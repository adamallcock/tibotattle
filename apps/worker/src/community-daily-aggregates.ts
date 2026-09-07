import { canonicalJson } from "./canonical-json";
import {
  COMMUNITY_ALLOWANCE_BASIS,
  COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS,
  collectCommunityAllowanceFits,
  readCachedCommunityAllowanceFits,
  summarizeCommunityAllowanceDay,
} from "./community-allowance";
import type { CommunityAllowanceFit, CommunityModelCacheReadBudget } from "./community-allowance";
import { PREVIEW_CACHE_JSON_LIMIT_BYTES } from "./admin-community-allowance";
import type { PublicAllowanceBreakdownsCacheRow } from "./public-allowance-breakdowns";
import { sha256Hex } from "./crypto";
import {
  DAILY_SPEND_CHUNKS_PER_PASS,
  DAILY_SPEND_EVENTS_PER_PASS,
  isCurrentCommunityDailySpend,
  priceCommunityDailySpend,
} from "./community-daily-spend";
import type { DailySpendBudget } from "./community-daily-spend";
import {
  loadV1SourcePin,
  V1_WINNER_FILTER_SQL,
} from "./telemetry-v1-source-selection";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function driftReconcileToDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The lowest UTC day whose complete trailing evidence window still fits inside
 * the analyzer corpus. The analyzer exposes 100 days, while each point needs
 * the preceding 30 days, so a methodology change may honestly rebuild the most
 * recent 70 calendar days only. Older points retire with their last published
 * value and the public read gate omits blocks on the superseded basis.
 */
