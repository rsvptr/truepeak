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
    postMessageSafe({ type: "progress", jobId: message.jobId, progress: 0.15, label: "Preparing analysis windows" });
    const asset = fromTransferAsset(message.asset);
    postMessageSafe({ type: "progress", jobId: message.jobId, progress: 0.55, label: "Computing LUFS, LRA, and peak metrics" });
    const result = analyzeDecodedAsset(asset, message.target ?? null);
    postMessageSafe({ type: "result", jobId: message.jobId, result });
  } catch (error) {
    postMessageSafe({
      type: "error",
      jobId: message.jobId,
      error: error instanceof Error ? error.message : "Analysis failed.",
    });
  }
};
