// Public, read-only community data boundary.
//
// This module intentionally knows only the released aggregate contracts. The
// public website reads the day-partitioned series alone; the sealed weekly
// snapshot normalizer below is retained because the app's data-client.js still
// interprets that contract. The app's local companion, identity, contribution,
// and deletion clients remain in data-client.js and are not part of the public
// website's module graph.

import { REVIEWED_MODEL_CATALOG } from "./model-catalog.generated.js";

const COMMUNITY_ROOT = "/api/v1";
const SAFE_ERROR_CODE_PATTERN =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const SERVICE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const COMMUNITY_SNAPSHOT_SCHEMA_VERSION =
  "community-weekly-snapshot-v0.3";
// Sealed snapshots are immutable, so a reader must retain every released
// schema version it can still interpret. The v0.1 cells omit plan cohorts;
// v0.3 changes the cohort claim from independent participants to eligible
// social-provider accounts. Every other publication and privacy check remains
// equally strict.
export const SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS = Object.freeze([
  "community-weekly-snapshot-v0.1",
  "community-weekly-snapshot-v0.2",
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
]);

const COMMUNITY_SNAPSHOT_PLAN_COHORT_VERSIONS = new Set([
  "community-weekly-snapshot-v0.2",
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
]);
const COMMUNITY_SNAPSHOT_PROVIDER_ACCOUNT_COHORT_VERSIONS = new Set([
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
]);
const PROVIDER_ACCOUNT_COHORT_ELIGIBILITY =
  "provider_account_gated_open_cohort";
// v0.3 is a closed public claim, not merely a shape to deserialize. The
// browser may accept stricter server policy values, but it must not render a
// payload that quietly weakens the published account/maturity guarantees.
// Any deliberate weaker or semantically different policy requires a new
// contract version and an explicit client review.
const COMMUNITY_WEEKLY_POLICY_VERSION = "community-weekly-v0.1";
const COMMUNITY_WEEKLY_MINIMUM_PROVIDER_ACCOUNTS = 20;
const COMMUNITY_WEEKLY_MINIMUM_MATURITY_DAYS = 7;
const COMMUNITY_WEEKLY_MINIMUM_ACCEPTED_COLLECTION_DAYS = 2;
const OPEN_PROVIDER_ACCOUNT_MATURITY_APPLIES_TO =
  "open_provider_account_cohort";
const ACCEPTED_COLLECTION_DAY_BASIS =
  "telemetry_contribution_created_at_before_cutoff";
const COMMUNITY_METRIC_UNITS = Object.freeze({
  usageEvents: "events_rounded_down",
  inputUncachedTokens: "tokens_rounded_down",
  inputCacheReadTokens: "tokens_rounded_down",
  inputCacheWriteTokens: "tokens_rounded_down",
  outputTextTokens: "tokens_rounded_down",
  outputReasoningTokens: "tokens_rounded_down",
  outputCombinedTokens: "tokens_rounded_down",
  toolUnits: "tool_units_rounded_down",
});

function finite(value, fallback = null) {
  if (value === null
      || value === undefined
      || value === ""
      || typeof value === "boolean") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.length <= 500 ? value : fallback;
}

function snapshotMetric(value, expectedUnit) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (value.status === "suppressed") {
    return { status: "suppressed", value: null, unit: expectedUnit };
  }
  const numeric = finite(value.value, null);
  if (value.status !== "released"
      || value.unit !== expectedUnit
      || numeric === null
      || !Number.isSafeInteger(numeric)
      || numeric < 0) {
    return null;
  }
  return { status: "released", value: numeric, unit: expectedUnit };
}

function publishedCohort(payload) {
  const providerAccountCohort =
    COMMUNITY_SNAPSHOT_PROVIDER_ACCOUNT_COHORT_VERSIONS.has(
      payload.schemaVersion,
    );
  if (!providerAccountCohort) {
    const minimumParticipants = finite(
      payload.privacyPolicy?.minimumIndependentParticipants,
      null,
    );
    return Number.isSafeInteger(minimumParticipants)
      && minimumParticipants >= 3
      ? {
        minimumParticipants,
        participantCohort: "legacy_contributor",
      }
      : null;
  }

  const minimumParticipants = finite(
    payload.privacyPolicy?.minimumProviderAccountParticipants,
    null,
  );
  const maturityDays = finite(payload.privacyPolicy?.maturity?.maturityDays, null);
  const minimumAcceptedCollectionDays = finite(
    payload.privacyPolicy?.maturity?.minimumAcceptedCollectionDays,
    null,
  );
  if (payload.privacyPolicy?.version !== COMMUNITY_WEEKLY_POLICY_VERSION
      || payload.cohortEligibility !== PROVIDER_ACCOUNT_COHORT_ELIGIBILITY
      || payload.privacyPolicy?.maturity?.appliesTo
        !== OPEN_PROVIDER_ACCOUNT_MATURITY_APPLIES_TO
      || payload.privacyPolicy?.maturity?.acceptedCollectionDayBasis
        !== ACCEPTED_COLLECTION_DAY_BASIS
      || !Number.isSafeInteger(minimumParticipants)
      || minimumParticipants < COMMUNITY_WEEKLY_MINIMUM_PROVIDER_ACCOUNTS
      || !Number.isSafeInteger(maturityDays)
      || maturityDays < COMMUNITY_WEEKLY_MINIMUM_MATURITY_DAYS
      || maturityDays > 3_650
      || !Number.isSafeInteger(minimumAcceptedCollectionDays)
      || minimumAcceptedCollectionDays
        < COMMUNITY_WEEKLY_MINIMUM_ACCEPTED_COLLECTION_DAYS
      || minimumAcceptedCollectionDays > 366) {
    return null;
  }
  return {
    minimumParticipants,
    participantCohort: "provider_account",
  };
}

