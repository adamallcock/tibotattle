import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  APP_PRICE_REGISTRY_MANIFEST,
} from "@app-usagemonitor/accounting";
import {
  codexPrimaryAllowanceBasis,
} from "../src/codex-primary-allowance-basis.js";
import {
  collectHistoricalSideChatGapProbe,
  collectSideChatEstimates,
} from "../src/side-chat-estimates.js";
import {
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import {
  openLocalUnifiedIndex,
} from "../src/local-unified-index.js";
import {
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "../src/replay-safe-accounting-cache.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const INCOMPLETE_CHILD = "33333333-3333-4333-8333-333333333333";
const TURN_ONE = "44444444-4444-4444-8444-444444444444";
const TURN_TWO = "55555555-5555-4555-8555-555555555555";
const NEWER_REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION =
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION.replace(
    /v0\.(\d+)$/u,
    (_match, minor) => `v0.${Number(minor) + 1}`,
  );

function seconds(instant) {
  return Math.floor(Date.parse(instant) / 1_000);
}

function samplingBody(turn, total, model = "gpt-5.6-sol") {
  return `post sampling token usage turn_id=${turn} total_usage_tokens=${total} `
    + `turn.id=${turn} model=${model} codex.turn.reasoning_effort=max`;
}

test("side-chat estimator detects only anchored children and prices warm then post-compaction cold calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-chat-estimates-"));
  const codexHome = join(root, ".codex");
  const desktopRoot = join(root, "desktop-logs");
  await mkdir(codexHome, { recursive: true });
  await mkdir(desktopRoot, { recursive: true });
  await writeFile(join(desktopRoot, "main.log"), [
    `2026-08-16T11:00:00.000Z method=thread/fork conversationId=${PARENT}`,
    `2026-08-16T11:00:01.000Z method=thread/inject_items conversationId=${CHILD}`,
    `2026-08-16T11:00:02.000Z IAB_LIFECYCLE received browser use session route capture conversationId=${CHILD} disposeAfterSessionActivity=false`,
    `2026-08-16T11:10:00.000Z method=thread/fork conversationId=${PARENT}`,
    `2026-08-16T11:10:01.000Z method=thread/inject_items conversationId=${INCOMPLETE_CHILD}`,
    "",
  ].join("\n"));

  const databaseFile = join(codexHome, "logs_2.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    thread_id TEXT
  )`);
  const insert = database.prepare(`
    INSERT INTO logs (id, ts, ts_nanos, target, feedback_log_body, thread_id)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(
    1,
    seconds("2026-08-16T11:01:00.000Z"),
    0,
    "codex_core::session::turn",
    samplingBody(TURN_ONE, 100_000),
    CHILD,
  );
  insert.run(
    2,
    seconds("2026-08-16T11:01:10.000Z"),
    0,
    "codex_core::session::turn",
    samplingBody(TURN_ONE, 100_000),
    CHILD,
  );
  insert.run(
    3,
    seconds("2026-08-16T11:02:00.000Z"),
    0,
    "codex_api::sse::responses",
    `run_auto_compact{reason=threshold phase=start} turn.id=${TURN_TWO}`,
    CHILD,
  );
  insert.run(
    4,
    seconds("2026-08-16T11:03:00.000Z"),
    0,
    "codex_core::session::turn",
    samplingBody(TURN_TWO, 100_000),
    CHILD,
  );
  insert.run(
    6,
    seconds("2026-08-16T11:02:00.000Z"),
    0,
    "feedback_tags",
    `run_auto_compact{reason=threshold phase=start} turn.id=${TURN_TWO}`,
    CHILD,
  );
  insert.run(
    5,
    seconds("2026-08-16T11:11:00.000Z"),
    0,
    "codex_core::session::turn",
    samplingBody(TURN_ONE, 999_999),
    INCOMPLETE_CHILD,
  );
  database.close();

  try {
    const result = await collectSideChatEstimates({
      codexHome,
      desktopLogRoot: desktopRoot,
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
      declaredSpeedBaselines: [{
        mode: "fast",
        firstSeenAt: "2026-08-16T11:03:00.000Z",
        lastSeenAt: "2026-08-16T11:03:00.000Z",
      }],
    });
    assert.equal(result.status, "available");
    assert.ok(result.coverage.desktop.bytesScanned > 0);
    assert.deepEqual(result.coverage, {
      desktop: {
        filesScanned: 1,
        bytesScanned: result.coverage.desktop.bytesScanned,
        oversizedLinesSkipped: 0,
        startAt: "2026-08-16T11:00:00.000Z",
        endAt: "2026-08-16T11:10:01.000Z",
      },
      logs2: {
        startAt: "2026-08-16T11:01:00.000Z",
        endAt: "2026-08-16T11:11:00.000Z",
        sourceScope: "active_logs2_retention_only",
      },
      detectedSessions: 1,
      retainedNumericSessions: 1,
      completeNumericSessions: 1,
      sessionsAtRetentionLimit: 0,
      sessionsWithoutNumericEvidence: 0,
      duplicateSamplingMarkers: 1,
      ambiguousDuplicateMarkers: 0,
      rejectedSamplingMarkers: 0,
      rejectedCompactionMarkers: 0,
      compactionMarkers: 1,
      status: "retained_for_all_detected_sessions",
    });
    const all = result.periods.find((period) => period.periodId === "all");
    assert.equal(all.samplingCalls, 2);
    assert.equal(all.postCompactionCalls, 1);
    assert.equal(all.activeContextTokens, 200_000);
    assert.equal(result.recent.length, 2);
    assert.equal(result.recent[0].cacheAssumption, "cold_after_compaction");
    assert.equal(result.recent[1].cacheAssumption, "warm_prefix");
    assert.equal(result.recent[0].turnOrdinal, 2);
    assert.equal(result.recent[1].turnOrdinal, 1);
    assert.ok(
      result.recent[0].estimatedApiPriceEquivalentUsd
        > result.recent[1].estimatedApiPriceEquivalentUsd * 5,
    );
    assert.equal(result.methodology.includedInExactUsage, false);
    assert.equal(result.methodology.includedInCalibrationTimeline, true);
    assert.equal(
      result.methodology.calibrationStatus,
      "eligible_active_retention",
    );
    assert.equal(
      result.methodology.retentionScope,
      "active_logs2_approximately_ten_days",
    );
    assert.equal(result.methodology.approximateRetentionDays, 10);
    assert.ok(result.timeline.length > 0);
    assert.equal(result.timeline[0].pricingCoverage.fullyPricedEvents, 0);
    assert.ok(result.timeline.every(
      (row) => row.pricingCoverage.partiallyPricedEvents > 0,
    ));
    assert.equal(
      Object.values(result.timeline[0].speedWeighting)
        .flatMap((families) => Object.values(families))
        .reduce((total, cell) => total + cell.events, 0),
      result.timeline[0].usageEvents,
    );
    assert.equal(
      result.timeline[0].declaredSpeedWeighting.fast["gpt-5.6"].events,
      1,
    );
    assert.equal(
      result.timeline[0].declaredSpeedWeighting.fast["gpt-5.6"]
        .apiPriceEquivalentUsd,
      result.recent[0].estimatedApiPriceEquivalentUsd,
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(CHILD), false);
    assert.equal(serialized.includes(PARENT), false);
    assert.equal(serialized.includes(INCOMPLETE_CHILD), false);
    assert.equal(serialized.includes(TURN_ONE), false);
    assert.equal(serialized.includes("999999"), false);

    const contextDatabase = new DatabaseSync(databaseFile);
    const update = contextDatabase.prepare(
      "UPDATE logs SET feedback_log_body = ? WHERE id = ?",
    );
    update.run(samplingBody(TURN_ONE, 400_000), 1);
    update.run(samplingBody(TURN_ONE, 400_000), 2);
    contextDatabase.close();
    const outsideContext = await collectSideChatEstimates({
      codexHome,
      desktopLogRoot: desktopRoot,
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    });
    assert.equal(
      outsideContext.methodology.calibrationStatus,
      "withheld_context_mismatch",
    );
    assert.equal(outsideContext.timeline.length, 0);

    const malformedDatabase = new DatabaseSync(databaseFile);
    const malformedUpdate = malformedDatabase.prepare(
      "UPDATE logs SET feedback_log_body = ? WHERE id = ?",
    );
    malformedUpdate.run(
      `${samplingBody(TURN_ONE, 400_000)} retry_variant=1`,
      2,
    );
    malformedUpdate.run(
      `run_auto_compact{malformed} turn.id=${TURN_TWO}`,
      3,
    );
    malformedDatabase.close();
    const parserGap = await collectSideChatEstimates({
      codexHome,
      desktopLogRoot: desktopRoot,
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    });
    assert.equal(parserGap.coverage.ambiguousDuplicateMarkers, 1);
    assert.equal(parserGap.coverage.rejectedCompactionMarkers, 1);
    assert.equal(
      parserGap.methodology.calibrationStatus,
      "withheld_parser_gaps",
    );
    assert.equal(parserGap.timeline.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("side-chat estimator keeps retained estimates separate when lifecycle coverage is partial", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-chat-estimates-partial-"));
  const codexHome = join(root, ".codex");
  const desktopRoot = join(root, "desktop-logs");
  await mkdir(codexHome, { recursive: true });
  await mkdir(desktopRoot, { recursive: true });
  await writeFile(join(desktopRoot, "main.log"), [
    `2026-08-16T11:00:00.000Z method=thread/fork conversationId=${PARENT}`,
    `2026-08-16T11:00:01.000Z method=thread/inject_items conversationId=${CHILD}`,
    `2026-08-16T11:00:02.000Z IAB_LIFECYCLE captured session route conversationId=${CHILD} disposeAfterSessionActivity=false`,
    `2026-08-16T11:10:00.000Z method=thread/fork conversationId=${PARENT}`,
    `2026-08-16T11:10:01.000Z method=thread/inject_items conversationId=${INCOMPLETE_CHILD}`,
    `2026-08-16T11:10:02.000Z IAB_LIFECYCLE captured session route conversationId=${INCOMPLETE_CHILD} disposeAfterSessionActivity=false`,
    "",
  ].join("\n"));

  const database = new DatabaseSync(join(codexHome, "logs_2.sqlite"));
  database.exec(`CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    thread_id TEXT
  )`);
  database.prepare(`
    INSERT INTO logs (id, ts, ts_nanos, target, feedback_log_body, thread_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    1,
    seconds("2026-08-16T11:01:00.000Z"),
    0,
    "codex_core::session::turn",
    samplingBody(TURN_ONE, 100_000),
    CHILD,
  );
  database.close();

  try {
    const result = await collectSideChatEstimates({
      codexHome,
      desktopLogRoot: desktopRoot,
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(result.coverage.detectedSessions, 2);
    assert.equal(result.coverage.retainedNumericSessions, 1);
    assert.equal(result.coverage.sessionsWithoutNumericEvidence, 1);
    assert.equal(result.coverage.status, "partial_diagnostic_retention");
    assert.equal(result.methodology.includedInCalibrationTimeline, true);
    assert.equal(
      result.methodology.calibrationStatus,
      "eligible_active_retention",
    );
    assert.equal(result.periods.find((row) => row.periodId === "all").samplingCalls, 1);
    assert.ok(result.timeline.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("side-chat estimator keeps detected lifecycles when numeric logs are empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-chat-estimates-empty-logs-"));
  const codexHome = join(root, ".codex");
  const desktopRoot = join(root, "desktop-logs");
  await mkdir(codexHome, { recursive: true });
  await mkdir(desktopRoot, { recursive: true });
  await writeFile(join(desktopRoot, "main.log"), [
    `2026-08-16T11:00:00.000Z method=thread/fork conversationId=${PARENT}`,
    `2026-08-16T11:00:01.000Z method=thread/inject_items conversationId=${CHILD}`,
    `2026-08-16T11:00:02.000Z IAB_LIFECYCLE captured session route conversationId=${CHILD} disposeAfterSessionActivity=false`,
    "",
  ].join("\n"));

  const database = new DatabaseSync(join(codexHome, "logs_2.sqlite"));
  database.exec(`CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    thread_id TEXT
  )`);
  database.close();

  try {
    const result = await collectSideChatEstimates({
      codexHome,
      desktopLogRoot: desktopRoot,
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    });
    assert.equal(result.status, "available");
    assert.equal(result.coverage.detectedSessions, 1);
    assert.equal(result.coverage.retainedNumericSessions, 0);
    assert.equal(result.coverage.sessionsWithoutNumericEvidence, 1);
    assert.deepEqual(result.coverage.logs2, {
      startAt: null,
      endAt: null,
      sourceScope: "active_logs2_retention_only",
    });
    assert.equal(result.coverage.status, "partial_diagnostic_retention");
    assert.equal(
      result.methodology.calibrationStatus,
      "withheld_no_retained_calls",
    );
    assert.equal(result.timeline.length, 0);
    assert.ok(result.periods.every((period) => (
      period.samplingCalls === 0
        && period.pricedCalls === 0
        && period.unpricedCalls === 0
        && period.estimatedApiPriceEquivalentUsd === 0
    )));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold sensitivity uses ordinary uncached input when an older model has no cache-write card", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-chat-estimates-older-model-"));
  const codexHome = join(root, ".codex");
  const desktopRoot = join(root, "desktop-logs");
  await mkdir(codexHome, { recursive: true });
  await mkdir(desktopRoot, { recursive: true });
  await writeFile(join(desktopRoot, "main.log"), [
    `2026-08-16T11:00:00.000Z method=thread/fork conversationId=${PARENT}`,
    `2026-08-16T11:00:01.000Z method=thread/inject_items conversationId=${CHILD}`,
    `2026-08-16T11:00:02.000Z IAB_LIFECYCLE captured session route conversationId=${CHILD} disposeAfterSessionActivity=false`,
    "",
  ].join("\n"));

  const database = new DatabaseSync(join(codexHome, "logs_2.sqlite"));
  database.exec(`CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    thread_id TEXT
  )`);
  database.prepare(`
    INSERT INTO logs (id, ts, ts_nanos, target, feedback_log_body, thread_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    1,
    seconds("2026-08-16T11:01:00.000Z"),
    0,
    "codex_core::session::turn",
    samplingBody(TURN_ONE, 100_000, "codex-auto-review"),
    CHILD,
  );
  database.close();

  try {
    const result = await collectSideChatEstimates({
      codexHome,
      desktopLogRoot: desktopRoot,
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    });
    const all = result.periods.find((period) => period.periodId === "all");
    assert.equal(all.pricedCalls, 1);
    assert.equal(all.unpricedCalls, 0);
    assert.ok(all.estimatedRangeUsd.upper > all.estimatedApiPriceEquivalentUsd);
    assert.equal(result.recent[0].model, "codex-auto-review");
    assert.equal(result.recent[0].pricingBasis, "reviewed_alias_assumption");
    assert.ok(result.recent[0].estimatedRangeUsd !== null);
    assert.equal(result.methodology.includedInCalibrationTimeline, false);
    assert.equal(
      result.methodology.calibrationStatus,
      "withheld_cohort_mismatch",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical side-chat gap probe keeps exact usage separate from its quota-residual backcast", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-chat-historical-gap-"));
  const indexFile = join(root, "unified.sqlite");
  const stateFile = join(root, "collector.sqlite");
  const database = openLocalUnifiedIndex(indexFile, { create: true });
  const startMs = Date.parse("2026-07-13T04:00:00.000Z");
  const endMs = Date.parse("2026-07-14T04:00:00.000Z");
  const resetMs = Date.parse("2026-07-19T19:00:50.000Z");
  try {
    database.exec(`
      INSERT INTO parser_version(id, parser_version, contract_version)
      VALUES (1, 'fixture-v1', 'fixture-v1');
      INSERT INTO ingest_run(id, received_at_ms, parser_version_id)
      VALUES (1, ${startMs}, 1);
      INSERT INTO model(id, model_id, recognition)
      VALUES (1, 'gpt-5.6-terra', 'recognized');
      INSERT INTO tier_semantics(
        id, api_service_tier, billing_surface, codex_speed_mode,
        tier_source, provider_tier_raw)
      VALUES
        (1, 'standard', 'subscription', 'fast', 'observed', 'priority'),
        (2, 'standard', 'subscription', 'standard', 'observed', 'default'),
        (3, 'standard', 'subscription', 'unknown', 'unobserved', NULL);
      INSERT INTO surface_class(
        id, agent_scope, surface, thread_source, lineage_disposition)
      VALUES (1, 'root', 'extension_or_ide', 'rollout', 'standalone');
      INSERT INTO account_scope(id, status, reason, plan_type, scope_local)
      VALUES (1, 'missing', 'fixture', NULL, NULL);
      INSERT INTO quota_observation(
        id, observed_at_ms, limit_id, slot, plan_type, used_percent,
        resets_at_ms, duration_mins)
      VALUES
        (1, ${startMs - 5 * 60_000}, 'codex', 'primary', NULL, 10,
          ${resetMs}, 10080),
        (2, ${startMs + 5 * 60_000}, 'codex', 'primary', NULL, 10,
          ${resetMs}, 10080),
        (3, ${endMs - 5 * 60_000}, 'codex', 'primary', NULL, 30,
          ${resetMs}, 10080),
        (4, ${endMs + 5 * 60_000}, 'codex', 'primary', NULL, 30,
          ${resetMs}, 10080);
    `);
    const insertUsage = database.prepare(`
      INSERT INTO usage_event(
        event_key, observed_at_ms, ingest_run_id, parser_version_id,
        source_id, source_offset, session_local, account_scope_id,
        model_id, tier_id, surface_id, quota_observation_id,
        reasoning_effort, outcome, tokens_in_uncached,
        tokens_in_cache_read, tokens_in_cache_write,
        tokens_in_cache_write_5m, tokens_in_cache_write_1h,
        tokens_out_text, tokens_out_reasoning, tokens_out_combined,
        total_input_context)
      VALUES (?, ?, 1, 1, NULL, NULL, ?, 1, 1, ?, 1, NULL,
        3, 0, 100000, 0, 0, 0, 0, 1000, 0, 0, NULL)
    `);
    for (const [index, tier] of [1, 2, 3].entries()) {
      insertUsage.run(
        Buffer.alloc(32, index + 1),
        startMs + (index + 1) * 60_000,
        Buffer.alloc(32, index + 11),
        tier,
      );
    }
  } finally {
    database.close();
  }
  await writeLocalCollectorAccountingCache({
    stateFile,
    cache: {
      schemaVersion: NEWER_REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
      priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
      priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
      accountingMethod:
        "lineage_aware_cumulative_snapshot_replay_exclusion",
      priceEpochBasis:
        "event_time_when_registry_has_effective_evidence",
      allowanceCapacityByScenario: {
        schemaVersion: "codex-primary-allowance-capacity-v0.1",
        basisFamilyId: codexPrimaryAllowanceBasis(
          "unresolved_as_standard",
        ).basisFamilyId,
        scenarios: Object.fromEntries([
          ["unresolved_as_standard", "speed_lower", 100, 80, 120],
          ["unresolved_as_fast", "speed_upper", 250, 200, 300],
        ].map(([scenario, candidate, median, lower, upper]) => [
          scenario,
          {
            basis: codexPrimaryAllowanceBasis(scenario),
            calibration: {
              schemaVersion: "weekly-calibration-summary-v0.1",
              status: "estimated",
              generatedAt: "2026-08-17T12:00:00.000Z",
              evidenceBasis:
                "lineage_aware_local_usage_and_provider_percentage_snapshots",
              interpretation:
                "conditional_api_price_equivalent_not_provider_allowance_or_bill",
              accountAttribution: {
                status: "historical_unattributed",
                maySpanMultipleAccounts: true,
              },
              validation: { selectedCostBasis: candidate },
              estimate: {
                medianApiPriceEquivalentUsd: median,
                plausibleRangeUsd: { lower, upper },
                qualifyingResets: 10,
              },
              recentResets: [{
                resetIdentity: "2026-07-19T19:00:50.000Z",
              }],
            },
          },
        ])),
      },
    },
  });
  try {
    const result = await collectHistoricalSideChatGapProbe({
      unifiedIndexFile: indexFile,
      collectorStateFile: stateFile,
      date: "2026-07-13",
    });
    assert.equal(result.status, "available");
    assert.equal(result.startAt, "2026-07-13T04:00:00.000Z");
    assert.equal(result.endAt, "2026-07-14T04:00:00.000Z");
    assert.equal(result.quota.minimumMovementPercentagePoints, 20);
    assert.equal(result.quota.maximumMovementPercentagePoints, 20);
    assert.equal(result.exactUsage.events, 3);
    assert.equal(result.exactUsage.sessions, 3);
    assert.deepEqual(
      Object.fromEntries(Object.entries(result.exactUsage.bySpeed).map(
        ([speed, row]) => [speed, row.events],
      )),
      { fast: 1, standard: 1, unknown: 1, other: 0 },
    );
    assert.ok(
      result.exactUsage.quotaWeightedApiPriceEquivalentRangeUsd.upper
        > result.exactUsage.quotaWeightedApiPriceEquivalentRangeUsd.lower,
    );
    assert.equal(result.exactUsage.allowanceWeighting.status, "complete");
    assert.equal(
      result.exactUsage.allowanceWeighting.selectedScenario,
      "unresolved_as_standard",
    );
    assert.equal(
      result.exactUsage.allowanceWeighting.scenarios
        .unresolved_as_standard.coverage.assumedFromPreferenceEvents,
      1,
    );
    assert.equal(result.estimate.allowanceComparison.status, "complete");
    assert.equal(
      result.estimate.allowanceComparison.selectedExpectedPercentagePoints,
      result.estimate.exactCostImpliedMedianRangePercentagePoints.lower,
    );
    assert.equal(
      result.estimate.exactCostImpliedMedianRangePercentagePoints.lower,
      result.estimate.exactCostImpliedMedianRangePercentagePoints.upper,
    );
    assert.equal(result.estimate.fastQuotaMultiplier, 2.5);
    assert.equal(result.estimate.includedInExactUsage, false);
    assert.equal(result.estimate.includedInCalibrationTimeline, false);
    assert.equal(result.estimate.independentlyObserved, false);
    assert.equal(result.calibration.sourceCacheRelationship,
      "validated_newer_schema_subdocument");
    assert.equal(
      result.calibration.scenarios.unresolved_as_fast
        .medianWeeklyCapacityUsd,
      250,
    );
    const fast = await collectHistoricalSideChatGapProbe({
      unifiedIndexFile: indexFile,
      collectorStateFile: stateFile,
      date: "2026-07-13",
      fastModePreference: "fast",
    });
    assert.equal(fast.status, "available");
    assert.equal(
      fast.exactUsage.allowanceWeighting.selectedScenario,
      "unresolved_as_fast",
    );
    assert.ok(
      fast.exactUsage.allowanceWeighting.selectedUsd
        > result.exactUsage.allowanceWeighting.selectedUsd,
    );
    const mixed = await collectHistoricalSideChatGapProbe({
      unifiedIndexFile: indexFile,
      collectorStateFile: stateFile,
      date: "2026-07-13",
      fastModePreference: "mixed_unknown",
    });
    assert.equal(mixed.status, "available");
    assert.equal(mixed.exactUsage.allowanceWeighting.status, "range");
    assert.equal(mixed.exactUsage.allowanceWeighting.selectedUsd, null);
    assert.equal(mixed.estimate.allowanceComparison.status, "range");
    const declared = await collectHistoricalSideChatGapProbe({
      unifiedIndexFile: indexFile,
      collectorStateFile: stateFile,
      date: "2026-07-13",
      declaredSpeedBaselines: [{
        mode: "fast",
        firstSeenAt: new Date(startMs + 3 * 60_000).toISOString(),
        lastSeenAt: new Date(startMs + 3 * 60_000).toISOString(),
      }],
    });
    assert.equal(declared.status, "available");
    assert.equal(
      declared.exactUsage.allowanceWeighting.scenarios
        .unresolved_as_standard.coverage.declaredFromConfigEvents,
      1,
    );
    assert.equal(
      declared.exactUsage.allowanceWeighting.scenarios
        .unresolved_as_standard.coverage.assumedFromPreferenceEvents,
      0,
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(Buffer.alloc(32, 11).toString("hex")), false);
    assert.equal(serialized.includes("event_key"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
