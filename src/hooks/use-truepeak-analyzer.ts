"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { JobStore } from "@/analysis/job-store";
import {
  subscribeLiveSessionPersistence,
  subscribePendingAnalysisCount,
  subscribeRecentSessionHistory,
} from "@/analysis/job-store-subscribers";
import {
  AnalysisScheduler,
  MAX_LANE_FAILURE_STREAK,
  recordLaneTransportFault,
  subscribeLaneAdmission,
} from "@/analysis/analysis-scheduler";
import { LaneReservations } from "@/analysis/lane-reservations";
import {
  ANALYSIS_PROGRESS_BASE,
  runAnalysisJob,
} from "@/analysis/run-analysis-job";
import type {
  AnalyzerSettings,
  DecodedWorkerResult,
  JobResourcePlan,
  LaneLease,
  WorkerLane,
} from "@/analysis/scheduler-types";
import { getComplianceSummary } from "@/audio/compliance";
import { shouldPreferBrowserDecoder } from "@/audio/browser-decode";
import {
  DecodeResourceError,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  checkedResourceByteSum,
  conservativeDecodePeakBytes,
  declaredDecodeCorroboratedByFileSize,
  decodePeakResidentBytes,
  decodeFailureDetails,
  decodeFailureSummary,
  inspectAudioContainer,
  planProbedDecodeFootprint,
  resolveAdaptiveDecodeBudget,
  resolveDecodeBudget,
  validatePlanarChannels,
  type DecodeBudget,
  type DecodeFailureCode,
  type DecodeProbeMetadata,
} from "@/audio/decode-budget";
import {
  createCountingSemaphore,
  type CountingSemaphore,
} from "@/audio/decode-window";
import {
  buildCsvExport,
  buildJsonExport,
  buildMarkdownExport,
  getExportFileName,
} from "@/audio/export";
import {
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_JOBS,
  buildSessionFile,
  getSessionFileName,
  planSessionIntake,
} from "@/audio/session-file";
import {
  indexedDbLiveSessionStore,
} from "@/session/live-session-store";
import {
  createLiveSessionController,
  type LiveSessionControllerResult,
} from "@/session/live-session-controller";
import {
  clearPersistedRecentSessions,
  loadRecentSessions,
  persistRecentSessions,
} from "@/session/persistence";
import { DEFAULT_TARGET_PRESET } from "@/audio/presets";
import { mergeImportedJobs, reconcileSessionJobs } from "@/audio/session-reconciliation";
import { retargetAnalysisResult } from "@/audio/targeting";
import { buildRecoveryNotice, composeJobError } from "@/lib/job-ui";
import {
  ANALYSIS_PAUSED_LABEL,
  getCompletedAnalysisJobs,
  isActiveJob,
  isIssueJob,
} from "@/lib/session-selectors";
import { downloadTextFile, makeId } from "@/lib/utils";
import { fileIdentityKey } from "@/lib/file-identity";
import type { ParallelLanesPreference } from "@/lib/workspace-preferences";
import type {
  AnalysisJob,
  AnalysisMode,
  DecodePreference,
  DecodedAudioTransfer,
  RecentSessionEntry,
  TargetPreset,
} from "@/types/audio";
import type {
  AnalyzerRequest,
  AnalyzerResponse,
  DecoderRequest,
  DecoderResponse,
  DecodeResourceUsage,
} from "@/workers/shared/messages";
import type { SessionImportWorkerResponse } from "@/workers/session-import.worker";

interface PendingResolver<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  lease: LaneLease;
  workerEpoch: number;
}

interface ProbeLease {
  readonly jobId: string;
  readonly generation: number;
  readonly planGeneration: number;
  readonly file: File;
}

interface ProbePendingResolver {
  resolve: (metadata: DecodeProbeMetadata) => void;
  reject: (reason?: unknown) => void;
  lease: ProbeLease;
  workerEpoch: number;
  timeoutId: number;
}

interface ProbeWorkerState {
  worker: Worker | null;
  workerEpoch: number;
  leaseGeneration: number;
  lease: ProbeLease | null;
}


class WorkerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTransportError";
  }
}

const WORKER_CIRCUIT_MESSAGE =
  "Analysis is paused because the browser could not keep its local workers running. Retry analysis. If it fails again, reload the page.";

// One shape for a cancelled row, applied both to job store (synchronously) and
// through setJobs, so the two can never describe the row differently.
function markJobCanceled(job: AnalysisJob): AnalysisJob {
  return {
    ...job,
    status: "canceled",
    progressPercent: 1,
    progressLabel: "Canceled",
    error: undefined,
  };
}

const PROGRESS_COMMIT_INTERVAL_MS = 100;

interface PendingProgressUpdate {
  jobId: string;
  runToken: number;
  status: AnalysisJob["status"];
  progressPercent: number;
  progressLabel: string;
}

// Tear idle lanes down after this long with nothing active. Workers (and any
// lazily loaded ffmpeg.wasm heaps inside them) are not free to keep around,
// especially on phones; fresh lanes spin up in milliseconds when needed.
const IDLE_LANE_TEARDOWN_MS = 45_000;

const SESSION_IMPORT_TIMEOUT_MS = 45_000;
const PROBE_RESPONSE_TIMEOUT_MS = 18_000;
const PENDING_ANALYSIS_COUNT_KEY = "truepeak-pending-analysis-count-v1";

function readPendingAnalysisCount() {
  try {
    const count = Number.parseInt(window.localStorage.getItem(PENDING_ANALYSIS_COUNT_KEY) ?? "0", 10);
    return Number.isSafeInteger(count) && count > 0 && count <= MAX_SESSION_JOBS
      ? count
      : 0;
  } catch {
    return 0;
  }
}

function writePendingAnalysisCount(count: number) {
  try {
    if (count > 0) {
      window.localStorage.setItem(PENDING_ANALYSIS_COUNT_KEY, String(count));
    } else {
      window.localStorage.removeItem(PENDING_ANALYSIS_COUNT_KEY);
    }
  } catch {
    // This counter only explains work lost after a mobile tab discard. The
    // completed-result recovery path remains authoritative when storage fails.
  }
}

function countPendingAnalysisJobs(jobs: readonly AnalysisJob[]) {
  return jobs.reduce(
    (count, job) =>
      job.status === "queued" ||
      job.status === "reading" ||
      job.status === "decoding" ||
      job.status === "analyzing"
        ? count + 1
        : count,
    0,
  );
}

function importSessionInWorker(file: File) {
  return new Promise<Extract<SessionImportWorkerResponse, { type: "result" }>>(
    (resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(
          new URL("../workers/session-import.worker.ts", import.meta.url),
          { type: "module" },
        );
      } catch (error) {
        reject(
          new Error(
            error instanceof Error
              ? `Session import worker could not start: ${error.message}`
              : "Session import worker could not start.",
          ),
        );
        return;
      }

      let settled = false;
      const finish = (
        callback: () => void,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        worker.terminate();
        callback();
      };
      const timeoutId = window.setTimeout(() => {
        finish(() => reject(new Error("Session validation timed out.")));
      }, SESSION_IMPORT_TIMEOUT_MS);

      worker.onerror = (event) => {
        event.preventDefault();
        finish(() =>
          reject(
            new Error(
              event.message
                ? `Session import worker failed: ${event.message}`
                : "Session import worker failed.",
            ),
          ),
        );
      };
      worker.onmessageerror = () => {
        finish(() => reject(new Error("Session import worker returned an unreadable result.")));
      };
      worker.onmessage = (event: MessageEvent<SessionImportWorkerResponse>) => {
        const message = event.data;
        if (message.type === "error") {
          finish(() => reject(new Error(message.error)));
          return;
        }
        finish(() => resolve(message));
      };

      try {
        worker.postMessage({ type: "import-session", file });
      } catch (error) {
        finish(() =>
          reject(
            new Error(
              error instanceof Error
                ? `Could not send the session file for validation: ${error.message}`
                : "Could not send the session file for validation.",
            ),
          ),
        );
      }
    },
  );
}

function deviceMemoryGb() {
  if (typeof navigator === "undefined") {
    return null;
  }

  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === "number" && Number.isFinite(memory) ? memory : null;
}

function isCoarsePointerDevice() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

// Each active job occupies roughly one core at a time (decode, then analyze),
// plus the main thread stays responsive for the UI. Half the reported cores,
// capped by what the device's memory supports, parallelizes well on desktops.
// Low-memory and touch-first devices are capped harder: their constraint is
// RAM, not cores. Machines that report 8 GB+ (Chrome caps the report at 8)
// and plenty of cores get up to 6 lanes.
export function resolveLaneLimit(preference: ParallelLanesPreference = "auto") {
  if (preference !== "auto") {
    return Math.min(4, Math.max(1, Number.parseInt(preference, 10) || 1));
  }

  if (typeof navigator === "undefined") {
    return 1;
  }

  const cores = navigator.hardwareConcurrency || 4;
  const memory = deviceMemoryGb();
  const maxLanes = memory != null && memory >= 8 ? 6 : 4;
  let limit = Math.min(maxLanes, Math.max(1, Math.floor(cores / 2)));

  if (memory != null) {
    if (memory <= 2) {
      limit = 1;
    } else if (memory <= 4) {
      limit = Math.min(limit, 2);
    }
  } else if (isCoarsePointerDevice()) {
    // No memory signal (Safari/Firefox): assume a phone/tablet is RAM-bound.
    limit = Math.min(limit, 2);
  }

  return limit;
}

// Files at or above this size run alone: peak memory while decoding/analyzing
// is dominated by one file's PCM, so a multi-lane batch of very large masters
// can't multiply that peak and take the tab down. Constrained devices use a
// much lower bar — a 100 MB decode is already a big slice of a phone's budget.
export function resolveHeavyFileBytes() {
  const memory = deviceMemoryGb();
  const constrained = memory != null ? memory <= 4 : isCoarsePointerDevice();
  return (constrained ? 96 : 256) * 1024 * 1024;
}

export function resolveAggregatePeakBytes(budget: DecodeBudget) {
  const memory = deviceMemoryGb();
  const canHoldTwoPeakRoutes =
    memory != null ? memory >= 8 : !isCoarsePointerDevice();
  const singleRoutePeak = conservativeDecodePeakBytes(budget);
  return canHoldTwoPeakRoutes
    ? checkedResourceByteSum(
        [singleRoutePeak, singleRoutePeak],
        "Aggregate decode route capacity",
      )
    : singleRoutePeak;
}

export function resolveBrowserFirstRoute(
  preference: DecodePreference,
  fileName: string,
  mimeType: string,
  knownFootprint: boolean,
  trustedNative: boolean,
) {
  return (
    (!knownFootprint || !trustedNative) &&
    preference !== "compatibility-first" &&
    shouldPreferBrowserDecoder(fileName, mimeType)
  );
}

