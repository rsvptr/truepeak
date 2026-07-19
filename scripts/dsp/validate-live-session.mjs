import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import ts from "typescript";

// The controller has runtime dependency injection and type-only project
// imports, so it can be transpiled in memory and exercised without a browser,
// React, a generated build artifact, or an IndexedDB polyfill.
const controllerUrl = new URL("../../src/audio/live-session-controller.ts", import.meta.url);
const controllerSource = await readFile(controllerUrl, "utf8");
const transpiled = ts.transpileModule(controllerSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "live-session-controller.ts",
  reportDiagnostics: true,
});

const transpileErrors = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.equal(transpileErrors.length, 0, "controller should transpile without diagnostics");

const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
const { LiveSessionController } = await import(moduleUrl);

const storeUrl = new URL("../../src/audio/live-session-store.ts", import.meta.url);
const rawStoreSource = await readFile(storeUrl, "utf8");
const testableStoreSource = rawStoreSource.replace(
  /import \{[\s\S]*?\} from "@\/audio\/session-file";/,
  `const MAX_SESSION_JOBS = 1000;
   function normalizeSessionJob(record) { return record?.normalizedJob ?? null; }
   function resolveAnalysisProvenance(job) { return job.provenance ?? { kind: "local-analysis" }; }`,
);
assert.notEqual(testableStoreSource, rawStoreSource, "store test shim should replace the runtime alias import");
const transpiledStore = ts.transpileModule(testableStoreSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "live-session-store.ts",
  reportDiagnostics: true,
});
const storeTranspileErrors = (transpiledStore.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.equal(storeTranspileErrors.length, 0, "store should transpile without diagnostics");
const storeModuleUrl = `data:text/javascript;base64,${Buffer.from(transpiledStore.outputText).toString("base64")}`;
const storeModule = await import(storeModuleUrl);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function completedJob(id, analyzedAt = "2026-07-18T00:00:00.000Z") {
  return { id, result: { analyzedAt } };
}

function committed(operation, count = 0) {
  return { operation, status: "committed", count };
}

function failed(operation, message = "synthetic failure") {
  return { operation, status: "failed", message };
}

function unavailable(operation) {
  return { operation, status: "unavailable", message: "synthetic unavailable" };
}

function emptyRead() {
  return {
    operation: "read",
    status: "empty",
    jobs: [],
    totalRecordCount: 0,
    invalidRecordCount: 0,
    overflowRecordCount: 0,
  };
}

function baseStore(overrides = {}) {
  return {
    read: async () => emptyRead(),
    write: async (jobs) => committed("write", jobs.length),
    delete: async (ids) => committed("delete", ids.length),
    clear: async () => committed("clear"),
    ...overrides,
  };
}

async function withMockIndexedDb(indexedDb, run) {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    writable: true,
    value: indexedDb,
  });
  try {
    await run();
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, "indexedDB", previousDescriptor);
    } else {
      delete globalThis.indexedDB;
    }
  }
}

async function testStoreDistinguishesUnavailableAndEmpty() {
  await withMockIndexedDb(undefined, async () => {
    const job = completedJob("persisted");
    const write = await storeModule.writeLiveSessionJobs([job]);
    const deletion = await storeModule.deleteLiveSessionJobs([job.id]);
    const clear = await storeModule.clearLiveSessionStore();
    const read = await storeModule.readLiveSessionJobs();
    const emptyWrite = await storeModule.writeLiveSessionJobs([]);
    const emptyDelete = await storeModule.deleteLiveSessionJobs([]);

    assert.equal(write.status, "unavailable");
    assert.equal(deletion.status, "unavailable");
    assert.equal(clear.status, "unavailable");
    assert.equal(read.status, "unavailable");
    assert.equal(emptyWrite.status, "empty");
    assert.equal(emptyDelete.status, "empty");
    assert.equal(await storeModule.persistLiveSessionJobs([job]), false);
    assert.equal(await storeModule.removeLiveSessionJobs([job.id]), false);
  });
}

async function testBlockedOpenClosesALateSuccessfulConnection() {
  const openRequest = {};
  let closeCalls = 0;
  const database = {
    close: () => {
      closeCalls += 1;
    },
  };

  await withMockIndexedDb({ open: () => openRequest }, async () => {
    const readPromise = storeModule.readLiveSessionJobs();
    openRequest.onblocked();
    const outcome = await readPromise;
    assert.equal(outcome.status, "blocked");

    openRequest.result = database;
    openRequest.onsuccess();
    assert.equal(closeCalls, 1, "a late connection from a blocked request must be closed");
  });
}

