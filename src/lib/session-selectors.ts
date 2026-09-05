import { countComplianceStates, getComplianceSummary } from "@/audio/compliance";
import { resolveAnalysisProvenance } from "@/audio/session-file";
import type { AnalysisJob, AnalysisMode, TargetPreset } from "@/types/audio";
import type { QueueFilter, QueueSort } from "@/lib/workspace-route";

export interface CompletedAnalysisJob extends AnalysisJob {
  result: NonNullable<AnalysisJob["result"]>;
}

/** Sort finite metrics while keeping unavailable values unranked at the end. */
export function compareOptionalMetric(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: "asc" | "desc",
) {
  const leftValid = left != null && Number.isFinite(left);
  const rightValid = right != null && Number.isFinite(right);
  if (!leftValid || !rightValid) {
    if (leftValid === rightValid) {
      return 0;
    }
    return leftValid ? -1 : 1;
  }

  const delta = left! - right!;
  return direction === "asc" ? delta : -delta;
}

// These run inside memos and render bodies on every progress tick, so they are
// written as single passes over the queue instead of chained filter/map/sort
// copies. Sets keep the status checks allocation-free.
const ACTIVE_STATUSES = new Set<AnalysisJob["status"]>([
  "queued",
  "reading",
  "decoding",
  "analyzing",
]);
const ISSUE_STATUSES = new Set<AnalysisJob["status"]>(["failed", "canceled"]);
const queueCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const ANALYSIS_PAUSED_LABEL = "Paused: analysis stopped";

export function isPausedAnalysisJob(job: AnalysisJob) {
  return job.status === "queued" && job.progressLabel === ANALYSIS_PAUSED_LABEL;
}

export function isActiveJob(job: AnalysisJob) {
  return ACTIVE_STATUSES.has(job.status) && !isPausedAnalysisJob(job);
}

export function isIssueJob(job: AnalysisJob) {
  return ISSUE_STATUSES.has(job.status);
}

export function isUnverifiedAnalysisJob(job: AnalysisJob) {
  return resolveAnalysisProvenance(job).kind === "unverified-import";
}

function queueStatusRank(status: AnalysisJob["status"]) {
  switch (status) {
    case "analyzing":
      return 0;
    case "decoding":
      return 1;
    case "reading":
      return 2;
    case "queued":
      return 3;
    case "complete":
      return 4;
    case "failed":
      return 5;
    case "canceled":
    default:
      return 6;
  }
}

export function sortQueueJobs(left: AnalysisJob, right: AnalysisJob, queueSort: QueueSort) {
  switch (queueSort) {
    case "oldest":
      return left.createdAt.localeCompare(right.createdAt);
    case "status": {
      const statusDelta = queueStatusRank(left.status) - queueStatusRank(right.status);
      return statusDelta || right.createdAt.localeCompare(left.createdAt);
    }
    case "integrated": {
      const leftValue = left.result?.metrics.integratedValid === false
        ? undefined
        : left.result?.metrics.integratedLufs;
      const rightValue = right.result?.metrics.integratedValid === false
        ? undefined
        : right.result?.metrics.integratedLufs;
      return compareOptionalMetric(leftValue, rightValue, "desc") ||
        right.createdAt.localeCompare(left.createdAt);
    }
    case "truePeak":
      return compareOptionalMetric(
        left.result?.metrics.truePeakDbtp,
        right.result?.metrics.truePeakDbtp,
        "desc",
      ) || right.createdAt.localeCompare(left.createdAt);
    case "name":
      return queueCollator.compare(left.fileName, right.fileName);
    case "recent":
    default:
      return right.createdAt.localeCompare(left.createdAt);
  }
}

export function buildQueueSearchHaystack(job: AnalysisJob) {
  return [
    job.fileName,
    job.status,
    job.result?.metadata.decoderLabel ?? "",
    job.result?.metadata.channelLayout.name ?? "",
    job.result?.target?.label ?? "",
    job.result ? getComplianceSummary(job.result)?.label ?? "" : "",
  ].join("\n").toLowerCase();
}

export function queueJobMatchesView(
  job: AnalysisJob,
  queueFilter: QueueFilter,
  normalizedSearchQuery: string,
) {
  const matchesFilter =
    queueFilter === "all" ||
    (queueFilter === "active" && isActiveJob(job)) ||
    (queueFilter === "complete" && job.status === "complete") ||
    (queueFilter === "issues" && isIssueJob(job));
  return matchesFilter && (
    !normalizedSearchQuery || buildQueueSearchHaystack(job).includes(normalizedSearchQuery)
  );
}

export interface BatchProgress {
  etaSeconds: number | null;
  finished: number;
  percent: number;
  total: number;
}

