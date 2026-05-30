"use client";

import { History, Trash2 } from "lucide-react";
import type { RecentSessionEntry } from "@/types/audio";
import { formatLufs, formatPeakDbtp, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const numberFormatter = new Intl.NumberFormat("en-GB");

export function RecentSessionsPanel({
  recentSessions,
  compact = false,
  onClear,
  className,
}: {
  recentSessions: RecentSessionEntry[];
  compact?: boolean;
  onClear?: () => void;
  className?: string;
}) {
  const displayLimit = compact ? 4 : 9;
  const hiddenCount = Math.max(0, recentSessions.length - displayLimit);
  return (
    <Card className={cn("h-full min-h-[260px] p-5 sm:p-6", className)}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
            Recent history
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-[var(--ink)]">
            Saved summaries from earlier runs
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">
            These cards keep the final readings close at hand. They are local snapshots, not live session restores.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{numberFormatter.format(recentSessions.length)} saved</Badge>
          {onClear ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClear}
              disabled={!recentSessions.length}
            >
              <Trash2 className="h-4 w-4" />
              Clear History
            </Button>
          ) : null}
        </div>
      </div>

      {recentSessions.length ? (
        <div
          className={cn(
            "mt-5 grid gap-3",
            compact ? "lg:grid-cols-2" : "lg:grid-cols-2 2xl:grid-cols-3",
          )}
        >
          {recentSessions.slice(0, displayLimit).map((session) => (
            <div
              key={`${session.id}-${session.analyzedAt}`}
              className="rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4"
            >
              <div className="break-words text-sm font-semibold leading-6 text-[var(--ink)]">
                {session.fileName}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {session.targetLabel ? <Badge>{session.targetLabel}</Badge> : <Badge>Measure Only</Badge>}
                {session.complianceLabel ? (
                  <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                    {session.complianceLabel}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm tabular-nums">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                    Integrated
                  </div>
                  <div className="mt-1 font-semibold text-[var(--ink)]">
                    {formatLufs(session.integratedLufs)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                    True peak
                  </div>
                  <div className="mt-1 font-semibold text-[var(--ink)]">
                    {formatPeakDbtp(session.truePeakDbtp)}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                <span className="min-w-0 break-words">{session.channelLayoutName}</span>
                <span className="min-w-0 break-words">{session.decoderLabel}</span>
              </div>
              <div className="mt-4 text-xs text-[var(--muted)]">
                {formatTimestamp(session.analyzedAt)} at {numberFormatter.format(session.sampleRate)} Hz
              </div>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <div className="flex items-center justify-center rounded-[22px] border border-dashed border-[var(--line)] bg-[var(--surface-1)]/60 p-4 text-sm text-[var(--muted)]">
              +{numberFormatter.format(hiddenCount)} more saved {hiddenCount === 1 ? "summary" : "summaries"} not shown
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 rounded-[22px] border border-dashed border-[var(--line)] bg-[var(--surface-1)] p-6 text-sm leading-6 text-[var(--muted)]">
          Saved summaries appear here when local history is on.
        </div>
      )}
    </Card>
  );
}

export function HistoryPreferenceCard({
  historyEnabled,
  recentCount,
  onToggle,
  onClear,
  className,
}: {
  historyEnabled: boolean;
  recentCount: number;
  onToggle: () => void;
  onClear: () => void;
  className?: string;
}) {
  return (
    <Card className={cn("h-full min-h-[260px] p-5 sm:p-6", className)}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
            Local history
          </div>
          <h2 className="mt-2 text-2xl font-semibold text-[var(--ink)]">
            Save finished readings only when you want to
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">
            History starts off. Turn it on if you want completed readings stored in this browser for later reference.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={historyEnabled ? "tone-success" : "border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]"}>
            {historyEnabled ? "History On" : "History Off"}
          </Badge>
          {historyEnabled ? (
            <Badge className="border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">
              {numberFormatter.format(recentCount)} saved
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant={historyEnabled ? "secondary" : "primary"} onClick={onToggle}>
          <History className="h-4 w-4" />
          {historyEnabled ? "Turn History Off" : "Turn History On"}
        </Button>
        {historyEnabled ? (
          <Button type="button" size="sm" variant="ghost" onClick={onClear} disabled={!recentCount}>
            <Trash2 className="h-4 w-4" />
            Clear Saved History
          </Button>
        ) : null}
      </div>

      <div className="mt-4 rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
        {historyEnabled
          ? "New completed runs will be saved as local summaries on this device. They stay available in the History panel until you clear them."
          : "Completed files stay in the current session only. Nothing is saved locally unless you turn history on."}
      </div>
    </Card>
  );
}
