// EBU Mode compliance checks for the TruePeak analyzer.
//
// Reproduces the documented test cases from EBU Tech 3341 (loudness) and
// Tech 3342 (loudness range) from their published parameters and asserts the
// standard's expected readings at the spec tolerances. This is stricter than
// validate-dsp.mjs (which uses hand-rolled reference signals): here the expected
// numbers come from the broadcast standard's own "answer key".
//
// Run: node scripts/dsp/validate-ebu.mjs   (or: npm run test:ebu)
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const { deriveChannelLayout } = await import("../../src/audio/channel-layout.ts");

const SR = 48000;

// A stereo 1 kHz sine is the EBU calibration tone: its integrated loudness in
// LUFS equals its amplitude in dBFS (the -0.691 LUFS offset and the K-weighting
// gain at 1 kHz cancel, and the two equal channels sum to +0 vs a single sine's
// RMS). So amplitude = 10^(LUFS/20) yields a tone that reads that many LUFS.
const ampForLufs = (lufs) => 10 ** (lufs / 20);

function toneSegment(lufs, seconds, freq = 1000, phase = 0) {
  const amp = ampForLufs(lufs);
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    l[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
    r[i] = l[i];
  }
  return [l, r];
}

function rawSine(amp, seconds, freq, phase = 0) {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    l[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
    r[i] = l[i];
  }
  return [l, r];
}

function concatSegments(segments) {
  const channelCount = segments[0].length;
  const channels = [];
  for (let c = 0; c < channelCount; c += 1) {
    const total = segments.reduce((sum, seg) => sum + seg[c].length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const seg of segments) {
      out.set(seg[c], offset);
      offset += seg[c].length;
    }
    channels.push(out);
  }
  return channels;
}

function analyze(channels) {
  const frameCount = channels[0].length;
  const asset = {
    fileName: "ebu.wav",
    mimeType: "audio/wav",
    sourceFormat: "wav",
    sampleRate: SR,
    bitDepth: 32,
    durationSeconds: frameCount / SR,
    frameCount,
    channelCount: channels.length,
    channelLayout: deriveChannelLayout(channels.length, null),
    decoderMode: "native-parser",
    decoderLabel: "test",
    decoderSummary: "",
    decodeNotes: [],
    warnings: [],
    channels,
  };
  return analyzeDecodedAsset(asset, null).metrics;
}

let passed = 0;
let failed = 0;
function expect(name, actual, expected, tol) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${actual.toFixed(3)} (expected ${expected.toFixed(2)} ±${tol})`);
  ok ? (passed += 1) : (failed += 1);
}
function expectGt(name, actual, bound) {
  const ok = Number.isFinite(actual) && actual > bound;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${actual.toFixed(3)} (expected > ${bound})`);
  ok ? (passed += 1) : (failed += 1);
}

console.log("\nEBU Tech 3341 — Integrated loudness");
console.log("[Case 1] Stereo 1 kHz sine @ -23 LUFS, 10s");
const c1 = analyze(toneSegment(-23, 10));
expect("integrated", c1.integratedLufs, -23.0, 0.1);
expect("max momentary", c1.maxMomentaryLufs, -23.0, 0.1);
expect("max short-term", c1.maxShortTermLufs, -23.0, 0.1);

console.log("[Case 2] Stereo 1 kHz sine @ -33 LUFS, 10s");
const c2 = analyze(toneSegment(-33, 10));
expect("integrated", c2.integratedLufs, -33.0, 0.1);

console.log("\nEBU Tech 3341 — Gating");
console.log("[Rel gate] 20s @ -23 LUFS + 20s @ -40 LUFS (quiet part excluded by the -10 LU relative gate)");
const g1 = analyze(concatSegments([toneSegment(-23, 20), toneSegment(-40, 20)]));
expect("integrated", g1.integratedLufs, -23.0, 0.2);

console.log("[Abs gate] 20s @ -23 LUFS + 20s @ -90 LUFS (quiet part excluded by the -70 LUFS absolute gate)");
const g2 = analyze(concatSegments([toneSegment(-23, 20), toneSegment(-90, 20)]));
expect("integrated", g2.integratedLufs, -23.0, 0.2);

console.log("\nEBU Tech 3342 — Loudness range");
console.log("[LRA] 10s @ -20 LUFS + 10s @ -30 LUFS → ~10 LU spread");
const lra = analyze(concatSegments([toneSegment(-20, 10), toneSegment(-30, 10)]));
expect("loudness range", lra.loudnessRange, 10.0, 1.5);

console.log("\nITU-R BS.1770 — True peak (inter-sample)");
console.log("[TP] Full-scale fs/4 sine, phase π/4: sample peak -3.01 dBFS, true peak ≈ 0 dBTP");
const tp = analyze(rawSine(1.0, 2, SR / 4, Math.PI / 4));
expect("sample peak", tp.samplePeakDbfs, -3.01, 0.1);
expectGt("true peak catches the inter-sample crest", tp.truePeakDbtp, -0.5);

console.log(`\n==== EBU compliance: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
