import test from "node:test";
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  INFORMATIONAL_HISTORY_GAP_MAX_SHARE,
  LocalCompanionDataStore,
  RETAINED_EVIDENCE_REFRESH_WARNING,
  RETAINED_EVIDENCE_RELABELED_WARNINGS,
  RETAINED_PROJECTION_SURFACE_PATHS,
  buildLocalCompanionSnapshot,
  isInformationalTerminalHistoryGap,
} from "../src/local-companion-data.js";
import {
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import {
  refreshLocalArchiveAccountingIndex,
} from "../src/local-archive-accounting-index.js";
import {
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import { emptySpeedWeightingCrossing } from "@app-usagemonitor/accounting";
import {
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "../src/local-unified-index.js";
import {
  readLocalUnifiedCompanionProjection,
} from "../src/local-unified-companion-source.js";

const ARTIFACT_FILES = {
  gradient: "2026-07-24-simple-quota-gradient-artifact.json",
  weekly: "2026-07-24-weekly-7-day-calibration-artifact.json",
  quality: "2026-07-24-monitoring-quality-artifact.json",
};

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "local-companion-data-"));
  const reportDirectory = join(root, ".usage-monitor", "legacy-reports");
  await mkdir(reportDirectory, { recursive: true });
  for (const [kind, file] of Object.entries(ARTIFACT_FILES)) {
    await writeFile(join(reportDirectory, file), JSON.stringify({
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
    await writeFile(join(reportDirectory, file), "<!doctype html><title>report</title>");
  }
  return root;
}

function rolloutUsage(input, output = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

function rolloutToken(timestamp, total, last, usedPercent) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: 1_785_433_600,
        },
        secondary: {
          used_percent: usedPercent,
          window_minutes: 10_080,
          resets_at: 1_785_433_600,
        },
      },
    },
  });
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
    assert.equal(
      snapshot.overview.monitoringGaps.find((row) => row.id === "reasoning_effort")
        ?.status,
      "unavailable",
    );
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
    assert.equal(fastMode.unresolvedScenario, "unresolved_as_standard");
    assert.equal(fastMode.logObservability.sessionBaselineRecorded, false);
    assert.equal(fastMode.metricLabel, "Speed-priced API-price equivalent");
    assert.deepEqual(fastMode.multipliers, {
      "gpt-5.6": 2,
      "gpt-5.5": 2.5,
      "gpt-5.4": 2,
    });
    assert.equal(fastMode.multiplierSource.recordedAt, "2026-08-30");
    assert.deepEqual(fastMode.coverage, {
      totalEvents: 2,
      observedEvents: 1,
      declaredFromConfigEvents: 0,
      assumedEvents: 1,
      inferredEvents: 0,
      unknownEvents: 0,
      observedSharePercent: 50,
      unknownSharePercent: 0,
    });
    // The only priced event was observed Fast on a GPT-5.6 model, so the
    // weighted total is exactly the published 2x Priority ratio of the
    // Standard total.
    assert.equal(
      Math.abs(
        snapshot.overview.accounting.quotaWeightedApiPriceEquivalentUsd
          - snapshot.overview.accounting.apiPriceEquivalentUsd * 2,
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

test("development side-chat estimates adjust only the calibration timeline", async () => {
  const root = await fixtureRoot();
  const codexHome = join(root, ".codex-test");
  try {
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
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
        tierSemantics: { codexSpeedMode: "standard" },
      })}\n`,
      { mode: 0o600 },
    );
    const now = () => Date.parse("2026-07-25T12:00:00.000Z");
    const exact = await buildLocalCompanionSnapshot({
      root,
      now,
    });
    assert.equal(
      Object.hasOwn(exact.overview.timeline, "calibrationUsage"),
      false,
    );
    assert.equal(
      Object.hasOwn(exact.overview.accounting, "sideChatEstimates"),
      false,
    );
    let receivedCodexHome = null;
    let receivedDeclaredBaselines = null;
    const codexSpeedBaselines = [{
      mode: "fast",
      firstSeenAt: "2026-07-25T10:00:00.000Z",
      lastSeenAt: "2026-07-25T12:00:00.000Z",
    }];
    const estimatedSpeedWeighting = emptySpeedWeightingCrossing();
    estimatedSpeedWeighting.unknown["gpt-5.6"] = {
      events: 2,
      apiPriceEquivalentUsd: 1.25,
    };
    const sideChatEstimates = {
      status: "available",
      methodology: {
        includedInCalibrationTimeline: true,
      },
      timeline: [{
        startAt: "2026-07-25T11:00:00.000Z",
        endAt: "2026-07-25T11:15:00.000Z",
        usageEvents: 2,
        totalTokens: 1_000,
        apiPriceEquivalentUsd: 1.25,
        speedWeighting: estimatedSpeedWeighting,
        declaredSpeedWeighting: emptySpeedWeightingCrossing(),
        components: {
          input_uncached_tokens: 10,
          input_cache_read_tokens: 900,
          input_cache_write_tokens: 0,
          output_text_tokens: 90,
          output_reasoning_tokens: 0,
          output_combined_tokens: 0,
        },
        pricingCoverage: {
          fullyPricedEvents: 2,
          partiallyPricedEvents: 0,
          unpricedEvents: 0,
        },
      }],
      periods: [],
      recent: [],
    };
    const adjusted = await buildLocalCompanionSnapshot({
      root,
      codexHome,
      includeDevelopmentSideChatEstimates: true,
      codexSpeedBaselines,
      sideChatEstimateCollector: async (options) => {
        receivedCodexHome = options.codexHome;
        receivedDeclaredBaselines = options.declaredSpeedBaselines;
        return sideChatEstimates;
      },
      now,
    });
    assert.equal(receivedCodexHome, codexHome);
    assert.deepEqual(receivedDeclaredBaselines, codexSpeedBaselines);
    assert.deepEqual(
      adjusted.overview.timeline.usage,
      exact.overview.timeline.usage,
    );
    assert.equal(
      adjusted.overview.accounting.apiPriceEquivalentUsd,
      exact.overview.accounting.apiPriceEquivalentUsd,
    );
    assert.equal(
      adjusted.overview.accounting.sideChatEstimates,
      sideChatEstimates,
    );
    const exactBucket = exact.overview.timeline.usage[0];
    const calibrationBucket = adjusted.overview.timeline.calibrationUsage[0];
    assert.equal(calibrationBucket.usageEvents, exactBucket.usageEvents + 2);
    assert.equal(calibrationBucket.totalTokens, exactBucket.totalTokens + 1_000);
    assert.equal(
      calibrationBucket.apiPriceEquivalentUsd,
      exactBucket.apiPriceEquivalentUsd + 1.25,
    );
    assert.deepEqual(
      adjusted.overview.timeline.allowanceWeightingEncoding,
      {
        schemaVersion: "quota-weighted-timeline-v0.1",
        basisFamilyId:
          "codex_primary:speed_priced_api_equivalent:v2:priority_price_ratio_2026_08_30:event_time:observed_declared_scenario",
        scenarioOrder: [
          "unresolved_as_standard",
          "unresolved_as_fast",
        ],
        selectedScenario: "unresolved_as_standard",
      },
    );
    assert.equal(calibrationBucket.allowanceWeighting.length, 16);
    assert.equal(
      calibrationBucket.allowanceWeighting[9],
      exactBucket.allowanceWeighting[9] + 2.5,
    );
    // Fast scenario block: status, weighted USD, covered USD, observed,
    // declared, preference-assumed, inferred, unresolved.
    assert.equal(calibrationBucket.allowanceWeighting[8], 0);
    assert.equal(calibrationBucket.allowanceWeighting[13], 2);
    assert.equal(
      calibrationBucket.components.input_cache_read_tokens,
      exactBucket.components.input_cache_read_tokens + 900,
    );
    const withheld = await buildLocalCompanionSnapshot({
      root,
      codexHome,
      includeDevelopmentSideChatEstimates: true,
      sideChatEstimateCollector: async () => ({
        ...sideChatEstimates,
        methodology: {
          includedInCalibrationTimeline: false,
          calibrationStatus: "withheld_partial_retention",
        },
      }),
      now,
    });
    assert.deepEqual(
      withheld.overview.timeline.calibrationUsage,
      exact.overview.timeline.usage,
    );
    assert.equal(
      withheld.overview.accounting.apiPriceEquivalentUsd,
      exact.overview.accounting.apiPriceEquivalentUsd,
    );
    assert.equal(
      withheld.overview.accounting.sideChatEstimates.methodology
        .calibrationStatus,
      "withheld_partial_retention",
    );
    let historicalGapOptions = null;
    await buildLocalCompanionSnapshot({
      root,
      codexHome,
      includeDevelopmentSideChatEstimates: true,
      codexSpeedBaselines,
      developmentSideChatHistoricalGapDate: "2026-07-13",
      sideChatEstimateCollector: async () => ({
        status: "unavailable",
        methodology: null,
        timeline: [],
      }),
      sideChatHistoricalGapCollector: async (options) => {
        historicalGapOptions = options;
        return { status: "unavailable", errorCode: "fixture_unavailable" };
      },
      now,
    });
    assert.deepEqual(
      historicalGapOptions.declaredSpeedBaselines,
      codexSpeedBaselines,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw rollout history reaches the companion through the archive projection with event-time prices", async () => {
  const root = await fixtureRoot();
  const codexHome = join(root, ".codex");
  const sessions = join(codexHome, "sessions");
  const archiveIndexFile = join(
    root,
    ".usage-monitor",
    "local-archive-accounting-index-v1.sqlite",
  );
  const archiveSecretFile = join(
    root,
    ".usage-monitor",
    "local-archive-accounting-index-v1-secret",
  );
  const oldTerraCard =
    "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30";
  const newTerraCard =
    "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-30";
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "rollout-2026-07-25T12-00-00-history.jsonl"),
      `${[
        JSON.stringify({
          timestamp: "2026-07-25T12:00:00.000Z",
          type: "session_meta",
          payload: { id: "PRIVATE_ARCHIVE_SESSION" },
        }),
        JSON.stringify({
          timestamp: "2026-07-25T12:00:00.010Z",
          type: "turn_context",
          payload: { model: "gpt-5.6-terra" },
        }),
        // Recognized historical Terra events remain priceable before the
        // review date. July 29 uses the old card and July 30 the lower new
        // card.
        rolloutToken(
          "2026-07-25T12:01:00.000Z",
          rolloutUsage(1_000_000),
          rolloutUsage(1_000_000),
          1,
        ),
        rolloutToken(
          "2026-07-29T23:59:59.000Z",
          rolloutUsage(2_000_000),
          rolloutUsage(1_000_000),
          2,
        ),
        rolloutToken(
          "2026-07-30T00:00:00.000Z",
          rolloutUsage(3_000_000),
          rolloutUsage(1_000_000),
          3,
        ),
      ].join("\n")}\n`,
      { mode: 0o600 },
    );

    const refreshed = await refreshLocalArchiveAccountingIndex({
      indexFile: archiveIndexFile,
      secretFile: archiveSecretFile,
      codexHome,
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
      workerCount: 1,
    });
    assert.equal(refreshed.status, "complete");
    assert.equal(refreshed.projectionStatus, "available");

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      archiveIndexFile,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    });
    const history = snapshot.overview.accounting.periods
      .find((period) => period.periodId === "history");
    assert.ok(history);
    assert.equal(history.periodLabel, "Indexed history");
    assert.equal(history.events, 3);
    assert.equal(history.totalTokens, 3_000_000);
    assert.equal(history.apiPriceEquivalentUsd, 7);
    assert.deepEqual(history.pricingCoverage, {
      fullyPricedEvents: 3,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    });
    assert.deepEqual(history.priceCardIds, [newTerraCard, oldTerraCard]);
    assert.deepEqual(history.priceCardBreakdown, [
      { priceCardId: newTerraCard, events: 1, costUsd: "2" },
      { priceCardId: oldTerraCard, events: 2, costUsd: "5" },
    ]);
    assert.equal(history.evidenceStartDate, "2026-07-26");
    assert.equal(snapshot.overview.accounting.evidenceStartDate, "2026-07-26");
    assert.equal(snapshot.overview.pricing.evidenceStartDate, "2026-07-26");
    assert.equal(snapshot.overview.accounting.historyPeriodStatus, "available");
    assert.equal(snapshot.overview.accounting.historyCoverage.status, "complete");
    assert.equal(
      snapshot.overview.pricing.priceEpochBasis,
      "event_time_when_registry_has_effective_evidence",
    );
    assert.equal(
      JSON.stringify(snapshot).includes("PRIVATE_ARCHIVE_SESSION"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local companion relays bounded durations and selects a deterministic primary window", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-generic-quota-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T11:45:00.000Z",
        windows: [
          {
            limitId: "codex",
            slot: "secondary",
            planType: "go",
            usedPercent: 20,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "arbitrary-plan-name",
            usedPercent: 30,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "prolite",
            usedPercent: 40,
            windowDurationMins: 300,
            resetsAt: 1_784_916_000,
          },
          {
            limitId: "codex",
            slot: "secondary",
            planType: "pro",
            usedPercent: 50,
            windowDurationMins: 10_080,
            resetsAt: 1_785_376_800,
          },
          {
            limitId: "codex_bengalfox",
            slot: "primary",
            planType: "edu",
            usedPercent: 60,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "future_alpha",
            limitName: "Future Alpha",
            slot: "primary",
            planType: "plus",
            usedPercent: 61,
            windowDurationMins: 1_440,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "future_beta",
            limitName: "Account alice@example.com",
            slot: "primary",
            planType: "plus",
            usedPercent: 62,
            windowDurationMins: 43_200,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "pro",
            usedPercent: 70,
            windowDurationMins: 0,
            resetsAt: 1_784_980_800,
          },
          {
            limitId: "codex",
            slot: "primary",
            planType: "pro",
            usedPercent: 80,
            windowDurationMins: 525_601,
            resetsAt: 1_784_980_800,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const windows = snapshot.overview.quota.windows;
    assert.deepEqual(
      windows.map((window) => [
        window.limitId,
        window.slot,
        window.durationMinutes,
        window.planType,
      ]),
      [
        ["codex", "primary", 43_200, "unknown"],
        ["codex", "secondary", 43_200, "go"],
        ["codex", "primary", 300, "prolite"],
        ["codex", "secondary", 10_080, "pro"],
        ["codex_bengalfox", "primary", 43_200, "edu"],
        ["future_alpha", "primary", 1_440, "plus"],
        ["future_beta", "primary", 43_200, "plus"],
      ],
    );
    assert.equal(windows.find((window) => window.limitId === "future_alpha").limitName, "Future Alpha");
    assert.equal(
      Object.hasOwn(windows.find((window) => window.limitId === "future_beta"), "limitName"),
      false,
    );
    assert.equal(new Set(windows.map((window) => window.limitId)).has("unknown"), false);
    assert.equal(snapshot.overview.quotaWindows[0].durationMinutes, 43_200);
    assert.equal(
      JSON.stringify(snapshot).includes("monthly"),
      false,
    );
    assert.equal(
      Object.hasOwn(snapshot.overview.quota.windows[0], "planType"),
      true,
    );
    assert.equal(snapshot.overview.quota.windows[0].planType, "unknown");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("local companion excludes invalid quota windows before presentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-companion-invalid-quota-"));
  try {
    await mkdir(join(root, ".usage-monitor"));
    const validWindow = {
      limitId: "codex",
      slot: "primary",
      planType: "go",
      usedPercent: 20,
      windowDurationMins: 300,
      resetsAt: 1_784_916_000,
    };
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "2026-07-25T11:45:00.000Z",
        windows: [
          validWindow,
          { ...validWindow, resetsAt: 0 },
          { ...validWindow, resetsAt: Number.MAX_SAFE_INTEGER },
          { ...validWindow, resetsAt: "not-a-date" },
          { ...validWindow, windowDurationMins: -1 },
          { ...validWindow, windowDurationMins: 525_601 },
          { ...validWindow, usedPercent: -1 },
          { ...validWindow, usedPercent: 101 },
        ],
      })}\n${JSON.stringify({
        kind: "codex_quota_snapshot",
        observedAt: "not-a-date",
        windows: [validWindow],
      })}\n`,
      { mode: 0o600 },
    );

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });

    assert.deepEqual(
      snapshot.overview.quota.windows.map((window) => [
        window.planType,
        window.usedPercent,
        window.durationMinutes,
        window.resetAt,
      ]),
      [[
        "go",
        20,
        300,
        new Date(1_784_916_000 * 1_000).toISOString(),
      ]],
    );
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
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });

    // Each event prices to $5 of Standard-rate API equivalent. The
    // unrecorded event is attributed to Standard as a visible assumption, so
    // the selected total stays at the Standard figure while the
    // unresolved-as-Fast sensitivity stays visible in the timeline encoding.
    assert.equal(snapshot.overview.accounting.apiPriceEquivalentUsd, 10);
    assert.equal(
      snapshot.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      10,
    );
    assert.deepEqual(snapshot.overview.accounting.fastMode.coverage, {
      totalEvents: 2,
      observedEvents: 1,
      declaredFromConfigEvents: 0,
      assumedEvents: 1,
      inferredEvents: 0,
      unknownEvents: 0,
      observedSharePercent: 50,
      unknownSharePercent: 0,
    });
    assert.equal(
      snapshot.overview.accounting.fastMode.unresolvedScenario,
      "unresolved_as_standard",
    );
    assert.equal(
      snapshot.overview.timeline.allowanceWeightingEncoding.selectedScenario,
      "unresolved_as_standard",
    );
    // Standard-scenario column: both dollars at 1x. Fast-scenario column:
    // the observed Standard event keeps its observed weight of one while the
    // assumed event is re-attributed at GPT-5.4's published 2x Priority
    // ratio, so $5 + $5 x 2 = $15.
    assert.equal(snapshot.overview.timeline.usage[0].allowanceWeighting[1], 10);
    assert.equal(snapshot.overview.timeline.usage[0].allowanceWeighting[9], 15);
    assert.equal(
      snapshot.overview.monitoringGaps.find((row) => row.id === "fast_mode").status,
      "partial",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an idle-period cache older than the wall clock threshold stays available with no stale banner", async () => {
  // Reproduces the owner's screenshot conflict: the newest observation is a
  // quota snapshot from one minute ago, while the replay-safe cache was last
  // rebuilt 54 minutes ago because the refresh loop reuses it on passes with
  // no new rollout usage. No usage evidence exists beyond the cache's
  // coverage end, so the accounting is complete, not stale.
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const usage = (observedAt) => JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt,
      model: "gpt-5.6-sol",
      components: { input_uncached_tokens: 100 },
    });
    const quota = (observedAt) => JSON.stringify({
      kind: "codex_quota_snapshot",
      observedAt,
      windows: [],
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      [
        usage("2026-07-25T11:00:00.000Z"),
        quota("2026-07-25T12:53:00.000Z"),
      ].map((line) => `${line}\n`).join(""),
      { mode: 0o600 },
    );
    await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      windowDays: 365,
      scan: async ({ onUsage }) => {
        onUsage({
          timestamp: "2026-07-25T11:00:00.000Z",
          model: "gpt-5.6-sol",
          components: { input_uncached_tokens: 100 },
        });
        return { diagnostics: {} };
      },
    });

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:54:00.000Z"),
    });
    assert.equal(snapshot.overview.freshness.status, "live");
    assert.equal(snapshot.overview.freshness.accountingStatus, "available");
    assert.equal(snapshot.overview.pricing.accountingCacheStatus, "available");
    assert.equal(snapshot.overview.accounting.accountingCacheStatus, "available");
    // The raw rebuild age remains published for a reader that wants it.
    assert.equal(snapshot.overview.freshness.accountingAgeSeconds, 54 * 60);
    assert.ok(!snapshot.overview.warnings.some((warning) => (
      warning.includes("shown as stale")
    )));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a cache genuinely outrun by newer usage evidence still reports stale", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
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
        usage("2026-07-25T11:00:00.000Z"),
        // Usage evidence 40 minutes past the cache's coverage end: the
        // cached totals genuinely miss it, so the honest verdict is stale.
        usage("2026-07-25T12:40:00.000Z"),
      ].map((line) => `${line}\n`).join(""),
      { mode: 0o600 },
    );
    await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
      windowDays: 365,
      scan: async ({ onUsage }) => {
        onUsage({
          timestamp: "2026-07-25T11:00:00.000Z",
          model: "gpt-5.6-sol",
          components: { input_uncached_tokens: 100 },
        });
        return { diagnostics: {} };
      },
    });

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:54:00.000Z"),
    });
    assert.equal(snapshot.overview.freshness.accountingStatus, "stale");
    assert.equal(snapshot.overview.pricing.accountingCacheStatus, "stale");
    // The red banner sentence stays retired even when stale is honest; the
    // machine-readable status carries the fact.
    assert.ok(!snapshot.overview.warnings.some((warning) => (
      warning.includes("shown as stale")
    )));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("collector fallback keeps mixed event-time price provenance while an old replay cache is withheld", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  const olderTerraCard =
    "openai:gpt-5.6-terra:standard:long-through-2026-07-29:official-observed-2026-08-30";
  const lowerTerraCard =
    "openai:gpt-5.6-terra:standard:long-from-2026-07-30:official-observed-2026-08-30";
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
    assert.equal(fastMode.coverage.assumedEvents, 2);
    assert.equal(fastMode.coverage.unknownEvents, 0);
    // Each event prices to $5 of Standard-rate API equivalent: $5 observed
    // Standard plus $5 declared Fast at GPT-5.4's published 2x, with the two
    // uncovered events attributed to Standard as a visible assumption.
    assert.equal(snapshot.overview.accounting.apiPriceEquivalentUsd, 20);
    assert.equal(
      snapshot.overview.accounting.quotaWeightedApiPriceEquivalentUsd,
      25,
    );
    assert.equal(fastMode.unweightedUnknownApiPriceEquivalentUsd, 0);
    assert.equal(fastMode.weightingStatus, "complete");
    assert.equal(fastMode.declarationSource.neverBackfillsHistory, true);
    assert.deepEqual(
      [...fastMode.declarationSource.retainedKeys],
      ["service_tier"],
    );

    // With no declarations at all the same ledger attributes nothing extra.
    const undeclared = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });
    assert.equal(
      undeclared.overview.accounting.fastMode.coverage.declaredFromConfigEvents,
      0,
    );
    assert.equal(
      undeclared.overview.accounting.fastMode.coverage.assumedEvents,
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
    await mkdir(join(root, ".usage-monitor", "legacy-reports"), { recursive: true });
    await writeFile(
      join(root, ".usage-monitor", "legacy-reports", ARTIFACT_FILES.gradient),
      "{malformed",
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: true,
    });
    assert.equal(snapshot.gradient.status, "unavailable");
    assert.equal(snapshot.gradient.errorCode, "artifact_malformed");
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(
      snapshot.weekly.errorCode,
      "allowance_capacity_cache_unavailable",
    );
    assert.equal(Object.hasOwn(snapshot, "reports"), false);
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
      // Re-pinned 31 -> 365 (2026-08-08): the standing owner rule forbids
      // convenience-sized history windows, so 365 is the smallest accepted.
      windowDays: 365,
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
    // The diagnostic contract is still attached when recent accounting comes
    // from the replay-safe cache. With no unified index, it is explicitly
    // unavailable rather than presented as a measured zero.
    assert.equal(
      snapshot.overview.accounting.cacheSwitchImpact.status,
      "unavailable",
    );
    assert.deepEqual(
      snapshot.overview.accounting.cacheSwitchImpact.periods,
      [],
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.status,
      "unavailable",
    );
    assert.deepEqual(
      snapshot.overview.accounting.cacheContinuityImpact.periods,
      [],
    );
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

