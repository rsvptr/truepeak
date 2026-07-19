import { fileNameTimestamp } from "@/lib/format";
import type {
  AnalysisJob,
  AnalysisMode,
  AnalysisProvenance,
  AnalysisProvenanceKind,
  AnalysisResult,
  AnalysisTimeline,
  AudioMetadata,
  ChannelLabel,
  DecoderMode,
  IntegratedInvalidReason,
  LoudnessMetrics,
  SourceFormat,
  TargetPreset,
} from "@/types/audio";

// Portable session file: an open-JSON snapshot of a completed review. Source
// audio is intentionally not included, so imported results are always
// unverified and view-only until the source is analyzed again.
const SESSION_APP = "truepeak";
const SESSION_KIND = "session";
export const SESSION_VERSION = 2;
const LEGACY_SESSION_VERSION = 1;

export function getSessionFileName() {
  return `truepeak-session-${fileNameTimestamp()}.truepeak.json`;
}

// The single authoritative session limit. MAX_SESSION_JOBS is shared by every
// path that grows or bounds a session: file intake, recovery restore, portable
// export, and portable import. Exports and imports fail explicitly rather than
// silently dropping completed jobs. MAX_SESSION_FILE_BYTES and
// MAX_SESSION_TIMELINE_POINTS are separate format/trust-boundary limits.
export const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_JOBS = 1000;
export const MAX_SESSION_TIMELINE_POINTS = 500_000;

export interface SessionIntakePlan {
  /** How many incoming files fit under the global session limit. */
  accepted: number;
  /** How many incoming files are turned away because the session is full. */
  turnedAway: number;
  /** Room left in the session before this add (MAX_SESSION_JOBS - current). */
  capacity: number;
}

// Single source of truth for the global session-limit arithmetic. The cap is
// enforced against everything already in the session, not per add, so a
// sequence of adds can never push the session past MAX_SESSION_JOBS total jobs.
// `incoming` is the count of otherwise-acceptable new files.
export function planSessionIntake(
  currentJobCount: number,
  incoming: number,
): SessionIntakePlan {
  const safeCurrent = Number.isFinite(currentJobCount)
    ? Math.max(0, Math.floor(currentJobCount))
    : 0;
  const safeIncoming = Number.isFinite(incoming)
    ? Math.max(0, Math.floor(incoming))
    : 0;
  const capacity = Math.max(0, MAX_SESSION_JOBS - safeCurrent);
  const accepted = Math.min(safeIncoming, capacity);
  return { accepted, turnedAway: safeIncoming - accepted, capacity };
}
const MAX_SHORT_STRING = 512;
const MAX_NOTE_STRING = 2000;
const MAX_NOTES = 64;
const MAX_CHANNEL_LABELS = 64;
const MAX_HIGHLIGHTS = 16;
const MAX_PROVENANCE_ID = 512;
const MAX_PROVENANCE_DIGEST = 80;
const PORTABLE_TIMELINE_WARNING =
  "Timeline downsampled to fit the portable session format; headline measurements are unchanged.";

const SOURCE_FORMATS = new Set<SourceFormat>([
  "wav",
  "rf64",
  "aiff",
  "aifc",
  "ffmpeg-wav",
  "browser-decoded",
]);
const DECODER_MODES = new Set<DecoderMode>([
  "native-parser",
  "browser-audio",
  "ffmpeg-wasm",
]);
const PRESET_CATEGORIES = new Set<TargetPreset["category"]>([
  "platform",
  "podcast",
  "broadcast",
  "hifi",
  "custom",
]);
const PRESET_EVIDENCE = new Set<TargetPreset["evidence"]>([
  "official",
  "inferred",
  "custom",
]);
const CHANNEL_LABELS = new Set<ChannelLabel>([
  "L",
  "R",
  "C",
  "LFE",
  "Ls",
  "Rs",
  "Lb",
  "Rb",
  "Cs",
  "Lc",
  "Rc",
  "Tfl",
  "Tfc",
  "Tfr",
  "Tc",
  "Tsl",
  "Tsr",
  "Tbl",
  "Tbc",
  "Tbr",
  "Unknown",
]);
const INTEGRATED_INVALID_REASONS = new Set<IntegratedInvalidReason>([
  "too-short",
  "below-gate",
]);
const PROVENANCE_KINDS = new Set<AnalysisProvenanceKind>([
  "local-analysis",
  "restored-local",
  "unverified-import",
]);
const SHA256_DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/i;

