import { getComplianceSummary } from "@/audio/compliance";
import {
  allocateTimelinePoints,
  downsampleTimeline,
  resolveAnalysisProvenance,
} from "@/audio/session-file";
import {
  fileNameTimestamp,
  formatMeasurementNumber,
  isSilencePeak,
  roundToMeasurementPrecision,
} from "@/lib/format";
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
const SAFE_FILENAME_HEADER =
  "Filename (leading apostrophe prevents spreadsheet formulas)";
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
  if (metrics.loudnessRangeValid === false) {
    return "Unavailable: fewer than two complete 3 s windows";
  }
  if (metrics.loudnessRangeUnstable === true) {
    return "Unstable: programme shorter than 60 s";
  }
  return metrics.loudnessRangeUnstable === false ? "Stable duration" : "Legacy/unspecified";
}

function exportMeasurement(value: number | null | undefined): number | null {
  return value == null ? null : roundToMeasurementPrecision(value);
}

function exportPeak(value: number | null | undefined): number | null {
  return value == null || isSilencePeak(value)
    ? null
    : roundToMeasurementPrecision(value);
}

function csvMeasurement(value: number | null | undefined): string {
  return value == null ? "" : formatMeasurementNumber(value);
}

function csvPeak(value: number | null | undefined): string {
  return value == null || isSilencePeak(value)
    ? ""
    : formatMeasurementNumber(value);
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
    SAFE_FILENAME_HEADER,
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
      csvMeasurement(result.target?.loudnessTargetLufs),
      csvMeasurement(result.target?.toleranceLufs),
      csvMeasurement(result.target?.truePeakCeilingDbtp),
      csvText(compliance?.label ?? ""),
      csvText(integrated.status),
      csvText(integrated.invalidReasonLabel ?? ""),
      csvMeasurement(integrated.valueLufs),
      csvMeasurement(result.metrics.ungatedLufs),
      csvMeasurement(
        result.metrics.loudnessRangeValid === false
          ? null
          : result.metrics.loudnessRange,
      ),
      csvText(lraStatus(result.metrics)),
      csvMeasurement(result.metrics.maxMomentaryLufs),
      csvMeasurement(result.metrics.maxShortTermLufs),
      csvPeak(result.metrics.samplePeakDbfs),
      csvPeak(result.metrics.truePeakDbtp),
      csvMeasurement(result.metrics.targetDeltaDb),
      csvPeak(result.metrics.projectedTruePeakDbtp),
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

// Same aggregate point budget and downsampling buildSessionFile uses
// (session-file.ts), applied across every completed job's timeline, so a
// large session's JSON report cannot serialize an unbounded number of
// timeline points (PERF-05). These are trusted in-memory results already
// shaped as AnalysisTimeline, not untrusted input, so no re-normalization
// pass is needed before downsampling.
function downsampleReportTimelines(completed: ReturnType<typeof completedJobs>) {
  const sourcePoints = completed.map(
    (job) => job.result.metrics.timeline.timeSeconds.length,
  );
  const allocations = allocateTimelinePoints(sourcePoints);
  return completed.map((job, index) => {
    const timeline = downsampleTimeline(job.result.metrics.timeline, allocations[index]);
    return {
      timeline,
      timelineDownsampled: timeline.timeSeconds.length < sourcePoints[index],
      timelineSourcePoints: sourcePoints[index],
    };
  });
}

// Pretty-printing (indent 2) roughly doubles both the payload size and the
// cost of producing it. Below this size that cost is negligible, so we keep
// the readable format; at or above it we keep the compact string from the
// first stringify pass rather than paying for a second one over tens of MB.
const JSON_EXPORT_PRETTY_PRINT_MAX_BYTES = 8 * 1024 * 1024;

export function buildJsonExport(jobs: AnalysisJob[]) {
  const completed = completedJobs(jobs);
  const timelines = downsampleReportTimelines(completed);

  const payload = completed.map((job, index) => {
    const result = job.result;
    const integrated = getIntegratedMeasurementPresentation(result.metrics);
    const provenance = resolveAnalysisProvenance(job);
    const { timeline, timelineDownsampled, timelineSourcePoints } = timelines[index];
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
          valueLufs: exportMeasurement(integrated.valueLufs),
          invalidReason: integrated.invalidReason,
          invalidReasonLabel: integrated.invalidReasonLabel,
          rawIntegratedLufs: integrated.rawIntegratedLufs,
        },
        loudnessRange: {
          valueLu: exportMeasurement(
            result.metrics.loudnessRangeValid === false
              ? null
              : result.metrics.loudnessRange,
          ),
          valid: result.metrics.loudnessRangeValid ?? true,
          unstable: result.metrics.loudnessRangeUnstable ?? null,
          status: lraStatus(result.metrics),
        },
      },
      result: {
        ...result,
        target: result.target
          ? {
              ...result.target,
              loudnessTargetLufs: roundToMeasurementPrecision(
                result.target.loudnessTargetLufs,
              ),
              toleranceLufs: roundToMeasurementPrecision(result.target.toleranceLufs),
              truePeakCeilingDbtp: roundToMeasurementPrecision(
                result.target.truePeakCeilingDbtp,
              ),
            }
          : null,
        metrics: {
          ...result.metrics,
          // `integratedLufs` is the report-facing measurement and therefore
          // null when invalid. The legacy wire value remains explicitly
          // available under a name that cannot be mistaken for a verdict.
          integratedLufs: exportMeasurement(integrated.valueLufs),
          rawIntegratedLufs: integrated.rawIntegratedLufs,
          integratedStatus: integrated.status,
          integratedInvalidReason: integrated.invalidReason,
          ungatedLufs: exportMeasurement(result.metrics.ungatedLufs),
          loudnessRange: exportMeasurement(
            result.metrics.loudnessRangeValid === false
              ? null
              : result.metrics.loudnessRange,
          ),
          loudnessRangeValid: result.metrics.loudnessRangeValid ?? true,
          loudnessRangeUnstable: result.metrics.loudnessRangeUnstable ?? null,
          maxMomentaryLufs: exportMeasurement(result.metrics.maxMomentaryLufs),
          maxShortTermLufs: exportMeasurement(result.metrics.maxShortTermLufs),
          samplePeakDbfs: exportPeak(result.metrics.samplePeakDbfs),
          truePeakDbtp: exportPeak(result.metrics.truePeakDbtp),
          unclampedTargetDeltaDb: exportMeasurement(
            result.metrics.unclampedTargetDeltaDb,
          ),
          targetDeltaDb: exportMeasurement(result.metrics.targetDeltaDb),
          projectedTruePeakDbtp: exportPeak(result.metrics.projectedTruePeakDbtp),
          // Capped/downsampled by downsampleReportTimelines above; these two
          // fields let a consumer tell whether the timeline below is the
          // full-resolution one or a reduced stand-in for it.
          timeline,
          timelineDownsampled,
          timelineSourcePoints,
        },
      },
    };
  });

  const compact = JSON.stringify(payload);
  const byteLength = new Blob([compact]).size;
  return byteLength < JSON_EXPORT_PRETTY_PRINT_MAX_BYTES
    ? JSON.stringify(payload, null, 2)
    : compact;
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
      ? `- Target: ${markdownEscape(result.target.label)} (${formatMeasurementNumber(result.target.loudnessTargetLufs)} LUFS, ceiling ${formatMeasurementNumber(result.target.truePeakCeilingDbtp)} dBTP)`
      : "- Target: Measure Only";
    const complianceLine = compliance
      ? `- Compliance: ${markdownEscape(compliance.label)}`
      : "- Compliance: Not applicable";
    const integratedLine = integrated.valueLufs == null
      ? `- Integrated Loudness: No valid measurement (${markdownEscape(integrated.invalidReasonLabel ?? "invalid")})`
      : `- Integrated Loudness: ${formatMeasurementNumber(integrated.valueLufs)} LUFS (${markdownEscape(integrated.status)})`;
    const lraQualifier = result.metrics.loudnessRangeUnstable === true
      ? " (unstable; programme shorter than 60 s)"
      : result.metrics.loudnessRangeUnstable === undefined
        ? " (stability unknown for legacy result)"
        : "";
    const suggestedGainLine = result.metrics.targetDeltaDb == null
      ? "- Suggested Gain: n/a"
      : `- Suggested Gain: ${formatMeasurementNumber(result.metrics.targetDeltaDb)} dB`;
    const projectedPeakLine = result.metrics.projectedTruePeakDbtp == null
      ? "- Projected True Peak: n/a"
      : `- Projected True Peak: ${isSilencePeak(result.metrics.projectedTruePeakDbtp) ? "Silence" : `${formatMeasurementNumber(result.metrics.projectedTruePeakDbtp)} dBTP`}`;
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
      `- True Peak: ${isSilencePeak(result.metrics.truePeakDbtp) ? "Silence" : `${formatMeasurementNumber(result.metrics.truePeakDbtp)} dBTP`}`,
      `- Loudness Range: ${result.metrics.loudnessRangeValid === false ? "" : `${formatMeasurementNumber(result.metrics.loudnessRange)} LU${lraQualifier}`}`,
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
