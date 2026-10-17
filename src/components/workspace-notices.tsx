import { useId } from "react";
import { AlertTriangle, Info, RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WorkspaceNotices({
  persistentWarning,
  transientNotice,
  persistentAction,
  errorNotice = null,
  onDismissError,
  persistentNotice = null,
  onDismissPersistentNotice,
  onTransientNoticeHold,
}: {
  persistentWarning: string | null;
  transientNotice: string | null;
  persistentAction: { label: string; onClick: () => void } | null;
  errorNotice?: string | null;
  onDismissError?: () => void;
  // Information the user needs (e.g. what a recovery restored) stays until
  // dismissed instead of expiring like a transient confirmation.
  persistentNotice?: string | null;
  onDismissPersistentNotice?: () => void;
  // Pauses the transient notice's timer while it is hovered or focused.
  onTransientNoticeHold?: (reason: "hover" | "focus", held: boolean) => void;
}) {
  const warningId = useId();
  const errorId = useId();
  const persistentNoticeId = useId();

  // Notices with a button are split in two: an sr-only live region that
  // carries the announcement, and a visible box (message hidden from
  // assistive tech, since the live region already exposes it) that holds the
  // buttons. Live regions are exempt from the inert background behind an open
  // modal (use-modal-focus.ts), so a button inside one would stay reachable
  // behind it.
  return (
    <>
      <div id={warningId} role="alert" className="sr-only">
        {persistentWarning}
      </div>
      {persistentWarning ? (
        <div className="tp-notice-in flex items-start gap-3 rounded-[22px] border tone-warning px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span aria-hidden="true">{persistentWarning}</span>
            {persistentAction ? (
              <div className="mt-2">
                <Button type="button" size="sm" variant="secondary" onClick={persistentAction.onClick} aria-describedby={warningId}>
                  <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                  {persistentAction.label}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {/* Failed actions: announced assertively and kept until dismissed, so
          they never expire before they have been read. */}
      <div id={errorId} role="alert" className="sr-only">
        {errorNotice}
      </div>
      {errorNotice ? (
        <div className="tp-notice-in flex flex-wrap items-start gap-3 rounded-[22px] border tone-danger px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span aria-hidden="true" className="min-w-0 flex-1 basis-[14rem] wrap-anywhere">{errorNotice}</span>
          {onDismissError ? (
            <Button type="button" size="sm" variant="ghost" onClick={onDismissError} aria-describedby={errorId} className="-my-1 shrink-0">
              <X className="h-4 w-4" aria-hidden="true" />
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      <div id={persistentNoticeId} role="status" aria-live="polite" className="sr-only">
        {persistentNotice}
      </div>
      {persistentNotice ? (
        <div className="tp-notice-in flex flex-wrap items-start gap-3 rounded-[22px] border border-[color:var(--accent)]/15 bg-[color:var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
          <span aria-hidden="true" className="min-w-0 flex-1 basis-[14rem] wrap-anywhere">{persistentNotice}</span>
          {onDismissPersistentNotice ? (
            <Button type="button" size="sm" variant="ghost" onClick={onDismissPersistentNotice} aria-describedby={persistentNoticeId} className="-my-1 shrink-0">
              <X className="h-4 w-4" aria-hidden="true" />
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        role="status"
        aria-live="polite"
        onPointerEnter={onTransientNoticeHold ? () => onTransientNoticeHold("hover", true) : undefined}
        onPointerLeave={onTransientNoticeHold ? () => onTransientNoticeHold("hover", false) : undefined}
        onFocus={onTransientNoticeHold ? () => onTransientNoticeHold("focus", true) : undefined}
        onBlur={onTransientNoticeHold ? () => onTransientNoticeHold("focus", false) : undefined}
        className={
          transientNotice
            ? "tp-notice-in flex items-start gap-3 rounded-[22px] border border-[color:var(--accent)]/15 bg-[color:var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]"
            : "sr-only"
        }
      >
        {transientNotice ? (
          <>
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
            <span>{transientNotice}</span>
          </>
        ) : null}
      </div>
    </>
  );
}
