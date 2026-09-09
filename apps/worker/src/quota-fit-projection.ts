import type {
  V1FitSourceRow,
  V1PlanSourceRow,
  V1QuotaPageReader,
  V1ResetCursor,
  V1TimeCursor,
} from "./quota-analysis-v1-reader";

export const V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE = 4_096;
export const V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES = 16;
const MAX_READER_PAGE_SIZE = 1_024;

interface BackfillState {
  through_record_id: number;
  last_record_id: number;
  is_complete: number;
}

export class V1QuotaFitProjectionUnavailableError extends Error {
  readonly code = "V1_QUOTA_FIT_PROJECTION_UNAVAILABLE";
  constructor() { super("v1 quota fit projection unavailable"); }
}

function validState(value: BackfillState | null): value is BackfillState {
  return value !== null && Number.isSafeInteger(value.through_record_id)
    && value.through_record_id >= 0 && Number.isSafeInteger(value.last_record_id)
    && value.last_record_id >= 0 && value.last_record_id <= value.through_record_id
    && (value.is_complete === 0 || value.is_complete === 1)
    && (value.is_complete === 0 || value.last_record_id === value.through_record_id);
}

const STATE_SQL = `SELECT through_record_id, last_record_id, is_complete
  FROM telemetry_v1_quota_fit_backfill WHERE singleton_id = 1`;

// LIMIT applies to canonical rowids BEFORE eligibility filtering. A page of
// usage-only or losing-device rows still advances, without scanning a prefix.
const BACKFILL_PAGE_SQL = `SELECT r.id, r.participant_id, r.resets_at, r.observed_at,
  r.stream, r.limit_id, r.window_duration_minutes, r.provider, r.plan_type,
  r.plan_variant, r.slot, r.used_percent
  FROM telemetry_v1_records r
  WHERE r.id > ?1 AND r.id <= ?2
    AND EXISTS (SELECT 1 FROM telemetry_v1_quota_fit_backfill
      WHERE singleton_id = 1 AND last_record_id = ?1
        AND through_record_id = ?2 AND is_complete = 0)
  ORDER BY r.id LIMIT ?3`;

export const V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL = `
  WITH page AS MATERIALIZED (${BACKFILL_PAGE_SQL})
  INSERT INTO telemetry_v1_quota_fit_rows
    (record_id, participant_id, resets_at, observed_at)
  SELECT r.id, r.participant_id, r.resets_at, r.observed_at FROM page r
  WHERE r.stream = 'quota' AND r.limit_id = 'codex'
    AND r.window_duration_minutes = 10080
    AND r.provider IS NOT NULL AND r.plan_type IS NOT NULL
    AND r.plan_variant IS NOT NULL AND r.resets_at IS NOT NULL
    AND r.slot IS NOT NULL AND r.used_percent IS NOT NULL
  ON CONFLICT(record_id) DO UPDATE SET participant_id = excluded.participant_id,
    resets_at = excluded.resets_at, observed_at = excluded.observed_at`;

export const V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL = `
  WITH next_cursor AS MATERIALIZED (
    SELECT COALESCE(MAX(id), ?2) AS id FROM (
      SELECT id FROM telemetry_v1_records WHERE id > ?1 AND id <= ?2
      ORDER BY id LIMIT ?3
    )
  )
  UPDATE telemetry_v1_quota_fit_backfill
  SET last_record_id = (SELECT id FROM next_cursor),
    is_complete = CASE WHEN (SELECT id FROM next_cursor) = through_record_id THEN 1 ELSE 0 END
  WHERE singleton_id = 1 AND last_record_id = ?1
    AND through_record_id = ?2 AND is_complete = 0`;

/**
 * Derived read-index construction only: no source writes, winner selection,
 * consent change, or partial-fit publication. D1.batch makes each page copy,
 * cursor CAS, and receipt atomic. Concurrent callers may observe another
 * caller's progress; neither can advance an un-copied range. Source mutation
 * triggers keep corrections/deletions and post-high-water inserts current.
 * No lease is required for this shared monotone cursor; callers still own
 * their invocation-wide query/time budget and scheduling authority.
 */
