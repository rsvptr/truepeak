import {
  iterateContainerChunks,
  readAscii,
  readExtendedFloat80,
  readSafeUint64,
} from "@/audio/container-chunks";
import type { AudioContainerPreflight } from "@/audio/decode-budget-core";

function inspectFlac(view: DataView): AudioContainerPreflight | null {
  if (view.byteLength < 8 || readAscii(view, 0, 4) !== "fLaC") {
    return null;
  }

  let offset = 4;
  let blocksVisited = 0;
  while (offset + 4 <= view.byteLength && blocksVisited < 128) {
    const blockType = view.getUint8(offset) & 0x7f;
    const blockLength =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);
    offset += 4;
    blocksVisited += 1;
    if (blockLength > view.byteLength - offset) {
      return null;
    }

    if (blockType === 0) {
      if (blockLength < 34 || offset + 34 > view.byteLength) {
        return null;
      }

      const byte10 = view.getUint8(offset + 10);
      const byte11 = view.getUint8(offset + 11);
      const byte12 = view.getUint8(offset + 12);
      const byte13 = view.getUint8(offset + 13);
      const sampleRate = (byte10 << 12) | (byte11 << 4) | (byte12 >> 4);
      const channelCount = ((byte12 >> 1) & 0x07) + 1;
      const bitDepth = (((byte12 & 0x01) << 4) | (byte13 >> 4)) + 1;
      const frameCount = (byte13 & 0x0f) * 2 ** 32 + view.getUint32(offset + 14, false);
      if (
        !Number.isSafeInteger(sampleRate) ||
        sampleRate <= 0 ||
        !Number.isSafeInteger(channelCount) ||
        channelCount <= 0 ||
        !Number.isSafeInteger(bitDepth) ||
        bitDepth <= 0 ||
        !Number.isSafeInteger(frameCount) ||
        frameCount <= 0
      ) {
        return null;
      }

      return {
        container: "flac",
        sampleRate,
        channelCount,
        bitDepth,
        frameCount,
        durationSeconds: frameCount / sampleRate,
        nativeDecodeSafe: false,
      };
    }

    offset += blockLength;
  }

  return null;
}

function inspectWave(view: DataView, totalBytes: number): AudioContainerPreflight | null {
  if (view.byteLength < 12) {
    return null;
  }
  const signature = readAscii(view, 0, 4);
  if (
    (signature !== "RIFF" && signature !== "RF64") ||
    readAscii(view, 8, 4) !== "WAVE"
  ) {
    return null;
  }

  let fmt: { offset: number; size: number } | null = null;
  let dataBytes: number | null = null;
  let rf64DataBytes: number | null = null;
  let rf64NativeStructureSafe = signature !== "RF64";
  let ds64Seen = false;

  for (const chunk of iterateContainerChunks(view, {
    startOffset: 12,
    totalBytes,
    littleEndian: true,
    resolveSize: (id, declaredSize) =>
      id === "data" && signature === "RF64" && declaredSize === 0xffffffff
        ? rf64DataBytes
        : declaredSize,
  })) {
    if (chunk.id === "ds64" && !ds64Seen) {
      ds64Seen = true;
      rf64DataBytes =
        chunk.declaredSize >= 28 && chunk.dataOffset + 28 <= view.byteLength
          ? readSafeUint64(view, chunk.dataOffset + 8, true)
          : null;
      rf64NativeStructureSafe =
        chunk.declaredSize >= 28 &&
        chunk.dataOffset + 28 <= view.byteLength &&
        rf64DataBytes != null;
    } else if (chunk.id === "fmt " && fmt == null) {
      fmt = { offset: chunk.dataOffset, size: chunk.declaredSize };
    } else if (chunk.id === "data" && dataBytes == null) {
      // The declared audio payload must fit inside the real file, not inside
      // the (possibly partial) header slice that was handed to the inspector.
      // This is what lets a 256 KiB preflight slice of a multi-hundred-MiB
      // PCM master produce a trusted, bounded plan. Plain RIFF matches the
      // native parser's best-effort clamp for crashed-recorder/streaming files
      // whose 32-bit data length runs past EOF. RF64 remains fail-closed because
      // its ds64 size is the authoritative 64-bit length.
      if (chunk.size == null || chunk.size <= 0) {
        return null;
      }
      const availableDataBytes = totalBytes - chunk.dataOffset;
      if (availableDataBytes <= 0) {
        return null;
      }
      if (chunk.size > availableDataBytes) {
        if (signature === "RF64") {
          return null;
        }
        dataBytes = availableDataBytes;
      } else {
        dataBytes = chunk.size;
      }
    }

    // This is the same first-wins latch and order-independent stopping rule as
    // parseWavBuffer, so later duplicate fmt chunks cannot change the budget.
    if (fmt && dataBytes != null) {
      break;
    }
  }

  if (!fmt || fmt.size < 16 || fmt.offset + 16 > view.byteLength) {
    return null;
  }
  const formatTag = view.getUint16(fmt.offset, true);
  const channelCount = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const blockAlign = view.getUint16(fmt.offset + 12, true);
  const bitDepth = view.getUint16(fmt.offset + 14, true);
  if (
    channelCount <= 0 ||
    sampleRate <= 0 ||
    bitDepth <= 0 ||
    blockAlign <= 0 ||
    dataBytes == null ||
    dataBytes <= 0
  ) {
    return null;
  }

  // The authorized footprint must never sit below what a decode actually
  // allocates. decodePcmToPlanar (wav.ts) strides by channelCount *
  // (bitsPerSample / 8) and never reads blockAlign at all, but blockAlign is an
  // untrusted uint16 out of `fmt `, so sizing frames by it alone let a file
  // declaring blockAlign 65535 against 8-bit mono PCM under-report by 65536x -
  // the parser then committed the real, far larger Float32Arrays before
  // validateNativeAsset could reject the mismatch. Take whichever stride yields
  // the LARGER frame count. For a well-formed file the two are equal, so the
  // trusted-footprint fast path is unchanged; only inconsistent containers get
  // the more conservative plan. nativeDecodeSafe is not a substitute for this:
  // it only feeds planLaneAdmission's scheduling decision and never gates
  // whether parseWavBuffer runs, so the footprint itself has to be honest.
  const parserStride = channelCount * (bitDepth / 8);
  const stride = parserStride > 0 ? Math.min(blockAlign, parserStride) : blockAlign;
  const frameCount = Math.floor(dataBytes / stride);
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return null;
  }

  return {
    container: signature === "RF64" ? "rf64" : "wav",
    sampleRate,
    channelCount,
    bitDepth,
    frameCount,
    durationSeconds: frameCount / sampleRate,
    nativeDecodeSafe:
      formatTag === 0x0001 &&
      rf64NativeStructureSafe &&
      (bitDepth === 8 || bitDepth === 16 || bitDepth === 24 || bitDepth === 32) &&
      blockAlign === channelCount * (bitDepth / 8),
  };
}

