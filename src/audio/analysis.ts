import { describeLayoutRisk, getLoudnessWeight } from "@/audio/channel-layout";
import { applyTargetToMetrics } from "@/audio/targeting";
import type {
  AnalysisResult,
  AnalysisTimeline,
  DecodedAudioAsset,
  IntegratedInvalidReason,
  LoudnessMetrics,
  TargetPreset,
} from "@/types/audio";

// Supported sample-rate range. The K-weighting high shelf is designed around a
// 1681.97 Hz corner. Measured behavior of this filter across candidate rates:
// at 3000 Hz and below the pre-warped shelf pole leaves the unit circle
// (|pole| = 1.31 at 3 kHz) and the filter blows up to non-finite output; at
// 4000-6000 Hz it is numerically stable but the shelf corner crowds Nyquist and
// the weighting response is no longer accurate. 8000 Hz is the lowest round rate
// that is both stable and well-conditioned (shelf corner comfortably below
// Nyquist), so it is the floor. The ceiling is a generous professional bound; the
// shelf stays well-conditioned far above it. Rates outside the range are rejected
// before any filtering runs.
export const MIN_SUPPORTED_SAMPLE_RATE = 8000;
export const MAX_SUPPORTED_SAMPLE_RATE = 384000;
export const UNSUPPORTED_SAMPLE_RATE_PREFIX = "Unsupported sample rate: ";

// H-02 contract warning constants. Exact strings so Codex UI/export can match and
// strip them. Pushed into metrics.warnings when the integrated measurement is not
// valid, or when the programme is too short for a stable Loudness Range.
export const INVALID_INTEGRATED_TOO_SHORT_WARNING =
  "Clip is too short for a valid integrated loudness measurement (no complete 400 ms gated block).";
export const INVALID_INTEGRATED_BELOW_GATE_WARNING =
  "All audio is below the -70 LUFS absolute gate; integrated loudness is not a valid measurement.";
export const LRA_UNSTABLE_WARNING =
  "Programme is shorter than 60 s; Loudness Range is not statistically stable (EBU Tech 3341 §2.4).";

// ITU-R BS.1770 defines K-weighting against a 48 kHz reference. Below ~24 kHz
// the tan-prewarped bilinear re-derivation steepens the high-shelf transition
// near Nyquist, so K-weighted loudness (integrated/momentary/short-term) reads
// progressively hotter than the same programme at 48 kHz: up to ~0.4 LU at
// 8 kHz with strong top-octave energy, ~0.08 LU by 22.05 kHz, and under
// ~0.01 LU at 44.1/48 kHz. Surfaced as a warning so a low-rate reading is not
// presented as an exact standards match; rates used for loudness-compliant
// delivery (44.1/48 kHz and above) never cross the threshold.
export const LOW_SAMPLE_RATE_KWEIGHTING_THRESHOLD = 24000;
export const LOW_SAMPLE_RATE_KWEIGHTING_WARNING =
  "Sample rate is below 24 kHz; K-weighted loudness can read up to ~0.4 LU high versus the 48 kHz ITU-R BS.1770 reference near Nyquist.";

export const TRUE_PEAK_FIR = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
];

// The largest per-phase L1 gain of the polyphase FIR. Every interpolated value
// is a linear combination of the twelve samples in its window, so no phase can
// exceed this factor times the largest magnitude in that window. Derived from
// the table above so it can never drift from the coefficients.
const TRUE_PEAK_PHASE_GAIN = Math.max(
  ...TRUE_PEAK_FIR.map((phase) => phase.reduce((sum, tap) => sum + Math.abs(tap), 0)),
);

function energyToLufs(energy: number) {
  if (energy <= 0) {
    return -70;
  }

  return Math.max(10 * Math.log10(energy) - 0.691, -70);
}

