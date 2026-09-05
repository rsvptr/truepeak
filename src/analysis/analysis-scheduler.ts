import {
  growDecodePeakReservation,
  planLaneAdmission,
} from "@/audio/decode-budget";
import type {
  AnalysisSchedulerContext,
  LaneLease,
  WorkerLane,
} from "@/analysis/scheduler-types";
import type { JobStore } from "@/analysis/job-store";
import type { AnalysisJob } from "@/types/audio";

export const MAX_LANE_FAILURE_STREAK = 3;

/**
 * The admission-relevant summary of a job snapshot. The scan below reads only
 * each row's id and status: it walks the queued rows, skips the ones already on
 * a lane, and never looks at progress percent or label. A coalesced progress
 * commit therefore leaves this signature unchanged, so a subscriber can compare
 * signatures and skip a queue scan that could not admit anything. Every state
 * the scan reads outside the snapshot (the lane list, the lane limit, the
 * circuit flag, the reservation totals) changes through a path that calls
 * fillLanes directly.
 */
export function admissionSignature(jobs: readonly AnalysisJob[]) {
  let queued = 0;
  let active = 0;
  for (const job of jobs) {
    if (job.status === "queued") {
      queued += 1;
    } else if (
      job.status === "reading" ||
      job.status === "decoding" ||
      job.status === "analyzing"
    ) {
      active += 1;
    }
  }

  return `${jobs.length}:${queued}:${active}`;
}

/**
 * Runs `fillLanes` whenever a store commit changes the admission signature, and
 * once immediately. Progress-only commits are skipped, so a long run no longer
 * pays for a queue scan per coalesced progress flush. Returns the unsubscribe.
 */
export function subscribeLaneAdmission(jobStore: JobStore, fillLanes: () => void) {
  let signature = admissionSignature(jobStore.getSnapshot());
  let scanning = false;
  const rescan = () => {
    scanning = true;
    try {
      fillLanes();
    } finally {
      scanning = false;
      // The scan can fail a row whose file handle is gone; re-read so the next
      // commit is compared against what the scan left behind, and so a store
      // write made from inside the scan cannot recurse into another scan.
      signature = admissionSignature(jobStore.getSnapshot());
    }
  };

  rescan();
  return jobStore.subscribe(() => {
    if (scanning || admissionSignature(jobStore.getSnapshot()) === signature) {
      return;
    }

    rescan();
  });
}

export function recordLaneTransportFault(lane: WorkerLane) {
  lane.failureStreak += 1;
  if (lane.failureStreak < MAX_LANE_FAILURE_STREAK) {
    return false;
  }
  lane.retireAfterRelease = true;
  return true;
}

export class AnalysisScheduler {
  private readonly context: AnalysisSchedulerContext;

  constructor(context: AnalysisSchedulerContext) {
    this.context = context;
  }

  readonly fillLanes = () => {
    const {
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
      transport,
      prepareResourcePlan,
      updateJob,
      beginJobRun,
      resolveBrowserFirstRoute,
    } = this.context;
    const {
      heavyJobActive: heavyJobActiveRef,
      laneByJob: laneByJobRef,
      reservedPeakBytes: reservedPeakBytesRef,
      aggregatePeakBytes: aggregatePeakBytesRef,
    } = reservations;
    const attachLaneWorkers = transport.attach;
    const disposeIdleLane = transport.dispose;
    const runJob = transport.run;
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

    for (const job of jobStore.getSnapshot()) {
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
      if (!plan || plan.kind === "preparing") {
        // Preflights are quick (a header slice read), so keep a small pool of
        // them in flight and keep scanning: a job whose plan is still pending
        // must not strand idle lanes for already-planned jobs behind it. Each
        // finished preflight re-runs fillLanes, so pending jobs are retried
        // promptly and in queue order.
        if (!plan) {
          // Counted incrementally rather than derived by materialising and
          // filtering the whole plan map. The count is loop-invariant except
          // where this very loop starts a preflight, so deriving it paid
          // O(|plans|) per unplanned job and made a single queue scan O(n^2).
          if (preparingPlanCountRef.current < 4) {
            void prepareResourcePlan(job.id, file);
          }
        }
        continue;
      }
      if (plan.kind === "rejected") {
        continue;
      }

      const settings = settingsRef.current;
      const mimeType = file.type || "application/octet-stream";
      // A job requeued after reservation contention carries the exact
      // reservation and exclusivity it must be re-admitted under; use those
      // directly and bypass the preflight admission model. Everything else
      // plans admission from its known/unknown footprint as usual.
      let reservationPeakBytes: number;
      let exclusive: boolean;
      if (plan.kind === "escalated") {
        reservationPeakBytes = plan.reservationPeakBytes;
        exclusive = plan.exclusive;
      } else {
        const browserFirst = resolveBrowserFirstRoute(
          settings.decodePreference,
          file.name,
          mimeType,
          plan.kind === "known",
          plan.kind === "known" && plan.trustedNative,
        );
        const admission = planLaneAdmission({
          fileSizeBytes: file.size,
          heavyFileBytes: heavyFileBytesRef.current,
          browserFirst,
          plan,
          budget: decodeBudgetRef.current,
        });
        reservationPeakBytes = admission.reservationPeakBytes;
        exclusive = admission.exclusive;
      }

      if (
        exclusive &&
        lanesRef.current.some((lane) => lane.lease !== null)
      ) {
        // Heavy files (and requeued exclusive escalations) drain the batch and
        // run alone. Stopping the scan here is deliberate: admitting later jobs
        // past a waiting exclusive job would starve it, because lanes might
        // never all be idle at once again.
        break;
      }

      let nextReservedPeakBytes: number;
      try {
        nextReservedPeakBytes = growDecodePeakReservation(
          reservedPeakBytesRef.current,
          0,
          reservationPeakBytes,
          aggregatePeakBytesRef.current,
        );
      } catch {
        // Aggregate capacity is exhausted. Stop rather than skip ahead so the
        // oldest waiting job gets first claim on capacity as running jobs
        // release their reservations.
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
  };
}
