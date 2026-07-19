// IndexedDB persistence for the live session's completed results, so a hard
// refresh (or an accidental tab close) does not discard a finished batch.
//
// The store deliberately reports storage outcomes instead of treating a
// missing/blocked database as a successful write. Scheduling, retries, and
// clear-vs-write ordering live in live-session-controller.ts; this module is a
// single-attempt adapter around IndexedDB transactions.
//
// Schema v2 (D5) adds a createdAt index and a quarantine store. Restore reads
// the index newest-first with a bounded cursor (never a getAll of the whole
// store) and stops at the session limit; records that fail validation are moved
// into quarantine instead of being deleted, and valid records beyond the limit
// are left in place untouched. The v1 -> v2 upgrade preserves every existing
// record and backfills a createdAt for any record missing one so the new index
// can see it.
import {
  MAX_SESSION_JOBS,
  normalizeSessionJob,
  resolveAnalysisProvenance,
} from "@/audio/session-file";
import type { AnalysisJob } from "@/types/audio";

const DB_NAME = "truepeak-live-session";
// Bumped to 2 for the createdAt index that powers the bounded newest-first
// restore and the quarantine store that holds records failing validation.
const DB_VERSION = 2;
const STORE_NAME = "jobs";
const CREATED_AT_INDEX = "createdAt";
const QUARANTINE_STORE_NAME = "quarantine";
// Restore never surfaces more than the portable-session limit; the cursor stops
// here instead of scanning or loading the whole store into memory at once.
const RESTORE_LIMIT = MAX_SESSION_JOBS;

export type LiveSessionStoreOperation = "open" | "read" | "write" | "delete" | "clear";
export type LiveSessionStoreProblemStatus = "unavailable" | "blocked" | "failed";

export interface LiveSessionStoreProblem<
  Operation extends LiveSessionStoreOperation = LiveSessionStoreOperation,
> {
  operation: Operation;
  status: LiveSessionStoreProblemStatus;
  message: string;
}

interface LiveSessionStoreOpenSuccess {
  operation: "open";
  status: "committed";
  database: IDBDatabase;
}

type LiveSessionStoreOpenOutcome =
  | LiveSessionStoreOpenSuccess
  | LiveSessionStoreProblem<"open">;

export type LiveSessionMutationOperation = "write" | "delete" | "clear";

export type LiveSessionMutationOutcome<
  Operation extends LiveSessionMutationOperation = LiveSessionMutationOperation,
> =
  | {
      operation: Operation;
      status: "committed";
      /** Number of requested records affected; clear uses zero. */
      count: number;
    }
  | {
      operation: Operation;
      status: "empty";
      count: 0;
    }
  | LiveSessionStoreProblem<Operation>;

export type LiveSessionReadOutcome =
  | {
      operation: "read";
      status: "committed" | "empty";
      jobs: AnalysisJob[];
      /** Records present in the live store when the bounded restore began. */
      totalRecordCount: number;
      /**
       * Records that failed the shared untrusted-session normalizer and were
       * moved into the quarantine store during this restore (never deleted).
       */
      invalidRecordCount: number;
      /**
       * Records left untouched in the live store beyond the restore cap: the
       * cursor stops once the cap is filled and never visits or deletes them.
       */
      overflowRecordCount: number;
    }
  | LiveSessionStoreProblem<"read">;

export interface LiveSessionStore {
  read(): Promise<LiveSessionReadOutcome>;
  write(jobs: AnalysisJob[]): Promise<LiveSessionMutationOutcome<"write">>;
  delete(jobIds: string[]): Promise<LiveSessionMutationOutcome<"delete">>;
  clear(): Promise<LiveSessionMutationOutcome<"clear">>;
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error) {
    return error;
  }
  return fallback;
}

function requestError(request: IDBRequest, fallback: string): string {
  try {
    return describeError(request.error, fallback);
  } catch {
    return fallback;
  }
}

function hasUsableCreatedAt(record: Record<string, unknown>): boolean {
  return typeof record.createdAt === "string" && record.createdAt.length > 0;
}

// A record that lacks a string createdAt is invisible to the createdAt index,
// which would leave it unreachable by the restore cursor: neither restorable nor
// quarantinable. Derive the most faithful timestamp available so the record
// keeps a sensible newest-first position, falling back to the epoch when nothing
// usable exists. Both branches return a canonical ISO string.
const EPOCH_ISO = new Date(0).toISOString();

