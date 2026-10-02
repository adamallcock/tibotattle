/**
 * GET /api/v1/admin/overview over PostgreSQL (GCP, C-ADMIN).
 *
 * The body is d43c8f92's 'admin-overview-v0.5' in typed storage mode:
 * handleAdminOverview composing readAdminOverview (admin-operations.ts) with
 * readStorageAdminOverview (storage-admin-overview.ts), the upload-ingress
 * status, the distribution block and the typed reconstruction placeholder,
 * in the Worker's key order. Every block below names its GCP source:
 *
 * - collection: collection_controls through the AA-0 reader;
 * - counts.participants, counts.contributions.telemetry: participants and
 *   telemetry_contributions, with the Worker's 10 000-row bounds and orders
 *   (text ids compare bytewise, COLLATE "C", as SQLite compares them);
 * - counts.contributions (typed): the v1, v1.1 and v1.2 chunk headers,
 *   the D1 telemetry_analytical_chunks view inlined over the same PostgreSQL
 *   tables, and the v1.2 head selection, pinned to the typed source identity;
 * - quarantine, lifecycle, reconciliation: pending_quarantine_objects,
 *   retention_state and quarantine_reconciliation_state;
 * - errors, audit: diagnostic_error_events and admin_action_audit (PT-3
 *   imports both);
 * - ingress: the Worker's readUploadIngressStatus over the env's
 *   UPLOAD_INGRESS_BUDGET binding (the PostgreSQL budget), null when absent;
 * - dailyPublication: the latest analytics_v2_published_daily head, and the
 *   pending rebuilds as the analytics-refresh job counts them: the distinct
 *   days the journal names after analytics_v2_journal_cursor (A-1
 *   readQueuedDays, terminal events contributing no day, as in the job);
 * - distribution: postgres-admin-distribution.ts (GitHub from the 0022
 *   snapshots; Cloudflare left to the edge);
 * - reconstruction: the Worker's constant typed-mode 'unavailable' block;
 * - snapshots [] and pendingHistoricalRebuilds null: the Worker's typed values.
 *
 * Three blocks have no GCP data source on this line, and the module never
 * fills them with zeros or a guess. Each is an injected source; without it the
 * whole overview is the Worker's own 503 BACKEND_STORAGE_UNAVAILABLE, the
 * answer the Worker gives when any overview source cannot be read:
 *
 * - counts.contributions.synthetic: the D1 `contributions` table has no
 *   PostgreSQL relation (it is untransferred legacy state);
 * - historicalPublication: production's per-day model publications and
 *   graph-preview freshness have no analytics_v2 counterpart;
 * - deletionLedger: the deletion-ledger tombstones. The PostgreSQL line has
 *   no deletion ledger (decisions D2, D4 and D6 of 2026-09-26), so there is
 *   no reader here; what the block reports once the ledger is gone is OWN-17
 *   question 1, and until it is answered the root injects nothing.
 *
 * All primary reads run in one REPEATABLE READ READ ONLY snapshot. A
 * reviewed ApiError (for example 503 COLLECTION_CONTROL_UNAVAILABLE) keeps its
 * code; any other failure is 503 BACKEND_STORAGE_UNAVAILABLE.
 */
import type { CollectionControls } from "./collection-controls";
import { QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS } from "./constants";
import { ApiError } from "./errors";
import { readQueuedDays } from "./analytics-v2/queued-days";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";
import { readPostgresCollectionControls } from "./postgres-collection-controls";
import { readPostgresAdminDistribution } from "./postgres-admin-distribution";
import { parseStoredJson } from "./stored-record";
import { parseTelemetryStorageMode } from "./telemetry-storage-mode";
import { readUploadIngressStatus } from "./upload-ingress-admission";

export const POSTGRES_ADMIN_OVERVIEW_SCHEMA_VERSION = "admin-overview-v0.5" as const;

