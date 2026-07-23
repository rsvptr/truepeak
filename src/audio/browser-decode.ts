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

// Bounded grace an already-aborted browser decode is given to actually drain
// before it is abandoned. decodeAudioData exposes no cancellation and, for some
// pathological inputs, its promise never settles (a documented WebKit/Blink
// failure mode). Without a bound the drain wait parks forever, pinning the
// browser-decode window slot and deadlocking every later browser decode on a
// capacity-1 device. 10 s is long enough that a merely-slow decode still drains
// on the normal path (so its transient memory is freed before the slot is
// released), yet short enough to recover a genuinely stuck decode promptly.
const BROWSER_DECODE_DRAIN_GRACE_MS = 10_000;

// Thrown when a browser decode has not settled within the post-abort drain
// grace. Distinct from an ordinary abort so the caller can retire the lane the
// (possibly still-running) decode is on. Uses the time-limit-exceeded code so
// existing failure classification treats it as a non-retryable time-budget
// failure, exactly like the maxDecodeMs abort it escalates from.
export class BrowserDecodeDrainTimeoutError extends DecodeResourceError {
  constructor(message: string) {
    super("time-limit-exceeded", message);
    this.name = "BrowserDecodeDrainTimeoutError";
  }
}

export function isBrowserDecodeDrainTimeout(
  error: unknown,
): error is BrowserDecodeDrainTimeoutError {
  return error instanceof BrowserDecodeDrainTimeoutError;
}

// Web Audio exposes no reliable cancellation primitive for decodeAudioData.
// On the normal path we never reject the wrapper while that decode is still
// running: callers use settlement to release/reassign a lane, and early
// rejection would allow the unabortable decode to overlap the replacement job.
// The UI reacts to its own AbortSignal immediately; this promise drains first,
// then reports the cancellation before any channel copy or analysis handoff.
//
// The one exception is a decode whose promise never settles: once the signal
// has aborted (cancel or the maxDecodeMs budget), the still-pending decode is
// raced against a bounded grace timer, and on expiry the wrapper rejects with a
// terminal BrowserDecodeDrainTimeoutError instead of parking forever. That is
// the only way the browser-decode window slot can be reclaimed from a zombie
// decode; the caller retires the lane so the still-draining decode never
// overlaps a future job. A NORMALLY-settling decode is unaffected: the grace
// only ever arms after an abort, and a decode that drains within it still
// reports the cancellation reason (release only after settle is preserved).
export async function waitForBrowserDecodeDrain<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  graceMs: number = BROWSER_DECODE_DRAIN_GRACE_MS,
): Promise<T> {
  throwIfAborted(signal);

  // If the grace race abandons `promise` (or the guard above already threw), a
  // later rejection from decodeAudioData must not surface as an unhandled
  // rejection. This side-chain swallows it and does not consume the rejection
  // for the race, which observes the original promise independently.
  void promise.catch(() => undefined);

  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  // Only ever rejects — and only once the signal has aborted and the bounded
  // grace has then elapsed without the decode settling.
  const drainGrace = new Promise<never>((_, reject) => {
    const armGrace = () => {
      if (graceTimer != null) {
        return;
      }
      graceTimer = setTimeout(() => {
        reject(
          new BrowserDecodeDrainTimeoutError(
            "Browser decoding did not finish within its time budget and was abandoned.",
          ),
        );
      }, graceMs);
    };

    if (signal?.aborted) {
      armGrace();
    } else if (signal) {
      abortListener = armGrace;
      signal.addEventListener("abort", armGrace, { once: true });
    }
  });

  try {
    const value = await Promise.race([promise, drainGrace]);
    throwIfAborted(signal);
    return value;
  } catch (error) {
    // The drain-grace expiry is terminal and must survive: the caller keys lane
    // retirement on it, so it must not be masked by the signal's abort reason.
    // Every other rejection still defers to a cancellation/time-budget reason
    // once the decoder has drained, else preserves the decoder's own error.
    if (isBrowserDecodeDrainTimeout(error)) {
      throw error;
    }
    throwIfAborted(signal);
    throw error;
  } finally {
    if (graceTimer != null) {
      clearTimeout(graceTimer);
    }
    if (abortListener && signal) {
      signal.removeEventListener("abort", abortListener);
    }
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
    // Always close the context, including the abort/zombie-drain path: a decode
    // that never settled still holds native decoder resources, and closing lets
    // the browser drop that work once the drain grace has given up on it.
    void context?.close().catch(() => undefined);
  }
}
