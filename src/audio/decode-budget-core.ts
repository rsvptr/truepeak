const MEBIBYTE = 1024 * 1024;

export const MAX_DECODE_CHANNELS = 32;
export const COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES = 64 * 1024;

export interface DecodeBudget {
  maxSourceBytes: number;
  maxDecodedBytes: number;
  maxOutputBytes: number;
  maxChannels: number;
  maxFrames: number;
  maxDurationSeconds: number;
  maxDecodeMs: number;
}

export type DecodeFailureCode =
  | "cancelled"
  | "source-budget-exceeded"
  | "decoded-budget-exceeded"
  | "output-budget-exceeded"
  | "channel-limit-exceeded"
  | "frame-limit-exceeded"
  | "duration-limit-exceeded"
  | "time-limit-exceeded"
  | "truncated-output"
  | "invalid-metadata"
  | "metadata-unavailable"
  | "decoder-busy"
  | "decode-failed";

export class DecodeResourceError extends Error {
  readonly code: DecodeFailureCode;
  readonly retryable: boolean;

  constructor(code: DecodeFailureCode, message: string, retryable = false) {
    super(message);
    this.name = "DecodeResourceError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Defaults are deliberately below the absolute ceilings. A later scheduler can
 * lower these per lane/device, but no caller can raise them past HARD_DECODE_LIMITS.
 * The default tier protects constrained devices; 256 MiB of float32 PCM is only
 * about 2.9 minutes of stereo 192 kHz audio, so capable devices resolve the
 * larger tier below instead.
 */
export const DEFAULT_DECODE_BUDGET: Readonly<DecodeBudget> = Object.freeze({
  maxSourceBytes: 512 * MEBIBYTE,
  maxDecodedBytes: 256 * MEBIBYTE,
  maxOutputBytes: 257 * MEBIBYTE,
  maxChannels: MAX_DECODE_CHANNELS,
  maxFrames: 200_000_000,
  maxDurationSeconds: 6 * 60 * 60,
  maxDecodeMs: 2 * 60 * 1000,
});

/**
 * Budget tier for devices that report 8 GB or more of memory (or a fine
 * pointer with no memory signal, matching the aggregate-capacity rule). One
 * GiB of decoded float32 PCM covers about 11.6 minutes of stereo 192 kHz or
 * 23 minutes of stereo 96 kHz, so ordinary high-resolution masters fit. The
 * decode-time ceiling is doubled because files this large legitimately take
 * longer through every route. Heavy-file exclusivity and the aggregate
 * reservation cap still bound the batch-level footprint.
 */
export const LARGE_MEMORY_DECODE_BUDGET: Readonly<DecodeBudget> = Object.freeze({
  maxSourceBytes: 1024 * MEBIBYTE,
  maxDecodedBytes: 1024 * MEBIBYTE,
  maxOutputBytes: 1025 * MEBIBYTE,
  maxChannels: MAX_DECODE_CHANNELS,
  maxFrames: 200_000_000,
  maxDurationSeconds: 6 * 60 * 60,
  maxDecodeMs: 4 * 60 * 1000,
});

export const HARD_DECODE_LIMITS: Readonly<DecodeBudget> = Object.freeze({
  maxSourceBytes: 2048 * MEBIBYTE,
  maxDecodedBytes: 1536 * MEBIBYTE,
  maxOutputBytes: 1537 * MEBIBYTE,
  maxChannels: MAX_DECODE_CHANNELS,
  maxFrames: 250_000_000,
  maxDurationSeconds: 12 * 60 * 60,
  maxDecodeMs: 5 * 60 * 1000,
});

function formatBudgetBytes(bytes: number) {
  const mebibytes = bytes / MEBIBYTE;
  if (mebibytes >= 1024) {
    const gibibytes = mebibytes / 1024;
    return `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GB`;
  }
  return `${Math.round(mebibytes)} MB`;
}

function formatBudgetDuration(seconds: number) {
  if (seconds >= 60 * 60 && seconds % (60 * 60) === 0) {
    const hours = seconds / (60 * 60);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** A plain device-limit sentence shared by refusal messages and UI guidance. */
export function describeDeviceDecodeLimit(budget: DecodeBudget) {
  const stereo48KhzMinutes = Math.max(
    1,
    Math.round(
      budget.maxDecodedBytes /
        (48_000 * 2 * Float32Array.BYTES_PER_ELEMENT * 60),
    ),
  );
  return `On this device, source files can be up to ${formatBudgetBytes(budget.maxSourceBytes)}, with working memory for about ${stereo48KhzMinutes} minutes of stereo 48 kHz audio.`;
}

/** Converts structured decoder failures into short, actionable user-facing copy. */
export function decodeFailureSummary(
  code: DecodeFailureCode,
  budget: DecodeBudget = DEFAULT_DECODE_BUDGET,
) {
  switch (code) {
    case "cancelled":
      return "Analysis was canceled.";
    case "source-budget-exceeded":
      return `This file is larger than this device can analyze safely. ${describeDeviceDecodeLimit(budget)} Try a smaller file or another device.`;
    case "decoded-budget-exceeded":
      return `This file needs more than the available ${formatBudgetBytes(budget.maxDecodedBytes)} of audio working memory. Try a shorter file, fewer channels, or another device.`;
    case "output-budget-exceeded":
      return `The compatibility decoder would create more than the available ${formatBudgetBytes(budget.maxOutputBytes)} output limit. Try a shorter file or convert it to WAV or AIFF.`;
    case "channel-limit-exceeded":
      return `This file has more than ${Math.min(MAX_DECODE_CHANNELS, budget.maxChannels)} channels. Export it with fewer channels, then add it again.`;
    case "frame-limit-exceeded":
      return "This file contains more audio frames than can be analyzed safely. Try a shorter file or a lower sample rate.";
    case "duration-limit-exceeded":
      return `This file is longer than the ${formatBudgetDuration(budget.maxDurationSeconds)} analysis limit. Split it into shorter files, then try again.`;
    case "time-limit-exceeded":
      return `Decoding took longer than the ${formatBudgetDuration(budget.maxDecodeMs / 1000)} safety limit. Try a shorter file or convert it to WAV or AIFF.`;
    case "truncated-output":
      return "The compatibility decoder produced an incomplete audio file. Try Browser first or convert the source to WAV or AIFF.";
    case "invalid-metadata":
      return "TruePeak could not verify this file's audio structure. Re-export or convert the file, then try again.";
    case "metadata-unavailable":
      return "The compatibility decoder could not inspect this file safely. Try Browser first or convert the source to WAV or AIFF.";
    case "decoder-busy":
      return "This device does not have enough free analysis capacity right now. Wait for current files to finish or reduce parallel files, then retry.";
    case "decode-failed":
      return "TruePeak could not decode this file. Try the other decoder route or convert the source to WAV or AIFF.";
  }
}

/** Best-effort classification for older saved errors that predate structured codes. */
export function inferDecodeFailureCode(message: string): DecodeFailureCode | null {
  const lower = message.toLowerCase();
  if (lower.includes("cancel")) return "cancelled";
  if (lower.includes("source-budget") || lower.includes("safe decode limit")) {
    return "source-budget-exceeded";
  }
  if (lower.includes("output-budget") || lower.includes("output limit")) {
    return "output-budget-exceeded";
  }
  if (lower.includes("channel-limit") || (lower.includes("channels") && lower.includes("at most"))) {
    return "channel-limit-exceeded";
  }
  if (lower.includes("frame-limit") || (lower.includes("frames") && lower.includes("safe limit"))) {
    return "frame-limit-exceeded";
  }
  if (lower.includes("duration-limit") || (lower.includes("seconds long") && lower.includes("safe limit"))) {
    return "duration-limit-exceeded";
  }
  if (
    lower.includes("time-limit") ||
    lower.includes("execution-time budget") ||
    lower.includes("decode timed out")
  ) {
    return "time-limit-exceeded";
  }
  if (lower.includes("truncated") || lower.includes("incomplete audio")) {
    return "truncated-output";
  }
  if (
    lower.includes("metadata-unavailable") ||
    lower.includes("could not inspect") ||
    lower.includes("no audio stream")
  ) {
    return "metadata-unavailable";
  }
  if (
    lower.includes("invalid-metadata") ||
    lower.includes("does not match the reported") ||
    lower.includes("must be a positive") ||
    lower.includes("must be finite")
  ) {
    return "invalid-metadata";
  }
  if (lower.includes("decoder-busy") || lower.includes("analysis capacity")) {
    return "decoder-busy";
  }
  if (
    lower.includes("decoded-budget") ||
    lower.includes("decoded bytes") ||
    lower.includes("resident bytes") ||
    lower.includes("safe integer arithmetic")
  ) {
    return "decoded-budget-exceeded";
  }
  if (
    lower.includes("couldn't decode") ||
    lower.includes("decode failed") ||
    lower.includes("unable to decode")
  ) {
    return "decode-failed";
  }
  return null;
}

export interface AudioContainerPreflight {
  container: "flac" | "wav" | "rf64" | "aiff" | "aifc";
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  frameCount: number;
  durationSeconds: number;
  /** True only when the bounded native parser can decode this complete shape. */
  nativeDecodeSafe: boolean;
}

export interface DecodedFootprint {
  frameCount: number;
  channelCount: number;
  decodedBytes: number;
  durationSeconds: number | null;
}

/** Bounded source geometry returned by a container header or codec probe. */
export interface DecodeProbeMetadata {
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  durationSeconds: number;
  codecName?: string;
}

export type ProbedDecodeFootprintPlan =
  | {
      kind: "known";
      metadata: DecodeProbeMetadata;
      decodedBytes: number;
    }
  | { kind: "unknown" };

export interface PlanarChannelView {
  length: number;
  byteLength: number;
}

export function finitePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} must be a positive safe integer.`,
    );
  }

  return value;
}

export function finitePositiveNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DecodeResourceError("invalid-metadata", `${label} must be finite and positive.`);
  }

  return value;
}

export function checkedMultiply(left: number, right: number, label: string) {
  finitePositiveInteger(left, `${label} left operand`);
  finitePositiveInteger(right, `${label} right operand`);
  if (left > Math.floor(Number.MAX_SAFE_INTEGER / right)) {
    throw new DecodeResourceError(
      "decoded-budget-exceeded",
      `${label} exceeds safe integer arithmetic.`,
    );
  }

  return left * right;
}

export function finiteNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} must be a non-negative safe integer.`,
    );
  }

