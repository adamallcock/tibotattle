import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLocalCacheDropThreadLinks, cacheDropThreadLookupKey,
} from "../src/local-cache-drop-thread-links.js";
import {
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
  reasoningEffortOrdinal,
} from "../src/local-unified-index.js";
import { readCacheImpacts } from "../src/cache-switch-impact.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const ROOT = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const local = (number) => Buffer.alloc(32, number);
const switchRow = () => ({
  observedAt: new Date(NOW - 60_000).toISOString(), gapSeconds: 60,
  previous: { model: "gpt-5.6-sol", reasoningEffort: "low" },
  current: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  changeType: "reasoning_only", previousCacheReadTokens: 1_000,
  currentCacheReadTokens: 0, lostCacheTokens: 1_000,
  estimatedPremiumUsd: null, estimatedPremiumUsdExact: null,
});
const continuityRow = () => ({
  observedAt: new Date(NOW - 30_000).toISOString(), gapSeconds: 600,
  configuration: { model: "gpt-5.6-terra", reasoningEffort: "high" },
  gapBand: "five_to_thirty_minutes", previousCacheReadTokens: 2_000,
  currentCacheReadTokens: 100, lostCacheTokens: 1_900,
  estimatedPremiumUsd: null, estimatedPremiumUsdExact: null,
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cache-drop-thread-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexFile = join(root, "index.sqlite");
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  database.prepare("INSERT INTO parser_version VALUES (1, ?, 'usage-event-v0.2')")
    .run(LOCAL_UNIFIED_INDEX_PARSER_VERSION);
  database.exec(`
    INSERT INTO ingest_run VALUES (1, ${NOW}, 1);
    INSERT INTO index_generation(id,started_at_ms,completed_at_ms,parser_version_id,
      contract_version,status,discovery_complete,diagnostics_complete)
      VALUES (7,${NOW - 300_000},${NOW},1,'usage-event-v0.2','complete',1,1);
    INSERT INTO meta(key,value) VALUES ('current_generation_id','7.0')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT INTO model VALUES (1,'gpt-5.6-sol','recognized'),(2,'gpt-5.6-terra','recognized');
    INSERT INTO tier_semantics VALUES (1,'standard','chatgpt_subscription','standard','observed',NULL);
    INSERT INTO surface_class VALUES (1,'root','desktop','user','canonical');
    INSERT INTO account_scope VALUES (1,'unattributed',NULL,NULL,NULL);
  `);
  database.prepare("INSERT INTO source_dimension VALUES (1, ?), (2, ?)")
    .run(local(1), local(2));
  database.prepare("INSERT INTO session_identity VALUES (?, ?), (?, ?), (?, ?)")
    .run(local(1), ROOT, local(2), WORKER, local(3), THIRD);
  let key = 0;
  const insert = database.prepare(`INSERT INTO usage_event (
    event_key, observed_at_ms, generation_id, ingest_run_id, parser_version_id,
    source_id, session_local, account_scope_id, model_id, tier_id, surface_id,
    source_local, source_offset, source_ordinal, reasoning_effort, outcome,
    tokens_in_uncached, tokens_in_cache_read, tokens_in_cache_write)
    VALUES (?, ?, 7, 1, 1, ?, ?, 1, ?, 1, 1, ?, ?, 0, ?, 0, ?, ?, ?)`);
  function event({ session = 1, time, source = 1, offset, model = 1,
    effort = 4, cached = 0, uncached = 1_100, written = 0,
    turn = false, compacted = false }) {
    const eventKey = Buffer.alloc(32);
    eventKey.writeUInt32BE(++key);
    insert.run(eventKey, time, source, local(session), model,
      source === null ? null : local(source), offset, effort, uncached, cached, written);
    if (turn || compacted) database.prepare(`INSERT INTO usage_event_boundary
      VALUES (?, ?, ?, ?, 1, 1, ?)`)
      .run(eventKey, Number(compacted), Number(turn), compacted ? time - 1 : null, local(session));
    return eventKey;
  }
  event({ time: NOW - 120_000, offset: 100, effort: 2, cached: 1_000 });
  event({ time: NOW - 60_000, offset: 200 });
  event({ session: 2, source: 2, model: 2, time: NOW - 630_000, offset: 100,
    cached: 2_000 });
  event({ session: 2, source: 2, model: 2, time: NOW - 30_000, offset: 200,
    cached: 100, uncached: 2_200, turn: true });
  const overview = {
    accounting: {
      generation: "7.0", generationMatched: true,
      generationFingerprint: readUnifiedIndexGenerationDescriptor(database).fingerprint,
      cacheSwitchImpact: { status: "available", recent: [switchRow()], periods: [
        { periodId: "24h", recent: [switchRow()] },
        { periodId: "7d", recent: [switchRow()] },
      ] },
      cacheContinuityImpact: { status: "available", periods: [
        { periodId: "all", recent: [continuityRow()] },
      ] },
    },
  };
  const readThreadMetadata = async (_home, ids) => new Map(ids.map((id) => [id, {
    id, name: id === ROOT ? "Synthetic root" : null,
    nickname: id === WORKER ? "Ada" : null,
    parent: id === WORKER ? { id: ROOT, name: "Synthetic root" } : null,
    ignoredPrivateField: "must-not-be-emitted",
  }]));
  t.after(() => { if (database.isOpen) database.close(); });
  return { root, indexFile, database, event, overview,
    run: (extra = {}) => buildLocalCacheDropThreadLinks({
      indexFile, overview, nowMs: NOW, readThreadMetadata, ...extra,
    }) };
}

test("both recent tables resolve exact adjacency identities without mutating anonymous accounting", async (t) => {
  const f = await fixture(t);
  const beforeOverview = structuredClone(f.overview);
  const beforeFile = await readFile(f.indexFile);
  const beforeNames = await readdir(f.root);
  const result = await f.run();
  assert.equal(result.status, "available");
  assert.equal(result.generation, "7");
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], {
    kind: "switch", key: cacheDropThreadLookupKey("switch", switchRow()),
    thread: { id: ROOT, name: "Synthetic root", nickname: null, parent: null },
  });
  assert.deepEqual(result.entries[1].thread, {
    id: WORKER, name: null, nickname: "Ada", parent: { id: ROOT, name: "Synthetic root" },
  });
  assert.deepEqual(f.overview, beforeOverview);
  assert.deepEqual(await readFile(f.indexFile), beforeFile);
  assert.deepEqual(await readdir(f.root), beforeNames);
  assert.deepEqual(Object.keys(result), ["schemaVersion", "status", "generation", "entries"]);
  assert.doesNotMatch(JSON.stringify(result), /ignoredPrivateField|must-not-be-emitted|session_local/u);
});

