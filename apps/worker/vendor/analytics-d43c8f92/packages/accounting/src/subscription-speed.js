// API-price-equivalent accounting for observed Codex speed modes. Published
// Fast/Priority and Ultrafast API ratios are proved against exact token cards,
// then qualified by event date and context. These are comparison prices, not
// subscription allowance consumption: the separately documented included-
// allowance factors (Fast 2.5x and Astra Ultrafast 8x) do not belong in this
// money series. Historical API-equivalent prices retain their original meaning.
//
// Supported rollouts can record tier changes in thread_settings_applied and
// a per-turn service_tier in turn_context. Older logs may omit the baseline;
// absence alone does not explain why evidence is missing. Parsers own version,
// timeline, turn-override and lineage semantics. This module receives the
// resulting observation or a timestamp-covered config declaration. Only the
// remaining unknown events use the explicit Standard/Fast sensitivity choice.
import {
  APP_PRICE_REGISTRY_VERSION,
  OPENAI_OFFICIAL_PRICE_CARDS,
} from "./price-registry.js";

const FAST_MODE_MULTIPLIER_RECORDED_AT = "2026-08-30";
const API_TIER_BY_SPEED_MODE = Object.freeze({ fast: "priority", ultrafast: "ultrafast" });

export const FAST_MODE_MULTIPLIER_SOURCE = Object.freeze({
  publisher: "openai",
  basis: "published_api_speed_price_ratio_relative_to_standard",
  statement:
    "Published Fast/Priority and Ultrafast API ratios are derived for exact registered models and reviewed aliases, then checked against the event's context and price epoch. Fast without an eligible Priority card retains its disclosed assumed 2x. Ultrafast without an eligible card remains unweighted. These API-equivalent comparisons do not measure included subscription allowance consumption.",
  recordedAt: "2026-09-29",
  priceRegistryVersion: APP_PRICE_REGISTRY_VERSION,
  appliesTo: "api_price_equivalent_only",
  observability: "rollout_thread_settings_and_supported_turn_context",
});

// What a Codex rollout log can and cannot prove about the speed mode. Shared
// so every surface states the same thing instead of re-deriving it.
export const CODEX_SPEED_MODE_OBSERVABILITY = Object.freeze({
  recordedEvent: "event_msg.payload.thread_settings_applied.service_tier",
  recordedTurnContext: "turn_context.payload.service_tier",
  observedValues: Object.freeze({ priority: "fast", fast: "fast", default: "standard", standard: "standard", ultrafast: "ultrafast" }),
  firesOn: "settings_applied_or_changed_and_supported_turn_context",
  // No guaranteed session_meta baseline; supported turn contexts can carry it.
  sessionBaselineRecorded: false,
  resolution: "observed_thread_settings_with_supported_per_turn_overrides",
  unobservedMeans:
    "no supported tier observation covers these turns; older logs may omit the baseline",
});

function decimalRational(amount) {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(String(amount));
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { digits: BigInt(match[1] + fraction), scale: fraction.length };
}

// Premium/Standard as an exact rational; equality is checked by
// cross-multiplication so decimal string scales never introduce float error.
function ratioPair(priorityAmount, standardAmount) {
  const priority = decimalRational(priorityAmount);
  const standard = decimalRational(standardAmount);
  if (!priority || !standard || standard.digits === 0n) return null;
  return { priority, standard };
}

function sameRatio(left, right) {
  return left.priority.digits * 10n ** BigInt(left.standard.scale)
    * right.standard.digits * 10n ** BigInt(right.priority.scale)
    === right.priority.digits * 10n ** BigInt(right.standard.scale)
    * left.standard.digits * 10n ** BigInt(left.priority.scale);
}

function ratioNumber({ priority, standard }) {
  let numerator = priority.digits * 10n ** BigInt(standard.scale);
  let denominator = standard.digits * 10n ** BigInt(priority.scale);
  let left = numerator;
  let right = denominator;
  while (right !== 0n) [left, right] = [right, left % right];
  numerator /= left;
  denominator /= left;
  return Number(numerator) / Number(denominator);
}

function tokenComponents(card) {
  return card.components.filter((component) => (
    component.usage_component.endsWith("_tokens")
  ));
}

function matchingContext(left, right) {
  return left.model === right.model
    && left.provider === right.provider
    && (left.surface ?? null) === (right.surface ?? null)
    && (left.region ?? null) === (right.region ?? null)
    && (left.pricing_period ?? null) === (right.pricing_period ?? null)
    && (left.metadata?.total_input_context_band ?? null)
      === (right.metadata?.total_input_context_band ?? null);
}

function effectiveRangesOverlap(left, right) {
  const from = (card) => card.effective?.from ?? "0000-00-00";
  const to = (card) => card.effective?.to ?? "9999-99-99";
  return from(left) <= to(right) && from(right) <= to(left);
}

/**
 * Canonical model -> published Fast or Ultrafast API price relative to Standard,
 * proven uniform across every token component, eligible context band, and
 * dated price epoch of that exact model before it is used. A non-uniform registry
 * throws here rather than shipping a wrong multiplier.
 */
