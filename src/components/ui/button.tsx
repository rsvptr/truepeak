import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border text-sm font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-[var(--accent-strong)] px-4 py-2 text-[var(--surface-0)] shadow-sm hover:bg-[var(--accent-hover)] hover:shadow-[0_12px_28px_rgba(18,141,129,0.2)] focus-visible:ring-[var(--accent)]",
        secondary:
          "border-[var(--control-line)] bg-[var(--surface-1)] px-4 py-2 text-[var(--ink)] shadow-sm hover:border-[var(--accent)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)] focus-visible:ring-[var(--accent)]",
        ghost:
          "border-transparent px-3 py-2 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)] focus-visible:ring-[var(--accent)]",
        danger:
          "border-transparent bg-[#b9314f] px-4 py-2 text-white shadow-sm hover:bg-[#992843] hover:shadow-[0_12px_26px_rgba(153,40,67,0.22)] focus-visible:ring-[#b9314f]",
      },
      size: {
        sm: "h-9 px-3 text-xs",
        md: "h-11 px-4",
        lg: "h-12 px-5 text-base",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {}

// React 19: ref is a regular prop on function components, so it arrives
// through the spread; forwardRef is no longer needed.
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