/** d43c8f92 admin-operations.ts constants. */
const DIAGNOSTIC_RETENTION_DAYS = 30;
const MAX_DIAGNOSTIC_EVENTS = 256;
const MAX_ADMIN_AGGREGATE_ROWS = 10_000;
const DIAGNOSTIC_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DAY_MS = 24 * 60 * 60 * 1_000;
const READ_TIMEOUT_MILLISECONDS = 10_000;
const QUEUE_PAGE_EVENTS = 100_000;
const MAX_QUEUE_PAGES = 100;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export interface PostgresAdminSyntheticContributions {
  readonly total: number;
  readonly bounded: boolean;
  readonly accepted: number;
  readonly deleting: number;
}

export interface PostgresAdminHistoricalPublication {
  readonly publishedDays: number;
  readonly publishedDaysBounded: boolean;
  readonly latestEvidenceDay: string | null;
  readonly latestComputedAt: string | null;
  readonly previewState: "current" | "stale" | "not_published";
  readonly previewGeneratedAt: string | null;
}

export interface PostgresAdminDeletionLedger {
  readonly total: number;
  readonly bounded: boolean;
  readonly earliestRetainUntil: string | null;
}

/** The blocks with no GCP source on this line; each must be supplied explicitly. */
export interface PostgresAdminOverviewSources {
  readonly syntheticContributions?: () => Promise<PostgresAdminSyntheticContributions>;
  readonly historicalPublication?: () => Promise<PostgresAdminHistoricalPublication>;
  readonly deletionLedger?: () => Promise<PostgresAdminDeletionLedger>;
}

export interface PostgresAdminOverviewOptions {
  readonly pool: PostgresPool;
  /** The primary runtime schema. */
  readonly schema: string;
  /** The frozen Worker-shaped env (ENVIRONMENT, modes, ingress binding, ...). */
  readonly env: Readonly<Record<string, unknown>>;
  readonly nowEpoch: number;
  /** Already validated by the route (400 BODY_INVALID otherwise). */
  readonly diagnosticReference?: string;
  readonly sources?: PostgresAdminOverviewSources;
}

function unavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function count(value: unknown): number {
  const parsed = typeof value === "string" && DECIMAL.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) unavailable();
  return parsed;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") unavailable();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  const text = nullableText(value);
  if (text !== null && !Number.isFinite(Date.parse(text))) unavailable();
  return text;
}

function nullableDay(value: unknown): string | null {
  const text = nullableText(value);
  if (text !== null && (!DAY.test(text)
      || new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10) !== text)) {
    unavailable();
  }
  return text;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") unavailable();
  return value;
}

function bounded(total: number): { total: number; bounded: boolean } {
  return { total: Math.min(total, MAX_ADMIN_AGGREGATE_ROWS), bounded: total >= MAX_ADMIN_AGGREGATE_ROWS };
}

function iso(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function offsetIso(value: string | null, milliseconds: number): string | null {
  if (value === null) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) unavailable();
  return new Date(epoch + milliseconds).toISOString();
}

async function one<Row extends object>(
  client: PostgresClient,
  sql: string,
  values: unknown[] = [],
): Promise<Row | null> {
  const result = await client.query<Row>(sql, values);
  if (!Array.isArray(result?.rows) || result.rows.length > 1) unavailable();
  return result.rows[0] ?? null;
}

async function many<Row extends object>(
  client: PostgresClient,
  sql: string,
  values: unknown[] = [],
): Promise<readonly Row[]> {
  const result = await client.query<Row>(sql, values);
  if (!Array.isArray(result?.rows)) unavailable();
  return result.rows;
}

type Row = Record<string, unknown>;

interface Instants {
  readonly now: string;
  readonly since: string;
  readonly sinceWeek: string;
  readonly sinceMonth: string;
  readonly diagnosticSince: string;
  readonly quarantineCutoffAt: string;
}

function instants(nowEpoch: number): Instants {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) unavailable();
  const at = (offset: number) => new Date(nowEpoch - offset).toISOString();
  return {
    now: at(0),
    since: at(DAY_MS),
    sinceWeek: at(7 * DAY_MS),
    sinceMonth: at(30 * DAY_MS),
    diagnosticSince: at(DIAGNOSTIC_RETENTION_DAYS * DAY_MS),
    quarantineCutoffAt: at(QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS),
  };
}

