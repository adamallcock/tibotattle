import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import { openLocalUnifiedIndex } from "./local-unified-index.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  createIndexedCodexLogScan,
  defaultLocalAnalysisIndexSecretPath,
} from "./local-analysis-index.js";
import {
  CODEX_TRANSITION_DERIVATION_CEILINGS,
  deriveCodexTransitionSeriesCooperatively,
  PARSER_VERSION,
} from "./codex-transition-miner.js";
import { validAbortSignal } from "./valid-abort-signal.js";
import {
  codexModelAllowanceTrack,
  codexModelApiPriceEquivalentApplicable,
  codexModelPricingStatus,
  OPENAI_CODEX_SPARK_MODEL_ID,
  recognizedCodexModelId,
} from "./export/index.js";
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
import {
  analyzeQuotaPace,
  isValidQuotaWindowDuration,
  SEVEN_DAY_WINDOW_MINUTES,
} from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  defaultLocalCollectorStatePath,
  prepareLocalCollectorState,
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "./local-collector-state.js";
import { stableJson } from "./storage.js";
import {
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  projectBoundedWeeklyCalibrationSummary,
} from "./reporting/index.js";
import { fastQuotaMultiplier } from "./application/index.js";

// v0.4 added per-model allowance-track and API-price-applicability state, and
// the combined `modelUsage` row set. v0.5 (2026-08-08) sources the weekly
// calibration transition corpus from the unified local index when one is
// present — the corpus then spans the whole indexed history rather than the
// scan window — and records that provenance in `weeklyCalibrationInput.source`
// and `.coveredAt`. A v0.4 cache's calibration was silently bounded by its
// scan window, so it is withheld and rebuilt rather than shown as full
// history.
export const REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION =
  "local-replay-safe-accounting-v0.5";

const HISTORICAL_PRICE_EPOCH_BASIS =
  "event_time_when_registry_has_effective_evidence";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
// Standing owner rule (2026-08-08, stated after five rounds of cap-shuffling):
// NEVER introduce or retain small data-window caps. A history limit is either
// absent or extreme (365+ days), never convenience-sized — 31 and 93 were
// both wrong. The floor makes a convenience-sized window unrepresentable; the
// ceiling is a ten-year typo guard, not a data-window policy.
const MINIMUM_WINDOW_DAYS = 365;
const MAXIMUM_WINDOW_DAYS = 3_653;
const DEFAULT_WINDOW_DAYS = MINIMUM_WINDOW_DAYS;
const TIMELINE_BUCKET_MS = 15 * 60 * 1_000;
const MAX_QUOTA_TIMELINE_ROWS = 10_000;
const WEEKLY_WINDOW_MINUTES = SEVEN_DAY_WINDOW_MINUTES;
const SPARK_MODEL = OPENAI_CODEX_SPARK_MODEL_ID;
const PACE_CURRENT_MAX_AGE_MS = 30 * 60_000;
const PACE_STATUSES = new Set([
  "unavailable",
  "insufficient_observations",
  "available",
  "will_reach_reset_first",
]);
const ACCOUNT_SCOPE_ID_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const ACCOUNT_TRACK_ID_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
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
const QUOTA_PLANS = new Set(TELEMETRY_PLAN_TYPES);
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
  return recognizedCodexModelId(value) ?? "unknown";
}

