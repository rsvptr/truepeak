"use client";

import { useRef, type KeyboardEvent, type Ref } from "react";
import dynamic from "next/dynamic";
import { BarChart3, CircleAlert, LoaderCircle, RefreshCcw, Square } from "lucide-react";
import { getComplianceSummary } from "@/audio/compliance";
import { describeIntegratedInvalidReason, formatDb, formatDuration, formatIntegratedLufs, formatLoudnessRange, formatLufs, formatPeakDbtp, formatRelativeDb, formatRelativeLu, formatTimestamp } from "@/lib/format";
import { getJobErrorDisplay } from "@/lib/job-ui";
import { complianceToneClass, statusToneClass } from "@/lib/status-tone";
import { isActiveJob, isIssueJob } from "@/lib/session-selectors";
import { cn } from "@/lib/utils";
import type { AnalysisJob, AnalysisMode, SourceFormat } from "@/types/audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

// uPlot and the chart wiring only matter once someone opens the Timeline tab
// of a completed result, so keep them out of the initial bundle. The
// placeholder mirrors the chart layout to avoid a layout shift.
const TimelineChart = dynamic(
  () => import("@/components/timeline-chart").then((module) => module.TimelineChart),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3" aria-hidden="true">
        <div className="h-7" />
        <div className="min-h-[250px] w-full animate-pulse rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)]" />
        <div className="min-h-[220px] w-full animate-pulse rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)]" />
      </div>
    ),
  },
);

export type InspectorDetailTab = "overview" | "timeline" | "metadata";

const DETAIL_TABS: Array<{ id: InspectorDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "metadata", label: "Technical" },
];

function formatSourceFormatLabel(sourceFormat: SourceFormat) {
  switch (sourceFormat) {
    case "wav":
      return "WAV";
    case "rf64":
      return "RF64";
    case "aiff":
      return "AIFF";
    case "aifc":
      return "AIFC";
    case "ffmpeg-wav":
      return "FFmpeg WAV";
    case "browser-decoded":
    default:
      return "Browser decode";
  }
}