interface PortableSessionJob {
  id: string;
  fileName: string;
  mimeType: string;
  status: "complete";
  createdAt: string;
  progressPercent: 1;
  progressLabel: "Complete";
  provenance: AnalysisProvenance;
  result: AnalysisResult;
}

interface SessionFileV2 {
  app: typeof SESSION_APP;
  kind: typeof SESSION_KIND;
  version: typeof SESSION_VERSION;
  exportedAt: string;
  jobCount: number;
  jobs: PortableSessionJob[];
}

export class SessionExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExportError";
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function cleanString(value: unknown, maxLength: number, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function cleanRequiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return cleanString(value, maxLength);
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

function normalizeIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) {
    return null;
  }

  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    return null;
  }

  try {
    return new Date(epochMs).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

// Exact TextEncoder-compatible byte count without allocating another copy of a
// potentially 64 MiB string.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function normalizeDigest(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > MAX_PROVENANCE_DIGEST ||
    !SHA256_DIGEST.test(value)
  ) {
    return undefined;
  }

  return value.toLowerCase();
}

function normalizeProvenance(raw: unknown): AnalysisProvenance | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const value = raw as Record<string, unknown>;
  if (!PROVENANCE_KINDS.has(value.kind as AnalysisProvenanceKind)) {
    return undefined;
  }

  const sourceJobId = cleanRequiredString(value.sourceJobId, MAX_PROVENANCE_ID);
  const sourceSessionDigest = normalizeDigest(value.sourceSessionDigest);
  return {
    kind: value.kind as AnalysisProvenanceKind,
    ...(sourceJobId ? { sourceJobId } : {}),
    ...(sourceSessionDigest ? { sourceSessionDigest } : {}),
  };
}

/** Resolve legacy flags and structured provenance into one exportable origin. */
export function resolveAnalysisProvenance(job: AnalysisJob): AnalysisProvenance {
  const declared = normalizeProvenance(job.provenance);
  const kind: AnalysisProvenanceKind =
    job.imported || declared?.kind === "unverified-import"
      ? "unverified-import"
      : job.restored || declared?.kind === "restored-local"
        ? "restored-local"
        : "local-analysis";

  return {
    kind,
    ...(declared?.sourceJobId ? { sourceJobId: declared.sourceJobId } : {}),
    ...(declared?.sourceSessionDigest
      ? { sourceSessionDigest: declared.sourceSessionDigest }
      : {}),
  };
}

function readFiniteNumberArray(value: unknown, maxPoints: number): number[] | null {
  if (!Array.isArray(value) || value.length > maxPoints) {
    return null;
  }

  for (const entry of value) {
    if (!isFiniteNumber(entry)) {
      return null;
    }
  }

  return value as number[];
}

function readNullableNumberArray(
  value: unknown,
  maxPoints: number,
): Array<number | null> | null {
  if (!Array.isArray(value) || value.length > maxPoints) {
    return null;
  }

  for (const entry of value) {
    if (entry !== null && !isFiniteNumber(entry)) {
      return null;
    }
  }

  return value as Array<number | null>;
}

function normalizeTimeline(
  raw: unknown,
  maxPoints = MAX_SESSION_TIMELINE_POINTS,
): AnalysisTimeline | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const timeline = raw as Record<string, unknown>;
  const stepDurationSeconds = timeline.stepDurationSeconds;
  if (!isFiniteNumber(stepDurationSeconds) || stepDurationSeconds <= 0) {
    return null;
  }

  const timeSeconds = readFiniteNumberArray(timeline.timeSeconds, maxPoints);
  const momentaryLufs = readNullableNumberArray(timeline.momentaryLufs, maxPoints);
  const shortTermLufs = readNullableNumberArray(timeline.shortTermLufs, maxPoints);
  const truePeakDbtp = readFiniteNumberArray(timeline.truePeakDbtp, maxPoints);
  if (!timeSeconds || !momentaryLufs || !shortTermLufs || !truePeakDbtp) {
    return null;
  }
  if (
    momentaryLufs.length !== timeSeconds.length ||
    shortTermLufs.length !== timeSeconds.length ||
    truePeakDbtp.length !== timeSeconds.length
  ) {
    return null;
  }

  let previous = -Infinity;
  for (const time of timeSeconds) {
    if (time < 0 || time <= previous) {
      return null;
    }
    previous = time;
  }

  return {
    stepDurationSeconds,
    timeSeconds,
    momentaryLufs,
    shortTermLufs,
    truePeakDbtp,
  };
}