test("real cache-impact analyzer rows match the resolver's keys and exact session proof", async (t) => {
  const f = await fixture(t);
  const impacts = readCacheImpacts(f.database, { nowMs: NOW });
  const result = await f.run({ overview: { accounting: { ...f.overview.accounting, ...impacts } } });
  assert.equal(result.entries.filter((entry) => entry.kind === "switch").length, 1);
  assert.equal(result.entries.filter((entry) => entry.kind === "continuity").length, 1);
});

test("a missing local name store keeps exact thread-ID fallbacks", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ readThreadMetadata: async () => { throw new Error("private path must not escape"); } });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0].thread, { id: ROOT, name: null, nickname: null, parent: null });
  assert.doesNotMatch(JSON.stringify(result), /private path/u);
});

test("unknown generation, a foreign fingerprint, and incomplete publications fail closed", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { generation: 8 }, { generation: null }, { generation: "Infinity" },
    { generation: "7.1" }, { generationMatched: false }, { generationFingerprint: "foreign" },
  ]) {
    const result = await f.run({ overview: { accounting: { ...f.overview.accounting, ...patch } } });
    assert.deepEqual(result, { schemaVersion: "local-cache-drop-thread-links-v1", status: "unavailable", generation: null, entries: [] });
  }
  f.database.exec("UPDATE index_generation SET status = 'in_progress' WHERE id = 7");
  assert.equal((await f.run()).status, "unavailable");
});

