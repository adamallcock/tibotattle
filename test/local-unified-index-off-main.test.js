import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import test from "node:test";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ingestLocalUnifiedIndexOffMain,
  runLocalUnifiedIndexOffMainWorker,
  shouldRunLocalUnifiedIndexOffMain,
} from "../src/local-unified-index-off-main.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  localUnifiedIndexStageFile,
} from "../src/local-unified-index-build.js";
import {
  LOCAL_UNIFIED_INDEX_USER_VERSION,
  openLocalUnifiedIndex,
  removeExactLocalUnifiedIndexAttemptStages,
  removeAbandonedLocalUnifiedIndexStages,
} from "../src/local-unified-index.js";

const CONTRACT = "usage-event-v0.2";
const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const FOURTH_THREAD_ID = "44444444-4444-4444-8444-444444444444";

function rolloutFixture({
  threadId = THREAD_ID,
  hour = "00",
  parentId = null,
  paddingBytes = 0,
  usageRows = 1,
  inputPerEvent = 10,
} = {}) {
  const start = Date.parse(`2026-08-24T${hour}:00:00.000Z`);
  const timestamp = (seconds) => new Date(start + seconds * 1_000).toISOString();
  return [
    JSON.stringify({
      timestamp: timestamp(0),
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        thread_source: parentId === null ? "user" : "subagent",
        originator: "codex_cli_rs",
        ...(parentId === null ? {} : { forked_from_id: parentId }),
      },
    }),
    JSON.stringify({
      timestamp: timestamp(1),
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model: "gpt-5.6-sol",
        effort: "high",
        ...(paddingBytes === 0 ? {} : { padding: "x".repeat(paddingBytes) }),
      },
    }),
    ...Array.from({ length: usageRows }, (_, index) => {
      const count = index + 1;
      return JSON.stringify({
        timestamp: timestamp(index + 2),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: inputPerEvent * count,
              cached_input_tokens: 0,
              output_tokens: 2 * count,
              reasoning_output_tokens: 0,
              total_tokens: (inputPerEvent + 2) * count,
            },
            last_token_usage: {
              input_tokens: inputPerEvent,
              cached_input_tokens: 0,
              output_tokens: 2,
              reasoning_output_tokens: 0,
              total_tokens: inputPerEvent + 2,
            },
          },
        },
      });
    }),
  ].join("\n") + "\n";
}

function writeCheckpointRollout(root, options) {
  const { hour, threadId } = options;
  return writeFile(join(
    root, "sessions", "2026", "08", "24",
    `rollout-2026-08-24T${hour}-00-00-${threadId}.jsonl`,
  ), rolloutFixture(options));
}

function readIndexedUsage(indexFile) {
  const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  try {
    return database.prepare(`
      SELECT hex(event_key) AS event_key, source_ordinal, observed_at_ms,
             tokens_in_uncached, tokens_out_text
      FROM usage_event
      ORDER BY observed_at_ms, source_ordinal, event_key
    `).all();
  } finally {
    database.close();
  }
}

async function incrementalArtifacts(root) {
  return (await readdir(root)).filter((name) => name.startsWith("index.sqlite.incremental-"));
}

