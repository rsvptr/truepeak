"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { CUSTOM_PRESET_ID, TARGET_PRESETS, type TargetDraftErrors } from "@/audio/presets";
import { DrawerPanel } from "@/components/drawer-panel";
import { PresetDetailPane } from "@/components/preset-detail-pane";
import { PresetListPane } from "@/components/preset-list-pane";
import {
  formatTargetDbtp,
  formatTargetLufs,
  formatToleranceLu,
} from "@/components/preset-taxonomy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TargetPreset } from "@/types/audio";

// Field errors listed in DOM/visual order so the summary and first-error focus
// walk them the same way the eye does.
const ERROR_FIELDS: Array<{ key: keyof TargetDraftErrors; name: string; label: string }> = [
  { key: "customTargetLufs", name: "custom-target-lufs", label: "Loudness Target" },
  { key: "customTruePeak", name: "custom-true-peak", label: "True Peak Limit" },
  { key: "toleranceLufs", name: "target-tolerance", label: "Target Tolerance" },
];

/**
 * Props for the Preset Library drawer.
 *
 * The workbench owns the target state and passes a clean active-vs-draft
 * interface (UX-004): `activeTarget` is the committed target driving verdicts,
 * `draftTarget` is the live preview (null while invalid), and the draft flags
 * gate Apply / Cancel / Reset so an invalid draft never silently takes effect.
 *
 * `initialFocusError` lets the workbench force the open-at-first-error behavior
 * (UX-008). When omitted, the drawer still auto-focuses the first invalid field
 * whenever it opens with a draft that already has errors.
 */
interface PresetLibraryDrawerProps {
  open: boolean;
  onClose: () => void;
  activeTarget: TargetPreset;
  draftTarget: TargetPreset | null;
  fieldErrors?: TargetDraftErrors;
  draftStatusMessage: string | null;
  draftIsValid: boolean;
  draftIsDirty: boolean;
  draftIsModified: boolean;
  selectedPresetId: string;
  toleranceLufs: string;
  customTargetLufs: string;
  customTruePeak: string;
  policy: TargetPreset["policy"];
  initialFocusError?: boolean;
  onSelectPreset: (presetId: string) => void;
  onToleranceChange: (value: string) => void;
  onCustomTargetLufsChange: (value: string) => void;
  onCustomTruePeakChange: (value: string) => void;
  onPolicyChange: (policy: TargetPreset["policy"]) => void;
  onApply: () => void;
  onCancel: () => void;
  onResetToPublished: () => void;
}

