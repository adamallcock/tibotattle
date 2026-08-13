import { canonicalJson } from "./canonical-json";
import {
  collectCommunityAllowanceFits,
  summarizeCommunityAllowanceDay,
  summarizeCommunityCapacityByPlanType,
} from "./community-allowance";
import type { CommunityAllowanceFit } from "./community-allowance";
import { sha256Hex } from "./crypto";
import { V1_ANALYSIS_WINDOW_DAYS } from "./quota-analysis-v1";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The lowest UTC day the drift reconciler still reconciles, given the analyzer's
 * trailing read horizon. Days that age past it RETIRE (keep their last published
 * value) rather than churn to a null block every pass: the v1 analyzer reads
 * only the trailing horizon, so recomputing a long-aged day would find no
 * in-window fits and republish it empty, erasing the historical series. Bounding
 * the enumeration to the SAME horizon keeps the reconciler and the analyzer in
 * lockstep. (No regression today — the band is still all-null — but this must
 * land with the windowed read before the series grows long.)
 */
function driftReconcileFromDay(nowMs: number): string {
  return new Date(nowMs - V1_ANALYSIS_WINDOW_DAYS * MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Day-partitioned community aggregates for telemetry-contribution-v1.0
 * (docs/design/2026-08-07-incremental-contribution-model.md, section 4).
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
type AllowanceFitsForEpoch = (epoch: number) => Promise<CommunityAllowanceFit[]>;

function memoizedAllowanceFits(
  db: D1Database,
  nowMs: number,
): AllowanceFitsForEpoch {
  let cached: { epoch: number; fits: CommunityAllowanceFit[] } | null = null;
  return async (epoch: number) => {
    if (cached === null || cached.epoch !== epoch) {
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
): Promise<void> {
  const epochRow = await db.prepare(
    `SELECT mutation_epoch FROM community_snapshot_mutation_control
      WHERE singleton_id = 1`,
  ).first<{ mutation_epoch: number }>();
  const reconcileEpoch = Number(epochRow?.mutation_epoch);
  if (!Number.isSafeInteger(reconcileEpoch) || reconcileEpoch < 0) {
    throw new Error("community daily aggregate mutation control unavailable");
  }
  const fits = await allowanceFitsForEpoch(reconcileEpoch);
  // Reconcile only days inside the analyzer's trailing read horizon; aged days
  // keep their last published value instead of churning to a null block.
  const reconcileFromDay = driftReconcileFromDay(nowMs);
  const published = await db.prepare(
    `SELECT a.day, a.payload_json
       FROM community_daily_aggregates a
       JOIN (
         SELECT day, MAX(revision) AS revision
           FROM community_daily_aggregates
          WHERE release_state = 'published' AND day >= ?1
          GROUP BY day
       ) latest ON latest.day = a.day AND latest.revision = a.revision
      WHERE a.release_state = 'published' AND a.day >= ?1
      ORDER BY a.day ASC`,
  ).bind(reconcileFromDay).all<{ day: string; payload_json: string }>();
  const drifted: string[] = [];
  for (const row of published.results) {
    const expected = canonicalJson(
      summarizeCommunityAllowanceDay(fits, row.day),
    );
    let current: string | null = null;
    try {
      const payload = JSON.parse(row.payload_json) as { allowance?: unknown };
      if (payload.allowance !== undefined) {
        current = canonicalJson(payload.allowance);
      }
    } catch {
      current = null;
    }
    if (current !== expected) drifted.push(row.day);
  }
  for (const day of drifted) {
    await db.prepare(
      `INSERT INTO community_daily_aggregate_rebuilds (
        day, requested_epoch, requested_at
      ) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(day) DO UPDATE SET
        requested_epoch = excluded.requested_epoch,
        requested_at = excluded.requested_at`,
    ).bind(day, reconcileEpoch).run();
  }
}

/**
 * Cross-device dedupe: for one participant and one day, count that day's
 * records exactly once.
 *
 * Sync state and chunk supersession are per-(participant, device), so a
 * participant whose device credential is irrecoverably lost re-pairs a fresh
 * device that reads an empty per-device cursor and re-uploads its entire
 * history — while the lost device's chunks stay current forever. Devices are
 * an upload transport, not a data partition: two devices of one participant
 * observe the SAME underlying local index, so summing records across devices
 * would double-count every overlapping day. The honest general rule applied
 * here: per (participant, day), aggregate only the records of the winning
 * device — the device whose current chunks holding records for that day have
 * the newest created_at (freshest evidence wins, across all streams), with a
 * deterministic tiebreak on the larger device_id. Records only ever belong
 * to current chunks (supersession deletes the superseded revision's records
 * in the same transaction), so joining records to their owning chunk is the
 * exact current-evidence set. The rule is self-healing and direction-free: a
 * newer upload by ANY device of the participant flips the winner at the next
 * rebuild, and a single-device participant is always its own winner, leaving
 * single-device aggregation unchanged.
 */
const WINNING_DEVICE_CTE = `
  WITH day_device_evidence AS (
    SELECT r.participant_id AS participant_id,
           r.device_id AS device_id,
           MAX(c.created_at) AS newest_chunk_created_at
      FROM telemetry_v1_records r
      JOIN telemetry_v1_chunks c ON c.id = r.chunk_row_id
     WHERE r.observed_day = ?
     GROUP BY r.participant_id, r.device_id
  ),
  winning_devices AS (
    SELECT participant_id, device_id
      FROM day_device_evidence winner
     WHERE NOT EXISTS (
       SELECT 1 FROM day_device_evidence rival
        WHERE rival.participant_id = winner.participant_id
          AND (
            rival.newest_chunk_created_at > winner.newest_chunk_created_at
            OR (
              rival.newest_chunk_created_at = winner.newest_chunk_created_at
              AND rival.device_id > winner.device_id
            )
          )
     )
  )`;

async function buildCommunityDailyAggregate(
  db: D1Database,
  rebuild: DailyRebuildRow,
  scheduledTime: number,
  allowanceFitsForEpoch: AllowanceFitsForEpoch,
): Promise<{ state: "built" | "conflicted"; aggregateId: string }> {
  const { day } = rebuild;
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
  const [totals, cells, revisionRow] = await Promise.all([
    // contributing_devices deliberately counts only winning devices — the
    // devices whose records the published numbers actually include (one per
    // participant per day). A losing transport duplicate is not a
    // contribution.
    db.prepare(
      `${WINNING_DEVICE_CTE}
      SELECT
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
       FROM telemetry_v1_records r
       JOIN winning_devices w
         ON w.participant_id = r.participant_id
        AND w.device_id = r.device_id
       JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE r.observed_day = ?`,
    ).bind(day, day).first<DailyTotalsRow>(),
    db.prepare(
      `${WINNING_DEVICE_CTE}
      SELECT r.provider, r.model_id,
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
       FROM telemetry_v1_records r
       JOIN winning_devices w
         ON w.participant_id = r.participant_id
        AND w.device_id = r.device_id
       JOIN participants p ON p.id = r.participant_id AND p.state = 'active'
       WHERE r.observed_day = ? AND r.stream = 'usage'
       GROUP BY r.provider, r.model_id
       ORDER BY r.provider, r.model_id
       LIMIT ?`,
    ).bind(day, day, MAX_DAILY_AGGREGATE_CELLS + 1).all<DailyCellRow>(),
    db.prepare(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
         FROM community_daily_aggregates WHERE day = ?`,
    ).bind(day).first<{ revision: number }>(),
  ]);
  const revision = Number(revisionRow?.revision ?? 1);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("invalid community daily aggregate revision");
  }
  // The allowance block is additive on schema v1.0: the site normalizer
  // treats a missing or invalid block as per-day-absent, so older published
  // revisions without it stay renderable and old clients ignore it entirely.
  const fits = await allowanceFitsForEpoch(buildEpoch);
  const allowance = summarizeCommunityAllowanceDay(fits, day);
  // Additive per-plan_type capacity monitor: median observed capacity per plan
  // over the same window, so the pro:prolite:plus ratios can be watched against
  // the stated multipliers (pro = 20x, prolite = 5x). Rides the same fits and
  // the same drift rebuild; read-side observability only, never gates the band.
  const capacityByPlanType = summarizeCommunityCapacityByPlanType(fits, day);
  const aggregateId = `community-daily:${day}:r${revision}`;
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
    allowance,
    capacityByPlanType,
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
      )`,
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
    ),
    // Clear exactly the request this build answered, and only when this
    // build's revision actually published. A cancelled build leaves the row
    // queued for the next pass; a concurrent arrival upserts a fresh
    // requested_at and the delete no-ops — convergent, never lossy.
    db.prepare(
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
    ),
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
): Promise<{ processed: number; remaining: boolean; aggregateIds: string[] }> {
  if (!Number.isFinite(scheduledTime)
      || !Number.isSafeInteger(maximumRebuilds)
      || maximumRebuilds < 1
      || maximumRebuilds > 48) {
    throw new Error("invalid community daily aggregate rebuild request");
  }
  const allowanceFitsForEpoch = memoizedAllowanceFits(db, scheduledTime);
  // Reconcile before draining, so days a late v0.2 contribution drifted are
  // enqueued in time for this same pass to rebuild them.
  await enqueueCommunityAllowanceDriftRebuilds(
    db, allowanceFitsForEpoch, scheduledTime,
  );
  const rows = await db.prepare(
    `SELECT day, requested_epoch, requested_at
       FROM community_daily_aggregate_rebuilds
      ORDER BY day ASC
      LIMIT ?`,
  ).bind(maximumRebuilds + 1).all<DailyRebuildRow>();
  const aggregateIds: string[] = [];
  let processed = 0;
  for (const row of rows.results.slice(0, maximumRebuilds)) {
    const result = await buildCommunityDailyAggregate(
      db,
      row,
      scheduledTime,
      allowanceFitsForEpoch,
    );
    processed += 1;
    aggregateIds.push(result.aggregateId);
  }
  const pending = await db.prepare(
    "SELECT 1 AS pending FROM community_daily_aggregate_rebuilds LIMIT 1",
  ).first<{ pending: number }>();
  return { processed, remaining: Boolean(pending), aggregateIds };
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
