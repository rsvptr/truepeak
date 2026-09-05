import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { makeDecodedAudioTransfer } from "./lib/job-fixtures.mjs";

register("./alias-loader.mjs", import.meta.url);

const { AnalysisScheduler, recordLaneTransportFault, subscribeLaneAdmission } = await import(
  "../../src/analysis/analysis-scheduler.ts"
);
const { LaneReservations } = await import(
  "../../src/analysis/lane-reservations.ts"
);
const { runAnalysisJob } = await import("../../src/analysis/run-analysis-job.ts");
const { JobStore } = await import("../../src/analysis/job-store.ts");
const { DEFAULT_DECODE_BUDGET } = await import("../../src/audio/decode-budget.ts");

/** @typedef {import("../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../src/types/audio.ts").JobStatus} JobStatus */
/** @typedef {import("../../src/analysis/scheduler-types.ts").JobResourcePlan} JobResourcePlan */
/** @typedef {import("../../src/analysis/scheduler-types.ts").LaneLease} LaneLease */
/** @typedef {import("../../src/analysis/scheduler-types.ts").WorkerLane} WorkerLane */
/** @typedef {import("../../src/analysis/scheduler-types.ts").AnalysisSchedulerContext} AnalysisSchedulerContext */
/** @typedef {ReturnType<typeof harness>} SchedulerHarness */

/**
 * @template T
 * @param {T} current
 * @returns {{ current: T }}
 */
function cell(current) {
  return { current };
}

/**
 * @param {string} id
 * @returns {AnalysisJob}
 */
function queuedJob(id) {
  return {
    id,
    fileName: `${id}.wav`,
    mimeType: "audio/wav",
    status: "queued",
    createdAt: "2026-09-04T00:00:00.000Z",
    progressPercent: 0,
    progressLabel: "Queued",
  };
}

/**
 * @param {number} id
 * @param {LaneLease | null} [lease]
 * @returns {WorkerLane}
 */
function lane(id, lease = null) {
  return {
    id,
    decoder: null,
    analyzer: null,
    workerEpoch: 0,
    leaseGeneration: lease?.generation ?? 0,
    lease,
    retireAfterRelease: false,
    failureStreak: 0,
  };
}

/**
 * @param {AnalysisJob[]} jobs
 * @param {{
 *   laneLimit?: number,
 *   circuitOpen?: boolean,
 *   run?: (subject: SchedulerHarness, lane: WorkerLane, lease: LaneLease) => void | Promise<void>,
 * }} [options]
 */
function harness(jobs, { laneLimit = 2, circuitOpen = false, run } = {}) {
  const jobStore = new JobStore(jobs);
  /** @type {{ current: Map<string, File> }} */
  const files = cell(new Map(jobs.map((job) => [
    job.id,
    new File([new Uint8Array([0])], job.fileName, { type: job.mimeType }),
  ])));
  /** @type {{ current: Map<string, JobResourcePlan> }} */
  const resourcePlans = cell(new Map(jobs.map((job) => [job.id, { kind: "unknown" }])));
  /** @type {{ current: WorkerLane[] }} */
  const lanes = cell([]);
  /** @type {{ current: Map<string, WorkerLane> }} */
  const laneByJob = cell(new Map());
  /** @type {{ current: string | null }} */
  const heavyJobActive = cell(null);
  const reservedPeakBytes = cell(0);
  /** @type {{ lane: WorkerLane, lease: LaneLease }[]} */
  const runCalls = [];
  /** @type {number[]} */
  const disposed = [];
  /** @type {Map<string, number>} */
  const tokens = new Map();
  // The real release path, so a change to releaseLane is visible here.
  const reservations = new LaneReservations({
    lanes,
    laneByJob,
    heavyJobActive,
    reservedPeakBytes,
    aggregatePeakBytes: cell(Number.MAX_SAFE_INTEGER),
    terminateLaneWorkers: () => {},
    scheduleIdleLaneTeardown: () => {},
  });
  /** @type {AnalysisSchedulerContext} */
  const context = {
    jobStore,
    workspaceOpen: cell(true),
    settings: cell({
      allowCompatibilityDecoder: true,
      analysisBlocked: false,
      analysisMode: "measure-only",
      decodePreference: "auto",
      target: null,
    }),
    workerCircuitOpen: cell(circuitOpen),
    lanes,
    laneLimit: cell(laneLimit),
    laneSequence: cell(0),
    files,
    resourcePlans,
    preparingPlanCount: cell(0),
    heavyFileBytes: cell(256 * 1024 * 1024),
    decodeBudget: cell(DEFAULT_DECODE_BUDGET),
    reservations,
    transport: {
      attach: () => null,
      dispose: (idleLane) => {
        disposed.push(idleLane.id);
        const index = lanes.current.indexOf(idleLane);
        if (index >= 0) lanes.current.splice(index, 1);
      },
      run: async (activeLane, lease) => {
        runCalls.push({ lane: activeLane, lease });
        if (run) {
          await run(subject, activeLane, lease);
        }
      },
    },
    prepareResourcePlan: async () => {},
    updateJob: (jobId, updater) => {
      jobStore.set((current) => current.map((job) => (
        job.id === jobId ? updater(job) : job
      )));
    },
    beginJobRun: (jobId) => {
      const token = (tokens.get(jobId) ?? 0) + 1;
      tokens.set(jobId, token);
      return token;
    },
    resolveBrowserFirstRoute: () => false,
  };
  // Declared after `context` so both can be plain consts; `transport.run` only
  // reads `subject` when the scheduler actually starts a job.
  const subject = {
    context,
    disposed,
    heavyJobActive,
    jobStore,
    laneByJob,
    lanes,
    reservations,
    reservedPeakBytes,
    resourcePlans,
    runCalls,
    scheduler: new AnalysisScheduler(context),
    /** @param {string} jobId */
    invalidateJobRun: (jobId) => {
      tokens.set(jobId, (tokens.get(jobId) ?? 0) + 1);
    },
  };
  return subject;
}

