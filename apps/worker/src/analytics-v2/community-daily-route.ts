/**
 * GET /api/v1/community/daily over the analytics_v2 tables (GCP fast path, A-4).
 *
 * An origin route module (IN-1 seam) that replaces the built-in PostgreSQL
 * test reader and reproduces the production Worker's handleCommunityDaily at
 * d43c8f92 (apps/worker/src/index.ts:3972-4110) in typed-storage mode, where
 * the daily read carries no allowance publication state:
 *
 * - GET only; only `from` and `to` are accepted, each a real calendar day in
 *   YYYY-MM-DD, spanning 1..366 days, else 400 BODY_INVALID;
 * - the publication collection control is asserted first through the AA-0
 *   PostgreSQL reader (503 PUBLICATION_DISABLED, or
 *   COLLECTION_CONTROL_UNAVAILABLE when the controls cannot be read);
 * - published days come from analytics_v2_published_daily in one REPEATABLE
 *   READ READ ONLY snapshot; any failure of that read, a payload whose content
 *   digest differs from payload_sha256, or revision fields (aggregateId,
 *   revision, releasedAt, day) that disagree with the row, is 503
 *   BACKEND_STORAGE_UNAVAILABLE;
 * - each payload is served in production's canonical key order with
 *   capacityByPlanType removed, apiEquivalentSpend removed unless it is
 *   current-price evidence matching totals.usageEvents, and allowance always
 *   removed (typed storage never has a current daily allowance publication);
 * - allowanceBreakdowns is the vendored projectPublicAllowanceGraph over the
 *   stored admin preview; allowanceReadState is `temporarily_unavailable`
 *   whenever the preview is absent, unreadable, oversized or fails the
 *   vendored cache validation, and allowanceState is `ready` exactly when the
 *   projection yields at least one closed published day;
 * - cacheRetention is composed at request time from analytics_v2_cache_bands
 *   (cache-windows-sql.ts), omitted when no window has evidence or the read
 *   fails, and withheld unless it is the full 4-window x 10-band shape;
 * - Cache-Control is `public, max-age=300`, or `no-store` when the allowance
 *   read is temporarily unavailable; every error is production's envelope
 *   with `no-store`.
 *
 * Not ported, and why: the PUBLIC_ANALYTICS environment switch (mounting this
 * module is the GCP switch), the public read rate limiter (an edge concern),
 * and production's per-row authority and containment fences plus preview
 * freshness columns (analytics-refresh writes every analytics_v2 family in one
 * transaction, and there are no withdrawals under the append-only decision).
 *
 * The clock defaults to Date.now. An injected clock is a test seam only: it is
 * accepted when the composition root reports the loopback `fastpath-test`
 * origin mode, and construction throws in every other mode.
 *
 * This module never logs, and its responses carry aggregates only.
 */
import { canonicalJson } from "../canonical-json";
import { sha256Hex } from "../crypto";
import { ApiError, errorResponse, jsonResponse } from "../errors";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
} from "../postgres-client";
import { assertPostgresCollectionControlFromPool } from "../postgres-collection-controls";
import {
  CACHE_RETENTION_METHOD,
  CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,
  CACHE_RETENTION_WINDOWS,
  isCurrentCommunityDailySpend,
  projectPublicAllowanceGraph,
  validCachedAdminCommunityAllowancePreview,
  type PublicAllowanceBreakdownsCacheRow,
  type PublicCacheRetentionSeries,
} from "../../vendor/analytics-d43c8f92/entry";
// Not re-exported by the vendor facade (entry.ts); the same vendored d43c8f92
// module projectPublicAllowanceGraph and the cache validator read it from.
import { PREVIEW_CACHE_JSON_LIMIT_BYTES } from "../../vendor/analytics-d43c8f92/apps/worker/src/admin-community-allowance";
import {
  ANALYTICS_V2_CACHE_RETENTION_BAND_IDS,
  composeAnalyticsV2CacheRetentionSeries,
  readAnalyticsV2CacheWindowRows,
  type AnalyticsV2CacheWindowRows,
} from "./cache-windows-sql";
import { ANALYTICS_V2_SINGLETON_ID, ANALYTICS_V2_TABLES, type OriginRouteModule } from "./contract";

