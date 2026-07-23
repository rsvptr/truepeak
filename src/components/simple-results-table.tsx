"use client";

import { memo } from "react";
import { RefreshCcw, Square, Trash2 } from "lucide-react";
import { getComplianceSummary, type ComplianceSummary } from "@/audio/compliance";
import { formatDuration, formatIntegratedLufs, formatLoudnessRange, formatPeakDbtp, formatRelativeDb } from "@/lib/format";
import { getJobErrorDisplay, type JobErrorDisplay } from "@/lib/job-ui";
import { isActiveJob, isIssueJob } from "@/lib/session-selectors";
import { complianceToneClass, statusToneClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import type { AnalysisJob, AnalysisMode } from "@/types/audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface SimpleRowProps {
  job: AnalysisJob;
  selected: boolean;
  analysisMode: AnalysisMode;
  onCancelJob: (jobId: string) => void;
  onOpenJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
}

interface SimpleResultsTableProps {
  analysisMode: AnalysisMode;
  jobs: AnalysisJob[];
  selectedJobId: string | null;
  onCancelJob: (jobId: string) => void;
  onOpenJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
}

interface JobBadgeDescriptor {
  key: string;
  label: string;
  className?: string;
}

interface JobRowModel {
  compliance: ComplianceSummary | null;
  errorDisplay: JobErrorDisplay | null;
  isActive: boolean;
  isIssue: boolean;
  badges: JobBadgeDescriptor[];
  integratedDisplay: string;
  truePeakDisplay: string;
  gainDisplay: string;
  durationDisplay: string;
  loudnessRangeDisplay: string;
}

// Single source of truth for a row's derived status/labels, shared by the
// mobile card and the desktop table row (UX-031). Without this, the two
// presentations independently re-derive the same job state and can drift -
// which is exactly how the Integrated column ended up saying "Waiting" for
// a job that had already terminally failed (UX-015).
function buildJobRowModel(job: AnalysisJob, analysisMode: AnalysisMode): JobRowModel {
  const compliance = job.result ? getComplianceSummary(job.result) : null;
  const errorDisplay = getJobErrorDisplay(job.error);
  const isActive = isActiveJob(job);
  const isIssue = isIssueJob(job);

  const badges: JobBadgeDescriptor[] = [
    { key: "status", label: job.status, className: statusToneClass(job.status) },
  ];
  if (job.imported) {
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
    badges.push({ key: "integrated-unavailable", label: "Integrated unavailable", className: "tone-warning" });
  }
  if (compliance) {
    badges.push({ key: "compliance", label: compliance.label, className: complianceToneClass(compliance.state) });
  }
  if (job.result?.target) {
    badges.push({ key: "target", label: job.result.target.label });
  }
  if (analysisMode === "measure-only" && job.result) {
    badges.push({ key: "measure-only", label: "Measure Only" });
  }

  // Reserve "Waiting" for work that is actually still queued/active. A
  // terminal failure or cancellation has no measurement coming - saying
  // "Waiting" there misrepresents a dead end as pending work.
  const integratedDisplay = job.result
    ? formatIntegratedLufs(job.result.metrics)
    : isIssue
      ? job.status === "failed" ? "Failed" : "Unavailable"
      : "Waiting";

  return {
    compliance,
    errorDisplay,
    isActive,
    isIssue,
    badges,
    integratedDisplay,
    truePeakDisplay: job.result ? formatPeakDbtp(job.result.metrics.truePeakDbtp) : "n/a",
    gainDisplay: job.result ? formatRelativeDb(job.result.metrics.targetDeltaDb) : "n/a",
    durationDisplay: job.result ? formatDuration(job.result.metadata.durationSeconds) : "n/a",
    loudnessRangeDisplay: job.result ? formatLoudnessRange(job.result.metrics) : "n/a",
  };
}

