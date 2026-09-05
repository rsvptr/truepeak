import {
  decodeAudioFileInBrowser,
  isBrowserDecodeDrainTimeout,
  shouldPreferBrowserDecoder,
} from "@/audio/browser-decode";
import {
  COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES,
  DecodeResourceError,
  checkedResourceByteSum,
  conservativeDecodePeakBytes,
  decodeFailureDetails,
  decodePeakResidentBytes,
} from "@/audio/decode-budget";
import { DEFAULT_TARGET_PRESET } from "@/audio/presets";
import { retargetAnalysisResult } from "@/audio/targeting";
import { composeJobError } from "@/lib/job-ui";
import type {
  LaneLease,
  RunAnalysisJobContext,
  WorkerLane,
} from "@/analysis/scheduler-types";
import type {
  AnalysisMode,
  DecodePreference,
  DecodedAudioTransfer,
  TargetPreset,
} from "@/types/audio";
import type { DecodeResourceUsage } from "@/workers/shared/messages";

// Where analysis begins on the job's overall progress bar (read+decode owns
// everything before it). Analyzer worker fractions are mapped above this.
export const ANALYSIS_PROGRESS_BASE = 0.86;

function canTryAlternateDecoder(error: unknown) {
  return decodeFailureDetails(error).retryable;
}

