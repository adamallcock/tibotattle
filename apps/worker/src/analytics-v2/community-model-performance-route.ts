/**
 * GET /api/v1/community/model-performance over the analytics_v2 heads
 * (community model speed, owner decisions 2026-10-10; GATE-Q 5).
 *
 * An origin route module that serves one published community-model-
 * performance-v1 slot (period x speed mode) from
 * analytics_v2_published_performance (primary 0079), the twelve heads that
 * store-publication.ts writeAnalyticsV2PublishedPerformance maintains. Its
 * request handling follows community-daily-route.ts (method, query, control,
 * limiter, snapshot and cache handling) and nothing else of that module: the
 * daily allowance, preview, cache-retention and interim-export logic does not
 * apply here.
 *
 * - GET only (405 METHOD_NOT_ALLOWED with allow: GET).
 * - The publication collection control is asserted first through the AA-0
 *   PostgreSQL reader: 503 PUBLICATION_DISABLED, or
 *   COLLECTION_CONTROL_UNAVAILABLE when the controls cannot be read.
 * - The injected public-read limiter then runs exactly once, at the Worker's
 *   call point (after the control, before the query is validated), so the
 *   edge's replayed admission outcome is consumed where the Worker consumes
 *   it: allowed reads on, limited is 429 ATTEMPT_LIMIT_REACHED and
 *   unavailable is 503 ADMISSION_RATE_LIMIT_UNAVAILABLE, each with its
 *   retry-after.
 * - The query is exactly `period` (1, 7, 30 or all) and `speedMode`
 *   (standard, fast or ultrafast), each once. A missing, repeated or unknown
 *   key, or any other value, is 400 BODY_INVALID.
 * - One REPEATABLE READ READ ONLY snapshot reads the slot's single head row by
 *   its primary key. No row is 404 COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED:
 *   nothing is published yet (GATE-Q 12), which is a normal public state and
 *   never a 5xx (origin-5xx-ratio counts every public read).
 * - The row is verified before it is served: its slot equals the request;
 *   payload_sha256 equals the store's content digest
 *   (performance-publication-contract.ts analyticsV2PerformanceContentSha256,
 *   the payload without revision and generatedAt); the stamped revision equals
 *   the row's revision and generatedAt equals its released_at; and the
 *   payload passes parseCommunityModelPerformance. A failed read or any
 *   failed check is 503 BACKEND_STORAGE_UNAVAILABLE.
 * - A verified head is 200 with Cache-Control `public, max-age=300` and the
 *   payload itself (canonical key order), the body the public client's
 *   normalizeCommunityModelPerformance reads. Every other answer is the
 *   production error envelope with `no-store`, so only a verified 200 is
 *   publicly cacheable.
 *
 * The read has no time dependence (the store stamps the window), so the
 * module takes no clock. Not handled here, and why: the PUBLIC_ANALYTICS
 * switch (mounting this module is the origin's switch; the edge answers
 * PUBLIC_ANALYTICS_MODE) and the limiter's binding (injected by the
 * composition root as assertPublicReadAllowed over the edge replay).
 *
 * This module never logs, and its responses carry aggregates only.
 */
import { parseCommunityModelPerformance } from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "../canonical-json";
import { ApiError, errorResponse, jsonResponse } from "../errors";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresPool,
} from "../postgres-client";
import { assertPostgresCollectionControlFromPool } from "../postgres-collection-controls";
import type { OriginRouteModule } from "./contract";
import {
  ANALYTICS_V2_PERFORMANCE_PERIODS,
  ANALYTICS_V2_PERFORMANCE_SPEED_MODES,
  ANALYTICS_V2_PERFORMANCE_TABLES,
  analyticsV2PerformanceContentSha256,
  type AnalyticsV2PerformancePeriod,
  type AnalyticsV2PerformanceSpeedMode,
} from "./performance-publication-contract";

