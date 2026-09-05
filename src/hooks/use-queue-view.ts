"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  countQueueJobs,
  deriveBatchProgress,
  deriveSessionStats,
  queueJobMatchesView,
  sortQueueJobs,
} from "@/lib/session-selectors";
import type { QueueFilter, QueueSort, WorkspaceTab } from "@/lib/workspace-route";
import type { AnalysisJob, AnalysisMode, TargetPreset } from "@/types/audio";

export interface UseQueueViewOptions {
  activeTarget: TargetPreset;
  activeWorkspaceTab: WorkspaceTab;
  analysisMode: AnalysisMode;
  completedJobs: AnalysisJob[];
  deferredSearchQuery: string;
  jobs: AnalysisJob[];
  parallelLimit: number;
  queueFilter: QueueFilter;
  queueSearchDraft: string;
  queueSort: QueueSort;
  selectedJobId: string | null;
}

export function useQueueView({
  activeTarget,
  activeWorkspaceTab,
  analysisMode,
  completedJobs,
  deferredSearchQuery,
  jobs,
  parallelLimit,
  queueFilter,
  queueSearchDraft,
  queueSort,
  selectedJobId,
}: UseQueueViewOptions) {
  const filteredJobs = useMemo(
    () => jobs.filter((job) => queueJobMatchesView(job, queueFilter, deferredSearchQuery)),
    [deferredSearchQuery, jobs, queueFilter],
  );
  const sortedQueueJobs = useMemo(
    () => [...filteredJobs].sort((left, right) => sortQueueJobs(left, right, queueSort)),
    [filteredJobs, queueSort],
  );
  const sortedQueueJobsRef = useRef(sortedQueueJobs);
  useEffect(() => {
    sortedQueueJobsRef.current = sortedQueueJobs;
  }, [sortedQueueJobs]);

  const resolvedSelectedJobId =
    selectedJobId && jobs.some((job) => job.id === selectedJobId)
      ? selectedJobId
      : sortedQueueJobs[0]?.id ?? jobs[0]?.id ?? null;
  const routeSelectedJob = useMemo(
    () => selectedJobId ? jobs.find((job) => job.id === selectedJobId) ?? null : null,
    [jobs, selectedJobId],
  );
  const visibleSelectedJob = useMemo(
    () => sortedQueueJobs.find((job) => job.id === routeSelectedJob?.id) ?? null,
    [routeSelectedJob?.id, sortedQueueJobs],
  );
  const selectedJob = useMemo(() => {
    if (activeWorkspaceTab === "queue") {
      return routeSelectedJob ?? sortedQueueJobs[0] ?? null;
    }
    return routeSelectedJob ?? completedJobs[0] ?? jobs[0] ?? null;
  }, [activeWorkspaceTab, completedJobs, jobs, routeSelectedJob, sortedQueueJobs]);
  const selectedJobHiddenByFilter =
    activeWorkspaceTab === "queue" && !!routeSelectedJob && !visibleSelectedJob;
  const sessionStats = useMemo(
    () => deriveSessionStats(completedJobs, activeTarget, analysisMode),
    [activeTarget, analysisMode, completedJobs],
  );
  const queueCounts = useMemo(() => countQueueJobs(jobs), [jobs]);
  const batchProgress = useMemo(
    () => deriveBatchProgress(jobs, parallelLimit),
    [jobs, parallelLimit],
  );
  const queueViewIsFiltered =
    queueSearchDraft.trim().length > 0 || queueFilter !== "all" || queueSort !== "recent";
  const visibleQueueCount = sortedQueueJobs.length;

  return {
    batchProgress,
    complianceCounts: sessionStats.complianceCounts,
    currentModeLabel: analysisMode === "targeted" ? activeTarget.label : "Measure Only",
    finishedCount: queueCounts.complete + queueCounts.issues,
    hottestTruePeak: sessionStats.hottestPeakJob?.result?.metrics.truePeakDbtp ?? null,
    queueAverage: sessionStats.averageIntegrated,
    queueCounts,
    queueShownLabel: queueViewIsFiltered
      ? `${visibleQueueCount} of ${jobs.length} shown`
      : `${visibleQueueCount} shown`,
    queueViewIsFiltered,
    resolvedSelectedJobId,
    selectedJob,
    selectedJobHiddenByFilter,
    sessionStats,
    sessionTabCounts: {
      queue: jobs.length,
      compare: completedJobs.length,
      insights: completedJobs.length,
    } satisfies Record<WorkspaceTab, number>,
    sortedQueueJobs,
    sortedQueueJobsRef,
    targetingEnabled: analysisMode === "targeted",
    visibleQueueCount,
  };
}
