"use client";

import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalFocus({
    open,
    panelRef,
    onClose,
    getInitialFocus: () => closeButtonRef.current,
  });

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50" aria-hidden={false}>
      <div
        aria-hidden="true"
        className="tp-fade-in absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="absolute inset-0 flex items-end justify-stretch lg:items-stretch lg:justify-end">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className={cn(
            "tp-drawer-in relative flex w-full flex-col border border-[var(--line)] bg-[var(--surface-1)] shadow-[var(--shadow-elevated)] overscroll-contain focus:outline-none",
            mobileMode === "full"
              ? "h-[100dvh] rounded-none"
              : "max-h-[88dvh] rounded-t-[28px] border-b-0",
            "lg:h-full lg:max-h-none lg:rounded-none lg:rounded-l-[30px] lg:border-b lg:border-l",
            desktopClassName,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                Studio panel
              </div>
              <h2 id={titleId} className="mt-2 text-xl font-semibold text-[var(--ink)] sm:text-2xl">
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
