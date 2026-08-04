import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  createIndexedCodexLogScan,
  defaultLocalAnalysisIndexSecretPath,
  readLocalAnalysisIndexProjection,
  writeLocalAnalysisIndexProjection,
} from "./local-analysis-index.js";
import {
  CODEX_TRANSITION_DERIVATION_CEILINGS,
  deriveCodexTransitionSeriesCooperatively,
  PARSER_VERSION,
} from "./codex-transition-miner.js";
import {
  createExportResourceGuard,
  ExportResourceLimitError,
} from "./export-resource-policy.js";
import {
  addUsdStrings,
  costWarningCodes,
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  priceCodexUsageEvent,
  APP_PRICE_REGISTRY_MANIFEST,
} from "@app-usagemonitor/accounting";
import { writeJsonOwnerOnlyAtomic } from "./storage.js";
import {
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  projectBoundedWeeklyCalibrationSummary,
} from "./reporting/index.js";
import { fastQuotaMultiplier } from "./application/index.js";

export const REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION =
  "local-replay-safe-accounting-v0.2";

const HISTORICAL_PRICE_EPOCH_BASIS =
  "event_time_when_registry_has_effective_evidence";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const DEFAULT_WINDOW_DAYS = 31;
const TIMELINE_BUCKET_MS = 15 * 60 * 1_000;
const MAX_QUOTA_TIMELINE_ROWS = 10_000;
const WEEKLY_WINDOW_MINUTES = 10_080;
const MAX_RETAINED_TRANSITION_BYTES = 320 * 1024 * 1024;
const MAX_ACCOUNTING_RSS_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
const ACCOUNTING_RSS_CHECK_INTERVAL = 2_048;
const COMPACT_USAGE_RETAINED_BYTES = 256;
const COMPACT_SNAPSHOT_RETAINED_BYTES = 192;
const DEFAULT_TRANSITION_RESOURCE_LIMITS = Object.freeze({
  usageEvents: CODEX_TRANSITION_DERIVATION_CEILINGS.usageEvents,
  weeklySnapshots:
    CODEX_TRANSITION_DERIVATION_CEILINGS.rateLimitSnapshots,
  combinedInputs: CODEX_TRANSITION_DERIVATION_CEILINGS.totalInputs,
  retainedBytes: MAX_RETAINED_TRANSITION_BYTES,
});
const COMPONENT_KEYS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
]);
const KNOWN_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-4.1",
]);
const SPEEDS = new Set(["standard", "fast", "flex", "batch", "unknown"]);
const API_TIERS = new Set(["standard", "priority", "flex", "batch", "unknown"]);
const SURFACES = new Set([
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
const AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
const LINEAGE = new Set(["standalone", "forked", "parent_linked", "unknown"]);
const QUOTA_PLANS = new Set([
  "free",
  "plus",
  "pro",
  "team",
  "business",
  "enterprise",
]);
const QUOTA_SLOTS = new Set(["primary", "secondary"]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function accountingScanResourceError(error) {
  const code = error?.code;
  if (!(error instanceof ExportResourceLimitError)
      && (typeof code !== "string"
        || !code.startsWith("export_resource_"))) return null;
  const suffix = code.slice("export_resource_".length);
  return fixedError(`accounting_scan_${suffix}_limit_exceeded`);
}

function validAbortSignal(signal) {
  return signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function");
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = fixedError("accounting_refresh_aborted");
  error.name = "AbortError";
  throw error;
}

function transitionResourceLimits(value) {
  if (value === null || value === undefined) {
    return DEFAULT_TRANSITION_RESOURCE_LIMITS;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("transitionResourceLimits must be an object or null");
  }
  const ceilings = {
    usageEvents: CODEX_TRANSITION_DERIVATION_CEILINGS.usageEvents,
    weeklySnapshots:
      CODEX_TRANSITION_DERIVATION_CEILINGS.rateLimitSnapshots,
    combinedInputs: CODEX_TRANSITION_DERIVATION_CEILINGS.totalInputs,
    retainedBytes: MAX_RETAINED_TRANSITION_BYTES,
  };
  const allowed = new Set(Object.keys(ceilings));
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("transitionResourceLimits contains an unknown key");
  }
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => {
    const selected = value[key] ?? ceiling;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > ceiling) {
      throw new TypeError(
        `transitionResourceLimits.${key} must be between 1 and ${ceiling}`,
      );
    }
    return [key, selected];
  }));
}

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function emptyComponents() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0]));
}