function energyToUnclampedLufs(energy: number) {
  if (energy <= 0) {
    return Number.NEGATIVE_INFINITY;
  }

  return 10 * Math.log10(energy) - 0.691;
}

function peakToDb(peak: number) {
  if (peak <= 0) {
    return -144;
  }

  return 20 * Math.log10(peak);
}

class KWeightingFilter {
  private readonly coeffs: number[];
  private state: [number, number, number, number] = [0, 0, 0, 0];

  constructor(sampleRate: number) {
    const epsilon = 1e-50;
    const highPassFrequency = 38.13547087606643;
    const highShelfFrequency = 1681.9744509555217;
    const q = 1.4140766640886306;
    const shelfA = 1.77992789404;
    const shelfB = 1.58486470113;
    const shelfC = 1.00065407464886;

    const w = (2 * Math.PI * highPassFrequency) / sampleRate;
    const k = Math.tan((highShelfFrequency * Math.PI) / sampleRate);
    const v = Math.sin(w) / shelfC;
    const highShelfDen = k * k + q * k + 1;
    const highShelfCoeffs = [
      (k * k + shelfA * k + shelfB) / highShelfDen,
      (2 * (k * k - shelfB)) / highShelfDen,
      (k * k - shelfA * k + shelfB) / highShelfDen,
      (2 * (k * k - 1)) / highShelfDen,
      (k * k - q * k + 1) / highShelfDen,
    ];
    const highPassCoeffs = [1, -2, 1, (-2 * Math.cos(w)) / (1 + v), (1 - v) / (1 + v)];

    this.coeffs = [epsilon, ...highPassCoeffs, ...highShelfCoeffs];
  }

  // Reads `source` and writes the K-weighted result to `dest`, leaving `source`
  // untouched (M-11: analysis must not mutate caller-owned PCM). `dest` is a
  // scratch buffer at least as long as `source`; passing `source === dest`
  // preserves the old in-place behavior.
  processInto(source: Float32Array, dest: Float32Array) {
    const [epsilon, b0, b1, b2, a1, a2, c0, c1, c2, d1, d2] = this.coeffs;
    let [s0, s1, s2, s3] = this.state;
    const length = source.length;

    for (let index = 0; index < length; index += 1) {
      const x = source[index];
      let y = b0 * x + s0 + epsilon;
      s0 = b1 * x - a1 * y + s1;
      s1 = b2 * x - a2 * y;

      const hp = y - epsilon;
      y = c0 * hp + s2 + epsilon;
      s2 = c1 * hp - d1 * y + s3;
      s3 = c2 * hp - d2 * y;

      dest[index] = y - epsilon;
    }

    this.state = [s0, s1, s2, s3];
  }
}

// Reports analysis progress as a 0..1 fraction. Implementations should expect
// coarse steps (a few percent apart); emission is rate-limited at the source.
export type AnalysisProgressCallback = (fraction: number) => void;

