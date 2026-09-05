import {
  COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES,
  MAX_DECODE_CHANNELS,
  DecodeResourceError,
  checkedMultiply,
  checkedResourceByteSum,
  conservativeDecodePeakBytes,
  decodePeakResidentBytes,
  finitePositiveInteger,
  finitePositiveNumber,
  type DecodeBudget,
  type DecodeProbeMetadata,
  type DecodedFootprint,
  type DecodeResidencyRoute,
  type PlanarChannelView,
  type ProbedDecodeFootprintPlan,
} from "@/audio/decode-budget-core";

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
 * - A known footprint reserves the peak of its selected route. Browser decode
 *   holds the AudioBuffer plus planar copy. Compatibility decode holds the
 *   source plus three decoded-size PCM representations. Native parsing keeps
 *   the existing two-decoded-size lifecycle reservation for analysis scratch.
 * - Unknown footprints reserve the full conservative per-job peak. On devices
 *   whose aggregate holds two conservative routes that still allows two at
 *   once; constrained devices stay serial.
 * The hard-exclusive drain barrier applies to large unknown sources and to
 * compatibility jobs whose decoded PCM reaches the same device threshold.
 * Other known footprints do not need the source-size proxy because their
 * reservation already bounds the whole decode-and-analyze lifecycle.
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

  const knownFootprint = plan.kind === "known";
  const reservationPeakBytes = !knownFootprint
    ? conservativeDecodePeakBytes(budget)
    : route === "compatibility-worker"
      ? decodePeakResidentBytes(
          route,
          plan.decodedBytes,
          Math.min(
            budget.maxOutputBytes,
            checkedResourceByteSum([
              plan.decodedBytes,
              COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES,
            ]),
          ),
          fileSizeBytes,
        )
      : decodePeakResidentBytes("browser", plan.decodedBytes);

  const decodedSizeRequiresExclusivity =
    knownFootprint &&
    route === "compatibility-worker" &&
    plan.decodedBytes >= heavyFileBytes;

  return {
    route,
    reservationPeakBytes,
    exclusive:
      decodedSizeRequiresExclusivity ||
      (!knownFootprint && fileSizeBytes >= heavyFileBytes),
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

/**
 * Re-validates metadata received across the worker boundary. TypeScript types
 * do not constrain structured-clone input at runtime, so every numeric field
 * is checked again before it can lower a scheduler reservation.
 */
export function validateDecodeProbeMetadata(
  metadata: unknown,
  budget: DecodeBudget,
  label = "Decoder probe",
): DecodeProbeMetadata & { decodedBytes: number } {
  if (!metadata || typeof metadata !== "object") {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} did not return a metadata object.`,
    );
  }

  const candidate = metadata as Record<string, unknown>;
  const numericField = (value: unknown) => typeof value === "number" ? value : Number.NaN;
  const sampleRate = finitePositiveInteger(
    numericField(candidate.sampleRate),
    `${label} sample rate`,
  );
  const channelCount = finitePositiveInteger(
    numericField(candidate.channelCount),
    `${label} channel count`,
  );
  const frameCount = finitePositiveInteger(
    numericField(candidate.frameCount),
    `${label} frame count`,
  );
  const durationSeconds = finitePositiveNumber(
    numericField(candidate.durationSeconds),
    `${label} duration`,
  );
  const codecNameValue = candidate.codecName;
  if (
    codecNameValue != null &&
    (typeof codecNameValue !== "string" ||
      codecNameValue.length < 1 ||
      codecNameValue.length > 64 ||
      !/^[a-z0-9][a-z0-9 ._+-]*$/i.test(codecNameValue))
  ) {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} returned an invalid codec name.`,
    );
  }

  const minimumFrameCount = Math.ceil(durationSeconds * sampleRate);
  if (!Number.isSafeInteger(minimumFrameCount) || frameCount < minimumFrameCount) {
    throw new DecodeResourceError(
      "invalid-metadata",
      `${label} frame count does not cover its reported duration.`,
    );
  }

  const footprint = assertDecodedFootprint(
    { frameCount, channelCount, sampleRate, durationSeconds },
    budget,
    label,
  );
  return {
    sampleRate,
    channelCount,
    frameCount,
    durationSeconds,
    ...(typeof codecNameValue === "string" ? { codecName: codecNameValue } : {}),
    decodedBytes: footprint.decodedBytes,
  };
}

/** Probe failures and malformed replies retain the conservative unknown plan. */
export function planProbedDecodeFootprint(
  metadata: unknown,
  budget: DecodeBudget,
): ProbedDecodeFootprintPlan {
  try {
    const validated = validateDecodeProbeMetadata(metadata, budget);
    const { decodedBytes, ...boundedMetadata } = validated;
    return { kind: "known", metadata: boundedMetadata, decodedBytes };
  } catch {
    return { kind: "unknown" };
  }
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

