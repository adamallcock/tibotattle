import { createHash, randomUUID } from "node:crypto";
import {
  POSTGRES_MIGRATION_ROOT,
  readPostgresMigrations,
  renderPostgresSearchPath,
} from "./postgres-migrations.mjs";

// Shared production-mode contract for the Cloudflare -> GCP transfer.
//
// Every importer defaults to a disposable prefix schema. Production mode is
// available only through a handle returned by openProductionTransferTarget:
// the registered transfer_target_contract names the one application schema,
// its database, the IAM login and the schema-owner role. There is one target
// database: the deletion ledger is retired (decisions D2, D4 and D6 of
// 2026-09-26), so there is no ledger pool, mirror run or 'erasure-ledger'
// stage. Each transaction re-asserts PostgreSQL 17, the database,
// session_user and SET LOCAL ROLE to the schema owner, so every object a tool creates is owned by the schema
// owner and never by the transfer login. Once a run is live (or the handle's
// run is abandoned) the handle only reads. Errors are closed codes; no value
// read from a source or target is ever placed in an error, log or receipt.

export const POSTGRES_TRANSFER_TARGET_SCHEMA_VERSION = "tibotattle-production-transfer-target-v1";
export const TRANSFER_CONTROL_SCHEMA = "tibotattle_transfer";

/** The frozen, ordered stage names. PT-3..PT-8 stage receipts use only these. */
export const TRANSFER_STAGES = Object.freeze([
  "analytics-expectation",
  "identity-authority",
  "legacy-contributions",
  "telemetry-v1-v11",
  "typed-legacy",
  "legacy-admission",
  "header-promotion",
  "telemetry-v12",
  "v12-event-sources",
  "usage-correction",
  "performance",
  "pending-registrations",
  "accountless-retention",
  "ingestion-journal",
  "analytics-history",
  "analytics-community-history",
  "owner-lifecycle-verify",
  "objects",
  "post-import",
]);

export const TRANSFER_RUN_STATES = Object.freeze([
  "preflight", "importing", "verifying", "verified", "live", "abandoned",
]);

function seeded(table, seedRows = 1) {
  return Object.freeze({ role: "primary", table, seedRows });
}

/**
 * Application tables that migrations seed. A fresh target counts them as
 * empty while they hold at most their seed rows. Entries are checked only
 * where the relation exists, so tables added by later migrations can be
 * listed before they land.
 */
export const SEEDED_SINGLETONS = Object.freeze([
  seeded("accountless_enrollment_issuance"),
  seeded("collection_controls"),
  // AN-1 migration 0053; replaced verbatim by the sealed singleton (PT-3).
  seeded("community_public_source_bootstrap"),
  seeded("current_queue_state"),
  seeded("github_distribution_sync_state"),
  seeded("mutation_control"),
  seeded("preparation_counters"),
  seeded("publication_state"),
  // RD-1 lifecycle-state singleton, seeded never_run.
  seeded("quarantine_reconciliation_state"),
  seeded("retention_state"),
  // PF-1 migration (number assigned in plan-v5) runtime row, seeded 'staged'.
  seeded("telemetry_performance_runtime"),
  seeded("telemetry_transport_formats", 5),
  seeded("telemetry_v12_runtime"),
  seeded("telemetry_v12_typed_runtime"),
  seeded("telemetry_v1_quota_fit_backfill"),
]);

/**
 * The relations the control migration creates (primary 0056). The ledger
 * mirror table that only the frozen ledger 0007 creates is not among them,
 * so a database that carries it fails the control-schema allowlist.
 */
export const CONTROL_SCHEMA_RELATIONS = Object.freeze([
  "sealed_collection_controls",
  "transfer_checkpoints",
  "transfer_control_installations",
  "transfer_dropped_relations",
  "transfer_object_erasures",
  "transfer_object_receipts",
  "transfer_runs",
  "transfer_stage_receipts",
  "transfer_table_receipts",
  "transfer_target_contract",
]);

/**
 * The only relations allowed in tibotattle_transfer once a run is verified.
 * Every column is a count, digest, state, stage or table name, or timestamp;
 * checkpoint cursors are NULL by then. The integrator appends each tool's
 * reviewed PRODUCTION_RETAINED_RELATIONS after the control relations.
 */
export const RETAINED_CONTROL_RELATIONS = Object.freeze([
  ...CONTROL_SCHEMA_RELATIONS,
]);

/** Functions created by the control migrations; never dropped by tools. */
export const RETAINED_CONTROL_FUNCTIONS = Object.freeze([
  "install_transfer_live_lock",
  "transfer_checkpoints_guard",
  "transfer_control_row_immutable",
  "transfer_insert_only_guard",
  "transfer_object_receipts_guard",
  "transfer_runs_guard",
  "transfer_stage_receipts_guard",
  "transfer_table_receipts_guard",
  "transfer_target_live_lock_guard",
  "transfer_write_allowed",
]);

/** Constant messages raised by the control-schema guards (ERRCODE P1005). */
const DATABASE_GUARD_CODES = Object.freeze([
  "TRANSFER_CONTROL_ROW_IMMUTABLE",
  "TRANSFER_CONTROL_SCHEMA_FOREIGN",
  "TRANSFER_CHECKPOINT_IMMUTABLE",
  "TRANSFER_LIVE_LOCK_INCOMPLETE",
  "TRANSFER_LIVE_LOCK_NOT_LIVE",
  "TRANSFER_LIVE_LOCK_RELATION_UNSUPPORTED",
  "TRANSFER_RECEIPT_IMMUTABLE",
  "TRANSFER_RECEIPT_REFUSED",
  "TRANSFER_RUN_IMMUTABLE",
  "TRANSFER_RUN_REFUSED",
  "TRANSFER_RUN_TRANSITION_REFUSED",
  "TRANSFER_TARGET_LIVE",
  "TRANSFER_WRITE_REFUSED",
]);

export const POSTGRES_TRANSFER_TARGET_ERROR_CODES = Object.freeze([
  ...DATABASE_GUARD_CODES,
  "CUTOVER_CHECKPOINT_INVALID",
  "CUTOVER_CONTROL_SCHEMA_NOT_ALLOWLISTED",
  "CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE",
  "CUTOVER_CONTROLS_DIGEST_MISMATCH",
  "CUTOVER_CONTROLS_MISSING",
  "CUTOVER_CONTROLS_NOT_DEGRADED",
  "CUTOVER_FLIP_EVIDENCE_INVALID",
  "CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED",
  "CUTOVER_FLIP_RUNTIME_PRIVILEGE",
  "CUTOVER_FLIP_TRIGGER_DISABLED",
  "CUTOVER_IDENTITY_HIGH_WATER_INVALID",
  "CUTOVER_INSTANT_FORMAT_INVALID",
  "CUTOVER_LIVE_LOCK_INCOMPLETE",
  "CUTOVER_RECEIPT_CONFLICT",
  "CUTOVER_RECEIPT_INVALID",
  "CUTOVER_RETENTION_FENCE_UNRECONCILED",
  "CUTOVER_RUN_EXISTS",
  "CUTOVER_RUN_MISSING",
  "CUTOVER_RUN_NOT_VERIFIED",
  "CUTOVER_RUN_STATE_DIVERGED",
  "CUTOVER_RUN_STATE_INVALID",
  "CUTOVER_RUN_TRANSITION_REFUSED",
  "CUTOVER_SEALED_CONTROLS_INVALID",
  "CUTOVER_SEALED_CONTROLS_MISSING",
  "CUTOVER_STAGE_INCOMPLETE",
  "CUTOVER_STAGE_UNKNOWN",
  "CUTOVER_STAGING_REGISTRY_INVALID",
  "CUTOVER_TARGET_ARGUMENT_INVALID",
  "CUTOVER_TARGET_COMMIT_FAILED",
  "CUTOVER_TARGET_CONNECT_FAILED",
  "CUTOVER_TARGET_CONTRACT_CONFLICT",
  "CUTOVER_TARGET_CONTRACT_INVALID",
  "CUTOVER_TARGET_CONTRACT_MISMATCH",
  "CUTOVER_TARGET_CONTRACT_MISSING",
  "CUTOVER_TARGET_CONTROL_SCHEMA_MISSING",
  "CUTOVER_TARGET_DATABASE_MISMATCH",
  "CUTOVER_TARGET_HANDLE_INVALID",
  "CUTOVER_TARGET_IAM_USER_MISSING",
  "CUTOVER_TARGET_LIVE",
  "CUTOVER_TARGET_MIGRATION_RECEIPTS_MISMATCH",
  "CUTOVER_TARGET_NOT_EMPTY",
  "CUTOVER_TARGET_POSTGRES_VERSION_UNSUPPORTED",
  "CUTOVER_TARGET_QUERY_FAILED",
  "CUTOVER_TARGET_ROLE_INVALID",
  "CUTOVER_TARGET_SCHEMA_MISMATCH",
  "CUTOVER_TARGET_SEAL_MISMATCH",
  "CUTOVER_TARGET_SESSION_USER_MISMATCH",
  "CUTOVER_TARGET_TRANSACTION_REQUIRED",
  "CUTOVER_TRANSFER_ID_INVALID",
  "CUTOVER_TRANSFER_USER_OWNS_OBJECTS",
  "CUTOVER_TRIGGER_POLICY_CONSTRAINT_VIOLATION",
  "CUTOVER_TRIGGER_POLICY_INVALID",
  "CUTOVER_TRIGGER_POLICY_MISSING",
  "CUTOVER_TRIGGER_POLICY_REENABLE_FAILED",
  "CUTOVER_TRIGGER_POLICY_STALE",
  "CUTOVER_TRIGGER_POLICY_TRANSACTION_REQUIRED",
  "CUTOVER_TRIGGER_POLICY_TRIGGER_INVALID",
]);

const ERROR_CODES = new Set(POSTGRES_TRANSFER_TARGET_ERROR_CODES);
const GUARD_CODES = new Set(DATABASE_GUARD_CODES);
// Application-schema guards that a transfer step can meet; mapped, never echoed.
const APPLICATION_GUARD_CODES = new Map([
  ["accountless_history_import_source_fence_unreconciled", "CUTOVER_RETENTION_FENCE_UNRECONCILED"],
  ["accountless_history_import_controls_locked", "CUTOVER_RETENTION_FENCE_UNRECONCILED"],
]);

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const SOURCE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$/u;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const CONTRACT_ID = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const INSTANCE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z][a-z0-9-]{1,40}:[a-z][a-z0-9-]{0,97}$/u;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHECKPOINT_NAME = /^[a-z][a-z0-9_.:-]{0,127}$/u;
const DISPOSITION = /^(?:(?:imported|mapped|claimed-by):[a-z][a-z0-9]*(?:-[a-z0-9]+)*|verified-equal|must-be-empty|schema-marker|source-machinery|runtime-reset|edge-retained|not-transferred-expiring|target-missing)$/u;
const SOURCE_ROLES = new Set(["ingestion", "analytics", "deletion-ledger", "r2"]);
const OBJECT_KINDS_ALLOWED_IN_CONTROL_SCHEMA = new Set(["r", "p", "i", "I"]);
const RESERVED_SCHEMAS = new Set(["tibotattle_transfer", "information_schema", "public", "pg_catalog"]);
const COLLECTION_CONTROL_STATES = new Set(["operational", "degraded", "contained"]);
const COLLECTION_REASON_CODES = new Set([
  "initial", "drill_containment", "drill_restore", "privacy_incident", "security_incident",
  "abuse_or_cost", "maintenance",
]);
const D1_COLLECTION_CONTROLS_SCHEMA_VERSION = "collection-controls-v0.1";
const SEALED_CONTROL_KEYS = new Set([
  "singleton", "schema_version", "control_state", "enrollment_enabled", "upload_registration_enabled",
  "processing_enabled", "publication_enabled", "revision", "reason_code", "updated_at",
]);
const CONTRACT_KEYS = Object.freeze([
  ["contractId", "contract_id"],
  ["mode", "mode"],
  ["projectId", "project_id"],
  ["projectNumber", "project_number"],
  ["instanceConnectionName", "instance_connection_name"],
  ["databaseName", "database_name"],
  ["schemaName", "schema_name"],
  ["iamDatabaseUser", "iam_database_user"],
  ["schemaOwnerRole", "schema_owner_role"],
  ["gcsBucket", "gcs_bucket"],
  ["gcsBucketGeneration", "gcs_bucket_generation"],
]);
const HISTORY_TABLE = "_tibotattle_migration_history";
const DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MILLISECONDS = 10_000;
const TRIGGER_POLICY_SAVEPOINT = "tibotattle_transfer_trigger_policy";
const LIVE_LOCK_TRIGGER = "transfer_target_live_lock";
const HASH = value => createHash("sha256").update(value).digest("hex");
const HANDLES = new WeakMap();
const TRANSACTION_CLIENTS = new WeakMap();
// Module-private option: the run-state transitions (advance, abandon,
// mark-live) enforce their own state rules under a FOR UPDATE run lock, so they skip the live/abandoned write gate (and its FOR
// SHARE lock) that every other write transaction meets.
const RUN_CONTROL = Symbol("tibotattle-transfer-run-control");
const MAX_WAIVED_ROLE_MEMBERS = 8;