export const ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PATH = "/api/v1/community/model-performance" as const;
export const ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PUBLIC_CACHE_CONTROL = "public, max-age=300" as const;
/** The query keys, each required exactly once. */
export const ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_QUERY_KEYS: readonly string[] = Object.freeze([
  "period",
  "speedMode",
]);

/** The root request context's id form (cloud-run/postgres-request-context.mjs). */
const ROOT_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_REVISION = /^[1-9][0-9]{0,9}$/u;
const READ_TIMEOUT_MILLISECONDS = 5_000;
const OPTION_KEYS: ReadonlySet<string> = new Set(["pool", "schema", "assertPublicReadAllowed"]);

export interface AnalyticsV2CommunityModelPerformanceRouteOptions {
  readonly pool: PostgresPool;
  /** The primary runtime schema holding analytics_v2_published_performance and collection_controls. */
  readonly schema: string;
  /**
   * The Worker's public-read limiter for this request (admission.ts
   * assertPublicAggregateReadAllowed over the composition's binding, the
   * edge's replayed outcome). Its ApiError (429 or 503 with retry-after) is
   * the route's answer. Required: a public read is never unlimited.
   */
  readonly assertPublicReadAllowed: (request: Request) => Promise<void>;
}

/** The route-module shape; the composition root registers its handler. */
export interface AnalyticsV2CommunityModelPerformanceRoute extends OriginRouteModule {
  readonly method: "GET";
  readonly pathname: typeof ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PATH;
  /** No built-in serves this path; it is a new owner-decided route. */
  readonly overridesBuiltIn: false;
}

interface StoredHeadRow {
  readonly period: unknown;
  readonly speed_mode: unknown;
  readonly revision: unknown;
  readonly released_at: unknown;
  readonly payload_text: unknown;
  readonly payload_sha256: unknown;
}

interface Slot {
  readonly period: AnalyticsV2PerformancePeriod;
  readonly speedMode: AnalyticsV2PerformanceSpeedMode;
}

function configurationError(): never {
  throw new Error("ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_CONFIGURATION_INVALID");
}

function bodyInvalid(): never {
  throw new ApiError(400, "BODY_INVALID");
}

function storageUnavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The requested slot: exactly one `period` and one `speedMode`, nothing else. */
function requestedSlot(url: string): Slot {
  const parameters = new URL(url).searchParams;
  const seen = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (!ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_QUERY_KEYS.includes(name) || seen.has(name)) bodyInvalid();
    seen.set(name, value);
  }
  const period = seen.get("period");
  const speedMode = seen.get("speedMode");
  if (!(ANALYTICS_V2_PERFORMANCE_PERIODS as readonly unknown[]).includes(period)
      || !(ANALYTICS_V2_PERFORMANCE_SPEED_MODES as readonly unknown[]).includes(speedMode)) {
    bodyInvalid();
  }
  return {
    period: period as AnalyticsV2PerformancePeriod,
    speedMode: speedMode as AnalyticsV2PerformanceSpeedMode,
  };
}

// One indexed row by the primary key (period, speed_mode). released_at is
// rendered at millisecond precision in UTC, the form the store stamps into
// generatedAt; jsonb is read as text and canonicalized here rather than
// trusting the driver's type parsers.
function headSql(schema: string): string {
  const relation = `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(
    ANALYTICS_V2_PERFORMANCE_TABLES.publishedPerformance)}`;
  return `SELECT h.period::text AS period,
       h.speed_mode::text AS speed_mode,
       h.revision::text AS revision,
       to_char(h.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS released_at,
       h.payload::text AS payload_text,
       h.payload_sha256::text AS payload_sha256
  FROM ${relation} h
 WHERE h.period = $1 AND h.speed_mode = $2`;
}