function driftReconcileFromDay(nowMs: number): string {
  const todayStartMs = Date.parse(
    `${driftReconcileToDay(nowMs)}T00:00:00.000Z`,
  );
  return new Date(
    todayStartMs
      - (COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS - 1) * MILLISECONDS_PER_DAY,
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Day-partitioned community aggregates for telemetry-contribution-v1.0.
 * Maintained publication and operational boundaries live in
 * docs/reference/api-surface.md and
 * docs/runbooks/2026-08-13-community-allowance-band-diagnosis.md.
 *
 * This deliberately reuses the revisioned pattern migration 0012 established
 * for weekly snapshots — published revisions are immutable rows, recomputation
 * writes revision N+1 — and replaces the sealing semantics: any accepted chunk
 * revision enqueues its day (via the 0031 journal trigger) and the hourly cron
 * drains the queue, so June recomputes when June data lands in August. Per
 * owner decision 4, no per-day suppression threshold blocks publication.
 */
export const COMMUNITY_DAILY_POLICY_VERSION = "community-daily-v1.0";
const DAILY_AGGREGATE_SCHEMA_VERSION = "community-daily-aggregate-v1.0";
const MAX_DAILY_AGGREGATE_CELLS = 100;

interface DailyRebuildRow {
  day: string;
  requested_epoch: number;
  requested_at: string;
}

interface DailyTotalsRow {
  contributing_participants: number;
  contributing_devices: number;
  usage_events: number;
  quota_observations: number;
  session_dimensions: number;
  input_uncached_tokens: number;
  input_cache_read_tokens: number;
  input_cache_write_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  output_combined_tokens: number;
}

interface DailyCellRow {
  provider: string;
  model_id: string;
  usage_events: number;
  input_uncached_tokens: number;
  input_cache_read_tokens: number;
  input_cache_write_tokens: number;
  output_text_tokens: number;
  output_reasoning_tokens: number;
  output_combined_tokens: number;
}

/**
 * Provider for the cross-participant allowance fits, keyed by the mutation
 * epoch the requesting build read its sources under. The collection walks
 * every active participant's v0.2 corpus, so a cron pass computes it once and
 * shares it across the ≤24 day builds of that pass; a mid-pass epoch bump
 * (participant deletion) invalidates the cache and the next build recollects
 * against the surviving corpus.
 */
type AllowanceFitsForEpoch = (epoch: number) => Promise<CommunityAllowanceFit[] | null>;

export interface CommunityDailyCacheRecovery {
  /** Activity-only admits new/unpublished days and retains their rebuild journal. */
  mode: "cache-only" | "activity-only";
  /** Conservative phase allocation; the root separately meters actual D1 statements. */
  budget: CommunityModelCacheReadBudget;
}

function memoizedAllowanceFits(
  db: D1Database,
  nowMs: number,
  recovery?: CommunityDailyCacheRecovery,
  initial?: { epoch: number; fits: CommunityAllowanceFit[] },
): AllowanceFitsForEpoch {
  let cached: { epoch: number; fits: CommunityAllowanceFit[] } | null = initial ?? null;
  return async (epoch: number) => {
    if (cached === null || cached.epoch !== epoch) {
      if (recovery) {
        // One complete cohort per recovery pass. A later source change defers
        // the remaining days instead of restarting analysis or mixing epochs.
        if (cached !== null) return null;
        const fits = await readCachedCommunityAllowanceFits(db, nowMs, { budget: recovery.budget });
        const current = await db.prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1")
          .first<{ mutation_epoch: number }>();
        if (fits === null || current?.mutation_epoch !== epoch) return null;
        cached = { epoch, fits };
        return fits;
      }
      // The analyzer's trailing read horizon is anchored to this pass's
      // scheduled time, so the reconciler and the day builds it feeds share one
      // horizon.
      cached = { epoch, fits: await collectCommunityAllowanceFits(db, nowMs) };
    }
    return cached.fits;
  };
}

/**
 * Fit-corpus drift reconciliation: the honesty backstop behind the payload's
 * `recomputesOnLateData: true` claim for the allowance block.
 *
 * The rebuild queue is fed by v1 chunk arrivals (0031 trigger) and participant
 * deletion, but the fit corpus is the v0.2 contribution path, which enqueues
 * nothing — a late v0.2 contribution whose fits fall inside already-published
 * trailing windows would otherwise leave those days' published fitCount and
 * centralUsd silently wrong forever. So every rebuild pass recomputes the
 * expected allowance block for each currently published day from the current
 * fit corpus and enqueues exactly the days whose published block disagrees
 * (including pre-allowance revisions, and any basis/cohort definition change
 * shipped in code). Convergent: once a day republishes with the matching
 * block, it stops drifting; days whose revisions are all withdrawn are the
 * deletion machinery's job and are never touched here.
 */
async function enqueueCommunityAllowanceDriftRebuilds(
  db: D1Database,
  allowanceFitsForEpoch: AllowanceFitsForEpoch,
  nowMs: number,
  cacheOnly = false,
): Promise<boolean> {
  const epochRow = await db.prepare(
    `SELECT mutation_epoch FROM community_snapshot_mutation_control
      WHERE singleton_id = 1`,
  ).first<{ mutation_epoch: number }>();
  const reconcileEpoch = Number(epochRow?.mutation_epoch);
  if (!Number.isSafeInteger(reconcileEpoch) || reconcileEpoch < 0) {
    throw new Error("community daily aggregate mutation control unavailable");
  }
  const fits = await allowanceFitsForEpoch(reconcileEpoch);
  if (fits === null) return false;
  // Reconcile only days inside the analyzer's trailing read horizon; aged days
  // keep their last published value instead of churning to a null block.
  const reconcileFromDay = driftReconcileFromDay(nowMs);
  const reconcileToDay = driftReconcileToDay(nowMs);
  const published = await db.prepare(
    `SELECT a.day, ${cacheOnly ? "CASE WHEN length(CAST(a.payload_json AS BLOB)) <= 262144 THEN a.payload_json ELSE NULL END" : "a.payload_json"} AS payload_json
       FROM community_daily_aggregates a
       JOIN (
         SELECT day, MAX(revision) AS revision
           FROM community_daily_aggregates
          WHERE release_state = 'published'
            AND day >= ?1 AND day <= ?2
          GROUP BY day
       ) latest ON latest.day = a.day AND latest.revision = a.revision
      WHERE a.release_state = 'published'
        AND a.day >= ?1 AND a.day <= ?2
      ORDER BY a.day ASC ${cacheOnly ? "LIMIT 71" : ""}`,
  ).bind(reconcileFromDay, reconcileToDay).all<{
    day: string;
    payload_json: string | null;
  }>();
  if (cacheOnly && (published.results.length > COMMUNITY_ALLOWANCE_RECONSTRUCTABLE_DAYS
      || published.results.some(row => row.payload_json === null))) return false;
  const drifted: string[] = [];
  for (const row of published.results) {
    const expected = canonicalJson(
      summarizeCommunityAllowanceDay(fits, row.day),
    );
    let current: string | null = null;
    try {
      const payload = JSON.parse(row.payload_json!) as { allowance?: unknown };
      if (payload.allowance !== undefined) {
        current = canonicalJson(payload.allowance);
      }
    } catch {
      current = null;
    }
    if (current !== expected) drifted.push(row.day);
  }
  const publicationState = published.results.length > 0
      && drifted.length === 0
    ? "ready"
    : "updating";
  // This singleton is the only global cutover evidence public requests read.
  // The WHERE clause avoids rewriting it every hour: it changes only with the
  // state, basis, or UTC safe window (normally once per day when settled).
  await db.prepare(
    `INSERT INTO community_allowance_publication_state (
       singleton, publication_state, expected_basis,
       safe_from_day, safe_to_day, changed_at, attribution_method_version
     ) SELECT 1, ?1, ?2, ?3, ?4, ?5, ?7
       WHERE EXISTS (
         SELECT 1 FROM community_snapshot_mutation_control
          WHERE singleton_id = 1 AND mutation_epoch = ?6
       )
     ON CONFLICT(singleton) DO UPDATE SET
       publication_state = excluded.publication_state,
       expected_basis = excluded.expected_basis,
       safe_from_day = excluded.safe_from_day,
       safe_to_day = excluded.safe_to_day,
       changed_at = excluded.changed_at,
       attribution_method_version = excluded.attribution_method_version
     WHERE community_allowance_publication_state.publication_state
             <> excluded.publication_state
        OR community_allowance_publication_state.expected_basis
             <> excluded.expected_basis
        OR community_allowance_publication_state.safe_from_day
             <> excluded.safe_from_day
        OR community_allowance_publication_state.safe_to_day
             <> excluded.safe_to_day
        OR community_allowance_publication_state.attribution_method_version
             IS NOT excluded.attribution_method_version`,
  ).bind(
    publicationState,
    COMMUNITY_ALLOWANCE_BASIS,
    reconcileFromDay,
    reconcileToDay,
    new Date(nowMs).toISOString(),
    reconcileEpoch,
    COMMUNITY_ATTRIBUTION_METHOD_VERSION,
  ).run();
  for (const day of drifted) {
    await db.prepare(
      `INSERT INTO community_daily_aggregate_rebuilds (
        day, requested_epoch, requested_at
      ) SELECT ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE EXISTS (SELECT 1 FROM community_snapshot_mutation_control
          WHERE singleton_id = 1 AND mutation_epoch = ?2)
      ON CONFLICT(day) DO UPDATE SET
        requested_epoch = excluded.requested_epoch,
        requested_at = excluded.requested_at`,
    ).bind(day, reconcileEpoch).run();
  }
  return true;
}

/** Additive price-cache backfill covers the displayed year, not fit lookback. */
async function readCommunitySpendDriftDays(
  db: D1Database, nowMs: number,
): Promise<Set<string>> {
  const to = driftReconcileToDay(nowMs);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 365 * MILLISECONDS_PER_DAY)
    .toISOString().slice(0, 10);
  const published = await db.prepare(`SELECT a.day,
      CASE WHEN json_valid(a.payload_json)
        THEN json_extract(a.payload_json, '$.apiEquivalentSpend') ELSE NULL END AS spend_json,
      CASE WHEN json_valid(a.payload_json)
        THEN json_extract(a.payload_json, '$.totals.usageEvents') ELSE NULL END AS usage_events
    FROM community_daily_aggregates a JOIN (
      SELECT day, MAX(revision) AS revision FROM community_daily_aggregates
      WHERE release_state = 'published' AND day >= ?1 AND day <= ?2 GROUP BY day
    ) latest ON latest.day = a.day AND latest.revision = a.revision
    WHERE a.release_state = 'published' ORDER BY a.day LIMIT 366`)
    .bind(from, to).all<{ day: string; spend_json: string | null; usage_events: number | null }>();
  const drifted = new Set<string>();
  for (const row of published.results) {
    let spend: unknown;
    try { spend = row.spend_json === null ? undefined : JSON.parse(row.spend_json); } catch { spend = undefined; }
    if (!isCurrentCommunityDailySpend(spend) || spend.usageEvents !== row.usage_events) drifted.add(row.day);
  }
  // Missing/stale price blocks themselves are the convergent backfill journal.
  // Do not mix synthetic requests with source-correction requests: preserving
  // an aged allowance is valid only for a positively price-only rebuild.
  return drifted;
}

async function buildCommunityDailyAggregate(
  db: D1Database,
  rebuild: DailyRebuildRow | { day: string },
  scheduledTime: number,
  allowanceFitsForEpoch: AllowanceFitsForEpoch,
  spendBudget: DailySpendBudget,
  cacheOnly = false,
  activityOnly = false,
): Promise<{ state: "built" | "conflicted" | "deferred"; aggregateId: string }> {
  const { day } = rebuild;
  const priceBackfill = !("requested_at" in rebuild);
  // Bind the build to the mutation epoch it read its sources under, exactly
  // as the weekly builder does: a participant deletion bumps the epoch (0012
  // trigger), so a build racing a deletion cannot publish the deleted data —
  // its finalization predicate below rejects the stale snapshot.
  const epochRow = await db.prepare(
    `SELECT mutation_epoch FROM community_snapshot_mutation_control
      WHERE singleton_id = 1`,
  ).first<{ mutation_epoch: number }>();
  const buildEpoch = Number(epochRow?.mutation_epoch);
  if (!Number.isSafeInteger(buildEpoch) || buildEpoch < 0) {
    throw new Error("community daily aggregate mutation control unavailable");
  }
  if (activityOnly && await db.prepare(`SELECT 1 AS published FROM community_daily_aggregates
      WHERE day = ? AND release_state = 'published' LIMIT 1`).bind(day).first()) {
    return { state: "deferred", aggregateId: "" };
  }
  const cachedFits = cacheOnly ? await allowanceFitsForEpoch(buildEpoch) : undefined;
  if (cachedFits === null) return { state: "deferred", aggregateId: "" };
  // Resolve once for BOTH totals and cells. This is the same analytical-stream
  // winner policy as calibration, with explicit session-only fallback.
  const sourcePin = await loadV1SourcePin(db, { day });
  const [totals, cells, revisionRow] = await Promise.all([
    // contributing_devices deliberately counts only winning devices — the
    // devices whose records the published numbers actually include (one per
    // participant per day). A losing transport duplicate is not a
    // contribution.
    db.prepare(
      `SELECT
        COUNT(DISTINCT r.participant_id) AS contributing_participants,
        COUNT(DISTINCT r.participant_id || ':' || r.device_id)
          AS contributing_devices,
        SUM(CASE WHEN r.stream = 'usage' THEN 1 ELSE 0 END) AS usage_events,
        SUM(CASE WHEN r.stream = 'quota' THEN 1 ELSE 0 END)
          AS quota_observations,
        SUM(CASE WHEN r.stream = 'session' THEN 1 ELSE 0 END)
          AS session_dimensions,
        COALESCE(SUM(r.input_uncached_tokens), 0) AS input_uncached_tokens,
        COALESCE(SUM(r.input_cache_read_tokens), 0)
          AS input_cache_read_tokens,
        COALESCE(SUM(r.input_cache_write_tokens), 0)
          AS input_cache_write_tokens,
        COALESCE(SUM(r.output_text_tokens), 0) AS output_text_tokens,
        COALESCE(SUM(r.output_reasoning_tokens), 0)
          AS output_reasoning_tokens,
        COALESCE(SUM(COALESCE(r.output_combined_tokens,
          COALESCE(r.output_text_tokens, 0)
            + COALESCE(r.output_reasoning_tokens, 0))), 0)
          AS output_combined_tokens
       FROM telemetry_analytical_records r
       JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE ${V1_WINNER_FILTER_SQL} AND r.observed_day = ?`,
    ).bind(sourcePin.winnersJson, day).first<DailyTotalsRow>(),
    db.prepare(
      `SELECT r.provider, r.model_id,
        COUNT(*) AS usage_events,
        COALESCE(SUM(r.input_uncached_tokens), 0) AS input_uncached_tokens,
        COALESCE(SUM(r.input_cache_read_tokens), 0)
          AS input_cache_read_tokens,
        COALESCE(SUM(r.input_cache_write_tokens), 0)
          AS input_cache_write_tokens,
        COALESCE(SUM(r.output_text_tokens), 0) AS output_text_tokens,
        COALESCE(SUM(r.output_reasoning_tokens), 0)
          AS output_reasoning_tokens,
        COALESCE(SUM(COALESCE(r.output_combined_tokens,
          COALESCE(r.output_text_tokens, 0)
            + COALESCE(r.output_reasoning_tokens, 0))), 0)
          AS output_combined_tokens
       FROM telemetry_analytical_records r
       JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE ${V1_WINNER_FILTER_SQL} AND r.observed_day = ? AND r.stream = 'usage'
       GROUP BY r.provider, r.model_id
       ORDER BY r.provider, r.model_id
       LIMIT ?`,
    ).bind(sourcePin.winnersJson, day, MAX_DAILY_AGGREGATE_CELLS + 1).all<DailyCellRow>(),
    db.prepare(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS revision,
         (SELECT payload_json FROM community_daily_aggregates
           WHERE day = ?1 AND release_state = 'published' ORDER BY revision DESC LIMIT 1) AS previous_payload_json
         FROM community_daily_aggregates WHERE day = ?1`,
    ).bind(day).first<{ revision: number; previous_payload_json: string | null }>(),
  ]);
  const revision = Number(revisionRow?.revision ?? 1);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid community daily aggregate revision");
  }
  // The allowance block is additive on schema v1.0: the site normalizer
  // treats a missing or invalid block as per-day-absent, so older published
  // revisions without it stay renderable and old clients ignore it entirely.
  const aggregateId = `community-daily:${day}:r${revision}`;
  const spendResult = await priceCommunityDailySpend(
    db, day, sourcePin.winnersJson, Number(totals?.usage_events ?? 0), spendBudget,
  );
  if (spendResult.state !== "priced") return { state: spendResult.state, aggregateId };
  const fits = activityOnly ? null : cachedFits ?? await allowanceFitsForEpoch(buildEpoch);
  if (!activityOnly && fits === null) return { state: "deferred", aggregateId };
  let allowance = fits === null ? undefined : summarizeCommunityAllowanceDay(fits, day);
  if (priceBackfill && day < driftReconcileFromDay(scheduledTime) && revisionRow?.previous_payload_json) {
    // A price-only backfill must not erase a historical estimate whose full
    // trailing fit corpus is no longer reconstructable. Its original basis is
    // retained; the existing public allowance gate still decides eligibility.
    const previous = JSON.parse(revisionRow.previous_payload_json) as { allowance?: typeof allowance };
    if (previous.allowance !== undefined) allowance = previous.allowance;
  }
  const releasedAt = new Date(scheduledTime).toISOString();
  const cellRows = cells.results.slice(0, MAX_DAILY_AGGREGATE_CELLS);
  const payload = {
    schemaVersion: DAILY_AGGREGATE_SCHEMA_VERSION,
    aggregateId,
    day,
    revision,
    releasedAt,
    // Revisions replace sealing: this row never mutates, and late or revised
    // source data produces the next revision instead of being rejected.
    immutableRevision: true,
    recomputesOnLateData: true,
    policyVersion: COMMUNITY_DAILY_POLICY_VERSION,
    suppression: "none_daily_grain_by_owner_decision",
    // Aggregate dollar-equivalent estimates and participant counts are
    // explicitly owner-approved for publication; no per-account identifier
    // exists anywhere in this block.
    ...(allowance === undefined ? {} : { allowance }),
    apiEquivalentSpend: spendResult.spend,
    totals: {
      contributingParticipants: Number(totals?.contributing_participants ?? 0),
      contributingDevices: Number(totals?.contributing_devices ?? 0),
      usageEvents: Number(totals?.usage_events ?? 0),
      quotaObservations: Number(totals?.quota_observations ?? 0),
      sessionDimensions: Number(totals?.session_dimensions ?? 0),
      inputUncachedTokens: Number(totals?.input_uncached_tokens ?? 0),
      inputCacheReadTokens: Number(totals?.input_cache_read_tokens ?? 0),
      inputCacheWriteTokens: Number(totals?.input_cache_write_tokens ?? 0),
      outputTextTokens: Number(totals?.output_text_tokens ?? 0),
      outputReasoningTokens: Number(totals?.output_reasoning_tokens ?? 0),
      outputCombinedTokens: Number(totals?.output_combined_tokens ?? 0),
    },
    cellsTruncated: cells.results.length > MAX_DAILY_AGGREGATE_CELLS,
    cells: cellRows.map((cell) => ({
      provider: cell.provider,
      modelId: cell.model_id,
      usageEvents: Number(cell.usage_events),
      inputUncachedTokens: Number(cell.input_uncached_tokens),
      inputCacheReadTokens: Number(cell.input_cache_read_tokens),
      inputCacheWriteTokens: Number(cell.input_cache_write_tokens),
      outputTextTokens: Number(cell.output_text_tokens),
      outputReasoningTokens: Number(cell.output_reasoning_tokens),
      outputCombinedTokens: Number(cell.output_combined_tokens),
    })),
  };
  const payloadJson = canonicalJson(payload);
  const payloadHash = await sha256Hex(payloadJson);
  if ((await loadV1SourcePin(db, { day })).fingerprint !== sourcePin.fingerprint) {
    return { state: "conflicted", aggregateId };
  }
  const results = await db.batch([
    // The finalization predicate mirrors the weekly builder's: the build is
    // cancelled outright when the mutation epoch moved after its source
    // reads — a deletion mid-build must never publish the deleted data.
    db.prepare(
      `INSERT INTO community_daily_aggregates (
        aggregate_id, day, revision, source_mutation_epoch, policy_version,
        payload_json, payload_sha256, release_state, released_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'published', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM community_daily_aggregates
         WHERE day = ? AND revision >= ?
      )
      AND EXISTS (
        SELECT 1 FROM community_snapshot_mutation_control
         WHERE singleton_id = 1 AND mutation_epoch = ?
      )
      AND (? = 0 OR (
        NOT EXISTS (SELECT 1 FROM community_daily_aggregate_rebuilds WHERE day = ?)
        AND EXISTS (SELECT 1 FROM community_daily_aggregates WHERE day = ? AND release_state = 'published')
      ))
      AND (? = 0 OR NOT EXISTS (SELECT 1 FROM community_daily_aggregates
        WHERE day = ? AND release_state = 'published'))`,
    ).bind(
      aggregateId,
      day,
      revision,
      buildEpoch,
      COMMUNITY_DAILY_POLICY_VERSION,
      payloadJson,
      payloadHash,
      releasedAt,
      day,
      revision,
      buildEpoch,
      priceBackfill ? 1 : 0,
      day,
      day,
      activityOnly ? 1 : 0,
      day,
    ),
    // Clear exactly the request this build answered, and only when this
    // build's revision actually published. A cancelled build leaves the row
    // queued for the next pass; a concurrent arrival upserts a fresh
    // requested_at and the delete no-ops — convergent, never lossy.
    // Activity-only recovery deliberately retains the request: it is the
    // durable allowance-rehydration journal once the whole fit cohort is ready.
    ...(!activityOnly && "requested_at" in rebuild ? [db.prepare(
      `DELETE FROM community_daily_aggregate_rebuilds
        WHERE day = ? AND requested_at = ? AND requested_epoch = ?
          AND EXISTS (
            SELECT 1 FROM community_daily_aggregates
             WHERE day = ? AND revision = ? AND source_mutation_epoch = ?
               AND release_state = 'published'
          )`,
    ).bind(
      day,
      rebuild.requested_at,
      rebuild.requested_epoch,
      day,
      revision,
      buildEpoch,
    )] : []),
  ]);
  if (results[0]?.meta.changes === 1) {
    return { state: "built", aggregateId };
  }
  return { state: "conflicted", aggregateId };
}

export async function rebuildPendingCommunityDailyAggregates(
  db: D1Database,
  scheduledTime: number,
  maximumRebuilds = 24,
  spendLimits: { chunks?: number; events?: number } = {},
  recovery?: CommunityDailyCacheRecovery,
): Promise<{ processed: number; remaining: boolean; aggregateIds: string[]; deferred?: true }> {
  if (!Number.isFinite(scheduledTime)
      || !Number.isSafeInteger(maximumRebuilds)
      || maximumRebuilds < 1
      || maximumRebuilds > 48) {
    throw new Error("invalid community daily aggregate rebuild request");
  }
  const spendBudget: DailySpendBudget = {
    remainingChunks: spendLimits.chunks ?? DAILY_SPEND_CHUNKS_PER_PASS,
    remainingEvents: spendLimits.events ?? DAILY_SPEND_EVENTS_PER_PASS,
  };
  if (!Number.isSafeInteger(spendBudget.remainingChunks) || spendBudget.remainingChunks < 0
      || spendBudget.remainingChunks > DAILY_SPEND_CHUNKS_PER_PASS
      || !Number.isSafeInteger(spendBudget.remainingEvents) || spendBudget.remainingEvents < 0
      || spendBudget.remainingEvents > DAILY_SPEND_EVENTS_PER_PASS) {
    throw new Error("invalid community daily spend budget");
  }
  const deferred = { processed: 0, remaining: true, aggregateIds: [], deferred: true } as const;
  const activityOnly = recovery?.mode === "activity-only";
  let initialFits: { epoch: number; fits: CommunityAllowanceFit[] } | undefined;
  if (recovery) {
    const budget = recovery.budget;
    const now = (budget.now ?? Date.now)();
    const reserve = budget.reserveQueries ?? 0;
    if (!["cache-only", "activity-only"].includes(recovery.mode) || !Number.isSafeInteger(budget.remainingQueries)
        || !Number.isSafeInteger(reserve) || reserve < 0 || !Number.isFinite(now)
        || !Number.isFinite(budget.deadlineMs) || now >= budget.deadlineMs) return { ...deferred, aggregateIds: [] };
    const fixedQueries = activityOnly ? 2 : 77;
    if (!activityOnly) {
      // Read the COMPLETE cohort before allocating optional days/chunks. A
      // fixed 18-query buffer cannot cover the per-participant blob reads and
      // would indefinitely starve even 16 otherwise-current participants.
      // Keep only the fixed publication work and one day in reserve while the
      // cache reader charges its actual queries. These two outer epoch checks
      // are separately paid before I/O, including on a deferred cache result.
      const minimumPublicationQueries = fixedQueries + 12;
      if (budget.remainingQueries - reserve < minimumPublicationQueries + 2) return { ...deferred, aggregateIds: [] };
      budget.remainingQueries -= 2;
      const originalReserve = budget.reserveQueries;
      budget.reserveQueries = reserve + minimumPublicationQueries;
      try {
        const first = await db.prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1")
          .first<{ mutation_epoch: number }>();
        if (!Number.isSafeInteger(first?.mutation_epoch) || first!.mutation_epoch < 0) return { ...deferred, aggregateIds: [] };
        const fits = await readCachedCommunityAllowanceFits(db, scheduledTime, { budget });
        if (fits === null) return { ...deferred, aggregateIds: [] };
        const current = await db.prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1")
          .first<{ mutation_epoch: number }>();
        if (current?.mutation_epoch !== first!.mutation_epoch) return { ...deferred, aggregateIds: [] };
        initialFits = { epoch: first!.mutation_epoch, fits };
      } catch {
        return { ...deferred, aggregateIds: [] };
      } finally {
        if (originalReserve === undefined) delete budget.reserveQueries;
        else budget.reserveQueries = originalReserve;
      }
    }
    // Size optional work only after cache acquisition. Unfinished days and
    // chunks remain queued; this changes work per pass, never fit admission.
    const available = budget.remainingQueries - reserve;
    maximumRebuilds = Math.min(maximumRebuilds, Math.floor((available - fixedQueries) / 12));
    if (maximumRebuilds < 1) return { ...deferred, aggregateIds: [] };
    spendBudget.remainingChunks = Math.min(spendBudget.remainingChunks,
      Math.max(0, available - fixedQueries - maximumRebuilds * 12) * 8);
    budget.remainingQueries -= fixedQueries + maximumRebuilds * 12 + Math.ceil(spendBudget.remainingChunks / 8);
  }
  const allowanceFitsForEpoch = memoizedAllowanceFits(db, scheduledTime, recovery, initialFits);
  // Reconcile before draining, so days a late v0.2 contribution drifted are
  // enqueued in time for this same pass to rebuild them.
  try {
    if (!activityOnly && !await enqueueCommunityAllowanceDriftRebuilds(
      db, allowanceFitsForEpoch, scheduledTime, Boolean(recovery),
    )) return { ...deferred, aggregateIds: [] };
  } catch (error) {
    if (recovery) return { ...deferred, aggregateIds: [] };
    throw error;
  }
  const priceBackfills = activityOnly ? new Set<string>() : await readCommunitySpendDriftDays(db, scheduledTime);
  const rows = await db.prepare(
    `SELECT day, requested_epoch, requested_at
       FROM community_daily_aggregate_rebuilds
       ${activityOnly ? "WHERE NOT EXISTS (SELECT 1 FROM community_daily_aggregates a WHERE a.day = community_daily_aggregate_rebuilds.day AND a.release_state = 'published')" : ""}
      ORDER BY day ASC
      LIMIT ?`,
  ).bind(maximumRebuilds + 1).all<DailyRebuildRow>();
  const aggregateIds: string[] = [];
  let processed = 0;
  let deferredWork = false;
  for (const row of rows.results.slice(0, maximumRebuilds)) {
    const result = await buildCommunityDailyAggregate(
      db,
      row,
      scheduledTime,
      allowanceFitsForEpoch,
      spendBudget,
      Boolean(recovery) && !activityOnly,
      activityOnly,
    );
    if (result.state === "deferred") deferredWork = true;
    if (result.state !== "deferred") {
      processed += 1;
      aggregateIds.push(result.aggregateId);
    }
    if (result.state === "built") priceBackfills.delete(row.day);
  }
  // A real source journal always has priority. A concurrently queued correction
  // also fences the price-only INSERT itself, so it cannot inherit old fits.
  const queuedDays = new Set(rows.results.map(row => row.day));
  for (const day of [...priceBackfills].filter(day => !queuedDays.has(day)).slice(0, maximumRebuilds - processed)) {
    const result = await buildCommunityDailyAggregate(db, { day }, scheduledTime, allowanceFitsForEpoch, spendBudget, Boolean(recovery));
    if (result.state === "deferred") deferredWork = true;
    if (result.state !== "deferred") {
      processed += 1;
      aggregateIds.push(result.aggregateId);
    }
    if (result.state === "built") priceBackfills.delete(day);
  }
  const pending = await db.prepare(
    "SELECT 1 AS pending FROM community_daily_aggregate_rebuilds LIMIT 1",
  ).first<{ pending: number }>();
  return { processed, remaining: Boolean(pending) || priceBackfills.size > 0, aggregateIds,
    ...(recovery && deferredWork ? { deferred: true as const } : {}) };
}

export interface LatestCommunityDailyAggregateRow {
  aggregate_id: string;
  day: string;
  revision: number;
  release_state: "published" | "withdrawn";
  payload_json: string;
}

export async function readLatestCommunityDailyAggregate(
  db: D1Database,
  day: string,
): Promise<LatestCommunityDailyAggregateRow | null> {
  return db.prepare(
    `SELECT aggregate_id, day, revision, release_state, payload_json
       FROM community_daily_aggregates
      WHERE day = ?
      ORDER BY revision DESC
      LIMIT 1`,
  ).bind(day).first<LatestCommunityDailyAggregateRow>();
}

export interface PublishedCommunityDailyAggregateRow {
  day: string;
  revision: number;
  payload_json: string;
  released_at: string;
}

export interface CommunityAllowancePublicationStateRow {
  publication_state: "updating" | "ready";
  expected_basis: string;
  attribution_method_version: string | null;
  safe_from_day: string;
  safe_to_day: string;
}

/** Shared by the public payload and operator gauges; old publication is not
 * current merely because an immutable daily row still says 'published'. */
export function isCurrentCommunityAllowancePublication(
  state: CommunityAllowancePublicationStateRow | null | undefined,
  nowMs: number,
): boolean {
  return Number.isFinite(nowMs) && state?.publication_state === "ready"
    && state.expected_basis === COMMUNITY_ALLOWANCE_BASIS
    && state.attribution_method_version === COMMUNITY_ATTRIBUTION_METHOD_VERSION
    && state.safe_from_day === driftReconcileFromDay(nowMs)
    && state.safe_to_day === driftReconcileToDay(nowMs);
}

export interface PublishedCommunityDailyRead {
  rows: PublishedCommunityDailyAggregateRow[];
  allowancePublicationState: CommunityAllowancePublicationStateRow | null;
  allowanceBreakdownsCache: PublicAllowanceBreakdownsCacheRow | null;
}

interface PublishedCommunityDailyQueryRow {
  day: string | null;
  revision: number | null;
  payload_json: string | null;
  released_at: string | null;
  publication_state: "updating" | "ready" | null;
  expected_basis: string | null;
  attribution_method_version: string | null;
  safe_from_day: string | null;
  safe_to_day: string | null;
}

/**
 * One atomic read-only batch keeps requested publication, readiness, and preview
 * source epoch on the same snapshot. The bounded preview is read once, not
 * joined and repeated for every daily row. A sentinel LEFT JOIN preserves
 * activity when readiness is absent; callers fail allowance closed as updating.
 */
export async function readPublishedCommunityDailyAggregatesWithAllowanceState(
  db: D1Database,
  fromDay: string,
  toDay: string,
): Promise<PublishedCommunityDailyRead> {
  const dailyStatement = db.prepare(
    `WITH latest AS (
       SELECT day, MAX(revision) AS revision
         FROM community_daily_aggregates
        WHERE day >= ?1 AND day <= ?2 AND release_state = 'published'
        GROUP BY day
     ),
     requested AS (
       SELECT a.day, a.revision, a.payload_json, a.released_at
         FROM community_daily_aggregates a
         JOIN latest
           ON latest.day = a.day AND latest.revision = a.revision
        WHERE a.release_state = 'published'
     )
     SELECT requested.day,
            requested.revision,
            requested.payload_json,
            requested.released_at,
            state.publication_state,
            state.expected_basis,
            state.attribution_method_version,
            state.safe_from_day,
            state.safe_to_day
       FROM (SELECT 1 AS singleton) gate
       LEFT JOIN community_allowance_publication_state state
         ON state.singleton = gate.singleton
       LEFT JOIN requested ON 1 = 1
      ORDER BY requested.day ASC`,
  ).bind(fromDay, toDay);
  let queryRows: PublishedCommunityDailyQueryRow[];
  let allowanceBreakdownsCache: PublicAllowanceBreakdownsCacheRow | null = null;
  try {
    const previewStatement = db.prepare(
      `SELECT cache.generated_at, cache.payload_json
         FROM admin_community_allowance_preview_cache cache
         JOIN community_snapshot_mutation_control source
           ON source.singleton_id = 1
          AND cache.source_mutation_epoch = source.mutation_epoch
        WHERE cache.singleton = 1
          AND length(CAST(cache.payload_json AS BLOB)) <= ?1
          AND cache.attribution_method_version = ?2
        LIMIT 1`,
    ).bind(PREVIEW_CACHE_JSON_LIMIT_BYTES, COMMUNITY_ATTRIBUTION_METHOD_VERSION);
    const results = await db.batch<PublishedCommunityDailyQueryRow | PublicAllowanceBreakdownsCacheRow>([
      dailyStatement,
      previewStatement,
    ]);
    queryRows = (results[0]?.results ?? []).filter(
      (row): row is PublishedCommunityDailyQueryRow => "publication_state" in row,
    );
    const cache = results[1]?.results[0];
    if (cache && "generated_at" in cache
        && typeof cache.generated_at === "string"
        && typeof cache.payload_json === "string") {
      allowanceBreakdownsCache = {
        generated_at: cache.generated_at,
        payload_json: cache.payload_json,
      };
    }
  } catch {
    // An unavailable optional cache/schema cannot hide existing activity. This
    // fallback has no preview, so it cannot combine rows from different epochs.
    // An unavailable daily store still fails normally; no source work is tried.
    queryRows = (await dailyStatement.all<PublishedCommunityDailyQueryRow>()).results;
  }
  const first = queryRows[0];
  const allowancePublicationState = first?.publication_state !== null
      && first?.publication_state !== undefined
      && typeof first.expected_basis === "string"
      && typeof first.safe_from_day === "string"
      && typeof first.safe_to_day === "string"
    ? {
        publication_state: first.publication_state,
        expected_basis: first.expected_basis,
        attribution_method_version: first.attribution_method_version,
        safe_from_day: first.safe_from_day,
        safe_to_day: first.safe_to_day,
      }
    : null;
  const rows = queryRows.flatMap((row) => (
    typeof row.day === "string"
      && typeof row.revision === "number"
      && typeof row.payload_json === "string"
      && typeof row.released_at === "string"
      ? [{
          day: row.day,
          revision: row.revision,
          payload_json: row.payload_json,
          released_at: row.released_at,
        }]
      : []
  ));
  return { rows, allowancePublicationState, allowanceBreakdownsCache };
}

/**
 * The public daily read: for every day in the inclusive range, the highest
 * published revision. Days whose revisions are all withdrawn simply do not
 * appear — a withdrawal (participant deletion, 0031 trigger) must leave no
 * readable trace, and the pending rebuild republishes the day as the next
 * revision when its surviving sources allow.
 */
export async function readPublishedCommunityDailyAggregates(
  db: D1Database,
  fromDay: string,
  toDay: string,
): Promise<PublishedCommunityDailyAggregateRow[]> {
  const rows = await db.prepare(
    `SELECT a.day, a.revision, a.payload_json, a.released_at
       FROM community_daily_aggregates a
       JOIN (
         SELECT day, MAX(revision) AS revision
           FROM community_daily_aggregates
          WHERE day >= ? AND day <= ? AND release_state = 'published'
          GROUP BY day
       ) latest ON latest.day = a.day AND latest.revision = a.revision
      WHERE a.release_state = 'published'
      ORDER BY a.day ASC`,
  ).bind(fromDay, toDay).all<PublishedCommunityDailyAggregateRow>();
  return rows.results;
}