export function normalizeCommunitySnapshot(payload) {
  if (!payload) return { state: "service_unavailable", cells: [] };
  if (payload.publicationStatus
      === "development_diagnostic_not_publication_safe") {
    return { state: "development_unsafe", cells: [] };
  }
  if (!SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS.includes(
    payload.schemaVersion,
  )
      || payload.immutable !== true
      || payload.nonOverlapping !== true) {
    return { state: "unsupported_schema", cells: [] };
  }
  const carriesPlanCohort = COMMUNITY_SNAPSHOT_PLAN_COHORT_VERSIONS.has(
    payload.schemaVersion,
  );
  const cohort = publishedCohort(payload);

  const base = {
    schemaVersion: payload.schemaVersion,
    snapshotId: text(payload.snapshotId, ""),
    period: {
      startAt: text(payload.period?.startAt, ""),
      endAt: text(payload.period?.endAt, ""),
    },
    ingestionCutoffAt: text(payload.ingestionCutoffAt, ""),
    releasedAt: text(payload.releasedAt, ""),
    policyVersion: text(payload.privacyPolicy?.version, ""),
    minimumParticipants: cohort?.minimumParticipants ?? null,
    participantCohort: cohort?.participantCohort ?? "unknown",
    cells: [],
  };

  if (payload.releaseStatus === "not_yet_published") {
    return { ...base, state: "not_yet_published" };
  }
  if (payload.releaseStatus === "withdrawn") {
    return { ...base, state: "withdrawn" };
  }
  if (payload.releaseStatus === "suppressed") {
    return { ...base, state: "suppressed" };
  }
  if (payload.releaseStatus !== "published"
      || !base.snapshotId
      || !base.period.startAt
      || !base.period.endAt
      || !base.ingestionCutoffAt
      || !base.releasedAt
      || !base.policyVersion
      || cohort === null
      || !Array.isArray(payload.cells)
      || payload.cells.length > 100) {
    return { ...base, state: "unsupported_schema" };
  }

  const cells = [];
  let partial = false;
  for (const candidate of payload.cells) {
    const provider = text(candidate?.provider, "");
    const modelId = text(candidate?.modelId, "");
    if (!provider
        || !modelId
        || !candidate.metrics
        || typeof candidate.metrics !== "object"
        || Array.isArray(candidate.metrics)) {
      return { ...base, state: "unsupported_schema" };
    }
    const planType = carriesPlanCohort
      ? text(candidate?.planType, "unknown")
      : "unknown";
    const planVariant = carriesPlanCohort
      ? text(candidate?.planVariant, "unknown")
      : "unknown";
    const metrics = {};
    for (
      const [metricName, expectedUnit]
      of Object.entries(COMMUNITY_METRIC_UNITS)
    ) {
      const metric = snapshotMetric(candidate.metrics[metricName], expectedUnit);
      if (!metric) return { ...base, state: "unsupported_schema" };
      metrics[metricName] = metric;
      partial ||= metric.status === "suppressed";
    }
    cells.push({ provider, planType, planVariant, modelId, metrics });
  }
  return {
    ...base,
    state: partial ? "published_partial" : "published",
    cells,
  };
}

export const COMMUNITY_DAILY_READ_SCHEMA_VERSION = "community-daily-read-v1.0";
const COMMUNITY_DAILY_AGGREGATE_SCHEMA_VERSION =
  "community-daily-aggregate-v1.0";
const COMMUNITY_DAILY_POLICY_VERSION = "community-daily-v1.0";
// Standing rule: read windows are absent or a full year, never
// convenience-sized. The endpoint's inclusive bound is 366 days.
export const COMMUNITY_DAILY_WINDOW_DAYS = 366;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const COMMUNITY_DAILY_TOTAL_FIELDS = Object.freeze([
  "contributingParticipants",
  "contributingDevices",
  "usageEvents",
  "quotaObservations",
  "sessionDimensions",
  "inputUncachedTokens",
  "inputCacheReadTokens",
  "inputCacheWriteTokens",
  "outputTextTokens",
  "outputReasoningTokens",
  "outputCombinedTokens",
]);

function dayString(value) {
  return typeof value === "string" && DAY_PATTERN.test(value) ? value : null;
}

/**
 * The inclusive year window ending today (UTC): 366 days, the endpoint's
 * exact bound, so late-arriving history recomputations stay visible instead
 * of a shorter convenience window hiding them.
 */
export function communityDailyWindow(nowMs = Date.now()) {
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const from = new Date(
    nowMs - (COMMUNITY_DAILY_WINDOW_DAYS - 1) * MILLISECONDS_PER_DAY,
  ).toISOString().slice(0, 10);
  return { from, to };
}

// The allowance block is additive on community-daily-aggregate-v1.0. Only the
// exact merged methodology is interpreted: supported personal-plan fits are
// normalized into one Pro 10x-equivalent summary before the median and range
// are calculated. Old Pro-only blocks and any future methodology are per-day
// absent, never silently relabelled under the merged copy.
export const COMMUNITY_ALLOWANCE_BASIS =
  "seven_day_codex_pro10x_equivalent_personal_plans_trailing_30d_promax25";
export const COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE = "pro";
export const COMMUNITY_ALLOWANCE_NORMALIZATION =
  "pro_x1_prolite_x2_promax_x0_4_plus_x10";
const LEGACY_COMMUNITY_ALLOWANCE_BASIS =
  "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d";
const LEGACY_COMMUNITY_ALLOWANCE_NORMALIZATION = "pro_x1_prolite_x4_plus_x20";

// Inverse of the validated reference-plan display basis, not a pricing model
// or a new allowance fit. Convert the unrounded estimate before formatting.
const PLAN_REFERENCE_MULTIPLIERS = Object.freeze({ pro: 1, prolite: 2, promax: 0.4, plus: 10 });
const LEGACY_PLAN_REFERENCE_MULTIPLIERS = Object.freeze({ pro: 1, prolite: 4, plus: 20 });
export function planWeeklyApiEquivalentUsd(referenceUsd, planType, normalization = COMMUNITY_ALLOWANCE_NORMALIZATION) {
  const multipliers = normalization === COMMUNITY_ALLOWANCE_NORMALIZATION ? PLAN_REFERENCE_MULTIPLIERS
    : normalization === LEGACY_COMMUNITY_ALLOWANCE_NORMALIZATION ? LEGACY_PLAN_REFERENCE_MULTIPLIERS : null;
  if (typeof referenceUsd !== "number" || !Number.isFinite(referenceUsd) || referenceUsd < 0
      || typeof planType !== "string"
      || (multipliers === null || !Object.prototype.hasOwnProperty.call(multipliers, planType))) return null;
  return referenceUsd / multipliers[planType];
}

// The page's own selected roster, in display order: the models it leads with.
// Roster models keep a card while they have no estimate.
const PUBLIC_ALLOWANCE_ROSTER = Object.freeze([
  ["gpt-6-astra", "GPT-6 Astra"],
  ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["gpt-6-sol", "GPT-6 Sol"],
  ["gpt-6-luna", "GPT-6 Luna"],
  ["gpt-5.6-terra", "GPT-5.6 Terra"],
  ["gpt-5.6-sol", "GPT-5.6 Sol"],
  ["gpt-5.6-luna", "GPT-5.6 Luna"],
]);
const PUBLIC_ALLOWANCE_ROSTER_IDS = new Set(PUBLIC_ALLOWANCE_ROSTER.map(([modelId]) => modelId));
// The owner chose a selected comparison, not the whole historical vocabulary
// (2d6cfbc8, "six requested public allowance models"): older generations stay
// off the page. That choice is this explicit list, frozen at catalog
// reviewed-model-catalog-2026-09-29.1. A model appended to the catalog after
// that version is not on it, so it is charted as soon as the server publishes an
// estimate for it, with no page edit. Add it here to keep it off. A published
// metadata block charts a model named here too.
const PUBLIC_ALLOWANCE_HIDDEN_IDS = Object.freeze([
  "codex-auto-review", "gpt-4-turbo-2024-04-09", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "gpt-4o", "gpt-4o-2024-05-13", "gpt-4o-mini", "gpt-5", "gpt-5-codex", "gpt-5-mini",
  "gpt-5-nano", "gpt-5-pro", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.2",
  "gpt-5.2-codex", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-codex", "gpt-5.5-pro", "gpt-5.6-sol-wm", "o1", "o1-pro",
  "o3", "o3-mini", "o3-pro", "o4-mini", "gpt-6.1-astra",
]);

