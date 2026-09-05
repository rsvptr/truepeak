// EBU / ITU standards-reference checks for the TruePeak analyzer.
//
// Reproduces a SUBSET of the published minimum-requirement test signals from
// EBU Tech 3341 (loudness + true peak) and EBU Tech 3342 (loudness range) from
// their documented parameters, and asserts the standards' expected readings at
// the published tolerances. This is stricter than validate-dsp.mjs (hand-rolled
// reference signals): here the expected numbers are the standards' own answer key.
//
// HONESTY NOTE (audit M-25): this is a SUBSET, not full compliance. The published
// sets are Tech 3341 = 23 cases and Tech 3342 = 6 cases. This suite reproduces the
// cases synthesizable from published parameters. It does NOT reproduce:
//   - Tech 3342 cases 5 and 6: per EBU Tech 3342 (2023) Table 1 these are AUTHENTIC
//     PROGRAMME segments (case 5 = narrow-loudness-range commercial/promo, case 6 =
//     wide-loudness-range movie/drama), distributed ONLY as the EBU reference-audio
//     downloads (tech.ebu.ch/loudness), not as tone/step parameters. They cannot be
//     synthesized here, so only Tech 3342 cases 1-4 are implemented and run.
//   - Tech 3341 cases 7, 8 (authentic-programme segments, same reference-audio-only
//     constraint);
//   - Tech 3341 cases 20-23 (true-peak signals defined via 4*fs synthesis +
//     anti-alias downsample at sample offsets — not a simple closed form).
// Passing this subset does NOT certify EBU-Mode compliance; it guards the specific
// documented behaviors below against regression. Counts are reported per CASE
// (one published test signal), not per assertion.
//
// Run: npm run test:ebu
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./alias-loader.mjs", import.meta.url);

const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const { deriveChannelLayout } = await import("../../src/audio/channel-layout.ts");

/** @typedef {import("../../src/types/audio.ts").ChannelLayout} ChannelLayout */
/** @typedef {import("../../src/types/audio.ts").DecodedAudioAsset} DecodedAudioAsset */

const SR = 48000;

// EBU calibration: a stereo 1 kHz sine reads its per-channel dBFS peak level as
// LUFS (the -0.691 LUFS offset and the K-weighting gain at 1 kHz cancel, and two
// equal channels sum to +0 vs a single sine's RMS). So amplitude 10^(dBFS/20)
// yields a stereo tone measuring that many LUFS / M / S.
/** @param {number} db */
const ampForDb = (db) => 10 ** (db / 20);

// One mono channel: 1 kHz tone at `db` dBFS for `seconds`.
/**
 * @param {number} db
 * @param {number} seconds
 * @param {number} [freq]
 * @param {number} [phase]
 */
function monoTone(db, seconds, freq = 1000, phase = 0) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const amp = ampForDb(db);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
}

// Stereo tone (both channels identical) at `db` dBFS for `seconds`.
/**
 * @param {number} db
 * @param {number} seconds
 * @param {number} [freq]
 * @param {number} [phase]
 * @returns {Float32Array[]}
 */
function toneSegment(db, seconds, freq = 1000, phase = 0) {
  const ch = monoTone(db, seconds, freq, phase);
  return [ch, ch.slice()];
}

// Concatenate per-channel segment arrays into one multi-segment asset.
/**
 * @param {Float32Array[][]} segments
 * @returns {Float32Array[]}
 */
