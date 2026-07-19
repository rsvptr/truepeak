import type { TargetPreset } from "@/types/audio";

export const TARGET_PRESETS: TargetPreset[] = [
  {
    id: "streaming-standard",
    label: "Streaming Standard",
    category: "platform",
    evidence: "inferred",
    sourceLabel: "Cross-platform house preset",
    referenceNote:
      "Use this when you do not have service-specific delivery notes. It follows the common streaming convention around -14 LUFS with a -1 dBTP ceiling.",
    highlights: ["Music uploads", "General streaming", "Safe default"],
    loudnessTargetLufs: -14,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Music preset for general streaming releases.",
  },
  {
    id: "spotify-normal",
    label: "Spotify Normal",
    category: "platform",
    evidence: "official",
    sourceLabel: "Spotify loudness normalization",
    referenceUrl: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    referenceNote:
      "Spotify says Normal playback adjusts tracks to -14 LUFS and recommends masters below -1 dBTP, including for lossless playback.",
    highlights: ["Album playback", "Playlist-safe", "Official target"],
    loudnessTargetLufs: -14,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Spotify's published Normal playback target.",
  },
  {
    id: "spotify-loud",
    label: "Spotify Loud",
    category: "platform",
    evidence: "official",
    sourceLabel: "Spotify Premium loud mode",
    referenceUrl: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    referenceNote:
      "Spotify documents a Loud setting at -11 LUFS and notes that playback may use a limiter rather than follow the same peak handling as Normal mode.",
    highlights: ["Noisy environments", "Limiter at playback", "Reference mode"],
    loudnessTargetLufs: -11,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "loudness-first",
    description: "Playback reference for Spotify Loud. Better for comparison than for mastering decisions.",
  },
  {
    id: "spotify-quiet",
    label: "Spotify Quiet",
    category: "platform",
    evidence: "official",
    sourceLabel: "Spotify Premium quiet mode",
    referenceUrl: "https://support.spotify.com/us/artists/article/loudness-normalization/",
    referenceNote:
      "Spotify documents a Quiet playback setting at -19 LUFS across both compressed and lossless playback.",
    highlights: ["Late-night listening", "Quiet environments", "Dynamic playback"],
    loudnessTargetLufs: -19,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Playback reference for quieter listening modes that keep more dynamics.",
  },
  {
    id: "apple-podcasts",
    label: "Apple Podcasts",
    category: "podcast",
    evidence: "official",
    sourceLabel: "Apple Podcasts audio requirements",
    referenceUrl: "https://podcasters.apple.com/support/893-audio-requirements",
    referenceNote:
      "Apple recommends overall loudness around -16 LKFS with +/-1 dB tolerance and true peak not exceeding -1 dBFS. Apple also notes that Sound Check playback uses -16 dB when metadata is present.",
    highlights: ["Speech-first", "Sound Check", "Official guidance"],
    loudnessTargetLufs: -16,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1,
    policy: "protect-true-peak",
    description: "Speech-first podcast preset based on Apple's published guidance.",
  },
  {
    id: "broadcast-ebu",
    label: "Broadcast EBU R128",
    category: "broadcast",
    evidence: "official",
    sourceLabel: "EBU R 128",
    referenceUrl: "https://tech.ebu.ch/publications/r128",
    referenceNote:
      "EBU R 128 recommends an average programme loudness of -23 LUFS, and version 3 tightened the target tolerance to +/-0.5 LU.",
    highlights: ["Europe", "Television", "Tight tolerance"],
    loudnessTargetLufs: -23,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 0.5,
    policy: "protect-true-peak",
    description: "European broadcast preset aligned with EBU R128.",
  },
  {
    id: "broadcast-atsc",
    label: "Broadcast ATSC A/85",
    category: "broadcast",
    evidence: "official",
    sourceLabel: "ATSC A/85",
    referenceUrl: "https://www.atsc.org/wp-content/uploads/2025/06/A85-2013-with-Corrigendum-No-1.pdf",
    referenceNote:
      "ATSC A/85 says content without metadata should target -24 LKFS and keep true peak below -2 dBTP, with small measurement variations anticipated.",
    highlights: ["North America", "Television", "Extra headroom"],
    loudnessTargetLufs: -24,
    truePeakCeilingDbtp: -2,
    toleranceLufs: 2,
    policy: "protect-true-peak",
    description: "North American broadcast preset based on ATSC A/85.",
  },
  {
    id: "hifi-dynamic",
    label: "HiFi Dynamic",
    category: "hifi",
    evidence: "inferred",
    sourceLabel: "Qobuz / TIDAL HiFi listening",
    referenceUrl: "https://help.qobuz.com/en/articles/10127-the-qobuz-experience",
    referenceNote:
      "Qobuz describes HiFi/HD listening and TIDAL documents lossless FLAC and HiRes FLAC tiers, but neither service publishes a loudness target. This is an app-side listening preset rather than a platform requirement.",
    highlights: ["Lossless playback", "Album dynamics", "Inference, not mandate"],
    loudnessTargetLufs: -18,
    truePeakCeilingDbtp: -1,
    toleranceLufs: 1.5,
    policy: "protect-true-peak",
    description: "Lower, more open preset for lossless listening where headroom matters more than level.",
  },
];

