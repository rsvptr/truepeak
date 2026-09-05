import { FFmpeg } from "@ffmpeg/ffmpeg";
import { parseAiffBuffer } from "@/audio/aiff";
import {
  DecodeResourceError,
  COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  decodeFailureDetails,
  inspectAudioContainer,
  resolveDecodeBudget,
  throwIfAborted,
  validateDecodeProbeMetadata,
  validatePlanarChannels,
} from "@/audio/decode-budget";
import { toTransferAsset } from "@/audio/serialise";
import { parseWavBuffer } from "@/audio/wav";
import type { ContainerPcmGeometry } from "@/audio/container-chunks";
import type {
  AudioContainerPreflight,
  DecodeBudget,
  DecodeProbeMetadata,
} from "@/audio/decode-budget";
import type { DecodedAudioAsset } from "@/types/audio";
import type {
  DecoderRequest,
  DecoderResponse,
  DecodeResourceUsage,
} from "@/workers/shared/messages";

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const MAX_LOG_LINES = 10;
const MAX_LOG_LINE_CHARS = 512;
const MAX_PROBE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 15_000;
const FFMPEG_CORE_VERSION = "0.12.9";
const FFMPEG_WRAPPER_VERSION = "0.12.15";

let ffmpegPromise: Promise<FFmpeg> | null = null;
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLogBuffer: string[] = [];
let ffmpegActiveJobId: string | null = null;
const activeJobs = new Map<string, AbortController>();

function postMessageSafe(message: DecoderResponse, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

function postDecodeError(
  jobId: string,
  error: unknown,
  phase?: "probe" | "decode",
) {
  const details = decodeFailureDetails(error);
  postMessageSafe({
    type: "error",
    jobId,
    error: details.message,
    code: details.code,
    retryable: details.retryable,
    ...(phase ? { phase } : {}),
  });
}

function pushFfmpegLog(message: string) {
  ffmpegLogBuffer.push(message.slice(0, MAX_LOG_LINE_CHARS));
  if (ffmpegLogBuffer.length > MAX_LOG_LINES) {
    ffmpegLogBuffer = ffmpegLogBuffer.slice(-MAX_LOG_LINES);
  }
}

function composeFfmpegError(message: string) {
  if (!ffmpegLogBuffer.length) {
    return message;
  }

  return `${message} Recent ffmpeg output: ${ffmpegLogBuffer.join(" | ")}`;
}

function ffmpegRuntimeAborted() {
  return ffmpegLogBuffer.some((line) =>
    /abort(?:\(\))?|out of memory|memory access out of bounds|wasm trap|unreachable/i.test(line),
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getLocalAssetUrl(packageName: "core" | "ffmpeg", version: string, fileName: string) {
  return new URL(
    `/vendor/ffmpeg/${packageName}/${version}/${fileName}`,
    ctx.location.origin,
  ).toString();
}

function sniffContainer(buffer: ArrayBuffer) {
  if (buffer.byteLength < 12) {
    return "unknown";
  }

  const view = new DataView(buffer);
  const a = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  const b = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11),
  );

  if (a === "RIFF" || a === "RF64") {
    return "wav";
  }

  if (a === "FORM" && (b === "AIFF" || b === "AIFC")) {
    return "aiff";
  }

  return "unknown";
}

function safeExtension(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (!extension || extension.length > 8) {
    return "bin";
  }
  return extension.replace(/[^a-z0-9]/g, "") || "bin";
}

function remainingTimeMs(deadlineMs: number, signal: AbortSignal) {
  throwIfAborted(signal);
  const remaining = Math.floor(deadlineMs - performance.now());
  if (remaining <= 0) {
    throw new DecodeResourceError(
      "time-limit-exceeded",
      "Audio decoding exceeded its execution-time budget.",
    );
  }
  return remaining;
}

function terminateFfmpeg() {
  const pending = ffmpegPromise;
  const instance = ffmpegInstance;
  ffmpegPromise = null;
  ffmpegInstance = null;
  ffmpegActiveJobId = null;
  if (instance) {
    try {
      instance.terminate();
    } catch {
      // The nested worker may already have terminated after cancellation.
    }
  } else if (pending) {
    void pending.then(
      (ffmpeg) => {
        try {
          ffmpeg.terminate();
        } catch {
          // The nested worker may already have terminated after cancellation.
        }
      },
      () => undefined,
    );
  }
}

// A rejected ffmpeg API promise can mean the Emscripten runtime aborted and is
// permanently unusable. Retire the singleton before surfacing the failure so
// the next job constructs a clean instance instead of inheriting a poisoned
// wasm heap. Clean non-zero exit codes are returned as numbers and do not pass
// through this guard.
async function runFfmpegCall<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    terminateFfmpeg();
    throw error;
  }
}

