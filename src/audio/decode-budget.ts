const MEBIBYTE = 1024 * 1024;

export const MAX_DECODE_CHANNELS = 32;

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

export interface PlanarChannelView {
  length: number;
  byteLength: number;
}

function finitePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} must be a positive safe integer.`,
    );
  }

  return value;
}

function finitePositiveNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new DecodeResourceError("invalid-metadata", `${label} must be finite and positive.`);
  }

  return value;
}

function checkedMultiply(left: number, right: number, label: string) {
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

function finiteNonNegativeInteger(value: number, label: string) {
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
 * Browser decode owns the AudioBuffer and its copied planar transfer together;
 * compatibility decode owns the float-WAV output and parsed planar PCM together.
 */
export function decodePeakResidentBytes(
  route: DecodeResidencyRoute,
  decodedBytes: number,
  outputBytes = 0,
) {
  finitePositiveInteger(decodedBytes, "Decoded resident bytes");
  finiteNonNegativeInteger(outputBytes, "Decoder output resident bytes");
  if (route === "browser") {
    return checkedResourceByteSum(
      [decodedBytes, decodedBytes],
      "Browser decode peak",
    );
  }
  if (route === "compatibility-worker") {
    return checkedResourceByteSum(
      [decodedBytes, outputBytes],
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

export interface LaneAdmissionInput {
  fileSizeBytes: number;
  heavyFileBytes: number;
  browserFirst: boolean;
  plan:
    | { kind: "known"; decodedBytes: number; trustedNative: boolean }
    | { kind: "unknown" };
  budget: DecodeBudget;
}

export interface LaneAdmissionPlan {
  route: DecodeResidencyRoute;
  reservationPeakBytes: number;
  exclusive: boolean;
}

/**
 * Decides how a queued job is admitted to a lane. Concurrency is governed by
 * peak-memory reservations against the aggregate cap, not by decoder route:
 * - A known footprint (complete PCM WAV/AIFF headers, FLAC STREAMINFO)
 *   reserves twice its decoded bytes on every route. That models the decode
 *   peak (browser: AudioBuffer plus the planar copy; native: source buffer
 *   plus planar output) and the analysis phase (planar PCM plus K-weighting
 *   scratch), so several high-resolution files can share the aggregate.
 * - Unknown footprints (MP3, AAC and friends) and compatibility-route jobs
 *   reserve the full conservative per-job peak: FFmpeg working memory is not
 *   modeled per file, and opaque codecs give no trustworthy pre-decode
 *   footprint. On devices whose aggregate holds two conservative routes that
 *   still allows two at once; constrained devices stay serial.
 * The hard-exclusive drain barrier applies only to LARGE UNKNOWN sources: a
 * big opaque file could decode to anything, so it runs alone. Known
 * footprints do not need the source-size proxy, because their reservation
 * already bounds the whole decode-and-analyze lifecycle.
 */
export function planLaneAdmission(input: LaneAdmissionInput): LaneAdmissionPlan {
  const { fileSizeBytes, heavyFileBytes, browserFirst, plan, budget } = input;
  finitePositiveInteger(fileSizeBytes, "Admission file size");
  finitePositiveInteger(heavyFileBytes, "Heavy-file threshold");

  const trustedNativePrimary =
    plan.kind === "known" && plan.trustedNative && !browserFirst;
  const route: DecodeResidencyRoute = trustedNativePrimary
    ? "native-worker"
    : browserFirst
      ? "browser"
      : "compatibility-worker";

  const knownFootprint =
    plan.kind === "known" && (trustedNativePrimary || route === "browser");
  const reservationPeakBytes = knownFootprint
    ? decodePeakResidentBytes("browser", plan.decodedBytes)
    : conservativeDecodePeakBytes(budget);

  return {
    route,
    reservationPeakBytes,
    exclusive: !knownFootprint && fileSizeBytes >= heavyFileBytes,
  };
}

export function checkedDecodedBytes(frameCount: number, channelCount: number) {
  const samples = checkedMultiply(frameCount, channelCount, "Decoded sample count");
  return checkedMultiply(samples, Float32Array.BYTES_PER_ELEMENT, "Decoded byte count");
}

export function assertSourceWithinBudget(
  sourceBytes: number,
  budget: DecodeBudget,
  label = "Audio source",
) {
  finitePositiveInteger(sourceBytes, `${label} byte length`);
  if (sourceBytes > budget.maxSourceBytes) {
    throw new DecodeResourceError(
      "source-budget-exceeded",
      `${label} is ${sourceBytes.toLocaleString("en-GB")} bytes; the safe decode limit is ${budget.maxSourceBytes.toLocaleString("en-GB")} bytes.`,
    );
  }
}

export function assertDecodedFootprint(
  metadata: {
    frameCount: number;
    channelCount: number;
    sampleRate?: number;
    durationSeconds?: number;
  },
  budget: DecodeBudget,
  label = "Decoded audio",
): DecodedFootprint {
  const frameCount = finitePositiveInteger(metadata.frameCount, `${label} frame count`);
  const channelCount = finitePositiveInteger(metadata.channelCount, `${label} channel count`);
  if (channelCount > MAX_DECODE_CHANNELS || channelCount > budget.maxChannels) {
    throw new DecodeResourceError(
      "channel-limit-exceeded",
      `${label} has ${channelCount} channels; at most ${Math.min(MAX_DECODE_CHANNELS, budget.maxChannels)} are supported safely.`,
    );
  }
  if (frameCount > budget.maxFrames) {
    throw new DecodeResourceError(
      "frame-limit-exceeded",
      `${label} has ${frameCount.toLocaleString("en-GB")} frames; the safe limit is ${budget.maxFrames.toLocaleString("en-GB")}.`,
    );
  }

  const decodedBytes = checkedDecodedBytes(frameCount, channelCount);
  if (decodedBytes > budget.maxDecodedBytes) {
    throw new DecodeResourceError(
      "decoded-budget-exceeded",
      `${label} needs ${decodedBytes.toLocaleString("en-GB")} decoded bytes; the safe limit is ${budget.maxDecodedBytes.toLocaleString("en-GB")} bytes.`,
    );
  }

  let durationSeconds: number | null = null;
  if (metadata.durationSeconds != null) {
    durationSeconds = finitePositiveNumber(metadata.durationSeconds, `${label} duration`);
  } else if (metadata.sampleRate != null) {
    const sampleRate = finitePositiveInteger(metadata.sampleRate, `${label} sample rate`);
    durationSeconds = frameCount / sampleRate;
  }

  if (durationSeconds != null && durationSeconds > budget.maxDurationSeconds) {
    throw new DecodeResourceError(
      "duration-limit-exceeded",
      `${label} is ${durationSeconds.toFixed(2)} seconds long; the safe limit is ${budget.maxDurationSeconds} seconds.`,
    );
  }

  return { frameCount, channelCount, decodedBytes, durationSeconds };
}

export function validatePlanarChannels(
  channels: readonly PlanarChannelView[],
  metadata: {
    frameCount: number;
    channelCount: number;
    sampleRate?: number;
    durationSeconds?: number;
  },
  budget: DecodeBudget,
  label = "Decoded audio",
) {
  const footprint = assertDecodedFootprint(metadata, budget, label);
  if (channels.length !== footprint.channelCount) {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} exposed ${channels.length} channel buffers after reporting ${footprint.channelCount}.`,
    );
  }

  const expectedChannelBytes = checkedMultiply(
    footprint.frameCount,
    Float32Array.BYTES_PER_ELEMENT,
    `${label} channel byte count`,
  );
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const channel = channels[channelIndex];
    if (
      channel.length !== footprint.frameCount ||
      channel.byteLength !== expectedChannelBytes
    ) {
      throw new DecodeResourceError(
        "invalid-metadata",
        `${label} channel ${channelIndex + 1} does not match the reported frame count.`,
      );
    }
  }

  return footprint;
}