export const DEFAULT_TARGET_PRESET = TARGET_PRESETS[0];

// ============================================================================
// Target draft / active-target engine
// ----------------------------------------------------------------------------
// Pure, React-free logic backing the Preset Library workflow. It is exercised
// directly by scripts/dsp/validate-presets.mjs so the correctness-critical
// rules below can be tested without the DOM.
//
// Findings implemented here:
//   UX-001  Atomic preset selection: selecting a published preset loads EVERY
//           stored value (including its tolerance) and commits it, instead of
//           letting a single global tolerance override the preset's own value.
//   UX-004  Active vs draft: `committed` is the applied target that drives
//           compliance verdicts; `draft` is the in-progress edit. Invalid
//           drafts never silently fall back: the active target simply stays
//           active and `draftStatusMessage` reports it.
//   UX-003  Gain-policy metadata: the two policies carry human labels and
//           consequence copy (interpolating the draft's own values) so the
//           drawer can render a proper fieldset.
//   UX-029  Domain ranges: defensible numeric bounds enforced in logic and
//           exported for the UI's min/max.
// ============================================================================

/** Sentinel preset id for a user-defined manual target. */
export const CUSTOM_PRESET_ID = "custom";

/** Two-value gain policy shared with {@link TargetPreset}. */
export type GainPolicy = TargetPreset["policy"];

/**
 * Inclusive numeric range for a target field. `minExclusive` marks bounds that
 * reject the endpoint itself (tolerance must be strictly greater than 0).
 */
export interface TargetFieldRange {
  min: number;
  max: number;
  minExclusive?: boolean;
}

// UX-029: defensible domain ranges. Exported so the drawer inputs can mirror
// them in HTML min/max and so the tests can assert rejection at the edges.
/** Loudness target bounds in LUFS. */
export const LOUDNESS_TARGET_RANGE: TargetFieldRange = { min: -60, max: 0 };
/** True-peak ceiling bounds in dBTP. */
export const TRUE_PEAK_LIMIT_RANGE: TargetFieldRange = { min: -20, max: 3 };
/** Tolerance window bounds in LU. Strictly greater than 0, up to 10. */
export const TOLERANCE_RANGE: TargetFieldRange = { min: 0, max: 10, minExclusive: true };

/**
 * Editable target state. Raw strings mirror the text inputs so an in-progress
 * value can be invalid without destroying what the user typed. Fields map 1:1
 * onto the persisted WorkspaceAnalysisSettings shape.
 */
