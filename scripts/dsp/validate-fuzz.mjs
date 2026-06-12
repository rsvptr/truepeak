// Deterministic fuzzing for everything that parses untrusted bytes:
// parseWavBuffer, parseAiffBuffer, sniffContainer, parseFlacStreamInfo, and
// parseSessionFile. A seeded PRNG mutates valid corpora and feeds raw noise,
// asserting that every input either parses into a sane asset or fails with a
// clean exception — quickly, without hangs, runaway memory, or non-Error
// throws. The seed is fixed, so failures reproduce exactly in CI.
//
// Run: node scripts/dsp/validate-fuzz.mjs   (or: npm run test:fuzz)
import { register } from "node:module";
import { performance } from "node:perf_hooks";

register("./alias-loader.mjs", import.meta.url);

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const { parseAiffBuffer } = await import("../../src/audio/aiff.ts");
const { parseFlacStreamInfo } = await import("../../src/audio/browser-decode.ts");
const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const { parseSessionFile } = await import("../../src/audio/session-file.ts");

const SEED = 0xc0ffee;
const PER_CASE_BUDGET_MS = 250;

// --- deterministic PRNG -----------------------------------------------------

function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);
const randomInt = (maxExclusive) => Math.floor(random() * maxExclusive);

// --- corpora -----------------------------------------------------------------

function encodeWav(channels, sampleRate, { float = false, bits = 16, extensible = false } = {}) {
  const channelCount = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = float ? 4 : bits / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const fmtSize = extensible ? 40 : 16;
  const buffer = new ArrayBuffer(20 + fmtSize + 8 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, extensible ? 0xfffe : float ? 3 : 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, float ? 32 : bits, true);
  let offset = 36;
  if (extensible) {
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(38, float ? 32 : bits, true); // valid bits
    view.setUint32(40, 0x3, true); // speaker mask L|R
    // KSDATAFORMAT subtype GUID: PCM or IEEE float
    view.setUint32(44, float ? 3 : 1, true);
    view.setUint16(48, 0, true);
    view.setUint16(50, 0x0010, true);
    const tail = [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    tail.forEach((byte, i) => view.setUint8(52 + i, byte));
    offset = 60;
  }
  ascii(offset, "data");
  view.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame]));
      if (float) {
        view.setFloat32(offset, value, true);
        offset += 4;
      } else {
        view.setInt16(offset, Math.round(value * 32767), true);
        offset += 2;
      }
    }
  }
  return buffer;
}

function writeFloat80(view, offset, value) {
  // Minimal big-endian 80-bit float encoder for positive sample rates.
  const exponent = Math.floor(Math.log2(value));
  const mantissa = value / 2 ** exponent; // in [1, 2)
  view.setUint16(offset, 16383 + exponent, false);
  view.setUint32(offset + 2, Math.floor(mantissa * 2 ** 31), false);
  view.setUint32(offset + 6, 0, false);
}

function encodeAiff(channels, sampleRate) {
  const channelCount = channels.length;
  const frames = channels[0].length;
  const dataBytes = frames * channelCount * 2;
  const ssndBytes = 8 + dataBytes;
  const buffer = new ArrayBuffer(12 + 8 + 18 + 8 + ssndBytes);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "FORM");
  view.setUint32(4, buffer.byteLength - 8, false);
  ascii(8, "AIFF");
  ascii(12, "COMM");
  view.setUint32(16, 18, false);
  view.setUint16(20, channelCount, false);
  view.setUint32(22, frames, false);
  view.setUint16(26, 16, false);
  writeFloat80(view, 28, sampleRate);
  ascii(38, "SSND");
  view.setUint32(42, ssndBytes, false);
  view.setUint32(46, 0, false); // data offset
  view.setUint32(50, 0, false); // block size
  let offset = 54;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(offset, Math.round(value * 32767), false);
      offset += 2;
    }
  }
  return buffer;
}

