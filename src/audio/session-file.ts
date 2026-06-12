import { fileNameTimestamp } from "@/lib/format";
import type {
  AnalysisMode,
  AnalysisJob,
  AnalysisResult,
  AnalysisTimeline,
  AudioMetadata,
  ChannelLabel,
  DecoderMode,
  LoudnessMetrics,
  SourceFormat,
  TargetPreset,
} from "@/types/audio";

// Portable session file: an open-JSON snapshot of a completed review that can be
// re-opened later as a read-only review (results only — the source audio is not
// included, so imported jobs can't be re-analyzed).
const SESSION_APP = "truepeak";
const SESSION_KIND = "session";
const SESSION_VERSION = 1;

// Timestamped so saving twice never overwrites the earlier session file; the
// double extension keeps the format recognizable while staying importable
// through the picker's plain `.json` filter.
export function getSessionFileName() {
  return `truepeak-session-${fileNameTimestamp()}.truepeak.json`;
}

// Import limits: session files are untrusted input, so cap what a single file
// can make the app hold in memory or render.
export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_JOBS = 1000;
const MAX_TIMELINE_POINTS = 500_000;
const MAX_SHORT_STRING = 512;
const MAX_NOTE_STRING = 2000;
const MAX_NOTES = 64;
const MAX_CHANNEL_LABELS = 64;
const MAX_HIGHLIGHTS = 16;

interface SessionFile {
  app: string;
  kind: string;
  version: number;
  exportedAt: string;
  jobCount: number;
  jobs: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    status: "complete";
    createdAt: string;
    progressPercent: number;
    progressLabel: string;
    result: AnalysisResult;
  }>;
}

export function buildSessionFile(jobs: AnalysisJob[]): string {
  const completed = jobs.filter((job): job is AnalysisJob & { result: AnalysisResult } => job.result != null);
  const payload: SessionFile = {
    app: SESSION_APP,
    kind: SESSION_KIND,
    version: SESSION_VERSION,
    exportedAt: new Date().toISOString(),
    jobCount: completed.length,
    jobs: completed.map((job) => ({
      id: job.id,
      fileName: job.fileName,
      mimeType: job.mimeType,
      status: "complete",
      createdAt: job.createdAt,
      progressPercent: 1,
      progressLabel: "Complete",
      result: job.result,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanString(value: unknown, maxLength: number, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, maxItems)
    .map((entry) => cleanString(entry, maxLength));
}

function readFiniteNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > MAX_TIMELINE_POINTS) {
    return null;
  }

  for (const entry of value) {
    if (!isFiniteNumber(entry)) {
      return null;
    }
  }

  return value as number[];
}

function readNullableNumberArray(value: unknown): Array<number | null> | null {
  if (!Array.isArray(value) || value.length > MAX_TIMELINE_POINTS) {
    return null;
  }

  for (const entry of value) {
    if (entry !== null && !isFiniteNumber(entry)) {
      return null;
    }
  }

  return value as Array<number | null>;
}

const SOURCE_FORMATS = new Set<SourceFormat>(["wav", "rf64", "aiff", "aifc", "ffmpeg-wav", "browser-decoded"]);
const DECODER_MODES = new Set<DecoderMode>(["native-parser", "browser-audio", "ffmpeg-wasm"]);
const PRESET_CATEGORIES = new Set<TargetPreset["category"]>(["platform", "podcast", "broadcast", "hifi", "custom"]);
const PRESET_EVIDENCE = new Set<TargetPreset["evidence"]>(["official", "inferred", "custom"]);

function normalizeTimeline(raw: unknown): AnalysisTimeline | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const timeline = raw as Record<string, unknown>;
  const stepDurationSeconds = timeline.stepDurationSeconds;
  if (!isFiniteNumber(stepDurationSeconds) || stepDurationSeconds <= 0) {
    return null;
  }

  const timeSeconds = readFiniteNumberArray(timeline.timeSeconds);
  const momentaryLufs = readNullableNumberArray(timeline.momentaryLufs);
  const shortTermLufs = readNullableNumberArray(timeline.shortTermLufs);
  const truePeakDbtp = readFiniteNumberArray(timeline.truePeakDbtp);
  if (!timeSeconds || !momentaryLufs || !shortTermLufs || !truePeakDbtp) {
    return null;
  }

  return { stepDurationSeconds, timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp };
}

// A target embedded in a session file is optional context. A malformed target
// must not take the whole job down (or crash exports later), so it degrades to
// null instead of rejecting the job.
function normalizeTarget(raw: unknown): TargetPreset | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const target = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(target.loudnessTargetLufs) ||
    !isFiniteNumber(target.truePeakCeilingDbtp) ||
    !isFiniteNumber(target.toleranceLufs)
  ) {
    return null;
  }

  const category = PRESET_CATEGORIES.has(target.category as TargetPreset["category"])
    ? (target.category as TargetPreset["category"])
    : "custom";
  const evidence = PRESET_EVIDENCE.has(target.evidence as TargetPreset["evidence"])
    ? (target.evidence as TargetPreset["evidence"])
    : "custom";
  const rawReferenceUrl = typeof target.referenceUrl === "string" ? target.referenceUrl : null;
  const referenceUrl =
    rawReferenceUrl && /^https?:\/\//i.test(rawReferenceUrl)
      ? cleanString(rawReferenceUrl, MAX_NOTE_STRING)
      : undefined;

  return {
    id: cleanString(target.id, MAX_SHORT_STRING, "imported-target"),
    label: cleanString(target.label, MAX_SHORT_STRING, "Imported target"),
    category,
    evidence,
    sourceLabel: cleanString(target.sourceLabel, MAX_SHORT_STRING),
    referenceNote: cleanString(target.referenceNote, MAX_NOTE_STRING),
    ...(referenceUrl ? { referenceUrl } : {}),
    highlights: cleanStringArray(target.highlights, MAX_HIGHLIGHTS, MAX_SHORT_STRING),
    loudnessTargetLufs: target.loudnessTargetLufs,
    truePeakCeilingDbtp: target.truePeakCeilingDbtp,
    toleranceLufs: target.toleranceLufs,
    policy: target.policy === "loudness-first" ? "loudness-first" : "protect-true-peak",
    description: cleanString(target.description, MAX_NOTE_STRING),
  };
}

