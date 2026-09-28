import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";

export const POSTGRES_IDENTITY_AUTHORITY_TRANSFER_SCHEMA = "postgres-identity-authority-transfer-rehearsal-v1";
export const POSTGRES_IDENTITY_AUTHORITY_SOURCE_BINDING = "USAGE_MONITOR_DB";
export const POSTGRES_IDENTITY_AUTHORITY_TARGET_SCHEMA_PREFIX = "identity_authority_transfer_target_";
export const POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX = "identity_authority_transfer_control_";
export const POSTGRES_IDENTITY_AUTHORITY_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_IDENTITY_AUTHORITY_MAX_PAGE_SIZE = 250;
export const POSTGRES_IDENTITY_AUTHORITY_RUN_TABLE = "_identity_authority_transfer_runs_v1";
export const POSTGRES_IDENTITY_AUTHORITY_CHECKPOINT_TABLE = "_identity_authority_transfer_checkpoints_v1";
const PRIMARY_MIGRATION_HISTORY_TABLE = "_tibotattle_migration_history";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_SEALED_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const KNOWN_PRIMARY_MIGRATION_COUNT = 46;
const PAIRING_CONSENT_VERSIONS = new Set([
  "ongoing-privacy-safe-telemetry-v0.1",
  "ongoing-privacy-safe-telemetry-v1.0",
]);
const TRANSPORT_CONSENT_VERSIONS = new Set([
  "ongoing-privacy-safe-telemetry-v0.1",
  "ongoing-privacy-safe-telemetry-v0.2",
  "ongoing-privacy-safe-telemetry-v1.0",
]);
const encoder = new TextEncoder();
const TRUSTED_SOURCES = new WeakSet();

function field(name, kind, nullable = false) {
  return Object.freeze({ name, kind, nullable });
}

function table(name, fields, primaryKey, { sourceFields = fields, sourcePrimaryKey = primaryKey, projectSourceRow = null } = {}) {
  const names = fields.map(value => value.name);
  const sourceNames = sourceFields.map(value => value.name);
  if (!IDENTIFIER.test(name) || names.length === 0 || new Set(names).size !== names.length
      || sourceNames.length === 0 || new Set(sourceNames).size !== sourceNames.length
      || primaryKey.length !== 1 || !names.includes(primaryKey[0])
      || sourcePrimaryKey.length !== 1 || !sourceNames.includes(sourcePrimaryKey[0])
      || (projectSourceRow !== null && typeof projectSourceRow !== "function")) {
    throw new TypeError("identity authority table contract invalid");
  }
  return Object.freeze({
    name,
    fields: Object.freeze(fields),
    columns: Object.freeze(names),
    primaryKey: Object.freeze(primaryKey),
    sourceFields: Object.freeze(sourceFields),
    sourceColumns: Object.freeze(sourceNames),
    sourcePrimaryKey: Object.freeze(sourcePrimaryKey),
    projectSourceRow,
  });
}

// This is the bounded social identity/device family in USAGE_MONITOR_DB. The
// accountless graph has a separate issuance counter and is refused below until
// its replace/rollback contract is implemented. Analytics owner links and
// journal-derived revision heads are deliberately outside this family.
const TABLES = Object.freeze([
  table("participants", [
    field("id", "text"), field("owner_kind", "text"), field("access_token_id", "text", true),
    field("access_token_hash", "bytes", true), field("recovery_token_id", "text", true),
    field("recovery_token_hash", "bytes", true), field("state", "text"),
    field("consent_version", "text", true), field("consented_at", "timestamp", true),
    field("created_at", "timestamp"), field("deletion_session_id", "text", true),
    field("identity_link_key", "text", true), field("identity_cooldown_digest", "text", true),
  ], ["id"]),
  table("identity_reenrollment_cooldowns", [
    field("identity_cooldown_digest", "text"), field("participant_id", "text", true),
    field("created_at", "timestamp"), field("expires_at", "timestamp"),
  ], ["identity_cooldown_digest"], {
    sourceFields: [
      field("identity_cooldown_digest", "text"), field("schema_version", "text"),
      field("deleted_at", "timestamp"), field("retain_until", "timestamp"),
    ],
    sourcePrimaryKey: ["identity_cooldown_digest"],
    projectSourceRow(sourceRow) {
      if (sourceRow.schema_version !== "identity-reenrollment-cooldown-v0.1") {
        fail("IDENTITY_TRANSFER_SOURCE_AUTHORITY_INVALID");
      }
      // D1 intentionally omits participant identity from this marker. Keep the
      // target's optional association NULL and preserve the exact time instants.
      return {
        identity_cooldown_digest: sourceRow.identity_cooldown_digest,
        participant_id: null,
        created_at: sourceRow.deleted_at,
        expires_at: sourceRow.retain_until,
      };
    },
  }),
  table("enrollment_grants", [
    field("id", "text"), field("secret_hash", "bytes"), field("state", "text"),
    field("issued_at", "timestamp"), field("expires_at", "timestamp"),
    field("redeemed_at", "timestamp", true), field("redeemed_participant_id", "text", true),
  ], ["id"]),
  table("web_sessions", [
    field("id", "text"), field("participant_id", "text"), field("secret_hash", "bytes"),
    field("csrf_hash", "bytes"), field("scope", "text"), field("state", "text"),
    field("issued_at", "timestamp"), field("expires_at", "timestamp"),
    field("last_used_at", "timestamp"), field("revoked_at", "timestamp", true),
  ], ["id"]),
  table("participant_community_eligibility", [
    field("id", "text"), field("participant_id", "text"), field("grant_id", "text"),
    field("created_at", "timestamp"),
  ], ["id"]),
  table("device_pairings", [
    field("id", "text"), field("participant_id", "text"), field("issued_by_session_id", "text"),
    field("secret_hash", "bytes"), field("consent_version", "text"),
    field("transport_consent_version", "text"), field("state", "text"),
    field("issued_at", "timestamp"), field("expires_at", "timestamp"),
    field("consumed_at", "timestamp", true), field("revoked_at", "timestamp", true),
    field("claimed_device_id", "text", true),
  ], ["id"]),
  table("device_credentials", [
    field("id", "text"), field("participant_id", "text"), field("authority_kind", "text"),
    field("paired_via_pairing_id", "text", true), field("accountless_enrollment_device_id", "text", true),
    field("secret_hash", "bytes"), field("state", "text"), field("issued_at", "timestamp"),
    field("expires_at", "timestamp"), field("last_used_at", "timestamp"),
    field("revoked_at", "timestamp", true), field("social_verified_at", "timestamp", true),
    field("credential_generation", "i32"),
  ], ["id"]),
  table("upload_authorizations", [
    field("id", "text"), field("participant_id", "text"), field("issued_by_session_id", "text"),
    field("secret_hash", "bytes"), field("envelope_digest", "text"), field("body_bytes", "i32"),
    field("content_type", "text"), field("state", "text"), field("issued_at", "timestamp"),
    field("expires_at", "timestamp"), field("consumed_at", "timestamp", true),
    field("revoked_at", "timestamp", true), field("consume_lease_expires_at", "timestamp", true),
    field("consumed_contribution_id", "text", true),
  ], ["id"]),
  table("device_upload_authorizations", [
    field("id", "text"), field("participant_id", "text"), field("issued_by_device_id", "text"),
    field("secret_hash", "bytes"), field("envelope_digest", "text"), field("body_bytes", "i32"),
    field("content_type", "text"), field("state", "text"), field("issued_at", "timestamp"),
    field("expires_at", "timestamp"), field("consumed_at", "timestamp", true),
    field("revoked_at", "timestamp", true), field("consume_lease_expires_at", "timestamp", true),
    field("consumed_contribution_id", "text", true),
  ], ["id"]),
  table("recovery_retry_receipts", [
    field("old_recovery_token_id", "text"), field("old_recovery_token_hash", "bytes"),
    field("recovery_attempt_hash", "bytes"), field("participant_id", "text"),
    field("derivation_nonce", "text"), field("replacement_recovery_token_id", "text"),
    field("replacement_session_id", "text"), field("issued_at", "timestamp"),
    field("expires_at", "timestamp"), field("replay_count", "i32"),
  ], ["old_recovery_token_id"]),
  table("device_credential_rotations", [
    field("id", "text"), field("device_id", "text"), field("participant_id", "text"),
    field("prior_secret_hash", "bytes"), field("replacement_secret_hash", "bytes"),
    field("attempt_id", "text"), field("generation", "i32"), field("rotated_at", "timestamp"),
    field("retire_at", "timestamp"), field("recovery_proof_hash", "bytes", true),
  ], ["id"]),
  table("device_pairing_events", [
    field("id", "text"), field("pairing_id", "text"), field("participant_id", "text"),
    field("kind", "text"), field("occurred_at", "timestamp"),
  ], ["id"]),
]);
const TABLE_BY_NAME = new Map(TABLES.map(value => [value.name, value]));
const CONTROL_RUN_TABLE = POSTGRES_IDENTITY_AUTHORITY_RUN_TABLE;
const CONTROL_CHECKPOINT_TABLE = POSTGRES_IDENTITY_AUTHORITY_CHECKPOINT_TABLE;

