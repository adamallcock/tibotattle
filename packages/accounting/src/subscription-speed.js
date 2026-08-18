// Codex subscription speed ("Fast") quota accounting.
//
// SOURCE OF THE MULTIPLIERS
// -------------------------
// OpenAI publishes the credit rates that Fast mode consumes relative to the
// Standard rate: Fast consumes credits at 2.5x the Standard rate for GPT-5.6
// and GPT-5.5, and at 2x for GPT-5.4, in exchange for a 1.5x speed increase.
// Fast supports only those three model families. These are the vendor's own
// published rates recorded on 2026-08-01; they are NOT fitted, estimated, or
// derived from this monitor's own calibration.
//
// WHAT THE LOGS ACTUALLY OBSERVE
// ------------------------------
// Codex records the speed mode as an `event_msg` whose payload type is
// `thread_settings_applied`, carrying `thread_settings.service_tier`
// ("priority" = Fast, "default" = Standard). That event fires only when the
// setting is APPLIED OR CHANGED - never at session start - and neither
// `session_meta` nor `turn_context` carries a tier. So every tier change is
// observable and forward-fills from the moment it is seen, but the session
// BASELINE is never written to the rollout log. A session where the mode was
// chosen up front and never switched contains no tier evidence at all.
//
// The provider log parser already models this exactly: it forward-fills from
// the tier timeline and reports `tierSource: "unobserved"` before the first
// observation, which reaches accounting as `codexSpeedMode: "unknown"`. A
// partial known-speed fraction is therefore a faithful measurement, not a
// defect. The declared preference below exists only to attribute that
// pre-first-observation remainder: observation always wins, and anything still
// unattributed stays an explicit unknown rather than a silent 1.0.
const FAST_MODE_MULTIPLIER_RECORDED_AT = "2026-08-01";

export const FAST_MODE_MULTIPLIER_SOURCE = Object.freeze({
  publisher: "openai",
  basis: "published_fast_mode_credit_rate_relative_to_standard",
  statement:
    "Fast mode consumes credits at 2.5x the Standard rate for GPT-5.6 and GPT-5.5, and 2x for GPT-5.4, for a 1.5x speed increase. Fast supports only those three model families.",
  recordedAt: FAST_MODE_MULTIPLIER_RECORDED_AT,
  appliesTo: "codex_subscription_quota_not_api_billing",
  // Tier changes are observable; the session baseline is not.
  observability: "rollout_thread_settings_changes_only_no_session_baseline",
});

// What a Codex rollout log can and cannot prove about the speed mode. Shared
// so every surface states the same thing instead of re-deriving it.
export const CODEX_SPEED_MODE_OBSERVABILITY = Object.freeze({
  recordedEvent: "event_msg.payload.thread_settings_applied.service_tier",
  observedValues: Object.freeze({ priority: "fast", default: "standard" }),
  firesOn: "settings_applied_or_changed",
  sessionBaselineRecorded: false,
  resolution: "forward_filled_from_first_observation_in_the_session",
  unobservedMeans:
    "the mode was set before the session began and never switched, so the log holds no tier for those turns",
});

// Model family -> published Fast credit rate relative to Standard. Any family
// absent from this map is an explicit unknown under Fast, never 1.0.
export const FAST_MODE_QUOTA_MULTIPLIERS = Object.freeze({
  "gpt-5.6": 2.5,
  "gpt-5.5": 2.5,
  "gpt-5.4": 2,
});

// Fixed bucket keys for the Standard-priced cost crossing that feeds the
// weighting. "unsupported" is the explicit bucket for every model outside the
// three published Fast families.
export const FAST_MODE_MODEL_FAMILY_KEYS = Object.freeze([
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.4",
  "unsupported",
]);

export const OBSERVED_SPEED_MODE_KEYS = Object.freeze([
  "standard",
  "fast",
  "unknown",
]);

