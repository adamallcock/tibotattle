import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY,
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  assertReplaySafeAccountingCache,
  buildReplaySafeAccountingCache,
  buildReplaySafeAccountingPeriod,
  fitCompositionFromCompactCorpus,
  readReplaySafeAccountingCache as readReplaySafeAccountingCacheImpl,
  refreshReplaySafeAccountingCache as refreshReplaySafeAccountingCacheImpl,
} from "../src/replay-safe-accounting-cache.js";
import {
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import {
  beginUnifiedIndexGeneration,
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";
import {
  blendedCompositionCapacityUsd,
  buildCompositionObservations,
  buildRollingQuotaComparisons,
  calibrateCompositionCapacities,
} from "@app-usagemonitor/quota-analysis";

// The previous JSON paths are test-fixture names only. The wrappers prove the
// same cache contracts against SQLite without allowing production callers to
// use the retired cacheFile option.
function refreshReplaySafeAccountingCache({ cacheFile, ...options } = {}) {
  return refreshReplaySafeAccountingCacheImpl({
    ...options,
    ...(cacheFile === undefined ? {} : { stateFile: cacheFile }),
  });
}

function readReplaySafeAccountingCache({ cacheFile, ...options } = {}) {
  return readReplaySafeAccountingCacheImpl({
    ...options,
    ...(cacheFile === undefined ? {} : { stateFile: cacheFile }),
  });
}

async function writeTestCache(stateFile, cache) {
  await writeLocalCollectorAccountingCache({ stateFile, cache });
}

async function readTestCache(stateFile) {
  return (await readLocalCollectorAccountingCache({ stateFile })).cache;
}

test("production replay-cache APIs reject the retired JSON cacheFile option", async () => {
  await assert.rejects(
    refreshReplaySafeAccountingCacheImpl({ cacheFile: "/private/retired.json" }),
    /cacheFile was retired; use stateFile/u,
  );
  await assert.rejects(
    readReplaySafeAccountingCacheImpl({ cacheFile: "/private/retired.json" }),
    /cacheFile was retired; use stateFile/u,
  );
});

test("a direct cache build without a scanner or explicit source mode fails closed", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCache({ now: () => NOW }),
    (error) => error?.code === "accounting_source_required",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      scan: completeUnifiedScanner([]),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_required",
  );
  await assert.rejects(
    readReplaySafeAccountingCacheImpl({
      stateFile: "/private/unbound-unified-cache.sqlite",
      sourceMode: "unified",
    }),
    (error) => error?.code === "accounting_unified_generation_required",
  );
});

test("refresh defaults to the unified reader without consulting the legacy index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-unified-default-"));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  const legacyIndexFile = join(directory, "local-analysis-index-v2.sqlite");
  await assert.rejects(
    refreshReplaySafeAccountingCacheImpl({
      stateFile,
      codexHome: directory,
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_required",
  );
  await assert.rejects(
    stat(legacyIndexFile),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(
    refreshReplaySafeAccountingCacheImpl({
      stateFile,
      codexHome: directory,
      expectedGeneration: "generation-test-1",
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_index_missing",
  );
  await assert.rejects(
    stat(legacyIndexFile),
    (error) => error?.code === "ENOENT",
  );
});

test("explicit legacy refresh keeps the injected characterization scanner on legacy authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-legacy-mode-"));
  const cache = await refreshReplaySafeAccountingCacheImpl({
    stateFile: join(directory, "local-collector-state-v1.sqlite"),
    sourceMode: "legacy",
    scan: scanner([]),
    now: () => NOW,
  });
  assert.equal(cache.sourceDescriptor.mode, "legacy");
  assert.equal(cache.sourceDescriptor.contextBehavior, "legacy_zero");
  assert.equal(cache.history.status, "unavailable");
});

test("unified builds reject incomplete coverage and generation mismatches", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      scan: completeUnifiedScanner([], { coverageStatus: "partial" }),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_coverage_incomplete",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-2",
      scan: completeUnifiedScanner([]),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_mismatch",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: {
        id: "generation-test-1",
        fingerprint: "generation-fingerprint-expected",
      },
      scan: completeUnifiedScanner([], {
        generationFingerprint: "generation-fingerprint-observed",
      }),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_mismatch",
  );
});

test("numeric-like object generation ids normalize without changing fingerprints", async () => {
  const cache = await buildReplaySafeAccountingCache({
    sourceMode: "unified",
    expectedGeneration: {
      id: "1.0",
      fingerprint: "generation-fingerprint-test-1",
    },
    scan: completeUnifiedScanner([], { generation: 1 }),
    now: () => NOW,
  });
  assert.equal(cache.sourceDescriptor.generation, "1");
  assert.equal(
    cache.sourceDescriptor.generationFingerprint,
    "generation-fingerprint-test-1",
  );

  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: {
        id: "1.0",
        fingerprint: "1.0",
      },
      scan: completeUnifiedScanner([], {
        generation: 1,
        generationFingerprint: "1",
      }),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_mismatch",
  );
});

test("unified cache history is attached only after a matching second generation read", async () => {
  const scan = completeUnifiedScanner([
    usageEvent({
      timestamp: "2026-07-27T11:00:00.000Z",
      components: { input_uncached_tokens: 1_000 },
    }),
  ]);
  const cache = await buildReplaySafeAccountingCache({
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    scan,
    now: () => NOW,
  });
  assert.equal(scan.calls, 2);
  assert.equal(cache.sourceDescriptor.mode, "unified");
  assert.equal(cache.sourceDescriptor.generation, "generation-test-1");
  assert.equal(cache.history.status, "available");
  assert.equal(cache.history.coverage.status, "complete");
  assert.equal(cache.history.generation, "generation-test-1");
  assert.equal(
    cache.history.generationFingerprint,
    "generation-fingerprint-test-1",
  );
  assert.equal(
    cache.history.coverage.generationFingerprint,
    "generation-fingerprint-test-1",
  );
  assert.equal(cache.history.period.id, "history");
  assert.equal(cache.history.period.events, 1);
});

test("cache reads invalidate when the unified generation no longer matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-generation-reuse-"));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  const scan = completeUnifiedScanner([]);
  await refreshReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    scan,
    now: () => NOW,
  });
  const available = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    contextBehavior: "legacy_zero",
  });
  assert.equal(available.status, "available");
  assert.deepEqual(available.cache.sourceDescriptor, {
    schemaVersion: "local-accounting-source-descriptor-v1",
    mode: "unified",
    contextBehavior: "legacy_zero",
    readerVersion: "test-unified-reader-v1",
    schemaVersionUsed: "test-unified-schema-v1",
    parserVersion: "test-parser-v1",
    contractVersion: "test-contract-v1",
    generation: "generation-test-1",
    generationFingerprint: "generation-fingerprint-test-1",
    coverageStatus: "complete",
    coverage: {
      status: "complete",
      generatedAt: "2026-07-27T12:00:00.000Z",
      coveredAt: {
        startAt: "2026-07-20T12:00:00.000Z",
        endAt: "2026-07-27T12:00:00.000Z",
      },
      sourceCount: null,
      sourceBytes: null,
      usageEvents: null,
      quotaObservations: null,
      quotaOccurrences: null,
      admittedQuotaOccurrences: null,
      generationProof: true,
    },
    diagnosticsAvailable: true,
    generationMatched: true,
    fallbackCount: 0,
    capabilities: {
      readsRawSources: false,
      deterministicCanonicalOrder: true,
      sourceOrderingProvenance: true,
      sourceOffsetProvenance: true,
      sourceScopedQuotaOccurrences: true,
      durableDiagnostics: true,
      crashSafeGenerationPublication: true,
    },
  });
  const contextInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    contextBehavior: "source_native",
  });
  assert.deepEqual(contextInvalidated, {
    status: "unavailable",
    errorCode: "cache_context_behavior_mismatch",
    cache: null,
  });
  const invalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-2",
    contextBehavior: "legacy_zero",
  });
  assert.deepEqual(invalidated, {
    status: "unavailable",
    errorCode: "cache_generation_mismatch",
    cache: null,
  });

  const fingerprintScan = completeUnifiedScanner([], {
    generationFingerprint: "generation-fingerprint-current",
  });
  await refreshReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-current",
    },
    scan: fingerprintScan,
    now: () => NOW,
  });
  const fingerprintInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-stale",
    },
    contextBehavior: "legacy_zero",
  });
  assert.deepEqual(fingerprintInvalidated, {
    status: "unavailable",
    errorCode: "cache_generation_mismatch",
    cache: null,
  });

  const tampered = await readTestCache(stateFile);
  tampered.sourceDescriptor.fallbackCount = 1;
  await writeTestCache(stateFile, tampered);
  const fallbackInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-current",
    },
  });
  assert.deepEqual(fallbackInvalidated, {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
  tampered.sourceDescriptor.fallbackCount = 0;
  tampered.history.generationFingerprint = "generation-fingerprint-tampered";
  await writeTestCache(stateFile, tampered);
  const historyInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-current",
    },
    contextBehavior: "legacy_zero",
  });
  assert.deepEqual(historyInvalidated, {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
});

test("unified reader errors map to closed content-free accounting codes", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        const error = new Error("private path and row contents");
        error.code = "local_unified_index_row_invalid";
        throw error;
      },
    }),
    (error) => (
      error?.code === "accounting_unified_index_invalid"
      && error?.message === "accounting_unified_index_invalid"
    ),
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        throw new Error("private path and row contents");
      },
    }),
    (error) => (
      error?.code === "accounting_unified_read_failed"
      && error?.message === "accounting_unified_read_failed"
    ),
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        const error = new Error("private path and row contents");
        error.code = "accounting_private_internal_detail";
        throw error;
      },
    }),
    (error) => (
      error?.code === "accounting_unified_read_failed"
      && error?.message === "accounting_unified_read_failed"
    ),
  );
});

test("known Spark and reviewed aliases stay diagnosable without folding into normal totals", async () => {
  const cache = await buildReplaySafeAccountingCache({
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:00:00.000Z",
        model: "gpt-5.3-codex-spark",
        components: { input_uncached_tokens: 71_829 },
      }),
      usageEvent({
        timestamp: "2026-07-27T11:05:00.000Z",
        model: "private-unknown-model",
        components: { input_uncached_tokens: 10 },
      }),
      usageEvent({
        timestamp: "2026-07-27T11:10:00.000Z",
        model: "gpt-5.5-codex",
        components: { input_uncached_tokens: 10 },
      }),
    ]),
    now: () => NOW,
  });

  const normal = period(cache, "7d");
  const rows = normal.byModel;
  const spark = normal.spark;
  const unknown = rows.find((row) => row.model === "unknown");
  const alias = rows.find((row) => row.model === "gpt-5.5-codex");
  const sparkRow = spark.byModel.find((row) => row.model === "gpt-5.3-codex-spark");
  assert.equal(normal.events, 2);
  assert.equal(normal.spark.events, 1);
  assert.equal(rows.some((row) => row.model === "gpt-5.3-codex-spark"), false);
  assert.equal(sparkRow.pricingStatus, "known_unpriced");
  assert.equal(spark.apiPriceEquivalentUsd, 0);
  assert.equal(spark.pricingCoverage.unpricedEvents, 1);
  assert.equal(unknown.pricingStatus, "unrecognized");
  assert.equal(unknown.apiPriceEquivalentUsd, 0);
  assert.equal(unknown.pricingCoverage.unpricedEvents, 1);
  assert.equal(alias.pricingStatus, "priced");
  assert.equal(alias.apiPriceEquivalentUsd, 0.00005);
});

test("period coverage retains recognized OpenAI history before the review date", async () => {
  const cache = await buildReplaySafeAccountingCache({
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000 },
      }),
      usageEvent({
        timestamp: "2026-07-19T11:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000 },
      }),
    ]),
    now: () => NOW,
  });

  const recent = period(cache, "7d");
  const longer = period(cache, "30d");
  assert.deepEqual(recent.pricingCoverage, {
    fullyPricedEvents: 1,
    partiallyPricedEvents: 0,
    unpricedEvents: 0,
  });
  assert.equal(longer.pricingCoverage.fullyPricedEvents, 2);
  assert.equal(longer.pricingCoverage.unpricedEvents, 0);
  assert.equal(
    100 * recent.pricingCoverage.fullyPricedEvents / recent.events,
    100,
  );
  assert.equal(
    100 * longer.pricingCoverage.fullyPricedEvents / longer.events,
    100,
  );
});

