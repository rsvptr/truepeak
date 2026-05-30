import { deriveChannelLayout } from "@/audio/channel-layout";
import { toTransferAsset } from "@/audio/serialise";
import type { DecodedAudioTransfer, SourceFormat } from "@/types/audio";

const WAVE_EXTENSIONS = new Set(["wav", "rf64"]);
const AIFF_EXTENSIONS = new Set(["aif", "aiff", "aifc"]);
const numberFormatter = new Intl.NumberFormat("en-GB");

interface FlacStreamInfo {
  sampleRate: number;
  channelCount: number;
  bitDepth: number;
  frameCount: number;
  durationSeconds: number;
}

function inferSourceFormat(fileName: string): SourceFormat {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension === "wav") {
    return "wav";
  }

  if (extension === "rf64") {
    return "rf64";
  }

  if (extension === "aif" || extension === "aiff") {
    return "aiff";
  }

  if (extension === "aifc") {
    return "aifc";
  }

  return "browser-decoded";
}

export function shouldPreferBrowserDecoder(fileName: string, mimeType: string) {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const lowerMime = mimeType.toLowerCase();

  if (WAVE_EXTENSIONS.has(extension) || AIFF_EXTENSIONS.has(extension)) {
    return false;
  }

  if (lowerMime.includes("wav") || lowerMime.includes("aiff")) {
    return false;
  }

  return true;
}

function getAudioContextConstructor() {
  const candidate =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!candidate) {
    throw new Error("This browser does not expose a Web Audio decoder.");
  }

  return candidate;
}

function readAscii(view: DataView, offset: number, length: number) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(view.getUint8(offset + index));
  }
  return out;
}

function parseFlacStreamInfo(buffer: ArrayBuffer): FlacStreamInfo | null {
  if (buffer.byteLength < 42) {
    return null;
  }

  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== "fLaC") {
    return null;
  }

  let offset = 4;
  while (offset + 4 <= view.byteLength) {
    const blockType = view.getUint8(offset) & 0x7f;
    const blockLength =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);
    offset += 4;

    if (offset + blockLength > view.byteLength) {
      return null;
    }

    if (blockType === 0) {
      if (blockLength < 34) {
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

      if (sampleRate <= 0 || channelCount <= 0 || bitDepth <= 0 || frameCount <= 0) {
        return null;
      }

      return {
        sampleRate,
        channelCount,
        bitDepth,
        frameCount,
        durationSeconds: frameCount / sampleRate,
      };
    }

    offset += blockLength;
  }

  return null;
}

function createAudioContext(
  AudioContextConstructor: typeof AudioContext,
  sourceMetadata: FlacStreamInfo | null,
) {
  if (sourceMetadata?.sampleRate) {
    try {
      return {
        context: new AudioContextConstructor({ sampleRate: sourceMetadata.sampleRate }),
        requestedSourceRate: true,
      };
    } catch {
      // Some browsers expose the options bag but reject specific rates. Fall back to default decode behaviour.
    }
  }

  return {
    context: new AudioContextConstructor(),
    requestedSourceRate: false,
  };
}

export async function decodeAudioFileInBrowser(
  file: File,
  primaryError?: string,
  sourceBuffer?: ArrayBuffer,
): Promise<DecodedAudioTransfer> {
  const AudioContextConstructor = getAudioContextConstructor();
  let context: AudioContext | null = null;

  try {
    const input = sourceBuffer ?? await file.arrayBuffer();
    const sourceMetadata = parseFlacStreamInfo(input);
    const contextState = createAudioContext(AudioContextConstructor, sourceMetadata);
    context = contextState.context;
    const decoded = await context.decodeAudioData(input);
    const channelCount = decoded.numberOfChannels;
    const channels = Array.from({ length: channelCount }, (_, index) =>
      new Float32Array(decoded.getChannelData(index)),
    );

    const decodeNotes = [
      "Decoded with the browser audio decoder. Container-level metadata may be reduced compared with the dedicated container parser.",
    ];
    const warnings: string[] = [];
    if (primaryError) {
      decodeNotes.unshift(`Fallback used after another decoder failed: ${primaryError}`);
    }
    if (sourceMetadata) {
      decodeNotes.push(
        `FLAC STREAMINFO reports ${numberFormatter.format(sourceMetadata.sampleRate)} Hz, ${sourceMetadata.bitDepth}-bit, ${sourceMetadata.channelCount} channel${sourceMetadata.channelCount === 1 ? "" : "s"}.`,
      );
      if (contextState.requestedSourceRate) {
        decodeNotes.push(
          `Requested browser decoding at the source sample rate of ${numberFormatter.format(sourceMetadata.sampleRate)} Hz.`,
        );
      }
      if (decoded.sampleRate !== sourceMetadata.sampleRate) {
        warnings.push(
          `Browser decoder returned ${numberFormatter.format(decoded.sampleRate)} Hz after source metadata reported ${numberFormatter.format(sourceMetadata.sampleRate)} Hz; analysis uses the decoded PCM sample rate.`,
        );
      }
      if (decoded.numberOfChannels !== sourceMetadata.channelCount) {
        warnings.push(
          `Browser decoder returned ${decoded.numberOfChannels} channel${decoded.numberOfChannels === 1 ? "" : "s"} after source metadata reported ${sourceMetadata.channelCount}.`,
        );
      }
    }

    return toTransferAsset({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      sourceFormat: inferSourceFormat(file.name),
      sampleRate: decoded.sampleRate,
      bitDepth: sourceMetadata?.bitDepth ?? 32,
      durationSeconds: decoded.duration,
      frameCount: decoded.length,
      channelCount,
      channelLayout: deriveChannelLayout(channelCount, null),
      decoderMode: "browser-audio",
      decoderLabel: "Browser audio decoder",
      decoderSummary: "Decoded through the browser codec stack for fast in-browser compatibility.",
      decodeNotes,
      warnings,
      channels,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : "The browser decoder could not read this audio file.",
    );
  } finally {
    void context?.close().catch(() => undefined);
  }
}
