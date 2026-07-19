import { FFmpeg } from "@ffmpeg/ffmpeg";
import { parseAiffBuffer } from "@/audio/aiff";
import {
  DecodeResourceError,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  decodeFailureDetails,
  inspectAudioContainer,
  resolveDecodeBudget,
  throwIfAborted,
  validatePlanarChannels,
} from "@/audio/decode-budget";
import { toTransferAsset } from "@/audio/serialise";
import { parseWavBuffer } from "@/audio/wav";
import type { AudioContainerPreflight, DecodeBudget } from "@/audio/decode-budget";
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
const WAV_HEADER_ALLOWANCE_BYTES = 64 * 1024;

let ffmpegPromise: Promise<FFmpeg> | null = null;
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLogBuffer: string[] = [];
let ffmpegActiveJobId: string | null = null;
const activeJobs = new Map<string, AbortController>();

function postMessageSafe(message: DecoderResponse, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

function postDecodeError(jobId: string, error: unknown) {
  const details = decodeFailureDetails(error);
  postMessageSafe({
    type: "error",
    jobId,
    error: details.message,
    code: details.code,
    retryable: details.retryable,
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getLocalAssetUrl(fileName: string) {
  return new URL(`/vendor/ffmpeg/${fileName}`, ctx.location.origin).toString();
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

async function getFfmpeg(jobId: string, signal: AbortSignal) {
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
          coreURL: getLocalAssetUrl("ffmpeg-core.js"),
          wasmURL: getLocalAssetUrl("ffmpeg-core.wasm"),
        },
        { signal },
      )
      .then(() => instance);
    const tracked = loading.catch((error) => {
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
      throw error;
    });
    ffmpegPromise = tracked;
  }

  return ffmpegPromise;
}

interface FfmpegProbe {
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  durationSeconds: number;
}

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

async function probeFfmpegInput(
  ffmpeg: FFmpeg,
  safeInput: string,
  safeProbe: string,
  budget: DecodeBudget,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<FfmpegProbe> {
  const exitCode = await ffmpeg.ffprobe(
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,channels,duration,duration_ts,time_base,nb_frames:format=duration",
      "-of",
      "json",
      safeInput,
      "-o",
      safeProbe,
    ],
    remainingTimeMs(deadlineMs, signal),
    { signal },
  );
  remainingTimeMs(deadlineMs, signal);
  if (exitCode !== 0) {
    throw new DecodeResourceError(
      "metadata-unavailable",
      composeFfmpegError("The compatibility decoder could not inspect this audio source safely."),
      true,
    );
  }

  const probeOutput = await ffmpeg.readFile(safeProbe, undefined, { signal });
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
    Math.max(0, budget.maxOutputBytes - WAV_HEADER_ALLOWANCE_BYTES)
  ) {
    throw new DecodeResourceError(
      "output-budget-exceeded",
      "The inspected PCM output plus its WAV header would exceed the compatibility decoder output budget.",
    );
  }

  return { sampleRate, channelCount, frameCount, durationSeconds };
}

async function decodeWithFfmpeg(
  jobId: string,
  fileName: string,
  mimeType: string,
  buffer: ArrayBuffer,
  budget: DecodeBudget,
  deadlineMs: number,
  signal: AbortSignal,
) {
  const ffmpeg = await getFfmpeg(jobId, signal);
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
    await ffmpeg.writeFile(safeInput, new Uint8Array(buffer), { signal });
    remainingTimeMs(deadlineMs, signal);
    const probe = await probeFfmpegInput(
      ffmpeg,
      safeInput,
      safeProbe,
      budget,
      deadlineMs,
      signal,
    );

    const exitCode = await ffmpeg.exec(
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
    );
    remainingTimeMs(deadlineMs, signal);

    if (exitCode !== 0) {
      throw new Error(composeFfmpegError(`ffmpeg.wasm exited with code ${exitCode}.`));
    }

    const output = await ffmpeg.readFile(safeOutput, undefined, { signal });
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

function validateNativeAsset(
  asset: DecodedAudioAsset,
  budget: DecodeBudget,
  preflight: AudioContainerPreflight,
) {
  if (
    asset.sampleRate !== preflight.sampleRate ||
    asset.channelCount !== preflight.channelCount ||
    asset.bitDepth !== preflight.bitDepth ||
    asset.frameCount !== preflight.frameCount
  ) {
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
        asset = parseWavBuffer(buffer, message.fileName, message.mimeType);
        decodedBytes = validateNativeAsset(
          asset,
          budget,
          containerMetadata as AudioContainerPreflight,
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
        asset = parseAiffBuffer(buffer, message.fileName, message.mimeType);
        decodedBytes = validateNativeAsset(
          asset,
          budget,
          containerMetadata as AudioContainerPreflight,
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

  void runDecode(message).catch((error) => {
    postDecodeError(message.jobId, error);
  });
};
