import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { createServer } from "vite";
import pg from "pg";
import {
  applyPostgresMigrations,
  POSTGRES_MIGRATION_ROOT,
  readPostgresMigrations,
} from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const BASELINE_VERSION = 34;
const RETENTION_MIGRATION = "0035_v12_ready_manifest_retention.sql";
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DAY = "2026-09-20";

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const { lstat, realpath, stat } = await import("node:fs/promises");
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

async function createPool() {
  const socket = await localSocket();
  const pool = new pg.Pool({
    ...socket,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? {} : { password: PG_TEST_PASSWORD }),
    database: "postgres",
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  const server = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num') AS version");
  assert.equal(server.rows[0]?.address, null);
  assert.ok(Number(server.rows[0]?.version) >= 170000 && Number(server.rows[0]?.version) < 180000,
    "the disposable socket must be PostgreSQL 17");
  return pool;
}

async function createSchema(pool, prefix) {
  const schema = `${prefix}_${randomBytes(6).toString("hex")}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return schema;
}

async function prepareBaseline(pool, schema) {
  const migrations = await readPostgresMigrations({ role: "primary" });
  const index = migrations.findIndex((migration) => migration.name === RETENTION_MIGRATION);
  assert.equal(index, BASELINE_VERSION, "0035 must follow the reviewed 34-migration baseline");
  const tempRoot = await mkdtemp(join(tmpdir(), "tibotattle-v12-retention-baseline-"));
  const primaryDirectory = join(tempRoot, "primary");
  await mkdir(primaryDirectory, { recursive: true });
  const names = await readdir(join(POSTGRES_MIGRATION_ROOT, "primary"));
  const prior = names.filter((name) => {
    const match = /^(\d{4})_[a-z][a-z0-9_-]*\.sql$/u.exec(name);
    return match !== null && Number(match[1]) < 35;
  }).sort();
  assert.equal(prior.length, BASELINE_VERSION);
  for (const name of prior) {
    await copyFile(join(POSTGRES_MIGRATION_ROOT, "primary", name), join(primaryDirectory, name));
  }
  const applied = await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: tempRoot });
  assert.equal(applied.applied, BASELINE_VERSION);
  return tempRoot;
}

async function seedIdentity(pool, schema, label, { withOwnerLink = true } = {}) {
  const table = (name) => `"${schema}"."${name}"`;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  const participantId = `synthetic-retention-participant-${label}-${randomUUID()}`;
  const sessionId = `synthetic-retention-session-${randomUUID()}`;
  const pairingId = `synthetic-retention-pairing-${randomUUID()}`;
  const deviceId = `synthetic-retention-device-${randomUUID()}`;
  await pool.query(
    `INSERT INTO ${table("participants")} (id,owner_kind,state,consent_version,created_at)
     VALUES ($1,'social','active','privacy-safe-telemetry-v0.1',$2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${table("web_sessions")} (
       id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, expires],
  );
  await pool.query(
    `INSERT INTO ${table("device_pairings")} (
       id,participant_id,issued_by_session_id,secret_hash,consent_version,
       transport_consent_version,state,issued_at,expires_at,consumed_at,claimed_device_id
     ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`,
    [pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId],
  );
  await pool.query(
    `INSERT INTO ${table("device_credentials")} (
       id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,
       issued_at,expires_at,last_used_at,social_verified_at
     ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
    [deviceId, participantId, pairingId, randomBytes(32), now, expires],
  );
  if (withOwnerLink) {
    await pool.query(
      `INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
       VALUES ($1,$2,'active')`,
      [participantId, randomBytes(32).toString("hex")],
    );
  }
  await pool.query(
    `INSERT INTO ${table("telemetry_v12_device_capabilities")} (
       participant_id,device_id,telemetry_schema_version,field_dictionary_version,
       privacy_contract_version,state,consented_at
     ) VALUES ($1,$2,'telemetry-contribution-v1.2',
       'telemetry-v1.2-registry-2026-09-20.1','ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`,
    [participantId, deviceId, now],
  );
  return { participantId, deviceId, now, expires };
}

async function insertLegacyReadyManifest(pool, schema, identity, day) {
  const table = (name) => `"${schema}"."${name}"`;
  const manifestId = randomUUID();
  const chunkId = `chunk:${randomUUID()}`;
  const sourceChunkId = `quota:${day}:0`;
  const authorizationId = `synthetic-retention-legacy-auth-${randomUUID()}`;
  const r2Key = `synthetic/retention/legacy/${randomUUID()}`;
  const digest = randomBytes(32).toString("hex");
  const envelopeDigest = randomBytes(32).toString("hex");
  const manifestJson = JSON.stringify({
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    chunks: [{ chunkId: sourceChunkId, chunkDigest: digest, recordCount: 1 }],
  });
  await pool.query(
    `INSERT INTO ${table("device_upload_authorizations")} (
       id,participant_id,issued_by_device_id,secret_hash,envelope_digest,
       body_bytes,content_type,state,issued_at,expires_at,consumed_at,consumed_contribution_id
     ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7,$6,$8)`,
    [authorizationId, identity.participantId, identity.deviceId,
      randomBytes(32), envelopeDigest, identity.now, identity.expires, chunkId],
  );
  await pool.query(
    `INSERT INTO ${table("pending_objects")} (contribution_id,object_key,object_kind)
     VALUES ($1,$2,'telemetry_v12')`,
    [chunkId, r2Key],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v12_day_manifests")} (
       id,participant_id,device_id,chunk_day,manifest_digest,parser_version,
       manifest_json,expected_chunk_count,state,created_at
     ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-retention-legacy',$6,1,'staged',$7)`,
    [manifestId, identity.participantId, identity.deviceId, day,
      randomBytes(32).toString("hex"), manifestJson, identity.now],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v12_chunks")} (
       id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,
       chunk_digest,envelope_digest,parser_version,record_count,r2_key,
       device_upload_authorization_id,created_at
     ) VALUES ($1,$2,$3,$4,'quota',$5::date,0,$6,$7,$8,
       'synthetic-retention-legacy',1,$9,$10,$11)`,
    [chunkId, manifestId, identity.participantId, identity.deviceId, day,
      sourceChunkId, digest, envelopeDigest, r2Key, authorizationId, identity.now],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v12_records")} (
       chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json
     ) VALUES ($1,$2,'quota','synthetic-retention-legacy-record',$3::timestamptz,'{}')`,
    [chunkId, manifestId, `${day}T12:00:00.000Z`],
  );
  await pool.query(
    `UPDATE ${table("telemetry_v12_day_manifests")} SET state='ready',ready_at=$2 WHERE id=$1`,
    [manifestId, identity.now],
  );
  return { manifestId, chunkId };
}

async function admitOneQuotaChunk(pool, schema, identity, modules) {
  const table = (name) => `"${schema}"."${name}"`;
  const nowEpoch = Date.now();
  const day = FIXTURE_DAY;
  const observedTime = `${day}T12:05:00.000Z`;
  const quotaRecord = {
    schemaVersion: "quota-observation-v1.2",
    observationId: `quota:v12:${randomUUID()}`,
    observedTime,
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 20,
    windowDurationMinutes: 10080,
    resetsAt: `${day}T13:05:00.000Z`,
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
  };
  const consent = telemetryV12RequiredConsent();
  const parserVersion = "synthetic-retention-pg17";
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.2",
    manifestDigest: "0".repeat(64),
    chunkId: `quota:${day}:0`,
    chunkRevision: 1,
    parserVersion,
    consent,
    records: [quotaRecord],
    chunkDigest: await modules.sha256Hex(canonicalTelemetryV12Json([quotaRecord])),
  };
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await modules.sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  const principal = { participantId: identity.participantId, deviceId: identity.deviceId };
  const options = { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };
  const candidate = await modules.registerPostgresTypedV12DayManifest(
    pool, principal, manifest, nowEpoch, options,
  );
  const envelopeDigest = await modules.sha256Hex(`synthetic-envelope:${randomUUID()}`);
  const authorizationId = `synthetic-retention-auth-${randomUUID()}`;
  const chunkRowId = `chunk:${randomUUID()}`;
  const r2Key = `synthetic/retention/${randomUUID()}`;
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
  await pool.query(
    `INSERT INTO ${table("device_upload_authorizations")} (
       id,participant_id,issued_by_device_id,secret_hash,envelope_digest,
       body_bytes,content_type,state,issued_at,expires_at,consume_lease_expires_at
     ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`,
    [authorizationId, identity.participantId, identity.deviceId,
      randomBytes(32), envelopeDigest, now, expires],
  );
  await pool.query(
    `INSERT INTO ${table("pending_objects")} (contribution_id,object_key,object_kind)
     VALUES ($1,$2,'telemetry_v12')`,
    [chunkRowId, r2Key],
  );
  const metadata = {
    chunkRowId,
    r2Key,
    envelopeDigest,
    deviceUploadAuthorizationId: authorizationId,
  };
  const first = await modules.persistPostgresTypedV12StagedChunk(
    pool, principal, chunk, metadata, nowEpoch, options,
  );
  assert.equal(first.replay, false);
  const replay = await modules.persistPostgresTypedV12StagedChunk(
    pool, principal, chunk, metadata, nowEpoch, options,
  );
  assert.equal(replay.replay, true);
  return { manifest, candidate, chunk, metadata, principal, options };
}