test("indexed history prices each event at its own effective date before and after repricing", async () => {
  const result = await buildReplaySafeAccountingPeriod({
    startAt: "1970-01-01T00:00:00.000Z",
    endAt: "2026-08-01T12:00:00.000Z",
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-25T23:59:59.999Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
      usageEvent({
        timestamp: "2026-07-29T23:59:59.999Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
      usageEvent({
        timestamp: "2026-07-30T00:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });

  assert.equal(result.priceEpochBasis, "event_time_when_registry_has_effective_evidence");
  assert.deepEqual(result.period.pricingCoverage, {
    fullyPricedEvents: 3,
    partiallyPricedEvents: 0,
    unpricedEvents: 0,
  });
  assert.deepEqual(result.period.priceCardBreakdown.map((row) => ({
    priceCardId: row.priceCardId,
    events: row.events,
    costUsd: row.costUsd,
  })), [
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-01",
      events: 1,
      costUsd: "2",
    },
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-01",
      events: 2,
      costUsd: "5",
    },
  ]);
  assert.equal(result.period.apiPriceEquivalentUsd, 7);
});

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const COMPONENT_KEYS = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
];

function usageEvent({
  timestamp,
  model = "gpt-5.6-sol",
  components,
  speed = "standard",
  apiServiceTier = "unknown",
  surface = "extension_or_ide",
  agentScope = "root",
  lineageDisposition = "standalone",
}) {
  return {
    timestamp,
    model,
    totalInputContextTokens: 1_000,
    components: Object.fromEntries(
      COMPONENT_KEYS.map((key) => [key, components[key] ?? 0]),
    ),
    componentAvailability: Object.fromEntries(
      COMPONENT_KEYS.map((key) => [key, true]),
    ),
    tierSemantics: {
      codexSpeedMode: speed,
      apiServiceTier,
    },
    surfaceClassification: {
      surface,
      agentScope,
      lineageDisposition,
    },
  };
}

function scanner(events, diagnostics = {}) {
  return async (options) => {
    for (const event of events) options.onUsage(event);
    return {
      diagnostics: {
        filesScanned: 9,
        forkReplayEventsSkipped: 21,
        unattributedForkReplayEventsSkipped: 3,
        duplicateSnapshotsSkipped: 4,
        lineageParentsMissing: 2,
        ...diagnostics,
      },
    };
  };
}

function completeUnifiedScanner(
  events = [],
  {
    generation = "generation-test-1",
    generationFingerprint = "generation-fingerprint-test-1",
    startAt = "2026-07-20T12:00:00.000Z",
    endAt = "2026-07-27T12:00:00.000Z",
    coverageStatus = "complete",
    generationProof = true,
  } = {},
) {
  let calls = 0;
  const scan = async (options) => {
    calls += 1;
    for (const event of events) {
      await options.onUsage?.(event);
    }
    return {
      readerVersion: "test-unified-reader-v1",
      schemaVersion: "test-unified-schema-v1",
      parserVersion: "test-parser-v1",
      contractVersion: "test-contract-v1",
      generation,
      generationFingerprint,
      coverage: {
        status: coverageStatus,
        generationProof,
        generatedAt: endAt,
        coveredAt: { startAt, endAt },
      },
      diagnosticsAvailable: true,
      capabilities: {
        readsRawSources: false,
        deterministicCanonicalOrder: true,
        sourceOrderingProvenance: true,
        sourceOffsetProvenance: true,
        sourceScopedQuotaOccurrences: true,
        durableDiagnostics: true,
        crashSafeGenerationPublication: true,
      },
      diagnostics: {},
    };
  };
  Object.defineProperty(scan, "calls", {
    enumerable: true,
    get: () => calls,
  });
  return scan;
}

function weeklySnapshot({
  timestamp,
  usedPercent,
  provider = "openai_codex",
  planType = "pro",
  limitId = "codex",
  slot = "primary",
  durationMinutes = 10_080,
  resetsAt = Math.floor(
    Date.parse("2026-08-03T12:00:00.000Z") / 1_000,
  ),
}) {
  return {
    timestamp,
    timestampMs: Date.parse(timestamp),
    window: {
      provider,
      planType,
      limitId,
      slot,
      windowDurationMins: durationMinutes,
      resetsAt,
      usedPercent,
    },
  };
}

function period(cache, id) {
  const value = cache.periods.find((row) => row.id === id);
  assert.ok(value, `missing ${id} period`);
  return value;
}

test("projects replay-safe diagnostics and aggregates costs, dimensions, and 15-minute buckets", async () => {
  let observedScanOptions;
  const events = [
    usageEvent({
      timestamp: "2026-07-27T11:46:00.000Z",
      components: {
        input_uncached_tokens: 1_000_000,
        input_cache_read_tokens: 1_000_000,
        output_reasoning_tokens: 1_000_000,
      },
    }),
    usageEvent({
      timestamp: "2026-07-27T11:58:00.000Z",
      model: "gpt-5.6-terra",
      components: {
        input_uncached_tokens: 1_000_000,
        output_text_tokens: 400_000,
        output_reasoning_tokens: 600_000,
      },
      speed: "fast",
      apiServiceTier: "priority",
      surface: "subagent",
      agentScope: "subagent",
      lineageDisposition: "forked",
    }),
    usageEvent({
      timestamp: "2026-07-27T11:31:00.000Z",
      model: "future-private-model-name",
      components: { input_uncached_tokens: 100 },
      speed: "future-speed",
      apiServiceTier: "future-tier",
      surface: "future-surface",
      agentScope: "future-agent-scope",
      lineageDisposition: "future-lineage",
    }),
    usageEvent({
      timestamp: "2026-07-25T12:00:00.000Z",
      model: "gpt-5.6-luna",
      components: {
        input_cache_read_tokens: 1_000_000,
        output_text_tokens: 1_000_000,
      },
      speed: "fast",
      surface: "scheduled_task",
      agentScope: "automation",
      lineageDisposition: "parent_linked",
    }),
  ];
  const cache = await buildReplaySafeAccountingCache({
    codexHome: "/private/example-codex-home",
    now: () => NOW,
    // Re-pinned 31 -> 365 (2026-08-08): the standing owner rule forbids
    // convenience-sized history windows outright, so 365 is now the smallest
    // window the builder accepts.
    windowDays: 365,
    scan: async (options) => {
      observedScanOptions = options;
      return scanner(events)(options);
    },
  });

  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(
    cache.accountingMethod,
    "lineage_aware_cumulative_snapshot_replay_exclusion",
  );
  assert.deepEqual(cache.diagnostics, {
    filesScanned: 9,
    forkReplayEventsExcluded: 21,
    unattributedForkReplayEventsExcluded: 3,
    contradictedLeadingSnapshotsExcluded: 0,
    duplicateSnapshotsExcluded: 4,
    missingLineageParents: 2,
  });
  assert.equal(observedScanOptions.codexHome, "/private/example-codex-home");
  // Re-pinned (2026-08-08): 365 days back from NOW, not 31.
  assert.equal(observedScanOptions.startAt, "2025-07-27T12:00:00.000Z");
  assert.equal(observedScanOptions.endAt, "2026-07-27T12:00:00.000Z");

  const latest = period(cache, "24h");
  assert.equal(latest.events, 3);
  assert.equal(latest.totalTokens, 5_000_100);
  assert.equal(latest.byModel[0].model, "gpt-5.6-sol");
  assert.deepEqual(
    latest.byModel.map((row) => [row.model, row.events]),
    [
      ["gpt-5.6-sol", 1],
      ["gpt-5.6-terra", 1],
      ["unknown", 1],
    ],
  );
  assert.equal(latest.bySpeed.standard.events, 1);
  assert.equal(latest.bySpeed.fast.events, 1);
  assert.equal(latest.bySpeed.unknown.events, 1);
  assert.equal(latest.byApiServiceTier.priority.events, 1);
  assert.equal(latest.byApiServiceTier.unknown.events, 2);
  assert.equal(latest.bySurface.extension_or_ide.events, 1);
  assert.equal(latest.bySurface.subagent.events, 1);
  assert.equal(latest.bySurface.unknown.events, 1);
  assert.equal(latest.byAgentScope.root.events, 1);
  assert.equal(latest.byAgentScope.subagent.events, 1);
  assert.equal(latest.byAgentScope.unknown.events, 1);
  assert.equal(latest.byLineage.standalone.events, 1);
  assert.equal(latest.byLineage.forked.events, 1);
  assert.equal(latest.byLineage.unknown.events, 1);
  assert.equal(latest.pricingCoverage.fullyPricedEvents, 2);
  assert.equal(latest.pricingCoverage.unpricedEvents, 1);
  assert.equal(latest.pricedEventFraction, 0.666667);

  // The observed speed x published-Fast-family crossing is what lets the
  // owner's stated mode be applied at read time without a cache rebuild. Its
  // event counts must reconcile exactly with the speed and model dimensions,
  // and an unrecognised model must land in "unsupported" rather than being
  // given a Fast rate it has no published evidence for.
  assert.deepEqual(
    Object.entries(latest.speedWeighting).flatMap(([speed, families]) => (
      Object.entries(families)
        .filter(([, cell]) => cell.events > 0)
        .map(([family, cell]) => [speed, family, cell.events])
    )),
    [
      ["standard", "gpt-5.6", 1],
      ["fast", "gpt-5.6", 1],
      ["unknown", "unsupported", 1],
    ],
  );
  assert.equal(
    Object.values(latest.speedWeighting).reduce((total, families) => (
      total + Object.values(families).reduce(
        (subtotal, cell) => subtotal + cell.events,
        0,
      )
    ), 0),
    latest.events,
  );
  assert.equal(
    latest.speedWeighting.fast["gpt-5.6"].apiPriceEquivalentUsd
      + latest.speedWeighting.standard["gpt-5.6"].apiPriceEquivalentUsd
      + latest.speedWeighting.unknown.unsupported.apiPriceEquivalentUsd,
    latest.apiPriceEquivalentUsd,
  );

  assert.equal(latest.components.input_uncached_tokens, 2_000_100);
  assert.equal(latest.components.input_cache_read_tokens, 1_000_000);
  assert.equal(latest.components.output_text_tokens, 400_000);
  assert.equal(latest.components.output_reasoning_tokens, 1_600_000);
  assert.equal(latest.components.output_combined_tokens, 0);
  assert.equal(latest.componentCosts.input_uncached_tokens.pricedTokens, 2_000_000);
  assert.equal(latest.componentCosts.input_uncached_tokens.unpricedTokens, 100);
  assert.equal(latest.componentCosts.input_uncached_tokens.costUsd, 7.5);
  assert.equal(latest.componentCosts.input_cache_read_tokens.costUsd, 0.5);
  assert.equal(latest.componentCosts.output_text_tokens.costUsd, 6);
  assert.equal(latest.componentCosts.output_reasoning_tokens.costUsd, 39);
  assert.equal(latest.componentCosts.output_combined_tokens.costUsd, 0);
  assert.equal(latest.apiPriceEquivalentUsd, 53);
  assert.equal(
    Object.values(latest.componentCosts)
      .reduce((sum, row) => sum + row.costUsd, 0),
    latest.apiPriceEquivalentUsd,
  );

  // The model table and the component bars are the two margins of one
  // crossing, so the cells must reconcile in both directions: each model's
  // components add up to that model's own totals, and the models add up to the
  // period. Without this a per-model breakdown could drift from the headline
  // it sits under and still look plausible.
  for (const row of latest.byModel) {
    assert.equal(
      Object.values(row.componentCosts).reduce((sum, cost) => sum + cost.costUsd, 0),
      row.apiPriceEquivalentUsd,
      `${row.model} component costs reconcile with its own total`,
    );
    assert.equal(
      Object.entries(row.components).reduce((sum, [key, tokens]) => (
        // `output_combined_tokens` is an alternative to the text/reasoning
        // split, never an addition to it, so it is excluded exactly as the
        // period's own token total excludes it.
        key === "output_combined_tokens" ? sum : sum + tokens
      ), row.components.output_combined_tokens),
      row.totalTokens,
      `${row.model} components reconcile with its own token total`,
    );
  }
  for (const key of Object.keys(latest.components)) {
    assert.equal(
      latest.byModel.reduce((sum, row) => sum + row.components[key], 0),
      latest.components[key],
      `${key} tokens add up across models`,
    );
    assert.equal(
      Number(latest.byModel
        .reduce((sum, row) => sum + row.componentCosts[key].costUsd, 0)
        .toFixed(6)),
      latest.componentCosts[key].costUsd,
      `${key} cost adds up across models`,
    );
  }
  // An unpriced event must stay visible as unpriced on the model row too,
  // rather than being folded into a priced zero.
  assert.equal(
    latest.byModel.reduce(
      (sum, row) => sum + row.componentCosts.input_uncached_tokens.unpricedTokens,
      0,
    ),
    latest.componentCosts.input_uncached_tokens.unpricedTokens,
  );

  assert.equal(period(cache, "7d").events, 4);
  assert.equal(period(cache, "7d").totalTokens, 7_000_100);
  assert.equal(period(cache, "30d").events, 4);
  assert.equal(period(cache, "all").events, 4);

  assert.deepEqual(
    cache.timeline.map((row) => [
      row.startAt,
      row.endAt,
      row.usageEvents,
      row.totalTokens,
    ]),
    [
      [
        "2026-07-25T12:00:00.000Z",
        "2026-07-25T12:15:00.000Z",
        1,
        2_000_000,
      ],
      [
        "2026-07-27T11:30:00.000Z",
        "2026-07-27T11:45:00.000Z",
        1,
        100,
      ],
      [
        "2026-07-27T11:45:00.000Z",
        "2026-07-27T12:00:00.000Z",
        2,
        5_000_000,
      ],
    ],
  );
  assert.equal(cache.timeline[2].apiPriceEquivalentUsd, 53);
  assert.equal(
    Object.values(cache.timeline[2].speedWeighting)
      .flatMap((families) => Object.values(families))
      .reduce((total, cell) => total + cell.events, 0),
    cache.timeline[2].usageEvents,
  );
  assert.equal(
    Object.values(cache.timeline[2].speedWeighting)
      .flatMap((families) => Object.values(families))
      .reduce(
        (total, cell) => total + cell.apiPriceEquivalentUsd,
        0,
      ),
    cache.timeline[2].apiPriceEquivalentUsd,
  );
  // Re-pinned (2026-08-08): the input receipt now names its corpus source and
  // covered span, so full-history unified sourcing is distinguishable from
  // the windowed fallback.
  assert.deepEqual(cache.weeklyCalibrationInput, {
    status: "complete",
    encoding: "accounting_compact_v2",
    source: "windowed_scan",
    coveredAt: {
      startAt: "2025-07-27T12:00:00.000Z",
      endAt: "2026-07-27T12:00:00.000Z",
    },
    retainedUsageEvents: 4,
    retainedWeeklySnapshots: 0,
    estimatedRetainedBytes: 1_024,
    limits: {
      usageEvents: 750_000,
      weeklySnapshots: 750_000,
      combinedInputs: 1_500_000,
      retainedBytes: 320 * 1024 * 1024,
    },
  });
});

test("replay-safe fast pricing plans keep pre-change events on their historical card", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-29T23:59:59.999Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
      usageEvent({
        timestamp: "2026-07-30T00:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const all = period(cache, "all");
  assert.deepEqual(all.priceCardIds, [
    "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-01",
    "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-01",
  ]);
  assert.deepEqual(all.priceCardBreakdown.map(({ priceCardId, events, costUsd }) => ({
    priceCardId,
    events,
    costUsd,
  })), [
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-01",
      events: 1,
      costUsd: "2",
    },
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-01",
      events: 1,
      costUsd: "2.5",
    },
  ]);
  assert.equal(all.apiPriceEquivalentUsd, 4.5);
});

test("replay-safe cache rejects price-card event and exact-cost reconciliation drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-provenance-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-30T00:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const all = period(cache, "all");
  assert.equal(all.apiPriceEquivalentUsdExact, "2");

  const badEvents = structuredClone(cache);
  const badEventsPeriod = period(badEvents, "all");
  badEventsPeriod.priceCardBreakdown[0].events += 1;
  await writeTestCache(cacheFile, badEvents);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const badCost = structuredClone(cache);
  const badCostPeriod = period(badCost, "all");
  badCostPeriod.priceCardBreakdown[0].costUsd = "3";
  await writeTestCache(cacheFile, badCost);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
});

test("exact decimal totals survive a floating-point half-boundary round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-exact-money-rounding-"));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  const events = Array.from({ length: 31 }, (_, index) => usageEvent({
    timestamp: new Date(NOW - 60_000 + index).toISOString(),
    model: "gpt-5.6-terra",
    components: { input_uncached_tokens: 1 },
  }));

  // At $2.50 / million tokens, the exact sum is on a seventh-decimal half
  // boundary. Repeated binary-float addition lands on the other side of that
  // boundary on some totals, so the published numeric projection must be
  // derived from the exact decimal ledger rather than the accumulated float.
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => NOW,
    scan: scanner(events),
  });
  const all = period(cache, "all");
  assert.equal(all.apiPriceEquivalentUsdExact, "0.0000775");
  assert.equal(all.apiPriceEquivalentUsd, 0.000078);
  assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));

  const stored = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => NOW,
  });
  assert.equal(stored.status, "available");
  assert.equal(period(stored.cache, "all").apiPriceEquivalentUsd, 0.000078);
});