function inspectAiff(view: DataView, totalBytes: number): AudioContainerPreflight | null {
  if (view.byteLength < 12 || readAscii(view, 0, 4) !== "FORM") {
    return null;
  }
  const formType = readAscii(view, 8, 4);
  if (formType !== "AIFF" && formType !== "AIFC") {
    return null;
  }

  let comm: { offset: number; size: number } | null = null;
  let ssnd: { offset: number; size: number } | null = null;
  for (const chunk of iterateContainerChunks(view, {
    startOffset: 12,
    totalBytes,
    littleEndian: false,
  })) {
    if (chunk.id === "COMM" && comm == null) {
      comm = { offset: chunk.dataOffset, size: chunk.declaredSize };
    } else if (chunk.id === "SSND" && ssnd == null) {
      ssnd = { offset: chunk.dataOffset, size: chunk.declaredSize };
    }

    // First COMM and first SSND win on both sides of the boundary. Stop once
    // both are selected even when SSND appears before COMM.
    if (comm && ssnd) {
      break;
    }
  }

  if (
    !comm ||
    comm.size < 18 ||
    comm.offset + 18 > view.byteLength ||
    !ssnd ||
    ssnd.size < 8 ||
    ssnd.offset + 8 > view.byteLength
  ) {
    return null;
  }

  const channelCount = view.getUint16(comm.offset, false);
  const frameCount = view.getUint32(comm.offset + 2, false);
  const bitDepth = view.getUint16(comm.offset + 6, false);
  const sampleRate = readExtendedFloat80(view, comm.offset + 8);
  if (
    channelCount <= 0 ||
    frameCount <= 0 ||
    bitDepth <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return null;
  }

  let compressionType = formType === "AIFF" ? "NONE" : "";
  if (formType === "AIFC") {
    if (comm.size < 22 || comm.offset + 22 > view.byteLength) {
      return null;
    }
    compressionType = readAscii(view, comm.offset + 18, 4);
  }

  const soundDataOffset = view.getUint32(ssnd.offset, false);
  if (soundDataOffset > ssnd.size - 8) {
    return null;
  }
  const soundDataBytes = ssnd.size - 8 - soundDataOffset;

  const integerPcmCompression =
    compressionType === "NONE" ||
    compressionType === "twos" ||
    compressionType === "sowt";
  const supportedIntegerDepth =
    bitDepth === 8 || bitDepth === 16 || bitDepth === 24 || bitDepth === 32;
  const bytesPerFrame = channelCount * (bitDepth / 8);
  const expectedAudioBytes =
    Number.isSafeInteger(bytesPerFrame) &&
    bytesPerFrame > 0 &&
    frameCount <= Math.floor(Number.MAX_SAFE_INTEGER / bytesPerFrame)
      ? frameCount * bytesPerFrame
      : null;

  return {
    container: formType === "AIFC" ? "aifc" : "aiff",
    sampleRate,
    channelCount,
    bitDepth,
    frameCount,
    durationSeconds: frameCount / sampleRate,
    nativeDecodeSafe:
      Number.isInteger(sampleRate) &&
      integerPcmCompression &&
      supportedIntegerDepth &&
      expectedAudioBytes != null &&
      soundDataBytes >= expectedAudioBytes,
  };
}

/**
 * Inspects a container header. `totalBytes` is the size of the complete file
 * the buffer was sliced from; it defaults to the buffer's own length, which
 * preserves the strict whole-buffer behavior for callers that hold the full
 * file (the decode workers and the fail-closed parser fixtures). Passing the
 * real file size lets a partial header slice of a large PCM WAV/AIFF validate
 * its declared payload bounds without reading the whole file.
 */
export function inspectAudioContainer(
  buffer: ArrayBuffer,
  totalBytes = buffer.byteLength,
): AudioContainerPreflight | null {
  const view = new DataView(buffer);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < view.byteLength) {
    return null;
  }
  return inspectFlac(view) ?? inspectWave(view, totalBytes) ?? inspectAiff(view, totalBytes);
}

