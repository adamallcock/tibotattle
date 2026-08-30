import {
  addUsdStrings,
  emptySpeedWeightingCrossing,
  FAST_MODE_MODEL_FAMILY_KEYS,
  fastModeModelFamilyKey,
  OBSERVED_SPEED_MODE_KEYS,
  priceCodexUsageEvent,
} from "@app-usagemonitor/accounting";
import {
  isValidQuotaWindowDuration,
  sanitizeQuotaLimitDisplayName,
  sanitizeQuotaLimitId,
} from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  codexModelAllowanceTrack,
  codexModelApiPriceEquivalentApplicable,
  codexModelPricingStatus,
  OPENAI_CODEX_SPARK_MODEL_ID,
  recognizedCodexModelId,
} from "./export/index.js";

// The companion's usage-accounting projection model, shared verbatim between
// its two evidence sources: the bounded recent collector state and the unified
// local index. One definition of a period, a timeline bucket and a projected
// usage event is what keeps the two sources comparable figure-for-figure —
// any parity diff between them is then a difference in evidence, never a
// difference in arithmetic.

export const COMPONENT_KEYS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
]);

// Model identity is owned by the reviewed export registry so that the live
// collector projection, the replay-safe cache and the indexed archive cannot
// drift apart and disagree about what counts as recognised.
const SPARK_MODEL = OPENAI_CODEX_SPARK_MODEL_ID;

export const KNOWN_SPEEDS = new Set(["standard", "fast", "flex", "batch", "unknown"]);
export const KNOWN_API_TIERS = new Set(["standard", "priority", "flex", "batch", "unknown"]);
export const KNOWN_SURFACES = new Set([
  "extension_or_ide",
  "scheduled_task",
  "subagent",
  "cli_exec",
  "work",
  "workspace_agent",
  "excel",
  "voice_task",
  "unknown",
]);
export const KNOWN_AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
export const KNOWN_LINEAGE = new Set(["standalone", "forked", "parent_linked", "unknown"]);
export const KNOWN_TOOL_CLASSES = new Set(["apply_patch", "local_shell", "other", "subagent", "tool_gateway"]);
export const KNOWN_LIMITS = new Set(["codex", "codex_bengalfox", "codex-spark"]);
// The Spark allowance's provider limit id as it actually occurs in rollout
// logs and the unified index ("codex_bengalfox", first because it is the only
// one observed to date), plus the marketing token ("codex-spark") the export
// registry reserves in case the provider stabilizes on it later. Querying
// only the marketing token left the sparkQuota series permanently empty.
export const SPARK_QUOTA_LIMIT_IDS = Object.freeze([
  "codex_bengalfox",
  "codex-spark",
]);
export const KNOWN_PLANS = new Set(TELEMETRY_PLAN_TYPES);
export const KNOWN_SLOTS = new Set(["primary", "secondary"]);
export const TIMELINE_BUCKET_MS = 15 * 60 * 1_000;
export const MAX_QUOTA_TIMELINE_POINTS = 10_000;
const MAX_DATASET_ROWS = 2_500;

export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function quotaResetIsoInstant(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  try {
    return new Date(value * 1_000).toISOString();
  } catch {
    return null;
  }
}

export function deterministicSample(rows, maximum = MAX_DATASET_ROWS) {
  if (rows.length <= maximum) return rows;
  if (maximum <= 0) return [];
  if (maximum === 1) return [rows[0]];
  const sampled = [];
  const last = rows.length - 1;
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(rows[Math.round((index * last) / (maximum - 1))]);
  }
  return sampled;
}

function quotaTimelineTrackKey(row) {
  return `${row.limitId}:${row.durationMinutes ?? "unknown"}`;
}

function quotaTimelineOrderCompare(left, right) {
  return left.observedEpochMs - right.observedEpochMs
    || left.row.limitId.localeCompare(right.row.limitId)
    || left.row.durationMinutes - right.row.durationMinutes
    || left.row.slot.localeCompare(right.row.slot)
    || left.row.planType.localeCompare(right.row.planType)
    || left.row.usedPercent - right.row.usedPercent;
}

