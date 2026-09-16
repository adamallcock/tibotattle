import {
  V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES,
  V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE,
  V1QuotaFitProjectionUnavailableError,
} from "./quota-fit-projection-contract";
import type {
  V1FitSourceRow,
  V1PlanSourceRow,
  V1QuotaPageReader,
  V1ResetCursor,
  V1TimeCursor,
} from "./quota-analysis-v1-reader";
import type {
  PostgresTelemetryV1Client,
  PostgresTelemetryV1Pool,
  PostgresTelemetryV1QueryResult,
} from "./postgres-telemetry-v1-contribution-store";

const SCHEMA = "tibotattle_v1_test";
const MAX_READER_PAGE_SIZE = 1_024;

const STATE_SQL = `SELECT through_record_id, last_record_id, is_complete
  FROM ${SCHEMA}.telemetry_v1_quota_fit_backfill WHERE singleton_id = 1`;

// LIMIT is applied to canonical rows before eligibility filtering. Ineligible
// and losing-device rows therefore advance the finite source high-water page.
// FOR SHARE keeps a source correction/deletion from committing between this
// snapshot and the projection upsert; its trigger then owns the post-copy
// mutation once this bounded transaction commits.
export const POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL = `
  WITH page AS MATERIALIZED (
    SELECT r.id, r.participant_id, r.resets_at,
      r.observed_at
    FROM ${SCHEMA}.records r
    WHERE r.id > $1 AND r.id <= $2
      AND EXISTS (SELECT 1 FROM ${SCHEMA}.telemetry_v1_quota_fit_backfill
        WHERE singleton_id = 1 AND last_record_id = $1
          AND through_record_id = $2 AND is_complete = 0)
    ORDER BY r.id LIMIT $3
    FOR SHARE OF r
  )
  INSERT INTO ${SCHEMA}.telemetry_v1_quota_fit_rows
    (record_id, participant_id, resets_at, observed_at)
  SELECT r.id, r.participant_id, r.resets_at, r.observed_at
  FROM page r
  WHERE EXISTS (
    SELECT 1 FROM ${SCHEMA}.records source
    WHERE source.id = r.id AND source.stream = 'quota'
      AND source.limit_id = 'codex'
      AND source.window_duration_minutes = 10080
      AND source.provider IS NOT NULL
      AND source.plan_type IS NOT NULL
      AND source.plan_variant IS NOT NULL
      AND source.resets_at IS NOT NULL
      AND source.slot IS NOT NULL
      AND source.used_percent IS NOT NULL
  )
  ON CONFLICT(record_id) DO UPDATE SET participant_id = EXCLUDED.participant_id,
    resets_at = EXCLUDED.resets_at, observed_at = EXCLUDED.observed_at`;

export const POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL = `
  WITH next_cursor AS MATERIALIZED (
    SELECT COALESCE(MAX(id), $2) AS id FROM (
      SELECT id FROM ${SCHEMA}.records WHERE id > $1 AND id <= $2
      ORDER BY id LIMIT $3
    ) page
  )
  UPDATE ${SCHEMA}.telemetry_v1_quota_fit_backfill
  SET last_record_id = (SELECT id FROM next_cursor),
      is_complete = CASE WHEN (SELECT id FROM next_cursor) = through_record_id THEN 1 ELSE 0 END
  WHERE singleton_id = 1 AND last_record_id = $1
    AND through_record_id = $2 AND is_complete = 0`;

function unsupported(): V1QuotaFitProjectionUnavailableError {
  return new V1QuotaFitProjectionUnavailableError();
}

function safeInteger(value: unknown, minimum = 0): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= minimum) return value;
  } else if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= minimum) return parsed;
  }
  throw unsupported();
}

function instant(value: unknown, allowEmpty = false): string {
  if (allowEmpty && value === "") return "";
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw unsupported();
  const canonical = new Date(value).toISOString();
  if (canonical !== value) throw unsupported();
  return value;
}

function day(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
      || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) throw unsupported();
  return value;
}

function text(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw unsupported();
  return value;
}

function numericPercent(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw unsupported();
  return parsed;
}

interface BackfillState {
  through_record_id: unknown;
  last_record_id: unknown;
  is_complete: unknown;
}

interface ValidBackfillState {
  throughRecordId: number;
  lastRecordId: number;
  isComplete: 0 | 1;
}