// Copied from the D1 authority migrations. This closes the source-side
// dependency graph so an incomplete or cross-binding SQLite reconstruction
// fails before PostgreSQL receives any rows.
const SOURCE_FOREIGN_KEYS = Object.freeze({
  participants: [],
  identity_reenrollment_cooldowns: [],
  enrollment_grants: [
    { column: "redeemed_participant_id", table: "participants", referencedColumn: "id", onDelete: "SET NULL" },
  ],
  web_sessions: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
  ],
  participant_community_eligibility: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "grant_id", table: "enrollment_grants", referencedColumn: "id", onDelete: "NO ACTION" },
  ],
  device_pairings: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "issued_by_session_id", table: "web_sessions", referencedColumn: "id", onDelete: "CASCADE" },
  ],
  device_credentials: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "paired_via_pairing_id", table: "device_pairings", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "accountless_enrollment_device_id", table: "accountless_enrollment_ledger", referencedColumn: "device_id", onDelete: "RESTRICT" },
  ],
  upload_authorizations: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "issued_by_session_id", table: "web_sessions", referencedColumn: "id", onDelete: "CASCADE" },
  ],
  device_upload_authorizations: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "issued_by_device_id", table: "device_credentials", referencedColumn: "id", onDelete: "CASCADE" },
  ],
  recovery_retry_receipts: [
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "replacement_session_id", table: "web_sessions", referencedColumn: "id", onDelete: "CASCADE" },
  ],
  device_credential_rotations: [
    { column: "device_id", table: "device_credentials", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
  ],
  device_pairing_events: [
    { column: "pairing_id", table: "device_pairings", referencedColumn: "id", onDelete: "CASCADE" },
    { column: "participant_id", table: "participants", referencedColumn: "id", onDelete: "CASCADE" },
  ],
});

export class PostgresIdentityAuthorityTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresIdentityAuthorityTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresIdentityAuthorityTransferError(code);
}

function schemaName(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value === "information_schema"
      || value === "pg_catalog" || value.startsWith("pg_")) fail("IDENTITY_TRANSFER_SCHEMA_INVALID");
  return value;
}

function quoteIdentifier(value) {
  return `"${schemaName(value)}"`;
}

function quoteRelation(schema, name) {
  if (!TABLE_BY_NAME.has(name) && name !== CONTROL_RUN_TABLE && name !== CONTROL_CHECKPOINT_TABLE
      && name !== PRIMARY_MIGRATION_HISTORY_TABLE) {
    fail("IDENTITY_TRANSFER_TABLE_INVALID");
  }
  return `${quoteIdentifier(schema)}."${name}"`;
}

function validatePageSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > POSTGRES_IDENTITY_AUTHORITY_MAX_PAGE_SIZE) {
    fail("IDENTITY_TRANSFER_PAGE_SIZE_INVALID");
  }
  return value;
}

function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function pgType(kind) {
  if (kind === "bytes") return "bytea";
  if (kind === "timestamp") return "timestamp with time zone";
  if (kind === "i32") return "integer";
  return "text";
}

function sqliteType(kind) {
  if (kind === "bytes") return "BLOB";
  if (kind === "i32") return "INTEGER";
  return "TEXT";
}

