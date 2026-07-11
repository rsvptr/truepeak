"use client";

import { BookOpen, ExternalLink, SlidersHorizontal, Sparkles } from "lucide-react";
import { TARGET_PRESETS } from "@/audio/presets";
import { formatLufs, formatPeakDbtp } from "@/lib/format";
import { evidenceToneClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import type { TargetPreset } from "@/types/audio";
import { DrawerPanel } from "@/components/drawer-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const CUSTOM_ID = "custom";
const PRESET_CATEGORY_LABELS: Record<TargetPreset["category"], string> = {
  platform: "Platform",
  podcast: "Podcast",
  broadcast: "Broadcast",
  hifi: "HiFi",
  custom: "Custom",
};

// Group presets in the category order declared above (not in the order they
// happen to appear in TARGET_PRESETS), and drop empty categories.
const GROUPED_PRESETS = (Object.keys(PRESET_CATEGORY_LABELS) as TargetPreset["category"][])
  .map((category) => ({
    label: PRESET_CATEGORY_LABELS[category],
    presets: TARGET_PRESETS.filter((preset) => preset.category === category),
  }))
  .filter((group) => group.presets.length > 0);

function evidenceLabel(evidence: TargetPreset["evidence"]) {
  switch (evidence) {
    case "official":
      return "Official";
    case "inferred":
      return "Inferred";
    case "custom":
    default:
      return "Custom";
  }
}

interface PresetLibraryDrawerProps {
  open: boolean;
  onClose: () => void;
  currentTarget: TargetPreset;
  fieldErrors?: TargetFieldErrors;
  selectedPresetId: string;
  targetTolerance: string;
  customTargetLufs: string;
  customTruePeak: string;
  customPolicy: TargetPreset["policy"];
  onSelectPreset: (presetId: string) => void;
  onTargetToleranceChange: (value: string) => void;
  onCustomTargetLufsChange: (value: string) => void;
  onCustomTruePeakChange: (value: string) => void;
  onCustomPolicyChange: (policy: TargetPreset["policy"]) => void;
}

export interface TargetFieldErrors {
  targetTolerance?: string;
  customTargetLufs?: string;
  customTruePeak?: string;
}

export function PresetLibraryDrawer({
  open,
  onClose,
  currentTarget,
  fieldErrors,
  selectedPresetId,
  targetTolerance,
  customTargetLufs,
  customTruePeak,
  customPolicy,
  onSelectPreset,
  onTargetToleranceChange,
  onCustomTargetLufsChange,
  onCustomTruePeakChange,
  onCustomPolicyChange,
}: PresetLibraryDrawerProps) {
  const targetToleranceError = fieldErrors?.targetTolerance;
  const customTargetError = fieldErrors?.customTargetLufs;
  const customTruePeakError = fieldErrors?.customTruePeak;

  return (
    <DrawerPanel
      open={open}
      onClose={onClose}
      title="Preset Library"
      description="Choose a preset when you need a delivery reference. The main view stays compact until then."
      mobileMode="full"
      desktopClassName="lg:w-[min(680px,94vw)]"
    >
      <div className="space-y-6">
        <section className="rounded-[24px] border border-[color:var(--accent)]/18 bg-[color:var(--accent-soft)] px-5 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{currentTarget.label}</Badge>
            <Badge className={evidenceToneClass(currentTarget.evidence)}>{evidenceLabel(currentTarget.evidence)}</Badge>
            <Badge className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
              {PRESET_CATEGORY_LABELS[currentTarget.category]}
            </Badge>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--ink)]/84">{currentTarget.description}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Target</div>
              <div className="mt-2 text-xl font-semibold text-[var(--ink)]">{formatLufs(currentTarget.loudnessTargetLufs)}</div>
            </div>
            <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Ceiling</div>
              <div className="mt-2 text-xl font-semibold text-[var(--ink)]">{formatPeakDbtp(currentTarget.truePeakCeilingDbtp)}</div>
            </div>
            <div className="rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Tolerance</div>
              <div className="mt-2 text-xl font-semibold text-[var(--ink)]">±{currentTarget.toleranceLufs.toFixed(2)} LU</div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.02fr)_minmax(250px,0.74fr)]">
          <div className="space-y-6 min-w-0">
            {GROUPED_PRESETS.map((group) => (
              <section key={group.label} className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{group.label}</div>
                  <div className="h-px flex-1 bg-[var(--line)]" />
                </div>
                <div className="space-y-3">
                  {group.presets.map((preset) => {
                    const selected = selectedPresetId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => onSelectPreset(preset.id)}
                        aria-pressed={selected}
                        className={cn(
                          "w-full rounded-[22px] border px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                          selected
                            ? "border-[color:var(--accent)]/35 bg-[color:var(--accent-soft)]"
                            : "border-[var(--line)] bg-[var(--surface-1)] hover:border-[color:var(--accent)]/28",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-base font-semibold text-[var(--ink)]">{preset.label}</div>
                            <div className="mt-1 text-xs leading-5 text-[var(--muted)]">{preset.sourceLabel}</div>
                          </div>
                          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                            {selected ? <Badge className="border-[color:var(--accent)]/30 bg-[color:var(--accent-soft)] text-[var(--accent)]">Selected</Badge> : null}
                            <Badge className={evidenceToneClass(preset.evidence)}>{evidenceLabel(preset.evidence)}</Badge>
                          </div>
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div className="text-sm text-[var(--muted)]">
                            <span className="font-semibold text-[var(--ink)]">{formatLufs(preset.loudnessTargetLufs)}</span>
                            <span className="ml-2">target</span>
                          </div>
                          <div className="text-sm text-[var(--muted)]">
                            <span className="font-semibold text-[var(--ink)]">{formatPeakDbtp(preset.truePeakCeilingDbtp)}</span>
                            <span className="ml-2">ceiling</span>
                          </div>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{preset.description}</p>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}

            <section className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Custom</div>
                <div className="h-px flex-1 bg-[var(--line)]" />
              </div>
              <button
                type="button"
                onClick={() => onSelectPreset(CUSTOM_ID)}
                aria-pressed={selectedPresetId === CUSTOM_ID}
                className={cn(
                  "w-full rounded-[22px] border px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                  selectedPresetId === CUSTOM_ID
                    ? "border-[color:var(--accent)]/35 bg-[color:var(--accent-soft)]"
                    : "border-[var(--line)] bg-[var(--surface-1)] hover:border-[color:var(--accent)]/28",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-[var(--ink)]">Custom preset</div>
                    <div className="mt-1 text-xs leading-5 text-[var(--muted)]">Manual target</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                    {selectedPresetId === CUSTOM_ID ? <Badge className="border-[color:var(--accent)]/30 bg-[color:var(--accent-soft)] text-[var(--accent)]">Selected</Badge> : null}
                    <Badge className={evidenceToneClass("custom")}>Custom</Badge>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                  Use this when you already know the loudness target and true-peak ceiling you need.
                </p>
              </button>
            </section>
          </div>

          <aside className="space-y-4 xl:sticky xl:top-0 self-start">
            <section className="rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                <Sparkles className="h-4 w-4 text-[var(--accent)]" />
                Current preset
              </div>
              <h3 className="mt-3 text-lg font-semibold text-[var(--ink)]">{currentTarget.label}</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {currentTarget.highlights.map((highlight) => (
                  <Badge key={highlight} className="border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                    {highlight}
                  </Badge>
                ))}
              </div>
            </section>

            <section className="rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                <BookOpen className="h-4 w-4 text-[var(--accent)]" />
                Reference note
              </div>
              <div className="mt-3 text-sm leading-6 text-[var(--muted)]">{currentTarget.referenceNote}</div>
              {currentTarget.referenceUrl ? (
                <a
                  href={currentTarget.referenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface-0)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Open Reference
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
            </section>

            <section className="rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                <SlidersHorizontal className="h-4 w-4 text-[var(--accent)]" />
                Session settings
              </div>
              <label className="mt-4 block text-sm text-[var(--muted)]">
                <span className="mb-2 block text-[11px] uppercase tracking-[0.18em]">Tolerance</span>
                <input
                  aria-label="Tolerance window in LU"
                  aria-describedby={targetToleranceError ? "target-tolerance-error" : undefined}
                  aria-invalid={!!targetToleranceError}
                  value={targetTolerance}
                  onChange={(event) => onTargetToleranceChange(event.target.value)}
                  type="number"
                  step="0.1"
                  min="0.1"
                  className={cn(
                    "w-full rounded-2xl border bg-[var(--surface-0)] px-4 py-3 text-[var(--ink)] outline-none transition focus:border-[var(--accent)]",
                    targetToleranceError ? "border-[var(--danger)]" : "border-[var(--line)]",
                  )}
                />
                {targetToleranceError ? (
                  <span id="target-tolerance-error" className="mt-2 block text-xs leading-5 text-[var(--danger)]">
                    {targetToleranceError}
                  </span>
                ) : null}
              </label>
              {selectedPresetId === CUSTOM_ID ? (
                <div className="mt-4 space-y-4 rounded-[20px] border border-[var(--line)] bg-[var(--surface-0)] p-4">
                  <label className="block text-sm text-[var(--muted)]">
                    <span className="mb-2 block text-[11px] uppercase tracking-[0.18em]">Target loudness</span>
                    <input
                      aria-label="Custom target loudness in LUFS"
                      aria-describedby={customTargetError ? "custom-target-lufs-error" : undefined}
                      aria-invalid={!!customTargetError}
                      value={customTargetLufs}
                      onChange={(event) => onCustomTargetLufsChange(event.target.value)}
                      type="number"
                      step="0.1"
                      className={cn(
                        "w-full rounded-2xl border bg-[var(--surface-1)] px-4 py-3 text-[var(--ink)] outline-none transition focus:border-[var(--accent)]",
                        customTargetError ? "border-[var(--danger)]" : "border-[var(--line)]",
                      )}
                    />
                    {customTargetError ? (
                      <span id="custom-target-lufs-error" className="mt-2 block text-xs leading-5 text-[var(--danger)]">
                        {customTargetError}
                      </span>
                    ) : null}
                  </label>
                  <label className="block text-sm text-[var(--muted)]">
                    <span className="mb-2 block text-[11px] uppercase tracking-[0.18em]">True-peak ceiling</span>
                    <input
                      aria-label="Custom true peak ceiling in dBTP"
                      aria-describedby={customTruePeakError ? "custom-true-peak-error" : undefined}
                      aria-invalid={!!customTruePeakError}
                      value={customTruePeak}
                      onChange={(event) => onCustomTruePeakChange(event.target.value)}
                      type="number"
                      step="0.1"
                      className={cn(
                        "w-full rounded-2xl border bg-[var(--surface-1)] px-4 py-3 text-[var(--ink)] outline-none transition focus:border-[var(--accent)]",
                        customTruePeakError ? "border-[var(--danger)]" : "border-[var(--line)]",
                      )}
                    />
                    {customTruePeakError ? (
                      <span id="custom-true-peak-error" className="mt-2 block text-xs leading-5 text-[var(--danger)]">
                        {customTruePeakError}
                      </span>
                    ) : null}
                  </label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button type="button" size="sm" variant={customPolicy === "protect-true-peak" ? "primary" : "secondary"} aria-pressed={customPolicy === "protect-true-peak"} onClick={() => onCustomPolicyChange("protect-true-peak")}>
                      Protect ceiling
                    </Button>
                    <Button type="button" size="sm" variant={customPolicy === "loudness-first" ? "primary" : "secondary"} aria-pressed={customPolicy === "loudness-first"} onClick={() => onCustomPolicyChange("loudness-first")}>
                      Hit target
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          </aside>
        </div>
      </div>
    </DrawerPanel>
  );
}

