/**
 * The models a build can name for the public comparison, from a reviewed catalog.
 * `charted` is the roster (pinned), then every other primary Codex model that is
 * not on the hide list, in catalog order, with its catalog label. `known` also
 * holds the hidden ones: their tuples are valid on the wire and kept, only not
 * charted, so a page update cannot make previously published days disappear.
 */
export function publicAllowanceModels(catalog = REVIEWED_MODEL_CATALOG) {
  const primary = catalog.filter(model => model.provider === "openai_codex"
    && model.allowanceTrack === "primary");
  const hidden = new Set(PUBLIC_ALLOWANCE_HIDDEN_IDS);
  const charted = Object.freeze([
    ...PUBLIC_ALLOWANCE_ROSTER.map(([modelId, label]) => Object.freeze({ modelId, label, pinned: true })),
    ...primary.filter(model => !PUBLIC_ALLOWANCE_ROSTER_IDS.has(model.id) && !hidden.has(model.id))
      .map(model => Object.freeze({ modelId: model.id, label: model.label })),
  ]);
  return { charted, known: new Set([...charted.map(model => model.modelId), ...primary.map(model => model.id)]) };
}
const PUBLIC_ALLOWANCE_MODELS = publicAllowanceModels();
export const PUBLIC_ALLOWANCE_MODEL_CONFIG = PUBLIC_ALLOWANCE_MODELS.charted;
const LEGACY_PUBLIC_ALLOWANCE_PLAN_IDS = Object.freeze(["pro", "prolite", "plus"]);
const PUBLIC_ALLOWANCE_PLAN_IDS = Object.freeze(["pro", "prolite", "promax", "plus"]);

// An allowance-breakdown day carries one tuple per identified model. A server
// that knows a newer model than this page does is expected, so the tuple count
// is bounded by a fixed sanity cap rather than by this build's catalog size.
const PUBLIC_BREAKDOWN_MODELS_PER_DAY_MAX = 256;
const PUBLIC_BREAKDOWN_DAYS_MAX = 70;
// A retained copy states how many tuples it left out as two content-free
// integers. They can never exceed what a live payload could have carried.
const RETAINED_UNRECOGNIZED_KEYS = Object.freeze(["tuples", "models"]);
const RETAINED_UNRECOGNIZED_TUPLES_MAX = PUBLIC_BREAKDOWN_DAYS_MAX * PUBLIC_BREAKDOWN_MODELS_PER_DAY_MAX;

// Optional, additive model metadata on the breakdown block. It lets the server
// name and order models this build's catalog has never seen. Closed on every
// axis: exact keys, bounded count, token grammars and an integer order. The id
// is only ever a join key; what the page may print is the validated label.
export const PUBLIC_MODEL_METADATA_MAX_ENTRIES = 128;
const PUBLIC_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const PUBLIC_MODEL_LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .+_()×·/:-]{0,79}$/u;
const PUBLIC_MODEL_FAMILY_PATTERN = /^[a-z][a-z0-9-]{0,23}$/u;
const PUBLIC_MODEL_ORDER_MAX = 9999;
// Reviewed identities that are deliberately not on the primary comparison
// (a separate allowance track, or another provider). A metadata block cannot
// promote them; the catalog's own classification wins.
const PUBLIC_MODEL_CATALOG_EXCLUDED_IDS = new Set(REVIEWED_MODEL_CATALOG
  .filter(model => model.provider !== "openai_codex" || model.allowanceTrack !== "primary")
  .map(model => model.id));
const exactObject = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const publicCount = value => Number.isSafeInteger(value) && value >= 0;
const publicDollars = value => typeof value === "number" && Number.isFinite(value) && value > 0;
const publicDay = value => typeof value === "string" && DAY_PATTERN.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

function publicAllowanceSummary(value) {
  if (!exactObject(value, ["centralUsd", "participantCount", "fitCount", "band80Usd"])
      || !publicCount(value.fitCount) || !publicCount(value.participantCount)
      || value.participantCount > value.fitCount) return null;
  if (value.fitCount === 0) {
    if (value.participantCount !== 0 || value.centralUsd !== null || value.band80Usd !== null) return null;
  } else if (value.participantCount < 1 || !publicDollars(value.centralUsd)) return null;
  let band80Usd = null;
  if (value.band80Usd !== null) {
    const band = value.band80Usd;
    if (value.fitCount < 3 || !exactObject(band, ["lowerUsd", "upperUsd"])
        || !publicDollars(band.lowerUsd) || !publicDollars(band.upperUsd)
        || band.lowerUsd > value.centralUsd || band.upperUsd < value.centralUsd) return null;
    band80Usd = { lowerUsd: band.lowerUsd, upperUsd: band.upperUsd };
  }
  return { centralUsd: value.centralUsd, participantCount: value.participantCount,
    fitCount: value.fitCount, band80Usd };
}

/**
 * The optional published model-metadata block, or null when any part of it is
 * outside the closed contract. All-or-nothing: a partly valid block is never
 * partly trusted. Returns a map of model id to its validated presentation.
 */
function publicModelMetadata(value) {
  if (!Array.isArray(value) || value.length > PUBLIC_MODEL_METADATA_MAX_ENTRIES) return null;
  const entries = new Map();
  for (const entry of value) {
    if (!exactObject(entry, ["id", "label", "family", "order"])
        || typeof entry.id !== "string" || !PUBLIC_MODEL_ID_PATTERN.test(entry.id)
        || PUBLIC_MODEL_CATALOG_EXCLUDED_IDS.has(entry.id) || entries.has(entry.id)
        || typeof entry.label !== "string" || !PUBLIC_MODEL_LABEL_PATTERN.test(entry.label)
        || typeof entry.family !== "string" || !PUBLIC_MODEL_FAMILY_PATTERN.test(entry.family)
        || !Number.isSafeInteger(entry.order) || entry.order < 0
        || entry.order > PUBLIC_MODEL_ORDER_MAX) return null;
    entries.set(entry.id, { label: entry.label, family: entry.family, order: entry.order });
  }
  return entries;
}