function normalizeTarget(raw: unknown): TargetPreset | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const target = raw as Record<string, unknown>;
  const id = cleanRequiredString(target.id, MAX_SHORT_STRING);
  const label = cleanRequiredString(target.label, MAX_SHORT_STRING);
  const sourceLabel = cleanRequiredString(target.sourceLabel, MAX_SHORT_STRING);
  if (
    !id ||
    !label ||
    !sourceLabel ||
    typeof target.referenceNote !== "string" ||
    typeof target.description !== "string" ||
    !PRESET_CATEGORIES.has(target.category as TargetPreset["category"]) ||
    !PRESET_EVIDENCE.has(target.evidence as TargetPreset["evidence"]) ||
    !isFiniteNumber(target.loudnessTargetLufs) ||
    !isFiniteNumber(target.truePeakCeilingDbtp) ||
    !isFiniteNumber(target.toleranceLufs) ||
    target.toleranceLufs < 0 ||
    (target.policy !== "protect-true-peak" && target.policy !== "loudness-first")
  ) {
    return null;
  }

  const rawReferenceUrl = typeof target.referenceUrl === "string" ? target.referenceUrl : null;
  const referenceUrl =
    rawReferenceUrl && /^https?:\/\//i.test(rawReferenceUrl)
      ? cleanString(rawReferenceUrl, MAX_NOTE_STRING)
      : undefined;

  return {
    id,
    label,
    category: target.category as TargetPreset["category"],
    evidence: target.evidence as TargetPreset["evidence"],
    sourceLabel,
    referenceNote: cleanString(target.referenceNote, MAX_NOTE_STRING),
    ...(referenceUrl ? { referenceUrl } : {}),
    highlights: cleanStringArray(target.highlights, MAX_HIGHLIGHTS, MAX_SHORT_STRING),
    loudnessTargetLufs: target.loudnessTargetLufs,
    truePeakCeilingDbtp: target.truePeakCeilingDbtp,
    toleranceLufs: target.toleranceLufs,
    policy: target.policy,
    description: cleanString(target.description, MAX_NOTE_STRING),
  };
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function normalizeResult(raw: unknown): AnalysisResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const result = raw as Record<string, unknown>;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const metrics = result.metrics as Record<string, unknown> | undefined;
  const analyzedAt = normalizeIsoDate(result.analyzedAt);
  if (!metadata || typeof metadata !== "object" || !metrics || typeof metrics !== "object") {
    return null;
  }
  if (result.analysisMode !== "targeted" && result.analysisMode !== "measure-only") {
    return null;
  }
  if (!analyzedAt) {
    return null;
  }

  const metadataFileName = cleanRequiredString(metadata.fileName, MAX_SHORT_STRING);
  if (
    !metadataFileName ||
    typeof metadata.mimeType !== "string" ||
    !SOURCE_FORMATS.has(metadata.sourceFormat as SourceFormat) ||
    !isPositiveInteger(metadata.sampleRate) ||
    metadata.sampleRate > 1_000_000 ||
    !isPositiveInteger(metadata.bitDepth) ||
    metadata.bitDepth > 128 ||
    !isFiniteNumber(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    !isPositiveInteger(metadata.frameCount) ||
    !isPositiveInteger(metadata.channelCount) ||
    metadata.channelCount > MAX_CHANNEL_LABELS ||
    !DECODER_MODES.has(metadata.decoderMode as DecoderMode) ||
    typeof metadata.decoderLabel !== "string" ||
    typeof metadata.decoderSummary !== "string"
  ) {
    return null;
  }

  const expectedDuration = metadata.frameCount / metadata.sampleRate;
  const durationTolerance = Math.max(1 / metadata.sampleRate, 1e-6);
  if (Math.abs(metadata.durationSeconds - expectedDuration) > durationTolerance) {
    return null;
  }

  const channelLayoutRaw = metadata.channelLayout as Record<string, unknown> | undefined;
  if (
    !channelLayoutRaw ||
    typeof channelLayoutRaw !== "object" ||
    typeof channelLayoutRaw.name !== "string" ||
    typeof channelLayoutRaw.guessed !== "boolean" ||
    !Array.isArray(channelLayoutRaw.labels) ||
    channelLayoutRaw.labels.length !== metadata.channelCount ||
    channelLayoutRaw.labels.length > MAX_CHANNEL_LABELS
  ) {
    return null;
  }

  const labels: ChannelLabel[] = [];
  for (const label of channelLayoutRaw.labels) {
    if (typeof label !== "string" || !CHANNEL_LABELS.has(label as ChannelLabel)) {
      return null;
    }
    labels.push(label as ChannelLabel);
  }

  const rawSpeakerMask = channelLayoutRaw.speakerMask;
  if (
    rawSpeakerMask !== undefined &&
    rawSpeakerMask !== null &&
    (!Number.isSafeInteger(rawSpeakerMask) || (rawSpeakerMask as number) < 0 || (rawSpeakerMask as number) > 0xffffffff)
  ) {
    return null;
  }

  if (
    !isFiniteNumber(metrics.integratedLufs) ||
    !isFiniteNumber(metrics.ungatedLufs) ||
    !isFiniteNumber(metrics.loudnessRange) ||
    !isFiniteOrNull(metrics.maxMomentaryLufs) ||
    !isFiniteOrNull(metrics.maxShortTermLufs) ||
    !isFiniteNumber(metrics.samplePeakDbfs) ||
    !isFiniteNumber(metrics.truePeakDbtp) ||
    !isFiniteOrNull(metrics.unclampedTargetDeltaDb) ||
    !isFiniteOrNull(metrics.targetDeltaDb) ||
    !isFiniteOrNull(metrics.projectedTruePeakDbtp) ||
    typeof metrics.normalizationLimited !== "boolean"
  ) {
    return null;
  }

  const integratedValid = metrics.integratedValid;
  const integratedInvalidReason = metrics.integratedInvalidReason;
  if (integratedValid !== undefined && typeof integratedValid !== "boolean") {
    return null;
  }
  if (
    integratedValid === false &&
    (!INTEGRATED_INVALID_REASONS.has(integratedInvalidReason as IntegratedInvalidReason) ||
      metrics.integratedLufs !== -70 ||
      metrics.unclampedTargetDeltaDb !== null ||
      metrics.targetDeltaDb !== null ||
      metrics.projectedTruePeakDbtp !== null ||
      metrics.normalizationLimited !== false)
  ) {
    return null;
  }
  if (integratedValid !== false && integratedInvalidReason !== undefined) {
    return null;
  }

  if (
    metrics.loudnessRangeUnstable !== undefined &&
    typeof metrics.loudnessRangeUnstable !== "boolean"
  ) {
    return null;
  }
  if (
    typeof metrics.loudnessRangeUnstable === "boolean" &&
    metrics.loudnessRangeUnstable !== (metadata.durationSeconds < 60)
  ) {
    return null;
  }

  const timeline = normalizeTimeline(metrics.timeline);
  if (!timeline) {
    return null;
  }
  const finalTime = timeline.timeSeconds.at(-1);
  if (
    finalTime !== undefined &&
    finalTime > metadata.durationSeconds + timeline.stepDurationSeconds + 1e-6
  ) {
    return null;
  }

  const target = normalizeTarget(result.target);
  if (
    (result.analysisMode === "targeted" && !target) ||
    (result.analysisMode === "measure-only" && result.target != null)
  ) {
    return null;
  }

  const normalizedMetadata: AudioMetadata = {
    fileName: metadataFileName,
    mimeType: cleanString(metadata.mimeType, MAX_SHORT_STRING),
    sourceFormat: metadata.sourceFormat as SourceFormat,
    sampleRate: metadata.sampleRate,
    bitDepth: metadata.bitDepth,
    durationSeconds: metadata.durationSeconds,
    frameCount: metadata.frameCount,
    channelCount: metadata.channelCount,
    channelLayout: {
      name: cleanString(channelLayoutRaw.name, MAX_SHORT_STRING),
      labels,
      guessed: channelLayoutRaw.guessed,
      speakerMask: rawSpeakerMask == null ? null : (rawSpeakerMask as number),
    },
    decoderMode: metadata.decoderMode as DecoderMode,
    decoderLabel: cleanString(metadata.decoderLabel, MAX_SHORT_STRING),
    decoderSummary: cleanString(metadata.decoderSummary, MAX_NOTE_STRING),
    decodeNotes: cleanStringArray(metadata.decodeNotes, MAX_NOTES, MAX_NOTE_STRING),
    warnings: cleanStringArray(metadata.warnings, MAX_NOTES, MAX_NOTE_STRING),
  };

  const normalizedMetrics: LoudnessMetrics = {
    integratedLufs: metrics.integratedLufs,
    ungatedLufs: metrics.ungatedLufs,
    loudnessRange: metrics.loudnessRange,
    ...(typeof integratedValid === "boolean" ? { integratedValid } : {}),
    ...(integratedValid === false
      ? { integratedInvalidReason: integratedInvalidReason as IntegratedInvalidReason }
      : {}),
    ...(typeof metrics.loudnessRangeUnstable === "boolean"
      ? { loudnessRangeUnstable: metrics.loudnessRangeUnstable }
      : {}),
    maxMomentaryLufs: metrics.maxMomentaryLufs,
    maxShortTermLufs: metrics.maxShortTermLufs,
    samplePeakDbfs: metrics.samplePeakDbfs,
    truePeakDbtp: metrics.truePeakDbtp,
    unclampedTargetDeltaDb: metrics.unclampedTargetDeltaDb,
    targetDeltaDb: metrics.targetDeltaDb,
    projectedTruePeakDbtp: metrics.projectedTruePeakDbtp,
    normalizationLimited: metrics.normalizationLimited,
    timeline,
    warnings: cleanStringArray(metrics.warnings, MAX_NOTES, MAX_NOTE_STRING),
  };

  return {
    metadata: normalizedMetadata,
    metrics: normalizedMetrics,
    analysisMode: result.analysisMode as AnalysisMode,
    target,
    analyzedAt,
  };
}

