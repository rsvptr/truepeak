// Reference-signal validation for the TruePeak DSP engine.
// Generates known WAV signals, runs the real parser + analyzer, and checks the
// measured loudness / true-peak / LRA against values we can derive analytically.
//
// Run: npm run test:dsp
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { encodeWav } from "./lib/fixtures.mjs";
import { makeAudioMetadata, makeTimeline } from "./lib/job-fixtures.mjs";

register("./alias-loader.mjs", import.meta.url);

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const {
  analyzeDecodedAsset,
  INVALID_INTEGRATED_TOO_SHORT_WARNING,
  INVALID_INTEGRATED_BELOW_GATE_WARNING,
  LRA_UNSTABLE_WARNING,
  TRUE_PEAK_FIR,
} = await import("../../src/audio/analysis.ts");
const { deriveChannelLayout, getLoudnessWeight, describeLayoutRisk } = await import(
  "../../src/audio/channel-layout.ts"
);
const { applyTargetToMetrics, clearTargetFromMetrics, TARGET_LIMIT_WARNING } = await import(
  "../../src/audio/targeting.ts"
);
const { getComplianceSummary } = await import("../../src/audio/compliance.ts");

/** @typedef {import("../../src/types/audio.ts").ChannelLabel} ChannelLabel */
/** @typedef {import("../../src/types/audio.ts").ChannelLayout} ChannelLayout */
/** @typedef {import("../../src/types/audio.ts").DecodedAudioAsset} DecodedAudioAsset */
/** @typedef {import("../../src/types/audio.ts").AnalysisResult} AnalysisResult */
/** @typedef {import("../../src/types/audio.ts").LoudnessMetrics} LoudnessMetrics */
/** @typedef {import("../../src/types/audio.ts").TargetPreset} TargetPreset */

/**
 * @param {object} options
 * @param {number} options.freq
 * @param {number} options.amp
 * @param {number} options.seconds
 * @param {number} [options.sampleRate]
 * @param {number} [options.channels]
 * @param {number} [options.phase]
 * @returns {Float32Array[]}
 */
function sine({ freq, amp, seconds, sampleRate = 48000, channels = 2, phase = 0 }) {
  const frameCount = Math.round(seconds * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(frameCount));
  for (let n = 0; n < frameCount; n += 1) {
    const value = amp * Math.sin((2 * Math.PI * freq * n) / sampleRate + phase);
    for (let ch = 0; ch < channels; ch += 1) data[ch][n] = value;
  }
  return data;
}

/**
 * @param {Float32Array[]} channels
 * @param {number} [sampleRate]
 */
function analyzeChannels(channels, sampleRate = 48000) {
  const wav = encodeWav({ channels, sampleRate });
  const asset = parseWavBuffer(wav, "test.wav", "audio/wav");
  return analyzeDecodedAsset(asset, null).metrics;
}

// ---- assertions ----
/**
 * @param {string} name
 * @param {number} actual
 * @param {number} expected
 * @param {number} tol
 */
function check(name, actual, expected, tol) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  test(name, () => {
    assert.ok(ok, `got ${actual}, expected ${expected.toFixed(3)} +-${tol}`);
  });
}
/**
 * @param {string} name
 * @param {number} actual
 * @param {">" | "<" | ">=" | "<="} op
 * @param {number} bound
 */
function checkCmp(name, actual, op, bound) {
  const ops = { ">": actual > bound, "<": actual < bound, ">=": actual >= bound, "<=": actual <= bound };
  const ok = Number.isFinite(actual) && ops[op];
  test(name, () => {
    assert.ok(ok, `got ${actual}, expected ${op} ${bound}`);
  });
}

// Boolean assertion (validity flags, nulls, warning membership, layout labels).
/**
 * @param {string} name
 * @param {boolean} cond
 * @param {string} [detail]
 */
function assertOk(name, cond, detail = "") {
  test(name, () => {
    assert.ok(cond, detail);
  });
}

// Build a decoded asset straight from channel data (bypasses the WAV encoder so
// tests can set exact frame counts, silence, sample rates, and channel layouts).
/**
 * @param {Float32Array[]} channels
 * @param {{ sampleRate?: number, layout?: ChannelLayout }} [options]
 * @returns {DecodedAudioAsset}
 */