function normalizeInteger(value) {
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) parsed = BigInt(value);
  else fail("IDENTITY_TRANSFER_VALUE_INVALID");
  if (parsed < -2_147_483_648n || parsed > 2_147_483_647n) fail("IDENTITY_TRANSFER_VALUE_INVALID");
  return Number(parsed);
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail("IDENTITY_TRANSFER_VALUE_INVALID");
    return value.toISOString();
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail("IDENTITY_TRANSFER_VALUE_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail("IDENTITY_TRANSFER_VALUE_INVALID");
  return value;
}

function normalizeValue(fieldValue, value) {
  if (value === null) {
    if (!fieldValue.nullable) fail("IDENTITY_TRANSFER_VALUE_INVALID");
    return null;
  }
  if (value === undefined) fail("IDENTITY_TRANSFER_VALUE_INVALID");
  if (fieldValue.kind === "text") {
    if (typeof value !== "string" || encoder.encode(value).byteLength > 4_096) fail("IDENTITY_TRANSFER_VALUE_INVALID");
    return value;
  }
  if (fieldValue.kind === "bytes") {
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer)) {
      fail("IDENTITY_TRANSFER_VALUE_INVALID");
    }
    const bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    if (bytes.byteLength > 4_096) fail("IDENTITY_TRANSFER_VALUE_INVALID");
    return bytes;
  }
  if (fieldValue.kind === "timestamp") return normalizeTimestamp(value);
  if (fieldValue.kind === "i32") return normalizeInteger(value);
  fail("IDENTITY_TRANSFER_COLUMN_TYPE_INVALID");
}

function normalizeRow(spec, row) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) fail("IDENTITY_TRANSFER_SOURCE_ROW_INVALID");
  const result = Object.create(null);
  for (const fieldValue of spec.fields) result[fieldValue.name] = normalizeValue(fieldValue, row[fieldValue.name]);
  return result;
}

function rowHash(hash, spec, row) {
  const values = spec.fields.map(fieldValue => {
    const value = row[fieldValue.name];
    return Buffer.isBuffer(value) ? { bytesHex: value.toString("hex") } : value;
  });
  hash.update(JSON.stringify(values));
  hash.update("\n");
}

function sameValue(fieldValue, left, right) {
  if (left === null || right === null) return left === right;
  if (fieldValue.kind === "bytes") return Buffer.compare(left, right) === 0;
  return left === right;
}

function sameRow(spec, left, right) {
  return spec.fields.every(fieldValue => sameValue(fieldValue, left[fieldValue.name], right[fieldValue.name]));
}

function digestObject(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cursorValue(spec, row) {
  const value = row[spec.sourcePrimaryKey[0]];
  if (typeof value !== "string") fail("IDENTITY_TRANSFER_SOURCE_KEY_INVALID");
  return value;
}

function mapTableManifest(entries) {
  return Object.freeze(Object.fromEntries(entries.map(({ spec, rows, sha256 }) => [spec.name,
    Object.freeze({ rows, sha256 })])));
}

function manifestDigest(tables) {
  return digestObject({ schema: POSTGRES_IDENTITY_AUTHORITY_TRANSFER_SCHEMA, tables });
}

function exactSnapshotDescriptor(source) {
  if (!source || !TRUSTED_SOURCES.has(source)) fail("IDENTITY_TRANSFER_SEALED_SOURCE_REQUIRED");
  const snapshot = source.snapshot;
  if (!snapshot || snapshot.kind !== "sealed-sqlite-rehearsal"
      || snapshot.binding !== POSTGRES_IDENTITY_AUTHORITY_SOURCE_BINDING
      || snapshot.immutable !== true || !SHA256.test(snapshot.artifactSha256 ?? "")
      || snapshot.snapshotId !== `sha256:${snapshot.artifactSha256}`
      || typeof source.listPage !== "function" || typeof source.verifySnapshot !== "function") {
    fail("IDENTITY_TRANSFER_SEALED_SOURCE_REQUIRED");
  }
  return Object.freeze({
    kind: snapshot.kind,
    binding: snapshot.binding,
    snapshotId: snapshot.snapshotId,
    artifactSha256: snapshot.artifactSha256,
  });
}

async function assertSnapshot(source, expected) {
  const actual = await source.verifySnapshot();
  if (!exactObject(actual, ["snapshotId", "artifactSha256"])
      || actual.snapshotId !== expected.snapshotId
      || actual.artifactSha256 !== expected.artifactSha256) fail("IDENTITY_TRANSFER_SNAPSHOT_CHANGED");
}

async function assertNoSqliteSidecars(path) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(`${path}${suffix}`);
      fail("IDENTITY_TRANSFER_SEALED_SQLITE_SIDECAR_PRESENT");
    } catch (error) {
      if (error instanceof PostgresIdentityAuthorityTransferError) throw error;
      if (error?.code !== "ENOENT") fail("IDENTITY_TRANSFER_SEALED_SQLITE_UNAVAILABLE");
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink;
}