// Validates one untrusted session/live-store record into a rebuilt job. This
// function preserves the record id because IndexedDB restore relies on it;
// parseSessionFile separately replaces portable-file ids with fresh local ids.
export function normalizeSessionJob(entry: unknown): AnalysisJob | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const raw = entry as Record<string, unknown>;
  const id = cleanRequiredString(raw.id, MAX_SHORT_STRING);
  const fileName = cleanRequiredString(raw.fileName, MAX_SHORT_STRING);
  const createdAt = normalizeIsoDate(raw.createdAt);
  if (!id || !fileName || !createdAt || typeof raw.mimeType !== "string") {
    return null;
  }

  const result = normalizeResult(raw.result);
  if (!result || result.metadata.fileName !== fileName) {
    return null;
  }
  if (raw.mimeType && result.metadata.mimeType && raw.mimeType !== result.metadata.mimeType) {
    return null;
  }
  if (Date.parse(createdAt) > Date.parse(result.analyzedAt)) {
    return null;
  }

  const provenance = normalizeProvenance(raw.provenance);
  return {
    id,
    fileName,
    mimeType: cleanString(raw.mimeType || result.metadata.mimeType, MAX_SHORT_STRING),
    status: "complete",
    createdAt,
    progressPercent: 1,
    progressLabel: "Complete",
    result,
    ...(provenance ? { provenance } : {}),
  };
}