function deriveCreatedAt(record: Record<string, unknown>): string {
  const result = record.result;
  if (result && typeof result === "object") {
    const analyzedAt = (result as Record<string, unknown>).analyzedAt;
    if (typeof analyzedAt === "string" && Number.isFinite(Date.parse(analyzedAt))) {
      return analyzedAt;
    }
  }
  return EPOCH_ISO;
}

// v1 -> v2 upgrade. Runs inside the open request's versionchange transaction, so
// all of it commits atomically before the connection resolves. It is
// deliberately non-destructive: existing records are preserved, records missing
// a usable createdAt are backfilled so the new index can see them, the createdAt
// index is created, and a quarantine store is added for the restore path. The
// backfill only runs when an existing store is being upgraded; a freshly created
// store has nothing to migrate.
function migrateLiveSessionDatabase(request: IDBOpenDBRequest): void {
  const database = request.result;
  const transaction = request.transaction;

  let store: IDBObjectStore;
  let hadExistingStore: boolean;
  if (database.objectStoreNames.contains(STORE_NAME)) {
    if (!transaction) {
      throw new Error(
        "Live-session upgrade is missing its versionchange transaction.",
      );
    }
    store = transaction.objectStore(STORE_NAME);
    hadExistingStore = true;
  } else {
    store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
    hadExistingStore = false;
  }

  if (!store.indexNames.contains(CREATED_AT_INDEX)) {
    store.createIndex(CREATED_AT_INDEX, "createdAt", { unique: false });
  }

  if (hadExistingStore) {
    // Creating the index above only captures records that already have a
    // createdAt. Walk the existing records and backfill the rest so the update
    // adds them to the index too; no record is dropped as a migration side
    // effect.
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const record = cursor.value as Record<string, unknown> | null | undefined;
      if (record && typeof record === "object" && !hasUsableCreatedAt(record)) {
        cursor.update({ ...record, createdAt: deriveCreatedAt(record) });
      }
      cursor.continue();
    };
  }

  if (!database.objectStoreNames.contains(QUARANTINE_STORE_NAME)) {
    database.createObjectStore(QUARANTINE_STORE_NAME, { keyPath: "id" });
  }
}

// A blocked open request can later succeed after this promise has already
// reported `blocked`. Keep the success handler alive and close that late
// connection instead of leaking an unowned database handle. Every owned
// connection also closes itself when another tab requests a version upgrade.
function openDatabase(): Promise<LiveSessionStoreOpenOutcome> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve({
      operation: "open",
      status: "unavailable",
      message: "IndexedDB is not available in this environment.",
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let upgradeError: unknown;

    const finish = (outcome: LiveSessionStoreOpenOutcome) => {
      if (settled) {
        if (outcome.status === "committed") {
          outcome.database.close();
        }
        return;
      }

      settled = true;
      resolve(outcome);
    };

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        try {
          migrateLiveSessionDatabase(request);
        } catch (error) {
          upgradeError = error;
          try {
            request.transaction?.abort();
          } catch {
            // The open request's error handler remains the authoritative result.
          }
        }
      };

      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        finish({ operation: "open", status: "committed", database });
      };

      request.onerror = () => {
        finish({
          operation: "open",
          status: "failed",
          message: describeError(
            upgradeError,
            requestError(request, "IndexedDB could not be opened."),
          ),
        });
      };

      request.onblocked = () => {
        finish({
          operation: "open",
          status: "blocked",
          message: "IndexedDB is blocked by another open TruePeak tab.",
        });
      };
    } catch (error) {
      finish({
        operation: "open",
        status: "failed",
        message: describeError(error, "IndexedDB could not be opened."),
      });
    }
  });
}

function mapOpenProblem<Operation extends Exclude<LiveSessionStoreOperation, "open">>(
  operation: Operation,
  outcome: LiveSessionStoreProblem<"open">,
): LiveSessionStoreProblem<Operation> {
  return {
    operation,
    status: outcome.status,
    message: outcome.message,
  };
}

async function withDatabase<
  Operation extends Exclude<LiveSessionStoreOperation, "open">,
  Outcome,
