"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getComplianceSummary } from "@/audio/compliance";
import {
  decodeAudioFileInBrowser,
  shouldPreferBrowserDecoder,
} from "@/audio/browser-decode";
import {
  DecodeResourceError,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  checkedResourceByteSum,
  conservativeDecodePeakBytes,
  decodePeakResidentBytes,
  decodeFailureDetails,
  growDecodePeakReservation,
  inspectAudioContainer,
  resolveDecodeBudget,
  validatePlanarChannels,
  type DecodeBudget,
} from "@/audio/decode-budget";
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
} from "@/audio/live-session-store";
import {
  createLiveSessionController,
  type LiveSessionControllerResult,
} from "@/audio/live-session-controller";
import {
  clearPersistedRecentSessions,
  loadRecentSessions,
  persistRecentSessions,
} from "@/audio/persistence";
import { DEFAULT_TARGET_PRESET } from "@/audio/presets";
import { mergeImportedJobs, reconcileSessionJobs } from "@/audio/session-reconciliation";
import { retargetAnalysisResult } from "@/audio/targeting";
import { getCompletedAnalysisJobs, isActiveJob, isIssueJob } from "@/lib/session-selectors";
import { makeId } from "@/lib/utils";
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

interface DecodedWorkerResult {
  asset: DecodedAudioTransfer;
  usage: DecodeResourceUsage;
}

interface DecodeReservation {
  readonly plannedPeakBytes: number;
  peakBytes: number;
  exclusive: boolean;
  released: boolean;
}

interface LaneLease {
  readonly laneId: number;
  readonly generation: number;
  readonly jobId: string;
  readonly runToken: number;
  readonly reservation: DecodeReservation;
  readonly browserAbortController: AbortController;
}

type JobResourcePlan =
  | { kind: "preparing" }
  | { kind: "known"; decodedBytes: number; trustedNative: boolean }
  | { kind: "unknown" }
  | { kind: "rejected"; error: string };

// A lane is an independent decoder+analyzer worker pair that owns at most one
// job at a time. Multiple lanes let the queue process files in parallel while
// keeping the original per-job semantics: canceling or removing an active job
// terminates only its own lane's workers, never a neighbour's.
interface WorkerLane {
  id: number;
  decoder: Worker | null;
  analyzer: Worker | null;
  workerEpoch: number;
  leaseGeneration: number;
  lease: LaneLease | null;
  retireAfterRelease: boolean;
  // Consecutive worker failures without a single successful message. Guards
  // against an unbounded terminate/respawn loop when worker scripts cannot
  // load at all (stale deploy, offline revisit).
  failureStreak: number;
}

class WorkerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerTransportError";
  }
}

// After this many consecutive worker failures the lane retires and the worker
// circuit remains open until the user explicitly queues or retries work.
const MAX_LANE_FAILURE_STREAK = 3;

// Where analysis begins on the job's overall progress bar (read+decode owns
// everything before it). Analyzer worker fractions are mapped above this.
const ANALYSIS_PROGRESS_BASE = 0.86;

// Tear idle lanes down after this long with nothing active. Workers (and any
// lazily loaded ffmpeg.wasm heaps inside them) are not free to keep around,
// especially on phones; fresh lanes spin up in milliseconds when needed.
const IDLE_LANE_TEARDOWN_MS = 45_000;

const SESSION_IMPORT_TIMEOUT_MS = 45_000;

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
function resolveHeavyFileBytes() {
  const memory = deviceMemoryGb();
  const constrained = memory != null ? memory <= 4 : isCoarsePointerDevice();
  return (constrained ? 96 : 256) * 1024 * 1024;
}

