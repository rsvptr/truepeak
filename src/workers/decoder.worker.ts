import { FFmpeg } from "@ffmpeg/ffmpeg";
import { parseAiffBuffer } from "@/audio/aiff";
import { toTransferAsset } from "@/audio/serialise";
import { parseWavBuffer } from "@/audio/wav";
import type { DecoderRequest, DecoderResponse } from "@/workers/shared/messages";

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const MAX_LOG_LINES = 10;

let ffmpegPromise: Promise<FFmpeg> | null = null;
let ffmpegLogBuffer: string[] = [];
let ffmpegActiveJobId: string | null = null;

function postMessageSafe(message: DecoderResponse, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

function pushFfmpegLog(message: string) {
  ffmpegLogBuffer.push(message);
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

async function getFfmpeg(jobId: string) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      ffmpegLogBuffer = [];
      postMessageSafe({
        type: "progress",
        jobId,
        progress: 0.16,
        label: "Loading compatibility decoder",
      });

      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        const activeJobId = ffmpegActiveJobId;
        if (!activeJobId) {
          return;
        }

        postMessageSafe({
          type: "progress",
          jobId: activeJobId,
          progress: Math.min(0.84, 0.24 + progress * 0.52),
          label: "Transcoding unsupported format in-browser",
        });
      });
      ffmpeg.on("log", ({ message }) => {
        pushFfmpegLog(message);
      });

      await ffmpeg.load({
        coreURL: getLocalAssetUrl("ffmpeg-core.js"),
        wasmURL: getLocalAssetUrl("ffmpeg-core.wasm"),
      });
      return ffmpeg;
    })().catch((error) => {
      ffmpegPromise = null;
      throw error;
    });
  }

  return ffmpegPromise;
}

async function decodeWithFfmpeg(
  jobId: string,
  fileName: string,
  mimeType: string,
  buffer: ArrayBuffer,
) {
  const ffmpeg = await getFfmpeg(jobId);
  ffmpegLogBuffer = [];

  const extension = safeExtension(fileName);
  const safeInput = `input-${jobId}.${extension}`;
  const safeOutput = `output-${jobId}.wav`;

  ffmpegActiveJobId = jobId;
  try {
    await ffmpeg.writeFile(safeInput, new Uint8Array(buffer));
    const exitCode = await ffmpeg.exec([
      "-i",
      safeInput,
      "-vn",
      "-acodec",
      "pcm_f32le",
      "-f",
      "wav",
      safeOutput,
    ]);

    if (exitCode !== 0) {
      throw new Error(composeFfmpegError(`ffmpeg.wasm exited with code ${exitCode}.`));
    }

    const output = await ffmpeg.readFile(safeOutput);
    if (typeof output === "string") {
      throw new Error("ffmpeg.wasm returned text instead of PCM data.");
    }

    const wavBuffer =
      output instanceof Uint8Array
        ? (output.buffer.slice(
            output.byteOffset,
            output.byteOffset + output.byteLength,
          ) as ArrayBuffer)
        : (output as ArrayBuffer);

    const asset = parseWavBuffer(wavBuffer, fileName, mimeType);
    asset.sourceFormat = "ffmpeg-wav";
    asset.decoderMode = "ffmpeg-wasm";
    asset.decoderLabel = "Compatibility decoder";
    asset.decoderSummary =
      "Decoded through local ffmpeg.wasm assets for broader in-browser format support.";
    asset.decodeNotes = [
      ...asset.decodeNotes,
      "Transcoded locally to float WAV before loudness analysis for broader container support.",
    ];
    return asset;
  } finally {
    if (ffmpegActiveJobId === jobId) {
      ffmpegActiveJobId = null;
    }
    await Promise.allSettled([ffmpeg.deleteFile(safeInput), ffmpeg.deleteFile(safeOutput)]);
  }
}

ctx.onmessage = async (event: MessageEvent<DecoderRequest>) => {
  const message = event.data;
  if (message.type !== "decode") {
    return;
  }

  try {
    postMessageSafe({
      type: "progress",
      jobId: message.jobId,
      progress: 0.05,
      label: "Inspecting container",
    });
    const container = sniffContainer(message.buffer);
    let asset;

    if (container === "wav") {
      postMessageSafe({
        type: "progress",
        jobId: message.jobId,
        progress: 0.3,
        label: "Parsing PCM wave file",
      });
      try {
        asset = parseWavBuffer(message.buffer, message.fileName, message.mimeType);
      } catch (nativeError) {
        postMessageSafe({
          type: "progress",
          jobId: message.jobId,
          progress: 0.42,
          label: "Trying compatibility decoder for WAV",
        });

        try {
          asset = await decodeWithFfmpeg(
            message.jobId,
            message.fileName,
            message.mimeType,
            message.buffer,
          );
          asset.decodeNotes = [
            `Native WAV parser skipped: ${errorMessage(nativeError, "WAV parser failed.")}`,
            ...asset.decodeNotes,
          ];
        } catch (ffmpegError) {
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
        asset = parseAiffBuffer(message.buffer, message.fileName, message.mimeType);
      } catch (nativeError) {
        postMessageSafe({
          type: "progress",
          jobId: message.jobId,
          progress: 0.42,
          label: "Trying compatibility decoder for AIFF",
        });

        try {
          asset = await decodeWithFfmpeg(
            message.jobId,
            message.fileName,
            message.mimeType,
            message.buffer,
          );
          asset.decodeNotes = [
            `Native AIFF parser skipped: ${errorMessage(nativeError, "AIFF parser failed.")}`,
            ...asset.decodeNotes,
          ];
        } catch (ffmpegError) {
          throw new Error(
            `AIFF parser failed: ${errorMessage(nativeError, "Unable to parse AIFF source.")} Compatibility decode failed: ${errorMessage(ffmpegError, "Unable to decode with ffmpeg.wasm.")}`,
          );
        }
      }
    } else {
      asset = await decodeWithFfmpeg(
        message.jobId,
        message.fileName,
        message.mimeType,
        message.buffer,
      );
    }

    const transfer = toTransferAsset(asset);
    postMessageSafe(
      { type: "decoded", jobId: message.jobId, asset: transfer },
      transfer.channelBuffers,
    );
  } catch (error) {
    postMessageSafe({
      type: "error",
      jobId: message.jobId,
      error: error instanceof Error ? error.message : "Unable to decode the selected file.",
    });
  }
};
