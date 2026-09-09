import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildLocalUnifiedIndex } from "../../src/local-unified-index-build.js";
import { openLocalUnifiedIndex, readUnifiedIndexGenerationDescriptor } from "../../src/local-unified-index.js";
import assert from "node:assert/strict";
import { createCachedLocalUnifiedProjectionReader, selectSharedWorkUsageSnapshot } from "./server.js";
import { createWorkUsageService } from "../../src/application/work-usage.js";
import { WORK_USAGE_SCHEMA } from "../../src/reporting/work-usage.js";

const generation = `generation-v2-${"a".repeat(64)}`;
const options = nowMs => ({ mode: "full", nowMs, indexFile: "/private/index.sqlite", codexHome: "/private/codex", includeWorkUsage: true });
function combined(nowMs, marker = 1) {
  return {
    companion: { status: "available", generation: { fingerprint: generation }, marker },
    workUsage: { status: "available", asOfMs: nowMs, periods: Object.fromEntries(
      [["24h", 86400000], ["7d", 7 * 86400000], ["30d", 30 * 86400000], ["all", null]].map(([id, duration]) => [id, {
        fromMs: duration === null ? 0 : Math.max(0, nowMs - duration), toMs: nowMs,
        scopes: [{ id: "account-a", status: "available" }, { id: "unknown", status: "unavailable" }],
        snapshots: Object.fromEntries(["account-a", "unknown"].map(scope => [scope, {
          status: "available", scope, scopes: [], cells: [], models: [], threadLookup: {}, metadata: {}, marker,
        }])),
      }]),
    ) },
  };
}
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("all periods and scopes reuse one priced projection with immutable original bounds", async () => {
  let reads = 0;
  let fingerprint = generation;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; return combined(o.nowMs, reads); },
    readGeneration: async () => fingerprint,
    validUntil: async o => o.nowMs + 1000,
  });
  const first = await reader(options(100));
  first.workUsage.periods.all.snapshots["account-a"].marker = 999;
  for (const period of ["24h", "7d", "30d", "all"]) {
    for (const scope of ["account-a", "unknown"]) {
      const value = selectSharedWorkUsageSnapshot(await reader(options(150)), { period, scope });
      assert.equal(value.marker, 1);
      assert.equal(value.toMs, 100);
      assert.equal(value.scope, scope);
    }
  }
  assert.equal(reads, 1);
  assert.throws(() => selectSharedWorkUsageSnapshot(first, { period: "all", scope: "other" }), { code: "work_usage_scope_unavailable" });
  assert.equal(selectSharedWorkUsageSnapshot(first, { period: "all" }).scope, "unknown");
  await reader(options(1100));
  assert.equal(reads, 2);
  fingerprint = `generation-v2-${"b".repeat(64)}`;
  await reader(options(1101));
  assert.equal(reads, 3);
});

test("concurrent dashboard and work reads coalesce, including later timestamps", async () => {
  const gate = latch(); let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; await gate.promise; return combined(o.nowMs); },
    readGeneration: async () => generation, validUntil: async () => 1000,
  });
  const a = reader(options(100)); const b = reader(options(101)); const c = reader(options(100));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  gate.resolve();
  const results = await Promise.all([a, b, c]);
  assert.equal(reads, 1);
  assert.deepEqual(results.map(r => r.workUsage.asOfMs), [100, 100, 100]);
});

test("cancelling one subscriber preserves another; cancelling every subscriber prevents publication", async () => {
  let gate = latch(); let reads = 0; let buildSignal;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async (o, controls) => { reads++; buildSignal = controls.signal; await gate.promise; return combined(o.nowMs, reads); },
    readGeneration: async () => generation, validUntil: async o => o.nowMs + 100,
  });
  const controller = new AbortController();
  const a = reader(options(100), { signal: controller.signal });
  const b = reader(options(100));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(a, { code: "local_unified_companion_projection_aborted" });
  assert.equal(buildSignal.aborted, false);
  gate.resolve(); await b;
  gate = latch();
  const last = new AbortController();
  const c = reader(options(200), { signal: last.signal });
  await new Promise(resolve => setImmediate(resolve));
  last.abort();
  await assert.rejects(c, { code: "local_unified_companion_projection_aborted" });
  assert.equal(buildSignal.aborted, true);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await reader(options(201));
  assert.equal(reads, 3);
});

