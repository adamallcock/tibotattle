import {
  fastModeModelFamilyKey,
  fastModeQuotaMultiplier,
} from "@app-usagemonitor/accounting";
import {
  KNOWN_SPEEDS,
  safeSpeed,
  usageProjection,
} from "./local-companion-usage-model.js";
import { openLocalUnifiedIndex } from "./local-unified-index.js";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";

// Windowed per-model / per-speed repricing over the unified local index.
//
// This is the same accounting path the "All indexed local history" projection
// uses — every event is repriced through `usageProjection`, which prices at the
// public API-equivalent Standard rate effective on the event's own day — but
// scoped to an explicit [from, to] millisecond window and grouped by model and
// by observed speed. It exists so a detected Trends divergence period can be
// explained with its OWN cost mix (which model, which speed, how much is
// unpriced) instead of the whole-selected-range context that was all the
// timeline payload could carry.
//
// It is content-free by construction: it reads only typed token counts and the
// already-privacy-minimized model/tier names, and returns only aggregate
// dollars, token totals and event counts. No prompt, reply, path or identifier
// is read or returned.

export const LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION = "local-window-breakdown-v0.1";

// The window bound exists to reject a non-finite or inverted range, never to
// shrink an honest span: it is deliberately over a year so it can never become
// a convenience-sized cap. The index holds far less than this in practice, so
// any real divergence period fits with room to spare.
export const MAX_WINDOW_BREAKDOWN_SPAN_MS = 400 * 24 * 60 * 60 * 1_000;

function roundUsd(value) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function speedBucket(codexSpeedMode) {
  const speed = safeSpeed(codexSpeedMode);
  return KNOWN_SPEEDS.has(speed) ? speed : "unknown";
}

function recordFromRow(row) {
  return {
    observedAt: new Date(Number(row.observed_at_ms)).toISOString(),
    model: row.model_id,
    components: {
      input_uncached_tokens: tokenCount(row.tokens_in_uncached),
      input_cache_read_tokens: tokenCount(row.tokens_in_cache_read),
      input_cache_write_tokens: tokenCount(row.tokens_in_cache_write),
      output_text_tokens: tokenCount(row.tokens_out_text),
      output_reasoning_tokens: tokenCount(row.tokens_out_reasoning),
      output_combined_tokens: tokenCount(row.tokens_out_combined),
    },
    tierSemantics: {
      codexSpeedMode: row.codex_speed_mode,
      apiServiceTier: row.api_service_tier,
    },
    surfaceClassification: {},
    // Rollout logs carry no account identity; the projection treats that as
    // unattributed, which is exactly what a repricing figure needs.
    accountScope: { status: "unavailable" },
  };
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Reprice an iterable of unified-index usage rows and group the priced result
 * by model and by observed speed. Pure over its input: the same rows always
 * produce the same breakdown, and Spark is separated out exactly as the main
 * projection separates it, because Spark meters against its own allowance and
 * an API-equivalent figure for it is not comparable with the primary pool.
 *
 * @param {Iterable} rows  Rows shaped like the unified-index usage SELECT
 *   (`observed_at_ms`, `model_id`, `codex_speed_mode`, `api_service_tier`, and
 *   the six `tokens_*` columns).
 * @param {Object} [options]
 * @param {Function|null} [options.pricer]  A memoized accounting pricer; when
 *   null the full pricer is used per event.
 */
export function summarizeWindowBreakdownRows(rows, { pricer = null } = {}) {
  const byModel = new Map();
  const bySpeed = new Map();
  let events = 0;
  let mainEvents = 0;
  let unpricedEvents = 0;
  let costUsd = 0;
  let tokens = 0;
  let fastCostUsd = 0;
  let fastEvents = 0;
  let sparkEvents = 0;
  let sparkCostUsd = 0;

  for (const row of rows) {
    const record = recordFromRow(row);
    const projection = usageProjection(record, "unknown", pricer);
    if (projection === null) continue;
    events += 1;
    if (projection.isSpark) {
      sparkEvents += 1;
      sparkCostUsd += projection.apiPriceEquivalentUsd;
      continue;
    }
    mainEvents += 1;
    const cost = projection.apiPriceEquivalentUsd;
    const unpriced = projection.pricingCoverageStatus === "unpriced";
    const speed = speedBucket(record.tierSemantics.codexSpeedMode);
    costUsd += cost;
    tokens += projection.totalTokens;
    if (unpriced) unpricedEvents += 1;
    if (speed === "fast") {
      fastCostUsd += cost;
      fastEvents += 1;
    }

    const model = projection.model;
    const modelRow = byModel.get(model) ?? {
      model,
      costUsd: 0,
      tokens: 0,
      events: 0,
      unpricedEvents: 0,
      fastModeFamily: fastModeModelFamilyKey(model),
      fastModeMultiplier: fastModeQuotaMultiplier(model),
    };
    modelRow.costUsd += cost;
    modelRow.tokens += projection.totalTokens;
    modelRow.events += 1;
    if (unpriced) modelRow.unpricedEvents += 1;
    byModel.set(model, modelRow);

    const speedRow = bySpeed.get(speed) ?? {
      speed,
      costUsd: 0,
      tokens: 0,
      events: 0,
      unpricedEvents: 0,
    };
    speedRow.costUsd += cost;
    speedRow.tokens += projection.totalTokens;
    speedRow.events += 1;
    if (unpriced) speedRow.unpricedEvents += 1;
    bySpeed.set(speed, speedRow);
  }

  const finalizeModel = (rowValue) => ({
    model: rowValue.model,
    costUsd: roundUsd(rowValue.costUsd),
    tokens: rowValue.tokens,
    events: rowValue.events,
    unpricedEvents: rowValue.unpricedEvents,
    unpricedShare: rowValue.events > 0
      ? Number((rowValue.unpricedEvents / rowValue.events).toFixed(6))
      : 0,
    fastModeFamily: rowValue.fastModeFamily,
    fastModeMultiplier: rowValue.fastModeMultiplier,
  });
  const finalizeSpeed = (rowValue) => ({
    speed: rowValue.speed,
    costUsd: roundUsd(rowValue.costUsd),
    tokens: rowValue.tokens,
    events: rowValue.events,
    unpricedEvents: rowValue.unpricedEvents,
    unpricedShare: rowValue.events > 0
      ? Number((rowValue.unpricedEvents / rowValue.events).toFixed(6))
      : 0,
  });

  return {
    events: mainEvents,
    unpricedEvents,
    unpricedShare: mainEvents > 0
      ? Number((unpricedEvents / mainEvents).toFixed(6))
      : 0,
    costUsd: roundUsd(costUsd),
    tokens,
    fastCostUsd: roundUsd(fastCostUsd),
    fastEvents,
    byModel: [...byModel.values()]
      .map(finalizeModel)
      .sort((left, right) => right.costUsd - left.costUsd
        || left.model.localeCompare(right.model)),
    bySpeed: Object.fromEntries(
      [...bySpeed.values()]
        .map(finalizeSpeed)
        .sort((left, right) => right.costUsd - left.costUsd)
        .map((rowValue) => [rowValue.speed, rowValue]),
    ),
    spark: {
      events: sparkEvents,
      costUsd: roundUsd(sparkCostUsd),
    },
  };
}

function invalidRange(fromMs, toMs) {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) return true;
  if (toMs <= fromMs) return true;
  if (toMs - fromMs > MAX_WINDOW_BREAKDOWN_SPAN_MS) return true;
  return false;
}

