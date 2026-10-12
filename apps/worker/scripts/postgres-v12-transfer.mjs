#!/usr/bin/env node
/**
 * Rehearsal-only importer: the v1.2 telemetry family of a sealed D1
 * USAGE_MONITOR_DB SQLite export into a prefix-only PostgreSQL 17 rehearsal
 * schema (GCP fast path, package T-2).
 *
 * It mirrors scripts/postgres-typed-legacy-transfer.mjs: a sealed, hash-checked
 * SQLite source; a target schema that must carry the
 * typed_legacy_transfer_rehearsal_target_ prefix; one PostgreSQL transaction
 * per family; and row-count plus per-table SHA-256 verification of canonical
 * rows. There is no production-target mode. Run it locally with Node.js 22.13
 * or later; it is never bundled into the Cloud Run image.
 *
 * Imported (the 14 D1 telemetry_v12_* / accountless_v12_* tables, exactly):
 *   authority  telemetry_v12_runtime (-> both PostgreSQL runtime singletons),
 *              telemetry_v12_device_capabilities,
 *              accountless_v12_device_authorizations
 *   source     telemetry_v12_day_manifests, telemetry_v12_chunks,
 *              telemetry_v12_attributions, telemetry_v12_records,
 *              telemetry_v12_usage, telemetry_v12_quota,
 *              telemetry_v12_session_tools (the five typed tables land in the
 *              PostgreSQL telemetry_v12_typed_* layout)
 *   domain     telemetry_v12_domain_predecessors, telemetry_v12_domains,
 *              telemetry_v12_domain_days, telemetry_v12_domain_heads
 * plus the rows those tables reference and PostgreSQL enforces by foreign key:
 * the typed_telemetry_dictionary ids they use and the consumed
 * device_upload_authorizations their chunks name (source-key scope: present
 * rows must be identical, missing rows are inserted). Identity rows
 * (participants, devices, accountless enrollment and owner links) must already
 * be present (T-1 runs first); the importer refuses when any is missing.
 *
 * Ids, revisions, manifest JSON and digests, states and timestamps are kept
 * exactly. Timestamps are compared as UTC instants at millisecond precision
 * and calendar days as YYYY-MM-DD.
 *
 * Admission-time triggers. Two live-path triggers cannot hold for retained
 * history and are disabled only inside the family transaction that needs it,
 * re-enabled before COMMIT, and proven enabled afterwards:
 *   - telemetry_v12_typed_record_admission requires the writer's v1.2 grant to
 *     be active now; retained history may belong to an expired or opted-out
 *     grant. The importer instead proves every typed record belongs to a chunk
 *     of the same manifest and stream, carries the UTC day of its instant and
 *     never exceeds its chunk's record count; the ready-day integrity guard
 *     (left enabled) then checks every ready manifest is complete.
 *   - storage_v12_head_publication appends the live owner journal and input
 *     revisions. Those are D1 history imported by their own importers, so a
 *     copied head must not mint a second journal event.
 * Every other trigger stays enabled; the import order satisfies them
 * (manifests are written staged and promoted to ready after their chunks and
 * records, generations are written oldest first with their days before any
 * successor or head, and each chunk is registered in pending_objects for the
 * reconciliation guard and the referenced registration is then cleared, as the
 * reconciler does once a durable row references the object).
 *
 * After the import the PostgreSQL v1.2 effective reader is checked against the
 * source: for every participant with a v1.2 generation, stream and day, the
 * current-head occurrence-id set read through readPostgresTelemetryV12EffectiveDays,
 * ...CandidatePage and ...Occurrences equals the set computed from the source
 * rows with the reader's own join (head generation, ready manifest, complete
 * chunk, retained authorization). The reader is TypeScript, so callers inject
 * it (the CLI loads it through Vite). The D1 production reader reads every
 * generation, not only the head; days where that union differs from the head
 * set are counted and reported (unionDivergentDayStreams), never hidden.
 *
 * The result is staged rehearsal evidence only. It names no participant,
 * device or occurrence: per-participant results carry a one-way key.
 *
 * Usage (local only; connection settings come from the PG* environment; the
 * target must already be migrated and hold T-1's identity rows, and the
 * control schema must already exist):
 *   node scripts/postgres-v12-transfer.mjs --source <absolute sealed .sqlite>
 *     --source-sha256 <hex> --target-schema typed_legacy_transfer_rehearsal_target_<suffix>
 *     --control-schema typed_legacy_transfer_rehearsal_<suffix> --transfer-id <id> [--page-size <n>]
 * Proof: postgres-test/postgres-v12-transfer.spec.mjs.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX,
} from "./postgres-typed-legacy-transfer.mjs";

export const POSTGRES_V12_TRANSFER_SCHEMA = "sealed-d1-telemetry-v12-to-postgres-rehearsal-v1";
export const POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX = POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX;
export const POSTGRES_V12_TRANSFER_CONTROL_SCHEMA_PREFIX = POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX;
export const POSTGRES_V12_TRANSFER_RUN_TABLE = "_v12_transfer_rehearsal_runs_v1";
export const POSTGRES_V12_TRANSFER_DEFAULT_PAGE_SIZE = 250;
export const POSTGRES_V12_TRANSFER_MAX_PAGE_SIZE = 500;
/** The promoted migration level this importer's trigger contract was read at. */
export const POSTGRES_V12_TRANSFER_MIN_MIGRATION_VERSION = 58;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const CONSTANT_MESSAGE = /^[a-z][a-z0-9_]{2,80}$/u;
const MAX_SEALED_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_BYTES = 1_024;
const MAX_PG_PARAMETERS = 60_000;
const DAY_MS = 86_400_000;
const READER_DAYS_WINDOW = 101;
const READER_OCCURRENCE_BATCH = 200;
const STREAMS = Object.freeze(["usage", "quota", "session"]);
const FAMILIES = Object.freeze(["authority", "source", "domain"]);
const RECORD_ADMISSION_TRIGGER = Object.freeze({
  table: "telemetry_v12_typed_records", trigger: "telemetry_v12_typed_record_admission",
});
const HEAD_PUBLICATION_TRIGGER = Object.freeze({
  table: "telemetry_v12_domain_heads", trigger: "storage_v12_head_publication",
});
const TRUSTED_SOURCES = new WeakSet();

export class PostgresV12TransferError extends Error {
  constructor(code, detail = undefined) {
    super(code);
    this.name = "PostgresV12TransferError";
    this.code = code;
    if (detail !== undefined) this.detail = Object.freeze(detail);
  }
}

function fail(code, detail) {
  throw new PostgresV12TransferError(code, detail);
}

/** Closed, content-free summary of a driver error (no values or identifiers). */
function databaseDetail(error) {
  const detail = {};
  if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)) detail.sqlstate = error.code;
  if (typeof error?.constraint === "string" && IDENTIFIER.test(error.constraint)) detail.constraint = error.constraint;
  if (typeof error?.message === "string" && CONSTANT_MESSAGE.test(error.message)) detail.message = error.message;
  return detail;
}

function rethrow(error, code) {
  if (error instanceof PostgresV12TransferError) throw error;
  fail(code, databaseDetail(error));
}

// ---------------------------------------------------------------------------
// Table layout

function column(name, type, options = {}) {
  return Object.freeze({ name, type, source: options.source ?? null });
}

function spec(name, options) {
  const columns = Object.freeze(options.columns);
  const primaryKey = Object.freeze(options.primaryKey);
  if (primaryKey.some(key => !columns.some(entry => entry.name === key))) {
    throw new TypeError("v12 transfer table definition invalid");
  }
  return Object.freeze({
    name,
    target: options.target ?? name,
    family: options.family,
    scope: options.scope ?? "all-rows",
    singleton: options.singleton === true,
    columns,
    primaryKey,
    sourceFrom: options.sourceFrom ?? `"${name}"`,
    sourceWhere: options.sourceWhere ?? null,
    sourceTables: Object.freeze(options.sourceTables ?? [name]),
  });
}

const DICTIONARY_REFERENCES = `
  SELECT provider_id AS id FROM telemetry_v12_records
  UNION SELECT model_id FROM telemetry_v12_usage UNION SELECT speed_mode_id FROM telemetry_v12_usage
  UNION SELECT api_service_tier_id FROM telemetry_v12_usage UNION SELECT surface_id FROM telemetry_v12_usage
  UNION SELECT billing_surface_id FROM telemetry_v12_usage UNION SELECT reasoning_effort_id FROM telemetry_v12_usage
  UNION SELECT agent_scope_id FROM telemetry_v12_usage UNION SELECT outcome_id FROM telemetry_v12_usage
  UNION SELECT plan_type_id FROM telemetry_v12_quota UNION SELECT plan_variant_id FROM telemetry_v12_quota
  UNION SELECT limit_id FROM telemetry_v12_quota UNION SELECT slot_id FROM telemetry_v12_quota
  UNION SELECT tool_class_id FROM telemetry_v12_session_tools
  UNION SELECT plan_type_id FROM telemetry_v12_attributions`;

const RUNTIME_COLUMNS = Object.freeze([
  column("id", "i32"), column("schema_version", "text"), column("envelope_schema_version", "text"),
  column("field_dictionary_version", "text"), column("privacy_contract_version", "text"),
  column("state", "text"), column("policy_revision", "i32"), column("max_day_chunks", "i32"),
  column("max_chunk_records", "i32"), column("max_day_bytes", "i32"), column("changed_at", "ts"),
]);

