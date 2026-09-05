import type { LucideIcon } from "lucide-react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function WorkbenchEmptyState({
  title,
  body,
  icon: Icon,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  icon: LucideIcon;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Card className="p-8 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">
        <Icon className="h-7 w-7" aria-hidden="true" />
      </div>
      <h2 className="mt-5 text-2xl font-semibold text-[var(--ink)]">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{body}</p>
      {actionLabel && onAction ? (
        <Button type="button" size="sm" variant="secondary" onClick={onAction} className="mt-5">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {actionLabel}
        </Button>
      ) : null}
    </Card>
  );
}