// Write the terminal status the way the hook does, then hand the lane back
// through the production release path.
/**
 * @param {SchedulerHarness} subject
 * @param {string} jobId
 * @param {JobStatus} [status]
 */
function finishRun(subject, jobId, status = "complete") {
  const activeLane = subject.laneByJob.current.get(jobId);
  assert.ok(activeLane?.lease, `${jobId} has an active lease`);
  const lease = activeLane.lease;
  subject.jobStore.set((current) => current.map((job) => (
    job.id === jobId ? { ...job, status } : job
  )));
  subject.reservations.releaseLane(activeLane, lease, status === "complete");
}

// Wire the production admission subscriber the way the hook's effect does, and
// count the scans it triggers so a case can prove a commit did not cause one.
/**
 * @param {SchedulerHarness} subject
 * @returns {{ scans: () => number, stop: () => void }}
 */
function watchAdmission(subject) {
  let scans = 0;
  const stop = subscribeLaneAdmission(subject.jobStore, () => {
    scans += 1;
    subject.scheduler.fillLanes();
  });
  return { scans: () => scans, stop };
}

/**
 * A progress-only commit: the coalesced flush the analyzer drives dozens of
 * times per file, which writes percent and label and leaves status alone.
 *
 * @param {SchedulerHarness} subject
 * @param {string} jobId
 * @param {number} progressPercent
 */
function commitProgress(subject, jobId, progressPercent) {
  subject.jobStore.set((current) => current.map((job) => (
    job.id === jobId
      ? { ...job, progressPercent, progressLabel: `Analyzing ${progressPercent}` }
      : job
  )));
}

test("progress commits never trigger an admission scan", () => {
  const subject = harness([queuedJob("running"), queuedJob("waiting")], { laneLimit: 1 });
  const admission = watchAdmission(subject);
  assert.equal(admission.scans(), 1, "the subscriber scans once when it is installed");
  assert.deepEqual(subject.runCalls.map(({ lease }) => lease.jobId), ["running"]);

  subject.jobStore.set((current) => current.map((job) => (
    job.id === "running" ? { ...job, status: "analyzing" } : job
  )));
  const scansAfterStatus = admission.scans();
  assert.equal(scansAfterStatus, 2, "a status transition still moves the signature");

  for (let index = 1; index <= 25; index += 1) {
    commitProgress(subject, "running", index / 100);
  }
  assert.equal(admission.scans(), scansAfterStatus, "25 progress commits caused no scan");
  assert.equal(subject.runCalls.length, 1);
  admission.stop();
});

test("a released lease admits the next queued job with no store write", () => {
  const subject = harness([queuedJob("holder"), queuedJob("next")], { laneLimit: 1 });
  const admission = watchAdmission(subject);
  assert.deepEqual(subject.runCalls.map(({ lease }) => lease.jobId), ["holder"]);

  finishRun(subject, "holder");
  const beforeAdmission = subject.jobStore.getSnapshot();
  // The call runAnalysisJob makes right after releasing the lane.
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["holder", "next"],
  );
  assert.equal(
    subject.jobStore.getSnapshot(),
    beforeAdmission,
    "admission wrote nothing to the job store",
  );
  admission.stop();
});

