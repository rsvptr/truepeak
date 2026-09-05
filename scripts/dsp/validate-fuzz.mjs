// Deterministic fuzzing for everything that parses untrusted bytes:
// parseWavBuffer, parseAiffBuffer, parseFlacStreamInfo, and parseSessionFile.
// A seeded PRNG mutates valid corpora and feeds raw noise,
// asserting that every input either parses into a sane asset or fails with a
// clean exception — quickly, without hangs, runaway memory, or non-Error
// throws. The seed is fixed, so failures reproduce exactly in CI.
//
// Run: npm run test:fuzz
import assert from "node:assert/strict";
import { register } from "node:module";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { encodeAiff, encodeFlacHeader, encodeWav, writeFloat80 } from "./lib/fixtures.mjs";

register("./alias-loader.mjs", import.meta.url);

const { parseWavBuffer } = await import("../../src/audio/wav.ts");
const { parseAiffBuffer } = await import("../../src/audio/aiff.ts");
const { inspectAudioContainer } = await import("../../src/audio/decode-budget.ts");
const { parseFlacStreamInfo } = await import("../../src/audio/browser-decode.ts");
const { analyzeDecodedAsset } = await import("../../src/audio/analysis.ts");
const { parseSessionFile } = await import("../../src/audio/session-file.ts");

/** @typedef {import("../../src/types/audio.ts").DecodedAudioAsset} DecodedAudioAsset */
/** @typedef {import("../../src/audio/container-chunks.ts").BeforePcmAllocation} BeforePcmAllocation */
/** @typedef {import("../../src/audio/decode-budget-core.ts").AudioContainerPreflight} AudioContainerPreflight */
/** @typedef {(buffer: ArrayBuffer, beforeAllocation?: BeforePcmAllocation) => DecodedAudioAsset} ContainerParser */
/** @typedef {{ label: string, kind: "wav" | "aiff", buffer: ArrayBuffer }} DifferentialCorpus */

const SEED = 0xc0ffee;
const PER_CASE_BUDGET_MS = 250;

// --- deterministic PRNG -----------------------------------------------------

/** @param {number} seed */
function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let activeSectionSeed = SEED;
let random = mulberry32(activeSectionSeed);
/** @param {number} maxExclusive */
const randomInt = (maxExclusive) => Math.floor(random() * maxExclusive);

/** @param {number} sectionIndex */
function seedSection(sectionIndex) {
  activeSectionSeed = (SEED ^ sectionIndex) >>> 0;
  random = mulberry32(activeSectionSeed);
}

// --- corpora -----------------------------------------------------------------

