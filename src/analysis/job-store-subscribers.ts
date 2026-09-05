import type { JobStore } from "@/analysis/job-store";
import type { MutableCell } from "@/analysis/scheduler-types";
import type {
  LiveSessionController,
  LiveSessionGenerationToken,
} from "@/session/live-session-controller";
import type { AnalysisJob } from "@/types/audio";

export interface LiveSessionSubscriptionOptions {
  allowSaves: boolean;
  controller: LiveSessionController;
  persistedResults: MutableCell<Map<string, string>>;
  persistenceGeneration: MutableCell<LiveSessionGenerationToken>;
  persistenceFailureEpoch: MutableCell<number>;
  describeFailure: (
    result: Awaited<ReturnType<LiveSessionController["write"]>>,
    action: "save" | "delete",
  ) => string | null;
  setIssue: (message: string | null) => void;
}

function subscribeAndRun(store: JobStore, listener: () => void) {
  const unsubscribe = store.subscribe(listener);
  listener();
  return unsubscribe;
}

export function subscribePendingAnalysisCount(
  store: JobStore,
  previousCount: MutableCell<number | null>,
  countPending: (jobs: readonly AnalysisJob[]) => number,
  writeCount: (count: number) => void,
) {
  return subscribeAndRun(store, () => {
    const pendingCount = countPending(store.getSnapshot());
    if (previousCount.current === pendingCount) {
      return;
    }
    previousCount.current = pendingCount;
    writeCount(pendingCount);
  });
}

export function subscribeLiveSessionPersistence(
  store: JobStore,
  options: LiveSessionSubscriptionOptions,
) {
  const {
    allowSaves,
    controller,
    persistedResults,
    persistenceGeneration,
    persistenceFailureEpoch,
    describeFailure,
    setIssue,
  } = options;

  return subscribeAndRun(store, () => {
    const currentById = new Map<string, AnalysisJob>();
    for (const job of store.getSnapshot()) {
      if (job.result) {
        currentById.set(job.id, job);
      }
    }

    const toSave: AnalysisJob[] = [];
    currentById.forEach((job, jobId) => {
      if (persistedResults.current.get(jobId) !== job.result!.analyzedAt) {
        toSave.push(job);
      }
    });

    const toDelete: string[] = [];
    persistedResults.current.forEach((_, jobId) => {
      if (!currentById.has(jobId)) {
        toDelete.push(jobId);
      }
    });

    if (!toSave.length && !toDelete.length) {
      return;
    }

    const persistenceToken = persistenceGeneration.current;
    const issueEpoch = persistenceFailureEpoch.current;
    if (allowSaves && toSave.length) {
      toSave.forEach((job) => {
        persistedResults.current.set(job.id, job.result!.analyzedAt);
      });
      void controller.write(toSave, persistenceToken).then((result) => {
        const failure = describeFailure(result, "save");
        if (!failure) {
          if (
            result.outcome.status !== "superseded" &&
            persistenceFailureEpoch.current === issueEpoch
          ) {
            setIssue(null);
          }
          return;
        }

        persistenceFailureEpoch.current += 1;
        setIssue(failure);
        toSave.forEach((job) => {
          if (persistedResults.current.get(job.id) === job.result!.analyzedAt) {
            persistedResults.current.delete(job.id);
          }
        });
      }).catch((error: unknown) => {
        persistenceFailureEpoch.current += 1;
        setIssue(
          `TruePeak could not save the recovery copy. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`,
        );
        toSave.forEach((job) => {
          if (persistedResults.current.get(job.id) === job.result!.analyzedAt) {
            persistedResults.current.delete(job.id);
          }
        });
      });
    }

    if (toDelete.length) {
      const previousMarks = new Map(
        toDelete.map((jobId) => [jobId, persistedResults.current.get(jobId)]),
      );
      toDelete.forEach((jobId) => persistedResults.current.delete(jobId));
      void controller.delete(toDelete, persistenceToken).then((result) => {
        const failure = describeFailure(result, "delete");
        if (!failure) {
          if (
            result.outcome.status !== "superseded" &&
            persistenceFailureEpoch.current === issueEpoch
          ) {
            setIssue(null);
          }
          return;
        }

        persistenceFailureEpoch.current += 1;
        setIssue(failure);
        previousMarks.forEach((analyzedAt, jobId) => {
          if (analyzedAt != null && !persistedResults.current.has(jobId)) {
            persistedResults.current.set(jobId, analyzedAt);
          }
        });
      }).catch((error: unknown) => {
        persistenceFailureEpoch.current += 1;
        setIssue(
          `TruePeak could not update the recovery copy. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`,
        );
        previousMarks.forEach((analyzedAt, jobId) => {
          if (analyzedAt != null && !persistedResults.current.has(jobId)) {
            persistedResults.current.set(jobId, analyzedAt);
          }
        });
      });
    }
  });
}

export interface HistorySubscriptionOptions {
  enabled: boolean;
  fingerprint: MutableCell<string>;
  buildFingerprint: (jobs: AnalysisJob[]) => string;
  persist: (jobs: AnalysisJob[]) => void;
  refresh: () => void;
}

export function subscribeRecentSessionHistory(
  store: JobStore,
  options: HistorySubscriptionOptions,
) {
  let completedSnapshot: AnalysisJob[] = [];
  return subscribeAndRun(store, () => {
    if (!options.enabled) {
      options.fingerprint.current = "";
      completedSnapshot = [];
      return;
    }

    const completed = store.getSnapshot().filter((job) => job.result);
    const unchanged =
      completed.length === completedSnapshot.length &&
      completed.every((job, index) => job === completedSnapshot[index]);
    if (unchanged) {
      return;
    }
    completedSnapshot = completed;

    const fingerprint = options.buildFingerprint(completed);
    if (!fingerprint) {
      options.fingerprint.current = "";
      return;
    }
    if (fingerprint === options.fingerprint.current) {
      return;
    }

    options.fingerprint.current = fingerprint;
    options.persist(completed);
    options.refresh();
  });
}
