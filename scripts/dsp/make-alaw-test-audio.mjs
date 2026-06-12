// Generates a small G.711 a-law WAV (format tag 6) into public/test-audio.
// The native WAV parser rejects a-law, so this file exercises the real
// ffmpeg.wasm fallback path in a running browser — useful for verifying the
// compatibility decoder still works under the production CSP.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "public", "test-audio");
mkdirSync(outDir, { recursive: true });

const sampleRate = 8000;
const seconds = 5;
const frames = sampleRate * seconds;

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
