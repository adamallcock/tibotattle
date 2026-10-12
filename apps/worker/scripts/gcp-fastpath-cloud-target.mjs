/**
 * The one exception to a rehearsal importer's local-PostgreSQL guard: the GCP
 * fast-path seed's Cloud SQL target.
 *
 * Some importers accept only a local PostgreSQL 17 reached over its Unix
 * socket (inet_server_addr() IS NULL). The GCP fast-path seed
 * (scripts/gcp-fastpath-seed.mjs) runs the local rehearsal's importer chain
 * into Cloud SQL through the Cloud SQL Node connector, a TCP session, so such
 * an importer takes an explicit `cloudFastpathTarget: true` that only the seed
 * passes, and accepts the non-local session only when this check finds ALL of:
 *   - current_database() is the disposable fast-path database
 *     (GCP_FASTPATH_CONNECTION.database, never the shared `tibotattle`);
 *   - the target schema is a fast-path rehearsal target
 *     (typed_legacy_transfer_rehearsal_target_fastpath_<8 hex>, the seed's
 *     names);
 *   - the server is PostgreSQL 17;
 *   - neither the session user nor the current user is a superuser (Cloud SQL
 *     never grants one; a superuser session is a local cluster, which keeps
 *     the local-socket rule).
 * The importer's own prefix and disposable-schema guards still run first and
 * are not relaxed, and any other session keeps the importer's original
 * refusal and code.
 */

import { GCP_FASTPATH_CONNECTION } from "./gcp-fastpath-connection.mjs";
import { POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX } from "./postgres-typed-legacy-transfer.mjs";

export const GCP_FASTPATH_CLOUD_TARGET = Object.freeze({
  database: GCP_FASTPATH_CONNECTION.database,
  schemaPrefix: POSTGRES_FASTPATH_REHEARSAL_TARGET_SCHEMA_PREFIX,
  postgresMajor: 17,
});

/** The closed set of reasons a session is not the fast-path cloud target. */
export const GCP_FASTPATH_CLOUD_TARGET_REFUSALS = Object.freeze([
  "schema", "unavailable", "database", "postgres-major", "superuser",
]);

const SEEDED_SUFFIX = /^[0-9a-f]{8}$/u;

/**
 * Null when `client`'s session is the GCP fast-path cloud target for
 * `schema`; otherwise the first failing condition, one of
 * GCP_FASTPATH_CLOUD_TARGET_REFUSALS. Read-only: one catalog query.
 */
export async function gcpFastpathCloudTargetRefusal(client, schema) {
  if (typeof schema !== "string" || !schema.startsWith(GCP_FASTPATH_CLOUD_TARGET.schemaPrefix)
      || !SEEDED_SUFFIX.test(schema.slice(GCP_FASTPATH_CLOUD_TARGET.schemaPrefix.length))) {
    return "schema";
  }
  let facts;
  try {
    const result = await client.query(`SELECT current_database()::text AS database,
        current_setting('server_version_num')::integer AS version,
        (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = session_user) AS session_superuser,
        current_setting('is_superuser') AS current_superuser`);
    facts = result?.rows?.[0];
  } catch {
    return "unavailable";
  }
  if (!facts) return "unavailable";
  if (facts.database !== GCP_FASTPATH_CLOUD_TARGET.database) return "database";
  const version = Number(facts.version);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== GCP_FASTPATH_CLOUD_TARGET.postgresMajor) {
    return "postgres-major";
  }
  if (facts.session_superuser !== false || facts.current_superuser !== "off") return "superuser";
  return null;
}