const USAGE_WINDOW_SELECT = `
  SELECT u.observed_at_ms AS observed_at_ms,
         m.model_id AS model_id,
         t.codex_speed_mode AS codex_speed_mode,
         t.api_service_tier AS api_service_tier,
         u.tokens_in_uncached AS tokens_in_uncached,
         u.tokens_in_cache_read AS tokens_in_cache_read,
         u.tokens_in_cache_write AS tokens_in_cache_write,
         u.tokens_out_text AS tokens_out_text,
         u.tokens_out_reasoning AS tokens_out_reasoning,
         u.tokens_out_combined AS tokens_out_combined
  FROM usage_event u
  JOIN model m ON m.id = u.model_id
  JOIN tier_semantics t ON t.id = u.tier_id
  WHERE u.observed_at_ms >= ? AND u.observed_at_ms <= ?`;

/**
 * Read and reprice the usage events in [fromMs, toMs] from the unified local
 * index, grouped by model and by observed speed. Strictly read-only; a missing
 * or unreadable index degrades to a typed unavailable status rather than
 * throwing, exactly like the whole-history projection.
 */
export async function readLocalUnifiedWindowBreakdown({
  indexFile,
  fromMs,
  toMs,
  pricer = createAccountingPricer(),
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (invalidRange(fromMs, toMs)) {
    const error = new TypeError("window range is invalid");
    error.code = "window_range_invalid";
    throw error;
  }
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch (error) {
    return {
      status: "unavailable",
      errorCode: error?.code ?? "local_unified_index_unavailable",
      schemaVersion: LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION,
      from: fromMs,
      to: toMs,
    };
  }
  try {
    const statement = database.prepare(USAGE_WINDOW_SELECT);
    const summary = summarizeWindowBreakdownRows(
      statement.iterate(fromMs, toMs),
      { pricer },
    );
    return {
      status: "available",
      errorCode: null,
      schemaVersion: LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION,
      from: fromMs,
      to: toMs,
      ...summary,
    };
  } catch (error) {
    return {
      status: "unavailable",
      errorCode: error?.code?.startsWith?.("local_unified_index_")
        ? error.code
        : "local_unified_index_unavailable",
      schemaVersion: LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION,
      from: fromMs,
      to: toMs,
    };
  } finally {
    database.close();
  }
}