test("service reports cached accounting bounds and passes the selected period", async () => {
  let input;
  const service = createWorkUsageService({ clock: () => 1000,
    build: async query => { input = query; return selectSharedWorkUsageSnapshot(combined(900), query); },
    enrich: async () => ({}),
  });
  try {
    const query = { schemaVersion: WORK_USAGE_SCHEMA, period: "all" };
    const pending = await service.query(query);
    await new Promise(resolve => setImmediate(resolve));
    const result = await service.query({ ...query, snapshotId: pending.snapshotId });
    assert.equal(input.period, "all");
    assert.equal(result.status, "available");
    assert.equal(result.fromMs, 0);
    assert.equal(result.toMs, 900);
  } finally { service.close(); }
});

test("temporary work failure is retried and bounded failure codes survive selection", async () => {
  let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => {
      const value = combined(o.nowMs);
      if (++reads === 1) value.workUsage = { status: "unavailable", errorCode: "work_usage_capacity_exceeded" };
      return value;
    },
    readGeneration: async () => generation, validUntil: async () => Infinity,
  });
  const failed = await reader(options(100));
  assert.throws(() => selectSharedWorkUsageSnapshot(failed, { period: "all" }), { code: "work_usage_capacity_exceeded" });
  assert.equal((await reader(options(101))).workUsage.status, "available");
  assert.equal(reads, 2);
});

test("selectors isolate dashboard and work shapes without copying every cached period", async () => {
  let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; return combined(o.nowMs); },
    readGeneration: async () => generation, validUntil: async () => Infinity,
  });
  const dashboard = await reader(options(100), { selectProjection: p => p.companion });
  assert.equal(dashboard.status, "available");
  assert.equal(Object.hasOwn(dashboard, "workUsage"), false);
  dashboard.marker = 999;
  const work = await reader(options(101), { selectProjection: p => selectSharedWorkUsageSnapshot(p, { period: "all", scope: "account-a" }) });
  assert.equal(Object.hasOwn(work, "companion"), false);
  assert.equal(work.marker, 1);
  assert.equal(reads, 1);
});


test("real index cache validity expires exactly at work admission and lower-bound exit", async t => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  for (const observedAt of [now - 86400000, now, now + 100]) {
    const root = await mkdtemp(join(tmpdir(), "work-cache-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "sessions"));
    const id = "10000000-0000-4000-8000-000000000001";
    const rows = [
      { type: "session_meta", timestamp: new Date(observedAt - 1000).toISOString(), payload: { id, session_id: id, originator: "codex_cli_rs", thread_source: "user" } },
      { type: "turn_context", timestamp: new Date(observedAt - 1000).toISOString(), payload: { model: "gpt-5.6-sol" } },
      { type: "event_msg", timestamp: new Date(observedAt).toISOString(), payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      } } },
    ];
    await writeFile(join(root, "sessions", `rollout-2026-09-01T12-00-00-${id}.jsonl`), rows.map(JSON.stringify).join("\n") + "\n");
    const indexFile = join(root, "index.sqlite");
    await rebuildLocalUnifiedIndex({ codexHome: root, indexFile, contractVersion: "work-cache-boundary-v1", workerCount: 1 });
    const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    const descriptor = readUnifiedIndexGenerationDescriptor(database);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1);
    database.close();
    let reads = 0;
    const reader = createCachedLocalUnifiedProjectionReader({ reader: async o => {
      reads++;
      const result = combined(o.nowMs);
      result.companion.generation = descriptor;
      return result;
    } });
    const request = time => ({ ...options(time), indexFile, codexHome: root });
    const boundary = observedAt < now ? now + 1 : observedAt + 1;
    await reader(request(now));
    await reader(request(boundary - 1));
    assert.equal(reads, 1);
    await reader(request(boundary));
    assert.equal(reads, 2);
  }
});