/** @param {string} text */
function asciiBytes(text) {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/** @param {Uint8Array[]} parts */
function joinBytes(parts) {
  const totalBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/**
 * @param {string} id
 * @param {Uint8Array} payload
 * @param {boolean} littleEndian
 * @param {number} [declaredSize]
 */
function encodeChunk(id, payload, littleEndian, declaredSize = payload.byteLength) {
  const paddedSize = payload.byteLength + (payload.byteLength & 1);
  const output = new Uint8Array(8 + paddedSize);
  output.set(asciiBytes(id), 0);
  new DataView(output.buffer).setUint32(4, declaredSize, littleEndian);
  output.set(payload, 8);
  return output;
}

/** @param {{ bits: number, float?: boolean, sampleRate?: number }} options */
function encodeWaveFmt({ bits, float = false, sampleRate = 48000 }) {
  const bytesPerSample = bits / 8;
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint16(0, float ? 3 : 1, true);
  view.setUint16(2, 1, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * bytesPerSample, true);
  view.setUint16(12, bytesPerSample, true);
  view.setUint16(14, bits, true);
  return encodeChunk("fmt ", payload, true);
}

/**
 * @param {[string, Uint8Array][]} chunkEntries
 * @param {string[]} order
 * @param {{ rf64?: boolean, dataBytes?: number }} [options]
 */
function encodeWaveChunks(
  chunkEntries,
  order,
  { rf64 = false, dataBytes = 96 } = {},
) {
  const dataPayload = new Uint8Array(dataBytes);
  const dataChunk = encodeChunk("data", dataPayload, true, rf64 ? 0xffffffff : dataBytes);
  /** @type {Record<string, Uint8Array>} */
  const chunkMap = { data: dataChunk };
  for (const [name, chunk] of chunkEntries) {
    chunkMap[name] = chunk;
  }

  const orderedChunks = order.map((name) => chunkMap[name]);
  if (rf64) {
    const ds64Payload = new Uint8Array(28);
    const ds64View = new DataView(ds64Payload.buffer);
    ds64View.setBigUint64(8, BigInt(dataBytes), true);
    orderedChunks.unshift(encodeChunk("ds64", ds64Payload, true));
  }

  const body = joinBytes(orderedChunks);
  const output = new Uint8Array(12 + body.byteLength);
  output.set(asciiBytes(rf64 ? "RF64" : "RIFF"), 0);
  new DataView(output.buffer).setUint32(4, rf64 ? 0xffffffff : output.byteLength - 8, true);
  output.set(asciiBytes("WAVE"), 8);
  output.set(body, 12);
  return output.buffer;
}

/** @param {{ bits: number, float?: boolean, frames?: number, rf64?: boolean, dataFirst?: boolean }} options */
function waveCorpus({ bits, float = false, frames = 12, rf64 = false, dataFirst = false }) {
  const fmt = encodeWaveFmt({ bits, float });
  const order = dataFirst ? ["data", "fmt"] : ["fmt", "data"];
  return encodeWaveChunks([["fmt", fmt]], order, {
    rf64,
    dataBytes: frames * (bits / 8),
  });
}

function duplicateWaveCorpus() {
  const first = encodeWaveFmt({ bits: 8 });
  const second = encodeWaveFmt({ bits: 64, float: true });
  return encodeWaveChunks(
    [["fmt1", first], ["fmt2", second]],
    ["data", "fmt1", "fmt2"],
    { dataBytes: 96 },
  );
}

/** @param {{ bits: number, frames: number, aifc?: boolean, compressionType?: string }} options */
function encodeAiffComm({ bits, frames, aifc = false, compressionType = "NONE" }) {
  const payload = new Uint8Array(aifc ? 23 : 18);
  const view = new DataView(payload.buffer);
  view.setUint16(0, 1, false);
  view.setUint32(2, frames, false);
  view.setUint16(6, bits, false);
  writeFloat80(view, 8, 48000);
  if (aifc) {
    payload.set(asciiBytes(compressionType), 18);
    view.setUint8(22, 0);
  }
  return encodeChunk("COMM", payload, false);
}

/**
 * @param {Uint8Array[]} chunks
 * @param {{ aifc?: boolean }} [options]
 */
function encodeAiffChunks(chunks, { aifc = false } = {}) {
  const body = joinBytes(chunks);
  const output = new Uint8Array(12 + body.byteLength);
  output.set(asciiBytes("FORM"), 0);
  new DataView(output.buffer).setUint32(4, output.byteLength - 8, false);
  output.set(asciiBytes(aifc ? "AIFC" : "AIFF"), 8);
  output.set(body, 12);
  return output.buffer;
}

/** @param {{ bits: number, frames?: number, aifc?: boolean, dataFirst?: boolean }} options */
function aiffCorpus({ bits, frames = 12, aifc = false, dataFirst = false }) {
  const compressionType = bits === 64 ? "FL64" : "NONE";
  const comm = encodeAiffComm({ bits, frames, aifc, compressionType });
  const soundPayload = new Uint8Array(8 + frames * (bits / 8));
  const ssnd = encodeChunk("SSND", soundPayload, false);
  const fverPayload = new Uint8Array(4);
  new DataView(fverPayload.buffer).setUint32(0, 0xa2805140, false);
  const fver = encodeChunk("FVER", fverPayload, false);
  const chunks = dataFirst ? [ssnd, comm] : [comm, ssnd];
  if (aifc) chunks.unshift(fver);
  return encodeAiffChunks(chunks, { aifc });
}

function duplicateAiffCorpus() {
  const dataBytes = 96;
  const first = encodeAiffComm({ bits: 8, frames: dataBytes });
  const second = encodeAiffComm({ bits: 64, frames: dataBytes / 8 });
  const ssnd = encodeChunk("SSND", new Uint8Array(8 + dataBytes), false);
  return encodeAiffChunks([first, second, ssnd]);
}

/**
 * @param {number} frames
 * @param {number} frequency
 * @param {number} sampleRate
 * @param {number} [gain]
 */
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
  encodeWav({ channels: [left, right], sampleRate: SR }),
  encodeWav({ channels: [left, right], sampleRate: SR, formatTag: 1, bitsPerSample: 16 }),
  encodeWav({
    channels: [left, right],
    sampleRate: SR,
    formatTag: 0xfffe,
    bitsPerSample: 16,
    extensible: true,
  }),
];
const AIFF_BASE = encodeAiff({ channels: [left, right], sampleRate: SR });
const FLAC_BASE = encodeFlacHeader(44100, 2, 16, 44100, { blockSize: 4096 });

/** @type {DifferentialCorpus[]} */
const DIFFERENTIAL_CORPORA = [
  { label: "WAV PCM 8-bit, data before fmt", kind: "wav", buffer: waveCorpus({ bits: 8, dataFirst: true }) },
  { label: "WAV PCM 24-bit", kind: "wav", buffer: waveCorpus({ bits: 24 }) },
  { label: "WAV PCM 32-bit", kind: "wav", buffer: waveCorpus({ bits: 32 }) },
  { label: "WAV IEEE float 64-bit", kind: "wav", buffer: waveCorpus({ bits: 64, float: true }) },
  { label: "RF64 PCM 16-bit", kind: "wav", buffer: waveCorpus({ bits: 16, rf64: true }) },
  { label: "WAV duplicate fmt after data", kind: "wav", buffer: duplicateWaveCorpus() },
  { label: "AIFF PCM 8-bit, SSND before COMM", kind: "aiff", buffer: aiffCorpus({ bits: 8, dataFirst: true }) },
  { label: "AIFF PCM 24-bit", kind: "aiff", buffer: aiffCorpus({ bits: 24 }) },
  { label: "AIFF PCM 32-bit", kind: "aiff", buffer: aiffCorpus({ bits: 32 }) },
  { label: "AIFC + FVER float 64-bit", kind: "aiff", buffer: aiffCorpus({ bits: 64, aifc: true }) },
  { label: "AIFF duplicate COMM before SSND", kind: "aiff", buffer: duplicateAiffCorpus() },
];

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

/**
 * @param {ArrayBuffer} base
 * @returns {ArrayBuffer}
 */
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

/**
 * @param {number} maxLength
 * @returns {ArrayBuffer}
 */
function randomBuffer(maxLength) {
  const bytes = new Uint8Array(randomInt(maxLength));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = randomInt(256);
  return bytes.buffer;
}

/**
 * @param {string} base
 * @returns {string}
 */
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
  /**
   * @param {unknown} node
   * @param {number} depth
   */
  const mutate = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    // Object.keys covers arrays and plain objects alike, and Reflect keeps the
    // same dynamic read/write on a node whose shape is deliberately unknown.
    const keys = Object.keys(node);
    if (!keys.length) return;
    const key = keys[randomInt(keys.length)];
    if (random() < 0.45) {
      Reflect.set(node, key, junkValues[randomInt(junkValues.length)]);
    } else {
      mutate(Reflect.get(node, key), depth + 1);
    }
  };
  for (let i = 0; i < 1 + randomInt(4); i += 1) {
    mutate(data, 0);
  }
  return JSON.stringify(data);
}