test("separated output takes precedence over a duplicate combined alias", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        model: "gpt-5.6-terra",
        components: {
          input_uncached_tokens: 1_000_000,
          output_text_tokens: 400_000,
          output_reasoning_tokens: 600_000,
          output_combined_tokens: 1_000_000,
        },
      }),
    ]),
  });
  const latest = period(cache, "24h");

  assert.equal(latest.totalTokens, 2_000_000);
  assert.equal(latest.components.output_text_tokens, 400_000);
  assert.equal(latest.components.output_reasoning_tokens, 600_000);
  assert.equal(latest.components.output_combined_tokens, 0);
  assert.equal(latest.apiPriceEquivalentUsd, 17.5);
  assert.equal(latest.pricingCoverage.fullyPricedEvents, 1);
  assert.equal(latest.componentCosts.output_text_tokens.costUsd, 6);
  assert.equal(latest.componentCosts.output_reasoning_tokens.costUsd, 9);
  assert.equal(latest.componentCosts.output_combined_tokens.costUsd, 0);
  assert.equal(cache.timeline[0].totalTokens, 2_000_000);
  assert.equal(cache.timeline[0].apiPriceEquivalentUsd, 17.5);
  assert.equal(
    Object.values(latest.componentCosts)
      .reduce((sum, row) => sum + row.costUsd, 0),
    17.5,
  );
});

test("combined-only output is retained once and priced as ordinary output", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        model: "gpt-5.6-terra",
        components: {
          input_uncached_tokens: 1_000_000,
          output_combined_tokens: 1_000_000,
        },
      }),
    ]),
  });
  const latest = period(cache, "24h");

  assert.equal(latest.totalTokens, 2_000_000);
  assert.equal(latest.components.output_text_tokens, 0);
  assert.equal(latest.components.output_reasoning_tokens, 0);
  assert.equal(latest.components.output_combined_tokens, 1_000_000);
  assert.equal(latest.apiPriceEquivalentUsd, 17.5);
  assert.equal(latest.pricingCoverage.fullyPricedEvents, 1);
  assert.equal(latest.componentCosts.output_combined_tokens.pricedTokens, 1_000_000);
  assert.equal(latest.componentCosts.output_combined_tokens.unpricedTokens, 0);
  assert.equal(latest.componentCosts.output_combined_tokens.costUsd, 15);
  assert.equal(cache.timeline[0].totalTokens, 2_000_000);
  assert.equal(cache.timeline[0].apiPriceEquivalentUsd, 17.5);
});

test("refresh and read round-trip a valid owner-only cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-accounting-"));
  const cacheFile = join(directory, "nested", "accounting.json");
  const written = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const metadata = await stat(cacheFile);
  const read = await readReplaySafeAccountingCache({ cacheFile });

  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
  assert.deepEqual(read.cache, written);
  assert.equal(period(read.cache, "24h").apiPriceEquivalentUsd, 5);
});

test("cache freshness uses the covered end and rejects a future projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-freshness-"));
  const cacheFile = join(directory, "accounting.json");
  const written = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });

  const stale = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 60 * 60 * 1_000,
    maximumAgeMs: 30 * 60 * 1_000,
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.errorCode, "cache_stale");
  assert.equal(stale.ageSeconds, 3_600);
  assert.deepEqual(stale.cache, written);

  const future = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW - 1,
    maximumAgeMs: 30 * 60 * 1_000,
  });
  assert.deepEqual(future, {
    status: "unavailable",
    errorCode: "cache_from_future",
    cache: null,
  });
});

test("the same lineage-aware scan produces a bounded weekly calibration summary", async () => {
  const resetStarts = [
    Date.parse("2026-07-30T00:00:00.000Z"),
    Date.parse("2026-08-06T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
  ];
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    // Re-pinned 31 -> 365 (2026-08-08): the window floor is now 365 days.
    windowDays: 365,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      for (const [resetIndex, resetStart] of resetStarts.entries()) {
        const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
        for (let boundary = 0; boundary < 10; boundary += 1) {
          const observedMs = resetStart + boundary * 60 * 60 * 1_000;
          if (boundary > 0) {
            onUsage(usageEvent({
              timestamp: new Date(observedMs).toISOString(),
              speed: "unknown",
              components: {
                input_uncached_tokens:
                  1_000_000 + resetIndex * 100_000,
              },
            }));
          }
          onRateLimitSnapshot({
            timestamp: new Date(observedMs).toISOString(),
            timestampMs: observedMs,
            window: {
              provider: "openai_codex",
              planType: "pro",
              limitId: "codex",
              slot: "secondary",
              windowDurationMins: 10_080,
              resetsAt,
              usedPercent: boundary,
            },
          });
        }
      }
      return {
        diagnostics: {
          filesScanned: 3,
          forkReplayEventsSkipped: 4,
          replayedEventsSkipped: 2,
          replayedToolCallsSkipped: 1,
          malformedLines: 0,
          malformedTimestamps: 0,
          malformedUsageRecords: 0,
          malformedRateLimitRecords: 0,
        },
      };
    },
  });

  assert.equal(cache.weeklyCalibration.status, "estimated");
  assert.equal(cache.weeklyCalibration.estimate.qualifyingResets, 3);
  assert.equal(cache.weeklyCalibration.recentResets.length, 3);
  const standardCapacity = cache.allowanceCapacityByScenario.scenarios
    .unresolved_as_standard;
  const fastCapacity = cache.allowanceCapacityByScenario.scenarios
    .unresolved_as_fast;
  assert.equal(
    cache.allowanceCapacityByScenario.schemaVersion,
    "codex-primary-allowance-capacity-v0.1",
  );
  assert.equal(
    standardCapacity.basis.basisFamilyId,
    fastCapacity.basis.basisFamilyId,
  );
  assert.notEqual(standardCapacity.basis.basisId, fastCapacity.basis.basisId);
  assert.equal(
    standardCapacity.basis.unresolvedScenario,
    "unresolved_as_standard",
  );
  assert.equal(fastCapacity.basis.unresolvedScenario, "unresolved_as_fast");
  assert.equal(
    standardCapacity.basis.multiplierRegistryRecordedAt,
    "2026-08-01",
  );
  assert.equal(
    standardCapacity.calibration.validation.selectedCostBasis,
    "speed_lower",
  );
  assert.equal(
    fastCapacity.calibration.validation.selectedCostBasis,
    "speed_upper",
  );
  assert.equal(standardCapacity.calibration.status, "estimated");
  assert.equal(fastCapacity.calibration.status, "estimated");
  assert.equal(
    Number((fastCapacity.calibration.estimate.medianApiPriceEquivalentUsd
      / standardCapacity.calibration.estimate.medianApiPriceEquivalentUsd)
      .toFixed(6)),
    2.5,
  );
  assert.deepEqual(cache.weeklyCalibration.accountAttribution, {
    status: "historical_unattributed",
    maySpanMultipleAccounts: true,
    label:
      "Historical estimate; account-unattributed and may combine multiple accounts",
  });
  const serialized = JSON.stringify(cache.weeklyCalibration);
  for (const forbidden of [
    "prompt",
    "response",
    "repository",
    "accountScopeId",
    "modelMix",
    "marginalComponents",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  // The composition block always exists on a v0.7 cache, and a corpus this
  // thin reports its own insufficiency instead of a fake vector.
  assert.equal(
    cache.weeklyCalibration.composition.status,
    "insufficient_observations",
  );
  assert.equal(cache.weeklyCalibration.composition.capacityUsdByModel, null);
});

