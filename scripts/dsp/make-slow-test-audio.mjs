// Generates four ~46 MB / 120 s stereo float32 WAVs used to exercise the
// parallel analysis lanes during manual verification. Output: public/test-audio.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.join(root, "public", "test-audio");
mkdirSync(outDir, { recursive: true });

const sampleRate = 48000;
const seconds = 120;
const frames = sampleRate * seconds;

function writeWav(filePath, freq) {
  const dataBytes = frames * 2 * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const v =
      0.4 *
      Math.sin((2 * Math.PI * freq * i) / sampleRate) *
      (0.6 + 0.4 * Math.sin((2 * Math.PI * 0.25 * i) / sampleRate));
    buf.writeFloatLE(v, offset);
    offset += 4;
    buf.writeFloatLE(v * 0.9, offset);
    offset += 4;
  }
  writeFileSync(filePath, buf);
  console.log(filePath, (buf.length / 1048576).toFixed(1) + " MB");
}

[220, 330, 440, 550].forEach((f, i) => writeWav(path.join(outDir, `slow-${i + 1}-${f}hz.wav`), f));