export function deriveBatchProgress(
  jobs: readonly AnalysisJob[],
  parallelLimit: number,
): BatchProgress | null {
  if (!jobs.length) {
    return null;
  }

  const activeJobs = jobs.filter(isActiveJob);
  if (!activeJobs.length) {
    return null;
  }

  const finished = jobs.length - activeJobs.length;
  const inFlightProgress = activeJobs.reduce(
    (sum, job) => sum + Math.min(Math.max(job.progressPercent, 0), 1),
    0,
  );
  const durations = jobs
    .filter((job) => job.status === "complete" && job.startedAtMs != null && job.finishedAtMs != null)
    .map((job) => job.finishedAtMs! - job.startedAtMs!)
    .sort((left, right) => left - right);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const lanes = Math.max(1, parallelLimit);

  return {
    etaSeconds: median != null
      ? Math.max(1, Math.round((Math.ceil(activeJobs.length / lanes) * median) / 1000))
      : null,
    finished,
    percent: ((finished + inFlightProgress) / jobs.length) * 100,
    total: jobs.length,
  };
}

export function getCompletedAnalysisJobs(jobs: AnalysisJob[]) {
  return jobs.filter((job): job is CompletedAnalysisJob => job.result != null);
}

export function hasValidIntegratedMeasurement(job: AnalysisJob) {
  return job.result != null && job.result.metrics.integratedValid !== false;
}

function hasValidLoudnessRange(job: AnalysisJob) {
  return job.result != null && job.result.metrics.loudnessRangeValid !== false;
}

export function countQueueJobs(jobs: AnalysisJob[]) {
  let active = 0;
  let complete = 0;
  let issues = 0;
  for (const job of jobs) {
    if (isActiveJob(job)) {
      active += 1;
    } else if (job.status === "complete") {
      complete += 1;
    } else if (isIssueJob(job)) {
      issues += 1;
    }
  }

  return { all: jobs.length, active, complete, issues };
}

export function averageIntegratedLufs(jobs: AnalysisJob[]) {
  let sum = 0;
  let count = 0;
  for (const job of jobs) {
    const value = job.result?.metrics.integratedLufs;
    if (value != null && job.result?.metrics.integratedValid !== false) {
      sum += value;
      count += 1;
    }
  }

  return count ? sum / count : null;
}

export function getAttentionJobs(jobs: CompletedAnalysisJob[]) {
  return jobs.filter((job) => {
    if (job.result.metrics.integratedValid === false) {
      return true;
    }
    const compliance = getComplianceSummary(job.result);
    return compliance != null && compliance.state !== "on-target";
  });
}

function getComplianceCounts(jobs: CompletedAnalysisJob[]) {
  return countComplianceStates(jobs);
}

function getDecoderMix(jobs: CompletedAnalysisJob[]) {
  const buckets = new Map<string, number>();

  jobs.forEach((job) => {
    const decoderLabel = job.result.metadata.decoderLabel;
    buckets.set(decoderLabel, (buckets.get(decoderLabel) ?? 0) + 1);
  });

  return [...buckets.entries()].sort((left, right) => right[1] - left[1]);
}

function sortByMetric<T>(items: T[], getValue: (item: T) => number, direction: "asc" | "desc" = "desc") {
  return [...items].sort((left, right) => {
    const delta = getValue(left) - getValue(right);
    return direction === "asc" ? delta : -delta;
  });
}

// Finding one extreme does not need a full sort. Strict comparison keeps the
// first job among ties, which is what a stable sort's [0] returned before.
function pickExtreme<T>(items: T[], getValue: (item: T) => number, direction: "asc" | "desc" = "desc") {
  let best: T | null = null;
  let bestValue = 0;
  for (const item of items) {
    const value = getValue(item);
    if (best == null || (direction === "asc" ? value < bestValue : value > bestValue)) {
      best = item;
      bestValue = value;
    }
  }

  return best;
}

export function getQuietestJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(
    jobs.filter(hasValidIntegratedMeasurement),
    (job) => job.result.metrics.integratedLufs,
    "asc",
  );
}

export function getLoudestJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(
    jobs.filter(hasValidIntegratedMeasurement),
    (job) => job.result.metrics.integratedLufs,
  );
}

function getHottestPeakJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => job.result.metrics.truePeakDbtp);
}

export function getWidestRangeJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(
    jobs.filter(hasValidLoudnessRange),
    (job) => job.result.metrics.loudnessRange,
  );
}

function getLongestJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => job.result.metadata.durationSeconds);
}

export function getHighestProjectedPeakJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(
    jobs.filter(
      (job) =>
        job.result.metrics.integratedValid !== false &&
        job.result.metrics.projectedTruePeakDbtp != null,
    ),
    (job) => job.result.metrics.projectedTruePeakDbtp!,
  );
}

export function getLargestMoveJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(
    jobs.filter(
      (job) =>
        job.result.metrics.integratedValid !== false &&
        job.result.metrics.targetDeltaDb != null,
    ),
    (job) => Math.abs(job.result.metrics.targetDeltaDb!),
  );
}