// --- harness -----------------------------------------------------------------

/** @param {unknown} input */
function inputAsBase64(input) {
  if (typeof input === "string") {
    return Buffer.from(input, "utf8").toString("base64");
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input).toString("base64");
  }
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64");
  }
  return Buffer.from(String(input), "utf8").toString("base64");
}

// One named test per generated case. A failure carries the section seed and the
// offending bytes so it reproduces without rerunning the whole corpus.
/**
 * @param {string} category
 * @param {number} index
 * @param {string | null} message
 * @param {unknown} input
 */
function recordCase(category, index, message, input) {
  const detail =
    message === null
      ? ""
      : `${message} (section seed 0x${activeSectionSeed.toString(16)}, input base64 ${inputAsBase64(input)})`;
  test(`${category}#${index}`, () => {
    assert.ok(message === null, detail);
  });
}

/**
 * @param {string} category
 * @param {number} index
 */
function recordPass(category, index) {
  recordCase(category, index, null, null);
}

/**
 * @param {string} category
 * @param {number} index
 * @param {string} message
 * @param {unknown} input
 */
function recordFailure(category, index, message, input) {
  recordCase(category, index, message, input);
}

/** @param {DecodedAudioAsset} asset */
function assertAssetInvariants(asset) {
  if (!Number.isFinite(asset.sampleRate) || asset.sampleRate <= 0) return "non-finite sampleRate accepted";
  if (!Array.isArray(asset.channels) || asset.channels.length !== asset.channelCount) return "channel count mismatch";
  if (!asset.channels.every((channel) => channel instanceof Float32Array)) return "non-typed-array channel";
  if (asset.channels[0].length <= 0) return "empty frames accepted";
  if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds < 0) return "bad duration";
  return null;
}

/**
 * @param {string} category
 * @param {number} index
 * @param {(buffer: ArrayBuffer) => DecodedAudioAsset} parse
 * @param {ArrayBuffer} input
 * @param {{ analyzeOnSuccess?: boolean }} [options]
 */
