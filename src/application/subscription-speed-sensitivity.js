import {
  FAST_MODE_ASSUMED_MULTIPLIER,
  fastModeModelFamilyKey,
  fastModeQuotaMultiplier,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";

import { isCodexSpeedMode } from "../providers/codex/logs.js";

// Single source of truth: the published Priority (Fast) API price ratios and
// their provenance live in the accounting package, derived from the price
// registry. This stays as the reviewed application-level name so existing
// callers keep working; a null still means "no published Priority rate".
export function fastQuotaMultiplier(model, evidence = undefined) {
  return fastModeQuotaMultiplier(model, evidence);
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

export function subscriptionSpeedSensitivity(byModel, observedSpeedMode = "unknown", {
  speedWeightingByModel = null,
} = {}) {
  if (!isCodexSpeedMode(observedSpeedMode)) throw new Error("observedSpeedMode is invalid");
  let standardApiEquivalentUsd = 0;
  let fastWeightedEquivalentUsd = 0;
  let assumedRatioStandardApiEquivalentUsd = 0;
  const modelMultipliers = {};
  for (const [model, summary] of Object.entries(byModel ?? {})) {
    const costUsd = Number(summary?.costUsd ?? 0);
    if (!Number.isFinite(costUsd) || costUsd < 0) continue;
    standardApiEquivalentUsd += costUsd;
    const crossing = speedWeightingByModel?.[model];
    const family = fastModeModelFamilyKey(model);
    const crossingAdmitted = crossing && typeof crossing === "object"
      && !Array.isArray(crossing)
      && Object.keys(crossing).every((speed) => speed === "unknown")
      && crossing.unknown && typeof crossing.unknown === "object"
      && !Array.isArray(crossing.unknown)
      && Object.keys(crossing.unknown).every((key) => key === family || key === "unsupported");
    const weighted = crossingAdmitted ? summarizeQuotaWeightedAccounting({
      speedWeighting: crossing, unresolvedScenario: "unresolved_as_fast",
    }) : null;
    if (weighted?.weightingStatus === "complete"
        && Math.abs(weighted.standardApiPriceEquivalentUsd - costUsd) <= 1e-8) {
      fastWeightedEquivalentUsd += weighted.quotaWeightedApiPriceEquivalentUsd;
      assumedRatioStandardApiEquivalentUsd += weighted.assumedRatioStandardApiPriceEquivalentUsd;
      const multipliers = Object.entries(weighted.appliedMultipliers);
      modelMultipliers[model] = multipliers.length === 1 && multipliers[0][0] !== "unsupported"
        ? multipliers[0][1] : null;
      continue;
    }
    // A per-model total without event context cannot establish that every
    // dollar had an eligible Priority card. Keep that scenario an explicit
    // assumption instead of borrowing a short-context or later dated rate.
    const multiplier = fastQuotaMultiplier(model, summary?.priceEvidence ?? {});
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