/**
 * The charted models for one publication: this build's own list (its roster,
 * then the rest of the catalog that is not hidden), then any metadata-only
 * models in published order. Metadata replaces a model's label and adds a family
 * and order, and charts a hidden model it names; it never removes a model.
 * Without metadata this is exactly this build's own list. `published` is a list
 * of validated `{ modelId, label, family, order }` entries.
 */
export function chartedModelsWith(published = []) {
  const config = new Map(PUBLIC_ALLOWANCE_MODEL_CONFIG.map(model => [model.modelId, model]));
  for (const { modelId, label, family, order } of published) {
    config.set(modelId, Object.freeze({ ...config.get(modelId), modelId, label, family, order }));
  }
  return [...config.values()];
}

// The published breakdown contract versions this reader honours, and the two
// fixed method claims inside them. Named because the cache projection has to
// rebuild the exact wire shape it accepted, and a second spelling of a claim
// is a second thing that can drift.
//
// v1.3 is v1.1's meaning (the Pro 20x basis, with `combined`) plus the closed
// model-metadata block, so it is read on the legacy basis. Only v1.2 is
// current: a newer version, v1.4 included, is refused whole until this reader
// is changed to understand it.
export const COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS = Object.freeze([
  "community-allowance-breakdowns-v1.0",
  "community-allowance-breakdowns-v1.1",
  "community-allowance-breakdowns-v1.2",
  "community-allowance-breakdowns-v1.3",
]);
const COMMUNITY_ALLOWANCE_BREAKDOWN_COMBINED_VERSION =
  "community-allowance-breakdowns-v1.1";
const COMMUNITY_ALLOWANCE_BREAKDOWN_MODEL_METADATA_VERSION =
  "community-allowance-breakdowns-v1.3";
const COMMUNITY_ALLOWANCE_MODEL_BASIS =
  "seven_day_codex_pro10x_equivalent_per_model_composition";
const LEGACY_COMMUNITY_ALLOWANCE_MODEL_BASIS =
  "seven_day_codex_pro20x_equivalent_per_model_composition";
const COMMUNITY_ALLOWANCE_MODEL_GATE =
  "shared_composition_kernel_identification";

const PUBLIC_BREAKDOWN_ENVELOPE_KEYS = Object.freeze(["schemaVersion", "basis",
  "referencePlanType", "normalization", "modelBasis", "modelGate", "generatedAt", "days"]);

/**
 * The count a retained copy carries for the tuples its projection left out, or
 * null when it is malformed. Two bounded integers and nothing else: a retained
 * copy has to keep saying that a gap exists, and no id ever reaches storage.
 */
function retainedUnrecognizedCounts(value) {
  if (!exactObject(value, RETAINED_UNRECOGNIZED_KEYS)
      || !Number.isSafeInteger(value.tuples) || value.tuples < 1
      || value.tuples > RETAINED_UNRECOGNIZED_TUPLES_MAX
      || !Number.isSafeInteger(value.models) || value.models < 1
      || value.models > value.tuples) return null;
  return { tuples: value.tuples, models: value.models };
}

/** New public contract, never the private preview. Invalid optional breakdowns
 * cannot hide the separately validated daily activity or aggregate estimates.
 *
 * Model identity is tolerant in one way only. A tuple whose model id is not
 * known (to this build's catalog, or to a valid `modelConfig` block) is skipped
 * and counted, so a model newer than this page costs its own series instead of
 * every breakdown. The skip is for identities this page has never heard of: an
 * id outside the id grammar, a repeated id, and an id the catalog reviewed and
 * kept off the primary comparison (a separate allowance track, or another
 * provider) are producer faults that refuse the block, exactly as for a known
 * id. The tuple's numbers must still be valid, the id is never retained or
 * rendered, and every other part of the contract stays closed.
 *
 * `retained` is true only for a payload this browser stored itself. Its
 * projection leaves the skipped tuples out and records how many as
 * `retainedUnrecognizedModels`, so a cached render still states the gap. A live
 * payload carrying that key is not on the wire contract and is refused. */
