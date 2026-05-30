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

  const formType = readAscii(view, 8, 4);
  if (formType !== "AIFF" && formType !== "AIFC") {
    throw new Error("Unsupported FORM type.");
  }

  let offset = 12;
  let commOffset = 0;
  let commSize = 0;
  let ssndOffset = 0;
  let ssndSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, false);
    const dataOffset = offset + 8;

    if (chunkId === "COMM") {
      commOffset = dataOffset;
      commSize = chunkSize;
    }

    if (chunkId === "SSND") {
      ssndOffset = dataOffset;
      ssndSize = chunkSize;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  if (!commOffset || !ssndOffset) {
    throw new Error("AIFF file is missing COMM or SSND chunks.");
  }

  const channelCount = view.getUint16(commOffset, false);
  const frameCount = view.getUint32(commOffset + 2, false);
  const bitsPerSample = view.getUint16(commOffset + 6, false);
  const sampleRate = Math.round(readExtendedFloat80(view, commOffset + 8));
  let compressionType = "NONE";

  if (channelCount <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    throw new Error("Invalid AIFF format values.");
  }

  if (formType === "AIFC" && commSize >= 22) {
    compressionType = readAscii(view, commOffset + 18, 4);
  }

  if (formType === "AIFC" && !SUPPORTED_AIFC_COMPRESSION_TYPES.has(compressionType)) {
    throw new Error(`Unsupported AIFC compression type: ${compressionType}.`);
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