async function sealedSqliteFingerprint(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("IDENTITY_TRANSFER_SEALED_SQLITE_PATH_INVALID");
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0
        || (before.mode & 0o222) !== 0 || before.size < 1 || before.size > MAX_SEALED_SQLITE_BYTES) {
      fail("IDENTITY_TRANSFER_SEALED_SQLITE_UNSAFE");
    }
    const resolved = await realpath(path);
    if (resolved !== path) fail("IDENTITY_TRANSFER_SEALED_SQLITE_UNSAFE");
    await assertNoSqliteSidecars(path);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) fail("IDENTITY_TRANSFER_SEALED_SQLITE_CHANGED");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - offset), offset);
      if (bytesRead <= 0) fail("IDENTITY_TRANSFER_SEALED_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after)) fail("IDENTITY_TRANSFER_SEALED_SQLITE_CHANGED");
    await assertNoSqliteSidecars(path);
    return Object.freeze({ sha256: hash.digest("hex"), stat: opened });
  } catch (error) {
    if (error instanceof PostgresIdentityAuthorityTransferError) throw error;
    fail("IDENTITY_TRANSFER_SEALED_SQLITE_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function validateSqliteLayout(database) {
  const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const spec of TABLES) {
    if (!names.has(spec.name)) fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    let columns;
    let sql;
    try {
      columns = database.prepare(`PRAGMA table_info("${spec.name}")`).all();
      sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(spec.name)?.sql;
    } catch {
      fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    }
    const expected = new Map(spec.sourceFields.map(value => [value.name, sqliteType(value.kind)]));
    if (!Array.isArray(columns) || columns.length !== expected.size || typeof sql !== "string"
        || !/\)\s*STRICT\s*;?\s*$/iu.test(sql)) fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    const seen = new Set();
    let primaryKeyCount = 0;
    for (const column of columns) {
      if (typeof column?.name !== "string" || !expected.has(column.name) || seen.has(column.name)
          || String(column.type).toUpperCase() !== expected.get(column.name)
          || Number(column.notnull) !== (spec.sourceFields.find(value => value.name === column.name).nullable ? 0 : 1)) {
        fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
      }
      seen.add(column.name);
      if (column.pk > 0) {
        primaryKeyCount += 1;
        if (column.name !== spec.sourcePrimaryKey[0] || column.pk !== 1) fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
      }
    }
    if (primaryKeyCount !== 1) fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    const expectedForeignKeys = SOURCE_FOREIGN_KEYS[spec.name]
      .map(value => `${value.column}|${value.table}|${value.referencedColumn}|${value.onDelete}`)
      .sort();
    let actualForeignKeys;
    try {
      actualForeignKeys = database.prepare(`PRAGMA foreign_key_list("${spec.name}")`).all()
        .map(value => `${value.from}|${value.table}|${value.to}|${String(value.on_delete).toUpperCase()}`)
        .sort();
    } catch {
      fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    }
    if (actualForeignKeys.join("\n") !== expectedForeignKeys.join("\n")) {
      fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    }
    try {
      if (database.prepare(`PRAGMA foreign_key_check("${spec.name}")`).all().length > 0) {
        fail("IDENTITY_TRANSFER_SOURCE_AUTHORITY_INVALID");
      }
    } catch (error) {
      if (error instanceof PostgresIdentityAuthorityTransferError) throw error;
      fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
    }
  }
  // The issuance singleton makes accountless migration authority stateful.
  // This slice will not reset it. Require the exact D1 migration seed and an
  // otherwise-empty accountless authority graph before copying social rows.
  const requiredAccountlessTables = [
    "accountless_enrollment_ledger", "accountless_enrollment_issuance",
    "accountless_upload_owners", "accountless_v11_device_authorizations",
  ];
  if (requiredAccountlessTables.some(name => !names.has(name))) fail("IDENTITY_TRANSFER_SOURCE_LAYOUT_INVALID");
}

function assertAccountlessAuthorityOutOfScope(database) {
  try {
    const participants = database.prepare("SELECT count(*) AS count FROM participants WHERE owner_kind='accountless'").get()?.count;
    const credentials = database.prepare("SELECT count(*) AS count FROM device_credentials WHERE authority_kind='accountless'").get()?.count;
    const ledgers = database.prepare("SELECT count(*) AS count FROM accountless_enrollment_ledger").get()?.count;
    const owners = database.prepare("SELECT count(*) AS count FROM accountless_upload_owners").get()?.count;
    const authorizations = database.prepare("SELECT count(*) AS count FROM accountless_v11_device_authorizations").get()?.count;
    const issuance = database.prepare("SELECT singleton,budget_day,daily_issued,lifetime_issued,last_issue_token,updated_at FROM accountless_enrollment_issuance").all();
    const seed = issuance.length === 1 && Number(issuance[0].singleton) === 1
      && issuance[0].budget_day === "1970-01-01" && Number(issuance[0].daily_issued) === 0
      && Number(issuance[0].lifetime_issued) === 0 && issuance[0].last_issue_token === ""
      && issuance[0].updated_at === "1970-01-01T00:00:00.000Z";
    if ([participants, credentials, ledgers, owners, authorizations].some(value => BigInt(value ?? 0) !== 0n)
        || !seed) fail("IDENTITY_TRANSFER_ACCOUNTLESS_AUTHORITY_OUT_OF_SCOPE");
  } catch (error) {
    if (error instanceof PostgresIdentityAuthorityTransferError) throw error;
    fail("IDENTITY_TRANSFER_ACCOUNTLESS_AUTHORITY_OUT_OF_SCOPE");
  }
}

/**
 * Open a content-free synthetic or independently sealed USAGE_MONITOR_DB SQL
 * reconstruction. The binding label is an explicit source selector only; it
 * does not prove who exported the artifact or that multiple D1 bindings shared
 * a source fence.
 */
