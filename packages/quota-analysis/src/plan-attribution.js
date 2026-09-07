// Attribution policy, not calibration math. Account scopes supplied here must
// already be positively comparable; transport/device IDs are not account proof.
// The index is an in-memory object (including Maps), never a wire/cache DTO.

export const PLAN_ATTRIBUTION_POLICY = Object.freeze({
  methodVersion: "plan-attribution-v1",
  maxObservations: 1_000_000,
  maxContexts: 256,
  maxEras: 60_000,
});

const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/u;
const CONTINUITY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const UNAVAILABLE_SCOPES = new Set(["", "unknown", "unattributed", "unavailable"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function continuityId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !CONTINUITY_TOKEN.test(value)) {
    throw new TypeError("continuityId must be a bounded opaque token");
  }
  return value;
}

function accountScope(value) {
  return typeof value === "string" && value.length <= 512
      && !UNAVAILABLE_SCOPES.has(value) ? value : null;
}

function planType(value) {
  return typeof value === "string" && TOKEN.test(value)
      && value !== "unknown" && value !== "unavailable" ? value : null;
}

function planVariant(value) {
  return typeof value === "string" && TOKEN.test(value) ? value : "unknown";
}

function groupKey(contextKey, scope) {
  return JSON.stringify([contextKey, scope]);
}

export function planAttributionContextKey(provider, limitId) {
  if (typeof provider !== "string" || !TOKEN.test(provider)
      || typeof limitId !== "string" || !TOKEN.test(limitId)) {
    throw new TypeError("provider and limitId must be bounded quota tokens");
  }
  return provider + "|" + limitId;
}

// Explicit accountScopeId only: a legacy synthetic accountTrackId is not proof.
// All window durations of one provider/limit family share plan evidence.
export function planAttributionObservationFromSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const observedAtMs = Number.isFinite(snapshot.observedAtMs)
    ? snapshot.observedAtMs : Date.parse(snapshot.observedAt);
  let contextKey = options.contextKey;
  if (contextKey === undefined) {
    try {
      contextKey = planAttributionContextKey(snapshot.provider, snapshot.limitId);
    } catch {
      return null;
    }
  }
  return {
    contextKey,
    observedAtMs,
    planType: snapshot.planType,
    planVariant: snapshot.planVariant,
    continuityId: snapshot.continuityId,
    conflicted: snapshot.conflicted,
    accountScopeId: accountScope(Object.hasOwn(options, "accountScopeId")
      ? options.accountScopeId : snapshot.accountScopeId),
    observationId: snapshot.snapshotId,
  };
}

function unavailable(reason = "no_plan_evidence") {
  return { status: "unavailable", era: null, reason };
}

function conflicted(reason) {
  return { status: "conflicted", era: null, reason };
}

/**
 * Build once from ALL admitted quota evidence, before fit/span/reset filters.
 * Unknown plan rows are not positive switches. An explicit conflict is a
 * barrier even when its plan is unknown. Equal-time contradictions are grouped
 * before ordering, so insertion order cannot choose a winning plan.
 * Temporary acquisition is O(Q); the retained index is O(eras + conflicts).
 */