function calculateSegmentEnergies(
  asset: DecodedAudioAsset,
  stepSamples: number,
  onProgress?: AnalysisProgressCallback,
) {
  const { channels, channelLayout, sampleRate } = asset;
  const frameCount = channels[0]?.length ?? 0;
  const fullSegmentFrameCount = Math.floor(frameCount / stepSamples) * stepSamples;
  const segmentEnergies: number[] = [];
  const warnings: string[] = [];
  const channelWeights = channels.map((_, channelIndex) =>
    getLoudnessWeight(channelLayout.labels[channelIndex] ?? "Unknown"),
  );

  let totalEnergy = 0;

  const layoutRisk = describeLayoutRisk(channelLayout);
  if (layoutRisk) {
    warnings.push(layoutRisk);
  }

  // M-11: K-weight into per-channel scratch buffers instead of mutating the
  // caller's PCM. At most one extra Float32Array per contributing channel; LFE
  // (weight 0) is never filtered or read, so it reuses the caller's reference.
  const filteredChannels: Float32Array[] = channels.map((channel, channelIndex) => {
    if (channelWeights[channelIndex] === 0) {
      return channel;
    }
    const scratch = new Float32Array(channel.length);
    const filter = new KWeightingFilter(sampleRate);
    filter.processInto(channel, scratch);
    return scratch;
  });

  // H-01: streaming high-resolution rolling 400 ms window for Maximum Momentary
  // Loudness. Hops at <= 10 ms so a 400 ms event lands on the grid within 0.055 LU
  // worst case (vs the +-0.1 LU tolerance in EBU Tech 3341 cases 13/14). The window
  // sum is maintained incrementally over a single 400 ms ring buffer (bounded, not
  // a whole-file high-res array). The 100 ms timeline/short-term/gating grid below
  // is untouched.
  //
  // H-02/H-01 boundary: length the window as exactly 4 * round(0.1 * sampleRate) =
  // the integrated gating block length (four 100 ms segments), NOT round(0.4 * SR).
  // At rates where those differ (e.g. 11025 Hz: 4 * 1103 = 4412 vs round(4410) =
  // 4410) the two forms disagreed by a frame or two, letting a clip report a valid
  // Max M while integrated was still (correctly) flagged too-short. Tying both to
  // the same block length makes Max-M validity and integrated too-short validity
  // agree at every sample rate. At 44.1/48 kHz this equals round(0.4 * SR) exactly.
  const momentaryFrames = Math.max(1, 4 * stepSamples);
  const momentaryHop = Math.max(1, Math.round(0.01 * sampleRate));
  const momentaryRing = new Float64Array(momentaryFrames);
  let momentaryRingIndex = 0;
  let momentaryRingSum = 0;
  let momentaryEvalPhase = 0;
  let maxMomentaryEnergy = 0;
  let hasMomentaryWindow = false;

  const progressStride = Math.max(1, Math.floor(frameCount / 20));
  let segmentEnergy = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    if (onProgress && frame % progressStride === 0) {
      onProgress(frame / frameCount);
    }

    let frameEnergy = 0;

    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const weight = channelWeights[channelIndex];
      if (weight === 0) {
        continue;
      }

      const sample = filteredChannels[channelIndex][frame];
      if (!Number.isFinite(sample)) {
        throw new Error(`Decoded audio contains a non-finite sample at frame ${frame + 1}, channel ${channelIndex + 1}.`);
      }
      frameEnergy += weight * sample * sample;
    }

    if (!Number.isFinite(frameEnergy)) {
      throw new Error(`Decoded audio energy overflowed at frame ${frame + 1}.`);
    }

    totalEnergy += frameEnergy;

    // High-resolution momentary rolling sum (incremental; ring holds one window).
    if (frame >= momentaryFrames) {
      momentaryRingSum -= momentaryRing[momentaryRingIndex];
    }
    momentaryRing[momentaryRingIndex] = frameEnergy;
    momentaryRingSum += frameEnergy;
    momentaryRingIndex += 1;
    if (momentaryRingIndex === momentaryFrames) {
      momentaryRingIndex = 0;
    }
    if (frame >= momentaryFrames - 1) {
      // Evaluate on the hop grid (window start at multiples of momentaryHop) and
      // always at the final complete window so an end-of-file event is captured.
      if (momentaryEvalPhase === 0 || frame === frameCount - 1) {
        const meanEnergy = momentaryRingSum / momentaryFrames;
        if (!hasMomentaryWindow || meanEnergy > maxMomentaryEnergy) {
          maxMomentaryEnergy = meanEnergy;
          hasMomentaryWindow = true;
        }
      }
      momentaryEvalPhase += 1;
      if (momentaryEvalPhase === momentaryHop) {
        momentaryEvalPhase = 0;
      }
    }

    if (frame >= fullSegmentFrameCount) {
      continue;
    }

    segmentEnergy += frameEnergy;

    if ((frame + 1) % stepSamples === 0 || frame === frameCount - 1) {
      segmentEnergies.push(segmentEnergy);
      segmentEnergy = 0;
    }
  }

  // Null when no complete 400 ms window exists. The window is 4 * stepSamples
  // frames — identical to the integrated "too-short" gating block (four complete
  // round(0.1 * sampleRate) segments) — so Max M is non-null exactly when a
  // complete integrated block exists. A clip is never simultaneously "valid Max M"
  // and "integrated too-short" at any sample rate (the 11025 Hz boundary case that
  // previously diverged now agrees).
  const maxMomentaryLufs = hasMomentaryWindow ? energyToLufs(maxMomentaryEnergy) : null;

  return { segmentEnergies, totalEnergy, warnings, maxMomentaryLufs };
}

