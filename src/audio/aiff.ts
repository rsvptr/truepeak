import { deriveChannelLayout } from "@/audio/channel-layout";
import {
  iterateContainerChunks,
  readAscii,
  readExtendedFloat80,
  type BeforePcmAllocation,
} from "@/audio/container-chunks";
import type { DecodedAudioAsset } from "@/types/audio";

const SUPPORTED_AIFC_COMPRESSION_TYPES = new Set([
  "NONE",
  "twos",
  "sowt",
  "fl32",
  "FL32",
  "fl64",
  "FL64",
]);

// FVER timestamp for AIFF-C Version 1 (the only defined AIFC version), per the
// Apple AIFF-C specification. AIFC files must carry an FVER chunk declaring it.
const AIFC_VERSION_1 = 0xa2805140;

function decodeAiffPcm(
  view: DataView,
  offset: number,
  byteLength: number,
  channelCount: number,
  bitsPerSample: number,
  littleEndian: boolean,
  isFloat: boolean,
) {
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample)) {
    throw new Error(`Unsupported AIFF sample depth: ${bitsPerSample}`);
  }

  if (isFloat && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new Error(`Unsupported AIFF floating-point sample depth: ${bitsPerSample}`);
  }

  const frameStride = bytesPerSample * channelCount;
  const frameCount = Math.floor(byteLength / frameStride);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = offset + frame * frameStride;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      let value = 0;

      if (isFloat && bitsPerSample === 32) {
        value = view.getFloat32(sampleOffset, littleEndian);
      } else if (isFloat && bitsPerSample === 64) {
        value = view.getFloat64(sampleOffset, littleEndian);
      } else if (bitsPerSample === 8) {
        value = view.getInt8(sampleOffset) / 128;
      } else if (bitsPerSample === 16) {
        value = view.getInt16(sampleOffset, littleEndian) / 32768;
      } else if (bitsPerSample === 24) {
        const first = view.getUint8(sampleOffset + (littleEndian ? 0 : 2));
        const second = view.getUint8(sampleOffset + 1);
        const third = view.getUint8(sampleOffset + (littleEndian ? 2 : 0));
        const signed = (third << 24) | (second << 16) | (first << 8);
        value = signed / 2147483648;
      } else if (bitsPerSample === 32) {
        value = view.getInt32(sampleOffset, littleEndian) / 2147483648;
      } else {
        throw new Error(`Unsupported AIFF sample depth: ${bitsPerSample}`);
      }

      if (!Number.isFinite(value)) {
        throw new Error(`Malformed AIFF sample at frame ${frame + 1}, channel ${channel + 1}.`);
      }

      channels[channel][frame] = value;
    }
  }

  return { channels, frameCount };
}

