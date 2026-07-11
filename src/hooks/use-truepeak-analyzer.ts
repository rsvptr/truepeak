"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getComplianceSummary } from "@/audio/compliance";
import {
  decodeAudioFileInBrowser,
  shouldPreferBrowserDecoder,
} from "@/audio/browser-decode";
import {
  buildCsvExport,
  buildJsonExport,
  buildMarkdownExport,
  getExportFileName,
} from "@/audio/export";
import {
  MAX_SESSION_FILE_BYTES,
  buildSessionFile,
  getSessionFileName,
  parseSessionFile,
} from "@/audio/session-file";
import {
  clearLiveSession,
  loadLiveSessionJobs,
  persistLiveSessionJobs,
  removeLiveSessionJobs,
} from "@/audio/live-session-store";
import {
  clearPersistedRecentSessions,
  loadRecentSessions,
  persistRecentSessions,
} from "@/audio/persistence";
import { DEFAULT_TARGET_PRESET } from "@/audio/presets";
import { retargetAnalysisResult } from "@/audio/targeting";
import { getCompletedAnalysisJobs, isActiveJob } from "@/lib/session-selectors";
import { makeId } from "@/lib/utils";
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
} from "@/workers/shared/messages";

interface PendingResolver<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

// A lane is an independent decoder+analyzer worker pair that owns at most one
// job at a time. Multiple lanes let the queue process files in parallel while
// keeping the original per-job semantics: canceling or removing an active job
// terminates only its own lane's workers, never a neighbour's.
interface WorkerLane {
  id: number;
  decoder: Worker;
  analyzer: Worker;
  jobId: string | null;
}

// Where analysis begins on the job's overall progress bar (read+decode owns
// everything before it). Analyzer worker fractions are mapped above this.
const ANALYSIS_PROGRESS_BASE = 0.86;

// Tear idle lanes down after this long with nothing active. Workers (and any
// lazily loaded ffmpeg.wasm heaps inside them) are not free to keep around,
// especially on phones; fresh lanes spin up in milliseconds when needed.
const IDLE_LANE_TEARDOWN_MS = 45_000;