async function getFfmpeg(
  jobId: string,
  signal: AbortSignal,
  allowCompatibilityDecoder: boolean,
) {
  if (!allowCompatibilityDecoder) {
    throw new DecodeResourceError(
      "decode-failed",
      "TruePeak skipped the compatibility decoder because Data Saver or a slow connection is active. To allow its approximately 31 MB download, open Advanced options and enable the compatibility decoder.",
    );
  }
  if (!ffmpegPromise) {
    ffmpegLogBuffer = [];
    postMessageSafe({
      type: "progress",
      jobId,
      progress: 0.16,
      label: "Loading compatibility decoder",
    });

    const instance = new FFmpeg();
    ffmpegInstance = instance;
    instance.on("progress", ({ progress }) => {
      const activeJobId = ffmpegActiveJobId;
      if (!activeJobId) {
        return;
      }

      const boundedProgress = Number.isFinite(progress)
        ? Math.max(0, Math.min(1, progress))
        : 0;
      postMessageSafe({
        type: "progress",
        jobId: activeJobId,
        progress: Math.min(0.84, 0.24 + boundedProgress * 0.52),
        label: "Transcoding unsupported format in-browser",
      });
    });
    instance.on("log", ({ message }) => {
      pushFfmpegLog(message);
    });

    const loading = instance
      .load(
        {
          classWorkerURL: getLocalAssetUrl(
            "ffmpeg",
            FFMPEG_WRAPPER_VERSION,
            "worker.js",
          ),
          coreURL: getLocalAssetUrl("core", FFMPEG_CORE_VERSION, "ffmpeg-core.js"),
          wasmURL: getLocalAssetUrl("core", FFMPEG_CORE_VERSION, "ffmpeg-core.wasm"),
        },
        { signal },
      )
      .then(() => instance);
    const tracked = loading.catch(() => {
      if (ffmpegInstance === instance) {
        try {
          instance.terminate();
        } catch {
          // Loading may have failed before the nested worker was constructed.
        }
        ffmpegInstance = null;
      }
      if (ffmpegPromise === tracked) {
        ffmpegPromise = null;
      }
      if (signal.aborted) {
        throwIfAborted(signal);
      }
      throw new DecodeResourceError(
        "decode-failed",
        "The compatibility decoder core could not load. Reload the page and try again.",
        true,
      );
    });
    ffmpegPromise = tracked;
  }

  return ffmpegPromise;
}

type FfmpegProbe = DecodeProbeMetadata;

function positiveNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTimeBase(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function asciiAt(view: DataView, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    return "";
  }
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function id3PayloadEnd(view: DataView) {
  if (view.byteLength < 10 || asciiAt(view, 0, 3) !== "ID3") {
    return 0;
  }
  const size =
    (view.getUint8(6) << 21) |
    (view.getUint8(7) << 14) |
    (view.getUint8(8) << 7) |
    view.getUint8(9);
  return Math.min(view.byteLength, 10 + size);
}

function sniffMp3(view: DataView): DecodeProbeMetadata | null {
  const scanEnd = Math.min(view.byteLength - 4, id3PayloadEnd(view) + 256 * 1024);
  for (let offset = id3PayloadEnd(view); offset <= scanEnd; offset += 1) {
    const header = view.getUint32(offset, false);
    if ((header >>> 21) !== 0x07ff) {
      continue;
    }
    const versionBits = (header >>> 19) & 0x3;
    const layerBits = (header >>> 17) & 0x3;
    const sampleRateIndex = (header >>> 10) & 0x3;
    if (versionBits === 1 || layerBits !== 1 || sampleRateIndex === 3) {
      continue;
    }

    const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex];
    const sampleRate = versionBits === 3
      ? baseSampleRate
      : versionBits === 2
        ? baseSampleRate / 2
        : baseSampleRate / 4;
    const channelCount = ((header >>> 6) & 0x3) === 3 ? 1 : 2;
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const sideInfoBytes = versionBits === 3
      ? channelCount === 1 ? 17 : 32
      : channelCount === 1 ? 9 : 17;
    const xingOffset = offset + 4 + sideInfoBytes;
    const xingName = asciiAt(view, xingOffset, 4);
    if ((xingName === "Xing" || xingName === "Info") && xingOffset + 12 <= view.byteLength) {
      const flags = view.getUint32(xingOffset + 4, false);
      if ((flags & 0x1) !== 0) {
        const mpegFrames = view.getUint32(xingOffset + 8, false);
        if (mpegFrames > 0) {
          const frameCount = mpegFrames * samplesPerFrame;
          return {
            sampleRate,
            channelCount,
            frameCount,
            durationSeconds: frameCount / sampleRate,
            codecName: "MP3",
          };
        }
      }
    }

    const vbriOffset = offset + 36;
    if (asciiAt(view, vbriOffset, 4) === "VBRI" && vbriOffset + 18 <= view.byteLength) {
      const mpegFrames = view.getUint32(vbriOffset + 14, false);
      if (mpegFrames > 0) {
        const frameCount = mpegFrames * samplesPerFrame;
        return {
          sampleRate,
          channelCount,
          frameCount,
          durationSeconds: frameCount / sampleRate,
          codecName: "MP3",
        };
      }
    }
  }
  return null;
}

