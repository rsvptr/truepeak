import { cn } from "@/lib/utils";

type LogoSize = "sm" | "md" | "lg";

const logoSizeClasses: Record<
  LogoSize,
  {
    markWrap: string;
    title: string;
    subtitle: string;
    gap: string;
  }
> = {
  sm: {
    markWrap: "h-8 w-8",
    title: "text-lg",
    subtitle: "text-[0.6875rem]",
    gap: "gap-2.5",
  },
  md: {
    markWrap: "h-10 w-10",
    title: "text-[1.55rem]",
    subtitle: "text-xs",
    gap: "gap-3",
  },
  lg: {
    markWrap: "h-11 w-11 sm:h-12 sm:w-12",
    title: "text-[2.5rem] sm:text-[3.4rem]",
    subtitle: "text-sm",
    gap: "gap-3.5",
  },
};

export function TruePeakLogo({
  className,
  markClassName,
  titleClassName,
  subtitle,
  imageSrc,
  size = "md",
}: {
  className?: string;
  markClassName?: string;
  titleClassName?: string;
  subtitle?: string;
  imageSrc?: string;
  size?: LogoSize;
}) {
  const styles = logoSizeClasses[size];
  // The mark renders at 32-48px, so a 96px source covers 2x displays.
  const resolvedImageSrc = imageSrc ?? "/logo-96.png";

  return (
    <span className={cn("inline-flex items-center", styles.gap, className)}>
      <span
        className={cn("relative shrink-0 overflow-hidden", styles.markWrap, markClassName)}
        aria-hidden="true"
      >
        {/* Plain img: images are unoptimized, so next/image would only add runtime. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolvedImageSrc}
          alt=""
          decoding="async"
          className="absolute inset-0 h-full w-full object-contain"
        />
      </span>
      <span className="inline-flex min-w-0 flex-col">
        <span
          className={cn(
            "font-semibold tracking-[-0.04em] text-[var(--ink)]",
            styles.title,
            titleClassName,
          )}
        >
          TruePeak
        </span>
        {subtitle ? (
          <span
            className={cn(
              "mt-1 font-medium uppercase tracking-[0.18em] text-[var(--muted)]",
              styles.subtitle,
            )}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}