/**
 * Thin a quota series to the payload ceiling without letting one dense track
 * starve another. Sampling the combined series by row index looked uniform
 * but was not: a consumer that then filters to one track (weekly versus
 * five-hour) inherits whatever uneven residue of that track survived the
 * combined thinning — measured as whole recent days losing every usable
 * calibration window. Each track is therefore thinned independently under a
 * fair share of the same total ceiling: tracks that fit keep every row and
 * their surplus flows to the dense tracks, so the overall payload bound (and
 * the size rationale behind it) is preserved exactly.
 */
export function sampleQuotaTimelineByTrack(rows, maximum = MAX_QUOTA_TIMELINE_POINTS) {
  if (rows.length <= maximum) return rows;
  const tracks = new Map();
  for (const row of rows) {
    const key = quotaTimelineTrackKey(row);
    const group = tracks.get(key) ?? [];
    group.push(row);
    tracks.set(key, group);
  }
  const groups = [...tracks.entries()]
    .sort((left, right) => (
      left[1].length - right[1].length || left[0].localeCompare(right[0])
    ))
    .map(([, group]) => group);
  let remaining = maximum;
  let tracksLeft = groups.length;
  const sampled = [];
  for (const group of groups) {
    const budget = Math.max(1, Math.floor(remaining / tracksLeft));
    const take = Math.min(group.length, budget);
    sampled.push(...deterministicSample(group, take));
    remaining -= take;
    tracksLeft -= 1;
  }
  return sampled
    .map((row) => ({ row, observedEpochMs: Date.parse(row.observedAt) }))
    .sort(quotaTimelineOrderCompare)
    .map(({ row }) => row);
}

export function emptyComponents() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0]));
}

export function addComponents(target, components) {
  if (!components || typeof components !== "object" || Array.isArray(components)) return;
  for (const key of COMPONENT_KEYS) {
    const value = components[key];
    if (Number.isSafeInteger(value) && value >= 0) target[key] += value;
  }
}

export function emptyComponentCosts() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [
    key,
    {
      tokens: 0,
      pricedTokens: 0,
      unpricedTokens: 0,
      costUsd: 0,
    },
  ]));
}

/**
 * Add one event's per-component priced amounts.
 *
 * Tokens are counted whether or not they carried a price, and the priced and
 * unpriced counts are kept apart, so a component that was never priced stays
 * visible as unpriced rather than collapsing into a priced zero. Shared with
 * the replay-safe cache so both accounting sources add money up identically —
 * a difference between them must be a difference in evidence, never in
 * arithmetic.
 */
export function addComponentCosts(target, components, priced) {
  const pricedByName = new Map(
    (Array.isArray(priced?.components) ? priced.components : [])
      .map((row) => [row.name, row]),
  );
  for (const key of COMPONENT_KEYS) {
    const tokens = components[key] ?? 0;
    const row = target[key];
    const pricedRow = pricedByName.get(key);
    row.tokens += tokens;
    if (pricedRow?.pricingStatus === "priced") {
      row.pricedTokens += tokens;
      const cost = Number(pricedRow.costUsd);
      if (Number.isFinite(cost) && cost >= 0) row.costUsd += cost;
    } else {
      row.unpricedTokens += tokens;
    }
  }
}

export function safeModel(model) {
  return recognizedCodexModelId(model) ?? "unknown";
}

function modelPricingStatus(model) {
  return codexModelPricingStatus(model);
}

export function safeSpeed(speed) {
  return KNOWN_SPEEDS.has(speed) ? speed : "unknown";
}

