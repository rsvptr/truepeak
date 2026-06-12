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

export function formatDb(value: number | null | undefined, suffix = "dB", precision = 2) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `${toFixedClean(value, precision)} ${suffix}`;
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

// Compact local-time stamp for download filenames (YYYYMMDD-HHMMSS), so
// repeated exports never overwrite or "(1)"-suffix each other.
export function fileNameTimestamp(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
