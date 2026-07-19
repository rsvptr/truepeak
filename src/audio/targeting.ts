import type { AnalysisResult, LoudnessMetrics, TargetPreset } from "@/types/audio";

export const TARGET_LIMIT_WARNING =
  "Target loudness would exceed the selected true peak ceiling, so the suggested gain is capped.";

// Persisted sessions and IndexedDB records written before the copy update
// carry the old wording; both spellings must strip when a target is cleared.
const TARGET_LIMIT_WARNINGS = new Set([
  TARGET_LIMIT_WARNING,
  "Target loudness would exceed the selected true-peak ceiling, so the suggested gain is capped.",
]);

export function clearTargetFromMetrics(metrics: LoudnessMetrics): LoudnessMetrics {
  const warnings = metrics.warnings.filter(
    (warning) => !TARGET_LIMIT_WARNINGS.has(warning),
  );

  return {
    ...metrics,
    unclampedTargetDeltaDb: null,
    targetDeltaDb: null,
    projectedTruePeakDbtp: null,
    normalizationLimited: false,
    warnings,
  };
}

export function applyTargetToMetrics(
  metrics: LoudnessMetrics,
  target: TargetPreset,
): LoudnessMetrics {
  const baseMetrics = clearTargetFromMetrics(metrics);

  if (baseMetrics.integratedValid === false) {
    return {
      ...baseMetrics,
      unclampedTargetDeltaDb: null,
      targetDeltaDb: null,
      projectedTruePeakDbtp: null,
      normalizationLimited: false,
    };
  }

  const unclampedTargetDeltaDb = target.loudnessTargetLufs - baseMetrics.integratedLufs;
  const maxAllowedDelta = target.truePeakCeilingDbtp - baseMetrics.truePeakDbtp;
  const targetDeltaDb =
    target.policy === "protect-true-peak"
      ? Math.min(unclampedTargetDeltaDb, maxAllowedDelta)
      : unclampedTargetDeltaDb;
  const normalizationLimited =
    target.policy === "protect-true-peak" && targetDeltaDb < unclampedTargetDeltaDb;

  const warnings = [...baseMetrics.warnings];
  if (normalizationLimited) {
    warnings.push(TARGET_LIMIT_WARNING);
  }

  return {
    ...baseMetrics,
    unclampedTargetDeltaDb,
    targetDeltaDb,
    projectedTruePeakDbtp: baseMetrics.truePeakDbtp + targetDeltaDb,
    normalizationLimited,
    warnings,
  };
}

export function retargetAnalysisResult(
  result: AnalysisResult,
  target?: TargetPreset | null,
): AnalysisResult {
  if (!target) {
    return {
      ...result,
      analysisMode: "measure-only",
      target: null,
      metrics: clearTargetFromMetrics(result.metrics),
    };
  }

  return {
    ...result,
    analysisMode: "targeted",
    target,
    metrics: applyTargetToMetrics(result.metrics, target),
  };
}