function concatSegments(segments) {
  const channelCount = segments[0].length;
  /** @type {Float32Array[]} */
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

// Stereo tone at `db` occupying [leadMs, leadMs+durMs), then `trailMs` of silence.
// Models the file-based EBU meter-dynamics segments (cases 10, 11, 13, 14).
/**
 * @param {number} db
 * @param {number} leadMs
 * @param {number} durMs
 * @param {number} trailMs
 * @returns {Float32Array[]}
 */
function pulseSegment(db, leadMs, durMs, trailMs) {
  const total = Math.round(((leadMs + durMs + trailMs) / 1000) * SR);
  const amp = ampForDb(db);
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  const start = Math.round((leadMs / 1000) * SR);
  const len = Math.round((durMs / 1000) * SR);
  for (let i = 0; i < len; i += 1) {
    const t = start + i;
    if (t >= total) break;
    const v = amp * Math.sin((2 * Math.PI * 1000 * t) / SR);
    l[t] = v;
    r[t] = v;
  }
  return [l, r];
}

// Steady stereo sine with raised-cosine edge fades. The true-peak cases 15-19
// specify a steady sine; generating one that abruptly starts mid-cycle makes the
// true-peak FIR ring on the onset step and report that transient overshoot instead
// of the steady-state inter-sample peak. A short fade (>= 5 ms; 20 ms used here for
// margin) removes the onset/offset discontinuity so the reading reflects the
// steady inter-sample peak the standard intends.
/**
 * @param {number} amp
 * @param {number} freq
 * @param {number} phaseDeg
 * @param {number} [seconds]
 * @param {number} [fadeMs]
 * @returns {Float32Array[]}
 */
function fadedSine(amp, freq, phaseDeg, seconds = 0.5, fadeMs = 20) {
  const n = Math.round(seconds * SR);
  const f = Math.max(1, Math.round((fadeMs / 1000) * SR));
  const phase = (phaseDeg * Math.PI) / 180;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let env = 1;
    if (i < f) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
    else if (i >= n - f) env = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / f);
    const v = env * amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
    l[i] = v;
    r[i] = v;
  }
  return [l, r];
}

/**
 * @param {Float32Array[]} channels
 * @param {ChannelLayout} [layout]
 */
function analyze(channels, layout) {
  const frameCount = channels[0].length;
  /** @type {DecodedAudioAsset} */
  const asset = {
    fileName: "ebu.wav",
    mimeType: "audio/wav",
    sourceFormat: "wav",
    sampleRate: SR,
    bitDepth: 32,
    durationSeconds: frameCount / SR,
    frameCount,
    channelCount: channels.length,
    channelLayout: layout ?? deriveChannelLayout(channels.length, null),
    decoderMode: "native-parser",
    decoderLabel: "test",
    decoderSummary: "",
    decodeNotes: [],
    warnings: [],
    channels,
  };
  return analyzeDecodedAsset(asset, null).metrics;
}

// ---- per-case harness (counts CASES, not assertions, per M-25) ----
let assertPass = 0;
let assertFail = 0;
let activeCaseId = "";
/** @type {{ id: string, ok: boolean }[]} */
const caseResults = [];

/**
 * @param {string} id
 * @param {string} title
 * @param {() => void} body
 */
function runCase(id, title, body) {
  const failBefore = assertFail;
  console.log(`\n[${id}] ${title}`);
  activeCaseId = id;
  body();
  caseResults.push({ id, ok: assertFail === failBefore });
}

// Every assertion becomes one named test under the runner. The counters stay so
// the coverage report below can keep its per-case denominators.
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function record(name, ok, detail) {
  ok ? (assertPass += 1) : (assertFail += 1);
  const caseId = activeCaseId;
  test(`[${caseId}] ${name}`, () => {
    assert.ok(ok, detail);
  });
}

/**
 * @param {string} name
 * @param {number | null} actual
 * @param {number} expected
 * @param {number} tol
 */
function expect(name, actual, expected, tol) {
  const value = Number(actual);
  const ok = Number.isFinite(actual) && Math.abs(value - expected) <= tol;
  record(
    name,
    ok,
    `${Number.isFinite(actual) ? value.toFixed(3) : actual} (expected ${expected.toFixed(2)} +-${tol})`,
  );
}

// Asymmetric band [expected+low, expected+high] for the EBU true-peak tolerance
// (published as "+0.2 / -0.4 dBTP": may over-read by 0.2, under-read by 0.4).
/**
 * @param {string} name
 * @param {number | null} actual
 * @param {number} expected
 * @param {number} low
 * @param {number} high
 */