export interface TargetDraft {
  /** Selected preset id, or {@link CUSTOM_PRESET_ID}. */
  presetId: string;
  /** Manual loudness target (LUFS); only resolved when `presetId` is custom. */
  customTargetLufs: string;
  /** Manual true-peak ceiling (dBTP); only resolved when `presetId` is custom. */
  customTruePeak: string;
  /** Tolerance window (LU); resolved for every preset. */
  toleranceLufs: string;
  /** Manual gain policy; only resolved when `presetId` is custom. */
  policy: GainPolicy;
}

/**
 * Full target workspace state.
 * - `committed` is the last applied draft. It always resolves to a valid target
 *   and is what gets persisted; {@link resolveActiveTarget} turns it into the
 *   active {@link TargetPreset} used for verdicts.
 * - `draft` is the live edit shown in the drawer.
 */
export interface TargetWorkspaceState {
  draft: TargetDraft;
  committed: TargetDraft;
}

/** Per-field validation messages for the draft inputs. */
export interface TargetDraftErrors {
  toleranceLufs?: string;
  customTargetLufs?: string;
  customTruePeak?: string;
  /** Non-field error (e.g. an unknown preset id from tampered storage). */
  preset?: string;
}

/** Outcome of resolving a draft into a concrete target. */
export interface TargetDraftResolution {
  /** The resolved target, or null when the draft is invalid. */
  target: TargetPreset | null;
  errors: TargetDraftErrors;
  isValid: boolean;
  /** First field error, for inline display; null when valid. */
  message: string | null;
}

/** Serializable subset that maps onto WorkspaceAnalysisSettings. */
export interface StoredTargetSettings {
  selectedPresetId: string;
  customTargetLufs: string;
  customTruePeak: string;
  targetTolerance: string;
  customPolicy: GainPolicy;
}

/**
 * Parse a user-entered numeric field. Empty/whitespace and non-finite input
 * (including NaN and +/-Infinity) resolve to null so callers can distinguish
 * "not a number" from a legitimate 0.
 */
export function parseTargetNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

// Compact string for a numeric field: trims trailing zeros so preset constants
// read as "-14"/"0.5", not "-14.00". Two-decimal rounding guards float noise.
function formatDraftNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function withinRange(value: number, range: TargetFieldRange): boolean {
  const aboveMin = range.minExclusive ? value > range.min : value >= range.min;
  return aboveMin && value <= range.max;
}

function knownPresetId(presetId: string): boolean {
  return presetId === CUSTOM_PRESET_ID || TARGET_PRESETS.some((preset) => preset.id === presetId);
}

function targetsEqual(a: TargetPreset, b: TargetPreset): boolean {
  return (
    a.id === b.id &&
    a.loudnessTargetLufs === b.loudnessTargetLufs &&
    a.truePeakCeilingDbtp === b.truePeakCeilingDbtp &&
    a.toleranceLufs === b.toleranceLufs &&
    a.policy === b.policy
  );
}

// ---------------------------------------------------------------------------
// Gain-policy metadata (UX-003)
// ---------------------------------------------------------------------------

/** Legend for the gain-policy radio fieldset. */
export const GAIN_POLICY_LEGEND = "When loudness and peak limits conflict";

/** Values interpolated into a policy's consequence copy. */
export interface GainPolicyConsequenceValues {
  loudnessTargetLufs: number;
  truePeakCeilingDbtp: number;
}

/** A selectable gain policy plus the copy that explains its trade-off. */
export interface GainPolicyDefinition {
  value: GainPolicy;
  label: string;
  /** Consequence sentence shown before selection, using the draft's values. */
  describeConsequence: (values: GainPolicyConsequenceValues) => string;
}

function lufsLabel(value: number): string {
  return `${formatDraftNumber(value)} LUFS`;
}

function dbtpLabel(value: number): string {
  return `${formatDraftNumber(value)} dBTP`;
}

