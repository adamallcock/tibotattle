import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  POSTGRES_TYPED_LEGACY_STAGING_FAMILY_EVIDENCE_TABLE,
  POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX,
  POSTGRES_TYPED_LEGACY_TRANSFER_CHECKPOINT_TABLE,
  POSTGRES_TYPED_LEGACY_TRANSFER_RUN_TABLE,
  POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA,
  POSTGRES_TYPED_LEGACY_TRANSFER_TABLES,
  typedLegacyStagingFamilyEvidenceSha256,
} from "./postgres-typed-legacy-transfer.mjs";

export const POSTGRES_LEGACY_ADMISSION_TRANSFER_SCHEMA = "legacy-admission-transfer-v1";
export const POSTGRES_LEGACY_ADMISSION_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE = 250;

const CONTROL_PREFIX = "typed_legacy_admission_transfer_";
const RUN_TABLE = "_legacy_admission_transfer_runs_v1";
const CHECKPOINT_TABLE = "_legacy_admission_transfer_checkpoints_v1";
const STAGING_RECEIPT_TABLE = "_legacy_admission_staging_receipts_v1";
const TRANSIENT_REQUEST_TABLE = "typed_v1_authority_requests";
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_SQLITE_BYTES = 100 * 1024 * 1024 * 1024;
const TABLES = Object.freeze([
  table("typed_v1_admission_state", ["id", "source_namespace", "namespace_id", "runtime_contract_version", "next_source_row_id"], ["id"], ["i16", "text", "i64", "i16", "i64"]),
  table("typed_v11_admission_state", ["id", "source_namespace", "namespace_id", "runtime_contract_version", "next_source_row_id"], ["id"], ["i16", "text", "i64", "i16", "i64"]),
  table("typed_v1_chunk_allocations", ["chunk_id", "namespace_id", "chunk_original", "first_source_row_id", "record_count"], ["chunk_id"], ["text", "i64", "bytes", "i64", "i32"]),
  table("typed_v11_chunk_allocations", ["chunk_id", "namespace_id", "chunk_original", "first_source_row_id", "record_count"], ["chunk_id"], ["text", "i64", "bytes", "i64", "i32"]),
  table("typed_v1_record_admissions", ["typed_record_id", "chunk_id"], ["typed_record_id"], ["i64", "text"]),
  table("typed_v1_preservation_proofs", ["source_row_id", "canonical_digest"], ["source_row_id"], ["i64", "bytes"]),
  table("typed_v11_manifest_memberships", ["manifest_id", "typed_manifest_id"], ["manifest_id"], ["text", "i64"]),
  table("typed_v11_record_proofs", ["typed_record_id", "chunk_key", "manifest_key", "stream_code", "occurrence_blob", "base_digest", "legacy_occurrence_blob", "legacy_digest", "observed_at_ms"], ["typed_record_id"], ["i64", "i64", "i64", "i16", "bytes", "bytes", "bytes", "bytes", "i64"]),
  table("typed_v1_event_sources", ["event_digest", "owner_digest", "participant_id", "chunk_id", "source_namespace"], ["event_digest"], ["text", "text", "text", "text", "text"]),
  table("storage_v11_event_sources", ["event_digest", "owner_digest", "participant_id", "device_id", "generation_id", "manifest_digest", "from_day", "through_day", "head_revision", "input_revision", "recorded_ms"], ["event_digest"], ["text", "text", "text", "text", "text", "text", "text", "text", "i64", "i64", "i64"]),
]);
const HEADER_TABLES = Object.freeze([
  table("telemetry_v1_chunks", ["id", "participant_id", "device_id", "stream", "chunk_day", "chunk_seq", "revision", "chunk_digest", "envelope_digest", "parser_version", "record_count", "accepted_record_count", "r2_key", "device_upload_authorization_id", "superseded_at", "quarantine_deleted_at", "created_at"], ["id"], ["text", "text", "text", "text", "text", "i32", "i32", "text", "text", "text", "i32", "i32", "text", "text", "text", "text", "text"], "_legacy_source_telemetry_v1_chunks_v1"),
  table("telemetry_v11_day_manifests", ["id", "participant_id", "device_id", "chunk_day", "manifest_digest", "parser_version", "manifest_json", "expected_chunk_count", "state", "created_at", "ready_at"], ["id"], ["text", "text", "text", "text", "text", "text", "longtext", "i32", "text", "text", "text"], "_legacy_source_telemetry_v11_day_manifests_v1"),
  table("telemetry_v11_chunks", ["id", "manifest_id", "participant_id", "device_id", "stream", "chunk_day", "chunk_seq", "chunk_id", "chunk_digest", "envelope_digest", "parser_version", "record_count", "r2_key", "device_upload_authorization_id", "quarantine_deleted_at", "created_at"], ["id"], ["text", "text", "text", "text", "text", "text", "i32", "text", "text", "text", "text", "i32", "text", "text", "text", "text"], "_legacy_source_telemetry_v11_chunks_v1"),
]);
const SOURCE_TABLES = Object.freeze([...TABLES, ...HEADER_TABLES]);
const TABLE_BY_NAME = new Map(SOURCE_TABLES.map((value) => [value.name, value]));
const ALLOWED_TARGET_TABLES = new Set([
  ...SOURCE_TABLES.map((value) => value.name),
  ...HEADER_TABLES.map((value) => value.targetTable),
]);
const TARGET_SUPPORT_TABLES = new Set([
  "telemetry_v1_records",
  "typed_telemetry_manifests",
  "typed_telemetry_owner_memberships",
  "typed_telemetry_records",
]);
const TRUSTED_SOURCES = new WeakSet();
const encoder = new TextEncoder();

export class PostgresLegacyAdmissionTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresLegacyAdmissionTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresLegacyAdmissionTransferError(code);
}

function table(name, columns, primaryKey, types, targetTable = undefined) {
  return Object.freeze({ name, columns: Object.freeze(columns), primaryKey: Object.freeze(primaryKey), types: Object.freeze(types), ...(targetTable ? { targetTable } : {}) });
}

function schemaName(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.startsWith("pg_")
      || value === "information_schema" || value === "pg_catalog") fail("LEGACY_ADMISSION_SCHEMA_INVALID");
  return value;
}

function qschema(value) { return `"${schemaName(value)}"`; }
function qtable(schema, name) {
  if (!ALLOWED_TARGET_TABLES.has(name) && name !== RUN_TABLE && name !== CHECKPOINT_TABLE
      && name !== "typed_telemetry_admission_transfer_receipts"
      && name !== "typed_telemetry_source_family_receipts"
      && !TARGET_SUPPORT_TABLES.has(name)) fail("LEGACY_ADMISSION_TABLE_INVALID");
  return `${qschema(schema)}."${name}"`;
}

function normalizeInt(value, type) {
  if (value === null) return null;
  let bigint;
  if (typeof value === "bigint") bigint = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) bigint = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) bigint = BigInt(value);
  else fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
  if (type === "i64") return bigint.toString();
  const [min, max] = type === "i16" ? [-32768n, 32767n] : [-2147483648n, 2147483647n];
  if (bigint < min || bigint > max) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
  return Number(bigint);
}

function normalizeValue(type, value) {
  if (value === null) return null;
  if (value === undefined) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
  if (type === "i64" || type === "i16" || type === "i32") return normalizeInt(value, type);
  if (type === "text") {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
    if (typeof value !== "string" || encoder.encode(value).byteLength > 4096) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
    return value;
  }
  if (type === "longtext") {
    if (typeof value !== "string" || encoder.encode(value).byteLength > 1_250_000) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
    return value;
  }
  if (type === "bytes") {
    if (Array.isArray(value)) {
      if (value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
      value = Buffer.from(value);
    }
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer)) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
    const bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    if (bytes.byteLength > 1024) fail("LEGACY_ADMISSION_SOURCE_VALUE_INVALID");
    return bytes;
  }
  fail("LEGACY_ADMISSION_COLUMN_TYPE_INVALID");
}

function normalizeRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("LEGACY_ADMISSION_SOURCE_ROW_INVALID");
  const result = Object.create(null);
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    result[column] = normalizeValue(spec.types[index], raw[column]);
  }
  return result;
}