  return value;
}

export function checkedResourceByteSum(
  values: readonly number[],
  label = "Resident decode bytes",
) {
  let total = 0;
  for (const value of values) {
    finiteNonNegativeInteger(value, `${label} component`);
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new DecodeResourceError(
        "decoded-budget-exceeded",
        `${label} exceeds safe integer arithmetic.`,
      );
    }
    total += value;
  }
  return total;
}

export type DecodeResidencyRoute =
  | "native-worker"
  | "compatibility-worker"
  | "browser";

/**
 * Peak simultaneously resident decoder memory represented by the scheduler.
 * Browser decode owns the AudioBuffer and its copied planar transfer together.
 * Compatibility decode owns the MEMFS source, MEMFS float WAV, the readFile
 * copy of that WAV, and parsed planar PCM at its peak.
 */
export function decodePeakResidentBytes(
  route: DecodeResidencyRoute,
  decodedBytes: number,
  outputBytes = 0,
  sourceBytes = 0,
) {
  finitePositiveInteger(decodedBytes, "Decoded resident bytes");
  finiteNonNegativeInteger(outputBytes, "Decoder output resident bytes");
  finiteNonNegativeInteger(sourceBytes, "Decoder source resident bytes");
  if (route === "browser") {
    return checkedResourceByteSum(
      [decodedBytes, decodedBytes],
      "Browser decode peak",
    );
  }
  if (route === "compatibility-worker") {
    return checkedResourceByteSum(
      [sourceBytes, outputBytes, outputBytes, decodedBytes],
      "Compatibility decode peak",
    );
  }
  return decodedBytes;
}