async function testOwnedConnectionClosesOnVersionChange() {
  const openRequest = {};
  // The v2 restore opens a readwrite transaction and drives a createdAt-index
  // cursor plus a count(); none of these requests are fired here, so the
  // transaction stays in flight until the test aborts it by hand.
  const cursorRequest = {};
  const countRequest = {};
  const readStore = {
    index: () => ({ openCursor: () => cursorRequest }),
    count: () => countRequest,
    put: () => ({}),
  };
  const transaction = {
    error: null,
    objectStore: () => readStore,
  };
  let closeCalls = 0;
  const database = {
    close: () => {
      closeCalls += 1;
    },
    transaction: () => transaction,
  };

  await withMockIndexedDb({ open: () => openRequest }, async () => {
    const readPromise = storeModule.readLiveSessionJobs();
    openRequest.result = database;
    openRequest.onsuccess();
    await waitUntil(() => typeof transaction.onabort === "function", "the read transaction to start");

    assert.equal(typeof database.onversionchange, "function");
    database.onversionchange();
    assert.equal(closeCalls, 1, "versionchange should proactively close the owned connection");

    transaction.onabort();
    const outcome = await readPromise;
    assert.equal(outcome.status, "failed");
    assert.equal(closeCalls, 2, "operation cleanup remains idempotent after versionchange close");
  });
}

async function testStorePersistsUnverifiedProvenance() {
  const openRequest = {};
  const storedRecords = [];
  const transaction = {
    error: null,
    objectStore: () => ({
      put: (record) => storedRecords.push(record),
    }),
  };
  const database = {
    close: () => undefined,
    transaction: () => transaction,
  };
  const provenance = {
    kind: "unverified-import",
    sourceJobId: "upstream-job",
    sourceSessionDigest: `sha256:${"ab".repeat(32)}`,
  };

  await withMockIndexedDb({ open: () => openRequest }, async () => {
    const writePromise = storeModule.writeLiveSessionJobs([
      {
        ...completedJob("imported"),
        fileName: "imported.wav",
        mimeType: "audio/wav",
        createdAt: "2026-07-18T00:00:00.000Z",
        imported: true,
        provenance,
      },
    ]);
    openRequest.result = database;
    openRequest.onsuccess();
    await waitUntil(
      () => typeof transaction.oncomplete === "function",
      "the provenance write transaction to start",
    );
    transaction.oncomplete();

    const outcome = await writePromise;
    assert.equal(outcome.status, "committed");
    assert.deepEqual(storedRecords[0].provenance, provenance);
  });
}

async function testClearOrdersAfterInflightWriteAndRejectsOldToken() {
  const firstWrite = deferred();
  const calls = [];
  const store = baseStore({
    write: async (jobs) => {
      calls.push(`write:${jobs.map((job) => job.id).join(",")}`);
      return firstWrite.promise;
    },
    clear: async () => {
      calls.push("clear");
      return committed("clear");
    },
  });
  const controller = new LiveSessionController(store, { maxAttempts: 1 });
  const oldGeneration = controller.captureGeneration();
  const writePromise = controller.write([completedJob("old")], oldGeneration);
  await waitUntil(() => calls.length === 1, "the first write to start");

  const clearPromise = controller.clear();
  firstWrite.resolve(committed("write", 1));
  const [writeResult, clearResult] = await Promise.all([writePromise, clearPromise]);

  assert.deepEqual(calls, ["write:old", "clear"]);
  assert.equal(writeResult.outcome.status, "superseded");
  assert.equal(writeResult.attempts, 1, "the superseded command did reach the store once");
  assert.equal(clearResult.outcome.status, "committed");

  const staleResult = await controller.write([completedJob("late")], oldGeneration);
  assert.equal(staleResult.outcome.status, "superseded");
  assert.equal(staleResult.attempts, 0);
  assert.deepEqual(calls, ["write:old", "clear"], "a stale post-clear write must not reach storage");
}

