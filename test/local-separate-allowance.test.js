import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addUsdStrings } from "@app-usagemonitor/accounting";
import {
  addUsageToPeriod,
  finalizeUsagePeriod,
  newUsagePeriod,
  usageProjection,
} from "../src/local-companion-usage-model.js";
import { readLocalCollectorProjection } from "../src/local-collector-projection.js";
import {
  commitLocalCollectorState,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import { readLocalUnifiedCompanionProjection } from "../src/local-unified-companion-source.js";
import {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";
import { readLocalUnifiedWindowBreakdown } from "../src/local-unified-window-breakdown.js";
import {
  assertReplaySafeAccountingCache,
  buildReplaySafeAccountingCache,
  createAccountingPricer,
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";

const CUTOFF = Date.parse("2026-10-06T00:00:00.000Z");
const NOW = CUTOFF + 60 * 60_000;

function usageRecord({
  observedAt = new Date(CUTOFF).toISOString(),
  model = "codex-auto-review",
  threadSource = "auto_review",
  eventKey = "usage-0",
} = {}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_rollout_usage_snapshot",
    observedAt,
    eventKey,
    model,
    totalInputContextTokens: 1_200,
    components: {
      input_uncached_tokens: 1_000,
      input_cache_read_tokens: 200,
      input_cache_write_tokens: 0,
      output_text_tokens: 10,
      output_reasoning_tokens: 0,
      output_combined_tokens: 0,
    },
    tierSemantics: { codexSpeedMode: "standard", apiServiceTier: "unknown" },
    surfaceClassification: {
      surface: "cli_exec",
      ...(threadSource === null ? {} : { threadSource }),
      agentScope: "root",
      lineageDisposition: "standalone",
    },
    accountScope: { status: "unavailable" },
  };
}

function mixedUsage() {
  return [
    { delta: -1 },
    { delta: 0 },
    { delta: 1 },
    { delta: 2, threadSource: "user" },
    { delta: 3, threadSource: null },
    { delta: 4, model: "gpt-5.4" },
    { delta: 5, threadSource: "subagent" },
    { delta: 6, model: "gpt-5.3-codex-spark", threadSource: "user" },
  ].map(({ delta, ...options }, index) => usageRecord({
    ...options,
    observedAt: new Date(CUTOFF + delta).toISOString(),
    eventKey: `usage-${index}`,
  }));
}

function quotaRows() {
  return [-15, 15, 30].map((minutes, index) => ({
    observedAtMs: CUTOFF + minutes * 60_000,
    usedPercent: 10 + index,
    resetsAtMs: CUTOFF + 7 * 24 * 60 * 60_000,
  }));
}

function scanRecords(records, quota = []) {
  return async ({ onUsage, onRateLimitSnapshot }) => {
    for (const { observedAt, ...record } of records) {
      onUsage({ ...record, timestamp: observedAt });
    }
    for (const row of quota) {
      onRateLimitSnapshot({
        timestamp: new Date(row.observedAtMs).toISOString(),
        timestampMs: row.observedAtMs,
        window: {
          provider: "openai_codex",
          limitId: row.limitId ?? "codex",
          slot: "secondary",
          planType: "pro",
          windowDurationMins: 10_080,
          resetsAt: row.resetsAtMs / 1_000,
          usedPercent: row.usedPercent,
        },
      });
    }
    return { diagnostics: {} };
  };
}

async function writeIndex(indexFile, records, quota = []) {
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "separate-allowance-test-v1",
  });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable", reason: null, planType: null, scopeLocal: null,
  });
  const tierId = writer.internTier({
    apiServiceTier: "unknown", billingSurface: "unknown",
    codexSpeedMode: "standard", tierSource: "unknown", providerTierRaw: null,
  });
  for (const record of records) {
    const components = record.components;
    writer.writeUsageEvent({
      eventKey: Buffer.from(record.eventKey),
      observedAtMs: Date.parse(record.observedAt),
      sessionLocal: Buffer.alloc(32, 3),
      accountScopeId,
      modelId: writer.internModel(record.model, "recognized"),
      tierId,
      surfaceId: writer.internSurface({
        ...record.surfaceClassification,
        threadSource: record.surfaceClassification.threadSource ?? "unknown",
      }),
      reasoningEffort: 8,
      outcome: 5,
      totalInputContext: record.totalInputContextTokens,
      tokensInUncached: components.input_uncached_tokens,
      tokensInCacheRead: components.input_cache_read_tokens,
      tokensInCacheWrite: components.input_cache_write_tokens,
      tokensOutText: components.output_text_tokens,
      tokensOutReasoning: components.output_reasoning_tokens,
      tokensOutCombined: components.output_combined_tokens,
    });
  }
  for (const row of quota) {
    writer.internQuota({
      ...row,
      limitId: row.limitId ?? "codex", slot: "secondary", planType: "pro", durationMins: 10_080,
    });
  }
  await writer.close({ integrityCheck: true, fsyncPath: indexFile });
}

