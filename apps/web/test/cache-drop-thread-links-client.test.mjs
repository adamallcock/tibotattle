import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalCompanionClient,
  cacheDropThreadLookupKey,
  normalizeCacheDropThreadLinks,
  normalizeDashboardPayload,
} from "../public/data-client.js";
import { cacheDropThreadLookupKey as companionLookupKey } from "../../../src/local-cache-drop-thread-links.js";
import { analyzeCacheContinuityRows, analyzeCacheSwitchRows } from "../../../src/cache-switch-impact.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, reasoningEffortOrdinal } from "../../../src/local-unified-index.js";

const SCHEMA = "local-cache-drop-thread-links-v1";
const THREAD_ID = "11111111-0000-4000-8000-000000000001";
const PARENT_ID = "22222222-0000-7000-8000-000000000002";
const NOW_MS = Date.parse("2026-08-25T13:00:00.000Z");
const UNAVAILABLE = { schemaVersion: SCHEMA, status: "unavailable", generation: null, entries: [] };

function drop(kind = "switch", offsetMs = 0) {
  const configuration = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  return {
    observedAt: new Date(NOW_MS - 60_000 + offsetMs).toISOString(),
    gapSeconds: 45,
    previousCacheReadTokens: 120_000,
    currentCacheReadTokens: 20_000,
    lostCacheTokens: 100_000,
    ...(kind === "switch" ? {
      previous: { model: "gpt-5.6-terra", reasoningEffort: "high" },
      current: configuration,
    } : { configuration }),
  };
}

function entry(kind = "switch", offsetMs = 0) {
  return {
    kind,
    key: cacheDropThreadLookupKey(kind, drop(kind, offsetMs)),
    thread: {
      id: THREAD_ID,
      name: "Synthetic thread title",
      nickname: null,
      parent: null,
    },
  };
}

function payload() {
  return { schemaVersion: SCHEMA, status: "available", generation: "35", entries: [entry()] };
}

// The analyzer publishes both speed scenarios; the companion chooses one for
// display. Supply that synthetic presentation metadata while retaining the
// analyzer's event-pair evidence unchanged for the browser/companion key test.
function displaySummary(summary) {
  const selectStandard = (weighting) => ({
    ...weighting,
    status: "complete",
    selectedScenario: "unresolved_as_standard",
    selectedPremiumUsd: weighting.scenarios.unresolved_as_standard.quotaWeightedPremiumUsd,
    rangePremiumUsd: null,
  });
  const result = {
    ...summary,
    allowanceWeighting: selectStandard(summary.allowanceWeighting),
    coveredSubtotal: summary.coveredSubtotal === null ? null : {
      ...summary.coveredSubtotal,
      allowanceWeighting: selectStandard(summary.coveredSubtotal.allowanceWeighting),
    },
  };
  for (const key of ["byChangeType", "byGapBand", "byOutcomeBucket"]) {
    if (summary[key]) result[key] = Object.fromEntries(Object.entries(summary[key])
      .map(([name, value]) => [name, displaySummary(value)]));
  }
  return result;
}

test("local thread lookup preserves only its exact bounded contract, including nullable labels and parent", () => {
  const input = payload();
  input.entries.push(entry("continuity"));
  input.entries[1].thread = {
    id: THREAD_ID, name: null, nickname: "Synthetic worker", parent: { id: PARENT_ID, name: null },
  };
  const before = structuredClone(input);
  const result = normalizeCacheDropThreadLinks(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result.entries[0], input.entries[0]);
  assert.notEqual(result.entries[0].thread, input.entries[0].thread);
  assert.notEqual(result.entries[1].thread.parent, input.entries[1].thread.parent);
  result.entries[1].thread.parent.name = "New local display name";
  assert.deepEqual(input, before, "normalization snapshots independent values");
  assert.deepEqual(normalizeCacheDropThreadLinks({ ...payload(), entries: [] }), {
    schemaVersion: SCHEMA, status: "available", generation: "35", entries: [],
  }, "an available lookup may honestly have no proven matches");
  const unnamed = payload();
  unnamed.entries[0].thread = { id: THREAD_ID, name: null, nickname: null, parent: null };
  assert.deepEqual(normalizeCacheDropThreadLinks(unnamed), unnamed);
});