export const ANALYTICS_V2_COMMUNITY_DAILY_PATH = "/api/v1/community/daily" as const;
export const ANALYTICS_V2_COMMUNITY_DAILY_SCHEMA_VERSION = "community-daily-read-v1.0" as const;
export const ANALYTICS_V2_COMMUNITY_DAILY_MAX_RANGE_DAYS = 366;
export const ANALYTICS_V2_COMMUNITY_DAILY_PUBLIC_CACHE_CONTROL = "public, max-age=300" as const;

/**
 * Origin modes (POSTGRES_TEST_HTTP_MODE as the composition root parsed it) in
 * which an injected clock is accepted: the local loopback fast-path test
 * origin only. The deployed IAM test service and production use Date.now.
 */
export const ANALYTICS_V2_TEST_CLOCK_ORIGIN_MODES: readonly string[] = Object.freeze(["fastpath-test"]);

/**
 * Payload fields analytics-refresh assigns at publication (A-3 store.ts):
 * payload_sha256 digests the canonical payload without them, and each must
 * agree with its row (aggregateId is community-daily:<day>:r<revision>).
 */
export const ANALYTICS_V2_DAILY_REVISION_FIELDS: readonly string[] = Object.freeze([
  "aggregateId",
  "revision",
  "releasedAt",
]);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_REVISION = /^[1-9][0-9]{0,15}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_TIMEOUT_MILLISECONDS = 5_000;
const OPTION_KEYS: ReadonlySet<string> = new Set(["pool", "schema", "clock", "originMode"]);

export interface AnalyticsV2CommunityDailyRouteOptions {
  readonly pool: PostgresPool;
  /** The primary runtime schema holding analytics_v2_* and collection_controls. */
  readonly schema: string;
  /** Test seam; accepted only in ANALYTICS_V2_TEST_CLOCK_ORIGIN_MODES. */
  readonly clock?: () => number;
  /** The origin's POSTGRES_TEST_HTTP_MODE, or null/undefined outside test hosting. */
  readonly originMode?: string | null;
}

/** The IN-1 route-module shape; the composition root wraps it with defineOriginRouteModule(). */
export interface AnalyticsV2CommunityDailyRoute extends OriginRouteModule {
  readonly method: "GET";
  readonly pathname: typeof ANALYTICS_V2_COMMUNITY_DAILY_PATH;
  readonly overridesBuiltIn: true;
}

interface StoredDailyRow {
  readonly day: unknown;
  readonly revision: unknown;
  readonly released_at: unknown;
  readonly payload_text: unknown;
  readonly payload_sha256: unknown;
}

interface StoredRead {
  readonly rows: readonly StoredDailyRow[];
  /** The preview's jsonb text, null when absent, or undefined when its read failed. */
  readonly previewText: string | null | undefined;
  /** The cache windows, or null when their read failed. */
  readonly cacheWindows: readonly AnalyticsV2CacheWindowRows[] | null;
}

interface PublishedDay {
  readonly day: string;
  readonly revision: number;
  readonly releasedAt: string;
  payload: unknown;
}

function configurationError(code: string): never {
  throw new Error(code);
}

function bodyInvalid(): never {
  throw new ApiError(400, "BODY_INVALID");
}

function storageUnavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

/** Byte-for-byte production communityDailyRangeDay. */
function rangeDay(value: string | null): string {
  if (value === null || !DAY_PATTERN.test(value)) bodyInvalid();
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  // The round-trip comparison rejects calendar-impossible dates such as
  // 2026-02-31 that Date.parse silently normalizes.
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    bodyInvalid();
  }
  return value;
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

function table(schema: string, name: string): string {
  return `${quotePostgresIdentifier(schema)}.${quotePostgresIdentifier(name)}`;
}