export function PresetLibraryDrawer({
  open,
  onClose,
  activeTarget,
  draftTarget,
  fieldErrors,
  draftStatusMessage,
  draftIsValid,
  draftIsDirty,
  draftIsModified,
  selectedPresetId,
  toleranceLufs,
  customTargetLufs,
  customTruePeak,
  policy,
  initialFocusError,
  onSelectPreset,
  onToleranceChange,
  onCustomTargetLufsChange,
  onCustomTruePeakChange,
  onPolicyChange,
  onApply,
  onCancel,
  onResetToPublished,
}: PresetLibraryDrawerProps) {
  // "list" | "detail" only drives the narrow (mobile) two-step flow; at wide
  // container widths CSS shows both panes regardless of this value.
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [focusTick, setFocusTick] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollTopRef = useRef(0);
  const pendingFocusRef = useRef<string | null>(null);
  // Which pane should receive focus after a narrow-layout step change. Switching
  // steps applies display:none to the pane holding the focused control, so
  // without an explicit move focus falls to <body> and the drawer's focus trap
  // sends the next Tab back to Close.
  const pendingStepFocusRef = useRef<"list" | "detail" | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const activeErrors = ERROR_FIELDS.filter((field) => fieldErrors?.[field.key]);
  const hasFieldErrors = activeErrors.length > 0;

  // Keep the newest error/force-focus state in refs so the open effect can read
  // it while depending only on `open` (it must fire once per open, not per edit).
  const shouldFocusOnOpenRef = useRef(false);
  useEffect(() => {
    shouldFocusOnOpenRef.current = hasFieldErrors || Boolean(initialFocusError);
  });

  // First-error focus on open (UX-008). The delay clears DrawerPanel's own
  // initial focus (it focuses Close on a 0ms timer) so the error wins.
  useEffect(() => {
    if (!open) {
      return;
    }
    const focusFirstError = shouldFocusOnOpenRef.current;
    setMobileView(focusFirstError ? "detail" : "list");
    listScrollTopRef.current = 0;
    if (!focusFirstError) {
      return;
    }
    const timer = window.setTimeout(() => {
      const target = rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (target && target.offsetParent !== null) {
        target.focus();
        target.scrollIntoView({ block: "center" });
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Restore the preserved list scroll position when returning to it (mobile).
  useLayoutEffect(() => {
    if (mobileView === "list" && listScrollRef.current) {
      listScrollRef.current.scrollTop = listScrollTopRef.current;
    }
  }, [mobileView]);

  // Move focus to a specific field on request (error-summary links), switching
  // to the detail step first on mobile so the field is actually visible.
  useLayoutEffect(() => {
    const name = pendingFocusRef.current;
    if (!name) {
      return;
    }
    const target = rootRef.current?.querySelector<HTMLElement>(`[name="${name}"]`);
    if (target && target.offsetParent !== null) {
      target.focus();
      target.scrollIntoView({ block: "center" });
      pendingFocusRef.current = null;
    }
  }, [focusTick]);

  // Land focus on the pane a step change just revealed.
  useLayoutEffect(() => {
    const step = pendingStepFocusRef.current;
    if (!step) {
      return;
    }
    const target =
      step === "detail"
        ? detailHeadingRef.current
        : rootRef.current?.querySelector<HTMLElement>(
            `input[name="preset-selection"][value="${CSS.escape(selectedPresetId)}"]`,
          );
    if (target && target.offsetParent !== null) {
      target.focus();
      pendingStepFocusRef.current = null;
    }
  }, [focusTick, selectedPresetId]);

  const requestFieldFocus = (name: string) => {
    pendingFocusRef.current = name;
    setMobileView("detail");
    setFocusTick((tick) => tick + 1);
  };

  const handleSelect = (presetId: string, viaPointer: boolean) => {
    // Preserve list scroll before the row navigates to detail on mobile.
    listScrollTopRef.current = listScrollRef.current?.scrollTop ?? 0;
    onSelectPreset(presetId);
    // Only a pointer activation advances the step. Native radio arrow keys also
    // fire change, and advancing on those hid the pane holding the focused radio
    // on the very first ArrowDown, so the group could not be browsed by keyboard
    // at all. Keyboard users reach the detail step through the explicit button
    // rendered below the list instead.
    if (viaPointer) {
      setMobileView("detail");
    }
  };

  const showDetailStep = () => {
    listScrollTopRef.current = listScrollRef.current?.scrollTop ?? 0;
    pendingStepFocusRef.current = "detail";
    setMobileView("detail");
    setFocusTick((tick) => tick + 1);
  };

  const handleBack = () => {
    pendingStepFocusRef.current = "list";
    setMobileView("list");
    setFocusTick((tick) => tick + 1);
  };

  const selectedPreset = TARGET_PRESETS.find((preset) => preset.id === selectedPresetId);
  const applyLabel =
    selectedPresetId === CUSTOM_PRESET_ID ? "Custom Target" : selectedPreset?.label ?? "Preset";

  const previewNote =
    draftIsDirty && draftIsValid && !hasFieldErrors ? (
      <p className="rounded-2xl border border-[color:var(--accent)]/25 bg-[var(--surface-0)] px-4 py-3 text-sm text-[var(--muted)]">
        Previewing unapplied changes. Apply to use them for this session. The active target stays{" "}
        <span className="font-semibold text-[var(--ink)]">{activeTarget.label}</span>.
      </p>
    ) : null;

  return (
    <DrawerPanel
      open={open}
      onClose={onClose}
      title="Loudness Presets"
      description="Compare published guidance, playback references, and TruePeak recommendations. Apply one to the current session."
      mobileMode="full"
      desktopClassName="lg:w-[min(960px,96vw)]"
    >
      <div ref={rootRef} className="@container flex h-full min-h-0 flex-col overflow-hidden">
        {/* Single compact Active Preset summary (UX-007). */}
        <div className="shrink-0 border-b border-[var(--line)] pb-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-[color:var(--accent)]/20 bg-[color:var(--accent-soft)] px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              Active
            </span>
            <span className="text-sm font-semibold text-[var(--ink)]">{activeTarget.label}</span>
            <span className="text-sm tabular-nums text-[var(--muted)]">
              {formatTargetLufs(activeTarget.loudnessTargetLufs)} ·{" "}
              {formatTargetDbtp(activeTarget.truePeakCeilingDbtp)} ·{" "}
              {formatToleranceLu(activeTarget.toleranceLufs)}
            </span>
            {draftIsDirty ? <Badge className="tone-info">Unapplied draft</Badge> : null}
          </div>
        </div>

        {/* Error summary near the top (UX-008); role=alert announces the issue. */}
        {hasFieldErrors ? (
          <div
            role="alert"
            className="mt-4 shrink-0 rounded-2xl border tone-danger px-4 py-3"
          >
            <div className="text-sm font-semibold">Fix these settings to apply</div>
            {draftStatusMessage ? (
              <p className="mt-1 text-sm leading-6">{draftStatusMessage}</p>
            ) : null}
            <ul className="mt-2 space-y-1">
              {activeErrors.map((field) => (
                <li key={field.key}>
                  <button
                    type="button"
                    onClick={() => requestFieldFocus(field.name)}
                    className="text-left text-sm underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)]"
                  >
                    {field.label}: {fieldErrors?.[field.key]}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Mobile-only back affordance; hidden once the master/detail layout kicks in. */}
        {mobileView === "detail" ? (
          <div className="mt-4 shrink-0 @[46rem]:hidden">
            <button
              type="button"
              onClick={handleBack}
              className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-2 py-1 text-sm font-semibold text-[var(--accent-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              All presets
            </button>
          </div>
        ) : null}

        {/* Master / detail. Container-query driven, never viewport (UX-002). */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col @[46rem]:flex-row @[46rem]:gap-5">
          <PresetListPane
            selectedPresetId={selectedPresetId}
            onSelect={handleSelect}
            scrollRef={listScrollRef}
            className={cn(
              "min-h-0 flex-1 @[46rem]:w-80 @[46rem]:flex-none",
              mobileView === "detail" ? "hidden @[46rem]:block" : "block",
            )}
          />
          <PresetDetailPane
            selectedPresetId={selectedPresetId}
            toleranceLufs={toleranceLufs}
            customTargetLufs={customTargetLufs}
            customTruePeak={customTruePeak}
            policy={policy}
            fieldErrors={fieldErrors}
            draftIsModified={draftIsModified}
            onToleranceChange={onToleranceChange}
            onCustomTargetLufsChange={onCustomTargetLufsChange}
            onCustomTruePeakChange={onCustomTruePeakChange}
            onPolicyChange={onPolicyChange}
            onResetToPublished={onResetToPublished}
            headingRef={detailHeadingRef}
            className={cn(
              "min-h-0 flex-1",
              mobileView === "list" ? "hidden @[46rem]:block" : "block",
            )}
          />
        </div>

        {/* Keyboard (and any non-pointer) route into the detail step. Selecting
            with the arrow keys deliberately stays on the list, so without this
            the detail pane would be unreachable below 46rem. Hidden once both
            panes are on screen together. */}
        {mobileView === "list" ? (
          <div className="mt-3 shrink-0 @[46rem]:hidden">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={showDetailStep}
              className="w-full justify-center"
            >
              Open {applyLabel} settings
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}

        {/* Polite status region for the valid-but-unapplied preview (UX-004). */}
        <div aria-live="polite" className="shrink-0 empty:hidden">
          {previewNote ? <div className="mt-4">{previewNote}</div> : null}
        </div>

        {/* Sticky action footer with safe-area padding (UX redesign). */}
        <div className="mt-4 flex shrink-0 items-center gap-2 border-t border-[var(--line)] pt-4 pb-[max(0px,env(safe-area-inset-bottom))] @[30rem]:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            disabled={!draftIsDirty}
            className="flex-1 @[30rem]:flex-none"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onApply}
            disabled={!draftIsDirty || !draftIsValid}
            className="flex-1 @[30rem]:flex-none"
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            Apply {applyLabel}
          </Button>
        </div>
      </div>
    </DrawerPanel>
  );
}
