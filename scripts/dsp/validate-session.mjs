// Portable-session v2 round trips, legacy-v1 compatibility, provenance, and
// rejection tests for the untrusted JSON boundary.
// Run: npm run test:session
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { encodeWav } from "./lib/fixtures.mjs";

register("./alias-loader.mjs", import.meta.url);

/** @typedef {import("../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../src/types/audio.ts").RecentSessionEntry} RecentSessionEntry */
/** @typedef {import("../../src/types/audio.ts").AnalysisResult} AnalysisResult */
/** @typedef {import("../../src/types/audio.ts").LoudnessMetrics} LoudnessMetrics */
/** @typedef {import("../../src/audio/session-file.ts").SessionImportResult} SessionImportResult */
/** A completed fixture job: `result` is always present, unlike the app type. */
/** @typedef {AnalysisJob & { result: AnalysisResult }} CompletedFixtureJob */

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const {
  MAX_SESSION_FILE_BYTES,
  MAX_SESSION_JOBS,
  MAX_SESSION_TIMELINE_POINTS,
  SESSION_VERSION,
  SessionExportError,
  buildSessionFile,
  getSessionFileName,
  normalizeSessionJob,
  parseSessionFile,
  planSessionIntake,
} = await import("../../src/audio/session-file.ts");
const { DEFAULT_TARGET_PRESET } = await import("../../src/audio/presets.ts");
const { fileIdentityKey } = await import("../../src/lib/file-identity.ts");
const { freshRestoredJobs, mergeImportedJobs, reconcileSessionJobs } = await import(
  "../../src/audio/session-reconciliation.ts"
);
const { loadRecentSessions } = await import("@/session/persistence");

const SAMPLE_RATE = 48_000;
const FRAME_COUNT = SAMPLE_RATE * 3;
const left = new Float32Array(FRAME_COUNT);
const right = new Float32Array(FRAME_COUNT);
for (let index = 0; index < FRAME_COUNT; index += 1) {
  left[index] = 0.3 * Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE);
  right[index] = left[index];
}
const asset = parseWavBuffer(
  encodeWav({ channels: [left, right], sampleRate: SAMPLE_RATE }),
  "round-trip.wav",
  "audio/wav",
);
const result = analyzeDecodedAsset(asset, DEFAULT_TARGET_PRESET);

/** @type {CompletedFixtureJob} */
const job = {
  id: "job-1",
  fileName: "round-trip.wav",
  mimeType: "audio/wav",
  status: "complete",
  createdAt: "2026-01-02T03:04:05.000Z",
  progressPercent: 1,
  progressLabel: "Complete",
  provenance: { kind: "local-analysis" },
  result,
};

/**
 * @param {string} name
 * @param {unknown} condition
 * @param {string | null | undefined} [detail]
 */
function check(name, condition, detail = "") {
  test(name, () => {
    assert.ok(condition, detail ?? undefined);
  });
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return structuredClone(value);
}

/**
 * Portable timelines round levels to 0.01 and times to the millisecond; the
 * importer then stores them as float32 again, so allow that last step too.
 *
 * @param {import("../../src/types/audio.ts").AnalysisTimeline} actual
 * @param {import("../../src/types/audio.ts").AnalysisTimeline} expected
 */
function timelineMatchesWithinRounding(actual, expected) {
  /**
   * @param {ArrayLike<number>} a
   * @param {ArrayLike<number>} b
   * @param {number} tolerance
   */
  const close = (a, b, tolerance) => {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (Number.isNaN(a[index]) || Number.isNaN(b[index])) {
        if (!(Number.isNaN(a[index]) && Number.isNaN(b[index]))) return false;
        continue;
      }
      if (Math.abs(a[index] - b[index]) > tolerance + Math.abs(b[index]) * 2 ** -23) return false;
    }
    return true;
  };
  return (
    close(actual.timeSeconds, expected.timeSeconds, 0.0005) &&
    close(actual.momentaryLufs, expected.momentaryLufs, 0.005) &&
    close(actual.shortTermLufs, expected.shortTermLufs, 0.005) &&
    close(actual.truePeakDbtp, expected.truePeakDbtp, 0.005)
  );
}

/**
 * Deterministic five-minute-style timeline with realistic float32 values: a
 * wandering programme level, the momentary and short-term warm-up gaps (NaN),
 * and a true peak a little above the level.
 *
 * @param {number} pointCount
 * @param {number} seed
 * @returns {import("../../src/types/audio.ts").AnalysisTimeline}
 */
function realisticTimeline(pointCount, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 2 ** 32;
  };
  const timeSeconds = new Float32Array(pointCount);
  const momentaryLufs = new Float32Array(pointCount);
  const shortTermLufs = new Float32Array(pointCount);
  const truePeakDbtp = new Float32Array(pointCount);
  let level = -12;
  for (let index = 0; index < pointCount; index += 1) {
    level = Math.max(-30, Math.min(-6, level + (random() - 0.5) * 0.6));
    timeSeconds[index] = (index + 1) * 0.1;
    momentaryLufs[index] = index >= 3 ? level + (random() - 0.5) * 2 : Number.NaN;
    shortTermLufs[index] = index >= 29 ? level : Number.NaN;
    truePeakDbtp[index] = Math.min(0.3, level + 10 + random() * 2);
  }
  return { stepDurationSeconds: 0.1, timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp };
}