export async function createSealedSqliteIdentityAuthoritySource({
  path,
  expectedSha256,
  binding = POSTGRES_IDENTITY_AUTHORITY_SOURCE_BINDING,
} = {}) {
  if (binding !== POSTGRES_IDENTITY_AUTHORITY_SOURCE_BINDING) fail("IDENTITY_TRANSFER_SOURCE_BINDING_INVALID");
  if (!SHA256.test(expectedSha256 ?? "")) fail("IDENTITY_TRANSFER_SEALED_SQLITE_SHA256_REQUIRED");
  const initial = await sealedSqliteFingerprint(path);
  if (initial.sha256 !== expectedSha256) fail("IDENTITY_TRANSFER_SEALED_SQLITE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal") {
      fail("IDENTITY_TRANSFER_SEALED_SQLITE_SIDECAR_PRESENT");
    }
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") {
      fail("IDENTITY_TRANSFER_SEALED_SQLITE_INTEGRITY_FAILED");
    }
    validateSqliteLayout(database);
    assertAccountlessAuthorityOutOfScope(database);
  } catch (error) {
    database?.close();
    if (error instanceof PostgresIdentityAuthorityTransferError) throw error;
    fail("IDENTITY_TRANSFER_SEALED_SQLITE_INVALID");
  }
  const statements = new Map();
  const d1Shape = {
    prepare(sql) {
      let statement = statements.get(sql);
      try {
        if (!statement) {
          if (statements.size >= 2 * TABLES.length + 1) fail("IDENTITY_TRANSFER_SOURCE_QUERY_LIMIT");
          statement = database.prepare(sql);
          statement.setReadBigInts(true);
          statements.set(sql, statement);
        }
      } catch {
        fail("IDENTITY_TRANSFER_SOURCE_READ_FAILED");
      }
      return {
        bind(...parameters) {
          return {
            async all() {
              try {
                return { success: true, results: statement.all(...parameters) };
              } catch {
                fail("IDENTITY_TRANSFER_SOURCE_READ_FAILED");
              }
            },
          };
        },
      };
    },
  };
  const snapshot = Object.freeze({
    kind: "sealed-sqlite-rehearsal",
    binding,
    snapshotId: `sha256:${expectedSha256}`,
    artifactSha256: expectedSha256,
    immutable: true,
  });
  let closed = false;
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      if (closed) fail("IDENTITY_TRANSFER_SEALED_SQLITE_CLOSED");
      const actual = await sealedSqliteFingerprint(path);
      if (actual.sha256 !== expectedSha256 || !sameFileIdentity(initial.stat, actual.stat)) {
        fail("IDENTITY_TRANSFER_SNAPSHOT_CHANGED");
      }
      return { snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256 };
    },
    async listPage({ table: tableName, after = null, limit } = {}) {
      if (closed) fail("IDENTITY_TRANSFER_SEALED_SQLITE_CLOSED");
    const spec = TABLE_BY_NAME.get(tableName);
      validatePageSize(limit);
      if (!spec) fail("IDENTITY_TRANSFER_TABLE_INVALID");
      if (after !== null && typeof after !== "string") fail("IDENTITY_TRANSFER_CHECKPOINT_INVALID");
      const columns = spec.sourceColumns.map(column => `"${column}"`).join(",");
      const key = `"${spec.sourcePrimaryKey[0]}"`;
      const sql = `SELECT ${columns} FROM "${spec.name}"${after === null ? "" : ` WHERE ${key} COLLATE BINARY > ?1`} ORDER BY ${key} COLLATE BINARY LIMIT ?${after === null ? "1" : "2"}`;
      const prepared = d1Shape.prepare(sql);
      const response = await prepared.bind(...(after === null ? [limit] : [after, limit])).all();
      if (!response || response.success === false || !Array.isArray(response.results)) fail("IDENTITY_TRANSFER_SOURCE_READ_FAILED");
      return Object.freeze({ rows: Object.freeze(response.results) });
    },
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      database.close();
    },
  });
  TRUSTED_SOURCES.add(source);
  exactSnapshotDescriptor(source);
  return source;
}

async function readSourcePage(source, spec, after, pageSize) {
  const page = await source.listPage({ table: spec.name, after, limit: pageSize });
  if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("IDENTITY_TRANSFER_SOURCE_PAGE_INVALID");
  const rows = page.rows.map(raw => {
    const sourceRow = normalizeRow({ fields: spec.sourceFields }, raw);
    const projected = spec.projectSourceRow ? spec.projectSourceRow(sourceRow) : sourceRow;
    return normalizeRow(spec, projected);
  });
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0 && cursorValue(spec, rows[index - 1]) >= cursorValue(spec, rows[index])) {
      fail("IDENTITY_TRANSFER_SOURCE_ORDER_INVALID");
    }
    if (after !== null && cursorValue(spec, rows[index]) <= after) fail("IDENTITY_TRANSFER_SOURCE_ORDER_INVALID");
  }
  return rows;
}

async function scanSource(source, pageSize) {
  const tables = [];
  for (const spec of TABLES) {
    const hash = createHash("sha256");
    let rows = 0;
    let after = null;
    for (;;) {
      const page = await readSourcePage(source, spec, after, pageSize);
      if (page.length === 0) break;
      for (const row of page) {
        if (spec.name === "participants" && row.owner_kind !== "social") {
          fail("IDENTITY_TRANSFER_ACCOUNTLESS_AUTHORITY_OUT_OF_SCOPE");
        }
        if (spec.name === "device_credentials"
            && (row.authority_kind !== "social" || row.accountless_enrollment_device_id !== null)) {
          fail("IDENTITY_TRANSFER_ACCOUNTLESS_AUTHORITY_OUT_OF_SCOPE");
        }
        if (spec.name === "device_pairings"
            && (!PAIRING_CONSENT_VERSIONS.has(row.consent_version)
              || !TRANSPORT_CONSENT_VERSIONS.has(row.transport_consent_version))) {
          fail("IDENTITY_TRANSFER_SOURCE_AUTHORITY_INVALID");
        }
        rowHash(hash, spec, row);
        rows += 1;
      }
      after = cursorValue(spec, page.at(-1));
      if (page.length < pageSize) break;
    }
    tables.push({ spec, rows, sha256: hash.digest("hex") });
  }
  const tableMap = mapTableManifest(tables);
  return Object.freeze({ tables: tableMap, sha256: manifestDigest(tableMap) });
}

async function assertPostgres17(pool) {
  let result;
  try {
    result = await pool.query("SELECT current_setting('server_version_num')::int AS version_num");
  } catch {
    fail("IDENTITY_TRANSFER_POSTGRES_UNAVAILABLE");
  }
  const version = Number(result.rows?.[0]?.version_num);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("IDENTITY_TRANSFER_POSTGRES_17_REQUIRED");
  return version;
}

async function assertMigrationHistory(pool, targetSchema) {
  let expected;
  let rows;
  try {
    expected = await readPostgresMigrations({ role: "primary" });
    const result = await pool.query(
      `SELECT version,name,checksum_sha256 FROM ${quoteRelation(targetSchema, "_tibotattle_migration_history")} ORDER BY version`,
    );
    rows = result.rows;
  } catch {
    fail("IDENTITY_TRANSFER_TARGET_MIGRATION_HISTORY_INVALID");
  }
  if (expected.length < KNOWN_PRIMARY_MIGRATION_COUNT || rows.length !== expected.length) {
    fail("IDENTITY_TRANSFER_TARGET_MIGRATION_HISTORY_INVALID");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = rows[index];
    const migration = expected[index];
    if (!actual || Number(actual.version) !== migration.version || actual.name !== migration.name
        || actual.checksum_sha256 !== migration.sha256) fail("IDENTITY_TRANSFER_TARGET_MIGRATION_HISTORY_INVALID");
  }
  return expected.length;
}

