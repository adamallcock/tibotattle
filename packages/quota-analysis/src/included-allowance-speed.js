// A dimensionless comparison policy from reviewed public documentation. It
// does not price tokens, infer which pool paid for a turn, prove mode access,
// or replace empirical quota calibration. In particular, these weights must
// never multiply money that already includes an API speed premium.
const LEGACY_MODELS = Object.freeze([
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-sol",
]);
const LEGACY_WEIGHTS = Object.freeze({ standard: 1, fast: 2.5 });
const LEGACY_ULTRAFAST_WEIGHT = Object.freeze({ ultrafast: 8 });

export const CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY = Object.freeze({
  version: "codex-included-allowance-speed-v0.2",
  basis: "documented_included_allowance_relative_to_standard",
  unit: "dimensionless",
  // Review and launch dates are day-level evidence, not rollout instants.
  reviewedFrom: "2026-09-29",
  historicalApplicability: "unavailable_before_reviewed_from",
  source: Object.freeze({
    publisher: "openai",
    url: "https://learn.chatgpt.com/docs/pricing#speed-multipliers",
    launchDatesUrl: "https://learn.chatgpt.com/docs/changelog",
    statement: "GPT-6.2 Astra and Sol use included allowance at 2x Standard for Fast and 6x for Ultrafast. The reviewed historical Fast weight is 2.5x, and GPT-6 Astra and GPT-6.1 Sol Ultrafast use 8x. Purchased credits and API prices use separate factors.",
  }),
  rules: Object.freeze([
    Object.freeze({
      models: LEGACY_MODELS,
      reviewedFrom: "2026-09-29",
      weights: LEGACY_WEIGHTS,
    }),
    Object.freeze({
      models: Object.freeze(["gpt-6-astra"]),
      reviewedFrom: "2026-09-29",
      weights: LEGACY_ULTRAFAST_WEIGHT,
    }),
    Object.freeze({
      models: Object.freeze(["gpt-6.1-sol"]),
      reviewedFrom: "2026-10-08",
      weights: LEGACY_ULTRAFAST_WEIGHT,
    }),
    Object.freeze({
      models: Object.freeze(["gpt-6.1-terra"]),
      reviewedFrom: "2026-10-26",
      weights: LEGACY_WEIGHTS,
    }),
    Object.freeze({
      models: Object.freeze(["gpt-6.2-astra", "gpt-6.2-sol"]),
      reviewedFrom: "2026-11-17",
      weights: Object.freeze({ standard: 1, fast: 2, ultrafast: 6 }),
    }),
  ]),
  establishesModeAvailability: false,
  infersConsumptionBasis: false,
  changesCalibrationBasis: false,
});

function result(status, reasonCode, weight = null, reviewedFrom = CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.reviewedFrom) {
  return Object.freeze({
    policyVersion: CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.version,
    basis: CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.basis,
    reviewedFrom,
    unit: CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.unit,
    status,
    reasonCode,
    weight,
  });
}

function canonicalEventDay(value) {
  if (typeof value !== "string" || value.length > 32
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
      || !Number.isFinite(Date.parse(value))) return null;
  const instant = new Date(value).toISOString();
  // Date.parse normalizes impossible calendar dates; those are not evidence.
  return instant.slice(0, 10) === value.slice(0, 10) ? instant.slice(0, 10) : null;
}

/**
 * Return a documented included-allowance speed weight for an explicit
 * comparison basis. A ChatGPT subscription can also consume purchased
 * credits, so the billing surface alone never establishes that basis.
 *
 * This lookup does not establish plan/account access to a mode. For example,
 * Astra Ultrafast availability depends on the plan or credit agreement. A
 * caller must label an assumed included-allowance basis as a counterfactual;
 * it must not present this weight as observed consumption or an exact quota
 * formula. Earlier history, unreviewed models, and unknown modes stay unknown.
 */
export function includedAllowanceSpeedWeight({
  provider,
  billingSurface,
  consumptionBasis,
  modelId,
  mode,
  eventTime,
} = {}) {
  if (consumptionBasis === "purchased_credits" || consumptionBasis === "api_billing") {
    return result("not_applicable", "separate_credit_or_api_basis");
  }
  if (consumptionBasis !== "included_allowance") {
    return result("unavailable", "consumption_basis_unavailable");
  }
  if (provider === undefined || provider === null || provider === "unknown"
      || billingSurface === undefined || billingSurface === null || billingSurface === "unknown") {
    return result("unavailable", "provider_or_billing_surface_unavailable");
  }
  if (provider !== "openai_codex" || billingSurface !== "chatgpt_subscription") {
    return result("not_applicable", "provider_or_billing_surface_not_supported");
  }
  const eventDay = canonicalEventDay(eventTime);
  if (eventDay === null) return result("unavailable", "event_time_unavailable");
  if (eventDay < CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.reviewedFrom) {
    return result("unavailable", "before_reviewed_policy");
  }
  if (!["standard", "fast", "ultrafast"].includes(mode)) {
    return result("unavailable", "speed_mode_unavailable");
  }
  const modelRules = CODEX_INCLUDED_ALLOWANCE_SPEED_POLICY.rules.filter((rule) => rule.models.includes(modelId));
  if (modelRules.length === 0) return result("unavailable", "model_not_reviewed");
  const rule = modelRules.find(({ weights }) => Object.hasOwn(weights, mode));
  if (!rule) return result("unavailable", "model_speed_not_supported");
  if (eventDay < rule.reviewedFrom) {
    return result("unavailable", "before_reviewed_policy", null, rule.reviewedFrom);
  }
  return result("documented", "documented_speed_weight", rule.weights[mode], rule.reviewedFrom);
}
