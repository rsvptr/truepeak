// Validation for CSV / JSON / Markdown report integrity, including H-02
// validity presentation, provenance, and untrusted Markdown escaping.
// Run: node scripts/dsp/validate-export.mjs
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const {
  buildCsvExport,
  buildJsonExport,
  buildMarkdownExport,
  getExportFileName,
  getIntegratedMeasurementPresentation,
} = await import("../../src/audio/export.ts");
const { formatIntegratedLufs, formatLoudnessRange } = await import("../../src/lib/format.ts");
const { loadRecentSessions, mergeRecentSessions } = await import("../../src/audio/persistence.ts");
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
} = await import("../../src/lib/session-selectors.ts");

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

function completedJob(
  fileName,
  {
    integratedLufs = -14.2,
    measureOnly = false,
    invalidReason = null,
    unstable = false,
    provenance = { kind: "local-analysis" },
    imported = false,
    restored = false,
  } = {},
) {
  const target = measureOnly
    ? null
    : {
        label: "Streaming -14",
        loudnessTargetLufs: -14,
        toleranceLufs: 0.5,
        truePeakCeilingDbtp: -1,
      };
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
        loudnessRange: 5.1,
        loudnessRangeUnstable: unstable,
        maxMomentaryLufs: -11,
        maxShortTermLufs: -12,
        samplePeakDbfs: -1,
        truePeakDbtp: -0.8,
        unclampedTargetDeltaDb: invalid || measureOnly ? null : 0.2,
        targetDeltaDb: invalid || measureOnly ? null : 0.2,
        projectedTruePeakDbtp: invalid || measureOnly ? null : -0.6,
        normalizationLimited: false,
        timeline: {
          stepDurationSeconds: 0.1,
          timeSeconds: [],
          momentaryLufs: [],
          shortTermLufs: [],
          truePeakDbtp: [],
        },
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
const jobs = [
  completedJob("song.wav"),
  completedJob("drums, kick.wav"),
  completedJob('vocal "wet".wav'),
  completedJob("=1+1.wav"),
  completedJob("@cmd.wav"),
  completedJob("measure.wav", { measureOnly: true }),
  imported,
  restored,
  invalid,
  queuedJob("not-done-yet.wav"),
];
const completedCount = jobs.filter((job) => job.status === "complete").length;

console.log("\n[A] CSV escaping, validity, and provenance");
const csv = buildCsvExport(jobs);
const csvLines = csv.split("\n");
const csvHeader = csvLines[0].split(",");
const invalidRow = csvLines.find((line) => line.startsWith("invalid-short.wav,"))?.split(",") ?? [];
const importedRow = csvLines.find((line) => line.startsWith("imported.wav,")) ?? "";
check("header row present", csvLines[0].startsWith("Filename,Status,Analysis Mode,"));
check("validity columns present", csvHeader.includes("Integrated Status") && csvHeader.includes("Integrated Invalid Reason"));
check("LRA status column present", csvHeader.includes("LRA Status"));
check("provenance columns present", csvHeader.includes("Provenance") && csvHeader.includes("Source Session Digest"));
check("comma in filename is quoted", csv.includes('"drums, kick.wav"'));
check("double quote in filename is doubled and quoted", csv.includes('"vocal ""wet"".wav"'));
check("=formula filename neutralized", csv.includes("'=1+1.wav"));
check("@formula filename neutralized", csv.includes("'@cmd.wav"));
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
check("unverified provenance label exported", importedRow.includes("Unverified import"));
check("source job and digest exported", importedRow.includes("source-job-7") && importedRow.includes(sourceDigest));
check("unverified provenance warning exported", importedRow.includes("Unverified imported result"));
check("restored provenance exported", csv.includes("Restored local analysis"));

console.log("\n[B] JSON report-facing values + explicit raw fields");
let parsed = null;
try {
  parsed = JSON.parse(buildJsonExport(jobs));
  check("JSON parses", true);
} catch (error) {
  check("JSON parses", false, error.message);
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

console.log("\n[C] Markdown structure, validity, provenance, and injection defense");
const malicious = completedJob("track\n## Forged heading ![pixel](https://evil.invalid/p.gif) <img src=x>");
malicious.result.target.label = "Target\n# injected";
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

console.log("\n[D] Shared H-02 formatters and selectors");
check("export presentation hides invalid sentinel", getIntegratedMeasurementPresentation(invalid.result.metrics).valueLufs === null);
check("UI formatter hides invalid sentinel", formatIntegratedLufs(invalid.result.metrics) === "No valid measurement");
check("UI LRA formatter adds unstable qualifier", formatLoudnessRange(invalid.result.metrics).includes("(unstable)"));
const quiet = completedJob("quiet.wav", { integratedLufs: -20 });
const loud = completedJob("loud.wav", { integratedLufs: -10 });
const selectorJobs = [quiet, invalid, loud];
check("average excludes invalid integrated value", averageIntegratedLufs(selectorJobs) === -15);
check("quietest excludes invalid -70 sentinel", getQuietestJob(selectorJobs)?.fileName === "quiet.wav");
check("loudest remains valid result", getLoudestJob(selectorJobs)?.fileName === "loud.wav");
const attentionNames = getAttentionJobs([
  completedJob("on-target.wav"),
  quiet,
  invalid,
]).map((entry) => entry.fileName);
check("attention includes below-target results", attentionNames.includes("quiet.wav"));
check("attention includes invalid integrated results", attentionNames.includes("invalid-short.wav"));
check("attention excludes on-target results", !attentionNames.includes("on-target.wav"));
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
  "unavailable metrics sort last in both directions",
  compareOptionalMetric(null, -14, "asc") > 0 &&
    compareOptionalMetric(null, -14, "desc") > 0,
);
const recentInvalid = mergeRecentSessions([], [invalid])[0];
check("recent history retains invalid integrated status", recentInvalid?.integratedValid === false);
const recentImported = mergeRecentSessions([], [imported])[0];
check(
  "recent history retains unverified provenance",
  recentImported?.provenanceKind === "unverified-import",
);

console.log("\n[E] Recent-history migration and settings durability");
class MemoryStorage {
  values = new Map();
  failWrites = false;

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failWrites) {
      throw new Error("storage blocked");
    }
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.failWrites) {
      throw new Error("storage blocked");
    }
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
globalThis.window = { localStorage: storage };
const legacyHistoryRow = {
  ...recentImported,
  targetLabel: null,
  complianceLabel: "On target",
};
delete legacyHistoryRow.recordTrust;
delete legacyHistoryRow.provenanceKind;
delete legacyHistoryRow.integratedValid;
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
  storage.getItem("truepeak-recent-sessions"),
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
check(
  "v2 history rejects invalid-measurement compliance contradictions atomically",
  loadRecentSessions().length === 0,
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
delete globalThis.window;

console.log("\n[F] Empty input + file names");
check("empty CSV is header-only", buildCsvExport([]).split("\n").length === 1);
check("empty JSON is []", buildJsonExport([]) === "[]");
check("empty Markdown reports 0", buildMarkdownExport([]).includes("Completed files: 0"));
check("csv extension", getExportFileName("csv").endsWith(".csv"));
check("json extension", getExportFileName("json").endsWith(".json"));
check("markdown extension", getExportFileName("markdown").endsWith(".md"));
check(
  "filenames embed a timestamp",
  /^truepeak-analysis-\d{8}-\d{6}\.csv$/.test(getExportFileName("csv")),
);

console.log(`\n==== Export: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