test("hostile extra or missing lookup fields fail closed at every contract level", () => {
  const mutations = [
    (v) => { v.schemaVersion = "local-cache-drop-thread-links-v2"; },
    (v) => { v.status = "ready"; },
    (v) => { delete v.generation; },
    (v) => { v.rawPath = "/synthetic/private"; },
    (v) => { v.entries = {}; },
    (v) => { v.entries[0].kind = "other"; },
    (v) => { delete v.entries[0].thread; },
    (v) => { v.entries[0].eventKey = "synthetic-private-event"; },
    (v) => { v.entries[0].thread.href = "javascript:alert(1)"; },
    (v) => { v.entries[0].thread.command = "synthetic-private-command"; },
    (v) => { delete v.entries[0].thread.name; },
    (v) => { delete v.entries[0].thread.nickname; },
    (v) => { delete v.entries[0].thread.parent; },
    (v) => { v.entries[0].thread.parent = { id: PARENT_ID }; },
    (v) => { v.entries[0].thread.parent = { id: PARENT_ID, name: "Parent", href: "https://example.test" }; },
    (v) => { v.entries[0].thread.parent = []; },
  ];
  for (const mutate of mutations) {
    const input = payload();
    mutate(input);
    assert.deepEqual(normalizeCacheDropThreadLinks(input), UNAVAILABLE);
  }
  for (const value of [null, undefined, false, "private error", [], {}, UNAVAILABLE]) {
    assert.deepEqual(normalizeCacheDropThreadLinks(value), UNAVAILABLE);
  }
});

test("lookup UUIDs require exact canonical version and variant positions with no arbitrary URL suffixes", () => {
  for (const invalidId of [null, 42, "", ` ${THREAD_ID}`, `${THREAD_ID}\n`,
    `${THREAD_ID}?x=1`, `${THREAD_ID}#fragment`, `${THREAD_ID}/../settings`,
    `codex://threads/${THREAD_ID}`, "javascript:alert(1)",
    "11111111-0000-0000-8000-000000000001", "11111111-0000-9000-8000-000000000001",
    "11111111-0000-4000-7000-000000000001", "11111111-0000-4000-c000-000000000001"]) {
    const input = payload();
    input.entries[0].thread.id = invalidId;
    assert.deepEqual(normalizeCacheDropThreadLinks(input), UNAVAILABLE);
    const parentInput = payload();
    parentInput.entries[0].thread.parent = { id: invalidId, name: "Synthetic parent" };
    assert.deepEqual(normalizeCacheDropThreadLinks(parentInput), UNAVAILABLE);
  }
  const uppercase = payload();
  uppercase.entries[0].thread.id = "ABCDEF01-0000-4000-8000-000000000001";
  assert.deepEqual(normalizeCacheDropThreadLinks(uppercase), UNAVAILABLE);
  const selfParent = payload();
  selfParent.entries[0].thread.parent = { id: THREAD_ID, name: "Synthetic self" };
  assert.deepEqual(normalizeCacheDropThreadLinks(selfParent), UNAVAILABLE);
  for (const version of [1, 4, 7, 8]) {
    const input = payload();
    input.entries[0].thread.id = `abcdef01-0000-${version}000-b000-000000000001`;
    assert.deepEqual(normalizeCacheDropThreadLinks(input), input);
  }
});

test("lookup names have exact length and control-character limits without interpreting literal markup", () => {
  for (const [field, maximum] of [["name", 512], ["nickname", 80]]) {
    const boundary = payload();
    boundary.entries[0].thread[field] = "λ".repeat(maximum);
    assert.deepEqual(normalizeCacheDropThreadLinks(boundary), boundary);
    for (const invalid of ["", "x".repeat(maximum + 1), 12, {}, [], "x\u0000y", "x\ny", "x\u007fy", "x\u0085y"]) {
      const input = payload();
      input.entries[0].thread[field] = invalid;
      assert.deepEqual(normalizeCacheDropThreadLinks(input), UNAVAILABLE);
    }
  }
  for (const name of [null, "Parent", "x".repeat(512)]) {
    const input = payload();
    input.entries[0].thread.parent = { id: PARENT_ID, name };
    assert.deepEqual(normalizeCacheDropThreadLinks(input), input);
  }
  for (const name of ["", "x".repeat(513), "x\ry", 12]) {
    const input = payload();
    input.entries[0].thread.parent = { id: PARENT_ID, name };
    assert.deepEqual(normalizeCacheDropThreadLinks(input), UNAVAILABLE);
  }
  const literal = payload();
  literal.entries[0].thread.name = '<img src=x onerror="synthetic()"> & Configuration';
  assert.deepEqual(normalizeCacheDropThreadLinks(literal), literal,
    "literal text is allowed; the renderer must use text nodes rather than HTML");
});