>(
  operation: Operation,
  run: (database: IDBDatabase) => Promise<Outcome>,
): Promise<Outcome | LiveSessionStoreProblem<Operation>> {
  const opened = await openDatabase();
  if (opened.status !== "committed") {
    return mapOpenProblem(operation, opened);
  }

  try {
    return await run(opened.database);
  } catch (error) {
    return {
      operation,
      status: "failed",
      message: describeError(error, `IndexedDB ${operation} failed.`),
    };
  } finally {
    opened.database.close();
  }
}

// A write is committed only when the transaction's complete event fires.
// Request success is intentionally insufficient: the transaction may still be
// aborted later (for example under quota pressure).
function runWrite<Operation extends LiveSessionMutationOperation>(
  database: IDBDatabase,
  operation: Operation,
  count: number,
  apply: (store: IDBObjectStore) => void,
): Promise<LiveSessionMutationOutcome<Operation>> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (outcome: LiveSessionMutationOutcome<Operation>) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");

      transaction.oncomplete = () => {
        finish({ operation, status: "committed", count });
      };
      transaction.onerror = () => {
        finish({
          operation,
          status: "failed",
          message: describeError(transaction.error, `IndexedDB ${operation} failed.`),
        });
      };
      transaction.onabort = () => {
        finish({
          operation,
          status: "failed",
          message: describeError(transaction.error, `IndexedDB ${operation} was aborted.`),
        });
      };

      try {
        apply(transaction.objectStore(STORE_NAME));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The explicit failed outcome below still settles the operation.
        }
        finish({
          operation,
          status: "failed",
          message: describeError(error, `IndexedDB ${operation} failed.`),
        });
      }
    } catch (error) {
      finish({
        operation,
        status: "failed",
        message: describeError(error, `IndexedDB ${operation} failed.`),
      });
    }
  });
}

export async function writeLiveSessionJobs(
  jobs: AnalysisJob[],
): Promise<LiveSessionMutationOutcome<"write">> {
  const withResults = jobs.filter(
    (job): job is AnalysisJob & { result: NonNullable<AnalysisJob["result"]> } =>
      job.result != null,
  );
  if (!withResults.length) {
    return { operation: "write", status: "empty", count: 0 };
  }

  return withDatabase("write", (database) =>
    runWrite(database, "write", withResults.length, (store) => {
      withResults.forEach((job) => {
        const record = {
          id: job.id,
          fileName: job.fileName,
          mimeType: job.mimeType,
          createdAt: job.createdAt,
          provenance: resolveAnalysisProvenance(job),
          result: job.result,
        };
        store.put(
          // A record whose createdAt is not a usable ISO string would be
          // invisible to the createdAt index: counted by count(), but never
          // restored, never quarantined, and reported as permanent phantom
          // overflow. Every current caller supplies a valid ISO string; this
          // guard keeps that invariant if a future job-creation path slips.
          hasUsableCreatedAt(record) ? record : { ...record, createdAt: deriveCreatedAt(record) },
        );
      });
    }),
  );
}

export async function deleteLiveSessionJobs(
  jobIds: string[],
): Promise<LiveSessionMutationOutcome<"delete">> {
  const uniqueJobIds = [...new Set(jobIds.filter((jobId) => jobId.length > 0))];
  if (!uniqueJobIds.length) {
    return { operation: "delete", status: "empty", count: 0 };
  }

  return withDatabase("delete", (database) =>
    runWrite(database, "delete", uniqueJobIds.length, (store) => {
      uniqueJobIds.forEach((jobId) => store.delete(jobId));
    }),
  );
}

export async function clearLiveSessionStore(): Promise<
  LiveSessionMutationOutcome<"clear">
> {
  return withDatabase("clear", (database) =>
    // Clear has no reliable affected-row count without an additional read. Its
    // success signal is exclusively the transaction's confirmed commit.
    runWrite(database, "clear", 0, (store) => store.clear()),
  );
}