export function deriveSpeedModeApiRatiosFromRegistry(
  mode,
  cards = OPENAI_OFFICIAL_PRICE_CARDS,
) {
  if (!Object.hasOwn(API_TIER_BY_SPEED_MODE, mode)) {
    throw new TypeError("Unsupported API speed mode.");
  }
  const serviceTier = API_TIER_BY_SPEED_MODE[mode];
  const ratios = {};
  const openAiCards = cards.filter((card) => card.provider === "openai");
  const priorityModels = [...new Set(openAiCards.filter(
    (card) => card.service_tier === serviceTier,
  ).map((card) => card.model))].sort();
  for (const model of priorityModels) {
    const priorityCards = openAiCards.filter(
      (card) => card.model === model && card.service_tier === serviceTier,
    );
    let reference = null;
    let referenceLabel = null;
    for (const priorityCard of priorityCards) {
      const priorityComponents = tokenComponents(priorityCard);
      if (new Set(priorityComponents.map((component) => component.usage_component)).size
          !== priorityComponents.length) {
        throw new TypeError(`Duplicate token component name on ${priorityCard.id}.`);
      }
      const standardCards = openAiCards.filter((card) => (
        card.service_tier === "standard"
        && matchingContext(card, priorityCard)
        && effectiveRangesOverlap(card, priorityCard)
      ));
      if (standardCards.length === 0) {
        throw new TypeError(
          `${serviceTier} card ${priorityCard.id} has no overlapping Standard card.`,
        );
      }
      for (const standardCard of standardCards) {
        const standardTokenComponents = tokenComponents(standardCard);
        const standardComponents = new Map(standardTokenComponents
          .map((component) => [component.usage_component, component]));
        if (standardComponents.size !== standardTokenComponents.length) {
          throw new TypeError(`Duplicate token component name on ${standardCard.id}.`);
        }
        if (standardComponents.size === 0
            || priorityComponents.length !== standardComponents.size) {
          throw new TypeError(`Token component coverage differs on ${priorityCard.id}/${standardCard.id}.`);
        }
        for (const component of priorityComponents) {
          const standardComponent = standardComponents.get(component.usage_component);
          if (standardComponent === undefined) {
            throw new TypeError(
              `${priorityCard.id} prices ${component.usage_component} that ${standardCard.id} does not.`,
            );
          }
          if (component.unit !== standardComponent.unit
              || component.unit !== "token"
              || component.price.currency !== "USD"
              || standardComponent.price.currency !== "USD"
              || component.price.per !== standardComponent.price.per
              || (decimalRational(component.price.per)?.digits ?? 0n) <= 0n
              || JSON.stringify(component.conditions ?? {})
                !== JSON.stringify(standardComponent.conditions ?? {})) {
            throw new TypeError(`Token price units or conditions differ on ${priorityCard.id}/${component.usage_component}.`);
          }
          const pair = ratioPair(component.price.amount, standardComponent.price.amount);
          if (pair === null) {
            throw new TypeError(
              `Unusable price amounts on ${priorityCard.id}/${component.usage_component}.`,
            );
          }
          if (reference === null) {
            reference = pair;
            referenceLabel = `${priorityCard.id}/${component.usage_component}`;
          } else if (!sameRatio(reference, pair)) {
            throw new TypeError(
              `${serviceTier}/Standard price ratio is not uniform for ${model}: `
              + `${referenceLabel} vs ${priorityCard.id}/${component.usage_component}.`,
            );
          }
        }
      }
    }
    ratios[model] = ratioNumber(reference);
  }
  return Object.freeze(ratios);
}

export function deriveFastModePriorityRatiosFromRegistry(cards = OPENAI_OFFICIAL_PRICE_CARDS) {
  return deriveSpeedModeApiRatiosFromRegistry("fast", cards);
}

// Canonical model -> published Priority (Fast) API price ratio over Standard,
// derived from the price registry on load. Any family absent from this map
// is priced with the disclosed assumed multiplier below, never a silent 1.0.
export const FAST_MODE_QUOTA_MULTIPLIERS = deriveFastModePriorityRatiosFromRegistry();
export const SPEED_MODE_API_MULTIPLIERS = Object.freeze({
  fast: FAST_MODE_QUOTA_MULTIPLIERS,
  ultrafast: deriveSpeedModeApiRatiosFromRegistry("ultrafast"),
});

// Owner-approved default for Fast usage on a model without a published
// Priority rate: include it at 2x Standard and disclose the assumption. 2x
// remains an assumption, including when a known model has no Priority card
// for the actual event context or date.
export const FAST_MODE_ASSUMED_MULTIPLIER = 2;

export const FAST_MODE_ASSUMED_MULTIPLIER_SOURCE = Object.freeze({
  basis: "assumed_priority_price_ratio_for_models_without_published_priority_rates",
  statement:
    "Fast usage without an eligible published Priority rate for its exact model, context, and date is included at an assumed 2x Standard and reported separately, instead of being excluded or silently counted at 1x.",
  recordedAt: FAST_MODE_MULTIPLIER_RECORDED_AT,
});