export function conservativeDecodePeakBytes(budget: DecodeBudget) {
  return Math.max(
    decodePeakResidentBytes("browser", budget.maxDecodedBytes),
    decodePeakResidentBytes(
      "compatibility-worker",
      budget.maxDecodedBytes,
      budget.maxOutputBytes,
      budget.maxSourceBytes,
    ),
  );
}

/** Atomically models replacing one lease reservation inside an aggregate cap. */
export function growDecodePeakReservation(
  currentTotalBytes: number,
  currentReservationBytes: number,
  requiredReservationBytes: number,
  aggregateLimitBytes: number,
) {
  finiteNonNegativeInteger(currentTotalBytes, "Aggregate resident bytes");
  finiteNonNegativeInteger(currentReservationBytes, "Current reservation bytes");
  finitePositiveInteger(requiredReservationBytes, "Required reservation bytes");
  finitePositiveInteger(aggregateLimitBytes, "Aggregate resident-byte limit");
  if (currentReservationBytes > currentTotalBytes) {
    throw new DecodeResourceError(
      "invalid-metadata",
      "Current reservation exceeds aggregate resident bytes.",
    );
  }
  if (requiredReservationBytes <= currentReservationBytes) {
    return currentTotalBytes;
  }

  const withoutCurrent = currentTotalBytes - currentReservationBytes;
  const nextTotal = checkedResourceByteSum(
    [withoutCurrent, requiredReservationBytes],
    "Aggregate decode peak",
  );
  if (nextTotal > aggregateLimitBytes) {
    throw new DecodeResourceError(
      "decoded-budget-exceeded",
      `Decode route needs ${requiredReservationBytes.toLocaleString("en-GB")} peak resident bytes, but the batch aggregate limit is ${aggregateLimitBytes.toLocaleString("en-GB")} bytes.`,
    );
  }
  return nextTotal;
}