test("timestamp tuples ambiguous across sessions never guess a thread", async (t) => {
  const f = await fixture(t);
  f.event({ session: 3, time: NOW - 120_000, offset: 100, effort: 2, cached: 1_000 });
  f.event({ session: 3, time: NOW - 60_000, offset: 200 });
  let result = await f.run();
  assert.equal(result.entries.some((entry) => entry.kind === "switch"), false);
  f.database.prepare("DELETE FROM session_identity WHERE session_local = ?").run(local(3));
  result = await f.run();
  assert.equal(result.entries.some((entry) => entry.kind === "switch"), false,
    "a second exact match without a UUID still makes attribution ambiguous");
});

test("positive source byte order, not timestamps or quota-only bookkeeping, proves the prior event", async (t) => {
  const f = await fixture(t);
  f.event({ time: NOW - 90_000, offset: 150, cached: 0, uncached: 0 });
  assert.equal((await f.run()).entries.some((entry) => entry.kind === "switch"), true);
  f.event({ time: NOW - 110_000, offset: 175, effort: 2, cached: 300 });
  assert.equal((await f.run()).entries.some((entry) => entry.kind === "switch"), false,
    "a byte-adjacent positive request defeats a timestamp-range guess");
});

test("timestamp ties are accepted only when byte order and exact zero elapsed gap resolve them", async (t) => {
  const f = await fixture(t);
  f.database.prepare("UPDATE usage_event SET observed_at_ms = ? WHERE session_local = ?")
    .run(NOW - 60_000, local(1));
  const row = { ...switchRow(), gapSeconds: 0 };
  const overview = structuredClone(f.overview);
  overview.accounting.cacheSwitchImpact = { status: "available", recent: [row] };
  const result = await f.run({ overview });
  assert.equal(result.entries.find((entry) => entry.kind === "switch")?.thread.id, ROOT);
});

test("incomplete offsets, duplicate offsets, and multi-source sessions are not identifiable", async (t) => {
  const f = await fixture(t);
  for (const [field, value] of [["source_offset", null], ["source_offset", 200], ["source_id", 2]]) {
    f.database.prepare(`UPDATE usage_event SET ${field} = ? WHERE session_local = ? AND observed_at_ms = ?`)
      .run(value, local(1), NOW - 120_000);
    assert.equal((await f.run()).entries.some((entry) => entry.kind === "switch"), false);
    f.database.prepare("UPDATE usage_event SET source_offset = 100, source_id = 1 WHERE session_local = ? AND observed_at_ms = ?")
      .run(local(1), NOW - 120_000);
  }
});

test("continuity needs its actual turn boundary and both kinds exclude observed compactions", async (t) => {
  const f = await fixture(t);
  f.database.exec("DELETE FROM usage_event_boundary");
  assert.equal((await f.run()).entries.some((entry) => entry.kind === "continuity"), false);
  f.database.prepare(`INSERT INTO usage_event_boundary
    SELECT event_key, 1, 0, observed_at_ms-1, 1, 1, session_local
    FROM usage_event WHERE session_local=? AND observed_at_ms=?`)
    .run(local(1), NOW - 60_000);
  assert.equal((await f.run()).entries.length, 0);
});

test("altered cache amounts, elapsed time, models and effort do not join by timestamp alone", async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { gapSeconds: 61 }, { lostCacheTokens: 900 }, { previousCacheReadTokens: 1_001 },
    { previous: { model: "gpt-5.6-terra", reasoningEffort: "low" } },
    { current: { model: "gpt-5.6-sol", reasoningEffort: "ultra" } },
  ]) {
    const overview = structuredClone(f.overview);
    overview.accounting.cacheSwitchImpact = { status: "available", recent: [{ ...switchRow(), ...patch }] };
    assert.equal((await f.run({ overview })).entries.some((entry) => entry.kind === "switch"), false);
  }
});

