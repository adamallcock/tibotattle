import { createHash } from "node:crypto";

export const POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA = "typed-legacy-transfer-rehearsal-v1";
export const POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX = "typed_legacy_transfer_rehearsal_";
export const POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX = "typed_legacy_transfer_rehearsal_target_";
export const POSTGRES_TYPED_LEGACY_DEFAULT_PAGE_SIZE = 200;
export const POSTGRES_TYPED_LEGACY_MAX_PAGE_SIZE = 500;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MIGRATION_VERSION = 30;
const CONTROL_RUN_TABLE = "_typed_legacy_transfer_rehearsal_runs_v1";
const CONTROL_CHECKPOINT_TABLE = "_typed_legacy_transfer_rehearsal_checkpoints_v1";
const encoder = new TextEncoder();

/**
 * D1 keyset source contract. `listPage` returns at most `limit` rows for one
 * canonical table, strictly ordered by that table's primary key. Legacy owner
 * membership rows also carry an `authority` projection used only for a
 * fail-closed source/destination identity check; it is never copied.
 *
 * Only synthetic fixtures are accepted by this implementation. A live D1
 * binding is not a consistent snapshot across independent paged SELECTs. An
 * immutable export is also rejected until a concrete artifact reader and
 * end-to-end snapshot verifier are implemented.
 */
const TABLES = Object.freeze([
  // The dictionary is shared with v1.2, so parity covers every imported source
  // ID while allowing unrelated v1.2-only target values.
  table("typed_telemetry_dictionary", ["id", "value"], ["id"], ["i64", "text"], { comparisonScope: "source-keys" }),
  table("typed_telemetry_namespaces", ["id", "original_id"], ["id"], ["i64", "bytes"]),
  table("typed_telemetry_owners", ["id", "namespace_id", "original_id"], ["id"], ["i64", "i64", "bytes"]),
  table("typed_telemetry_owner_memberships",
    ["namespace_id", "source_format", "owner_id", "participant_id", "source_namespace"],
    ["namespace_id", "source_format", "owner_id"], ["i64", "i16", "i64", "text", "text"]),
  table("typed_telemetry_devices", ["id", "namespace_id", "owner_id", "original_id"], ["id"], ["i64", "i64", "i64", "bytes"]),
  table("typed_telemetry_manifests", ["id", "namespace_id", "owner_id", "device_id", "original_id", "chunk_day"], ["id"], ["i64", "i64", "i64", "i64", "bytes", "i32"]),
  table("typed_telemetry_identifiers", ["id", "namespace_id", "owner_id", "value"], ["id"], ["i64", "i64", "i64", "bytes"]),
  table("typed_telemetry_attributions",
    ["id", "namespace_id", "owner_id", "account_basis", "account_track", "plan_basis", "plan_type_id", "plan_era"],
    ["id"], ["i64", "i64", "i64", "i16", "bytes", "i16", "i64", "bytes"]),
  table("typed_telemetry_quota_dimensions",
    ["id", "namespace_id", "owner_id", "plan_type_id", "plan_variant_id", "attribution_id"],
    ["id"], ["i64", "i64", "i64", "i64", "i64", "i64"]),
  table("typed_telemetry_chunks",
    ["id", "namespace_id", "format", "owner_id", "device_id", "manifest_id", "original_id", "stream", "chunk_day"],
    ["id"], ["i64", "i64", "i16", "i64", "i64", "i64", "bytes", "i16", "i32"]),
  table("typed_telemetry_records",
    ["id", "namespace_id", "format", "source_row_id", "owner_id", "device_id", "chunk_id", "manifest_id", "stream", "occurrence_id", "observed_at_ms", "observed_day", "provider_id", "canonical_digest"],
    ["id"], ["i64", "i64", "i16", "i64", "i64", "i64", "i64", "i64", "i16", "bytes", "i64", "i32", "i64", "bytes"]),
  table("typed_telemetry_usage",
    ["record_id", "stream", "session_id", "model_id", "speed_mode_id", "api_service_tier_id", "surface_id", "billing_surface_id", "reasoning_effort_id", "agent_scope_id", "outcome_id", "attribution_id", "total_input_context_tokens", "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens"],
    ["record_id"], ["i64", "i16", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64", "i64"]),
  table("typed_telemetry_quota",
    ["record_id", "stream", "dimensions_id", "limit_id", "slot_id", "used_percent", "window_duration_minutes", "resets_at_ms"],
    ["record_id"], ["i64", "i16", "i64", "i64", "i64", "f64", "i32", "i64"]),
  table("typed_telemetry_session_tools", ["record_id", "stream", "tool_class_id", "count"], ["record_id", "tool_class_id"], ["i64", "i16", "i64", "i64"]),
]);
const TABLE_BY_NAME = new Map(TABLES.map(value => [value.name, value]));
const SYNTHETIC_TYPED_LEGACY_FIXTURE_SOURCES = new WeakSet();

export class PostgresTypedLegacyTransferError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresTypedLegacyTransferError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresTypedLegacyTransferError(code);
}

function table(name, columns, primaryKey, types, options = {}) {
  if (columns.length !== types.length || primaryKey.some(key => !columns.includes(key))) {
    throw new TypeError("typed legacy transfer table definition invalid");
  }
  const comparisonScope = options.comparisonScope ?? "all-rows";
  if (comparisonScope !== "all-rows" && comparisonScope !== "source-keys") {
    throw new TypeError("typed legacy transfer comparison scope invalid");
  }
  return Object.freeze({
    name,
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(primaryKey),
    types: Object.freeze(types),
    comparisonScope,
  });
}

function schemaName(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)
      || value === "information_schema" || value === "pg_catalog" || value.startsWith("pg_")) {
    fail("TYPED_LEGACY_SCHEMA_INVALID");
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${schemaName(value)}"`;
}

