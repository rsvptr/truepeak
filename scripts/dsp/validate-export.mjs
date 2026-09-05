// Validation for CSV / JSON / Markdown report integrity, including H-02
// validity presentation, provenance, and untrusted Markdown escaping.
// Run: npm run test:export
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { makeTargetPreset, makeTimeline } from "./lib/job-fixtures.mjs";

register("./alias-loader.mjs", import.meta.url);

/** @typedef {import("../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../src/types/audio.ts").AnalysisProvenance} AnalysisProvenance */
/** @typedef {import("../../src/types/audio.ts").AnalysisTimeline} AnalysisTimeline */
/** @typedef {import("../../src/types/audio.ts").IntegratedInvalidReason} IntegratedInvalidReason */
/** @typedef {import("../../src/types/audio.ts").TargetPreset} TargetPreset */
/** @typedef {import("../../src/lib/session-selectors.ts").CompletedAnalysisJob} CompletedAnalysisJob */

/**
 * The part of a JSON export entry these assertions read. The exporter builds
 * its payload inline, so there is no shared type to import.
 *
 * @typedef {object} JsonExportEntry
 * @property {string} id
 * @property {string} fileName
 * @property {{ kind: string, sourceJobId?: string, sourceSessionDigest?: string }} provenance
 * @property {string} [provenanceWarning]
 * @property {{ state: string }} compliance
 * @property {{
 *   integratedLoudness: { status: string, invalidReason: string | null, valueLufs: number | null },
 *   loudnessRange: { status: string, valid: boolean, valueLu: number | null },
 * }} measurements
 * @property {{
 *   metrics: {
 *     integratedLufs: number | null,
 *     rawIntegratedLufs: number,
 *     loudnessRange: number | null,
 *     loudnessRangeValid: boolean,
 *     loudnessRangeUnstable: boolean | null,
 *     samplePeakDbfs: number | null,
 *     truePeakDbtp: number | null,
 *     timeline: { timeSeconds: number[] },
 *     timelineDownsampled: boolean,
 *     timelineSourcePoints: number,
 *   },
 * }} result
 */

/**
 * The targeted fixtures below always carry a target; this keeps that implicit
 * assumption explicit instead of silently reading through a nullable field.
 *
 * @param {CompletedAnalysisJob} job
 * @returns {TargetPreset}
 */
function targetOf(job) {
  const { target } = job.result;
  if (!target) {
    throw new Error(`Fixture ${job.fileName} has no target.`);
  }
  return target;
}

const {
  buildCsvExport,
  buildJsonExport,
  buildMarkdownExport,
  getExportFileName,
  getIntegratedMeasurementPresentation,
} = await import("../../src/audio/export.ts");
const {
  MEASUREMENT_PRECISION,
  fileNameTimestamp,
  formatDb,
  formatIntegratedLufs,
  formatLoudnessRange,
  formatPeakDbtp,
} = await import("../../src/lib/format.ts");
const { loadRecentSessions, mergeRecentSessions } = await import("@/session/persistence");
const { MAX_SESSION_TIMELINE_POINTS } = await import("../../src/audio/session-file.ts");
const {
  readAnalysisSettingsPreference,
  writeAnalysisSettingsPreference,
} = await import("../../src/lib/workspace-preferences.ts");
const {
  averageIntegratedLufs,
  compareOptionalMetric,
  getAttentionJobs,
  getHighestProjectedPeakJob,
  getLargestMoveJob,
  getLoudestJob,
  getQuietestJob,
  getTargetedFocusJobs,
  getWidestRangeJob,
} = await import("../../src/lib/session-selectors.ts");

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

/** @type {AnalysisProvenance} */
const LOCAL_PROVENANCE = { kind: "local-analysis" };

/**
 * @param {string} fileName
 * @param {{
 *   integratedLufs?: number,
 *   truePeakDbtp?: number,
 *   samplePeakDbfs?: number,
 *   loudnessRange?: number,
 *   loudnessRangeValid?: boolean,
 *   measureOnly?: boolean,
 *   invalidReason?: IntegratedInvalidReason | null,
 *   unstable?: boolean,
 *   provenance?: AnalysisProvenance,
 *   imported?: boolean,
 *   restored?: boolean,
 * }} [options]
 * @returns {CompletedAnalysisJob}
 */
