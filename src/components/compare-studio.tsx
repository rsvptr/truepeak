"use client";

import { useMemo } from "react";
import { ArrowRightLeft, AudioLines, BarChart3, CircleAlert, Target, Waves } from "lucide-react";
import { getComplianceSummary, type ComplianceState } from "@/audio/compliance";
import {
  formatDb,
  formatDuration,
  formatLufs,
  formatPeakDbtp,
  formatRelativeDb,
  formatRelativeLu,
} from "@/lib/format";
import {
  getAttentionJobs,
  getClosestToTargetJob,
  getComplianceCounts,
  getCompletedAnalysisJobs,
  getDecoderMix,
  getHottestPeakJob,
  getLargestMoveJob,
  getLoudestJob,
  getLongestJob,
  getQuietestJob,
  getWidestRangeJob,
  type CompletedAnalysisJob,
} from "@/lib/session-selectors";
import { complianceToneClass, deltaToneClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import type { AnalysisJob, AnalysisMode, TargetPreset } from "@/types/audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export type CompareView = "cards" | "board" | "reference" | "table";
export type CompareSort = "integrated" | "truePeak" | "lra" | "gain" | "duration" | "name";
export type SortDirection = "asc" | "desc";
export type CompareFilter = "all" | "on-target" | "attention";

interface CompareStudioProps {
  completedJobs: AnalysisJob[];
  currentTarget: TargetPreset | null;
  analysisMode: AnalysisMode;
  selectedJobId: string | null;
  referenceId: string | null;
  compareView: CompareView;
  compareSort: CompareSort;
  compareDirection: SortDirection;
  compareFilter: CompareFilter;
  onReferenceIdChange: (referenceId: string | null) => void;
  onCompareViewChange: (view: CompareView) => void;
  onCompareSortChange: (sort: CompareSort) => void;
  onCompareFilterChange: (filter: CompareFilter) => void;
  onOpenQueue?: () => void;
  onOpenJob: (jobId: string) => void;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const numberFormatter = new Intl.NumberFormat("en-GB");
const TARGETED_VIEWS: Array<{ id: CompareView; label: string; description: string }> = [
  { id: "cards", label: "Ranked Cards", description: "Scan the batch in a richer card view." },
  { id: "board", label: "Status Board", description: "Group files by what needs attention next." },
  { id: "reference", label: "Reference Delta", description: "See how each file differs from a chosen reference." },
  { id: "table", label: "Comparison Table", description: "Use a dense table when you want everything at once." },
];
const MEASURE_ONLY_VIEWS: Array<{ id: CompareView; label: string; description: string }> = [
  { id: "cards", label: "Ranked Cards", description: "Scan loudness, peak, and dynamics without applying a target." },
  { id: "reference", label: "Reference Delta", description: "Compare measured deltas against a chosen file, or leave reference off." },
  { id: "table", label: "Comparison Table", description: "Use a dense table when you want everything at once." },
];
const TARGETED_SORTS: Array<{ id: CompareSort; label: string }> = [
  { id: "integrated", label: "Integrated" },
  { id: "truePeak", label: "True Peak" },
  { id: "lra", label: "LRA" },
  { id: "gain", label: "Gain" },
  { id: "duration", label: "Duration" },
  { id: "name", label: "Name" },
];
const MEASURE_ONLY_SORTS: Array<{ id: CompareSort; label: string }> = [
  { id: "integrated", label: "Integrated" },
  { id: "truePeak", label: "True Peak" },
  { id: "lra", label: "LRA" },
  { id: "duration", label: "Duration" },
  { id: "name", label: "Name" },
];
const COMPARE_FILTERS: Array<{ id: CompareFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "on-target", label: "On Target" },
  { id: "attention", label: "Attention" },
];
const BOARD_COLUMNS: Array<{ state: ComplianceState; label: string; description: string }> = [
  { state: "on-target", label: "On Target", description: "Inside the selected loudness window." },
  { state: "below-target", label: "Needs Gain", description: "Below target and likely wants gain." },
  { state: "above-target", label: "Too Hot", description: "Above target and likely wants attenuation." },
  { state: "ceiling-limited", label: "Ceiling-Limited", description: "Projected peak is capping the gain move." },
];

function axisPercent(value: number, min: number, max: number) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return 50;
  }

  const raw = ((value - min) / (max - min)) * 100;
  return Math.min(100, Math.max(0, raw));
}

function insightSpread(values: number[]) {
  if (!values.length) {
    return null;
  }

  return Math.max(...values) - Math.min(...values);
}

function compareNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return Number.NEGATIVE_INFINITY;
  }

  return value;
}

function formatSortDirection(direction: SortDirection) {
  return direction === "asc" ? "Ascending" : "Descending";
}

function compareJobs(
  left: CompletedAnalysisJob,
  right: CompletedAnalysisJob,
  compareSort: CompareSort,
  compareDirection: SortDirection,
) {
  let compare = 0;

  switch (compareSort) {
    case "name":
      compare = collator.compare(left.fileName, right.fileName);
      break;
    case "truePeak":
      compare = left.result.metrics.truePeakDbtp - right.result.metrics.truePeakDbtp;
      break;
    case "lra":
      compare = left.result.metrics.loudnessRange - right.result.metrics.loudnessRange;
      break;
    case "gain":
      compare = compareNumber(left.result.metrics.targetDeltaDb) - compareNumber(right.result.metrics.targetDeltaDb);
      break;
    case "duration":
      compare = left.result.metadata.durationSeconds - right.result.metadata.durationSeconds;
      break;
    case "integrated":
    default:
      compare = left.result.metrics.integratedLufs - right.result.metrics.integratedLufs;
      break;
  }

  return compareDirection === "asc" ? compare : -compare;
}