function quoteRelation(schema, name) {
  if (!TABLE_BY_NAME.has(name) && name !== CONTROL_RUN_TABLE && name !== CONTROL_CHECKPOINT_TABLE) {
    fail("TYPED_LEGACY_TABLE_INVALID");
  }
  return `${quoteIdentifier(schema)}."${name}"`;
}

function validSnapshotDescriptor(source) {
  if (!source || !SYNTHETIC_TYPED_LEGACY_FIXTURE_SOURCES.has(source)) {
    fail("TYPED_LEGACY_SNAPSHOT_REQUIRED");
  }
  const snapshot = source?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || typeof source.listPage !== "function" || typeof source.verifySnapshot !== "function") {
    fail("TYPED_LEGACY_SNAPSHOT_REQUIRED");
  }
  if (snapshot.kind === "synthetic-d1-fixture") {
    if (typeof snapshot.snapshotId !== "string" || snapshot.snapshotId.length < 8
        || snapshot.immutable !== true) fail("TYPED_LEGACY_SNAPSHOT_REQUIRED");
    return Object.freeze({ kind: snapshot.kind, snapshotId: snapshot.snapshotId, artifactSha256: null });
  }
  // Neither a live binding nor an export descriptor alone qualifies all
  // independent keyset reads as one snapshot; no artifact reader/verifier is
  // wired into this rehearsal yet.
  fail("TYPED_LEGACY_SNAPSHOT_REQUIRED");
}

async function assertSnapshot(source, expected) {
  const actual = await source.verifySnapshot();
  if (!actual || typeof actual !== "object" || Array.isArray(actual)
      || actual.snapshotId !== expected.snapshotId
      || (expected.artifactSha256 !== null && actual.artifactSha256 !== expected.artifactSha256)) {
    fail("TYPED_LEGACY_SNAPSHOT_CHANGED");
  }
}

function normalizeInteger(value, type) {
  if (value === null || value === undefined) return null;
  let parsed;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^-?(0|[1-9][0-9]*)$/u.test(value)) parsed = BigInt(value);
  else fail("TYPED_LEGACY_VALUE_INVALID");
  if (type === "i64") return parsed.toString();
  const min = type === "i16" ? -32_768 : -2_147_483_648;
  const max = type === "i16" ? 32_767 : 2_147_483_647;
  if (parsed < BigInt(min) || parsed > BigInt(max)) fail("TYPED_LEGACY_VALUE_INVALID");
  return Number(parsed);
}

function normalizeValue(type, value) {
  if (value === null) return null;
  if (value === undefined) fail("TYPED_LEGACY_VALUE_INVALID");
  if (type === "i64" || type === "i16" || type === "i32") return normalizeInteger(value, type);
  if (type === "f64") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) fail("TYPED_LEGACY_VALUE_INVALID");
    return Object.is(parsed, -0) ? 0 : parsed;
  }
  if (type === "text") {
    if (typeof value !== "string" || encoder.encode(value).byteLength > 4_096) fail("TYPED_LEGACY_VALUE_INVALID");
    return value;
  }
  if (type === "bytes") {
    if (Array.isArray(value)) {
      if (value.length > 1_024) fail("TYPED_LEGACY_VALUE_INVALID");
      const bytes = new Uint8Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const byte = value[index];
        if (!Object.hasOwn(value, index) || !Number.isInteger(byte) || byte < 0 || byte > 255) {
          fail("TYPED_LEGACY_VALUE_INVALID");
        }
        bytes[index] = byte;
      }
      return Buffer.from(bytes);
    }
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer)) {
      fail("TYPED_LEGACY_VALUE_INVALID");
    }
    const result = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    if (result.byteLength > 1_024) fail("TYPED_LEGACY_VALUE_INVALID");
    return result;
  }
  fail("TYPED_LEGACY_COLUMN_TYPE_INVALID");
}

function normalizeRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("TYPED_LEGACY_SOURCE_ROW_INVALID");
  const result = Object.create(null);
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    result[column] = normalizeValue(spec.types[index], raw[column]);
  }
  return result;
}

