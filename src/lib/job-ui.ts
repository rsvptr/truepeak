export interface JobErrorDisplay {
  summary: string;
  detail: string | null;
}

export function getJobErrorDisplay(message?: string | null): JobErrorDisplay | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();

  if (
    lower.includes("couldn't decode this file") ||
    lower.includes("browser decode failed:") ||
    lower.includes("primary decode failed:") ||
    lower.includes("compatibility decode failed:")
  ) {
    return {
      summary: "This file could not be decoded in the browser.",
      detail: trimmed,
    };
  }

  if (lower.includes("original file handle was not available")) {
    return {
      summary: "The source file is no longer available for this queue item.",
      detail: "Add the file again before retrying this analysis.",
    };
  }

  return {
    summary: trimmed,
    detail: null,
  };
}