export type ReservationContention = "retryable" | "permanent";

/**
 * Classifies a rejected peak-memory reservation as transient contention or a
 * permanent over-budget condition. A route whose reservation would fit an
 * otherwise-empty aggregate is only blocked because the batch is momentarily
 * full, so the scheduler can requeue it and admit it once running jobs release
 * their reservations. A route larger than the entire aggregate can never be
 * admitted at all and must fail. Pure so the scheduler's contention branch is
 * testable without a DOM.
 */
export function classifyReservationContention(
  requiredReservationBytes: number,
  aggregateLimitBytes: number,
): ReservationContention {
  finitePositiveInteger(requiredReservationBytes, "Required reservation bytes");
  finitePositiveInteger(aggregateLimitBytes, "Aggregate resident-byte limit");
  return requiredReservationBytes <= aggregateLimitBytes ? "retryable" : "permanent";
}

/**
 * Decides whether a compressed container's declared decoded footprint can be
 * trusted as a concurrency reservation, given the real file size.
 *
 * FLAC is the only compressed container the scheduler admits on the strength of
 * its declared STREAMINFO length. Unlike uncompressed PCM WAV/AIFF — whose
 * declared payload the inspector already bounds against the real file size, and
 * whose decoder reads exactly that many bytes — a FLAC STREAMINFO sample count
 * is not bounded by the file, and the browser codec decodes every frame the
 * file actually contains regardless of it. An under-declared header would hand
 * admission a peak reservation far below the real decode, so several such files
 * could decode at once and breach the aggregate peak cap before the post-decode
 * footprint check fires.
 *
 * A lossless stream never encodes to more bytes than its own native PCM (the
 * worst case is verbatim storage), and float32 decoded PCM is at least the
 * native sample size, so an honest decode is at least as large as the file it
 * came from. When the declared footprint is smaller than the file it cannot
 * account for the bytes actually present, so the length is not trustworthy as a
 * concurrency bound and the caller must fall back to the conservative plan.
 * Genuine 16/24-bit masters clear this floor with room to spare (float32 PCM is
 * 2x/1.33x the native size), so the parallel known-footprint route is
 * preserved. Pure so the scheduler's trust decision is testable without a DOM.
 */
