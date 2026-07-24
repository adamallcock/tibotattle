import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProviderCrosscheck } from "../src/provider-crosscheck.js";
import { createInitialPlanTimeline } from "../src/plan-timeline.js";

const SCOPE = "openai-account:v1:0123456789abcdef0123456789abcdef0123456789a";

function accountSnapshot() {
  return {
    capturedAt: "2026-07-24T00:00:00.000Z",
    accountScope: { status: "available", reason: null, version: "openai-account-v1", scopeId: SCOPE, planType: "pro" },
    canonical: { planType: "pro", primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1785456360 } },
    officialDailyTokens: [
      { date: "2026-07-22", tokens: 200 },
      { date: "2026-07-23", tokens: 300 },
    ],
    officialUsageSummary: { lifetimeTokens: 1000 },
  };
}

function localScan() {
  return {
    startAt: "2026-07-22T00:00:00.000Z",
    endAt: "2026-07-23T23:59:59.999Z",
    eventCount: 2,
    totalTokens: 300,
    runcost: { totalUsd: 3 },
    bySurface: { scheduled_task: { events: 1, totalTokens: 100, totalUsd: 1 } },
    daily: [
      { date: "2026-07-22", events: 1, totalTokens: 100, totalUsd: 1, bySurface: { scheduled_task: { events: 1, totalTokens: 100, totalUsd: 1 } } },
      { date: "2026-07-23", events: 1, totalTokens: 200, totalUsd: 2, bySurface: { subagent: { events: 1, totalTokens: 200, totalUsd: 2 } } },
    ],
    diagnostics: { forkReplayEventsSkipped: 9, rolloutsBySurface: { scheduled_task: 1, subagent: 1 }, rolloutsByThreadSource: {}, rolloutsByAgentScope: {} },
  };
}

test("crosscheck keeps provider activity unallocated and partitions by pseudonymous scope", () => {
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    planTimeline: createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-07-23T00:00:00Z" }),
    providerUiObservations: [{
      kind: "provider_ui_usage_snapshot",
      capturedAt: "2026-07-24T00:01:00.000Z",
      accountScope: accountSnapshot().accountScope,
      range: { startAt: "2026-06-25T00:00:00.000Z", endAt: "2026-07-24T23:59:59.999Z" },
      weekly: { remainingPercent: 74, resetsAt: "2026-07-30T20:06:00.000Z" },
      turnsByModelTotal: 6844,
      turnsBySurfaceTotal: 5275,
      surfaceCategories: ["desktop", "cli", "extension", "cloud", "mobile", "code_review"],
      workSharedPoolTextObserved: true,
      email: "must-not-survive@example.test",
    }],
  });
  assert.equal(report.comparisons.aggregateLocalToOfficialTokenRatio, 0.6);
  assert.equal(report.comparisons.aggregateUnallocatedProviderTokens, 200);
  assert.equal(report.comparisons.aggregateLocalExcessTokens, 0);
  assert.equal(report.comparisons.accountCompatibility.verdict, "not_disproven_by_lifetime_total");
  assert.equal(report.comparisons.accountPartitioning.comparisonEligibility, "coverage_diagnostic_only_not_account_matched");
  assert.equal(report.comparisons.daily[0].plan.planVariant, "unknown");
  assert.equal(report.comparisons.daily[0].plan.source, "historical_local_account_unattributed");
  assert.equal(report.comparisons.daily[0].classification, "material_provider_activity_unallocated");
  assert.equal(report.comparisons.uiVsAppServer[0].percentagePointDifference, 0);
  assert.equal(report.provider.uiObservations[0].turnsByModelTotal, 6844);
  assert.equal(JSON.stringify(report).includes("must-not-survive"), false);
});

test("malformed UI percentages and turn counts are unavailable rather than retained", () => {
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    providerUiObservations: [{
      kind: "provider_ui_usage_snapshot",
      capturedAt: "2026-07-24T00:01:00.000Z",
      accountScope: accountSnapshot().accountScope,
      range: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-07-24T00:00:00.000Z" },
      weekly: { remainingPercent: 101, resetsAt: "2026-07-30T20:06:00.000Z" },
      turnsByModelTotal: 1.5,
      turnsBySurfaceTotal: -1,
    }],
  });
  assert.equal(report.provider.uiObservations[0].weekly.remainingPercent, null);
  assert.equal(report.provider.uiObservations[0].turnsByModelTotal, null);
  assert.equal(report.provider.uiObservations[0].turnsBySurfaceTotal, null);
  assert.equal(report.comparisons.uiVsAppServer[0].percentagePointDifference, null);
});

test("stale UI observations are retained but never compared to a current app snapshot", () => {
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    providerUiObservations: [{
      kind: "provider_ui_usage_snapshot",
      capturedAt: "2026-07-20T00:00:00.000Z",
      accountScope: accountSnapshot().accountScope,
      range: { startAt: "2026-06-20T00:00:00.000Z", endAt: "2026-07-20T00:00:00.000Z" },
      weekly: { remainingPercent: 74, resetsAt: "2026-07-30T20:06:00.000Z" },
    }],
  });
  assert.equal(report.comparisons.uiVsAppServer[0].comparisonStatus, "not_comparable_stale_or_missing_capture");
  assert.equal(report.comparisons.uiVsAppServer[0].percentagePointDifference, null);
  assert.equal(report.comparisons.uiVsAppServer[0].resetDifferenceSeconds, null);
});

