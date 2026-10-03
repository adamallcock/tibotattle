/**
 * The one reader of the PostgreSQL primary migration receipt (owner decision
 * OWN-19, round 8; consolidated by D-CRB, CR phase B).
 *
 * Every PostgreSQL path that must refuse a schema other than the one this
 * image was built for reads the receipt here, and nowhere else:
 *   - the origin's storage gate and the private test health
 *     (cloud-run/postgres-test-dispatch.mjs, readStorageReceipt), in their own
 *     bounded read-only transaction;
 *   - the RD-2 readiness reader (src/postgres-readiness.ts), inside its one
 *     REPEATABLE READ snapshot with the lifecycle rows;
 *   - the MP-2-lite lifecycle pass (src/postgres-lifecycle-pass.ts), inside
 *     each of its own transactions, so the check and the pass's write share
 *     one snapshot.
 * scripts/ledger-absence.check.mjs (STORAGE_RECEIPT_READER) pins this module
 * as the single reader: no other src module may name the migration-history
 * table, and no module may declare a second readSchemaReceipt.
 *
 * The receipt is current only on PostgreSQL 17 with a migration history that
 * equals the expected manifest exactly: the same count and, in version order,
 * the same version, name and checksum. A missing schema or history table, an
 * older, newer or drifted history is not current. Nothing here opens,
 * commits or rolls back a transaction: the caller owns the client and its
 * snapshot. The status checks use to_regclass and pg_namespace, so a missing
 * table never raises an error that would abort the caller's transaction; a
 * driver error (a lost connection, a timeout) propagates to the caller.
 *
 * This module is self-contained (no imports) and uses only erasable
 * TypeScript, so plain Node with type stripping can load it through the
 * dispatch as well as the Worker toolchain and the bundler.
 */

/** PostgreSQL major version the origin requires. */
export const POSTGRES_SCHEMA_RECEIPT_MAJOR = 17;

/** Every status readSchemaReceipt reports. */
export const POSTGRES_SCHEMA_RECEIPT_STATUSES = Object.freeze([
  "current",
  "unsupported_postgres_version",
  "schema_missing",
  "receipt_mismatch",
] as const);

export type PostgresSchemaReceiptStatus = (typeof POSTGRES_SCHEMA_RECEIPT_STATUSES)[number];

/** One entry of an image's migration manifest (POSTGRES_RUNTIME_MIGRATIONS.primary). */
export interface PostgresSchemaReceiptMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

/** The slice of a pg client the reader uses. */
export interface PostgresSchemaReceiptClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

export interface PostgresSchemaReceiptOptions {
  /** The primary schema: a lowercase identifier, never pg_* or information_schema. */
  readonly schema: string;
  /** The image's manifest, versions 1..n in order. */
  readonly expected: readonly PostgresSchemaReceiptMigration[];
}

const MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function invalid(code: string): never {
  throw Object.assign(new TypeError(code), { code });
}

function field(row: unknown, name: string): unknown {
  return row !== null && typeof row === "object" ? Reflect.get(row, name) : undefined;
}

function validSchema(value: unknown): value is string {
  return typeof value === "string" && SCHEMA_IDENTIFIER.test(value)
    && !value.startsWith("pg_") && value !== "information_schema";
}

function validManifest(value: unknown): value is readonly PostgresSchemaReceiptMigration[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry: unknown, index) =>
    field(entry, "version") === index + 1
    && typeof field(entry, "name") === "string" && MIGRATION_NAME.test(field(entry, "name") as string)
    && typeof field(entry, "sha256") === "string" && SHA256.test(field(entry, "sha256") as string));
}

/**
 * Read the primary migration receipt on `client`, inside the caller's
 * transaction. Throws a TypeError with POSTGRES_SCHEMA_RECEIPT_SCHEMA_INVALID
 * or POSTGRES_SCHEMA_RECEIPT_MANIFEST_INVALID for a malformed argument
 * (before any query), and lets a driver error propagate; every other outcome
 * is one of POSTGRES_SCHEMA_RECEIPT_STATUSES.
 */
export async function readSchemaReceipt(
  client: PostgresSchemaReceiptClient,
  options: PostgresSchemaReceiptOptions,
): Promise<PostgresSchemaReceiptStatus> {
  const schema: unknown = field(options, "schema");
  const expected: unknown = field(options, "expected");
  if (!validSchema(schema)) invalid("POSTGRES_SCHEMA_RECEIPT_SCHEMA_INVALID");
  if (!validManifest(expected)) invalid("POSTGRES_SCHEMA_RECEIPT_MANIFEST_INVALID");
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    invalid("POSTGRES_SCHEMA_RECEIPT_CLIENT_INVALID");
  }
  const qualified = `"${schema}"."${MIGRATION_HISTORY_TABLE}"`;
  const probe = await client.query(
    `SELECT current_setting('server_version_num')::integer AS server_version_num,
            EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1) AS schema_exists,
            to_regclass($2)::text AS history`,
    [schema, qualified],
  );
  const row = probe.rows[0];
  if (Math.floor(Number(field(row, "server_version_num")) / 10_000) !== POSTGRES_SCHEMA_RECEIPT_MAJOR) {
    return "unsupported_postgres_version";
  }
  if (field(row, "schema_exists") !== true) return "schema_missing";
  if (typeof field(row, "history") !== "string") return "receipt_mismatch";
  const history = await client.query(
    `SELECT version, name, checksum_sha256 FROM ${qualified} ORDER BY version`,
  );
  const matches = history.rows.length === expected.length
    && expected.every((migration, index) => {
      const actual = history.rows[index];
      return field(actual, "version") === migration.version
        && field(actual, "name") === migration.name
        && field(actual, "checksum_sha256") === migration.sha256;
    });
  return matches ? "current" : "receipt_mismatch";
}
