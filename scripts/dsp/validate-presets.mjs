// Validation for the target draft / active-target engine that backs the Preset
// Library. Covers the correctness-critical rules from the UI/UX audit:
//   UX-001  atomic preset selection (every value, including tolerance)
//   UX-004  active vs draft, Apply/Cancel, Modified/Reset, no silent fallback
//   UX-003  gain-policy labels + consequence copy
//   UX-029  defensible domain ranges
// The compliance-window check ties the selected tolerance to the actual verdict.
// Run: node scripts/dsp/validate-presets.mjs
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

const P = await import("../../src/audio/presets.ts");
const { getComplianceSummary } = await import("../../src/audio/compliance.ts");
const { applyTargetToMetrics } = await import("../../src/audio/targeting.ts");

const {
  CUSTOM_PRESET_ID,
  DEFAULT_TARGET_PRESET,
  GAIN_POLICIES,
  GAIN_POLICY_LEGEND,
  LOUDNESS_TARGET_RANGE,
  TARGET_PRESETS,
  TOLERANCE_RANGE,
  TRUE_PEAK_LIMIT_RANGE,
  applyDraft,
  cancelDraft,
  createDefaultTargetState,
  describeGainPolicy,
  draftStatusMessage,
  isDraftDirty,
  isDraftModified,
  resetToPublished,
  resolveActiveTarget,
  resolveDraftTarget,
  selectPreset,
  serializeCommittedDraft,
  stateFromStoredSettings,
  updateDraft,
} = P;

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

// Build a minimal completed result so getComplianceSummary can be exercised.
function resultWithTarget(target, integratedLufs) {
  return {
    analysisMode: "targeted",
    target,
    analyzedAt: "2026-07-19T00:00:00.000Z",
    metadata: { fileName: "probe.wav" },
    metrics: {
      integratedLufs,
      integratedValid: true,
      normalizationLimited: false,
    },
  };
}

// Build a targeted result whose target-derived metrics (targetDeltaDb,
// normalizationLimited, projectedTruePeakDbtp) come from the REAL targeting
// engine, so the compliance verdict is exercised against production wiring
// rather than hand-set flags. `truePeakDbtp` is the measured true peak.
function targetedResult(target, integratedLufs, truePeakDbtp) {
  const baseMetrics = {
    integratedLufs,
    integratedValid: true,
    ungatedLufs: integratedLufs,
    loudnessRange: 5,
    maxMomentaryLufs: integratedLufs + 2,
    maxShortTermLufs: integratedLufs + 1,
    samplePeakDbfs: truePeakDbtp - 0.1,
    truePeakDbtp,
    unclampedTargetDeltaDb: null,
    targetDeltaDb: null,
    projectedTruePeakDbtp: null,
    normalizationLimited: false,
    timeline: { stepDurationSeconds: 0.1, timeSeconds: [], momentaryLufs: [], shortTermLufs: [], truePeakDbtp: [] },
    warnings: [],
  };
  return {
    analysisMode: "targeted",
    target,
    analyzedAt: "2026-07-19T00:00:00.000Z",
    metadata: { fileName: "probe.wav" },
    metrics: applyTargetToMetrics(baseMetrics, target),
  };
}

// ---------------------------------------------------------------------------
console.log("\n[A] UX-001 — atomic preset selection loads EVERY stored value");
// Every published preset: selecting it makes the active target match the stored
// definition exactly (id, target, ceiling, tolerance, policy).
for (const preset of TARGET_PRESETS) {
  const state = selectPreset(createDefaultTargetState(), preset.id);
  const active = resolveActiveTarget(state.committed);
  check(
    `select ${preset.id} loads all values`,
    active.id === preset.id &&
      active.loudnessTargetLufs === preset.loudnessTargetLufs &&
      active.truePeakCeilingDbtp === preset.truePeakCeilingDbtp &&
      active.toleranceLufs === preset.toleranceLufs &&
      active.policy === preset.policy,
    JSON.stringify({
      got: {
        target: active.loudnessTargetLufs,
        ceiling: active.truePeakCeilingDbtp,
        tol: active.toleranceLufs,
        policy: active.policy,
      },
      want: {
        target: preset.loudnessTargetLufs,
        ceiling: preset.truePeakCeilingDbtp,
        tol: preset.toleranceLufs,
        policy: preset.policy,
      },
    }),
  );
  // The draft mirrors the committed tolerance (UI state is atomic too).
  check(`select ${preset.id} draft tolerance matches`, Number(state.draft.toleranceLufs) === preset.toleranceLufs);
}

