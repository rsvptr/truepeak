"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { ChevronDown, ChevronUp, Download, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fileNameTimestamp, formatDuration, formatLufs, formatPeakDbtp } from "@/lib/format";
import { downloadTextFile } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { AnalysisTimeline } from "@/types/audio";

interface TimelineChartProps {
  timeline: AnalysisTimeline;
}

interface XDomain {
  min: number;
  max: number;
}

// Order matches the loudness plot's series 1 and 2.
const LOUDNESS_SERIES = [
  { label: "Momentary", token: "--chart-momentary" },
  { label: "Short-term", token: "--chart-shortterm" },
] as const;

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

function minMax(values: Iterable<number>) {
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

// Legend value formatter shared by all three series. Replaces the previous
// `.map(v => Number(v.toFixed(2)))` passes over the whole series (PERF-10):
// same rounding (toFixed(2)) and the same uPlot.fmtNum rendering, just done
// lazily per legend read instead of once for every point on every rebuild.
function formatSeriesLegendValue(
  _self: uPlot,
  rawValue: number | null,
  _seriesIdx: number,
  dataIdx: number | null,
) {
  if (dataIdx == null) {
    return "--";
  }
  if (rawValue == null || !Number.isFinite(rawValue)) {
    return "";
  }
  return uPlot.fmtNum(Number(rawValue.toFixed(2)));
}

// uPlot treats a point as a gap only when it is `null` (`v != null`); it never
// tests for NaN, so the NaN sentinels the typed loudness series carry would be
// fed into the y-scale min/max and blank the chart. Translate them once per
// timeline on the way into uPlot. Exported for `validate-render-smoke.mjs`.
export function toNullGappedSeries(series: ArrayLike<number>): Array<number | null> {
  return Array.from(series, (value) => (Number.isFinite(value) ? value : null));
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
  // Zoom/pan carried across a rebuild (theme toggle, pointer-type change).
  // Written by the effect's cleanup, read by the next effect body.
  const lastScaleRef = useRef<XDomain | null>(null);
  // Cursor readout cells. Their text is written imperatively from uPlot's
  // setCursor hook rather than through React state: the hook fires on every
  // pointer move, and a re-render would rebuild the data table (up to 200
  // rows) each time. React only rewrites these nodes when the JSX values
  // below change, which happens when a new timeline arrives.
  const loudnessTimeRef = useRef<HTMLElement | null>(null);
  const loudnessMomentaryRef = useRef<HTMLElement | null>(null);
  const loudnessShortTermRef = useRef<HTMLElement | null>(null);
  const loudnessStatusRef = useRef<HTMLParagraphElement | null>(null);
  const peakTimeRef = useRef<HTMLElement | null>(null);
  const peakValueRef = useRef<HTMLElement | null>(null);
  const peakStatusRef = useRef<HTMLParagraphElement | null>(null);

  const summaryId = useId();
  const tableId = useId();

  const [isZoomed, setIsZoomed] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  // uPlot binds a click handler to each legend cell to toggle that series, and
  // styles the cells as pointers, but a <th> is not focusable and uPlot attaches
  // no key handler. The mount is also role="img", which hides those cells from
  // assistive tech entirely. These buttons give the same capability a keyboard
  // path (WCAG SC 2.1.1); the setSeries hook below keeps them in step when the
  // legend is clicked with a mouse, so there is still one source of truth.
  const [loudnessSeriesShown, setLoudnessSeriesShown] = useState<[boolean, boolean]>([true, true]);
  // Read inside the plot-building effect without making it a dependency: a
  // toggle must not tear down and rebuild both charts. Kept in sync from an
  // effect rather than during render.
  const loudnessSeriesShownRef = useRef(loudnessSeriesShown);
  useEffect(() => {
    loudnessSeriesShownRef.current = loudnessSeriesShown;
  }, [loudnessSeriesShown]);

  // Drag-to-zoom on a touch screen fights with native scroll panning, so it's
  // disabled for coarse pointers in favour of the explicit zoom buttons
  // below (which remain available to every input type). Hydration-safe
  // (MOB-15): reads matchMedia during render, so this never flips after mount
  // and rebuilds the uPlot instances.
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");

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
        momentaryLufs: Number.isFinite(momentaryLufs[index]) ? momentaryLufs[index] : null,
        shortTermLufs: Number.isFinite(shortTermLufs[index]) ? shortTermLufs[index] : null,
        truePeakDbtp: truePeakDbtp[index],
      });
    }

    const lastIndex = total - 1;
    if (rows[rows.length - 1]?.index !== lastIndex) {
      rows.push({
        index: lastIndex,
        timeSeconds: timeSeconds[lastIndex],
        momentaryLufs: Number.isFinite(momentaryLufs[lastIndex]) ? momentaryLufs[lastIndex] : null,
        shortTermLufs: Number.isFinite(shortTermLufs[lastIndex]) ? shortTermLufs[lastIndex] : null,
        truePeakDbtp: truePeakDbtp[lastIndex],
      });
    }

    return rows;
  }, [timeline]);

  const isTableDownsampled = tableRows.length < timeline.timeSeconds.length;

  // Keyed on the timeline object so a theme toggle or resize reuses the same
  // converted arrays instead of copying both series again.
  const loudnessSeries = useMemo(
    () => [toNullGappedSeries(timeline.momentaryLufs), toNullGappedSeries(timeline.shortTermLufs)],
    [timeline],
  );

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
    // Read the scale the cleanup stashed, not the plot refs. React runs the
    // previous effect's cleanup before this body, and that cleanup nulls both
    // plot refs, so reading loudnessPlotRef.current here always saw null and the
    // whole preservation path was dead: a theme toggle silently reset the zoom.
    const preservedScale = timelineChanged ? null : lastScaleRef.current;
    lastScaleRef.current = null;

    loudnessPlotRef.current?.destroy();
    peakPlotRef.current?.destroy();
    loudnessContainer.innerHTML = "";
    peakContainer.innerHTML = "";

    const x = timeline.timeSeconds;
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

    // Cursor readout (MOB-11). uPlot's own legend needs a hover, which a touch
    // screen cannot produce, so the values at the cursor are mirrored into a
    // row under each chart. The last cursor position stays on screen after the
    // pointer leaves, so there is always a value to read.
    const setText = (node: HTMLElement | null, text: string) => {
      if (node && node.textContent !== text) {
        node.textContent = text;
      }
    };
    let loudnessCursorIndex = x.length - 1;
    let peakCursorIndex = x.length - 1;

    const showLoudnessAt = (index: number) => {
      loudnessCursorIndex = index;
      setText(loudnessTimeRef.current, formatDuration(x[index]));
      setText(loudnessMomentaryRef.current, formatLufs(loudnessSeries[0][index]));
      setText(loudnessShortTermRef.current, formatLufs(loudnessSeries[1][index]));
    };
    const showPeakAt = (index: number) => {
      peakCursorIndex = index;
      setText(peakTimeRef.current, formatDuration(x[index]));
      setText(peakValueRef.current, formatPeakDbtp(timeline.truePeakDbtp[index]));
    };

    // Announced only when an interaction ends (touch end, mouse leave), not on
    // every move, so the live region does not flood a screen reader.
    const announceLoudness = () => {
      const index = loudnessCursorIndex;
      setText(
        loudnessStatusRef.current,
        `Loudness at ${formatDuration(x[index])}: momentary ${formatLufs(loudnessSeries[0][index])}, short-term ${formatLufs(loudnessSeries[1][index])}.`,
      );
    };
    const announcePeak = () => {
      const index = peakCursorIndex;
      setText(
        peakStatusRef.current,
        `True peak at ${formatDuration(x[index])}: ${formatPeakDbtp(timeline.truePeakDbtp[index])}.`,
      );
    };

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
            show: loudnessSeriesShownRef.current[0],
            value: formatSeriesLegendValue,
          },
          {
            label: "Short-term (LUFS)",
            stroke: readThemeToken("--chart-shortterm", "#f7b756"),
            width: 2,
            spanGaps: false,
            show: loudnessSeriesShownRef.current[1],
            value: formatSeriesLegendValue,
          },
        ],
        hooks: {
          setScale: [makeSyncHook(() => peakPlotRef.current)],
          setCursor: [
            (plot) => {
              const index = plot.cursor.idx;
              if (index != null) {
                showLoudnessAt(index);
              }
            },
          ],
          // Mirror a legend click back into React so the accessible toggles
          // below never disagree with what the chart is actually drawing.
          setSeries: [
            (plot) => {
              const next: [boolean, boolean] = [
                plot.series[1]?.show !== false,
                plot.series[2]?.show !== false,
              ];
              setLoudnessSeriesShown((current) =>
                current[0] === next[0] && current[1] === next[1] ? current : next,
              );
            },
          ],
        },
      },
      [x, loudnessSeries[0], loudnessSeries[1]],
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
            value: formatSeriesLegendValue,
          },
        ],
        hooks: {
          setScale: [makeSyncHook(() => loudnessPlotRef.current)],
          setCursor: [
            (plot) => {
              const index = plot.cursor.idx;
              if (index != null) {
                showPeakAt(index);
              }
            },
          ],
        },
      },
      [x, timeline.truePeakDbtp],
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

    // uPlot moves its cursor from mouse events only, so on a touch screen the
    // cursor never moves and the readout above would stay on the last sample
    // (MOB-11). Map a drag on the plot area onto setCursor, which fires the
    // hooks above. The listeners live on uPlot's own overlay element and go
    // away with it when the plot is destroyed below.
    const wireCursorInput = (plot: uPlot, announce: () => void) => {
      const over = plot.over;
      let startX = 0;
      let startY = 0;

      const moveCursorTo = (touch: Touch) => {
        const bounds = over.getBoundingClientRect();
        plot.setCursor({ left: touch.clientX - bounds.left, top: touch.clientY - bounds.top });
      };

      over.addEventListener("mouseleave", announce);
      if (!isCoarsePointer) {
        return;
      }

      over.addEventListener(
        "touchstart",
        (event) => {
          const touch = event.touches[0];
          if (!touch) {
            return;
          }
          startX = touch.clientX;
          startY = touch.clientY;
          moveCursorTo(touch);
        },
        { passive: false },
      );
      over.addEventListener(
        "touchmove",
        (event) => {
          const touch = event.touches[0];
          if (!touch) {
            return;
          }
          // `.u-over` is `touch-action: pan-y`, so a vertical drag still
          // scrolls the page; claim the gesture only once it is mostly
          // horizontal.
          if (Math.abs(touch.clientX - startX) > Math.abs(touch.clientY - startY) && event.cancelable) {
            event.preventDefault();
          }
          moveCursorTo(touch);
        },
        { passive: false },
      );
      over.addEventListener("touchend", announce);
    };

    wireCursorInput(loudnessPlotRef.current, announceLoudness);
    wireCursorInput(peakPlotRef.current, announcePeak);

    // rAF-throttled: a CSS width transition (drawer open/close, sidebar
    // resize) fires the observer once per frame, and each callback used to
    // trigger a full uPlot redraw on both charts. Coalesce to at most one
    // setSize per animation frame (PERF-10).
    let resizeFrame: number | null = null;
    const applyResize = () => {
      resizeFrame = null;
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
    };
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame != null) {
        cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = requestAnimationFrame(applyResize);
    });

    resizeObserver.observe(loudnessContainer);
    resizeObserver.observe(peakContainer);
    return () => {
      resizeObserver.disconnect();
      if (resizeFrame != null) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      // Stash the current zoom before the instances go away. This is the only
      // point at which it is still readable: the next effect body runs after
      // this cleanup has already nulled the refs.
      const plot = loudnessPlotRef.current;
      lastScaleRef.current =
        plot && plot.scales.x.min != null && plot.scales.x.max != null
          ? { min: plot.scales.x.min, max: plot.scales.x.max }
          : null;
      loudnessPlotRef.current?.destroy();
      peakPlotRef.current?.destroy();
      loudnessPlotRef.current = null;
      peakPlotRef.current = null;
    };
  }, [timeline, loudnessSeries, themeVersion, isCoarsePointer]);

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

  const toggleLoudnessSeries = (seriesIndex: 0 | 1) => {
    const next = !loudnessSeriesShown[seriesIndex];
    // These buttons never hide both: an empty chart is not a useful state to be
    // one click away from. uPlot's own legend cells still allow it, which is its
    // stock behaviour and is left alone; the buttons stay in step either way
    // through the setSeries hook.
    if (!next && !loudnessSeriesShown[seriesIndex === 0 ? 1 : 0]) {
      return;
    }
    // setSeries fires the hook above, which is what updates React state.
    loudnessPlotRef.current?.setSeries(seriesIndex + 1, { show: next });
  };

  // Starting values for the readout row under each chart: the last sample,
  // until a pointer moves the cursor.
  const lastSampleIndex = timeline.timeSeconds.length - 1;

  const downloadTimelineCsv = () => {
    const { timeSeconds, momentaryLufs, shortTermLufs, truePeakDbtp } = timeline;
    const rows = Array.from(timeSeconds, (time, index) => {
      const momentary = momentaryLufs[index];
      const shortTerm = shortTermLufs[index];
      const peak = truePeakDbtp[index];
      return [
        time.toFixed(3),
        Number.isFinite(momentary) ? momentary.toFixed(2) : "",
        Number.isFinite(shortTerm) ? shortTerm.toFixed(2) : "",
        Number.isFinite(peak) ? peak.toFixed(2) : "",
      ].join(",");
    });
    const csv = ["time_seconds,momentary_lufs,short_term_lufs,true_peak_dbtp", ...rows].join("\n");
    downloadTextFile(
      `truepeak-timeline-${fileNameTimestamp("timeline")}.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
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

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Loudness chart series">
        {LOUDNESS_SERIES.map((series, index) => (
          <Button
            key={series.label}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={loudnessSeriesShown[index]}
            onClick={() => toggleLoudnessSeries(index as 0 | 1)}
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full"
              style={{
                backgroundColor: loudnessSeriesShown[index] ? `var(${series.token})` : "var(--muted)",
              }}
            />
            {series.label}
          </Button>
        ))}
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
        <dl
          data-timeline-readout="loudness"
          className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--line)]/60 pt-2 text-xs tabular-nums text-[var(--muted)]"
        >
          <div className="flex items-baseline gap-1.5">
            <dt>Time</dt>
            <dd ref={loudnessTimeRef} className="text-[var(--ink)]">
              {formatDuration(timeline.timeSeconds[lastSampleIndex])}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt>Momentary</dt>
            <dd ref={loudnessMomentaryRef} className="text-[var(--ink)]">
              {formatLufs(timeline.momentaryLufs[lastSampleIndex])}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt>Short-term</dt>
            <dd ref={loudnessShortTermRef} className="text-[var(--ink)]">
              {formatLufs(timeline.shortTermLufs[lastSampleIndex])}
            </dd>
          </div>
        </dl>
        <p ref={loudnessStatusRef} role="status" className="sr-only" />
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
        <dl
          data-timeline-readout="peak"
          className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-[var(--line)]/60 pt-2 text-xs tabular-nums text-[var(--muted)]"
        >
          <div className="flex items-baseline gap-1.5">
            <dt>Time</dt>
            <dd ref={peakTimeRef} className="text-[var(--ink)]">
              {formatDuration(timeline.timeSeconds[lastSampleIndex])}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt>True peak</dt>
            <dd ref={peakValueRef} className="text-[var(--ink)]">
              {formatPeakDbtp(timeline.truePeakDbtp[lastSampleIndex])}
            </dd>
          </div>
        </dl>
        <p ref={peakStatusRef} role="status" className="sr-only" />
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