function allocateTimelinePoints(lengths: number[]): number[] {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= MAX_SESSION_TIMELINE_POINTS) {
    return [...lengths];
  }

  const allocations = lengths.map((length) => Math.min(length, length > 0 ? 2 : 0));
  const baseline = allocations.reduce((sum, length) => sum + length, 0);
  let remaining = MAX_SESSION_TIMELINE_POINTS - baseline;
  const extras = lengths.map((length, index) => length - allocations[index]);
  const totalExtras = extras.reduce((sum, length) => sum + length, 0);

  if (remaining > 0 && totalExtras > 0) {
    for (let index = 0; index < allocations.length; index += 1) {
      const share = Math.min(
        extras[index],
        Math.floor((extras[index] * remaining) / totalExtras),
      );
      allocations[index] += share;
    }

    remaining = MAX_SESSION_TIMELINE_POINTS - allocations.reduce((sum, length) => sum + length, 0);
    for (let index = 0; index < allocations.length && remaining > 0; index += 1) {
      if (allocations[index] < lengths[index]) {
        allocations[index] += 1;
        remaining -= 1;
      }
    }
  }

  return allocations;
}

function downsampleTimeline(timeline: AnalysisTimeline, pointCount: number): AnalysisTimeline {
  const originalCount = timeline.timeSeconds.length;
  if (pointCount >= originalCount) {
    return timeline;
  }
  if (pointCount <= 0) {
    return {
      ...timeline,
      timeSeconds: [],
      momentaryLufs: [],
      shortTermLufs: [],
      truePeakDbtp: [],
    };
  }

  const indexes = pointCount === 1
    ? [0]
    : Array.from({ length: pointCount }, (_, index) =>
        Math.round((index * (originalCount - 1)) / (pointCount - 1)),
      );
  const firstTime = timeline.timeSeconds[indexes[0]];
  const finalTime = timeline.timeSeconds[indexes[indexes.length - 1]];
  const portableStep = pointCount > 1
    ? (finalTime - firstTime) / (pointCount - 1)
    : timeline.stepDurationSeconds;

  return {
    stepDurationSeconds: portableStep,
    timeSeconds: indexes.map((index) => timeline.timeSeconds[index]),
    momentaryLufs: indexes.map((index) => timeline.momentaryLufs[index]),
    shortTermLufs: indexes.map((index) => timeline.shortTermLufs[index]),
    truePeakDbtp: indexes.map((index) => timeline.truePeakDbtp[index]),
  };
}