// EBU Tech 3342 reference rounded-rank percentile (M-14). The MATLAB reference
// (1-based) uses idx = round((n - 1) * P/100 + 1); in 0-based form that is
// round((n - 1) * percentile), with `percentile` a fraction (0.1 / 0.95). MATLAB
// round() ties away from zero; for the non-negative argument here that matches
// Math.round (ties toward +Inf). No interpolation between neighbouring samples.
function percentileRoundedRank(sortedValues: number[], percentile: number) {
  const n = sortedValues.length;
  if (n === 0) {
    return null;
  }

  const index = Math.round((n - 1) * percentile);
  return sortedValues[index];
}

function calculatePeaks(
  asset: DecodedAudioAsset,
  stepSamples: number,
  onProgress?: AnalysisProgressCallback,
) {
  const frameCount = asset.channels[0]?.length ?? 0;
  const history = asset.channels.map(() => new Float32Array(24));
  const historyIndex = new Array(asset.channels.length).fill(0);
  // Largest magnitude in each channel's current twelve-sample window, and the
  // tap that holds it. Maintained so the oversampling FIR can be skipped where
  // no phase could beat the peak already reported for this scope.
  const windowMax = new Float64Array(asset.channels.length);
  const windowMaxTap = new Int32Array(asset.channels.length);
  const truePeakByStep: number[] = [];
  const progressStride = Math.max(1, Math.floor(frameCount / 20));

  let overallSamplePeak = 0;
  let overallTruePeak = 0;
  let stepPeak = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    if (onProgress && frame % progressStride === 0) {
      onProgress(frame / frameCount);
    }

    for (let channelIndex = 0; channelIndex < asset.channels.length; channelIndex += 1) {
      const sample = asset.channels[channelIndex][frame];
      if (!Number.isFinite(sample)) {
        throw new Error(`Decoded audio contains a non-finite sample at frame ${frame + 1}, channel ${channelIndex + 1}.`);
      }

      const absSample = Math.abs(sample);
      overallSamplePeak = Math.max(overallSamplePeak, absSample);

      const ring = history[channelIndex];
      const pointer = historyIndex[channelIndex];
      ring[pointer] = sample;
      ring[pointer + 12] = sample;

      // Sliding maximum of |x| over the window. Amortised O(1): a sample at or
      // above the stored maximum replaces it, and the window is rescanned only
      // when the sample holding the maximum leaves it. The result is exact, not
      // an estimate.
      let maxMagnitude = windowMax[channelIndex];
      let maxTap = windowMaxTap[channelIndex] + 1;
      if (absSample >= maxMagnitude) {
        maxMagnitude = absSample;
        maxTap = 0;
      } else if (maxTap > 11) {
        maxMagnitude = 0;
        maxTap = 0;
        for (let tap = 0; tap < 12; tap += 1) {
          const magnitude = Math.abs(ring[pointer + tap]);
          if (magnitude > maxMagnitude) {
            maxMagnitude = magnitude;
            maxTap = tap;
          }
        }
      }
      windowMax[channelIndex] = maxMagnitude;
      windowMaxTap[channelIndex] = maxTap;

      // Exact candidate gate. `stepPeak` is never above `overallTruePeak`, and
      // `absSample` is never above the window maximum, so a window whose bound
      // cannot beat `stepPeak` cannot change either reported maximum. Gating on
      // the per-bin peak (not the overall one) is what keeps the timeline
      // values exact as well.
      // A second, Cauchy-Schwarz gate on the window energy was measured and
      // rejected: the per-phase L2 norms are 0.959 to 0.991, so its bound is
      // rarely tighter than this one, and the twelve extra multiply-adds made
      // the stage 3 to 5 percent slower on tonal and noisy ten-minute fixtures.
      if (maxMagnitude * TRUE_PEAK_PHASE_GAIN > stepPeak) {
        let localPeak = absSample;
        for (let phase = 0; phase < TRUE_PEAK_FIR.length; phase += 1) {
          let oversampled = 0;
          for (let tap = 0; tap < 12; tap += 1) {
            oversampled += ring[pointer + tap] * TRUE_PEAK_FIR[phase][tap];
          }
          localPeak = Math.max(localPeak, Math.abs(oversampled));
        }

        overallTruePeak = Math.max(overallTruePeak, localPeak);
        stepPeak = Math.max(stepPeak, localPeak);
      }

      historyIndex[channelIndex] = pointer === 0 ? 11 : pointer - 1;
    }

    // Push only complete 100 ms bins (matches the loudness segment grid, so the
    // returned series length equals timeSeconds.length). This fires exactly
    // floor(frameCount / stepSamples) times. Frames past the last boundary stay
    // accumulated in stepPeak and are folded below (M-09).
    if ((frame + 1) % stepSamples === 0) {
      truePeakByStep.push(peakToDb(stepPeak));
      stepPeak = 0;
    }
  }

  // Match libebur128 and ffmpeg at a hard-cut ending: stop at the final source
  // sample instead of feeding zeroes through the FIR, which would measure an
  // artificial step to silence. A partial final 100 ms bin still belongs to the
  // programme and is folded into the last timeline point to preserve the
  // headline/timeline maximum invariant.
  if (truePeakByStep.length > 0 && stepPeak > 0) {
    const lastIndex = truePeakByStep.length - 1;
    truePeakByStep[lastIndex] = Math.max(truePeakByStep[lastIndex], peakToDb(stepPeak));
  }

  return {
    samplePeakDbfs: peakToDb(overallSamplePeak),
    truePeakDbtp: peakToDb(overallTruePeak),
    truePeakByStep,
  };
}

