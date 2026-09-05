import { AlertTriangle, Info, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function WorkspaceNotices({
  persistentWarning,
  transientNotice,
  persistentAction,
}: {
  persistentWarning: string | null;
  transientNotice: string | null;
  persistentAction: { label: string; onClick: () => void } | null;
}) {
  return (
    <>
      <div
        role="alert"
        className={
          persistentWarning
            ? "tp-notice-in flex items-start gap-3 rounded-[22px] border tone-warning px-4 py-3 text-sm"
            : "sr-only"
        }
      >
        {persistentWarning ? (
          <>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <span>{persistentWarning}</span>
              {persistentAction ? (
                <div className="mt-2">
                  <Button type="button" size="sm" variant="secondary" onClick={persistentAction.onClick}>
                    <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                    {persistentAction.label}
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <div
        role="status"
        aria-live="polite"
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