test("lookup keys are bounded and closed to valid recent-row fields", () => {
  assert.equal(cacheDropThreadLookupKey("switch", switchRow()), JSON.stringify([
    "switch", switchRow().observedAt, 60, "gpt-5.6-sol", "low", "gpt-5.6-sol", "high", 1_000, 0, 1_000,
  ]));
  assert.equal(cacheDropThreadLookupKey("continuity", continuityRow()), JSON.stringify([
    "continuity", continuityRow().observedAt, 600, "gpt-5.6-terra", "high", "gpt-5.6-terra", "high", 2_000, 100, 1_900,
  ]));
  for (const patch of [
    { observedAt: "2026-08-30" }, { gapSeconds: 0.0001 }, { gapSeconds: -1 },
    { previousCacheReadTokens: Infinity }, { currentCacheReadTokens: 999 },
    { lostCacheTokens: 0 }, { lostCacheTokens: Number.MAX_SAFE_INTEGER },
    { current: { model: "x".repeat(201), reasoningEffort: "high" } },
    { current: { model: "gpt-5.6-sol", reasoningEffort: "unknown" } },
  ]) assert.equal(cacheDropThreadLookupKey("switch", { ...switchRow(), ...patch }), null);
  assert.equal(cacheDropThreadLookupKey("arbitrary", switchRow()), null);
});

test("unsafe or missing index paths fail without creating a database, salt or derived file", async (t) => {
  const f = await fixture(t);
  const linked = join(f.root, "linked.sqlite");
  await symlink(f.indexFile, linked);
  assert.equal((await f.run({ indexFile: linked })).status, "unavailable");
  const before = await readdir(f.root);
  assert.equal((await f.run({ indexFile: join(f.root, "missing.sqlite") })).status, "unavailable");
  assert.deepEqual(await readdir(f.root), before);
  await chmod(f.indexFile, 0o622);
  assert.equal((await f.run()).status, "unavailable");
});

test("ephemeral metadata is projected afresh and malformed names or parents cannot broaden links", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ readThreadMetadata: async () => new Map([
    [ROOT, { id: ROOT, name: "<b>Synthetic title</b>", nickname: "invalid\nname", parent: { id: ROOT, name: "self" }, url: "https://invalid.test" }],
    [WORKER, { id: WORKER, name: "x".repeat(513), nickname: "x".repeat(81), parent: { id: "not-a-uuid", name: "bad" } }],
  ]) });
  assert.deepEqual(result.entries[0].thread, { id: ROOT, name: "<b>Synthetic title</b>", nickname: null, parent: null });
  assert.deepEqual(result.entries[1].thread, { id: WORKER, name: null, nickname: null, parent: null });
  assert.doesNotMatch(JSON.stringify(result), /invalid.test/u);
});