function cursor(spec, row) { return spec.primaryKey.map((key) => row[key]); }
function compareKey(spec, left, right) {
  const key = spec.primaryKey[0];
  const index = spec.columns.indexOf(key);
  const type = spec.types[index];
  const a = left[key]; const b = right[key];
  if (type === "i64") return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
  if (type === "bytes") return Buffer.compare(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function rowJson(spec, row) {
  return JSON.stringify(spec.columns.map((column) => {
    const value = row[column];
    return Buffer.isBuffer(value) ? { bytes: value.toString("base64") } : value;
  }));
}

function validSource(source) {
  if (!source || !TRUSTED_SOURCES.has(source) || typeof source.listPage !== "function"
      || typeof source.verifySnapshot !== "function" || !source.snapshot) fail("LEGACY_ADMISSION_SEALED_SOURCE_REQUIRED");
  const snapshot = source.snapshot;
  if (snapshot.kind === "synthetic-d1-fixture" && snapshot.immutable === true
      && typeof snapshot.snapshotId === "string" && snapshot.snapshotId.length >= 8) {
    return Object.freeze({ kind: snapshot.kind, snapshotId: snapshot.snapshotId, artifactSha256: null });
  }
  if (snapshot.kind === "sealed-sqlite-rehearsal" && snapshot.immutable === true
      && SHA256.test(snapshot.artifactSha256 ?? "") && snapshot.snapshotId === `sha256:${snapshot.artifactSha256}`) {
    return Object.freeze({ kind: snapshot.kind, snapshotId: snapshot.snapshotId, artifactSha256: snapshot.artifactSha256 });
  }
  fail("LEGACY_ADMISSION_SEALED_SOURCE_REQUIRED");
}

function validatePageSize(value) {
  const pageSize = value ?? POSTGRES_LEGACY_ADMISSION_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE) fail("LEGACY_ADMISSION_PAGE_SIZE_INVALID");
  return pageSize;
}

async function scanSource(source, pageSize) {
  const tables = Object.create(null);
  for (const spec of SOURCE_TABLES) {
    let after = null;
    let count = 0;
    const hash = createHash("sha256");
    for (;;) {
      const page = await source.listPage({ table: spec.name, after, limit: pageSize });
      if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("LEGACY_ADMISSION_SOURCE_PAGE_INVALID");
      const rows = page.rows.map((raw) => normalizeRow(spec, raw));
      for (let index = 0; index < rows.length; index += 1) {
        if (after !== null && compareKey(spec, rows[index], { [spec.primaryKey[0]]: normalizeValue(spec.types[0], after[0]) }) <= 0) fail("LEGACY_ADMISSION_SOURCE_ORDER_INVALID");
        if (index > 0 && compareKey(spec, rows[index - 1], rows[index]) >= 0) fail("LEGACY_ADMISSION_SOURCE_ORDER_INVALID");
        hash.update(rowJson(spec, rows[index]));
        hash.update("\n");
      }
      count += rows.length;
      if (rows.length < pageSize) break;
      after = cursor(spec, rows.at(-1));
    }
    tables[spec.name] = Object.freeze({ rows: count, sha256: hash.digest("hex") });
  }
  const base = Object.freeze({ schema: POSTGRES_LEGACY_ADMISSION_TRANSFER_SCHEMA, tables: Object.freeze(tables) });
  return Object.freeze({ ...base, sha256: createHash("sha256").update(JSON.stringify(base)).digest("hex") });
}

export function createSyntheticLegacyAdmissionSource({
  tables,
  snapshotId,
  v11SourceManifests = [],
  expectedTypedRecordIds = { v1: [], v11Ready: [] },
} = {}) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables)
      || typeof snapshotId !== "string" || snapshotId.length < 8) fail("LEGACY_ADMISSION_SOURCE_INVALID");
  if (!Array.isArray(v11SourceManifests)) fail("LEGACY_ADMISSION_SOURCE_INVALID");
  if (!expectedTypedRecordIds || typeof expectedTypedRecordIds !== "object"
      || !Array.isArray(expectedTypedRecordIds.v1) || !Array.isArray(expectedTypedRecordIds.v11Ready)) fail("LEGACY_ADMISSION_SOURCE_INVALID");
  const recordIds = Object.freeze({
    v1: expectedTypedRecordIds.v1.map((value) => normalizeInt(value, "i64")),
    v11Ready: expectedTypedRecordIds.v11Ready.map((value) => normalizeInt(value, "i64")),
  });
  for (const ids of Object.values(recordIds)) {
    if (ids.some((value) => BigInt(value) < 1n) || new Set(ids).size !== ids.length) fail("LEGACY_ADMISSION_SOURCE_INVALID");
  }
  const manifestHeaders = new Map();
  for (const manifest of v11SourceManifests) {
    if (!manifest || typeof manifest.id !== "string" || !["staged", "ready"].includes(manifest.state)
        || !Number.isSafeInteger(manifest.expectedChunkCount) || manifest.expectedChunkCount < 0
        || !Number.isSafeInteger(manifest.actualChunkCount) || manifest.actualChunkCount < 0
        || manifestHeaders.has(manifest.id)) fail("LEGACY_ADMISSION_SOURCE_INVALID");
    manifestHeaders.set(manifest.id, Object.freeze({ ...manifest }));
  }
  for (const name of Object.keys(tables)) if (!TABLE_BY_NAME.has(name) && name !== TRANSIENT_REQUEST_TABLE) fail("LEGACY_ADMISSION_TABLE_INVALID");
  const transientRequests = tables[TRANSIENT_REQUEST_TABLE] ?? [];
  if (!Array.isArray(transientRequests)) fail("LEGACY_ADMISSION_SOURCE_TABLE_INVALID");
  const fixture = Object.create(null);
  for (const spec of SOURCE_TABLES) {
    const rows = tables[spec.name] ?? [];
    if (!Array.isArray(rows)) fail("LEGACY_ADMISSION_SOURCE_TABLE_MISSING");
    fixture[spec.name] = rows.map((row) => structuredClone(row)).sort((a, b) => compareKey(spec, normalizeRow(spec, a), normalizeRow(spec, b)));
  }
  const source = Object.freeze({
    snapshot: Object.freeze({ kind: "synthetic-d1-fixture", snapshotId, immutable: true }),
    async verifySnapshot() { return { snapshotId, artifactSha256: null }; },
    async assertSourceReady() {
      if (transientRequests.length !== 0) fail("LEGACY_ADMISSION_PENDING_AUTHORITY_REQUESTS");
      const memberships = fixture.typed_v11_manifest_memberships;
      const manifestByTypedId = new Map();
      for (const membership of memberships) {
        const header = manifestHeaders.get(membership.manifest_id);
        if (!header) fail("LEGACY_ADMISSION_SOURCE_PARENT_MISSING");
        manifestByTypedId.set(String(membership.typed_manifest_id), header);
        if (header.state !== "ready" || header.expectedChunkCount !== header.actualChunkCount) {
          fail("LEGACY_ADMISSION_STAGED_SOURCE_UNQUALIFIED");
        }
      }
      for (const proof of fixture.typed_v11_record_proofs) {
        const header = manifestByTypedId.get(String(proof.manifest_key));
        if (!header) fail("LEGACY_ADMISSION_SOURCE_PARENT_MISSING");
        if (header.state !== "ready" || header.expectedChunkCount !== header.actualChunkCount) {
          fail("LEGACY_ADMISSION_STAGED_SOURCE_UNQUALIFIED");
        }
      }
      const admittedV1 = fixture.typed_v1_record_admissions.map((row) => String(row.typed_record_id)).sort();
      const expectedV1 = [...recordIds.v1].sort();
      const provenReadyV11 = fixture.typed_v11_record_proofs
        .filter((row) => manifestByTypedId.get(String(row.manifest_key))?.state === "ready")
        .map((row) => String(row.typed_record_id)).sort();
      const expectedV11 = [...recordIds.v11Ready].sort();
      if (admittedV1.length !== expectedV1.length || admittedV1.some((id, index) => id !== expectedV1[index])
          || provenReadyV11.length !== expectedV11.length || provenReadyV11.some((id, index) => id !== expectedV11[index])) {
        fail("LEGACY_ADMISSION_SOURCE_PROOF_INCOMPLETE");
      }
      return Object.freeze({ pendingAuthorityRequests: 0 });
    },
    async listPage({ table: name, after = null, limit } = {}) {
      const spec = TABLE_BY_NAME.get(name);
      if (!spec || !Number.isInteger(limit) || limit < 1 || limit > POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE) fail("LEGACY_ADMISSION_SOURCE_PAGE_INVALID");
      const afterRow = after === null ? null : { [spec.primaryKey[0]]: normalizeValue(spec.types[0], after[0]) };
      const sourceRows = fixture[name];
      let low = 0;
      let high = sourceRows.length;
      if (afterRow !== null) {
        const key = spec.primaryKey[0];
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          const rowKey = normalizeValue(spec.types[0], sourceRows[middle][key]);
          if (compareKey(spec, { [key]: rowKey }, afterRow) <= 0) low = middle + 1;
          else high = middle;
        }
      }
      const rows = sourceRows.slice(low, low + limit).map((row) => structuredClone(row));
      return Object.freeze({ rows: Object.freeze(rows) });
    },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

async function fileFingerprint(path) {
  let file;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || await realpath(path) !== path) fail("LEGACY_ADMISSION_SQLITE_PATH_INVALID");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { await lstat(path + suffix); fail("LEGACY_ADMISSION_SQLITE_SIDECAR_PRESENT"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || typeof process.getuid !== "function" || before.uid !== process.getuid()
        || (before.mode & 0o222) !== 0 || before.size <= 0 || before.size > MAX_SQLITE_BYTES) fail("LEGACY_ADMISSION_SQLITE_UNSAFE");
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await file.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size || before.mtimeMs !== opened.mtimeMs) fail("LEGACY_ADMISSION_SQLITE_CHANGED");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (!bytesRead) fail("LEGACY_ADMISSION_SQLITE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) fail("LEGACY_ADMISSION_SQLITE_CHANGED");
    return { sha256: hash.digest("hex"), stat: opened };
  } catch (error) {
    if (error instanceof PostgresLegacyAdmissionTransferError) throw error;
    fail("LEGACY_ADMISSION_SQLITE_UNAVAILABLE");
  } finally { await file?.close().catch(() => {}); }
}