function expectBand(name, actual, expected, low, high) {
  const lo = expected + low;
  const hi = expected + high;
  const value = Number(actual);
  const ok = Number.isFinite(actual) && value >= lo && value <= hi;
  record(
    name,
    ok,
    `${Number.isFinite(actual) ? value.toFixed(3) : actual} (expected in [${lo.toFixed(2)}, ${hi.toFixed(2)}])`,
  );
}

// Roll a family of sub-signals (e.g. 20 alignments) into ONE case: passes iff every
// sub-signal is within tol of its expected value. Reports the worst error.
/**
 * @param {(number | null)[]} values
 * @param {string} name
 * @param {(index: number) => number} expectedFn
 * @param {number} tol
 */
function expectFamily(name, values, expectedFn, tol) {
  let worst = 0;
  let allOk = true;
  values.forEach((v, i) => {
    const e = expectedFn(i);
    const d = Math.abs(Number(v) - e);
    worst = Math.max(worst, d);
    if (!(Number.isFinite(v) && d <= tol)) allOk = false;
  });
  record(name, allOk, `${values.length} sub-signals, worst error ${worst.toFixed(4)} LU (tol +-${tol})`);
}

console.log("================ EBU Tech 3341 — Loudness (I / M / S) ================");

runCase("3341-1", "Stereo 1 kHz sine @ -23 dBFS, 20 s -> I/M/S = -23.0", () => {
  const m = analyze(toneSegment(-23, 20));
  expect("integrated", m.integratedLufs, -23.0, 0.1);
  expect("max momentary", m.maxMomentaryLufs, -23.0, 0.1);
  expect("max short-term", m.maxShortTermLufs, -23.0, 0.1);
});

runCase("3341-2", "Stereo 1 kHz sine @ -33 dBFS, 20 s -> I = -33.0", () => {
  const m = analyze(toneSegment(-33, 20));
  expect("integrated", m.integratedLufs, -33.0, 0.1);
});

runCase("3341-3", "Gating: 10s -36 / 60s -23 / 10s -36 -> I = -23.0 (relative gate)", () => {
  const m = analyze(concatSegments([toneSegment(-36, 10), toneSegment(-23, 60), toneSegment(-36, 10)]));
  expect("integrated", m.integratedLufs, -23.0, 0.1);
});

runCase("3341-4", "Gating: 10s -72 / 10s -36 / 60s -23 / 10s -36 / 10s -72 -> I = -23.0 (abs + rel gate)", () => {
  const m = analyze(
    concatSegments([toneSegment(-72, 10), toneSegment(-36, 10), toneSegment(-23, 60), toneSegment(-36, 10), toneSegment(-72, 10)]),
  );
  expect("integrated", m.integratedLufs, -23.0, 0.1);
});

runCase("3341-5", "Gating: 20s -26 / 20.1s -20 / 20s -26 -> I = -23.0", () => {
  const m = analyze(concatSegments([toneSegment(-26, 20), toneSegment(-20, 20.1), toneSegment(-26, 20)]));
  expect("integrated", m.integratedLufs, -23.0, 0.1);
});

runCase("3341-6", "5.0 multichannel: L/R -28, C -24, Ls/Rs -30, 20 s -> I = -23.0", () => {
  // Mask 0x607 = FL|FR|FC|SL|SR -> L,R,C,Ls,Rs (not guessed). Exercises ITU-R
  // BS.1770-5 channel summation with the Ls/Rs surround weight (sqrt 2). With the
  // pre-H-03 prefix weighting this read ~-23.4 and would fail this +-0.1 band.
  const layout = deriveChannelLayout(5, 0x607);
  const channels = [monoTone(-28, 20), monoTone(-28, 20), monoTone(-24, 20), monoTone(-30, 20), monoTone(-30, 20)];
  const m = analyze(channels, layout);
  expect("integrated", m.integratedLufs, -23.0, 0.1);
});

console.log("\n================ EBU Tech 3341 — Momentary / Short-term meter dynamics ================");

