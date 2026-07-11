"use client";

import { useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalFocus({
    open,
    panelRef,
    onClose,
    // The safe action gets initial focus so Enter cannot destroy anything.
    getInitialFocus: () => cancelButtonRef.current,
  });

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4 py-6 sm:px-6" aria-hidden={false}>
      <div
        aria-hidden="true"
        className="tp-fade-in absolute inset-0 bg-black/62 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="tp-dialog-in relative z-10 w-full max-w-[460px] rounded-[28px] border border-[var(--line)] bg-[var(--surface-1)] p-5 shadow-[var(--shadow-elevated)] focus:outline-none sm:p-6"
      >
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border",
              tone === "danger"
                ? "tone-danger"
                : "border-[color:var(--accent)]/20 bg-[color:var(--accent-soft)] text-[var(--accent-text)]",
            )}
            aria-hidden="true"
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Please confirm</div>
            <h2 id={titleId} className="mt-2 text-xl font-semibold text-[var(--ink)]">
              {title}
            </h2>
            <p id={descriptionId} className="mt-3 text-sm leading-6 text-[var(--muted)]">
              {description}
            </p>
          </div>
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelButtonRef} type="button" size="sm" variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
