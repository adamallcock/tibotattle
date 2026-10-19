/**
 * Best-effort, content-free refusal counters for the restored accountless
 * performance intake (owner decision 2026-10-10; GATE-Q 6).
 *
 * The origin route family (cloud-run/routes/performance-telemetry.mjs)
 * calls this once for every 4xx or 5xx answer it gives after the device has
 * authenticated. Each call adds one to telemetry_performance_refusal_counts
 * for (UTC day of the clock, route id, closed response code, status). The
 * table has no participant, device, report or request column, so nothing
 * here can carry an identifier, a bearer, a body or plaintext.
 *
 * It is a separate short transaction, never the request's own: a refusal
 * has usually rolled its transaction back, and a counter must never widen
 * what the request wrote. Statement and lock timeouts are about one second,
 * and the whole call (pool connect included) is raced against the same
 * bound, so a locked or unavailable table delays a refusal by at most that
 * and never changes it. Every failure is swallowed: the function never
 * throws and logs nothing. It resolves true only when the increment
 * committed.
 */

import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresPool,
  type PostgresSchemaConfig,
} from "./postgres-client";

/** The three intake route ids the counter table's CHECK admits. */
export const POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_ROUTE_IDS = Object.freeze([
  "accountless_telemetry_performance_authorization",
  "telemetry_performance_capabilities",
  "telemetry_performance_reports",
] as const);

export type PostgresTelemetryPerformanceRefusalRouteId =
  typeof POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_ROUTE_IDS[number];

/** The recorder's whole bound: statement, lock and wall clock. */
export const POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_TIMEOUT_MILLISECONDS = 1_000;

/** The counter table's code CHECK: a closed upper-case code of 2 to 64 characters. */
const CLOSED_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const ROUTE_IDS: ReadonlySet<string> = new Set(POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_ROUTE_IDS);

export interface PostgresTelemetryPerformanceRefusal {
  readonly schema?: PostgresSchemaConfig;
  readonly routeId: PostgresTelemetryPerformanceRefusalRouteId;
  readonly code: string;
  readonly status: number;
  readonly nowEpoch: number;
}

function utcDay(nowEpoch: number): string | null {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) return null;
  const date = new Date(nowEpoch);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Record one refusal. Invalid input (an unknown route, a code outside the
 * table's CHECK, a status outside 400..599 or a bad clock) writes nothing.
 * Never throws; resolves whether the increment committed.
 */
export async function recordPostgresTelemetryPerformanceRefusal(
  pool: PostgresPool,
  refusal: PostgresTelemetryPerformanceRefusal,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { routeId, code, status, nowEpoch } = refusal;
    const day = utcDay(nowEpoch);
    if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
        || typeof routeId !== "string" || !ROUTE_IDS.has(routeId)
        || typeof code !== "string" || !CLOSED_CODE.test(code)
        || !Number.isSafeInteger(status) || status < 400 || status > 599
        || day === null) {
      return false;
    }
    const schema = quotePostgresIdentifier(createPostgresSchemaConfig(refusal.schema ?? {}).primarySchema);
    const table = `${schema}.${quotePostgresIdentifier("telemetry_performance_refusal_counts")}`;
    const increment = withPostgresMutation(pool, async (client) => {
      const result = await client.query(
        `INSERT INTO ${table} (day, route_id, code, status, refusals)
         VALUES ($1::date, $2, $3, $4, 1)
         ON CONFLICT (day, route_id, code, status)
         DO UPDATE SET refusals = ${table}.refusals + 1`,
        [day, routeId, code, status],
      );
      return result.rowCount === 1;
    }, {
      operation: "telemetry_performance.refusal_count",
      statementTimeoutMilliseconds: POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_TIMEOUT_MILLISECONDS,
    }).catch(() => false);
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), POSTGRES_TELEMETRY_PERFORMANCE_REFUSAL_TIMEOUT_MILLISECONDS);
    });
    return await Promise.race([increment, bound]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
