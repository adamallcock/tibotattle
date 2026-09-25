#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";
import {
  POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT,
  createSyntheticLegacyAdmissionSource,
  runPostgresLegacyAdmissionTransfer,
} from "./postgres-legacy-admission-transfer.mjs";

const quote = (value) => {
  assert.match(value, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const originalId = (value) => Buffer.concat([Buffer.from([0]), Buffer.from(value)]);
const PG_TEST_SOCKET_PATTERN = /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u;
const ROWS = [10_000, 100_000];
const PAGE_SIZES = [100, 250];
const INSERT_BATCH_SIZE = 500;

function selectedProfiles(env, key, defaults, allowed) {
  const raw = env[key];
  if (raw === undefined || raw === "") return defaults;
  const selected = raw.split(",").map((value) => Number(value.trim()));
  if (selected.length === 0 || selected.some((value) => !allowed.includes(value))) {
    throw new Error("BENCHMARK_PROFILE_INVALID");
  }
  return [...new Set(selected)];
}

async function localSocket(env = process.env) {
  const path = env.PG_TEST_SOCKET;
  if (!PG_TEST_SOCKET_PATTERN.test(path ?? "")) throw new Error("BENCHMARK_DISPOSABLE_PG_SOCKET_REQUIRED");
  const symlink = await lstat(path);
  const resolved = await realpath(path);
  const metadata = await stat(resolved);
  if (symlink.isSymbolicLink() || !resolved.startsWith("/private/tmp/tibotattle-pg-")
      || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid()) {
    throw new Error("BENCHMARK_DISPOSABLE_PG_SOCKET_REQUIRED");
  }
  const port = Number(env.PG_TEST_PORT ?? "55432");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("BENCHMARK_DISPOSABLE_PG_SOCKET_REQUIRED");
  return { host: resolved, port };
}

function createSourceFixture(rowCount, suffix) {
  const chunkCount = Math.ceil(rowCount / 200);
  const chunkIds = Array.from({ length: chunkCount }, (_, index) =>
    `synthetic-admission-${suffix}-chunk-${String(index).padStart(4, "0")}`);
  const allocations = chunkIds.map((chunkId, index) => {
    const firstRecord = index * 200;
    return {
      chunk_id: chunkId,
      namespace_id: 1,
      chunk_original: originalId(chunkId),
      first_source_row_id: firstRecord + 1,
      record_count: Math.min(200, rowCount - firstRecord),
    };
  });
  const firstTypedRecordId = 1001 + chunkCount;
  const admissions = Array.from({ length: rowCount }, (_, index) => ({
    typed_record_id: firstTypedRecordId + index,
    chunk_id: chunkIds[Math.floor(index / 200)],
  }));
  const recordIds = admissions.map((row) => String(row.typed_record_id));
  const sourceNamespace = `synthetic-admission-v1-${suffix}`;
  const v11SourceNamespace = `synthetic-admission-v11-${suffix}`;
  const tables = {
    typed_v1_admission_state: [{ id: 1, source_namespace: sourceNamespace, namespace_id: 1,
      runtime_contract_version: 1, next_source_row_id: rowCount + 1 }],
    typed_v11_admission_state: [{ id: 1, source_namespace: v11SourceNamespace, namespace_id: 1,
      runtime_contract_version: 1, next_source_row_id: 1 }],
    typed_v1_chunk_allocations: allocations,
    typed_v11_chunk_allocations: [],
    typed_v1_record_admissions: admissions,
    typed_v1_preservation_proofs: [],
    typed_v11_manifest_memberships: [],
    typed_v11_record_proofs: [],
    typed_v1_event_sources: [],
    storage_v11_event_sources: [],
  };
  return {
    source: createSyntheticLegacyAdmissionSource({
      tables,
      snapshotId: `synthetic-admission-profile-${suffix}`,
      expectedTypedRecordIds: { v1: recordIds, v11Ready: [] },
    }),
    sourceNamespace,
    v11SourceNamespace,
    chunkIds,
  };
}

async function insertRows(client, schema, table, columns, rows) {
  const qualified = `${quote(schema)}.${quote(table)}`;
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const params = [];
    const groups = batch.map((row) => `(${columns.map((column) => {
      params.push(row[column] ?? null);
      return `$${params.length}`;
    }).join(",")})`);
    const names = columns.map(quote).join(",");
    await client.query(`INSERT INTO ${qualified} (${names}) VALUES ${groups.join(",")}`, params);
  }
}

async function seedTarget(pool, schema, { rowCount, suffix, sourceNamespace, v11SourceNamespace, chunkIds }) {
  const namespace = quote(schema);
  const day = "2026-09-24";
  const dayNumber = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
  const now = new Date("2026-09-24T10:00:00.000Z");
  const later = new Date("2026-09-24T11:00:00.000Z");
  const participantId = `synthetic-admission-bench-participant-${suffix}`;
  const deviceId = `device:synthetic-admission-bench-${suffix}`;
  const ownerDigest = digest(`synthetic-admission-owner-${suffix}`);
  const chunks = chunkIds.map((chunkId, index) => {
    const firstRecord = index * 200;
    return {
      id: chunkId,
      participant_id: participantId,
      device_id: deviceId,
      stream: "session",
      chunk_day: day,
      chunk_seq: index,
      revision: 1,
      chunk_digest: digest(`synthetic-chunk-${suffix}-${index}`),
      envelope_digest: digest(`synthetic-envelope-${suffix}-${index}`),
      parser_version: "synthetic-admission-benchmark-v1",
      record_count: Math.min(200, rowCount - firstRecord),
      accepted_record_count: Math.min(200, rowCount - firstRecord),
      r2_key: `synthetic/${suffix}/${index}`,
      device_upload_authorization_id: `synthetic-upload-${suffix}-${index}`,
      created_at: now,
    };
  });
  const authorizations = chunks.map((chunk, index) => ({
    id: chunk.device_upload_authorization_id,
    participant_id: participantId,
    issued_by_device_id: deviceId,
    secret_hash: Buffer.alloc(32, 7),
    envelope_digest: chunk.envelope_digest,
    body_bytes: 1,
    content_type: "application/json",
    state: "consumed",
    issued_at: now,
    expires_at: later,
    consumed_at: now,
  }));
  const typedChunks = chunks.map((chunk, index) => ({
    id: 1001 + index,
    namespace_id: 1,
    format: 10,
    owner_id: 7,
    device_id: 8,
    manifest_id: null,
    original_id: originalId(chunk.id),
    stream: 3,
    chunk_day: dayNumber,
  }));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`INSERT INTO ${namespace}.participants (id,created_at) VALUES ($1,$2)`, [participantId, now]);
    await client.query(`INSERT INTO ${namespace}.device_credentials (
      id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,issued_at,expires_at,last_used_at
    ) VALUES ($1,$2,'accountless',$3,$4,'active',$5,$6,$5)`,
    [deviceId, participantId, `synthetic-enrollment-${suffix}`, Buffer.alloc(32, 3), now, later]);
    await client.query(`INSERT INTO ${namespace}.typed_telemetry_namespaces (id,original_id)
      VALUES (1,$1)`, [originalId(`synthetic-admission-namespace-${suffix}`)]);
    await client.query(`INSERT INTO ${namespace}.typed_telemetry_source_family_receipts
      (source_namespace,source_format,generation,source_digest,source_row_count,membership_row_count,reconciled_at)
      VALUES ($1,10,1,$3,${rowCount},1,clock_timestamp()),($2,11,1,$3,0,0,clock_timestamp())`,
    [sourceNamespace, v11SourceNamespace, digest(`synthetic-base-receipt-${suffix}`)]);
    await client.query(`INSERT INTO ${namespace}.typed_telemetry_owners (id,namespace_id,original_id)
      VALUES (7,1,$1)`, [originalId(`synthetic-owner-${suffix}`)]);
    await client.query(`INSERT INTO ${namespace}.typed_telemetry_owner_memberships
      (namespace_id,source_format,owner_id,participant_id,source_namespace)
      VALUES (1,10,7,$1,$2)`, [participantId, sourceNamespace]);
    await client.query(`INSERT INTO ${namespace}.typed_telemetry_devices (id,namespace_id,owner_id,original_id)
      VALUES (8,1,7,$1)`, [originalId(deviceId)]);
    await client.query(`INSERT INTO ${namespace}.typed_telemetry_dictionary (id,value)
      VALUES (900,'synthetic_admission_benchmark_provider')`);
    await insertRows(client, schema, "device_upload_authorizations", [
      "id", "participant_id", "issued_by_device_id", "secret_hash", "envelope_digest", "body_bytes",
      "content_type", "state", "issued_at", "expires_at", "consumed_at",
    ], authorizations);
    await insertRows(client, schema, "telemetry_v1_chunks", [
      "id", "participant_id", "device_id", "stream", "chunk_day", "chunk_seq", "revision", "chunk_digest",
      "envelope_digest", "parser_version", "record_count", "accepted_record_count", "r2_key",
      "device_upload_authorization_id", "created_at",
    ], chunks);
    await insertRows(client, schema, "typed_telemetry_chunks", [
      "id", "namespace_id", "format", "owner_id", "device_id", "manifest_id", "original_id", "stream", "chunk_day",
    ], typedChunks);

    for (let offset = 0; offset < rowCount; offset += INSERT_BATCH_SIZE) {
      const records = [];
      for (let index = offset; index < Math.min(rowCount, offset + INSERT_BATCH_SIZE); index += 1) {
        const observedAt = Date.parse(`${day}T10:00:00.000Z`) + index;
        records.push({
          id: 1001 + chunkIds.length + index,
          namespace_id: 1,
          format: 10,
          source_row_id: index + 1,
          owner_id: 7,
          device_id: 8,
          chunk_id: 1001 + Math.floor(index / 200),
          manifest_id: null,
          stream: 3,
          occurrence_id: originalId(`synthetic-occurrence-${suffix}-${index}`),
          observed_at_ms: observedAt,
          observed_day: dayNumber,
          provider_id: 900,
          canonical_digest: Buffer.from(digest(`synthetic-record-${suffix}-${index}`), "hex"),
        });
      }
      await insertRows(client, schema, "typed_telemetry_records", [
        "id", "namespace_id", "format", "source_row_id", "owner_id", "device_id", "chunk_id", "manifest_id",
        "stream", "occurrence_id", "observed_at_ms", "observed_day", "provider_id", "canonical_digest",
      ], records);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function instrumentPool(pool) {
  const metrics = { pageTransactions: 0, pageTransactionMs: 0 };
  return {
    metrics,
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      let started = null;
      let pageInsert = false;
      return {
        async query(...args) {
          const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
          const command = text.trim().toUpperCase();
          const result = await client.query(...args);
          if (command === "BEGIN") {
            started = performance.now();
            pageInsert = false;
          } else if (started !== null && command.startsWith("INSERT INTO")
              && POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT.some(({ name }) => text.includes(`."${name}"`))) {
            pageInsert = true;
          } else if (command === "COMMIT" && started !== null) {
            if (pageInsert) {
              metrics.pageTransactions += 1;
              metrics.pageTransactionMs += performance.now() - started;
            }
            started = null;
            pageInsert = false;
          } else if (command === "ROLLBACK") {
            started = null;
            pageInsert = false;
          }
          return result;
        },
        release(...args) { client.release(...args); },
      };
    },
  };
}

async function runProfile(pool, { rowCount, pageSize }) {
  const suffix = randomBytes(5).toString("hex");
  const targetSchema = `legacy_admission_bench_${suffix}`;
  const controlSchema = `typed_legacy_admission_transfer_${suffix}`;
  const fixture = createSourceFixture(rowCount, suffix);
  const sourceTotalRows = rowCount + fixture.chunkIds.length + 2;
  let targetCreated = false;
  let controlCreated = false;
  try {
    await pool.query(`CREATE SCHEMA ${quote(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quote(controlSchema)}`);
    controlCreated = true;
    await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
    await seedTarget(pool, targetSchema, { rowCount, suffix, ...fixture });

    const measuredPool = instrumentPool(pool);
    const started = performance.now();
    const result = await runPostgresLegacyAdmissionTransfer({
      source: fixture.source,
      destinationPool: measuredPool,
      targetSchema,
      controlSchema,
      transferId: `synthetic-admission-benchmark-${suffix}`,
      pageSize,
    });
    const elapsedMs = performance.now() - started;
    assert.equal(result.status, "staged_admission_lineage_transfer_complete");
    assert.equal(result.tableRows.typed_v1_record_admissions, rowCount);
    assert.equal(measuredPool.metrics.pageTransactions, result.pagesCommittedThisRun);
    const admissionTransactions = Math.ceil(rowCount / pageSize);
    return Object.freeze({
      rowCount,
      auxiliarySourceRows: sourceTotalRows - rowCount,
      pageSize,
      elapsedMs: Number(elapsedMs.toFixed(1)),
      admissionsPerSecond: Number((rowCount / (elapsedMs / 1000)).toFixed(1)),
      pagesCommitted: result.pagesCommittedThisRun,
      expectedAdmissionPageTransactions: admissionTransactions,
      admissionRowsTargetCompared: rowCount * 2,
      observedPageTransactionMs: Number(measuredPool.metrics.pageTransactionMs.toFixed(1)),
      averagePageTransactionMs: Number((measuredPool.metrics.pageTransactionMs / measuredPool.metrics.pageTransactions).toFixed(2)),
      fullKeysetSourcePasses: 4,
      syntheticFamily: "typed_v1_record_admissions (2 columns; zero proof rows)",
      productionReady: result.productionReady,
    });
  } finally {
    if (controlCreated) await pool.query(`DROP SCHEMA ${quote(controlSchema)} CASCADE`).catch(() => {});
    if (targetCreated) await pool.query(`DROP SCHEMA ${quote(targetSchema)} CASCADE`).catch(() => {});
  }
}

export async function runLegacyAdmissionTransferBench({ env = process.env, rowCounts, pageSizes } = {}) {
  if (env.PG_TEST_LEGACY_ADMISSION_BENCHMARK !== "1") throw new Error("BENCHMARK_EXPLICIT_OPT_IN_REQUIRED");
  rowCounts ??= selectedProfiles(env, "PG_TEST_LEGACY_ADMISSION_BENCH_ROWS", ROWS, ROWS);
  pageSizes ??= selectedProfiles(env, "PG_TEST_LEGACY_ADMISSION_BENCH_PAGE_SIZES", PAGE_SIZES, PAGE_SIZES);
  if (!Array.isArray(rowCounts) || rowCounts.some((value) => !ROWS.includes(value))) throw new Error("BENCHMARK_ROW_PROFILE_INVALID");
  if (!Array.isArray(pageSizes) || pageSizes.some((value) => !PAGE_SIZES.includes(value))) throw new Error("BENCHMARK_PAGE_PROFILE_INVALID");
  const socket = await localSocket(env);
  const pool = new pg.Pool({
    ...socket,
    user: env.PG_TEST_USER ?? "postgres",
    database: env.PG_TEST_DATABASE ?? "postgres",
    password: env.PG_TEST_PASSWORD ?? "synthetic-local-only",
    max: 4,
  });
  try {
    const locality = await pool.query("SELECT inet_server_addr()::text AS address, current_setting('server_version_num')::integer AS version_num");
    assert.equal(locality.rows[0]?.address, null, "benchmark requires a local Unix socket");
    assert.equal(Math.floor(locality.rows[0]?.version_num / 10_000), 17, "benchmark requires PostgreSQL 17");
    const profiles = [];
    for (const rowCount of rowCounts) {
      for (const pageSize of pageSizes) {
        profiles.push(await runProfile(pool, { rowCount, pageSize }));
      }
    }
    const inventoryRows = 9_450_000;
    const estimates = profiles.map((profile) => ({
      pageSize: profile.pageSize,
      estimatedDataPageTransactionsForInventory: Math.ceil(inventoryRows / profile.pageSize),
      v1AdmissionEquivalentRowScaledSeconds: Number((profile.elapsedMs / (profile.rowCount + profile.auxiliarySourceRows)
        * inventoryRows / 1000).toFixed(1)),
    }));
    return Object.freeze({
      benchmark: "postgres-legacy-admission-transfer-local-pg17-v1",
      syntheticOnly: true,
      pgMajor: 17,
      profileCount: profiles.length,
      profiles: Object.freeze(profiles),
      inventoryEstimate: Object.freeze({
        sourceRows: inventoryRows,
        estimates,
        warning: "Row-scaled seconds are v1 two-column equivalents, not a prediction for the mixed v1.1 proof workload or Cloud SQL. Page-transaction counts exclude small per-table/control commits.",
      }),
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLegacyAdmissionTransferBench().then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }).catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : "BENCHMARK_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
