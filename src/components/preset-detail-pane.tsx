"use client";

import type { FormEvent, Ref } from "react";
import { AlertTriangle, BookOpen, ExternalLink, Info, RotateCcw } from "lucide-react";
import {
  CUSTOM_PRESET_ID,
  GAIN_POLICIES,
  GAIN_POLICY_LEGEND,
  LOUDNESS_TARGET_RANGE,
  TARGET_PRESETS,
  TOLERANCE_RANGE,
  TRUE_PEAK_LIMIT_RANGE,
  describeGainPolicy,
  gainPolicyDefinition,
  parseTargetNumber,
  type TargetDraftErrors,
} from "@/audio/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PLAYBACK_REFERENCE_DETAIL,
  PLAYBACK_REFERENCE_NOTE,
  formatTargetDbtp,
  formatTargetLufs,
  isPlaybackReference,
  provenanceLabel,
  provenanceToneClass,
} from "@/components/preset-taxonomy";
import { cn } from "@/lib/utils";
import type { TargetPreset } from "@/types/audio";

const CUSTOM_DESCRIPTION =
  "Use this when you already know the loudness target and true peak limit you need: a client, label, or distributor spec the preset library does not cover.";

/**
 * Id of the detail pane's `<form>`. The drawer footer's Apply button lives
 * outside this component (in PresetLibraryDrawer) and submits the form via
 * the HTML `form` attribute rather than nesting, so Enter in a field and a
 * click on Apply both go through the same submit handler (UX-09).
 */
export const PRESET_TARGET_FORM_ID = "preset-target-form";

/** The three numeric draft fields that carry per-keystroke validation. */
export type TargetFieldKey = Exclude<keyof TargetDraftErrors, "preset">;

interface NumberFieldProps {
  id: string;
  name: string;
  label: string;
  unit: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  min: number;
  max: number;
  error?: string;
  surface: "surface-0" | "surface-1";
  /** Signed fields (negative values allowed) must not use the decimal keypad
      on iOS: it has no minus key (MOB-01). */
  signed?: boolean;
}

