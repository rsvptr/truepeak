import type { AnalysisResult, DecodedAudioTransfer, TargetPreset } from "@/types/audio";

export type DecoderRequest = {
  type: "decode";
  jobId: string;
  fileName: string;
  mimeType: string;
  buffer: ArrayBuffer;
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
