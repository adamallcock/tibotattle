import { lstat } from "node:fs/promises";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  addTimelineUsage,
  addUsageToPeriod,
  finalizeTimelineBuckets,
  finalizeUsagePeriod,
  KNOWN_TOOL_CLASSES,
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
  createUnifiedIndexToolFactFingerprintAccumulator,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "./local-unified-index.js";
import {
  createAccountingPricer,
} from "./replay-safe-accounting-cache.js";
import {
  readCacheImpacts,
  unavailableCacheContinuityImpact,
  unavailableCacheSwitchImpact,
} from "./cache-switch-impact.js";

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
const USAGE_READ_BATCH_ROWS = 10_000;
const USAGE_PROCESS_YIELD_ROWS = 2_000;
const UNIFIED_PROJECTION_MODES = new Set(["full", "deferred"]);

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
    generation: null,
    coveredAt: { startAt: null, endAt: null },
    usageEvents: 0,
    quotaObservations: 0,
    sourceCount: 0,
    sourceBytes: 0,
    discoveredSourceCount: 0,
    discoveredSourceBytes: 0,
    indexedSourceCount: 0,
    indexedSourceBytes: 0,
    indexBytes: 0,
    latestExportableRecordAt: null,
    tools: emptyToolProjection(),
    toolCoverageStatus: "unavailable",
    toolCoverageBlockReason: null,
    usage: [],
    timeline: null,
    cacheSwitchImpact: unavailableCacheSwitchImpact(
      status === "missing"
        ? "local_unified_index_missing"
        : errorCode ?? "local_unified_index_unavailable",
    ),
    cacheContinuityImpact: unavailableCacheContinuityImpact(
      status === "missing"
        ? "local_unified_index_missing"
        : errorCode ?? "local_unified_index_unavailable",
    ),
    readWallMs: null,
  };
}

function emptyToolProjection() {
  return {
    total: 0,
    counts: Object.fromEntries([...KNOWN_TOOL_CLASSES].map((toolClass) => [
      toolClass,
      0,
    ])),
  };
}

function tableExists(database, tableName) {
  return database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName)?.present === 1;
}

function isDigest(value) {
  return value instanceof Uint8Array && value.byteLength === 32;
}

function sameOpenedFile(before, after) {
  if (!after?.isFile?.() || after.isSymbolicLink()) return false;
  const canCompareIdentity = [before.dev, before.ino, after.dev, after.ino]
    .every((value) => value !== undefined && value !== null);
  return !canCompareIdentity
    || (before.dev === after.dev && before.ino === after.ino);
}

async function revalidatePublishedPath(indexFile, metadata) {
  let first;
  let second;
  try {
    first = await lstat(indexFile);
    second = await lstat(indexFile);
  } catch {
    throw fixedError("local_unified_index_file_changed");
  }
  if (!sameOpenedFile(metadata, first) || !sameOpenedFile(first, second)) {
    throw fixedError("local_unified_index_file_changed");
  }
}

function toolProjection(database, generation) {
  const projection = emptyToolProjection();
  if (tableExists(database, "tool_class_fact")) {
    if (generation?.toolProvenanceComplete !== true) {
      // The rest of a readable partial publication still supplies honest
      // coverage metadata. Withhold only the un-attested tool projection; the
      // companion's generation gate prevents it from becoming unified
      // authority.
      return projection;
    }
    const expectedCount = Number(generation.toolFacts);
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
      throw fixedError("local_unified_index_tool_attestation_mismatch");
    }
    let count = 0;
    const fingerprint = createUnifiedIndexToolFactFingerprintAccumulator();
    for (const row of database.prepare(`
      SELECT f.event_key, f.source_local, f.source_offset, f.source_ordinal,
             f.session_local, f.observed_at_ms, f.tool_ordinal,
             f.tool_class, f.source_kind, gs.source_ordinal AS attested_ordinal
      FROM tool_class_fact f
      LEFT JOIN generation_source gs
        ON gs.generation_id = f.generation_id
       AND gs.source_local = f.source_local
      WHERE f.generation_id = ?
      ORDER BY f.event_key`).iterate(generation.id)) {
      if (!isDigest(row.event_key)
          || !isDigest(row.source_local)
          || !isDigest(row.session_local)
          || !Number.isSafeInteger(Number(row.source_offset))
          || Number(row.source_offset) < 0
          || !Number.isSafeInteger(Number(row.source_ordinal))
          || Number(row.source_ordinal) < 0
          || Number(row.attested_ordinal) !== Number(row.source_ordinal)
          || !Number.isSafeInteger(Number(row.observed_at_ms))
          || !Number.isSafeInteger(Number(row.tool_ordinal))
          || Number(row.tool_ordinal) < 0
          || typeof row.tool_class !== "string"
          || !/^[a-z0-9._:-]{1,64}$/u.test(row.tool_class)
          || typeof row.source_kind !== "string"
          || !/^[a-z0-9._:-]{1,64}$/u.test(row.source_kind)) {
        throw fixedError("local_unified_index_tool_attestation_mismatch");
      }
      const toolClass = KNOWN_TOOL_CLASSES.has(row.tool_class)
        ? row.tool_class
        : "other";
      projection.counts[toolClass] += 1;
      projection.total += 1;
      count += 1;
      fingerprint.add(row);
    }
    if (count !== expectedCount
        || fingerprint.digest() !== generation.toolFactFingerprint) {
      throw fixedError("local_unified_index_tool_attestation_mismatch");
    }
    return projection;
  }
  // A pre-v8 read-only index can still be displayed in explicit legacy mode.
  // It is never accepted as the unified authority because its generation has
  // no tool attestation fields.
  if (!tableExists(database, "tool_class_count")) return projection;
  for (const row of database.prepare(
    "SELECT tool_class, SUM(count) AS count FROM tool_class_count GROUP BY tool_class",
  ).iterate()) {
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0) continue;
    const toolClass = KNOWN_TOOL_CLASSES.has(row.tool_class)
      ? row.tool_class
      : "other";
    projection.counts[toolClass] += count;
    projection.total += count;
  }
  return projection;
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

function cooperativeYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function* usageBatches(database) {
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
    yield batch;
    afterRowId = Number(batch.at(-1).row_id);
    if (batch.length < USAGE_READ_BATCH_ROWS) return;
    await cooperativeYield();
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
  mode = "full",
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowMs must be a finite epoch timestamp");
  }
  if (!UNIFIED_PROJECTION_MODES.has(mode)) {
    throw new TypeError("mode must be full or deferred");
  }
  // Startup and the refresh controller's provisional headline do not need to
  // replay the whole unified index before they can publish a useful dashboard.
  // Their caller falls back to the already replay-safe accounting cache and
  // labels the full-history projection as loading. The terminal refresh calls
  // this reader in full mode and replaces that provisional snapshot.
  if (mode === "deferred") {
    return unavailable("deferred", "local_unified_index_deferred");
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
    await revalidatePublishedPath(indexFile, metadata);
    // A legacy read-only file may still satisfy the projection queries, but
    // only v2 publications carry the immutable generation proof accounting
    // needs. Keep that distinction explicit instead of upgrading a legacy
    // projection into authority merely because its rows are readable.
    let generation = null;
    try {
      generation = readUnifiedIndexGenerationDescriptor(database);
    } catch {
      generation = null;
    }
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
    for await (const batch of usageBatches(database)) {
      let rowsSinceYield = 0;
      for (const row of batch) {
        if (rowsSinceYield === USAGE_PROCESS_YIELD_ROWS) {
          await cooperativeYield();
          rowsSinceYield = 0;
        }
        rowsSinceYield += 1;
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
    }
    let cacheSwitchImpact;
    let cacheContinuityImpact;
    try {
      ({ cacheSwitchImpact, cacheContinuityImpact } = readCacheImpacts(
        database,
        { nowMs, pricer, declaredSpeedBaselines: baselines },
      ));
    } catch {
      // The ordinary usage projection remains useful if this optional,
      // read-only diagnostic cannot be evaluated. Never substitute a zero for
      // a failed transition read.
      cacheSwitchImpact = unavailableCacheSwitchImpact(
        "cache_switch_impact_unavailable",
      );
      cacheContinuityImpact = unavailableCacheContinuityImpact(
        "cache_continuity_impact_unavailable",
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
    const discoveredSourceCount = generation?.discoveredSourceCount
      ?? (Number.isSafeInteger(sourceCount) ? sourceCount : 0);
    const discoveredSourceBytes = generation?.discoveredSourceBytes
      ?? (Number.isSafeInteger(sourceBytes) ? sourceBytes : 0);
    const indexedSourceCount = generation?.indexedSourceCount;
    const indexedSourceBytes = generation?.indexedSourceBytes;
    const result = {
      status: "available",
      errorCode: null,
      generatedAt: readMeta(database, "generated_at"),
      indexStatus: readMeta(database, "status") ?? "unknown",
      generation,
      coveredAt: {
        startAt: isoOrNull(firstObservedMs),
        endAt: isoOrNull(lastObservedMs),
      },
      usageEvents,
      quotaObservations,
      sourceCount: Number.isSafeInteger(sourceCount) ? sourceCount : 0,
      sourceBytes: Number.isSafeInteger(sourceBytes) ? sourceBytes : 0,
      discoveredSourceCount: Number.isSafeInteger(discoveredSourceCount)
        ? discoveredSourceCount : 0,
      discoveredSourceBytes: Number.isSafeInteger(discoveredSourceBytes)
        ? discoveredSourceBytes : 0,
      indexedSourceCount: Number.isSafeInteger(indexedSourceCount)
        ? indexedSourceCount : 0,
      indexedSourceBytes: Number.isSafeInteger(indexedSourceBytes)
        ? indexedSourceBytes : 0,
      indexBytes: metadata.size,
      latestExportableRecordAt: isoOrNull(lastObservedMs),
      tools: toolProjection(database, generation),
      toolCoverageStatus: generation?.toolProvenanceComplete === true
        ? "complete"
        : generation === null ? "unavailable" : "partial",
      toolCoverageBlockReason: generation?.toolProvenanceComplete === true
        ? null
        : generation?.blockReason ?? "tool_provenance_incomplete",
      usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
      cacheSwitchImpact,
      cacheContinuityImpact,
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
    let settledGeneration = null;
    try {
      settledGeneration = readUnifiedIndexGenerationDescriptor(database);
    } catch {
      settledGeneration = null;
    }
    if ((generation?.id ?? null) !== (settledGeneration?.id ?? null)
        || (generation?.fingerprint ?? null)
          !== (settledGeneration?.fingerprint ?? null)) {
      throw fixedError("local_unified_index_generation_mismatch");
    }
    await revalidatePublishedPath(indexFile, metadata);
    return result;
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) {
      return unavailable("unavailable", error.code);
    }
    throw fixedError("local_unified_index_unavailable");
  } finally {
    database.close();
  }
}
