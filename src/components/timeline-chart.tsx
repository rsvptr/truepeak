"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { ChevronDown, ChevronUp, Download, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { fileNameTimestamp, formatDuration, formatLufs, formatPeakDbtp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import type { AnalysisTimeline } from "@/types/audio";

interface TimelineChartProps {
  timeline: AnalysisTimeline;
}

interface XDomain {
  min: number;
  max: number;
}

// Rows shown in the on-screen data table are downsampled to a readable count;
// the CSV download always covers every sample.
const MAX_TABLE_ROWS = 200;
const ZOOM_IN_FACTOR = 0.6;
const ZOOM_OUT_FACTOR = 1 / 0.6;
const MIN_ZOOM_SPAN_SECONDS = 1;
const ZOOM_EPSILON_SECONDS = 1e-3;

function readThemeToken(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function minMax(values: number[]) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return { min, max };
}

function isRangeZoomed(domain: XDomain, min: number, max: number) {
  return min > domain.min + ZOOM_EPSILON_SECONDS || max < domain.max - ZOOM_EPSILON_SECONDS;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

export function TimelineChart({ timeline }: TimelineChartProps) {
  const loudnessContainerRef = useRef<HTMLDivElement | null>(null);
  const peakContainerRef = useRef<HTMLDivElement | null>(null);
  const loudnessPlotRef = useRef<uPlot | null>(null);
  const peakPlotRef = useRef<uPlot | null>(null);
  const xDomainRef = useRef<XDomain | null>(null);
  // Tracks which `timeline` the charts were last built from, so a
  // theme-toggle-only (or pointer-type-only) re-instantiation can tell it
  // isn't looking at new data and should keep the user's current zoom/pan
  // instead of snapping back to the full range.
  const lastTimelineRef = useRef<AnalysisTimeline | null>(null);

  const summaryId = useId();
  const tableId = useId();

  const [isZoomed, setIsZoomed] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);

  // Drag-to-zoom on a touch screen fights with native scroll panning, so it's
  // disabled for coarse pointers in favour of the explicit zoom buttons
  // below (which remain available to every input type).
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(pointer: coarse)");
    setIsCoarsePointer(query.matches);
    const handleChange = (event: MediaQueryListEvent) => setIsCoarsePointer(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  // uPlot reads its axis/series colours from CSS custom properties once, at
  // creation. Watch the document theme so a light/dark toggle restyles the charts.
  const [themeVersion, setThemeVersion] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") {
      return;
    }
    const observer = new MutationObserver(() => setThemeVersion((version) => version + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const summaryText = useMemo(() => {
    const { timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp, stepDurationSeconds } = timeline;
    const sampleCount = timeSeconds.length;
    const durationSeconds = sampleCount > 0 ? timeSeconds[sampleCount - 1] + stepDurationSeconds : 0;

    const momentaryValues = momentaryLufs.filter((value): value is number => value != null && Number.isFinite(value));
    const shortTermValues = shortTermLufs.filter((value): value is number => value != null && Number.isFinite(value));
    const peakValues = truePeakDbtp.filter((value) => Number.isFinite(value));

    const parts: string[] = [
      `Timeline covers ${formatDuration(durationSeconds)} across ${sampleCount} sample${sampleCount === 1 ? "" : "s"}.`,
    ];

    if (momentaryValues.length > 0) {
      const { min, max } = minMax(momentaryValues);
      parts.push(`Momentary loudness ranges from ${formatLufs(min)} to ${formatLufs(max)}.`);
    }
    if (shortTermValues.length > 0) {
      const { min, max } = minMax(shortTermValues);
      parts.push(`Short-term loudness ranges from ${formatLufs(min)} to ${formatLufs(max)}.`);
    }
    if (peakValues.length > 0) {
      const { max } = minMax(peakValues);
      parts.push(`True peak reaches ${formatPeakDbtp(max)}.`);
    }

    parts.push("Use the data table below for exact per-sample values, or download the full-resolution CSV.");
    return parts.join(" ");
  }, [timeline]);

  const tableRows = useMemo(() => {
    const { timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp } = timeline;
    const total = timeSeconds.length;
    if (total === 0) {
      return [];
    }

    const step = Math.max(1, Math.ceil(total / MAX_TABLE_ROWS));
    const rows: Array<{
      index: number;
      timeSeconds: number;
      momentaryLufs: number | null;
      shortTermLufs: number | null;
      truePeakDbtp: number;
    }> = [];

    for (let index = 0; index < total; index += step) {
      rows.push({
        index,
        timeSeconds: timeSeconds[index],
        momentaryLufs: momentaryLufs[index] ?? null,
        shortTermLufs: shortTermLufs[index] ?? null,
        truePeakDbtp: truePeakDbtp[index],
      });
    }

    const lastIndex = total - 1;
    if (rows[rows.length - 1]?.index !== lastIndex) {
      rows.push({
        index: lastIndex,
        timeSeconds: timeSeconds[lastIndex],
        momentaryLufs: momentaryLufs[lastIndex] ?? null,
        shortTermLufs: shortTermLufs[lastIndex] ?? null,
        truePeakDbtp: truePeakDbtp[lastIndex],
      });
    }

    return rows;
  }, [timeline]);

  const isTableDownsampled = tableRows.length < timeline.timeSeconds.length;

  useEffect(() => {
    const loudnessContainer = loudnessContainerRef.current;
    const peakContainer = peakContainerRef.current;
    if (!loudnessContainer || !peakContainer) {
      return;
    }

    // Only reset the view when the underlying timeline data actually
    // changed (a new file/result). A theme toggle or pointer-type change
    // still destroys and recreates the uPlot instances (they read colours
    // from CSS variables once, at creation), but should restyle the same
    // view rather than silently discarding the user's zoom/pan.
    const timelineChanged = lastTimelineRef.current !== timeline;
    lastTimelineRef.current = timeline;
    const previousPlot = loudnessPlotRef.current;
    const preservedScale =
      !timelineChanged && previousPlot && previousPlot.scales.x.min != null && previousPlot.scales.x.max != null
        ? { min: previousPlot.scales.x.min, max: previousPlot.scales.x.max }
        : null;

    loudnessPlotRef.current?.destroy();
    peakPlotRef.current?.destroy();
    loudnessContainer.innerHTML = "";
    peakContainer.innerHTML = "";

    const x = timeline.timeSeconds;
    const momentary = timeline.momentaryLufs.map((value) =>
      value == null ? null : Number(value.toFixed(2)),
    );
    const shortTerm = timeline.shortTermLufs.map((value) =>
      value == null ? null : Number(value.toFixed(2)),
    );
    const truePeak = timeline.truePeakDbtp.map((value) => Number(value.toFixed(2)));
    const loudnessHeight = 250;
    const peakHeight = 220;
    // Keep the floor low enough for narrow phones (the deepest nesting leaves
    // ~240px of content width at 360px viewports); the container scrolls
    // horizontally if a chart still can't fit.
    const minChartWidth = 240;

    const domain: XDomain = {
      min: x.length > 0 ? x[0] : 0,
      max: x.length > 0 ? x[x.length - 1] : 0,
    };
    xDomainRef.current = domain;
    if (timelineChanged) {
      setIsZoomed(false);
    }

    // Keep both charts' x-axis in lockstep: dragging to zoom on either one
    // (or the explicit Zoom In/Out/Reset controls below) updates the other,
    // and both feed the shared "Reset Zoom" enabled state. `getOtherPlot` is
    // read lazily inside the hook, so it sees the real instance even though
    // it's registered before that instance exists.
    const makeSyncHook = (getOtherPlot: () => uPlot | null) => (self: uPlot, key: string) => {
      if (key !== "x") {
        return;
      }
      const { min, max } = self.scales.x;
      if (min == null || max == null) {
        return;
      }
      const otherPlot = getOtherPlot();
      if (otherPlot && (otherPlot.scales.x.min !== min || otherPlot.scales.x.max !== max)) {
        otherPlot.setScale("x", { min, max });
      }
      setIsZoomed(isRangeZoomed(domain, min, max));
    };

    const dragEnabled = !isCoarsePointer;

    loudnessPlotRef.current = new uPlot(
      {
        width: Math.max(loudnessContainer.clientWidth, minChartWidth),
        height: loudnessHeight,
        legend: { show: true },
        scales: {
          x: { time: false },
          y: { auto: true },
        },
        axes: [
          {
            stroke: readThemeToken("--chart-axis", "#95aca8"),
            grid: { stroke: readThemeToken("--chart-grid", "rgba(160,194,187,0.14)") },
            values: (_plot, ticks) => ticks.map((value) => `${Math.round(value)}s`),
          },
          {
            stroke: readThemeToken("--chart-axis", "#95aca8"),
            grid: { stroke: readThemeToken("--chart-grid", "rgba(160,194,187,0.14)") },
            values: (_plot, ticks) => ticks.map((value) => `${value.toFixed(1)} LUFS`),
          },
        ],
        cursor: {
          drag: { x: dragEnabled, y: false },
        },
        series: [
          {},
          {
            label: "Momentary (LUFS)",
            stroke: readThemeToken("--chart-momentary", "#37d2be"),
            width: 2,
            spanGaps: false,
          },
          {
            label: "Short-term (LUFS)",
            stroke: readThemeToken("--chart-shortterm", "#f7b756"),
            width: 2,
            spanGaps: false,
          },
        ],
        hooks: {
          setScale: [makeSyncHook(() => peakPlotRef.current)],
        },
      },
      [x, momentary, shortTerm],
      loudnessContainer,
    );

    peakPlotRef.current = new uPlot(
      {
        width: Math.max(peakContainer.clientWidth, minChartWidth),
        height: peakHeight,
        legend: { show: true },
        scales: {
          x: { time: false },
          y: { auto: true },
        },
        axes: [
          {
            stroke: readThemeToken("--chart-axis", "#95aca8"),
            grid: { stroke: readThemeToken("--chart-grid", "rgba(160,194,187,0.14)") },
            values: (_plot, ticks) => ticks.map((value) => `${Math.round(value)}s`),
          },
          {
            stroke: readThemeToken("--chart-axis", "#95aca8"),
            grid: { stroke: readThemeToken("--chart-grid", "rgba(160,194,187,0.14)") },
            values: (_plot, ticks) => ticks.map((value) => `${value.toFixed(2)} dBTP`),
          },
        ],
        cursor: {
          drag: { x: dragEnabled, y: false },
        },
        series: [
          {},
          {
            label: "True peak (dBTP)",
            stroke: readThemeToken("--chart-truepeak", "#ff9c55"),
            width: 2,
            spanGaps: true,
          },
        ],
        hooks: {
          setScale: [makeSyncHook(() => loudnessPlotRef.current)],
        },
      },
      [x, truePeak],
      peakContainer,
    );

    // Reapply the pre-recreation zoom/pan (if any) now that both fresh
    // instances exist. This runs through the same setScale path as a manual
    // zoom, so the sync hook mirrors it onto the other chart and restores
    // `isZoomed` to match.
    if (preservedScale) {
      loudnessPlotRef.current.setScale("x", {
        min: clamp(preservedScale.min, domain.min, domain.max),
        max: clamp(preservedScale.max, domain.min, domain.max),
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!loudnessContainerRef.current || !peakContainerRef.current) {
        return;
      }

      loudnessPlotRef.current?.setSize({
        width: Math.max(loudnessContainerRef.current.clientWidth, minChartWidth),
        height: loudnessHeight,
      });
      peakPlotRef.current?.setSize({
        width: Math.max(peakContainerRef.current.clientWidth, minChartWidth),
        height: peakHeight,
      });
    });

    resizeObserver.observe(loudnessContainer);
    resizeObserver.observe(peakContainer);
    return () => {
      resizeObserver.disconnect();
      loudnessPlotRef.current?.destroy();
      peakPlotRef.current?.destroy();
      loudnessPlotRef.current = null;
      peakPlotRef.current = null;
    };
  }, [timeline, themeVersion, isCoarsePointer]);

  const applyZoom = (factor: number) => {
    const domain = xDomainRef.current;
    const primary = loudnessPlotRef.current;
    if (!domain || !primary) {
      return;
    }

    const fullSpan = Math.max(domain.max - domain.min, MIN_ZOOM_SPAN_SECONDS);
    const currentMin = primary.scales.x.min ?? domain.min;
    const currentMax = primary.scales.x.max ?? domain.max;
    const center = (currentMin + currentMax) / 2;
    const currentSpan = Math.max(currentMax - currentMin, MIN_ZOOM_SPAN_SECONDS);
    const nextSpan = clamp(currentSpan * factor, MIN_ZOOM_SPAN_SECONDS, fullSpan);

    let nextMin = center - nextSpan / 2;
    let nextMax = center + nextSpan / 2;
    if (nextMin < domain.min) {
      nextMax += domain.min - nextMin;
      nextMin = domain.min;
    }
    if (nextMax > domain.max) {
      nextMin -= nextMax - domain.max;
      nextMax = domain.max;
    }
    nextMin = clamp(nextMin, domain.min, domain.max);
    nextMax = clamp(nextMax, domain.min, domain.max);

    // The plot's own setScale hook (wired above) propagates this to the
    // other chart and refreshes the zoomed state.
    primary.setScale("x", { min: nextMin, max: nextMax });
  };

  const resetZoom = () => {
    const domain = xDomainRef.current;
    if (!domain || !loudnessPlotRef.current) {
      return;
    }
    loudnessPlotRef.current.setScale("x", { min: domain.min, max: domain.max });
  };

  const downloadTimelineCsv = () => {
    const { timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp } = timeline;
    const rows = timeSeconds.map((time, index) => {
      const momentary = momentaryLufs[index];
      const shortTerm = shortTermLufs[index];
      const peak = truePeakDbtp[index];
      return [
        time.toFixed(3),
        momentary == null ? "" : momentary.toFixed(2),
        shortTerm == null ? "" : shortTerm.toFixed(2),
        Number.isFinite(peak) ? peak.toFixed(2) : "",
      ].join(",");
    });
    const csv = ["time_seconds,momentary_lufs,short_term_lufs,true_peak_dbtp", ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `truepeak-timeline-${fileNameTimestamp()}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
          <span className="rounded-full border border-[var(--line)] bg-[var(--surface-0)] px-3 py-1.5">
            Timeline
          </span>
          <span>Loudness and true peak use separate axes.</span>
        </div>
        <div className="flex items-center gap-1.5" role="group" aria-label="Timeline zoom controls">
          <Button type="button" size="sm" variant="ghost" onClick={() => applyZoom(ZOOM_IN_FACTOR)}>
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Zoom in</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => applyZoom(ZOOM_OUT_FACTOR)}>
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Zoom out</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={resetZoom} disabled={!isZoomed}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Reset Zoom
          </Button>
        </div>
      </div>

      <p id={summaryId} className="sr-only">
        {summaryText}
      </p>

      {/* Unpadded, exactly-measured mount: uPlot sizes itself to this element's
          clientWidth, so padding here would make the chart wider than the
          visible box. Visual padding lives on the outer, non-scrolling
          border box instead; horizontal overflow scrolls only the mount. */}
      <div className="rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)] p-3">
        <div className="overflow-x-auto overscroll-x-contain">
          <div
            ref={loudnessContainerRef}
            role="img"
            aria-label="Momentary and short-term loudness chart in LUFS"
            aria-describedby={summaryId}
            className="min-h-[250px] min-w-[240px]"
          />
        </div>
      </div>
      <div className="rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)] p-3">
        <div className="overflow-x-auto overscroll-x-contain">
          <div
            ref={peakContainerRef}
            role="img"
            aria-label="True peak chart in dBTP"
            aria-describedby={summaryId}
            className="min-h-[220px] min-w-[240px]"
          />
        </div>
      </div>

      <details
        className="rounded-[16px] border border-[var(--line)] bg-[var(--surface-0)]/40 px-4 py-3 text-sm text-[var(--muted)]"
        open={tableOpen}
        onToggle={(event) => setTableOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer items-center gap-2 font-semibold text-[var(--ink)]">
          {tableOpen ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
          View timeline data table
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-5 text-[var(--muted)]">
            {isTableDownsampled
              ? `Showing ${tableRows.length} of ${timeline.timeSeconds.length} samples, evenly spaced. Download the CSV for every sample.`
              : "Every sample in this timeline."}
          </p>
          <div className="overflow-x-auto rounded-[12px] border border-[var(--line)]/70">
            <table id={tableId} className="w-full min-w-[420px] border-collapse text-xs tabular-nums">
              <caption className="sr-only">Per-sample loudness and true peak timeline values for this file</caption>
              <thead>
                <tr className="text-left text-[var(--muted)]">
                  <th scope="col" className="border-b border-[var(--line)] bg-[var(--surface-1)]/60 py-1.5 px-3">
                    Time
                  </th>
                  <th scope="col" className="border-b border-[var(--line)] bg-[var(--surface-1)]/60 py-1.5 px-3">
                    Momentary
                  </th>
                  <th scope="col" className="border-b border-[var(--line)] bg-[var(--surface-1)]/60 py-1.5 px-3">
                    Short-term
                  </th>
                  <th scope="col" className="border-b border-[var(--line)] bg-[var(--surface-1)]/60 py-1.5 px-3">
                    True peak
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => (
                  <tr key={row.index}>
                    <td className="border-b border-[var(--line)]/60 px-3 py-1 text-[var(--ink)]">
                      {formatDuration(row.timeSeconds)}
                    </td>
                    <td className="border-b border-[var(--line)]/60 px-3 py-1">
                      {row.momentaryLufs == null ? "n/a" : formatLufs(row.momentaryLufs)}
                    </td>
                    <td className="border-b border-[var(--line)]/60 px-3 py-1">
                      {row.shortTermLufs == null ? "n/a" : formatLufs(row.shortTermLufs)}
                    </td>
                    <td className="border-b border-[var(--line)]/60 px-3 py-1">
                      {formatPeakDbtp(row.truePeakDbtp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={downloadTimelineCsv}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download timeline CSV
          </Button>
        </div>
      </details>
    </div>
  );
}
