import { createHash } from "node:crypto";
import {
  POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT,
  POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE,
  openPostgresLegacyAdmissionHeaderMirror,
} from "./postgres-legacy-admission-transfer.mjs";
import { POSTGRES_MIGRATION_ROOT, readPostgresMigrations } from "./postgres-migrations.mjs";

export const POSTGRES_LEGACY_HEADER_PROMOTION_SCHEMA = "legacy-header-promotion-v1";
export const POSTGRES_LEGACY_HEADER_PROMOTION_DEFAULT_PAGE_SIZE = 100;
export const POSTGRES_LEGACY_HEADER_PROMOTION_MAX_PAGE_SIZE = 250;

const TARGET_PREFIX = "typed_legacy_target_";
const CONTROL_PREFIX = "typed_legacy_admission_transfer_";
const CHECKPOINT_TABLE = "_legacy_header_promotion_checkpoints_v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const TRANSFER_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const HEADER_TABLES = Object.freeze(POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT.map((spec) => Object.freeze({
  ...spec,
  targetTable: ({
    telemetry_v1_chunks: "historical_telemetry_v1_chunk_headers",
    telemetry_v11_day_manifests: "historical_telemetry_v11_manifest_headers",
    telemetry_v11_chunks: "historical_telemetry_v11_chunk_headers",
  })[spec.name],
})));

export class PostgresLegacyHeaderPromotionError extends Error {
  constructor(code) {
    super(code);
    this.name = "PostgresLegacyHeaderPromotionError";
    this.code = code;
  }
}

function fail(code) {
  throw new PostgresLegacyHeaderPromotionError(code);
}

function schemaName(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.startsWith("pg_")
      || value === "pg_catalog" || value === "information_schema") fail("LEGACY_HEADER_PROMOTION_SCHEMA_INVALID");
  return value;
}

function quote(value) {
  return `"${schemaName(value)}"`;
}

function validatePageSize(value) {
  const pageSize = value ?? POSTGRES_LEGACY_HEADER_PROMOTION_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > POSTGRES_LEGACY_HEADER_PROMOTION_MAX_PAGE_SIZE
      || pageSize > POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE) fail("LEGACY_HEADER_PROMOTION_PAGE_SIZE_INVALID");
  return pageSize;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rowJson(spec, row) {
  return JSON.stringify(spec.columns.map((column) => row[column]));
}

