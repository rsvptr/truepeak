"use client";

import { memo } from "react";
import { BarChart3, SlidersHorizontal } from "lucide-react";
import { useWorkspaceCommands, useWorkspaceSession } from "@/components/workspace-contexts";
import { formatLufs, formatPeakDbtp, formatPresetLufs, formatPresetPeakDbtp } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface WorkspaceSummaryRailProps {
  variant?: "default" | "compact";
}

function RailMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex h-full min-h-[96px] min-w-[42%] shrink-0 snap-start flex-col justify-between rounded-[20px] border border-[var(--line)]/60 bg-[var(--surface-1)]/50 px-3 py-3 sm:min-h-[124px] sm:min-w-0 sm:px-4 sm:py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 break-words text-lg font-semibold text-[var(--ink)] tabular-nums sm:mt-3">{value}</div>
      <div className="mt-1 text-xs leading-5 text-[var(--muted)] sm:mt-2">{hint}</div>
    </div>
  );
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-[42%] shrink-0 snap-start rounded-[16px] border border-[var(--line)]/60 bg-[var(--surface-1)]/46 px-3 py-2.5 sm:min-w-[104px]">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

export const WorkspaceSummaryRail = memo(function WorkspaceSummaryRail({
  variant = "default",
}: WorkspaceSummaryRailProps) {
  const {
    currentTarget,
    openCompare: onOpenCompare,
    openPresetLibrary: onOpenPresetLibrary,
    route: { analysisMode, uiMode },
  } = useWorkspaceCommands();
  const { completedJobs, jobs, queueCounts, sessionStats } = useWorkspaceSession();
  const averageLufs = sessionStats.averageIntegrated;
  const canOpenCompare = uiMode === "advanced" && completedJobs.length > 1;
  const completedCount = completedJobs.length;
  const complianceCounts = analysisMode === "targeted" ? sessionStats.complianceCounts : undefined;
  const hottestTruePeak = sessionStats.hottestPeakJob?.result?.metrics.truePeakDbtp ?? null;
  const issueCount = queueCounts.issues;
  const queueCount = jobs.length;
  if (variant === "compact") {
    return (
      <div className="rounded-[20px] border border-[var(--line)]/60 bg-[var(--surface-0)]/82 px-3 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          {/* Mobile: single-row horizontal snap rail so the six metrics stay
              one compact strip above the results instead of three stacked rows
              (UX-010). sm and up restore the original grid/flex layout. */}
          <div className="flex min-w-0 snap-x gap-2 overflow-x-auto overscroll-x-contain pb-1 sm:grid sm:grid-cols-3 sm:overflow-visible sm:pb-0 lg:grid-cols-6 xl:flex xl:flex-wrap">
            <CompactMetric label="Queue" value={String(queueCount)} />
            <CompactMetric label="Complete" value={String(completedCount)} />
            <CompactMetric label="Issues" value={String(issueCount)} />
            <CompactMetric label="Avg LUFS" value={formatLufs(averageLufs)} />
            <CompactMetric label="Peak" value={formatPeakDbtp(hottestTruePeak)} />
            {analysisMode === "targeted" && complianceCounts ? (
              <CompactMetric label="On target" value={String(complianceCounts["on-target"])} />
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-2 rounded-[16px] border border-[var(--line)]/55 bg-[var(--surface-1)]/42 px-3 py-3 sm:flex-row sm:items-center sm:justify-between xl:max-w-[520px]">
            {analysisMode === "targeted" && currentTarget ? (
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Preset</div>
                <div className="mt-1 truncate text-sm font-semibold text-[var(--ink)]">{currentTarget.label}</div>
                <div className="mt-0.5 text-xs tabular-nums text-[var(--muted)]">
                  {formatPresetLufs(currentTarget.loudnessTargetLufs)} / {formatPresetPeakDbtp(currentTarget.truePeakCeilingDbtp)}
                </div>
              </div>
            ) : (
              <div className="min-w-0 text-sm leading-5 text-[var(--muted)]">
                Measure-only session. No target or gain plan is active.
              </div>
            )}

            {/* No Compare button here: the compact rail only renders in
                Advanced mode, immediately above the Session views tablist,
                which already offers a Compare tab (see UX-036). Repeating
                the action here doubled up the same destination. */}
            {analysisMode === "targeted" && currentTarget ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={onOpenPresetLibrary}>
                  <SlidersHorizontal className="h-4 w-4" />
                  Presets
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[24px] border border-[var(--line)]/65 bg-[var(--surface-0)]/92 px-4 py-4 sm:px-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.84fr)] xl:items-stretch">
        {/* Mobile: single-row horizontal snap rail (UX-010); sm and up restore
            the original responsive grid. */}
        <div className="flex snap-x gap-3 overflow-x-auto overscroll-x-contain pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 xl:grid-cols-3 2xl:grid-cols-6">
          <RailMetric label="Queue" value={String(queueCount)} hint="Files in this session" />
          <RailMetric label="Complete" value={String(completedCount)} hint="Ready to inspect" />
          <RailMetric label="Issues" value={String(issueCount)} hint="Failed or canceled" />
          <RailMetric label="Average LUFS" value={formatLufs(averageLufs)} hint="Across valid integrated readings" />
          <RailMetric label="Hottest peak" value={formatPeakDbtp(hottestTruePeak)} hint="Highest measured true peak" />
          {analysisMode === "targeted" && complianceCounts ? (
            <RailMetric label="On target" value={String(complianceCounts["on-target"])} hint="Inside the tolerance window" />
          ) : null}
        </div>

        <div className="flex h-full min-h-[124px] flex-col justify-between rounded-[22px] border border-[var(--line)]/60 bg-[var(--surface-1)]/58 px-4 py-4">
          {analysisMode === "targeted" && currentTarget ? (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Current preset</div>
                  <div className="mt-2 text-base font-semibold text-[var(--ink)]">{currentTarget.label}</div>
                  <div className="mt-1 text-sm text-[var(--muted)] tabular-nums">
                    {formatPresetLufs(currentTarget.loudnessTargetLufs)} / {formatPresetPeakDbtp(currentTarget.truePeakCeilingDbtp)}
                  </div>
                </div>
                <Button type="button" size="sm" variant="secondary" className="justify-center" onClick={onOpenPresetLibrary}>
                  <SlidersHorizontal className="h-4 w-4" />
                  Presets
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {currentTarget.highlights.slice(0, 3).map((highlight) => (
                  <Badge key={highlight} className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                    {highlight}
                  </Badge>
                ))}
              </div>
            </>
          ) : (
            <div className="max-w-[48ch] text-sm leading-6 text-[var(--muted)]">
              No target is active. The session is showing measured loudness, peaks, dynamics, and timing as recorded.
            </div>
          )}

          {canOpenCompare ? (
            <Button type="button" size="sm" variant="secondary" onClick={onOpenCompare} className="mt-4 w-full justify-center sm:w-auto">
              <BarChart3 className="h-4 w-4" />
              Open Compare
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});