// `day` and `released_at` are cast so the statement serves the same strings
// whether the columns are date/timestamptz or ISO text; jsonb is read as text
// and canonicalized here rather than trusting the driver's type parsers.
function dailySql(schema: string): string {
  return `SELECT to_char(p.day::date, 'YYYY-MM-DD') AS day,
       p.revision::text AS revision,
       to_char(p.released_at::timestamptz AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS released_at,
       p.payload::text AS payload_text,
       p.payload_sha256::text AS payload_sha256
  FROM ${table(schema, ANALYTICS_V2_TABLES.publishedDaily)} p
 WHERE p.day::date BETWEEN $1::date AND $2::date
 ORDER BY p.day::date`;
}

function previewSql(schema: string): string {
  return `SELECT v.preview::text AS preview_text
  FROM ${table(schema, ANALYTICS_V2_TABLES.preview)} v
 WHERE v.id = ${ANALYTICS_V2_SINGLETON_ID}`;
}

/**
 * Run one optional read under a savepoint so its failure degrades exactly as
 * production's optional graph and cache reads do, without aborting the
 * snapshot that already holds the required daily rows.
 */
async function optionalRead<T>(
  client: PostgresClient,
  savepoint: string,
  read: () => Promise<T>,
): Promise<T | undefined> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const value = await read();
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch {
    // A failure of the rollback itself propagates: the connection is unusable
    // and the whole read is then storage-unavailable.
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return undefined;
  }
}

async function readStored(
  pool: PostgresPool,
  schema: string,
  from: string,
  to: string,
  nowMs: number,
): Promise<StoredRead> {
  return withPostgresRead(pool, async (client) => {
    const daily = await client.query<StoredDailyRow>(dailySql(schema), [from, to]);
    if (!Array.isArray(daily?.rows)) storageUnavailable();
    const preview = await optionalRead(client, "analytics_v2_preview_read", async () => {
      const result = await client.query<{ preview_text: unknown }>(previewSql(schema));
      if (!Array.isArray(result?.rows) || result.rows.length > 1) throw new Error("preview shape");
      const text = result.rows[0]?.preview_text ?? null;
      if (text !== null && typeof text !== "string") throw new Error("preview shape");
      return text;
    });
    const cacheWindows = await optionalRead(client, "analytics_v2_cache_read",
      () => readAnalyticsV2CacheWindowRows(client, schema, nowMs));
    return {
      rows: daily.rows,
      previewText: preview,
      cacheWindows: cacheWindows ?? null,
    };
  }, {
    operation: "analytics_v2.community_daily.read",
    statementTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    lockTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
  });
}

/** Verify one stored row and return it in production's served order and key order. */
async function publishedDay(row: StoredDailyRow, from: string, to: string): Promise<PublishedDay> {
  if (row === null || typeof row !== "object"
      || typeof row.day !== "string" || !DAY_PATTERN.test(row.day) || row.day < from || row.day > to
      || typeof row.revision !== "string" || !DECIMAL_REVISION.test(row.revision)
      || typeof row.released_at !== "string" || !Number.isFinite(Date.parse(row.released_at))
      || typeof row.payload_text !== "string"
      || typeof row.payload_sha256 !== "string" || !SHA256_PATTERN.test(row.payload_sha256)) {
    storageUnavailable();
  }
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision)) storageUnavailable();
  let stored: unknown;
  try {
    stored = JSON.parse(row.payload_text);
  } catch {
    storageUnavailable();
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) storageUnavailable();
  // Production verifies sha256(payload_json) over the whole canonical payload.
  // analytics_v2 digests the content without the store-assigned revision
  // fields, so the same guarantee is the content digest plus those fields
  // agreeing exactly with the row. Anything else is storage corruption, not a
  // client error.
  const fields = stored as Record<string, unknown>;
  const content = Object.fromEntries(Object.entries(fields)
    .filter(([key]) => !ANALYTICS_V2_DAILY_REVISION_FIELDS.includes(key)));
  if (fields.day !== row.day || fields.revision !== revision
      || fields.aggregateId !== `community-daily:${row.day}:r${revision}`
      || fields.releasedAt !== row.released_at
      || await sha256Hex(canonicalJson(content)) !== row.payload_sha256) {
    storageUnavailable();
  }
  let payload: unknown;
  try {
    // Production serves JSON.parse(canonicalJson(payload)): canonical key order.
    payload = JSON.parse(canonicalJson(stored));
  } catch {
    // Published rows are digest-stamped and immutable; production answers an
    // unparseable payload with 500 INTERNAL_ERROR.
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  return { day: row.day, revision, releasedAt: row.released_at, payload };
}