// Rows are memoized individually: the jobs array gets a new identity on every
// progress tick, but updateJob keeps untouched job objects identical, so rows
// whose job did not change bail out instead of re-rendering the whole list
// (which exists twice in the tree - the card and table branches are both
// mounted and only CSS-hidden).
const SimpleQueueCard = memo(function SimpleQueueCard({
  job,
  selected,
  analysisMode,
  onCancelJob,
  onOpenJob,
  onRemoveJob,
  onRetryJob,
}: SimpleRowProps) {
  const model = buildJobRowModel(job, analysisMode);

  return (
    <article
      className={cn(
        "tp-selected-row rounded-[22px] border p-4 [content-visibility:auto] [contain-intrinsic-size:260px]",
        selected
          ? "border-[color:var(--accent)]/35 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)]/80 bg-[var(--surface-0)]/46",
      )}
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
    >
      {/* The file name is the card's one row-navigation affordance (UX-028):
          it doubles as the "Inspect" action, so the actions row below only
          carries Retry/Cancel/Remove instead of repeating an equivalent
          Inspect button. Keeping the card's data outside of it also matters
          for screen readers: a button's aria-label hides every descendant,
          so badges, metrics, and errors rendered inside would be
          unreachable. */}
      <button
        type="button"
        data-queue-nav="true"
        data-job-id={job.id}
        onClick={() => onOpenJob(job.id)}
        className="w-full rounded-[18px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        aria-label={`Inspect ${job.fileName}`}
      >
        <div className="break-words text-base font-semibold leading-7 text-[var(--ink)]">
          {job.fileName}
        </div>
      </button>
      <div className="mt-3 flex flex-wrap gap-2">
        {model.badges.map((badge) => (
          <Badge key={badge.key} className={badge.className}>
            {badge.label}
          </Badge>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Integrated</div>
          <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">{model.integratedDisplay}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">True peak</div>
          <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">{model.truePeakDisplay}</div>
        </div>
        {analysisMode === "targeted" ? (
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Gain</div>
            <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">{model.gainDisplay}</div>
          </div>
        ) : null}
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Duration</div>
          <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">{model.durationDisplay}</div>
        </div>
      </div>
      {model.isActive ? (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
            <span>{job.progressLabel}</span>
            <span className="tabular-nums">{Math.round(job.progressPercent * 100)}%</span>
          </div>
          <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
        </div>
      ) : null}
      {model.errorDisplay ? (
        <div className="mt-3 text-xs leading-5 text-[var(--danger)]">
          {model.errorDisplay.summary}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--line)]/70 pt-4">
        {model.isIssue ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        {model.isActive ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
            <Square className="h-4 w-4" aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveJob(job.id)} aria-label={`Remove ${job.fileName}`}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Remove
        </Button>
      </div>
    </article>
  );
});

const SimpleQueueRow = memo(function SimpleQueueRow({
  job,
  selected,
  analysisMode,
  onCancelJob,
  onOpenJob,
  onRemoveJob,
  onRetryJob,
}: SimpleRowProps) {
  const model = buildJobRowModel(job, analysisMode);

  return (
    <tr
      className={cn(
        "tp-selected-row border-b border-[var(--line)]/70 align-top text-[var(--ink)]",
        selected ? "bg-[color:var(--accent-soft)]/72" : "hover:bg-[color:var(--surface-0)]/56",
      )}
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
    >
      <td className="px-5 py-4 align-top">
        <div className="flex gap-3">
          <div className={cn("mt-1 h-auto min-h-[54px] w-1.5 rounded-full transition-[background-color] duration-200 ease-out", selected ? "bg-[var(--accent)]" : "bg-transparent")} />
          <div className="min-w-0 flex-1">
            {/* The file name is this row's one row-navigation affordance
                (UX-028): it doubles as "Inspect", so the actions cell only
                repeats Retry/Cancel/Remove instead of an equivalent Inspect
                button. Badges, progress, and the failure disclosure are
                siblings of the button rather than children: a <details>
                inside a <button> is invalid HTML, and expanding it also
                used to bubble into row navigation. */}
            <button
              type="button"
              data-queue-nav="true"
              data-job-id={job.id}
              onClick={() => onOpenJob(job.id)}
              className="w-full rounded-[10px] text-left transition-[color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              aria-label={`Inspect ${job.fileName}`}
            >
              <div className="max-w-[32rem] text-base font-semibold leading-7 break-words text-[var(--ink)]">
                {job.fileName}
              </div>
            </button>
            <div className="mt-2 flex flex-wrap gap-2">
              {model.badges.map((badge) => (
                <Badge key={badge.key} className={badge.className}>
                  {badge.label}
                </Badge>
              ))}
            </div>
            {model.isActive ? (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                  <span>{job.progressLabel}</span>
                  <span className="tabular-nums">{Math.round(job.progressPercent * 100)}%</span>
                </div>
                <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
              </div>
            ) : null}
            {model.errorDisplay ? (
              <div className="mt-3 text-xs leading-5 text-[var(--danger)]">
                {model.errorDisplay.summary}
                {model.errorDisplay.detail ? (
                  <details className="mt-2 rounded-[16px] border border-[color:var(--danger)]/20 bg-[color:var(--danger)]/10 px-3 py-2 text-[11px] leading-5 text-[var(--ink)]/85">
                    <summary className="cursor-pointer font-semibold uppercase tracking-[0.14em] text-[var(--danger)]">
                      Why it failed
                    </summary>
                    <p className="mt-2 normal-case tracking-normal text-[var(--ink)]/75">{model.errorDisplay.detail}</p>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-4 align-top whitespace-nowrap text-base font-semibold tabular-nums text-[var(--ink)]">
        {model.integratedDisplay}
      </td>
      {analysisMode === "targeted" ? (
        <td className="hidden px-4 py-4 align-top whitespace-nowrap font-semibold tabular-nums text-[var(--ink)] lg:table-cell">
          {model.gainDisplay}
        </td>
      ) : null}
      <td className="px-4 py-4 align-top whitespace-nowrap font-semibold tabular-nums text-[var(--ink)]">
        {model.truePeakDisplay}
      </td>
      <td className="hidden px-4 py-4 align-top whitespace-nowrap font-semibold tabular-nums text-[var(--ink)] xl:table-cell">
        {model.loudnessRangeDisplay}
      </td>
      <td className="px-5 py-4 align-top">
        <div className="flex flex-wrap justify-end gap-1.5">
          {model.isIssue ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          {model.isActive ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
              <Square className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveJob(job.id)} aria-label={`Remove ${job.fileName}`}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </td>
    </tr>
  );
});

export const SimpleResultsTable = memo(function SimpleResultsTable({
  analysisMode,
  jobs,
  selectedJobId,
  onCancelJob,
  onOpenJob,
  onRemoveJob,
  onRetryJob,
}: SimpleResultsTableProps) {
  return (
    <div className="overflow-hidden rounded-[28px] border border-[var(--line)]/80 bg-[var(--surface-1)] shadow-[0_18px_44px_rgba(0,0,0,0.12)]">
      <div className="grid gap-3 p-3 md:hidden">
        {jobs.map((job) => (
          <SimpleQueueCard
            key={job.id}
            job={job}
            selected={job.id === selectedJobId}
            analysisMode={analysisMode}
            onCancelJob={onCancelJob}
            onOpenJob={onOpenJob}
            onRemoveJob={onRemoveJob}
            onRetryJob={onRetryJob}
          />
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] table-fixed text-sm lg:min-w-[760px] xl:min-w-[860px]">
          <caption className="sr-only">
            Analysis results for {jobs.length} file{jobs.length === 1 ? "" : "s"} in this session,{" "}
            {analysisMode === "targeted" ? "showing target compliance and gain" : "in measure-only mode"}.
          </caption>
          <colgroup>
            <col className="w-[48%]" />
            <col className="w-[15%]" />
            {analysisMode === "targeted" ? <col className="hidden lg:table-column lg:w-[12%]" /> : null}
            <col className="w-[15%]" />
            <col className="hidden xl:table-column xl:w-[10%]" />
            <col className="w-[14%]" />
          </colgroup>
          {/* The header cells are sticky against the overflow-x wrapper, NOT
              the page: an ancestor with overflow-x:auto is a scroll container,
              so sticky can never dock these cells under the page-level
              toolbar. Keep the offset at top-0 - any positive offset (e.g. a
              toolbar-height variable) permanently pushes the header that far
              down into the card at rest, covering the first rows. Verified
              against a live reproduction; do not reintroduce an offset here
              without restructuring the wrappers. */}
          <thead>
            <tr className="border-b border-[var(--line)] text-left text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
              <th scope="col" className="sticky top-0 bg-[var(--surface-1)]/96 px-5 py-4 backdrop-blur">File</th>
              <th scope="col" className="sticky top-0 bg-[var(--surface-1)]/96 px-4 py-4 backdrop-blur">Integrated</th>
              {analysisMode === "targeted" ? (
                <th scope="col" className="sticky top-0 hidden bg-[var(--surface-1)]/96 px-4 py-4 backdrop-blur lg:table-cell">
                  Gain
                </th>
              ) : null}
              <th scope="col" className="sticky top-0 bg-[var(--surface-1)]/96 px-4 py-4 backdrop-blur">True peak</th>
              <th scope="col" className="sticky top-0 hidden bg-[var(--surface-1)]/96 px-4 py-4 backdrop-blur xl:table-cell">LRA</th>
              <th scope="col" className="sticky top-0 px-5 py-4 backdrop-blur bg-[var(--surface-1)]/96">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <SimpleQueueRow
                key={job.id}
                job={job}
                selected={job.id === selectedJobId}
                analysisMode={analysisMode}
                onCancelJob={onCancelJob}
                onOpenJob={onOpenJob}
                onRemoveJob={onRemoveJob}
                onRetryJob={onRetryJob}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
