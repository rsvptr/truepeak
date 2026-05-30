import type { ComplianceState } from "@/audio/compliance";
import type { AnalysisJob, TargetPreset } from "@/types/audio";

/**
 * Centralized, theme-aware status tones. These return the semantic `.tone-*`
 * utility classes defined in globals.css (which mix their colors from CSS
 * variables, so they stay legible in both light and dark themes). Previously
 * every component carried its own copy of these switch statements using
 * hardcoded Tailwind palette colors (emerald-300, sky-300, …) that washed out
 * on light backgrounds.
 */

/** Tone for a queue job's lifecycle status. */
export function statusToneClass(status: AnalysisJob["status"]): string {
  switch (status) {
    case "complete":
      return "tone-success";
    case "failed":
      return "tone-danger";
    case "canceled":
      return "tone-neutral";
    case "analyzing":
    case "decoding":
    case "reading":
      return "tone-warning";
    default:
      return "tone-neutral";
  }
}

/** Tone for a target-compliance verdict. */
export function complianceToneClass(state: ComplianceState): string {
  switch (state) {
    case "on-target":
      return "tone-success";
    case "below-target":
      return "tone-info";
    case "above-target":
      return "tone-danger";
    case "ceiling-limited":
    default:
      return "tone-warning";
  }
}

/** Tone for a preset's evidence/provenance badge. */
export function evidenceToneClass(evidence: TargetPreset["evidence"]): string {
  switch (evidence) {
    case "official":
      return "tone-success";
    case "inferred":
      return "tone-info";
    case "custom":
    default:
      return "tone-neutral";
  }
}

/**
 * Text color for a signed delta against a target: on-target (≈0) reads as
 * success, hotter-than-target as danger, quieter-than-target as info.
 */
export function deltaToneClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.05) {
    return "text-[var(--success)]";
  }

  return value > 0 ? "text-[var(--danger)]" : "text-[var(--info)]";
}