// What the Codex configuration file can and cannot prove about the baseline.
// `~/.codex/config.toml` holds a top-level `service_tier` key with the CURRENT
// setting - the only place a session baseline exists at all. The Codex UI
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

// The user preference is the only way a current Codex log can be attributed to
// a speed mode at all, because the provider stopped recording it.
export const FAST_MODE_PREFERENCE_VALUES = Object.freeze([
  "standard",
  "fast",
  "mixed_unknown",
]);
export const DEFAULT_FAST_MODE_PREFERENCE = "standard";

// How an event's effective mode was decided. These five are distinct
// everywhere they surface; neither "declared_codex_config" nor "inferred" is
// ever presented as "observed".
export const SPEED_MODE_PROVENANCE_VALUES = Object.freeze([
  "observed",
  "declared_codex_config",
  "assumed_from_preference",
  "inferred",
  "unknown",
]);

export const QUOTA_WEIGHTED_API_PRICE_METRIC = Object.freeze({
  key: "quotaWeightedApiPriceEquivalentUsd",
  label: "Quota-weighted API-price equivalent",
  shortLabel: "Quota-weighted API equivalent",
  standardMetricKey: "apiPriceEquivalentUsd",
  standardMetricLabel: "Standard-rate API-price equivalent",
  explainer:
    "Standard-rate API prices, multiplied by the published Fast credit rate for events in Fast mode: 2.5x for GPT-5.6 and GPT-5.5, 2x for GPT-5.4. It tracks relative quota consumption, not a bill.",
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
  // evidence is both present and overwhelmingly Standard.
  minimumReferenceKnownSpeedFraction: 0.6,
  maximumReferenceFastFractionOfKnown: 0.05,
  minimumReferenceWindows: 3,
  // The observed-to-Standard-predicted movement ratio must land inside this
  // relative band around a published multiple. 0.10 keeps the 2.0 and 2.5
  // bands disjoint ([1.8, 2.2] and [2.25, 2.75]), so a window can never match
  // both; a window matching more than one multiple is reported ambiguous.
  relativeToleranceOfPublishedMultiple: 0.1,
});

export const FAST_MODE_RESIDUAL_INFERENCE_REASON_CODES = Object.freeze([
  "not_enough_scored_windows",
  "not_enough_reference_windows",
  "reference_capacity_unusable",
  "windows_unavailable",
]);

const FAST_MODE_FAMILY_PATTERNS = Object.freeze(
  Object.keys(FAST_MODE_QUOTA_MULTIPLIERS).map((family) => Object.freeze({
    family,
    // Exact family, then end-of-name or a "-" suffix. "gpt-5.60" and
    // "gpt-5.4future" are deliberately not members of any family.
    pattern: new RegExp(`^${family.replaceAll(".", "\\.")}(?:$|-)`, "u"),
  })),
);

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
 * The published Fast model family a model name belongs to, or null when the
 * model is outside the three families Fast supports.
 */
export function fastModeModelFamily(model) {
  if (typeof model !== "string") return null;
  for (const { family, pattern } of FAST_MODE_FAMILY_PATTERNS) {
    if (pattern.test(model)) return family;
  }
  return null;
}

/**
 * The published Fast credit rate for a model, or null when the model has no
 * published Fast rate. Callers must treat null as unknown; it is never 1.
 */
export function fastModeQuotaMultiplier(model) {
  const family = fastModeModelFamily(model);
  return family === null ? null : FAST_MODE_QUOTA_MULTIPLIERS[family];
}

export function fastModeModelFamilyKey(model) {
  return fastModeModelFamily(model) ?? "unsupported";
}

export function isFastModePreference(value) {
  return FAST_MODE_PREFERENCE_VALUES.includes(value);
}

