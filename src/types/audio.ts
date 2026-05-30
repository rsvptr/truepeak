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
  timeSeconds: number[];
  momentaryLufs: Array<number | null>;
  shortTermLufs: Array<number | null>;
  truePeakDbtp: number[];
}

export interface LoudnessMetrics {
  integratedLufs: number;
  ungatedLufs: number;
  loudnessRange: number;
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
}

export interface RecentSessionEntry {
  id: string;
  fileName: string;
  analyzedAt: string;
  analysisMode: AnalysisMode;
  targetLabel: string | null;
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRange: number;
  sampleRate: number;
  channelLayoutName: string;
  decoderLabel: string;
  complianceLabel: string | null;
}
