import { describeLayoutRisk, getLoudnessWeight } from "@/audio/channel-layout";
import { applyTargetToMetrics } from "@/audio/targeting";
import type {
  AnalysisResult,
  AnalysisTimeline,
  DecodedAudioAsset,
  LoudnessMetrics,
  TargetPreset,
} from "@/types/audio";

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

  processInPlace(channel: Float32Array) {
    const [epsilon, b0, b1, b2, a1, a2, c0, c1, c2, d1, d2] = this.coeffs;
    let [s0, s1, s2, s3] = this.state;

    for (let index = 0; index < channel.length; index += 1) {
      const x = channel[index];
      let y = b0 * x + s0 + epsilon;
      s0 = b1 * x - a1 * y + s1;
      s1 = b2 * x - a2 * y;

      const hp = y - epsilon;
      y = c0 * hp + s2 + epsilon;
      s2 = c1 * hp - d1 * y + s3;
      s3 = c2 * hp - d2 * y;

      channel[index] = y - epsilon;
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

  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const weight = channelWeights[channelIndex];
    if (weight === 0) {
      continue;
    }

    const filtered = channels[channelIndex];
    const filter = new KWeightingFilter(sampleRate);
    filter.processInPlace(filtered);
  }

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

      const sample = channels[channelIndex][frame];
      if (!Number.isFinite(sample)) {
        throw new Error(`Decoded audio contains a non-finite sample at frame ${frame + 1}, channel ${channelIndex + 1}.`);
      }
      frameEnergy += weight * sample * sample;
    }

    if (!Number.isFinite(frameEnergy)) {
      throw new Error(`Decoded audio energy overflowed at frame ${frame + 1}.`);
    }

    totalEnergy += frameEnergy;
    if (frame >= fullSegmentFrameCount) {
      continue;
    }

    segmentEnergy += frameEnergy;

    if ((frame + 1) % stepSamples === 0 || frame === frameCount - 1) {
      segmentEnergies.push(segmentEnergy);
      segmentEnergy = 0;
    }
  }

  return { segmentEnergies, totalEnergy, warnings };
}

function percentileLinear(sortedValues: number[], percentile: number) {
  if (!sortedValues.length) {
    return null;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position = Math.min(
    sortedValues.length - 1,
    Math.max(0, (sortedValues.length - 1) * percentile),
  );
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;

  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * fraction;
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

    if ((frame + 1) % stepSamples === 0 || frame === frameCount - 1) {
      truePeakByStep.push(peakToDb(stepPeak));
      stepPeak = 0;
    }
  }

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
        overallTruePeak = Math.max(overallTruePeak, Math.abs(oversampled));
      }

      historyIndex[channelIndex] = pointer === 0 ? 11 : pointer - 1;
    }
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

function calculateIntegrated(
  segmentEnergies: number[],
  timeline: AnalysisTimeline,
  sampleRate: number,
) {
  const blockWindow = Math.max(1, Math.round(0.4 / timeline.stepDurationSeconds));
  const segmentSamples = Math.max(1, Math.round(timeline.stepDurationSeconds * sampleRate));
  const absoluteGateEnergy = 10 ** ((-70 + 0.691) / 10);
  const gatedBlockEnergies: number[] = [];

  let blockEnergy = 0;
  for (let index = 0; index < segmentEnergies.length; index += 1) {
    blockEnergy += segmentEnergies[index];
    if (index >= blockWindow) {
      blockEnergy -= segmentEnergies[index - blockWindow];
    }

    if (timeline.momentaryLufs[index] == null) {
      continue;
    }

    const windowEnergy = blockEnergy / (blockWindow * segmentSamples);
    if (windowEnergy > absoluteGateEnergy) {
      gatedBlockEnergies.push(windowEnergy);
    }
  }

  if (gatedBlockEnergies.length === 0) {
    return -70;
  }

  const average = gatedBlockEnergies.reduce((sum, energy) => sum + energy, 0) / gatedBlockEnergies.length;
  const relativeGate = average * 10 ** (-10 / 10);
  const finalBlocks = gatedBlockEnergies.filter((energy) => energy > relativeGate);
  if (finalBlocks.length === 0) {
    return -70;
  }

  return energyToLufs(finalBlocks.reduce((sum, energy) => sum + energy, 0) / finalBlocks.length);
}

function calculateLra(segmentEnergies: number[], stepDurationSeconds: number, sampleRate: number) {
  const shortTermWindow = Math.max(1, Math.round(3 / stepDurationSeconds));
  const segmentSamples = Math.max(1, Math.round(stepDurationSeconds * sampleRate));
  const absoluteGateEnergy = 10 ** ((-70 + 0.691) / 10);

  // EBU Tech 3342 computes the loudness range from the short-term loudness of the
  // programme itself. Earlier revisions padded the tail with 1.5s of silence, which
  // injected artificial low-loudness windows and inflated LRA on steady or short
  // material (a dead-steady tone read ~2.3 LU instead of ~0). Measure the real audio.
  const shortTermLoudness: number[] = [];
  let blockEnergy = 0;

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
  const lo = percentileLinear(loudnessValues, 0.1);
  const hi = percentileLinear(loudnessValues, 0.95);
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
  } = calculateSegmentEnergies(
    asset,
    stepSamples,
    onProgress ? (fraction) => onProgress(0.55 + fraction * 0.35) : undefined,
  );
  onProgress?.(0.92);

  const timeline = buildTimeline(stepDurationSeconds, segmentEnergies, truePeakByStep, asset.sampleRate);
  const ungatedLufs = energyToLufs(totalEnergy / Math.max(totalFrames, 1));
  const integratedLufs = calculateIntegrated(segmentEnergies, timeline, asset.sampleRate);
  const loudnessRange = calculateLra(segmentEnergies, stepDurationSeconds, asset.sampleRate);
  const baseMetrics: LoudnessMetrics = {
    integratedLufs,
    ungatedLufs,
    loudnessRange,
    maxMomentaryLufs: maxOrNull(timeline.momentaryLufs),
    maxShortTermLufs: maxOrNull(timeline.shortTermLufs),
    samplePeakDbfs,
    truePeakDbtp,
    unclampedTargetDeltaDb: null,
    targetDeltaDb: null,
    projectedTruePeakDbtp: null,
    normalizationLimited: false,
    timeline,
    warnings: [...asset.warnings, ...analysisWarnings],
  };

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