function sniffAdts(view: DataView): DecodeProbeMetadata | null {
  const sampleRates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000,
    22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
  ];
  let offset = id3PayloadEnd(view);
  let sampleRate = 0;
  let channelCount = 0;
  let frameCount = 0;
  let adtsFrames = 0;

  while (offset + 7 <= view.byteLength) {
    const first = view.getUint8(offset);
    const second = view.getUint8(offset + 1);
    if (first !== 0xff || (second & 0xf6) !== 0xf0) {
      break;
    }
    const third = view.getUint8(offset + 2);
    const fourth = view.getUint8(offset + 3);
    const fifth = view.getUint8(offset + 4);
    const sixth = view.getUint8(offset + 5);
    const rate = sampleRates[(third >>> 2) & 0x0f] ?? 0;
    const channels = ((third & 0x01) << 2) | ((fourth >>> 6) & 0x03);
    const packetBytes = ((fourth & 0x03) << 11) | (fifth << 3) | (sixth >>> 5);
    const headerBytes = (second & 0x01) === 1 ? 7 : 9;
    if (
      rate <= 0 ||
      channels <= 0 ||
      packetBytes < headerBytes ||
      offset + packetBytes > view.byteLength ||
      (sampleRate > 0 && sampleRate !== rate) ||
      (channelCount > 0 && channelCount !== channels)
    ) {
      return null;
    }
    sampleRate = rate;
    channelCount = channels;
    frameCount += 1024 * ((view.getUint8(offset + 6) & 0x03) + 1);
    adtsFrames += 1;
    offset += packetBytes;
  }

  if (adtsFrames === 0 || frameCount <= 0) {
    return null;
  }
  const trailingBytes = view.byteLength - offset;
  if (trailingBytes > 0 && !(trailingBytes === 128 && asciiAt(view, offset, 3) === "TAG")) {
    return null;
  }
  return {
    sampleRate,
    channelCount,
    frameCount,
    durationSeconds: frameCount / sampleRate,
    codecName: "AAC ADTS",
  };
}

function findAscii(view: DataView, needle: string, limit: number) {
  const end = Math.min(view.byteLength - needle.length, limit);
  for (let offset = 0; offset <= end; offset += 1) {
    if (asciiAt(view, offset, needle.length) === needle) {
      return offset;
    }
  }
  return -1;
}

function findLastOggPage(view: DataView) {
  const searchFloor = Math.max(0, view.byteLength - 256 * 1024);
  for (let offset = view.byteLength - 27; offset >= searchFloor; offset -= 1) {
    if (asciiAt(view, offset, 4) === "OggS" && view.getUint8(offset + 4) === 0) {
      return offset;
    }
  }
  return -1;
}

