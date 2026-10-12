/**
 * Read-only PostgreSQL lifecycle and quarantine-reconciliation state.
 *
 * Readiness, health, the admin overview and maintenance all read the two
 * singleton rows that primary migration 0049 puts in the Worker vocabulary
 * (D1 migrations 0010, 0013 and 0020). These helpers run on a client inside
 * the caller's transaction and never open, commit or roll back one.
 *
 * Every timestamp is rendered by PostgreSQL as a canonical UTC
 * millisecond instant, so session TimeZone and DateStyle cannot change the
 * value. Counters become JavaScript numbers only when they are safe integers.
 * Any value outside the closed contract throws StateShapeError, which callers
 * map to 503 BACKEND_STORAGE_UNAVAILABLE. Nothing is coerced to a default:
 * an absent row is null and a malformed row is an error.
 */
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  type PostgresClient,
  type PostgresSchemaOptions,
} from "./postgres-client";

export const POSTGRES_RETENTION_STATE_SCHEMA_VERSION = "backend-retention-v0.1" as const;
export const POSTGRES_QUARANTINE_RECONCILIATION_SCHEMA_VERSION =
  "quarantine-reconciliation-v0.1" as const;
export const POSTGRES_LIFECYCLE_RUN_STATES = Object.freeze([
  "never_run",
  "running",
  "completed",
  "failed",
] as const);

export type PostgresLifecycleRunState = (typeof POSTGRES_LIFECYCLE_RUN_STATES)[number];
export type PostgresLifecycleStateRelation = "retention_state" | "quarantine_reconciliation_state";

export interface PostgresRetentionState {
  readonly state: PostgresLifecycleRunState;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAtMs: number | null;
  readonly maintenanceRunAtIso: string | null;
  readonly quarantineCutoffAt: string | null;
  readonly quarantineObjectsDeleted: number;
  readonly quarantineRetentionComplete: boolean;
  readonly restoredParticipantsSuppressed: number;
  readonly restoreReplayComplete: boolean;
  readonly failureCode: "LIFECYCLE_PASS_FAILED" | null;
}

export interface PostgresQuarantineReconciliationState {
  readonly state: PostgresLifecycleRunState;
  readonly lastStartedAt: string | null;
  readonly lastCompletedAt: string | null;
  readonly maintenanceRunAtIso: string | null;
  readonly cutoffAt: string | null;
  readonly registrationsExamined: number;
  readonly orphanObjectsDeleted: number;
  readonly referencedObjectsPreserved: number;
  readonly reconciliationComplete: boolean;
  readonly failureCode: "QUARANTINE_RECONCILIATION_FAILED" | null;
}

/**
 * A stored lifecycle row does not match the closed contract. The message is
 * constant; relation and field are schema names, never stored values.
 */
export class StateShapeError extends Error {
  readonly code = "LIFECYCLE_STATE_SHAPE_INVALID" as const;
  readonly relation: PostgresLifecycleStateRelation;
  readonly field: string;

  constructor(relation: PostgresLifecycleStateRelation, field: string) {
    super("LIFECYCLE_STATE_SHAPE_INVALID");
    this.name = "StateShapeError";
    this.relation = relation;
    this.field = field;
  }
}

const UTC_MILLISECOND_INSTANT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL_COUNTER = /^(?:0|[1-9][0-9]{0,15})$/u;
const RUN_STATES: ReadonlySet<string> = new Set(POSTGRES_LIFECYCLE_RUN_STATES);

type Column = string;

/**
 * Render one timestamptz column as a canonical UTC millisecond instant. A
 * value that has no four-digit ISO form (infinite, BC or beyond year 9999)
 * becomes a marker that fails validation instead of NULL, so it can never
 * read as an absent timestamp. An `exact` column is an identity that callers
 * compare, so a sub-millisecond value is refused rather than truncated: two
 * different instants can then never read as the same string.
 */
function instantColumn(column: Column, exact = false): string {
  const wholeMilliseconds = exact
    ? `
             AND ${column} = date_trunc('milliseconds', ${column}, 'UTC')`
    : "";
  return `CASE
            WHEN ${column} IS NULL THEN NULL
            WHEN isfinite(${column})
             AND extract(year FROM ${column} AT TIME ZONE 'UTC') BETWEEN 1 AND 9999${wholeMilliseconds}
              THEN to_char(${column} AT TIME ZONE 'UTC', '${UTC_MILLISECOND_INSTANT}')
            ELSE 'out-of-range'
          END AS ${column}`;
}

function counterColumn(column: Column): string {
  return `${column}::text AS ${column}`;
}

function primaryTable(schema: PostgresSchemaOptions | undefined, name: PostgresLifecycleStateRelation): string {
  const { primarySchema } = createPostgresSchemaConfig(schema ?? {});
  return `${quotePostgresIdentifier(primarySchema)}.${quotePostgresIdentifier(name)}`;
}

function assertClient(client: PostgresClient): void {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new TypeError("invalid PostgreSQL client");
  }
}

