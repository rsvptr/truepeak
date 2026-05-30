import type { AnalysisJob, AnalysisResult } from "@/types/audio";

// Portable session file: an open-JSON snapshot of a completed review that can be
// re-opened later as a read-only review (results only — the source audio is not
// included, so imported jobs can't be re-analyzed).
const SESSION_APP = "truepeak";
const SESSION_KIND = "session";
const SESSION_VERSION = 1;

export const SESSION_FILE_NAME = "truepeak-session.truepeak.json";

interface SessionFile {
  app: string;
  kind: string;
  version: number;
  exportedAt: string;
  jobCount: number;
  jobs: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    status: "complete";
    createdAt: string;
    progressPercent: number;
    progressLabel: string;
    result: AnalysisResult;
  }>;
}

export function buildSessionFile(jobs: AnalysisJob[]): string {
  const completed = jobs.filter((job): job is AnalysisJob & { result: AnalysisResult } => job.result != null);
  const payload: SessionFile = {
    app: SESSION_APP,
    kind: SESSION_KIND,
    version: SESSION_VERSION,
    exportedAt: new Date().toISOString(),
    jobCount: completed.length,
    jobs: completed.map((job) => ({
      id: job.id,
      fileName: job.fileName,
      mimeType: job.mimeType,
      status: "complete",
      createdAt: job.createdAt,
      progressPercent: 1,
      progressLabel: "Complete",
      result: job.result,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Imported files are untrusted, so validate the shape the UI actually reads
// before accepting a job. Returns the result object as-is when valid, null otherwise.
function validateResult(raw: unknown): AnalysisResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const result = raw as Record<string, unknown>;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const metrics = result.metrics as Record<string, unknown> | undefined;

  if (!metadata || typeof metadata !== "object") return null;
  if (!metrics || typeof metrics !== "object") return null;
  if (result.analysisMode !== "targeted" && result.analysisMode !== "measure-only") return null;
  if (typeof result.analyzedAt !== "string") return null;

  if (
    !isFiniteNumber(metrics.integratedLufs) ||
    !isFiniteNumber(metrics.truePeakDbtp) ||
    !isFiniteNumber(metrics.samplePeakDbfs) ||
    !isFiniteNumber(metrics.loudnessRange)
  ) {
    return null;
  }

  const timeline = metrics.timeline as Record<string, unknown> | undefined;
  if (
    !timeline ||
    typeof timeline !== "object" ||
    !Array.isArray(timeline.timeSeconds) ||
    !Array.isArray(timeline.momentaryLufs) ||
    !Array.isArray(timeline.shortTermLufs) ||
    !Array.isArray(timeline.truePeakDbtp)
  ) {
    return null;
  }

  const channelLayout = metadata.channelLayout as Record<string, unknown> | undefined;
  if (
    !isFiniteNumber(metadata.sampleRate) ||
    !channelLayout ||
    typeof channelLayout !== "object" ||
    typeof channelLayout.name !== "string"
  ) {
    return null;
  }

  return raw as AnalysisResult;
}

export interface SessionImportResult {
  jobs: AnalysisJob[];
  error?: string;
}

export function parseSessionFile(text: string): SessionImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { jobs: [], error: "This file is not valid JSON." };
  }

  if (!data || typeof data !== "object") {
    return { jobs: [], error: "This is not a TruePeak session file." };
  }

  const envelope = data as Record<string, unknown>;
  if (envelope.app !== SESSION_APP || envelope.kind !== SESSION_KIND) {
    return { jobs: [], error: "This is not a TruePeak session file." };
  }
  if (envelope.version !== SESSION_VERSION) {
    return { jobs: [], error: `Unsupported session file version (${String(envelope.version)}).` };
  }
  if (!Array.isArray(envelope.jobs)) {
    return { jobs: [], error: "The session file does not contain any analyses." };
  }

  const jobs: AnalysisJob[] = [];
  for (const entry of envelope.jobs) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.fileName !== "string") continue;
    const result = validateResult(raw.result);
    if (!result) continue;

    jobs.push({
      id: raw.id,
      fileName: raw.fileName,
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "",
      status: "complete",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : result.analyzedAt,
      progressPercent: 1,
      progressLabel: "Imported",
      imported: true,
      result,
    });
  }

  if (!jobs.length) {
    return { jobs: [], error: "No valid analyses were found in the session file." };
  }

  return { jobs };
}
