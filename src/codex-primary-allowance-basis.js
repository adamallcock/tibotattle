import {
  FAST_MODE_MULTIPLIER_SOURCE,
} from "@app-usagemonitor/accounting";

export const CODEX_PRIMARY_ALLOWANCE_UNRESOLVED_SCENARIOS = Object.freeze([
  "unresolved_as_standard",
  "unresolved_as_fast",
]);

const CODEX_PRIMARY_ALLOWANCE_BASIS_FAMILY_ID =
  "codex_primary:quota_weighted_api_equivalent:v1:fast_rates_2026_08_01:event_time:observed_declared_scenario";

// One local constructor owns the identity used to couple a weighted timeline
// numerator with the weekly capacity fitted from the same speed scenario. The
// current preference selects a scenario at read time; it is deliberately
// absent from the stable identity so changing that preference does not force a
// replay-cache rebuild.
export function codexPrimaryAllowanceBasis(unresolvedScenario) {
  if (!CODEX_PRIMARY_ALLOWANCE_UNRESOLVED_SCENARIOS.includes(
    unresolvedScenario,
  )) {
    throw new TypeError("Unknown Codex primary allowance scenario");
  }
  return Object.freeze({
    metric: "quota_weighted_api_equivalent",
    version: 1,
    multiplierRegistryRecordedAt: FAST_MODE_MULTIPLIER_SOURCE.recordedAt,
    priceEpochBasis: "event_time_when_registry_has_effective_evidence",
    speedResolutionPolicy: "observed_declared_preference_unknown_v1",
    unresolvedScenario,
    allowanceTrack: "codex_primary",
    basisFamilyId: CODEX_PRIMARY_ALLOWANCE_BASIS_FAMILY_ID,
    basisId:
      `${CODEX_PRIMARY_ALLOWANCE_BASIS_FAMILY_ID}:${unresolvedScenario}`,
  });
}
