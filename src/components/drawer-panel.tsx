"use client";

import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useExitPresence } from "@/hooks/use-exit-presence";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DrawerPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  desktopClassName?: string;
  mobileMode?: "sheet" | "full";
}

export function DrawerPanel({
  open,
  onClose,
  title,
  description,
  children,
  desktopClassName,
  mobileMode = "sheet",
}: DrawerPanelProps) {
  const titleId = useId();
  const descriptionId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalFocus({
    open,
    panelRef,
    containerRef,
    onClose,
    getInitialFocus: () => closeButtonRef.current,
  });
  // useModalFocus is keyed on `open`, so the modal layer (stack entry, inert
  // background, scroll lock, focus restore) is released the moment `open`
  // flips false; only the visuals linger, inert, for the exit animation.
  const { mounted, exiting, onAnimationEnd } = useExitPresence(open);

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={cn("fixed inset-0 z-50", exiting && "pointer-events-none")}
      aria-hidden={false}
    >
      {/* Preventing the mousedown default keeps focus inside the panel, so a
          guard dialog opened by onClose (dirty preset draft) restores focus
          there instead of to <body>. */}
      <div
        aria-hidden="true"
        className={cn(
          exiting ? "tp-fade-out" : "tp-fade-in",
          "absolute inset-0 touch-none overscroll-contain bg-black/55 backdrop-blur-sm",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClose}
      />
      {/* pointer-events-none lets clicks outside the panel fall through to
          the backdrop (which closes the drawer); the panel re-enables them. */}
      <div className="pointer-events-none absolute inset-0 flex items-end justify-stretch lg:items-stretch lg:justify-end">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          inert={exiting}
          onAnimationEnd={onAnimationEnd}
          className={cn(
            exiting ? "tp-drawer-out" : "tp-drawer-in pointer-events-auto",
            "relative flex w-full flex-col border border-[var(--line)] bg-[var(--surface-1)] shadow-[var(--shadow-elevated)] overscroll-contain focus:outline-none",
            mobileMode === "full"
              ? "h-[100dvh] rounded-none"
              : "max-h-[88dvh] rounded-t-[28px] border-b-0",
            "lg:h-full lg:max-h-none lg:rounded-none lg:rounded-l-[30px] lg:border-b lg:border-l",
            desktopClassName,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-4 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
            {/* min-w-0 lets the title shrink and wrap instead of pushing
                Close off-screen; line-clamp-2 plus a shrink-0 Close button
                keep a filename-length title from ever hiding the control
                behind it (UX-034). */}
            <div className="min-w-0 flex-1">
              <div className="text-[0.6875rem] uppercase tracking-[0.18em] text-[var(--muted)]">
                Studio panel
              </div>
              <h2
                id={titleId}
                className="mt-2 line-clamp-2 wrap-anywhere text-xl font-semibold text-[var(--ink)] sm:text-2xl"
              >
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">
                  {description}
                </p>
              ) : null}
            </div>
            <Button
              ref={closeButtonRef}
              type="button"
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="shrink-0"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Close
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-5 sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