export function normalizePublicAllowanceBreakdowns(value, publishedDays, nowMs = Date.now(), { retained = false } = {}) {
  const isRecord = value !== null && typeof value === "object" && !Array.isArray(value);
  const hasMetadataBlock = isRecord && Object.prototype.hasOwnProperty.call(value, "modelConfig");
  const hasRetainedCounts = retained && isRecord
    && Object.prototype.hasOwnProperty.call(value, "retainedUnrecognizedModels");
  const carried = hasRetainedCounts ? retainedUnrecognizedCounts(value.retainedUnrecognizedModels) : null;
  if (hasRetainedCounts && carried === null) return null;
  if (!exactObject(value, [
    ...PUBLIC_BREAKDOWN_ENVELOPE_KEYS,
    ...(hasMetadataBlock ? ["modelConfig"] : []),
    ...(hasRetainedCounts ? ["retainedUnrecognizedModels"] : []),
  ])
      || !COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS.includes(value.schemaVersion)
      || value.referencePlanType !== "pro"
      || value.modelGate !== COMMUNITY_ALLOWANCE_MODEL_GATE
      || typeof value.generatedAt !== "string" || !Number.isFinite(nowMs)
      || !Array.isArray(value.days) || value.days.length > PUBLIC_BREAKDOWN_DAYS_MAX) return null;
  const generatedMs = Date.parse(value.generatedAt);
  // Keep the publication's actual dates; only the server can invalidate its
  // source. An ordinary refresh does not expire a previously published graph.
  if (!Number.isFinite(generatedMs) || new Date(generatedMs).toISOString() !== value.generatedAt
      || generatedMs > nowMs + 5 * 60 * 1000) return null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const generatedDay = value.generatedAt.slice(0, 10);
  const earliestDay = new Date(Date.parse(`${generatedDay}T00:00:00.000Z`)
    - 69 * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
  const allowedDays = new Set(publishedDays);
  const days = [];
  const isCurrent = value.schemaVersion === "community-allowance-breakdowns-v1.2";
  if (value.modelBasis !== (isCurrent ? COMMUNITY_ALLOWANCE_MODEL_BASIS : LEGACY_COMMUNITY_ALLOWANCE_MODEL_BASIS)
      || value.basis !== (isCurrent ? COMMUNITY_ALLOWANCE_BASIS : LEGACY_COMMUNITY_ALLOWANCE_BASIS)
      || value.normalization !== (isCurrent ? COMMUNITY_ALLOWANCE_NORMALIZATION : LEGACY_COMMUNITY_ALLOWANCE_NORMALIZATION)) return null;
  const planIds = isCurrent ? PUBLIC_ALLOWANCE_PLAN_IDS : LEGACY_PUBLIC_ALLOWANCE_PLAN_IDS;
  const hasCombined = value.schemaVersion === COMMUNITY_ALLOWANCE_BREAKDOWN_COMBINED_VERSION
    || value.schemaVersion === COMMUNITY_ALLOWANCE_BREAKDOWN_MODEL_METADATA_VERSION || isCurrent;
  // A malformed block is ignored whole and reported, never partly trusted: the
  // page then draws exactly what it would have drawn without one.
  const metadata = hasMetadataBlock ? publicModelMetadata(value.modelConfig) : null;
  const modelMetadata = !hasMetadataBlock ? "absent" : metadata === null ? "rejected" : "applied";
  const modelConfig = chartedModelsWith([...(metadata ?? [])].map(
    ([modelId, entry]) => ({ modelId, ...entry })));
  const knownModelIds = new Set([...PUBLIC_ALLOWANCE_MODELS.known, ...modelConfig.map(model => model.modelId)]);
  let unrecognizedModelTuples = 0;
  const unrecognizedModelIds = new Set();
  for (const row of value.days) {
    if (!exactObject(row, hasCombined ? ["day", "combined", "byPlanType", "models"] : ["day", "byPlanType", "models"]) || !publicDay(row.day)
        || !allowedDays.has(row.day) || row.day < earliestDay || row.day >= today || row.day >= generatedDay
        || (days.length > 0 && row.day <= days.at(-1).day)
        || !exactObject(row.byPlanType, planIds)
        || !Array.isArray(row.models) || row.models.length > PUBLIC_BREAKDOWN_MODELS_PER_DAY_MAX) return null;
    const byPlanType = {};
    for (const id of planIds) {
      const summary = publicAllowanceSummary(row.byPlanType[id]);
      if (summary === null) return null;
      byPlanType[id] = summary;
    }
    const models = [];
    const seen = new Set();
    for (const tuple of row.models) {
      // The shape and numbers are validated for every tuple, known or not. Only
      // the identity is tolerant, and only to the extent of leaving the tuple out.
      if (!Array.isArray(tuple) || tuple.length !== 3 || typeof tuple[0] !== "string"
          || !publicDollars(tuple[1]) || !publicCount(tuple[2]) || tuple[2] < 1) return null;
      const known = knownModelIds.has(tuple[0]);
      // An identity this page does not know may be skipped, but only if it is
      // shaped like a model id at all. A reviewed identity kept off the primary
      // comparison is not "newer than this page": it is a producer fault.
      if (!known && (!PUBLIC_MODEL_ID_PATTERN.test(tuple[0])
          || PUBLIC_MODEL_CATALOG_EXCLUDED_IDS.has(tuple[0]))) return null;
      // One tuple per model per day, known or not.
      if (seen.has(tuple[0])) return null;
      seen.add(tuple[0]);
      if (!known) {
        unrecognizedModelTuples += 1;
        unrecognizedModelIds.add(tuple[0]);
        continue;
      }
      models.push([tuple[0], tuple[1], tuple[2]]);
    }
    const combined = hasCombined ? publicAllowanceSummary(row.combined) : null;
    if (hasCombined && combined === null) return null;
    days.push({ day: row.day, ...(hasCombined ? { combined } : {}), byPlanType, models });
  }
  // A stored copy's projection never keeps a skipped tuple, so a copy that
  // both carries a count and still holds one contradicts itself: refuse it.
  if (carried !== null && unrecognizedModelTuples > 0) return null;
  return {
    generatedAt: value.generatedAt, hasCombined, isCurrent, normalization: value.normalization, planIds,
    modelConfig, days,
    // Counts only. An unrecognized id is dropped before it reaches this value.
    unrecognizedModelTuples: unrecognizedModelTuples + (carried?.tuples ?? 0),
    unrecognizedModelCount: unrecognizedModelIds.size + (carried?.models ?? 0),
    modelMetadata,
  };
}

function normalizedDailyAllowance(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const isCurrent = candidate.basis === COMMUNITY_ALLOWANCE_BASIS
    && candidate.normalization === COMMUNITY_ALLOWANCE_NORMALIZATION;
  const isLegacy = candidate.basis === LEGACY_COMMUNITY_ALLOWANCE_BASIS
    && candidate.normalization === LEGACY_COMMUNITY_ALLOWANCE_NORMALIZATION;
  if ((!isCurrent && !isLegacy)
      || candidate.referencePlanType !== COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE) {
    return null;
  }
  const fitCount = finite(candidate.fitCount, null);
  const participantCount = finite(candidate.participantCount, null);
  if (!Number.isSafeInteger(fitCount)
      || fitCount < 0
      || !Number.isSafeInteger(participantCount)
      || participantCount < 0
      || (fitCount === 0) !== (participantCount === 0)) {
    return null;
  }
  if (fitCount === 0) {
    if (candidate.centralUsd !== null || candidate.band80Usd !== null) {
      return null;
    }
    return { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
  }
  const centralUsd = finite(candidate.centralUsd, null);
  if (centralUsd === null || centralUsd <= 0) return null;
  let band80Usd = null;
  if (candidate.band80Usd !== null && candidate.band80Usd !== undefined) {
    const raw = candidate.band80Usd;
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    const lowerUsd = finite(raw.lowerUsd, null);
    const upperUsd = finite(raw.upperUsd, null);
    if (lowerUsd === null
        || upperUsd === null
        || lowerUsd <= 0
        || upperUsd < lowerUsd) {
      return null;
    }
    band80Usd = { lowerUsd, upperUsd };
  }
  return { fitCount, participantCount, centralUsd, band80Usd };
}

function normalizedDailyTotals(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const totals = {};
  for (const field of COMMUNITY_DAILY_TOTAL_FIELDS) {
    const value = finite(candidate[field], null);
    if (value === null || !Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    totals[field] = value;
  }
  return totals;
}

export const COMMUNITY_DAILY_SPEND_BASIS = "reported_usage_event_time_api_price_equivalent_v1";

function normalizedDailySpend(candidate, usageEvents) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || candidate.basis !== COMMUNITY_DAILY_SPEND_BASIS || candidate.currency !== "USD"
      || typeof candidate.pricingMethodVersion !== "string"
      || !/^server-api-price-equivalent-v\d+\.\d+$/u.test(candidate.pricingMethodVersion)
      || typeof candidate.registrySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.registrySha256)) return null;
  const unprocessed = candidate.unprocessedUsageEvents ?? 0;
  const counts = [candidate.usageEvents, candidate.fullyPricedUsageEvents,
    candidate.partiallyPricedUsageEvents, candidate.unpricedUsageEvents, unprocessed];
  if (!counts.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const [events, full, partial, unpriced] = counts;
  if (events !== usageEvents || full + partial + unpriced + unprocessed !== events) return null;
  const resourceLimited = unprocessed > 0;
  if (resourceLimited && (unprocessed !== events || candidate.unavailableReason !== "processing_capacity_exceeded"
      || typeof candidate.processingPolicyVersion !== "string"
      || !/^daily-spend-capacity-[1-9]\d{0,5}-chunks-[1-9]\d{0,8}-events$/u.test(candidate.processingPolicyVersion))) return null;
  if (!resourceLimited && (candidate.unavailableReason !== undefined || candidate.processingPolicyVersion !== undefined)) return null;
  const known = events === 0 || full + partial > 0;
  const coverage = !known ? "unavailable" : full === events ? "complete" : "partial";
  if (candidate.coverage !== coverage || (known
    ? typeof candidate.knownCostUsd !== "number" || !Number.isFinite(candidate.knownCostUsd)
      || candidate.knownCostUsd < 0 || (events === 0 && candidate.knownCostUsd !== 0)
    : candidate.knownCostUsd !== null)) return null;
  // Fresh allowlist: neither unknown fields nor private diagnostics reach UI.
  return {
    basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd: candidate.knownCostUsd, coverage,
    usageEvents: events, fullyPricedUsageEvents: full, partiallyPricedUsageEvents: partial, unpricedUsageEvents: unpriced,
    pricingMethodVersion: candidate.pricingMethodVersion, registrySha256: candidate.registrySha256,
    ...(resourceLimited ? { unprocessedUsageEvents: unprocessed, unavailableReason: "processing_capacity_exceeded",
      processingPolicyVersion: candidate.processingPolicyVersion } : {}),
  };
}

// The community cache-retention lane. It is additive and optional: the key is
// absent until the lane publishes, so an older cached response must stay
// renderable rather than degrade the whole series.
export const COMMUNITY_CACHE_RETENTION_SCHEMA_VERSION = "community-cache-retention-v1.0";
const COMMUNITY_CACHE_RETENTION_METRIC = "cache_retention_by_pause";
const COMMUNITY_CACHE_RETENTION_MEASURES = "consecutive_requests";
// The gap basis is a load-bearing claim, not a label. The browser's caveat —
// that a response-end-to-response-end gap overstates the real idle pause by
// the later request's own duration — is only true for this basis, so any
// other basis must reject rather than inherit the sentence.
const COMMUNITY_CACHE_RETENTION_GAP_BASIS = "response_end_to_response_end";
const COMMUNITY_CACHE_RETENTION_METHOD_PATTERN = /^cache-retention-v[1-9]\d{0,2}$/u;

/**
 * Exactly ten ordered bands, always all ten, even with no evidence. Each
 * band's `endMs` is the next band's `startMs`. The final band is CLOSED, not
 * open-ended: the lane's lookback is seven days, so a gap longer than that is
 * not measured at all rather than counted here.
 */
export const COMMUNITY_CACHE_RETENTION_BANDS = Object.freeze([
  Object.freeze({ band: "under_one_minute", startMs: 0, endMs: 60_000 }),
  Object.freeze({ band: "one_to_two_minutes", startMs: 60_000, endMs: 120_000 }),
  Object.freeze({ band: "two_to_five_minutes", startMs: 120_000, endMs: 300_000 }),
  Object.freeze({ band: "five_to_ten_minutes", startMs: 300_000, endMs: 600_000 }),
  Object.freeze({ band: "ten_to_thirty_minutes", startMs: 600_000, endMs: 1_800_000 }),
  Object.freeze({ band: "thirty_minutes_to_one_hour", startMs: 1_800_000, endMs: 3_600_000 }),
  Object.freeze({ band: "one_to_two_hours", startMs: 3_600_000, endMs: 7_200_000 }),
  Object.freeze({ band: "two_to_six_hours", startMs: 7_200_000, endMs: 21_600_000 }),
  Object.freeze({ band: "six_to_twenty_four_hours", startMs: 21_600_000, endMs: 86_400_000 }),
  // 24 hours to SEVEN DAYS, not "24 hours and up". The worker's
  // `MAXIMUM_GAP_MS` is `lookbackDays * 86_400_000`, and a longer gap falls
  // outside the lens entirely.
  Object.freeze({ band: "over_twenty_four_hours", startMs: 86_400_000, endMs: 604_800_000 }),
]);

// Counters for evidence the lane deliberately did not measure. They qualify
// every rate above them, so they are carried, never dropped.
const COMMUNITY_CACHE_RETENTION_EXCLUSION_FIELDS = Object.freeze([
  "excludedInsufficientEvidence",
  "excludedContextContracted",
  "unorderedTies",
]);

const COMMUNITY_CACHE_RETENTION_RATE_FIELDS = Object.freeze([
  "reusedMoreThanHalfRate",
  "matchedOrExceededRate",
]);

function normalizedCacheRetentionBand(candidate, expected) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  // Every boundary is exact, the last one included. Accepting a null there
  // would admit a payload claiming an unbounded band, which the lane cannot
  // produce and which would overstate what the curve covers.
  if (candidate.band !== expected.band
      || candidate.startMs !== expected.startMs
      || candidate.endMs !== expected.endMs) {
    return null;
  }
  const counts = [
    candidate.adjacencies,
    candidate.sessions,
    candidate.contributors,
    ...COMMUNITY_CACHE_RETENTION_EXCLUSION_FIELDS.map((field) => candidate[field]),
  ];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return null;
  }
  const [adjacencies, sessions, contributors] = counts;
  // An empty band is published with explicit nulls: "no gap was measured" and
  // "the cache was not reused" are different claims. Where gaps were measured,
  // they came from at least one session, and distinct participants cannot
  // outnumber the sessions they fed.
  if (adjacencies === 0
    ? sessions !== 0 || contributors !== 0
    : sessions < 1 || contributors < 1 || contributors > sessions) {
    return null;
  }
  const rates = {};
  for (const field of COMMUNITY_CACHE_RETENTION_RATE_FIELDS) {
    const value = candidate[field];
    if (adjacencies === 0) {
      if (value !== null) return null;
      rates[field] = null;
      continue;
    }
    if (typeof value !== "number"
        || !Number.isFinite(value)
        || value < 0
        || value > 1) {
      return null;
    }
    rates[field] = value;
  }
  // The largest single share of a band cannot exist without a contributor and
  // cannot be zero, but the lane may decline to publish it at all.
  const topContributorShare = candidate.topContributorShare;
  if (topContributorShare !== null
      && (contributors === 0
        || typeof topContributorShare !== "number"
        || !Number.isFinite(topContributorShare)
        || topContributorShare <= 0
        || topContributorShare > 1)) {
    return null;
  }
  return {
    band: expected.band,
    startMs: expected.startMs,
    endMs: expected.endMs,
    adjacencies,
    sessions,
    contributors,
    ...rates,
    topContributorShare,
    ...Object.fromEntries(COMMUNITY_CACHE_RETENTION_EXCLUSION_FIELDS
      .map((field) => [field, candidate[field]])),
  };
}