export class PostgresTransferTargetError extends Error {
  constructor(code, details = undefined) {
    const safe = safeDetails(details);
    const suffix = Object.entries(safe).map(([key, value]) => `${key}=${value}`).join(" ");
    super(suffix.length > 0 ? `${code} [${suffix}]` : code);
    this.name = "PostgresTransferTargetError";
    this.code = code;
    for (const [key, value] of Object.entries(safe)) this[key] = value;
  }
}

function safeDetails(details) {
  const safe = {};
  if (details === null || typeof details !== "object") return safe;
  if (typeof details.sqlState === "string" && SQLSTATE.test(details.sqlState)) safe.sqlState = details.sqlState;
  for (const key of ["table", "column", "trigger", "relation"]) {
    const value = details[key];
    if (typeof value === "string" && SOURCE_TABLE.test(value)) safe[key] = value;
  }
  if (typeof details.stage === "string" && TRANSFER_STAGES.includes(details.stage)) safe.stage = details.stage;
  return safe;
}

function fail(code, details = undefined) {
  if (!ERROR_CODES.has(code)) throw new PostgresTransferTargetError("CUTOVER_TARGET_ARGUMENT_INVALID");
  throw new PostgresTransferTargetError(code, details);
}

function sqlStateOf(error) {
  return typeof error?.code === "string" && SQLSTATE.test(error.code) ? error.code : undefined;
}

async function q(client, text, values = undefined, code = "CUTOVER_TARGET_QUERY_FAILED") {
  try {
    return await client.query(text, values);
  } catch (error) {
    if (error instanceof PostgresTransferTargetError) throw error;
    const sqlState = sqlStateOf(error);
    if (sqlState === "P1005" && typeof error?.message === "string") {
      if (GUARD_CODES.has(error.message)) fail(error.message, { sqlState });
      const mapped = APPLICATION_GUARD_CODES.get(error.message);
      if (mapped !== undefined) fail(mapped, { sqlState });
    }
    fail(code, { sqlState });
  }
}

function rows(result) {
  if (result === null || typeof result !== "object" || !Array.isArray(result.rows)) {
    fail("CUTOVER_TARGET_QUERY_FAILED");
  }
  return result.rows;
}

function identifier(value, code = "CUTOVER_TARGET_ARGUMENT_INVALID") {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.startsWith("pg_")) fail(code);
  return value;
}

function roleName(value, code = "CUTOVER_TARGET_ARGUMENT_INVALID") {
  if (typeof value !== "string" || !ROLE_NAME.test(value)) fail(code);
  return value;
}

/** Quote an identifier read from the catalog or validated by the caller. */
function quote(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.includes("\0")) {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function control(table) {
  return `${quote(TRANSFER_CONTROL_SCHEMA)}.${quote(table)}`;
}

function sha256Hex(value, code = "CUTOVER_TARGET_ARGUMENT_INVALID") {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function safeCount(value, code) {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code);
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function databaseCount(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(text)) fail("CUTOVER_TARGET_QUERY_FAILED");
  return BigInt(text);
}

function assertStage(stage) {
  if (typeof stage !== "string" || !TRANSFER_STAGES.includes(stage)) fail("CUTOVER_STAGE_UNKNOWN");
  return stage;
}

// ---------------------------------------------------------------------------
// Canonical digests (byte-equal to postgres-cutover-rehearsal.mjs 824-846).

export const EMPTY_PREFIX_CHAIN = HASH("tibotattle-cutover-rehearsal-prefix-v1");

export function canonicalValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function digestRows(rowsToDigest) {
  return HASH(JSON.stringify(canonicalValue(rowsToDigest)));
}

export function createRowsDigest() {
  const hash = createHash("sha256");
  hash.update("[");
  let count = 0;
  return {
    update(row) {
      if (count > 0) hash.update(",");
      hash.update(JSON.stringify(canonicalValue(row)));
      count += 1;
    },
    digest() {
      hash.update("]");
      return hash.digest("hex");
    },
    get count() { return count; },
  };
}

export function advancePrefixChain(previous, row) {
  return HASH(`${previous}\0${JSON.stringify(canonicalValue(row))}`);
}

// ---------------------------------------------------------------------------
// Transfer ids and instants.

export function productionTransferId(stage, sealId) {
  assertStage(stage);
  sha256Hex(sealId, "CUTOVER_TRANSFER_ID_INVALID");
  return `production-${stage}-${sealId.slice(0, 16)}`;
}

export function assertProductionTransferId(transferId, stage, sealId) {
  if (typeof transferId !== "string" || transferId !== productionTransferId(stage, sealId)) {
    fail("CUTOVER_TRANSFER_ID_INVALID");
  }
  return transferId;
}

function instantFailure(table, column) {
  fail("CUTOVER_INSTANT_FORMAT_INVALID", { table, column });
}

/**
 * Accept only a canonical millisecond UTC instant that re-renders
 * identically, and return it for a `$n::timestamptz` parameter. Failures
 * name only the table and column, never the value.
 */
export function toPostgresInstant(value, { table, column, nullable = false } = {}) {
  if (value === null && nullable === true) return null;
  if (typeof value !== "string" || !INSTANT.test(value) || value.startsWith("0000-")) {
    instantFailure(table, column);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) instantFailure(table, column);
  return value;
}

/** Render a timestamptz read back from PostgreSQL in the canonical form. */
export function instantFromPostgres(value, { table, column, nullable = false } = {}) {
  if (value === null && nullable === true) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) instantFailure(table, column);
  return toPostgresInstant(value.toISOString(), { table, column });
}

/**
 * Prove every stored instant in the named columns re-renders to a canonical
 * millisecond UTC string and parses back to the same value.
 */
export async function assertInstantRoundTrip(client, { schema, table, columns } = {}) {
  identifier(schema);
  identifier(table);
  if (!Array.isArray(columns) || columns.length === 0) fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  for (const column of columns) {
    identifier(column);
    const rendered = `to_char(${quote(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    const result = rows(await q(client, `SELECT count(*)::text AS n FROM ${quote(schema)}.${quote(table)}
      WHERE ${quote(column)} IS NOT NULL
        AND (${rendered} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          OR ${rendered}::timestamptz IS DISTINCT FROM ${quote(column)})`));
    if (databaseCount(result[0]?.n) !== 0n) instantFailure(table, column);
  }
}

// ---------------------------------------------------------------------------
// Transactions, sessions and roles.

function positiveTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  return value;
}

async function inTransaction(pool, options, fn) {
  if (pool === null || typeof pool !== "object" || typeof pool.connect !== "function") {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  const statementTimeout = positiveTimeout(options.statementTimeoutMilliseconds,
    DEFAULT_STATEMENT_TIMEOUT_MILLISECONDS);
  const lockTimeout = positiveTimeout(options.lockTimeoutMilliseconds, DEFAULT_LOCK_TIMEOUT_MILLISECONDS);
  let client;
  try {
    client = await pool.connect();
  } catch {
    fail("CUTOVER_TARGET_CONNECT_FAILED");
  }
  let open = false;
  let discard = false;
  try {
    await q(client, options.readOnly === true ? "BEGIN READ ONLY" : "BEGIN");
    open = true;
    await q(client, `SET LOCAL statement_timeout = '${statementTimeout}ms'`);
    await q(client, `SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    const result = await fn(client);
    open = false;
    try {
      await client.query("COMMIT");
    } catch (error) {
      discard = true;
      fail("CUTOVER_TARGET_COMMIT_FAILED", { sqlState: sqlStateOf(error) });
    }
    return result;
  } catch (error) {
    if (open) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    throw error;
  } finally {
    try {
      client.release(discard ? true : undefined);
    } catch {
      // The connection is already unusable; the transaction outcome stands.
    }
  }
}

async function sessionFacts(client) {
  const [facts] = rows(await q(client, `SELECT current_setting('server_version_num') AS server_version_num,
      current_database()::text AS database_name, session_user::text AS login_role,
      current_user::text AS effective_role`));
  const version = Number(facts?.server_version_num);
  if (!Number.isSafeInteger(version) || version < 170000 || version >= 180000) {
    fail("CUTOVER_TARGET_POSTGRES_VERSION_UNSUPPORTED");
  }
  if (typeof facts.database_name !== "string" || typeof facts.login_role !== "string"
      || facts.effective_role !== facts.login_role) {
    fail("CUTOVER_TARGET_ROLE_INVALID");
  }
  return Object.freeze({ databaseName: facts.database_name, loginRole: facts.login_role });
}

async function assumeOwnerRole(client, owner) {
  roleName(owner, "CUTOVER_TARGET_ROLE_INVALID");
  await q(client, `SET LOCAL ROLE ${quote(owner)}`, undefined, "CUTOVER_TARGET_ROLE_INVALID");
  const [assumed] = rows(await q(client,
    "SELECT current_user::text AS assumed_role, session_user::text AS login_role"));
  if (assumed?.assumed_role !== owner) fail("CUTOVER_TARGET_ROLE_INVALID");
}

async function controlSchemaOwner(client) {
  const [row] = rows(await q(client, `SELECT pg_get_userbyid(nspowner)::text AS owner
    FROM pg_catalog.pg_namespace WHERE nspname = $1`, [TRANSFER_CONTROL_SCHEMA]));
  if (row === undefined) fail("CUTOVER_TARGET_CONTROL_SCHEMA_MISSING");
  return row.owner;
}

async function assertPrimaryControlInstalled(client) {
  const [row] = rows(await q(client, `SELECT to_regclass($1) IS NOT NULL AS installations,
      to_regclass($2) IS NOT NULL AS runs`,
  [`${TRANSFER_CONTROL_SCHEMA}.transfer_control_installations`, `${TRANSFER_CONTROL_SCHEMA}.transfer_runs`]));
  if (row?.installations !== true || row?.runs !== true) fail("CUTOVER_TARGET_CONTROL_SCHEMA_MISSING");
  const installed = rows(await q(client, `SELECT 1 FROM ${control("transfer_control_installations")}
    WHERE component = 'primary'`));
  if (installed.length !== 1) fail("CUTOVER_TARGET_CONTROL_SCHEMA_MISSING");
}

async function assertApplicationSchema(client, schema, owner) {
  const [row] = rows(await q(client, `SELECT pg_get_userbyid(nspowner)::text AS owner
    FROM pg_catalog.pg_namespace WHERE nspname = $1`, [schema]));
  if (row === undefined || row.owner !== owner) fail("CUTOVER_TARGET_SCHEMA_MISMATCH");
}