test("duplicate, oversized and noncanonical lookup keys fail closed without truncating mappings", () => {
  const maximum = { ...payload(), entries: Array.from({ length: 160 }, (_, index) => entry("switch", index)) };
  assert.equal(normalizeCacheDropThreadLinks(maximum).entries.length, 160);
  assert.deepEqual(normalizeCacheDropThreadLinks({ ...maximum, entries: [...maximum.entries, entry("switch", 160)] }), UNAVAILABLE);
  const duplicate = payload();
  duplicate.entries.push(structuredClone(duplicate.entries[0]));
  duplicate.entries[1].thread.id = PARENT_ID;
  assert.deepEqual(normalizeCacheDropThreadLinks(duplicate), UNAVAILABLE, "ambiguous duplicate mappings are not last-write-wins");
  const key = payload().entries[0].key;
  const tuple = JSON.parse(key);
  const invalidTuples = [
    [...tuple, "extra"], tuple.slice(0, 9), ["continuity", ...tuple.slice(1)],
    tuple.map((value, index) => index === 2 ? -1 : value),
    tuple.map((value, index) => index === 2 ? 0.0001 : value),
    tuple.map((value, index) => index === 3 ? "x".repeat(201) : value),
    tuple.map((value, index) => index === 3 ? "<script>" : value),
    tuple.map((value, index) => index === 4 ? "unknown" : value),
    tuple.map((value, index) => index === 7 ? -1 : value),
    tuple.map((value, index) => index === 8 ? 100_000 : value),
    tuple.map((value, index) => index === 9 ? 200_000 : value),
  ];
  for (const badKey of [null, 42, "", "x".repeat(2049), "not-json", "{}", ` ${key}`, `${key}\n`,
    JSON.stringify(tuple, null, 2), ...invalidTuples.map((value) => JSON.stringify(value))]) {
    const input = payload();
    input.entries[0].key = badKey;
    assert.deepEqual(normalizeCacheDropThreadLinks(input), UNAVAILABLE);
  }
  const changedContinuity = entry("continuity");
  const continuityTuple = JSON.parse(changedContinuity.key);
  continuityTuple[3] = "gpt-5.6-terra";
  changedContinuity.key = JSON.stringify(continuityTuple);
  assert.deepEqual(normalizeCacheDropThreadLinks({ ...payload(), entries: [changedContinuity] }), UNAVAILABLE,
    "continuity lookup cannot smuggle a different preceding model into its key");
});

test("lookup and dashboard generations canonicalize positive integers without inventing a match attestation", () => {
  for (const generation of [35, "35", "35.0", "35.000"]) {
    const input = { ...payload(), generation };
    assert.equal(normalizeCacheDropThreadLinks(input).generation, "35");
    const result = normalizeDashboardPayload({ mode: "real_local_evidence", accounting: { generation, generationMatched: true } });
    assert.equal(result.mode, "real_local_evidence");
    assert.equal(result.accounting.generation, "35");
    assert.equal(result.accounting.generationMatched, true);
    for (const mismatch of [false, "true", "false", 1, null, undefined]) {
      const mismatched = normalizeDashboardPayload({ accounting: { generation, generationMatched: mismatch } });
      assert.equal(mismatched.accounting.generation, "35");
      assert.equal(mismatched.accounting.generationMatched, false);
    }
  }
  for (const generation of [null, undefined, 0, -1, 35.5, NaN, Infinity,
    "", "0", "035", " 35", "35\n", "35.1", "3.5e1", "0x23", "x".repeat(33), Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(normalizeCacheDropThreadLinks({ ...payload(), generation }), UNAVAILABLE);
    assert.equal(normalizeDashboardPayload({ accounting: { generation, generationMatched: true } }).accounting.generation, null);
  }
  assert.equal(normalizeCacheDropThreadLinks({ ...payload(), generation: "36" }).generation, "36",
    "the separate lookup retains its own generation for the UI to compare, never relabels it");
});

test("lookup client sends only the loopback route, local header and no-store request policy", async () => {
  const calls = [];
  const client = new LocalCompanionClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload()), { status: 200 });
  } });
  assert.deepEqual(await client.cacheDropThreadLinks(), payload());
  assert.deepEqual(calls, [{
    url: "/api/local/cache-drop-thread-links",
    options: { cache: "no-store", headers: { Accept: "application/json", "X-Usage-Monitor-Local": "1" } },
  }]);
});

test("older missing routes, failed reads and malformed responses degrade to the same quiet lookup fallback", async () => {
  for (const fetchImpl of [
    async () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }),
    async () => new Response("synthetic private error", { status: 500 }),
    async () => new Response("not-json", { status: 200 }),
    async () => new Response(null, { status: 204 }),
    async () => new Response(JSON.stringify({ ...payload(), sessionPath: "synthetic-private-path" }), { status: 200 }),
    async () => { throw new Error("synthetic private path"); },
  ]) {
    const client = new LocalCompanionClient({ fetchImpl });
    assert.deepEqual(await client.cacheDropThreadLinks(), UNAVAILABLE);
  }
});