async function testRetryDoesNotNeedAnotherJobsChange() {
  const waits = [];
  let writeCalls = 0;
  const controller = new LiveSessionController(
    baseStore({
      write: async (jobs) => {
        writeCalls += 1;
        return writeCalls === 1 ? failed("write") : committed("write", jobs.length);
      },
    }),
    {
      maxAttempts: 2,
      retryDelaysMs: [5],
      wait: () => {
        const pause = deferred();
        waits.push(pause);
        return pause.promise;
      },
    },
  );

  const writePromise = controller.write(
    [completedJob("retry")],
    controller.captureGeneration(),
  );
  await waitUntil(() => waits.length === 1, "the retry state to be scheduled");
  assert.equal(controller.getSnapshot().waitingRetries, 1);
  waits[0].resolve();

  const result = await writePromise;
  assert.equal(result.outcome.status, "committed");
  assert.equal(result.attempts, 2);
  assert.equal(result.retryExhausted, false);
  assert.equal(writeCalls, 2);
  assert.equal(controller.getSnapshot().waitingRetries, 0);
}

async function testClearCancelsAScheduledOldRetry() {
  const waits = [];
  let writeCalls = 0;
  let clearCalls = 0;
  const controller = new LiveSessionController(
    baseStore({
      write: async () => {
        writeCalls += 1;
        return failed("write");
      },
      clear: async () => {
        clearCalls += 1;
        return committed("clear");
      },
    }),
    {
      maxAttempts: 3,
      wait: () => {
        const pause = deferred();
        waits.push(pause);
        return pause.promise;
      },
    },
  );

  const writePromise = controller.write(
    [completedJob("old-retry")],
    controller.captureGeneration(),
  );
  await waitUntil(() => waits.length === 1, "the old write retry to wait");
  const clearResult = await controller.clear();
  assert.equal(clearResult.outcome.status, "committed");
  waits[0].resolve();

  const writeResult = await writePromise;
  assert.equal(writeResult.outcome.status, "superseded");
  assert.equal(writeResult.attempts, 1);
  assert.equal(writeCalls, 1, "no old retry may run after clear");
  assert.equal(clearCalls, 1);
}

async function testNewerIntentDisplacesAnOlderRetryForTheSameJob() {
  const waits = [];
  const savedVersions = [];
  let writeCalls = 0;
  const controller = new LiveSessionController(
    baseStore({
      write: async (jobs) => {
        writeCalls += 1;
        savedVersions.push(jobs[0].result.analyzedAt);
        return writeCalls === 1 ? failed("write") : committed("write", jobs.length);
      },
    }),
    {
      maxAttempts: 3,
      wait: () => {
        const pause = deferred();
        waits.push(pause);
        return pause.promise;
      },
    },
  );

  const generation = controller.captureGeneration();
  const oldPromise = controller.write([completedJob("same", "old")], generation);
  await waitUntil(() => waits.length === 1, "the old version retry to wait");
  const newResult = await controller.write([completedJob("same", "new")], generation);
  assert.equal(newResult.outcome.status, "committed");
  waits[0].resolve();

  const oldResult = await oldPromise;
  assert.equal(oldResult.outcome.status, "superseded");
  assert.deepEqual(oldResult.supersededItemIds, ["same"]);
  assert.deepEqual(savedVersions, ["old", "new"], "the old value must not retry over the new one");
}

async function testUnavailableIsNotSuccessOrRetriedByDefault() {
  let calls = 0;
  const controller = new LiveSessionController(
    baseStore({
      write: async () => {
        calls += 1;
        return unavailable("write");
      },
    }),
  );

  const result = await controller.write(
    [completedJob("unavailable")],
    controller.captureGeneration(),
  );
  assert.equal(result.outcome.status, "unavailable");
  assert.equal(result.attempts, 1);
  assert.equal(result.retryExhausted, false);
  assert.equal(calls, 1);
}

async function testClearRequiresAConfirmedCommit() {
  const controller = new LiveSessionController(
    baseStore({ clear: async () => failed("clear", "quota") }),
    { maxAttempts: 1 },
  );

  const result = await controller.clear();
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.message, "quota");
  assert.equal(result.retryExhausted, true);
}