async function assertMigrationReceipts(client, schema, rootDirectory) {
  let expected;
  try {
    expected = await readPostgresMigrations({ role: "primary", rootDirectory });
  } catch {
    fail("CUTOVER_TARGET_MIGRATION_RECEIPTS_MISMATCH");
  }
  const [present] = rows(await q(client, "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${quote(schema)}.${quote(HISTORY_TABLE)}`]));
  if (present?.present !== true) fail("CUTOVER_TARGET_MIGRATION_RECEIPTS_MISMATCH");
  const history = rows(await q(client, `SELECT version, name, checksum_sha256
    FROM ${quote(schema)}.${quote(HISTORY_TABLE)} ORDER BY version`));
  if (history.length !== expected.length) fail("CUTOVER_TARGET_MIGRATION_RECEIPTS_MISMATCH");
  for (let index = 0; index < expected.length; index += 1) {
    const row = history[index];
    const migration = expected[index];
    if (Number(row.version) !== migration.version || row.name !== migration.name
        || row.checksum_sha256 !== migration.sha256) {
      fail("CUTOVER_TARGET_MIGRATION_RECEIPTS_MISMATCH");
    }
  }
}

async function assertApplicationTablesEmpty(client, schema) {
  const seededLimits = new Map(SEEDED_SINGLETONS.map(entry => [entry.table, entry.seedRows]));
  const tables = rows(await q(client, `SELECT c.relname::text AS relname
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname <> $2
     ORDER BY c.relname`, [schema, HISTORY_TABLE]));
  for (const { relname } of tables) {
    const limit = seededLimits.get(relname) ?? 0;
    const [sample] = rows(await q(client, `SELECT count(*)::text AS n FROM (
        SELECT 1 FROM ${quote(schema)}.${quote(relname)} LIMIT ${limit + 1}) sample`));
    if (databaseCount(sample?.n) > BigInt(limit)) fail("CUTOVER_TARGET_NOT_EMPTY", { relation: relname });
  }
}

function runRow(row) {
  if (row === undefined) return undefined;
  return Object.freeze({
    runId: row.run_id,
    contractId: row.contract_id,
    sealManifestSha256: row.seal_manifest_sha256,
    state: row.state,
    flipEvidenceSha256: row.flip_evidence_sha256 ?? null,
    sealedAt: row.sealed_at,
  });
}

const RUN_COLUMNS = `run_id, contract_id, seal_manifest_sha256, state, flip_evidence_sha256,
  to_char(sealed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sealed_at`;

async function readOpenRun(client, table) {
  const found = rows(await q(client, `SELECT ${RUN_COLUMNS} FROM ${control(table)}
    WHERE state <> 'abandoned'`));
  if (found.length > 1) fail("CUTOVER_RUN_STATE_DIVERGED");
  return runRow(found[0]);
}

async function readRunById(client, table, runId, lock = "") {
  const [row] = rows(await q(client, `SELECT ${RUN_COLUMNS} FROM ${control(table)}
    WHERE run_id = $1 ${lock}`, [runId]));
  return runRow(row);
}

async function readContract(client) {
  const [present] = rows(await q(client, "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${TRANSFER_CONTROL_SCHEMA}.transfer_target_contract`]));
  if (present?.present !== true) fail("CUTOVER_TARGET_CONTROL_SCHEMA_MISSING");
  const found = rows(await q(client, `SELECT ${CONTRACT_KEYS.map(([, column]) => column).join(", ")}
    FROM ${control("transfer_target_contract")} WHERE singleton`));
  if (found.length !== 1) fail("CUTOVER_TARGET_CONTRACT_MISSING");
  return Object.freeze({ ...found[0] });
}

function normalizeContract(contract) {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    fail("CUTOVER_TARGET_CONTRACT_INVALID");
  }
  const allowed = new Set(CONTRACT_KEYS.map(([key]) => key));
  if (Object.keys(contract).some(key => !allowed.has(key))) fail("CUTOVER_TARGET_CONTRACT_INVALID");
  const row = {};
  for (const [key, column] of CONTRACT_KEYS) {
    const value = contract[key];
    if (typeof value !== "string") fail("CUTOVER_TARGET_CONTRACT_INVALID");
    row[column] = value;
  }
  const schemaOk = value => IDENTIFIER.test(value) && !value.startsWith("pg_") && !RESERVED_SCHEMAS.has(value);
  if (!CONTRACT_ID.test(row.contract_id)
      || !["production", "staging_rehearsal"].includes(row.mode)
      || !PROJECT_ID.test(row.project_id)
      || !DECIMAL_ID.test(row.project_number)
      || !INSTANCE.test(row.instance_connection_name)
      || !DATABASE_NAME.test(row.database_name)
      || !schemaOk(row.schema_name)
      || !ROLE_NAME.test(row.iam_database_user)
      || !ROLE_NAME.test(row.schema_owner_role)
      || row.iam_database_user === row.schema_owner_role
      || !BUCKET.test(row.gcs_bucket)
      || !DECIMAL_ID.test(row.gcs_bucket_generation)) {
    fail("CUTOVER_TARGET_CONTRACT_INVALID");
  }
  return Object.freeze(row);
}

async function assertRoleExists(client, role) {
  const found = rows(await q(client, "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1", [role]));
  if (found.length !== 1) fail("CUTOVER_TARGET_IAM_USER_MISSING");
}

/** Refuse any argument key outside the closed set (a retired ledger pool included). */
function closedArguments(args, allowed) {
  if (args === null || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some(key => !allowed.includes(key))) {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  return args;
}

/**
 * Owner-run, idempotent registration of the production target contract in
 * the one target database. The contract row is immutable once written. A
 * database still carrying the dual-role contract shape (before primary 0064)
 * refuses the insert, as does any argument beyond the primary pool and the
 * contract.
 */
export async function registerProductionTransferTarget(args = {}) {
  const { primaryPool, contract } = closedArguments(args, ["primaryPool", "contract"]);
  const row = normalizeContract(contract);
  return inTransaction(primaryPool, {}, async (client) => {
    const facts = await sessionFacts(client);
    if (facts.databaseName !== row.database_name) fail("CUTOVER_TARGET_DATABASE_MISMATCH");
    if (facts.loginRole !== row.schema_owner_role) await assumeOwnerRole(client, row.schema_owner_role);
    if (await controlSchemaOwner(client) !== row.schema_owner_role) fail("CUTOVER_TARGET_ROLE_INVALID");
    await assertPrimaryControlInstalled(client);
    await assertApplicationSchema(client, row.schema_name, row.schema_owner_role);
    await assertRoleExists(client, row.iam_database_user);
    const columns = CONTRACT_KEYS.map(([, column]) => column);
    const inserted = rows(await q(client, `INSERT INTO ${control("transfer_target_contract")}
        (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
      ON CONFLICT (singleton) DO NOTHING RETURNING contract_id`, columns.map(column => row[column])));
    const stored = await readContract(client);
    if (columns.some(column => stored[column] !== row[column])) fail("CUTOVER_TARGET_CONTRACT_CONFLICT");
    return Object.freeze({ contractId: row.contract_id, registered: inserted.length === 1 });
  });
}

function handleState(handle) {
  const state = HANDLES.get(handle);
  if (state === undefined) fail("CUTOVER_TARGET_HANDLE_INVALID");
  return state;
}

// The one target is the primary; any other role (the retired 'ledger'
// included) is refused.
function roleTarget(handle, role) {
  if (role === "primary") {
    return { database: handle.primaryDatabase, schema: handle.primarySchema, component: "primary" };
  }
  return fail("CUTOVER_TARGET_ARGUMENT_INVALID");
}

async function liveRunPresent(client, table) {
  const [present] = rows(await q(client, "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${TRANSFER_CONTROL_SCHEMA}.${table}`]));
  if (present?.present !== true) return false;
  const [row] = rows(await q(client, `SELECT EXISTS (SELECT 1 FROM ${control(table)}
    WHERE state = 'live') AS live`));
  return row?.live === true;
}

// A write transaction is refused once any run in this database is live (the
// target then belongs to the runtime) and once the handle's own run is
// abandoned. The primary run row is share-locked first, so a concurrent
// markLive either waits for this transaction or is seen by it.
async function assertWritableTarget(client, runId) {
  const own = runId === null ? undefined : await readRunById(client, "transfer_runs", runId, "FOR SHARE");
  if (await liveRunPresent(client, "transfer_runs")) fail("CUTOVER_TARGET_LIVE");
  if (own?.state === "abandoned") fail("CUTOVER_RUN_STATE_INVALID");
}

/**
 * Run fn(client) in one transaction on the named target, re-asserting
 * PostgreSQL 17, the contract database and IAM login, and SET LOCAL ROLE to
 * the schema owner. Objects fn creates are owned by the schema owner. A
 * write transaction is refused once any run is live or the handle's run is
 * abandoned; read-only transactions stay available for readbacks.
 */
export async function withTransferTransaction(handle, role, fn, options = {}) {
  const state = handleState(handle);
  const target = roleTarget(handle, role);
  if (typeof fn !== "function" || options === null || typeof options !== "object") {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  const pool = state.primaryPool;
  const readOnly = options.readOnly === true;
  const runControl = options[RUN_CONTROL] === true;
  return inTransaction(pool, {
    statementTimeoutMilliseconds: options.statementTimeoutMilliseconds,
    lockTimeoutMilliseconds: options.lockTimeoutMilliseconds,
    readOnly,
  }, async (client) => {
    const facts = await sessionFacts(client);
    if (facts.databaseName !== target.database) fail("CUTOVER_TARGET_DATABASE_MISMATCH");
    if (facts.loginRole !== handle.iamDatabaseUser) fail("CUTOVER_TARGET_SESSION_USER_MISMATCH");
    await assumeOwnerRole(client, handle.schemaOwnerRole);
    await q(client, renderPostgresSearchPath(target.schema));
    if (!readOnly && !runControl) await assertWritableTarget(client, state.runId);
    TRANSACTION_CLIENTS.set(client, Object.freeze({ handle, role }));
    try {
      return await fn(client);
    } finally {
      TRANSACTION_CLIENTS.delete(client);
    }
  });
}

function transactionRole(client, handle, role = undefined) {
  handleState(handle);
  const entry = TRANSACTION_CLIENTS.get(client);
  if (entry === undefined || entry.handle !== handle || (role !== undefined && entry.role !== role)) {
    fail("CUTOVER_TARGET_TRANSACTION_REQUIRED");
  }
  return entry.role;
}

async function inspectPrimary(client, { expectedContractId, sealManifestSha256, rootDirectory }) {
  const facts = await sessionFacts(client);
  const owner = await controlSchemaOwner(client);
  await assumeOwnerRole(client, owner);
  const contract = await readContract(client);
  if (contract.contract_id !== expectedContractId) fail("CUTOVER_TARGET_CONTRACT_MISMATCH");
  if (contract.schema_owner_role !== owner) fail("CUTOVER_TARGET_ROLE_INVALID");
  if (contract.database_name !== facts.databaseName) fail("CUTOVER_TARGET_DATABASE_MISMATCH");
  if (contract.iam_database_user !== facts.loginRole) fail("CUTOVER_TARGET_SESSION_USER_MISMATCH");
  await assertApplicationSchema(client, contract.schema_name, owner);
  await assertPrimaryControlInstalled(client);
  await assertMigrationReceipts(client, contract.schema_name, rootDirectory);
  const run = await readOpenRun(client, "transfer_runs");
  if (run !== undefined && run.sealManifestSha256 !== sealManifestSha256) fail("CUTOVER_TARGET_SEAL_MISMATCH");
  if (run !== undefined && run.contractId !== contract.contract_id) fail("CUTOVER_RUN_STATE_DIVERGED");
  if (run === undefined) await assertApplicationTablesEmpty(client, contract.schema_name);
  return { contract, run };
}

/**
 * Open the registered production target. A fresh open requires empty
 * application tables (seeded singletons excepted); an open whose seal id
 * equals the existing non-abandoned run resumes it and skips that check.
 */
export async function openProductionTransferTarget(args = {}) {
  const {
    primaryPool,
    expectedContractId,
    sealManifestSha256,
    rootDirectory = POSTGRES_MIGRATION_ROOT,
  } = closedArguments(args, ["primaryPool", "expectedContractId", "sealManifestSha256", "rootDirectory"]);
  if (typeof expectedContractId !== "string" || !CONTRACT_ID.test(expectedContractId)) {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  sha256Hex(sealManifestSha256);
  const primary = await inTransaction(primaryPool, { readOnly: true }, client => inspectPrimary(client, {
    expectedContractId, sealManifestSha256, rootDirectory,
  }));
  const { contract, run } = primary;
  const handle = Object.freeze({
    schemaVersion: POSTGRES_TRANSFER_TARGET_SCHEMA_VERSION,
    contractId: contract.contract_id,
    mode: contract.mode,
    sealManifestSha256,
    primaryDatabase: contract.database_name,
    primarySchema: contract.schema_name,
    controlSchema: TRANSFER_CONTROL_SCHEMA,
    iamDatabaseUser: contract.iam_database_user,
    schemaOwnerRole: contract.schema_owner_role,
    gcsBucket: contract.gcs_bucket,
    gcsBucketGeneration: contract.gcs_bucket_generation,
    resumed: run !== undefined,
    openedRunState: run?.state ?? null,
  });
  HANDLES.set(handle, { primaryPool, rootDirectory, runId: run?.runId ?? null, began: run !== undefined });
  return handle;
}

// ---------------------------------------------------------------------------
// Runs.

async function currentRun(client, handle, lock = "") {
  const state = handleState(handle);
  if (state.runId === null) fail("CUTOVER_RUN_MISSING");
  const run = await readRunById(client, "transfer_runs", state.runId, lock);
  if (run === undefined || run.sealManifestSha256 !== handle.sealManifestSha256
      || run.contractId !== handle.contractId) {
    fail("CUTOVER_RUN_MISSING");
  }
  return run;
}

async function writableRun(client, handle) {
  transactionRole(client, handle, "primary");
  const run = await currentRun(client, handle, "FOR SHARE");
  if (run.state !== "importing" && run.state !== "verifying") fail("CUTOVER_RUN_STATE_INVALID");
  return run;
}

async function importingRun(client, handle, lock) {
  transactionRole(client, handle, "primary");
  const run = await currentRun(client, handle, lock);
  if (run.state !== "importing") fail("CUTOVER_RUN_STATE_INVALID");
  return run;
}

/**
 * The current run, which must be 'importing' with the handle's seal id.
 * Takes no row lock, so it also serves read-only transactions.
 */
export async function requireImportingRun(client, handle) {
  return importingRun(client, handle, "");
}

function nextStateToward(from, to) {
  if (to === "abandoned") return "abandoned";
  const order = ["preflight", "importing", "verifying", "verified", "live"];
  return order[order.indexOf(from) + 1];
}

/** Begin the one run for this handle's seal; the target must still be empty. */
export async function beginRun(handle, { sealedAt } = {}) {
  const state = handleState(handle);
  if (state.began) fail("CUTOVER_RUN_EXISTS");
  const sealed = toPostgresInstant(sealedAt, { table: "transfer_runs", column: "sealed_at" });
  const runId = randomUUID();
  await withTransferTransaction(handle, "primary", async (client) => {
    if (await readOpenRun(client, "transfer_runs") !== undefined) fail("CUTOVER_RUN_EXISTS");
    await assertApplicationTablesEmpty(client, handle.primarySchema);
    await q(client, `INSERT INTO ${control("transfer_runs")}
        (run_id, contract_id, seal_manifest_sha256, sealed_at, state)
      VALUES ($1, $2, $3, $4::timestamptz, 'preflight')`,
    [runId, handle.contractId, handle.sealManifestSha256, sealed]);
  });
  state.began = true;
  state.runId = runId;
  return Object.freeze({ runId, state: "preflight" });
}

async function assertAllStagesComplete(client, run) {
  const complete = rows(await q(client, `SELECT stage FROM ${control("transfer_stage_receipts")}
    WHERE run_id = $1 AND state = 'complete'`, [run.runId])).map(row => row.stage);
  const missing = TRANSFER_STAGES.find(stage => !complete.includes(stage));
  if (missing !== undefined) fail("CUTOVER_STAGE_INCOMPLETE", { stage: missing });
}

// No checkpoint cursor survives in any run: the current run's and those of
// abandoned runs, which the live lock would otherwise freeze for good.
async function assertNoCheckpointCursors(client) {
  const [cursors] = rows(await q(client, `SELECT count(*)::text AS n FROM ${control("transfer_checkpoints")}
    WHERE last_key IS NOT NULL`));
  if (databaseCount(cursors?.n) !== 0n) fail("CUTOVER_CHECKPOINT_INVALID");
}

// NULL the cursors of every abandoned run (0056 admits only that UPDATE for
// an abandoned run). Returns the number of checkpoints scrubbed. Issues no
// UPDATE when nothing is left, so it never meets a statement-level lock.
async function scrubAbandonedRunCursors(client) {
  const abandonedCursor = `checkpoint.last_key IS NOT NULL AND EXISTS (SELECT 1 FROM ${control("transfer_runs")} run
      WHERE run.run_id = checkpoint.run_id AND run.state = 'abandoned')`;
  const [pending] = rows(await q(client, `SELECT count(*)::text AS n
    FROM ${control("transfer_checkpoints")} AS checkpoint WHERE ${abandonedCursor}`));
  if (databaseCount(pending?.n) === 0n) return 0;
  const result = await q(client, `UPDATE ${control("transfer_checkpoints")} AS checkpoint SET last_key = NULL
    WHERE ${abandonedCursor}`);
  return result.rowCount ?? 0;
}

async function assertVerifiedPreconditions(client, handle, run) {
  await assertAllStagesComplete(client, run);
  await assertNoCheckpointCursors(client);
  await assertControlSchemaAllowlist(client);
  await assertNoTransferUserOwnership(client, handle);
}

/**
 * Move the run forward: preflight -> importing -> verifying -> verified.
 * The transition refuses a live or abandoned run itself, so it takes the
 * run row FOR UPDATE directly rather than through the shared write gate.
 */
export async function advanceRun(handle, to) {
  if (!["importing", "verifying", "verified"].includes(to)) fail("CUTOVER_RUN_TRANSITION_REFUSED");
  const state = handleState(handle);
  if (state.runId === null) fail("CUTOVER_RUN_MISSING");
  return withTransferTransaction(handle, "primary", async (client) => {
    const run = await currentRun(client, handle, "FOR UPDATE");
    if (run.state !== to) {
      if (nextStateToward(run.state, to) !== to) fail("CUTOVER_RUN_TRANSITION_REFUSED");
      if (to === "verifying") await assertAllStagesComplete(client, run);
      if (to === "verified") await assertVerifiedPreconditions(client, handle, run);
      await q(client, `UPDATE ${control("transfer_runs")} SET state = $2,
          verified_at = CASE WHEN $2 = 'verified' THEN clock_timestamp() ELSE verified_at END
        WHERE run_id = $1`, [run.runId, to]);
    }
    return Object.freeze({ runId: run.runId, state: to });
  }, { [RUN_CONTROL]: true });
}

/**
 * Abandon the run. There is no reopen. The run's checkpoint cursors are
 * NULLed in the same transaction, so an abandoned run never keeps a cursor.
 */
export async function abandonRun(handle) {
  const state = handleState(handle);
  if (state.runId === null) fail("CUTOVER_RUN_MISSING");
  return withTransferTransaction(handle, "primary", async (client) => {
    const run = await currentRun(client, handle, "FOR UPDATE");
    if (run.state === "live") fail("CUTOVER_RUN_TRANSITION_REFUSED");
    if (run.state !== "abandoned") {
      await q(client, `UPDATE ${control("transfer_runs")} SET state = 'abandoned',
        abandoned_at = clock_timestamp() WHERE run_id = $1`, [run.runId]);
    }
    await scrubAbandonedRunCursors(client);
    const [left] = rows(await q(client, `SELECT count(*)::text AS n FROM ${control("transfer_checkpoints")}
      WHERE run_id = $1 AND last_key IS NOT NULL`, [run.runId]));
    if (databaseCount(left?.n) !== 0n) fail("CUTOVER_CHECKPOINT_INVALID");
    return Object.freeze({ runId: run.runId, state: "abandoned" });
  }, { [RUN_CONTROL]: true });
}

// ---------------------------------------------------------------------------
// Receipts and checkpoints.

function receiptCount(value) {
  return safeCount(value, "CUTOVER_RECEIPT_INVALID");
}

/**
 * Record a stage receipt. A 'complete' receipt is never overwritten; a
 * repeated completion must carry identical counts and digest.
 */
export async function stageReceipt(client, handle, { stage, state, rowCount, byteCount, receiptSha256 } = {}) {
  assertStage(stage);
  if (state !== "started" && state !== "complete") fail("CUTOVER_RECEIPT_INVALID");
  const complete = state === "complete";
  const counts = complete
    ? [receiptCount(rowCount), receiptCount(byteCount), sha256Hex(receiptSha256, "CUTOVER_RECEIPT_INVALID")]
    : [null, null, null];
  const run = await writableRun(client, handle);
  const transferId = productionTransferId(stage, run.sealManifestSha256);
  const [existing] = rows(await q(client, `SELECT state, row_count::text AS row_count,
      byte_count::text AS byte_count, receipt_sha256
    FROM ${control("transfer_stage_receipts")} WHERE run_id = $1 AND stage = $2 FOR UPDATE`, [run.runId, stage]));
  if (existing?.state === "complete") {
    if (complete && (existing.row_count !== String(counts[0]) || existing.byte_count !== String(counts[1])
        || existing.receipt_sha256 !== counts[2])) {
      fail("CUTOVER_RECEIPT_CONFLICT", { stage });
    }
    return Object.freeze({ stage, transferId, state: "complete" });
  }
  if (existing === undefined) {
    await q(client, `INSERT INTO ${control("transfer_stage_receipts")}
        (run_id, stage, transfer_id, state, row_count, byte_count, receipt_sha256, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'complete' THEN clock_timestamp() END)`,
    [run.runId, stage, transferId, state, ...counts]);
  } else if (complete) {
    await q(client, `UPDATE ${control("transfer_stage_receipts")} SET state = 'complete',
        row_count = $3, byte_count = $4, receipt_sha256 = $5, completed_at = clock_timestamp()
      WHERE run_id = $1 AND stage = $2`, [run.runId, stage, ...counts]);
  }
  return Object.freeze({ stage, transferId, state });
}

/** Require a complete stage receipt for the handle's current run. */
export async function assertStageComplete(handle, stage, client = undefined) {
  assertStage(stage);
  const check = async (activeClient) => {
    const run = await currentRun(activeClient, handle);
    const found = rows(await q(activeClient, `SELECT 1 FROM ${control("transfer_stage_receipts")}
      WHERE run_id = $1 AND stage = $2 AND state = 'complete'`, [run.runId, stage]));
    if (found.length !== 1) fail("CUTOVER_STAGE_INCOMPLETE", { stage });
  };
  if (client !== undefined) {
    transactionRole(client, handle, "primary");
    return check(client);
  }
  return withTransferTransaction(handle, "primary", check, { readOnly: true });
}

/** Record one sealed source table's disposition and digests; complete rows are never overwritten. */
export async function tableReceipt(client, handle, receipt = {}) {
  const {
    stage, sourceRole, sourceTable, disposition, targetTable = null, state,
    sourceRowCount = null, sourceSha256 = null, targetRowCount = null, targetSha256 = null,
  } = receipt;
  assertStage(stage);
  if (!SOURCE_ROLES.has(sourceRole) || typeof sourceTable !== "string" || !SOURCE_TABLE.test(sourceTable)
      || typeof disposition !== "string" || !DISPOSITION.test(disposition)
      || (targetTable !== null && (typeof targetTable !== "string" || !IDENTIFIER.test(targetTable)))
      || (state !== "started" && state !== "complete")
      || ((targetRowCount === null) !== (targetSha256 === null))) {
    fail("CUTOVER_RECEIPT_INVALID");
  }
  const complete = state === "complete";
  if (complete && (sourceRowCount === null || sourceSha256 === null)) fail("CUTOVER_RECEIPT_INVALID");
  const values = [
    sourceRowCount === null ? null : receiptCount(sourceRowCount),
    sourceSha256 === null ? null : sha256Hex(sourceSha256, "CUTOVER_RECEIPT_INVALID"),
    targetRowCount === null ? null : receiptCount(targetRowCount),
    targetSha256 === null ? null : sha256Hex(targetSha256, "CUTOVER_RECEIPT_INVALID"),
  ];
  const run = await writableRun(client, handle);
  const [existing] = rows(await q(client, `SELECT stage, disposition, target_table, state,
      source_row_count::text AS source_row_count, source_sha256,
      target_row_count::text AS target_row_count, target_sha256
    FROM ${control("transfer_table_receipts")}
    WHERE run_id = $1 AND source_role = $2 AND source_table = $3 FOR UPDATE`,
  [run.runId, sourceRole, sourceTable]));
  const text = value => (value === null ? null : String(value));
  if (existing !== undefined && (existing.stage !== stage || existing.disposition !== disposition)) {
    fail("CUTOVER_RECEIPT_CONFLICT", { table: sourceTable, stage });
  }
  if (existing?.state === "complete") {
    if (complete && (existing.target_table !== targetTable
        || existing.source_row_count !== text(values[0]) || existing.source_sha256 !== values[1]
        || existing.target_row_count !== text(values[2]) || existing.target_sha256 !== values[3])) {
      fail("CUTOVER_RECEIPT_CONFLICT", { table: sourceTable, stage });
    }
    return Object.freeze({ sourceRole, sourceTable, stage, state: "complete" });
  }
  if (existing === undefined) {
    await q(client, `INSERT INTO ${control("transfer_table_receipts")}
        (run_id, source_role, source_table, stage, disposition, target_table, state,
         source_row_count, source_sha256, target_row_count, target_sha256, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        CASE WHEN $7 = 'complete' THEN clock_timestamp() END)`,
    [run.runId, sourceRole, sourceTable, stage, disposition, targetTable, state, ...values]);
  } else {
    await q(client, `UPDATE ${control("transfer_table_receipts")} SET target_table = $4, state = $5,
        source_row_count = $6, source_sha256 = $7, target_row_count = $8, target_sha256 = $9,
        completed_at = CASE WHEN $5 = 'complete' THEN clock_timestamp() END
      WHERE run_id = $1 AND source_role = $2 AND source_table = $3`,
    [run.runId, sourceRole, sourceTable, targetTable, state, ...values]);
  }
  return Object.freeze({ sourceRole, sourceTable, stage, state });
}

/** Write a keyset checkpoint. A complete checkpoint carries no cursor. */
export async function recordCheckpoint(client, handle, {
  stage, name, state, lastKey = null, rowCount, prefixChainSha256,
} = {}) {
  assertStage(stage);
  if (typeof name !== "string" || !CHECKPOINT_NAME.test(name)
      || (state !== "pending" && state !== "complete")
      || (state === "complete" && lastKey !== null)) {
    fail("CUTOVER_CHECKPOINT_INVALID");
  }
  const count = safeCount(rowCount, "CUTOVER_CHECKPOINT_INVALID");
  sha256Hex(prefixChainSha256, "CUTOVER_CHECKPOINT_INVALID");
  let cursor = null;
  if (lastKey !== null) {
    try {
      cursor = JSON.stringify(canonicalValue(lastKey));
    } catch {
      fail("CUTOVER_CHECKPOINT_INVALID");
    }
    if (typeof cursor !== "string" || Buffer.byteLength(cursor) > 8192) fail("CUTOVER_CHECKPOINT_INVALID");
  }
  const run = await writableRun(client, handle);
  const [existing] = rows(await q(client, `SELECT state, row_count::text AS row_count, prefix_chain_sha256
    FROM ${control("transfer_checkpoints")} WHERE run_id = $1 AND stage = $2 AND checkpoint_name = $3
    FOR UPDATE`, [run.runId, stage, name]));
  if (existing?.state === "complete") {
    if (state !== "complete" || existing.row_count !== String(count)
        || existing.prefix_chain_sha256 !== prefixChainSha256) {
      fail("CUTOVER_RECEIPT_CONFLICT", { stage });
    }
    return Object.freeze({ stage, name, state: "complete" });
  }
  await q(client, `INSERT INTO ${control("transfer_checkpoints")}
      (run_id, stage, checkpoint_name, state, last_key, row_count, prefix_chain_sha256)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (run_id, stage, checkpoint_name) DO UPDATE SET state = EXCLUDED.state,
      last_key = EXCLUDED.last_key, row_count = EXCLUDED.row_count,
      prefix_chain_sha256 = EXCLUDED.prefix_chain_sha256`,
  [run.runId, stage, name, state, cursor, count, prefixChainSha256]);
  return Object.freeze({ stage, name, state });
}

export async function readCheckpoint(client, handle, { stage, name } = {}) {
  assertStage(stage);
  if (typeof name !== "string" || !CHECKPOINT_NAME.test(name)) fail("CUTOVER_CHECKPOINT_INVALID");
  transactionRole(client, handle, "primary");
  const run = await currentRun(client, handle);
  const [row] = rows(await q(client, `SELECT state, last_key, row_count::text AS row_count, prefix_chain_sha256
    FROM ${control("transfer_checkpoints")} WHERE run_id = $1 AND stage = $2 AND checkpoint_name = $3`,
  [run.runId, stage, name]));
  if (row === undefined) return null;
  let lastKey = null;
  if (row.last_key !== null) {
    try {
      lastKey = JSON.parse(row.last_key);
    } catch {
      fail("CUTOVER_CHECKPOINT_INVALID");
    }
  }
  return Object.freeze({
    state: row.state,
    lastKey,
    rowCount: Number(databaseCount(row.row_count)),
    prefixChainSha256: row.prefix_chain_sha256,
  });
}

// ---------------------------------------------------------------------------
// Trigger policy.

async function relationOid(client, schema, table, code) {
  const [row] = rows(await q(client, `SELECT c.oid::text AS oid FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`, [schema, table]));
  if (row === undefined) fail(code, { table });
  return row.oid;
}

async function deferrableConstraints(client, oid) {
  return rows(await q(client, `WITH neighbours AS (
        SELECT $1::oid AS relid
        UNION SELECT con.conrelid FROM pg_catalog.pg_constraint con
         WHERE con.contype = 'f' AND con.confrelid = $1::oid
        UNION SELECT con.confrelid FROM pg_catalog.pg_constraint con
         WHERE con.contype = 'f' AND con.conrelid = $1::oid
      )
      SELECT DISTINCT n.nspname::text AS schema_name, con.conname::text AS constraint_name
        FROM pg_catalog.pg_constraint con
        JOIN neighbours ON neighbours.relid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
       WHERE con.condeferrable
       ORDER BY 1, 2`, [oid]));
}

async function suppressedTriggersEnabled(client, oid, names) {
  const found = rows(await q(client, `SELECT tgname::text AS name FROM pg_catalog.pg_trigger
    WHERE tgrelid = $1::oid AND tgname = ANY($2::text[]) AND tgenabled = 'O'`, [oid, names]));
  return found.length === names.length;
}

// Roll the page back to the savepoint, which restores every disabled
// trigger. When the connection itself is lost the server aborts the whole
// transaction, DDL included, so only a live session that still reports a
// disabled trigger is an error of its own.
async function restoreTriggerPolicy(client, oid, names) {
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${TRIGGER_POLICY_SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${TRIGGER_POLICY_SAVEPOINT}`);
  } catch {
    return;
  }
  if (oid === undefined || names.length === 0) return;
  let enabled;
  try {
    enabled = await suppressedTriggersEnabled(client, oid, names);
  } catch {
    return;
  }
  if (!enabled) fail("CUTOVER_TRIGGER_POLICY_REENABLE_FAILED");
}

/**
 * Suppress the named row triggers of one table for one page inside the
 * caller's transaction. The page runs, then every deferrable constraint of
 * the table and its foreign-key neighbours (user constraint triggers
 * included) is forced IMMEDIATE so no AFTER-trigger event stays pending
 * (ALTER TABLE refuses pending events with SQLSTATE 55006), and the
 * triggers are re-enabled and asserted 'O'. On any error the savepoint is
 * rolled back, which restores the triggers. Foreign-key, internal and
 * constraint triggers are never disabled, and neither is ALL or USER.
 * The control schema (whose guards and live lock are never suppressed) and
 * the reserved schemas are refused. Must be the last write group of the
 * page transaction.
 */
export async function withTriggerPolicy(client, { schema, table, suppress } = {}, fn) {
  identifier(schema, "CUTOVER_TRIGGER_POLICY_INVALID");
  if (RESERVED_SCHEMAS.has(schema)) fail("CUTOVER_TRIGGER_POLICY_INVALID");
  identifier(table, "CUTOVER_TRIGGER_POLICY_INVALID");
  if (!Array.isArray(suppress) || typeof fn !== "function"
      || new Set(suppress).size !== suppress.length
      || suppress.some(name => typeof name !== "string" || !IDENTIFIER.test(name))) {
    fail("CUTOVER_TRIGGER_POLICY_INVALID");
  }
  const names = [...suppress];
  try {
    await client.query(`SAVEPOINT ${TRIGGER_POLICY_SAVEPOINT}`);
  } catch (error) {
    fail(sqlStateOf(error) === "25P01" ? "CUTOVER_TRIGGER_POLICY_TRANSACTION_REQUIRED" : "CUTOVER_TARGET_QUERY_FAILED",
      { sqlState: sqlStateOf(error) });
  }
  const relation = `${quote(schema)}.${quote(table)}`;
  let oid;
  try {
    oid = await relationOid(client, schema, table, "CUTOVER_TRIGGER_POLICY_INVALID");
    const triggers = rows(await q(client, `SELECT tgname::text AS name, tgenabled::text AS enabled,
        tgisinternal AS internal, tgconstraint <> 0 AS constraint_trigger
      FROM pg_catalog.pg_trigger WHERE tgrelid = $1::oid AND tgname = ANY($2::text[])`, [oid, names]));
    for (const name of names) {
      const trigger = triggers.find(row => row.name === name);
      if (trigger === undefined || trigger.internal === true || trigger.constraint_trigger === true
          || trigger.enabled !== "O") {
        fail("CUTOVER_TRIGGER_POLICY_TRIGGER_INVALID", { table, trigger: name });
      }
    }
    for (const name of names) {
      await q(client, `ALTER TABLE ${relation} DISABLE TRIGGER ${quote(name)}`, undefined,
        "CUTOVER_TRIGGER_POLICY_INVALID");
    }
  } catch (error) {
    await restoreTriggerPolicy(client, undefined, names);
    throw error;
  }
  let result;
  try {
    result = await fn(client);
  } catch (error) {
    await restoreTriggerPolicy(client, oid, names);
    throw error;
  }
  try {
    const deferrables = await deferrableConstraints(client, oid);
    if (deferrables.length > 0) {
      const list = deferrables.map(row => `${quote(row.schema_name)}.${quote(row.constraint_name)}`).join(", ");
      await q(client, `SET CONSTRAINTS ${list} IMMEDIATE`, undefined, "CUTOVER_TRIGGER_POLICY_CONSTRAINT_VIOLATION");
    }
    for (const name of names) {
      await q(client, `ALTER TABLE ${relation} ENABLE TRIGGER ${quote(name)}`, undefined,
        "CUTOVER_TRIGGER_POLICY_REENABLE_FAILED");
    }
    if (!await suppressedTriggersEnabled(client, oid, names)) fail("CUTOVER_TRIGGER_POLICY_REENABLE_FAILED");
    await q(client, `RELEASE SAVEPOINT ${TRIGGER_POLICY_SAVEPOINT}`);
  } catch (error) {
    await restoreTriggerPolicy(client, oid, names);
    throw error;
  }
  return result;
}

function validPolicyMap(policyMap) {
  if (policyMap === null || typeof policyMap !== "object" || Array.isArray(policyMap)) {
    fail("CUTOVER_TRIGGER_POLICY_INVALID");
  }
  for (const [table, triggers] of Object.entries(policyMap)) {
    if (!IDENTIFIER.test(table) || triggers === null || typeof triggers !== "object" || Array.isArray(triggers)) {
      fail("CUTOVER_TRIGGER_POLICY_INVALID");
    }
    for (const [trigger, entry] of Object.entries(triggers)) {
      if (!IDENTIFIER.test(trigger) || entry === null || typeof entry !== "object"
          || (entry.policy !== "fire" && entry.policy !== "suppress")
          || typeof entry.reason !== "string" || entry.reason.trim().length === 0 || entry.reason.length > 240
          || Object.keys(entry).some(key => key !== "policy" && key !== "reason")) {
        fail("CUTOVER_TRIGGER_POLICY_INVALID", { table, trigger });
      }
    }
  }
  return policyMap;
}

/**
 * Every non-internal trigger on every table named in policyMap must have
 * exactly one reviewed policy ('fire' or 'suppress', with a reason), and
 * every policy must name a trigger that exists. User constraint triggers
 * may only fire; withTriggerPolicy forces them IMMEDIATE instead.
 */
export async function assertTriggerPolicyCoverage(client, schema, policyMap) {
  identifier(schema, "CUTOVER_TRIGGER_POLICY_INVALID");
  validPolicyMap(policyMap);
  const tables = Object.keys(policyMap).sort();
  const existing = new Set(rows(await q(client, `SELECT c.relname::text AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')`,
  [schema, tables])).map(row => row.name));
  const triggers = rows(await q(client, `SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name,
      t.tgconstraint <> 0 AS constraint_trigger
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND NOT t.tgisinternal
     ORDER BY 1, 2`, [schema, tables]));
  for (const row of triggers) {
    const entry = Object.hasOwn(policyMap[row.table_name], row.trigger_name)
      ? policyMap[row.table_name][row.trigger_name] : undefined;
    if (entry === undefined) {
      fail("CUTOVER_TRIGGER_POLICY_MISSING", { table: row.table_name, trigger: row.trigger_name });
    }
    if (row.constraint_trigger === true && entry.policy === "suppress") {
      fail("CUTOVER_TRIGGER_POLICY_INVALID", { table: row.table_name, trigger: row.trigger_name });
    }
  }
  for (const table of tables) {
    if (!existing.has(table)) fail("CUTOVER_TRIGGER_POLICY_STALE", { table });
    for (const trigger of Object.keys(policyMap[table])) {
      if (!triggers.some(row => row.table_name === table && row.trigger_name === trigger)) {
        fail("CUTOVER_TRIGGER_POLICY_STALE", { table, trigger });
      }
    }
  }
  const suppressedTables = tables.filter(table =>
    Object.values(policyMap[table]).some(entry => entry.policy === "suppress"));
  const suppressedTablesWithDeferrables = [];
  for (const table of suppressedTables) {
    const oid = await relationOid(client, schema, table, "CUTOVER_TRIGGER_POLICY_STALE");
    if ((await deferrableConstraints(client, oid)).length > 0) suppressedTablesWithDeferrables.push(table);
  }
  return Object.freeze({
    tables: tables.length,
    triggers: triggers.length,
    suppressed: tables.reduce((total, table) =>
      total + Object.values(policyMap[table]).filter(entry => entry.policy === "suppress").length, 0),
    suppressedTablesWithDeferrables: Object.freeze(suppressedTablesWithDeferrables),
  });
}

// ---------------------------------------------------------------------------
// Identity high water.

/**
 * Raise every identity or serial sequence of the target schema to
 * GREATEST(max(column), the sealed sqlite_sequence value, its current
 * value). Never lowers a sequence. sealedSequences must name every table of
 * the schema that has an identity or serial column, and nothing else: a
 * sealed sqlite_sequence value, or null when the sealed source has no
 * sqlite_sequence row for it. A missing entry is missing evidence and fails.
 */
export async function applyIdentityHighWater(client, handle, { sealedSequences } = {}) {
  const role = transactionRole(client, handle);
  const schema = roleTarget(handle, role).schema;
  if (sealedSequences === null || typeof sealedSequences !== "object" || Array.isArray(sealedSequences)) {
    fail("CUTOVER_IDENTITY_HIGH_WATER_INVALID");
  }
  const sealed = new Map();
  for (const [table, value] of Object.entries(sealedSequences)) {
    if (!IDENTIFIER.test(table)) fail("CUTOVER_IDENTITY_HIGH_WATER_INVALID");
    sealed.set(table, value === null ? null : BigInt(safeCount(value, "CUTOVER_IDENTITY_HIGH_WATER_INVALID")));
  }
  const columns = rows(await q(client, `SELECT c.relname::text AS table_name, a.attname::text AS column_name,
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname)::regclass::oid::text AS sequence_oid
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
       AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL
     ORDER BY 1, 2`, [schema]));
  const sequenced = new Set(columns.map(row => row.table_name));
  for (const [table, value] of sealed) {
    const count = columns.filter(row => row.table_name === table).length;
    if (count === 0 || (value !== null && count !== 1)) fail("CUTOVER_IDENTITY_HIGH_WATER_INVALID");
  }
  for (const table of sequenced) {
    if (!sealed.has(table)) fail("CUTOVER_IDENTITY_HIGH_WATER_INVALID", { table });
  }
  const applied = [];
  for (const row of columns) {
    const [maximum] = rows(await q(client, `SELECT COALESCE(max(${quote(row.column_name)}), 0)::text AS value
      FROM ${quote(schema)}.${quote(row.table_name)}`));
    // Read the sequence itself (fails closed without privilege) rather than
    // pg_sequences, whose last_value is NULL for a caller lacking it.
    const [sequence] = rows(await q(client, `SELECT $1::oid::regclass::text AS relation,
        seqincrement::text AS increment FROM pg_catalog.pg_sequence WHERE seqrelid = $1::oid`,
    [row.sequence_oid]));
    if (sequence === undefined || BigInt(sequence.increment) < 1n) fail("CUTOVER_IDENTITY_HIGH_WATER_INVALID");
    const [current] = rows(await q(client, `SELECT last_value::text AS last_value, is_called
      FROM ${sequence.relation}`, undefined, "CUTOVER_IDENTITY_HIGH_WATER_INVALID"));
    if (current === undefined) fail("CUTOVER_IDENTITY_HIGH_WATER_INVALID");
    const previous = current.is_called === true
      ? BigInt(current.last_value)
      : BigInt(current.last_value) - BigInt(sequence.increment);
    const candidates = [BigInt(maximum.value), sealed.get(row.table_name) ?? 0n, previous];
    const target = candidates.reduce((left, right) => (right > left ? right : left));
    if (target > previous && target >= 1n) {
      await q(client, "SELECT setval($1::oid::regclass, $2::bigint, true)", [row.sequence_oid, target.toString()]);
    }
    applied.push(Object.freeze({
      table: row.table_name,
      column: row.column_name,
      previous: previous.toString(),
      highWater: (target > previous ? target : previous).toString(),
    }));
  }
  return Object.freeze(applied);
}

// ---------------------------------------------------------------------------
// Collection controls.

function sealedFlag(value) {
  if (value === true || value === 1 || value === 1n) return true;
  if (value === false || value === 0 || value === 0n) return false;
  return fail("CUTOVER_SEALED_CONTROLS_INVALID");
}

function canonicalControls(row) {
  return {
    control_state: row.control_state,
    enrollment_enabled: row.enrollment_enabled,
    processing_enabled: row.processing_enabled,
    publication_enabled: row.publication_enabled,
    reason_code: row.reason_code,
    revision: row.revision,
    updated_at: row.updated_at,
    upload_registration_enabled: row.upload_registration_enabled,
  };
}

/** The content-free digest of a collection-controls row in canonical form. */
export function sealedCollectionControlsSha256(row) {
  return HASH(`tibotattle-sealed-collection-controls-v1\n${JSON.stringify(canonicalValue(canonicalControls(row)))}`);
}

function normalizeSealedControls(sealedRow) {
  if (sealedRow === null || typeof sealedRow !== "object" || Array.isArray(sealedRow)
      || Object.keys(sealedRow).some(key => !SEALED_CONTROL_KEYS.has(key))) {
    fail("CUTOVER_SEALED_CONTROLS_INVALID");
  }
  // The sealed D1 row carries both markers; schema_version is asserted
  // constant and then dropped. An absent marker is missing evidence.
  if (sealedRow.singleton !== 1 && sealedRow.singleton !== 1n) fail("CUTOVER_SEALED_CONTROLS_INVALID");
  if (sealedRow.schema_version !== D1_COLLECTION_CONTROLS_SCHEMA_VERSION) fail("CUTOVER_SEALED_CONTROLS_INVALID");
  const revision = typeof sealedRow.revision === "bigint" ? sealedRow.revision : BigInt(
    Number.isSafeInteger(sealedRow.revision) ? sealedRow.revision : -1);
  if (revision < 1n || revision > BigInt(Number.MAX_SAFE_INTEGER)) fail("CUTOVER_SEALED_CONTROLS_INVALID");
  const row = {
    control_state: sealedRow.control_state,
    enrollment_enabled: sealedFlag(sealedRow.enrollment_enabled),
    upload_registration_enabled: sealedFlag(sealedRow.upload_registration_enabled),
    processing_enabled: sealedFlag(sealedRow.processing_enabled),
    publication_enabled: sealedFlag(sealedRow.publication_enabled),
    reason_code: sealedRow.reason_code,
    revision: Number(revision),
    updated_at: sealedRow.updated_at,
  };
  if (!COLLECTION_CONTROL_STATES.has(row.control_state) || !COLLECTION_REASON_CODES.has(row.reason_code)) {
    fail("CUTOVER_SEALED_CONTROLS_INVALID");
  }
  try {
    toPostgresInstant(row.updated_at, { table: "collection_controls", column: "updated_at" });
  } catch {
    fail("CUTOVER_SEALED_CONTROLS_INVALID");
  }
  const flags = [row.enrollment_enabled, row.upload_registration_enabled, row.processing_enabled,
    row.publication_enabled];
  const consistent = (row.control_state === "operational" && flags.every(Boolean))
    || (row.control_state === "contained" && flags.every(flag => !flag))
    || (row.control_state === "degraded" && !flags.every(Boolean) && flags.some(Boolean));
  if (!consistent) fail("CUTOVER_SEALED_CONTROLS_INVALID");
  return Object.freeze({ ...row, sealed_row_sha256: sealedCollectionControlsSha256(row) });
}

async function readSealedControls(client, runId) {
  const [row] = rows(await q(client, `SELECT revision::text AS revision, control_state, enrollment_enabled,
      upload_registration_enabled, processing_enabled, publication_enabled, reason_code,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at, sealed_row_sha256
    FROM ${control("sealed_collection_controls")} WHERE run_id = $1`, [runId]));
  if (row === undefined) fail("CUTOVER_SEALED_CONTROLS_MISSING");
  const sealed = { ...row, revision: Number(databaseCount(row.revision)) };
  if (sealedCollectionControlsSha256(sealed) !== row.sealed_row_sha256) fail("CUTOVER_SEALED_CONTROLS_INVALID");
  return Object.freeze(sealed);
}

async function readApplicationControls(client, schema) {
  const [row] = rows(await q(client, `SELECT revision::text AS revision, control_state, enrollment_enabled,
      upload_registration_enabled, processing_enabled, publication_enabled, reason_code,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
      date_trunc('milliseconds', updated_at) = updated_at AS millisecond_precision
    FROM ${quote(schema)}.collection_controls WHERE singleton = 1`));
  if (row === undefined) fail("CUTOVER_CONTROLS_MISSING");
  return Object.freeze({ ...row, revision: Number(databaseCount(row.revision)) });
}

/** Record the sealed D1 collection_controls row for the importing run. */
export async function recordSealedCollectionControls(client, handle, sealedRow) {
  const sealed = normalizeSealedControls(sealedRow);
  const run = await importingRun(client, handle, "FOR SHARE");
  const existing = rows(await q(client, `SELECT sealed_row_sha256 FROM ${control("sealed_collection_controls")}
    WHERE run_id = $1`, [run.runId]));
  if (existing.length === 1) {
    if (existing[0].sealed_row_sha256 !== sealed.sealed_row_sha256) fail("CUTOVER_RECEIPT_CONFLICT");
    return Object.freeze({ sealedRowSha256: sealed.sealed_row_sha256, revision: sealed.revision });
  }
  await q(client, `INSERT INTO ${control("sealed_collection_controls")}
      (run_id, revision, control_state, enrollment_enabled, upload_registration_enabled, processing_enabled,
       publication_enabled, reason_code, updated_at, sealed_row_sha256)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`, [
    run.runId, sealed.revision, sealed.control_state, sealed.enrollment_enabled,
    sealed.upload_registration_enabled, sealed.processing_enabled, sealed.publication_enabled,
    sealed.reason_code, sealed.updated_at, sealed.sealed_row_sha256,
  ]);
  return Object.freeze({ sealedRowSha256: sealed.sealed_row_sha256, revision: sealed.revision });
}

/** The import-lane controls: degraded, enrollment and publication off, sealed revision. */
export async function assertCollectionControlsDegradedForImport(client, handle) {
  transactionRole(client, handle, "primary");
  const run = await currentRun(client, handle);
  const sealed = await readSealedControls(client, run.runId);
  const current = await readApplicationControls(client, handle.primarySchema);
  if (current.control_state !== "degraded" || current.enrollment_enabled !== false
      || current.publication_enabled !== false || current.revision !== sealed.revision
      || current.upload_registration_enabled !== sealed.upload_registration_enabled
      || current.processing_enabled !== sealed.processing_enabled) {
    fail("CUTOVER_CONTROLS_NOT_DEGRADED");
  }
}

/**
 * Degrade the application collection_controls row for the import with an
 * ordinary UPDATE (no trigger suppression): control_state 'degraded',
 * enrollment and publication off, upload registration, processing, reason
 * and revision at their sealed values. A sealed row with neither upload
 * registration nor processing on (for example 'contained') has no
 * consistent degraded form: 'degraded' with every flag off is a defect to
 * the Worker reader and the state/flag CHECK, and the import lane admits
 * only 'degraded'. That case is refused before any write
 * (CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE); the owner re-seals instead.
 */
export async function degradeCollectionControlsForImport(client, handle) {
  const run = await importingRun(client, handle, "FOR SHARE");
  const sealed = await readSealedControls(client, run.runId);
  if (sealed.upload_registration_enabled !== true && sealed.processing_enabled !== true) {
    fail("CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE");
  }
  const updated = await q(client, `UPDATE ${quote(handle.primarySchema)}.collection_controls
      SET control_state = 'degraded', enrollment_enabled = false, publication_enabled = false,
          upload_registration_enabled = $1, processing_enabled = $2, revision = $3, reason_code = $4,
          updated_at = date_trunc('milliseconds', clock_timestamp())
    WHERE singleton = 1`, [sealed.upload_registration_enabled, sealed.processing_enabled, sealed.revision,
    sealed.reason_code]);
  if (updated.rowCount !== 1) fail("CUTOVER_CONTROLS_MISSING");
  await assertCollectionControlsDegradedForImport(client, handle);
}

async function assertRetentionFenceReconciled(client, schema) {
  const [present] = rows(await q(client, "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${quote(schema)}.accountless_public_history_import_runs`]));
  if (present?.present !== true) return;
  const [open] = rows(await q(client, `SELECT count(*)::text AS n
      FROM ${quote(schema)}.accountless_public_history_import_runs run
     WHERE run.target_schema = $1
       AND (run.status = 'importing'
         OR (run.source_kind = 'cloudflare-d1-accountless-retention-snapshot-v1'
           AND run.status = 'complete' AND run.source_fence_state <> 'reconciled'))`, [schema]));
  if (databaseCount(open?.n) !== 0n) fail("CUTOVER_RETENTION_FENCE_UNRECONCILED");
}

async function assertControlsEqualSealed(client, handle, runId) {
  const sealed = await readSealedControls(client, runId);
  const current = await readApplicationControls(client, handle.primarySchema);
  if (current.millisecond_precision !== true
      || sealedCollectionControlsSha256(current) !== sealed.sealed_row_sha256) {
    fail("CUTOVER_CONTROLS_DIGEST_MISMATCH");
  }
  return sealed;
}

/**
 * Restore the sealed collection_controls row exactly. Requires a verified
 * run and no unreconciled accountless-retention import; the restored row's
 * digest must equal the sealed digest.
 */
export async function restoreSealedCollectionControls(client, handle) {
  transactionRole(client, handle, "primary");
  const run = await currentRun(client, handle, "FOR SHARE");
  if (run.state !== "verified") fail("CUTOVER_RUN_NOT_VERIFIED");
  const sealed = await readSealedControls(client, run.runId);
  await assertRetentionFenceReconciled(client, handle.primarySchema);
  const updated = await q(client, `UPDATE ${quote(handle.primarySchema)}.collection_controls
      SET revision = $1, control_state = $2, enrollment_enabled = $3, upload_registration_enabled = $4,
          processing_enabled = $5, publication_enabled = $6, reason_code = $7, updated_at = $8::timestamptz
    WHERE singleton = 1`, [sealed.revision, sealed.control_state, sealed.enrollment_enabled,
    sealed.upload_registration_enabled, sealed.processing_enabled, sealed.publication_enabled,
    sealed.reason_code, sealed.updated_at]);
  if (updated.rowCount !== 1) fail("CUTOVER_CONTROLS_MISSING");
  await assertControlsEqualSealed(client, handle, run.runId);
  return Object.freeze({ sealedRowSha256: sealed.sealed_row_sha256, revision: sealed.revision });
}

// ---------------------------------------------------------------------------
// Control-schema hygiene.

function controlRelationName(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("CUTOVER_STAGING_REGISTRY_INVALID");
  return value;
}

/**
 * NULL every checkpoint cursor: transfer_checkpoints of the current run and
 * of every abandoned run, plus registered tool cursor columns.
 */
export async function scrubCheckpointCursors(client, handle, registry = []) {
  const run = await writableRun(client, handle);
  if (!Array.isArray(registry)) fail("CUTOVER_STAGING_REGISTRY_INVALID");
  const entries = registry.map((entry) => {
    if (entry === null || typeof entry !== "object"
        || (entry.schema !== undefined && entry.schema !== TRANSFER_CONTROL_SCHEMA)
        || !Array.isArray(entry.cursorColumns) || entry.cursorColumns.length === 0
        || new Set(entry.cursorColumns).size !== entry.cursorColumns.length) {
      fail("CUTOVER_STAGING_REGISTRY_INVALID");
    }
    return { table: controlRelationName(entry.table), columns: entry.cursorColumns.map(controlRelationName) };
  });
  if (new Set(entries.map(entry => entry.table)).size !== entries.length) fail("CUTOVER_STAGING_REGISTRY_INVALID");
  const scrubbed = [];
  const builtIn = await q(client, `UPDATE ${control("transfer_checkpoints")} SET last_key = NULL
    WHERE run_id = $1 AND last_key IS NOT NULL`, [run.runId]);
  const abandoned = await scrubAbandonedRunCursors(client);
  scrubbed.push(Object.freeze({ relation: "transfer_checkpoints", rows: (builtIn.rowCount ?? 0) + abandoned }));
  for (const entry of entries) {
    const nullable = rows(await q(client, `SELECT a.attname::text AS name FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       WHERE c.relnamespace = $1::regnamespace AND c.relname = $2 AND c.relkind IN ('r', 'p')
         AND a.attname = ANY($3::text[]) AND a.attnum > 0 AND NOT a.attisdropped AND NOT a.attnotnull`,
    [TRANSFER_CONTROL_SCHEMA, entry.table, entry.columns]));
    if (nullable.length !== entry.columns.length) fail("CUTOVER_STAGING_REGISTRY_INVALID", { relation: entry.table });
    const setList = entry.columns.map(column => `${quote(column)} = NULL`).join(", ");
    const anyPresent = entry.columns.map(column => `${quote(column)} IS NOT NULL`).join(" OR ");
    const result = await q(client, `UPDATE ${control(entry.table)} SET ${setList} WHERE ${anyPresent}`);
    const [left] = rows(await q(client, `SELECT count(*)::text AS n FROM ${control(entry.table)} WHERE ${anyPresent}`));
    if (databaseCount(left?.n) !== 0n) fail("CUTOVER_CHECKPOINT_INVALID", { relation: entry.table });
    scrubbed.push(Object.freeze({ relation: entry.table, rows: result.rowCount ?? 0 }));
  }
  await assertNoCheckpointCursors(client);
  return Object.freeze(scrubbed);
}

/** tibotattle_transfer may hold only the frozen RETAINED_CONTROL_RELATIONS. */
export async function assertControlSchemaAllowlist(client) {
  const relations = rows(await q(client, `SELECT c.relname::text AS name, c.relkind::text AS kind
      FROM pg_catalog.pg_class c WHERE c.relnamespace = $1::regnamespace ORDER BY c.relname`,
  [TRANSFER_CONTROL_SCHEMA]));
  for (const relation of relations) {
    if (relation.kind === "i" || relation.kind === "I") continue;
    if (!OBJECT_KINDS_ALLOWED_IN_CONTROL_SCHEMA.has(relation.kind)
        || !(CONTROL_SCHEMA_RELATIONS.includes(relation.name) || RETAINED_CONTROL_RELATIONS.includes(relation.name))) {
      fail("CUTOVER_CONTROL_SCHEMA_NOT_ALLOWLISTED", { relation: relation.name });
    }
  }
  return Object.freeze(relations.filter(relation => relation.kind === "r" || relation.kind === "p")
    .map(relation => relation.name));
}

async function digestRelation(client, table) {
  const cursor = "tibotattle_transfer_drop_digest";
  const digest = createRowsDigest();
  await q(client, `DECLARE ${cursor} NO SCROLL CURSOR FOR
    SELECT to_jsonb(relation_row)::text AS row_text FROM ${control(table)} relation_row
     ORDER BY to_jsonb(relation_row)::text COLLATE "C"`);
  try {
    for (;;) {
      const batch = rows(await q(client, `FETCH FORWARD 500 FROM ${cursor}`));
      if (batch.length === 0) break;
      for (const row of batch) digest.update(row.row_text);
    }
  } finally {
    await q(client, `CLOSE ${cursor}`);
  }
  return { rowCount: digest.count, rowsSha256: digest.digest() };
}

/**
 * Drop every registered tool staging or mirror relation in
 * tibotattle_transfer once its stage is complete, recording its row count
 * and canonical digest first, together with trigger functions that only it
 * used. Then assert the schema holds only RETAINED_CONTROL_RELATIONS.
 */
export async function dropTransferStagingRelations(client, handle, registry = []) {
  const run = await writableRun(client, handle);
  if (!Array.isArray(registry)) fail("CUTOVER_STAGING_REGISTRY_INVALID");
  const entries = registry.map((entry) => {
    if (entry === null || typeof entry !== "object" || entry.schema !== TRANSFER_CONTROL_SCHEMA
        || Object.keys(entry).some(key => !["schema", "table", "requiresStageComplete"].includes(key))) {
      fail("CUTOVER_STAGING_REGISTRY_INVALID");
    }
    const table = controlRelationName(entry.table);
    if (RETAINED_CONTROL_RELATIONS.includes(table) || CONTROL_SCHEMA_RELATIONS.includes(table)) {
      fail("CUTOVER_STAGING_REGISTRY_INVALID", { relation: table });
    }
    return { table, stage: assertStage(entry.requiresStageComplete) };
  });
  if (new Set(entries.map(entry => entry.table)).size !== entries.length) fail("CUTOVER_STAGING_REGISTRY_INVALID");
  const receipts = [];
  for (const entry of entries) {
    const complete = rows(await q(client, `SELECT 1 FROM ${control("transfer_stage_receipts")}
      WHERE run_id = $1 AND stage = $2 AND state = 'complete'`, [run.runId, entry.stage]));
    if (complete.length !== 1) fail("CUTOVER_STAGE_INCOMPLETE", { stage: entry.stage, relation: entry.table });
    const [recorded] = rows(await q(client, `SELECT was_present, row_count::text AS row_count, rows_sha256
      FROM ${control("transfer_dropped_relations")} WHERE run_id = $1 AND relation_name = $2`,
    [run.runId, entry.table]));
    const [relation] = rows(await q(client, `SELECT c.oid::text AS oid, c.relkind::text AS kind,
        pg_get_userbyid(c.relowner)::text AS owner
      FROM pg_catalog.pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relname = $2`,
    [TRANSFER_CONTROL_SCHEMA, entry.table]));
    if (recorded !== undefined) {
      if (relation !== undefined) fail("CUTOVER_STAGING_REGISTRY_INVALID", { relation: entry.table });
      receipts.push(Object.freeze({ relation: entry.table, wasPresent: recorded.was_present,
        rowCount: Number(databaseCount(recorded.row_count)), rowsSha256: recorded.rows_sha256 }));
      continue;
    }
    if (relation === undefined) {
      const empty = createRowsDigest().digest();
      await q(client, `INSERT INTO ${control("transfer_dropped_relations")}
          (run_id, relation_name, stage, was_present, row_count, rows_sha256)
        VALUES ($1, $2, $3, false, 0, $4)`, [run.runId, entry.table, entry.stage, empty]);
      receipts.push(Object.freeze({ relation: entry.table, wasPresent: false, rowCount: 0, rowsSha256: empty }));
      continue;
    }
    if ((relation.kind !== "r" && relation.kind !== "p") || relation.owner !== handle.schemaOwnerRole) {
      fail("CUTOVER_STAGING_REGISTRY_INVALID", { relation: entry.table });
    }
    const { rowCount, rowsSha256 } = await digestRelation(client, entry.table);
    await q(client, `INSERT INTO ${control("transfer_dropped_relations")}
        (run_id, relation_name, stage, was_present, row_count, rows_sha256)
      VALUES ($1, $2, $3, true, $4, $5)`, [run.runId, entry.table, entry.stage, rowCount, rowsSha256]);
    const functions = rows(await q(client, `SELECT DISTINCT p.oid::text AS oid
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = $1::oid AND NOT t.tgisinternal
         AND p.pronamespace = $2::regnamespace AND NOT (p.proname = ANY($3::text[]))`,
    [relation.oid, TRANSFER_CONTROL_SCHEMA, RETAINED_CONTROL_FUNCTIONS]));
    await q(client, `DROP TABLE ${control(entry.table)}`);
    for (const fn of functions) {
      const users = rows(await q(client, "SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid = $1::oid LIMIT 1",
        [fn.oid]));
      if (users.length > 0) continue;
      const [signature] = rows(await q(client, "SELECT $1::oid::regprocedure::text AS signature", [fn.oid]));
      await q(client, `DROP FUNCTION ${signature.signature}`);
    }
    receipts.push(Object.freeze({ relation: entry.table, wasPresent: true, rowCount, rowsSha256 }));
  }
  await assertControlSchemaAllowlist(client);
  return Object.freeze(receipts);
}

/**
 * No namespace, relation, function or type in the application schemas or
 * tibotattle_transfer (and no object in this database) is owned by the
 * transfer IAM login, so the login can be dropped after mark-live.
 */
export async function assertNoTransferUserOwnership(client, handle) {
  transactionRole(client, handle);
  const schemas = [handle.primarySchema, TRANSFER_CONTROL_SCHEMA];
  const [owned] = rows(await q(client, `WITH login AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $2
      ), spaces AS (
        SELECT n.oid, n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = ANY($1::text[])
      )
      SELECT (
        (SELECT count(*) FROM spaces, login WHERE spaces.nspowner = login.oid)
        + (SELECT count(*) FROM pg_catalog.pg_class c JOIN spaces ON spaces.oid = c.relnamespace, login
            WHERE c.relowner = login.oid)
        + (SELECT count(*) FROM pg_catalog.pg_proc p JOIN spaces ON spaces.oid = p.pronamespace, login
            WHERE p.proowner = login.oid)
        + (SELECT count(*) FROM pg_catalog.pg_type t JOIN spaces ON spaces.oid = t.typnamespace, login
            WHERE t.typowner = login.oid)
        + (SELECT count(*) FROM pg_catalog.pg_shdepend d, login
            WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = login.oid
              AND d.deptype = 'o'
              AND d.dbid IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())))
      )::text AS n`, [schemas, handle.iamDatabaseUser]));
  if (databaseCount(owned?.n) !== 0n) fail("CUTOVER_TRANSFER_USER_OWNS_OBJECTS");
}

// ---------------------------------------------------------------------------
// Flip readiness and the live lock.

// Besides the transfer login, a member of the schema-owner role or of
// tibotattle_source_transfer is accepted only when the owner names it
// (allowedRoleMembers, for example the migration owner that PostgreSQL 16+
// records as the creator of a role) and its membership is administrative
// only: it can neither SET ROLE to the role nor inherit its privileges, and
// it holds no direct grant on the application or control schema.
async function assertRoleMembers(client, handle, allowedRoleMembers, schema) {
  const waived = new Set(allowedRoleMembers);
  const members = rows(await q(client, `SELECT m.rolname::text AS member, am.inherit_option, am.set_option
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = am.member
     WHERE r.rolname = ANY($1::text[])`, [[handle.schemaOwnerRole, "tibotattle_source_transfer"]]));
  for (const row of members) {
    if (row.member === handle.iamDatabaseUser) continue;
    if (!waived.has(row.member) || row.inherit_option !== false || row.set_option !== false) {
      fail("CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED");
    }
  }
  if (waived.size === 0) return;
  const [granted] = rows(await q(client, `SELECT count(*)::text AS n
      FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
      JOIN pg_catalog.pg_roles grantee ON grantee.oid = acl.grantee
     WHERE n.nspname = ANY($1::text[]) AND grantee.rolname = ANY($2::text[])`,
  [[schema, TRANSFER_CONTROL_SCHEMA], [...waived]]));
  if (databaseCount(granted?.n) !== 0n) fail("CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED");
}

async function assertNoRuntimePrivilege(client) {
  const [granted] = rows(await q(client, `WITH grants AS (
        SELECT (aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner)))).grantee AS grantee,
               n.nspowner AS owner, 'schema' AS kind
          FROM pg_catalog.pg_namespace n WHERE n.nspname = $1
        UNION ALL
        SELECT (aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner)))).grantee, c.relowner, 'relation'
          FROM pg_catalog.pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        UNION ALL
        SELECT (aclexplode(COALESCE(c.relacl, acldefault('s', c.relowner)))).grantee, c.relowner, 'relation'
          FROM pg_catalog.pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'S'
        UNION ALL
        SELECT (aclexplode(a.attacl)).grantee, c.relowner, 'column'
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         WHERE c.relnamespace = $1::regnamespace AND a.attacl IS NOT NULL
        UNION ALL
        SELECT (aclexplode(p.proacl)).grantee, p.proowner, 'function'
          FROM pg_catalog.pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proacl IS NOT NULL
      )
      SELECT count(*)::text AS n FROM grants
       WHERE grantee <> owner AND NOT (kind = 'function' AND grantee = 0)`, [TRANSFER_CONTROL_SCHEMA]));
  if (databaseCount(granted?.n) !== 0n) fail("CUTOVER_FLIP_RUNTIME_PRIVILEGE");
}

async function assertUserTriggersEnabled(client, schemas) {
  const [disabled] = rows(await q(client, `SELECT c.relname::text AS relation, t.tgname::text AS trigger
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[]) AND NOT t.tgisinternal AND t.tgenabled NOT IN ('O', 'A')
     ORDER BY 1, 2 LIMIT 1`, [schemas]));
  if (disabled !== undefined) {
    fail("CUTOVER_FLIP_TRIGGER_DISABLED", { relation: disabled.relation, trigger: disabled.trigger });
  }
}

async function assertDatabaseFlipReady(client, handle, allowedRoleMembers, schema) {
  await assertRoleMembers(client, handle, allowedRoleMembers, schema);
  await assertNoRuntimePrivilege(client);
  await assertUserTriggersEnabled(client, [schema, TRANSFER_CONTROL_SCHEMA]);
  await assertNoTransferUserOwnership(client, handle);
  await assertControlSchemaAllowlist(client);
}

function flipOptions(options) {
  if (options === null || typeof options !== "object"
      || Object.keys(options).some(key => key !== "flipEvidenceSha256" && key !== "allowedRoleMembers")) {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  const { flipEvidenceSha256, allowedRoleMembers = [] } = options;
  sha256Hex(flipEvidenceSha256, "CUTOVER_FLIP_EVIDENCE_INVALID");
  if (!Array.isArray(allowedRoleMembers) || allowedRoleMembers.length > MAX_WAIVED_ROLE_MEMBERS
      || new Set(allowedRoleMembers).size !== allowedRoleMembers.length
      || allowedRoleMembers.some(member => typeof member !== "string" || !ROLE_NAME.test(member))) {
    fail("CUTOVER_TARGET_ARGUMENT_INVALID");
  }
  return { flipEvidenceSha256, allowedRoleMembers: Object.freeze([...allowedRoleMembers].sort()) };
}

/**
 * Flip readiness: a verified run with every stage complete, no checkpoint
 * cursor in any run, collection_controls equal to the sealed row, no role
 * member beyond the transfer login and owner-named administrative members,
 * no privilege on tibotattle_transfer for any other role, every user trigger
 * enabled, nothing owned by the transfer login, and the control schema
 * allowlist (which a leftover ledger mirror table fails). The report names
 * the waived members.
 */
export async function assertFlipReady(client, handle, options = {}) {
  transactionRole(client, handle, "primary");
  const { flipEvidenceSha256, allowedRoleMembers } = flipOptions(options);
  const run = await currentRun(client, handle);
  if (run.state !== "verified") fail("CUTOVER_RUN_NOT_VERIFIED");
  await assertAllStagesComplete(client, run);
  await assertNoCheckpointCursors(client);
  await assertControlsEqualSealed(client, handle, run.runId);
  await assertDatabaseFlipReady(client, handle, allowedRoleMembers, handle.primarySchema);
  return Object.freeze({ runId: run.runId, flipEvidenceSha256, ready: true, waivedRoleMembers: allowedRoleMembers });
}

// Every table of the control schema carries the enabled-always statement
// lock, no other relation kind exists, and no role (the owner included)
// holds CREATE on the schema, so no unlocked relation can be added.
async function verifyLiveLock(client) {
  const [missing] = rows(await q(client, `SELECT count(*)::text AS n FROM pg_catalog.pg_class c
     WHERE c.relnamespace = $1::regnamespace
       AND (c.relkind NOT IN ('r', 'p', 'i', 'I')
         OR (c.relkind IN ('r', 'p') AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_trigger t
            WHERE t.tgrelid = c.oid AND t.tgname = $2 AND t.tgenabled = 'A' AND t.tgtype = 62
              AND NOT t.tgisinternal
              AND t.tgfoid = 'tibotattle_transfer.transfer_target_live_lock_guard()'::regprocedure)))`,
  [TRANSFER_CONTROL_SCHEMA, LIVE_LOCK_TRIGGER]));
  if (databaseCount(missing?.n) !== 0n) fail("CUTOVER_LIVE_LOCK_INCOMPLETE");
  const [creatable] = rows(await q(client, `SELECT count(*)::text AS n FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
     WHERE n.nspname = $1 AND acl.privilege_type = 'CREATE'`, [TRANSFER_CONTROL_SCHEMA]));
  if (databaseCount(creatable?.n) !== 0n) fail("CUTOVER_LIVE_LOCK_INCOMPLETE");
  const [locked] = rows(await q(client, `SELECT count(*)::text AS n FROM pg_catalog.pg_class c
    WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'p')`, [TRANSFER_CONTROL_SCHEMA]));
  return Number(databaseCount(locked?.n));
}

// An already-live database is only read back: a relation added after live
// fails the allowlist or the lock check instead of being adopted.
async function readBackLiveLock(client) {
  await assertControlSchemaAllowlist(client);
  return verifyLiveLock(client);
}

/**
 * Mark the verified run live after assertFlipReady, then install and verify
 * the whole-schema TRANSFER_TARGET_LIVE lock in the same transaction, so a
 * run in state 'live' always carries its lock. Idempotent for the same flip
 * evidence: a repeated call on a live database is a readback that fails
 * closed on any relation added after live (a leftover ledger mirror table
 * included).
 */
export async function markLive(handle, options = {}) {
  const { flipEvidenceSha256, allowedRoleMembers } = flipOptions(options);
  const state = handleState(handle);
  if (state.runId === null) fail("CUTOVER_RUN_MISSING");
  const primaryLocked = await withTransferTransaction(handle, "primary", async (client) => {
    const run = await currentRun(client, handle, "FOR UPDATE");
    if (run.state === "live") {
      if (run.flipEvidenceSha256 !== flipEvidenceSha256) fail("CUTOVER_FLIP_EVIDENCE_INVALID");
      return readBackLiveLock(client);
    }
    await assertFlipReady(client, handle, { flipEvidenceSha256, allowedRoleMembers });
    await q(client, `UPDATE ${control("transfer_runs")} SET state = 'live', live_at = clock_timestamp(),
      flip_evidence_sha256 = $2 WHERE run_id = $1`, [run.runId, flipEvidenceSha256]);
    await q(client, "SELECT tibotattle_transfer.install_transfer_live_lock()");
    return verifyLiveLock(client);
  }, { [RUN_CONTROL]: true });
  const liveRun = await withTransferTransaction(handle, "primary", client => currentRun(client, handle),
    { readOnly: true });
  if (liveRun.state !== "live" || liveRun.flipEvidenceSha256 !== flipEvidenceSha256) {
    fail("CUTOVER_RUN_STATE_DIVERGED");
  }
  return Object.freeze({ runId: liveRun.runId, state: "live", primaryLocked });
}
