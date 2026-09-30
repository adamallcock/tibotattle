import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY, includedAllowanceSpeedWeight } from "@app-usagemonitor/quota-analysis";
import { speedModeApiMultiplier } from "@app-usagemonitor/accounting";

const BASE = Object.freeze({
  provider: "openai_codex",
  billingSurface: "chatgpt_subscription",
  consumptionBasis: "included_allowance",
  modelId: "gpt-6-astra",
  mode: "ultrafast",
  eventTime: "2026-09-29T00:00:00.000Z",
});

test("documented included weights have a reviewed source and preserve distinct API money ratios", () => {
  const policy = CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY;
  assert.equal(policy.reviewedFrom, "2026-09-29");
  assert.equal(policy.source.url, "https://learn.chatgpt.com/docs/agent-configuration/speed");
  assert.equal(policy.historicalApplicability, "unavailable_before_reviewed_from");
  assert.equal(policy.unit, "dimensionless");
  assert.equal(policy.establishesModeAvailability, false);
  assert.equal(policy.infersConsumptionBasis, false);
  assert.equal(policy.changesCalibrationBasis, false);
  assert.deepEqual(policy.weights, { standard: 1, fast: 2.5, ultrafast: 8 });
  for (const value of [policy, policy.source, policy.weights, policy.supportedFastModels, policy.supportedUltrafastModels]) {
    assert.equal(Object.isFrozen(value), true);
  }
  for (const [mode, apiRatio, includedWeight] of [["standard", 1, 1], ["fast", 2, 2.5], ["ultrafast", 6, 8]]) {
    assert.equal(speedModeApiMultiplier(BASE.modelId, mode, { eventTime: BASE.eventTime, totalInputContextTokens: 272_000 }), apiRatio);
    const comparison = includedAllowanceSpeedWeight({ ...BASE, mode });
    assert.equal(comparison.weight, includedWeight);
    assert.equal(comparison.status, "documented");
    assert.equal(comparison.reasonCode, "documented_speed_weight");
    assert.equal(Object.isFrozen(comparison), true);
    assert.equal(Object.keys(comparison).some((key) => /usd|money|cost|capacity/iu.test(key)), false);
  }
});

test("current exact supported Fast models are closed and Sol 6.1 Ultrafast stays unavailable", () => {
  assert.deepEqual(CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.supportedFastModels, [
    "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol",
  ]);
  for (const modelId of CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.supportedFastModels) {
    for (const [mode, weight] of [["standard", 1], ["fast", 2.5]]) {
      assert.equal(includedAllowanceSpeedWeight({ ...BASE, modelId, mode }).weight, weight);
    }
    const ultrafast = includedAllowanceSpeedWeight({ ...BASE, modelId });
    assert.equal(ultrafast.weight, modelId === "gpt-6-astra" ? 8 : null);
    if (modelId !== "gpt-6-astra") assert.equal(ultrafast.reasonCode, "model_speed_not_supported");
  }
  // API Priority capability is not evidence of current Codex mode availability.
  assert.equal(speedModeApiMultiplier("gpt-4.1", "fast"), 1.75);
  for (const modelId of ["gpt-4.1", "gpt-5", "gpt-5-mini", "gpt-5.5-codex", "gpt-6.1-sol-preview", "GPT-6-ASTRA", "unknown", null]) {
    assert.equal(includedAllowanceSpeedWeight({ ...BASE, modelId, mode: "fast" }).reasonCode, "model_not_reviewed");
  }
});

test("the explicit consumption basis prevents subscription credits from inheriting allowance weights", () => {
  for (const consumptionBasis of ["purchased_credits", "api_billing"]) {
    const value = includedAllowanceSpeedWeight({ ...BASE, consumptionBasis });
    assert.equal(value.status, "not_applicable");
    assert.equal(value.weight, null);
    assert.equal(value.reasonCode, "separate_credit_or_api_basis");
  }
  for (const consumptionBasis of [undefined, null, "unknown", "invented"]) {
    const value = includedAllowanceSpeedWeight({ ...BASE, consumptionBasis });
    assert.equal(value.status, "unavailable");
    assert.equal(value.weight, null);
    assert.equal(value.reasonCode, "consumption_basis_unavailable");
  }
  for (const changed of [{ provider: "anthropic_claude_code" }, { billingSurface: "openai_api" }, { billingSurface: "claude_subscription" }]) {
    const value = includedAllowanceSpeedWeight({ ...BASE, ...changed });
    assert.equal(value.status, "not_applicable");
    assert.equal(value.weight, null);
  }
  for (const changed of [{ provider: null }, { billingSurface: "unknown" }]) {
    assert.equal(includedAllowanceSpeedWeight({ ...BASE, ...changed }).status, "unavailable");
  }
});

test("unknown modes and unsupported historical or malformed dates never become Standard", () => {
  assert.equal(includedAllowanceSpeedWeight().weight, null);
  for (const mode of [undefined, null, "unknown", "priority", "mixed", "future"]) {
    const value = includedAllowanceSpeedWeight({ ...BASE, mode });
    assert.equal(value.status, "unavailable");
    assert.equal(value.reasonCode, "speed_mode_unavailable");
    assert.equal(value.weight, null);
  }
  for (const mode of ["standard", "fast", "ultrafast"]) {
    const value = includedAllowanceSpeedWeight({ ...BASE, mode, eventTime: "2026-09-28T23:59:59.999Z" });
    assert.equal(value.reasonCode, "before_reviewed_policy");
    assert.equal(value.weight, null);
  }
  for (const eventTime of [undefined, null, "2026-09-29", "2026-09-29T00:00:00+00:00", "2026-09-31T00:00:00.000Z", "2026-09-29T24:00:00.000Z", "not-a-date"]) {
    assert.equal(includedAllowanceSpeedWeight({ ...BASE, eventTime }).reasonCode, "event_time_unavailable");
  }
  for (const eventTime of ["2026-09-29T00:00:00Z", "2026-09-29T00:00:00.001Z", "2026-10-01T12:00:00.000Z"]) {
    assert.equal(includedAllowanceSpeedWeight({ ...BASE, eventTime }).weight, 8);
  }
  const source = { ...BASE };
  const before = structuredClone(source);
  includedAllowanceSpeedWeight(source);
  assert.deepEqual(source, before);
});
