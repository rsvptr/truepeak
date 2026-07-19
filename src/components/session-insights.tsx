"use client";

import { useMemo } from "react";
import {
  ArrowUpRight,
  AudioLines,
  BarChart3,
  CircleAlert,
  Lightbulb,
  ShieldCheck,
  Sparkles,
  Waves,
} from "lucide-react";
import { getComplianceSummary } from "@/audio/compliance";
import { resolveAnalysisProvenance } from "@/audio/session-file";
import {
  formatDuration,
  formatIntegratedLufs,
  formatLoudnessRange,
  formatLufs,
  formatPeakDbtp,
  formatPresetLufs,
  formatPresetPeakDbtp,
  formatRelativeDb,
} from "@/lib/format";
import {
  averageIntegratedLufs,
  getAttentionJobs,
  getComplianceCounts,
  getCompletedAnalysisJobs,
  getDecoderMix,
  getHighestProjectedPeakJob,
  getHottestPeakJob,
  getLargestMoveJob,
  getLongestJob,
  getMeasureOnlyFocusJobs,
  getQuietestJob,
  getSessionChannelLayouts,
  getSessionSampleRates,
  getTargetedFocusJobs,
  getWidestRangeJob,
} from "@/lib/session-selectors";
import type { AnalysisJob, AnalysisMode, TargetPreset } from "@/types/audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface SessionInsightsPanelProps {
  completedJobs: AnalysisJob[];
  currentTarget: TargetPreset | null;
  analysisMode: AnalysisMode;
  historyEnabled: boolean;
  recentSessionCount: number;
  onOpenCompare: () => void;
  onOpenQueue?: () => void;
  onOpenJob: (jobId: string) => void;
}

function isUnverifiedImport(job: AnalysisJob) {
  return resolveAnalysisProvenance(job).kind === "unverified-import";
}

function InsightMetric({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div
      className={accent
        ? "min-w-0 rounded-[22px] border border-[color:var(--accent)]/25 bg-[color:var(--accent-soft)] p-4"
        : "min-w-0 rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4"}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 break-words text-[clamp(1.05rem,1.6vw,1.5rem)] font-semibold leading-tight tabular-nums text-[var(--ink)]">{value}</div>
      <div className="mt-1 break-words text-xs leading-5 text-[var(--muted)]">{hint}</div>
    </div>
  );
}

function RecommendationCard({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: "default" | "warn" | "good";
}) {
  const className =
    tone === "warn"
      ? "tone-warning"
      : tone === "good"
        ? "tone-success"
        : "border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]";

  return (
    <div className={`rounded-[22px] border p-4 ${className}`}>
      <div className="font-semibold text-[var(--ink)]">{title}</div>
      <div className="mt-2 break-words text-sm leading-6">{body}</div>
    </div>
  );
}

