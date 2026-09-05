// Typed object fixtures for the validator suites. Each factory returns a
// complete value of the app's own type and takes a Partial override, so a suite
// can set only the fields the case measures and still pass a well-formed object
// through tsconfig.scripts.json.

/** @typedef {import("../../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../../src/types/audio.ts").AnalysisResult} AnalysisResult */
/** @typedef {import("../../../src/types/audio.ts").AnalysisTimeline} AnalysisTimeline */
/** @typedef {import("../../../src/types/audio.ts").AudioMetadata} AudioMetadata */
/** @typedef {import("../../../src/types/audio.ts").ChannelLayout} ChannelLayout */
/** @typedef {import("../../../src/types/audio.ts").DecodedAudioTransfer} DecodedAudioTransfer */
/** @typedef {import("../../../src/types/audio.ts").LoudnessMetrics} LoudnessMetrics */
/** @typedef {import("../../../src/types/audio.ts").RecentSessionEntry} RecentSessionEntry */
/** @typedef {import("../../../src/types/audio.ts").TargetPreset} TargetPreset */

/**
 * @param {Partial<ChannelLayout>} [overrides]
 * @returns {ChannelLayout}
 */
export function makeChannelLayout(overrides = {}) {
  return { name: "Stereo", labels: ["L", "R"], guessed: false, ...overrides };
}

/**
 * @param {Partial<AnalysisTimeline>} [overrides]
 * @returns {AnalysisTimeline}
 */
export function makeTimeline(overrides = {}) {
  return {
    stepDurationSeconds: 0.1,
    timeSeconds: new Float32Array(0),
    momentaryLufs: new Float32Array(0),
    shortTermLufs: new Float32Array(0),
    truePeakDbtp: new Float32Array(0),
    ...overrides,
  };
}

/**
 * @param {Partial<AudioMetadata>} [overrides]
 * @returns {AudioMetadata}
 */
export function makeAudioMetadata(overrides = {}) {
  return {
    fileName: "fixture.wav",
    mimeType: "audio/wav",
    sourceFormat: "wav",
    sampleRate: 48000,
    bitDepth: 24,
    durationSeconds: 30,
    frameCount: 1440000,
    channelCount: 2,
    channelLayout: makeChannelLayout(),
    decoderMode: "native-parser",
    decoderLabel: "Built-in parser",
    decoderSummary: "",
    decodeNotes: [],
    warnings: [],
    ...overrides,
  };
}

/**
 * @param {Partial<LoudnessMetrics>} [overrides]
 * @returns {LoudnessMetrics}
 */
export function makeMetrics(overrides = {}) {
  return {
    integratedLufs: -14,
    ungatedLufs: -14,
    loudnessRange: 4,
    loudnessRangeValid: true,
    integratedValid: true,
    maxMomentaryLufs: -12,
    maxShortTermLufs: -13,
    samplePeakDbfs: -2,
    truePeakDbtp: -2,
    unclampedTargetDeltaDb: null,
    targetDeltaDb: null,
    projectedTruePeakDbtp: null,
    normalizationLimited: false,
    timeline: makeTimeline(),
    warnings: [],
    ...overrides,
  };
}

/**
 * @param {Partial<TargetPreset>} [overrides]
 * @returns {TargetPreset}
 */
export function makeTargetPreset(overrides = {}) {
  return {
    id: "fixture-target",
    label: "Fixture Target",
    category: "platform",
    evidence: "official",
    sourceLabel: "Fixture",
    referenceNote: "Fixture",
    highlights: [],
    loudnessTargetLufs: -14,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Fixture preset",
    ...overrides,
  };
}

/**
 * @param {Partial<AnalysisResult>} [overrides]
 * @returns {AnalysisResult}
 */
export function makeAnalysisResult(overrides = {}) {
  return {
    metadata: makeAudioMetadata(),
    metrics: makeMetrics(),
    analysisMode: "measure-only",
    target: null,
    analyzedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * @param {Partial<AnalysisJob>} [overrides]
 * @returns {AnalysisJob}
 */
export function makeAnalysisJob(overrides = {}) {
  return {
    id: "job-1",
    fileName: "fixture.wav",
    mimeType: "audio/wav",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    progressPercent: 0,
    progressLabel: "Queued",
    ...overrides,
  };
}

/**
 * @param {Partial<DecodedAudioTransfer>} [overrides]
 * @returns {DecodedAudioTransfer}
 */
export function makeDecodedAudioTransfer(overrides = {}) {
  return { ...makeAudioMetadata(), channelBuffers: [], ...overrides };
}

/**
 * @param {Partial<RecentSessionEntry>} [overrides]
 * @returns {RecentSessionEntry}
 */
export function makeRecentSessionEntry(overrides = {}) {
  return {
    id: "entry-1",
    fileName: "fixture.wav",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    analysisMode: "measure-only",
    targetLabel: null,
    integratedLufs: -14,
    truePeakDbtp: -2,
    loudnessRange: 4,
    sampleRate: 48000,
    channelLayoutName: "Stereo",
    decoderLabel: "Built-in parser",
    complianceLabel: null,
    ...overrides,
  };
}
