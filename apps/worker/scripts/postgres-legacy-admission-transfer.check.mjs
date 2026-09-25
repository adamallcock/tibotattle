import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import pg from "pg";
import {
  POSTGRES_LEGACY_ADMISSION_DEFAULT_PAGE_SIZE,
  POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE,
  POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT,
  POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT,
  PostgresLegacyAdmissionTransferError,
  createSealedSqliteLegacyAdmissionSource,
  createSyntheticLegacyAdmissionSource,
  runPostgresLegacyAdmissionTransfer,
} from "./postgres-legacy-admission-transfer.mjs";
import { applyPostgresMigrations } from "./postgres-migrations.mjs";
import { runLegacyAdmissionTransferBench } from "./postgres-legacy-admission-transfer.bench.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");

function quote(value) {
  assert.match(value, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const symlink = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(symlink.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

function sourceTables({
  v1Namespace = "synthetic-admission-v1",
  v11Namespace = "synthetic-admission-v11",
  v1NextSourceRowId = 1,
  v1Allocations = [],
  v1Admissions = [],
  v1Events = [],
} = {}) {
  return {
    typed_v1_admission_state: [{ id: 1, source_namespace: v1Namespace, namespace_id: 1, runtime_contract_version: 1, next_source_row_id: v1NextSourceRowId }],
    typed_v11_admission_state: [{ id: 1, source_namespace: v11Namespace, namespace_id: 1, runtime_contract_version: 1, next_source_row_id: 1 }],
    typed_v1_chunk_allocations: v1Allocations,
    typed_v11_chunk_allocations: [],
    typed_v1_record_admissions: v1Admissions,
    typed_v1_preservation_proofs: [],
    typed_v11_manifest_memberships: [],
    typed_v11_record_proofs: [],
    typed_v1_event_sources: v1Events,
    storage_v11_event_sources: [],
  };
}

async function sealedMultiPageSource({ withAllocations = true, withHeaders = false,
  partialV1Header = false, missingHeaderTable = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "legacy-admission-sealed-"));
  const path = join(await realpath(directory), "source.sqlite");
  const database = new DatabaseSync(path);
  try {
    for (const spec of [...POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT, ...POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT]) {
      if (spec.name === missingHeaderTable) continue;
      const columns = spec.columns.map((column, index) => {
        const type = spec.types[index];
        const sqlType = type === "bytes" ? "BLOB" : type.startsWith("i") ? "INTEGER" : "TEXT";
        return `${quote(column)} ${sqlType}${spec.primaryKey.includes(column) ? " PRIMARY KEY" : ""}`;
      });
      database.exec(`CREATE TABLE ${quote(spec.name)} (${columns.join(",")})`);
    }
    if (withAllocations) {
      const spec = POSTGRES_LEGACY_ADMISSION_TRANSFER_LAYOUT.find((item) => item.name === "typed_v1_chunk_allocations");
      const insert = database.prepare(`INSERT INTO typed_v1_chunk_allocations(${spec.columns.map(quote).join(",")}) VALUES(${spec.columns.map(() => "?").join(",")})`);
      insert.run("chunk-a", 1, Buffer.from([0, 97]), 1, 1);
      insert.run("chunk-b", 1, Buffer.from([0, 98]), 2, 1);
    }
    const insertRows = (spec, rows) => {
      const insert = database.prepare(`INSERT INTO ${quote(spec.name)}(${spec.columns.map(quote).join(",")}) VALUES(${spec.columns.map(() => "?").join(",")})`);
      for (const row of rows) insert.run(...spec.columns.map((column) => row[column] ?? null));
    };
    if (withHeaders) {
      const headerNow = "2026-09-24T10:00:00.000Z";
      const v1Rows = partialV1Header ? [] : ["chunk-a", "chunk-b"].map((id, index) => ({
        id, participant_id: "synthetic-header-participant", device_id: "synthetic-header-device",
        stream: "usage", chunk_day: "2026-09-24", chunk_seq: index, revision: 1,
        chunk_digest: String(index + 1).repeat(64), envelope_digest: String(index + 3).repeat(64),
        parser_version: "synthetic-header-v1", record_count: 1, accepted_record_count: 1,
        r2_key: `synthetic/${id}`, device_upload_authorization_id: `synthetic-upload-${id}`,
        superseded_at: null, quarantine_deleted_at: null, created_at: headerNow,
      }));
      insertRows(POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT.find((item) => item.name === "telemetry_v1_chunks"), v1Rows);
      const manifestId = "00000000-0000-4000-8000-000000000011";
      const v11ChunkId = "chunk:00000000-0000-4000-8000-000000000012";
      const v11ChunkDigest = "f".repeat(64);
      const v11ManifestJson = JSON.stringify({
        schemaVersion: "telemetry-day-manifest-v1.1", day: "2026-09-24",
        chunks: [{ chunkId: v11ChunkId, chunkDigest: v11ChunkDigest, recordCount: 1 }],
      });
      insertRows(POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT.find((item) => item.name === "telemetry_v11_day_manifests"), [{
        id: manifestId, participant_id: "synthetic-header-participant", device_id: "synthetic-header-device",
        chunk_day: "2026-09-24", manifest_digest: "e".repeat(64), parser_version: "synthetic-header-v11",
        manifest_json: v11ManifestJson,
        expected_chunk_count: 1, state: "ready", created_at: headerNow, ready_at: headerNow,
      }]);
      insertRows(POSTGRES_LEGACY_ADMISSION_HEADER_LAYOUT.find((item) => item.name === "telemetry_v11_chunks"), [{
        id: v11ChunkId, manifest_id: manifestId, participant_id: "synthetic-header-participant",
        device_id: "synthetic-header-device", stream: "usage", chunk_day: "2026-09-24",
        chunk_seq: 0, chunk_id: v11ChunkId, chunk_digest: v11ChunkDigest,
        envelope_digest: "9".repeat(64), parser_version: "synthetic-header-v11", record_count: 1,
        r2_key: `synthetic/${v11ChunkId}`, device_upload_authorization_id: "synthetic-v11-upload",
        quarantine_deleted_at: null, created_at: headerNow,
      }]);
      const states = [
        { name: "typed_v1_admission_state", namespace: "synthetic-admission-v1" },
        { name: "typed_v11_admission_state", namespace: "synthetic-admission-v11" },
      ];
      for (const item of states) {
        database.prepare(`INSERT INTO ${quote(item.name)} (id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id) VALUES (1,?,1,1,1)`)
          .run(item.namespace);
      }
    }
    database.exec(`CREATE TABLE typed_v1_authority_requests(chunk_id TEXT PRIMARY KEY);
      CREATE TABLE typed_telemetry_records(id INTEGER PRIMARY KEY,format INTEGER,manifest_id INTEGER);
      CREATE TABLE typed_telemetry_chunks(id INTEGER PRIMARY KEY);
      CREATE TABLE typed_telemetry_manifests(id INTEGER PRIMARY KEY);
      CREATE TABLE telemetry_v11_records(chunk_id TEXT,manifest_id TEXT)`);
    const cursorPlan = database.prepare(`EXPLAIN QUERY PLAN
      SELECT chunk_id FROM typed_v1_chunk_allocations WHERE chunk_id > ? ORDER BY chunk_id LIMIT ?`).all("chunk-a", 1);
    assert.match(cursorPlan.map((row) => row.detail).join(" "), /SEARCH typed_v1_chunk_allocations USING (?:COVERING )?INDEX .*chunk_id>\?/u);
  } finally {
    database.close();
  }
  await chmod(path, 0o400);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  return { directory, path, digest };
}

test("sealed SQLite source pages past the first cursor and remains pinned", async () => {
  const fixture = await sealedMultiPageSource();
  let source;
  try {
    source = await createSealedSqliteLegacyAdmissionSource({ path: fixture.path, expectedSha256: fixture.digest });
    const first = await source.listPage({ table: "typed_v1_chunk_allocations", after: null, limit: 1 });
    assert.equal(first.rows[0].chunk_id, "chunk-a");
    const second = await source.listPage({ table: "typed_v1_chunk_allocations", after: ["chunk-a"], limit: 1 });
    assert.equal(second.rows[0].chunk_id, "chunk-b");
    assert.equal((await source.listPage({ table: "typed_v1_chunk_allocations", after: ["chunk-b"], limit: 1 })).rows.length, 0);
    assert.equal((await source.verifySnapshot()).artifactSha256, fixture.digest);
  } finally {
    source?.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("sealed source refuses missing header tables and partial chunk prerequisites before destination writes", async () => {
  const missing = await sealedMultiPageSource({ missingHeaderTable: "telemetry_v11_chunks" });
  try {
    await assert.rejects(createSealedSqliteLegacyAdmissionSource({ path: missing.path, expectedSha256: missing.digest }),
      (error) => error instanceof PostgresLegacyAdmissionTransferError && error.code === "LEGACY_ADMISSION_SOURCE_TABLE_MISSING");
  } finally { await rm(missing.directory, { recursive: true, force: true }); }

  const partial = await sealedMultiPageSource({ withAllocations: true, withHeaders: true, partialV1Header: true });
  let partialSource;
  let destinationTouched = false;
  try {
    partialSource = await createSealedSqliteLegacyAdmissionSource({ path: partial.path, expectedSha256: partial.digest });
    await assert.rejects(runPostgresLegacyAdmissionTransfer({
      source: partialSource,
      destinationPool: { query() { destinationTouched = true; }, connect() { destinationTouched = true; } },
      targetSchema: "legacy_admission_target_partial",
      controlSchema: "typed_legacy_admission_transfer_partialheader",
      transferId: "partial-header-refusal",
    }), (error) => error instanceof PostgresLegacyAdmissionTransferError
      && error.code === "LEGACY_ADMISSION_SOURCE_HEADER_INCOMPLETE");
    assert.equal(destinationTouched, false);
  } finally {
    partialSource?.close();
    await rm(partial.directory, { recursive: true, force: true });
  }
});

test("synthetic source fails closed for staged v1.1 manifest lineage and incomplete proofs", async () => {
  const stagedTables = sourceTables();
  stagedTables.typed_v11_manifest_memberships.push({ manifest_id: "synthetic-manifest", typed_manifest_id: 22 });
  const stagedSource = createSyntheticLegacyAdmissionSource({
    tables: stagedTables,
    snapshotId: "synthetic-staged-manifest",
    v11SourceManifests: [{ id: "synthetic-manifest", state: "staged", expectedChunkCount: 2, actualChunkCount: 1 }],
  });
  await assert.rejects(stagedSource.assertSourceReady(), (error) =>
    error instanceof PostgresLegacyAdmissionTransferError && error.code === "LEGACY_ADMISSION_STAGED_SOURCE_UNQUALIFIED");

  const readyTables = sourceTables();
  const readySource = createSyntheticLegacyAdmissionSource({
    tables: readyTables,
    snapshotId: "synthetic-ready-missing-proof",
    v11SourceManifests: [{ id: "synthetic-manifest", state: "ready", expectedChunkCount: 1, actualChunkCount: 1 }],
    expectedTypedRecordIds: { v1: [], v11Ready: [23] },
  });
  await assert.rejects(readySource.assertSourceReady(), (error) =>
    error instanceof PostgresLegacyAdmissionTransferError && error.code === "LEGACY_ADMISSION_SOURCE_PROOF_INCOMPLETE");
});

test("synthetic source keyset paging stays ordered across a large bounded fixture", async () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => {
    const chunkId = `synthetic-chunk-${String(index).padStart(5, "0")}`;
    return { chunk_id: chunkId, namespace_id: 1, chunk_original: Buffer.from([0, ...Buffer.from(chunkId)]),
      first_source_row_id: index + 1, record_count: 1 };
  });
  const source = createSyntheticLegacyAdmissionSource({
    tables: sourceTables({ v1Allocations: rows }),
    snapshotId: "synthetic-keyset-profile-source",
  });
  const observed = [];
  let after = null;
  for (;;) {
    const page = await source.listPage({ table: "typed_v1_chunk_allocations", after, limit: 249 });
    assert.ok(page.rows.length <= 249);
    if (page.rows.length === 0) break;
    observed.push(...page.rows.map((row) => row.chunk_id));
    after = [page.rows.at(-1).chunk_id];
    if (page.rows.length < 249) break;
  }
  assert.equal(observed.length, rows.length);
  assert.deepEqual(observed, rows.map((row) => row.chunk_id));
  assert.ok(POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE >= 250);
});

test("importer page size is bounded and benchmark is opt-in", async () => {
  assert.equal(POSTGRES_LEGACY_ADMISSION_DEFAULT_PAGE_SIZE, 100);
  assert.equal(POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE, 250);
  let destinationTouched = false;
  await assert.rejects(
    runPostgresLegacyAdmissionTransfer({
      destinationPool: { query() { destinationTouched = true; }, connect() { destinationTouched = true; } },
      targetSchema: "target_schema",
      controlSchema: "typed_legacy_admission_transfer_synthetic",
      transferId: "synthetic-invalid-page-size",
      pageSize: POSTGRES_LEGACY_ADMISSION_MAX_PAGE_SIZE + 1,
    }),
    (error) => error instanceof PostgresLegacyAdmissionTransferError
      && error.code === "LEGACY_ADMISSION_PAGE_SIZE_INVALID",
  );
  assert.equal(destinationTouched, false);
  await assert.rejects(runLegacyAdmissionTransferBench({ env: {} }), /BENCHMARK_EXPLICIT_OPT_IN_REQUIRED/u);
});

test("PG17 transfer requires both base receipts, checkpoints pages, resumes, and keeps receipt historical", { skip: !PG_TEST_SOCKET }, async () => {
  const socket = await localSocket();
  const suffix = randomBytes(6).toString("hex");
  const targetSchema = `legacy_admission_target_${suffix}`;
  const controlSchema = `typed_legacy_admission_transfer_${suffix}`;
  const pool = new pg.Pool({ ...socket, user: process.env.PG_TEST_USER ?? "postgres", database: process.env.PG_TEST_DATABASE ?? "postgres", password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", max: 4 });
  let targetCreated = false;
  let controlCreated = false;
  try {
    const locality = await pool.query("SELECT inet_server_addr()::text AS address, current_setting('server_version_num')::integer AS version_num");
    assert.equal(locality.rows[0]?.address, null);
    assert.equal(Math.floor(locality.rows[0]?.version_num / 10_000), 17);
    await pool.query(`CREATE SCHEMA ${quote(targetSchema)}`);
    targetCreated = true;
    await pool.query(`CREATE SCHEMA ${quote(controlSchema)}`);
    controlCreated = true;
    const migration = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
    assert.equal(migration.applied, 41);
    await pool.query(`INSERT INTO ${quote(targetSchema)}.typed_telemetry_namespaces(id,original_id) VALUES(1,$1)`, [Buffer.from([1, 2])]);
    await pool.query(`INSERT INTO ${quote(targetSchema)}.typed_telemetry_source_family_receipts
      (source_namespace,source_format,generation,source_digest,source_row_count,membership_row_count,reconciled_at)
      VALUES ($1,10,1,$3,0,0,clock_timestamp()),($2,11,1,$3,0,0,clock_timestamp())`, ["synthetic-admission-v1", "synthetic-admission-v11", "a".repeat(64)]);

    const participantId = "synthetic-admission-participant";
    const ownerDigest = "b".repeat(64);
    const deviceId = `device:${randomUUID()}`;
    const chunkIds = [`chunk:${randomUUID()}`, `chunk:${randomUUID()}`];
    const uploadIds = [randomUUID(), randomUUID()];
    const eventDigests = ["c".repeat(64), "d".repeat(64)];
    const namespace = quote(targetSchema);
    const namespaced = (name) => `${namespace}.${quote(name)}`;
    const date = "2026-09-24";
    const dayNumber = Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
    const original = (value) => Buffer.concat([Buffer.from([0]), Buffer.from(value)]);
    const insertNow = new Date("2026-09-24T10:00:00.000Z");
    const insertLater = new Date("2026-09-24T11:00:00.000Z");
    await pool.query("BEGIN");
    try {
      await pool.query("SET LOCAL session_replication_role = replica");
      await pool.query(`INSERT INTO ${namespaced("participants")} (id,created_at) VALUES ($1,$2)`, [participantId, insertNow]);
      await pool.query(`INSERT INTO ${namespaced("storage_v11_owner_links")} (participant_id,owner_digest,state)
        VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
      await pool.query(`INSERT INTO ${namespaced("device_credentials")} (
        id,participant_id,authority_kind,accountless_enrollment_device_id,secret_hash,state,issued_at,expires_at,last_used_at
      ) VALUES ($1,$2,'accountless',$3,$4,'active',$5,$6,$5)`,
      [deviceId, participantId, "synthetic-admission-enrollment", Buffer.alloc(32, 1), insertNow, insertLater]);
      for (let index = 0; index < chunkIds.length; index += 1) {
        const chunkDigest = createHash("sha256").update(`chunk:${index}`).digest("hex");
        const envelopeDigest = createHash("sha256").update(`envelope:${index}`).digest("hex");
        await pool.query(`INSERT INTO ${namespaced("device_upload_authorizations")} (
          id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,state,issued_at,expires_at,consumed_at
        ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7,$6)`,
        [uploadIds[index], participantId, deviceId, Buffer.alloc(32, index + 2), envelopeDigest, insertNow, insertLater]);
        await pool.query(`INSERT INTO ${namespaced("telemetry_v1_chunks")} (
          id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,parser_version,
          record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at
        ) VALUES ($1,$2,$3,'session',$4::date,$5,1,$6,$7,'synthetic-legacy-admission-v1',1,1,$8,$9,$10)`,
        [chunkIds[index], participantId, deviceId, date, index, chunkDigest, envelopeDigest,
          `synthetic/${chunkIds[index]}`, uploadIds[index], insertNow]);
      }
      await pool.query(`INSERT INTO ${namespaced("typed_telemetry_owners")} (id,namespace_id,original_id)
        VALUES (7,1,$1)`, [original("owner:synthetic")]);
      await pool.query(`INSERT INTO ${namespaced("typed_telemetry_owner_memberships")} (
        namespace_id,source_format,owner_id,participant_id,source_namespace
      ) VALUES (1,10,7,$1,'synthetic-admission-v1')`, [participantId]);
      await pool.query(`INSERT INTO ${namespaced("typed_telemetry_devices")} (id,namespace_id,owner_id,original_id)
        VALUES (8,1,7,$1)`, [original(deviceId)]);
      await pool.query(`INSERT INTO ${namespaced("typed_telemetry_chunks")} (
        id,namespace_id,format,owner_id,device_id,manifest_id,original_id,stream,chunk_day
      ) VALUES (1001,1,10,7,8,NULL,$1,3,$2),(1002,1,10,7,8,NULL,$3,3,$2)`,
      [original(chunkIds[0]), dayNumber, original(chunkIds[1])]);
      await pool.query(`INSERT INTO ${namespaced("typed_telemetry_dictionary")} (id,value)
        VALUES (900,'synthetic_provider')`);
      for (let index = 0; index < 2; index += 1) {
        const observedAt = Date.parse(`${date}T10:00:0${index}.000Z`);
        await pool.query(`INSERT INTO ${namespaced("typed_telemetry_records")} (
          id,namespace_id,format,source_row_id,owner_id,device_id,chunk_id,manifest_id,stream,occurrence_id,
          observed_at_ms,observed_day,provider_id,canonical_digest
        ) VALUES ($1,1,10,$2,7,8,$3,NULL,3,$4,$5,$6,900,$7)`,
        [1001 + index, index + 1, 1001 + index, original(`occurrence:${index}`), observedAt, dayNumber,
          createHash("sha256").update(`record:${index}`).digest()]);
      }
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    const v1Allocations = chunkIds.map((chunkId, index) => ({
      chunk_id: chunkId, namespace_id: 1, chunk_original: original(chunkId), first_source_row_id: index + 1, record_count: 1,
    }));
    const v1Admissions = chunkIds.map((chunkId, index) => ({ typed_record_id: 1001 + index, chunk_id: chunkId }));
    const v1Events = chunkIds.map((chunkId, index) => ({
      event_digest: eventDigests[index], owner_digest: ownerDigest, participant_id: participantId,
      chunk_id: chunkId, source_namespace: "synthetic-admission-v1",
    }));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${namespaced("telemetry_v1_records")}`)).rows[0]?.n, 0,
      "the typed-only fixture has no legacy JSON v1 records");

    const transfer = {
      source: createSyntheticLegacyAdmissionSource({
        tables: sourceTables({ v1NextSourceRowId: 3, v1Allocations, v1Admissions, v1Events }),
        snapshotId: "synthetic-admission-snapshot-v1",
        expectedTypedRecordIds: { v1: ["1001", "1002"], v11Ready: [] },
      }),
      destinationPool: pool,
      targetSchema,
      controlSchema,
      transferId: "synthetic-admission-transfer-v1",
      pageSize: 1,
    };

    const missingReceiptSource = createSyntheticLegacyAdmissionSource({
      tables: sourceTables({ v11Namespace: "synthetic-admission-v11-unreceipted" }),
      snapshotId: "synthetic-admission-snapshot-without-v11-receipt",
    });
    await assert.rejects(
      runPostgresLegacyAdmissionTransfer({ ...transfer, source: missingReceiptSource, transferId: "synthetic-admission-no-base-receipt" }),
      (error) => error instanceof PostgresLegacyAdmissionTransferError && error.code === "LEGACY_ADMISSION_BASE_RECEIPT_REQUIRED",
    );
    assert.equal((await pool.query("SELECT to_regclass($1) AS run_table", [`${controlSchema}._legacy_admission_transfer_runs_v1`])).rows[0]?.run_table, null,
      "a source rejected before destination writes does not create its transfer journal");

    await pool.query(`CREATE FUNCTION ${quote(targetSchema)}.fail_admission_v11_state()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_admission_page_failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_admission_v11_state BEFORE INSERT ON ${quote(targetSchema)}.typed_v11_admission_state
      FOR EACH ROW EXECUTE FUNCTION ${quote(targetSchema)}.fail_admission_v11_state()`);
    await assert.rejects(runPostgresLegacyAdmissionTransfer(transfer), /synthetic_admission_page_failure/u);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.typed_v1_admission_state`)).rows[0]?.n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.typed_v11_admission_state`)).rows[0]?.n, 0);
    const firstCheckpoint = await pool.query(`SELECT complete,row_count::int FROM ${quote(controlSchema)}._legacy_admission_transfer_checkpoints_v1
      WHERE transfer_id=$1 AND table_name='typed_v1_admission_state'`, [transfer.transferId]);
    assert.deepEqual(firstCheckpoint.rows[0], { complete: true, row_count: 1 });
    const failedCheckpoint = await pool.query(`SELECT count(*)::int AS n FROM ${quote(controlSchema)}._legacy_admission_transfer_checkpoints_v1
      WHERE transfer_id=$1 AND table_name='typed_v11_admission_state'`, [transfer.transferId]);
    assert.equal(failedCheckpoint.rows[0]?.n, 0);

    await pool.query(`DROP TRIGGER fail_admission_v11_state ON ${quote(targetSchema)}.typed_v11_admission_state`);
    await pool.query(`DROP FUNCTION ${quote(targetSchema)}.fail_admission_v11_state()`);
    const completed = await runPostgresLegacyAdmissionTransfer(transfer);
    assert.equal(completed.status, "staged_admission_lineage_transfer_complete");
    assert.equal(completed.postgresMajor, 17);
    assert.equal(completed.productionReady, false);
    assert.equal(completed.readerActivationAuthorized, false);
    assert.equal(completed.erasureAuthorized, false);
    assert.equal(completed.tableRows.typed_v1_admission_state, 1);
    assert.equal(completed.tableRows.storage_v11_event_sources, 0);
    assert.equal(completed.tableRows.typed_v1_chunk_allocations, 2);
    assert.equal(completed.tableRows.typed_v1_record_admissions, 2);
    assert.equal(completed.tableRows.typed_v1_event_sources, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${namespaced("telemetry_v1_records")}`)).rows[0]?.n, 0,
      "typed admission transfer does not synthesize raw JSON records");
    const eventCheckpoint = await pool.query(`SELECT row_count::int,page_count::int,complete
      FROM ${quote(controlSchema)}._legacy_admission_transfer_checkpoints_v1
      WHERE transfer_id=$1 AND table_name='typed_v1_event_sources'`, [transfer.transferId]);
    assert.deepEqual(eventCheckpoint.rows[0], { row_count: 2, page_count: 2, complete: true },
      "two source events commit as two resumable keyset pages");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.typed_telemetry_admission_transfer_receipts`)).rows[0]?.n, 1);

    const replay = await runPostgresLegacyAdmissionTransfer(transfer);
    assert.equal(replay.pagesCommittedThisRun, 0);
    assert.equal(replay.lineageManifestSha256, completed.lineageManifestSha256);

    await pool.query("BEGIN");
    try {
      await pool.query("SET LOCAL session_replication_role = replica");
      await pool.query(`INSERT INTO ${quote(targetSchema)}.typed_v1_event_sources
        (event_digest,owner_digest,participant_id,chunk_id,source_namespace)
        VALUES ($1,$2,'synthetic-orphan-participant','synthetic-orphan-chunk',$3)`,
      ["b".repeat(64), "c".repeat(64), "synthetic-admission-v1"]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      runPostgresLegacyAdmissionTransfer({ ...transfer, transferId: "synthetic-admission-extra-target-row" }),
      (error) => error instanceof PostgresLegacyAdmissionTransferError
        && error.code === "LEGACY_ADMISSION_DESTINATION_PARITY_FAILED",
      "an extra row in the source namespace must block the completion receipt",
    );
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${quote(targetSchema)}.typed_telemetry_admission_transfer_receipts`)).rows[0]?.n, 1);

    await pool.query("BEGIN");
    try {
      await pool.query("SET LOCAL session_replication_role = replica");
      await pool.query(`DELETE FROM ${quote(targetSchema)}.typed_v1_event_sources WHERE event_digest=$1`, ["b".repeat(64)]);
      await pool.query(`UPDATE ${quote(targetSchema)}.typed_telemetry_admission_transfer_receipts
        SET table_row_counts='{}'::jsonb WHERE transfer_id=$1`, [transfer.transferId]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      runPostgresLegacyAdmissionTransfer(transfer),
      (error) => error instanceof PostgresLegacyAdmissionTransferError
        && error.code === "LEGACY_ADMISSION_RECEIPT_MISMATCH",
      "an existing receipt with altered table counts must fail closed on replay",
    );

    await pool.query(`INSERT INTO ${quote(targetSchema)}.typed_v1_chunk_allocations
      (chunk_id,namespace_id,chunk_original,first_source_row_id,record_count) VALUES('missing-parent',1,$1,1,1)`, [Buffer.from([0, ...Buffer.from("missing-parent")])])
      .then(() => assert.fail("missing raw chunk unexpectedly admitted"), (error) => assert.equal(error.code, "P1005"));
  } finally {
    if (controlCreated) await pool.query(`DROP SCHEMA ${quote(controlSchema)} CASCADE`).catch(() => {});
    if (targetCreated) await pool.query(`DROP SCHEMA ${quote(targetSchema)} CASCADE`).catch(() => {});
    await pool.end();
  }
});

test("PG17 stages exact sealed headers with a replay-safe control receipt before admission writes", { skip: !PG_TEST_SOCKET }, async () => {
  const fixture = await sealedMultiPageSource({ withAllocations: false, withHeaders: true });
  let source;
  const socket = await localSocket();
  const suffix = randomBytes(6).toString("hex");
  const targetSchema = "legacy_header_target_" + suffix;
  const controlSchema = "typed_legacy_admission_transfer_header_" + suffix;
  const pool = new pg.Pool({ ...socket, user: process.env.PG_TEST_USER ?? "postgres", database: process.env.PG_TEST_DATABASE ?? "postgres", password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", max: 4 });
  let targetCreated = false;
  let controlCreated = false;
  try {
    source = await createSealedSqliteLegacyAdmissionSource({ path: fixture.path, expectedSha256: fixture.digest });
    const locality = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(locality.rows[0]?.address, null);
    await pool.query("CREATE SCHEMA " + quote(targetSchema));
    targetCreated = true;
    await pool.query("CREATE SCHEMA " + quote(controlSchema));
    controlCreated = true;
    const migration = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
    assert.equal(migration.applied, 41);
    const target = quote(targetSchema);
    await pool.query("INSERT INTO " + target + ".typed_telemetry_namespaces(id,original_id) VALUES(1,$1)", [Buffer.from([1, 2])]);
    await pool.query("INSERT INTO " + target + ".typed_telemetry_source_family_receipts " +
      "(source_namespace,source_format,generation,source_digest,source_row_count,membership_row_count,reconciled_at) " +
      "VALUES ($1,10,1,$3,0,0,clock_timestamp()),($2,11,1,$3,0,0,clock_timestamp())",
    ["synthetic-admission-v1", "synthetic-admission-v11", "a".repeat(64)]);

    let interruptReceipt = true;
    const interruptedPool = {
      async query(sql, values) {
        if (interruptReceipt && typeof sql === "string"
            && sql.startsWith("INSERT INTO ") && sql.includes("_legacy_admission_header_receipts_v1")) {
          interruptReceipt = false;
          throw new Error("synthetic_header_stage_interruption");
        }
        return pool.query(sql, values);
      },
      async connect() {
        const client = await pool.connect();
        return {
          async query(...args) {
            const [sql, values] = args;
            if (interruptReceipt && typeof sql === "string"
                && sql.startsWith("INSERT INTO ") && sql.includes("_legacy_admission_header_receipts_v1")) {
              interruptReceipt = false;
              throw new Error("synthetic_header_stage_interruption");
            }
            return client.query(...args);
          },
          release(...args) { return client.release(...args); },
        };
      },
    };
    const transfer = {
      source, destinationPool: interruptedPool, targetSchema, controlSchema,
      transferId: "sealed-header-stage-v1", pageSize: 1,
    };
    await assert.rejects(runPostgresLegacyAdmissionTransfer(transfer), /synthetic_header_stage_interruption/u);
    const v1Stage = quote(controlSchema) + "._legacy_source_telemetry_v1_chunks_v1";
    const v11ManifestStage = quote(controlSchema) + "._legacy_source_telemetry_v11_day_manifests_v1";
    const v11ChunkStage = quote(controlSchema) + "._legacy_source_telemetry_v11_chunks_v1";
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM " + v1Stage)).rows[0]?.n, 2);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM " + v11ManifestStage)).rows[0]?.n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM " + v11ChunkStage)).rows[0]?.n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM " + target + ".typed_v1_admission_state")).rows[0]?.n, 0,
      "the interruption is before any admission-table write");
    assert.equal((await pool.query("SELECT to_regclass($1) AS name", [
      `${controlSchema}._legacy_admission_header_receipts_v1`,
    ])).rows[0]?.name, null,
    "the interrupted receipt transaction rolls back its table and receipt atomically");

    const completed = await runPostgresLegacyAdmissionTransfer({ ...transfer, destinationPool: pool });
    assert.equal(completed.status, "staged_admission_lineage_transfer_complete");
    assert.equal(completed.productionReady, false);
    assert.equal(completed.readerActivationAuthorized, false);
    assert.equal(completed.erasureAuthorized, false);
    assert.deepEqual(completed.sourceHeaderTableRows, {
      telemetry_v1_chunks: 2, telemetry_v11_day_manifests: 1, telemetry_v11_chunks: 1,
    });
    assert.match(completed.sourceHeaderManifestSha256, /^[0-9a-f]{64}$/u);
    const receipt = await pool.query("SELECT source_snapshot_id,source_snapshot_sha256,header_manifest_sha256,header_table_row_counts " +
      "FROM " + quote(controlSchema) + "._legacy_admission_header_receipts_v1 WHERE transfer_id=$1",
    [transfer.transferId]);
    assert.equal(receipt.rows[0]?.source_snapshot_id, "sha256:" + fixture.digest);
    assert.equal(receipt.rows[0]?.source_snapshot_sha256, fixture.digest);
    assert.equal(receipt.rows[0]?.header_manifest_sha256, completed.sourceHeaderManifestSha256);
    assert.deepEqual(receipt.rows[0]?.header_table_row_counts, completed.sourceHeaderTableRows);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM " + target + ".telemetry_v1_chunks")).rows[0]?.n, 0,
      "mirrored historical headers never enter the application tables");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM " + target + ".telemetry_v11_day_manifests")).rows[0]?.n, 0);

    await assert.rejects(pool.query("UPDATE " + v1Stage + " SET stream='quota' WHERE id='chunk-a'"),
      (error) => error?.code === "P1005");
    await assert.rejects(pool.query("UPDATE " + quote(controlSchema) +
      "._legacy_admission_header_receipts_v1 SET header_manifest_sha256=$2 WHERE transfer_id=$1",
    [transfer.transferId, "f".repeat(64)]), (error) => error?.code === "P1005");
    const replay = await runPostgresLegacyAdmissionTransfer({ ...transfer, destinationPool: pool });
    assert.equal(replay.pagesCommittedThisRun, 0);
    assert.equal(replay.sourceHeaderManifestSha256, completed.sourceHeaderManifestSha256);
  } finally {
    source?.close();
    if (controlCreated) await pool.query("DROP SCHEMA IF EXISTS " + quote(controlSchema) + " CASCADE").catch(() => {});
    if (targetCreated) await pool.query("DROP SCHEMA IF EXISTS " + quote(targetSchema) + " CASCADE").catch(() => {});
    await pool.end();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("PG17 manifest membership guard rejects participant and owner mismatches", { skip: !PG_TEST_SOCKET }, async () => {
  const socket = await localSocket();
  const suffix = randomBytes(6).toString("hex");
  const schema = `legacy_admission_guard_${suffix}`;
  const pool = new pg.Pool({ ...socket, user: process.env.PG_TEST_USER ?? "postgres", database: process.env.PG_TEST_DATABASE ?? "postgres", password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", max: 2 });
  try {
    const migrationSql = await readFile(new URL("../postgres/migrations/primary/0033_legacy_admission_proofs.sql", import.meta.url), "utf8");
    await pool.query(`CREATE SCHEMA ${quote(schema)}`);
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${quote(schema)},pg_catalog`);
      await client.query(`CREATE TABLE typed_telemetry_namespaces(id bigint PRIMARY KEY);
        CREATE TABLE typed_telemetry_source_family_receipts(source_namespace text,source_format smallint,PRIMARY KEY(source_namespace,source_format));
        CREATE TABLE typed_telemetry_records(id bigint PRIMARY KEY,namespace_id bigint,format smallint,source_row_id bigint,owner_id bigint,device_id bigint,chunk_id bigint,manifest_id bigint,stream smallint,occurrence_id bytea,observed_at_ms bigint,canonical_digest bytea);
        CREATE TABLE typed_telemetry_chunks(id bigint PRIMARY KEY,manifest_id bigint);
        CREATE TABLE typed_telemetry_manifests(id bigint PRIMARY KEY,namespace_id bigint,owner_id bigint,device_id bigint,original_id bytea,chunk_day integer);
        CREATE TABLE typed_telemetry_devices(id bigint PRIMARY KEY,namespace_id bigint,owner_id bigint,original_id bytea);
        CREATE TABLE typed_telemetry_owner_memberships(namespace_id bigint,source_format smallint,owner_id bigint,participant_id text,source_namespace text,PRIMARY KEY(namespace_id,source_format,owner_id));
        CREATE TABLE telemetry_v1_chunks(id text PRIMARY KEY,record_count integer,participant_id text,device_id text,stream text,chunk_day text);
        CREATE TABLE telemetry_v1_records(id bigint PRIMARY KEY,chunk_row_id text,participant_id text,device_id text,stream text);
        CREATE TABLE telemetry_v11_chunks(id text PRIMARY KEY,manifest_id text,record_count integer,participant_id text,device_id text,stream text);
        CREATE TABLE telemetry_v11_records(chunk_id text,manifest_id text,stream text,occurrence_id text,observed_at timestamptz,legacy_occurrence_id text);
        CREATE TABLE telemetry_v11_day_manifests(id text PRIMARY KEY,participant_id text,device_id text)`);
      await client.query(migrationSql);
      const manifestOne = "00000000-0000-4000-8000-000000000001";
      const manifestTwo = "00000000-0000-4000-8000-000000000002";
      const encode = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text)]);
      await client.query("INSERT INTO typed_telemetry_namespaces VALUES(1)");
      await client.query("INSERT INTO typed_v11_admission_state VALUES(1,'synthetic-v11',1,1,1)");
      await client.query("INSERT INTO telemetry_v11_day_manifests VALUES($1,'source-participant','source-device'),($2,'source-participant','source-device')", [manifestOne, manifestTwo]);
      await client.query("INSERT INTO typed_telemetry_devices VALUES(8,1,7,$1)", [encode("source-device")]);
      await client.query("INSERT INTO typed_telemetry_owner_memberships VALUES(1,11,7,'other-participant','synthetic-v11')");
      await client.query("INSERT INTO typed_telemetry_manifests VALUES(10,1,7,8,$1,20720)", [encode(manifestOne)]);
      await client.query("INSERT INTO typed_telemetry_records VALUES(12,1,11,1,7,8,100,10,1,$1,1780000000000,$2)", [encode("occurrence-00000001"), Buffer.alloc(32, 1)]);
      await assert.rejects(
        client.query("INSERT INTO typed_v11_manifest_memberships VALUES($1,10)", [manifestOne]),
        (error) => error.code === "P1005",
      );

      await client.query("INSERT INTO typed_telemetry_owner_memberships VALUES(1,11,8,'source-participant','synthetic-v11')");
      await client.query("INSERT INTO typed_telemetry_manifests VALUES(11,1,9,8,$1,20720)", [encode(manifestTwo)]);
      await client.query("INSERT INTO typed_telemetry_records VALUES(13,1,11,2,9,8,101,11,1,$1,1780000000000,$2)", [encode("occurrence-00000002"), Buffer.alloc(32, 2)]);
      await assert.rejects(
        client.query("INSERT INTO typed_v11_manifest_memberships VALUES($1,11)", [manifestTwo]),
        (error) => error.code === "P1005",
      );
    } finally { client.release(); }
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => {});
    await pool.end();
  }
});