function average(values: number[]) {
  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function SessionInsightsPanel({
  completedJobs,
  currentTarget,
  analysisMode,
  historyEnabled,
  recentSessionCount,
  onOpenCompare,
  onOpenQueue,
  onOpenJob,
}: SessionInsightsPanelProps) {
  const readyJobs = useMemo(() => getCompletedAnalysisJobs(completedJobs), [completedJobs]);

  const averageIntegrated = useMemo(
    () => averageIntegratedLufs(readyJobs),
    [readyJobs],
  );
  const averagePeak = useMemo(
    () => average(readyJobs.map((job) => job.result.metrics.truePeakDbtp)),
    [readyJobs],
  );
  // Only average files that actually have a planned move; coercing missing
  // deltas to 0 would drag the mean toward zero and misreport the batch.
  const averageMove = useMemo(
    () =>
      average(
        readyJobs
          .map((job) => job.result.metrics.targetDeltaDb)
          .filter((value): value is number => value != null),
      ),
    [readyJobs],
  );

  const sampleRates = useMemo(() => getSessionSampleRates(readyJobs), [readyJobs]);
  const layouts = useMemo(() => getSessionChannelLayouts(readyJobs), [readyJobs]);
  const decoderMix = useMemo(() => getDecoderMix(readyJobs), [readyJobs]);

  const quietestJob = useMemo(() => getQuietestJob(readyJobs), [readyJobs]);
  const hottestPeakJob = useMemo(() => getHottestPeakJob(readyJobs), [readyJobs]);
  const widestRangeJob = useMemo(() => getWidestRangeJob(readyJobs), [readyJobs]);
  const longestJob = useMemo(() => getLongestJob(readyJobs), [readyJobs]);
  // Small batches often have one file win both categories at once; fold
  // them into a single tile instead of repeating the file name (UX-011).
  const widestIsLongest = widestRangeJob != null && longestJob != null && widestRangeJob.id === longestJob.id;
  const largestMoveJob = useMemo(() => getLargestMoveJob(readyJobs), [readyJobs]);
  const highestProjectedPeak = useMemo(() => getHighestProjectedPeakJob(readyJobs), [readyJobs]);

  const complianceCounts = useMemo(() => getComplianceCounts(readyJobs), [readyJobs]);
  const attentionJobs = useMemo(() => getAttentionJobs(readyJobs), [readyJobs]);
  const ceilingLimitedJobs = useMemo(
    () => readyJobs.filter((job) => getComplianceSummary(job.result)?.state === "ceiling-limited"),
    [readyJobs],
  );
  const invalidIntegratedCount = useMemo(
    () =>
      readyJobs.filter(
        (job) => job.result.metrics.integratedValid === false,
      ).length,
    [readyJobs],
  );
  const unverifiedCount = useMemo(
    () => readyJobs.filter(isUnverifiedImport).length,
    [readyJobs],
  );

  const targetedFocusJobs = useMemo(() => getTargetedFocusJobs(readyJobs).slice(0, 4), [readyJobs]);
  const measureOnlyFocusJobs = useMemo(() => getMeasureOnlyFocusJobs(readyJobs).slice(0, 4), [readyJobs]);

  const recommendations = useMemo(() => {
    const items: Array<{ title: string; body: string; tone: "default" | "warn" | "good" }> = [];

    if (unverifiedCount) {
      items.push({
        title: "Imported results are unverified",
        body: `${unverifiedCount} imported result${unverifiedCount === 1 ? " is" : "s are"} view-only evidence. Re-analyze the source audio before using these measurements for compliance or delivery decisions.`,
        tone: "warn",
      });
    }

    if (invalidIntegratedCount) {
      items.push({
        title: "Some files have no valid integrated measurement",
        body: `${invalidIntegratedCount} file${invalidIntegratedCount === 1 ? " is" : "s are"} too short or below the loudness gate. Those files are excluded from averages, target guidance, compliance counts, and integrated-loudness comparisons.`,
        tone: "warn",
      });
    }

    if (analysisMode === "targeted" && currentTarget) {
      if (ceilingLimitedJobs.length) {
        items.push({
          title: "Ceiling-limited files need a second look",
          body: `${ceilingLimitedJobs.length} file${ceilingLimitedJobs.length === 1 ? " is" : "s are"} having gain capped by the selected true peak ceiling. Consider a gentler target, or look at material with a high crest factor before batch normalization.`,
          tone: "warn",
        });
      }

      if (sampleRates.length > 1) {
        items.push({
          title: "Mixed sample rates detected",
          body: `This session spans ${sampleRates.map((rate) => `${rate / 1000} kHz`).join(", ")}. Analysis is fine, but decide whether your final delivery should also be sample-rate-normalized.`,
          tone: "default",
        });
      }

      if (decoderMix.length > 1) {
        items.push({
          title: "Decoder paths are mixed",
          body: `The batch used multiple decode routes (${decoderMix.map(([label, count]) => `${label} x${count}`).join(" | ")}). Inspect the technical tab on outliers if metadata consistency matters.`,
          tone: "default",
        });
      }

      const validTargetedCount =
        complianceCounts["on-target"] +
        complianceCounts["above-target"] +
        complianceCounts["below-target"] +
        complianceCounts["ceiling-limited"];
      const needsAdjustment =
        complianceCounts["above-target"] +
        complianceCounts["below-target"] +
        complianceCounts["ceiling-limited"];
      if (validTargetedCount > 0 && needsAdjustment > 0) {
        const allBelow = complianceCounts["below-target"] === validTargetedCount;
        const allAbove =
          complianceCounts["above-target"] +
            complianceCounts["ceiling-limited"] ===
          validTargetedCount;
        items.push({
          title: allBelow
            ? "The batch is consistently below target"
            : allAbove
              ? "The batch is consistently above target"
              : "The batch has mixed target outcomes",
          body: allBelow
            ? `Every valid result needs gain to reach ${currentTarget.label}. Review the suggested moves and projected peaks before applying a batch-wide adjustment.`
            : allAbove
              ? `Every valid result is above ${currentTarget.label} or constrained by its ceiling. Review attenuation and ceiling-limited files before delivery.`
              : `${needsAdjustment} of ${validTargetedCount} valid result${validTargetedCount === 1 ? "" : "s"} still need a gain or ceiling decision; use Compare to separate the groups.`,
          tone: "warn",
        });
      }

      if (
        !items.length &&
        validTargetedCount > 0 &&
        complianceCounts["on-target"] === validTargetedCount
      ) {
        items.push({
          title: "Batch looks consistent",
          body: `Completed files are clustering cleanly around the ${currentTarget.label} target, with no obvious decoder or delivery mismatch to resolve first.`,
          tone: "good",
        });
      }

      return items;
    }

    if ((hottestPeakJob?.result.metrics.truePeakDbtp ?? -999) > -1) {
      items.push({
        title: "A file is peaking close to full scale",
        body: `${hottestPeakJob?.fileName ?? "One file"} is sitting at ${formatPeakDbtp(hottestPeakJob?.result.metrics.truePeakDbtp)}. That is useful context even without a target, because it leaves less room for later gain staging.`,
        tone: "warn",
      });
    }

    if (layouts.length > 1) {
      items.push({
        title: "Channel layouts are mixed",
        body: `This session spans ${layouts.join(" | ")}. Keep that in mind before comparing integrated loudness decisions too literally across stereo and surround sources.`,
        tone: "default",
      });
    }

    if (sampleRates.length > 1) {
      items.push({
        title: "Sample rates vary across the batch",
        body: `You have ${sampleRates.map((rate) => `${rate / 1000} kHz`).join(" | ")} in the same review pass. That is fine for inspection, but it may matter if you later export to a single delivery spec.`,
        tone: "default",
      });
    }

    if (!items.length) {
      items.push({
        title: "Measurement-only view is clean",
        body: "The batch is ready for a straight loudness review. Use Compare to inspect spread and outliers, then switch to Targeted only if you need normalization planning.",
        tone: "good",
      });
    }

    return items;
  }, [
    analysisMode,
    ceilingLimitedJobs.length,
    complianceCounts,
    currentTarget,
    decoderMix,
    hottestPeakJob,
    invalidIntegratedCount,
    layouts,
    sampleRates,
    unverifiedCount,
  ]);

  const focusJobs = analysisMode === "targeted" ? targetedFocusJobs : measureOnlyFocusJobs;

  if (!readyJobs.length) {
    return (
      <Card className="tp-enter-soft p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">
          <Lightbulb className="h-7 w-7" aria-hidden="true" />
        </div>
        <h2 className="mt-5 text-2xl font-semibold text-[var(--ink)]">Insights appear as files finish</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          Once the first file finishes, this screen summarizes the batch as next-step notes and technical context.
        </p>
        {onOpenQueue ? (
          <Button type="button" size="sm" variant="secondary" onClick={onOpenQueue} className="mt-5">
            <AudioLines className="h-4 w-4" aria-hidden="true" />
            Open Queue
          </Button>
        ) : null}
      </Card>
    );
  }

  return (
    <section className="tp-enter-soft space-y-6">
      {unverifiedCount ? (
        <div className="tone-warning rounded-[22px] border p-4 text-sm leading-6" role="status">
          <div className="flex items-start gap-3">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-semibold text-[var(--ink)]">
                {unverifiedCount} unverified imported result{unverifiedCount === 1 ? "" : "s"}
              </div>
              <div className="mt-1">Insights may summarize these rows for review, but they are not trusted until the source audio is re-analyzed.</div>
            </div>
          </div>
        </div>
      ) : null}
      {/* Recommendations lead the view (UX-011): on mobile, the counter
          tiles below used to push "What stands out in this batch" past a
          full screen of scrolling before it was reachable. */}
      <Card className="p-5 sm:p-6">
        <div className="flex items-center gap-3 text-[var(--muted)]">
          <Sparkles className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
          <div className="text-[11px] uppercase tracking-[0.18em]">Recommendations</div>
        </div>
        <h2 className="mt-3 text-2xl font-semibold text-[var(--ink)]">What stands out in this batch</h2>
        <div className="mt-5 space-y-3">
          {recommendations.map((recommendation) => (
            <RecommendationCard
              key={recommendation.title}
              title={recommendation.title}
              body={recommendation.body}
              tone={recommendation.tone}
            />
          ))}
        </div>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {analysisMode === "targeted" ? (
          <>
            <InsightMetric label="Ready now" value={String(complianceCounts["on-target"])} hint="Already inside the current target window" accent />
            <InsightMetric label="Needs gain" value={String(complianceCounts["below-target"])} hint="Below target but not ceiling-limited" />
            <InsightMetric label="Attention" value={String(attentionJobs.length)} hint="Outside target or integrated unavailable" />
            <InsightMetric label="Average move" value={averageMove == null ? "n/a" : formatRelativeDb(averageMove)} hint="Average planned gain across completed files" />
            <InsightMetric label="Projected hottest" value={highestProjectedPeak ? formatPeakDbtp(highestProjectedPeak.result.metrics.projectedTruePeakDbtp) : "n/a"} hint={highestProjectedPeak ? highestProjectedPeak.fileName : "Waiting for completed jobs"} />
            <InsightMetric label="History" value={historyEnabled ? "On" : "Off"} hint={historyEnabled ? `${recentSessionCount} saved summaries available` : "Recent-summary history is off; recovery storage is separate"} />
          </>
        ) : (
          <>
            <InsightMetric label="Completed" value={String(readyJobs.length)} hint="Files with measured loudness data" accent />
            <InsightMetric label="Average LUFS" value={formatLufs(averageIntegrated)} hint="Average across valid integrated readings" />
            <InsightMetric label="Average peak" value={formatPeakDbtp(averagePeak)} hint="True-peak average across completed files" />
            {widestIsLongest && widestRangeJob ? (
              <InsightMetric
                label="Widest LRA + Longest file"
                value={formatLoudnessRange(widestRangeJob.result.metrics)}
                hint={`${widestRangeJob.fileName} • ${formatDuration(widestRangeJob.result.metadata.durationSeconds)}`}
              />
            ) : (
              <>
                <InsightMetric label="Widest LRA" value={widestRangeJob ? formatLoudnessRange(widestRangeJob.result.metrics) : "n/a"} hint={widestRangeJob ? widestRangeJob.fileName : "Waiting for completed jobs"} />
                <InsightMetric label="Longest file" value={longestJob ? formatDuration(longestJob.result.metadata.durationSeconds) : "n/a"} hint={longestJob ? longestJob.fileName : "Waiting for completed jobs"} />
              </>
            )}
            <InsightMetric label="History" value={historyEnabled ? "On" : "Off"} hint={historyEnabled ? `${recentSessionCount} saved summaries available` : "Recent-summary history is off; recovery storage is separate"} />
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <div className="flex items-center gap-3 text-[var(--muted)]">
              {analysisMode === "targeted" ? (
                <ShieldCheck className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
              ) : (
                <Waves className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
              )}
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                {analysisMode === "targeted" ? "Preset summary" : "Raw measurement"}
              </div>
            </div>
            <h2 className="mt-3 text-2xl font-semibold text-[var(--ink)]">
              {analysisMode === "targeted" ? "Current preset" : "Measured source view"}
            </h2>

            {analysisMode === "targeted" && currentTarget ? (
              <>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{currentTarget.description}</p>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <InsightMetric label="Target" value={formatPresetLufs(currentTarget.loudnessTargetLufs)} hint={currentTarget.label} accent />
                  <InsightMetric label="Ceiling" value={formatPresetPeakDbtp(currentTarget.truePeakCeilingDbtp)} hint={currentTarget.policy === "protect-true-peak" ? "Gain capped when needed" : "Reference ceiling only"} />
                  <InsightMetric label="Tolerance" value={`±${currentTarget.toleranceLufs.toFixed(2)} LU`} hint={currentTarget.sourceLabel} />
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  {currentTarget.highlights.map((highlight) => (
                    <Badge key={highlight} className="border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">
                      {highlight}
                    </Badge>
                  ))}
                </div>
                <div className="mt-4 rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
                  {currentTarget.referenceNote}
                </div>
                {currentTarget.referenceUrl ? (
                  <a
                    href={currentTarget.referenceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface-0)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition-[border-color,color,background-color] duration-200 ease-out hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    View {currentTarget.sourceLabel}
                    <span className="sr-only"> (opens in a new tab)</span>
                    <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                ) : null}
              </>
            ) : (
              <>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                  Raw mode keeps the numbers exactly as measured. Switch to Targeted only when you want gain planning, projected peak, and compliance labels.
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  <InsightMetric label="Mode" value="Measure Only" hint="No normalization target applied" accent />
                  <InsightMetric label="Quietest" value={quietestJob ? formatIntegratedLufs(quietestJob.result.metrics) : "n/a"} hint={quietestJob ? quietestJob.fileName : "Waiting for a valid integrated measurement"} />
                  <InsightMetric label="Hottest peak" value={hottestPeakJob ? formatPeakDbtp(hottestPeakJob.result.metrics.truePeakDbtp) : "n/a"} hint={hottestPeakJob ? hottestPeakJob.fileName : "Waiting for completed jobs"} />
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <div className="flex items-center gap-3 text-[var(--muted)]">
              <BarChart3 className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
              <div className="text-[11px] uppercase tracking-[0.18em]">Batch signature</div>
            </div>
            <h2 className="mt-3 text-2xl font-semibold text-[var(--ink)]">Session profile</h2>
            <div className="mt-5 space-y-3 text-sm leading-6 text-[var(--muted)]">
              <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
                <div className="font-semibold text-[var(--ink)]">Decoder mix</div>
                <div className="mt-1 break-words">{decoderMix.map(([label, count]) => `${label} x${count}`).join(" | ")}</div>
              </div>
              <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
                <div className="font-semibold text-[var(--ink)]">Sample rates</div>
                <div className="mt-1 break-words">{sampleRates.map((rate) => `${rate / 1000} kHz`).join(" | ")}</div>
              </div>
              <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
                <div className="font-semibold text-[var(--ink)]">Channel layouts</div>
                <div className="mt-1 break-words">{layouts.join(" | ")}</div>
              </div>
              <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
                <div className="font-semibold text-[var(--ink)]">Highlighted outlier</div>
                <div className="mt-1 break-words text-[var(--ink)]">
                  {analysisMode === "targeted"
                    ? largestMoveJob
                      ? `${largestMoveJob.fileName} (${formatRelativeDb(largestMoveJob.result.metrics.targetDeltaDb)})`
                      : "n/a"
                    : widestRangeJob
                      ? `${widestRangeJob.fileName} (${formatLoudnessRange(widestRangeJob.result.metrics)})`
                      : "n/a"}
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="flex items-center gap-3 text-[var(--muted)]">
              <CircleAlert className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
              <div className="text-[11px] uppercase tracking-[0.18em]">Focus queue</div>
            </div>
            <h2 className="mt-3 text-2xl font-semibold text-[var(--ink)]">Start with these files</h2>
            <div className="mt-5 space-y-3">
              {focusJobs.length ? (
                focusJobs.map((job) => {
                  const summary = getComplianceSummary(job.result);
                  return (
                    <div key={job.id} className="min-w-0 overflow-hidden rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4 [content-visibility:auto] [contain-intrinsic-size:190px]">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="break-words text-sm font-semibold text-[var(--ink)]">{job.fileName}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {summary ? <Badge>{summary.label}</Badge> : job.result.metrics.integratedValid === false ? <Badge className="tone-warning">Integrated unavailable</Badge> : <Badge>Measure Only</Badge>}
                            {isUnverifiedImport(job) ? <Badge className="tone-warning">Unverified import</Badge> : null}
                            <Badge className="max-w-full break-words border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">{job.result.metadata.decoderLabel}</Badge>
                            <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">{formatDuration(job.result.metadata.durationSeconds)}</Badge>
                          </div>
                          <div className="mt-3 break-words text-sm leading-6 text-[var(--muted)]">
                            Integrated {formatIntegratedLufs(job.result.metrics)} | True Peak {formatPeakDbtp(job.result.metrics.truePeakDbtp)} | LRA {formatLoudnessRange(job.result.metrics)}
                            {analysisMode === "targeted"
                              ? ` | Gain ${formatRelativeDb(job.result.metrics.targetDeltaDb)}`
                              : ""}
                          </div>
                        </div>
                        <Button type="button" size="sm" variant="secondary" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`} className="shrink-0">
                          Inspect
                        </Button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-[22px] border border-dashed border-[var(--line)] bg-[var(--surface-1)] p-5 text-sm leading-6 text-[var(--muted)]">
                  No obvious outliers need a first-pass inspection. The completed files are still available in Queue and Compare when you want to review them one by one.
                </div>
              )}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={onOpenCompare}>
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
                Open Compare
              </Button>
              {hottestPeakJob ? (
                <Button type="button" size="sm" variant="secondary" onClick={() => onOpenJob(hottestPeakJob.id)} aria-label={`Inspect hottest peak ${hottestPeakJob.fileName}`}>
                  Inspect Hottest Peak
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}
