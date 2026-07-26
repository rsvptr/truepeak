import type { IntegratedInvalidReason, LoudnessMetrics } from "@/types/audio";

const NEGATIVE_FLOOR = -144;
const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

// Fixed-precision string that never renders "-0.00": a small negative that
// rounds to zero would otherwise show a stray minus sign (and, for relative
// values, the sign logic below would then disagree with the displayed number).
function toFixedClean(value: number, precision: number) {
  const fixed = value.toFixed(precision);
  const zero = (0).toFixed(precision);
  return fixed === `-${zero}` ? zero : fixed;
}

export function formatLufs(value: number | null | undefined, precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${toFixedClean(value, precision)} LUFS`;
}

export function describeIntegratedInvalidReason(
  reason: IntegratedInvalidReason | undefined,
) {
  switch (reason) {
    case "too-short":
      return "Clip is too short for a complete 400 ms gated measurement.";
    case "below-gate":
      return "All audio is below the -70 LUFS absolute gate.";
    default:
      return "Integrated loudness is not a valid measurement.";
  }
}

/**
 * Formats the measured value only when the analyzer says it is valid. Legacy
 * records have no validity flag and retain their historical presentation.
 */
export function formatIntegratedLufs(
  metrics: Pick<LoudnessMetrics, "integratedLufs" | "integratedValid">,
  precision = 2,
) {
  return metrics.integratedValid === false
    ? "No valid measurement"
    : formatLufs(metrics.integratedLufs, precision);
}

export function formatLoudnessRange(
  metrics: Pick<LoudnessMetrics, "loudnessRange" | "loudnessRangeUnstable">,
  precision = 2,
) {
  const value = formatDb(metrics.loudnessRange, "LU", precision);
  return metrics.loudnessRangeUnstable === true ? `${value} (unstable)` : value;
}

export function formatDb(value: number | null | undefined, suffix = "dB", precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${toFixedClean(value, precision)} ${suffix}`;
}

// Strips trailing fractional zeros (and a bare trailing dot) left behind by
// toFixedClean, e.g. "-18.00" -> "-18" but "-14.50" -> "-14.5". The decimal
// point always precedes any zero this removes, so a whole number's own
// trailing zero (as in "-100.00") is never touched.
function trimTrailingZeros(fixed: string) {
  if (!fixed.includes(".")) {
    return fixed;
  }

  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Formats preset-defined targets (loudness targets, true-peak ceilings) at
 * only the precision they actually carry. Built-in presets are whole
 * numbers, so this renders "-18 LUFS" rather than formatLufs's "-18.00
 * LUFS" - a decimal suffix on a preset constant reads as measured
 * precision it doesn't have. Custom targets can still carry real decimal
 * input (e.g. -14.5), which this preserves instead of rounding it away.
 */
export function formatPresetLufs(value: number | null | undefined, precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${trimTrailingZeros(toFixedClean(value, precision))} LUFS`;
}

/** Preset/ceiling counterpart to {@link formatPresetLufs}; see its docs. */
export function formatPresetPeakDbtp(value: number | null | undefined, precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${trimTrailingZeros(toFixedClean(value, precision))} dBTP`;
}

export function formatPeakDbtp(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${toFixedClean(value, 2)} dBTP`;
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) {
    return "n/a";
  }

  const totalSeconds = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatRelativeDb(value: number | null | undefined, precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  const fixed = toFixedClean(value, precision);
  const sign = Number(fixed) > 0 ? "+" : "";
  return `${sign}${fixed} dB`;
}

export function formatRelativeLu(value: number | null | undefined, precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  const fixed = toFixedClean(value, precision);
  const sign = Number(fixed) > 0 ? "+" : "";
  return `${sign}${fixed} LU`;
}

export function formatTimestamp(value: string | number | Date | null | undefined) {
  if (value == null) {
    return "Unknown time";
  }

  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return "Unknown time";
  }

  return timestampFormatter.format(timestamp);
}

// Last stamp handed out per filename scope, so a second call inside the same
// wall-clock second can be disambiguated. The stamp is second-resolution with no
// counter otherwise, so two exports of the same kind one after another produced
// byte-identical filenames and the browser silently overwrote or "(1)"-suffixed
// the first, which is exactly what stamping the filename was meant to avoid.
//
// Scoped rather than global because only same-scope names can actually collide:
// a CSV export and a JSON export in the same second already differ by extension,
// and a shared counter would hang a spurious "-2" on the second one.
const lastFileNameStamps = new Map<string, { base: string; repeat: number }>();

/**
 * Compact local-time stamp for download filenames (YYYYMMDD-HHMMSS).
 *
 * `scope` identifies the family of filenames this stamp belongs to (one per
 * distinct basename plus extension). A repeat within the same second and scope
 * gains a "-2", "-3", ... suffix; the plain form is what every ordinary export
 * gets.
 */
export function fileNameTimestamp(scope = "default", now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const previous = lastFileNameStamps.get(scope);
  if (previous && previous.base === base) {
    previous.repeat += 1;
    return `${base}-${previous.repeat + 1}`;
  }

  lastFileNameStamps.set(scope, { base, repeat: 0 });
  return base;
}

export function peakToDb(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return NEGATIVE_FLOOR;
  }

  return 20 * Math.log10(value);
}

export function energyToLufs(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return -70;
  }

  return Math.max(10 * Math.log10(value) - 0.691, -70);
}