function parseHeaderRow(spec, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
  const output = Object.create(null);
  for (let index = 0; index < spec.columns.length; index += 1) {
    const column = spec.columns[index];
    const type = spec.types[index];
    const value = row[column];
    if (value === null) {
      output[column] = null;
      continue;
    }
    if (type === "i32") {
      const number = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(number) || number < -2147483648 || number > 2147483647) fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
      output[column] = number;
      continue;
    }
    if (type === "text" || type === "longtext") {
      if (typeof value !== "string" || Buffer.byteLength(value) > (type === "longtext" ? 1_250_000 : 4096)) {
        fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
      }
      output[column] = value;
      continue;
    }
    fail("LEGACY_HEADER_PROMOTION_LAYOUT_INVALID");
  }
  if (spec.columns.some((column) => output[column] === undefined)) fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
  if (typeof output.id !== "string" || output.id.length === 0
      || typeof output.participant_id !== "string" || output.participant_id.length === 0
      || typeof output.device_id !== "string" || output.device_id.length === 0) {
    fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
  }
  if (spec.name === "telemetry_v1_chunks") {
    if (!["usage", "quota", "session"].includes(output.stream)
        || !/^\d{4}-\d{2}-\d{2}$/u.test(output.chunk_day)
        || output.chunk_seq < 0 || output.chunk_seq > 99999 || output.revision < 1
        || !SHA256.test(output.chunk_digest) || !SHA256.test(output.envelope_digest)
        || output.record_count < 1 || output.record_count > 200
        || output.accepted_record_count < 0 || output.accepted_record_count > output.record_count
        || output.parser_version.length === 0 || output.r2_key.length === 0
        || output.device_upload_authorization_id.length === 0 || output.created_at.length === 0) {
      fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
    }
  } else if (spec.name === "telemetry_v11_day_manifests") {
    let manifest;
    try { manifest = JSON.parse(output.manifest_json); } catch { fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID"); }
    if (output.id.length !== 36 || output.chunk_day.length !== 10
        || !/^\d{4}-\d{2}-\d{2}$/u.test(output.chunk_day)
        || !SHA256.test(output.manifest_digest) || output.parser_version.length === 0 || output.parser_version.length > 64
        || output.expected_chunk_count < 0 || output.expected_chunk_count > 4096
        || !["staged", "ready"].includes(output.state)
        || !manifest || typeof manifest !== "object" || Array.isArray(manifest)
        || !Array.isArray(manifest.chunks) || manifest.chunks.length !== output.expected_chunk_count
        || (output.state === "ready") !== (output.ready_at !== null)
        || output.created_at.length === 0) fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
  } else if (spec.name === "telemetry_v11_chunks") {
    if (output.id.length !== 42 || !output.id.startsWith("chunk:")
        || typeof output.manifest_id !== "string" || output.manifest_id.length === 0
        || !["usage", "quota", "session"].includes(output.stream)
        || output.chunk_day.length === 0 || output.chunk_seq < 0 || output.chunk_seq > 99999
        || output.chunk_id.length === 0 || !SHA256.test(output.chunk_digest) || !SHA256.test(output.envelope_digest)
        || output.parser_version.length === 0 || output.parser_version.length > 64
        || output.record_count < 1 || output.record_count > 200
        || output.r2_key.length === 0 || output.device_upload_authorization_id.length === 0
        || output.created_at.length === 0) fail("LEGACY_HEADER_PROMOTION_SOURCE_ROW_INVALID");
  } else {
    fail("LEGACY_HEADER_PROMOTION_LAYOUT_INVALID");
  }
  return output;
}

function headerPermit(mirror, targetSchema, proof) {
  const receipt = mirror.receipt;
  const counts = Object.fromEntries(HEADER_TABLES.map((spec) => [spec.name, proof.tables[spec.name].rows]));
  const hashes = Object.fromEntries(HEADER_TABLES.map((spec) => [spec.name, proof.tables[spec.name].sha256]));
  const mirrorReceiptSha256 = sha256(JSON.stringify([
    receipt.targetSchema, receipt.transferId, receipt.sourceSnapshotId, receipt.sourceSnapshotKind,
    receipt.sourceSnapshotSha256, receipt.sourceManifestSha256, receipt.v1SourceNamespace,
    receipt.v11SourceNamespace, receipt.headerManifestSha256, counts, receipt.completedAt,
  ]));
  const fields = {
    targetSchema,
    sourceSnapshotId: receipt.sourceSnapshotId,
    sourceSnapshotKind: receipt.sourceSnapshotKind,
    sourceSnapshotSha256: receipt.sourceSnapshotSha256,
    sourceManifestSha256: receipt.sourceManifestSha256,
    v1SourceNamespace: receipt.v1SourceNamespace,
    v11SourceNamespace: receipt.v11SourceNamespace,
    headerManifestSha256: proof.sha256,
    headerTableRowCounts: counts,
    headerTableSha256: hashes,
    mirrorControlSchema: receipt.controlSchema,
    mirrorTransferId: receipt.transferId,
    mirrorReceiptSha256,
  };
  const sourceImportId = sha256(JSON.stringify([
    fields.targetSchema, fields.sourceSnapshotId, fields.sourceSnapshotKind,
    fields.sourceSnapshotSha256, fields.sourceManifestSha256, fields.v1SourceNamespace,
    fields.v11SourceNamespace, fields.headerManifestSha256, fields.headerTableRowCounts,
    fields.headerTableSha256, fields.mirrorControlSchema, fields.mirrorTransferId,
    fields.mirrorReceiptSha256,
  ]));
  return Object.freeze({ sourceImportId, ...fields });
}