test("a mix-varied corpus yields a fitted per-model composition that survives the cache round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "composition-cache-"));
  const stateFile = join(directory, "collector-state-v1.sqlite");
  const resetStart = Date.parse("2026-08-10T00:00:00.000Z");
  const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
  const nowMs = resetStart + 60 * 60 * 60 * 1_000;
  const cache = await buildReplaySafeAccountingCache({
    now: () => nowMs,
    windowDays: 365,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      let usedPercent = 0;
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: new Date(resetStart).toISOString(),
        usedPercent,
        resetsAt,
      }));
      // 25 alternating pure-model 2h bins: sol bins move 1pp on a large
      // token spend, terra bins move 4pp on the same spend — enough rank for
      // the NNLS to separate the two rates, with zero collinearity.
      for (let bin = 0; bin < 25; bin += 1) {
        const binStart = resetStart + bin * 2 * 60 * 60 * 1_000;
        const model = bin % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra";
        onUsage(usageEvent({
          timestamp: new Date(binStart + 30 * 60_000).toISOString(),
          model,
          components: { input_uncached_tokens: 2_000_000 },
        }));
        usedPercent += bin % 2 === 0 ? 1 : 4;
        onRateLimitSnapshot(weeklySnapshot({
          timestamp: new Date(binStart + 90 * 60_000).toISOString(),
          usedPercent,
          resetsAt,
        }));
      }
      return { diagnostics: {} };
    },
  });
  const composition = cache.weeklyCalibration.composition;
  assert.equal(composition.status, "fitted");
  const sol = composition.capacityUsdByModel["gpt-5.6-sol"];
  const terra = composition.capacityUsdByModel["gpt-5.6-terra"];
  assert.ok(Number.isFinite(sol) && sol > 0);
  assert.ok(Number.isFinite(terra) && terra > 0);
  // Same spend, 4x the displayed movement: terra's $/100pp is materially
  // lower than sol's.
  assert.ok(sol > terra * 2);
  assert.ok(composition.r2 > composition.singleConstantR2);
  assert.ok(Number.isFinite(composition.blendedRecentMixUsd));
  assert.equal(composition.grainHours, 2);
  // The block survives the SQLite round trip and the read-path validator.
  await writeTestCache(stateFile, cache);
  const read = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => nowMs,
  });
  assert.equal(read.status, "available");
  assert.deepEqual(read.cache.weeklyCalibration.composition, composition);
});

// Compact rows exactly as transitionUsageProjection / weeklyRateLimitProjection
// lay them out, restricted to the indices the composition fit reads: usage
// [0]=ISO timestamp, [1]=model, [10]=costUsd; snapshot [1]=timestampMs,
// [3]=planType, [7]=resetsAt seconds, [8]=usedPercent.
function compactUsageRow(timestampMs, model, costUsd) {
  const row = new Array(16).fill(null);
  row[0] = new Date(timestampMs).toISOString();
  row[1] = model;
  row[10] = costUsd;
  return row;
}

function compactSnapshotRow(
  timestampMs,
  usedPercent,
  resetsAtSeconds,
  planType = "pro",
) {
  const row = new Array(9).fill(null);
  row[0] = new Date(timestampMs).toISOString();
  row[1] = timestampMs;
  row[3] = planType;
  row[7] = resetsAtSeconds;
  row[8] = usedPercent;
  return row;
}

// The pre-streaming per-event reference: materialize {observedAtMs, model,
// costUsd} objects for the whole corpus and hand them to the kernel — the
// exact code the streaming pass replaced. The fit must stay bit-identical to
// this path; only the peak memory may differ.
function referencePerEventComposition({
  rawUsageEvents,
  weeklyRateLimitSnapshots,
  endMs,
}) {
  const usageRows = [];
  for (const row of rawUsageEvents) {
    if (!Array.isArray(row)) continue;
    const observedAtMs = Date.parse(row[0]);
    const costUsd = Number(row[10]);
    if (!Number.isFinite(observedAtMs)
        || typeof row[1] !== "string"
        || !Number.isFinite(costUsd)
        || costUsd < 0) continue;
    usageRows.push({ observedAtMs, model: row[1], costUsd });
  }
  const quotaRows = [];
  for (const row of weeklyRateLimitSnapshots) {
    if (!Array.isArray(row)) continue;
    const observedAtMs = Number(row[1]);
    const resetsAtSeconds = Number(row[7]);
    const usedPercent = Number(row[8]);
    if (!Number.isFinite(observedAtMs)
        || !Number.isFinite(resetsAtSeconds)
        || !Number.isFinite(usedPercent)) continue;
    quotaRows.push({
      observedAtMs,
      planType: typeof row[3] === "string" ? row[3] : "unknown",
      resetsAtMs: resetsAtSeconds * 1_000,
      usedPercent,
    });
  }
  const { observations, voidedBinCount, poolCount } =
    buildCompositionObservations({ usageRows, quotaRows });
  const fit = calibrateCompositionCapacities(observations);
  const recentStartMs = endMs - 14 * 24 * 60 * 60 * 1_000;
  const recentMix = {};
  for (const row of usageRows) {
    if (row.observedAtMs < recentStartMs) continue;
    recentMix[row.model] = (recentMix[row.model] ?? 0) + row.costUsd;
  }
  const blendedRecentMixUsd = fit.status === "fitted"
    ? blendedCompositionCapacityUsd(recentMix, {
      capacityUsdByModel: fit.capacityUsdByModel,
      fallbackCapacityUsd: fit.singleConstantUsd,
    })
    : null;
  return {
    usageRows,
    quotaRows,
    observations,
    voidedBinCount,
    poolCount,
    fit,
    blendedRecentMixUsd,
  };
}

test("the streaming composition binning matches the per-event kernel path exactly", async () => {
  const grainMs = 2 * 60 * 60 * 1_000;
  const resetStartMs = Date.parse("2026-08-10T00:00:00.000Z");
  const resetsAtSeconds = Math.floor(
    (resetStartMs + 7 * 24 * 60 * 60 * 1_000) / 1_000,
  );
  const endMs = resetStartMs + 60 * 60 * 60 * 1_000;
  const rawUsageEvents = [];
  const weeklyRateLimitSnapshots = [
    compactSnapshotRow(resetStartMs, 0, resetsAtSeconds),
  ];
  // The mix-varied fixture shape: alternating pure-model 2h bins whose
  // displayed movement differs 4x on comparable spend — but with SEVERAL
  // fractional-cost events per bin, so the streaming accumulation has real
  // floating-point summation order to preserve, plus a sliver model that
  // folds into "other" and an out-of-recent-window event that must reach the
  // bins yet stay out of the recent mix.
  let usedPercent = 0;
  for (let bin = 0; bin < 25; bin += 1) {
    const binStartMs = resetStartMs + bin * grainMs;
    const model = bin % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra";
    for (let event = 0; event < 7; event += 1) {
      rawUsageEvents.push(compactUsageRow(
        binStartMs + (event + 1) * 60_000,
        model,
        0.7 + event * 0.037,
      ));
    }
    rawUsageEvents.push(
      compactUsageRow(binStartMs + 8 * 60_000, "gpt-5.6-luna", 0.003),
    );
    usedPercent += bin % 2 === 0 ? 1 : 4;
    weeklyRateLimitSnapshots.push(
      compactSnapshotRow(binStartMs + 90 * 60_000, usedPercent, resetsAtSeconds),
    );
  }
  rawUsageEvents.push(compactUsageRow(
    resetStartMs - 30 * 24 * 60 * 60 * 1_000,
    "gpt-5.6-sol",
    5,
  ));
  // Malformed rows both paths must skip identically.
  rawUsageEvents.push(null);
  rawUsageEvents.push(compactUsageRow(resetStartMs, "gpt-5.6-sol", -1));
  const negativeCost = compactUsageRow(resetStartMs, "gpt-5.6-sol", 1);
  negativeCost[0] = "not-a-timestamp";
  rawUsageEvents.push(negativeCost);
  weeklyRateLimitSnapshots.push(null);
  const malformedSnapshot = compactSnapshotRow(resetStartMs, 50, resetsAtSeconds);
  malformedSnapshot[1] = Number.NaN;
  weeklyRateLimitSnapshots.push(malformedSnapshot);

  const reference = referencePerEventComposition({
    rawUsageEvents,
    weeklyRateLimitSnapshots,
    endMs,
  });
  // The fixture must exercise the strongest path: a genuinely fitted vector.
  assert.equal(reference.fit.status, "fitted");

  const streamed = await fitCompositionFromCompactCorpus({
    rawUsageEvents,
    weeklyRateLimitSnapshots,
    endMs,
  });
  assert.deepEqual(streamed, {
    status: reference.fit.status,
    grainHours: 2,
    observationCount: reference.fit.observationCount,
    voidedBinCount: reference.voidedBinCount,
    poolCount: reference.poolCount,
    capacityUsdByModel: reference.fit.capacityUsdByModel,
    modelCostShares: reference.fit.modelCostShares,
    r2: reference.fit.r2,
    singleConstantUsd: reference.fit.singleConstantUsd,
    singleConstantR2: reference.fit.singleConstantR2,
    identification: reference.fit.identification ?? null,
    blendedRecentMixUsd: Number(reference.blendedRecentMixUsd.toFixed(2)),
    recentMixDays: 14,
  });

  // The grains themselves are identical, not merely the fit summary:
  // aggregating per (grain bin, model) in encounter order and re-running the
  // kernel yields byte-for-byte the observations the per-event rows produce.
  const binCosts = new Map();
  for (const row of reference.usageRows) {
    if (row.model.length === 0) continue;
    const binStartMs = Math.floor(row.observedAtMs / grainMs) * grainMs;
    let costs = binCosts.get(binStartMs);
    if (costs === undefined) {
      costs = new Map();
      binCosts.set(binStartMs, costs);
    }
    costs.set(row.model, (costs.get(row.model) ?? 0) + row.costUsd);
  }
  const aggregatedRows = [];
  for (const [binStartMs, costs] of binCosts) {
    for (const [model, costUsd] of costs) {
      aggregatedRows.push({ observedAtMs: binStartMs, model, costUsd });
    }
  }
  assert.deepEqual(
    buildCompositionObservations({
      usageRows: aggregatedRows,
      quotaRows: reference.quotaRows,
    }),
    {
      observations: reference.observations,
      voidedBinCount: reference.voidedBinCount,
      poolCount: reference.poolCount,
    },
  );
});

test("the composition fit meters memory and abort on the shared cadence", async () => {
  const startMs = Date.parse("2026-08-10T00:00:00.000Z");
  const resetsAtSeconds = Math.floor(
    (startMs + 7 * 24 * 60 * 60 * 1_000) / 1_000,
  );
  const rawUsageEvents = [];
  for (let index = 0; index < 5_000; index += 1) {
    rawUsageEvents.push(
      compactUsageRow(startMs + index * 1_000, "gpt-5.6-sol", 0.01),
    );
  }
  const weeklyRateLimitSnapshots = [];
  for (let index = 0; index < 1_200; index += 1) {
    weeklyRateLimitSnapshots.push(compactSnapshotRow(
      startMs + index * 60_000,
      Math.min(100, Math.floor(index / 60)),
      resetsAtSeconds,
    ));
  }
  const endMs = startMs + 24 * 60 * 60 * 1_000;

  // 5,000 usage rows + 1,200 snapshot rows share one row counter, so the
  // 2,048-row cadence fires at 2,048 and 4,096 (usage pass) and 6,144
  // (quota pass): exactly three memory checks.
  let checks = 0;
  await fitCompositionFromCompactCorpus({
    rawUsageEvents,
    weeklyRateLimitSnapshots,
    endMs,
    checkRuntimeMemory: () => {
      checks += 1;
    },
  });
  assert.equal(checks, 3);

  // A memory guard that trips mid-corpus propagates out of the fit itself.
  const guardError = new Error("accounting_transition_rss_limit_exceeded");
  guardError.code = "accounting_transition_rss_limit_exceeded";
  await assert.rejects(
    fitCompositionFromCompactCorpus({
      rawUsageEvents,
      weeklyRateLimitSnapshots,
      endMs,
      checkRuntimeMemory: () => {
        throw guardError;
      },
    }),
    (error) => error?.code === "accounting_transition_rss_limit_exceeded",
  );

  // An aborted signal interrupts on the same cadence.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fitCompositionFromCompactCorpus({
      rawUsageEvents,
      weeklyRateLimitSnapshots,
      endMs,
      signal: controller.signal,
    }),
    (error) => error?.name === "AbortError",
  );
});

