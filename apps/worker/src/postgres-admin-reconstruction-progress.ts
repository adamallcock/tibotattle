/**
 * Aggregate-only full-refresh evidence for the GCP admin console (v4).
 * Origin composition only: never imported by the analytics compute closure.
 * One bounded REPEATABLE READ READ ONLY snapshot; no payloads or identifiers
 * leave PostgreSQL. Queue semantics mirror analytics-v2/queued-days.ts and
 * postgres-admin-overview.ts, including replaced v1.1 days, v1.2 manifest
 * differences and terminal events contributing no day on this owner line.
 *
 * Runs become visible only with the publication transaction's commit. Neither
 * a running job nor an unrecorded failure is observable here. The next nominal
 * 03:00 UTC slot is the owner's cadence, not scheduler health or an ETA.
 */
import { ApiError } from "./errors";
import { quotePostgresIdentifier, withPostgresRead, type PostgresPool } from "./postgres-client";

const MAX_EVENTS = 100_000;
const MAX_DAYS = 10_000;
const MAX_SOURCE_ROWS = 100_000;
const UNAVAILABLE = Object.freeze({ status: "unavailable" } as const);
type Row = Record<string, unknown>;

export interface PostgresAdminReconstructionProgress {
  schemaVersion: 4;
  generatedAt: string;
  pipeline: {
    ingestion: { journalHead: number | null; latestRecordedAt: string | null;
      v12Heads: number | null; v12Days: number | null; pendingActivations: number | null };
    delivery: { appliedSequence: number | null; pendingChanges: number | null;
      pendingOwnerActivations: number | null; current: typeof UNAVAILABLE };
    daily: { queuedDays: number | null; oldestQueuedDay: string | null;
      newestQueuedDay: string | null; lastReleasedAt: string | null; releasedLastHour: number };
  };
  publication: { publishedDays: number; latestEvidenceDay: string | null;
    preview: { state: "recorded" | "unavailable" | "not_recorded"; computedAt: string | null } };
  work: { currentState: "unavailable";
    lastRun: { state: "complete" | "failed"; startedAt: string; finishedAt: string;
      kernelId: number | null; owners: number; ownerDays: number } | null;
    nextScheduledAt: string; scheduleState: "unavailable" };
  history: typeof UNAVAILABLE;
  graph: typeof UNAVAILABLE;
}