function readAscii(view: DataView, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    return "";
  }

  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += String.fromCharCode(view.getUint8(offset + index));
  }
  return output;
}

function safeUint64(view: DataView, offset: number, littleEndian: boolean) {
  if (offset < 0 || offset + 8 > view.byteLength) {
    return null;
  }

  const value = view.getBigUint64(offset, littleEndian);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function parseExtendedFloat80(view: DataView, offset: number) {
  if (offset < 0 || offset + 10 > view.byteLength) {
    return Number.NaN;
  }

  const exponentWord = view.getUint16(offset, false);
  const exponent = exponentWord & 0x7fff;
  const sign = exponentWord & 0x8000 ? -1 : 1;
  const high = view.getUint32(offset + 2, false);
  const low = view.getUint32(offset + 6, false);
  if (exponent === 0 && high === 0 && low === 0) {
    return 0;
  }
  if (exponent === 0x7fff) {
    return Number.NaN;
  }

  const mantissa = high * 2 ** -31 + low * 2 ** -63;
  return sign * mantissa * 2 ** (exponent - 16383);
}

function inspectFlac(view: DataView): AudioContainerPreflight | null {
  if (view.byteLength < 8 || readAscii(view, 0, 4) !== "fLaC") {
    return null;
  }

  let offset = 4;
  let blocksVisited = 0;
  while (offset + 4 <= view.byteLength && blocksVisited < 128) {
    const blockType = view.getUint8(offset) & 0x7f;
    const blockLength =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);
    offset += 4;
    blocksVisited += 1;
    if (blockLength > view.byteLength - offset) {
      return null;
    }

    if (blockType === 0) {
      if (blockLength < 34 || offset + 34 > view.byteLength) {
        return null;
      }

      const byte10 = view.getUint8(offset + 10);
      const byte11 = view.getUint8(offset + 11);
      const byte12 = view.getUint8(offset + 12);
      const byte13 = view.getUint8(offset + 13);
      const sampleRate = (byte10 << 12) | (byte11 << 4) | (byte12 >> 4);
      const channelCount = ((byte12 >> 1) & 0x07) + 1;
      const bitDepth = (((byte12 & 0x01) << 4) | (byte13 >> 4)) + 1;
      const frameCount = (byte13 & 0x0f) * 2 ** 32 + view.getUint32(offset + 14, false);
      if (
        !Number.isSafeInteger(sampleRate) ||
        sampleRate <= 0 ||
        !Number.isSafeInteger(channelCount) ||
        channelCount <= 0 ||
        !Number.isSafeInteger(bitDepth) ||
        bitDepth <= 0 ||
        !Number.isSafeInteger(frameCount) ||
        frameCount <= 0
      ) {
        return null;
      }

      return {
        container: "flac",
        sampleRate,
        channelCount,
        bitDepth,
        frameCount,
        durationSeconds: frameCount / sampleRate,
        nativeDecodeSafe: false,
      };
    }

    offset += blockLength;
  }

  return null;
}