function CompareMetricTile({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[22px] border p-4",
        accent
          ? "border-[color:var(--accent)]/25 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)]/70 bg-[var(--surface-1)]/64",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 min-w-0 break-words text-[clamp(1.05rem,1.6vw,1.5rem)] font-semibold leading-tight tabular-nums text-[var(--ink)]">{value}</div>
      {hint ? <div className="mt-1 min-w-0 break-words text-xs leading-5 text-[var(--muted)]">{hint}</div> : null}
    </div>
  );
}

function RangeLane({
  label,
  valueLabel,
  minLabel,
  maxLabel,
  valuePercent,
  markerPercent,
  markerLabel,
  toneClassName,
}: {
  label: string;
  valueLabel: string;
  minLabel: string;
  maxLabel: string;
  valuePercent: number;
  markerPercent?: number;
  markerLabel?: string;
  toneClassName: string;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3 text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
        <span className="min-w-0 break-words">{label}</span>
        <span className="shrink-0 text-[var(--ink)]">{valueLabel}</span>
      </div>
      <div className="relative mt-2 h-2.5 rounded-full bg-[var(--surface-2)]">
        {markerPercent != null ? (
          <div className="absolute top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-[var(--muted)]" style={{ left: `${markerPercent}%` }} />
        ) : null}
        <div
          className={cn(
            "absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20 shadow-[0_0_0_4px_rgba(255,255,255,0.04)]",
            toneClassName,
          )}
          style={{ left: `${valuePercent}%` }}
        />
      </div>
      <div className="mt-1 grid grid-cols-[1fr_minmax(0,1.4fr)_1fr] gap-3 text-[10px] text-[var(--muted)]">
        <span className="min-w-0 break-words">{minLabel}</span>
        <span className="min-w-0 break-words text-center">{markerLabel ?? "Batch range"}</span>
        <span className="min-w-0 break-words text-right">{maxLabel}</span>
      </div>
    </div>
  );
}

