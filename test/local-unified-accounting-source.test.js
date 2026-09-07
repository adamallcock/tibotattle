import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION,
  createLocalUnifiedAccountingSource,
  canonicalInstant,
  createLocalUnifiedUsageAttributionReader,
  precomputeLocalUnifiedUsageAttribution,
} from "../src/local-unified-accounting-source.js";
import {
  beginUnifiedIndexGeneration,
  createUnifiedIndexWriter,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";

const START_AT = "2026-08-01T00:00:00.000Z";
const END_AT = "2026-08-02T00:00:00.000Z";
const OBSERVED_MS = Date.parse("2026-08-01T12:00:00.000Z");
const RESET_MS = Date.parse("2026-08-08T00:00:00.000Z");

async function createIndex({ status = "complete", empty = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "unified-accounting-source-"));
  const indexFile = join(root, "unified.sqlite");
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
    discoveredSourceCount: empty ? 0 : 1,
    discoveredSourceBytes: empty ? 0 : 4096,
  });
  const sourceLocal = Buffer.alloc(32, 4);
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
    generationId: generation.generationId,
    parserVersionId: generation.parserVersionId,
    ingestRunId: generation.ingestRunId,
  });
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", status);
  writer.writeMeta("generated_at", "2026-08-01T13:00:00.000Z");
  writer.writeMeta("source_count", empty ? 0 : 1);
  writer.writeMeta("source_bytes", empty ? 0 : 4096);
  if (!empty) {
    const accountScopeId = writer.internAccountScope({
      status: "unavailable",
      reason: "missing_account",
      planType: null,
      scopeLocal: null,
    });
    const modelId = writer.internModel("gpt-5.6-sol", "recognized");
    const tierId = writer.internTier({
      apiServiceTier: "unknown",
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      tierSource: "rollout_thread_settings",
      providerTierRaw: "priority",
    });
    const surfaceId = writer.internSurface({
      agentScope: "root",
      surface: "cli_exec",
      threadSource: "user",
      lineageDisposition: "standalone",
    });
    const quotaObservationId = writer.internQuota({
      observedAtMs: OBSERVED_MS + 1_000,
      limitId: "codex",
      slot: "primary",
      planType: null,
      usedPercent: 12.5,
      resetsAtMs: RESET_MS,
      durationMins: 10_080,
    });
    const writeUsage = (eventKeyByte, inputTokens, sourceOffset) => writer.writeUsageEvent({
      eventKey: Buffer.alloc(32, eventKeyByte),
      observedAtMs: OBSERVED_MS,
      generationId: generation.generationId,
      sourceLocal,
      sourceOffset,
      sourceOrdinal: 0,
      tierObservedAtMs: OBSERVED_MS - 1_000,
      sessionLocal: Buffer.alloc(32, 7),
      accountScopeId,
      modelId,
      tierId,
      surfaceId,
      quotaObservationId,
      reasoningEffort: 4,
      outcome: 5,
      tokensInUncached: inputTokens,
      tokensInCacheRead: 0,
      tokensInCacheWrite: 0,
      tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null,
      tokensOutText: 2,
      tokensOutReasoning: 1,
      tokensOutCombined: null,
      totalInputContext: null,
      partial: false,
    });
    // Insert in reverse key order; the read contract must still be stable.
    writeUsage(2, 20, 2);
    writeUsage(1, 10, 1);
    // Quota-only token records exist in the current schema. They must not
    // become zero-token accounting usage callbacks.
    writer.writeUsageEvent({
      eventKey: Buffer.alloc(32, 3),
      observedAtMs: OBSERVED_MS + 1_000,
      generationId: generation.generationId,
      sourceLocal,
      sourceOffset: 3,
      sourceOrdinal: 0,
      tierObservedAtMs: OBSERVED_MS - 1_000,
      sessionLocal: Buffer.alloc(32, 7),
      accountScopeId,
      modelId,
      tierId,
      surfaceId,
      quotaObservationId,
      reasoningEffort: 4,
      outcome: 5,
      tokensInUncached: null,
      tokensInCacheRead: null,
      tokensInCacheWrite: null,
      tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null,
      tokensOutText: null,
      tokensOutReasoning: null,
      tokensOutCombined: null,
      totalInputContext: null,
      partial: false,
    });
    writer.writeQuotaOccurrence({
      generationId: generation.generationId,
      sourceLocal,
      sourceOffset: 3,
      sourceOrdinal: 0,
      surfaceId,
      canonicalObservationId: quotaObservationId,
      observedAtMs: OBSERVED_MS + 1_000,
      provider: "openai_codex",
      planType: null,
      limitId: "codex",
      slot: "primary",
      slotOrder: 0,
      usedPercent: 12.5,
      resetsAtMs: RESET_MS,
      durationMins: 10_080,
      admission: "admitted",
    });
    writer.writeSourceCursor({
      sourceLocal,
      sourceOrdinal: 0,
      sessionLocal: Buffer.alloc(32, 7),
      scannedBytes: 4096,
      sizeBytes: 4096,
      mtimeMs: OBSERVED_MS,
      snapshotsPersisted: true,
      turnContextSeen: true,
      carryModel: "gpt-5.6-sol",
      carryEffort: "high",
      carryTierRaw: "priority",
      carryTierObservedAtMs: OBSERVED_MS - 1_000,
      carryTotals: null,
    });
    writer.writeGenerationSource({
      generationId: generation.generationId,
      sourceLocal,
      sourceOrdinal: 0,
      sessionLocal: Buffer.alloc(32, 7),
      surfaceId,
      status: "complete",
      discoveredSizeBytes: 4096,
      scannedBytes: 4096,
      mtimeMs: OBSERVED_MS,
      diagnosticsComplete: true,
    });
    writer.writeSourceDiagnostics(sourceLocal, {}, {
      generationId: generation.generationId,
    });
  }
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", status);
  writer.finalizeGeneration({
    status,
    blockReason: status === "complete" ? null : "unified_index_incomplete",
    discoveredSourceCount: empty ? 0 : 1,
    discoveredSourceBytes: empty ? 0 : 4096,
    indexedSourceCount: empty ? 0 : 1,
    indexedSourceBytes: empty ? 0 : 4096,
    discoveryComplete: status === "complete",
    diagnosticsComplete: status === "complete",
  });
  await writer.close({ fsyncPath: indexFile });
  return { root, indexFile };
}