export function buildSessionFile(jobs: AnalysisJob[]): string {
  const completed = jobs.filter(
    (job): job is AnalysisJob & { result: AnalysisResult } => job.result != null,
  );
  if (!completed.length) {
    throw new SessionExportError("There are no completed analyses to export.");
  }
  if (completed.length > MAX_SESSION_JOBS) {
    throw new SessionExportError(
      `This session has ${completed.length} completed analyses, above the portable-session limit of ${MAX_SESSION_JOBS}. No analyses were exported.`,
    );
  }

  const normalizedTimelines = completed.map((job, index) => {
    const timeline = normalizeTimeline(job.result.metrics.timeline, Number.MAX_SAFE_INTEGER);
    if (!timeline) {
      throw new SessionExportError(
        `Analysis ${index + 1} has an invalid or unaligned timeline and cannot be exported.`,
      );
    }
    return timeline;
  });
  const allocations = allocateTimelinePoints(
    normalizedTimelines.map((timeline) => timeline.timeSeconds.length),
  );

  const portableJobs: PortableSessionJob[] = completed.map((job, index) => {
    const timeline = downsampleTimeline(normalizedTimelines[index], allocations[index]);
    const wasDownsampled = timeline.timeSeconds.length < normalizedTimelines[index].timeSeconds.length;
    const candidate = {
      id: job.id,
      fileName: job.fileName,
      mimeType: job.mimeType,
      createdAt: job.createdAt,
      provenance: resolveAnalysisProvenance(job),
      result: {
        ...job.result,
        metrics: {
          ...job.result.metrics,
          timeline,
          warnings: wasDownsampled
            ? [
                PORTABLE_TIMELINE_WARNING,
                ...job.result.metrics.warnings.filter(
                  (warning) => warning !== PORTABLE_TIMELINE_WARNING,
                ),
              ]
            : job.result.metrics.warnings,
        },
      },
    };
    const normalized = normalizeSessionJob(candidate);
    if (!normalized?.result) {
      throw new SessionExportError(
        `Analysis ${index + 1} (${job.fileName}) does not satisfy the portable-session schema.`,
      );
    }

    return {
      id: normalized.id,
      fileName: normalized.fileName,
      mimeType: normalized.mimeType,
      status: "complete",
      createdAt: normalized.createdAt,
      progressPercent: 1,
      progressLabel: "Complete",
      provenance: resolveAnalysisProvenance(normalized),
      result: normalized.result,
    };
  });

  const payload: SessionFileV2 = {
    app: SESSION_APP,
    kind: SESSION_KIND,
    version: SESSION_VERSION,
    exportedAt: new Date().toISOString(),
    jobCount: portableJobs.length,
    jobs: portableJobs,
  };
  const serialized = JSON.stringify(payload, null, 2);
  const byteLength = utf8ByteLength(serialized);
  if (byteLength > MAX_SESSION_FILE_BYTES) {
    throw new SessionExportError(
      `The portable session would be ${byteLength} UTF-8 bytes, above the ${MAX_SESSION_FILE_BYTES}-byte import limit. No file was created.`,
    );
  }

  return serialized;
}

export interface SessionImportResult {
  jobs: AnalysisJob[];
  sourceVersion?: 1 | 2;
  error?: string;
}