// Hard ceiling on files accepted into one session in a single add.
const MAX_INTAKE_FILES = 2000;

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
export function resolveLaneLimit(preference: "auto" | "1" | "2" | "4" = "auto") {
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

interface UseTruePeakAnalyzerOptions {
  analysisMode?: AnalysisMode;
  analysisBlocked?: boolean;
  decodePreference?: DecodePreference;
  persistHistory?: boolean;
  parallelPreference?: "auto" | "1" | "2" | "4";
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

function fileSignature(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
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
        result.metrics.truePeakDbtp,
        result.metrics.loudnessRange,
        result.metadata.sampleRate,
        result.metadata.channelLayout.name,
        result.metadata.decoderLabel,
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

export function useTruePeakAnalyzer(
  target: TargetPreset | null = DEFAULT_TARGET_PRESET,
  options: UseTruePeakAnalyzerOptions = {},
) {
  const analysisMode = options.analysisMode ?? "targeted";
  const analysisBlocked = options.analysisBlocked ?? false;
  const decodePreference = options.decodePreference ?? "auto";
  const persistHistory = options.persistHistory ?? false;
  const parallelPreference = options.parallelPreference ?? "auto";
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Resolved after mount (it consults navigator/matchMedia) so server and
  // first client render agree; the queue only starts on user action anyway.
  const [parallelLimit, setParallelLimit] = useState(1);

  const filesRef = useRef(new Map<string, File>());
  const fileSignaturesRef = useRef(new Map<string, string>());
  const jobRunTokensRef = useRef(new Map<string, number>());
  const jobsRef = useRef<AnalysisJob[]>([]);
  const lanesRef = useRef<WorkerLane[]>([]);
  const laneSequenceRef = useRef(0);
  const laneLimitRef = useRef(1);
  const heavyFileBytesRef = useRef(256 * 1024 * 1024);
  const idleTeardownRef = useRef<number | null>(null);
  const laneByJobRef = useRef(new Map<string, WorkerLane>());
  const heavyJobActiveRef = useRef<string | null>(null);
  const decoderPendingRef = useRef(
    new Map<string, PendingResolver<DecodedAudioTransfer>>(),
  );
  const analyzerPendingRef = useRef(
    new Map<string, PendingResolver<AnalysisJob["result"]>>(),
  );
  const historyFingerprintRef = useRef("");
  // id -> analyzedAt of results already written to the live-session store.
  const persistedResultsRef = useRef(new Map<string, string>());
  const didRestoreRef = useRef(false);
  const resetLaneRef = useRef<(lane: WorkerLane, reason?: string) => void>(() => undefined);
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
    if (jobRunTokensRef.current.get(jobId) !== runToken) {
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

  const attachLaneWorkers = useCallback((lane: WorkerLane) => {
    const decoderWorker = new Worker(
      new URL("../workers/decoder.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    const analyzerWorker = new Worker(
      new URL("../workers/analyzer.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );

    decoderWorker.onerror = (event) => {
      event.preventDefault();
      resetLaneRef.current(lane, describeWorkerFailure("Decoder", event));
    };
    decoderWorker.onmessageerror = (event) => {
      resetLaneRef.current(lane, describeWorkerFailure("Decoder", event));
    };
    decoderWorker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        if (!decoderPendingRef.current.has(message.jobId)) {
          return;
        }

        const displayProgress = nextProgressValue(message.jobId, "decoding", message.progress, message.label);
        if (displayProgress == null) {
          return;
        }

        updateJob(message.jobId, (job) => ({
          ...job,
          status: "decoding",
          progressPercent: Math.max(job.progressPercent, displayProgress),
          progressLabel: message.label,
        }));
        return;
      }

      const pending = decoderPendingRef.current.get(message.jobId);
      if (!pending) {
        return;
      }

      decoderPendingRef.current.delete(message.jobId);
      if (message.type === "decoded") {
        pending.resolve(message.asset);
        return;
      }

      pending.reject(new Error(message.error));
    };

    analyzerWorker.onerror = (event) => {
      event.preventDefault();
      resetLaneRef.current(lane, describeWorkerFailure("Analyzer", event));
    };
    analyzerWorker.onmessageerror = (event) => {
      resetLaneRef.current(lane, describeWorkerFailure("Analyzer", event));
    };
    analyzerWorker.onmessage = (event: MessageEvent<AnalyzerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        if (!analyzerPendingRef.current.has(message.jobId)) {
          return;
        }

        // The analyzer reports its own 0..1 fraction; analysis occupies the
        // tail of the job's overall progress, after read+decode.
        const mapped = Math.min(0.99, ANALYSIS_PROGRESS_BASE + message.progress * (0.99 - ANALYSIS_PROGRESS_BASE));
        const displayProgress = nextProgressValue(message.jobId, "analyzing", mapped, message.label);
        if (displayProgress == null) {
          return;
        }

        updateJob(message.jobId, (job) => ({
          ...job,
          status: "analyzing",
          progressPercent: Math.max(job.progressPercent, displayProgress),
          progressLabel: message.label,
        }));
        return;
      }

      const pending = analyzerPendingRef.current.get(message.jobId);
      if (!pending) {
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
  }, [nextProgressValue, updateJob]);

  // Terminate and replace one lane's workers, failing only the job that lane
  // was running. Other lanes keep working untouched.
  const resetLane = useCallback(
    (lane: WorkerLane, reason = "Worker restarted.") => {
      lane.decoder.terminate();
      lane.analyzer.terminate();

      const jobId = lane.jobId;
      if (jobId) {
        const decoderPending = decoderPendingRef.current.get(jobId);
        if (decoderPending) {
          decoderPendingRef.current.delete(jobId);
          decoderPending.reject(new Error(reason));
        }

        const analyzerPending = analyzerPendingRef.current.get(jobId);
        if (analyzerPending) {
          analyzerPendingRef.current.delete(jobId);
          analyzerPending.reject(new Error(reason));
        }

        laneByJobRef.current.delete(jobId);
        if (heavyJobActiveRef.current === jobId) {
          heavyJobActiveRef.current = null;
        }
      }

      lane.jobId = null;
      attachLaneWorkers(lane);
    },
    [attachLaneWorkers],
  );

  useEffect(() => {
    resetLaneRef.current = resetLane;
  }, [resetLane]);

  // Terminate an idle lane and remove it. Mutates lanesRef's array in place so
  // the unmount cleanup (which captured the array) still sees every live lane.
  const disposeIdleLane = useCallback((lane: WorkerLane) => {
    if (lane.jobId !== null) {
      return;
    }

    lane.decoder.terminate();
    lane.analyzer.terminate();
    const index = lanesRef.current.indexOf(lane);
    if (index >= 0) {
      lanesRef.current.splice(index, 1);
    }
  }, []);

  // Re-resolve the lane budget when the user preference changes (and once on
  // mount, where navigator/matchMedia first become available).
  useEffect(() => {
    const limit = resolveLaneLimit(parallelPreference);
    laneLimitRef.current = limit;
    heavyFileBytesRef.current = resolveHeavyFileBytes();
    setParallelLimit(limit);
    // Shrink immediately if the new budget is lower; busy lanes finish their
    // current file first (no new work lands on them past the limit).
    const busyCount = lanesRef.current.filter((lane) => lane.jobId !== null).length;
    const idleLanes = lanesRef.current.filter((lane) => lane.jobId === null);
    const idleToKeep = Math.max(0, limit - busyCount);
    idleLanes.slice(idleToKeep).forEach(disposeIdleLane);
    fillLanesRef.current();
  }, [disposeIdleLane, parallelPreference]);

  // Free idle workers (and any ffmpeg.wasm heaps inside them) once the queue
  // has been quiet for a while; they respawn on demand in milliseconds.
  useEffect(() => {
    if (idleTeardownRef.current != null) {
      window.clearTimeout(idleTeardownRef.current);
      idleTeardownRef.current = null;
    }

    if (hasActiveJobs || !lanesRef.current.length) {
      return;
    }

    idleTeardownRef.current = window.setTimeout(() => {
      idleTeardownRef.current = null;
      if (jobsRef.current.some(isActiveJob)) {
        return;
      }

      [...lanesRef.current].forEach(disposeIdleLane);
    }, IDLE_LANE_TEARDOWN_MS);

    return () => {
      if (idleTeardownRef.current != null) {
        window.clearTimeout(idleTeardownRef.current);
        idleTeardownRef.current = null;
      }
    };
  }, [disposeIdleLane, hasActiveJobs]);

  useEffect(() => {
    const lanes = lanesRef.current;
    const decoderPending = decoderPendingRef.current;
    const analyzerPending = analyzerPendingRef.current;
    const laneByJob = laneByJobRef.current;

    return () => {
      lanes.forEach((lane) => {
        lane.decoder.terminate();
        lane.analyzer.terminate();
      });
      lanes.length = 0;
      decoderPending.forEach(({ reject }) => reject(new Error("Workspace closed.")));
      analyzerPending.forEach(({ reject }) => reject(new Error("Workspace closed.")));
      decoderPending.clear();
      analyzerPending.clear();
      laneByJob.clear();
      heavyJobActiveRef.current = null;
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setRecentSessions(persistHistory ? loadRecentSessions() : []);
  }, [persistHistory]);

  // Restore the previous session's completed results once on load. Restored
  // jobs are view-only (no File handle survives a refresh), exactly like jobs
  // imported from a session file.
  useEffect(() => {
    if (didRestoreRef.current) {
      return;
    }

    didRestoreRef.current = true;
    let cancelled = false;

    void loadLiveSessionJobs().then((restoredJobs) => {
      if (cancelled || !restoredJobs.length) {
        return;
      }

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

      pushNotice(
        `Restored ${fresh.length} result${fresh.length === 1 ? "" : "s"} from your last session.`,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [pushNotice]);

  // Autosave: mirror completed results into the live-session store, and drop
  // records for jobs that left the queue. Diffing against what's already
  // persisted keeps this a no-op on progress ticks.
  useEffect(() => {
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

    // Mark optimistically so concurrent effect runs don't double-write, but
    // roll the marks back if the transaction fails (e.g. storage quota), so
    // the next jobs change retries instead of silently dropping the records.
    toSave.forEach((job) => persistedResultsRef.current.set(job.id, job.result!.analyzedAt));
    if (toSave.length) {
      void persistLiveSessionJobs(toSave).then((committed) => {
        if (committed) {
          return;
        }

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
      void removeLiveSessionJobs(toDelete).then((committed) => {
        if (committed) {
          return;
        }

        previousMarks.forEach((analyzedAt, jobId) => {
          if (analyzedAt != null && !persistedResultsRef.current.has(jobId)) {
            persistedResultsRef.current.set(jobId, analyzedAt);
          }
        });
      });
    }
  }, [jobs]);

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

  const decodeInWorker = useCallback(
    (lane: WorkerLane, jobId: string, file: File, mimeType: string) =>
      new Promise<DecodedAudioTransfer>((resolve, reject) => {
        decoderPendingRef.current.set(jobId, { resolve, reject });
        try {
          // Send the File handle; the worker reads the bytes itself so the
          // main thread never holds a full copy of a large file.
          lane.decoder.postMessage(
            { type: "decode", jobId, fileName: file.name, mimeType, file } satisfies DecoderRequest,
          );
        } catch (error) {
          decoderPendingRef.current.delete(jobId);
          const message = error instanceof Error ? error.message : "Unable to send audio to the decoder worker.";
          reject(new Error(message));
          resetLaneRef.current(lane, `Decoder worker post failed: ${message}`);
        }
      }),
    [],
  );

  const analyzeInWorker = useCallback(
    (lane: WorkerLane, jobId: string, asset: DecodedAudioTransfer, currentTarget: TargetPreset | null) =>
      new Promise<AnalysisJob["result"]>((resolve, reject) => {
        analyzerPendingRef.current.set(jobId, { resolve, reject });
        try {
          lane.analyzer.postMessage({
            type: "analyze",
            jobId,
            asset,
            target: currentTarget,
          } satisfies AnalyzerRequest, asset.channelBuffers);
        } catch (error) {
          analyzerPendingRef.current.delete(jobId);
          const message = error instanceof Error ? error.message : "Unable to send audio to the analyzer worker.";
          reject(new Error(message));
          resetLaneRef.current(lane, `Analyzer worker post failed: ${message}`);
        }
      }),
    [],
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

  const releaseLane = useCallback((jobId: string) => {
    const lane = laneByJobRef.current.get(jobId);
    if (lane && lane.jobId === jobId) {
      lane.jobId = null;
    }

    laneByJobRef.current.delete(jobId);
    if (heavyJobActiveRef.current === jobId) {
      heavyJobActiveRef.current = null;
    }
  }, []);

  const runJob = useCallback(
    async (
      jobId: string,
      lane: WorkerLane,
      currentTarget: TargetPreset | null,
      currentAnalysisMode: AnalysisMode,
      currentDecodePreference: DecodePreference,
    ) => {
      const runToken = beginJobRun(jobId);
      const file = filesRef.current.get(jobId);
      if (!file) {
        releaseLane(jobId);
        updateJob(jobId, (job) => ({
          ...job,
          status: "failed",
          error: "Original file handle was not available for retry.",
          progressLabel: "Missing file",
          progressPercent: 1,
        }));
        return;
      }

      let browserDecodeHeartbeat: number | null = null;

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
        const browserFirst =
          currentDecodePreference === "browser-first" ||
          (currentDecodePreference === "auto" &&
            shouldPreferBrowserDecoder(file.name, mimeType));

        if (browserFirst) {
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
            decoded = await decodeAudioFileInBrowser(file);
          } catch (browserError) {
            stopBrowserDecodeHeartbeat();
            if (!isJobRunCurrent(jobId, runToken)) {
              return;
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
              decoded = await decodeInWorker(lane, jobId, file, mimeType);
            } catch (workerError) {
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
            decoded = await decodeInWorker(lane, jobId, file, mimeType);
          } catch (decodeError) {
            if (!isJobRunCurrent(jobId, runToken)) {
              return;
            }

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
              decoded = await decodeAudioFileInBrowser(file, primaryMessage);
            } catch (fallbackError) {
              stopBrowserDecodeHeartbeat();
              if (!isJobRunCurrent(jobId, runToken)) {
                return;
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
        if (!isJobRunCurrent(jobId, runToken)) {
          return;
        }

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
        const result = await analyzeInWorker(lane, jobId, decoded, targetForJob);
        if (!isJobRunCurrent(jobId, runToken)) {
          return;
        }

        // The target or analysis mode may have changed while this file was still
        // decoding/analyzing. Reconcile the freshly computed result to the current
        // settings so a job that finishes after a target switch doesn't keep a stale
        // target. (The retarget effect only re-maps already-completed jobs, so without
        // this a mid-flight job would slip through with the old target applied.)
        const latestSettings = settingsRef.current;
        const reconciledResult =
          result == null || latestSettings.analysisBlocked
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
      } catch (error) {
        stopBrowserDecodeHeartbeat();
        if (!isJobRunCurrent(jobId, runToken)) {
          return;
        }

        const rawMessage = error instanceof Error ? error.message : "The job failed.";
        const message = normalizeDecodeFailure(rawMessage, currentDecodePreference);
        const canceled =
          message.toLowerCase().includes("cancel") ||
          message.toLowerCase().includes("restarted") ||
          message.toLowerCase().includes("removed");
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
        releaseLane(jobId);
        // The freed lane can pick up the next queued file right away.
        fillLanesRef.current();
      }
    },
    [
      analyzeInWorker,
      beginJobRun,
      decodeInWorker,
      isJobRunCurrent,
      releaseLane,
      startBrowserDecodeHeartbeat,
      updateJob,
      updateJobIfRunCurrent,
    ],
  );

  // Hand queued jobs to free lanes. Lanes are created on demand up to the
  // device-derived limit. Heavy files run exclusively: nothing new starts while
  // one is active, and one only starts once every lane is idle (draining first
  // keeps FIFO order, so a large master can't be starved by a stream of small
  // files behind it).
  const fillLanes = useCallback(() => {
    if (settingsRef.current.analysisBlocked || heavyJobActiveRef.current) {
      return;
    }

    const acquireLane = (): WorkerLane | null => {
      const idle = lanesRef.current.find((lane) => lane.jobId === null);
      if (idle) {
        return idle;
      }

      if (lanesRef.current.length >= laneLimitRef.current) {
        return null;
      }

      const lane: WorkerLane = {
        id: laneSequenceRef.current++,
        decoder: null as unknown as Worker,
        analyzer: null as unknown as Worker,
        jobId: null,
      };
      attachLaneWorkers(lane);
      lanesRef.current.push(lane);
      return lane;
    };

    for (const job of jobsRef.current) {
      if (job.status !== "queued" || laneByJobRef.current.has(job.id)) {
        continue;
      }

      const file = filesRef.current.get(job.id);
      const heavy = !!file && file.size >= heavyFileBytesRef.current;
      if (heavy) {
        if (lanesRef.current.some((lane) => lane.jobId !== null)) {
          break;
        }

        const lane = acquireLane();
        if (!lane) {
          break;
        }

        lane.jobId = job.id;
        laneByJobRef.current.set(job.id, lane);
        heavyJobActiveRef.current = job.id;
        const settings = settingsRef.current;
        void runJob(job.id, lane, settings.target, settings.analysisMode, settings.decodePreference);
        break;
      }

      const lane = acquireLane();
      if (!lane) {
        break;
      }

      lane.jobId = job.id;
      laneByJobRef.current.set(job.id, lane);
      const settings = settingsRef.current;
      void runJob(job.id, lane, settings.target, settings.analysisMode, settings.decodePreference);
    }
  }, [attachLaneWorkers, runJob]);

  useEffect(() => {
    fillLanesRef.current = fillLanes;
  }, [fillLanes]);

  useEffect(() => {
    fillLanes();
  }, [analysisBlocked, fillLanes, jobs]);

  const enqueueFiles = useCallback((input: FileList | File[]) => {
    const allFiles = Array.from(input);
    // One session is a review desk, not a database; a runaway selection (or a
    // dropped drive) gets cut off instead of freezing the tab with jobs.
    const files = allFiles.slice(0, MAX_INTAKE_FILES);
    const skippedOverCap = allFiles.length - files.length;
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

      const signature = fileSignature(file);
      if (knownSignatures.has(signature)) {
        skippedDuplicates += 1;
        return;
      }

      knownSignatures.add(signature);
      accepted.push(file);
    });

    const nextJobs = accepted.map<AnalysisJob>((file) => {
      const id = makeId("analysis");
      filesRef.current.set(id, file);
      fileSignaturesRef.current.set(id, fileSignature(file));
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
        ? `${skippedOverCap} over the ${MAX_INTAKE_FILES}-file session limit`
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
      resetLane(lane, "Job canceled.");
    }

    updateJob(jobId, (job) => ({
      ...job,
      status: "canceled",
      progressPercent: 1,
      progressLabel: "Canceled",
      error: undefined,
    }));
    fillLanesRef.current();
  }, [invalidateJobRun, resetLane, updateJob]);

  const cancelActiveJobs = useCallback(() => {
    const activeIds = jobsRef.current
      .filter((job) => ["queued", "reading", "decoding", "analyzing"].includes(job.status))
      .map((job) => job.id);

    if (!activeIds.length) {
      return;
    }

    activeIds.forEach(invalidateJobRun);
    lanesRef.current.forEach((lane) => {
      if (lane.jobId !== null) {
        resetLane(lane, "Jobs canceled.");
      }
    });

    setJobs((current) => {
      const next: AnalysisJob[] = current.map((job) =>
        activeIds.includes(job.id)
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
      `Canceled ${activeIds.length} active job${activeIds.length === 1 ? "" : "s"}.`,
    );
  }, [invalidateJobRun, resetLane, pushNotice]);

  const retryJob = useCallback((jobId: string) => {
    if (!filesRef.current.has(jobId)) {
      return;
    }

    invalidateJobRun(jobId);
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
    const retryIds = jobsRef.current
      .filter(
        (job) =>
          (job.status === "failed" || job.status === "canceled") &&
          filesRef.current.has(job.id),
      )
      .map((job) => job.id);

    retryIds.forEach(invalidateJobRun);
    setJobs((current) => {
      const next: AnalysisJob[] = current.map((job) => {
        if (retryIds.includes(job.id)) {
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

    if (retryIds.length) {
      pushNotice(`Re-queued ${retryIds.length} issue job${retryIds.length === 1 ? "" : "s"}.`);
    }
  }, [invalidateJobRun, pushNotice]);

  const removeJob = useCallback((jobId: string) => {
    invalidateJobRun(jobId);
    const lane = laneByJobRef.current.get(jobId);
    if (lane) {
      resetLane(lane, "Job removed.");
    }

    dropJobResources(jobId);
    setJobs((current) => {
      const next = current.filter((job) => job.id !== jobId);
      jobsRef.current = next;
      return next;
    });
    fillLanesRef.current();
  }, [invalidateJobRun, resetLane, dropJobResources]);

  const clearFinished = useCallback(() => {
    setJobs((current) => {
      const finishedIds = current
        .filter((job) => ["complete", "failed", "canceled"].includes(job.status))
        .map((job) => job.id);
      finishedIds.forEach(dropJobResources);
      const keep = current.filter((job) => !finishedIds.includes(job.id));
      jobsRef.current = keep;
      return keep;
    });
    pushNotice("Cleared finished jobs from the queue.");
  }, [dropJobResources, pushNotice]);

  const clearSession = useCallback(() => {
    jobRunTokensRef.current.clear();
    lanesRef.current.forEach((lane) => {
      if (lane.jobId !== null) {
        resetLane(lane, "Session cleared.");
      }
    });

    filesRef.current.clear();
    fileSignaturesRef.current.clear();
    laneByJobRef.current.clear();
    heavyJobActiveRef.current = null;
    persistedResultsRef.current.clear();
    void clearLiveSession();
    setJobs(() => {
      jobsRef.current = [];
      return [];
    });
    pushNotice("Cleared the current analysis session.");
  }, [resetLane, pushNotice]);

  const clearRecentSessions = useCallback(() => {
    clearPersistedRecentSessions();
    setRecentSessions([]);
    pushNotice("Cleared saved history from this browser.");
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
    } catch {
      pushNotice("The browser blocked the session download. Try again.");
    }
  }, [pushNotice]);

  const importSession = useCallback(
    async (file: File) => {
      if (file.size > MAX_SESSION_FILE_BYTES) {
        pushNotice("That session file is too large to import safely.");
        return 0;
      }

      let text: string;
      try {
        text = await file.text();
      } catch {
        pushNotice("Could not read that session file.");
        return 0;
      }

      const { jobs: importedJobs, error } = parseSessionFile(text);
      if (error || !importedJobs.length) {
        pushNotice(error ?? "No analyses were found in that session file.");
        return 0;
      }

      // Count against the latest committed state (not inside the updater, which
      // React may invoke twice in development) so the notice numbers are right.
      const existingIds = new Set(jobsRef.current.map((job) => job.id));
      const fresh = importedJobs.filter((job) => !existingIds.has(job.id));
      const added = fresh.length;
      const skipped = importedJobs.length - added;

      if (!added) {
        pushNotice("Those analyses are already in this session.");
        return 0;
      }

      setJobs((current) => {
        const currentIds = new Set(current.map((job) => job.id));
        const toAdd = fresh.filter((job) => !currentIds.has(job.id));
        if (!toAdd.length) {
          return current;
        }

        const next = [...toAdd, ...current];
        jobsRef.current = next;
        return next;
      });

      pushNotice(
        skipped
          ? `Loaded ${added} file${added === 1 ? "" : "s"} from the session (${skipped} already present).`
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