export async function readLiveSessionJobs(): Promise<LiveSessionReadOutcome> {
  return withDatabase("read", (database) =>
    new Promise<LiveSessionReadOutcome>((resolve) => {
      let settled = false;
      const jobs: AnalysisJob[] = [];
      let totalRecordCount = 0;
      let quarantinedCount = 0;

      const finish = (outcome: LiveSessionReadOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      try {
        // readwrite: invalid records are *moved* into the quarantine store, so
        // the restore (surfaced jobs plus quarantine moves) commits or rolls
        // back as one atomic transaction.
        const transaction = database.transaction(
          [STORE_NAME, QUARANTINE_STORE_NAME],
          "readwrite",
        );
        const store = transaction.objectStore(STORE_NAME);
        const quarantine = transaction.objectStore(QUARANTINE_STORE_NAME);
        const index = store.index(CREATED_AT_INDEX);

        // count() is a key-only tally; it never deserializes record values, so
        // it stays cheap even for a store far larger than the restore cap. It is
        // issued before the cursor advances, so it reflects the pre-restore
        // total rather than the post-quarantine store size.
        const countRequest = store.count();
        countRequest.onsuccess = () => {
          totalRecordCount =
            typeof countRequest.result === "number" ? countRequest.result : 0;
        };

        // Newest-first, bounded restore. The cursor walks the createdAt index in
        // reverse and stops as soon as the cap is filled: overflow records are
        // never visited, loaded, or deleted, which avoids the whole-store scan
        // and the all-records-in-memory blow-up of the previous getAll().
        const cursorRequest = index.openCursor(null, "prev");
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return; // exhausted; oncomplete finalizes the outcome

          const record = cursor.value;
          const job = normalizeSessionJob(record);
          if (job) {
            jobs.push({
              ...job,
              progressLabel: "Restored",
              restored: true,
              ...(job.provenance?.kind === "unverified-import"
                ? { imported: true }
                : {}),
            });
            if (jobs.length >= RESTORE_LIMIT) {
              return; // cap filled: leave the remaining overflow untouched
            }
            cursor.continue();
            return;
          }

          // Invalid record: move it (copy into quarantine, then remove from the
          // live store) rather than deleting it or silently leaving it behind.
          quarantine.put(record);
          cursor.delete();
          quarantinedCount += 1;
          cursor.continue();
        };
        cursorRequest.onerror = () => {
          // The transaction abort/error handler provides the final outcome.
        };

        transaction.onerror = () => {
          finish({
            operation: "read",
            status: "failed",
            message: describeError(transaction.error, "IndexedDB read failed."),
          });
        };
        transaction.onabort = () => {
          finish({
            operation: "read",
            status: "failed",
            message: describeError(transaction.error, "IndexedDB read was aborted."),
          });
        };
        transaction.oncomplete = () => {
          // Overflow is what the cursor never touched: total minus surfaced
          // minus quarantined. When the cursor ran to the end this is 0; when it
          // stopped at the cap it is the untouched tail left in the store.
          const overflowRecordCount = Math.max(
            0,
            totalRecordCount - jobs.length - quarantinedCount,
          );
          finish({
            operation: "read",
            status: jobs.length > 0 ? "committed" : "empty",
            jobs,
            totalRecordCount,
            invalidRecordCount: quarantinedCount,
            overflowRecordCount,
          });
        };
      } catch (error) {
        finish({
          operation: "read",
          status: "failed",
          message: describeError(error, "IndexedDB read failed."),
        });
      }
    }),
  );
}

export const indexedDbLiveSessionStore: LiveSessionStore = {
  read: readLiveSessionJobs,
  write: writeLiveSessionJobs,
  delete: deleteLiveSessionJobs,
  clear: clearLiveSessionStore,
};

// Compatibility adapters for the existing hook. They intentionally report
// unavailable/blocked/failed writes as false; the Phase 2 hook integration can
// switch to indexedDbLiveSessionStore + LiveSessionController for full status
// visibility and autonomous retries.
export async function persistLiveSessionJobs(jobs: AnalysisJob[]): Promise<boolean> {
  const outcome = await writeLiveSessionJobs(jobs);
  return outcome.status === "committed" || outcome.status === "empty";
}

export async function removeLiveSessionJobs(jobIds: string[]): Promise<boolean> {
  const outcome = await deleteLiveSessionJobs(jobIds);
  return outcome.status === "committed" || outcome.status === "empty";
}

export async function clearLiveSession(): Promise<LiveSessionMutationOutcome<"clear">> {
  return clearLiveSessionStore();
}

export async function loadLiveSessionJobs(): Promise<AnalysisJob[]> {
  const outcome = await readLiveSessionJobs();
  return outcome.status === "committed" || outcome.status === "empty" ? outcome.jobs : [];
}
