/**
 * GET /api/v1/admin/database-health over PostgreSQL (GCP, C-ADMIN): the
 * Worker's readAdminDatabaseHealth (admin-database-health.ts at d43c8f92)
 * with each D1 binding replaced by the pool of the same role.
 *
 * The DTO is the closed 'admin-database-health-v0.1' contract:
 * - the roles are always primary, deletion_ledger and analytics, in that
 *   order;
 * - a role whose pool the composition root does not supply is
 *   'not_configured', exactly as the Worker reports an absent binding (it is
 *   never aliased to another role or omitted);
 * - in json storage mode the analytics role is 'not_applicable';
 * - a probe is one constant read, bounded to 5 s: 'reachable' with its
 *   response time and pg_database_size of the connected database (the
 *   counterpart of D1's meta.size_after), 'timeout' when the deadline wins,
 *   'unavailable' on any failure;
 * - status is 'available' only when the storage mode parses and every role
 *   is reachable or not applicable, else 'degraded'.
 *
 * The probe reads no table, scans nothing and returns no database
 * identifier. As in the Worker, the deadline bounds the response, not the
 * already-admitted statement; the statement timeout bounds the latter.
 */
import type { PostgresClient, PostgresPool } from "./postgres-client";
import { withPostgresRead } from "./postgres-client";
import { parseTelemetryStorageMode } from "./telemetry-storage-mode";

export const POSTGRES_ADMIN_DATABASE_HEALTH_SCHEMA_VERSION = "admin-database-health-v0.1" as const;
/** d43c8f92 DATABASE_PROBE_TIMEOUT_MS. */
export const POSTGRES_DATABASE_PROBE_TIMEOUT_MS = 5_000;

export type PostgresAdminDatabaseRole = "primary" | "deletion_ledger" | "analytics";
export type PostgresAdminDatabaseStatus =
  | "reachable"
  | "unavailable"
  | "timeout"
  | "not_configured"
  | "not_applicable";

export interface PostgresAdminDatabaseRow {
  readonly role: PostgresAdminDatabaseRole;
  readonly status: PostgresAdminDatabaseStatus;
  readonly responseMs: number | null;
  readonly databaseBytes: number | null;
}

export interface PostgresAdminDatabaseHealth {
  readonly schemaVersion: typeof POSTGRES_ADMIN_DATABASE_HEALTH_SCHEMA_VERSION;
  readonly observedAt: string;
  readonly storageMode: "json" | "typed" | "unknown";
  readonly status: "available" | "degraded";
  readonly databases: readonly PostgresAdminDatabaseRow[];
}

export interface PostgresAdminDatabaseHealthOptions {
  /** The frozen Worker-shaped env; only the telemetry storage mode is read. */
  readonly env: unknown;
  /** The pool of each role, or undefined when the role has no database. */
  readonly pools: {
    readonly primary?: PostgresPool;
    readonly deletionLedger?: PostgresPool;
    readonly analytics?: PostgresPool;
  };
  /** Epoch milliseconds; defaults to Date.now. */
  readonly clock?: () => number;
  /** Test seam; defaults to POSTGRES_DATABASE_PROBE_TIMEOUT_MS. */
  readonly probeTimeoutMs?: number;
}

interface ProbeResult {
  readonly status: Exclude<PostgresAdminDatabaseStatus, "not_applicable">;
  readonly responseMs: number | null;
  readonly databaseBytes: number | null;
}

const EMPTY = Object.freeze({ responseMs: null, databaseBytes: null });
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;
const PROBE_SQL = "SELECT 1 AS reachable, pg_database_size(current_database())::text AS database_bytes";

function isPool(value: unknown): value is PostgresPool {
  return value !== null && typeof value === "object"
    && typeof Reflect.get(value, "connect") === "function";
}

function nullableBytes(value: unknown): number | null {
  if (typeof value !== "string" || !DECIMAL.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

async function probe(
  pool: unknown,
  clock: () => number,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (!isPool(pool)) return { status: "not_configured", ...EMPTY };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = clock();
  try {
    return await Promise.race([
      withPostgresRead(pool, async (client: PostgresClient) => {
        const result = await client.query<{ reachable: unknown; database_bytes: unknown }>(PROBE_SQL);
        const row = result.rows[0];
        if (result.rows.length !== 1 || row === undefined || Number(row.reachable) !== 1) {
          throw new Error("PROBE_FAILED");
        }
        return {
          status: "reachable" as const,
          responseMs: Math.max(0, clock() - start),
          databaseBytes: nullableBytes(row.database_bytes),
        };
      }, {
        operation: "admin_database_health.probe",
        statementTimeoutMilliseconds: timeoutMs,
        lockTimeoutMilliseconds: timeoutMs,
      }),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", ...EMPTY }), timeoutMs);
      }),
    ]);
  } catch {
    return { status: "unavailable", ...EMPTY };
  } finally {
    clearTimeout(timer);
  }
}

/** The Worker DTO for the three roles; never throws for a probe failure. */
export async function readPostgresAdminDatabaseHealth(
  options: PostgresAdminDatabaseHealthOptions,
): Promise<PostgresAdminDatabaseHealth> {
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.probeTimeoutMs ?? POSTGRES_DATABASE_PROBE_TIMEOUT_MS;
  if (typeof clock !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("invalid admin database health options");
  }
  let storageMode: "json" | "typed" | "unknown" = "unknown";
  try {
    storageMode = parseTelemetryStorageMode((options.env ?? {}) as Parameters<
      typeof parseTelemetryStorageMode
    >[0]).kind;
  } catch {
    // Keep the other roles visible, as the Worker does.
  }
  const pools = options.pools ?? {};
  const [primary, deletion, analytical] = await Promise.all([
    probe(pools.primary, clock, timeoutMs),
    probe(pools.deletionLedger, clock, timeoutMs),
    storageMode === "json"
      ? Promise.resolve({ status: "not_applicable" as const, ...EMPTY })
      : probe(pools.analytics, clock, timeoutMs),
  ]);
  const databases: PostgresAdminDatabaseRow[] = [
    { role: "primary", ...primary },
    { role: "deletion_ledger", ...deletion },
    { role: "analytics", ...analytical },
  ];
  return {
    schemaVersion: POSTGRES_ADMIN_DATABASE_HEALTH_SCHEMA_VERSION,
    observedAt: new Date(clock()).toISOString(),
    storageMode,
    status: storageMode !== "unknown" && databases.every((row) =>
      row.status === "reachable" || row.status === "not_applicable") ? "available" : "degraded",
    databases,
  };
}
