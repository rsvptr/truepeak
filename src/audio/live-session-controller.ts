// Same-tab coordination for live-session persistence.
//
// The controller is intentionally independent of React: a failed operation
// retains its own bounded retry state, so it does not rely on a later jobs
// render/effect to happen to retry. All store attempts share one serial queue.
// A Clear Session request advances the generation immediately; older writes
// either finish before the queued clear or are rejected by the clear tombstone.
import type { AnalysisJob } from "@/types/audio";
import type {
  LiveSessionMutationOutcome,
  LiveSessionReadOutcome,
  LiveSessionStore,
  LiveSessionStoreProblem,
  LiveSessionStoreProblemStatus,
} from "@/audio/live-session-store";

export type LiveSessionControllerOperation = "read" | "write" | "delete" | "clear";

export interface LiveSessionGenerationToken {
  readonly generation: number;
}

export interface LiveSessionSupersededOutcome {
  operation: LiveSessionControllerOperation;
  status: "superseded";
  message: string;
}

export type LiveSessionControllerStoreOutcome =
  | LiveSessionReadOutcome
  | LiveSessionMutationOutcome
  | LiveSessionStoreProblem<LiveSessionControllerOperation>;

export type LiveSessionControllerOutcome =
  | LiveSessionControllerStoreOutcome
  | LiveSessionSupersededOutcome;

export interface LiveSessionControllerResult {
  outcome: LiveSessionControllerOutcome;
  /** Actual store attempts. Superseded commands can settle with zero. */
  attempts: number;
  generation: number;
  /** Items displaced by a newer save/delete intent in the same generation. */
  supersededItemIds: string[];
  /** True only when a retryable fault consumed the configured attempt budget. */
  retryExhausted: boolean;
}

export interface LiveSessionControllerEvent {
  operation: LiveSessionControllerOperation;
  status: LiveSessionControllerOutcome["status"];
  attempts: number;
  generation: number;
  retryExhausted: boolean;
  message?: string;
}

export interface LiveSessionControllerSnapshot {
  generation: number;
  pendingCommands: number;
  waitingRetries: number;
  lastEvent: LiveSessionControllerEvent | null;
}

export interface LiveSessionControllerOptions {
  /** Includes the initial attempt. Values are clamped to 1..10. */
  maxAttempts?: number;
  /** Delay before attempt N+1; the final value repeats if needed. */
  retryDelaysMs?: readonly number[];
  /** Defaults to blocked/failed. Unavailable is normally not transient. */
  retryStatuses?: readonly LiveSessionStoreProblemStatus[];
  /** Injectable for deterministic tests; defaults to setTimeout. */
  wait?: (delayMs: number) => Promise<void>;
}

type ControllerListener = () => void;
type ExecutableOutcome = LiveSessionReadOutcome | LiveSessionMutationOutcome;
interface AttemptExecution {
  outcome: ExecutableOutcome | null;
  storeAttempted: boolean;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;
const DEFAULT_RETRY_STATUSES = new Set<LiveSessionStoreProblemStatus>([
  "blocked",
  "failed",
]);

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}

function clampAttemptCount(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_RETRY_DELAYS_MS.length + 1;
  }
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

function normalizeDelays(delays: readonly number[] | undefined): number[] {
  const source = delays?.length ? delays : DEFAULT_RETRY_DELAYS_MS;
  return source.map((delay) =>
    Number.isFinite(delay) ? Math.max(0, Math.trunc(delay)) : 0,
  );
}

function uniqueNonEmptyIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

export class LiveSessionController {
  private readonly store: LiveSessionStore;
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly retryStatuses: ReadonlySet<LiveSessionStoreProblemStatus>;
  private readonly wait: (delayMs: number) => Promise<void>;

  private generation = 0;
  private sequence = 0;
  private queueTail: Promise<void> = Promise.resolve();
  // New-generation reads/writes wait here while a clear is retrying. Without
  // this barrier, a write could commit between clear attempts and then be
  // erased by the successful retry even though the caller saw "committed".
  private clearBarrier: Promise<void> = Promise.resolve();
  private readonly latestIntentById = new Map<string, number>();
  private readonly listeners = new Set<ControllerListener>();
  private pendingCommands = 0;
  private waitingRetries = 0;
  private lastEvent: LiveSessionControllerEvent | null = null;
  private snapshot: LiveSessionControllerSnapshot = {
    generation: 0,
    pendingCommands: 0,
    waitingRetries: 0,
    lastEvent: null,
  };

  constructor(store: LiveSessionStore, options: LiveSessionControllerOptions = {}) {
    this.store = store;
    this.maxAttempts = clampAttemptCount(options.maxAttempts);
    this.retryDelaysMs = normalizeDelays(options.retryDelaysMs);
    this.retryStatuses = options.retryStatuses
      ? new Set(options.retryStatuses)
      : DEFAULT_RETRY_STATUSES;
    this.wait = options.wait ?? defaultWait;
  }

