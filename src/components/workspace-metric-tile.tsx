import { cn } from "@/lib/utils";

export function WorkspaceMetricTile({
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
        "flex h-full min-h-[148px] flex-col justify-between rounded-[24px] border p-5",
        accent
          ? "border-[color:var(--accent)]/25 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)] bg-[var(--surface-1)]",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-3 space-y-2">
        <div className="text-[clamp(1.7rem,2vw,2.35rem)] font-semibold leading-tight tabular-nums text-[var(--ink)] break-words">
          {value}
        </div>
        {hint ? <div className="max-w-[30ch] text-xs leading-5 text-[var(--muted)]">{hint}</div> : null}
      </div>
    </div>
  );
}
