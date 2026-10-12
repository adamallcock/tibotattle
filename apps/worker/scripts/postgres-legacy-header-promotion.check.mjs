import assert from "node:assert/strict";
import { copyFile, lstat, mkdtemp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import {
  createSyntheticLegacyAdmissionSource,
  runPostgresLegacyAdmissionTransfer,
} from "./postgres-legacy-admission-transfer.mjs";
import { applyPostgresMigrations, POSTGRES_MIGRATION_ROOT } from "./postgres-migrations.mjs";
import {
  PostgresLegacyHeaderPromotionError,
  runPostgresLegacyHeaderPromotion,
} from "./postgres-legacy-header-promotion.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");

test("promotion refuses non-rehearsal targets and invalid bounded input before database access", async () => {
  let databaseAccessed = false;
  const pool = {
    async query() { databaseAccessed = true; throw new Error("unexpected database access"); },
    async connect() { databaseAccessed = true; throw new Error("unexpected database access"); },
  };
  await assert.rejects(runPostgresLegacyHeaderPromotion({
    pool, targetSchema: "tibotattle_v12_a2_20260925",
    controlSchema: "typed_legacy_admission_transfer_12345678", transferId: "synthetic-v1",
  }), (error) => error instanceof PostgresLegacyHeaderPromotionError
    && error.code === "LEGACY_HEADER_PROMOTION_SCHEMA_INVALID");
  await assert.rejects(runPostgresLegacyHeaderPromotion({
    pool, targetSchema: "typed_legacy_target_12345678",
    controlSchema: "typed_legacy_admission_transfer_12345678", transferId: "synthetic-v1", pageSize: 251,
  }), (error) => error instanceof PostgresLegacyHeaderPromotionError
    && error.code === "LEGACY_HEADER_PROMOTION_PAGE_SIZE_INVALID");
  assert.equal(databaseAccessed, false);
});