/**
 * Normalizes the optional cache-retention block into a closed, render-safe
 * shape. Unknown fields never reach the UI, and a block that disagrees with
 * the published contract in any way is refused whole: a partially trusted
 * retention claim is worse than none.
 */
function normalizedCacheRetention(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.schemaVersion !== COMMUNITY_CACHE_RETENTION_SCHEMA_VERSION
      || value.metric !== COMMUNITY_CACHE_RETENTION_METRIC
      || value.measures !== COMMUNITY_CACHE_RETENTION_MEASURES
      || value.gapBasis !== COMMUNITY_CACHE_RETENTION_GAP_BASIS
      || typeof value.methodVersion !== "string"
      || !COMMUNITY_CACHE_RETENTION_METHOD_PATTERN.test(value.methodVersion)
      || !Array.isArray(value.bands)
      || value.bands.length !== COMMUNITY_CACHE_RETENTION_BANDS.length) {
    return null;
  }
  const bands = [];
  for (const [index, expected] of COMMUNITY_CACHE_RETENTION_BANDS.entries()) {
    const band = normalizedCacheRetentionBand(value.bands[index], expected);
    if (band === null) return null;
    bands.push(band);
  }
  return {
    schemaVersion: COMMUNITY_CACHE_RETENTION_SCHEMA_VERSION,
    metric: COMMUNITY_CACHE_RETENTION_METRIC,
    methodVersion: value.methodVersion,
    measures: COMMUNITY_CACHE_RETENTION_MEASURES,
    gapBasis: COMMUNITY_CACHE_RETENTION_GAP_BASIS,
    bands,
  };
}

