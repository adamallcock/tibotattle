import { lstat } from "node:fs/promises";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  addTimelineUsage,
  addUsageToPeriod,
  finalizeTimelineBuckets,
  finalizeUsagePeriod,
  MAX_QUOTA_TIMELINE_POINTS,
  newUsagePeriod,
  quotaWindowProjection,
  safeSpeed,
  sampleQuotaTimelineByTrack,
  SPARK_QUOTA_LIMIT_IDS,
  TIMELINE_BUCKET_MS,
  usageProjection,
} from "./local-companion-usage-model.js";
import {
  openLocalUnifiedIndex,
} from "./local-unified-index.js";
import {
  createAccountingPricer,
} from "./replay-safe-accounting-cache.js";

// The companion's read over the unified local index.
//
// This is what removes the 31-day ceiling: the index holds the whole
// fork-replay-suppressed corpus in typed columns, so the "All" period and the
// timelines can cover everything that was ever indexed instead of a bounded
// recent collector window. Every figure goes through the same
// `usageProjection` the collector path uses, so the two sources price and
// classify identically and differ only in evidence.
//
// Reads are strictly read-only, and a missing or unreadable index degrades to
// a typed status the snapshot reports honestly rather than silently
// truncating back to the bounded window.

export const UNIFIED_COMPANION_PERIOD_LABEL = "All indexed local history";

// Streaming batch for the usage read. Keyset pagination on the observed-at
// index keeps peak memory at one batch of typed rows regardless of index size.
const USAGE_READ_BATCH_ROWS = 20_000;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function unavailable(status, errorCode = null) {
  return {
    status,
    errorCode,
    generatedAt: null,
    indexStatus: null,
    coveredAt: { startAt: null, endAt: null },
    usageEvents: 0,
    quotaObservations: 0,
    sourceCount: 0,
    sourceBytes: 0,
    indexBytes: 0,
    usage: [],
    timeline: null,
    readWallMs: null,
  };
}

