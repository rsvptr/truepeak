import {
  decodeFailureSummary,
  inferDecodeFailureCode,
} from "@/audio/decode-budget";
import { getComplianceSummary } from "@/audio/compliance";
import { isPausedAnalysisJob, isUnverifiedAnalysisJob } from "@/lib/session-selectors";
import { complianceToneClass, statusToneClass } from "@/lib/status-tone";
import type { AnalysisJob, AnalysisMode } from "@/types/audio";

export interface JobErrorDisplay {
  summary: string;
  detail: string | null;
}

export type JobBadgeKey =
  | "status"
  | "imported"
  | "restored"
  | "integrated-unavailable"
  | "compliance"
  | "target"
  | "measure-only"
  | "decoder";

export interface JobBadgeDescriptor {
  key: JobBadgeKey;
  label: string;
  className?: string;
}

export function describeJobBadges(
  job: AnalysisJob,
  analysisMode: AnalysisMode,
): JobBadgeDescriptor[] {
  const compliance = job.result ? getComplianceSummary(job.result) : null;
  const paused = isPausedAnalysisJob(job);
  const badges: JobBadgeDescriptor[] = [
    {
      key: "status",
      label: paused ? "Paused" : job.status,
      className: paused ? "tone-warning" : statusToneClass(job.status),
    },
  ];

  if (isUnverifiedAnalysisJob(job)) {
    badges.push({ key: "imported", label: "Unverified import", className: "tone-warning" });
  }
  if (job.restored) {
    badges.push({
      key: "restored",
      label: "Restored",
      className: "border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]",
    });
  }
  if (job.result?.metrics.integratedValid === false) {
    badges.push({
      key: "integrated-unavailable",
      label: "Integrated unavailable",
      className: "tone-warning",
    });
  }
  if (compliance) {
    badges.push({
      key: "compliance",
      label: compliance.label,
      className: complianceToneClass(compliance.state),
    });
  }
  if (job.result?.target) {
    badges.push({ key: "target", label: job.result.target.label });
  }
  if (analysisMode === "measure-only" && job.result) {
    badges.push({ key: "measure-only", label: "Measure Only" });
  }
  if (job.result?.metadata.decoderLabel) {
    badges.push({
      key: "decoder",
      label: job.result.metadata.decoderLabel,
      className: "max-w-full break-words border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]",
    });
  }

  return badges;
}

export function describeResultBadges(
  job: AnalysisJob,
  analysisMode: AnalysisMode,
  includeDecoder = false,
) {
  const described = describeJobBadges(job, analysisMode);
  const primary = described.find((badge) => badge.key === "compliance") ??
    described.find((badge) => badge.key === "integrated-unavailable") ??
    described.find((badge) => badge.key === "measure-only");
  const imported = described.find((badge) => badge.key === "imported");
  const decoder = includeDecoder
    ? described.find((badge) => badge.key === "decoder")
    : undefined;
  return [primary, imported, decoder].filter(
    (badge): badge is JobBadgeDescriptor => badge != null,
  );
}

const ERROR_DETAIL_SEPARATOR = "\n\nTechnical details:\n";

export function composeJobError(summary: string, detail?: string | null) {
  const cleanSummary = summary.trim();
  const cleanDetail = detail?.trim();
  return cleanDetail && cleanDetail !== cleanSummary
    ? `${cleanSummary}${ERROR_DETAIL_SEPARATOR}${cleanDetail}`
    : cleanSummary;
}

export function getJobErrorDisplay(message?: string | null): JobErrorDisplay | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const detailOffset = trimmed.indexOf(ERROR_DETAIL_SEPARATOR);
  if (detailOffset >= 0) {
    return {
      summary: trimmed.slice(0, detailOffset).trim(),
      detail: trimmed.slice(detailOffset + ERROR_DETAIL_SEPARATOR.length).trim() || null,
    };
  }

  const lower = trimmed.toLowerCase();

  if (lower.startsWith("truepeak couldn't decode this file") && lower.includes("try ")) {
    return { summary: trimmed, detail: null };
  }

  if (
    lower.includes("worker failed") ||
    lower.includes("worker could not") ||
    lower.includes("workers could not start")
  ) {
    return {
      summary: "Analysis stopped because the local worker failed. Retry analysis. If it fails again, reload the page.",
      detail: trimmed,
    };
  }

  if (
    lower.includes("couldn't decode this file") ||
    lower.includes("browser decode failed:") ||
    lower.includes("primary decode failed:") ||
    lower.includes("compatibility decode failed:")
  ) {
    return {
      summary: decodeFailureSummary("decode-failed"),
      detail: trimmed,
    };
  }

  if (lower.includes("original file handle was not available")) {
    return {
      summary: "The source file is no longer available for this queue item.",
      detail: "Add the file again before retrying this analysis.",
    };
  }

  const inferredCode = inferDecodeFailureCode(trimmed);
  if (inferredCode) {
    return {
      summary: decodeFailureSummary(inferredCode),
      detail: trimmed,
    };
  }

  return {
    summary: trimmed,
    detail: null,
  };
}

export function getViewOnlyHint(job: AnalysisJob) {
  if (job.imported) {
    return "This imported result is view-only and has not been verified against local audio. Add the source file again to analyze it locally.";
  }
  if (job.restored) {
    return "This restored result is view-only. Add the source file again to re-analyze it.";
  }
  return null;
}

export function buildRecoveryNotice({
  restoredCount,
  invalidRecordCount,
  overflowRecordCount,
  interruptedFileCount,
}: {
  restoredCount: number;
  invalidRecordCount: number;
  overflowRecordCount: number;
  interruptedFileCount: number;
}) {
  const parts = [
    restoredCount > 0
      ? `Restored ${restoredCount} view-only result${restoredCount === 1 ? "" : "s"} from your last session. Add the source ${restoredCount === 1 ? "file" : "files"} again to re-analyze.`
      : null,
    invalidRecordCount > 0
      ? `${invalidRecordCount} invalid saved recovery record${invalidRecordCount === 1 ? " was" : "s were"} quarantined and not restored.`
      : null,
    interruptedFileCount > 0
      ? `${interruptedFileCount} file${interruptedFileCount === 1 ? " was" : "s were"} still queued or running and must be added again.`
      : null,
    overflowRecordCount > 0
      ? `${overflowRecordCount} additional stored result${overflowRecordCount === 1 ? " remains" : "s remain"} outside the current restore limit.`
      : null,
  ].filter((part): part is string => part != null);

  return parts.length ? parts.join(" ") : null;
}

export function buildBatchIdleAnnouncement(
  jobs: readonly AnalysisJob[],
  batchJobIds: ReadonlySet<string>,
) {
  const batchJobs = jobs.filter((job) => batchJobIds.has(job.id));
  if (
    batchJobs.length === 0 ||
    batchJobs.some(
      (job) =>
        job.status !== "complete" &&
        job.status !== "failed" &&
        job.status !== "canceled",
    )
  ) {
    return null;
  }

  let completed = 0;
  let failed = 0;
  let canceled = 0;
  for (const job of batchJobs) {
    if (job.status === "complete") completed += 1;
    else if (job.status === "failed") failed += 1;
    else canceled += 1;
  }

  return `All ${batchJobs.length} ${batchJobs.length === 1 ? "file" : "files"} finished. ${completed} completed, ${failed} failed, ${canceled} canceled.`;
}