runCase("3341-9", "Short-term averaging: (1.34s -20 / 1.66s -30) x5 -> Max S = -23.0", () => {
  const pattern = [toneSegment(-20, 1.34), toneSegment(-30, 1.66)];
  const segments = [];
  for (let k = 0; k < 5; k += 1) segments.push(...pattern);
  const m = analyze(concatSegments(segments));
  expect("max short-term", m.maxShortTermLufs, -23.0, 0.1);
});

runCase("3341-10", "Short-term alignment: 20 files (i*0.15s sil; 3s -23; 1s sil) -> Max S = -23.0 each", () => {
  /** @type {(number | null)[]} */
  const values = [];
  for (let i = 0; i < 20; i += 1) values.push(analyze(pulseSegment(-23, i * 150, 3000, 1000)).maxShortTermLufs);
  expectFamily("Max S over 20 alignments", values, () => -23.0, 0.1);
});

runCase("3341-11", "Short-term staircase: 20 files (i*0.15s sil; 3s @(-38+i); trail) -> Max S = -38..-19 (file-based equivalent)", () => {
  // Case 11 is defined for 'live' meters as one file yielding 20 successive Max S
  // values; a file-based meter reproduces it by measuring each segment as its own
  // file (audit M-25 / task note: "the meter is file-based so analyze each segment").
  /** @type {(number | null)[]} */
  const values = [];
  for (let i = 0; i < 20; i += 1) values.push(analyze(pulseSegment(-38 + i, i * 150, 3000, 3000 - i * 150)).maxShortTermLufs);
  expectFamily("Max S over 20 levels", values, (i) => -38 + i, 0.1);
});

runCase("3341-12", "Momentary averaging: (0.18s -20 / 0.22s -30) x25 -> Max M = -23.0", () => {
  const pattern = [toneSegment(-20, 0.18), toneSegment(-30, 0.22)];
  const segments = [];
  for (let k = 0; k < 25; k += 1) segments.push(...pattern);
  const m = analyze(concatSegments(segments));
  expect("max momentary", m.maxMomentaryLufs, -23.0, 0.1);
});

runCase("3341-13", "Momentary alignment (H-01): 20 files (i*20ms sil; 400ms -23; 1s sil) -> Max M = -23.0 each", () => {
  // The exact audit H-01 failure: on a fixed 100 ms grid, 16 of these 20 read
  // wrong. The high-resolution rolling momentary window must read -23.0 +-0.1 for
  // every alignment.
  /** @type {(number | null)[]} */
  const values = [];
  for (let i = 0; i < 20; i += 1) values.push(analyze(pulseSegment(-23, i * 20, 400, 1000)).maxMomentaryLufs);
  expectFamily("Max M over 20 alignments", values, () => -23.0, 0.1);
});

runCase("3341-14", "Momentary staircase: 20 files (i*20ms sil; 400ms @(-38+i); trail) -> Max M = -38..-19 (file-based equivalent)", () => {
  /** @type {(number | null)[]} */
  const values = [];
  for (let i = 0; i < 20; i += 1) values.push(analyze(pulseSegment(-38 + i, i * 20, 400, 400 - i * 20)).maxMomentaryLufs);
  expectFamily("Max M over 20 levels", values, (i) => -38 + i, 0.1);
});

console.log("\n================ EBU Tech 3341 — True peak (ITU-R BS.1770 inter-sample) ================");
// Published tolerance: +0.2 / -0.4 dBTP. Steady sines with faded edges (see fadedSine).

runCase("3341-15", "True peak: fs/4 sine, amp 0.50, phase 0 deg -> -6.0 dBTP", () => {
  const m = analyze(fadedSine(0.5, SR / 4, 0));
  expect("sample peak", m.samplePeakDbfs, -6.02, 0.2);
  expectBand("true peak", m.truePeakDbtp, -6.0, -0.4, 0.2);
});

runCase("3341-16", "True peak: fs/4 sine, amp 0.50, phase 45 deg -> -6.0 dBTP (samples under-represent the crest)", () => {
  const m = analyze(fadedSine(0.5, SR / 4, 45));
  expectBand("true peak", m.truePeakDbtp, -6.0, -0.4, 0.2);
  // The inter-sample peak must exceed the (lower) sample peak.
  const catches = m.truePeakDbtp > m.samplePeakDbfs + 1.0;
  record(
    "true peak exceeds sample peak by >1 dB",
    catches,
    `TP=${m.truePeakDbtp.toFixed(3)} SP=${m.samplePeakDbfs.toFixed(3)}`,
  );
});