// The diagnostic weekly fit remains Standard-priced. Until composition is
// fitted independently on the selected speed-priced basis, its vector must
// not leak into an allowance-facing card whose scalar uses Fast weighting.
test("the Standard diagnostic fitted mix does not leak into the weighted allowance card", async () => {
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
      windowDays: 365,
      scan: async () => ({ diagnostics: {} }),
    });
    const composition = {
      status: "fitted",
      grainHours: 2,
      observationCount: 120,
      capacityUsdByModel: {
        "gpt-5.6-sol": 2_500,
        "gpt-5.6-terra": 900,
        other: 1_900,
      },
      // Luna is a tenth of the floor: fitted, folded, and priced at "other".
      modelCostShares: {
        "gpt-5.6-sol": 0.5,
        "gpt-5.5": 0.4,
        "gpt-5.6-terra": 0.0977,
        "gpt-5.6-luna": 0.002,
        "gpt-5.4-mini": 0.0003,
      },
      r2: 0.8,
      singleConstantUsd: 2_000,
      singleConstantR2: 0.7,
      blendedRecentMixUsd: 2_050,
      recentMixDays: 14,
    };
    const cache = (await readLocalCollectorAccountingCache({ stateFile })).cache;
    cache.weeklyCalibration.composition = composition;
    await writeLocalCollectorAccountingCache({ stateFile, cache });

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const summary = snapshot.weekly.datasets.summary[0];
    assert.equal(snapshot.weekly.dataClass, "live_replay_safe_cache");
    assert.equal(summary.capacity_by_model, null);
    assert.equal(summary.model_cost_shares, null);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an out-of-range fitted-mix share fails closed like any other cache defect", async () => {
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
      windowDays: 365,
      scan: async () => ({ diagnostics: {} }),
    });
    const cache = (await readLocalCollectorAccountingCache({ stateFile })).cache;
    cache.weeklyCalibration.composition = {
      status: "fitted",
      grainHours: 2,
      observationCount: 120,
      capacityUsdByModel: { "gpt-5.6-sol": 2_500 },
      modelCostShares: { "gpt-5.6-luna": 2 },
      r2: 0.8,
      singleConstantUsd: 2_000,
      singleConstantR2: 0.7,
      blendedRecentMixUsd: 2_050,
      recentMixDays: 14,
    };
    await writeLocalCollectorAccountingCache({ stateFile, cache });

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(snapshot.weekly.errorCode, "live_cache_invalid");
    assert.deepEqual(snapshot.weekly.datasets, {});
  } finally {
    await rm(root, { recursive: true });
  }
});

