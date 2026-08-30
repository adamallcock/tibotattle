import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  APP_PRICE_REGISTRY_MANIFEST,
  DEFAULT_UNRESOLVED_SPEED_SCENARIO,
  FAST_MODE_ASSUMED_MULTIPLIER,
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  priceCodexUsageEvent,
  summarizeQuotaWeightedAccounting,
} from "@app-usagemonitor/accounting";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import { recognizedCodexModelId } from "./export/index.js";
import {
  readLocalCollectorAccountingCache,
} from "./local-collector-state.js";
import {
  usageProjection,
} from "./local-companion-usage-model.js";
import {
  openLocalUnifiedIndex,
} from "./local-unified-index.js";
import {
  createAccountingPricer,
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "./replay-safe-accounting-cache.js";
import { forEachRolloutLine } from "./rollout-line-reader.js";

export const SIDE_CHAT_ESTIMATE_SCHEMA_VERSION =
  "development-side-chat-estimate-v0.4";
export const SIDE_CHAT_ESTIMATE_PARSER_VERSION =
  "desktop-fork-logs2-active-context-v0.3";
export const SIDE_CHAT_HISTORICAL_GAP_SCHEMA_VERSION =
  "development-side-chat-historical-gap-v0.3";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`, "iu");
const CONVERSATION_PATTERN = new RegExp(`\\bconversationId=(${UUID})\\b`, "iu");
const TURN_PATTERN = new RegExp(`\\bturn\\.id=(${UUID})\\b`, "iu");
const POST_SAMPLING_PATTERN = new RegExp(
  `\\bpost sampling token usage turn_id=(${UUID})\\b`
    + "[^\\r\\n]{0,256}?\\btotal_usage_tokens=(\\d+)\\b",
  "iu",
);
const MODEL_PATTERN = /\bmodel=([a-z0-9][a-z0-9._-]{0,63})\b/iu;
const EFFORT_PATTERN = /\bcodex\.turn\.reasoning_effort=([a-z]+)\b/iu;
const COMPACTION_PATTERN = /\brun_auto_compact\{reason=[^}\r\n]{1,64}\s+phase=[^}\r\n]{1,64}\}/u;

const DESKTOP_FORK = Buffer.from("method=thread/fork", "utf8");
const DESKTOP_INJECT = Buffer.from("method=thread/inject_items", "utf8");
const DESKTOP_SIDE_ROUTE = Buffer.from(
  "IAB_LIFECYCLE received browser use session route capture",
  "utf8",
);
const DESKTOP_SIDE_ROUTE_FALLBACK = Buffer.from(
  "IAB_LIFECYCLE captured session route",
  "utf8",
);
const ROUTE_DISPOSITION = Buffer.from("disposeAfterSessionActivity=false", "utf8");

// The owner's current desktop logs contain a small number of diagnostic lines
// between 16 KiB and 376 KiB. A 512 KiB bound reads those lines without making
// lifecycle coverage look complete after silently skipping them.
const DESKTOP_LINE_BYTES = 512 * 1024;
const MAX_DESKTOP_FILES = 10_000;
const MAX_DESKTOP_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LIFECYCLE_GAP_MS = 10_000;
const MAX_SIDE_CHAT_SESSIONS = 10_000;
const MAX_LOG_ROWS = 100_000;
const LOGS2_THREAD_RETENTION_LIMIT = 1_000;
const LOGS2_APPROXIMATE_RETENTION_DAYS = 10;
export const SIDE_CHAT_RECENT_DETAIL_LIMIT = 500;
const TIMELINE_BUCKET_MS = 15 * 60_000;
const GPT_56_WARM_ELIGIBILITY_MS = 30 * 60_000;
const OTHER_MODEL_WARM_ELIGIBILITY_MS = 5 * 60_000;
const HISTORICAL_GAP_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const HISTORICAL_GAP_RESET_TOLERANCE_MS = 2 * 60_000;
const HISTORICAL_GAP_QUOTA_WINDOW_MINUTES = 10_080;
const HISTORICAL_GAP_ACCOUNTING_METHOD =
  "lineage_aware_cumulative_snapshot_replay_exclusion";
const HISTORICAL_GAP_PRICE_EPOCH_BASIS =
  "event_time_when_registry_has_effective_evidence";
const HISTORICAL_GAP_TIME_ZONE = "America/New_York";
const HISTORICAL_GAP_SPEEDS = Object.freeze([
  "fast",
  "standard",
  "unknown",
  "other",
]);

const CALIBRATION_MODEL = "gpt-5.6-sol";
const CALIBRATION_EFFORTS = new Set(["high", "max", "ultra"]);
const CALIBRATION_MATCHED_CALLS = 818;
const CALIBRATION_AT = "2026-08-17T02:20:00.000Z";
const CALIBRATION_AT_MS = Date.parse(CALIBRATION_AT);
const CALIBRATION_FRESH_FOR_MS = 30 * 24 * 60 * 60_000;
const CALIBRATION_MAX_ACTIVE_CONTEXT_TOKENS = 271_999;
const CACHE_WRITE_PRICED_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-sol-wm",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
const CONDITIONAL_ALIAS_MODELS = new Set([
  "codex-auto-review",
  "gpt-5.5-codex",
  "gpt-5.6-sol-wm",
]);

// Frozen from the aggregate-only matched durable Sol high/max calibration in
// docs/research/2026-08-16-side-chat-accounting-observability.md. These are
// assumptions, not observations from an ephemeral child. The point estimate
// deliberately follows the owner's development hypothesis: an ordinary fork
// is mostly warm, while the first sampling call after an observed compaction
// is cold. The low side uses the warmest durable-cohort observation; because
// child cache and cache-write fields are absent, the high side is deliberately
// a fully cold sensitivity rather than a claimed p90 interval. GPT-5.6 cards
// price that cold side as a new cache write; older reviewed cards without a
// cache-write category use ordinary uncached input instead.
export const SIDE_CHAT_ESTIMATE_ASSUMPTIONS = Object.freeze({
  activeToProviderTotal: Object.freeze({
    lowerCost: 1.1137,
    point: 1.0172,
    upperCost: 1.0007,
  }),
  outputToInput: Object.freeze({
    lowerCost: 0.00071,
    point: 0.0024,
    upperCost: 0.00953,
  }),
  ordinaryCacheReadShare: Object.freeze({
    lowerCost: 0.9954,
    point: 0.9857,
    // No child cache field survives. Keep the owner-directed warm point, but
    // make the high side a true cold sensitivity rather than transferring the
    // durable cohort's p10 cache share as if it had been observed here.
    upperCost: 0,
  }),
  postCompactionCacheReadShare: Object.freeze({
    lowerCost: 0,
    point: 0,
    upperCost: 0,
  }),
  // Cache-write telemetry is absent. The low and point scenarios treat the
  // non-read remainder as ordinary uncached input; the high-cost sensitivity
  // treats it as a cache write, which current GPT-5.6 cards price at 1.25x.
  uncachedRemainderCacheWriteShare: Object.freeze({
    lowerCost: 0,
    point: 0,
    upperCost: 1,
  }),
  warmEligibilitySeconds: Object.freeze({
    gpt56: GPT_56_WARM_ELIGIBILITY_MS / 1_000,
    other: OTHER_MODEL_WARM_ELIGIBILITY_MS / 1_000,
  }),
});

const PERIODS = Object.freeze([
  Object.freeze({ id: "24h", label: "Last 24 hours", milliseconds: 24 * 60 * 60_000 }),
  Object.freeze({ id: "7d", label: "Last 7 days", milliseconds: 7 * 24 * 60 * 60_000 }),
  Object.freeze({ id: "30d", label: "Last 30 days", milliseconds: 30 * 24 * 60 * 60_000 }),
  Object.freeze({ id: "all", label: "All retained side-chat evidence", milliseconds: null }),
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalInstant(milliseconds) {
  return Number.isSafeInteger(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function roundMoney(value) {
  return Number.isFinite(value) ? Number(value.toFixed(12)) : null;
}

function tokenCount(value) {
  if (value === null || value === undefined || value === ""
      || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function roundHistoricalGap(value, digits = 12) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function nextIsoDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function localClockParts(milliseconds, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(milliseconds);
  return Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

// Convert one civil midnight without assuming that Eastern Time is always
// UTC-4 or UTC-5. Midnight itself is unambiguous on the supported reporting
// zone, and the short correction loop also handles the 23/25-hour DST days.
function reportingMidnightMs(date, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = localClockParts(candidate, timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const correction = target - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  const verified = localClockParts(candidate, timeZone);
  if (verified.year !== year || verified.month !== month || verified.day !== day
      || verified.hour !== 0 || verified.minute !== 0
      || verified.second !== 0) {
    throw fixedError("side_chat_historical_gap_date_unavailable");
  }
  return candidate;
}

function historicalGapDayBounds(date, timeZone) {
  const startMs = reportingMidnightMs(date, timeZone);
  const endMs = reportingMidnightMs(nextIsoDate(date), timeZone);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
      || endMs <= startMs
      || ![23, 24, 25].includes((endMs - startMs) / 3_600_000)) {
    throw fixedError("side_chat_historical_gap_date_unavailable");
  }
  return { startMs, endMs };
}

export function unavailableHistoricalSideChatGapProbe(errorCode, date = null) {
  return {
    schemaVersion: SIDE_CHAT_HISTORICAL_GAP_SCHEMA_VERSION,
    status: "unavailable",
    errorCode,
    date: HISTORICAL_GAP_DATE.test(date ?? "") ? date : null,
    timeZone: HISTORICAL_GAP_TIME_ZONE,
    startAt: null,
    endAt: null,
    basis: "quota_residual_backcast_not_observed_side_chat_usage",
    quota: null,
    exactUsage: null,
    calibration: null,
    estimate: null,
  };
}

function cacheSchemaMinor(version) {
  const match = /^local-replay-safe-accounting-v0\.(\d+)$/u.exec(version ?? "");
  return match ? Number(match[1]) : null;
}

function historicalGapCalibration(cache) {
  const sourceMinor = cacheSchemaMinor(cache?.schemaVersion);
  const currentMinor = cacheSchemaMinor(REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  if (!Number.isSafeInteger(sourceMinor)
      || !Number.isSafeInteger(currentMinor)
      || sourceMinor < currentMinor
      || cache?.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || cache?.priceRegistryObservedAt !== APP_PRICE_REGISTRY_MANIFEST.observedAt
      || cache?.accountingMethod !== HISTORICAL_GAP_ACCOUNTING_METHOD
      || cache?.priceEpochBasis !== HISTORICAL_GAP_PRICE_EPOCH_BASIS) {
    return null;
  }
  const container = cache?.allowanceCapacityByScenario;
  const basis = codexPrimaryAllowanceBasis("unresolved_as_standard");
  if (container?.schemaVersion
        !== "codex-primary-allowance-capacity-v0.1"
      || container?.basisFamilyId !== basis.basisFamilyId) return null;
  const scenarios = {};
  const expectedCandidates = {
    unresolved_as_standard: "speed_lower",
    unresolved_as_fast: "speed_upper",
  };
  for (const [scenario, selectedCostBasis] of Object.entries(
    expectedCandidates,
  )) {
    const source = container.scenarios?.[scenario];
    const expectedBasis = codexPrimaryAllowanceBasis(scenario);
    const weekly = source?.calibration;
    const estimate = weekly?.estimate;
    const plausible = estimate?.plausibleRangeUsd;
    const median = Number(estimate?.medianApiPriceEquivalentUsd);
    const lower = Number(plausible?.lower);
    const upper = Number(plausible?.upper);
    const qualifyingResets = Number(estimate?.qualifyingResets);
    const recentResetIdentities = Array.isArray(weekly?.recentResets)
      ? weekly.recentResets.map((row) => canonicalInstant(
        Date.parse(row?.resetIdentity ?? ""),
      ))
      : null;
    if (!source?.basis || Object.keys(source.basis).length
          !== Object.keys(expectedBasis).length
        || !Object.entries(expectedBasis).every(([key, value]) => (
          source.basis[key] === value
        ))
        || weekly?.schemaVersion !== "weekly-calibration-summary-v0.1"
        || weekly?.status !== "estimated"
        || weekly?.evidenceBasis
            !== "lineage_aware_local_usage_and_provider_percentage_snapshots"
        || weekly?.interpretation
            !== "conditional_api_price_equivalent_not_provider_allowance_or_bill"
        || weekly?.accountAttribution?.status !== "historical_unattributed"
        || weekly?.accountAttribution?.maySpanMultipleAccounts !== true
        || weekly?.validation?.selectedCostBasis !== selectedCostBasis
        || !Number.isFinite(median) || median <= 0
        || !Number.isFinite(lower) || lower <= 0
        || !Number.isFinite(upper) || upper < median
        || lower > median
        || !Number.isSafeInteger(qualifyingResets) || qualifyingResets < 1
        || recentResetIdentities === null
        || recentResetIdentities.some((value) => value === null)) return null;
    const generatedAt = canonicalInstant(Date.parse(weekly.generatedAt));
    if (generatedAt === null) return null;
    scenarios[scenario] = {
      basisId: expectedBasis.basisId,
      generatedAt,
      selectedCostBasis,
      medianWeeklyCapacityUsd: roundHistoricalGap(median),
      plausibleWeeklyCapacityRangeUsd: {
        lower: roundHistoricalGap(lower),
        upper: roundHistoricalGap(upper),
      },
      qualifyingResets,
      cohortId: createHash("sha256")
        .update(JSON.stringify(recentResetIdentities))
        .digest("hex"),
      recentResetIdentities,
    };
  }
  const standard = scenarios.unresolved_as_standard;
  const fast = scenarios.unresolved_as_fast;
  if (standard.qualifyingResets !== fast.qualifyingResets
      || standard.cohortId !== fast.cohortId
      || standard.recentResetIdentities.length
        !== fast.recentResetIdentities.length
      || !standard.recentResetIdentities.every(
        (value, index) => value === fast.recentResetIdentities[index],
      )) return null;
  for (const scenario of Object.keys(scenarios)) {
    delete scenarios[scenario].recentResetIdentities;
  }
  return {
    sourceCacheSchemaVersion: cache.schemaVersion,
    sourceCacheRelationship: sourceMinor === currentMinor
      ? "current_schema"
      : "validated_newer_schema_subdocument",
    weeklyCalibrationSchemaVersion: "weekly-calibration-summary-v0.1",
    basisFamilyId: basis.basisFamilyId,
    accountAttribution: "historical_unattributed_may_combine_accounts",
    scenarios,
    timelineCapacityEligible: true,
  };
}

function sameHistoricalGapReset(reference, row) {
  return Number.isSafeInteger(reference?.resetsAtMs)
    && Number.isSafeInteger(row?.resetsAtMs)
    && Math.abs(reference.resetsAtMs - row.resetsAtMs)
      <= HISTORICAL_GAP_RESET_TOLERANCE_MS;
}

function historicalGapQuota(database, { startMs, endMs }) {
  const rows = database.prepare(`
    SELECT observed_at_ms, used_percent, resets_at_ms
    FROM quota_observation
    WHERE limit_id = 'codex'
      AND slot = 'primary'
      AND duration_mins = ?
      AND used_percent IS NOT NULL
      AND resets_at_ms IS NOT NULL
      AND observed_at_ms >= ?
      AND observed_at_ms <= ?
    ORDER BY observed_at_ms
  `).all(
    HISTORICAL_GAP_QUOTA_WINDOW_MINUTES,
    startMs - 24 * 60 * 60_000,
    endMs + 24 * 60 * 60_000,
  ).flatMap((row) => {
    const observedAtMs = Number(row.observed_at_ms);
    const usedPercent = Number(row.used_percent);
    const resetsAtMs = Number(row.resets_at_ms);
    return Number.isSafeInteger(observedAtMs)
        && Number.isFinite(usedPercent)
        && usedPercent >= 0 && usedPercent <= 100
        && Number.isSafeInteger(resetsAtMs)
      ? [{ observedAtMs, usedPercent, resetsAtMs }]
      : [];
  });
  const startBefore = rows.findLast((row) => row.observedAtMs <= startMs);
  if (!startBefore) return null;
  const track = rows.filter((row) => sameHistoricalGapReset(startBefore, row));
  const startAfter = track.find((row) => row.observedAtMs >= startMs);
  const endBefore = track.findLast((row) => row.observedAtMs <= endMs);
  const endAfter = track.find((row) => row.observedAtMs >= endMs);
  if (!startAfter || !endBefore || !endAfter
      || startAfter.observedAtMs > endBefore.observedAtMs
      || startBefore.usedPercent > startAfter.usedPercent
      || startAfter.usedPercent > endBefore.usedPercent
      || endBefore.usedPercent > endAfter.usedPercent) return null;
  const minimumMovement = endBefore.usedPercent - startAfter.usedPercent;
  const maximumMovement = endAfter.usedPercent - startBefore.usedPercent;
  if (minimumMovement < 0 || maximumMovement < minimumMovement) return null;
  const publicRow = (row) => ({
    observedAt: canonicalInstant(row.observedAtMs),
    usedPercent: row.usedPercent,
  });
  return {
    limitId: "codex",
    slot: "primary",
    durationMinutes: HISTORICAL_GAP_QUOTA_WINDOW_MINUTES,
    resetAt: canonicalInstant(startBefore.resetsAtMs),
    startBefore: publicRow(startBefore),
    startAfter: publicRow(startAfter),
    endBefore: publicRow(endBefore),
    endAfter: publicRow(endAfter),
    minimumMovementPercentagePoints: roundHistoricalGap(minimumMovement, 6),
    maximumMovementPercentagePoints: roundHistoricalGap(maximumMovement, 6),
    observationPrecision: "whole_percentage_points",
  };
}

function historicalGapSpeedKey(speed) {
  return HISTORICAL_GAP_SPEEDS.includes(speed) ? speed : "other";
}

function emptyHistoricalGapSpeedSummary() {
  return {
    events: 0,
    totalTokens: 0,
    standardApiPriceEquivalentUsd: 0,
  };
}

function addHistoricalGapWeighting(crossing, speed, family, cost) {
  const speedKey = ["standard", "fast", "unknown"].includes(speed)
    ? speed
    : "unknown";
  const cell = crossing[speedKey][family];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += cost;
}

function historicalGapAllowanceWeighting({
  speedWeighting,
  declaredSpeedWeighting,
}) {
  const summaries = Object.fromEntries([
    "unresolved_as_standard",
    "unresolved_as_fast",
  ].map((scenario) => [scenario, summarizeQuotaWeightedAccounting({
    speedWeighting,
    declaredSpeedWeighting,
    unresolvedScenario: scenario,
  })]));
  const scenarios = Object.fromEntries(Object.entries(summaries).map(
    ([scenario, summary]) => {
      const complete = summary.weightingStatus === "complete"
        && summary.coverage.unknownEvents === 0;
      return [scenario, {
        basisId: codexPrimaryAllowanceBasis(scenario).basisId,
        sourceWeightingStatus: summary.weightingStatus,
        quotaWeightedUsd: complete
          ? roundHistoricalGap(summary.quotaWeightedApiPriceEquivalentUsd)
          : null,
        coveredSubtotalUsd: summary.weightingStatus === "unknown"
          ? 0
          : roundHistoricalGap(
            summary.quotaWeightedApiPriceEquivalentUsd,
          ),
        coverage: { ...summary.coverage },
      }];
    },
  ));
  // The default scenario carries the money; the fast scenario stays visible
  // as the sensitivity bound in `scenarios`.
  const selectedScenario = DEFAULT_UNRESOLVED_SPEED_SCENARIO;
  const values = Object.values(scenarios)
    .map((scenario) => scenario.quotaWeightedUsd)
    .filter(Number.isFinite);
  const status = selectedScenario === null
    ? values.length === 2 ? "range" : "unavailable"
    : scenarios[selectedScenario].quotaWeightedUsd === null
      ? "unavailable"
      : "complete";
  return {
    status,
    basisFamilyId: codexPrimaryAllowanceBasis(
      "unresolved_as_standard",
    ).basisFamilyId,
    selectedScenario,
    selectedUsd: status === "complete"
      ? scenarios[selectedScenario].quotaWeightedUsd
      : null,
    scenarios,
    rangeUsd: status === "range"
      ? { lower: Math.min(...values), upper: Math.max(...values) }
      : null,
  };
}

function historicalGapExactUsage(database, {
  startMs,
  endMs,
  declaredSpeedBaselines,
}) {
  const statement = database.prepare(`
    SELECT u.observed_at_ms, u.session_local,
           m.model_id, t.codex_speed_mode, t.api_service_tier,
           s.surface, s.agent_scope, s.lineage_disposition,
           a.status AS scope_status,
           u.tokens_in_uncached, u.tokens_in_cache_read,
           u.tokens_in_cache_write, u.tokens_out_text,
           u.tokens_out_reasoning, u.tokens_out_combined,
           u.total_input_context
    FROM usage_event u
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN surface_class s ON s.id = u.surface_id
    JOIN account_scope a ON a.id = u.account_scope_id
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ?
    ORDER BY u.observed_at_ms
  `);
  const bySpeed = Object.fromEntries(HISTORICAL_GAP_SPEEDS.map((speed) => [
    speed,
    emptyHistoricalGapSpeedSummary(),
  ]));
  const sessions = new Set();
  const models = new Set();
  const pricer = createAccountingPricer();
  let events = 0;
  let totalTokens = 0;
  let standardCost = 0;
  let unpricedEvents = 0;
  const speedWeighting = emptySpeedWeightingCrossing();
  const declaredSpeedWeighting = emptySpeedWeightingCrossing();
  for (const row of statement.iterate(startMs, endMs)) {
    const observedAtMs = Number(row.observed_at_ms);
    const observedAt = canonicalInstant(observedAtMs);
    if (observedAt === null) continue;
    const record = {
      observedAt,
      model: row.model_id,
      components: {
        input_uncached_tokens: tokenCount(row.tokens_in_uncached) ?? 0,
        input_cache_read_tokens: tokenCount(row.tokens_in_cache_read) ?? 0,
        input_cache_write_tokens: tokenCount(row.tokens_in_cache_write) ?? 0,
        output_text_tokens: tokenCount(row.tokens_out_text) ?? 0,
        output_reasoning_tokens: tokenCount(row.tokens_out_reasoning) ?? 0,
        output_combined_tokens: tokenCount(row.tokens_out_combined) ?? 0,
      },
      tierSemantics: {
        codexSpeedMode: row.codex_speed_mode,
        apiServiceTier: row.api_service_tier,
      },
      surfaceClassification: {
        surface: row.surface,
        agentScope: row.agent_scope,
        lineageDisposition: row.lineage_disposition,
      },
      accountScope: { status: row.scope_status },
    };
    const declaredMode = declaredSpeedModeAt(
      declaredSpeedBaselines,
      observedAtMs,
    ) ?? "unknown";
    const projection = usageProjection(record, declaredMode, pricer);
    if (projection === null) continue;
    let priced;
    try {
      priced = pricer({
        timestamp: observedAt,
        model: projection.model,
        totalInputContextTokens: tokenCount(row.total_input_context),
      }, projection.components);
    } catch {
      priced = null;
    }
    const cost = Number(priced?.totalUsd);
    const pricedCompletely = ["fully_priced", "partially_priced"].includes(
      priced?.coverageStatus,
    ) && typeof priced?.totalUsd === "string"
      && /^\d+(?:\.\d+)?$/u.test(priced.totalUsd)
      && Number.isFinite(cost) && cost >= 0;
    events += 1;
    totalTokens += projection.totalTokens;
    sessions.add(Buffer.from(row.session_local).toString("hex"));
    models.add(projection.model);
    const speed = historicalGapSpeedKey(projection.speed);
    bySpeed[speed].events += 1;
    bySpeed[speed].totalTokens += projection.totalTokens;
    const family = fastModeModelFamilyKey(projection.model, {
      eventTime: observedAt,
      standardPriceCardIds: priced?.selectedPriceCardIds ?? [],
    });
    addHistoricalGapWeighting(
      speedWeighting,
      projection.speed,
      family,
      pricedCompletely ? cost : 0,
    );
    if (projection.speed === "unknown"
        && (declaredMode === "standard" || declaredMode === "fast")) {
      addHistoricalGapWeighting(
        declaredSpeedWeighting,
        declaredMode,
        family,
        pricedCompletely ? cost : 0,
      );
    }
    if (!pricedCompletely) {
      unpricedEvents += 1;
      continue;
    }
    standardCost += cost;
    bySpeed[speed].standardApiPriceEquivalentUsd += cost;
  }
  const allowanceWeighting = historicalGapAllowanceWeighting({
    speedWeighting,
    declaredSpeedWeighting,
  });
  const scenarioValues = Object.values(allowanceWeighting.scenarios)
    .map((scenario) => scenario.quotaWeightedUsd)
    .filter(Number.isFinite);
  return {
    events,
    sessions: sessions.size,
    totalTokens,
    observedModels: [...models].sort(),
    standardApiPriceEquivalentUsd: roundHistoricalGap(standardCost),
    allowanceWeighting,
    quotaWeightedApiPriceEquivalentRangeUsd: scenarioValues.length > 0
      ? {
        lower: Math.min(...scenarioValues),
        upper: Math.max(...scenarioValues),
      }
      : null,
    pricingCoverage: {
      pricedEvents: events - unpricedEvents,
      unpricedEvents,
    },
    speedWeightingCoverage: {
      unsupportedEvents: allowanceWeighting.status === "unavailable" ? 1 : 0,
      unknownSpeedEvents: bySpeed.unknown.events,
    },
    bySpeed: Object.fromEntries(HISTORICAL_GAP_SPEEDS.map((speed) => [
      speed,
      {
        ...bySpeed[speed],
        standardApiPriceEquivalentUsd: roundHistoricalGap(
          bySpeed[speed].standardApiPriceEquivalentUsd,
        ),
      },
    ])),
  };
}

/**
 * Development-only backcast for an expired side-chat day.
 *
 * This never reconstructs or adds usage. It measures exact indexed activity,
 * brackets the observed weekly-quota movement, then answers the explicitly
 * conditional question: how much same-model Fast activity would be required
 * to explain the remaining gap? The answer is calibrated to that gap and is
 * therefore a sensitivity, not independent evidence that the activity was a
 * side chat or that the inferred amount occurred.
 */
export async function collectHistoricalSideChatGapProbe({
  unifiedIndexFile,
  collectorStateFile,
  date,
  timeZone = HISTORICAL_GAP_TIME_ZONE,
  assumedMissingSpeed = "fast",
  declaredSpeedBaselines = [],
} = {}) {
  if (typeof unifiedIndexFile !== "string" || unifiedIndexFile.length < 1
      || typeof collectorStateFile !== "string" || collectorStateFile.length < 1
      || typeof date !== "string" || !HISTORICAL_GAP_DATE.test(date)
      || timeZone !== HISTORICAL_GAP_TIME_ZONE
      || assumedMissingSpeed !== "fast"
      || !Array.isArray(declaredSpeedBaselines)) {
    throw new TypeError("Historical side-chat gap options are invalid");
  }
  const unavailable = (code) => unavailableHistoricalSideChatGapProbe(code, date);
  let database;
  try {
    const { startMs, endMs } = historicalGapDayBounds(date, timeZone);
    const rawCache = await readLocalCollectorAccountingCache({
      stateFile: collectorStateFile,
    });
    const calibration = rawCache.status === "available"
      ? historicalGapCalibration(rawCache.cache)
      : null;
    if (calibration === null) {
      return unavailable("side_chat_historical_gap_calibration_unavailable");
    }
    database = openLocalUnifiedIndex(unifiedIndexFile, { readOnly: true });
    const quota = historicalGapQuota(database, { startMs, endMs });
    if (quota === null) {
      return unavailable("side_chat_historical_gap_quota_unavailable");
    }
    const exactUsage = historicalGapExactUsage(database, {
      startMs,
      endMs,
      declaredSpeedBaselines,
    });
    if (exactUsage.events === 0) {
      return unavailable("side_chat_historical_gap_usage_unavailable");
    }
    if (exactUsage.pricingCoverage.unpricedEvents > 0) {
      return unavailable("side_chat_historical_gap_pricing_incomplete");
    }
    if (exactUsage.allowanceWeighting.status === "unavailable") {
      return unavailable("side_chat_historical_gap_speed_weighting_incomplete");
    }
    if (exactUsage.observedModels.length !== 1) {
      return unavailable("side_chat_historical_gap_model_ambiguous");
    }
    const assumedMissingModel = exactUsage.observedModels[0];
    // The missing events are hypothetical: their input context and exact
    // price epoch were never observed. A model-capability ratio would claim
    // unsupported evidence, so this backcast uses the disclosed fallback.
    const missingMultiplier = FAST_MODE_ASSUMED_MULTIPLIER;
    const weighting = exactUsage.allowanceWeighting;
    const minimumMovement = quota.minimumMovementPercentagePoints;
    const maximumMovement = quota.maximumMovementPercentagePoints;
    const comparisonScenarios = Object.fromEntries(Object.entries(
      weighting.scenarios,
    ).map(([scenario, numerator]) => {
      const capacity = calibration.scenarios[scenario];
      const valid = numerator.quotaWeightedUsd !== null
        && numerator.basisId === capacity?.basisId;
      return [scenario, valid ? {
        basisId: numerator.basisId,
        numeratorUsd: numerator.quotaWeightedUsd,
        capacityUsd: capacity.medianWeeklyCapacityUsd,
        expectedPercentagePoints: roundHistoricalGap(
          100 * numerator.quotaWeightedUsd
            / capacity.medianWeeklyCapacityUsd,
          6,
        ),
      } : null];
    }));
    const selectedScenario = weighting.selectedScenario;
    const comparisonStatus = weighting.status === "range"
      ? Object.values(comparisonScenarios).every((row) => row !== null)
        ? "range"
        : "unavailable"
      : comparisonScenarios[selectedScenario] !== null
        ? "complete"
        : "unavailable";
    if (comparisonStatus === "unavailable") {
      return unavailable("side_chat_historical_gap_capacity_mismatch");
    }
    const selectedComparison = selectedScenario === null
      ? null
      : comparisonScenarios[selectedScenario];
    const expectedByScenario = selectedComparison === null
      ? Object.values(comparisonScenarios)
        .filter((row) => row !== null)
        .map((row) => row.expectedPercentagePoints)
      : [selectedComparison.expectedPercentagePoints];
    const expectedMedianLower = Math.min(...expectedByScenario);
    const expectedMedianUpper = Math.max(...expectedByScenario);
    const residualMedianLower = minimumMovement - expectedMedianUpper;
    const residualMedianUpper = maximumMovement - expectedMedianLower;
    const pointMissingQuotaWeightedUsd = selectedComparison === null
      ? null
      : Math.max(
        0,
        minimumMovement * selectedComparison.capacityUsd / 100
          - selectedComparison.numeratorUsd,
      );
    const pointMissingUsd = pointMissingQuotaWeightedUsd === null
      ? null
      : pointMissingQuotaWeightedUsd / missingMultiplier;
    const sensitivityCandidates = Object.entries(comparisonScenarios)
      .filter(([, row]) => row !== null)
      .map(([scenario, row]) => ({
        weighted: row.numeratorUsd,
        capacity: calibration.scenarios[scenario]
          .plausibleWeeklyCapacityRangeUsd,
      }));
    const sensitivityLower = Math.min(...sensitivityCandidates.map((row) => (
      Math.max(0, (
        minimumMovement * row.capacity.lower / 100 - row.weighted
      ) / missingMultiplier)
    )));
    const sensitivityUpper = Math.max(
      sensitivityLower,
      ...sensitivityCandidates.map((row) => (
        Math.max(0, (
          maximumMovement * row.capacity.upper / 100 - row.weighted
        ) / missingMultiplier)
      )),
    );
    const weightedSensitivityLower = sensitivityLower * missingMultiplier;
    const weightedSensitivityUpper = sensitivityUpper * missingMultiplier;
    return {
      schemaVersion: SIDE_CHAT_HISTORICAL_GAP_SCHEMA_VERSION,
      status: "available",
      errorCode: null,
      date,
      timeZone,
      startAt: canonicalInstant(startMs),
      endAt: canonicalInstant(endMs),
      basis: "quota_residual_backcast_not_observed_side_chat_usage",
      quota,
      exactUsage,
      calibration,
      estimate: {
        assumedMissingSpeed,
        assumedMissingModel,
        modelAssumption: "only_exact_model_observed_that_day",
        fastQuotaMultiplier: missingMultiplier,
        fastQuotaMultiplierSource: "assumed_missing_event_context",
        allowanceComparison: {
          status: comparisonStatus,
          basisFamilyId: calibration.basisFamilyId,
          selectedScenario,
          selectedExpectedPercentagePoints: selectedComparison
            ?.expectedPercentagePoints ?? null,
          scenarios: comparisonScenarios,
          expectedRangePercentagePoints: comparisonStatus === "range"
            ? {
              lower: roundHistoricalGap(expectedMedianLower, 6),
              upper: roundHistoricalGap(expectedMedianUpper, 6),
            }
            : null,
        },
        exactCostImpliedMedianRangePercentagePoints: {
          lower: roundHistoricalGap(expectedMedianLower, 6),
          upper: roundHistoricalGap(expectedMedianUpper, 6),
        },
        unexplainedMedianRangePercentagePoints: {
          lower: roundHistoricalGap(residualMedianLower, 6),
          upper: roundHistoricalGap(residualMedianUpper, 6),
        },
        impliedMissingStandardApiEquivalentUsd:
          roundHistoricalGap(pointMissingUsd),
        impliedMissingQuotaWeightedApiEquivalentUsd:
          roundHistoricalGap(pointMissingQuotaWeightedUsd),
        sensitivityRangeUsd: {
          lower: roundHistoricalGap(sensitivityLower),
          upper: roundHistoricalGap(sensitivityUpper),
        },
        quotaWeightedSensitivityRangeUsd: {
          lower: roundHistoricalGap(weightedSensitivityLower),
          upper: roundHistoricalGap(weightedSensitivityUpper),
        },
        includedInExactUsage: false,
        includedInCalibrationTimeline: false,
        independentlyObserved: false,
      },
    };
  } catch (error) {
    const code = typeof error?.code === "string"
        && /^side_chat_historical_gap_[a-z0-9_]{1,64}$/u.test(error.code)
      ? error.code
      : "side_chat_historical_gap_unavailable";
    return unavailable(code);
  } finally {
    database?.close();
  }
}

function timestampFromLogLine(line) {
  if (!Buffer.isBuffer(line) || line.length < 24) return null;
  const parsed = Date.parse(line.subarray(0, 24).toString("utf8"));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function conversationIdFromLine(line) {
  const match = line.toString("utf8").match(CONVERSATION_PATTERN);
  return match && UUID_PATTERN.test(match[1]) ? match[1].toLowerCase() : null;
}

async function desktopLogFiles(root) {
  const files = [];
  let bytes = 0;
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_DESKTOP_FILES) {
        throw fixedError("side_chat_desktop_file_limit_exceeded");
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      const metadata = await lstat(path);
      if (!regularOwnerFile(metadata)) continue;
      bytes += metadata.size;
      if (bytes > MAX_DESKTOP_BYTES) {
        throw fixedError("side_chat_desktop_byte_limit_exceeded");
      }
      files.push({ path, size: metadata.size });
    }
  }
  await walk(root);
  return { files, bytes };
}

async function detectSideChatLifecycles(desktopLogRoot, signal) {
  const { files, bytes } = await desktopLogFiles(desktopLogRoot);
  const detected = new Map();
  let firstObservedMs = null;
  let lastObservedMs = null;
  let oversizedLines = 0;
  for (const file of files) {
    if (signal?.aborted) throw fixedError("side_chat_estimate_aborted");
    let pendingFork = null;
    let pendingPair = null;
    const read = await forEachRolloutLine(file.path, {
      start: 0,
      end: file.size,
      maximumLineBytes: DESKTOP_LINE_BYTES,
      signal,
      onLine(line) {
        const observedMs = timestampFromLogLine(line);
        if (observedMs !== null) {
          firstObservedMs = firstObservedMs === null
            ? observedMs
            : Math.min(firstObservedMs, observedMs);
          lastObservedMs = lastObservedMs === null
            ? observedMs
            : Math.max(lastObservedMs, observedMs);
        }
        if (line.includes(DESKTOP_FORK)) {
          const parent = conversationIdFromLine(line);
          pendingFork = parent === null || observedMs === null
            ? null
            : { parent, observedMs };
          pendingPair = null;
          return;
        }
        if (line.includes(DESKTOP_INJECT)) {
          const child = conversationIdFromLine(line);
          pendingPair = pendingFork !== null
              && child !== null
              && child !== pendingFork.parent
              && observedMs !== null
              && observedMs >= pendingFork.observedMs
              && observedMs - pendingFork.observedMs <= MAX_LIFECYCLE_GAP_MS
            ? {
              child,
              parent: pendingFork.parent,
              forkedAtMs: pendingFork.observedMs,
              injectedAtMs: observedMs,
            }
            : null;
          pendingFork = null;
          return;
        }
        if (pendingPair === null
            || observedMs === null
            || observedMs - pendingPair.injectedAtMs > MAX_LIFECYCLE_GAP_MS) {
          if (pendingPair !== null
              && observedMs !== null
              && observedMs - pendingPair.injectedAtMs > MAX_LIFECYCLE_GAP_MS) {
            pendingPair = null;
          }
          return;
        }
        const isRoute = (line.includes(DESKTOP_SIDE_ROUTE)
            || line.includes(DESKTOP_SIDE_ROUTE_FALLBACK))
          && line.includes(ROUTE_DISPOSITION);
        if (!isRoute || conversationIdFromLine(line) !== pendingPair.child) return;
        const prior = detected.get(pendingPair.child);
        if (prior === undefined || pendingPair.forkedAtMs < prior.forkedAtMs) {
          detected.set(pendingPair.child, pendingPair);
        }
        pendingPair = null;
      },
    });
    if (read.aborted) throw fixedError("side_chat_estimate_aborted");
    oversizedLines += read.oversizedLines;
  }
  if (detected.size > MAX_SIDE_CHAT_SESSIONS) {
    throw fixedError("side_chat_session_limit_exceeded");
  }
  return {
    sessions: [...detected.values()].sort(
      (left, right) => left.forkedAtMs - right.forkedAtMs
        || left.child.localeCompare(right.child),
    ),
    coverage: {
      filesScanned: files.length,
      bytesScanned: bytes,
      oversizedLinesSkipped: oversizedLines,
      startAt: canonicalInstant(firstObservedMs),
      endAt: canonicalInstant(lastObservedMs),
    },
  };
}

function regularOwnerFile(metadata) {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid());
}

function logs2SchemaSupported(database) {
  const required = new Set([
    "id",
    "ts",
    "ts_nanos",
    "target",
    "feedback_log_body",
    "thread_id",
  ]);
  const columns = database.prepare("PRAGMA table_info(logs)").all();
  for (const row of columns) required.delete(row.name);
  return required.size === 0;
}

function observedMs(row) {
  const seconds = tokenCount(row.ts);
  const nanos = tokenCount(row.ts_nanos);
  if (seconds === null || nanos === null || nanos >= 1_000_000_000) return null;
  const milliseconds = seconds * 1_000 + Math.floor(nanos / 1_000_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function parseSamplingRow(row) {
  if (row.target !== "codex_core::session::turn"
      || typeof row.feedback_log_body !== "string") return null;
  const body = row.feedback_log_body;
  const usage = body.match(POST_SAMPLING_PATTERN);
  const contextTurn = body.match(TURN_PATTERN);
  const model = body.match(MODEL_PATTERN)?.[1] ?? null;
  const effort = body.match(EFFORT_PATTERN)?.[1]?.toLowerCase() ?? null;
  const timestampMs = observedMs(row);
  const activeContextTokens = tokenCount(usage?.[2]);
  if (usage === null
      || contextTurn === null
      || usage[1].toLowerCase() !== contextTurn[1].toLowerCase()
      || model === null
      || effort === null
      || timestampMs === null
      || activeContextTokens === null
      || activeContextTokens === 0
      || activeContextTokens > 10_000_000) return null;
  return {
    rowId: Number(row.id),
    observedAtMs: timestampMs,
    turnId: usage[1].toLowerCase(),
    model: model.toLowerCase(),
    reasoningEffort: effort,
    activeContextTokens,
  };
}

function parseCompactionRow(row) {
  if (typeof row.feedback_log_body !== "string"
      || !COMPACTION_PATTERN.test(row.feedback_log_body)) return null;
  const turn = row.feedback_log_body.match(TURN_PATTERN)?.[1];
  const timestampMs = observedMs(row);
  return turn && timestampMs !== null
    ? { observedAtMs: timestampMs, turnId: turn.toLowerCase() }
    : null;
}

function isCompactionCandidate(row) {
  return typeof row.feedback_log_body === "string"
    && row.feedback_log_body.includes("run_auto_compact");
}

function diagnosticBodyDigest(body) {
  return createHash("sha256")
    .update("side-chat-sampling-body-v1\0", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function readRetainedSideChatRows(logs2File, sessions) {
  let database;
  try {
    database = new DatabaseSync(logs2File, { readOnly: true });
    if (!logs2SchemaSupported(database)) {
      throw fixedError("side_chat_logs2_schema_unsupported");
    }
    const range = database.prepare(
      "SELECT MIN(ts) AS minimum_ts, MAX(ts) AS maximum_ts FROM logs",
    ).get();
    const minimumSeconds = tokenCount(range?.minimum_ts);
    const maximumSeconds = tokenCount(range?.maximum_ts);
    const coverage = {
      startAt: minimumSeconds === null
        ? null
        : canonicalInstant(minimumSeconds * 1_000),
      endAt: maximumSeconds === null
        ? null
        : canonicalInstant(maximumSeconds * 1_000),
    };
    const rows = [];
    const threadRowCounts = new Map();
    const children = sessions.map((row) => row.child);
    for (let start = 0; start < children.length; start += 500) {
      const selected = children.slice(start, start + 500);
      const placeholders = selected.map(() => "?").join(",");
      for (const row of database.prepare(`
        SELECT thread_id, COUNT(*) AS row_count
        FROM logs
        WHERE thread_id IN (${placeholders})
        GROUP BY thread_id`).all(...selected)) {
        threadRowCounts.set(row.thread_id, Number(row.row_count));
      }
      rows.push(...database.prepare(`
        SELECT id, ts, ts_nanos, target, feedback_log_body, thread_id
        FROM logs
        WHERE thread_id IN (${placeholders})
          AND (
            target IN ('codex_core::session::turn', 'codex_core::client')
            OR instr(feedback_log_body, 'post sampling token usage') > 0
            OR instr(feedback_log_body, 'run_auto_compact') > 0
          )
        ORDER BY thread_id, ts, ts_nanos, id`).all(...selected));
      if (rows.length > MAX_LOG_ROWS) {
        throw fixedError("side_chat_logs2_row_limit_exceeded");
      }
    }
    const samples = [];
    const lifecycles = new Map(sessions.map((row) => [row.child, row]));
    let child = null;
    let pendingCompaction = false;
    let compactionOrdinal = 0;
    let priorUniqueSampleAtMs = null;
    let turnOrdinal = 0;
    let priorTurnId = null;
    const seen = new Map();
    const seenCompactions = new Set();
    let duplicateSamplingMarkers = 0;
    let ambiguousDuplicateMarkers = 0;
    let rejectedSamplingMarkers = 0;
    let rejectedCompactionMarkers = 0;
    let compactionMarkers = 0;
    for (const row of rows) {
      if (row.thread_id !== child) {
        child = row.thread_id;
        pendingCompaction = false;
        compactionOrdinal = 0;
        priorUniqueSampleAtMs = null;
        turnOrdinal = 0;
        priorTurnId = null;
      }
      const compactionCandidate = isCompactionCandidate(row);
      const compaction = compactionCandidate
        ? parseCompactionRow(row)
        : null;
      if (compactionCandidate && compaction === null) {
        rejectedCompactionMarkers += 1;
        continue;
      }
      if (compaction !== null) {
        // One compaction can be echoed by several diagnostic targets. Keep a
        // single segmentation boundary for the same child/turn/timestamp so
        // target fan-out cannot inflate the ordinal or alter sampling dedupe.
        const compactionKey = [
          row.thread_id,
          compaction.turnId,
          compaction.observedAtMs,
        ].join("|");
        if (seenCompactions.has(compactionKey)) continue;
        seenCompactions.add(compactionKey);
        pendingCompaction = true;
        compactionOrdinal += 1;
        compactionMarkers += 1;
        continue;
      }
      const sample = parseSamplingRow(row);
      if (sample === null) {
        if (typeof row.feedback_log_body === "string"
            && row.feedback_log_body.includes("post sampling token usage")) {
          rejectedSamplingMarkers += 1;
        }
        continue;
      }
      const key = [
        row.thread_id,
        sample.turnId,
        sample.model,
        sample.reasoningEffort,
        sample.activeContextTokens,
        compactionOrdinal,
      ].join("|");
      const bodyDigest = diagnosticBodyDigest(row.feedback_log_body);
      if (seen.has(key)) {
        duplicateSamplingMarkers += 1;
        if (seen.get(key) !== bodyDigest) ambiguousDuplicateMarkers += 1;
        continue;
      }
      seen.set(key, bodyDigest);
      if (sample.turnId !== priorTurnId) {
        turnOrdinal += 1;
        priorTurnId = sample.turnId;
      }
      const lifecycle = lifecycles.get(row.thread_id);
      const referenceAtMs = priorUniqueSampleAtMs ?? lifecycle?.forkedAtMs ?? null;
      const elapsedMs = referenceAtMs === null
        ? null
        : sample.observedAtMs - referenceAtMs;
      const warmEligibilityMs = sample.model.startsWith("gpt-5.6-")
        ? GPT_56_WARM_ELIGIBILITY_MS
        : OTHER_MODEL_WARM_ELIGIBILITY_MS;
      const cacheAssumption = pendingCompaction
        ? "cold_after_compaction"
        : elapsedMs !== null && elapsedMs >= 0 && elapsedMs <= warmEligibilityMs
          ? "warm_prefix"
          : "retention_unknown";
      samples.push({
        ...sample,
        childId: row.thread_id,
        turnOrdinal,
        cacheAssumption,
        compactionBefore: pendingCompaction,
      });
      priorUniqueSampleAtMs = sample.observedAtMs;
      pendingCompaction = false;
    }
    const retainedSessionIds = new Set(samples.map((row) => row.childId));
    const sessionsAtRetentionLimit = new Set(
      sessions
        .filter((row) => (
          retainedSessionIds.has(row.child)
          && (threadRowCounts.get(row.child) ?? 0) >= LOGS2_THREAD_RETENTION_LIMIT
        ))
        .map((row) => row.child),
    );
    const completeSessionIds = new Set(
      [...retainedSessionIds].filter(
        (sessionId) => !sessionsAtRetentionLimit.has(sessionId),
      ),
    );
    return {
      samples,
      retainedSessionIds,
      completeSessionIds,
      sessionsAtRetentionLimit,
      duplicateSamplingMarkers,
      ambiguousDuplicateMarkers,
      rejectedSamplingMarkers,
      rejectedCompactionMarkers,
      compactionMarkers,
      coverage: {
        ...coverage,
        sourceScope: "active_logs2_retention_only",
      },
    };
  } finally {
    database?.close();
  }
}

function estimatedComponents(activeContextTokens, scenario, cacheAssumption) {
  const providerTotal = Math.max(
    1,
    Math.round(activeContextTokens / scenario.activeToProviderTotal),
  );
  const input = Math.max(
    1,
    Math.round(providerTotal / (1 + scenario.outputToInput)),
  );
  const output = Math.max(0, providerTotal - input);
  const cacheReadShare = cacheAssumption === "cold_after_compaction"
    ? scenario.postCompactionCacheReadShare
    : cacheAssumption === "retention_unknown" && scenario.name === "upperCost"
      ? scenario.postCompactionCacheReadShare
      : scenario.ordinaryCacheReadShare;
  const cacheRead = Math.max(0, Math.min(input, Math.round(input * cacheReadShare)));
  const nonRead = input - cacheRead;
  const cacheWrite = Math.max(
    0,
    Math.min(nonRead, Math.round(nonRead * scenario.cacheWriteShare)),
  );
  return {
    totalInputContextTokens: input,
    components: {
      input_uncached_tokens: nonRead - cacheWrite,
      input_cache_read_tokens: cacheRead,
      input_cache_write_tokens: cacheWrite,
      // The sampling diagnostic exposes no text/reasoning split. Preserve the
      // inferred output as the accounting package's combined fallback instead
      // of inventing a zero-reasoning observation.
      output_text_tokens: null,
      output_reasoning_tokens: null,
      output_combined_tokens: output,
    },
  };
}

function scenario(name) {
  return {
    name,
    activeToProviderTotal:
      SIDE_CHAT_ESTIMATE_ASSUMPTIONS.activeToProviderTotal[name],
    outputToInput: SIDE_CHAT_ESTIMATE_ASSUMPTIONS.outputToInput[name],
    ordinaryCacheReadShare:
      SIDE_CHAT_ESTIMATE_ASSUMPTIONS.ordinaryCacheReadShare[name],
    postCompactionCacheReadShare:
      SIDE_CHAT_ESTIMATE_ASSUMPTIONS.postCompactionCacheReadShare[name],
    cacheWriteShare:
      SIDE_CHAT_ESTIMATE_ASSUMPTIONS.uncachedRemainderCacheWriteShare[name],
  };
}

function priceScenario(sample, selectedScenario) {
  const model = recognizedCodexModelId(sample.model);
  if (model === null) return null;
  const modelScenario = selectedScenario.name === "upperCost"
      && selectedScenario.cacheWriteShare > 0
      && !CACHE_WRITE_PRICED_MODELS.has(model)
    ? { ...selectedScenario, cacheWriteShare: 0 }
    : selectedScenario;
  const estimated = estimatedComponents(
    sample.activeContextTokens,
    modelScenario,
    sample.cacheAssumption,
  );
  // OpenAI charges all generated tokens at the output rate, but the side-chat
  // diagnostic cannot split visible text from hidden reasoning. Keep the
  // public estimate as combined output and map it to ordinary output only at
  // this price-adapter boundary, matching the replay-safe fallback policy.
  const pricingComponents = {
    ...estimated.components,
    output_text_tokens: estimated.components.output_combined_tokens,
    output_reasoning_tokens: 0,
    output_combined_tokens: 0,
  };
  let priced;
  try {
    priced = priceCodexUsageEvent({
      timestamp: new Date(sample.observedAtMs).toISOString(),
      model,
      totalInputContextTokens: estimated.totalInputContextTokens,
      components: pricingComponents,
      tierSemantics: {
        codexSpeedMode: "standard",
        apiServiceTier: "standard",
      },
    });
  } catch {
    return null;
  }
  const cost = Number(priced.totalUsd);
  if (priced.coverageStatus !== "fully_priced"
      || !Number.isFinite(cost)
      || cost < 0) return null;
  return {
    ...estimated,
    costUsd: cost,
    costUsdExact: priced.totalUsd,
    priceCardIds: [...priced.selectedPriceCardIds],
  };
}

function pricedSample(sample) {
  const model = recognizedCodexModelId(sample.model) ?? "unknown";
  const point = priceScenario(sample, scenario("point"));
  const lower = priceScenario(sample, scenario("lowerCost"));
  const upper = priceScenario(sample, scenario("upperCost"));
  const fullyPriced = point !== null && lower !== null && upper !== null;
  return {
    observedAt: new Date(sample.observedAtMs).toISOString(),
    observedAtMs: sample.observedAtMs,
    childId: sample.childId,
    turnId: sample.turnId,
    model,
    reasoningEffort: sample.reasoningEffort,
    activeContextTokens: sample.activeContextTokens,
    turnOrdinal: sample.turnOrdinal,
    cacheAssumption: sample.cacheAssumption,
    compactionBefore: sample.compactionBefore,
    estimatedApiPriceEquivalentUsd: fullyPriced
      ? roundMoney(point.costUsd)
      : null,
    estimatedRangeUsd: fullyPriced
      ? {
        lower: roundMoney(Math.min(lower.costUsd, upper.costUsd)),
        upper: roundMoney(Math.max(lower.costUsd, upper.costUsd)),
      }
      : null,
    pricingBasis: fullyPriced
      ? CONDITIONAL_ALIAS_MODELS.has(model)
        ? "reviewed_alias_assumption"
        : "reviewed_model_card"
      : "unavailable",
    point,
  };
}

function periodSummary(period, calls, lifecycles, nowMs) {
  const startMs = period.milliseconds === null
    ? Number.NEGATIVE_INFINITY
    : nowMs - period.milliseconds;
  const selected = calls.filter((row) => (
    row.observedAtMs >= startMs && row.observedAtMs <= nowMs + 5 * 60_000
  ));
  const sessions = new Set(selected.map((row) => row.childId));
  const turns = new Set(selected.map((row) => `${row.childId}|${row.turnId}`));
  const lifecycleCount = lifecycles.filter((row) => (
    row.forkedAtMs >= startMs && row.forkedAtMs <= nowMs + 5 * 60_000
  )).length;
  const priced = selected.filter(
    (row) => row.estimatedApiPriceEquivalentUsd !== null,
  );
  const unpricedCalls = selected.length - priced.length;
  const sum = (selector) => priced.reduce((total, row) => total + selector(row), 0);
  return {
    periodId: period.id,
    periodLabel: period.label,
    startAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    endAt: new Date(nowMs).toISOString(),
    detectedSessions: lifecycleCount,
    retainedSessions: sessions.size,
    visibleTurns: turns.size,
    samplingCalls: selected.length,
    activeContextTokens: selected.reduce(
      (total, row) => total + row.activeContextTokens,
      0,
    ),
    postCompactionCalls: selected.filter((row) => row.compactionBefore).length,
    pricedCalls: priced.length,
    unpricedCalls,
    estimatedApiPriceEquivalentUsd: unpricedCalls === 0
      ? roundMoney(sum((row) => row.estimatedApiPriceEquivalentUsd))
      : null,
    estimatedRangeUsd: unpricedCalls === 0
      ? {
        lower: roundMoney(sum((row) => row.estimatedRangeUsd.lower)),
        upper: roundMoney(sum((row) => row.estimatedRangeUsd.upper)),
      }
      : null,
  };
}

function emptyComponents() {
  return {
    input_uncached_tokens: 0,
    input_cache_read_tokens: 0,
    input_cache_write_tokens: 0,
    output_text_tokens: 0,
    output_reasoning_tokens: 0,
    output_combined_tokens: 0,
  };
}

function addComponents(target, source) {
  for (const key of Object.keys(target)) target[key] += source?.[key] ?? 0;
}

function roundedSpeedWeighting(crossing) {
  return Object.fromEntries(
    Object.entries(crossing).map(([speed, families]) => [
      speed,
      Object.fromEntries(
        Object.entries(families).map(([family, cell]) => [family, {
          events: cell.events,
          apiPriceEquivalentUsd: roundMoney(cell.apiPriceEquivalentUsd),
        }]),
      ),
    ]),
  );
}

function estimatedTimeline(calls, declaredSpeedBaselines = []) {
  if (calls.some((row) => row.point === null)) return [];
  const buckets = new Map();
  for (const call of calls) {
    const startMs = Math.floor(call.observedAtMs / TIMELINE_BUCKET_MS)
      * TIMELINE_BUCKET_MS;
    const bucket = buckets.get(startMs) ?? {
      startMs,
      usageEvents: 0,
      totalTokens: 0,
      apiPriceEquivalentUsd: 0,
      speedWeighting: emptySpeedWeightingCrossing(),
      declaredSpeedWeighting: emptySpeedWeightingCrossing(),
      components: emptyComponents(),
      pricingCoverage: {
        fullyPricedEvents: 0,
        partiallyPricedEvents: 0,
        unpricedEvents: 0,
      },
    };
    bucket.usageEvents += 1;
    bucket.totalTokens += Object.values(call.point.components).reduce(
      (total, value) => total + value,
      0,
    );
    bucket.apiPriceEquivalentUsd += call.estimatedApiPriceEquivalentUsd;
    const family = fastModeModelFamilyKey(call.model, {
      eventTime: new Date(call.observedAtMs).toISOString(),
      totalInputContextTokens: call.point.components.input_uncached_tokens
        + call.point.components.input_cache_read_tokens
        + call.point.components.input_cache_write_tokens,
    });
    const weightingCell = bucket.speedWeighting.unknown[family];
    weightingCell.events += 1;
    weightingCell.apiPriceEquivalentUsd +=
      call.estimatedApiPriceEquivalentUsd;
    const declaredMode = declaredSpeedModeAt(
      declaredSpeedBaselines,
      call.observedAtMs,
    );
    if (declaredMode === "standard" || declaredMode === "fast") {
      const declaredCell = bucket.declaredSpeedWeighting[declaredMode][family];
      declaredCell.events += 1;
      declaredCell.apiPriceEquivalentUsd +=
        call.estimatedApiPriceEquivalentUsd;
    }
    // The rate card is complete, but the components are reconstructed rather
    // than observed. Mark the shared timeline row partial so downstream
    // consumers cannot mistake a priceable scenario for exact telemetry.
    bucket.pricingCoverage.partiallyPricedEvents += 1;
    addComponents(bucket.components, call.point.components);
    buckets.set(startMs, bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => left.startMs - right.startMs)
    .map(({ startMs, ...row }) => ({
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(startMs + TIMELINE_BUCKET_MS).toISOString(),
      ...row,
      apiPriceEquivalentUsd: roundMoney(row.apiPriceEquivalentUsd),
      speedWeighting: roundedSpeedWeighting(row.speedWeighting),
      declaredSpeedWeighting: roundedSpeedWeighting(
        row.declaredSpeedWeighting,
      ),
    }));
}

function publicRecent(calls) {
  return [...calls]
    .sort((left, right) => right.observedAtMs - left.observedAtMs)
    .slice(0, SIDE_CHAT_RECENT_DETAIL_LIMIT)
    .map((row) => ({
      observedAt: row.observedAt,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      turnOrdinal: row.turnOrdinal,
      activeContextTokens: row.activeContextTokens,
      cacheAssumption: row.cacheAssumption,
      compactionBefore: row.compactionBefore,
      estimatedApiPriceEquivalentUsd:
        row.estimatedApiPriceEquivalentUsd,
      estimatedRangeUsd: row.estimatedRangeUsd,
      pricingBasis: row.pricingBasis,
    }));
}

function calibrationEligibility(calls, lifecycle, retained, allPriced, nowMs) {
  if (calls.length === 0) return "withheld_no_retained_calls";
  if (!allPriced) return "withheld_unpriced_calls";
  if (lifecycle.coverage.oversizedLinesSkipped > 0
      || retained.rejectedSamplingMarkers > 0
      || retained.rejectedCompactionMarkers > 0
      || retained.ambiguousDuplicateMarkers > 0) {
    return "withheld_parser_gaps";
  }
  if (calls.some((row) => (
    row.model !== CALIBRATION_MODEL
      || !CALIBRATION_EFFORTS.has(row.reasoningEffort)
  ))) {
    return "withheld_cohort_mismatch";
  }
  if (calls.some(
    (row) => row.activeContextTokens > CALIBRATION_MAX_ACTIVE_CONTEXT_TOKENS,
  )) {
    return "withheld_context_mismatch";
  }
  const calibrationAgeMs = nowMs - CALIBRATION_AT_MS;
  if (!Number.isSafeInteger(calibrationAgeMs)
      || calibrationAgeMs < 0
      || calibrationAgeMs > CALIBRATION_FRESH_FOR_MS) {
    return "withheld_stale_calibration";
  }
  // This feature intentionally represents only the active, approximately
  // ten-day logs_2 window. Expired lifecycles and a capped retained partition
  // remain visible coverage limitations, but no longer suppress the surviving
  // priceable calls from the experimental red line and AUC.
  return "eligible_active_retention";
}

export function unavailableSideChatEstimates(errorCode) {
  return {
    schemaVersion: SIDE_CHAT_ESTIMATE_SCHEMA_VERSION,
    status: "unavailable",
    errorCode,
    generatedAt: null,
    methodology: {
      parserVersion: SIDE_CHAT_ESTIMATE_PARSER_VERSION,
      ordinaryAssumption: "warm_prefix",
      postCompactionAssumption: "cold_first_request",
      elapsedRetentionAssumption: "warm_to_cold_sensitivity",
      coldUpperInputTreatment: "cache_write_when_reviewed_else_uncached",
      parentCacheStateObserved: false,
      compactionCostIncluded: false,
      componentEvidence: "reconstructed_from_active_context",
      retentionScope: "active_logs2_approximately_ten_days",
      approximateRetentionDays: LOGS2_APPROXIMATE_RETENTION_DAYS,
      includedInExactUsage: false,
      includedInCalibrationTimeline: false,
      calibrationStatus: "withheld_unavailable",
      calibrationCohort: {
        model: CALIBRATION_MODEL,
        reasoningEfforts: [...CALIBRATION_EFFORTS],
        matchedDurableCalls: CALIBRATION_MATCHED_CALLS,
        calibratedAt: CALIBRATION_AT,
        freshForSeconds: CALIBRATION_FRESH_FOR_MS / 1_000,
        maximumActiveContextTokens: CALIBRATION_MAX_ACTIVE_CONTEXT_TOKENS,
      },
      assumptions: SIDE_CHAT_ESTIMATE_ASSUMPTIONS,
    },
    coverage: null,
    periods: [],
    timeline: [],
    recent: [],
    recentDetailLimit: SIDE_CHAT_RECENT_DETAIL_LIMIT,
    recentTruncated: false,
  };
}

/**
 * Development-only, content-free side-chat estimate.
 *
 * Desktop logs are read solely for the fork -> inject -> side-route lifecycle
 * and `logs_2.sqlite` is queried only for those exact child partitions and
 * known sampling/compaction diagnostic candidates. Prompt, answer, tool, path,
 * and reasoning text never enter the returned object.
 */
export async function collectSideChatEstimates({
  codexHome = join(homedir(), ".codex"),
  desktopLogRoot = join(homedir(), "Library", "Logs", "com.openai.codex"),
  logs2File = null,
  now = () => Date.now(),
  signal = null,
  declaredSpeedBaselines = [],
} = {}) {
  const nowMs = now();
  if (typeof codexHome !== "string" || codexHome.length < 1
      || typeof desktopLogRoot !== "string" || desktopLogRoot.length < 1
      || (logs2File !== null
        && (typeof logs2File !== "string" || logs2File.length < 1))
      || typeof now !== "function"
      || !Array.isArray(declaredSpeedBaselines)
      || !Number.isSafeInteger(nowMs)) {
    throw new TypeError("Side-chat estimate options are invalid");
  }
  const selectedLogs2File = resolve(logs2File ?? join(codexHome, "logs_2.sqlite"));
  try {
    const metadata = await lstat(selectedLogs2File);
    if (!regularOwnerFile(metadata)) {
      return unavailableSideChatEstimates("side_chat_logs2_unavailable");
    }
  } catch {
    return unavailableSideChatEstimates("side_chat_logs2_unavailable");
  }
  try {
    const lifecycle = await detectSideChatLifecycles(
      resolve(desktopLogRoot),
      signal,
    );
    const retained = readRetainedSideChatRows(
      selectedLogs2File,
      lifecycle.sessions,
    );
    const calls = retained.samples.map(pricedSample);
    const allPriced = calls.every(
      (row) => row.estimatedApiPriceEquivalentUsd !== null,
    );
    const calibrationStatus = calibrationEligibility(
      calls,
      lifecycle,
      retained,
      allPriced,
      nowMs,
    );
    const periods = PERIODS.map((period) => periodSummary(
      period,
      calls,
      lifecycle.sessions,
      nowMs,
    ));
    const recent = publicRecent(calls);
    return {
      schemaVersion: SIDE_CHAT_ESTIMATE_SCHEMA_VERSION,
      status: "available",
      errorCode: null,
      generatedAt: new Date(nowMs).toISOString(),
      methodology: {
        parserVersion: SIDE_CHAT_ESTIMATE_PARSER_VERSION,
        ordinaryAssumption: "warm_prefix",
        postCompactionAssumption: "cold_first_request",
        elapsedRetentionAssumption: "warm_to_cold_sensitivity",
        coldUpperInputTreatment: "cache_write_when_reviewed_else_uncached",
        parentCacheStateObserved: false,
        compactionCostIncluded: false,
        componentEvidence: "reconstructed_from_active_context",
        retentionScope: "active_logs2_approximately_ten_days",
        approximateRetentionDays: LOGS2_APPROXIMATE_RETENTION_DAYS,
        includedInExactUsage: false,
        includedInCalibrationTimeline:
          calibrationStatus === "eligible_active_retention",
        calibrationStatus,
        calibrationCohort: {
          model: CALIBRATION_MODEL,
          reasoningEfforts: [...CALIBRATION_EFFORTS],
          matchedDurableCalls: CALIBRATION_MATCHED_CALLS,
          calibratedAt: CALIBRATION_AT,
          freshForSeconds: CALIBRATION_FRESH_FOR_MS / 1_000,
          maximumActiveContextTokens: CALIBRATION_MAX_ACTIVE_CONTEXT_TOKENS,
        },
        assumptions: SIDE_CHAT_ESTIMATE_ASSUMPTIONS,
      },
      coverage: {
        desktop: lifecycle.coverage,
        logs2: retained.coverage,
        detectedSessions: lifecycle.sessions.length,
        retainedNumericSessions: retained.retainedSessionIds.size,
        completeNumericSessions: retained.completeSessionIds.size,
        sessionsAtRetentionLimit: retained.sessionsAtRetentionLimit.size,
        sessionsWithoutNumericEvidence: Math.max(
          0,
          lifecycle.sessions.length - retained.retainedSessionIds.size,
        ),
        duplicateSamplingMarkers: retained.duplicateSamplingMarkers,
        ambiguousDuplicateMarkers: retained.ambiguousDuplicateMarkers,
        rejectedSamplingMarkers: retained.rejectedSamplingMarkers,
        rejectedCompactionMarkers: retained.rejectedCompactionMarkers,
        compactionMarkers: retained.compactionMarkers,
        status: retained.completeSessionIds.size === lifecycle.sessions.length
            && lifecycle.coverage.oversizedLinesSkipped === 0
            && retained.rejectedSamplingMarkers === 0
            && retained.rejectedCompactionMarkers === 0
            && retained.ambiguousDuplicateMarkers === 0
          ? "retained_for_all_detected_sessions"
          : "partial_diagnostic_retention",
      },
      periods,
      timeline: calibrationStatus === "eligible_active_retention"
        ? estimatedTimeline(calls, declaredSpeedBaselines)
        : [],
      recent,
      recentDetailLimit: SIDE_CHAT_RECENT_DETAIL_LIMIT,
      recentTruncated: calls.length > recent.length,
    };
  } catch (error) {
    if (error?.code === "side_chat_estimate_aborted") throw error;
    const code = typeof error?.code === "string"
        && /^side_chat_[a-z0-9_]{1,64}$/u.test(error.code)
      ? error.code
      : "side_chat_estimate_unavailable";
    return unavailableSideChatEstimates(code);
  }
}