test("a composition fit that trips the RSS ceiling mid-way fails soft into a completed v0.7 cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-fit-fail-soft-"));
  const stateFile = join(directory, "collector-state-v1.sqlite");
  let fitSpikeArmed = false;
  let checksSinceArmed = 0;
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    maximumRssBytes: 1_000,
    // Under the ceiling everywhere except the SECOND check after the scan
    // returns: the first is the build's post-scan phase boundary, the second
    // is the fit's first in-loop cadence check — so the throw provably
    // starts inside the fit, and the ceiling is back under for every later
    // phase.
    rss: () => {
      if (!fitSpikeArmed) return 10;
      checksSinceArmed += 1;
      return checksSinceArmed === 2 ? 1_001 : 10;
    },
    scan: async ({ onUsage }) => {
      for (let index = 0; index < 2_100; index += 1) {
        onUsage(usageEvent({
          timestamp: new Date(NOW - 100_000_000 + index * 1_000).toISOString(),
          components: { input_uncached_tokens: 1 },
        }));
      }
      fitSpikeArmed = true;
      return { diagnostics: {} };
    },
  });

  // The build completed: every event aggregated, the calibration block
  // exists, and only the optional composition enrichment is gone.
  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(period(cache, "all").events, 2_100);
  assert.equal(cache.weeklyCalibration.composition, null);
  assert.deepEqual(cache.weeklyCalibration.compositionStatus, {
    status: "fit_failed",
    reason: "accounting_transition_rss_limit_exceeded",
  });

  // The completed cache is valid, survives the SQLite round trip, and the
  // honest failure record survives with it.
  await writeTestCache(stateFile, cache);
  const read = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => NOW,
  });
  assert.equal(read.status, "available");
  assert.equal(read.cache.weeklyCalibration.composition, null);
  assert.deepEqual(read.cache.weeklyCalibration.compositionStatus, {
    status: "fit_failed",
    reason: "accounting_transition_rss_limit_exceeded",
  });

  // The failure record is validated, not merely tolerated: an unbounded
  // reason or a record claiming failure NEXT TO a composition block both
  // fail the cache validator.
  const unboundedReason = structuredClone(cache);
  unboundedReason.weeklyCalibration.compositionStatus = {
    status: "fit_failed",
    reason: "free text with spaces / and paths",
  };
  assert.throws(
    () => assertReplaySafeAccountingCache(unboundedReason),
    (error) => error?.code === "cache_invalid",
  );
  const contradictory = structuredClone(cache);
  contradictory.weeklyCalibration.composition = {
    status: "insufficient_observations",
    grainHours: 2,
    observationCount: 0,
    capacityUsdByModel: null,
    modelCostShares: {},
    r2: null,
    singleConstantUsd: null,
    singleConstantR2: null,
    blendedRecentMixUsd: null,
    recentMixDays: 14,
  };
  assert.throws(
    () => assertReplaySafeAccountingCache(contradictory),
    (error) => error?.code === "cache_invalid",
  );
});

// Fixture unified index for the full-history calibration tests: the same
// three-reset shape the windowed calibration test uses, written as typed
// rows. Each boundary carries one usage event so the derived transitions are
// calibration-eligible.
async function writeUnifiedCalibrationFixture(indexFile, {
  resets,
  boundaries = 10,
}) {
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "unified-calibration-test-v1",
    discoveredSourceCount: 0,
    discoveredSourceBytes: 0,
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "unified-calibration-test-v1",
    generationId: generation.generationId,
    parserVersionId: generation.parserVersionId,
    ingestRunId: generation.ingestRunId,
  });
  const modelId = writer.internModel("gpt-5.6-terra", "recognized");
  const tierId = writer.internTier({
    apiServiceTier: "unknown",
    billingSurface: "unknown",
    codexSpeedMode: "unknown",
    tierSource: "unknown",
    providerTierRaw: null,
  });
  const surfaceId = writer.internSurface({
    agentScope: "unknown",
    surface: "unknown",
    threadSource: "unknown",
    lineageDisposition: "unknown",
  });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable",
    reason: null,
    planType: null,
    scopeLocal: null,
  });
  const sessionLocal = Buffer.alloc(32, 7);
  let eventNumber = 0;
  for (const [resetIndex, resetStartMs] of resets.entries()) {
    const resetsAtMs = resetStartMs + 7 * 24 * 60 * 60 * 1_000;
    for (let boundary = 0; boundary < boundaries; boundary += 1) {
      const observedMs = resetStartMs + boundary * 60 * 60 * 1_000;
      if (boundary > 0) {
        eventNumber += 1;
        writer.writeUsageEvent({
          eventKey: Buffer.from(`unified-calibration-event-${eventNumber}`),
          observedAtMs: observedMs,
          sessionLocal,
          accountScopeId,
          modelId,
          tierId,
          surfaceId,
          reasoningEffort: 8,
          outcome: 5,
          tokensInUncached: 1_000_000 + resetIndex * 100_000,
        });
      }
      writer.internQuota({
        observedAtMs: observedMs,
        limitId: "codex",
        slot: "secondary",
        planType: "pro",
        usedPercent: boundary,
        resetsAtMs,
        durationMins: 10_080,
      });
    }
  }
  writer.finalizeGeneration({
    status: "partial",
    blockReason: "calibration_fixture",
    discoveredSourceCount: 0,
    discoveredSourceBytes: 0,
    indexedSourceCount: 0,
    indexedSourceBytes: 0,
    discoveryComplete: false,
    diagnosticsComplete: false,
  });
  await writer.close({ integrityCheck: true, fsyncPath: indexFile });
}

// Standing owner rule (2026-08-08): with a unified index covering N months,
// the calibration corpus spans all N months. The fixture resets sit MORE than
// a year before "now" — outside every representable scan window — and the
// scan itself returns nothing, so an estimate can only come from the index.
test("the unified index supplies the full-history calibration corpus with no scan window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-unified-calibration-"));
  const indexFile = join(directory, "local-unified-index-v1.sqlite");
  await writeUnifiedCalibrationFixture(indexFile, {
    resets: [
      Date.parse("2025-05-01T00:00:00.000Z"),
      Date.parse("2025-05-08T00:00:00.000Z"),
      Date.parse("2025-05-15T00:00:00.000Z"),
    ],
  });

  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    unifiedIndexFile: indexFile,
    scan: scanner([]),
  });

  assert.equal(cache.weeklyCalibrationInput.source, "unified_index");
  assert.deepEqual(cache.weeklyCalibrationInput.coveredAt, {
    startAt: "2025-05-01T00:00:00.000Z",
    endAt: "2026-08-20T12:00:00.000Z",
  });
  assert.equal(cache.weeklyCalibrationInput.retainedUsageEvents, 27);
  assert.equal(cache.weeklyCalibration.status, "estimated");
  assert.equal(cache.weeklyCalibration.estimate.qualifyingResets, 3);
  assert.equal(cache.weeklyCalibration.recentResets.length, 3);
  assert.equal(
    cache.weeklyCalibration.recentResets[0].firstObservedAt,
    "2025-05-01T00:00:00.000Z",
  );
  assert.equal(
    cache.allowanceCapacityByScenario.scenarios.unresolved_as_fast
      .calibration.status,
    "estimated",
  );
  // The cache's own scan coverage stays the requested window; only the
  // calibration corpus escapes it.
  assert.equal(cache.coveredAt.endAt, "2026-08-20T12:00:00.000Z");
  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
});

test("declared speed baselines resolve unified calibration events before scenario fitting", async () => {
  const directory = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-unified-declared-speed-",
  ));
  const indexFile = join(directory, "local-unified-index-v1.sqlite");
  await writeUnifiedCalibrationFixture(indexFile, {
    resets: [
      Date.parse("2025-05-01T00:00:00.000Z"),
      Date.parse("2025-05-08T00:00:00.000Z"),
      Date.parse("2025-05-15T00:00:00.000Z"),
    ],
  });
  try {
    const cache = await buildReplaySafeAccountingCache({
      now: () => Date.parse("2026-08-20T12:00:00.000Z"),
      unifiedIndexFile: indexFile,
      declaredSpeedBaselines: [{
        firstSeenAt: "2025-05-01T00:00:00.000Z",
        lastSeenAt: "2025-05-24T00:00:00.000Z",
        mode: "standard",
      }],
      scan: scanner([]),
    });
    const standard = cache.allowanceCapacityByScenario.scenarios
      .unresolved_as_standard.calibration;
    const fast = cache.allowanceCapacityByScenario.scenarios
      .unresolved_as_fast.calibration;
    assert.equal(standard.status, "estimated");
    assert.equal(fast.status, "estimated");
    assert.equal(
      standard.estimate.medianApiPriceEquivalentUsd,
      fast.estimate.medianApiPriceEquivalentUsd,
      "a declared Standard corpus has no unresolved events for Fast to inflate",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified calibration canonicalizes a decimal SQLite generation id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-unified-generation-token-"));
  const indexFile = join(directory, "local-unified-index-v1.sqlite");
  await writeUnifiedCalibrationFixture(indexFile, {
    resets: [Date.parse("2025-05-01T00:00:00.000Z")],
    boundaries: 4,
  });

  const database = openLocalUnifiedIndex(indexFile);
  database.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("current_generation_id", "1.0");
  assert.equal(database.prepare(
    "SELECT value FROM meta WHERE key = 'current_generation_id'",
  ).get()?.value, "1.0");
  database.close();

  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    sourceMode: "unified",
    expectedGeneration: 1,
    unifiedIndexFile: indexFile,
    scan: completeUnifiedScanner([], {
      generation: 1,
      startAt: "2026-07-20T12:00:00.000Z",
      endAt: "2026-07-27T12:00:00.000Z",
    }),
  });

  assert.equal(cache.sourceDescriptor.mode, "unified");
  assert.equal(cache.sourceDescriptor.generation, "1");
  assert.equal(cache.weeklyCalibrationInput.source, "unified_index");
  assert.equal(cache.weeklyCalibrationInput.retainedUsageEvents, 3);
});

test("a missing or empty unified index degrades honestly to the windowed corpus", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-unified-fallback-"));
  const missing = await buildReplaySafeAccountingCache({
    now: () => NOW,
    unifiedIndexFile: join(directory, "never-written.sqlite"),
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  assert.equal(missing.weeklyCalibrationInput.source, "windowed_scan");
  assert.equal(missing.weeklyCalibrationInput.retainedUsageEvents, 1);

  // An index that exists but holds no usage rows yet (first refresh mid-build)
  // must also fall back rather than presenting an empty corpus as history.
  const emptyIndexFile = join(directory, "empty-index.sqlite");
  await writeUnifiedCalibrationFixture(emptyIndexFile, { resets: [] });
  const empty = await buildReplaySafeAccountingCache({
    now: () => NOW,
    unifiedIndexFile: emptyIndexFile,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  assert.equal(empty.weeklyCalibrationInput.source, "windowed_scan");
});

// Free-form fixture for the retained-byte budget tests: exact usage
// timestamps and exact quota readings, unlike the reset-shaped calibration
// fixture above.
async function writeUnifiedCorpusFixture(indexFile, { usageEvents, quotaRows }) {
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "unified-calibration-test-v1",
  });
  const modelId = writer.internModel("gpt-5.6-terra", "recognized");
  const tierId = writer.internTier({
    apiServiceTier: "unknown",
    billingSurface: "unknown",
    codexSpeedMode: "unknown",
    tierSource: "unknown",
    providerTierRaw: null,
  });
  const surfaceId = writer.internSurface({
    agentScope: "unknown",
    surface: "unknown",
    threadSource: "unknown",
    lineageDisposition: "unknown",
  });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable",
    reason: null,
    planType: null,
    scopeLocal: null,
  });
  const sessionLocal = Buffer.alloc(32, 9);
  for (const [index, observedAtMs] of usageEvents.entries()) {
    writer.writeUsageEvent({
      eventKey: Buffer.from(`unified-budget-event-${index}`),
      observedAtMs,
      sessionLocal,
      accountScopeId,
      modelId,
      tierId,
      surfaceId,
      reasoningEffort: 8,
      outcome: 5,
      tokensInUncached: 1_000,
    });
  }
  for (const row of quotaRows) {
    writer.internQuota({
      observedAtMs: row.observedAtMs,
      limitId: "codex",
      slot: "secondary",
      planType: "pro",
      usedPercent: row.usedPercent,
      resetsAtMs: row.resetsAtMs,
      durationMins: 10_080,
    });
  }
  await writer.close({ integrityCheck: true, fsyncPath: indexFile });
}

test("the unified usage read refuses incrementally when resident rows project past the byte budget", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "usage-monitor-unified-usage-budget-"),
  );
  const indexFile = join(directory, "local-unified-index-v2.sqlite");
  const tieMs = NOW - 24 * 60 * 60 * 1_000;
  await writeUnifiedCorpusFixture(indexFile, {
    usageEvents: Array.from({ length: 40 }, () => tieMs),
    quotaRows: [0, 1, 2].map((step) => ({
      observedAtMs: tieMs + step * 60_000,
      usedPercent: step,
      resetsAtMs: NOW + 60 * 60 * 1_000,
    })),
  });

  // Retention keeps the newest 5 usage rows, but every row shares one
  // timestamp, so the batched read walks all 40 before trimming. The
  // post-trim corpus (5 usage rows + 3 collapsed snapshots = 1,856 projected
  // bytes) FITS the injected 2,560-byte budget, so this refusal can only
  // come from the incremental accounting inside the batch loop noticing the
  // resident working set (40 rows = 10,240 projected bytes) — the residency
  // the after-the-fact gate never saw.
  await assert.rejects(
    buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: indexFile,
      transitionResourceLimits: { usageEvents: 5, retainedBytes: 2_560 },
      scan: scanner([]),
    }),
    (error) => error?.code === "accounting_calibration_corpus_unavailable",
  );
});

