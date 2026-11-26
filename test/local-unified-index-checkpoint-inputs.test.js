import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createLocalUnifiedAccountingSource } from "../src/local-unified-accounting-source.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { readLocalUnifiedWindowBreakdown } from "../src/local-unified-window-breakdown.js";

const DAY = "2026-11-22";
const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const HISTORY_BASE = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function timestamp(hour, second = "01") {
  return `${DAY}T${hour}:00:${second}.000Z`;
}

function rollout(hour, name) {
  return `rollout-${DAY}T${hour}-00-00-${name}.jsonl`;
}

function jsonl(records) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function session(id, payload = {}) {
  return {
    timestamp: timestamp("00", "00"),
    type: "session_meta",
    payload: { id, session_id: id, originator: "codex_cli_rs", thread_source: "user", ...payload },
  };
}

function turn(hour, model, padding = 0) {
  return {
    timestamp: timestamp(hour, "00"),
    type: "turn_context",
    payload: { model, effort: "high", ...(padding > 0 ? { padding: "x".repeat(padding) } : {}) },
  };
}

function speed(hour, serviceTier) {
  return {
    timestamp: timestamp(hour, "00"),
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: { service_tier: serviceTier },
    },
  };
}

function tokenCount(hour, input, { total = input, usedPercent = null } = {}) {
  const usage = (tokens) => ({
    input_tokens: tokens, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, total_tokens: tokens,
  });
  const quota = usedPercent === null ? {} : {
    rate_limits: {
      limit_id: "codex",
      plan_type: "pro",
      primary: {
        used_percent: usedPercent,
        window_minutes: 10_080,
        resets_at: Date.parse(timestamp("22")) / 1_000,
      },
    },
  };
  return {
    timestamp: timestamp(hour),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(total), last_token_usage: usage(input) },
      ...quota,
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-checkpoint-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions", ...DAY.split("-"));
  await mkdir(sessions, { recursive: true });
  const write = (file, records) => writeFile(join(sessions, file), jsonl(records));
  const indexFile = join(root, "index.sqlite");
  const uninterruptedFile = join(root, "uninterrupted.sqlite");
  const options = {
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: "usage-event-v0.2",
  };
  await write(rollout("00", "baseline"), [
    session("baseline"), turn("00", "gpt-5.6-sol"), tokenCount("00", 1),
  ]);
  await rebuildLocalUnifiedIndex(options);
  await copyFile(indexFile, uninterruptedFile);
  const ingest = (overrides) => ingestLocalUnifiedIndexIncrement({ ...options, ...overrides });
  return { root, sessions, write, indexFile, uninterruptedFile, ingest };
}

async function abortAfterCheckpoint(ingest, scanned, { multiSource = false } = {}) {
  const controller = new AbortController();
  let reportsAtTarget = 0;
  await assert.rejects(ingest({
    signal: controller.signal,
    onProgress: ({ sourcesScanned }) => {
      // A multi-source component reports after its final member and again
      // after committing. Only the second callback proves durable reuse.
      if (sourcesScanned === scanned && ++reportsAtTarget === (multiSource ? 2 : 1)) {
        controller.abort();
      }
    },
  }), { code: "local_unified_index_aborted" });
}

async function quotaOrder(indexFile) {
  const snapshots = [];
  await createLocalUnifiedAccountingSource({ indexFile, requireComplete: true })({
    startAt: timestamp("00"),
    endAt: timestamp("05"),
    onRateLimitSnapshot: ({ window, sourceOrdinal }) => {
      snapshots.push([window.usedPercent, sourceOrdinal]);
    },
  });
  return snapshots;
}

function windowBreakdown(indexFile, hour) {
  return readLocalUnifiedWindowBreakdown({
    indexFile,
    fromMs: Date.parse(timestamp(hour, "00")),
    toMs: Date.parse(timestamp(hour, "05")),
  });
}