function compareScalar(type, left, right) {
  if (type === "bytes") return Buffer.compare(left, right);
  if (type === "i64") {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareKey(spec, left, right) {
  for (const column of spec.primaryKey) {
    const index = spec.columns.indexOf(column);
    const comparison = compareScalar(spec.types[index], left[column], right[column]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function keyValues(spec, row) {
  return spec.primaryKey.map(column => row[column]);
}

function normalizeKeyRow(spec, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("TYPED_LEGACY_SOURCE_ROW_INVALID");
  const result = Object.create(null);
  for (const column of spec.primaryKey) {
    const index = spec.columns.indexOf(column);
    result[column] = normalizeValue(spec.types[index], raw[column]);
  }
  return result;
}

function canonicalValue(type, value) {
  if (value === null) return null;
  if (type === "bytes") return ["bytea", value.toString("base64")];
  if (type === "i64") return ["int64", value];
  if (type === "i16" || type === "i32") return [type, value];
  if (type === "f64") return ["float64", value];
  return ["text", value];
}

function updateRowHash(hash, spec, row) {
  const values = spec.columns.map((column, index) => canonicalValue(spec.types[index], row[column]));
  hash.update(`${JSON.stringify(values)}\n`);
}

function sha256() {
  return createHash("sha256");
}

function manifestDigest(manifest) {
  const rows = TABLES.map(spec => ({
    table: spec.name,
    comparisonScope: manifest.tables[spec.name].comparisonScope,
    rows: manifest.tables[spec.name].rows,
    sha256: manifest.tables[spec.name].sha256,
  }));
  return sha256().update(JSON.stringify({ schema: POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA, rows })).digest("hex");
}

function validatePageSize(pageSize) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_TYPED_LEGACY_MAX_PAGE_SIZE) {
    fail("TYPED_LEGACY_PAGE_SIZE_INVALID");
  }
  return pageSize;
}

function d1Cursor(spec, after) {
  if (after === null) return null;
  if (!Array.isArray(after) || after.length !== spec.primaryKey.length) fail("TYPED_LEGACY_CHECKPOINT_INVALID");
  return after.map((value, index) => {
    const type = spec.types[spec.columns.indexOf(spec.primaryKey[index])];
    if (type === "i64") {
      const numeric = Number(BigInt(value));
      if (!Number.isSafeInteger(numeric)) fail("TYPED_LEGACY_SOURCE_KEY_UNSAFE");
      return numeric;
    }
    return value;
  });
}

async function readSourcePage(source, spec, after, limit) {
  const page = await source.listPage({ table: spec.name, after: d1Cursor(spec, after), limit });
  if (!page || typeof page !== "object" || !Array.isArray(page.rows) || page.rows.length > limit) {
    fail("TYPED_LEGACY_SOURCE_PAGE_INVALID");
  }
  let previous = null;
  const rows = page.rows.map(raw => {
    const row = normalizeRow(spec, raw);
    const key = keyValues(spec, row);
    if (after !== null) {
      const afterRow = Object.create(null);
      spec.primaryKey.forEach((column, index) => { afterRow[column] = after[index]; });
      if (compareKey(spec, row, afterRow) <= 0) fail("TYPED_LEGACY_SOURCE_ORDER_INVALID");
    }
    if (previous !== null && compareKey(spec, row, previous) <= 0) fail("TYPED_LEGACY_SOURCE_ORDER_INVALID");
    previous = row;
    return row;
  });
  return rows;
}

async function scanSource(source, pageSize) {
  const tables = Object.create(null);
  for (const spec of TABLES) {
    const hash = sha256();
    let rows = 0;
    let after = null;
    for (;;) {
      const page = await readSourcePage(source, spec, after, pageSize);
      for (const row of page) {
        updateRowHash(hash, spec, row);
        rows += 1;
        if (!Number.isSafeInteger(rows)) fail("TYPED_LEGACY_ROW_COUNT_LIMIT");
      }
      if (page.length < pageSize) break;
      after = keyValues(spec, page.at(-1));
    }
    tables[spec.name] = Object.freeze({
      comparisonScope: spec.comparisonScope,
      rows,
      sha256: hash.digest("hex"),
    });
  }
  const result = Object.freeze({ schema: POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA, tables: Object.freeze(tables) });
  return Object.freeze({ ...result, sha256: manifestDigest(result) });
}

async function assertPostgres17(pool, schema) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    fail("TYPED_LEGACY_DESTINATION_INVALID");
  }
  const result = await pool.query("SELECT current_setting('server_version_num')::integer AS version_num");
  const version = Number(result.rows?.[0]?.version_num);
  if (!Number.isSafeInteger(version) || Math.floor(version / 10_000) !== 17) fail("TYPED_LEGACY_POSTGRES_17_REQUIRED");
  const history = await pool.query(
    `SELECT count(*)::integer AS count, max(version)::integer AS latest
       FROM ${quoteIdentifier(schema)}."_tibotattle_migration_history" WHERE version <= $1`,
    [MIGRATION_VERSION],
  );
  if (Number(history.rows?.[0]?.count) < MIGRATION_VERSION
      || Number(history.rows?.[0]?.latest) !== MIGRATION_VERSION) {
    fail("TYPED_LEGACY_BASE_MIGRATION_REQUIRED");
  }
  return version;
}

async function ensureCheckpointTables(pool, schema) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TABLE IF NOT EXISTS ${quoteRelation(schema, CONTROL_RUN_TABLE)} (
      transfer_id text PRIMARY KEY CHECK (length(transfer_id) BETWEEN 1 AND 128),
      schema_version text NOT NULL CHECK (schema_version = '${POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA}'),
      target_schema text NOT NULL,
      source_snapshot_id text NOT NULL,
      source_snapshot_kind text NOT NULL,
      source_artifact_sha256 text,
      source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      status text NOT NULL CHECK (status IN ('running', 'complete')),
      target_manifest_sha256 text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${quoteRelation(schema, CONTROL_CHECKPOINT_TABLE)} (
      transfer_id text NOT NULL REFERENCES ${quoteRelation(schema, CONTROL_RUN_TABLE)}(transfer_id) ON DELETE CASCADE,
      table_name text NOT NULL,
      last_key jsonb,
      row_count bigint NOT NULL CHECK (row_count >= 0),
      page_count bigint NOT NULL CHECK (page_count >= 0),
      complete boolean NOT NULL,
      PRIMARY KEY (transfer_id, table_name)
    )`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function preflightMembershipAuthority({ source, destinationPool, targetSchema, pageSize }) {
  const spec = TABLE_BY_NAME.get("typed_telemetry_owner_memberships");
  let after = null;
  let memberships = 0;
  let linked = 0;
  let linkless = 0;
  for (;;) {
    const rawPage = await source.listPage({ table: spec.name, after: d1Cursor(spec, after), limit: pageSize });
    if (!rawPage || !Array.isArray(rawPage.rows) || rawPage.rows.length > pageSize) fail("TYPED_LEGACY_SOURCE_PAGE_INVALID");
    if (rawPage.rows.length === 0) break;
    const normalized = rawPage.rows.map(raw => normalizeRow(spec, raw));
    const participantIds = [];
    const byParticipant = new Map();
    for (let index = 0; index < rawPage.rows.length; index += 1) {
      const raw = rawPage.rows[index];
      const row = normalized[index];
      const authority = raw.authority;
      if (!authority || typeof authority !== "object" || Array.isArray(authority)
          || authority.participantState !== "active") fail("TYPED_LEGACY_SOURCE_AUTHORITY_INVALID");
      const link = authority.ownerLink ?? null;
      if (link !== null && (typeof link !== "object" || link.state !== "active"
          || !SHA256.test(link.ownerDigest ?? ""))) fail("TYPED_LEGACY_SOURCE_AUTHORITY_INVALID");
      const existing = byParticipant.get(row.participant_id);
      if (existing) {
        const sameLink = existing.link === null && link === null
          || existing.link !== null && link !== null
            && existing.link.ownerDigest === link.ownerDigest && existing.link.state === link.state;
        if (!sameLink) fail("TYPED_LEGACY_SOURCE_AUTHORITY_INVALID");
      } else {
        participantIds.push(row.participant_id);
        byParticipant.set(row.participant_id, { link });
      }
    }
    const destination = await destinationPool.query(
      `SELECT participant.id, participant.state AS participant_state,
              owner_link.owner_digest, owner_link.state AS owner_link_state
         FROM ${quoteIdentifier(targetSchema)}.participants participant
         LEFT JOIN ${quoteIdentifier(targetSchema)}.storage_v11_owner_links owner_link
           ON owner_link.participant_id = participant.id
        WHERE participant.id = ANY($1::text[])`,
      [participantIds],
    );
    const targetByParticipant = new Map(destination.rows.map(row => [row.id, row]));
    for (const participantId of participantIds) {
      const current = targetByParticipant.get(participantId);
      const expected = byParticipant.get(participantId);
      if (!current || current.participant_state !== "active") fail("TYPED_LEGACY_DESTINATION_AUTHORITY_MISSING");
      const sourceLink = expected.link;
      const destinationHasLink = current.owner_digest !== null && current.owner_digest !== undefined;
      if (sourceLink === null) {
        if (destinationHasLink) fail("TYPED_LEGACY_AUTHORITY_MISMATCH");
      } else {
        if (!destinationHasLink || current.owner_digest !== sourceLink.ownerDigest
            || current.owner_link_state !== "active") fail("TYPED_LEGACY_DESTINATION_AUTHORITY_MISSING");
      }
    }
    memberships += rawPage.rows.length;
    linked += normalized.filter(row => byParticipant.get(row.participant_id).link !== null).length;
    linkless += normalized.filter(row => byParticipant.get(row.participant_id).link === null).length;
    const last = normalized.at(-1);
    if (rawPage.rows.length < pageSize) break;
    after = keyValues(spec, last);
  }
  return Object.freeze({ memberships, linked, linkless });
}

function cursorRow(spec, values) {
  if (values === null) return null;
  if (!Array.isArray(values) || values.length !== spec.primaryKey.length) fail("TYPED_LEGACY_CHECKPOINT_INVALID");
  const row = Object.create(null);
  spec.primaryKey.forEach((column, index) => {
    const type = spec.types[spec.columns.indexOf(column)];
    row[column] = normalizeValue(type, values[index]);
  });
  return row;
}

function cursorJson(spec, row) {
  const values = keyValues(spec, row);
  return JSON.stringify(values.map(value => Buffer.isBuffer(value) ? value.toString("base64") : value));
}

function insertSql(schema, spec, rowCount) {
  const columns = spec.columns.map(column => `"${column}"`).join(", ");
  const valueGroups = [];
  let parameter = 1;
  for (let row = 0; row < rowCount; row += 1) {
    valueGroups.push(`(${spec.columns.map(() => `$${parameter++}`).join(", ")})`);
  }
  const key = spec.primaryKey.map(column => `"${column}"`).join(", ");
  return `INSERT INTO ${quoteRelation(schema, spec.name)} (${columns}) VALUES ${valueGroups.join(", ")} ON CONFLICT (${key}) DO NOTHING`;
}

function pageParameters(spec, rows) {
  return rows.flatMap(row => spec.columns.map(column => row[column]));
}

function rangeQuery(schema, spec) {
  const key = spec.primaryKey;
  const left = key.length === 1 ? `"${key[0]}"` : `(${key.map(column => `"${column}"`).join(",")})`;
  const first = key.length === 1 ? "$1" : `(${key.map((_, index) => `$${index + 1}`).join(",")})`;
  const last = key.length === 1 ? `$${key.length + 1}` : `(${key.map((_, index) => `$${key.length + index + 1}`).join(",")})`;
  const columns = spec.columns.map(column => `"${column}"`).join(", ");
  return `SELECT ${columns} FROM ${quoteRelation(schema, spec.name)} WHERE ${left} >= ${first} AND ${left} <= ${last} ORDER BY ${key.map(column => `"${column}"`).join(", ")}`;
}

async function verifyPageRows(client, targetSchema, spec, rows) {
  if (rows.length === 0) return;
  const first = keyValues(spec, rows[0]);
  const last = keyValues(spec, rows.at(-1));
  const values = await client.query(rangeQuery(targetSchema, spec), [...first, ...last]);
  const byKey = new Map(values.rows.map(raw => {
    const normalized = normalizeRow(spec, raw);
    return [cursorJson(spec, normalized), normalized];
  }));
  for (const expected of rows) {
    const actual = byKey.get(cursorJson(spec, expected));
    if (!actual || spec.columns.some(column => !sameValue(expected[column], actual[column]))) {
      fail("TYPED_LEGACY_DESTINATION_ROW_MISMATCH");
    }
  }
}

function sameValue(left, right) {
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  }
  return left === right;
}

async function getOrCreateRun({ pool, controlSchema, transferId, targetSchema, snapshot, sourceManifest }) {
  const relation = quoteRelation(controlSchema, CONTROL_RUN_TABLE);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT * FROM ${relation} WHERE transfer_id = $1 FOR UPDATE`, [transferId]);
    if (existing.rowCount === 0) {
      await client.query(`INSERT INTO ${relation}(
        transfer_id, schema_version, target_schema, source_snapshot_id,
        source_snapshot_kind, source_artifact_sha256, source_manifest_sha256, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'running')`, [
        transferId, POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA, targetSchema,
        snapshot.snapshotId, snapshot.kind, snapshot.artifactSha256,
        sourceManifest.sha256,
      ]);
      await client.query("COMMIT");
      return { created: true, status: "running", resumedPages: 0 };
    }
    const run = existing.rows[0];
    if (run.schema_version !== POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA
        || run.target_schema !== targetSchema
        || run.source_snapshot_id !== snapshot.snapshotId
        || run.source_snapshot_kind !== snapshot.kind
        || run.source_artifact_sha256 !== snapshot.artifactSha256
        || run.source_manifest_sha256 !== sourceManifest.sha256) {
      fail("TYPED_LEGACY_TRANSFER_ID_REUSED");
    }
    const progress = await client.query(
      `SELECT COALESCE(sum(page_count),0)::bigint AS page_count
         FROM ${quoteRelation(controlSchema, CONTROL_CHECKPOINT_TABLE)} WHERE transfer_id=$1`,
      [transferId],
    );
    await client.query("COMMIT");
    return { created: false, status: run.status, resumedPages: Number(progress.rows[0]?.page_count ?? 0) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function acquireTransferLock(pool, transferId) {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [transferId]);
    if (result.rows?.[0]?.locked !== true) fail("TYPED_LEGACY_TRANSFER_BUSY");
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseTransferLock(client, transferId) {
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [transferId]);
  } finally {
    client.release();
  }
}