// Fixed bucket keys for the Standard-priced cost crossing that feeds the
// weighting. Canonical models are a closed registry-derived set; aliases fold
// into their reviewed target, not a prefix family. "unsupported" identifies
// uncovered models, event contexts, or epochs: Fast uses its disclosed assumed
// rate there; Ultrafast remains unweighted.
export const FAST_MODE_MODEL_FAMILY_KEYS = Object.freeze([
  ...Object.keys(FAST_MODE_QUOTA_MULTIPLIERS),
  "unsupported",
]);
export const SPEED_MODE_MODEL_FAMILY_KEYS = Object.freeze([
  ...new Set(Object.values(SPEED_MODE_API_MULTIPLIERS).flatMap(Object.keys)),
  "unsupported",
]);

export const OBSERVED_SPEED_MODE_KEYS = Object.freeze([
  "standard",
  "fast",
  "ultrafast",
  "unknown",
]);

// What the Codex configuration file can and cannot prove about the baseline.
// `~/.codex/config.toml` holds a top-level `service_tier` key with the CURRENT
// setting. A supported turn context can independently record its own tier. The Codex UI
// rewrites that file on every toggle, so the key proves the value at READ TIME
// and nothing more. It is therefore recorded as a timestamped observation and
// resolved only over the interval it covers; it never backfills history and
// never overrides the rollout log.
export const CODEX_SPEED_MODE_DECLARATION = Object.freeze({
  provenance: "declared_codex_config",
  source: "codex_config_service_tier_key",
  retainedKeys: Object.freeze(["service_tier"]),
  appliesTo: "turns_at_or_after_the_moment_the_key_was_read",
  neverBackfillsHistory: true,
  reason:
    "the Codex UI rewrites the configuration file on every toggle, so the key proves only the value at the moment it was read",
});

// How an event's effective mode was decided. These are distinct everywhere
// they surface; neither "declared_codex_config" nor "inferred" is ever
// presented as "observed". The speed mode is the Codex UI's own control:
// observation and the timestamped configuration reading are the evidence, and
// anything neither covers defaults to Standard as a visible assumption (the
// owner-stated dashboard preference was removed on 2026-08-30).
export const SPEED_MODE_PROVENANCE_VALUES = Object.freeze([
  "observed",
  "declared_codex_config",
  "assumed_standard_default",
  "assumed_fast_scenario",
  "inferred",
  "unknown",
]);

// The sensitivity axis for turns with no speed evidence at all: the default
// scenario attributes them to Standard; the fast scenario re-attributes the
// same residual to Fast so fit couplings can quote both directions. The
// scenario never overrides an observation or a covering declaration.
// These are sensitivities, not bounds: an unobserved turn could be Ultrafast.
export const UNRESOLVED_SPEED_SCENARIOS = Object.freeze([
  "unresolved_as_standard",
  "unresolved_as_fast",
]);
export const DEFAULT_UNRESOLVED_SPEED_SCENARIO = "unresolved_as_standard";

export const QUOTA_WEIGHTED_API_PRICE_METRIC = Object.freeze({
  // The key names are the persisted wire contract and deliberately keep the
  // legacy "quotaWeighted" spelling; only the labels and basis changed when
  // the metric moved to published Priority API prices on 2026-08-30.
  key: "quotaWeightedApiPriceEquivalentUsd",
  label: "Speed-priced API-price equivalent",
  shortLabel: "Speed-priced API equivalent",
  standardMetricKey: "apiPriceEquivalentUsd",
  standardMetricLabel: "Standard-rate API-price equivalent",
  explainer:
    "Standard-rate API prices, with Fast and Ultrafast priced at the published API rate for the exact model, context, and date. Fast without an eligible Priority rate uses a disclosed assumed 2x; unsupported Ultrafast remains unweighted. This is an API comparison, not a bill or included-allowance formula.",
});

// Named thresholds for the secondary residual inference. Every one of these is
// a deliberate, reviewable choice; none of them may be inlined as a literal.
export const FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS = Object.freeze({
  // A window is only scored when its own calibration fit rests on enough
  // independent evidence to mean anything.
  minimumEligibleTransitions: 8,
  minimumUniquePercentageBoundaries: 4,
  minimumObservedSpanPercentagePoints: 5,
  // A Standard reference is only formed from windows whose observed speed
  // evidence is both present and overwhelmingly Standard. The legacy Fast
  // threshold now limits the combined Fast and Ultrafast fraction.
  minimumReferenceKnownSpeedFraction: 0.6,
  maximumReferenceFastFractionOfKnown: 0.05,
  minimumReferenceWindows: 3,
  // The observed-to-Standard-predicted movement ratio must land inside this
  // relative band around a published multiple. The 1.7, 1.75 and 1.8 ratios
  // have overlapping bands: a window matching more than one published
  // multiple is explicitly ambiguous, never attributed to a convenient one.
  relativeToleranceOfPublishedMultiple: 0.1,
});

export const FAST_MODE_RESIDUAL_INFERENCE_REASON_CODES = Object.freeze([
  "not_enough_scored_windows",
  "not_enough_reference_windows",
  "reference_capacity_unusable",
  "windows_unavailable",
]);

