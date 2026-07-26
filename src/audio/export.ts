import { getComplianceSummary } from "@/audio/compliance";
import { resolveAnalysisProvenance } from "@/audio/session-file";
import { fileNameTimestamp } from "@/lib/format";
import type {
  AnalysisJob,
  AnalysisProvenance,
  IntegratedInvalidReason,
  LoudnessMetrics,
} from "@/types/audio";

export type ExportFormat = "csv" | "json" | "markdown";
export type IntegratedMeasurementStatus = "valid" | "invalid" | "legacy-unknown";

export interface IntegratedMeasurementPresentation {
  status: IntegratedMeasurementStatus;
  valueLufs: number | null;
  rawIntegratedLufs: number;
  invalidReason: IntegratedInvalidReason | null;
  invalidReasonLabel: string | null;
}

const EXPORT_BASENAME = "truepeak-analysis";
// Excel on Windows opens a double-clicked .csv using the system ANSI codepage
// (e.g. Windows-1252) unless the file begins with a UTF-8 byte-order mark, which
// mojibakes any non-ASCII cell such as a "Café Été.wav" filename. The Blob's
// `charset=utf-8` MIME type does not influence a locally-saved file, so the BOM
// must live in the bytes. It is scoped to CSV only: JSON must not carry a BOM
// (strict parsers reject it) and Markdown does not need one.
const UTF8_BOM = "\uFEFF";
const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r\n]/;
const UNVERIFIED_IMPORT_WARNING =
  "Unverified imported result; re-analyze the source audio before relying on it for compliance or delivery.";

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
  return jobs.filter(
    (job): job is AnalysisJob & { result: NonNullable<AnalysisJob["result"]> } =>
      job.result != null,
  );
}

function invalidReasonLabel(reason: IntegratedInvalidReason | undefined): string {
  switch (reason) {
    case "too-short":
      return "Too short: no complete 400 ms gated block";
    case "below-gate":
      return "All audio is below the -70 LUFS absolute gate";
    default:
      return "Invalid integrated loudness measurement";
  }
}

/** Shared export/UI presentation rule for the legacy -70 wire sentinel. */
export function getIntegratedMeasurementPresentation(
  metrics: LoudnessMetrics,
): IntegratedMeasurementPresentation {
  if (metrics.integratedValid === false) {
    return {
      status: "invalid",
      valueLufs: null,
      rawIntegratedLufs: metrics.integratedLufs,
      invalidReason: metrics.integratedInvalidReason ?? null,
      invalidReasonLabel: invalidReasonLabel(metrics.integratedInvalidReason),
    };
  }

  return {
    status: metrics.integratedValid === true ? "valid" : "legacy-unknown",
    valueLufs: metrics.integratedLufs,
    rawIntegratedLufs: metrics.integratedLufs,
    invalidReason: null,
    invalidReasonLabel: null,
  };
}

function provenanceLabel(provenance: AnalysisProvenance): string {
  switch (provenance.kind) {
    case "unverified-import":
      return "Unverified import";
    case "restored-local":
      return "Restored local analysis";
    case "local-analysis":
    default:
      return "Local analysis";
  }
}

function provenanceWarning(provenance: AnalysisProvenance): string {
  return provenance.kind === "unverified-import" ? UNVERIFIED_IMPORT_WARNING : "";
}

function lraStatus(metrics: LoudnessMetrics): string {
  if (metrics.loudnessRangeUnstable === true) {
    return "Unstable: programme shorter than 60 s";
  }
  return metrics.loudnessRangeUnstable === false ? "Stable duration" : "Legacy/unspecified";
}

// Collapse line/control characters and encode every Markdown-active punctuation
// character. This is intentionally stricter than needed for ordinary prose so
// imported filenames/labels cannot create headings, links, images, HTML, or
// additional list items in a permissive downstream renderer.
function markdownEscape(value: string): string {
  const flattened = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return flattened
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~\-])/g, "\\$1");
}

export function getExportFileName(format: ExportFormat) {
  // Scope per format: a CSV and a JSON export in the same second differ by
  // extension already, so only same-format repeats need a discriminator.
  const base = `${EXPORT_BASENAME}-${fileNameTimestamp(`analysis-${format}`)}`;
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
    "Integrated Status",
    "Integrated Invalid Reason",
    "Integrated LUFS",
    "Ungated LUFS",
    "LRA LU",
    "LRA Status",
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
    "Provenance",
    "Source Job ID",
    "Source Session Digest",
    "Provenance Warning",
  ];

  const rows = completed.map((job) => {
    const result = job.result;
    const compliance = getComplianceSummary(result);
    const integrated = getIntegratedMeasurementPresentation(result.metrics);
    const provenance = resolveAnalysisProvenance(job);
    return [
      csvText(job.fileName),
      csvText(job.status),
      csvText(result.analysisMode),
      csvText(result.target?.label ?? ""),
      result.target?.loudnessTargetLufs?.toFixed(2) ?? "",
      result.target?.toleranceLufs?.toFixed(2) ?? "",
      result.target?.truePeakCeilingDbtp?.toFixed(2) ?? "",
      csvText(compliance?.label ?? ""),
      csvText(integrated.status),
      csvText(integrated.invalidReasonLabel ?? ""),
      integrated.valueLufs?.toFixed(2) ?? "",
      result.metrics.ungatedLufs.toFixed(2),
      result.metrics.loudnessRange.toFixed(2),
      csvText(lraStatus(result.metrics)),
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
      csvText(provenanceLabel(provenance)),
      csvText(provenance.sourceJobId ?? ""),
      csvText(provenance.sourceSessionDigest ?? ""),
      csvText(provenanceWarning(provenance)),
    ]
      .map(csvEscape)
      .join(",");
  });

  return UTF8_BOM + [header.join(","), ...rows].join("\n");
}

