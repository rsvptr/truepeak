"use client";

import { useRef, type Ref } from "react";
import { CUSTOM_PRESET_ID } from "@/audio/presets";
import { Badge } from "@/components/ui/badge";
import {
  GROUPED_PRESETS,
  PLAYBACK_REFERENCE_TAG,
  PRESET_PURPOSE_BLURB,
  PRESET_PURPOSE_LABEL,
  formatTargetDbtp,
  formatTargetLufs,
  isPlaybackReference,
  provenanceLabel,
  provenanceToneClass,
} from "@/components/preset-taxonomy";
import { cn } from "@/lib/utils";
import type { TargetPreset } from "@/types/audio";

// One shared radio-group name so every preset row (including Custom) forms a
// single exclusive selection with native arrow-key navigation and one Tab stop
// (UX-021). Category context comes from the real <fieldset>/<legend> wrappers.
const PRESET_RADIO_GROUP = "preset-selection";

interface PresetRowProps {
  id: string;
  label: string;
  selected: boolean;
  onSelect: (presetId: string) => void;
  onPointerActivate: () => void;
  provenance: string;
  provenanceTone: string;
  sourceLabel?: string;
  stats?: string;
  blurb?: string;
  playback?: boolean;
}

function PresetRow({
  id,
  label,
  selected,
  onSelect,
  onPointerActivate,
  provenance,
  provenanceTone,
  sourceLabel,
  stats,
  blurb,
  playback,
}: PresetRowProps) {
  return (
    <label
      // Only pointerdown sets the flag. Clicking a <label> runs its activation
      // behaviour AFTER the click event finishes propagating, so the order is
      // pointerdown -> click (label) -> click (input) -> change: clearing the
      // flag on click would clear it before onChange ever reads it, and every
      // tap would look like a keyboard selection. The flag is consumed and
      // cleared inside handleSelect instead, and a keydown on the list clears it
      // so a click on an already-selected row (which fires no change) cannot
      // leave it set for a later arrow key.
      onPointerDown={onPointerActivate}
      className={cn(
        "flex cursor-pointer gap-3 rounded-2xl border p-3 transition",
        "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--surface-1)]",
        selected
          ? "border-[color:var(--accent)]/45 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)] bg-[var(--surface-1)] hover:border-[color:var(--accent)]/30",
      )}
    >
      <input
        type="radio"
        name={PRESET_RADIO_GROUP}
        value={id}
        checked={selected}
        onChange={() => onSelect(id)}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent-strong)] focus-visible:outline-none"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-[var(--ink)]">{label}</span>
        {sourceLabel ? (
          <span className="mt-0.5 block text-xs leading-5 text-[var(--muted)]">{sourceLabel}</span>
        ) : null}
        {blurb ? (
          <span className="mt-0.5 block text-xs leading-5 text-[var(--muted)]">{blurb}</span>
        ) : null}
        {stats ? (
          <span className="mt-1.5 block text-sm tabular-nums text-[var(--ink)]">{stats}</span>
        ) : null}
        {/* Badges below the title so they never squeeze the name on narrow
            containers (UX-030). */}
        <span className="mt-2 flex flex-wrap gap-1.5">
          <Badge className={provenanceTone}>{provenance}</Badge>
          {playback ? (
            <Badge className="tone-warning">{PLAYBACK_REFERENCE_TAG}</Badge>
          ) : null}
        </span>
      </span>
    </label>
  );
}

interface PresetListPaneProps {
  selectedPresetId: string;
  /**
   * `viaPointer` is false for native radio arrow-key navigation. The narrow
   * master/detail flow must not navigate away from the list on those, or the
   * group becomes unusable by keyboard: hiding the list pane display:none's the
   * radio that currently holds focus.
   */
  onSelect: (presetId: string, viaPointer: boolean) => void;
  /** Ref to the scroll container so the mobile flow can preserve list position. */
  scrollRef: Ref<HTMLDivElement>;
  className?: string;
}

/**
 * The master list: published presets grouped by purpose (UX-005) as real
 * radio-card fieldsets (UX-021), plus a synthetic Custom row. Compact rows
 * (name, source, target/limit, provenance) with descriptions moved to the
 * detail pane so the list stays scannable (UX-006/UX-007).
 */
export function PresetListPane({ selectedPresetId, onSelect, scrollRef, className }: PresetListPaneProps) {
  const pointerSelectRef = useRef(false);
  const handleSelect = (presetId: string) => {
    const viaPointer = pointerSelectRef.current;
    pointerSelectRef.current = false;
    onSelect(presetId, viaPointer);
  };
  const markPointer = () => {
    pointerSelectRef.current = true;
  };
  const clearPointer = () => {
    pointerSelectRef.current = false;
  };

  return (
    <div
      ref={scrollRef}
      onKeyDown={clearPointer}
      className={cn("min-w-0 space-y-5 overflow-y-auto overscroll-contain pr-1", className)}
    >
      {GROUPED_PRESETS.map((group) => (
        <fieldset key={group.purpose} className="min-w-0 border-0 p-0">
          <legend className="mb-1 flex w-full items-center gap-3 p-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
            {group.label}
          </legend>
          <p className="mb-2.5 text-xs leading-5 text-[var(--muted)]">{group.blurb}</p>
          <div className="space-y-2.5">
            {group.presets.map((preset: TargetPreset) => (
              <PresetRow
                key={preset.id}
                id={preset.id}
                label={preset.label}
                selected={selectedPresetId === preset.id}
                onSelect={handleSelect}
                onPointerActivate={markPointer}
                provenance={provenanceLabel(preset.evidence)}
                provenanceTone={provenanceToneClass(preset.evidence)}
                sourceLabel={preset.sourceLabel}
                stats={`${formatTargetLufs(preset.loudnessTargetLufs)} · ${formatTargetDbtp(preset.truePeakCeilingDbtp)}`}
                playback={isPlaybackReference(preset)}
              />
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="min-w-0 border-0 p-0">
        <legend className="mb-1 flex w-full items-center gap-3 p-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
          {PRESET_PURPOSE_LABEL.custom}
        </legend>
        <p className="mb-2.5 text-xs leading-5 text-[var(--muted)]">{PRESET_PURPOSE_BLURB.custom}</p>
        <div className="space-y-2.5">
          <PresetRow
            id={CUSTOM_PRESET_ID}
            label="Custom Target"
            selected={selectedPresetId === CUSTOM_PRESET_ID}
            onSelect={handleSelect}
            onPointerActivate={markPointer}
            provenance={provenanceLabel("custom")}
            provenanceTone={provenanceToneClass("custom")}
            blurb="Set your own loudness target and true peak limit."
          />
        </div>
      </fieldset>
    </div>
  );
}