test("the snapshot run-collapse loop stops reading once the retained byte budget is exhausted", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "usage-monitor-unified-snapshot-budget-"),
  );
  const indexFile = join(directory, "local-unified-index-v2.sqlite");
  const baseMs = NOW - 30 * 24 * 60 * 60 * 1_000;
  const snapshotRows = 60_000;
  await writeUnifiedCorpusFixture(indexFile, {
    usageEvents: Array.from(
      { length: 10 },
      (_, index) => baseMs + index * 60_000,
    ),
    quotaRows: Array.from({ length: snapshotRows }, (_, index) => ({
      observedAtMs: baseMs + index * 1_000,
      // Consecutive readings always differ, so the run collapse retains every
      // row and only the byte budget can stop the read.
      usedPercent: (index % 200) / 2,
      resetsAtMs: NOW + 60 * 60 * 1_000,
    })),
  });

  let rssCalls = 0;
  await assert.rejects(
    buildReplaySafeAccountingCache({
      now: () => NOW,
      unifiedIndexFile: indexFile,
      // The 10 usage rows (2,560 projected bytes) fit; the budget dies at the
      // 51st retained snapshot, ~59,950 stream rows before the end.
      transitionResourceLimits: { retainedBytes: 12_288 },
      rss: () => {
        rssCalls += 1;
        return 1_000;
      },
      scan: scanner([]),
    }),
    (error) => error?.code === "accounting_calibration_corpus_unavailable",
  );
  // A read that stops at the refusal never reaches the periodic in-loop
  // memory checks a full 60k-row materialization performs (~29 checks at the
  // 2,048-row cadence). The handful recorded here are the build's fixed
  // phase-boundary checks.
  assert.ok(rssCalls < 15, `expected an early stop, saw ${rssCalls} RSS checks`);
});

// Standing owner rule (2026-08-08): NEVER convenience-sized history windows.
// 31 and 93 — the two values that were actually shipped — must now be
// unrepresentable, not merely unused.
test("convenience-sized scan windows are rejected outright", async () => {
  for (const windowDays of [31, 93, 364]) {
    await assert.rejects(
      buildReplaySafeAccountingCache({
        now: () => NOW,
        windowDays,
        scan: scanner([]),
      }),
      /Replay-safe accounting options are invalid/u,
      `windowDays ${windowDays}`,
    );
  }
});

// The transition miner refuses more than 10,000 derived rows per call; the
// real corpus already holds ~18k weekly transitions. The derivation is
// batched by reset-window group, so a series past the single-call ceiling
// must succeed and keep every transition.
test("weekly transition derivation crosses the single-call row ceiling by group batching", async () => {
  const resetStarts = [
    Date.parse("2026-05-28T00:00:00.000Z"),
    Date.parse("2026-06-04T00:00:00.000Z"),
    Date.parse("2026-06-11T00:00:00.000Z"),
    Date.parse("2026-06-18T00:00:00.000Z"),
  ];
  const boundariesPerReset = 3_001;
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    scan: async ({ onRateLimitSnapshot }) => {
      for (const resetStart of resetStarts) {
        const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
        for (let boundary = 0; boundary < boundariesPerReset; boundary += 1) {
          const observedMs = resetStart + boundary * 60_000;
          onRateLimitSnapshot({
            timestamp: new Date(observedMs).toISOString(),
            timestampMs: observedMs,
            window: {
              provider: "openai_codex",
              planType: "pro",
              limitId: "codex",
              slot: "secondary",
              windowDurationMins: 10_080,
              resetsAt,
              usedPercent: Number((boundary / 100).toFixed(2)),
            },
          });
        }
      }
      return { diagnostics: {} };
    },
  });

  // 4 groups x 3,000 percent changes = 12,000 transitions — strictly more
  // than one derivation call may return, so this passes only through the
  // group-batched path, with every transition retained.
  assert.equal(
    cache.weeklyCalibration.sourceCounts.weeklyTransitions,
    12_000,
  );
  assert.equal(
    cache.weeklyCalibration.sourceCounts.rateLimitSnapshots,
    4 * boundariesPerReset,
  );
});

test("retains exact deterministic quota points for comparison brackets", async () => {
  const snapshots = [
    weeklySnapshot({
      timestamp: "2026-07-27T11:46:00.000Z",
      usedPercent: 10.12349,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:52:00.000Z",
      usedPercent: 20,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:52:00.000Z",
      usedPercent: 19,
      planType: "go",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:30:00.000Z",
      usedPercent: 20.5,
      planType: "prolite",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T12:00:00.000Z",
      usedPercent: 21,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T12:00:00.000Z",
      usedPercent: 40,
      slot: "secondary",
      planType: "edu",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:00:00.000Z",
      usedPercent: 8,
      planType: "private-plan-name",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:15:00.000Z",
      usedPercent: 9,
      provider: "private-provider-name",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:30:00.000Z",
      usedPercent: 9,
      limitId: "codex_bengalfox",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:45:00.000Z",
      usedPercent: 9,
      durationMinutes: 300,
    }),
  ];
  const build = async (orderedSnapshots) => buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) {
        onRateLimitSnapshot(snapshot);
      }
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());

  assert.deepEqual(cache.quotaTimeline, reversed.quotaTimeline);
  assert.deepEqual(cache.quotaTimeline, [
    {
      observedAt: "2026-07-27T10:00:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "unknown",
      usedPercent: 8,
      remainingPercent: 92,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T11:30:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "prolite",
      usedPercent: 20.5,
      remainingPercent: 79.5,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T11:46:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "pro",
      usedPercent: 10.123,
      remainingPercent: 89.877,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T11:52:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "go",
      usedPercent: 19,
      remainingPercent: 81,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    // Track identity is (limitId, duration): the provider's primary and
    // secondary slots are UI roles, so the two same-instant 12:00 readings
    // are one track point and the deterministic tie-break keeps exactly one
    // ("edu" sorts before "pro"). The surviving row's slot is provenance of
    // the winning reading, not a second series.
    {
      observedAt: "2026-07-27T12:00:00.000Z",
      limitId: "codex",
      slot: "secondary",
      planType: "edu",
      usedPercent: 40,
      remainingPercent: 60,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
  ]);
  const serialized = JSON.stringify(cache.quotaTimeline);
  for (const forbidden of [
    "private-plan-name",
    "private-provider-name",
    "codex_bengalfox",
    "accountScope",
    "accountScopeId",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

// The provider reports the weekly window under the `secondary` slot for the
// first half of the range and under `primary` afterwards — the observed
// server-side slot flip of ~2026-07-06. Identity is (limitId, duration), so
// this is ONE continuous duplicate-rich series spanning the flip, not two
// slot-keyed fragments.
test("retains duplicate-rich quota history across 31 days under the cap", async () => {
  const startMs = Date.parse("2026-07-01T00:00:00.000Z");
  const minutes = 31 * 24 * 60;
  const flipMinute = Math.floor(minutes / 2);
  const snapshots = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const timestamp = new Date(startMs + minute * 60_000).toISOString();
    const day = Math.floor(minute / (24 * 60));
    snapshots.push(weeklySnapshot({
      timestamp,
      slot: minute < flipMinute ? "secondary" : "primary",
      usedPercent: day,
    }));
  }
  assert.ok(snapshots.length > 10_000);

  const build = async (orderedSnapshots) => buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    // Re-pinned 31 -> 365 (2026-08-08): the window floor is now 365 days; the
    // fixture still spans 31 days of observations.
    windowDays: 365,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) {
        onRateLimitSnapshot(snapshot);
      }
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());

  assert.deepEqual(cache.quotaTimeline, reversed.quotaTimeline);
  // One merged (limitId, duration) track spans the flip; retention stays
  // under the cap and reaches both ends of the covered window.
  assert.ok(cache.quotaTimeline.length > 0);
  assert.ok(cache.quotaTimeline.length <= 10_000);
  assert.equal(
    new Set(
      cache.quotaTimeline.map((row) => `${row.limitId}:${row.durationMinutes}`),
    ).size,
    1,
  );
  assert.equal(
    cache.quotaTimeline[0].observedAt,
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(
    cache.quotaTimeline.at(-1).observedAt,
    "2026-07-31T23:59:00.000Z",
  );
  assert.equal(
    new Set(cache.quotaTimeline.map((row) => row.observedAt.slice(0, 10))).size,
    31,
  );
  const values = new Set(cache.quotaTimeline.map((row) => row.usedPercent));
  for (let day = 0; day < 31; day += 1) {
    assert.equal(values.has(day), true, `day ${day}`);
  }
  // Slot survives on the rows as provenance of each era of the one track:
  // pre-flip rows carry `secondary`, post-flip rows carry `primary`, and the
  // series is continuous across the boundary.
  const flipMs = Date.parse("2026-07-01T00:00:00.000Z")
    + Math.floor((31 * 24 * 60) / 2) * 60_000;
  for (const row of cache.quotaTimeline) {
    assert.equal(
      row.slot,
      Date.parse(row.observedAt) < flipMs ? "secondary" : "primary",
      `slot provenance at ${row.observedAt}`,
    );
  }
  assert.ok(cache.quotaTimeline.some((row) => row.slot === "secondary"));
  assert.ok(cache.quotaTimeline.some((row) => row.slot === "primary"));
});

// The duplicate-rich case above repeats one value per day, so it never has
// more distinct quota states than the cap and cannot detect an unbounded
// retention path. Real history churns the displayed percentage constantly:
// every retained row is then its own state transition, and prioritising
// transitions without budgeting them returns more rows than the cache is
// allowed to carry. That cache is rejected by its own read validation, which
// is indistinguishable to the owner from having no quota evidence at all.
// Both quota series are finalized by the same retention function and are held
// to the same cap by `validQuotaTimeline`. Spark is used here because weekly
// snapshots additionally feed the transition miner, whose own 10,000-row
// derivation ceiling trips first and would mask the retention defect.
test("churn-rich quota history stays inside the cap and still spans the range", async () => {
  const startMs = Date.parse("2026-07-01T00:00:00.000Z");
  const minutes = 31 * 24 * 60;
  const snapshots = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const timestamp = new Date(startMs + minute * 60_000).toISOString();
    // A distinct displayed percentage on every observation, so every row is a
    // state transition on its track.
    const usedPercent = Number(((minute % 9_901) / 100).toFixed(2));
    for (const [slot, value] of [
      ["primary", usedPercent],
      ["secondary", Number((usedPercent / 2).toFixed(3))],
    ]) {
      snapshots.push(weeklySnapshot({
        timestamp,
        slot,
        limitId: "codex-spark",
        usedPercent: value,
      }));
    }
  }

  const build = async (orderedSnapshots) => buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    // Re-pinned 31 -> 365 (2026-08-08): the window floor is now 365 days; the
    // fixture still spans 31 days of observations.
    windowDays: 365,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) {
        onRateLimitSnapshot(snapshot);
      }
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());
  const timeline = cache.sparkQuotaTimeline;

  assert.deepEqual(timeline, reversed.sparkQuotaTimeline);
  // The cap is an invariant of the cache contract, not a soft preference:
  // `readReplaySafeAccountingCache` refuses a longer series outright.
  assert.equal(timeline.length, 10_000);
  // Retention must reach both ends of the covered window, not just its tail.
  assert.equal(timeline[0].observedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(timeline.at(-1).observedAt, "2026-07-31T23:59:00.000Z");
  assert.equal(
    new Set(timeline.map((row) => row.observedAt.slice(0, 10))).size,
    31,
  );
  // Track identity is (limitId, duration): the primary and secondary
  // readings are ONE merged track, each instant keeping the deterministic
  // tie-break winner (the lower displayed percentage), never a phantom
  // second series keyed by UI slot.
  assert.equal(
    new Set(timeline.map((row) => `${row.limitId}:${row.durationMinutes}`)).size,
    1,
  );
  for (const row of timeline) {
    const minute = Math.round(
      (Date.parse(row.observedAt) - Date.parse("2026-07-01T00:00:00.000Z"))
        / 60_000,
    );
    const primaryPercent = Number(((minute % 9_901) / 100).toFixed(2));
    const secondaryPercent = Number((primaryPercent / 2).toFixed(3));
    assert.equal(
      row.usedPercent,
      Math.min(primaryPercent, secondaryPercent),
      `merged winner at ${row.observedAt}`,
    );
  }
  // No retained neighbour gap may exceed the widest bracket tolerance the
  // dashboard allows for its narrowest comparison window.
  const merged = timeline.map((row) => Date.parse(row.observedAt));
  let widestGapMs = 0;
  for (let index = 1; index < merged.length; index += 1) {
    widestGapMs = Math.max(widestGapMs, merged[index] - merged[index - 1]);
  }
  assert.ok(
    widestGapMs <= 60 * 60 * 1_000,
    `widest retained gap ${widestGapMs}ms`,
  );
});