function makeAsset(channels, { sampleRate = 48000, layout } = {}) {
  const frameCount = channels[0]?.length ?? 0;
  return {
    fileName: "dsp.wav",
    mimeType: "audio/wav",
    sourceFormat: "wav",
    sampleRate,
    bitDepth: 32,
    durationSeconds: sampleRate > 0 ? frameCount / sampleRate : 0,
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
}

/** @param {number} amp */
const dbfs = (amp) => 20 * Math.log10(amp);
/** @param {number} db */
const ampForDbfs = (db) => 10 ** (db / 20);

console.log("\n[1] Stereo 1 kHz sine @ -6 dBFS (amp 0.5), 48k, 4s");
const m1 = analyzeChannels(sine({ freq: 1000, amp: 0.5, seconds: 4 }));
console.log(`     integrated=${m1.integratedLufs.toFixed(2)} LUFS  TP=${m1.truePeakDbtp.toFixed(2)} dBTP  SP=${m1.samplePeakDbfs.toFixed(2)} dBFS  LRA=${m1.loudnessRange.toFixed(2)}`);
check("sample peak", m1.samplePeakDbfs, dbfs(0.5), 0.05);
checkCmp("true peak >= sample peak", m1.truePeakDbtp, ">=", m1.samplePeakDbfs - 0.02);
checkCmp("true peak within 0.3 dB of sample peak (low freq)", m1.truePeakDbtp, "<", m1.samplePeakDbfs + 0.3);
for (const seconds of [2, 3, 5, 10, 20]) {
  const steadyToneMetrics = analyzeChannels(sine({ freq: 1000, amp: 0.5, seconds }));
  checkCmp(
    `LRA uses complete windows for a steady ${seconds} s tone`,
    steadyToneMetrics.loudnessRange,
    "<",
    0.1,
  );
  assertOk(
    `LRA validity reflects complete-window count at ${seconds} s`,
    steadyToneMetrics.loudnessRangeValid === (seconds >= 5),
  );
}

console.log("\n[1b] LOGIC-05 per-rate accuracy: -23 dBFS 1 kHz stereo tone at each supported rate (48 kHz covered by validate-ebu.mjs 3341-1)");
const referenceRateTruePeakDbtp = analyzeChannels(sine({ freq: 1000, amp: ampForDbfs(-23), seconds: 4 })).truePeakDbtp;
for (const sampleRate of [44100, 88200, 96000, 192000]) {
  const rateMetrics = analyzeChannels(
    sine({ freq: 1000, amp: ampForDbfs(-23), seconds: 4, sampleRate }),
    sampleRate,
  );
  check(`integrated -23 dBFS tone reads -23.0 LUFS at ${sampleRate} Hz`, rateMetrics.integratedLufs, -23.0, 0.1);
  check(
    `true peak at ${sampleRate} Hz matches the 48 kHz reading`,
    rateMetrics.truePeakDbtp,
    referenceRateTruePeakDbtp,
    0.1,
  );
}

console.log("\n[2] Same tone at -12 dBFS (amp 0.25) — expect ~6 dB/LU drop vs [1]");
const m2 = analyzeChannels(sine({ freq: 1000, amp: 0.25, seconds: 4 }));
console.log(`     integrated=${m2.integratedLufs.toFixed(2)} LUFS  SP=${m2.samplePeakDbfs.toFixed(2)} dBFS`);
check("sample peak", m2.samplePeakDbfs, dbfs(0.25), 0.05);
check("integrated drops ~6.02 LU", m1.integratedLufs - m2.integratedLufs, 6.02, 0.15);

console.log("\n[3] Inter-sample peak: full-scale 12 kHz (fs/4) sine, phase π/4 — samples hit ±0.707");
const m3 = analyzeChannels(sine({ freq: 12000, amp: 1.0, seconds: 2, phase: Math.PI / 4 }));
console.log(`     TP=${m3.truePeakDbtp.toFixed(2)} dBTP  SP=${m3.samplePeakDbfs.toFixed(2)} dBFS`);
check("sample peak ~ -3.01 dBFS", m3.samplePeakDbfs, dbfs(Math.SQRT1_2), 0.1);
checkCmp("true peak recovers the inter-sample crest (> -1 dBTP)", m3.truePeakDbtp, ">", -1.0);
checkCmp("true peak well above sample peak (> +1.5 dB)", m3.truePeakDbtp - m3.samplePeakDbfs, ">", 1.5);

console.log("\n[4] LRA: 5s @ -20 dBFS then 5s @ -14 dBFS (6 dB step), 1 kHz stereo");
/**
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
const concat = (a, b) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};
const quiet = sine({ freq: 1000, amp: 0.1, seconds: 5 });
const loud = sine({ freq: 1000, amp: 0.1 * 10 ** (6 / 20), seconds: 5 });
const stepped = quiet.map((ch, i) => concat(ch, loud[i]));
const m4 = analyzeChannels(stepped);
console.log(`     LRA=${m4.loudnessRange.toFixed(2)} LU  integrated=${m4.integratedLufs.toFixed(2)} LUFS`);
check("LRA tracks a 5 s + 5 s, 6 dB step", m4.loudnessRange, 6, 0.5);

console.log("\n[5] Digital silence, stereo, 2s — floors");
const m5 = analyzeChannels([new Float32Array(96000), new Float32Array(96000)]);
console.log(`     integrated=${m5.integratedLufs.toFixed(2)} LUFS  TP=${m5.truePeakDbtp.toFixed(2)}  SP=${m5.samplePeakDbfs.toFixed(2)}`);
check("integrated floor", m5.integratedLufs, -70, 0.001);
check("sample peak floor", m5.samplePeakDbfs, -144, 0.001);
check("true peak floor", m5.truePeakDbtp, -144, 0.001);

console.log("\n[6] Mono vs stereo same tone — integrated loudness should match (sum of channel energies, equal weight)");
const monoM = analyzeChannels(sine({ freq: 1000, amp: 0.5, seconds: 4, channels: 1 }));
const stereoM = m1;
console.log(`     mono=${monoM.integratedLufs.toFixed(2)}  stereo=${stereoM.integratedLufs.toFixed(2)}`);
check("stereo is ~3.01 LU louder than mono (2x energy)", stereoM.integratedLufs - monoM.integratedLufs, 3.01, 0.1);

console.log("\n[7] H-02 integrated-loudness validity (too-short / below-gate / boundary)");
const short300 = analyzeDecodedAsset(makeAsset(sine({ freq: 1000, amp: 0.5, seconds: 0.3 })), null).metrics;
assertOk("300 ms clip: integratedValid === false", short300.integratedValid === false, `got ${short300.integratedValid}`);
assertOk("300 ms clip: reason === 'too-short'", short300.integratedInvalidReason === "too-short", `got ${short300.integratedInvalidReason}`);
assertOk("300 ms clip: integratedLufs keeps -70 sentinel", short300.integratedLufs === -70, `got ${short300.integratedLufs}`);
assertOk("300 ms clip: maxMomentaryLufs === null", short300.maxMomentaryLufs === null, `got ${short300.maxMomentaryLufs}`);
assertOk("300 ms clip: too-short warning pushed", short300.warnings.includes(INVALID_INTEGRATED_TOO_SHORT_WARNING));
assertOk("300 ms clip: loudnessRangeUnstable === true", short300.loudnessRangeUnstable === true);

const exact400 = analyzeDecodedAsset(makeAsset(sine({ freq: 1000, amp: 0.5, seconds: 0.4 })), null).metrics;
assertOk("exact 400 ms clip: integratedValid === true (boundary)", exact400.integratedValid === true, `got ${exact400.integratedValid}`);
assertOk("exact 400 ms clip: no integratedInvalidReason key", !("integratedInvalidReason" in exact400));
assertOk("exact 400 ms clip: maxMomentaryLufs finite", Number.isFinite(exact400.maxMomentaryLufs), `got ${exact400.maxMomentaryLufs}`);
assertOk("exact 400 ms clip: no too-short warning", !exact400.warnings.includes(INVALID_INTEGRATED_TOO_SHORT_WARNING));

const short399 = analyzeDecodedAsset(makeAsset(sine({ freq: 1000, amp: 0.5, seconds: 0.399 })), null).metrics;
assertOk("399 ms clip: integratedValid === false (just under 400 ms boundary)", short399.integratedValid === false, `got ${short399.integratedValid}`);
assertOk("399 ms clip: reason === 'too-short'", short399.integratedInvalidReason === "too-short");

const silence1s = analyzeDecodedAsset(makeAsset([new Float32Array(48000), new Float32Array(48000)]), null).metrics;
assertOk("1 s digital silence: integratedValid === false", silence1s.integratedValid === false);
assertOk("1 s digital silence: reason === 'below-gate'", silence1s.integratedInvalidReason === "below-gate", `got ${silence1s.integratedInvalidReason}`);
assertOk("1 s digital silence: integratedLufs keeps -70 sentinel", silence1s.integratedLufs === -70);
assertOk("1 s digital silence: below-gate warning pushed", silence1s.warnings.includes(INVALID_INTEGRATED_BELOW_GATE_WARNING));

// Sub-gate noise: 2 s of ~-80 dBFS noise. Complete 400 ms blocks exist, but none
// clears the -70 LUFS absolute gate -> below-gate (distinct from too-short).
{
  const n = 96000;
  const amp = ampForDbfs(-80);
  const chL = new Float32Array(n);
  const chR = new Float32Array(n);
  let seed = 22222;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i += 1) { chL[i] = amp * rnd(); chR[i] = amp * rnd(); }
  const subgate = analyzeDecodedAsset(makeAsset([chL, chR]), null).metrics;
  assertOk("2 s sub-gate noise: integratedValid === false", subgate.integratedValid === false);
  assertOk("2 s sub-gate noise: reason === 'below-gate'", subgate.integratedInvalidReason === "below-gate", `got ${subgate.integratedInvalidReason}`);
}

const valid10s = analyzeDecodedAsset(makeAsset(sine({ freq: 1000, amp: 0.5, seconds: 10 })), null).metrics;
assertOk("10 s tone: integratedValid === true", valid10s.integratedValid === true);
assertOk("10 s tone: no integratedInvalidReason key", !("integratedInvalidReason" in valid10s));
assertOk(
  "10 s tone: no invalid-integrated warning",
  !valid10s.warnings.includes(INVALID_INTEGRATED_TOO_SHORT_WARNING) &&
    !valid10s.warnings.includes(INVALID_INTEGRATED_BELOW_GATE_WARNING),
);
assertOk("10 s tone (<60 s): loudnessRangeUnstable === true", valid10s.loudnessRangeUnstable === true);
assertOk("10 s tone (<60 s): LRA-unstable warning pushed", valid10s.warnings.includes(LRA_UNSTABLE_WARNING));

const valid60s = analyzeDecodedAsset(makeAsset(sine({ freq: 1000, amp: 0.5, seconds: 60 })), null).metrics;
assertOk("60 s tone (>=60 s): loudnessRangeUnstable === false", valid60s.loudnessRangeUnstable === false);
assertOk("60 s tone (>=60 s): no LRA-unstable warning", !valid60s.warnings.includes(LRA_UNSTABLE_WARNING));

// H-02/H-01 boundary alignment at 11025 Hz. The high-res Max-M window is now
// 4 * round(0.1 * SR) frames = the integrated gating-block length. At 11025 Hz that
// is 4 * 1103 = 4412 frames, whereas round(0.4 * SR) = 4410 — the previous mismatch
// let a 4410/4411-frame clip report a valid Max M while integrated was (correctly)
// flagged too-short. Max M must now be null exactly when no complete integrated
// block exists, at every sample rate.
{
  const boundarySr = 11025;
  /** @param {number} frames */
  const boundaryTone = (frames) => {
    const c = new Float32Array(frames);
    const amp = ampForDbfs(-10); // well above the -70 LUFS absolute gate
    for (let i = 0; i < frames; i += 1) c[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / boundarySr);
    return [c, c.slice()];
  };
  for (const frames of [4410, 4411]) {
    const m = analyzeDecodedAsset(makeAsset(boundaryTone(frames), { sampleRate: boundarySr }), null).metrics;
    assertOk(`11025 Hz / ${frames} frames: maxMomentaryLufs === null`, m.maxMomentaryLufs === null, `got ${m.maxMomentaryLufs}`);
    assertOk(
      `11025 Hz / ${frames} frames: integratedValid === false (too-short)`,
      m.integratedValid === false && m.integratedInvalidReason === "too-short",
      `valid=${m.integratedValid} reason=${m.integratedInvalidReason}`,
    );
  }
  const m4412 = analyzeDecodedAsset(makeAsset(boundaryTone(4412), { sampleRate: boundarySr }), null).metrics;
  assertOk("11025 Hz / 4412 frames: maxMomentaryLufs finite (one complete block)", Number.isFinite(m4412.maxMomentaryLufs), `got ${m4412.maxMomentaryLufs}`);
  assertOk(
    "11025 Hz / 4412 frames: integratedValid === true",
    m4412.integratedValid === true,
    `valid=${m4412.integratedValid} reason=${m4412.integratedInvalidReason}`,
  );
}