function completedJob(
  fileName,
  {
    integratedLufs = -14.2,
    truePeakDbtp = -0.8,
    samplePeakDbfs = -1,
    loudnessRange = 5.1,
    loudnessRangeValid = true,
    measureOnly = false,
    invalidReason = null,
    unstable = false,
    provenance = LOCAL_PROVENANCE,
    imported = false,
    restored = false,
  } = {},
) {
  const target = measureOnly
    ? null
    : makeTargetPreset({
        label: "Streaming -14",
        loudnessTargetLufs: -14,
        toleranceLufs: 0.5,
        truePeakCeilingDbtp: -1,
      });
  const invalid = invalidReason != null;
  return {
    id: `id:${fileName}`,
    fileName,
    mimeType: "audio/wav",
    status: "complete",
    createdAt: "2026-05-30T00:00:00.000Z",
    progressPercent: 1,
    progressLabel: "Complete",
    provenance,
    imported,
    restored,
    result: {
      analysisMode: measureOnly ? "measure-only" : "targeted",
      target,
      metrics: {
        integratedLufs: invalid ? -70 : integratedLufs,
        integratedValid: !invalid,
        ...(invalid ? { integratedInvalidReason: invalidReason } : {}),
        ungatedLufs: -13.8,
        loudnessRange,
        loudnessRangeValid,
        loudnessRangeUnstable: unstable,
        maxMomentaryLufs: -11,
        maxShortTermLufs: -12,
        samplePeakDbfs,
        truePeakDbtp,
        unclampedTargetDeltaDb: invalid || measureOnly ? null : 0.2,
        targetDeltaDb: invalid || measureOnly ? null : 0.2,
        projectedTruePeakDbtp: invalid || measureOnly ? null : -0.6,
        normalizationLimited: false,
        timeline: makeTimeline(),
        warnings: [],
      },
      metadata: {
        fileName,
        mimeType: "audio/wav",
        sourceFormat: "wav",
        sampleRate: 48_000,
        bitDepth: 24,
        durationSeconds: unstable ? 30 : 120,
        frameCount: (unstable ? 30 : 120) * 48_000,
        channelCount: 2,
        channelLayout: {
          name: "L / R",
          labels: ["L", "R"],
          guessed: false,
          speakerMask: 3,
        },
        decoderMode: "native-parser",
        decoderLabel: "WAV parser",
        decoderSummary: "Dedicated PCM parser",
        decodeNotes: [],
        warnings: [],
      },
      analyzedAt: "2026-05-30T00:00:01.000Z",
    },
  };
}

// A real timeline of the given length, built the way buildTimeline() does
// (an ascending timeSeconds series, three other same-length series).
/**
 * @param {number} pointCount
 * @returns {AnalysisTimeline}
 */
function buildTimelinePoints(pointCount) {
  const stepDurationSeconds = 0.1;
  const timeSeconds = new Float32Array(pointCount);
  const momentaryLufs = new Float32Array(pointCount);
  const shortTermLufs = new Float32Array(pointCount);
  const truePeakDbtp = new Float32Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    timeSeconds[index] = (index + 1) * stepDurationSeconds;
    momentaryLufs[index] = -23.456789 + (index % 7) * 0.01;
    shortTermLufs[index] = -23.1234567 + (index % 11) * 0.01;
    truePeakDbtp[index] = -6.2345678 + (index % 5) * 0.001;
  }
  return { stepDurationSeconds, timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp };
}

// completedJob() with its (normally empty) timeline replaced by a real one,
// for PERF-05's downsampling/pretty-print coverage below.
/**
 * @param {string} fileName
 * @param {number} pointCount
 * @param {Parameters<typeof completedJob>[1]} [options]
 */
function completedJobWithTimeline(fileName, pointCount, options = {}) {
  const job = completedJob(fileName, options);
  job.result.metrics.timeline = buildTimelinePoints(pointCount);
  return job;
}

/**
 * @param {string} fileName
 * @returns {AnalysisJob}
 */
function queuedJob(fileName) {
  return {
    id: `id:${fileName}`,
    fileName,
    mimeType: "audio/wav",
    status: "queued",
    createdAt: "2026-05-30T00:00:00.000Z",
    progressPercent: 0,
    progressLabel: "Queued",
  };
}