const TABLES = Object.freeze([
  // authority
  spec("telemetry_v12_runtime", {
    target: "telemetry_v12_typed_runtime", family: "authority", singleton: true,
    columns: RUNTIME_COLUMNS, primaryKey: ["id"],
  }),
  // D1 keeps one runtime row; PostgreSQL also has the transport runtime whose
  // revision starts at 0 where D1's policy revision starts at 1 (every
  // activation increments both, see postgres-transport-write-authority.spec).
  spec("telemetry_v12_runtime#transport", {
    target: "telemetry_v12_runtime", family: "authority", singleton: true,
    sourceFrom: "\"telemetry_v12_runtime\"", sourceTables: ["telemetry_v12_runtime"],
    columns: [column("id", "i32"), column("state", "text"),
      column("revision", "i32", { source: "\"policy_revision\" - 1" }), column("changed_at", "ts")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_device_capabilities", {
    family: "authority",
    columns: [column("participant_id", "text"), column("device_id", "text"),
      column("telemetry_schema_version", "text"), column("field_dictionary_version", "text"),
      column("privacy_contract_version", "text"), column("state", "text"),
      column("consented_at", "ts"), column("revoked_at", "ts")],
    primaryKey: ["participant_id", "device_id"],
  }),
  spec("accountless_v12_device_authorizations", {
    family: "authority",
    columns: [column("enrollment_device_id", "text"), column("participant_id", "text"),
      column("device_credential_id", "text"), column("schema_version", "text"),
      column("policy_version", "text"), column("authorization_basis", "text"),
      column("telemetry_schema_version", "text"), column("field_dictionary_version", "text"),
      column("privacy_contract_version", "text"), column("authorized_at", "ts"),
      column("expires_at", "ts"), column("state", "text"), column("revoked_at", "ts"),
      column("revocation_reason", "text")],
    primaryKey: ["enrollment_device_id"],
  }),
  // source (dependencies first: their rows are referenced by foreign key)
  spec("typed_telemetry_dictionary", {
    family: "source", scope: "source-keys",
    sourceFrom: `"typed_telemetry_dictionary" WHERE "id" IN (${DICTIONARY_REFERENCES})`,
    sourceTables: ["typed_telemetry_dictionary", "telemetry_v12_records", "telemetry_v12_usage",
      "telemetry_v12_quota", "telemetry_v12_session_tools", "telemetry_v12_attributions"],
    columns: [column("id", "i64"), column("value", "text")],
    primaryKey: ["id"],
  }),
  spec("device_upload_authorizations", {
    family: "source", scope: "source-keys",
    sourceFrom: `"device_upload_authorizations" WHERE "id" IN (
      SELECT device_upload_authorization_id FROM telemetry_v12_chunks)`,
    sourceTables: ["device_upload_authorizations", "telemetry_v12_chunks"],
    columns: [column("id", "text"), column("participant_id", "text"), column("issued_by_device_id", "text"),
      column("secret_hash", "bytes"), column("envelope_digest", "text"), column("body_bytes", "i32"),
      column("content_type", "text"), column("state", "text"), column("issued_at", "ts"),
      column("expires_at", "ts"), column("consumed_at", "ts"), column("revoked_at", "ts"),
      column("consume_lease_expires_at", "ts"), column("consumed_contribution_id", "text")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_day_manifests", {
    family: "source",
    columns: [column("id", "text"), column("participant_id", "text"), column("device_id", "text"),
      column("chunk_day", "date"), column("manifest_digest", "text"), column("parser_version", "text"),
      column("manifest_json", "text"), column("expected_chunk_count", "i32"), column("state", "text"),
      column("created_at", "ts"), column("ready_at", "ts")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_chunks", {
    family: "source",
    columns: [column("id", "text"), column("manifest_id", "text"), column("participant_id", "text"),
      column("device_id", "text"), column("stream", "text"), column("chunk_day", "date"),
      column("chunk_seq", "i32"), column("chunk_id", "text"), column("chunk_digest", "text"),
      column("envelope_digest", "text"), column("parser_version", "text"), column("record_count", "i32"),
      column("r2_key", "text"), column("device_upload_authorization_id", "text"), column("created_at", "ts")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_attributions", {
    target: "telemetry_v12_typed_attributions", family: "source",
    columns: [column("id", "i64"), column("account_basis", "i16"), column("account_track", "bytes"),
      column("plan_basis", "i16"), column("plan_type_id", "i64"), column("plan_era", "bytes")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_records", {
    target: "telemetry_v12_typed_records", family: "source",
    columns: [column("id", "i64"), column("chunk_id", "text"), column("manifest_id", "text"),
      column("stream", "text"), column("record_index", "i32"), column("occurrence_id", "bytes"),
      column("observed_at_ms", "i64"), column("observed_day", "i32"), column("provider_id", "i64"),
      column("canonical_digest", "bytes")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_usage", {
    target: "telemetry_v12_typed_usage", family: "source",
    columns: [column("record_id", "i64"), column("session_id", "bytes"), column("model_id", "i64"),
      column("speed_mode_id", "i64"), column("api_service_tier_id", "i64"), column("surface_id", "i64"),
      column("billing_surface_id", "i64"), column("reasoning_effort_id", "i64"),
      column("agent_scope_id", "i64"), column("outcome_id", "i64"), column("attribution_id", "i64"),
      column("total_input_context_tokens", "i64"), column("input_uncached_tokens", "i64"),
      column("input_cache_read_tokens", "i64"), column("input_cache_write_tokens", "i64"),
      column("output_text_tokens", "i64"), column("output_reasoning_tokens", "i64"),
      column("output_combined_tokens", "i64"), column("boundary_flags", "i32"), column("tie_order", "i32"),
      column("cache_write_ttl_five_minute_tokens", "i64"), column("cache_write_ttl_one_hour_tokens", "i64")],
    primaryKey: ["record_id"],
  }),
  spec("telemetry_v12_quota", {
    target: "telemetry_v12_typed_quota", family: "source",
    columns: [column("record_id", "i64"), column("plan_type_id", "i64"), column("plan_variant_id", "i64"),
      column("limit_id", "i64"), column("slot_id", "i64"), column("used_percent", "f64"),
      column("window_duration_minutes", "i32"), column("resets_at_ms", "i64"), column("attribution_id", "i64")],
    primaryKey: ["record_id"],
  }),
  spec("telemetry_v12_session_tools", {
    target: "telemetry_v12_typed_session_tools", family: "source",
    columns: [column("record_id", "i64"), column("tool_class_id", "i64"), column("count", "i64")],
    primaryKey: ["record_id", "tool_class_id"],
  }),
  // domain
  spec("telemetry_v12_domain_predecessors", {
    family: "domain",
    columns: [column("token_hash", "text"), column("participant_id", "text"), column("device_id", "text"),
      column("previous_generation_id", "text"), column("legacy_fingerprint", "text"),
      column("input_revision", "i32"), column("from_day", "date"), column("through_day", "date"),
      column("days_json", "text"), column("created_at", "ts"), column("expires_at", "ts"),
      column("consumed_at", "ts")],
    primaryKey: ["token_hash"],
  }),
  spec("telemetry_v12_domains", {
    family: "domain",
    columns: [column("id", "text"), column("participant_id", "text"), column("device_id", "text"),
      column("predecessor_token_hash", "text"), column("previous_generation_id", "text"),
      column("manifest_digest", "text"), column("legacy_fingerprint", "text"),
      column("input_revision", "i32"), column("from_day", "date"), column("through_day", "date"),
      column("days_json", "text"), column("created_at", "ts")],
    primaryKey: ["id"],
  }),
  spec("telemetry_v12_domain_days", {
    family: "domain",
    columns: [column("generation_id", "text"), column("observed_day", "date"),
      column("manifest_id", "text"), column("manifest_digest", "text")],
    primaryKey: ["generation_id", "observed_day"],
  }),
  spec("telemetry_v12_domain_heads", {
    family: "domain",
    columns: [column("participant_id", "text"), column("generation_id", "text"),
      column("revision", "i32"), column("updated_at", "ts")],
    primaryKey: ["participant_id"],
  }),
]);
const TABLE_BY_NAME = new Map(TABLES.map(entry => [entry.name, entry]));

/** The fourteen D1 tables this importer owns, by their D1 names. */
export const POSTGRES_V12_TRANSFER_SOURCE_TABLES = Object.freeze([...new Set(TABLES
  .filter(entry => entry.scope === "all-rows")
  .map(entry => entry.sourceTables[0]))]);
/** Every source relation the sealed file must contain (owned, referenced and verification inputs). */
export const POSTGRES_V12_TRANSFER_REQUIRED_SOURCE_RELATIONS = Object.freeze([
  ...new Set([...TABLES.flatMap(entry => entry.sourceTables),
    "participants", "device_credentials", "storage_v11_owner_links",
    "accountless_enrollment_ledger", "accountless_upload_owners"]),
]);
export const POSTGRES_V12_TRANSFER_LAYOUT = Object.freeze(TABLES.map(entry => Object.freeze({
  name: entry.name, target: entry.target, family: entry.family, scope: entry.scope,
  columns: Object.freeze(entry.columns.map(value => Object.freeze({ name: value.name, type: value.type }))),
  primaryKey: entry.primaryKey,
})));

/** Migration seeds of the two runtime singletons (primary 0006 and 0025). */
const RUNTIME_SEEDS = Object.freeze({
  "telemetry_v12_runtime": Object.freeze({
    id: 1, schema_version: "telemetry-contribution-v1.2", envelope_schema_version: "telemetry-envelope-v1.2",
    field_dictionary_version: "telemetry-v1.2-registry-2026-09-20.1",
    privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.2", state: "staged", policy_revision: 1,
    max_day_chunks: 4096, max_chunk_records: 200, max_day_bytes: 64_000_000,
    changed_at: "1970-01-01T00:00:00.000Z",
  }),
  "telemetry_v12_runtime#transport": Object.freeze({
    id: 1, state: "staged", revision: 0, changed_at: "1970-01-01T00:00:00.000Z",
  }),
});

// ---------------------------------------------------------------------------
// Canonical values

function sha256() {
  return createHash("sha256");
}

function normalizeInteger(value, type) {
  if (value === null || value === undefined) return null;
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) parsed = BigInt(value);
  else fail("V12_TRANSFER_VALUE_INVALID");
  if (type === "i64") {
    if (parsed < -(2n ** 63n) || parsed >= 2n ** 63n) fail("V12_TRANSFER_VALUE_INVALID");
    return parsed.toString();
  }
  const limit = type === "i16" ? 32_768n : 2_147_483_648n;
  if (parsed < -limit || parsed >= limit) fail("V12_TRANSFER_VALUE_INVALID");
  return Number(parsed);
}

function normalizeInstant(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail("V12_TRANSFER_VALUE_INVALID");
    return value.toISOString();
  }
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) fail("V12_TRANSFER_TIMESTAMP_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("V12_TRANSFER_TIMESTAMP_INVALID");
  return new Date(parsed).toISOString();
}

function normalizeDay(value) {
  if (typeof value !== "string" || !DAY.test(value)) fail("V12_TRANSFER_DAY_INVALID");
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail("V12_TRANSFER_DAY_INVALID");
  }
  return value;
}

function normalizeValue(type, value) {
  if (value === null) return null;
  if (value === undefined) fail("V12_TRANSFER_VALUE_INVALID");
  switch (type) {
    case "i16": case "i32": case "i64": return normalizeInteger(value, type);
    case "f64": {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) fail("V12_TRANSFER_VALUE_INVALID");
      return Object.is(parsed, -0) ? 0 : parsed;
    }
    case "text":
      if (typeof value !== "string" || value.length > MAX_TEXT_CHARS) fail("V12_TRANSFER_VALUE_INVALID");
      return value;
    case "ts": return normalizeInstant(value);
    case "date": return normalizeDay(value);
    case "bytes": {
      if (Array.isArray(value)) value = Uint8Array.from(value);
      if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) fail("V12_TRANSFER_VALUE_INVALID");
      const result = Buffer.from(value);
      if (result.byteLength > MAX_BYTES) fail("V12_TRANSFER_VALUE_INVALID");
      return result;
    }
    default: fail("V12_TRANSFER_COLUMN_TYPE_INVALID");
  }
}

function normalizeRow(entry, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("V12_TRANSFER_ROW_INVALID");
  const row = Object.create(null);
  for (const value of entry.columns) row[value.name] = normalizeValue(value.type, raw[value.name]);
  return row;
}

function canonicalValue(type, value) {
  if (value === null) return null;
  if (type === "bytes") return ["bytea", value.toString("base64")];
  if (type === "i64") return ["int64", value];
  if (type === "i16" || type === "i32") return [type, value];
  if (type === "f64") return ["float64", value];
  if (type === "ts") return ["timestamp", value];
  if (type === "date") return ["date", value];
  return ["text", value];
}

function canonicalLine(entry, row) {
  return `${JSON.stringify(entry.columns.map(value => canonicalValue(value.type, row[value.name])))}\n`;
}

function sameRow(entry, left, right) {
  return canonicalLine(entry, left) === canonicalLine(entry, right);
}

function keyValues(entry, row) {
  return entry.primaryKey.map(name => row[name]);
}

function manifestSha256(tables) {
  return sha256().update(JSON.stringify({
    schema: POSTGRES_V12_TRANSFER_SCHEMA,
    tables: TABLES.map(entry => ({ table: entry.name, scope: entry.scope,
      rows: tables[entry.name].rows, sha256: tables[entry.name].sha256 })),
  })).digest("hex");
}

// ---------------------------------------------------------------------------
// Sealed SQLite source

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function assertNoSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("V12_TRANSFER_SEALED_SQLITE_UNAVAILABLE");
    }
    fail("V12_TRANSFER_SEALED_SQLITE_SIDECAR_PRESENT");
  }
}