export function safeEnum(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

export function emptyDimension(keys) {
  return Object.fromEntries([...keys].map((key) => [
    key,
    { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
  ]));
}

export function usageProjection(record, declaredSpeed = "unknown", pricer = null) {
  const components = emptyComponents();
  addComponents(components, record.components);
  if (components.output_combined_tokens > 0
      && components.output_text_tokens + components.output_reasoning_tokens > 0) {
    components.output_combined_tokens = 0;
  }
  const totalTokens = components.input_uncached_tokens
    + components.input_cache_read_tokens
    + components.input_cache_write_tokens
    + (components.output_combined_tokens > 0
      ? components.output_combined_tokens
      : components.output_text_tokens + components.output_reasoning_tokens);
  if (totalTokens === 0) return null;
  const model = safeModel(record.model);
  let priced;
  try {
    // A caller iterating a large store passes a memoized pricer (the same one
    // the replay-safe cache accounts with); it falls back to the full pricer
    // whenever its per-(model, band, date) plan cannot be proven exact, so
    // the figures are identical either way — only the wall time differs.
    priced = pricer !== null
      ? pricer({ timestamp: record.observedAt, model }, components)
      : priceCodexUsageEvent({
        timestamp: record.observedAt,
        model,
        components,
      }, {
        // Subscription speed and the API billing tier are separate concepts.
        // Standard is the explicit counterfactual until an API tier is
        // observed.
        apiServiceTier: "standard",
        priceEpochBasis: "event_time",
      });
  } catch {
    priced = { totalUsd: "0", coverageStatus: "unpriced" };
  }
  const rawCost = Number(priced.totalUsd);
  const priceCardIds = Array.isArray(priced.selectedPriceCardIds)
    ? [...new Set(priced.selectedPriceCardIds.filter((id) => (
      typeof id === "string" && id.length > 0 && id.length <= 128
    )))].sort()
    : [];
  const priceCardBreakdown = Array.isArray(priced.priceCardBreakdown)
    ? priced.priceCardBreakdown.filter((item) => (
      item
      && typeof item === "object"
      && typeof item.priceCardId === "string"
      && item.priceCardId.length > 0
      && item.priceCardId.length <= 128
      && Number.isSafeInteger(item.events)
      && item.events >= 0
      && typeof item.costUsd === "string"
      && /^\d+(?:\.\d+)?$/u.test(item.costUsd)
    ))
    : [];
  // The per-component priced breakdown, kept only where the pricer said the
  // component was actually priced. Without it this projection could report a
  // model's tokens by component but never its money by component, so the
  // companion's own accounting could not answer the question the replay-safe
  // cache already answers.
  const pricedComponents = Array.isArray(priced.components)
    ? priced.components.filter((item) => (
      item
      && typeof item === "object"
      && typeof item.name === "string"
      && item.pricingStatus === "priced"
      && typeof item.costUsd === "string"
      && /^\d+(?:\.\d+)?$/u.test(item.costUsd)
    )).map((item) => ({
      name: item.name,
      pricingStatus: "priced",
      costUsd: item.costUsd,
    }))
    : [];
  return {
    model,
    modelPricingStatus: modelPricingStatus(record.model),
    modelAllowanceTrack: codexModelAllowanceTrack(record.model),
    modelApiPriceEquivalentApplicable:
      codexModelApiPriceEquivalentApplicable(record.model),
    isSpark: model === SPARK_MODEL,
    components,
    totalTokens,
    apiPriceEquivalentUsd: Number.isFinite(rawCost) ? rawCost : 0,
    apiPriceEquivalentUsdExact: ["fully_priced", "partially_priced"].includes(
      priced.coverageStatus,
    ) && typeof priced.totalUsd === "string"
        && /^\d+(?:\.\d+)?$/u.test(priced.totalUsd)
      ? priced.totalUsd
      : null,
    priceCardIds,
    priceCardBreakdown,
    pricedComponents,
    pricingCoverageStatus: ["fully_priced", "partially_priced"].includes(priced.coverageStatus)
      ? priced.coverageStatus
      : "unpriced",
    speed: safeSpeed(record.tierSemantics?.codexSpeedMode),
    declaredSpeed,
    apiServiceTier: safeEnum(record.tierSemantics?.apiServiceTier, KNOWN_API_TIERS),
    surface: safeEnum(record.surfaceClassification?.surface, KNOWN_SURFACES),
    agentScope: safeEnum(record.surfaceClassification?.agentScope, KNOWN_AGENT_SCOPES),
    lineage: safeEnum(record.surfaceClassification?.lineageDisposition, KNOWN_LINEAGE),
    reasoningEffort: "unknown",
    accountAttribution: record.accountScope?.status === "available"
      ? "attributed_pseudonymous"
      : "unattributed",
  };
}

export function newUsagePeriod(id, label, { includeSpark = true } = {}) {
  const period = {
    id,
    label,
    events: 0,
    totalTokens: 0,
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
    apiPriceEquivalentUsd: 0,
    apiPriceEquivalentUsdExact: null,
    priceCardIds: [],
    priceCardBreakdown: {},
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
    byModel: {},
    bySpeed: emptyDimension(KNOWN_SPEEDS),
    byApiServiceTier: emptyDimension(KNOWN_API_TIERS),
    bySurface: emptyDimension(KNOWN_SURFACES),
    byAgentScope: emptyDimension(KNOWN_AGENT_SCOPES),
    byLineage: emptyDimension(KNOWN_LINEAGE),
    byReasoningEffort: {
      unknown: { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
    },
    // Observed speed mode crossed with the model's Priority (Fast) price-
    // ratio family, so the published ratio can be applied at read time.
    speedWeighting: emptySpeedWeightingCrossing(),
    // The same crossing, holding only the events the log left UNOBSERVED that
    // a timestamped Codex `service_tier` reading actually covers.
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
    accountAttribution: {
      attributedPseudonymousEvents: 0,
      unattributedEvents: 0,
    },
  };
  if (includeSpark) {
    period.spark = newUsagePeriod("spark", "Spark allowance", {
      includeSpark: false,
    });
  }
  return period;
}

function addSpeedWeighting(crossing, projection) {
  const speed = crossing[projection.speed] ? projection.speed : "unknown";
  const cell = crossing[speed][fastModeModelFamilyKey(projection.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
}

function addDeclaredSpeedWeighting(crossing, projection) {
  // Only a declaration that resolved to a real mode is recorded, and only for
  // events the log left unobserved; everything else is left unattributed.
  if (projection.declaredSpeed !== "standard"
      && projection.declaredSpeed !== "fast") return;
  const cell =
    crossing[projection.declaredSpeed][fastModeModelFamilyKey(projection.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
}

function finalizeSpeedWeighting(crossing) {
  return Object.fromEntries(Object.entries(crossing).map(([speed, families]) => [
    speed,
    Object.fromEntries(Object.entries(families).map(([family, cell]) => [
      family,
      {
        ...cell,
        apiPriceEquivalentUsd: Number(cell.apiPriceEquivalentUsd.toFixed(6)),
      },
    ])),
  ]));
}

export function safeSpeedWeighting(value) {
  const crossing = emptySpeedWeightingCrossing();
  for (const speed of OBSERVED_SPEED_MODE_KEYS) {
    for (const family of FAST_MODE_MODEL_FAMILY_KEYS) {
      const cell = value?.[speed]?.[family];
      crossing[speed][family] = {
        events: Number.isSafeInteger(cell?.events) && cell.events >= 0
          ? cell.events
          : 0,
        apiPriceEquivalentUsd:
          finiteNumber(cell?.apiPriceEquivalentUsd) !== null
            && cell.apiPriceEquivalentUsd >= 0
            ? cell.apiPriceEquivalentUsd
            : 0,
      };
    }
  }
  return crossing;
}

function addDimension(dimension, key, projection) {
  const row = dimension[key] ?? dimension.unknown;
  row.events += 1;
  row.totalTokens += projection.totalTokens;
  row.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
}

export function addUsageToPeriod(period, projection) {
  if (projection === null) return;
  if (projection.isSpark) {
    addUsageToPeriod(period.spark, { ...projection, isSpark: false });
    return;
  }
  period.events += 1;
  period.totalTokens += projection.totalTokens;
  addComponents(period.components, projection.components);
  addComponentCosts(
    period.componentCosts,
    projection.components,
    { components: projection.pricedComponents },
  );
  const modelSummary = period.byModel[projection.model] ??= {
    model: projection.model,
    pricingStatus: projection.modelPricingStatus,
    allowanceTrack: projection.modelAllowanceTrack,
    apiPriceEquivalentApplicable: projection.modelApiPriceEquivalentApplicable,
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    // The same two crossings the replay-safe cache keeps per model, so a model
    // table reads the same whichever source produced the period.
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
  };
  modelSummary.events += 1;
  modelSummary.totalTokens += projection.totalTokens;
  modelSummary.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
  addComponents(modelSummary.components, projection.components);
  addComponentCosts(
    modelSummary.componentCosts,
    projection.components,
    { components: projection.pricedComponents },
  );
  period.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
  if (projection.apiPriceEquivalentUsdExact !== null) {
    period.apiPriceEquivalentUsdExact = period.apiPriceEquivalentUsdExact === null
      ? projection.apiPriceEquivalentUsdExact
      : addUsdStrings(
        period.apiPriceEquivalentUsdExact,
        projection.apiPriceEquivalentUsdExact,
      );
  }
  for (const id of projection.priceCardIds) {
    if (!period.priceCardIds.includes(id)) period.priceCardIds.push(id);
  }
  for (const item of projection.priceCardBreakdown) {
    const row = period.priceCardBreakdown[item.priceCardId] ?? {
      priceCardId: item.priceCardId,
      events: 0,
      costUsd: "0",
    };
    row.events += item.events;
    row.costUsd = addUsdStrings(row.costUsd, item.costUsd);
    period.priceCardBreakdown[item.priceCardId] = row;
  }
  addDimension(period.bySpeed, projection.speed, projection);
  addSpeedWeighting(period.speedWeighting, projection);
  addDeclaredSpeedWeighting(period.declaredSpeedWeighting, projection);
  addDimension(period.byApiServiceTier, projection.apiServiceTier, projection);
  addDimension(period.bySurface, projection.surface, projection);
  addDimension(period.byAgentScope, projection.agentScope, projection);
  addDimension(period.byLineage, projection.lineage, projection);
  addDimension(period.byReasoningEffort, projection.reasoningEffort, projection);
  if (projection.accountAttribution === "attributed_pseudonymous") {
    period.accountAttribution.attributedPseudonymousEvents += 1;
  } else {
    period.accountAttribution.unattributedEvents += 1;
  }
  if (projection.pricingCoverageStatus === "fully_priced") {
    period.pricingCoverage.fullyPricedEvents += 1;
  } else if (projection.pricingCoverageStatus === "partially_priced") {
    period.pricingCoverage.partiallyPricedEvents += 1;
  }
  else period.pricingCoverage.unpricedEvents += 1;
}

function finalizeDimension(dimension) {
  return Object.fromEntries(Object.entries(dimension).map(([key, row]) => [
    key,
    {
      ...row,
      apiPriceEquivalentUsd: Number(row.apiPriceEquivalentUsd.toFixed(6)),
    },
  ]));
}

function roundComponentCosts(componentCosts) {
  return Object.fromEntries(
    Object.entries(componentCosts).map(([key, cost]) => [
      key,
      { ...cost, costUsd: Number(cost.costUsd.toFixed(6)) },
    ]),
  );
}

export function finalizeUsagePeriod(period) {
  const priced = period.pricingCoverage.fullyPricedEvents + period.pricingCoverage.partiallyPricedEvents;
  const finalized = {
    ...period,
    apiPriceEquivalentUsd: Number(period.apiPriceEquivalentUsd.toFixed(6)),
    priceCardIds: [...period.priceCardIds].sort(),
    priceCardBreakdown: Object.values(period.priceCardBreakdown).sort(
      (left, right) => left.priceCardId.localeCompare(right.priceCardId),
    ),
    pricedEventFraction: period.events === 0 ? null : Number((priced / period.events).toFixed(6)),
    componentCosts: roundComponentCosts(period.componentCosts),
    byModel: Object.values(period.byModel)
      .map((row) => ({
        ...row,
        apiPriceEquivalentUsd: Number(row.apiPriceEquivalentUsd.toFixed(6)),
        componentCosts: roundComponentCosts(row.componentCosts),
      }))
      .sort((left, right) => right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd || left.model.localeCompare(right.model)),
    bySpeed: finalizeDimension(period.bySpeed),
    byApiServiceTier: finalizeDimension(period.byApiServiceTier),
    bySurface: finalizeDimension(period.bySurface),
    byAgentScope: finalizeDimension(period.byAgentScope),
    byLineage: finalizeDimension(period.byLineage),
    byReasoningEffort: finalizeDimension(period.byReasoningEffort),
    speedWeighting: finalizeSpeedWeighting(period.speedWeighting),
    declaredSpeedWeighting: finalizeSpeedWeighting(
      period.declaredSpeedWeighting,
    ),
  };
  if (period.spark) finalized.spark = finalizeUsagePeriod(period.spark);
  // One list covering every allowance track. `byModel` stays aligned with the
  // period's own totals, which exclude the separately metered Spark track.
  finalized.modelUsage = [
    ...finalized.byModel,
    ...(finalized.spark?.byModel ?? []),
  ].sort((left, right) => (
    right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd
    || right.totalTokens - left.totalTokens
    || left.model.localeCompare(right.model)
  ));
  return finalized;
}

export function validObservedAt(record) {
  const timestamp = Date.parse(record?.observedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function newTimelineBucket(startMs) {
  return {
    startMs,
    endMs: startMs + TIMELINE_BUCKET_MS,
    usageEvents: 0,
    totalTokens: 0,
    components: emptyComponents(),
    apiPriceEquivalentUsd: 0,
    speedWeighting: emptySpeedWeightingCrossing(),
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
    fullyPricedEvents: 0,
    partiallyPricedEvents: 0,
    unpricedEvents: 0,
  };
}

export function addTimelineUsage(buckets, observedMs, projection) {
  if (projection === null) return;
  const startMs = Math.floor(observedMs / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS;
  const bucket = buckets.get(startMs) ?? newTimelineBucket(startMs);
  bucket.usageEvents += 1;
  bucket.totalTokens += projection.totalTokens;
  bucket.apiPriceEquivalentUsd += projection.apiPriceEquivalentUsd;
  addSpeedWeighting(bucket.speedWeighting, projection);
  addDeclaredSpeedWeighting(bucket.declaredSpeedWeighting, projection);
  addComponents(bucket.components, projection.components);
  if (projection.pricingCoverageStatus === "fully_priced") bucket.fullyPricedEvents += 1;
  else if (projection.pricingCoverageStatus === "partially_priced") bucket.partiallyPricedEvents += 1;
  else bucket.unpricedEvents += 1;
  buckets.set(startMs, bucket);
}

export function finalizeTimelineBuckets(buckets) {
  return [...buckets.values()]
    .sort((left, right) => left.startMs - right.startMs)
    .map((bucket) => ({
      startAt: new Date(bucket.startMs).toISOString(),
      endAt: new Date(bucket.endMs).toISOString(),
      usageEvents: bucket.usageEvents,
      totalTokens: bucket.totalTokens,
      components: bucket.components,
      apiPriceEquivalentUsd: Number(bucket.apiPriceEquivalentUsd.toFixed(6)),
      speedWeighting: finalizeSpeedWeighting(bucket.speedWeighting),
      declaredSpeedWeighting: finalizeSpeedWeighting(
        bucket.declaredSpeedWeighting,
      ),
      pricingCoverage: {
        fullyPricedEvents: bucket.fullyPricedEvents,
        partiallyPricedEvents: bucket.partiallyPricedEvents,
        unpricedEvents: bucket.unpricedEvents,
      },
    }));
}

export function quotaWindowProjection(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = finiteNumber(window.usedPercent);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  const durationMinutes = isValidQuotaWindowDuration(
    window.windowDurationMins,
  )
    ? window.windowDurationMins
    : null;
  if (durationMinutes === null) return null;
  const resetAt = quotaResetIsoInstant(window.resetsAt);
  if (resetAt === null) return null;
  const projected = {
    // Preserve a bounded future provider id for local display and track
    // separation. Closed accounting/export boundaries still map it through
    // their reviewed registries, so this cannot promote a new quota pool.
    limitId: sanitizeQuotaLimitId(window.limitId),
    slot: KNOWN_SLOTS.has(window.slot) ? window.slot : "unknown",
    planType: KNOWN_PLANS.has(window.planType) ? window.planType : "unknown",
    usedPercent,
    remainingPercent: Number((100 - usedPercent).toFixed(3)),
    durationMinutes,
    resetAt,
  };
  const limitName = sanitizeQuotaLimitDisplayName(window.limitName);
  if (limitName !== null) projected.limitName = limitName;
  return projected;
}

function primaryCodexWindowIndex(windows) {
  let selected = -1;
  for (let index = 0; index < windows.length; index += 1) {
    const candidate = windows[index];
    if (candidate.limitId !== "codex") continue;
    if (selected === -1) {
      selected = index;
      continue;
    }
    const prior = windows[selected];
    if (candidate.durationMinutes > prior.durationMinutes
        || (candidate.durationMinutes === prior.durationMinutes
          && candidate.slot === "primary"
          && prior.slot !== "primary")) {
      selected = index;
    }
  }
  return selected;
}

// Keep every observed window, but put the selected normal Codex window first.
// The scan is stable for equal duration/slot candidates, so provider ordering
// remains the final deterministic tie-breaker and planType stays attached only
// to the window where it was observed.
export function orderQuotaWindows(windows) {
  const selected = primaryCodexWindowIndex(windows);
  if (selected <= 0) return windows;
  return [
    windows[selected],
    ...windows.slice(0, selected),
    ...windows.slice(selected + 1),
  ];
}

function quotaTimelineRowTieBreak(row) {
  // Percent is zero-padded so the string compare is numeric: between two
  // same-instant readings of one track the lower displayed percentage wins.
  // Slot is deliberately LAST: it is display provenance, not identity, and
  // only breaks the tie when the state is otherwise identical so dedupe
  // stays order-independent.
  return [
    row.planType,
    row.usedPercent.toFixed(3).padStart(7, "0"),
    row.resetAt,
    row.accountAttribution,
    row.slot,
  ].join("\0");
}

export function finalizeQuotaTimeline(rows) {
  // Quota track identity is (limitId, duration). The provider's
  // primary/secondary slots are server-assigned UI roles — the weekly
  // 10080-minute window flipped from `secondary` to `primary` around
  // 2026-07-06 — so slot never participates in track identity or sorts ahead
  // of the duration; it stays on the row as display provenance and acts only
  // as a trailing deterministic tie-break.
  rows.sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || left.limitId.localeCompare(right.limitId)
    || left.durationMinutes - right.durationMinutes
    || left.slot.localeCompare(right.slot)
    || left.planType.localeCompare(right.planType)
    || left.usedPercent - right.usedPercent
  ));
  const points = new Map();
  for (const row of rows) {
    const track = `${row.limitId}:${row.durationMinutes ?? "unknown"}`;
    const observedMs = Date.parse(row.observedAt);
    const key = `${track}:${observedMs}`;
    const prior = points.get(key);
    if (prior === undefined
        || quotaTimelineRowTieBreak(row) < quotaTimelineRowTieBreak(prior)) {
      points.set(key, row);
    }
  }
  // Thinning is per track under the shared ceiling: an index-uniform sample
  // of the combined series silently starves whichever track a consumer
  // filters down to (see sampleQuotaTimelineByTrack).
  return sampleQuotaTimelineByTrack(
    [...points.values()].sort((left, right) => (
      Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.limitId.localeCompare(right.limitId)
      || left.durationMinutes - right.durationMinutes
      || left.slot.localeCompare(right.slot)
      || left.planType.localeCompare(right.planType)
      || left.usedPercent - right.usedPercent
    )),
    MAX_QUOTA_TIMELINE_POINTS,
  );
}
