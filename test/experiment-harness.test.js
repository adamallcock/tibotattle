import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { environmentForWorkload, runExperiment, validateExperimentManifest } from "../src/experiment-harness.js";

const PRICE_CARDS = [{
  schema_version: "0.1",
  id: "openai:gpt-test:test",
  provider: "openai",
  model: "gpt-test",
  components: [
    { usage_component: "input_uncached_tokens", unit: "token", price: { amount: "1", currency: "USD", per: "1000" } },
    { usage_component: "input_cache_read_tokens", unit: "token", price: { amount: "0.1", currency: "USD", per: "1000" } },
    { usage_component: "input_cache_write_tokens", unit: "token", price: { amount: "1.25", currency: "USD", per: "1000" } },
    { usage_component: "output_text_tokens", unit: "token", price: { amount: "2", currency: "USD", per: "1000" } },
    { usage_component: "output_reasoning_tokens", unit: "token", price: { amount: "2", currency: "USD", per: "1000" } },
  ],
  source: { name: "test", url: "https://example.invalid/pricing", retrieved_at: "2026-07-23T00:00:00.000Z" },
}];

function manifest(overrides = {}) {
  return {
    schemaVersion: "0.3",
    experimentId: "test-pilot-v1",
    hypothesis: "A small controlled turn should remain within all declared budgets.",
    mode: "live",
    model: "gpt-test",
    reasoningEffort: "low",
    tierDeclaration: {
      billingSurface: "chatgpt_subscription",
      codexSpeedMode: "standard",
      apiServiceTier: "unknown",
      providerTierRaw: "default",
      tierSource: "experiment_manifest",
      tierObservedAt: null,
    },
    workloadId: "no-tool-arithmetic-v1",
    contextBand: { targetInputTokens: 1000, maximumInputTokens: 2000 },
    cacheState: "uncached",
    permittedToolClass: "none",
    projectedUsage: {
      inputUncachedTokens: 1000,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 10,
      outputReasoningTokens: 10,
      outputCombinedTokens: null,
    },
    budgets: {
      maximumTurns: 1,
      maximumElapsedMs: 10000,
      maximumApiPricedUsd: 2,
      maximumDisplayedQuotaMovement: 1,
      minimumQuotaHeadroomPercent: 10,
      minimumQuietPeriodMs: 15000,
    },
    requiredCaptures: { before: true, after: true },
    concurrency: "none",
    ...overrides,
  };
}

function accountSnapshot(percent, reset = 1784854800) {
  return {
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: percent, windowDurationMins: 10080, resetsAt: reset },
        secondary: null,
      },
      rateLimitsByLimitId: {},
    },
    accountUsage: { dailyUsageBuckets: [] },
  };
}

function localUsage(cost = 1) {
  return {
    runcost: { totalUsd: cost, byModel: { "gpt-test": { events: 1 } }, warningCounts: {} },
    components: { input_uncached_tokens: 1000, output_text_tokens: 10 },
    toolCallsByClass: {},
    diagnostics: { pricedEvents: 1, usageBearingRollouts: 1, concurrentLocalUsageDetected: false },
  };
}

const quietConcurrency = async ({ lookbackMs }) => ({
  lookbackMs,
  usageEvents: 0,
  usageBearingRollouts: 0,
  lastUsageAt: null,
  controllerExclusionApplied: true,
  excludedControllerRollouts: 1,
  activeTaskRolloutsAtEnd: 0,
  activeTaskRecencyMs: 300000,
});

test("manifest validation enforces one-turn, headroom, capture, and tool budgets", () => {
  assert.equal(validateExperimentManifest(manifest()).experimentId, "test-pilot-v1");
  assert.throws(() => validateExperimentManifest(manifest({ budgets: { ...manifest().budgets, maximumTurns: 2 } })), /exactly one turn/);
  assert.throws(() => validateExperimentManifest(manifest({ budgets: { ...manifest().budgets, minimumQuotaHeadroomPercent: 2 } })), /at least five/);
  assert.throws(() => validateExperimentManifest(manifest({ permittedToolClass: "web_search" })), /does not match/);
  assert.throws(() => validateExperimentManifest(manifest({ concurrency: "parallel" })), /concurrency/);
});