// Audit acceptance path: start from the default 1 LU tolerance, then select
// EBU -> 0.5, ATSC -> 2, HiFi -> 1.5.
check("default tolerance is 1 LU", DEFAULT_TARGET_PRESET.toleranceLufs === 1);
let seq = createDefaultTargetState();
for (const [id, want] of [
  ["broadcast-ebu", 0.5],
  ["broadcast-atsc", 2],
  ["hifi-dynamic", 1.5],
]) {
  seq = selectPreset(seq, id);
  check(`acceptance: ${id} => ${want} LU active`, resolveActiveTarget(seq.committed).toleranceLufs === want);
}

// ---------------------------------------------------------------------------
console.log("\n[A2] UX-001 — the selected tolerance drives the compliance window");
// EBU (tolerance 0.5) with a -0.8 LU delta must NOT read on-target; under the
// old global 1 LU tolerance the same delta would have. This proves the verdict
// window follows the preset, not a stray global value.
{
  const ebuState = selectPreset(createDefaultTargetState(), "broadcast-ebu");
  const ebu = resolveActiveTarget(ebuState.committed);
  const delta08 = getComplianceSummary(resultWithTarget(ebu, ebu.loudnessTargetLufs - 0.8));
  check("EBU 0.5 LU: -0.8 delta is NOT on-target", delta08 && delta08.state !== "on-target", delta08 && delta08.state);
  const delta04 = getComplianceSummary(resultWithTarget(ebu, ebu.loudnessTargetLufs - 0.4));
  check("EBU 0.5 LU: -0.4 delta IS on-target", delta04 && delta04.state === "on-target", delta04 && delta04.state);

  const atscState = selectPreset(createDefaultTargetState(), "broadcast-atsc");
  const atsc = resolveActiveTarget(atscState.committed);
  const atscDelta = getComplianceSummary(resultWithTarget(atsc, atsc.loudnessTargetLufs + 1.5));
  check("ATSC 2 LU: +1.5 delta IS on-target", atscDelta && atscDelta.state === "on-target", atscDelta && atscDelta.state);
}

