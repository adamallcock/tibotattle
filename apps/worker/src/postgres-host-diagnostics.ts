/**
 * Sampled, content-free request-failure diagnostics for the PostgreSQL host.
 *
 * This is the PostgreSQL port of the Worker's D1 writer and prune
 * (src/admin-operations.ts recordDiagnosticError / pruneDiagnosticErrors).
 * A row holds only the request id returned to the caller, the route class,
 * the closed error code, the status and the time. It is never joined to
 * participant, contribution or record contents.
 */
import {
  createPostgresSchemaConfig,
  PostgresStorageError,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

export const POSTGRES_DIAGNOSTIC_LOCK_DOMAIN =
  "tibotattle/diagnostic-error-events/v1" as const;
export const POSTGRES_DIAGNOSTIC_MAX_EVENTS = 256;
export const POSTGRES_DIAGNOSTIC_RETENTION_DAYS = 30;
export const POSTGRES_DIAGNOSTIC_PRUNE_BATCH_SIZE = 1_000;

const DIAGNOSTIC_SAMPLE_SUFFIX = "00";
const DIAGNOSTIC_FIELD_MAX_LENGTH = 80;
const DIAGNOSTIC_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]+$/u;
const MAX_EPOCH_MILLISECONDS = 9_999_999_999_999;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface PostgresDiagnosticErrorEvent {
  readonly requestId: string;
  readonly routeClass: string;
  readonly code: string;
  readonly status: number;
  /** Epoch milliseconds; defaults to the current time. */
  readonly occurredAt?: number;
}

interface SampledDiagnostic {
  readonly requestId: string;
  readonly routeClass: string;
  readonly code: string;
  readonly status: number;
  readonly occurredAt: string;
}

function diagnosticTable(schema: PostgresSchemaOptions | undefined): string {
  const config = createPostgresSchemaConfig(schema ?? {});
  return `${quotePostgresIdentifier(config.primarySchema)}."diagnostic_error_events"`;
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    && (value as number) <= MAX_EPOCH_MILLISECONDS;
}

/**
 * Apply the Worker's sampling rule: only server failures whose v4 request id
 * ends in "00" are recorded. Anything else, including a malformed event, is
 * not a diagnostic and is refused before any database work.
 */
function sampledDiagnostic(event: PostgresDiagnosticErrorEvent): SampledDiagnostic | null {
  if (event === null || typeof event !== "object") return null;
  const { requestId, routeClass, code, status } = event;
  const occurredAt = event.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(status) || status < 500 || status > 599
      || typeof requestId !== "string"
      || !DIAGNOSTIC_REFERENCE_PATTERN.test(requestId)
      || !requestId.endsWith(DIAGNOSTIC_SAMPLE_SUFFIX)
      || typeof routeClass !== "string"
      || typeof code !== "string"
      || !validEpoch(occurredAt)) {
    return null;
  }
  const boundedRouteClass = routeClass.slice(0, DIAGNOSTIC_FIELD_MAX_LENGTH);
  const boundedCode = code.slice(0, DIAGNOSTIC_FIELD_MAX_LENGTH);
  if (boundedRouteClass.length === 0 || !ERROR_CODE_PATTERN.test(boundedCode)) return null;
  return {
    requestId,
    routeClass: boundedRouteClass,
    code: boundedCode,
    status,
    occurredAt: new Date(occurredAt).toISOString(),
  };
}

/**
 * Best-effort failure recording. The failure response must stay available
 * even when PostgreSQL cannot accept its own diagnostic row, so this never
 * throws. It returns true only when a row was written. The transaction-scoped
 * advisory lock serializes writers so the 256-row cap holds under
 * concurrency.
 */
export async function recordPostgresDiagnosticError(
  pool: PostgresPool,
  schema: PostgresSchemaOptions | undefined,
  event: PostgresDiagnosticErrorEvent,
): Promise<boolean> {
  try {
    const diagnostic = sampledDiagnostic(event);
    if (diagnostic === null) return false;
    const table = diagnosticTable(schema);
    return await withPostgresMutation(pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [POSTGRES_DIAGNOSTIC_LOCK_DOMAIN],
      );
      const inserted = await client.query(
        `INSERT INTO ${table}(request_id,route_class,error_code,status,occurred_at)
         SELECT $1,$2,$3,$4,$5::timestamptz
          WHERE (SELECT count(*) FROM ${table}) < $6
         RETURNING id`,
        [
          diagnostic.requestId,
          diagnostic.routeClass,
          diagnostic.code,
          diagnostic.status,
          diagnostic.occurredAt,
          POSTGRES_DIAGNOSTIC_MAX_EVENTS,
        ],
      );
      return inserted.rowCount === 1;
    }, { operation: "diagnostics.record" });
  } catch {
    // Diagnostics cannot turn a useful error response into a second failure,
    // especially while the database itself is unhealthy.
    return false;
  }
}

/**
 * Delete diagnostics older than the 30-day retention window, at most
 * POSTGRES_DIAGNOSTIC_PRUNE_BATCH_SIZE rows per call, oldest first. Rows a
 * concurrent writer holds are skipped for a later pass. Scheduled maintenance
 * calls this and owns the completeness decision, so failures propagate.
 */
export async function prunePostgresDiagnosticErrors(
  pool: PostgresPool,
  schema: PostgresSchemaOptions | undefined,
  nowEpoch: number = Date.now(),
): Promise<number> {
  if (!validEpoch(nowEpoch)) throw new PostgresStorageError("invalid", "diagnostics.prune");
  const table = diagnosticTable(schema);
  const cutoff = new Date(
    nowEpoch - POSTGRES_DIAGNOSTIC_RETENTION_DAYS * DAY_MILLISECONDS,
  ).toISOString();
  return withPostgresMutation(pool, async (client) => {
    const result = await client.query<{ readonly pruned: number | string }>(
      `WITH expired AS (
         SELECT id FROM ${table}
          WHERE occurred_at < $1::timestamptz
          ORDER BY occurred_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ),
       pruned AS (
         DELETE FROM ${table} event
          USING expired
          WHERE event.id=expired.id
         RETURNING 1
       )
       SELECT count(*)::integer AS pruned FROM pruned`,
      [cutoff, POSTGRES_DIAGNOSTIC_PRUNE_BATCH_SIZE],
    );
    const pruned = Number(result.rows[0]?.pruned);
    if (!Number.isSafeInteger(pruned) || pruned < 0
        || pruned > POSTGRES_DIAGNOSTIC_PRUNE_BATCH_SIZE) {
      throw new PostgresStorageError("unavailable", "diagnostics.prune.result");
    }
    return pruned;
  }, { operation: "diagnostics.prune" });
}
