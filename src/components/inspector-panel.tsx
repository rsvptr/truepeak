"use client";

import { useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { BarChart3, CircleAlert, LoaderCircle, RefreshCcw, Square } from "lucide-react";
import { getComplianceSummary } from "@/audio/compliance";
import { formatDb, formatDuration, formatLufs, formatPeakDbtp, formatRelativeDb, formatRelativeLu, formatTimestamp } from "@/lib/format";
import { getJobErrorDisplay } from "@/lib/job-ui";
import { complianceToneClass, statusToneClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import type { AnalysisJob, AnalysisMode, SourceFormat } from "@/types/audio";
import { TimelineChart } from "@/components/timeline-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export type InspectorDetailTab = "overview" | "timeline" | "metadata";

const DETAIL_TABS: Array<{ id: InspectorDetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "metadata", label: "Technical" },
];

function isActive(job: AnalysisJob) {
  return ["queued", "reading", "decoding", "analyzing"].includes(job.status);
}

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
  density = "default",
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
  density?: "default" | "rail";
}) {
  const compact = density === "rail";

  return (
    <div
      className={cn(
        "min-w-0 rounded-[20px] border",
        compact ? "px-3 py-3" : "px-4 py-4",
        accent
          ? "border-[color:var(--accent)]/18 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)]/80 bg-[var(--surface-1)]",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className={cn("mt-2 break-words font-semibold text-[var(--ink)] tabular-nums", compact ? "text-base" : "text-xl")}>{value}</div>
      <p className={cn("mt-2 break-words leading-5 text-[var(--muted)]", compact ? "text-[11px]" : "text-xs")}>{hint}</p>
    </div>
  );
}

function MetadataRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-[16px] border border-[var(--line)]/70 bg-[var(--surface-0)]/54 px-3 py-3">
      <dt className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold leading-6 text-[var(--ink)]">{value}</dd>
      {hint ? <dd className="mt-1 break-words text-xs leading-5 text-[var(--muted)]">{hint}</dd> : null}
    </div>
  );
}