function runParserCase(category, index, parse, input, { analyzeOnSuccess = false } = {}) {
  const started = performance.now();
  try {
    const asset = parse(input);
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure(category, index, `parse took ${elapsed.toFixed(0)}ms`, input);
      return;
    }

    const invariantProblem = assertAssetInvariants(asset);
    if (invariantProblem) {
      recordFailure(category, index, invariantProblem, input);
      return;
    }

    if (analyzeOnSuccess) {
      try {
        const result = analyzeDecodedAsset(asset, null);
        if (!Number.isFinite(result.metrics.integratedLufs) || !Number.isFinite(result.metrics.truePeakDbtp)) {
          recordFailure(category, index, "analyzer produced non-finite metrics", input);
          return;
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          recordFailure(category, index, "analyzer threw a non-Error", input);
          return;
        }
      }
    }

    recordPass(category, index);
  } catch (error) {
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure(category, index, `failure path took ${elapsed.toFixed(0)}ms`, input);
      return;
    }

    if (!(error instanceof Error)) {
      recordFailure(category, index, `threw a non-Error: ${String(error)}`, input);
      return;
    }

    recordPass(category, index);
  }
}

class PreflightAllocationError extends Error {}
class PreflightGeometryError extends Error {}

/**
 * @param {ContainerParser} parse
 * @param {ArrayBuffer} input
 * @param {AudioContainerPreflight} preflight
 */
function parseWithAllocationGuard(parse, input, preflight) {
  const NativeFloat32Array = globalThis.Float32Array;
  let geometryChecked = false;
  globalThis.Float32Array = new Proxy(NativeFloat32Array, {
    construct(target, args) {
      const requestedLength = typeof args[0] === "number" ? args[0] : 0;
      if (!geometryChecked) {
        throw new PreflightAllocationError("allocated Float32Array before checking preflight geometry");
      }
      if (requestedLength > preflight.frameCount) {
        throw new PreflightAllocationError(
          `requested ${requestedLength} frames after preflight authorised ${preflight.frameCount}`,
        );
      }
      return Reflect.construct(target, args, target);
    },
  });
  try {
    return parse(input, (geometry) => {
      geometryChecked = true;
      if (
        geometry.channelCount !== preflight.channelCount ||
        geometry.bitDepth !== preflight.bitDepth ||
        geometry.frameCount !== preflight.frameCount
      ) {
        throw new PreflightGeometryError("parser rejected mismatched preflight geometry before allocation");
      }
    });
  } finally {
    globalThis.Float32Array = NativeFloat32Array;
  }
}

/**
 * @param {DifferentialCorpus} corpus
 * @param {number} index
 * @param {ArrayBuffer} input
 */
