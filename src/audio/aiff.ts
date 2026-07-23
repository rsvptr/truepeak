import { deriveChannelLayout } from "@/audio/channel-layout";
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

function readAscii(view: DataView, offset: number, length: number) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(view.getUint8(offset + index));
  }
  return out;
}

function readExtendedFloat80(view: DataView, offset: number) {
  const exponent = view.getUint16(offset, false);
  const hiMantissa = view.getUint32(offset + 2, false);
  const loMantissa = view.getUint32(offset + 6, false);

  if (exponent === 0 && hiMantissa === 0 && loMantissa === 0) {
    return 0;
  }

  const sign = exponent & 0x8000 ? -1 : 1;
  const unbiasedExponent = (exponent & 0x7fff) - 16383;
  const mantissa = hiMantissa * 2 ** -31 + loMantissa * 2 ** -63;
  return sign * mantissa * 2 ** unbiasedExponent;
}

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
): DecodedAudioAsset {
  const view = new DataView(buffer);

  if (readAscii(view, 0, 4) !== "FORM") {
    throw new Error("Not an AIFF/AIFC file.");
  }

  if (view.byteLength < 12) {
    throw new Error("AIFF file header is truncated.");
  }

  const formType = readAscii(view, 8, 4);
  if (formType !== "AIFF" && formType !== "AIFC") {
    throw new Error("Unsupported FORM type.");
  }

  let offset = 12;
  let chunksVisited = 0;
  let commOffset = 0;
  let commSize = 0;
  let ssndOffset = 0;
  let ssndSize = 0;
  let fverOffset = 0;
  let fverSize = 0;

  // Bound the chunk walk exactly the way inspectAiff (decode-budget.ts) already
  // caps its sibling pre-flight scan. A legitimate AIFF/AIFC carries COMM, SSND,
  // and (for AIFC) its mandatory FVER within the first handful of chunks, so
  // 100k iterations is far more than any real file needs. Without this cap an
  // AIFC with COMM+SSND early, no FVER, and a huge padded tail of size-0 chunks
  // (which still fits inside the decode budget and passes the inspector) forces
  // this synchronous loop to march to EOF one 4-char allocation per chunk before
  // finally throwing "missing FVER" — freezing the decoder lane for seconds and
  // bypassing the maxDecodeMs budget, which cannot interrupt a synchronous loop.
  while (offset + 8 <= view.byteLength && chunksVisited < 100_000) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, false);
    const dataOffset = offset + 8;
    chunksVisited += 1;

    if (chunkId === "FVER") {
      fverOffset = dataOffset;
      fverSize = chunkSize;
    }

    if (chunkId === "COMM") {
      commOffset = dataOffset;
      commSize = chunkSize;
    }

    if (chunkId === "SSND") {
      ssndOffset = dataOffset;
      ssndSize = chunkSize;
    }

    // A valid AIFF is described by COMM + SSND; a valid AIFC additionally requires
    // the mandatory FVER version chunk. Stop scanning once the required chunks are
    // known so attacker-padded chunk tails can't burn time. FVER may legitimately
    // appear after COMM/SSND, so for AIFC keep scanning until it is found — but the
    // chunksVisited cap above guarantees the walk still terminates cheaply on a
    // crafted FVER-absent flood instead of running all the way to EOF.
    if (commOffset && ssndOffset && (formType !== "AIFC" || fverOffset)) {
      break;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
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
  const bytesPerFrame = channelCount * (bitsPerSample / 8);
  const audioDataOffset = ssndOffset + 8 + soundDataOffset;
  const declaredAudioBytes = Math.max(0, ssndSize - 8 - soundDataOffset);
  const declaredFrameBytes = frameCount * bytesPerFrame;
  const availableBytes = Math.max(0, view.byteLength - audioDataOffset);
  const audioDataByteLength = Math.min(
    declaredAudioBytes,
    declaredFrameBytes,
    availableBytes,
  );
  const littleEndian = compressionType === "sowt";
  const isFloat = ["fl32", "FL32", "fl64", "FL64"].includes(compressionType);

  const decoded = decodeAiffPcm(
    view,
    audioDataOffset,
    audioDataByteLength,
    channelCount,
    bitsPerSample,
    littleEndian,
    isFloat,
  );
  if (decoded.frameCount <= 0) {
    throw new Error("AIFF file does not contain decoded audio frames.");
  }

  return {
    fileName,
    mimeType,
    sourceFormat: formType === "AIFC" ? "aifc" : "aiff",
    sampleRate,
    bitDepth: bitsPerSample,
    durationSeconds: decoded.frameCount / sampleRate,
    frameCount: Math.min(frameCount, decoded.frameCount),
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