/** The slot's head row, or null when nothing is published for it. */
async function readHead(pool: PostgresPool, schema: string, slot: Slot): Promise<StoredHeadRow | null> {
  return withPostgresRead(pool, async (client) => {
    const result = await client.query<StoredHeadRow>(headSql(schema), [slot.period, slot.speedMode]);
    if (!Array.isArray(result?.rows) || result.rows.length > 1) storageUnavailable();
    return result.rows[0] ?? null;
  }, {
    operation: "analytics_v2.community_model_performance.read",
    statementTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    lockTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
  });
}

/**
 * Verify one stored head against its slot, its digest, its stamps and the
 * public contract, and return the payload in canonical key order. Anything
 * else is storage corruption, never a client error.
 */
async function verifiedPayload(row: StoredHeadRow, slot: Slot): Promise<unknown> {
  if (row === null || typeof row !== "object"
      || row.period !== slot.period || row.speed_mode !== slot.speedMode
      || typeof row.revision !== "string" || !DECIMAL_REVISION.test(row.revision)
      || typeof row.released_at !== "string" || !Number.isFinite(Date.parse(row.released_at))
      || typeof row.payload_text !== "string"
      || typeof row.payload_sha256 !== "string" || !SHA256_PATTERN.test(row.payload_sha256)) {
    storageUnavailable();
  }
  const revision = Number(row.revision);
  let stored: unknown;
  try {
    stored = JSON.parse(row.payload_text);
  } catch {
    storageUnavailable();
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) storageUnavailable();
  const fields = stored as Record<string, unknown>;
  if (fields.period !== slot.period || fields.speedMode !== slot.speedMode
      || fields.revision !== revision || fields.generatedAt !== row.released_at) {
    storageUnavailable();
  }
  try {
    if (await analyticsV2PerformanceContentSha256(stored) !== row.payload_sha256) storageUnavailable();
    parseCommunityModelPerformance(stored);
    return JSON.parse(canonicalJson(stored));
  } catch {
    return storageUnavailable();
  }
}

/**
 * Build the community model-performance route module. Throws at
 * construction on unknown options, an invalid pool or schema, or a missing
 * public-read limiter.
 */
export function createAnalyticsV2CommunityModelPerformanceRoute(
  options: AnalyticsV2CommunityModelPerformanceRouteOptions,
): AnalyticsV2CommunityModelPerformanceRoute {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !OPTION_KEYS.has(key))) {
    configurationError();
  }
  const { pool, schema, assertPublicReadAllowed } = options;
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") configurationError();
  try {
    quotePostgresIdentifier(schema);
  } catch {
    configurationError();
  }
  if (typeof assertPublicReadAllowed !== "function") configurationError();

  async function serve(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", { responseHeaders: { allow: "GET" } });
    }
    await assertPostgresCollectionControlFromPool(pool, schema, "publication");
    // The Worker's call point: after the publication control, before the
    // query is validated, exactly once per request that reaches it.
    await assertPublicReadAllowed(request);
    const slot = requestedSlot(request.url);
    let row: StoredHeadRow | null;
    try {
      row = await readHead(pool, schema, slot);
    } catch {
      storageUnavailable();
    }
    if (row === null) throw new ApiError(404, "COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED");
    const payload = await verifiedPayload(row, slot);
    return jsonResponse(payload, 200, {
      "cache-control": ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PUBLIC_CACHE_CONTROL,
    });
  }

  async function handler(request: Request, context?: unknown): Promise<Response> {
    // The root's request id (the route context carries it per request), so
    // the error body matches the origin's log line.
    const rootRequestId: unknown = context !== null && typeof context === "object"
      ? Reflect.get(context, "requestId") : undefined;
    const requestId = typeof rootRequestId === "string" && ROOT_REQUEST_ID.test(rootRequestId)
      ? rootRequestId : crypto.randomUUID();
    try {
      return await serve(request);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR");
      return noStore(errorResponse(apiError, requestId));
    }
  }

  return Object.freeze({
    method: "GET",
    pathname: ANALYTICS_V2_COMMUNITY_MODEL_PERFORMANCE_PATH,
    overridesBuiltIn: false,
    handler,
  });
}