async function readSingleton(
  client: PostgresClient,
  relation: PostgresLifecycleStateRelation,
  sql: string,
): Promise<Record<string, unknown> | null> {
  const result = await client.query<Record<string, unknown>>(sql);
  const rows: unknown = result?.rows;
  if (!Array.isArray(rows)) throw new StateShapeError(relation, "singleton");
  if (rows.length === 0) return null;
  const row: unknown = rows[0];
  if (rows.length !== 1 || row === null || typeof row !== "object") {
    throw new StateShapeError(relation, "singleton");
  }
  return row as Record<string, unknown>;
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function instant(
  row: Record<string, unknown>,
  relation: PostgresLifecycleStateRelation,
  field: string,
): string | null {
  const value = row[field];
  if (value === null) return null;
  if (!isCanonicalInstant(value)) throw new StateShapeError(relation, field);
  return value;
}

function counter(
  row: Record<string, unknown>,
  relation: PostgresLifecycleStateRelation,
  field: string,
): number {
  const value = row[field];
  if (typeof value !== "string" || !DECIMAL_COUNTER.test(value)) {
    throw new StateShapeError(relation, field);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new StateShapeError(relation, field);
  return parsed;
}

function flag(
  row: Record<string, unknown>,
  relation: PostgresLifecycleStateRelation,
  field: string,
): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new StateShapeError(relation, field);
  return value;
}

function runState(
  row: Record<string, unknown>,
  relation: PostgresLifecycleStateRelation,
): PostgresLifecycleRunState {
  const value = row.state;
  if (typeof value !== "string" || !RUN_STATES.has(value)) {
    throw new StateShapeError(relation, "state");
  }
  return value as PostgresLifecycleRunState;
}

function schemaVersion(
  row: Record<string, unknown>,
  relation: PostgresLifecycleStateRelation,
  expected: string,
): void {
  if (row.schema_version !== expected) throw new StateShapeError(relation, "schema_version");
}

function failureCode<Code extends string>(
  row: Record<string, unknown>,
  relation: PostgresLifecycleStateRelation,
  expected: Code,
): Code | null {
  const value = row.failure_code;
  if (value === null) return null;
  if (value !== expected) throw new StateShapeError(relation, "failure_code");
  return expected;
}

/**
 * Read the lifecycle retention singleton, or null when the row is absent.
 * The completion instant is returned as epoch milliseconds for freshness
 * checks; every other instant is a canonical ISO string.
 */
export async function readPostgresRetentionState(
  client: PostgresClient,
  schema?: PostgresSchemaOptions,
): Promise<PostgresRetentionState | null> {
  assertClient(client);
  const relation = "retention_state";
  const row = await readSingleton(client, relation, `SELECT schema_version,
            state,
            ${instantColumn("last_started_at")},
            ${instantColumn("last_completed_at")},
            ${instantColumn("maintenance_run_at", true)},
            ${instantColumn("quarantine_cutoff_at")},
            ${counterColumn("quarantine_objects_deleted")},
            quarantine_retention_complete,
            ${counterColumn("restored_participants_suppressed")},
            restore_replay_complete,
            failure_code
       FROM ${primaryTable(schema, relation)}
      WHERE singleton = 1`);
  if (row === null) return null;
  schemaVersion(row, relation, POSTGRES_RETENTION_STATE_SCHEMA_VERSION);
  const lastCompletedAt = instant(row, relation, "last_completed_at");
  return Object.freeze({
    state: runState(row, relation),
    lastStartedAt: instant(row, relation, "last_started_at"),
    lastCompletedAtMs: lastCompletedAt === null ? null : Date.parse(lastCompletedAt),
    maintenanceRunAtIso: instant(row, relation, "maintenance_run_at"),
    quarantineCutoffAt: instant(row, relation, "quarantine_cutoff_at"),
    quarantineObjectsDeleted: counter(row, relation, "quarantine_objects_deleted"),
    quarantineRetentionComplete: flag(row, relation, "quarantine_retention_complete"),
    restoredParticipantsSuppressed: counter(row, relation, "restored_participants_suppressed"),
    restoreReplayComplete: flag(row, relation, "restore_replay_complete"),
    failureCode: failureCode(row, relation, "LIFECYCLE_PASS_FAILED"),
  });
}

/** Read the quarantine-reconciliation singleton, or null when it is absent. */
export async function readPostgresQuarantineReconciliationState(
  client: PostgresClient,
  schema?: PostgresSchemaOptions,
): Promise<PostgresQuarantineReconciliationState | null> {
  assertClient(client);
  const relation = "quarantine_reconciliation_state";
  const row = await readSingleton(client, relation, `SELECT schema_version,
            state,
            ${instantColumn("last_started_at")},
            ${instantColumn("last_completed_at")},
            ${instantColumn("maintenance_run_at", true)},
            ${instantColumn("cutoff_at")},
            ${counterColumn("registrations_examined")},
            ${counterColumn("orphan_objects_deleted")},
            ${counterColumn("referenced_objects_preserved")},
            reconciliation_complete,
            failure_code
       FROM ${primaryTable(schema, relation)}
      WHERE singleton = 1`);
  if (row === null) return null;
  schemaVersion(row, relation, POSTGRES_QUARANTINE_RECONCILIATION_SCHEMA_VERSION);
  return Object.freeze({
    state: runState(row, relation),
    lastStartedAt: instant(row, relation, "last_started_at"),
    lastCompletedAt: instant(row, relation, "last_completed_at"),
    maintenanceRunAtIso: instant(row, relation, "maintenance_run_at"),
    cutoffAt: instant(row, relation, "cutoff_at"),
    registrationsExamined: counter(row, relation, "registrations_examined"),
    orphanObjectsDeleted: counter(row, relation, "orphan_objects_deleted"),
    referencedObjectsPreserved: counter(row, relation, "referenced_objects_preserved"),
    reconciliationComplete: flag(row, relation, "reconciliation_complete"),
    failureCode: failureCode(row, relation, "QUARANTINE_RECONCILIATION_FAILED"),
  });
}

/**
 * The lifecycle and reconciliation rows record the same maintenance cycle
 * only when both markers are present, canonical and identical (Worker
 * handleReady parity). Two absent markers never match. The readers return a
 * marker only when it holds whole milliseconds, so string identity is
 * instant identity.
 */
export function maintenanceCyclesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return isCanonicalInstant(a) && isCanonicalInstant(b) && a === b;
}
