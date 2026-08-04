import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  buildLocalCompanionSnapshot,
} from "../src/local-companion-data.js";
import {
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import {
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";

const ARTIFACT_FILES = {
  gradient: "2026-07-24-simple-quota-gradient-artifact.json",
  weekly: "2026-07-24-weekly-7-day-calibration-artifact.json",
  quality: "2026-07-24-monitoring-quality-artifact.json",
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-data-"));
  await mkdir(join(root, ".usage-monitor"));
  for (const [kind, file] of Object.entries(ARTIFACT_FILES)) {
    await writeFile(join(root, file), JSON.stringify({
      privateTopLevel: "/Users/private/source",
      snapshot: {
        status: "complete",
        generatedAt: "2026-07-24T12:00:00.000Z",
        datasets: kind === "gradient" ? {
          summary: [{
            capacity_usd: 100,
            lower_80_usd: 80,
            upper_80_usd: 130,
            private_field: "person@example.com",
          }],
          reset_calendar: [{
            announced_at_utc: "2026-07-23T00:00:00.000Z",
            event_type: "global_reset",
            source_url: "https://private.example/",
          }],
        } : kind === "weekly" ? {
          summary: [{ median_weekly_value_usd: 112, qualifying_resets: 8 }],
        } : {
          summary: [{ known_speed_fraction: 0.8 }],
          opportunities: [{
            id: "collector_continuity",
            priority: "P0",
            title: "Keep collection fresh",
            evidence: "No arbitrary content.",
            action: "Collect again.",
          }],
        },
      },
    }));
  }
  for (const file of [
    "2026-07-24-simple-quota-gradient-report.html",
    "2026-07-24-weekly-7-day-calibration-report.html",
    "2026-07-24-monitoring-quality-report.html",
    "2026-07-24-codex-work-account-usage-report.html",
  ]) {
    await writeFile(join(root, file), "<!doctype html><title>report</title>");
  }
  return root;
}

test("local companion builds a closed real-data projection without identifiers or paths", async () => {
  const root = await fixtureRoot();
  try {
    const ledger = [
      {
        schemaVersion: "0.3",
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:00:00.000Z",
        model: "gpt-5.6-sol",
        components: {
          input_uncached_tokens: 100,
          input_cache_read_tokens: 50,
          input_cache_write_tokens: 0,
          output_text_tokens: 20,
          output_reasoning_tokens: 30,
        },
        tierSemantics: { codexSpeedMode: "fast" },
        surfaceClassification: {
          surface: "subagent",
          agentScope: "subagent",
          lineageDisposition: "forked",
        },
        eventKey: "private-event-key",
        accountScope: { scopeId: "private-account-id" },
      },
      {
        schemaVersion: "0.3",
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:30:00.000Z",
        model: "private-model-name",
        components: {
          input_uncached_tokens: 10,
          input_cache_read_tokens: 0,
          input_cache_write_tokens: 0,
          output_text_tokens: 0,
          output_reasoning_tokens: 0,
        },
        tierSemantics: { codexSpeedMode: "not-a-real-mode" },
      },
      {
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T11:45:00.000Z",
        eventKey: "quota-event-key",
        accountScope: { scopeId: "private-account-id" },
        windows: [{
          limitId: "codex",
          slot: "primary",
          planType: "pro",
          usedPercent: 39,
          windowDurationMins: 10080,
          resetsAt: 1784980800,
        }],
      },
      {
        kind: "codex_tool_class_event",
        observedAt: "2026-07-25T11:46:00.000Z",
        toolClass: "subagent",
        eventKey: "tool-event-key",
      },
      {
        kind: "codex_tool_class_event",
        observedAt: "2026-07-25T11:47:00.000Z",
        toolClass: "private-tool-name",
      },
    ];
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${ledger.map((row) => JSON.stringify(row)).join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, ".usage-monitor", "collector-checkpoint-v0.3.json"),
      JSON.stringify({
        schemaVersion: "0.3",
        collectionStartedAt: "2026-07-18T12:00:00.000Z",
        files: {
          "private-inode-key": { offset: 1, privatePath: "/Users/private/rollout.jsonl" },
        },
        diagnostics: {
          filesDiscovered: 3,
          filesInitializedAtEnd: 0,
          rolloutRecordsWritten: 5,
        },
        indexing: {
          status: "recent_7d_complete",
          phase: "complete",
          mode: "recent_7d",
          boundedBy: "modified_at_and_collection_start",
          filesDiscovered: 3,
          filesSelected: 1,
          filesProcessed: 1,
          recordsWritten: 5,
          coveredAt: {
            startAt: "2026-07-18T12:00:00.000Z",
            endAt: "2026-07-25T12:00:00.000Z",
          },
        },
        privateDetail: "person@example.com",
      }),
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.schemaVersion, LOCAL_COMPANION_SCHEMA_VERSION);
    assert.equal(snapshot.mode, "real_local_evidence");
    assert.equal(snapshot.overview.quota.windows[0].remainingPercent, 61);
    assert.equal(snapshot.overview.usage[0].events, 2);
    assert.deepEqual(snapshot.overview.usage[0].byModel.map((row) => row.model), ["gpt-5.6-sol", "unknown"]);
    assert.equal(snapshot.overview.tools.counts.subagent, 1);
    assert.equal(snapshot.overview.tools.counts.other, 1);
    assert.equal(snapshot.overview.collector.malformedLines, 0);
    assert.deepEqual(snapshot.overview.collector.coveredAt, {
      startAt: "2026-07-25T11:00:00.000Z",
      endAt: "2026-07-25T11:47:00.000Z",
    });
    assert.deepEqual(snapshot.overview.collector.recordCounts, {
      usage: 2,
      quota: 1,
      tools: 2,
      other: 0,
    });
    assert.deepEqual(snapshot.overview.collector.exportableCoveredAt, {
      startAt: "2026-07-25T11:00:00.000Z",
      endAt: "2026-07-25T11:47:00.000Z",
    });
    assert.equal(snapshot.overview.collector.indexingState, "recent_7d_complete");
    assert.deepEqual(snapshot.overview.collector.indexing, {
      status: "recent_7d_complete",
      phase: "complete",
      mode: "recent_7d",
      filesDiscovered: 3,
      filesSelected: 1,
      filesProcessed: 1,
      recordsWritten: 5,
      coveredAt: {
        startAt: "2026-07-25T11:00:00.000Z",
        endAt: "2026-07-25T11:47:00.000Z",
      },
      boundedBy: "modified_at_and_collection_start",
    });
    assert.equal(snapshot.overview.timeline.bucketMinutes, 15);
    assert.equal(snapshot.overview.timeline.usage.length, 2);
    assert.equal(snapshot.overview.timeline.usage[0].usageEvents, 1);
    assert.equal(snapshot.overview.timeline.quota.length, 1);
    assert.equal(snapshot.overview.timeline.quota[0].accountAttribution, "unattributed");
    assert.equal(snapshot.overview.accounting.bySpeed.fast.events, 1);
    assert.equal(snapshot.overview.accounting.bySurface.subagent.events, 1);
    assert.equal(snapshot.overview.accounting.byAgentScope.subagent.events, 1);
    assert.equal(snapshot.overview.accounting.byLineage.forked.events, 1);
    assert.equal(snapshot.overview.accounting.reasoningEffortAvailable, false);
    assert.equal(snapshot.overview.accounting.apiPriceCounterfactualTier, "standard");
    assert.deepEqual(snapshot.overview.pricing.historyCoverage, {
      status: "partial",
      phase: "not_started",
      errorCode: "archive_index_unavailable",
      generatedAt: null,
      coveredAt: { startAt: null, endAt: null },
      sourceCount: 0,
      indexedSourceCount: 0,
      pendingSourceCount: 0,
      sourceBytes: 0,
      indexedBytes: 0,
    });
    assert.equal(
      snapshot.overview.monitoringGaps.find((row) => row.id === "ordinary_chat")?.status,
      "excluded",
    );
    // The Fast-mode blind spot reports an attribution share. It must never
    // claim "not observed" while observed Fast evidence is in the projection.
    const fastModeGap = snapshot.overview.monitoringGaps
      .find((row) => row.id === "fast_mode");
    assert.equal(fastModeGap.status, "partial");
    assert.match(
      fastModeGap.explanation,
      /only when it is applied or changed, never at session start/u,
    );
    const fastMode = snapshot.overview.accounting.fastMode;
    assert.equal(fastMode.preference, "standard");
    assert.equal(fastMode.logObservability.sessionBaselineRecorded, false);
    assert.equal(fastMode.metricLabel, "Quota-weighted API-price equivalent");
    assert.deepEqual(fastMode.multipliers, {
      "gpt-5.6": 2.5,
      "gpt-5.5": 2.5,
      "gpt-5.4": 2,
    });
    assert.equal(fastMode.multiplierSource.recordedAt, "2026-08-01");
    assert.deepEqual(fastMode.coverage, {
      totalEvents: 2,
      observedEvents: 1,
      declaredFromConfigEvents: 0,
      assumedFromPreferenceEvents: 1,
      inferredEvents: 0,
      unknownEvents: 0,
      observedSharePercent: 50,
      unknownSharePercent: 0,
    });
    // The only priced event was observed Fast on a GPT-5.6 model, so the
    // weighted total is exactly the published 2.5x of the Standard total.
    assert.equal(
      Math.abs(
        snapshot.overview.accounting.quotaWeightedApiPriceEquivalentUsd
          - snapshot.overview.accounting.apiPriceEquivalentUsd * 2.5,
      ) < 1e-12,
      true,
    );
    assert.equal(
      snapshot.overview.pricing.quotaWeightedTotalCostUsd,
      snapshot.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
    );
    // The Standard-rate figure stays available and unchanged beside it.
    assert.equal(
      snapshot.overview.pricing.totalCostUsd,
      snapshot.overview.accounting.apiPriceEquivalentUsd,
    );
    assert.equal(
      snapshot.overview.pricing.priceEpochBasis,
      "event_time_when_registry_has_effective_evidence",
    );
    assert.equal(
      snapshot.overview.pricing.eventTimeHistoricalTotalUsdExact,
      snapshot.overview.accounting.apiPriceEquivalentUsdExact ?? null,
    );
    assert.equal(snapshot.overview.pricing.currentPriceSensitivityTotalUsdExact, null);
    assert.equal(fastMode.inference.appliedToWeighting, false);
    assert.equal(fastMode.inference.status, "insufficient_signal");
    assert.equal(snapshot.gradient.datasets.summary[0].private_field, undefined);
    assert.equal(snapshot.gradient.datasets.reset_calendar[0].source_url, undefined);
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of [
      "private-event-key",
      "private-account-id",
      "private-model-name",
      "private-tool-name",
      "person@example.com",
      "/Users/private/source",
      "https://private.example/",
      "eventKey",
      "accountScope",
      "private-inode-key",
      "privatePath",
    ]) {
      assert.equal(serialized.includes(privateValue), false, `response leaked ${privateValue}`);
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the stated speed mode attributes unrecorded evidence and never overrides an observed mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-fast-mode-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    const usage = (observedAt, model, codexSpeedMode) => JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt,
      model,
      components: {
        input_uncached_tokens: 1_000_000,
        input_cache_read_tokens: 0,
        input_cache_write_tokens: 0,
        output_text_tokens: 0,
        output_reasoning_tokens: 0,
      },
      tierSemantics: { codexSpeedMode },
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      [
        // Observed Standard on a family with a published Fast rate.
        usage("2026-07-26T11:00:00.000Z", "gpt-5.4", "standard"),
        // No recorded mode: only the stated preference can attribute this.
        usage("2026-07-26T11:10:00.000Z", "gpt-5.4", "unknown"),
      ].map((line) => `${line}\n`).join(""),
      { mode: 0o600 },
    );
    const build = (fastModePreference) => buildLocalCompanionSnapshot({
      root,
      fastModePreference,
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });

    // Each event prices to $5 of Standard-rate API equivalent. Stating
    // Standard leaves the total exactly where it was before weighting existed.
    const standard = await build("standard");
    assert.equal(standard.overview.accounting.apiPriceEquivalentUsd, 10);
    assert.equal(
      standard.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      10,
    );

    // Stating Fast weights only the event whose mode was not recorded; the
    // observed Standard event keeps its observed weight of one. GPT-5.4's
    // published Fast rate is 2x, so $5 + $5 x 2 = $15.
    const fast = await build("fast");
    assert.equal(
      fast.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      15,
    );
    assert.deepEqual(fast.overview.accounting.fastMode.coverage, {
      totalEvents: 2,
      observedEvents: 1,
      declaredFromConfigEvents: 0,
      assumedFromPreferenceEvents: 1,
      inferredEvents: 0,
      unknownEvents: 0,
      observedSharePercent: 50,
      unknownSharePercent: 0,
    });
    assert.deepEqual(fast.overview.accounting.fastMode.appliedMultipliers, {
      "gpt-5.4": 2,
    });

    // Stating "not sure" leaves the unrecorded event explicitly unweighted
    // instead of quietly counting it at the Standard rate.
    const mixed = await build("mixed_unknown");
    assert.equal(
      mixed.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      5,
    );
    assert.equal(
      mixed.overview.accounting.fastMode.unweightedUnknownApiPriceEquivalentUsd,
      5,
    );
    assert.equal(mixed.overview.accounting.fastMode.weightingStatus, "partial");
    assert.equal(mixed.overview.accounting.fastMode.coverage.unknownEvents, 1);
    assert.equal(
      mixed.overview.accounting.fastMode.coverage.unknownSharePercent,
      50,
    );
    assert.equal(
      mixed.overview.monitoringGaps.find((row) => row.id === "fast_mode").status,
      "partial",
    );

    // An unrecognised statement is never treated as Fast.
    const hostile = await build("turbo");
    assert.equal(hostile.overview.accounting.fastMode.preference, "standard");
    assert.equal(
      hostile.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      10,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("collector fallback keeps mixed event-time price provenance while an old replay cache is withheld", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  const olderTerraCard =
    "openai:gpt-5.6-terra:standard:long-through-2026-07-29:official-observed-2026-08-01";
  const lowerTerraCard =
    "openai:gpt-5.6-terra:standard:long-from-2026-07-30:official-observed-2026-08-01";
  try {
    const usage = (observedAt) => JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt,
      model: "gpt-5.6-terra",
      components: { input_uncached_tokens: 1_000_000 },
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      [
        usage("2026-07-29T23:59:59.000Z"),
        usage("2026-07-30T00:00:00.000Z"),
      ].map((line) => `${line}\n`).join(""),
      { mode: 0o600 },
    );
    // This is deliberately a former cache shape: it must be withheld rather
    // than supplying legacy price provenance during the rebuild interval.
    await writeLocalCollectorAccountingCache({ stateFile, cache: {
      schemaVersion: "local-replay-safe-accounting-v0.1",
      priceEpochBasis: "current_price_sensitivity_at_registry_observation",
    } });

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-30T01:00:00.000Z"),
    });

    assert.equal(
      snapshot.overview.pricing.accountingCacheStatus,
      "unavailable",
    );
    assert.equal(
      snapshot.overview.pricing.accountingSource,
      "collector_projection_unverified",
    );
    assert.equal(snapshot.overview.pricing.totalCostUsd, 9);
    assert.equal(snapshot.overview.pricing.eventTimeHistoricalTotalUsdExact, "9");
    assert.deepEqual(snapshot.overview.pricing.priceCardIds, [
      lowerTerraCard,
      olderTerraCard,
    ]);
    assert.deepEqual(snapshot.overview.pricing.priceCardBreakdown, [
      { priceCardId: lowerTerraCard, events: 1, costUsd: "4" },
      { priceCardId: olderTerraCard, events: 1, costUsd: "5" },
    ]);
    assert.equal(snapshot.overview.pricing.mixedPriceCardWindows, true);
    assert.deepEqual(
      snapshot.overview.accounting.periods.find((period) => period.periodId === "7d")
        ?.priceCardBreakdown,
      snapshot.overview.pricing.priceCardBreakdown,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("collector fallback never presents its retained ledger as all local history", async () => {
  const root = await fixtureRoot();
  try {
    const usage = (observedAt) => JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt,
      model: "gpt-5.6-sol",
      components: { input_uncached_tokens: 100 },
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      [
        usage("2026-06-01T12:00:00.000Z"),
        usage("2026-07-25T11:00:00.000Z"),
      ].map((line) => `${line}\n`).join(""),
      { mode: 0o600 },
    );

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const broadest = snapshot.overview.accounting.periods
      .find((period) => period.periodId === "all");
    assert.equal(broadest?.periodLabel, "Cached 31-day collector window");
    assert.equal(broadest?.events, 1);
    assert.equal(snapshot.overview.pricing.historyCoverage.status, "partial");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a declared Codex baseline fills only the turns it actually covers", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-declared-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    const usage = (observedAt, codexSpeedMode) => JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt,
      model: "gpt-5.4",
      components: {
        input_uncached_tokens: 1_000_000,
        input_cache_read_tokens: 0,
        input_cache_write_tokens: 0,
        output_text_tokens: 0,
        output_reasoning_tokens: 0,
      },
      tierSemantics: { codexSpeedMode },
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      [
        // Before the configuration was ever read: the declaration must not
        // reach back to it, however close.
        usage("2026-07-26T09:00:00.000Z", "unknown"),
        // Inside the covered interval, but observed Standard in the log, so
        // the declaration must not touch it either.
        usage("2026-07-26T10:30:00.000Z", "standard"),
        // Inside the covered interval and unobserved: the only turn the
        // declaration is allowed to attribute.
        usage("2026-07-26T10:45:00.000Z", "unknown"),
        // After the newest reading: uncovered again until the next reading.
        usage("2026-07-26T11:30:00.000Z", "unknown"),
      ].map((line) => `${line}\n`).join(""),
      { mode: 0o600 },
    );

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      // "not sure" removes the stated preference as an attribution route, so
      // anything attributed here came from the declaration alone.
      fastModePreference: "mixed_unknown",
      codexSpeedBaselines: [{
        mode: "fast",
        firstSeenAt: "2026-07-26T10:00:00.000Z",
        lastSeenAt: "2026-07-26T11:00:00.000Z",
      }],
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });

    const fastMode = snapshot.overview.accounting.fastMode;
    assert.equal(fastMode.coverage.totalEvents, 4);
    assert.equal(fastMode.coverage.observedEvents, 1);
    assert.equal(fastMode.coverage.declaredFromConfigEvents, 1);
    assert.equal(fastMode.coverage.assumedFromPreferenceEvents, 0);
    assert.equal(fastMode.coverage.unknownEvents, 2);
    // Each event prices to $5 of Standard-rate API equivalent: $5 observed
    // Standard plus $5 declared Fast at GPT-5.4's published 2x, with the two
    // uncovered events left explicitly unweighted rather than counted at 1x.
    assert.equal(snapshot.overview.accounting.apiPriceEquivalentUsd, 20);
    assert.equal(
      snapshot.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      15,
    );
    assert.equal(fastMode.unweightedUnknownApiPriceEquivalentUsd, 10);
    assert.equal(fastMode.weightingStatus, "partial");
    assert.equal(fastMode.declarationSource.neverBackfillsHistory, true);
    assert.deepEqual(
      [...fastMode.declarationSource.retainedKeys],
      ["service_tier"],
    );

    // With no declarations at all the same ledger attributes nothing extra.
    const undeclared = await buildLocalCompanionSnapshot({
      root,
      fastModePreference: "mixed_unknown",
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(
      undeclared.overview.accounting.fastMode.coverage.declaredFromConfigEvents,
      0,
    );
    assert.equal(
      undeclared.overview.accounting.fastMode.coverage.unknownEvents,
      3,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a completed bounded tail is projected as useful partial recent coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-partial-tail-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-25T11:00:00.000Z",
        model: "gpt-5.6-sol",
        components: {
          input_uncached_tokens: 10,
          input_cached_tokens: 0,
          cache_write_tokens: 0,
          output_visible_tokens: 1,
          output_reasoning_tokens: 0,
          output_combined_tokens: 1,
          total_tokens: 11,
        },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, ".usage-monitor", "collector-checkpoint-v0.3.json"),
      JSON.stringify({
        collectionStartedAt: "2026-07-18T12:00:00.000Z",
        files: {},
        diagnostics: {},
        indexing: {
          status: "recent_7d_partial",
          phase: "complete",
          mode: "recent_7d",
          boundedBy: "modified_at_and_collection_start",
          filesDiscovered: 1,
          filesSelected: 1,
          filesProcessed: 1,
          recordsWritten: 1,
          coveredAt: {
            startAt: "2026-07-25T11:00:00.000Z",
            endAt: "2026-07-25T12:00:00.000Z",
          },
        },
      }),
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({ root });
    assert.equal(
      snapshot.overview.collector.indexingState,
      "recent_7d_partial",
    );
    assert.equal(snapshot.overview.collector.indexing.phase, "complete");
    assert.deepEqual(snapshot.overview.collector.indexing.coveredAt, {
      startAt: "2026-07-25T11:00:00.000Z",
      endAt: "2026-07-25T11:00:00.000Z",
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("missing and malformed artifacts fail closed while collector evidence remains available", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-missing-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(join(root, ".usage-monitor", "collector-events.jsonl"), "", { mode: 0o600 });
    await writeFile(
      join(root, ".usage-monitor", "collector-checkpoint-v0.3.json"),
      JSON.stringify({
        collectionStartedAt: "2026-07-25T12:00:00.000Z",
        indexing: {
          mode: "recent_7d",
          status: "recent_7d_complete",
          phase: "paused",
          boundedBy: "modified_at_and_collection_start",
          filesDiscovered: 1,
          filesSelected: 2,
          filesProcessed: 3,
          recordsWritten: 4,
          coveredAt: {
            startAt: "not-an-instant",
            endAt: null,
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(join(root, ARTIFACT_FILES.gradient), "{malformed");
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: true,
    });
    assert.equal(snapshot.gradient.status, "unavailable");
    assert.equal(snapshot.gradient.errorCode, "artifact_malformed");
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(snapshot.weekly.errorCode, "artifact_missing");
    assert.equal(snapshot.reports.every((report) => report.status === "unavailable"), true);
    assert.equal(snapshot.overview.collector.indexingState, "not_started");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("live weekly cache replaces the repo artifact and labels historical account ambiguity", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const collectorFile = join(
      root,
      ".usage-monitor",
      "collector-events.jsonl",
    );
    await writeFile(collectorFile, `${JSON.stringify({
      kind: "codex_tool_class_event",
      observedAt: "2026-07-25T11:30:00.000Z",
      toolClass: "subagent",
      eventKey: "PRIVATE_COLLECTOR_EVENT_KEY",
    })}\n`, { mode: 0o600 });
    await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      windowDays: 31,
      scan: async ({ onUsage, onRateLimitSnapshot }) => {
        onUsage({
          timestamp: "2026-07-25T10:00:00.000Z",
          model: "gpt-5.6-sol",
          components: { input_uncached_tokens: 1_000_000 },
        });
        for (const [timestamp, usedPercent] of [
          ["2026-07-25T10:00:00.000Z", 10],
          ["2026-07-25T11:00:00.000Z", 11],
        ]) {
          onRateLimitSnapshot({
            timestamp,
            timestampMs: Date.parse(timestamp),
            window: {
              provider: "openai_codex",
              planType: "pro",
              limitId: "codex",
              slot: "secondary",
              windowDurationMins: 10_080,
              resetsAt: 1_775_000_000,
              usedPercent,
            },
          });
        }
        return { diagnostics: {} };
      },
    });
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.weekly.dataClass, "live_replay_safe_cache");
    assert.equal(snapshot.weekly.status, "insufficient_evidence");
    assert.equal(
      snapshot.weekly.accountAttribution.label,
      "Historical estimate; account-unattributed and may combine multiple accounts",
    );
    assert.equal(
      snapshot.overview.artifactStatus.weekly.dataClass,
      "live_replay_safe_cache",
    );
    assert.notEqual(
      snapshot.weekly.datasets.summary[0].median_weekly_value_usd,
      112,
    );
    assert.deepEqual(
      snapshot.overview.timeline.quota.map((row) => [
        row.observedAt,
        row.usedPercent,
        row.accountAttribution,
      ]),
      [
        [
          "2026-07-25T10:00:00.000Z",
          10,
          "historical_unattributed",
        ],
        [
          "2026-07-25T11:00:00.000Z",
          11,
          "historical_unattributed",
        ],
      ],
    );
    assert.equal(snapshot.overview.tools.total, 1);
    await assert.rejects(
      stat(`${collectorFile}.projection-v1.json`),
      { code: "ENOENT" },
    );
    await assert.rejects(
      stat(`${collectorFile}.projection-v2.json`),
      { code: "ENOENT" },
    );
    const cachedSnapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(cachedSnapshot.overview.collector.records, 1);
    assert.equal(cachedSnapshot.overview.tools.total, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("malformed live weekly reset rows fail closed without crashing the dashboard", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      "",
      { mode: 0o600 },
    );
    await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      windowDays: 31,
      scan: async () => ({ diagnostics: {} }),
    });
    const cache = (await readLocalCollectorAccountingCache({ stateFile })).cache;
    cache.weeklyCalibration.recentResets = [null];
    await writeLocalCollectorAccountingCache({ stateFile, cache });

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(snapshot.weekly.errorCode, "live_cache_invalid");
    assert.deepEqual(snapshot.weekly.datasets, {});
    assert.equal(snapshot.overview.artifactStatus.weekly.status, "unavailable");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("data store retains its last good snapshot when a reload fails", async () => {
  let calls = 0;
  const store = new LocalCompanionDataStore({
    builder: async () => {
      calls += 1;
      if (calls > 1) throw new Error("private internal failure");
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        generatedAt: "2026-07-25T12:00:00.000Z",
        overview: { marker: "last-good" },
        gradient: {},
        weekly: {},
        quality: {},
        reports: [],
      };
    },
  });
  await store.initialize();
  await assert.rejects(() => store.reload(), /private internal failure/);
  assert.equal(store.getOverview().marker, "last-good");
});