const sourceDigest = "cd".repeat(32);
const imported = completedJob("imported.wav", {
  imported: true,
  provenance: {
    kind: "unverified-import",
    sourceJobId: "source-job-7",
    sourceSessionDigest: sourceDigest,
  },
});
const restored = completedJob("restored.wav", {
  restored: true,
  provenance: { kind: "restored-local" },
});
const invalid = completedJob("invalid-short.wav", {
  invalidReason: "too-short",
  unstable: true,
});
const silence = completedJob("silence.wav", {
  invalidReason: "below-gate",
  measureOnly: true,
  samplePeakDbfs: -144,
  truePeakDbtp: -144,
  unstable: true,
});
const invalidLra = completedJob("short-lra.wav", {
  loudnessRange: 0,
  loudnessRangeValid: false,
  unstable: true,
});
const precisionBoundary = completedJob("precision-boundary.wav", {
  integratedLufs: -24.004,
  samplePeakDbfs: -1.004,
  truePeakDbtp: -0.996,
});
precisionBoundary.result.target = {
  ...targetOf(precisionBoundary),
  loudnessTargetLufs: -23,
  toleranceLufs: 1,
  truePeakCeilingDbtp: -1,
};
const jobs = [
  completedJob("song.wav"),
  completedJob("drums, kick.wav"),
  completedJob('vocal "wet".wav'),
  completedJob("=1+1.wav"),
  completedJob("@cmd.wav"),
  completedJob("-mix.wav"),
  completedJob("+3dB.wav"),
  completedJob("measure.wav", { measureOnly: true }),
  imported,
  restored,
  invalid,
  silence,
  invalidLra,
  precisionBoundary,
  queuedJob("not-done-yet.wav"),
];
const completedCount = jobs.filter((job) => job.status === "complete").length;

console.log("\n[A] CSV escaping, validity, and provenance");
const csv = buildCsvExport(jobs);
const csvLines = csv.split("\n");
// The CSV leads with a UTF-8 BOM (so Excel-on-Windows reads a double-clicked file
// as UTF-8); strip it before the header/column assertions below.
const csvHeaderLine = csvLines[0].replace(/^\uFEFF/, "");
const csvHeader = csvHeaderLine.split(",");
const invalidRow = csvLines.find((line) => line.startsWith("invalid-short.wav,"))?.split(",") ?? [];
const importedRow = csvLines.find((line) => line.startsWith("imported.wav,")) ?? "";
const silenceRow = csvLines.find((line) => line.startsWith("silence.wav,"))?.split(",") ?? [];
const invalidLraRow = csvLines.find((line) => line.startsWith("short-lra.wav,"))?.split(",") ?? [];
const precisionRow = csvLines.find((line) => line.startsWith("precision-boundary.wav,"))?.split(",") ?? [];
check("CSV begins with a UTF-8 BOM", csv.startsWith("\uFEFF"), JSON.stringify(csv.slice(0, 1)));
check(
  "header documents filename formula neutralisation",
  csvHeaderLine.startsWith(
    "Filename (leading apostrophe prevents spreadsheet formulas),Status,Analysis Mode,",
  ),
);