/**
 * @template T
 * @param {T} base
 * @param {(value: T) => void} mutate
 */
function mutateEnvelope(base, mutate) {
  const next = clone(base);
  mutate(next);
  return parseSessionFile(JSON.stringify(next));
}

console.log("\n[A] Portable v2 round trip + provenance");
const text = buildSessionFile([job]);
const payload = JSON.parse(text);
const digest = "ab".repeat(32);
const back = parseSessionFile(text, { sourceSessionDigest: digest });
check("v2 emitted", payload.version === SESSION_VERSION && SESSION_VERSION === 2);
check("UTF-8 output stays within the import byte limit", Buffer.byteLength(text, "utf8") <= MAX_SESSION_FILE_BYTES);
check("jobCount matches serialized jobs", payload.jobCount === 1 && payload.jobs.length === 1);
check(
  "analysis timelines use four Float32Array series in memory",
  Object.values(result.metrics.timeline)
    .filter((value) => typeof value !== "number")
    .every((value) => value instanceof Float32Array),
);
check(
  "a five-minute 3,000-point timeline has a 48,000-byte typed-array payload",
  result.metrics.timeline.timeSeconds.BYTES_PER_ELEMENT === 4 &&
    3_000 * 4 * 4 === 48_000,
);
check(
  "missing loudness windows use NaN sentinels in memory and JSON nulls at the boundary",
  Number.isNaN(result.metrics.timeline.momentaryLufs[0]) &&
    payload.jobs[0].result.metrics.timeline.momentaryLufs[0] === null,
);
check("no import error", !back.error, back.error);
check("source version reported", back.sourceVersion === 2);
check("one job restored", back.jobs.length === 1);
const restored = back.jobs[0];
check("portable import gets a fresh id", restored.id !== job.id && restored.id.startsWith("analysis-import-"));
check("source job id retained", restored.provenance?.sourceJobId === job.id);
check("import cannot self-assert local provenance", restored.provenance?.kind === "unverified-import");
check("caller-supplied digest retained", restored.provenance?.sourceSessionDigest === digest);
check("compatibility imported flag retained", restored.imported === true);
check("status complete", restored.status === "complete");
check("filename preserved", restored.fileName === "round-trip.wav");
check("createdAt preserved", restored.createdAt === "2026-01-02T03:04:05.000Z");
check("integrated LUFS preserved", restored.result?.metrics.integratedLufs === result.metrics.integratedLufs);
check("integrated validity preserved", restored.result?.metrics.integratedValid === result.metrics.integratedValid);
check("LRA stability preserved", restored.result?.metrics.loudnessRangeUnstable === true);
check("true peak preserved", restored.result?.metrics.truePeakDbtp === result.metrics.truePeakDbtp);
check("target preserved", restored.result?.target?.id === DEFAULT_TARGET_PRESET.id);
check(
  "timeline preserved",
  restored.result?.metrics.timeline.timeSeconds.length === result.metrics.timeline.timeSeconds.length &&
    restored.result?.metrics.timeline.truePeakDbtp.length === result.metrics.timeline.truePeakDbtp.length,
);
// LOGIC-05: the field-by-field checks above only sample a few metrics. A real
// analyzeDecodedAsset result (this 3 s stereo tone) must round-trip losslessly
// in full apart from the timeline samples, which the portable file rounds to
// 0.01 LU/dB and to the millisecond to keep large sessions under the limit.
{
  const { timeline: restoredTimeline, ...restoredSummary } = restored.result?.metrics ?? {};
  const { timeline: sourceTimeline, ...sourceSummary } = result.metrics;
  check(
    "result.metrics summary values round-trip deep-equal from a real analyzeDecodedAsset run",
    isDeepStrictEqual(restoredSummary, sourceSummary),
  );
  check(
    "the nested timeline round-trips within the portable rounding, gaps intact",
    restoredTimeline !== undefined && timelineMatchesWithinRounding(restoredTimeline, sourceTimeline),
  );
}

const secondImport = parseSessionFile(text);
check("re-import creates another fresh id", secondImport.jobs[0]?.id !== restored.id);
const forgedDigestPayload = clone(payload);
forgedDigestPayload.jobs[0].provenance.sourceSessionDigest = "de".repeat(32);
const forgedDigestImport = parseSessionFile(JSON.stringify(forgedDigestPayload));
check(
  "portable file cannot self-assert its source digest",
  forgedDigestImport.jobs[0]?.provenance?.sourceSessionDigest === undefined,
);
const reexported = JSON.parse(buildSessionFile(back.jobs));
check(
  "re-export preserves unverified provenance and original source id",
  reexported.jobs[0].provenance.kind === "unverified-import" &&
    reexported.jobs[0].provenance.sourceJobId === job.id &&
    reexported.jobs[0].provenance.sourceSessionDigest === digest,
);

check(
  "session filename is timestamped and keeps the .truepeak.json suffix",
  // Same second-resolution stamp as the CSV/JSON/Markdown exports, so a repeat
  // inside one wall-clock second carries a "-2", "-3", ... discriminator.
  /^truepeak-session-\d{8}-\d{6}(-\d+)?\.truepeak\.json$/.test(getSessionFileName()),
);

