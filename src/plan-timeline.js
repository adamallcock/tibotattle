export const PLAN_VARIANTS = new Set([
  "pro-20x",
  "pro-10x-promo",
  "pro-5x",
  "plus",
  "unknown",
]);

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeScopeId(value) {
  return typeof value === "string" && /^openai-account:v1:[A-Za-z0-9_-]{43}$/.test(value);
}

function safeAlias(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

export function validatePlanTimeline(value) {
  if (!value || typeof value !== "object") throw new Error("Plan timeline must be an object");
  if (value.schemaVersion !== "0.1") throw new Error("Unsupported plan timeline schema");
  if (!Array.isArray(value.profiles)) throw new Error("Plan timeline profiles must be an array");
  if (!Array.isArray(value.unresolvedEpisodes)) throw new Error("Plan timeline unresolvedEpisodes must be an array");
  const profiles = value.profiles;
  const unresolvedEpisodes = value.unresolvedEpisodes;
  const seenScopes = new Set();
  const seenAliases = new Set();
  for (const profile of profiles) {
    if (!safeScopeId(profile.scopeId)) throw new Error("Plan profile has an invalid pseudonymous scope ID");
    if (seenScopes.has(profile.scopeId)) throw new Error("Plan timeline contains a duplicate scope profile");
    seenScopes.add(profile.scopeId);
    if (profile.alias !== null && profile.alias !== undefined && !safeAlias(profile.alias)) {
      throw new Error("Plan profile alias must be a low-cardinality local label");
    }
    if (profile.alias && seenAliases.has(profile.alias)) throw new Error("Plan timeline contains a duplicate local alias");
    if (profile.alias) seenAliases.add(profile.alias);
    if (!PLAN_VARIANTS.has(profile.defaultPlanVariant)) throw new Error("Plan profile has an invalid default variant");
    if (!validIso(profile.defaultEffectiveAt)) throw new Error("Plan profile defaultEffectiveAt must be an ISO timestamp");
    if (!Array.isArray(profile.periods)) throw new Error("Plan profile periods must be an array");
    const periods = profile.periods;
    for (const period of periods) {
      if (!PLAN_VARIANTS.has(period.planVariant)) throw new Error("Plan period has an invalid variant");
      if (!validIso(period.startAt)) throw new Error("Plan period startAt must be an ISO timestamp");
      if (period.endAt !== null && period.endAt !== undefined && !validIso(period.endAt)) {
        throw new Error("Plan period endAt must be null or an ISO timestamp");
      }
      if (period.endAt && Date.parse(period.endAt) <= Date.parse(period.startAt)) {
        throw new Error("Plan period endAt must follow startAt");
      }
    }
    const orderedPeriods = [...periods].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
    for (let index = 1; index < orderedPeriods.length; index += 1) {
      const previousEnd = orderedPeriods[index - 1].endAt ? Date.parse(orderedPeriods[index - 1].endAt) : Number.POSITIVE_INFINITY;
      if (Date.parse(orderedPeriods[index].startAt) < previousEnd) throw new Error("Plan periods must not overlap");
    }
  }
  for (const episode of unresolvedEpisodes) {
    if (!PLAN_VARIANTS.has(episode.planVariant)) throw new Error("Unresolved plan episode has an invalid variant");
    if (episode.scopeId !== null && episode.scopeId !== undefined && !safeScopeId(episode.scopeId)) {
      throw new Error("Unresolved plan episode has an invalid pseudonymous scope ID");
    }
    for (const field of ["startAt", "endAt"]) {
      if (episode[field] !== null && episode[field] !== undefined && !validIso(episode[field])) {
        throw new Error(`Unresolved plan episode ${field} must be null or an ISO timestamp`);
      }
    }
    if (episode.startAt && episode.endAt && Date.parse(episode.endAt) <= Date.parse(episode.startAt)) {
      throw new Error("Unresolved plan episode endAt must follow startAt");
    }
  }
  return value;
}

export function resolvePlanContext({ timeline, scopeId, at, providerPlanType = "unknown" }) {
  const timestampMs = Date.parse(at);
  if (!Number.isFinite(timestampMs)) throw new Error("Plan resolution requires a valid timestamp");
  if (!timeline) {
    return {
      providerPlanType,
      planVariant: "unknown",
      localAlias: null,
      source: "no_plan_timeline",
      ambiguity: [],
    };
  }
  validatePlanTimeline(timeline);
  const profile = timeline.profiles.find((candidate) => candidate.scopeId === scopeId) ?? null;
  const matchingPeriods = (profile?.periods ?? []).filter((period) => {
    const startsBefore = Date.parse(period.startAt) <= timestampMs;
    const endsAfter = !period.endAt || timestampMs < Date.parse(period.endAt);
    return startsBefore && endsAfter;
  });
  if (matchingPeriods.length > 1) throw new Error("Overlapping plan periods make the plan variant ambiguous");
  const unresolved = timeline.unresolvedEpisodes.filter((episode) => episode.scopeId === null || episode.scopeId === undefined || episode.scopeId === scopeId);
  return {
    providerPlanType,
    planVariant: matchingPeriods[0]?.planVariant
      ?? (profile && Date.parse(profile.defaultEffectiveAt) <= timestampMs ? profile.defaultPlanVariant : "unknown"),
    localAlias: profile?.alias ?? null,
    source: matchingPeriods.length === 1
      ? "dated_user_declaration"
      : (profile && Date.parse(profile.defaultEffectiveAt) <= timestampMs ? "dated_user_reported_default" : (profile ? "before_default_effective_date" : "unregistered_scope")),
    ambiguity: unresolved.map((episode) => ({
      planVariant: episode.planVariant,
      startAtKnown: Boolean(episode.startAt),
      endAtKnown: Boolean(episode.endAt),
      scopeKnown: Boolean(episode.scopeId),
      reason: "unresolved_user_reported_plan_episode",
    })),
  };
}

export function createInitialPlanTimeline({ scopeId, alias = "account-current", effectiveAt } = {}) {
  if (safeScopeId(scopeId) && !validIso(effectiveAt)) throw new Error("Initial scoped plan timeline requires an effectiveAt timestamp");
  return validatePlanTimeline({
    schemaVersion: "0.1",
    profiles: safeScopeId(scopeId)
      ? [{
          scopeId,
          alias,
          defaultPlanVariant: "pro-20x",
          defaultEffectiveAt: effectiveAt,
          confidence: "user_reported_normal_state",
          periods: [],
        }]
      : [],
    unresolvedEpisodes: [{
      scopeId: null,
      planVariant: "pro-5x",
      startAt: null,
      endAt: null,
      confidence: "user_reported_brief_period_dates_and_account_unknown",
    }],
  });
}

export function upsertPlanProfile({ timeline, scopeId, alias, defaultPlanVariant, effectiveAt }) {
  validatePlanTimeline(timeline);
  if (!safeScopeId(scopeId)) throw new Error("Plan registration requires a pseudonymous account scope");
  if (!safeAlias(alias)) throw new Error("Plan registration requires a low-cardinality alias");
  if (!PLAN_VARIANTS.has(defaultPlanVariant)) throw new Error("Plan registration has an invalid plan variant");
  if (!validIso(effectiveAt)) throw new Error("Plan registration requires an effectiveAt timestamp");
  const next = structuredClone(timeline);
  const existing = next.profiles.find((profile) => profile.scopeId === scopeId);
  if (existing) {
    if (existing.defaultPlanVariant !== defaultPlanVariant) {
      throw new Error("Account scope is already registered with a different default plan; add a dated plan period instead of rewriting history");
    }
    existing.alias = alias;
  } else {
    next.profiles.push({
      scopeId,
      alias,
      defaultPlanVariant,
      defaultEffectiveAt: effectiveAt,
      confidence: "user_registered_current_state",
      periods: [],
    });
  }
  return validatePlanTimeline(next);
}