function decodeState(result: PostgresTelemetryV1QueryResult): ValidBackfillState {
  if (!Array.isArray(result.rows) || result.rowCount !== result.rows.length || result.rows.length !== 1) {
    throw unsupported();
  }
  const row = result.rows[0] as BackfillState | undefined;
  if (!row) throw unsupported();
  const throughRecordId = safeInteger(row.through_record_id);
  const lastRecordId = safeInteger(row.last_record_id);
  const isComplete = safeInteger(row.is_complete) as 0 | 1;
  if ((isComplete !== 0 && isComplete !== 1) || lastRecordId > throughRecordId
      || (isComplete === 1 && lastRecordId !== throughRecordId)) throw unsupported();
  return { throughRecordId, lastRecordId, isComplete };
}

function validateBackfillOptions(options: { maxPages?: number; pageSize?: number }) {
  const maxPages = options.maxPages ?? V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES;
  const pageSize = options.pageSize ?? V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > V1_QUOTA_PROJECTION_BACKFILL_MAX_PAGES
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > V1_QUOTA_PROJECTION_BACKFILL_PAGE_SIZE) {
    throw new TypeError("v1 quota projection backfill bound invalid");
  }
  return { maxPages, pageSize };
}

async function connect(pool: PostgresTelemetryV1Pool): Promise<PostgresTelemetryV1Client> {
  try {
    return await pool.connect();
  } catch {
    throw unsupported();
  }
}

async function release(client: PostgresTelemetryV1Client, discard: boolean): Promise<boolean> {
  try {
    await client.release(discard);
    return true;
  } catch {
    return false;
  }
}

async function readOne<T>(
  pool: PostgresTelemetryV1Pool,
  sql: string,
  values: unknown[],
  decode: (result: PostgresTelemetryV1QueryResult) => T,
): Promise<T> {
  const client = await connect(pool);
  let result: T;
  try {
    result = decode(await client.query(sql, values));
  } catch {
    // A failed query/decode may leave the connection in an unknown state.
    // Release exactly once and discard it; provider details stay private.
    await release(client, true);
    throw unsupported();
  }
  if (!await release(client, false)) throw unsupported();
  return result;
}

async function readState(pool: PostgresTelemetryV1Pool): Promise<ValidBackfillState> {
  return readOne(pool, STATE_SQL, [], decodeState);
}

async function pageTransaction(
  pool: PostgresTelemetryV1Pool,
  previous: ValidBackfillState,
  pageSize: number,
): Promise<ValidBackfillState> {
  const client = await connect(pool);
  let transactionOpen = false;
  let commitAttempted = false;
  let state: ValidBackfillState;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL statement_timeout='10s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_INSERT_SQL,
      [previous.lastRecordId, previous.throughRecordId, pageSize]);
    await client.query(POSTGRES_V1_QUOTA_PROJECTION_BACKFILL_ADVANCE_SQL,
      [previous.lastRecordId, previous.throughRecordId, pageSize]);
    state = decodeState(await client.query(STATE_SQL));
    commitAttempted = true;
    await client.query("COMMIT");
    transactionOpen = false;
  } catch {
    if (transactionOpen && !commitAttempted) {
      let rollbackSucceeded = false;
      try {
        await client.query("ROLLBACK");
        rollbackSucceeded = true;
      } catch { /* discard below */ }
      await release(client, !rollbackSucceeded);
    } else {
      // A failed COMMIT is ambiguous; discard rather than returning an
      // uncertain connection to the pool. This is the only release here.
      await release(client, true);
    }
    throw unsupported();
  }
  if (!await release(client, false)) throw unsupported();
  return state!;
}

