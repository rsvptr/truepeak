// Focused resource-safety contract checks for decode budgets and bounded folder
// traversal. Wired into package.json as the test:runtime script.
//
// Run: npm run test:runtime
import assert from "node:assert/strict";
import { register } from "node:module";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  makeAnalysisJob,
  makeAnalysisResult,
  makeAudioMetadata,
  makeChannelLayout,
  makeMetrics,
} from "./lib/job-fixtures.mjs";
import { encodeAiff, encodeFlacHeader, encodeWav, silentChannels } from "./lib/fixtures.mjs";

register("./alias-loader.mjs", import.meta.url);

const { formatTargetLufs } = await import("../../src/components/preset-taxonomy.tsx");
const {
  COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES,
  DEFAULT_DECODE_BUDGET,
  DecodeResourceError,
  HARD_DECODE_LIMITS,
  LARGE_MEMORY_DECODE_BUDGET,
  MAX_DECODE_CHANNELS,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  checkedDecodedBytes,
  checkedResourceByteSum,
  classifyReservationContention,
  conservativeDecodePeakBytes,
  declaredDecodeCorroboratedByFileSize,
  decodePeakResidentBytes,
  decodeFailureDetails,
  growDecodePeakReservation,
  inspectAudioContainer,
  planLaneAdmission,
  planProbedDecodeFootprint,
  resolveAdaptiveDecodeBudget,
  resolveDecodeBudget,
  throwIfAborted,
  validateDecodeProbeMetadata,
  validatePlanarChannels,
} = await import("../../src/audio/decode-budget.ts");
const {
  collectDroppedFiles,
  getDroppedFileRelativePath,
} = await import("../../src/lib/dropped-files.ts");
const {
  decodeAudioFileInBrowser,
  isBrowserDecodeDrainTimeout,
  waitForBrowserDecodeDrain,
} = await import("../../src/audio/browser-decode.ts");
const {
  browserDecodeWindowCapacity,
  createCountingSemaphore,
} = await import("../../src/audio/decode-window.ts");
const {
  completedHistoryFingerprint,
  isSupportedAudioFile,
  normalizeDecodeFailure,
  resolveAggregatePeakBytes,
  resolveBrowserFirstRoute,
  resolveHeavyFileBytes,
} = await import("../../src/hooks/use-truepeak-analyzer.ts");

/** @typedef {import("../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../src/audio/decode-budget-core.ts").AudioContainerPreflight} AudioContainerPreflight */

/**
 * @param {AudioContainerPreflight | null} preflight
 * @param {string} label
 * @returns {AudioContainerPreflight}
 */
function requirePreflight(preflight, label) {
  if (!preflight) {
    throw new Error(`${label} fixture did not preflight.`);
  }
  return preflight;
}

/**
 * @param {string} name
 * @param {unknown} condition
 * @param {string | null | undefined} [detail]
 */
function ok(name, condition, detail = "") {
  test(name, () => {
    assert.ok(condition, detail ?? undefined);
  });
}

/**
 * @template T
 * @param {number} deviceMemory
 * @param {boolean} coarsePointer
 * @param {() => T} operation
 * @returns {T}
 */