export async function createSealedSqliteLegacyAdmissionSource({ path, expectedSha256 } = {}) {
  if (!SHA256.test(expectedSha256 ?? "")) fail("LEGACY_ADMISSION_SQLITE_SHA256_REQUIRED");
  const initial = await fileFingerprint(path);
  if (initial.sha256 !== expectedSha256) fail("LEGACY_ADMISSION_SQLITE_SHA256_MISMATCH");
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    database.exec("PRAGMA query_only=ON");
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") fail("LEGACY_ADMISSION_SQLITE_INTEGRITY_FAILED");
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) fail("LEGACY_ADMISSION_SOURCE_PARENT_MISSING");
    const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    const requiredSourceTables = [
      ...SOURCE_TABLES.map((spec) => spec.name), TRANSIENT_REQUEST_TABLE,
      "typed_telemetry_records", "typed_telemetry_chunks", "typed_telemetry_manifests",
      "telemetry_v11_day_manifests", "telemetry_v11_chunks", "telemetry_v11_records",
    ];
    if (requiredSourceTables.some((name) => !names.has(name))) fail("LEGACY_ADMISSION_SOURCE_TABLE_MISSING");
  } catch (error) {
    database?.close();
    if (error instanceof PostgresLegacyAdmissionTransferError) throw error;
    fail("LEGACY_ADMISSION_SQLITE_INVALID");
  }
  const prepared = new Map();
  const snapshot = Object.freeze({ kind: "sealed-sqlite-rehearsal", snapshotId: `sha256:${expectedSha256}`, artifactSha256: expectedSha256, immutable: true });
  let closed = false;
  const source = Object.freeze({
    snapshot,
    async verifySnapshot() {
      if (closed) fail("LEGACY_ADMISSION_SQLITE_CLOSED");
      const actual = await fileFingerprint(path);
      if (actual.sha256 !== expectedSha256 || actual.stat.dev !== initial.stat.dev || actual.stat.ino !== initial.stat.ino) fail("LEGACY_ADMISSION_SOURCE_CHANGED");
      return { snapshotId: snapshot.snapshotId, artifactSha256: expectedSha256 };
    },
    async assertSourceReady() {
      if (closed) fail("LEGACY_ADMISSION_SQLITE_CLOSED");
      let count;
      try { count = database.prepare(`SELECT count(*) AS n FROM "${TRANSIENT_REQUEST_TABLE}"`).get()?.n; }
      catch { fail("LEGACY_ADMISSION_SOURCE_TABLE_MISSING"); }
      if (Number(count) !== 0) fail("LEGACY_ADMISSION_PENDING_AUTHORITY_REQUESTS");
      const scalar = (sql) => Number(database.prepare(sql).get()?.n ?? 0);
      if (scalar(`SELECT count(*) AS n FROM typed_v1_chunk_allocations allocation
        LEFT JOIN telemetry_v1_chunks chunk ON chunk.id=allocation.chunk_id
        WHERE chunk.id IS NULL OR chunk.record_count!=allocation.record_count`) > 0
        || scalar(`SELECT count(*) AS n FROM typed_v11_chunk_allocations allocation
          LEFT JOIN telemetry_v11_chunks chunk ON chunk.id=allocation.chunk_id
          WHERE chunk.id IS NULL OR chunk.record_count!=allocation.record_count`) > 0) {
        fail("LEGACY_ADMISSION_SOURCE_HEADER_INCOMPLETE");
      }
      if (scalar(`SELECT count(*) AS n FROM typed_telemetry_records record
        WHERE record.format=10 AND NOT EXISTS (
          SELECT 1 FROM typed_v1_record_admissions admission WHERE admission.typed_record_id=record.id
        )`) > 0
        || scalar(`SELECT count(*) AS n FROM typed_v1_record_admissions admission
          JOIN typed_telemetry_records record ON record.id=admission.typed_record_id WHERE record.format!=10`) > 0) {
        fail("LEGACY_ADMISSION_SOURCE_PROOF_INCOMPLETE");
      }
      if (scalar(`SELECT count(*) AS n FROM typed_v11_record_proofs proof
        LEFT JOIN typed_v11_manifest_memberships membership ON membership.typed_manifest_id=proof.manifest_key
        WHERE membership.typed_manifest_id IS NULL`) > 0
        || scalar(`SELECT count(*) AS n FROM typed_telemetry_records record
          WHERE record.format=11 AND NOT EXISTS (
            SELECT 1 FROM typed_v11_manifest_memberships membership
             WHERE membership.typed_manifest_id=record.manifest_id
          )`) > 0) {
        fail("LEGACY_ADMISSION_SOURCE_PARENT_MISSING");
      }
      if (scalar(`SELECT count(*) AS n FROM telemetry_v11_day_manifests manifest
        WHERE (EXISTS (SELECT 1 FROM typed_v11_manifest_memberships membership WHERE membership.manifest_id=manifest.id)
          OR EXISTS (SELECT 1 FROM typed_v11_manifest_memberships membership
            JOIN typed_v11_record_proofs proof ON proof.manifest_key=membership.typed_manifest_id
            WHERE membership.manifest_id=manifest.id))
          AND (manifest.state!='ready' OR manifest.expected_chunk_count!=(
            SELECT count(*) FROM telemetry_v11_chunks chunk WHERE chunk.manifest_id=manifest.id
          ))`) > 0) {
        fail("LEGACY_ADMISSION_STAGED_SOURCE_UNQUALIFIED");
      }
      if (scalar(`SELECT count(*) AS n FROM typed_telemetry_records record
        JOIN typed_v11_manifest_memberships membership ON membership.typed_manifest_id=record.manifest_id
        JOIN telemetry_v11_day_manifests manifest ON manifest.id=membership.manifest_id AND manifest.state='ready'
        WHERE record.format=11 AND NOT EXISTS (
          SELECT 1 FROM typed_v11_record_proofs proof WHERE proof.typed_record_id=record.id
        )`) > 0) {
        fail("LEGACY_ADMISSION_SOURCE_PROOF_INCOMPLETE");
      }
      return Object.freeze({ pendingAuthorityRequests: 0 });
    },
    async listPage({ table: name, after = null, limit } = {}) {
      if (closed) fail("LEGACY_ADMISSION_SQLITE_CLOSED");
      const spec = TABLE_BY_NAME.get(name);
      if (!spec || !Number.isInteger(limit) || limit < 1 || limit > POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE) fail("LEGACY_ADMISSION_SOURCE_PAGE_INVALID");
      const cacheKey = `${name}:${after === null ? "first" : "cursor"}`;
      let statement = prepared.get(cacheKey);
      if (!statement) {
        const columns = spec.columns.map((column) => `"${column}"`).join(",");
        const key = spec.primaryKey[0];
        statement = database.prepare(after === null
          ? `SELECT ${columns} FROM "${name}" ORDER BY "${key}" LIMIT ?`
          : `SELECT ${columns} FROM "${name}" WHERE "${key}" > ? ORDER BY "${key}" LIMIT ?`);
        statement.setReadBigInts(true);
        prepared.set(cacheKey, statement);
      }
      try {
        const rows = after === null ? statement.all(BigInt(limit)) : statement.all(after[0], BigInt(limit));
        return Object.freeze({ rows: Object.freeze(rows) });
      }
      catch { fail("LEGACY_ADMISSION_SQLITE_READ_FAILED"); }
    },
    close() { if (closed) return; closed = true; prepared.clear(); database.close(); },
  });
  TRUSTED_SOURCES.add(source);
  return source;
}