test("a retired lane frees its slot for the next queued job", () => {
  const subject = harness([queuedJob("faulty"), queuedJob("follower")], { laneLimit: 1 });
  const admission = watchAdmission(subject);
  const busyLane = subject.laneByJob.current.get("faulty");
  assert.ok(busyLane, "the first job holds a lane");
  recordLaneTransportFault(busyLane);
  recordLaneTransportFault(busyLane);
  assert.equal(recordLaneTransportFault(busyLane), true);

  finishRun(subject, "faulty", "failed");
  assert.equal(subject.lanes.current.length, 0, "the retired lane is removed on release");
  const beforeAdmission = subject.jobStore.getSnapshot();
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["faulty", "follower"],
  );
  assert.equal(subject.lanes.current.length, 1, "the follower runs on a fresh lane");
  assert.equal(subject.jobStore.getSnapshot(), beforeAdmission);
  admission.stop();
});

test("raising the lane limit admits a waiting job with no store write", () => {
  const subject = harness([queuedJob("first"), queuedJob("second")], { laneLimit: 1 });
  const admission = watchAdmission(subject);
  assert.deepEqual(subject.runCalls.map(({ lease }) => lease.jobId), ["first"]);

  const beforeAdmission = subject.jobStore.getSnapshot();
  // What the lane-budget effect does when the parallel preference changes.
  subject.context.laneLimit.current = 2;
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["first", "second"],
  );
  assert.equal(subject.jobStore.getSnapshot(), beforeAdmission);
  admission.stop();
});

test("resuming the worker circuit admits a paused row with no status change", () => {
  const subject = harness([queuedJob("paused")], { circuitOpen: true });
  const admission = watchAdmission(subject);
  assert.equal(subject.runCalls.length, 0, "an open circuit admits nothing");

  // openWorkerCircuit writes the paused label; the row's status is untouched, so
  // the admission signature does not move and no scan runs.
  const scansBeforePause = admission.scans();
  subject.jobStore.set((current) => current.map((job) => (
    { ...job, progressLabel: "Paused: analysis stopped" }
  )));
  assert.equal(admission.scans(), scansBeforePause, "pausing caused no scan");

  // resumeWorkerCircuit clears the flag and the label, then scans explicitly.
  subject.context.workerCircuitOpen.current = false;
  subject.jobStore.set((current) => current.map((job) => (
    { ...job, progressLabel: "Queued" }
  )));
  assert.equal(admission.scans(), scansBeforePause, "clearing the label caused no scan");
  assert.equal(subject.runCalls.length, 0, "the signature alone never resumes the queue");

  subject.scheduler.fillLanes();
  assert.deepEqual(subject.runCalls.map(({ lease }) => lease.jobId), ["paused"]);
  admission.stop();
});

test("unblocking analysis admits through a re-subscribed scan", () => {
  const subject = harness([queuedJob("blocked")]);
  subject.context.settings.current.analysisBlocked = true;
  const blocked = watchAdmission(subject);
  assert.equal(subject.runCalls.length, 0, "a blocked workspace admits nothing");
  blocked.stop();

  // analysisBlocked is a dependency of the hook's effect, so flipping it tears
  // the subscription down and installs a fresh one, which scans on arrival.
  subject.context.settings.current.analysisBlocked = false;
  const unblocked = watchAdmission(subject);
  assert.deepEqual(subject.runCalls.map(({ lease }) => lease.jobId), ["blocked"]);
  unblocked.stop();
});

test("a retried row is re-admitted through the admission signature alone", () => {
  const subject = harness([queuedJob("retried")]);
  const admission = watchAdmission(subject);
  finishRun(subject, "retried", "failed");
  const scansAfterFailure = admission.scans();
  assert.equal(subject.runCalls.length, 1);

  // retryJob mints a new run token, clears the plan and requeues the row.
  subject.invalidateJobRun("retried");
  subject.resourcePlans.current.set("retried", { kind: "unknown" });
  subject.jobStore.set((current) => current.map((job) => (
    { ...job, status: "queued", progressPercent: 0, progressLabel: "Queued" }
  )));
  assert.ok(admission.scans() > scansAfterFailure, "requeueing moved the signature");
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["retried", "retried"],
  );
  admission.stop();
});