function emptyDimension(keys) {
  return Object.fromEntries([...keys].map((key) => [
    key,
    { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
  ]));
}

function newPeriod(id, label, { includeSpark = true } = {}) {
  const period = {
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
  if (includeSpark) {
    period.spark = newPeriod("spark", "Spark allowance", {
      includeSpark: false,
    });
  }
  return period;
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

// Exported for the unified-index companion read: one memoized unit-price plan
// per (model, context band, effective date), integer-scaled per event, falling
// back to the full pricer whenever a plan cannot be proven exact. This is the
// same pricer the replay-safe cache itself accounts with.
export function createAccountingPricer() {
  const plans = new Map();
  return (event, components) => {
    // The reviewed pricer bands by the provider-reported total input context
    // when present, and otherwise by the sum of the input token components.
    // The plan key must reproduce that rule exactly: keying the band off the
    // reported total alone silently priced every 272k+ event whose record
    // lacks the field at short-context rates.
    const reportedTotal = Number(event.totalInputContextTokens);
    const inputSum = (components.input_uncached_tokens ?? 0)
      + (components.input_cache_read_tokens ?? 0)
      + (components.input_cache_write_tokens ?? 0);
    const contextBand =
      (Number.isFinite(reportedTotal) ? reportedTotal : inputSum) >= 272_000
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
      // Keep only rows whose unit price is proven exact. The per-event loop
      // below falls back to the full pricer the moment an event actually USES
      // a component that has no such row, so a partially priced card — Codex
      // never prices cache writes, for example — still yields a fast plan for
      // the events that never touch the unpriced component. The previous
      // all-components gate nullified every Codex plan and silently sent the
      // entire corpus down the slow path.
      const rows = new Map(template.components
        .filter((row) => (
          typeof row.unitPriceUsd === "string"
          && /^\d+(?:\.\d{1,9})?$/u.test(row.unitPriceUsd)
        ))
        .map((row) => [row.name, row]));
      plan = ["fully_priced", "partially_priced"].includes(
        template.coverageStatus,
      ) && rows.size > 0
        ? {
          rows,
          // A fast-priced event uses only fully priced components, so the
          // template's unpriced-component warnings do not describe it. The
          // empty shape mirrors the full pricer's warnings object.
          warnings: template.coverageStatus === "fully_priced"
            ? template.warnings
            : { coverage: [], informational: [] },
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
    modelPricingStatus: codexModelPricingStatus(event.model),
    modelAllowanceTrack: codexModelAllowanceTrack(event.model),
    modelApiPriceEquivalentApplicable:
      codexModelApiPriceEquivalentApplicable(event.model),
    isSpark: model === SPARK_MODEL,
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

function quotaTimelineProjection(
  snapshot,
  { limitId = "codex", durationMinutes = WEEKLY_WINDOW_MINUTES } = {},
) {
  const observedAt = canonicalInstant(snapshot?.timestamp);
  const window = snapshot?.window;
  // Keep only the fixed main Codex weekly family used by the UI calibration.
  // The high-churn codex_bengalfox family is a different track, not a
  // substitute for missing observations on this allowance.
  if (observedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== limitId
      || !QUOTA_SLOTS.has(window.slot)
      || (durationMinutes !== null
        && window.windowDurationMins !== durationMinutes)
      || !isValidQuotaWindowDuration(window.windowDurationMins)
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
    limitId,
    slot: window.slot,
    planType: QUOTA_PLANS.has(window.planType)
      ? window.planType
      : "unknown",
    usedPercent,
    remainingPercent: Number(Math.max(0, 100 - usedPercent).toFixed(3)),
    durationMinutes: window.windowDurationMins,
    resetAt,
    accountAttribution: "historical_unattributed",
  };
}

function quotaTimelineTrackBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  // Preserve the exact observed point. Collapsing to a 15-minute bucket can
  // erase the closest points to an exact comparison endpoint and manufacture
  // an otherwise avoidable missing-bracket status.
  return `${observedMs}:${row.limitId}:${row.slot}:${row.durationMinutes}`;
}

function quotaTimelineTrackKey(row) {
  return `${row.limitId}:${row.slot}:${row.durationMinutes}`;
}

function quotaTimelineBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  const bucketStartMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  return `${bucketStartMs}:${quotaTimelineTrackKey(row)}`;
}

function quotaTimelineStateKey(row) {
  return [
    row.planType,
    row.usedPercent.toFixed(3),
    row.resetAt,
  ].join("\0");
}

function quotaTimelineRowTieBreak(row) {
  return [
    row.planType,
    row.usedPercent.toFixed(3),
    row.resetAt,
  ].join("\0");
}

function quotaTimelineRowSort(left, right) {
  return left.observedAt.localeCompare(right.observedAt)
    || left.limitId.localeCompare(right.limitId)
    || left.slot.localeCompare(right.slot)
    || left.resetAt.localeCompare(right.resetAt)
    || left.planType.localeCompare(right.planType)
    || left.usedPercent - right.usedPercent;
}

function quotaTimelineDeterministicRowSort(left, right) {
  return quotaTimelineRowSort(left, right)
    || String(left.durationMinutes).localeCompare(String(right.durationMinutes));
}

function retainQuotaTimeline(buckets, snapshot, options) {
  const row = quotaTimelineProjection(snapshot, options);
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

function addQuotaTimelineCandidate(candidates, row, transitionKeys = null) {
  const key = quotaTimelineTrackBucketKey(row);
  candidates.set(key, row);
  if (transitionKeys !== null) transitionKeys.add(key);
}

function quotaTimelineCandidates(rows) {
  const candidates = new Map();
  const transitionKeys = new Set();
  const previousByTrack = new Map();
  const bucketEdges = new Map();

  for (const row of rows) {
    const trackKey = quotaTimelineTrackKey(row);
    const previous = previousByTrack.get(trackKey);
    if (previous === undefined
        || quotaTimelineStateKey(previous) !== quotaTimelineStateKey(row)) {
      addQuotaTimelineCandidate(candidates, row, transitionKeys);
    }
    previousByTrack.set(trackKey, row);

    const bucketKey = quotaTimelineBucketKey(row);
    const edge = bucketEdges.get(bucketKey);
    if (edge === undefined) {
      bucketEdges.set(bucketKey, { first: row, last: row });
    } else {
      edge.last = row;
    }
  }

  for (const { first, last } of bucketEdges.values()) {
    addQuotaTimelineCandidate(candidates, first);
    addQuotaTimelineCandidate(candidates, last);
  }

  return { candidates, transitionKeys };
}

function selectTimeStratifiedQuotaTimelineRows(
  rows,
  maximum,
  rangeRows = rows,
) {
  if (rows.length <= maximum) return rows;
  const rangeStartMs = Date.parse(rangeRows[0].observedAt);
  const rangeEndMs = Date.parse(rangeRows.at(-1).observedAt);
  if (rangeStartMs === rangeEndMs) {
    return rows
      .slice()
      .sort(quotaTimelineDeterministicRowSort)
      .slice(0, maximum);
  }

  const spanMs = rangeEndMs - rangeStartMs;
  const groups = new Map();
  for (const row of rows) {
    const observedMs = Date.parse(row.observedAt);
    const stratum = Math.min(
      maximum - 1,
      Math.floor(((observedMs - rangeStartMs) * maximum) / spanMs),
    );
    const group = groups.get(stratum) ?? [];
    group.push(row);
    groups.set(stratum, group);
  }

  const activeGroups = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => ({
      rows: group.sort(quotaTimelineDeterministicRowSort),
      nextIndex: 0,
    }));
  const selected = [];
  while (activeGroups.length > 0 && selected.length < maximum) {
    const nextGroups = [];
    for (const group of activeGroups) {
      if (group.nextIndex < group.rows.length) {
        selected.push(group.rows[group.nextIndex]);
        group.nextIndex += 1;
      }
      if (group.nextIndex < group.rows.length) nextGroups.push(group);
      if (selected.length >= maximum) break;
    }
    activeGroups.splice(0, activeGroups.length, ...nextGroups);
  }
  return selected;
}

// The oldest and newest observation on every track. These are pinned before
// any sampling so the retained series always reaches both ends of the covered
// window: the oldest row is what a calibration window near the start of the
// range needs to bracket against, and the newest row is the current allowance
// reading.
function quotaTimelineRangeAnchors(sortedRows) {
  const firstByTrack = new Map();
  const lastByTrack = new Map();
  for (const row of sortedRows) {
    const key = quotaTimelineTrackKey(row);
    if (!firstByTrack.has(key)) firstByTrack.set(key, row);
    lastByTrack.set(key, row);
  }
  const anchors = new Map();
  for (const row of [...firstByTrack.values(), ...lastByTrack.values()]) {
    anchors.set(quotaTimelineTrackBucketKey(row), row);
  }
  return [...anchors.values()].sort(quotaTimelineDeterministicRowSort);
}

// Time stratification alone is not enough when several tracks share the range:
// at equal timestamps one slot always sorts first, so a single stratified pass
// can spend the whole budget on that slot and erase the other one. Give every
// track its own stratified share and interleave them.
function selectTrackBalancedQuotaTimelineRows(rows, maximum, rangeRows) {
  if (rows.length <= maximum) return rows;
  const byTrack = new Map();
  for (const row of rows) {
    const key = quotaTimelineTrackKey(row);
    const group = byTrack.get(key) ?? [];
    group.push(row);
    byTrack.set(key, group);
  }
  if (byTrack.size <= 1) {
    return selectTimeStratifiedQuotaTimelineRows(rows, maximum, rangeRows);
  }
  const trackBudget = Math.ceil(maximum / byTrack.size);
  let tracks = [...byTrack.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({
      rows: selectTimeStratifiedQuotaTimelineRows(
        group.sort(quotaTimelineDeterministicRowSort),
        trackBudget,
        rangeRows,
      ).slice().sort(quotaTimelineDeterministicRowSort),
      nextIndex: 0,
    }));
  const selected = [];
  while (tracks.length > 0 && selected.length < maximum) {
    const nextTracks = [];
    for (const track of tracks) {
      if (selected.length < maximum && track.nextIndex < track.rows.length) {
        selected.push(track.rows[track.nextIndex]);
        track.nextIndex += 1;
      }
      if (track.nextIndex < track.rows.length) nextTracks.push(track);
    }
    tracks = nextTracks;
  }
  return selected;
}

// Fill a hard row budget from priority groups. Each group is stratified over
// time and balanced across tracks into whatever capacity is left, so a dense
// recent burst can never crowd out the earlier part of the covered window and
// the result never exceeds `maximum` — the same ceiling `validQuotaTimeline`
// enforces on read. A final pass over every candidate spends any capacity a
// short group left behind.
function retainBoundedQuotaTimelineRows(groups, maximum, rangeRows) {
  const retained = new Map();
  for (const group of [...groups, rangeRows]) {
    const capacity = maximum - retained.size;
    if (capacity <= 0) break;
    const pending = group.filter((row) => (
      !retained.has(quotaTimelineTrackBucketKey(row))
    ));
    if (pending.length === 0) continue;
    const selected = selectTrackBalancedQuotaTimelineRows(
      pending,
      capacity,
      rangeRows,
    );
    for (const row of selected) {
      if (retained.size >= maximum) break;
      retained.set(quotaTimelineTrackBucketKey(row), row);
    }
  }
  return [...retained.values()].sort(quotaTimelineDeterministicRowSort);
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
  // Keep the historical path byte-for-byte/order-for-order for ordinary
  // caches. Retention only changes when the old newest-only cap would have
  // discarded the earlier covered window.
  if (rows.length <= MAX_QUOTA_TIMELINE_ROWS) return rows;

  const { candidates, transitionKeys } = quotaTimelineCandidates(rows);
  if (candidates.size <= MAX_QUOTA_TIMELINE_ROWS) {
    return [...candidates.values()].sort(quotaTimelineDeterministicRowSort);
  }

  const candidateRows = [...candidates.values()]
    .sort(quotaTimelineDeterministicRowSort);
  const transitionRows = candidateRows.filter((row) => (
    transitionKeys.has(quotaTimelineTrackBucketKey(row))
  ));
  const bucketEdgeRows = candidateRows.filter((row) => (
    !transitionKeys.has(quotaTimelineTrackBucketKey(row))
  ));
  // Retaining every state transition is not bounded: a long, busy range can
  // hold far more transitions than the cap, which is how this path used to
  // return more rows than the cache is allowed to carry. Transitions still
  // rank above plain bucket edges, but they are budgeted like everything else.
  return retainBoundedQuotaTimelineRows(
    [quotaTimelineRangeAnchors(candidateRows), transitionRows, bucketEdgeRows],
    MAX_QUOTA_TIMELINE_ROWS,
    candidateRows,
  );
}

function paceAccountTrackId(snapshot) {
  const scope = snapshot?.accountScope;
  if (scope?.status === "available"
      && (ACCOUNT_SCOPE_ID_PATTERN.test(scope.scopeId ?? "")
        || ACCOUNT_TRACK_ID_PATTERN.test(scope.scopeId ?? ""))) {
    return scope.scopeId;
  }
  // A caller that has already projected the app-server marker may supply the
  // opaque track directly. Never accept a session/source scope or an
  // arbitrary string as an account identity.
  const direct = snapshot?.accountTrackId;
  return ACCOUNT_SCOPE_ID_PATTERN.test(direct ?? "")
      || ACCOUNT_TRACK_ID_PATTERN.test(direct ?? "")
    ? direct
    : null;
}

function paceToken(value, fallback) {
  return typeof value === "string"
      && /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu.test(value)
    ? value
    : fallback;
}

function weeklyPaceSnapshotProjection(snapshot) {
  const window = snapshot?.window;
  const accountTrackId = paceAccountTrackId(snapshot);
  const observedAt = canonicalInstant(
    snapshot?.observedAt ?? snapshot?.timestamp,
  );
  const receivedAt = canonicalInstant(
    snapshot?.receivedAt ?? snapshot?.timestamp,
  );
  if (accountTrackId === null
      || observedAt === null
      || receivedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== "codex"
      || !QUOTA_SLOTS.has(window.slot)
      || window.windowDurationMins !== WEEKLY_WINDOW_MINUTES
      || !Number.isFinite(window.usedPercent)
      || window.usedPercent < 0
      || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt)
      || window.resetsAt <= 0
      || Date.parse(receivedAt) < Date.parse(observedAt)) {
    return null;
  }
  const resetDate = new Date(window.resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  return {
    accountTrackId,
    provider: "openai_codex",
    planType: paceToken(window.planType, "unknown"),
    planVariant: paceToken(
      snapshot?.planVariant ?? window.planVariant,
      "current-window",
    ),
    limitId: "codex",
    slot: window.slot,
    windowDurationMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: resetDate.toISOString(),
    observedAt,
    receivedAt,
    usedPercent: Number(window.usedPercent.toFixed(3)),
    policyEpoch: paceToken(
      snapshot?.policyEpoch ?? window.policyEpoch,
      "current-window",
    ),
  };
}

function paceTrackKey(row, includeReset = true) {
  return [
    row.accountTrackId,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.slot,
    row.windowDurationMinutes,
    ...(includeReset ? [row.resetsAt] : []),
    row.policyEpoch,
  ].join("\0");
}

function paceUnavailable(row, status = "unavailable") {
  return {
    status,
    currentUsedPercent: Number(row.usedPercent.toFixed(3)),
    remainingPercent: Number(Math.max(0, 100 - row.usedPercent).toFixed(3)),
    resetsAt: row.resetsAt,
    pace: { percentagePointsPerHour: null },
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: Number(
      Math.max(0, Date.parse(row.resetsAt) - Date.parse(row.observedAt))
        / (60 * 60 * 1_000),
    ),
  };
}

function sanitizeWeeklyPaceForecast(result) {
  if (!result || typeof result !== "object"
      || !PACE_STATUSES.has(result.status)
      || !Number.isFinite(result.currentUsedPercent)
      || result.currentUsedPercent < 0
      || result.currentUsedPercent > 100
      || !Number.isFinite(result.remainingPercent)
      || result.remainingPercent < 0
      || result.remainingPercent > 100
      || result.remainingPercent
        !== Number(Math.max(0, 100 - result.currentUsedPercent).toFixed(3))
      || canonicalInstant(result.resetsAt) === null) {
    return null;
  }
  const rate = result.pace?.percentagePointsPerHour;
  const hoursToExhaustion = result.hoursToExhaustion;
  const hoursToReset = result.hoursToReset;
  const etaAt = result.etaAt === null ? null : canonicalInstant(result.etaAt);
  if ((rate !== null
        && (!Number.isFinite(rate) || rate < 0 || rate > 100))
      || (hoursToExhaustion !== null
        && (!Number.isFinite(hoursToExhaustion) || hoursToExhaustion < 0))
      || (hoursToReset !== null
        && (!Number.isFinite(hoursToReset) || hoursToReset < 0))
      || (result.etaAt !== null && etaAt === null)) {
    return null;
  }
  return {
    status: result.status,
    currentUsedPercent: Number(result.currentUsedPercent.toFixed(3)),
    remainingPercent: Number(result.remainingPercent.toFixed(3)),
    resetsAt: result.resetsAt,
    pace: {
      percentagePointsPerHour:
        rate === null ? null : Number(rate.toFixed(6)),
    },
    etaAt,
    hoursToExhaustion: hoursToExhaustion === null
      ? null
      : Number(hoursToExhaustion.toFixed(6)),
    hoursToReset: hoursToReset === null ? null : Number(hoursToReset.toFixed(6)),
  };
}

function projectWeeklyPaceForecast(rows, endMs) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const ordered = [...rows].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.receivedAt.localeCompare(right.receivedAt)
    || left.usedPercent - right.usedPercent
  ));
  const latestMs = Date.parse(ordered.at(-1).observedAt);
  const latest = ordered.filter(
    (row) => Date.parse(row.observedAt) === latestMs,
  );
  const latestAccounts = new Set(latest.map((row) => row.accountTrackId));
  if (latestAccounts.size !== 1) return null;
  const latestScope = latest[0].accountTrackId;
  const latestSlots = new Set(
    latest.filter((row) => row.accountTrackId === latestScope)
      .map((row) => row.slot),
  );
  // The provider labels either slot as valid for the seven-day limit. If both
  // are present at the same instant, follow the dashboard's primary-slot
  // preference; otherwise keep the only observed slot.
  const selectedSlot = latestSlots.has("primary")
    ? "primary"
    : latestSlots.size === 1 ? [...latestSlots][0] : null;
  if (selectedSlot === null) return null;
  const currentCandidates = latest.filter((row) => (
    row.accountTrackId === latestScope && row.slot === selectedSlot
  ));
  const currentKeys = new Set(currentCandidates.map((row) => paceTrackKey(row)));
  if (currentKeys.size !== 1) return null;
  const current = currentCandidates[0];
  if (endMs - latestMs > PACE_CURRENT_MAX_AGE_MS) {
    return sanitizeWeeklyPaceForecast(paceUnavailable(current));
  }
  const currentKey = paceTrackKey(current);
  const observations = ordered.filter((row) => (
    row.accountTrackId === latestScope
    && paceTrackKey(row) === currentKey
  ));
  try {
    const result = analyzeQuotaPace({
      currentSnapshot: current,
      observations,
    });
    return sanitizeWeeklyPaceForecast(result);
  } catch {
    return sanitizeWeeklyPaceForecast(paceUnavailable(current));
  }
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
  if (event.isSpark) {
    addEvent(period.spark, { ...event, isSpark: false });
    return;
  }
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
    pricingStatus: event.modelPricingStatus,
    allowanceTrack: event.modelAllowanceTrack,
    apiPriceEquivalentApplicable: event.modelApiPriceEquivalentApplicable,
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

function modelUsageRowSort(left, right) {
  return right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd
    || right.totalTokens - left.totalTokens
    || left.model.localeCompare(right.model);
}

// One row per model identity across every allowance track, for surfaces that
// render a single "model usage" table. `byModel` deliberately covers only the
// primary allowance, because the period's own event/token/cost totals exclude
// the separately metered Spark track and the two must stay reconcilable. A
// renderer that wants every model on one list needs this instead, and each
// row states which track it belongs to and whether an API-price equivalent is
// a meaningful figure for it at all.
function combinedModelUsage(finalized) {
  return [
    ...finalized.byModel,
    ...(finalized.spark?.byModel ?? []),
  ].sort(modelUsageRowSort);
}

function finalizePeriod(period) {
  const priced = period.pricingCoverage.fullyPricedEvents
    + period.pricingCoverage.partiallyPricedEvents;
  const finalized = {
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
      .sort(modelUsageRowSort),
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
  if (period.spark) finalized.spark = finalizePeriod(period.spark);
  finalized.modelUsage = combinedModelUsage(finalized);
  return finalized;
}

// Build one constant-memory accounting total from an already indexed event
// stream. Unlike the recent replay cache, this deliberately retains no raw
// transition inputs, quota timeline, or chart buckets: its only contract is a
// content-free aggregate whose price cards are selected at each event's own
// timestamp. This is what lets the archive grow beyond the 31-day interactive
// cache without turning an old Mac's history into an unbounded heap.
export async function buildReplaySafeAccountingPeriod({
  id = "history",
  label = "Indexed history",
  startAt,
  endAt,
  scan,
  signal = null,
  declaredSpeedBaselines = [],
  rss = () => process.memoryUsage().rss,
  maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
} = {}) {
  const canonicalStart = canonicalInstant(startAt);
  const canonicalEnd = canonicalInstant(endAt);
  if (typeof id !== "string"
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(id)
      || typeof label !== "string"
      || label.length < 1
      || label.length > 96
      || canonicalStart === null
      || canonicalEnd === null
      || Date.parse(canonicalStart) > Date.parse(canonicalEnd)
      || typeof scan !== "function"
      || !validAbortSignal(signal)
      || typeof rss !== "function"
      || !Number.isSafeInteger(maximumRssBytes)
      || maximumRssBytes < 1) {
    throw new TypeError("Replay-safe accounting period options are invalid");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  const startMs = Date.parse(canonicalStart);
  const endMs = Date.parse(canonicalEnd);
  const period = newPeriod(id, label);
  const price = createAccountingPricer();
  let acceptedEvents = 0;
  const checkRuntimeMemory = () => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_archive_rss_measurement_invalid");
    }
    if (currentRss > maximumRssBytes) {
      throw fixedError("accounting_archive_rss_limit_exceeded");
    }
  };
  checkRuntimeMemory();
  await scan({
    startAt: canonicalStart,
    endAt: canonicalEnd,
    signal,
    onUsage: (rawEvent) => {
      throwIfAborted(signal);
      const observedAt = canonicalInstant(rawEvent?.timestamp);
      if (observedAt === null) return;
      const observedMs = Date.parse(observedAt);
      if (observedMs < startMs || observedMs > endMs) return;
      const event = eventProjection(rawEvent, price);
      if (event === null) return;
      event.declaredSpeed = event.speed === "unknown"
        ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
        : "unknown";
      addEvent(period, event);
      acceptedEvents += 1;
      if (acceptedEvents % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
        checkRuntimeMemory();
      }
    },
  });
  throwIfAborted(signal);
  checkRuntimeMemory();
  return {
    generatedAt: canonicalEnd,
    coveredAt: {
      startAt: canonicalStart,
      endAt: canonicalEnd,
    },
    priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    period: finalizePeriod(period),
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
  return defaultLocalCollectorStatePath(root);
}

function cooperativeYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

function firstIndexAtLeast(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstIndexAbove(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Mirror of the transition miner's windowKey over the compact snapshot
// encoding [timestamp, timestampMs, provider, planType, limitId, slot,
// windowDurationMins, resetsAt, usedPercent]. Transitions are derived from
// consecutive snapshots WITHIN one of these groups, never across groups,
// which is what makes the batched derivation below exact.
function compactSnapshotGroupKey(row) {
  return [row[2], row[3], row[4], row[5], row[6], row[7]].join("|");
}

// The transition miner refuses more than 10,000 derived rows per call — a
// structural memory-safety ceiling owned by codex-transition-miner.js, not a
// data-window policy. A full unbounded history legitimately holds more (the
// real corpus measured 18,176 weekly transitions over its first 82 days), so
// the derivation is partitioned by reset-window group and each batch stays
// under the ceiling with headroom. Cumulative aggregations are
// difference-based over each window's own span, so deriving disjoint group
// batches against a usage slice that covers every window start in the batch
// reproduces the unbatched result exactly.
const CALIBRATION_BATCH_TRANSITION_BUDGET = 8_000;

async function deriveBoundedWeeklyCalibrationSeries({
  startAt,
  endAt,
  rawUsageEvents,
  rateLimitSnapshots,
  diagnostics,
  signal,
  resourceCheck,
}) {
  const derive = (usage, snapshots) => deriveCodexTransitionSeriesCooperatively({
    startAt,
    endAt,
    rawUsageEvents: usage,
    rateLimitSnapshots: snapshots,
    diagnostics,
    includeSnapshotIntervals: false,
    windowDurationMins: WEEKLY_WINDOW_MINUTES,
    signal,
    consumeInputs: true,
    includeNormalizedInputs: false,
    inputEncoding: "accounting_prepriced_compact_v2",
    resourceCheck,
  });

  // Group the compact snapshots exactly as the miner will, and count the
  // transitions each group will derive: within a group the miner walks
  // deduplicated snapshots in (time, percent) order and emits one transition
  // per consecutive percent change, so this count is exact, not an estimate.
  const groups = new Map();
  for (let index = 0; index < rateLimitSnapshots.length; index += 1) {
    if (index % 8_192 === 0) {
      throwIfAborted(signal);
      resourceCheck?.();
      await cooperativeYield();
    }
    const row = rateLimitSnapshots[index];
    if (!Array.isArray(row) || row.length !== 9) continue;
    const key = compactSnapshotGroupKey(row);
    let group = groups.get(key);
    if (group === undefined) {
      group = { rows: [], dedupe: new Set(), deduped: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    const dedupeKey = `${row[0]}|${row[8]}`;
    if (!group.dedupe.has(dedupeKey)) {
      group.dedupe.add(dedupeKey);
      group.deduped.push(row);
    }
  }
  let totalTransitions = 0;
  for (const group of groups.values()) {
    const ordered = [...group.deduped].sort(
      (left, right) => left[1] - right[1] || left[8] - right[8],
    );
    let transitions = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index][8] !== ordered[index - 1][8]) transitions += 1;
    }
    const durationMins = Number(ordered[0]?.[6]);
    const resetsAt = Number(ordered[0]?.[7]);
    const windowStartMs = (resetsAt - durationMins * 60) * 1_000;
    group.transitions = transitions;
    group.sliceStartMs = Number.isFinite(windowStartMs)
      ? windowStartMs
      : Number.NEGATIVE_INFINITY;
    group.firstMs = Number(ordered[0]?.[1] ?? 0);
    group.lastMs = Number(ordered.at(-1)?.[1] ?? 0);
    totalTransitions += transitions;
  }
  throwIfAborted(signal);
  resourceCheck?.();

  if (totalTransitions <= CALIBRATION_BATCH_TRANSITION_BUDGET) {
    const series = await derive(rawUsageEvents, rateLimitSnapshots);
    return {
      transitions: series.transitions,
      deduplicatedSnapshotCount: series.deduplicatedSnapshotCount,
    };
  }

  // Sort the compact usage rows once so every batch can take the contiguous
  // slice that covers its groups' windows. Rows without a parseable timestamp
  // would be dropped by the miner's own normalization, so excluding them here
  // changes nothing.
  const stamped = [];
  for (let index = 0; index < rawUsageEvents.length; index += 1) {
    if (index % 8_192 === 0) {
      throwIfAborted(signal);
      resourceCheck?.();
      await cooperativeYield();
    }
    const observedMs = Date.parse(rawUsageEvents[index]?.[0]);
    if (Number.isFinite(observedMs)) stamped.push([observedMs, index]);
  }
  stamped.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const sortedUsage = stamped.map(([, index]) => rawUsageEvents[index]);
  const sortedMs = stamped.map(([observedMs]) => observedMs);
  stamped.length = 0;

  const orderedGroups = [...groups.values()].sort((left, right) => (
    left.sliceStartMs - right.sliceStartMs
    || left.firstMs - right.firstMs
    || left.lastMs - right.lastMs
  ));
  const batches = [];
  let current = null;
  for (const group of orderedGroups) {
    if (current === null
        || (current.groups.length > 0
          && current.transitions + group.transitions
            > CALIBRATION_BATCH_TRANSITION_BUDGET)) {
      current = {
        groups: [],
        transitions: 0,
        sliceStartMs: Number.POSITIVE_INFINITY,
        sliceEndMs: Number.NEGATIVE_INFINITY,
      };
      batches.push(current);
    }
    current.groups.push(group);
    current.transitions += group.transitions;
    current.sliceStartMs = Math.min(current.sliceStartMs, group.sliceStartMs);
    current.sliceEndMs = Math.max(current.sliceEndMs, group.lastMs);
  }

  const transitions = [];
  let deduplicatedSnapshotCount = 0;
  for (const batch of batches) {
    throwIfAborted(signal);
    resourceCheck?.();
    const low = batch.sliceStartMs === Number.NEGATIVE_INFINITY
      ? 0
      : firstIndexAtLeast(sortedMs, batch.sliceStartMs);
    const high = firstIndexAbove(sortedMs, batch.sliceEndMs);
    const usageSlice = sortedUsage.slice(low, high);
    const snapshotSlice = [];
    for (const group of batch.groups) snapshotSlice.push(...group.rows);
    const series = await derive(usageSlice, snapshotSlice);
    transitions.push(...series.transitions);
    deduplicatedSnapshotCount += series.deduplicatedSnapshotCount;
  }
  rawUsageEvents.length = 0;
  rateLimitSnapshots.length = 0;
  transitions.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.slot.localeCompare(right.slot));
  return { transitions, deduplicatedSnapshotCount };
}

const UNIFIED_CALIBRATION_READ_BATCH_ROWS = 20_000;

/**
 * Cheap usability probe for the unified calibration corpus, run BEFORE the
 * scan so the scan can skip retaining its own window-bounded transition
 * inputs. The corpus itself is materialized only AFTER the scan finishes:
 * holding both the corpus and the scan's working set at once measured past
 * the accounting RSS ceiling on the real dev corpus, while sequencing them
 * keeps the peak to whichever is larger.
 */
async function probeUnifiedCalibrationCorpus(indexFile) {
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch {
    return false;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const hasUsage = database.prepare(
      "SELECT 1 AS present FROM usage_event LIMIT 1",
    ).get()?.present === 1;
    const hasWeeklyQuota = database.prepare(`
      SELECT 1 AS present FROM quota_observation
      WHERE limit_id = 'codex' AND duration_mins = ?
        AND used_percent IS NOT NULL AND resets_at_ms IS NOT NULL
      LIMIT 1`).get(WEEKLY_WINDOW_MINUTES)?.present === 1;
    return hasUsage && hasWeeklyQuota;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

/**
 * The full-history weekly-calibration corpus, read from the unified local
 * index in the same compact pre-priced encoding the windowed scan retains.
 *
 * This is what removes the calibration's data window: `usage_event` and
 * `quota_observation` have no lower time bound, so the corpus spans everything
 * ever indexed. The only remaining bound is the transition miner's structural
 * input ceiling (750k usage events — count-based memory safety owned by
 * codex-transition-miner.js, not a day window; it covers years of typical use
 * and 130+ days of the heaviest observed usage). When the corpus exceeds it,
 * the newest rows are retained and the returned `coveredAt` names the span
 * honestly.
 *
 * Quota rows are collapsed to the first and last observation of each
 * unchanged (window, percent) run before retention. The miner derives a
 * transition only where the displayed percent changes between consecutive
 * observations of one window, so this collapse is transition-lossless while
 * shrinking hundreds of thousands of repeated readings to the boundaries the
 * calibration actually uses.
 *
 * Failures degrade to `null` — the caller falls back to the windowed corpus —
 * except aborts and the build's own resource-guard errors, which propagate.
 */
async function readUnifiedIndexCalibrationCorpus({
  indexFile,
  endMs,
  limits,
  signal,
  checkRuntimeMemory,
}) {
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch {
    return null;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const usageGraceMs = endMs + 5 * 60_000;
    const usageCount = Number(database.prepare(
      "SELECT COUNT(*) AS c FROM usage_event WHERE observed_at_ms <= ?",
    ).get(usageGraceMs)?.c ?? 0);
    if (usageCount === 0) return null;
    let retainedStartMs = null;
    if (usageCount > limits.usageEvents) {
      const cutoff = database.prepare(`
        SELECT observed_at_ms AS ms FROM usage_event
        WHERE observed_at_ms <= ?
        ORDER BY observed_at_ms DESC
        LIMIT 1 OFFSET ?`).get(usageGraceMs, limits.usageEvents - 1);
      retainedStartMs = Number(cutoff?.ms);
      if (!Number.isSafeInteger(retainedStartMs)) return null;
    }

    const price = createAccountingPricer();
    const usageStatement = database.prepare(`
      SELECT u.rowid AS row_id,
             u.observed_at_ms AS observed_at_ms,
             m.model_id AS model_id,
             t.codex_speed_mode AS codex_speed_mode,
             t.api_service_tier AS api_service_tier,
             u.tokens_in_uncached AS tokens_in_uncached,
             u.tokens_in_cache_read AS tokens_in_cache_read,
             u.tokens_in_cache_write AS tokens_in_cache_write,
             u.tokens_out_text AS tokens_out_text,
             u.tokens_out_reasoning AS tokens_out_reasoning,
             u.tokens_out_combined AS tokens_out_combined,
             u.total_input_context AS total_input_context
      FROM usage_event u
      JOIN model m ON m.id = u.model_id
      JOIN tier_semantics t ON t.id = u.tier_id
      WHERE u.rowid > ? AND u.observed_at_ms >= ? AND u.observed_at_ms <= ?
      ORDER BY u.rowid
      LIMIT ${UNIFIED_CALIBRATION_READ_BATCH_ROWS}`);
    const stampedUsage = [];
    let processed = 0;
    let afterRowId = -1;
    const lowerBoundMs = retainedStartMs ?? -1;
    for (;;) {
      const batch = usageStatement.all(afterRowId, lowerBoundMs, usageGraceMs);
      if (batch.length === 0) break;
      for (const row of batch) {
        processed += 1;
        if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
          throwIfAborted(signal);
          checkRuntimeMemory();
          await cooperativeYield();
        }
        const observedMs = Number(row.observed_at_ms);
        if (!Number.isSafeInteger(observedMs)) continue;
        const tokenValue = (value) => (
          Number.isSafeInteger(Number(value)) && Number(value) >= 0
            ? Number(value)
            : 0
        );
        const rawEvent = {
          timestamp: new Date(observedMs).toISOString(),
          model: row.model_id,
          // NULL means "the record did not report a total"; it must stay
          // absent so the pricer bands by the summed input components exactly
          // as it does on the scan path, instead of reading NULL as zero.
          ...(row.total_input_context === null
            ? {}
            : { totalInputContextTokens: Number(row.total_input_context) }),
          components: {
            input_uncached_tokens: tokenValue(row.tokens_in_uncached),
            input_cache_read_tokens: tokenValue(row.tokens_in_cache_read),
            input_cache_write_tokens: tokenValue(row.tokens_in_cache_write),
            output_text_tokens: tokenValue(row.tokens_out_text),
            output_reasoning_tokens: tokenValue(row.tokens_out_reasoning),
            output_combined_tokens: tokenValue(row.tokens_out_combined),
          },
          tierSemantics: {
            codexSpeedMode: row.codex_speed_mode,
            apiServiceTier: row.api_service_tier,
          },
        };
        const event = eventProjection(rawEvent, price);
        // The calibration corpus mirrors the scan retention exactly: no
        // zero-token rows, and no separately metered Spark rows.
        if (event === null || event.isSpark) continue;
        stampedUsage.push([
          observedMs,
          transitionUsageProjection(rawEvent, event),
        ]);
      }
      afterRowId = Number(batch.at(-1).row_id);
      if (batch.length < UNIFIED_CALIBRATION_READ_BATCH_ROWS) break;
    }
    if (stampedUsage.length === 0) return null;
    stampedUsage.sort((left, right) => left[0] - right[0]);
    if (stampedUsage.length > limits.usageEvents) {
      stampedUsage.splice(0, stampedUsage.length - limits.usageEvents);
    }
    const firstUsageMs = stampedUsage[0][0];
    const rawUsageEvents = stampedUsage.map(([, row]) => row);
    stampedUsage.length = 0;

    const snapshotLowerMs = retainedStartMs === null
      ? -1
      : firstUsageMs;
    const snapshotStatement = database.prepare(`
      SELECT observed_at_ms, slot, plan_type, used_percent, resets_at_ms
      FROM quota_observation
      WHERE limit_id = 'codex' AND duration_mins = ?
        AND used_percent IS NOT NULL AND resets_at_ms IS NOT NULL
        AND observed_at_ms >= ? AND observed_at_ms <= ?
      ORDER BY observed_at_ms, id`);
    const weeklyRateLimitSnapshots = [];
    let firstSnapshotMs = null;
    const groupRuns = new Map();
    const emit = (pending) => {
      weeklyRateLimitSnapshots.push(weeklyRateLimitProjection({
        timestamp: new Date(pending.observedMs).toISOString(),
        timestampMs: pending.observedMs,
        window: {
          provider: "openai_codex",
          planType: pending.planType,
          limitId: "codex",
          slot: pending.slot,
          windowDurationMins: WEEKLY_WINDOW_MINUTES,
          resetsAt: pending.resetsAtSec,
          usedPercent: pending.usedPercent,
        },
      }));
    };
    for (const row of snapshotStatement.iterate(
      WEEKLY_WINDOW_MINUTES,
      snapshotLowerMs,
      endMs,
    )) {
      processed += 1;
      if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
        throwIfAborted(signal);
        checkRuntimeMemory();
        await cooperativeYield();
      }
      const observedMs = Number(row.observed_at_ms);
      const resetsAtSec = Math.floor(Number(row.resets_at_ms) / 1_000);
      const usedPercent = Number(row.used_percent);
      if (!Number.isSafeInteger(observedMs)
          || !Number.isSafeInteger(resetsAtSec)
          || resetsAtSec <= 0
          || !Number.isFinite(usedPercent)) continue;
      if (firstSnapshotMs === null) firstSnapshotMs = observedMs;
      const projected = {
        observedMs,
        slot: row.slot,
        planType: typeof row.plan_type === "string" && row.plan_type.length > 0
          ? row.plan_type
          : "unknown",
        usedPercent,
        resetsAtSec,
      };
      const groupKey = `${projected.slot}\0${projected.planType}\0${resetsAtSec}`;
      const run = groupRuns.get(groupKey);
      if (run !== undefined && run.usedPercent === usedPercent) {
        // Same displayed state as the previous observation of this window:
        // remember it as the run's pending last row, emit it only when the
        // state changes or the stream ends.
        run.pending = projected;
        continue;
      }
      if (run?.pending) emit(run.pending);
      emit(projected);
      groupRuns.set(groupKey, { usedPercent, pending: null });
    }
    for (const run of groupRuns.values()) {
      if (run.pending) emit(run.pending);
    }
    if (weeklyRateLimitSnapshots.length === 0) return null;
    if (weeklyRateLimitSnapshots.length > limits.weeklySnapshots
        || rawUsageEvents.length + weeklyRateLimitSnapshots.length
          > limits.combinedInputs
        || rawUsageEvents.length * COMPACT_USAGE_RETAINED_BYTES
          + weeklyRateLimitSnapshots.length * COMPACT_SNAPSHOT_RETAINED_BYTES
          > limits.retainedBytes) {
      return null;
    }
    throwIfAborted(signal);
    checkRuntimeMemory();
    const coveredStartMs = firstSnapshotMs === null
      ? firstUsageMs
      : Math.min(firstUsageMs, firstSnapshotMs);
    return {
      rawUsageEvents,
      weeklyRateLimitSnapshots,
      coveredAt: {
        startAt: new Date(coveredStartMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
      },
    };
  } catch (error) {
    if (error?.name === "AbortError"
        || (typeof error?.code === "string"
          && error.code.startsWith("accounting_"))) {
      throw error;
    }
    return null;
  } finally {
    database.close();
  }
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
  // The unified local index. When present and readable, the weekly
  // calibration transition corpus is read from it — the full indexed history,
  // with no time window at all — and the scan-window corpus becomes the
  // fallback for machines that do not have the index yet.
  unifiedIndexFile = null,
  transitionResourceLimits: requestedTransitionResourceLimits = null,
  rss = () => process.memoryUsage().rss,
  maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
} = {}) {
  const endMs = now();
  if (!Number.isFinite(endMs)
      || !Number.isSafeInteger(windowDays)
      || windowDays < MINIMUM_WINDOW_DAYS
      || windowDays > MAXIMUM_WINDOW_DAYS
      || (unifiedIndexFile !== null
        && (typeof unifiedIndexFile !== "string" || unifiedIndexFile.length < 1))
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
  // Whether the unified index can supply the full-history calibration corpus.
  // Probed before the scan so the scan skips retaining its own window-bounded
  // transition inputs; the corpus itself is materialized only after the scan,
  // keeping the two working sets sequential rather than resident together. A
  // missing or unusable index degrades to the windowed corpus here; it never
  // fails the build.
  const useUnifiedCalibration = unifiedIndexFile !== null
    && await probeUnifiedCalibrationCorpus(unifiedIndexFile);
  const retainWindowedCalibrationInputs = !useUnifiedCalibration;
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
  const sparkTimeline = new Map();
  const weeklyQuotaTimelineBuckets = new Map();
  const sparkQuotaTimelineBuckets = new Map();
  const weeklyPaceSnapshots = [];
  const rawUsageEvents = [];
  const weeklyRateLimitSnapshots = [];
  let retainedSparkUsageEvents = 0;
  let retainedSparkSnapshotInputs = 0;
  const price = createAccountingPricer();
  let retainedTransitionBytes = 0;
  let retainedTransitionInputs = 0;
  // When the unified index supplies the calibration corpus, the scan retains
  // no transition inputs of its own; this counter only preserves the periodic
  // RSS check cadence the reserve path would otherwise provide.
  let unretainedCalibrationInputs = 0;
  const observeUnretainedCalibrationInput = () => {
    unretainedCalibrationInputs += 1;
    if (unretainedCalibrationInputs % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      checkRuntimeMemory();
    }
  };
  const reserveTransitionInput = (kind) => {
    const usageCount = rawUsageEvents.length + retainedSparkUsageEvents;
    const snapshotCount = weeklyRateLimitSnapshots.length
      + retainedSparkSnapshotInputs;
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
        if (retainWindowedCalibrationInputs) {
          reserveTransitionInput("usage");
        } else {
          observeUnretainedCalibrationInput();
        }
        if (event.isSpark) {
          if (retainWindowedCalibrationInputs) retainedSparkUsageEvents += 1;
          for (const [id, period] of periods) {
            if (observedMs >= starts[id]) addEvent(period, event);
          }
          addTimelineEvent(sparkTimeline, event);
          return;
        }
        if (retainWindowedCalibrationInputs) {
          rawUsageEvents.push(transitionUsageProjection(rawEvent, event));
        }
        for (const [id, period] of periods) {
          if (observedMs >= starts[id]) addEvent(period, event);
        }
        addTimelineEvent(timeline, event);
      },
      onRateLimitSnapshot: (snapshot) => {
        throwIfAborted(signal);
        const window = snapshot?.window;
        const observedAt = canonicalInstant(snapshot?.timestamp);
        const observedMs = observedAt === null
          ? Number.NaN
          : Date.parse(observedAt);
        if (!Number.isFinite(observedMs)
            || observedMs < startMs
            || observedMs > endMs) return;
        if (window?.limitId === "codex-spark"
            && window.provider === "openai_codex"
            && isValidQuotaWindowDuration(window.windowDurationMins)) {
          if (retainWindowedCalibrationInputs) {
            reserveTransitionInput("snapshot");
            retainedSparkSnapshotInputs += 1;
          } else {
            observeUnretainedCalibrationInput();
          }
          retainQuotaTimeline(
            sparkQuotaTimelineBuckets,
            snapshot,
            { limitId: "codex-spark", durationMinutes: null },
          );
          return;
        }
        if (window?.limitId === "codex"
            && window.windowDurationMins === WEEKLY_WINDOW_MINUTES) {
          if (retainWindowedCalibrationInputs) {
            reserveTransitionInput("snapshot");
            weeklyRateLimitSnapshots.push(weeklyRateLimitProjection(snapshot));
          } else {
            observeUnretainedCalibrationInput();
          }
          retainQuotaTimeline(
            weeklyQuotaTimelineBuckets,
            snapshot,
            { limitId: "codex", durationMinutes: WEEKLY_WINDOW_MINUTES },
          );
          const paceSnapshot = weeklyPaceSnapshotProjection(snapshot);
          if (paceSnapshot !== null) weeklyPaceSnapshots.push(paceSnapshot);
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
  let unifiedCalibration = null;
  if (useUnifiedCalibration) {
    unifiedCalibration = await readUnifiedIndexCalibrationCorpus({
      indexFile: unifiedIndexFile,
      endMs,
      limits,
      signal,
      checkRuntimeMemory,
    });
    // The probe accepted this index, so the scan retained no windowed
    // fallback corpus. If the full read then fails, the only honest outputs
    // are a typed failure or a calibration falsely labelled complete-but-
    // empty; fail closed, and the next refresh re-probes from scratch.
    if (unifiedCalibration === null) {
      throw fixedError("accounting_calibration_corpus_unavailable");
    }
  }
  const retainedUsageEvents = retainWindowedCalibrationInputs
    ? rawUsageEvents.length + retainedSparkUsageEvents
    : unifiedCalibration.rawUsageEvents.length;
  const retainedWeeklySnapshots = retainWindowedCalibrationInputs
    ? weeklyRateLimitSnapshots.length + retainedSparkSnapshotInputs
    : unifiedCalibration.weeklyRateLimitSnapshots.length;
  const calibrationRetainedBytes = retainWindowedCalibrationInputs
    ? retainedTransitionBytes
    : retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES
      + retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES;
  const calibrationCoveredAt = {
    startAt: retainWindowedCalibrationInputs
      ? new Date(startMs).toISOString()
      : unifiedCalibration.coveredAt.startAt,
    endAt: new Date(endMs).toISOString(),
  };
  let transitionSeries;
  try {
    transitionSeries = await deriveBoundedWeeklyCalibrationSeries({
      startAt: calibrationCoveredAt.startAt,
      endAt: calibrationCoveredAt.endAt,
      rawUsageEvents: retainWindowedCalibrationInputs
        ? rawUsageEvents
        : unifiedCalibration.rawUsageEvents,
      rateLimitSnapshots: retainWindowedCalibrationInputs
        ? weeklyRateLimitSnapshots
        : unifiedCalibration.weeklyRateLimitSnapshots,
      // The scan diagnostics describe the windowed raw-log pass; the unified
      // corpus was fork-replay-suppressed at ingest, so its transitions do
      // not restate scan-level counts as their own.
      diagnostics: retainWindowedCalibrationInputs
        ? scanned?.diagnostics ?? {}
        : {},
      signal,
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
      startAt: calibrationCoveredAt.startAt,
      endAt: calibrationCoveredAt.endAt,
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
  const paceForecast = projectWeeklyPaceForecast(weeklyPaceSnapshots, endMs);
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
    sparkUsageTimeline: finalizeTimeline(sparkTimeline),
    quotaTimeline: finalizeWeeklyQuotaTimeline(
      weeklyQuotaTimelineBuckets,
    ),
    sparkQuotaTimeline: finalizeWeeklyQuotaTimeline(
      sparkQuotaTimelineBuckets,
    ),
    ...(paceForecast === null
      ? {}
      : { weekly: { paceForecast } }),
    weeklyCalibration,
    weeklyCalibrationInput: {
      status: "complete",
      encoding: "accounting_compact_v2",
      // Which corpus fed the calibration: the whole unified index when it is
      // present, the scan window only as the fallback. `coveredAt` states the
      // span that corpus actually reaches, so a reader can tell full history
      // from a bounded window instead of guessing.
      source: retainWindowedCalibrationInputs
        ? "windowed_scan"
        : "unified_index",
      coveredAt: calibrationCoveredAt,
      retainedUsageEvents,
      retainedWeeklySnapshots,
      estimatedRetainedBytes: calibrationRetainedBytes,
      limits,
    },
    diagnostics: publicDiagnostics(scanned?.diagnostics),
  };
}

export async function refreshReplaySafeAccountingCache({
  stateFile = null,
  // A JSON cache is no longer a supported durable target. Keeping this
  // explicit catch prevents a stale caller from silently writing SQLite bytes
  // to a misleading .json path.
  cacheFile = undefined,
  indexFile = null,
  indexSecretFile = null,
  scan = null,
  indexWorkerCount,
  indexChunkBytes,
  ...options
} = {}) {
  if (cacheFile !== undefined) {
    throw new TypeError("cacheFile was retired; use stateFile");
  }
  const selectedStateFile = stateFile ?? defaultReplaySafeAccountingCachePath();
  const selectedIndexFile = indexFile ?? resolve(
    dirname(selectedStateFile),
    "local-analysis-index-v2.sqlite",
  );
  const selectedIndexSecretFile = indexSecretFile
    ?? defaultLocalAnalysisIndexSecretPath(selectedIndexFile);
  if (typeof selectedStateFile !== "string" || selectedStateFile.length < 1
      || typeof selectedIndexFile !== "string" || selectedIndexFile.length < 1) {
    throw new TypeError("Replay-safe SQLite state paths are invalid");
  }
  if (scan !== null && typeof scan !== "function") {
    throw new TypeError("scan must be a function or null");
  }
  const effectiveScan = scan ?? createIndexedCodexLogScan({
    indexFile: selectedIndexFile,
    secretFile: selectedIndexSecretFile,
    ...(indexWorkerCount === undefined
      ? {}
      : { workerCount: indexWorkerCount }),
    ...(indexChunkBytes === undefined
      ? {}
      : { chunkBytes: indexChunkBytes }),
  });
  // Converge legacy state before spending a potentially substantial raw-log
  // scan. A live old JSON collector or an unverified parity mismatch must
  // fail before we derive a cache that cannot be committed safely.
  await prepareLocalCollectorState({ stateFile: selectedStateFile });
  const cache = await buildReplaySafeAccountingCache({
    ...options,
    scan: effectiveScan,
  });
  if (Buffer.byteLength(stableJson(cache)) > MAX_CACHE_BYTES) {
    throw fixedError("cache_invalid_size");
  }
  await writeLocalCollectorAccountingCache({ stateFile: selectedStateFile, cache });
  return cache;
}

function validWeeklyCalibrationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "complete"
      || value.encoding !== "accounting_compact_v2"
      || !["unified_index", "windowed_scan"].includes(value.source)
      || canonicalInstant(value.coveredAt?.startAt) === null
      || canonicalInstant(value.coveredAt?.endAt) === null
      || Date.parse(value.coveredAt.startAt)
        > Date.parse(value.coveredAt.endAt)
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

function validQuotaTimeline(
  value,
  coveredAt,
  { limitId = "codex", durationMinutes = WEEKLY_WINDOW_MINUTES } = {},
) {
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
        || row.limitId !== limitId
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
        || !isValidQuotaWindowDuration(row.durationMinutes)
        || (durationMinutes !== null && row.durationMinutes !== durationMinutes)
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

function validWeeklyPaceForecast(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [
        "currentUsedPercent",
        "etaAt",
        "hoursToExhaustion",
        "hoursToReset",
        "pace",
        "remainingPercent",
        "resetsAt",
        "status",
      ].sort().join("\0")
      || !PACE_STATUSES.has(value.status)
      || !Number.isFinite(value.currentUsedPercent)
      || value.currentUsedPercent < 0
      || value.currentUsedPercent > 100
      || !Number.isFinite(value.remainingPercent)
      || value.remainingPercent < 0
      || value.remainingPercent > 100
      || value.remainingPercent
        !== Number(Math.max(0, 100 - value.currentUsedPercent).toFixed(3))
      || canonicalInstant(value.resetsAt) === null
      || !value.pace
      || typeof value.pace !== "object"
      || Array.isArray(value.pace)
      || Object.keys(value.pace).sort().join("\0")
        !== "percentagePointsPerHour"
      || (value.pace.percentagePointsPerHour !== null
        && (!Number.isFinite(value.pace.percentagePointsPerHour)
          || value.pace.percentagePointsPerHour < 0
          || value.pace.percentagePointsPerHour > 100))
      || (value.etaAt !== null && canonicalInstant(value.etaAt) === null)
      || (value.hoursToExhaustion !== null
        && (!Number.isFinite(value.hoursToExhaustion)
          || value.hoursToExhaustion < 0))
      || (value.hoursToReset !== null
        && (!Number.isFinite(value.hoursToReset) || value.hoursToReset < 0))) {
    return false;
  }
  return true;
}

function validWeeklyPaceContainer(value) {
  return value !== undefined
    && value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, "paceForecast")
    && validWeeklyPaceForecast(value.paceForecast);
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
      || !validQuotaTimeline(
        value.sparkQuotaTimeline,
        value.coveredAt,
        { limitId: "codex-spark", durationMinutes: null },
      )
      || (value.weekly !== undefined && !validWeeklyPaceContainer(value.weekly))
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
    ))
    && Array.isArray(value.sparkUsageTimeline)
    && value.sparkUsageTimeline.every((row) => (
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
  stateFile = null,
  cacheFile = undefined,
  now = null,
  maximumAgeMs = null,
} = {}) {
  if (cacheFile !== undefined) {
    throw new TypeError("cacheFile was retired; use stateFile");
  }
  const selectedStateFile = stateFile ?? defaultReplaySafeAccountingCachePath();
  if (typeof selectedStateFile !== "string" || selectedStateFile.length < 1) {
    throw new TypeError("Replay-safe SQLite state path is invalid");
  }
  if (now !== null && typeof now !== "function") {
    throw new TypeError("now must be a function or null");
  }
  if (maximumAgeMs !== null
      && (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0)) {
    throw new TypeError("maximumAgeMs must be a non-negative safe integer or null");
  }
  let unavailableErrorCode = null;
  let parsed = null;
  try {
    await prepareLocalCollectorState({ stateFile: selectedStateFile });
    const stored = await readLocalCollectorAccountingCache({ stateFile: selectedStateFile });
    if (stored.status === "missing" || stored.cache === null) {
      unavailableErrorCode = "cache_missing";
    } else {
      parsed = stored.cache;
    }
  } catch (error) {
    unavailableErrorCode = error?.code === "local_collector_state_missing"
      ? "cache_missing"
      : "cache_unavailable";
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