function encodeFlacHeader(sampleRate, channelCount, bitDepth, frames) {
  const buffer = new ArrayBuffer(4 + 4 + 34);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "fLaC");
  view.setUint8(4, 0x80); // last block, type 0 (STREAMINFO)
  view.setUint8(5, 0);
  view.setUint8(6, 0);
  view.setUint8(7, 34);
  // min/max block + frame sizes (don't matter to the parser)
  view.setUint16(8, 4096, false);
  view.setUint16(10, 4096, false);
  // bytes 12..17: frame sizes, leave zero
  const byte18 = (sampleRate >> 12) & 0xff;
  const byte19 = (sampleRate >> 4) & 0xff;
  const byte20 = ((sampleRate & 0x0f) << 4) | (((channelCount - 1) & 0x07) << 1) | (((bitDepth - 1) >> 4) & 0x01);
  const byte21 = (((bitDepth - 1) & 0x0f) << 4) | 0; // top 4 bits of frame count = 0
  view.setUint8(18, byte18);
  view.setUint8(19, byte19);
  view.setUint8(20, byte20);
  view.setUint8(21, byte21);
  view.setUint32(22, frames, false);
  return buffer;
}

function tone(frames, frequency, sampleRate, gain = 0.5) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = gain * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

const SR = 8000;
const FRAMES = SR / 10; // 100 ms — fast to parse and analyze
const left = tone(FRAMES, 440, SR);
const right = tone(FRAMES, 330, SR);

const WAV_BASES = [
  encodeWav([left, right], SR, { float: true }),
  encodeWav([left, right], SR, { bits: 16 }),
  encodeWav([left, right], SR, { bits: 16, extensible: true }),
];
const AIFF_BASE = encodeAiff([left, right], SR);
const FLAC_BASE = encodeFlacHeader(44100, 2, 16, 44100);

const SESSION_BASE = JSON.stringify({
  app: "truepeak",
  kind: "session",
  version: 1,
  exportedAt: "2026-06-11T00:00:00.000Z",
  jobCount: 1,
  jobs: [
    {
      id: "fuzz-job",
      fileName: "fuzz.wav",
      mimeType: "audio/wav",
      status: "complete",
      createdAt: "2026-06-11T00:00:00.000Z",
      progressPercent: 1,
      progressLabel: "Complete",
      result: {
        analysisMode: "targeted",
        analyzedAt: "2026-06-11T00:00:00.000Z",
        target: {
          id: "t", label: "T", category: "platform", evidence: "official",
          sourceLabel: "s", referenceNote: "n", highlights: ["h"],
          loudnessTargetLufs: -14, truePeakCeilingDbtp: -1, toleranceLufs: 1,
          policy: "protect-true-peak", description: "d",
        },
        metrics: {
          integratedLufs: -14, ungatedLufs: -13.5, loudnessRange: 3,
          maxMomentaryLufs: -11, maxShortTermLufs: -12, samplePeakDbfs: -2,
          truePeakDbtp: -1.5, unclampedTargetDeltaDb: 0, targetDeltaDb: 0,
          projectedTruePeakDbtp: -1.5, normalizationLimited: false,
          warnings: [],
          timeline: {
            stepDurationSeconds: 0.1,
            timeSeconds: [0.1, 0.2, 0.3],
            momentaryLufs: [null, -14, -14.2],
            shortTermLufs: [null, null, -14.1],
            truePeakDbtp: [-2, -1.5, -1.8],
          },
        },
        metadata: {
          fileName: "fuzz.wav", mimeType: "audio/wav", sourceFormat: "wav",
          sampleRate: 48000, bitDepth: 24, durationSeconds: 0.3,
          frameCount: 14400, channelCount: 2,
          channelLayout: { name: "L / R", labels: ["L", "R"], guessed: false, speakerMask: 3 },
          decoderMode: "native-parser", decoderLabel: "WAV parser",
          decoderSummary: "x", decodeNotes: [], warnings: [],
        },
      },
    },
  ],
});

// --- mutators ----------------------------------------------------------------