function periodState(period) {
  const modelRows = period.modelUsage.map((row) => ({
    model: row.model,
    allowanceTrack: row.allowanceTrack,
    apiPriceEquivalentApplicable: row.apiPriceEquivalentApplicable,
    events: row.events,
    totalTokens: row.totalTokens,
    components: row.components,
    componentCosts: row.componentCosts,
    apiPriceEquivalentUsd: row.apiPriceEquivalentUsd,
  }));
  return {
    events: period.events,
    totalTokens: period.totalTokens,
    apiPriceEquivalentUsd: period.apiPriceEquivalentUsd,
    apiPriceEquivalentUsdExact: period.apiPriceEquivalentUsdExact,
    priceCardIds: period.priceCardIds,
    priceCardBreakdown: period.priceCardBreakdown,
    separate: {
      label: period.spark.label,
      events: period.spark.events,
      totalTokens: period.spark.totalTokens,
      apiPriceEquivalentUsd: period.spark.apiPriceEquivalentUsd,
      apiPriceEquivalentUsdExact: period.spark.apiPriceEquivalentUsdExact,
      priceCardIds: period.spark.priceCardIds,
      priceCardBreakdown: period.spark.priceCardBreakdown,
    },
    modelRows,
  };
}

test("allowance projections use source metadata and the UTC instant without changing API pricing", () => {
  for (const pricer of [null, createAccountingPricer()]) {
    for (const [observedAt, expected] of [
      ["2026-10-05T23:59:59.999Z", "primary"],
      ["2026-10-06T00:00:00.000Z", "separate"],
      ["2026-10-06T00:00:00.001Z", "separate"],
      ["2026-10-05T19:59:59.999-04:00", "primary"],
      ["2026-10-05T20:00:00.000-04:00", "separate"],
      ["2026-10-06T02:00:00.000+02:00", "separate"],
      ["invalid", "primary"],
    ]) {
      const review = usageProjection(usageRecord({ observedAt }), "unknown", pricer);
      const ordinary = usageProjection(usageRecord({ observedAt, threadSource: "user" }), "unknown", pricer);
      assert.equal(review.modelAllowanceTrack, expected);
      assert.equal(review.modelApiPriceEquivalentApplicable, expected === "primary");
      assert.equal(review.isSeparateAllowance, expected !== "primary");
      assert.equal(review.isSpark, false);
      for (const key of [
        "components", "totalTokens", "apiPriceEquivalentUsd", "apiPriceEquivalentUsdExact",
        "priceCardIds", "priceCardBreakdown", "pricedComponents", "pricingCoverageStatus",
      ]) assert.deepEqual(review[key], ordinary[key], key);
    }
    for (const threadSource of [null, "user", "subagent", "auto-review"]) {
      assert.equal(usageProjection(usageRecord({ threadSource }), "unknown", pricer).modelAllowanceTrack, "primary");
    }
    assert.equal(usageProjection(usageRecord({ model: "gpt-5.4" }), "unknown", pricer).modelAllowanceTrack, "separate");
    const spark = usageProjection(usageRecord({ model: "gpt-5.3-codex-spark" }), "unknown", pricer);
    assert.equal(spark.modelAllowanceTrack, "spark");
    assert.equal(spark.isSpark, true);
    assert.equal(spark.isSeparateAllowance, true);
    assert.equal(spark.modelApiPriceEquivalentApplicable, false);
  }
});

