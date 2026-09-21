import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { extractRolloutUsage } from "../src/local-unified-index-extract.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, openLocalUnifiedIndex, outcomeName, reasoningEffortName } from "../src/local-unified-index.js";
import { createTelemetryV1IndexReader } from "../src/contribution/telemetry-v1-chunks.js";
import { createTelemetryV11Day } from "../src/contribution/index.js";
import { usageProjection } from "../src/local-companion-usage-model.js";
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

function uploadedUsage(file) {
  const database = openLocalUnifiedIndex(file, { readOnly: true });
  try {
    return createTelemetryV1IndexReader(database, { outcomeName, reasoningEffortName,
      fallbackParserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION })
      .deriveDay("2026-09-03").chunks.filter((chunk) => chunk.stream === "usage")
      .flatMap((chunk) => chunk.records);
  } finally { database.close(); }
}

test("exact selected totals survive serial, worker, incremental and v1/v1.1 projection without duplicate output", async () => {
  const first = { ...vector(100, 60), cache_write_input_tokens: 20, reasoning_output_tokens: 4 };
  const second = { ...vector(250, 160), cache_write_input_tokens: 40,
    output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 280 };
  const value = await fixture([count(1, first, first)]);
  const options = { codexHome: value.root, secretFile: join(value.root, "salt"), contractVersion: "usage-event-v0.2" };
  const incremental = join(value.root, "incremental.sqlite");
  try {
    await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    // No last sample: the second selected usage must be the cumulative delta,
    // never the whole cumulative context or a reconstructed split sum.
    await appendFile(value.path, `${count(2, second, null)}\n`);
    await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    const expected = uploadedUsage(incremental);
    assert.equal(expected.length, 2);
    assert.deepEqual(expected.map((event) => event.totalInputContextTokens), [100, 150]);
    assert.deepEqual(expected.map((event) => event.components.outputCombinedTokens), [10, 20]);
    assert.deepEqual(expected.map((event) => event.components.inputCacheWriteTokens), [20, 20]);
    assert.ok(expected.every((event) => event.outcome === "unknown"));
    const successor = createTelemetryV11Day({ day: "2026-09-03",
      recordsByStream: { usage: expected }, parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION });
    assert.deepEqual(successor.chunks.flatMap((chunk) => chunk.records)
      .map(({ schemaVersion, accountPlanAttribution, ...event }) => event),
    expected.map(({ schemaVersion, ...event }) => event));

    const event = expected[0];
    const projected = { observedAt: event.eventTime, model: event.modelId,
      totalInputContextTokens: event.totalInputContextTokens,
      components: { input_uncached_tokens: 20, input_cache_read_tokens: 60, input_cache_write_tokens: 20,
        output_text_tokens: 6, output_reasoning_tokens: 4, output_combined_tokens: 10 } };
    assert.deepEqual(usageProjection(projected), usageProjection({ ...projected,
      components: { ...projected.components, output_combined_tokens: 0 } }),
    "complete splits and their combined alias produce the same token and price totals");

    for (const workerCount of [1, 2]) {
      const indexFile = join(value.root, `full-${workerCount}.sqlite`);
      await rebuildLocalUnifiedIndex({ ...options, indexFile, workerCount });
      assert.deepEqual(uploadedUsage(indexFile), expected);
    }
    await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    assert.deepEqual(uploadedUsage(incremental), expected, "replay cannot add the combined alias twice");

    const database = openLocalUnifiedIndex(incremental, { readOnly: false });
    try {
      database.exec("UPDATE usage_event SET total_input_context=NULL, tokens_out_combined=NULL");
      database.exec("UPDATE parser_version SET parser_version='unified-rollout-typed-v15'");
    } finally { database.close(); }
    const refreshed = await ingestLocalUnifiedIndexIncrement({ ...options, indexFile: incremental });
    assert.equal(refreshed.sourcesReparsedForParserVersion, 1);
    assert.deepEqual(uploadedUsage(incremental), expected, "present v15 sources regain exact totals with stable event IDs");
  } finally { await rm(value.root, { recursive: true }); }
});

