import { deriveChannelLayout } from "@/audio/channel-layout";
import {
  DecodeResourceError,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  inspectAudioContainer,
  resolveDecodeBudget,
  throwIfAborted,
  validatePlanarChannels,
} from "@/audio/decode-budget";
import { toTransferAsset } from "@/audio/serialise";
import type { DecodeBudget } from "@/audio/decode-budget";
import type { DecodedAudioTransfer, SourceFormat } from "@/types/audio";

const WAVE_EXTENSIONS = new Set(["wav", "rf64"]);
const AIFF_EXTENSIONS = new Set(["aif", "aiff", "aifc"]);
const numberFormatter = new Intl.NumberFormat("en-GB");

interface FlacStreamInfo {
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  frameCount: number;
  durationSeconds: number;
}

export interface BrowserDecodeOptions {
  signal?: AbortSignal;
  budget?: DecodeBudget;
}

function inferSourceFormat(fileName: string): SourceFormat {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension === "wav") {
    return "wav";
  }

  if (extension === "rf64") {
    return "rf64";
  }

  if (extension === "aif" || extension === "aiff") {
    return "aiff";
  }

  if (extension === "aifc") {
    return "aifc";
  }

  return "browser-decoded";
}

export function shouldPreferBrowserDecoder(fileName: string, mimeType: string) {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const lowerMime = mimeType.toLowerCase();

  if (WAVE_EXTENSIONS.has(extension) || AIFF_EXTENSIONS.has(extension)) {
    return false;
  }

  if (lowerMime.includes("wav") || lowerMime.includes("aiff")) {
    return false;
  }

  return true;
}

function getAudioContextConstructor() {
  const candidate =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!candidate) {
    throw new Error("This browser does not expose a Web Audio decoder.");
  }

  return candidate;
}

// Exported for the fuzz suite: this runs on the main thread against untrusted
// bytes before the browser decoder sees them, so it gets fuzzed directly.
export function parseFlacStreamInfo(buffer: ArrayBuffer): FlacStreamInfo | null {
  const metadata = inspectAudioContainer(buffer);
  return metadata?.container === "flac"
    ? {
        sampleRate: metadata.sampleRate,
        channelCount: metadata.channelCount,
        bitDepth: metadata.bitDepth,
        frameCount: metadata.frameCount,
        durationSeconds: metadata.durationSeconds,
      }
    : null;
}

// Web Audio exposes no reliable cancellation primitive for decodeAudioData.
// Never reject the wrapper while that decode is still running: callers use
// settlement to release/reassign a lane, and early rejection would allow the
// unabortable decode to overlap the replacement job. The UI can react to its
// own AbortSignal immediately; this promise drains first, then reports the
// cancellation before any channel copy or analysis handoff.
export async function waitForBrowserDecodeDrain<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const value = await promise;
    throwIfAborted(signal);
    return value;
  } catch (error) {
    // A cancellation/time-budget reason takes precedence once the underlying
    // decoder has drained; otherwise preserve the decoder's original error.
    throwIfAborted(signal);
    throw error;
  }
}

function createDecodeSignal(externalSignal: AbortSignal | undefined, maxDecodeMs: number) {
  const controller = new AbortController();
  const forwardExternalAbort = () => {
    controller.abort(
      externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new DecodeResourceError("cancelled", "Audio decoding was canceled."),
    );
  };
  if (externalSignal?.aborted) {
    forwardExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    controller.abort(
      new DecodeResourceError(
        "time-limit-exceeded",
        `Browser decoding exceeded the ${maxDecodeMs} ms execution-time budget.`,
      ),
    );
  }, maxDecodeMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", forwardExternalAbort);
    },
  };
}

function createAudioContext(
  AudioContextConstructor: typeof AudioContext,
  sourceMetadata: FlacStreamInfo | null,
) {
  if (sourceMetadata?.sampleRate) {
    try {
      return {
        context: new AudioContextConstructor({ sampleRate: sourceMetadata.sampleRate }),
        requestedSourceRate: true,
      };
    } catch {
      // Some browsers expose the options bag but reject specific rates. Fall back to default decode behaviour.
    }
  }

  return {
    context: new AudioContextConstructor(),
    requestedSourceRate: false,
  };
}