test("malformed selected allowance-capacity rows fail closed without crashing the dashboard", async () => {
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
      // Re-pinned 31 -> 365 (2026-08-08): the standing owner rule forbids
      // convenience-sized history windows, so 365 is the smallest accepted.
      windowDays: 365,
      scan: async () => ({ diagnostics: {} }),
    });
    const cache = (await readLocalCollectorAccountingCache({ stateFile })).cache;
    cache.allowanceCapacityByScenario.scenarios
      .unresolved_as_standard.calibration.recentResets = [null];
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

test("an aborted candidate cannot publish after its projection completes", async () => {
  let calls = 0;
  let releaseCandidate;
  let candidateStarted;
  const candidateGate = new Promise((resolve) => {
    releaseCandidate = resolve;
  });
  const candidateEntered = new Promise((resolve) => {
    candidateStarted = resolve;
  });
  const snapshot = (marker) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-07-25T12:00:00.000Z",
    overview: { marker },
    gradient: {},
    weekly: {},
    quality: {},
    reports: [],
  });
  const store = new LocalCompanionDataStore({
    builder: async () => {
      calls += 1;
      if (calls === 1) return snapshot("last-good");
      candidateStarted();
      await candidateGate;
      return snapshot("must-not-publish");
    },
  });
  await store.reload();
  const controller = new AbortController();
  const reload = store.reload({
    purpose: "full",
    signal: controller.signal,
  });
  await candidateEntered;
  controller.abort();
  releaseCandidate();
  await assert.rejects(
    reload,
    (error) => error?.code === "local_companion_snapshot_reload_aborted",
  );
  assert.equal(store.getOverview().marker, "last-good");
});