// ---------------------------------------------------------------------------
console.log("\n[A3] Compliance verdict = WORST of loudness-vs-tolerance and true-peak-vs-ceiling");
// A true-peak ceiling breach must never hide behind an on-target loudness read.
{
  const spotifyNormal = TARGET_PRESETS.find((p) => p.id === "spotify-normal"); // -14 / -1 / tol 1, protect-true-peak
  const spotifyLoud = TARGET_PRESETS.find((p) => p.id === "spotify-loud"); // -11 / -1 / tol 1, loudness-first

  // Acceptance repro (finding [1]): loudness inside tolerance (-14.2 vs -14, tol 1)
  // but the measured true peak (-0.3) is over the -1 ceiling. Must NOT read compliant.
  const hotMaster = targetedResult(spotifyNormal, -14.2, -0.3);
  const hotSummary = getComplianceSummary(hotMaster);
  check("hot master: engine flags normalizationLimited", hotMaster.metrics.normalizationLimited === true);
  check("loudness-pass + TP-over-ceiling is NOT on-target (acceptance repro)", hotSummary?.state !== "on-target", hotSummary?.state);
  check("loudness-pass + TP-over-ceiling reads ceiling-limited", hotSummary?.state === "ceiling-limited", hotSummary?.state);

  // Raw-peak axis is independent of normalizationLimited: a slightly-hot-but-in-tolerance
  // file (-13.8) whose peak (-0.9) is over -1 has normalizationLimited === false
  // (attenuating to exact target would clear it), yet its measured peak is still over
  // the ceiling, so it must read ceiling-limited.
  const inTolHotPeak = targetedResult(spotifyNormal, -13.8, -0.9);
  const inTolSummary = getComplianceSummary(inTolHotPeak);
  check("in-tolerance-over-ceiling: normalizationLimited=false", inTolHotPeak.metrics.normalizationLimited === false);
  check("in-tolerance file with raw peak over ceiling reads ceiling-limited", inTolSummary?.state === "ceiling-limited", inTolSummary?.state);

  // Boundary: exactly at the ceiling is compliant; a hair over is not.
  const atCeiling = getComplianceSummary(targetedResult(spotifyNormal, -14, -1));
  check("true peak EXACTLY at the ceiling (on target) reads on-target", atCeiling?.state === "on-target", atCeiling?.state);
  const overCeiling = getComplianceSummary(targetedResult(spotifyNormal, -14, -0.99));
  check("true peak a hair over the ceiling (on target) reads ceiling-limited", overCeiling?.state === "ceiling-limited", overCeiling?.state);

  // Control: on target and comfortably under the ceiling stays on-target (the fix must
  // not turn every targeted file ceiling-limited).
  const underCeiling = getComplianceSummary(targetedResult(spotifyNormal, -14, -3));
  check("on target + peak well under ceiling stays on-target", underCeiling?.state === "on-target", underCeiling?.state);

  // No hijack: an out-of-tolerance too-hot file whose peak is over the ceiling keeps its
  // actionable above-target verdict (attenuating to target also clears the peak).
  const tooHot = targetedResult(spotifyNormal, -8, -0.2);
  const tooHotSummary = getComplianceSummary(tooHot);
  check("too-hot-over-ceiling: normalizationLimited=false", tooHot.metrics.normalizationLimited === false);
  check("out-of-tolerance too-hot file stays above-target (no ceiling hijack)", tooHotSummary?.state === "above-target", tooHotSummary?.state);

  // Preserved: an out-of-tolerance quiet file that cannot be normalized up without
  // breaching the ceiling stays ceiling-limited (existing normalizationLimited path).
  const quietCapped = targetedResult(spotifyNormal, -20, -0.5);
  const quietSummary = getComplianceSummary(quietCapped);
  check("quiet-but-capped: normalizationLimited=true", quietCapped.metrics.normalizationLimited === true);
  check("out-of-tolerance quiet-but-capped file reads ceiling-limited", quietSummary?.state === "ceiling-limited", quietSummary?.state);

  // loudness-first policy never sets normalizationLimited, so the raw-peak axis is the
  // ONLY thing that can surface an on-target-loudness ceiling breach here.
  const loudFirst = targetedResult(spotifyLoud, -11.5, -0.5);
  const loudFirstSummary = getComplianceSummary(loudFirst);
  check("loudness-first leaves normalizationLimited=false", loudFirst.metrics.normalizationLimited === false);
  check("loudness-first on-target-loudness with peak over ceiling reads ceiling-limited", loudFirstSummary?.state === "ceiling-limited", loudFirstSummary?.state);
}

