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
 * Stable identity for a completed result, used to keep imports idempotent
 * against everything already in the session. The lineage id is the job id the
 * analysis was first given: a local or restored row's own id, or the
 * sourceJobId an import carries forward (parseSessionFile sets it from the
 * exported id and keeps it across re-exports). So importing a session into a
 * workspace that holds the same rows, live, restored, or imported from any
 * earlier copy of the file, matches them. Lineage alone is not an audio
 * identity: a malformed or hand-edited portable file can repeat a sourceJobId
 * for different rows, so the key folds in the measured fingerprint too and
 * never collapses distinct results that merely share lineage or a file name.
 * Returns null when a job has no result or no lineage.
 */
export function sessionResultKey(job: AnalysisJob): string | null {
  const provenance = job.provenance;
  const result = job.result;
  const lineageId =
    provenance?.kind === "unverified-import" ? provenance.sourceJobId : job.id;
  if (!lineageId || !result) {
    return null;
  }

  return JSON.stringify([
    lineageId,
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

/**
 * Recovery rows that are not already in the workspace. A row is already there
 * when its id is (a remount), or when its result matches by sessionResultKey:
 * a session opened before the restore landed already holds imported copies of
 * the same analyses under fresh ids. Matching rows within the batch collapse
 * too, so a store that holds both an original and its imported copy restores
 * one row.
 */
export function freshRestoredJobs(existing: AnalysisJob[], restored: AnalysisJob[]) {
  const ids = new Set(existing.map((job) => job.id));
  const seen = new Set(
    existing.map(sessionResultKey).filter((key): key is string => key != null),
  );
  return restored.filter((job) => {
    if (ids.has(job.id)) {
      return false;
    }
    const key = sessionResultKey(job);
    if (key == null) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
      .map(sessionResultKey)
      .filter((key): key is string => key != null),
  );
  const fresh = incoming.filter((job) => {
    const key = sessionResultKey(job);
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