function withDeviceEnvironment(deviceMemory, coarsePointer, operation) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { deviceMemory },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => ({ matches: coarsePointer }),
    },
  });

  try {
    return operation();
  } finally {
    if (navigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
    if (windowDescriptor) {
      Object.defineProperty(globalThis, "window", windowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
}

/**
 * @param {string} name
 * @param {string} code
 * @param {() => unknown} operation
 */
function throwsCode(name, code, operation) {
  try {
    operation();
    ok(name, false);
  } catch (error) {
    ok(name, error instanceof DecodeResourceError && error.code === code);
  }
}

/**
 * @param {DataView} view
 * @param {number} offset
 * @param {string} value
 */
function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

// The drag-and-drop DOM types (FileSystemEntry, FileList, DataTransfer) cannot
// be constructed under Node and their `filesystem` back-reference is circular,
// so each factory below builds the members collectDroppedFiles actually reads
// and states the DOM type it stands in for at one cast.

/**
 * @param {string} name
 * @param {File} file
 * @returns {FileSystemFileEntry}
 */
function fileEntry(name, file) {
  return /** @type {FileSystemFileEntry} */ (/** @type {unknown} */ ({
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    filesystem: {},
    /** @param {(file: File) => void} success */
    file(success) {
      queueMicrotask(() => success(file));
    },
  }));
}

/**
 * @param {string} name
 * @param {FileSystemEntry[][]} pages
 * @param {{ neverSettles?: boolean }} [options]
 * @returns {{ entry: FileSystemDirectoryEntry, state: { readCalls: number } }}
 */
function directoryEntry(name, pages, options = {}) {
  let pageIndex = 0;
  const state = { readCalls: 0 };
  return {
    entry: /** @type {FileSystemDirectoryEntry} */ (/** @type {unknown} */ ({
      isFile: false,
      isDirectory: true,
      name,
      fullPath: `/${name}`,
      filesystem: {},
      createReader() {
        return {
          /** @param {(entries: FileSystemEntry[]) => void} success */
          readEntries(success) {
            state.readCalls += 1;
            if (options.neverSettles) return;
            const page = pages[pageIndex] ?? [];
            pageIndex += 1;
            queueMicrotask(() => success(page));
          },
        };
      },
    })),
    state,
  };
}

/**
 * @param {File[]} files
 * @returns {FileList}
 */
function mockFileList(files) {
  return /** @type {FileList} */ (/** @type {unknown} */ ({
    ...files,
    length: files.length,
    /** @param {number} index */
    item(index) {
      return files[index] ?? null;
    },
  }));
}

/**
 * @param {FileSystemEntry} entry
 * @param {File[]} [flatFiles]
 * @returns {DataTransfer}
 */
function dataTransferForEntry(entry, flatFiles = []) {
  return /** @type {DataTransfer} */ (/** @type {unknown} */ ({
    files: mockFileList(flatFiles),
    items: {
      0: {
        kind: "file",
        type: "",
        webkitGetAsEntry: () => entry,
      },
      length: 1,
    },
  }));
}

console.log("\nTSX loader and analyzer helper contracts");
ok(
  "the loader imports the preset taxonomy TSX module",
  formatTargetLufs(-14) === "-14 LUFS",
  formatTargetLufs(-14),
);

const oneMiB = 1024 * 1024;
const constrainedHeavyBytes = withDeviceEnvironment(4, false, resolveHeavyFileBytes);
const capableHeavyBytes = withDeviceEnvironment(8, false, resolveHeavyFileBytes);
ok(
  "constrained devices lower the heavy-file threshold",
  constrainedHeavyBytes === 96 * oneMiB,
  `${constrainedHeavyBytes / oneMiB} MiB`,
);
ok(
  "capable devices retain the desktop heavy-file threshold",
  capableHeavyBytes === 256 * oneMiB,
  `${capableHeavyBytes / oneMiB} MiB`,
);

const conservativeRoutePeak = conservativeDecodePeakBytes(DEFAULT_DECODE_BUDGET);
const constrainedHelperAggregate = withDeviceEnvironment(4, false, () =>
  resolveAggregatePeakBytes(DEFAULT_DECODE_BUDGET));
const capableHelperAggregate = withDeviceEnvironment(8, false, () =>
  resolveAggregatePeakBytes(DEFAULT_DECODE_BUDGET));
ok(
  "constrained devices admit one conservative decode route",
  constrainedHelperAggregate === conservativeRoutePeak,
  `${constrainedHelperAggregate} bytes`,
);
ok(
  "capable devices admit two conservative decode routes",
  capableHelperAggregate === conservativeRoutePeak * 2,
  `${capableHelperAggregate} bytes`,
);

ok(
  "decode failures are normalized for the selected route",
  normalizeDecodeFailure("Decode failed", "compatibility-first").includes(
    "compatibility decoder",
  ),
);
ok(
  "analysis-stage corruption gets actionable copy",
  normalizeDecodeFailure("Non-finite sample at frame 3", "auto").includes(
    "audio data was empty or corrupt",
  ),
);
ok(
  "auto keeps compressed browser decoding available when a probe falls back",
  resolveBrowserFirstRoute("auto", "bounded.mp3", "audio/mpeg", true, false) &&
    resolveBrowserFirstRoute("auto", "opaque.mp3", "audio/mpeg", false, false),
);
ok(
  "browser-first keeps trusted WAV and AIFF sources on their native route",
  !resolveBrowserFirstRoute("browser-first", "layout.wav", "audio/wav", true, true) &&
    !resolveBrowserFirstRoute("browser-first", "layout.aiff", "audio/aiff", true, true),
);
ok(
  "unrelated failures pass through unchanged",
  normalizeDecodeFailure("synthetic failure", "auto") === "synthetic failure",
);

ok(
  "supported audio MIME types are accepted",
  isSupportedAudioFile(new File([], "untitled.bin", { type: "audio/x-custom" })),
);
ok(
  "known extensions are accepted without a MIME type",
  isSupportedAudioFile(new File([], "master.FLAC", { type: "" })),
);
ok(
  "unrelated dropped files are rejected",
  !isSupportedAudioFile(new File([], "notes.txt", { type: "text/plain" })),
);

const fingerprintJob = makeAnalysisJob({
  id: "history-1",
  fileName: "history.wav",
  status: "complete",
  result: makeAnalysisResult({
    analyzedAt: "2026-09-04T00:00:00.000Z",
    analysisMode: "measure-only",
    target: null,
    metrics: makeMetrics({
      integratedLufs: -14,
      integratedValid: true,
      truePeakDbtp: -1.25,
      loudnessRange: 3.5,
    }),
    metadata: makeAudioMetadata({
      sampleRate: 48_000,
      channelLayout: makeChannelLayout({ name: "Stereo" }),
      decoderLabel: "WAV parser",
    }),
  }),
});
const fingerprintResult = fingerprintJob.result ?? makeAnalysisResult();
const completedFingerprint = completedHistoryFingerprint([fingerprintJob]);
ok(
  "history fingerprints ignore unfinished jobs",
  completedHistoryFingerprint([
    fingerprintJob,
    makeAnalysisJob({ id: "queued", fileName: "queued.wav" }),
  ]) === completedFingerprint,
);
ok(
  "history fingerprints change with completed result data",
  completedHistoryFingerprint([
    {
      ...fingerprintJob,
      result: {
        ...fingerprintResult,
        metrics: { ...fingerprintResult.metrics, truePeakDbtp: -0.5 },
      },
    },
  ]) !== completedFingerprint,
);

console.log("\nDecode arithmetic and hard ceilings");
ok("checked decoded bytes use planar float32 size", checkedDecodedBytes(100, 2) === 800);
throwsCode("unsafe multiplication fails closed", "decoded-budget-exceeded", () =>
  checkedDecodedBytes(Number.MAX_SAFE_INTEGER, 2));
throwsCode("more than 32 channels is rejected", "channel-limit-exceeded", () =>
  assertDecodedFootprint(
    { frameCount: 1, channelCount: MAX_DECODE_CHANNELS + 1, sampleRate: 48000 },
    DEFAULT_DECODE_BUDGET,
  ));
throwsCode("source-byte cap is enforced", "source-budget-exceeded", () =>
  assertSourceWithinBudget(DEFAULT_DECODE_BUDGET.maxSourceBytes + 1, DEFAULT_DECODE_BUDGET));

const attemptedUnboundedBudget = resolveDecodeBudget({
  ...DEFAULT_DECODE_BUDGET,
  maxChannels: 999,
  maxDecodedBytes: Number.MAX_SAFE_INTEGER,
  maxOutputBytes: Number.MAX_SAFE_INTEGER,
});
ok("caller budgets cannot raise the 32-channel ceiling", attemptedUnboundedBudget.maxChannels === 32);
ok(
  "caller budgets are clamped to absolute byte ceilings",
  attemptedUnboundedBudget.maxDecodedBytes < Number.MAX_SAFE_INTEGER &&
    attemptedUnboundedBudget.maxOutputBytes < Number.MAX_SAFE_INTEGER,
);

const goodChannels = [new Float32Array(16), new Float32Array(16)];
ok(
  "matching planar output validates",
  validatePlanarChannels(
    goodChannels,
    { frameCount: 16, channelCount: 2, sampleRate: 48000 },
    DEFAULT_DECODE_BUDGET,
  ).decodedBytes === 128,
);
throwsCode("mismatched channel frames fail closed", "invalid-metadata", () =>
  validatePlanarChannels(
    [new Float32Array(16), new Float32Array(15)],
    { frameCount: 16, channelCount: 2, sampleRate: 48000 },
    DEFAULT_DECODE_BUDGET,
  ));

const timedController = new AbortController();
timedController.abort(new DecodeResourceError("time-limit-exceeded", "timed out"));
throwsCode("abort checkpoints preserve timeout causes", "time-limit-exceeded", () =>
  throwIfAborted(timedController.signal));
ok(
  "structured failure details preserve stable codes",
  decodeFailureDetails(new DecodeResourceError("decoder-busy", "busy", true)).code ===
    "decoder-busy",
);

console.log("\nPeak residency and aggregate admission");
ok(
  "native worker peak counts one planar PCM residency",
  decodePeakResidentBytes("native-worker", 1_000) === 1_000,
);
ok(
  "browser peak counts AudioBuffer plus planar copy",
  decodePeakResidentBytes("browser", 1_000) === 2_000,
);
ok(
  "compatibility peak counts source, two float-WAV copies, and planar PCM",
  decodePeakResidentBytes("compatibility-worker", 1_000, 1_100, 250) === 3_450,
);
throwsCode("peak byte addition fails closed on overflow", "decoded-budget-exceeded", () =>
  checkedResourceByteSum([Number.MAX_SAFE_INTEGER, 1]));

const conservativePeak = conservativeDecodePeakBytes(DEFAULT_DECODE_BUDGET);
ok(
  "conservative admission covers the larger browser/compatibility route",
  conservativePeak ===
    Math.max(
      DEFAULT_DECODE_BUDGET.maxDecodedBytes * 2,
      DEFAULT_DECODE_BUDGET.maxSourceBytes +
        DEFAULT_DECODE_BUDGET.maxDecodedBytes +
        DEFAULT_DECODE_BUDGET.maxOutputBytes * 2,
    ),
);
ok(
  "exclusive fallback can atomically grow a native reservation",
  growDecodePeakReservation(1_000, 1_000, conservativePeak, conservativePeak) ===
    conservativePeak,
);
throwsCode(
  "fallback growth fails before admission when another reservation consumes capacity",
  "decoded-budget-exceeded",
  () => growDecodePeakReservation(2_000, 1_000, conservativePeak, conservativePeak),
);
throwsCode(
  "aggregate admission rejects a route beyond the cap",
  "decoded-budget-exceeded",
  () => growDecodePeakReservation(conservativePeak, 0, 1, conservativePeak),
);

/** @type {(value: unknown) => void} */
let finishDecode = () => {};
const unabortableDecode = new Promise((resolve) => {
  finishDecode = resolve;
});
const browserCancel = new AbortController();
let wrapperSettled = false;
const drainedCancellation = waitForBrowserDecodeDrain(
  unabortableDecode,
  browserCancel.signal,
).finally(() => {
  wrapperSettled = true;
});
browserCancel.abort(new DecodeResourceError("cancelled", "test cancellation"));
await new Promise((resolve) => setTimeout(resolve, 0));
ok("browser cancellation does not release before decodeAudioData drains", !wrapperSettled);
finishDecode({ numberOfChannels: 2 });
let drainedCode = null;
try {
  await drainedCancellation;
} catch (error) {
  drainedCode = error instanceof DecodeResourceError ? error.code : null;
}
ok("drained browser decode then reports cancellation", wrapperSettled && drainedCode === "cancelled");

// A decodeAudioData promise that never settles (a documented WebKit/Blink
// failure mode) must not park the drain wrapper forever: once the signal has
// aborted, a bounded grace abandons the zombie decode so its window slot can be
// reclaimed instead of deadlocking every later browser decode (finding [3]). A
// short grace keeps the check fast.
{
  const neverSettles = new Promise(() => {});
  const zombieSignal = new AbortController();
  /** @type {unknown} */
  let zombieError = null;
  const zombieWait = waitForBrowserDecodeDrain(
    neverSettles,
    zombieSignal.signal,
    40,
  ).catch((error) => {
    zombieError = error;
  });
  const graceStarted = performance.now();
  // Abort AFTER the wrapper has parked on the never-settling decode, so the
  // bounded grace (not the entry guard) is what abandons it.
  zombieSignal.abort(new DecodeResourceError("cancelled", "user canceled"));
  await zombieWait;
  const graceElapsed = performance.now() - graceStarted;
  ok(
    "a never-settling browser decode is abandoned within the post-abort grace",
    isBrowserDecodeDrainTimeout(zombieError) &&
      zombieError instanceof DecodeResourceError &&
      zombieError.code === "time-limit-exceeded" &&
      graceElapsed < 500,
  );
}

// A normally-settling decode is unaffected by the grace: it resolves with its
// value and never triggers the drain timeout, even with a small grace set.
{
  const settles = Promise.resolve({ numberOfChannels: 2 });
  const idleSignal = new AbortController();
  let settledValue = null;
  let settleError = null;
  try {
    settledValue = await waitForBrowserDecodeDrain(settles, idleSignal.signal, 40);
  } catch (error) {
    settleError = error;
  }
  ok(
    "a normally-settling decode resolves unaffected by the drain grace",
    settleError === null &&
      settledValue != null &&
      settledValue.numberOfChannels === 2,
  );
}

// The grace only ever arms after an abort: a still-pending decode whose signal
// has not aborted keeps waiting past the grace window without a premature drain
// timeout, then returns its value once it finally settles.
{
  /** @type {(value: unknown) => void} */
  let releasePending = () => {};
  const pending = new Promise((resolve) => {
    releasePending = resolve;
  });
  const patientSignal = new AbortController();
  /** @type {{ value: { numberOfChannels: number } | null, errored: boolean }} */
  const outcome = { value: null, errored: false };
  const patientWait = waitForBrowserDecodeDrain(
    pending,
    patientSignal.signal,
    20,
  ).then(
    (value) => {
      outcome.value = value;
    },
    () => {
      outcome.errored = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  ok(
    "the drain grace stays disarmed until the signal aborts",
    outcome.errored === false && outcome.value === null,
  );
  releasePending({ numberOfChannels: 1 });
  await patientWait;
  ok(
    "an un-aborted slow decode still returns its value after it settles",
    outcome.errored === false &&
      outcome.value != null &&
      outcome.value.numberOfChannels === 1,
  );
}

// Browser decoding must use an offline context at the probed source rate and
// disclose the decoded PCM rate when the browser still returns another rate.
{
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  // Held on an object so the recorded request reads as its declared type after
  // the decode call below rather than staying narrowed to its initial null.
  /** @type {{ request: { channelCount: number, length: number, sampleRate: number } | null }} */
  const offline = { request: null };
  let realtimeContexts = 0;
  class FakeOfflineAudioContext {
    /**
     * @param {number} channelCount
     * @param {number} length
     * @param {number} sampleRate
     */
    constructor(channelCount, length, sampleRate) {
      offline.request = { channelCount, length, sampleRate };
    }

    async decodeAudioData() {
      return {
        numberOfChannels: 1,
        length: 4,
        sampleRate: 48_000,
        duration: 4 / 48_000,
        getChannelData: () => new Float32Array(4),
      };
    }
  }
  class FakeRealtimeAudioContext {
    constructor() {
      realtimeContexts += 1;
    }
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      AudioContext: FakeRealtimeAudioContext,
      OfflineAudioContext: FakeOfflineAudioContext,
      setTimeout,
      clearTimeout,
    },
  });
  try {
    const browserAsset = await decodeAudioFileInBrowser(
      new File([new Uint8Array(4)], "rate-check.mp3", { type: "audio/mpeg" }),
      undefined,
      new ArrayBuffer(4),
      {
        sourceMetadata: {
          sampleRate: 44_100,
          channelCount: 1,
          frameCount: 4,
          durationSeconds: 4 / 44_100,
          codecName: "MP3",
        },
      },
    );
    ok(
      "browser decode requests an OfflineAudioContext at the probed source rate",
      offline.request?.sampleRate === 44_100 &&
        offline.request?.channelCount === 1 &&
        realtimeContexts === 0,
    );
    ok(
      "browser decode reports a decoded-rate mismatch and analyzes that PCM rate",
      browserAsset.sampleRate === 48_000 &&
        browserAsset.warnings.some((warning) =>
          warning.includes("48,000 Hz") && warning.includes("44,100 Hz")),
    );
  } finally {
    if (windowDescriptor) {
      Object.defineProperty(globalThis, "window", windowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
}

console.log("\nContainer preflight");
const flac = inspectAudioContainer(encodeFlacHeader(48000, 2, 24, 96000));
ok(
  "FLAC STREAMINFO exposes checked footprint metadata",
  flac?.container === "flac" &&
    flac.frameCount === 96000 &&
    flac.channelCount === 2 &&
    !flac.nativeDecodeSafe,
);
const wav = inspectAudioContainer(
  encodeWav({ channels: silentChannels(2, 10), sampleRate: 44100, formatTag: 1 }),
);
ok(
  "WAVE fmt/data expose checked footprint metadata",
  wav?.container === "wav" &&
    wav.frameCount === 10 &&
    wav.sampleRate === 44100 &&
    wav.nativeDecodeSafe,
);
const aiff = inspectAudioContainer(
  encodeAiff({ channels: silentChannels(6, 24000), sampleRate: 48000, bitsPerSample: 24 }),
);
ok(
  "AIFF COMM exposes checked footprint metadata",
  aiff?.container === "aiff" &&
    aiff.frameCount === 24000 &&
    aiff.channelCount === 6 &&
    aiff.nativeDecodeSafe,
);
ok("truncated known metadata returns no optimistic estimate", inspectAudioContainer(new ArrayBuffer(11)) === null);

// The preflight must never authorize less than a decode will actually allocate.
// decodePcmToPlanar strides by channelCount * (bitsPerSample / 8) and never
// reads blockAlign, but blockAlign is an untrusted uint16 from `fmt `, so a file
// declaring an inflated one used to under-report the footprint by that ratio and
// the parser then committed the real, far larger buffers before validation ran.
/**
 * @param {number} payloadBytes
 * @param {number} blockAlign
 * @param {number} bitsPerSample
 * @param {number} channelCount
 */
function encodeHostileBlockAlignWave(payloadBytes, blockAlign, bitsPerSample, channelCount) {
  const buffer = new ArrayBuffer(44 + payloadBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, payloadBytes, true);
  return buffer;
}

// Moderate inflation: the OLD code returned a positive but 16x-too-small frame
// count here, so this case pins the under-reporting itself rather than the
// incidental "frameCount <= 0 -> null" rejection the extreme case trips.
{
  const payloadBytes = 8192;
  const hostile = inspectAudioContainer(encodeHostileBlockAlignWave(payloadBytes, 16, 8, 1));
  ok(
    "a 16x inflated blockAlign cannot under-report the WAVE decode footprint",
    hostile != null && hostile.frameCount === payloadBytes,
    `frameCount ${hostile ? hostile.frameCount : "null"} (parser allocates ${payloadBytes} frames)`,
  );
  ok(
    "a blockAlign inconsistent with channels x depth is still not native-decode safe",
    hostile != null && hostile.nativeDecodeSafe === false,
  );
}
// Extreme inflation, the originally reported case: uint16 max against 8-bit mono.
{
  const payloadBytes = 8192;
  const hostile = inspectAudioContainer(encodeHostileBlockAlignWave(payloadBytes, 65535, 8, 1));
  ok(
    "a uint16-max blockAlign cannot under-report the WAVE decode footprint",
    hostile != null && hostile.frameCount === payloadBytes,
    `frameCount ${hostile ? hostile.frameCount : "null"}`,
  );
}
// Multi-channel: the parser strides by channelCount * (bitDepth / 8), so the
// authorized frame count has to follow that, not the declared blockAlign.
{
  const payloadBytes = 8192;
  const hostile = inspectAudioContainer(encodeHostileBlockAlignWave(payloadBytes, 4096, 16, 2));
  ok(
    "an inflated blockAlign on stereo 16-bit reports the parser's own frame count",
    hostile != null && hostile.frameCount === payloadBytes / 4,
    `frameCount ${hostile ? hostile.frameCount : "null"}, expected ${payloadBytes / 4}`,
  );
}
// A well-formed file must keep the trusted fast path: min(blockAlign, stride)
// has to be a no-op whenever the two agree.
{
  const consistent = inspectAudioContainer(
    encodeWav({ channels: silentChannels(2, 1000), sampleRate: 48000, formatTag: 1 }),
  );
  ok(
    "a consistent blockAlign leaves the reported frame count unchanged",
    consistent != null && consistent.frameCount === 1000 && consistent.nativeDecodeSafe,
    `frameCount ${consistent ? consistent.frameCount : "null"}`,
  );
}

console.log("\nBounded folder traversal");
const firstFile = new File(["a"], "same.wav", { lastModified: 1 });
const secondFile = new File(["b"], "same.wav", { lastModified: 1 });
const pagedDirectory = directoryEntry("album", [
  [fileEntry("disc-1.wav", firstFile)],
  [fileEntry("disc-2.wav", secondFile)],
  [],
]);
const pagedResult = await collectDroppedFiles(
  dataTransferForEntry(pagedDirectory.entry),
  { maxFiles: 2, maxEntries: 10, maxDirectoryPages: 10, deadlineMs: 500 },
);
ok("file cap stops directory reads before another page", pagedDirectory.state.readCalls === 2);
ok("file cap is surfaced as truncation", pagedResult.files.length === 2 && pagedResult.truncated);
ok(
  "folder-relative identity is retained without copying File bytes",
  pagedResult.files[0] === firstFile &&
    getDroppedFileRelativePath(firstFile) === "album/disc-1.wav",
);

const plainFile = new File(["x"], "plain.wav", { lastModified: 2 });
const plainResult = await collectDroppedFiles(
  dataTransferForEntry(fileEntry("plain.wav", plainFile), [plainFile]),
  { maxFiles: 2, maxEntries: 4, deadlineMs: 500 },
);
ok(
  "plain-file basename is not promoted to relative-path identity",
  plainResult.files[0] === plainFile && getDroppedFileRelativePath(plainFile) === "",
);

const budgetFiles = Array.from({ length: 5 }, (_, index) =>
  fileEntry(`budget-${index}.wav`, new File([String(index)], `budget-${index}.wav`)));
const entryLimitedDirectory = directoryEntry("budget", [budgetFiles, []]);
const entryLimitedResult = await collectDroppedFiles(
  dataTransferForEntry(entryLimitedDirectory.entry),
  { maxFiles: 10, maxEntries: 3, maxDirectoryPages: 10, deadlineMs: 500 },
);
ok(
  "total entry budget stops inside the current page",
  entryLimitedResult.files.length === 2 && entryLimitedResult.truncated,
);
ok("entry exhaustion does not request another page", entryLimitedDirectory.state.readCalls === 1);

const hangingDirectory = directoryEntry("hanging", [], { neverSettles: true });
const deadlineStarted = performance.now();
const deadlineResult = await collectDroppedFiles(
  dataTransferForEntry(hangingDirectory.entry),
  { maxFiles: 10, maxEntries: 10, maxDirectoryPages: 10, deadlineMs: 25 },
);
const deadlineElapsed = performance.now() - deadlineStarted;
ok("unresponsive directory callbacks are deadline-bounded", deadlineElapsed < 250);
ok("deadline exhaustion is surfaced as truncation", deadlineResult.truncated);

const leaf = fileEntry("leaf.wav", new File(["leaf"], "leaf.wav"));
const inner = directoryEntry("inner", [[leaf], []]);
const outer = directoryEntry("outer", [[inner.entry], []]);
const depthResult = await collectDroppedFiles(
  dataTransferForEntry(outer.entry),
  { maxFiles: 10, maxEntries: 10, maxDepth: 1, maxDirectoryPages: 10, deadlineMs: 500 },
);
ok("directory depth is bounded", depthResult.files.length === 0 && depthResult.truncated);

// ---------------------------------------------------------------------------
// Adaptive per-job decode budget tiers. A 24-bit 192 kHz stereo master decodes
// well past the conservative 256 MiB tier (the reported real-world rejection
// was 373,669,696 bytes, about 4 minutes of stereo 192 kHz as float32), so
// devices with memory headroom must resolve the larger tier while constrained
// devices keep the conservative one.
console.log("\n[H] Adaptive decode-budget tiers");

const capableBudget = resolveAdaptiveDecodeBudget(8, false);
const constrainedBudget = resolveAdaptiveDecodeBudget(4, true);
const noSignalDesktopBudget = resolveAdaptiveDecodeBudget(null, false);
const noSignalPhoneBudget = resolveAdaptiveDecodeBudget(null, true);

ok(
  "8 GB devices resolve the large decode tier",
  capableBudget.maxDecodedBytes === LARGE_MEMORY_DECODE_BUDGET.maxDecodedBytes &&
    capableBudget.maxSourceBytes === LARGE_MEMORY_DECODE_BUDGET.maxSourceBytes &&
    capableBudget.maxOutputBytes === LARGE_MEMORY_DECODE_BUDGET.maxOutputBytes,
);
ok(
  "4 GB devices keep the conservative default tier",
  constrainedBudget.maxDecodedBytes === DEFAULT_DECODE_BUDGET.maxDecodedBytes,
);
ok(
  "no memory signal + fine pointer resolves the large tier (matches aggregate rule)",
  noSignalDesktopBudget.maxDecodedBytes === LARGE_MEMORY_DECODE_BUDGET.maxDecodedBytes,
);
ok(
  "no memory signal + coarse pointer keeps the conservative tier",
  noSignalPhoneBudget.maxDecodedBytes === DEFAULT_DECODE_BUDGET.maxDecodedBytes,
);
ok(
  "large tier stays within the hard ceilings",
  LARGE_MEMORY_DECODE_BUDGET.maxDecodedBytes <= HARD_DECODE_LIMITS.maxDecodedBytes &&
    LARGE_MEMORY_DECODE_BUDGET.maxSourceBytes <= HARD_DECODE_LIMITS.maxSourceBytes &&
    LARGE_MEMORY_DECODE_BUDGET.maxOutputBytes <= HARD_DECODE_LIMITS.maxOutputBytes &&
    LARGE_MEMORY_DECODE_BUDGET.maxDecodeMs <= HARD_DECODE_LIMITS.maxDecodeMs,
);

// The exact real-world rejection: 46,708,712 frames x 2 channels x 4 bytes =
// 373,669,696 decoded bytes at 192 kHz (about 4:03). Must pass on the large
// tier and still be rejected on the conservative tier.
const hiResFootprint = {
  frameCount: 46_708_712,
  channelCount: 2,
  sampleRate: 192_000,
};
ok(
  "hi-res 24-bit 192 kHz footprint (373,669,696 bytes) passes the large tier",
  assertDecodedFootprint(hiResFootprint, capableBudget).decodedBytes === 373_669_696,
);
throwsCode(
  "same footprint is still rejected on the conservative tier",
  "decoded-budget-exceeded",
  () => assertDecodedFootprint(hiResFootprint, constrainedBudget),
);

// Eleven minutes of stereo 192 kHz fits the large tier; the tier's own cap
// still rejects an hour-long 192 kHz master rather than allowing unbounded PCM.
ok(
  "11 minutes of stereo 192 kHz fits the large tier",
  assertDecodedFootprint(
    { frameCount: 660 * 192_000, channelCount: 2, sampleRate: 192_000 },
    capableBudget,
  ).decodedBytes <= capableBudget.maxDecodedBytes,
);
// An hour of stereo 192 kHz is 691.2 million frames (about 5.5 GB decoded), so
// the frame ceiling rejects it before the byte ceiling gets a look. Either
// budget code is a correct fail-closed outcome.
try {
  assertDecodedFootprint(
    { frameCount: 3600 * 192_000, channelCount: 2, sampleRate: 192_000 },
    capableBudget,
  );
  ok("an hour of stereo 192 kHz still exceeds the large tier", false);
} catch (error) {
  ok(
    "an hour of stereo 192 kHz still exceeds the large tier",
    error instanceof DecodeResourceError &&
      (error.code === "frame-limit-exceeded" || error.code === "decoded-budget-exceeded"),
  );
}

// ---------------------------------------------------------------------------
// Parallel admission. Header-slice preflight must classify large PCM masters
// without reading the whole file, known-footprint FLAC must reserve its exact
// browser-route peak, unknown formats must reserve the conservative peak, and
// the aggregate reservation cap must be what actually governs concurrency.
console.log("\n[I] Parallel admission planning");

/**
 * @param {number} sampleRate
 * @param {number} channelCount
 * @param {number} bitDepth
 * @param {number} frameCount
 */
function wavHeaderSlice(sampleRate, channelCount, bitDepth, frameCount) {
  const blockAlign = channelCount * (bitDepth / 8);
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return { buffer, totalBytes: 44 + dataBytes };
}

// The reported real-world file: 24-bit 192 kHz stereo, 46,708,712 frames.
const hiResFrames = 46_708_712;
const hiResWav = wavHeaderSlice(192_000, 2, 24, hiResFrames);
const hiResSliceMeta = inspectAudioContainer(hiResWav.buffer, hiResWav.totalBytes);
ok(
  "header slice of a 280 MiB PCM WAV classifies with totalBytes",
  hiResSliceMeta != null &&
    hiResSliceMeta.nativeDecodeSafe === true &&
    hiResSliceMeta.frameCount === hiResFrames &&
    hiResSliceMeta.sampleRate === 192_000,
);
ok(
  "the same slice without totalBytes stays unknown (strict whole-buffer rule)",
  inspectAudioContainer(hiResWav.buffer) === null,
);
const clampedWavMetadata = inspectAudioContainer(
  hiResWav.buffer,
  hiResWav.totalBytes - 1_000,
);
ok(
  "plain RIFF preflight clamps an oversized data length like the native parser",
  clampedWavMetadata?.container === "wav" &&
    clampedWavMetadata.frameCount === Math.floor((hiResFrames * 6 - 1_000) / 6),
);
const sentinelWavHeader = hiResWav.buffer.slice(0);
new DataView(sentinelWavHeader).setUint32(40, 0xffffffff, true);
ok(
  "plain RIFF preflight accepts the crashed-recorder data-size sentinel",
  inspectAudioContainer(sentinelWavHeader, hiResWav.totalBytes)?.frameCount === hiResFrames,
);
ok(
  "totalBytes smaller than the supplied buffer is rejected as inconsistent",
  inspectAudioContainer(hiResWav.buffer, 10) === null,
);

const capable = resolveAdaptiveDecodeBudget(8, false);
const aggregateCapable = checkedResourceByteSum([
  conservativeDecodePeakBytes(capable),
  conservativeDecodePeakBytes(capable),
]);
const heavyBytes = 256 * 1024 * 1024;
const hiResDecodedBytes = checkedDecodedBytes(hiResFrames, 2);

const nativeAdmission = planLaneAdmission({
  fileSizeBytes: hiResWav.totalBytes,
  heavyFileBytes: heavyBytes,
  browserFirst: false,
  plan: { kind: "known", decodedBytes: hiResDecodedBytes, trustedNative: true },
  budget: capable,
});
ok(
  "a 280 MiB trusted PCM WAV reserves 2x decoded bytes and is not exclusive",
  nativeAdmission.route === "native-worker" &&
    nativeAdmission.reservationPeakBytes ===
      decodePeakResidentBytes("browser", hiResDecodedBytes) &&
    nativeAdmission.exclusive === false,
);

const flacAdmission = planLaneAdmission({
  fileSizeBytes: 160 * 1024 * 1024,
  heavyFileBytes: heavyBytes,
  browserFirst: true,
  plan: { kind: "known", decodedBytes: hiResDecodedBytes, trustedNative: false },
  budget: capable,
});
ok(
  "known-footprint FLAC reserves its exact browser peak and is not exclusive",
  flacAdmission.route === "browser" &&
    flacAdmission.reservationPeakBytes ===
      decodePeakResidentBytes("browser", hiResDecodedBytes) &&
    flacAdmission.exclusive === false,
);

const mp3Admission = planLaneAdmission({
  fileSizeBytes: 12 * 1024 * 1024,
  heavyFileBytes: heavyBytes,
  browserFirst: true,
  plan: { kind: "unknown" },
  budget: capable,
});
ok(
  "unknown MP3 reserves the conservative peak instead of being exclusive",
  mp3Admission.reservationPeakBytes === conservativeDecodePeakBytes(capable) &&
    mp3Admission.exclusive === false,
);

const stubbedProbeMetadata = {
  sampleRate: 48_000,
  channelCount: 2,
  frameCount: 5 * 60 * 48_000,
  durationSeconds: 5 * 60,
  codecName: "MP3",
};
const probedPlan = planProbedDecodeFootprint(stubbedProbeMetadata, capable);
ok(
  "a bounded compressed probe produces a known decoded footprint",
  probedPlan.kind === "known" &&
    probedPlan.decodedBytes === checkedDecodedBytes(5 * 60 * 48_000, 2),
);
const probedCompatibilityAdmission = planLaneAdmission({
  fileSizeBytes: 5 * 1024 * 1024,
  heavyFileBytes: heavyBytes,
  browserFirst: false,
  plan: probedPlan.kind === "known"
    ? { kind: "known", decodedBytes: probedPlan.decodedBytes, trustedNative: false }
    : { kind: "unknown" },
  budget: capable,
});
ok(
  "known compressed compatibility admission uses source plus three decoded copies",
  probedPlan.kind === "known" &&
    probedCompatibilityAdmission.route === "compatibility-worker" &&
    probedCompatibilityAdmission.reservationPeakBytes ===
      5 * 1024 * 1024 +
        probedPlan.decodedBytes +
        (probedPlan.decodedBytes + COMPATIBILITY_WAV_HEADER_ALLOWANCE_BYTES) * 2,
);

const failedProbePlan = planProbedDecodeFootprint(null, capable);
ok(
  "a failed probe falls back to the conservative unknown-footprint plan",
  failedProbePlan.kind === "unknown" &&
    planLaneAdmission({
      fileSizeBytes: 5 * 1024 * 1024,
      heavyFileBytes: heavyBytes,
      browserFirst: false,
      plan: failedProbePlan,
      budget: capable,
    }).reservationPeakBytes === conservativeDecodePeakBytes(capable),
);
ok(
  "a probe above the frame tier cannot lower admission below conservative",
  planProbedDecodeFootprint(
    {
      sampleRate: 48_000,
      channelCount: 1,
      frameCount: 6_000 * 48_000,
      durationSeconds: 6_000,
      codecName: "Opus",
    },
    DEFAULT_DECODE_BUDGET,
  ).kind === "unknown",
);
throwsCode("probe field validation rejects non-numeric sample rates", "invalid-metadata", () =>
  validateDecodeProbeMetadata(
    { ...stubbedProbeMetadata, sampleRate: "48000" },
    capable,
  ));
throwsCode("probe field validation rejects frame counts below duration", "invalid-metadata", () =>
  validateDecodeProbeMetadata(
    { ...stubbedProbeMetadata, frameCount: stubbedProbeMetadata.frameCount - 1 },
    capable,
  ));

const heavyDecodedFrames = heavyBytes / Float32Array.BYTES_PER_ELEMENT;
const heavyProbedCompatibility = planLaneAdmission({
  fileSizeBytes: 24 * 1024 * 1024,
  heavyFileBytes: heavyBytes,
  browserFirst: false,
  plan: {
    kind: "known",
    decodedBytes: checkedDecodedBytes(heavyDecodedFrames, 1),
    trustedNative: false,
  },
  budget: capable,
});
ok(
  "compatibility jobs become exclusive at the decoded-size threshold",
  heavyProbedCompatibility.exclusive === true,
);
ok(
  "large unknown sources remain hard-exclusive",
  planLaneAdmission({
    fileSizeBytes: heavyBytes,
    heavyFileBytes: heavyBytes,
    browserFirst: true,
    plan: { kind: "unknown" },
    budget: capable,
  }).exclusive === true,
);
ok(
  "large sources with a known footprint are governed by reservations, not the barrier",
  planLaneAdmission({
    fileSizeBytes: heavyBytes,
    heavyFileBytes: heavyBytes,
    browserFirst: false,
    plan: { kind: "known", decodedBytes: hiResDecodedBytes, trustedNative: true },
    budget: capable,
  }).exclusive === false,
);

/**
 * @param {number} reservationBytes
 * @param {number} aggregateLimit
 * @param {number} attempts
 */
function countAdmissions(reservationBytes, aggregateLimit, attempts) {
  let total = 0;
  let admitted = 0;
  for (let index = 0; index < attempts; index += 1) {
    try {
      total = growDecodePeakReservation(total, 0, reservationBytes, aggregateLimit);
      admitted += 1;
    } catch {
      break;
    }
  }
  return admitted;
}

ok(
  "six 4-minute 24-bit 192 kHz FLACs use all capable-device lanes",
  countAdmissions(flacAdmission.reservationPeakBytes, aggregateCapable, 6) === 6,
);
const cdFlacDecoded = checkedDecodedBytes(4 * 60 * 44_100, 2);
ok(
  "six 4-minute CD-quality FLACs all run concurrently",
  countAdmissions(
    decodePeakResidentBytes("browser", cdFlacDecoded),
    aggregateCapable,
    6,
  ) === 6,
);
ok(
  "six 24-bit 192 kHz PCM WAVs use all capable-device lanes",
  countAdmissions(nativeAdmission.reservationPeakBytes, aggregateCapable, 6) === 6,
);
ok(
  "six 24-bit 96 kHz PCM WAVs all run concurrently",
  countAdmissions(
    decodePeakResidentBytes("browser", checkedDecodedBytes(4 * 60 * 96_000, 2)),
    aggregateCapable,
    6,
  ) === 6,
);
ok(
  "unknown-footprint jobs run two at once on a capable device",
  countAdmissions(mp3Admission.reservationPeakBytes, aggregateCapable, 3) === 2,
);
const constrained = resolveAdaptiveDecodeBudget(4, true);
ok(
  "unknown-footprint jobs stay serial on a constrained device",
  countAdmissions(
    conservativeDecodePeakBytes(constrained),
    conservativeDecodePeakBytes(constrained),
    2,
  ) === 1,
);

// ---------------------------------------------------------------------------
// Reservation contention classification. When a fallback/true-up route cannot
// grow its reservation, the scheduler must tell a momentarily full aggregate
// (transient: requeue and retry once the batch drains) apart from a route that
// can never fit the whole aggregate (permanent over-budget). This pure helper
// is what the hook's growLeasePeakReservation uses to make that call, so the
// contention branch is testable without a DOM.
console.log("\n[J] Reservation contention classification");

const capablePeak = conservativeDecodePeakBytes(capable);
const capableAggregate = checkedResourceByteSum([capablePeak, capablePeak]);

ok(
  "a conservative route that fits the empty aggregate is transient contention",
  classifyReservationContention(capablePeak, capableAggregate) === "retryable",
);
ok(
  "a reservation exactly equal to the whole aggregate is still transient (fits alone)",
  classifyReservationContention(capableAggregate, capableAggregate) === "retryable",
);
ok(
  "a reservation larger than the whole aggregate can never fit and is permanent",
  classifyReservationContention(capableAggregate + 1, capableAggregate) === "permanent",
);
ok(
  "a constrained single-route aggregate still admits its own conservative peak",
  classifyReservationContention(
    conservativeDecodePeakBytes(constrained),
    conservativeDecodePeakBytes(constrained),
  ) === "retryable",
);
throwsCode("contention classification validates its inputs", "invalid-metadata", () =>
  classifyReservationContention(0, capableAggregate));

// End to end with the aggregate model: a full two-route aggregate rejects a
// further conservative route, and that rejection classifies as retryable
// contention (the reservation would fit an empty batch) rather than a permanent
// over-budget. This mirrors the hook flipping a job back to "queued" instead of
// failing it when >=2 browser-first files contend for the fallback reservation.
let contendedCode = null;
try {
  growDecodePeakReservation(capableAggregate, 0, capablePeak, capableAggregate);
} catch (error) {
  contendedCode = error instanceof DecodeResourceError ? error.code : null;
}
ok("a full aggregate rejects a further conservative route", contendedCode === "decoded-budget-exceeded");
ok(
  "and that rejection is retryable contention, not permanent over-budget",
  classifyReservationContention(capablePeak, capableAggregate) === "retryable",
);

// ---------------------------------------------------------------------------
// FLAC footprint corroboration. FLAC is the only compressed container admitted
// on the strength of its declared STREAMINFO length, and the browser codec
// decodes every frame present regardless of that length. An under-declared
// header would hand admission a concurrency reservation far below the real
// decode, so with the pre-decode exclusive reservation removed several such
// files could decode at once and breach the aggregate peak cap before the
// post-decode footprint check fires. The scheduler corroborates the declared
// footprint against the file size before trusting it: a lossless decode is at
// least the compressed file's own size. This pure check is what lets the hook
// keep genuine high-resolution FLACs on the parallel known-footprint route
// while flipping an under-declared header to the conservative unknown plan.
console.log("\n[K] FLAC footprint corroboration");

// A genuine 24-bit/192 kHz stereo master (~4 min): STREAMINFO declares the true
// length, whose float32 decode dwarfs any realistically compressed file, so it
// stays trusted and keeps decoding in parallel with its peers.
const honestFlac = inspectAudioContainer(encodeFlacHeader(192000, 2, 24, 192000 * 240));
const honestFlacDecodedBytes = assertDecodedFootprint(
  requirePreflight(honestFlac, "Honest FLAC"),
  capable,
  "Honest FLAC",
).decodedBytes;
ok(
  "a genuine hi-res FLAC footprint is corroborated by a realistically compressed file",
  honestFlac?.container === "flac" &&
    declaredDecodeCorroboratedByFileSize(honestFlacDecodedBytes, 180 * 1024 * 1024) === true,
);

// The attack: STREAMINFO declares ~1024 samples (a few KiB decoded) but the file
// is hundreds of MiB. The declared footprint cannot account for the file's
// bytes, so it is not trusted and the hook falls back to the conservative plan.
const underDeclaredFlac = inspectAudioContainer(encodeFlacHeader(192000, 2, 24, 1024));
const underDeclaredDecodedBytes = assertDecodedFootprint(
  requirePreflight(underDeclaredFlac, "Under-declared FLAC"),
  capable,
  "Under-declared FLAC",
).decodedBytes;
ok(
  "an under-declared FLAC footprint is not corroborated against a large file",
  underDeclaredFlac?.container === "flac" &&
    declaredDecodeCorroboratedByFileSize(underDeclaredDecodedBytes, 512 * 1024 * 1024) === false,
);
ok(
  "a footprint that exactly matches the file size is corroborated (lossless floor)",
  declaredDecodeCorroboratedByFileSize(4 * 1024 * 1024, 4 * 1024 * 1024) === true,
);
ok(
  "a footprint one byte under the file size is not corroborated",
  declaredDecodeCorroboratedByFileSize(4 * 1024 * 1024 - 1, 4 * 1024 * 1024) === false,
);
throwsCode("footprint corroboration validates its declared bytes", "invalid-metadata", () =>
  declaredDecodeCorroboratedByFileSize(0, 4 * 1024 * 1024));
throwsCode("footprint corroboration validates its file size", "invalid-metadata", () =>
  declaredDecodeCorroboratedByFileSize(4 * 1024 * 1024, 0));

// ---------------------------------------------------------------------------
// Browser-decode window semaphore. Removing the pre-decode exclusive escalation
// removed the only serialization of browser-first decodes, so several files
// with an under-declared footprint could each allocate up to the browser peak
// inside decodeAudioData at once, transiently breaching the aggregate cap
// before the post-decode footprint check fires. This pure FIFO counting
// semaphore bounds how many browser decodes run concurrently to
// floor(aggregate / browserPeak), keeping the combined transient allocation
// inside the aggregate cap. It has no DOM dependency, so the hook's transient
// guard is exercised here directly.
console.log("\n[L] Browser-decode window semaphore");

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// FIFO order: one slot, two queued waiters served strictly in arrival order as
// the slot is released and re-released.
{
  const semaphore = createCountingSemaphore(1);
  /** @type {string[]} */
  const served = [];
  const releaseHeld = await semaphore.acquire();
  const first = semaphore.acquire().then((release) => {
    served.push("first");
    return release;
  });
  const second = semaphore.acquire().then((release) => {
    served.push("second");
    return release;
  });
  await flushMicrotasks();
  ok(
    "queued waiters stay parked while the only slot is held",
    served.length === 0 && semaphore.pending === 2 && semaphore.available === 0,
  );
  releaseHeld();
  const releaseFirst = await first;
  ok("the first waiter is served first (FIFO)", served.join(",") === "first");
  releaseFirst();
  const releaseSecond = await second;
  ok(
    "the second waiter is served only after the first (FIFO)",
    served.join(",") === "first,second",
  );
  releaseSecond();
  ok(
    "the slot returns to the pool once every holder releases",
    semaphore.available === 1 && semaphore.pending === 0,
  );
}

// Capacity respected: two slots are handed out immediately, a third waits until
// one is released, and the window never runs more than `capacity` at once.
{
  const semaphore = createCountingSemaphore(2);
  const releaseA = await semaphore.acquire();
  const releaseB = await semaphore.acquire();
  ok(
    "a two-slot window hands both slots out immediately",
    semaphore.available === 0 && semaphore.pending === 0,
  );
  // Tracked on an object so the flag reads as a boolean after the awaits below
  // rather than staying narrowed to its initial value.
  const thirdState = { ran: false };
  const third = semaphore.acquire().then((release) => {
    thirdState.ran = true;
    return release;
  });
  await flushMicrotasks();
  ok(
    "a third acquire waits while both slots are held",
    thirdState.ran === false && semaphore.pending === 1,
  );
  releaseA();
  const releaseThird = await third;
  ok(
    "releasing a slot admits exactly one waiter, never exceeding capacity",
    thirdState.ran === true && semaphore.available === 0 && semaphore.pending === 0,
  );
  releaseThird();
  releaseB();
  ok("both slots are free once all holders release", semaphore.available === 2);
}

// Abort while waiting: an aborted waiter leaves the FIFO queue without ever
// consuming a slot, so the held slot is still free when its holder releases and
// no waiter is stranded.
{
  const semaphore = createCountingSemaphore(1);
  const releaseHeld = await semaphore.acquire();
  const controller = new AbortController();
  let rejectionReason = null;
  const abortedWait = semaphore.acquire(controller.signal).then(
    () => "granted",
    (reason) => {
      rejectionReason = reason;
      return "rejected";
    },
  );
  await flushMicrotasks();
  ok("an acquire with no free slot joins the queue", semaphore.pending === 1);
  const reason = new Error("waiter aborted while queued");
  controller.abort(reason);
  ok(
    "aborting a queued waiter removes it from the queue at once",
    semaphore.pending === 0,
  );
  ok(
    "the aborted acquire rejects with the signal reason",
    (await abortedWait) === "rejected" && rejectionReason === reason,
  );
  releaseHeld();
  ok(
    "the aborted waiter consumed no slot, so releasing frees the window",
    semaphore.available === 1,
  );
  const releaseNext = await semaphore.acquire();
  ok("a fresh acquire then claims the freed slot", semaphore.available === 0);
  releaseNext();
}

// Release idempotence: a second release is a no-op and can never over-free a
// slot into a phantom extra holder.
{
  const semaphore = createCountingSemaphore(1);
  const release = await semaphore.acquire();
  ok("holding the only slot leaves none available", semaphore.available === 0);
  release();
  release();
  ok(
    "a repeated release does not over-free the window",
    semaphore.available === 1 && semaphore.capacity === 1,
  );
  const releaseBusy = await semaphore.acquire();
  let grantedHolders = 0;
  const queued = semaphore.acquire().then((next) => {
    grantedHolders += 1;
    return next;
  });
  await flushMicrotasks();
  releaseBusy();
  releaseBusy(); // idempotent: the second call must not grant a phantom holder
  const releaseQueued = await queued;
  await flushMicrotasks();
  ok(
    "a repeated release does not double-grant a waiter",
    grantedHolders === 1 && semaphore.available === 0,
  );
  releaseQueued();
}

// The legacy capacity helper remains internally consistent with the expanded
// compatibility-route aggregate. The hook now sizes its browser window from
// the lane limit because browser-bound sources carry checked probe footprints.
const capableWindowCapacity = Math.max(
  1,
  Math.floor(
    aggregateCapable /
      decodePeakResidentBytes("browser", capable.maxDecodedBytes),
  ),
);
const constrainedWindowCapacity = Math.max(
  1,
  Math.floor(
    conservativeDecodePeakBytes(constrained) /
      decodePeakResidentBytes("browser", constrained.maxDecodedBytes),
  ),
);
ok(
  "the browser-window formula follows the capable aggregate model",
  browserDecodeWindowCapacity(aggregateCapable, capable) === capableWindowCapacity,
);
ok(
  "the browser-window formula follows the constrained aggregate model",
  browserDecodeWindowCapacity(
    conservativeDecodePeakBytes(constrained),
    constrained,
  ) === constrainedWindowCapacity,
);
ok(
  "the window capacity floor is one even when the aggregate is below a browser peak",
  browserDecodeWindowCapacity(1, capable) === 1,
);
ok(
  "a window exactly one browser peak wide admits exactly one",
  browserDecodeWindowCapacity(
    decodePeakResidentBytes("browser", capable.maxDecodedBytes),
    capable,
  ) === 1,
);
ok(
  "setCapacity re-sizes the window in place when the aggregate is re-resolved",
  (() => {
    const semaphore = createCountingSemaphore(1);
    semaphore.setCapacity(browserDecodeWindowCapacity(aggregateCapable, capable));
    return (
      semaphore.capacity === capableWindowCapacity &&
      semaphore.available === capableWindowCapacity
    );
  })(),
);
