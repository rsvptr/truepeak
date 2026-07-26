import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function makeId(seed = "job") {
  return `${seed}-${crypto.randomUUID()}`;
}

/**
 * Save a string as a file download.
 *
 * The teardown is deferred to the next task on purpose. Activating a link runs
 * "follow the hyperlink", which the HTML spec queues on the DOM manipulation
 * task source, so the browser fetches the blob: URL after this function has
 * returned. Revoking synchronously (as the timeline CSV export used to) can race
 * that fetch and produce a silent no-op download.
 *
 * Shared rather than duplicated: the two copies had drifted, and only one of
 * them deferred.
 */
export function downloadTextFile(fileName: string, content: string, contentType: string) {
  let url: string | null = null;
  let anchor: HTMLAnchorElement | null = null;

  try {
    const blob = new Blob([content], { type: contentType });
    url = URL.createObjectURL(blob);
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    const targetUrl = url;
    const targetAnchor = anchor;
    window.setTimeout(() => {
      targetAnchor?.remove();
      if (targetUrl) {
        URL.revokeObjectURL(targetUrl);
      }
    }, 0);
  }
}

export function bytesToSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