test("workload environment does not inherit the controller thread identity", () => {
  const source = { PATH: "/safe/bin", CODEX_THREAD_ID: "controller-session-secret", CODEX_CI: "1" };
  const result = environmentForWorkload(source);
  assert.deepEqual(result, { PATH: "/safe/bin", CODEX_CI: "1" });
  assert.equal(source.CODEX_THREAD_ID, "controller-session-secret");
});

test("every checked-in experiment manifest validates", async () => {
  const directory = new URL("../experiments/manifests/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  assert.ok(files.length >= 7);
  for (const file of files) {
    const value = JSON.parse(await readFile(new URL(file, directory), "utf8"));
    assert.equal(validateExperimentManifest(value), value, file);
  }
});

test("dry-run prices the manifest without reading quota or executing a workload", async () => {
  let reads = 0;
  let executions = 0;
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: false,
    priceCards: PRICE_CARDS,
    readSnapshot: async () => { reads += 1; return accountSnapshot(10); },
    executeWorkload: async () => { executions += 1; },
  });
  assert.equal(result.status, "dry_run_only");
  assert.equal(result.projection.priceResolution.serviceTier.observed, null);
  assert.equal(result.projection.priceResolution.serviceTier.apiPriceAssumption, "standard");
  assert.deepEqual(result.stopReasons, ["live_execution_flag_required"]);
  assert.equal(result.projection.totalUsd, 1.04);
  assert.equal(reads, 0);
  assert.equal(executions, 0);
  assert.equal(JSON.stringify(result).includes("Compute 271828"), false);
});

test("live preflight refuses insufficient quota headroom before workload execution", async () => {
  let executions = 0;
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: true,
    priceCards: PRICE_CARDS,
    readSnapshot: async () => accountSnapshot(98),
    readConcurrency: quietConcurrency,
    executeWorkload: async () => { executions += 1; },
    clock: () => Date.parse("2026-07-23T00:00:00.000Z"),
  });
  assert.equal(result.status, "preflight_refused");
  assert.deepEqual(result.stopReasons, ["insufficient_quota_headroom"]);
  assert.equal(executions, 0);
});

test("live preflight refuses recent local activity before workload execution", async () => {
  let executions = 0;
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: true,
    priceCards: PRICE_CARDS,
    readSnapshot: async () => accountSnapshot(20),
    readConcurrency: async ({ lookbackMs }) => ({
      lookbackMs,
      usageEvents: 2,
      usageBearingRollouts: 1,
      lastUsageAt: "2026-07-23T00:00:00.000Z",
    }),
    executeWorkload: async () => { executions += 1; },
    clock: () => Date.parse("2026-07-23T00:00:01.000Z"),
  });
  assert.equal(result.status, "preflight_refused");
  assert.ok(result.stopReasons.includes("recent_local_activity_detected"));
  assert.equal(result.concurrencyPreflight.usageEvents, 2);
  assert.equal(executions, 0);
});

test("live preflight refuses an active local task even before it emits usage", async () => {
  let executions = 0;
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: true,
    priceCards: PRICE_CARDS,
    readSnapshot: async () => accountSnapshot(20),
    readConcurrency: async ({ lookbackMs }) => ({
      lookbackMs,
      usageEvents: 0,
      usageBearingRollouts: 0,
      lastUsageAt: null,
      controllerExclusionApplied: true,
      excludedControllerRollouts: 1,
      activeTaskRolloutsAtEnd: 1,
    }),
    executeWorkload: async () => { executions += 1; },
    clock: () => Date.parse("2026-07-23T00:00:01.000Z"),
  });
  assert.equal(result.status, "preflight_refused");
  assert.ok(result.stopReasons.includes("active_local_task_detected"));
  assert.equal(executions, 0);
});