function buildTimeline(
  stepDurationSeconds: number,
  segmentEnergies: number[],
  truePeakByStep: number[],
  sampleRate: number,
): AnalysisTimeline {
  const momentaryWindow = Math.max(1, Math.round(0.4 / stepDurationSeconds));
  const shortTermWindow = Math.max(1, Math.round(3 / stepDurationSeconds));
  const segmentSamples = Math.max(1, Math.round(stepDurationSeconds * sampleRate));

  const pointCount = segmentEnergies.length;
  const momentaryLufs = new Float32Array(pointCount);
  const shortTermLufs = new Float32Array(pointCount);
  const timeSeconds = new Float32Array(pointCount);
  const truePeakDbtp = new Float32Array(pointCount);
  momentaryLufs.fill(Number.NaN);
  shortTermLufs.fill(Number.NaN);

  let momentarySum = 0;
  let shortTermSum = 0;

  for (let index = 0; index < segmentEnergies.length; index += 1) {
    const energy = segmentEnergies[index];
    momentarySum += energy;
    shortTermSum += energy;

    if (index >= momentaryWindow) {
      momentarySum -= segmentEnergies[index - momentaryWindow];
    }

    if (index >= shortTermWindow) {
      shortTermSum -= segmentEnergies[index - shortTermWindow];
    }

    timeSeconds[index] = (index + 1) * stepDurationSeconds;

    if (index >= momentaryWindow - 1) {
      momentaryLufs[index] = energyToLufs(momentarySum / (momentaryWindow * segmentSamples));
    }

    if (index >= shortTermWindow - 1) {
      shortTermLufs[index] = energyToLufs(shortTermSum / (shortTermWindow * segmentSamples));
    }

    truePeakDbtp[index] = truePeakByStep[index];
  }

  return {
    stepDurationSeconds,
    timeSeconds,
    momentaryLufs,
    shortTermLufs,
    truePeakDbtp,
  };
}

