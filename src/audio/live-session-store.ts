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
//
// The database is a single origin-wide store, so concurrent tabs share it. Each
// record therefore carries per-tab ownership (ownerId + heartbeatMs); every
// mutation is scoped so a tab can only ever overwrite, delete, or clear records
// it owns or that a crashed/closed peer left behind. See the ownership section
// below.
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

// ---------------------------------------------------------------------------
// Cross-tab ownership (finding [4]).
//
// Two tabs open on the same origin share this one database. Without ownership,
// a Clear Session or a job removal in one tab wipes/deletes records another tab
// persisted, destroying that peer's only crash-recovery copy. Every record this
// tab writes is stamped with a per-tab ownerId and a heartbeatMs timestamp:
//
//   * ownerId is minted once per tab and kept in sessionStorage, so it survives
//     a same-tab hard refresh (the store's primary purpose) yet is distinct in
//     any other tab and gone once a tab closes.
//   * A tab may overwrite/delete/clear ONLY records it owns, legacy rows with no
//     owner (pre-ownership data, treated as stale-owned), or foreign rows whose
//     heartbeat has gone stale (a crashed/closed peer). A foreign row with a
//     fresh heartbeat is a live peer's and is left strictly untouched.
//   * Restore SURFACES every valid row view-only (showing a completed result
//     mutates nothing), and adopts own/stale/legacy rows by re-stamping them. A
//     live peer's fresh row is surfaced but left owned by the peer -- only the
//     mutating write/delete/clear paths withhold it. Surfacing (not withholding)
//     on restore is what keeps single-tab recovery working after an accidental
//     close: the per-tab ownerId dies with the tab, so within the stale window
//     the reopened tab's OWN just-closed rows are indistinguishable from a live
//     peer's; withholding them there would silently discard the finished batch.
//   * heartbeatMs is refreshed on every write and, while the tab is open, by a
//     periodic timer, so an active tab's rows never look crashed to a peer.
const OWNER_STORAGE_KEY = "truepeak-live-session-owner";
// A tab with no usable sessionStorage (private mode, storage disabled) shares
// this fixed id. That disables cross-tab protection for such a tab -- matching
// the pre-ownership behaviour, so it is no worse than before -- but the id is
// identical on the next load, so same-tab refresh recovery still works.
const FALLBACK_OWNER_ID = "truepeak-live-session-fallback-owner";
// A foreign record whose owner has not refreshed within this window is treated
// as a crashed/closed tab's leftover: adoptable. Two minutes rides out a
// backgrounded or GC-paused tab and a slow write cycle, yet reclaims a genuinely
// dead tab's copy promptly. Active tabs refresh well inside it.
const STALE_AFTER_MS = 2 * 60 * 1000;
// Comfortably under half the stale window, so an active tab refreshes at least
// twice before it could be judged stale even if a tick is missed.
const HEARTBEAT_INTERVAL_MS = 45 * 1000;

export interface LiveSessionOwnershipOptions {
  /** Overrides the sessionStorage-derived tab id. Injected by tests. */
  ownerId?: string;
  /** Overrides Date.now() for deterministic heartbeats. Injected by tests. */
  now?: number;
  /** Overrides the staleness window. Injected by tests. */
  staleAfterMs?: number;
}

let cachedOwnerId: string | null = null;