function runDifferentialCase(corpus, index, input) {
  const category = `differential-${corpus.label}`;
  let preflight;
  try {
    preflight = inspectAudioContainer(input);
  } catch (error) {
    recordFailure(
      category,
      index,
      `preflight threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      input,
    );
    return;
  }

  if (preflight == null) {
    recordPass(category, index);
    return;
  }

  /** @type {ContainerParser} */
  const parse = corpus.kind === "wav"
    ? (buffer, beforeAllocation) =>
        parseWavBuffer(buffer, "differential.wav", "audio/wav", beforeAllocation)
    : (buffer, beforeAllocation) =>
        parseAiffBuffer(buffer, "differential.aiff", "audio/aiff", beforeAllocation);

  let asset;
  try {
    asset = parseWithAllocationGuard(parse, input, preflight);
  } catch (error) {
    if (error instanceof PreflightAllocationError) {
      recordFailure(category, index, error.message, input);
    } else if (error instanceof PreflightGeometryError) {
      recordPass(category, index);
    } else if (error instanceof Error) {
      recordPass(category, index);
    } else {
      recordFailure(category, index, `parser threw a non-Error: ${String(error)}`, input);
    }
    return;
  }

  /** @type {string[]} */
  const mismatches = [];
  if (asset.channelCount !== preflight.channelCount) {
    mismatches.push(`channels ${asset.channelCount}/${preflight.channelCount}`);
  }
  if (asset.bitDepth !== preflight.bitDepth) {
    mismatches.push(`bit depth ${asset.bitDepth}/${preflight.bitDepth}`);
  }
  if (asset.frameCount !== preflight.frameCount) {
    mismatches.push(`frames ${asset.frameCount}/${preflight.frameCount}`);
  }
  if (mismatches.length > 0) {
    recordFailure(category, index, mismatches.join(", "), input);
    return;
  }

  recordPass(category, index);
}

seedSection(0);
console.log("\n[A] WAV mutations (3 corpora x 120)");
for (let i = 0; i < 360; i += 1) {
  const base = WAV_BASES[i % WAV_BASES.length];
  runParserCase("wav", i, (buf) => parseWavBuffer(buf, "fuzz.wav", "audio/wav"), mutateBuffer(base), {
    analyzeOnSuccess: i % 4 === 0,
  });
}

seedSection(1);
console.log("[B] AIFF mutations (250)");
for (let i = 0; i < 250; i += 1) {
  runParserCase("aiff", i, (buf) => parseAiffBuffer(buf, "fuzz.aiff", "audio/aiff"), mutateBuffer(AIFF_BASE), {
    analyzeOnSuccess: i % 4 === 0,
  });
}

seedSection(2);
console.log("[C] Raw noise into every binary parser (200)");
for (let i = 0; i < 200; i += 1) {
  const noise = randomBuffer(2048);
  runParserCase("noise-wav", i, (buf) => parseWavBuffer(buf, "n.wav", "audio/wav"), noise);
  runParserCase("noise-aiff", i, (buf) => parseAiffBuffer(buf, "n.aiff", "audio/aiff"), noise);
}

seedSection(3);
console.log("[C2] FLAC STREAMINFO mutations + noise (200) — main-thread parser");
for (let i = 0; i < 200; i += 1) {
  const input = i % 2 === 0 ? mutateBuffer(FLAC_BASE) : randomBuffer(1024);
  const started = performance.now();
  try {
    const info = parseFlacStreamInfo(input);
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure("flac", i, `took ${elapsed.toFixed(0)}ms`, input);
    } else if (info !== null && (!Number.isFinite(info.sampleRate) || info.sampleRate <= 0)) {
      recordFailure("flac", i, "returned non-finite sample rate", input);
    } else {
      recordPass("flac", i);
    }
  } catch (error) {
    recordFailure(
      "flac",
      i,
      `parseFlacStreamInfo threw: ${error instanceof Error ? error.message : String(error)}`,
      input,
    );
  }
}

seedSection(4);
console.log("[D] WAV/AIFF preflight differential fuzzing");
for (let corpusIndex = 0; corpusIndex < DIFFERENTIAL_CORPORA.length; corpusIndex += 1) {
  const corpus = DIFFERENTIAL_CORPORA[corpusIndex];
  runDifferentialCase(corpus, corpusIndex * 41, corpus.buffer);
  for (let mutationIndex = 1; mutationIndex <= 40; mutationIndex += 1) {
    runDifferentialCase(
      corpus,
      corpusIndex * 41 + mutationIndex,
      mutateBuffer(corpus.buffer),
    );
  }
}

seedSection(5);
console.log("[E] Session JSON mutations (150)");
for (let i = 0; i < 150; i += 1) {
  const input = mutateJson(SESSION_BASE);
  const started = performance.now();
  try {
    const result = parseSessionFile(input);
    const elapsed = performance.now() - started;
    if (elapsed > PER_CASE_BUDGET_MS) {
      recordFailure("session", i, `took ${elapsed.toFixed(0)}ms`, input);
    } else if (!result || !Array.isArray(result.jobs)) {
      recordFailure("session", i, "did not return a jobs array", input);
    } else if (result.jobs.length && result.error) {
      recordFailure("session", i, "returned jobs and an error at once", input);
    } else {
      recordPass("session", i);
    }
  } catch (error) {
    recordFailure(
      "session",
      i,
      `parseSessionFile threw: ${error instanceof Error ? error.message : String(error)}`,
      input,
    );
  }
}

seedSection(6);
console.log("[F] Targeted DoS regressions");
{
  // A 2 MB WAV made of ~250k empty unknown chunks: must fail or parse quickly
  // without accumulating per-chunk state.
  const chunkCount = 250_000;
  const buffer = new ArrayBuffer(12 + chunkCount * 8);
  const view = new DataView(buffer);
  /**
   * @param {number} offset
   * @param {string} text
   */
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
    recordFailure("dos", 0, "chunk-flood file unexpectedly parsed", buffer);
  } catch (error) {
    const elapsed = performance.now() - started;
    if (!(error instanceof Error)) {
      recordFailure("dos", 0, "threw a non-Error", buffer);
    } else if (elapsed > 1000) {
      recordFailure("dos", 0, `chunk flood took ${elapsed.toFixed(0)}ms`, buffer);
    } else {
      recordPass("dos", 0);
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
    recordFailure("dos", 1, "infinite sample rate accepted", evil);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Invalid AIFF format values")) {
      recordPass("dos", 1);
    } else {
      recordFailure(
        "dos",
        1,
        `unexpected rejection: ${error instanceof Error ? error.message : String(error)}`,
        evil,
      );
    }
  }
}
