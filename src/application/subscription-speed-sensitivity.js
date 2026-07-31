import { isCodexSpeedMode } from "../providers/codex/logs.js";

export function fastQuotaMultiplier(model) {
  if (typeof model !== "string") return null;
  if (/^gpt-5\.(?:5|6)(?:$|-)/.test(model)) return 2.5;
  if (/^gpt-5\.4(?:$|-)/.test(model)) return 2;
  return null;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

export function subscriptionSpeedSensitivity(byModel, observedSpeedMode = "unknown") {
  if (!isCodexSpeedMode(observedSpeedMode)) throw new Error("observedSpeedMode is invalid");
  let standardApiEquivalentUsd = 0;
  let fastWeightedEquivalentUsd = 0;
  let unsupportedStandardApiEquivalentUsd = 0;
  const modelMultipliers = {};
  for (const [model, summary] of Object.entries(byModel ?? {})) {
    const costUsd = Number(summary?.costUsd ?? 0);
    if (!Number.isFinite(costUsd) || costUsd < 0) continue;
    standardApiEquivalentUsd += costUsd;
    const multiplier = fastQuotaMultiplier(model);
    modelMultipliers[model] = multiplier;
    if (multiplier === null) unsupportedStandardApiEquivalentUsd += costUsd;
    else fastWeightedEquivalentUsd += costUsd * multiplier;
  }
  const complete = unsupportedStandardApiEquivalentUsd === 0;
  const scenarios = {
    standard: {
      relativeQuotaWeight: 1,
      weightedStandardApiEquivalentUsd: roundUsd(standardApiEquivalentUsd),
      complete: true,
    },
    fast: {
      relativeQuotaWeight: "model_specific",
      weightedStandardApiEquivalentUsd: complete ? roundUsd(fastWeightedEquivalentUsd) : null,
      supportedWeightedStandardApiEquivalentUsd: roundUsd(fastWeightedEquivalentUsd),
      unsupportedStandardApiEquivalentUsd: roundUsd(unsupportedStandardApiEquivalentUsd),
      complete,
    },
  };
  return {
    basis: "codex_subscription_speed_multiplier_applied_to_standard_api_equivalent_not_api_cost",
    observedSpeedMode,
    selectedScenario: observedSpeedMode === "standard" || observedSpeedMode === "fast" ? observedSpeedMode : null,
    scenarios,
    modelMultipliers,
  };
}
