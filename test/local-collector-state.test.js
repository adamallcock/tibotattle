import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fsSync from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLocalCollectorStateLock,
  commitLocalCollectorState,
  defaultLocalCollectorStatePath,
  forEachLocalCollectorRecord,
  inspectLocalCollectorStateStorage,
  migrateLegacyLocalCollectorState,
  planLocalCollectorStateRetention,
  prepareLocalCollectorState,
  LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX,
  readLocalCollectorLegacyRefreshUse,
  readLocalCollectorRecordSummary,
  readLocalCollectorRolloutStalenessSummary,
  readLocalCollectorState,
  recordLocalCollectorLegacyRefreshAttempt,
  serializeLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import { stableJson } from "../src/storage.js";

function checkpoint() {
  return {
    schemaVersion: "0.3",
    collectionStartedAt: "2026-08-01T00:00:00.000Z",
    files: {},
    recentEventKeys: [],
    lastQuotaObservedAt: null,
    accountScopeMarker: null,
    diagnostics: {},
    indexing: {
      mode: "recent_7d",
      status: "recent_7d_indexing",
      phase: "discovering",
      boundedBy: "modified_at_and_collection_start",
      filesDiscovered: 0,
      filesSelected: 0,
      filesProcessed: 0,
      recordsWritten: 0,
      coveredAt: {
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: null,
      },
    },
  };
}

function record(eventKey, observedAt = "2026-08-03T00:00:00.000Z") {
  return {
    schemaVersion: "0.3",
    kind: "codex_tool_class_event",
    observedAt,
    eventKey,
    toolClass: "other",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-collector-state-"));
  const stateDirectory = join(root, ".usage-monitor");
  await mkdir(stateDirectory, { recursive: true });
  return {
    root,
    stateDirectory,
    stateFile: defaultLocalCollectorStatePath(root),
  };
}

test("new collector state is owner-only before SQLite writes and immediately usable by a queued reader", {
  skip: process.platform === "win32",
}, async (t) => {
  const value = await fixture();
  const originalExec = DatabaseSync.prototype.exec;
  const originalChmod = fsPromises.chmod;
  const originalUmask = process.umask(0o022);
  let firstSqliteOpen = false;
  let chmodBoundary = false;
  let concurrentRead;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    if (!firstSqliteOpen) {
      firstSqliteOpen = true;
      const before = fsSync.lstatSync(value.stateFile);
      assert.equal(before.mode & 0o777, 0o600, "first visible SQLite target is private under umask 022");
      assert.equal(before.size, 0, "privacy exists before the first SQLite content write");
      concurrentRead = readLocalCollectorState({ stateFile: value.stateFile });
    }
    return originalExec.call(this, sql);
  });
  t.mock.method(fsPromises, "chmod", async (path, mode) => {
    if (path === value.stateFile && !chmodBoundary) {
      chmodBoundary = true;
      assert.equal((await stat(path)).mode & 0o777, 0o600,
        "post-creation chmod is never the privacy boundary");
      assert.equal((await readLocalCollectorState({ stateFile: path })).status, "available");
    }
    return originalChmod(path, mode);
  });
  syncBuiltinESMExports();
  try {
    await commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint(), records: [record("private-first-byte")] });
    assert.equal(firstSqliteOpen, true);
    assert.equal(chmodBoundary, true);
    assert.equal((await concurrentRead).status, "available");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    process.umask(originalUmask);
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector creation reuses a validated winning database after an exclusive-create race", async (t) => {
  const value = await fixture();
  const winner = await fixture();
  const originalOpen = fsSync.openSync;
  const expected = checkpoint();
  let raced = false;
  try {
    await commitLocalCollectorState({ stateFile: winner.stateFile, checkpoint: expected, records: [record("winning-creator")] });
    t.mock.method(fsSync, "openSync", (path, flags, mode) => {
      if (path === value.stateFile && (flags & fsSync.constants.O_EXCL) !== 0 && !raced) {
        raced = true;
        fsSync.copyFileSync(winner.stateFile, value.stateFile, fsSync.constants.COPYFILE_EXCL);
      }
      return originalOpen(path, flags, mode);
    });
    syncBuiltinESMExports();
    await commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: expected,
      records: [record("race-reuse")] });
    assert.equal(raced, true);
    assert.deepEqual((await readLocalCollectorState({ stateFile: value.stateFile })).records,
      [record("winning-creator"), record("race-reuse")], "winning state is retained");
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: expected, records: [record("later-reuse")] });
    assert.deepEqual((await readLocalCollectorState({ stateFile: value.stateFile })).records,
      [record("winning-creator"), record("race-reuse"), record("later-reuse")]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(value.root, { recursive: true, force: true });
    await rm(winner.root, { recursive: true, force: true });
  }
});