test("normalized switch and continuity rows keep exactly the same anonymous lookup key as the companion", () => {
  const base = {
    observed_at_ms: NOW_MS - 60_000,
    previous_observed_at_ms: NOW_MS - 105_000,
    model_id: "gpt-5.6-sol", previous_model_id: "gpt-5.6-sol",
    model_recognition: "recognized", previous_model_recognition: "recognized",
    reasoning_effort: reasoningEffortOrdinal("high"), previous_reasoning_effort: reasoningEffortOrdinal("low"),
    tokens_in_uncached: 800, tokens_in_cache_read: 0, tokens_in_cache_write: 300,
    previous_tokens_in_cache_read: 1_000,
    parser_version: LOCAL_UNIFIED_INDEX_PARSER_VERSION, previous_parser_version: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    tier_id: 1, previous_tier_id: 1, surface_id: 1, previous_surface_id: 1,
    compaction_between: 0, turn_context_between: 1,
    tokens_out_text: 0, tokens_out_reasoning: 0, tokens_out_combined: 0,
  };
  const pricer = (_event, components) => ({
    coverageStatus: "fully_priced",
    totalUsd: ((components.input_uncached_tokens * 10 + components.input_cache_read_tokens
      + components.input_cache_write_tokens * 12) / 1_000_000_000).toFixed(9),
  });
  for (const [kind, analyze, rows, field] of [
    ["switch", analyzeCacheSwitchRows, [base], "cacheSwitchImpact"],
    ["continuity", analyzeCacheContinuityRows, [{ ...base, previous_reasoning_effort: base.reasoning_effort }], "cacheContinuityImpact"],
  ]) {
    const analysis = analyze(rows, { nowMs: NOW_MS, pricer });
    const periods = analysis.periods.map(displaySummary);
    const selected = periods.find((period) => period.periodId === "7d");
    assert.equal(selected.recent.length, 1, `${kind} fixture has a real analyzer-produced comparison`);
    const impact = { ...analysis, ...selected, periods, standardApiPremiumUsd: selected.estimatedPremiumUsd };
    impact.recent[0].sessionLocal = "synthetic-private-session";
    impact.recent[0].threadName = "synthetic-private-title";
    const normalized = normalizeDashboardPayload({
      mode: "real_local_evidence",
      accounting: { generation: "35.0", generationMatched: true, [field]: impact },
    }).accounting;
    assert.equal(normalized[field].status, "available", `${kind} display fixture is admitted`);
    assert.equal(normalized[field].recent.length, 1);
    const rawKey = companionLookupKey(kind, selected.recent[0]);
    assert.notEqual(rawKey, null);
    assert.equal(cacheDropThreadLookupKey(kind, normalized[field].recent[0]), rawKey);
    assert.equal(normalized[field].recent[0].gapSeconds, 45);
    assert.doesNotMatch(JSON.stringify(normalized), /synthetic-private|sessionLocal|threadName/u,
      "the numeric dashboard contract stays anonymous despite the separate display lookup");
    const response = { ...payload(), entries: [{ ...entry(kind), key: rawKey }] };
    assert.deepEqual(normalizeCacheDropThreadLinks(response), response);
  }
});

test("browser and companion key helpers reject the same malformed event-pair evidence", () => {
  for (const kind of ["switch", "continuity"]) {
    const mutations = [
      (v) => { v.observedAt = "2026-02-30T12:34:00.000Z"; },
      (v) => { v.observedAt = "not-a-time"; },
      (v) => { v.gapSeconds = NaN; },
      (v) => { v.gapSeconds = Infinity; },
      (v) => { v.gapSeconds = -1; },
      (v) => { v.gapSeconds = 0.0001; },
      (v) => { v.gapSeconds = Number.MAX_SAFE_INTEGER; },
      (v) => { v.currentCacheReadTokens = 120_000; },
      (v) => { v.lostCacheTokens = 0; },
      (v) => { v.previousCacheReadTokens = 1.5; },
      (v) => { (kind === "switch" ? v.current : v.configuration).reasoningEffort = "unknown"; },
      (v) => { (kind === "switch" ? v.previous : v.configuration).model = "x".repeat(201); },
    ];
    for (const mutate of mutations) {
      const value = drop(kind);
      mutate(value);
      assert.equal(cacheDropThreadLookupKey(kind, value), null);
      assert.equal(companionLookupKey(kind, value), null);
    }
    assert.equal(cacheDropThreadLookupKey(kind, null), null);
    assert.equal(companionLookupKey(kind, null), null);
  }
});
