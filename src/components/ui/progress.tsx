import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type ProgressProps = Omit<ComponentProps<"div">, "children" | "role"> & {
  value: number;
  label?: string;
};

export function Progress({ value, label = "Progress", className, ...props }: ProgressProps) {
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(value, 100)) : 0;

  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      {...props}
    >
      {/* Slide a full-width fill instead of animating width: transform stays on
          the compositor, so parallel lanes ticking at once cause no layout work,
          and the rounded end cap keeps its shape. */}
      <div
        className="h-full w-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-strong))] transition-transform duration-300 ease-out"
        style={{ transform: `translateX(-${100 - clamped}%)` }}
      />
    </div>
  );
}