export function buildPlanAttributionIndex(observations = [], options = {}) {
  if (!Array.isArray(observations)) {
    throw new TypeError("observations must be an array");
  }
  const maxObservations = options.maxObservations ?? PLAN_ATTRIBUTION_POLICY.maxObservations;
  const maxContexts = options.maxContexts ?? PLAN_ATTRIBUTION_POLICY.maxContexts;
  const maxEras = options.maxEras ?? PLAN_ATTRIBUTION_POLICY.maxEras;
  for (const limit of [maxObservations, maxContexts, maxEras]) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("attribution limits must be positive safe integers");
    }
  }
  const index = {
    methodVersion: PLAN_ATTRIBUTION_POLICY.methodVersion,
    status: "ready",
    observationCount: observations.length,
    ignoredObservationCount: 0,
    eras: [],
    conflicts: [],
    contexts: new Map(),
  };
  const refuse = () => ({
    ...index, status: "limit_exceeded", eras: [], conflicts: [], contexts: new Map(),
  });
  if (observations.length > maxObservations) return refuse();
  const groups = new Map();
  for (const observation of observations) {
    const type = planType(observation?.planType);
    const continuity = continuityId(observation?.continuityId);
    if (observation?.conflicted !== undefined && typeof observation.conflicted !== "boolean") {
      throw new TypeError("conflicted must be a boolean");
    }
    if (!observation || typeof observation.contextKey !== "string"
        || observation.contextKey.length === 0 || observation.contextKey.length > 512
        || !Number.isSafeInteger(observation.observedAtMs)) {
      index.ignoredObservationCount += 1;
      continue;
    }
    if (type === null && observation.planType !== null && observation.planType !== undefined
        && observation.planType !== "unknown" && observation.planType !== "unavailable") {
      index.ignoredObservationCount += 1;
      continue;
    }
    const scope = accountScope(observation.accountScopeId);
    const key = groupKey(observation.contextKey, scope);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= maxContexts) return refuse();
      group = {
        contextKey: observation.contextKey, accountScopeId: scope, rows: [],
        firstUnknownMs: Infinity, lastUnknownMs: -Infinity,
        hasKnownPlan: false, hasExplicitConflict: false,
      };
      groups.set(key, group);
    }
    if (type === null && !observation.conflicted) {
      index.ignoredObservationCount += 1;
      group.firstUnknownMs = Math.min(group.firstUnknownMs, observation.observedAtMs);
      group.lastUnknownMs = Math.max(group.lastUnknownMs, observation.observedAtMs);
      continue;
    }
    group.rows.push({
      ms: observation.observedAtMs,
      planType: type ?? "unknown",
      planVariant: planVariant(observation.planVariant),
      continuityId: continuity,
      conflicted: observation.conflicted === true,
    });
    group.hasKnownPlan ||= type !== null && !observation.conflicted;
    group.hasExplicitConflict ||= observation.conflicted === true;
  }

  // Only wholly unknown contexts with explicit barriers need their intermediate
  // unknown anchors. Recover them in one bounded pass, never contexts x input.
  // Ordinary legacy contexts keep the inexpensive two-endpoint fallback.
  const unknownConflictGroups = new Set([...groups]
    .filter(([, group]) => !group.hasKnownPlan && group.hasExplicitConflict)
    .map(([key]) => key));
  if (unknownConflictGroups.size > 0) {
    for (const observation of observations) {
      if (!observation || observation.conflicted || !Number.isSafeInteger(observation.observedAtMs)
          || (observation.planType !== null && observation.planType !== undefined
            && observation.planType !== "unknown" && observation.planType !== "unavailable")) continue;
      const key = groupKey(observation.contextKey, accountScope(observation.accountScopeId));
      if (!unknownConflictGroups.has(key)) continue;
      groups.get(key).rows.push({ ms: observation.observedAtMs, planType: "unknown",
        planVariant: "unknown", continuityId: null, conflicted: false });
    }
  }

  for (const [key, group] of [...groups].sort(([left], [right]) => compareText(left, right))) {
    // Entirely unknown-plan legacy history is still useful conditional local
    // evidence. It is never relabelled to a named plan, nor used to bridge a
    // known-plan transition. Two endpoints suffice for this fallback.
    if (group.rows.length === 0 && Number.isFinite(group.firstUnknownMs)) {
      group.rows.push({ ms: group.firstUnknownMs, planType: "unknown", planVariant: "unknown", continuityId: null });
      if (group.lastUnknownMs !== group.firstUnknownMs) {
        group.rows.push({ ms: group.lastUnknownMs, planType: "unknown", planVariant: "unknown", continuityId: null });
      }
    }
    group.rows.sort((left, right) => left.ms - right.ms
      || compareText(left.planType, right.planType)
      || compareText(left.planVariant, right.planVariant)
      || compareText(left.continuityId ?? "", right.continuityId ?? ""));
    const context = { eras: [], conflicts: [], singlePlan: true };
    let current = null;
    let interrupted = false;
    const seenPlans = new Set();
    for (let offset = 0; offset < group.rows.length;) {
      const first = group.rows[offset];
      let end = offset + 1;
      let contradiction = first.conflicted === true;
      while (end < group.rows.length && group.rows[end].ms === first.ms) {
        const row = group.rows[end];
        if (row.conflicted || row.planType !== first.planType || row.planVariant !== first.planVariant
            || row.continuityId !== first.continuityId) {
          contradiction = true;
        }
        end += 1;
      }
      if (contradiction) {
        if (current) current.upperBoundMs = current.lastObservedAtMs;
        const conflict = {
          contextKey: group.contextKey,
          accountScopeId: group.accountScopeId,
          observedAtMs: first.ms,
        };
        context.conflicts.push(conflict);
        index.conflicts.push(conflict);
        interrupted = true;
        current = null;
      } else {
        seenPlans.add(JSON.stringify([first.planType, first.planVariant, first.continuityId]));
        if (!current || current.planType !== first.planType
            || current.planVariant !== first.planVariant || current.continuityId !== first.continuityId) {
          if (current) current.upperBoundMs = current.lastObservedAtMs;
          if (index.eras.length >= maxEras) return refuse();
          current = {
            eraKey: JSON.stringify([group.contextKey, group.accountScopeId,
              first.planType, first.planVariant, first.ms,
              ...(first.continuityId === null ? [] : [first.continuityId])]),
            contextKey: group.contextKey,
            accountScopeId: group.accountScopeId,
            planType: first.planType,
            planVariant: first.planVariant,
            // Continuity is a boundary claim only, never an account identity.
            continuityId: first.continuityId,
            firstObservedAtMs: first.ms,
            lastObservedAtMs: first.ms,
            lowerBoundMs: context.eras.length === 0 && !interrupted ? null : first.ms,
            upperBoundMs: null,
          };
          context.eras.push(current);
          index.eras.push(current);
        } else {
          current.lastObservedAtMs = first.ms;
        }
      }
      offset = end;
    }
    context.singlePlan = seenPlans.size === 1 && context.conflicts.length === 0;
    // Past-before-first is only the explicitly conditional single-plan legacy
    // lane. Multiple observed regimes provide no such unambiguous fallback.
    if (!context.singlePlan && context.eras.length > 0) {
      context.eras[0].lowerBoundMs = context.eras[0].firstObservedAtMs;
    }
    for (const era of context.eras) Object.freeze(era);
    index.contexts.set(key, context);
  }
  return index;
}

