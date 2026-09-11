import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractRolloutUsage } from "../src/local-unified-index-extract.js";
import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  createUnifiedIndexWriter,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const CONTRACT = "usage-event-v0.2";
const RAW = { input_tokens: 100, cached_input_tokens: 30, output_tokens: 12,
  reasoning_output_tokens: 2, total_tokens: 112 };
function records(raw, { quota = false } = {}) {
  return [
    { timestamp: "2026-07-25T00:00:00.000Z", type: "session_meta", payload: { id: THREAD } },
    { timestamp: "2026-07-25T00:00:00.500Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { timestamp: "2026-07-25T00:00:01.000Z", type: "event_msg", payload: {
      type: "token_count", info: { total_token_usage: raw, last_token_usage: raw },
      ...(quota ? { rate_limits: { limit_id: "codex", plan_type: "pro", primary: {
        used_percent: 5, window_minutes: 300, resets_at: 1_800_000_000,
      } } } : {}),
    } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}
async function fixture(t, raw, options) {
  const root = await mkdtemp(join(tmpdir(), "unified-cache-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions", "2026", "07", "25");
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, `rollout-2026-07-25T00-00-00-${THREAD}.jsonl`);
  await writeFile(path, records(raw, options));
  return { root, path, indexFile: join(root, "index.sqlite"),
    codexHome: root, secretFile: join(root, "salt"), contractVersion: CONTRACT };
}

test("cache-write zero assumption applies only to missing writes with usable input counters", async (t) => {
  const cases = [
    { name: "absent", raw: RAW, assumed: true, uncached: 70, write: 0 },
    { name: "null", raw: { ...RAW, cache_write_input_tokens: null }, assumed: true, uncached: 70, write: 0 },
    { name: "observed zero", raw: { ...RAW, cache_write_input_tokens: 0 }, uncached: 70, write: 0 },
    { name: "observed positive", raw: { ...RAW, cache_write_input_tokens: 5 }, uncached: 65, write: 5 },
    { name: "contradictory input", raw: { ...RAW, cached_input_tokens: 101 }, uncached: null, write: null },
    { name: "unknown cache read", raw: { ...RAW, cached_input_tokens: null }, uncached: null, write: null },
    { name: "unknown input", raw: { ...RAW, input_tokens: null }, uncached: null, write: null },
    { name: "malformed input", raw: { ...RAW, input_tokens: "100" }, quota: true, uncached: null, write: null },
    { name: "fractional cache read", raw: { ...RAW, cached_input_tokens: 0.5 }, quota: true, uncached: null, write: null },
    { name: "malformed write", raw: { ...RAW, cache_write_input_tokens: -1 }, quota: true, uncached: null, write: null },
    { name: "all unknown", raw: Object.fromEntries(Object.keys(RAW).map((key) => [key, null])), quota: true, uncached: null, write: null },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const { path } = await fixture(t, item.raw, item);
    const events = [];
    const result = await extractRolloutUsage(path, { size: (await stat(path)).size, onEvent: (event) => events.push(event) });
    assert.equal(events.length, 1);
    assert.equal(events[0].cacheWriteAssumedZero === true, item.assumed === true);
    assert.equal(events[0].components?.inputUncachedTokens ?? null, item.uncached);
    assert.equal(events[0].components?.inputCacheWriteTokens ?? null, item.write);
    if (item.assumed) {
      assert.equal(result.finalTotals.cache_write_input_tokens, null, "replay counters retain raw missingness");
      assert.equal(events[0].components.outputTextTokens, 10);
      assert.equal(events[0].components.outputReasoningTokens, 2);
    }
  });
});

test("assumption is stored with other row provenance and v15 cursors reparse exactly once", async (t) => {
  const options = await fixture(t, RAW);
  const ingest = () => ingestLocalUnifiedIndexIncrement(options);
  const first = await ingest();
  assert.equal(first.insertedUsageEvents, 1);
  let db = openLocalUnifiedIndex(options.indexFile, { readOnly: false });
  try {
    const original = db.prepare("SELECT * FROM usage_event").get();
    assert.equal(original.tokens_in_uncached, 70);
    assert.equal(original.tokens_in_cache_write, 0);
    const version = db.prepare("SELECT parser_version FROM parser_version WHERE id = ?").get(original.parser_version_id).parser_version;
    assert.equal(version, `${LOCAL_UNIFIED_INDEX_PARSER_VERSION}-cache-write-zero`);
    const writer = createUnifiedIndexWriter(db, { contractVersion: CONTRACT, generationId: original.generation_id });
    for (const [i, flags] of [{ partial: true }, { modelInherited: true }, { partial: true, modelInherited: true }].entries()) {
      writer.writeUsageEvent({ eventKey: Buffer.alloc(32, i + 1), observedAtMs: original.observed_at_ms,
        sessionLocal: original.session_local, accountScopeId: original.account_scope_id, modelId: original.model_id,
        tierId: original.tier_id, surfaceId: original.surface_id, reasoningEffort: original.reasoning_effort,
        outcome: original.outcome, tokensInUncached: 70, tokensInCacheRead: 30, tokensInCacheWrite: 0,
        cacheWriteAssumedZero: true, ...flags });
    }
    writer.flush();
    assert.deepEqual(db.prepare(`SELECT DISTINCT p.parser_version FROM usage_event u
      JOIN parser_version p ON p.id = u.parser_version_id ORDER BY p.parser_version`).all().map((row) => row.parser_version), [
      `${LOCAL_UNIFIED_INDEX_PARSER_VERSION}-cache-write-zero`,
      `${LOCAL_UNIFIED_INDEX_PARSER_VERSION}-parent-model-cache-write-zero`,
      `${LOCAL_UNIFIED_INDEX_PARSER_VERSION}-parent-model-partial-cache-write-zero`,
      `${LOCAL_UNIFIED_INDEX_PARSER_VERSION}-partial-cache-write-zero`,
    ]);
    // Remove writer-only provenance probes before rehearsing a real source reparse.
    db.prepare("DELETE FROM usage_event WHERE source_local IS NULL").run();
    db.prepare("UPDATE usage_event SET tokens_in_uncached = NULL, tokens_in_cache_write = NULL").run();
    db.prepare("UPDATE parser_version SET parser_version = replace(parser_version, 'v16', 'v15')").run();
  } finally { db.close(); }
  const reparsed = await ingest();
  assert.equal(reparsed.sourcesReparsedForParserVersion, 1);
  assert.equal(reparsed.usageRowsDeletedForReparse, 1);
  assert.equal(reparsed.totalUsageEvents, 1);
  db = openLocalUnifiedIndex(options.indexFile, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT tokens_in_uncached FROM usage_event").get().tokens_in_uncached, 70);
    assert.equal(db.prepare("SELECT tokens_in_cache_write FROM usage_event").get().tokens_in_cache_write, 0);
    const cursor = db.prepare(`SELECT p.parser_version FROM source_cursor c
      JOIN ingest_run r ON r.id = c.ingest_run_id JOIN parser_version p ON p.id = r.parser_version_id`).get();
    assert.equal(cursor.parser_version, LOCAL_UNIFIED_INDEX_PARSER_VERSION);
  } finally { db.close(); }
  const repeated = await ingest();
  assert.equal(repeated.sourcesReparsedForParserVersion, 0);
  assert.equal(repeated.insertedUsageEvents, 0);
  assert.equal(repeated.totalUsageEvents, 1);
});
