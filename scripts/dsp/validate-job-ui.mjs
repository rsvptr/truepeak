import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./alias-loader.mjs", import.meta.url);

import {
  makeAnalysisResult,
  makeAudioMetadata,
  makeMetrics,
  makeTargetPreset,
} from "./lib/job-fixtures.mjs";

const {
  describeJobBadges,
  describeResultBadges,
} = await import("../../src/lib/job-ui.ts");
const {
  ANALYSIS_PAUSED_LABEL,
  buildQueueSearchHaystack,
  deriveBatchProgress,
  deriveSessionStats,
  queueJobMatchesView,
  sortQueueJobs,
} = await import("../../src/lib/session-selectors.ts");

/** @typedef {import("../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../src/types/audio.ts").AnalysisProvenance} AnalysisProvenance */
/** @typedef {import("../../src/types/audio.ts").JobStatus} JobStatus */
/** @typedef {import("../../src/types/audio.ts").TargetPreset} TargetPreset */

/**
 * @param {string} name
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(name, condition, detail = "") {
  test(name, () => {
    assert.ok(condition, detail);
  });
}

const target = makeTargetPreset({ referenceUrl: "https://example.com" });

/** @type {AnalysisProvenance} */
const importedProvenance = { kind: "unverified-import" };

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.createdAt
 * @param {string} options.fileName
 * @param {number} [options.integratedLufs]
 * @param {boolean} [options.integratedValid]
 * @param {JobStatus} [options.status]
 * @param {number} [options.progressPercent]
 * @param {string} [options.progressLabel]
 * @param {number} [options.truePeakDbtp]
 * @param {TargetPreset | null} [options.targetValue]
 * @param {boolean} [options.imported]
 * @param {boolean} [options.restored]
 * @param {number} [options.startedAtMs]
 * @param {number} [options.finishedAtMs]
 * @returns {AnalysisJob}
 */
function makeJob({
  id,
  createdAt,
  fileName,
  integratedLufs = -14,
  integratedValid = true,
  status = "complete",
  progressPercent = 1,
  progressLabel = "Complete",
  truePeakDbtp = -2,
  targetValue = target,
  imported = false,
  restored = false,
  startedAtMs,
  finishedAtMs,
}) {
  const result = status === "complete"
    ? makeAnalysisResult({
        analysisMode: targetValue ? "targeted" : "measure-only",
        analyzedAt: createdAt,
        target: targetValue,
        metadata: makeAudioMetadata({
          decoderLabel: "Compatibility decoder",
          durationSeconds: 30,
          sampleRate: 48000,
        }),
        metrics: makeMetrics({
          integratedLufs,
          integratedValid,
          loudnessRange: 4,
          loudnessRangeValid: true,
          normalizationLimited: false,
          projectedTruePeakDbtp: truePeakDbtp,
          targetDeltaDb: targetValue ? targetValue.loudnessTargetLufs - integratedLufs : null,
          truePeakDbtp,
        }),
      })
    : undefined;

  return {
    id,
    createdAt,
    fileName,
    mimeType: "audio/wav",
    status,
    progressPercent,
    progressLabel,
    imported,
    restored,
    ...(imported ? { provenance: importedProvenance } : {}),
    ...(result ? { result } : {}),
    ...(startedAtMs == null ? {} : { startedAtMs }),
    ...(finishedAtMs == null ? {} : { finishedAtMs }),
  };
}

const completed = makeJob({
  id: "completed",
  createdAt: "2026-09-04T10:00:00.000Z",
  fileName: "mix-10.wav",
  imported: true,
  restored: true,
  startedAtMs: 0,
  finishedAtMs: 1000,
});
const invalid = makeJob({
  id: "invalid",
  createdAt: "2026-09-04T09:00:00.000Z",
  fileName: "mix-2.wav",
  integratedValid: false,
  integratedLufs: -70,
  startedAtMs: 0,
  finishedAtMs: 3000,
});
const active = makeJob({
  id: "active",
  createdAt: "2026-09-04T11:00:00.000Z",
  fileName: "mix-1.wav",
  status: "analyzing",
  progressPercent: 0.5,
  progressLabel: "Analyzing",
});
const paused = makeJob({
  id: "paused",
  createdAt: "2026-09-04T12:00:00.000Z",
  fileName: "paused.wav",
  status: "queued",
  progressPercent: 0.2,
  progressLabel: ANALYSIS_PAUSED_LABEL,
});

check(
  "job badges keep the established queue order",
  describeJobBadges(completed, "targeted").map((badge) => badge.label).join("|") ===
    "complete|Unverified import|Restored|On target|Fixture Target|Compatibility decoder",
);
check(
  "result badges select one result state plus provenance",
  describeResultBadges(invalid, "targeted", true).map((badge) => badge.label).join("|") ===
    "Integrated unavailable|Compatibility decoder",
);
check(
  "paused status is excluded from active search filtering",
  !queueJobMatchesView(paused, "active", ""),
);
check(
  "search haystack includes decoder, layout, target and verdict",
  ["compatibility decoder", "stereo", "fixture target", "on target"].every((term) =>
    buildQueueSearchHaystack(completed).includes(term),
  ),
);
check(
  "natural filename sorting is stable",
  [completed, invalid, active].sort((left, right) => sortQueueJobs(left, right, "name"))
    .map((job) => job.fileName).join("|") === "mix-1.wav|mix-2.wav|mix-10.wav",
);
check(
  "unavailable integrated readings sort after measurements",
  [invalid, completed].sort((left, right) => sortQueueJobs(left, right, "integrated"))[0].id === "completed",
);

const batchProgress = deriveBatchProgress([completed, invalid, active], 2);
check(
  "batch progress preserves finished, percent and median ETA",
  batchProgress?.finished === 2 &&
    Math.abs(batchProgress.percent - 83.33333333333334) < 1e-9 &&
    batchProgress.etaSeconds === 3,
);

const stats = deriveSessionStats([completed, invalid], target, "targeted");
check("session stats exclude invalid integrated readings from the average", stats.averageIntegrated === -14);
check("session stats retain the hottest peak job", stats.hottestPeakJob?.id === "completed");
check("session stats count unverified provenance once", stats.unverifiedCount === 1);
check("session stats share the completed result list", stats.readyJobs.length === 2);