const REGISTERED_MODEL_NAMES = new Map();
const REGISTERED_STANDARD_CARDS = new Map();
const REGISTERED_STANDARD_CARDS_BY_MODEL = new Map();
const REGISTERED_SPEED_CARDS = Object.fromEntries(
  Object.keys(API_TIER_BY_SPEED_MODE).map((mode) => [mode, new Map()]),
);
for (const card of OPENAI_OFFICIAL_PRICE_CARDS) {
  for (const name of [card.model, ...(card.aliases ?? [])]) {
    const prior = REGISTERED_MODEL_NAMES.get(name);
    if (prior !== undefined && prior !== card.model) {
      throw new TypeError(`Ambiguous registered speed model name: ${name}.`);
    }
    REGISTERED_MODEL_NAMES.set(name, card.model);
  }
  if (card.service_tier === "standard") {
    REGISTERED_STANDARD_CARDS.set(card.id, card);
    const cards = REGISTERED_STANDARD_CARDS_BY_MODEL.get(card.model) ?? [];
    cards.push(card);
    REGISTERED_STANDARD_CARDS_BY_MODEL.set(card.model, cards);
  }
  for (const [mode, tier] of Object.entries(API_TIER_BY_SPEED_MODE)) {
    if (card.service_tier !== tier) continue;
    const cards = REGISTERED_SPEED_CARDS[mode].get(card.model) ?? [];
    cards.push(card);
    REGISTERED_SPEED_CARDS[mode].set(card.model, cards);
  }
}

const PUBLISHED_MULTIPLES = Object.freeze(
  [...new Set(Object.values(FAST_MODE_QUOTA_MULTIPLIERS))].sort(
    (left, right) => left - right,
  ),
);

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function roundFraction(value) {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The exact registered model (including reviewed aliases), or null when no
 * card supports the requested premium mode. With event evidence, classification
 * additionally requires an eligible context and effective date. Omitting
 * evidence is a model-capability lookup only, not event-pricing authority.
 */
function speedModeModelFamily(model, mode, evidence = undefined) {
  if (typeof model !== "string"
      || !Object.hasOwn(SPEED_MODE_API_MULTIPLIERS, mode)) return null;
  const canonicalModel = REGISTERED_MODEL_NAMES.get(model);
  if (!Object.hasOwn(SPEED_MODE_API_MULTIPLIERS[mode], canonicalModel ?? "")) return null;
  if (evidence === undefined) return canonicalModel;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
      || Object.keys(evidence).some((key) => ![
        "eventTime", "totalInputContextTokens", "standardPriceCardIds",
      ].includes(key))) return null;
  const eventTime = evidence.eventTime;
  if (typeof eventTime !== "string" || eventTime.length > 32
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(eventTime)
      || !Number.isFinite(Date.parse(eventTime))) return null;
  const day = new Date(eventTime).toISOString().slice(0, 10);
  if (day !== eventTime.slice(0, 10)) return null;
  const coversDay = (card) => (card.effective?.from ?? "0000-00-00") <= day
    && day <= (card.effective?.to ?? "9999-99-99");
  const context = evidence.totalInputContextTokens;
  const contextProvided = context !== null && context !== undefined;
  if (contextProvided && (!Number.isSafeInteger(context) || context < 0)) return null;
  const matchingBand = (card) => {
    if (card.metadata?.total_input_context_band == null) return true;
    if (!contextProvided) return false;
    // Follow each exact card's boundary, not a universal model-family cutoff.
    return card.components.every(({ conditions }) => (
      (conditions?.min_total_input_tokens === undefined || context >= Number(conditions.min_total_input_tokens))
      && (conditions?.max_total_input_tokens === undefined || context <= Number(conditions.max_total_input_tokens))
    ));
  };
  const speedCards = REGISTERED_SPEED_CARDS[mode].get(canonicalModel).filter(coversDay);
  if (evidence.standardPriceCardIds !== undefined) {
    const ids = evidence.standardPriceCardIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 8) return null;
    for (const id of ids) {
      const standard = REGISTERED_STANDARD_CARDS.get(id);
      if (!standard || standard.model !== canonicalModel || !coversDay(standard)
          || (contextProvided && !matchingBand(standard))
          || !speedCards.some((card) => matchingContext(standard, card))) {
        return null;
      }
    }
    return canonicalModel;
  }
  return speedCards.some((card) => matchingBand(card)
    && REGISTERED_STANDARD_CARDS_BY_MODEL.get(canonicalModel).some(
      (standard) => coversDay(standard) && matchingContext(standard, card),
    )) ? canonicalModel : null;
}

export function fastModeModelFamily(model, evidence = undefined) {
  return speedModeModelFamily(model, "fast", evidence);
}

/**
 * API ratio, never an included-allowance weight. Omitting evidence only looks
 * up model capability. Event pricing must supply a date and eligible context
 * (or the exact Standard card ids already used to price that event).
 */
export function speedModeApiMultiplier(model, mode, evidence = undefined) {
  if (mode === "standard") return 1;
  const family = speedModeModelFamily(model, mode, evidence);
  return family === null ? null : SPEED_MODE_API_MULTIPLIERS[mode][family];
}

