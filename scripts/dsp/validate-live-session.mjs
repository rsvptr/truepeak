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
      // Ownership-scoped writes read the existing row before deciding to put; a
      // fresh store has none, so this resolves to undefined and the put proceeds.
      get: () => {
        const request = { onsuccess: null, result: undefined };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
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

  get(key) {
    return this.txn.runRequest(() => this.store.records.get(key));
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

// ---------------------------------------------------------------------------
// Cross-tab ownership (finding [4]). Records carry {ownerId, heartbeatMs}; a tab
// may only overwrite/delete/clear rows it owns or that a crashed/closed peer
// left behind, restore prefers its own rows and adopts stale/legacy ones, and a
// live peer's rows are strictly protected.
// ---------------------------------------------------------------------------

const OWNERSHIP_CLOCK = Date.UTC(2026, 6, 20, 12, 0, 0);
const STALE_WINDOW_MS = 2 * 60 * 1000;

// A stored row with an optional owner/heartbeat and a valid normalizedJob so the
// shim restores it. Omitting owner+heartbeat models a legacy (pre-ownership) row.
function storedRow(id, ownerId, heartbeatMs, createdAt = "2026-07-18T00:00:00.000Z") {
  return {
    id,
    createdAt,
    ...(ownerId !== undefined ? { ownerId } : {}),
    ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
    normalizedJob: { id, createdAt },
  };
}

function ownershipDisk(records) {
  return makeDisk(2, {
    jobs: {
      keyPath: "id",
      indexes: [{ name: "createdAt", keyPath: "createdAt" }],
      records,
    },
    quarantine: { keyPath: "id" },
  });
}

async function testForeignLiveRecordIsProtected() {
  // tab-A persisted "peer-live" with a fresh heartbeat. tab-B may surface it
  // view-only on restore (recovery must never be withheld), but must not adopt,
  // delete, clear, or overwrite it through any mutating path.
  const asTabB = { ownerId: "tab-B", now: OWNERSHIP_CLOCK + 1000, staleAfterMs: STALE_WINDOW_MS };
  const seed = () => ownershipDisk([storedRow("peer-live", "tab-A", OWNERSHIP_CLOCK)]);

  const readDisk = seed();
  await withMockIndexedDb(createMemoryIndexedDb(readDisk), async () => {
    const outcome = await storeModule.readLiveSessionJobs(asTabB);
    // Restore is view-only: the row IS surfaced (so single-tab recovery after an
    // accidental close is not silently discarded), but its stored ownership is
    // left intact -- the read never re-stamps or removes it.
    assert.equal(outcome.status, "committed", "a live peer's valid row is surfaced view-only");
    assert.deepEqual(outcome.jobs.map((job) => job.id), ["peer-live"]);
    assert.equal(outcome.jobs[0].restored, true, "the surfaced row is flagged restored");
    assert.equal(outcome.invalidRecordCount, 0, "a live peer's row is never quarantined");
  });
  const readRow = readDisk.stores.get("jobs").records.get("peer-live");
  assert.equal(readRow.ownerId, "tab-A", "read leaves the peer's owner untouched (not adopted)");
  assert.equal(readRow.heartbeatMs, OWNERSHIP_CLOCK, "read leaves the peer's heartbeat untouched");
  assert.equal(readDisk.stores.get("quarantine").records.size, 0);

  const deleteDisk = seed();
  await withMockIndexedDb(createMemoryIndexedDb(deleteDisk), async () => {
    const outcome = await storeModule.deleteLiveSessionJobs(["peer-live"], asTabB);
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.count, 0, "no live peer row is deleted");
  });
  assert.ok(
    deleteDisk.stores.get("jobs").records.has("peer-live"),
    "delete leaves the live peer's row in place",
  );

  const clearDisk = seed();
  await withMockIndexedDb(createMemoryIndexedDb(clearDisk), async () => {
    const outcome = await storeModule.clearLiveSessionStore(asTabB);
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.count, 0, "clear removes no live peer row");
  });
  assert.ok(
    clearDisk.stores.get("jobs").records.has("peer-live"),
    "clear leaves the live peer's row in place (no blind store.clear wipe)",
  );

  const writeDisk = seed();
  await withMockIndexedDb(createMemoryIndexedDb(writeDisk), async () => {
    const outcome = await storeModule.writeLiveSessionJobs(
      [
        {
          id: "peer-live",
          fileName: "tab-b.wav",
          mimeType: "audio/wav",
          createdAt: "2026-07-19T00:00:00.000Z",
          result: { analyzedAt: "2026-07-19T00:00:00.000Z" },
        },
      ],
      asTabB,
    );
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.count, 0, "no live peer row is overwritten");
  });
  const writeRow = writeDisk.stores.get("jobs").records.get("peer-live");
  assert.equal(writeRow.ownerId, "tab-A", "write does not steal a live peer's row");
  assert.equal(writeRow.fileName, undefined, "the peer's original record is unchanged");
}

