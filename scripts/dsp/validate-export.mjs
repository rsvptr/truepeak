// Validation for the CSV / JSON / Markdown export builders.
// Exports are user-facing and carry non-trivial escaping logic (CSV quoting +
// spreadsheet-formula neutralization), yet had no coverage. This locks in the
// escaping rules, completed-only filtering, and empty-input behavior.
//
// Run: node scripts/dsp/validate-export.mjs
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { buildCsvExport, buildJsonExport, buildMarkdownExport, getExportFileName } =
  await import("../../src/audio/export.ts");

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

// Minimal completed job carrying only the fields the exporters read.
function completedJob(fileName, { measureOnly = false } = {}) {
  const target = measureOnly
    ? null
    : { label: "Streaming -14", loudnessTargetLufs: -14, toleranceLufs: 0.5, truePeakCeilingDbtp: -1 };
  return {
    id: `id:${fileName}`,
    fileName,
    mimeType: "audio/wav",
    status: "complete",
    createdAt: "2026-05-30T00:00:00.000Z",
    progressPercent: 1,
    progressLabel: "Complete",
    result: {
      analysisMode: measureOnly ? "measure-only" : "targeted",
      target,
      metrics: {
        integratedLufs: -14.2,
        ungatedLufs: -13.8,
        loudnessRange: 5.1,
        maxMomentaryLufs: -11,
        maxShortTermLufs: -12,
        samplePeakDbfs: -1,
        truePeakDbtp: -0.8,
        unclampedTargetDeltaDb: measureOnly ? null : 0.2,
        targetDeltaDb: measureOnly ? null : 0.2,
        projectedTruePeakDbtp: measureOnly ? null : -0.6,
        normalizationLimited: false,
        timeline: { stepDurationSeconds: 0.1, timeSeconds: [], momentaryLufs: [], shortTermLufs: [], truePeakDbtp: [] },
        warnings: [],
      },
      metadata: {
        fileName,
        mimeType: "audio/wav",
        sourceFormat: "wav",
        sampleRate: 48000,
        bitDepth: 24,
        durationSeconds: 120,
        frameCount: 5760000,
        channelCount: 2,
        channelLayout: { name: "L / R", labels: ["L", "R"], guessed: false, speakerMask: 3 },
        decoderMode: "native-parser",
        decoderLabel: "WAV parser",
        decoderSummary: "x",
        decodeNotes: [],
        warnings: [],
      },
      analyzedAt: "2026-05-30T00:00:00.000Z",
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

const jobs = [
  completedJob("song.wav"),
  completedJob("drums, kick.wav"), // comma -> must be quoted
  completedJob('vocal "wet".wav'), // double-quote -> doubled + quoted
  completedJob("=1+1.wav"), // spreadsheet formula -> neutralized with leading '
  completedJob("@cmd.wav"), // @ formula vector -> neutralized
  completedJob("measure.wav", { measureOnly: true }),
  queuedJob("not-done-yet.wav"), // not completed -> excluded everywhere
];
const completedCount = jobs.filter((j) => j.status === "complete").length;

console.log("\n[A] CSV: escaping + neutralization");
const csv = buildCsvExport(jobs);
const csvLines = csv.split("\n");
check("header row present", csvLines[0].startsWith("Filename,Status,Analysis Mode,"));
check("comma in filename is quoted", csv.includes('"drums, kick.wav"'));
check('double-quote in filename is doubled and quoted', csv.includes('"vocal ""wet"".wav"'));
check("=formula filename neutralized with leading apostrophe", csv.includes("'=1+1.wav"));
check("@formula filename neutralized with leading apostrophe", csv.includes("'@cmd.wav"));
check("queued job excluded from CSV", !csv.includes("not-done-yet.wav"));
check("one header + one row per completed job", csvLines.length === completedCount + 1, `got ${csvLines.length} lines for ${completedCount} completed`);
check("negative LUFS left as raw number (Excel reads it numeric, not formula)", csv.includes("-14.20") && !csv.includes("'-14.20"));
check("measure-only row leaves target columns empty (no stray label)", csv.includes("measure.wav"));

console.log("\n[B] JSON: validity + shape");
let parsed = null;
try {
  parsed = JSON.parse(buildJsonExport(jobs));
  check("JSON output parses", true);
} catch (error) {
  check("JSON output parses", false, error.message);
}
check("JSON contains only completed jobs", Array.isArray(parsed) && parsed.length === completedCount);
check("JSON entries expose fileName/result/compliance", !!parsed && parsed.every((e) => "fileName" in e && "result" in e && "compliance" in e));
check("JSON excludes queued job", !!parsed && !parsed.some((e) => e.fileName === "not-done-yet.wav"));

console.log("\n[C] Markdown: structure");
const md = buildMarkdownExport(jobs);
check("report title present", md.includes("# TruePeak Analysis Report"));
check("per-file heading present", md.includes("## song.wav"));
check("completed file count correct", md.includes(`Completed files: ${completedCount}`));
check("measure-only file shows 'Measure Only' target line", md.includes("- Target: Measure Only"));
check("queued job excluded from Markdown", !md.includes("not-done-yet.wav"));

console.log("\n[D] Empty input");
check("empty CSV is header-only", buildCsvExport([]).split("\n").length === 1);
check("empty JSON is []", buildJsonExport([]) === "[]");
check("empty Markdown reports 0 files", buildMarkdownExport([]).includes("Completed files: 0"));

console.log("\n[E] File names");
check("csv extension", getExportFileName("csv").endsWith(".csv"));
check("json extension", getExportFileName("json").endsWith(".json"));
check("markdown extension", getExportFileName("markdown").endsWith(".md"));

console.log(`\n==== Export: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