console.log("\n[8] Targeting & compliance (H-02 validity gating, M-12 tolerance-before-ceiling)");
/**
 * @param {Partial<LoudnessMetrics>} [overrides]
 * @returns {LoudnessMetrics}
 */
function baseMetricsFixture(overrides = {}) {
  return {
    integratedLufs: -14.05,
    ungatedLufs: -14.05,
    loudnessRange: 5,
    maxMomentaryLufs: -13,
    maxShortTermLufs: -13.5,
    samplePeakDbfs: -1,
    truePeakDbtp: -1,
    unclampedTargetDeltaDb: null,
    targetDeltaDb: null,
    projectedTruePeakDbtp: null,
    normalizationLimited: false,
    timeline: makeTimeline(),
    warnings: [],
    ...overrides,
  };
}
/**
 * @param {Partial<TargetPreset>} [overrides]
 * @returns {TargetPreset}
 */
function targetPresetFixture(overrides = {}) {
  return {
    id: "test",
    label: "Test",
    category: "custom",
    evidence: "custom",
    sourceLabel: "s",
    referenceNote: "n",
    highlights: [],
    loudnessTargetLufs: -14,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 0.5,
    policy: "protect-true-peak",
    description: "d",
    ...overrides,
  };
}
/**
 * @param {LoudnessMetrics} metrics
 * @param {TargetPreset | null} [target]
 * @returns {AnalysisResult}
 */