function permitValues(permit) {
  return [permit.sourceImportId, permit.targetSchema, permit.sourceSnapshotId,
    permit.sourceSnapshotKind, permit.sourceSnapshotSha256, permit.sourceManifestSha256,
    permit.v1SourceNamespace, permit.v11SourceNamespace, permit.headerManifestSha256,
    JSON.stringify(permit.headerTableRowCounts), JSON.stringify(permit.headerTableSha256),
    permit.mirrorControlSchema, permit.mirrorTransferId, permit.mirrorReceiptSha256];
}

function matchesPermit(row, permit) {
  if (!row) return false;
  const jsonEqual = (actual, expected) => {
    if (typeof actual === "string") {
      try { actual = JSON.parse(actual); } catch { return false; }
    }
    const keys = Object.keys(expected).sort();
    return actual && typeof actual === "object" && !Array.isArray(actual)
      && JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(keys)
      && keys.every((key) => actual[key] === expected[key]);
  };
  return row.source_import_id === permit.sourceImportId
    && row.target_schema === permit.targetSchema
    && row.source_snapshot_id === permit.sourceSnapshotId
    && row.source_snapshot_kind === permit.sourceSnapshotKind
    && row.source_snapshot_sha256 === permit.sourceSnapshotSha256
    && row.source_manifest_sha256 === permit.sourceManifestSha256
    && row.v1_source_namespace === permit.v1SourceNamespace
    && row.v11_source_namespace === permit.v11SourceNamespace
    && row.header_manifest_sha256 === permit.headerManifestSha256
    && jsonEqual(row.header_table_row_counts, permit.headerTableRowCounts)
    && jsonEqual(row.header_table_sha256, permit.headerTableSha256)
    && row.mirror_control_schema === permit.mirrorControlSchema
    && row.mirror_transfer_id === permit.mirrorTransferId
    && row.mirror_receipt_sha256 === permit.mirrorReceiptSha256;
}

async function assertLocalPostgres17(pool, targetSchema) {
  const result = await pool.query(`SELECT current_setting('server_version_num')::integer AS version,
      inet_server_addr() AS address, to_regnamespace($1) AS target`, [targetSchema]);
  const version = Number(result.rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < 170000 || version >= 180000
      || result.rows[0]?.address !== null || !result.rows[0]?.target) {
    fail("LEGACY_HEADER_PROMOTION_LOCAL_POSTGRES17_REQUIRED");
  }
}

async function assertMigrationReady(pool, targetSchema) {
  let migrations;
  try { migrations = await readPostgresMigrations({ role: "primary", rootDirectory: POSTGRES_MIGRATION_ROOT }); }
  catch { fail("LEGACY_HEADER_PROMOTION_MIGRATION_REQUIRED"); }
  const expected = migrations.find((item) => item.version === 40 && item.name === "0040_historical_transport_headers.sql");
  if (!expected) fail("LEGACY_HEADER_PROMOTION_MIGRATION_REQUIRED");
  const history = await pool.query(`SELECT to_regclass($1) AS relation`, [`${targetSchema}._tibotattle_migration_history`]);
  if (!history.rows[0]?.relation) fail("LEGACY_HEADER_PROMOTION_MIGRATION_REQUIRED");
  const receipt = await pool.query(`SELECT name,checksum_sha256 FROM ${quote(targetSchema)}."_tibotattle_migration_history" WHERE version=40`);
  if (receipt.rowCount !== 1 || receipt.rows[0]?.name !== expected.name || receipt.rows[0]?.checksum_sha256 !== expected.sha256) {
    fail("LEGACY_HEADER_PROMOTION_MIGRATION_REQUIRED");
  }
}