export async function decodeAudioFileInBrowser(
  file: File,
  primaryError?: string,
  sourceBuffer?: ArrayBuffer,
  options: BrowserDecodeOptions = {},
): Promise<DecodedAudioTransfer> {
  const AudioContextConstructor = getAudioContextConstructor();
  const budget = resolveDecodeBudget(options.budget);
  const decodeSignal = createDecodeSignal(options.signal, budget.maxDecodeMs);
  let context: AudioContext | null = null;

  try {
    throwIfAborted(decodeSignal.signal);
    if (!sourceBuffer) {
      assertSourceWithinBudget(file.size, budget);
    }
    const input = sourceBuffer ?? await file.arrayBuffer();
    throwIfAborted(decodeSignal.signal);
    assertSourceWithinBudget(input.byteLength, budget);
    const sourceMetadata = parseFlacStreamInfo(input);
    if (sourceMetadata) {
      assertDecodedFootprint(sourceMetadata, budget, "FLAC STREAMINFO");
    }
    const contextState = createAudioContext(AudioContextConstructor, sourceMetadata);
    context = contextState.context;
    const decoded = await waitForBrowserDecodeDrain(
      context.decodeAudioData(input),
      decodeSignal.signal,
    );
    throwIfAborted(decodeSignal.signal);
    const channelCount = decoded.numberOfChannels;
    assertDecodedFootprint(
      {
        frameCount: decoded.length,
        channelCount,
        sampleRate: decoded.sampleRate,
        durationSeconds: decoded.duration,
      },
      budget,
      "Browser decoder output",
    );

    const channelViews: Float32Array[] = [];
    for (let index = 0; index < channelCount; index += 1) {
      throwIfAborted(decodeSignal.signal);
      channelViews.push(decoded.getChannelData(index));
    }
    validatePlanarChannels(
      channelViews,
      {
        frameCount: decoded.length,
        channelCount,
        sampleRate: decoded.sampleRate,
        durationSeconds: decoded.duration,
      },
      budget,
      "Browser decoder output",
    );

    const channels: Float32Array[] = [];
    for (const channelView of channelViews) {
      throwIfAborted(decodeSignal.signal);
      channels.push(new Float32Array(channelView));
    }
    throwIfAborted(decodeSignal.signal);
    validatePlanarChannels(
      channels,
      {
        frameCount: decoded.length,
        channelCount,
        sampleRate: decoded.sampleRate,
        durationSeconds: decoded.duration,
      },
      budget,
      "Copied browser decoder output",
    );

    const decodeNotes = [
      "Decoded with the browser audio decoder. Container-level metadata may be reduced compared with the dedicated container parser.",
    ];
    const warnings: string[] = [];
    if (primaryError) {
      decodeNotes.unshift(`Fallback used after another decoder failed: ${primaryError}`);
    }
    if (sourceMetadata) {
      decodeNotes.push(
        `FLAC STREAMINFO reports ${numberFormatter.format(sourceMetadata.sampleRate)} Hz, ${sourceMetadata.bitDepth}-bit, ${sourceMetadata.channelCount} channel${sourceMetadata.channelCount === 1 ? "" : "s"}.`,
      );
      if (contextState.requestedSourceRate) {
        decodeNotes.push(
          `Requested browser decoding at the source sample rate of ${numberFormatter.format(sourceMetadata.sampleRate)} Hz.`,
        );
      }
      if (decoded.sampleRate !== sourceMetadata.sampleRate) {
        warnings.push(
          `Browser decoder returned ${numberFormatter.format(decoded.sampleRate)} Hz after source metadata reported ${numberFormatter.format(sourceMetadata.sampleRate)} Hz; analysis uses the decoded PCM sample rate.`,
        );
      }
      if (decoded.numberOfChannels !== sourceMetadata.channelCount) {
        warnings.push(
          `Browser decoder returned ${decoded.numberOfChannels} channel${decoded.numberOfChannels === 1 ? "" : "s"} after source metadata reported ${sourceMetadata.channelCount}.`,
        );
      }
      if (decoded.length !== sourceMetadata.frameCount) {
        warnings.push(
          `Browser decoder returned ${numberFormatter.format(decoded.length)} frames after source metadata reported ${numberFormatter.format(sourceMetadata.frameCount)}; analysis uses the decoded PCM frame count.`,
        );
      }
    }

    return toTransferAsset({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sourceFormat: inferSourceFormat(file.name),
      sampleRate: decoded.sampleRate,
      bitDepth: sourceMetadata?.bitDepth ?? 32,
      durationSeconds: decoded.duration,
      frameCount: decoded.length,
      channelCount,
      channelLayout: deriveChannelLayout(channelCount, null),
      decoderMode: "browser-audio",
      decoderLabel: "Browser audio decoder",
      decoderSummary: "Decoded through the browser codec stack for fast in-browser compatibility.",
      decodeNotes,
      warnings,
      channels,
    });
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("The browser decoder could not read this audio file.");
  } finally {
    decodeSignal.cleanup();
    void context?.close().catch(() => undefined);
  }
}
