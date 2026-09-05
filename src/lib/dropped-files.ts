// Resolves a drop's DataTransfer into a flat list of Files, walking dropped
// folders through the FileSystem entry API where the browser supports it.
// Every resource dimension is bounded: files, visited entries, directory
// depth, pages per directory, callback wait, and total elapsed time.

export const MAX_DROPPED_FILES = 2000;
const TRUEPEAK_RELATIVE_PATH_PROPERTY = "truepeakRelativePath" as const;

const MAX_DROPPED_ENTRIES = 8000;
const MAX_DIRECTORY_DEPTH = 12;
const MAX_DIRECTORY_PAGES = 256;
const MAX_DROP_TRAVERSAL_MS = 5000;
const MAX_RELATIVE_PATH_LENGTH = 4096;

export interface DropTraversalBudget {
  maxFiles: number;
  maxEntries: number;
  maxDepth: number;
  maxDirectoryPages: number;
  deadlineMs: number;
}

const DEFAULT_DROP_TRAVERSAL_BUDGET: Readonly<DropTraversalBudget> = Object.freeze({
  maxFiles: MAX_DROPPED_FILES,
  maxEntries: MAX_DROPPED_ENTRIES,
  maxDepth: MAX_DIRECTORY_DEPTH,
  maxDirectoryPages: MAX_DIRECTORY_PAGES,
  deadlineMs: MAX_DROP_TRAVERSAL_MS,
});

export interface DroppedFilesResult {
  files: File[];
  truncated: boolean;
}

type FileWithTruePeakPath = File & {
  readonly truepeakRelativePath?: string;
};

const relativePathFallback = new WeakMap<File, string>();

function boundedInteger(value: number | undefined, fallback: number, ceiling: number) {
  if (!Number.isSafeInteger(value) || value == null || value <= 0) {
    return fallback;
  }
  return Math.min(value, ceiling);
}

function resolveTraversalBudget(
  budget?: Partial<DropTraversalBudget>,
): DropTraversalBudget {
  return {
    maxFiles: boundedInteger(
      budget?.maxFiles,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxFiles,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxFiles,
    ),
    maxEntries: boundedInteger(
      budget?.maxEntries,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxEntries,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxEntries,
    ),
    maxDepth: boundedInteger(
      budget?.maxDepth,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxDepth,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxDepth,
    ),
    maxDirectoryPages: boundedInteger(
      budget?.maxDirectoryPages,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxDirectoryPages,
      DEFAULT_DROP_TRAVERSAL_BUDGET.maxDirectoryPages,
    ),
    deadlineMs: boundedInteger(
      budget?.deadlineMs,
      DEFAULT_DROP_TRAVERSAL_BUDGET.deadlineMs,
      DEFAULT_DROP_TRAVERSAL_BUDGET.deadlineMs,
    ),
  };
}

function cleanPathPart(name: string) {
  const cleaned = name
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.{1,2}$/, "_")
    .slice(0, 255);
  return cleaned || "_";
}

function appendRelativePath(parentPath: string, name: string) {
  const part = cleanPathPart(name);
  const path = parentPath ? `${parentPath}/${part}` : part;
  return path.slice(0, MAX_RELATIVE_PATH_LENGTH);
}

function rememberRelativePath(file: File, relativePath: string) {
  // A basename alone is not extra identity. Only files reached below a
  // directory receive a path, so two plain dropped files with the same
  // name/size/time remain distinct inputs.
  if (!relativePath.includes("/")) {
    return;
  }

  const boundedPath = relativePath.slice(0, MAX_RELATIVE_PATH_LENGTH);
  relativePathFallback.set(file, boundedPath);
  try {
    Object.defineProperty(file, TRUEPEAK_RELATIVE_PATH_PROPERTY, {
      configurable: true,
      enumerable: false,
      value: boundedPath,
      writable: false,
    });
  } catch {
    // Some browser File objects are non-extensible. The module-local WeakMap
    // keeps the path available through getDroppedFileRelativePath without
    // copying the File's bytes.
  }
}

export function getDroppedFileRelativePath(file: File) {
  const customPath =
    (file as FileWithTruePeakPath)[TRUEPEAK_RELATIVE_PATH_PROPERTY] ??
    relativePathFallback.get(file) ??
    file.webkitRelativePath;
  if (!customPath) {
    return "";
  }

  const normalized = customPath.replace(/\\/g, "/").slice(0, MAX_RELATIVE_PATH_LENGTH);
  return normalized.includes("/") ? normalized : "";
}

function fileAt(files: FileList, index: number) {
  return files.item(index) ?? files[index] ?? null;
}

function itemAt(items: DataTransferItemList, index: number) {
  return items[index] ?? null;
}

function remainingDeadlineMs(deadlineAt: number) {
  return Math.max(0, Math.ceil(deadlineAt - performance.now()));
}