test("UI observations from a different account scope are excluded", () => {
  const otherScope = `openai-account:v1:${"z".repeat(43)}`;
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    providerUiObservations: [{
      kind: "provider_ui_usage_snapshot",
      capturedAt: "2026-07-24T00:01:00.000Z",
      accountScope: { status: "available", version: "openai-account-v1", scopeId: otherScope, planType: "pro" },
      range: { startAt: "2026-07-01T00:00:00.000Z", endAt: "2026-07-24T00:00:00.000Z" },
      weekly: { remainingPercent: 74, resetsAt: "2026-07-30T20:06:00.000Z" },
    }],
  });
  assert.equal(report.provider.uiObservations.length, 0);
  assert.equal(report.comparisons.uiVsAppServer.length, 0);
});

test("policy-epoch ratios compare only days with an official provider bucket", () => {
  const report = analyzeProviderCrosscheck({
    localScan: {
      startAt: "2026-07-09T00:00:00.000Z",
      endAt: "2026-07-10T23:59:59.999Z",
      eventCount: 2,
      totalTokens: 1_100,
      runcost: { totalUsd: 1 },
      daily: [
        { date: "2026-07-09", totalTokens: 100, totalUsd: 0.1, events: 1 },
        { date: "2026-07-10", totalTokens: 1_000, totalUsd: 0.9, events: 1 },
      ],
      diagnostics: {},
    },
    accountSnapshot: {
      capturedAt: "2026-07-11T00:00:00.000Z",
      accountScope: { status: "unavailable", reason: "missing_hmac_key", version: "openai-account-v1", scopeId: null, planType: "unknown" },
      officialDailyTokens: [{ date: "2026-07-09", tokens: 200 }],
      canonical: { planType: "pro", primary: null },
    },
  });

  assert.equal(report.comparisons.byPolicyEpoch[0].localTokens, 1_100);
  assert.equal(report.comparisons.byPolicyEpoch[0].comparableLocalTokens, 100);
  assert.equal(report.comparisons.byPolicyEpoch[0].officialTokens, 200);
  assert.equal(report.comparisons.byPolicyEpoch[0].localToOfficialRatio, 0.5);
});

test("stale cache override remains visible in durable crosscheck output", () => {
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    cacheValidation: { status: "stale_override" },
  });
  assert.equal(report.local.cacheValidation.status, "stale_override");
  assert.ok(report.limitations.some((value) => value.includes("explicit stale override")));
});

test("prospective collector comparison filters by account and dates plan variants", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-07-23T00:00:00Z" });
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    planTimeline: timeline,
    prospectiveCollectorRecords: [
      {
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-23T12:00:00.000Z",
        accountScope: accountSnapshot().accountScope,
        components: { input_uncached_tokens: 25, output_text_tokens: 5 },
      },
      {
        kind: "codex_rollout_usage_snapshot",
        observedAt: "2026-07-23T12:01:00.000Z",
        accountScope: { ...accountSnapshot().accountScope, scopeId: `openai-account:v1:${"z".repeat(43)}` },
        components: { input_uncached_tokens: 999 },
      },
    ],
  });
  const scoped = report.comparisons.prospectiveAccountScoped;
  assert.equal(scoped.status, "available_partial");
  assert.equal(scoped.eventCount, 1);
  assert.equal(scoped.totalTokens, 30);
  assert.equal(scoped.byPlanVariant["pro-20x"].eventCount, 1);
  assert.equal(scoped.daily[0].officialAccountTokens, 300);
  assert.equal(scoped.daily[0].partialLocalToOfficialRatio, 0.1);
});

test("prospective comparison never assigns one provider day across mixed plan variants", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-07-23T00:00:00Z" });
  timeline.profiles[0].periods.push({
    planVariant: "pro-5x",
    startAt: "2026-07-23T12:00:00.000Z",
    endAt: "2026-07-23T13:00:00.000Z",
  });
  const scopedRecord = (observedAt) => ({
    kind: "codex_rollout_usage_snapshot",
    observedAt,
    accountScope: accountSnapshot().accountScope,
    components: { input_uncached_tokens: 10 },
  });
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    planTimeline: timeline,
    prospectiveCollectorRecords: [
      scopedRecord("2026-07-23T11:00:00.000Z"),
      scopedRecord("2026-07-23T12:30:00.000Z"),
    ],
  });
  const rows = report.comparisons.prospectiveAccountScoped.daily;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.planVariant), ["pro-20x", "pro-5x"]);
  assert.ok(rows.every((row) => row.officialAccountTokens === null));
  assert.ok(rows.every((row) => row.partialLocalToOfficialRatio === null));
  assert.ok(rows.every((row) => row.coverage === "mixed_plan_day_provider_bucket_not_allocatable"));
});

test("a known intraday plan boundary suppresses the provider day even when only one side is observed", () => {
  const timeline = createInitialPlanTimeline({ scopeId: SCOPE, effectiveAt: "2026-07-23T00:00:00Z" });
  timeline.profiles[0].periods.push({
    planVariant: "pro-5x",
    startAt: "2026-07-23T12:00:00.000Z",
    endAt: "2026-07-23T13:00:00.000Z",
  });
  const report = analyzeProviderCrosscheck({
    localScan: localScan(),
    accountSnapshot: accountSnapshot(),
    planTimeline: timeline,
    prospectiveCollectorRecords: [{
      kind: "codex_rollout_usage_snapshot",
      observedAt: "2026-07-23T11:00:00.000Z",
      accountScope: accountSnapshot().accountScope,
      components: { input_uncached_tokens: 10 },
    }],
  });
  const [row] = report.comparisons.prospectiveAccountScoped.daily;
  assert.equal(row.planVariant, "pro-20x");
  assert.equal(row.officialAccountTokens, null);
  assert.equal(row.partialLocalToOfficialRatio, null);
  assert.equal(row.coverage, "known_plan_boundary_day_provider_bucket_not_allocatable");
});
