/**
 * PostgreSQL port of the Worker collection-control reader and assertion
 * (src/collection-controls.ts). Route families share this module so every
 * GCP handler refuses exactly where the Worker refuses:
 *
 * - any unreadable, missing, or internally inconsistent singleton row is
 *   503 COLLECTION_CONTROL_UNAVAILABLE (never "enabled by default");
 * - a disabled control is 503 with the Worker's DISABLED_CODES entry.
 *
 * PostgreSQL stores no schema_version column (primary 0007), so the returned
 * schemaVersion is the Worker constant. The state is read from control_state,
 * never derived; a state that disagrees with its flag count is a defect even
 * though primary 0050 also refuses to store one.
 *
 * Client-scoped functions run on the caller's connection, inside whatever
 * transaction the caller holds. `forShare: true` adds FOR SHARE so a write
 * transaction keeps the observed controls stable until it commits. The pool
 * variants run their own bounded REPEATABLE READ READ ONLY transaction.
 */
import {
  COLLECTION_CONTROLS_SCHEMA_VERSION,
  type CollectionControlName,
  type CollectionControls,
} from "./collection-controls";
import { ApiError } from "./errors";
import type { ErrorCode } from "./errors";
import {
  quotePostgresIdentifier,
  withPostgresRead,
  type PostgresClient,
  type PostgresPool,
} from "./postgres-client";

export { COLLECTION_CONTROLS_SCHEMA_VERSION };
export type { CollectionControlName, CollectionControls };

/** Byte-for-byte the Worker's DISABLED_CODES (collection-controls.ts). */
export const POSTGRES_COLLECTION_CONTROL_DISABLED_CODES: Readonly<
  Record<CollectionControlName, ErrorCode>
> = Object.freeze({
  enrollment: "COLLECTION_ENROLLMENT_DISABLED",
  uploadRegistration: "UPLOAD_REGISTRATION_DISABLED",
  processing: "PROCESSING_DISABLED",
  publication: "PUBLICATION_DISABLED",
});

const CONTROL_STATES: ReadonlySet<string> = new Set(["operational", "degraded", "contained"]);
const DECIMAL_REVISION = /^(?:0|[1-9][0-9]{0,18})$/u;
const POOL_READ_TIMEOUT_MILLISECONDS = 5_000;

export interface PostgresCollectionControlsReadOptions {
  /**
   * Take FOR SHARE on the singleton row. Use only inside a caller-owned
   * write transaction that must not interleave with a controls change.
   */
  readonly forShare?: boolean;
}

interface CollectionControlRow {
  readonly control_state: unknown;
  readonly revision: unknown;
  readonly enrollment_enabled: unknown;
  readonly upload_registration_enabled: unknown;
  readonly processing_enabled: unknown;
  readonly publication_enabled: unknown;
}

function unavailable(): never {
  throw new ApiError(503, "COLLECTION_CONTROL_UNAVAILABLE");
}

function controlsTable(schema: unknown): string {
  try {
    return `${quotePostgresIdentifier(schema)}."collection_controls"`;
  } catch {
    // An unconfigured or invalid schema is the PostgreSQL counterpart of the
    // Worker's missing D1 binding: the controls are unavailable, not open.
    return unavailable();
  }
}

function controlsQuery(schema: unknown, forShare: boolean): string {
  return `SELECT control_state,
                 revision::text AS revision,
                 enrollment_enabled,
                 upload_registration_enabled,
                 processing_enabled,
                 publication_enabled
            FROM ${controlsTable(schema)}
           WHERE singleton = 1${forShare ? "\n             FOR SHARE" : ""}`;
}