/**
 * Crossings must use the effective observed or covering declared mode for both
 * their observed and declared cells. Only eligible Ultrafast events enter its
 * published model bucket; all others stay explicitly unsupported. Unresolved
 * cells retain Fast eligibility for the existing Standard/Fast sensitivities.
 */
export function speedModeModelFamilyKey(model, mode, evidence = undefined) {
  if (mode === "ultrafast") {
    return speedModeModelFamily(model, mode, evidence) ?? "unsupported";
  }
  if (mode === "standard" || mode === "fast" || mode === "unknown") {
    return fastModeModelFamilyKey(model, evidence);
  }
  return "unsupported";
}

/**
 * The published Priority/Standard price ratio for a registered model (and,
 * when supplied, its event evidence), or null. Null is never silently 1.
 */
export function fastModeQuotaMultiplier(model, evidence = undefined) {
  return speedModeApiMultiplier(model, "fast", evidence);
}

export function fastModeModelFamilyKey(model, evidence = undefined) {
  return fastModeModelFamily(model, evidence) ?? "unsupported";
}

/**
 * Resolution order, strongest evidence first:
 *   1. observed          - a supported rollout settings or per-turn tier
 *                          observation covers this turn. This ALWAYS wins;
 *                          nothing below can overwrite or bypass it.
 *   2. declared_codex_config - the Codex configuration's `service_tier` key was
 *                          read at a moment that covers this turn. It recovers
 *                          a baseline absent from the log, but only
 *                          forward from the reading; callers must not pass a
 *                          declaration for a turn the reading does not cover.
 *   3. assumed_standard_default - no log tier and no covering reading. The
 *                          speed mode is the Codex UI's own control, so with
 *                          no evidence the turn is attributed to Standard as a
 *                          visible assumption, counted separately from both
 *                          observation and declaration. Window-level residual
 *                          inference stays diagnostic-only and never changes
 *                          the money.
 */
export function resolveEffectiveSpeedMode({
  observedMode = "unknown",
  declaredMode = "unknown",
  unresolvedScenario = DEFAULT_UNRESOLVED_SPEED_SCENARIO,
} = {}) {
  if (["standard", "fast", "ultrafast"].includes(observedMode)) {
    return Object.freeze({ mode: observedMode, provenance: "observed" });
  }
  if (["standard", "fast", "ultrafast"].includes(declaredMode)) {
    return Object.freeze({
      mode: declaredMode,
      provenance: "declared_codex_config",
    });
  }
  if (unresolvedScenario === "unresolved_as_fast") {
    return Object.freeze({
      mode: "fast",
      provenance: "assumed_fast_scenario",
    });
  }
  return Object.freeze({
    mode: "standard",
    provenance: "assumed_standard_default",
  });
}

/**
 * Speed-priced API-price equivalent for one Standard-priced token amount.
 * Fixed provider tool-call prices are separate and must not be multiplied.
 * A Fast amount on a model without a published Priority rate is included at the
 * disclosed assumed multiplier rather than excluded. Ultrafast requires an
 * eligible published card; an unknown mode is never a silent Standard.
 */
export function quotaWeightedApiPriceEquivalent({
  apiPriceEquivalentUsd,
  model,
  mode,
  eventTime,
  totalInputContextTokens,
  standardPriceCardIds,
} = {}) {
  if (!finiteNonNegative(apiPriceEquivalentUsd)) {
    return Object.freeze({
      usd: null,
      multiplier: null,
      status: "unknown_standard_amount",
    });
  }
  if (mode === "standard") {
    return Object.freeze({
      usd: roundUsd(apiPriceEquivalentUsd),
      multiplier: 1,
      status: "standard_rate",
    });
  }
  if (mode !== "fast" && mode !== "ultrafast") {
    return Object.freeze({ usd: null, multiplier: null, status: "unknown_mode" });
  }
  const multiplier = speedModeApiMultiplier(model, mode, {
    eventTime, totalInputContextTokens, standardPriceCardIds,
  });
  if (multiplier === null) {
    if (mode === "ultrafast") {
      return Object.freeze({
        usd: null,
        multiplier: null,
        status: "ultrafast_price_unavailable",
      });
    }
    return Object.freeze({
      usd: roundUsd(apiPriceEquivalentUsd * FAST_MODE_ASSUMED_MULTIPLIER),
      multiplier: FAST_MODE_ASSUMED_MULTIPLIER,
      status: "fast_weighted_assumed_ratio",
    });
  }
  return Object.freeze({
    usd: roundUsd(apiPriceEquivalentUsd * multiplier),
    multiplier,
    status: mode === "ultrafast" ? "ultrafast_weighted" : "fast_weighted",
  });
}

export function emptySpeedWeightingCrossing() {
  return Object.fromEntries(OBSERVED_SPEED_MODE_KEYS.map((speed) => [
    speed,
    Object.fromEntries(SPEED_MODE_MODEL_FAMILY_KEYS.map((family) => [
      family,
      { events: 0, apiPriceEquivalentUsd: 0 },
    ])),
  ]));
}

