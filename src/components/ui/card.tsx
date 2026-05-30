import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[28px] border border-[color:var(--line)]/80 bg-[color:var(--surface-0)] shadow-[0_14px_38px_rgba(0,0,0,0.12)] transition-[border-color,background-color,box-shadow] duration-200 ease-out",
        className,
      )}
      {...props}
    />
  );
}
