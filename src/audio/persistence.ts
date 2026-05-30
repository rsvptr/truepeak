import { getComplianceSummary } from "@/audio/compliance";
import type { AnalysisJob, RecentSessionEntry } from "@/types/audio";

const STORAGE_KEY = "truepeak-recent-sessions";
const LEGACY_STORAGE_KEYS = ["lufs-pro-recent-sessions"];
const MAX_RECENT = 20;

function sortRecentSessions(entries: RecentSessionEntry[]) {
  return [...entries].sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
}

function keyForEntry(entry: RecentSessionEntry) {
  return `${entry.id}:${entry.analyzedAt}`;
}

function isRecentSessionEntry(value: unknown): value is RecentSessionEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<RecentSessionEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.fileName === "string" &&
    typeof entry.analyzedAt === "string" &&
    (entry.analysisMode === "targeted" || entry.analysisMode === "measure-only") &&
    (typeof entry.targetLabel === "string" || entry.targetLabel == null) &&
    typeof entry.integratedLufs === "number" &&
    Number.isFinite(entry.integratedLufs) &&
    typeof entry.truePeakDbtp === "number" &&
    Number.isFinite(entry.truePeakDbtp) &&
    typeof entry.loudnessRange === "number" &&
    Number.isFinite(entry.loudnessRange) &&
    typeof entry.sampleRate === "number" &&
    Number.isFinite(entry.sampleRate) &&
    typeof entry.channelLayoutName === "string" &&
    typeof entry.decoderLabel === "string" &&
    (typeof entry.complianceLabel === "string" || entry.complianceLabel == null)
  );
}

function normalizeRecentSessionEntries(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as RecentSessionEntry[];
  }

  return value.filter(isRecentSessionEntry);
}

function completedJobsToEntries(jobs: AnalysisJob[]) {
  return jobs
    .filter((job) => job.result)
    .map((job) => {
      const result = job.result!;
      const compliance = getComplianceSummary(result);
      return {
        id: job.id,
        fileName: job.fileName,
        analyzedAt: result.analyzedAt,
        analysisMode: result.analysisMode,
        targetLabel: result.target?.label ?? null,
        integratedLufs: result.metrics.integratedLufs,
        truePeakDbtp: result.metrics.truePeakDbtp,
        loudnessRange: result.metrics.loudnessRange,
        sampleRate: result.metadata.sampleRate,
        channelLayoutName: result.metadata.channelLayout.name,
        decoderLabel: result.metadata.decoderLabel,
        complianceLabel: compliance?.label ?? null,
      } satisfies RecentSessionEntry;
    });
}

function writeRecentSessions(entries: RecentSessionEntry[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    LEGACY_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
  } catch {}
}

function readRecentSessionsFromStorage() {
  const current = window.localStorage.getItem(STORAGE_KEY);
  if (current) {
    return normalizeRecentSessionEntries(JSON.parse(current));
  }

  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy) {
      const parsed = normalizeRecentSessionEntries(JSON.parse(legacy));
      writeRecentSessions(parsed);
      return parsed;
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
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY);
    LEGACY_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
  } catch {}
}
