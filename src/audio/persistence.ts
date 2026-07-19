import { getComplianceSummary } from "@/audio/compliance";
import { resolveAnalysisProvenance } from "@/audio/session-file";
import type { AnalysisJob, RecentSessionEntry } from "@/types/audio";

const STORAGE_KEY = "truepeak-recent-sessions";
const LEGACY_STORAGE_KEYS = ["lufs-pro-recent-sessions"];
const MAX_RECENT = 20;
const RECENT_SESSIONS_VERSION = 2;
const MAX_LEGACY_RECENT_ROWS = 200;
const MAX_ID_LENGTH = 256;
const MAX_FILE_NAME_LENGTH = 4096;
const MAX_LABEL_LENGTH = 1024;
const MAX_DATE_LENGTH = 64;

interface RecentSessionsEnvelope {
  version: typeof RECENT_SESSIONS_VERSION;
  entries: RecentSessionEntry[];
}

function sortRecentSessions(entries: RecentSessionEntry[]) {
  return [...entries].sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
}

function keyForEntry(entry: RecentSessionEntry) {
  return `${entry.id}:${entry.analyzedAt}`;
}

function isBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.length > 0)
  );
}

function isIsoDate(value: unknown): value is string {
  if (!isBoundedString(value, MAX_DATE_LENGTH)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isBoundedNumber(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isRecentSessionEntry(
  value: unknown,
  schema: "legacy" | "v2",
): value is RecentSessionEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<RecentSessionEntry>;
  const provenanceValid =
    entry.provenanceKind === "local-analysis" ||
    entry.provenanceKind === "restored-local" ||
    entry.provenanceKind === "unverified-import";
  const integratedValidityPresent =
    typeof entry.integratedValid === "boolean";
  const lraStabilityPresent =
    typeof entry.loudnessRangeUnstable === "boolean";
  const validatedV2 = entry.recordTrust === "validated-v2";
  const legacyUnknown = entry.recordTrust === "legacy-unknown";
  const targetSemanticsValid =
    entry.analysisMode === "measure-only"
      ? entry.targetLabel === null && entry.complianceLabel === null
      : legacyUnknown
        ? entry.targetLabel == null ||
          isBoundedString(entry.targetLabel, MAX_LABEL_LENGTH)
        : isBoundedString(entry.targetLabel, MAX_LABEL_LENGTH);
  return (
    isBoundedString(entry.id, MAX_ID_LENGTH) &&
    isBoundedString(entry.fileName, MAX_FILE_NAME_LENGTH) &&
    isIsoDate(entry.analyzedAt) &&
    (entry.analysisMode === "targeted" || entry.analysisMode === "measure-only") &&
    (schema === "legacy"
      ? entry.provenanceKind === undefined || provenanceValid
      : (validatedV2 || legacyUnknown) &&
        (legacyUnknown
          ? entry.provenanceKind === undefined || provenanceValid
          : provenanceValid)) &&
    (entry.targetLabel == null ||
      isBoundedString(entry.targetLabel, MAX_LABEL_LENGTH, true)) &&
    (schema === "legacy" || targetSemanticsValid) &&
    isBoundedNumber(entry.integratedLufs, -200, 100) &&
    (schema === "legacy" || legacyUnknown
      ? entry.integratedValid === undefined || integratedValidityPresent
      : integratedValidityPresent) &&
    (entry.integratedValid === false
      ? (entry.integratedInvalidReason === "too-short" ||
          entry.integratedInvalidReason === "below-gate") &&
        entry.integratedLufs === -70 &&
        entry.complianceLabel === null
      : entry.integratedInvalidReason === undefined) &&
    isBoundedNumber(entry.truePeakDbtp, -1000, 100) &&
    isBoundedNumber(entry.loudnessRange, 0, 1000) &&
    (schema === "legacy" || legacyUnknown
      ? entry.loudnessRangeUnstable === undefined || lraStabilityPresent
      : lraStabilityPresent) &&
    isBoundedNumber(entry.sampleRate, 1, 1_000_000) &&
    isBoundedString(entry.channelLayoutName, MAX_LABEL_LENGTH) &&
    isBoundedString(entry.decoderLabel, MAX_LABEL_LENGTH) &&
    (entry.complianceLabel == null ||
      isBoundedString(entry.complianceLabel, MAX_LABEL_LENGTH, true)) &&
    (!legacyUnknown || entry.complianceLabel === null)
  );
}

function migrateLegacyEntry(entry: RecentSessionEntry): RecentSessionEntry {
  const targetContractValid =
    entry.analysisMode === "targeted"
      ? isBoundedString(entry.targetLabel, MAX_LABEL_LENGTH)
      : entry.targetLabel === null && entry.complianceLabel === null;
  const hasCurrentContract =
    entry.provenanceKind !== undefined &&
    typeof entry.integratedValid === "boolean" &&
    typeof entry.loudnessRangeUnstable === "boolean" &&
    targetContractValid;
  return {
    ...entry,
    recordTrust: hasCurrentContract ? "validated-v2" : "legacy-unknown",
    ...(entry.analysisMode === "measure-only"
      ? { targetLabel: null, complianceLabel: null }
      : hasCurrentContract
        ? {}
        : { complianceLabel: null }),
  };
}

function normalizeRecentSessionEntries(value: unknown) {
  const legacy = Array.isArray(value);
  const entries = legacy
    ? value
    : value &&
        typeof value === "object" &&
        (value as Partial<RecentSessionsEnvelope>).version ===
          RECENT_SESSIONS_VERSION &&
        Array.isArray((value as Partial<RecentSessionsEnvelope>).entries)
      ? (value as Partial<RecentSessionsEnvelope>).entries!
      : null;
  if (
    !entries ||
    entries.length > (legacy ? MAX_LEGACY_RECENT_ROWS : MAX_RECENT)
  ) {
    return null;
  }

  const normalized = entries.filter((entry) =>
    isRecentSessionEntry(entry, legacy ? "legacy" : "v2"),
  );
  const fullyValid = normalized.length === entries.length;
  if (!legacy && !fullyValid) {
    return null;
  }

  return {
    entries: sortRecentSessions(
      legacy ? normalized.map(migrateLegacyEntry) : normalized,
    ).slice(0, MAX_RECENT),
    legacy,
    fullyValid,
  };
}

function completedJobsToEntries(jobs: AnalysisJob[]) {
  return jobs
    .filter((job) => job.result)
    .map((job) => {
      const result = job.result!;
      const compliance = getComplianceSummary(result);
      const hasCurrentContract =
        typeof result.metrics.integratedValid === "boolean" &&
        typeof result.metrics.loudnessRangeUnstable === "boolean";
      return {
        id: job.id,
        fileName: job.fileName,
        analyzedAt: result.analyzedAt,
        analysisMode: result.analysisMode,
        recordTrust: hasCurrentContract
          ? "validated-v2"
          : "legacy-unknown",
        provenanceKind: resolveAnalysisProvenance(job).kind,
        targetLabel: result.target?.label ?? null,
        integratedLufs: result.metrics.integratedLufs,
        ...(typeof result.metrics.integratedValid === "boolean"
          ? { integratedValid: result.metrics.integratedValid }
          : {}),
        ...(result.metrics.integratedValid === false &&
        result.metrics.integratedInvalidReason
          ? { integratedInvalidReason: result.metrics.integratedInvalidReason }
          : {}),
        truePeakDbtp: result.metrics.truePeakDbtp,
        loudnessRange: result.metrics.loudnessRange,
        ...(typeof result.metrics.loudnessRangeUnstable === "boolean"
          ? { loudnessRangeUnstable: result.metrics.loudnessRangeUnstable }
          : {}),
        sampleRate: result.metadata.sampleRate,
        channelLayoutName: result.metadata.channelLayout.name,
        decoderLabel: result.metadata.decoderLabel,
        complianceLabel: hasCurrentContract ? compliance?.label ?? null : null,
      } satisfies RecentSessionEntry;
    });
}

function writeRecentSessions(entries: RecentSessionEntry[]) {
  try {
    const envelope: RecentSessionsEnvelope = {
      version: RECENT_SESSIONS_VERSION,
      entries,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    LEGACY_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
  } catch {}
}

function readRecentSessionsFromStorage() {
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) {
    const parsed = JSON.parse(current);
    const normalized = normalizeRecentSessionEntries(parsed);
    if (!normalized) {
      return [] as RecentSessionEntry[];
    }
    // Upgrade an unversioned array only when every row validates. A malformed
    // legacy row must never be silently deleted as a side effect of reading.
    if (normalized.legacy && normalized.fullyValid) {
      writeRecentSessions(normalized.entries);
    }
    return normalized.entries;
  }

  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy) {
      const normalized = normalizeRecentSessionEntries(JSON.parse(legacy));
      if (!normalized) {
        continue;
      }
      if (normalized.fullyValid) {
        writeRecentSessions(normalized.entries);
      }
      return normalized.entries;
    }
  }

  return [] as RecentSessionEntry[];
}

export function mergeRecentSessions(
  existing: RecentSessionEntry[],
  jobs: AnalysisJob[],
): RecentSessionEntry[] {
  const merged = new Map<string, RecentSessionEntry>();

  sortRecentSessions(existing).forEach((entry) => {
    merged.set(keyForEntry(entry), entry);
  });

  sortRecentSessions(completedJobsToEntries(jobs)).forEach((entry) => {
    merged.set(keyForEntry(entry), entry);
  });

  return sortRecentSessions([...merged.values()]).slice(0, MAX_RECENT);
}

export function loadRecentSessions() {
  if (typeof window === "undefined") {
    return [] as RecentSessionEntry[];
  }

  try {
    return readRecentSessionsFromStorage();
  } catch {
    return [];
  }
}

export function persistRecentSessions(jobs: AnalysisJob[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const merged = mergeRecentSessions(loadRecentSessions(), jobs);
    writeRecentSessions(merged);
  } catch {}
}

export function clearPersistedRecentSessions() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
    LEGACY_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
    return true;
  } catch {
    return false;
  }
}