async function sealedFingerprint(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) {
      fail("V12_TRANSFER_SEALED_SQLITE_PATH_INVALID");
    }
    await assertNoSidecars(path);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SEALED_SQLITE_BYTES) {
      fail("V12_TRANSFER_SEALED_SQLITE_UNSAFE");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened)) fail("V12_TRANSFER_SEALED_SQLITE_CHANGED");
    const hash = sha256();
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("V12_TRANSFER_SEALED_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after)) fail("V12_TRANSFER_SEALED_SQLITE_CHANGED");
    await assertNoSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresV12TransferError) throw error;
    fail("V12_TRANSFER_SEALED_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Open a sealed D1 USAGE_MONITOR_DB SQLite export: absolute, symlink-free,
 * owner-owned, read-only, single-link, no journal sidecars, exact SHA-256,
 * quick_check ok, and every relation the transfer and its verification read.
 */
export async function createSealedSqliteV12RehearsalSource({ path, expectedSha256 } = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("V12_TRANSFER_SEALED_SQLITE_SHA256_REQUIRED");
  const initial = await sealedFingerprint(path);
  if (initial.sha256 !== expectedSha256) fail("V12_TRANSFER_SEALED_SQLITE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("V12_TRANSFER_SEALED_SQLITE_SIDECAR_PRESENT");
    }
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
      fail("V12_TRANSFER_SEALED_SQLITE_INTEGRITY_FAILED");
    }
    const available = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
    ).all().map(row => row.name));
    const missing = POSTGRES_V12_TRANSFER_REQUIRED_SOURCE_RELATIONS.filter(name => !available.has(name));
    if (missing.length > 0 || !available.has("telemetry_v12_active_authorizations")) {
      fail("V12_TRANSFER_SOURCE_TABLE_MISSING", { missing: missing.length
        + (available.has("telemetry_v12_active_authorizations") ? 0 : 1) });
    }
  } catch (error) {
    database?.close();
    if (error instanceof PostgresV12TransferError) throw error;
    fail("V12_TRANSFER_SEALED_SQLITE_INVALID");
  }
  const snapshot = Object.freeze({
    kind: "sealed-sqlite-rehearsal", snapshotId: `sha256:${expectedSha256}`,
    artifactSha256: expectedSha256, immutable: true,
  });
  const statements = new Map();
  let closed = false;
  function statement(sql) {
    if (closed) fail("V12_TRANSFER_SEALED_SQLITE_CLOSED");
    let prepared = statements.get(sql);
    if (!prepared) {
      try {
        prepared = database.prepare(sql);
        prepared.setReadBigInts(true);
      } catch {
        fail("V12_TRANSFER_SEALED_SQLITE_READ_FAILED");
      }
      statements.set(sql, prepared);
    }
    return prepared;
  }
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      if (closed) fail("V12_TRANSFER_SEALED_SQLITE_CLOSED");
      const actual = await sealedFingerprint(path);
      if (actual.sha256 !== expectedSha256 || !sameFileIdentity(initial.stat, actual.stat)) {
        fail("V12_TRANSFER_SNAPSHOT_CHANGED");
      }
      return { snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256 };
    },
    all(sql, ...parameters) {
      try {
        return statement(sql).all(...parameters);
      } catch (error) {
        if (error instanceof PostgresV12TransferError) throw error;
        fail("V12_TRANSFER_SEALED_SQLITE_READ_FAILED");
      }
    },
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      database.close();
    },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

function trustedSource(source) {
  if (!source || !TRUSTED_SOURCES.has(source) || source.snapshot?.kind !== "sealed-sqlite-rehearsal"
      || !SHA256.test(source.snapshot.artifactSha256 ?? "")) {
    fail("V12_TRANSFER_SNAPSHOT_REQUIRED");
  }
  return source.snapshot;
}

async function assertSnapshot(source, snapshot) {
  const actual = await source.verifySnapshot();
  if (actual?.snapshotId !== snapshot.snapshotId || actual?.artifactSha256 !== snapshot.artifactSha256) {
    fail("V12_TRANSFER_SNAPSHOT_CHANGED");
  }
}

function sourceSelect(entry) {
  const columns = entry.columns.map(value => value.source === null
    ? `"${value.name}"` : `${value.source} AS "${value.name}"`).join(", ");
  return `SELECT ${columns} FROM ${entry.sourceFrom}`;
}

function sourceKeysetSql(entry) {
  const key = entry.primaryKey.map(name => `"${name}"`);
  const tuple = key.length === 1 ? key[0] : `(${key.join(",")})`;
  const marks = key.length === 1 ? "?" : `(${key.map(() => "?").join(",")})`;
  return {
    first: `SELECT * FROM (${sourceSelect(entry)}) ORDER BY ${key.join(",")} LIMIT ?`,
    next: `SELECT * FROM (${sourceSelect(entry)}) WHERE ${tuple} > ${marks} ORDER BY ${key.join(",")} LIMIT ?`,
  };
}

function sqliteKey(entry, row) {
  return entry.primaryKey.map(name => {
    const type = entry.columns.find(value => value.name === name).type;
    return type === "i64" ? BigInt(row[name]) : row[name];
  });
}

/** Yield normalized source rows of one table in primary-key order, in bounded pages. */
function* sourcePages(source, entry, pageSize) {
  const sql = sourceKeysetSql(entry);
  let after = null;
  for (;;) {
    const raw = after === null ? source.all(sql.first, pageSize) : source.all(sql.next, ...after, pageSize);
    if (!Array.isArray(raw) || raw.length > pageSize) fail("V12_TRANSFER_SOURCE_PAGE_INVALID");
    const rows = raw.map(value => normalizeRow(entry, value));
    if (rows.length > 0) yield rows;
    if (rows.length < pageSize) return;
    after = sqliteKey(entry, rows.at(-1));
  }
}