// ---------------------------------------------------------------------------
console.log("\n[B] UX-004 — active vs draft, Apply / Cancel, no silent fallback");
{
  // Edit a preset's tolerance: the active target must stay put until Apply.
  let s = selectPreset(createDefaultTargetState(), "broadcast-ebu");
  check("fresh selection is not dirty", isDraftDirty(s) === false);
  s = updateDraft(s, { toleranceLufs: "0.7" });
  check("edit makes the draft dirty", isDraftDirty(s) === true);
  check("edit does NOT move the active target", resolveActiveTarget(s.committed).toleranceLufs === 0.5);
  const applied = applyDraft(s);
  check("Apply commits the draft", resolveActiveTarget(applied.committed).toleranceLufs === 0.7);
  check("Apply clears dirty", isDraftDirty(applied) === false);

  // Cancel restores the draft to the active target.
  let edited = updateDraft(applied, { toleranceLufs: "0.9" });
  check("re-edit is dirty", isDraftDirty(edited) === true);
  const cancelled = cancelDraft(edited);
  check("Cancel restores the draft", cancelled.draft.toleranceLufs === applied.draft.toleranceLufs);
  check("Cancel clears dirty", isDraftDirty(cancelled) === false);

  // Invalid drafts never silently fall back: active stays, status names it.
  let bad = updateDraft(selectPreset(createDefaultTargetState(), "broadcast-ebu"), { toleranceLufs: "abc" });
  check("invalid draft resolves to no target", resolveDraftTarget(bad.draft).target === null);
  check("invalid draft keeps active target valid", resolveActiveTarget(bad.committed).toleranceLufs === 0.5);
  check(
    "invalid draft status names the active target",
    draftStatusMessage(bad) === "Draft has errors; Broadcast EBU R128 remains active.",
    draftStatusMessage(bad) ?? "null",
  );
  check("Apply on an invalid draft is a no-op", resolveActiveTarget(applyDraft(bad).committed).toleranceLufs === 0.5);

  // Selecting Custom previews as a draft and commits only on Apply.
  let custom = selectPreset(applied, CUSTOM_PRESET_ID);
  check("selecting Custom does not auto-commit", resolveActiveTarget(custom.committed).id === "broadcast-ebu");
  check("selecting Custom is dirty (pending apply)", isDraftDirty(custom) === true);
  custom = updateDraft(custom, { customTargetLufs: "-16", customTruePeak: "-2", toleranceLufs: "1", policy: "loudness-first" });
  const committedCustom = applyDraft(custom);
  const activeCustom = resolveActiveTarget(committedCustom.committed);
  check(
    "Apply commits the custom target",
    activeCustom.id === CUSTOM_PRESET_ID &&
      activeCustom.loudnessTargetLufs === -16 &&
      activeCustom.truePeakCeilingDbtp === -2 &&
      activeCustom.toleranceLufs === 1 &&
      activeCustom.policy === "loudness-first",
  );
}

// ---------------------------------------------------------------------------
console.log("\n[C] UX-004 — Modified state + Reset to Published Value");
{
  let s = selectPreset(createDefaultTargetState(), "broadcast-ebu");
  check("freshly selected preset is not Modified", isDraftModified(s.draft) === false);
  s = updateDraft(s, { toleranceLufs: "0.7" });
  check("edited preset is Modified", isDraftModified(s.draft) === true);
  s = applyDraft(s);
  check("applied edit is still Modified vs published", isDraftModified(s.draft) === true);
  check("...and the active tolerance is the modified 0.7", resolveActiveTarget(s.committed).toleranceLufs === 0.7);
  s = resetToPublished(s);
  check("Reset returns to the published 0.5", resolveActiveTarget(s.committed).toleranceLufs === 0.5);
  check("Reset clears Modified", isDraftModified(s.draft) === false);
  check("Reset clears dirty", isDraftDirty(s) === false);

  // Custom is inherently user-defined: never "Modified", Reset is a no-op.
  let c = selectPreset(createDefaultTargetState(), CUSTOM_PRESET_ID);
  c = updateDraft(c, { customTargetLufs: "-20" });
  check("Custom is never Modified", isDraftModified(c.draft) === false);
  check("Reset on Custom is a no-op", resetToPublished(c).draft.customTargetLufs === "-20");
}