function normalizedDailyDay(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const day = dayString(candidate.day);
  const revision = finite(candidate.revision, null);
  const releasedAt = text(candidate.releasedAt, "");
  const payload = candidate.payload;
  if (day === null
      || !Number.isSafeInteger(revision)
      || revision < 1
      || releasedAt === ""
      || !payload
      || typeof payload !== "object"
      || Array.isArray(payload)) {
    return null;
  }
  // The per-day payload is the immutable published revision. The read wrapper
  // repeats day/revision; a disagreement means the response cannot be trusted.
  if (payload.schemaVersion !== COMMUNITY_DAILY_AGGREGATE_SCHEMA_VERSION
      || payload.policyVersion !== COMMUNITY_DAILY_POLICY_VERSION
      || payload.immutableRevision !== true
      || payload.recomputesOnLateData !== true
      || payload.day !== day
      || payload.revision !== revision) {
    return null;
  }
  const totals = normalizedDailyTotals(payload.totals);
  if (totals === null) return null;
  return {
    day,
    revision,
    releasedAt,
    totals,
    allowance: normalizedDailyAllowance(payload.allowance),
    apiEquivalentSpend: normalizedDailySpend(payload.apiEquivalentSpend, totals.usageEvents),
  };
}

/**
 * Normalizes one /community/daily response into a closed, render-safe shape.
 * Anything the page would have to guess about — schema drift, invalid days,
 * out-of-order series — collapses to `unsupported_schema` rather than a
 * partially trusted render.
 */
export function normalizeCommunityDailySeries(payload, { nowMs = Date.now(), retained = false } = {}) {
  if (!payload) return { state: "service_unavailable", days: [] };
  const from = dayString(payload.from);
  const to = dayString(payload.to);
  if (payload.schemaVersion !== COMMUNITY_DAILY_READ_SCHEMA_VERSION
      || from === null
      || to === null
      || !["ready", "updating"].includes(payload.allowanceState)
      || (payload.allowanceReadState !== undefined
        && !["confirmed", "temporarily_unavailable"].includes(payload.allowanceReadState))
      || !Array.isArray(payload.days)
      || payload.days.length > COMMUNITY_DAILY_WINDOW_DAYS) {
    return { state: "unsupported_schema", days: [] };
  }
  const days = [];
  const allowanceBases = new Set();
  for (const candidate of payload.days) {
    const normalized = normalizedDailyDay(candidate);
    if (normalized === null
        || normalized.day < from
        || normalized.day > to
        || (days.length > 0 && normalized.day <= days[days.length - 1].day)) {
      return { state: "unsupported_schema", days: [] };
    }
    if (normalized.allowance !== null) allowanceBases.add(candidate.payload.allowance.basis);
    days.push(normalized);
  }
  // A response spanning the basis cutover cannot connect old and new
  // allowance estimates into one line. Activity remains independently valid.
  if (allowanceBases.size > 1) {
    for (const day of days) day.allowance = null;
  }
  const allowanceIsCurrent = allowanceBases.size === 1
    && allowanceBases.has(COMMUNITY_ALLOWANCE_BASIS);
  return {
    state: days.length === 0 ? "none_published" : "published",
    from,
    to,
    allowanceState: payload.allowanceState,
    allowanceIsCurrent,
    breakdowns: payload.allowanceState === "ready"
      ? normalizePublicAllowanceBreakdowns(payload.allowanceBreakdowns, days.map(day => day.day), nowMs, { retained }) : null,
    // Community-wide, not per-day: the lane measures gaps between consecutive
    // requests across the whole published window.
    cacheRetention: normalizedCacheRetention(payload.cacheRetention),
    days,
  };
}

// Everything this reader must still agree with before a payload retained by
// an earlier visit may be rendered under today's meanings. Every published
// contract version and method claim the daily series depends on is folded in,
// so widening any one of them refuses the previous deploy's cache instead of
// reinterpreting it.
export const COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY = [
  COMMUNITY_DAILY_READ_SCHEMA_VERSION,
  COMMUNITY_DAILY_AGGREGATE_SCHEMA_VERSION,
  COMMUNITY_DAILY_POLICY_VERSION,
  COMMUNITY_ALLOWANCE_BASIS,
  COMMUNITY_ALLOWANCE_NORMALIZATION,
  COMMUNITY_DAILY_SPEND_BASIS,
  ...COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS,
].join("|");

