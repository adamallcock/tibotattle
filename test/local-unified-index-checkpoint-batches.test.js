import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";

const CONTRACT = "usage-event-v0.2";

async function setupIndex(t) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-checkpoint-batches-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const sessions = join(root, "sessions", "2026", "07", "25");
  await mkdir(sessions, { mode: 0o700, recursive: true });
  const options = {
    codexHome: root,
    indexFile: join(root, "index.sqlite"),
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  };

  async function writeSource(sequence, { parent = null, padding = 0 } = {}) {
    const id = "fixture-" + String(sequence).padStart(3, "0");
    const timestamp = "2026-07-25T00:00:00.000Z";
    const usage = {
      input_tokens: 100 + sequence,
      output_tokens: 4,
      total_tokens: 104 + sequence,
    };
    const records = [
      {
        timestamp,
        type: "session_meta",
        payload: {
          id,
          session_id: id,
          thread_source: parent === null ? "user" : "subagent",
          originator: "codex_cli_rs",
          ...(parent === null ? {} : { parent_thread_id: parent, forked_from_id: parent }),
        },
      },
      ...Array.from({ length: padding }, () => ({ timestamp, type: "ignored" })),
      {
        timestamp,
        type: "turn_context",
        payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "high" },
      },
      {
        timestamp: "2026-07-25T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: usage, last_token_usage: usage },
        },
      },
    ];
    await writeFile(
      join(sessions, `rollout-2026-07-25T00-00-00-${id}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return id;
  }

  await writeSource(0);
  await rebuildLocalUnifiedIndex({ ...options, workerCount: 1 });
  return { options, writeSource };
}

function readCheckpointCounts(indexFile) {
  const database = openLocalUnifiedIndex(`${indexFile}.incremental-checkpoint`, {
    readOnly: true,
  });
  try {
    return {
      events: database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n,
      completed: database.prepare(`
        SELECT COUNT(*) AS n FROM meta
        WHERE key GLOB 'incremental_checkpoint_component:*'
      `).get().n,
    };
  } finally {
    database.close();
  }
}

async function setupWriter(t, options) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-checkpoint-writer-"));
  const database = openLocalUnifiedIndex(join(root, "index.sqlite"), { create: true });
  t.after(async () => {
    if (database.isOpen) database.close();
    await rm(root, { force: true, recursive: true });
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: CONTRACT,
    manualCommit: true,
    ...options,
  });
  return { database, writer };
}

test("many independent inputs share bounded durable checkpoint commits", async (t) => {
  const { options, writeSource } = await setupIndex(t);
  const count = 140;
  for (let source = 1; source <= count; source += 1) await writeSource(source);

  const result = await ingestLocalUnifiedIndexIncrement(options);
  assert.equal(result.generation.status, "complete");
  assert.equal(result.sourcesScanned, count);
  assert.equal(result.insertedUsageEvents, count);
  assert.equal(result.totalUsageEvents, count + 1);
  // 140 groups exceed two 64-group batches. Even if a time or write limit
  // cuts a batch short, the pass should not commit separately for each file.
  assert.ok(result.batches >= 4, `unbounded batching: ${result.batches}`);
  assert.ok(result.batches <= 16, `excessive commits: ${result.batches}`);
});

test("cancellation preserves pending complete groups and rolls back the active fork", async (t) => {
  const { options, writeSource } = await setupIndex(t);
  const liveBefore = await readFile(options.indexFile);
  // Components scan by decreasing byte size. Both independent sources must
  // finish before the smaller fork group starts.
  await writeSource(1, { padding: 25 });
  await writeSource(2, { padding: 20 });
  const parent = await writeSource(3);
  await writeSource(4, { parent });
  // Keep the second completed group pending even on a slow test host.
  t.mock.method(performance, "now", () => 0);

  const abort = new AbortController();
  await assert.rejects(ingestLocalUnifiedIndexIncrement({
    ...options,
    signal: abort.signal,
    onProgress({ sourcesScanned }) {
      if (sourcesScanned === 3) abort.abort();
    },
  }), { code: "local_unified_index_aborted" });
  assert.deepEqual(await readFile(options.indexFile), liveBefore);
  assert.deepEqual(readCheckpointCounts(options.indexFile), { events: 3, completed: 2 });

  const retried = await ingestLocalUnifiedIndexIncrement(options);
  assert.equal(retried.generation.status, "complete");
  assert.equal(retried.sourcesScanned, 2);
  assert.equal(retried.insertedUsageEvents, 2);
  assert.equal(retried.totalUsageEvents, 5);
});

test("group rollback restores the writer's model and quota intern caches", async (t) => {
  const { database, writer } = await setupWriter(t);
  const observation = {
    observedAtMs: Date.parse("2026-07-25T00:00:01Z"),
    limitId: "codex",
    slot: "primary",
    usedPercent: 25,
  };
  const newerReading = { ...observation, usedPercent: 50 };
  const readQuota = database.prepare("SELECT used_percent FROM quota_observation");
  const readModel = database.prepare("SELECT id FROM model WHERE model_id = ?");

  writer.beginCheckpointGroup();
  writer.internQuota(observation);
  writer.completeCheckpointGroup({ changed: true });
  assert.equal(writer.batches, 1);
  writer.beginCheckpointGroup();
  writer.internQuota(newerReading);
  writer.internModel("gpt-5.6-sol", "known");
  writer.preserveCheckpointGroups();

  assert.equal(readQuota.get().used_percent, 25);
  assert.equal(readModel.get("gpt-5.6-sol"), undefined);
  writer.beginCheckpointGroup();
  const modelId = writer.internModel("gpt-5.6-sol", "known");
  writer.internQuota(newerReading);
  writer.completeCheckpointGroup({ changed: true });
  writer.flush();
  assert.equal(readQuota.get().used_percent, 50);
  assert.equal(readModel.get("gpt-5.6-sol").id, modelId);
});

test("skipped groups share the write and elapsed limits without splitting active groups", async (t) => {
  const { writer } = await setupWriter(t, { commitRows: 3 });
  let elapsedMs = 0;
  t.mock.method(performance, "now", () => elapsedMs);

  writer.beginCheckpointGroup();
  writer.writeMeta("fixture-first", "complete");
  writer.completeCheckpointGroup({ changed: true });
  assert.equal(writer.batches, 1);

  writer.beginCheckpointGroup();
  writer.writeMeta("fixture-skipped-1", "skipped");
  writer.completeCheckpointGroup({ changed: false });

  writer.beginCheckpointGroup();
  writer.writeMeta("fixture-parent", "complete");
  writer.writeMeta("fixture-child", "complete");
  assert.equal(writer.batches, 1);
  writer.completeCheckpointGroup({ changed: true });
  assert.equal(writer.batches, 2);

  writer.beginCheckpointGroup();
  writer.writeMeta("fixture-skipped-2", "skipped");
  writer.completeCheckpointGroup({ changed: false });
  assert.equal(writer.batches, 2);

  elapsedMs = 251;
  writer.beginCheckpointGroup();
  assert.equal(writer.batches, 3);
  writer.preserveCheckpointGroups();
});
