/**
 * GET /api/v1/admin/community/allowance-preview over analytics_v2 (GCP,
 * C-ADMIN).
 *
 * d43c8f92 handleAdminCommunityAllowancePreview in typed storage mode serves
 * readPublishedStorageCommunityAdminPreview: the stored canonical preview
 * payload, JSON-parsed, when it is within PREVIEW_CACHE_JSON_LIMIT_BYTES and
 * passes validCachedAdminCommunityAllowancePreview at the request time; else
 * null, which the route answers 503 ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE.
 *
 * On GCP the analytics-refresh job writes that same preview (built by the
 * current authored cross-owner buildAdminCommunityAllowancePreview) to the
 * analytics_v2_preview singleton, or NULL when a run could not build one.
 * This reader applies the same acceptance as the public community-daily
 * route's preview read (src/analytics-v2/community-daily-route.ts): canonical
 * JSON within the byte limit, the exact current or frozen legacy validator at nowMs, and
 * the payload returned in canonical key order (production stores and serves
 * canonicalJson(preview); jsonb does not keep key order).
 *
 * Not ported: production's per-row authority, containment and freshness
 * columns. analytics-refresh writes every analytics_v2 family in one
 * transaction and the append-only decision has no withdrawals, the same
 * basis the public route documents.
 *
 * A read failure is 503 BACKEND_STORAGE_UNAVAILABLE; an absent, NULL,
 * oversized, unparseable or invalid preview is null (never a stale or
 * partial preview, never zeros).
 */
import { canonicalJson } from "./canonical-json";
import { ApiError } from "./errors";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresPool,
} from "./postgres-client";
import { validReadableAdminCommunityAllowancePreview } from "./analytics-v2/allowance-projection";
// Not re-exported by the vendor facade; the same vendored module the
// validator and the public route read it from.
import { PREVIEW_CACHE_JSON_LIMIT_BYTES } from "../vendor/analytics-d43c8f92/apps/worker/src/admin-community-allowance";

const READ_TIMEOUT_MILLISECONDS = 5_000;

function storageUnavailable(): never {
  throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
}

function previewSql(schema: string): string {
  return `SELECT preview::text AS preview_text
  FROM ${quotePostgresIdentifier(schema)}."analytics_v2_preview"
 WHERE id = 1`;
}

/** Read the stored preview text: a string, or null when absent or NULL. */
async function readPreviewText(pool: PostgresPool, schema: string): Promise<string | null> {
  let sql: string;
  try {
    sql = previewSql(schema);
  } catch {
    return storageUnavailable();
  }
  try {
    return await withPostgresRead(pool, async (client) => {
      const result = await client.query<{ preview_text: unknown }>(sql);
      if (!Array.isArray(result?.rows) || result.rows.length > 1) throw new Error("preview shape");
      const text = result.rows[0]?.preview_text ?? null;
      if (text !== null && typeof text !== "string") throw new Error("preview shape");
      return text;
    }, {
      operation: "admin_allowance_preview.read",
      statementTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
      lockTimeoutMilliseconds: READ_TIMEOUT_MILLISECONDS,
    });
  } catch {
    return storageUnavailable();
  }
}

/**
 * The served preview for nowMs, or null when there is none to serve. The
 * returned object is a fresh parse of the canonical payload.
 */
export async function readPostgresAdminAllowancePreview(
  pool: PostgresPool,
  schema: string,
  nowMs: number,
): Promise<Record<string, unknown> | null> {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function"
      || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return storageUnavailable();
  }
  const text = await readPreviewText(pool, schema);
  if (text === null) return null;
  let preview: unknown;
  try {
    preview = JSON.parse(text);
  } catch {
    return null;
  }
  if (preview === null || typeof preview !== "object" || Array.isArray(preview)) return null;
  const generatedAt = (preview as Record<string, unknown>).generatedAt;
  if (typeof generatedAt !== "string") return null;
  const payloadJson = canonicalJson(preview);
  if (new TextEncoder().encode(payloadJson).byteLength > PREVIEW_CACHE_JSON_LIMIT_BYTES) return null;
  const served: unknown = JSON.parse(payloadJson);
  if (!validReadableAdminCommunityAllowancePreview(served, generatedAt, nowMs)) return null;
  return JSON.parse(payloadJson) as Record<string, unknown>;
}
