import { analyzeDecodedAsset } from "@/audio/analysis";
import { fromTransferAsset } from "@/audio/serialise";
import type { AnalyzerRequest, AnalyzerResponse } from "@/workers/shared/messages";

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

function postMessageSafe(message: AnalyzerResponse) {
  ctx.postMessage(message);
}

ctx.onmessage = (event: MessageEvent<AnalyzerRequest>) => {
  const message = event.data;
  if (message.type !== "analyze") {
    return;
  }

  try {
    postMessageSafe({ type: "progress", jobId: message.jobId, progress: 0, label: "Preparing analysis windows" });
    const asset = fromTransferAsset(message.asset);
    // Forward real measurement progress as a 0..1 fraction; the UI maps it
    // into the job's overall progress band.
    const result = analyzeDecodedAsset(asset, message.target ?? null, (fraction) => {
      postMessageSafe({
        type: "progress",
        jobId: message.jobId,
        progress: fraction,
        label: "Measuring loudness, peaks, and dynamics",
      });
    });
    postMessageSafe({ type: "result", jobId: message.jobId, result });
  } catch (error) {
    postMessageSafe({
      type: "error",
      jobId: message.jobId,
      error: error instanceof Error ? error.message : "Analysis failed.",
    });
  }
};