function crossingCell(crossing, speed, family) {
  const row = crossing?.[OBSERVED_SPEED_MODE_KEYS.includes(speed) ? speed : "unknown"];
  const cell = row?.[SPEED_MODE_MODEL_FAMILY_KEYS.includes(family) ? family : "unsupported"];
  return {
    events: Number.isSafeInteger(cell?.events) && cell.events >= 0
      ? cell.events
      : 0,
    apiPriceEquivalentUsd: finiteNonNegative(cell?.apiPriceEquivalentUsd)
      ? cell.apiPriceEquivalentUsd
      : 0,
  };
}

// Both crossings round money independently, so a declared cell may exceed the
// unobserved cell it describes by a rounding hair. Anything past this is a real
// inconsistency, not float noise.
const DECLARED_CROSSING_USD_TOLERANCE = 1e-5;

/**
 * Split the unobserved cell of one model family into the part a declared
 * baseline covers and the part still unattributed.
 *
 * A declaration only ever REDESCRIBES turns the rollout log left unobserved, so
 * it can never claim more events or dollars than that cell holds. A crossing
 * that does is discarded whole rather than trusted in part, which degrades to
 * exactly the pre-declaration behaviour instead of inventing an attribution.
 */
function declaredUnobservedSplit(declaredSpeedWeighting, family, unobserved) {
  const parts = [];
  let events = 0;
  let usd = 0;
  for (const mode of ["standard", "fast", "ultrafast"]) {
    const cell = crossingCell(declaredSpeedWeighting, mode, family);
    if (cell.events === 0 && cell.apiPriceEquivalentUsd === 0) continue;
    parts.push({ cell, mode });
    events += cell.events;
    usd += cell.apiPriceEquivalentUsd;
  }
  if (events > unobserved.events
      || usd > unobserved.apiPriceEquivalentUsd
        + DECLARED_CROSSING_USD_TOLERANCE) {
    return { parts: [], residual: unobserved };
  }
  return {
    parts,
    residual: {
      events: unobserved.events - events,
      apiPriceEquivalentUsd: Math.max(
        0,
        unobserved.apiPriceEquivalentUsd - usd,
      ),
    },
  };
}

/**
 * Fold a Standard-priced token-cost speed x model-family crossing into the
 * legacy quota-weighted metric plus an honest coverage split. Independently
 * priced provider tool units must stay outside this crossing.
 *
 * `declaredSpeedWeighting` is the same crossing shape, holding only the
 * unobserved events a timestamped `service_tier` reading actually covers. The
 * caller is responsible for the coverage test, because only it knows each
 * event's timestamp; this function enforces the precedence, never the dates.
 *
 * `inferredFastEvents` is a secondary, window-level count. It reports an
 * overlapping subset of the events whose individual mode remains unknown; it
 * does not reclassify events out of `unknown` or change the coverage
 * partition. A window-level signal cannot prove an individual event's mode,
 * so it never changes the weighted total.
 */