function fakeResult(metrics, target) {
  return {
    metadata: makeAudioMetadata(),
    metrics,
    analysisMode: target ? "targeted" : "measure-only",
    target: target ?? null,
    analyzedAt: "2026-01-01T00:00:00.000Z",
  };
}

// M-12: source already inside tolerance, optional residual move capped by the ceiling.
{
  const target = targetPresetFixture();
  const applied = applyTargetToMetrics(baseMetricsFixture({ integratedLufs: -14.05, truePeakDbtp: -1 }), target);
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk("M-12: residual move at ceiling -> normalizationLimited === true", applied.normalizationLimited === true);
  assertOk(
    "M-12: in-tolerance-at-ceiling reports 'on-target' (not 'ceiling-limited')",
    summary != null && summary.state === "on-target",
    summary ? summary.state : "null",
  );
}
// Genuinely out-of-tolerance quiet source with a capped upward move -> still ceiling-limited.
{
  const target = targetPresetFixture();
  const applied = applyTargetToMetrics(baseMetricsFixture({ integratedLufs: -20, truePeakDbtp: -1 }), target);
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk(
    "out-of-tolerance + capped move -> 'ceiling-limited'",
    summary != null && summary.state === "ceiling-limited",
    summary ? summary.state : "null",
  );
}
// A quiet file whose MEASURED peak is already over the ceiling, under a
// loudness-first target. normalizationLimited is only ever set for
// protect-true-peak, so this used to read "Needs gain" with a large positive
// suggested move and a projected peak far past the ceiling, with the breach
// reported nowhere at all.
{
  const target = targetPresetFixture({ policy: "loudness-first", toleranceLufs: 1 });
  const applied = applyTargetToMetrics(
    baseMetricsFixture({ integratedLufs: -20, truePeakDbtp: -0.5 }),
    target,
  );
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk(
    "loudness-first leaves normalizationLimited false",
    applied.normalizationLimited === false,
  );
  assertOk(
    "loudness-first quiet file with measured peak over the ceiling -> 'ceiling-limited'",
    summary != null && summary.state === "ceiling-limited",
    summary ? summary.state : "null",
  );
}
// The same peak breach must NOT hijack a too-hot file when attenuating to target
// clears the loudness axis and the peak axis together: -8 against a -14 target
// moves -6 dB, taking a -0.2 dBTP peak to -6.2, well inside a -1 dBTP ceiling.
{
  const target = targetPresetFixture({ policy: "loudness-first", toleranceLufs: 1 });
  const applied = applyTargetToMetrics(
    baseMetricsFixture({ integratedLufs: -8, truePeakDbtp: -0.2 }),
    target,
  );
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk(
    "too-hot file whose attenuation also clears the ceiling keeps 'above-target'",
    summary != null && summary.state === "above-target",
    summary ? summary.state : "null",
  );
}
// A too-hot file whose PEAK excess exceeds its LOUDNESS excess is the same trap
// in the other direction: attenuating by the loudness gap is not enough to clear
// the ceiling. Shipped preset shape (loudness-first, tolerance 1 LU): -9.5 LUFS
// against a -11 target attenuates 1.5 dB, taking a +1.5 dBTP peak to 0.0 dBTP,
// still 1 dB over a -1 dBTP ceiling.
{
  const target = targetPresetFixture({
    policy: "loudness-first",
    loudnessTargetLufs: -11,
    toleranceLufs: 1,
  });
  const applied = applyTargetToMetrics(
    baseMetricsFixture({ integratedLufs: -9.5, truePeakDbtp: 1.5 }),
    target,
  );
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk(
    "peak excess larger than loudness excess -> attenuation leaves the peak over",
    Math.abs((applied.projectedTruePeakDbtp ?? 0) - 0) < 1e-9,
    String(applied.projectedTruePeakDbtp),
  );
  assertOk(
    "too-hot file whose attenuation cannot clear the ceiling reads 'ceiling-limited'",
    summary != null && summary.state === "ceiling-limited",
    summary ? summary.state : "null",
  );
}
// ...and a SMALL overshoot does not clear a large peak excess. -13.5 against a
// -14 target moves only -0.5 dB, so a -0.1 dBTP peak lands at -0.6, still over a
// -1 dBTP ceiling. Reporting "Too hot" alone would hand the user a gain move that
// leaves the file non-compliant.
{
  const target = targetPresetFixture({ policy: "loudness-first", toleranceLufs: 0.2 });
  const applied = applyTargetToMetrics(
    baseMetricsFixture({ integratedLufs: -13.5, truePeakDbtp: -0.1 }),
    target,
  );
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk(
    "the suggested attenuation is the one that decides the peak axis",
    Math.abs((applied.projectedTruePeakDbtp ?? 0) - -0.6) < 1e-9,
    String(applied.projectedTruePeakDbtp),
  );
  assertOk(
    "too-hot file whose attenuation still leaves the peak over the ceiling reads 'ceiling-limited'",
    summary != null && summary.state === "ceiling-limited",
    summary ? summary.state : "null",
  );
}
// The verdict window is the tolerance the user actually chose. A 0.1 LU floor
// used to widen anything tighter, while CSV/JSON exported the unclamped value
// next to a verdict never evaluated against it.
{
  const target = targetPresetFixture({ toleranceLufs: 0.05 });
  const applied = applyTargetToMetrics(
    baseMetricsFixture({ integratedLufs: -14.09, truePeakDbtp: -3 }),
    target,
  );
  const summary = getComplianceSummary(fakeResult(applied, target));
  assertOk(
    "a 0.09 LU miss against a 0.05 LU tolerance is NOT on-target",
    summary != null && summary.state !== "on-target",
    summary ? summary.state : "null",
  );
  const inside = applyTargetToMetrics(
    baseMetricsFixture({ integratedLufs: -14.04, truePeakDbtp: -3 }),
    target,
  );
  const insideSummary = getComplianceSummary(fakeResult(inside, target));
  assertOk(
    "a 0.04 LU miss against a 0.05 LU tolerance IS on-target",
    insideSummary != null && insideSummary.state === "on-target",
    insideSummary ? insideSummary.state : "null",
  );
  assertOk(
    "the reported window is the chosen tolerance, not a floored one",
    insideSummary != null && insideSummary.description.includes("0.05"),
    insideSummary ? insideSummary.description : "null",
  );
}
// integratedValid === false -> all gain/projection fields null, no cap warning, compliance null.
{
  const target = targetPresetFixture();
  const invalid = baseMetricsFixture({
    integratedLufs: -70,
    integratedValid: false,
    integratedInvalidReason: "too-short",
    truePeakDbtp: -6,
  });
  const applied = applyTargetToMetrics(invalid, target);
  assertOk("invalid integrated: unclampedTargetDeltaDb === null", applied.unclampedTargetDeltaDb === null);
  assertOk("invalid integrated: targetDeltaDb === null", applied.targetDeltaDb === null);
  assertOk("invalid integrated: projectedTruePeakDbtp === null", applied.projectedTruePeakDbtp === null);
  assertOk("invalid integrated: normalizationLimited === false", applied.normalizationLimited === false);
  assertOk("invalid integrated: no TARGET_LIMIT_WARNING pushed", !applied.warnings.includes(TARGET_LIMIT_WARNING));
  assertOk("invalid integrated: getComplianceSummary === null", getComplianceSummary(fakeResult(applied, target)) === null);
}
// Legacy metrics (integratedValid key absent) -> targeting math unchanged from pre-Phase-1.
{
  const target = targetPresetFixture();
  const legacyIn = baseMetricsFixture({ integratedLufs: -20, truePeakDbtp: -3 });
  delete legacyIn.integratedValid;
  const applied = applyTargetToMetrics(legacyIn, target);
  const cleared = clearTargetFromMetrics(legacyIn);
  const unclamped = target.loudnessTargetLufs - cleared.integratedLufs;
  const maxAllowed = target.truePeakCeilingDbtp - cleared.truePeakDbtp;
  const delta = Math.min(unclamped, maxAllowed);
  assertOk("legacy: unclampedTargetDeltaDb matches pre-Phase-1", applied.unclampedTargetDeltaDb === unclamped);
  assertOk("legacy: targetDeltaDb matches pre-Phase-1", applied.targetDeltaDb === delta);
  assertOk("legacy: projectedTruePeakDbtp matches pre-Phase-1", applied.projectedTruePeakDbtp === cleared.truePeakDbtp + delta);
  assertOk("legacy: getComplianceSummary is non-null (measurement present)", getComplianceSummary(fakeResult(applied, target)) !== null);
}

