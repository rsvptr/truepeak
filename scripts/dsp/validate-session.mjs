// Round-trip + rejection tests for the .truepeak.json session format.
// Proves buildSessionFile -> parseSessionFile preserves the results, and that
// malformed / untrusted input is rejected rather than crashing the importer.
//
// Run: node scripts/dsp/validate-session.mjs   (or: npm run test:session)
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const { buildSessionFile, getSessionFileName, parseSessionFile } = await import("../../src/audio/session-file.ts");
const { DEFAULT_TARGET_PRESET } = await import("../../src/audio/presets.ts");

function encodeWavFloat32(channels, sampleRate) {
  const cc = channels.length;
  const n = channels[0].length;
  const ba = cc * 4;
  const db = n * ba;
  const buf = new ArrayBuffer(44 + db);
  const v = new DataView(buf);
  const A = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
  A(0, "RIFF"); v.setUint32(4, 36 + db, true); A(8, "WAVE"); A(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, cc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ba, true);
  v.setUint16(32, ba, true); v.setUint16(34, 32, true); A(36, "data"); v.setUint32(40, db, true);
  let o = 44;
  for (let i = 0; i < n; i += 1) for (let c = 0; c < cc; c += 1) { v.setFloat32(o, channels[c][i], true); o += 4; }
  return buf;
}

const SR = 48000;
const N = SR * 3;
const l = new Float32Array(N);
const r = new Float32Array(N);
for (let i = 0; i < N; i += 1) { l[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR); r[i] = l[i]; }
const asset = parseWavBuffer(encodeWavFloat32([l, r], SR), "round-trip.wav", "audio/wav");
const result = analyzeDecodedAsset(asset, DEFAULT_TARGET_PRESET);

const job = {
  id: "job-1",
  fileName: "round-trip.wav",
  mimeType: "audio/wav",
  status: "complete",
  createdAt: "2026-01-02T03:04:05.000Z",
  progressPercent: 1,
  progressLabel: "Complete",
  result,
};

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? (passed += 1) : (failed += 1);
};

console.log("\nRound-trip (build -> parse)");
const text = buildSessionFile([job]);
const back = parseSessionFile(text);
ok("no error", !back.error);
ok("one job restored", back.jobs.length === 1);
const rj = back.jobs[0] ?? {};
ok("flagged imported", rj.imported === true);
ok("status complete", rj.status === "complete");
ok("filename preserved", rj.fileName === "round-trip.wav");
ok("createdAt preserved", rj.createdAt === "2026-01-02T03:04:05.000Z");
ok("integrated LUFS preserved", rj.result?.metrics?.integratedLufs === result.metrics.integratedLufs);
ok("true peak preserved", rj.result?.metrics?.truePeakDbtp === result.metrics.truePeakDbtp);
ok("target preserved", rj.result?.target?.id === DEFAULT_TARGET_PRESET.id);
ok(
  "timeline preserved",
  rj.result?.metrics?.timeline?.timeSeconds?.length === result.metrics.timeline.timeSeconds.length &&
    rj.result?.metrics?.timeline?.truePeakDbtp?.length === result.metrics.timeline.truePeakDbtp.length,
);

ok(
  "session filename is timestamped and keeps the .truepeak.json suffix",
  /^truepeak-session-\d{8}-\d{6}\.truepeak\.json$/.test(getSessionFileName()),
);

console.log("\nRejection (untrusted / malformed input)");
ok("invalid JSON rejected", !!parseSessionFile("not json at all").error);
ok("wrong app rejected", !!parseSessionFile(JSON.stringify({ app: "something-else" })).error);
ok("non-object rejected", !!parseSessionFile("42").error);
ok(
  "unsupported version rejected",
  !!parseSessionFile(JSON.stringify({ app: "truepeak", kind: "session", version: 99, jobs: [] })).error,
);
ok(
  "missing jobs array rejected",
  !!parseSessionFile(JSON.stringify({ app: "truepeak", kind: "session", version: 1 })).error,
);
ok(
  "job with no result skipped",
  !!parseSessionFile(
    JSON.stringify({ app: "truepeak", kind: "session", version: 1, jobs: [{ id: "a", fileName: "b", result: {} }] }),
  ).error,
);
ok(
  "job with non-finite metric skipped",
  !!parseSessionFile(
    JSON.stringify({
      app: "truepeak",
      kind: "session",
      version: 1,
      jobs: [{ id: "a", fileName: "b", result: { ...result, metrics: { ...result.metrics, integratedLufs: null } } }],
    }),
  ).error,
);
// A valid job alongside an invalid one should still import the valid one.
const mixed = parseSessionFile(
  JSON.stringify({
    app: "truepeak",
    kind: "session",
    version: 1,
    jobs: [{ id: "bad", fileName: "bad", result: {} }, job],
  }),
);
ok("valid job kept when mixed with invalid", !mixed.error && mixed.jobs.length === 1 && mixed.jobs[0].id === "job-1");

console.log(`\n==== Session format: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