test("cancel during decode is not re-admitted", () => {
  const subject = harness([queuedJob("cancel-mid-decode")]);
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 1);
  subject.jobStore.set((current) => current.map((job) => ({
    ...job,
    status: "canceled",
    progressPercent: 1,
    progressLabel: "Canceled",
  })));
  finishRun(subject, "cancel-mid-decode", "canceled");
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 1);
});

test("an escalated decoder-busy plan waits for drain and reruns alone", () => {
  const subject = harness([queuedJob("running"), queuedJob("requeued")]);
  subject.resourcePlans.current.set("requeued", {
    kind: "escalated",
    reservationPeakBytes: 1024,
    exclusive: true,
    route: "compatibility-only",
    decodedBytes: null,
    sourceMetadata: null,
    escalations: 1,
  });
  subject.scheduler.fillLanes();
  assert.deepEqual(subject.runCalls.map(({ lease }) => lease.jobId), ["running"]);
  finishRun(subject, "running");
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["running", "requeued"],
  );
  assert.equal(subject.runCalls[1].lease.reservation.exclusive, true);
});

test("three transport faults retire a lane and an explicit reopen resumes intake", () => {
  const brokenLane = lane(0);
  assert.equal(recordLaneTransportFault(brokenLane), false);
  assert.equal(recordLaneTransportFault(brokenLane), false);
  assert.equal(recordLaneTransportFault(brokenLane), true);
  assert.equal(brokenLane.retireAfterRelease, true);

  const subject = harness([queuedJob("after-reopen")], { circuitOpen: true });
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 0);
  subject.context.workerCircuitOpen.current = false;
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 1);
});

test("a lower lane limit disposes idle lanes and lets busy lanes finish", () => {
  const subject = harness([], { laneLimit: 2 });
  /** @type {LaneLease} */
  const firstLease = {
    laneId: 0,
    generation: 1,
    jobId: "busy-a",
    runToken: 1,
    reservation: {
      plannedPeakBytes: 1,
      peakBytes: 1,
      exclusive: false,
      released: false,
    },
    browserAbortController: new AbortController(),
  };
  /** @type {LaneLease} */
  const secondLease = {
    ...firstLease,
    laneId: 1,
    jobId: "busy-b",
    browserAbortController: new AbortController(),
  };
  subject.lanes.current.push(lane(0, firstLease), lane(1, secondLease), lane(2));
  subject.scheduler.fillLanes();
  assert.deepEqual(subject.disposed, [2]);
  assert.equal(subject.lanes.current.length, 2);

  subject.context.laneLimit.current = 1;
  subject.scheduler.fillLanes();
  assert.equal(subject.lanes.current.length, 2);
  subject.lanes.current[1].lease = null;
  subject.scheduler.fillLanes();
  assert.equal(subject.lanes.current.length, 1);
  assert.deepEqual(subject.disposed, [2, 1]);
});

test("three queued jobs against a limit of two admit exactly two at a time", () => {
  const subject = harness(
    [queuedJob("limit-a"), queuedJob("limit-b"), queuedJob("limit-c")],
    { laneLimit: 2 },
  );
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["limit-a", "limit-b"],
  );
  assert.equal(subject.lanes.current.length, 2);

  // A second scan with every lane busy admits nothing more.
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 2);

  finishRun(subject, "limit-a");
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["limit-a", "limit-b", "limit-c"],
  );
  assert.equal(subject.lanes.current.length, 2);
});

test("a job cancelled while queued is never admitted", () => {
  const subject = harness([queuedJob("canceled-early"), queuedJob("follower")]);
  // Cancelled before any lane was acquired, so there is no lease to interrupt:
  // the scheduler must simply never pick the row up.
  subject.jobStore.set((current) => current.map((job) => (
    job.id === "canceled-early"
      ? { ...job, status: "canceled", progressPercent: 1, progressLabel: "Canceled" }
      : job
  )));
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["follower"],
  );
  assert.equal(subject.laneByJob.current.has("canceled-early"), false);

  finishRun(subject, "follower");
  subject.scheduler.fillLanes();
  assert.deepEqual(
    subject.runCalls.map(({ lease }) => lease.jobId),
    ["follower"],
  );
});