console.log("\n[9] M-09 true-peak timeline invariant (headline == max plotted, within 1e-6)");
/** @param {Float32Array | number[]} arr */
function maxArr(arr) {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
}
// Partial final bin: 1.05 s (50400 frames, not a multiple of 4800); only non-zero sample is the final 0.9.
{
  const n = Math.round(1.05 * 48000);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  l[n - 1] = 0.9;
  r[n - 1] = 0.9;
  const m = analyzeDecodedAsset(makeAsset([l, r]), null).metrics;
  const plotted = maxArr(m.timeline.truePeakDbtp);
  assertOk(
    "partial-final-bin: headline TP == max(timeline.truePeakDbtp)",
    Math.abs(m.truePeakDbtp - plotted) <= 1e-6,
    `headline ${m.truePeakDbtp.toFixed(6)} vs max ${plotted.toFixed(6)}`,
  );
  assertOk(
    "partial-final-bin: truePeak series length == timeSeconds length",
    m.timeline.truePeakDbtp.length === m.timeline.timeSeconds.length,
  );
}
// End-of-file transient (M-09 probe #2): source samples in the last 20 frames
// remain represented in the last complete timeline bin.
{
  const n = 48000;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = n - 20; i < n; i += 1) { l[i] = (i % 2 === 0 ? 1 : -1) * 0.98; r[i] = l[i]; }
  const m = analyzeDecodedAsset(makeAsset([l, r]), null).metrics;
  const plotted = maxArr(m.timeline.truePeakDbtp);
  assertOk(
    "end-transient: headline TP == max(timeline.truePeakDbtp)",
    Math.abs(m.truePeakDbtp - plotted) <= 1e-6,
    `headline ${m.truePeakDbtp.toFixed(6)} vs max ${plotted.toFixed(6)}`,
  );
}
// LOGIC-06: a tone cut at its positive peak must stop at the last source sample.
// Flushing the FIR with zeroes measured the artificial step and read about 1 dB hot.
{
  const sampleRate = 48000;
  const amplitude = ampForDbfs(-6.02);
  let frameCount = sampleRate;
  while ((frameCount - 1) % 48 !== 12) frameCount += 1;
  const channels = sine({
    freq: 1000,
    amp: amplitude,
    seconds: frameCount / sampleRate,
    sampleRate,
  });
  const m = analyzeDecodedAsset(makeAsset(channels, { sampleRate }), null).metrics;
  check(
    "hard-cut positive peak matches libebur128/ffmpeg source-boundary behavior",
    m.truePeakDbtp,
    -6.02,
    0.1,
  );
}
// Mid-file transient: invariant must still hold when the hottest peak is not at the edges.
{
  const n = Math.round(2.05 * 48000);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 48000; i < 48020; i += 1) { l[i] = (i % 2 === 0 ? 1 : -1) * 0.95; r[i] = l[i]; }
  const m = analyzeDecodedAsset(makeAsset([l, r]), null).metrics;
  const plotted = maxArr(m.timeline.truePeakDbtp);
  assertOk("mid-file transient: headline TP == max(timeline.truePeakDbtp)", Math.abs(m.truePeakDbtp - plotted) <= 1e-6);
}

console.log("\n[10] M-11 determinism + caller PCM not mutated");
{
  const amp = 0.5;
  const n = 4 * 48000;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { l[i] = amp * Math.sin((2 * Math.PI * 100 * i) / 48000); r[i] = l[i]; }
  const lCopy = Float32Array.from(l);
  const rCopy = Float32Array.from(r);
  const asset = makeAsset([l, r]);
  const m1 = analyzeDecodedAsset(asset, null).metrics;
  let mutated = false;
  for (let i = 0; i < n; i += 1) { if (l[i] !== lCopy[i] || r[i] !== rCopy[i]) { mutated = true; break; } }
  assertOk("caller PCM byte-identical after analysis", !mutated);
  const m2 = analyzeDecodedAsset(asset, null).metrics;
  /** @type {(keyof LoudnessMetrics)[]} */
  const fields = ["integratedLufs", "ungatedLufs", "loudnessRange", "maxMomentaryLufs", "maxShortTermLufs", "samplePeakDbfs", "truePeakDbtp"];
  let identical = true;
  let diff = "";
  for (const f of fields) { if (m1[f] !== m2[f]) { identical = false; diff = `${f}: ${m1[f]} vs ${m2[f]}`; break; } }
  assertOk("repeat analysis returns identical metrics", identical, diff);
}