interface IntegratedResult {
  // -70 sentinel when invalid (kept at the wire level per H-02 contract §2).
  integratedLufs: number;
  integratedValid: boolean;
  integratedInvalidReason?: IntegratedInvalidReason;
}

function calculateIntegrated(
  segmentEnergies: number[],
  timeline: AnalysisTimeline,
  sampleRate: number,
): IntegratedResult {
  const blockWindow = Math.max(1, Math.round(0.4 / timeline.stepDurationSeconds));
  const segmentSamples = Math.max(1, Math.round(timeline.stepDurationSeconds * sampleRate));
  const absoluteGateEnergy = 10 ** ((-70 + 0.691) / 10);
  const gatedBlockEnergies: number[] = [];
  let anyCompleteBlock = false;

  let blockEnergy = 0;
  for (let index = 0; index < segmentEnergies.length; index += 1) {
    blockEnergy += segmentEnergies[index];
    if (index >= blockWindow) {
      blockEnergy -= segmentEnergies[index - blockWindow];
    }

    // A complete 400 ms gated block exists exactly where the momentary window is
    // defined (index >= blockWindow - 1).
    if (!Number.isFinite(timeline.momentaryLufs[index])) {
      continue;
    }
    anyCompleteBlock = true;

    const windowEnergy = blockEnergy / (blockWindow * segmentSamples);
    if (windowEnergy > absoluteGateEnergy) {
      gatedBlockEnergies.push(windowEnergy);
    }
  }

  // H-02: distinguish "too-short" (no complete 400 ms block at all) from
  // "below-gate" (blocks exist but none clears the -70 LUFS absolute gate). The
  // -70 sentinel is retained as the wire value in both invalid cases.
  if (!anyCompleteBlock) {
    return { integratedLufs: -70, integratedValid: false, integratedInvalidReason: "too-short" };
  }
  if (gatedBlockEnergies.length === 0) {
    return { integratedLufs: -70, integratedValid: false, integratedInvalidReason: "below-gate" };
  }

  const average = gatedBlockEnergies.reduce((sum, energy) => sum + energy, 0) / gatedBlockEnergies.length;
  const relativeGate = average * 10 ** (-10 / 10);
  const finalBlocks = gatedBlockEnergies.filter((energy) => energy > relativeGate);
  if (finalBlocks.length === 0) {
    // Unreachable in practice (the maximum absolute-gated block always clears the
    // relative gate), but fail closed rather than emit a fabricated number.
    return { integratedLufs: -70, integratedValid: false, integratedInvalidReason: "below-gate" };
  }

  return {
    integratedLufs: energyToLufs(finalBlocks.reduce((sum, energy) => sum + energy, 0) / finalBlocks.length),
    integratedValid: true,
  };
}