function workerFailure(reason: string) {
  return new WorkerTransportError(reason);
}

function cancellationFailure(reason: string) {
  return new DecodeResourceError("cancelled", reason);
}

export interface UseTruePeakAnalyzerOptions {
  allowCompatibilityDecoder?: boolean;
  analysisMode?: AnalysisMode;
  analysisBlocked?: boolean;
  decodePreference?: DecodePreference;
  persistHistory?: boolean;
  parallelPreference?: ParallelLanesPreference;
  restoreReady?: boolean;
  recoveryWritesAllowed?: boolean;
}


export function normalizeDecodeFailure(
  message: string,
  decodePreference: DecodePreference,
  failureCode?: DecodeFailureCode,
  budget?: DecodeBudget,
) {
  const lower = message.toLowerCase();

  if (lower.includes("data saver") && lower.includes("compatibility decoder")) {
    return message;
  }

  if (failureCode && failureCode !== "decode-failed") {
    return decodeFailureSummary(failureCode, budget);
  }

  if (
    lower.includes("decode failed") ||
    lower.includes("could not read this file") ||
    lower.includes("unable to decode") ||
    lower.includes("couldn't decode")
  ) {
    if (decodePreference === "browser-first") {
      return "TruePeak couldn't read this file with the browser decoder or the compatibility decoder. Try Compatibility First in Advanced Options, or convert the file to WAV or AIFF.";
    }

    if (decodePreference === "compatibility-first") {
      return "TruePeak couldn't read this file with the compatibility decoder. Try Browser First in Advanced Options, or convert the file to WAV or AIFF.";
    }

    return "TruePeak couldn't decode this file in the browser. Try Browser First or Compatibility First in Advanced Options, or convert the file to WAV or AIFF.";
  }

  // Analysis-stage failures: the file decoded, but the PCM it produced was empty,
  // corrupt, or non-finite (e.g. a truncated/garbage file that still passed decode).
  // Surface a plain, actionable message instead of the raw frame/channel diagnostic.
  if (
    lower.includes("non-finite sample") ||
    lower.includes("no decoded audio frames") ||
    lower.includes("invalid sample rate") ||
    lower.includes("energy overflowed")
  ) {
    return "TruePeak decoded this file but the audio data was empty or corrupt, so it couldn't be analyzed. Try re-exporting it or converting it to WAV or AIFF.";
  }

  if (failureCode) {
    return decodeFailureSummary(failureCode, budget);
  }

  return message;
}

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  "wav",
  "rf64",
  "aif",
  "aiff",
  "aifc",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "weba",
]);