// A BOM only helps if it survives as bytes and a BOM-aware reader (Excel,
// TextDecoder) strips it while decoding the rest as UTF-8, so a non-ASCII filename
// round-trips instead of mojibaking under the system ANSI codepage.
const bomCsv = buildCsvExport([completedJob("Café Été.wav")]);
const csvBytes = new TextEncoder().encode(bomCsv);
check("CSV emits the UTF-8 BOM bytes EF BB BF", csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, `${csvBytes[0]},${csvBytes[1]},${csvBytes[2]}`);
const excelDecoded = new TextDecoder("utf-8").decode(csvBytes); // ignoreBOM=false → strips the BOM like Excel
check(
  "BOM-aware reader strips the BOM so the header parses cleanly",
  excelDecoded.startsWith(
    "Filename (leading apostrophe prevents spreadsheet formulas),Status,Analysis Mode,",
  ),
);
check("non-ASCII filename round-trips without mojibake", excelDecoded.includes("Café Été.wav") && !excelDecoded.includes("CafÃ©"));
check("validity columns present", csvHeader.includes("Integrated Status") && csvHeader.includes("Integrated Invalid Reason"));
check("LRA status column present", csvHeader.includes("LRA Status"));
check("provenance columns present", csvHeader.includes("Provenance") && csvHeader.includes("Source Session Digest"));
check("comma in filename is quoted", csv.includes('"drums, kick.wav"'));
check("double quote in filename is doubled and quoted", csv.includes('"vocal ""wet"".wav"'));
check("=formula filename neutralized", csv.includes("'=1+1.wav"));
check("@formula filename neutralized", csv.includes("'@cmd.wav"));
check("-formula filename neutralized", csv.includes("'-mix.wav"));
check("+formula filename neutralized", csv.includes("'+3dB.wav"));
check("queued job excluded", !csv.includes("not-done-yet.wav"));
check("one header + completed rows", csvLines.length === completedCount + 1);
check("ordinary negative LUFS remains numeric", csv.includes("-14.20") && !csv.includes("'-14.20"));
check(
  "invalid status and reason explicit",
  invalidRow[csvHeader.indexOf("Integrated Status")] === "invalid" &&
    invalidRow[csvHeader.indexOf("Integrated Invalid Reason")].includes("Too short"),
);
check("invalid -70 sentinel omitted from measurement cell", invalidRow[csvHeader.indexOf("Integrated LUFS")] === "");
check("unstable LRA qualifier exported", invalidRow[csvHeader.indexOf("LRA Status")].includes("Unstable"));
check(
  "invalid LRA leaves the CSV measurement empty",
  invalidLraRow[csvHeader.indexOf("LRA LU")] === "" &&
    invalidLraRow[csvHeader.indexOf("LRA Status")].includes("Unavailable"),
);
check("unverified provenance label exported", importedRow.includes("Unverified import"));
check("source job and digest exported", importedRow.includes("source-job-7") && importedRow.includes(sourceDigest));
check("unverified provenance warning exported", importedRow.includes("Unverified imported result"));
check("restored provenance exported", csv.includes("Restored local analysis"));
check(
  "silence peak sentinels export as empty CSV cells",
  silenceRow[csvHeader.indexOf("Sample Peak dBFS")] === "" &&
    silenceRow[csvHeader.indexOf("True Peak dBTP")] === "",
);
check(
  "CSV precision and verdict agree at rounded boundaries",
  precisionRow[csvHeader.indexOf("Integrated LUFS")] === "-24.00" &&
    precisionRow[csvHeader.indexOf("True Peak dBTP")] === "-1.00" &&
    precisionRow[csvHeader.indexOf("Compliance")] === "On target",
);

console.log("\n[B] JSON report-facing values + explicit raw fields");
/** @type {JsonExportEntry[] | null} */
let parsed = null;
try {
  parsed = JSON.parse(buildJsonExport(jobs));
  check("JSON parses", true);
} catch (error) {
  check("JSON parses", false, error instanceof Error ? error.message : String(error));
}
check("JSON contains completed jobs only", Array.isArray(parsed) && parsed.length === completedCount);
check("JSON excludes queued job", parsed && !parsed.some((entry) => entry.fileName === "not-done-yet.wav"));
const invalidJson = parsed?.find((entry) => entry.fileName === "invalid-short.wav");
check("invalid report measurement is null, not -70", invalidJson?.result.metrics.integratedLufs === null);
check("raw legacy sentinel is explicitly named", invalidJson?.result.metrics.rawIntegratedLufs === -70);
check(
  "invalid status/reason exported",
  invalidJson?.measurements.integratedLoudness.status === "invalid" &&
    invalidJson?.measurements.integratedLoudness.invalidReason === "too-short",
);
check(
  "LRA instability raw field and qualifier exported",
  invalidJson?.result.metrics.loudnessRangeUnstable === true &&
    invalidJson?.measurements.loudnessRange.status.includes("Unstable"),
);
const importedJson = parsed?.find((entry) => entry.fileName === "imported.wav");
check("structured provenance exported", importedJson?.provenance.kind === "unverified-import");
check("provenance warning exported", importedJson?.provenanceWarning?.includes("re-analyze"));
check("source lineage exported", importedJson?.provenance.sourceJobId === "source-job-7" && importedJson?.provenance.sourceSessionDigest === sourceDigest);
const silenceJson = parsed?.find((entry) => entry.fileName === "silence.wav");
check(
  "silence peak sentinels export as JSON null",
  silenceJson?.result.metrics.samplePeakDbfs === null &&
    silenceJson?.result.metrics.truePeakDbtp === null,
);
const invalidLraJson = parsed?.find((entry) => entry.fileName === "short-lra.wav");
check(
  "invalid LRA exports as JSON null with its validity flag",
  invalidLraJson?.result.metrics.loudnessRange === null &&
    invalidLraJson?.result.metrics.loudnessRangeValid === false &&
    invalidLraJson?.measurements.loudnessRange.valueLu === null &&
    invalidLraJson?.measurements.loudnessRange.valid === false,
);
const precisionJson = parsed?.find((entry) => entry.fileName === "precision-boundary.wav");
check(
  "JSON precision and verdict agree at rounded boundaries",
  MEASUREMENT_PRECISION === 0.01 &&
    precisionJson?.result.metrics.integratedLufs === -24 &&
    precisionJson?.result.metrics.truePeakDbtp === -1 &&
    precisionJson?.compliance.state === "on-target",
);