test("a transport failure is terminal and a user retry is admitted under a new run token", () => {
  // A transport failure is terminal: runJob writes "failed" and releases the
  // lane, and the scheduler does not requeue it. Only a user retry (which
  // clears the plan and mints a new run token) puts the row back in the queue.
  const subject = harness([queuedJob("transport-fault")], {
    run: (target, activeLane, lease) => {
      target.jobStore.set((current) => current.map((job) => (
        job.id === lease.jobId
          ? { ...job, status: "failed", progressPercent: 1, progressLabel: "Failed" }
          : job
      )));
      target.reservations.releaseLane(activeLane, lease, false);
    },
  });
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 1);
  const firstLease = subject.runCalls[0].lease;
  assert.equal(subject.reservedPeakBytes.current, 0, "the failed run released its reservation");
  assert.equal(subject.laneByJob.current.has("transport-fault"), false);

  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 1, "a failed job is not requeued on its own");

  subject.invalidateJobRun("transport-fault");
  subject.resourcePlans.current.set("transport-fault", { kind: "unknown" });
  subject.jobStore.set((current) => current.map((job) => (
    { ...job, status: "queued", progressPercent: 0, progressLabel: "Queued", error: undefined }
  )));
  subject.scheduler.fillLanes();
  assert.equal(subject.runCalls.length, 2);
  const retryLease = subject.runCalls[1].lease;
  assert.ok(
    retryLease.runToken > firstLease.runToken,
    "the retry runs under a new run token",
  );
  assert.notEqual(retryLease, firstLease);
});

test("a worker-route job passes through decoding before analyzing", async () => {
  // A-01: on the worker-first route the row must reach "decoding" before the
  // decoder posts progress. Every decoder progress sample carries that status
  // and the coalescer drops samples whose status differs from the row's, so a
  // missing checkpoint hides the whole decode behind "reading".
  /** @type {AnalysisJob} */
  let row = {
    ...queuedJob("worker-route"),
    status: "queued",
  };
  /** @type {{ status: JobStatus, progressPercent: number, progressLabel: string }[]} */
  const checkpoints = [];
  /** @type {LaneLease} */
  const workerLease = {
    laneId: 0,
    generation: 1,
    jobId: "worker-route",
    runToken: 1,
    reservation: {
      plannedPeakBytes: 1,
      peakBytes: 1,
      exclusive: false,
      released: false,
    },
    browserAbortController: new AbortController(),
  };
  const workerLane = lane(0, workerLease);
  let statusDuringDecode = null;
  await runAnalysisJob(
    {
      files: cell(new Map([[
        "worker-route",
        new File([new Uint8Array([0])], "worker-route.wav", { type: "audio/wav" }),
      ]])),
      resourcePlans: cell(new Map([["worker-route", { kind: "unknown" }]])),
      decodeBudget: cell(DEFAULT_DECODE_BUDGET),
      heavyFileBytes: cell(256 * 1024 * 1024),
      browserDecodeWindow: cell({
        available: 1,
        capacity: 1,
        pending: 0,
        acquire: async () => () => {},
        setCapacity: () => {},
      }),
      settings: cell({
        allowCompatibilityDecoder: true,
        analysisBlocked: false,
        analysisMode: "measure-only",
        decodePreference: "auto",
        target: null,
      }),
      updateJobIfRunCurrent: (jobId, runToken, updater) => {
        row = updater(row);
        checkpoints.push({
          status: row.status,
          progressPercent: row.progressPercent,
          progressLabel: row.progressLabel,
        });
      },
      isJobRunCurrent: () => true,
      releaseLane: () => {},
      fillLanes: () => {},
      startBrowserDecodeHeartbeat: () => 0,
      growLeasePeakReservation: () => {},
      decodeInWorker: async () => {
        statusDuringDecode = row.status;
        return {
          asset: makeDecodedAudioTransfer(),
          usage: {
            sourceBytes: 1,
            decodedBytes: 0,
            outputBytes: null,
            channelCount: 0,
            frameCount: 0,
            elapsedMs: 0,
          },
        };
      },
      analyzeInWorker: async () => undefined,
      validateDecodedAssetForLease: () => {},
      resolveBrowserFirstRoute: () => false,
      normalizeDecodeFailure: (message) => message,
      isWorkerTransportError: () => false,
      isCancellationReason: () => false,
    },
    workerLane,
    workerLease,
    null,
    "measure-only",
    "auto",
  );

  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.status),
    ["reading", "decoding", "analyzing", "complete"],
  );
  assert.equal(
    statusDuringDecode,
    "decoding",
    "decoder progress samples are matched against a decoding row",
  );
  const decodingCheckpoint = checkpoints.find(
    (checkpoint) => checkpoint.status === "decoding",
  );
  assert.ok(
    decodingCheckpoint != null &&
      decodingCheckpoint.progressPercent >= 0.03 &&
      decodingCheckpoint.progressPercent <= 0.84,
    "the decoding checkpoint sits inside the decoder progress range",
  );
});
