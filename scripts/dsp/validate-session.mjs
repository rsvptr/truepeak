// Portable-session v2 round trips, legacy-v1 compatibility, provenance, and
// rejection tests for the untrusted JSON boundary.
// Run: node scripts/dsp/validate-session.mjs
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

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
  parseSessionFile,
  planSessionIntake,
} = await import("../../src/audio/session-file.ts");
const { DEFAULT_TARGET_PRESET } = await import("../../src/audio/presets.ts");
const { fileIdentityKey } = await import("../../src/lib/file-identity.ts");
const { mergeImportedJobs } = await import("../../src/audio/session-reconciliation.ts");

function encodeWavFloat32(channels, sampleRate) {
  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const blockAlign = channelCount * 4;
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      view.setFloat32(offset, channels[channel][frame], true);
      offset += 4;
    }
  }
  return buffer;
}

const SAMPLE_RATE = 48_000;
const FRAME_COUNT = SAMPLE_RATE * 3;
const left = new Float32Array(FRAME_COUNT);
const right = new Float32Array(FRAME_COUNT);
for (let index = 0; index < FRAME_COUNT; index += 1) {
  left[index] = 0.3 * Math.sin((2 * Math.PI * 1000 * index) / SAMPLE_RATE);
  right[index] = left[index];
}
const asset = parseWavBuffer(
  encodeWavFloat32([left, right], SAMPLE_RATE),
  "round-trip.wav",
  "audio/wav",
);
const result = analyzeDecodedAsset(asset, DEFAULT_TARGET_PRESET);

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

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

function clone(value) {
  return structuredClone(value);
}

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
  /^truepeak-session-\d{8}-\d{6}\.truepeak\.json$/.test(getSessionFileName()),
);

console.log("\n[B] H-02/Tc fields + legacy v1 compatibility");
const invalidJob = clone(job);
invalidJob.id = "invalid-short";
invalidJob.result.analysisMode = "measure-only";
invalidJob.result.target = null;
invalidJob.result.metadata.durationSeconds = 0.3;
invalidJob.result.metadata.frameCount = 14_400;
invalidJob.result.metrics = {
  ...invalidJob.result.metrics,
  integratedLufs: -70,
  integratedValid: false,
  integratedInvalidReason: "too-short",
  loudnessRange: 0,
  loudnessRangeUnstable: true,
  unclampedTargetDeltaDb: null,
  targetDeltaDb: null,
  projectedTruePeakDbtp: null,
  normalizationLimited: false,
  timeline: {
    stepDurationSeconds: 0.1,
    timeSeconds: [0.1, 0.2, 0.3],
    momentaryLufs: [null, null, null],
    shortTermLufs: [null, null, null],
    truePeakDbtp: [-120, -120, -120],
  },
};
const invalidBack = parseSessionFile(buildSessionFile([invalidJob]));
check("invalid integrated status round-trips", invalidBack.jobs[0]?.result?.metrics.integratedValid === false);
check("invalid integrated reason round-trips", invalidBack.jobs[0]?.result?.metrics.integratedInvalidReason === "too-short");
check("invalid targeting stays absent", invalidBack.jobs[0]?.result?.metrics.targetDeltaDb === null);

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
delete legacyEnvelope.jobs[0].result.metrics.loudnessRangeUnstable;
const legacy = parseSessionFile(JSON.stringify(legacyEnvelope));
check("v1 session remains importable", !legacy.error && legacy.sourceVersion === 1);
check("v1 missing validity stays legacy/absent", legacy.jobs[0]?.result?.metrics.integratedValid === undefined);
check("v1 import is still unverified", legacy.jobs[0]?.provenance?.kind === "unverified-import");
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
  oversizedVersion.error === "This session file uses an unsupported version.",
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
oversizedTimelineJob.result.metrics.timeline = {
  stepDurationSeconds: 0.1,
  timeSeconds: Array.from({ length: sourcePointCount }, (_, index) => (index + 1) * 0.1),
  momentaryLufs: Array(sourcePointCount).fill(null),
  shortTermLufs: Array(sourcePointCount).fill(null),
  truePeakDbtp: Array(sourcePointCount).fill(-1),
};
let downsampledText = "";
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
// past the limit. A local job has no import provenance key, so it counts toward
// the cap denominator but is never a dedupe target.
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

console.log(`\n==== Session format: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
