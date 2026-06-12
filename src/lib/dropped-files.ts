// Resolves a drop's DataTransfer into a flat list of Files, walking dropped
// folders through the FileSystem entry API where the browser supports it.
// Caps protect against hostile or accidental monster drops (a node_modules
// folder, a whole drive): traversal stops at the file cap and depth limit and
// reports that it did, so the UI can say so instead of silently truncating.

export const MAX_DROPPED_FILES = 2000;
const MAX_DIRECTORY_DEPTH = 12;

export interface DroppedFilesResult {
  files: File[];
  truncated: boolean;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = [];
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(all);
            return;
          }

          all.push(...batch);
          // readEntries returns at most ~100 entries per call; keep going
          // until it hands back an empty batch.
          step();
        },
        () => resolve(all),
      );
    };
    step();
  });
}

function entryToFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

export async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFilesResult> {
  // Snapshot everything synchronously: items and files become unreadable in
  // some browsers once the drop handler yields to the event loop.
  const flatFiles = [...dataTransfer.files];
  const entries = dataTransfer.items
    ? [...dataTransfer.items]
        .filter((item) => item.kind === "file")
        .map((item) =>
          typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null,
        )
    : [];

  // No entry support (or nothing resolved): use the flat list, which already
  // covers plain multi-file drops everywhere.
  if (!entries.some(Boolean)) {
    return {
      files: flatFiles.slice(0, MAX_DROPPED_FILES),
      truncated: flatFiles.length > MAX_DROPPED_FILES,
    };
  }

  const collected: File[] = [];
  let truncated = false;

  const walk = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    if (collected.length >= MAX_DROPPED_FILES) {
      truncated = true;
      return;
    }

    if (entry.isFile) {
      const file = await entryToFile(entry as FileSystemFileEntry);
      if (file) {
        collected.push(file);
      }
      return;
    }

    if (entry.isDirectory) {
      if (depth >= MAX_DIRECTORY_DEPTH) {
        truncated = true;
        return;
      }

      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
      for (const child of children) {
        if (collected.length >= MAX_DROPPED_FILES) {
          truncated = true;
          return;
        }

        await walk(child, depth + 1);
      }
    }
  };

  for (const entry of entries) {
    if (!entry) continue;
    if (collected.length >= MAX_DROPPED_FILES) {
      truncated = true;
      break;
    }

    await walk(entry, 0);
  }

  // Defensive: if entry traversal produced nothing but the flat list has
  // files (odd browser behaviour), fall back to the snapshot.
  if (!collected.length && flatFiles.length) {
    return {
      files: flatFiles.slice(0, MAX_DROPPED_FILES),
      truncated: truncated || flatFiles.length > MAX_DROPPED_FILES,
    };
  }

  return { files: collected, truncated };
}