export async function runAnalysisJob(
  context: RunAnalysisJobContext,
  lane: WorkerLane,
  lease: LaneLease,
  currentTarget: TargetPreset | null,
  currentAnalysisMode: AnalysisMode,
  currentDecodePreference: DecodePreference,
) {
  const {
    files: filesRef,
    resourcePlans: resourcePlansRef,
    decodeBudget: decodeBudgetRef,
    heavyFileBytes: heavyFileBytesRef,
    browserDecodeWindow: browserDecodeWindowRef,
    settings: settingsRef,
    updateJobIfRunCurrent,
    isJobRunCurrent,
    releaseLane,
    fillLanes,
    startBrowserDecodeHeartbeat,
    growLeasePeakReservation,
    decodeInWorker,
    analyzeInWorker,
    validateDecodedAssetForLease,
    resolveBrowserFirstRoute,
    normalizeDecodeFailure,
    isWorkerTransportError,
    isCancellationReason,
  } = context;
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
        fillLanes();
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

      // Defence in depth, not the fix for the stale-admission race: fillLanes
      // mints this lease's run token immediately before calling runJob, so on
      // every current path the gate passes. What actually stops a cancelled job
      // being admitted is cancelJob/cancelActiveJobs writing the cancel into
      // job store synchronously. This gate is what keeps that guarantee cheap to
      // hold: any future caller that hands runJob a lease built from a stale
      // view releases here instead of reading and fully decoding the file, and
      // every other leaseIsCurrent check sits past the decode.
      if (!leaseIsCurrent()) {
        releaseLane(lane, lease, false);
        fillLanes();
        return;
      }

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

        // A job that was requeued after reservation contention carries a pinned
        // single route it must run this time, plus the reservation it was
        // re-admitted under. Non-escalated plans keep the usual
        // browser-first/native ordering and fallback chains.
        const activePlan = resourcePlansRef.current.get(jobId);
        const escalatedRoute =
          activePlan?.kind === "escalated" ? activePlan.route : null;
        const plannedDecodedBytes =
          activePlan?.kind === "known" || activePlan?.kind === "escalated"
            ? activePlan.decodedBytes
            : null;
        const plannedSourceMetadata =
          activePlan?.kind === "known" || activePlan?.kind === "escalated"
            ? activePlan.sourceMetadata
            : null;
        const browserEligible = shouldPreferBrowserDecoder(file.name, mimeType);
        const browserFirst = resolveBrowserFirstRoute(
          currentDecodePreference,
          file.name,
          mimeType,
          activePlan?.kind === "known",
          activePlan?.kind === "known" && activePlan.trustedNative,
        );
        const browserReservationPeakBytes = plannedDecodedBytes != null
          ? decodePeakResidentBytes("browser", plannedDecodedBytes)
          : conservativeDecodePeakBytes(decodeBudgetRef.current);
        const compatibilityReservationPeakBytes = plannedDecodedBytes != null
          ? decodePeakResidentBytes(
              "compatibility-worker",
              plannedDecodedBytes,
              Math.min(
                decodeBudgetRef.current.maxOutputBytes,
                checkedResourceByteSum([
                  plannedDecodedBytes,
                  COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES,
                ]),
              ),
              file.size,
            )
          : conservativeDecodePeakBytes(decodeBudgetRef.current);
        const compatibilityRequiresExclusivity =
          plannedDecodedBytes != null &&
          plannedDecodedBytes >= heavyFileBytesRef.current;

        // Flip a contended job back to "queued" so the scheduler re-admits it
        // once the batch frees the memory it needs, recording the reservation,
        // exclusivity and route the retry must use. Returns "failed" only when
        // the requeue cap trips (belt-and-braces: an escalated re-admission
        // already holds its reservation before runJob starts, so a second
        // same-or-lower requeue should be unreachable).
        const requeueForContention = (
          reservationPeakBytes: number,
          exclusive: boolean,
          route: "browser-only" | "compatibility-only",
        ): "requeued" | "failed" | "stale" => {
          // Guard the plan mutation on run-currency itself rather than trusting
          // that no caller ever awaits between its last leaseIsCurrent check and
          // this call. If a concurrent cancel/remove/retry has invalidated the
          // run token or handed the lane to a newer job, a stale requeue must
          // not resurrect a resource plan for a job that has moved on (retryJob
          // and removeJob delete the plan; overwriting it here would leak an
          // escalated plan or clobber a fresh preflight).
          if (!isJobRunCurrent(jobId, runToken) || lane.lease !== lease) {
            return "stale";
          }

          const priorPlan = resourcePlansRef.current.get(jobId);
          const priorEscalations =
            priorPlan?.kind === "escalated" ? priorPlan.escalations : 0;
          const carriedDecodedBytes =
            priorPlan?.kind === "known"
              ? priorPlan.decodedBytes
              : priorPlan?.kind === "escalated"
                ? priorPlan.decodedBytes
                : null;
          const carriedSourceMetadata =
            priorPlan?.kind === "known"
              ? priorPlan.sourceMetadata
              : priorPlan?.kind === "escalated"
                ? priorPlan.sourceMetadata
                : null;

          if (
            priorPlan?.kind === "escalated" &&
            reservationPeakBytes <= priorPlan.reservationPeakBytes &&
            (!exclusive || priorPlan.exclusive)
          ) {
            updateJobIfRunCurrent(jobId, runToken, (job) => ({
              ...job,
              status: "failed",
              error:
                "TruePeak could not reserve enough memory to analyze this file alongside the rest of the batch. Remove some files or retry once the batch finishes.",
              progressLabel: "Failed",
              progressPercent: 1,
              finishedAtMs: Date.now(),
            }));
            return "failed";
          }

          resourcePlansRef.current.set(jobId, {
            kind: "escalated",
            reservationPeakBytes,
            exclusive,
            route,
            decodedBytes: carriedDecodedBytes,
            sourceMetadata: carriedSourceMetadata,
            escalations: priorEscalations + 1,
          });
          updateJobIfRunCurrent(jobId, runToken, (job) => ({
            ...job,
            status: "queued",
            progressPercent: 0,
            progressLabel: "Waiting for memory reservation",
            error: undefined,
            startedAtMs: undefined,
            finishedAtMs: undefined,
          }));
          return "requeued";
        };

        // Grow the lease reservation for a fallback/true-up route. Returns true
        // when runJob must stop: transient contention requeued the job, or the
        // requeue cap failed it. A retryable decoder-busy is handled HERE and
        // never propagates into the decode fallback chains, so it can never be
        // swallowed by canTryAlternateDecoder. Any other error propagates
        // unchanged (a stale lease is caught by the outer leaseIsCurrent gate).
        const escalateReservationOrBail = (
          reservationPeakBytes: number,
          exclusive: boolean,
          route: "browser-only" | "compatibility-only",
        ): boolean => {
          try {
            growLeasePeakReservation(lane, lease, reservationPeakBytes, exclusive);
            return false;
          } catch (error) {
            if (
              error instanceof DecodeResourceError &&
              error.code === "decoder-busy"
            ) {
              requeueForContention(reservationPeakBytes, exclusive, route);
              return true;
            }
            throw error;
          }
        };

        // Every browser decode holds a window slot for the duration of the
        // decode call, so at most `capacity` untrusted decodeAudioData
        // allocations run at once (capacity x browser peak <= aggregate cap by
        // construction). This is orthogonal to the byte reservations: those
        // bound retained memory, this bounds the concurrent transient decode
        // allocation, which an under-declared header could otherwise slip past
        // admission. The lease's abort signal is passed so a cancel/remove
        // while waiting leaves the FIFO queue WITHOUT leaking a slot or a
        // waiter. The slot is released in a finally AFTER the decode promise
        // settles: like waitForBrowserDecodeDrain, the un-abortable browser
        // decode may still be draining, and its transient memory is only surely
        // freed once the wrapper resolves or rejects. Unlike a reservation
        // contention this wait never requeues and cannot deadlock: a slot is
        // ALWAYS freed eventually because the browser decode either settles or,
        // if its promise never settles, is abandoned by the bounded post-abort
        // drain grace in waitForBrowserDecodeDrain (a terminal
        // BrowserDecodeDrainTimeoutError). On that rare zombie path the slot is
        // still freed by the finally and the lane is retired below so the
        // still-draining decode never overlaps a future job.
        const browserDecodeWindow = browserDecodeWindowRef.current;
        const decodeInBrowserWindow = async (
          primaryError: string | undefined,
          decodingLabel: string,
          decodingProgress: number,
        ): Promise<DecodedAudioTransfer> => {
          // Surface the waiting label only while the window is actually full so
          // an uncontended decode does not flash it. The check and the acquire
          // run with no await between them, so this branch matches what acquire
          // then does (grab immediately vs. queue).
          if (browserDecodeWindow.available <= 0) {
            updateJobIfRunCurrent(jobId, runToken, (job) => ({
              ...job,
              status: "decoding",
              progressLabel: "Waiting for a browser decode slot",
            }));
          }
          const releaseSlot = await browserDecodeWindow.acquire(
            lease.browserAbortController.signal,
          );
          try {
            // Each browser decode/fallback restarts its own 0..1 scale, so the
            // decode checkpoint is set directly (as before the window wrap), not
            // clamped to a possibly-higher value left by a failed prior route.
            updateJobIfRunCurrent(jobId, runToken, (job) => ({
              ...job,
              status: "decoding",
              progressPercent: decodingProgress,
              progressLabel: decodingLabel,
            }));
            browserDecodeHeartbeat = startBrowserDecodeHeartbeat(jobId, runToken);
            return await decodeAudioFileInBrowser(file, primaryError, undefined, {
              signal: lease.browserAbortController.signal,
              budget: decodeBudgetRef.current,
              sourceMetadata: plannedSourceMetadata ?? undefined,
            });
          } catch (error) {
            // A browser decode whose post-abort drain grace expired may still be
            // running on the main thread (decodeAudioData is unabortable). Retire
            // this lane so no future job shares it — or the transient memory the
            // zombie decode may still hold. Marked here, not in the outer catch,
            // because a user cancel takes an early-return path that skips the
            // outer catch; the slot is freed by the finally below in every case.
            // (Finding [3].)
            if (isBrowserDecodeDrainTimeout(error)) {
              lane.retireAfterRelease = true;
            }
            throw error;
          } finally {
            releaseSlot();
          }
        };

        if (escalatedRoute === "browser-only") {
          // Re-admitted under an escalated plan: run only the browser decoder,
          // under the reservation this run already holds. No fallback.
          decoded = await decodeInBrowserWindow(
            undefined,
            "Decoding locally",
            0.16,
          );
          decodedByBrowser = true;
        } else if (escalatedRoute === "compatibility-only") {
          // Re-admitted under an escalated plan: run only the compatibility
          // decoder, under the reservation this run already holds. No fallback.
          updateJobIfRunCurrent(jobId, runToken, (job) => ({
            ...job,
            status: "decoding",
            progressPercent: 0.16,
            progressLabel: "Decoding with the compatibility decoder",
          }));
          const workerResult = await decodeInWorker(lane, lease, file, mimeType);
          decoded = workerResult.asset;
          workerUsage = workerResult.usage;
          decodedByBrowser = false;
        } else if (browserFirst) {
          // Admission already reserved the browser-route peak for this job (2x
          // decoded bytes for a known footprint, the conservative peak for an
          // unknown one), so the browser decode proceeds under that reservation
          // directly. The window slot (acquired inside decodeInBrowserWindow)
          // is held only for the browser decode and released before the compat
          // fallback below, so a failed browser attempt never keeps a slot from
          // the compatibility route. Post-decode validateDecodedAssetForLease
          // trues up the actual peak and escalates only if the decode exceeded
          // its plan.
          try {
            decoded = await decodeInBrowserWindow(
              undefined,
              currentDecodePreference === "browser-first"
                ? "Using browser decoder preference"
                : "Trying browser decoder first",
              0.16,
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

            // Grow to the probed compatibility peak before decoding. Large
            // decoded footprints drain the batch and run alone.
            if (
              escalateReservationOrBail(
                compatibilityReservationPeakBytes,
                compatibilityRequiresExclusivity,
                "compatibility-only",
              )
            ) {
              return;
            }

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
          // The worker owns this decode from the first byte, so the row moves to
          // "decoding" here. Every decoder progress sample carries that status
          // and the coalescer drops any sample whose status differs from the
          // row's, so without this checkpoint the whole worker decode stays
          // invisible behind the "reading" label. Same label and value as the
          // decoder's own first message, so nothing flickers.
          updateJobIfRunCurrent(jobId, runToken, (job) => ({
            ...job,
            status: "decoding",
            progressPercent: 0.03,
            progressLabel: "Reading local file",
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
          } catch (decodeError) {
            if (!leaseIsCurrent()) {
              return;
            }
            if (!canTryAlternateDecoder(decodeError)) {
              throw decodeError;
            }

            // WAV and AIFF stay with their layout-aware worker path. Opaque
            // compressed sources retain the browser fallback when their probe
            // failed, but only under the full conservative reservation.
            if (!browserEligible) {
              throw decodeError;
            }

            // Grow to the checked browser peak before the fallback allocates an
            // AudioBuffer and planar copy.
            if (
              escalateReservationOrBail(
                browserReservationPeakBytes,
                false,
                "browser-only",
              )
            ) {
              return;
            }

            const primaryMessage =
              decodeError instanceof Error
                ? decodeError.message
                : "The primary decoder could not read this file.";

            try {
              decoded = await decodeInBrowserWindow(
                primaryMessage,
                "Trying browser decoder fallback",
                0.78,
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
        try {
          validateDecodedAssetForLease(
            lane,
            lease,
            decoded,
            workerUsage,
            decodedByBrowser,
          );
        } catch (error) {
          // A header that lied about its footprint makes the decode exceed its
          // plan; validateDecodedAssetForLease escalates to the conservative
          // exclusive posture. If that escalation hits contention, requeue the
          // job pinned to the route that just decoded so it re-runs alone once
          // the batch drains (the decoded buffers are discarded and re-decoded).
          // Genuine budget violations are not decoder-busy and propagate to the
          // failure handler unchanged.
          if (
            error instanceof DecodeResourceError &&
            error.code === "decoder-busy"
          ) {
            requeueForContention(
              conservativeDecodePeakBytes(decodeBudgetRef.current),
              true,
              decodedByBrowser ? "browser-only" : "compatibility-only",
            );
            return;
          }
          throw error;
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

        const details = decodeFailureDetails(error);
        const rawMessage = details.message;
        const summary =
          isWorkerTransportError(error)
            ? "Analysis stopped because the local worker failed. Retry this file. If it fails again, reload the page."
            : normalizeDecodeFailure(
                rawMessage,
                currentDecodePreference,
                details.code,
                decodeBudgetRef.current,
              );
        const message = composeJobError(summary, rawMessage);
        const canceled =
          details.code === "cancelled" || isCancellationReason(rawMessage);
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
        fillLanes();
      }
}
