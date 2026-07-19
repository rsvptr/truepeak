// Focused resource-safety contract checks for decode budgets and bounded folder
// traversal. Kept standalone so it can run before being wired into package.json.
//
// Run: node scripts/dsp/validate-runtime.mjs
import { register } from "node:module";
import { performance } from "node:perf_hooks";

register("./alias-loader.mjs", import.meta.url);

const {
  DEFAULT_DECODE_BUDGET,
  DecodeResourceError,
  HARD_DECODE_LIMITS,
  LARGE_MEMORY_DECODE_BUDGET,
  MAX_DECODE_CHANNELS,
  assertDecodedFootprint,
  assertSourceWithinBudget,
  checkedDecodedBytes,
  checkedResourceByteSum,
  conservativeDecodePeakBytes,
  decodePeakResidentBytes,
  decodeFailureDetails,
  growDecodePeakReservation,
  inspectAudioContainer,
  planLaneAdmission,
  resolveAdaptiveDecodeBudget,
  resolveDecodeBudget,
  throwIfAborted,
  validatePlanarChannels,
} = await import("../../src/audio/decode-budget.ts");
const {
  collectDroppedFiles,
  getDroppedFileRelativePath,
} = await import("../../src/lib/dropped-files.ts");
const { waitForBrowserDecodeDrain } = await import("../../src/audio/browser-decode.ts");

let passed = 0;
let failed = 0;

function ok(name, condition) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) passed += 1;
  else failed += 1;
}

function throwsCode(name, code, operation) {
  try {
    operation();
    ok(name, false);
  } catch (error) {
    ok(name, error instanceof DecodeResourceError && error.code === code);
  }
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeFlacHeader(sampleRate, channelCount, bitDepth, frameCount) {
  const buffer = new ArrayBuffer(42);
  const view = new DataView(buffer);
  writeAscii(view, 0, "fLaC");
  view.setUint8(4, 0x80);
  view.setUint8(7, 34);
  const byte10 = (sampleRate >> 12) & 0xff;
  const byte11 = (sampleRate >> 4) & 0xff;
  const byte12 =
    ((sampleRate & 0x0f) << 4) |
    (((channelCount - 1) & 0x07) << 1) |
    (((bitDepth - 1) >> 4) & 0x01);
  const byte13 = (((bitDepth - 1) & 0x0f) << 4) | Math.floor(frameCount / 2 ** 32);
  view.setUint8(18, byte10);
  view.setUint8(19, byte11);
  view.setUint8(20, byte12);
  view.setUint8(21, byte13);
  view.setUint32(22, frameCount >>> 0, false);
  return buffer;
}

function encodeWaveHeader(sampleRate, channelCount, frameCount) {
  const blockAlign = channelCount * 4;
  const dataBytes = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

function writeFloat80(view, offset, value) {
  const exponent = Math.floor(Math.log2(value));
  const mantissa = value / 2 ** exponent;
  view.setUint16(offset, 16383 + exponent, false);
  view.setUint32(offset + 2, Math.floor(mantissa * 2 ** 31), false);
  view.setUint32(offset + 6, 0, false);
}

function encodeAiffHeader(sampleRate, channelCount, frameCount) {
  const dataBytes = frameCount * channelCount * 3;
  const buffer = new ArrayBuffer(54 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "FORM");
  view.setUint32(4, buffer.byteLength - 8, false);
  writeAscii(view, 8, "AIFF");
  writeAscii(view, 12, "COMM");
  view.setUint32(16, 18, false);
  view.setUint16(20, channelCount, false);
  view.setUint32(22, frameCount, false);
  view.setUint16(26, 24, false);
  writeFloat80(view, 28, sampleRate);
  writeAscii(view, 38, "SSND");
  view.setUint32(42, 8 + dataBytes, false);
  view.setUint32(46, 0, false);
  view.setUint32(50, 0, false);
  return buffer;
}

function fileEntry(name, file) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    fullPath: `/${name}`,
    filesystem: {},
    file(success) {
      queueMicrotask(() => success(file));
    },
  };
}

function directoryEntry(name, pages, options = {}) {
  let pageIndex = 0;
  const state = { readCalls: 0 };
  return {
    entry: {
      isFile: false,
      isDirectory: true,
      name,
      fullPath: `/${name}`,
      filesystem: {},
      createReader() {
        return {
          readEntries(success) {
            state.readCalls += 1;
            if (options.neverSettles) return;
            const page = pages[pageIndex] ?? [];
            pageIndex += 1;
            queueMicrotask(() => success(page));
          },
        };
      },
    },
    state,
  };
}

function mockFileList(files) {
  return {
    length: files.length,
    item(index) {
      return files[index] ?? null;
    },
    ...files,
  };
}

function dataTransferForEntry(entry, flatFiles = []) {
  return {
    files: mockFileList(flatFiles),
    items: {
      0: {
        kind: "file",
        type: "",
        webkitGetAsEntry: () => entry,
      },
      length: 1,
    },
  };
}

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
  "compatibility peak counts float-WAV output plus planar PCM",
  decodePeakResidentBytes("compatibility-worker", 1_000, 1_100) === 2_100,
);
throwsCode("peak byte addition fails closed on overflow", "decoded-budget-exceeded", () =>
  checkedResourceByteSum([Number.MAX_SAFE_INTEGER, 1]));

const conservativePeak = conservativeDecodePeakBytes(DEFAULT_DECODE_BUDGET);
ok(
  "conservative admission covers the larger browser/compatibility route",
  conservativePeak ===
    Math.max(
      DEFAULT_DECODE_BUDGET.maxDecodedBytes * 2,
      DEFAULT_DECODE_BUDGET.maxDecodedBytes + DEFAULT_DECODE_BUDGET.maxOutputBytes,
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

let finishDecode;
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

console.log("\nContainer preflight");
const flac = inspectAudioContainer(encodeFlacHeader(48000, 2, 24, 96000));
ok(
  "FLAC STREAMINFO exposes checked footprint metadata",
  flac?.container === "flac" &&
    flac.frameCount === 96000 &&
    flac.channelCount === 2 &&
    !flac.nativeDecodeSafe,
);
const wav = inspectAudioContainer(encodeWaveHeader(44100, 2, 10));
ok(
  "WAVE fmt/data expose checked footprint metadata",
  wav?.container === "wav" &&
    wav.frameCount === 10 &&
    wav.sampleRate === 44100 &&
    wav.nativeDecodeSafe,
);
const aiff = inspectAudioContainer(encodeAiffHeader(48000, 6, 24000));
ok(
  "AIFF COMM exposes checked footprint metadata",
  aiff?.container === "aiff" &&
    aiff.frameCount === 24000 &&
    aiff.channelCount === 6 &&
    aiff.nativeDecodeSafe,
);
ok("truncated known metadata returns no optimistic estimate", inspectAudioContainer(new ArrayBuffer(11)) === null);

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
ok(
  "a declared payload larger than the real file is rejected",
  inspectAudioContainer(hiResWav.buffer, hiResWav.totalBytes - 1_000) === null,
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
  "five 4-minute 24-bit 192 kHz FLACs run concurrently on a capable device",
  countAdmissions(flacAdmission.reservationPeakBytes, aggregateCapable, 6) === 5,
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
  "five 24-bit 192 kHz PCM WAVs run concurrently on the native route",
  countAdmissions(nativeAdmission.reservationPeakBytes, aggregateCapable, 6) === 5,
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

console.log(`\n==== Runtime safety: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