function scanSource(source, pageSize) {
  const tables = Object.create(null);
  for (const entry of TABLES) {
    const hash = sha256();
    let rows = 0;
    for (const page of sourcePages(source, entry, pageSize)) {
      for (const row of page) {
        hash.update(canonicalLine(entry, row));
        rows += 1;
      }
    }
    if (entry.singleton && rows !== 1) fail("V12_TRANSFER_SOURCE_SINGLETON_INVALID");
    tables[entry.name] = Object.freeze({ scope: entry.scope, rows, sha256: hash.digest("hex") });
  }
  return Object.freeze({ schema: POSTGRES_V12_TRANSFER_SCHEMA, tables: Object.freeze(tables),
    sha256: manifestSha256(tables) });
}

// ---------------------------------------------------------------------------
// PostgreSQL target

function schemaName(value, code) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.startsWith("pg_")
      || value === "information_schema") fail(code);
  return value;
}

function relation(schema, name) {
  return `"${schema}"."${name}"`;
}

// Target reads alias the relation as "target_row" and qualify every column:
// the text projections below reuse the column names as output aliases, and an
// unqualified ORDER BY would sort by those text aliases (so "10" < "2").
const TARGET_ROW = "target_row";

function targetExpression(value) {
  const name = `"${value.name}"`;
  const column = `${TARGET_ROW}.${name}`;
  if (value.type === "ts") {
    return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${name}`;
  }
  if (value.type === "date") return `to_char(${column}, 'YYYY-MM-DD') AS ${name}`;
  if (value.type === "i64" || value.type === "i32" || value.type === "i16") return `${column}::text AS ${name}`;
  return `${column} AS ${name}`;
}

/** Primary-key order matching SQLite's: numeric for integers, bytewise ("C") for text. */
function targetOrder(entry) {
  return entry.primaryKey.map(name => {
    const type = entry.columns.find(value => value.name === name).type;
    return type === "text" ? `${TARGET_ROW}."${name}" COLLATE "C"` : `${TARGET_ROW}."${name}"`;
  }).join(", ");
}

function parameterCast(type) {
  switch (type) {
    case "i16": return "::smallint";
    case "i32": return "::integer";
    case "i64": return "::bigint";
    case "f64": return "::double precision";
    case "ts": return "::timestamptz";
    case "date": return "::date";
    case "bytes": return "::bytea";
    default: return "::text";
  }
}

async function withTransaction(pool, operation, { isolation = "READ COMMITTED", readOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}${readOnly ? " READ ONLY" : ""}`);
    await client.query("SET LOCAL statement_timeout = '600s'");
    await client.query("SET LOCAL lock_timeout = '30s'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Stream one target table (all rows, or only `keys`) in canonical order. */
async function scanTarget(client, schema, entry, pageSize, keys = null) {
  const columns = entry.columns.map(targetExpression).join(", ");
  const name = `v12_transfer_${entry.target}`.slice(0, 63);
  const hash = sha256();
  let rows = 0;
  let where = "";
  const parameters = [];
  if (keys !== null) {
    if (entry.primaryKey.length !== 1) fail("V12_TRANSFER_TABLE_INVALID");
    const keyType = entry.columns.find(value => value.name === entry.primaryKey[0]).type;
    where = ` WHERE ${TARGET_ROW}."${entry.primaryKey[0]}" = ANY($1${keyType === "i64" ? "::bigint[]" : "::text[]"})`;
    parameters.push(keys);
  }
  await client.query(`DECLARE "${name}" NO SCROLL CURSOR FOR SELECT ${columns}
    FROM ${relation(schema, entry.target)} ${TARGET_ROW}${where} ORDER BY ${targetOrder(entry)}`, parameters);
  try {
    for (;;) {
      const page = await client.query(`FETCH ${pageSize} FROM "${name}"`);
      for (const raw of page.rows) {
        hash.update(canonicalLine(entry, normalizeRow(entry, raw)));
        rows += 1;
      }
      if (page.rows.length < pageSize) break;
    }
  } finally {
    await client.query(`CLOSE "${name}"`);
  }
  return Object.freeze({ scope: entry.scope, rows, sha256: hash.digest("hex") });
}

function sourceKeys(source, entry, pageSize) {
  const keys = [];
  for (const page of sourcePages(source, entry, pageSize)) {
    for (const row of page) keys.push(row[entry.primaryKey[0]]);
  }
  return keys;
}

async function targetRowCount(client, schema, entry) {
  const result = await client.query(`SELECT count(*)::text AS count FROM ${relation(schema, entry.target)}`);
  return BigInt(result.rows[0]?.count ?? "0");
}

async function targetSingleton(client, schema, entry) {
  const result = await client.query(`SELECT ${entry.columns.map(targetExpression).join(", ")}
    FROM ${relation(schema, entry.target)} ${TARGET_ROW} ORDER BY ${TARGET_ROW}."id"`);
  if (result.rows.length !== 1) fail("V12_TRANSFER_TARGET_SINGLETON_INVALID");
  return normalizeRow(entry, result.rows[0]);
}

async function assertTarget(pool, targetSchema) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    fail("V12_TRANSFER_DESTINATION_INVALID");
  }
  let version;
  let history;
  try {
    version = Number((await pool.query("SELECT current_setting('server_version_num')::integer AS v")).rows[0]?.v);
    history = (await pool.query(`SELECT count(*)::integer AS count, min(version)::integer AS first,
        max(version)::integer AS latest FROM ${relation(targetSchema, "_tibotattle_migration_history")}`)).rows[0];
  } catch {
    fail("V12_TRANSFER_TARGET_MIGRATION_REQUIRED");
  }
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("V12_TRANSFER_POSTGRES_17_REQUIRED");
  if (!history || history.first !== 1 || history.count !== history.latest
      || history.latest < POSTGRES_V12_TRANSFER_MIN_MIGRATION_VERSION) {
    fail("V12_TRANSFER_TARGET_MIGRATION_REQUIRED");
  }
  return Object.freeze({ postgresMajor: Math.floor(version / 10_000), migrationVersion: history.latest });
}

/** Every user trigger on the v1.2 targets must exist and be enabled ('O'). */
async function assertTriggersEnabled(client, schema) {
  const targets = [...new Set(TABLES.filter(entry => entry.scope === "all-rows").map(entry => entry.target))];
  const result = await client.query(`SELECT c.relname AS table_name, t.tgname AS trigger_name,
      t.tgenabled::text AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal AND c.relname = ANY($2::text[])`, [schema, targets]);
  if (result.rows.some(row => row.enabled !== "O")) fail("V12_TRANSFER_TARGET_TRIGGER_DISABLED");
  for (const required of [RECORD_ADMISSION_TRIGGER, HEAD_PUBLICATION_TRIGGER]) {
    if (!result.rows.some(row => row.table_name === required.table && row.trigger_name === required.trigger)) {
      fail("V12_TRANSFER_TARGET_TRIGGER_CONTRACT_CHANGED");
    }
  }
  return result.rows.length;
}

/**
 * Identity rows the v1.2 rows reference must already be in the target (T-1):
 * every participant with the source's state, every (participant, device) pair,
 * every accountless enrollment ledger row, and every owner link with the
 * source's state (the reader's retained-authorization scope reads it).
 */
async function assertIdentityPresent(source, client, schema) {
  const devices = source.all(`SELECT DISTINCT participant_id, device_id FROM (
      SELECT participant_id, device_id FROM telemetry_v12_device_capabilities
      UNION SELECT participant_id, device_credential_id FROM accountless_v12_device_authorizations
      UNION SELECT participant_id, device_id FROM telemetry_v12_day_manifests
      UNION SELECT participant_id, device_id FROM telemetry_v12_chunks
      UNION SELECT participant_id, device_id FROM telemetry_v12_domain_predecessors
      UNION SELECT participant_id, device_id FROM telemetry_v12_domains
      UNION SELECT participant_id, issued_by_device_id FROM device_upload_authorizations
        WHERE id IN (SELECT device_upload_authorization_id FROM telemetry_v12_chunks))
    ORDER BY participant_id, device_id`);
  const participants = source.all(`SELECT p.id, p.state, link.state AS link_state FROM participants p
      LEFT JOIN storage_v11_owner_links link ON link.participant_id = p.id
     WHERE p.id IN (SELECT participant_id FROM telemetry_v12_device_capabilities
       UNION SELECT participant_id FROM accountless_v12_device_authorizations
       UNION SELECT participant_id FROM telemetry_v12_day_manifests
       UNION SELECT participant_id FROM telemetry_v12_domains
       UNION SELECT participant_id FROM telemetry_v12_domain_heads)
     ORDER BY p.id`);
  const ledgers = source.all("SELECT enrollment_device_id AS id FROM accountless_v12_device_authorizations ORDER BY 1");
  const linked = participants.filter(row => row.link_state !== null);
  const found = (await client.query(`SELECT
      (SELECT count(*)::integer FROM unnest($1::text[], $2::text[]) AS expected(id, state)
         JOIN ${relation(schema, "participants")} p ON p.id = expected.id AND p.state = expected.state) AS participants,
      (SELECT count(*)::integer FROM unnest($3::text[], $4::text[]) AS expected(participant_id, device_id)
         JOIN ${relation(schema, "device_credentials")} device
           ON device.id = expected.device_id AND device.participant_id = expected.participant_id) AS devices,
      (SELECT count(*)::integer FROM ${relation(schema, "accountless_enrollment_ledger")}
         WHERE device_id = ANY($5::text[])) AS ledgers,
      (SELECT count(*)::integer FROM unnest($6::text[], $7::text[]) AS expected(participant_id, state)
         JOIN ${relation(schema, "storage_v11_owner_links")} link
           ON link.participant_id = expected.participant_id AND link.state = expected.state) AS links,
      (SELECT count(*)::integer FROM ${relation(schema, "storage_v11_owner_links")}
         WHERE participant_id = ANY($8::text[])) AS unexpected_links`,
  [participants.map(row => row.id), participants.map(row => row.state),
    devices.map(row => row.participant_id), devices.map(row => row.device_id),
    ledgers.map(row => row.id),
    linked.map(row => row.id), linked.map(row => row.link_state),
    participants.filter(row => row.link_state === null).map(row => row.id)])).rows[0];
  if (found?.participants !== participants.length || found?.devices !== devices.length
      || found?.ledgers !== ledgers.length) {
    fail("V12_TRANSFER_TARGET_IDENTITY_MISSING");
  }
  if (found?.links !== linked.length || found?.unexpected_links !== 0) {
    fail("V12_TRANSFER_TARGET_OWNER_LINK_MISMATCH");
  }
  return Object.freeze({ participants: participants.length, devices: devices.length,
    ledgers: ledgers.length, ownerLinks: linked.length });
}