test("checkpoint input digests stream large quarantine sets and lineage groups", async (t) => {
  const { write, ingest } = await fixture(t);
  const damagedCount = 24;
  const childCount = 24;
  await write(rollout("01", "parent"), [
    session("parent"), turn("01", "gpt-5.6-sol"), tokenCount("01", 10),
  ]);
  for (let index = 0; index < damagedCount; index += 1) {
    const filenameThread = "44444444-4444-4444-8444-" + String(index).padStart(12, "0");
    await write(rollout("02", filenameThread), [session("different-thread")]);
  }
  for (let index = 0; index < childCount; index += 1) {
    const id = "child-" + String(index).padStart(2, "0");
    await write(rollout("03", id), [
      session(id, { parent_thread_id: "parent", forked_from_id: "parent", thread_source: "subagent" }),
      turn("03", "gpt-5.6-sol"),
      tokenCount("03", 100 + index),
    ]);
  }
  await write(rollout("04", "unrelated"), [
    session("unrelated"), turn("04", "gpt-5.6-sol"), tokenCount("04", 400),
  ]);
  // The lineage group completes ahead of the independent singleton.
  await abortAfterCheckpoint(ingest, childCount + 1, { multiSource: true });
  const result = await ingest();
  assert.equal(result.sourcesScanned, 1);
  assert.equal(result.generation.status, "partial");
  assert.equal(result.generation.skippedSourceCount, damagedCount);
  assert.equal(result.generation.indexedSourceCount, childCount + 3);
  assert.equal(result.totalUsageEvents, childCount + 3);
});

test("switching selected leaves at different depths invalidates inherited price evidence", async (t) => {
  const { root, sessions, write, indexFile, uninterruptedFile, ingest } = await fixture(t);
  const original = rollout("01", PARENT);
  const replacement = rollout("03", PARENT + "_" + REPLACEMENT);
  const prefix = [
    session(HISTORY_BASE), turn("02", "gpt-6-astra"), tokenCount("02", 300),
  ];
  await write(original, [
    session(PARENT), turn("01", "gpt-5.6-sol"), speed("01", "default"), tokenCount("01", 100),
  ]);
  await write(rollout("02", HISTORY_BASE), prefix);
  await write(replacement, [
    {
      ...session(PARENT, {
        history_mode: "paginated",
        history_base: {
          thread_id: HISTORY_BASE,
          end_ordinal_exclusive: prefix.length,
          end_byte_offset: Buffer.byteLength(jsonl(prefix)),
        },
      }),
      ordinal: prefix.length,
    },
    turn("03", "gpt-6-astra"),
    speed("03", "priority"),
    tokenCount("03", 200, { total: 500 }),
  ]);
  await write(rollout("04", CHILD), [
    session(CHILD, { forked_from_id: PARENT, parent_thread_id: PARENT, thread_source: "subagent" }),
    turn("04"),
    tokenCount("04", 400_000),
  ]);

  const stateFile = join(root, "state_5.sqlite");
  let state = new DatabaseSync(stateFile);
  try {
    state.exec("CREATE TABLE threads(id TEXT, rollout_path TEXT)");
    state.prepare("INSERT INTO threads VALUES (?, ?)").run(PARENT, join(sessions, original));
  } finally {
    state.close();
  }
  await chmod(stateFile, 0o600);
  await abortAfterCheckpoint(ingest, 4, { multiSource: true });

  // The replacement has a different physical-history depth. Selecting it
  // changes the inline child's seed without changing any rollout or sort order.
  state = new DatabaseSync(stateFile);
  try {
    state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
      .run(join(sessions, replacement), PARENT);
  } finally {
    state.close();
  }

  const resumed = await ingest();
  const uninterrupted = await ingest({ indexFile: uninterruptedFile });
  assert.equal(resumed.sourcesScanned, uninterrupted.sourcesScanned);
  assert.equal(resumed.generation.status, "complete");
  const unchanged = await ingest();
  assert.equal(unchanged.unchanged, true);
  const retriedCost = await windowBreakdown(indexFile, "04");
  const uninterruptedCost = await windowBreakdown(uninterruptedFile, "04");
  assert.equal(retriedCost.status, "available");
  assert.equal(retriedCost.byModel[0].model, "gpt-6-astra");
  assert.equal(retriedCost.bySpeed.fast.events, 1);
  assert.equal(retriedCost.costUsd, 8);
  assert.deepEqual(retriedCost, uninterruptedCost);
});