function sniffOgg(view: DataView): DecodeProbeMetadata | null {
  if (findAscii(view, "OggS", Math.min(view.byteLength, 64 * 1024)) < 0) {
    return null;
  }
  const lastPage = findLastOggPage(view);
  if (lastPage < 0 || lastPage + 14 > view.byteLength) {
    return null;
  }
  const granule = view.getBigUint64(lastPage + 6, true);
  if (granule === 0xffffffffffffffffn || granule > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  const opusOffset = findAscii(view, "OpusHead", Math.min(view.byteLength, 64 * 1024));
  if (opusOffset >= 0 && opusOffset + 12 <= view.byteLength) {
    const channelCount = view.getUint8(opusOffset + 9);
    const preSkip = view.getUint16(opusOffset + 10, true);
    const frameCount = Number(granule) - preSkip;
    if (channelCount > 0 && frameCount > 0) {
      return {
        sampleRate: 48_000,
        channelCount,
        frameCount,
        durationSeconds: frameCount / 48_000,
        codecName: "Opus",
      };
    }
  }

  const vorbisOffset = findAscii(view, "vorbis", Math.min(view.byteLength, 64 * 1024));
  if (
    vorbisOffset > 0 &&
    view.getUint8(vorbisOffset - 1) === 1 &&
    vorbisOffset + 11 <= view.byteLength
  ) {
    const channelCount = view.getUint8(vorbisOffset + 6);
    const sampleRate = view.getUint32(vorbisOffset + 7, true);
    const frameCount = Number(granule);
    if (channelCount > 0 && sampleRate > 0 && frameCount > 0) {
      return {
        sampleRate,
        channelCount,
        frameCount,
        durationSeconds: frameCount / sampleRate,
        codecName: "Vorbis",
      };
    }
  }
  return null;
}

interface IsoBox {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function isoBoxes(view: DataView, start: number, end: number) {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset + 8 <= end && boxes.length < 10_000) {
    const shortSize = view.getUint32(offset, false);
    const type = asciiAt(view, offset + 4, 4);
    let headerBytes = 8;
    let size = shortSize;
    if (shortSize === 1) {
      if (offset + 16 > end) break;
      const wideSize = view.getBigUint64(offset + 8, false);
      if (wideSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(wideSize);
      headerBytes = 16;
    } else if (shortSize === 0) {
      size = end - offset;
    }
    if (size < headerBytes || offset + size > end) break;
    boxes.push({ type, start: offset, dataStart: offset + headerBytes, end: offset + size });
    offset += size;
  }
  return boxes;
}

function childIsoBox(view: DataView, parent: IsoBox, type: string) {
  return isoBoxes(view, parent.dataStart, parent.end).find((box) => box.type === type) ?? null;
}

function sniffMp4(view: DataView): DecodeProbeMetadata | null {
  const topLevel = isoBoxes(view, 0, view.byteLength);
  if (!topLevel.some((box) => box.type === "ftyp")) {
    return null;
  }
  const moov = topLevel.find((box) => box.type === "moov");
  if (!moov) return null;

  for (const trak of isoBoxes(view, moov.dataStart, moov.end).filter((box) => box.type === "trak")) {
    const mdia = childIsoBox(view, trak, "mdia");
    if (!mdia) continue;
    const hdlr = childIsoBox(view, mdia, "hdlr");
    const mdhd = childIsoBox(view, mdia, "mdhd");
    const minf = childIsoBox(view, mdia, "minf");
    const stbl = minf ? childIsoBox(view, minf, "stbl") : null;
    const stsd = stbl ? childIsoBox(view, stbl, "stsd") : null;
    if (!hdlr || !mdhd || !stsd || asciiAt(view, hdlr.dataStart + 8, 4) !== "soun") {
      continue;
    }

    const version = view.getUint8(mdhd.dataStart);
    const timingOffset = version === 1 ? mdhd.dataStart + 20 : mdhd.dataStart + 12;
    const timingBytes = version === 1 ? 12 : 8;
    if (timingOffset + timingBytes > mdhd.end || stsd.dataStart + 8 > stsd.end) continue;
    const timescale = view.getUint32(timingOffset, false);
    const durationValue = version === 1
      ? view.getBigUint64(timingOffset + 4, false)
      : BigInt(view.getUint32(timingOffset + 4, false));
    if (
      timescale <= 0 ||
      durationValue <= 0n ||
      durationValue > BigInt(Number.MAX_SAFE_INTEGER)
    ) continue;

    const entries = isoBoxes(view, stsd.dataStart + 8, stsd.end);
    const audioEntry = entries.find((entry) => entry.end >= entry.start + 36);
    if (!audioEntry) continue;
    const channelCount = view.getUint16(audioEntry.start + 24, false);
    const sampleRate = view.getUint32(audioEntry.start + 32, false) >>> 16;
    const durationSeconds = Number(durationValue) / timescale;
    // One second of guard covers decoder delay/edit-list rounding without ever
    // reducing the reservation below the container's reported programme span.
    const frameCount = Math.ceil(durationSeconds * sampleRate) + sampleRate;
    if (channelCount > 0 && sampleRate > 0 && frameCount > 0) {
      return {
        sampleRate,
        channelCount,
        frameCount,
        durationSeconds,
        codecName: audioEntry.type,
      };
    }
  }
  return null;
}

function sniffCompressedMetadata(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  return sniffMp3(view) ?? sniffAdts(view) ?? sniffOgg(view) ?? sniffMp4(view);
}

async function probeFfmpegInput(
  ffmpeg: FFmpeg,
  safeInput: string,
  safeProbe: string,
  budget: DecodeBudget,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<FfmpegProbe> {
  const exitCode = await runFfmpegCall(() =>
    ffmpeg.ffprobe(
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name,sample_rate,channels,duration,duration_ts,time_base,nb_frames:format=duration",
        "-of",
        "json",
        safeInput,
        "-o",
        safeProbe,
      ],
      remainingTimeMs(deadlineMs, signal),
      { signal },
    ),
  );
  remainingTimeMs(deadlineMs, signal);
  // Measured against the pinned ffmpeg-core 0.12.9: a successful probe exits -1
  // (Module.ret is only updated on some ffprobe exit paths) while an argument
  // error exits 1, so only exitCode > 0 is treated as a real ffprobe failure.
  if (exitCode > 0) {
    if (ffmpegRuntimeAborted()) {
      terminateFfmpeg();
    }
    throw new DecodeResourceError(
      "metadata-unavailable",
      composeFfmpegError("The compatibility decoder could not inspect this audio source safely."),
      true,
    );
  }

  const probeOutput = await runFfmpegCall(() =>
    ffmpeg.readFile(safeProbe, undefined, { signal }),
  ).catch(() => {
    throw new DecodeResourceError(
      "metadata-unavailable",
      composeFfmpegError("The compatibility decoder could not inspect this audio source safely."),
      true,
    );
  });
  remainingTimeMs(deadlineMs, signal);
  if (typeof probeOutput === "string") {
    if (probeOutput.length > MAX_PROBE_BYTES) {
      throw new DecodeResourceError("invalid-metadata", "Decoder metadata exceeded its safe size.");
    }
  } else if (probeOutput.byteLength > MAX_PROBE_BYTES) {
    throw new DecodeResourceError("invalid-metadata", "Decoder metadata exceeded its safe size.");
  }

  let parsed: unknown;
  try {
    const text = typeof probeOutput === "string"
      ? probeOutput
      : new TextDecoder().decode(probeOutput);
    parsed = JSON.parse(text);
  } catch {
    throw new DecodeResourceError(
      "metadata-unavailable",
      "The compatibility decoder returned unreadable audio metadata.",
      true,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new DecodeResourceError(
      "metadata-unavailable",
      "The compatibility decoder did not return audio metadata.",
      true,
    );
  }

  const probe = parsed as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const stream = probe.streams?.[0];
  const sampleRate = positiveNumber(stream?.sample_rate);
  const channelCount = positiveNumber(stream?.channels);
  let durationSeconds = positiveNumber(stream?.duration) ?? positiveNumber(probe.format?.duration);
  if (durationSeconds == null) {
    const durationTicks = positiveNumber(stream?.duration_ts);
    const timeBase = parseTimeBase(stream?.time_base);
    if (durationTicks != null && timeBase != null) {
      durationSeconds = durationTicks * timeBase;
    }
  }

  const reportedFrames = positiveNumber(stream?.nb_frames);
  const codecName =
    typeof stream?.codec_name === "string" && stream.codec_name.length <= 64
      ? stream.codec_name
      : undefined;
  if (
    sampleRate == null ||
    !Number.isSafeInteger(sampleRate) ||
    channelCount == null ||
    !Number.isSafeInteger(channelCount) ||
    durationSeconds == null
  ) {
    throw new DecodeResourceError(
      "metadata-unavailable",
      "The source does not expose enough audio metadata for a bounded compatibility decode.",
      true,
    );
  }

  const estimatedFrames = Math.ceil(durationSeconds * sampleRate);
  const frameCount =
    reportedFrames != null && Number.isSafeInteger(reportedFrames)
      ? Math.max(reportedFrames, estimatedFrames)
      : estimatedFrames;
  const footprint = assertDecodedFootprint(
    { frameCount, channelCount, sampleRate, durationSeconds },
    budget,
    "Compatibility decoder preflight",
  );
  if (
    footprint.decodedBytes >
    Math.max(0, budget.maxOutputBytes - COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES)
  ) {
    throw new DecodeResourceError(
      "output-budget-exceeded",
      "The inspected PCM output plus its WAV header would exceed the compatibility decoder output budget.",
    );
  }

  return {
    sampleRate,
    channelCount,
    frameCount,
    durationSeconds,
    ...(codecName ? { codecName } : {}),
  };
}

async function probeWithFfmpeg(
  jobId: string,
  fileName: string,
  buffer: ArrayBuffer,
  budget: DecodeBudget,
  deadlineMs: number,
  signal: AbortSignal,
  allowCompatibilityDecoder: boolean,
) {
  ffmpegActiveJobId = jobId;
  const ffmpeg = await getFfmpeg(jobId, signal, allowCompatibilityDecoder);
  remainingTimeMs(deadlineMs, signal);
  ffmpegLogBuffer = [];
  const safeInput = `input-current.${safeExtension(fileName)}`;
  const safeProbe = "probe-current.json";

  try {
    await runFfmpegCall(() =>
      ffmpeg.writeFile(safeInput, new Uint8Array(buffer), { signal }),
    );
    remainingTimeMs(deadlineMs, signal);
    return await probeFfmpegInput(
      ffmpeg,
      safeInput,
      safeProbe,
      budget,
      deadlineMs,
      signal,
    );
  } finally {
    if (ffmpegActiveJobId === jobId) {
      ffmpegActiveJobId = null;
    }
    await Promise.allSettled([
      ffmpeg.deleteFile(safeInput),
      ffmpeg.deleteFile(safeProbe),
    ]);
  }
}

async function runProbe(message: Extract<DecoderRequest, { type: "probe" }>) {
  if (activeJobs.size > 0) {
    throw new DecodeResourceError(
      "decoder-busy",
      "This decoder lane is already processing another job.",
      true,
    );
  }

  const budget = resolveDecodeBudget(message.budget);
  const controller = new AbortController();
  activeJobs.set(message.jobId, controller);
  const startedAt = performance.now();
  const deadlineMs = startedAt + Math.min(PROBE_TIMEOUT_MS, budget.maxDecodeMs);
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DecodeResourceError(
        "time-limit-exceeded",
        "Audio metadata inspection exceeded its execution-time budget.",
        true,
      ),
    );
  }, Math.min(PROBE_TIMEOUT_MS, budget.maxDecodeMs));

  try {
    assertSourceWithinBudget(message.file.size, budget);
    let buffer: ArrayBuffer;
    try {
      buffer = await message.file.arrayBuffer();
    } catch (readError) {
      throw new Error(
        readError instanceof Error && readError.message
          ? `Could not read this file from disk: ${readError.message}`
          : "Could not read this file from disk for metadata inspection.",
      );
    }
    remainingTimeMs(deadlineMs, controller.signal);
    assertSourceWithinBudget(buffer.byteLength, budget);

    const sniffed = sniffCompressedMetadata(buffer);
    const metadata = sniffed ?? await probeWithFfmpeg(
      message.jobId,
      message.fileName,
      buffer,
      budget,
      deadlineMs,
      controller.signal,
      message.allowCompatibilityDecoder !== false,
    );
    remainingTimeMs(deadlineMs, controller.signal);
    const validated = validateDecodeProbeMetadata(
      metadata,
      budget,
      sniffed ? "Compressed header probe" : "Compatibility decoder probe",
    );
    const { decodedBytes: _decodedBytes, ...boundedMetadata } = validated;
    postMessageSafe({
      type: "probed",
      jobId: message.jobId,
      metadata: boundedMetadata,
    });
  } finally {
    clearTimeout(timeoutId);
    activeJobs.delete(message.jobId);
  }
}