// ---------------------------------------------------------------------------
console.log("\n[D] UX-004 — draft-validation gating");
{
  const base = { presetId: CUSTOM_PRESET_ID, customTargetLufs: "-14", customTruePeak: "-1", toleranceLufs: "1", policy: "protect-true-peak" };
  check("valid custom draft resolves", resolveDraftTarget(base).isValid === true);
  check("blank tolerance is invalid", resolveDraftTarget({ ...base, toleranceLufs: "" }).isValid === false);
  check("non-numeric target is invalid", resolveDraftTarget({ ...base, customTargetLufs: "loud" }).isValid === false);
  check("non-numeric ceiling is invalid", resolveDraftTarget({ ...base, customTruePeak: "x" }).isValid === false);
  check("unknown preset id is invalid", resolveDraftTarget({ ...base, presetId: "does-not-exist" }).isValid === false);
  const errs = resolveDraftTarget({ ...base, toleranceLufs: "0", customTargetLufs: "" });
  check("errors are reported per field", !!errs.errors.toleranceLufs && !!errs.errors.customTargetLufs);
  check("a message is surfaced for invalid drafts", typeof errs.message === "string" && errs.message.length > 0);
}

// ---------------------------------------------------------------------------
console.log("\n[E] UX-029 — defensible domain ranges");
{
  check("loudness range is [-60, 0]", LOUDNESS_TARGET_RANGE.min === -60 && LOUDNESS_TARGET_RANGE.max === 0);
  check("true-peak range is [-20, +3]", TRUE_PEAK_LIMIT_RANGE.min === -20 && TRUE_PEAK_LIMIT_RANGE.max === 3);
  check("tolerance range is (0, 10]", TOLERANCE_RANGE.min === 0 && TOLERANCE_RANGE.max === 10 && TOLERANCE_RANGE.minExclusive === true);

  const custom = (patch) =>
    resolveDraftTarget({ presetId: CUSTOM_PRESET_ID, customTargetLufs: "-14", customTruePeak: "-1", toleranceLufs: "1", policy: "protect-true-peak", ...patch }).isValid;

  // Loudness target bounds.
  check("target -60 LUFS accepted (edge)", custom({ customTargetLufs: "-60" }) === true);
  check("target 0 LUFS accepted (edge)", custom({ customTargetLufs: "0" }) === true);
  check("target -60.1 LUFS rejected", custom({ customTargetLufs: "-60.1" }) === false);
  check("target 0.1 LUFS rejected", custom({ customTargetLufs: "0.1" }) === false);
  check("target +999 LUFS rejected", custom({ customTargetLufs: "999" }) === false);

  // True-peak ceiling bounds.
  check("ceiling -20 dBTP accepted (edge)", custom({ customTruePeak: "-20" }) === true);
  check("ceiling +3 dBTP accepted (edge)", custom({ customTruePeak: "3" }) === true);
  check("ceiling -20.1 dBTP rejected", custom({ customTruePeak: "-20.1" }) === false);
  check("ceiling +3.1 dBTP rejected", custom({ customTruePeak: "3.1" }) === false);
  check("ceiling +100 dBTP rejected", custom({ customTruePeak: "100" }) === false);

  // Tolerance bounds (exclusive 0, inclusive 10).
  check("tolerance 0 rejected", custom({ toleranceLufs: "0" }) === false);
  check("tolerance -1 rejected", custom({ toleranceLufs: "-1" }) === false);
  check("tolerance 0.1 accepted", custom({ toleranceLufs: "0.1" }) === true);
  check("tolerance 10 accepted (edge)", custom({ toleranceLufs: "10" }) === true);
  check("tolerance 10.1 rejected", custom({ toleranceLufs: "10.1" }) === false);
  check("tolerance 999 rejected", custom({ toleranceLufs: "999" }) === false);
}

