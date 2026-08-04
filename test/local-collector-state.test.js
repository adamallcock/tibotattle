import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  readLocalCollectorRolloutStalenessSummary,
  readLocalCollectorState,
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
    assert.equal((await stat(value.stateFile)).mode & 0o777, 0o600);
  } finally {
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