// Imported files are untrusted, so rebuild the result from validated fields
// instead of trusting the parsed object. Anything the UI renders or computes
// with is type-checked, range-capped, and re-assembled — unknown fields and
// wrong-typed values never reach React or the exporters.
function normalizeResult(raw: unknown): AnalysisResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const result = raw as Record<string, unknown>;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const metrics = result.metrics as Record<string, unknown> | undefined;

  if (!metadata || typeof metadata !== "object") return null;
  if (!metrics || typeof metrics !== "object") return null;
  if (result.analysisMode !== "targeted" && result.analysisMode !== "measure-only") return null;
  if (typeof result.analyzedAt !== "string") return null;

  if (
    !isFiniteNumber(metrics.integratedLufs) ||
    !isFiniteNumber(metrics.truePeakDbtp) ||
    !isFiniteNumber(metrics.samplePeakDbfs) ||
    !isFiniteNumber(metrics.loudnessRange)
  ) {
    return null;
  }

  const timeline = normalizeTimeline(metrics.timeline);
  if (!timeline) {
    return null;
  }

  const channelLayoutRaw = metadata.channelLayout as Record<string, unknown> | undefined;
  if (
    !isFiniteNumber(metadata.sampleRate) ||
    !channelLayoutRaw ||
    typeof channelLayoutRaw !== "object" ||
    typeof channelLayoutRaw.name !== "string"
  ) {
    return null;
  }

  const normalizedMetadata: AudioMetadata = {
    fileName: cleanString(metadata.fileName, MAX_SHORT_STRING),
    mimeType: cleanString(metadata.mimeType, MAX_SHORT_STRING),
    sourceFormat: SOURCE_FORMATS.has(metadata.sourceFormat as SourceFormat)
      ? (metadata.sourceFormat as SourceFormat)
      : "browser-decoded",
    sampleRate: metadata.sampleRate,
    bitDepth: finiteOr(metadata.bitDepth, 0),
    durationSeconds: finiteOr(metadata.durationSeconds, 0),
    frameCount: finiteOr(metadata.frameCount, 0),
    channelCount: finiteOr(metadata.channelCount, 0),
    channelLayout: {
      name: cleanString(channelLayoutRaw.name, MAX_SHORT_STRING),
      labels: cleanStringArray(channelLayoutRaw.labels, MAX_CHANNEL_LABELS, 16) as ChannelLabel[],
      guessed: channelLayoutRaw.guessed === true,
      speakerMask: finiteOrNull(channelLayoutRaw.speakerMask),
    },
    decoderMode: DECODER_MODES.has(metadata.decoderMode as DecoderMode)
      ? (metadata.decoderMode as DecoderMode)
      : "browser-audio",
    decoderLabel: cleanString(metadata.decoderLabel, MAX_SHORT_STRING),
    decoderSummary: cleanString(metadata.decoderSummary, MAX_NOTE_STRING),
    decodeNotes: cleanStringArray(metadata.decodeNotes, MAX_NOTES, MAX_NOTE_STRING),
    warnings: cleanStringArray(metadata.warnings, MAX_NOTES, MAX_NOTE_STRING),
  };

  const normalizedMetrics: LoudnessMetrics = {
    integratedLufs: metrics.integratedLufs,
    ungatedLufs: finiteOr(metrics.ungatedLufs, -70),
    loudnessRange: metrics.loudnessRange,
    maxMomentaryLufs: finiteOrNull(metrics.maxMomentaryLufs),
    maxShortTermLufs: finiteOrNull(metrics.maxShortTermLufs),
    samplePeakDbfs: metrics.samplePeakDbfs,
    truePeakDbtp: metrics.truePeakDbtp,
    unclampedTargetDeltaDb: finiteOrNull(metrics.unclampedTargetDeltaDb),
    targetDeltaDb: finiteOrNull(metrics.targetDeltaDb),
    projectedTruePeakDbtp: finiteOrNull(metrics.projectedTruePeakDbtp),
    normalizationLimited: metrics.normalizationLimited === true,
    timeline,
    warnings: cleanStringArray(metrics.warnings, MAX_NOTES, MAX_NOTE_STRING),
  };

  return {
    metadata: normalizedMetadata,
    metrics: normalizedMetrics,
    analysisMode: result.analysisMode as AnalysisMode,
    target: normalizeTarget(result.target),
    analyzedAt: cleanString(result.analyzedAt, MAX_SHORT_STRING),
  };
}