function inspectWave(view: DataView, totalBytes: number): AudioContainerPreflight | null {
  const signature = readAscii(view, 0, 4);
  if (
    view.byteLength < 12 ||
    (signature !== "RIFF" && signature !== "RF64") ||
    readAscii(view, 8, 4) !== "WAVE"
  ) {
    return null;
  }

  let offset = 12;
  let chunksVisited = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let blockAlign = 0;
  let formatTag = 0;
  let dataBytes: number | null = null;
  let rf64DataBytes: number | null = null;
  let rf64NativeStructureSafe = signature !== "RF64";

  while (offset + 8 <= view.byteLength && chunksVisited < 100_000) {
    const chunkId = readAscii(view, offset, 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    chunksVisited += 1;

    if (chunkId === "ds64" && declaredSize >= 16 && dataOffset + 16 <= view.byteLength) {
      rf64DataBytes = safeUint64(view, dataOffset + 8, true);
      rf64NativeStructureSafe =
        declaredSize >= 28 && dataOffset + 28 <= view.byteLength;
    } else if (chunkId === "fmt " && declaredSize >= 16 && dataOffset + 16 <= view.byteLength) {
      formatTag = view.getUint16(dataOffset, true);
      channelCount = view.getUint16(dataOffset + 2, true);
      sampleRate = view.getUint32(dataOffset + 4, true);
      blockAlign = view.getUint16(dataOffset + 12, true);
      bitDepth = view.getUint16(dataOffset + 14, true);
    } else if (chunkId === "data") {
      // The declared audio payload must fit inside the real file, not inside
      // the (possibly partial) header slice that was handed to the inspector.
      // This is what lets a 256 KiB preflight slice of a multi-hundred-MiB
      // PCM master produce a trusted, bounded plan.
      const resolvedDataBytes = signature === "RF64" && declaredSize === 0xffffffff
        ? rf64DataBytes
        : declaredSize;
      if (
        resolvedDataBytes == null ||
        resolvedDataBytes <= 0 ||
        resolvedDataBytes > totalBytes - dataOffset
      ) {
        return null;
      }
      dataBytes = resolvedDataBytes;
      if (channelCount > 0) {
        break;
      }
    }

    const sizeToSkip =
      chunkId === "data" && signature === "RF64" && declaredSize === 0xffffffff
        ? dataBytes
        : declaredSize;
    // Structural validity is judged against the real file size; running past
    // the supplied slice just ends the scan with whatever was found so far.
    if (sizeToSkip == null || sizeToSkip > totalBytes - dataOffset) {
      return null;
    }
    const paddedSize = sizeToSkip + (sizeToSkip & 1);
    if (!Number.isSafeInteger(paddedSize) || paddedSize > totalBytes - dataOffset) {
      return null;
    }
    offset = dataOffset + paddedSize;
  }

  if (
    channelCount <= 0 ||
    sampleRate <= 0 ||
    bitDepth <= 0 ||
    blockAlign <= 0 ||
    dataBytes == null ||
    dataBytes <= 0
  ) {
    return null;
  }

  const frameCount = Math.floor(dataBytes / blockAlign);
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return null;
  }

  return {
    container: signature === "RF64" ? "rf64" : "wav",
    sampleRate,
    channelCount,
    bitDepth,
    frameCount,
    durationSeconds: frameCount / sampleRate,
    nativeDecodeSafe:
      formatTag === 0x0001 &&
      rf64NativeStructureSafe &&
      (bitDepth === 8 || bitDepth === 16 || bitDepth === 24 || bitDepth === 32) &&
      blockAlign === channelCount * (bitDepth / 8),
  };
}