/**
 * Resolution order, strongest evidence first:
 *   1. observed          - the rollout log carried a `thread_settings_applied`
 *                          tier at or before this turn. This ALWAYS wins;
 *                          nothing below can overwrite or bypass it.
 *   2. declared_codex_config - the Codex configuration's `service_tier` key was
 *                          read at a moment that covers this turn. It recovers
 *                          the session baseline the log never writes, but only
 *                          forward from the reading; callers must not pass a
 *                          declaration for a turn the reading does not cover.
 *   3. assumed_from_preference - no log tier and no covering reading, so the
 *                          owner's stated mode is the only attribution left.
 *   4. inferred          - only when the owner explicitly said mixed_unknown,
 *                          so inference can never override a stated preference.
 *   5. unknown           - nothing legitimate to say; never a silent Standard.
 */
export function resolveEffectiveSpeedMode({
  observedMode = "unknown",
  declaredMode = "unknown",
  preference = DEFAULT_FAST_MODE_PREFERENCE,
  inferredMode = "unknown",
} = {}) {
  if (observedMode === "standard" || observedMode === "fast") {
    return Object.freeze({ mode: observedMode, provenance: "observed" });
  }
  if (declaredMode === "standard" || declaredMode === "fast") {
    return Object.freeze({
      mode: declaredMode,
      provenance: "declared_codex_config",
    });
  }
  if (preference === "standard" || preference === "fast") {
    return Object.freeze({
      mode: preference,
      provenance: "assumed_from_preference",
    });
  }
  if (inferredMode === "fast" || inferredMode === "standard") {
    return Object.freeze({ mode: inferredMode, provenance: "inferred" });
  }
  return Object.freeze({ mode: "unknown", provenance: "unknown" });
}

/**
 * Quota-weighted API-price equivalent for one Standard-priced amount.
 * Returns an explicit unknown rather than falling back to the Standard amount
 * whenever the mode or the model's published rate is not known.
 */