async function assertIdentityPairs(pool, targetSchema, rows) {
  const pairs = new Map();
  for (const row of rows) pairs.set(`${row.participant_id}\u0000${row.device_id}`, [row.participant_id, row.device_id]);
  if (pairs.size === 0) return;
  const values = [...pairs.values()];
  const participants = values.map(([participant]) => participant);
  const devices = values.map(([, device]) => device);
  const result = await pool.query(`SELECT candidate.participant_id,candidate.device_id
    FROM unnest($1::text[],$2::text[]) AS candidate(participant_id,device_id)
    JOIN ${quote(targetSchema)}.participants participant
      ON participant.id=candidate.participant_id AND participant.state='active'
    JOIN ${quote(targetSchema)}.device_credentials device
      ON device.id=candidate.device_id AND device.participant_id=participant.id`, [participants, devices]);
  const found = new Set(result.rows.map((row) => `${row.participant_id}\u0000${row.device_id}`));
  if (found.size !== pairs.size || [...pairs.keys()].some((key) => !found.has(key))) {
    fail("LEGACY_HEADER_PROMOTION_IDENTITY_AUTHORITY_MISMATCH");
  }
}

async function assertManifestChunkMirrorIntegrity(pool, controlSchema) {
  const control = quote(controlSchema);
  let result;
  try {
    result = await pool.query(`SELECT count(*)::text AS n
      FROM ${control}."_legacy_source_telemetry_v11_chunks_v1" chunk
      LEFT JOIN ${control}."_legacy_source_telemetry_v11_day_manifests_v1" manifest
        ON manifest.id=chunk.manifest_id
      WHERE manifest.id IS NULL OR manifest.participant_id IS DISTINCT FROM chunk.participant_id
         OR manifest.device_id IS DISTINCT FROM chunk.device_id
         OR manifest.chunk_day IS DISTINCT FROM chunk.chunk_day
         OR manifest.parser_version IS DISTINCT FROM chunk.parser_version
         OR NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(manifest.manifest_json::jsonb -> 'chunks') expected
            WHERE expected.value ->> 'chunkId'=chunk.chunk_id
              AND expected.value ->> 'chunkDigest'=chunk.chunk_digest
              AND (expected.value ->> 'recordCount')::integer=chunk.record_count
         )`);
  } catch { fail("LEGACY_HEADER_PROMOTION_MANIFEST_MISMATCH"); }
  if (BigInt(result.rows[0]?.n ?? "-1") !== 0n) fail("LEGACY_HEADER_PROMOTION_MANIFEST_MISMATCH");
}

async function preflightSource({ pool, targetSchema, mirror, pageSize }) {
  const proofs = Object.create(null);
  for (const spec of HEADER_TABLES) {
    const digest = createHash("sha256");
    let after = null;
    let rowsSeen = 0;
    for (;;) {
      const page = await mirror.listPage({ table: spec.name, after, limit: pageSize });
      if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("LEGACY_HEADER_PROMOTION_SOURCE_PAGE_INVALID");
      const rows = page.rows.map((row) => parseHeaderRow(spec, row));
      await assertIdentityPairs(pool, targetSchema, rows);
      for (let index = 0; index < rows.length; index += 1) {
        if (after !== null && rows[index].id <= after) fail("LEGACY_HEADER_PROMOTION_SOURCE_ORDER_INVALID");
        if (index > 0 && rows[index - 1].id >= rows[index].id) fail("LEGACY_HEADER_PROMOTION_SOURCE_ORDER_INVALID");
        digest.update(rowJson(spec, rows[index]));
        digest.update("\n");
      }
      rowsSeen += rows.length;
      if (rows.length < pageSize) break;
      after = rows.at(-1).id;
    }
    proofs[spec.name] = Object.freeze({ rows: rowsSeen, sha256: digest.digest("hex") });
  }
  await assertManifestChunkMirrorIntegrity(pool, mirror.receipt.controlSchema);
  const tables = Object.create(null);
  for (const spec of HEADER_TABLES) tables[spec.name] = proofs[spec.name];
  const manifest = Object.freeze({
    tables: Object.freeze(tables),
    sha256: sha256(JSON.stringify(tables)),
  });
  const mirrorProof = await mirror.verify();
  if (mirrorProof.sha256 !== manifest.sha256
      || HEADER_TABLES.some((spec) => mirrorProof.tables[spec.name].rows !== manifest.tables[spec.name].rows
        || mirrorProof.tables[spec.name].sha256 !== manifest.tables[spec.name].sha256)) {
    fail("LEGACY_HEADER_PROMOTION_SOURCE_MISMATCH");
  }
  return manifest;
}

