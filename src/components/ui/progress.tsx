interface ProgressProps {
  value: number;
  label?: string;
}

export function Progress({ value, label = "Progress" }: ProgressProps) {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(value, 100)) : 0;

  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <div
        className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-strong))] transition-[width] duration-300 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