function getClosestToTargetJob(jobs: CompletedAnalysisJob[], targetLufs: number | null) {
  if (targetLufs == null) {
    return null;
  }

  return pickExtreme(
    jobs.filter(hasValidIntegratedMeasurement),
    (job) => Math.abs(job.result.metrics.integratedLufs - targetLufs),
    "asc",
  );
}

function getSessionSampleRates(jobs: CompletedAnalysisJob[]) {
  return [...new Set(jobs.map((job) => job.result.metadata.sampleRate))].sort((a, b) => a - b);
}

function getSessionChannelLayouts(jobs: CompletedAnalysisJob[]) {
  return [...new Set(jobs.map((job) => job.result.metadata.channelLayout.name))];
}

export function getTargetedFocusJobs(jobs: CompletedAnalysisJob[]) {
  // One compliance computation per job; the dedupe pass preserves the original
  // priority order (invalid, ceiling-limited, remaining attention, then below).
  const invalidJobs: CompletedAnalysisJob[] = [];
  const ceilingLimitedJobs: CompletedAnalysisJob[] = [];
  const attentionJobs: CompletedAnalysisJob[] = [];
  const belowTargetJobs: CompletedAnalysisJob[] = [];
  for (const job of jobs) {
    if (job.result.metrics.integratedValid === false) {
      invalidJobs.push(job);
      continue;
    }
    const state = getComplianceSummary(job.result)?.state;
    if (state === "ceiling-limited") {
      ceilingLimitedJobs.push(job);
      attentionJobs.push(job);
    } else if (state === "above-target") {
      attentionJobs.push(job);
    } else if (state === "below-target") {
      belowTargetJobs.push(job);
    }
  }

  const seen = new Set<string>();

  return [
    ...invalidJobs,
    ...ceilingLimitedJobs,
    ...attentionJobs,
    ...belowTargetJobs,
  ].filter((job) => {
    if (seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
}

function getMeasureOnlyFocusJobs(jobs: CompletedAnalysisJob[]) {
  const seen = new Set<string>();
  const ordered = [
    ...sortByMetric(jobs, (job) => job.result.metrics.truePeakDbtp),
    ...sortByMetric(
      jobs.filter(hasValidLoudnessRange),
      (job) => job.result.metrics.loudnessRange,
    ),
    ...sortByMetric(
      jobs.filter(hasValidIntegratedMeasurement),
      (job) => job.result.metrics.integratedLufs,
    ),
  ];

  return ordered.filter((job) => {
    if (seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

export function deriveSessionStats(
  jobs: AnalysisJob[],
  currentTarget: TargetPreset | null,
  analysisMode: AnalysisMode,
) {
  const readyJobs = getCompletedAnalysisJobs(jobs);
  const quietestJob = getQuietestJob(readyJobs);
  const hottestPeakJob = getHottestPeakJob(readyJobs);
  const widestRangeJob = getWidestRangeJob(readyJobs);
  const longestJob = getLongestJob(readyJobs);
  const largestMoveJob = getLargestMoveJob(readyJobs);
  const attentionJobs = getAttentionJobs(readyJobs);
  const complianceCounts = getComplianceCounts(readyJobs);

  return {
    attentionJobs,
    averageIntegrated: averageIntegratedLufs(readyJobs),
    averageMove: average(
      readyJobs
        .map((job) => job.result.metrics.targetDeltaDb)
        .filter((value): value is number => value != null),
    ),
    averagePeak: average(readyJobs.map((job) => job.result.metrics.truePeakDbtp)),
    ceilingLimitedJobs: readyJobs.filter(
      (job) => getComplianceSummary(job.result)?.state === "ceiling-limited",
    ),
    channelLayouts: getSessionChannelLayouts(readyJobs),
    closestToTargetJob: getClosestToTargetJob(
      readyJobs,
      analysisMode === "targeted" && currentTarget
        ? currentTarget.loudnessTargetLufs
        : null,
    ),
    complianceCounts,
    decoderMix: getDecoderMix(readyJobs),
    highestProjectedPeak: getHighestProjectedPeakJob(readyJobs),
    hottestPeakJob,
    invalidIntegratedCount: readyJobs.filter(
      (job) => job.result.metrics.integratedValid === false,
    ).length,
    largestMoveJob,
    longestJob,
    loudestJob: getLoudestJob(readyJobs),
    measureOnlyFocusJobs: getMeasureOnlyFocusJobs(readyJobs).slice(0, 4),
    quietestJob,
    readyJobs,
    sampleRates: getSessionSampleRates(readyJobs),
    targetedFocusJobs: getTargetedFocusJobs(readyJobs).slice(0, 4),
    unverifiedCount: readyJobs.filter(isUnverifiedAnalysisJob).length,
    widestRangeJob,
  };
}

export type SessionStats = ReturnType<typeof deriveSessionStats>;
