import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { evaluateMinimizationAblation } from "../src/minimization-ablation.js";

const fixtureUrls = [
  new URL("./fixtures/minimization-codex-shaped-v1.json", import.meta.url),
  new URL("./fixtures/minimization-claude-shaped-v1.json", import.meta.url),
];

async function fixtureHashes() {
  const fixtures = await Promise.all(fixtureUrls.map((url) => readFile(url, "utf8")));
  return Object.fromEntries(fixtures.map((fixture, index) => [
    index === 0 ? "codex_shape" : "claude_shape",
    createHash("sha256").update(fixture).digest("hex"),
  ]));
}

function syntheticTransitions({ includeRestrictedFamilies = true, collideResetTimes = false } = {}) {
  const firstResetAt = Date.parse("2026-08-01T00:00:00.000Z") / 1_000;
  const resets = Array.from({ length: 4 }, (_, index) => firstResetAt + index * 7 * 24 * 60 * 60);
  return resets.flatMap((resetsAt, resetIndex) => Array.from({ length: 12 }, (_, pointIndex) => {
    const prior = pointIndex;
    const next = pointIndex + 1;
    const eventMs = (resetsAt * 1_000) - ((12 - pointIndex) * 30 * 60 * 1_000);
    const common = {
      accountScopeId: "safe-account-partition",
      provider: collideResetTimes ? "openai_codex" : resetIndex % 2 === 0 ? "openai_codex" : "anthropic_claude",
      planType: "pro",
      limitId: "codex",
      slot: "primary",
      windowDurationMins: 10_080,
      resetsAt: collideResetTimes && resetIndex === 1 ? resets[0] + 30 : resetsAt,
      eventTime: new Date(eventMs).toISOString(),
      lastPriorObservedAt: new Date(eventMs - 1_000).toISOString(),
      firstNextObservedAt: new Date(eventMs).toISOString(),
      priorUsedPercent: prior,
      nextUsedPercent: next,
      lastPriorCumulativeApiPricedUsd: prior * 6,
      firstNextCumulativeApiPricedUsd: next * 6,
      lastPriorCumulativeQuotaWeightedLowerUsd: prior * 6,
      firstNextCumulativeQuotaWeightedLowerUsd: next * 6,
      lastPriorCumulativeQuotaWeightedUpperUsd: prior * 6,
      firstNextCumulativeQuotaWeightedUpperUsd: next * 6,
      marginalApiPricedUsd: 6,
      marginalComponents: { input_uncached_tokens: 1, output_text_tokens: 1 },
      marginalUsageEventCount: 1,
      aggregateToolClassMix: { web_search: pointIndex % 2, local_shell: 1 },
      tierUsageEventCounts: { standard: 1 },
      controlledState: "controlled",
      quality: {
        localCoverage: { elapsedTimeCoverageFraction: 1 },
        pricingWarnings: [],
        attributionWarnings: [],
      },
    };
    return includeRestrictedFamilies ? {
      ...common,
      sessionPseudonym: "synthetic-session-not-for-output",
      modelFingerprint: "fingerprint:v1:synthetic-not-for-output",
      providerSummary: { group: "synthetic" },
    } : common;
  }));
}

function syntheticDataset(options = {}) {
  return {
    schemaVersion: "synthetic-minimization-input-v0.1",
    scope: {
      startAt: "2026-07-25T00:00:00.000Z",
      endAt: "2026-09-01T00:00:00.000Z",
      snapshotIntervalsIncluded: false,
    },
    transitions: syntheticTransitions(options),
  };
}

