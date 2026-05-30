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

  const deltaFromTargetLufs = result.metrics.integratedLufs - result.target.loudnessTargetLufs;
  const window = Math.max(0.1, result.target.toleranceLufs);

  if (result.metrics.normalizationLimited) {
    return {
      state: "ceiling-limited",
      label: "Ceiling-limited",
      description:
        "Normalization gain was capped to keep the projected true peak inside the selected ceiling.",
      deltaFromTargetLufs,
    };
  }

  if (Math.abs(deltaFromTargetLufs) <= window) {
    return {
      state: "on-target",
      label: "On target",
      description: `Integrated loudness sits within +/-${window.toFixed(2)} LU of the selected target.`,
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
