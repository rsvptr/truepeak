import type { AnalysisResult, DecodedAudioTransfer, TargetPreset } from "@/types/audio";

export type DecoderRequest = {
  type: "decode";
  jobId: string;
  fileName: string;
  mimeType: string;
  // The worker reads the bytes itself so large files never occupy the main
  // thread (a File handle is cheap to clone; the data stays on disk until read).
  file: File;
};

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
    }
  | {
      type: "error";
      jobId: string;
      error: string;
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