/**
 * The stored preview as production's typed-storage graph read returns it: a
 * cache row only when the canonical payload is within the byte limit and
 * passes the vendored cache validation at nowMs, else null.
 */
function previewCacheRow(previewText: string | null | undefined, nowMs: number): PublicAllowanceBreakdownsCacheRow | null {
  if (typeof previewText !== "string") return null;
  let preview: unknown;
  try {
    preview = JSON.parse(previewText);
  } catch {
    return null;
  }
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return null;
  const generatedAt = (preview as Record<string, unknown>).generatedAt;
  if (typeof generatedAt !== "string") return null;
  const payloadJson = canonicalJson(preview);
  if (new TextEncoder().encode(payloadJson).byteLength > PREVIEW_CACHE_JSON_LIMIT_BYTES) return null;
  if (!validCachedAdminCommunityAllowancePreview(JSON.parse(payloadJson), generatedAt, nowMs)) return null;
  return { payload_json: payloadJson, generated_at: generatedAt };
}

/**
 * Production's boundary gate on the cache-retention series: the current
 * public schema and method, all four windows, and the whole band vocabulary in
 * every window and every model inside it. Anything else is withheld whole.
 */
export function publishableAnalyticsV2CacheRetentionSeries(
  series: PublicCacheRetentionSeries | null,
): PublicCacheRetentionSeries | null {
  return series !== null
    && series.schemaVersion === CACHE_RETENTION_PUBLIC_SCHEMA_VERSION
    && series.methodVersion === CACHE_RETENTION_METHOD.version
    && series.windows.length === CACHE_RETENTION_WINDOWS.length
    && series.windows.every((window) => window.bands.length === ANALYTICS_V2_CACHE_RETENTION_BAND_IDS.length
      && window.byModel.every((model) => model.bands.length === ANALYTICS_V2_CACHE_RETENTION_BAND_IDS.length))
    ? series : null;
}

function composedCacheRetention(windows: readonly AnalyticsV2CacheWindowRows[] | null): PublicCacheRetentionSeries | null {
  if (windows === null) return null;
  try {
    // Absence is reported as absence, and a row the vendored validation
    // refuses withholds the series, exactly as production's read does.
    return composeAnalyticsV2CacheRetentionSeries(windows);
  } catch {
    return null;
  }
}

/** Remove the private and non-current fields exactly as production does. */
function publicDayPayload(day: PublishedDay): void {
  if (typeof day.payload !== "object" || day.payload === null || Array.isArray(day.payload)) return;
  const publicPayload = { ...day.payload as Record<string, unknown> };
  // The old diagnostic shape remains private. Only the separate validated
  // allowanceBreakdowns contract exposes plan/model dollar estimates.
  delete publicPayload.capacityByPlanType;
  const spend = publicPayload.apiEquivalentSpend;
  const totals = publicPayload.totals;
  if (!isCurrentCommunityDailySpend(spend) || !totals || typeof totals !== "object"
      || Array.isArray(totals) || (totals as Record<string, unknown>).usageEvents !== spend.usageEvents) {
    delete publicPayload.apiEquivalentSpend;
  }
  // Typed storage carries no current daily allowance publication, so the
  // per-day allowance block is never public (production dailyAllowanceReady
  // is false for every storage-mode read).
  delete publicPayload.allowance;
  day.payload = publicPayload;
}

/**
 * Build the community/daily route module. Throws at construction on an
 * invalid pool or schema, unknown options, or an injected clock outside the
 * loopback fast-path test mode.
 */