function cachedAllowanceBlock(allowance, isCurrent) {
  if (allowance === null) return null;
  return {
    basis: isCurrent ? COMMUNITY_ALLOWANCE_BASIS : LEGACY_COMMUNITY_ALLOWANCE_BASIS,
    referencePlanType: COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE,
    normalization: isCurrent ? COMMUNITY_ALLOWANCE_NORMALIZATION : LEGACY_COMMUNITY_ALLOWANCE_NORMALIZATION,
    fitCount: allowance.fitCount,
    participantCount: allowance.participantCount,
    centralUsd: allowance.centralUsd,
    band80Usd: allowance.band80Usd === null
      ? null
      : { lowerUsd: allowance.band80Usd.lowerUsd, upperUsd: allowance.band80Usd.upperUsd },
  };
}

function cachedBreakdowns(breakdowns) {
  return {
    schemaVersion: breakdowns.isCurrent
      ? COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS[2]
      : breakdowns.hasCombined
        ? COMMUNITY_ALLOWANCE_BREAKDOWN_COMBINED_VERSION
        : COMMUNITY_ALLOWANCE_BREAKDOWN_SCHEMA_VERSIONS[0],
    basis: breakdowns.isCurrent ? COMMUNITY_ALLOWANCE_BASIS : LEGACY_COMMUNITY_ALLOWANCE_BASIS,
    referencePlanType: COMMUNITY_ALLOWANCE_REFERENCE_PLAN_TYPE,
    normalization: breakdowns.isCurrent ? COMMUNITY_ALLOWANCE_NORMALIZATION : LEGACY_COMMUNITY_ALLOWANCE_NORMALIZATION,
    modelBasis: breakdowns.isCurrent ? COMMUNITY_ALLOWANCE_MODEL_BASIS : LEGACY_COMMUNITY_ALLOWANCE_MODEL_BASIS,
    modelGate: COMMUNITY_ALLOWANCE_MODEL_GATE,
    generatedAt: breakdowns.generatedAt,
    // This build's reviewed catalog is not published data, so it is never
    // stored: the reader supplies it again on the way back out. A published
    // metadata block IS data the stored tuples depend on (a model only it
    // names would otherwise be dropped on the way back in), so exactly the
    // entries it supplied are rebuilt, in the closed wire shape.
    ...(breakdowns.modelMetadata === "applied" ? {
      modelConfig: breakdowns.modelConfig.filter(model => model.order !== undefined)
        .map(model => ({ id: model.modelId, label: model.label, family: model.family, order: model.order })),
    } : {}),
    // Tuples this page could not name are left out above, and the gap is not:
    // two content-free integers keep a cached render saying what the live one
    // said. Absent when nothing was left out.
    ...(breakdowns.unrecognizedModelTuples > 0 ? {
      retainedUnrecognizedModels: {
        tuples: breakdowns.unrecognizedModelTuples, models: breakdowns.unrecognizedModelCount,
      },
    } : {}),
    days: breakdowns.days.map(row => ({
      day: row.day,
      ...(breakdowns.hasCombined ? { combined: row.combined } : {}),
      byPlanType: row.byPlanType,
      models: row.models,
    })),
  };
}

function cachedDay(day, allowanceIsCurrent) {
  return {
    day: day.day,
    revision: day.revision,
    releasedAt: day.releasedAt,
    payload: {
      schemaVersion: COMMUNITY_DAILY_AGGREGATE_SCHEMA_VERSION,
      policyVersion: COMMUNITY_DAILY_POLICY_VERSION,
      immutableRevision: true,
      recomputesOnLateData: true,
      day: day.day,
      revision: day.revision,
      totals: day.totals,
      allowance: cachedAllowanceBlock(day.allowance, allowanceIsCurrent),
      ...(day.apiEquivalentSpend === null
        ? {}
        : { apiEquivalentSpend: day.apiEquivalentSpend }),
    },
  };
}

/**
 * The storable form of one /community/daily response: the wire shape rebuilt
 * from the normalized value and from this module's own contract constants,
 * and nothing else.
 *
 * Rebuilding rather than copying is the point. The normalizer's output is a
 * closed shape, so no unknown upstream field, private diagnostic or
 * unvalidated block can reach storage by construction — only figures this
 * page would have rendered. A block the normalizer declined, such as an
 * allowance breakdown that failed its checks, is absent here exactly as it
 * was absent from the render; it is never repaired or filled in.
 *
 * The result re-normalizes (as retained) to the same series the original did,
 * which is what makes a cached render identical to the live one rather than a
 * second, looser interpretation. That includes the gap: tuples for models this
 * page could not name are never stored, but how many were left out is, as two
 * integers, so a cached render states the same omission a live one does. Re-normalizing later only ever gets stricter: the
 * breakdown checks that depend on the current day move against acceptance,
 * never towards it, so time cannot promote a refused payload.
 *
 * Returns null for anything this reader could not honestly interpret, which
 * the cache treats as a refusal to store.
 */
export function projectCommunityDailyPayloadForCache(payload, { nowMs = Date.now() } = {}) {
  const series = normalizeCommunityDailySeries(payload, { nowMs });
  if (series.state !== "published" && series.state !== "none_published") return null;
  // Validated by the normalizer above, but not carried on its result, and the
  // public site reads it to keep an activity-only answer from being mistaken
  // for a withdrawn allowance.
  const readState = payload?.allowanceReadState;
  return {
    schemaVersion: COMMUNITY_DAILY_READ_SCHEMA_VERSION,
    from: series.from,
    to: series.to,
    allowanceState: series.allowanceState,
    ...(readState === "confirmed" || readState === "temporarily_unavailable"
      ? { allowanceReadState: readState }
      : {}),
    ...(series.breakdowns === null
      ? {}
      : { allowanceBreakdowns: cachedBreakdowns(series.breakdowns) }),
    days: series.days.map(day => cachedDay(day, series.allowanceIsCurrent)),
  };
}

async function readPublicJson(fetchImpl, path, signal) {
  const response = await fetchImpl(path, {
    headers: { Accept: "application/json" },
    cache: "no-cache",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(`Request failed (${response.status}).`);
    error.status = response.status;
    const code = payload?.error?.code;
    const requestId = payload?.error?.requestId;
    if (typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code)) {
      error.code = code;
    }
    if (typeof requestId === "string"
        && SERVICE_REQUEST_ID_PATTERN.test(requestId)) {
      error.requestId = requestId;
    }
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function fetchCommunityDaily(fetchImpl, nowMs, signal) {
  const { from, to } = communityDailyWindow(nowMs);
  return readPublicJson(
    fetchImpl,
    `${COMMUNITY_ROOT}/community/daily?from=${from}&to=${to}`,
    signal,
  );
}

export class PublicCommunityClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("Public community fetch implementation must be a function.");
    }
    this.fetchImpl = fetchImpl;
  }

  communityDaily({ nowMs = Date.now(), signal } = {}) {
    const fetchImpl = this.fetchImpl;
    return fetchCommunityDaily(fetchImpl, nowMs, signal);
  }
}