/** The D1 telemetry_analytical_chunks view (migration 0058), over PostgreSQL. */
function analyticalChunkCountSql(s: string): string {
  return `(SELECT COUNT(*) FROM ${s}."telemetry_v1_chunks" c
            WHERE c.superseded_at IS NULL AND NOT EXISTS (
              SELECT 1 FROM ${s}."telemetry_v11_domain_heads" h WHERE h.participant_id = c.participant_id))
         + (SELECT COUNT(*) FROM ${s}."telemetry_v11_domain_heads" h
              JOIN ${s}."telemetry_v11_domains" d ON d.id = h.generation_id
              JOIN ${s}."telemetry_v11_domain_days" day_row ON day_row.generation_id = d.id
              JOIN ${s}."telemetry_v11_chunks" c ON c.manifest_id = day_row.manifest_id)
         + (SELECT COUNT(*) FROM ${s}."telemetry_v12_domain_heads" head
              JOIN ${s}."telemetry_v12_domain_days" day ON day.generation_id = head.generation_id
              JOIN ${s}."telemetry_v12_chunks" chunk ON chunk.participant_id = head.participant_id
               AND chunk.manifest_id = day.manifest_id)`;
}

interface PrimaryRead {
  readonly controls: CollectionControls;
  readonly participants: Row;
  readonly telemetry: Row;
  readonly quarantine: Row;
  readonly retention: Row;
  readonly reconciliation: Row;
  readonly errorGroups: readonly Row[];
  readonly recentDiagnostics: readonly Row[];
  readonly lookup: Row | null;
  readonly audit: readonly Row[];
  readonly typed: TypedRead;
}

interface TypedRead {
  readonly chunks: Row;
  readonly accounts: Row;
  readonly storedRecords: Row;
  readonly legacy: Row;
  readonly latestDaily: Row | null;
  readonly pendingDays: number;
}

async function readPendingDays(client: PostgresClient, pool: PostgresPool, schema: string,
  nowEpoch: number, s: string): Promise<number> {
  const cursor = await one<{ last_sequence: unknown }>(client,
    `SELECT last_sequence::text AS last_sequence FROM ${s}."analytics_v2_journal_cursor" WHERE id = 1`);
  let afterSequence = cursor === null ? 0 : count(cursor.last_sequence);
  const days = new Set<string>();
  const context = { pool, schema, nowMs: nowEpoch, client };
  for (let page = 0; page < MAX_QUEUE_PAGES; page += 1) {
    const result = await readQueuedDays(context, { afterSequence, limit: QUEUE_PAGE_EVENTS });
    for (const day of result.days) days.add(day);
    // The Worker counts at most MAX_ADMIN_AGGREGATE_ROWS + 1 pending days.
    if (days.size > MAX_ADMIN_AGGREGATE_ROWS || result.complete) return days.size;
    if (result.lastSequence <= afterSequence) unavailable();
    afterSequence = result.lastSequence;
  }
  return unavailable();
}