// ---------------------------------------------------------------------------
// Family state and writes

/**
 * Classify one owned table: 'pristine' (empty, or a singleton at its migration
 * seed), 'equal' (already holds exactly the source rows), or a refusal.
 */
async function classifyTable(client, schema, entry, sourceManifest, source, pageSize) {
  if (entry.singleton) {
    const current = await targetSingleton(client, schema, entry);
    const expected = [...sourcePages(source, entry, pageSize)][0][0];
    if (sameRow(entry, current, expected)) return "equal";
    if (sameRow(entry, current, normalizeRow(entry, RUNTIME_SEEDS[entry.name]))) return "pristine";
    fail("V12_TRANSFER_TARGET_NOT_EMPTY", { table: entry.target });
  }
  if (await targetRowCount(client, schema, entry) === 0n) return "pristine";
  const actual = await scanTarget(client, schema, entry, pageSize);
  const expected = sourceManifest.tables[entry.name];
  if (actual.rows === expected.rows && actual.sha256 === expected.sha256) return "equal";
  fail("V12_TRANSFER_TARGET_NOT_EMPTY", { table: entry.target });
}

function insertSql(schema, entry, rowCount, { onConflict = null, columns = entry.columns } = {}) {
  const names = columns.map(value => `"${value.name}"`).join(", ");
  const groups = [];
  let parameter = 1;
  for (let row = 0; row < rowCount; row += 1) {
    groups.push(`(${columns.map(value => `$${parameter++}${parameterCast(value.type)}`).join(", ")})`);
  }
  return `INSERT INTO ${relation(schema, entry.target)} (${names}) VALUES ${groups.join(", ")}`
    + (onConflict === null ? "" : ` ${onConflict}`);
}

function rowParameters(columns, rows, override = {}) {
  return rows.flatMap(row => columns.map(value =>
    Object.hasOwn(override, value.name) ? override[value.name] : row[value.name]));
}

function insertBatchSize(entry, pageSize) {
  return Math.max(1, Math.min(pageSize, Math.floor(MAX_PG_PARAMETERS / entry.columns.length)));
}

async function insertRows(client, schema, entry, rows, pageSize, override = {}) {
  const batch = insertBatchSize(entry, pageSize);
  for (let offset = 0; offset < rows.length; offset += batch) {
    const slice = rows.slice(offset, offset + batch);
    const result = await client.query(insertSql(schema, entry, slice.length),
      rowParameters(entry.columns, slice, override));
    if (result.rowCount !== slice.length) fail("V12_TRANSFER_DESTINATION_WRITE_FAILED", { table: entry.target });
  }
}

async function copyTable(client, schema, entry, source, pageSize, transform = null) {
  let rows = 0;
  for (const page of sourcePages(source, entry, pageSize)) {
    if (transform === null) await insertRows(client, schema, entry, page, pageSize);
    else await transform(page);
    rows += page.length;
  }
  return rows;
}

/** Insert missing source-key rows and require present ones to be identical. */
async function copySourceKeys(client, schema, entry, source, pageSize) {
  let inserted = 0;
  let verified = 0;
  const key = entry.primaryKey[0];
  const keyType = entry.columns.find(value => value.name === key).type;
  for (const page of sourcePages(source, entry, pageSize)) {
    const existing = await client.query(`SELECT ${entry.columns.map(targetExpression).join(", ")}
      FROM ${relation(schema, entry.target)} ${TARGET_ROW}
     WHERE ${TARGET_ROW}."${key}" = ANY($1${keyType === "i64" ? "::bigint[]" : "::text[]"})`,
    [page.map(row => row[key])]);
    const present = new Map(existing.rows.map(raw => {
      const row = normalizeRow(entry, raw);
      return [String(row[key]), row];
    }));
    const missing = [];
    for (const row of page) {
      const current = present.get(String(row[key]));
      if (current === undefined) missing.push(row);
      else if (!sameRow(entry, current, row)) fail("V12_TRANSFER_TARGET_DEPENDENCY_CONFLICT", { table: entry.target });
      else verified += 1;
    }
    if (missing.length > 0) await insertRows(client, schema, entry, missing, pageSize);
    inserted += missing.length;
  }
  return Object.freeze({ inserted, verified });
}

async function setTrigger(client, schema, { table, trigger }, enabled) {
  await client.query(`ALTER TABLE ${relation(schema, table)} ${enabled ? "ENABLE" : "DISABLE"} TRIGGER "${trigger}"`);
}