console.log("\n[B] H-02/Tc fields + legacy v1 compatibility");
const invalidJob = clone(job);
invalidJob.id = "invalid-short";
invalidJob.result.analysisMode = "measure-only";
invalidJob.result.target = null;
invalidJob.result.metadata.durationSeconds = 0.3;
invalidJob.result.metadata.frameCount = 14_400;
/** @type {LoudnessMetrics} */
const invalidMetrics = {
  ...invalidJob.result.metrics,
  integratedLufs: -70,
  integratedValid: false,
  integratedInvalidReason: "too-short",
  loudnessRange: 0,
  loudnessRangeValid: false,
  loudnessRangeUnstable: true,
  unclampedTargetDeltaDb: null,
  targetDeltaDb: null,
  projectedTruePeakDbtp: null,
  normalizationLimited: false,
  timeline: {
    stepDurationSeconds: 0.1,
    timeSeconds: Float32Array.from([0.1, 0.2, 0.3]),
    momentaryLufs: new Float32Array(3).fill(Number.NaN),
    shortTermLufs: new Float32Array(3).fill(Number.NaN),
    truePeakDbtp: Float32Array.from([-120, -120, -120]),
  },
};
invalidJob.result.metrics = invalidMetrics;
const invalidBack = parseSessionFile(buildSessionFile([invalidJob]));
check("invalid integrated status round-trips", invalidBack.jobs[0]?.result?.metrics.integratedValid === false);
check("invalid integrated reason round-trips", invalidBack.jobs[0]?.result?.metrics.integratedInvalidReason === "too-short");
check("invalid targeting stays absent", invalidBack.jobs[0]?.result?.metrics.targetDeltaDb === null);
check("invalid LRA status round-trips", invalidBack.jobs[0]?.result?.metrics.loudnessRangeValid === false);
check(
  "result with invalid LRA round-trips deeply",
  isDeepStrictEqual(invalidBack.jobs[0]?.result, invalidJob.result),
);

const tcEnvelope = clone(payload);
tcEnvelope.jobs[0].result.metadata.channelCount = 4;
tcEnvelope.jobs[0].result.metadata.channelLayout = {
  name: "L / R / C / Tc",
  labels: ["L", "R", "C", "Tc"],
  guessed: false,
  speakerMask: 0x807,
};
const tcBack = parseSessionFile(JSON.stringify(tcEnvelope));
check("Tc is accepted by the channel-label whitelist", tcBack.jobs[0]?.result?.metadata.channelLayout.labels[3] === "Tc");

const legacyEnvelope = clone(payload);
legacyEnvelope.version = 1;
delete legacyEnvelope.jobs[0].provenance;
delete legacyEnvelope.jobs[0].result.metrics.integratedValid;
delete legacyEnvelope.jobs[0].result.metrics.integratedInvalidReason;
delete legacyEnvelope.jobs[0].result.metrics.loudnessRangeValid;
delete legacyEnvelope.jobs[0].result.metrics.loudnessRangeUnstable;
const legacy = parseSessionFile(JSON.stringify(legacyEnvelope));
check("v1 session remains importable", !legacy.error && legacy.sourceVersion === 1);
check("v1 missing validity stays legacy/absent", legacy.jobs[0]?.result?.metrics.integratedValid === undefined);
check(
  "v1 missing LRA validity is treated as valid",
  legacy.jobs[0]?.result?.metrics.loudnessRangeValid !== false,
);
check("v1 import is still unverified", legacy.jobs[0]?.provenance?.kind === "unverified-import");
const olderV2Envelope = clone(payload);
delete olderV2Envelope.jobs[0].result.metrics.loudnessRangeValid;
const olderV2 = parseSessionFile(JSON.stringify(olderV2Envelope));
check(
  "older v2 missing LRA validity is treated as valid",
  !olderV2.error && olderV2.jobs[0]?.result?.metrics.loudnessRangeValid !== false,
);
const firstAmbiguousFile = { name: "same.wav", size: 10, lastModified: 1 };
const secondAmbiguousFile = { name: "same.wav", size: 10, lastModified: 1 };
check(
  "only exact File object identity is deduplicated",
  fileIdentityKey(firstAmbiguousFile) === fileIdentityKey(firstAmbiguousFile) &&
    fileIdentityKey(firstAmbiguousFile) !== fileIdentityKey(secondAmbiguousFile),
);
check(
  "same-looking folder paths retain distinct File objects",
  fileIdentityKey({
    name: "clip.wav",
    size: 10,
    lastModified: 1,
    webkitRelativePath: "root/clip.wav",
  }) !==
    fileIdentityKey({
      name: "clip.wav",
      size: 10,
      lastModified: 1,
      webkitRelativePath: "root/clip.wav",
    }),
);