async function assertP1005(promise, label) {
  await assert.rejects(promise, (error) => error?.code === "P1005", label);
}

async function assertBlocked(promise, label) {
  await assert.rejects(promise, (error) => ["P1005", "23514"].includes(error?.code), label);
}

test("0035 audits existing ready data, preserves exact admission replay, and allows owner erasure", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  let pool;
  let schema;
  let tempRoot;
  let vite;
  try {
    pool = await createPool();
    schema = await createSchema(pool, "v12_retention");
    tempRoot = await prepareBaseline(pool, schema);
    const identity = await seedIdentity(pool, schema, "existing");
    const legacyReady = await insertLegacyReadyManifest(pool, schema, identity, "2026-09-19");

    const migrations = await readPostgresMigrations({ role: "primary" });
    const result = await applyPostgresMigrations({ role: "primary", schema, pool });
    assert.equal(result.applied, 58);
    assert.equal(migrations[BASELINE_VERSION]?.name, RETENTION_MIGRATION);
    assert.equal(migrations[BASELINE_VERSION + 1]?.name, "0036_streamed_publication_proofs.sql");
    assert.equal(migrations[BASELINE_VERSION + 2]?.name, "0037_community_daily_publications.sql");

    const table = (name) => `"${schema}"."${name}"`;
    await assertP1005(pool.query(
      `UPDATE ${table("telemetry_v12_day_manifests")}
          SET state='staged',ready_at=NULL WHERE id=$1`,
      [legacyReady.manifestId],
    ), "ready to staged is rejected");
    await assertP1005(pool.query(
      `UPDATE ${table("telemetry_v12_day_manifests")}
          SET parser_version='changed' WHERE id=$1`,
      [legacyReady.manifestId],
    ), "ready header content is immutable");
    await assertP1005(pool.query(
      `DELETE FROM ${table("telemetry_v12_day_manifests")} WHERE id=$1`,
      [legacyReady.manifestId],
    ), "ready header deletion is rejected while the participant exists");
    await assertP1005(pool.query(
      `UPDATE ${table("telemetry_v12_records")} SET record_json='{"changed":true}' WHERE chunk_id=$1`,
      [legacyReady.chunkId],
    ), "ready raw record update is rejected");
    await assertP1005(pool.query(
      `DELETE FROM ${table("telemetry_v12_records")} WHERE chunk_id=$1`,
      [legacyReady.chunkId],
    ), "ready raw record deletion is rejected");

    await pool.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active',changed_at=clock_timestamp() WHERE id=1`);
    await pool.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active',changed_at=clock_timestamp() WHERE id=1`);
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const admission = await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts");
    const { sha256Hex } = await vite.ssrLoadModule("/src/crypto.ts");
    const admitted = await admitOneQuotaChunk(pool, schema, identity, { ...admission, sha256Hex });

    const ready = await pool.query(
      `SELECT state FROM ${table("telemetry_v12_day_manifests")} WHERE id=$1`,
      [admitted.candidate.manifestId],
    );
    assert.equal(ready.rows[0]?.state, "ready");
    const chunkId = admitted.metadata.chunkRowId;
    const typedRecord = await pool.query(
      `SELECT id::text AS id FROM ${table("telemetry_v12_typed_records")} WHERE chunk_id=$1`,
      [chunkId],
    );
    assert.equal(typedRecord.rows.length, 1);
    const recordId = typedRecord.rows[0].id;

    await assertP1005(pool.query(
      `UPDATE ${table("telemetry_v12_chunks")} SET quarantine_deleted_at=clock_timestamp() WHERE id=$1`,
      [chunkId],
    ), "ready chunk update is rejected");
    await assertP1005(pool.query(
      `DELETE FROM ${table("telemetry_v12_chunks")} WHERE id=$1`,
      [chunkId],
    ), "ready chunk deletion is rejected");
    const lateChunkId = `chunk:${randomUUID()}`;
    const lateObjectKey = `synthetic/retention/late/${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${table("pending_objects")} (contribution_id,object_key,object_kind)
       VALUES ($1,$2,'telemetry_v12')`,
      [lateChunkId, lateObjectKey],
    );
    await assertP1005(pool.query(
      `INSERT INTO ${table("telemetry_v12_chunks")} (
         id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,
         chunk_digest,envelope_digest,parser_version,record_count,r2_key,
         device_upload_authorization_id,created_at
       ) SELECT $2, id, participant_id, device_id, 'quota', chunk_day, 1,
                'quota:late:1', repeat('a',64), repeat('b',64), 'late', 1,
                $3, (SELECT chunk.device_upload_authorization_id
                       FROM ${table("telemetry_v12_chunks")} chunk WHERE chunk.id=$4),
                clock_timestamp()
           FROM ${table("telemetry_v12_day_manifests")} WHERE id=$1`,
      [admitted.candidate.manifestId, lateChunkId, lateObjectKey, chunkId],
    ), "a ready manifest cannot gain a chunk");
    await pool.query(`DELETE FROM ${table("pending_objects")} WHERE contribution_id=$1`, [lateChunkId]);
    await assertBlocked(pool.query(
      `UPDATE ${table("telemetry_v12_typed_records")} SET observed_at_ms=observed_at_ms+1 WHERE id=$1`,
      [recordId],
    ), "ready typed record update is rejected by the retained typed immutability guard");
    await assertP1005(pool.query(
      `DELETE FROM ${table("telemetry_v12_typed_records")} WHERE id=$1`,
      [recordId],
    ), "ready typed record deletion is rejected");
    await assertBlocked(pool.query(
      `UPDATE ${table("telemetry_v12_typed_quota")} SET used_percent=21 WHERE record_id=$1`,
      [recordId],
    ), "ready typed child update is rejected by the retained typed immutability guard");
    await assertP1005(pool.query(
      `DELETE FROM ${table("telemetry_v12_typed_quota")} WHERE record_id=$1`,
      [recordId],
    ), "ready typed child deletion is rejected");
    await assertP1005(pool.query(
      `INSERT INTO ${table("telemetry_v12_records")} (
         chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json
       ) VALUES ($1,$2,'quota','synthetic-late-record',clock_timestamp(),'{}')`,
      [chunkId, admitted.candidate.manifestId],
    ), "ready manifest cannot gain a raw record");

    await pool.query(
      `UPDATE ${table("participants")} SET state='deleting',deletion_session_id='synthetic-retention-fence'
        WHERE id=$1`,
      [identity.participantId],
    );
    await assertP1005(pool.query(
      `DELETE FROM ${table("telemetry_v12_day_manifests")} WHERE id=$1`,
      [admitted.candidate.manifestId],
    ), "deleting state alone does not authorize ready source deletion");
    await pool.query(
      `DELETE FROM ${table("pending_objects")} pending
        WHERE pending.contribution_id IN (
          SELECT chunk.id FROM ${table("telemetry_v12_chunks")} chunk WHERE chunk.participant_id=$1
        )`,
      [identity.participantId],
    );
    const erased = await pool.query(
      `DELETE FROM ${table("participants")}
        WHERE id=$1 AND state='deleting' AND deletion_session_id='synthetic-retention-fence'`,
      [identity.participantId],
    );
    assert.equal(erased.rowCount, 1, "the terminal participant erasure cascade succeeds");

    for (const sourceTable of [
      "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_records",
      "telemetry_v12_typed_records", "telemetry_v12_typed_quota",
    ]) {
      const remaining = await pool.query(`SELECT count(*)::text AS n FROM ${table(sourceTable)}`);
      assert.equal(remaining.rows[0]?.n, "0", `${sourceTable} rows cascade with owner erasure`);
    }
    const receipt = await pool.query(
      `SELECT count(*)::text AS n FROM ${table("storage_owner_erasure_receipts")}`,
    );
    assert.equal(receipt.rows[0]?.n, "1");
  } finally {
    await vite?.close();
    if (pool && schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
});