async function createAttributionIndex({
  sources = [{ id: 1, session: 1 }],
  records,
  previous = null,
  replaceSources = true,
}) {
  const root = previous?.root
    ?? await mkdtemp(join(tmpdir(), "unified-plan-attribution-"));
  const indexFile = previous?.indexFile ?? join(root, "unified.sqlite");
  const database = openLocalUnifiedIndex(indexFile, { create: previous === null });
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
    discoveredSourceCount: sources.length,
    discoveredSourceBytes: sources.length * 4096,
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2",
    receivedAtMs: OBSERVED_MS,
    generationId: generation.generationId,
    parserVersionId: generation.parserVersionId,
    ingestRunId: generation.ingestRunId,
  });
  if (previous !== null && replaceSources) {
    for (const row of database.prepare(
      "SELECT source_local, session_local FROM source_cursor",
    ).all()) writer.deleteSourceFacts(row.source_local, row.session_local);
  }
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", "complete");
  writer.writeMeta("generated_at", "2026-08-01T13:00:00.000Z");
  writer.writeMeta("source_count", sources.length);
  writer.writeMeta("source_bytes", sources.length * 4096);
  const accountScopeId = writer.internAccountScope({
    status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
  });
  const modelId = writer.internModel("gpt-5.6-sol", "recognized");
  const tierId = writer.internTier({
    apiServiceTier: "unknown", billingSurface: "chatgpt_subscription",
    codexSpeedMode: "standard", tierSource: "unknown", providerTierRaw: null,
  });
  const surfaceId = writer.internSurface({
    agentScope: "root", surface: "cli_exec", threadSource: "user",
    lineageDisposition: "standalone",
  });
  const sourceRows = new Map(sources.map((source, sourceOrdinal) => [source.id, {
    sourceLocal: Buffer.alloc(32, source.id),
    sessionLocal: Buffer.alloc(32, source.session),
    sourceOrdinal,
  }]));
  for (const [index, record] of records.entries()) {
    const source = sourceRows.get(record.source ?? 1);
    const observedAtMs = OBSERVED_MS + (record.at ?? index * 1_000);
    const sourceOffset = record.offset ?? index + 1;
    let quotaObservationId = null;
    for (const [slotOrder, quota] of (record.quotas ?? []).entries()) {
      const window = {
        observedAtMs: OBSERVED_MS + (quota.at ?? record.at ?? index * 1_000),
        limitId: quota.limitId ?? "codex",
        slot: quota.slot ?? (slotOrder === 0 ? "primary" : "secondary"),
        planType: quota.plan ?? null,
        usedPercent: quota.percent ?? 10,
        resetsAtMs: RESET_MS,
        durationMins: quota.duration ?? 10_080,
      };
      const canonicalObservationId = writer.internQuota(window);
      quotaObservationId ??= canonicalObservationId;
      writer.writeQuotaOccurrence({
        ...source, sourceOffset, generationId: generation.generationId,
        surfaceId, canonicalObservationId, ...window, provider: "openai_codex",
        slotOrder, admission: quota.admission ?? "admitted",
      });
    }
    const eventKey = Buffer.alloc(32);
    eventKey.writeUInt32BE(index + 1, 28);
    writer.writeUsageEvent({
      eventKey, observedAtMs, generationId: generation.generationId,
      ...source, sourceOffset,
      sessionLocal: record.session === undefined
        ? source.sessionLocal : Buffer.alloc(32, record.session),
      accountScopeId, modelId, tierId, surfaceId, quotaObservationId,
      reasoningEffort: 4, outcome: 5, tierObservedAtMs: null,
      tokensInUncached: record.noUsage ? null : record.tokens ?? 1,
      tokensInCacheRead: record.noUsage ? null : 0,
      tokensInCacheWrite: record.noUsage ? null : 0,
      tokensInCacheWrite5m: null, tokensInCacheWrite1h: null,
      tokensOutText: record.noUsage ? null : 0,
      tokensOutReasoning: record.noUsage ? null : 0,
      tokensOutCombined: null, totalInputContext: null, partial: false,
    });
  }
  for (const source of sourceRows.values()) {
    writer.writeSourceCursor({
      ...source, scannedBytes: 4096, sizeBytes: 4096, mtimeMs: OBSERVED_MS,
      snapshotsPersisted: true, turnContextSeen: true, carryModel: "gpt-5.6-sol",
      carryEffort: "high", carryTierRaw: null, carryTierObservedAtMs: null,
      carryTotals: null,
    });
    writer.writeGenerationSource({
      ...source, generationId: generation.generationId, surfaceId, status: "complete",
      discoveredSizeBytes: 4096, scannedBytes: 4096, mtimeMs: OBSERVED_MS,
      diagnosticsComplete: true,
    });
    writer.writeSourceDiagnostics(source.sourceLocal, {}, {
      generationId: generation.generationId,
    });
  }
  writer.finalizeGeneration({
    status: "complete", blockReason: null,
    discoveredSourceCount: sources.length, discoveredSourceBytes: sources.length * 4096,
    indexedSourceCount: sources.length, indexedSourceBytes: sources.length * 4096,
    discoveryComplete: true, diagnosticsComplete: true,
  });
  await writer.close({ fsyncPath: indexFile });
  return { root, indexFile, generationId: generation.generationId };
}

async function scan(indexFile, options = {}) {
  const usage = [];
  const quota = [];
  const source = createLocalUnifiedAccountingSource({ indexFile, ...options });
  const result = await source({
    startAt: START_AT,
    endAt: END_AT,
    onUsage: async (row) => {
      await Promise.resolve();
      usage.push(row);
    },
    onRateLimitSnapshot: async (row) => {
      await Promise.resolve();
      quota.push(row);
    },
  });
  return { result, usage, quota };
}

