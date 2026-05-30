// Reference-signal validation for the TruePeak DSP engine.
// Generates known WAV signals, runs the real parser + analyzer, and checks the
// measured loudness / true-peak / LRA against values we can derive analytically.
//
// Run: node scripts/dsp/validate-dsp.mjs
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");

// ---- tiny float32 WAV encoder (IEEE float, interleaved) ----
function encodeWavFloat32(channels, sampleRate) {
  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const bytesPerSample = 4;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      view.setFloat32(offset, channels[ch][frame], true);
      offset += 4;
    }
  }
  return buffer;
}

function sine({ freq, amp, seconds, sampleRate = 48000, channels = 2, phase = 0 }) {
  const frameCount = Math.round(seconds * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(frameCount));
  for (let n = 0; n < frameCount; n += 1) {
    const value = amp * Math.sin((2 * Math.PI * freq * n) / sampleRate + phase);
    for (let ch = 0; ch < channels; ch += 1) data[ch][n] = value;
  }
  return data;
}

function analyzeChannels(channels, sampleRate = 48000) {
  const wav = encodeWavFloat32(channels, sampleRate);
  const asset = parseWavBuffer(wav, "test.wav", "audio/wav");
  return analyzeDecodedAsset(asset, null).metrics;
}

// ---- assertions ----
let passed = 0;
let failed = 0;
function check(name, actual, expected, tol) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}: got ${actual.toFixed(3)}, expected ${expected.toFixed(3)} ±${tol}`,
  );
  ok ? (passed += 1) : (failed += 1);
}
function checkCmp(name, actual, op, bound) {
  const ops = { ">": actual > bound, "<": actual < bound, ">=": actual >= bound, "<=": actual <= bound };
  const ok = Number.isFinite(actual) && ops[op];
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: got ${actual.toFixed(3)}, expected ${op} ${bound}`);
  ok ? (passed += 1) : (failed += 1);
}

const dbfs = (amp) => 20 * Math.log10(amp);

console.log("\n[1] Stereo 1 kHz sine @ -6 dBFS (amp 0.5), 48k, 4s");
const m1 = analyzeChannels(sine({ freq: 1000, amp: 0.5, seconds: 4 }));
console.log(`     integrated=${m1.integratedLufs.toFixed(2)} LUFS  TP=${m1.truePeakDbtp.toFixed(2)} dBTP  SP=${m1.samplePeakDbfs.toFixed(2)} dBFS  LRA=${m1.loudnessRange.toFixed(2)}`);
check("sample peak", m1.samplePeakDbfs, dbfs(0.5), 0.05);
checkCmp("true peak >= sample peak", m1.truePeakDbtp, ">=", m1.samplePeakDbfs - 0.02);
checkCmp("true peak within 0.3 dB of sample peak (low freq)", m1.truePeakDbtp, "<", m1.samplePeakDbfs + 0.3);
checkCmp("LRA ~0 for steady tone", m1.loudnessRange, "<", 1.0);

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

console.log("\n[4] LRA: 10s @ -20 dBFS then 10s @ -14 dBFS (6 dB step), 1 kHz stereo");
const concat = (a, b) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};
const quiet = sine({ freq: 1000, amp: 0.1, seconds: 10 });
const loud = sine({ freq: 1000, amp: 0.1 * 10 ** (6 / 20), seconds: 10 });
const stepped = quiet.map((ch, i) => concat(ch, loud[i]));
const m4 = analyzeChannels(stepped);
console.log(`     LRA=${m4.loudnessRange.toFixed(2)} LU  integrated=${m4.integratedLufs.toFixed(2)} LUFS`);
checkCmp("LRA reflects the ~6 LU spread (> 3)", m4.loudnessRange, ">", 3.0);
checkCmp("LRA not wildly large (< 9)", m4.loudnessRange, "<", 9.0);

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

console.log(`\n==== DSP validation: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