async function ensureCheckpointTable(pool, controlSchema) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${quote(controlSchema)}."${CHECKPOINT_TABLE}" (
    source_import_id text NOT NULL CHECK (source_import_id ~ '^[0-9a-f]{64}$'),
    table_name text NOT NULL CHECK (table_name IN ('telemetry_v1_chunks','telemetry_v11_day_manifests','telemetry_v11_chunks')),
    last_key text,
    row_count bigint NOT NULL CHECK (row_count >= 0),
    page_count bigint NOT NULL CHECK (page_count >= 0),
    complete boolean NOT NULL,
    PRIMARY KEY (source_import_id,table_name)
  )`);
}

async function insertPermit(pool, permit) {
  const relation = `${quote(permit.targetSchema)}."historical_transport_header_imports"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${quote(permit.targetSchema)}, pg_catalog`);
    await client.query(`INSERT INTO ${relation}(
      source_import_id,target_schema,source_snapshot_id,source_snapshot_kind,source_snapshot_sha256,
      source_manifest_sha256,v1_source_namespace,v11_source_namespace,header_manifest_sha256,
      header_table_row_counts,header_table_sha256,mirror_control_schema,mirror_transfer_id,mirror_receipt_sha256
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)
      ON CONFLICT DO NOTHING`, permitValues(permit));
    const result = await client.query(`SELECT * FROM ${relation} WHERE target_schema=$1`, [permit.targetSchema]);
    if (result.rowCount !== 1 || !matchesPermit(result.rows[0], permit)) fail("LEGACY_HEADER_PROMOTION_PERMIT_MISMATCH");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresLegacyHeaderPromotionError) throw error;
    fail("LEGACY_HEADER_PROMOTION_PERMIT_WRITE_FAILED");
  } finally {
    client.release();
  }
}

async function readPermit(pool, permit) {
  const result = await pool.query(`SELECT * FROM ${quote(permit.targetSchema)}."historical_transport_header_imports" WHERE target_schema=$1`, [permit.targetSchema]);
  if (result.rowCount === 0) return false;
  if (result.rowCount !== 1 || !matchesPermit(result.rows[0], permit)) fail("LEGACY_HEADER_PROMOTION_PERMIT_MISMATCH");
  return true;
}

async function assertArchiveEmpty(pool, targetSchema) {
  for (const spec of HEADER_TABLES) {
    const result = await pool.query(`SELECT count(*)::text AS n FROM ${quote(targetSchema)}."${spec.targetTable}"`);
    if (BigInt(result.rows[0]?.n ?? "-1") !== 0n) fail("LEGACY_HEADER_PROMOTION_UNPERMITTED_ROWS_PRESENT");
  }
  const result = await pool.query(`SELECT count(*)::text AS n FROM ${quote(targetSchema)}."historical_transport_header_promotion_receipts"`);
  if (BigInt(result.rows[0]?.n ?? "-1") !== 0n) fail("LEGACY_HEADER_PROMOTION_UNPERMITTED_RECEIPT_PRESENT");
}

async function getCheckpoint(pool, controlSchema, sourceImportId, tableName) {
  const result = await pool.query(`SELECT last_key,row_count,page_count,complete
    FROM ${quote(controlSchema)}."${CHECKPOINT_TABLE}" WHERE source_import_id=$1 AND table_name=$2`, [sourceImportId, tableName]);
  return result.rows[0] ?? null;
}

function insertPageStatement(targetSchema, spec, importId, rows) {
  const columns = ["source_import_id", ...spec.columns];
  const values = [];
  const groups = rows.map((row) => `(${columns.map((column) => {
    values.push(column === "source_import_id" ? importId : row[column]);
    return `$${values.length}`;
  }).join(",")})`);
  const relation = `${quote(targetSchema)}."${spec.targetTable}"`;
  return {
    sql: `INSERT INTO ${relation}(${columns.map((column) => `"${column}"`).join(",")}) VALUES ${groups.join(",")}
      ON CONFLICT (source_import_id,id) DO NOTHING`,
    values,
  };
}

function equalRow(spec, expected, actual) {
  return actual !== undefined && spec.columns.every((column) => expected[column] === actual[column]);
}

async function verifyTargetPage(client, targetSchema, spec, importId, expectedRows) {
  if (expectedRows.length === 0) return;
  const ids = expectedRows.map((row) => row.id);
  const columns = ["source_import_id", ...spec.columns].map((column) => `"${column}"`).join(",");
  const result = await client.query(`SELECT ${columns} FROM ${quote(targetSchema)}."${spec.targetTable}"
    WHERE source_import_id=$1 AND id=ANY($2::text[])`, [importId, ids]);
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  if (byId.size !== expectedRows.length || expectedRows.some((row) => !equalRow(spec, row, byId.get(row.id)))) {
    fail("LEGACY_HEADER_PROMOTION_DESTINATION_MISMATCH");
  }
}

async function copyTable({ pool, targetSchema, controlSchema, mirror, permit, spec, pageSize }) {
  const prior = await getCheckpoint(pool, controlSchema, permit.sourceImportId, spec.name);
  if (prior?.complete) {
    if (BigInt(prior.row_count) !== BigInt(permit.headerTableRowCounts[spec.name])) fail("LEGACY_HEADER_PROMOTION_CHECKPOINT_MISMATCH");
    return { pages: 0 };
  }
  let after = prior?.last_key ?? null;
  let rowCount = Number(prior?.row_count ?? 0);
  let pageCount = Number(prior?.page_count ?? 0);
  let pages = 0;
  for (;;) {
    const page = await mirror.listPage({ table: spec.name, after: after === null ? null : [after], limit: pageSize });
    if (!page || !Array.isArray(page.rows) || page.rows.length > pageSize) fail("LEGACY_HEADER_PROMOTION_SOURCE_PAGE_INVALID");
    const rows = page.rows.map((row) => parseHeaderRow(spec, row));
    for (let index = 0; index < rows.length; index += 1) {
      if (after !== null && rows[index].id <= after) fail("LEGACY_HEADER_PROMOTION_SOURCE_ORDER_INVALID");
      if (index > 0 && rows[index - 1].id >= rows[index].id) fail("LEGACY_HEADER_PROMOTION_SOURCE_ORDER_INVALID");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${quote(targetSchema)}, pg_catalog`);
      await client.query("SELECT set_config('tibotattle.legacy_header_promotion',$1,true)", [permit.sourceImportId]);
      if (rows.length > 0) {
        const statement = insertPageStatement(targetSchema, spec, permit.sourceImportId, rows);
        await client.query(statement.sql, statement.values);
        await verifyTargetPage(client, targetSchema, spec, permit.sourceImportId, rows);
        after = rows.at(-1).id;
        rowCount += rows.length;
        pageCount += 1;
        pages += 1;
      }
      const checkpoint = `${quote(controlSchema)}."${CHECKPOINT_TABLE}"`;
      await client.query(`INSERT INTO ${checkpoint}(source_import_id,table_name,last_key,row_count,page_count,complete)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_import_id,table_name) DO UPDATE SET
          last_key=EXCLUDED.last_key,row_count=EXCLUDED.row_count,page_count=EXCLUDED.page_count,complete=EXCLUDED.complete`,
      [permit.sourceImportId, spec.name, after, rowCount, pageCount, rows.length < pageSize]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof PostgresLegacyHeaderPromotionError) throw error;
      fail("LEGACY_HEADER_PROMOTION_PAGE_WRITE_FAILED");
    } finally {
      client.release();
    }
    if (rows.length < pageSize) break;
  }
  return { pages };
}