async function createRolloutRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sessions = join(root, "sessions", "2026", "08", "24");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`),
    rolloutFixture(),
  );
  return root;
}

test("only native macOS companions select off-main unified ingestion", () => {
  assert.equal(shouldRunLocalUnifiedIndexOffMain({ platform: "darwin" }), true);
  assert.equal(shouldRunLocalUnifiedIndexOffMain({ platform: "linux" }), false);
  assert.equal(shouldRunLocalUnifiedIndexOffMain({ platform: "win32" }), false);
});

test("native unified ingestion completes a cold rebuild and forwards progress", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await createRolloutRoot("unified-index-off-main-");
  try {
    const progress = [];
    const result = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      onProgress: (value) => progress.push(value),
    });
    assert.equal(result.status, "ingested");
    assert.equal(result.generation.status, "complete");
    assert.equal(result.rebuilt, true);
    assert.equal(result.rebuildReason, "missing_index");
    assert.equal(result.workerCount, 1);
    assert.equal(result.sourcesScanned, 1);
    assert.equal(progress.length > 0, true);
    const database = openLocalUnifiedIndex(join(root, "index.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(Number(database.prepare(
        "PRAGMA user_version",
      ).get().user_version), LOCAL_UNIFIED_INDEX_USER_VERSION);
      assert.deepEqual(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'usage_event_source', 'usage_event_quota_observation')
        ORDER BY name`).all().map((row) => row.name), [
        "usage_event_quota_observation",
        "usage_event_source",
      ]);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Darwin cold default leaves an existing index on incremental ingest", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await createRolloutRoot("unified-index-off-main-existing-");
  const indexFile = join(root, "index.sqlite");
  const sourceFile = join(
    root,
    "sessions",
    "2026",
    "08",
    "24",
    `rollout-2026-08-24T00-00-00-${THREAD_ID}.jsonl`,
  );
  try {
    const first = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(first.rebuildReason, "missing_index");
    await appendFile(sourceFile, `${JSON.stringify({
      timestamp: "2026-08-24T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 20,
            output_tokens: 4,
            total_tokens: 24,
          },
          last_token_usage: {
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
        },
      },
    })}\n`);

    const second = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(second.rebuilt, undefined);
    assert.equal(second.rebuildReason, undefined);
    assert.equal(second.sourcesResumed, 1);
    assert.equal(second.sourcesRescanned, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Darwin off-main ingestion migrates v10 indexes without a cold rebuild", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await createRolloutRoot("unified-index-off-main-v10-");
  const indexFile = join(root, "index.sqlite");
  try {
    const first = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(first.rebuilt, true);

    const old = openLocalUnifiedIndex(indexFile, { readOnly: false });
    old.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX usage_event_source;
      DROP INDEX usage_event_quota_observation;
      UPDATE meta SET value = '10'
      WHERE key IN (
        'compatibility_format_user_version',
        'compatibility_minimum_reader_user_version',
        'compatibility_minimum_writer_user_version');
      PRAGMA user_version=10;
      COMMIT;
    `);
    old.close();

    const migrated = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile,
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
    });
    assert.equal(migrated.rebuilt, undefined);
    assert.equal(migrated.rebuildReason, undefined);
    assert.equal(migrated.sourcesScanned, 0);
    assert.equal(migrated.totalUsageEvents, 1);
    const current = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(Number(current.prepare(
        "PRAGMA user_version",
      ).get().user_version), LOCAL_UNIFIED_INDEX_USER_VERSION);
    } finally {
      current.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit false keeps a fresh Darwin target on incremental ingest", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await createRolloutRoot("unified-index-off-main-explicit-false-");
  try {
    const result = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      coldRebuildIfMissing: false,
    });
    assert.equal(result.status, "ingested");
    assert.equal(result.rebuilt, undefined);
    assert.equal(result.rebuildReason, undefined);
    assert.equal(result.sourcesScanned, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold rebuild missing flag requires a boolean", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-cold-flag-invalid-"));
  try {
    await assert.rejects(
      ingestLocalUnifiedIndexIncrement({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        coldRebuildIfMissing: "yes",
      }),
      (error) => error instanceof TypeError
        && error.message === "coldRebuildIfMissing must be a boolean",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cold worker override reaches a missing-index rebuild", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await createRolloutRoot("unified-index-off-main-workers-");
  try {
    const result = await ingestLocalUnifiedIndexOffMain({
      codexHome: root,
      indexFile: join(root, "index.sqlite"),
      secretFile: join(root, "salt"),
      contractVersion: CONTRACT,
      coldBackfillWorkerCount: 2,
    });
    assert.equal(result.rebuilt, true);
    assert.equal(result.rebuildReason, "missing_index");
    assert.equal(result.workerCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("off-main stage names are token-exact", () => {
  const indexFile = "/tmp/tibotattle-unified/index.sqlite";
  const token = "a".repeat(32);
  assert.equal(
    localUnifiedIndexStageFile(indexFile, "incremental", token),
    `${indexFile}.incremental-${process.pid}-${token}`,
  );
  assert.equal(
    localUnifiedIndexStageFile(indexFile, "building", token),
    `${indexFile}.building-${process.pid}-${token}`,
  );
  assert.match(
    localUnifiedIndexStageFile(indexFile, "building"),
    /\.building-[1-9][0-9]*-[0-9a-z]+$/u,
  );
  assert.throws(
    () => localUnifiedIndexStageFile(indexFile, "building", "not-a-token"),
    (error) => error?.code === "local_unified_index_attempt_token_invalid",
  );
});

test("exact attempt cleanup refuses a stage that is not owner-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-exact-unsafe-"));
  const indexFile = join(root, "index.sqlite");
  const attemptToken = "e".repeat(32);
  const stage = localUnifiedIndexStageFile(
    indexFile,
    "building",
    attemptToken,
  );
  try {
    await writeFile(stage, "unsafe exact stage", { mode: 0o600 });
    await chmod(stage, 0o644);
    assert.deepEqual(
      await removeExactLocalUnifiedIndexAttemptStages(indexFile, attemptToken),
      { inspected: 1, removed: 0, skipped: 1 },
    );
    await assert.doesNotReject(() => access(stage));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-PID cleanup preserves the active token and legacy stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-off-main-orphan-"));
  const activeToken = "c".repeat(32);
  const oldToken = "d".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const activeStage = localUnifiedIndexStageFile(
    indexFile,
    "building",
    activeToken,
  );
  const oldStage = localUnifiedIndexStageFile(
    indexFile,
    "incremental",
    oldToken,
  );
  const legacyStage = `${indexFile}.building-${process.pid}-legacy`;
  const nowMs = Date.now();
  try {
    await Promise.all([
      writeFile(activeStage, "active", { mode: 0o600 }),
      writeFile(oldStage, "old", { mode: 0o600 }),
      writeFile(legacyStage, "legacy", { mode: 0o600 }),
    ]);
    const fresh = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      platform: "darwin",
      activeAttemptToken: activeToken,
      isProcessAlive: () => true,
    });
    assert.deepEqual(fresh, { inspected: 3, removed: 0, skipped: 3 });

    const old = new Date(nowMs - 60_001);
    await utimes(oldStage, old, old);
    const reclaimed = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      platform: "darwin",
      activeAttemptToken: activeToken,
      isProcessAlive: () => true,
    });
    assert.equal(reclaimed.removed, 1);
    assert.equal(reclaimed.skipped, 2);
    await assert.rejects(() => access(oldStage));
    await Promise.all([
      assert.doesNotReject(() => access(activeStage)),
      assert.doesNotReject(() => access(legacyStage)),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rotating cleanup reaches stale stages behind more than 64 skipped names", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-stage-rotation-"));
  const indexFile = join(root, "index.sqlite");
  const tokenFor = (value) => value.toString(16).padStart(32, "0");
  const activeToken = tokenFor(0);
  const youngStages = Array.from({ length: 80 }, (_, index) => (
    localUnifiedIndexStageFile(indexFile, "building", tokenFor(index))
  ));
  const staleStage = localUnifiedIndexStageFile(
    indexFile,
    "incremental",
    "f".repeat(32),
  );
  const nowMs = Date.now();
  try {
    for (const stage of [...youngStages, staleStage]) {
      await writeFile(stage, "bounded stage", { mode: 0o600 });
    }
    const old = new Date(nowMs - 60_001);
    await utimes(staleStage, old, old);

    const first = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      scanLimit: 64,
      platform: "darwin",
      activeAttemptToken: activeToken,
      isProcessAlive: () => true,
    });
    assert.ok(first.inspected <= 64);
    const second = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      scanLimit: 64,
      platform: "darwin",
      activeAttemptToken: activeToken,
      isProcessAlive: () => true,
    });
    assert.ok(second.inspected <= 64);
    assert.equal(first.removed + second.removed, 1);
    await assert.rejects(() => access(staleStage));
    await assert.doesNotReject(() => access(youngStages[0]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleted scan position stays bounded and later stages are not starved", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-stage-bounded-cursor-"));
  const indexFile = join(root, "index.sqlite");
  const scanLimit = 8;
  const tokenFor = (value) => value.toString(16).padStart(32, "0");
  const youngStages = Array.from({ length: 256 }, (_, index) => (
    localUnifiedIndexStageFile(indexFile, "building", tokenFor(index))
  ));
  let totalDirectoryReads = 0;
  let observedNames = [];
  const countedOpenDirectory = async (directory, options) => {
    const handle = await opendir(directory, options);
    return {
      async read() {
        totalDirectoryReads += 1;
        const entry = await handle.read();
        if (entry !== null) observedNames.push(entry.name);
        return entry;
      },
      close: () => handle.close(),
    };
  };
  const scan = async (nowMs) => {
    const readsBefore = totalDirectoryReads;
    observedNames = [];
    const receipt = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      scanLimit,
      platform: "darwin",
      activeAttemptToken: tokenFor(0),
      isProcessAlive: () => true,
      openDirectory: countedOpenDirectory,
    });
    assert.ok(
      totalDirectoryReads - readsBefore <= scanLimit,
      "one cleanup pass exceeded its raw directory-read bound",
    );
    assert.ok(receipt.inspected <= scanLimit);
    return receipt;
  };

  try {
    for (const stage of youngStages) {
      await writeFile(stage, "young stage", { mode: 0o600 });
    }
    const nowMs = Date.now();
    await scan(nowMs);
    const lastObserved = observedNames.at(-1);
    assert.equal(typeof lastObserved, "string");
    await unlink(join(root, lastObserved));

    // Add the eligible target only after deleting the last observed entry. A
    // filename cursor would now rescan the whole directory looking for a name
    // that cannot be found; the retained Dir position continues in O(limit).
    const staleStage = localUnifiedIndexStageFile(
      indexFile,
      "incremental",
      "f".repeat(32),
    );
    await writeFile(staleStage, "stale stage", { mode: 0o600 });
    const old = new Date(nowMs - 60_001);
    await utimes(staleStage, old, old);

    let removed = 0;
    for (let pass = 0; pass < 100; pass += 1) {
      removed += (await scan(nowMs)).removed;
      try {
        await access(staleStage);
      } catch (error) {
        if (error?.code === "ENOENT") break;
        throw error;
      }
    }
    assert.equal(removed, 1);
    await assert.rejects(() => access(staleStage));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandoned cleanup preserves a substituted target inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-stage-target-race-"));
  const indexFile = join(root, "index.sqlite");
  const deadPid = process.pid === 999_999 ? 999_998 : 999_999;
  const stage = `${indexFile}.incremental-${deadPid}-${"e".repeat(32)}`;
  const originalStage = `${stage}.original`;
  const nowMs = Date.now();
  const old = new Date(nowMs - 60_001);
  let substituted = false;
  try {
    await writeFile(stage, "original stale stage", { mode: 0o600 });
    await utimes(stage, old, old);

    const receipt = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      platform: "darwin",
      isProcessAlive(pid) {
        assert.equal(pid, deadPid);
        renameSync(stage, originalStage);
        writeFileSync(stage, "substituted stale stage", { mode: 0o600 });
        utimesSync(stage, old, old);
        substituted = true;
        return false;
      },
    });

    assert.equal(substituted, true);
    assert.deepEqual(receipt, { inspected: 1, removed: 0, skipped: 1 });
    assert.equal(await readFile(stage, "utf8"), "substituted stale stage");
    assert.equal(await readFile(originalStage, "utf8"), "original stale stage");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandoned cleanup preserves files after parent replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-stage-parent-race-"));
  const movedRoot = `${root}-original`;
  const indexFile = join(root, "index.sqlite");
  const deadPid = process.pid === 888_888 ? 888_887 : 888_888;
  const stageName = `index.sqlite.building-${deadPid}-${"d".repeat(32)}`;
  const stage = join(root, stageName);
  const movedStage = join(movedRoot, stageName);
  const nowMs = Date.now();
  const old = new Date(nowMs - 60_001);
  let substituted = false;
  try {
    await writeFile(stage, "original parent stage", { mode: 0o600 });
    await utimes(stage, old, old);

    const receipt = await removeAbandonedLocalUnifiedIndexStages(indexFile, {
      nowMs,
      minimumAgeMs: 60_000,
      platform: "darwin",
      isProcessAlive(pid) {
        assert.equal(pid, deadPid);
        renameSync(root, movedRoot);
        mkdirSync(root, { mode: 0o700 });
        writeFileSync(stage, "substituted parent stage", { mode: 0o600 });
        utimesSync(stage, old, old);
        substituted = true;
        return false;
      },
    });

    assert.equal(substituted, true);
    assert.deepEqual(receipt, { inspected: 1, removed: 0, skipped: 1 });
    assert.equal(await readFile(stage, "utf8"), "substituted parent stage");
    assert.equal(await readFile(movedStage, "utf8"), "original parent stage");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(movedRoot, { recursive: true, force: true });
  }
});

test("cooperative worker cancellation retains completed groups for retry", async () => {
  const root = await createRolloutRoot("unified-index-off-main-cancel-");
  const controller = new AbortController();
  const indexFile = join(root, "index.sqlite");
  const cleanFile = join(root, "clean.sqlite");
  const options = {
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  };
  try {
    await runLocalUnifiedIndexOffMainWorker(options);
    const before = await readFile(indexFile);
    await copyFile(indexFile, cleanFile);
    await writeCheckpointRollout(root, {
      hour: "01",
      threadId: SECOND_THREAD_ID,
      paddingBytes: 256,
      inputPerEvent: 20,
    });
    await writeCheckpointRollout(root, {
      hour: "02",
      threadId: THIRD_THREAD_ID,
      inputPerEvent: 30,
    });

    await assert.rejects(
      runLocalUnifiedIndexOffMainWorker(options, {
        signal: controller.signal,
        onProgress: ({ sourcesScanned }) => {
          if (sourcesScanned === 1) controller.abort();
        },
      }),
      { code: "local_unified_index_aborted" },
    );
    assert.deepEqual(await readFile(indexFile), before);
    assert.deepEqual(
      await incrementalArtifacts(root),
      ["index.sqlite.incremental-checkpoint"],
    );
    assert.deepEqual(
      readIndexedUsage(`${indexFile}.incremental-checkpoint`)
        .map((row) => row.tokens_in_uncached),
      [10, 20],
    );

    const resumed = await runLocalUnifiedIndexOffMainWorker(options);
    const clean = await runLocalUnifiedIndexOffMainWorker({
      ...options, indexFile: cleanFile,
    });
    assert.equal(resumed.generation.status, "complete");
    assert.equal(resumed.sourcesScanned, 1);
    assert.equal(clean.sourcesScanned, 2);
    const usage = readIndexedUsage(indexFile);
    assert.deepEqual(usage.map((row) => row.tokens_in_uncached), [10, 20, 30]);
    assert.deepEqual(usage, readIndexedUsage(cleanFile));
    assert.deepEqual(await incrementalArtifacts(root), []);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("killed ingestion recovers a hot checkpoint journal and replays the unfinished fork group", {
  skip: process.platform === "win32",
}, async () => {
  const root = await createRolloutRoot("unified-index-checkpoint-kill-");
  const indexFile = join(root, "index.sqlite");
  const cleanFile = join(root, "clean.sqlite");
  const journalFile = `${indexFile}.incremental-checkpoint-journal`;
  const options = {
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  };
  try {
    await ingestLocalUnifiedIndexIncrement(options);
    const before = await readFile(indexFile);
    await copyFile(indexFile, cleanFile);
    // Components run largest first. Finish an independent group before the
    // process exits after writing the parent in the next group.
    await writeCheckpointRollout(root, {
      hour: "01",
      threadId: SECOND_THREAD_ID,
      paddingBytes: 150_000,
      inputPerEvent: 20,
    });
    await writeCheckpointRollout(root, {
      hour: "02",
      threadId: THIRD_THREAD_ID,
      usageRows: 200,
      inputPerEvent: 30,
    });
    await writeCheckpointRollout(root, {
      hour: "03",
      threadId: FOURTH_THREAD_ID,
      parentId: THIRD_THREAD_ID,
      inputPerEvent: 10_000,
    });

    const ingestModule = new URL("../src/local-unified-index-ingest.js", import.meta.url);
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        const result = exec.call(this, sql);
        if (sql.includes("PRAGMA cache_size=")) {
          // Make a small fixture spill dirty pages to disk before it is killed.
          exec.call(this, "PRAGMA cache_size=5; PRAGMA cache_spill=ON");
        }
        return result;
      };
      const { ingestLocalUnifiedIndexIncrement } = await import(process.argv[1]);
      await ingestLocalUnifiedIndexIncrement({
        ...JSON.parse(process.argv[2]),
        onProgress({ sourcesScanned }) {
          if (sourcesScanned === 2) process.kill(process.pid, "SIGKILL");
        },
      });
    `, ingestModule.href, JSON.stringify(options)], { encoding: "utf8", timeout: 20_000 });
    assert.ifError(crashed.error);
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    assert.deepEqual(await readFile(indexFile), before);
    // SQLite writes this magic after journal sync and before spilling pages.
    // A journal with a zeroed header would miss the recovery path under test.
    const journal = await readFile(journalFile);
    assert.equal(journal.subarray(0, 8).toString("hex"), "d9d505f920a163d7");

    const resumed = await ingestLocalUnifiedIndexIncrement(options);
    const clean = await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: cleanFile });
    assert.equal(resumed.generation.status, "complete");
    assert.equal(resumed.sourcesScanned, 2);
    assert.equal(clean.sourcesScanned, 3);
    const usage = readIndexedUsage(indexFile);
    assert.equal(usage.length, 203);
    assert.deepEqual(usage, readIndexedUsage(cleanFile));
    assert.deepEqual(await incrementalArtifacts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hard cancellation waits for confirmed termination and ignores late results", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-worker-abort-"));
  const controller = new AbortController();
  let worker = null;
  let grace = null;
  let releaseTermination = null;
  const attemptToken = "b".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const hardStage = localUnifiedIndexStageFile(
    indexFile,
    "incremental",
    attemptToken,
  );

  class HangingWorker extends EventEmitter {
    constructor(_url, { workerData }) {
      super();
      this.workerData = workerData;
      worker = this;
    }

    postMessage(message) {
      this.lastMessage = message;
    }

    terminate() {
      return new Promise((resolve) => {
        releaseTermination = () => {
          this.emit("exit", 1);
          resolve(1);
        };
      });
    }
  }

  try {
    await writeFile(hardStage, "untrusted partial stage", { mode: 0o600 });
    let settled = false;
    const pending = runLocalUnifiedIndexOffMainWorker({
      codexHome: root,
      indexFile,
      contractVersion: CONTRACT,
    }, {
      signal: controller.signal,
      attemptToken,
      WorkerClass: HangingWorker,
      abortGraceMs: 25,
      setTimeoutImpl(callback, delay) {
        grace = { callback, delay, unref() {} };
        return grace;
      },
      clearTimeoutImpl() {},
    }).finally(() => {
      settled = true;
    });

    controller.abort();
    assert.equal(worker.lastMessage.type, "abort");
    assert.equal(worker.workerData.options.attemptToken, attemptToken);
    assert.equal(grace.delay, 25);
    worker.emit("message", { type: "result", result: { status: "ingested" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    grace.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseTermination, "function");
    assert.equal(settled, false);
    releaseTermination();
    await assert.rejects(
      pending,
      (error) => error?.code === "local_unified_index_aborted",
    );
    // terminate() has settled and the attempt token is exact, so the parent can
    // remove this owner-only stage without waiting for the abandoned-stage age.
    await assert.rejects(() => access(hardStage));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated hard terminations leave no exact attempt stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-worker-repeated-kill-"));
  const indexFile = join(root, "index.sqlite");

  class TerminatedWorker extends EventEmitter {
    postMessage() {}

    terminate() {
      this.emit("exit", 1);
      return Promise.resolve(1);
    }
  }

  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const controller = new AbortController();
      const attemptToken = (attempt + 1).toString(16).padStart(32, "0");
      const stage = localUnifiedIndexStageFile(
        indexFile,
        attempt % 2 === 0 ? "building" : "incremental",
        attemptToken,
      );
      await writeFile(stage, "terminated partial stage", { mode: 0o600 });
      let terminateAfterGrace = null;
      const pending = runLocalUnifiedIndexOffMainWorker({
        codexHome: root,
        indexFile,
        contractVersion: CONTRACT,
      }, {
        signal: controller.signal,
        attemptToken,
        WorkerClass: TerminatedWorker,
        abortGraceMs: 1,
        setTimeoutImpl(callback) {
          terminateAfterGrace = callback;
          return { unref() {} };
        },
        clearTimeoutImpl() {},
      });
      controller.abort();
      terminateAfterGrace();
      await assert.rejects(
        pending,
        (error) => error?.code === "local_unified_index_aborted",
      );
      await assert.rejects(() => access(stage));
    }
    assert.deepEqual(
      (await readdir(root)).filter((name) => (
        name.includes(".building-") || name.includes(".incremental-")
      )),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("termination failure keeps the index claimed until worker exit is observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-worker-kill-fail-"));
  const controller = new AbortController();
  const attemptToken = "a".repeat(32);
  const indexFile = join(root, "index.sqlite");
  const stage = localUnifiedIndexStageFile(
    indexFile,
    "incremental",
    attemptToken,
  );
  let worker = null;
  let grace = null;

  class RejectingWorker extends EventEmitter {
    constructor() {
      super();
      worker = this;
    }

    postMessage() {}

    terminate() {
      return Promise.reject(new Error("synthetic termination refusal"));
    }
  }

  try {
    await writeFile(stage, "still potentially owned", { mode: 0o600 });
    let settled = false;
    const pending = runLocalUnifiedIndexOffMainWorker({
      codexHome: root,
      indexFile,
      contractVersion: CONTRACT,
    }, {
      signal: controller.signal,
      attemptToken,
      WorkerClass: RejectingWorker,
      setTimeoutImpl(callback) {
        grace = callback;
        return { unref() {} };
      },
      clearTimeoutImpl() {},
    }).finally(() => {
      settled = true;
    });
    controller.abort();
    grace();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    worker.emit("exit", 1);
    await assert.rejects(
      pending,
      (error) => error?.code
        === "local_unified_index_worker_termination_failed",
    );
    await assert.doesNotReject(() => access(stage));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("off-main admission remains closed until a prior worker has exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-worker-busy-"));
  const controller = new AbortController();
  const indexFile = join(root, "index.sqlite");
  let worker = null;

  class HangingWorker extends EventEmitter {
    constructor() {
      super();
      worker = this;
    }

    postMessage() {}

    terminate() {
      this.emit("exit", 1);
      return Promise.resolve(1);
    }
  }

  class UnexpectedWorker extends EventEmitter {}

  try {
    const first = runLocalUnifiedIndexOffMainWorker({
      codexHome: root,
      indexFile,
      contractVersion: CONTRACT,
    }, {
      signal: controller.signal,
      WorkerClass: HangingWorker,
      abortGraceMs: 0,
    });
    await assert.rejects(
      runLocalUnifiedIndexOffMainWorker({
        codexHome: root,
        indexFile,
        contractVersion: CONTRACT,
      }, { WorkerClass: UnexpectedWorker }),
      (error) => error?.code === "local_unified_index_worker_busy",
    );
    controller.abort();
    await assert.rejects(
      first,
      (error) => error?.code === "local_unified_index_aborted",
    );
    assert.equal(worker !== null, true);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("progress callback failures retain only their fixed error code", async () => {
  const root = await createRolloutRoot("unified-index-off-main-progress-");
  try {
    await assert.rejects(
      ingestLocalUnifiedIndexOffMain({
        codexHome: root,
        indexFile: join(root, "index.sqlite"),
        secretFile: join(root, "salt"),
        contractVersion: CONTRACT,
        onProgress: () => {
          const error = new Error("private progress failure");
          error.code = "local_unified_index_progress_failed";
          throw error;
        },
      }),
      (error) => error?.code === "local_unified_index_progress_failed"
        && !error.message.includes("private"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