function emptyComponentCosts() {
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

function tokenTotal(components) {
  const input = (components.input_uncached_tokens ?? 0)
    + (components.input_cache_read_tokens ?? 0)
    + (components.input_cache_write_tokens ?? 0);
  const separatedOutput = (components.output_text_tokens ?? 0)
    + (components.output_reasoning_tokens ?? 0);
  const combinedOutput = components.output_combined_tokens ?? 0;
  return input + (combinedOutput > 0 ? combinedOutput : separatedOutput);
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

function safeModel(value) {
  return KNOWN_MODELS.has(value) ? value : "unknown";
}

function emptyDimension(keys) {
  return Object.fromEntries([...keys].map((key) => [
    key,
    { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
  ]));
}

function newPeriod(id, label) {
  return {
    id,
    label,
    events: 0,
    totalTokens: 0,
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
    apiPriceEquivalentUsd: 0,
    apiPriceEquivalentUsdExact: "0",
    priceCardIds: [],
    priceCardBreakdown: {},
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
    byModel: {},
    bySpeed: emptyDimension(SPEEDS),
    byApiServiceTier: emptyDimension(API_TIERS),
    bySurface: emptyDimension(SURFACES),
    byAgentScope: emptyDimension(AGENT_SCOPES),
    byLineage: emptyDimension(LINEAGE),
    // Observed speed mode crossed with the model's published Fast credit rate
    // family. The crossing is what lets the owner's Fast-mode preference be
    // applied at read time without rebuilding this cache.
    speedWeighting: emptySpeedWeightingCrossing(),
    // The same crossing, holding only the events the log left UNOBSERVED that
    // a timestamped Codex `service_tier` reading actually covers. Kept apart
    // from the observed crossing so a declaration can never be read back as an
    // observation.
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
  };
}

function addComponents(target, source) {
  for (const key of COMPONENT_KEYS) {
    const value = source?.[key];
    if (Number.isSafeInteger(value) && value >= 0) target[key] += value;
  }
}

function addDimension(target, key, event) {
  const row = target[key] ?? target.unknown;
  row.events += 1;
  row.totalTokens += event.totalTokens;
  row.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
}

function addComponentCosts(target, components, priced) {
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

const FAST_PRICE_SCALE = 1_000_000_000;

function scaledUsdString(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return "0";
  const whole = Math.floor(value / FAST_PRICE_SCALE);
  const fraction = String(value % FAST_PRICE_SCALE).padStart(9, "0");
  return `${whole}.${fraction}`.replace(/\.?0+$/u, "");
}

function createAccountingPricer() {
  const plans = new Map();
  return (event, components) => {
    const contextBand =
      Number(event.totalInputContextTokens) >= 272_000
        ? "long"
        : "short";
    // Keep the effective date in the fast-plan key: official price cards may
    // change by date, and a later plan must never price an earlier event.
    const effectiveDate = canonicalInstant(event.timestamp)?.slice(0, 10)
      ?? "missing_timestamp";
    const key = `${event.model}\0${contextBand}\0${effectiveDate}`;
    let plan = plans.get(key);
    if (plan === undefined) {
      const templateComponents = Object.fromEntries(
        COMPONENT_KEYS.map((name) => [
          name,
          name === "output_combined_tokens" ? 0 : 1,
        ]),
      );
      const template = priceCodexUsageEvent({
        ...event,
        totalInputContextTokens:
          contextBand === "long" ? 272_000 : 0,
        components: templateComponents,
      }, {
        apiServiceTier: "standard",
        priceEpochBasis: "event_time",
      });
      const rows = new Map(template.components.map((row) => [
        row.name,
        row,
      ]));
      plan = template.coverageStatus === "fully_priced"
          && [...COMPONENT_KEYS]
            .filter((name) => name !== "output_combined_tokens")
            .every((name) => (
              typeof rows.get(name)?.unitPriceUsd === "string"
              && /^\d+(?:\.\d{1,9})?$/u.test(
                rows.get(name).unitPriceUsd,
              )
            ))
        ? {
          rows,
          warnings: template.warnings,
          selectedPriceCardIds: template.selectedPriceCardIds,
        }
        : null;
      plans.set(key, plan);
    }
    if (plan === null) {
      return priceCodexUsageEvent({
        ...event,
        components,
      }, {
        apiServiceTier: "standard",
        priceEpochBasis: "event_time",
      });
    }
    const pricedComponents = [];
    const priceCardBreakdown = new Map();
    let totalUsdScaled = 0;
    for (const name of COMPONENT_KEYS) {
      const quantity = components[name] ?? 0;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
      const template = plan.rows.get(name);
      if (!template || typeof template.unitPriceUsd !== "string") {
        return priceCodexUsageEvent({
          ...event,
          components,
        }, {
          apiServiceTier: "standard",
          priceEpochBasis: "event_time",
        });
      }
      const unitPriceScaled = Math.round(
        Number(template.unitPriceUsd) * FAST_PRICE_SCALE,
      );
      const costUsdScaled = unitPriceScaled * quantity;
      if (!Number.isSafeInteger(costUsdScaled)
          || !Number.isSafeInteger(
            totalUsdScaled + costUsdScaled,
          )) {
        return priceCodexUsageEvent({
          ...event,
          components,
        }, {
          apiServiceTier: "standard",
          priceEpochBasis: "event_time",
        });
      }
      totalUsdScaled += costUsdScaled;
      pricedComponents.push({
        name,
        pricedAs: template.pricedAs,
        quantity: String(quantity),
        unit: template.unit,
        pricingStatus: "priced",
        unitPriceUsd: template.unitPriceUsd,
        costUsd: scaledUsdString(costUsdScaled),
        priceCardId: template.priceCardId,
      });
      const card = priceCardBreakdown.get(template.priceCardId) ?? {
        priceCardId: template.priceCardId,
        events: 0,
        costUsd: "0",
      };
      card.events = 1;
      card.costUsd = addUsdStrings(card.costUsd, scaledUsdString(costUsdScaled));
      priceCardBreakdown.set(template.priceCardId, card);
    }
    return {
      totalUsd: scaledUsdString(totalUsdScaled),
      coverageStatus: "fully_priced",
      components: pricedComponents,
      selectedPriceCardIds: plan.selectedPriceCardIds,
      priceCardBreakdown: [...priceCardBreakdown.values()].sort(
        (left, right) => left.priceCardId.localeCompare(right.priceCardId),
      ),
      warnings: plan.warnings,
    };
  };
}

function eventProjection(event, price) {
  const components = emptyComponents();
  addComponents(components, event.components);
  const separatedOutput = components.output_text_tokens
    + components.output_reasoning_tokens;
  // Prefer the more informative non-overlapping split when both the split and
  // a combined alias are present. A combined-only count is preserved for
  // display, but normalized to ordinary output solely for API pricing.
  if (components.output_combined_tokens > 0 && separatedOutput > 0) {
    components.output_combined_tokens = 0;
  }
  const totalTokens = tokenTotal(components);
  if (totalTokens === 0) return null;
  const model = safeModel(event.model);
  const combinedOnly = components.output_combined_tokens > 0;
  const pricingComponents = combinedOnly
    ? {
      ...components,
      output_text_tokens: components.output_combined_tokens,
      output_combined_tokens: 0,
    }
    : components;
  let priced;
  try {
    priced = price({
      ...event,
      model,
    }, pricingComponents);
    if (combinedOnly) {
      priced = {
        ...priced,
        components: priced.components.map((row) => (
          row.name === "output_text_tokens"
            ? {
              ...row,
              name: "output_combined_tokens",
              pricedAs: "output_text_tokens",
            }
            : row
        )),
      };
    }
  } catch {
    priced = {
      totalUsd: "0",
      coverageStatus: "unpriced",
      components: [],
    };
  }
  const cost = Number(priced.totalUsd);
  return {
    timestamp: event.timestamp,
    model,
    components,
    totalTokens,
    priced,
    apiPriceEquivalentUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    pricingCoverageStatus: ["fully_priced", "partially_priced"].includes(
      priced.coverageStatus,
    )
      ? priced.coverageStatus
      : "unpriced",
    speed: safeEnum(event.tierSemantics?.codexSpeedMode, SPEEDS),
    apiServiceTier: safeEnum(
      event.tierSemantics?.apiServiceTier,
      API_TIERS,
    ),
    surface: safeEnum(event.surfaceClassification?.surface, SURFACES),
    agentScope: safeEnum(
      event.surfaceClassification?.agentScope,
      AGENT_SCOPES,
    ),
    lineage: safeEnum(
      event.surfaceClassification?.lineageDisposition,
      LINEAGE,
    ),
  };
}

function transitionUsageProjection(event, projection) {
  const components = COMPONENT_KEYS.map((key) => (
    Number.isSafeInteger(event.components?.[key])
      && event.components[key] >= 0
      ? event.components[key]
      : 0
  ));
  const costUsd = Number(projection.priced.totalUsd);
  const multiplier = fastQuotaMultiplier(projection.model);
  const fastWeightedEquivalentUsd =
    multiplier === null ? null : costUsd * multiplier;
  const quotaWeightedLowerUsd = projection.speed === "fast"
    ? fastWeightedEquivalentUsd
    : costUsd;
  const quotaWeightedUpperUsd = projection.speed === "standard"
    ? costUsd
    : fastWeightedEquivalentUsd;
  return [
    canonicalInstant(event.timestamp),
    projection.model,
    Number.isSafeInteger(event.totalInputContextTokens)
      && event.totalInputContextTokens >= 0
      ? event.totalInputContextTokens
      : 0,
    ...components,
    projection.speed,
    Number.isFinite(costUsd) ? costUsd : 0,
    projection.priced.totalUsd,
    projection.priced.coverageStatus,
    fastWeightedEquivalentUsd,
    quotaWeightedLowerUsd,
    quotaWeightedUpperUsd,
    costWarningCodes(projection.priced),
    projection.priced.warnings.coverage
      .map((warning) => warning.code)
      .sort(),
    projection.priced.selectedPriceCardIds,
    projection.priced.priceCardBreakdown ?? [],
  ];
}

function weeklyRateLimitProjection(snapshot) {
  const window = snapshot.window;
  const boundedText = (value) => (
    typeof value === "string"
      && value.length > 0
      && value.length <= 64
      ? value
      : "unknown"
  );
  return [
    canonicalInstant(snapshot.timestamp),
    Number.isFinite(snapshot.timestampMs)
      ? snapshot.timestampMs
      : Date.parse(snapshot.timestamp),
    boundedText(window.provider),
    boundedText(window.planType),
    boundedText(window.limitId),
    boundedText(window.slot),
    window.windowDurationMins,
    window.resetsAt,
    window.usedPercent,
  ];
}

function weeklyQuotaTimelineProjection(snapshot) {
  const observedAt = canonicalInstant(snapshot?.timestamp);
  const window = snapshot?.window;
  // Keep only the fixed main Codex weekly family used by the UI calibration.
  // The high-churn codex_bengalfox family is a different track, not a
  // substitute for missing observations on this allowance.
  if (observedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== "codex"
      || !QUOTA_SLOTS.has(window.slot)
      || window.windowDurationMins !== WEEKLY_WINDOW_MINUTES
      || typeof window.usedPercent !== "number"
      || !Number.isFinite(window.usedPercent)
      || window.usedPercent < 0
      || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt)
      || window.resetsAt <= 0) {
    return null;
  }
  const resetDate = new Date(window.resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  const resetAt = resetDate.toISOString();
  const usedPercent = Number(window.usedPercent.toFixed(3));
  return {
    observedAt,
    limitId: "codex",
    slot: window.slot,
    planType: QUOTA_PLANS.has(window.planType)
      ? window.planType
      : "unknown",
    usedPercent,
    remainingPercent: Number(Math.max(0, 100 - usedPercent).toFixed(3)),
    durationMinutes: WEEKLY_WINDOW_MINUTES,
    resetAt,
    accountAttribution: "historical_unattributed",
  };
}

function quotaTimelineTrackBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  const bucketStartMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  return `${bucketStartMs}:${row.limitId}:${row.slot}:${row.durationMinutes}`;
}

function quotaTimelineRowTieBreak(row) {
  return [
    row.planType,
    row.usedPercent.toFixed(3),
    row.resetAt,
  ].join("\0");
}

function retainWeeklyQuotaTimeline(buckets, snapshot) {
  const row = weeklyQuotaTimelineProjection(snapshot);
  if (row === null) return;
  const key = quotaTimelineTrackBucketKey(row);
  const prior = buckets.get(key);
  if (prior === undefined
      || row.observedAt > prior.observedAt
      || (row.observedAt === prior.observedAt
        && quotaTimelineRowTieBreak(row)
          < quotaTimelineRowTieBreak(prior))) {
    buckets.set(key, row);
  }
}

function finalizeWeeklyQuotaTimeline(buckets) {
  const rows = [...buckets.values()].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.limitId.localeCompare(right.limitId)
    || left.slot.localeCompare(right.slot)
    || left.resetAt.localeCompare(right.resetAt)
    || left.planType.localeCompare(right.planType)
    || left.usedPercent - right.usedPercent
  ));
  return rows.length <= MAX_QUOTA_TIMELINE_ROWS
    ? rows
    : rows.slice(rows.length - MAX_QUOTA_TIMELINE_ROWS);
}

function addSpeedWeighting(crossing, event) {
  // "fast", "standard" and "unknown" are the only observed values; anything
  // else collapses to unknown rather than being treated as Standard.
  const speed = crossing[event.speed] ? event.speed : "unknown";
  const cell = crossing[speed][fastModeModelFamilyKey(event.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
}

function addDeclaredSpeedWeighting(crossing, event) {
  // Only a declaration that resolved to a real mode is recorded, and only for
  // events the log left unobserved; everything else is left unattributed.
  if (event.declaredSpeed !== "standard" && event.declaredSpeed !== "fast") {
    return;
  }
  const cell = crossing[event.declaredSpeed][fastModeModelFamilyKey(event.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
}

function finalizeSpeedWeighting(crossing) {
  return Object.fromEntries(Object.entries(crossing).map(([speed, families]) => [
    speed,
    Object.fromEntries(Object.entries(families).map(([family, cell]) => [
      family,
      { ...cell, apiPriceEquivalentUsd: roundedMoney(cell.apiPriceEquivalentUsd) },
    ])),
  ]));
}

function addEvent(period, event) {
  period.events += 1;
  period.totalTokens += event.totalTokens;
  period.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  period.apiPriceEquivalentUsdExact = addUsdStrings(
    period.apiPriceEquivalentUsdExact,
    event.priced?.totalUsd ?? "0",
  );
  addComponents(period.components, event.components);
  addComponentCosts(period.componentCosts, event.components, event.priced);
  for (const id of event.priced?.selectedPriceCardIds ?? []) {
    if (!period.priceCardIds.includes(id)) period.priceCardIds.push(id);
  }
  for (const item of event.priced?.priceCardBreakdown ?? []) {
    const row = period.priceCardBreakdown[item.priceCardId] ?? {
      priceCardId: item.priceCardId,
      events: 0,
      costUsd: "0",
    };
    row.events += item.events ?? 0;
    row.costUsd = addUsdStrings(row.costUsd, item.costUsd ?? "0");
    period.priceCardBreakdown[item.priceCardId] = row;
  }
  const model = period.byModel[event.model] ??= {
    model: event.model,
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
  };
  model.events += 1;
  model.totalTokens += event.totalTokens;
  model.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  model.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += 1;
  addDimension(period.bySpeed, event.speed, event);
  addSpeedWeighting(period.speedWeighting, event);
  addDeclaredSpeedWeighting(period.declaredSpeedWeighting, event);
  addDimension(period.byApiServiceTier, event.apiServiceTier, event);
  addDimension(period.bySurface, event.surface, event);
  addDimension(period.byAgentScope, event.agentScope, event);
  addDimension(period.byLineage, event.lineage, event);
  if (event.pricingCoverageStatus === "fully_priced") {
    period.pricingCoverage.fullyPricedEvents += 1;
  } else if (event.pricingCoverageStatus === "partially_priced") {
    period.pricingCoverage.partiallyPricedEvents += 1;
  } else {
    period.pricingCoverage.unpricedEvents += 1;
  }
}

function roundedMoney(value) {
  return Number(value.toFixed(6));
}

function finalizeDimension(dimension) {
  return Object.fromEntries(Object.entries(dimension).map(([key, row]) => [
    key,
    {
      ...row,
      apiPriceEquivalentUsd: roundedMoney(row.apiPriceEquivalentUsd),
    },
  ]));
}

function finalizePeriod(period) {
  const priced = period.pricingCoverage.fullyPricedEvents
    + period.pricingCoverage.partiallyPricedEvents;
  return {
    ...period,
    apiPriceEquivalentUsd: roundedMoney(period.apiPriceEquivalentUsd),
    priceCardIds: [...period.priceCardIds].sort(),
    priceCardBreakdown: Object.values(period.priceCardBreakdown).sort(
      (left, right) => left.priceCardId.localeCompare(right.priceCardId),
    ),
    pricedEventFraction: period.events === 0
      ? null
      : Number((priced / period.events).toFixed(6)),
    componentCosts: Object.fromEntries(
      Object.entries(period.componentCosts).map(([key, row]) => [
        key,
        { ...row, costUsd: roundedMoney(row.costUsd) },
      ]),
    ),
    byModel: Object.values(period.byModel)
      .map((row) => ({
        ...row,
        apiPriceEquivalentUsd: roundedMoney(row.apiPriceEquivalentUsd),
      }))
      .sort((left, right) => (
        right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd
        || right.totalTokens - left.totalTokens
        || left.model.localeCompare(right.model)
      )),
    bySpeed: finalizeDimension(period.bySpeed),
    byApiServiceTier: finalizeDimension(period.byApiServiceTier),
    bySurface: finalizeDimension(period.bySurface),
    byAgentScope: finalizeDimension(period.byAgentScope),
    byLineage: finalizeDimension(period.byLineage),
    speedWeighting: finalizeSpeedWeighting(period.speedWeighting),
    declaredSpeedWeighting: finalizeSpeedWeighting(
      period.declaredSpeedWeighting,
    ),
  };
}

function newTimelineBucket(startMs) {
  return {
    startMs,
    usageEvents: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    components: emptyComponents(),
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
  };
}

function addTimelineEvent(buckets, event) {
  const observedMs = Date.parse(event.timestamp);
  if (!Number.isFinite(observedMs)) return;
  const startMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  const bucket = buckets.get(startMs) ?? newTimelineBucket(startMs);
  bucket.usageEvents += 1;
  bucket.totalTokens += event.totalTokens;
  bucket.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addComponents(bucket.components, event.components);
  bucket.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += 1;
  buckets.set(startMs, bucket);
}

function finalizeTimeline(buckets) {
  return [...buckets.values()]
    .sort((left, right) => left.startMs - right.startMs)
    .map((bucket) => ({
      startAt: new Date(bucket.startMs).toISOString(),
      endAt: new Date(bucket.startMs + TIMELINE_BUCKET_MS).toISOString(),
      usageEvents: bucket.usageEvents,
      totalTokens: bucket.totalTokens,
      apiPriceEquivalentUsd: roundedMoney(bucket.apiPriceEquivalentUsd),
      components: bucket.components,
      pricingCoverage: bucket.pricingCoverage,
    }));
}

function publicDiagnostics(value) {
  return {
    filesScanned: Number.isSafeInteger(value?.filesScanned)
      ? value.filesScanned
      : 0,
    forkReplayEventsExcluded: Number.isSafeInteger(value?.forkReplayEventsSkipped)
      ? value.forkReplayEventsSkipped
      : 0,
    unattributedForkReplayEventsExcluded:
      Number.isSafeInteger(value?.unattributedForkReplayEventsSkipped)
        ? value.unattributedForkReplayEventsSkipped
        : 0,
    duplicateSnapshotsExcluded:
      Number.isSafeInteger(value?.duplicateSnapshotsSkipped)
        ? value.duplicateSnapshotsSkipped
        : 0,
    contradictedLeadingSnapshotsExcluded:
      Number.isSafeInteger(value?.contradictedLeadingSnapshotsSkipped)
        ? value.contradictedLeadingSnapshotsSkipped
        : 0,
    missingLineageParents: Number.isSafeInteger(value?.lineageParentsMissing)
      ? value.lineageParentsMissing
      : 0,
  };
}

export function defaultReplaySafeAccountingCachePath(
  root = process.cwd(),
) {
  return resolve(
    root,
    ".usage-monitor",
    "local-replay-safe-accounting-v0.2.json",
  );
}

export async function buildReplaySafeAccountingCache({
  codexHome = join(homedir(), ".codex"),
  now = () => Date.now(),
  windowDays = DEFAULT_WINDOW_DAYS,
  scan = scanCodexLogEvents,
  signal = null,
  // Timestamped Codex `service_tier` readings. Each covers only the interval
  // it was actually observed over, so a reading can never reach back before it
  // happened. An absent or unreadable ledger is simply no coverage.
  declaredSpeedBaselines = [],
  transitionResourceLimits: requestedTransitionResourceLimits = null,
  rss = () => process.memoryUsage().rss,
  maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
} = {}) {
  const endMs = now();
  if (!Number.isFinite(endMs)
      || !Number.isSafeInteger(windowDays)
      || windowDays < 1
      || windowDays > 93
      || typeof scan !== "function"
      || !validAbortSignal(signal)
      || typeof rss !== "function"
      || !Number.isSafeInteger(maximumRssBytes)
      || maximumRssBytes < 1) {
    throw new TypeError("Replay-safe accounting options are invalid");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  const checkRuntimeMemory = () => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_transition_rss_measurement_invalid");
    }
    if (currentRss > maximumRssBytes) {
      throw fixedError("accounting_transition_rss_limit_exceeded");
    }
  };
  checkRuntimeMemory();
  const scanResourceGuard = createExportResourceGuard({
    limits: { maximumRssBytes },
    clock: now,
    rss,
  });
  const limits = transitionResourceLimits(
    requestedTransitionResourceLimits,
  );
  throwIfAborted(signal);
  const startMs = endMs - windowDays * 24 * 60 * 60 * 1_000;
  const starts = {
    "24h": endMs - 24 * 60 * 60 * 1_000,
    "7d": endMs - 7 * 24 * 60 * 60 * 1_000,
    "30d": endMs - 30 * 24 * 60 * 60 * 1_000,
    all: startMs,
  };
  const periods = new Map([
    ["24h", newPeriod("24h", "Last 24 hours")],
    ["7d", newPeriod("7d", "Last 7 days")],
    ["30d", newPeriod("30d", "Last 30 days")],
    ["all", newPeriod("all", `Cached ${windowDays}-day window`)],
  ]);
  const timeline = new Map();
  const weeklyQuotaTimelineBuckets = new Map();
  const rawUsageEvents = [];
  const weeklyRateLimitSnapshots = [];
  const price = createAccountingPricer();
  let retainedTransitionBytes = 0;
  let retainedTransitionInputs = 0;
  const reserveTransitionInput = (kind) => {
    const usageCount = rawUsageEvents.length;
    const snapshotCount = weeklyRateLimitSnapshots.length;
    const combinedCount = usageCount + snapshotCount;
    if (kind === "usage" && usageCount >= limits.usageEvents) {
      throw fixedError("accounting_transition_usage_limit_exceeded");
    }
    if (kind === "snapshot" && snapshotCount >= limits.weeklySnapshots) {
      throw fixedError("accounting_transition_snapshot_limit_exceeded");
    }
    if (combinedCount >= limits.combinedInputs) {
      throw fixedError("accounting_transition_input_limit_exceeded");
    }
    const retainedBytes = kind === "usage"
      ? COMPACT_USAGE_RETAINED_BYTES
      : COMPACT_SNAPSHOT_RETAINED_BYTES;
    if (retainedTransitionBytes + retainedBytes > limits.retainedBytes) {
      throw fixedError("accounting_transition_memory_budget_exceeded");
    }
    retainedTransitionBytes += retainedBytes;
    retainedTransitionInputs += 1;
    if (retainedTransitionInputs % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      checkRuntimeMemory();
    }
  };
  let scanned;
  try {
    scanned = await scan({
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      codexHome,
      resourceGuard: scanResourceGuard,
      signal,
      onUsage: (rawEvent) => {
        throwIfAborted(signal);
        const observedAt = canonicalInstant(rawEvent?.timestamp);
        if (observedAt === null) return;
        const observedMs = Date.parse(observedAt);
        if (observedMs < startMs || observedMs > endMs + 5 * 60_000) return;
        const event = eventProjection(rawEvent, price);
        if (event === null) return;
        // An observed tier always wins, so a declaration is only ever looked
        // up for the turns the rollout log left unobserved.
        event.declaredSpeed = event.speed === "unknown"
          ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
          : "unknown";
        reserveTransitionInput("usage");
        rawUsageEvents.push(transitionUsageProjection(rawEvent, event));
        for (const [id, period] of periods) {
          if (observedMs >= starts[id]) addEvent(period, event);
        }
        addTimelineEvent(timeline, event);
      },
      onRateLimitSnapshot: (snapshot) => {
        throwIfAborted(signal);
        if (snapshot?.window?.windowDurationMins === 10_080) {
          const observedAt = canonicalInstant(snapshot.timestamp);
          const observedMs = observedAt === null
            ? Number.NaN
            : Date.parse(observedAt);
          if (!Number.isFinite(observedMs)
              || observedMs < startMs
              || observedMs > endMs) return;
          reserveTransitionInput("snapshot");
          weeklyRateLimitSnapshots.push(weeklyRateLimitProjection(snapshot));
          retainWeeklyQuotaTimeline(weeklyQuotaTimelineBuckets, snapshot);
        }
      },
    });
  } catch (error) {
    const bounded = accountingScanResourceError(error);
    if (bounded !== null) throw bounded;
    throw error;
  }
  throwIfAborted(signal);
  checkRuntimeMemory();
  const retainedUsageEvents = rawUsageEvents.length;
  const retainedWeeklySnapshots = weeklyRateLimitSnapshots.length;
  let transitionSeries;
  try {
    transitionSeries = await deriveCodexTransitionSeriesCooperatively({
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      rawUsageEvents,
      rateLimitSnapshots: weeklyRateLimitSnapshots,
      diagnostics: scanned?.diagnostics ?? {},
      includeSnapshotIntervals: false,
      windowDurationMins: 10_080,
      signal,
      consumeInputs: true,
      includeNormalizedInputs: false,
      inputEncoding: "accounting_prepriced_compact_v2",
      resourceCheck: checkRuntimeMemory,
    });
  } catch (error) {
    if (error?.name === "AbortError"
        || error?.code === "transition_derivation_aborted") {
      const aborted = fixedError("accounting_refresh_aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
    if ([
      "transition_derivation_input_limit_exceeded",
      "transition_derivation_row_limit_exceeded",
      "transition_derivation_work_limit_exceeded",
    ].includes(error?.code)) {
      throw fixedError("accounting_transition_derivation_limit_exceeded");
    }
    throw error;
  }
  const weeklyCalibration = projectBoundedWeeklyCalibrationSummary({
    parserVersion: PARSER_VERSION,
    scope: {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      snapshotIntervalsIncluded: false,
    },
    pricing: {
      basis: "standard_openai_api_prices_not_codex_subscription_credits",
    },
    summary: {
      deduplicatedRateLimitSnapshots:
        transitionSeries.deduplicatedSnapshotCount,
    },
    transitions: transitionSeries.transitions,
  });
  throwIfAborted(signal);
  return {
    schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
    generatedAt: new Date(endMs).toISOString(),
    coveredAt: {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
    accountingMethod:
      "lineage_aware_cumulative_snapshot_replay_exclusion",
    priceBasis: "official_api_price_equivalent_not_subscription_allowance",
    priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    periods: [...periods.values()].map(finalizePeriod),
    timeline: finalizeTimeline(timeline),
    quotaTimeline: finalizeWeeklyQuotaTimeline(
      weeklyQuotaTimelineBuckets,
    ),
    weeklyCalibration,
    weeklyCalibrationInput: {
      status: "complete",
      encoding: "accounting_compact_v2",
      retainedUsageEvents,
      retainedWeeklySnapshots,
      estimatedRetainedBytes: retainedTransitionBytes,
      limits,
    },
    diagnostics: publicDiagnostics(scanned?.diagnostics),
  };
}

export async function refreshReplaySafeAccountingCache({
  cacheFile = defaultReplaySafeAccountingCachePath(),
  indexFile = resolve(
    dirname(cacheFile),
    "local-analysis-index-v2.sqlite",
  ),
  indexSecretFile = defaultLocalAnalysisIndexSecretPath(indexFile),
  scan = null,
  indexWorkerCount,
  indexChunkBytes,
  ...options
} = {}) {
  if (scan !== null && typeof scan !== "function") {
    throw new TypeError("scan must be a function or null");
  }
  const effectiveScan = scan ?? createIndexedCodexLogScan({
    indexFile,
    secretFile: indexSecretFile,
    ...(indexWorkerCount === undefined
      ? {}
      : { workerCount: indexWorkerCount }),
    ...(indexChunkBytes === undefined
      ? {}
      : { chunkBytes: indexChunkBytes }),
  });
  const cache = await buildReplaySafeAccountingCache({
    ...options,
    scan: effectiveScan,
  });
  await writeJsonOwnerOnlyAtomic(cacheFile, cache);
  if (scan === null) {
    await writeLocalAnalysisIndexProjection({
      indexFile,
      schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
      generatedAt: cache.generatedAt,
      value: cache,
    });
  }
  return cache;
}

function validWeeklyCalibrationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "complete"
      || value.encoding !== "accounting_compact_v2"
      || !Number.isSafeInteger(value.retainedUsageEvents)
      || value.retainedUsageEvents < 0
      || !Number.isSafeInteger(value.retainedWeeklySnapshots)
      || value.retainedWeeklySnapshots < 0
      || !Number.isSafeInteger(value.estimatedRetainedBytes)
      || value.estimatedRetainedBytes < 0
      || !value.limits
      || typeof value.limits !== "object"
      || Array.isArray(value.limits)) return false;
  let limits;
  try {
    limits = transitionResourceLimits(value.limits);
  } catch {
    return false;
  }
  return value.retainedUsageEvents <= limits.usageEvents
    && value.retainedWeeklySnapshots <= limits.weeklySnapshots
    && value.retainedUsageEvents + value.retainedWeeklySnapshots
      <= limits.combinedInputs
    && value.estimatedRetainedBytes
      === value.retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES
        + value.retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES
    && value.estimatedRetainedBytes <= limits.retainedBytes;
}

function validQuotaTimeline(value, coveredAt) {
  if (!Array.isArray(value) || value.length > MAX_QUOTA_TIMELINE_ROWS) {
    return false;
  }
  const expectedKeys = [
    "accountAttribution",
    "durationMinutes",
    "limitId",
    "observedAt",
    "planType",
    "remainingPercent",
    "resetAt",
    "slot",
    "usedPercent",
  ].sort().join("\0");
  const coverageStartMs = Date.parse(coveredAt.startAt);
  const coverageEndMs = Date.parse(coveredAt.endAt);
  const seenBuckets = new Set();
  let priorSortKey = null;
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).sort().join("\0") !== expectedKeys
        || canonicalInstant(row.observedAt) === null
        || canonicalInstant(row.resetAt) === null
        || row.limitId !== "codex"
        || !QUOTA_SLOTS.has(row.slot)
        || !(QUOTA_PLANS.has(row.planType) || row.planType === "unknown")
        || typeof row.usedPercent !== "number"
        || !Number.isFinite(row.usedPercent)
        || row.usedPercent < 0
        || row.usedPercent > 100
        || typeof row.remainingPercent !== "number"
        || !Number.isFinite(row.remainingPercent)
        || row.remainingPercent < 0
        || row.remainingPercent > 100
        || row.remainingPercent
          !== Number(Math.max(0, 100 - row.usedPercent).toFixed(3))
        || row.durationMinutes !== WEEKLY_WINDOW_MINUTES
        || row.accountAttribution !== "historical_unattributed") {
      return false;
    }
    const observedMs = Date.parse(row.observedAt);
    if (observedMs < coverageStartMs || observedMs > coverageEndMs) {
      return false;
    }
    const bucketKey = quotaTimelineTrackBucketKey(row);
    if (seenBuckets.has(bucketKey)) return false;
    seenBuckets.add(bucketKey);
    const sortKey = [
      row.observedAt,
      row.limitId,
      row.slot,
      row.resetAt,
      row.planType,
      row.usedPercent.toFixed(3),
    ].join("\0");
    if (priorSortKey !== null && sortKey < priorSortKey) return false;
    priorSortKey = sortKey;
  }
  return true;
}

function validPriceCardProvenance(row) {
  if (!Array.isArray(row?.priceCardIds)
      || row.priceCardIds.length > 32
      || !row.priceCardIds.every((id) => (
        typeof id === "string" && id.length > 0 && id.length <= 128
      ))
      || !Array.isArray(row?.priceCardBreakdown)
      || row.priceCardBreakdown.length > 32) return false;
  if (typeof row.apiPriceEquivalentUsdExact !== "string"
      || !/^\d+(?:\.\d+)?$/u.test(row.apiPriceEquivalentUsdExact)) {
    return false;
  }
  const ids = row.priceCardIds;
  if (new Set(ids).size !== ids.length || [...ids].sort().some((id, index) => id !== ids[index])) {
    return false;
  }
  let priorId = null;
  let breakdownEvents = 0;
  let breakdownCost = "0";
  for (const item of row.priceCardBreakdown) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.priceCardId !== "string"
        || !ids.includes(item.priceCardId)
        || (priorId !== null && item.priceCardId <= priorId)
        || !Number.isSafeInteger(item.events)
        || item.events < 0
        || typeof item.costUsd !== "string"
        || !/^\d+(?:\.\d+)?$/u.test(item.costUsd)) return false;
    breakdownEvents += item.events;
    try {
      breakdownCost = addUsdStrings(breakdownCost, item.costUsd);
    } catch {
      return false;
    }
    priorId = item.priceCardId;
  }
  const coverage = row.pricingCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
      || !Number.isSafeInteger(coverage.fullyPricedEvents)
      || !Number.isSafeInteger(coverage.partiallyPricedEvents)
      || !Number.isSafeInteger(coverage.unpricedEvents)
      || coverage.fullyPricedEvents < 0
      || coverage.partiallyPricedEvents < 0
      || coverage.unpricedEvents < 0
      || coverage.fullyPricedEvents
        + coverage.partiallyPricedEvents
        + coverage.unpricedEvents !== row.events
      || breakdownEvents !== coverage.fullyPricedEvents
        + coverage.partiallyPricedEvents
      || breakdownCost !== row.apiPriceEquivalentUsdExact) {
    return false;
  }
  const exactNumber = Number(row.apiPriceEquivalentUsdExact);
  return Number.isFinite(exactNumber)
    && Number(row.apiPriceEquivalentUsd.toFixed(6))
      === Number(exactNumber.toFixed(6));
}

function validCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
      || canonicalInstant(value.generatedAt) === null
      || canonicalInstant(value.coveredAt?.startAt) === null
      || canonicalInstant(value.coveredAt?.endAt) === null
      || value.accountingMethod
        !== "lineage_aware_cumulative_snapshot_replay_exclusion"
      || value.priceEpochBasis !== HISTORICAL_PRICE_EPOCH_BASIS
      // A replay-safe total is meaningful only under the exact price registry
      // that produced it. Never let an older, higher price card silently
      // survive a registry correction just because its JSON shape is valid.
      || value.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || value.priceRegistryObservedAt !== APP_PRICE_REGISTRY_MANIFEST.observedAt
      || !Array.isArray(value.periods)
      || !Array.isArray(value.timeline)
      || !validQuotaTimeline(value.quotaTimeline, value.coveredAt)
      || !validWeeklyCalibrationInput(value.weeklyCalibrationInput)
      || value.weeklyCalibration?.schemaVersion
        !== "weekly-calibration-summary-v0.1"
      || canonicalInstant(value.weeklyCalibration.generatedAt) === null
      || !["estimated", "insufficient_evidence"].includes(
        value.weeklyCalibration.status,
      )
      || value.weeklyCalibration.accountAttribution?.status
        !== "historical_unattributed"
      || value.weeklyCalibration.accountAttribution?.maySpanMultipleAccounts
        !== true
      || !Array.isArray(value.weeklyCalibration.recentResets)
      || value.weeklyCalibration.recentResets.length
        > BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT
      || value.periods.length !== 4
      || !Number.isSafeInteger(value.bucketMinutes)
      || value.bucketMinutes !== 15) return false;
  const ids = value.periods.map((row) => row?.id).sort().join(",");
  return ids === "24h,30d,7d,all"
    && value.periods.every((row) => (
      Number.isSafeInteger(row.events)
      && row.events >= 0
      && Number.isSafeInteger(row.totalTokens)
      && row.totalTokens >= 0
      && typeof row.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validPriceCardProvenance(row)
    ))
    && value.timeline.every((row) => (
      canonicalInstant(row?.startAt) !== null
      && canonicalInstant(row?.endAt) !== null
      && Number.isSafeInteger(row?.usageEvents)
      && row.usageEvents >= 0
      && Number.isSafeInteger(row?.totalTokens)
      && row.totalTokens >= 0
      && typeof row?.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
    ));
}