export interface SessionImportOptions {
  /** Optional SHA-256 supplied by the caller after hashing the source bytes. */
  sourceSessionDigest?: string;
}

let fallbackImportId = 0;
function makeImportedJobId() {
  if (globalThis.crypto?.randomUUID) {
    return `analysis-import-${globalThis.crypto.randomUUID()}`;
  }

  fallbackImportId += 1;
  return `analysis-import-${Date.now().toString(36)}-${fallbackImportId.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function parseSessionFile(
  text: string,
  options: SessionImportOptions = {},
): SessionImportResult {
  if (utf8ByteLength(text) > MAX_SESSION_FILE_BYTES) {
    return { jobs: [], error: "That session file is too large to import safely." };
  }

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
  if (envelope.version !== LEGACY_SESSION_VERSION && envelope.version !== SESSION_VERSION) {
    return {
      jobs: [],
      error: "This session file uses an unsupported version.",
    };
  }
  const sourceVersion = envelope.version as 1 | 2;
  if (!normalizeIsoDate(envelope.exportedAt)) {
    return { jobs: [], sourceVersion, error: "The session export date is invalid." };
  }
  if (!Array.isArray(envelope.jobs) || !envelope.jobs.length) {
    return {
      jobs: [],
      sourceVersion,
      error: "The session file does not contain any analyses.",
    };
  }
  if (envelope.jobs.length > MAX_SESSION_JOBS) {
    return {
      jobs: [],
      sourceVersion,
      error: `The session contains ${envelope.jobs.length} analyses, above the import limit of ${MAX_SESSION_JOBS}. Nothing was imported.`,
    };
  }
  if (!Number.isSafeInteger(envelope.jobCount) || envelope.jobCount !== envelope.jobs.length) {
    return {
      jobs: [],
      sourceVersion,
      error: "The session job count does not match its analyses.",
    };
  }

  const callerDigest = normalizeDigest(options.sourceSessionDigest);
  const jobs: AnalysisJob[] = [];
  const generatedIds = new Set<string>();
  let aggregateTimelinePoints = 0;

  for (let index = 0; index < envelope.jobs.length; index += 1) {
    const rawEntry = envelope.jobs[index];
    if (!rawEntry || typeof rawEntry !== "object") {
      return {
        jobs: [],
        sourceVersion,
        error: `Analysis ${index + 1} is malformed. Nothing was imported.`,
      };
    }

    const raw = rawEntry as Record<string, unknown>;
    if (
      (raw.status !== undefined && raw.status !== "complete") ||
      (raw.progressPercent !== undefined && raw.progressPercent !== 1)
    ) {
      return {
        jobs: [],
        sourceVersion,
        error: `Analysis ${index + 1} is not a completed result. Nothing was imported.`,
      };
    }

    const job = normalizeSessionJob(rawEntry);
    if (!job?.result) {
      return {
        jobs: [],
        sourceVersion,
        error: `Analysis ${index + 1} is invalid or inconsistent. Nothing was imported.`,
      };
    }

    aggregateTimelinePoints += job.result.metrics.timeline.timeSeconds.length;
    if (aggregateTimelinePoints > MAX_SESSION_TIMELINE_POINTS) {
      return {
        jobs: [],
        sourceVersion,
        error: `The session timeline exceeds the aggregate limit of ${MAX_SESSION_TIMELINE_POINTS} points. Nothing was imported.`,
      };
    }

    const declared = normalizeProvenance(raw.provenance);
    const sourceJobId =
      declared?.kind === "unverified-import" && declared.sourceJobId
        ? declared.sourceJobId
        : cleanString(job.id, MAX_PROVENANCE_ID);
    // A portable file cannot authenticate its own digest. Only a digest the
    // caller computed from the actual source bytes may become trusted lineage;
    // otherwise an imported file could forge the "Source Session Digest"
    // shown by later exports.
    const sourceSessionDigest = callerDigest;
    let freshId = makeImportedJobId();
    while (generatedIds.has(freshId)) {
      freshId = makeImportedJobId();
    }
    generatedIds.add(freshId);

    jobs.push({
      ...job,
      id: freshId,
      progressLabel: "Imported",
      imported: true,
      restored: undefined,
      provenance: {
        kind: "unverified-import",
        sourceJobId,
        ...(sourceSessionDigest ? { sourceSessionDigest } : {}),
      },
    });
  }

  return { jobs, sourceVersion };
}