interface InspectorPanelProps {
  job: AnalysisJob;
  analysisMode: AnalysisMode;
  detailTab: InspectorDetailTab;
  density?: "default" | "rail";
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
  density = "default",
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
  const selectedCompliance = result ? getComplianceSummary(result) : null;
  const selectedNotes = result
    ? Array.from(new Set([...result.metadata.decodeNotes, ...result.metadata.warnings, ...result.metrics.warnings]))
    : [];
  const errorDisplay = getJobErrorDisplay(job.error);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const compact = density === "rail";

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
    <Card className={cn(compact ? "p-4 shadow-none" : "p-5 sm:p-6")}>
      <div className={cn("flex flex-col border-b border-[var(--line)]/80", compact ? "gap-3 pb-4" : "gap-4 pb-5")}>
        <div className={cn("flex flex-col gap-4", compact ? "" : "xl:flex-row xl:items-start xl:justify-between")}>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">File details</div>
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={headingTabIndex}
              className={cn(
                "mt-2 break-words font-semibold leading-tight text-[var(--ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                compact ? "text-xl" : "text-2xl",
              )}
            >
              {job.fileName}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge className={statusToneClass(job.status)}>{job.status}</Badge>
              {selectedCompliance ? <Badge className={complianceToneClass(selectedCompliance.state)}>{selectedCompliance.label}</Badge> : null}
              {selectedTarget ? <Badge>{selectedTarget.label}</Badge> : null}
              {result?.metadata.decoderLabel ? (
                <Badge className="max-w-full break-words border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                  {result.metadata.decoderLabel}
                </Badge>
              ) : null}
              {!selectedCompliance && result ? (
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
            {(job.status === "failed" || job.status === "canceled") ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
                <RefreshCcw className="h-4 w-4" />
                Retry
              </Button>
            ) : null}
            {isActive(job) ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
                <Square className="h-4 w-4" />
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        {result ? (
          <div className={cn("grid gap-3", compact ? "grid-cols-2" : analysisMode === "targeted" ? "md:grid-cols-2 2xl:grid-cols-3" : "md:grid-cols-2 xl:grid-cols-3")}>
            <InspectorMetric density={density} label="Integrated" value={formatLufs(result.metrics.integratedLufs)} hint={selectedTarget?.label ?? "Measured loudness"} accent />
            <InspectorMetric density={density} label="True peak" value={formatPeakDbtp(result.metrics.truePeakDbtp)} hint="Measured true peak" />
            <InspectorMetric density={density} label="LRA" value={formatDb(result.metrics.loudnessRange, "LU")} hint="Loudness range" />
            {analysisMode === "targeted" ? (
              <>
                <InspectorMetric density={density} label="Gain move" value={formatRelativeDb(result.metrics.targetDeltaDb)} hint={result.metrics.normalizationLimited ? "Limited by ceiling" : "Planned normalization move"} />
                <InspectorMetric density={density} label="Projected TP" value={formatPeakDbtp(result.metrics.projectedTruePeakDbtp)} hint="After planned normalization" />
              </>
            ) : (
              <>
                <InspectorMetric density={density} label="Ungated" value={formatLufs(result.metrics.ungatedLufs)} hint="Reference before gating" />
                <InspectorMetric density={density} label="Sample peak" value={formatDb(result.metrics.samplePeakDbfs, "dBFS")} hint="Highest sample peak" />
              </>
            )}
            <InspectorMetric density={density} label="Duration" value={formatDuration(result.metadata.durationSeconds)} hint={result.metadata.channelLayout.name} />
          </div>
        ) : null}
      </div>

      <div className={cn("flex flex-wrap gap-2 border-b border-[var(--line)]/80", compact ? "mt-4 pb-4" : "mt-5 pb-5")} role="tablist" aria-label="File detail sections">
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
            {isActive(job) ? (
              <LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent)]" />
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
              <InspectorMetric density={density} label="Integrated" value={formatLufs(result.metrics.integratedLufs)} hint="Primary LUFS reading" accent />
              <InspectorMetric density={density} label="Ungated" value={formatLufs(result.metrics.ungatedLufs)} hint="Before gating" />
              <InspectorMetric density={density} label="Max momentary" value={formatLufs(result.metrics.maxMomentaryLufs)} hint="400 ms window" />
              <InspectorMetric density={density} label="Max short-term" value={formatLufs(result.metrics.maxShortTermLufs)} hint="3 second window" />
            </div>
          </section>

          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Peaks and dynamics</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InspectorMetric density={density} label="True peak" value={formatPeakDbtp(result.metrics.truePeakDbtp)} hint="Measured true peak" accent />
              <InspectorMetric density={density} label="Sample peak" value={formatDb(result.metrics.samplePeakDbfs, "dBFS")} hint="Highest sample peak" />
              <InspectorMetric density={density} label="LRA" value={formatDb(result.metrics.loudnessRange, "LU")} hint="Loudness range" />
              <InspectorMetric density={density} label="Timeline points" value={String(result.metrics.timeline.timeSeconds.length)} hint="Momentary, short-term, and peak samples" />
            </div>
          </section>

          {analysisMode === "targeted" && selectedTarget ? (
            <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Normalization and delivery</div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <InspectorMetric density={density} label="Requested move" value={formatRelativeDb(result.metrics.unclampedTargetDeltaDb)} hint="Needed before ceiling protection" />
                <InspectorMetric density={density} label="Applied move" value={formatRelativeDb(result.metrics.targetDeltaDb)} hint={result.metrics.normalizationLimited ? "Capped to protect projected true peak" : "Move toward target"} accent={result.metrics.normalizationLimited} />
                <InspectorMetric density={density} label="Projected TP" value={formatPeakDbtp(result.metrics.projectedTruePeakDbtp)} hint="After planned normalization" />
                <InspectorMetric density={density} label="Policy" value={selectedTarget.policy === "protect-true-peak" ? "Protect ceiling" : "Hit target"} hint="Current normalization strategy" />
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
              <InspectorMetric density={density} label="Decoder" value={result.metadata.decoderLabel} hint={result.metadata.decoderSummary} accent />
              <InspectorMetric density={density} label="Source" value={formatSourceFormatLabel(result.metadata.sourceFormat)} hint={result.metadata.mimeType || "Audio source"} />
              <InspectorMetric density={density} label="Sample rate" value={`${result.metadata.sampleRate.toLocaleString("en-GB")} Hz`} hint="Parsed sample rate" />
              <InspectorMetric density={density} label="Channels" value={String(result.metadata.channelCount)} hint={result.metadata.channelLayout.name} />
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
              <TimelineChart timeline={result.metrics.timeline} density={compact ? "compact" : "default"} />
            </div>
          </section>
          <div className="grid gap-3 md:grid-cols-3">
            <InspectorMetric density={density} label="Timeline step" value={`${result.metrics.timeline.stepDurationSeconds.toFixed(1)} s`} hint="Sampling interval for plotted values" />
            <InspectorMetric density={density} label="Timeline points" value={String(result.metrics.timeline.timeSeconds.length)} hint="Momentary, short-term, and peak samples" />
            <InspectorMetric density={density} label="Analysis time" value={formatTimestamp(result.analyzedAt)} hint="When this result was produced" />
          </div>
        </div>
      ) : null}

      {result && detailTab === "metadata" ? (
        compact ? (
          <div id="inspector-panel-metadata" role="tabpanel" aria-labelledby="inspector-tab-metadata" className="mt-5 space-y-4">
            <section className="rounded-[18px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Technical metadata</div>
              <dl className="mt-4 grid gap-2">
                <MetadataRow label="Sample rate" value={`${result.metadata.sampleRate.toLocaleString("en-GB")} Hz`} hint="Source sample rate" />
                <MetadataRow label="Bit depth" value={`${result.metadata.bitDepth}-bit`} hint="Parsed container depth" />
                <MetadataRow label="Channels" value={String(result.metadata.channelCount)} hint={result.metadata.channelLayout.name} />
                <MetadataRow label="Layout confidence" value={result.metadata.channelLayout.guessed ? "Guessed" : "Explicit"} hint={result.metadata.channelLayout.labels.join(" / ")} />
                <MetadataRow label="Frame count" value={result.metadata.frameCount.toLocaleString("en-GB")} hint="Decoded sample frames" />
                <MetadataRow label="Duration" value={formatDuration(result.metadata.durationSeconds)} hint="Source duration" />
              </dl>
            </section>

            <section className="rounded-[18px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Container and decode path</div>
              <dl className="mt-4 grid gap-2">
                <MetadataRow label="Container" value={formatSourceFormatLabel(result.metadata.sourceFormat)} hint={result.metadata.mimeType || "Audio source"} />
                <MetadataRow label="Decoder mode" value={result.metadata.decoderMode} />
                <MetadataRow label="Decoder summary" value={result.metadata.decoderLabel} hint={result.metadata.decoderSummary} />
                <MetadataRow label="Policy" value={selectedTarget ? (selectedTarget.policy === "protect-true-peak" ? "Protect ceiling" : "Hit target") : "Measure Only"} />
              </dl>
            </section>
          </div>
        ) : (
        <div id="inspector-panel-metadata" role="tabpanel" aria-labelledby="inspector-tab-metadata" className="mt-5 grid gap-4 xl:grid-cols-2">
          <section className="rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Technical metadata</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <InspectorMetric density={density} label="Sample rate" value={`${result.metadata.sampleRate.toLocaleString("en-GB")} Hz`} hint="Source sample rate" accent />
              <InspectorMetric density={density} label="Bit depth" value={`${result.metadata.bitDepth}-bit`} hint="Parsed container depth" />
              <InspectorMetric density={density} label="Channels" value={String(result.metadata.channelCount)} hint={result.metadata.channelLayout.name} />
              <InspectorMetric density={density} label="Layout confidence" value={result.metadata.channelLayout.guessed ? "Guessed" : "Explicit"} hint={result.metadata.channelLayout.labels.join(" / ")} />
              <InspectorMetric density={density} label="Frame count" value={result.metadata.frameCount.toLocaleString("en-GB")} hint="Decoded sample frames" />
              <InspectorMetric density={density} label="Duration" value={formatDuration(result.metadata.durationSeconds)} hint="Source duration" />
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
        )
      ) : null}
    </Card>
  );
}