async function scanTargetRows(pool, schema, spec, keys) {
  if (keys.length === 0) return [];
  const key = spec.primaryKey[0];
  const values = keys.map((value, index) => `$${index + 1}`).join(",");
  const result = await pool.query(`SELECT ${spec.columns.map((column) => `"${column}"`).join(",")} FROM ${qtable(schema, spec.targetTable ?? spec.name)} WHERE "${key}" IN (${values})`, keys);
  return result.rows;
}

function equalRow(spec, expected, raw) {
  const actual = normalizeRow(spec, raw);
  return spec.columns.every((column) => Buffer.isBuffer(expected[column])
    ? Buffer.isBuffer(actual[column]) && expected[column].equals(actual[column])
    : expected[column] === actual[column]);
}

function sameCounts(actual, expected) {
  if (typeof actual === "string") {
    try { actual = JSON.parse(actual); } catch { return false; }
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return expectedKeys.every((key) => {
    const left = actual[key]; const right = expected[key];
    if (!(typeof left === "number" && Number.isSafeInteger(left) && left >= 0)
        && !(typeof left === "string" && /^(0|[1-9][0-9]*)$/u.test(left))) return false;
    return BigInt(left) === BigInt(right);
  });
}

async function assertPostgres17(pool, schema) {
  const result = await pool.query("SELECT current_setting('server_version_num')::integer AS version, to_regnamespace($1) AS target", [schema]);
  const version = Number(result.rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < 170000 || version >= 180000 || !result.rows[0]?.target) fail("LEGACY_ADMISSION_POSTGRES17_REQUIRED");
  return version;
}

async function assertBaseReceipts(pool, schema, v1Namespace, v11Namespace) {
  const result = await pool.query(`SELECT source_namespace,source_format,generation FROM ${qtable(schema, "typed_telemetry_source_family_receipts")}
    WHERE (source_namespace=$1 AND source_format=10) OR (source_namespace=$2 AND source_format=11) ORDER BY source_format`, [v1Namespace, v11Namespace]);
  const byFormat = new Map(result.rows.map((row) => [Number(row.source_format), row]));
  const v1 = byFormat.get(10); const v11 = byFormat.get(11);
  if (!v1 || !v11 || v1.source_namespace !== v1Namespace || v11.source_namespace !== v11Namespace
      || !Number.isSafeInteger(Number(v1.generation)) || Number(v1.generation) < 1
      || !Number.isSafeInteger(Number(v11.generation)) || Number(v11.generation) < 1) fail("LEGACY_ADMISSION_BASE_RECEIPT_REQUIRED");
  return Object.freeze({ v1: Number(v1.generation), v11: Number(v11.generation) });
}

async function verifyBaseStagingEvidence({ pool, targetSchema, snapshot, state, controlSchema, transferId } = {}) {
  if (snapshot.kind !== "sealed-sqlite-rehearsal" || !SHA256.test(snapshot.artifactSha256 ?? "")
      || !targetSchema.startsWith(POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX)) {
    fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_REQUIRED");
  }
  if (typeof controlSchema !== "string" || !controlSchema.startsWith("typed_legacy_transfer_rehearsal_")
      || controlSchema.length < "typed_legacy_transfer_rehearsal_".length + 8
      || typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) {
    fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_REQUIRED");
  }
  const control = qschema(controlSchema);
  let run;
  let checkpoints;
  let evidence;
  try {
    const result = await pool.query(`SELECT schema_version,target_schema,source_snapshot_id,source_snapshot_kind,
        source_artifact_sha256,source_manifest_sha256,status,target_manifest_sha256
      FROM ${control}."${POSTGRES_TYPED_LEGACY_TRANSFER_RUN_TABLE}" WHERE transfer_id=$1`, [transferId]);
    run = result.rows[0];
    checkpoints = await pool.query(`SELECT table_name,complete FROM ${control}."${POSTGRES_TYPED_LEGACY_TRANSFER_CHECKPOINT_TABLE}"
      WHERE transfer_id=$1 ORDER BY table_name`, [transferId]);
    evidence = await pool.query(`SELECT target_schema,source_snapshot_id,source_artifact_sha256,source_manifest_sha256,
        target_manifest_sha256,source_format,source_namespace,source_row_count::text AS source_row_count,
        membership_row_count::text AS membership_row_count,membership_table_sha256,records_table_sha256,
        family_evidence_sha256 FROM ${control}."${POSTGRES_TYPED_LEGACY_STAGING_FAMILY_EVIDENCE_TABLE}"
      WHERE transfer_id=$1 ORDER BY source_format,source_namespace`, [transferId]);
  } catch {
    fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_REQUIRED");
  }
  if (!run || run.schema_version !== POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA
      || run.target_schema !== targetSchema || run.source_snapshot_id !== snapshot.snapshotId
      || run.source_snapshot_kind !== "sealed-sqlite-rehearsal"
      || run.source_artifact_sha256 !== snapshot.artifactSha256 || run.status !== "complete"
      || !SHA256.test(run.source_manifest_sha256 ?? "") || !SHA256.test(run.target_manifest_sha256 ?? "")
      || checkpoints.rows.length !== POSTGRES_TYPED_LEGACY_TRANSFER_TABLES.length
      || POSTGRES_TYPED_LEGACY_TRANSFER_TABLES.some(name =>
        !checkpoints.rows.some(row => row.table_name === name && row.complete === true))
      || evidence.rows.length !== 2) {
    fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_REQUIRED");
  }
  const expectedNamespaces = new Map([
    [10, state.typed_v1_admission_state.source_namespace],
    [11, state.typed_v11_admission_state.source_namespace],
  ]);
  for (const row of evidence.rows) {
    const sourceFormat = Number(row.source_format);
    if (expectedNamespaces.get(sourceFormat) !== row.source_namespace
        || row.target_schema !== targetSchema || row.source_snapshot_id !== run.source_snapshot_id
        || row.source_artifact_sha256 !== run.source_artifact_sha256
        || row.source_manifest_sha256 !== run.source_manifest_sha256
        || row.target_manifest_sha256 !== run.target_manifest_sha256) {
      fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_MISMATCH");
    }
    let expectedDigest;
    try {
      expectedDigest = typedLegacyStagingFamilyEvidenceSha256({
        sourceSnapshotId: row.source_snapshot_id,
        sourceArtifactSha256: row.source_artifact_sha256,
        sourceManifestSha256: row.source_manifest_sha256,
        targetManifestSha256: row.target_manifest_sha256,
        sourceFormat,
        sourceNamespace: row.source_namespace,
        sourceRowCount: row.source_row_count,
        membershipRowCount: row.membership_row_count,
        membershipTableSha256: row.membership_table_sha256,
        recordsTableSha256: row.records_table_sha256,
      });
    } catch { fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_MISMATCH"); }
    if (expectedDigest !== row.family_evidence_sha256) fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_MISMATCH");
    const parity = await pool.query(`SELECT count(DISTINCT (membership.namespace_id,membership.source_format,membership.owner_id))::text AS memberships,
        count(record.id)::text AS records
      FROM ${qtable(targetSchema, "typed_telemetry_owner_memberships")} membership
      LEFT JOIN ${qtable(targetSchema, "typed_telemetry_records")} record
        ON record.namespace_id=membership.namespace_id AND record.format=membership.source_format
       AND record.owner_id=membership.owner_id
      WHERE membership.source_format=$1 AND membership.source_namespace=$2`, [sourceFormat, row.source_namespace]);
    if (parity.rows[0]?.memberships !== row.membership_row_count
        || parity.rows[0]?.records !== row.source_row_count) {
      fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_MISMATCH");
    }
  }
  for (const sourceFormat of [10, 11]) {
    if (!evidence.rows.some(row => Number(row.source_format) === sourceFormat
        && row.source_namespace === expectedNamespaces.get(sourceFormat))) {
      fail("LEGACY_ADMISSION_BASE_STAGING_RECEIPT_REQUIRED");
    }
  }
  const proofSha256 = createHash("sha256").update(JSON.stringify(evidence.rows.map(row => row.family_evidence_sha256))).digest("hex");
  return Object.freeze({
    baseControlSchema: controlSchema,
    baseTransferId: transferId,
    sourceSnapshotId: run.source_snapshot_id,
    sourceArtifactSha256: run.source_artifact_sha256,
    sourceManifestSha256: run.source_manifest_sha256,
    targetManifestSha256: run.target_manifest_sha256,
    v1SourceNamespace: expectedNamespaces.get(10),
    v11SourceNamespace: expectedNamespaces.get(11),
    familyEvidenceSha256: proofSha256,
  });
}

async function ensureAdmissionStagingReceiptTable(pool, controlSchema) {
  const control = qschema(controlSchema);
  const relation = `${control}."${STAGING_RECEIPT_TABLE}"`;
  const guard = "_legacy_admission_staging_receipt_guard";
  const guardFunction = `${control}."${guard}_fn"`;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${relation} (
      transfer_id text PRIMARY KEY REFERENCES ${control}."${RUN_TABLE}"(transfer_id) ON DELETE CASCADE,
      target_schema text NOT NULL,
      base_control_schema text NOT NULL,
      base_transfer_id text NOT NULL,
      source_snapshot_id text NOT NULL,
      source_snapshot_kind text NOT NULL CHECK(source_snapshot_kind IN ('sealed-sqlite-rehearsal','synthetic-d1-fixture')),
      source_snapshot_sha256 text NOT NULL CHECK(source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
      base_source_manifest_sha256 text NOT NULL CHECK(base_source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      base_target_manifest_sha256 text NOT NULL CHECK(base_target_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      v1_source_namespace text NOT NULL,
      v11_source_namespace text NOT NULL,
      family_evidence_sha256 text NOT NULL CHECK(family_evidence_sha256 ~ '^[0-9a-f]{64}$'),
      header_manifest_sha256 text NOT NULL CHECK(header_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      header_table_row_counts jsonb NOT NULL CHECK(jsonb_typeof(header_table_row_counts)='object'),
      lineage_manifest_sha256 text NOT NULL CHECK(lineage_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      table_row_counts jsonb NOT NULL CHECK(jsonb_typeof(table_row_counts)='object'),
      completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await pool.query(`CREATE OR REPLACE FUNCTION ${guardFunction}() RETURNS trigger
      LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
      BEGIN RAISE EXCEPTION 'legacy_admission_staging_receipt_immutable' USING ERRCODE='P1005'; END; $$`);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${controlSchema}.${STAGING_RECEIPT_TABLE}'::regclass
        AND tgname='${guard}') THEN
        CREATE TRIGGER ${guard} BEFORE UPDATE OR DELETE ON ${relation}
          FOR EACH ROW EXECUTE FUNCTION ${guardFunction}();
      END IF;
    END $$`);
  } catch { fail("LEGACY_ADMISSION_STAGING_RECEIPT_INVALID"); }
}

async function persistAdmissionStagingReceipt({ pool, controlSchema, transferId, targetSchema, baseProof, snapshot, sourceSnapshotSha256,
  headerManifestSha256, headerTableRowCounts, lineageManifestSha256, tableRowCounts } = {}) {
  await ensureAdmissionStagingReceiptTable(pool, controlSchema);
  const relation = `${qschema(controlSchema)}."${STAGING_RECEIPT_TABLE}"`;
  const inserted = await pool.query(`INSERT INTO ${relation}(
      transfer_id,target_schema,base_control_schema,base_transfer_id,source_snapshot_id,source_snapshot_sha256,
      base_source_manifest_sha256,base_target_manifest_sha256,v1_source_namespace,v11_source_namespace,
      family_evidence_sha256,source_snapshot_kind,header_manifest_sha256,header_table_row_counts,
      lineage_manifest_sha256,table_row_counts
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb)
    ON CONFLICT(transfer_id) DO NOTHING`, [transferId, targetSchema, baseProof.baseControlSchema,
    baseProof.baseTransferId, baseProof.sourceSnapshotId, sourceSnapshotSha256,
    baseProof.sourceManifestSha256, baseProof.targetManifestSha256, baseProof.v1SourceNamespace,
    baseProof.v11SourceNamespace, baseProof.familyEvidenceSha256, snapshot.kind, headerManifestSha256,
    JSON.stringify(headerTableRowCounts), lineageManifestSha256, JSON.stringify(tableRowCounts)]);
  if (inserted.rowCount === 0) {
    const current = await pool.query(`SELECT target_schema,base_control_schema,base_transfer_id,source_snapshot_id,
        source_snapshot_sha256,base_source_manifest_sha256,base_target_manifest_sha256,v1_source_namespace,
        v11_source_namespace,family_evidence_sha256,source_snapshot_kind,header_manifest_sha256,header_table_row_counts,
        lineage_manifest_sha256,table_row_counts
      FROM ${relation} WHERE transfer_id=$1`, [transferId]);
    const row = current.rows[0];
    if (!row || row.target_schema !== targetSchema || row.base_control_schema !== baseProof.baseControlSchema
        || row.base_transfer_id !== baseProof.baseTransferId || row.source_snapshot_id !== baseProof.sourceSnapshotId
        || row.source_snapshot_sha256 !== sourceSnapshotSha256
        || row.base_source_manifest_sha256 !== baseProof.sourceManifestSha256
        || row.base_target_manifest_sha256 !== baseProof.targetManifestSha256
        || row.v1_source_namespace !== baseProof.v1SourceNamespace
        || row.v11_source_namespace !== baseProof.v11SourceNamespace
        || row.family_evidence_sha256 !== baseProof.familyEvidenceSha256
        || row.source_snapshot_kind !== snapshot.kind
        || row.header_manifest_sha256 !== headerManifestSha256
        || !sameCounts(row.header_table_row_counts, headerTableRowCounts)
        || row.lineage_manifest_sha256 !== lineageManifestSha256
        || !sameCounts(row.table_row_counts, tableRowCounts)) fail("LEGACY_ADMISSION_STAGING_RECEIPT_MISMATCH");
  }
}

function headerManifest(sourceManifest) {
  const tables = Object.create(null);
  for (const spec of HEADER_TABLES) {
    const item = sourceManifest.tables[spec.name];
    if (!item || !Number.isSafeInteger(item.rows) || item.rows < 0 || !SHA256.test(item.sha256 ?? "")) {
      fail("LEGACY_ADMISSION_HEADER_MANIFEST_INVALID");
    }
    tables[spec.name] = Object.freeze({ rows: item.rows, sha256: item.sha256 });
  }
  return Object.freeze({
    tables: Object.freeze(tables),
    rowCounts: Object.freeze(Object.fromEntries(Object.entries(tables).map(([name, item]) => [name, item.rows]))),
    sha256: createHash("sha256").update(JSON.stringify(tables)).digest("hex"),
  });
}

async function persistHeaderStageReceipt({ pool, controlSchema, transferId, targetSchema, snapshot, sourceManifest,
  state, proof } = {}) {
  const control = qschema(controlSchema);
  const table = `${control}."_legacy_admission_header_receipts_v1"`;
  const functionName = `${control}."_legacy_admission_header_receipt_guard_fn"`;
  const triggerName = "_legacy_admission_header_receipt_guard";
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
    transfer_id text PRIMARY KEY REFERENCES ${control}."${RUN_TABLE}"(transfer_id) ON DELETE CASCADE,
    target_schema text NOT NULL,
    source_snapshot_id text NOT NULL,
    source_snapshot_kind text NOT NULL CHECK(source_snapshot_kind IN ('sealed-sqlite-rehearsal','synthetic-d1-fixture')),
    source_snapshot_sha256 text NOT NULL CHECK(source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    source_manifest_sha256 text NOT NULL CHECK(source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    v1_source_namespace text NOT NULL,
    v11_source_namespace text NOT NULL,
    header_manifest_sha256 text NOT NULL CHECK(header_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    header_table_row_counts jsonb NOT NULL CHECK(jsonb_typeof(header_table_row_counts)='object'),
    completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  await pool.query(`CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
    BEGIN RAISE EXCEPTION 'legacy_admission_header_receipt_immutable' USING ERRCODE='P1005'; END; $$`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${controlSchema}._legacy_admission_header_receipts_v1'::regclass
      AND tgname='${triggerName}') THEN
      CREATE TRIGGER ${triggerName} BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${functionName}();
    END IF;
  END $$`);
  const values = [transferId, targetSchema, snapshot.snapshotId, snapshot.kind,
    snapshot.artifactSha256 ?? sourceManifest.sha256, sourceManifest.sha256,
    state.typed_v1_admission_state.source_namespace, state.typed_v11_admission_state.source_namespace,
    proof.sha256, JSON.stringify(proof.rowCounts)];
  const inserted = await pool.query(`INSERT INTO ${table}(
      transfer_id,target_schema,source_snapshot_id,source_snapshot_kind,source_snapshot_sha256,source_manifest_sha256,
      v1_source_namespace,v11_source_namespace,header_manifest_sha256,header_table_row_counts
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(transfer_id) DO NOTHING`, values);
  if (inserted.rowCount !== 0 && inserted.rowCount !== 1) fail("LEGACY_ADMISSION_HEADER_RECEIPT_MISMATCH");
  const current = await pool.query(`SELECT target_schema,source_snapshot_id,source_snapshot_kind,source_snapshot_sha256,
      source_manifest_sha256,v1_source_namespace,v11_source_namespace,header_manifest_sha256,header_table_row_counts
    FROM ${table} WHERE transfer_id=$1`, [transferId]);
  const row = current.rows[0];
  if (!row || row.target_schema !== targetSchema || row.source_snapshot_id !== snapshot.snapshotId
      || row.source_snapshot_kind !== snapshot.kind
      || row.source_snapshot_sha256 !== (snapshot.artifactSha256 ?? sourceManifest.sha256)
      || row.source_manifest_sha256 !== sourceManifest.sha256
      || row.v1_source_namespace !== state.typed_v1_admission_state.source_namespace
      || row.v11_source_namespace !== state.typed_v11_admission_state.source_namespace
      || row.header_manifest_sha256 !== proof.sha256 || !sameCounts(row.header_table_row_counts, proof.rowCounts)) {
    fail("LEGACY_ADMISSION_HEADER_RECEIPT_MISMATCH");
  }
}

async function ensureControlTables(pool, controlSchema) {
  const ns = qschema(controlSchema);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${ns}."${RUN_TABLE}" (
    transfer_id text PRIMARY KEY CHECK(length(transfer_id) BETWEEN 1 AND 128),
    source_snapshot_id text NOT NULL,
    source_snapshot_sha256 text NOT NULL CHECK(source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    source_manifest_sha256 text NOT NULL CHECK(source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    v1_source_namespace text NOT NULL, v11_source_namespace text NOT NULL,
    status text NOT NULL CHECK(status IN ('running','complete')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${ns}."${CHECKPOINT_TABLE}" (
    transfer_id text NOT NULL REFERENCES ${ns}."${RUN_TABLE}"(transfer_id) ON DELETE CASCADE,
    table_name text NOT NULL, last_key jsonb, row_count bigint NOT NULL CHECK(row_count>=0),
    page_count bigint NOT NULL CHECK(page_count>=0), complete boolean NOT NULL,
    PRIMARY KEY(transfer_id,table_name)
  )`);
  const immutableFunction = `${ns}."_legacy_header_stage_immutable_fn"`;
  await pool.query(`CREATE OR REPLACE FUNCTION ${immutableFunction}() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
    BEGIN RAISE EXCEPTION 'legacy_header_stage_immutable' USING ERRCODE='P1005'; END; $$`);
  for (const spec of HEADER_TABLES) {
    const columns = spec.columns.map((column, index) => {
      const type = spec.types[index];
      const sqlType = type === "i16" ? "smallint" : type === "i32" ? "integer"
        : type === "i64" ? "bigint" : type === "bytes" ? "bytea" : "text";
      return `"${column}" ${sqlType}${spec.primaryKey.includes(column) ? " NOT NULL" : ""}`;
    });
    const primaryKey = spec.primaryKey.map((column) => `"${column}"`).join(",");
    const relation = `${ns}."${spec.targetTable}"`;
    const trigger = `${spec.targetTable}_immutable`;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${relation} (${columns.join(",")}, PRIMARY KEY(${primaryKey}))`);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='${controlSchema}.${spec.targetTable}'::regclass AND tgname='${trigger}') THEN
        CREATE TRIGGER ${trigger} BEFORE UPDATE OR DELETE ON ${relation}
          FOR EACH ROW EXECUTE FUNCTION ${immutableFunction}();
      END IF;
    END $$`);
  }
}

function insertStatement(schema, spec, rows) {
  const columns = spec.columns.map((column) => `"${column}"`).join(",");
  const params = [];
  const groups = rows.map((row) => `(${spec.columns.map((column) => { params.push(row[column]); return `$${params.length}`; }).join(",")})`);
  return { sql: `INSERT INTO ${qtable(schema, spec.targetTable ?? spec.name)} (${columns}) VALUES ${groups.join(",")} ON CONFLICT (${spec.primaryKey.map((key) => `"${key}"`).join(",")}) DO NOTHING`, params };
}

async function getRun(pool, controlSchema, transferId, snapshot, sourceManifest, v1Namespace, v11Namespace) {
  const relation = qtable(controlSchema, RUN_TABLE);
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const current = await client.query(`SELECT * FROM ${relation} WHERE transfer_id=$1 FOR UPDATE`, [transferId]);
    if (current.rowCount === 0) {
      await client.query(`INSERT INTO ${relation}(transfer_id,source_snapshot_id,source_snapshot_sha256,source_manifest_sha256,v1_source_namespace,v11_source_namespace,status)
        VALUES($1,$2,$3,$4,$5,$6,'running')`, [transferId, snapshot.snapshotId, snapshot.artifactSha256 ?? sourceManifest.sha256, sourceManifest.sha256, v1Namespace, v11Namespace]);
    } else {
      const row = current.rows[0];
      if (row.source_snapshot_id !== snapshot.snapshotId || row.source_manifest_sha256 !== sourceManifest.sha256
          || row.v1_source_namespace !== v1Namespace || row.v11_source_namespace !== v11Namespace) fail("LEGACY_ADMISSION_TRANSFER_ID_REUSED");
    }
    await client.query("COMMIT");
    return current.rows[0] ?? null;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

async function copyTable({ source, pool, targetSchema, controlSchema, transferId, spec, pageSize }) {
  const destinationSchema = spec.targetTable ? controlSchema : targetSchema;
  const checkpoint = qtable(controlSchema, CHECKPOINT_TABLE);
  const prior = await pool.query(`SELECT last_key,row_count,page_count,complete FROM ${checkpoint} WHERE transfer_id=$1 AND table_name=$2`, [transferId, spec.name]);
  if (prior.rows[0]?.complete) return { pages: 0, resumed: true };
  let after = prior.rows[0]?.last_key ?? null;
  let rowCount = Number(prior.rows[0]?.row_count ?? 0);
  let pageCount = Number(prior.rows[0]?.page_count ?? 0);
  let pages = 0;
  for (;;) {
    const page = await source.listPage({ table: spec.name, after, limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("LEGACY_ADMISSION_SOURCE_PAGE_INVALID");
    const rows = page.rows.map((raw) => normalizeRow(spec, raw));
    for (let index = 1; index < rows.length; index += 1) if (compareKey(spec, rows[index - 1], rows[index]) >= 0) fail("LEGACY_ADMISSION_SOURCE_ORDER_INVALID");
    if (rows.length > 0) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const statement = insertStatement(destinationSchema, spec, rows);
        await client.query(statement.sql, statement.params);
        const keys = rows.map((row) => row[spec.primaryKey[0]]);
        const stored = await scanTargetRows(client, destinationSchema, spec, keys);
        const byKey = new Map(stored.map((raw) => [String(raw[spec.primaryKey[0]]), raw]));
        if (stored.length !== rows.length || rows.some((row) => !equalRow(spec, row, byKey.get(String(row[spec.primaryKey[0]]))))) fail("LEGACY_ADMISSION_DESTINATION_ROW_MISMATCH");
        rowCount += rows.length; pageCount += 1; pages += 1;
        after = cursor(spec, rows.at(-1));
        await client.query(`INSERT INTO ${checkpoint}(transfer_id,table_name,last_key,row_count,page_count,complete)
          VALUES($1,$2,$3::jsonb,$4,$5,false) ON CONFLICT(transfer_id,table_name) DO UPDATE SET
          last_key=EXCLUDED.last_key,row_count=EXCLUDED.row_count,page_count=EXCLUDED.page_count,complete=false`,
        [transferId, spec.name, JSON.stringify(after), rowCount, pageCount]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
    }
    if (rows.length < pageSize) {
      await pool.query(`INSERT INTO ${checkpoint}(transfer_id,table_name,last_key,row_count,page_count,complete)
        VALUES($1,$2,$3::jsonb,$4,$5,true) ON CONFLICT(transfer_id,table_name) DO UPDATE SET
        last_key=EXCLUDED.last_key,row_count=EXCLUDED.row_count,page_count=EXCLUDED.page_count,complete=true`,
      [transferId, spec.name, after === null ? null : JSON.stringify(after), rowCount, pageCount]);
      return { pages, resumed: prior.rowCount > 0 };
    }
  }
}

async function verifyAllRows({ source, pool, schema, controlSchema = schema, pageSize, specs = SOURCE_TABLES }) {
  for (const spec of specs) {
    let after = null;
    for (;;) {
      const page = await source.listPage({ table: spec.name, after, limit: pageSize });
      const rows = page.rows.map((raw) => normalizeRow(spec, raw));
      if (rows.length === 0) break;
      const destinationSchema = spec.targetTable ? controlSchema : schema;
      const stored = await scanTargetRows(pool, destinationSchema, spec, rows.map((row) => row[spec.primaryKey[0]]));
      const byKey = new Map(stored.map((raw) => [String(raw[spec.primaryKey[0]]), raw]));
      if (stored.length !== rows.length || rows.some((row) => !equalRow(spec, row, byKey.get(String(row[spec.primaryKey[0]]))))) fail("LEGACY_ADMISSION_DESTINATION_PARITY_FAILED");
      after = cursor(spec, rows.at(-1));
      if (rows.length < pageSize) break;
    }
  }
}

async function verifyTargetCounts(pool, schema, expected, v1State, v11State) {
  const v1NamespaceId = v1State.namespace_id;
  const v11NamespaceId = v11State.namespace_id;
  const counts = new Map([
    ["typed_v1_admission_state", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v1_admission_state")} WHERE id=1 AND source_namespace=$1`,
      values: [v1State.source_namespace],
    }],
    ["typed_v11_admission_state", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v11_admission_state")} WHERE id=1 AND source_namespace=$1`,
      values: [v11State.source_namespace],
    }],
    ["typed_v1_chunk_allocations", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v1_chunk_allocations")} WHERE namespace_id=$1`,
      values: [v1NamespaceId],
    }],
    ["typed_v11_chunk_allocations", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v11_chunk_allocations")} WHERE namespace_id=$1`,
      values: [v11NamespaceId],
    }],
    ["typed_v1_record_admissions", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v1_record_admissions")} admission
        JOIN ${qtable(schema, "typed_telemetry_records")} record ON record.id=admission.typed_record_id
        JOIN ${qtable(schema, "typed_telemetry_owner_memberships")} membership
          ON membership.namespace_id=record.namespace_id AND membership.source_format=10
         AND membership.owner_id=record.owner_id AND membership.source_namespace=$2
        WHERE record.namespace_id=$1 AND record.format=10`,
      values: [v1NamespaceId, v1State.source_namespace],
    }],
    ["typed_v1_preservation_proofs", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v1_preservation_proofs")} proof
        JOIN ${qtable(schema, "telemetry_v1_records")} source_record ON source_record.id=proof.source_row_id
        JOIN ${qtable(schema, "typed_telemetry_records")} record
          ON record.format=10 AND record.source_row_id=source_record.id
        JOIN ${qtable(schema, "typed_telemetry_owner_memberships")} membership
          ON membership.namespace_id=record.namespace_id AND membership.source_format=10
         AND membership.owner_id=record.owner_id AND membership.source_namespace=$2
        WHERE record.namespace_id=$1`,
      values: [v1NamespaceId, v1State.source_namespace],
    }],
    ["typed_v11_manifest_memberships", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v11_manifest_memberships")} membership_row
        JOIN ${qtable(schema, "typed_telemetry_manifests")} manifest ON manifest.id=membership_row.typed_manifest_id
        JOIN ${qtable(schema, "typed_telemetry_owner_memberships")} owner_membership
          ON owner_membership.namespace_id=manifest.namespace_id AND owner_membership.source_format=11
         AND owner_membership.owner_id=manifest.owner_id AND owner_membership.source_namespace=$2
        WHERE manifest.namespace_id=$1`,
      values: [v11NamespaceId, v11State.source_namespace],
    }],
    ["typed_v11_record_proofs", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v11_record_proofs")} proof
        JOIN ${qtable(schema, "typed_telemetry_records")} record ON record.id=proof.typed_record_id
        JOIN ${qtable(schema, "typed_telemetry_owner_memberships")} membership
          ON membership.namespace_id=record.namespace_id AND membership.source_format=11
         AND membership.owner_id=record.owner_id AND membership.source_namespace=$2
        WHERE record.namespace_id=$1 AND record.format=11`,
      values: [v11NamespaceId, v11State.source_namespace],
    }],
    ["typed_v1_event_sources", {
      sql: `SELECT count(*)::text AS n FROM ${qtable(schema, "typed_v1_event_sources")} WHERE source_namespace=$1`,
      values: [v1State.source_namespace],
    }],
    ["storage_v11_event_sources", {
      sql: `SELECT count(DISTINCT event.event_digest)::text AS n FROM ${qtable(schema, "storage_v11_event_sources")} event
        JOIN ${qtable(schema, "typed_telemetry_owner_memberships")} membership
          ON membership.participant_id=event.participant_id AND membership.namespace_id=$1
         AND membership.source_format=11 AND membership.source_namespace=$2`,
      values: [v11NamespaceId, v11State.source_namespace],
    }],
  ]);
  if (expected[TRANSIENT_REQUEST_TABLE] !== 0) fail("LEGACY_ADMISSION_PENDING_AUTHORITY_REQUESTS");
  for (const [name, query] of counts) {
    const actual = (await pool.query(query.sql, query.values)).rows[0]?.n;
    if (actual === undefined || BigInt(actual) !== BigInt(expected[name])) fail("LEGACY_ADMISSION_DESTINATION_PARITY_FAILED");
  }
}

