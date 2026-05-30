// Adversarial-input / robustness validation for the TruePeak decode + analysis path.
// Feeds garbage, truncated, degenerate, and hostile buffers to the real parser and
// analyzer and asserts each one fails CLEANLY: it must either throw a sane Error or
// return finite output — never hang, never return NaN/garbage.
//
// Run: node scripts/dsp/validate-robustness.mjs
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const { parseAiffBuffer } = await import("../../src/audio/aiff.ts");
const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const { deriveChannelLayout } = await import("../../src/audio/channel-layout.ts");

let passed = 0;
let failed = 0;

function pass(name, detail = "") {
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  passed += 1;
}
function fail(name, detail = "") {
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  failed += 1;
}

// Assert fn throws (any Error). Also bounds runtime so an infinite loop shows as a
// failure of the surrounding process timeout rather than a silent hang.
function expectThrow(name, fn) {
  const start = performance.now();
  try {
    fn();
    fail(name, "did not throw");
  } catch (error) {
    const ms = performance.now() - start;
    if (error instanceof Error) {
      pass(name, `threw "${error.message.slice(0, 70)}" in ${ms.toFixed(0)}ms`);
    } else {
      fail(name, `threw a non-Error value: ${String(error)}`);
    }
  }
}

// Assert fn returns and the result passes a validator (no throw, sane output).
function expectOk(name, fn, validate) {
  const start = performance.now();
  try {
    const result = fn();
    const ms = performance.now() - start;
    const verdict = validate ? validate(result) : true;
    if (verdict === true) {
      pass(name, `${ms.toFixed(0)}ms`);
    } else {
      fail(name, typeof verdict === "string" ? verdict : "validator rejected result");
    }
  } catch (error) {
    fail(name, `unexpected throw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expectFast(name, fn, maxMs) {
  const start = performance.now();
  let threw = null;
  try {
    fn();
  } catch (error) {
    threw = error;
  }
  const ms = performance.now() - start;
  if (ms <= maxMs) {
    pass(name, `${ms.toFixed(0)}ms ≤ ${maxMs}ms${threw ? ` (threw "${threw.message.slice(0, 40)}", fine)` : ""}`);
  } else {
    fail(name, `took ${ms.toFixed(0)}ms (> ${maxMs}ms) — possible pathological scaling`);
  }
}

// ---- WAV encoder knobs (lets us craft hostile headers) ----
function encodeWav({ channels, sampleRate, formatTag = 3, bitsPerSample = 32, declaredChannels, declaredDataBytes }) {
  const channelCount = channels.length;
  const writtenChannels = declaredChannels ?? channelCount;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = writtenChannels * bytesPerSample;
  const frameCount = channels[0]?.length ?? 0;
  const realDataBytes = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + realDataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + realDataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, writtenChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, declaredDataBytes ?? realDataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      if (bitsPerSample === 32 && formatTag === 3) view.setFloat32(offset, channels[ch][frame], true);
      else if (bitsPerSample === 16) view.setInt16(offset, Math.round(channels[ch][frame] * 32767), true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}

function tone(frameCount, amp = 0.5, channels = 2) {
  const data = Array.from({ length: channels }, () => new Float32Array(frameCount));
  for (let n = 0; n < frameCount; n += 1) {
    const v = amp * Math.sin((2 * Math.PI * 1000 * n) / 48000);
    for (let ch = 0; ch < channels; ch += 1) data[ch][n] = v;
  }
  return data;
}

function makeAsset(channels, sampleRate = 48000) {
  const channelCount = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  return {
    fileName: "adversarial.bin",
    mimeType: "application/octet-stream",
    sourceFormat: "wav",
    sampleRate,
    bitDepth: 32,
    durationSeconds: sampleRate > 0 ? frameCount / sampleRate : 0,
    frameCount,
    channelCount,
    channelLayout: deriveChannelLayout(channelCount, null),
    decoderMode: "native-parser",
    decoderLabel: "test",
    decoderSummary: "test",
    decodeNotes: [],
    warnings: [],
    channels,
  };
}

function metricsAreSane(result) {
  const m = result.metrics;
  const finiteFields = ["integratedLufs", "ungatedLufs", "loudnessRange", "samplePeakDbfs", "truePeakDbtp"];
  for (const field of finiteFields) {
    if (!Number.isFinite(m[field])) return `${field} is not finite: ${m[field]}`;
  }
  const nullableFields = ["maxMomentaryLufs", "maxShortTermLufs", "unclampedTargetDeltaDb", "targetDeltaDb", "projectedTruePeakDbtp"];
  for (const field of nullableFields) {
    if (m[field] != null && !Number.isFinite(m[field])) return `${field} is neither null nor finite: ${m[field]}`;
  }
  for (const arr of [m.timeline.momentaryLufs, m.timeline.shortTermLufs]) {
    if (arr.some((v) => v != null && !Number.isFinite(v))) return "timeline contains NaN/Infinity";
  }
  if (m.timeline.truePeakDbtp.some((v) => !Number.isFinite(v))) return "timeline true peak contains NaN/Infinity";
  return true;
}

console.log("\n[A] Parser: hostile / malformed WAV headers");

// random non-audio bytes (a .txt renamed to .wav, etc.)
const randomBytes = new ArrayBuffer(2048);
{
  const u8 = new Uint8Array(randomBytes);
  for (let i = 0; i < u8.length; i += 1) u8[i] = (i * 73 + 17) & 0xff;
}
expectThrow("random bytes rejected (not RIFF/RF64)", () => parseWavBuffer(randomBytes, "x.wav", "audio/wav"));

// RIFF but not WAVE
{
  const buf = encodeWav({ channels: tone(10), sampleRate: 48000 });
  new DataView(buf).setUint8(8, "X".charCodeAt(0)); // corrupt "WAVE" -> "XAVE"
  expectThrow("RIFF with bad WAVE signature rejected", () => parseWavBuffer(buf, "x.wav", "audio/wav"));
}

// no fmt/data chunks (just the 12-byte RIFF/WAVE header)
{
  const buf = new ArrayBuffer(12);
  const v = new DataView(buf);
  "RIFF".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  "WAVE".split("").forEach((c, i) => v.setUint8(8 + i, c.charCodeAt(0)));
  expectThrow("RIFF/WAVE with no chunks rejected", () => parseWavBuffer(buf, "x.wav", "audio/wav"));
}

// channelCount = 0
expectThrow("WAV with 0 channels rejected", () =>
  parseWavBuffer(encodeWav({ channels: tone(10), sampleRate: 48000, declaredChannels: 0 }), "x.wav", "audio/wav"));

// sampleRate = 0
expectThrow("WAV with 0 sample rate rejected", () =>
  parseWavBuffer(encodeWav({ channels: tone(10), sampleRate: 0 }), "x.wav", "audio/wav"));

// unsupported format tag (0x0055 = MPEG layer 3 in WAV)
expectThrow("WAV with unsupported format tag rejected", () =>
  parseWavBuffer(encodeWav({ channels: tone(10), sampleRate: 48000, formatTag: 0x0055 }), "x.wav", "audio/wav"));

// truncated data chunk: header claims 10x more data than the file actually holds.
// Best-effort decoders should CLAMP to the available bytes and still decode, not crash.
expectOk(
  "truncated data chunk clamps to available frames",
  () => parseWavBuffer(
    encodeWav({ channels: tone(2400), sampleRate: 48000, declaredDataBytes: 2400 * 2 * 4 * 10 }),
    "x.wav",
    "audio/wav",
  ),
  (asset) => asset.frameCount > 0 && asset.frameCount <= 2400 && asset.channels[0].every((v) => Number.isFinite(v)),
);

// hostile channel count (claims 60000 channels) with a tiny data chunk: must not hang
// or allocate insanely; frameCount resolves to 0 -> clean throw.
expectFast(
  "absurd channel count (60000) returns fast without hang",
  () => parseWavBuffer(encodeWav({ channels: tone(4), sampleRate: 48000, declaredChannels: 60000 }), "x.wav", "audio/wav"),
  2000,
);

// 16-bit PCM still parses
expectOk(
  "16-bit PCM WAV decodes",
  () => parseWavBuffer(encodeWav({ channels: tone(4800), sampleRate: 48000, formatTag: 1, bitsPerSample: 16 }), "x.wav", "audio/wav"),
  (asset) => asset.frameCount === 4800 && asset.channels[0].every((v) => Number.isFinite(v)),
);

console.log("\n[B] Parser: hostile AIFF");
expectThrow("random bytes rejected by AIFF parser", () => parseAiffBuffer(randomBytes, "x.aiff", "audio/aiff"));
{
  // "FORM????XXXX" — FORM container but not an AIFF/AIFC form type
  const buf = new ArrayBuffer(64);
  const v = new DataView(buf);
  "FORM".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  "JUNK".split("").forEach((c, i) => v.setUint8(8 + i, c.charCodeAt(0)));
  expectThrow("FORM with non-AIFF type rejected", () => parseAiffBuffer(buf, "x.aiff", "audio/aiff"));
}

console.log("\n[C] Analyzer: degenerate decoded assets");

expectThrow("sample rate 0 rejected", () => analyzeDecodedAsset(makeAsset(tone(100), 0), null));
expectThrow("sample rate NaN rejected", () => analyzeDecodedAsset(makeAsset(tone(100), Number.NaN), null));
expectThrow("sample rate Infinity rejected", () => analyzeDecodedAsset(makeAsset(tone(100), Infinity), null));
expectThrow("empty channel list rejected", () => analyzeDecodedAsset(makeAsset([], 48000), null));
expectThrow("zero-length channel rejected", () => analyzeDecodedAsset(makeAsset([new Float32Array(0)], 48000), null));

expectThrow("NaN sample rejected", () => {
  const ch = new Float32Array(48000).fill(0.1);
  ch[2000] = Number.NaN;
  analyzeDecodedAsset(makeAsset([ch, ch.slice()], 48000), null);
});
expectThrow("Infinity sample rejected", () => {
  const ch = new Float32Array(48000).fill(0.1);
  ch[2000] = Infinity;
  analyzeDecodedAsset(makeAsset([ch, ch.slice()], 48000), null);
});
expectThrow("mismatched channel lengths rejected (no garbage output)", () => {
  analyzeDecodedAsset(makeAsset([new Float32Array(48000).fill(0.1), new Float32Array(10).fill(0.1)], 48000), null);
});

console.log("\n[D] Analyzer: valid-but-extreme inputs produce finite output (no crash, no NaN)");

expectOk("single sample", () => analyzeDecodedAsset(makeAsset([new Float32Array([0.5]), new Float32Array([0.5])], 48000), null), metricsAreSane);
expectOk("sub-window clip (100 frames < one 100ms step)", () => analyzeDecodedAsset(makeAsset(tone(100), 48000), null), metricsAreSane);
expectOk("clipping samples (amp 4.0, way over full scale)", () => analyzeDecodedAsset(makeAsset(tone(48000, 4.0), 48000), null), metricsAreSane);
expectOk("digital silence", () => analyzeDecodedAsset(makeAsset([new Float32Array(48000), new Float32Array(48000)], 48000), null), metricsAreSane);
expectOk("8 kHz low sample rate", () => analyzeDecodedAsset(makeAsset(tone(16000, 0.5), 8000), null), metricsAreSane);
expectOk("192 kHz high sample rate", () => analyzeDecodedAsset(makeAsset(tone(192000, 0.5), 192000), null), metricsAreSane);
expectOk("mono", () => analyzeDecodedAsset(makeAsset(tone(48000, 0.5, 1), 48000), null), metricsAreSane);
expectOk("8-channel", () => analyzeDecodedAsset(makeAsset(tone(48000, 0.5, 8), 48000), null), metricsAreSane);

console.log("\n[E] Performance: large input scales linearly (proxy for very-long-file pressure)");
// 60 s stereo @ 48k = 2.88M frames/channel. Confirms the O(n) analyzer doesn't blow up.
expectFast(
  "60s stereo @ 48k analyzes without pathological slowdown",
  () => analyzeDecodedAsset(makeAsset(tone(48000 * 60), 48000), null),
  20000,
);

console.log(`\n==== Robustness: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