export async function backfillV1QuotaFitProjection(
  db: D1Database,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<{ status: "complete" | "deferred"; pagesRun: number; queriesUsed: number;
  lastRecordId: number; throughRecordId: number }> {
  const maxPages = options.maxPages ?? V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES;
  const pageSize = options.pageSize ?? V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE) {
    throw new TypeError("v1 quota projection backfill bound invalid");
  }
  let state = await db.prepare(STATE_SQL).first<BackfillState>();
  if (!validState(state)) throw new V1QuotaFitProjectionUnavailableError();
  let pagesRun = 0;
  while (state.is_complete === 0 && pagesRun < maxPages) {
    const previous: BackfillState = state;
    const results: D1Result<BackfillState>[] = await db.batch<BackfillState>([
      db.prepare(V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL)
        .bind(previous.last_record_id, previous.through_record_id, pageSize),
      db.prepare(V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL)
        .bind(previous.last_record_id, previous.through_record_id, pageSize),
      db.prepare(STATE_SQL),
    ]);
    state = results[2]?.results[0] ?? null;
    if (!validState(state) || state.through_record_id !== previous.through_record_id
        || state.last_record_id < previous.last_record_id
        || (state.is_complete === 0 && state.last_record_id === previous.last_record_id)) {
      throw new V1QuotaFitProjectionUnavailableError();
    }
    pagesRun += 1;
  }
  return { status: state.is_complete === 1 ? "complete" : "deferred", pagesRun,
    queriesUsed: 1 + pagesRun * 3, lastRecordId: state.last_record_id,
    throughRecordId: state.through_record_id };
}

// Explicit equal-time + id seek drains an arbitrarily large timestamp tie;
// the next-key seek does not revisit it. Only these bounded pages materialize.
function planQuotaPageSql(historical: boolean): string {
  const upperBound = historical ? " AND r.observed_at < ?5" : "";
  return `WITH same_time AS MATERIALIZED (
  SELECT r.id, r.observed_at, r.observed_day, r.device_id, r.provider,
    r.limit_id, r.plan_type, r.plan_variant
  FROM telemetry_v1_records r INDEXED BY telemetry_v1_records_participant_stream_observed
  WHERE r.participant_id = ?1 AND r.stream = 'quota' AND r.observed_at = ?2 AND r.id > ?3${upperBound}
  ORDER BY r.id LIMIT ?4
), later AS MATERIALIZED (
  SELECT r.id, r.observed_at, r.observed_day, r.device_id, r.provider,
    r.limit_id, r.plan_type, r.plan_variant
  FROM telemetry_v1_records r INDEXED BY telemetry_v1_records_participant_stream_observed
  WHERE r.participant_id = ?1 AND r.stream = 'quota' AND r.observed_at > ?2${upperBound}
  ORDER BY r.observed_at, r.id LIMIT (SELECT ?4 - COUNT(*) FROM same_time)
)
SELECT * FROM same_time UNION ALL SELECT * FROM later ORDER BY observed_at, id`;
}
export const V1_PLAN_QUOTA_PAGE_SQL = planQuotaPageSql(false);
export const V1_HISTORY_PLAN_QUOTA_PAGE_SQL = planQuotaPageSql(true);

