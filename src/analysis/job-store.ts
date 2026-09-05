import type { AnalysisJob } from "@/types/audio";

type JobStoreListener = () => void;
type JobStoreUpdate =
  | AnalysisJob[]
  | ((current: AnalysisJob[]) => AnalysisJob[]);

/**
 * Synchronous external store for the active analysis queue. Scheduler commands
 * can update it and immediately observe the new snapshot without maintaining a
 * second mutable copy alongside React state.
 */
export class JobStore {
  private snapshot: AnalysisJob[];
  private readonly listeners = new Set<JobStoreListener>();

  constructor(initialJobs: AnalysisJob[] = []) {
    this.snapshot = initialJobs;
  }

  readonly getSnapshot = () => this.snapshot;

  readonly subscribe = (listener: JobStoreListener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly set = (update: JobStoreUpdate) => {
    const next = typeof update === "function" ? update(this.snapshot) : update;
    if (Object.is(next, this.snapshot)) {
      return this.snapshot;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
    return next;
  };
}
