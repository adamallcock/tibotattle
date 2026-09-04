import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { extractRolloutUsage } from "../src/local-unified-index-extract.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, openLocalUnifiedIndex } from "../src/local-unified-index.js";
import { cumulativeSnapshotKey, normalizeTokenUsage } from "../src/providers/codex/logs.js";

const stamp = (second) => `2026-09-03T12:00:${String(second).padStart(2, "0")}.000Z`;
const vector = (input, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
  total_tokens: input + 10 });
const line = (second, type, payload, extra = {}) => JSON.stringify({ timestamp: stamp(second), type, payload, ...extra });
const count = (second, total, last) => line(second, "event_msg", { type: "token_count",
  info: { total_token_usage: total, last_token_usage: last } });
const header = [line(0, "session_meta", { id: "synthetic-compatibility" }),
  line(0, "turn_context", { model: "gpt-6-astra", effort: "low" })];

async function fixture(lines) {
  const root = await mkdtemp(join(tmpdir(), "codex-usage-compatibility-"));
  await mkdir(join(root, "sessions"));
  const path = join(root, "sessions", "rollout-2026-09-03T12-00-00-compatibility.jsonl");
  await writeFile(path, `${[...header, ...lines].join("\n")}\n`);
  return { root, path };
}

function rows(file) {
  const database = openLocalUnifiedIndex(file, { readOnly: true });
  try {
    return database.prepare(`SELECT tokens_in_uncached, tokens_in_cache_read,
      tokens_in_cache_write, tokens_out_text, tokens_out_reasoning
      FROM usage_event ORDER BY observed_at_ms`).all().map((row) => ({ ...row }));
  } finally { database.close(); }
}

test("missing cache components remain null; explicit zero remains observed across full, worker and incremental indexing", async () => {
  const sparse = { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 };
  const first = count(1, sparse, sparse);
  const second = count(2, { ...vector(200), output_tokens: 20, total_tokens: 220 }, vector(100));
  const value = await fixture([first]);
  const options = { codexHome: value.root, secretFile: join(value.root, "salt"), contractVersion: "usage-event-v0.2" };
  const incremental = join(value.root, "incremental.sqlite");
  try {
    await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    const cursorDb = openLocalUnifiedIndex(incremental, { readOnly: true });
    try {
      assert.equal(cursorDb.prepare("SELECT carry_total_cached FROM source_cursor").get().carry_total_cached, null);
      assert.equal(cursorDb.prepare("SELECT carry_total_cache_write FROM source_cursor").get().carry_total_cache_write, null);
    } finally { cursorDb.close(); }
    await appendFile(value.path, `${second}\n`);
    await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    const expected = [
      { tokens_in_uncached: null, tokens_in_cache_read: null, tokens_in_cache_write: null, tokens_out_text: 10, tokens_out_reasoning: 0 },
      { tokens_in_uncached: 100, tokens_in_cache_read: 0, tokens_in_cache_write: 0, tokens_out_text: 10, tokens_out_reasoning: 0 },
    ];
    assert.deepEqual(rows(incremental), expected);
    for (const workerCount of [1, 2]) {
      const indexFile = join(value.root, `full-${workerCount}.sqlite`);
      const rebuilt = await rebuildLocalUnifiedIndex({ ...options, indexFile, workerCount });
      assert.equal(rebuilt.workerCount, workerCount);
      assert.deepEqual(rows(indexFile), expected);
    }
    await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    assert.deepEqual(rows(incremental), expected, "replay is unchanged");

    // Reproduce the old zero-filled derived cache, then verify parser reparse
    // replaces only this derived evidence without deleting the database.
    const poison = openLocalUnifiedIndex(incremental, { readOnly: false });
    try {
      poison.exec("UPDATE usage_event SET tokens_in_uncached=100, tokens_in_cache_read=0, tokens_in_cache_write=0");
      poison.exec("UPDATE parser_version SET parser_version='unified-rollout-typed-v11'");
    } finally { poison.close(); }
    const refreshed = await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    assert.equal(refreshed.sourcesReparsedForParserVersion, 1);
    assert.deepEqual(rows(incremental), expected);
    assert.equal(LOCAL_UNIFIED_INDEX_PARSER_VERSION, "unified-rollout-typed-v12");
  } finally { await rm(value.root, { recursive: true }); }
});