function NumberField({
  id,
  name,
  label,
  unit,
  ariaLabel,
  value,
  onChange,
  onBlur,
  min,
  max,
  error,
  surface,
  signed,
}: NumberFieldProps) {
  const errorId = `${id}-error`;
  return (
    <label className="block text-sm text-[var(--muted)]">
      <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em]">{label}</span>
      <span className="relative block">
        <input
          id={id}
          name={name}
          autoComplete="off"
          inputMode={signed ? undefined : "decimal"}
          aria-label={ariaLabel}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => {
            // Enter should submit the detail form (UX-09). The footer's Apply
            // button submits this form via the HTML `form` attribute rather
            // than DOM nesting (see PRESET_TARGET_FORM_ID), and browsers do
            // not reliably treat an externally-associated button as the
            // form's default button for implicit Enter submission, so submit
            // explicitly instead of relying on that.
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          type="number"
          step="0.1"
          min={min}
          max={max}
          className={cn(
            "w-full rounded-2xl border px-4 py-3 pr-16 tabular-nums text-[var(--ink)] outline-none transition",
            "focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            surface === "surface-0" ? "bg-[var(--surface-0)]" : "bg-[var(--surface-1)]",
            error ? "border-[var(--danger)]" : "border-[var(--control-line)]",
          )}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm text-[var(--muted)]"
        >
          {unit}
        </span>
      </span>
      {error ? (
        <span id={errorId} className="mt-2 block text-xs leading-5 text-[var(--danger)]">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-1.5 text-lg font-semibold tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

function ViewSourceLink({ url, sourceLabel }: { url: string; sourceLabel: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface-0)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]"
    >
      View {sourceLabel}
      <span className="sr-only"> (opens in a new tab)</span>
      <ExternalLink className="h-4 w-4" aria-hidden="true" />
    </a>
  );
}

interface PresetDetailPaneProps {
  selectedPresetId: string;
  toleranceLufs: string;
  customTargetLufs: string;
  customTruePeak: string;
  policy: TargetPreset["policy"];
  fieldErrors?: TargetDraftErrors;
  draftIsModified: boolean;
  /** Fields the user has blurred at least once (UX-02): gates error display. */
  touchedFields: Partial<Record<TargetFieldKey, boolean>>;
  /** True after an Apply attempt; reveals every field's error regardless of touch. */
  showAllErrors: boolean;
  onToleranceChange: (value: string) => void;
  onCustomTargetLufsChange: (value: string) => void;
  onCustomTruePeakChange: (value: string) => void;
  onPolicyChange: (policy: TargetPreset["policy"]) => void;
  onFieldBlur: (field: TargetFieldKey) => void;
  onResetToPublished: () => void;
  /** Submit handler for the detail form (UX-09): Enter in a field or the
      footer's Apply button (associated via PRESET_TARGET_FORM_ID) both land
      here. */
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Focus target for the narrow master/detail step change. */
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
}

/**
 * The detail pane: the selected preset's description, source, target settings,
 * gain strategy and warnings. Published presets show read-only target/limit
 * tiles plus an editable tolerance; Custom shows the full manual editor and the
 * gain-strategy radiogroup. All internal layout responds to this pane's own
 * container width (never the viewport), so nothing clips at any drawer size
 * (UX-002).
 */
export function PresetDetailPane({
  selectedPresetId,
  toleranceLufs,
  customTargetLufs,
  customTruePeak,
  policy,
  fieldErrors,
  draftIsModified,
  touchedFields,
  showAllErrors,
  onToleranceChange,
  onCustomTargetLufsChange,
  onCustomTruePeakChange,
  onPolicyChange,
  onFieldBlur,
  onResetToPublished,
  onSubmit,
  headingRef,
  className,
}: PresetDetailPaneProps) {
  const isCustom = selectedPresetId === CUSTOM_PRESET_ID;
  const preset = isCustom ? null : TARGET_PRESETS.find((item) => item.id === selectedPresetId);
  // Only a touched field or an Apply attempt shows its error text/aria-invalid
  // (UX-02); resolveDraftTarget still runs live for the Apply button's gate.
  const showError = (field: TargetFieldKey) => showAllErrors || Boolean(touchedFields[field]);

  const evidence: TargetPreset["evidence"] = preset?.evidence ?? "custom";
  const playback = preset ? isPlaybackReference(preset) : false;

  // Effective gain policy for display: published presets carry their own fixed
  // policy; custom uses the editable draft policy.
  const effectivePolicy: TargetPreset["policy"] = preset ? preset.policy : policy;
  const consequenceValues = {
    loudnessTargetLufs: preset
      ? preset.loudnessTargetLufs
      : parseTargetNumber(customTargetLufs) ?? LOUDNESS_TARGET_RANGE.max,
    truePeakCeilingDbtp: preset
      ? preset.truePeakCeilingDbtp
      : parseTargetNumber(customTruePeak) ?? TRUE_PEAK_LIMIT_RANGE.max,
  };

  return (
    <form
      id={PRESET_TARGET_FORM_ID}
      onSubmit={onSubmit}
      noValidate
      className={cn("@container min-w-0 space-y-5 overflow-y-auto overscroll-contain", className)}
    >
      {/* Header: name + provenance + task marker + modified/reset */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {/* tabIndex -1 so the narrow master/detail flow can land focus here
                after the list pane is hidden. Without a focus target the browser
                drops focus to <body> when the previously focused radio is
                display:none'd, and the drawer's focus trap then bounces the next
                Tab back to Close. */}
            <h3
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-semibold text-[var(--ink)] focus:outline-none"
            >
              {preset ? preset.label : "Custom Target"}
            </h3>
          </div>
          {preset && draftIsModified ? (
            <Button type="button" size="sm" variant="ghost" onClick={onResetToPublished}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reset to published
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge className={provenanceToneClass(evidence)}>{provenanceLabel(evidence)}</Badge>
          {playback ? <Badge className="tone-warning">Not a delivery spec</Badge> : null}
          {preset && draftIsModified ? <Badge className="tone-warning">Modified</Badge> : null}
        </div>
        <p className="text-sm leading-6 text-[var(--ink)]/85">
          {preset ? preset.description : CUSTOM_DESCRIPTION}
        </p>
      </div>

      {/* Warnings */}
      {playback ? (
        <div className="flex gap-3 rounded-2xl border tone-warning px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="text-sm leading-6">
            <span className="font-semibold">{PLAYBACK_REFERENCE_NOTE}.</span> {PLAYBACK_REFERENCE_DETAIL}
          </div>
        </div>
      ) : null}
      {effectivePolicy === "loudness-first" ? (
        <div className="flex gap-3 rounded-2xl border tone-info px-4 py-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="text-sm leading-6">
            This target reaches loudness first, so the projected true peak may exceed the limit.
          </div>
        </div>
      ) : null}

      {/* Target settings */}
      <section className="space-y-4 rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
          Target Settings
        </div>

        {isCustom ? (
          <div className="grid gap-3 @[22rem]:grid-cols-2">
            <NumberField
              id="custom-target-lufs"
              name="custom-target-lufs"
              label="Loudness Target"
              unit="LUFS"
              ariaLabel="Custom loudness target in LUFS"
              value={customTargetLufs}
              onChange={onCustomTargetLufsChange}
              onBlur={() => onFieldBlur("customTargetLufs")}
              min={LOUDNESS_TARGET_RANGE.min}
              max={LOUDNESS_TARGET_RANGE.max}
              error={showError("customTargetLufs") ? fieldErrors?.customTargetLufs : undefined}
              surface="surface-0"
              signed
            />
            <NumberField
              id="custom-true-peak"
              name="custom-true-peak"
              label="True Peak Limit"
              unit="dBTP"
              ariaLabel="Custom true peak limit in dBTP"
              value={customTruePeak}
              onChange={onCustomTruePeakChange}
              onBlur={() => onFieldBlur("customTruePeak")}
              min={TRUE_PEAK_LIMIT_RANGE.min}
              max={TRUE_PEAK_LIMIT_RANGE.max}
              error={showError("customTruePeak") ? fieldErrors?.customTruePeak : undefined}
              surface="surface-0"
              signed
            />
          </div>
        ) : preset ? (
          <div className="grid gap-3 @[22rem]:grid-cols-2">
            <StatTile label="Loudness Target" value={formatTargetLufs(preset.loudnessTargetLufs)} />
            <StatTile label="True Peak Limit" value={formatTargetDbtp(preset.truePeakCeilingDbtp)} />
          </div>
        ) : null}

        <NumberField
          id="target-tolerance"
          name="target-tolerance"
          label="Target Tolerance"
          unit="LU"
          ariaLabel="Target tolerance window in LU"
          value={toleranceLufs}
          onChange={onToleranceChange}
          onBlur={() => onFieldBlur("toleranceLufs")}
          min={TOLERANCE_RANGE.min}
          max={TOLERANCE_RANGE.max}
          error={showError("toleranceLufs") ? fieldErrors?.toleranceLufs : undefined}
          surface="surface-0"
        />

        {isCustom ? (
          <fieldset className="space-y-2 border-0 p-0">
            <legend className="mb-1 block p-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              {GAIN_POLICY_LEGEND}
            </legend>
            {GAIN_POLICIES.map((option) => {
              const active = policy === option.value;
              return (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-2xl border p-3 transition",
                    "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--surface-1)]",
                    active
                      ? "border-[color:var(--accent)]/45 bg-[color:var(--accent-soft)]"
                      : "border-[var(--line)] bg-[var(--surface-0)] hover:border-[color:var(--accent)]/30",
                  )}
                >
                  <input
                    type="radio"
                    name="gain-policy"
                    value={option.value}
                    checked={active}
                    onChange={() => onPolicyChange(option.value)}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-strong)] focus-visible:outline-none"
                  />
                  <span className="min-w-0 block">
                    <span className="block text-sm font-semibold text-[var(--ink)]">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[var(--muted)]">
                      {describeGainPolicy(option.value, consequenceValues)}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : (
          <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-0)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
              {GAIN_POLICY_LEGEND}
            </div>
            <div className="mt-1.5 text-sm font-semibold text-[var(--ink)]">
              {gainPolicyDefinition(effectivePolicy).label}
            </div>
            <div className="mt-1 text-xs leading-5 text-[var(--muted)]">
              {describeGainPolicy(effectivePolicy, consequenceValues)}
            </div>
          </div>
        )}
      </section>

      {/* Source / reference */}
      {preset ? (
        <section className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
            <BookOpen className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
            Source
          </div>
          <p className="mt-2.5 text-sm leading-6 text-[var(--muted)]">{preset.referenceNote}</p>
          {preset.referenceUrl ? (
            <ViewSourceLink url={preset.referenceUrl} sourceLabel={preset.sourceLabel} />
          ) : null}
        </section>
      ) : null}
    </form>
  );
}