test("a deferred quick reload keeps the projection surfaces it cannot rebuild", async () => {
  // A quick reload is answered with a DEFERRED unified projection, whose
  // gradient/weekly datasets come back as empty arrays rather than absent.
  // Publishing that wholesale blanked both charts on every refresh cycle and
  // refilled them at completion, which reads as data repeatedly vanishing.
  const snapshotFor = (purpose) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-20T21:00:00.000Z",
    overview: { marker: purpose },
    gradient: {
      datasets: ["startup", "quick"].includes(purpose)
        ? { rolling: [], curve: [] }
        : { rolling: [{ at: 1 }, { at: 2 }], curve: [{ at: 1 }] },
    },
    weekly: {
      datasets: ["startup", "quick"].includes(purpose)
        ? { weekly_values: [] }
        : { weekly_values: [{ sequence: 1 }] },
    },
    quality: {},
    reports: [],
  });
  const store = new LocalCompanionDataStore({
    builder: async ({ purpose = "full" } = {}) => snapshotFor(purpose),
  });

  await store.reload({ purpose: "full" });
  assert.equal(store.getGradient().datasets.rolling.length, 2);
  assert.equal(store.getWeekly().datasets.weekly_values.length, 1);

  // The quick pass publishes its fresh overview but must not blank the charts.
  await store.reload({ purpose: "quick" });
  assert.equal(store.getOverview().marker, "quick");
  assert.equal(store.getGradient().datasets.rolling.length, 2);
  assert.equal(store.getGradient().datasets.curve.length, 1);
  assert.equal(store.getWeekly().datasets.weekly_values.length, 1);

  // A FULL reload is still authoritative in both directions: a genuine
  // transition to empty must land, or this would pin stale figures forever.
  const emptying = new LocalCompanionDataStore({
    builder: async ({ purpose = "full" } = {}) => ({
      ...snapshotFor(purpose),
      gradient: { datasets: { rolling: [], curve: [] } },
      weekly: { datasets: { weekly_values: [] } },
    }),
  });
  await emptying.reload({ purpose: "full" });
  assert.equal(emptying.getGradient().datasets.rolling.length, 0);
  assert.equal(emptying.getWeekly().datasets.weekly_values.length, 0);
});

test("weekly pace reads re-project the strict forecast at request time", async () => {
  const nowMs = Date.parse("2026-08-03T12:00:00.000Z");
  const resetsAt = new Date(nowMs + 100 * 60 * 60_000).toISOString();
  const forecast = {
    schemaVersion: "local-weekly-pace-forecast-v0.2",
    status: "will_reach_reset_first",
    currentUsedPercent: 50,
    remainingPercent: 50,
    resetsAt,
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 2,
      elapsedHours: 2,
      movementPp: 0.4,
      activePercentagePointsPerHour: 0.2,
      overallPercentagePointsPerHour: 0.2,
    },
    observationCount: 3,
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: 100,
  };
  let builds = 0;
  const store = new LocalCompanionDataStore({
    builder: async () => {
      builds += 1;
      return {
        schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
        mode: "real_local_evidence",
        generatedAt: new Date(nowMs).toISOString(),
        overview: {},
        gradient: {},
        weekly: {
          datasets: {},
          paceForecast: forecast,
          paceOutlook: { marker: "must-not-be-served" },
        },
        quality: {},
        reports: [],
      };
    },
  });
  await store.reload();

  const initial = store.getWeeklyPaceOutlook({ nowMs });
  const oneHourLater = store.getWeeklyPaceOutlook({
    nowMs: nowMs + 60 * 60_000,
  });
  assert.equal(builds, 1);
  assert.equal(initial.status, "available");
  assert.equal(initial.standing, "under");
  assert.equal(initial.projection.hoursToReset, 100);
  assert.equal(oneHourLater.projection.hoursToReset, 99);
  assert.ok(oneHourLater.projection.sparePercent > initial.projection.sparePercent);
  assert.deepEqual(
    store.getWeekly({ nowMs: nowMs + 60 * 60_000 }).paceOutlook,
    oneHourLater,
  );
  assert.doesNotMatch(JSON.stringify(oneHourLater), /marker|account|path/iu);
});

