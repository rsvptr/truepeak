import type { AnalysisJob, AnalysisResult } from "@/types/audio";

export type ComplianceState =
  | "on-target"
  | "below-target"
  | "above-target"
  | "ceiling-limited";

export interface ComplianceSummary {
  state: ComplianceState;
  label: string;
  description: string;
  deltaFromTargetLufs: number;
}

// Two decimals for every ordinary tolerance, more only when that would round the
// window down to "0.00". The field accepts anything above 0, so a 0.005 LU
// window has to read as 0.005 rather than as no window at all.
function formatTolerance(value: number): string {
  if (value >= 0.01) {
    return value.toFixed(2);
  }
  return value.toPrecision(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function getComplianceSummary(result: AnalysisResult): ComplianceSummary | null {
  if (!result.target) {
    return null;
  }

  if (result.metrics.integratedValid === false) {
    return null;
  }

  const deltaFromTargetLufs = result.metrics.integratedLufs - result.target.loudnessTargetLufs;
  // Compare against the tolerance the user actually chose. There used to be a
  // Math.max(0.1, ...) floor here, but validateTolerance accepts anything in
  // (0, 10] and resolveDraftTarget applies a drafted tolerance to published
  // presets too, so a 0.05 LU window was silently widened to 0.1 while CSV and
  // JSON exported the unclamped 0.05 next to a verdict never evaluated against
  // it. Floating-point noise at these magnitudes is ~1e-13, not 0.1 LU, so no
  // floor is needed; if a minimum window is ever wanted it belongs in
  // TOLERANCE_RANGE.min so the stored, exported, and compared numbers agree.
  const window = result.target.toleranceLufs;
  const withinTolerance = Math.abs(deltaFromTargetLufs) <= window;
  const exceedsCeiling = result.metrics.truePeakDbtp > result.target.truePeakCeilingDbtp;
  // Which peak the verdict must judge depends on what the user is going to do
  // with the file. Inside tolerance they ship it as measured, so the measured
  // peak is the one that matters. Outside tolerance they apply the suggested
  // gain, so the peak AFTER that move decides whether the file lands compliant.
  // Falls back to the measured peak on legacy records written before
  // projectedTruePeakDbtp existed.
  const projectedTruePeakDbtp =
    result.metrics.projectedTruePeakDbtp ?? result.metrics.truePeakDbtp;
  const projectedExceedsCeiling = projectedTruePeakDbtp > result.target.truePeakCeilingDbtp;

  // The verdict must reflect the WORST of the loudness-vs-tolerance and
  // true-peak-vs-ceiling axes. It keys off the MEASURED true peak, not the
  // normalizationLimited flag alone: a file already inside the loudness tolerance
  // whose measured peak sits under/at the ceiling is fully deliverable and reads
  // on-target even when the residual move to hit dead-centre target was capped
  // (that cap is cosmetic, the file is already compliant). Only a measured peak
  // that actually EXCEEDS the ceiling turns an otherwise on-target file into a
  // ceiling breach that must not hide behind the loudness read.
  if (withinTolerance) {
    if (exceedsCeiling) {
      return {
        state: "ceiling-limited",
        label: "Ceiling-limited",
        description:
          "Measured true peak exceeds the selected ceiling even though integrated loudness is on target.",
        deltaFromTargetLufs,
      };
    }
    return {
      state: "on-target",
      label: "On target",
      description: `Integrated loudness sits within +/-${formatTolerance(window)} LU of the selected target.`,
      deltaFromTargetLufs,
    };
  }

  // Out of tolerance: a capped normalization move means the loudness target and the
  // peak ceiling cannot both be reached, so surface that as the binding constraint
  // rather than a plain below/above verdict.
  if (result.metrics.normalizationLimited) {
    return {
      state: "ceiling-limited",
      label: "Ceiling-limited",
      description:
        "Normalization gain was capped to keep the projected true peak inside the selected ceiling.",
      deltaFromTargetLufs,
    };
  }

  // Out of tolerance and the suggested move does not land the file inside the
  // ceiling. This covers both directions. A quiet file gains, so a measured peak
  // already over the ceiling only gets worse. A too-hot file attenuates, which
  // usually clears the peak as a side effect (and then the actionable "Too hot"
  // verdict stands), but a small overshoot against a large peak excess does not:
  // -13.5 LUFS against a -14 target moves only 0.5 dB, so a -0.1 dBTP peak still
  // breaches a -1 dBTP ceiling afterwards. normalizationLimited does not catch
  // either case, because applyTargetToMetrics only ever sets it for
  // policy === "protect-true-peak".
  if (projectedExceedsCeiling) {
    const direction = deltaFromTargetLufs < 0 ? "below" : "above";
    const move = deltaFromTargetLufs < 0 ? "gain" : "attenuation";
    return {
      state: "ceiling-limited",
      label: "Ceiling-limited",
      description: `Integrated loudness is ${Math.abs(deltaFromTargetLufs).toFixed(2)} LU ${direction} target, and the ${move} needed to reach it still leaves the true peak above the selected ceiling.`,
      deltaFromTargetLufs,
    };
  }

  if (deltaFromTargetLufs < 0) {
    return {
      state: "below-target",
      label: "Needs gain",
      description: `Integrated loudness is ${Math.abs(deltaFromTargetLufs).toFixed(2)} LU below target.`,
      deltaFromTargetLufs,
    };
  }

  // Too hot, and attenuating to target brings the true peak inside the ceiling as
  // well, so the actionable above-target verdict stands.
  return {
    state: "above-target",
    label: "Too hot",
    description: `Integrated loudness is ${deltaFromTargetLufs.toFixed(2)} LU above target.`,
    deltaFromTargetLufs,
  };
}

export function countComplianceStates(jobs: AnalysisJob[]) {
  return jobs.reduce(
    (counts, job) => {
      if (!job.result) {
        return counts;
      }

      const summary = getComplianceSummary(job.result);
      if (!summary) {
        return counts;
      }

      counts[summary.state] += 1;
      return counts;
    },
    {
      "on-target": 0,
      "below-target": 0,
      "above-target": 0,
      "ceiling-limited": 0,
    } as Record<ComplianceState, number>,
  );
}
