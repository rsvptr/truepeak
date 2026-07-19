// Shared, React-free taxonomy + formatting helpers for the Preset Library
// redesign. Kept free of JSX and hooks so it stays a plain logic module that
// both preset-list-pane and preset-detail-pane can import without cycles.
//
// Findings backed here:
//   UX-005  Information architecture by *purpose and provenance*: presets are
//           grouped into Delivery Guidance / Playback References / TruePeak
//           Recommendations / Custom, and the provenance badge is renamed
//           (Official -> Published Guidance, Inferred -> TruePeak Recommendation)
//           while playback modes are explicitly marked "not a delivery spec".
//   UX-030  Whole-number formatting for preset *definitions* (-18 LUFS, not
//           -18.00 LUFS); measured results keep their two-decimal precision
//           elsewhere. Callers pair these strings with `tabular-nums`.
//
// The data model (TargetPreset) does not carry a purpose field, so the grouping
// is derived from `category` + `evidence`. The rule is intentionally tiny;
// scripts/dsp/validate-presets.mjs asserts it against the real TARGET_PRESETS
// so every preset lands in exactly one non-empty group.
import { TARGET_PRESETS } from "@/audio/presets";
import { evidenceToneClass } from "@/lib/status-tone";
import type { TargetPreset } from "@/types/audio";

export type PresetPurpose = "delivery" | "playback" | "recommendation" | "custom";

/**
 * Derive the UX-005 purpose group for a preset from its category/evidence:
 * - broadcast & podcast standards are real delivery requirements;
 * - HiFi and inferred "house" platform presets are TruePeak recommendations;
 * - the remaining published platform presets (Spotify Normal/Loud/Quiet) are
 *   playback-normalization references, not delivery specs.
 */
export function purposeOfPreset(preset: TargetPreset): PresetPurpose {
  switch (preset.category) {
    case "broadcast":
    case "podcast":
      return "delivery";
    case "hifi":
      return "recommendation";
    case "custom":
      return "custom";
    case "platform":
    default:
      return preset.evidence === "inferred" ? "recommendation" : "playback";
  }
}

/** A playback reference describes playback behavior, not a delivery target. */
export function isPlaybackReference(preset: TargetPreset): boolean {
  return purposeOfPreset(preset) === "playback";
}

/** Render order for the published groups (custom is handled separately). */
export const PRESET_PURPOSE_ORDER: readonly PresetPurpose[] = [
  "delivery",
  "playback",
  "recommendation",
  "custom",
];

export const PRESET_PURPOSE_LABEL: Record<PresetPurpose, string> = {
  delivery: "Delivery Guidance",
  playback: "Playback References",
  recommendation: "TruePeak Recommendations",
  custom: "Custom",
};

export const PRESET_PURPOSE_BLURB: Record<PresetPurpose, string> = {
  delivery: "Published delivery requirements for broadcast and podcast.",
  playback: "How platforms normalize playback. References, not delivery targets.",
  recommendation: "TruePeak house references where no platform target is published.",
  custom: "Enter your own loudness target and true peak limit.",
};

export interface PresetGroup {
  purpose: PresetPurpose;
  label: string;
  blurb: string;
  presets: TargetPreset[];
}

// Published presets grouped by purpose, in PRESET_PURPOSE_ORDER, dropping empty
// groups. "custom" is intentionally excluded here: it is a synthetic row the
// drawer renders on its own, not an entry in TARGET_PRESETS.
export const GROUPED_PRESETS: PresetGroup[] = PRESET_PURPOSE_ORDER.filter(
  (purpose) => purpose !== "custom",
)
  .map((purpose) => ({
    purpose,
    label: PRESET_PURPOSE_LABEL[purpose],
    blurb: PRESET_PURPOSE_BLURB[purpose],
    presets: TARGET_PRESETS.filter((preset) => purposeOfPreset(preset) === purpose),
  }))
  .filter((group) => group.presets.length > 0);

/** Renamed provenance label (UX-005). Source authority, kept distinct from purpose. */
export function provenanceLabel(evidence: TargetPreset["evidence"]): string {
  switch (evidence) {
    case "official":
      return "Published Guidance";
    case "inferred":
      return "TruePeak Recommendation";
    case "custom":
    default:
      return "Custom";
  }
}

/** Theme-aware tone class for the provenance badge (reuses the shared tokens). */
export function provenanceToneClass(evidence: TargetPreset["evidence"]): string {
  return evidenceToneClass(evidence);
}

/** Short marker for playback-reference rows. */
export const PLAYBACK_REFERENCE_TAG = "Playback reference";
/** Full clarifying line for the detail pane. */
export const PLAYBACK_REFERENCE_NOTE = "Playback reference, not a delivery spec";
export const PLAYBACK_REFERENCE_DETAIL =
  "These values describe how the platform plays back audio, not a mastering or delivery requirement.";

// ---------------------------------------------------------------------------
// Whole-number formatting for preset definitions (UX-030)
// ---------------------------------------------------------------------------

/**
 * Trim a preset-definition number to a compact string: whole numbers lose their
 * decimals (-18, not -18.00) and fractional tolerances stay readable (0.5).
 * Two-decimal rounding guards float noise; String() drops a stray "-0".
 */
export function trimTargetNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return String(Math.round(value * 100) / 100);
}

export function formatTargetLufs(value: number): string {
  return `${trimTargetNumber(value)} LUFS`;
}

export function formatTargetDbtp(value: number): string {
  return `${trimTargetNumber(value)} dBTP`;
}

export function formatToleranceLu(value: number): string {
  return `±${trimTargetNumber(value)} LU`;
}