/** Copy both admission/proof/publication families from a sealed D1 snapshot.
 * A successful return is staged import evidence only; this does not qualify or
 * activate the PostgreSQL effective reader. */
export async function runPostgresLegacyAdmissionTransfer({ source, destinationPool, targetSchema: rawTargetSchema,
  controlSchema: rawControlSchema, transferId, pageSize, baseStagingTransfer } = {}) {
  const targetSchema = schemaName(rawTargetSchema);
  const controlSchema = schemaName(rawControlSchema);
  if (!controlSchema.startsWith(CONTROL_PREFIX) || controlSchema.length < CONTROL_PREFIX.length + 8 || controlSchema === targetSchema) fail("LEGACY_ADMISSION_CONTROL_SCHEMA_INVALID");
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("LEGACY_ADMISSION_TRANSFER_ID_INVALID");
  if (!destinationPool || typeof destinationPool.query !== "function" || typeof destinationPool.connect !== "function") fail("LEGACY_ADMISSION_DESTINATION_INVALID");
  const size = validatePageSize(pageSize);
  const snapshot = validSource(source);
  if (typeof source.assertSourceReady !== "function") fail("LEGACY_ADMISSION_SEALED_SOURCE_REQUIRED");
  const before = await source.verifySnapshot();
  if (before?.snapshotId !== snapshot.snapshotId) fail("LEGACY_ADMISSION_SOURCE_CHANGED");
  await source.assertSourceReady();
  const postgresVersion = await assertPostgres17(destinationPool, targetSchema);
  const state = Object.create(null);
  for (const name of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
    const spec = TABLE_BY_NAME.get(name);
    const rows = (await source.listPage({ table: name, after: null, limit: 2 })).rows.map((row) => normalizeRow(spec, row));
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].runtime_contract_version !== 1) fail("LEGACY_ADMISSION_STATE_INVALID");
    state[name] = rows[0];
  }
  if (state.typed_v1_admission_state.source_namespace === state.typed_v11_admission_state.source_namespace) {
    // One D1 source can use one namespace for both formats; this is valid.
  }
  const sourceManifest = await scanSource(source, size);
  const sourceHeaderManifest = headerManifest(sourceManifest);
  const baseProof = baseStagingTransfer === undefined ? null : await verifyBaseStagingEvidence({
    pool: destinationPool,
    targetSchema,
    snapshot,
    state,
    controlSchema: baseStagingTransfer?.controlSchema,
    transferId: baseStagingTransfer?.transferId,
  });
  const baseGenerations = baseProof ? null : await assertBaseReceipts(destinationPool, targetSchema,
    state.typed_v1_admission_state.source_namespace, state.typed_v11_admission_state.source_namespace);
  await source.verifySnapshot();
  const controlNamespace = await destinationPool.query("SELECT to_regnamespace($1) AS namespace", [controlSchema]);
  if (!controlNamespace.rows[0]?.namespace) fail("LEGACY_ADMISSION_CONTROL_SCHEMA_REQUIRED");
  await ensureControlTables(destinationPool, controlSchema);
  const lockClient = await destinationPool.connect();
  let lockAcquired = false;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`legacy-admission:${transferId}`]);
    lockAcquired = true;
    await getRun(destinationPool, controlSchema, transferId, snapshot, sourceManifest,
      state.typed_v1_admission_state.source_namespace, state.typed_v11_admission_state.source_namespace);
    let pages = 0;
    for (const spec of HEADER_TABLES) {
      const copied = await copyTable({ source, pool: destinationPool, targetSchema, controlSchema, transferId, spec, pageSize: size });
      pages += copied.pages;
    }
    await verifyAllRows({ source, pool: destinationPool, schema: targetSchema, controlSchema, pageSize: size, specs: HEADER_TABLES });
    await persistHeaderStageReceipt({ pool: destinationPool, controlSchema, transferId, targetSchema,
      snapshot, sourceManifest, state, proof: sourceHeaderManifest });
    for (const spec of TABLES) {
      const copied = await copyTable({ source, pool: destinationPool, targetSchema, controlSchema, transferId, spec, pageSize: size });
      pages += copied.pages;
    }
    const after = await source.verifySnapshot();
    if (after?.snapshotId !== snapshot.snapshotId) fail("LEGACY_ADMISSION_SOURCE_CHANGED");
    const finalSource = await scanSource(source, size);
    if (finalSource.sha256 !== sourceManifest.sha256) fail("LEGACY_ADMISSION_SOURCE_CHANGED");
    const finalSnapshot = await source.verifySnapshot();
    if (finalSnapshot?.snapshotId !== snapshot.snapshotId) fail("LEGACY_ADMISSION_SOURCE_CHANGED");
    await verifyAllRows({ source, pool: destinationPool, schema: targetSchema, controlSchema, pageSize: size });
    const tableCounts = Object.fromEntries(Object.entries(sourceManifest.tables).map(([name, value]) => [name, value.rows]));
    tableCounts[TRANSIENT_REQUEST_TABLE] = 0;
    await verifyTargetCounts(destinationPool, targetSchema, tableCounts,
      state.typed_v1_admission_state, state.typed_v11_admission_state);
    if (baseProof) {
      await persistAdmissionStagingReceipt({ pool: destinationPool, controlSchema, transferId, targetSchema,
        baseProof, snapshot, sourceSnapshotSha256: snapshot.artifactSha256 ?? sourceManifest.sha256,
        headerManifestSha256: sourceHeaderManifest.sha256,
        headerTableRowCounts: sourceHeaderManifest.rowCounts,
        lineageManifestSha256: sourceManifest.sha256, tableRowCounts });
    } else {
      const receipt = await destinationPool.query(`INSERT INTO ${qtable(targetSchema, "typed_telemetry_admission_transfer_receipts")}
      (transfer_id,v1_source_namespace,v11_source_namespace,v1_base_generation,v11_base_generation,source_snapshot_sha256,lineage_manifest_sha256,table_row_counts)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(transfer_id) DO NOTHING RETURNING transfer_id`,
      [transferId, state.typed_v1_admission_state.source_namespace, state.typed_v11_admission_state.source_namespace,
        baseGenerations.v1, baseGenerations.v11, snapshot.artifactSha256 ?? sourceManifest.sha256,
        sourceManifest.sha256, JSON.stringify(tableCounts)]);
      if (receipt.rowCount === 0) {
        const existing = await destinationPool.query(`SELECT v1_source_namespace,v11_source_namespace,v1_base_generation,v11_base_generation,source_snapshot_sha256,lineage_manifest_sha256,table_row_counts
          FROM ${qtable(targetSchema, "typed_telemetry_admission_transfer_receipts")} WHERE transfer_id=$1`, [transferId]);
        const row = existing.rows[0];
        if (!row || row.v1_source_namespace !== state.typed_v1_admission_state.source_namespace
            || row.v11_source_namespace !== state.typed_v11_admission_state.source_namespace
            || Number(row.v1_base_generation) !== baseGenerations.v1 || Number(row.v11_base_generation) !== baseGenerations.v11
            || row.source_snapshot_sha256 !== (snapshot.artifactSha256 ?? sourceManifest.sha256)
            || row.lineage_manifest_sha256 !== sourceManifest.sha256
            || !sameCounts(row.table_row_counts, tableCounts)) fail("LEGACY_ADMISSION_RECEIPT_MISMATCH");
      }
    }
    await destinationPool.query(`UPDATE ${qtable(controlSchema, RUN_TABLE)} SET status='complete',updated_at=clock_timestamp() WHERE transfer_id=$1`, [transferId]);
    return Object.freeze({ schema: POSTGRES_LEGACY_ADMISSION_TRANSFER_SCHEMA, status: "staged_admission_lineage_transfer_complete", postgresMajor: Math.floor(postgresVersion / 10000), pageSize: size, pagesCommittedThisRun: pages, tableRows: Object.freeze(tableCounts), sourceSnapshotSha256: snapshot.artifactSha256 ?? sourceManifest.sha256, sourceHeaderManifestSha256: sourceHeaderManifest.sha256, sourceHeaderTableRows: sourceHeaderManifest.rowCounts, lineageManifestSha256: sourceManifest.sha256, productionReady: false, readerActivationAuthorized: false, erasureAuthorized: false });
  } finally {
    if (lockAcquired) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`legacy-admission:${transferId}`]).catch(() => {});
    lockClient.release();
  }
}

export const POSTGRES_LEGACY_ADMISSION_TRANSFER_TABLES = Object.freeze(TABLES.map((spec) => spec.name));
export const POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT = Object.freeze(TABLES.map((spec) => Object.freeze({
  name: spec.name,
  columns: spec.columns,
  primaryKey: spec.primaryKey,
  types: spec.types,
})));
export const POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT = Object.freeze(HEADER_TABLES.map((spec) => Object.freeze({
  name: spec.name,
  columns: spec.columns,
  primaryKey: spec.primaryKey,
  types: spec.types,
})));