async function testAccidentalCloseRecoverySurfacesOwnRows() {
  // The follow-up finding's acceptance criterion. A single tab wrote rows under
  // ownerId "tab-A" with a fresh heartbeat, then closed accidentally. Its per-tab
  // sessionStorage ownerId died with it, so the reopened tab mints a NEW id
  // ("tab-A2") and restores within the 2-minute stale window. From the reopened
  // tab's view the rows are foreign-fresh -- previously withheld, silently
  // emptying the recovered session. Restore must now surface them.
  const disk = ownershipDisk([
    storedRow("done-1", "tab-A", OWNERSHIP_CLOCK, "2026-07-18T00:00:00.000Z"),
    storedRow("done-2", "tab-A", OWNERSHIP_CLOCK, "2026-07-18T00:00:01.000Z"),
  ]);
  // Reopened one second later: well inside STALE_WINDOW_MS.
  const reopened = { ownerId: "tab-A2", now: OWNERSHIP_CLOCK + 1000, staleAfterMs: STALE_WINDOW_MS };

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs(reopened);
    assert.equal(outcome.status, "committed", "the reopened tab recovers its own finished batch");
    assert.deepEqual(
      outcome.jobs.map((job) => job.id).sort(),
      ["done-1", "done-2"],
      "every completed row is surfaced, not silently dropped",
    );
    assert.equal(outcome.invalidRecordCount, 0);
    assert.equal(outcome.overflowRecordCount, 0, "surfaced rows are not miscounted as overflow");
  });

  // Ownership is left intact rather than adopted, so the overflow accounting is
  // exact and (in the genuine live-peer case) the peer keeps authority.
  for (const id of ["done-1", "done-2"]) {
    const row = disk.stores.get("jobs").records.get(id);
    assert.equal(row.ownerId, "tab-A", `${id} keeps its original owner after a view-only restore`);
    assert.equal(row.heartbeatMs, OWNERSHIP_CLOCK, `${id} heartbeat is untouched by restore`);
  }
}

async function testForeignLiveInvalidRecordIsLeftInPlace() {
  // An INVALID row (no normalizedJob) owned by a live peer must be left strictly
  // in place: surfacing does not apply (it cannot be normalized), and quarantine
  // must not touch another tab's data. It is excluded from invalidRecordCount and
  // from overflow (accounted as a skipped foreign row).
  const disk = ownershipDisk([
    { id: "peer-bad", createdAt: "2026-07-18T00:00:00.000Z", ownerId: "tab-A", heartbeatMs: OWNERSHIP_CLOCK },
  ]);
  const asTabB = { ownerId: "tab-B", now: OWNERSHIP_CLOCK + 1000, staleAfterMs: STALE_WINDOW_MS };

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs(asTabB);
    assert.equal(outcome.status, "empty", "an invalid live-peer row surfaces nothing");
    assert.deepEqual(outcome.jobs, []);
    assert.equal(outcome.invalidRecordCount, 0, "a live peer's invalid row is not quarantined");
    assert.equal(outcome.overflowRecordCount, 0, "a skipped foreign row is not counted as overflow");
  });
  assert.ok(
    disk.stores.get("jobs").records.has("peer-bad"),
    "the live peer's invalid row is left in place, not deleted",
  );
  assert.equal(disk.stores.get("quarantine").records.size, 0, "nothing was quarantined from a peer");
}