console.log("\n[C] Markdown structure, validity, provenance, and injection defense");
const malicious = completedJob("track\n## Forged heading ![pixel](https://evil.invalid/p.gif) <img src=x>");
targetOf(malicious).label = "Target\n# injected";
malicious.result.metadata.decoderLabel = "Decoder\n- forged item";
malicious.result.metadata.channelLayout.name = "<script>alert(1)</script>";
const markdown = buildMarkdownExport([...jobs, malicious]);
check("report title present", markdown.includes("# TruePeak Analysis Report"));
check("ordinary per-file heading present", markdown.includes("## song\\.wav"));
check("completed count includes malicious completed row", markdown.includes(`Completed files: ${completedCount + 1}`));
check("measure-only target line present", markdown.includes("- Target: Measure Only"));
check("queued job excluded", !markdown.includes("not-done-yet.wav"));
check("invalid result never prints -70 as integrated measurement", !markdown.includes("Integrated Loudness: -70"));
check("invalid reason is human-readable", markdown.includes("No valid measurement"));
check("unstable LRA is qualified", markdown.includes("LU (unstable; programme shorter than 60 s)"));
check("unverified provenance warning is prominent", markdown.includes("> **Provenance warning:**") && markdown.includes("re\\-analyze"));
check("source lineage included", markdown.includes("source\\-job\\-7") && markdown.includes(sourceDigest));
check("filename newline cannot create a heading", !markdown.includes("\n## Forged heading"));
check("raw image syntax is escaped", !markdown.includes("![pixel]"));
check("raw HTML is encoded", !markdown.includes("<img src=x>") && markdown.includes("&lt;img src=x&gt;"));
check("target newline cannot create a heading", !markdown.includes("\n# injected"));
check("decoder newline cannot create a list item", !markdown.includes("\n- forged item"));
check("script tags are encoded", !markdown.includes("<script>") && markdown.includes("&lt;script&gt;"));
check("Markdown renders the silence peak sentinel as Silence", markdown.includes("## silence\\.wav\n") && markdown.includes("- True Peak: Silence"));
const invalidLraHeading = "## short\\-lra\\.wav";
const invalidLraStart = markdown.indexOf(invalidLraHeading);
const invalidLraEnd = markdown.indexOf("\n## ", invalidLraStart + invalidLraHeading.length);
const invalidLraSection = markdown.slice(
  invalidLraStart,
  invalidLraEnd < 0 ? undefined : invalidLraEnd,
);
check(
  "invalid LRA leaves the Markdown measurement blank",
  invalidLraStart >= 0 && invalidLraSection.includes("- Loudness Range: \n"),
);
check(
  "Markdown uses the shared two-decimal precision",
  markdown.includes("## precision\\-boundary\\.wav\n") &&
    markdown.includes("- Integrated Loudness: -24.00 LUFS") &&
    markdown.includes("- True Peak: -1.00 dBTP"),
);