async function advanceIdentity(client, schema, table) {
  const result = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS sequence,
      COALESCE((SELECT max(id) FROM ${relation(schema, table)}), 0)::text AS maximum`, [`"${schema}"."${table}"`]);
  const sequence = result.rows[0]?.sequence;
  const maximum = BigInt(result.rows[0]?.maximum ?? "0");
  if (!sequence) fail("V12_TRANSFER_IDENTITY_SEQUENCE_INVALID", { table });
  if (maximum < 1n) return;
  const match = /^"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?$/u.exec(sequence);
  if (!match || match[1] !== schema) fail("V12_TRANSFER_IDENTITY_SEQUENCE_INVALID", { table });
  const current = await client.query(`SELECT last_value::text AS last_value, is_called FROM "${match[1]}"."${match[2]}"`);
  const last = BigInt(current.rows[0]?.last_value ?? "0");
  if (maximum > last || (maximum === last && current.rows[0]?.is_called !== true)) {
    await client.query("SELECT setval($1::regclass, $2::bigint, true)", [sequence, maximum.toString()]);
  }
}

async function importAuthority(client, schema, source, pageSize, states) {
  for (const entry of TABLES.filter(value => value.family === "authority")) {
    if (states[entry.name] === "equal") continue;
    if (entry.singleton) {
      const row = [...sourcePages(source, entry, pageSize)][0][0];
      const assignments = entry.columns.filter(value => value.name !== "id")
        .map((value, index) => `"${value.name}" = $${index + 2}${parameterCast(value.type)}`);
      const values = entry.columns.filter(value => value.name !== "id").map(value => row[value.name]);
      const result = await client.query(`UPDATE ${relation(schema, entry.target)} SET ${assignments.join(", ")}
        WHERE "id" = $1`, [row.id, ...values]);
      if (result.rowCount !== 1) fail("V12_TRANSFER_DESTINATION_WRITE_FAILED", { table: entry.target });
    } else {
      await copyTable(client, schema, entry, source, pageSize);
    }
  }
}

async function importSource(client, schema, source, pageSize) {
  const counts = Object.create(null);
  await setTrigger(client, schema, RECORD_ADMISSION_TRIGGER, false);
  counts.typed_telemetry_dictionary = await copySourceKeys(client, schema,
    TABLE_BY_NAME.get("typed_telemetry_dictionary"), source, pageSize);
  const authorizations = TABLE_BY_NAME.get("device_upload_authorizations");
  for (const page of sourcePages(source, authorizations, pageSize)) {
    for (const row of page) {
      // A chunk names exactly one consumed authorization that names it back.
      if (row.state !== "consumed" || row.consumed_contribution_id === null) {
        fail("V12_TRANSFER_SOURCE_AUTHORIZATION_INVALID");
      }
    }
  }
  counts.device_upload_authorizations = await copySourceKeys(client, schema, authorizations, source, pageSize);

  // Manifests are written staged; ready ones are promoted after their rows.
  const manifests = TABLE_BY_NAME.get("telemetry_v12_day_manifests");
  const ready = [];
  counts.telemetry_v12_day_manifests = await copyTable(client, schema, manifests, source, pageSize, async page => {
    for (const row of page) {
      if (row.state === "ready") {
        if (row.ready_at === null) fail("V12_TRANSFER_SOURCE_ROW_INVALID", { table: manifests.name });
        ready.push([row.id, row.ready_at]);
      } else if (row.state !== "staged" || row.ready_at !== null) {
        fail("V12_TRANSFER_SOURCE_ROW_INVALID", { table: manifests.name });
      }
    }
    await insertRows(client, schema, manifests, page, pageSize, { state: "staged", ready_at: null });
  });

  // The reconciliation guard admits a chunk only against its registered object;
  // once the chunk references it the registration is cleared, as the reconciler
  // does ("referenced"), so no pending row survives the import.
  const chunks = TABLE_BY_NAME.get("telemetry_v12_chunks");
  counts.telemetry_v12_chunks = await copyTable(client, schema, chunks, source, pageSize, async page => {
    const ids = page.map(row => row.id);
    const keys = page.map(row => row.r2_key);
    const registered = await client.query(`INSERT INTO ${relation(schema, "pending_objects")}
        (contribution_id, object_key, object_kind)
      SELECT id, key, 'telemetry_v12' FROM unnest($1::text[], $2::text[]) AS item(id, key)
      RETURNING contribution_id, registration_token`, [ids, keys]);
    if (registered.rowCount !== page.length) fail("V12_TRANSFER_DESTINATION_WRITE_FAILED", { table: "pending_objects" });
    await insertRows(client, schema, chunks, page, pageSize);
    const cleared = await client.query(`DELETE FROM ${relation(schema, "pending_objects")} pending
       USING unnest($1::text[], $2::text[], $3::text[]) AS item(id, key, token)
      WHERE pending.contribution_id = item.id AND pending.object_key = item.key
        AND pending.registration_token = item.token AND pending.reconciliation_state = 'registered'`,
    [registered.rows.map(row => row.contribution_id),
      registered.rows.map(row => keys[ids.indexOf(row.contribution_id)]),
      registered.rows.map(row => row.registration_token)]);
    if (cleared.rowCount !== page.length) fail("V12_TRANSFER_DESTINATION_WRITE_FAILED", { table: "pending_objects" });
  });

  for (const name of ["telemetry_v12_attributions", "telemetry_v12_records", "telemetry_v12_usage",
    "telemetry_v12_quota", "telemetry_v12_session_tools"]) {
    counts[name] = await copyTable(client, schema, TABLE_BY_NAME.get(name), source, pageSize);
  }

  // What the disabled admission trigger would have proved, minus the live
  // grant: same manifest and stream as the chunk, the instant's UTC day, and
  // never more records than the chunk declares.
  const admission = await client.query(`SELECT
      (SELECT count(*)::integer FROM ${relation(schema, "telemetry_v12_typed_records")} record
         JOIN ${relation(schema, "telemetry_v12_chunks")} chunk ON chunk.id = record.chunk_id
        WHERE chunk.manifest_id <> record.manifest_id OR chunk.stream <> record.stream
           OR record.observed_day <> floor(record.observed_at_ms / 86400000.0)::integer
           OR record.observed_day <> (chunk.chunk_day - DATE '1970-01-01')) AS mismatched,
      (SELECT count(*)::integer FROM ${relation(schema, "telemetry_v12_chunks")} chunk
        WHERE (SELECT count(*) FROM ${relation(schema, "telemetry_v12_typed_records")} record
                WHERE record.chunk_id = chunk.id) > chunk.record_count) AS overfull`);
  if (admission.rows[0]?.mismatched !== 0 || admission.rows[0]?.overfull !== 0) {
    fail("V12_TRANSFER_SOURCE_RECORD_ADMISSION_INVALID");
  }

  // Promote ready manifests; the ready-day integrity and retention guards run.
  for (let offset = 0; offset < ready.length; offset += pageSize) {
    const slice = ready.slice(offset, offset + pageSize);
    const promoted = await client.query(`UPDATE ${relation(schema, "telemetry_v12_day_manifests")} manifest
        SET state = 'ready', ready_at = item.ready_at
       FROM unnest($1::text[], $2::timestamptz[]) AS item(id, ready_at)
      WHERE manifest.id = item.id AND manifest.state = 'staged'`,
    [slice.map(item => item[0]), slice.map(item => item[1])]);
    if (promoted.rowCount !== slice.length) fail("V12_TRANSFER_DESTINATION_WRITE_FAILED", { table: manifests.target });
  }
  await setTrigger(client, schema, RECORD_ADMISSION_TRIGGER, true);
  for (const table of ["typed_telemetry_dictionary", "telemetry_v12_typed_attributions", "telemetry_v12_typed_records"]) {
    await advanceIdentity(client, schema, table);
  }
  counts.readyManifestsPromoted = ready.length;
  return Object.freeze(counts);
}

/** Oldest generation first; a generation's predecessor must precede it. */
function orderedGenerations(source, pageSize) {
  const domains = TABLE_BY_NAME.get("telemetry_v12_domains");
  const rows = [];
  for (const page of sourcePages(source, domains, pageSize)) rows.push(...page);
  rows.sort((left, right) => left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1
    : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const ids = new Set(rows.map(row => row.id));
  const seen = new Set();
  for (const row of rows) {
    if (row.previous_generation_id !== null && ids.has(row.previous_generation_id)
        && !seen.has(row.previous_generation_id)) fail("V12_TRANSFER_SOURCE_GENERATION_ORDER_INVALID");
    seen.add(row.id);
  }
  return rows;
}

async function importDomain(client, schema, source, pageSize) {
  const counts = Object.create(null);
  await setTrigger(client, schema, HEAD_PUBLICATION_TRIGGER, false);
  counts.telemetry_v12_domain_predecessors = await copyTable(client, schema,
    TABLE_BY_NAME.get("telemetry_v12_domain_predecessors"), source, pageSize);
  const domains = TABLE_BY_NAME.get("telemetry_v12_domains");
  const days = TABLE_BY_NAME.get("telemetry_v12_domain_days");
  const daySql = `${sourceSelect(days)} WHERE "generation_id" = ? ORDER BY "observed_day"`;
  counts.telemetry_v12_domains = 0;
  counts.telemetry_v12_domain_days = 0;
  // Each generation's days go in before any successor or head names it: the
  // day guard treats an older generation with a successor as immutable.
  for (const generation of orderedGenerations(source, pageSize)) {
    await insertRows(client, schema, domains, [generation], pageSize);
    const rows = source.all(daySql, generation.id).map(raw => normalizeRow(days, raw));
    if (rows.length > 0) await insertRows(client, schema, days, rows, pageSize);
    counts.telemetry_v12_domains += 1;
    counts.telemetry_v12_domain_days += rows.length;
  }
  counts.telemetry_v12_domain_heads = await copyTable(client, schema,
    TABLE_BY_NAME.get("telemetry_v12_domain_heads"), source, pageSize);
  await setTrigger(client, schema, HEAD_PUBLICATION_TRIGGER, true);
  return Object.freeze(counts);
}

// ---------------------------------------------------------------------------
// Control

async function ensureControl(pool, controlSchema) {
  await withTransaction(pool, async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS ${relation(controlSchema, POSTGRES_V12_TRANSFER_RUN_TABLE)} (
      transfer_id text PRIMARY KEY CHECK (length(transfer_id) BETWEEN 1 AND 128),
      schema_version text NOT NULL CHECK (schema_version = '${POSTGRES_V12_TRANSFER_SCHEMA}'),
      target_schema text NOT NULL,
      source_snapshot_id text NOT NULL,
      source_artifact_sha256 text NOT NULL CHECK (source_artifact_sha256 ~ '^[0-9a-f]{64}$'),
      source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      status text NOT NULL CHECK (status IN ('running', 'complete')),
      families jsonb NOT NULL DEFAULT '{}'::jsonb,
      target_manifest_sha256 text CHECK (target_manifest_sha256 IS NULL OR target_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      effective_sha256 text CHECK (effective_sha256 IS NULL OR effective_sha256 ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz
    )`);
  });
}

async function openRun(pool, controlSchema, run) {
  return withTransaction(pool, async client => {
    const table = relation(controlSchema, POSTGRES_V12_TRANSFER_RUN_TABLE);
    const existing = await client.query(`SELECT target_schema, source_snapshot_id, source_artifact_sha256,
        source_manifest_sha256, status FROM ${table} WHERE transfer_id = $1 FOR UPDATE`, [run.transferId]);
    if (existing.rowCount === 0) {
      await client.query(`INSERT INTO ${table} (transfer_id, schema_version, target_schema, source_snapshot_id,
          source_artifact_sha256, source_manifest_sha256, status) VALUES ($1,$2,$3,$4,$5,$6,'running')`,
      [run.transferId, POSTGRES_V12_TRANSFER_SCHEMA, run.targetSchema, run.snapshotId,
        run.artifactSha256, run.sourceManifestSha256]);
      return "created";
    }
    const row = existing.rows[0];
    if (row.target_schema !== run.targetSchema || row.source_snapshot_id !== run.snapshotId
        || row.source_artifact_sha256 !== run.artifactSha256
        || row.source_manifest_sha256 !== run.sourceManifestSha256) fail("V12_TRANSFER_ID_REUSED");
    return row.status === "complete" ? "complete" : "resumed";
  });
}

async function recordFamily(client, controlSchema, transferId, family, action) {
  await client.query(`UPDATE ${relation(controlSchema, POSTGRES_V12_TRANSFER_RUN_TABLE)}
      SET families = families || jsonb_build_object($2::text, $3::text), updated_at = clock_timestamp()
    WHERE transfer_id = $1`, [transferId, family, action]);
}