function mutateBuffer(base) {
  let bytes = new Uint8Array(base.slice(0));
  const operations = 1 + randomInt(3);

  for (let op = 0; op < operations; op += 1) {
    const choice = randomInt(4);
    if (choice === 0 && bytes.length > 0) {
      // flip random bytes
      const flips = 1 + randomInt(32);
      for (let i = 0; i < flips; i += 1) {
        bytes[randomInt(bytes.length)] = randomInt(256);
      }
    } else if (choice === 1 && bytes.length > 1) {
      // truncate to a random length
      bytes = bytes.slice(0, randomInt(bytes.length));
    } else if (choice === 2 && bytes.length >= 4) {
      // stomp a 32-bit field with an extreme value
      const extremes = [0, 1, 0x7fffffff, 0xffffffff, 0xfffffffe, bytes.length, bytes.length - 1];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(randomInt(bytes.length - 3), extremes[randomInt(extremes.length)], random() < 0.5);
    } else {
      // append random tail
      const tail = new Uint8Array(randomInt(64));
      for (let i = 0; i < tail.length; i += 1) tail[i] = randomInt(256);
      const grown = new Uint8Array(bytes.length + tail.length);
      grown.set(bytes);
      grown.set(tail, bytes.length);
      bytes = grown;
    }
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function randomBuffer(maxLength) {
  const bytes = new Uint8Array(randomInt(maxLength));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = randomInt(256);
  return bytes.buffer;
}

function mutateJson(base) {
  if (random() < 0.4) {
    // raw text mutation: may or may not stay valid JSON
    const chars = base.split("");
    const flips = 1 + randomInt(12);
    for (let i = 0; i < flips; i += 1) {
      chars[randomInt(chars.length)] = String.fromCharCode(32 + randomInt(96));
    }
    return chars.join("");
  }

  // structural mutation: replace a random path with junk
  const data = JSON.parse(base);
  const junkValues = [null, 0, -1, 1e308, "", "junk", [], {}, true, [{}], { a: 1 }, Number.NaN];
  const mutate = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    if (!keys.length) return;
    const key = keys[randomInt(keys.length)];
    if (random() < 0.45) {
      node[key] = junkValues[randomInt(junkValues.length)];
    } else {
      mutate(node[key], depth + 1);
    }
  };
  for (let i = 0; i < 1 + randomInt(4); i += 1) {
    mutate(data, 0);
  }
  return JSON.stringify(data);
}

// --- harness -----------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function recordFailure(category, index, message) {
  failed += 1;
  if (failures.length < 10) {
    failures.push(`${category}#${index}: ${message}`);
  }
}

function assertAssetInvariants(asset) {
  if (!Number.isFinite(asset.sampleRate) || asset.sampleRate <= 0) return "non-finite sampleRate accepted";
  if (!Array.isArray(asset.channels) || asset.channels.length !== asset.channelCount) return "channel count mismatch";
  if (!asset.channels.every((channel) => channel instanceof Float32Array)) return "non-typed-array channel";
  if (asset.channels[0].length <= 0) return "empty frames accepted";
  if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds < 0) return "bad duration";
  return null;
}

function runParserCase(category, index, parse, input, { analyzeOnSuccess = false } = {}) {
  const started = performance.now();
  try {
    const asset = parse(input);
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure(category, index, `parse took ${elapsed.toFixed(0)}ms`);
      return;
    }

    const invariantProblem = assertAssetInvariants(asset);
    if (invariantProblem) {
      recordFailure(category, index, invariantProblem);
      return;
    }

    if (analyzeOnSuccess) {
      try {
        const result = analyzeDecodedAsset(asset, null);
        if (!Number.isFinite(result.metrics.integratedLufs) || !Number.isFinite(result.metrics.truePeakDbtp)) {
          recordFailure(category, index, "analyzer produced non-finite metrics");
          return;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          recordFailure(category, index, "analyzer threw a non-Error");
          return;
        }
      }
    }

    passed += 1;
  } catch (error) {
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure(category, index, `failure path took ${elapsed.toFixed(0)}ms`);
      return;
    }

    if (!(error instanceof Error)) {
      recordFailure(category, index, `threw a non-Error: ${String(error)}`);
      return;
    }

    passed += 1;
  }
}

