export const PROSPECTIVE_COLLECTOR_TRANSITIONS_SCHEMA_VERSION =
  "prospective-collector-transitions-v0.1";

const COLLECTOR_SCHEMA_VERSION = "0.3";
const PROVIDER = "openai_codex";
const MAXIMUM_STALENESS_MS = 5 * 60 * 1_000;
const AGENTIC_POOL_POLICY_START_MS = Date.parse("2026-07-09T00:00:00.000Z");
const EVENT_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const ACCOUNT_SCOPE_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const SAFE_CLASSIFICATION_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

const COMPONENT_NAMES = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
]);
const SPEED_MODES = Object.freeze(["standard", "fast", "unknown", "other"]);
const TOOL_CLASSES = Object.freeze([
  "web_search",
  "file_search",
  "code_interpreter",
  "subagent",
  "mcp",
  "computer_use",
  "apply_patch",
  "local_shell",
  "tool_gateway",
  "other",
  "unknown",
]);
const SURFACES = new Set([
  "scheduled_task",
  "subagent",
  "extension_or_ide",
  "cli_exec",
  "local_interactive_unclassified",
  "local_rollout_unclassified",
]);
const THREAD_SOURCES = new Set(["user", "subagent", "automation", "unknown"]);
const AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
const LINEAGE_DISPOSITIONS = new Set(["standalone", "forked", "parent_linked"]);