console.log("\n[11] H-03 channel weighting (ITU-R BS.1770-5) + WAVE speaker-mask layouts");
const SQRT2 = Math.sqrt(2);
/** @type {[ChannelLabel, number][]} */
const weightTable = [
  ["L", 1], ["R", 1], ["C", 1], ["LFE", 0], ["Ls", SQRT2], ["Rs", SQRT2], ["Lb", 1], ["Rb", 1],
  ["Cs", 1], ["Lc", 1], ["Rc", 1], ["Tfl", 1], ["Tfc", 1], ["Tfr", 1], ["Tc", 1], ["Tsl", 1],
  ["Tsr", 1], ["Tbl", 1], ["Tbc", 1], ["Tbr", 1], ["Unknown", 1],
];
for (const [label, exp] of weightTable) {
  assertOk(`weight(${label}) === ${exp === SQRT2 ? "sqrt(2)" : exp}`, getLoudnessWeight(label) === exp, `got ${getLoudnessWeight(label)}`);
}
{
  // Top-centre mask bit 0x800 -> Tc (H-03 addition); L/R/C/Tc, not guessed, no risk note.
  const layout = deriveChannelLayout(4, 0x807);
  assertOk("mask 0x807 -> labels L,R,C,Tc", layout.labels.join(",") === "L,R,C,Tc", layout.labels.join(","));
  assertOk("mask 0x807 -> not guessed", layout.guessed === false);
  assertOk("mask 0x807 -> no layout risk note", describeLayoutRisk(layout) === null);
}
{
  // Quad mask 0x33 = FL|FR|BL|BR (4ch, no centre, no side bits). The back pair are
  // GENUINE rears Lb/Rb at weight 1.0 — NOT the 5.1 ~110 degree surrounds. This is
  // the H-03 regression the reviewer caught: back-without-side must only remap to
  // Ls/Rs when a front centre is present (the ITU 5.1 convention). No ambiguity note.
  const layout = deriveChannelLayout(4, 0x33);
  assertOk("mask 0x33 (quad) -> labels L,R,Lb,Rb", layout.labels.join(",") === "L,R,Lb,Rb", layout.labels.join(","));
  assertOk("mask 0x33 (quad) -> not guessed", layout.guessed === false);
  const quadWeights = layout.labels.map((label) => getLoudnessWeight(label));
  assertOk("mask 0x33 (quad) -> weights [1,1,1,1] (true rears, not surrounds)", JSON.stringify(quadWeights) === JSON.stringify([1, 1, 1, 1]), JSON.stringify(quadWeights));
  assertOk("mask 0x33 (quad) -> no ambiguity note (no back->surround remap)", describeLayoutRisk(layout) === null);
}
{
  // The count-only fallback (AIFF, the browser decode route, and any WAVE with a
  // plain 16-byte fmt chunk) must weight quad the same way the 0x33 mask path
  // does. It used to label a maskless 4-channel stream L/R/Ls/Rs, giving two
  // channels the sqrt(2) surround boost, so identical PCM read 0.82 LU louder
  // without a speaker mask than with one.
  const masked = deriveChannelLayout(4, 0x33);
  const fallback = deriveChannelLayout(4, null);
  assertOk("maskless quad -> labels L,R,Lb,Rb", fallback.labels.join(",") === "L,R,Lb,Rb", fallback.labels.join(","));
  assertOk("maskless quad -> guessed", fallback.guessed === true);
  const maskedWeights = masked.labels.map((label) => getLoudnessWeight(label));
  const fallbackWeights = fallback.labels.map((label) => getLoudnessWeight(label));
  assertOk(
    "maskless quad weights match the 0x33 mask path exactly",
    JSON.stringify(fallbackWeights) === JSON.stringify(maskedWeights),
    `${JSON.stringify(fallbackWeights)} vs ${JSON.stringify(maskedWeights)}`,
  );

  // The same PCM through both layouts must land on the same integrated reading.
  const n = Math.round(3 * 48000);
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i += 1) tone[i] = 0.0708 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
  const quadChannels = () => [tone.slice(), tone.slice(), tone.slice(), tone.slice()];
  const withMask = analyzeDecodedAsset(
    makeAsset(quadChannels(), { layout: masked }),
    null,
  ).metrics.integratedLufs;
  const withoutMask = analyzeDecodedAsset(
    makeAsset(quadChannels(), { layout: fallback }),
    null,
  ).metrics.integratedLufs;
  assertOk(
    "quad measures identically with and without a speaker mask",
    Math.abs(withMask - withoutMask) < 1e-9,
    `${withMask.toFixed(4)} vs ${withoutMask.toFixed(4)}`,
  );
}
{
  // Same invariant across every count-only fallback that has a canonical mask
  // equivalent. The weight VECTOR must match position for position, not just as
  // a multiset: weights are applied per channel index, so a fallback listing
  // Ls/Rs where the mask puts Lb/Rb boosts the wrong two channels.
  //
  // The WAVE convention is the one compared here, because that is the only
  // container that can present the same file with and without a mask. AIFF and
  // the browser route always pass "coreaudio" and never have a mask to disagree
  // with, so their 7.1 order (sides at 4/5) is checked separately below.
  const maskByCount = { 4: 0x33, 6: 0x3f, 8: 0x63f };
  for (const [count, mask] of Object.entries(maskByCount)) {
    const channels = Number(count);
    const masked = deriveChannelLayout(channels, mask);
    const fallback = deriveChannelLayout(channels, null, "wave");
    const maskedWeights = masked.labels.map((label) => getLoudnessWeight(label));
    const fallbackWeights = fallback.labels.map((label) => getLoudnessWeight(label));
    assertOk(
      `${channels}-channel WAVE fallback weights match mask 0x${mask.toString(16)} position for position`,
      JSON.stringify(fallbackWeights) === JSON.stringify(maskedWeights),
      `${fallback.labels.join(",")} ${JSON.stringify(fallbackWeights)} vs ${masked.labels.join(",")} ${JSON.stringify(maskedWeights)}`,
    );
  }

  // The two conventions genuinely differ at 8 channels, and the default must
  // stay CoreAudio/MPEG so AIFF and browser-decoded 7.1 keep the sides at
  // indices 4 and 5. Pinning both directions stops a future "make them agree"
  // change from silently reweighting one of the two container families.
  const coreAudio8 = deriveChannelLayout(8, null);
  const wave8 = deriveChannelLayout(8, null, "wave");
  assertOk(
    "the default 8-channel fallback follows CoreAudio/MPEG order (sides at 4/5)",
    coreAudio8.labels.join(",") === "L,R,C,LFE,Ls,Rs,Lb,Rb",
    coreAudio8.labels.join(","),
  );
  assertOk(
    "the WAVE 8-channel fallback follows WAVE order (rears at 4/5)",
    wave8.labels.join(",") === "L,R,C,LFE,Lb,Rb,Ls,Rs",
    wave8.labels.join(","),
  );
}
{
  // 5.1-style mask (front centre + back bits, no side bits) -> back remapped to Ls/Rs, ambiguity note.
  const layout = deriveChannelLayout(6, 0x3f);
  assertOk("mask 0x3F -> labels L,R,C,LFE,Ls,Rs", layout.labels.join(",") === "L,R,C,LFE,Ls,Rs", layout.labels.join(","));
  const weights = layout.labels.map((label) => getLoudnessWeight(label));
  assertOk("mask 0x3F -> weights [1,1,1,0,sqrt2,sqrt2] (5.1 unchanged)", JSON.stringify(weights) === JSON.stringify([1, 1, 1, 0, SQRT2, SQRT2]));
  assertOk("mask 0x3F -> ambiguous-back note mentions 'side channels'", (describeLayoutRisk(layout) || "").includes("side channels"));
}
{
  // 7.1-style mask (side bits present) -> back bits are true rears Lb/Rb (1.0), no note.
  const layout = deriveChannelLayout(8, 0x63f);
  assertOk("mask 0x63F -> labels L,R,C,LFE,Lb,Rb,Ls,Rs", layout.labels.join(",") === "L,R,C,LFE,Lb,Rb,Ls,Rs", layout.labels.join(","));
  const weights = layout.labels.map((label) => getLoudnessWeight(label));
  assertOk("mask 0x63F -> weights [1,1,1,0,1,1,sqrt2,sqrt2] (rears 1.0)", JSON.stringify(weights) === JSON.stringify([1, 1, 1, 0, 1, 1, SQRT2, SQRT2]));
  assertOk("mask 0x63F -> no ambiguity note (side bits disambiguate)", describeLayoutRisk(layout) === null);
}
{
  // Real-analyzer mono equivalence: identical mono reads identical LUFS for C/Tfl/Tc/Lb/Cs (weight 1.0),
  // and +1.505 LU for Ls (surround weight sqrt 2). Guards the H-03 fix through the full pipeline.
  const monoCh = sine({ freq: 1000, amp: 0.5, seconds: 4, channels: 1 })[0];
  /** @param {ChannelLabel} label */
  const readAs = (label) =>
    analyzeDecodedAsset(
      makeAsset([monoCh.slice()], { layout: { name: label, labels: [label], guessed: false, speakerMask: null } }),
      null,
    ).metrics.integratedLufs;
  const cLufs = readAs("C");
  /** @type {ChannelLabel[]} */
  const unitWeightLabels = ["Tfl", "Tc", "Lb", "Cs"];
  for (const label of unitWeightLabels) {
    const v = readAs(label);
    assertOk(`mono '${label}' reads identical to 'C' (weight 1.0)`, Math.abs(v - cLufs) < 1e-9, `delta ${(v - cLufs).toExponential(2)}`);
  }
  const lsLufs = readAs("Ls");
  assertOk("mono 'Ls' reads +1.505 LU above 'C' (surround weight sqrt 2)", Math.abs(lsLufs - cLufs - 1.505) < 0.01, `delta ${(lsLufs - cLufs).toFixed(4)} LU`);
}

