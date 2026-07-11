import { countComplianceStates, getComplianceSummary } from "@/audio/compliance";
import type { AnalysisJob } from "@/types/audio";

export interface CompletedAnalysisJob extends AnalysisJob {
  result: NonNullable<AnalysisJob["result"]>;
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

export function isActiveJob(job: AnalysisJob) {
  return ACTIVE_STATUSES.has(job.status);
}

export function isIssueJob(job: AnalysisJob) {
  return ISSUE_STATUSES.has(job.status);
}

export function getCompletedAnalysisJobs(jobs: AnalysisJob[]) {
  return jobs.filter((job): job is CompletedAnalysisJob => job.result != null);
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
    if (value != null) {
      sum += value;
      count += 1;
    }
  }

  return count ? sum / count : null;
}

export function highestTruePeakDbtp(jobs: AnalysisJob[]) {
  let max: number | null = null;
  for (const job of jobs) {
    const value = job.result?.metrics.truePeakDbtp;
    if (value != null && (max == null || value > max)) {
      max = value;
    }
  }

  return max;
}

export function getAttentionJobs(jobs: CompletedAnalysisJob[]) {
  return jobs.filter((job) => {
    const compliance = getComplianceSummary(job.result);
    return compliance?.state === "above-target" || compliance?.state === "ceiling-limited";
  });
}

export function getComplianceCounts(jobs: CompletedAnalysisJob[]) {
  return countComplianceStates(jobs);
}

export function getDecoderMix(jobs: CompletedAnalysisJob[]) {
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
  return pickExtreme(jobs, (job) => job.result.metrics.integratedLufs, "asc");
}

export function getLoudestJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => job.result.metrics.integratedLufs);
}

export function getHottestPeakJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => job.result.metrics.truePeakDbtp);
}

export function getWidestRangeJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => job.result.metrics.loudnessRange);
}

export function getLongestJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => job.result.metadata.durationSeconds);
}

export function getHighestProjectedPeakJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(
    jobs,
    (job) => job.result.metrics.projectedTruePeakDbtp ?? Number.NEGATIVE_INFINITY,
  );
}

export function getLargestMoveJob(jobs: CompletedAnalysisJob[]) {
  return pickExtreme(jobs, (job) => Math.abs(job.result.metrics.targetDeltaDb ?? 0));
}

export function getClosestToTargetJob(jobs: CompletedAnalysisJob[], targetLufs: number | null) {
  if (targetLufs == null) {
    return null;
  }

  return pickExtreme(jobs, (job) => Math.abs(job.result.metrics.integratedLufs - targetLufs), "asc");
}

export function getSessionSampleRates(jobs: CompletedAnalysisJob[]) {
  return [...new Set(jobs.map((job) => job.result.metadata.sampleRate))].sort((a, b) => a - b);
}

export function getSessionChannelLayouts(jobs: CompletedAnalysisJob[]) {
  return [...new Set(jobs.map((job) => job.result.metadata.channelLayout.name))];
}

export function getTargetedFocusJobs(jobs: CompletedAnalysisJob[]) {
  // One compliance computation per job; the dedupe pass preserves the original
  // priority order (ceiling-limited, then remaining attention, then below).
  const ceilingLimitedJobs: CompletedAnalysisJob[] = [];
  const attentionJobs: CompletedAnalysisJob[] = [];
  const belowTargetJobs: CompletedAnalysisJob[] = [];
  for (const job of jobs) {
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

  return [...ceilingLimitedJobs, ...attentionJobs, ...belowTargetJobs].filter((job) => {
    if (seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
}

export function getMeasureOnlyFocusJobs(jobs: CompletedAnalysisJob[]) {
  const seen = new Set<string>();
  const ordered = [
    ...sortByMetric(jobs, (job) => job.result.metrics.truePeakDbtp),
    ...sortByMetric(jobs, (job) => job.result.metrics.loudnessRange),
    ...sortByMetric(jobs, (job) => job.result.metrics.integratedLufs),
  ];

  return ordered.filter((job) => {
    if (seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
}