test("null and inconsistent provider components cannot manufacture measured cache evidence", async () => {
  const bad = [
    { ...vector(100), cached_input_tokens: null },
    { ...vector(100), cache_write_input_tokens: null },
    { ...vector(100, 90), cache_write_input_tokens: 20 },
  ];
  const value = await fixture([...bad.map((usage, index) => count(index + 1, null, usage)),
    count(4, null, {}), count(5, null, { input_tokens: null, output_tokens: null })]);
  try {
    const events = [];
    await extractRolloutUsage(value.path, { size: (await stat(value.path)).size, onEvent: (event) => events.push(event) });
    assert.equal(events.length, 3);
    assert.equal(events.every((event) => event.components.inputUncachedTokens === null), true);
    assert.equal(events[0].components.inputCacheReadTokens, null);
    assert.equal(events[1].components.inputCacheWriteTokens, null);
    assert.equal(events[2].components.inputCacheReadTokens, null);
    const provider = [];
    await localCodexLogScanner.scanCodexLogEvents({ codexHome: value.root, startAt: stamp(0), endAt: stamp(59), onUsage: (event) => provider.push(event) });
    assert.equal(provider.length, 3);
    assert.equal(provider.every((event) => event.componentAvailability.input_uncached_tokens === false), true);
  } finally { await rm(value.root, { recursive: true }); }
});

test("nullable evidence retains legacy lineage snapshot identity for rotated parents", async () => {
  const sparse = { input_tokens: 100, total_tokens: 100 };
  const value = await fixture([count(1, sparse, sparse)]);
  try {
    const snapshots = new Set();
    const collected = [];
    await extractRolloutUsage(value.path, { size: (await stat(value.path)).size,
      collectSnapshots: snapshots, onEvent: (event) => collected.push(event) });
    const legacy = cumulativeSnapshotKey(normalizeTokenUsage(sparse), normalizeTokenUsage(sparse));
    assert.deepEqual([...snapshots], [legacy]);
    assert.equal(collected[0].components.inputCacheReadTokens, null);
    const replay = [];
    const outcome = await extractRolloutUsage(value.path, { size: (await stat(value.path)).size,
      isFork: true, inheritedSnapshots: new Set([legacy]), onEvent: (event) => replay.push(event) });
    assert.deepEqual(replay, []);
    assert.equal(outcome.diagnostics.forkReplayEventsSkipped, 1);
  } finally { await rm(value.root, { recursive: true }); }
});

test("response totals/checkpoint copies are not additive usage and authored configuration is not applied effort evidence", async () => {
  // #41912 continues emitting legacy token_count. Response, turn and thread
  // totals overlap; a checkpoint copy is not a new response. Until a reviewed
  // response reconciliation contract exists, legacy rows remain authoritative.
  const response = { thread_id: "private-thread-canary", turn_id: "private-turn-canary",
    session_id: "private-root-canary", root_turn_id: "private-root-turn-canary", response_id: "private-response-canary",
    usage: vector(999), turn_token_usage: vector(1999), thread_token_usage: vector(2999) };
  const value = await fixture([
    line(1, "token_usage_record", response),
    line(2, "response_item", { type: "configuration_update", reasoning: { effort: "high" } },
      { metadata: { client_authored: false, harness_authored_configuration: true } }),
    line(3, "response_item", { type: "configuration_update", reasoning: { effort: "private-custom-canary" } }),
    count(4, vector(100, 80), vector(100, 80)),
    line(5, "compacted", { latest_token_usage_record: response }),
    line(6, "token_usage_record", response),
    count(7, { ...vector(200, 160), output_tokens: 20, total_tokens: 220 }, vector(100, 80)),
  ]);
  try {
    const extracted = [];
    await extractRolloutUsage(value.path, { size: (await stat(value.path)).size, onEvent: (event) => extracted.push(event) });
    assert.equal(extracted.length, 2);
    assert.deepEqual(extracted.map((event) => event.reasoningEffort), ["low", "low"]);
    assert.deepEqual(extracted.map((event) => event.components.inputCacheReadTokens), [80, 80]);
    assert.equal(JSON.stringify(extracted).includes("private-"), false);
    const provider = [];
    await localCodexLogScanner.scanCodexLogEvents({ codexHome: value.root, startAt: stamp(0), endAt: stamp(59), onUsage: (event) => provider.push(event) });
    assert.equal(provider.length, 2);
    assert.equal(provider.reduce((sum, event) => sum + event.raw.input_tokens, 0), 200);
    const onlyResponse = await fixture([line(1, "token_usage_record", response), line(2, "compacted", { latest_token_usage_record: response })]);
    try {
      const absent = [];
      await extractRolloutUsage(onlyResponse.path, { size: (await stat(onlyResponse.path)).size, onEvent: (event) => absent.push(event) });
      assert.deepEqual(absent, [], "unsupported response-only evidence is unavailable, not a fabricated zero event");
    } finally { await rm(onlyResponse.root, { recursive: true }); }
  } finally { await rm(value.root, { recursive: true }); }
});