export const V1_FIT_QUOTA_PAGE_SQL = `WITH same_key AS MATERIALIZED (
  SELECT p.record_id, p.resets_at, p.observed_at FROM telemetry_v1_quota_fit_rows p
    INDEXED BY telemetry_v1_quota_fit_rows_cursor
  WHERE p.participant_id = ?1 AND p.resets_at = ?2 AND p.observed_at = ?3 AND p.record_id > ?4
  ORDER BY p.record_id LIMIT ?5
), later AS MATERIALIZED (
  SELECT p.record_id, p.resets_at, p.observed_at FROM telemetry_v1_quota_fit_rows p
    INDEXED BY telemetry_v1_quota_fit_rows_cursor
  WHERE p.participant_id = ?1 AND (p.resets_at, p.observed_at) > (?2, ?3)
  ORDER BY p.resets_at, p.observed_at, p.record_id LIMIT (SELECT ?5 - COUNT(*) FROM same_key)
), page AS MATERIALIZED (
  SELECT * FROM same_key UNION ALL SELECT * FROM later
)
SELECT p.record_id AS id, p.resets_at AS projection_resets_at,
  p.observed_at AS projection_observed_at, r.participant_id AS source_participant_id,
  r.observed_at, r.observed_day, r.device_id, r.provider, r.limit_id,
  r.plan_type, r.plan_variant, r.occurrence_id, r.slot, r.used_percent,
  r.window_duration_minutes, r.resets_at
FROM page p LEFT JOIN telemetry_v1_records r ON r.id = p.record_id
ORDER BY p.resets_at, p.observed_at, p.record_id`;

function validatePage(cursor: V1TimeCursor, limit: number): void {
  if (typeof cursor.observedAt !== "string" || !Number.isSafeInteger(cursor.id) || cursor.id < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READER_PAGE_SIZE) {
    throw new TypeError("v1 quota projection page bound invalid");
  }
}

/** One upfront readiness query belongs to the caller's reserved budget. Each
 * callback then spends exactly one query and returns physical rows, including
 * losing-device and pre-cutoff rows. The acquisition engine applies residual
 * source filters and must retain its original/final source-pin fences.
 */
export async function createV1QuotaPageReader(db: D1Database, participantId: string,
  observedAtBefore?: string): Promise<V1QuotaPageReader> {
  if (typeof participantId !== "string" || participantId.length === 0) throw new TypeError("participant required");
  if (observedAtBefore !== undefined && (!Number.isFinite(Date.parse(observedAtBefore))
    || new Date(observedAtBefore).toISOString() !== observedAtBefore)) throw new TypeError("quota upper bound invalid");
  const ready = await db.prepare(`SELECT s.through_record_id, s.last_record_id, s.is_complete
    FROM telemetry_v1_quota_fit_backfill s JOIN participants p ON p.id = ? AND p.state = 'active'
    WHERE s.singleton_id = 1`).bind(participantId).first<BackfillState>();
  if (!validState(ready) || ready.is_complete !== 1) throw new V1QuotaFitProjectionUnavailableError();
  return {
    async readPlanPage(cursor, limit) {
      validatePage(cursor, limit);
      if (observedAtBefore !== undefined) {
        return (await db.prepare(V1_HISTORY_PLAN_QUOTA_PAGE_SQL)
          .bind(participantId, cursor.observedAt, cursor.id, limit, observedAtBefore).all<V1PlanSourceRow>()).results;
      }
      const result = await db.prepare(V1_PLAN_QUOTA_PAGE_SQL)
        .bind(participantId, cursor.observedAt, cursor.id, limit).all<V1PlanSourceRow>();
      return result.results;
    },
    async readFitPage(cursor: V1ResetCursor, limit) {
      // The reset-first index cannot seek an observed-time upper bound across
      // reset groups. Keep its physical LIMIT before residual filtering. The
      // acquisition's closed day-winner map excludes all future rows; even a
      // future-only page advances the cursor rather than pretending to be EOF.
      validatePage(cursor, limit);
      if (typeof cursor.resetsAt !== "string") throw new TypeError("reset cursor required");
      const result = await db.prepare(V1_FIT_QUOTA_PAGE_SQL)
        .bind(participantId, cursor.resetsAt, cursor.observedAt, cursor.id, limit)
        .all<V1FitSourceRow & { projection_resets_at: string; projection_observed_at: string;
          source_participant_id: string | null }>();
      return result.results.map(({ projection_resets_at, projection_observed_at, source_participant_id, ...row }) => {
        if (source_participant_id !== participantId || row.resets_at !== projection_resets_at
            || row.observed_at !== projection_observed_at) throw new V1QuotaFitProjectionUnavailableError();
        return row;
      });
    },
  };
}