function InspectorMetric({
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
      className={cn(
        "min-w-0 rounded-[20px] border px-4 py-4",
        accent
          ? "border-[color:var(--accent)]/18 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)]/80 bg-[var(--surface-1)]",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 break-words text-xl font-semibold text-[var(--ink)] tabular-nums">{value}</div>
      <p className="mt-2 break-words text-xs leading-5 text-[var(--muted)]">{hint}</p>
    </div>
  );
}

interface InspectorPanelProps {
  job: AnalysisJob;
  analysisMode: AnalysisMode;
  detailTab: InspectorDetailTab;
  headingId?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  headingTabIndex?: number;
  completedCount: number;
  onDetailTabChange: (tab: InspectorDetailTab) => void;
  onOpenCompare?: () => void;
  onRetryJob: (jobId: string) => void;
  onCancelJob: (jobId: string) => void;
}

export function InspectorPanel({
  job,
  analysisMode,
  detailTab,
  headingId,
  headingRef,
  headingTabIndex,
  completedCount,
  onDetailTabChange,
  onOpenCompare,
  onRetryJob,
  onCancelJob,
}: InspectorPanelProps) {
  const result = job.result ?? null;
  const selectedTarget = result?.target ?? null;
  const processingSeconds =
    job.status === "complete" && job.startedAtMs != null && job.finishedAtMs != null
      ? Math.max(0, (job.finishedAtMs - job.startedAtMs) / 1000)
      : null;
  const processingLabel =
    processingSeconds == null
      ? null
      : processingSeconds < 10
        ? `${processingSeconds.toFixed(1)} s`
        : `${Math.round(processingSeconds)} s`;
  const selectedCompliance = result ? getComplianceSummary(result) : null;
  const selectedNotes = result
    ? Array.from(new Set([...result.metadata.decodeNotes, ...result.metadata.warnings, ...result.metrics.warnings]))
    : [];
  const errorDisplay = getJobErrorDisplay(job.error);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleDetailTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const lastIndex = DETAIL_TABS.length - 1;
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = index >= lastIndex ? 0 : index + 1;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = index <= 0 ? lastIndex : index - 1;
    }

    if (event.key === "Home") {
      nextIndex = 0;
    }

    if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex == null) {
      return;
    }

    event.preventDefault();
    tabRefs.current[nextIndex]?.focus();
    onDetailTabChange(DETAIL_TABS[nextIndex].id);
  };

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col gap-4 border-b border-[var(--line)]/80 pb-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">File details</div>
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={headingTabIndex}
              className="mt-2 break-words text-2xl font-semibold leading-tight text-[var(--ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {job.fileName}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge className={statusToneClass(job.status)}>{job.status}</Badge>
              {job.imported ? (
                <Badge className="tone-warning">Unverified import</Badge>
              ) : null}
              {job.restored ? (
                <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                  Restored
                </Badge>
              ) : null}
              {selectedCompliance ? <Badge className={complianceToneClass(selectedCompliance.state)}>{selectedCompliance.label}</Badge> : null}
              {result?.metrics.integratedValid === false ? <Badge className="tone-warning">Integrated unavailable</Badge> : null}
              {selectedTarget ? <Badge>{selectedTarget.label}</Badge> : null}
              {result?.metadata.decoderLabel ? (
                <Badge className="max-w-full break-words border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                  {result.metadata.decoderLabel}
                </Badge>
              ) : null}
              {!selectedCompliance && result && analysisMode === "measure-only" ? (
                <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">Measure Only</Badge>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {result && completedCount > 1 && onOpenCompare ? (
              <Button type="button" size="sm" variant="secondary" onClick={onOpenCompare}>
                <BarChart3 className="h-4 w-4" />
                Compare
              </Button>
            ) : null}
            {isIssueJob(job) ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
                <RefreshCcw className="h-4 w-4" />
                Retry
              </Button>
            ) : null}
            {isActiveJob(job) ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
                <Square className="h-4 w-4" />
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        {result ? (
          <div className={cn("grid gap-3", analysisMode === "targeted" ? "md:grid-cols-2 2xl:grid-cols-3" : "md:grid-cols-2 xl:grid-cols-3")}>
            <InspectorMetric label="Integrated" value={formatIntegratedLufs(result.metrics)} hint={result.metrics.integratedValid === false ? describeIntegratedInvalidReason(result.metrics.integratedInvalidReason) : selectedTarget?.label ?? "Measured loudness"} accent />
            <InspectorMetric label="True peak" value={formatPeakDbtp(result.metrics.truePeakDbtp)} hint="Measured true peak" />
            <InspectorMetric label="LRA" value={formatLoudnessRange(result.metrics)} hint={result.metrics.loudnessRangeUnstable === true ? "Programme is under 60 seconds; LRA is not statistically stable" : "Loudness range"} />
            {analysisMode === "targeted" ? (
              <>
                <InspectorMetric label="Gain move" value={formatRelativeDb(result.metrics.targetDeltaDb)} hint={result.metrics.normalizationLimited ? "Limited by ceiling" : "Planned normalization move"} />
                <InspectorMetric label="Projected TP" value={formatPeakDbtp(result.metrics.projectedTruePeakDbtp)} hint="After planned normalization" />
              </>
            ) : (
              <>
                <InspectorMetric label="Ungated" value={formatLufs(result.metrics.ungatedLufs)} hint="Reference before gating" />
                <InspectorMetric label="Sample peak" value={formatDb(result.metrics.samplePeakDbfs, "dBFS")} hint="Highest sample peak" />
              </>
            )}
            <InspectorMetric label="Duration" value={formatDuration(result.metadata.durationSeconds)} hint={result.metadata.channelLayout.name} />
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-b border-[var(--line)]/80 pb-5" role="tablist" aria-label="File detail sections">
        {DETAIL_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            onClick={() => onDetailTabChange(tab.id)}
            onKeyDown={(event) => handleDetailTabKeyDown(event, index)}
            role="tab"
            aria-selected={detailTab === tab.id}
            aria-controls={`inspector-panel-${tab.id}`}
            id={`inspector-tab-${tab.id}`}
            tabIndex={detailTab === tab.id ? 0 : -1}
            className={cn(
              "rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              detailTab === tab.id
                ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[var(--ink)]"
                : "border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)] hover:border-[color:var(--accent)]/30",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!result ? (
        <div className="mt-5 rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)] p-5">
          <div className="flex items-center gap-3 text-[var(--muted)]">
            {isActiveJob(job) ? (
              // Spin a wrapper element, not the SVG itself: transforms on SVG
              // elements are not hardware accelerated in several browsers.
              <span className="inline-flex animate-spin">
                <LoaderCircle className="h-5 w-5 text-[var(--accent)]" />
              </span>
            ) : (
              <CircleAlert className="h-5 w-5 text-[var(--accent)]" />
            )}
            <div className="text-[11px] uppercase tracking-[0.18em]">Status</div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
            <span>{job.progressLabel}</span>
            <span>{Math.round(job.progressPercent * 100)}%</span>
          </div>
          <div className="mt-3">
            <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
          </div>
          <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
            {errorDisplay?.summary ?? "Results, charts, and file details will appear here as soon as analysis finishes."}
          </p>
          {errorDisplay?.detail ? (
            <details className="mt-3 rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
              <summary className="cursor-pointer font-semibold text-[var(--ink)]">Failure details</summary>
              <p className="mt-3">{errorDisplay.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      {result && detailTab === "overview" ? (
        <div id="inspector-panel-overview" role="tabpanel" aria-labelledby="inspector-tab-overview" className="mt-5 space-y-4">
          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Loudness</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InspectorMetric label="Integrated" value={formatIntegratedLufs(result.metrics)} hint={result.metrics.integratedValid === false ? describeIntegratedInvalidReason(result.metrics.integratedInvalidReason) : "Primary LUFS reading"} accent />
              <InspectorMetric label="Ungated" value={formatLufs(result.metrics.ungatedLufs)} hint="Before gating" />
              <InspectorMetric label="Max momentary" value={formatLufs(result.metrics.maxMomentaryLufs)} hint="400 ms window" />
              <InspectorMetric label="Max short-term" value={formatLufs(result.metrics.maxShortTermLufs)} hint="3 second window" />
            </div>
          </section>

          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Peaks and dynamics</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InspectorMetric label="True peak" value={formatPeakDbtp(result.metrics.truePeakDbtp)} hint="Measured true peak" accent />
              <InspectorMetric label="Sample peak" value={formatDb(result.metrics.samplePeakDbfs, "dBFS")} hint="Highest sample peak" />
              <InspectorMetric label="LRA" value={formatLoudnessRange(result.metrics)} hint={result.metrics.loudnessRangeUnstable === true ? "Programme is under 60 seconds; LRA is not statistically stable" : "Loudness range"} />
              <InspectorMetric label="Timeline points" value={String(result.metrics.timeline.timeSeconds.length)} hint="Momentary, short-term, and peak samples" />
            </div>
          </section>

          {analysisMode === "targeted" && selectedTarget ? (
            <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Normalization and delivery</div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <InspectorMetric label="Requested move" value={formatRelativeDb(result.metrics.unclampedTargetDeltaDb)} hint="Needed before ceiling protection" />
                <InspectorMetric label="Applied move" value={formatRelativeDb(result.metrics.targetDeltaDb)} hint={result.metrics.normalizationLimited ? "Capped to protect projected true peak" : "Move toward target"} accent={result.metrics.normalizationLimited} />
                <InspectorMetric label="Projected TP" value={formatPeakDbtp(result.metrics.projectedTruePeakDbtp)} hint="After planned normalization" />
                <InspectorMetric label="Policy" value={selectedTarget.policy === "protect-true-peak" ? "Protect ceiling" : "Hit target"} hint="Current normalization strategy" />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">Target {formatLufs(selectedTarget.loudnessTargetLufs)}</Badge>
                <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">Ceiling {formatPeakDbtp(selectedTarget.truePeakCeilingDbtp)}</Badge>
                {selectedCompliance ? (
                  <Badge className={complianceToneClass(selectedCompliance.state)}>
                    Delta {formatRelativeLu(selectedCompliance.deltaFromTargetLufs)}
                  </Badge>
                ) : null}
              </div>
            </section>
          ) : (
            <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5 text-sm leading-6 text-[var(--muted)]">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">No target active</div>
              <p className="mt-3">
                These numbers are the measured source values. No gain move or compliance label is being applied.
              </p>
            </section>
          )}

          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Technical details</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InspectorMetric label="Decoder" value={result.metadata.decoderLabel} hint={result.metadata.decoderSummary} accent />
              <InspectorMetric label="Source" value={formatSourceFormatLabel(result.metadata.sourceFormat)} hint={result.metadata.mimeType || "Audio source"} />
              <InspectorMetric label="Sample rate" value={`${result.metadata.sampleRate.toLocaleString("en-GB")} Hz`} hint="Parsed sample rate" />
              <InspectorMetric label="Channels" value={String(result.metadata.channelCount)} hint={result.metadata.channelLayout.name} />
            </div>
          </section>

          {selectedNotes.length ? (
            <section className="rounded-[24px] border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/12 p-5">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--warning)]">
                <CircleAlert className="h-4 w-4" />
                Notes and warnings
              </div>
              <div className="mt-4 space-y-2 text-sm leading-6 text-[var(--ink)]/85">
                {selectedNotes.map((note) => (
                  <div key={note} className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-2)]/60 px-4 py-3">
                    {note}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {result && detailTab === "timeline" ? (
        <div id="inspector-panel-timeline" role="tabpanel" aria-labelledby="inspector-tab-timeline" className="mt-5 space-y-4">
          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Timeline review</div>
            <div className="mt-4">
              <TimelineChart timeline={result.metrics.timeline} />
            </div>
          </section>
          <div className="grid gap-3 md:grid-cols-3">
            <InspectorMetric label="Timeline step" value={`${result.metrics.timeline.stepDurationSeconds.toFixed(1)} s`} hint="Sampling interval for plotted values" />
            <InspectorMetric label="Timeline points" value={String(result.metrics.timeline.timeSeconds.length)} hint="Momentary, short-term, and peak samples" />
            <InspectorMetric label="Analysis time" value={formatTimestamp(result.analyzedAt)} hint="When this result was produced" />
          </div>
        </div>
      ) : null}

      {result && detailTab === "metadata" ? (
        <div id="inspector-panel-metadata" role="tabpanel" aria-labelledby="inspector-tab-metadata" className="mt-5 grid gap-4 xl:grid-cols-2">
          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Technical metadata</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InspectorMetric label="Sample rate" value={`${result.metadata.sampleRate.toLocaleString("en-GB")} Hz`} hint="Source sample rate" accent />
              <InspectorMetric label="Bit depth" value={`${result.metadata.bitDepth}-bit`} hint="Parsed container depth" />
              <InspectorMetric label="Channels" value={String(result.metadata.channelCount)} hint={result.metadata.channelLayout.name} />
              <InspectorMetric label="Layout confidence" value={result.metadata.channelLayout.guessed ? "Guessed" : "Explicit"} hint={result.metadata.channelLayout.labels.join(" / ")} />
              <InspectorMetric label="Frame count" value={result.metadata.frameCount.toLocaleString("en-GB")} hint="Decoded sample frames" />
              <InspectorMetric label="Duration" value={formatDuration(result.metadata.durationSeconds)} hint="Source duration" />
              {processingLabel ? <InspectorMetric label="Processing time" value={processingLabel} hint="Read, decode, and analysis for this run" /> : null}
            </div>
          </section>

          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Container and decode path</div>
            <div className="mt-4 space-y-3 break-words text-sm leading-6 text-[var(--muted)]">
              <div className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                <span className="font-semibold text-[var(--ink)]">Container</span>: {formatSourceFormatLabel(result.metadata.sourceFormat)}
              </div>
              <div className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                <span className="font-semibold text-[var(--ink)]">Decoder mode</span>: {result.metadata.decoderMode}
              </div>
              <div className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                <span className="font-semibold text-[var(--ink)]">Decoder summary</span>: {result.metadata.decoderSummary}
              </div>
              <div className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
                <span className="font-semibold text-[var(--ink)]">Policy</span>: {selectedTarget ? (selectedTarget.policy === "protect-true-peak" ? "Protect ceiling" : "Hit target") : "Measure Only"}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </Card>
  );
}