test("a bounded live pilot captures before and after evidence without content", async () => {
  let snapshotReads = 0;
  let workloadRuns = 0;
  let scanOptions = null;
  const times = [
    Date.parse("2026-07-23T00:00:00.000Z"),
    Date.parse("2026-07-23T00:00:01.000Z"),
    Date.parse("2026-07-23T00:00:03.000Z"),
    Date.parse("2026-07-23T00:00:04.000Z"),
  ];
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: true,
    priceCards: PRICE_CARDS,
    clock: () => times.shift(),
    readSnapshot: async () => accountSnapshot(snapshotReads++ === 0 ? 20 : 21),
    readConcurrency: quietConcurrency,
    executeWorkload: async () => { workloadRuns += 1; return { exitCode: 0 }; },
    controllerSessionId: "controller-session-secret",
    scanUsage: async (options) => {
      scanOptions = options;
      return { ...localUsage(1), diagnostics: { ...localUsage(1).diagnostics, excludedRollouts: 1 } };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.controlledState, "controlled");
  assert.equal(workloadRuns, 1);
  assert.equal(result.quotaChanges[0].displayedMovement, 1);
  assert.equal(result.measuredLocal.apiPricedUsd, 1);
  assert.equal(result.concurrencyEvidence.concurrentLocalUsageDetected, false);
  assert.deepEqual(scanOptions.excludeSessionIds, ["controller-session-secret"]);
  assert.equal(result.concurrencyEvidence.controllerExclusionApplied, true);
  assert.equal(result.concurrencyEvidence.excludedControllerRollouts, 1);
  assert.equal(result.privacy.promptStored, false);
  assert.equal(result.privacy.responseStored, false);
  assert.equal(result.concurrencyPreflight.controllerExclusionApplied, true);
  assert.equal(JSON.stringify(result).includes("controller-session-secret"), false);
});

test("concurrent rollout usage and unexpected tools invalidate controlled state", async () => {
  let reads = 0;
  const times = [
    Date.parse("2026-07-23T00:00:00.000Z"),
    Date.parse("2026-07-23T00:00:01.000Z"),
    Date.parse("2026-07-23T00:00:03.000Z"),
    Date.parse("2026-07-23T00:00:04.000Z"),
  ];
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: true,
    priceCards: PRICE_CARDS,
    clock: () => times.shift(),
    readSnapshot: async () => accountSnapshot(reads++ === 0 ? 20 : 20),
    readConcurrency: quietConcurrency,
    executeWorkload: async () => ({ exitCode: 0 }),
    scanUsage: async () => ({
      ...localUsage(1),
      toolCallsByClass: { local_shell: 1 },
      diagnostics: { pricedEvents: 2, usageBearingRollouts: 2, concurrentLocalUsageDetected: true },
    }),
  });
  assert.equal(result.status, "completed_with_stop");
  assert.equal(result.controlledState, "unknown");
  assert.ok(result.stopReasons.includes("concurrent_local_usage_detected"));
  assert.ok(result.stopReasons.includes("unexpected_tool_activity"));
});

test("postflight cost and reset breaches complete with explicit stops", async () => {
  let reads = 0;
  const times = [
    Date.parse("2026-07-23T00:00:00.000Z"),
    Date.parse("2026-07-23T00:00:01.000Z"),
    Date.parse("2026-07-23T00:00:03.000Z"),
    Date.parse("2026-07-23T00:00:04.000Z"),
  ];
  const result = await runExperiment({
    manifest: manifest(),
    executeLive: true,
    priceCards: PRICE_CARDS,
    clock: () => times.shift(),
    readSnapshot: async () => accountSnapshot(20, reads++ === 0 ? 1784854800 : 1785459600),
    readConcurrency: quietConcurrency,
    executeWorkload: async () => ({ exitCode: 0 }),
    scanUsage: async () => localUsage(3),
  });
  assert.equal(result.status, "completed_with_stop");
  assert.ok(result.stopReasons.includes("measured_api_price_budget_exceeded"));
  assert.ok(result.stopReasons.includes("reset_changed"));
  assert.equal(result.controlledState, "unknown");
});

test("unknown model pricing warning blocks live execution", async () => {
  let executions = 0;
  const result = await runExperiment({
    manifest: manifest({ model: "gpt-not-priced" }),
    executeLive: true,
    priceCards: PRICE_CARDS,
    readSnapshot: async () => accountSnapshot(20),
    readConcurrency: quietConcurrency,
    executeWorkload: async () => { executions += 1; },
    clock: () => Date.parse("2026-07-23T00:00:00.000Z"),
  });
  assert.equal(result.status, "preflight_refused");
  assert.ok(result.stopReasons.includes("pricing_warning"));
  assert.equal(executions, 0);
});