function parseRevision(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !DECIMAL_REVISION.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

/** Validate one row exactly as the Worker does (collection-controls.ts). */
function parseControlsRow(rows: readonly CollectionControlRow[] | undefined): CollectionControls {
  if (!Array.isArray(rows) || rows.length !== 1) unavailable();
  const row = rows[0];
  if (row === null || typeof row !== "object") unavailable();
  const revision = parseRevision(row.revision);
  if (typeof row.enrollment_enabled !== "boolean"
      || typeof row.upload_registration_enabled !== "boolean"
      || typeof row.processing_enabled !== "boolean"
      || typeof row.publication_enabled !== "boolean"
      || typeof row.control_state !== "string"
      || !CONTROL_STATES.has(row.control_state)
      || revision === null
      || revision < 1) {
    unavailable();
  }
  const controls = {
    schemaVersion: COLLECTION_CONTROLS_SCHEMA_VERSION,
    state: row.control_state as CollectionControls["state"],
    revision,
    enrollment: row.enrollment_enabled,
    uploadRegistration: row.upload_registration_enabled,
    processing: row.processing_enabled,
    publication: row.publication_enabled,
  } satisfies CollectionControls;
  const enabledCount = [
    controls.enrollment,
    controls.uploadRegistration,
    controls.processing,
    controls.publication,
  ].filter(Boolean).length;
  if ((controls.state === "operational" && enabledCount !== 4)
      || (controls.state === "contained" && enabledCount !== 0)
      || (controls.state === "degraded"
        && (enabledCount === 0 || enabledCount === 4))) {
    unavailable();
  }
  return Object.freeze(controls);
}

function disabled(controls: CollectionControls, name: CollectionControlName): CollectionControls {
  if (!Object.hasOwn(POSTGRES_COLLECTION_CONTROL_DISABLED_CODES, name)) unavailable();
  if (controls[name] !== true) {
    throw new ApiError(503, POSTGRES_COLLECTION_CONTROL_DISABLED_CODES[name]);
  }
  return controls;
}

/**
 * Read the controls singleton on the caller's connection. Every failure,
 * including a driver error, is 503 COLLECTION_CONTROL_UNAVAILABLE. A driver
 * error inside the caller's transaction still aborts that transaction.
 */
export async function readPostgresCollectionControls(
  client: PostgresClient,
  schema: string,
  options: PostgresCollectionControlsReadOptions = {},
): Promise<CollectionControls> {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    unavailable();
  }
  const text = controlsQuery(schema, options.forShare === true);
  let rows: readonly CollectionControlRow[] | undefined;
  try {
    rows = (await client.query<CollectionControlRow>(text)).rows;
  } catch {
    unavailable();
  }
  return parseControlsRow(rows);
}

/**
 * Read the controls on the caller's connection and require one control to be
 * enabled; a disabled control throws the Worker's DISABLED_CODES error.
 */
export async function assertPostgresCollectionControl(
  client: PostgresClient,
  schema: string,
  name: CollectionControlName,
  options: PostgresCollectionControlsReadOptions = {},
): Promise<CollectionControls> {
  return disabled(await readPostgresCollectionControls(client, schema, options), name);
}

/**
 * Read the controls in a dedicated bounded REPEATABLE READ READ ONLY
 * transaction. Connection, transaction and commit failures are 503
 * COLLECTION_CONTROL_UNAVAILABLE, as a failed D1 read is in the Worker.
 */
export async function readPostgresCollectionControlsFromPool(
  pool: PostgresPool,
  schema: string,
): Promise<CollectionControls> {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    unavailable();
  }
  // Refuse an invalid schema before acquiring a connection.
  controlsTable(schema);
  try {
    return await withPostgresRead(
      pool,
      (client) => readPostgresCollectionControls(client, schema),
      {
        operation: "collection_controls.read",
        statementTimeoutMilliseconds: POOL_READ_TIMEOUT_MILLISECONDS,
        lockTimeoutMilliseconds: POOL_READ_TIMEOUT_MILLISECONDS,
        preserveSafeError: (error) => (error instanceof ApiError ? error : null),
      },
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return unavailable();
  }
}

/** Pool variant of assertPostgresCollectionControl in its own read-only transaction. */
export async function assertPostgresCollectionControlFromPool(
  pool: PostgresPool,
  schema: string,
  name: CollectionControlName,
): Promise<CollectionControls> {
  return disabled(await readPostgresCollectionControlsFromPool(pool, schema), name);
}
