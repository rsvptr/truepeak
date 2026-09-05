import {
  DecodeResourceError,
  classifyReservationContention,
  growDecodePeakReservation,
} from "@/audio/decode-budget";
import type {
  LaneLease,
  MutableCell,
  WorkerLane,
} from "@/analysis/scheduler-types";

export interface LaneReservationsContext {
  lanes: MutableCell<WorkerLane[]>;
  laneByJob: MutableCell<Map<string, WorkerLane>>;
  heavyJobActive: MutableCell<string | null>;
  reservedPeakBytes: MutableCell<number>;
  aggregatePeakBytes: MutableCell<number>;
  terminateLaneWorkers: (lane: WorkerLane) => void;
  scheduleIdleLaneTeardown: () => void;
}

/**
 * The release half of scheduling: the aggregate decode reservation and the
 * lane bookkeeping that goes with it. Growing a lease mid-run and releasing it
 * when the run ends are the two operations the admission scan in
 * AnalysisScheduler has to stay consistent with, so they live behind the same
 * React-free boundary and the scheduler harness exercises the real code.
 */
export class LaneReservations {
  readonly laneByJob: MutableCell<Map<string, WorkerLane>>;
  readonly heavyJobActive: MutableCell<string | null>;
  readonly reservedPeakBytes: MutableCell<number>;
  readonly aggregatePeakBytes: MutableCell<number>;
  private readonly lanes: MutableCell<WorkerLane[]>;
  private readonly terminateLaneWorkers: (lane: WorkerLane) => void;
  private readonly scheduleIdleLaneTeardown: () => void;

  constructor(context: LaneReservationsContext) {
    this.lanes = context.lanes;
    this.laneByJob = context.laneByJob;
    this.heavyJobActive = context.heavyJobActive;
    this.reservedPeakBytes = context.reservedPeakBytes;
    this.aggregatePeakBytes = context.aggregatePeakBytes;
    this.terminateLaneWorkers = context.terminateLaneWorkers;
    this.scheduleIdleLaneTeardown = context.scheduleIdleLaneTeardown;
  }

  readonly growLeasePeakReservation = (
    lane: WorkerLane,
    lease: LaneLease,
    requiredPeakBytes: number,
    requireExclusive: boolean,
  ) => {
    const lanesRef = this.lanes;
    const reservedPeakBytesRef = this.reservedPeakBytes;
    const aggregatePeakBytesRef = this.aggregatePeakBytes;
    const heavyJobActiveRef = this.heavyJobActive;
    if (lane.lease !== lease) {
      throw new DecodeResourceError(
        "cancelled",
        "The decode lease is no longer current.",
      );
    }
    if (
      requireExclusive &&
      lanesRef.current.some(
        (candidate) =>
          candidate !== lane && candidate.lease !== null,
      )
    ) {
      // Contention, not an over-budget condition: another lease is still
      // active, so the exclusive reservation cannot be taken yet. This state
      // clears as the batch drains, so it is retryable — runJob catches it and
      // requeues the job instead of failing it.
      throw new DecodeResourceError(
        "decoder-busy",
        "Waiting for the current batch to finish so this file can reserve exclusive decode memory.",
        true,
      );
    }

    const reservation = lease.reservation;
    let nextTotal: number;
    try {
      nextTotal = growDecodePeakReservation(
        reservedPeakBytesRef.current,
        reservation.peakBytes,
        requiredPeakBytes,
        aggregatePeakBytesRef.current,
      );
    } catch (error) {
      // Separate a momentarily full aggregate (transient: this reservation
      // would fit an otherwise-empty batch, so wait and retry) from a route
      // that can never fit the aggregate at all (permanent over-budget). Only
      // the former becomes a retryable requeue.
      if (
        error instanceof DecodeResourceError &&
        error.code === "decoded-budget-exceeded" &&
        classifyReservationContention(
          requiredPeakBytes,
          aggregatePeakBytesRef.current,
        ) === "retryable"
      ) {
        throw new DecodeResourceError(
          "decoder-busy",
          "Waiting for decode memory to free up before this file can continue.",
          true,
        );
      }
      throw error;
    }

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
  };

  readonly releaseLane = (
    lane: WorkerLane,
    lease: LaneLease,
    terminalSuccess: boolean,
  ) => {
    const lanesRef = this.lanes;
    const reservedPeakBytesRef = this.reservedPeakBytes;
    const laneByJobRef = this.laneByJob;
    const heavyJobActiveRef = this.heavyJobActive;
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
      this.terminateLaneWorkers(lane);
      const index = lanesRef.current.indexOf(lane);
      if (index >= 0) {
        lanesRef.current.splice(index, 1);
      }
    }
    // A canceled browser decode can outlive the first idle timer because its
    // lease correctly remains busy while decodeAudioData drains. Re-arm the
    // timer now that this lane is genuinely idle.
    this.scheduleIdleLaneTeardown();
  };
}