async function testCrashedTabRecordIsAdopted() {
  // tab-A's heartbeat is older than the stale window: a crashed/closed tab. tab-B
  // adopts the row on restore, claiming ownership so a third tab cannot re-adopt.
  const staleHeartbeat = OWNERSHIP_CLOCK - 3 * 60 * 1000;
  const disk = ownershipDisk([storedRow("crashed", "tab-A", staleHeartbeat)]);
  const asTabB = { ownerId: "tab-B", now: OWNERSHIP_CLOCK, staleAfterMs: STALE_WINDOW_MS };

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs(asTabB);
    assert.equal(outcome.status, "committed", "a crashed peer's stale row is restored");
    assert.deepEqual(outcome.jobs.map((job) => job.id), ["crashed"]);
    assert.equal(outcome.jobs[0].restored, true, "the adopted row is flagged restored");
    assert.equal(outcome.invalidRecordCount, 0);

    const adopted = disk.stores.get("jobs").records.get("crashed");
    assert.equal(adopted.ownerId, "tab-B", "the adopted row is re-stamped to the adopting tab");
    assert.equal(adopted.heartbeatMs, OWNERSHIP_CLOCK, "the adopted row gets a fresh heartbeat");

    // Having claimed it, tab-B can now clear it as its own row.
    const cleared = await storeModule.clearLiveSessionStore({
      ownerId: "tab-B",
      now: OWNERSHIP_CLOCK + 1000,
      staleAfterMs: STALE_WINDOW_MS,
    });
    assert.equal(cleared.status, "committed");
    assert.equal(cleared.count, 1, "the adopting tab owns and can clear the adopted row");
  });
  assert.equal(
    disk.stores.get("jobs").records.size,
    0,
    "the adopted row was removed by its new owner",
  );
}

async function testLegacyRecordIsRestorableAndMigrated() {
  // A pre-ownership row has no ownerId/heartbeatMs. It is treated as stale-owned:
  // restorable, and migrated to the restoring tab's ownership on restore.
  const disk = ownershipDisk([storedRow("legacy", undefined, undefined)]);
  const asTabB = { ownerId: "tab-B", now: OWNERSHIP_CLOCK, staleAfterMs: STALE_WINDOW_MS };

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs(asTabB);
    assert.equal(outcome.status, "committed", "a legacy (owner-less) row is restorable");
    assert.deepEqual(outcome.jobs.map((job) => job.id), ["legacy"]);
    assert.equal(outcome.jobs[0].restored, true);
    assert.equal(outcome.invalidRecordCount, 0, "a legacy row is migrated, not quarantined");
  });

  const migrated = disk.stores.get("jobs").records.get("legacy");
  assert.equal(migrated.ownerId, "tab-B", "the legacy row is migrated to the restoring tab");
  assert.equal(migrated.heartbeatMs, OWNERSHIP_CLOCK, "the migrated row gets a fresh heartbeat");
}