function lowerBound(values, value, field) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle][field] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Bounds are observation anchors, inclusive; null is open. A different-plan
 * gap (last old observation, first new observation) is unresolved. A supplied
 * quantity interval is (intervalStartMs, observedAtMs], matching counter deltas.
 * No guessed historical interval is manufactured when its start is unavailable.
 */
export function planEraForInterval(index, input) {
  if (!index || index.status !== "ready") return unavailable("attribution_limit_exceeded");
  const end = input?.observedAtMs;
  const suppliedStart = input?.intervalStartMs;
  const start = suppliedStart === undefined || suppliedStart === null ? end : suppliedStart;
  if (!Number.isSafeInteger(end) || !Number.isSafeInteger(start) || start > end) {
    return unavailable("usage_interval_unresolved");
  }
  const scope = accountScope(input.accountScopeId);
  const context = index.contexts.get(groupKey(input.contextKey, scope));
  if (!context || context.eras.length === 0) {
    return context?.conflicts.length ? conflicted("conflicting_quota_evidence") : unavailable();
  }
  const point = start === end;
  let conflictAt = lowerBound(context.conflicts, start, "observedAtMs");
  if (!point && context.conflicts[conflictAt]?.observedAtMs === start) conflictAt += 1;
  if (context.conflicts[conflictAt]?.observedAtMs <= end) {
    return conflicted("conflicting_quota_evidence");
  }
  let at = lowerBound(context.eras, end, "firstObservedAtMs");
  if (at === context.eras.length || context.eras[at].firstObservedAtMs > end) at -= 1;
  if (at < 0) {
    if (!context.singlePlan) return unavailable("outside_observed_history");
    at = 0;
  }
  const era = context.eras[at];
  if ((era.lowerBoundMs !== null && start < era.lowerBoundMs)
      || (era.upperBoundMs !== null && end > era.upperBoundMs)) {
    return conflicted("plan_transition_interval");
  }
  return {
    status: "matched",
    era,
    reason: start < era.firstObservedAtMs || end > era.lastObservedAtMs
      ? "legacy_single_plan_history" : "coherent_plan_era",
  };
}

