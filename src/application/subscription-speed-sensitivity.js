import {
  FAST_MODE_ASSUMED_MULTIPLIER,
  fastModeQuotaMultiplier,
} from "@app-usagemonitor/accounting";

import { isCodexSpeedMode } from "../providers/codex/logs.js";

// Single source of truth: the published Priority (Fast) API price ratios and
// their provenance live in the accounting package, derived from the price
// registry. This stays as the reviewed application-level name so existing
// callers keep working; a null still means "no published Priority rate".
export function fastQuotaMultiplier(model) {
  return fastModeQuotaMultiplier(model);
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

export function subscriptionSpeedSensitivity(byModel, observedSpeedMode = "unknown") {
  if (!isCodexSpeedMode(observedSpeedMode)) throw new Error("observedSpeedMode is invalid");
  let standardApiEquivalentUsd = 0;
  let fastWeightedEquivalentUsd = 0;
  let assumedRatioStandardApiEquivalentUsd = 0;
  const modelMultipliers = {};
  for (const [model, summary] of Object.entries(byModel ?? {})) {
    const costUsd = Number(summary?.costUsd ?? 0);
    if (!Number.isFinite(costUsd) || costUsd < 0) continue;
    standardApiEquivalentUsd += costUsd;
    const multiplier = fastQuotaMultiplier(model);
    modelMultipliers[model] = multiplier;
    if (multiplier === null) {
      // No published Priority rate: include at the disclosed assumed ratio
      // instead of leaving the scenario incomplete.
      assumedRatioStandardApiEquivalentUsd += costUsd;
      fastWeightedEquivalentUsd += costUsd * FAST_MODE_ASSUMED_MULTIPLIER;
    } else fastWeightedEquivalentUsd += costUsd * multiplier;
  }
  const scenarios = {
    standard: {
      relativeQuotaWeight: 1,
      weightedStandardApiEquivalentUsd: roundUsd(standardApiEquivalentUsd),
      complete: true,
    },
    fast: {
      relativeQuotaWeight: "model_specific",
      weightedStandardApiEquivalentUsd: roundUsd(fastWeightedEquivalentUsd),
      assumedRatioStandardApiEquivalentUsd:
        roundUsd(assumedRatioStandardApiEquivalentUsd),
      assumedRatioMultiplier: FAST_MODE_ASSUMED_MULTIPLIER,
      complete: true,
    },
  };
  return {
    basis: "codex_subscription_priority_price_ratio_applied_to_standard_api_equivalent",
    observedSpeedMode,
    selectedScenario: observedSpeedMode === "standard" || observedSpeedMode === "fast" ? observedSpeedMode : null,
    scenarios,
    modelMultipliers,
  };
}