test("mixed dates preserve distinct model rows and conserve all tokens, exact quotes, and price cards", async () => {
  const records = mixedUsage();
  const period = newUsagePeriod("all", "All");
  for (const record of records) addUsageToPeriod(period, usageProjection(record));
  const projected = finalizeUsagePeriod(period);
  const cache = await buildReplaySafeAccountingCache({ now: () => NOW, scan: scanRecords(records) });
  const replayed = cache.periods.find((row) => row.id === "all");
  assert.deepEqual(periodState(replayed), periodState(projected));
  assert.equal(projected.events, 4);
  assert.equal(projected.spark.events, 4);
  assert.equal(projected.spark.label, "Separate allowance");
  assert.deepEqual(projected.modelUsage.filter((row) => row.model === "codex-auto-review")
    .map((row) => [row.allowanceTrack, row.events]).sort(), [["primary", 4], ["separate", 2]]);
  assert.equal(projected.totalTokens + projected.spark.totalTokens, 8 * 1_210);
  const quoted = records.map((record) => usageProjection(record));
  const totalExact = quoted.reduce((total, row) => addUsdStrings(total, row.apiPriceEquivalentUsdExact ?? "0"), "0");
  assert.equal(addUsdStrings(replayed.apiPriceEquivalentUsdExact, replayed.spark.apiPriceEquivalentUsdExact), totalExact);
  assert.ok(replayed.spark.apiPriceEquivalentUsd > 0, "separate usage retains the raw nonzero API quote");
  assert.deepEqual(replayed.spark.priceCardIds, replayed.priceCardIds);
  assert.equal(cache.timeline.reduce((total, row) => total + row.usageEvents, 0), 4);
  assert.equal(cache.sparkUsageTimeline.reduce((total, row) => total + row.usageEvents, 0), 1);
  assert.deepEqual(cache.sparkQuotaTimeline, []);
  assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));
  const root = await mkdtemp(join(tmpdir(), "separate-allowance-cache-"));
  try {
    const stateFile = join(root, "state.sqlite");
    await writeLocalCollectorAccountingCache({ stateFile, cache });
    const restored = await readReplaySafeAccountingCache({ stateFile, now: () => NOW });
    assert.equal(restored.status, "available");
    assert.deepEqual(restored.cache, cache);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector, unified companion, and window readbacks agree on separate source events", async () => {
  const root = await mkdtemp(join(tmpdir(), "separate-allowance-readbacks-"));
  try {
    const records = mixedUsage();
    const stateFile = join(root, "collector.sqlite");
    const indexFile = join(root, "index.sqlite");
    await commitLocalCollectorState({ stateFile, checkpoint: {}, records, clock: () => NOW });
    await writeIndex(indexFile, records);
    const collector = await readLocalCollectorProjection(stateFile, NOW);
    const unified = await readLocalUnifiedCompanionProjection({ indexFile, nowMs: NOW });
    assert.equal(collector.status, "available");
    assert.equal(unified.status, "available");
    const collectorPeriod = collector.usage.find((row) => row.id === "all");
    const unifiedPeriod = unified.usage.find((row) => row.id === "all");
    assert.deepEqual(periodState(unifiedPeriod), periodState(collectorPeriod));
    assert.equal(unifiedPeriod.events, 4);
    assert.equal(unifiedPeriod.spark.events, 4);
    for (const projection of [collector, unified]) {
      assert.equal(projection.timeline.usage.reduce((total, row) => total + row.usageEvents, 0), 4);
      assert.equal(projection.timeline.sparkUsage.reduce((total, row) => total + row.usageEvents, 0), 1);
      assert.deepEqual(projection.timeline.sparkQuota, []);
    }
    const window = await readLocalUnifiedWindowBreakdown({ indexFile, fromMs: CUTOFF - 1, toMs: NOW });
    assert.equal(window.status, "available");
    assert.equal(window.events, 4);
    assert.equal(window.costUsd, unifiedPeriod.apiPriceEquivalentUsd);
    assert.equal(window.spark.events, 4);
    assert.equal(window.spark.costUsd, unifiedPeriod.spark.apiPriceEquivalentUsd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streamed calibration filters source metadata in discovery and priced rereads", async () => {
  const root = await mkdtemp(join(tmpdir(), "separate-allowance-calibration-"));
  try {
    const records = mixedUsage();
    const quota = quotaRows();
    const indexFile = join(root, "index.sqlite");
    await writeIndex(indexFile, records, quota);
    let metrics;
    const streamed = await buildReplaySafeAccountingCache({
      now: () => NOW, unifiedIndexFile: indexFile, scan: scanRecords(records, quota),
      onCalibrationCorpusMetrics: (value) => { metrics = value; },
    });
    const primary = records.filter((record) => !usageProjection(record).isSeparateAllowance);
    const oracle = await buildReplaySafeAccountingCache({ now: () => NOW, scan: scanRecords(primary, quota) });
    const windowed = await buildReplaySafeAccountingCache({ now: () => NOW, scan: scanRecords(records, quota) });
    assert.equal(streamed.weeklyCalibrationInput.source, "unified_index");
    assert.equal(streamed.weeklyCalibrationInput.retainedUsageEvents, 4);
    assert.equal(metrics.retainedUsageEvents, 4);
    assert.ok(metrics.projectedRows >= 4, "the priced reread consumed the primary rows");
    assert.ok(streamed.weeklyCalibration.sourceCounts.weeklyTransitions > 0);
    assert.deepEqual(streamed.weeklyCalibration, oracle.weeklyCalibration);
    assert.deepEqual(windowed.weeklyCalibration, oracle.weeklyCalibration);
    assert.deepEqual(streamed.allowanceCapacityByScenario, oracle.allowanceCapacityByScenario);
    assert.deepEqual(streamed.fiveHourAllowanceCalibration, oracle.fiveHourAllowanceCalibration);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a history containing only separate allowance usage remains readable with empty primary calibration", async () => {
  const root = await mkdtemp(join(tmpdir(), "separate-allowance-only-"));
  try {
    const records = [usageRecord()];
    const indexFile = join(root, "index.sqlite");
    await writeIndex(indexFile, records, quotaRows());
    const cache = await buildReplaySafeAccountingCache({
      now: () => NOW, unifiedIndexFile: indexFile, scan: scanRecords(records, quotaRows()),
    });
    assert.equal(cache.weeklyCalibrationInput.source, "unified_index");
    assert.equal(cache.weeklyCalibrationInput.retainedUsageEvents, 0);
    assert.equal(cache.weeklyCalibration.status, "insufficient_evidence");
    const period = cache.periods.find((row) => row.id === "all");
    assert.equal(period.events, 0);
    assert.equal(period.spark.events, 1);
    assert.equal(period.modelUsage[0].allowanceTrack, "separate");
    assert.deepEqual(cache.timeline, []);
    assert.deepEqual(cache.sparkUsageTimeline, []);
    assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("a prior primary-priced cache refreshes to separate allowance once and preserves its exact quote", async () => {
  const root = await mkdtemp(join(tmpdir(), "separate-allowance-upgrade-"));
  try {
    const stateFile = join(root, "state.sqlite");
    const record = usageRecord();
    const previouslyUnclassified = {
      ...record,
      surfaceClassification: { ...record.surfaceClassification, threadSource: "unknown" },
    };
    const prior = await buildReplaySafeAccountingCache({
      now: () => NOW, scan: scanRecords([previouslyUnclassified]),
    });
    prior.schemaVersion = "local-replay-safe-accounting-v0.18";
    const priorPeriod = prior.periods.find((row) => row.id === "all");
    assert.equal(priorPeriod.events, 1);
    assert.equal(priorPeriod.spark.events, 0);
    await writeLocalCollectorAccountingCache({ stateFile, cache: prior });

    const outdated = await readReplaySafeAccountingCache({ stateFile, now: () => NOW });
    assert.equal(outdated.status, "unavailable");
    assert.equal(outdated.errorCode, "cache_accounting_semantics_outdated");
    assert.equal(outdated.cache, null, "the old allowance result is never current evidence");
    assert.equal(outdated.staleCache.schemaVersion, prior.schemaVersion);
    assert.deepEqual(outdated.staleCache.cache, prior, "the prior artifact remains explicitly stale until replacement");

    const options = { stateFile, now: () => NOW, scan: scanRecords([record]) };
    const rebuilt = await refreshReplaySafeAccountingCache(options);
    const period = rebuilt.periods.find((row) => row.id === "all");
    assert.equal(period.events, 0);
    assert.equal(period.apiPriceEquivalentUsd, 0);
    assert.equal(period.spark.events, 1);
    assert.equal(period.spark.totalTokens, priorPeriod.totalTokens);
    assert.deepEqual(period.spark.components, priorPeriod.components);
    assert.deepEqual(period.spark.componentCosts, priorPeriod.componentCosts);
    assert.equal(period.spark.apiPriceEquivalentUsdExact, priorPeriod.apiPriceEquivalentUsdExact);
    assert.deepEqual(period.spark.priceCardBreakdown, priorPeriod.priceCardBreakdown);
    assert.equal(period.modelUsage[0].allowanceTrack, "separate");
    assert.deepEqual(rebuilt.sparkUsageTimeline, [], "auto-review never enters Spark's measured series");

    const reread = await readReplaySafeAccountingCache({ stateFile, now: () => NOW });
    assert.equal(reread.status, "available");
    assert.equal(Object.hasOwn(reread, "staleCache"), false);
    assert.deepEqual(reread.cache, rebuilt);
    assert.deepEqual(await refreshReplaySafeAccountingCache(options), rebuilt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("auto-review changes separate totals without changing observed Spark usage or quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "separate-allowance-spark-isolation-"));
  try {
    const spark = usageRecord({
      model: "gpt-5.3-codex-spark", threadSource: "user", eventKey: "spark-usage",
    });
    const review = usageRecord({ eventKey: "review-usage" });
    const quota = quotaRows().map((row) => ({ ...row, limitId: "codex_bengalfox" }));
    const onlySpark = await buildReplaySafeAccountingCache({
      now: () => NOW, scan: scanRecords([spark], quota),
    });
    const mixed = await buildReplaySafeAccountingCache({
      now: () => NOW, scan: scanRecords([spark, review], quota),
    });
    assert.ok(onlySpark.sparkQuotaTimeline.length > 0);
    assert.ok(onlySpark.sparkUsageTimeline.length > 0);
    assert.deepEqual(mixed.sparkQuotaTimeline, onlySpark.sparkQuotaTimeline);
    assert.deepEqual(mixed.sparkUsageTimeline, onlySpark.sparkUsageTimeline);
    assert.equal(mixed.periods.find((row) => row.id === "all").spark.events, 2);

    const indexFile = join(root, "index.sqlite");
    await writeIndex(indexFile, [spark, review], quota);
    const unified = await readLocalUnifiedCompanionProjection({ indexFile, nowMs: NOW });
    assert.equal(unified.status, "available");
    assert.equal(unified.usage.find((row) => row.id === "all").spark.events, 2);
    assert.equal(unified.timeline.sparkUsage.reduce((count, row) => count + row.usageEvents, 0), 1);
    assert.deepEqual(unified.timeline.sparkQuota.map((row) => [row.limitId, row.usedPercent]),
      onlySpark.sparkQuotaTimeline.map((row) => [row.limitId, row.usedPercent]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
