"use client";

import { memo } from "react";
import { RefreshCcw, Square, Trash2 } from "lucide-react";
import { getComplianceSummary } from "@/audio/compliance";
import { formatDb, formatDuration, formatLufs, formatPeakDbtp, formatRelativeDb } from "@/lib/format";
import { getJobErrorDisplay } from "@/lib/job-ui";
import { complianceToneClass, statusToneClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import type { AnalysisJob, AnalysisMode } from "@/types/audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

function isActive(job: AnalysisJob) {
  return ["queued", "reading", "decoding", "analyzing"].includes(job.status);
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
        {jobs.map((job) => {
          const selected = job.id === selectedJobId;
          const compliance = job.result ? getComplianceSummary(job.result) : null;
          const errorDisplay = getJobErrorDisplay(job.error);

          return (
            <article
              key={job.id}
              className={cn(
                "tp-selected-row rounded-[22px] border p-4 [content-visibility:auto] [contain-intrinsic-size:260px]",
                selected
                  ? "border-[color:var(--accent)]/35 bg-[color:var(--accent-soft)]"
                  : "border-[var(--line)]/80 bg-[var(--surface-0)]/46",
              )}
              data-selected={selected}
              aria-current={selected ? "true" : undefined}
            >
              <button
                type="button"
                data-queue-nav="true"
                onClick={() => onOpenJob(job.id)}
                className="w-full rounded-[18px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                aria-label={`Inspect ${job.fileName}`}
              >
                <div className="break-words text-base font-semibold leading-7 text-[var(--ink)]">
                  {job.fileName}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge className={statusToneClass(job.status)}>{job.status}</Badge>
                  {job.imported ? <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">Imported</Badge> : null}
                  {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : null}
                  {job.result?.target ? <Badge>{job.result.target.label}</Badge> : null}
                  {analysisMode === "measure-only" && job.result ? <Badge>Measure Only</Badge> : null}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Integrated</div>
                    <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">
                      {job.result ? formatLufs(job.result.metrics.integratedLufs) : "Waiting"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">True peak</div>
                    <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">
                      {job.result ? formatPeakDbtp(job.result.metrics.truePeakDbtp) : "n/a"}
                    </div>
                  </div>
                  {analysisMode === "targeted" ? (
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Gain</div>
                      <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">
                        {job.result ? formatRelativeDb(job.result.metrics.targetDeltaDb) : "n/a"}
                      </div>
                    </div>
                  ) : null}
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Duration</div>
                    <div className="mt-1 font-semibold tabular-nums text-[var(--ink)]">
                      {job.result ? formatDuration(job.result.metadata.durationSeconds) : "n/a"}
                    </div>
                  </div>
                </div>
                {isActive(job) ? (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                      <span>{job.progressLabel}</span>
                      <span className="tabular-nums">{Math.round(job.progressPercent * 100)}%</span>
                    </div>
                    <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
                  </div>
                ) : null}
                {errorDisplay ? (
                  <div className="mt-3 text-xs leading-5 text-[var(--danger)]">
                    {errorDisplay.summary}
                  </div>
                ) : null}
              </button>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--line)]/70 pt-4">
                <Button type="button" size="sm" variant={selected ? "primary" : "secondary"} onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>
                  Inspect
                </Button>
                {job.status === "failed" || job.status === "canceled" ? (
                  <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
                    <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                  </Button>
                ) : null}
                {isActive(job) ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
                    <Square className="h-4 w-4" aria-hidden="true" />
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveJob(job.id)} aria-label={`Remove ${job.fileName}`}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] table-fixed text-sm lg:min-w-[760px] xl:min-w-[860px]">
          <colgroup>
            <col className="w-[48%]" />
            <col className="w-[15%]" />
            {analysisMode === "targeted" ? <col className="hidden lg:table-column lg:w-[12%]" /> : null}
            <col className="w-[15%]" />
            <col className="hidden xl:table-column xl:w-[10%]" />
            <col className="w-[14%]" />
          </colgroup>
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
            {jobs.map((job) => {
              const selected = job.id === selectedJobId;
              const compliance = job.result ? getComplianceSummary(job.result) : null;
              const errorDisplay = getJobErrorDisplay(job.error);

              return (
                <tr
                  key={job.id}
                  className={cn(
                    "tp-selected-row border-b border-[var(--line)]/70 align-top text-[var(--ink)]",
                    selected ? "bg-[color:var(--accent-soft)]/72" : "hover:bg-[color:var(--surface-0)]/56",
                  )}
                  data-selected={selected}
                  aria-current={selected ? "true" : undefined}
                >
                  <td className="px-5 py-4 align-top">
                    <button
                      type="button"
                      data-queue-nav="true"
                      onClick={() => onOpenJob(job.id)}
                      className="w-full text-left transition-[color] duration-200 ease-out"
                      aria-label={`Inspect ${job.fileName}`}
                    >
                      <div className="flex gap-3">
                        <div className={cn("mt-1 h-auto min-h-[54px] w-1.5 rounded-full transition-[background-color] duration-200 ease-out", selected ? "bg-[var(--accent)]" : "bg-transparent")} />
                        <div className="min-w-0 flex-1">
                          <div className="max-w-[32rem] text-base font-semibold leading-7 break-words text-[var(--ink)]">
                            {job.fileName}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Badge className={statusToneClass(job.status)}>{job.status}</Badge>
                            {job.imported ? <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">Imported</Badge> : null}
                            {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : null}
                            {job.result?.target ? <Badge>{job.result.target.label}</Badge> : null}
                            {analysisMode === "measure-only" && job.result ? <Badge>Measure Only</Badge> : null}
                          </div>
                          {isActive(job) ? (
                            <div className="mt-3 space-y-2">
                              <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
                                <span>{job.progressLabel}</span>
                                <span className="tabular-nums">{Math.round(job.progressPercent * 100)}%</span>
                              </div>
                              <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
                            </div>
                          ) : null}
                          {errorDisplay ? (
                            <div className="mt-3 text-xs leading-5 text-[var(--danger)]">
                              {errorDisplay.summary}
                              {errorDisplay.detail ? (
                                <details className="mt-2 rounded-[16px] border border-[color:var(--danger)]/20 bg-[color:var(--danger)]/10 px-3 py-2 text-[11px] leading-5 text-[var(--ink)]/85">
                                  <summary className="cursor-pointer font-semibold uppercase tracking-[0.14em] text-[var(--danger)]">
                                    Why it failed
                                  </summary>
                                  <p className="mt-2 normal-case tracking-normal text-[var(--ink)]/75">{errorDisplay.detail}</p>
                                </details>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-4 align-top whitespace-nowrap text-base font-semibold tabular-nums text-[var(--ink)]">
                    {job.result ? formatLufs(job.result.metrics.integratedLufs) : "Waiting"}
                  </td>
                  {analysisMode === "targeted" ? (
                    <td className="hidden px-4 py-4 align-top whitespace-nowrap font-semibold tabular-nums text-[var(--ink)] lg:table-cell">
                      {job.result ? formatRelativeDb(job.result.metrics.targetDeltaDb) : "n/a"}
                    </td>
                  ) : null}
                  <td className="px-4 py-4 align-top whitespace-nowrap font-semibold tabular-nums text-[var(--ink)]">
                    {job.result ? formatPeakDbtp(job.result.metrics.truePeakDbtp) : "n/a"}
                  </td>
                  <td className="hidden px-4 py-4 align-top whitespace-nowrap font-semibold tabular-nums text-[var(--ink)] xl:table-cell">
                    {job.result ? formatDb(job.result.metrics.loudnessRange, "LU") : "n/a"}
                  </td>
                  <td className="px-5 py-4 align-top">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button type="button" size="sm" variant={selected ? "primary" : "secondary"} onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>
                        Inspect
                      </Button>
                      {job.status === "failed" || job.status === "canceled" ? (
                        <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
                          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      ) : null}
                      {isActive(job) ? (
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
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});
