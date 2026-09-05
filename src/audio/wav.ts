import { deriveChannelLayout } from "@/audio/channel-layout";
import {
  iterateContainerChunks,
  readAscii,
  readSafeUint64,
  type BeforePcmAllocation,
} from "@/audio/container-chunks";
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
  beforePcmAllocation?: BeforePcmAllocation,
): DecodedAudioAsset {
  const view = new DataView(buffer);
  if (view.byteLength < 12) {
    throw new Error("WAV file header is truncated.");
  }

  const container = readAscii(view, 0, 4);
  const sourceFormat: SourceFormat = container === "RF64" ? "rf64" : "wav";

  if (container !== "RIFF" && container !== "RF64") {
    throw new Error("Not a RIFF/RF64 wave file.");
  }

  if (readAscii(view, 8, 4) !== "WAVE") {
    throw new Error("Missing WAVE signature.");
  }

  const warnings: string[] = [];
  let fmt: ChunkInfo | null = null;
  let data: ChunkInfo | null = null;
  let dataSizeFromDs64: number | null = null;
  let ds64Resolved = false;
  let ds64Seen = false;

  for (const chunk of iterateContainerChunks(view, {
    startOffset: 12,
    totalBytes: view.byteLength,
    littleEndian: true,
    resolveSize: (id, declaredSize) =>
      id === "data" && sourceFormat === "rf64" && declaredSize === 0xffffffff
        ? dataSizeFromDs64
        : declaredSize,
  })) {
    if (chunk.id === "ds64" && !ds64Seen) {
      ds64Seen = true;
      // ds64 must carry a readable 64-bit dataSize field (riffSize + dataSize
      // + sampleCount + tableLength = 28 bytes minimum); bound the read to
      // the actual buffer so a truncated ds64 can't be misread as valid.
      const ds64Readable =
        chunk.declaredSize >= 28 && chunk.dataOffset + 28 <= view.byteLength;
      if (sourceFormat === "rf64" && !ds64Readable) {
        throw new Error("RF64 ds64 chunk is truncated or malformed.");
      }
      if (ds64Readable) {
        const resolvedDataSize = readSafeUint64(view, chunk.dataOffset + 8, true);
        const resolvedValid = resolvedDataSize != null && resolvedDataSize >= 0;
        if (sourceFormat === "rf64" && !resolvedValid) {
          throw new Error("RF64 ds64 chunk declares an invalid or unresolved data size.");
        }
        if (resolvedValid) {
          dataSizeFromDs64 = resolvedDataSize;
          ds64Resolved = true;
        }
      }
    }

    // RF64 requires ds64, and it must precede data — reject unresolved
    // 0xFFFFFFFF sentinel data sizes rather than clamping them to whatever
    // bytes happen to remain in the buffer (that previously turned trailing
    // chunk headers/padding into fabricated audio frames).
    if (chunk.id === "data" && sourceFormat === "rf64" && !ds64Resolved) {
      throw new Error(
        "RF64 file is missing the required ds64 chunk, or it does not precede the data chunk.",
      );
    }

    if (chunk.id === "fmt " && fmt == null && chunk.size != null) {
      fmt = { offset: chunk.dataOffset, size: chunk.size };
    } else if (chunk.id === "data" && data == null && chunk.size != null) {
      data = { offset: chunk.dataOffset, size: chunk.size };
    }

    // First occurrence wins on both sides of the preflight/parser boundary.
    // Stop as soon as both chunks are known, including when data precedes fmt.
    if (fmt && data) {
      break;
    }
  }

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
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample)) {
    throw new Error(`Unsupported PCM depth: ${bitsPerSample}-bit`);
  }
  if (
    (formatTag === WAVE_FORMAT_PCM && ![8, 16, 24, 32].includes(bitsPerSample)) ||
    (formatTag === WAVE_FORMAT_IEEE_FLOAT && ![32, 64].includes(bitsPerSample))
  ) {
    throw new Error(
      formatTag === WAVE_FORMAT_IEEE_FLOAT
        ? `Unsupported IEEE float depth: ${bitsPerSample}-bit`
        : `Unsupported PCM depth: ${bitsPerSample}-bit`,
    );
  }

  // M-10: for RF64 the ds64-resolved (or explicit) data size is authoritative. If it
  // claims more bytes than the file physically holds, the file is corrupt or hostile
  // — fail closed rather than clamp. Clamping fabricates audio frames from whatever
  // trailing chunk headers/padding happen to remain (the audit's exact repro: a ds64
  // declaring 400 bytes over 4 physical PCM bytes parsed as two real frames). Plain
  // RIFF/WAV keeps the best-effort clamp below, because an oversized 32-bit data size
  // is a common benign streaming/authoring artifact rather than a 64-bit size lie.
  const availableDataBytes = view.byteLength - data.offset;
  if (sourceFormat === "rf64" && data.size > availableDataBytes) {
    throw new Error(
      `RF64 declares a data size of ${data.size} bytes but only ${availableDataBytes} bytes are physically present; refusing to fabricate audio from truncated data.`,
    );
  }

  const decodedByteLength = Math.min(data.size, availableDataBytes);
  const frameStride = bytesPerSample * channelCount;
  const decodedFrameCount = Math.floor(decodedByteLength / frameStride);
  if (!Number.isSafeInteger(decodedFrameCount) || decodedFrameCount <= 0) {
    throw new Error("Wave file does not contain decoded audio frames.");
  }
  beforePcmAllocation?.({
    channelCount,
    bitDepth: bitsPerSample,
    frameCount: decodedFrameCount,
  });

  const decoded = decodePcmToPlanar(
    view,
    data.offset,
    decodedByteLength,
    channelCount,
    bitsPerSample,
    formatTag,
    true,
  );
  // "wave" so a plain 16-byte `fmt ` chunk (no dwChannelMask) is laid out the
  // way WAVE interleaves, matching what the mask path resolves for the same file
  // when the mask is present.
  const channelLayout = deriveChannelLayout(channelCount, speakerMask, "wave");

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
