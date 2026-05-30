import { countComplianceStates, getComplianceSummary } from "@/audio/compliance";
import type { AnalysisJob } from "@/types/audio";

export interface CompletedAnalysisJob extends AnalysisJob {
  result: NonNullable<AnalysisJob["result"]>;
}

export function isActiveJob(job: AnalysisJob) {
  return ["queued", "reading", "decoding", "analyzing"].includes(job.status);
}

export function isIssueJob(job: AnalysisJob) {
  return ["failed", "canceled"].includes(job.status);
}

export function getCompletedAnalysisJobs(jobs: AnalysisJob[]) {
  return jobs.filter((job): job is CompletedAnalysisJob => job.result != null);
}

export function countQueueJobs(jobs: AnalysisJob[]) {
  return {
    all: jobs.length,
    active: jobs.filter(isActiveJob).length,
    complete: jobs.filter((job) => job.status === "complete").length,
    issues: jobs.filter(isIssueJob).length,
  };
}

export function averageIntegratedLufs(jobs: AnalysisJob[]) {
  const values = jobs
    .map((job) => job.result?.metrics.integratedLufs)
    .filter((value): value is number => value != null);

  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function highestTruePeakDbtp(jobs: AnalysisJob[]) {
  const values = jobs
    .map((job) => job.result?.metrics.truePeakDbtp)
    .filter((value): value is number => value != null);

  if (!values.length) {
    return null;
  }

  return Math.max(...values);
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

export function getQuietestJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(jobs, (job) => job.result.metrics.integratedLufs, "asc")[0] ?? null;
}

export function getLoudestJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(jobs, (job) => job.result.metrics.integratedLufs)[0] ?? null;
}

export function getHottestPeakJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(jobs, (job) => job.result.metrics.truePeakDbtp)[0] ?? null;
}

export function getWidestRangeJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(jobs, (job) => job.result.metrics.loudnessRange)[0] ?? null;
}

export function getLongestJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(jobs, (job) => job.result.metadata.durationSeconds)[0] ?? null;
}

export function getHighestProjectedPeakJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(
    jobs,
    (job) => job.result.metrics.projectedTruePeakDbtp ?? Number.NEGATIVE_INFINITY,
  )[0] ?? null;
}

export function getLargestMoveJob(jobs: CompletedAnalysisJob[]) {
  return sortByMetric(jobs, (job) => Math.abs(job.result.metrics.targetDeltaDb ?? 0))[0] ?? null;
}

export function getClosestToTargetJob(jobs: CompletedAnalysisJob[], targetLufs: number | null) {
  if (targetLufs == null) {
    return null;
  }

  return [...jobs].sort(
    (left, right) =>
      Math.abs(left.result.metrics.integratedLufs - targetLufs) -
      Math.abs(right.result.metrics.integratedLufs - targetLufs),
  )[0] ?? null;
}

export function getSessionSampleRates(jobs: CompletedAnalysisJob[]) {
  return [...new Set(jobs.map((job) => job.result.metadata.sampleRate))].sort((a, b) => a - b);
}

export function getSessionChannelLayouts(jobs: CompletedAnalysisJob[]) {
  return [...new Set(jobs.map((job) => job.result.metadata.channelLayout.name))];
}

export function getTargetedFocusJobs(jobs: CompletedAnalysisJob[]) {
  const ceilingLimitedJobs = jobs.filter(
    (job) => getComplianceSummary(job.result)?.state === "ceiling-limited",
  );
  const attentionJobs = getAttentionJobs(jobs);
  const belowTargetJobs = jobs.filter(
    (job) => getComplianceSummary(job.result)?.state === "below-target",
  );
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