function inspectAiff(view: DataView, totalBytes: number): AudioContainerPreflight | null {
  const formType = readAscii(view, 8, 4);
  if (
    view.byteLength < 12 ||
    readAscii(view, 0, 4) !== "FORM" ||
    (formType !== "AIFF" && formType !== "AIFC")
  ) {
    return null;
  }

  let offset = 12;
  let chunksVisited = 0;
  let sampleRate = 0;
  let channelCount = 0;
  let bitDepth = 0;
  let frameCount = 0;
  let compressionType = formType === "AIFF" ? "NONE" : "";
  let commFound = false;
  let soundDataBytes: number | null = null;
  while (offset + 8 <= view.byteLength && chunksVisited < 100_000) {
    const chunkId = readAscii(view, offset, 4);
    const declaredSize = view.getUint32(offset + 4, false);
    const dataOffset = offset + 8;
    chunksVisited += 1;
    // Chunk payloads must fit the real file; a header slice smaller than the
    // file is fine as long as the fields actually read stay inside the slice.
    if (declaredSize > totalBytes - dataOffset) {
      return null;
    }

    if (chunkId === "COMM" && declaredSize >= 18 && dataOffset + 18 <= view.byteLength) {
      channelCount = view.getUint16(dataOffset, false);
      frameCount = view.getUint32(dataOffset + 2, false);
      bitDepth = view.getUint16(dataOffset + 6, false);
      sampleRate = parseExtendedFloat80(view, dataOffset + 8);
      if (
        channelCount <= 0 ||
        frameCount <= 0 ||
        bitDepth <= 0 ||
        !Number.isFinite(sampleRate) ||
        sampleRate <= 0
      ) {
        return null;
      }
      if (formType === "AIFC") {
        if (declaredSize < 22 || dataOffset + 22 > view.byteLength) {
          return null;
        }
        compressionType = readAscii(view, dataOffset + 18, 4);
      }
      commFound = true;
    } else if (chunkId === "SSND") {
      if (declaredSize < 8 || dataOffset + 8 > view.byteLength) {
        return null;
      }
      const soundDataOffset = view.getUint32(dataOffset, false);
      if (soundDataOffset > declaredSize - 8) {
        return null;
      }
      soundDataBytes = declaredSize - 8 - soundDataOffset;
    }

    if (commFound && soundDataBytes != null) {
      break;
    }

    const paddedSize = declaredSize + (declaredSize & 1);
    if (!Number.isSafeInteger(paddedSize) || paddedSize > totalBytes - dataOffset) {
      return null;
    }
    offset = dataOffset + paddedSize;
  }

  if (!commFound || soundDataBytes == null) {
    return null;
  }

  const integerPcmCompression =
    compressionType === "NONE" ||
    compressionType === "twos" ||
    compressionType === "sowt";
  const supportedIntegerDepth =
    bitDepth === 8 || bitDepth === 16 || bitDepth === 24 || bitDepth === 32;
  const bytesPerFrame = channelCount * (bitDepth / 8);
  const expectedAudioBytes =
    Number.isSafeInteger(bytesPerFrame) &&
    bytesPerFrame > 0 &&
    frameCount <= Math.floor(Number.MAX_SAFE_INTEGER / bytesPerFrame)
      ? frameCount * bytesPerFrame
      : null;

  return {
    container: formType === "AIFC" ? "aifc" : "aiff",
    sampleRate,
    channelCount,
    bitDepth,
    frameCount,
    durationSeconds: frameCount / sampleRate,
    nativeDecodeSafe:
      Number.isInteger(sampleRate) &&
      integerPcmCompression &&
      supportedIntegerDepth &&
      expectedAudioBytes != null &&
      soundDataBytes >= expectedAudioBytes,
  };
}

/**
 * Inspects a container header. `totalBytes` is the size of the complete file
 * the buffer was sliced from; it defaults to the buffer's own length, which
 * preserves the strict whole-buffer behavior for callers that hold the full
 * file (the decode workers and the fail-closed parser fixtures). Passing the
 * real file size lets a partial header slice of a large PCM WAV/AIFF validate
 * its declared payload bounds without reading the whole file.
 */
export function inspectAudioContainer(
  buffer: ArrayBuffer,
  totalBytes = buffer.byteLength,
): AudioContainerPreflight | null {
  const view = new DataView(buffer);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < view.byteLength) {
    return null;
  }
  return inspectFlac(view) ?? inspectWave(view, totalBytes) ?? inspectAiff(view, totalBytes);
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

  return {
    code: "decode-failed",
    message: error instanceof Error ? error.message : "Unable to decode the selected file.",
    retryable: true,
  };
}