test("0035 cannot use another owner's receipt to erase linkless ready source", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  let pool;
  let schema;
  let tempRoot;
  let client;
  try {
    pool = await createPool();
    schema = await createSchema(pool, "v12_retention_cross_owner");
    tempRoot = await prepareBaseline(pool, schema);
    const linked = await seedIdentity(pool, schema, "linked");
    const linkless = await seedIdentity(pool, schema, "linkless", { withOwnerLink: false });
    await insertLegacyReadyManifest(pool, schema, linked, "2026-09-17");
    const linklessReady = await insertLegacyReadyManifest(pool, schema, linkless, "2026-09-18");
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const table = (name) => `"${schema}"."${name}"`;
    for (const identity of [linked, linkless]) {
      await pool.query(
        `UPDATE ${table("participants")}
            SET state='deleting',deletion_session_id='synthetic-cross-owner-fence'
          WHERE id=$1`,
        [identity.participantId],
      );
      await pool.query(
        `DELETE FROM ${table("pending_objects")}
          WHERE contribution_id IN (
            SELECT id FROM ${table("telemetry_v12_chunks")} WHERE participant_id=$1
          )`,
        [identity.participantId],
      );
    }
    client = await pool.connect();
    await client.query("BEGIN");
    const first = await client.query(
      `DELETE FROM ${table("participants")}
        WHERE id=$1 AND state='deleting' AND deletion_session_id='synthetic-cross-owner-fence'`,
      [linked.participantId],
    );
    assert.equal(first.rowCount, 1, "the linked owner creates its own terminal receipt");
    await assertP1005(client.query(
      `DELETE FROM ${table("participants")}
        WHERE id=$1 AND state='deleting' AND deletion_session_id='synthetic-cross-owner-fence'`,
      [linkless.participantId],
    ), "another owner's receipt must not authorize the linkless ready-source cascade");
    await client.query("ROLLBACK");
    client.release();
    client = null;
    await assertP1005(pool.query(
      `DELETE FROM ${table("participants")}
        WHERE id IN ($1,$2) AND state='deleting'
          AND deletion_session_id='synthetic-cross-owner-fence'`,
      [linked.participantId, linkless.participantId],
    ), "a mixed-owner DELETE statement must roll back rather than erase the linkless owner");
    const retained = await pool.query(
      `SELECT count(*)::text AS n FROM ${table("telemetry_v12_day_manifests")} WHERE id=$1`,
      [linklessReady.manifestId],
    );
    assert.equal(retained.rows[0]?.n, "1");
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    if (pool && schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
});

test("0035 rejects a stale erased owner link when another owner erases in the current transaction", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  let pool;
  let schema;
  let tempRoot;
  let client;
  try {
    pool = await createPool();
    schema = await createSchema(pool, "v12_retention_stale_owner");
    tempRoot = await prepareBaseline(pool, schema);
    const currentOwner = await seedIdentity(pool, schema, "current");
    const staleOwner = await seedIdentity(pool, schema, "stale");
    const currentReady = await insertLegacyReadyManifest(pool, schema, currentOwner, "2026-09-16");
    const staleReady = await insertLegacyReadyManifest(pool, schema, staleOwner, "2026-09-15");
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const table = (name) => `"${schema}"."${name}"`;

    for (const identity of [currentOwner, staleOwner]) {
      await pool.query(
        `UPDATE ${table("participants")}
            SET state='deleting',deletion_session_id='synthetic-stale-owner-fence'
          WHERE id=$1`,
        [identity.participantId],
      );
      await pool.query(
        `DELETE FROM ${table("pending_objects")}
          WHERE contribution_id IN (
            SELECT id FROM ${table("telemetry_v12_chunks")} WHERE participant_id=$1
          )`,
        [identity.participantId],
      );
    }

    const staleLink = await pool.query(
      `SELECT owner_digest FROM ${table("storage_v11_owner_links")} WHERE participant_id=$1`,
      [staleOwner.participantId],
    );
    assert.equal(staleLink.rowCount, 1);
    await pool.query(
      `UPDATE ${table("storage_v11_owner_links")} SET state='erased' WHERE participant_id=$1`,
      [staleOwner.participantId],
    );
    const staleReceipt = await pool.query(
      `SELECT count(*)::text AS n FROM ${table("storage_owner_erasure_receipts")} WHERE owner_digest=$1`,
      [staleLink.rows[0].owner_digest],
    );
    assert.equal(staleReceipt.rows[0]?.n, "1", "the stale owner has a committed receipt before the deletion transaction");

    client = await pool.connect();
    await client.query("BEGIN");
    const first = await client.query(
      `DELETE FROM ${table("participants")}
        WHERE id=$1 AND state='deleting' AND deletion_session_id='synthetic-stale-owner-fence'`,
      [currentOwner.participantId],
    );
    assert.equal(first.rowCount, 1, "a valid current owner erasure creates its participant-specific proof");
    await assertP1005(client.query(
      `DELETE FROM ${table("participants")}
        WHERE id=$1 AND state='deleting' AND deletion_session_id='synthetic-stale-owner-fence'`,
      [staleOwner.participantId],
    ), "a prior erased-link receipt cannot borrow the current owner's receipt");
    await client.query("ROLLBACK");
    client.release();
    client = null;

    const retained = await pool.query(
      `SELECT id FROM ${table("telemetry_v12_day_manifests")}
        WHERE id = ANY($1::text[]) ORDER BY id`,
      [[currentReady.manifestId, staleReady.manifestId]],
    );
    assert.deepEqual(
      retained.rows.map((row) => row.id).sort(),
      [currentReady.manifestId, staleReady.manifestId].sort(),
      "rollback retains ready manifests for both owners",
    );
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    if (pool && schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
});

test("0035 refuses malformed ready data already present at upgrade", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  let pool;
  let schema;
  let tempRoot;
  try {
    pool = await createPool();
    schema = await createSchema(pool, "v12_retention_bad");
    tempRoot = await prepareBaseline(pool, schema);
    const identity = await seedIdentity(pool, schema, "malformed");
    const table = (name) => `"${schema}"."${name}"`;
    await pool.query(`ALTER TABLE ${table("telemetry_v12_day_manifests")}
      DISABLE TRIGGER telemetry_v12_manifest_ready_integrity_guard`);
    await pool.query(
      `INSERT INTO ${table("telemetry_v12_day_manifests")} (
         id,participant_id,device_id,chunk_day,manifest_digest,parser_version,
         manifest_json,expected_chunk_count,state,created_at,ready_at
       ) VALUES ($1,$2,$3,'2026-09-18',$4,'synthetic-invalid',
         '{"schemaVersion":"telemetry-day-manifest-v1.2","day":"2026-09-18","chunks":[]}',
         1,'ready',$5,$5)`,
      [randomUUID(), identity.participantId, identity.deviceId,
        randomBytes(32).toString("hex"), identity.now],
    );
    await pool.query(`ALTER TABLE ${table("telemetry_v12_day_manifests")}
      ENABLE TRIGGER telemetry_v12_manifest_ready_integrity_guard`);

    await assert.rejects(
      applyPostgresMigrations({ role: "primary", schema, pool }),
      "the migration audit must reject an incomplete preexisting ready day",
    );
    const history = await pool.query(
      `SELECT count(*)::text AS n FROM ${table("_tibotattle_migration_history")} WHERE version=35`,
    );
    assert.equal(history.rows[0]?.n, "0", "a failed audit rolls back migration and receipt");
    const guard = await pool.query(
      `SELECT count(*)::text AS n FROM pg_trigger trigger
        JOIN pg_class relation ON relation.oid=trigger.tgrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname=$1 AND trigger.tgname='telemetry_v12_day_manifest_retention_guard'`,
      [schema],
    );
    assert.equal(guard.rows[0]?.n, "0", "the forward guard is not installed over malformed state");
  } finally {
    if (pool && schema) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool?.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
});