export function createAnalyticsV2CommunityDailyRoute(
  options: AnalyticsV2CommunityDailyRouteOptions,
): AnalyticsV2CommunityDailyRoute {
  if (options === null || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).some((key) => !OPTION_KEYS.has(key))) {
    configurationError("ANALYTICS_V2_COMMUNITY_DAILY_CONFIGURATION_INVALID");
  }
  const { pool, schema, clock, originMode } = options;
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    configurationError("ANALYTICS_V2_COMMUNITY_DAILY_CONFIGURATION_INVALID");
  }
  try {
    quotePostgresIdentifier(schema);
  } catch {
    configurationError("ANALYTICS_V2_COMMUNITY_DAILY_CONFIGURATION_INVALID");
  }
  if (originMode !== undefined && originMode !== null && typeof originMode !== "string") {
    configurationError("ANALYTICS_V2_COMMUNITY_DAILY_CONFIGURATION_INVALID");
  }
  let now: () => number = Date.now;
  if (clock !== undefined) {
    if (typeof originMode !== "string" || !ANALYTICS_V2_TEST_CLOCK_ORIGIN_MODES.includes(originMode)) {
      configurationError("ANALYTICS_V2_COMMUNITY_DAILY_TEST_CLOCK_REFUSED");
    }
    if (typeof clock !== "function") {
      configurationError("ANALYTICS_V2_COMMUNITY_DAILY_CONFIGURATION_INVALID");
    }
    now = clock;
  }

  async function serve(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", { responseHeaders: { allow: "GET" } });
    }
    await assertPostgresCollectionControlFromPool(pool, schema, "publication");
    const parameters = new URL(request.url).searchParams;
    for (const name of parameters.keys()) {
      if (name !== "from" && name !== "to") bodyInvalid();
    }
    const from = rangeDay(parameters.get("from"));
    const to = rangeDay(parameters.get("to"));
    const rangeDays = 1 + Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
    );
    if (rangeDays < 1 || rangeDays > ANALYTICS_V2_COMMUNITY_DAILY_MAX_RANGE_DAYS) bodyInvalid();
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ApiError(500, "INTERNAL_ERROR");

    let read: StoredRead;
    try {
      read = await readStored(pool, schema, from, to, nowMs);
    } catch {
      storageUnavailable();
    }
    if (read.rows.length > ANALYTICS_V2_COMMUNITY_DAILY_MAX_RANGE_DAYS) storageUnavailable();
    const days: PublishedDay[] = [];
    for (const row of read.rows) days.push(await publishedDay(row, from, to));
    if (days.some((day, index) => index > 0 && days[index - 1]!.day >= day.day)) storageUnavailable();

    const cache = previewCacheRow(read.previewText, nowMs);
    const allowanceReadState = cache === null ? "temporarily_unavailable" : "confirmed";
    const graph = projectPublicAllowanceGraph(cache, {
      publishedDays: days.map((day) => day.day), nowMs,
    });
    const allowanceState = graph !== null ? "ready" : "updating";
    const allowanceBreakdowns = graph?.breakdowns ?? null;
    for (const day of days) publicDayPayload(day);
    const cacheRetention = publishableAnalyticsV2CacheRetentionSeries(
      composedCacheRetention(read.cacheWindows),
    );
    return jsonResponse(
      {
        schemaVersion: ANALYTICS_V2_COMMUNITY_DAILY_SCHEMA_VERSION,
        from,
        to,
        allowanceState,
        allowanceReadState,
        ...(allowanceBreakdowns === null ? {} : { allowanceBreakdowns }),
        ...(cacheRetention === null ? {} : { cacheRetention }),
        days,
      },
      200,
      {
        "cache-control": allowanceReadState === "temporarily_unavailable"
          ? "no-store" : ANALYTICS_V2_COMMUNITY_DAILY_PUBLIC_CACHE_CONTROL,
      },
    );
  }

  async function handler(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      return await serve(request);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR");
      return noStore(errorResponse(apiError, requestId));
    }
  }

  return Object.freeze({
    method: "GET",
    pathname: ANALYTICS_V2_COMMUNITY_DAILY_PATH,
    overridesBuiltIn: true,
    handler,
  });
}
