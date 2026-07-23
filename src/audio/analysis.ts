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

const TRUE_PEAK_FIR = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625, 0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625, 0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
];

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

  // M-09: the partial final bin (frames after the last 100 ms boundary; stepPeak is
  // 0 when frameCount is an exact multiple) and the FIR ring-out both belong to the
  // end of the programme but were previously sliced away / left only in the headline
  // peak. Fold them into the last complete bin so the invariant
  // overallTruePeak == max(timeline.truePeakDbtp) holds whenever the timeline is
  // non-empty.
  let tailPeak = stepPeak;

  for (let tailFrame = 0; tailFrame < 11; tailFrame += 1) {
    for (let channelIndex = 0; channelIndex < asset.channels.length; channelIndex += 1) {
      const ring = history[channelIndex];
      const pointer = historyIndex[channelIndex];
      ring[pointer] = 0;
      ring[pointer + 12] = 0;

      for (let phase = 0; phase < TRUE_PEAK_FIR.length; phase += 1) {
        let oversampled = 0;
        for (let tap = 0; tap < 12; tap += 1) {
          oversampled += ring[pointer + tap] * TRUE_PEAK_FIR[phase][tap];
        }
        const magnitude = Math.abs(oversampled);
        overallTruePeak = Math.max(overallTruePeak, magnitude);
        tailPeak = Math.max(tailPeak, magnitude);
      }

      historyIndex[channelIndex] = pointer === 0 ? 11 : pointer - 1;
    }
  }

  if (truePeakByStep.length > 0 && tailPeak > 0) {
    const lastIndex = truePeakByStep.length - 1;
    truePeakByStep[lastIndex] = Math.max(truePeakByStep[lastIndex], peakToDb(tailPeak));
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

  const momentaryLufs: Array<number | null> = [];
  const shortTermLufs: Array<number | null> = [];
  const timeSeconds: number[] = [];

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

    timeSeconds.push((index + 1) * stepDurationSeconds);

    if (index >= momentaryWindow - 1) {
      momentaryLufs.push(energyToLufs(momentarySum / (momentaryWindow * segmentSamples)));
    } else {
      momentaryLufs.push(null);
    }

    if (index >= shortTermWindow - 1) {
      shortTermLufs.push(energyToLufs(shortTermSum / (shortTermWindow * segmentSamples)));
    } else {
      shortTermLufs.push(null);
    }
  }

  return {
    stepDurationSeconds,
    timeSeconds,
    momentaryLufs,
    shortTermLufs,
    truePeakDbtp: truePeakByStep.slice(0, timeSeconds.length),
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
    if (timeline.momentaryLufs[index] == null) {
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

  // EBU Tech 3342 (2023) §5, file-based procedure: "the signal should be followed
  // by at least 1.5 s of silence (corresponding to the latency of the loudness
  // analysis-window) before the final LRA value is determined." We emulate that by
  // sweeping the 3 s short-term window past the end of the real audio by half a
  // window (~1.5 s) of zero-energy segments. This lets the trailing programme be
  // represented by full-length short-term windows instead of being truncated, so a
  // genuine end-transient enters the statistics rather than appearing in only the
  // single window that ends exactly at the last sample.
  //
  // The cascaded gate keeps this honest: a window that has decayed to pure silence
  // falls below the -70 LUFS absolute gate and is dropped, so the padding never
  // injects fabricated low-loudness points. On steady material the handful of
  // trailing half-filled windows sit below the 10th percentile (Tech 3342 §3.1: the
  // 10% lower percentile prevents a fade-out from dominating LRA), so a long steady
  // tone still reads ~0. Not padding at all was the M-14 defect: it diverged from
  // the reference by >18 LU on short end-transient programmes.
  const tailPadSegments = Math.max(1, Math.round(shortTermWindow / 2));
  const sweptSegments = segmentEnergies.length + tailPadSegments;

  const shortTermLoudness: number[] = [];
  let blockEnergy = 0;

  for (let index = 0; index < sweptSegments; index += 1) {
    blockEnergy += index < segmentEnergies.length ? segmentEnergies[index] : 0;
    if (index >= shortTermWindow) {
      const outgoing = index - shortTermWindow;
      blockEnergy -= outgoing < segmentEnergies.length ? segmentEnergies[outgoing] : 0;
    }

    if (index < shortTermWindow - 1) {
      continue;
    }

    // Windows that have fully decayed into the silence pad produce a ~0 mean energy;
    // energyToUnclampedLufs maps that to a large-negative / -Infinity value that the
    // -70 absolute gate below removes. Real-content windows stay finite and gated in.
    shortTermLoudness.push(energyToUnclampedLufs(blockEnergy / (shortTermWindow * segmentSamples)));
  }

  const absoluteGated = shortTermLoudness.filter((loudness) => loudness >= -70);
  if (absoluteGated.length < 2) {
    return 0;
  }

  const averagePower =
    absoluteGated.reduce((sum, loudness) => sum + 10 ** (loudness / 10), 0) /
    absoluteGated.length;
  const relativeGate = 10 * Math.log10(Math.max(averagePower, absoluteGateEnergy)) - 20;
  const gated = absoluteGated.filter((loudness) => loudness >= relativeGate);
  if (gated.length < 2) {
    return 0;
  }

  const loudnessValues = [...gated].sort((a, b) => a - b);
  const lo = percentileRoundedRank(loudnessValues, 0.1);
  const hi = percentileRoundedRank(loudnessValues, 0.95);
  if (lo == null || hi == null) {
    return 0;
  }

  return Math.max(0, hi - lo);
}

// Single pass, no spread: these arrays hold one entry per 100 ms of audio, and
// spreading a multi-hour timeline into Math.max() overflows the engine's
// argument limit and throws after all the analysis work is already done.
function maxOrNull(values: Array<number | null>) {
  let max: number | null = null;
  for (const value of values) {
    if (value != null && (max == null || value > max)) {
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

  // The two frame loops dominate runtime roughly 55/35; the gating and range
  // passes over the (much smaller) segment list make up the tail.
  const { samplePeakDbfs, truePeakDbtp, truePeakByStep } = calculatePeaks(
    asset,
    stepSamples,
    onProgress ? (fraction) => onProgress(fraction * 0.55) : undefined,
  );
  const {
    segmentEnergies,
    totalEnergy,
    warnings: analysisWarnings,
    maxMomentaryLufs,
  } = calculateSegmentEnergies(
    asset,
    stepSamples,
    onProgress ? (fraction) => onProgress(0.55 + fraction * 0.35) : undefined,
  );
  onProgress?.(0.92);

  const timeline = buildTimeline(stepDurationSeconds, segmentEnergies, truePeakByStep, asset.sampleRate);
  const ungatedLufs = energyToLufs(totalEnergy / Math.max(totalFrames, 1));
  const integrated = calculateIntegrated(segmentEnergies, timeline, asset.sampleRate);
  const loudnessRange = calculateLra(segmentEnergies, stepDurationSeconds, asset.sampleRate);

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