async function decodeWithFfmpeg(
  jobId: string,
  fileName: string,
  mimeType: string,
  buffer: ArrayBuffer,
  budget: DecodeBudget,
  deadlineMs: number,
  signal: AbortSignal,
  allowCompatibilityDecoder: boolean,
) {
  const ffmpeg = await getFfmpeg(jobId, signal, allowCompatibilityDecoder);
  remainingTimeMs(deadlineMs, signal);
  ffmpegLogBuffer = [];

  const extension = safeExtension(fileName);
  // One decoder worker accepts one active job, so fixed virtual filenames
  // avoid treating the externally supplied job id as a filesystem path.
  const safeInput = `input-current.${extension}`;
  const safeOutput = "output-current.wav";
  const safeProbe = "probe-current.json";

  ffmpegActiveJobId = jobId;
  try {
    await runFfmpegCall(() =>
      ffmpeg.writeFile(safeInput, new Uint8Array(buffer), { signal }),
    );
    remainingTimeMs(deadlineMs, signal);
    const probe = await probeFfmpegInput(
      ffmpeg,
      safeInput,
      safeProbe,
      budget,
      deadlineMs,
      signal,
    );

    const exitCode = await runFfmpegCall(() =>
      ffmpeg.exec(
        [
          "-i",
          safeInput,
          "-map",
          "0:a:0",
          "-vn",
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-acodec",
          "pcm_f32le",
          "-f",
          "wav",
          "-fs",
          String(budget.maxOutputBytes),
          safeOutput,
        ],
        remainingTimeMs(deadlineMs, signal),
        { signal },
      ),
    );
    remainingTimeMs(deadlineMs, signal);

    if (exitCode !== 0) {
      if (ffmpegRuntimeAborted()) {
        terminateFfmpeg();
      }
      throw new Error(composeFfmpegError(`ffmpeg.wasm exited with code ${exitCode}.`));
    }

    const output = await runFfmpegCall(() =>
      ffmpeg.readFile(safeOutput, undefined, { signal }),
    );
    remainingTimeMs(deadlineMs, signal);
    if (typeof output === "string") {
      throw new Error("ffmpeg.wasm returned text instead of PCM data.");
    }
    const residentOutputBytes = Math.max(output.byteLength, output.buffer.byteLength);
    if (residentOutputBytes >= budget.maxOutputBytes) {
      throw new DecodeResourceError(
        "output-budget-exceeded",
        "Compatibility decoding reached its output limit; the possibly truncated audio was rejected.",
      );
    }

    const outputLimitWasReported = ffmpegLogBuffer.some((line) =>
      /file size limit|maximum file size|limit_size/i.test(line),
    );
    if (outputLimitWasReported) {
      throw new DecodeResourceError(
        "truncated-output",
        "Compatibility decoding reported an output limit; truncated audio was rejected.",
      );
    }

    const wavBuffer =
      output.byteOffset === 0 && output.byteLength === output.buffer.byteLength
        ? (output.buffer as ArrayBuffer)
        : (output.buffer.slice(
            output.byteOffset,
            output.byteOffset + output.byteLength,
          ) as ArrayBuffer);

    const asset = parseWavBuffer(wavBuffer, fileName, mimeType);
    const footprint = validatePlanarChannels(
      asset.channels,
      asset,
      budget,
      "Compatibility decoder output",
    );
    if (
      asset.sampleRate !== probe.sampleRate ||
      asset.channelCount !== probe.channelCount
    ) {
      throw new DecodeResourceError(
        "invalid-metadata",
        "Compatibility decoder output did not match the inspected sample rate and channel count.",
      );
    }
    const durationToleranceSeconds = Math.max(0.25, 4096 / probe.sampleRate);
    if (asset.durationSeconds + durationToleranceSeconds < probe.durationSeconds) {
      throw new DecodeResourceError(
        "truncated-output",
        "Compatibility decoding ended before the inspected source duration; truncated audio was rejected.",
      );
    }

    asset.sourceFormat = "ffmpeg-wav";
    asset.decoderMode = "ffmpeg-wasm";
    asset.decoderLabel = "Compatibility decoder";
    asset.decoderSummary =
      "Decoded through local ffmpeg.wasm assets for broader in-browser format support.";
    asset.decodeNotes = [
      ...asset.decodeNotes,
      "Transcoded locally to float WAV before loudness analysis for broader container support.",
    ];
    return { asset, outputBytes: output.byteLength, decodedBytes: footprint.decodedBytes };
  } catch (error) {
    if (signal.aborted) {
      terminateFfmpeg();
      throwIfAborted(signal);
    }
    throw error;
  } finally {
    if (ffmpegActiveJobId === jobId) {
      ffmpegActiveJobId = null;
    }
    await Promise.allSettled([
      ffmpeg.deleteFile(safeInput),
      ffmpeg.deleteFile(safeOutput),
      ffmpeg.deleteFile(safeProbe),
    ]);
  }
}