console.log("\n[C] Envelope/job consistency rejection");
check("invalid JSON rejected", !!parseSessionFile("not json at all").error);
check("wrong app rejected", !!parseSessionFile(JSON.stringify({ app: "something-else" })).error);
check("non-object rejected", !!parseSessionFile("42").error);
check(
  "unsupported version rejected",
  !!mutateEnvelope(payload, (value) => { value.version = 99; }).error,
);
const oversizedVersion = mutateEnvelope(payload, (value) => {
  value.version = "x".repeat(1_000_000);
});
check(
  "unsupported version error does not echo attacker-controlled content",
  oversizedVersion.error === "This session file uses an unsupported version. Export it again from the current version of TruePeak, then open it.",
);
check(
  "invalid export date rejected",
  !!mutateEnvelope(payload, (value) => { value.exportedAt = "tomorrow-ish"; }).error,
);
check(
  "job-count mismatch rejected",
  !!mutateEnvelope(payload, (value) => { value.jobCount = 2; }).error,
);
check(
  "non-complete row rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].status = "queued"; }).error,
);
check(
  "bad createdAt rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].createdAt = "2026-99-99"; }).error,
);
check(
  "createdAt after analyzedAt rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].createdAt = "2099-01-01T00:00:00.000Z"; }).error,
);
check(
  "outer/result filename mismatch rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].fileName = "different.wav"; }).error,
);
check(
  "mixed valid/invalid file fails atomically",
  !!mutateEnvelope(payload, (value) => {
    value.jobs.push({ ...clone(value.jobs[0]), id: "bad", result: {} });
    value.jobCount = 2;
  }).error,
);

console.log("\n[D] Metadata, target, validity, and timeline invariants");
check(
  "fractional sample rate rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metadata.sampleRate = 48_000.5; }).error,
);
check(
  "zero frame count rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metadata.frameCount = 0; }).error,
);
check(
  "duration/frame mismatch rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metadata.durationSeconds = 99; }).error,
);
check(
  "unknown channel label rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metadata.channelLayout.labels[0] = "Frontish"; }).error,
);
check(
  "channel-count/labels mismatch rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metadata.channelLayout.labels.pop(); }).error,
);
check(
  "measure-only result carrying a target rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.analysisMode = "measure-only"; }).error,
);
check(
  "targeted result without a target rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.target = null; }).error,
);
check(
  "invalid flag without reason rejected",
  !!mutateEnvelope(payload, (value) => {
    const metrics = value.jobs[0].result.metrics;
    metrics.integratedLufs = -70;
    metrics.integratedValid = false;
    delete metrics.integratedInvalidReason;
    metrics.unclampedTargetDeltaDb = null;
    metrics.targetDeltaDb = null;
    metrics.projectedTruePeakDbtp = null;
    metrics.normalizationLimited = false;
  }).error,
);
check(
  "LRA stability/duration mismatch rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metrics.loudnessRangeUnstable = false; }).error,
);
check(
  "invalid LRA flag with a nonzero wire value rejected",
  !!mutateEnvelope(payload, (value) => {
    value.jobs[0].result.metrics.loudnessRangeValid = false;
    value.jobs[0].result.metrics.loudnessRange = 1;
  }).error,
);
check(
  "misaligned timeline arrays rejected",
  !!mutateEnvelope(payload, (value) => { value.jobs[0].result.metrics.timeline.truePeakDbtp.pop(); }).error,
);
check(
  "non-increasing timeline rejected",
  !!mutateEnvelope(payload, (value) => {
    const times = value.jobs[0].result.metrics.timeline.timeSeconds;
    times[1] = times[0];
  }).error,
);
check(
  "timeline beyond media duration rejected",
  !!mutateEnvelope(payload, (value) => {
    const timeline = value.jobs[0].result.metrics.timeline;
    timeline.timeSeconds[timeline.timeSeconds.length - 1] = 99;
  }).error,
);

console.log("\n[E] Aggregate limits + portable export guarantees");
const overJobLimit = clone(payload);
overJobLimit.jobs = Array.from({ length: MAX_SESSION_JOBS + 1 }, (_, index) => ({
  ...clone(payload.jobs[0]),
  id: `job-${index}`,
}));
overJobLimit.jobCount = overJobLimit.jobs.length;
const overJobResult = parseSessionFile(JSON.stringify(overJobLimit));
check("over-limit import fails instead of truncating", !!overJobResult.error && overJobResult.jobs.length === 0);

let overLimitExportThrew = false;
try {
  buildSessionFile(
    Array.from({ length: MAX_SESSION_JOBS + 1 }, (_, index) => ({ ...job, id: `local-${index}` })),
  );
} catch (error) {
  overLimitExportThrew = error instanceof SessionExportError;
}
check("over-limit export fails explicitly", overLimitExportThrew);

let emptyExportThrew = false;
try {
  buildSessionFile([]);
} catch (error) {
  emptyExportThrew = error instanceof SessionExportError;
}
check("empty non-importable export fails explicitly", emptyExportThrew);

const perJobPoints = Math.floor(MAX_SESSION_TIMELINE_POINTS / 2) + 1;
const aggregateEnvelope = clone(payload);
/** @param {string} id */
const makeLargeEntry = (id) => {
  const entry = clone(payload.jobs[0]);
  entry.id = id;
  entry.result.metadata.durationSeconds = perJobPoints * 0.1;
  entry.result.metadata.frameCount = perJobPoints * 4_800;
  entry.result.metrics.loudnessRangeUnstable = false;
  entry.result.metrics.timeline = {
    stepDurationSeconds: 0.1,
    timeSeconds: Array.from({ length: perJobPoints }, (_, index) => (index + 1) * 0.1),
    momentaryLufs: Array(perJobPoints).fill(null),
    shortTermLufs: Array(perJobPoints).fill(null),
    truePeakDbtp: Array(perJobPoints).fill(-1),
  };
  return entry;
};
aggregateEnvelope.jobs = [makeLargeEntry("large-a"), makeLargeEntry("large-b")];
aggregateEnvelope.jobCount = 2;
const aggregateResult = parseSessionFile(JSON.stringify(aggregateEnvelope));
check("aggregate timeline budget enforced across jobs", !!aggregateResult.error && aggregateResult.jobs.length === 0);