async function testNewGenerationWriteWaitsForClearRetries() {
  const waits = [];
  const calls = [];
  let clearCalls = 0;
  const controller = new LiveSessionController(
    baseStore({
      clear: async () => {
        clearCalls += 1;
        calls.push(`clear:${clearCalls}`);
        return clearCalls === 1 ? failed("clear") : committed("clear");
      },
      write: async (jobs) => {
        calls.push(`write:${jobs.map((job) => job.id).join(",")}`);
        return committed("write", jobs.length);
      },
    }),
    {
      maxAttempts: 2,
      wait: () => {
        const pause = deferred();
        waits.push(pause);
        return pause.promise;
      },
    },
  );

  const clearPromise = controller.clear();
  await waitUntil(() => waits.length === 1, "the clear retry barrier to wait");
  const writePromise = controller.write(
    [completedJob("new-after-clear")],
    controller.captureGeneration(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["clear:1"], "new writes must wait behind all clear attempts");

  waits[0].resolve();
  const [clearResult, writeResult] = await Promise.all([clearPromise, writePromise]);
  assert.equal(clearResult.outcome.status, "committed");
  assert.equal(writeResult.outcome.status, "committed");
  assert.deepEqual(calls, ["clear:1", "clear:2", "write:new-after-clear"]);
}

// ---------------------------------------------------------------------------
// In-memory IndexedDB mock for the v2 migration and bounded-restore tests.
//
// It models only the surface the store touches, but faithfully: persistent
// per-database "disk" state that survives across open() calls (so a v1 database
// can be upgraded to v2), a versionchange transaction that runs the backfill
// cursor to completion before the connection resolves, index cursors with a
// direction, count(), put/delete/clear, and microtask-scheduled request
// callbacks that auto-commit the transaction once no work remains.
// ---------------------------------------------------------------------------

function compareKeys(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function makeMockRequest() {
  return { onsuccess: null, onerror: null, result: undefined, error: null };
}

class MemTransaction {
  constructor(disk, onCommit, onAbort) {
    this.disk = disk;
    this.onCommit = onCommit;
    this.onAbort = onAbort;
    this.pending = 0;
    this.settled = false;
    this.checkScheduled = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    // A transaction with zero requests still commits.
    this.scheduleCommitCheck();
  }

  objectStore(name) {
    const store = this.disk.stores.get(name);
    if (!store) {
      throw new Error(`No object store named "${name}".`);
    }
    return new MemStoreHandle(this, store);
  }

  abort() {
    this.settleAbort(new Error("Transaction aborted."));
  }

  scheduleCommitCheck() {
    if (this.checkScheduled || this.settled) return;
    this.checkScheduled = true;
    queueMicrotask(() => {
      this.checkScheduled = false;
      if (this.settled || this.pending > 0) return;
      this.settled = true;
      this.onCommit();
    });
  }

  settleAbort(error) {
    if (this.settled) return;
    this.settled = true;
    this.error = error ?? this.error;
    this.onAbort(error);
  }

  runRequest(work) {
    const request = makeMockRequest();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.settled) {
        this.pending -= 1;
        return;
      }
      try {
        request.result = work();
        if (request.onsuccess) request.onsuccess({ target: request });
      } catch (error) {
        request.error = error;
        this.error = error;
        if (request.onerror) request.onerror({ target: request });
        this.settleAbort(error);
      } finally {
        this.pending -= 1;
        this.scheduleCommitCheck();
      }
    });
    return request;
  }

  // A cursor request fires onsuccess repeatedly (once per record, then once with
  // a null result). Each continue() schedules the next delivery, keeping the
  // transaction alive across the whole walk.
  runCursor(store, indexKeyPath, direction) {
    let entries = [...store.records.entries()];
    if (indexKeyPath) {
      entries = entries.filter(
        ([, value]) => value != null && value[indexKeyPath] != null,
      );
      entries.sort(
        ([keyA, valueA], [keyB, valueB]) =>
          compareKeys(valueA[indexKeyPath], valueB[indexKeyPath]) ||
          compareKeys(keyA, keyB),
      );
    } else {
      entries.sort(([keyA], [keyB]) => compareKeys(keyA, keyB));
    }
    if (direction === "prev") entries.reverse();

    const request = makeMockRequest();
    const txn = this;
    let pos = 0;

    const deliver = () => {
      txn.pending += 1;
      queueMicrotask(() => {
        if (txn.settled) {
          txn.pending -= 1;
          return;
        }
        try {
          if (pos >= entries.length) {
            request.result = null;
            if (request.onsuccess) request.onsuccess({ target: request });
          } else {
            const [primaryKey, value] = entries[pos];
            if (indexKeyPath) txn.disk.indexCursorReads += 1;
            request.result = {
              value,
              key: indexKeyPath ? value[indexKeyPath] : primaryKey,
              primaryKey,
              continue() {
                pos += 1;
                deliver();
              },
              update(newValue) {
                store.records.set(primaryKey, newValue);
              },
              delete() {
                store.records.delete(primaryKey);
              },
            };
            if (request.onsuccess) request.onsuccess({ target: request });
          }
        } catch (error) {
          request.error = error;
          txn.error = error;
          if (request.onerror) request.onerror({ target: request });
          txn.settleAbort(error);
        } finally {
          txn.pending -= 1;
          txn.scheduleCommitCheck();
        }
      });
    };

    deliver();
    return request;
  }
}