function validateNativeGeometry(
  geometry: ContainerPcmGeometry,
  preflight: AudioContainerPreflight,
) {
  if (
    geometry.channelCount !== preflight.channelCount ||
    geometry.bitDepth !== preflight.bitDepth ||
    geometry.frameCount !== preflight.frameCount
  ) {
    throw new DecodeResourceError(
      "invalid-metadata",
      "Native decoder output did not match the bounded container preflight metadata.",
    );
  }
}

function validateNativeAsset(
  asset: DecodedAudioAsset,
  budget: DecodeBudget,
  preflight: AudioContainerPreflight,
) {
  validateNativeGeometry(asset, preflight);
  if (asset.sampleRate !== preflight.sampleRate) {
    throw new DecodeResourceError(
      "invalid-metadata",
      "Native decoder output did not match the bounded container preflight metadata.",
    );
  }
  return validatePlanarChannels(asset.channels, asset, budget, "Native decoder output");
}

async function runDecode(message: Extract<DecoderRequest, { type: "decode" }>) {
  if (activeJobs.size > 0) {
    throw new DecodeResourceError(
      "decoder-busy",
      "This decoder lane is already processing another job.",
      true,
    );
  }

  const budget = resolveDecodeBudget(message.budget);
  const controller = new AbortController();
  activeJobs.set(message.jobId, controller);
  const startedAt = performance.now();
  const deadlineMs = startedAt + budget.maxDecodeMs;
  const timeoutId = setTimeout(() => {
    controller.abort(
      new DecodeResourceError(
        "time-limit-exceeded",
        `Audio decoding exceeded the ${budget.maxDecodeMs} ms execution-time budget.`,
      ),
    );
  }, budget.maxDecodeMs);

  try {
    assertSourceWithinBudget(message.file.size, budget);
    postMessageSafe({
      type: "progress",
      jobId: message.jobId,
      progress: 0.03,
      label: "Reading local file",
    });

    let buffer: ArrayBuffer;
    try {
      buffer = await message.file.arrayBuffer();
    } catch (readError) {
      throw new Error(
        readError instanceof Error && readError.message
          ? `Could not read this file from disk: ${readError.message}`
          : "Could not read this file from disk. It may have moved or changed since it was added.",
      );
    }
    remainingTimeMs(deadlineMs, controller.signal);
    assertSourceWithinBudget(buffer.byteLength, budget);
    // FFmpeg.writeFile transfers this ArrayBuffer to its nested worker and
    // detaches it here, so retain the verified size before compatibility decode.
    const sourceBytes = buffer.byteLength;

    postMessageSafe({
      type: "progress",
      jobId: message.jobId,
      progress: 0.05,
      label: "Inspecting container",
    });
    const container = sniffContainer(buffer);
    const containerMetadata = inspectAudioContainer(buffer);
    if (containerMetadata) {
      assertDecodedFootprint(containerMetadata, budget, "Container metadata");
    } else if (container === "wav" || container === "aiff") {
      throw new DecodeResourceError(
        "metadata-unavailable",
        `The ${container.toUpperCase()} header is incomplete or inconsistent, so it cannot be decoded within safe bounds.`,
        true,
      );
    }

    let asset: DecodedAudioAsset;
    let outputBytes: number | null = null;
    let decodedBytes: number;

    if (container === "wav") {
      postMessageSafe({
        type: "progress",
        jobId: message.jobId,
        progress: 0.3,
        label: "Parsing PCM wave file",
      });
      try {
        const preflight = containerMetadata as AudioContainerPreflight;
        asset = parseWavBuffer(
          buffer,
          message.fileName,
          message.mimeType,
          (geometry) => validateNativeGeometry(geometry, preflight),
        );
        decodedBytes = validateNativeAsset(
          asset,
          budget,
          preflight,
        ).decodedBytes;
      } catch (nativeError) {
        if (nativeError instanceof DecodeResourceError) {
          throw nativeError;
        }
        postMessageSafe({
          type: "progress",
          jobId: message.jobId,
          progress: 0.42,
          label: "Trying compatibility decoder for WAV",
        });

        try {
          const decoded = await decodeWithFfmpeg(
            message.jobId,
            message.fileName,
            message.mimeType,
            buffer,
            budget,
            deadlineMs,
            controller.signal,
            message.allowCompatibilityDecoder !== false,
          );
          asset = decoded.asset;
          decodedBytes = decoded.decodedBytes;
          outputBytes = decoded.outputBytes;
          asset.decodeNotes = [
            `Native WAV parser skipped: ${errorMessage(nativeError, "WAV parser failed.")}`,
            ...asset.decodeNotes,
          ];
        } catch (ffmpegError) {
          if (ffmpegError instanceof DecodeResourceError) {
            throw ffmpegError;
          }
          throw new Error(
            `WAV parser failed: ${errorMessage(nativeError, "Unable to parse WAV source.")} Compatibility decode failed: ${errorMessage(ffmpegError, "Unable to decode with ffmpeg.wasm.")}`,
          );
        }
      }
    } else if (container === "aiff") {
      postMessageSafe({
        type: "progress",
        jobId: message.jobId,
        progress: 0.3,
        label: "Parsing AIFF source",
      });
      try {
        const preflight = containerMetadata as AudioContainerPreflight;
        asset = parseAiffBuffer(
          buffer,
          message.fileName,
          message.mimeType,
          (geometry) => validateNativeGeometry(geometry, preflight),
        );
        decodedBytes = validateNativeAsset(
          asset,
          budget,
          preflight,
        ).decodedBytes;
      } catch (nativeError) {
        if (nativeError instanceof DecodeResourceError) {
          throw nativeError;
        }
        postMessageSafe({
          type: "progress",
          jobId: message.jobId,
          progress: 0.42,
          label: "Trying compatibility decoder for AIFF",
        });

        try {
          const decoded = await decodeWithFfmpeg(
            message.jobId,
            message.fileName,
            message.mimeType,
            buffer,
            budget,
            deadlineMs,
            controller.signal,
            message.allowCompatibilityDecoder !== false,
          );
          asset = decoded.asset;
          decodedBytes = decoded.decodedBytes;
          outputBytes = decoded.outputBytes;
          asset.decodeNotes = [
            `Native AIFF parser skipped: ${errorMessage(nativeError, "AIFF parser failed.")}`,
            ...asset.decodeNotes,
          ];
        } catch (ffmpegError) {
          if (ffmpegError instanceof DecodeResourceError) {
            throw ffmpegError;
          }
          throw new Error(
            `AIFF parser failed: ${errorMessage(nativeError, "Unable to parse AIFF source.")} Compatibility decode failed: ${errorMessage(ffmpegError, "Unable to decode with ffmpeg.wasm.")}`,
          );
        }
      }
    } else {
      const decoded = await decodeWithFfmpeg(
        message.jobId,
        message.fileName,
        message.mimeType,
        buffer,
        budget,
        deadlineMs,
        controller.signal,
        message.allowCompatibilityDecoder !== false,
      );
      asset = decoded.asset;
      decodedBytes = decoded.decodedBytes;
      outputBytes = decoded.outputBytes;
    }

    remainingTimeMs(deadlineMs, controller.signal);
    const transfer = toTransferAsset(asset);
    const usage: DecodeResourceUsage = {
      sourceBytes,
      decodedBytes,
      outputBytes,
      channelCount: asset.channelCount,
      frameCount: asset.frameCount,
      elapsedMs: performance.now() - startedAt,
    };
    postMessageSafe(
      { type: "decoded", jobId: message.jobId, asset: transfer, usage },
      transfer.channelBuffers,
    );
  } finally {
    clearTimeout(timeoutId);
    activeJobs.delete(message.jobId);
  }
}

ctx.onmessage = (event: MessageEvent<DecoderRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    activeJobs
      .get(message.jobId)
      ?.abort(new DecodeResourceError("cancelled", "Audio decoding was canceled."));
    return;
  }

  if (message.type === "probe") {
    void runProbe(message).catch((error) => {
      postDecodeError(message.jobId, error, "probe");
    });
    return;
  }

  void runDecode(message).catch((error) => {
    postDecodeError(message.jobId, error);
  });
};