test("Spark quota observations stay outside the normal weekly quota timeline", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:00.000Z",
        usedPercent: 12,
      }));
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:30.000Z",
        usedPercent: 4,
        limitId: "codex-spark",
        durationMinutes: 300,
      }));
      return { diagnostics: {} };
    },
  });

  assert.deepEqual(cache.quotaTimeline.map((row) => row.limitId), ["codex"]);
  assert.deepEqual(cache.sparkQuotaTimeline, [{
    observedAt: "2026-07-27T11:59:30.000Z",
    limitId: "codex-spark",
    slot: "primary",
    planType: "pro",
    usedPercent: 4,
    remainingPercent: 96,
    durationMinutes: 300,
    resetAt: "2026-08-03T12:00:00.000Z",
    accountAttribution: "historical_unattributed",
  }]);
});

// Real captures report the Spark allowance as `codex_bengalfox`;
// `codex-spark` is the reserved marketing token that has never been observed.
// The scan must retain both, each row keeping its observed limit id — the
// consumers filter with SPARK_QUOTA_LIMIT_IDS — or the cached spark series is
// permanently empty against every real capture.
test("Spark quota snapshots are retained under every real Spark limit id and round-trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-spark-ids-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:58:00.000Z",
        usedPercent: 12,
      }));
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:00.000Z",
        usedPercent: 33,
        limitId: "codex_bengalfox",
        durationMinutes: 300,
      }));
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:30.000Z",
        usedPercent: 4,
        limitId: "codex-spark",
        durationMinutes: 300,
      }));
      return { diagnostics: {} };
    },
  });

  assert.deepEqual(cache.quotaTimeline.map((row) => row.limitId), ["codex"]);
  assert.deepEqual(
    cache.sparkQuotaTimeline.map((row) => [row.limitId, row.usedPercent]),
    [["codex_bengalfox", 33], ["codex-spark", 4]],
  );
  // The mixed-id series survives its own read validation: validQuotaTimeline
  // accepts every id in SPARK_QUOTA_LIMIT_IDS on the spark timeline.
  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
  assert.deepEqual(read.cache, cache);
});

// At one instant the two Spark ids are two tracks whose retained order must
// be the order the read-side sortKey check expects. localeCompare's variable
// punctuation weighting puts "codex_bengalfox" before "codex-spark" while the
// code-unit check puts them the other way around; a cache emitted in
// collation order would be rejected by its own read validation.
test("same-instant readings under both Spark ids stay deterministic and readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-spark-tie-"));
  const cacheFile = join(directory, "accounting.json");
  const snapshots = [
    weeklySnapshot({
      timestamp: "2026-07-27T11:59:00.000Z",
      usedPercent: 33,
      limitId: "codex_bengalfox",
      durationMinutes: 300,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:59:00.000Z",
      usedPercent: 4,
      limitId: "codex-spark",
      durationMinutes: 300,
    }),
  ];
  const build = async (orderedSnapshots) => refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) onRateLimitSnapshot(snapshot);
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());

  assert.deepEqual(cache.sparkQuotaTimeline, reversed.sparkQuotaTimeline);
  assert.deepEqual(
    cache.sparkQuotaTimeline.map((row) => row.limitId),
    ["codex-spark", "codex_bengalfox"],
  );
  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
});

// Every v0.7 cache was built matching "codex-spark" only, so its spark series
// is empty against real captures. The schema bump withholds those caches for
// rebuild instead of serving them as evidence that no Spark history exists.
test("a v0.7 cache with the permanently empty spark series is withheld for rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-spark-stale-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  await writeTestCache(cacheFile, {
    ...cache,
    schemaVersion: "local-replay-safe-accounting-v0.7",
  });

  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "unavailable");
  assert.equal(read.errorCode, "cache_accounting_semantics_outdated");
  // The CURRENT-cache contract stays withheld; the artifact additionally
  // rides the explicit stale channel so the post-update recalculation can
  // serve it labeled (see replay-safe-accounting-stale-serve.test.js).
  assert.equal(read.cache, null);
  assert.equal(
    read.staleCache.schemaVersion,
    "local-replay-safe-accounting-v0.7",
  );
  assert.equal(read.staleCache.stale, true);
});

test("exact retained quota points make an eligible comparison window testable", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-07-27T17:00:00.000Z"),
    scan: async ({ onRateLimitSnapshot }) => {
      for (const timestamp of [
        "2026-07-27T14:59:00.000Z",
        "2026-07-27T15:01:00.000Z",
        "2026-07-27T15:59:00.000Z",
        "2026-07-27T16:01:00.000Z",
      ]) {
        onRateLimitSnapshot(weeklySnapshot({ timestamp, usedPercent: 10 }));
      }
      return { diagnostics: {} };
    },
  });
  const quotaSeries = cache.quotaTimeline.map((row) => ({
    observedAt: row.observedAt,
    receivedAt: row.observedAt,
    usedPercent: row.usedPercent,
  }));
  const result = buildRollingQuotaComparisons({
    resetEvidence: {
      schemaVersion: "quota-reset-evidence-v0.1",
      status: "eligible",
      refusalCodes: [],
      continuityKey: "fixture-continuity",
      resetKey: "fixture-reset",
      accountTrackId: "account-track:v1:fixture",
      provider: "openai",
      planType: "subscription",
      planVariant: "pro",
      limitId: "codex",
      windowDurationMinutes: 10_080,
      policyEpoch: "fixture-policy",
      resetsAt: "2026-08-03T12:00:00.000Z",
      slots: ["primary"],
      firstObservedAt: quotaSeries[0].observedAt,
      lastObservedAt: quotaSeries.at(-1).observedAt,
      snapshotCount: quotaSeries.length,
      usageEventCount: 0,
      totalCostNanousd: 0,
      sourceDatasetCount: 1,
      boundaries: [],
      quotaSeries,
      usageSeries: [],
    },
    capacityForecast: {
      method: "median_of_prior_completed_resets",
      priorResetCount: 2,
      priorResetKeys: ["prior-one", "prior-two"],
      trainedThrough: "2026-07-27T13:00:00.000Z",
      capacityNanousd: 1,
    },
  });
  assert.equal(result.status, "conditional_comparison");
  assert.deepEqual(result.comparisons.map((row) => [
    row.smoothingHours,
    row.windowStart,
    row.windowEnd,
  ]), [[
    1,
    "2026-07-27T15:00:00.000Z",
    "2026-07-27T16:00:00.000Z",
  ]]);
});

test("cache validation requires weighted and bounded timeline evidence so older cache shapes rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-quota-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([usageEvent({
      timestamp: new Date(NOW).toISOString(),
      components: { input_uncached_tokens: 1_000 },
    })]),
  });
  delete cache.timeline[0].speedWeighting;
  await writeTestCache(cacheFile, cache);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const withoutAllowanceCapacity = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  delete withoutAllowanceCapacity.allowanceCapacityByScenario;
  await writeTestCache(cacheFile, withoutAllowanceCapacity);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const withoutQuota = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  delete withoutQuota.quotaTimeline;
  await writeTestCache(cacheFile, withoutQuota);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const rebuilt = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:45:00.000Z",
        usedPercent: 5,
      }));
      return { diagnostics: {} };
    },
  });
  rebuilt.quotaTimeline = Array.from(
    { length: 10_001 },
    () => ({ ...rebuilt.quotaTimeline[0] }),
  );
  await writeTestCache(cacheFile, rebuilt);
  assert.equal(
    (await readReplaySafeAccountingCache({ cacheFile })).errorCode,
    "cache_invalid",
  );
});

test("a replay cache from an older official price registry is withheld", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-pricing-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  await writeTestCache(cacheFile, {
    ...cache,
    priceRegistryVersion: "superseded-price-registry",
  });

  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_price_registry_outdated",
    cache: null,
  });
});

test("a cache from the former current-price basis is withheld for deterministic rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-semantics-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  await writeTestCache(cacheFile, {
    ...cache,
    schemaVersion: "local-replay-safe-accounting-v0.1",
    priceEpochBasis: "current_price_sensitivity_at_registry_observation",
  });

  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "unavailable");
  assert.equal(read.errorCode, "cache_accounting_semantics_outdated");
  assert.equal(read.cache, null);
  // The deterministic rebuild still happens; meanwhile the artifact rides the
  // explicit stale channel with its outdated identity named.
  assert.equal(
    read.staleCache.schemaVersion,
    "local-replay-safe-accounting-v0.1",
  );
});

test("refresh forwards AbortSignal and never writes an aborted projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-abort-"));
  const cacheFile = join(directory, "accounting.json");
  const controller = new AbortController();
  let observedSignal;
  const scan = async (options) => {
    observedSignal = options.signal;
    options.onUsage(usageEvent({
      timestamp: "2026-07-27T11:55:00.000Z",
      components: { input_uncached_tokens: 1_000_000 },
    }));
    controller.abort();
    return { diagnostics: {} };
  };

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW,
      scan,
      signal: controller.signal,
    }),
    (error) => (
      error?.name === "AbortError"
      && error?.code === "accounting_refresh_aborted"
    ),
  );
  assert.equal(observedSignal, controller.signal);
  // State preparation is allowed to create the SQLite container before the
  // scan starts, but an aborted refresh must not store an accounting value.
  assert.equal(await readTestCache(cacheFile), null);
});

test("compact transition input ceilings fail closed without truncating or replacing the last good cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-bounds-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);
  const denseUsageScan = async ({ onUsage }) => {
    for (let index = 0; index < 4; index += 1) {
      onUsage(usageEvent({
        timestamp: `2026-07-27T11:55:0${index}.000Z`,
        components: { input_uncached_tokens: 1 },
      }));
    }
    return { diagnostics: {} };
  };

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: denseUsageScan,
      transitionResourceLimits: { usageEvents: 3 },
    }),
    (error) => error?.code === "accounting_transition_usage_limit_exceeded",
  );
  assert.deepEqual(await readTestCache(cacheFile), before);

  const denseSnapshotScan = async ({ onRateLimitSnapshot }) => {
    for (let index = 0; index < 4; index += 1) {
      const timestampMs = NOW - 10_000 + index * 1_000;
      onRateLimitSnapshot({
        timestamp: new Date(timestampMs).toISOString(),
        timestampMs,
        window: {
          provider: "openai_codex",
          planType: "pro",
          limitId: "codex",
          slot: "secondary",
          windowDurationMins: 10_080,
          resetsAt: Math.floor((NOW + 7 * 24 * 60 * 60 * 1_000) / 1_000),
          usedPercent: index,
        },
      });
    }
    return { diagnostics: {} };
  };
  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 2_000,
      scan: denseSnapshotScan,
      transitionResourceLimits: { weeklySnapshots: 3 },
    }),
    (error) => (
      error?.code === "accounting_transition_snapshot_limit_exceeded"
    ),
  );
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});

// Effective-ceiling arithmetic READ FROM the module rather than mirrored:
// effective = min(absolute, baseline + delta). The tests below pin that
// RELATIONSHIP, so they keep testing the same property when the policy moves;
// the shipped VALUES are pinned once, deliberately, by the tripwire directly
// below. Mirrored literals here would have meant every ceiling test silently
// encoding one particular number, which is how the 2026-08-20 raise found
// three regressions asserting a ceiling the product no longer had.
const ACCOUNTING_RSS_ABSOLUTE =
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.maximumRssBytes;
const ACCOUNTING_RSS_DELTA =
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.rssDeltaBudgetBytes;
// Mirrored from src/export/resource-policy.js: the shared export policy's own
// RSS bound, which clamps the deep-scan guard independently of the above.
const EXPORT_POLICY_MAX_RSS_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
// A realistic resting companion RSS after indexing a large history — the
// baseline the in-process arm of the guard is actually shaped for.
const REALISTIC_COMPANION_BASELINE = 800 * 1024 * 1024;

test("the shipped accounting memory policy is the owner-set pair and a derived child cap", () => {
  // THE TRIPWIRE, and the only place a literal ceiling lives. Everything else
  // derives, so this is what a policy change has to come through — and the
  // rationale for these numbers is in the constants themselves, not in a pull
  // request that will not be read again.
  assert.deepEqual(REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY, {
    maximumRssBytes: 6 * 1024 * 1024 * 1024,
    rssDeltaBudgetBytes: Math.floor(5.25 * 1024 * 1024 * 1024),
    rebuildChildOldSpaceMib: 6_144,
  });
  // DERIVED, not coincident: the child's V8 old-space cap is the absolute
  // target expressed in MiB. Because the effective ceiling is at most the
  // absolute for every baseline, and whole-process RSS always exceeds the JS
  // heap, this ordering is what guarantees the RSS guard reads before V8
  // aborts — a typed accounting_transition_rss_limit_exceeded deferral rather
  // than a SIGABRT the parent can only report as
  // accounting_rebuild_subprocess_failed.
  assert.equal(
    REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.rebuildChildOldSpaceMib * 1024 * 1024,
    REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.maximumRssBytes,
  );
  // Which arm binds where. Off the rebuild child's clean baseline the DELTA is
  // the effective ceiling, so raising the absolute alone would have been inert
  // there; the absolute only takes over above a fat in-process baseline. Both
  // regimes are exercised by the two ceiling tests below, and pinning them
  // here is what stops a future edit from moving a number until one of those
  // tests is quietly testing the same arm twice.
  const cleanChildBaseline = 60 * 1024 * 1024;
  assert.ok(
    cleanChildBaseline + ACCOUNTING_RSS_DELTA < ACCOUNTING_RSS_ABSOLUTE,
    "off a clean child baseline the delta must be the binding ceiling",
  );
  assert.ok(
    REALISTIC_COMPANION_BASELINE + ACCOUNTING_RSS_DELTA >= ACCOUNTING_RSS_ABSOLUTE,
    "off a realistic companion baseline the absolute target must be the "
      + "binding ceiling",
  );
  // The deep-scan phase is clamped by the shared export policy at any baseline
  // below 1.5 GiB, the child's included. Asserted so the asymmetry stays a
  // recorded decision (the observed deferrals were all on the transition path)
  // rather than a surprise found in a later incident.
  assert.ok(
    EXPORT_POLICY_MAX_RSS_BYTES < cleanChildBaseline + ACCOUNTING_RSS_DELTA,
    "the scan phase is expected to be clamped by the export policy rather "
      + "than by the accounting delta; if that stops holding, the scan-guard "
      + "regression below is asserting the wrong regime",
  );
});

