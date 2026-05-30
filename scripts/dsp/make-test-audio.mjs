// Generates a small set of reference WAV files (float32 + 16-bit PCM) with
// distinct loudness/dynamics so the running app's queue, compare, and insights
// views have meaningful data to display. Output: <os tmp>/truepeak-test-audio/
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const outDir = path.join(os.tmpdir(), "truepeak-test-audio");
await mkdir(outDir, { recursive: true });

function encodeWav(channels, sampleRate, { float = false, bits = 16 } = {}) {
  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const bytesPerSample = float ? 4 : bits / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (off, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(off + i, text.charCodeAt(i)); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, float ? 32 : bits, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  for (let n = 0; n < frameCount; n += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      const v = clamp(channels[ch][n]);
      if (float) { view.setFloat32(off, v, true); off += 4; }
      else if (bits === 16) { view.setInt16(off, Math.round(v * 32767), true); off += 2; }
      else if (bits === 24) {
        const s = Math.round(v * 8388607);
        view.setUint8(off, s & 0xff); view.setUint8(off + 1, (s >> 8) & 0xff); view.setUint8(off + 2, (s >> 16) & 0xff); off += 3;
      }
    }
  }
  return Buffer.from(buffer);
}

const SR = 48000;
const stereo = (fn, seconds) => {
  const N = Math.round(seconds * SR);
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  for (let n = 0; n < N; n += 1) { const [a, b] = fn(n / SR, n); l[n] = a; r[n] = b; }
  return [l, r];
};
const tone = (f, t) => Math.sin(2 * Math.PI * f * t);

// 1) Loud, steady, hot peaks — should read above a -14 LUFS streaming target.
const loud = stereo((t) => { const v = 0.5 * (tone(220, t) + tone(440, t) + tone(660, t)) / 1.5; return [v, v]; }, 8);

// 2) Quiet pad — well below target, needs gain.
const quiet = stereo((t) => { const v = 0.08 * (tone(330, t) + tone(495, t)) / 2; return [v, v]; }, 8);

// 3) Dynamic mix — soft intro then loud body, gives a real LRA and slight stereo width.
const dynamic = stereo((t) => {
  const env = t < 4 ? 0.06 : 0.32;
  const base = env * (tone(110, t) + 0.7 * tone(220, t) + 0.5 * tone(440, t));
  return [base, base * 0.94 + env * 0.2 * tone(330, t)];
}, 12);

const files = [
  ["loud-master_48k_f32.wav", encodeWav(loud, SR, { float: true })],
  ["quiet-pad_48k_16bit.wav", encodeWav(quiet, SR, { bits: 16 })],
  ["dynamic-mix_48k_24bit.wav", encodeWav(dynamic, SR, { bits: 24 })],
];

for (const [name, buf] of files) {
  await writeFile(path.join(outDir, name), buf);
  console.log(`wrote ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
}
console.log(`\nTest audio in: ${outDir}`);
