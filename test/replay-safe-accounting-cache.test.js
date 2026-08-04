import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  buildReplaySafeAccountingCache,
  readReplaySafeAccountingCache as readReplaySafeAccountingCacheImpl,
  refreshReplaySafeAccountingCache as refreshReplaySafeAccountingCacheImpl,
} from "../src/replay-safe-accounting-cache.js";
import {
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";

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
    windowDays: 31,
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
  assert.equal(observedScanOptions.startAt, "2026-06-26T12:00:00.000Z");
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
  assert.deepEqual(cache.weeklyCalibrationInput, {
    status: "complete",
    encoding: "accounting_compact_v2",
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
    windowDays: 31,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      for (const [resetIndex, resetStart] of resetStarts.entries()) {
        const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
        for (let boundary = 0; boundary < 10; boundary += 1) {
          const observedMs = resetStart + boundary * 60 * 60 * 1_000;
          if (boundary > 0) {
            onUsage(usageEvent({
              timestamp: new Date(observedMs).toISOString(),
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
});

test("retains a deterministic privacy-safe weekly quota point per track and 15-minute bucket", async () => {
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
      planType: "plus",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T12:00:00.000Z",
      usedPercent: 21,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T12:00:00.000Z",
      usedPercent: 40,
      slot: "secondary",
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
      observedAt: "2026-07-27T11:52:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "plus",
      usedPercent: 19,
      remainingPercent: 81,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T12:00:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "pro",
      usedPercent: 21,
      remainingPercent: 79,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T12:00:00.000Z",
      limitId: "codex",
      slot: "secondary",
      planType: "pro",
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

test("cache validation requires the bounded quota timeline so older cache shapes rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-quota-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  delete cache.quotaTimeline;
  await writeTestCache(cacheFile, cache);
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

  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_accounting_semantics_outdated",
    cache: null,
  });
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

test("measured RSS ceiling fails closed during accounting and preserves the last good cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-bound-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const samples = [50, 101];

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      maximumRssBytes: 100,
      rss: () => samples.shift() ?? 101,
      scan: scanner([
        usageEvent({
          timestamp: "2026-07-27T11:55:00.000Z",
          components: { input_uncached_tokens: 1 },
        }),
      ]),
    }),
    (error) => error?.code === "accounting_transition_rss_limit_exceeded",
  );

  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
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