export function parseAiffBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
  beforePcmAllocation?: BeforePcmAllocation,
): DecodedAudioAsset {
  const view = new DataView(buffer);

  if (view.byteLength < 12) {
    throw new Error("AIFF file header is truncated.");
  }

  if (readAscii(view, 0, 4) !== "FORM") {
    throw new Error("Not an AIFF/AIFC file.");
  }

  const formType = readAscii(view, 8, 4);
  if (formType !== "AIFF" && formType !== "AIFC") {
    throw new Error("Unsupported FORM type.");
  }

  let commOffset = 0;
  let commSize = 0;
  let ssndOffset = 0;
  let ssndSize = 0;
  let fverOffset = 0;
  let fverSize = 0;

  // The parser and preflight share the same bounded iterator and selection
  // rule: the first chunk with each required id wins, and scanning stops as
  // soon as both COMM and SSND are known, regardless of their order. For AIFC,
  // FVER therefore has to be encountered before that pair is complete.
  for (const chunk of iterateContainerChunks(view, {
    startOffset: 12,
    totalBytes: view.byteLength,
    littleEndian: false,
  })) {
    if (chunk.id === "FVER" && !fverOffset) {
      fverOffset = chunk.dataOffset;
      fverSize = chunk.declaredSize;
    }

    if (chunk.id === "COMM" && !commOffset) {
      commOffset = chunk.dataOffset;
      commSize = chunk.declaredSize;
    }

    if (chunk.id === "SSND" && !ssndOffset) {
      ssndOffset = chunk.dataOffset;
      ssndSize = chunk.declaredSize;
    }

    if (commOffset && ssndOffset) {
      break;
    }
  }

  if (!commOffset || !ssndOffset) {
    throw new Error("AIFF file is missing COMM or SSND chunks.");
  }

  // M-13: AIFC must carry the mandatory FVER (format version) chunk declaring the
  // AIFF-C Version 1 timestamp. Reject a missing, truncated, or wrong-version FVER.
  // Plain AIFF must not carry one and is unaffected.
  if (formType === "AIFC") {
    if (!fverOffset) {
      throw new Error("AIFC file is missing the mandatory FVER (format version) chunk.");
    }
    if (fverSize < 4 || fverOffset + 4 > view.byteLength) {
      throw new Error("AIFC FVER chunk is truncated.");
    }
    const fverTimestamp = view.getUint32(fverOffset, false);
    if (fverTimestamp !== AIFC_VERSION_1) {
      throw new Error(
        `AIFC FVER declares an unsupported version timestamp 0x${fverTimestamp.toString(16)} (expected 0x${AIFC_VERSION_1.toString(16)}).`,
      );
    }
  }

  if (commSize < 18 || commOffset + 18 > view.byteLength) {
    throw new Error("AIFF COMM chunk is truncated.");
  }

  const channelCount = view.getUint16(commOffset, false);
  const frameCount = view.getUint32(commOffset + 2, false);
  const bitsPerSample = view.getUint16(commOffset + 6, false);
  const sampleRate = Math.round(readExtendedFloat80(view, commOffset + 8));
  let compressionType = "NONE";

  // The 80-bit float can encode NaN/Infinity, which `<= 0` does not reject.
  if (
    channelCount <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    bitsPerSample <= 0
  ) {
    throw new Error("Invalid AIFF format values.");
  }

  if (formType === "AIFC") {
    // The extended AIFC COMM adds, after the 18 fixed bytes, a 4-byte compression
    // type ID and a compression-name Pascal string (a 1-byte length count followed
    // by that many characters). The minimum is therefore 23 bytes (18 + 4 + a count
    // byte, even for an empty name). Bound BOTH the fixed+type region AND the pstring
    // (count byte plus its declared characters) to the declared COMM size and to the
    // physical buffer — never read out of bounds, and never default to PCM when the
    // metadata is truncated or the name length is forged.
    if (commSize < 23 || commOffset + 23 > view.byteLength) {
      throw new Error(
        "AIFC COMM chunk is missing its compression-type / compression-name fields (truncated extended COMM).",
      );
    }
    compressionType = readAscii(view, commOffset + 18, 4);
    const compressionNameCount = view.getUint8(commOffset + 22);
    const compressionNameEnd = commOffset + 23 + compressionNameCount;
    if (compressionNameEnd > commOffset + commSize || compressionNameEnd > view.byteLength) {
      throw new Error(
        "AIFC COMM compression-name string extends past the COMM chunk or the end of the buffer.",
      );
    }

    if (!SUPPORTED_AIFC_COMPRESSION_TYPES.has(compressionType)) {
      throw new Error(`Unsupported AIFC compression type: ${compressionType}.`);
    }
  }

  if (ssndOffset + 8 > view.byteLength) {
    throw new Error("AIFF SSND chunk is truncated.");
  }

  const soundDataOffset = view.getUint32(ssndOffset, false);
  const bytesPerSample = bitsPerSample / 8;
  const isFloat = ["fl32", "FL32", "fl64", "FL64"].includes(compressionType);
  if (!Number.isInteger(bytesPerSample)) {
    throw new Error(`Unsupported AIFF sample depth: ${bitsPerSample}`);
  }
  if (
    (isFloat && ![32, 64].includes(bitsPerSample)) ||
    (!isFloat && ![8, 16, 24, 32].includes(bitsPerSample))
  ) {
    throw new Error(
      isFloat
        ? `Unsupported AIFF floating-point sample depth: ${bitsPerSample}`
        : `Unsupported AIFF sample depth: ${bitsPerSample}`,
    );
  }

  const bytesPerFrame = channelCount * bytesPerSample;
  const audioDataOffset = ssndOffset + 8 + soundDataOffset;
  const declaredAudioBytes = Math.max(0, ssndSize - 8 - soundDataOffset);
  const declaredFrameBytes =
    Number.isSafeInteger(bytesPerFrame) &&
    bytesPerFrame > 0 &&
    frameCount <= Math.floor(Number.MAX_SAFE_INTEGER / bytesPerFrame)
      ? frameCount * bytesPerFrame
      : null;
  if (declaredFrameBytes == null) {
    throw new Error("AIFF frame geometry exceeds the supported range.");
  }
  const availableBytes = Math.max(0, view.byteLength - audioDataOffset);
  const audioDataByteLength = Math.min(
    declaredAudioBytes,
    declaredFrameBytes,
    availableBytes,
  );
  const littleEndian = compressionType === "sowt";
  const decodedFrameCount = Math.floor(audioDataByteLength / bytesPerFrame);
  if (!Number.isSafeInteger(decodedFrameCount) || decodedFrameCount <= 0) {
    throw new Error("AIFF file does not contain decoded audio frames.");
  }
  beforePcmAllocation?.({
    channelCount,
    bitDepth: bitsPerSample,
    frameCount: decodedFrameCount,
  });

  const decoded = decodeAiffPcm(
    view,
    audioDataOffset,
    audioDataByteLength,
    channelCount,
    bitsPerSample,
    littleEndian,
    isFloat,
  );
  return {
    fileName,
    mimeType,
    sourceFormat: formType === "AIFC" ? "aifc" : "aiff",
    sampleRate,
    bitDepth: bitsPerSample,
    durationSeconds: decoded.frameCount / sampleRate,
    frameCount: decoded.frameCount,
    channelCount,
    channelLayout: deriveChannelLayout(channelCount, null),
    decoderMode: "native-parser",
    decoderLabel: formType === "AIFC" ? "AIFC parser" : "AIFF parser",
    decoderSummary: "Decoded directly from the original PCM-compatible container without transcoding.",
    decodeNotes: [],
    warnings: [],
    channels: decoded.channels,
  };
}