async function verifyAllPromoted({ pool, targetSchema, mirror, permit, pageSize }) {
  const proofs = Object.create(null);
  for (const spec of HEADER_TABLES) {
    const digest = createHash("sha256");
    let after = null;
    let rowCount = 0;
    for (;;) {
      const page = await mirror.listPage({ table: spec.name, after, limit: pageSize });
      const rows = page.rows.map((row) => parseHeaderRow(spec, row));
      if (rows.length === 0) break;
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await verifyTargetPage(client, targetSchema, spec, permit.sourceImportId, rows);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if (error instanceof PostgresLegacyHeaderPromotionError) throw error;
        fail("LEGACY_HEADER_PROMOTION_DESTINATION_MISMATCH");
      } finally { client.release(); }
      for (const row of rows) { digest.update(rowJson(spec, row)); digest.update("\n"); }
      rowCount += rows.length;
      after = rows.at(-1).id;
      if (rows.length < pageSize) break;
    }
    const tableProof = Object.freeze({ rows: rowCount, sha256: digest.digest("hex") });
    const expectedCount = permit.headerTableRowCounts[spec.name];
    const expectedSha = permit.headerTableSha256[spec.name];
    if (tableProof.rows !== expectedCount || tableProof.sha256 !== expectedSha) fail("LEGACY_HEADER_PROMOTION_DESTINATION_MISMATCH");
    const total = await pool.query(`SELECT count(*)::text AS n FROM ${quote(targetSchema)}."${spec.targetTable}" WHERE source_import_id=$1`, [permit.sourceImportId]);
    if (BigInt(total.rows[0]?.n ?? "-1") !== BigInt(expectedCount)) fail("LEGACY_HEADER_PROMOTION_DESTINATION_MISMATCH");
    proofs[spec.name] = tableProof;
  }
  const manifest = Object.create(null);
  for (const spec of HEADER_TABLES) manifest[spec.name] = proofs[spec.name];
  const headerManifestSha256 = sha256(JSON.stringify(manifest));
  if (headerManifestSha256 !== permit.headerManifestSha256) fail("LEGACY_HEADER_PROMOTION_DESTINATION_MISMATCH");
  return Object.freeze({ tables: Object.freeze(proofs), sha256: headerManifestSha256 });
}