runCase("3341-17", "True peak: fs/6 sine, amp 0.50, phase 60 deg -> -6.0 dBTP", () => {
  const m = analyze(fadedSine(0.5, SR / 6, 60));
  expectBand("true peak", m.truePeakDbtp, -6.0, -0.4, 0.2);
});

runCase("3341-18", "True peak: fs/8 sine, amp 0.50, phase 67.5 deg -> -6.0 dBTP", () => {
  const m = analyze(fadedSine(0.5, SR / 8, 67.5));
  expectBand("true peak", m.truePeakDbtp, -6.0, -0.4, 0.2);
});

runCase("3341-19", "True peak: fs/4 sine, amp 1.41 (over 0 dBFS), phase 45 deg -> +3.0 dBTP", () => {
  const m = analyze(fadedSine(Math.SQRT2, SR / 4, 45));
  expectBand("true peak", m.truePeakDbtp, 3.0, -0.4, 0.2);
});

console.log("\n================ EBU Tech 3342 — Loudness Range ================");
// Table 1 synthetic tone cases 1-4 (durations/levels per the published table),
// exercising the rounded-rank percentile procedure and the >=1.5 s file-based
// trailing-silence padding (M-14). Tolerance +-1 LU. Cases 5-6 are authentic
// programme segments (reference-audio only, see the HONESTY NOTE) and are not run.

runCase("3342-1", "LRA: 20s -20 / 20s -30 dBFS -> 10 LU", () => {
  const m = analyze(concatSegments([toneSegment(-20, 20), toneSegment(-30, 20)]));
  expect("loudness range", m.loudnessRange, 10.0, 1.0);
});

runCase("3342-2", "LRA: 20s -20 / 20s -15 dBFS -> 5 LU", () => {
  const m = analyze(concatSegments([toneSegment(-20, 20), toneSegment(-15, 20)]));
  expect("loudness range", m.loudnessRange, 5.0, 1.0);
});

runCase("3342-3", "LRA: 20s -40 / 20s -20 dBFS -> 20 LU", () => {
  const m = analyze(concatSegments([toneSegment(-40, 20), toneSegment(-20, 20)]));
  expect("loudness range", m.loudnessRange, 20.0, 1.0);
});

runCase("3342-4", "LRA: 20s each -50 / -35 / -20 / -35 / -50 dBFS -> 15 LU", () => {
  const m = analyze(
    concatSegments([toneSegment(-50, 20), toneSegment(-35, 20), toneSegment(-20, 20), toneSegment(-35, 20), toneSegment(-50, 20)]),
  );
  expect("loudness range", m.loudnessRange, 15.0, 1.0);
});

// ---- report (per-case, honest denominators) ----
const casesOk = caseResults.filter((c) => c.ok).length;
const failedCases = caseResults.filter((c) => !c.ok);
const tech3341Reproduced = caseResults.filter((c) => c.id.startsWith("3341-")).length;
const tech3342Reproduced = caseResults.filter((c) => c.id.startsWith("3342-")).length;

console.log("\n=====================================================================");
console.log(
  `EBU Tech 3341/3342 subset: ${casesOk}/${caseResults.length} reproduced cases pass ` +
    `(${assertPass}/${assertPass + assertFail} assertions).`,
);
console.log(
  `Coverage: ${tech3341Reproduced} of 23 published Tech 3341 cases + ${tech3342Reproduced} of 6 published Tech 3342 cases. ` +
    `Not reproduced (need EBU reference-audio downloads or 4*fs synthesis): 3341-7/8, 3341-20..23, 3342-5/6.`,
);
if (failedCases.length) {
  console.log(`Failed cases: ${failedCases.map((c) => c.id).join(", ")}`);
}
console.log("=====================================================================\n");