class MemStoreHandle {
  constructor(txn, store) {
    this.txn = txn;
    this.store = store;
    this.keyPath = store.keyPath;
  }

  get indexNames() {
    return { contains: (name) => this.store.indexes.has(name) };
  }

  createIndex(name, keyPath, options = {}) {
    this.store.indexes.set(name, { keyPath, unique: !!options.unique });
    return { name, keyPath };
  }

  index(name) {
    const def = this.store.indexes.get(name);
    if (!def) {
      throw new Error(`No index named "${name}".`);
    }
    return new MemIndexHandle(this.txn, this.store, def);
  }

  count() {
    const size = this.store.records.size;
    return this.txn.runRequest(() => size);
  }

  put(value) {
    return this.txn.runRequest(() => {
      this.store.records.set(value[this.keyPath], value);
      return undefined;
    });
  }

  delete(key) {
    return this.txn.runRequest(() => {
      this.store.records.delete(key);
      return undefined;
    });
  }

  clear() {
    return this.txn.runRequest(() => {
      this.store.records.clear();
      return undefined;
    });
  }

  openCursor(range, direction) {
    return this.txn.runCursor(this.store, null, direction ?? "next");
  }
}

class MemIndexHandle {
  constructor(txn, store, def) {
    this.txn = txn;
    this.store = store;
    this.def = def;
  }

  openCursor(range, direction) {
    return this.txn.runCursor(this.store, this.def.keyPath, direction ?? "next");
  }
}

class MemDatabase {
  constructor(disk, connections) {
    this.disk = disk;
    this.connections = connections;
    this.onversionchange = null;
    this.upgradeTxn = null;
  }

  get objectStoreNames() {
    return { contains: (name) => this.disk.stores.has(name) };
  }

  createObjectStore(name, options = {}) {
    this.disk.stores.set(name, {
      keyPath: options.keyPath,
      indexes: new Map(),
      records: new Map(),
    });
    return new MemStoreHandle(this.upgradeTxn, this.disk.stores.get(name));
  }

  transaction(names) {
    const requested = Array.isArray(names) ? names : [names];
    for (const name of requested) {
      if (!this.disk.stores.has(name)) {
        throw new Error(`No object store named "${name}".`);
      }
    }
    const txn = new MemTransaction(
      this.disk,
      () => {
        if (txn.oncomplete) txn.oncomplete({ target: txn });
      },
      () => {
        if (txn.onabort) txn.onabort({ target: txn });
      },
    );
    return txn;
  }

  close() {
    this.connections.delete(this);
  }
}

function createMemoryIndexedDb(disk) {
  const connections = new Set();
  const mock = {
    disk,
    connections,
    open(name, version) {
      const request = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        result: null,
        transaction: null,
        error: null,
      };
      queueMicrotask(() => {
        const current = disk.version || 0;
        const database = new MemDatabase(disk, connections);
        connections.add(database);
        request.result = database;
        if (version > current) {
          const vtxn = new MemTransaction(
            disk,
            () => {
              disk.version = version;
              database.upgradeTxn = null;
              request.transaction = null;
              if (request.onsuccess) request.onsuccess({ target: request });
            },
            (error) => {
              request.error = error ?? new Error("Upgrade aborted.");
              if (request.onerror) request.onerror({ target: request });
            },
          );
          database.upgradeTxn = vtxn;
          request.transaction = vtxn;
          try {
            if (request.onupgradeneeded) {
              request.onupgradeneeded({
                target: request,
                oldVersion: current,
                newVersion: version,
              });
            }
          } catch (error) {
            vtxn.settleAbort(error);
            return;
          }
          vtxn.scheduleCommitCheck();
        } else if (request.onsuccess) {
          request.onsuccess({ target: request });
        }
      });
      return request;
    },
  };
  return mock;
}