function quote(value) {
  assert.match(value, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${value}"`;
}

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const socket = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(socket.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

function headerFixture() {
  const headerAt = "2026-09-24T10:00:00.000Z";
  const participantId = "synthetic-header-participant";
  const deviceId = "synthetic-header-device";
  const v1 = ["chunk-a", "chunk-b"].map((id, index) => ({
    id, participant_id: participantId, device_id: deviceId, stream: "usage",
    chunk_day: "2026-09-24", chunk_seq: index, revision: 1,
    chunk_digest: String(index + 1).repeat(64), envelope_digest: String(index + 3).repeat(64),
    parser_version: "synthetic-header-v1", record_count: 1, accepted_record_count: 1,
    r2_key: `synthetic/${id}`, device_upload_authorization_id: `synthetic-upload-${id}`,
    superseded_at: null, quarantine_deleted_at: null, created_at: headerAt,
  }));
  const manifestId = "00000000-0000-4000-8000-000000000011";
  const chunkId = "chunk:00000000-0000-4000-8000-000000000012";
  const chunkDigest = "f".repeat(64);
  const manifestJson = JSON.stringify({
    schemaVersion: "telemetry-day-manifest-v1.1", day: "2026-09-24",
    chunks: [{ chunkId, chunkDigest, recordCount: 1 }],
  });
  const v11Manifests = [{
    id: manifestId, participant_id: participantId, device_id: deviceId,
    chunk_day: "2026-09-24", manifest_digest: "e".repeat(64), parser_version: "synthetic-header-v11",
    manifest_json: manifestJson, expected_chunk_count: 1, state: "ready",
    created_at: headerAt, ready_at: headerAt,
  }];
  const v11Chunks = [{
    id: chunkId, manifest_id: manifestId, participant_id: participantId, device_id: deviceId,
    stream: "usage", chunk_day: "2026-09-24", chunk_seq: 0, chunk_id: chunkId,
    chunk_digest: chunkDigest, envelope_digest: "9".repeat(64), parser_version: "synthetic-header-v11",
    record_count: 1, r2_key: `synthetic/${chunkId}`, device_upload_authorization_id: "synthetic-v11-upload",
    quarantine_deleted_at: null, created_at: headerAt,
  }];
  return { participantId, deviceId, tables: {
    typed_v1_admission_state: [{ id: 1, source_namespace: "synthetic-admission-v1", namespace_id: 1,
      runtime_contract_version: 1, next_source_row_id: 1 }],
    typed_v11_admission_state: [{ id: 1, source_namespace: "synthetic-admission-v11", namespace_id: 1,
      runtime_contract_version: 1, next_source_row_id: 1 }],
    telemetry_v1_chunks: v1,
    telemetry_v11_day_manifests: v11Manifests,
    telemetry_v11_chunks: v11Chunks,
  } };
}

async function applyThroughVersion(pool, targetSchema, version) {
  const root = await mkdtemp(join(tmpdir(), `legacy-header-migrations-v${version}-`));
  try {
    const primary = join(root, "primary");
    await mkdir(primary, { recursive: true });
    const canonical = join(POSTGRES_MIGRATION_ROOT, "primary");
    const entries = (await readdir(canonical)).filter((name) => Number(name.slice(0, 4)) <= version).sort();
    assert.equal(entries.length, version);
    for (const name of entries) await copyFile(join(canonical, name), join(primary, name));
    const applied = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool, rootDirectory: root });
    assert.equal(applied.applied, version);
    return applied;
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function seedAuthority(pool, schema, participantId, deviceId, suffix) {
  const target = quote(schema);
  const now = new Date();
  const expires = new Date(now.getTime() + 86_400_000);
  const sessionId = `synthetic-session-${suffix}`;
  const pairingId = `synthetic-pairing-${suffix}`;
  await pool.query(`INSERT INTO ${target}.participants(id,owner_kind,state,created_at)
    VALUES($1,'social','active',$2) ON CONFLICT(id) DO NOTHING`, [participantId, now]);
  await pool.query(`INSERT INTO ${target}.web_sessions(
    id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at
  ) VALUES($1,$2,$3,$3,'personal','active',$4,$5,$4)`, [sessionId, participantId, Buffer.alloc(32, 1), now, expires]);
  await pool.query(`INSERT INTO ${target}.device_pairings(
    id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,issued_at,expires_at
  ) VALUES($1,$2,$3,$4,'synthetic-consent','synthetic-transport',$5,$6)`,
  [pairingId, participantId, sessionId, Buffer.alloc(32, 2), now, expires]);
  await pool.query(`INSERT INTO ${target}.device_credentials(
    id,participant_id,paired_via_pairing_id,secret_hash,issued_at,expires_at,last_used_at
  ) VALUES($1,$2,$3,$4,$5,$6,$5)`, [deviceId, participantId, pairingId, Buffer.alloc(32, 3), now, expires]);
}

function interruptingPool(pool) {
  let interrupt = true;
  return {
    query(...args) { return pool.query(...args); },
    async connect() {
      const client = await pool.connect();
      return {
        query(sql, values) {
          if (interrupt && typeof sql === "string" && sql.startsWith("INSERT INTO")
              && sql.includes("historical_telemetry_v1_chunk_headers") && values?.includes("chunk-b")) {
            interrupt = false;
            throw new Error("synthetic_promotion_interruption");
          }
          return client.query(sql, values);
        },
        release(...args) { return client.release(...args); },
      };
    },
  };
}

test("PG17 promotes one synthetic sealed header mirror with an immutable permit, resumable pages, and erasure cascades", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const suffix = randomBytes(6).toString("hex");
  const targetSchema = `typed_legacy_target_${suffix}`;
  const controlSchema = `typed_legacy_admission_transfer_${suffix}`;
  const transferId = "synthetic-header-promotion-v1";
  const pool = new pg.Pool({ ...socket, user: process.env.PG_TEST_USER ?? "postgres",
    database: process.env.PG_TEST_DATABASE ?? "postgres", password: process.env.PG_TEST_PASSWORD ?? "synthetic-local-only", max: 4 });
  const fixture = headerFixture();
  const source = createSyntheticLegacyAdmissionSource({ tables: fixture.tables, snapshotId: "synthetic-header-snapshot-v1" });
  let targetCreated = false;
  let controlCreated = false;
  try {
    const local = await pool.query("SELECT inet_server_addr() AS address");
    assert.equal(local.rows[0]?.address, null);
    await pool.query("CREATE SCHEMA " + quote(targetSchema));
    targetCreated = true;
    await pool.query("CREATE SCHEMA " + quote(controlSchema));
    controlCreated = true;
    await applyThroughVersion(pool, targetSchema, 39);
    const target = quote(targetSchema);
    await pool.query(`INSERT INTO ${target}.typed_telemetry_namespaces(id,original_id) VALUES(1,$1)`, [Buffer.from([1, 2])]);
    await pool.query(`INSERT INTO ${target}.typed_telemetry_source_family_receipts(
      source_namespace,source_format,generation,source_digest,source_row_count,membership_row_count,reconciled_at
    ) VALUES($1,10,1,$3,0,0,clock_timestamp()),($2,11,1,$3,0,0,clock_timestamp())`,
    ["synthetic-admission-v1", "synthetic-admission-v11", "a".repeat(64)]);
    const imported = await runPostgresLegacyAdmissionTransfer({ source, destinationPool: pool,
      targetSchema, controlSchema, transferId, pageSize: 1 });
    assert.equal(imported.status, "staged_admission_lineage_transfer_complete");

    await assert.rejects(runPostgresLegacyHeaderPromotion({ pool, targetSchema, controlSchema, transferId, pageSize: 1 }),
      (error) => error instanceof PostgresLegacyHeaderPromotionError
        && error.code === "LEGACY_HEADER_PROMOTION_MIGRATION_REQUIRED");
    assert.equal((await pool.query("SELECT to_regclass($1) AS relation", [
      `${targetSchema}.historical_transport_header_imports`,
    ])).rows[0]?.relation, null, "migration 0040 tables are absent before the forward migration");

    const migration = await applyThroughVersion(pool, targetSchema, 40);
    assert.equal(migration.applied, 40);
    await pool.query(`INSERT INTO ${target}.participants(id,owner_kind,state,created_at)
      VALUES($1,'social','active',clock_timestamp())`, [fixture.participantId]);
    await assert.rejects(runPostgresLegacyHeaderPromotion({ pool, targetSchema, controlSchema, transferId, pageSize: 1 }),
      (error) => error instanceof PostgresLegacyHeaderPromotionError
        && error.code === "LEGACY_HEADER_PROMOTION_IDENTITY_AUTHORITY_MISMATCH");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_imports`)).rows[0]?.n, 0,
      "missing device authority is refused before a permit is written");
    await seedAuthority(pool, targetSchema, fixture.participantId, "synthetic-mismatched-device", "mismatch-a");
    await seedAuthority(pool, targetSchema, "synthetic-other-participant", fixture.deviceId, "mismatch-b");
    await assert.rejects(runPostgresLegacyHeaderPromotion({ pool, targetSchema, controlSchema, transferId, pageSize: 1 }),
      (error) => error instanceof PostgresLegacyHeaderPromotionError
        && error.code === "LEGACY_HEADER_PROMOTION_IDENTITY_AUTHORITY_MISMATCH");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_imports`)).rows[0]?.n, 0);

    await pool.query(`DELETE FROM ${target}.participants WHERE id=$1`, ["synthetic-other-participant"]);
    await seedAuthority(pool, targetSchema, fixture.participantId, fixture.deviceId, "correct");
    await pool.query(`UPDATE ${target}.participants
      SET state='deleting',deletion_session_id='synthetic-header-erasure-fence' WHERE id=$1`, [fixture.participantId]);
    await assert.rejects(runPostgresLegacyHeaderPromotion({ pool, targetSchema, controlSchema, transferId, pageSize: 1 }),
      (error) => error instanceof PostgresLegacyHeaderPromotionError
        && error.code === "LEGACY_HEADER_PROMOTION_IDENTITY_AUTHORITY_MISMATCH");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_imports`)).rows[0]?.n, 0,
      "a deleting participant is refused before the immutable permit is written");
    await pool.query(`UPDATE ${target}.participants
      SET state='active',deletion_session_id=NULL WHERE id=$1`, [fixture.participantId]);
    const interrupted = await interruptingPool(pool);
    await assert.rejects(runPostgresLegacyHeaderPromotion({ pool: interrupted, targetSchema, controlSchema, transferId, pageSize: 1 }),
      (error) => error instanceof PostgresLegacyHeaderPromotionError
        && error.code === "LEGACY_HEADER_PROMOTION_PAGE_WRITE_FAILED");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_telemetry_v1_chunk_headers`)).rows[0]?.n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_telemetry_v11_manifest_headers`)).rows[0]?.n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_promotion_receipts`)).rows[0]?.n, 0);

    const completed = await runPostgresLegacyHeaderPromotion({ pool, targetSchema, controlSchema, transferId, pageSize: 1 });
    assert.equal(completed.status, "synthetic_historical_header_promotion_complete");
    assert.equal(completed.productionReady, false);
    assert.equal(completed.readerActivationAuthorized, false);
    assert.equal(completed.cursorAdvanced, false);
    assert.equal(completed.ownerStateActivated, false);
    assert.equal(completed.publicationActivated, false);
    assert.equal(completed.erasureAuthorized, false);
    assert.equal(completed.headerTableRowCounts.telemetry_v1_chunks, 2);
    assert.equal(completed.headerTableRowCounts.telemetry_v11_day_manifests, 1);
    assert.equal(completed.headerTableRowCounts.telemetry_v11_chunks, 1);
    for (const digest of Object.values(completed.headerTableSha256)) assert.match(digest, /^[0-9a-f]{64}$/u);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.telemetry_v1_chunks`)).rows[0]?.n, 0,
      "the live v1 table is unchanged");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.telemetry_v11_day_manifests`)).rows[0]?.n, 0,
      "the live v1.1 table is unchanged");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_imports`)).rows[0]?.n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_promotion_receipts`)).rows[0]?.n, 1);
    await assert.rejects(pool.query(`UPDATE ${target}.historical_telemetry_v1_chunk_headers SET stream='quota' WHERE id='chunk-a'`),
      (error) => error?.code === "P1005");
    await assert.rejects(pool.query(`DELETE FROM ${target}.historical_telemetry_v1_chunk_headers WHERE id='chunk-a'`),
      (error) => error?.code === "P1005");

    const sealProbe = await pool.connect();
    try {
      await sealProbe.query("BEGIN");
      await sealProbe.query(`SET LOCAL search_path TO ${target}, pg_catalog`);
      await sealProbe.query("SELECT set_config('tibotattle.legacy_header_promotion',$1,true)", [completed.sourceImportId]);
    await assert.rejects(sealProbe.query(`INSERT INTO ${target}.historical_telemetry_v1_chunk_headers
        SELECT * FROM ${target}.historical_telemetry_v1_chunk_headers WHERE id='chunk-a'`),
      (error) => error?.code === "P1005" && error.message.includes("historical_transport_header_insert_refused"));
      await sealProbe.query("ROLLBACK");
    } finally { sealProbe.release(); }

    await assert.rejects(pool.query(`DELETE FROM ${target}.device_credentials WHERE id=$1`, [fixture.deviceId]),
      (error) => error?.code === "P1005" && error.message.includes("historical_transport_header_retained"));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_telemetry_v1_chunk_headers`)).rows[0]?.n, 2,
      "device-only cleanup cannot erase retained participant history");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.device_credentials WHERE id=$1`,
      [fixture.deviceId])).rows[0]?.n, 1, "refused device deletion keeps authority intact");

    const replay = await runPostgresLegacyHeaderPromotion({ pool, targetSchema, controlSchema, transferId, pageSize: 1 });
    assert.equal(replay.pagesCommittedThisRun, 0);
    assert.equal(replay.sourceImportId, completed.sourceImportId);
    await pool.query(`DELETE FROM ${target}.participants WHERE id=$1`, [fixture.participantId]);
    for (const table of ["historical_telemetry_v1_chunk_headers", "historical_telemetry_v11_manifest_headers", "historical_telemetry_v11_chunk_headers"]) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}."${table}"`)).rows[0]?.n, 0,
        `${table} follows participant erasure cascades`);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${target}.historical_transport_header_imports`)).rows[0]?.n, 1,
      "the content-free permit remains as migration provenance");
  } finally {
    source.close?.();
    if (controlCreated) await pool.query("DROP SCHEMA IF EXISTS " + quote(controlSchema) + " CASCADE").catch(() => {});
    if (targetCreated) await pool.query("DROP SCHEMA IF EXISTS " + quote(targetSchema) + " CASCADE").catch(() => {});
    await pool.end();
  }
});
