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

export function getComplianceSummary(result: AnalysisResult): ComplianceSummary | null {
  if (!result.target) {
    return null;
  }

  if (result.metrics.integratedValid === false) {
    return null;
  }

  const deltaFromTargetLufs = result.metrics.integratedLufs - result.target.loudnessTargetLufs;
  const window = Math.max(0.1, result.target.toleranceLufs);
  const withinTolerance = Math.abs(deltaFromTargetLufs) <= window;
  const exceedsCeiling = result.metrics.truePeakDbtp > result.target.truePeakCeilingDbtp;

  // The verdict must reflect the WORST of the loudness-vs-tolerance and
  // true-peak-vs-ceiling axes. It keys off the MEASURED true peak, not the
  // normalizationLimited flag alone: a file already inside the loudness tolerance
  // whose measured peak sits under/at the ceiling is fully deliverable and reads
  // on-target even when the residual move to hit dead-centre target was capped
  // (that cap is cosmetic — the file is already compliant). Only a measured peak
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
      description: `Integrated loudness sits within +/-${window.toFixed(2)} LU of the selected target.`,
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

  if (deltaFromTargetLufs < 0) {
    return {
      state: "below-target",
      label: "Needs gain",
      description: `Integrated loudness is ${Math.abs(deltaFromTargetLufs).toFixed(2)} LU below target.`,
      deltaFromTargetLufs,
    };
  }

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