function calculateLra(segmentEnergies: number[], stepDurationSeconds: number, sampleRate: number) {
  const shortTermWindow = Math.max(1, Math.round(3 / stepDurationSeconds));
  const segmentSamples = Math.max(1, Math.round(stepDurationSeconds * sampleRate));
  const absoluteGateEnergy = 10 ** ((-70 + 0.691) / 10);

  const shortTermLoudness: number[] = [];
  let blockEnergy = 0;

  // Only complete 3 s windows of programme enter the LRA distribution. Appending
  // silence creates partial trailing windows whose falling energy can inflate the
  // percentile spread of otherwise steady, short material.
  for (let index = 0; index < segmentEnergies.length; index += 1) {
    blockEnergy += segmentEnergies[index];
    if (index >= shortTermWindow) {
      blockEnergy -= segmentEnergies[index - shortTermWindow];
    }

    if (index < shortTermWindow - 1) {
      continue;
    }

    shortTermLoudness.push(energyToUnclampedLufs(blockEnergy / (shortTermWindow * segmentSamples)));
  }

  if (shortTermLoudness.length < 2) {
    return { loudnessRange: 0, loudnessRangeValid: false };
  }

  const absoluteGated = shortTermLoudness.filter((loudness) => loudness >= -70);
  if (absoluteGated.length < 2) {
    return { loudnessRange: 0, loudnessRangeValid: true };
  }

  const averagePower =
    absoluteGated.reduce((sum, loudness) => sum + 10 ** (loudness / 10), 0) /
    absoluteGated.length;
  const relativeGate = 10 * Math.log10(Math.max(averagePower, absoluteGateEnergy)) - 20;
  const gated = absoluteGated.filter((loudness) => loudness >= relativeGate);
  if (gated.length < 2) {
    return { loudnessRange: 0, loudnessRangeValid: true };
  }

  const loudnessValues = [...gated].sort((a, b) => a - b);
  const lo = percentileRoundedRank(loudnessValues, 0.1);
  const hi = percentileRoundedRank(loudnessValues, 0.95);
  if (lo == null || hi == null) {
    return { loudnessRange: 0, loudnessRangeValid: true };
  }

  return { loudnessRange: Math.max(0, hi - lo), loudnessRangeValid: true };
}

// Single pass, no spread: these arrays hold one entry per 100 ms of audio, and
// spreading a multi-hour timeline into Math.max() overflows the engine's
// argument limit and throws after all the analysis work is already done.
function maxOrNull(values: Float32Array) {
  let max: number | null = null;
  for (const value of values) {
    if (Number.isFinite(value) && (max == null || value > max)) {
      max = value;
    }
  }

  return max;
}