async function testHeartbeatRefreshesOnlyOwnRows() {
  // The periodic heartbeat keeps an active tab's rows fresh without disturbing a
  // peer's rows.
  const disk = ownershipDisk([
    storedRow("mine", "tab-A", OWNERSHIP_CLOCK - 60_000, "2026-07-18T00:00:00.000Z"),
    storedRow("peer", "tab-B", OWNERSHIP_CLOCK - 60_000, "2026-07-17T00:00:00.000Z"),
  ]);

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.refreshLiveSessionHeartbeat({
      ownerId: "tab-A",
      now: OWNERSHIP_CLOCK,
    });
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.count, 1, "only the tab's own row is refreshed");
  });
  assert.equal(
    disk.stores.get("jobs").records.get("mine").heartbeatMs,
    OWNERSHIP_CLOCK,
    "the tab's own row heartbeat advanced",
  );
  assert.equal(
    disk.stores.get("jobs").records.get("peer").heartbeatMs,
    OWNERSHIP_CLOCK - 60_000,
    "a peer's row is left untouched",
  );
}

async function testRestoreRefreshesOwnRowHeartbeats() {
  // The ordinary same-tab refresh: the reloaded tab owns its rows already, so the
  // autosave diff is empty and no write ever happens. Restore therefore has to
  // refresh the heartbeat itself. Without that the rows kept their pre-refresh
  // timestamp, went stale two minutes later while the tab was open and showing
  // them, and a peer's Clear Session then deleted the live tab's only recovery
  // copy.
  const staleHeartbeat = OWNERSHIP_CLOCK - 5 * 60_000;
  const disk = ownershipDisk([storedRow("mine", "tab-A", staleHeartbeat)]);
  const asTabA = { ownerId: "tab-A", now: OWNERSHIP_CLOCK, staleAfterMs: STALE_WINDOW_MS };

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.readLiveSessionJobs(asTabA);
    assert.equal(outcome.status, "committed", "the tab's own row is restored");
    assert.deepEqual(outcome.jobs.map((job) => job.id), ["mine"]);
    // The restore schedules the refresh from the transaction's completion, so
    // let the microtask queue drain before asserting on the stored row.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(
    disk.stores.get("jobs").records.get("mine").heartbeatMs,
    OWNERSHIP_CLOCK,
    "a restored own row leaves the restore with a fresh heartbeat, not the pre-refresh one",
  );
}

async function testClearAlsoEmptiesQuarantine() {
  // Records set aside during a restore used to survive every Clear Session:
  // clearLiveSessionStore scoped its transaction to the jobs store alone, and
  // nothing else in the codebase ever deletes from quarantine, so the only way
  // out was clearing site data.
  const disk = ownershipDisk([storedRow("mine", "tab-A", OWNERSHIP_CLOCK)]);
  disk.stores.get("quarantine").records.set(
    "bad",
    storedRow("bad", "tab-A", OWNERSHIP_CLOCK),
  );
  disk.stores.get("quarantine").records.set(
    "peer-bad",
    storedRow("peer-bad", "tab-B", OWNERSHIP_CLOCK),
  );

  await withMockIndexedDb(createMemoryIndexedDb(disk), async () => {
    const outcome = await storeModule.clearLiveSessionStore({
      ownerId: "tab-A",
      now: OWNERSHIP_CLOCK,
      staleAfterMs: STALE_WINDOW_MS,
    });
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.count, 1, "the count reports live rows only, not quarantined ones");
  });

  assert.equal(disk.stores.get("jobs").records.size, 0, "the tab's live row is cleared");
  assert.equal(
    disk.stores.get("quarantine").records.has("bad"),
    false,
    "the tab's own quarantined row is cleared too",
  );
  assert.equal(
    disk.stores.get("quarantine").records.has("peer-bad"),
    true,
    "a live peer's quarantined row is left alone, same ownership rule as the jobs store",
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
  testForeignLiveRecordIsProtected,
  testAccidentalCloseRecoverySurfacesOwnRows,
  testForeignLiveInvalidRecordIsLeftInPlace,
  testCrashedTabRecordIsAdopted,
  testLegacyRecordIsRestorableAndMigrated,
  testHeartbeatRefreshesOnlyOwnRows,
  testRestoreRefreshesOwnRowHeartbeats,
  testClearAlsoEmptiesQuarantine,
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