export function summarizeQuotaWeightedAccounting({
  speedWeighting,
  declaredSpeedWeighting = null,
  unresolvedScenario = DEFAULT_UNRESOLVED_SPEED_SCENARIO,
  inferredFastEvents = 0,
  inference = null,
} = {}) {
  const selectedScenario = UNRESOLVED_SPEED_SCENARIOS.includes(unresolvedScenario)
    ? unresolvedScenario
    : DEFAULT_UNRESOLVED_SPEED_SCENARIO;
  let standardApiPriceEquivalentUsd = 0;
  let weightedUsd = 0;
  let unweightedUnknownUsd = 0;
  let hasWeightedAmount = false;
  let hasUnweightedAmount = false;
  let assumedRatioStandardUsd = 0;
  let totalEvents = 0;
  let observedEvents = 0;
  let declaredEvents = 0;
  let assumedEvents = 0;
  let unknownEvents = 0;
  const appliedMultipliers = {};

  const attribute = (cell, resolved, family) => {
    if (cell.events === 0 && cell.apiPriceEquivalentUsd === 0) return;
    standardApiPriceEquivalentUsd += cell.apiPriceEquivalentUsd;
    totalEvents += cell.events;
    if (resolved.provenance === "observed") observedEvents += cell.events;
    else if (resolved.provenance === "declared_codex_config") {
      declaredEvents += cell.events;
    } else if (resolved.provenance === "assumed_standard_default"
      || resolved.provenance === "assumed_fast_scenario") {
      assumedEvents += cell.events;
    } else unknownEvents += cell.events;
    if (resolved.mode === "standard") {
      hasWeightedAmount = true;
      weightedUsd += cell.apiPriceEquivalentUsd;
      return;
    }
    if (resolved.mode === "fast") {
      hasWeightedAmount = true;
      const multiplier = family === "unsupported"
        ? null
        : FAST_MODE_QUOTA_MULTIPLIERS[family] ?? null;
      if (multiplier === null) {
        // No published Priority rate for this model family: include the Fast
        // amount at the disclosed assumed multiplier and report it apart,
        // rather than excluding it or silently counting it at 1x.
        appliedMultipliers.unsupported = FAST_MODE_ASSUMED_MULTIPLIER;
        assumedRatioStandardUsd += cell.apiPriceEquivalentUsd;
        weightedUsd += cell.apiPriceEquivalentUsd * FAST_MODE_ASSUMED_MULTIPLIER;
        return;
      }
      appliedMultipliers[family] = multiplier;
      weightedUsd += cell.apiPriceEquivalentUsd * multiplier;
      return;
    }
    if (resolved.mode === "ultrafast") {
      const multiplier = SPEED_MODE_API_MULTIPLIERS.ultrafast[family] ?? null;
      if (multiplier !== null) {
        hasWeightedAmount = true;
        appliedMultipliers[`ultrafast:${family}`] = multiplier;
        weightedUsd += cell.apiPriceEquivalentUsd * multiplier;
        return;
      }
    }
    hasUnweightedAmount = true;
    unweightedUnknownUsd += cell.apiPriceEquivalentUsd;
  };

  for (const speed of OBSERVED_SPEED_MODE_KEYS) {
    for (const family of SPEED_MODE_MODEL_FAMILY_KEYS) {
      const cell = crossingCell(speedWeighting, speed, family);
      if (speed !== "unknown") {
        // An observed tier is decided by the log alone; no declaration is even
        // offered to the resolver for these events.
        attribute(cell, resolveEffectiveSpeedMode({
          observedMode: speed,
        }), family);
        continue;
      }
      const split = declaredUnobservedSplit(
        declaredSpeedWeighting,
        family,
        cell,
      );
      for (const part of split.parts) {
        attribute(part.cell, resolveEffectiveSpeedMode({
          observedMode: "unknown",
          declaredMode: part.mode,
        }), family);
      }
      attribute(split.residual, resolveEffectiveSpeedMode({
        observedMode: "unknown",
        unresolvedScenario: selectedScenario,
      }), family);
    }
  }

  // Inference labels events with no per-event evidence, which is exactly the
  // assumed bucket now that unresolved turns are attributed by scenario
  // rather than left unknown.
  const reportableInferred = Number.isSafeInteger(inferredFastEvents)
      && inferredFastEvents > 0
    ? Math.min(inferredFastEvents, assumedEvents + unknownEvents)
    : 0;
  const weightingStatus = !hasUnweightedAmount
    ? "complete"
    : hasWeightedAmount ? "partial" : "unknown";

  return Object.freeze({
    metric: QUOTA_WEIGHTED_API_PRICE_METRIC,
    multiplierSource: FAST_MODE_MULTIPLIER_SOURCE,
    assumedMultiplierSource: FAST_MODE_ASSUMED_MULTIPLIER_SOURCE,
    declarationSource: CODEX_SPEED_MODE_DECLARATION,
    unresolvedScenario: selectedScenario,
    standardApiPriceEquivalentUsd: roundUsd(standardApiPriceEquivalentUsd),
    quotaWeightedApiPriceEquivalentUsd: weightingStatus === "unknown"
      ? null
      : roundUsd(weightedUsd),
    unweightedUnknownApiPriceEquivalentUsd: roundUsd(unweightedUnknownUsd),
    // Standard-priced dollars whose Fast weighting used the assumed
    // multiplier because the model has no published Priority rate. Included
    // in the weighted total above; reported here so the assumption is never
    // invisible.
    assumedRatioStandardApiPriceEquivalentUsd: roundUsd(assumedRatioStandardUsd),
    weightingStatus,
    appliedMultipliers: Object.freeze({ ...appliedMultipliers }),
    coverage: Object.freeze({
      totalEvents,
      observedEvents,
      // Turns the log left unobserved that a timestamped `service_tier`
      // reading covers. Kept separate from both observed and assumed so no
      // surface can present a declaration as an observation.
      declaredFromConfigEvents: declaredEvents,
      // Turns with no evidence at all, attributed by the selected unresolved
      // scenario (Standard in the default scenario).
      assumedEvents,
      inferredEvents: reportableInferred,
      // Inference is a window-level label over unresolved events. Keep the
      // full unknown provenance count so the four provenance buckets still
      // partition the total event count; inferredEvents is an overlap.
      unknownEvents,
      observedSharePercent: totalEvents === 0
        ? null
        : roundFraction((observedEvents / totalEvents) * 100),
      unknownSharePercent: totalEvents === 0
        ? null
        : roundFraction((unknownEvents / totalEvents) * 100),
    }),
    inference: Object.freeze({
      status: inference?.status ?? "not_run",
      reasonCode: inference?.reasonCode ?? null,
      inferredFastWindows: inference?.inferredFastWindowCount ?? 0,
      // Inference labels windows, never individual events, so it is reported
      // beside the weighted total and never folded into it.
      appliedToWeighting: false,
      appliedToWeightingReason:
        "window_level_signal_cannot_be_attributed_to_individual_events",
    }),
  });
}

function scorableWindow(window) {
  const thresholds = FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS;
  return finiteNonNegative(window?.apiPriceEquivalentUsd)
    && window.apiPriceEquivalentUsd > 0
    && Number.isSafeInteger(window?.eligibleTransitions)
    && window.eligibleTransitions >= thresholds.minimumEligibleTransitions
    && Number.isSafeInteger(window?.uniqueBoundaries)
    && window.uniqueBoundaries >= thresholds.minimumUniquePercentageBoundaries
    && finiteNonNegative(window?.observedSpanPercentagePoints)
    && window.observedSpanPercentagePoints
      >= thresholds.minimumObservedSpanPercentagePoints;
}

