import { deriveChannelLayout } from "@/audio/channel-layout";
import type { DecodedAudioAsset, SourceFormat } from "@/types/audio";

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const KSDATAFORMAT_SUBTYPE_PCM = "00000001-0000-0010-8000-00aa00389b71";
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = "00000003-0000-0010-8000-00aa00389b71";

interface ChunkInfo {
  offset: number;
  size: number;
}

function readAscii(view: DataView, offset: number, length: number) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(view.getUint8(offset + index));
  }
  return out;
}

function readGuid(view: DataView, offset: number) {
  const a = view.getUint32(offset, true).toString(16).padStart(8, "0");
  const b = view.getUint16(offset + 4, true).toString(16).padStart(4, "0");
  const c = view.getUint16(offset + 6, true).toString(16).padStart(4, "0");
  const d = Array.from({ length: 2 }, (_, i) =>
    view.getUint8(offset + 8 + i).toString(16).padStart(2, "0"),
  ).join("");
  const e = Array.from({ length: 6 }, (_, i) =>
    view.getUint8(offset + 10 + i).toString(16).padStart(2, "0"),
  ).join("");
  return `${a}-${b}-${c}-${d}-${e}`;
}

function readUint64LE(view: DataView, offset: number) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 2 ** 32 + low;
}

function decodePcmToPlanar(
  view: DataView,
  offset: number,
  byteLength: number,
  channelCount: number,
  bitsPerSample: number,
  formatTag: number,
  littleEndian: boolean,
) {
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample)) {
    throw new Error(`Unsupported PCM depth: ${bitsPerSample}-bit`);
  }

  if (formatTag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new Error(`Unsupported IEEE float depth: ${bitsPerSample}-bit`);
  }

  const frameStride = bytesPerSample * channelCount;
  const frameCount = Math.floor(byteLength / frameStride);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = offset + frame * frameStride;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      let value = 0;

      if (formatTag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
        value = view.getFloat32(sampleOffset, littleEndian);
      } else if (formatTag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 64) {
        value = view.getFloat64(sampleOffset, littleEndian);
      } else if (bitsPerSample === 8) {
        value = (view.getUint8(sampleOffset) - 128) / 128;
      } else if (bitsPerSample === 16) {
        value = view.getInt16(sampleOffset, littleEndian) / 32768;
      } else if (bitsPerSample === 24) {
        const a = view.getUint8(sampleOffset + (littleEndian ? 0 : 2));
        const b = view.getUint8(sampleOffset + 1);
        const c = view.getUint8(sampleOffset + (littleEndian ? 2 : 0));
        const signed = (c << 24) | (b << 16) | (a << 8);
        value = signed / 2147483648;
      } else if (bitsPerSample === 32) {
        value = view.getInt32(sampleOffset, littleEndian) / 2147483648;
      } else {
        throw new Error(`Unsupported PCM depth: ${bitsPerSample}-bit`);
      }

      if (!Number.isFinite(value)) {
        throw new Error(`Malformed PCM sample at frame ${frame + 1}, channel ${channel + 1}.`);
      }

      channels[channel][frame] = value;
    }
  }

  return { channels, frameCount };
}

export function parseWavBuffer(
  buffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): DecodedAudioAsset {
  const view = new DataView(buffer);
  const container = readAscii(view, 0, 4);
  const sourceFormat: SourceFormat = container === "RF64" ? "rf64" : "wav";

  if (container !== "RIFF" && container !== "RF64") {
    throw new Error("Not a RIFF/RF64 wave file.");
  }

  if (readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Missing WAVE signature.");
  }

  const warnings: string[] = [];
  // Track only the chunks the parser actually reads. Recording every chunk in
  // a map let a hostile file made of millions of tiny chunks balloon memory
  // before any audio was parsed; unknown chunk IDs are now just skipped over.
  const chunks = new Map<string, ChunkInfo>();
  let offset = 12;
  let dataSizeFromDs64: number | null = null;

  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const size =
      chunkSize === 0xffffffff && id === "data" && dataSizeFromDs64 != null
        ? dataSizeFromDs64
        : chunkSize;

    if (id === "ds64" && chunkSize >= 28 && dataOffset + 16 <= view.byteLength) {
      dataSizeFromDs64 = readUint64LE(view, dataOffset + 8);
    }

    if (id === "fmt " || id === "data" || id === "ds64") {
      chunks.set(id, { offset: dataOffset, size });
    }

    // Spec-conforming files carry one fmt and one data chunk (and ds64, when
    // present, precedes data), so once both are known nothing later can
    // legitimately change the result — stop scanning attacker-padded tails.
    if (chunks.has("fmt ") && chunks.has("data")) {
      break;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  const fmt = chunks.get("fmt ");
  const data = chunks.get("data");
  if (!fmt || !data) {
    throw new Error("Wave file is missing fmt or data chunks.");
  }

  if (fmt.size < 16 || fmt.offset + 16 > view.byteLength) {
    throw new Error("Wave fmt chunk is truncated.");
  }

  let formatTag = view.getUint16(fmt.offset, true);
  const channelCount = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const bitsPerSample = view.getUint16(fmt.offset + 14, true);
  let speakerMask: number | null = null;

  if (channelCount <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    throw new Error("Invalid WAV format values.");
  }

  if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
    if (fmt.size < 40 || fmt.offset + 40 > view.byteLength) {
      throw new Error("Invalid WAVE_FORMAT_EXTENSIBLE chunk.");
    }

    speakerMask = view.getUint32(fmt.offset + 20, true);
    const subFormat = readGuid(view, fmt.offset + 24);
    if (subFormat === KSDATAFORMAT_SUBTYPE_PCM) {
      formatTag = WAVE_FORMAT_PCM;
    } else if (subFormat === KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) {
      formatTag = WAVE_FORMAT_IEEE_FLOAT;
    } else {
      throw new Error(`Unsupported extensible subformat: ${subFormat}`);
    }
  }

  if (![WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT].includes(formatTag)) {
    throw new Error(`Unsupported wave format tag: 0x${formatTag.toString(16)}`);
  }

  const decoded = decodePcmToPlanar(
    view,
    data.offset,
    Math.min(data.size, view.byteLength - data.offset),
    channelCount,
    bitsPerSample,
    formatTag,
    true,
  );
  if (decoded.frameCount <= 0) {
    throw new Error("Wave file does not contain decoded audio frames.");
  }

  const channelLayout = deriveChannelLayout(channelCount, speakerMask);

  if (sourceFormat === "rf64") {
    warnings.push(
      "RF64 source detected. Large-file chunk sizes were resolved through the ds64 chunk when present.",
    );
  }

  return {
    fileName,
    mimeType,
    sourceFormat,
    sampleRate,
    bitDepth: bitsPerSample,
    durationSeconds: decoded.frameCount / sampleRate,
    frameCount: decoded.frameCount,
    channelCount,
    channelLayout,
    decoderMode: "native-parser",
    decoderLabel: sourceFormat === "rf64" ? "RF64 parser" : "WAV parser",
    decoderSummary: "Decoded directly from the original PCM container without transcoding.",
    decodeNotes: [],
    warnings,
    channels: decoded.channels,
  };
}