async function readCheckpoint(client, schema, transferId, tableName) {
  const result = await client.query(
    `SELECT last_key, row_count::text, page_count::text, complete
       FROM ${quoteRelation(schema, CONTROL_CHECKPOINT_TABLE)}
      WHERE transfer_id=$1 AND table_name=$2`,
    [transferId, tableName],
  );
  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function copyTable({ source, destinationPool, targetSchema, controlSchema, transferId, spec, pageSize }) {
  const checkpointRelation = quoteRelation(controlSchema, CONTROL_CHECKPOINT_TABLE);
  const readClient = await destinationPool.connect();
  let checkpoint;
  try {
    checkpoint = await readCheckpoint(readClient, controlSchema, transferId, spec.name);
  } finally {
    readClient.release();
  }
  if (checkpoint?.complete) return { pages: 0, resumed: true };
  let after = checkpoint === null ? null : cursorRow(spec, checkpoint.last_key);
  let rowsDone = checkpoint === null ? 0 : Number(checkpoint.row_count);
  let pagesDone = checkpoint === null ? 0 : Number(checkpoint.page_count);
  if (!Number.isSafeInteger(rowsDone) || !Number.isSafeInteger(pagesDone)) fail("TYPED_LEGACY_CHECKPOINT_INVALID");
  let newPages = 0;
  for (;;) {
    const rows = await readSourcePage(source, spec, after === null ? null : keyValues(spec, after), pageSize);
    const client = await destinationPool.connect();
    try {
      await client.query("BEGIN");
      if (rows.length > 0) {
        await client.query(insertSql(targetSchema, spec, rows.length), pageParameters(spec, rows));
        await verifyPageRows(client, targetSchema, spec, rows);
        after = rows.at(-1);
        rowsDone += rows.length;
        pagesDone += 1;
        newPages += 1;
      }
      const complete = rows.length < pageSize;
      await client.query(`INSERT INTO ${checkpointRelation}(
        transfer_id, table_name, last_key, row_count, page_count, complete
      ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
      ON CONFLICT (transfer_id,table_name) DO UPDATE SET
        last_key=EXCLUDED.last_key, row_count=EXCLUDED.row_count,
        page_count=EXCLUDED.page_count, complete=EXCLUDED.complete`, [
        transferId, spec.name, after === null ? null : cursorJson(spec, after), rowsDone, pagesDone, complete,
      ]);
      await client.query("COMMIT");
      if (complete) break;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { pages: newPages, resumed: checkpoint !== null };
}

async function scanPostgresTable(pool, schema, spec, pageSize) {
  const hash = sha256();
  let after = null;
  let rows = 0;
  for (;;) {
    const keySql = spec.primaryKey.length === 1
      ? `"${spec.primaryKey[0]}" > $1`
      : `(${spec.primaryKey.map(column => `"${column}"`).join(",")}) > (${spec.primaryKey.map((_, index) => `$${index + 1}`).join(",")})`;
    const order = spec.primaryKey.map(column => `"${column}"`).join(", ");
    const columns = spec.columns.map(column => `"${column}"`).join(", ");
    const values = after === null ? [] : keyValues(spec, after);
    const where = after === null ? "" : ` WHERE ${keySql}`;
    const result = await pool.query(
      `SELECT ${columns} FROM ${quoteRelation(schema, spec.name)}${where} ORDER BY ${order} LIMIT $${values.length + 1}`,
      [...values, pageSize],
    );
    const page = result.rows.map(raw => normalizeRow(spec, raw));
    if (page.length > pageSize) fail("TYPED_LEGACY_DESTINATION_PAGE_INVALID");
    for (let index = 0; index < page.length; index += 1) {
      if (after !== null && compareKey(spec, page[index], after) <= 0) fail("TYPED_LEGACY_DESTINATION_ORDER_INVALID");
      if (index > 0 && compareKey(spec, page[index], page[index - 1]) <= 0) fail("TYPED_LEGACY_DESTINATION_ORDER_INVALID");
      updateRowHash(hash, spec, page[index]);
      rows += 1;
    }
    if (!Number.isSafeInteger(rows)) fail("TYPED_LEGACY_ROW_COUNT_LIMIT");
    if (page.length < pageSize) break;
    after = page.at(-1);
  }
  return Object.freeze({
    comparisonScope: spec.comparisonScope,
    rows,
    sha256: hash.digest("hex"),
  });
}

async function scanDictionaryTarget({ source, destinationPool, targetSchema, spec, pageSize }) {
  const hash = sha256();
  let rows = 0;
  let after = null;
  for (;;) {
    const sourceRows = await readSourcePage(source, spec, after === null ? null : keyValues(spec, after), pageSize);
    if (sourceRows.length === 0) break;
    const ids = sourceRows.map(row => row.id);
    const result = await destinationPool.query(
      `SELECT ${spec.columns.map(column => `"${column}"`).join(", ")}
         FROM ${quoteRelation(targetSchema, spec.name)} WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ids],
    );
    const targetRows = result.rows.map(raw => normalizeRow(spec, raw));
    if (targetRows.length !== sourceRows.length) fail("TYPED_LEGACY_DESTINATION_ROW_MISMATCH");
    for (let index = 0; index < sourceRows.length; index += 1) {
      const expected = sourceRows[index];
      const actual = targetRows[index];
      if (spec.columns.some(column => !sameValue(expected[column], actual[column]))) fail("TYPED_LEGACY_DESTINATION_ROW_MISMATCH");
      updateRowHash(hash, spec, actual);
      rows += 1;
    }
    after = sourceRows.at(-1);
    if (sourceRows.length < pageSize) break;
  }
  return Object.freeze({
    comparisonScope: spec.comparisonScope,
    rows,
    sha256: hash.digest("hex"),
  });
}

async function updateDictionarySequence(pool, targetSchema) {
  const result = await pool.query(
    `SELECT pg_get_serial_sequence($1, 'id') AS sequence,
            COALESCE((SELECT max(id) FROM ${quoteRelation(targetSchema, "typed_telemetry_dictionary")}),0)::bigint AS maximum`,
    [`${targetSchema}.typed_telemetry_dictionary`],
  );
  const sequence = result.rows?.[0]?.sequence;
  const maximum = BigInt(result.rows?.[0]?.maximum ?? 0);
  if (!sequence || maximum < 1n) return;
  const match = /^"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?$/u.exec(sequence);
  if (!match || match[1] !== targetSchema) fail("TYPED_LEGACY_DICTIONARY_SEQUENCE_INVALID");
  const sequenceName = `"${match[1]}"."${match[2]}"`;
  const current = await pool.query(`SELECT last_value::bigint AS last_value FROM ${sequenceName}`);
  const lastValue = BigInt(current.rows?.[0]?.last_value ?? 0);
  if (maximum > lastValue) {
    await pool.query("SELECT setval($1::regclass, $2::bigint, true)", [sequence, maximum.toString()]);
  }
}

/**
 * Import the 0030 v1/v1.1 normalized family from a D1-shaped keyset source
 * into an already migrated PostgreSQL 17 schema. Rows and per-table progress
 * are committed page by page; each page and its checkpoint share one PG
 * transaction. A later call with the same transfer id revalidates the frozen
 * source manifest and resumes idempotently.
 *
 * The result is always staged rehearsal evidence. It does not publish a
 * reader, import admission/proof state, or authorize erasure.
 */
export async function runPostgresTypedLegacyTransfer({
  source,
  destinationPool,
  targetSchema: rawTargetSchema,
  controlSchema: rawControlSchema,
  transferId,
  pageSize = POSTGRES_TYPED_LEGACY_DEFAULT_PAGE_SIZE,
} = {}) {
  const targetSchema = schemaName(rawTargetSchema);
  if (typeof rawControlSchema !== "string") fail("TYPED_LEGACY_CONTROL_SCHEMA_REQUIRED");
  const controlSchema = schemaName(rawControlSchema);
  const controlSchemaSuffix = controlSchema.slice(POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX.length);
  if (controlSchema === targetSchema || !controlSchema.startsWith(POSTGRES_TYPED_LEGACY_CONTROL_SCHEMA_PREFIX)
      || controlSchemaSuffix.length < 8) {
    fail("TYPED_LEGACY_CONTROL_SCHEMA_REQUIRED");
  }
  const targetSchemaSuffix = targetSchema.slice(POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX.length);
  if (!targetSchema.startsWith(POSTGRES_TYPED_LEGACY_TARGET_SCHEMA_PREFIX)
      || targetSchemaSuffix.length < 8) {
    fail("TYPED_LEGACY_TARGET_SCHEMA_REQUIRED");
  }
  const size = validatePageSize(pageSize);
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("TYPED_LEGACY_TRANSFER_ID_INVALID");
  const snapshot = validSnapshotDescriptor(source);
  await assertSnapshot(source, snapshot);
  const postgresVersion = await assertPostgres17(destinationPool, targetSchema);
  const authority = await preflightMembershipAuthority({ source, destinationPool, targetSchema, pageSize: size });
  const sourceManifest = await scanSource(source, size);
  await assertSnapshot(source, snapshot);
  await ensureCheckpointTables(destinationPool, controlSchema);
  const runLock = await acquireTransferLock(destinationPool, transferId);
  try {
    const run = await getOrCreateRun({
      pool: destinationPool,
      controlSchema,
      transferId,
      targetSchema,
      snapshot,
      sourceManifest,
    });
    let writtenPages = 0;
    for (const spec of TABLES) {
      const result = await copyTable({
        source,
        destinationPool,
        targetSchema,
        controlSchema,
        transferId,
        spec,
        pageSize: size,
      });
      writtenPages += result.pages;
    }
    const finalSourceManifest = await scanSource(source, size);
    if (finalSourceManifest.sha256 !== sourceManifest.sha256) fail("TYPED_LEGACY_SOURCE_CHANGED");
    await assertSnapshot(source, snapshot);
    await updateDictionarySequence(destinationPool, targetSchema);

    const targetTables = Object.create(null);
    for (const spec of TABLES) {
      targetTables[spec.name] = spec.comparisonScope === "source-keys"
        ? await scanDictionaryTarget({ source, destinationPool, targetSchema, spec, pageSize: size })
        : await scanPostgresTable(destinationPool, targetSchema, spec, size);
    }
    const targetManifestBase = Object.freeze({
      schema: POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA,
      tables: Object.freeze(targetTables),
    });
    const targetManifest = Object.freeze({ ...targetManifestBase, sha256: manifestDigest(targetManifestBase) });
    for (const spec of TABLES) {
      const expected = sourceManifest.tables[spec.name];
      const actual = targetManifest.tables[spec.name];
      if (expected.rows !== actual.rows || expected.sha256 !== actual.sha256) {
        fail("TYPED_LEGACY_SOURCE_DESTINATION_PARITY_FAILED");
      }
    }
    await assertSnapshot(source, snapshot);
    await destinationPool.query(
      `UPDATE ${quoteRelation(controlSchema, CONTROL_RUN_TABLE)}
          SET status='complete', target_manifest_sha256=$2,
              updated_at=clock_timestamp(), completed_at=COALESCE(completed_at,clock_timestamp())
        WHERE transfer_id=$1 AND source_manifest_sha256=$3`,
      [transferId, targetManifest.sha256, sourceManifest.sha256],
    );
    return Object.freeze({
    schema: POSTGRES_TYPED_LEGACY_TRANSFER_SCHEMA,
    status: "staged_rehearsal_complete",
    transferId,
    source: Object.freeze({
      kind: snapshot.kind,
      snapshotId: snapshot.snapshotId,
      artifactSha256: snapshot.artifactSha256,
      rows: Object.values(sourceManifest.tables).reduce((sum, tableValue) => sum + tableValue.rows, 0),
      manifestSha256: sourceManifest.sha256,
      tables: sourceManifest.tables,
    }),
    destination: Object.freeze({
      postgresMajor: Math.floor(postgresVersion / 10_000),
      schema: targetSchema,
      comparedRows: Object.values(targetManifest.tables).reduce((sum, tableValue) => sum + tableValue.rows, 0),
      manifestSha256: targetManifest.sha256,
      tables: targetManifest.tables,
    }),
    pageSize: size,
      pagesCommittedThisRun: writtenPages,
      pagesPreviouslyCommitted: run.resumedPages,
      authority: Object.freeze({
      membershipRowsChecked: authority.memberships,
      matchingActiveOwnerLinks: authority.linked,
      preservedLinklessMemberships: authority.linkless,
      ownerDigestsTransferred: 0,
      missingAuthorityAcceptedAsProof: false,
    }),
      capabilities: Object.freeze({
      legacyRowsTransferred: true,
      v1AdmissionsTransferred: false,
      v11AdmissionsTransferred: false,
      preservationProofsTransferred: false,
      effectiveReaderEnabled: false,
      erasureAuthorized: false,
      productionCutoverAuthorized: false,
      }),
    });
  } finally {
    await releaseTransferLock(runLock, transferId);
  }
}

/**
 * Create a transfer source from an immutable in-memory fixture. The private
 * WeakSet brand is the transfer runner's trust boundary: generic D1 bindings
 * and caller-built source objects cannot self-label into this rehearsal path.
 */
export function createSyntheticD1TypedLegacyFixtureSource({ rows, snapshotId } = {}) {
  if (!rows || typeof rows !== "object" || Array.isArray(rows)
      || typeof snapshotId !== "string" || snapshotId.length < 8) {
    fail("TYPED_LEGACY_SOURCE_ADAPTER_INVALID");
  }
  for (const name of Object.keys(rows)) {
    if (!TABLE_BY_NAME.has(name)) fail("TYPED_LEGACY_TABLE_INVALID");
  }
  const fixture = Object.create(null);
  for (const spec of TABLES) {
    const values = rows[spec.name] ?? [];
    if (!Array.isArray(values)) fail("TYPED_LEGACY_SOURCE_ROW_INVALID");
    const cloned = structuredClone(values);
    cloned.sort((left, right) => compareKey(spec, normalizeKeyRow(spec, left), normalizeKeyRow(spec, right)));
    fixture[spec.name] = cloned;
  }
  const counters = { pages: 0, maxRowsPerPage: 0, listedRows: 0 };
  const descriptor = Object.freeze({
    kind: "synthetic-d1-fixture",
    snapshotId,
    immutable: true,
  });
  const source = {
    snapshot: descriptor,
    async verifySnapshot() {
      return { snapshotId: descriptor.snapshotId };
    },
    getStats() {
      return Object.freeze({ ...counters });
    },
    async listPage({ table: tableName, after = null, limit } = {}) {
      const spec = TABLE_BY_NAME.get(tableName);
      validatePageSize(limit);
      if (!spec) fail("TYPED_LEGACY_TABLE_INVALID");
      const afterRow = after === null ? null : cursorRow(spec, after);
      const candidates = fixture[tableName].filter(raw => afterRow === null
        || compareKey(spec, normalizeKeyRow(spec, raw), afterRow) > 0);
      const page = candidates.slice(0, limit).map(raw => structuredClone(raw));
      counters.pages += 1;
      counters.maxRowsPerPage = Math.max(counters.maxRowsPerPage, page.length);
      counters.listedRows += page.length;
      return Object.freeze({ rows: Object.freeze(page) });
    },
  };
  SYNTHETIC_TYPED_LEGACY_FIXTURE_SOURCES.add(source);
  validSnapshotDescriptor(source);
  return Object.freeze(source);
}

/** Build a pagination-only D1 adapter. The transfer runner does not accept it. */
export function createD1TypedLegacyPageSource({ database } = {}) {
  if (!database || typeof database.prepare !== "function") fail("TYPED_LEGACY_SOURCE_ADAPTER_INVALID");
  return Object.freeze({
    async listPage({ table: tableName, after = null, limit } = {}) {
      const spec = TABLE_BY_NAME.get(tableName);
      validatePageSize(limit);
      if (!spec) fail("TYPED_LEGACY_TABLE_INVALID");
      let sql;
      let parameters;
      if (tableName === "typed_telemetry_owner_memberships") {
        if (after !== null && (!Array.isArray(after) || after.length !== 3)) fail("TYPED_LEGACY_CHECKPOINT_INVALID");
        sql = `WITH source_memberships AS (
          SELECT owner.namespace_id, 10 AS source_format, owner.id AS owner_id,
                 membership.participant_id, admission.source_namespace,
                 participant.state AS participant_state,
                 owner_link.owner_digest, owner_link.state AS owner_link_state
            FROM typed_v1_owner_memberships membership
            JOIN typed_telemetry_owners owner ON owner.id=membership.typed_owner_id
            JOIN typed_v1_admission_state admission ON admission.id=1 AND admission.namespace_id=owner.namespace_id
            JOIN participants participant ON participant.id=membership.participant_id
            LEFT JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=membership.participant_id
          UNION ALL
          SELECT owner.namespace_id, 11 AS source_format, owner.id AS owner_id,
                 membership.participant_id, admission.source_namespace,
                 participant.state AS participant_state,
                 owner_link.owner_digest, owner_link.state AS owner_link_state
            FROM typed_v11_owner_memberships membership
            JOIN typed_telemetry_owners owner ON owner.id=membership.typed_owner_id
            JOIN typed_v11_admission_state admission ON admission.id=1 AND admission.namespace_id=owner.namespace_id
            JOIN participants participant ON participant.id=membership.participant_id
            LEFT JOIN storage_v11_owner_links owner_link ON owner_link.participant_id=membership.participant_id
        )
        SELECT namespace_id,source_format,owner_id,participant_id,source_namespace,
               participant_state,owner_digest,owner_link_state
          FROM source_memberships
         WHERE (?1 IS NULL OR (namespace_id,source_format,owner_id)>(?1,?2,?3))
         ORDER BY namespace_id,source_format,owner_id LIMIT ?4`;
        parameters = after === null ? [null, null, null, limit] : [...after, limit];
      } else {
        if (after !== null && (!Array.isArray(after) || after.length !== spec.primaryKey.length)) fail("TYPED_LEGACY_CHECKPOINT_INVALID");
        const columns = spec.columns.map(column => `"${column}"`).join(",");
        const key = spec.primaryKey.length === 1
          ? `"${spec.primaryKey[0]}" > ?`
          : `(${spec.primaryKey.map(column => `"${column}"`).join(",")}) > (${spec.primaryKey.map(() => "?").join(",")})`;
        sql = `SELECT ${columns} FROM "${tableName}"${after === null ? "" : ` WHERE ${key}`} ORDER BY ${spec.primaryKey.map(column => `"${column}"`).join(",")} LIMIT ?`;
        parameters = after === null ? [limit] : [...after, limit];
      }
      const prepared = database.prepare(sql);
      const response = await prepared.bind(...parameters).all();
      if (!response || response.success === false || !Array.isArray(response.results)) fail("TYPED_LEGACY_D1_READ_FAILED");
      const rows = response.results.map(raw => {
        if (tableName !== "typed_telemetry_owner_memberships") return raw;
        const {
          participant_state: participantState,
          owner_digest: ownerDigest,
          owner_link_state: ownerLinkState,
          ...membership
        } = raw;
        return {
          ...membership,
          authority: {
            participantState,
            ownerLink: ownerDigest === null || ownerDigest === undefined
              ? null
              : { ownerDigest, state: ownerLinkState },
          },
        };
      });
      return Object.freeze({ rows: Object.freeze(rows) });
    },
  });
}

export const POSTGRES_TYPED_LEGACY_TRANSFER_TABLES = Object.freeze(TABLES.map(spec => spec.name));