async function acquireLock(pool, key) {
  const client = await pool.connect();
  try {
    const locked = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]);
    if (locked.rows[0]?.locked !== true) fail("V12_TRANSFER_BUSY");
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseLock(client, key) {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Effective-reader verification

const RETAINED_SCOPE = `
  SELECT authorization.participant_id, authorization.device_id
    FROM telemetry_v12_active_authorizations authorization
    JOIN storage_v11_owner_links owner_link ON owner_link.participant_id = authorization.participant_id
     AND owner_link.state = 'active'
  UNION
  SELECT capability.participant_id, capability.device_id
    FROM telemetry_v12_device_capabilities capability
    JOIN participants participant ON participant.id = capability.participant_id AND participant.state = 'active'
    JOIN storage_v11_owner_links owner_link ON owner_link.participant_id = capability.participant_id
     AND owner_link.state = 'active'
   WHERE capability.state IN ('accepted', 'revoked')
     AND capability.telemetry_schema_version = 'telemetry-contribution-v1.2'
  UNION
  SELECT authorization.participant_id, authorization.device_credential_id
    FROM accountless_v12_device_authorizations authorization
    JOIN participants participant ON participant.id = authorization.participant_id AND participant.state = 'active'
    JOIN storage_v11_owner_links owner_link ON owner_link.participant_id = authorization.participant_id
     AND owner_link.state = 'active'
   WHERE (authorization.state = 'active'
      AND authorization.expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      OR (authorization.state = 'revoked' AND authorization.revocation_reason = 'user_opt_out')`;

/** The reader's own join over the source rows; `headOnly` selects its head scope. */
function expectedSql(headOnly) {
  return `SELECT domain_day.observed_day AS day, r.occurrence_id AS occurrence
    FROM telemetry_v12_domains generation
    ${headOnly ? `JOIN telemetry_v12_domain_heads head
      ON head.participant_id = generation.participant_id AND head.generation_id = generation.id` : ""}
    JOIN telemetry_v12_domain_days domain_day ON domain_day.generation_id = generation.id
    JOIN telemetry_v12_day_manifests manifest ON manifest.id = domain_day.manifest_id
     AND manifest.participant_id = generation.participant_id AND manifest.device_id = generation.device_id
     AND manifest.chunk_day = domain_day.observed_day AND manifest.manifest_digest = domain_day.manifest_digest
     AND manifest.state = 'ready'
    JOIN telemetry_v12_chunks chunk ON chunk.manifest_id = manifest.id
     AND chunk.participant_id = generation.participant_id AND chunk.device_id = generation.device_id
     AND chunk.chunk_day = manifest.chunk_day AND chunk.stream = ?
     AND chunk.record_count = (SELECT count(*) FROM telemetry_v12_records complete WHERE complete.chunk_id = chunk.id)
    JOIN telemetry_v12_records r ON r.chunk_id = chunk.id AND r.manifest_id = manifest.id AND r.stream = ?
    JOIN (${RETAINED_SCOPE}) authorization
      ON authorization.participant_id = generation.participant_id AND authorization.device_id = generation.device_id
   WHERE generation.participant_id = ?`;
}

function daySets(source, sql, stream, participantId, decode) {
  const result = new Map();
  for (const row of source.all(sql, stream, stream, participantId)) {
    const day = normalizeDay(row.day);
    const bytes = normalizeValue("bytes", row.occurrence);
    let id;
    try { id = decode(new Uint8Array(bytes)); } catch { fail("V12_TRANSFER_SOURCE_OCCURRENCE_INVALID"); }
    if (!result.has(day)) result.set(day, new Set());
    result.get(day).add(id);
  }
  return result;
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function participantKey(participantId) {
  return sha256().update(`v12-transfer-participant\u0000${participantId}`).digest("hex").slice(0, 16);
}

function validReader(reader) {
  return reader && typeof reader.readPostgresTelemetryV12EffectiveDays === "function"
    && typeof reader.readPostgresTelemetryV12EffectiveCandidatePage === "function"
    && typeof reader.readPostgresTelemetryV12EffectiveOccurrences === "function"
    && typeof reader.decodeTypedTelemetryId === "function";
}

async function verifyEffectiveReader({ source, pool, targetSchema, reader }) {
  const options = { schema: { primarySchema: targetSchema } };
  const participants = source.all("SELECT DISTINCT participant_id FROM telemetry_v12_domains ORDER BY 1")
    .map(row => row.participant_id);
  const headSql = expectedSql(true);
  const unionSql = expectedSql(false);
  const digest = sha256();
  const perParticipant = [];
  let dayStreams = 0;
  let occurrences = 0;
  let records = 0;
  let unionDivergent = 0;
  for (const participantId of participants) {
    const span = source.all(`SELECT min(domain_day.observed_day) AS first, max(domain_day.observed_day) AS last
      FROM telemetry_v12_domain_days domain_day JOIN telemetry_v12_domains generation
        ON generation.id = domain_day.generation_id WHERE generation.participant_id = ?`, participantId)[0];
    const summary = { participantKey: participantKey(participantId), days: new Set(), occurrences: 0, records: 0,
      dayStreams: 0, unionDivergentDayStreams: 0 };
    for (const stream of STREAMS) {
      const expected = daySets(source, headSql, stream, participantId, reader.decodeTypedTelemetryId);
      const union = daySets(source, unionSql, stream, participantId, reader.decodeTypedTelemetryId);
      for (const day of new Set([...expected.keys(), ...union.keys()])) {
        if (!sameSet(expected.get(day) ?? new Set(), union.get(day) ?? new Set())) {
          unionDivergent += 1;
          summary.unionDivergentDayStreams += 1;
        }
      }
      // Days: the reader's nonempty-day enumeration over the whole span.
      const readDays = new Set();
      if (span?.first !== null && span?.first !== undefined) {
        const first = normalizeDay(span.first);
        const last = normalizeDay(span.last);
        for (let from = first; from <= last; from = addDays(from, READER_DAYS_WINDOW)) {
          const through = addDays(from, READER_DAYS_WINDOW - 1) < last ? addDays(from, READER_DAYS_WINDOW - 1) : last;
          const days = await reader.readPostgresTelemetryV12EffectiveDays(pool,
            { participantId, fromDay: from, throughDay: through, stream }, options);
          for (const day of days) readDays.add(day);
        }
      }
      if (!sameSet(readDays, new Set(expected.keys()))) fail("V12_TRANSFER_EFFECTIVE_DAYS_MISMATCH");
      for (const day of [...expected.keys()].sort()) {
        const want = expected.get(day);
        const candidates = new Set();
        let after;
        for (;;) {
          const page = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool,
            { participantId, day, stream, ...(after === undefined ? {} : { after }), limit: 200 }, options);
          if (page.available !== true) fail("V12_TRANSFER_EFFECTIVE_READER_UNAVAILABLE");
          for (const candidate of page.records) candidates.add(candidate.occurrenceId);
          if (page.next === null) break;
          after = page.next;
        }
        if (!sameSet(candidates, want)) fail("V12_TRANSFER_EFFECTIVE_OCCURRENCES_MISMATCH");
        const ids = [...want].sort();
        const returned = new Set();
        for (let offset = 0; offset < ids.length; offset += READER_OCCURRENCE_BATCH) {
          const batch = ids.slice(offset, offset + READER_OCCURRENCE_BATCH);
          const read = await reader.readPostgresTelemetryV12EffectiveOccurrences(pool,
            { participantId, stream, occurrenceIds: batch }, options);
          if (read.available !== true) fail("V12_TRANSFER_EFFECTIVE_READER_UNAVAILABLE");
          const requested = new Set(batch);
          for (const record of read.records) {
            if (!requested.has(record.occurrenceId) || record.observedAt.slice(0, 10) !== day) {
              fail("V12_TRANSFER_EFFECTIVE_OCCURRENCES_MISMATCH");
            }
            returned.add(record.occurrenceId);
          }
          records += read.records.length;
          summary.records += read.records.length;
        }
        if (!sameSet(returned, want)) fail("V12_TRANSFER_EFFECTIVE_OCCURRENCES_MISMATCH");
        digest.update(`${JSON.stringify([participantKey(participantId), stream, day, ids])}\n`);
        dayStreams += 1;
        occurrences += ids.length;
        summary.dayStreams += 1;
        summary.occurrences += ids.length;
        summary.days.add(day);
      }
    }
    perParticipant.push(Object.freeze({ ...summary, days: summary.days.size }));
  }
  return Object.freeze({
    verified: true,
    reader: "readPostgresTelemetryV12EffectiveOccurrences",
    scope: "current-head generation, ready manifest, complete chunk, retained authorization",
    participants: participants.length,
    dayStreams,
    occurrenceIds: occurrences,
    records,
    unionDivergentDayStreams: unionDivergent,
    sha256: digest.digest("hex"),
    perParticipant: Object.freeze(perParticipant),
  });
}

// ---------------------------------------------------------------------------
// Run

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_V12_TRANSFER_MAX_PAGE_SIZE) {
    fail("V12_TRANSFER_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

/**
 * Import the sealed source's v1.2 family into `targetSchema`, verify counts and
 * canonical per-table SHA-256 against the source, then verify the effective
 * reader. A rerun with the same transfer id and source resumes: a family whose
 * tables already hold exactly the source rows is verified and skipped. Any
 * other non-empty v1.2 table refuses the transfer before a write.
 */
export async function runPostgresV12Transfer({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  controlSchema: rawControlSchema,
  transferId,
  pageSize = POSTGRES_V12_TRANSFER_DEFAULT_PAGE_SIZE,
  effectiveReader = null,
} = {}) {
  const targetSchema = schemaName(rawTargetSchema, "V12_TRANSFER_TARGET_SCHEMA_REQUIRED");
  if (!targetSchema.startsWith(POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX)
      || targetSchema.length - POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX.length < 8) {
    fail("V12_TRANSFER_TARGET_SCHEMA_REQUIRED");
  }
  const controlSchema = schemaName(rawControlSchema, "V12_TRANSFER_CONTROL_SCHEMA_REQUIRED");
  if (controlSchema === targetSchema || !controlSchema.startsWith(POSTGRES_V12_TRANSFER_CONTROL_SCHEMA_PREFIX)
      || controlSchema.startsWith(POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX)
      || controlSchema.length - POSTGRES_V12_TRANSFER_CONTROL_SCHEMA_PREFIX.length < 8) {
    fail("V12_TRANSFER_CONTROL_SCHEMA_REQUIRED");
  }
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("V12_TRANSFER_ID_INVALID");
  const size = validatePageSize(pageSize);
  if (effectiveReader !== null && !validReader(effectiveReader)) fail("V12_TRANSFER_EFFECTIVE_READER_INVALID");
  const snapshot = trustedSource(source);
  await assertSnapshot(source, snapshot);
  const target = await assertTarget(destinationPool, targetSchema);
  const sourceManifest = scanSource(source, size);
  await assertSnapshot(source, snapshot);

  const lockKey = `tibotattle:v12-transfer:${targetSchema}`;
  const lock = await acquireLock(destinationPool, lockKey);
  try {
    await ensureControl(destinationPool, controlSchema).catch(error => rethrow(error, "V12_TRANSFER_CONTROL_UNAVAILABLE"));
    const run = await openRun(destinationPool, controlSchema, {
      transferId, targetSchema, snapshotId: snapshot.snapshotId, artifactSha256: snapshot.artifactSha256,
      sourceManifestSha256: sourceManifest.sha256,
    }).catch(error => rethrow(error, "V12_TRANSFER_CONTROL_UNAVAILABLE"));

    // Preflight before any write: trigger contract, identity, empty legacy
    // raw table, and the state of every owned table.
    const preflight = await withTransaction(destinationPool, async client => {
      const triggers = await assertTriggersEnabled(client, targetSchema);
      const identity = await assertIdentityPresent(source, client, targetSchema);
      const legacy = await client.query(`SELECT count(*)::integer AS count FROM ${relation(targetSchema, "telemetry_v12_records")}`);
      if (legacy.rows[0]?.count !== 0) fail("V12_TRANSFER_TARGET_NOT_EMPTY", { table: "telemetry_v12_records" });
      const states = Object.create(null);
      for (const entry of TABLES) {
        if (entry.scope !== "all-rows") continue;
        states[entry.name] = await classifyTable(client, targetSchema, entry, sourceManifest, source, size);
      }
      return { triggers, identity, states };
    }, { isolation: "REPEATABLE READ", readOnly: true }).catch(error => rethrow(error, "V12_TRANSFER_PREFLIGHT_FAILED"));

    const families = [];
    for (const family of FAMILIES) {
      const owned = TABLES.filter(entry => entry.family === family && entry.scope === "all-rows");
      const states = owned.map(entry => preflight.states[entry.name]);
      let action;
      if (states.every(state => state === "equal")) {
        action = "verified-existing";
      } else if (family !== "authority" && !states.every(state => state === "pristine")) {
        // Source and domain families are written atomically: a mix can only
        // come from another writer.
        fail("V12_TRANSFER_TARGET_NOT_EMPTY", { family });
      } else {
        action = "imported";
      }
      let counts = null;
      await withTransaction(destinationPool, async client => {
        if (action === "imported") {
          if (family === "authority") await importAuthority(client, targetSchema, source, size, preflight.states);
          else if (family === "source") counts = await importSource(client, targetSchema, source, size);
          else counts = await importDomain(client, targetSchema, source, size);
        }
        await recordFamily(client, controlSchema, transferId, family, action);
      }).catch(error => rethrow(error, `V12_TRANSFER_${family.toUpperCase()}_FAMILY_FAILED`));
      families.push(Object.freeze({ family, action, ...(counts === null ? {} : { counts }) }));
      await assertSnapshot(source, snapshot);
    }

    // Final audit over one stable snapshot.
    const audit = await withTransaction(destinationPool, async client => {
      await assertTriggersEnabled(client, targetSchema);
      const tables = Object.create(null);
      for (const entry of TABLES) {
        tables[entry.name] = entry.singleton
          ? await (async () => {
            const row = await targetSingleton(client, targetSchema, entry);
            return Object.freeze({ scope: entry.scope, rows: 1,
              sha256: sha256().update(canonicalLine(entry, row)).digest("hex") });
          })()
          : await scanTarget(client, targetSchema, entry, size,
            entry.scope === "source-keys" ? sourceKeys(source, entry, size) : null);
      }
      const extras = await client.query(`SELECT
          (SELECT count(*)::integer FROM ${relation(targetSchema, "telemetry_v12_chunks")}
            WHERE quarantine_deleted_at IS NOT NULL) AS quarantined,
          (SELECT count(*)::integer FROM ${relation(targetSchema, "telemetry_v12_domain_predecessors")}
            WHERE winners_json IS NOT NULL) AS winners,
          (SELECT count(*)::integer FROM ${relation(targetSchema, "telemetry_v12_records")}) AS legacy,
          (SELECT count(*)::integer FROM ${relation(targetSchema, "pending_objects")} pending
             JOIN ${relation(targetSchema, "telemetry_v12_chunks")} chunk ON chunk.id = pending.contribution_id) AS pending`);
      const row = extras.rows[0];
      if (row?.quarantined !== 0 || row?.winners !== 0 || row?.legacy !== 0 || row?.pending !== 0) {
        fail("V12_TRANSFER_TARGET_EXTRA_STATE");
      }
      return Object.freeze({ tables: Object.freeze(tables), sha256: manifestSha256(tables) });
    }, { isolation: "REPEATABLE READ", readOnly: true }).catch(error => rethrow(error, "V12_TRANSFER_AUDIT_FAILED"));
    for (const entry of TABLES) {
      const expected = sourceManifest.tables[entry.name];
      const actual = audit.tables[entry.name];
      if (expected.rows !== actual.rows || expected.sha256 !== actual.sha256) {
        fail("V12_TRANSFER_SOURCE_DESTINATION_PARITY_FAILED", { table: entry.name });
      }
    }
    await assertSnapshot(source, snapshot);

    const effective = effectiveReader === null
      ? Object.freeze({ verified: false, reason: "reader-not-supplied" })
      : await verifyEffectiveReader({ source, pool: destinationPool, targetSchema, reader: effectiveReader })
        .catch(error => rethrow(error, "V12_TRANSFER_EFFECTIVE_VERIFICATION_FAILED"));
    await assertSnapshot(source, snapshot);

    await withTransaction(destinationPool, async client => {
      await client.query(`UPDATE ${relation(controlSchema, POSTGRES_V12_TRANSFER_RUN_TABLE)}
          SET status = CASE WHEN $4::boolean THEN 'complete' ELSE status END,
              target_manifest_sha256 = $2, effective_sha256 = $3,
              updated_at = clock_timestamp(),
              completed_at = CASE WHEN $4::boolean THEN COALESCE(completed_at, clock_timestamp()) ELSE completed_at END
        WHERE transfer_id = $1`,
      [transferId, audit.sha256, effective.verified ? effective.sha256 : null, effective.verified === true]);
    }).catch(error => rethrow(error, "V12_TRANSFER_CONTROL_UNAVAILABLE"));

    return Object.freeze({
      schema: POSTGRES_V12_TRANSFER_SCHEMA,
      status: effective.verified ? "staged_rehearsal_complete" : "staged_rehearsal_unverified_reader",
      transferId,
      run,
      source: Object.freeze({
        kind: snapshot.kind, snapshotId: snapshot.snapshotId, artifactSha256: snapshot.artifactSha256,
        manifestSha256: sourceManifest.sha256, tables: sourceManifest.tables,
      }),
      destination: Object.freeze({
        schema: targetSchema, postgresMajor: target.postgresMajor, migrationVersion: target.migrationVersion,
        manifestSha256: audit.sha256, tables: audit.tables,
      }),
      preflight: Object.freeze({ triggersChecked: preflight.triggers, identity: preflight.identity }),
      families: Object.freeze(families),
      suspendedTriggers: Object.freeze([RECORD_ADMISSION_TRIGGER.trigger, HEAD_PUBLICATION_TRIGGER.trigger]),
      effective,
      capabilities: Object.freeze({
        productionTargetMode: false,
        ownerJournalImported: false,
        storageV12EventSourcesImported: false,
        productionCutoverAuthorized: false,
      }),
    });
  } finally {
    await releaseLock(lock, lockKey);
  }
}

// ---------------------------------------------------------------------------
// CLI (local only)

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load the PostgreSQL v1.2 effective reader and the typed-id codec from this
 * checkout's TypeScript sources through Vite. Local tooling only.
 */
export async function loadPostgresV12EffectiveReader({ workerRoot = WORKER_ROOT } = {}) {
  const { createServer } = await import("vite");
  const server = await createServer({
    root: workerRoot, configFile: false, logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true },
  });
  try {
    const reader = await server.ssrLoadModule("/src/postgres-typed-v12-effective-reader.ts");
    const codec = await server.ssrLoadModule("/src/typed-telemetry-codec.ts");
    return Object.freeze({
      readPostgresTelemetryV12EffectiveDays: reader.readPostgresTelemetryV12EffectiveDays,
      readPostgresTelemetryV12EffectiveCandidatePage: reader.readPostgresTelemetryV12EffectiveCandidatePage,
      readPostgresTelemetryV12EffectiveOccurrences: reader.readPostgresTelemetryV12EffectiveOccurrences,
      decodeTypedTelemetryId: codec.decodeTypedTelemetryId,
      close: () => server.close(),
    });
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

const CLI_OPTIONS = Object.freeze(["source", "source-sha256", "target-schema", "control-schema", "transfer-id",
  "page-size"]);

function cliArguments(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    const key = typeof name === "string" && name.startsWith("--") ? name.slice(2) : null;
    if (key === null || !CLI_OPTIONS.includes(key) || Object.hasOwn(values, key)
        || typeof value !== "string" || value.startsWith("--")) fail("V12_TRANSFER_CLI_USAGE");
    values[key] = value;
  }
  for (const required of ["source", "source-sha256", "target-schema", "control-schema", "transfer-id"]) {
    if (typeof values[required] !== "string") fail("V12_TRANSFER_CLI_USAGE");
  }
  return values;
}

async function main(argv) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) fail("V12_TRANSFER_NODE_TOO_OLD");
  const values = cliArguments(argv);
  const { default: pg } = await import("pg");
  // Connection settings come from the standard PG* environment variables.
  const pool = new pg.Pool({ max: 4, connectionTimeoutMillis: 5_000 });
  const source = await createSealedSqliteV12RehearsalSource({
    path: values.source, expectedSha256: values["source-sha256"],
  });
  const reader = await loadPostgresV12EffectiveReader();
  try {
    const result = await runPostgresV12Transfer({
      source, destinationPool: pool, targetSchema: values["target-schema"],
      controlSchema: values["control-schema"], transferId: values["transfer-id"],
      pageSize: values["page-size"] === undefined ? POSTGRES_V12_TRANSFER_DEFAULT_PAGE_SIZE : Number(values["page-size"]),
      effectiveReader: reader,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    source.close();
    await reader.close();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const code = error instanceof PostgresV12TransferError ? error.code : "V12_TRANSFER_FAILED";
    process.stderr.write(`${JSON.stringify({ error: code, ...(error?.detail ? { detail: error.detail } : {}) })}\n`);
    process.exitCode = 1;
  });
}