const oversizedTimelineJob = clone(job);
const sourcePointCount = MAX_SESSION_TIMELINE_POINTS + 1;
oversizedTimelineJob.id = "needs-downsampling";
oversizedTimelineJob.result.metadata.durationSeconds = sourcePointCount * 0.1;
oversizedTimelineJob.result.metadata.frameCount = sourcePointCount * 4_800;
oversizedTimelineJob.result.metrics.loudnessRangeUnstable = false;
// Realistic float32 levels, not constant -1/NaN fills: a constant series
// serialises in a few bytes per point and hid how large a real file gets.
oversizedTimelineJob.result.metrics.timeline = realisticTimeline(sourcePointCount, 7);
let downsampledText = "";
/** @type {SessionImportResult} */
let downsampledImport = { jobs: [], error: "not built" };
try {
  downsampledText = buildSessionFile([oversizedTimelineJob]);
  downsampledImport = parseSessionFile(downsampledText);
} catch (error) {
  downsampledImport = { jobs: [], error: error instanceof Error ? error.message : String(error) };
}
check("oversized source timeline is downsampled into an importable file", !downsampledImport.error, downsampledImport.error);
check(
  "downsampled timeline obeys aggregate point budget",
  downsampledImport.jobs[0]?.result?.metrics.timeline.timeSeconds.length === MAX_SESSION_TIMELINE_POINTS,
);
check(
  "downsampled export byte count obeys importer limit",
  Buffer.byteLength(downsampledText, "utf8") <= MAX_SESSION_FILE_BYTES,
);
{
  const restoredTimeline = downsampledImport.jobs[0]?.result?.metrics.timeline;
  check(
    "downsampled realistic timeline keeps its warm-up gaps as nulls and rounded values",
    restoredTimeline !== undefined &&
      Number.isNaN(restoredTimeline.momentaryLufs[0]) &&
      Number.isNaN(restoredTimeline.shortTermLufs[28]) &&
      Number.isFinite(restoredTimeline.shortTermLufs[29]) &&
      /"momentaryLufs":\[null,null,null,-?\d+(\.\d{1,2})?,/.test(downsampledText),
  );
}

// A full session at the job cap with realistic five-minute timelines (3,000
// points each, downsampled to the aggregate point cap) must still export under
// the import limit and round-trip.
{
  const fiveMinutePoints = 3_000;
  const fullSessionJobs = Array.from({ length: MAX_SESSION_JOBS }, (_, index) => {
    const entry = clone(job);
    entry.id = `full-session-${index}`;
    entry.result.metadata.durationSeconds = fiveMinutePoints * 0.1;
    entry.result.metadata.frameCount = fiveMinutePoints * 4_800;
    entry.result.metrics.loudnessRangeUnstable = false;
    entry.result.metrics.timeline = realisticTimeline(fiveMinutePoints, index + 1);
    return entry;
  });
  let fullSessionText = "";
  /** @type {SessionImportResult} */
  let fullSessionImport = { jobs: [], error: "not built" };
  try {
    fullSessionText = buildSessionFile(fullSessionJobs);
    fullSessionImport = parseSessionFile(fullSessionText);
  } catch (error) {
    fullSessionImport = { jobs: [], error: error instanceof Error ? error.message : String(error) };
  }
  check(
    "1,000 jobs with realistic five-minute timelines export under the import limit",
    fullSessionText.length > 0 && Buffer.byteLength(fullSessionText, "utf8") <= MAX_SESSION_FILE_BYTES,
    `${Buffer.byteLength(fullSessionText, "utf8")} bytes`,
  );
  check(
    "the 1,000-job session round-trips every job at the aggregate point cap",
    !fullSessionImport.error &&
      fullSessionImport.jobs.length === MAX_SESSION_JOBS &&
      fullSessionImport.jobs.reduce(
        (sum, entry) => sum + (entry.result?.metrics.timeline.timeSeconds.length ?? 0),
        0,
      ) === MAX_SESSION_TIMELINE_POINTS,
    fullSessionImport.error,
  );
  check(
    "the portable session is serialised compactly",
    fullSessionText.startsWith("{\"app\":") && !fullSessionText.includes("\n"),
  );
}

console.log("\n[F] Global session intake cap");
check(
  "session limit is the shared 1,000-job cap",
  MAX_SESSION_JOBS === 1000,
  `MAX_SESSION_JOBS=${MAX_SESSION_JOBS}`,
);
{
  const plan = planSessionIntake(999, 5);
  check(
    "boundary: 999 existing + add 5 accepts exactly 1 and turns 4 away",
    plan.accepted === 1 && plan.turnedAway === 4 && plan.capacity === 1,
    JSON.stringify(plan),
  );
}
{
  const plan = planSessionIntake(MAX_SESSION_JOBS, 3);
  check(
    "at the limit: 1,000 existing + add 3 accepts 0 (all turned away)",
    plan.accepted === 0 && plan.turnedAway === 3 && plan.capacity === 0,
    JSON.stringify(plan),
  );
}
{
  const plan = planSessionIntake(0, 1200);
  check(
    "empty session + add 1,200 accepts 1,000 and turns 200 away",
    plan.accepted === MAX_SESSION_JOBS && plan.turnedAway === 200 && plan.capacity === MAX_SESSION_JOBS,
    JSON.stringify(plan),
  );
}
{
  const plan = planSessionIntake(0, MAX_SESSION_JOBS);
  check(
    "exact fit fills the session to the limit with no overflow",
    plan.accepted === MAX_SESSION_JOBS && plan.turnedAway === 0,
    JSON.stringify(plan),
  );
}
{
  const plan = planSessionIntake(0, 10);
  check(
    "under-limit add accepts every file and turns none away",
    plan.accepted === 10 && plan.turnedAway === 0,
    JSON.stringify(plan),
  );
}
{
  // Defensive: a NaN/negative current count must not manufacture capacity above
  // the cap or produce a negative accepted/turnedAway.
  const plan = planSessionIntake(Number.NaN, 5);
  check(
    "non-finite current count falls back to an empty session",
    plan.accepted === 5 && plan.turnedAway === 0 && plan.capacity === MAX_SESSION_JOBS,
    JSON.stringify(plan),
  );
}

console.log("\n[G] Portable-import merge shares the global session cap");
// mergeImportedJobs is the single path importSession() uses to fold a portable
// file into the live session. It must obey the same 1,000-job cap as file
// intake: an import onto a full session is turned away, not silently merged
// past the limit. These local fixtures have lineage ids no import below
// carries, so they count toward the cap denominator without ever matching.
/**
 * @param {number} id
 * @returns {AnalysisJob}
 */
const makeMergeLocalJob = (id) => ({
  id: `local-${id}`,
  fileName: `local-${id}.wav`,
  mimeType: "audio/wav",
  status: "complete",
  createdAt: "2026-01-02T03:04:05.000Z",
  progressPercent: 1,
  progressLabel: "Complete",
  provenance: { kind: "local-analysis" },
  result,
});
// `slot` drives the provenance identity (so two jobs sharing a slot collide as
// duplicates); `id` only varies the row id, which is deliberately NOT part of
// the dedupe key.
/**
 * @param {number} slot
 * @param {string} [id]
 * @returns {AnalysisJob}
 */
const makeMergeImportedJob = (slot, id = `slot-${slot}`) => ({
  id: `analysis-import-${id}`,
  fileName: `import-${slot}.wav`,
  mimeType: "audio/wav",
  status: "complete",
  createdAt: "2026-01-02T03:04:05.000Z",
  progressPercent: 1,
  progressLabel: "Imported",
  imported: true,
  provenance: {
    kind: "unverified-import",
    sourceJobId: `src-${slot}`,
    sourceSessionDigest: digest,
  },
  result,
});

{
  // Core regression for the reported defect: a session already at the cap must
  // reject the whole import instead of growing to 1,005.
  const full = Array.from({ length: MAX_SESSION_JOBS }, (_, i) => makeMergeLocalJob(i));
  const incoming = Array.from({ length: 5 }, (_, i) => makeMergeImportedJob(i));
  const plan = mergeImportedJobs(full, incoming);
  check(
    "import onto an at-limit session adds nothing",
    plan.added === 0 && plan.toAdd.length === 0,
    JSON.stringify({ added: plan.added }),
  );
  check(
    "import onto an at-limit session reports all rows as over-cap, not duplicates",
    plan.skippedOverCap === 5 && plan.skippedDuplicates === 0,
    JSON.stringify(plan),
  );
  check(
    "merged session never exceeds MAX_SESSION_JOBS after an at-limit import",
    full.length + plan.added <= MAX_SESSION_JOBS,
    `${full.length} + ${plan.added}`,
  );
}
{
  // Partial acceptance at the boundary: only the remaining room is taken.
  const near = Array.from({ length: MAX_SESSION_JOBS - 2 }, (_, i) => makeMergeLocalJob(i));
  const incoming = Array.from({ length: 5 }, (_, i) => makeMergeImportedJob(i));
  const plan = mergeImportedJobs(near, incoming);
  check(
    "near-limit import accepts only the remaining room and turns the rest away",
    plan.added === 2 && plan.skippedOverCap === 3 && plan.skippedDuplicates === 0,
    JSON.stringify(plan),
  );
  check(
    "partial import fills the session to exactly the limit",
    near.length + plan.added === MAX_SESSION_JOBS,
    `${near.length} + ${plan.added}`,
  );
}
{
  // Below the cap, everything distinct is accepted.
  const small = Array.from({ length: 10 }, (_, i) => makeMergeLocalJob(i));
  const incoming = Array.from({ length: 5 }, (_, i) => makeMergeImportedJob(i));
  const plan = mergeImportedJobs(small, incoming);
  check(
    "under-limit import accepts every distinct row",
    plan.added === 5 && plan.skippedOverCap === 0 && plan.skippedDuplicates === 0,
    JSON.stringify(plan),
  );
}
{
  // Idempotent re-import: a row already present (same provenance identity) is a
  // duplicate, not an over-cap skip, and does not consume capacity.
  const current = [makeMergeImportedJob(0, "existing")];
  const incoming = [makeMergeImportedJob(0, "dup"), makeMergeImportedJob(1, "new")];
  const plan = mergeImportedJobs(current, incoming);
  check(
    "duplicate import row is deduplicated while the new row is added",
    plan.added === 1 && plan.skippedDuplicates === 1 && plan.skippedOverCap === 0,
    JSON.stringify(plan),
  );
}
{
  // Dedupe and cap interact correctly: at 999 jobs (one an import) a 3-row file
  // with one duplicate leaves 2 fresh rows but only 1 slot of room.
  const current = [
    ...Array.from({ length: MAX_SESSION_JOBS - 2 }, (_, i) => makeMergeLocalJob(i)),
    makeMergeImportedJob(0, "existing"),
  ];
  const incoming = [
    makeMergeImportedJob(0, "dup"),
    makeMergeImportedJob(1),
    makeMergeImportedJob(2),
  ];
  const plan = mergeImportedJobs(current, incoming);
  check(
    "dedupe runs before the cap and the cap bounds what remains",
    plan.added === 1 && plan.skippedDuplicates === 1 && plan.skippedOverCap === 1,
    JSON.stringify(plan),
  );
  check(
    "combined dedupe + cap still lands exactly at the limit",
    current.length + plan.added === MAX_SESSION_JOBS,
    `${current.length} + ${plan.added}`,
  );
}

console.log("\n[G2] Importing a session already in the workspace adds nothing");
// Regression: a recovery-restored workspace plus "Open session" on its own
// export doubled every row. The import must match the rows it came from by
// lineage (the original job id) and measured fingerprint, whether they are
// live, restored, or earlier imports.
{
  const quietLeft = left.map((sample) => sample * 0.25);
  const quietAsset = parseWavBuffer(
    encodeWav({ channels: [quietLeft, quietLeft], sampleRate: SAMPLE_RATE }),
    "quiet.wav",
    "audio/wav",
  );
  const quietResult = analyzeDecodedAsset(quietAsset, DEFAULT_TARGET_PRESET);
  /** @type {AnalysisJob} */
  const jobA = { ...job, id: "analysis-a" };
  /** @type {AnalysisJob} */
  const jobB = { ...job, id: "analysis-b", fileName: "quiet.wav", result: quietResult };
  /** @type {AnalysisJob} */
  const jobC = { ...job, id: "analysis-c", fileName: "quiet.wav", result: quietResult };
  const settings = {
    analysisBlocked: false,
    analysisMode: /** @type {const} */ ("targeted"),
    target: DEFAULT_TARGET_PRESET,
  };
  /**
   * @param {AnalysisJob[]} jobs
   * @param {string} [sourceSessionDigest]
   */
  const importOf = (jobs, sourceSessionDigest = digest) =>
    reconcileSessionJobs(
      parseSessionFile(buildSessionFile(jobs), { sourceSessionDigest }).jobs,
      settings,
    );
  const sessionAB = importOf([jobA, jobB]);
  /** @param {AnalysisJob} source */
  const restoredCopy = (source) => {
    const normalized = normalizeSessionJob(clone(source));
    assert.ok(normalized);
    return { ...normalized, progressLabel: "Restored", restored: true };
  };

  {
    const plan = mergeImportedJobs([jobA, jobB], sessionAB);
    check(
      "re-importing a session into the workspace that exported it adds 0",
      plan.added === 0 && plan.skippedDuplicates === 2 && plan.skippedOverCap === 0,
      JSON.stringify(plan),
    );
  }
  {
    const plan = mergeImportedJobs([restoredCopy(jobA), restoredCopy(jobB)], sessionAB);
    check(
      "importing a session into its recovery-restored copy adds 0",
      plan.added === 0 && plan.skippedDuplicates === 2 && plan.skippedOverCap === 0,
      JSON.stringify(plan),
    );
  }
  {
    const first = mergeImportedJobs([], sessionAB);
    const second = mergeImportedJobs(first.toAdd, importOf([jobA, jobB], "cd".repeat(32)));
    const reexported = mergeImportedJobs(first.toAdd, importOf(first.toAdd, "ef".repeat(32)));
    check(
      "the same session imported twice adds its rows once",
      first.added === 2 && second.added === 0 && second.skippedDuplicates === 2,
      JSON.stringify({ first: first.added, second }),
    );
    check(
      "a re-export of imported rows still matches them by original lineage",
      reexported.added === 0 && reexported.skippedDuplicates === 2,
      JSON.stringify(reexported),
    );
  }
  {
    const measureOnly = reconcileSessionJobs(sessionAB, {
      ...settings,
      analysisMode: "measure-only",
      target: null,
    });
    const plan = mergeImportedJobs([jobA, jobB], measureOnly);
    check(
      "a duplicate stays a duplicate when reconciled to a different target",
      plan.added === 0 && plan.skippedDuplicates === 2,
      JSON.stringify(plan),
    );
  }
  {
    const plan = mergeImportedJobs([jobA, jobB], importOf([jobC]));
    check(
      "a different session merges",
      plan.added === 1 && plan.skippedDuplicates === 0,
      JSON.stringify(plan),
    );
  }
  {
    // jobB and jobC share a file name but are separate analyses (distinct
    // lineage), so a session holding both keeps both, into any workspace.
    const empty = mergeImportedJobs([], importOf([jobB, jobC]));
    const withB = mergeImportedJobs([jobB], importOf([jobB, jobC]));
    check(
      "two different files with the same name are both kept",
      empty.added === 2 && withB.added === 1 && withB.skippedDuplicates === 1,
      JSON.stringify({ empty: empty.added, withB }),
    );
  }
  {
    // Same lineage, different measurement (the source was analyzed again): the
    // import is additive and never replaces or drops a row already present.
    /** @type {AnalysisJob} */
    const reanalyzed = { ...jobA, result: { ...result, analyzedAt: "2026-01-03T00:00:00.000Z" } };
    const plan = mergeImportedJobs([reanalyzed], importOf([jobA]));
    check(
      "a different analysis of the same source is added alongside, not merged",
      plan.added === 1 && plan.skippedDuplicates === 0,
      JSON.stringify(plan),
    );
  }
  {
    const full = [
      ...Array.from({ length: MAX_SESSION_JOBS - 2 }, (_, i) => makeMergeLocalJob(i)),
      jobA,
      jobB,
    ];
    const plan = mergeImportedJobs(full, sessionAB);
    check(
      "duplicates into an at-limit session are reported as duplicates, not over the cap",
      plan.added === 0 && plan.skippedDuplicates === 2 && plan.skippedOverCap === 0,
      JSON.stringify(plan),
    );
  }
  {
    const nearFull = [
      ...Array.from({ length: MAX_SESSION_JOBS - 2 }, (_, i) => makeMergeLocalJob(i)),
      jobA,
    ];
    const plan = mergeImportedJobs(nearFull, importOf([jobA, jobB, jobC]));
    check(
      "skipped duplicates do not consume the room left under the cap",
      plan.added === 1 &&
        plan.skippedDuplicates === 1 &&
        plan.skippedOverCap === 1 &&
        nearFull.length + plan.added === MAX_SESSION_JOBS,
      JSON.stringify(plan),
    );
  }
  {
    // Race: the session is opened before the recovery read lands, so the
    // workspace already holds imported copies when the restored rows arrive.
    const imported = mergeImportedJobs([], sessionAB).toAdd;
    const fresh = freshRestoredJobs(imported, [restoredCopy(jobA), restoredCopy(jobB)]);
    check("a restore landing after the same session was opened adds 0", fresh.length === 0, `${fresh.length}`);
    const withNew = freshRestoredJobs(imported, [restoredCopy(jobA), restoredCopy(jobC)]);
    check(
      "a restore still adds rows the opened session does not hold",
      withNew.length === 1 && withNew[0].id === jobC.id,
      JSON.stringify(withNew.map((row) => row.id)),
    );
    const byId = freshRestoredJobs([jobA], [restoredCopy(jobA), restoredCopy(jobB)]);
    check(
      "a restore still skips rows already present by id",
      byId.length === 1 && byId[0].id === jobB.id,
      JSON.stringify(byId.map((row) => row.id)),
    );
    // A store holding both an original and its imported copy restores one row.
    const batch = freshRestoredJobs([], [restoredCopy(jobA), restoredCopy(imported[0])]);
    check(
      "an original and its imported copy in one restore collapse to one row",
      batch.length === 1 && batch[0].id === jobA.id,
      JSON.stringify(batch.map((row) => row.id)),
    );
  }
}

console.log("\n[H] LOGIC-07 — persistence.ts keeps valid rows from a v2 recent-sessions envelope");
{
  // Fake window.localStorage the way validate-export.mjs does, scoped to this block.
  class MemoryStorage {
    /** @type {Map<string, string>} */
    values = new Map();
    get length() {
      return this.values.size;
    }
    clear() {
      this.values.clear();
    }
    /** @param {number} index */
    key(index) {
      return [...this.values.keys()][index] ?? null;
    }
    /** @param {string} key */
    getItem(key) {
      return this.values.get(key) ?? null;
    }
    /**
     * @param {string} key
     * @param {string} value
     */
    setItem(key, value) {
      this.values.set(key, String(value));
    }
    /** @param {string} key */
    removeItem(key) {
      this.values.delete(key);
    }
  }
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });

  /**
   * @param {string} id
   * @param {number} second
   * @returns {RecentSessionEntry}
   */
  const validEntry = (id, second) => ({
    id,
    fileName: `${id}.wav`,
    analyzedAt: `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    analysisMode: "measure-only",
    recordTrust: "validated-v2",
    provenanceKind: "local-analysis",
    targetLabel: null,
    integratedLufs: -14,
    integratedValid: true,
    truePeakDbtp: -1,
    loudnessRange: 3,
    loudnessRangeValid: true,
    loudnessRangeUnstable: false,
    sampleRate: 48000,
    channelLayoutName: "Stereo",
    decoderLabel: "native",
    complianceLabel: null,
  });
  // Invalid: analysisMode "targeted" requires a string targetLabel; null fails
  // isRecentSessionEntry's targetSemanticsValid check for the v2 schema.
  const invalidEntry = { ...validEntry("row-bad", 3), analysisMode: "targeted" };
  storage.setItem(
    "truepeak-recent-sessions",
    JSON.stringify({
      version: 2,
      entries: [invalidEntry, validEntry("row-1", 1), validEntry("row-2", 2)],
    }),
  );
  const survivors = loadRecentSessions();
  check(
    "a v2 envelope with one invalid row keeps the valid rows instead of wiping the whole history",
    survivors.length === 2 && survivors.every((entry) => entry.id !== "row-bad"),
    JSON.stringify(survivors.map((entry) => entry.id)),
  );

  Reflect.deleteProperty(globalThis, "window");
}