function referenceWindow(window) {
  const thresholds = FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS;
  // Old windows predate Ultrafast and omit this field. A supplied unknown or
  // invalid fraction cannot establish a Standard reference.
  const ultrafastFraction = window.ultrafastFractionOfKnown === undefined
    ? 0 : window.ultrafastFractionOfKnown;
  return scorableWindow(window)
    && typeof window.knownSpeedFraction === "number"
    && Number.isFinite(window.knownSpeedFraction)
    && window.knownSpeedFraction >= thresholds.minimumReferenceKnownSpeedFraction
    && finiteNonNegative(window.fastFractionOfKnown)
    && finiteNonNegative(ultrafastFraction)
    && window.fastFractionOfKnown + ultrafastFraction
      <= thresholds.maximumReferenceFastFractionOfKnown;
}

function matchedMultiples(ratio) {
  const tolerance =
    FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS.relativeToleranceOfPublishedMultiple;
  return PUBLISHED_MULTIPLES.filter((multiple) => (
    Math.abs(ratio - multiple) / multiple <= tolerance
  ));
}

/**
 * Secondary, clearly-labelled residual inference over matched calibration
 * windows.
 *
 * Each window's calibration fit yields the Standard-priced USD that maps to a
 * full allowance in that window. The `reference / window` ratio is compared
 * with the existing published Fast API multiples as a diagnostic correlation.
 * These API multiples are not included-allowance weights, so a match does not
 * prove a provider quota formula or the actual speed of any event. Only one
 * matching multiple produces the legacy inferred Fast label; Ultrafast is
 * never inferred from this correlation.
 *
 * This never overrides an observed value or a stated preference: callers apply
 * it only after `resolveEffectiveSpeedMode` has exhausted both.
 */
export function inferFastModeFromCalibrationWindows(windows) {
  const thresholds = FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS;
  const empty = (reasonCode, extra = {}) => Object.freeze({
    status: "insufficient_signal",
    reasonCode,
    thresholds,
    referenceStandardCapacityUsd: null,
    referenceWindowCount: 0,
    scoredWindowCount: 0,
    inferredFastWindowCount: 0,
    inferredFastUnknownSpeedEvents: 0,
    windows: Object.freeze([]),
    ...extra,
  });
  if (!Array.isArray(windows) || windows.length === 0) {
    return empty("windows_unavailable");
  }
  const scorable = windows.filter(scorableWindow);
  if (scorable.length < thresholds.minimumReferenceWindows + 1) {
    return empty("not_enough_scored_windows");
  }
  const references = scorable.filter(referenceWindow);
  if (references.length < thresholds.minimumReferenceWindows) {
    return empty("not_enough_reference_windows", {
      scoredWindowCount: scorable.length,
    });
  }
  const referenceStandardCapacityUsd = median(
    references.map((window) => window.apiPriceEquivalentUsd),
  );
  if (!finiteNonNegative(referenceStandardCapacityUsd)
      || referenceStandardCapacityUsd === 0) {
    return empty("reference_capacity_unusable", {
      referenceWindowCount: references.length,
      scoredWindowCount: scorable.length,
    });
  }

  const referenceIds = new Set(references.map((window) => window.id));
  let inferredFastWindowCount = 0;
  let inferredFastUnknownSpeedEvents = 0;
  const scored = scorable.map((window) => {
    const ratio = referenceStandardCapacityUsd / window.apiPriceEquivalentUsd;
    const matches = matchedMultiples(ratio);
    const isReference = referenceIds.has(window.id);
    const unknownSpeedEvents =
      Number.isSafeInteger(window.unknownSpeedEvents)
        && window.unknownSpeedEvents >= 0
        ? window.unknownSpeedEvents
        : 0;
    let mode = "unknown";
    let reasonCode = "ratio_matches_no_published_multiple";
    if (isReference) {
      mode = "unknown";
      reasonCode = "window_is_a_standard_reference";
    } else if (matches.length > 1) {
      reasonCode = "ratio_matches_more_than_one_published_multiple";
    } else if (matches.length === 1) {
      mode = "fast";
      reasonCode = "ratio_matches_one_published_multiple";
      inferredFastWindowCount += 1;
      inferredFastUnknownSpeedEvents += unknownSpeedEvents;
    }
    return Object.freeze({
      id: window.id ?? null,
      startAt: window.startAt ?? null,
      endAt: window.endAt ?? null,
      mode,
      provenance: mode === "fast" ? "inferred" : "unknown",
      observedToStandardPredictedRatio: roundFraction(ratio),
      matchedMultiple: mode === "fast" ? matches[0] : null,
      reasonCode,
      isStandardReference: isReference,
      unknownSpeedEvents,
    });
  });

  return Object.freeze({
    status: "inferred",
    reasonCode: null,
    thresholds,
    referenceStandardCapacityUsd: roundUsd(referenceStandardCapacityUsd),
    referenceWindowCount: references.length,
    scoredWindowCount: scorable.length,
    inferredFastWindowCount,
    inferredFastUnknownSpeedEvents,
    windows: Object.freeze(scored),
  });
}