for (const addedAfterCheckpoint of [false, true]) {
  const timing = addedAfterCheckpoint ? "discovered after cancellation" : "present before cancellation";
  test("checkpoint retains tied quota order with an earlier source " + timing, async (t) => {
    const { write, ingest, indexFile, uninterruptedFile } = await fixture(t);
    const writeEarlier = () => write(rollout("01", "earlier"), [
      session("earlier"), turn("05", "gpt-5.6-sol"), tokenCount("05", 100, { usedPercent: 5 }),
    ]);
    if (!addedAfterCheckpoint) await writeEarlier();
    // This source sorts later in discovery, but its larger byte count gives it
    // the first scan and the first durable checkpoint.
    await write(rollout("02", "larger"), [
      session("larger"), turn("05", "gpt-5.6-sol", 300), tokenCount("05", 200, { usedPercent: 8 }),
    ]);
    await abortAfterCheckpoint(ingest, 1);
    if (addedAfterCheckpoint) await writeEarlier();

    const resumed = await ingest();
    await ingest({ indexFile: uninterruptedFile });
    assert.equal(resumed.generation.sourceOrderComplete, true);
    assert.equal(resumed.sourcesScanned, addedAfterCheckpoint ? 2 : 1);
    assert.deepEqual(await quotaOrder(indexFile), [[5, 1], [8, 2]]);
    assert.deepEqual(await quotaOrder(indexFile), await quotaOrder(uninterruptedFile));
  });
}

for (const newSourceLarger of [true, false]) {
  const timing = newSourceLarger ? "before" : "after";
  test("checkpoint rejects a same-size mutation " + timing + " skipping a reused source", async (t) => {
    const { indexFile, sessions, write, ingest } = await fixture(t);
    const old = rollout("01", "completed");
    function oldRecords(input) {
      return [
        session("completed"),
        turn("01", "gpt-5.6-sol", newSourceLarger ? 0 : 700),
        tokenCount("01", input),
      ];
    }
    await write(old, oldRecords(100));
    await abortAfterCheckpoint(ingest, 1);
    await write(rollout("02", "new"), [
      session("new"), turn("02", "gpt-5.6-sol", newSourceLarger ? 700 : 0), tokenCount("02", 200),
    ]);
    const before = await readFile(indexFile);
    assert.equal(Buffer.byteLength(jsonl(oldRecords(100))), Buffer.byteLength(jsonl(oldRecords(999))));
    let mutated = false;
    await assert.rejects(ingest({
      onProgress: async ({ sourcesScanned, sourcesSkipped }) => {
        if (sourcesScanned === 1) {
          if (!newSourceLarger) assert.ok(sourcesSkipped >= 1);
          else assert.equal(sourcesSkipped, 0);
          await write(old, oldRecords(999));
          const changedAt = new Date(timestamp("01"));
          await utimes(join(sessions, old), changedAt, changedAt);
          mutated = true;
        }
      },
    }), { code: "codex_rollout_source_changed" });
    assert.equal(mutated, true);
    assert.deepEqual(await readFile(indexFile), before);
    const recovered = await ingest();
    assert.equal(recovered.generation.status, "complete");
    assert.equal(recovered.totalUsageEvents, 3);
    assert.equal((await windowBreakdown(indexFile, "01")).tokens, 999);
  });
}