// ---------------------------------------------------------------------------
console.log("\n[F] UX-003 — gain-policy labels + consequence copy");
{
  check("legend text is set", GAIN_POLICY_LEGEND === "When loudness and peak limits conflict");
  check("two policies are exposed", GAIN_POLICIES.length === 2);
  const protect = GAIN_POLICIES.find((p) => p.value === "protect-true-peak");
  const loudness = GAIN_POLICIES.find((p) => p.value === "loudness-first");
  check("protect-true-peak label", protect && protect.label === "Respect Peak Limit", protect && protect.label);
  check("loudness-first label", loudness && loudness.label === "Reach Loudness Target", loudness && loudness.label);
  check(
    "protect consequence interpolates values",
    describeGainPolicy("protect-true-peak", { loudnessTargetLufs: -14, truePeakCeilingDbtp: -1 }) ===
      "Caps suggested gain at -1 dBTP. Loudness may remain below -14 LUFS.",
    describeGainPolicy("protect-true-peak", { loudnessTargetLufs: -14, truePeakCeilingDbtp: -1 }),
  );
  check(
    "loudness consequence interpolates values",
    describeGainPolicy("loudness-first", { loudnessTargetLufs: -11, truePeakCeilingDbtp: -1 }) ===
      "Applies the full gain needed for -11 LUFS. Projected true peak may exceed -1 dBTP.",
    describeGainPolicy("loudness-first", { loudnessTargetLufs: -11, truePeakCeilingDbtp: -1 }),
  );
  check(
    "consequence tracks a different draft value",
    describeGainPolicy("protect-true-peak", { loudnessTargetLufs: -23, truePeakCeilingDbtp: -2 }).includes("-23 LUFS") &&
      describeGainPolicy("protect-true-peak", { loudnessTargetLufs: -23, truePeakCeilingDbtp: -2 }).includes("-2 dBTP"),
  );
}

// ---------------------------------------------------------------------------
console.log("\n[G] persistence round-trips the committed target");
{
  // Published, modified tolerance.
  const modified = applyDraft(updateDraft(selectPreset(createDefaultTargetState(), "broadcast-ebu"), { toleranceLufs: "0.7" }));
  const restored = stateFromStoredSettings(serializeCommittedDraft(modified.committed));
  check("published modified tolerance round-trips", resolveActiveTarget(restored.committed).toleranceLufs === 0.7);
  check("...preserving the preset id", resolveActiveTarget(restored.committed).id === "broadcast-ebu");
  check("...and restoring as not-dirty", isDraftDirty(restored) === false);
  check("...still recognised as Modified", isDraftModified(restored.draft) === true);

  // Custom target.
  const custom = applyDraft(
    updateDraft(selectPreset(createDefaultTargetState(), CUSTOM_PRESET_ID), {
      customTargetLufs: "-9",
      customTruePeak: "-2",
      toleranceLufs: "1.5",
      policy: "loudness-first",
    }),
  );
  const restoredCustom = resolveActiveTarget(stateFromStoredSettings(serializeCommittedDraft(custom.committed)).committed);
  check(
    "custom target round-trips",
    restoredCustom.id === CUSTOM_PRESET_ID &&
      restoredCustom.loudnessTargetLufs === -9 &&
      restoredCustom.truePeakCeilingDbtp === -2 &&
      restoredCustom.toleranceLufs === 1.5 &&
      restoredCustom.policy === "loudness-first",
  );

  // Tampered / out-of-range stored value falls back to the default target.
  const tampered = stateFromStoredSettings({
    selectedPresetId: "broadcast-ebu",
    customTargetLufs: "-14",
    customTruePeak: "-1",
    targetTolerance: "50",
    customPolicy: "protect-true-peak",
  });
  check("out-of-range stored tolerance falls back to default", resolveActiveTarget(tampered.committed).id === DEFAULT_TARGET_PRESET.id);
}

console.log(`\n==== Presets: ${passed} passed, ${failed} failed ====\n`);
process.exit(failed ? 1 : 0);