function mintOwnerId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // crypto access can throw in locked-down contexts; fall through.
  }
  return `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// This tab's id: a sessionStorage-persisted uuid when possible, else a fixed
// shared fallback. Cached so every operation in one page uses a single id.
function resolveOwnerId(): string {
  if (cachedOwnerId != null) {
    return cachedOwnerId;
  }
  try {
    if (typeof sessionStorage !== "undefined") {
      const existing = sessionStorage.getItem(OWNER_STORAGE_KEY);
      if (typeof existing === "string" && existing.length > 0) {
        cachedOwnerId = existing;
        return existing;
      }
      const minted = mintOwnerId();
      sessionStorage.setItem(OWNER_STORAGE_KEY, minted);
      cachedOwnerId = minted;
      return minted;
    }
  } catch {
    // sessionStorage can be unavailable or throw (private mode, quota). Use the
    // fixed fallback so recovery still degrades gracefully.
  }
  cachedOwnerId = FALLBACK_OWNER_ID;
  return cachedOwnerId;
}

function recordOwnerId(record: Record<string, unknown>): string | null {
  const ownerId = record.ownerId;
  return typeof ownerId === "string" && ownerId.length > 0 ? ownerId : null;
}

function recordHeartbeat(record: Record<string, unknown>): number | null {
  const heartbeat = record.heartbeatMs;
  return typeof heartbeat === "number" && Number.isFinite(heartbeat) ? heartbeat : null;
}

// Whether this tab may restore, overwrite, or delete a record: one it owns, a
// legacy row with no owner, or a foreign row whose heartbeat has gone stale. The
// sole protected case is a foreign row with a fresh heartbeat -- a live peer's,
// which must never be touched.
function isClaimable(
  record: Record<string, unknown>,
  ownerId: string,
  now: number,
  staleAfterMs: number,
): boolean {
  const owner = recordOwnerId(record);
  if (owner === null) {
    return true; // legacy row: stale-owned, adoptable + migratable
  }
  if (owner === ownerId) {
    return true; // our own row: always claimable regardless of heartbeat
  }
  const heartbeat = recordHeartbeat(record);
  if (heartbeat === null) {
    return true; // owned but unheartbeated: cannot prove a live peer, so adopt
  }
  return now - heartbeat > staleAfterMs;
}

function stampOwnership<T extends Record<string, unknown>>(
  record: T,
  ownerId: string,
  now: number,
): T & { ownerId: string; heartbeatMs: number } {
  return { ...record, ownerId, heartbeatMs: now };
}

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

// A mutation is committed only when the transaction's complete event fires.
// Request success is intentionally insufficient: the transaction may still be
// aborted later (for example under quota pressure). `apply` drives the requests
// and reports how many records it actually mutated through the shared counter,
// because ownership scoping means the affected count is only known after the
// per-record ownership checks resolve, not up front.
function runMutation<Operation extends LiveSessionMutationOperation>(
  database: IDBDatabase,
  operation: Operation,
  apply: (store: IDBObjectStore, committed: { count: number }) => void,
): Promise<LiveSessionMutationOutcome<Operation>> {
  return new Promise((resolve) => {
    let settled = false;
    const committed = { count: 0 };

    const finish = (outcome: LiveSessionMutationOutcome<Operation>) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");

      transaction.oncomplete = () => {
        finish({ operation, status: "committed", count: committed.count });
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
        apply(transaction.objectStore(STORE_NAME), committed);
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
  options: LiveSessionOwnershipOptions = {},
): Promise<LiveSessionMutationOutcome<"write">> {
  const withResults = jobs.filter(
    (job): job is AnalysisJob & { result: NonNullable<AnalysisJob["result"]> } =>
      job.result != null,
  );
  if (!withResults.length) {
    return { operation: "write", status: "empty", count: 0 };
  }

  const ownerId = options.ownerId ?? resolveOwnerId();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  // Keep this tab's rows looking alive to peers for as long as it stays open.
  ensureHeartbeatTimer();

  return withDatabase("write", (database) =>
    runMutation(database, "write", (store, committed) => {
      withResults.forEach((job) => {
        const base = {
          id: job.id,
          fileName: job.fileName,
          mimeType: job.mimeType,
          createdAt: job.createdAt,
          provenance: resolveAnalysisProvenance(job),
          result: job.result,
        };
        // A record whose createdAt is not a usable ISO string would be invisible
        // to the createdAt index: counted by count(), but never restored, never
        // quarantined, and reported as permanent phantom overflow. Every current
        // caller supplies a valid ISO string; this guard keeps that invariant if
        // a future job-creation path slips.
        const withCreatedAt = hasUsableCreatedAt(base)
          ? base
          : { ...base, createdAt: deriveCreatedAt(base) };
        const record = stampOwnership(withCreatedAt, ownerId, now);

        // Read-before-write: never overwrite a live peer's row. Own, legacy, and
        // stale rows are claimable and receive this tab's fresh ownership stamp.
        const existingRequest = store.get(job.id);
        existingRequest.onsuccess = () => {
          const existing = existingRequest.result as Record<string, unknown> | undefined;
          if (!existing || isClaimable(existing, ownerId, now, staleAfterMs)) {
            store.put(record);
            committed.count += 1;
          }
        };
      });
    }),
  );
}

export async function deleteLiveSessionJobs(
  jobIds: string[],
  options: LiveSessionOwnershipOptions = {},
): Promise<LiveSessionMutationOutcome<"delete">> {
  const uniqueJobIds = [...new Set(jobIds.filter((jobId) => jobId.length > 0))];
  if (!uniqueJobIds.length) {
    return { operation: "delete", status: "empty", count: 0 };
  }

  const ownerId = options.ownerId ?? resolveOwnerId();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;

  return withDatabase("delete", (database) =>
    runMutation(database, "delete", (store, committed) => {
      uniqueJobIds.forEach((jobId) => {
        // Read-before-delete: only remove a row this tab owns or that a crashed
        // peer left behind. A live peer's recovery copy is left in place.
        const existingRequest = store.get(jobId);
        existingRequest.onsuccess = () => {
          const existing = existingRequest.result as Record<string, unknown> | undefined;
          if (existing && isClaimable(existing, ownerId, now, staleAfterMs)) {
            store.delete(jobId);
            committed.count += 1;
          }
        };
      });
    }),
  );
}

export async function clearLiveSessionStore(
  options: LiveSessionOwnershipOptions = {},
): Promise<LiveSessionMutationOutcome<"clear">> {
  const ownerId = options.ownerId ?? resolveOwnerId();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;

  return withDatabase("clear", (database) =>
    // Scoped clear: remove this tab's own rows plus adoptable stale/legacy rows
    // (opportunistic cleanup of crashed-tab and pre-ownership leftovers), but
    // leave live peers' rows intact. A blind store.clear() here would destroy
    // another open tab's only crash-recovery copy. Success is exclusively the
    // transaction's confirmed commit; the count reports rows actually removed.
    runMutation(database, "clear", (store, committed) => {
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          return;
        }
        const record = cursor.value as Record<string, unknown> | null | undefined;
        if (
          record &&
          typeof record === "object" &&
          isClaimable(record, ownerId, now, staleAfterMs)
        ) {
          cursor.delete();
          committed.count += 1;
        }
        cursor.continue();
      };
    }),
  );
}

export async function readLiveSessionJobs(
  options: LiveSessionOwnershipOptions = {},
): Promise<LiveSessionReadOutcome> {
  const ownerId = options.ownerId ?? resolveOwnerId();
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;

  return withDatabase("read", (database) =>
    new Promise<LiveSessionReadOutcome>((resolve) => {
      let settled = false;
      const jobs: AnalysisJob[] = [];
      let totalRecordCount = 0;
      let quarantinedCount = 0;
      // Invalid rows a live peer owns: left strictly in place (not restored,
      // quarantined, or deleted) and excluded from the overflow tally. VALID
      // live-peer rows are surfaced view-only rather than skipped, so they land
      // in `jobs`, not here.
      let skippedForeignCount = 0;

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
          // Restore is a VIEW-ONLY surface: showing a completed result never
          // mutates the stored row, so a live peer's row can be surfaced without
          // harming the peer. Claimability therefore gates only the two mutating
          // steps below (adopt-restamp and quarantine-delete), never whether a
          // valid row is restored. Withholding foreign-fresh rows here would
          // break single-tab recovery after an accidental close/crash: the
          // per-tab sessionStorage ownerId dies with the tab, so within the stale
          // window the just-closed tab's OWN rows look exactly like a live peer's
          // and would be silently dropped from the reopened tab's session.
          const claimable =
            record && typeof record === "object"
              ? isClaimable(record as Record<string, unknown>, ownerId, now, staleAfterMs)
              : true;

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
            // Adopt legacy, crashed-peer, and own rows by claiming ownership, so
            // a second tab cannot also adopt the same row; rows we already own are
            // effectively re-stamped fresh too. A live peer's fresh row is
            // surfaced above but deliberately NOT re-stamped -- leaving the peer
            // its ownership and thus its delete/clear authority over the row.
            if (claimable && recordOwnerId(record as Record<string, unknown>) !== ownerId) {
              cursor.update(stampOwnership(record as Record<string, unknown>, ownerId, now));
            }
            if (jobs.length >= RESTORE_LIMIT) {
              return; // cap filled: leave the remaining overflow untouched
            }
            cursor.continue();
            return;
          }

          // Invalid record. Quarantine (copy out, then delete from the live
          // store) only when this tab may claim it; a live peer's invalid row is
          // left strictly in place so quarantine never touches another tab's
          // data. Peer rows left in place are tallied so the overflow accounting
          // below stays exact.
          if (claimable) {
            quarantine.put(record);
            cursor.delete();
            quarantinedCount += 1;
          } else {
            skippedForeignCount += 1;
          }
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
          // Overflow is what the cursor never touched: total minus surfaced,
          // minus quarantined, minus live peers' invalid rows left in place. When
          // the cursor ran to the end this is 0; when it stopped at the cap it is
          // the untouched tail left in the store.
          const overflowRecordCount = Math.max(
            0,
            totalRecordCount - jobs.length - quarantinedCount - skippedForeignCount,
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

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// While the tab is open, refresh its own rows' heartbeats so a peer never
// mistakes an idle-but-live tab for a crashed one. Started lazily on the first
// write and only in a browser, so a background/read-only tab pays nothing and a
// Node test never starts a timer.
function ensureHeartbeatTimer(): void {
  if (heartbeatTimer !== null || typeof window === "undefined") {
    return;
  }
  heartbeatTimer = setInterval(() => {
    void refreshLiveSessionHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

// Refresh heartbeatMs on every row this tab owns, in a single transaction; a
// no-op when the tab owns nothing. Only own rows are touched, so it can never
// resurrect a cleared row or disturb a peer's data. Exported so tests can drive
// it deterministically; production calls it from the periodic timer above.
export async function refreshLiveSessionHeartbeat(
  options: LiveSessionOwnershipOptions = {},
): Promise<LiveSessionMutationOutcome<"write">> {
  const ownerId = options.ownerId ?? resolveOwnerId();
  const now = options.now ?? Date.now();

  return withDatabase("write", (database) =>
    runMutation(database, "write", (store, committed) => {
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          return;
        }
        const record = cursor.value as Record<string, unknown> | null | undefined;
        if (record && typeof record === "object" && recordOwnerId(record) === ownerId) {
          cursor.update({ ...record, heartbeatMs: now });
          committed.count += 1;
        }
        cursor.continue();
      };
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