export function CompareStudio({
  completedJobs,
  currentTarget,
  analysisMode,
  selectedJobId,
  referenceId,
  compareView: compareViewProp,
  compareSort: compareSortProp,
  compareDirection: compareDirectionProp,
  compareFilter: compareFilterProp,
  onReferenceIdChange,
  onCompareViewChange,
  onCompareSortChange,
  onCompareFilterChange,
  onOpenQueue,
  onOpenJob,
}: CompareStudioProps) {
  const availableViews = analysisMode === "targeted" ? TARGETED_VIEWS : MEASURE_ONLY_VIEWS;
  const availableSorts = analysisMode === "targeted" ? TARGETED_SORTS : MEASURE_ONLY_SORTS;
  const compareView = availableViews.some((view) => view.id === compareViewProp) ? compareViewProp : "cards";
  const compareSort = availableSorts.some((sort) => sort.id === compareSortProp) ? compareSortProp : "integrated";
  const compareDirection = compareDirectionProp === "asc" || compareDirectionProp === "desc" ? compareDirectionProp : compareSort === "name" ? "asc" : "desc";
  const compareFilter = analysisMode === "targeted" ? compareFilterProp : "all";

  const readyJobs = useMemo(() => getCompletedAnalysisJobs(completedJobs), [completedJobs]);
  const selectedCompletedJob = useMemo(
    () => readyJobs.find((job) => job.id === selectedJobId) ?? null,
    [readyJobs, selectedJobId],
  );
  const closestToTargetJob = useMemo(
    () => getClosestToTargetJob(readyJobs, analysisMode === "targeted" && currentTarget ? currentTarget.loudnessTargetLufs : null),
    [analysisMode, currentTarget, readyJobs],
  );
  const quietestJob = useMemo(() => getQuietestJob(readyJobs), [readyJobs]);
  const loudestJob = useMemo(() => getLoudestJob(readyJobs), [readyJobs]);
  const hottestPeakJob = useMemo(() => getHottestPeakJob(readyJobs), [readyJobs]);
  const widestRangeJob = useMemo(() => getWidestRangeJob(readyJobs), [readyJobs]);
  const longestJob = useMemo(() => getLongestJob(readyJobs), [readyJobs]);
  const largestMoveJob = useMemo(() => getLargestMoveJob(readyJobs), [readyJobs]);

  const complianceCounts = useMemo(() => getComplianceCounts(readyJobs), [readyJobs]);
  const attentionJobs = useMemo(() => getAttentionJobs(readyJobs), [readyJobs]);

  const filterCounts = useMemo<Record<CompareFilter, number>>(
    () => ({
      all: readyJobs.length,
      "on-target": complianceCounts["on-target"],
      attention: attentionJobs.length,
    }),
    [attentionJobs.length, complianceCounts, readyJobs.length],
  );

  const filteredJobs = useMemo(() => {
    if (analysisMode !== "targeted") {
      return readyJobs;
    }

    switch (compareFilter) {
      case "on-target":
        return readyJobs.filter((job) => getComplianceSummary(job.result)?.state === "on-target");
      case "attention":
        return attentionJobs;
      case "all":
      default:
        return readyJobs;
    }
  }, [analysisMode, attentionJobs, compareFilter, readyJobs]);

  const sortedJobs = useMemo(
    () => [...filteredJobs].sort((left, right) => compareJobs(left, right, compareSort, compareDirection)),
    [compareDirection, compareSort, filteredJobs],
  );
  const boardGroups = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => ({
        ...column,
        jobs: sortedJobs.filter((job) => getComplianceSummary(job.result)?.state === column.state),
      })),
    [sortedJobs],
  );
  const referenceJob = useMemo(
    () => (referenceId ? readyJobs.find((job) => job.id === referenceId) ?? null : null),
    [readyJobs, referenceId],
  );
  const quickReferenceActions = useMemo(() => {
    const actions: Array<{ label: string; job: CompletedAnalysisJob }> = [];

    if (selectedCompletedJob) {
      actions.push({ label: "Use selected file", job: selectedCompletedJob });
    }

    if (analysisMode === "targeted" && closestToTargetJob && closestToTargetJob.id !== selectedCompletedJob?.id) {
      actions.push({ label: "Use closest match", job: closestToTargetJob });
    }

    if (!actions.length && readyJobs[0]) {
      actions.push({ label: "Use first completed", job: readyJobs[0] });
    }

    return actions;
  }, [analysisMode, closestToTargetJob, readyJobs, selectedCompletedJob]);

  const integratedSpread = useMemo(
    () => insightSpread(readyJobs.map((job) => job.result.metrics.integratedLufs)),
    [readyJobs],
  );
  const peakSpread = useMemo(
    () => insightSpread(readyJobs.map((job) => job.result.metrics.truePeakDbtp)),
    [readyJobs],
  );
  const decoderMix = useMemo(() => getDecoderMix(readyJobs), [readyJobs]);
  const decoderSummary = decoderMix.length
    ? decoderMix.map(([label, count]) => `${label} x${count}`).join(" | ")
    : "Waiting for completed jobs";

  const integratedRange = useMemo(() => {
    if (!readyJobs.length) {
      return null;
    }

    const values = readyJobs.map((job) => job.result.metrics.integratedLufs);
    const marker = analysisMode === "targeted" && currentTarget ? currentTarget.loudnessTargetLufs : null;
    const rangeValues = marker == null ? values : [...values, marker];
    return {
      min: Math.min(...rangeValues),
      max: Math.max(...rangeValues),
      marker,
      label: marker == null ? "Batch range" : `Target ${formatLufs(marker)}`,
    };
  }, [analysisMode, currentTarget, readyJobs]);

  const truePeakRange = useMemo(() => {
    if (!readyJobs.length) {
      return null;
    }

    const values = readyJobs.map((job) => job.result.metrics.truePeakDbtp);
    const marker = analysisMode === "targeted" && currentTarget ? currentTarget.truePeakCeilingDbtp : null;
    const rangeValues = marker == null ? values : [...values, marker];
    return {
      min: Math.min(...rangeValues),
      max: Math.max(...rangeValues),
      marker,
      label: marker == null ? "Batch range" : `Ceiling ${formatPeakDbtp(marker)}`,
    };
  }, [analysisMode, currentTarget, readyJobs]);

  const topLaneJobs = useMemo(() => sortedJobs.slice(0, 8), [sortedJobs]);

  const toggleCompareSort = (sortId: CompareSort) => {
    onCompareSortChange(sortId);
  };

  if (!readyJobs.length) {
    return (
      <Card className="tp-enter-soft p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">
          <BarChart3 className="h-7 w-7" aria-hidden="true" />
        </div>
        <h2 className="mt-5 text-2xl font-semibold text-[var(--ink)]">Compare opens as soon as files finish</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          Cards, reference deltas, and the comparison table become available once the first result is ready.
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
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {analysisMode === "targeted" ? (
          <>
            <CompareMetricTile label="Closest to target" value={closestToTargetJob ? closestToTargetJob.fileName : "n/a"} hint={closestToTargetJob ? formatLufs(closestToTargetJob.result.metrics.integratedLufs) : "Waiting for completed jobs"} accent />
            <CompareMetricTile label="Quietest file" value={quietestJob ? quietestJob.fileName : "n/a"} hint={quietestJob ? formatLufs(quietestJob.result.metrics.integratedLufs) : "Waiting for completed jobs"} />
            <CompareMetricTile label="Hottest peak" value={hottestPeakJob ? hottestPeakJob.fileName : "n/a"} hint={hottestPeakJob ? formatPeakDbtp(hottestPeakJob.result.metrics.truePeakDbtp) : "Waiting for completed jobs"} />
            <CompareMetricTile label="Widest LRA" value={widestRangeJob ? widestRangeJob.fileName : "n/a"} hint={widestRangeJob ? formatDb(widestRangeJob.result.metrics.loudnessRange, "LU") : "Waiting for completed jobs"} />
            <CompareMetricTile label="Integrated spread" value={integratedSpread == null ? "n/a" : formatDb(integratedSpread, "LU")} hint="Window between the quietest and loudest completed files" />
            <CompareMetricTile label="Largest move" value={largestMoveJob ? formatRelativeDb(largestMoveJob.result.metrics.targetDeltaDb) : "n/a"} hint={largestMoveJob ? largestMoveJob.fileName : "Waiting for completed jobs"} />
          </>
        ) : (
          <>
            <CompareMetricTile label="Quietest file" value={quietestJob ? quietestJob.fileName : "n/a"} hint={quietestJob ? formatLufs(quietestJob.result.metrics.integratedLufs) : "Waiting for completed jobs"} accent />
            <CompareMetricTile label="Loudest file" value={loudestJob ? loudestJob.fileName : "n/a"} hint={loudestJob ? formatLufs(loudestJob.result.metrics.integratedLufs) : "Waiting for completed jobs"} />
            <CompareMetricTile label="Hottest peak" value={hottestPeakJob ? hottestPeakJob.fileName : "n/a"} hint={hottestPeakJob ? formatPeakDbtp(hottestPeakJob.result.metrics.truePeakDbtp) : "Waiting for completed jobs"} />
            <CompareMetricTile label="Widest LRA" value={widestRangeJob ? widestRangeJob.fileName : "n/a"} hint={widestRangeJob ? formatDb(widestRangeJob.result.metrics.loudnessRange, "LU") : "Waiting for completed jobs"} />
            <CompareMetricTile label="Integrated spread" value={integratedSpread == null ? "n/a" : formatDb(integratedSpread, "LU")} hint="Window between the quietest and loudest completed files" />
            <CompareMetricTile label="Longest file" value={longestJob ? longestJob.fileName : "n/a"} hint={longestJob ? formatDuration(longestJob.result.metadata.durationSeconds) : "Waiting for completed jobs"} />
          </>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(320px,0.72fr)_minmax(0,1.28fr)]">
        <Card className="p-5 sm:p-6">
          <div className="flex items-center gap-3 text-[var(--muted)]">
            {analysisMode === "targeted" ? (
              <Target className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
            ) : (
              <Waves className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
            )}
            <div className="text-[11px] uppercase tracking-[0.18em]">Batch snapshot</div>
          </div>
          <h2 className="mt-3 text-2xl font-semibold text-[var(--ink)]">What stands out in this batch</h2>
          <div className="mt-5 space-y-3">
            {analysisMode === "targeted" ? (
              <>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm leading-6 text-[var(--muted)]">
                  <div className="font-semibold text-[var(--ink)]">{numberFormatter.format(complianceCounts["on-target"])} file{complianceCounts["on-target"] === 1 ? "" : "s"} are already inside the target window.</div>
                  <div className="mt-1">{numberFormatter.format(attentionJobs.length)} file{attentionJobs.length === 1 ? "" : "s"} still need attention because they are too hot or ceiling-limited.</div>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm leading-6 text-[var(--muted)]">
                  <div className="font-semibold text-[var(--ink)]">Decoder mix</div>
                  <div className="mt-1">{decoderSummary}</div>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm leading-6 text-[var(--muted)]">
                  <div className="font-semibold text-[var(--ink)]">Reference suggestion</div>
                  <div className="mt-1">{closestToTargetJob ? `${closestToTargetJob.fileName} is the best anchor if you want the rest of the batch to converge around the current target.` : "Pick a completed file to anchor the delta view."}</div>
                </div>
                {attentionJobs.length ? (
                  <div className="tone-warning rounded-[20px] border p-4 text-sm leading-6">
                    <div className="flex items-start gap-3">
                      <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                      <div>
                        <div className="font-semibold text-[var(--ink)]">Actionable note</div>
                        <div className="mt-1">Use the reference view or status board first when several files are outside the window. It is the quickest way to spot whether the batch needs level changes, a different target, or a closer listen.</div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm leading-6 text-[var(--muted)]">
                  <div className="font-semibold text-[var(--ink)]">Decoder mix</div>
                  <div className="mt-1">{decoderSummary}</div>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm leading-6 text-[var(--muted)]">
                  <div className="font-semibold text-[var(--ink)]">Loudness spread</div>
                  <div className="mt-1">The batch spans {integratedSpread == null ? "n/a" : formatDb(integratedSpread, "LU")}. Use the cards for a quick triage, then open the table if you need denser side-by-side numbers.</div>
                </div>
                <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4 text-sm leading-6 text-[var(--muted)]">
                  <div className="font-semibold text-[var(--ink)]">Reference suggestion</div>
                  <div className="mt-1">Choose any steady, representative file when you want delta cards. Leaving reference off keeps the compare view focused on raw measurements.</div>
                </div>
              </>
            )}
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="flex items-center gap-3 text-[var(--muted)]">
            <BarChart3 className="h-5 w-5 text-[var(--accent)]" aria-hidden="true" />
            <div className="text-[11px] uppercase tracking-[0.18em]">Batch range</div>
          </div>
          <h2 className="mt-3 text-2xl font-semibold text-[var(--ink)]">See each file against the batch</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            {analysisMode === "targeted"
              ? `Use this to see where files sit against the current target and ceiling without scanning the full table. Peak spread across finished files: ${peakSpread == null ? "n/a" : formatDb(peakSpread, "dBTP")}.`
              : `Use this to see how loudness and peak values cluster before deciding whether a target is needed. Peak spread across finished files: ${peakSpread == null ? "n/a" : formatDb(peakSpread, "dBTP")}.`}
          </p>
          <div className="mt-5 space-y-3">
            {topLaneJobs.map((job) => {
              const compliance = getComplianceSummary(job.result);
              return (
                  <div key={job.id} className="min-w-0 overflow-hidden rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4 [content-visibility:auto] [contain-intrinsic-size:180px]">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="break-words text-sm font-semibold text-[var(--ink)]">{job.fileName}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : <Badge>Measure Only</Badge>}
                        <Badge className="max-w-full break-words">{job.result.metadata.decoderLabel}</Badge>
                        <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">{formatDuration(job.result.metadata.durationSeconds)}</Badge>
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="ghost" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>
                      Inspect
                    </Button>
                  </div>
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    {integratedRange ? (
                      <RangeLane label="Integrated" valueLabel={formatLufs(job.result.metrics.integratedLufs)} minLabel={formatLufs(integratedRange.min)} maxLabel={formatLufs(integratedRange.max)} valuePercent={axisPercent(job.result.metrics.integratedLufs, integratedRange.min, integratedRange.max)} markerPercent={integratedRange.marker == null ? undefined : axisPercent(integratedRange.marker, integratedRange.min, integratedRange.max)} markerLabel={integratedRange.label} toneClassName="bg-[var(--accent)]" />
                    ) : null}
                    {truePeakRange ? (
                      <RangeLane label="True peak" valueLabel={formatPeakDbtp(job.result.metrics.truePeakDbtp)} minLabel={formatPeakDbtp(truePeakRange.min)} maxLabel={formatPeakDbtp(truePeakRange.max)} valuePercent={axisPercent(job.result.metrics.truePeakDbtp, truePeakRange.min, truePeakRange.max)} markerPercent={truePeakRange.marker == null ? undefined : axisPercent(truePeakRange.marker, truePeakRange.min, truePeakRange.max)} markerLabel={truePeakRange.label} toneClassName="bg-[var(--chart-truepeak)]" />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Compare</div>
            <h2 className="mt-2 text-2xl font-semibold text-[var(--ink)]">Choose the view that best fits this batch</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">{availableViews.find((view) => view.id === compareView)?.description}</p>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Choose compare view">
            {availableViews.map((view) => (
              <Button key={view.id} type="button" size="sm" variant={compareView === view.id ? "primary" : "secondary"} aria-pressed={compareView === view.id} onClick={() => onCompareViewChange(view.id)}>
                {view.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)]">
          <div className="rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Filter</div>
            <div role="group" aria-label="Filter compare items" className="mt-3 flex flex-wrap gap-2">
              {(analysisMode === "targeted" ? COMPARE_FILTERS : [{ id: "all", label: "All" }]).map((filter) => (
                <Button key={filter.id} type="button" size="sm" variant={compareFilter === filter.id ? "primary" : "secondary"} aria-pressed={compareFilter === filter.id} onClick={() => onCompareFilterChange(filter.id as CompareFilter)}>
                  {filter.label}
                  {analysisMode === "targeted" ? <span className="text-[11px] opacity-70">{numberFormatter.format(filterCounts[filter.id as CompareFilter])}</span> : null}
                </Button>
              ))}
            </div>
            <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
              {analysisMode === "targeted" ? "Filter down to files already in range or the ones that still need attention." : "Raw mode keeps the full batch visible unless you choose a reference or another view."}
            </p>
          </div>
          <div className="rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
            {compareView === "reference" || compareView === "table" ? (
              <>
                <div className="flex items-center gap-3 text-[var(--muted)]">
                  <ArrowRightLeft className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                  <div className="text-[11px] uppercase tracking-[0.18em]">Reference</div>
                </div>
                <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-center">
                  <label htmlFor="compare-reference" className="sr-only">Choose a reference file</label>
                  <select id="compare-reference" name="compare-reference" aria-label="Choose reference file" value={referenceJob?.id ?? "none"} onChange={(event) => onReferenceIdChange(event.target.value === "none" ? null : event.target.value)} className="w-full rounded-full border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3 text-sm text-[var(--ink)] outline-none transition-[border-color,background-color] duration-200 ease-out focus:border-[var(--accent)] xl:max-w-md">
                    <option value="none">No reference</option>
                    {readyJobs.map((job) => (
                      <option key={job.id} value={job.id}>{job.fileName}</option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-2">
                    {selectedCompletedJob ? <Button type="button" size="sm" variant="secondary" onClick={() => onReferenceIdChange(selectedCompletedJob.id)} aria-label={`Use selected file as reference: ${selectedCompletedJob.fileName}`}>Use selected</Button> : null}
                    {analysisMode === "targeted" && closestToTargetJob && closestToTargetJob.id !== selectedCompletedJob?.id ? <Button type="button" size="sm" variant="secondary" onClick={() => onReferenceIdChange(closestToTargetJob.id)} aria-label={`Use closest match as reference: ${closestToTargetJob.fileName}`}>Use closest match</Button> : null}
                    <Button type="button" size="sm" variant="ghost" onClick={() => onReferenceIdChange(null)}>Clear</Button>
                  </div>
                </div>
                {referenceJob ? <p className="mt-3 break-words text-sm leading-6 text-[var(--muted)]">Reference file: <span className="font-semibold text-[var(--ink)]">{referenceJob.fileName}</span> at {formatLufs(referenceJob.result.metrics.integratedLufs)} and {formatPeakDbtp(referenceJob.result.metrics.truePeakDbtp)}.</p> : <p className="mt-3 text-sm leading-6 text-[var(--muted)]">No reference is selected. Delta columns stay hidden until you choose one.</p>}
              </>
            ) : (
              <>
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">View guide</div>
                <h3 className="mt-3 text-lg font-semibold text-[var(--ink)]">{compareView === "board" ? "Group the batch by likely action" : "Use cards for fast triage"}</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{compareView === "board" ? "The board groups files by the next likely move, which is helpful once larger sessions mix on-target and problematic masters." : "Cards give you more context than the table without locking the whole batch to a single reference."}</p>
              </>
            )}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Sort compare items">
          {availableSorts.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={compareSort === option.id ? "primary" : "secondary"}
              aria-pressed={compareSort === option.id}
              aria-label={
                compareSort === option.id
                  ? `Sort by ${option.label}, ${formatSortDirection(compareDirection).toLowerCase()}`
                  : `Sort by ${option.label}`
              }
              onClick={() => toggleCompareSort(option.id)}
            >
              {option.label}
              {compareSort === option.id ? <span className="text-[11px] opacity-70">{formatSortDirection(compareDirection)}</span> : null}
            </Button>
          ))}
        </div>

        {sortedJobs.length ? (
          <>
            {compareView === "cards" ? (
              <div className="mt-5 grid gap-4 xl:grid-cols-2">
                {sortedJobs.map((job, index) => {
                  const compliance = getComplianceSummary(job.result);
                  const distanceToTarget = currentTarget ? Math.abs(job.result.metrics.integratedLufs - currentTarget.loudnessTargetLufs) : null;
                  return (
                    <Card
                      key={job.id}
                      className="tp-selected-row overflow-hidden border-[var(--line)] bg-[var(--surface-1)] p-5 [content-visibility:auto] [contain-intrinsic-size:360px]"
                      data-selected={selectedJobId === job.id}
                      aria-current={selectedJobId === job.id ? "true" : undefined}
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>#{index + 1}</Badge>
                            {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : <Badge>Measure Only</Badge>}
                            {job.result.metrics.normalizationLimited ? <Badge className="tone-warning">Ceiling-limited</Badge> : null}
                          </div>
                          <h3 className="mt-3 break-words text-xl font-semibold text-[var(--ink)]">{job.fileName}</h3>
                          <p className="mt-2 break-words text-sm leading-6 text-[var(--muted)]">{job.result.metadata.channelLayout.name}, {numberFormatter.format(job.result.metadata.sampleRate)} Hz, {job.result.metadata.decoderLabel}</p>
                        </div>
                        <Button type="button" size="sm" variant="secondary" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>Inspect</Button>
                      </div>
                      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <CompareMetricTile label="Integrated" value={formatLufs(job.result.metrics.integratedLufs)} accent />
                        <CompareMetricTile label="True peak" value={formatPeakDbtp(job.result.metrics.truePeakDbtp)} />
                        <CompareMetricTile label="LRA" value={formatDb(job.result.metrics.loudnessRange, "LU")} />
                        <CompareMetricTile label="Max short-term" value={formatLufs(job.result.metrics.maxShortTermLufs)} />
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{analysisMode === "targeted" ? "Distance to target" : "Ungated loudness"}</div>
                          <div className="mt-2 text-lg font-semibold tabular-nums text-[var(--ink)]">{analysisMode === "targeted" ? formatDb(distanceToTarget, "LU") : formatLufs(job.result.metrics.ungatedLufs)}</div>
                        </div>
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{analysisMode === "targeted" ? "Gain move" : "Sample peak"}</div>
                          <div className="mt-2 text-lg font-semibold tabular-nums text-[var(--ink)]">{analysisMode === "targeted" ? formatRelativeDb(job.result.metrics.targetDeltaDb) : formatDb(job.result.metrics.samplePeakDbfs, "dBFS")}</div>
                        </div>
                        <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{analysisMode === "targeted" ? "Projected peak" : "Duration"}</div>
                          <div className="mt-2 text-lg font-semibold tabular-nums text-[var(--ink)]">{analysisMode === "targeted" ? formatPeakDbtp(job.result.metrics.projectedTruePeakDbtp) : formatDuration(job.result.metadata.durationSeconds)}</div>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            ) : null}

            {compareView === "board" && analysisMode === "targeted" ? (
              <div className="mt-5 grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
                {boardGroups.map((group) => (
                  <Card key={group.state} className="min-w-0 overflow-hidden border-[var(--line)] bg-[var(--surface-1)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Badge className={complianceToneClass(group.state)}>{group.label}</Badge>
                        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{group.description}</p>
                      </div>
                      <div className="text-2xl font-semibold tabular-nums text-[var(--ink)]">{numberFormatter.format(group.jobs.length)}</div>
                    </div>
                    {group.jobs.length ? (
                      <div className="mt-4 space-y-3">
                        {group.jobs.map((job) => {
                          const compliance = getComplianceSummary(job.result);
                          const isSelected = selectedJobId === job.id;
                          return (
                            <div
                              key={job.id}
                              className={cn(
                                "tp-selected-row overflow-hidden rounded-[20px] border p-4 [content-visibility:auto] [contain-intrinsic-size:260px]",
                                isSelected ? "border-[color:var(--accent)]/35 bg-[color:var(--accent-soft)]" : "border-[var(--line)] bg-[var(--surface-0)]",
                              )}
                              data-selected={isSelected}
                              aria-current={isSelected ? "true" : undefined}
                            >
                              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="break-words text-sm font-semibold text-[var(--ink)]">{job.fileName}</div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : null}
                                    <Badge className="max-w-full break-words border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">{job.result.metadata.decoderLabel}</Badge>
                                  </div>
                                </div>
                                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`} className="shrink-0">Inspect</Button>
                              </div>
                              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                <CompareMetricTile label="Integrated" value={formatLufs(job.result.metrics.integratedLufs)} accent />
                                <CompareMetricTile label="True peak" value={formatPeakDbtp(job.result.metrics.truePeakDbtp)} />
                                <CompareMetricTile label="Gain" value={formatRelativeDb(job.result.metrics.targetDeltaDb)} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : <div className="mt-4 rounded-[18px] border border-dashed border-[var(--line)] bg-[var(--surface-0)] px-4 py-5 text-sm leading-6 text-[var(--muted)]">No files land in this state for the current filter.</div>}
                  </Card>
                ))}
              </div>
            ) : null}

            {compareView === "reference" ? (
              referenceJob ? (
                <div className="mt-5 grid gap-4 xl:grid-cols-2">
                  {sortedJobs.map((job) => {
                    const compliance = getComplianceSummary(job.result);
                    const integratedDelta = job.result.metrics.integratedLufs - referenceJob.result.metrics.integratedLufs;
                    const truePeakDelta = job.result.metrics.truePeakDbtp - referenceJob.result.metrics.truePeakDbtp;
                    const lraDelta = job.result.metrics.loudnessRange - referenceJob.result.metrics.loudnessRange;
                    const gainDelta = job.result.metrics.targetDeltaDb == null || referenceJob.result.metrics.targetDeltaDb == null ? null : job.result.metrics.targetDeltaDb - referenceJob.result.metrics.targetDeltaDb;
                    const isReference = job.id === referenceJob.id;
                    return (
                      <Card
                        key={job.id}
                        className={cn(
                          "tp-selected-row overflow-hidden border-[var(--line)] p-5 [content-visibility:auto] [contain-intrinsic-size:300px]",
                          isReference ? "bg-[color:var(--accent-soft)] shadow-[var(--shadow-elevated)]" : "bg-[var(--surface-1)]",
                        )}
                        data-selected={isReference}
                        aria-current={isReference ? "true" : undefined}
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              {isReference ? <Badge>Reference</Badge> : null}
                              {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : <Badge>Measure Only</Badge>}
                            </div>
                            <h3 className="mt-3 break-words text-xl font-semibold text-[var(--ink)]">{job.fileName}</h3>
                            <p className="mt-2 break-words text-sm leading-6 text-[var(--muted)]">Compare this file against {referenceJob.fileName} before making batch-wide decisions.</p>
                          </div>
                          <Button type="button" size="sm" variant="secondary" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`} className="shrink-0">Inspect</Button>
                        </div>
                        <div className={cn("mt-5 grid gap-3", analysisMode === "targeted" ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
                          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3"><div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Integrated delta</div><div className={cn("mt-2 text-lg font-semibold tabular-nums", deltaToneClass(integratedDelta))}>{formatRelativeLu(integratedDelta)}</div></div>
                          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3"><div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">True peak delta</div><div className={cn("mt-2 text-lg font-semibold tabular-nums", deltaToneClass(truePeakDelta))}>{formatRelativeDb(truePeakDelta)}</div></div>
                          <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3"><div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">LRA delta</div><div className={cn("mt-2 text-lg font-semibold tabular-nums", deltaToneClass(lraDelta))}>{formatRelativeLu(lraDelta)}</div></div>
                          {analysisMode === "targeted" ? <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3"><div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Gain delta</div><div className={cn("mt-2 text-lg font-semibold tabular-nums", deltaToneClass(gainDelta))}>{formatRelativeDb(gainDelta)}</div></div> : null}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-5 rounded-[22px] border border-dashed border-[var(--line)] bg-[var(--surface-1)] p-6 text-sm leading-6 text-[var(--muted)]">
                  <div>No reference is selected. Choose any completed file when you want delta cards to appear.</div>
                  {quickReferenceActions.length ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {quickReferenceActions.map((action) => (
                        <Button
                          key={action.job.id}
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => onReferenceIdChange(action.job.id)}
                          aria-label={`${action.label}: ${action.job.fileName}`}
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            ) : null}

            {compareView === "table" ? (
              <>
              <div className="mt-5 grid gap-3 md:hidden">
                {sortedJobs.map((job) => {
                  const compliance = getComplianceSummary(job.result);
                  const referenceDelta = referenceJob ? job.result.metrics.integratedLufs - referenceJob.result.metrics.integratedLufs : null;
                  const isSelected = selectedJobId === job.id;
                  return (
                    <article
                      key={job.id}
                      className={cn(
                        "tp-selected-row rounded-[22px] border p-4 text-[var(--ink)] [content-visibility:auto] [contain-intrinsic-size:280px]",
                        isSelected ? "border-[color:var(--accent)]/40 bg-[color:var(--accent-soft)]" : "border-[var(--line)] bg-[var(--surface-1)]",
                      )}
                      data-selected={isSelected}
                      aria-current={isSelected ? "true" : undefined}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : <Badge>Measure Only</Badge>}
                        {job.result.metrics.normalizationLimited ? <Badge className="tone-warning">Ceiling-limited</Badge> : null}
                      </div>
                      <h3 className="mt-3 break-words text-lg font-semibold">{job.fileName}</h3>
                      <div className="mt-4 grid grid-cols-2 gap-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Integrated</div>
                          <div className="mt-1 font-semibold tabular-nums">{formatLufs(job.result.metrics.integratedLufs)}</div>
                        </div>
                        {referenceJob ? (
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Vs ref</div>
                            <div className={cn("mt-1 font-semibold tabular-nums", deltaToneClass(referenceDelta))}>{formatRelativeLu(referenceDelta)}</div>
                          </div>
                        ) : null}
                        {analysisMode === "targeted" ? (
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Gain</div>
                            <div className="mt-1 font-semibold tabular-nums">{formatRelativeDb(job.result.metrics.targetDeltaDb)}</div>
                          </div>
                        ) : null}
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">True peak</div>
                          <div className="mt-1 font-semibold tabular-nums">{formatPeakDbtp(job.result.metrics.truePeakDbtp)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">LRA</div>
                          <div className="mt-1 font-semibold tabular-nums">{formatDb(job.result.metrics.loudnessRange, "LU")}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Duration</div>
                          <div className="mt-1 font-semibold tabular-nums">{formatDuration(job.result.metadata.durationSeconds)}</div>
                        </div>
                      </div>
                      <div className="mt-4 border-t border-[var(--line)]/70 pt-4">
                        <Button type="button" size="sm" variant="secondary" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>Inspect</Button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="mt-5 hidden overflow-x-auto md:block">
                <table className="w-full min-w-[640px] border-separate border-spacing-y-3 text-sm lg:min-w-[760px] xl:min-w-[860px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                      <th scope="col" className="sticky top-0 bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur">File</th>
                      <th scope="col" className="sticky top-0 bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur">Integrated</th>
                      {referenceJob ? <th scope="col" className="sticky top-0 bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur">Vs ref</th> : null}
                      {analysisMode === "targeted" ? <th scope="col" className="sticky top-0 bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur">Gain</th> : null}
                      <th scope="col" className="sticky top-0 bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur">True peak</th>
                      <th scope="col" className="sticky top-0 hidden bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur md:table-cell">LRA</th>
                      <th scope="col" className="sticky top-0 hidden bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur xl:table-cell">Duration</th>
                      <th scope="col" className="sticky top-0 hidden bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur 2xl:table-cell">Decoder</th>
                      <th scope="col" className="sticky top-0 bg-[var(--surface-0)]/95 px-4 py-2 backdrop-blur">Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedJobs.map((job) => {
                      const compliance = getComplianceSummary(job.result);
                      const referenceDelta = referenceJob ? job.result.metrics.integratedLufs - referenceJob.result.metrics.integratedLufs : null;
                      const isSelected = selectedJobId === job.id;
                      return (
                        <tr
                          key={job.id}
                          className={cn("text-[var(--ink)]", isSelected ? "[&>td]:border-[color:var(--accent)]/40 [&>td]:bg-[color:var(--accent-soft)]" : "")}
                          aria-current={isSelected ? "true" : undefined}
                        >
                          <td className="rounded-l-[20px] border border-r-0 border-[var(--line)] px-4 py-4"><div className="break-words font-semibold">{job.fileName}</div><div className="mt-2 flex flex-wrap gap-2">{compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : <Badge>Measure Only</Badge>}{job.result.metrics.normalizationLimited ? <Badge className="tone-warning">Ceiling-limited</Badge> : null}</div></td>
                          <td className="border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 tabular-nums">{formatLufs(job.result.metrics.integratedLufs)}</td>
                          {referenceJob ? <td className={cn("border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 font-semibold tabular-nums", deltaToneClass(referenceDelta))}>{formatRelativeLu(referenceDelta)}</td> : null}
                          {analysisMode === "targeted" ? <td className="border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 tabular-nums">{formatRelativeDb(job.result.metrics.targetDeltaDb)}</td> : null}
                          <td className="border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 tabular-nums">{formatPeakDbtp(job.result.metrics.truePeakDbtp)}</td>
                          <td className="hidden border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 tabular-nums md:table-cell">{formatDb(job.result.metrics.loudnessRange, "LU")}</td>
                          <td className="hidden border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 tabular-nums xl:table-cell">{formatDuration(job.result.metadata.durationSeconds)}</td>
                          <td className="hidden break-words border border-l-0 border-r-0 border-[var(--line)] px-4 py-4 2xl:table-cell">{job.result.metadata.decoderLabel}</td>
                          <td className="rounded-r-[20px] border border-l-0 border-[var(--line)] px-4 py-4"><Button type="button" size="sm" variant="ghost" onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>Inspect</Button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            ) : null}
          </>
        ) : (
          <div className="mt-5 rounded-[22px] border border-dashed border-[var(--line)] bg-[var(--surface-1)] p-6 text-sm leading-6 text-[var(--muted)]">
            <div>Nothing matches the current filter. Try a different filter or finish more files.</div>
            {analysisMode === "targeted" && compareFilter !== "all" ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => onCompareFilterChange("all")} className="mt-4">
                <AudioLines className="h-4 w-4" aria-hidden="true" />
                Show All Files
              </Button>
            ) : null}
          </div>
        )}
      </Card>
    </section>
  );
}