export function buildJsonExport(jobs: AnalysisJob[]) {
  return JSON.stringify(
    completedJobs(jobs).map((job) => {
      const result = job.result;
      const integrated = getIntegratedMeasurementPresentation(result.metrics);
      const provenance = resolveAnalysisProvenance(job);
      return {
        id: job.id,
        fileName: job.fileName,
        status: job.status,
        analysisMode: result.analysisMode,
        compliance: getComplianceSummary(result),
        provenance,
        provenanceWarning: provenanceWarning(provenance) || null,
        measurements: {
          integratedLoudness: {
            status: integrated.status,
            valueLufs: integrated.valueLufs,
            invalidReason: integrated.invalidReason,
            invalidReasonLabel: integrated.invalidReasonLabel,
            rawIntegratedLufs: integrated.rawIntegratedLufs,
          },
          loudnessRange: {
            valueLu: result.metrics.loudnessRange,
            unstable: result.metrics.loudnessRangeUnstable ?? null,
            status: lraStatus(result.metrics),
          },
        },
        result: {
          ...result,
          metrics: {
            ...result.metrics,
            // `integratedLufs` is the report-facing measurement and therefore
            // null when invalid. The legacy wire value remains explicitly
            // available under a name that cannot be mistaken for a verdict.
            integratedLufs: integrated.valueLufs,
            rawIntegratedLufs: integrated.rawIntegratedLufs,
            integratedStatus: integrated.status,
            integratedInvalidReason: integrated.invalidReason,
            loudnessRangeUnstable: result.metrics.loudnessRangeUnstable ?? null,
          },
        },
      };
    }),
    null,
    2,
  );
}

export function buildMarkdownExport(jobs: AnalysisJob[]) {
  const completed = completedJobs(jobs);
  const generatedAt = new Date().toISOString();

  const sections = completed.map((job) => {
    const result = job.result;
    const compliance = getComplianceSummary(result);
    const integrated = getIntegratedMeasurementPresentation(result.metrics);
    const provenance = resolveAnalysisProvenance(job);
    const targetLine = result.target
      ? `- Target: ${markdownEscape(result.target.label)} (${result.target.loudnessTargetLufs.toFixed(2)} LUFS, ceiling ${result.target.truePeakCeilingDbtp.toFixed(2)} dBTP)`
      : "- Target: Measure Only";
    const complianceLine = compliance
      ? `- Compliance: ${markdownEscape(compliance.label)}`
      : "- Compliance: Not applicable";
    const integratedLine = integrated.valueLufs == null
      ? `- Integrated Loudness: No valid measurement (${markdownEscape(integrated.invalidReasonLabel ?? "invalid")})`
      : `- Integrated Loudness: ${integrated.valueLufs.toFixed(2)} LUFS (${markdownEscape(integrated.status)})`;
    const lraQualifier = result.metrics.loudnessRangeUnstable === true
      ? " (unstable; programme shorter than 60 s)"
      : result.metrics.loudnessRangeUnstable === undefined
        ? " (stability unknown for legacy result)"
        : "";
    const suggestedGainLine = result.metrics.targetDeltaDb == null
      ? "- Suggested Gain: n/a"
      : `- Suggested Gain: ${result.metrics.targetDeltaDb.toFixed(2)} dB`;
    const projectedPeakLine = result.metrics.projectedTruePeakDbtp == null
      ? "- Projected True Peak: n/a"
      : `- Projected True Peak: ${result.metrics.projectedTruePeakDbtp.toFixed(2)} dBTP`;
    const provenanceLines = [
      `- Provenance: ${markdownEscape(provenanceLabel(provenance))}`,
      ...(provenance.sourceJobId
        ? [`- Source Job ID: ${markdownEscape(provenance.sourceJobId)}`]
        : []),
      ...(provenance.sourceSessionDigest
        ? [`- Source Session Digest: ${markdownEscape(provenance.sourceSessionDigest)}`]
        : []),
      ...(provenance.kind === "unverified-import"
        ? ["", `> **Provenance warning:** ${markdownEscape(UNVERIFIED_IMPORT_WARNING)}`]
        : []),
    ];

    return [
      `## ${markdownEscape(job.fileName) || "Untitled analysis"}`,
      `- Status: ${markdownEscape(job.status)}`,
      `- Analysis Mode: ${markdownEscape(result.analysisMode)}`,
      complianceLine,
      targetLine,
      integratedLine,
      `- True Peak: ${result.metrics.truePeakDbtp.toFixed(2)} dBTP`,
      `- Loudness Range: ${result.metrics.loudnessRange.toFixed(2)} LU${lraQualifier}`,
      suggestedGainLine,
      projectedPeakLine,
      `- Decoder: ${markdownEscape(result.metadata.decoderLabel)}`,
      `- Layout: ${markdownEscape(result.metadata.channelLayout.name)}`,
      `- Sample Rate: ${result.metadata.sampleRate} Hz`,
      `- Analyzed At: ${markdownEscape(result.analyzedAt)}`,
      ...provenanceLines,
    ].join("\n");
  });

  return [
    "# TruePeak Analysis Report",
    "",
    `Generated: ${generatedAt}`,
    `Completed files: ${completed.length}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n").trimEnd();
}
