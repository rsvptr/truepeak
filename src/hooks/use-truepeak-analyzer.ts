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
  SESSION_FILE_NAME,
  buildSessionFile,
  parseSessionFile,
} from "@/audio/session-file";
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

interface UseTruePeakAnalyzerOptions {
  analysisMode?: AnalysisMode;
  analysisBlocked?: boolean;
  decodePreference?: DecodePreference;
  persistHistory?: boolean;
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
      ].join("\u001f");
    })
    .join("\u001e");
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
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const filesRef = useRef(new Map<string, File>());
  const fileSignaturesRef = useRef(new Map<string, string>());
  const jobRunTokensRef = useRef(new Map<string, number>());
  const activeJobIdRef = useRef<string | null>(null);
  const jobsRef = useRef<AnalysisJob[]>([]);
  const pumpingRef = useRef(false);
  const pumpGenerationRef = useRef(0);
  const decoderPendingRef = useRef(
    new Map<string, PendingResolver<DecodedAudioTransfer>>(),
  );
  const analyzerPendingRef = useRef(
    new Map<string, PendingResolver<AnalysisJob["result"]>>(),
  );
  const decoderWorkerRef = useRef<Worker | null>(null);
  const analyzerWorkerRef = useRef<Worker | null>(null);
  const historyFingerprintRef = useRef("");
  const resetWorkersRef = useRef<(reason?: string) => void>(() => undefined);
  const settingsRef = useRef<AnalyzerSettings>({
    analysisBlocked,
    analysisMode,
    decodePreference,
    target,
  });
  const noticeTimeoutRef = useRef<number | null>(null);
  settingsRef.current = {
    analysisBlocked,
    analysisMode,
    decodePreference,
    target,
  };

  const completedJobs = useMemo(() => getCompletedAnalysisJobs(jobs), [jobs]);

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

  const interruptPump = useCallback(() => {
    pumpGenerationRef.current += 1;
    pumpingRef.current = false;
    activeJobIdRef.current = null;
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

  const createWorkers = useCallback(() => {
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
      resetWorkersRef.current(describeWorkerFailure("Decoder", event));
    };
    decoderWorker.onmessageerror = (event) => {
      resetWorkersRef.current(describeWorkerFailure("Decoder", event));
    };
    decoderWorker.onmessage = (event: MessageEvent<DecoderResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        if (!decoderPendingRef.current.has(message.jobId)) {
          return;
        }

        updateJob(message.jobId, (job) => ({
          ...job,
          status: "decoding",
          progressPercent: message.progress,
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
      resetWorkersRef.current(describeWorkerFailure("Analyzer", event));
    };
    analyzerWorker.onmessageerror = (event) => {
      resetWorkersRef.current(describeWorkerFailure("Analyzer", event));
    };
    analyzerWorker.onmessage = (event: MessageEvent<AnalyzerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        if (!analyzerPendingRef.current.has(message.jobId)) {
          return;
        }

        updateJob(message.jobId, (job) => ({
          ...job,
          status: "analyzing",
          progressPercent: message.progress,
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

    decoderWorkerRef.current = decoderWorker;
    analyzerWorkerRef.current = analyzerWorker;
  }, [updateJob]);

  const resetWorkers = useCallback(
    (reason = "Worker restarted.") => {
      decoderWorkerRef.current?.terminate();
      analyzerWorkerRef.current?.terminate();

      decoderPendingRef.current.forEach(({ reject }) => reject(new Error(reason)));
      analyzerPendingRef.current.forEach(({ reject }) => reject(new Error(reason)));
      decoderPendingRef.current.clear();
      analyzerPendingRef.current.clear();

      createWorkers();
    },
    [createWorkers],
  );

  useEffect(() => {
    resetWorkersRef.current = resetWorkers;
  }, [resetWorkers]);

  useEffect(() => {
    createWorkers();

    return () => {
      decoderWorkerRef.current?.terminate();
      analyzerWorkerRef.current?.terminate();
      if (noticeTimeoutRef.current) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, [createWorkers]);

  useEffect(() => {
    setRecentSessions(persistHistory ? loadRecentSessions() : []);
  }, [persistHistory]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

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
    (jobId: string, fileName: string, mimeType: string, buffer: ArrayBuffer) =>
      new Promise<DecodedAudioTransfer>((resolve, reject) => {
        const worker = decoderWorkerRef.current;
        if (!worker) {
          reject(new Error("Decoder worker is not available."));
          return;
        }

        decoderPendingRef.current.set(jobId, { resolve, reject });
        try {
          worker.postMessage(
            { type: "decode", jobId, fileName, mimeType, buffer } satisfies DecoderRequest,
            [buffer],
          );
        } catch (error) {
          decoderPendingRef.current.delete(jobId);
          const message = error instanceof Error ? error.message : "Unable to send audio to the decoder worker.";
          reject(new Error(message));
          resetWorkers(`Decoder worker post failed: ${message}`);
        }
      }),
    [resetWorkers],
  );

  const analyzeInWorker = useCallback(
    (jobId: string, asset: DecodedAudioTransfer, currentTarget: TargetPreset | null) =>
      new Promise<AnalysisJob["result"]>((resolve, reject) => {
        const worker = analyzerWorkerRef.current;
        if (!worker) {
          reject(new Error("Analyzer worker is not available."));
          return;
        }

        analyzerPendingRef.current.set(jobId, { resolve, reject });
        try {
          worker.postMessage({
            type: "analyze",
            jobId,
            asset,
            target: currentTarget,
          } satisfies AnalyzerRequest, asset.channelBuffers);
        } catch (error) {
          analyzerPendingRef.current.delete(jobId);
          const message = error instanceof Error ? error.message : "Unable to send audio to the analyzer worker.";
          reject(new Error(message));
          resetWorkers(`Analyzer worker post failed: ${message}`);
        }
      }),
    [resetWorkers],
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
          progressPercent: Math.min(0.42, Math.max(job.progressPercent, 0.18 + tick * 0.02)),
          progressLabel: "Still decoding locally - large files can take a moment",
        }));
      }, 4500);
    },
    [isJobRunCurrent, updateJobIfRunCurrent],
  );

  const runJob = useCallback(
    async (
      jobId: string,
      currentTarget: TargetPreset | null,
      currentAnalysisMode: AnalysisMode,
      currentDecodePreference: DecodePreference,
    ) => {
      const runToken = beginJobRun(jobId);
      const file = filesRef.current.get(jobId);
      if (!file) {
        updateJob(jobId, (job) => ({
          ...job,
          status: "failed",
          error: "Original file handle was not available for retry.",
          progressLabel: "Missing file",
          progressPercent: 1,
        }));
        return;
      }

      activeJobIdRef.current = jobId;
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
              const fallbackBuffer = await file.arrayBuffer();
              if (!isJobRunCurrent(jobId, runToken)) {
                return;
              }

              decoded = await decodeInWorker(jobId, file.name, mimeType, fallbackBuffer);
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
          const buffer = await file.arrayBuffer();
          if (!isJobRunCurrent(jobId, runToken)) {
            return;
          }

          try {
            decoded = await decodeInWorker(jobId, file.name, mimeType, buffer);
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
          progressPercent: 0.9,
          progressLabel:
            currentAnalysisMode === "measure-only"
              ? "Measuring loudness, peaks, and dynamics"
              : "Analyzing loudness history",
        }));
        const targetForJob =
          currentAnalysisMode === "targeted"
            ? currentTarget ?? DEFAULT_TARGET_PRESET
            : null;
        const result = await analyzeInWorker(jobId, decoded, targetForJob);
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
        }));
      } finally {
        stopBrowserDecodeHeartbeat();
        if (activeJobIdRef.current === jobId) {
          activeJobIdRef.current = null;
        }
      }
    },
    [
      analyzeInWorker,
      beginJobRun,
      decodeInWorker,
      isJobRunCurrent,
      startBrowserDecodeHeartbeat,
      updateJob,
      updateJobIfRunCurrent,
    ],
  );

  useEffect(() => {
    if (analysisBlocked || pumpingRef.current || !jobs.some((job) => job.status === "queued")) {
      return;
    }

    pumpingRef.current = true;
    const pumpGeneration = pumpGenerationRef.current;
    void (async () => {
      try {
        while (true) {
          if (pumpGenerationRef.current !== pumpGeneration) {
            break;
          }

          const settings = settingsRef.current;
          if (settings.analysisBlocked) {
            break;
          }

          const queued = jobsRef.current.find((job) => job.status === "queued");
          if (!queued) {
            break;
          }

          await runJob(
            queued.id,
            settings.target,
            settings.analysisMode,
            settings.decodePreference,
          );
        }
      } finally {
        if (pumpGenerationRef.current === pumpGeneration) {
          pumpingRef.current = false;
        }
      }
    })();
  }, [analysisBlocked, jobs, runJob]);

  const enqueueFiles = useCallback((input: FileList | File[]) => {
    const files = Array.from(input);
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
  }, [pushNotice]);

  const cancelJob = useCallback((jobId: string) => {
    invalidateJobRun(jobId);
    if (activeJobIdRef.current === jobId) {
      interruptPump();
      resetWorkers("Job canceled.");
    }

    updateJob(jobId, (job) => ({
      ...job,
      status: "canceled",
      progressPercent: 1,
      progressLabel: "Canceled",
      error: undefined,
    }));
  }, [invalidateJobRun, interruptPump, resetWorkers, updateJob]);

  const cancelActiveJobs = useCallback(() => {
    const activeIds = jobsRef.current
      .filter((job) => ["queued", "reading", "decoding", "analyzing"].includes(job.status))
      .map((job) => job.id);

    if (!activeIds.length) {
      return;
    }

    activeIds.forEach(invalidateJobRun);
    if (activeJobIdRef.current) {
      interruptPump();
      resetWorkers("Jobs canceled.");
    }

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
  }, [invalidateJobRun, interruptPump, resetWorkers, pushNotice]);

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
    const wasActive = activeJobIdRef.current === jobId;
    invalidateJobRun(jobId);
    if (wasActive) {
      interruptPump();
      resetWorkers("Job removed.");
    }

    dropJobResources(jobId);
    setJobs((current) => {
      const next = current.filter((job) => job.id !== jobId);
      jobsRef.current = next;
      return next;
    });
  }, [invalidateJobRun, interruptPump, resetWorkers, dropJobResources]);

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
    if (activeJobIdRef.current) {
      interruptPump();
      resetWorkers("Session cleared.");
    }

    filesRef.current.clear();
    fileSignaturesRef.current.clear();
    activeJobIdRef.current = null;
    setJobs(() => {
      jobsRef.current = [];
      return [];
    });
    pushNotice("Cleared the current analysis session.");
  }, [interruptPump, resetWorkers, pushNotice]);

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
        SESSION_FILE_NAME,
        buildSessionFile(jobsRef.current),
        "application/json;charset=utf-8",
      );
    } catch {
      pushNotice("The browser blocked the session download. Try again.");
    }
  }, [pushNotice]);

  const importSession = useCallback(
    async (file: File) => {
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

      let added = 0;
      let skipped = 0;
      setJobs((current) => {
        const existingIds = new Set(current.map((job) => job.id));
        const fresh = importedJobs.filter((job) => {
          if (existingIds.has(job.id)) {
            skipped += 1;
            return false;
          }
          added += 1;
          return true;
        });

        if (!fresh.length) {
          return current;
        }

        const next = [...fresh, ...current];
        jobsRef.current = next;
        return next;
      });

      if (!added) {
        pushNotice("Those analyses are already in this session.");
        return 0;
      }

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