// The file picker enforces `accept`, but drag-and-drop does not, so any dropped
// file (a folder, a .txt, an image) would otherwise become a job that only fails
// later at decode time. Filter intake centrally so both paths behave the same.
export function isSupportedAudioFile(file: File) {
  if (file.type.toLowerCase().startsWith("audio/")) {
    return true;
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_AUDIO_EXTENSIONS.has(extension);
}

export function completedHistoryFingerprint(jobs: AnalysisJob[]) {
  return jobs
    .filter((job) => job.result)
    .map((job) => {
      const result = job.result!;
      const target = result.target;
      const compliance = getComplianceSummary(result);
      return [
        job.id,
        job.fileName,
        result.analyzedAt,
        result.analysisMode,
        target?.label ?? "",
        target?.loudnessTargetLufs ?? "",
        target?.truePeakCeilingDbtp ?? "",
        target?.toleranceLufs ?? "",
        result.metrics.integratedLufs,
        result.metrics.integratedValid ?? "legacy",
        result.metrics.integratedInvalidReason ?? "",
        result.metrics.truePeakDbtp,
        result.metrics.loudnessRange,
        result.metrics.loudnessRangeUnstable ?? "legacy",
        result.metadata.sampleRate,
        result.metadata.channelLayout.name,
        result.metadata.decoderLabel,
        job.provenance?.kind ?? "legacy",
        job.provenance?.sourceSessionDigest ?? "",
        job.provenance?.sourceJobId ?? "",
        compliance?.label ?? "",
      ].join("");
    })
    .join("");
}

function describeWorkerFailure(label: string, event: ErrorEvent | MessageEvent) {
  if (event instanceof ErrorEvent && event.message) {
    return `${label} worker failed: ${event.message}`;
  }

  return `${label} worker could not process a message.`;
}

// Shared by runJob's failure handler and user-driven interruption paths so
// both classify the same reasons as cancellation rather than failure.
function isCancellationReason(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("cancel") || lower.includes("restarted") || lower.includes("removed");
}

function persistenceFailureMessage(
  result: LiveSessionControllerResult,
  action: "restore" | "save" | "delete" | "clear",
) {
  const { outcome } = result;
  if (
    outcome.status !== "unavailable" &&
    outcome.status !== "blocked" &&
    outcome.status !== "failed"
  ) {
    return null;
  }

  const actionLabel =
    action === "restore"
      ? "restore the previous session"
      : action === "save"
        ? "save the recovery copy"
        : action === "delete"
          ? "update the recovery copy"
          : "delete the recovery copy";
  const retryCopy = result.retryExhausted
    ? ` after ${result.attempts} attempts`
    : "";
  return `TruePeak could not ${actionLabel}${retryCopy}. ${outcome.message} Downloaded session files and report exports are unaffected.`;
}

export function useTruePeakAnalyzer(
  target: TargetPreset | null = DEFAULT_TARGET_PRESET,
  options: UseTruePeakAnalyzerOptions = {},
) {
  const analysisMode = options.analysisMode ?? "targeted";
  const analysisBlocked = options.analysisBlocked ?? false;
  const allowCompatibilityDecoder = options.allowCompatibilityDecoder ?? true;
  const decodePreference = options.decodePreference ?? "auto";
  const persistHistory = options.persistHistory ?? false;
  const parallelPreference = options.parallelPreference ?? "auto";
  const restoreReady = options.restoreReady ?? true;
  const recoveryWritesAllowed = options.recoveryWritesAllowed ?? true;
  const [jobStore] = useState(() => new JobStore());
  const jobs = useSyncExternalStore(
    jobStore.subscribe,
    jobStore.getSnapshot,
    jobStore.getSnapshot,
  );
  const setJobs = jobStore.set;
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [persistenceIssue, setPersistenceIssue] = useState<string | null>(null);
  const [workerCircuitIssue, setWorkerCircuitIssue] = useState<string | null>(null);
  const [liveSessionController] = useState(() =>
    createLiveSessionController(indexedDbLiveSessionStore),
  );
  // Resolved after mount (it consults navigator/matchMedia) so server and
  // first client render agree; the queue only starts on user action anyway.
  const [parallelLimit, setParallelLimit] = useState(1);

  const filesRef = useRef(new Map<string, File>());
  const fileSignaturesRef = useRef(new Map<string, string>());
  const jobRunTokensRef = useRef(new Map<string, number>());
  const pendingProgressRef = useRef(new Map<string, PendingProgressUpdate>());
  const progressCommitTimerRef = useRef<number | null>(null);
  const workspaceOpenRef = useRef(true);
  const lanesRef = useRef<WorkerLane[]>([]);
  const laneSequenceRef = useRef(0);
  const laneLimitRef = useRef(1);
  const heavyFileBytesRef = useRef(256 * 1024 * 1024);
  const decodeBudgetRef = useRef<DecodeBudget>(resolveDecodeBudget());
  const aggregatePeakBytesRef = useRef(
    conservativeDecodePeakBytes(resolveDecodeBudget()),
  );
  // Browser decodes keep a FIFO window so queued work cannot stampede into
  // decodeAudioData. Every browser-eligible source now has a probed footprint,
  // so aggregate byte reservations provide the memory bound and this window
  // follows the configured lane count. It starts at one for the server/client
  // initial render and is resized after device settings resolve.
  const browserDecodeWindowRef = useRef<CountingSemaphore>(
    createCountingSemaphore(1),
  );
  const reservedPeakBytesRef = useRef(0);
  const resourcePlansRef = useRef(new Map<string, JobResourcePlan>());
  const resourcePlanGenerationRef = useRef(new Map<string, number>());
  const probeWorkerRef = useRef<ProbeWorkerState>({
    worker: null,
    workerEpoch: 0,
    leaseGeneration: 0,
    lease: null,
  });
  const probePendingRef = useRef(new Map<string, ProbePendingResolver>());
  const probeQueueTailRef = useRef<Promise<void>>(Promise.resolve());
  const probeIdleTeardownRef = useRef<number | null>(null);
  // How many preflights are in flight right now. Maintained alongside the
  // "preparing" entries in resourcePlansRef so fillLanes can read the pool size
  // in O(1) instead of scanning the whole map once per unplanned job.
  const preparingPlanCountRef = useRef(0);
  const idleTeardownRef = useRef<number | null>(null);
  const laneByJobRef = useRef(new Map<string, WorkerLane>());
  const heavyJobActiveRef = useRef<string | null>(null);
  const decoderPendingRef = useRef(
    new Map<string, PendingResolver<DecodedWorkerResult>>(),
  );
  const analyzerPendingRef = useRef(
    new Map<string, PendingResolver<AnalysisJob["result"]>>(),
  );
  const historyFingerprintRef = useRef("");
  // id -> analyzedAt of results already written to the live-session store.
  const persistedResultsRef = useRef(new Map<string, string>());
  const didRestoreRef = useRef(false);
  // False until the live-session restore has settled (committed, empty, or
  // failed). Consumers that reconcile URL state against `jobs` must wait for it,
  // because `jobs` is empty on the first client commit and the restore is an
  // async IndexedDB round trip it can never win.
  const [restoreSettled, setRestoreSettled] = useState(false);
  // Bumped by clearSession so a restore still resolving from IndexedDB cannot
  // resurrect rows into a session the user just cleared.
  const restoreGenerationRef = useRef(0);
  const persistenceGenerationRef = useRef(
    liveSessionController.captureGeneration(),
  );
  const persistenceFailureEpochRef = useRef(0);
  const workerFaultRef = useRef<
    (
      lane: WorkerLane,
      workerEpoch: number,
      reason: string,
    ) => void
  >(() => undefined);
  const workerCircuitOpenRef = useRef(false);
  const workerCircuitRetryJobsRef = useRef(new Set<string>());
  const pendingAnalysisCountRef = useRef<number | null>(null);
  const fillLanesRef = useRef<() => void>(() => undefined);
  const settingsRef = useRef<AnalyzerSettings>({
    allowCompatibilityDecoder,
    analysisBlocked,
    analysisMode,
    decodePreference,
    target,
  });
  const noticeTimeoutRef = useRef<number | null>(null);
  // Keep the latest settings readable from lane callbacks without retriggering
  // them. Updated in an effect (never during render) so a discarded render
  // can't leak its values; this effect is declared before every effect that
  // reads the ref, so within a commit readers always see the fresh snapshot.
  useEffect(() => {
    settingsRef.current = {
      allowCompatibilityDecoder,
      analysisBlocked,
      analysisMode,
      decodePreference,
      target,
    };
  });

  const filteredCompletedJobs = useMemo(() => getCompletedAnalysisJobs(jobs), [jobs]);
  // Referential stability across pure progress ticks, without a render-phase ref
  // read (which the project's react-hooks/refs rule forbids). `jobs` is a
  // brand-new array on every tick from any active lane; handing a new
  // completedJobs array to Compare/Insights each time would force their
  // completedJobs-keyed memos to fully recompute even though no completed result
  // changed. Instead hold the last emitted completed list in state and swap it
  // only when the completed set actually differs by object identity — a real
  // completion, removal, or retarget (all immutable updates). On a pure progress
  // tick the filter yields the same completed objects, so the guard is false, no
  // state update is scheduled, and consumers keep the same reference. This is
  // React's blessed "adjust state during render" pattern (the setState is
  // guarded, so it cannot loop). (Finding [15].)
  const [stableCompletedJobs, setStableCompletedJobs] = useState(filteredCompletedJobs);
  const completedSetChanged =
    filteredCompletedJobs.length !== stableCompletedJobs.length ||
    filteredCompletedJobs.some((job, index) => job !== stableCompletedJobs[index]);
  if (completedSetChanged) {
    setStableCompletedJobs(filteredCompletedJobs);
  }
  const completedJobs = completedSetChanged ? filteredCompletedJobs : stableCompletedJobs;
  const hasActiveJobs = useMemo(() => jobs.some(isActiveJob), [jobs]);

  const pushNotice = useCallback((message: string | null) => {
    setNotice(message);
    if (noticeTimeoutRef.current) {
      window.clearTimeout(noticeTimeoutRef.current);
      noticeTimeoutRef.current = null;
    }

    if (message) {
      noticeTimeoutRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimeoutRef.current = null;
      }, 4200);
    }
  }, []);

  const updateJob = useCallback(
    (jobId: string, updater: (job: AnalysisJob) => AnalysisJob) => {
      pendingProgressRef.current.delete(jobId);
      setJobs((current) => {
        let changed = false;
        const next: AnalysisJob[] = current.map((job) => {
          if (job.id !== jobId) {
            return job;
          }

          const updated = updater(job);
          if (updated !== job) {
            changed = true;
          }
          return updated;
        });

        if (!changed) {
          return current;
        }
        return next;
      });
    },
    [setJobs],
  );

  const openWorkerCircuit = useCallback((jobId?: string) => {
    pendingProgressRef.current.clear();
    workerCircuitOpenRef.current = true;
    if (jobId) {
      workerCircuitRetryJobsRef.current.add(jobId);
    }
    setWorkerCircuitIssue(WORKER_CIRCUIT_MESSAGE);

    const pauseQueued = (current: AnalysisJob[]) => {
      let changed = false;
      const next = current.map((job) => {
        if (
          job.status !== "queued" ||
          job.progressLabel === ANALYSIS_PAUSED_LABEL
        ) {
          return job;
        }

        changed = true;
        return { ...job, progressLabel: ANALYSIS_PAUSED_LABEL };
      });

      if (!changed) {
        return current;
      }
      return next;
    };
    setJobs(pauseQueued);
  }, [setJobs]);

  const resumeWorkerCircuit = useCallback(() => {
    pendingProgressRef.current.clear();
    workerCircuitOpenRef.current = false;
    workerCircuitRetryJobsRef.current.clear();
    setWorkerCircuitIssue(null);

    const resumeQueued = (current: AnalysisJob[]) => {
      let changed = false;
      const next = current.map((job) => {
        if (
          job.status !== "queued" ||
          job.progressLabel !== ANALYSIS_PAUSED_LABEL
        ) {
          return job;
        }

        changed = true;
        return { ...job, progressLabel: "Queued" };
      });

      if (!changed) {
        return current;
      }
      return next;
    };
    setJobs(resumeQueued);
    // Resuming clears the circuit flag and the paused label without changing any
    // row's status, so the admission signature does not move. Scan explicitly.
    fillLanesRef.current();
  }, [setJobs]);

  const beginJobRun = useCallback((jobId: string) => {
    const nextToken = (jobRunTokensRef.current.get(jobId) ?? 0) + 1;
    jobRunTokensRef.current.set(jobId, nextToken);
    return nextToken;
  }, []);

  const invalidateJobRun = useCallback((jobId: string) => {
    jobRunTokensRef.current.set(jobId, (jobRunTokensRef.current.get(jobId) ?? 0) + 1);
  }, []);

  const isJobRunCurrent = useCallback((jobId: string, runToken: number) => {
    if (
      !workspaceOpenRef.current ||
      jobRunTokensRef.current.get(jobId) !== runToken
    ) {
      return false;
    }

    return jobStore.getSnapshot().some((job) => job.id === jobId && isActiveJob(job));
  }, [jobStore]);

  const updateJobIfRunCurrent = useCallback(
    (jobId: string, runToken: number, updater: (job: AnalysisJob) => AnalysisJob) => {
      if (jobRunTokensRef.current.get(jobId) !== runToken) {
        return;
      }

      // Explicit checkpoints supersede any older progress sample still
      // waiting for the next coalescing interval.
      pendingProgressRef.current.delete(jobId);
      setJobs((current) => {
        if (jobRunTokensRef.current.get(jobId) !== runToken) {
          return current;
        }

        let updated = false;
        const next: AnalysisJob[] = current.map((job) => {
          if (job.id !== jobId || !isActiveJob(job)) {
            return job;
          }

          updated = true;
          return updater(job);
        });

        if (!updated) {
          return current;
        }
        return next;
      });
    },
    [setJobs],
  );

  const dropJobResources = useCallback((jobId: string) => {
    pendingProgressRef.current.delete(jobId);
    filesRef.current.delete(jobId);
    fileSignaturesRef.current.delete(jobId);
    jobRunTokensRef.current.delete(jobId);
    resourcePlansRef.current.delete(jobId);
  }, []);

  const flushPendingProgress = useCallback(() => {
    progressCommitTimerRef.current = null;
    const pending = pendingProgressRef.current;
    if (!pending.size) {
      return;
    }
    pendingProgressRef.current = new Map();

    setJobs((current) => {
      let changed = false;
      const next = current.map((job) => {
        const update = pending.get(job.id);
        if (
          !update ||
          jobRunTokensRef.current.get(job.id) !== update.runToken ||
          !isActiveJob(job) ||
          job.status !== update.status
        ) {
          return job;
        }

        const progressPercent = Math.max(
          job.progressPercent,
          update.progressPercent,
        );
        if (
          job.progressLabel === update.progressLabel &&
          Math.abs(job.progressPercent - progressPercent) < 0.01
        ) {
          return job;
        }

        changed = true;
        return {
          ...job,
          progressPercent,
          progressLabel: update.progressLabel,
        };
      });

      if (!changed) {
        return current;
      }
      return next;
    });
  }, [setJobs]);

  // Workers can emit dozens of progress messages per file across several
  // lanes. Keep only the latest sample for each job and commit the whole batch
  // at most once per interval. Status transitions still use the immediate
  // updater above.
  const queueJobProgress = useCallback(
    (
      jobId: string,
      runToken: number,
      status: AnalysisJob["status"],
      progress: number,
      label: string,
    ) => {
      if (
        !workspaceOpenRef.current ||
        jobRunTokensRef.current.get(jobId) !== runToken
      ) {
        return;
      }

      const job = jobStore.getSnapshot().find((candidate) => candidate.id === jobId);
      if (!job || !isActiveJob(job) || job.status !== status) {
        return;
      }

      const queued = pendingProgressRef.current.get(jobId);
      const progressPercent = Math.max(
        job.progressPercent,
        queued?.progressPercent ?? 0,
        progress,
      );
      const currentLabel = queued?.progressLabel ?? job.progressLabel;
      const currentProgress = queued?.progressPercent ?? job.progressPercent;
      if (
        currentLabel === label &&
        Math.abs(currentProgress - progressPercent) < 0.01
      ) {
        return;
      }

      pendingProgressRef.current.set(jobId, {
        jobId,
        runToken,
        status,
        progressPercent,
        progressLabel: label,
      });
      if (progressCommitTimerRef.current == null) {
        progressCommitTimerRef.current = window.setTimeout(
          flushPendingProgress,
          PROGRESS_COMMIT_INTERVAL_MS,
        );
      }
    },
    [flushPendingProgress, jobStore],
  );

  const terminateLaneWorkers = useCallback((lane: WorkerLane) => {
    // Advance the epoch before terminating so an already-queued event from the
    // old pair cannot observe the replacement pair as current.
    lane.workerEpoch += 1;
    const decoder = lane.decoder;
    const analyzer = lane.analyzer;
    lane.decoder = null;
    lane.analyzer = null;
    decoder?.terminate();
    analyzer?.terminate();
  }, []);

  const rejectLanePending = useCallback((lane: WorkerLane, reason: unknown) => {
    const lease = lane.lease;
    if (!lease) {
      return;
    }

    const decoderPending = decoderPendingRef.current.get(lease.jobId);
    if (decoderPending?.lease === lease) {
      decoderPendingRef.current.delete(lease.jobId);
      decoderPending.reject(reason);
    }

    const analyzerPending = analyzerPendingRef.current.get(lease.jobId);
    if (analyzerPending?.lease === lease) {
      analyzerPendingRef.current.delete(lease.jobId);
      analyzerPending.reject(reason);
    }
  }, []);

  const attachLaneWorkers = useCallback((lane: WorkerLane) => {
    const workerEpoch = lane.workerEpoch + 1;
    lane.workerEpoch = workerEpoch;
    let decoderWorker: Worker | null = null;
    let analyzerWorker: Worker | null = null;

    try {
      decoderWorker = new Worker(
        new URL("../workers/decoder.worker.ts", import.meta.url),
        { type: "module" },
      );
      analyzerWorker = new Worker(
        new URL("../workers/analyzer.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      decoderWorker?.terminate();
      analyzerWorker?.terminate();
      lane.decoder = null;
      lane.analyzer = null;
      return workerFailure(
        error instanceof Error
          ? `Analysis workers could not start: ${error.message}`
          : "Analysis workers could not start.",
      );
    }

    decoderWorker.onerror = (event) => {
      event.preventDefault();
      workerFaultRef.current(
        lane,
        workerEpoch,
        describeWorkerFailure("Decoder", event),
      );
    };
    decoderWorker.onmessageerror = (event) => {
      workerFaultRef.current(
        lane,
        workerEpoch,
        describeWorkerFailure("Decoder", event),
      );
    };
    decoderWorker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      if (
        lane.workerEpoch !== workerEpoch ||
        lane.decoder !== decoderWorker
      ) {
        return;
      }

      const message = event.data;
      const pending = decoderPendingRef.current.get(message.jobId);
      if (
        !pending ||
        pending.workerEpoch !== workerEpoch ||
        pending.lease !== lane.lease
      ) {
        return;
      }

      if (message.type === "progress") {
        queueJobProgress(
          message.jobId,
          pending.lease.runToken,
          "decoding",
          message.progress,
          message.label,
        );
        return;
      }

      decoderPendingRef.current.delete(message.jobId);
      if (message.type === "decoded") {
        pending.resolve({ asset: message.asset, usage: message.usage });
        return;
      }

      if (message.type !== "error") {
        return;
      }

      pending.reject(
        new DecodeResourceError(
          message.code,
          message.error,
          message.retryable,
        ),
      );
    };

    analyzerWorker.onerror = (event) => {
      event.preventDefault();
      workerFaultRef.current(
        lane,
        workerEpoch,
        describeWorkerFailure("Analyzer", event),
      );
    };
    analyzerWorker.onmessageerror = (event) => {
      workerFaultRef.current(
        lane,
        workerEpoch,
        describeWorkerFailure("Analyzer", event),
      );
    };
    analyzerWorker.onmessage = (event: MessageEvent<AnalyzerResponse>) => {
      if (
        lane.workerEpoch !== workerEpoch ||
        lane.analyzer !== analyzerWorker
      ) {
        return;
      }

      const message = event.data;
      const pending = analyzerPendingRef.current.get(message.jobId);
      if (
        !pending ||
        pending.workerEpoch !== workerEpoch ||
        pending.lease !== lane.lease
      ) {
        return;
      }

      if (message.type === "progress") {
        // The analyzer reports its own 0..1 fraction; analysis occupies the
        // tail of the job's overall progress, after read+decode.
        const mapped = Math.min(
          0.99,
          ANALYSIS_PROGRESS_BASE +
            message.progress * (0.99 - ANALYSIS_PROGRESS_BASE),
        );
        queueJobProgress(
          message.jobId,
          pending.lease.runToken,
          "analyzing",
          mapped,
          message.label,
        );
        return;
      }

      analyzerPendingRef.current.delete(message.jobId);
      if (message.type === "result") {
        pending.resolve(message.result);
        return;
      }

      pending.reject(new Error(message.error));
    };

    lane.decoder = decoderWorker;
    lane.analyzer = analyzerWorker;
    return null;
  }, [queueJobProgress]);

  const workerFault = useCallback(
    (lane: WorkerLane, workerEpoch: number, reason: string) => {
      if (lane.workerEpoch !== workerEpoch) {
        return;
      }

      terminateLaneWorkers(lane);
      const circuitOpened = recordLaneTransportFault(lane);
      rejectLanePending(lane, workerFailure(reason));

      if (circuitOpened) {
        openWorkerCircuit(lane.lease?.jobId);
        if (!lane.lease) {
          const index = lanesRef.current.indexOf(lane);
          if (index >= 0) {
            lanesRef.current.splice(index, 1);
          }
        }
        return;
      }

      const attachError = attachLaneWorkers(lane);
      if (attachError) {
        lane.failureStreak += 1;
        if (lane.failureStreak >= MAX_LANE_FAILURE_STREAK) {
          lane.retireAfterRelease = true;
          openWorkerCircuit(lane.lease?.jobId);
          if (!lane.lease) {
            const index = lanesRef.current.indexOf(lane);
            if (index >= 0) {
              lanesRef.current.splice(index, 1);
            }
          }
        }
      }
    },
    [attachLaneWorkers, openWorkerCircuit, rejectLanePending, terminateLaneWorkers],
  );

  useEffect(() => {
    workerFaultRef.current = workerFault;
  }, [workerFault]);

  // User-driven interruption is deliberately different from a worker fault:
  // it aborts browser work and rejects worker work, but the immutable lease is
  // retained until runJob's finally block observes that all decode work drained.
  const interruptLane = useCallback(
    (lane: WorkerLane, reason = "Job canceled.") => {
      const lease = lane.lease;
      if (!lease) {
        return;
      }

      const cancellation = cancellationFailure(reason);
      if (!lease.browserAbortController.signal.aborted) {
        lease.browserAbortController.abort(cancellation);
      }
      try {
        lane.decoder?.postMessage({
          type: "cancel",
          jobId: lease.jobId,
        } satisfies DecoderRequest);
      } catch {
        // Termination below is the authoritative cancellation path.
      }
      terminateLaneWorkers(lane);
      rejectLanePending(lane, cancellation);
    },
    [rejectLanePending, terminateLaneWorkers],
  );

  // Terminate an idle lane and remove it. Mutates lanesRef's array in place so
  // the unmount cleanup (which captured the array) still sees every live lane.
  const disposeIdleLane = useCallback((lane: WorkerLane) => {
    if (lane.lease !== null) {
      return;
    }

    terminateLaneWorkers(lane);
    const index = lanesRef.current.indexOf(lane);
    if (index >= 0) {
      lanesRef.current.splice(index, 1);
    }
  }, [terminateLaneWorkers]);

  const clearIdleLaneTeardown = useCallback(() => {
    if (idleTeardownRef.current != null) {
      window.clearTimeout(idleTeardownRef.current);
      idleTeardownRef.current = null;
    }
  }, []);

  const scheduleIdleLaneTeardown = useCallback(() => {
    if (
      idleTeardownRef.current != null ||
      jobStore.getSnapshot().some(isActiveJob) ||
      !lanesRef.current.length
    ) {
      return;
    }

    idleTeardownRef.current = window.setTimeout(() => {
      idleTeardownRef.current = null;
      if (jobStore.getSnapshot().some(isActiveJob)) {
        return;
      }
      [...lanesRef.current].forEach(disposeIdleLane);
    }, IDLE_LANE_TEARDOWN_MS);
  }, [disposeIdleLane, jobStore]);

  // The reservation and lane bookkeeping shared by admission and release. It
  // holds no state of its own (the cells above stay the single source of
  // truth), so re-creating it is harmless.
  const reservations = useMemo(
    () => new LaneReservations({
      lanes: lanesRef,
      laneByJob: laneByJobRef,
      heavyJobActive: heavyJobActiveRef,
      reservedPeakBytes: reservedPeakBytesRef,
      aggregatePeakBytes: aggregatePeakBytesRef,
      terminateLaneWorkers,
      scheduleIdleLaneTeardown,
    }),
    [scheduleIdleLaneTeardown, terminateLaneWorkers],
  );

  // Re-resolve the lane budget when the user preference changes (and once on
  // mount, where navigator/matchMedia first become available).
  useEffect(() => {
    const limit = resolveLaneLimit(parallelPreference);
    laneLimitRef.current = limit;
    heavyFileBytesRef.current = resolveHeavyFileBytes();
    // Devices with memory headroom get the larger per-job decode budget, so
    // high-resolution masters (24-bit 192 kHz runs well past 256 MiB of
    // decoded PCM) are not turned away on hardware that can hold them. The
    // aggregate reservation cap below is derived from whichever tier applies.
    decodeBudgetRef.current = resolveAdaptiveDecodeBudget(
      deviceMemoryGb(),
      isCoarsePointerDevice(),
    );
    aggregatePeakBytesRef.current = resolveAggregatePeakBytes(
      decodeBudgetRef.current,
    );
    // Every browser-bound job now has a checked probe reservation, so admitted
    // byte totals provide the memory bound and the FIFO window can use every
    // configured lane. Adjusting in place preserves held and waiting slots.
    browserDecodeWindowRef.current.setCapacity(limit);
    setParallelLimit(limit);
    // Shrink immediately if the new budget is lower; busy lanes finish their
    // current file first (no new work lands on them past the limit).
    const busyCount = lanesRef.current.filter((lane) => lane.lease !== null).length;
    const idleLanes = lanesRef.current.filter((lane) => lane.lease === null);
    const idleToKeep = Math.max(0, limit - busyCount);
    idleLanes.slice(idleToKeep).forEach(disposeIdleLane);
    fillLanesRef.current();
  }, [disposeIdleLane, parallelPreference]);

  // Free idle workers (and any ffmpeg.wasm heaps inside them) once the queue
  // has been quiet for a while; they respawn on demand in milliseconds.
  useEffect(() => {
    clearIdleLaneTeardown();
    if (hasActiveJobs) {
      return;
    }
    scheduleIdleLaneTeardown();

    return () => {
      clearIdleLaneTeardown();
    };
  }, [clearIdleLaneTeardown, hasActiveJobs, scheduleIdleLaneTeardown]);

  useEffect(() => {
    workspaceOpenRef.current = true;
    const lanes = lanesRef.current;
    const decoderPending = decoderPendingRef.current;
    const analyzerPending = analyzerPendingRef.current;
    const probeState = probeWorkerRef.current;
    const probePending = probePendingRef.current;
    const laneByJob = laneByJobRef.current;
    const jobRunTokens = jobRunTokensRef.current;
    const resourcePlanGenerations = resourcePlanGenerationRef.current;

    return () => {
      workspaceOpenRef.current = false;
      jobRunTokens.clear();
      lanes.forEach((lane) => {
        lane.lease?.browserAbortController.abort(
          cancellationFailure("Workspace closed."),
        );
        lane.decoder?.terminate();
        lane.analyzer?.terminate();
      });
      lanes.length = 0;
      decoderPending.forEach(({ reject }) => reject(new Error("Workspace closed.")));
      analyzerPending.forEach(({ reject }) => reject(new Error("Workspace closed.")));
      decoderPending.clear();
      analyzerPending.clear();
      probeState.workerEpoch += 1;
      probeState.worker?.terminate();
      probeState.worker = null;
      probeState.lease = null;
      probePending.forEach((pending) => {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error("Workspace closed."));
      });
      probePending.clear();
      resourcePlanGenerations.clear();
      if (probeIdleTeardownRef.current != null) {
        window.clearTimeout(probeIdleTeardownRef.current);
        probeIdleTeardownRef.current = null;
      }
      laneByJob.clear();
      heavyJobActiveRef.current = null;
      reservedPeakBytesRef.current = 0;
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
      if (progressCommitTimerRef.current != null) {
        window.clearTimeout(progressCommitTimerRef.current);
        progressCommitTimerRef.current = null;
      }
      pendingProgressRef.current.clear();
    };
  }, []);

  useEffect(() => {
    // Turning history off stops new writes; it does not delete summaries the
    // user already saved. Keep them visible so the count and clear control stay
    // truthful while the preference is off.
    setRecentSessions(loadRecentSessions());
  }, [persistHistory]);

  // Restore the previous session's completed results once on load. Restored
  // jobs are view-only (no File handle survives a refresh), exactly like jobs
  // imported from a session file.
  useEffect(() => {
    if (!restoreReady || didRestoreRef.current) {
      return;
    }

    didRestoreRef.current = true;
    let cancelled = false;
    const generation = restoreGenerationRef.current;
    const interruptedFileCount = readPendingAnalysisCount();

    const persistenceToken = persistenceGenerationRef.current;
    void liveSessionController.read(persistenceToken).then((controllerResult) => {
      if (cancelled || generation !== restoreGenerationRef.current) {
        return;
      }

      const failure = persistenceFailureMessage(controllerResult, "restore");
      if (failure) {
        persistenceFailureEpochRef.current += 1;
        setPersistenceIssue(failure);
        return;
      }

      const { outcome } = controllerResult;
      if (
        outcome.status === "superseded" ||
        outcome.operation !== "read" ||
        (outcome.status !== "committed" && outcome.status !== "empty")
      ) {
        return;
      }

      setPersistenceIssue(null);
      const loadedJobs = outcome.jobs;
      if (!loadedJobs.length) {
        const recoveryNotice = buildRecoveryNotice({
          restoredCount: 0,
          invalidRecordCount: outcome.invalidRecordCount,
          overflowRecordCount: outcome.overflowRecordCount,
          interruptedFileCount,
        });
        if (recoveryNotice) {
          pushNotice(recoveryNotice);
        }
        return;
      }

      // The stored results carry whatever target was active when they were
      // computed. Reconcile them to the settings that are active right now,
      // exactly like a job that finishes after a target switch; otherwise a
      // preset or mode change made before the refresh silently reverts.
      const settings = settingsRef.current;
      const restoredJobs = reconcileSessionJobs(loadedJobs, settings);

      // Recovery shares the same authoritative session-cap plan as file and
      // portable-session intake. The JobStore snapshot/set pair is synchronous,
      // so this merge cannot append past MAX_SESSION_JOBS between calculation
      // and publication.
      const existingJobs = jobStore.getSnapshot();
      const existingIds = new Set(existingJobs.map((job) => job.id));
      const fresh = restoredJobs.filter((job) => !existingIds.has(job.id));
      const intakePlan = planSessionIntake(existingJobs.length, fresh.length);
      const acceptedJobs = fresh.slice(0, intakePlan.accepted);
      if (!acceptedJobs.length) {
        const recoveryNotice = buildRecoveryNotice({
          restoredCount: 0,
          invalidRecordCount: outcome.invalidRecordCount,
          overflowRecordCount: outcome.overflowRecordCount + intakePlan.turnedAway,
          interruptedFileCount,
        });
        if (recoveryNotice) {
          pushNotice(recoveryNotice);
        }
        return;
      }

      // Mark only admitted rows as already persisted so the live-session
      // subscriber does not write every restored record straight back.
      acceptedJobs.forEach((job) => {
        if (job.result) {
          persistedResultsRef.current.set(job.id, job.result.analyzedAt);
        }
      });
      setJobs([...existingJobs, ...acceptedJobs]);

      const recoveryNotice = buildRecoveryNotice({
        restoredCount: acceptedJobs.length,
        invalidRecordCount: outcome.invalidRecordCount,
        overflowRecordCount: outcome.overflowRecordCount + intakePlan.turnedAway,
        interruptedFileCount,
      });
      pushNotice(recoveryNotice);
    }).catch((error: unknown) => {
      if (cancelled || generation !== restoreGenerationRef.current) {
        return;
      }

      const message = `TruePeak could not restore the previous session. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`;
      persistenceFailureEpochRef.current += 1;
      setPersistenceIssue(message);
    }).finally(() => {
      // Settled means "the restore has had its chance", success or not. Callers
      // that prune URL state against the job list have to wait for this: on the
      // first client commit `jobs` is always empty, so pruning then strips
      // ?job/?drawer/?reference for rows the restore is about to add back under
      // their original ids.
      //
      // Deliberately NOT gated on `cancelled`. didRestoreRef makes this a
      // once-per-mount read, so if an effect re-run were ever to cancel this
      // instance (React StrictMode's double invoke, were it enabled) no later
      // instance would issue another read, and a cancelled latch would leave
      // pruning disabled for the rest of the session. The flag is one-way and
      // only enables work, so setting it late is harmless.
      setRestoreSettled(true);
    });

    return () => {
      cancelled = true;
    };
  }, [jobStore, liveSessionController, pushNotice, restoreReady, setJobs]);

  useEffect(() => subscribePendingAnalysisCount(
    jobStore,
    pendingAnalysisCountRef,
    countPendingAnalysisJobs,
    writePendingAnalysisCount,
  ), [jobStore]);

  // Recovery persistence observes the synchronous job store directly. It
  // diffs completed results and removed ids, so progress-only updates remain
  // no-ops without making the React hook subscribe through an effect on jobs.
  useEffect(() => subscribeLiveSessionPersistence(jobStore, {
    allowSaves: recoveryWritesAllowed,
    controller: liveSessionController,
    persistedResults: persistedResultsRef,
    persistenceGeneration: persistenceGenerationRef,
    persistenceFailureEpoch: persistenceFailureEpochRef,
    describeFailure: persistenceFailureMessage,
    setIssue: setPersistenceIssue,
  }), [jobStore, liveSessionController, recoveryWritesAllowed]);

  // Desktop browsers can ask before leaving. Mobile browsers usually cannot,
  // so pagehide also records the latest pending count for the restore notice.
  useEffect(() => {
    if (typeof window === "undefined" || !hasActiveJobs) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handlePageHide = () => {
      writePendingAnalysisCount(countPendingAnalysisJobs(jobStore.getSnapshot()));
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [hasActiveJobs, jobStore]);

  // Keep the screen awake while a batch runs. On phones the screen sleeping
  // throttles or discards the tab, which silently loses the whole queue. The
  // lock is best-effort: when the browser refuses (battery saver, hidden tab)
  // analysis simply continues without it.
  useEffect(() => {
    if (
      typeof navigator === "undefined" ||
      !("wakeLock" in navigator) ||
      !hasActiveJobs
    ) {
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let stopped = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (stopped) {
          void lock.release().catch(() => undefined);
          return;
        }

        sentinel = lock;
      } catch {
        // Denied by policy — nothing to do.
      }
    };

    void acquire();
    // The platform auto-releases the lock when the tab is hidden; take it
    // back when the user returns mid-batch.
    const handleVisibility = () => {
      if (!stopped && document.visibilityState === "visible") {
        void acquire();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      void sentinel?.release().catch(() => undefined);
    };
  }, [hasActiveJobs]);

  useEffect(() => subscribeRecentSessionHistory(jobStore, {
    enabled: persistHistory,
    fingerprint: historyFingerprintRef,
    buildFingerprint: completedHistoryFingerprint,
    persist: persistRecentSessions,
    refresh: () => setRecentSessions(loadRecentSessions()),
  }), [jobStore, persistHistory]);

  useEffect(() => {
    if (analysisBlocked) {
      return;
    }

    const nextTarget = analysisMode === "targeted" ? target ?? DEFAULT_TARGET_PRESET : null;

    setJobs((current) => {
      let changed = false;
      const next: AnalysisJob[] = current.map((job) => {
        if (!job.result) {
          return job;
        }

        changed = true;
        return { ...job, result: retargetAnalysisResult(job.result, nextTarget) };
      });

      if (!changed) {
        return current;
      }
      return next;
    });
  }, [analysisBlocked, analysisMode, setJobs, target]);

  const terminateProbeWorker = useCallback((reason: unknown) => {
    const state = probeWorkerRef.current;
    const worker = state.worker;
    const lease = state.lease;
    state.workerEpoch += 1;
    state.worker = null;
    state.lease = null;
    worker?.terminate();

    if (!lease) {
      return;
    }
    const pending = probePendingRef.current.get(lease.jobId);
    if (pending?.lease !== lease) {
      return;
    }
    window.clearTimeout(pending.timeoutId);
    probePendingRef.current.delete(lease.jobId);
    pending.reject(reason);
  }, []);

  const ensureProbeWorker = useCallback(() => {
    const state = probeWorkerRef.current;
    if (state.worker) {
      return state.worker;
    }

    let worker: Worker;
    try {
      worker = new Worker(
        new URL("../workers/decoder.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      throw workerFailure(
        error instanceof Error
          ? `Metadata worker could not start: ${error.message}`
          : "Metadata worker could not start.",
      );
    }

    const workerEpoch = state.workerEpoch + 1;
    state.workerEpoch = workerEpoch;
    state.worker = worker;
    worker.onerror = (event) => {
      event.preventDefault();
      if (
        probeWorkerRef.current.worker === worker &&
        probeWorkerRef.current.workerEpoch === workerEpoch
      ) {
        terminateProbeWorker(workerFailure(describeWorkerFailure("Metadata", event)));
      }
    };
    worker.onmessageerror = (event) => {
      if (
        probeWorkerRef.current.worker === worker &&
        probeWorkerRef.current.workerEpoch === workerEpoch
      ) {
        terminateProbeWorker(workerFailure(describeWorkerFailure("Metadata", event)));
      }
    };
    worker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      const current = probeWorkerRef.current;
      if (current.worker !== worker || current.workerEpoch !== workerEpoch) {
        return;
      }

      const message = event.data;
      const pending = probePendingRef.current.get(message.jobId);
      if (
        !pending ||
        pending.workerEpoch !== workerEpoch ||
        pending.lease !== current.lease
      ) {
        return;
      }
      const probeStillCurrent =
        filesRef.current.get(message.jobId) === pending.lease.file &&
        resourcePlansRef.current.get(message.jobId)?.kind === "preparing" &&
        resourcePlanGenerationRef.current.get(message.jobId) ===
          pending.lease.planGeneration &&
        jobStore.getSnapshot().some(
          (job) => job.id === message.jobId && job.status === "queued",
        );
      if (!probeStillCurrent) {
        terminateProbeWorker(
          cancellationFailure("Metadata inspection is no longer current."),
        );
        return;
      }
      if (message.type === "progress") {
        return;
      }
      if (
        message.type !== "probed" &&
        !(message.type === "error" && message.phase === "probe")
      ) {
        return;
      }

      window.clearTimeout(pending.timeoutId);
      probePendingRef.current.delete(message.jobId);
      current.lease = null;
      if (message.type === "probed") {
        pending.resolve(message.metadata);
        return;
      }
      if (message.type === "error" && message.phase === "probe") {
        pending.reject(
          new DecodeResourceError(message.code, message.error, message.retryable),
        );
      }
    };
    return worker;
  }, [jobStore, terminateProbeWorker]);

  const probeCompressedSource = useCallback(
    (jobId: string, file: File, planGeneration: number) => {
      const runProbe = async () => {
        if (probeIdleTeardownRef.current != null) {
          window.clearTimeout(probeIdleTeardownRef.current);
          probeIdleTeardownRef.current = null;
        }
        if (
          !workspaceOpenRef.current ||
          filesRef.current.get(jobId) !== file ||
          resourcePlansRef.current.get(jobId)?.kind !== "preparing" ||
          resourcePlanGenerationRef.current.get(jobId) !== planGeneration ||
          !jobStore.getSnapshot().some((job) => job.id === jobId && job.status === "queued")
        ) {
          throw cancellationFailure("Metadata inspection is no longer current.");
        }

        const worker = ensureProbeWorker();
        const state = probeWorkerRef.current;
        if (state.lease) {
          throw workerFailure("The metadata worker is already processing another file.");
        }
        state.leaseGeneration += 1;
        const lease: ProbeLease = Object.freeze({
          jobId,
          generation: state.leaseGeneration,
          planGeneration,
          file,
        });
        state.lease = lease;

        return new Promise<DecodeProbeMetadata>((resolve, reject) => {
          const timeoutId = window.setTimeout(() => {
            if (
              probeWorkerRef.current.lease === lease &&
              probePendingRef.current.get(jobId)?.lease === lease
            ) {
              terminateProbeWorker(
                new DecodeResourceError(
                  "time-limit-exceeded",
                  "Audio metadata inspection did not answer in time.",
                  true,
                ),
              );
            }
          }, PROBE_RESPONSE_TIMEOUT_MS);
          const pending: ProbePendingResolver = {
            resolve,
            reject,
            lease,
            workerEpoch: state.workerEpoch,
            timeoutId,
          };
          probePendingRef.current.set(jobId, pending);
          try {
            worker.postMessage({
              type: "probe",
              jobId,
              fileName: file.name,
              mimeType: file.type || "application/octet-stream",
              file,
              budget: decodeBudgetRef.current,
              allowCompatibilityDecoder: settingsRef.current.allowCompatibilityDecoder,
            } satisfies DecoderRequest);
          } catch (error) {
            terminateProbeWorker(
              workerFailure(
                error instanceof Error
                  ? `Metadata worker post failed: ${error.message}`
                  : "Metadata worker post failed.",
              ),
            );
          }
        });
      };

      const operation = probeQueueTailRef.current
        .catch(() => undefined)
        .then(runProbe);
      probeQueueTailRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      const scheduleTeardown = () => {
        if (workspaceOpenRef.current && probeIdleTeardownRef.current == null) {
          probeIdleTeardownRef.current = window.setTimeout(() => {
            probeIdleTeardownRef.current = null;
            if (probeWorkerRef.current.lease == null) {
              terminateProbeWorker(new Error("Metadata worker became idle."));
            }
          }, IDLE_LANE_TEARDOWN_MS);
        }
      };
      void operation.then(scheduleTeardown, scheduleTeardown);
      return operation;
    },
    [ensureProbeWorker, jobStore, terminateProbeWorker],
  );

  const prepareResourcePlan = useCallback(
    async (jobId: string, file: File) => {
      if (resourcePlansRef.current.has(jobId)) {
        return;
      }

      const planGeneration = (resourcePlanGenerationRef.current.get(jobId) ?? 0) + 1;
      resourcePlanGenerationRef.current.set(jobId, planGeneration);
      resourcePlansRef.current.set(jobId, { kind: "preparing" });
      preparingPlanCountRef.current += 1;
      try {
        const budget = decodeBudgetRef.current;
        assertSourceWithinBudget(file.size, budget);

        // Container PCM and FLAC metadata is available from a bounded header
        // slice. Sources without trusted geometry are sent through the shared,
        // serialized metadata worker: it sniffs common compressed headers and
        // invokes ffprobe only when the sniff cannot establish a duration.
        const preflightBytes =
          file.size <= 16 * 1024 * 1024
            ? file.size
            : Math.min(file.size, 256 * 1024);
        const header = await file.slice(0, preflightBytes).arrayBuffer();
        const metadata = inspectAudioContainer(header, file.size);
        let plan: JobResourcePlan;
        if (metadata) {
          const decodedBytes = assertDecodedFootprint(
            metadata,
            budget,
            "Container preflight",
          ).decodedBytes;
          const footprintTrusted =
            metadata.container !== "flac" ||
            declaredDecodeCorroboratedByFileSize(decodedBytes, file.size);
          if (footprintTrusted) {
            plan = {
              kind: "known",
              decodedBytes,
              trustedNative: metadata.nativeDecodeSafe,
              sourceMetadata: {
                sampleRate: metadata.sampleRate,
                channelCount: metadata.channelCount,
                frameCount: metadata.frameCount,
                durationSeconds: metadata.durationSeconds,
                codecName: metadata.container,
                bitDepth: metadata.bitDepth,
                label: metadata.container === "flac"
                  ? "FLAC STREAMINFO"
                  : `${metadata.container.toUpperCase()} header`,
                frameCountExact: true,
              },
            };
          } else {
            let probedMetadata: DecodeProbeMetadata | null = null;
            try {
              probedMetadata = await probeCompressedSource(jobId, file, planGeneration);
            } catch {
              // Probe failures keep the conservative plan and are not surfaced.
            }
            const probedPlan = planProbedDecodeFootprint(probedMetadata, budget);
            plan = probedPlan.kind === "known"
              ? {
                  kind: "known",
                  decodedBytes: probedPlan.decodedBytes,
                  trustedNative: false,
                  sourceMetadata: {
                    ...probedPlan.metadata,
                    label: probedPlan.metadata.codecName
                      ? `${probedPlan.metadata.codecName} probe`
                      : "Source probe",
                    frameCountExact: false,
                  },
                }
              : { kind: "unknown" };
          }
        } else {
          let probedMetadata: DecodeProbeMetadata | null = null;
          try {
            probedMetadata = await probeCompressedSource(jobId, file, planGeneration);
          } catch {
            // A timed-out, rejected or crashed probe preserves old behavior by
            // falling back to the conservative plan. It never fails the row.
          }
          const probedPlan = planProbedDecodeFootprint(probedMetadata, budget);
          plan = probedPlan.kind === "known"
            ? {
                kind: "known",
                decodedBytes: probedPlan.decodedBytes,
                trustedNative: false,
                sourceMetadata: {
                  ...probedPlan.metadata,
                  label: probedPlan.metadata.codecName
                    ? `${probedPlan.metadata.codecName} probe`
                    : "Source probe",
                  frameCountExact: false,
                },
              }
            : { kind: "unknown" };
        }

        if (
          filesRef.current.get(jobId) === file &&
          resourcePlansRef.current.get(jobId)?.kind === "preparing" &&
          resourcePlanGenerationRef.current.get(jobId) === planGeneration &&
          jobStore.getSnapshot().some((job) => job.id === jobId && job.status === "queued")
        ) {
          resourcePlansRef.current.set(jobId, plan);
        }
      } catch (error) {
        if (
          filesRef.current.get(jobId) === file &&
          resourcePlansRef.current.get(jobId)?.kind === "preparing" &&
          resourcePlanGenerationRef.current.get(jobId) === planGeneration &&
          jobStore.getSnapshot().some((job) => job.id === jobId && job.status === "queued")
        ) {
          const details = decodeFailureDetails(error);
          const summary = normalizeDecodeFailure(
            details.message,
            settingsRef.current.decodePreference,
            details.code,
            decodeBudgetRef.current,
          );
          resourcePlansRef.current.set(jobId, {
            kind: "rejected",
            error: composeJobError(summary, details.message),
          });
          updateJob(jobId, (job) =>
            job.status === "queued"
              ? {
                  ...job,
                  status: "failed",
                  error: composeJobError(summary, details.message),
                  progressPercent: 1,
                  progressLabel: "Resource limit",
                  finishedAtMs: Date.now(),
                }
              : job,
          );
        }
      } finally {
        preparingPlanCountRef.current = Math.max(0, preparingPlanCountRef.current - 1);
        fillLanesRef.current();
      }
    },
    [jobStore, probeCompressedSource, updateJob],
  );

  const ensureLaneWorkers = useCallback(
    (lane: WorkerLane) => {
      if (lane.decoder && lane.analyzer) {
        return;
      }
      if (lane.retireAfterRelease) {
        throw workerFailure("The analysis worker lane is no longer available.");
      }

      if (lane.decoder || lane.analyzer) {
        terminateLaneWorkers(lane);
      }
      const attachError = attachLaneWorkers(lane);
      if (!attachError) {
        return;
      }

      lane.failureStreak += 1;
      if (lane.failureStreak >= MAX_LANE_FAILURE_STREAK) {
        lane.retireAfterRelease = true;
        openWorkerCircuit(lane.lease?.jobId);
      }
      throw attachError;
    },
    [attachLaneWorkers, openWorkerCircuit, terminateLaneWorkers],
  );

  const validateDecodedAssetForLease = useCallback(
    (
      lane: WorkerLane,
      lease: LaneLease,
      asset: DecodedAudioTransfer,
      workerUsage?: DecodeResourceUsage,
      browserRoute = false,
    ) => {
      const footprint = validatePlanarChannels(
        asset.channelBuffers.map((buffer) => ({
          length: buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
          byteLength: buffer.byteLength,
        })),
        asset,
        decodeBudgetRef.current,
        "Decoded audio handoff",
      );
      if (
        workerUsage != null &&
        workerUsage.decodedBytes !== footprint.decodedBytes
      ) {
        throw new DecodeResourceError(
          "invalid-metadata",
          "Decoder resource accounting did not match the transferred PCM buffers.",
        );
      }

      const actualPeakBytes = browserRoute
        ? decodePeakResidentBytes("browser", footprint.decodedBytes)
        : workerUsage?.outputBytes != null
          ? decodePeakResidentBytes(
              "compatibility-worker",
              footprint.decodedBytes,
              workerUsage.outputBytes,
              workerUsage.sourceBytes,
            )
          : decodePeakResidentBytes(
              "native-worker",
              footprint.decodedBytes,
            );
      // A decode that stayed within the reservation it was admitted under
      // needs no escalation: the aggregate already accounts for it, so other
      // lanes may keep running. Escalation to the conservative exclusive
      // posture is reserved for a decode that EXCEEDED its plan, which means
      // the container header lied about its footprint (or an unplanned route
      // produced more than the model allowed) and the job can only continue
      // once it holds the full conservative reservation alone.
      const exceededPlan =
        actualPeakBytes > lease.reservation.plannedPeakBytes;
      const conservativeRoute =
        (browserRoute || workerUsage?.outputBytes != null) && exceededPlan;
      reservations.growLeasePeakReservation(
        lane,
        lease,
        conservativeRoute
          ? Math.max(
              actualPeakBytes,
              conservativeDecodePeakBytes(decodeBudgetRef.current),
            )
          : actualPeakBytes,
        conservativeRoute,
      );
    },
    [reservations],
  );

  const decodeInWorker = useCallback(
    (lane: WorkerLane, lease: LaneLease, file: File, mimeType: string) =>
      new Promise<DecodedWorkerResult>((resolve, reject) => {
        if (lane.lease !== lease) {
          reject(cancellationFailure("The decoder lease is no longer current."));
          return;
        }
        try {
          ensureLaneWorkers(lane);
        } catch (error) {
          reject(error);
          return;
        }

        const decoder = lane.decoder;
        if (!decoder) {
          reject(workerFailure("The decoder worker is unavailable."));
          return;
        }
        const pending: PendingResolver<DecodedWorkerResult> = {
          resolve,
          reject,
          lease,
          workerEpoch: lane.workerEpoch,
        };
        decoderPendingRef.current.set(lease.jobId, pending);
        try {
          // Send the File handle; the worker reads the bytes itself so the
          // main thread never holds a full copy of a large file.
          decoder.postMessage(
            {
              type: "decode",
              jobId: lease.jobId,
              fileName: file.name,
              mimeType,
              file,
              budget: decodeBudgetRef.current,
              allowCompatibilityDecoder: settingsRef.current.allowCompatibilityDecoder,
            } satisfies DecoderRequest,
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Unable to send audio to the decoder worker.";
          workerFaultRef.current(
            lane,
            pending.workerEpoch,
            `Decoder worker post failed: ${message}`,
          );
          if (decoderPendingRef.current.get(lease.jobId) === pending) {
            decoderPendingRef.current.delete(lease.jobId);
            reject(workerFailure(message));
          }
        }
      }),
    [ensureLaneWorkers],
  );

  const analyzeInWorker = useCallback(
    (
      lane: WorkerLane,
      lease: LaneLease,
      asset: DecodedAudioTransfer,
      currentTarget: TargetPreset | null,
    ) =>
      new Promise<AnalysisJob["result"]>((resolve, reject) => {
        if (lane.lease !== lease) {
          reject(cancellationFailure("The analyzer lease is no longer current."));
          return;
        }
        try {
          ensureLaneWorkers(lane);
        } catch (error) {
          reject(error);
          return;
        }

        const analyzer = lane.analyzer;
        if (!analyzer) {
          reject(workerFailure("The analyzer worker is unavailable."));
          return;
        }
        const pending: PendingResolver<AnalysisJob["result"]> = {
          resolve,
          reject,
          lease,
          workerEpoch: lane.workerEpoch,
        };
        analyzerPendingRef.current.set(lease.jobId, pending);
        try {
          analyzer.postMessage({
            type: "analyze",
            jobId: lease.jobId,
            asset,
            target: currentTarget,
          } satisfies AnalyzerRequest, asset.channelBuffers);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Unable to send audio to the analyzer worker.";
          workerFaultRef.current(
            lane,
            pending.workerEpoch,
            `Analyzer worker post failed: ${message}`,
          );
          if (analyzerPendingRef.current.get(lease.jobId) === pending) {
            analyzerPendingRef.current.delete(lease.jobId);
            reject(workerFailure(message));
          }
        }
      }),
    [ensureLaneWorkers],
  );

  const startBrowserDecodeHeartbeat = useCallback(
    (jobId: string, runToken: number) => {
      let tick = 0;
      return window.setInterval(() => {
        if (!isJobRunCurrent(jobId, runToken)) {
          return;
        }

        tick += 1;
        queueJobProgress(
          jobId,
          runToken,
          "decoding",
          Math.min(0.42, 0.18 + tick * 0.02),
          "Still decoding locally - large files can take a moment",
        );
      }, 4500);
    },
    [isJobRunCurrent, queueJobProgress],
  );

  const runJob = useCallback(
    (
      lane: WorkerLane,
      lease: LaneLease,
      currentTarget: TargetPreset | null,
      currentAnalysisMode: AnalysisMode,
      currentDecodePreference: DecodePreference,
    ) => runAnalysisJob(
      {
        files: filesRef,
        resourcePlans: resourcePlansRef,
        decodeBudget: decodeBudgetRef,
        heavyFileBytes: heavyFileBytesRef,
        browserDecodeWindow: browserDecodeWindowRef,
        settings: settingsRef,
        updateJobIfRunCurrent,
        isJobRunCurrent,
        releaseLane: reservations.releaseLane,
        fillLanes: () => fillLanesRef.current(),
        startBrowserDecodeHeartbeat,
        growLeasePeakReservation: reservations.growLeasePeakReservation,
        decodeInWorker,
        analyzeInWorker,
        validateDecodedAssetForLease,
        resolveBrowserFirstRoute,
        normalizeDecodeFailure,
        isWorkerTransportError: (error) => error instanceof WorkerTransportError,
        isCancellationReason,
      },
      lane,
      lease,
      currentTarget,
      currentAnalysisMode,
      currentDecodePreference,
    ),
    [
      analyzeInWorker,
      decodeInWorker,
      isJobRunCurrent,
      reservations,
      startBrowserDecodeHeartbeat,
      updateJobIfRunCurrent,
      validateDecodedAssetForLease,
    ],
  );
  // Hand queued jobs to free lanes. A checked preflight reserves decoded PCM,
  // not compressed source bytes. Sources whose footprint cannot be established
  // safely run alone, as do very large files, so an optimistic estimate can
  // never multiply across lanes.
  const scheduler = useMemo(
    () => new AnalysisScheduler({
      jobStore,
      workspaceOpen: workspaceOpenRef,
      settings: settingsRef,
      workerCircuitOpen: workerCircuitOpenRef,
      lanes: lanesRef,
      laneLimit: laneLimitRef,
      laneSequence: laneSequenceRef,
      files: filesRef,
      resourcePlans: resourcePlansRef,
      preparingPlanCount: preparingPlanCountRef,
      heavyFileBytes: heavyFileBytesRef,
      decodeBudget: decodeBudgetRef,
      reservations,
      transport: {
        attach: attachLaneWorkers,
        dispose: disposeIdleLane,
        run: runJob,
      },
      prepareResourcePlan,
      updateJob,
      beginJobRun,
      resolveBrowserFirstRoute,
    }),
    [
      attachLaneWorkers,
      beginJobRun,
      disposeIdleLane,
      jobStore,
      prepareResourcePlan,
      reservations,
      runJob,
      updateJob,
    ],
  );
  const fillLanes = scheduler.fillLanes;


  useEffect(() => {
    fillLanesRef.current = fillLanes;
  }, [fillLanes]);

  // The admission scan reads only each row's id and status, so the coalesced
  // progress commits that dominate a run cannot admit anything new. Rescan when
  // the admission signature moves instead of on every commit; the paths that
  // free capacity without moving it (lane release, circuit resume, a lane-limit
  // change, cancel, removal, a finished preflight) call fillLanes directly, and
  // analysisBlocked stays a dependency so unblocking re-subscribes and scans.
  useEffect(
    () => subscribeLaneAdmission(jobStore, fillLanes),
    [analysisBlocked, fillLanes, jobStore],
  );

  const enqueueFiles = useCallback((input: FileList | File[]) => {
    const allFiles = Array.from(input);
    // One session is a review desk, not a database. The session limit is global:
    // it is enforced against every job already in the session, not per add, so a
    // runaway selection, a dropped drive, or a sequence of adds can never push
    // the session past MAX_SESSION_JOBS and freeze the tab. Overflow is reported
    // in the notice below, never silently dropped.
    const intakePlan = planSessionIntake(jobStore.getSnapshot().length, allFiles.length);
    const files = allFiles.slice(0, intakePlan.accepted);
    const skippedOverCap = intakePlan.turnedAway;
    const knownSignatures = new Set(fileSignaturesRef.current.values());
    const accepted: File[] = [];
    let skippedEmpty = 0;
    let skippedDuplicates = 0;
    let skippedUnsupported = 0;

    files.forEach((file) => {
      if (file.size <= 0) {
        skippedEmpty += 1;
        return;
      }

      if (!isSupportedAudioFile(file)) {
        skippedUnsupported += 1;
        return;
      }

      const signature = fileIdentityKey(file);
      if (signature && knownSignatures.has(signature)) {
        skippedDuplicates += 1;
        return;
      }

      if (signature) {
        knownSignatures.add(signature);
      }
      accepted.push(file);
    });

    const nextJobs = accepted.map<AnalysisJob>((file) => {
      const id = makeId("analysis");
      filesRef.current.set(id, file);
      const identity = fileIdentityKey(file);
      if (identity) {
        fileSignaturesRef.current.set(id, identity);
      }
      return {
        id,
        fileName: file.name,
        mimeType: file.type,
        status: "queued",
        createdAt: new Date().toISOString(),
        progressPercent: 0,
        progressLabel: "Queued",
      };
    });

    if (nextJobs.length) {
      // A new explicit queue action is the retry boundary for a worker-start
      // circuit breaker; background renders never reopen it on their own.
      resumeWorkerCircuit();
      setJobs((current) => {
        const merged = [...nextJobs, ...current];
        return merged;
      });
    }

    const skippedParts = [
      skippedDuplicates
        ? `${skippedDuplicates} duplicate${skippedDuplicates === 1 ? "" : "s"}`
        : null,
      skippedUnsupported
        ? `${skippedUnsupported} unsupported file${skippedUnsupported === 1 ? "" : "s"}`
        : null,
      skippedEmpty
        ? `${skippedEmpty} empty file${skippedEmpty === 1 ? "" : "s"}`
        : null,
      skippedOverCap
        ? `${skippedOverCap} over the ${MAX_SESSION_JOBS}-file session limit`
        : null,
    ].filter(Boolean);

    if (skippedParts.length && nextJobs.length) {
      pushNotice(
        `Added ${nextJobs.length} file${nextJobs.length === 1 ? "" : "s"} and skipped ${skippedParts.join(" and ")}.`,
      );
    } else if (skippedParts.length) {
      pushNotice(
        `Skipped ${skippedParts.join(" and ")}.`,
      );
    } else if (nextJobs.length) {
      pushNotice(
        `Queued ${nextJobs.length} file${nextJobs.length === 1 ? "" : "s"} for analysis.`,
      );
    }

    // Callers use this to decide whether to navigate to the session screen.
    return nextJobs.length;
  }, [jobStore, pushNotice, resumeWorkerCircuit, setJobs]);

  const cancelJob = useCallback((jobId: string) => {
    invalidateJobRun(jobId);

    // JobStore updates synchronously, so rejection microtasks and fillLanes
    // observe the cancellation before either can re-admit this job.
    setJobs((current) => current.map((job) =>
      job.id === jobId ? markJobCanceled(job) : job,
    ));

    const lane = laneByJobRef.current.get(jobId);
    if (lane) {
      interruptLane(lane, "Job canceled.");
    }

    fillLanesRef.current();
  }, [interruptLane, invalidateJobRun, setJobs]);

  const cancelActiveJobs = useCallback(() => {
    const activeIds = new Set(
      jobStore.getSnapshot().filter(isActiveJob).map((job) => job.id),
    );

    if (!activeIds.size) {
      return;
    }

    activeIds.forEach(invalidateJobRun);

    // Same ordering requirement as cancelJob: publish every cancellation
    // before interrupting lanes so rejection microtasks cannot re-admit them.
    setJobs((current) => current.map((job) =>
      activeIds.has(job.id) ? markJobCanceled(job) : job,
    ));

    lanesRef.current.forEach((lane) => {
      if (lane.lease !== null && activeIds.has(lane.lease.jobId)) {
        interruptLane(lane, "Jobs canceled.");
      }
    });

    pushNotice(
      `Canceled ${activeIds.size} active file${activeIds.size === 1 ? "" : "s"}.`,
    );
  }, [interruptLane, invalidateJobRun, jobStore, pushNotice, setJobs]);

  const retryJob = useCallback((jobId: string) => {
    if (!filesRef.current.has(jobId)) {
      return;
    }

    invalidateJobRun(jobId);
    resourcePlansRef.current.delete(jobId);
    resumeWorkerCircuit();
    updateJob(jobId, (job) => ({
      ...job,
      status: "queued",
      progressPercent: 0,
      progressLabel: "Queued",
      error: undefined,
      result: undefined,
      startedAtMs: undefined,
      finishedAtMs: undefined,
    }));
  }, [invalidateJobRun, resumeWorkerCircuit, updateJob]);

  const retryIssues = useCallback(() => {
    const retryIds = new Set(
      jobStore.getSnapshot()
        .filter((job) => isIssueJob(job) && filesRef.current.has(job.id))
        .map((job) => job.id),
    );

    retryIds.forEach((jobId) => {
      invalidateJobRun(jobId);
      resourcePlansRef.current.delete(jobId);
    });
    if (retryIds.size) {
      resumeWorkerCircuit();
    }
    setJobs((current) => {
      const next: AnalysisJob[] = current.map((job) => {
        if (retryIds.has(job.id)) {
          return {
            ...job,
            status: "queued",
            progressPercent: 0,
            progressLabel: "Queued",
            error: undefined,
            result: undefined,
            startedAtMs: undefined,
            finishedAtMs: undefined,
          };
        }

        return job;
      });
      return next;
    });

    if (retryIds.size) {
      pushNotice(`Re-queued ${retryIds.size} file${retryIds.size === 1 ? "" : "s"} with issues.`);
    }
  }, [invalidateJobRun, jobStore, pushNotice, resumeWorkerCircuit, setJobs]);

  const retryAnalysis = useCallback(() => {
    const retryIds = new Set(workerCircuitRetryJobsRef.current);
    retryIds.forEach((jobId) => {
      invalidateJobRun(jobId);
      resourcePlansRef.current.delete(jobId);
    });
    resumeWorkerCircuit();

    if (retryIds.size) {
      const retryWorkerFailures = (current: AnalysisJob[]) =>
        current.map((job) =>
          retryIds.has(job.id) && job.status === "failed" && filesRef.current.has(job.id)
            ? {
                ...job,
                status: "queued" as const,
                progressPercent: 0,
                progressLabel: "Queued",
                error: undefined,
                result: undefined,
                startedAtMs: undefined,
                finishedAtMs: undefined,
              }
            : job,
        );
      setJobs(retryWorkerFailures);
    }

    fillLanesRef.current();
  }, [invalidateJobRun, resumeWorkerCircuit, setJobs]);

  const removeJob = useCallback((jobId: string) => {
    invalidateJobRun(jobId);
    const lane = laneByJobRef.current.get(jobId);
    if (lane) {
      interruptLane(lane, "Job removed.");
    }

    dropJobResources(jobId);
    setJobs((current) => {
      const next = current.filter((job) => job.id !== jobId);
      return next;
    });
    fillLanesRef.current();
  }, [dropJobResources, interruptLane, invalidateJobRun, setJobs]);

  const clearFinished = useCallback(() => {
    setJobs((current) => {
      const finishedIds = new Set(
        current
          .filter((job) => job.status === "complete" || isIssueJob(job))
          .map((job) => job.id),
      );
      finishedIds.forEach(dropJobResources);
      const keep = current.filter((job) => !finishedIds.has(job.id));
      return keep;
    });
    pushNotice("Cleared finished files from the queue.");
  }, [dropJobResources, pushNotice, setJobs]);

  const clearSession = useCallback(() => {
    restoreGenerationRef.current += 1;
    // clear() advances the persistence tombstone synchronously before its
    // transaction joins the serialized queue. Capture the new generation for
    // every later state snapshot so an old autosave can never reappear after
    // the clear commits.
    const clearPromise = liveSessionController.clear();
    persistenceGenerationRef.current = liveSessionController.captureGeneration();
    jobRunTokensRef.current.clear();
    lanesRef.current.forEach((lane) => {
      if (lane.lease !== null) {
        interruptLane(lane, "Session cleared.");
      }
    });

    filesRef.current.clear();
    fileSignaturesRef.current.clear();
    resourcePlansRef.current.clear();
    resourcePlanGenerationRef.current.clear();
    persistedResultsRef.current.clear();
    workerCircuitOpenRef.current = false;
    workerCircuitRetryJobsRef.current.clear();
    pendingAnalysisCountRef.current = 0;
    writePendingAnalysisCount(0);
    setWorkerCircuitIssue(null);
    setJobs(() => {
      return [];
    });
    void clearPromise.then((controllerResult) => {
      const failure = persistenceFailureMessage(controllerResult, "clear");
      if (failure) {
        persistenceFailureEpochRef.current += 1;
        const message = `The visible session was cleared, but its browser recovery copy may remain. ${failure}`;
        setPersistenceIssue(message);
        return;
      }

      if (controllerResult.outcome.status === "committed") {
        setPersistenceIssue(null);
        pushNotice("Cleared the current analysis session and its browser recovery copy.");
      }
    }).catch((error: unknown) => {
      persistenceFailureEpochRef.current += 1;
      const message = `The visible session was cleared, but its browser recovery copy could not be deleted. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`;
      setPersistenceIssue(message);
    });
  }, [interruptLane, liveSessionController, pushNotice, setJobs]);

  const clearRecentSessions = useCallback(() => {
    if (clearPersistedRecentSessions()) {
      setRecentSessions([]);
      pushNotice("Cleared saved history from this browser.");
      return true;
    }

    pushNotice(
      "TruePeak could not clear saved history from this browser. The existing history remains visible.",
    );
    return false;
  }, [pushNotice]);

  const exportCsv = useCallback(() => {
    try {
      downloadTextFile(
        getExportFileName("csv"),
        buildCsvExport(jobStore.getSnapshot()),
        "text/csv;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the CSV download. Try again or use another export format.");
    }
  }, [jobStore, pushNotice]);
  const exportJson = useCallback(() => {
    try {
      downloadTextFile(
        getExportFileName("json"),
        buildJsonExport(jobStore.getSnapshot()),
        "application/json;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the JSON download. Try again or use another export format.");
    }
  }, [jobStore, pushNotice]);
  const exportMarkdown = useCallback(() => {
    try {
      downloadTextFile(
        getExportFileName("markdown"),
        buildMarkdownExport(jobStore.getSnapshot()),
        "text/markdown;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the Markdown report download. Try again or use another export format.");
    }
  }, [jobStore, pushNotice]);

  const exportSession = useCallback(() => {
    try {
      downloadTextFile(
        getSessionFileName(),
        buildSessionFile(jobStore.getSnapshot()),
        "application/json;charset=utf-8",
      );
    } catch (error) {
      pushNotice(
        error instanceof Error
          ? error.message
          : "The browser blocked the session download. Try again.",
      );
    }
  }, [jobStore, pushNotice]);

  const importSession = useCallback(
    async (file: File) => {
      if (file.size > MAX_SESSION_FILE_BYTES) {
        pushNotice("That session file is too large to import safely.");
        return 0;
      }

      let importResult: Extract<SessionImportWorkerResponse, { type: "result" }>;
      try {
        importResult = await importSessionInWorker(file);
      } catch (error) {
        pushNotice(
          error instanceof Error
            ? error.message
            : "Could not read or validate that session file.",
        );
        return 0;
      }

      const { jobs: importedJobs, error } = importResult;
      if (error || !importedJobs.length) {
        pushNotice(error ?? "No analyses were found in that session file.");
        return 0;
      }

      // Count against the latest committed state (not inside the updater, which
      // React may invoke twice in development) so the notice numbers are right.
      // Import shares file intake's global cap: mergeImportedJobs deduplicates
      // against what is already present and then bounds the remainder to the
      // room left under MAX_SESSION_JOBS, so a portable import can never push a
      // full session past the limit the way file intake cannot.
      const reconciledJobs = reconcileSessionJobs(importedJobs, settingsRef.current);
      const { added, skippedDuplicates, skippedOverCap } = mergeImportedJobs(
        jobStore.getSnapshot(),
        reconciledJobs,
      );

      if (!added) {
        pushNotice(
          skippedOverCap
            ? `This session is already at the ${MAX_SESSION_JOBS}-file limit, so no analyses were imported.`
            : "Those analyses are already in this session.",
        );
        return 0;
      }

      setJobs((current) => {
        // Re-run the merge against the latest committed state so a concurrent
        // add cannot let the import overshoot the cap it was planned against.
        const { toAdd } = mergeImportedJobs(current, reconciledJobs);
        if (!toAdd.length) {
          return current;
        }

        const next = [...toAdd, ...current];
        return next;
      });

      const skippedParts = [
        skippedDuplicates ? `${skippedDuplicates} already present` : null,
        skippedOverCap
          ? `${skippedOverCap} over the ${MAX_SESSION_JOBS}-file session limit`
          : null,
      ].filter(Boolean);

      pushNotice(
        skippedParts.length
          ? `Loaded ${added} file${added === 1 ? "" : "s"} from the session (${skippedParts.join(", ")}).`
          : `Loaded ${added} file${added === 1 ? "" : "s"} from the saved session.`,
      );
      return added;
    },
    [jobStore, pushNotice, setJobs],
  );


  return {
    jobs,
    completedJobs,
    restoreSettled,
    recentSessions,
    notice,
    persistenceIssue,
    workerCircuitIssue,
    parallelLimit,
    enqueueFiles,
    cancelJob,
    cancelActiveJobs,
    retryJob,
    retryIssues,
    retryAnalysis,
    removeJob,
    clearFinished,
    clearSession,
    clearRecentSessions,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportSession,
    importSession,
  };
}