async function persistCompletionReceipt(pool, permit) {
  const relation = `${quote(permit.targetSchema)}."historical_transport_header_promotion_receipts"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${quote(permit.targetSchema)}, pg_catalog`);
    await client.query(`INSERT INTO ${relation}(source_import_id,mirror_receipt_sha256,promoted_table_row_counts,promoted_table_sha256)
      VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(source_import_id) DO NOTHING`, [permit.sourceImportId,
      permit.mirrorReceiptSha256, JSON.stringify(permit.headerTableRowCounts), JSON.stringify(permit.headerTableSha256)]);
    const result = await client.query(`SELECT mirror_receipt_sha256,promoted_table_row_counts,promoted_table_sha256
      FROM ${relation} WHERE source_import_id=$1`, [permit.sourceImportId]);
    const row = result.rows[0];
    const jsonEqual = (actual, expected) => {
      if (typeof actual === "string") { try { actual = JSON.parse(actual); } catch { return false; } }
      return actual && typeof actual === "object" && !Array.isArray(actual)
        && Object.keys(actual).length === Object.keys(expected).length
        && Object.entries(expected).every(([key, value]) => actual[key] === value);
    };
    if (result.rowCount !== 1 || row.mirror_receipt_sha256 !== permit.mirrorReceiptSha256
        || !jsonEqual(row.promoted_table_row_counts, permit.headerTableRowCounts)
        || !jsonEqual(row.promoted_table_sha256, permit.headerTableSha256)) fail("LEGACY_HEADER_PROMOTION_RECEIPT_MISMATCH");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof PostgresLegacyHeaderPromotionError) throw error;
    fail("LEGACY_HEADER_PROMOTION_RECEIPT_WRITE_FAILED");
  } finally { client.release(); }
}