function resolveAggregatePeakBytes(budget: DecodeBudget) {
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

function canTryAlternateDecoder(error: unknown) {
  return decodeFailureDetails(error).retryable;
}

function workerFailure(reason: string) {
  return new WorkerTransportError(reason);
}

function cancellationFailure(reason: string) {
  return new DecodeResourceError("cancelled", reason);
}

function allowRecoveryWritesByDefault() {
  return true;
}

export interface UseTruePeakAnalyzerOptions {
  analysisMode?: AnalysisMode;
  analysisBlocked?: boolean;
  decodePreference?: DecodePreference;
  persistHistory?: boolean;
  parallelPreference?: ParallelLanesPreference;
  restoreReady?: boolean;
  recoveryWriteAllowed?: () => boolean;
  recoveryWriteRevision?: number;
}

interface AnalyzerSettings {
  analysisBlocked: boolean;
  analysisMode: AnalysisMode;
  decodePreference: DecodePreference;
  target: TargetPreset | null;
}

function downloadTextFile(fileName: string, content: string, contentType: string) {
  let url: string | null = null;
  let anchor: HTMLAnchorElement | null = null;

  try {
    const blob = new Blob([content], { type: contentType });
    url = URL.createObjectURL(blob);
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    const targetUrl = url;
    const targetAnchor = anchor;
    window.setTimeout(() => {
      targetAnchor?.remove();
      if (targetUrl) {
        URL.revokeObjectURL(targetUrl);
      }
    }, 0);
  }
}

function normalizeDecodeFailure(message: string, decodePreference: DecodePreference) {
  const lower = message.toLowerCase();

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
function isSupportedAudioFile(file: File) {
  if (file.type.toLowerCase().startsWith("audio/")) {
    return true;
  }

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_AUDIO_EXTENSIONS.has(extension);
}

function completedHistoryFingerprint(jobs: AnalysisJob[]) {
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
  const decodePreference = options.decodePreference ?? "auto";
  const persistHistory = options.persistHistory ?? false;
  const parallelPreference = options.parallelPreference ?? "auto";
  const restoreReady = options.restoreReady ?? true;
  const recoveryWriteAllowed =
    options.recoveryWriteAllowed ?? allowRecoveryWritesByDefault;
  const recoveryWriteRevision = options.recoveryWriteRevision ?? 0;
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [persistenceIssue, setPersistenceIssue] = useState<string | null>(null);
  const [liveSessionController] = useState(() =>
    createLiveSessionController(indexedDbLiveSessionStore),
  );
  // Resolved after mount (it consults navigator/matchMedia) so server and
  // first client render agree; the queue only starts on user action anyway.
  const [parallelLimit, setParallelLimit] = useState(1);

  const filesRef = useRef(new Map<string, File>());
  const fileSignaturesRef = useRef(new Map<string, string>());
  const jobRunTokensRef = useRef(new Map<string, number>());
  const jobsRef = useRef<AnalysisJob[]>([]);
  const workspaceOpenRef = useRef(true);
  const lanesRef = useRef<WorkerLane[]>([]);
  const laneSequenceRef = useRef(0);
  const laneLimitRef = useRef(1);
  const heavyFileBytesRef = useRef(256 * 1024 * 1024);
  const decodeBudgetRef = useRef<DecodeBudget>(resolveDecodeBudget());
  const aggregatePeakBytesRef = useRef(
    conservativeDecodePeakBytes(resolveDecodeBudget()),
  );
  const reservedPeakBytesRef = useRef(0);
  const resourcePlansRef = useRef(new Map<string, JobResourcePlan>());
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
  const fillLanesRef = useRef<() => void>(() => undefined);
  const settingsRef = useRef<AnalyzerSettings>({
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
      analysisBlocked,
      analysisMode,
      decodePreference,
      target,
    };
  });

  const completedJobs = useMemo(() => getCompletedAnalysisJobs(jobs), [jobs]);
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
      setJobs((current) => {
        const next: AnalysisJob[] = current.map((job) =>
          job.id === jobId ? updater(job) : job,
        );
        jobsRef.current = next;
        return next;
      });
    },
    [],
  );

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

    return jobsRef.current.some((job) => job.id === jobId && isActiveJob(job));
  }, []);

  const updateJobIfRunCurrent = useCallback(
    (jobId: string, runToken: number, updater: (job: AnalysisJob) => AnalysisJob) => {
      if (jobRunTokensRef.current.get(jobId) !== runToken) {
        return;
      }

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

        jobsRef.current = next;
        return next;
      });
    },
    [],
  );

  const dropJobResources = useCallback((jobId: string) => {
    filesRef.current.delete(jobId);
    fileSignaturesRef.current.delete(jobId);
    jobRunTokensRef.current.delete(jobId);
    resourcePlansRef.current.delete(jobId);
  }, []);

  // Progress events arrive from up to laneLimit workers at once. This returns
  // the value to display, or null to skip the update entirely:
  // - clamps to never move backward within a run (each decode fallback path
  //   restarts its own 0..1 scale, which used to yank the bar from 78% to 42%
  //   or 46% to 3%; a retry resets progress to 0 *before* the next run starts,
  //   so the clamp can't pin a re-run at its old value), and
  // - skips updates that wouldn't visibly change the row, so render churn
  //   stays flat as parallelism grows.
  const nextProgressValue = useCallback(
    (jobId: string, status: AnalysisJob["status"], progress: number, label: string) => {
      const job = jobsRef.current.find((candidate) => candidate.id === jobId);
      if (!job) {
        return null;
      }

      const clamped = Math.max(job.progressPercent, progress);
      const visibleChange =
        job.status !== status ||
        job.progressLabel !== label ||
        Math.abs(job.progressPercent - clamped) >= 0.01;
      return visibleChange ? clamped : null;
    },
    [],
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
        const displayProgress = nextProgressValue(
          message.jobId,
          "decoding",
          message.progress,
          message.label,
        );
        if (displayProgress == null) {
          return;
        }

        updateJobIfRunCurrent(
          message.jobId,
          pending.lease.runToken,
          (job) => ({
            ...job,
            status: "decoding",
            progressPercent: Math.max(job.progressPercent, displayProgress),
            progressLabel: message.label,
          }),
        );
        return;
      }

      decoderPendingRef.current.delete(message.jobId);
      if (message.type === "decoded") {
        pending.resolve({ asset: message.asset, usage: message.usage });
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
        const displayProgress = nextProgressValue(
          message.jobId,
          "analyzing",
          mapped,
          message.label,
        );
        if (displayProgress == null) {
          return;
        }

        updateJobIfRunCurrent(
          message.jobId,
          pending.lease.runToken,
          (job) => ({
            ...job,
            status: "analyzing",
            progressPercent: Math.max(job.progressPercent, displayProgress),
            progressLabel: message.label,
          }),
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
  }, [nextProgressValue, updateJobIfRunCurrent]);

  const workerFault = useCallback(
    (lane: WorkerLane, workerEpoch: number, reason: string) => {
      if (lane.workerEpoch !== workerEpoch) {
        return;
      }

      terminateLaneWorkers(lane);
      lane.failureStreak += 1;
      rejectLanePending(lane, workerFailure(reason));

      if (lane.failureStreak >= MAX_LANE_FAILURE_STREAK) {
        lane.retireAfterRelease = true;
        workerCircuitOpenRef.current = true;
        if (!lane.lease) {
          const index = lanesRef.current.indexOf(lane);
          if (index >= 0) {
            lanesRef.current.splice(index, 1);
          }
        }
        pushNotice(
          "The analysis workers keep failing to start. Reload the page and try again.",
        );
        return;
      }

      const attachError = attachLaneWorkers(lane);
      if (attachError) {
        lane.failureStreak += 1;
        if (lane.failureStreak >= MAX_LANE_FAILURE_STREAK) {
          lane.retireAfterRelease = true;
          workerCircuitOpenRef.current = true;
          if (!lane.lease) {
            const index = lanesRef.current.indexOf(lane);
            if (index >= 0) {
              lanesRef.current.splice(index, 1);
            }
          }
          pushNotice(
            "The analysis workers keep failing to start. Reload the page and try again.",
          );
        }
      }
    },
    [attachLaneWorkers, pushNotice, rejectLanePending, terminateLaneWorkers],
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
      jobsRef.current.some(isActiveJob) ||
      !lanesRef.current.length
    ) {
      return;
    }

    idleTeardownRef.current = window.setTimeout(() => {
      idleTeardownRef.current = null;
      if (jobsRef.current.some(isActiveJob)) {
        return;
      }
      [...lanesRef.current].forEach(disposeIdleLane);
    }, IDLE_LANE_TEARDOWN_MS);
  }, [disposeIdleLane]);

  // Re-resolve the lane budget when the user preference changes (and once on
  // mount, where navigator/matchMedia first become available).
  useEffect(() => {
    const limit = resolveLaneLimit(parallelPreference);
    laneLimitRef.current = limit;
    heavyFileBytesRef.current = resolveHeavyFileBytes();
    aggregatePeakBytesRef.current = resolveAggregatePeakBytes(
      decodeBudgetRef.current,
    );
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
    const laneByJob = laneByJobRef.current;
    const jobRunTokens = jobRunTokensRef.current;

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
      laneByJob.clear();
      heavyJobActiveRef.current = null;
      reservedPeakBytesRef.current = 0;
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
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

    const persistenceToken = persistenceGenerationRef.current;
    void liveSessionController.read(persistenceToken).then((controllerResult) => {
      if (cancelled || generation !== restoreGenerationRef.current) {
        return;
      }

      const failure = persistenceFailureMessage(controllerResult, "restore");
      if (failure) {
        persistenceFailureEpochRef.current += 1;
        setPersistenceIssue(failure);
        pushNotice(failure);
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
        if (outcome.invalidRecordCount > 0) {
          pushNotice(
            `${outcome.invalidRecordCount} saved recovery record${outcome.invalidRecordCount === 1 ? " was" : "s were"} invalid and could not be restored. The stored records were left untouched.`,
          );
        }
        return;
      }

      // The stored results carry whatever target was active when they were
      // computed. Reconcile them to the settings that are active right now,
      // exactly like a job that finishes after a target switch; otherwise a
      // preset or mode change made before the refresh silently reverts.
      const settings = settingsRef.current;
      const restoredJobs = reconcileSessionJobs(loadedJobs, settings);

      // Mark as already persisted so the autosave diff below doesn't rewrite
      // every record straight back.
      restoredJobs.forEach((job) => {
        if (job.result) {
          persistedResultsRef.current.set(job.id, job.result.analyzedAt);
        }
      });

      // Count against the latest committed state, not inside the updater:
      // React runs updaters lazily, so a variable mutated in there is not
      // readable right after the setJobs call.
      const existingIds = new Set(jobsRef.current.map((job) => job.id));
      const fresh = restoredJobs.filter((job) => !existingIds.has(job.id));
      if (!fresh.length) {
        return;
      }

      setJobs((current) => {
        const currentIds = new Set(current.map((job) => job.id));
        const toAdd = fresh.filter((job) => !currentIds.has(job.id));
        if (!toAdd.length) {
          return current;
        }

        const next = [...current, ...toAdd];
        jobsRef.current = next;
        return next;
      });

      const recoveryNotes = [
        `Restored ${fresh.length} result${fresh.length === 1 ? "" : "s"} from your last session.`,
        outcome.invalidRecordCount
          ? `${outcome.invalidRecordCount} invalid stored record${outcome.invalidRecordCount === 1 ? " was" : "s were"} left untouched.`
          : null,
        outcome.overflowRecordCount
          ? `${outcome.overflowRecordCount} additional stored result${outcome.overflowRecordCount === 1 ? " remains" : "s remain"} outside the current restore limit.`
          : null,
      ].filter((part): part is string => part != null);
      pushNotice(recoveryNotes.join(" "));
    }).catch((error: unknown) => {
      if (cancelled || generation !== restoreGenerationRef.current) {
        return;
      }

      const message = `TruePeak could not restore the previous session. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`;
      persistenceFailureEpochRef.current += 1;
      setPersistenceIssue(message);
      pushNotice(message);
    });

    return () => {
      cancelled = true;
    };
  }, [liveSessionController, pushNotice, restoreReady]);

  // Autosave: mirror completed results into the live-session store, and drop
  // records for jobs that left the queue. Diffing against what's already
  // persisted keeps this a no-op on progress ticks.
  useEffect(() => {
    const allowSaves = recoveryWriteAllowed();
    const currentById = new Map<string, AnalysisJob>();
    jobs.forEach((job) => {
      if (job.result) {
        currentById.set(job.id, job);
      }
    });

    const toSave: AnalysisJob[] = [];
    currentById.forEach((job, jobId) => {
      if (persistedResultsRef.current.get(jobId) !== job.result!.analyzedAt) {
        toSave.push(job);
      }
    });

    const toDelete: string[] = [];
    persistedResultsRef.current.forEach((_, jobId) => {
      if (!currentById.has(jobId)) {
        toDelete.push(jobId);
      }
    });

    if (!toSave.length && !toDelete.length) {
      return;
    }

    // Mark optimistically so concurrent effect runs don't double-write. The
    // controller owns autonomous bounded retries; failed final outcomes roll
    // these marks back and surface a persistent issue instead of waiting for
    // an unrelated jobs update to happen to retry.
    const persistenceToken = persistenceGenerationRef.current;
    const persistenceIssueEpoch = persistenceFailureEpochRef.current;
    if (allowSaves && toSave.length) {
      toSave.forEach((job) =>
        persistedResultsRef.current.set(job.id, job.result!.analyzedAt),
      );
      void liveSessionController.write(toSave, persistenceToken).then((controllerResult) => {
        const failure = persistenceFailureMessage(controllerResult, "save");
        if (!failure) {
          if (
            controllerResult.outcome.status !== "superseded" &&
            persistenceFailureEpochRef.current === persistenceIssueEpoch
          ) {
            setPersistenceIssue(null);
          }
          return;
        }

        persistenceFailureEpochRef.current += 1;
        setPersistenceIssue(failure);
        pushNotice(failure);
        toSave.forEach((job) => {
          if (persistedResultsRef.current.get(job.id) === job.result!.analyzedAt) {
            persistedResultsRef.current.delete(job.id);
          }
        });
      }).catch((error: unknown) => {
        const message = `TruePeak could not save the recovery copy. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`;
        persistenceFailureEpochRef.current += 1;
        setPersistenceIssue(message);
        pushNotice(message);
        toSave.forEach((job) => {
          if (persistedResultsRef.current.get(job.id) === job.result!.analyzedAt) {
            persistedResultsRef.current.delete(job.id);
          }
        });
      });
    }

    if (toDelete.length) {
      const previousMarks = new Map(
        toDelete.map((jobId) => [jobId, persistedResultsRef.current.get(jobId)]),
      );
      toDelete.forEach((jobId) => persistedResultsRef.current.delete(jobId));
      void liveSessionController.delete(toDelete, persistenceToken).then((controllerResult) => {
        const failure = persistenceFailureMessage(controllerResult, "delete");
        if (!failure) {
          if (
            controllerResult.outcome.status !== "superseded" &&
            persistenceFailureEpochRef.current === persistenceIssueEpoch
          ) {
            setPersistenceIssue(null);
          }
          return;
        }

        persistenceFailureEpochRef.current += 1;
        setPersistenceIssue(failure);
        pushNotice(failure);
        previousMarks.forEach((analyzedAt, jobId) => {
          if (analyzedAt != null && !persistedResultsRef.current.has(jobId)) {
            persistedResultsRef.current.set(jobId, analyzedAt);
          }
        });
      }).catch((error: unknown) => {
        const message = `TruePeak could not update the recovery copy. ${error instanceof Error ? error.message : "Recovery storage failed unexpectedly."}`;
        persistenceFailureEpochRef.current += 1;
        setPersistenceIssue(message);
        pushNotice(message);
        previousMarks.forEach((analyzedAt, jobId) => {
          if (analyzedAt != null && !persistedResultsRef.current.has(jobId)) {
            persistedResultsRef.current.set(jobId, analyzedAt);
          }
        });
      });
    }
  }, [
    jobs,
    liveSessionController,
    pushNotice,
    recoveryWriteAllowed,
    recoveryWriteRevision,
  ]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  // Losing the tab mid-batch silently discards every queued and in-flight
  // result, so ask the browser to confirm while work is running.
  useEffect(() => {
    if (typeof window === "undefined" || !hasActiveJobs) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasActiveJobs]);

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

  useEffect(() => {
    if (!persistHistory) {
      historyFingerprintRef.current = "";
      return;
    }

    const fingerprint = completedHistoryFingerprint(jobs);
    if (!fingerprint) {
      historyFingerprintRef.current = "";
      return;
    }

    if (fingerprint === historyFingerprintRef.current) {
      return;
    }

    historyFingerprintRef.current = fingerprint;
    persistRecentSessions(jobs);
    setRecentSessions(loadRecentSessions());
  }, [jobs, persistHistory]);

  useEffect(() => {
    if (analysisBlocked) {
      return;
    }

    const nextTarget = analysisMode === "targeted" ? target ?? DEFAULT_TARGET_PRESET : null;

    setJobs((current) => {
      const next: AnalysisJob[] = current.map((job) =>
        job.result ? { ...job, result: retargetAnalysisResult(job.result, nextTarget) } : job,
      );
      jobsRef.current = next;
      return next;
    });
  }, [analysisBlocked, analysisMode, target]);

  const prepareResourcePlan = useCallback(
    async (jobId: string, file: File) => {
      if (resourcePlansRef.current.has(jobId)) {
        return;
      }

      resourcePlansRef.current.set(jobId, { kind: "preparing" });
      try {
        const budget = decodeBudgetRef.current;
        assertSourceWithinBudget(file.size, budget);

        // FLAC STREAMINFO and AIFF COMM normally live near the start. Small
        // sources are inspected in full (which also covers compact WAV files),
        // while large/opaque sources remain deliberately unknown and therefore
        // run exclusively rather than trusting a size-to-PCM guess.
        const preflightBytes =
          file.size <= 16 * 1024 * 1024
            ? file.size
            : Math.min(file.size, 256 * 1024);
        const header = await file.slice(0, preflightBytes).arrayBuffer();
        const metadata = inspectAudioContainer(header);
        const inspectedWholeFile = preflightBytes === file.size;
        const plan: JobResourcePlan = metadata
          ? {
              kind: "known",
              decodedBytes: assertDecodedFootprint(
                metadata,
                budget,
                "Container preflight",
              ).decodedBytes,
              // Only a complete integer-PCM WAV/AIFF shape is admitted as a
              // bounded native route. FLAC metadata and partial headers can be
              // contradicted by decoder output, so they stay conservative.
              trustedNative:
                inspectedWholeFile && metadata.nativeDecodeSafe,
            }
          : { kind: "unknown" };

        if (
          filesRef.current.get(jobId) === file &&
          resourcePlansRef.current.get(jobId)?.kind === "preparing"
        ) {
          resourcePlansRef.current.set(jobId, plan);
        }
      } catch (error) {
        if (
          filesRef.current.get(jobId) === file &&
          resourcePlansRef.current.get(jobId)?.kind === "preparing"
        ) {
          const details = decodeFailureDetails(error);
          resourcePlansRef.current.set(jobId, {
            kind: "rejected",
            error: details.message,
          });
          updateJob(jobId, (job) =>
            job.status === "queued"
              ? {
                  ...job,
                  status: "failed",
                  error: details.message,
                  progressPercent: 1,
                  progressLabel: "Resource limit",
                  finishedAtMs: Date.now(),
                }
              : job,
          );
        }
      } finally {
        fillLanesRef.current();
      }
    },
    [updateJob],
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
        workerCircuitOpenRef.current = true;
        pushNotice(
          "The analysis workers keep failing to start. Reload the page and try again.",
        );
      }
      throw attachError;
    },
    [attachLaneWorkers, pushNotice, terminateLaneWorkers],
  );

  const growLeasePeakReservation = useCallback(
    (
      lane: WorkerLane,
      lease: LaneLease,
      requiredPeakBytes: number,
      requireExclusive: boolean,
    ) => {
      if (lane.lease !== lease) {
        throw cancellationFailure("The decode lease is no longer current.");
      }
      if (
        requireExclusive &&
        lanesRef.current.some(
          (candidate) =>
            candidate !== lane && candidate.lease !== null,
        )
      ) {
        throw new DecodeResourceError(
          "decoded-budget-exceeded",
          "The fallback decoder needs an exclusive peak-memory reservation, but another decode is still active. Retry after the current batch advances.",
        );
      }

      const reservation = lease.reservation;
      const nextTotal = growDecodePeakReservation(
        reservedPeakBytesRef.current,
        reservation.peakBytes,
        requiredPeakBytes,
        aggregatePeakBytesRef.current,
      );

      // All validation happens above. Mutate the aggregate and its lease as one
      // synchronous step so no route can begin between the capacity check and
      // ownership update.
      reservedPeakBytesRef.current = nextTotal;
      if (requiredPeakBytes > reservation.peakBytes) {
        reservation.peakBytes = requiredPeakBytes;
      }
      if (requireExclusive && !reservation.exclusive) {
        reservation.exclusive = true;
        heavyJobActiveRef.current = lease.jobId;
      }
    },
    [],
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
            )
          : decodePeakResidentBytes(
              "native-worker",
              footprint.decodedBytes,
            );
      const conservativeRoute =
        browserRoute || workerUsage?.outputBytes != null;
      growLeasePeakReservation(
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
    [growLeasePeakReservation],
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
        updateJobIfRunCurrent(jobId, runToken, (job) => ({
          ...job,
          status: "decoding",
          // Never below the job's current progress: in the fallback path the
          // job arrives here already at 78%, and the old min() clamp dragged
          // it back to 42%.
          progressPercent: Math.max(job.progressPercent, Math.min(0.42, 0.18 + tick * 0.02)),
          progressLabel: "Still decoding locally - large files can take a moment",
        }));
      }, 4500);
    },
    [isJobRunCurrent, updateJobIfRunCurrent],
  );

  const releaseLane = useCallback(
    (lane: WorkerLane, lease: LaneLease, terminalSuccess: boolean) => {
      // A stale finally block must never release a newer job that has since
      // acquired this lane. Object identity plus generation makes that check
      // explicit instead of relying on a mutable jobId string.
      if (lane.lease !== lease || lane.leaseGeneration !== lease.generation) {
        return;
      }

      if (!lease.reservation.released) {
        lease.reservation.released = true;
        reservedPeakBytesRef.current = Math.max(
          0,
          reservedPeakBytesRef.current - lease.reservation.peakBytes,
        );
      }
      if (laneByJobRef.current.get(lease.jobId) === lane) {
        laneByJobRef.current.delete(lease.jobId);
      }
      if (heavyJobActiveRef.current === lease.jobId) {
        heavyJobActiveRef.current = null;
      }
      lane.lease = null;

      // Progress is not proof that the worker pair is healthy. Only a complete
      // decode+analysis result resets the consecutive transport-failure streak.
      if (terminalSuccess) {
        lane.failureStreak = 0;
      }

      if (lane.retireAfterRelease) {
        terminateLaneWorkers(lane);
        const index = lanesRef.current.indexOf(lane);
        if (index >= 0) {
          lanesRef.current.splice(index, 1);
        }
      }
      // A canceled browser decode can outlive the first idle timer because its
      // lease correctly remains busy while decodeAudioData drains. Re-arm the
      // timer now that this lane is genuinely idle.
      scheduleIdleLaneTeardown();
    },
    [scheduleIdleLaneTeardown, terminateLaneWorkers],
  );

  const runJob = useCallback(
    async (
      lane: WorkerLane,
      lease: LaneLease,
      currentTarget: TargetPreset | null,
      currentAnalysisMode: AnalysisMode,
      currentDecodePreference: DecodePreference,
    ) => {
      const { jobId, runToken } = lease;
      const file = filesRef.current.get(jobId);
      if (!file) {
        updateJobIfRunCurrent(jobId, runToken, (job) => ({
          ...job,
          status: "failed",
          error: "Original file handle was not available for retry.",
          progressLabel: "Missing file",
          progressPercent: 1,
          finishedAtMs: Date.now(),
        }));
        releaseLane(lane, lease, false);
        fillLanesRef.current();
        return;
      }

      let browserDecodeHeartbeat: number | null = null;
      let terminalSuccess = false;
      const leaseIsCurrent = () =>
        lane.lease === lease && isJobRunCurrent(jobId, runToken);

      const stopBrowserDecodeHeartbeat = () => {
        if (browserDecodeHeartbeat != null) {
          window.clearInterval(browserDecodeHeartbeat);
          browserDecodeHeartbeat = null;
        }
      };

      try {
        updateJobIfRunCurrent(jobId, runToken, (job) => ({
          ...job,
          status: "reading",
          progressPercent: 0.02,
          progressLabel: "Reading local file",
          startedAtMs: Date.now(),
          finishedAtMs: undefined,
        }));

        const mimeType = file.type || "application/octet-stream";
        let decoded: DecodedAudioTransfer;
        let workerUsage: DecodeResourceUsage | undefined;
        let decodedByBrowser = false;
        const browserFirst =
          currentDecodePreference === "browser-first" ||
          (currentDecodePreference === "auto" &&
            shouldPreferBrowserDecoder(file.name, mimeType));

        if (browserFirst) {
          growLeasePeakReservation(
            lane,
            lease,
            conservativeDecodePeakBytes(decodeBudgetRef.current),
            true,
          );
          updateJobIfRunCurrent(jobId, runToken, (job) => ({
            ...job,
            status: "decoding",
            progressPercent: 0.16,
            progressLabel:
              currentDecodePreference === "browser-first"
                ? "Using browser decoder preference"
                : "Trying browser decoder first",
          }));
          browserDecodeHeartbeat = startBrowserDecodeHeartbeat(jobId, runToken);

          try {
            decoded = await decodeAudioFileInBrowser(
              file,
              undefined,
              undefined,
              {
                signal: lease.browserAbortController.signal,
                budget: decodeBudgetRef.current,
              },
            );
            decodedByBrowser = true;
          } catch (browserError) {
            stopBrowserDecodeHeartbeat();
            if (!leaseIsCurrent()) {
              return;
            }
            if (!canTryAlternateDecoder(browserError)) {
              throw browserError;
            }

            const browserMessage =
              browserError instanceof Error
                ? browserError.message
                : "The browser decoder could not read this file.";

            updateJobIfRunCurrent(jobId, runToken, (job) => ({
              ...job,
              status: "decoding",
              progressPercent: 0.46,
              progressLabel: "Escalating to compatibility decoder",
            }));

            try {
              const workerResult = await decodeInWorker(
                lane,
                lease,
                file,
                mimeType,
              );
              decoded = workerResult.asset;
              workerUsage = workerResult.usage;
              decodedByBrowser = false;
            } catch (workerError) {
              if (!canTryAlternateDecoder(workerError)) {
                throw workerError;
              }
              const workerMessage =
                workerError instanceof Error
                  ? workerError.message
                  : "The compatibility decoder could not read this file.";
              throw new Error(
                `Browser decode failed: ${browserMessage}. Compatibility decode failed: ${workerMessage}`,
              );
            }
          }
        } else {
          try {
            const workerResult = await decodeInWorker(
              lane,
              lease,
              file,
              mimeType,
            );
            decoded = workerResult.asset;
            workerUsage = workerResult.usage;
          } catch (decodeError) {
            if (!leaseIsCurrent()) {
              return;
            }
            if (!canTryAlternateDecoder(decodeError)) {
              throw decodeError;
            }

            // The native route had a smaller checked reservation. Promote it
            // atomically to the conservative exclusive peak before invoking a
            // browser fallback that will allocate AudioBuffer + planar PCM.
            growLeasePeakReservation(
              lane,
              lease,
              conservativeDecodePeakBytes(decodeBudgetRef.current),
              true,
            );

            const primaryMessage =
              decodeError instanceof Error
                ? decodeError.message
                : "The primary decoder could not read this file.";

            updateJobIfRunCurrent(jobId, runToken, (job) => ({
              ...job,
              status: "decoding",
              progressPercent: 0.78,
              progressLabel: "Trying browser decoder fallback",
            }));

            try {
              browserDecodeHeartbeat = startBrowserDecodeHeartbeat(jobId, runToken);
              decoded = await decodeAudioFileInBrowser(
                file,
                primaryMessage,
                undefined,
                {
                  signal: lease.browserAbortController.signal,
                  budget: decodeBudgetRef.current,
                },
              );
              decodedByBrowser = true;
            } catch (fallbackError) {
              stopBrowserDecodeHeartbeat();
              if (!leaseIsCurrent()) {
                return;
              }
              if (!canTryAlternateDecoder(fallbackError)) {
                throw fallbackError;
              }

              const fallbackMessage =
                fallbackError instanceof Error
                  ? fallbackError.message
                  : "The browser decoder could not read this file.";
              throw new Error(
                `Primary decode failed: ${primaryMessage}. Browser fallback failed: ${fallbackMessage}`,
              );
            }
          }
        }
        stopBrowserDecodeHeartbeat();
        if (!leaseIsCurrent()) {
          return;
        }
        validateDecodedAssetForLease(
          lane,
          lease,
          decoded,
          workerUsage,
          decodedByBrowser,
        );

        updateJobIfRunCurrent(jobId, runToken, (job) => ({
          ...job,
          status: "analyzing",
          progressPercent: ANALYSIS_PROGRESS_BASE,
          progressLabel:
            currentAnalysisMode === "measure-only"
              ? "Measuring loudness, peaks, and dynamics"
              : "Analyzing loudness history",
        }));
        const targetForJob =
          currentAnalysisMode === "targeted"
            ? currentTarget ?? DEFAULT_TARGET_PRESET
            : null;
        const result = await analyzeInWorker(
          lane,
          lease,
          decoded,
          targetForJob,
        );
        if (!leaseIsCurrent()) {
          return;
        }

        // The target or analysis mode may have changed while this file was still
        // decoding/analyzing. Reconcile the freshly computed result to the current
        // settings so a job that finishes after a target switch doesn't keep a stale
        // target. (The retarget effect only re-maps already-completed jobs, so without
        // this a mid-flight job would slip through with the old target applied.)
        const latestSettings = settingsRef.current;
        const reconciledResult =
          result == null
            ? result
            : retargetAnalysisResult(
                result,
                latestSettings.analysisMode === "targeted"
                  ? latestSettings.target ?? DEFAULT_TARGET_PRESET
                  : null,
              );
        updateJobIfRunCurrent(jobId, runToken, (job) => ({
          ...job,
          status: "complete",
          progressPercent: 1,
          progressLabel: "Complete",
          result: reconciledResult,
          error: undefined,
          finishedAtMs: Date.now(),
        }));
        terminalSuccess = true;
      } catch (error) {
        stopBrowserDecodeHeartbeat();
        if (!leaseIsCurrent()) {
          return;
        }

        const rawMessage = error instanceof Error ? error.message : "The job failed.";
        const message = normalizeDecodeFailure(rawMessage, currentDecodePreference);
        const canceled = isCancellationReason(message);
        updateJobIfRunCurrent(jobId, runToken, (job) => ({
          ...job,
          status: canceled ? "canceled" : "failed",
          error: canceled ? undefined : message,
          progressLabel: canceled ? "Canceled" : "Failed",
          progressPercent: 1,
          finishedAtMs: Date.now(),
        }));
      } finally {
        stopBrowserDecodeHeartbeat();
        releaseLane(lane, lease, terminalSuccess);
        // The freed lane can pick up the next queued file right away.
        fillLanesRef.current();
      }
    },
    [
      analyzeInWorker,
      decodeInWorker,
      isJobRunCurrent,
      growLeasePeakReservation,
      releaseLane,
      startBrowserDecodeHeartbeat,
      updateJobIfRunCurrent,
      validateDecodedAssetForLease,
    ],
  );

  // Hand queued jobs to free lanes. A checked preflight reserves decoded PCM,
  // not compressed source bytes. Sources whose footprint cannot be established
  // safely run alone, as do very large files, so an optimistic estimate can
  // never multiply across lanes.
  const fillLanes = useCallback(() => {
    if (
      !workspaceOpenRef.current ||
      settingsRef.current.analysisBlocked ||
      heavyJobActiveRef.current ||
      workerCircuitOpenRef.current
    ) {
      return;
    }

    // Enforce a lowered lane budget mid-batch. The preference effect can only
    // dispose lanes that are idle at that moment; lanes that were busy then
    // must be culled here as they free up, otherwise the queue keeps running
    // at the old concurrency until it drains.
    while (lanesRef.current.length > laneLimitRef.current) {
      const idle = lanesRef.current.find((lane) => lane.lease === null);
      if (!idle) {
        break;
      }

      disposeIdleLane(idle);
    }

    const acquireLane = (): WorkerLane | null => {
      const idle = lanesRef.current.find(
        (lane) => lane.lease === null && !lane.retireAfterRelease,
      );
      if (idle) {
        return idle;
      }

      if (lanesRef.current.length >= laneLimitRef.current) {
        return null;
      }

      const lane: WorkerLane = {
        id: laneSequenceRef.current++,
        decoder: null,
        analyzer: null,
        workerEpoch: 0,
        leaseGeneration: 0,
        lease: null,
        retireAfterRelease: false,
        failureStreak: 0,
      };
      const attachError = attachLaneWorkers(lane);
      if (attachError) {
        lane.failureStreak = 1;
      }
      lanesRef.current.push(lane);
      return lane;
    };

    for (const job of jobsRef.current) {
      if (job.status !== "queued" || laneByJobRef.current.has(job.id)) {
        continue;
      }

      const file = filesRef.current.get(job.id);
      if (!file) {
        updateJob(job.id, (current) => ({
          ...current,
          status: "failed",
          error: "Original file handle is not available.",
          progressPercent: 1,
          progressLabel: "Missing file",
          finishedAtMs: Date.now(),
        }));
        continue;
      }

      const plan = resourcePlansRef.current.get(job.id);
      if (!plan) {
        void prepareResourcePlan(job.id, file);
        break;
      }
      if (plan.kind === "preparing") {
        break;
      }
      if (plan.kind === "rejected") {
        continue;
      }

      const settings = settingsRef.current;
      const mimeType = file.type || "application/octet-stream";
      const browserFirst =
        settings.decodePreference === "browser-first" ||
        (settings.decodePreference === "auto" &&
          shouldPreferBrowserDecoder(file.name, mimeType));
      const trustedNativePrimary =
        plan.kind === "known" && plan.trustedNative && !browserFirst;
      const exclusive =
        file.size >= heavyFileBytesRef.current || !trustedNativePrimary;
      if (
        exclusive &&
        lanesRef.current.some((lane) => lane.lease !== null)
      ) {
        break;
      }

      const reservationPeakBytes = trustedNativePrimary
        ? decodePeakResidentBytes("native-worker", plan.decodedBytes)
        : conservativeDecodePeakBytes(decodeBudgetRef.current);
      let nextReservedPeakBytes: number;
      try {
        nextReservedPeakBytes = growDecodePeakReservation(
          reservedPeakBytesRef.current,
          0,
          reservationPeakBytes,
          aggregatePeakBytesRef.current,
        );
      } catch {
        break;
      }

      const lane = acquireLane();
      if (!lane) {
        break;
      }

      const runToken = beginJobRun(job.id);
      lane.leaseGeneration += 1;
      const lease: LaneLease = Object.freeze({
        laneId: lane.id,
        generation: lane.leaseGeneration,
        jobId: job.id,
        runToken,
        reservation: {
          plannedPeakBytes: reservationPeakBytes,
          peakBytes: reservationPeakBytes,
          exclusive,
          released: false,
        },
        browserAbortController: new AbortController(),
      });
      lane.lease = lease;
      reservedPeakBytesRef.current = nextReservedPeakBytes;
      laneByJobRef.current.set(job.id, lane);
      if (exclusive) {
        heavyJobActiveRef.current = job.id;
      }
      void runJob(
        lane,
        lease,
        settings.target,
        settings.analysisMode,
        settings.decodePreference,
      );
      if (exclusive) {
        break;
      }
    }
  }, [
    attachLaneWorkers,
    beginJobRun,
    disposeIdleLane,
    prepareResourcePlan,
    runJob,
    updateJob,
  ]);

  useEffect(() => {
    fillLanesRef.current = fillLanes;
  }, [fillLanes]);

  useEffect(() => {
    fillLanes();
  }, [analysisBlocked, fillLanes, jobs]);

  const enqueueFiles = useCallback((input: FileList | File[]) => {
    const allFiles = Array.from(input);
    // One session is a review desk, not a database. The session limit is global:
    // it is enforced against every job already in the session, not per add, so a
    // runaway selection, a dropped drive, or a sequence of adds can never push
    // the session past MAX_SESSION_JOBS and freeze the tab. Overflow is reported
    // in the notice below, never silently dropped.
    const intakePlan = planSessionIntake(jobsRef.current.length, allFiles.length);
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
      workerCircuitOpenRef.current = false;
      setJobs((current) => {
        const merged = [...nextJobs, ...current];
        jobsRef.current = merged;
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
  }, [pushNotice]);

  const cancelJob = useCallback((jobId: string) => {
    invalidateJobRun(jobId);
    const lane = laneByJobRef.current.get(jobId);
    if (lane) {
      interruptLane(lane, "Job canceled.");
    }

    updateJob(jobId, (job) => ({
      ...job,
      status: "canceled",
      progressPercent: 1,
      progressLabel: "Canceled",
      error: undefined,
    }));
    fillLanesRef.current();
  }, [interruptLane, invalidateJobRun, updateJob]);

  const cancelActiveJobs = useCallback(() => {
    const activeIds = new Set(
      jobsRef.current.filter(isActiveJob).map((job) => job.id),
    );

    if (!activeIds.size) {
      return;
    }

    activeIds.forEach(invalidateJobRun);
    lanesRef.current.forEach((lane) => {
      if (lane.lease !== null && activeIds.has(lane.lease.jobId)) {
        interruptLane(lane, "Jobs canceled.");
      }
    });

    setJobs((current) => {
      const next: AnalysisJob[] = current.map((job) =>
        activeIds.has(job.id)
          ? {
              ...job,
              status: "canceled",
              progressPercent: 1,
              progressLabel: "Canceled",
              error: undefined,
            }
          : job,
      );
      jobsRef.current = next;
      return next;
    });
    pushNotice(
      `Canceled ${activeIds.size} active job${activeIds.size === 1 ? "" : "s"}.`,
    );
  }, [interruptLane, invalidateJobRun, pushNotice]);

  const retryJob = useCallback((jobId: string) => {
    if (!filesRef.current.has(jobId)) {
      return;
    }

    invalidateJobRun(jobId);
    resourcePlansRef.current.delete(jobId);
    workerCircuitOpenRef.current = false;
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
  }, [invalidateJobRun, updateJob]);

  const retryIssues = useCallback(() => {
    const retryIds = new Set(
      jobsRef.current
        .filter((job) => isIssueJob(job) && filesRef.current.has(job.id))
        .map((job) => job.id),
    );

    retryIds.forEach((jobId) => {
      invalidateJobRun(jobId);
      resourcePlansRef.current.delete(jobId);
    });
    if (retryIds.size) {
      workerCircuitOpenRef.current = false;
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
      jobsRef.current = next;
      return next;
    });

    if (retryIds.size) {
      pushNotice(`Re-queued ${retryIds.size} issue job${retryIds.size === 1 ? "" : "s"}.`);
    }
  }, [invalidateJobRun, pushNotice]);

  const removeJob = useCallback((jobId: string) => {
    invalidateJobRun(jobId);
    const lane = laneByJobRef.current.get(jobId);
    if (lane) {
      interruptLane(lane, "Job removed.");
    }

    dropJobResources(jobId);
    setJobs((current) => {
      const next = current.filter((job) => job.id !== jobId);
      jobsRef.current = next;
      return next;
    });
    fillLanesRef.current();
  }, [dropJobResources, interruptLane, invalidateJobRun]);

  const clearFinished = useCallback(() => {
    setJobs((current) => {
      const finishedIds = new Set(
        current
          .filter((job) => job.status === "complete" || isIssueJob(job))
          .map((job) => job.id),
      );
      finishedIds.forEach(dropJobResources);
      const keep = current.filter((job) => !finishedIds.has(job.id));
      jobsRef.current = keep;
      return keep;
    });
    pushNotice("Cleared finished jobs from the queue.");
  }, [dropJobResources, pushNotice]);

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
    persistedResultsRef.current.clear();
    setJobs(() => {
      jobsRef.current = [];
      return [];
    });
    void clearPromise.then((controllerResult) => {
      const failure = persistenceFailureMessage(controllerResult, "clear");
      if (failure) {
        persistenceFailureEpochRef.current += 1;
        const message = `The visible session was cleared, but its browser recovery copy may remain. ${failure}`;
        setPersistenceIssue(message);
        pushNotice(message);
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
      pushNotice(message);
    });
  }, [interruptLane, liveSessionController, pushNotice]);

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
        buildCsvExport(jobsRef.current),
        "text/csv;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the CSV download. Try again or use another export format.");
    }
  }, [pushNotice]);
  const exportJson = useCallback(() => {
    try {
      downloadTextFile(
        getExportFileName("json"),
        buildJsonExport(jobsRef.current),
        "application/json;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the JSON download. Try again or use another export format.");
    }
  }, [pushNotice]);
  const exportMarkdown = useCallback(() => {
    try {
      downloadTextFile(
        getExportFileName("markdown"),
        buildMarkdownExport(jobsRef.current),
        "text/markdown;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the Markdown report download. Try again or use another export format.");
    }
  }, [pushNotice]);

  const exportSession = useCallback(() => {
    try {
      downloadTextFile(
        getSessionFileName(),
        buildSessionFile(jobsRef.current),
        "application/json;charset=utf-8",
      );
    } catch (error) {
      pushNotice(
        error instanceof Error
          ? error.message
          : "The browser blocked the session download. Try again.",
      );
    }
  }, [pushNotice]);

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
        jobsRef.current,
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
        jobsRef.current = next;
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
    [pushNotice],
  );

  return {
    jobs,
    completedJobs,
    recentSessions,
    notice,
    persistenceIssue,
    parallelLimit,
    enqueueFiles,
    cancelJob,
    cancelActiveJobs,
    retryJob,
    retryIssues,
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