function fail(): never { throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"); }
function count(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value))) fail();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) fail();
  return result;
}
const bounded = (value: unknown, maximum = MAX_SOURCE_ROWS): number | null => {
  const result = count(value);
  return result > maximum ? null : result;
};
function time(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail();
  return new Date(value).toISOString();
}
const nullableTime = (value: unknown): string | null => value === null ? null : time(value);
const iso = (expression: string): string =>
  `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** This query reads at most MAX_EVENTS+1 journal rows, then aggregates the
 * exact queue producers entirely in SQL. A cap never becomes a smaller total.
 * No event/owner/generation identifiers cross the client query boundary. */
function queueSql(s: string): string {
  return `WITH changes AS MATERIALIZED (
    SELECT change.sequence, change.event_digest, change.owner_digest, change.kind
      FROM ${s}.storage_ingestion_changes change
      JOIN ${s}.storage_source_state source ON source.singleton=1 AND source.source_id=change.source_id
     WHERE change.sequence>$1 ORDER BY change.sequence LIMIT $2
  ), v1_days AS (
    SELECT chunk.chunk_day AS day FROM changes
      JOIN ${s}.typed_v1_event_sources event ON event.event_digest=changes.event_digest
        AND event.owner_digest=changes.owner_digest
      JOIN ${s}.telemetry_v1_chunks chunk ON chunk.id=event.chunk_id
     WHERE changes.kind NOT IN ('owner-withdrawn','owner-erased')
  ), v11_days AS (
    SELECT domain_day.observed_day AS day FROM changes
      JOIN ${s}.storage_v11_event_sources event ON event.event_digest=changes.event_digest
        AND event.owner_digest=changes.owner_digest
      JOIN ${s}.telemetry_v11_domains generation ON generation.id=event.generation_id
      JOIN ${s}.telemetry_v11_domain_days domain_day
        ON domain_day.generation_id IN (generation.id,generation.previous_generation_id)
     WHERE changes.kind NOT IN ('owner-withdrawn','owner-erased')
  ), v12_pairs AS (
    SELECT event.generation_id,event.previous_generation_id FROM changes
      JOIN ${s}.storage_v12_event_sources event ON event.event_digest=changes.event_digest
        AND event.owner_digest=changes.owner_digest
     WHERE changes.kind NOT IN ('owner-withdrawn','owner-erased')
  ), v12_days AS (
    SELECT changed.observed_day AS day FROM v12_pairs pair CROSS JOIN LATERAL (
      (SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days WHERE generation_id=pair.generation_id
       EXCEPT SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days WHERE generation_id=pair.previous_generation_id)
      UNION
      (SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days WHERE generation_id=pair.previous_generation_id
       EXCEPT SELECT observed_day,manifest_digest FROM ${s}.telemetry_v12_domain_days WHERE generation_id=pair.generation_id)
    ) changed
  ), days AS MATERIALIZED (
    SELECT day FROM (SELECT day FROM v1_days UNION SELECT day FROM v11_days UNION SELECT day FROM v12_days) queued LIMIT $3
  ) SELECT (SELECT count(*)::text FROM changes) AS pending_changes,
    (SELECT count(*)::text FROM changes WHERE kind='owner-active') AS pending_activations,
    count(*)::text AS queued_days, to_char(min(day),'YYYY-MM-DD') AS oldest_day,
    to_char(max(day),'YYYY-MM-DD') AS newest_day FROM days`;
}

export async function readPostgresAdminReconstructionProgress(input: {
  pool: PostgresPool; schema: string; nowEpoch: number; includePreparation?: boolean;
}): Promise<PostgresAdminReconstructionProgress> {
  const { pool, schema, nowEpoch } = input;
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0 || !Number.isFinite(new Date(nowEpoch).getTime())) fail();
  const s = quotePostgresIdentifier(schema);
  const generatedAt = new Date(nowEpoch).toISOString();
  const nextSlot = new Date(nowEpoch);
  nextSlot.setUTCHours(3, 0, 0, 0);
  if (nextSlot.getTime() <= nowEpoch) nextSlot.setUTCDate(nextSlot.getUTCDate() + 1);
  try {
    return await withPostgresRead(pool, async (client) => {
      const row = async (sql: string, values?: unknown[]): Promise<Row> => {
        const result = await client.query(sql, values);
        if (result.rows.length !== 1) fail();
        return result.rows[0]!;
      };
      const source = await row(`SELECT count(*)::text AS sources FROM ${s}.storage_source_state WHERE singleton=1`);
      if (count(source.sources) !== 1) fail();
      const metadata = await row(`WITH predecessors AS MATERIALIZED (
        SELECT consumed_at, expires_at FROM ${s}.telemetry_v12_domain_predecessors LIMIT $1
      ) SELECT
        (SELECT change.sequence::text FROM ${s}.storage_ingestion_changes change
          JOIN ${s}.storage_source_state source ON source.singleton=1 AND source.source_id=change.source_id
          ORDER BY change.sequence DESC LIMIT 1) AS head,
        (SELECT change.recorded_ms::text FROM ${s}.storage_ingestion_changes change
          JOIN ${s}.storage_source_state source ON source.singleton=1 AND source.source_id=change.source_id
          ORDER BY change.sequence DESC LIMIT 1) AS recorded_ms,
        (SELECT last_sequence::text FROM ${s}.analytics_v2_journal_cursor WHERE id=1) AS cursor,
        (SELECT count(*)::text FROM (SELECT 1 FROM ${s}.telemetry_v12_domain_heads LIMIT $1) heads) AS v12_heads,
        (SELECT count(*)::text FROM (SELECT 1 FROM ${s}.telemetry_v12_domain_days LIMIT $1) days) AS v12_days,
        (SELECT count(*)::text FROM predecessors) AS activation_rows,
        (SELECT count(*)::text FROM predecessors WHERE consumed_at IS NULL AND expires_at>$2::timestamptz) AS activations`,
      [MAX_SOURCE_ROWS + 1, generatedAt]);
      const head = metadata.head === null ? null : count(metadata.head);
      let cursor: number | null = null;
      try {
        if (metadata.cursor !== null) cursor = count(metadata.cursor);
        if (cursor !== null && cursor > (head ?? 0)) cursor = null;
      } catch { cursor = null; }
      const queue = cursor === null ? null : await row(queueSql(s), [cursor, MAX_EVENTS + 1, MAX_DAYS + 1]);
      const pendingChanges = queue === null ? null : bounded(queue.pending_changes, MAX_EVENTS);
      const queuedDays = queue === null || pendingChanges === null ? null : bounded(queue.queued_days, MAX_DAYS);
      const daily = await row(`SELECT count(*)::text AS published_days,
        to_char(max(day),'YYYY-MM-DD') AS latest_day, ${iso("max(released_at)")} AS last_released_at,
        count(*) FILTER (WHERE released_at >= $1::timestamptz AND released_at <= $2::timestamptz)::text AS released_last_hour
        FROM ${s}.analytics_v2_published_daily`, [new Date(nowEpoch - 3_600_000).toISOString(), generatedAt]);
      const previews = await client.query(`SELECT preview IS NOT NULL AS available,
        ${iso("computed_at")} AS computed_at FROM ${s}.analytics_v2_preview WHERE id=1`);
      const preview = previews.rows[0];
      const runs = await client.query(`SELECT state, ${iso("started_at")} AS started_at,
        ${iso("finished_at")} AS finished_at, kernel_id, owners, owner_days
        FROM ${s}.analytics_v2_runs ORDER BY finished_at DESC, started_at DESC LIMIT 1`);
      const run = runs.rows[0];
      let lastRun: PostgresAdminReconstructionProgress["work"]["lastRun"] = null;
      if (run) {
        if (run.state !== "complete" && run.state !== "failed") fail();
        const startedAt = time(run.started_at), finishedAt = time(run.finished_at);
        if (finishedAt < startedAt) fail();
        const kernelId = run.kernel_id === null ? null : count(run.kernel_id);
        if (kernelId === 0) fail();
        lastRun = { state: run.state, startedAt, finishedAt, kernelId,
          owners: count(run.owners), ownerDays: count(run.owner_days) };
      }
      const recorded = metadata.recorded_ms === null ? null : count(metadata.recorded_ms);
      if (recorded !== null && !Number.isFinite(new Date(recorded).getTime())) fail();
      return {
        schemaVersion: 4, generatedAt,
        pipeline: {
          ingestion: { journalHead: head, latestRecordedAt: recorded === null ? null : new Date(recorded).toISOString(),
            v12Heads: bounded(metadata.v12_heads), v12Days: bounded(metadata.v12_days),
            pendingActivations: bounded(metadata.activation_rows) === null ? null : count(metadata.activations) },
          delivery: { appliedSequence: cursor, pendingChanges,
            pendingOwnerActivations: pendingChanges === null ? null : count(queue!.pending_activations), current: UNAVAILABLE },
          daily: { queuedDays, oldestQueuedDay: queuedDays === null ? null : queue!.oldest_day as string | null,
            newestQueuedDay: queuedDays === null ? null : queue!.newest_day as string | null,
            lastReleasedAt: nullableTime(daily.last_released_at), releasedLastHour: count(daily.released_last_hour) },
        },
        publication: { publishedDays: count(daily.published_days), latestEvidenceDay: daily.latest_day as string | null,
          preview: { state: preview ? preview.available === true ? "recorded" : "unavailable" : "not_recorded",
            computedAt: preview ? time(preview.computed_at) : null } },
        work: { currentState: "unavailable", lastRun, nextScheduledAt: nextSlot.toISOString(), scheduleState: "unavailable" },
        history: UNAVAILABLE, graph: UNAVAILABLE,
      };
    }, { statementTimeoutMilliseconds: 2_000, lockTimeoutMilliseconds: 500,
      operation: "admin_reconstruction_progress" });
  } catch { return fail(); }
}