export function declaredDecodeCorroboratedByFileSize(
  declaredDecodedBytes: number,
  fileSizeBytes: number,
): boolean {
  finitePositiveInteger(declaredDecodedBytes, "Declared decoded bytes");
  finitePositiveInteger(fileSizeBytes, "Container file size");
  return declaredDecodedBytes >= fileSizeBytes;
}

function configuredLimit(
  value: number | undefined,
  fallback: number,
  hardLimit: number,
  label: string,
) {
  if (value == null) {
    return fallback;
  }

  finitePositiveInteger(value, label);
  return Math.min(value, hardLimit);
}

export function resolveDecodeBudget(budget?: DecodeBudget): DecodeBudget {
  return {
    maxSourceBytes: configuredLimit(
      budget?.maxSourceBytes,
      DEFAULT_DECODE_BUDGET.maxSourceBytes,
      HARD_DECODE_LIMITS.maxSourceBytes,
      "Source-byte budget",
    ),
    maxDecodedBytes: configuredLimit(
      budget?.maxDecodedBytes,
      DEFAULT_DECODE_BUDGET.maxDecodedBytes,
      HARD_DECODE_LIMITS.maxDecodedBytes,
      "Decoded-byte budget",
    ),
    maxOutputBytes: configuredLimit(
      budget?.maxOutputBytes,
      DEFAULT_DECODE_BUDGET.maxOutputBytes,
      HARD_DECODE_LIMITS.maxOutputBytes,
      "Decoder-output budget",
    ),
    maxChannels: configuredLimit(
      budget?.maxChannels,
      DEFAULT_DECODE_BUDGET.maxChannels,
      MAX_DECODE_CHANNELS,
      "Channel budget",
    ),
    maxFrames: configuredLimit(
      budget?.maxFrames,
      DEFAULT_DECODE_BUDGET.maxFrames,
      HARD_DECODE_LIMITS.maxFrames,
      "Frame budget",
    ),
    maxDurationSeconds: configuredLimit(
      budget?.maxDurationSeconds,
      DEFAULT_DECODE_BUDGET.maxDurationSeconds,
      HARD_DECODE_LIMITS.maxDurationSeconds,
      "Duration budget",
    ),
    maxDecodeMs: configuredLimit(
      budget?.maxDecodeMs,
      DEFAULT_DECODE_BUDGET.maxDecodeMs,
      HARD_DECODE_LIMITS.maxDecodeMs,
      "Decode-time budget",
    ),
  };
}

/**
 * Picks the per-job decode budget tier from the same device signals the lane
 * and aggregate schedulers use: 8 GB or more of reported memory gets the large
 * tier, no memory signal falls back to the pointer heuristic (fine pointer
 * reads as a desktop), and everything else keeps the conservative default.
 * Pure so the tier rule is testable outside the DOM; callers supply the
 * signals.
 */
export function resolveAdaptiveDecodeBudget(
  deviceMemoryGigabytes: number | null,
  coarsePointer: boolean,
): DecodeBudget {
  const capable =
    deviceMemoryGigabytes != null ? deviceMemoryGigabytes >= 8 : !coarsePointer;
  return resolveDecodeBudget(capable ? { ...LARGE_MEMORY_DECODE_BUDGET } : undefined);
}

export function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof DecodeResourceError) {
    throw signal.reason;
  }

  throw new DecodeResourceError("cancelled", "Audio decoding was canceled.");
}

export function decodeFailureDetails(error: unknown): {
  code: DecodeFailureCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof DecodeResourceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "cancelled", message: "Audio decoding was canceled.", retryable: false };
  }

  const message = error instanceof Error ? error.message : "Unable to decode the selected file.";
  return {
    code: inferDecodeFailureCode(message) ?? "decode-failed",
    message,
    retryable: true,
  };
}