console.log("\n[D] Shared H-02 formatters and selectors");
check("export presentation hides invalid sentinel", getIntegratedMeasurementPresentation(invalid.result.metrics).valueLufs === null);
check("UI formatter hides invalid sentinel", formatIntegratedLufs(invalid.result.metrics) === "No valid measurement");
check("UI LRA formatter adds unstable qualifier", formatLoudnessRange(invalid.result.metrics).includes("(unstable)"));
check(
  "UI LRA formatter uses the shared invalid-measurement label",
  formatLoudnessRange(invalidLra.result.metrics) === "No valid measurement",
);
check("UI true-peak formatter renders the silence sentinel", formatPeakDbtp(-144) === "Silence");
check("UI sample-peak formatter renders the silence sentinel", formatDb(-144, "dBFS") === "Silence");
const quiet = completedJob("quiet.wav", { integratedLufs: -20 });
const loud = completedJob("loud.wav", { integratedLufs: -10 });
const selectorJobs = [quiet, invalid, loud];
check("average excludes invalid integrated value", averageIntegratedLufs(selectorJobs) === -15);
check("quietest excludes invalid -70 sentinel", getQuietestJob(selectorJobs)?.fileName === "quiet.wav");
check("loudest remains valid result", getLoudestJob(selectorJobs)?.fileName === "loud.wav");
// on-target.wav is genuinely compliant: loudness within tolerance AND true peak
// (-1.5) under the -1 ceiling. hot-peak.wav has on-target loudness but its measured
// true peak (-0.8) breaches the -1 ceiling, so the corrected compliance semantics
// must surface it for attention rather than hiding it behind the loudness read.
const attentionNames = getAttentionJobs([
  completedJob("on-target.wav", { truePeakDbtp: -1.5 }),
  completedJob("hot-peak.wav", { truePeakDbtp: -0.8 }),
  quiet,
  invalid,
]).map((entry) => entry.fileName);
check("attention includes below-target results", attentionNames.includes("quiet.wav"));
check("attention includes invalid integrated results", attentionNames.includes("invalid-short.wav"));
check("attention includes on-target-loudness files whose true peak breaches the ceiling", attentionNames.includes("hot-peak.wav"));
check("attention excludes genuinely on-target results", !attentionNames.includes("on-target.wav"));
check(
  "targeted focus prioritizes invalid integrated results",
  getTargetedFocusJobs([quiet, invalid, loud])[0]?.fileName === "invalid-short.wav",
);
check(
  "largest move excludes rows without guidance",
  getLargestMoveJob([invalid]) === null,
);
check(
  "projected hottest excludes rows without guidance",
  getHighestProjectedPeakJob([invalid]) === null,
);
check(
  "widest-range ranking skips invalid LRA readings",
  getWidestRangeJob([
    invalidLra,
    completedJob("valid-lra.wav", { loudnessRange: 1 }),
  ])?.fileName === "valid-lra.wav",
);
check(
  "unavailable metrics sort last in both directions",
  compareOptionalMetric(null, -14, "asc") > 0 &&
    compareOptionalMetric(null, -14, "desc") > 0,
);
const recentInvalid = mergeRecentSessions([], [invalid])[0];
check("recent history retains invalid integrated status", recentInvalid?.integratedValid === false);
const recentInvalidLra = mergeRecentSessions([], [invalidLra])[0];
check("recent history retains invalid LRA status", recentInvalidLra?.loudnessRangeValid === false);
const recentImported = mergeRecentSessions([], [imported])[0];
check(
  "recent history retains unverified provenance",
  recentImported?.provenanceKind === "unverified-import",
);

console.log("\n[E] Recent-history migration and settings durability");
class MemoryStorage {
  /** @type {Map<string, string>} */
  values = new Map();
  failWrites = false;

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
    if (this.failWrites) {
      throw new Error("storage blocked");
    }
    this.values.set(key, String(value));
  }

  /** @param {string} key */
  removeItem(key) {
    if (this.failWrites) {
      throw new Error("storage blocked");
    }
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { localStorage: storage },
});
const legacyHistoryRow = {
  ...recentImported,
  targetLabel: null,
  complianceLabel: "On target",
};
delete legacyHistoryRow.recordTrust;
delete legacyHistoryRow.provenanceKind;
delete legacyHistoryRow.integratedValid;
delete legacyHistoryRow.loudnessRangeValid;
delete legacyHistoryRow.loudnessRangeUnstable;
storage.setItem("truepeak-recent-sessions", JSON.stringify([legacyHistoryRow]));
const firstLegacyLoad = loadRecentSessions();
const secondLegacyLoad = loadRecentSessions();
check(
  "legacy history migrates to an explicit unknown-trust row",
  firstLegacyLoad[0]?.recordTrust === "legacy-unknown" &&
    firstLegacyLoad[0]?.complianceLabel === null,
);
check(
  "migrated legacy history survives a second v2 load",
  secondLegacyLoad[0]?.recordTrust === "legacy-unknown",
);