export async function readReplaySafeAccountingCache({
  cacheFile = defaultReplaySafeAccountingCachePath(),
  indexFile = resolve(
    dirname(cacheFile),
    "local-analysis-index-v2.sqlite",
  ),
  now = null,
  maximumAgeMs = null,
} = {}) {
  if (now !== null && typeof now !== "function") {
    throw new TypeError("now must be a function or null");
  }
  if (maximumAgeMs !== null
      && (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0)) {
    throw new TypeError("maximumAgeMs must be a non-negative safe integer or null");
  }
  let unavailableErrorCode = null;
  let parsed = null;
  let metadata;
  try {
    metadata = await stat(cacheFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      unavailableErrorCode = "cache_missing";
    } else {
      unavailableErrorCode = "cache_unavailable";
    }
  }
  if (metadata !== undefined) {
    if (!metadata.isFile() || metadata.size > MAX_CACHE_BYTES) {
      unavailableErrorCode = "cache_invalid_size";
    } else {
      try {
        parsed = JSON.parse(await readFile(cacheFile, "utf8"));
      } catch {
        unavailableErrorCode = "cache_malformed";
      }
    }
  }
  if (parsed !== null && !validCache(parsed)) {
    const registryOutdated = (
      parsed?.priceRegistryVersion !== undefined
      || parsed?.priceRegistryObservedAt !== undefined
    ) && (
      parsed?.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || parsed?.priceRegistryObservedAt
        !== APP_PRICE_REGISTRY_MANIFEST.observedAt
    );
    unavailableErrorCode = registryOutdated
      ? "cache_price_registry_outdated"
      : parsed?.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
        || parsed?.priceEpochBasis !== HISTORICAL_PRICE_EPOCH_BASIS
        ? "cache_accounting_semantics_outdated"
        : "cache_invalid";
    parsed = null;
  }
  if (parsed === null) {
    const projection = await readLocalAnalysisIndexProjection({
      indexFile,
      schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
    });
    if (projection.status === "available"
        && validCache(projection.value)) {
      parsed = projection.value;
    }
  }
  if (parsed === null) {
    return {
      status: "unavailable",
      errorCode: unavailableErrorCode ?? "cache_unavailable",
      cache: null,
    };
  }
  if (now !== null) {
    const nowMs = now();
    if (!Number.isFinite(nowMs)) throw new TypeError("now must return a finite epoch timestamp");
    const coverageEndMs = Date.parse(parsed.coveredAt.endAt);
    if (coverageEndMs > nowMs) {
      return {
        status: "unavailable",
        errorCode: "cache_from_future",
        cache: null,
      };
    }
    const ageMs = Math.max(0, nowMs - coverageEndMs);
    if (maximumAgeMs !== null && ageMs > maximumAgeMs) {
      return {
        status: "stale",
        errorCode: "cache_stale",
        ageSeconds: Math.round(ageMs / 1_000),
        cache: parsed,
      };
    }
    return {
      status: "available",
      errorCode: null,
      ageSeconds: Math.round(ageMs / 1_000),
      cache: parsed,
    };
  }
  return { status: "available", errorCode: null, cache: parsed };
}

export function assertReplaySafeAccountingCache(value) {
  if (!validCache(value)) throw fixedError("cache_invalid");
  return value;
}
