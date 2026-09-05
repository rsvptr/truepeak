export type JobStatus =
  | "queued"
  | "reading"
  | "decoding"
  | "analyzing"
  | "complete"
  | "failed"
  | "canceled";

export type SourceFormat =
  | "wav"
  | "rf64"
  | "aiff"
  | "aifc"
  | "ffmpeg-wav"
  | "browser-decoded";

export type DecodePreference =
  | "auto"
  | "browser-first"
  | "compatibility-first";

export type DecoderMode = "native-parser" | "browser-audio" | "ffmpeg-wasm";
export type AnalysisMode = "targeted" | "measure-only";

export type TargetPresetCategory =
  | "platform"
  | "podcast"
  | "broadcast"
  | "hifi"
  | "custom";

export type TargetPresetEvidence = "official" | "inferred" | "custom";

export type ChannelLabel =
  | "L"
  | "R"
  | "C"
  | "LFE"
  | "Ls"
  | "Rs"
  | "Lb"
  | "Rb"
  | "Cs"
  | "Lc"
  | "Rc"
  | "Tfl"
  | "Tfc"
  | "Tfr"
  | "Tc"
  | "Tsl"
  | "Tsr"
  | "Tbl"
  | "Tbc"
  | "Tbr"
  | "Unknown";

export interface ChannelLayout {
  name: string;
  labels: ChannelLabel[];
  guessed: boolean;
  speakerMask?: number | null;
}

export interface AudioMetadata {
  fileName: string;
  mimeType: string;
  sourceFormat: SourceFormat;
  sampleRate: number;
  bitDepth: number;
  durationSeconds: number;
  frameCount: number;
  channelCount: number;
  channelLayout: ChannelLayout;
  decoderMode: DecoderMode;
  decoderLabel: string;
  decoderSummary: string;
  decodeNotes: string[];
  warnings: string[];
}

export interface DecodedAudioAsset extends AudioMetadata {
  channels: Float32Array[];
}

export interface DecodedAudioTransfer extends AudioMetadata {
  channelBuffers: ArrayBuffer[];
}

export interface TargetPreset {
  id: string;
  label: string;
  category: TargetPresetCategory;
  evidence: TargetPresetEvidence;
  sourceLabel: string;
  referenceNote: string;
  referenceUrl?: string;
  highlights: string[];
  loudnessTargetLufs: number;
  truePeakCeilingDbtp: number;
  toleranceLufs: number;
  policy: "protect-true-peak" | "loudness-first";
  description: string;
}

export interface AnalysisTimeline {
  stepDurationSeconds: number;
  /** Compact in-memory series. Missing loudness windows use NaN sentinels. */
  timeSeconds: Float32Array;
  momentaryLufs: Float32Array;
  shortTermLufs: Float32Array;
  truePeakDbtp: Float32Array;
}

export type IntegratedInvalidReason = "too-short" | "below-gate";

export interface LoudnessMetrics {
  integratedLufs: number;
  ungatedLufs: number;
  loudnessRange: number;
  /**
   * False when fewer than two complete 3 second short-term windows exist.
   * `loudnessRange` remains 0 for wire compatibility and MUST NOT be presented
   * as a measurement. Absent on older records: treat absent as valid.
   */
  loudnessRangeValid?: boolean;
  /**
   * False when no complete 400 ms gated block exists ("too-short") or nothing
   * survives the -70 LUFS absolute gate ("below-gate"). When false,
   * `integratedLufs` still carries the legacy -70 sentinel for wire
   * compatibility but MUST NOT be presented as a measurement. Absent on
   * records analyzed before this field existed: treat absent as
   * "unknown/legacy", not as false.
   */
  integratedValid?: boolean;
  /** Present iff integratedValid === false. */
  integratedInvalidReason?: IntegratedInvalidReason;
  /**
   * True when programme duration < 60 s: Loudness Range is not statistically
   * stable per EBU Tech 3341 section 2.4.
   */
  loudnessRangeUnstable?: boolean;
  maxMomentaryLufs: number | null;
  maxShortTermLufs: number | null;
  samplePeakDbfs: number;
  truePeakDbtp: number;
  unclampedTargetDeltaDb: number | null;
  targetDeltaDb: number | null;
  projectedTruePeakDbtp: number | null;
  normalizationLimited: boolean;
  timeline: AnalysisTimeline;
  warnings: string[];
}

export interface AnalysisResult {
  metadata: AudioMetadata;
  metrics: LoudnessMetrics;
  analysisMode: AnalysisMode;
  target: TargetPreset | null;
  analyzedAt: string;
}

export type AnalysisProvenanceKind =
  | "local-analysis"
  | "restored-local"
  | "unverified-import";

/**
 * Result origin carried across persistence and portable exports.
 *
 * `sourceJobId` and `sourceSessionDigest` are deliberately plain strings at
 * the type level because their hard bounds are enforced at every session-file
 * trust boundary. A portable file can never grant itself local provenance:
 * the importer always rewrites its origin to `unverified-import`.
 */
export interface AnalysisProvenance {
  kind: AnalysisProvenanceKind;
  sourceJobId?: string;
  sourceSessionDigest?: string;
}

export interface AnalysisJob {
  id: string;
  fileName: string;
  mimeType: string;
  status: JobStatus;
  createdAt: string;
  progressPercent: number;
  progressLabel: string;
  error?: string;
  result?: AnalysisResult;
  // True for jobs reconstructed from an imported session file (results only — no
  // source audio handle, so they can't be re-analyzed).
  imported?: boolean;
  // True for jobs restored from this browser's persisted live session after a
  // refresh. Results only, like imported jobs.
  restored?: boolean;
  // Structured origin used by portable sessions and report exports. Optional
  // for legacy in-memory/IndexedDB records; consumers infer local/imported/
  // restored origin from the compatibility flags when it is absent.
  provenance?: AnalysisProvenance;
  // Wall-clock processing window for this run (epoch ms). Session-local only:
  // used for the per-file timing display and the batch ETA estimate.
  startedAtMs?: number;
  finishedAtMs?: number;
}

export interface RecentSessionEntry {
  id: string;
  fileName: string;
  analyzedAt: string;
  analysisMode: AnalysisMode;
  /** Explicitly distinguishes current-contract summaries from migrated rows. */
  recordTrust?: "validated-v2" | "legacy-unknown";
  provenanceKind?: AnalysisProvenanceKind;
  targetLabel: string | null;
  integratedLufs: number;
  integratedValid?: boolean;
  integratedInvalidReason?: IntegratedInvalidReason;
  truePeakDbtp: number;
  loudnessRange: number;
  /** Absent on older history rows: treat absent as valid. */
  loudnessRangeValid?: boolean;
  loudnessRangeUnstable?: boolean;
  sampleRate: number;
  channelLayoutName: string;
  decoderLabel: string;
  complianceLabel: string | null;
}
