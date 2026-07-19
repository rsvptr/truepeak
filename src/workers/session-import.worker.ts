/// <reference lib="webworker" />

import {
  MAX_SESSION_FILE_BYTES,
  parseSessionFile,
} from "@/audio/session-file";
import type { AnalysisJob } from "@/types/audio";

interface SessionImportRequest {
  type: "import-session";
  file: File;
}

export type SessionImportWorkerResponse =
  | {
      type: "result";
      jobs: AnalysisJob[];
      sourceVersion?: number;
      sourceSessionDigest: string;
      error?: string;
    }
  | {
      type: "error";
      error: string;
    };

function digestToHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function post(message: SessionImportWorkerResponse) {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<SessionImportRequest>) => {
  if (event.data?.type !== "import-session") {
    post({ type: "error", error: "The session import request was malformed." });
    return;
  }

  const { file } = event.data;
  if (!(file instanceof File) || file.size <= 0) {
    post({ type: "error", error: "The selected session file is empty or invalid." });
    return;
  }
  if (file.size > MAX_SESSION_FILE_BYTES) {
    post({ type: "error", error: "That session file is too large to import safely." });
    return;
  }

  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_SESSION_FILE_BYTES) {
      post({ type: "error", error: "That session file is too large to import safely." });
      return;
    }

    const digestBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const sourceSessionDigest = `sha256:${digestToHex(digestBuffer)}`;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      post({ type: "error", error: "The session file is not valid UTF-8 text." });
      return;
    }

    const result = parseSessionFile(text, { sourceSessionDigest });
    post({
      type: "result",
      jobs: result.jobs,
      sourceVersion: result.sourceVersion,
      sourceSessionDigest,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    post({
      type: "error",
      error:
        error instanceof Error
          ? error.message
          : "The session file could not be read or validated.",
    });
  }
};

export {};