export function analyzeDecodedAsset(
  asset: DecodedAudioAsset,
  target: TargetPreset | null = null,
  onProgress?: AnalysisProgressCallback,
): AnalysisResult {
  if (!Number.isFinite(asset.sampleRate) || asset.sampleRate <= 0) {
    throw new Error("Decoded audio has an invalid sample rate.");
  }

  // M-15: reject rates the K-weighting filter cannot handle stably, before any
  // filtering runs. Outside this range the shelf poles drift and produce
  // non-finite or absurd finite loudness rather than a clean failure.
  if (
    asset.sampleRate < MIN_SUPPORTED_SAMPLE_RATE ||
    asset.sampleRate > MAX_SUPPORTED_SAMPLE_RATE
  ) {
    throw new Error(
      `${UNSUPPORTED_SAMPLE_RATE_PREFIX}${asset.sampleRate} Hz (supported range ${MIN_SUPPORTED_SAMPLE_RATE}-${MAX_SUPPORTED_SAMPLE_RATE} Hz).`,
    );
  }

  const totalFrames = asset.channels[0]?.length ?? 0;
  if (asset.channels.length <= 0 || totalFrames <= 0) {
    throw new Error("No decoded audio frames were available for analysis.");
  }

  const stepSamples = Math.max(1, Math.round(asset.sampleRate * 0.1));
  const stepDurationSeconds = stepSamples / asset.sampleRate;

  // Weights measured on two ten-minute stereo 48 kHz fixtures. On a music-like
  // signal the split is 76 / 24 / 0.1 (true-peak loop, loudness loop, everything
  // else); on seeded noise at a slowly varying level it is 86 / 14 / 0.1. The
  // weights below are the average of the two. The gating, range, and timeline
  // passes run over the segment list rather than the frames, so their share of
  // the run is under a tenth of a percent and rounds away.
  const { samplePeakDbfs, truePeakDbtp, truePeakByStep } = calculatePeaks(
    asset,
    stepSamples,
    onProgress ? (fraction) => onProgress(fraction * 0.8) : undefined,
  );
  const {
    segmentEnergies,
    totalEnergy,
    warnings: analysisWarnings,
    maxMomentaryLufs,
  } = calculateSegmentEnergies(
    asset,
    stepSamples,
    onProgress ? (fraction) => onProgress(0.8 + fraction * 0.2) : undefined,
  );
  onProgress?.(1);

  const timeline = buildTimeline(stepDurationSeconds, segmentEnergies, truePeakByStep, asset.sampleRate);
  const ungatedLufs = energyToLufs(totalEnergy / Math.max(totalFrames, 1));
  const integrated = calculateIntegrated(segmentEnergies, timeline, asset.sampleRate);
  const { loudnessRange, loudnessRangeValid } = calculateLra(
    segmentEnergies,
    stepDurationSeconds,
    asset.sampleRate,
  );

  // EBU Tech 3341 §2.4: Loudness Range is not statistically stable for programmes
  // shorter than 60 s. Flagged so consumers can render an "unstable" qualifier.
  const loudnessRangeUnstable = totalFrames / asset.sampleRate < 60;

  const warnings = [...asset.warnings, ...analysisWarnings];
  if (!integrated.integratedValid) {
    warnings.push(
      integrated.integratedInvalidReason === "too-short"
        ? INVALID_INTEGRATED_TOO_SHORT_WARNING
        : INVALID_INTEGRATED_BELOW_GATE_WARNING,
    );
  }
  if (loudnessRangeUnstable) {
    warnings.push(LRA_UNSTABLE_WARNING);
  }
  // Documented low-rate limitation: the K-weighting response diverges from the
  // 48 kHz reference near Nyquist below ~24 kHz. Warn rather than silently
  // presenting a hotter-than-reference reading as an exact standards match.
  if (asset.sampleRate < LOW_SAMPLE_RATE_KWEIGHTING_THRESHOLD) {
    warnings.push(LOW_SAMPLE_RATE_KWEIGHTING_WARNING);
  }

  const baseMetrics: LoudnessMetrics = {
    integratedLufs: integrated.integratedLufs,
    ungatedLufs,
    loudnessRange,
    loudnessRangeValid,
    integratedValid: integrated.integratedValid,
    loudnessRangeUnstable,
    maxMomentaryLufs,
    maxShortTermLufs: maxOrNull(timeline.shortTermLufs),
    samplePeakDbfs,
    truePeakDbtp,
    unclampedTargetDeltaDb: null,
    targetDeltaDb: null,
    projectedTruePeakDbtp: null,
    normalizationLimited: false,
    timeline,
    warnings,
  };
  // Present iff integratedValid === false (contract §1).
  if (integrated.integratedInvalidReason) {
    baseMetrics.integratedInvalidReason = integrated.integratedInvalidReason;
  }

  const metrics = target ? applyTargetToMetrics(baseMetrics, target) : baseMetrics;

  return {
    metadata: {
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sourceFormat: asset.sourceFormat,
      sampleRate: asset.sampleRate,
      bitDepth: asset.bitDepth,
      durationSeconds: asset.durationSeconds,
      frameCount: asset.frameCount,
      channelCount: asset.channelCount,
      channelLayout: asset.channelLayout,
      decoderMode: asset.decoderMode,
      decoderLabel: asset.decoderLabel,
      decoderSummary: asset.decoderSummary,
      decodeNotes: asset.decodeNotes,
      warnings: asset.warnings,
    },
    metrics,
    analysisMode: target ? "targeted" : "measure-only",
    target,
    analyzedAt: new Date().toISOString(),
  };
}