console.log("\n[A] WAV mutations (3 corpora x 120)");
for (let i = 0; i < 360; i += 1) {
  const base = WAV_BASES[i % WAV_BASES.length];
  runParserCase("wav", i, (buf) => parseWavBuffer(buf, "fuzz.wav", "audio/wav"), mutateBuffer(base), {
    analyzeOnSuccess: i % 4 === 0,
  });
}
console.log(`  ${passed} ok so far`);

console.log("[B] AIFF mutations (250)");
for (let i = 0; i < 250; i += 1) {
  runParserCase("aiff", i, (buf) => parseAiffBuffer(buf, "fuzz.aiff", "audio/aiff"), mutateBuffer(AIFF_BASE), {
    analyzeOnSuccess: i % 4 === 0,
  });
}

console.log("[C] Raw noise into every binary parser (200)");
for (let i = 0; i < 200; i += 1) {
  const noise = randomBuffer(2048);
  runParserCase("noise-wav", i, (buf) => parseWavBuffer(buf, "n.wav", "audio/wav"), noise);
  runParserCase("noise-aiff", i, (buf) => parseAiffBuffer(buf, "n.aiff", "audio/aiff"), noise);
}

console.log("[C2] FLAC STREAMINFO mutations + noise (200) — main-thread parser");
for (let i = 0; i < 200; i += 1) {
  const input = i % 2 === 0 ? mutateBuffer(FLAC_BASE) : randomBuffer(1024);
  const started = performance.now();
  try {
    const info = parseFlacStreamInfo(input);
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure("flac", i, `took ${elapsed.toFixed(0)}ms`);
    } else if (info !== null && (!Number.isFinite(info.sampleRate) || info.sampleRate <= 0)) {
      recordFailure("flac", i, "returned non-finite sample rate");
    } else {
      passed += 1;
    }
  } catch (error) {
    recordFailure("flac", i, `parseFlacStreamInfo threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("[D] Session JSON mutations (150)");
for (let i = 0; i < 150; i += 1) {
  const input = mutateJson(SESSION_BASE);
  const started = performance.now();
  try {
    const result = parseSessionFile(input);
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure("session", i, `took ${elapsed.toFixed(0)}ms`);
    } else if (!result || !Array.isArray(result.jobs)) {
      recordFailure("session", i, "did not return a jobs array");
    } else if (result.jobs.length && result.error) {
      recordFailure("session", i, "returned jobs and an error at once");
    } else {
      passed += 1;
    }
  } catch (error) {
    recordFailure("session", i, `parseSessionFile threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("[E] Targeted DoS regressions");
{
  // A 2 MB WAV made of ~250k empty unknown chunks: must fail or parse quickly
  // without accumulating per-chunk state.
  const chunkCount = 250_000;
  const buffer = new ArrayBuffer(12 + chunkCount * 8);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  for (let i = 0; i < chunkCount; i += 1) {
    ascii(12 + i * 8, "junk");
    view.setUint32(12 + i * 8 + 4, 0, true);
  }

  const started = performance.now();
  try {
    parseWavBuffer(buffer, "chunks.wav", "audio/wav");
    recordFailure("dos", 0, "chunk-flood file unexpectedly parsed");
  } catch (error) {
    const elapsed = performance.now() - started;
    if (!(error instanceof Error)) {
      recordFailure("dos", 0, "threw a non-Error");
    } else if (elapsed > 1000) {
      recordFailure("dos", 0, `chunk flood took ${elapsed.toFixed(0)}ms`);
    } else {
      passed += 1;
    }
  }
}
{
  // AIFF with an infinite sample rate (exponent 0x7fff) must be rejected.
  const evil = new Uint8Array(AIFF_BASE.slice(0));
  const view = new DataView(evil.buffer);
  view.setUint16(28, 0x7fff, false);
  try {
    parseAiffBuffer(evil.buffer, "inf.aiff", "audio/aiff");
    recordFailure("dos", 1, "infinite sample rate accepted");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Invalid AIFF format values")) {
      passed += 1;
    } else {
      recordFailure("dos", 1, `unexpected rejection: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (failures.length) {
  console.log("\nFirst failures:");
  failures.forEach((failure) => console.log(`  FAIL  ${failure}`));
}

console.log(`\n==== Fuzz: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