async function readTyped(client: PostgresClient, pool: PostgresPool, schema: string,
  namespace: string, at: Instants, nowEpoch: number): Promise<TypedRead> {
  const s = quotePostgresIdentifier(schema);
  const identity = await one<Row>(client,
    `SELECT v1.source_namespace AS v1_namespace, v11.source_namespace AS v11_namespace
       FROM ${s}."storage_source_state" source
       JOIN ${s}."typed_v1_admission_state" v1 ON v1.id = 1 AND v1.runtime_contract_version = 1
       JOIN ${s}."typed_v11_admission_state" v11 ON v11.id = 1 AND v11.runtime_contract_version = 1
      WHERE source.singleton = 1`);
  if (identity === null || identity.v1_namespace !== namespace || identity.v11_namespace !== namespace) {
    unavailable();
  }
  const chunks = await one<Row>(client,
    `WITH chunk_headers AS (
       SELECT participant_id, created_at FROM ${s}."telemetry_v1_chunks"
       UNION ALL SELECT participant_id, created_at FROM ${s}."telemetry_v11_chunks"
       UNION ALL SELECT participant_id, created_at FROM ${s}."telemetry_v12_chunks"
     )
     SELECT COUNT(*)::text AS total,
            (${analyticalChunkCountSql(s)})::text AS current,
            COALESCE(SUM(CASE WHEN created_at >= $1::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_24h,
            COALESCE(SUM(CASE WHEN created_at >= $2::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_7d,
            ${iso("MAX(created_at)")} AS latest_accepted_at
       FROM chunk_headers`, [at.since, at.sinceWeek]);
  const accounts = await one<Row>(client,
    `WITH accepted_uploads AS (
       SELECT participant_id, created_at FROM ${s}."telemetry_contributions" WHERE status = 'accepted'
       UNION ALL SELECT participant_id, created_at FROM ${s}."telemetry_v1_chunks"
       UNION ALL SELECT participant_id, created_at FROM ${s}."telemetry_v11_chunks"
       UNION ALL SELECT participant_id, created_at FROM ${s}."telemetry_v12_chunks"
     ), latest_by_account AS (
       SELECT participant_id, MAX(created_at) AS latest_accepted_at
         FROM accepted_uploads GROUP BY participant_id
     )
     SELECT COUNT(*)::text AS total,
            COALESCE(SUM(CASE WHEN latest_accepted_at >= $1::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_24h,
            COALESCE(SUM(CASE WHEN latest_accepted_at >= $2::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_7d,
            COALESCE(SUM(CASE WHEN latest_accepted_at >= $3::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_30d
       FROM latest_by_account`, [at.since, at.sinceWeek, at.sinceMonth]);
  const storedRecords = await one<Row>(client,
    `SELECT (COALESCE((SELECT SUM(accepted_record_count) FROM ${s}."telemetry_v1_chunks"), 0)
            + COALESCE((SELECT SUM(record_count) FROM ${s}."telemetry_v11_chunks"), 0)
            + COALESCE((SELECT SUM(record_count) FROM ${s}."telemetry_v12_chunks"), 0))::text AS total`);
  const legacy = await one<Row>(client,
    `SELECT ${iso("MAX(created_at)")} AS latest_accepted_at,
            COALESCE(SUM(CASE WHEN created_at >= $1::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_24h,
            COALESCE(SUM(CASE WHEN created_at >= $2::timestamptz THEN 1 ELSE 0 END), 0)::text
              AS accepted_last_7d
       FROM ${s}."telemetry_contributions" WHERE status = 'accepted'`, [at.since, at.sinceWeek]);
  const latestDaily = await one<Row>(client,
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, ${iso("released_at")} AS released_at
       FROM ${s}."analytics_v2_published_daily" ORDER BY day DESC LIMIT 1`);
  const pendingDays = await readPendingDays(client, pool, schema, nowEpoch, s);
  if (chunks === null || accounts === null || storedRecords === null || legacy === null) unavailable();
  return { chunks, accounts, storedRecords, legacy, latestDaily, pendingDays };
}

async function readPrimary(pool: PostgresPool, schema: string, namespace: string,
  at: Instants, nowEpoch: number, diagnosticReference: string | undefined): Promise<PrimaryRead> {
  const s = quotePostgresIdentifier(schema);
  return withPostgresRead(pool, async (client) => {
    const controls = await readPostgresCollectionControls(client, schema);
    const participants = await one<Row>(client,
      `SELECT COUNT(*)::text AS total,
              COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0)::text AS active,
              COALESCE(SUM(CASE WHEN state = 'deleting' THEN 1 ELSE 0 END), 0)::text AS deleting,
              COALESCE(SUM(CASE WHEN created_at >= $1::timestamptz THEN 1 ELSE 0 END), 0)::text
                AS enrolled_last_24h,
              COALESCE(SUM(CASE WHEN created_at >= $2::timestamptz THEN 1 ELSE 0 END), 0)::text
                AS enrolled_last_7d
         FROM (SELECT state, created_at FROM ${s}."participants"
                ORDER BY id COLLATE "C" LIMIT $3) bounded_participants`,
      [at.since, at.sinceWeek, MAX_ADMIN_AGGREGATE_ROWS]);
    const telemetry = await one<Row>(client,
      `SELECT COUNT(*)::text AS total,
              COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0)::text AS accepted,
              COALESCE(SUM(CASE WHEN status = 'deleting' THEN 1 ELSE 0 END), 0)::text AS deleting,
              COALESCE(SUM(CASE WHEN status = 'accepted' AND created_at >= $1::timestamptz
                THEN 1 ELSE 0 END), 0)::text AS accepted_last_24h,
              COALESCE(SUM(CASE WHEN status = 'accepted' AND created_at >= $2::timestamptz
                THEN 1 ELSE 0 END), 0)::text AS accepted_last_7d
         FROM (SELECT status, created_at FROM ${s}."telemetry_contributions"
                ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT $3) bounded_contributions`,
      [at.since, at.sinceWeek, MAX_ADMIN_AGGREGATE_ROWS]);
    const referenced = (key: string) => `(
        EXISTS (SELECT 1 FROM ${s}."telemetry_contributions" WHERE r2_key = ${key})
        OR EXISTS (SELECT 1 FROM ${s}."telemetry_v1_chunks" WHERE r2_key = ${key})
        OR EXISTS (SELECT 1 FROM ${s}."telemetry_v11_chunks" WHERE r2_key = ${key})
        OR EXISTS (SELECT 1 FROM ${s}."telemetry_v12_chunks" WHERE r2_key = ${key}))`;
    const quarantine = await one<Row>(client,
      `SELECT COUNT(*)::text AS total,
              COALESCE(SUM(CASE WHEN registered_at > $1::timestamptz THEN 1 ELSE 0 END), 0)::text
                AS within_grace,
              COALESCE(SUM(CASE WHEN registered_at <= $1::timestamptz AND ${referenced("pending.r2_key")}
                THEN 1 ELSE 0 END), 0)::text AS due_referenced,
              COALESCE(SUM(CASE WHEN registered_at <= $1::timestamptz AND NOT ${referenced("pending.r2_key")}
                THEN 1 ELSE 0 END), 0)::text AS due_unreferenced,
              ${iso("MIN(registered_at)")} AS oldest_registered_at,
              ${iso("MAX(registered_at)")} AS newest_registered_at,
              ${iso("MIN(CASE WHEN registered_at > $1::timestamptz THEN registered_at END)")}
                AS next_eligible_registered_at
         FROM (SELECT r2_key, registered_at FROM ${s}."pending_quarantine_objects"
                ORDER BY registered_at, r2_key COLLATE "C" LIMIT $2) AS pending`,
      [at.quarantineCutoffAt, MAX_ADMIN_AGGREGATE_ROWS]);
    const retention = await one<Row>(client,
      `SELECT state, ${iso("last_started_at")} AS last_started_at,
              ${iso("last_completed_at")} AS last_completed_at,
              ${iso("maintenance_run_at")} AS maintenance_run_at,
              ${iso("quarantine_cutoff_at")} AS quarantine_cutoff_at,
              quarantine_objects_deleted::text AS quarantine_objects_deleted,
              quarantine_retention_complete,
              restored_participants_suppressed::text AS restored_participants_suppressed,
              restore_replay_complete, failure_code
         FROM ${s}."retention_state" WHERE singleton = 1`);
    const reconciliation = await one<Row>(client,
      `SELECT state, ${iso("last_completed_at")} AS last_completed_at,
              ${iso("maintenance_run_at")} AS maintenance_run_at,
              ${iso("cutoff_at")} AS cutoff_at,
              registrations_examined::text AS registrations_examined,
              orphan_objects_deleted::text AS orphan_objects_deleted,
              referenced_objects_preserved::text AS referenced_objects_preserved,
              reconciliation_complete, failure_code
         FROM ${s}."quarantine_reconciliation_state" WHERE singleton = 1`);
    const errorGroups = await many<Row>(client,
      `SELECT route_class, error_code, status, COUNT(*)::text AS occurrences,
              ${iso("MAX(occurred_at)")} AS latest_at
         FROM ${s}."diagnostic_error_events"
        WHERE occurred_at >= $1::timestamptz
        GROUP BY route_class, error_code, status
        ORDER BY COUNT(*) DESC, MAX(occurred_at) DESC
        LIMIT 20`, [at.diagnosticSince]);
    const recentDiagnostics = await many<Row>(client,
      `SELECT request_id, route_class, error_code, status, ${iso("occurred_at")} AS occurred_at
         FROM ${s}."diagnostic_error_events"
        WHERE occurred_at >= $1::timestamptz
        ORDER BY occurred_at DESC, id DESC
        LIMIT 20`, [at.diagnosticSince]);
    const lookup = diagnosticReference === undefined ? null : await one<Row>(client,
      `SELECT request_id, route_class, error_code, status, ${iso("occurred_at")} AS occurred_at
         FROM ${s}."diagnostic_error_events" WHERE request_id = $1 LIMIT 1`, [diagnosticReference]);
    const audit = await many<Row>(client,
      `SELECT action, outcome, details_json, ${iso("created_at")} AS created_at
         FROM ${s}."admin_action_audit"
        ORDER BY created_at DESC, id DESC
        LIMIT 20`);
    const typed = await readTyped(client, pool, schema, namespace, at, nowEpoch);
    if (participants === null || telemetry === null || quarantine === null
        || retention === null || reconciliation === null) {
      unavailable();
    }
    return {
      controls, participants, telemetry, quarantine, retention, reconciliation,
      errorGroups, recentDiagnostics, lookup, audit, typed,
    };
  }, {
    operation: "admin_overview.read",
    statementTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    lockTimeoutMilliseconds: 5_000,
    preserveSafeError: (error) => (error instanceof ApiError ? error : null),
  });
}

function publicDiagnostic(row: Row | null): object | null {
  return row === null ? null : {
    requestId: nullableText(row.request_id),
    routeClass: nullableText(row.route_class),
    errorCode: nullableText(row.error_code),
    status: count(row.status),
    occurredAt: nullableTimestamp(row.occurred_at),
  };
}

function typedOverview(typed: TypedRead) {
  const chunkTotal = count(typed.chunks.total);
  const currentChunks = count(typed.chunks.current);
  const chunkLast24Hours = count(typed.chunks.accepted_last_24h);
  const chunkLast7Days = count(typed.chunks.accepted_last_7d);
  const accountTotal = count(typed.accounts.total);
  const accountLast24Hours = count(typed.accounts.accepted_last_24h);
  const accountLast7Days = count(typed.accounts.accepted_last_7d);
  const accountLast30Days = count(typed.accounts.accepted_last_30d);
  const storedRecordTotal = count(typed.storedRecords.total);
  if (currentChunks > chunkTotal || accountLast24Hours > accountTotal
      || accountLast7Days > accountTotal || accountLast30Days > accountTotal) {
    unavailable();
  }
  const latestAcceptedAt = [
    nullableTimestamp(typed.chunks.latest_accepted_at),
    nullableTimestamp(typed.legacy.latest_accepted_at),
  ].filter((value): value is string => value !== null).sort().at(-1) ?? null;
  const add = (left: number, right: unknown) => count(left + count(right));
  return {
    contributions: {
      contributingAccounts: {
        total: accountTotal,
        bounded: false,
        acceptedLast24Hours: accountLast24Hours,
        acceptedLast7Days: accountLast7Days,
        acceptedLast30Days: accountLast30Days,
      },
      // The overview's key order (admin-operations.ts), not the storage reader's.
      incrementalChunks: {
        total: chunkTotal,
        bounded: false,
        current: currentChunks,
        acceptedLast24Hours: chunkLast24Hours,
        acceptedLast7Days: chunkLast7Days,
      },
      acceptedLast24Hours: add(chunkLast24Hours, typed.legacy.accepted_last_24h),
      acceptedLast7Days: add(chunkLast7Days, typed.legacy.accepted_last_7d),
      latestAcceptedAt,
      storedTelemetryRecords: storedRecordTotal,
      storedTelemetryRecordsBounded: false,
    },
    dailyPublication: {
      latestEvidenceDay: typed.latestDaily ? nullableDay(typed.latestDaily.day) : null,
      latestReleasedAt: typed.latestDaily ? nullableTimestamp(typed.latestDaily.released_at) : null,
      pendingRebuilds: Math.min(typed.pendingDays, MAX_ADMIN_AGGREGATE_ROWS),
      pendingRebuildsBounded: typed.pendingDays > MAX_ADMIN_AGGREGATE_ROWS,
    },
  };
}

async function required<T>(source: (() => Promise<T>) | undefined): Promise<T> {
  if (typeof source !== "function") unavailable();
  return source();
}

/** The 'admin-overview-v0.5' body, or an ApiError (503 unless a reviewed code). */
export async function readPostgresAdminOverview(
  options: PostgresAdminOverviewOptions,
): Promise<Record<string, unknown>> {
  const { pool, schema, env, nowEpoch, diagnosticReference } = options;
  const sources = options.sources ?? {};
  if (diagnosticReference !== undefined && !DIAGNOSTIC_REFERENCE_PATTERN.test(diagnosticReference)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const mode = parseTelemetryStorageMode(env as Parameters<typeof parseTelemetryStorageMode>[0]);
  // The PostgreSQL origin stores typed telemetry only.
  if (mode.kind !== "typed") unavailable();
  try {
    quotePostgresIdentifier(schema);
  } catch {
    return unavailable();
  }
  const at = instants(nowEpoch);
  const [primaryResult, synthetic, historicalPublication, deletionLedger, ingress, distribution] =
    await Promise.allSettled([
      readPrimary(pool, schema, mode.sourceNamespace, at, nowEpoch, diagnosticReference),
      required(sources.syntheticContributions),
      required(sources.historicalPublication),
      required(sources.deletionLedger),
      readUploadIngressStatus(env as unknown as Env),
      readPostgresAdminDistribution(pool, schema, env, nowEpoch),
    ]);
  for (const result of [primaryResult, synthetic, historicalPublication, deletionLedger,
    ingress, distribution]) {
    if (result.status === "rejected") {
      if (result.reason instanceof ApiError) throw result.reason;
      unavailable();
    }
  }
  const value = <T>(result: PromiseSettledResult<T>): T => (result as PromiseFulfilledResult<T>).value;
  const primary: PrimaryRead = value(primaryResult);
  const syntheticCounts = value(synthetic);
  const typed = typedOverview(primary.typed);
  const participants = bounded(count(primary.participants.total));
  const telemetry = bounded(count(primary.telemetry.total));
  const pending = bounded(count(primary.quarantine.total));
  const retention = primary.retention;
  const reconciliation = primary.reconciliation;
  const overview = {
    schemaVersion: POSTGRES_ADMIN_OVERVIEW_SCHEMA_VERSION,
    generatedAt: at.now,
    service: {
      environment: Reflect.get(env, "ENVIRONMENT"),
      enrollmentMode: Reflect.get(env, "ENROLLMENT_MODE"),
      accountScopedIngestMode: Reflect.get(env, "ACCOUNT_SCOPED_INGEST_MODE"),
      telemetryStorageMode: "typed",
    },
    collection: primary.controls,
    counts: {
      participants: {
        total: participants.total,
        bounded: participants.bounded,
        active: count(primary.participants.active),
        deleting: count(primary.participants.deleting),
        enrolledLast24Hours: count(primary.participants.enrolled_last_24h),
        enrolledLast7Days: count(primary.participants.enrolled_last_7d),
      },
      contributions: {
        contributingAccounts: typed.contributions.contributingAccounts,
        synthetic: {
          total: syntheticCounts.total,
          bounded: syntheticCounts.bounded,
          accepted: syntheticCounts.accepted,
          deleting: syntheticCounts.deleting,
        },
        telemetry: {
          total: telemetry.total,
          bounded: telemetry.bounded,
          accepted: count(primary.telemetry.accepted),
          deleting: count(primary.telemetry.deleting),
          acceptedLast24Hours: count(primary.telemetry.accepted_last_24h),
          acceptedLast7Days: count(primary.telemetry.accepted_last_7d),
        },
        incrementalChunks: typed.contributions.incrementalChunks,
        acceptedLast24Hours: typed.contributions.acceptedLast24Hours,
        acceptedLast7Days: typed.contributions.acceptedLast7Days,
        latestAcceptedAt: typed.contributions.latestAcceptedAt,
        storedTelemetryRecords: typed.contributions.storedTelemetryRecords,
        storedTelemetryRecordsBounded: typed.contributions.storedTelemetryRecordsBounded,
      },
    },
    quarantine: {
      pendingObjects: pending.total,
      pendingObjectsBounded: pending.bounded,
      gracePeriodMinutes: QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS / (60 * 1_000),
      cutoffAt: at.quarantineCutoffAt,
      withinGrace: count(primary.quarantine.within_grace),
      dueReferenced: count(primary.quarantine.due_referenced),
      dueUnreferenced: count(primary.quarantine.due_unreferenced),
      oldestRegisteredAt: nullableTimestamp(primary.quarantine.oldest_registered_at),
      newestRegisteredAt: nullableTimestamp(primary.quarantine.newest_registered_at),
      nextEligibleAt: offsetIso(
        nullableTimestamp(primary.quarantine.next_eligible_registered_at),
        QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS,
      ),
    },
    lifecycle: {
      state: nullableText(retention.state),
      lastStartedAt: nullableTimestamp(retention.last_started_at),
      lastCompletedAt: nullableTimestamp(retention.last_completed_at),
      maintenanceRunAt: nullableTimestamp(retention.maintenance_run_at),
      quarantineCutoffAt: nullableTimestamp(retention.quarantine_cutoff_at),
      quarantineObjectsDeleted: count(retention.quarantine_objects_deleted),
      quarantineRetentionComplete: boolean(retention.quarantine_retention_complete),
      restoredParticipantsSuppressed: count(retention.restored_participants_suppressed),
      restoreReplayComplete: boolean(retention.restore_replay_complete),
      failureCode: nullableText(retention.failure_code),
    },
    reconciliation: {
      state: nullableText(reconciliation.state),
      lastCompletedAt: nullableTimestamp(reconciliation.last_completed_at),
      maintenanceRunAt: nullableTimestamp(reconciliation.maintenance_run_at),
      cutoffAt: nullableTimestamp(reconciliation.cutoff_at),
      registrationsExamined: count(reconciliation.registrations_examined),
      orphanObjectsDeleted: count(reconciliation.orphan_objects_deleted),
      referencedObjectsPreserved: count(reconciliation.referenced_objects_preserved),
      reconciliationComplete: boolean(reconciliation.reconciliation_complete),
      failureCode: nullableText(reconciliation.failure_code),
    },
    ingress: value(ingress),
    deletionLedger: value(deletionLedger),
    snapshots: [],
    pendingHistoricalRebuilds: null,
    pendingHistoricalRebuildsBounded: null,
    historicalPublication: value(historicalPublication),
    dailyPublication: typed.dailyPublication,
    errors: {
      retentionDays: DIAGNOSTIC_RETENTION_DAYS,
      sampled: true,
      capacity: MAX_DIAGNOSTIC_EVENTS,
      groups: primary.errorGroups.map((row) => {
        const occurrences = count(row.occurrences);
        return {
          routeClass: nullableText(row.route_class),
          errorCode: nullableText(row.error_code),
          status: count(row.status),
          occurrences,
          ratePerDay: Number((occurrences / DIAGNOSTIC_RETENTION_DAYS).toFixed(2)),
          latestAt: nullableTimestamp(row.latest_at),
        };
      }),
      recentDiagnostics: primary.recentDiagnostics.map((row) => publicDiagnostic(row)),
      lookup: publicDiagnostic(primary.lookup),
    },
    audit: primary.audit.map((row) => ({
      action: nullableText(row.action),
      outcome: nullableText(row.outcome),
      details: parseStoredJson(row.details_json),
      createdAt: nullableTimestamp(row.created_at),
    })),
    distribution: value(distribution),
    reconstruction: {
      schemaVersion: "admin-reconstruction-progress-v0.1",
      observedAt: at.now,
      mode: "resumable",
      status: "unavailable",
    },
  };
  return overview;
}