function isoOrNull(milliseconds) {
  return Number.isSafeInteger(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function readMeta(database, key) {
  const row = database
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key);
  return typeof row?.value === "string" ? row.value : null;
}

function* usageRows(database) {
  // Rowid keyset pagination: bounded memory (one batch of typed rows) with no
  // per-batch sort. The aggregation downstream is order-independent — periods
  // and timeline buckets key on the row's own timestamp — so arrival order is
  // free to be storage order.
  const statement = database.prepare(`
    SELECT u.rowid AS row_id,
           u.observed_at_ms AS observed_at_ms,
           m.model_id AS model_id,
           t.codex_speed_mode AS codex_speed_mode,
           t.api_service_tier AS api_service_tier,
           s.surface AS surface,
           s.agent_scope AS agent_scope,
           s.lineage_disposition AS lineage_disposition,
           a.status AS scope_status,
           u.tokens_in_uncached AS tokens_in_uncached,
           u.tokens_in_cache_read AS tokens_in_cache_read,
           u.tokens_in_cache_write AS tokens_in_cache_write,
           u.tokens_out_text AS tokens_out_text,
           u.tokens_out_reasoning AS tokens_out_reasoning,
           u.tokens_out_combined AS tokens_out_combined
    FROM usage_event u
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN surface_class s ON s.id = u.surface_id
    JOIN account_scope a ON a.id = u.account_scope_id
    WHERE u.rowid > ?
    ORDER BY u.rowid
    LIMIT ${USAGE_READ_BATCH_ROWS}`);
  let afterRowId = -1;
  for (;;) {
    const batch = statement.all(afterRowId);
    if (batch.length === 0) return;
    yield* batch;
    afterRowId = Number(batch.at(-1).row_id);
    if (batch.length < USAGE_READ_BATCH_ROWS) return;
  }
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function recordShape(row) {
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
    surfaceClassification: {
      surface: row.surface,
      agentScope: row.agent_scope,
      lineageDisposition: row.lineage_disposition,
    },
    accountScope: { status: row.scope_status },
  };
}

function quotaRowCompare(left, right) {
  // Track identity is (limitId, duration); slot is a server-assigned UI role
  // and may only serve as a trailing deterministic tie-break, never ahead of
  // the duration.
  return left.observedMs - right.observedMs
    || left.limitId.localeCompare(right.limitId)
    || left.durationMinutes - right.durationMinutes
    || left.slot.localeCompare(right.slot)
    || left.planType.localeCompare(right.planType)
    || left.usedPercent - right.usedPercent;
}

function quotaRowTieBreak(row) {
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

/**
 * The quota series for one limit, streamed off the index in timestamp order.
 * `limitIds` lists every provider spelling of that limit's id (the Spark
 * allowance is stored as `codex_bengalfox`, with `codex-spark` reserved in
 * case the marketing name stabilizes); querying only a spelling that never
 * occurs left the series permanently empty.
 *
 * Semantically identical to the collector path's finalizeQuotaTimeline —
 * dedupe per (track, millisecond) by the same tie-break, per-track sample
 * under the same ceiling — but computed in one streaming pass over the
 * already sorted SQL result. Re-sorting 645k materialized rows with
 * Date.parse inside the comparator measured as seconds of the snapshot
 * build; this is why the shared finalizer is not reused here.
 */
function quotaTimelineFor(database, limitIds, nowMs) {
  const statement = database.prepare(`
    SELECT observed_at_ms, limit_id, slot, plan_type, used_percent,
           resets_at_ms, duration_mins
    FROM quota_observation
    WHERE limit_id IN (${limitIds.map(() => "?").join(", ")})
      AND observed_at_ms <= ?
    ORDER BY observed_at_ms`);
  const rows = [];
  let groupMs = null;
  let group = new Map();
  const flushGroup = () => {
    if (group.size === 0) return;
    const members = [...group.values()].sort(quotaRowCompare);
    for (const member of members) {
      delete member.observedMs;
      rows.push(member);
    }
    group = new Map();
  };
  for (const row of statement.iterate(...limitIds, nowMs + 5 * 60_000)) {
    const observedMs = Number(row.observed_at_ms);
    const projected = quotaWindowProjection({
      limitId: row.limit_id,
      slot: row.slot,
      planType: row.plan_type,
      usedPercent: row.used_percent,
      windowDurationMins: Number(row.duration_mins),
      resetsAt: Number.isSafeInteger(Number(row.resets_at_ms))
        ? Math.floor(Number(row.resets_at_ms) / 1_000)
        : null,
    });
    if (projected === null) continue;
    if (observedMs !== groupMs) {
      flushGroup();
      groupMs = observedMs;
    }
    const candidate = {
      observedAt: new Date(observedMs).toISOString(),
      ...projected,
      // Rollout logs carry no account identity, and the index records that
      // honestly; quota points read from it are therefore unattributed.
      accountAttribution: "unattributed",
      observedMs,
    };
    // Quota track identity is (limitId, duration). The provider's
    // primary/secondary slots are UI roles that flipped server-side around
    // 2026-07-06; keying on them fragments one continuous window into two
    // tracks. Slot stays on the row as display provenance only.
    const track = `${candidate.limitId}:${candidate.durationMinutes}`;
    const prior = group.get(track);
    if (prior === undefined
        || quotaRowTieBreak(candidate) < quotaRowTieBreak(prior)) {
      group.set(track, candidate);
    }
  }
  flushGroup();
  return sampleQuotaTimelineByTrack(rows, MAX_QUOTA_TIMELINE_POINTS);
}

/**
 * Project the whole unified index into the companion's usage shape: the four
 * accounting periods, the full-history usage/quota timelines and the coverage
 * facts the page needs to describe what span the evidence actually reaches.
 */
export async function readLocalUnifiedCompanionProjection({
  indexFile,
  nowMs = Date.now(),
  declaredSpeedBaselines = [],
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch timestamp");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch (error) {
    if (error?.code === "ENOENT") return unavailable("missing");
    return unavailable("unavailable", "local_unified_index_unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return unavailable("unavailable", "local_unified_index_unavailable");
  }
  const startedAt = performance.now();
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch (error) {
    return unavailable(
      "unavailable",
      error?.code ?? "local_unified_index_unavailable",
    );
  }
  try {
    const periods = [
      { summary: newUsagePeriod("24h", "Last 24 hours"), start: nowMs - 24 * 60 * 60 * 1_000 },
      { summary: newUsagePeriod("7d", "Last 7 days"), start: nowMs - 7 * 24 * 60 * 60 * 1_000 },
      { summary: newUsagePeriod("30d", "Last 30 days"), start: nowMs - 30 * 24 * 60 * 60 * 1_000 },
      {
        summary: newUsagePeriod("all", UNIFIED_COMPANION_PERIOD_LABEL),
        start: Number.NEGATIVE_INFINITY,
      },
    ];
    const timelineBuckets = new Map();
    const sparkTimelineBuckets = new Map();
    // The same memoized pricer the replay-safe cache accounts with: exact by
    // construction (it falls back to the full pricer when a unit-price plan
    // cannot be proven), and the difference between 33us and sub-microsecond
    // per event over 460k+ events.
    const pricer = createAccountingPricer();
    let usageEvents = 0;
    let firstObservedMs = null;
    let lastObservedMs = null;
    const futureLimitMs = nowMs + 5 * 60_000;
    for (const row of usageRows(database)) {
      const observedMs = Number(row.observed_at_ms);
      if (!Number.isSafeInteger(observedMs) || observedMs > futureLimitMs) {
        continue;
      }
      usageEvents += 1;
      if (firstObservedMs === null || observedMs < firstObservedMs) {
        firstObservedMs = observedMs;
      }
      if (lastObservedMs === null || observedMs > lastObservedMs) {
        lastObservedMs = observedMs;
      }
      const record = recordShape(row);
      // An observed tier always wins, so a declaration is only ever looked up
      // for the turns the rollout log left unobserved — identical to the
      // collector projection's rule.
      const projection = usageProjection(
        record,
        safeSpeed(record.tierSemantics.codexSpeedMode) === "unknown"
          ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
          : "unknown",
        pricer,
      );
      if (projection === null) continue;
      for (const period of periods) {
        if (observedMs >= period.start) {
          addUsageToPeriod(period.summary, projection);
        }
      }
      addTimelineUsage(
        projection.isSpark ? sparkTimelineBuckets : timelineBuckets,
        observedMs,
        projection,
      );
    }
    const quotaSeries = quotaTimelineFor(database, ["codex"], nowMs);
    const sparkQuotaSeries = quotaTimelineFor(
      database,
      SPARK_QUOTA_LIMIT_IDS,
      nowMs,
    );
    const quotaObservations = Number(database.prepare(
      "SELECT COUNT(*) AS c FROM quota_observation",
    ).get()?.c ?? 0);
    const coveredStartMs = timelineBuckets.size === 0
      ? null
      : Math.min(...timelineBuckets.keys());
    const coveredEndMs = timelineBuckets.size === 0
      ? null
      : Math.max(...timelineBuckets.keys()) + TIMELINE_BUCKET_MS;
    const sourceCount = Number(readMeta(database, "source_count"));
    const sourceBytes = Number(readMeta(database, "source_bytes"));
    return {
      status: "available",
      errorCode: null,
      generatedAt: readMeta(database, "generated_at"),
      indexStatus: readMeta(database, "status") ?? "unknown",
      coveredAt: {
        startAt: isoOrNull(firstObservedMs),
        endAt: isoOrNull(lastObservedMs),
      },
      usageEvents,
      quotaObservations,
      sourceCount: Number.isSafeInteger(sourceCount) ? sourceCount : 0,
      sourceBytes: Number.isSafeInteger(sourceBytes) ? sourceBytes : 0,
      indexBytes: metadata.size,
      usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
      timeline: {
        bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
        coveredAt: {
          startAt: isoOrNull(coveredStartMs),
          endAt: isoOrNull(coveredEndMs),
        },
        usage: finalizeTimelineBuckets(timelineBuckets),
        sparkUsage: finalizeTimelineBuckets(sparkTimelineBuckets),
        quota: quotaSeries,
        sparkQuota: sparkQuotaSeries,
      },
      readWallMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) {
      return unavailable("unavailable", error.code);
    }
    throw fixedError("local_unified_index_unavailable");
  } finally {
    database.close();
  }
}
