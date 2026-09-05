"use client";

import { memo } from "react";
import { RefreshCcw, Square, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  formatDuration,
  formatIntegratedLufs,
  formatPeakDbtp,
  formatRelativeDb,
} from "@/lib/format";
import { describeJobBadges, getJobErrorDisplay, getViewOnlyHint } from "@/lib/job-ui";
import { isActiveJob, isPausedAnalysisJob } from "@/lib/session-selectors";
import { cn } from "@/lib/utils";
import type { AnalysisJob, AnalysisMode } from "@/types/audio";

function AdvancedQueueMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[14px] border border-[var(--line)]/60 bg-[var(--surface-0)]/46 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold leading-tight tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

export const AdvancedQueueRow = memo(function AdvancedQueueRow({
  job,
  selected,
  analysisMode,
  onCancelJob,
  onOpenJob,
  onRemoveJob,
  onRetryJob,
}: {
  job: AnalysisJob;
  selected: boolean;
  analysisMode: AnalysisMode;
  onCancelJob: (jobId: string) => void;
  onOpenJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
}) {
  const errorDisplay = getJobErrorDisplay(job.error);
  const active = isActiveJob(job);
  const paused = isPausedAnalysisJob(job);
  const viewOnlyHint = getViewOnlyHint(job);
  const badgeOrder = new Map([
    ["status", 0],
    ["imported", 1],
    ["restored", 2],
    ["compliance", 3],
    ["integrated-unavailable", 4],
    ["target", 5],
    ["measure-only", 6],
    ["decoder", 7],
  ]);
  const badges = describeJobBadges(job, analysisMode)
    .sort((left, right) => (badgeOrder.get(left.key) ?? 99) - (badgeOrder.get(right.key) ?? 99));

  return (
    <article
      className={cn(
        "tp-selected-row rounded-[18px] border overflow-hidden [content-visibility:auto] [contain-intrinsic-size:96px]",
        selected
          ? "border-[color:var(--accent)]/36 bg-[color:var(--accent-soft)] shadow-[0_14px_34px_rgba(0,0,0,0.12)]"
          : "border-[var(--line)]/72 bg-[var(--surface-0)]/48 hover:border-[color:var(--accent)]/24 hover:bg-[var(--surface-1)]/64",
      )}
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
    >
      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)_auto] lg:items-center">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "mt-1 h-9 w-1.5 shrink-0 rounded-full",
              selected ? "bg-[var(--accent)]" : active ? "bg-[var(--warning)]" : "bg-[var(--line)]",
            )}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <button
              type="button"
              data-queue-nav="true"
              data-job-id={job.id}
              onClick={() => onOpenJob(job.id)}
              className="min-w-0 rounded-[10px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              aria-label={`Inspect ${job.fileName}`}
            >
              <div className="break-words text-sm font-semibold leading-6 text-[var(--ink)]">
                {job.fileName}
              </div>
            </button>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {badges.map((badge) => (
                <Badge key={badge.key} className={badge.className}>{badge.label}</Badge>
              ))}
            </div>
            {viewOnlyHint ? (
              <p className="mt-2 max-w-xl text-xs leading-5 text-[var(--muted)]">{viewOnlyHint}</p>
            ) : null}
          </div>
        </div>

        <div className={cn("grid min-w-0 gap-2", analysisMode === "targeted" ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3")}>
          <AdvancedQueueMetric label="Integrated" value={job.result ? formatIntegratedLufs(job.result.metrics) : paused ? "Paused" : "Waiting"} />
          <AdvancedQueueMetric label="True peak" value={job.result ? formatPeakDbtp(job.result.metrics.truePeakDbtp) : "n/a"} />
          {analysisMode === "targeted" ? (
            <AdvancedQueueMetric label="Gain" value={job.result ? formatRelativeDb(job.result.metrics.targetDeltaDb) : "n/a"} />
          ) : null}
          <AdvancedQueueMetric label="Duration" value={job.result ? formatDuration(job.result.metadata.durationSeconds) : "n/a"} />
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5 lg:justify-end">
          <Button type="button" size="sm" variant={selected ? "primary" : "secondary"} onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>
            Inspect
          </Button>
          {job.status === "failed" || job.status === "canceled" ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          {active ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
              <Square className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveJob(job.id)} aria-label={`Remove ${job.fileName}`}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {active ? (
        <div className="border-t border-[var(--line)]/55 px-3 pb-3 pt-2">
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
            <span className="min-w-0 break-words">{job.progressLabel}</span>
            <span className="shrink-0 tabular-nums">{Math.round(job.progressPercent * 100)}%</span>
          </div>
          <div className="mt-2">
            <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
          </div>
        </div>
      ) : null}

      {errorDisplay ? (
        <div className="border-t border-[var(--danger-line)] px-3 pb-3 pt-2 text-sm leading-6 text-[var(--danger)]">
          {errorDisplay.summary}
          {errorDisplay.detail ? (
            <details className="mt-2 rounded-[14px] border border-[var(--danger-line)] bg-[var(--danger-soft)] px-3 py-2 text-xs leading-5 text-[var(--ink)]/85">
              <summary className="cursor-pointer font-semibold uppercase tracking-[0.14em] text-[var(--danger)]">
                Why it failed
              </summary>
              <p className="mt-2 normal-case tracking-normal text-[var(--ink)]/75">{errorDisplay.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});