  captureGeneration(): LiveSessionGenerationToken {
    return { generation: this.generation };
  }

  getSnapshot = (): LiveSessionControllerSnapshot => this.snapshot;

  subscribe = (listener: ControllerListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // Tokens are required rather than captured implicitly: the caller must tie a
  // persistence command to the generation of the state snapshot that produced
  // it. Otherwise a delayed callback could capture a fresh token after clear
  // and incorrectly make stale work look current.
  read(token: LiveSessionGenerationToken): Promise<LiveSessionControllerResult> {
    const generation = token.generation;
    return this.afterClearBarrier(() =>
      this.runCommand({
        operation: "read",
        generation,
        attempt: () => this.store.read(),
      }),
    );
  }

  write(
    jobs: AnalysisJob[],
    token: LiveSessionGenerationToken,
  ): Promise<LiveSessionControllerResult> {
    const generation = token.generation;
    const completedById = new Map<string, AnalysisJob>();
    jobs.forEach((job) => {
      if (job.result && job.id) {
        completedById.set(job.id, job);
      }
    });

    const completedJobs = [...completedById.values()];
    const itemIds = completedJobs.map((job) => job.id);
    const sequence = ++this.sequence;

    if (generation === this.generation) {
      itemIds.forEach((jobId) => this.latestIntentById.set(jobId, sequence));
    }

    const supersededIds = new Set<string>();
    return this.afterClearBarrier(() =>
      this.runCommand({
        operation: "write",
        generation,
        getSupersededItemIds: () => [...supersededIds],
        attempt: async () => {
          const activeJobs = completedJobs.filter((job) => {
            const active = this.latestIntentById.get(job.id) === sequence;
            if (!active) supersededIds.add(job.id);
            return active;
          });

          if (completedJobs.length > 0 && activeJobs.length === 0) {
            return null;
          }
          return this.store.write(activeJobs);
        },
        cleanup: () => {
          itemIds.forEach((jobId) => {
            if (this.latestIntentById.get(jobId) === sequence) {
              this.latestIntentById.delete(jobId);
            }
          });
        },
      }),
    );
  }

  delete(
    jobIds: string[],
    token: LiveSessionGenerationToken,
  ): Promise<LiveSessionControllerResult> {
    const generation = token.generation;
    const uniqueJobIds = uniqueNonEmptyIds(jobIds);
    const sequence = ++this.sequence;

    if (generation === this.generation) {
      uniqueJobIds.forEach((jobId) => this.latestIntentById.set(jobId, sequence));
    }

    const supersededIds = new Set<string>();
    return this.afterClearBarrier(() =>
      this.runCommand({
        operation: "delete",
        generation,
        getSupersededItemIds: () => [...supersededIds],
        attempt: async () => {
          const activeIds = uniqueJobIds.filter((jobId) => {
            const active = this.latestIntentById.get(jobId) === sequence;
            if (!active) supersededIds.add(jobId);
            return active;
          });

          if (uniqueJobIds.length > 0 && activeIds.length === 0) {
            return null;
          }
          return this.store.delete(activeIds);
        },
        cleanup: () => {
          uniqueJobIds.forEach((jobId) => {
            if (this.latestIntentById.get(jobId) === sequence) {
              this.latestIntentById.delete(jobId);
            }
          });
        },
      }),
    );
  }

  clear(): Promise<LiveSessionControllerResult> {
    // This is the clear tombstone. It advances before entering the serial
    // queue, so an in-flight old write is followed by this clear and a delayed
    // old retry cannot enter the store afterward.
    this.generation += 1;
    const generation = this.generation;
    this.latestIntentById.clear();
    this.publishSnapshot();

    const command = this.runCommand({
      operation: "clear",
      generation,
      attempt: async () => {
        const outcome = await this.store.clear();
        if (outcome.status !== "empty") {
          return outcome;
        }

        // A clear is never a no-op success: only transaction completion proves
        // the destructive operation committed.
        return {
          operation: "clear",
          status: "failed",
          message: "IndexedDB clear did not confirm a committed transaction.",
        };
      },
    });
    this.clearBarrier = command.then(
      () => undefined,
      () => undefined,
    );
    return command;
  }

  private afterClearBarrier(
    start: () => Promise<LiveSessionControllerResult>,
  ): Promise<LiveSessionControllerResult> {
    const barrier = this.clearBarrier;
    return barrier.then(start, start);
  }

  private enqueue<Outcome>(task: () => Promise<Outcome>): Promise<Outcome> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private retryDelay(attempts: number): number {
    const index = Math.min(Math.max(0, attempts - 1), this.retryDelaysMs.length - 1);
    return this.retryDelaysMs[index] ?? 0;
  }

  private isRetryable(outcome: ExecutableOutcome): boolean {
    return (
      (outcome.status === "unavailable" ||
        outcome.status === "blocked" ||
        outcome.status === "failed") &&
      this.retryStatuses.has(outcome.status)
    );
  }

  private async runCommand({
    operation,
    generation,
    attempt,
    cleanup,
    getSupersededItemIds = () => [],
  }: {
    operation: LiveSessionControllerOperation;
    generation: number;
    attempt: () => Promise<ExecutableOutcome | null>;
    cleanup?: () => void;
    getSupersededItemIds?: () => string[];
  }): Promise<LiveSessionControllerResult> {
    this.pendingCommands += 1;
    this.publishSnapshot();

    let attempts = 0;
    let result: LiveSessionControllerResult | null = null;

    try {
      while (!result) {
        const execution = await this.enqueue(async (): Promise<AttemptExecution> => {
          if (generation !== this.generation) {
            return { outcome: null, storeAttempted: false };
          }

          try {
            const attempted = await attempt();
            if (attempted === null) {
              return { outcome: null, storeAttempted: false };
            }
            if (attempted && attempted.operation !== operation) {
              return {
                outcome: {
                  operation,
                  status: "failed",
                  message: `Persistence adapter returned ${attempted.operation} for ${operation}.`,
                } as LiveSessionStoreProblem<LiveSessionControllerOperation>,
                storeAttempted: true,
              };
            }

            // Clear may have advanced the generation while the store attempt
            // was in flight. The queued clear will remove any write that just
            // committed; never let the old command schedule a later retry.
            return {
              outcome: generation === this.generation ? attempted : null,
              storeAttempted: true,
            };
          } catch (error) {
            return {
              outcome: {
                operation,
                status: "failed",
                message: errorMessage(error, `Persistence ${operation} failed.`),
              } as LiveSessionStoreProblem<LiveSessionControllerOperation>,
              storeAttempted: true,
            };
          }
        });

        if (execution.storeAttempted) {
          attempts += 1;
        }
        const outcome = execution.outcome;
        if (outcome === null) {
          result = {
            outcome: {
              operation,
              status: "superseded",
              message: "Persistence command was superseded by a newer intent or clear.",
            },
            attempts,
            generation,
            supersededItemIds: getSupersededItemIds(),
            retryExhausted: false,
          };
          break;
        }

        const retryable = this.isRetryable(outcome);
        if (!retryable || attempts >= this.maxAttempts) {
          result = {
            outcome,
            attempts,
            generation,
            supersededItemIds: getSupersededItemIds(),
            retryExhausted: retryable && attempts >= this.maxAttempts,
          };
          break;
        }

        this.waitingRetries += 1;
        this.publishSnapshot();
        try {
          await this.wait(this.retryDelay(attempts));
        } catch (error) {
          result = {
            outcome: {
              operation,
              status: "failed",
              message: errorMessage(error, `Persistence ${operation} retry scheduling failed.`),
            },
            attempts,
            generation,
            supersededItemIds: getSupersededItemIds(),
            retryExhausted: true,
          };
        } finally {
          this.waitingRetries -= 1;
          this.publishSnapshot();
        }
      }
    } finally {
      cleanup?.();
      this.pendingCommands -= 1;

      if (result) {
        const message = "message" in result.outcome ? result.outcome.message : undefined;
        this.lastEvent = {
          operation: result.outcome.operation,
          status: result.outcome.status,
          attempts: result.attempts,
          generation: result.generation,
          retryExhausted: result.retryExhausted,
          ...(message ? { message } : {}),
        };
      }
      this.publishSnapshot();
    }

    // The loop settles a result unless an unexpected exception escaped the
    // injected wait/adapter guards. Keep a defensive failed outcome for that
    // impossible-by-contract edge so callers never receive undefined.
    return (
      result ?? {
        outcome: {
          operation,
          status: "failed",
          message: `Persistence ${operation} ended without an outcome.`,
        },
        attempts,
        generation,
        supersededItemIds: getSupersededItemIds(),
        retryExhausted: true,
      }
    );
  }

  private publishSnapshot(): void {
    this.snapshot = {
      generation: this.generation,
      pendingCommands: this.pendingCommands,
      waitingRetries: this.waitingRetries,
      lastEvent: this.lastEvent,
    };

    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // Persistence must not fail because a UI observer threw.
      }
    });
  }
}

export function createLiveSessionController(
  store: LiveSessionStore,
  options?: LiveSessionControllerOptions,
): LiveSessionController {
  return new LiveSessionController(store, options);
}