const manyLegacyRows = Array.from({ length: 25 }, (_, index) => ({
  ...legacyHistoryRow,
  id: `legacy-${index}`,
  analyzedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));
storage.setItem("truepeak-recent-sessions", JSON.stringify(manyLegacyRows));
const cappedHistory = loadRecentSessions();
check(
  "legacy history is sorted and capped to the newest 20 on read",
  cappedHistory.length === 20 && cappedHistory[0]?.id === "legacy-24",
);

const poisonedEnvelope = JSON.parse(
  storage.getItem("truepeak-recent-sessions") ?? "null",
);
poisonedEnvelope.entries[0] = {
  ...poisonedEnvelope.entries[0],
  recordTrust: "validated-v2",
  provenanceKind: "local-analysis",
  analysisMode: "targeted",
  targetLabel: "Streaming -14",
  integratedValid: false,
  integratedInvalidReason: "too-short",
  integratedLufs: -70,
  loudnessRangeUnstable: true,
  complianceLabel: "On target",
};
storage.setItem("truepeak-recent-sessions", JSON.stringify(poisonedEnvelope));
// LOGIC-07: one invalid row no longer wipes the history. The contradictory row
// is dropped and the remaining valid rows survive.
const survivingHistory = loadRecentSessions();
check(
  "v2 history drops an invalid-measurement compliance contradiction and keeps the valid rows",
  survivingHistory.length === 19 &&
    !survivingHistory.some((entry) => entry.id === poisonedEnvelope.entries[0].id),
);

storage.setItem(
  "truepeak-analysis-settings",
  JSON.stringify({
    version: 1,
    settings: {
      analysisMode: "targeted",
      selectedPresetId: "custom",
      customTargetLufs: "-",
      customTruePeak: "-1",
      targetTolerance: "0.5",
      customPolicy: "protect-true-peak",
      decodePreference: "auto",
    },
  }),
);
check(
  "invalid custom target drafts are not restorable settings",
  readAnalysisSettingsPreference() === null,
);
storage.failWrites = true;
check(
  "settings persistence reports a blocked write",
  writeAnalysisSettingsPreference({
    analysisMode: "measure-only",
    selectedPresetId: "streaming",
    customTargetLufs: "-14",
    customTruePeak: "-1",
    targetTolerance: "0.5",
    customPolicy: "protect-true-peak",
    decodePreference: "compatibility-first",
  }) === false,
);
Reflect.deleteProperty(globalThis, "window");

console.log("\n[F] Empty input + file names");
const emptyCsv = buildCsvExport([]);
check("empty CSV is header-only", emptyCsv.split("\n").length === 1);
check("empty CSV still carries the UTF-8 BOM", emptyCsv.startsWith("\uFEFF"));
check("empty JSON is []", buildJsonExport([]) === "[]");
check("empty Markdown reports 0", buildMarkdownExport([]).includes("Completed files: 0"));
// The BOM is CSV-only: JSON must stay BOM-free (strict parsers reject it) and
// Markdown does not need one.
check("JSON export carries no BOM", !buildJsonExport(jobs).startsWith("\uFEFF"));
check("Markdown export carries no BOM", !buildMarkdownExport(jobs).startsWith("\uFEFF"));
check("empty Markdown reports 0", buildMarkdownExport([]).includes("Completed files: 0"));
check("csv extension", getExportFileName("csv").endsWith(".csv"));
check("json extension", getExportFileName("json").endsWith(".json"));
check("markdown extension", getExportFileName("markdown").endsWith(".md"));
check(
  "filenames embed a timestamp",
  // The stamp is second-resolution, so a repeat inside the same second carries a
  // "-2", "-3", ... discriminator. Earlier checks in this file already consumed
  // the csv scope, hence the optional suffix here.
  /^truepeak-analysis-\d{8}-\d{6}(-\d+)?\.csv$/.test(getExportFileName("csv")),
);
{
  // The stamp contract, on scopes nothing else in this file touches so the
  // counters are provably at zero.
  const first = fileNameTimestamp("export-suite-a");
  check("an ordinary export gets the plain, unsuffixed stamp", /^\d{8}-\d{6}$/.test(first), first);

  // A repeat of the SAME export inside the same second must not collide: that is
  // the whole point of stamping the filename in the first place.
  const second = fileNameTimestamp("export-suite-a");
  check("repeated same-second exports get distinct stamps", first !== second, `${first} vs ${second}`);
  check("the disambiguated stamp is the base plus a counter", second === `${first}-2`, second);
  check("a third repeat keeps counting", fileNameTimestamp("export-suite-a") === `${first}-3`);

  // The counter is per filename family. A CSV and a JSON export in the same
  // second cannot collide (their extensions differ), so the second one must not
  // inherit a suffix from the first.
  check(
    "a different filename family in the same second still gets the plain stamp",
    /^\d{8}-\d{6}$/.test(fileNameTimestamp("export-suite-b")),
  );
}

console.log("\n[G] JSON export bounds timeline points under the aggregate session cap (PERF-05)");
const LARGE_JSON_JOB_COUNT = 1000;
const LARGE_JSON_POINTS_PER_JOB = 5000;
const largeTimelineJobs = Array.from({ length: LARGE_JSON_JOB_COUNT }, (_, index) =>
  completedJobWithTimeline(`large-${index}.wav`, LARGE_JSON_POINTS_PER_JOB),
);
// Conservative bytes-per-timeline-point figure for the compact (non-pretty)
// encoding a payload this size takes: four number series (time, momentary,
// short-term, true-peak) at up to ~16 significant digits plus separators.
// MAX_SESSION_TIMELINE_POINTS is the same aggregate cap buildSessionFile
// enforces; multiplying by it gives a generous byte ceiling that still proves
// the export stays bounded instead of growing with job/point count.
const CONSERVATIVE_BYTES_PER_TIMELINE_POINT = 150;
const LARGE_JSON_BYTE_CAP = MAX_SESSION_TIMELINE_POINTS * CONSERVATIVE_BYTES_PER_TIMELINE_POINT;

let largeTimelineJson = null;
let largeTimelineThrew = null;
try {
  largeTimelineJson = buildJsonExport(largeTimelineJobs);
} catch (error) {
  largeTimelineThrew = error;
}
check(
  "1000-job x 5000-point export does not throw",
  largeTimelineThrew === null,
  largeTimelineThrew instanceof Error ? largeTimelineThrew.message : null,
);

const largeTimelineBytes = largeTimelineJson ? new Blob([largeTimelineJson]).size : Infinity;
check(
  `1000-job export stays under the ${LARGE_JSON_BYTE_CAP}-byte cap (${MAX_SESSION_TIMELINE_POINTS} points x ${CONSERVATIVE_BYTES_PER_TIMELINE_POINT} bytes)`,
  largeTimelineBytes < LARGE_JSON_BYTE_CAP,
  `${largeTimelineBytes} bytes`,
);

/** @type {JsonExportEntry[]} */
const largeTimelineParsed = largeTimelineJson ? JSON.parse(largeTimelineJson) : [];
check("large export contains one entry per job", largeTimelineParsed.length === LARGE_JSON_JOB_COUNT);
check(
  "every job in the large export is marked downsampled with the correct source point count",
  largeTimelineParsed.every(
    (entry) =>
      entry.result.metrics.timelineDownsampled === true &&
      entry.result.metrics.timelineSourcePoints === LARGE_JSON_POINTS_PER_JOB,
  ),
);
const largeTimelineTotalPoints = largeTimelineParsed.reduce(
  (sum, entry) => sum + entry.result.metrics.timeline.timeSeconds.length,
  0,
);
check(
  "large export's aggregate timeline points stay within the session cap",
  largeTimelineTotalPoints <= MAX_SESSION_TIMELINE_POINTS,
  `${largeTimelineTotalPoints} points`,
);

console.log("\n[H] JSON export leaves small sessions full-resolution and pretty-printed");
const smallTimelinePointCounts = [50, 40, 30];
const smallTimelineJobs = smallTimelinePointCounts.map((pointCount, index) =>
  completedJobWithTimeline(`small-${index}.wav`, pointCount),
);
const smallTimelineJson = buildJsonExport(smallTimelineJobs);
/** @type {JsonExportEntry[]} */
const smallTimelineParsed = JSON.parse(smallTimelineJson);
check(
  "small export is not downsampled and keeps its full source point count",
  smallTimelineParsed.every(
    (entry, index) =>
      entry.result.metrics.timelineDownsampled === false &&
      entry.result.metrics.timelineSourcePoints === smallTimelinePointCounts[index] &&
      entry.result.metrics.timeline.timeSeconds.length === smallTimelinePointCounts[index],
  ),
);
check("small export is pretty-printed (indent present)", smallTimelineJson.includes("\n  "));