test("evaluates A1-A7 deterministically and selects only minimum-detail variants after prospective gates pass", async () => {
  const dataset = syntheticDataset();
  const frozenFixtures = await fixtureHashes();
  const first = evaluateMinimizationAblation(dataset, {
    prospectiveAfter: "2026-07-24T00:00:00.000Z",
    fixtureHashes: frozenFixtures,
  });
  const second = evaluateMinimizationAblation(dataset, {
    prospectiveAfter: "2026-07-24T00:00:00.000Z",
    fixtureHashes: frozenFixtures,
  });

  assert.equal(first.receiptSha256, second.receiptSha256);
  assert.equal(first.decision.status, "selection_complete");
  assert.equal(first.evidence.prospectiveQualifyingResetCount, 4);
  assert.equal(first.ablations.length, 7);
  assert.ok(first.ablations.every((family) => family.sourceAvailability === "available"));
  assert.ok(first.ablations.flatMap((family) => family.variants).every((variant) => variant.hardGates.every((gate) => gate.status === "pass") || variant.id === "diagnostics_omitted"));
  assert.equal(first.ablations.find((family) => family.id === "A1").decision.selectedVariantId, "five_minute_timestamp");
  assert.equal(first.ablations.find((family) => family.id === "A2").decision.selectedVariantId, "session_omitted");
  assert.equal(first.ablations.find((family) => family.id === "A3").decision.selectedVariantId, "fingerprint_plain_unknown");
  assert.equal(first.ablations.find((family) => family.id === "A4").decision.selectedVariantId, "binary_tool_used");
  assert.equal(first.ablations.find((family) => family.id === "A5").decision.selectedVariantId, "five_minute_receipt_reset_time");
  assert.equal(first.ablations.find((family) => family.id === "A6").decision.selectedVariantId, "aggregate_diagnostic_counts");
  assert.equal(first.ablations.find((family) => family.id === "A7").decision.selectedVariantId, "provider_summary_omitted");
  assert.equal(first.jointSelection.status, "selected_joint_set_passes");
  assert.deepEqual(first.input.fixtureHashes, frozenFixtures);
});

test("fails closed to preregistered defaults when reset windows are not prospective", () => {
  const receipt = evaluateMinimizationAblation(syntheticDataset(), {
    prospectiveAfter: "2026-09-01T00:00:00.000Z",
  });

  assert.equal(receipt.decision.status, "inconclusive");
  assert.equal(receipt.decision.noPublicAggregate, true);
  assert.ok(receipt.evidence.blockers.includes("fewer_than_three_completed_prospective_reset_windows"));
  assert.ok(receipt.decision.fieldDecisions.every((decision) => decision.status === "insufficient_evidence_default"));
  assert.equal(receipt.jointSelection.status, "not_evaluated_insufficient_evidence");
});

test("never emits source rows, exact source times, or synthetic pseudonyms", () => {
  const receipt = evaluateMinimizationAblation(syntheticDataset(), {
    prospectiveAfter: "2026-07-24T00:00:00.000Z",
  });
  const serialized = JSON.stringify(receipt);

  assert.doesNotMatch(serialized, /synthetic-session-not-for-output/);
  assert.doesNotMatch(serialized, /fingerprint:v1:synthetic-not-for-output/);
  assert.doesNotMatch(serialized, /2026-08-01T00:00:00\.000Z/);
  assert.equal(receipt.privacy.rowDataEmitted, false);
  assert.ok(receipt.ablations.every((family) => family.variants.every((variant) => variant.privacyCardinality.rowValuesEmitted === false)));
});

test("reset-time coarsening fails the reset-assignment hard gate when it merges whole resets", () => {
  const receipt = evaluateMinimizationAblation(syntheticDataset({ collideResetTimes: true }), {
    prospectiveAfter: "2026-07-24T00:00:00.000Z",
  });
  const resetFamily = receipt.ablations.find((family) => family.id === "A5");

  assert.ok(resetFamily.variants.every((variant) => variant.hardGates.find((gate) => gate.id === "reset_assignment").status === "fail"));
  assert.equal(resetFamily.decision.status, "no_variant_met_gates");
});

test("marks unavailable source families explicitly instead of substituting account scope or model labels", () => {
  const receipt = evaluateMinimizationAblation(syntheticDataset({ includeRestrictedFamilies: false }), {
    prospectiveAfter: "2026-07-24T00:00:00.000Z",
  });

  for (const id of ["A2", "A3", "A7"]) {
    const family = receipt.ablations.find((item) => item.id === id);
    assert.equal(family.sourceAvailability, "unavailable");
    assert.ok(family.variants.every((variant) => variant.status === "source_field_unavailable"));
  }
});
