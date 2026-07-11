"use client";

import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { AnalysisTimeline } from "@/types/audio";

interface TimelineChartProps {
  timeline: AnalysisTimeline;
}

function readThemeToken(name: string, fallback: string) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export function TimelineChart({ timeline }: TimelineChartProps) {
  const loudnessContainerRef = useRef<HTMLDivElement | null>(null);
  const peakContainerRef = useRef<HTMLDivElement | null>(null);
  const loudnessPlotRef = useRef<uPlot | null>(null);
  const peakPlotRef = useRef<uPlot | null>(null);

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

  useEffect(() => {
    const loudnessContainer = loudnessContainerRef.current;
    const peakContainer = peakContainerRef.current;
    if (!loudnessContainer || !peakContainer) {
      return;
    }

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
          drag: { x: true, y: false },
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
          drag: { x: true, y: false },
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
      },
      [x, truePeak],
      peakContainer,
    );

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
  }, [timeline, themeVersion]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">
        <span className="rounded-full border border-[var(--line)] bg-[var(--surface-0)] px-3 py-1.5">
          Timeline
        </span>
        <span>Loudness and true peak use separate axes.</span>
      </div>
      <div
        ref={loudnessContainerRef}
        role="img"
        aria-label="Momentary and short-term loudness chart in LUFS"
        className="min-h-[250px] w-full overflow-x-auto overflow-y-hidden rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)] p-3"
      />
      <div
        ref={peakContainerRef}
        role="img"
        aria-label="True peak chart in dBTP"
        className="min-h-[220px] w-full overflow-x-auto overflow-y-hidden rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)] p-3"
      />
    </div>
  );
}
