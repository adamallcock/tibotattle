import { describe, expect, it } from "vitest";
import { finishProviderEffectiveModelComposition } from "../src/quota-analysis-v1";

const BASE = Date.parse("2026-08-01T00:00:00.000Z");
const HOUR = 3_600_000;
const PROVIDER = "openai_codex";
const at = (hours: number) => new Date(BASE + hours * HOUR).toISOString();
const track = (value: string) => `account-track:v2:${value.repeat(64)}`;
const dataset = (value: string) => `dataset:v1:${value.repeat(64)}`;

function recordJson(model = "gpt-5.6-sol", schemaVersion = "usage-event-v1.1") {
  return JSON.stringify({
    schemaVersion,
    provider: PROVIDER,
    modelId: model,
    billingSurface: "chatgpt_subscription",
    speedMode: "fast",
    components: {
      inputUncachedTokens: 1_000,
      inputCacheReadTokens: 9_000,
      inputCacheWriteTokens: 0,
      outputTextTokens: 1_000,
      outputReasoningTokens: 0,
      outputCombinedTokens: 1_000,
    },
  });
}

function group(value: string, {
  planType = "pro",
  includeLegacy = false,
  dualWindows = false,
}: { planType?: string; includeLegacy?: boolean; dualWindows?: boolean } = {}) {
  const quotaRows = Array.from({ length: 34 }, (_, index) => ({
    occurrenceId: `quota:${value}:${index}`,
    observedAt: at(index / 2),
    provider: PROVIDER,
    planType,
    planVariant: "unknown",
    limitId: "codex",
    slot: "seven_day",
    usedPercent: index / 2 * 5,
    windowDurationMinutes: dualWindows && index % 2 === 0 ? 300 : 10_080,
    resetsAt: at(168),
  }));
  const usageRows = Array.from({ length: 33 }, (_, index) => ({
    occurrenceId: `usage:${value}:${index}`,
    observedAt: at(index / 2 + 0.25),
    provider: PROVIDER,
    recordJson: recordJson(
      index % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
      index % 2 === 0 ? "usage-event-v1.1" : "usage-event-v1.2",
    ),
  }));
  return {
    modern: {
      kind: "modern" as const,
      datasetId: dataset(value),
      accountTrackId: track(value),
      policyEpoch: "effective-v1",
      completeWindow: true,
      quotaRows,
      usageRows,
    },
    legacy: {
      kind: "legacy" as const,
      datasetId: dataset("d"),
      accountTrackId: null,
      policyEpoch: "legacy-v1",
      completeWindow: true,
      quotaRows: [{ ...quotaRows[0]!, occurrenceId: `quota:legacy:${value}` }],
      usageRows: [{ ...usageRows[0]!, occurrenceId: `usage:legacy:${value}` }],
    },
  };
}

function finish(sourceGroups: readonly unknown[]) {
  return finishProviderEffectiveModelComposition({
    sourceFingerprint: "a".repeat(64),
    sourceGroups,
  } as never);
}

describe("effective model source continuity", () => {
  it("joins v1.1 and v1.2 rows only when the source group proves one track", () => {
    const source = group("a", { dualWindows: true });
    expect(finish([source.modern])).toMatchObject({
      status: "ready",
      attributionStatus: "effective_source",
      usageEventCount: 33,
      quotaRowCount: 34,
      legacyQuotaRowsExcluded: 0,
      legacyUsageRowsExcluded: 0,
    });
  });

  it("refuses distinct modern account tracks instead of flattening them", () => {
    const left = group("a").modern;
    const right = group("b").modern;
    expect(finish([left, right])).toEqual({
      status: "not_testable",
      reason: "effective_model_account_attribution_conflict",
    });
  });

  it("excludes legacy rows and reports their bounded counts", () => {
    const source = group("a");
    expect(finish([source.modern, source.legacy])).toMatchObject({
      status: "ready",
      usageEventCount: 33,
      quotaRowCount: 34,
      legacyQuotaRowsExcluded: 1,
      legacyUsageRowsExcluded: 1,
    });
  });

  it("refuses unavailable modern attribution and provider plan conflicts", () => {
    const source = group("a").modern;
    expect(finish([{ ...source, accountTrackId: null }])).toEqual({
      status: "not_testable",
      reason: "effective_account_attribution_unavailable",
    });
    const conflicting = group("b", { planType: "plus" }).modern;
    expect(finish([{ ...source, quotaRows: source.quotaRows }, conflicting])).toEqual({
      status: "not_testable",
      reason: "effective_model_account_attribution_conflict",
    });
    expect(finish([{ ...source, quotaRows: source.quotaRows.map((row) => ({ ...row, planType: "pro" })) }, {
      ...source,
      datasetId: dataset("c"),
      accountTrackId: track("a"),
      quotaRows: source.quotaRows.map((row) => ({ ...row, occurrenceId: `quota:c:${row.occurrenceId}`,
        planType: "plus" })),
      usageRows: source.usageRows.map((row) => ({ ...row, occurrenceId: `usage:c:${row.occurrenceId}` })),
    }])).toEqual({
      status: "not_testable",
      reason: "effective_model_provider_plan_conflict",
    });
  });
});