async function assertTargetLayout(pool, schema) {
  let result;
  try {
    result = await pool.query(
      `SELECT table_name,column_name,data_type,is_nullable
         FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=ANY($2::text[])
        ORDER BY table_name,ordinal_position`,
      [schema, TABLES.map(spec => spec.name)],
    );
  } catch {
    fail("IDENTITY_TRANSFER_TARGET_LAYOUT_INVALID");
  }
  const byTable = new Map();
  for (const row of result.rows ?? []) {
    const values = byTable.get(row.table_name) ?? [];
    values.push(row);
    byTable.set(row.table_name, values);
  }
  for (const spec of TABLES) {
    const rows = byTable.get(spec.name) ?? [];
    if (rows.length !== spec.fields.length) fail("IDENTITY_TRANSFER_TARGET_LAYOUT_INVALID");
    const byName = new Map(rows.map(row => [row.column_name, row]));
    for (const fieldValue of spec.fields) {
      const column = byName.get(fieldValue.name);
      if (!column || column.data_type !== pgType(fieldValue.kind)
          || column.is_nullable !== (fieldValue.nullable ? "YES" : "NO")) {
        fail("IDENTITY_TRANSFER_TARGET_LAYOUT_INVALID");
      }
    }
  }
}

async function ensureControlTables(pool, controlSchema) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(controlSchema)}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${quoteRelation(controlSchema, CONTROL_RUN_TABLE)} (
    transfer_id text PRIMARY KEY,
    schema_version text NOT NULL,
    source_binding text NOT NULL,
    source_snapshot_id text NOT NULL,
    source_artifact_sha256 text NOT NULL,
    source_manifest_sha256 text NOT NULL,
    target_schema text NOT NULL,
    status text NOT NULL CHECK (status IN ('copying','complete')),
    updated_at timestamptz NOT NULL,
    completed_at timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${quoteRelation(controlSchema, CONTROL_CHECKPOINT_TABLE)} (
    transfer_id text NOT NULL REFERENCES ${quoteRelation(controlSchema, CONTROL_RUN_TABLE)}(transfer_id) ON DELETE CASCADE,
    table_name text NOT NULL,
    last_key text,
    row_count bigint NOT NULL CHECK (row_count >= 0),
    page_count integer NOT NULL CHECK (page_count >= 0),
    complete boolean NOT NULL,
    PRIMARY KEY (transfer_id,table_name)
  )`);
  const shape = await pool.query(
    `SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position`,
    [controlSchema, [CONTROL_RUN_TABLE, CONTROL_CHECKPOINT_TABLE]],
  );
  const expected = {
    [CONTROL_RUN_TABLE]: ["transfer_id:text:NO", "schema_version:text:NO", "source_binding:text:NO", "source_snapshot_id:text:NO",
      "source_artifact_sha256:text:NO", "source_manifest_sha256:text:NO", "target_schema:text:NO", "status:text:NO",
      "updated_at:timestamp with time zone:NO", "completed_at:timestamp with time zone:YES"],
    [CONTROL_CHECKPOINT_TABLE]: ["transfer_id:text:NO", "table_name:text:NO", "last_key:text:YES", "row_count:bigint:NO",
      "page_count:integer:NO", "complete:boolean:NO"],
  };
  for (const name of Object.keys(expected)) {
    const actual = (shape.rows ?? []).filter(row => row.table_name === name)
      .map(row => `${row.column_name}:${row.data_type}:${row.is_nullable}`);
    if (actual.join(",") !== expected[name].join(",")) fail("IDENTITY_TRANSFER_CONTROL_LAYOUT_INVALID");
  }
  const primaryKeys = await pool.query(
    `SELECT tc.table_name,string_agg(kcu.column_name,',' ORDER BY kcu.ordinal_position) AS columns
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name
        AND kcu.table_name=tc.table_name
      WHERE tc.constraint_schema=$1 AND tc.constraint_type='PRIMARY KEY'
        AND tc.table_name=ANY($2::text[])
      GROUP BY tc.table_name`,
    [controlSchema, [CONTROL_RUN_TABLE, CONTROL_CHECKPOINT_TABLE]],
  );
  const actualKeys = Object.fromEntries((primaryKeys.rows ?? []).map(row => [row.table_name, row.columns]));
  if (actualKeys[CONTROL_RUN_TABLE] !== "transfer_id"
      || actualKeys[CONTROL_CHECKPOINT_TABLE] !== "transfer_id,table_name"
      || Object.keys(actualKeys).length !== 2) fail("IDENTITY_TRANSFER_CONTROL_LAYOUT_INVALID");
  const foreignKeys = await pool.query(
    `SELECT kcu.column_name,ccu.table_name AS referenced_table,ccu.column_name AS referenced_column,rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_catalog=rc.constraint_catalog AND kcu.constraint_schema=rc.constraint_schema
        AND kcu.constraint_name=rc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_catalog=rc.constraint_catalog AND ccu.constraint_schema=rc.constraint_schema
        AND ccu.constraint_name=rc.constraint_name
      WHERE kcu.constraint_schema=$1 AND kcu.table_name=$2`,
    [controlSchema, CONTROL_CHECKPOINT_TABLE],
  );
  if (foreignKeys.rows?.length !== 1 || foreignKeys.rows[0]?.column_name !== "transfer_id"
      || foreignKeys.rows[0]?.referenced_table !== CONTROL_RUN_TABLE
      || foreignKeys.rows[0]?.referenced_column !== "transfer_id"
      || foreignKeys.rows[0]?.delete_rule !== "CASCADE") fail("IDENTITY_TRANSFER_CONTROL_LAYOUT_INVALID");
}

async function acquireTransferLock(pool, transferId) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`identity-authority-transfer:${transferId}`]);
    return client;
  } catch {
    client.release();
    fail("IDENTITY_TRANSFER_LOCK_FAILED");
  }
}

async function releaseTransferLock(client, transferId) {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`identity-authority-transfer:${transferId}`]);
  } finally {
    client.release();
  }
}

async function getOrCreateRun({ pool, controlSchema, transferId, targetSchema, snapshot, sourceManifest }) {
  const relation = quoteRelation(controlSchema, CONTROL_RUN_TABLE);
  await pool.query(
    `INSERT INTO ${relation} (transfer_id,schema_version,source_binding,source_snapshot_id,
       source_artifact_sha256,source_manifest_sha256,target_schema,status,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'copying',clock_timestamp()) ON CONFLICT (transfer_id) DO NOTHING`,
    [transferId, POSTGRES_IDENTITY_AUTHORITY_TRANSFER_SCHEMA, snapshot.binding, snapshot.snapshotId,
      snapshot.artifactSha256, sourceManifest.sha256, targetSchema],
  );
  const selected = await pool.query(`SELECT * FROM ${relation} WHERE transfer_id=$1`, [transferId]);
  const run = selected.rows?.[0];
  if (!run || run.schema_version !== POSTGRES_IDENTITY_AUTHORITY_TRANSFER_SCHEMA
      || run.source_binding !== snapshot.binding || run.source_snapshot_id !== snapshot.snapshotId
      || run.source_artifact_sha256 !== snapshot.artifactSha256
      || run.source_manifest_sha256 !== sourceManifest.sha256 || run.target_schema !== targetSchema) {
    fail("IDENTITY_TRANSFER_ID_REUSED");
  }
  return run;
}

async function assertTargetEmptyBeforeRun(pool, targetSchema) {
  for (const spec of TABLES) {
    const row = await pool.query(`SELECT EXISTS (SELECT 1 FROM ${quoteRelation(targetSchema, spec.name)} LIMIT 1) AS has_rows`);
    if (row.rows?.[0]?.has_rows !== false) fail("IDENTITY_TRANSFER_TARGET_NOT_EMPTY");
  }
}

async function readCheckpoint(pool, controlSchema, transferId, tableName) {
  const result = await pool.query(
    `SELECT last_key,row_count::text AS row_count,page_count,complete
       FROM ${quoteRelation(controlSchema, CONTROL_CHECKPOINT_TABLE)}
      WHERE transfer_id=$1 AND table_name=$2`, [transferId, tableName],
  );
  return result.rows?.[0] ?? null;
}

async function readTargetRowsByKeys(client, targetSchema, spec, keys) {
  const key = spec.primaryKey[0];
  const columns = spec.columns.map(name => `"${name}"`).join(",");
  const result = await client.query(
    `SELECT ${columns} FROM ${quoteRelation(targetSchema, spec.name)} WHERE "${key}" = ANY($1::text[]) ORDER BY "${key}" COLLATE "C"`,
    [keys],
  );
  return result.rows.map(row => normalizeRow(spec, row));
}

async function copyTable({ source, pool, targetSchema, controlSchema, transferId, spec, pageSize }) {
  const checkpoint = await readCheckpoint(pool, controlSchema, transferId, spec.name);
  let after = checkpoint?.last_key ?? null;
  let importedRows = BigInt(checkpoint?.row_count ?? "0");
  let pageCount = Number(checkpoint?.page_count ?? 0);
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) fail("IDENTITY_TRANSFER_CHECKPOINT_INVALID");
  if (checkpoint?.complete) {
    const next = await readSourcePage(source, spec, after, pageSize);
    if (next.length !== 0) fail("IDENTITY_TRANSFER_CHECKPOINT_INVALID");
    return { pages: 0 };
  }
  for (;;) {
    const page = await readSourcePage(source, spec, after, pageSize);
    if (page.length === 0) break;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const columns = spec.columns.map(name => `"${name}"`).join(",");
      const placeholders = spec.fields.map((_, index) => `$${index + 1}`).join(",");
      const key = spec.primaryKey[0];
      for (const row of page) {
        const values = spec.fields.map(fieldValue => row[fieldValue.name]);
        await client.query(
          `INSERT INTO ${quoteRelation(targetSchema, spec.name)} (${columns}) VALUES (${placeholders})
           ON CONFLICT ("${key}") DO NOTHING`, values,
        );
      }
      const targetRows = await readTargetRowsByKeys(client, targetSchema, spec, page.map(row => cursorValue(spec, row)));
      if (targetRows.length !== page.length) fail("IDENTITY_TRANSFER_DESTINATION_KEY_CONFLICT");
      for (let index = 0; index < page.length; index += 1) {
        if (!sameRow(spec, page[index], targetRows[index])) fail("IDENTITY_TRANSFER_DESTINATION_ROW_MISMATCH");
      }
      const newCount = importedRows + BigInt(page.length);
      const newPages = pageCount + 1;
      const lastKey = cursorValue(spec, page.at(-1));
      await client.query(
        `INSERT INTO ${quoteRelation(controlSchema, CONTROL_CHECKPOINT_TABLE)}
           (transfer_id,table_name,last_key,row_count,page_count,complete)
         VALUES ($1,$2,$3,$4,$5,false)
         ON CONFLICT (transfer_id,table_name) DO UPDATE SET last_key=EXCLUDED.last_key,
           row_count=EXCLUDED.row_count,page_count=EXCLUDED.page_count,complete=false`,
        [transferId, spec.name, lastKey, newCount.toString(), newPages],
      );
      await client.query("COMMIT");
      importedRows = newCount;
      pageCount = newPages;
      after = lastKey;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof PostgresIdentityAuthorityTransferError) throw error;
      fail("IDENTITY_TRANSFER_PAGE_WRITE_FAILED");
    } finally {
      client.release();
    }
    if (page.length < pageSize) break;
  }
  await pool.query(
    `INSERT INTO ${quoteRelation(controlSchema, CONTROL_CHECKPOINT_TABLE)}
       (transfer_id,table_name,last_key,row_count,page_count,complete)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (transfer_id,table_name) DO UPDATE SET last_key=EXCLUDED.last_key,
       row_count=EXCLUDED.row_count,page_count=EXCLUDED.page_count,complete=true`,
    [transferId, spec.name, after, importedRows.toString(), pageCount],
  );
  return { pages: Math.max(0, pageCount - Number(checkpoint?.page_count ?? 0)) };
}

async function scanPostgresTable(pool, schema, spec, pageSize) {
  const hash = createHash("sha256");
  let rows = 0;
  let after = null;
  for (;;) {
    const key = spec.primaryKey[0];
    const columns = spec.columns.map(name => `"${name}"`).join(",");
    const result = await pool.query(
      `SELECT ${columns} FROM ${quoteRelation(schema, spec.name)}${after === null ? "" : ` WHERE "${key}" COLLATE "C" > $1`}
       ORDER BY "${key}" COLLATE "C" LIMIT $${after === null ? "1" : "2"}`,
      after === null ? [pageSize] : [after, pageSize],
    );
    if (!Array.isArray(result.rows) || result.rows.length > pageSize) fail("IDENTITY_TRANSFER_DESTINATION_READ_FAILED");
    if (result.rows.length === 0) break;
    const page = result.rows.map(raw => normalizeRow(spec, raw));
    for (const row of page) {
      rowHash(hash, spec, row);
      rows += 1;
    }
    after = cursorValue(spec, page.at(-1));
    if (page.length < pageSize) break;
  }
  return Object.freeze({ rows, sha256: hash.digest("hex") });
}

/**
 * Copy only the social identity/device-authority family from a sealed local
 * USAGE_MONITOR_DB SQLite rehearsal artifact into a fully migrated, disposable
 * PostgreSQL 17 schema. This is staged evidence, never cutover or erasure proof.
 */
export async function runPostgresIdentityAuthorityTransfer({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  controlSchema: rawControlSchema,
  transferId,
  pageSize = POSTGRES_IDENTITY_AUTHORITY_DEFAULT_PAGE_SIZE,
} = {}) {
  const targetSchema = schemaName(rawTargetSchema);
  const controlSchema = schemaName(rawControlSchema);
  if (!targetSchema.startsWith(POSTGRES_IDENTITY_AUTHORITY_TARGET_SCHEMA_PREFIX)
      || targetSchema.slice(POSTGRES_IDENTITY_AUTHORITY_TARGET_SCHEMA_PREFIX.length).length < 8
      || !controlSchema.startsWith(POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX)
      || controlSchema.slice(POSTGRES_IDENTITY_AUTHORITY_CONTROL_SCHEMA_PREFIX.length).length < 8
      || targetSchema === controlSchema) fail("IDENTITY_TRANSFER_DISPOSABLE_SCHEMA_REQUIRED");
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("IDENTITY_TRANSFER_ID_INVALID");
  const size = validatePageSize(pageSize);
  const snapshot = exactSnapshotDescriptor(source);
  await assertSnapshot(source, snapshot);
  const postgresVersion = await assertPostgres17(destinationPool);
  const migrationCount = await assertMigrationHistory(destinationPool, targetSchema);
  await assertTargetLayout(destinationPool, targetSchema);
  const sourceManifest = await scanSource(source, size);
  await assertSnapshot(source, snapshot);
  await ensureControlTables(destinationPool, controlSchema);
  const lockClient = await acquireTransferLock(destinationPool, transferId);
  try {
    const priorRun = await destinationPool.query(
      `SELECT transfer_id FROM ${quoteRelation(controlSchema, CONTROL_RUN_TABLE)} WHERE transfer_id=$1`, [transferId],
    );
    if ((priorRun.rows?.length ?? 0) === 0) await assertTargetEmptyBeforeRun(destinationPool, targetSchema);
    const run = await getOrCreateRun({
      pool: destinationPool, controlSchema, transferId, targetSchema, snapshot, sourceManifest,
    });
    let pagesCommittedThisRun = 0;
    for (const spec of TABLES) {
      const result = await copyTable({
        source, pool: destinationPool, targetSchema, controlSchema, transferId, spec, pageSize: size,
      });
      pagesCommittedThisRun += result.pages;
    }
    const finalSourceManifest = await scanSource(source, size);
    if (finalSourceManifest.sha256 !== sourceManifest.sha256) fail("IDENTITY_TRANSFER_SOURCE_CHANGED");
    await assertSnapshot(source, snapshot);
    const targetTables = Object.create(null);
    for (const spec of TABLES) targetTables[spec.name] = await scanPostgresTable(destinationPool, targetSchema, spec, size);
    const targetManifest = Object.freeze(targetTables);
    const targetManifestSha256 = manifestDigest(targetManifest);
    for (const spec of TABLES) {
      const expected = sourceManifest.tables[spec.name];
      const actual = targetManifest[spec.name];
      if (expected.rows !== actual.rows || expected.sha256 !== actual.sha256) {
        fail("IDENTITY_TRANSFER_SOURCE_DESTINATION_PARITY_FAILED");
      }
    }
    await destinationPool.query(
      `UPDATE ${quoteRelation(controlSchema, CONTROL_RUN_TABLE)}
          SET status='complete',updated_at=clock_timestamp(),completed_at=COALESCE(completed_at,clock_timestamp())
        WHERE transfer_id=$1 AND source_manifest_sha256=$2`,
      [transferId, sourceManifest.sha256],
    );
    const repeated = run.status === "complete";
    return Object.freeze({
      schema: POSTGRES_IDENTITY_AUTHORITY_TRANSFER_SCHEMA,
      status: "staged_rehearsal_complete",
      transferId,
      source: Object.freeze({
        kind: snapshot.kind,
        binding: snapshot.binding,
        snapshotId: snapshot.snapshotId,
        artifactSha256: snapshot.artifactSha256,
        rows: Object.values(sourceManifest.tables).reduce((sum, value) => sum + value.rows, 0),
        manifestSha256: sourceManifest.sha256,
        tables: sourceManifest.tables,
      }),
      destination: Object.freeze({
        postgresMajor: Math.floor(postgresVersion / 10_000),
        appliedPrimaryMigrations: migrationCount,
        schema: targetSchema,
        rows: Object.values(targetManifest).reduce((sum, value) => sum + value.rows, 0),
        manifestSha256: targetManifestSha256,
        tables: targetManifest,
      }),
      pageSize: size,
      pagesCommittedThisRun,
      idempotentRetry: repeated || pagesCommittedThisRun === 0,
      capabilities: Object.freeze({
        socialParticipantsTransferred: true,
        socialSessionsAndDevicesTransferred: true,
        enrollmentAndUploadAuthoritiesTransferred: true,
        accountlessAuthorityTransferred: false,
        accountlessIssuanceControlTransferred: false,
        analyticsOwnerLinksTransferred: false,
        ownerJournalAndRevisionsTransferred: false,
        deletionLedgerTransferred: false,
        productionCutoverAuthorized: false,
        erasureAuthorized: false,
      }),
    });
  } finally {
    await releaseTransferLock(lockClient, transferId);
  }
}

export const POSTGRES_IDENTITY_AUTHORITY_TRANSFER_TABLES = Object.freeze(TABLES.map(spec => spec.name));
export const POSTGRES_IDENTITY_AUTHORITY_TRANSFER_LAYOUT = Object.freeze(TABLES.map(spec => Object.freeze({
  name: spec.name,
  primaryKey: spec.primaryKey,
  columns: Object.freeze(spec.fields.map(value => Object.freeze({
    name: value.name, kind: value.kind, nullable: value.nullable,
  }))),
})));