test("raw totals stay independent of missing splits and contradictory evidence is withheld", async () => {
  const samples = [
    { input_tokens: 100, output_tokens: 10 },
    // Output-only usage is still a selected token-count record, but it does
    // not create a positive-input boundary relation.
    { input_tokens: 0, output_tokens: 10, total_tokens: 10 },
    { total_tokens: 110 },
    { input_tokens: 100, cached_input_tokens: 120, output_tokens: 10, reasoning_output_tokens: 12 },
    { input_tokens: 100, cache_write_input_tokens: 101, output_tokens: 10 },
    { input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 20, output_tokens: 10 },
    { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
  ];
  const value = await fixture(samples.map((sample, index) => count(index + 1, null, sample)));
  try {
    const indexFile = join(value.root, "index.sqlite");
    await rebuildLocalUnifiedIndex({ codexHome: value.root, indexFile, secretFile: join(value.root, "salt"),
      contractVersion: "usage-event-v0.2", workerCount: 2 });
    const events = uploadedUsage(indexFile);
    // The total-only snapshot is not a usage row because it has no selected
    // input/output fields. The output-only row remains a fact, while the
    // continuity lens accepts positive-input requests only. The retained rows
    // prove that exact totals survive missing or contradictory components.
    assert.deepEqual(events.map((event) => [event.totalInputContextTokens, event.components.outputCombinedTokens]),
      [[100, 10], [0, 10], [null, null], [null, 10], [null, 10], [100, 0]]);
    assert.ok(events.every((event) => event.components.inputUncachedTokens === null));
    assert.ok(events.every((event) => event.components.outputTextTokens === null));
    assert.equal(events[0].components.inputCacheWriteTokens, null);
  } finally { await rm(value.root, { recursive: true }); }
});

test("rotated v15 sources preserve their recorded null totals and provenance", async () => {
  const value = await fixture([count(1, vector(100), vector(100))]);
  const indexFile = join(value.root, "index.sqlite");
  const options = { codexHome: value.root, indexFile, secretFile: join(value.root, "salt"), contractVersion: "usage-event-v0.2" };
  try {
    await ingestLocalUnifiedIndexIncrement(options);
    const database = openLocalUnifiedIndex(indexFile, { readOnly: false });
    try {
      database.exec("UPDATE usage_event SET total_input_context=NULL, tokens_out_combined=NULL");
      database.exec("UPDATE parser_version SET parser_version='unified-rollout-typed-v15'");
    } finally { database.close(); }
    await rm(value.path);
    const refreshed = await ingestLocalUnifiedIndexIncrement(options);
    assert.equal(refreshed.sourcesReparsedForParserVersion, 0);
    const events = uploadedUsage(indexFile);
    assert.equal(events.length, 1);
    assert.equal(events[0].totalInputContextTokens, null);
    assert.equal(events[0].components.outputCombinedTokens, null);
    const retained = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try {
      assert.equal(retained.prepare(`SELECT p.parser_version FROM usage_event u
        JOIN ingest_run r ON r.id=u.ingest_run_id JOIN parser_version p ON p.id=r.parser_version_id`)
        .get().parser_version, "unified-rollout-typed-v15");
    } finally { retained.close(); }
  } finally { await rm(value.root, { recursive: true }); }
});

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
    assert.equal(LOCAL_UNIFIED_INDEX_PARSER_VERSION, "unified-rollout-typed-v17");
  } finally { await rm(value.root, { recursive: true }); }
});

test("unknown and inconsistent cache evidence stays null apart from the approved cache-write assumption", async () => {
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
    assert.deepEqual(events.map((event) => event.components.inputUncachedTokens), [null, 100, null]);
    assert.equal(events[0].components.inputCacheReadTokens, null);
    assert.equal(events[1].components.inputCacheWriteTokens, 0);
    assert.deepEqual(events.map((event) => event.cacheWriteAssumedZero === true), [false, true, false]);
    assert.equal(events[2].components.inputCacheReadTokens, null);
    // The raw provider adapter retains missingness; the typed index records
    // the product assumption explicitly after selecting the charged usage.
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
