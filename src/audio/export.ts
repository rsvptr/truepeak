import { getComplianceSummary } from "@/audio/compliance";
import type { AnalysisJob } from "@/types/audio";

export type ExportFormat = "csv" | "json" | "markdown";

const EXPORT_BASENAME = "truepeak-analysis";
const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r\n]/;

interface CsvCell {
  value: string | number;
  neutralizeFormula?: boolean;
}

function csvText(value: string | number): CsvCell {
  return { value, neutralizeFormula: true };
}

function csvEscape(cell: string | number | CsvCell) {
  const value = typeof cell === "object" ? cell.value : cell;
  const shouldNeutralize = typeof cell === "object" && cell.neutralizeFormula;
  let serialized = String(value);
  if (shouldNeutralize && SPREADSHEET_FORMULA_PREFIX.test(serialized)) {
    serialized = `'${serialized}`;
  }

  if (
    serialized.includes(",") ||
    serialized.includes('"') ||
    serialized.includes("\n") ||
    serialized.includes("\r")
  ) {
    return `"${serialized.replaceAll('"', '""')}"`;
  }
  return serialized;
}

function completedJobs(jobs: AnalysisJob[]) {
  return jobs.filter((job) => job.result);
}

// Timestamped so repeated exports land as separate files instead of silently
// overwriting (or "(1)"-suffixing) the previous download.
function exportTimestamp(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function getExportFileName(format: ExportFormat) {
  const base = `${EXPORT_BASENAME}-${exportTimestamp()}`;
  switch (format) {
    case "csv":
      return `${base}.csv`;
    case "json":
      return `${base}.json`;
    case "markdown":
    default:
      return `${base}.md`;
  }
}

export function buildCsvExport(jobs: AnalysisJob[]) {
  const completed = completedJobs(jobs);
  const header = [
    "Filename",
    "Status",
    "Analysis Mode",
    "Target",
    "Target LUFS",
    "Tolerance LU",
    "Ceiling dBTP",
    "Compliance",
    "Integrated LUFS",
    "Ungated LUFS",
    "LRA LU",
    "Max Momentary LUFS",
    "Max Short-Term LUFS",
    "Sample Peak dBFS",
    "True Peak dBTP",
    "Target Gain dB",
    "Projected True Peak dBTP",
    "Sample Rate",
    "Channels",
    "Layout",
    "Decoder",
    "Analyzed At",
  ];

  const rows = completed.map((job) => {
    const result = job.result!;
    const compliance = getComplianceSummary(result);
    return [
      csvText(job.fileName),
      csvText(job.status),
      csvText(result.analysisMode),
      csvText(result.target?.label ?? ""),
      result.target?.loudnessTargetLufs?.toFixed(2) ?? "",
      result.target?.toleranceLufs?.toFixed(2) ?? "",
      result.target?.truePeakCeilingDbtp?.toFixed(2) ?? "",
      csvText(compliance?.label ?? ""),
      result.metrics.integratedLufs.toFixed(2),
      result.metrics.ungatedLufs.toFixed(2),
      result.metrics.loudnessRange.toFixed(2),
      result.metrics.maxMomentaryLufs?.toFixed(2) ?? "",
      result.metrics.maxShortTermLufs?.toFixed(2) ?? "",
      result.metrics.samplePeakDbfs.toFixed(2),
      result.metrics.truePeakDbtp.toFixed(2),
      result.metrics.targetDeltaDb?.toFixed(2) ?? "",
      result.metrics.projectedTruePeakDbtp?.toFixed(2) ?? "",
      result.metadata.sampleRate,
      result.metadata.channelCount,
      csvText(result.metadata.channelLayout.name),
      csvText(result.metadata.decoderLabel),
      csvText(result.analyzedAt),
    ]
      .map(csvEscape)
      .join(",");
  });

  return [header.join(","), ...rows].join("\n");
}

export function buildJsonExport(jobs: AnalysisJob[]) {
  return JSON.stringify(
    completedJobs(jobs).map((job) => ({
      id: job.id,
      fileName: job.fileName,
      status: job.status,
      analysisMode: job.result!.analysisMode,
      compliance: getComplianceSummary(job.result!),
      result: job.result,
    })),
    null,
    2,
  );
}

export function buildMarkdownExport(jobs: AnalysisJob[]) {
  const completed = completedJobs(jobs);
  const generatedAt = new Date().toISOString();

  const sections = completed.map((job) => {
    const result = job.result!;
    const compliance = getComplianceSummary(result);
    const targetLine = result.target
      ? `- Target: ${result.target.label} (${result.target.loudnessTargetLufs.toFixed(2)} LUFS, ceiling ${result.target.truePeakCeilingDbtp.toFixed(2)} dBTP)`
      : "- Target: Measure Only";
    const complianceLine = compliance
      ? `- Compliance: ${compliance.label}`
      : "- Compliance: Not applicable";
    const suggestedGainLine = result.metrics.targetDeltaDb == null
      ? "- Suggested Gain: n/a"
      : `- Suggested Gain: ${result.metrics.targetDeltaDb.toFixed(2)} dB`;
    const projectedPeakLine = result.metrics.projectedTruePeakDbtp == null
      ? "- Projected True Peak: n/a"
      : `- Projected True Peak: ${result.metrics.projectedTruePeakDbtp.toFixed(2)} dBTP`;

    return [
      `## ${job.fileName}`,
      `- Status: ${job.status}`,
      `- Analysis Mode: ${result.analysisMode}`,
      complianceLine,
      targetLine,
      `- Integrated: ${result.metrics.integratedLufs.toFixed(2)} LUFS`,
      `- True Peak: ${result.metrics.truePeakDbtp.toFixed(2)} dBTP`,
      `- Loudness Range: ${result.metrics.loudnessRange.toFixed(2)} LU`,
      suggestedGainLine,
      projectedPeakLine,
      `- Decoder: ${result.metadata.decoderLabel}`,
      `- Layout: ${result.metadata.channelLayout.name}`,
      `- Sample Rate: ${result.metadata.sampleRate} Hz`,
      `- Analyzed At: ${result.analyzedAt}`,
    ].join("\n");
  });

  return [
    "# TruePeak Analysis Report",
    "",
    `Generated: ${generatedAt}`,
    `Completed files: ${completed.length}`,
    "",
    ...sections,
  ].join("\n");
}
