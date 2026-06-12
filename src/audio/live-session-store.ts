// IndexedDB persistence for the live session's completed results, so a hard
// refresh (or an accidental tab close) no longer discards a finished batch.
// Only results are stored — File handles can't persist, so restored jobs are
// view-only, exactly like jobs imported from a session file. Every record read
// back goes through the same whitelist validator as untrusted session files:
// IndexedDB is same-origin, but treating stored bytes as trusted is how
// corruption (or any future origin-level compromise) turns into a crash.
import { MAX_SESSION_JOBS, normalizeSessionJob } from "@/audio/session-file";
import type { AnalysisJob } from "@/types/audio";

const DB_NAME = "truepeak-live-session";
const DB_VERSION = 1;
const STORE_NAME = "jobs";

// Persistence is best-effort everywhere: private browsing modes and storage
// pressure can deny IndexedDB, and analysis must keep working without it.
function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function runWrite(
  db: IDBDatabase,
  apply: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      apply(transaction.objectStore(STORE_NAME));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function persistLiveSessionJobs(jobs: AnalysisJob[]): Promise<void> {
  const withResults = jobs.filter((job) => job.result);
  if (!withResults.length) {
    return;
  }

  const db = await openDatabase();
  if (!db) {
    return;
  }

  try {
    await runWrite(db, (store) => {
      withResults.forEach((job) => {
        store.put({
          id: job.id,
          fileName: job.fileName,
          mimeType: job.mimeType,
          createdAt: job.createdAt,
          result: job.result,
        });
      });
    });
  } finally {
    db.close();
  }
}

export async function removeLiveSessionJobs(jobIds: string[]): Promise<void> {
  if (!jobIds.length) {
    return;
  }

  const db = await openDatabase();
  if (!db) {
    return;
  }

  try {
    await runWrite(db, (store) => {
      jobIds.forEach((jobId) => store.delete(jobId));
    });
  } finally {
    db.close();
  }
}

export async function clearLiveSession(): Promise<void> {
  const db = await openDatabase();
  if (!db) {
    return;
  }

  try {
    await runWrite(db, (store) => store.clear());
  } finally {
    db.close();
  }
}

export async function loadLiveSessionJobs(): Promise<AnalysisJob[]> {
  const db = await openDatabase();
  if (!db) {
    return [];
  }

  try {
    const records = await new Promise<unknown[]>((resolve) => {
      try {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });

    const jobs: AnalysisJob[] = [];
    for (const record of records) {
      if (jobs.length >= MAX_SESSION_JOBS) {
        break;
      }

      const job = normalizeSessionJob(record);
      if (!job) continue;

      jobs.push({ ...job, progressLabel: "Restored", restored: true });
    }

    // Newest first, matching how fresh batches sit in the queue.
    jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return jobs;
  } finally {
    db.close();
  }
}