/**
 * Positive incompatible attribution is an EXCLUSION, not poisoning account A.
 * Unknown possible A quantities remain unresolved for a scoped A numerator.
 * Legacy conditional is useful evidence, never a certification of ownership.
 */
export function classifyUsageAttribution(index, usage, target = undefined) {
  const scope = accountScope(usage?.accountScopeId);
  const targetScope = accountScope(target?.accountScopeId);
  const observedType = planType(usage?.observedPlanType);
  const observedVariant = planVariant(usage?.observedPlanVariant);
  const targetType = planType(target?.planType);
  const result = (disposition, reason, match = unavailable(reason)) => ({
    ...match, disposition, reason,
    planType: match.era?.planType ?? observedType,
    planVariant: match.era?.planVariant ?? observedVariant,
    accountScopeId: scope,
  });
  if (target?.contextKey && usage?.contextKey !== target.contextKey) {
    return result("incompatible", "different_context");
  }
  if (scope !== null && targetScope !== null && scope !== targetScope) {
    return result("incompatible", "different_account");
  }
  const match = planEraForInterval(index, usage);
  if (match.status === "conflicted") return result("unresolved", match.reason, match);
  const quantityKnown = usage?.quantityBasis === "reported-increment"
    || (usage?.quantityBasis === "reconstructed-counter-delta"
      && Number.isSafeInteger(usage.intervalStartMs));
  if (observedType !== null && targetType !== null && observedType !== targetType) {
    // A label on the ending record does not necessarily label an unbounded
    // cumulative delta. Do not silently exclude its possible target-plan part.
    const fullQuantityPlanKnown = usage.quantityBasis === "reported-increment"
      || (quantityKnown && match.status === "matched"
        && match.era.planType === observedType && match.era.planVariant === observedVariant
        && match.reason === "coherent_plan_era");
    return fullQuantityPlanKnown
      ? result("incompatible", "different_plan", match)
      : result("unresolved", "usage_quantity_plan_unresolved", match);
  }
  if (targetScope !== null && scope === null) {
    return result("unresolved", "account_unresolved", match);
  }
  if (match.status !== "matched") return result("unresolved", match.reason, match);
  if (observedType !== null && (observedType !== match.era.planType
      || observedVariant !== match.era.planVariant)) {
    return result("unresolved", "usage_plan_conflict", match);
  }
  if (targetType !== null && match.era.planType !== targetType) {
    if (match.era.planType === "unknown") return result("unresolved", "plan_unresolved", match);
    return result("incompatible", "different_plan", match);
  }
  if (target?.eraKey && target.eraKey !== match.era.eraKey) {
    return result("incompatible", "different_era", match);
  }
  if (scope !== null && observedType !== null && quantityKnown
      && match.reason === "coherent_plan_era") {
    return result("compatible", "explicit_usage_attribution", match);
  }
  return result("legacy_conditional", scope === null ? "account_unresolved" : "plan_unresolved", match);
}