test("concurrent first collector writers both reuse the same initialized state", { timeout: 10_000 }, async (t) => {
  const value = await fixture();
  const originalLstat = fsPromises.lstat;
  let missingObservations = 0;
  let release;
  const bothMissing = new Promise((resolve) => { release = resolve; });
  t.mock.method(fsPromises, "lstat", async (path, options) => {
    try { return await originalLstat(path, options); }
    catch (error) {
      if (path === value.stateFile && error.code === "ENOENT") {
        missingObservations += 1;
        if (missingObservations === 2) release();
        await bothMissing;
      }
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    const receipts = await Promise.all([
      recordLocalCollectorLegacyRefreshAttempt({ stateFile: value.stateFile }),
      recordLocalCollectorLegacyRefreshAttempt({ stateFile: value.stateFile }),
    ]);
    assert.equal(missingObservations, 2);
    assert.deepEqual(receipts.map((receipt) => receipt.attempts).sort(), [1, 2]);
    assert.equal((await readLocalCollectorLegacyRefreshUse({ stateFile: value.stateFile })).receipt.attempts, 2);
  } finally {
    release();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the first real collector transaction keeps its DELETE rollback journal owner-only", {
  skip: process.platform === "win32",
}, async (t) => {
  const value = await fixture();
  const originalExec = DatabaseSync.prototype.exec;
  const originalUmask = process.umask(0o022);
  let observed = false;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    if (sql === "COMMIT" && !observed) {
      observed = true;
      assert.equal(this.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
      for (const path of [value.stateFile, `${value.stateFile}-journal`]) {
        const metadata = fsSync.lstatSync(path);
        assert.equal(metadata.isFile(), true);
        assert.equal(metadata.isSymbolicLink(), false);
        assert.equal(metadata.nlink, 1);
        assert.equal(metadata.mode & 0o777, 0o600);
      }
      assert.equal(fsSync.existsSync(`${value.stateFile}-wal`), false);
      assert.equal(fsSync.existsSync(`${value.stateFile}-shm`), false);
    }
    return originalExec.call(this, sql);
  });
  try {
    await commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint(), records: [record("private-journal")] });
    assert.equal(observed, true);
    assert.equal(fsSync.existsSync(`${value.stateFile}-journal`), false);
  } finally {
    t.mock.restoreAll();
    process.umask(originalUmask);
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector creation never initializes or removes an empty competing reservation", async (t) => {
  const value = await fixture();
  const originalOpen = fsSync.openSync;
  let raced = false;
  t.mock.method(fsSync, "openSync", (path, flags, mode) => {
    if (path === value.stateFile && (flags & fsSync.constants.O_EXCL) !== 0 && !raced) {
      raced = true;
      const winner = originalOpen(path, flags, mode);
      fsSync.closeSync(winner);
    }
    return originalOpen(path, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint() }),
      { code: "local_collector_state_unavailable" });
    assert.equal(raced, true);
    assert.equal((await stat(value.stateFile)).size, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector reservation identity checks preserve a substituted target before SQLite opens it", async (t) => {
  const value = await fixture();
  const originalStat = fsSync.lstatSync;
  let replaced = false;
  t.mock.method(fsSync, "lstatSync", (path, options) => {
    if (path === value.stateFile && !replaced) {
      replaced = true;
      fsSync.renameSync(path, `${path}.reserved`);
      fsSync.writeFileSync(path, "synthetic replacement", { mode: 0o600, flag: "wx" });
    }
    return originalStat(path, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint() }),
      { code: "local_collector_state_unavailable" });
    assert.equal(replaced, true);
    assert.equal(await readFile(value.stateFile, "utf8"), "synthetic replacement");
    assert.equal((await stat(`${value.stateFile}.reserved`)).size, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed collector initialization removes only its own untouched reservation", async (t) => {
  const value = await fixture();
  const originalExec = DatabaseSync.prototype.exec;
  let fail = true;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    if (fail) { fail = false; throw new Error("synthetic initial open failure"); }
    return originalExec.call(this, sql);
  });
  try {
    await assert.rejects(commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint() }),
      { code: "local_collector_state_unavailable" });
    await assert.rejects(stat(value.stateFile), { code: "ENOENT" });
    t.mock.restoreAll();
    await commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint() });
    assert.equal((await readLocalCollectorState({ stateFile: value.stateFile })).status, "available");
  } finally {
    t.mock.restoreAll();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed collector initialization preserves nonempty partial state for diagnosis", async (t) => {
  const value = await fixture();
  const originalExec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    const result = originalExec.call(this, sql);
    if (sql.includes("CREATE TABLE IF NOT EXISTS meta")) throw new Error("synthetic schema completion failure");
    return result;
  });
  try {
    await assert.rejects(commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint() }),
      { code: "local_collector_state_unavailable" });
    const before = await readFile(value.stateFile);
    assert.ok(before.byteLength > 0);
    if (process.platform !== "win32") assert.equal((await stat(value.stateFile)).mode & 0o777, 0o600);
    t.mock.restoreAll();
    await assert.rejects(commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: checkpoint() }),
      { code: "local_collector_state_schema_invalid" });
    assert.deepEqual(await readFile(value.stateFile), before);
  } finally {
    t.mock.restoreAll();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("accounting caches use compact JSON while old caches and canonical collector bytes remain compatible", async () => {
  const value = await fixture();
  const cache = {
    timeline: [[1_700_000_000_000, 0, 1.25, null], [1_700_000_900_000, 2, 0, 100]],
    metadata: { z: "synthetic café\nreading", a: true },
  };
  const first = checkpoint();
  const event = record("compact-cache-compatibility");
  try {
    await commitLocalCollectorState({ stateFile: value.stateFile, checkpoint: first, records: [event] });
    let database = new DatabaseSync(value.stateFile);
    let before;
    try {
      database.prepare("INSERT INTO meta(key, value_json) VALUES ('accounting_cache', ?)")
        .run(stableJson(cache));
      before = database.prepare("SELECT record_json, record_digest FROM records").get();
      assert.equal(before.record_json, stableJson(event));
      assert.equal(database.prepare("SELECT value_json FROM meta WHERE key = 'checkpoint'").get().value_json,
        stableJson(first));
    } finally { database.close(); }
    assert.deepEqual((await readLocalCollectorState({ stateFile: value.stateFile })).accountingCache, cache);
    await writeLocalCollectorAccountingCache({ stateFile: value.stateFile, cache });
    database = new DatabaseSync(value.stateFile);
    try {
      const stored = database.prepare("SELECT value_json FROM meta WHERE key = 'accounting_cache'").get().value_json;
      assert.equal(stored, JSON.stringify(cache));
      assert.equal(stored, serializeLocalCollectorAccountingCache(cache));
      assert.ok(Buffer.byteLength(stored) < Buffer.byteLength(stableJson(cache)));
      assert.ok(Buffer.byteLength(stored) > stored.length, "non-ASCII cache values are counted in UTF-8 bytes");
      assert.deepEqual(JSON.parse(stored), cache);
      assert.deepEqual(database.prepare("SELECT record_json, record_digest FROM records").get(), before);
      assert.equal(database.prepare("SELECT value_json FROM meta WHERE key = 'checkpoint'").get().value_json,
        stableJson(first));
    } finally { database.close(); }
    assert.deepEqual((await readLocalCollectorState({ stateFile: value.stateFile })).accountingCache, cache);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("SQLite commits collector records and checkpoints atomically", async () => {
  const value = await fixture();
  try {
    const first = checkpoint();
    await commitLocalCollectorState({
      stateFile: value.stateFile,
      checkpoint: first,
      records: [record("first")],
      clock: () => Date.parse("2026-08-03T00:00:00.000Z"),
    });
    const changed = { ...first, lastQuotaObservedAt: "2026-08-03T00:01:00.000Z" };
    await assert.rejects(
      () => commitLocalCollectorState({
        stateFile: value.stateFile,
        checkpoint: changed,
        records: [record("second"), null],
      }),
      /collector record must be an object/,
    );
    const durable = await readLocalCollectorState({ stateFile: value.stateFile });
    assert.deepEqual(durable.checkpoint, first);
    assert.deepEqual(durable.records, [record("first")]);
    if (process.platform !== "win32") {
      assert.equal((await stat(value.stateFile)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("legacy refresh-use receipt increments durably in one fixed meta row", async () => {
  const value = await fixture();
  try {
    const first = await recordLocalCollectorLegacyRefreshAttempt({
      stateFile: value.stateFile,
      clock: () => Date.parse("2026-08-03T00:00:00.000Z"),
    });
    assert.deepEqual(first, {
      schemaVersion: "local-collector-legacy-refresh-use-v1",
      sourceMode: "legacy",
      attempts: 1,
      saturated: false,
      lastAttemptedAt: "2026-08-03T00:00:00.000Z",
    });
    const second = await recordLocalCollectorLegacyRefreshAttempt({
      stateFile: value.stateFile,
      clock: () => Date.parse("2026-08-03T00:01:00.000Z"),
    });
    assert.equal(second.attempts, 2);
    assert.equal(
      (await readLocalCollectorLegacyRefreshUse({ stateFile: value.stateFile }))
        .receipt.lastAttemptedAt,
      "2026-08-03T00:01:00.000Z",
    );
    const state = await readLocalCollectorState({
      stateFile: value.stateFile,
      includeRecords: false,
    });
    assert.deepEqual(state.legacyRefreshUse, second);
    const database = new DatabaseSync(value.stateFile, { readOnly: true });
    const rowCount = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM meta WHERE key = 'legacy_refresh_use'",
    ).get().count);
    database.close();
    assert.equal(rowCount, 1);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("legacy refresh-use receipt saturates without growing rows and rejects corrupt shape", async () => {
  const value = await fixture();
  try {
    await recordLocalCollectorLegacyRefreshAttempt({
      stateFile: value.stateFile,
      clock: () => Date.parse("2026-08-03T00:00:00.000Z"),
    });
    let database = new DatabaseSync(value.stateFile, { readOnly: false });
    database.prepare(
      "UPDATE meta SET value_json = ? WHERE key = 'legacy_refresh_use'",
    ).run(JSON.stringify({
      schemaVersion: "local-collector-legacy-refresh-use-v1",
      sourceMode: "legacy",
      attempts: LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX - 1,
      saturated: false,
      lastAttemptedAt: "2026-08-03T00:00:00.000Z",
    }));
    database.close();

    const saturated = await recordLocalCollectorLegacyRefreshAttempt({
      stateFile: value.stateFile,
      clock: () => Date.parse("2026-08-03T00:02:00.000Z"),
    });
    assert.equal(saturated.attempts, LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX);
    assert.equal(saturated.saturated, true);
    const stillSaturated = await recordLocalCollectorLegacyRefreshAttempt({
      stateFile: value.stateFile,
      clock: () => Date.parse("2026-08-03T00:03:00.000Z"),
    });
    assert.equal(stillSaturated.attempts, LOCAL_COLLECTOR_LEGACY_REFRESH_USE_MAX);
    assert.equal(stillSaturated.lastAttemptedAt, "2026-08-03T00:03:00.000Z");

    database = new DatabaseSync(value.stateFile, { readOnly: true });
    const rowCount = Number(database.prepare(
      "SELECT COUNT(*) AS count FROM meta WHERE key = 'legacy_refresh_use'",
    ).get().count);
    database.close();
    assert.equal(rowCount, 1);

    database = new DatabaseSync(value.stateFile, { readOnly: false });
    database.prepare(
      "UPDATE meta SET value_json = ? WHERE key = 'legacy_refresh_use'",
    ).run(JSON.stringify({ attempts: "not-a-count" }));
    database.close();
    await assert.rejects(
      () => readLocalCollectorLegacyRefreshUse({ stateFile: value.stateFile }),
      { code: "local_collector_state_corrupt" },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("state preparation recovers a hot SQLite rollback journal after a killed writer", {
  skip: process.platform === "win32",
}, async () => {
  const value = await fixture();
  let writer;
  try {
    const durableCheckpoint = checkpoint();
    await writeFile(
      join(value.stateDirectory, "collector-events.jsonl"),
      `${JSON.stringify(record("before-crash"))}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(value.stateDirectory, "collector-checkpoint-v0.3.json"),
      JSON.stringify(durableCheckpoint),
      { mode: 0o600 },
    );
    await prepareLocalCollectorState({ stateFile: value.stateFile });

    writer = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.env.TIBOTATTLE_STATE_FILE, {
          readOnly: false,
          timeout: 5_000,
        });
        database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;");
        database.prepare("UPDATE meta SET value_json = ? WHERE key = 'checkpoint'")
          .run(JSON.stringify({ crashed: true }));
        const insert = database.prepare(
          "INSERT INTO records(event_key, record_digest, kind, observed_at, observed_at_ms, record_json, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        for (let index = 0; index < 512; index += 1) {
          insert.run(
            "crash-" + index,
            "0".repeat(64),
            "crash_fixture",
            null,
            null,
            "x".repeat(16 * 1024),
            "2026-08-05T00:00:00.000Z",
          );
        }
        process.stdout.write("READY\\n");
        setInterval(() => {}, 1_000);
      `,
    ], {
      env: {
        ...process.env,
        TIBOTATTLE_STATE_FILE: value.stateFile,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    writer.stdout.setEncoding("utf8");
    await Promise.race([
      new Promise((resolveReady, rejectReady) => {
        let output = "";
        writer.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("READY\n")) resolveReady();
        });
        writer.once("exit", (code, signal) => {
          rejectReady(new Error(
            `SQLite crash fixture exited before READY (${code ?? signal})`,
          ));
        });
      }),
      new Promise((_, rejectTimeout) => {
        setTimeout(
          () => rejectTimeout(new Error("SQLite crash fixture timed out")),
          5_000,
        ).unref();
      }),
    ]);
    assert.equal(writer.kill("SIGKILL"), true);
    const [, signal] = await once(writer, "exit");
    assert.equal(signal, "SIGKILL");
    writer = null;

    assert.equal((await stat(`${value.stateFile}-journal`)).isFile(), true);
    await assert.rejects(
      () => readLocalCollectorState({ stateFile: value.stateFile }),
      { code: "local_collector_state_unavailable" },
    );
    const receipt = await prepareLocalCollectorState({
      stateFile: value.stateFile,
    });
    assert.equal(receipt.status, "complete");
    const recovered = await readLocalCollectorState({
      stateFile: value.stateFile,
    });
    assert.deepEqual(recovered.checkpoint, durableCheckpoint);
    assert.deepEqual(recovered.records, [record("before-crash")]);
  } finally {
    if (writer && writer.exitCode === null && writer.signalCode === null) {
      writer.kill("SIGKILL");
      await once(writer, "exit");
    }
    await rm(value.root, { recursive: true, force: true });
  }
});

test("migration streams parity-checked valid legacy state and removes only managed JSON paths", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  const checkpointFile = join(value.stateDirectory, "collector-checkpoint-v0.3.json");
  const projectionFile = `${collectorFile}.projection-v1.json`;
  const oldCacheFile = join(value.stateDirectory, "local-replay-safe-accounting-v0.1.json");
  const cacheFile = join(value.stateDirectory, "local-replay-safe-accounting-v0.2.json");
  const lockFile = join(value.stateDirectory, "collector.lock");
  const legacyCheckpoint = checkpoint();
  const legacyCache = {
    schemaVersion: "local-replay-safe-accounting-v0.2",
    generatedAt: "2026-08-03T00:00:00.000Z",
  };
  const supersededLegacyCache = {
    schemaVersion: "local-replay-safe-accounting-v0.1",
    generatedAt: "2026-08-02T00:00:00.000Z",
  };
  try {
    await writeFile(
      collectorFile,
      `${JSON.stringify(record("one"))}\n${JSON.stringify(record("one"))}\n${JSON.stringify(record("two", "2026-08-03T00:01:00.000Z"))}\n`,
      { mode: 0o600 },
    );
    await writeFile(checkpointFile, JSON.stringify(legacyCheckpoint), { mode: 0o600 });
    await writeFile(projectionFile, "obsolete projection", { mode: 0o600 });
    await writeFile(oldCacheFile, JSON.stringify(supersededLegacyCache), { mode: 0o600 });
    await writeFile(cacheFile, JSON.stringify(legacyCache), { mode: 0o600 });
    await writeFile(lockFile, JSON.stringify({
      pid: 77,
      startedAt: "2026-08-03T00:00:00.000Z",
    }), { mode: 0o600 });

    const receipt = await migrateLegacyLocalCollectorState({
      stateFile: value.stateFile,
      legacyProcessExists: () => false,
    });
    assert.equal(receipt.status, "complete");
    assert.deepEqual(receipt.parity, {
      records: true,
      checkpoint: true,
      accountingCache: true,
    });
    assert.equal(receipt.source.recordCount, 3);
    assert.equal(receipt.source.malformedLines, 0);
    assert.deepEqual(receipt.removedLegacyFiles.sort(), [
      "collector-checkpoint-v0.3.json",
      "collector-events.jsonl",
      "collector-events.jsonl.projection-v1.json",
      "collector.lock",
      "local-replay-safe-accounting-v0.1.json",
      "local-replay-safe-accounting-v0.2.json",
    ]);
    const migrated = await readLocalCollectorState({ stateFile: value.stateFile });
    assert.deepEqual(migrated.checkpoint, legacyCheckpoint);
    assert.deepEqual(migrated.accountingCache, legacyCache);
    assert.deepEqual(migrated.records, [
      record("one"),
      record("one"),
      record("two", "2026-08-03T00:01:00.000Z"),
    ]);
    for (const file of [
      collectorFile,
      checkpointFile,
      projectionFile,
      oldCacheFile,
      cacheFile,
      lockFile,
    ]) {
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("malformed legacy JSONL is retained for repair instead of silently retired", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  try {
    await writeFile(
      collectorFile,
      `${JSON.stringify(record("valid"))}\nnot-json\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => migrateLegacyLocalCollectorState({
        stateFile: value.stateFile,
        legacyProcessExists: () => false,
      }),
      { code: "local_collector_state_legacy_records_invalid" },
    );
    assert.match(await readFile(collectorFile, "utf8"), /not-json/u);
    const state = await readLocalCollectorState({
      stateFile: value.stateFile,
      includeRecords: false,
    });
    assert.equal(state.migration, null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("oversized legacy JSONL rows are bounded and retained for repair", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  try {
    await writeFile(
      collectorFile,
      `${"x".repeat(16 * 1024 * 1024 + 1)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      () => migrateLegacyLocalCollectorState({
        stateFile: value.stateFile,
        legacyProcessExists: () => false,
      }),
      { code: "local_collector_state_legacy_record_too_large" },
    );
    assert.equal((await stat(collectorFile)).size > 16 * 1024 * 1024, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a dry-run migration remains parity-verified until all legacy files are gone", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  const checkpointFile = join(value.stateDirectory, "collector-checkpoint-v0.3.json");
  try {
    await writeFile(collectorFile, `${JSON.stringify(record("one"))}\n`, { mode: 0o600 });
    await writeFile(checkpointFile, JSON.stringify(checkpoint()), { mode: 0o600 });
    const parity = await migrateLegacyLocalCollectorState({
      stateFile: value.stateFile,
      removeLegacy: false,
      legacyProcessExists: () => false,
    });
    assert.equal(parity.status, "parity_verified");
    await readFile(collectorFile, "utf8");
    const completed = await prepareLocalCollectorState({ stateFile: value.stateFile });
    assert.equal(completed.status, "complete");
    await assert.rejects(readFile(collectorFile), { code: "ENOENT" });
    await assert.rejects(readFile(checkpointFile), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a complete migration fails closed if a named legacy artifact reappears", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  try {
    await writeFile(collectorFile, `${JSON.stringify(record("one"))}\n`, { mode: 0o600 });
    await prepareLocalCollectorState({ stateFile: value.stateFile });
    await writeFile(collectorFile, `${JSON.stringify(record("unexpected"))}\n`, { mode: 0o600 });
    await assert.rejects(
      () => prepareLocalCollectorState({ stateFile: value.stateFile }),
      { code: "local_collector_state_legacy_reappeared" },
    );
    assert.match(await readFile(collectorFile, "utf8"), /unexpected/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("concurrent state preparation serializes legacy migration without duplicate rows", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  try {
    const payload = Array.from({ length: 200 }, (_, index) => JSON.stringify(
      record(`event-${index}`, `2026-08-03T00:${String(index % 60).padStart(2, "0")}:00.000Z`),
    )).join("\n");
    await writeFile(collectorFile, `${payload}\n`, { mode: 0o600 });
    const receipts = await Promise.all([
      prepareLocalCollectorState({ stateFile: value.stateFile }),
      prepareLocalCollectorState({ stateFile: value.stateFile }),
    ]);
    assert.deepEqual(receipts.map((receipt) => receipt.status), ["complete", "complete"]);
    const state = await readLocalCollectorState({ stateFile: value.stateFile });
    assert.equal(state.records.length, 200);
    await assert.rejects(readFile(collectorFile), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a durable parity receipt resumes JSON cleanup after an interrupted migration", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  const checkpointFile = join(value.stateDirectory, "collector-checkpoint-v0.3.json");
  const lockFile = join(value.stateDirectory, "collector.lock");
  const legacyCheckpoint = checkpoint();
  try {
    await writeFile(collectorFile, `${JSON.stringify(record("one"))}\n`, { mode: 0o600 });
    await writeFile(checkpointFile, JSON.stringify(legacyCheckpoint), { mode: 0o600 });
    await writeFile(lockFile, JSON.stringify({
      pid: 77,
      startedAt: "2026-08-03T00:00:00.000Z",
    }), { mode: 0o600 });
    await assert.rejects(
      () => migrateLegacyLocalCollectorState({
        stateFile: value.stateFile,
        removeLegacyPath: async () => {
          throw new Error("injected cleanup interruption");
        },
        legacyProcessExists: () => false,
      }),
      /injected cleanup interruption/,
    );
    const interrupted = await readLocalCollectorState({
      stateFile: value.stateFile,
      includeRecords: false,
    });
    assert.equal(interrupted.migration.status, "parity_verified");
    assert.deepEqual(interrupted.checkpoint, legacyCheckpoint);
    assert.equal((await readFile(collectorFile, "utf8")).includes('"one"'), true);
    assert.equal((await readFile(lockFile, "utf8")).includes('"pid":77'), true);

    const resumed = await migrateLegacyLocalCollectorState({
      stateFile: value.stateFile,
      legacyProcessExists: () => false,
    });
    assert.equal(resumed.status, "complete");
    assert.deepEqual((await readLocalCollectorState({ stateFile: value.stateFile })).records, [record("one")]);
    await assert.rejects(readFile(collectorFile), { code: "ENOENT" });
    await assert.rejects(readFile(checkpointFile), { code: "ENOENT" });
    await assert.rejects(readFile(lockFile), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a live legacy JSON lock blocks migration and preserves its source state", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  const lockFile = join(value.stateDirectory, "collector.lock");
  try {
    await writeFile(collectorFile, `${JSON.stringify(record("one"))}\n`, { mode: 0o600 });
    await writeFile(lockFile, JSON.stringify({
      pid: 77,
      startedAt: "2026-08-03T00:00:00.000Z",
    }), { mode: 0o600 });
    await assert.rejects(
      () => migrateLegacyLocalCollectorState({
        stateFile: value.stateFile,
        legacyProcessExists: () => true,
      }),
      { code: "local_collector_state_legacy_lock_held" },
    );
    assert.equal((await readFile(collectorFile, "utf8")).includes('"one"'), true);
    assert.equal((await readFile(lockFile, "utf8")).includes('"pid":77'), true);
    await assert.rejects(readFile(value.stateFile), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("state preparation resolves a committed old JSON journal before importing it once", async () => {
  const value = await fixture();
  const collectorFile = join(value.stateDirectory, "collector-events.jsonl");
  const checkpointFile = join(value.stateDirectory, "collector-checkpoint-v0.3.json");
  const journalFile = `${checkpointFile}.batch-journal`;
  const legacyCheckpoint = checkpoint();
  const payload = `${JSON.stringify(record("journaled"))}\n`;
  const digest = (input) => createHash("sha256").update(input).digest("hex");
  try {
    await writeFile(collectorFile, payload, { mode: 0o600 });
    await writeFile(checkpointFile, JSON.stringify(legacyCheckpoint), { mode: 0o600 });
    await writeFile(journalFile, JSON.stringify({
      schemaVersion: "0.1",
      state: "prepared",
      dataStartOffset: 0,
      payloadBytes: Buffer.byteLength(payload),
      payloadDigest: digest(payload),
      checkpointAfterDigest: digest(stableJson(legacyCheckpoint)),
    }), { mode: 0o600 });

    const receipt = await prepareLocalCollectorState({ stateFile: value.stateFile });
    assert.equal(receipt.status, "complete");
    const migrated = await readLocalCollectorState({ stateFile: value.stateFile });
    assert.deepEqual(migrated.records, [record("journaled")]);
    assert.deepEqual(migrated.checkpoint, legacyCheckpoint);
    for (const file of [collectorFile, checkpointFile, journalFile]) {
      await assert.rejects(readFile(file), { code: "ENOENT" });
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("state record iteration is bounded by rows rather than a whole-ledger read", async () => {
  const value = await fixture();
  try {
    await commitLocalCollectorState({
      stateFile: value.stateFile,
      checkpoint: checkpoint(),
      records: [record("one"), record("two")],
    });
    const keys = [];
    const result = await forEachLocalCollectorRecord({
      stateFile: value.stateFile,
      onRecord: async (valueRecord) => keys.push(valueRecord.eventKey),
    });
    assert.deepEqual(result, { status: "available", recordCount: 2 });
    assert.deepEqual(keys, ["one", "two"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("state summaries and kind filters avoid replaying usage JSON rows", async () => {
  const value = await fixture();
  try {
    await prepareLocalCollectorState({ stateFile: value.stateFile });
    assert.deepEqual(
      await readLocalCollectorRecordSummary({ stateFile: value.stateFile }),
      {
        status: "available",
        recordCount: 0,
        recordCounts: { usage: 0, quota: 0, tools: 0, other: 0 },
        firstObservedAtMs: null,
        latestObservedAtMs: null,
        firstUsageObservedAtMs: null,
        latestUsageObservedAtMs: null,
      },
    );
    const usage = {
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt: "2026-08-03T00:01:00.000Z",
      eventKey: "usage",
    };
    const quota = {
      kind: "codex_quota_snapshot",
      observedAt: "2026-08-03T00:02:00.000Z",
      eventKey: "quota",
    };
    await commitLocalCollectorState({
      stateFile: value.stateFile,
      checkpoint: checkpoint(),
      records: [usage, quota, record("tool")],
    });
    const selected = [];
    const selectedResult = await forEachLocalCollectorRecord({
      stateFile: value.stateFile,
      kinds: ["codex_tool_class_event", "codex_tool_class_event"],
      onRecord: (valueRecord) => selected.push(valueRecord.eventKey),
    });
    assert.deepEqual(selectedResult, { status: "available", recordCount: 1 });
    assert.deepEqual(selected, ["tool"]);
    assert.deepEqual(
      await readLocalCollectorRecordSummary({
        stateFile: value.stateFile,
        maximumUsageObservedAtMs: Date.parse("2026-08-03T00:01:30.000Z"),
      }),
      {
        status: "available",
        recordCount: 3,
        recordCounts: { usage: 1, quota: 1, tools: 1, other: 0 },
        firstObservedAtMs: Date.parse("2026-08-03T00:00:00.000Z"),
        latestObservedAtMs: Date.parse("2026-08-03T00:02:00.000Z"),
        firstUsageObservedAtMs: Date.parse("2026-08-03T00:01:00.000Z"),
        latestUsageObservedAtMs: Date.parse("2026-08-03T00:01:00.000Z"),
      },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("state streaming can order by observation time and keeps exact rollout staleness percentiles off heap", async () => {
  const value = await fixture();
  const rollout = (eventKey, observedAt, stalenessMs) => ({
    schemaVersion: "0.3",
    kind: "codex_rollout_usage_snapshot",
    observedAt,
    eventKey,
    stalenessMs,
  });
  try {
    await commitLocalCollectorState({
      stateFile: value.stateFile,
      checkpoint: checkpoint(),
      records: [
        rollout("late", "2026-08-03T00:02:00.000Z", 30),
        rollout("early", "2026-08-03T00:01:00.000Z", 10),
        rollout("middle", "2026-08-03T00:01:30.000Z", 20),
      ],
    });
    const observed = [];
    await forEachLocalCollectorRecord({
      stateFile: value.stateFile,
      orderBy: "observed_at",
      onRecord: (valueRecord) => observed.push(valueRecord.eventKey),
    });
    assert.deepEqual(observed, ["early", "middle", "late"]);
    assert.deepEqual(
      await readLocalCollectorRolloutStalenessSummary({ stateFile: value.stateFile }),
      { status: "available", recordCount: 3, p50: 20, p90: 28 },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("collector-state maintenance reports and plans retention without changing records", async () => {
  const value = await fixture();
  try {
    await commitLocalCollectorState({
      stateFile: value.stateFile,
      checkpoint: checkpoint(),
      records: [
        record("old", "2026-08-01T00:00:00.000Z"),
        record("new", "2026-08-03T00:00:00.000Z"),
      ],
    });
    const status = await inspectLocalCollectorStateStorage({ stateFile: value.stateFile });
    assert.equal(status.status, "available");
    assert.equal(status.recordCount, 2);
    assert.equal(status.fileBytes > 0, true);
    assert.equal(status.recordJsonBytes > 0, true);
    assert.equal(status.needsReview, false);
    const plan = await planLocalCollectorStateRetention({
      stateFile: value.stateFile,
      before: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(plan.action, "no_changes");
    assert.equal(plan.eligible.recordCount, 1);
    assert.equal(plan.retained.recordCount, 1);
    assert.match(plan.eligible.digest, /^[a-f0-9]{64}$/u);
    assert.equal((await readLocalCollectorState({ stateFile: value.stateFile })).records.length, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("SQLite collector lock rejects a second live owner and releases cleanly", async () => {
  const value = await fixture();
  try {
    const release = await acquireLocalCollectorStateLock(value.stateFile, {
      processExists: () => true,
    });
    await assert.rejects(
      () => acquireLocalCollectorStateLock(value.stateFile, {
        processExists: () => true,
      }),
      /local_collector_state_lock_held/,
    );
    await release();
    const releaseAgain = await acquireLocalCollectorStateLock(value.stateFile, {
      processExists: () => true,
    });
    await releaseAgain();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