test("only bounded recent references are queried through timestamp and session indexes", async (t) => {
  const f = await fixture(t);
  let cursor = 0;
  const recent = (template) => Array.from({ length: 20 }, () => ({
    ...template(), observedAt: new Date(NOW - (++cursor * 1_000)).toISOString(),
  }));
  const impact = (template) => ({
    status: "available", recent: recent(template),
    periods: ["24h", "7d", "30d", "all"].map((periodId) => ({
      periodId, recent: recent(template),
    })),
  });
  const overview = { accounting: {
    ...f.overview.accounting,
    cacheSwitchImpact: impact(switchRow),
    cacheContinuityImpact: impact(continuityRow),
  } };
  let reads = 0;
  const openIndex = (path, options) => {
    assert.deepEqual(options, { readOnly: true });
    const connection = openLocalUnifiedIndex(path, options);
    return {
      get isOpen() { return connection.isOpen; },
      close: () => connection.close(),
      exec: (sql) => connection.exec(sql),
      prepare(sql) {
        assert.doesNotMatch(sql, /\bLAG\s*\(/iu, "HTTP lookup never scans whole history with LAG");
        const statement = connection.prepare(sql);
        if (!sql.includes("u.rowid AS usage_rowid")) return statement;
        assert.match(sql, /INDEXED BY usage_event_observed/u);
        return { all(...args) {
          reads += 1;
          assert.equal(args.at(-1), 9, "candidate row limit is fixed");
          return statement.all(...args);
        } };
      },
    };
  };
  assert.equal((await f.run({ overview, openIndex })).status, "available");
  assert.equal(reads, 160, "unique references stop at the closed 160-row bound");
});

test("an oversized session cannot cause an unbounded ordering scan or hide other covered sessions", async (t) => {
  const f = await fixture(t);
  f.database.exec("BEGIN");
  for (let index = 0; index < 25_000; index += 1) {
    f.event({ time: NOW - 20_000, offset: index + 1_000, cached: 10 });
  }
  f.database.exec("COMMIT");
  const result = await f.run();
  assert.equal(result.entries.some((entry) => entry.kind === "switch"), false);
  assert.equal(result.entries.find((entry) => entry.kind === "continuity")?.thread.id, WORKER);
});

test("too many timestamp candidates are unresolved, not truncated into a unique match", async (t) => {
  const f = await fixture(t);
  for (let session = 3; session < 12; session += 1) {
    f.event({ session, time: NOW - 120_000, offset: 100, effort: 2, cached: 1_000 });
    f.event({ session, time: NOW - 60_000, offset: 200 });
  }
  assert.equal((await f.run()).entries.some((entry) => entry.kind === "switch"), false);
});

test("an outdated parser or contracted input cannot supply a cache-drop identity", async (t) => {
  const f = await fixture(t);
  f.database.exec("UPDATE parser_version SET parser_version = 'unified-rollout-typed-v10'");
  let result = await f.run({ overview: { accounting: {
    ...f.overview.accounting, generationFingerprint: null,
  } } });
  assert.equal(result.entries.length, 0);
  f.database.prepare("UPDATE parser_version SET parser_version = ?")
    .run(LOCAL_UNIFIED_INDEX_PARSER_VERSION);
  f.database.prepare("UPDATE usage_event SET tokens_in_uncached = 100 WHERE session_local = ? AND observed_at_ms = ?")
    .run(local(1), NOW - 60_000);
  const overview = structuredClone(f.overview);
  overview.accounting.cacheSwitchImpact = { status: "available", recent: [
    { ...switchRow(), lostCacheTokens: 100 },
  ] };
  result = await f.run({ overview });
  assert.equal(result.entries.some((entry) => entry.kind === "switch"), false);
});

function inspectionOrder(reverse, onSessionRow = () => {}) {
  return (path, options) => {
    const connection = openLocalUnifiedIndex(path, options);
    return {
      get isOpen() { return connection.isOpen; },
      close: () => connection.close(),
      exec: (sql) => connection.exec(sql),
      prepare(sql) {
        const statement = connection.prepare(sql);
        if (sql.includes("u.rowid AS usage_rowid")) {
          return { all(...args) {
            const result = statement.all(...args);
            return reverse ? result.reverse() : result;
          } };
        }
        if (sql.includes("FROM usage_event INDEXED BY usage_event_session")) {
          return { *iterate(...args) {
            for (const row of statement.iterate(...args)) {
              onSessionRow();
              yield row;
            }
          } };
        }
        return statement;
      },
    };
  };
}

for (const reverse of [false, true]) {
  const order = reverse ? "bounded-out candidate first" : "covered candidate first";
  test(`a per-session budget gap is not evidence of a unique thread (${order})`, async (t) => {
    const f = await fixture(t);
    f.database.exec("BEGIN");
    f.event({ session: 3, time: NOW - 120_000, offset: 100, effort: 2, cached: 1_000 });
    f.event({ session: 3, time: NOW - 60_000, offset: 200 });
    for (let index = 0; index < 25_000; index += 1) {
      f.event({ session: 3, time: NOW - 20_000, offset: index + 1_000, cached: 10 });
    }
    f.database.exec("COMMIT");
    const result = await f.run({ openIndex: inspectionOrder(reverse) });
    assert.equal(result.entries.some((entry) => entry.kind === "switch"), false,
      "the unexamined same-timestamp candidate might be another exact match");
    assert.equal(result.entries.find((entry) => entry.kind === "continuity")?.thread.id, WORKER,
      "an independent completely inspected reference remains available");
  });

  test(`total-budget exhaustion cannot promote a cached candidate into a unique thread (${order})`, async (t) => {
    const f = await fixture(t);
    f.database.exec("BEGIN");
    f.event({ time: NOW - 20_000, offset: 300, effort: 4, cached: 1_000 });
    f.event({ time: NOW - 10_000, offset: 400, effort: 2 });
    f.event({ session: 3, time: NOW - 120_000, offset: 100, effort: 2, cached: 1_000 });
    f.event({ session: 3, time: NOW - 60_000, offset: 200 });
    const primingReferences = [{
      ...switchRow(), observedAt: new Date(NOW - 10_000).toISOString(), gapSeconds: 10,
      previous: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      current: { model: "gpt-5.6-sol", reasoningEffort: "low" },
    }];
    // Four rows in the cached known session plus these four fully inspected
    // sessions consume exactly 100,000 rows. The final ambiguous reference
    // then has one cached match and one unseen two-row session.
    for (let session = 4; session <= 7; session += 1) {
      const currentTime = NOW - session * 1_000;
      const rows = session === 7 ? 24_996 : 25_000;
      f.event({ session, time: currentTime - 60_000, offset: 100, effort: 2, cached: 1_000 });
      f.event({ session, time: currentTime, offset: 200 });
      for (let index = 2; index < rows; index += 1) {
        f.event({ session, time: NOW - 1_000, offset: index + 1_000, cached: 10 });
      }
      primingReferences.push({ ...switchRow(), observedAt: new Date(currentTime).toISOString() });
    }
    f.database.exec("COMMIT");
    const overview = { accounting: { ...f.overview.accounting,
      cacheSwitchImpact: { status: "available", recent: [...primingReferences, switchRow()] },
      cacheContinuityImpact: { status: "available", recent: [] },
    } };
    let inspectedRows = 0;
    const result = await f.run({
      overview, openIndex: inspectionOrder(reverse, () => { inspectedRows += 1; }),
    });
    assert.equal(inspectedRows, 100_000, "the total budget is actually exhausted");
    assert.equal(result.entries.some((entry) => entry.key === cacheDropThreadLookupKey("switch", switchRow())), false,
      "a cached match is not unique while the other candidate remains unexamined");
    assert.equal(result.entries.find((entry) => entry.key === cacheDropThreadLookupKey("switch", primingReferences[0]))?.thread.id, ROOT);
  });
}

for (const [previousEffort, currentEffort] of [["max", "ultra"], ["ultra", "max"]]) {
  test(`authoritative ${previousEffort}-to-${currentEffort} continuity rows keep their exact thread identity`, async (t) => {
    const f = await fixture(t);
    const update = f.database.prepare(
      "UPDATE usage_event SET reasoning_effort = ? WHERE session_local = ? AND source_offset = ?",
    );
    update.run(reasoningEffortOrdinal(previousEffort), local(2), 100);
    update.run(reasoningEffortOrdinal(currentEffort), local(2), 200);
    const impacts = readCacheImpacts(f.database, { nowMs: NOW });
    const rows = impacts.cacheContinuityImpact.periods.find((period) => period.periodId === "all").recent;
    assert.equal(rows.length, 1, "the authoritative analyzer admits this effective-effort match");
    assert.equal(rows[0].configuration.reasoningEffort, currentEffort);
    const result = await f.run({ overview: { accounting: { ...f.overview.accounting, ...impacts } } });
    assert.equal(result.entries.find((entry) => entry.key === cacheDropThreadLookupKey("continuity", rows[0]))?.thread.id, WORKER);
  });
}

test("both genuine Max/Ultra continuity candidates make a collapsed current-only DTO ambiguous", async (t) => {
  const f = await fixture(t);
  f.database.prepare("UPDATE usage_event SET reasoning_effort = ? WHERE session_local = ? AND source_offset = ?")
    .run(reasoningEffortOrdinal("max"), local(2), 100);
  f.database.prepare("UPDATE usage_event SET reasoning_effort = ? WHERE session_local = ? AND source_offset = ?")
    .run(reasoningEffortOrdinal("ultra"), local(2), 200);
  f.event({ session: 3, model: 2, time: NOW - 630_000, offset: 100,
    effort: reasoningEffortOrdinal("ultra"), cached: 2_000 });
  f.event({ session: 3, model: 2, time: NOW - 30_000, offset: 200,
    effort: reasoningEffortOrdinal("ultra"), cached: 100, uncached: 2_200, turn: true });
  const impacts = readCacheImpacts(f.database, { nowMs: NOW });
  const rows = impacts.cacheContinuityImpact.periods.find((period) => period.periodId === "all").recent;
  assert.equal(rows.length, 2);
  assert.equal(cacheDropThreadLookupKey("continuity", rows[0]), cacheDropThreadLookupKey("continuity", rows[1]),
    "the anonymous DTO intentionally carries the current effort, not its raw prior alias");
  const result = await f.run({ overview: { accounting: { ...f.overview.accounting, ...impacts } } });
  assert.equal(result.entries.some((entry) => entry.kind === "continuity"), false,
    "both effective-effort candidates must be counted before uniqueness is claimed");
});

function addDistinctRoutingDimensions(database) {
  database.exec(`
    INSERT INTO tier_semantics VALUES (2,'priority','chatgpt_subscription','fast','observed',NULL);
    INSERT INTO surface_class VALUES (2,'subagent','subagent','subagent','canonical');
  `);
}

for (const field of ["tier_id", "surface_id"]) {
  test(`continuity ${field} boundaries rejected by the analyzer cannot be attributed by tuple alone`, async (t) => {
    const f = await fixture(t);
    addDistinctRoutingDimensions(f.database);
    f.database.prepare(`UPDATE usage_event SET ${field} = 2 WHERE session_local = ? AND source_offset = 200`)
      .run(local(2));
    const impacts = readCacheImpacts(f.database, { nowMs: NOW });
    assert.equal(impacts.cacheContinuityImpact.periods.find((period) => period.periodId === "all").recent.length, 0);
    const result = await f.run();
    assert.equal(result.entries.some((entry) => entry.kind === "continuity"), false,
      "a reference with matching time/model/effort/tokens still needs the same observed routing dimensions");
    assert.equal(result.entries.find((entry) => entry.kind === "switch")?.thread.id, ROOT);
  });

  test(`a ${field}-excluded candidate does not hide a uniquely eligible continuity thread`, async (t) => {
    const f = await fixture(t);
    addDistinctRoutingDimensions(f.database);
    f.event({ session: 3, model: 2, time: NOW - 630_000, offset: 100, cached: 2_000 });
    f.event({ session: 3, model: 2, time: NOW - 30_000, offset: 200,
      cached: 100, uncached: 2_200, turn: true });
    f.database.prepare(`UPDATE usage_event SET ${field} = 2 WHERE session_local = ? AND source_offset = 200`)
      .run(local(3));
    const impacts = readCacheImpacts(f.database, { nowMs: NOW });
    const rows = impacts.cacheContinuityImpact.periods.find((period) => period.periodId === "all").recent;
    assert.equal(rows.length, 1, "only the candidate with unchanged routing is eligible");
    const result = await f.run({ overview: { accounting: { ...f.overview.accounting, ...impacts } } });
    assert.equal(result.entries.find((entry) => entry.key === cacheDropThreadLookupKey("continuity", rows[0]))?.thread.id, WORKER);
  });
}

test("switch rows preserve exact prior Max/Ultra labels rather than adopting continuity equivalence", async (t) => {
  const f = await fixture(t);
  f.database.prepare("UPDATE usage_event SET reasoning_effort = ? WHERE session_local = ? AND source_offset = 100")
    .run(reasoningEffortOrdinal("max"), local(1));
  f.event({ session: 3, time: NOW - 120_000, offset: 100,
    effort: reasoningEffortOrdinal("ultra"), cached: 1_000 });
  f.event({ session: 3, time: NOW - 60_000, offset: 200 });
  const impacts = readCacheImpacts(f.database, { nowMs: NOW });
  const rows = impacts.cacheSwitchImpact.periods.find((period) => period.periodId === "all").recent;
  assert.equal(rows.length, 2);
  const result = await f.run({ overview: { accounting: { ...f.overview.accounting, ...impacts } } });
  for (const row of rows) {
    assert.equal(result.entries.find((entry) => entry.key === cacheDropThreadLookupKey("switch", row))?.thread.id,
      row.previous.reasoningEffort === "max" ? ROOT : THIRD);
  }
});
