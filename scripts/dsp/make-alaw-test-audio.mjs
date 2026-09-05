// Generates the WAV fixtures the Playwright suite needs into public/test-audio.
// Both are synthesized here so nothing binary is committed and CI can rebuild
// them on every run.
//
// 1. alaw-compat-test.wav: a small G.711 a-law WAV (format tag 6). The native
//    WAV parser rejects a-law, so this file exercises the real ffmpeg.wasm
//    fallback path in a running browser under the production CSP.
// 2. timeline-fixture_48k_24bit.wav: eight seconds of stereo 24-bit PCM whose
//    level steps every two seconds, so the loudness timeline has a visible
//    range and the cursor readout changes along a drag.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "public", "test-audio");
mkdirSync(outDir, { recursive: true });

const sampleRate = 8000;
const seconds = 5;
const frames = sampleRate * seconds;

/** @param {number} sample */
function linearToALaw(sample) {
  let pcm = Math.max(-32768, Math.min(32767, sample));
  const sign = pcm >= 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm - 1;

  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1) {
    // walk down to the highest set bit
  }

  const mantissa = exponent === 0 ? (pcm >> 4) & 0x0f : (pcm >> (exponent + 3)) & 0x0f;
  return (sign | (exponent << 4) | mantissa) ^ 0x55;
}

const dataBytes = frames; // mono, 1 byte per sample
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(6, 20); // WAVE_FORMAT_ALAW
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate, 28); // byte rate = sr * channels * 1
buf.writeUInt16LE(1, 32); // block align
buf.writeUInt16LE(8, 34); // bits per sample
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);

for (let i = 0; i < frames; i += 1) {
  const value = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  buf.writeUInt8(linearToALaw(value), 44 + i);
}

const filePath = path.join(outDir, "alaw-compat-test.wav");
writeFileSync(filePath, buf);
console.log(filePath, `${(buf.length / 1024).toFixed(0)} KB`);

// Timeline fixture: stereo, 48 kHz, 24-bit PCM, four two-second steps.
const tlRate = 48000;
const tlSeconds = 8;
const tlFrames = tlRate * tlSeconds;
const tlChannels = 2;
const tlBlockAlign = tlChannels * 3;
const tlDataBytes = tlFrames * tlBlockAlign;
const tlBuf = Buffer.alloc(44 + tlDataBytes);
tlBuf.write("RIFF", 0);
tlBuf.writeUInt32LE(36 + tlDataBytes, 4);
tlBuf.write("WAVE", 8);
tlBuf.write("fmt ", 12);
tlBuf.writeUInt32LE(16, 16);
tlBuf.writeUInt16LE(1, 20); // WAVE_FORMAT_PCM
tlBuf.writeUInt16LE(tlChannels, 22);
tlBuf.writeUInt32LE(tlRate, 24);
tlBuf.writeUInt32LE(tlRate * tlBlockAlign, 28);
tlBuf.writeUInt16LE(tlBlockAlign, 32);
tlBuf.writeUInt16LE(24, 34);
tlBuf.write("data", 36);
tlBuf.writeUInt32LE(tlDataBytes, 40);

// Peak amplitudes per two-second step, as fractions of full scale
// (about -26, -10, -18 and -4 dBFS), with a slightly different tone per channel
// so the stereo sum is not a pure mono signal.
const steps = [0.05, 0.32, 0.125, 0.63];
const max24 = 8388607;
let offset = 44;
for (let i = 0; i < tlFrames; i += 1) {
  const amp = steps[Math.min(steps.length - 1, Math.floor(i / (tlRate * 2)))];
  const t = i / tlRate;
  const left = amp * Math.sin(2 * Math.PI * 220 * t);
  const right = amp * 0.8 * Math.sin(2 * Math.PI * 330 * t);
  for (const sample of [left, right]) {
    const value = Math.round(Math.max(-1, Math.min(1, sample)) * max24);
    tlBuf.writeIntLE(value, offset, 3);
    offset += 3;
  }
}

const tlPath = path.join(outDir, "timeline-fixture_48k_24bit.wav");
writeFileSync(tlPath, tlBuf);
console.log(tlPath, `${(tlBuf.length / 1024).toFixed(0)} KB`);