function makeDisk(version, storeConfigs = {}) {
  const stores = new Map();
  for (const [name, config] of Object.entries(storeConfigs)) {
    const keyPath = config.keyPath ?? "id";
    const records = new Map();
    for (const record of config.records ?? []) {
      records.set(record[keyPath], record);
    }
    const indexes = new Map();
    for (const idx of config.indexes ?? []) {
      indexes.set(idx.name, { keyPath: idx.keyPath, unique: !!idx.unique });
    }
    stores.set(name, { keyPath, indexes, records });
  }
  return { version: version ?? 0, stores, indexCursorReads: 0 };
}

async function testFreshDatabaseMigratesAndRestoresEmpty() {
  const disk = makeDisk(0);
  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs();
    assert.equal(outcome.status, "empty");
    assert.deepEqual(outcome.jobs, []);
    assert.equal(outcome.totalRecordCount, 0);
    assert.equal(outcome.invalidRecordCount, 0);
    assert.equal(outcome.overflowRecordCount, 0);
  });

  assert.equal(disk.version, 2, "a fresh open upgrades straight to v2");
  assert.ok(disk.stores.has("jobs"), "the jobs store is created");
  assert.ok(disk.stores.has("quarantine"), "the quarantine store is created");
  assert.ok(
    disk.stores.get("jobs").indexes.has("createdAt"),
    "the createdAt index is created on the jobs store",
  );
}

async function testV1ToV2MigrationPreservesValidAndQuarantinesInvalid() {
  // A v1 database: a jobs store with no createdAt index and no quarantine store.
  // Records are seeded out of chronological order so the restore has to sort by
  // createdAt rather than returning insertion order. Two records lack createdAt
  // entirely, so the migration must backfill them or they would be orphaned:
  // unreachable by the index cursor and therefore neither restored nor
  // quarantined.
  const disk = makeDisk(1, {
    jobs: {
      keyPath: "id",
      records: [
        { id: "bad-with-date", createdAt: "2026-07-17T00:00:00.000Z" },
        {
          id: "newest",
          createdAt: "2026-07-18T00:00:00.000Z",
          normalizedJob: {
            id: "newest",
            createdAt: "2026-07-18T00:00:00.000Z",
            provenance: { kind: "restored-local" },
          },
        },
        { id: "bad-no-date" },
        {
          id: "backfilled",
          result: { analyzedAt: "2026-07-16T00:00:00.000Z" },
          normalizedJob: {
            id: "backfilled",
            createdAt: "2026-07-16T00:00:00.000Z",
          },
        },
      ],
    },
  });

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs();

    assert.equal(outcome.status, "committed");
    assert.deepEqual(
      outcome.jobs.map((job) => job.id),
      ["newest", "backfilled"],
      "valid records restore newest-first, including the one recovered by backfill",
    );
    assert.ok(
      outcome.jobs.every((job) => job.restored === true),
      "restored jobs are flagged as restored",
    );
    assert.equal(outcome.totalRecordCount, 4);
    assert.equal(outcome.invalidRecordCount, 2, "both malformed records were quarantined");
    assert.equal(outcome.overflowRecordCount, 0);
  });

  assert.equal(disk.version, 2, "the database upgraded to v2");
  assert.ok(disk.stores.get("jobs").indexes.has("createdAt"));

  const jobsRecords = disk.stores.get("jobs").records;
  const quarantineRecords = disk.stores.get("quarantine").records;

  // Nothing was deleted: valid records stay in the live store, malformed records
  // were moved into quarantine, and the total is preserved across both stores.
  assert.deepEqual([...jobsRecords.keys()].sort(), ["backfilled", "newest"]);
  assert.deepEqual(
    [...quarantineRecords.keys()].sort(),
    ["bad-no-date", "bad-with-date"],
    "the quarantine store contents are assertable",
  );
  assert.equal(
    jobsRecords.size + quarantineRecords.size,
    4,
    "no record is lost across migration + restore",
  );

  // Backfill: the valid record that lacked createdAt kept its analyzedAt-derived
  // timestamp, and the malformed dateless record became reachable (so it could
  // be quarantined) via an epoch-0 backfill.
  assert.equal(
    jobsRecords.get("backfilled").createdAt,
    "2026-07-16T00:00:00.000Z",
    "a missing createdAt is derived from result.analyzedAt",
  );
  assert.equal(
    quarantineRecords.get("bad-no-date").createdAt,
    new Date(0).toISOString(),
    "a record with no usable timestamp is backfilled to epoch-0",
  );
  assert.equal(
    quarantineRecords.get("bad-with-date").createdAt,
    "2026-07-17T00:00:00.000Z",
    "an existing createdAt is left unchanged",
  );
}