const ACCOUNT_KEYS = Object.freeze([
  "status", "reason", "version", "scopeId", "planType",
]);
const COMPONENT_KEYS = Object.freeze([...COMPONENT_NAMES]);
const WINDOW_KEYS = Object.freeze([
  "provider", "planType", "limitId", "slot", "usedPercent",
  "windowDurationMins", "resetsAt",
]);
const SURFACE_KEYS = Object.freeze([
  "schemaVersion", "threadSource", "surface", "agentScope", "lineageDisposition",
]);
const TIER_KEYS = Object.freeze([
  "schemaVersion", "billingSurface", "codexSpeedMode", "apiServiceTier",
  "providerTierRaw", "tierSource", "tierObservedAt",
]);
const USAGE_KEYS = Object.freeze([
  "schemaVersion", "kind", "provider", "observedAt", "receivedAt", "stalenessMs",
  "source", "model", "components", "tierSemantics", "surfaceClassification",
  "accountScope", "accountScopeAttribution", "windows", "controlledState", "eventKey",
]);
const TOOL_KEYS = Object.freeze([
  "schemaVersion", "kind", "provider", "observedAt", "receivedAt", "stalenessMs",
  "source", "toolClass", "surfaceClassification", "accountScope",
  "accountScopeAttribution", "controlledState", "eventKey",
]);
const QUOTA_KEYS = Object.freeze([
  "schemaVersion", "kind", "provider", "observedAt", "receivedAt", "stalenessMs",
  "source", "windows", "providerSurface", "accountScope", "officialDailyTokens",
  "officialUsageSummary", "controlledState", "eventKey",
]);
const SUMMARY_KEYS = Object.freeze([
  "currentStreakDays",
  "lifetimeTokens",
  "longestRunningTurnSec",
  "longestStreakDays",
  "peakDailyTokens",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isCanonicalIso(value) {
  if (typeof value !== "string" || value.length > 32) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafeNumber(value) {
  return Number.isFinite(value) && value >= 0;
}

function isValidResetTimestamp(value) {
  return Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value * 1_000).getTime());
}

function isSafeClassification(value) {
  return typeof value === "string" && SAFE_CLASSIFICATION_PATTERN.test(value);
}

function validAccountScope(value) {
  return hasExactKeys(value, ACCOUNT_KEYS)
    && value.status === "available"
    && value.reason === null
    && value.version === "openai-account-v1"
    && ACCOUNT_SCOPE_PATTERN.test(value.scopeId)
    && isSafeClassification(value.planType)
    && value.planType !== "unknown";
}

function validComponents(value) {
  return hasExactKeys(value, COMPONENT_KEYS)
    && COMPONENT_NAMES.every((name) => isSafeInteger(value[name]));
}

function validWindow(value, accountScope) {
  return hasExactKeys(value, WINDOW_KEYS)
    && value.provider === PROVIDER
    && value.planType === accountScope.planType
    && isSafeClassification(value.limitId)
    && ["primary", "secondary"].includes(value.slot)
    && isSafeNumber(value.usedPercent)
    && value.usedPercent <= 100
    && Number.isSafeInteger(value.windowDurationMins)
    && value.windowDurationMins > 0
    && isValidResetTimestamp(value.resetsAt);
}

function validSurface(value) {
  return hasExactKeys(value, SURFACE_KEYS)
    && value.schemaVersion === "0.1"
    && THREAD_SOURCES.has(value.threadSource)
    && SURFACES.has(value.surface)
    && AGENT_SCOPES.has(value.agentScope)
    && LINEAGE_DISPOSITIONS.has(value.lineageDisposition);
}

function validTier(value) {
  return hasExactKeys(value, TIER_KEYS)
    && value.schemaVersion === "0.1"
    && value.billingSurface === "chatgpt_subscription"
    && SPEED_MODES.includes(value.codexSpeedMode)
    && value.apiServiceTier === "unknown"
    && (value.providerTierRaw === null || isSafeClassification(value.providerTierRaw))
    && ["rollout_thread_settings", "unobserved"].includes(value.tierSource)
    && (value.tierObservedAt === null || isCanonicalIso(value.tierObservedAt));
}

function validCommon(value, keys, kind, source) {
  return hasExactKeys(value, keys)
    && value.schemaVersion === COLLECTOR_SCHEMA_VERSION
    && value.kind === kind
    && value.provider === PROVIDER
    && isCanonicalIso(value.observedAt)
    && isCanonicalIso(value.receivedAt)
    && Date.parse(value.receivedAt) >= Date.parse(value.observedAt)
    && isSafeInteger(value.stalenessMs)
    && value.stalenessMs === Date.parse(value.receivedAt) - Date.parse(value.observedAt)
    && value.source === source
    && value.controlledState === "unknown"
    && EVENT_KEY_PATTERN.test(value.eventKey)
    && validAccountScope(value.accountScope);
}

function validUsageRecord(value) {
  return validCommon(
    value,
    USAGE_KEYS,
    "codex_rollout_usage_snapshot",
    "rollout_token_count",
  )
    && SAFE_MODEL_PATTERN.test(value.model)
    && (value.components === null || validComponents(value.components))
    && validTier(value.tierSemantics)
    && validSurface(value.surfaceClassification)
    && value.accountScopeAttribution === "provisional_fresh_app_server_marker"
    && Array.isArray(value.windows)
    && value.windows.every((window) => validWindow(window, value.accountScope));
}

function validToolRecord(value) {
  return validCommon(
    value,
    TOOL_KEYS,
    "codex_tool_class_event",
    "rollout_tool_call",
  )
    && TOOL_CLASSES.includes(value.toolClass)
    && validSurface(value.surfaceClassification)
    && value.accountScopeAttribution === "provisional_fresh_app_server_marker";
}

function validOfficialDailyTokens(value) {
  return Array.isArray(value) && value.every((row) => (
    hasExactKeys(row, ["date", "tokens"])
      && typeof row.date === "string"
      && /^\d{4}-\d{2}-\d{2}$/u.test(row.date)
      && isSafeNumber(row.tokens)
  ));
}

function validOfficialUsageSummary(value) {
  return value === null || (
    hasExactKeys(value, SUMMARY_KEYS)
      && SUMMARY_KEYS.every((key) => value[key] === null || isSafeNumber(value[key]))
  );
}

function validQuotaRecord(value) {
  return validCommon(
    value,
    QUOTA_KEYS,
    "codex_quota_snapshot",
    value?.source,
  )
    && ["app_server_read", "app_server_notification"].includes(value.source)
    && value.stalenessMs === 0
    && value.providerSurface === "account_shared_unallocated"
    && Array.isArray(value.windows)
    && value.windows.length > 0
    && value.windows.every((window) => validWindow(window, value.accountScope))
    && validOfficialDailyTokens(value.officialDailyTokens)
    && validOfficialUsageSummary(value.officialUsageSummary);
}

function classifyRecord(value) {
  if (value?.kind === "codex_rollout_usage_snapshot" && validUsageRecord(value)) return "usage";
  if (value?.kind === "codex_quota_snapshot" && validQuotaRecord(value)) return "quota";
  if (value?.kind === "codex_tool_class_event" && validToolRecord(value)) return "tool";
  return null;
}

function emptyComponents() {
  return Object.fromEntries(COMPONENT_NAMES.map((name) => [name, 0]));
}

function emptyTierCounts() {
  return Object.fromEntries(SPEED_MODES.map((name) => [name, 0]));
}

function emptyToolCounts() {
  return Object.fromEntries(TOOL_CLASSES.map((name) => [name, 0]));
}

function addComponents(target, source) {
  for (const name of COMPONENT_NAMES) target[name] += source[name];
}

function partitionKey(accountScopeId, window, includeReset = true) {
  return [
    accountScopeId,
    window.provider,
    window.planType,
    window.limitId,
    window.windowDurationMins,
    ...(includeReset ? [window.resetsAt] : []),
  ].join("\u0000");
}

function canonicalRecordOrder(left, right) {
  return Date.parse(left.record.observedAt) - Date.parse(right.record.observedAt)
    || left.record.eventKey.localeCompare(right.record.eventKey)
    || left.type.localeCompare(right.type);
}

function compareEventPosition(left, right) {
  return left.timestampMs - right.timestampMs
    || left.eventKey.localeCompare(right.eventKey);
}

function deduplicate(records, diagnostics) {
  const byEventKey = new Map();
  const conflicted = new Set();
  for (const record of records) {
    const key = [
      record.record.accountScope.scopeId,
      record.record.provider,
      record.type,
      record.record.eventKey,
    ].join("\u0000");
    if (conflicted.has(key)) {
      diagnostics.exclusions.conflictingEventKey += 1;
      continue;
    }
    const prior = byEventKey.get(key);
    if (!prior) {
      byEventKey.set(key, record);
      continue;
    }
    const priorJson = JSON.stringify(prior.record);
    const currentJson = JSON.stringify(record.record);
    if (currentJson === priorJson) {
      diagnostics.exclusions.duplicateEventKey += 1;
      continue;
    }
    diagnostics.exclusions.conflictingEventKey += 2;
    byEventKey.delete(key);
    conflicted.add(key);
  }
  return [...byEventKey.values()].sort(canonicalRecordOrder);
}

function collapseSlotObservations(snapshots, diagnostics) {
  const byPosition = new Map();
  for (const snapshot of snapshots) {
    const values = byPosition.get(snapshot.timestampMs) ?? [];
    values.push(snapshot);
    byPosition.set(snapshot.timestampMs, values);
  }
  const result = [];
  for (const values of byPosition.values()) {
    const percents = new Set(values.map((value) => value.window.usedPercent));
    if (percents.size > 1) {
      diagnostics.exclusions.slotConflict += values.length;
      continue;
    }
    values.sort((left, right) => (
      left.window.slot.localeCompare(right.window.slot)
      || left.eventKey.localeCompare(right.eventKey)
    ));
    result.push(values[0]);
  }
  return result.sort(compareEventPosition);
}

function priceRecord(record, priceUsage) {
  let price;
  try {
    price = priceUsage(record);
  } catch {
    throw new TypeError("priceUsage failed for an eligible collector usage record");
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
    throw new TypeError("priceUsage must return a finite non-negative number");
  }
  return price;
}

function transitionOrder(left, right) {
  return left.accountScopeId.localeCompare(right.accountScopeId)
    || left.provider.localeCompare(right.provider)
    || left.planType.localeCompare(right.planType)
    || left.limitId.localeCompare(right.limitId)
    || left.slot.localeCompare(right.slot)
    || left.windowDurationMins - right.windowDurationMins
    || left.resetsAt - right.resetsAt
    || left.firstNextObservedAt.localeCompare(right.firstNextObservedAt)
    || left.lastPriorObservedAt.localeCompare(right.lastPriorObservedAt);
}

/**
 * Convert privacy-reduced passive-collector records into deterministic,
 * account-local adjacent quota transitions. This function performs no I/O and
 * deliberately retains the local account scope; its result is not an upload
 * contract.
 */
export function buildProspectiveCollectorTransitions(records, { priceUsage } = {}) {
  if (!Array.isArray(records)) throw new TypeError("collector records must be an array");
  if (typeof priceUsage !== "function") throw new TypeError("priceUsage callback is required");

  const diagnostics = {
    inputRecords: records.length,
    eligibleRecords: 0,
    emittedTransitions: 0,
    exclusions: {
      unattributed: 0,
      stale: 0,
      resetBoundary: 0,
      regression: 0,
      nonmovement: 0,
      malformed: 0,
      duplicateEventKey: 0,
      conflictingEventKey: 0,
      slotConflict: 0,
      unsupportedPolicyEpoch: 0,
    },
  };
  const validated = [];
  for (const record of records) {
    if (!isPlainObject(record)) {
      diagnostics.exclusions.malformed += 1;
      continue;
    }
    if (record.accountScope?.status !== "available") {
      diagnostics.exclusions.unattributed += 1;
      continue;
    }
    const type = classifyRecord(record);
    if (type === null) {
      diagnostics.exclusions.malformed += 1;
      continue;
    }
    if (record.stalenessMs > MAXIMUM_STALENESS_MS) {
      diagnostics.exclusions.stale += 1;
      continue;
    }
    if (Date.parse(record.observedAt) < AGENTIC_POOL_POLICY_START_MS) {
      diagnostics.exclusions.unsupportedPolicyEpoch += 1;
      continue;
    }
    validated.push({ type, record });
  }

  const eligible = deduplicate(validated, diagnostics);
  diagnostics.eligibleRecords = eligible.length;
  const eligibleTimes = eligible.map(({ record }) => Date.parse(record.observedAt));
  const usageByPartition = new Map();
  const toolsByAccountPlan = new Map();
  const snapshotsByPartition = new Map();
  const snapshotsByResetlessPartition = new Map();

  for (const item of eligible) {
    const { record } = item;
    const accountPlanKey = [
      record.accountScope.scopeId,
      record.provider,
      record.accountScope.planType,
    ].join("\u0000");
    if (item.type === "usage") {
      if (record.components !== null) {
        const priced = {
          record,
          timestampMs: Date.parse(record.observedAt),
          priceUsd: priceRecord(record, priceUsage),
        };
        for (const window of record.windows) {
          const key = partitionKey(record.accountScope.scopeId, window);
          const values = usageByPartition.get(key) ?? [];
          values.push(priced);
          usageByPartition.set(key, values);
        }
      }
    } else if (item.type === "tool") {
      const values = toolsByAccountPlan.get(accountPlanKey) ?? [];
      values.push({ record, timestampMs: Date.parse(record.observedAt) });
      toolsByAccountPlan.set(accountPlanKey, values);
    }

    if (item.type === "usage" || item.type === "quota") {
      for (const window of record.windows) {
        const snapshot = {
          accountScopeId: record.accountScope.scopeId,
          eventKey: record.eventKey,
          observedAt: record.observedAt,
          timestampMs: Date.parse(record.observedAt),
          window,
        };
        const key = partitionKey(snapshot.accountScopeId, window);
        const values = snapshotsByPartition.get(key) ?? [];
        values.push(snapshot);
        snapshotsByPartition.set(key, values);
        const resetlessKey = partitionKey(snapshot.accountScopeId, window, false);
        const resetless = snapshotsByResetlessPartition.get(resetlessKey) ?? [];
        resetless.push(snapshot);
        snapshotsByResetlessPartition.set(resetlessKey, resetless);
      }
    }
  }

  for (const values of usageByPartition.values()) {
    values.sort((left, right) => (
      left.timestampMs - right.timestampMs || left.record.eventKey.localeCompare(right.record.eventKey)
    ));
  }
  for (const values of toolsByAccountPlan.values()) {
    values.sort((left, right) => (
      left.timestampMs - right.timestampMs || left.record.eventKey.localeCompare(right.record.eventKey)
    ));
  }
  for (const snapshots of snapshotsByResetlessPartition.values()) {
    snapshots.sort((left, right) => (
      left.timestampMs - right.timestampMs || left.eventKey.localeCompare(right.eventKey)
    ));
    for (let index = 1; index < snapshots.length; index += 1) {
      if (snapshots[index - 1].window.resetsAt !== snapshots[index].window.resetsAt) {
        diagnostics.exclusions.resetBoundary += 1;
      }
    }
  }

  const transitions = [];
  for (const rawSnapshots of snapshotsByPartition.values()) {
    const snapshots = collapseSlotObservations(rawSnapshots, diagnostics);
    if (snapshots.length === 0) continue;
    let aggregationStart = snapshots[0];
    for (let index = 1; index < snapshots.length; index += 1) {
      const prior = snapshots[index - 1];
      const next = snapshots[index];
      if (next.window.usedPercent < prior.window.usedPercent) {
        diagnostics.exclusions.regression += 1;
        aggregationStart = next;
        continue;
      }
      if (next.window.usedPercent === prior.window.usedPercent) {
        diagnostics.exclusions.nonmovement += 1;
        continue;
      }
      const accountPlanKey = [
        prior.accountScopeId, prior.window.provider, prior.window.planType,
      ].join("\u0000");
      const usagePartitionKey = partitionKey(prior.accountScopeId, prior.window);
      const components = emptyComponents();
      const tierUsageEventCounts = emptyTierCounts();
      const aggregateToolClassMix = emptyToolCounts();
      let marginalApiPricedUsd = 0;
      let marginalUsageEventCount = 0;
      for (const usage of usageByPartition.get(usagePartitionKey) ?? []) {
        const usagePosition = {
          timestampMs: usage.timestampMs,
          eventKey: usage.record.eventKey,
        };
        if (
          compareEventPosition(usagePosition, aggregationStart) <= 0
          || compareEventPosition(usagePosition, next) > 0
        ) continue;
        addComponents(components, usage.record.components);
        marginalApiPricedUsd += usage.priceUsd;
        marginalUsageEventCount += 1;
        tierUsageEventCounts[usage.record.tierSemantics.codexSpeedMode] += 1;
      }
      for (const tool of toolsByAccountPlan.get(accountPlanKey) ?? []) {
        const toolPosition = {
          timestampMs: tool.timestampMs,
          eventKey: tool.record.eventKey,
        };
        if (
          compareEventPosition(toolPosition, aggregationStart) <= 0
          || compareEventPosition(toolPosition, next) > 0
        ) continue;
        aggregateToolClassMix[tool.record.toolClass] += 1;
      }
      transitions.push({
        accountScopeId: prior.accountScopeId,
        planVariant: "unknown",
        provider: prior.window.provider,
        planType: prior.window.planType,
        limitId: prior.window.limitId,
        slot: "duration_led",
        windowDurationMins: prior.window.windowDurationMins,
        resetsAt: prior.window.resetsAt,
        resetIdentity: new Date(prior.window.resetsAt * 1_000).toISOString(),
        eventTime: next.observedAt,
        priorUsedPercent: prior.window.usedPercent,
        nextUsedPercent: next.window.usedPercent,
        lastPriorObservedAt: prior.observedAt,
        firstNextObservedAt: next.observedAt,
        marginalApiPricedUsd,
        marginalUsageEventCount,
        marginalComponents: components,
        tierUsageEventCounts,
        aggregateToolClassMix,
        controlledState: "unknown",
        snapshot: {
          identity: "duration_led_slot_is_metadata",
          priorSlot: prior.window.slot,
          nextSlot: next.window.slot,
          policyEpoch: "openai_agentic_pool_2026_07_09",
        },
      });
      aggregationStart = next;
    }
  }
  transitions.sort(transitionOrder);
  diagnostics.emittedTransitions = transitions.length;

  return {
    schemaVersion: PROSPECTIVE_COLLECTOR_TRANSITIONS_SCHEMA_VERSION,
    sourceSchemaVersion: COLLECTOR_SCHEMA_VERSION,
    localOnly: true,
    accountPartitioning: "available_openai_account_scope_no_cross_account_pooling",
    policyEpoch: "openai_agentic_pool_2026_07_09",
    scope: {
      startAt: eligibleTimes.length > 0
        ? new Date(Math.min(...eligibleTimes)).toISOString()
        : null,
      endAt: eligibleTimes.length > 0
        ? new Date(Math.max(...eligibleTimes)).toISOString()
        : null,
    },
    transitions,
    diagnostics,
  };
}
