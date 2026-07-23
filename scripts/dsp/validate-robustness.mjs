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
const {
  analyzeDecodedAsset,
  MIN_SUPPORTED_SAMPLE_RATE,
  MAX_SUPPORTED_SAMPLE_RATE,
  UNSUPPORTED_SAMPLE_RATE_PREFIX,
} = await import("../../src/audio/analysis.ts");
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

// Truncated header: only the 4-byte container id is present, with no room for the
// WAVE signature at offset 8-11. Must throw the parser's normal descriptive
// truncation error, never an uncaught RangeError from the raw DataView read.
for (const container of ["RIFF", "RF64"]) {
  for (let len = 4; len <= 11; len += 1) {
    const buf = new ArrayBuffer(len);
    const v = new DataView(buf);
    container.split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
    expectThrowDescriptive(
      `${container} header truncated to ${len} bytes rejected (no RangeError)`,
      () => parseWavBuffer(buf, "x.wav", "audio/wav"),
      "truncated",
    );
  }
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

// Truncated header: only the 4-byte "FORM" id is present, with no room for the
// FORM type (AIFF/AIFC) at offset 8-11. Must throw the parser's normal descriptive
// truncation error, never an uncaught RangeError from the raw DataView read.
for (let len = 4; len <= 11; len += 1) {
  const buf = new ArrayBuffer(len);
  const v = new DataView(buf);
  "FORM".split("").forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  expectThrowDescriptive(
    `FORM header truncated to ${len} bytes rejected (no RangeError)`,
    () => parseAiffBuffer(buf, "x.aiff", "audio/aiff"),
    "truncated",
  );
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

console.log("\n[F] Analyzer: sample-rate bounds (M-15)");

function assertBool(name, cond, detail) {
  cond ? pass(name, detail) : fail(name, detail);
}
assertBool(`MIN_SUPPORTED_SAMPLE_RATE === 8000 (contract §5)`, MIN_SUPPORTED_SAMPLE_RATE === 8000, `got ${MIN_SUPPORTED_SAMPLE_RATE}`);
assertBool(`MAX_SUPPORTED_SAMPLE_RATE === 384000 (contract §5)`, MAX_SUPPORTED_SAMPLE_RATE === 384000, `got ${MAX_SUPPORTED_SAMPLE_RATE}`);

function analyzeAtRate(rate) {
  const frames = Math.max(1, Math.round(rate * 0.5));
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const v = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate);
    l[i] = v;
    r[i] = v;
  }
  return analyzeDecodedAsset(makeAsset([l, r], rate), null).metrics;
}
function expectRateOk(rate) {
  const name = `${rate} Hz accepted -> finite metrics`;
  try {
    const m = analyzeAtRate(rate);
    if (Number.isFinite(m.integratedLufs) && Number.isFinite(m.truePeakDbtp)) {
      pass(name, `integrated ${m.integratedLufs.toFixed(2)} TP ${m.truePeakDbtp.toFixed(2)}`);
    } else {
      fail(name, `non-finite metrics: integrated ${m.integratedLufs} TP ${m.truePeakDbtp}`);
    }
  } catch (error) {
    fail(name, `unexpected throw: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function expectRateRejected(rate) {
  const name = `${rate} Hz rejected with the exported prefix`;
  try {
    analyzeAtRate(rate);
    fail(name, "did not throw");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith(UNSUPPORTED_SAMPLE_RATE_PREFIX)) {
      pass(name, `threw "${msg.slice(0, 55)}"`);
    } else {
      fail(name, `threw without the exported prefix: "${msg}"`);
    }
  }
}
expectRateRejected(7999); // just below the documented floor
expectRateOk(8000); // floor
expectRateOk(44100);
expectRateOk(48000);
expectRateOk(96000);
expectRateOk(192000);
expectRateOk(384000); // ceiling
expectRateRejected(384001); // just above the documented ceiling

console.log("\n[G] Parsers: fail closed on malformed RF64 / AIFC / truncated chunks (M-10, M-13, NEW-1)");

function putAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
function putFloat80(view, offset, value) {
  const exponent = Math.floor(Math.log2(value));
  const mantissa = value / 2 ** exponent;
  view.setUint16(offset, 16383 + exponent, false);
  view.setUint32(offset + 2, Math.floor(mantissa * 2 ** 31), false);
  view.setUint32(offset + 6, 0, false);
}
// Assert fn throws a descriptive Error that is NOT a raw RangeError (NEW-1: no
// DataView out-of-bounds error may escape the parser). RangeError extends Error,
// so the existing `instanceof Error` check alone would not catch it.
function expectThrowDescriptive(name, fn, mustInclude) {
  try {
    fn();
    fail(name, "did not throw");
  } catch (error) {
    if (!(error instanceof Error)) {
      fail(name, `threw a non-Error value: ${String(error)}`);
      return;
    }
    if (error.constructor && error.constructor.name === "RangeError") {
      fail(name, `threw a raw RangeError: "${error.message}"`);
      return;
    }
    if (mustInclude && !error.message.includes(mustInclude)) {
      fail(name, `message "${error.message.slice(0, 60)}" did not mention "${mustInclude}"`);
      return;
    }
    pass(name, `threw "${error.message.slice(0, 50)}"`);
  }
}

// ---- RF64 / ds64 fixtures (M-10) ----
// RF64 with a 0xFFFFFFFF sentinel data size and NO ds64 chunk, then trailing JUNK
// (the audit's exact M-10 repro: two real PCM samples were decoded as eight frames).
function buildRf64NoDs64Sentinel() {
  const dataBytes = 2 * 2; // 2 frames, mono, 16-bit
  const junkBytes = 6;
  const buffer = new ArrayBuffer(12 + 8 + 16 + 8 + dataBytes + 8 + junkBytes);
  const view = new DataView(buffer);
  putAscii(view, 0, "RF64");
  view.setUint32(4, 0xffffffff, true);
  putAscii(view, 8, "WAVE");
  putAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 48000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  putAscii(view, 36, "data");
  view.setUint32(40, 0xffffffff, true); // sentinel, unresolved (no ds64)
  view.setInt16(44, 1000, true);
  view.setInt16(46, -1000, true);
  putAscii(view, 48, "JUNK");
  view.setUint32(52, junkBytes, true);
  return buffer;
}
// Valid RF64: ds64 precedes fmt/data; data uses the 0xFFFFFFFF sentinel resolved by ds64.
function buildValidRf64(frames = 10, sampleRate = 48000, channelCount = 2) {
  const blockAlign = channelCount * 2;
  const dataBytes = frames * blockAlign;
  const ds64Payload = 28;
  const buffer = new ArrayBuffer(12 + 8 + ds64Payload + 8 + 16 + 8 + dataBytes);
  const view = new DataView(buffer);
  putAscii(view, 0, "RF64");
  view.setUint32(4, 0xffffffff, true);
  putAscii(view, 8, "WAVE");
  let offset = 12;
  putAscii(view, offset, "ds64");
  view.setUint32(offset + 4, ds64Payload, true);
  const ds64 = offset + 8;
  view.setUint32(ds64, buffer.byteLength - 8, true); // riffSize low
  view.setUint32(ds64 + 4, 0, true);
  view.setUint32(ds64 + 8, dataBytes, true); // dataSize low
  view.setUint32(ds64 + 12, 0, true);
  view.setUint32(ds64 + 16, frames, true); // sampleCount low
  view.setUint32(ds64 + 20, 0, true);
  view.setUint32(ds64 + 24, 0, true); // tableLength
  offset += 8 + ds64Payload;
  putAscii(view, offset, "fmt ");
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, 1, true);
  view.setUint16(offset + 10, channelCount, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * blockAlign, true);
  view.setUint16(offset + 20, blockAlign, true);
  view.setUint16(offset + 22, 16, true);
  offset += 8 + 16;
  putAscii(view, offset, "data");
  view.setUint32(offset + 4, 0xffffffff, true); // sentinel, resolved via ds64
  offset += 8;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      view.setInt16(offset, (frame * 100 + ch) % 30000, true);
      offset += 2;
    }
  }
  return buffer;
}
// ds64 present but its declared payload runs past the end of the buffer.
function buildRf64TruncatedDs64() {
  const buffer = new ArrayBuffer(12 + 8 + 10); // ds64 header claims 28 bytes; only 10 present
  const view = new DataView(buffer);
  putAscii(view, 0, "RF64");
  view.setUint32(4, 0xffffffff, true);
  putAscii(view, 8, "WAVE");
  putAscii(view, 12, "ds64");
  view.setUint32(16, 28, true);
  return buffer;
}
// ds64 appears AFTER data (invalid ordering: RF64 requires ds64 first).
function buildRf64Ds64AfterData() {
  const dataBytes = 2 * 2;
  const ds64Payload = 28;
  const buffer = new ArrayBuffer(12 + 8 + 16 + 8 + dataBytes + 8 + ds64Payload);
  const view = new DataView(buffer);
  putAscii(view, 0, "RF64");
  view.setUint32(4, 0xffffffff, true);
  putAscii(view, 8, "WAVE");
  let offset = 12;
  putAscii(view, offset, "fmt ");
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, 1, true);
  view.setUint16(offset + 10, 1, true);
  view.setUint32(offset + 12, 48000, true);
  view.setUint32(offset + 16, 96000, true);
  view.setUint16(offset + 20, 2, true);
  view.setUint16(offset + 22, 16, true);
  offset += 8 + 16;
  putAscii(view, offset, "data");
  view.setUint32(offset + 4, 0xffffffff, true); // sentinel, ds64 not seen yet
  offset += 8 + dataBytes;
  putAscii(view, offset, "ds64");
  view.setUint32(offset + 4, ds64Payload, true);
  return buffer;
}
// ds64 present and valid, but it resolves a data size (400 bytes) far larger than
// the bytes physically present (4). Must FAIL CLOSED (M-10) — the ds64 64-bit size
// is authoritative, so clamping would fabricate audio from truncated data.
function buildRf64Ds64OversizedData() {
  const physicalDataBytes = 4; // 2 frames, mono, 16-bit
  const declaredDataSize = 400; // ds64 lies: claims 400 bytes
  const ds64Payload = 28;
  const buffer = new ArrayBuffer(12 + 8 + ds64Payload + 8 + 16 + 8 + physicalDataBytes);
  const view = new DataView(buffer);
  putAscii(view, 0, "RF64");
  view.setUint32(4, 0xffffffff, true);
  putAscii(view, 8, "WAVE");
  let offset = 12;
  putAscii(view, offset, "ds64");
  view.setUint32(offset + 4, ds64Payload, true);
  const ds64 = offset + 8;
  view.setUint32(ds64, buffer.byteLength - 8, true); // riffSize low
  view.setUint32(ds64 + 4, 0, true);
  view.setUint32(ds64 + 8, declaredDataSize, true); // dataSize low = 400 (the lie)
  view.setUint32(ds64 + 12, 0, true);
  view.setUint32(ds64 + 16, 200, true); // sampleCount low
  view.setUint32(ds64 + 20, 0, true);
  view.setUint32(ds64 + 24, 0, true); // tableLength
  offset += 8 + ds64Payload;
  putAscii(view, offset, "fmt ");
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, 1, true); // PCM
  view.setUint16(offset + 10, 1, true); // mono
  view.setUint32(offset + 12, 48000, true);
  view.setUint32(offset + 16, 96000, true);
  view.setUint16(offset + 20, 2, true);
  view.setUint16(offset + 22, 16, true);
  offset += 8 + 16;
  putAscii(view, offset, "data");
  view.setUint32(offset + 4, 0xffffffff, true); // sentinel, resolved to 400 via ds64
  offset += 8;
  view.setInt16(offset, 1000, true);
  view.setInt16(offset + 2, -1000, true);
  return buffer;
}

expectThrowDescriptive("RF64 sentinel data size with no ds64 rejected (M-10 repro)", () =>
  parseWavBuffer(buildRf64NoDs64Sentinel(), "x.rf64", "audio/wav"));
// The old bug produced eight fabricated frames from two real samples + JUNK. Prove it can no longer parse at all.
{
  let fabricated = null;
  try {
    fabricated = parseWavBuffer(buildRf64NoDs64Sentinel(), "x.rf64", "audio/wav").frameCount;
  } catch {
    // expected
  }
  assertBool("RF64-no-ds64 no longer fabricates frames from JUNK", fabricated === null, fabricated === null ? "" : `parsed frameCount=${fabricated}`);
}
expectThrowDescriptive("RF64 with truncated ds64 rejected", () =>
  parseWavBuffer(buildRf64TruncatedDs64(), "x.rf64", "audio/wav"), "ds64");
expectThrowDescriptive("RF64 with ds64 after data rejected (ordering)", () =>
  parseWavBuffer(buildRf64Ds64AfterData(), "x.rf64", "audio/wav"));
expectThrowDescriptive("RF64 ds64 declaring more data than physically present rejected (M-10: no clamp)", () =>
  parseWavBuffer(buildRf64Ds64OversizedData(), "x.rf64", "audio/wav"), "physically present");
// Prove it fails closed instead of clamping the 400-byte claim down to 4 real bytes
// (which the pre-fix code decoded as two fabricated frames).
{
  let fabricated = null;
  try {
    fabricated = parseWavBuffer(buildRf64Ds64OversizedData(), "x.rf64", "audio/wav").frameCount;
  } catch {
    // expected
  }
  assertBool("RF64 oversized-ds64 no longer fabricates frames from truncated data", fabricated === null, fabricated === null ? "" : `parsed frameCount=${fabricated}`);
}
expectOk(
  "valid RF64 with proper ds64 parses to the correct frame count",
  () => parseWavBuffer(buildValidRf64(10, 48000, 2), "x.rf64", "audio/wav"),
  (asset) => asset.frameCount === 10 && asset.channels.length === 2 && asset.channels[0].every((v) => Number.isFinite(v)),
);

// ---- AIFC FVER + extended COMM + truncated chunk fixtures (M-13, NEW-1) ----
// For AIFC, an FVER chunk (declaring the AIFF-C Version 1 timestamp) is written
// automatically unless includeFver is set false. The extended COMM is written as
// the 18 fixed bytes + a 4-byte compression type + a compression-name Pascal string
// (1 count byte + the name). overrideNameCount forges a bad count byte for the
// bounds tests; commSizeDeclared / commDataBytes let a caller declare or physically
// write a different amount than the well-formed length.
function buildAiffFixture({
  formType = "AIFF",
  commSizeDeclared,
  commDataBytes,
  compressionType = null,
  compressionName = "",
  overrideNameCount = null,
  includeFver,
  fverVersion = 0xa2805140,
  sampleRate = 44100,
  channelCount = 2,
  frames = 10,
  bitsPerSample = 16,
} = {}) {
  const wantFver = includeFver ?? formType === "AIFC";
  const wellFormedComm = formType === "AIFC" ? 18 + 4 + 1 + compressionName.length : 18;
  const physicalComm = commDataBytes ?? wellFormedComm;
  const declaredComm = commSizeDeclared ?? physicalComm;

  const ssndAudio = frames * channelCount * (bitsPerSample / 8);
  const fverChunkBytes = wantFver ? 12 : 0; // "FVER"(4) + size(4) + version(4)
  // AIFF chunks are word-aligned: an odd-sized chunk is followed by a pad byte (not
  // counted in ckSize), so the next chunk starts on an even boundary. The parser
  // advances by chunkSize + (chunkSize % 2), so mirror that here or SSND is missed.
  const commPad = physicalComm % 2;
  const total = 12 + fverChunkBytes + 8 + physicalComm + commPad + 8 + 8 + ssndAudio;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  putAscii(view, 0, "FORM");
  view.setUint32(4, total - 8, false);
  putAscii(view, 8, formType);

  let offset = 12;
  if (wantFver) {
    putAscii(view, offset, "FVER");
    view.setUint32(offset + 4, 4, false);
    view.setUint32(offset + 8, fverVersion >>> 0, false);
    offset += 12;
  }

  const commOffset = offset;
  putAscii(view, commOffset, "COMM");
  view.setUint32(commOffset + 4, declaredComm, false);
  const commData = commOffset + 8;
  if (physicalComm >= 2) view.setUint16(commData, channelCount, false);
  if (physicalComm >= 6) view.setUint32(commData + 2, frames, false);
  if (physicalComm >= 8) view.setUint16(commData + 6, bitsPerSample, false);
  if (physicalComm >= 18) putFloat80(view, commData + 8, sampleRate);
  if (formType === "AIFC" && compressionType && physicalComm >= 22) putAscii(view, commData + 18, compressionType);
  if (formType === "AIFC" && physicalComm >= 23) {
    view.setUint8(commData + 22, (overrideNameCount ?? compressionName.length) & 0xff);
    for (let i = 0; i < compressionName.length && commData + 23 + i < buffer.byteLength; i += 1) {
      view.setUint8(commData + 23 + i, compressionName.charCodeAt(i));
    }
  }
  offset = commData + physicalComm + commPad;

  const ssndOffset = offset;
  putAscii(view, ssndOffset, "SSND");
  view.setUint32(ssndOffset + 4, 8 + ssndAudio, false);
  view.setUint32(ssndOffset + 8, 0, false);
  view.setUint32(ssndOffset + 12, 0, false);
  let audioOffset = ssndOffset + 16;
  for (let i = 0; audioOffset + 2 <= buffer.byteLength && i < frames * channelCount; i += 1) {
    view.setInt16(audioOffset, (i * 137) % 30000, false);
    audioOffset += 2;
  }
  return buffer;
}
// AIFC where COMM is the final chunk and the physical buffer ends before its
// declared compression-name pstring: the count byte fits inside the declared COMM,
// but the pstring bytes run past end-of-buffer. SSND precedes COMM so both required
// chunks are still discovered. Exercises the buffer-bound guard (NEW-1: descriptive
// Error, never a raw DataView RangeError).
function buildAiffcCommPastBuffer() {
  const ssndAudio = 4; // 1 frame, stereo, 16-bit
  const commDeclared = 100; // header claims a large extended COMM...
  const commPhysical = 24; // ...but only 24 bytes physically follow
  const total = 12 + 12 + (16 + ssndAudio) + 8 + commPhysical;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  putAscii(view, 0, "FORM");
  view.setUint32(4, total - 8, false);
  putAscii(view, 8, "AIFC");
  let o = 12;
  putAscii(view, o, "FVER");
  view.setUint32(o + 4, 4, false);
  view.setUint32(o + 8, 0xa2805140, false);
  o += 12;
  putAscii(view, o, "SSND");
  view.setUint32(o + 4, 8 + ssndAudio, false);
  view.setUint32(o + 8, 0, false);
  view.setUint32(o + 12, 0, false);
  view.setInt16(o + 16, 1000, false);
  view.setInt16(o + 18, -1000, false);
  o += 16 + ssndAudio;
  putAscii(view, o, "COMM");
  view.setUint32(o + 4, commDeclared, false);
  const commData = o + 8;
  view.setUint16(commData, 2, false); // channels
  view.setUint32(commData + 2, 1, false); // frames
  view.setUint16(commData + 6, 16, false); // bits
  putFloat80(view, commData + 8, 44100);
  putAscii(view, commData + 18, "NONE");
  view.setUint8(commData + 22, 60); // count 60 fits in declared 100 but not the 24 physical bytes
  return buffer;
}
// AIFF whose final SSND chunk header fits but the declared data runs past EOF.
function buildAiffTruncatedSsnd(ssndDataBytes) {
  const total = 12 + 8 + 18 + 8 + ssndDataBytes;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  putAscii(view, 0, "FORM");
  view.setUint32(4, total - 8, false);
  putAscii(view, 8, "AIFF");
  putAscii(view, 12, "COMM");
  view.setUint32(16, 18, false);
  view.setUint16(20, 2, false);
  view.setUint32(22, 100, false);
  view.setUint16(26, 16, false);
  putFloat80(view, 28, 44100);
  putAscii(view, 38, "SSND");
  view.setUint32(42, 8 + 100 * 2 * 2, false); // declares far more than the buffer holds
  return buffer;
}

// Missing FVER: mandatory for AIFC (M-13) -> reject.
expectThrowDescriptive("AIFC without FVER rejected (M-13: mandatory version chunk)", () =>
  parseAiffBuffer(buildAiffFixture({ formType: "AIFC", compressionType: "NONE", compressionName: "not compressed", includeFver: false }), "x.aifc", "audio/aiff"), "FVER");
// FVER present but wrong version timestamp -> reject.
expectThrowDescriptive("AIFC with wrong FVER version rejected", () =>
  parseAiffBuffer(buildAiffFixture({ formType: "AIFC", compressionType: "NONE", compressionName: "x", fverVersion: 0x12345678 }), "x.aifc", "audio/aiff"), "FVER");
// 18-byte COMM (no compression fields at all) -> reject, never silent PCM.
expectThrowDescriptive("AIFC with 18-byte COMM rejected (M-13: not silent PCM)", () =>
  parseAiffBuffer(buildAiffFixture({ formType: "AIFC", commSizeDeclared: 18, commDataBytes: 18 }), "x.aifc", "audio/aiff"));
{
  let decodedAsPcm = false;
  try {
    parseAiffBuffer(buildAiffFixture({ formType: "AIFC", commSizeDeclared: 18, commDataBytes: 18 }), "x.aifc", "audio/aiff");
    decodedAsPcm = true;
  } catch {
    // expected
  }
  assertBool("AIFC 18-byte COMM no longer silently decodes as PCM", !decodedAsPcm, decodedAsPcm ? "parsed instead of rejecting" : "");
}
// 22-byte COMM: has the 4-byte compression type but NO compression-name count byte -> reject (< 23).
expectThrowDescriptive("AIFC with 22-byte COMM (no compression-name count byte) rejected (M-13)", () =>
  parseAiffBuffer(buildAiffFixture({ formType: "AIFC", commSizeDeclared: 22, commDataBytes: 22, compressionType: "NONE" }), "x.aifc", "audio/aiff"));
// COMM declares room for the count byte (23) but fewer physical bytes exist -> reject.
for (const commDataBytes of [19, 20, 21, 22]) {
  expectThrowDescriptive(`AIFC declaring commSize=23 but only ${commDataBytes} physical bytes rejected`, () =>
    parseAiffBuffer(
      buildAiffFixture({ formType: "AIFC", commSizeDeclared: 23, commDataBytes, compressionType: "NONE" }),
      "x.aifc",
      "audio/aiff",
    ));
}
// Compression-name pstring count byte claims more characters than the COMM chunk holds -> reject.
expectThrowDescriptive("AIFC compression-name pstring overrunning the COMM chunk rejected (M-13)", () =>
  parseAiffBuffer(buildAiffFixture({ formType: "AIFC", compressionType: "NONE", compressionName: "abc", overrideNameCount: 200 }), "x.aifc", "audio/aiff"), "compression-name");
// Compression-name pstring runs past the end of the buffer -> reject (NEW-1: Error, not RangeError).
expectThrowDescriptive("AIFC compression-name pstring overrunning the buffer rejected (NEW-1)", () =>
  parseAiffBuffer(buildAiffcCommPastBuffer(), "x.aifc", "audio/aiff"), "compression-name");
// Complete AIFC (FVER + type + pstring name) parses.
expectOk(
  "AIFC with FVER + complete COMM (NONE + name) parses",
  () => parseAiffBuffer(buildAiffFixture({ formType: "AIFC", compressionType: "NONE", compressionName: "not compressed" }), "x.aifc", "audio/aiff"),
  (asset) => asset.frameCount > 0 && asset.channels[0].every((v) => Number.isFinite(v)),
);
// Complete AIFC (FVER + type + empty pstring name) parses.
expectOk(
  "AIFC with FVER + complete COMM (sowt, empty name) parses",
  () => parseAiffBuffer(buildAiffFixture({ formType: "AIFC", compressionType: "sowt", compressionName: "" }), "x.aifc", "audio/aiff"),
  (asset) => asset.frameCount > 0,
);
// Plain AIFF is unchanged: 18-byte COMM, no FVER, still parses.
expectOk(
  "plain AIFF with 18-byte COMM still parses (unchanged)",
  () => parseAiffBuffer(buildAiffFixture({ formType: "AIFF", commSizeDeclared: 18, commDataBytes: 18 }), "x.aiff", "audio/aiff"),
  (asset) => asset.frameCount > 0,
);
for (const n of [0, 1, 2, 3]) {
  expectThrowDescriptive(`AIFF final SSND truncated to ${n} bytes rejected (NEW-1: Error, not RangeError)`, () =>
    parseAiffBuffer(buildAiffTruncatedSsnd(n), "x.aiff", "audio/aiff"), "SSND");
}

console.log("\n[H] AIFC unbounded-scan DoS: parseAiffBuffer bounds its chunk walk (finding [0])");
// An AIFC with COMM+SSND discovered early but NO FVER and a large padded tail of
// size-0 chunks must NOT scan to EOF. parseAiffBuffer caps its chunk walk at 100k
// iterations exactly like inspectAiff, so the flood is rejected as "missing FVER"
// cheaply instead of freezing the synchronous, budget-immune decoder lane for
// seconds. (COMM contents need only be recognized: for AIFC the parser throws
// "missing FVER" before it ever validates COMM.)
function writeAifcFloodHeader(view) {
  putAscii(view, 0, "FORM");
  view.setUint32(4, view.byteLength - 8, false);
  putAscii(view, 8, "AIFC");
  putAscii(view, 12, "COMM");
  view.setUint32(16, 18, false);
  view.setUint16(20, 2, false); // channels
  view.setUint32(22, 1000, false); // frames
  view.setUint16(26, 16, false); // bits per sample
  putFloat80(view, 28, 44100);
  putAscii(view, 38, "SSND");
  view.setUint32(42, 8, false); // declared size 8 = offset+blockSize header, no audio
  view.setUint32(46, 0, false); // data offset
  view.setUint32(50, 0, false); // block size
  // The next chunk begins at offset 54; the rest of the (zeroed) buffer forms
  // size-0 chunks — id "\0\0\0\0", size 0 — that a walk marches through 8 bytes at a time.
}
function buildAifcFloodNoFver(totalBytes) {
  const buffer = new ArrayBuffer(totalBytes);
  writeAifcFloodHeader(new DataView(buffer));
  return buffer;
}
function buildAifcFloodFverBeyondCap(zeroChunksBeforeFver = 120_000) {
  // COMM(chunk 1) + SSND(chunk 2) + zeroChunksBeforeFver zero chunks, then a VALID
  // FVER at chunk (zeroChunksBeforeFver + 3) — comfortably past the 100k cap.
  const fverAt = 54 + zeroChunksBeforeFver * 8;
  const buffer = new ArrayBuffer(fverAt + 12);
  const view = new DataView(buffer);
  writeAifcFloodHeader(view);
  putAscii(view, fverAt, "FVER");
  view.setUint32(fverAt + 4, 4, false);
  view.setUint32(fverAt + 8, 0xa2805140, false); // AIFF-C Version 1 timestamp (valid)
  return buffer;
}

// Timing guard (the acceptance repro): a 256 MiB in-budget flood must be rejected in
// well under a second. Pre-cap this walked ~33.5M chunks — a multi-hundred-ms to
// multi-second synchronous freeze; the cap stops after 100k regardless of file size.
// The buffer is built OUTSIDE the timed region so only the parse is measured.
const aifcFloodBuffer = buildAifcFloodNoFver(256 * 1024 * 1024);
expectFast(
  "256 MiB AIFC flood (COMM+SSND early, no FVER, padded tail) rejected fast",
  () => parseAiffBuffer(aifcFloodBuffer, "flood.aifc", "audio/aiff"),
  750,
);
// The flood is still rejected for the RIGHT reason, not silently parsed.
expectThrowDescriptive(
  "AIFC flood with no FVER rejected as missing FVER",
  () => parseAiffBuffer(buildAifcFloodNoFver(2 * 1024 * 1024), "flood.aifc", "audio/aiff"),
  "FVER",
);
// Deterministic cap proof (no wall-clock reliance): a valid FVER hidden beyond the
// 100k cap must NOT be found, so the file is rejected as missing FVER. An unbounded
// walk would instead find the far FVER and throw a different, non-FVER error — so
// this assertion fails the moment the cap is removed.
expectThrowDescriptive(
  "AIFC hiding a valid FVER beyond the 100k chunk cap is rejected as missing FVER",
  () => parseAiffBuffer(buildAifcFloodFverBeyondCap(), "flood.aifc", "audio/aiff"),
  "FVER",
);
// Regression guard for the cap NOT breaking legitimate files: a well-formed AIFC
// (FVER within the first handful of chunks) still parses.
expectOk(
  "well-formed AIFC still parses under the chunk cap",
  () => parseAiffBuffer(buildAiffFixture({ formType: "AIFC", compressionType: "NONE", compressionName: "not compressed" }), "ok.aifc", "audio/aiff"),
  (asset) => asset.frameCount > 0 && asset.channels[0].every((v) => Number.isFinite(v)),
);

console.log(`\n==== Robustness: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
