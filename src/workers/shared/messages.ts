import type { AnalysisResult, DecodedAudioTransfer, TargetPreset } from "@/types/audio";
import type { DecodeBudget, DecodeFailureCode } from "@/audio/decode-budget";

export type DecoderRequest =
  | {
      type: "decode";
      jobId: string;
      fileName: string;
      mimeType: string;
      // The worker reads the bytes itself so large files never occupy the main
      // thread (a File handle is cheap to clone; the data stays on disk until read).
      file: File;
      // Optional for compatibility with older callers. The worker always
      // resolves a bounded default and clamps supplied values to hard ceilings.
      budget?: DecodeBudget;
    }
  | {
      type: "cancel";
      jobId: string;
    };

export interface DecodeResourceUsage {
  sourceBytes: number;
  decodedBytes: number;
  outputBytes: number | null;
  channelCount: number;
  frameCount: number;
  elapsedMs: number;
}

export type DecoderResponse =
  | {
      type: "progress";
      jobId: string;
      progress: number;
      label: string;
    }
  | {
      type: "decoded";
      jobId: string;
      asset: DecodedAudioTransfer;
      usage: DecodeResourceUsage;
    }
  | {
      type: "error";
      jobId: string;
      error: string;
      code: DecodeFailureCode;
      retryable: boolean;
    };

export type AnalyzerRequest = {
  type: "analyze";
  jobId: string;
  asset: DecodedAudioTransfer;
  target?: TargetPreset | null;
};

export type AnalyzerResponse =
  | {
      type: "progress";
      jobId: string;
      progress: number;
      label: string;
    }
  | {
      type: "result";
      jobId: string;
      result: AnalysisResult;
    }
  | {
      type: "error";
      jobId: string;
      error: string;
    };