// Validates one untrusted job entry — from a session file or a persisted
// live-session record — into a clean, fully rebuilt AnalysisJob, or null.
// Callers decorate the result (imported/restored flags, progress label).
export function normalizeSessionJob(entry: unknown): AnalysisJob | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const raw = entry as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.fileName !== "string") {
    return null;
  }

  const result = normalizeResult(raw.result);
  if (!result) {
    return null;
  }

  return {
    id: cleanString(raw.id, MAX_SHORT_STRING),
    fileName: cleanString(raw.fileName, MAX_SHORT_STRING),
    mimeType: cleanString(raw.mimeType, MAX_SHORT_STRING),
    status: "complete",
    createdAt: cleanString(raw.createdAt, MAX_SHORT_STRING, result.analyzedAt),
    progressPercent: 1,
    progressLabel: "Complete",
    result,
  };
}

export interface SessionImportResult {
  jobs: AnalysisJob[];
  error?: string;
}

export function parseSessionFile(text: string): SessionImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { jobs: [], error: "This file is not valid JSON." };
  }

  if (!data || typeof data !== "object") {
    return { jobs: [], error: "This is not a TruePeak session file." };
  }

  const envelope = data as Record<string, unknown>;
  if (envelope.app !== SESSION_APP || envelope.kind !== SESSION_KIND) {
    return { jobs: [], error: "This is not a TruePeak session file." };
  }
  if (envelope.version !== SESSION_VERSION) {
    return { jobs: [], error: `Unsupported session file version (${String(envelope.version)}).` };
  }
  if (!Array.isArray(envelope.jobs)) {
    return { jobs: [], error: "The session file does not contain any analyses." };
  }

  const jobs: AnalysisJob[] = [];
  for (const entry of envelope.jobs) {
    if (jobs.length >= MAX_SESSION_JOBS) {
      break;
    }

    const job = normalizeSessionJob(entry);
    if (!job) continue;

    jobs.push({ ...job, progressLabel: "Imported", imported: true });
  }

  if (!jobs.length) {
    return { jobs: [], error: "No valid analyses were found in the session file." };
  }

  return { jobs };
}