async function testBoundedRestoreStopsAtLimitNewestFirst() {
  // RESTORE_LIMIT is MAX_SESSION_JOBS, which the store test shim pins to 1000.
  const limit = 1000;
  const overflow = 2;
  const total = limit + overflow;
  const baseMs = Date.UTC(2020, 0, 1);
  const records = [];
  for (let i = 0; i < total; i += 1) {
    const iso = new Date(baseMs + i * 60_000).toISOString();
    const id = `job-${String(i).padStart(4, "0")}`;
    records.push({ id, createdAt: iso, normalizedJob: { id, createdAt: iso } });
  }
  // Seed a v2 database directly so this isolates the bounded restore from the
  // migration path. Records ascend in time; newest-first restore must reverse
  // them and stop at the cap.
  const disk = makeDisk(2, {
    jobs: {
      keyPath: "id",
      indexes: [{ name: "createdAt", keyPath: "createdAt" }],
      records,
    },
    quarantine: { keyPath: "id" },
  });

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs();

    assert.equal(outcome.status, "committed");
    assert.equal(outcome.jobs.length, limit, "restore is capped at the session limit");
    assert.equal(outcome.jobs[0].id, "job-1001", "the newest record is first");
    assert.equal(
      outcome.jobs[limit - 1].id,
      "job-0002",
      "the oldest kept record is exactly at the cap boundary",
    );
    for (let i = 1; i < outcome.jobs.length; i += 1) {
      assert.ok(
        outcome.jobs[i - 1].createdAt > outcome.jobs[i].createdAt,
        "jobs are returned in strictly descending createdAt order",
      );
    }
    assert.equal(outcome.totalRecordCount, total);
    assert.equal(outcome.invalidRecordCount, 0);
    assert.equal(outcome.overflowRecordCount, overflow);
  });

  // Bounded: the index cursor visited exactly the cap and never walked into the
  // overflow tail (no getAll / whole-store scan).
  assert.equal(
    disk.indexCursorReads,
    limit,
    "the cursor stops at the limit instead of scanning the whole store",
  );

  // Overflow records were left in place: not loaded, not quarantined, not
  // deleted.
  const jobsRecords = disk.stores.get("jobs").records;
  assert.equal(jobsRecords.size, total, "no record was removed from the live store");
  assert.ok(
    jobsRecords.has("job-0000") && jobsRecords.has("job-0001"),
    "the overflow tail stays in the live store untouched",
  );
  assert.equal(
    disk.stores.get("quarantine").records.size,
    0,
    "nothing was quarantined for a store of valid records",
  );
}

const tests = [
  testStoreDistinguishesUnavailableAndEmpty,
  testBlockedOpenClosesALateSuccessfulConnection,
  testOwnedConnectionClosesOnVersionChange,
  testStorePersistsUnverifiedProvenance,
  testFreshDatabaseMigratesAndRestoresEmpty,
  testV1ToV2MigrationPreservesValidAndQuarantinesInvalid,
  testBoundedRestoreStopsAtLimitNewestFirst,
  testClearOrdersAfterInflightWriteAndRejectsOldToken,
  testRetryDoesNotNeedAnotherJobsChange,
  testClearCancelsAScheduledOldRetry,
  testNewerIntentDisplacesAnOlderRetryForTheSameJob,
  testUnavailableIsNotSuccessOrRetriedByDefault,
  testClearRequiresAConfirmedCommit,
  testNewGenerationWriteWaitsForClearRetries,
];

for (const test of tests) {
  await test();
  console.log(`PASS ${test.name}`);
}

console.log(`Live-session coordination validation passed (${tests.length}/${tests.length}).`);