/** Promote a completed synthetic header mirror into an isolated local PG17 schema. */
export async function runPostgresLegacyHeaderPromotion({ pool, targetSchema: rawTargetSchema,
  controlSchema: rawControlSchema, transferId, pageSize } = {}) {
  const targetSchema = schemaName(rawTargetSchema);
  const controlSchema = schemaName(rawControlSchema);
  if (!targetSchema.startsWith(TARGET_PREFIX) || targetSchema.length < TARGET_PREFIX.length + 8
      || controlSchema === targetSchema || !controlSchema.startsWith(CONTROL_PREFIX)
      || controlSchema.length < CONTROL_PREFIX.length + 8) fail("LEGACY_HEADER_PROMOTION_SCHEMA_INVALID");
  if (typeof transferId !== "string" || !TRANSFER_ID.test(transferId)) fail("LEGACY_HEADER_PROMOTION_TRANSFER_ID_INVALID");
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") fail("LEGACY_HEADER_PROMOTION_POOL_INVALID");
  const size = validatePageSize(pageSize);
  await assertLocalPostgres17(pool, targetSchema);
  await assertMigrationReady(pool, targetSchema);
  const mirror = await openPostgresLegacyAdmissionHeaderMirror({ pool, targetSchema, controlSchema, transferId, pageSize: size });
  if (mirror.receipt.sourceSnapshotKind !== "synthetic-d1-fixture") fail("LEGACY_HEADER_PROMOTION_SYNTHETIC_SOURCE_REQUIRED");
  const lockClient = await pool.connect();
  let lockAcquired = false;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`legacy-header-promotion:${targetSchema}`]);
    lockAcquired = true;
    await ensureCheckpointTable(pool, controlSchema);
    const proof = await preflightSource({ pool, targetSchema, mirror, pageSize: size });
    const permit = headerPermit(mirror, targetSchema, proof);
    const hasPermit = await readPermit(pool, permit);
    if (!hasPermit) await assertArchiveEmpty(pool, targetSchema);
    await insertPermit(pool, permit);
    let pages = 0;
    for (const spec of HEADER_TABLES) {
      pages += (await copyTable({ pool, targetSchema, controlSchema, mirror, permit, spec, pageSize: size })).pages;
    }
    const finalProof = await preflightSource({ pool, targetSchema, mirror, pageSize: size });
    if (finalProof.sha256 !== permit.headerManifestSha256) fail("LEGACY_HEADER_PROMOTION_SOURCE_MISMATCH");
    const promotedProof = await verifyAllPromoted({ pool, targetSchema, mirror, permit, pageSize: size });
    await persistCompletionReceipt(pool, permit);
    return Object.freeze({
      schema: POSTGRES_LEGACY_HEADER_PROMOTION_SCHEMA,
      status: "synthetic_historical_header_promotion_complete",
      postgresMajor: 17,
      pageSize: size,
      pagesCommittedThisRun: pages,
      sourceImportId: permit.sourceImportId,
      sourceSnapshotSha256: permit.sourceSnapshotSha256,
      sourceManifestSha256: permit.sourceManifestSha256,
      headerManifestSha256: promotedProof.sha256,
      headerTableRowCounts: permit.headerTableRowCounts,
      headerTableSha256: permit.headerTableSha256,
      productionReady: false,
      readerActivationAuthorized: false,
      cursorAdvanced: false,
      ownerStateActivated: false,
      publicationActivated: false,
      erasureAuthorized: false,
    });
  } finally {
    if (lockAcquired) await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`legacy-header-promotion:${targetSchema}`]).catch(() => {});
    lockClient.release();
  }
}