test("exact occurrence plans survive canonical collisions and dual quota windows (L01/L02)", async () => {
  const fixture = await createAttributionIndex({
    sources: [{ id: 1, session: 1 }, { id: 2, session: 2 }],
    records: [
      { source: 1, at: 0, tokens: 20, quotas: [
        { plan: "pro", duration: 300 }, { plan: "pro" },
      ] },
      { source: 2, at: 0, tokens: 30, quotas: [
        { plan: "plus", duration: 300, percent: 90 }, { plan: "plus", percent: 90 },
      ] },
    ],
  });
  try {
    const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
    const before = database.prepare("SELECT * FROM usage_event ORDER BY event_key").all();
    assert.deepEqual(database.prepare(
      "SELECT DISTINCT plan_type FROM quota_observation",
    ).all().map((row) => row.plan_type), ["plus"]);
    database.close();
    const { usage, quota } = await scan(fixture.indexFile, {
      requireComplete: true, verifyPublishedGeneration: true,
    });
    assert.equal(usage.length, 2);
    assert.equal(quota.length, 4);
    assert.deepEqual(usage.map((row) => row.planAttribution), [
      { basis: "same_record", planType: "pro", planVariant: null },
      { basis: "same_record", planType: "plus", planVariant: null },
    ]);
    assert.equal(usage.reduce((sum, row) => sum + row.components.input_uncached_tokens, 0), 50);
    const unchanged = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
    assert.deepEqual(unchanged.prepare(
      "SELECT * FROM usage_event ORDER BY event_key",
    ).all(), before);
    assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 11);
    unchanged.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("admission and exact coordinates control plan association without carry-forward (L04/L05)", async () => {
  const fixture = await createAttributionIndex({ records: [
    { quotas: [{ plan: "pro" }, { plan: "pro" }] },
    { quotas: [{ plan: "plus", admission: "held" }, { plan: "pro" }] },
    { quotas: [{ plan: "pro" }, { plan: "plus" }] },
    {},
    { quotas: [{ plan: null }] },
    { quotas: [{ plan: "plus", admission: "suppressed" }] },
    { quotas: [{ plan: "pro", at: 7_000 }] },
  ] });
  try {
    const { usage, quota } = await scan(fixture.indexFile);
    assert.deepEqual(usage.map((row) => row.planAttribution), [
      { basis: "same_record", planType: "pro", planVariant: null },
      { basis: "same_record", planType: "pro", planVariant: null },
      { basis: "conflicted", planType: null, planVariant: null },
      ...Array.from({ length: 4 }, () => ({
        basis: "unavailable", planType: null, planVariant: null,
      })),
    ]);
    assert.equal(usage.length, 7);
    assert.equal(quota.length, 7);
    assert.equal(usage.reduce((sum, row) => sum + row.components.input_uncached_tokens, 0), 7);
    const database = openLocalUnifiedIndex(fixture.indexFile);
    database.prepare("UPDATE usage_event SET source_offset = NULL WHERE source_offset = 1").run();
    database.close();
    const legacy = await scan(fixture.indexFile);
    assert.equal(legacy.usage.length, 7);
    assert.deepEqual(legacy.usage[0].planAttribution, {
      basis: "unavailable", planType: null, planVariant: null,
    });
    assert.equal(legacy.usage[0].usageIntervalStartedAt, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("quota-only plan changes remain observations and bound the next usage interval (L11/L13)", async () => {
  const fixture = await createAttributionIndex({ records: [
    { at: 0, tokens: 20, quotas: [{ plan: "pro" }] },
    { at: 1_000, noUsage: true, quotas: [{ plan: "plus", percent: 0.1 }] },
    { at: 2_000, tokens: 30, quotas: [{ plan: "pro" }] },
  ] });
  try {
    const { usage, quota } = await scan(fixture.indexFile, {
      requireComplete: true, verifyPublishedGeneration: true,
    });
    assert.deepEqual(quota.map((row) => row.window.planType), ["pro", "plus", "pro"]);
    assert.deepEqual(usage.map((row) => row.components.input_uncached_tokens), [20, 30]);
    assert.deepEqual(usage.map((row) => row.planAttribution.planType), ["pro", "pro"]);
    assert.equal(usage[0].usageIntervalStartedAt, null);
    assert.equal(usage[0].usageIntervalBasis, "unavailable");
    assert.equal(usage[1].usageIntervalStartedAt, new Date(OBSERVED_MS + 1_000).toISOString());
    assert.equal(usage[1].usageIntervalBasis, "previous_session_record");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("legacy interval bounds use same-session records then source, including outside the requested range (RT08)", async () => {
  const fixture = await createAttributionIndex({
    sources: [
      { id: 1, session: 1 }, { id: 2, session: 1 },
      { id: 3, session: 3 }, { id: 4, session: 4 },
    ],
    records: [
      { source: 1, at: 0, offset: 10 },
      { source: 1, at: 2_000, offset: 20 },
      { source: 3, at: 2_500, offset: 10 },
      { source: 2, at: 3_000, offset: 10 },
      { source: 1, at: 4_000, offset: 30 },
      { source: 4, at: 5_000, offset: 10, session: 9 },
      { source: 4, at: 6_000, offset: 20, session: 9 },
    ],
  });
  try {
    const usage = [];
    await createLocalUnifiedAccountingSource({ indexFile: fixture.indexFile })({
      startAt: new Date(OBSERVED_MS + 3_000).toISOString(), endAt: END_AT,
      onUsage: (row) => usage.push(row),
    });
    assert.deepEqual(usage.map((row) => row.usageIntervalStartedAt), [
      new Date(OBSERVED_MS + 2_000).toISOString(),
      new Date(OBSERVED_MS + 3_000).toISOString(),
      null,
      new Date(OBSERVED_MS + 5_000).toISOString(),
    ]);
    assert.deepEqual(usage.map((row) => row.usageIntervalBasis), [
      "previous_session_record", "previous_session_record", "unavailable", "previous_source_record",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("interval bounds do not invent cross-source tie order or follow reversed source clocks (RT08)", async () => {
  const fixture = await createAttributionIndex({
    sources: [{ id: 1, session: 1 }, { id: 2, session: 1 }, { id: 3, session: 3 }],
    records: [
      { source: 1, at: 0, offset: 10 }, { source: 1, at: 0, offset: 20 },
      { source: 2, at: 0, offset: 10 },
      { source: 3, at: 2_000, offset: 10 }, { source: 3, at: 1_000, offset: 20 },
    ],
  });
  try {
    const { usage } = await scan(fixture.indexFile);
    assert.deepEqual(usage.map((row) => row.usageIntervalStartedAt), [
      null, new Date(OBSERVED_MS).toISOString(), null, null, null,
    ]);
    assert.deepEqual(usage.map((row) => row.usageIntervalBasis), [
      "unavailable", "previous_session_record", "unavailable", "unavailable", "unavailable",
    ]);
    const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
    const reader = createLocalUnifiedUsageAttributionReader({
      database, generationId: fixture.generationId,
    });
    const raw = database.prepare("SELECT * FROM usage_event ORDER BY event_key DESC").all();
    const first = raw.map((row) => reader.read(row));
    const second = raw.map((row) => reader.read(row));
    assert.deepEqual(second, first, "arbitrary/repeated corpus slices have identical metadata");
    database.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("copy-forward generation membership admits exact occurrences without row-generation equality (L03)", async () => {
  const records = [{ quotas: [{ plan: "pro" }] }];
  const first = await createAttributionIndex({ records });
  try {
    const next = await createAttributionIndex({
      records, previous: first, replaceSources: false,
    });
    const database = openLocalUnifiedIndex(first.indexFile, { readOnly: true });
    assert.equal(database.prepare("SELECT generation_id FROM usage_event").get().generation_id, first.generationId);
    assert.equal(database.prepare("SELECT generation_id FROM quota_occurrence").get().generation_id, next.generationId);
    database.close();
    const { usage, result } = await scan(first.indexFile, {
      requireComplete: true, verifyPublishedGeneration: true,
    });
    assert.equal(result.coverage.generationId, next.generationId);
    assert.deepEqual(usage[0].planAttribution, {
      basis: "same_record", planType: "pro", planVariant: null,
    });
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("source replacement derives fresh attribution even when source offset and event key are reused (L16)", async () => {
  const first = await createAttributionIndex({ records: [
    { quotas: [{ plan: "pro" }] },
  ] });
  try {
    assert.equal((await scan(first.indexFile)).usage[0].planAttribution.planType, "pro");
    const next = await createAttributionIndex({ previous: first, records: [
      { quotas: [{ plan: "plus" }] },
    ] });
    const { usage, result } = await scan(first.indexFile, {
      requireComplete: true, verifyPublishedGeneration: true,
    });
    assert.equal(result.coverage.generationId, next.generationId);
    assert.equal(usage.length, 1);
    assert.deepEqual(usage[0].planAttribution, {
      basis: "same_record", planType: "plus", planVariant: null,
    });
    assert.equal(usage[0].usageIntervalStartedAt, null);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("attribution reads remain deterministic across interleaved long sources and arbitrary re-reads", async (t) => {
  const sourceCount = 32;
  const recordsPerSource = 2_048;
  const sources = Array.from({ length: sourceCount }, (_, index) => ({
    id: index + 1, session: index + 1,
  }));
  const records = [];
  for (let offset = 1; offset <= recordsPerSource; offset += 1) {
    for (const source of sources) {
      records.push({
        source: source.id,
        offset,
        at: offset * 1_000 + source.id,
        quotas: [{ plan: source.id % 2 === 0 ? "pro" : "plus" }],
      });
    }
  }
  const fixture = await createAttributionIndex({ sources, records });
  const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
  try {
    database.exec("BEGIN");
    const before = readUnifiedIndexGenerationDescriptor(database);
    const inputRows = database.prepare(`
      SELECT source_local, source_ordinal, source_offset, session_local, observed_at_ms
      FROM usage_event ORDER BY observed_at_ms, source_ordinal, source_offset
    `).all();
    const costs = { predecessorQueries: 0, predecessorRows: 0 };
    const queryPlans = new Map();
    const reader = createLocalUnifiedUsageAttributionReader({
      generationId: fixture.generationId,
      database: {
        prepare(sql) {
          const statement = database.prepare(sql);
          if (!sql.includes("FROM usage_event p")) return statement;
          return {
            get(...parameters) {
              if (!queryPlans.has(sql)) {
                queryPlans.set(sql, database.prepare(`EXPLAIN QUERY PLAN ${sql}`)
                  .all(...parameters).map((row) => row.detail).join("\n"));
              }
              costs.predecessorQueries += 1;
              const row = statement.get(...parameters);
              costs.predecessorRows += row === undefined ? 0 : 1;
              return row;
            },
            all(...parameters) {
              costs.predecessorQueries += 1;
              const rows = statement.all(...parameters);
              costs.predecessorRows += rows.length;
              return rows;
            },
          };
        },
      },
    });
    const startedAt = performance.now();
    let checkedRows = 0;
    const check = (row) => {
      checkedRows += 1;
      const result = reader.read(row);
      assert.equal(result.planAttribution.basis, "same_record");
      assert.equal(result.planAttribution.planType, row.source_local[0] % 2 === 0 ? "pro" : "plus");
      assert.equal(result.usageIntervalStartedAt, row.source_offset === 1
        ? null : new Date(row.observed_at_ms - 1_000).toISOString());
    };
    for (const row of inputRows) check(row);
    // Go backwards across page boundaries, then revisit the newest source.
    for (let index = inputRows.length - 1; index >= 0; index -= 137) check(inputRows[index]);
    check(inputRows.at(-1));
    t.diagnostic(JSON.stringify({
      sources: sourceCount,
      usageRows: inputRows.length,
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      ...costs,
    }));
    assert.ok(costs.predecessorQueries <= checkedRows * 2,
      "interleaving cannot trigger prefetch/rescans on bounded-cache eviction");
    assert.ok(costs.predecessorRows <= checkedRows,
      "single-source sessions should materialize only their exact source predecessor");
    assert.equal(queryPlans.size, 2);
    const plans = [...queryPlans.values()].join("\n");
    assert.match(plans, /usage_event_source_predecessor/u);
    assert.match(plans, /usage_event_session_predecessor/u);
    assert.doesNotMatch(plans, /USE TEMP B-TREE/u,
      "ordered predecessor seeks must not sort an entire source/session per usage");
    assert.deepEqual(readUnifiedIndexGenerationDescriptor(database), before);
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 11);
    database.exec("ROLLBACK");
  } finally {
    database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("canonicalInstant's shape fast path agrees with the Date round trip on every input class", () => {
  const roundTrip = (value) => {
    if (typeof value !== "string") return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
        && new Date(timestamp).toISOString() === value
      ? value
      : null;
  };
  const pad = (number, width) => String(number).padStart(width, "0");
  const inputs = [];
  // The whole calendar field grid, including every out-of-range neighbour.
  for (const year of [0, 1, 4, 100, 400, 1900, 1970, 2000, 2024, 2026, 2100, 9999]) {
    for (let month = 0; month <= 13; month += 1) {
      for (let day = 0; day <= 32; day += 1) {
        inputs.push(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T12:34:56.789Z`);
      }
    }
  }
  for (const [hour, minute, second] of [
    [0, 0, 0], [23, 59, 59], [24, 0, 0], [23, 60, 0], [23, 59, 60],
    [25, 0, 0], [99, 99, 99], [12, 0, 60], [0, 60, 0],
  ]) {
    inputs.push(`2026-06-15T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.000Z`);
  }
  inputs.push(
    "2026-06-15T12:00:00Z", "2026-06-15T12:00:00.00Z", "2026-06-15T12:00:00.0000Z",
    "2026-06-15 12:00:00.000Z", "2026-06-15T12:00:00.000+00:00", "2026-06-15T12:00:00.000z",
    "+002026-06-15T12:00:00.000Z", "+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z",
    "-000000-01-01T00:00:00.000Z", "275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z",
    "+275760-09-13T00:00:00.001Z", "-271821-04-20T00:00:00.000Z", "-271821-04-19T23:59:59.999Z",
    "２０２６-06-15T12:00:00.000Z", "2026-06-15T12:00:00.000Z\n", " 2026-06-15T12:00:00.000Z",
    "", "Z", null, undefined, 5, {}, [], true,
  );
  // Random instants across the whole Date range (4-digit and expanded years)
  // plus single-character corruptions of canonical strings.
  let seed = 0x2545f491;
  const next = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed;
  };
  const randomMs = () => Math.floor((next() / 2 ** 32) * 2 * 8.64e15) - 8.64e15;
  for (let index = 0; index < 20_000; index += 1) {
    inputs.push(new Date(randomMs()).toISOString());
  }
  for (let index = 0; index < 5_000; index += 1) {
    const canonical = new Date(Math.floor((next() / 2 ** 32) * 8.64e15) - 4.32e15).toISOString();
    const position = next() % canonical.length;
    const replacement = String.fromCharCode(48 + (next() % 10));
    inputs.push(`${canonical.slice(0, position)}${replacement}${canonical.slice(position + 1)}`);
  }
  let checked = 0;
  for (const input of inputs) {
    assert.equal(canonicalInstant(input), roundTrip(input), JSON.stringify(input));
    checked += 1;
  }
  assert.ok(checked > 30_000);
});

test("the one-pass attribution precomputation reproduces every point-query read exactly", async (t) => {
  // Scenarios that exercise each branch of the reader: same-record and
  // conflicting plans, unknown plans, a session spanning two sources with
  // interleaved and tied timestamps, a reversed source clock, offsets past a
  // member's scanned bytes, a source dropped from the generation, and gaps
  // in the offset sequence.
  const scenarios = [
    {
      name: "two sources sharing a session with ties and reversed clocks",
      sources: [{ id: 1, session: 9 }, { id: 2, session: 9 }, { id: 3, session: 3 }],
      records: [
        { source: 1, offset: 1, at: 0, quotas: [{ plan: "pro" }] },
        { source: 2, offset: 1, at: 500, quotas: [{ plan: "pro" }] },
        { source: 1, offset: 2, at: 1_000, quotas: [{ plan: "pro" }] },
        { source: 2, offset: 2, at: 1_000, quotas: [{ plan: "plus" }] },
        { source: 1, offset: 3, at: 900 },
        { source: 2, offset: 3, at: 1_500, quotas: [{ plan: "pro" }, { plan: "plus" }] },
        { source: 3, offset: 1, at: 2_000, quotas: [{ plan: "pro" }] },
        { source: 3, offset: 2, at: 2_000, quotas: [{ plan: "unknown" }] },
        { source: 3, offset: 4, at: 1_900 },
        { source: 1, offset: 4, at: 3_000, quotas: [{ plan: "pro", admission: "held" }] },
        { source: 2, offset: 4, at: 3_000, noUsage: true },
        { source: 2, offset: 5, at: 3_100 },
        // Records whose session is not the source's own session: no session
        // lineage, so only the source predecessor can bound the interval.
        { source: 1, offset: 5, at: 4_000, session: 5, quotas: [{ plan: "pro" }] },
        { source: 1, offset: 6, at: 4_100, session: 5 },
        { source: 1, offset: 7, at: 4_050, session: 5 },
      ],
    },
    {
      name: "membership boundaries",
      sources: [{ id: 1, session: 1 }, { id: 2, session: 2 }],
      records: Array.from({ length: 40 }, (_, index) => ({
        source: (index % 2) + 1,
        offset: 100 + index * 100,
        at: index * 1_000,
        quotas: index % 5 === 0 ? [] : [{ plan: index % 3 === 0 ? "plus" : "pro" }],
      })),
      mutate(database, generationId) {
        // Source 2 is only partially scanned in this generation, so offsets
        // past the boundary are unattributable and cannot be predecessors.
        database.prepare(`
          UPDATE generation_source SET scanned_bytes = 2_500
          WHERE generation_id = ? AND source_local = ?`).run(generationId, Buffer.alloc(32, 2));
      },
    },
    {
      name: "a source dropped from the generation",
      sources: [{ id: 1, session: 1 }, { id: 2, session: 1 }],
      records: Array.from({ length: 12 }, (_, index) => ({
        source: (index % 2) + 1,
        offset: index + 1,
        at: index * 700,
        quotas: [{ plan: "pro" }],
      })),
      mutate(database, generationId) {
        database.prepare(`
          UPDATE generation_source SET status = 'failed'
          WHERE generation_id = ? AND source_local = ?`).run(generationId, Buffer.alloc(32, 2));
      },
    },
  ];
  for (const scenario of scenarios) {
    const fixture = await createAttributionIndex({
      sources: scenario.sources,
      records: scenario.records,
    });
    const database = openLocalUnifiedIndex(fixture.indexFile);
    try {
      scenario.mutate?.(database, fixture.generationId);
      const rows = database.prepare(`
        SELECT rowid AS row_id, source_local, source_offset, source_ordinal,
               session_local, observed_at_ms
        FROM usage_event ORDER BY observed_at_ms, source_ordinal, source_offset`).all();
      const live = createLocalUnifiedUsageAttributionReader({
        database, generationId: fixture.generationId,
      });
      const precomputed = await precomputeLocalUnifiedUsageAttribution({
        database, generationId: fixture.generationId,
        maximumRetainedBytes: 1024 * 1024,
      });
      const batch = createLocalUnifiedUsageAttributionReader({
        database, generationId: fixture.generationId, precomputed,
      });
      const bases = new Set();
      for (const row of rows) {
        assert.equal(precomputed.has(row.row_id), true, scenario.name);
        const expected = live.read(row);
        assert.deepEqual(batch.read(row), expected, `${scenario.name}: rowid ${row.row_id}`);
        bases.add(`${expected.planAttribution.basis}/${expected.usageIntervalBasis}`);
      }
      // A rowid the pass never saw is served by the point queries, unchanged.
      assert.deepEqual(
        batch.read({ ...rows[0], row_id: rows.at(-1).row_id + 1_000 }),
        live.read(rows[0]),
      );
      t.diagnostic(`${scenario.name}: ${rows.length} rows, outcomes ${[...bases].sort().join(" ")}`);
      assert.ok(rows.length >= 12, scenario.name);
    } finally {
      database.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("attribution precomputation sizes live rows, not sparse rescan rowids, and falls back exactly", async () => {
  let fixture = await createAttributionIndex({ records: Array.from({ length: 12 }, (_, index) => ({
    quotas: [{ plan: index % 2 === 0 ? "pro" : "plus" }],
  })) });
  try {
    for (let rescan = 0; rescan < 2; rescan += 1) {
      if (rescan > 0) fixture = await createAttributionIndex({
        previous: fixture,
        records: Array.from({ length: 12 }, () => ({ quotas: [{ plan: "plus" }] })),
      });
      const database = openLocalUnifiedIndex(fixture.indexFile);
      try {
        // Persisted IDs can grow independently of the live row count after
        // deletion/reinsertion. These IDs would require terabyte arrays if
        // MAX(rowid) were still used as the allocation length.
        database.prepare("UPDATE usage_event SET rowid = rowid + ?").run(2 ** 40 + rescan * 10_000);
        const rows = database.prepare("SELECT rowid AS row_id, * FROM usage_event ORDER BY rowid").all();
        const reference = createLocalUnifiedUsageAttributionReader({ database, generationId: fixture.generationId });
        const expected = rows.map((row) => reference.read(row));
        const allocationReservations = [];
        const precomputed = await precomputeLocalUnifiedUsageAttribution({
          database, generationId: fixture.generationId, maximumRetainedBytes: 4096,
          checkRuntimeMemory: (bytes) => { if (bytes > 0) allocationReservations.push(bytes); },
        });
        assert.equal(precomputed.retainedRows, 12);
        assert.ok(precomputed.retainedBytes <= 4096);
        assert.equal(allocationReservations[0], 12 * 32);
        const optimized = createLocalUnifiedUsageAttributionReader({ database, generationId: fixture.generationId, precomputed });
        assert.deepEqual(rows.map((row) => optimized.read(row)), expected);
        if (rescan > 0) assert.ok(expected.every((row) => row.planAttribution.planType === "plus"));
        for (const absent of [0, 2 ** 40, rows.at(-1).row_id + 1, Number.MAX_SAFE_INTEGER]) {
          assert.equal(precomputed.has(absent), false);
        }
        // Too little space for the typed columns, or for their plan dictionary,
        // simply declines the optimization; the old reader stays authoritative.
        for (const maximumRetainedBytes of [12 * 32 - 1, 12 * 32]) {
          const declined = await precomputeLocalUnifiedUsageAttribution({
            database, generationId: fixture.generationId, maximumRetainedBytes,
          });
          assert.equal(declined, null);
          const fallback = createLocalUnifiedUsageAttributionReader({ database, generationId: fixture.generationId, precomputed: declined });
          assert.deepEqual(rows.map((row) => fallback.read(row)), expected);
        }
      } finally {
        database.close();
      }
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("precompute checks allocation headroom before allocating and yields in every whole-table walk", async (t) => {
  const rowCount = 6000;
  const fixture = await createAttributionIndex({
    sources: [{ id: 1, session: 1 }, { id: 2, session: 1 }],
    records: Array.from({ length: rowCount }, (_, index) => ({
      source: index % 2 + 1, offset: Math.floor(index / 2) + 1,
    })),
  });
  const database = openLocalUnifiedIndex(fixture.indexFile, { readOnly: true });
  const observe = (onRow) => {
    let rowidPass = 0;
    return {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          get: (...args) => statement.get(...args),
          *iterate(...args) {
            const phase = sql.includes("ORDER BY rowid")
              ? (++rowidPass === 1 ? "count" : "rowids")
              : sql.includes("ORDER BY session_local") ? "sessions" : "predecessors";
            let rows = 0;
            for (const row of statement.iterate(...args)) {
              onRow(phase, ++rows);
              yield row;
            }
          },
        };
      },
    };
  };
  try {
    let rowsRead = 0;
    let reservedBytes = 0;
    const allocationError = Object.assign(new Error("accounting_transition_memory_budget_exceeded"), {
      code: "accounting_transition_memory_budget_exceeded",
    });
    await assert.rejects(precomputeLocalUnifiedUsageAttribution({
      database: observe(() => { rowsRead += 1; }), generationId: fixture.generationId,
      maximumRetainedBytes: 1024 * 1024,
      checkRuntimeMemory: (additionalBytes) => {
        if (additionalBytes > 0) { reservedBytes = additionalBytes; throw allocationError; }
      },
    }), (error) => error === allocationError);
    assert.equal(reservedBytes, rowCount * 32);
    assert.equal(rowsRead, rowCount, "only the non-allocating count walk may precede reservation");

    for (const target of ["count", "rowids", "predecessors", "sessions"]) {
      for (const stop of ["abort", "rss"]) await t.test(`${target}: ${stop}`, async () => {
        const controller = new AbortController();
        let reached = 0;
        let active = null;
        const guardedDatabase = observe((phase, rows) => {
          active = phase;
          if (phase !== target) return;
          reached = rows;
          if (rows === 10 && stop === "abort") setImmediate(() => controller.abort());
        });
        const rssError = Object.assign(new Error("accounting_transition_rss_limit_exceeded"), {
          code: "accounting_transition_rss_limit_exceeded",
        });
        await assert.rejects(precomputeLocalUnifiedUsageAttribution({
          database: guardedDatabase, generationId: fixture.generationId,
          maximumRetainedBytes: 1024 * 1024, signal: controller.signal,
          checkRuntimeMemory: () => {
            if (stop === "rss" && active === target && reached >= 10) throw rssError;
          },
        }), (error) => stop === "rss" ? error === rssError
          : error.name === "AbortError" && error.code === "local_unified_index_read_aborted");
        assert.ok(reached >= 10 && reached <= 2058, `${target} read ${reached} rows before stopping`);
        assert.ok(reached < rowCount);
      });
    }
  } finally {
    database.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an indexed-history consumer receives the covered range in the same read, proven per window", async () => {
  const fixture = await createAttributionIndex({
    sources: [{ id: 1, session: 1 }],
    records: Array.from({ length: 12 }, (_, index) => ({
      offset: index + 1,
      at: index * 1_000,
      tokens: index === 5 ? 0 : 1,
      quotas: [{ plan: "pro" }],
    })),
  });
  try {
    const source = createLocalUnifiedAccountingSource({
      indexFile: fixture.indexFile,
      requireComplete: true,
    });
    const windowStartMs = OBSERVED_MS + 7_000;
    const request = () => {
      const windowed = [];
      const history = [];
      const quota = [];
      return {
        windowed,
        history,
        quota,
        options: {
          startAt: new Date(windowStartMs).toISOString(),
          endAt: END_AT,
          onUsage: (row) => windowed.push(row),
          onRateLimitSnapshot: (row) => quota.push(row),
          indexedHistory: { onUsage: (row) => history.push(row) },
        },
      };
    };
    const fused = request();
    const result = await source(fused.options);
    assert.equal(result.indexedHistory.status, "available");
    assert.equal(result.indexedHistory.errorCode, null);
    assert.equal(result.indexedHistory.coverage.generationId, result.coverage.generationId);
    assert.deepEqual(result.indexedHistory.coverage.coveredAt, result.coverage.coveredAt);
    assert.deepEqual(result.indexedHistory.capabilities, result.capabilities);
    // The window saw only its own rows; history saw every usage row of the
    // covered range (the zero-token record is not a usage row for either).
    assert.deepEqual(fused.windowed.map((row) => row.sourceOffset), [8, 9, 10, 11, 12]);
    assert.deepEqual(fused.history.map((row) => row.sourceOffset), [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12]);
    // Quota rows are delivered for the window only.
    assert.deepEqual(fused.quota.map((row) => row.sourceOffset), [8, 9, 10, 11, 12]);
    // A row inside both windows is one object, delivered to both consumers
    // with the windowed consumer's attribution; history-only rows carry none.
    assert.equal(fused.history[6], fused.windowed[0]);
    assert.ok(Object.hasOwn(fused.windowed[0], "planAttribution"));
    assert.equal(Object.hasOwn(fused.history[0], "planAttribution"), false);
    assert.equal(fused.history[0].model, "gpt-5.6-sol");
    // Sequence numbers are unique across everything delivered.
    const sequences = [...fused.windowed, ...fused.history, ...fused.quota].map((row) => row.sequence);
    assert.equal(new Set(sequences).size, 5 + 6 + 5);

    // The same rows, read separately, are byte-for-byte what the fused read
    // delivered (attribution keys aside, which history never receives).
    const separate = [];
    const separateResult = await source({
      startAt: result.coverage.coveredAt.startAt,
      endAt: result.coverage.coveredAt.endAt,
      usageAttribution: "none",
      onUsage: (row) => separate.push(row),
    });
    const strip = ({ sequence, planAttribution, usageIntervalStartedAt, usageIntervalBasis, ...rest }) => rest;
    assert.deepEqual(fused.history.map(strip), separate.map(strip));
    assert.deepEqual(separateResult.coverage, result.indexedHistory.coverage);

    // A covered-range proof failure leaves the window's read intact and is
    // reported with the code a separate read of that range throws.
    const database = openLocalUnifiedIndex(fixture.indexFile);
    database.prepare(`
      UPDATE usage_event SET source_offset = NULL
      WHERE observed_at_ms = ?`).run(OBSERVED_MS + 1_000);
    database.close();
    const degraded = request();
    const degradedResult = await source(degraded.options);
    assert.equal(degradedResult.coverage.status, "complete");
    assert.deepEqual(degraded.windowed.map((row) => row.sourceOffset), [8, 9, 10, 11, 12]);
    assert.deepEqual(degraded.history, []);
    assert.equal(degradedResult.indexedHistory.status, "unavailable");
    assert.equal(
      degradedResult.indexedHistory.errorCode,
      "local_unified_index_accounting_coverage_incomplete",
    );
    await assert.rejects(
      source({
        startAt: result.coverage.coveredAt.startAt,
        endAt: result.coverage.coveredAt.endAt,
        onUsage: () => {},
      }),
      (error) => error.code === "local_unified_index_accounting_coverage_incomplete",
    );
    for (const indexedHistory of [null, "history", [], {}, { onUsage: 1 }]) {
      await assert.rejects(
        source({ startAt: START_AT, endAt: END_AT, indexedHistory }),
        (error) => error.code === "local_unified_index_read_request_invalid",
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the current unified index maps deterministically without mutating SQLite", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const before = await stat(indexFile);
    const { result, usage, quota } = await scan(indexFile);
    const after = await stat(indexFile);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(result.readerVersion, LOCAL_UNIFIED_ACCOUNTING_SOURCE_VERSION);
    assert.equal(result.schemaVersion, "local-unified-index-v2");
    assert.equal(result.parserVersion, LOCAL_UNIFIED_INDEX_PARSER_VERSION);
    assert.equal(result.contractVersion, "usage-event-v0.2");
    assert.deepEqual(result.compatibility.contractVersions, ["usage-event-v0.2"]);
    assert.equal(result.coverage.status, "complete");
    assert.equal(result.coverage.indexStatus, "complete");
    assert.equal(result.coverage.blockReason, null);
    assert.equal(result.coverage.usageProvenanceAttested, true);
    assert.equal(result.coverage.sourceOrderAttested, true);
    assert.equal(result.coverage.quotaProvenanceAttested, true);
    assert.equal(result.coverage.toolProvenanceAttested, true);
    assert.equal(result.coverage.toolFactsComplete, true);
    assert.equal(result.coverage.toolFacts, 0);
    assert.match(
      result.coverage.toolFactFingerprint,
      /^tool-facts-v1-[a-f0-9]{64}$/u,
    );
    assert.deepEqual(result.capabilities, {
      readsRawSources: false,
      deterministicCanonicalOrder: true,
      sourceOrderingProvenance: true,
      sourceOffsetProvenance: true,
      sourceScopedQuotaOccurrences: true,
      durableDiagnostics: true,
      crashSafeGenerationPublication: true,
    });
    assert.equal(result.diagnosticsAvailable, true);
    assert.deepEqual(usage.map((row) => row.components.input_uncached_tokens), [10, 20]);
    assert.deepEqual(usage.map((row) => row.sequence), [0, 1]);
    assert.equal(Object.hasOwn(usage[0], "totalInputContextTokens"), false);
    assert.equal(usage[0].model, "gpt-5.6-sol");
    assert.deepEqual(usage[0].tierSemantics, {
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "fast",
      apiServiceTier: "unknown",
      tierSource: "rollout_thread_settings",
      tierObservedAt: "2026-08-01T11:59:59.000Z",
    });
    assert.deepEqual(usage[0].surfaceClassification, {
      surface: "cli_exec",
      threadSource: "user",
      agentScope: "root",
      lineageDisposition: "standalone",
    });
    assert.equal(quota.length, 1);
    assert.equal(quota[0].sequence, 2);
    assert.deepEqual(quota[0].window, {
      provider: "openai_codex",
      planType: "unknown",
      limitId: "codex",
      slot: "primary",
      usedPercent: 12.5,
      windowDurationMins: 10_080,
      resetsAt: RESET_MS / 1_000,
    });
    assert.equal(quota[0].surfaceClassification.surface, "cli_exec");
    assert.equal(quota[0].sourceRecordOrdinal, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context behavior is explicit and expected generations are bound", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const native = await scan(indexFile, { contextBehavior: "source_native" });
    assert.equal(Object.hasOwn(native.usage[0], "totalInputContextTokens"), false);
    const legacy = await scan(indexFile, { contextBehavior: "legacy_zero" });
    assert.equal(legacy.usage[0].totalInputContextTokens, 0);
    assert.equal(native.result.coverage.generationId > 0, true);
    assert.equal(
      native.result.coverage.generationFingerprint.startsWith("generation-v2-"),
      true,
    );
    const bound = await scan(indexFile, {
      expectedGeneration: {
        id: native.result.coverage.generationId,
        fingerprint: native.result.coverage.generationFingerprint,
      },
    });
    assert.equal(bound.result.coverage.generationId, native.result.coverage.generationId);
    await assert.rejects(
      createLocalUnifiedAccountingSource({
        indexFile,
        expectedGeneration: native.result.coverage.generationId + 1,
      })({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code === "local_unified_index_generation_mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation fingerprints are canonical and metadata overrides must agree", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const baseline = await scan(indexFile);
    const canonical = baseline.result.coverage.generationFingerprint;
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run("current_generation_fingerprint", canonical);
    database.close();
    const accepted = await scan(indexFile);
    assert.equal(accepted.result.coverage.generationFingerprint, canonical);

    const wrong = `generation-v2-${"0".repeat(64)}`;
    const tampered = openLocalUnifiedIndex(indexFile);
    tampered.prepare(`
      UPDATE meta SET value = ? WHERE key = 'current_generation_fingerprint'
    `).run(wrong);
    tampered.close();
    await assert.rejects(
      scan(indexFile),
      (error) => error.code === "local_unified_index_generation_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy nullable provenance is partial even when generation status is complete", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(
      "UPDATE usage_event SET source_offset = NULL WHERE source_offset = 1",
    ).run();
    database.close();
    const result = await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(result.coverage.status, "partial");
    assert.equal(result.coverage.blockReason, "legacy_nullable_rows");
    assert.equal(result.capabilities.sourceOffsetProvenance, false);
    await assert.rejects(
      createLocalUnifiedAccountingSource({
        indexFile,
        requireComplete: true,
      })({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code
        === "local_unified_index_accounting_coverage_incomplete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict metadata validation rejects missing or stale required fields", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare("DELETE FROM meta WHERE key = ?").run("contract_version");
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_meta_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const stale = await createIndex();
  try {
    const database = openLocalUnifiedIndex(stale.indexFile);
    database.prepare(
      `UPDATE index_generation
       SET usage_events = usage_events + 1
       WHERE id = (SELECT value FROM meta WHERE key = 'current_generation_id')`,
    ).run();
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({
        indexFile: stale.indexFile,
        requireComplete: true,
        verifyPublishedGeneration: true,
      })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code
        === "local_unified_index_accounting_coverage_incomplete",
    );
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }
});

test("mixed parser rows are reported without pretending to have one parser", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(
      "INSERT INTO parser_version(parser_version, contract_version) VALUES (?, ?)",
    ).run("unified-rollout-typed-v2", "usage-event-v0.2");
    const parserVersionId = database.prepare(
      `SELECT id FROM parser_version
       WHERE parser_version = 'unified-rollout-typed-v2'`,
    ).get().id;
    database.prepare(
      `UPDATE usage_event SET parser_version_id = ?
       WHERE rowid = (SELECT MIN(rowid) FROM usage_event)`,
    ).run(parserVersionId);
    database.close();
    const result = await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
    });
    assert.equal(result.parserVersion, null);
    assert.equal(result.compatibility.status, "mixed_parser_versions");
    assert.deepEqual(result.compatibility.parserVersions, [
      LOCAL_UNIFIED_INDEX_PARSER_VERSION,
      "unified-rollout-typed-v2",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("callback errors stay fixed and content-free, and sequence counts callbacks only", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const callbackError = Object.assign(
      new Error("PRIVATE_CALLBACK_CANARY"),
      { code: "accounting_private_callback" },
    );
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: () => {
          throw callbackError;
        },
      }),
      (error) => error.code === "local_unified_index_callback_failed"
        && !error.message.includes("PRIVATE_CALLBACK_CANARY"),
    );

    for (const abortError of [
      Object.assign(new Error("PRIVATE_ABORT_CANARY"), { name: "AbortError" }),
      Object.assign(new Error("PRIVATE_ABORT_CODE_CANARY"), { code: "ABORT_ERR" }),
    ]) {
      await assert.rejects(
        createLocalUnifiedAccountingSource({ indexFile })({
          startAt: START_AT,
          endAt: END_AT,
          onUsage: () => {
            throw abortError;
          },
        }),
        (error) => error.name === "AbortError"
          && error.code === "local_unified_index_read_aborted"
          && !error.message.includes("PRIVATE_ABORT"),
      );
    }

    const resourceError = Object.assign(
      new Error("PRIVATE_RESOURCE_CANARY"),
      { code: "accounting_scan_rss_limit_exceeded" },
    );
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: () => {
          throw resourceError;
        },
      }),
      (error) => error.code === "accounting_scan_rss_limit_exceeded"
        && !error.message.includes("PRIVATE_RESOURCE_CANARY"),
    );

    for (const code of [
      "accounting_refresh_aborted",
      "accounting_transition_rss_measurement_invalid",
      "accounting_archive_rss_measurement_invalid",
    ]) {
      await assert.rejects(
        createLocalUnifiedAccountingSource({ indexFile })({
          startAt: START_AT,
          endAt: END_AT,
          onUsage: () => {
            throw Object.assign(new Error("PRIVATE_FIXED_CODE_CANARY"), {
              code,
            });
          },
        }),
        (error) => error.code === code
          && !error.message.includes("PRIVATE_FIXED_CODE_CANARY"),
      );
    }

    const quota = [];
    await createLocalUnifiedAccountingSource({ indexFile })({
      startAt: START_AT,
      endAt: END_AT,
      onRateLimitSnapshot: (row) => quota.push(row),
    });
    assert.equal(quota[0].sequence, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage attribution is derived only for consumers that declare they read it", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const source = createLocalUnifiedAccountingSource({ indexFile });
    const collect = async (request) => {
      const usage = [];
      await source({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: (row) => usage.push(row),
        ...request,
      });
      return usage;
    };
    const attributionKeys = [
      "planAttribution",
      "usageIntervalStartedAt",
      "usageIntervalBasis",
    ];
    for (const request of [{}, { usageAttribution: "required" }]) {
      const usage = await collect(request);
      assert.equal(usage.length, 2);
      for (const row of usage) {
        for (const key of attributionKeys) assert.ok(Object.hasOwn(row, key), key);
      }
    }
    const aggregate = await collect({ usageAttribution: "none" });
    assert.equal(aggregate.length, 2);
    for (const row of aggregate) {
      for (const key of attributionKeys) {
        assert.equal(Object.hasOwn(row, key), false, key);
      }
      // Everything an aggregate consumer reads is still there, unchanged.
      assert.equal(row.model, "gpt-5.6-sol");
      assert.equal(typeof row.timestamp, "string");
      assert.equal(row.sourceOrdinal, 0);
    }
    assert.deepEqual(
      aggregate.map((row) => row.components.input_uncached_tokens),
      [10, 20],
    );
    for (const usageAttribution of ["all", "", null, 1, true]) {
      await assert.rejects(
        source({ startAt: START_AT, endAt: END_AT, usageAttribution }),
        (error) => error.code === "local_unified_index_read_request_invalid",
        String(usageAttribution),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abort signalled from a macrotask stops the read within one yield cadence", async () => {
  const rowCount = 6_000;
  const fixture = await createAttributionIndex({
    records: Array.from({ length: rowCount }, (_, index) => ({
      at: index * 1_000,
      tokens: 1,
    })),
  });
  try {
    const controller = new AbortController();
    let delivered = 0;
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: fixture.indexFile })({
        startAt: START_AT,
        endAt: new Date(OBSERVED_MS + rowCount * 1_000).toISOString(),
        signal: controller.signal,
        usageAttribution: "none",
        onUsage: () => {
          delivered += 1;
          // Arm the abort from the event loop's check phase, exactly the way
          // a signal handler or the parent's watchdog would reach the loop.
          if (delivered === 1) setImmediate(() => controller.abort());
        },
      }),
      (error) => error.name === "AbortError"
        && error.code === "local_unified_index_read_aborted",
    );
    // Synchronous consumers are delivered without a promise per row, so the
    // only place a macrotask can run is the loop's periodic cooperative
    // yield. The abort must land there, not after the whole stream.
    assert.ok(delivered >= 2, `expected delivery to begin, saw ${delivered}`);
    assert.ok(delivered <= 2_049, `abort waited for ${delivered} rows`);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("orphaned dimensions and null quota percentages fail closed", async () => {
  const orphan = await createIndex();
  try {
    const database = openLocalUnifiedIndex(orphan.indexFile);
    database.prepare("UPDATE model SET model_id = ?").run("invalid model");
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: orphan.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid",
    );
  } finally {
    await rm(orphan.root, { recursive: true, force: true });
  }

  const nullQuota = await createIndex();
  try {
    const database = openLocalUnifiedIndex(nullQuota.indexFile);
    database.prepare("UPDATE quota_occurrence SET resets_at_ms = NULL").run();
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: nullQuota.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid",
    );
  } finally {
    await rm(nullQuota.root, { recursive: true, force: true });
  }
});

test("tampered short event keys fail the fixed row boundary", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare(`
      UPDATE usage_event
      SET event_key = ?
      WHERE rowid = (SELECT MIN(rowid) FROM usage_event)
    `).run(Buffer.alloc(1, 9));
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("complete index status cannot overstate current accounting coverage", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare("UPDATE usage_event SET source_local = NULL").run();
    database.close();
    const source = createLocalUnifiedAccountingSource({
      indexFile,
      requireComplete: true,
    });
    await assert.rejects(
      source({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code
        === "local_unified_index_accounting_coverage_incomplete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full integrity rejects duplicate source ordinals and orphan quota observations", async () => {
  const duplicate = await createIndex();
  try {
    const database = openLocalUnifiedIndex(duplicate.indexFile);
    const generationId = Number(database.prepare(
      "SELECT value FROM meta WHERE key = 'current_generation_id'",
    ).get().value);
    const surfaceId = database.prepare(
      "SELECT surface_id FROM generation_source LIMIT 1",
    ).get().surface_id;
    database.prepare(`
      INSERT INTO generation_source(
        generation_id, source_local, source_ordinal, session_local, surface_id,
        status, discovered_size_bytes, scanned_bytes, mtime_ms,
        diagnostics_complete
      ) VALUES (?, ?, ?, ?, ?, 'complete', ?, ?, ?, 1)
    `).run(
      generationId,
      Buffer.alloc(32, 8),
      0,
      Buffer.alloc(32, 9),
      surfaceId,
      4096,
      4096,
      OBSERVED_MS,
    );
    database.prepare(`
      UPDATE index_generation
      SET indexed_source_count = 2, indexed_source_bytes = 8192
      WHERE id = ?
    `).run(generationId);
    database.close();

    const result = await scan(duplicate.indexFile, {
      verifyPublishedGeneration: true,
    });
    assert.equal(result.result.coverage.generationProof, false);
    assert.equal(result.result.coverage.provenanceComplete, false);
    assert.equal(result.result.capabilities.deterministicCanonicalOrder, false);
  } finally {
    await rm(duplicate.root, { recursive: true, force: true });
  }

  const orphan = await createIndex();
  try {
    const database = openLocalUnifiedIndex(orphan.indexFile);
    const generationId = Number(database.prepare(
      "SELECT value FROM meta WHERE key = 'current_generation_id'",
    ).get().value);
    database.prepare("DELETE FROM quota_occurrence").run();
    database.prepare(`
      UPDATE index_generation SET quota_occurrences = 0 WHERE id = ?
    `).run(generationId);
    database.close();

    const result = await scan(orphan.indexFile, {
      verifyPublishedGeneration: true,
    });
    assert.equal(result.result.coverage.generationProof, false);
    assert.equal(result.result.coverage.quotaOccurrencesComplete, false);
    assert.equal(result.result.capabilities.sourceScopedQuotaOccurrences, false);
  } finally {
    await rm(orphan.root, { recursive: true, force: true });
  }
});

test("empty and source-partial indexes remain honest readable characterizations", async () => {
  for (const fixture of [
    { status: "complete", empty: true, expectedReason: null },
    { status: "partial", empty: false, expectedReason: "unified_index_incomplete" },
  ]) {
    const { root, indexFile } = await createIndex(fixture);
    try {
      const { result, usage } = await scan(indexFile);
      assert.equal(
        result.coverage.status,
        fixture.status === "complete" ? "complete" : "partial",
      );
      assert.equal(result.coverage.indexStatus, fixture.status);
      assert.equal(result.coverage.blockReason, fixture.expectedReason);
      if (fixture.empty) assert.deepEqual(usage, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing, insecure, and incompatible files fail with fixed errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-accounting-source-bad-"));
  try {
    const missing = createLocalUnifiedAccountingSource({
      indexFile: join(root, "missing.sqlite"),
    });
    await assert.rejects(
      missing({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code === "local_unified_index_missing",
    );
    const incompatibleFile = join(root, "incompatible.sqlite");
    await writeFile(incompatibleFile, "PRIVATE_UNIFIED_SOURCE_CANARY", { mode: 0o600 });
    const incompatible = createLocalUnifiedAccountingSource({
      indexFile: incompatibleFile,
    });
    await assert.rejects(
      incompatible({ startAt: START_AT, endAt: END_AT }),
      (error) => (
        error.code === "local_unified_index_schema_invalid"
        || error.code === "local_unified_index_unavailable"
      ) && !error.message.includes("PRIVATE_UNIFIED_SOURCE_CANARY"),
    );
    await chmod(incompatibleFile, 0o644);
    await assert.rejects(
      incompatible({ startAt: START_AT, endAt: END_AT }),
      (error) => error.code === "local_unified_index_file_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requests and aborts fail before publishing partial callback output", async () => {
  const { root, indexFile } = await createIndex();
  try {
    const source = createLocalUnifiedAccountingSource({ indexFile });
    await assert.rejects(
      source({ startAt: "2026-08-01T00:00:00Z", endAt: END_AT }),
      (error) => error.code === "local_unified_index_read_request_invalid",
    );
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      source({
        startAt: START_AT,
        endAt: END_AT,
        signal: preAborted.signal,
      }),
      (error) => error.name === "AbortError"
        && error.code === "local_unified_index_read_aborted",
    );
    const midAbort = new AbortController();
    const seen = [];
    await assert.rejects(
      source({
        startAt: START_AT,
        endAt: END_AT,
        signal: midAbort.signal,
        onUsage: (row) => {
          seen.push(row);
          midAbort.abort();
        },
      }),
      (error) => error.name === "AbortError"
        && error.code === "local_unified_index_read_aborted",
    );
    assert.equal(seen.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("published path identity is revalidated after callbacks", async () => {
  const original = await createIndex();
  const replacement = await createIndex();
  try {
    let swapped = false;
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile: original.indexFile })({
        startAt: START_AT,
        endAt: END_AT,
        onUsage: async () => {
          if (swapped) return;
          swapped = true;
          await rename(original.indexFile, `${original.indexFile}.old`);
          await rename(replacement.indexFile, original.indexFile);
        },
      }),
      (error) => error.code === "local_unified_index_file_changed",
    );
    assert.equal(swapped, true);
  } finally {
    await rm(original.root, { recursive: true, force: true });
    await rm(replacement.root, { recursive: true, force: true });
  }
});

test("malformed stored scalars fail content-free and the module has no raw-log boundary", async () => {
  const { root, indexFile } = await createIndex();
  const privateCanary = "/private/rollout/PRIVATE_UNIFIED_SOURCE_CANARY.jsonl";
  try {
    const database = openLocalUnifiedIndex(indexFile);
    database.prepare("UPDATE model SET model_id = ?").run(privateCanary);
    database.close();
    await assert.rejects(
      createLocalUnifiedAccountingSource({ indexFile })({
        startAt: START_AT,
        endAt: END_AT,
      }),
      (error) => error.code === "local_unified_index_row_invalid"
        && !error.message.includes(privateCanary),
    );
    const source = await readFile(
      new URL("../src/local-unified-accounting-source.js", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "codex-log-scan",
      "discoverCodexRolloutInfos",
      "rollout-line-reader",
      "local-analysis-index",
    ]) assert.equal(source.includes(forbidden), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