export const GAIN_POLICIES: readonly GainPolicyDefinition[] = [
  {
    value: "protect-true-peak",
    label: "Respect Peak Limit",
    describeConsequence: ({ loudnessTargetLufs, truePeakCeilingDbtp }) =>
      `Caps suggested gain at ${dbtpLabel(truePeakCeilingDbtp)}. Loudness may remain below ${lufsLabel(loudnessTargetLufs)}.`,
  },
  {
    value: "loudness-first",
    label: "Reach Loudness Target",
    describeConsequence: ({ loudnessTargetLufs, truePeakCeilingDbtp }) =>
      `Applies the full gain needed for ${lufsLabel(loudnessTargetLufs)}. Projected true peak may exceed ${dbtpLabel(truePeakCeilingDbtp)}.`,
  },
];

/** Look up a policy definition, defaulting to peak-protection. */
export function gainPolicyDefinition(policy: GainPolicy): GainPolicyDefinition {
  return GAIN_POLICIES.find((option) => option.value === policy) ?? GAIN_POLICIES[0];
}

/** Consequence copy for a policy given the current draft values. */
export function describeGainPolicy(policy: GainPolicy, values: GainPolicyConsequenceValues): string {
  return gainPolicyDefinition(policy).describeConsequence(values);
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function validateTolerance(value: string): string | undefined {
  const parsed = parseTargetNumber(value);
  if (parsed == null) {
    return "Enter a tolerance in LU.";
  }
  if (parsed <= TOLERANCE_RANGE.min) {
    return `Enter a tolerance greater than ${TOLERANCE_RANGE.min} LU.`;
  }
  if (parsed > TOLERANCE_RANGE.max) {
    return `Enter a tolerance of ${TOLERANCE_RANGE.max} LU or less.`;
  }
  return undefined;
}

function validateLoudnessTarget(value: string): string | undefined {
  const parsed = parseTargetNumber(value);
  if (parsed == null) {
    return "Enter a numeric LUFS target.";
  }
  if (!withinRange(parsed, LOUDNESS_TARGET_RANGE)) {
    return `Enter a target between ${LOUDNESS_TARGET_RANGE.min} and ${LOUDNESS_TARGET_RANGE.max} LUFS.`;
  }
  return undefined;
}

function validateTruePeak(value: string): string | undefined {
  const parsed = parseTargetNumber(value);
  if (parsed == null) {
    return "Enter a numeric dBTP ceiling.";
  }
  if (!withinRange(parsed, TRUE_PEAK_LIMIT_RANGE)) {
    return `Enter a ceiling between ${TRUE_PEAK_LIMIT_RANGE.min} and +${TRUE_PEAK_LIMIT_RANGE.max} dBTP.`;
  }
  return undefined;
}

function buildCustomTarget(
  loudnessTargetLufs: number,
  truePeakCeilingDbtp: number,
  toleranceLufs: number,
  policy: GainPolicy,
): TargetPreset {
  return {
    id: CUSTOM_PRESET_ID,
    label: "Custom",
    category: "custom",
    evidence: "custom",
    sourceLabel: "Manual target",
    referenceNote:
      "Use this when you already have a client, label, or distributor specification that is not covered by the preset library.",
    highlights: ["Manual spec", "Session-specific", "User-defined"],
    loudnessTargetLufs,
    truePeakCeilingDbtp,
    toleranceLufs,
    policy,
    description:
      policy === "protect-true-peak"
        ? "Manual target that holds the true peak ceiling when planning normalization gain."
        : "Manual target that prioritizes hitting loudness even if headroom is exceeded.",
  };
}

function finalizeResolution(errors: TargetDraftErrors, target: TargetPreset | null): TargetDraftResolution {
  const message =
    errors.toleranceLufs ?? errors.customTargetLufs ?? errors.customTruePeak ?? errors.preset ?? null;
  return { target, errors, isValid: target != null && message == null, message };
}

/**
 * Resolve a draft into a concrete {@link TargetPreset}. Tolerance is validated
 * for every preset (UX-001 makes it part of the target); published presets take
 * their target/ceiling/policy from the stored definition, while custom targets
 * validate all three numeric fields against the domain ranges (UX-029).
 */
export function resolveDraftTarget(draft: TargetDraft): TargetDraftResolution {
  const errors: TargetDraftErrors = {};

  const toleranceError = validateTolerance(draft.toleranceLufs);
  if (toleranceError) {
    errors.toleranceLufs = toleranceError;
  }

  if (draft.presetId !== CUSTOM_PRESET_ID) {
    const base = TARGET_PRESETS.find((preset) => preset.id === draft.presetId);
    if (!base) {
      errors.preset = "Select a preset to continue.";
      return finalizeResolution(errors, null);
    }
    const tolerance = parseTargetNumber(draft.toleranceLufs);
    if (errors.toleranceLufs || tolerance == null) {
      return finalizeResolution(errors, null);
    }
    return finalizeResolution(errors, { ...base, toleranceLufs: tolerance });
  }

  const targetError = validateLoudnessTarget(draft.customTargetLufs);
  if (targetError) {
    errors.customTargetLufs = targetError;
  }
  const truePeakError = validateTruePeak(draft.customTruePeak);
  if (truePeakError) {
    errors.customTruePeak = truePeakError;
  }

  const loudness = parseTargetNumber(draft.customTargetLufs);
  const truePeak = parseTargetNumber(draft.customTruePeak);
  const tolerance = parseTargetNumber(draft.toleranceLufs);
  if (
    errors.toleranceLufs ||
    errors.customTargetLufs ||
    errors.customTruePeak ||
    loudness == null ||
    truePeak == null ||
    tolerance == null
  ) {
    return finalizeResolution(errors, null);
  }
  return finalizeResolution(errors, buildCustomTarget(loudness, truePeak, tolerance, draft.policy));
}

/** The active target used for verdicts, derived from the committed draft. */
export function resolveActiveTarget(committed: TargetDraft): TargetPreset {
  return resolveDraftTarget(committed).target ?? { ...DEFAULT_TARGET_PRESET };
}

// ---------------------------------------------------------------------------
// State construction & persistence mapping
// ---------------------------------------------------------------------------

/** A fresh draft seeded from the default preset. */
export function createDefaultDraft(): TargetDraft {
  return {
    presetId: DEFAULT_TARGET_PRESET.id,
    customTargetLufs: "-14",
    customTruePeak: "-1",
    toleranceLufs: formatDraftNumber(DEFAULT_TARGET_PRESET.toleranceLufs),
    policy: "protect-true-peak",
  };
}

/** Initial workspace state (draft and committed both the default preset). */
export function createDefaultTargetState(): TargetWorkspaceState {
  const draft = createDefaultDraft();
  return { draft, committed: { ...draft } };
}

/** Build a draft from persisted settings, falling back to the default preset id. */
export function draftFromStoredSettings(stored: StoredTargetSettings): TargetDraft {
  return {
    presetId: knownPresetId(stored.selectedPresetId) ? stored.selectedPresetId : DEFAULT_TARGET_PRESET.id,
    customTargetLufs: stored.customTargetLufs,
    customTruePeak: stored.customTruePeak,
    toleranceLufs: stored.targetTolerance,
    policy: stored.customPolicy,
  };
}

/**
 * Rehydrate workspace state from persisted settings. The stored draft is the
 * last committed target, so it seeds both draft and committed. A stored value
 * that no longer validates (e.g. tampered storage) falls back to the default so
 * the active target is never invalid.
 */
export function stateFromStoredSettings(stored: StoredTargetSettings): TargetWorkspaceState {
  const draft = draftFromStoredSettings(stored);
  if (!resolveDraftTarget(draft).isValid) {
    return createDefaultTargetState();
  }
  return { draft, committed: { ...draft } };
}

/** Serialize the committed draft for persistence. */
export function serializeCommittedDraft(committed: TargetDraft): StoredTargetSettings {
  return {
    selectedPresetId: committed.presetId,
    customTargetLufs: committed.customTargetLufs,
    customTruePeak: committed.customTruePeak,
    targetTolerance: committed.toleranceLufs,
    customPolicy: committed.policy,
  };
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Merge a partial edit into the draft, leaving the committed target untouched. */
export function updateDraft(state: TargetWorkspaceState, patch: Partial<TargetDraft>): TargetWorkspaceState {
  return { ...state, draft: { ...state.draft, ...patch } };
}

/**
 * Select a preset.
 * - Published preset: atomically loads all its values (including tolerance) and
 *   commits immediately. A published preset is always a valid, complete spec
 *   (UX-001).
 * - Custom: switches the draft to the manual editor without committing; the
 *   user applies the draft explicitly (UX-004). The active target is unchanged.
 * Unknown ids are ignored.
 */
export function selectPreset(state: TargetWorkspaceState, presetId: string): TargetWorkspaceState {
  if (presetId === CUSTOM_PRESET_ID) {
    return { ...state, draft: { ...state.draft, presetId: CUSTOM_PRESET_ID } };
  }
  const base = TARGET_PRESETS.find((preset) => preset.id === presetId);
  if (!base) {
    return state;
  }
  const committedDraft: TargetDraft = {
    ...state.draft,
    presetId: base.id,
    toleranceLufs: formatDraftNumber(base.toleranceLufs),
  };
  return { draft: committedDraft, committed: { ...committedDraft } };
}

/**
 * Commit the draft to the active target. Invalid drafts are rejected outright:
 * the previous active target stays active rather than silently falling back
 * (UX-004).
 */
export function applyDraft(state: TargetWorkspaceState): TargetWorkspaceState {
  if (!resolveDraftTarget(state.draft).isValid) {
    return state;
  }
  return { draft: state.draft, committed: { ...state.draft } };
}

/** Discard uncommitted edits, restoring the draft to the active target. */
export function cancelDraft(state: TargetWorkspaceState): TargetWorkspaceState {
  return { ...state, draft: { ...state.committed } };
}

/**
 * Reset a modified published preset back to its stored ("published") values and
 * commit them, mirroring a fresh selection (UX-004). No-op for custom targets.
 */
export function resetToPublished(state: TargetWorkspaceState): TargetWorkspaceState {
  const base = TARGET_PRESETS.find((preset) => preset.id === state.draft.presetId);
  if (!base) {
    return state;
  }
  const committedDraft: TargetDraft = {
    ...state.draft,
    presetId: base.id,
    toleranceLufs: formatDraftNumber(base.toleranceLufs),
  };
  return { draft: committedDraft, committed: { ...committedDraft } };
}

// ---------------------------------------------------------------------------
// Derived UI state
// ---------------------------------------------------------------------------

/**
 * True when a published preset's value differs from its stored definition, so
 * the UI can show "Modified" and offer Reset to Published Value (UX-004).
 * Custom targets are inherently user-defined and never "modified".
 */
export function isDraftModified(draft: TargetDraft): boolean {
  if (draft.presetId === CUSTOM_PRESET_ID) {
    return false;
  }
  const base = TARGET_PRESETS.find((preset) => preset.id === draft.presetId);
  if (!base) {
    return false;
  }
  const tolerance = parseTargetNumber(draft.toleranceLufs);
  return tolerance == null || tolerance !== base.toleranceLufs;
}

/** True when the draft has uncommitted changes (or cannot be applied). */
export function isDraftDirty(state: TargetWorkspaceState): boolean {
  const resolved = resolveDraftTarget(state.draft);
  if (!resolved.target) {
    return true;
  }
  return !targetsEqual(resolved.target, resolveActiveTarget(state.committed));
}

/**
 * Status line for an invalid draft, naming the target that stays active
 * (UX-004). Null when the draft is valid.
 */
export function draftStatusMessage(state: TargetWorkspaceState): string | null {
  if (resolveDraftTarget(state.draft).isValid) {
    return null;
  }
  return `Draft has errors; ${resolveActiveTarget(state.committed).label} remains active.`;
}