/** Bounded, resumable PostgreSQL equivalent of backfillV1QuotaFitProjection. */
export async function backfillPostgresV1QuotaFitProjection(
  pool: PostgresTelemetryV1Pool,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<{ status: "complete" | "deferred"; pagesRun: number; queriesUsed: number;
  lastRecordId: number; throughRecordId: number }> {
  const { maxPages, pageSize } = validateBackfillOptions(options);
  let state = await readState(pool);
  let pagesRun = 0;
  while (state.isComplete === 0 && pagesRun < maxPages) {
    const previous = state;
    state = await pageTransaction(pool, previous, pageSize);
    if (state.throughRecordId !== previous.throughRecordId
        || state.lastRecordId < previous.lastRecordId
        || (state.isComplete === 0 && state.lastRecordId === previous.lastRecordId)) {
      throw unsupported();
    }
    pagesRun += 1;
  }
  return {
    status: state.isComplete === 1 ? "complete" : "deferred",
    pagesRun,
    queriesUsed: 1 + pagesRun * 3,
    lastRecordId: state.lastRecordId,
    throughRecordId: state.throughRecordId,
  };
}

function validatePage(cursor: V1TimeCursor, limit: number): void {
  if (typeof cursor.observedAt !== "string" || !Number.isSafeInteger(cursor.id) || cursor.id < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READER_PAGE_SIZE) {
    throw new TypeError("v1 quota projection page bound invalid");
  }
}

function validUpperBound(value: string | undefined): void {
  if (value !== undefined) instant(value);
}

function planRow(row: Record<string, unknown>): V1PlanSourceRow {
  const stream = row.stream;
  if (stream !== "quota") throw unsupported();
  const provider = text(row.provider, true);
  const limitId = text(row.limit_id, true);
  const planType = text(row.plan_type, true);
  const planVariant = text(row.plan_variant, true);
  return {
    id: safeInteger(row.id), observed_at: instant(row.observed_at), observed_day: day(row.observed_day),
    device_id: text(row.device_id)!, provider, limit_id: limitId, plan_type: planType, plan_variant: planVariant,
  };
}

function fitRow(row: Record<string, unknown>): V1FitSourceRow {
  const sourceParticipant = row.source_participant_id;
  if (sourceParticipant === null || typeof sourceParticipant !== "string" || sourceParticipant.length === 0) {
    throw unsupported();
  }
  const stream = row.stream;
  if (stream !== "quota") throw unsupported();
  const provider = text(row.provider);
  const limitId = text(row.limit_id);
  const planType = text(row.plan_type);
  const planVariant = text(row.plan_variant);
  const slot = text(row.slot);
  const resetsAt = instant(row.resets_at);
  return {
    id: safeInteger(row.id), observed_at: instant(row.observed_at), observed_day: day(row.observed_day),
    device_id: text(row.device_id)!, provider: provider!, limit_id: limitId!, plan_type: planType!,
    plan_variant: planVariant!, occurrence_id: text(row.occurrence_id)!, slot: slot!,
    used_percent: numericPercent(row.used_percent),
    window_duration_minutes: safeInteger(row.window_duration_minutes, 1), resets_at: resetsAt,
  };
}

function planSql(historical: boolean): string {
  const cutoff = historical ? " AND r.observed_at < NULLIF($5, '')::timestamptz" : "";
  return `WITH same_time AS MATERIALIZED (
  SELECT r.id, to_char(r.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
    to_char((r.observed_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS observed_day, r.device_id,
    r.provider, r.limit_id, r.plan_type, r.plan_variant, r.stream
  FROM ${SCHEMA}.records r
  WHERE r.participant_id = $1 AND r.stream = 'quota'
    AND NULLIF($2, '')::timestamptz IS NOT NULL
    AND r.observed_at = NULLIF($2, '')::timestamptz AND r.id > $3${cutoff}
    ORDER BY r.id LIMIT $4
), later AS MATERIALIZED (
  SELECT r.id, to_char(r.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
    to_char((r.observed_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS observed_day, r.device_id,
    r.provider, r.limit_id, r.plan_type, r.plan_variant, r.stream
  FROM ${SCHEMA}.records r
  WHERE r.participant_id = $1 AND r.stream = 'quota'
    AND (NULLIF($2, '')::timestamptz IS NULL OR r.observed_at > NULLIF($2, '')::timestamptz)${cutoff}
    ORDER BY r.observed_at, r.id LIMIT GREATEST(0, $4 - (SELECT COUNT(*) FROM same_time))
)
SELECT * FROM same_time UNION ALL SELECT * FROM later ORDER BY observed_at, id`;
}

const PLAN_SQL = planSql(false);
const HISTORY_PLAN_SQL = planSql(true);

const FIT_SQL = `WITH same_key AS MATERIALIZED (
  SELECT p.record_id, p.resets_at, p.observed_at
  FROM ${SCHEMA}.telemetry_v1_quota_fit_rows p
  WHERE p.participant_id = $1 AND NULLIF($2, '')::timestamptz IS NOT NULL
    AND p.resets_at = NULLIF($2, '')::timestamptz
    AND p.observed_at = NULLIF($3, '')::timestamptz AND p.record_id > $4
  ORDER BY p.record_id LIMIT $5
), later AS MATERIALIZED (
  SELECT p.record_id, p.resets_at, p.observed_at
  FROM ${SCHEMA}.telemetry_v1_quota_fit_rows p
  WHERE p.participant_id = $1
    AND (NULLIF($2, '')::timestamptz IS NULL OR p.resets_at > NULLIF($2, '')::timestamptz
      OR (p.resets_at = NULLIF($2, '')::timestamptz
        AND (NULLIF($3, '')::timestamptz IS NULL OR p.observed_at > NULLIF($3, '')::timestamptz)))
  ORDER BY p.resets_at, p.observed_at, p.record_id
  LIMIT GREATEST(0, $5 - (SELECT COUNT(*) FROM same_key))
), page AS MATERIALIZED (
  SELECT * FROM same_key UNION ALL SELECT * FROM later
)
SELECT p.record_id AS id,
  to_char(p.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS projection_resets_at,
  to_char(p.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS projection_observed_at,
  r.participant_id AS source_participant_id,
  to_char(r.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
  to_char((r.observed_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS observed_day, r.device_id,
  r.provider, r.limit_id, r.plan_type, r.plan_variant,
  r.occurrence_id, r.slot, r.used_percent, r.window_duration_minutes,
  to_char(r.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resets_at,
  r.stream
FROM page p LEFT JOIN ${SCHEMA}.records r ON r.id = p.record_id
ORDER BY p.resets_at, p.observed_at, p.record_id`;

async function readiness(pool: PostgresTelemetryV1Pool, participantId: string): Promise<void> {
  await readOne(pool, `SELECT b.through_record_id, b.last_record_id, b.is_complete
    FROM ${SCHEMA}.telemetry_v1_quota_fit_backfill b
    JOIN ${SCHEMA}.participants p ON p.id = $1 AND p.state = 'active'
    WHERE b.singleton_id = 1`, [participantId], result => {
    const state = decodeState(result);
    if (state.isComplete !== 1) throw unsupported();
    return undefined;
  });
}

/**
 * One readiness query plus one bounded raw-source query per callback. This
 * qualification adapter does not implement the separate prepared-source
 * 128-row protocol or claim prepared projection parity.
 */
export async function createPostgresV1QuotaPageReader(
  pool: PostgresTelemetryV1Pool,
  participantId: string,
  observedAtBefore?: string,
): Promise<V1QuotaPageReader> {
  if (typeof participantId !== "string" || participantId.length === 0) throw new TypeError("participant required");
  validUpperBound(observedAtBefore);
  await readiness(pool, participantId);
  return {
    async readPlanPage(cursor, limit) {
      validatePage(cursor, limit);
      const sql = observedAtBefore === undefined ? PLAN_SQL : HISTORY_PLAN_SQL;
      const values = observedAtBefore === undefined
        ? [participantId, cursor.observedAt, cursor.id, limit]
        : [participantId, cursor.observedAt, cursor.id, limit, observedAtBefore];
      const result = await readOne(pool, sql, values, value => value);
      if (result.rows.length > limit) throw unsupported();
      return result.rows.map(planRow);
    },
    async readFitPage(cursor: V1ResetCursor, limit) {
      validatePage(cursor, limit);
      if (typeof cursor.resetsAt !== "string") throw new TypeError("reset cursor required");
      const result = await readOne(pool, FIT_SQL,
        [participantId, cursor.resetsAt, cursor.observedAt, cursor.id, limit], value => value);
      if (result.rows.length > limit) throw unsupported();
      return result.rows.map(row => {
        const sourceParticipant = row.source_participant_id;
        const projectionResetsAt = instant(row.projection_resets_at);
        const projectionObservedAt = instant(row.projection_observed_at);
        if (sourceParticipant !== participantId || row.resets_at !== projectionResetsAt
            || row.observed_at !== projectionObservedAt) throw unsupported();
        return fitRow(row);
      });
    },
  };
}

// Explicit qualification alias for callers that name experimental adapters.
export const createExperimentalPostgresV1QuotaPageReader = createPostgresV1QuotaPageReader;