test("the unified index removes the 31-day ceiling and keeps fork replay out of the headline", async () => {
  const root = await fixtureRoot();
  try {
    // A corpus whose real history reaches far beyond any 31-day window, plus
    // a forked child that replays its parent — the replay must not surface
    // anywhere in the snapshot.
    const sessions = join(root, "sessions", "2026", "06", "01");
    await mkdir(sessions, { recursive: true });
    const line = (value) => JSON.stringify(value);
    const meta = (id, parent = null) => line({
      timestamp: "2026-06-01T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        ...(parent === null ? { thread_source: "user" } : {
          forked_from_id: parent,
          parent_thread_id: parent,
          thread_source: "subagent",
        }),
        originator: "codex_cli_rs",
        cwd: "/Users/private/project",
      },
    });
    const turn = (timestamp) => line({
      timestamp,
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", effort: "high" },
    });
    const usageTotals = (input, output) => ({
      input_tokens: input,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: 0,
      total_tokens: input + output,
    });
    const count = (timestamp, totals, last) => line({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: totals, last_token_usage: last },
      },
    });
    await writeFile(join(sessions, "rollout-2026-06-01T12-00-00-parent.jsonl"), `${[
      meta("session-deep-parent"),
      turn("2026-06-01T12:00:00.000Z"),
      count("2026-06-01T12:00:01.000Z", usageTotals(100, 10), usageTotals(100, 10)),
      count("2026-07-25T11:00:00.000Z", usageTotals(300, 30), usageTotals(200, 20)),
    ].join("\n")}\n`);
    await writeFile(join(sessions, "rollout-2026-07-25T11-30-00-child.jsonl"), `${[
      meta("session-deep-child", "session-deep-parent"),
      count("2026-07-25T11:30:00.000Z", usageTotals(100, 10), usageTotals(100, 10)),
      count("2026-07-25T11:30:01.000Z", usageTotals(300, 30), usageTotals(200, 20)),
      turn("2026-07-25T11:30:02.000Z"),
      ...Array.from({ length: 4 }, (_, index) => line({
        timestamp: `2026-07-25T11:30:02.${String(index + 1).padStart(3, "0")}Z`,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "thread_spawn",
          call_id: `private-subagent-call-${index}`,
        },
      })),
      ...Array.from({ length: 2 }, (_, index) => line({
        timestamp: `2026-07-25T11:30:02.${String(index + 5).padStart(3, "0")}Z`,
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "private-tool-class",
          call_id: `private-other-call-${index}`,
        },
      })),
      count("2026-07-25T11:30:03.000Z", usageTotals(400, 50), usageTotals(100, 20)),
    ].join("\n")}\n`);
    const { rebuildLocalUnifiedIndex } = await import("../src/local-unified-index-build.js");
    const built = await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile: join(root, ".usage-monitor", "local-unified-index-v1.sqlite"),
      secretFile: join(root, ".usage-monitor", "local-unified-index-device-salt-v1"),
      contractVersion: "companion-test-v1",
    });
    assert.equal(built.usageEvents, 3);
    assert.equal(built.forkReplayEventsSkipped, 2);
    assert.equal(built.toolEvents, 6);

    // A readable SQLite publication whose ingest status is partial remains
    // useful coverage metadata, but it is not an accounting authority.
    const partialIndexFile = join(
      root,
      ".usage-monitor",
      "local-unified-index-v1.sqlite",
    );
    const partialDatabase = openLocalUnifiedIndex(partialIndexFile, {
      readOnly: false,
    });
    partialDatabase.prepare(
      "UPDATE meta SET value = ? WHERE key = 'status'",
    ).run("partial");
    partialDatabase.close();
    const partialSnapshot = await buildLocalCompanionSnapshot({
      root,
      accountingSourceMode: "unified",
      unifiedIndexFile: partialIndexFile,
      allowDevelopmentArtifactFallback: false,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(partialSnapshot.overview.timeline.history.status, "partial");
    assert.equal(
      partialSnapshot.overview.timeline.history.reason,
      "unified_index_partial",
    );
    assert.equal(partialSnapshot.overview.timeline.source, "insufficient_evidence");
    assert.equal(
      partialSnapshot.overview.accounting.accountingSource,
      "insufficient_evidence",
    );
    assert.equal(
      partialSnapshot.overview.usage.find((period) => period.id === "all").events,
      0,
    );
    assert.ok(partialSnapshot.overview.warnings.some((warning) => (
      warning.includes("readable but only partially covered")
    )));
    const restoredDatabase = openLocalUnifiedIndex(partialIndexFile, {
      readOnly: false,
    });
    restoredDatabase.prepare(
      "UPDATE meta SET value = ? WHERE key = 'status'",
    ).run("complete");
    restoredDatabase.close();

    const snapshot = await buildLocalCompanionSnapshot({
      root,
      allowDevelopmentArtifactFallback: false,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });

    // The broadest period covers the whole indexed history — the June event
    // sits 54 days back, far beyond the old 31-day ceiling — and counts the
    // three genuine turns, never the two replayed ones.
    const broadest = snapshot.overview.usage.find((period) => period.id === "all");
    assert.equal(broadest.label, "All indexed local history");
    assert.equal(broadest.events, 3);
    assert.equal(broadest.totalTokens, 110 + 220 + 120);
    // The timeline reaches the June evidence too.
    assert.equal(snapshot.overview.timeline.source, "unified_local_index");
    assert.equal(
      snapshot.overview.timeline.usage[0].startAt,
      "2026-06-01T12:00:00.000Z",
    );
    assert.equal(snapshot.overview.timeline.history.status, "complete");
    assert.equal(
      snapshot.overview.timeline.history.coveredAt.startAt,
      "2026-06-01T12:00:01.000Z",
    );
    // The headline accounting names the replay-suppressed source and the
    // collector-projection warning does not fire.
    assert.equal(
      snapshot.overview.accounting.accountingSource,
      "unified_local_index_replay_suppressed",
    );
    assert.equal(
      snapshot.overview.accounting.cacheSwitchImpact.status,
      "available",
    );
    assert.equal(
      snapshot.overview.accounting.cacheSwitchImpact.periods.length,
      4,
    );
    assert.equal(
      snapshot.overview.accounting.cacheSwitchImpact.cacheReadDrops,
      0,
    );
    assert.equal(
      snapshot.overview.accounting.cacheSwitchImpact.estimatedPremiumUsd,
      0,
    );
    assert.equal(
      snapshot.overview.accounting.cacheSwitchImpact.orderingCoverageGaps,
      0,
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.status,
      "available",
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.periodId,
      "7d",
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.periods.length,
      4,
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.minimumGapSeconds,
      0,
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact
        .outcomeDisplayMaximumGapSeconds,
      604_800,
    );
    assert.equal(
      Object.keys(
        snapshot.overview.accounting.cacheContinuityImpact.byOutcomeBucket,
      ).length,
      10,
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.cacheReadDrops,
      0,
    );
    assert.equal(
      snapshot.overview.accounting.cacheContinuityImpact.orderingCoverageGaps,
      0,
    );
    assert.equal(
      snapshot.overview.monitoringGaps.find((row) => row.id === "reasoning_effort")
        ?.status,
      "partial",
    );
    // Legacy rollback mode continues to read the collector ledger; it must
    // not silently adopt typed unified-index tool counts.
    assert.equal(snapshot.overview.tools.total, 0);
    assert.ok(!snapshot.overview.warnings.some((warning) => (
      warning.includes("live collector projection")
    )));
    assert.ok(!snapshot.overview.warnings.some((warning) => (
      warning.includes("unified local index")
    )));
    // Content never leaks into the payload.
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes("session-deep-parent"));
    assert.ok(!serialized.includes("/Users/private"));

    // Cutover mode reads its long history from the generation-bound cache,
    // never from the rollback archive. A deliberately invalid archive
    // sentinel proves the old reader is not even consulted.
    const stateDirectory = join(root, ".usage-monitor");
    const collectorStateFile = join(
      stateDirectory,
      "local-collector-state-v1.sqlite",
    );
    const unifiedIndexFile = join(
      stateDirectory,
      "local-unified-index-v1.sqlite",
    );
    const archiveIndexFile = join(
      stateDirectory,
      "local-archive-accounting-index-v1.sqlite",
    );
    await writeFile(archiveIndexFile, "rollback-sentinel", { mode: 0o600 });
    const archiveBefore = await stat(archiveIndexFile);
    await refreshReplaySafeAccountingCache({
      stateFile: collectorStateFile,
      sourceMode: "unified",
      unifiedIndexFile,
      expectedGeneration: built.generation,
      contextBehavior: "legacy_zero",
      codexHome: root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const unifiedSnapshot = await buildLocalCompanionSnapshot({
      root,
      accountingSourceMode: "unified",
      archiveIndexFile,
      unifiedIndexFile,
      allowDevelopmentArtifactFallback: false,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const archiveAfter = await stat(archiveIndexFile);
    assert.equal(archiveAfter.size, archiveBefore.size);
    assert.equal(archiveAfter.mtimeMs, archiveBefore.mtimeMs);
    const history = unifiedSnapshot.overview.accounting.periods
      .find((period) => period.periodId === "history");
    assert.equal(history.events, 3);
    assert.equal(history.totalTokens, 110 + 220 + 120);
    assert.equal(
      unifiedSnapshot.overview.accounting.historyPeriodStatus,
      "available",
    );
    assert.equal(
      unifiedSnapshot.overview.accounting.historyCoverage.status,
      "complete",
    );
    assert.equal(
      unifiedSnapshot.overview.accounting.historyCoverage.sourceMode,
      "unified",
    );
    assert.equal(unifiedSnapshot.overview.accounting.sourceMode, "unified");
    assert.equal(
      unifiedSnapshot.overview.accounting.compatibilityBehavior,
      "legacy_zero",
    );
    assert.equal(
      unifiedSnapshot.overview.accounting.generationMatched,
      true,
    );
    assert.equal(
      unifiedSnapshot.overview.accounting.diagnosticsAvailable,
      true,
    );
    assert.equal(
      unifiedSnapshot.overview.accounting.sourceCapabilities
        .crashSafeGenerationPublication,
      true,
    );
    assert.equal(unifiedSnapshot.overview.tools.total, 6);
    assert.equal(unifiedSnapshot.overview.tools.counts.subagent, 4);
    assert.equal(unifiedSnapshot.overview.tools.counts.other, 2);
    assert.equal(unifiedSnapshot.overview.evidenceStatus, "available");
    assert.equal(unifiedSnapshot.overview.freshness.status, "live");
    assert.equal(
      unifiedSnapshot.overview.freshness.latestObservedAt,
      "2026-07-25T11:30:03.000Z",
    );
    assert.deepEqual(unifiedSnapshot.overview.collector.exportableCoveredAt, {
      startAt: "2026-06-01T12:00:01.000Z",
      endAt: "2026-07-25T11:30:03.000Z",
    });

    const toolPartialDatabase = openLocalUnifiedIndex(unifiedIndexFile, {
      readOnly: false,
    });
    toolPartialDatabase.prepare(`
      UPDATE index_generation
      SET status = 'partial', block_reason = 'tool_provenance_incomplete',
          tool_provenance_complete = 0
      WHERE id = (SELECT CAST(value AS INTEGER) FROM meta
                  WHERE key = 'current_generation_id')
    `).run();
    toolPartialDatabase.prepare(
      "UPDATE meta SET value = 'partial' WHERE key = 'status'",
    ).run();
    const toolPartialGeneration = readUnifiedIndexGenerationDescriptor(
      toolPartialDatabase,
    );
    toolPartialDatabase.close();
    await refreshReplaySafeAccountingCache({
      stateFile: collectorStateFile,
      sourceMode: "unified",
      unifiedIndexFile,
      expectedGeneration: toolPartialGeneration,
      contextBehavior: "legacy_zero",
      codexHome: root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const toolPartialSnapshot = await buildLocalCompanionSnapshot({
      root,
      accountingSourceMode: "unified",
      archiveIndexFile,
      unifiedIndexFile,
      allowDevelopmentArtifactFallback: false,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(
      toolPartialSnapshot.overview.usage.find((period) => period.id === "all")
        .events,
      3,
    );
    assert.equal(toolPartialSnapshot.overview.tools.status, "unavailable");
    assert.equal(
      toolPartialSnapshot.overview.tools.reason,
      "typed_tool_history_partial",
    );
    assert.equal(toolPartialSnapshot.overview.tools.total, null);
    assert.equal(toolPartialSnapshot.overview.activity.toolEvents, null);
    assert.ok(Object.values(toolPartialSnapshot.overview.tools.counts).every(
      (value) => value === null,
    ));
    assert.ok(toolPartialSnapshot.overview.warnings.some((warning) => (
      warning.includes("typed tool history is partial")
    )));
    const restoreToolDatabase = openLocalUnifiedIndex(unifiedIndexFile, {
      readOnly: false,
    });
    restoreToolDatabase.prepare(`
      UPDATE index_generation
      SET status = 'complete', block_reason = NULL,
          tool_provenance_complete = 1
      WHERE id = (SELECT CAST(value AS INTEGER) FROM meta
                  WHERE key = 'current_generation_id')
    `).run();
    restoreToolDatabase.prepare(
      "UPDATE meta SET value = 'complete' WHERE key = 'status'",
    ).run();
    restoreToolDatabase.close();

    // A copy-on-write publisher replacing the path mid-read must not let the
    // old opened inode masquerade as the current publication.
    const movedIndexFile = `${unifiedIndexFile}.reader-race`;
    let moved = false;
    const raceBaselines = [];
    raceBaselines[Symbol.iterator] = function* triggerReplacement() {
      if (!moved) {
        moved = true;
        renameSync(unifiedIndexFile, movedIndexFile);
      }
    };
    let raced;
    try {
      raced = await readLocalUnifiedCompanionProjection({
        indexFile: unifiedIndexFile,
        declaredSpeedBaselines: raceBaselines,
        nowMs: Date.parse("2026-07-25T12:00:00.000Z"),
      });
    } finally {
      if (moved) renameSync(movedIndexFile, unifiedIndexFile);
    }
    assert.equal(raced.status, "unavailable");
    assert.equal(raced.errorCode, "local_unified_index_file_changed");

    // The descriptor commits to the exact fixed-class fact set. Any in-place
    // edit after publication is withheld rather than silently displayed.
    const tamperedDatabase = openLocalUnifiedIndex(unifiedIndexFile, {
      readOnly: false,
    });
    tamperedDatabase.prepare(`
      UPDATE tool_class_fact SET tool_class = 'web_search'
      WHERE event_key = (SELECT event_key FROM tool_class_fact LIMIT 1)
    `).run();
    tamperedDatabase.close();
    const tampered = await readLocalUnifiedCompanionProjection({
      indexFile: unifiedIndexFile,
      nowMs: Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(tampered.status, "unavailable");
    assert.equal(
      tampered.errorCode,
      "local_unified_index_tool_attestation_mismatch",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a missing unified index keeps the bounded window and says so in the payload", async () => {
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
      `${usage("2026-07-25T11:00:00.000Z")}\n`,
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.overview.timeline.source, "recent_collector_window");
    assert.equal(snapshot.overview.timeline.history.status, "unavailable");
    assert.equal(snapshot.overview.timeline.history.reason, "unified_index_missing");
    assert.equal(snapshot.overview.timeline.history.boundedDays, 31);
    assert.ok(snapshot.overview.warnings.some((warning) => (
      warning.includes("unified local index has not been built yet")
    )));
    const broadest = snapshot.overview.usage.find((period) => period.id === "all");
    assert.equal(broadest.label, "Cached 31-day collector window");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a deferred unified projection publishes a loading history receipt", async () => {
  const root = await fixtureRoot();
  try {
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      unifiedProjectionMode: "deferred",
      allowDevelopmentArtifactFallback: true,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.deepEqual(snapshot.overview.timeline.history, {
      status: "loading",
      reason: "unified_index_deferred",
      source: "recent_collector_window",
      coveredAt: {
        startAt: null,
        endAt: null,
      },
    });
    assert.ok(snapshot.overview.warnings.some((warning) => (
      warning.includes("Full indexed history is loading")
    )));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("snapshot construction delegates the selected unified projection mode", async () => {
  const root = await fixtureRoot();
  const calls = [];
  const controller = new AbortController();
  try {
    await buildLocalCompanionSnapshot({
      root,
      unifiedProjectionMode: "deferred",
      unifiedProjectionReader: async (options, controls) => {
        calls.push({ options, controls });
        return readLocalUnifiedCompanionProjection(options);
      },
      signal: controller.signal,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.mode, "deferred");
    assert.equal(
      calls[0].options.nowMs,
      Date.parse("2026-07-25T12:00:00.000Z"),
    );
    assert.equal(calls[0].controls.signal, controller.signal);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an attested rollout quarantine publishes verified totals as a terminal gap, never as zero", async () => {
  const root = await fixtureRoot();
  const sessions = join(root, "sessions", "2026", "07", "25");
  const threadGap = "11111111-1111-4111-8111-111111111111";
  const threadValid = "22222222-2222-4222-8222-222222222222";
  const name = (timestamp, threadId) => (
    `rollout-${timestamp}-${threadId}.jsonl`
  );
  try {
    await mkdir(sessions, { recursive: true });
    const meta = (id) => JSON.stringify({
      timestamp: "2026-07-25T11:00:00.000Z",
      type: "session_meta",
      payload: { id, session_id: id, thread_source: "user" },
    });
    const turn = (model) => JSON.stringify({
      timestamp: "2026-07-25T11:00:01.000Z",
      type: "turn_context",
      payload: { model, effort: "high" },
    });
    const writeLines = (filename, lines) => writeFile(
      join(sessions, filename),
      `${lines.join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeLines(name("2026-07-25T10-00-00", threadGap), [
      meta(threadGap),
    ]);
    await writeLines(name("2026-07-25T10-00-01", threadGap), [
      meta(threadGap),
      turn("gpt-5.6-terra"),
    ]);
    await writeLines(name("2026-07-25T11-00-00", threadValid), [
      meta(threadValid),
      turn("gpt-5.6-sol"),
      rolloutToken(
        "2026-07-25T11:00:02.000Z",
        rolloutUsage(100, 10),
        rolloutUsage(100, 10),
        12,
      ),
    ]);

    const { rebuildLocalUnifiedIndex } = await import(
      "../src/local-unified-index-build.js"
    );
    const unifiedIndexFile = join(
      root,
      ".usage-monitor",
      "local-unified-index-v1.sqlite",
    );
    const built = await rebuildLocalUnifiedIndex({
      codexHome: root,
      indexFile: unifiedIndexFile,
      secretFile: join(
        root,
        ".usage-monitor",
        "local-unified-index-device-salt-v1",
      ),
      contractVersion: "companion-test-v1",
    });
    assert.equal(built.generation.status, "partial");
    assert.equal(built.generation.skippedSourceCount, 2);

    await refreshReplaySafeAccountingCache({
      stateFile: join(
        root,
        ".usage-monitor",
        "local-collector-state-v1.sqlite",
      ),
      sourceMode: "unified",
      unifiedIndexFile,
      expectedGeneration: built.generation,
      contextBehavior: "legacy_zero",
      codexHome: root,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      accountingSourceMode: "unified",
      unifiedIndexFile,
      allowDevelopmentArtifactFallback: false,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.overview.timeline.history.status, "partial");
    assert.equal(snapshot.overview.timeline.history.usageEvents, 1);
    assert.deepEqual(snapshot.overview.accounting.historyCoverage, {
      status: "partial",
      phase: "partial_terminal",
      errorCode: null,
      generatedAt: snapshot.overview.accounting.historyCoverage.generatedAt,
      coveredAt: snapshot.overview.accounting.historyCoverage.coveredAt,
      sourceCount: 3,
      indexedSourceCount: 1,
      pendingSourceCount: 0,
      skippedSourceCount: 2,
      skippedSourceBytes: built.generation.skippedSourceBytes,
      skippedThreadCount: 1,
      sourceBytes: built.generation.discoveredSourceBytes,
      indexedBytes: built.generation.indexedSourceBytes,
      sourceMode: "unified",
      generationMatched: true,
    });
    assert.equal(
      snapshot.overview.accounting.historyCoverage.phase,
      "partial_terminal",
    );
    assert.equal(snapshot.overview.accounting.historyPeriodStatus, "available");
    assert.equal(
      snapshot.overview.accounting.periods.find((period) => (
        period.periodId === "history"
      )).events,
      1,
    );
    assert.equal(
      snapshot.overview.usage.find((period) => period.id === "all").events,
      1,
    );
    const coverageWarning = snapshot.overview.warnings.find((warning) => (
      warning.includes("Indexed-history totals include")
    ));
    assert.match(coverageWarning, /material coverage gap/u);
    assert.match(coverageWarning, /unavailable rather than zero/u);
    assert.doesNotMatch(coverageWarning, /quarantined|known gap/iu);
    assert.equal(JSON.stringify(snapshot).includes(threadGap), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only coherent terminal history gaps at or below one percent are informational", () => {
  const coverage = {
    status: "partial",
    phase: "partial_terminal",
    sourceCount: 100,
    indexedSourceCount: 99,
    pendingSourceCount: 0,
    skippedSourceCount: 1,
  };
  assert.equal(INFORMATIONAL_HISTORY_GAP_MAX_SHARE, 0.01);
  assert.equal(isInformationalTerminalHistoryGap(coverage), true);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    indexedSourceCount: 98,
    skippedSourceCount: 2,
  }), false);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    indexedSourceCount: 0,
    skippedSourceCount: 100,
  }), false);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    pendingSourceCount: 1,
  }), false);
  assert.equal(isInformationalTerminalHistoryGap({
    ...coverage,
    indexedSourceCount: 98,
  }), false);
});

test("unified mode with no valid generation withholds the provisional collector projection", async () => {
  const root = await fixtureRoot();
  try {
    const usage = JSON.stringify({
      schemaVersion: "0.3",
      kind: "codex_rollout_usage_snapshot",
      observedAt: "2026-07-25T11:00:00.000Z",
      model: "gpt-5.6-sol",
      components: { input_uncached_tokens: 100 },
    });
    const tool = JSON.stringify({
      kind: "codex_tool_class_event",
      observedAt: "2026-07-25T11:01:00.000Z",
      toolClass: "subagent",
    });
    await writeFile(
      join(root, ".usage-monitor", "collector-events.jsonl"),
      `${usage}\n${tool}\n`,
      { mode: 0o600 },
    );
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      accountingSourceMode: "unified",
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });
    assert.equal(snapshot.overview.timeline.source, "insufficient_evidence");
    assert.deepEqual(snapshot.overview.timeline.usage, []);
    assert.equal(
      snapshot.overview.accounting.accountingSource,
      "insufficient_evidence",
    );
    assert.equal(snapshot.overview.pricing.totalCostUsd, 0);
    assert.equal(snapshot.overview.pricing.eventCount, 0);
    assert.equal(snapshot.overview.tools.status, "unavailable");
    assert.equal(snapshot.overview.tools.total, null);
    assert.equal(snapshot.overview.activity.toolEvents, null);
    assert.deepEqual(snapshot.overview.collector.exportableCoveredAt, {
      startAt: null,
      endAt: null,
    });
    assert.ok(snapshot.overview.warnings.some((warning) => (
      warning.includes("Usage totals and timelines remain unavailable")
    )));
    assert.ok(!snapshot.overview.warnings.some((warning) => (
      warning.includes("live collector projection")
    )));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a deferred quick reload keeps the usage figures and both usage timelines", () => {
  // 0.1.14 protected gradient/weekly and left these three live, because they
  // sit inside `overview` rather than at the top level. Reported against the
  // shipped 0.1.14 build as usage still appearing and disappearing while the
  // charts held still.
  //
  // The usage PERIODS matter most here: a deferred build does not empty them,
  // it replaces them with four fully-formed zeroed placeholders, so any check
  // based on array length reads them as present and lets zeroes overwrite real
  // totals.
  const period = (events) => ({ id: "7d", label: "Last 7 days", events });
  const snapshotFor = (purpose) => {
    const deferred = ["startup", "quick"].includes(purpose);
    return {
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      mode: "real_local_evidence",
      generatedAt: "2026-08-20T21:00:00.000Z",
      overview: {
        marker: purpose,
        quota: { windows: [{ remainingPercent: purpose === "quick" ? 41 : 77 }] },
        usage: deferred ? [period(0)] : [period(12)],
        timeline: {
          usage: deferred ? [] : [{ at: 1 }, { at: 2 }],
          sparkUsage: deferred ? [] : [{ at: 1 }],
          calibrationUsage: deferred ? [] : [{ at: 1 }],
          quota: [{ at: 9 }],
        },
      },
      gradient: { datasets: deferred ? { rolling: [] } : { rolling: [{ at: 1 }] } },
      weekly: { datasets: deferred ? { weekly_values: [] } : { weekly_values: [{ sequence: 1 }] } },
      quality: {},
      reports: [],
    };
  };
  const store = new LocalCompanionDataStore({
    builder: async ({ purpose = "full" } = {}) => snapshotFor(purpose),
  });

  return (async () => {
    await store.reload({ purpose: "full" });
    await store.reload({ purpose: "quick" });
    const overview = store.getOverview();

    // Retained: the surfaces a deferred build could not rebuild.
    assert.equal(overview.usage[0].events, 12, "usage totals must not drop to zero");
    assert.equal(overview.timeline.usage.length, 2);
    assert.equal(overview.timeline.sparkUsage.length, 1);
    assert.equal(overview.timeline.calibrationUsage.length, 1);
    assert.equal(store.getGradient().datasets.rolling.length, 1);
    assert.equal(store.getWeekly().datasets.weekly_values.length, 1);

    // Still fresh: the fast-moving figures the quick pass exists to deliver.
    assert.equal(overview.marker, "quick");
    assert.equal(overview.quota.windows[0].remainingPercent, 41);

    // A surface the build omits entirely stays omitted rather than being
    // conjured back: absence is a configuration choice, not emptiness.
    const withoutCalibration = new LocalCompanionDataStore({
      builder: async ({ purpose = "full" } = {}) => {
        const next = snapshotFor(purpose);
        if (["startup", "quick"].includes(purpose)) delete next.overview.timeline.calibrationUsage;
        return next;
      },
    });
    await withoutCalibration.reload({ purpose: "full" });
    await withoutCalibration.reload({ purpose: "quick" });
    assert.equal(
      Object.hasOwn(withoutCalibration.getOverview().timeline, "calibrationUsage"),
      false,
    );

    // A FULL reload stays authoritative in both directions, so a genuine
    // transition to empty still lands and this can never pin stale figures.
    const emptying = new LocalCompanionDataStore({
      builder: async () => {
        const next = snapshotFor("full");
        next.overview.usage = [period(0)];
        next.overview.timeline.usage = [];
        return next;
      },
    });
    await emptying.reload({ purpose: "full" });
    await emptying.reload({ purpose: "full" });
    assert.equal(emptying.getOverview().usage[0].events, 0);
    assert.equal(emptying.getOverview().timeline.usage.length, 0);
  })();
});

test("a non-authoritative FULL build keeps the evidence it could not rebuild", async () => {
  // Reproduced 2026-08-21 against the owner's real index (repro-blank.mjs):
  // a full-mode snapshot built while the generation row is not ready — the
  // exact row shape an in-flight ingest produces — publishes an empty-array
  // timeline and zeroed usage placeholders even though the complete history is
  // readable in the same file. Full reloads bypassed retention by design, so
  // one full reload racing an ingest blanked the dashboard AND PINNED the
  // blank until the next authoritative reload. Intermittent, persisting across
  // refreshes: the exact behavior reported against 0.1.13 through 0.1.15.
  //
  // Authority is the snapshot's own accounting block: generationMatched can
  // only be true once the generation passed the readiness gate and the cache
  // was rebuilt against exactly that generation.
  const period = (events) => ({ id: "7d", label: "Last 7 days", events });
  const snapshot = ({ matched, empty, sourceMode = "unified" }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T14:30:00.000Z",
    overview: {
      marker: matched ? "authoritative" : "not-ready",
      accounting: { sourceMode, generationMatched: matched },
      usage: empty ? [period(0)] : [period(12)],
      timeline: { usage: empty ? [] : [{ at: 1 }, { at: 2 }] },
    },
    gradient: { datasets: empty ? { rolling: [] } : { rolling: [{ at: 1 }] } },
    weekly: { datasets: empty ? { weekly_values: [] } : { weekly_values: [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };

  // M2/M3: a not-ready full build must not blank a populated dashboard.
  const notReady = storeWith([
    { matched: true, empty: false },
    { matched: false, empty: true },
  ]);
  await notReady.reload({ purpose: "full" });
  await notReady.reload({ purpose: "full" });
  assert.equal(notReady.getOverview().timeline.usage.length, 2,
    "a not-ready full build must not blank the timeline");
  assert.equal(notReady.getOverview().usage[0].events, 12);
  // The build's own status fields still publish — staleness stays labeled.
  assert.equal(notReady.getOverview().marker, "not-ready");

  // Authoritative empty: a ready, matched build with genuinely no data lands.
  const wiped = storeWith([
    { matched: true, empty: false },
    { matched: true, empty: true },
  ]);
  await wiped.reload({ purpose: "full" });
  await wiped.reload({ purpose: "full" });
  assert.equal(wiped.getOverview().timeline.usage.length, 0,
    "an authoritative empty build must land");

  // M1: fresh evidence always wins — a mismatched build that still carries
  // its buckets replaces, never resurrects older data over newer.
  const mismatchOnly = storeWith([
    { matched: true, empty: false },
    { matched: false, empty: false },
  ]);
  await mismatchOnly.reload({ purpose: "full" });
  await mismatchOnly.reload({ purpose: "full" });
  assert.equal(mismatchOnly.getOverview().marker, "not-ready");
  assert.equal(mismatchOnly.getOverview().timeline.usage.length, 2);

  // Legacy rollback mode never had this gate and keeps full-replace semantics.
  const legacy = storeWith([
    { matched: true, empty: false, sourceMode: "legacy" },
    { matched: false, empty: true, sourceMode: "legacy" },
  ]);
  await legacy.reload({ purpose: "full" });
  await legacy.reload({ purpose: "full" });
  assert.equal(legacy.getOverview().timeline.usage.length, 0,
    "legacy full reloads replace unconditionally");
});

test("a non-authoritative build keeps the allowance capacity the chart selects by", async () => {
  // Captured live 2026-08-21 during a user-visible blank: buckets, weighting
  // arrays, and quota rows all present and retained, while
  // timeline.allowanceCapacity published as {status:"unavailable", reason:
  // "allowance_capacity_cache_unavailable"}. The dashboard's capacity selector
  // returns null on anything but "available", which excludes every window as
  // "speed-adjusted allowance weighting unavailable" in one stroke — 0 of
  // 1,482 matched. A row count cannot see a status object, which is how this
  // field survived two rounds of retention fixes around it.
  const capacityOf = (status) => ({
    status,
    ...(status === "available"
      ? { selectedScenario: "unresolved_as_standard", scenarios: {} }
      : { reason: "allowance_capacity_cache_unavailable", selectedScenario: null }),
  });
  const snapshot = ({ matched, capacity }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T15:30:00.000Z",
    overview: {
      accounting: { sourceMode: "unified", generationMatched: matched },
      usage: [{ id: "7d", label: "Last 7 days", events: 12 }],
      timeline: {
        usage: [{ at: 1 }],
        allowanceCapacity: capacityOf(capacity),
      },
    },
    gradient: { datasets: { rolling: [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };

  // The captured incident: a non-authoritative full publish degrades capacity
  // while everything else survives. The chart must keep selecting.
  const degraded = storeWith([
    { matched: true, capacity: "available" },
    { matched: false, capacity: "unavailable" },
  ]);
  await degraded.reload({ purpose: "full" });
  await degraded.reload({ purpose: "full" });
  assert.equal(
    degraded.getOverview().timeline.allowanceCapacity.status,
    "available",
    "a non-authoritative publish must not strip the capacity the chart keys on",
  );

  // The same protection on the quick pass, which publishes mid-refresh.
  const quick = storeWith([
    { matched: true, capacity: "available" },
    { matched: false, capacity: "unavailable" },
  ]);
  await quick.reload({ purpose: "full" });
  await quick.reload({ purpose: "quick" });
  assert.equal(quick.getOverview().timeline.allowanceCapacity.status, "available");

  // An AUTHORITATIVE build that genuinely cannot produce capacity lands: a
  // matched cache with an insufficient fit is a true state, not a transient.
  const genuine = storeWith([
    { matched: true, capacity: "available" },
    { matched: true, capacity: "unavailable" },
  ]);
  await genuine.reload({ purpose: "full" });
  await genuine.reload({ purpose: "full" });
  assert.equal(genuine.getOverview().timeline.allowanceCapacity.status, "unavailable");
});

test("a mismatch window keeps the cost figures while the truth fields stay current", async () => {
  // The Usage-and-costs page renders overview.accounting directly. Confirmed
  // live on dogfood 1021 (2026-08-21): during each mismatch window the page
  // zeroed — $0.00, 0 tokens, "No model usage in this period" — then refilled
  // at $4,982.79 / 12.6B tokens the moment authority returned. The accounting
  // node was the last unretained surface of the class.
  //
  // It cannot use the generic swap: the same object carries generationMatched
  // and the cache status. Retaining those would republish yesterday's
  // "matched: true" over a live mismatch — the app lying about its own state.
  const accountingFor = ({ matched, zeroed }) => ({
    sourceMode: "unified",
    generationMatched: matched,
    accountingCacheStatus: matched ? "available" : "unavailable",
    generationFingerprint: matched ? "generation-v2-current" : "generation-v2-next",
    events: zeroed ? 0 : 95636,
    totalTokens: zeroed ? 0 : 12596645828,
    apiPriceEquivalentUsd: zeroed ? 0 : 4982.785667,
    byModel: zeroed ? [] : [{ model: "gpt-5.4", events: 90000 }],
    periods: zeroed
      ? [{ periodId: "7d", events: 0 }]
      : [{ periodId: "7d", events: 95636 }],
  });
  const snapshot = (shape) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T15:50:00.000Z",
    overview: {
      accounting: accountingFor(shape),
      usage: [{ id: "7d", label: "Last 7 days", events: shape.zeroed ? 0 : 12 }],
      timeline: { usage: [{ at: 1 }] },
    },
    gradient: { datasets: { rolling: [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };

  // The captured incident: figures retained, truth fields current.
  const window = storeWith([
    { matched: true, zeroed: false },
    { matched: false, zeroed: true },
  ]);
  await window.reload({ purpose: "full" });
  await window.reload({ purpose: "full" });
  const held = window.getOverview().accounting;
  assert.equal(held.events, 95636, "cost figures must survive the mismatch window");
  assert.equal(held.apiPriceEquivalentUsd, 4982.785667);
  assert.equal(held.byModel.length, 1);
  // The truth fields must NOT be retained: the window is real and stays
  // visible, which is what keeps the staleness labeled.
  assert.equal(held.generationMatched, false);
  assert.equal(held.accountingCacheStatus, "unavailable");
  assert.equal(held.generationFingerprint, "generation-v2-next");

  // An authoritative zero is a true state and lands.
  const wiped = storeWith([
    { matched: true, zeroed: false },
    { matched: true, zeroed: true },
  ]);
  await wiped.reload({ purpose: "full" });
  await wiped.reload({ purpose: "full" });
  assert.equal(wiped.getOverview().accounting.events, 0,
    "an authoritative empty accounting must land");
});

test("a build serving retained evidence does not claim its figures are loading", async () => {
  // Captured live 2026-08-21 on the owner's machine: every ~5-minute refresh
  // pass republishes a quick-milestone snapshot for the first ~2 minutes.
  // Retention keeps the page's figures complete and current through that
  // window, but the build's own warnings — "Full indexed history is loading",
  // "History indexing is still advancing. Complete historical totals stay
  // hidden" — were served verbatim alongside them. On the Usage-and-costs
  // page the banners therefore showed on a ~40% duty cycle forever, always
  // claiming figures were hidden that were plainly on screen.
  const UNRELATED_WARNING =
    "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
  const snapshot = ({ matched, empty, warnings }) => ({
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt: "2026-08-21T20:32:51.918Z",
    overview: {
      accounting: {
        sourceMode: "unified",
        generationMatched: matched,
        events: empty ? 0 : 95636,
        byModel: empty ? [] : [{ model: "gpt-5.4", events: 90000 }],
        periods: empty
          ? [{ periodId: "7d", events: 0 }]
          : [{ periodId: "7d", events: 95636 }],
      },
      usage: [{ id: "7d", label: "Last 7 days", events: empty ? 0 : 12 }],
      timeline: { usage: empty ? [] : [{ at: 1 }] },
      warnings,
    },
    gradient: { datasets: { rolling: empty ? [] : [{ at: 1 }] } },
    weekly: { datasets: { weekly_values: empty ? [] : [{ sequence: 1 }] } },
    quality: {},
    reports: [],
  });
  const storeWith = (sequence) => {
    let call = 0;
    return new LocalCompanionDataStore({
      builder: async () => snapshot(sequence[Math.min(call++, sequence.length - 1)]),
    });
  };
  const [deferredLoading, withheldPartial, , , historyHidden] =
    RETAINED_EVIDENCE_RELABELED_WARNINGS;

  // The captured cycle: an authoritative full, then the quick milestone. Both
  // loading sentences are replaced by the one sentence that is true of the
  // retained figures — once, first, with unrelated warnings kept in place.
  const quick = storeWith([
    { matched: true, empty: false, warnings: [] },
    {
      matched: false,
      empty: true,
      warnings: [deferredLoading, UNRELATED_WARNING, historyHidden],
    },
  ]);
  await quick.reload({ purpose: "full" });
  await quick.reload({ purpose: "quick" });
  assert.deepEqual(quick.getOverview().warnings, [
    RETAINED_EVIDENCE_REFRESH_WARNING,
    UNRELATED_WARNING,
  ], "loading claims must not outlive the evidence they describe");

  // The mismatch-window full build (M3) gets the same relabel: its withheld
  // sentence is false of the retained figures the page keeps showing.
  const mismatch = storeWith([
    { matched: true, empty: false, warnings: [] },
    { matched: false, empty: true, warnings: [withheldPartial] },
  ]);
  await mismatch.reload({ purpose: "full" });
  await mismatch.reload({ purpose: "full" });
  assert.deepEqual(mismatch.getOverview().warnings, [
    RETAINED_EVIDENCE_REFRESH_WARNING,
  ]);

  // A true cold start retains nothing, so "loading" is exactly right and the
  // build's own sentences stand untouched.
  const cold = storeWith([
    {
      matched: false,
      empty: true,
      warnings: [deferredLoading, historyHidden],
    },
  ]);
  await cold.reload({ purpose: "startup" });
  assert.deepEqual(cold.getOverview().warnings, [deferredLoading, historyHidden],
    "a cold start genuinely is loading and must say so");

  // A deferred build with no replaceable sentence gains nothing: the relabel
  // replaces false claims, it does not add a standing banner to every pass.
  const quiet = storeWith([
    { matched: true, empty: false, warnings: [] },
    { matched: false, empty: true, warnings: [UNRELATED_WARNING] },
  ]);
  await quiet.reload({ purpose: "full" });
  await quiet.reload({ purpose: "quick" });
  assert.deepEqual(quiet.getOverview().warnings, [UNRELATED_WARNING]);

  // An authoritative build keeps its own words even when they include these
  // sentences: nothing was retained over it, so nothing is relabeled.
  const authoritative = storeWith([
    { matched: true, empty: false, warnings: [] },
    { matched: true, empty: true, warnings: [historyHidden] },
  ]);
  await authoritative.reload({ purpose: "full" });
  await authoritative.reload({ purpose: "full" });
  assert.deepEqual(authoritative.getOverview().warnings, [historyHidden],
    "an authoritative build's own sentences are its own to make");
});

test("every surface a withheld projection empties is registered for retention", async () => {
  // The completeness gate for this defect class. `unifiedAccountingWithheld`
  // is the single condition under which the builder substitutes evidence-free
  // values, so enumerating its substitution sites enumerates the class.
  //
  // Two of the eight sites yield real data surfaces as bare empty arrays and
  // one yields the zeroed placeholder periods; the remaining five yield a
  // coverage window or a source LABEL, which carry no rows and are meant to
  // change on a deferred pass. If a new evidence-bearing substitution appears,
  // this fails until it is registered in PROJECTION_SURFACES — which is the
  // point, because reviewing the retention list is not something anyone
  // remembers to do when adding a surface.
  const source = await readFile(
    new URL("../src/local-companion-data.js", import.meta.url),
    "utf8",
  );
  const emptyArraySites = source.match(/unifiedAccountingWithheld\s+\?\s+\[\]/gu) ?? [];
  const placeholderPeriodSites =
    source.match(/unifiedAccountingWithheld\s+\?\s+insufficientEvidenceUsagePeriods\(\)/gu) ?? [];

  assert.equal(
    emptyArraySites.length,
    2,
    "new `unifiedAccountingWithheld ? []` surface — register it in PROJECTION_SURFACES",
  );
  assert.equal(
    placeholderPeriodSites.length,
    1,
    "new placeholder-period substitution — register it in PROJECTION_SURFACES",
  );

  assert.deepEqual(RETAINED_PROJECTION_SURFACE_PATHS, [
    // allowanceCapacity: registered 2026-08-21 after a live capture showed a
    // non-authoritative publish stripping it to status "unavailable" and
    // blanking every Trends window at once, while every array surface here
    // survived. It is a status OBJECT, so its evidence counter is
    // availableStatusRows, not a row count.
    "gradient",
    "weekly",
    "overview.usage",
    "overview.timeline.usage",
    "overview.timeline.sparkUsage",
    "overview.timeline.calibrationUsage",
    "overview.timeline.allowanceCapacity",
  ]);
});