function readEntriesPage(
  reader: FileSystemDirectoryReader,
  deadlineAt: number,
): Promise<FileSystemEntry[] | null> {
  const remaining = remainingDeadlineMs(deadlineAt);
  if (remaining <= 0) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (entries: FileSystemEntry[] | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(entries);
    };
    const timeoutId = setTimeout(() => finish(null), remaining);
    try {
      reader.readEntries(
        (entries) => finish(entries),
        () => finish(null),
      );
    } catch {
      finish(null);
    }
  });
}

function entryToFile(
  entry: FileSystemFileEntry,
  deadlineAt: number,
): Promise<File | null> {
  const remaining = remainingDeadlineMs(deadlineAt);
  if (remaining <= 0) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(file);
    };
    const timeoutId = setTimeout(() => finish(null), remaining);
    try {
      entry.file(
        (file) => finish(file),
        () => finish(null),
      );
    } catch {
      finish(null);
    }
  });
}

export async function collectDroppedFiles(
  dataTransfer: DataTransfer,
  requestedBudget?: Partial<DropTraversalBudget>,
): Promise<DroppedFilesResult> {
  const budget = resolveTraversalBudget(requestedBudget);
  const deadlineAt = performance.now() + budget.deadlineMs;
  let truncated = false;

  // Snapshot only bounded prefixes synchronously: items and files can become
  // unreadable once the drop handler yields, but spreading either collection
  // first would defeat the cap.
  const flatFiles: File[] = [];
  const flatLength = dataTransfer.files.length;
  for (let index = 0; index < flatLength && flatFiles.length < budget.maxFiles; index += 1) {
    const file = fileAt(dataTransfer.files, index);
    if (file) {
      flatFiles.push(file);
    }
  }
  if (flatLength > flatFiles.length) {
    truncated = true;
  }

  const rootEntries: FileSystemEntry[] = [];
  let entriesVisited = 0;
  const items = dataTransfer.items;
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      if (performance.now() >= deadlineAt || entriesVisited >= budget.maxEntries) {
        truncated = true;
        break;
      }

      const item = itemAt(items, index);
      if (!item || item.kind !== "file") {
        continue;
      }
      entriesVisited += 1;
      let entry: FileSystemEntry | null = null;
      try {
        entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      } catch {
        // Fall back to the bounded FileList snapshot below.
      }
      if (entry) {
        rootEntries.push(entry);
      }
    }
  }

  if (!rootEntries.length) {
    return { files: flatFiles, truncated };
  }

  const collected: File[] = [];

  const walk = async (
    entry: FileSystemEntry,
    depth: number,
    parentPath: string,
    alreadyCounted = false,
  ): Promise<void> => {
    if (
      collected.length >= budget.maxFiles ||
      performance.now() >= deadlineAt
    ) {
      truncated = true;
      return;
    }
    if (!alreadyCounted) {
      if (entriesVisited >= budget.maxEntries) {
        truncated = true;
        return;
      }
      entriesVisited += 1;
    }

    const relativePath = appendRelativePath(parentPath, entry.name);
    if (entry.isFile) {
      const file = await entryToFile(entry as FileSystemFileEntry, deadlineAt);
      if (!file) {
        truncated = true;
        return;
      }
      rememberRelativePath(file, relativePath);
      collected.push(file);
      return;
    }

    if (!entry.isDirectory) {
      return;
    }
    if (depth >= budget.maxDepth) {
      truncated = true;
      return;
    }

    let reader: FileSystemDirectoryReader;
    try {
      reader = (entry as FileSystemDirectoryEntry).createReader();
    } catch {
      truncated = true;
      return;
    }

    let pagesRead = 0;
    while (pagesRead < budget.maxDirectoryPages) {
      if (
        collected.length >= budget.maxFiles ||
        entriesVisited >= budget.maxEntries ||
        performance.now() >= deadlineAt
      ) {
        truncated = true;
        return;
      }

      const page = await readEntriesPage(reader, deadlineAt);
      if (page == null) {
        truncated = true;
        return;
      }
      pagesRead += 1;
      if (page.length === 0) {
        return;
      }

      // Consume this page directly. Do not spread it into a directory-wide
      // accumulator or request another page before the current one is done.
      for (let index = 0; index < page.length; index += 1) {
        if (
          collected.length >= budget.maxFiles ||
          entriesVisited >= budget.maxEntries ||
          performance.now() >= deadlineAt
        ) {
          truncated = true;
          return;
        }
        await walk(page[index], depth + 1, relativePath);
      }
    }

    truncated = true;
  };

  for (const entry of rootEntries) {
    if (
      collected.length >= budget.maxFiles ||
      performance.now() >= deadlineAt
    ) {
      truncated = true;
      break;
    }
    await walk(entry, 0, "", true);
  }

  if (!collected.length && flatFiles.length) {
    return { files: flatFiles, truncated };
  }

  return { files: collected, truncated };
}