test("an RSS ceiling miss during accounting is a soft target: the prior cache is retained and served", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-bound-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);
  assert.notEqual(before, null);
  // Baseline capture, a clean start check, then the post-scan check crosses the
  // absolute ceiling: the injected 100-byte ceiling is far below baseline +
  // delta budget, so this exercises the hard-backstop arm — which is now a soft
  // TARGET, never a hard refresh failure that blanks the dashboard.
  const samples = [50, 50, 101];
  const deferredEvents = [];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    maximumRssBytes: 100,
    rss: () => samples.shift() ?? 101,
    onAccountingRebuildDeferred: (event) => { deferredEvents.push(event); },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:56:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  // No throw escaped to fail the refresh; a degraded/deferred outcome is
  // reported instead, naming the budget it missed.
  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_rss_limit_exceeded");
  assert.equal(outcome.retained, true);
  assert.equal(outcome.generatedAt, before.generatedAt);
  // The honest degraded note was produced — content-free reason + retained.
  // The deferral now carries the three quantities the guard compared. Six days
  // of these misses were undiagnosable because the note recorded only the code:
  // a too-small ceiling, a bloated parent and an unbounded slice all stayed
  // equally consistent with the evidence. Pinned so the payload can never
  // silently narrow back to a bare reason.
  assert.deepEqual(deferredEvents, [{
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
    measurements: {
      baselineRssMib: 0,
      ceilingRssMib: 0,
      observedRssMib: 0,
    },
  }]);
  // The last good cache survives on disk untouched, at its owner-only mode...
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
  // ...and is still SERVED: the surface is available, not blanked.
  const served = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
  });
  assert.equal(served.status, "available");
  assert.deepEqual(served.cache, before);
});

test("the RSS guard is budget-relative: a pass past the delta budget soft-fails below the absolute ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-delta-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const baseline = 200 * 1024 * 1024;
  // Baseline capture and the start check see the companion's resting RSS; the
  // post-scan check sees the pass one byte past its delta budget while still
  // UNDER the absolute ceiling — the delta arm binds, and it is a soft target:
  // the prior cache is retained, the refresh does not fail. The premise is
  // asserted rather than assumed, so a policy change that made the absolute
  // the binding arm at this baseline fails here instead of leaving this test
  // silently exercising the other arm.
  assert.ok(
    baseline + ACCOUNTING_RSS_DELTA < ACCOUNTING_RSS_ABSOLUTE,
    "this test only exercises the delta arm while baseline + delta stays "
      + "below the absolute ceiling",
  );
  const samples = [baseline, baseline, baseline + ACCOUNTING_RSS_DELTA + 1];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    rss: () => samples.shift() ?? baseline + ACCOUNTING_RSS_DELTA + 1,
    scan: scanner([]),
  });

  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_rss_limit_exceeded");
  assert.equal(outcome.retained, true);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a retained-byte budget miss is a soft target that retains the prior cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-bytes-soft-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);
  const deferredEvents = [];

  // The per-row retained-byte meter is likewise advisory: over budget it
  // retains the last good cache rather than failing the refresh.
  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    transitionResourceLimits: { retainedBytes: 1 },
    onAccountingRebuildDeferred: (event) => { deferredEvents.push(event); },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:56:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_memory_budget_exceeded");
  assert.equal(outcome.retained, true);
  // A retained-byte miss is a different guard and records no RSS quantities,
  // so `measurements` is explicitly null rather than absent — a reader can tell
  // "this guard does not meter RSS" from "the metering was lost".
  assert.deepEqual(deferredEvents, [{
    reason: "accounting_transition_memory_budget_exceeded",
    retained: true,
    measurements: null,
  }]);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a memory-budget miss with no prior cache degrades honestly without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-nocache-"));
  const cacheFile = join(directory, "accounting.json");
  // No prior refresh: nothing valid is on disk to retain.
  const samples = [50, 50, 101];
  const deferredEvents = [];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    maximumRssBytes: 100,
    rss: () => samples.shift() ?? 101,
    onAccountingRebuildDeferred: (event) => { deferredEvents.push(event); },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  // Still no unhandled throw, but nothing is fabricated: retained is false and
  // the surface honestly reports insufficient evidence.
  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.retained, false);
  assert.equal(outcome.generatedAt, null);
  assert.deepEqual(deferredEvents, [{
    reason: "accounting_transition_rss_limit_exceeded",
    retained: false,
    measurements: {
      baselineRssMib: 0,
      ceilingRssMib: 0,
      observedRssMib: 0,
    },
  }]);
  assert.equal(await readTestCache(cacheFile), null);
  const served = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
  });
  assert.equal(served.status, "unavailable");
  assert.equal(served.cache, null);
});

test("the 2026-08-11 incident's own reading is in budget and rebuilds normally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-in-budget-"));
  const cacheFile = join(directory, "accounting.json");
  const baseline = REALISTIC_COMPANION_BASELINE;
  // The live-failure reading: ~800 MB baseline, the pass climbs to ~1.6 GB.
  // Under the then-current 1.5 GiB ceiling / 512 MiB delta that hard-failed
  // and blanked the dashboard; every policy shipped since keeps it in budget,
  // so the cache builds. Asserted against the live policy rather than a
  // remembered ceiling, so this stays the incident's regression rather than a
  // test of one particular number.
  const climbed = 1_600 * 1024 * 1024;
  assert.ok(
    climbed <= Math.min(ACCOUNTING_RSS_ABSOLUTE, baseline + ACCOUNTING_RSS_DELTA),
    "the reading that caused the 2026-08-11 incident must stay in budget",
  );
  let calls = 0;
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    rss: () => {
      calls += 1;
      return calls <= 2 ? baseline : climbed;
    },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(period(cache, "7d").events, 1);
});

test("the absolute target is the effective transition ceiling for a realistic companion baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-absolute-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const baseline = REALISTIC_COMPANION_BASELINE;
  // The other arm of the min(). Baseline capture + start check see the ~800 MB
  // resting RSS; the post-scan transition-path check sees the pass one byte
  // past the ABSOLUTE target, which at this baseline is the lower of the two
  // and therefore the exact boundary. Paired with the "1.6 GB completes" test
  // above this brackets the in-process effective ceiling (the 1.6 GB the
  // 2026-08-11 incident tripped at is comfortably under budget at any shipped
  // policy since), and crossing it is a soft target miss.
  assert.ok(
    baseline + ACCOUNTING_RSS_DELTA >= ACCOUNTING_RSS_ABSOLUTE,
    "this test only exercises the absolute arm while a realistic baseline "
      + "plus the delta reaches the absolute ceiling",
  );
  const samples = [baseline, baseline, ACCOUNTING_RSS_ABSOLUTE + 1];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    rss: () => samples.shift() ?? ACCOUNTING_RSS_ABSOLUTE + 1,
    scan: scanner([]),
  });

  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_rss_limit_exceeded");
  assert.equal(outcome.retained, true);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a large companion baseline is not charged against the pass budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-baseline-"));
  const cacheFile = join(directory, "accounting.json");
  const baseline = 1_200 * 1024 * 1024;
  // The companion idles at ~1.2 GiB and the pass climbs a modest 50 MiB:
  // well within its delta budget and under the absolute ceiling, so the
  // rebuild must complete — a high resting baseline alone is never a
  // refusal.
  let calls = 0;
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    rss: () => {
      calls += 1;
      return calls <= 2 ? baseline : baseline + 50 * 1024 * 1024;
    },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(period(cache, "7d").events, 1);
});

test("the scan resource guard inherits the budget-relative RSS ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-guard-limit-"));
  const cacheFile = join(directory, "accounting.json");
  const baseline = 100 * 1024 * 1024;
  let observedGuard = null;
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    rss: () => baseline,
    scan: async ({ resourceGuard }) => {
      observedGuard = resourceGuard;
      return { diagnostics: {} };
    },
  });

  // The deep-scan guard polices the same pass and carries the LOWER of the
  // accounting effective ceiling and the shared export policy's own RSS bound.
  // Asserted as the explicit min() rather than assuming which side wins, so a
  // future move in either constant fails here instead of silently loosening or
  // tightening the scan phase.
  assert.equal(
    observedGuard?.limits.maximumRssBytes,
    Math.min(baseline + ACCOUNTING_RSS_DELTA, EXPORT_POLICY_MAX_RSS_BYTES),
  );
  // At this modest baseline — the shape the rebuild child actually runs at —
  // the export policy's flat bound is the lower of the two since the
  // 2026-08-20 delta raise, so the scan phase is clamped by the export policy
  // while the transition path runs at the full budget-relative ceiling. Pinned
  // explicitly, because that split is a decision (the observed deferrals were
  // all on the transition path) and not an accident of arithmetic.
  assert.equal(
    observedGuard?.limits.maximumRssBytes,
    EXPORT_POLICY_MAX_RSS_BYTES,
  );
  assert.ok(EXPORT_POLICY_MAX_RSS_BYTES < baseline + ACCOUNTING_RSS_DELTA);
});

test("deep log scanning receives hard resource bounds and preserves the last cache when they trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-scan-bound-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  let observedGuard = null;

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: async ({ resourceGuard }) => {
        observedGuard = resourceGuard;
        resourceGuard.observeSourcePlan(
          1,
          resourceGuard.limits.maximumSourceBytes + 1,
        );
        return { diagnostics: {} };
      },
    }),
    (error) => (
      error?.code === "accounting_scan_source_bytes_limit_exceeded"
    ),
  );

  assert.equal(typeof observedGuard?.checkRuntime, "function");
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});

test("the deep-scan guard admits a full rollout corpus and still stops above the source-file ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-scan-files-"));
  const cacheFile = join(directory, "accounting.json");

  // The owner's deduped Codex rollout corpus measured 4,880 files; the ceiling
  // was raised 5_000 -> 100_000 so a real corpus is admitted with headroom.
  let admittedGuard = null;
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ resourceGuard }) => {
      admittedGuard = resourceGuard;
      resourceGuard.observeSourcePlan(4_880, 0);
      return { diagnostics: {} };
    },
  });
  assert.equal(admittedGuard?.counters.sourceFiles, 4_880);
  const before = await readTestCache(cacheFile);

  // Above the ceiling it still stops, and -- unlike the RSS soft miss -- a
  // source_files trip is a hard failure that retains the prior cache intact.
  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: async ({ resourceGuard }) => {
        resourceGuard.observeSourcePlan(
          resourceGuard.limits.maximumSourceFiles + 1,
          0,
        );
        return { diagnostics: {} };
      },
    }),
    (error) => error?.code === "accounting_scan_source_files_limit_exceeded",
  );
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});

test("an AbortSignal can interrupt cooperative derivation after a dense scan and preserves the last cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-derive-abort-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const controller = new AbortController();
  let scanCompleted = false;
  const scan = async ({ onUsage }) => {
    for (let index = 0; index < 5_000; index += 1) {
      onUsage(usageEvent({
        timestamp: new Date(NOW - 10_000 + index).toISOString(),
        components: { input_uncached_tokens: 1 },
      }));
    }
    scanCompleted = true;
    setImmediate(() => controller.abort());
    return { diagnostics: {} };
  };

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan,
      signal: controller.signal,
    }),
    (error) => (
      error?.name === "AbortError"
      && error?.code === "accounting_refresh_aborted"
    ),
  );
  assert.equal(scanCompleted, true);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a failed refresh leaves the last good owner-only cache intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-last-good-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: async () => {
        throw new Error("controlled_scan_failure");
      },
    }),
    /controlled_scan_failure/,
  );

  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});