export function quotaWeightedApiPriceEquivalent({
  apiPriceEquivalentUsd,
  model,
  mode,
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
  if (mode !== "fast") {
    return Object.freeze({ usd: null, multiplier: null, status: "unknown_mode" });
  }
  const multiplier = fastModeQuotaMultiplier(model);
  if (multiplier === null) {
    return Object.freeze({
      usd: null,
      multiplier: null,
      status: "unknown_multiplier",
    });
  }
  return Object.freeze({
    usd: roundUsd(apiPriceEquivalentUsd * multiplier),
    multiplier,
    status: "fast_weighted",
  });
}

export function emptySpeedWeightingCrossing() {
  return Object.fromEntries(OBSERVED_SPEED_MODE_KEYS.map((speed) => [
    speed,
    Object.fromEntries(FAST_MODE_MODEL_FAMILY_KEYS.map((family) => [
      family,
      { events: 0, apiPriceEquivalentUsd: 0 },
    ])),
  ]));
}

function crossingCell(crossing, speed, family) {
  const row = crossing?.[OBSERVED_SPEED_MODE_KEYS.includes(speed) ? speed : "unknown"];
  const cell = row?.[FAST_MODE_MODEL_FAMILY_KEYS.includes(family) ? family : "unsupported"];
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
  for (const mode of ["standard", "fast"]) {
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
 * Fold a Standard-priced speed x model-family crossing into the quota-weighted
 * metric plus an honest coverage split.
 *
 * `declaredSpeedWeighting` is the same crossing shape, holding only the
 * unobserved events a timestamped `service_tier` reading actually covers. The
 * caller is responsible for the coverage test, because only it knows each
 * event's timestamp; this function enforces the precedence, never the dates.
 *
 * `inferredFastEvents` is a secondary, window-level count. It reports an
 * overlapping subset of the events whose individual mode remains unknown; it
 * does not reclassify events out of `unknown` or change the coverage
 * partition. A window-level signal cannot be attributed to an individual
 * event without the mode field the provider stopped emitting, so it never
 * changes the weighted total.
 */
export function summarizeQuotaWeightedAccounting({
  speedWeighting,
  declaredSpeedWeighting = null,
  preference = DEFAULT_FAST_MODE_PREFERENCE,
  inferredFastEvents = 0,
  inference = null,
} = {}) {
  const selectedPreference = isFastModePreference(preference)
    ? preference
    : DEFAULT_FAST_MODE_PREFERENCE;
  let standardApiPriceEquivalentUsd = 0;
  let weightedUsd = 0;
  let unweightedUnknownUsd = 0;
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
    } else if (resolved.provenance === "assumed_from_preference") {
      assumedEvents += cell.events;
    } else unknownEvents += cell.events;
    if (resolved.mode === "standard") {
      weightedUsd += cell.apiPriceEquivalentUsd;
      return;
    }
    if (resolved.mode === "fast") {
      const multiplier = family === "unsupported"
        ? null
        : FAST_MODE_QUOTA_MULTIPLIERS[family];
      if (multiplier === null) {
        unweightedUnknownUsd += cell.apiPriceEquivalentUsd;
        return;
      }
      appliedMultipliers[family] = multiplier;
      weightedUsd += cell.apiPriceEquivalentUsd * multiplier;
      return;
    }
    unweightedUnknownUsd += cell.apiPriceEquivalentUsd;
  };

  for (const speed of OBSERVED_SPEED_MODE_KEYS) {
    for (const family of FAST_MODE_MODEL_FAMILY_KEYS) {
      const cell = crossingCell(speedWeighting, speed, family);
      if (speed !== "unknown") {
        // An observed tier is decided by the log alone; no declaration is even
        // offered to the resolver for these events.
        attribute(cell, resolveEffectiveSpeedMode({
          observedMode: speed,
          preference: selectedPreference,
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
          preference: selectedPreference,
        }), family);
      }
      attribute(split.residual, resolveEffectiveSpeedMode({
        observedMode: "unknown",
        preference: selectedPreference,
      }), family);
    }
  }

  const reportableInferred = Number.isSafeInteger(inferredFastEvents)
      && inferredFastEvents > 0
    ? Math.min(inferredFastEvents, unknownEvents)
    : 0;
  const weightingStatus = unweightedUnknownUsd === 0
    ? "complete"
    : weightedUsd === 0 ? "unknown" : "partial";

  return Object.freeze({
    metric: QUOTA_WEIGHTED_API_PRICE_METRIC,
    multiplierSource: FAST_MODE_MULTIPLIER_SOURCE,
    declarationSource: CODEX_SPEED_MODE_DECLARATION,
    preference: selectedPreference,
    standardApiPriceEquivalentUsd: roundUsd(standardApiPriceEquivalentUsd),
    quotaWeightedApiPriceEquivalentUsd: weightingStatus === "unknown"
      ? null
      : roundUsd(weightedUsd),
    unweightedUnknownApiPriceEquivalentUsd: roundUsd(unweightedUnknownUsd),
    weightingStatus,
    appliedMultipliers: Object.freeze({ ...appliedMultipliers }),
    coverage: Object.freeze({
      totalEvents,
      observedEvents,
      // Turns the log left unobserved that a timestamped `service_tier`
      // reading covers. Kept separate from both observed and assumed so no
      // surface can present a declaration as an observation.
      declaredFromConfigEvents: declaredEvents,
      assumedFromPreferenceEvents: assumedEvents,
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
  return scorableWindow(window)
    && typeof window.knownSpeedFraction === "number"
    && Number.isFinite(window.knownSpeedFraction)
    && window.knownSpeedFraction >= thresholds.minimumReferenceKnownSpeedFraction
    && typeof window.fastFractionOfKnown === "number"
    && Number.isFinite(window.fastFractionOfKnown)
    && window.fastFractionOfKnown
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
 * full allowance in that window. A window that actually ran in Fast burns the
 * allowance faster per Standard-priced dollar, so its fitted capacity is the
 * Standard reference divided by the Fast multiple. The ratio
 * `reference / window` is therefore the window's observed quota movement
 * expressed as a multiple of its Standard-priced prediction. When that ratio
 * sits inside a narrow band around a published multiple - and only one
 * published multiple matches - the window is marked inferred Fast.
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
