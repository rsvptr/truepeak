import { DEFAULT_TARGET_PRESET } from "@/audio/presets";
import { planSessionIntake } from "@/audio/session-file";
import { retargetAnalysisResult } from "@/audio/targeting";
import type { AnalysisJob, AnalysisMode, TargetPreset } from "@/types/audio";

export interface SessionReconciliationSettings {
  analysisBlocked: boolean;
  analysisMode: AnalysisMode;
  target: TargetPreset | null;
}

/**
 * Applies the active workspace semantics to view-only session results. Restore
 * and import deliberately share this path so they cannot drift into opposite
 * target/mode behavior.
 */
export function reconcileSessionJobs(
  jobs: AnalysisJob[],
  settings: SessionReconciliationSettings,
) {
  // During an invalid input draft the workbench still displays its last valid
  // target. Reconcile view-only results to that same target; `analysisBlocked`
  // prevents new analysis but must not create contradictory restored metrics.
  const target =
    settings.analysisMode === "targeted"
      ? settings.target ?? DEFAULT_TARGET_PRESET
      : null;

  return jobs.map((job) =>
    job.result
      ? { ...job, result: retargetAnalysisResult(job.result, target) }
      : job,
  );
}

/**
 * Stable identity for an imported result, used to keep repeated imports of the
 * same measured row idempotent. Lineage alone is not an audio identity: a
 * malformed or hand-edited portable file can repeat a sourceJobId for different
 * rows, so the key folds in the measured fingerprint too and never collapses
 * distinct results that merely share lineage. Returns null for jobs that are
 * not unverified imports (local and restored jobs are never deduplicated here).
 */
export function importedProvenanceKey(job: AnalysisJob): string | null {
  const provenance = job.provenance;
  const result = job.result;
  if (
    provenance?.kind !== "unverified-import" ||
    !provenance.sourceSessionDigest ||
    !provenance.sourceJobId ||
    !result
  ) {
    return null;
  }

  return JSON.stringify([
    provenance.sourceSessionDigest,
    provenance.sourceJobId,
    job.fileName,
    result.analyzedAt,
    result.metadata.frameCount,
    result.metadata.sampleRate,
    result.metadata.channelCount,
    result.metrics.integratedLufs,
    result.metrics.truePeakDbtp,
    result.metrics.loudnessRange,
  ]);
}

export interface ImportMergePlan {
  /** New jobs to prepend, deduplicated against `current` and capped to the limit. */
  toAdd: AnalysisJob[];
  /** How many jobs will be added (same as `toAdd.length`). */
  added: number;
  /** Imported jobs skipped because an equivalent result is already present. */
  skippedDuplicates: number;
  /** Imported jobs turned away because the session is at MAX_SESSION_JOBS. */
  skippedOverCap: number;
}

/**
 * Merges freshly imported (already reconciled) jobs into the current session
 * under the SAME global cap as file intake. Import and file drop must not drift:
 * both are bounded by planSessionIntake against everything already present, so a
 * portable import can never push a full session past MAX_SESSION_JOBS. Duplicate
 * imports (matching provenance and audio fingerprint) are dropped idempotently
 * first, then whatever remains is capped to the room left in the session.
 */
export function mergeImportedJobs(
  current: AnalysisJob[],
  incoming: AnalysisJob[],
): ImportMergePlan {
  const seen = new Set(
    current
      .map(importedProvenanceKey)
      .filter((key): key is string => key != null),
  );
  const fresh = incoming.filter((job) => {
    const key = importedProvenanceKey(job);
    if (key == null || !seen.has(key)) {
      if (key != null) {
        seen.add(key);
      }
      return true;
    }
    return false;
  });
  const skippedDuplicates = incoming.length - fresh.length;
  const { accepted } = planSessionIntake(current.length, fresh.length);
  const toAdd = fresh.slice(0, accepted);
  return {
    toAdd,
    added: toAdd.length,
    skippedDuplicates,
    skippedOverCap: fresh.length - toAdd.length,
  };
}