console.log("\n[13] True-peak candidate gating is bit-identical to the ungated loop");
// The analyzer skips the oversampling FIR wherever the largest magnitude in a
// sample's twelve-sample window, times the FIR's largest per-phase L1 gain,
// cannot beat the peak already reported for the bin. The reference below is the
// ungated loop the gate replaced, kept here so every reported value can be
// compared against it rather than against a tolerance.

/** @param {number} peak */
const referencePeakToDb = (peak) => (peak <= 0 ? -144 : 20 * Math.log10(peak));

/**
 * @param {Float32Array[]} channels
 * @param {number} stepSamples
 */
function referencePeaks(channels, stepSamples) {
  const frameCount = channels[0]?.length ?? 0;
  const history = channels.map(() => new Float32Array(24));
  const historyIndex = new Array(channels.length).fill(0);
  /** @type {number[]} */
  const truePeakByStep = [];
  let overallSamplePeak = 0;
  let overallTruePeak = 0;
  let stepPeak = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const sample = channels[channelIndex][frame];
      const absSample = Math.abs(sample);
      overallSamplePeak = Math.max(overallSamplePeak, absSample);

      const ring = history[channelIndex];
      const pointer = historyIndex[channelIndex];
      ring[pointer] = sample;
      ring[pointer + 12] = sample;

      let localPeak = absSample;
      for (let phase = 0; phase < TRUE_PEAK_FIR.length; phase += 1) {
        let oversampled = 0;
        for (let tap = 0; tap < 12; tap += 1) {
          oversampled += ring[pointer + tap] * TRUE_PEAK_FIR[phase][tap];
        }
        localPeak = Math.max(localPeak, Math.abs(oversampled));
      }

      overallTruePeak = Math.max(overallTruePeak, localPeak);
      stepPeak = Math.max(stepPeak, localPeak);
      historyIndex[channelIndex] = pointer === 0 ? 11 : pointer - 1;
    }

    if ((frame + 1) % stepSamples === 0) {
      truePeakByStep.push(referencePeakToDb(stepPeak));
      stepPeak = 0;
    }
  }

  if (truePeakByStep.length > 0 && stepPeak > 0) {
    const lastIndex = truePeakByStep.length - 1;
    truePeakByStep[lastIndex] = Math.max(truePeakByStep[lastIndex], referencePeakToDb(stepPeak));
  }

  return {
    samplePeakDbfs: referencePeakToDb(overallSamplePeak),
    truePeakDbtp: referencePeakToDb(overallTruePeak),
    truePeakByStep,
  };
}

/** @param {number} seed */
function seededRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GATING_SAMPLE_RATE = 8000;
const GATING_FRAMES = 2000; // two complete 100 ms bins plus a partial third
const GATING_STEP_SAMPLES = Math.round(GATING_SAMPLE_RATE * 0.1);

/**
 * @param {number} frames
 * @param {(frame: number, channel: number) => number} fill
 * @returns {Float32Array[]}
 */
function gatingSignal(frames, fill) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = fill(frame, 0);
    right[frame] = fill(frame, 1);
  }
  return [left, right];
}

/** @type {{ label: string, channels: Float32Array[] }[]} */
const gatingCases = [
  { label: "silence", channels: gatingSignal(GATING_FRAMES, () => 0) },
  { label: "positive DC", channels: gatingSignal(GATING_FRAMES, () => 0.75) },
  { label: "negative DC", channels: gatingSignal(GATING_FRAMES, () => -0.75) },
  {
    label: "full-scale square wave",
    channels: gatingSignal(GATING_FRAMES, (frame) => (Math.floor(frame / 7) % 2 === 0 ? 1 : -1)),
  },
  {
    label: "full-scale square wave, alternating samples",
    channels: gatingSignal(GATING_FRAMES, (frame) => (frame % 2 === 0 ? 1 : -1)),
  },
  {
    label: "late-arriving peak",
    channels: gatingSignal(GATING_FRAMES, (frame) => {
      const amplitude = frame < GATING_FRAMES - 200 ? 0.02 : 0.98;
      return amplitude * Math.sin((2 * Math.PI * 997 * frame) / GATING_SAMPLE_RATE);
    }),
  },
  {
    label: "single late spike",
    channels: gatingSignal(GATING_FRAMES, (frame) => (frame === GATING_FRAMES - 3 ? 0.999 : 0)),
  },
  {
    label: "single late spike over a quiet floor",
    channels: gatingSignal(GATING_FRAMES, (frame) => (
      frame === GATING_FRAMES - 3
        ? -0.999
        : 0.001 * Math.sin((2 * Math.PI * 311 * frame) / GATING_SAMPLE_RATE)
    )),
  },
];

const gatingRandom = seededRandom(0x7ea11ed);
for (let index = 0; index < 1500; index += 1) {
  const amplitude = 0.05 + gatingRandom() * 0.95;
  const bias = (gatingRandom() - 0.5) * 0.2;
  gatingCases.push({
    label: `seeded noise #${index}`,
    channels: gatingSignal(GATING_FRAMES, () => {
      const value = bias + amplitude * (gatingRandom() * 2 - 1);
      return Math.max(-1, Math.min(1, value));
    }),
  });
}

for (let index = 0; index < 1500; index += 1) {
  // Music-like: a few partials, a slow envelope, and an occasional transient,
  // so the running bin peak spends time both near and far from the window
  // maximum the gate compares against.
  const root = 60 + gatingRandom() * 900;
  const envelopeHz = 0.5 + gatingRandom() * 6;
  const drive = 0.2 + gatingRandom() * 0.8;
  const transientAt = Math.floor(gatingRandom() * GATING_FRAMES);
  gatingCases.push({
    label: `music-like #${index}`,
    channels: gatingSignal(GATING_FRAMES, (frame, channel) => {
      const detune = channel === 0 ? 1 : 1.003;
      const envelope =
        0.35 + 0.65 * Math.abs(Math.sin((2 * Math.PI * envelopeHz * frame) / GATING_SAMPLE_RATE));
      const partials =
        Math.sin((2 * Math.PI * root * detune * frame) / GATING_SAMPLE_RATE) +
        0.6 * Math.sin((2 * Math.PI * root * 2 * detune * frame) / GATING_SAMPLE_RATE) +
        0.3 * Math.sin((2 * Math.PI * root * 3.01 * detune * frame) / GATING_SAMPLE_RATE);
      const transient = frame === transientAt ? 0.9 : 0;
      const value = drive * envelope * partials * 0.45 + transient;
      return Math.max(-1, Math.min(1, value));
    }),
  });
}

{
  let mismatches = 0;
  let firstMismatch = "";
  let comparedTimelinePoints = 0;
  for (const gatingCase of gatingCases) {
    const expected = referencePeaks(gatingCase.channels, GATING_STEP_SAMPLES);
    const metrics = analyzeDecodedAsset(
      makeAsset(gatingCase.channels, { sampleRate: GATING_SAMPLE_RATE }),
      null,
    ).metrics;

    /** @param {string} detail */
    const report = (detail) => {
      mismatches += 1;
      if (!firstMismatch) firstMismatch = `${gatingCase.label}: ${detail}`;
    };

    if (metrics.truePeakDbtp !== expected.truePeakDbtp) {
      report(`true peak ${metrics.truePeakDbtp} vs ${expected.truePeakDbtp}`);
    }
    if (metrics.samplePeakDbfs !== expected.samplePeakDbfs) {
      report(`sample peak ${metrics.samplePeakDbfs} vs ${expected.samplePeakDbfs}`);
    }
    if (metrics.timeline.truePeakDbtp.length !== expected.truePeakByStep.length) {
      report(
        `timeline length ${metrics.timeline.truePeakDbtp.length} vs ${expected.truePeakByStep.length}`,
      );
      continue;
    }
    for (let index = 0; index < expected.truePeakByStep.length; index += 1) {
      comparedTimelinePoints += 1;
      // buildTimeline stores the series in a Float32Array, so the reference
      // value is rounded the same way before the comparison.
      if (metrics.timeline.truePeakDbtp[index] !== Math.fround(expected.truePeakByStep[index])) {
        report(
          `timeline[${index}] ${metrics.timeline.truePeakDbtp[index]} vs ${Math.fround(expected.truePeakByStep[index])}`,
        );
      }
    }
  }

  console.log(
    `     ${gatingCases.length} signals, ${comparedTimelinePoints} timeline points, ${mismatches} mismatches`,
  );
  assertOk(
    `gated true peak is bit-identical to the ungated loop over ${gatingCases.length} signals`,
    mismatches === 0,
    firstMismatch,
  );
}
