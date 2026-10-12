import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "vite";
import pg from "pg";
import {
  applyPostgresMigrations,
  POSTGRES_MIGRATION_ROOT,
  readPostgresMigrations,
} from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD ?? "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const MIGRATION_VERSION = 33;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const host = PG_TEST_SOCKET;
  const [link, resolved] = await Promise.all([lstat(host), realpath(host)]);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  const address = resolved;
  return { host: address, port: PG_TEST_PORT };
}

function record(format, sessionUuid, eventTime, toolClassCounts = { shell: 2 }) {
  return {
    schemaVersion: `session-dimension-${format === "v1" ? "v1.0" : "v1.1"}`,
    sessionUuid,
    firstEventTime: eventTime,
    provider: "codex",
    toolClassCounts,
  };
}

function quotaRecord(format, observationId, observedTime) {
  return {
    schemaVersion: `quota-observation-${format === "v1" ? "v1.0" : "v1.1"}`,
    observationId,
    observedTime,
    provider: "codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: 35,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-10-01T00:00:00.000Z",
    ...(format === "v11" ? { accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    } } : {}),
  };
}

async function insertV11Generation(pool, table, participantId, deviceId, day, now, expectedChunkCount = 1) {
  const manifestId = randomUUID();
  const generationId = randomUUID();
  const predecessorToken = randomBytes(32).toString("hex");
  const manifestDigest = randomBytes(32).toString("hex");
  const legacyFingerprint = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO ${table("telemetry_v11_day_manifests")} (
      id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
      expected_chunk_count,state,created_at,ready_at
    ) VALUES ($1,$2,$3,$4::date,$5,'synthetic-effective-v11',$6,$8,'ready',$7,$7)`,
  [manifestId, participantId, deviceId, day, manifestDigest,
    JSON.stringify({ schemaVersion: "telemetry-day-manifest-v1.1", day, chunks: [] }), now, expectedChunkCount]);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domain_predecessors")} (
      token_hash,participant_id,device_id,previous_generation_id,legacy_fingerprint,input_revision,
      from_day,through_day,winners_json,created_at,expires_at
    ) VALUES ($1,$2,$3,NULL,$4,0,$5::date,$5::date,'[]',$6,$6::timestamptz+interval '1 hour')`,
  [predecessorToken, participantId, deviceId, legacyFingerprint, day, now]);
  await pool.query(`INSERT INTO ${table("telemetry_v11_domains")} (
      id,participant_id,device_id,predecessor_token_hash,previous_generation_id,manifest_digest,
      legacy_fingerprint,input_revision,from_day,through_day,days_json,created_at
    ) VALUES ($1,$2,$3,$4,NULL,$5,$6,0,$7::date,$7::date,$8,$9)`,
  [generationId, participantId, deviceId, predecessorToken, manifestDigest, legacyFingerprint, day,
    JSON.stringify([{ day, manifestId, manifestDigest }]), now]);
  return { manifestId, manifestDigest, generationId };
}

test("PG17 typed legacy reader pages source-aware v1/v1.1 groups and fails closed without receipts", {
  skip: !PG_TEST_SOCKET,
}, async () => {
  const socket = await localSocket();
  const pool = new pg.Pool({ ...socket, user: PG_TEST_USER, password: PG_TEST_PASSWORD,
    database: PG_TEST_DATABASE, ssl: false, max: 4, connectionTimeoutMillis: 5_000 });
  const schema = `legacy_effective_${randomBytes(6).toString("hex")}`;
  const table = (name) => `"${schema}"."${name}"`;
  const sourceId = `synthetic-source-${randomBytes(4).toString("hex")}`;
  const sourceNamespace = `synthetic-namespace-${randomBytes(4).toString("hex")}`;
  const participantId = `synthetic-participant-${randomBytes(4).toString("hex")}`;
  const ownerDigest = randomBytes(32).toString("hex");
  const deviceUuid = randomUUID();
  const deviceId = `device:${deviceUuid}`;
  const typedOwnerKey = `participant:${randomUUID()}`;
  const namespaceId = 101;
  const ownerId = 201;
  const deviceStorageId = 301;
  const v1ChunkStorageId = 401;
  const v11ChunkStorageId = 402;
  const v11ManifestStorageId = 403;
  const v1QuotaChunkStorageId = 404;
  const v11QuotaChunkStorageId = 405;
  const quotaOccurrence = `quota-occurrence:v1:${"a".repeat(64)}`;
  const quotaTime = "2026-09-24T10:00:03.000Z";
  const typedRows = [
    { format: "v1", stream: 3, sourceRowId: 17, storageRowId: 501, chunkId: v1ChunkStorageId,
      manifestId: null, occurrenceId: "11111111-1111-4111-8111-111111111111", time: "2026-09-24T10:00:00.000Z" },
    { format: "v1", stream: 3, sourceRowId: 18, storageRowId: 502, chunkId: v1ChunkStorageId,
      manifestId: null, occurrenceId: "22222222-2222-4222-8222-222222222222", time: "2026-09-24T10:00:01.000Z" },
    { format: "v1", stream: 2, sourceRowId: 19, storageRowId: 503, chunkId: v1QuotaChunkStorageId,
      manifestId: null, occurrenceId: quotaOccurrence, time: quotaTime },
    { format: "v11", stream: 3, sourceRowId: 27, storageRowId: 601, chunkId: v11ChunkStorageId,
      manifestId: v11ManifestStorageId, occurrenceId: "11111111-1111-4111-8111-111111111111", time: "2026-09-24T10:00:00.000Z" },
    { format: "v11", stream: 3, sourceRowId: 28, storageRowId: 602, chunkId: v11ChunkStorageId,
      manifestId: v11ManifestStorageId, occurrenceId: "22222222-2222-4222-8222-222222222222", time: "2026-09-24T10:00:02.000Z" },
    { format: "v11", stream: 2, sourceRowId: 29, storageRowId: 603, chunkId: v11QuotaChunkStorageId,
      manifestId: v11ManifestStorageId, occurrenceId: quotaOccurrence, time: quotaTime },
  ];
  const day = "2026-09-24";
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const participantSession = randomUUID();
  const pairingId = randomUUID();
  const v1ChunkId = `chunk:${randomUUID()}`;
  const v1QuotaChunkId = `chunk:${randomUUID()}`;
  const v11ChunkId = `chunk:${randomUUID()}`;
  const v11QuotaChunkId = `chunk:${randomUUID()}`;
  const v1UploadId = randomUUID();
  const v1QuotaUploadId = randomUUID();
  const v11UploadId = randomUUID();
  const v11QuotaUploadId = randomUUID();
  const v1Envelope = randomBytes(32).toString("hex");
  const v1QuotaEnvelope = randomBytes(32).toString("hex");
  const v11Envelope = randomBytes(32).toString("hex");
  const v11QuotaEnvelope = randomBytes(32).toString("hex");
  const v1ChunkDigest = randomBytes(32).toString("hex");
  const v1QuotaChunkDigest = randomBytes(32).toString("hex");
  const v11ChunkDigest = randomBytes(32).toString("hex");
  const v11QuotaChunkDigest = randomBytes(32).toString("hex");
  let vite;
  let schemaCreated = false;
  let tempRoot;
  try {
    const locality = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num') AS version");
    assert.equal(locality.rows[0]?.address, null, "test database must use the local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^17\d+$/u, "test must run on PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    vite = await createServer({ root: WORKER_ROOT, configFile: false,
      server: { middlewareMode: true }, appType: "custom" });
    const reader = await vite.ssrLoadModule("/src/postgres-typed-legacy-effective-reader.ts");
    const codec = await vite.ssrLoadModule("/src/typed-telemetry-codec.ts");
    const { sha256Hex } = await vite.ssrLoadModule("/src/crypto.ts");

    const migrations = await readPostgresMigrations({ role: "primary" });
    tempRoot = await mkdtemp(join(tmpdir(), "tibotattle-pg-legacy-effective-"));
    const primary = join(tempRoot, "primary");
    await mkdir(primary, { recursive: true, mode: 0o700 });
    const selected = migrations.filter((migration) => migration.version <= MIGRATION_VERSION);
    assert.equal(selected.length, MIGRATION_VERSION);
    const names = await readdir(join(POSTGRES_MIGRATION_ROOT, "primary"));
    for (const migration of selected) {
      const name = names.find((candidate) => candidate.startsWith(`${String(migration.version).padStart(4, "0")}_`));
      assert.ok(name, `migration ${migration.version} has a source file`);
      await copyFile(join(POSTGRES_MIGRATION_ROOT, "primary", name), join(primary, name));
    }
    assert.equal((await applyPostgresMigrations({ role: "primary", schema, pool, rootDirectory: tempRoot })).applied,
      MIGRATION_VERSION);
    await pool.query(`INSERT INTO ${table("storage_source_state")} (singleton,source_id,authority_epoch)
      VALUES (1,$1,3)`, [sourceId]);
    await pool.query(`INSERT INTO ${table("analytics_source_cursors")} (source_id,sequence,authority_epoch)
      VALUES ($1,41,7)`, [sourceId]);

    await assert.rejects(reader.listPostgresEffectiveOwners(pool, { sourceId, sourceNamespace, schema: { primarySchema: schema } }),
      (error) => error?.code === "POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE",
      "empty source tables are not evidence that both source families were transferred");

    await pool.query(`INSERT INTO ${table("participants")} (id,created_at) VALUES ($1,$2)`, [participantId, now]);
    await pool.query(`INSERT INTO ${table("web_sessions")} (
        id,participant_id,secret_hash,csrf_hash,issued_at,expires_at,last_used_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
    [participantSession, participantId, randomBytes(32), randomBytes(32), now, expires]);
    await pool.query(`INSERT INTO ${table("device_pairings")} (
        id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,
        state,issued_at,expires_at,consumed_at,claimed_device_id
      ) VALUES ($1,$2,$3,$4,'synthetic-consent','synthetic-transport','consumed',$5,$6,$5,$7)`,
    [pairingId, participantId, participantSession, randomBytes(32), now, expires, deviceId]);
    await pool.query(`INSERT INTO ${table("device_credentials")} (
        id,participant_id,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at
      ) VALUES ($1,$2,$3,$4,'active',$5,$6,$5)`,
    [deviceId, participantId, pairingId, randomBytes(32), now, expires]);
    await pool.query(`INSERT INTO ${table("storage_v11_owner_links")} (participant_id,owner_digest,state)
      VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
    await pool.query(`INSERT INTO ${table("analytics_owner_state")} (
        source_id,owner_digest,revision,authority_epoch,state
      ) VALUES ($1,$2,9,4,'active')`, [sourceId, ownerDigest]);

    await pool.query(`INSERT INTO ${table("device_upload_authorizations")} (
        id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,
        state,issued_at,expires_at,consumed_at
      ) VALUES ($1,$2,$3,$4,$5,32,'application/json','consumed',$6,$7,$6),
               ($8,$2,$3,$9,$10,32,'application/json','consumed',$6,$7,$6),
               ($11,$2,$3,$12,$13,32,'application/json','consumed',$6,$7,$6),
               ($14,$2,$3,$15,$16,32,'application/json','consumed',$6,$7,$6)`,
    [v1UploadId, participantId, deviceId, randomBytes(32), v1Envelope, now, expires,
      v11UploadId, randomBytes(32), v11Envelope,
      v1QuotaUploadId, randomBytes(32), v1QuotaEnvelope,
      v11QuotaUploadId, randomBytes(32), v11QuotaEnvelope]);
    await pool.query(`INSERT INTO ${table("pending_objects")} (contribution_id,object_key,object_kind)
      VALUES ($1,$2,'telemetry_v1'),($3,$4,'telemetry_v1'),
             ($5,$6,'telemetry_v11'),($7,$8,'telemetry_v11')`,
    [v1ChunkId, `synthetic/${v1ChunkId}`, v1QuotaChunkId, `synthetic/${v1QuotaChunkId}`,
      v11ChunkId, `synthetic/${v11ChunkId}`, v11QuotaChunkId, `synthetic/${v11QuotaChunkId}`]);

    const v1Records = typedRows.filter((row) => row.format === "v1");
    const v11Records = typedRows.filter((row) => row.format === "v11");
    const sourceRecords = new Map();
    for (const row of typedRows) {
      sourceRecords.set(row.storageRowId, row.stream === 2
        ? quotaRecord(row.format, row.occurrenceId, row.time)
        : record(row.format, row.occurrenceId, row.time));
    }
    await pool.query(`INSERT INTO ${table("telemetry_v1_chunks")} (
        id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
        parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at
      ) VALUES ($1,$2,$3,'session',$4::date,0,1,$5,$6,'synthetic-legacy-v1',2,2,$7,$8,$9)`,
    [v1ChunkId, participantId, deviceId, day, v1ChunkDigest, v1Envelope,
      `synthetic/${v1ChunkId}`, v1UploadId, now]);
    await pool.query(`INSERT INTO ${table("telemetry_v1_chunks")} (
        id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
        parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at
      ) VALUES ($1,$2,$3,'quota',$4::date,1,1,$5,$6,'synthetic-legacy-v1',1,1,$7,$8,$9)`,
    [v1QuotaChunkId, participantId, deviceId, day, v1QuotaChunkDigest, v1QuotaEnvelope,
      `synthetic/${v1QuotaChunkId}`, v1QuotaUploadId, now]);
    const v11Generation = await insertV11Generation(pool, table, participantId, deviceId, day, now, 2);
    await pool.query(`INSERT INTO ${table("telemetry_v11_chunks")} (
        id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
        envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at
      ) VALUES ($1,$2,$3,$4,'session',$5::date,0,$6,$7,$8,'synthetic-legacy-v11',2,$9,$10,$11)`,
    [v11ChunkId, v11Generation.manifestId, participantId, deviceId, day, `legacy-${randomUUID()}`,
      v11ChunkDigest, v11Envelope, `synthetic/${v11ChunkId}`, v11UploadId, now]);
    await pool.query(`INSERT INTO ${table("telemetry_v11_chunks")} (
        id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
        envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at
      ) VALUES ($1,$2,$3,$4,'quota',$5::date,1,$6,$7,$8,'synthetic-legacy-v11',1,$9,$10,$11)`,
    [v11QuotaChunkId, v11Generation.manifestId, participantId, deviceId, day, `legacy-${randomUUID()}`,
      v11QuotaChunkDigest, v11QuotaEnvelope, `synthetic/${v11QuotaChunkId}`, v11QuotaUploadId, now]);
    await pool.query(`INSERT INTO ${table("telemetry_v11_domain_days")} (generation_id,observed_day,manifest_id)
      VALUES ($1,$2::date,$3)`, [v11Generation.generationId, day, v11Generation.manifestId]);
    await pool.query(`INSERT INTO ${table("telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
      VALUES ($1,$2,1,$3)`, [participantId, v11Generation.generationId, now]);

    const namespaceOriginalId = codec.encodeTypedTelemetryId(sourceNamespace);
    const ownerOriginalId = codec.encodeTypedTelemetryId(typedOwnerKey);
    const deviceOriginalId = codec.encodeTypedTelemetryId(deviceId);
    const v1ChunkOriginalId = codec.encodeTypedTelemetryId(v1ChunkId);
    const v1QuotaChunkOriginalId = codec.encodeTypedTelemetryId(v1QuotaChunkId);
    const v11ChunkOriginalId = codec.encodeTypedTelemetryId(v11ChunkId);
    const v11QuotaChunkOriginalId = codec.encodeTypedTelemetryId(v11QuotaChunkId);
    const v11ManifestOriginalId = codec.encodeTypedTelemetryId(v11Generation.manifestId);
    const dayNumber = Date.parse(`${day}T00:00:00.000Z`) / 86_400_000;
    await pool.query(`INSERT INTO ${table("typed_telemetry_namespaces")} (id,original_id) VALUES ($1,$2)`,
      [namespaceId, namespaceOriginalId]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_owners")} (id,namespace_id,original_id)
      VALUES ($1,$2,$3)`, [ownerId, namespaceId, ownerOriginalId]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_owner_memberships")} (
        namespace_id,source_format,owner_id,participant_id,source_namespace
      ) VALUES ($1,10,$2,$3,$4),($1,11,$2,$3,$4)`,
    [namespaceId, ownerId, participantId, sourceNamespace]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_devices")} (id,namespace_id,owner_id,original_id)
      VALUES ($1,$2,$3,$4)`, [deviceStorageId, namespaceId, ownerId, deviceOriginalId]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_manifests")} (
        id,namespace_id,owner_id,device_id,original_id,chunk_day
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [v11ManifestStorageId, namespaceId, ownerId, deviceStorageId, v11ManifestOriginalId, dayNumber]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_chunks")} (
        id,namespace_id,format,owner_id,device_id,manifest_id,original_id,stream,chunk_day
      ) VALUES ($1,$2,10,$3,$4,NULL,$5,3,$6),($7,$2,10,$3,$4,NULL,$8,2,$6),
               ($9,$2,11,$3,$4,$10,$11,3,$6),($12,$2,11,$3,$4,$10,$13,2,$6)`,
    [v1ChunkStorageId, namespaceId, ownerId, deviceStorageId, v1ChunkOriginalId, dayNumber,
      v1QuotaChunkStorageId, v1QuotaChunkOriginalId, v11ChunkStorageId, v11ManifestStorageId,
      v11ChunkOriginalId, v11QuotaChunkStorageId, v11QuotaChunkOriginalId]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_dictionary")} (id,value)
      VALUES (1,'codex'),(2,'shell'),(3,'pro'),(4,'unknown'),(5,'primary')`);
    const typedDigests = new Map();
    const typedFields = new Map();
    for (const row of typedRows) {
      const value = sourceRecords.get(row.storageRowId);
      const fields = codec.encodeTypedTelemetryRecord(row.format, value);
      const canonical = codec.typedTelemetryCanonicalRecords(fields).canonicalRecord;
      const digest = await sha256Hex(canonical);
      typedDigests.set(row.storageRowId, Buffer.from(digest, "hex"));
      typedFields.set(row.storageRowId, fields);
      await pool.query(`INSERT INTO ${table("typed_telemetry_records")} (
          id,namespace_id,format,source_row_id,owner_id,device_id,chunk_id,manifest_id,stream,
          occurrence_id,observed_at_ms,observed_day,provider_id,canonical_digest
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13)`,
      [row.storageRowId, namespaceId, row.format === "v1" ? 10 : 11, row.sourceRowId,
        ownerId, deviceStorageId, row.chunkId, row.manifestId, row.stream, fields.occurrenceId,
        fields.observedAtMs, dayNumber, Buffer.from(digest, "hex")]);
      if (row.stream === 3) {
        await pool.query(`INSERT INTO ${table("typed_telemetry_session_tools")} (record_id,stream,tool_class_id,count)
          VALUES ($1,3,2,2)`, [row.storageRowId]);
      }
    }
    await pool.query(`INSERT INTO ${table("typed_telemetry_attributions")} (
        id,namespace_id,owner_id,account_basis,account_track,plan_basis,plan_type_id,plan_era
      ) VALUES (1,$1,$2,0,''::bytea,1,3,''::bytea)`, [namespaceId, ownerId]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_quota_dimensions")} (
        id,namespace_id,owner_id,plan_type_id,plan_variant_id,attribution_id
      ) VALUES (1,$1,$2,3,4,NULL),(2,$1,$2,3,4,1)`, [namespaceId, ownerId]);
    await pool.query(`INSERT INTO ${table("typed_telemetry_quota")} (
        record_id,stream,dimensions_id,limit_id,slot_id,used_percent,window_duration_minutes,resets_at_ms
      ) VALUES (503,2,1,1,5,35,10080,$1),(603,2,2,1,5,35,10080,$1)`,
    [Date.parse("2026-10-01T00:00:00.000Z")]);
    await pool.query(`INSERT INTO ${table("typed_v1_admission_state")} (
        id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id
      ) VALUES (1,$1,$2,1,20)`, [sourceNamespace, namespaceId]);
    await pool.query(`INSERT INTO ${table("typed_v11_admission_state")} (
        id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id
      ) VALUES (1,$1,$2,1,30)`, [sourceNamespace, namespaceId]);
    await pool.query(`INSERT INTO ${table("typed_v1_chunk_allocations")} (
        chunk_id,namespace_id,chunk_original,first_source_row_id,record_count
      ) VALUES ($1,$2,$3,17,2),($4,$2,$5,19,1)`,
    [v1ChunkId, namespaceId, Buffer.from(v1ChunkOriginalId), v1QuotaChunkId, Buffer.from(v1QuotaChunkOriginalId)]);
    await pool.query(`INSERT INTO ${table("typed_v11_chunk_allocations")} (
        chunk_id,namespace_id,chunk_original,first_source_row_id,record_count
      ) VALUES ($1,$2,$3,27,2),($4,$2,$5,29,1)`,
    [v11ChunkId, namespaceId, Buffer.from(v11ChunkOriginalId), v11QuotaChunkId, Buffer.from(v11QuotaChunkOriginalId)]);
    await pool.query(`INSERT INTO ${table("typed_v11_manifest_memberships")} (manifest_id,typed_manifest_id)
      VALUES ($1,$2)`, [v11Generation.manifestId, v11ManifestStorageId]);
    for (const row of v1Records) {
      await pool.query(`INSERT INTO ${table("typed_v1_record_admissions")} (typed_record_id,chunk_id)
        VALUES ($1,$2)`, [row.storageRowId, row.chunkId === v1ChunkStorageId ? v1ChunkId : v1QuotaChunkId]);
    }
    for (const row of v11Records) {
      if (row === v11Records.at(-1)) break;
      const fields = typedFields.get(row.storageRowId);
      await pool.query(`INSERT INTO ${table("typed_v11_record_proofs")} (
          typed_record_id,chunk_key,manifest_key,stream_code,occurrence_blob,base_digest,
          legacy_occurrence_blob,legacy_digest,observed_at_ms
        ) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7)`,
      [row.storageRowId, row.chunkId, row.manifestId, row.stream, Buffer.from(fields.occurrenceId),
        typedDigests.get(row.storageRowId), fields.observedAtMs]);
    }
    assert.equal((await pool.query(`SELECT count(*) AS count FROM ${table("telemetry_v1_records")}`)).rows[0].count, "0");
    assert.equal((await pool.query(`SELECT count(*) AS count FROM ${table("telemetry_v11_records")}`)).rows[0].count, "0");
    const receipts = [
      { sourceFormat: 10, generation: 1, sourceDigest: randomBytes(32).toString("hex"), sourceRowCount: 3, membershipRowCount: 1 },
      { sourceFormat: 11, generation: 1, sourceDigest: randomBytes(32).toString("hex"), sourceRowCount: 3, membershipRowCount: 1 },
    ];
    await assert.rejects(reader.finalizePostgresTypedLegacyFamilyReceipts(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema }, receipts,
    }), (error) => error?.code === "POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT",
    "nonempty typed rows cannot be attested while their event-source lineage is absent");
    assert.equal((await pool.query(`SELECT count(*) AS count FROM ${table("typed_telemetry_source_family_receipts")}`)).rows[0].count, "0",
      "missing lineage does not partially publish either source-family receipt");

    await pool.query(`DELETE FROM ${table("typed_v1_record_admissions")} WHERE typed_record_id=$1`, [v1Records[1].storageRowId]);
    await assert.rejects(pool.query(`INSERT INTO ${table("typed_v1_event_sources")} (
        event_digest,owner_digest,participant_id,chunk_id,source_namespace
      ) VALUES ($1,$2,$3,$4,$5)`,
    [randomBytes(32).toString("hex"), ownerDigest, participantId, v1ChunkId, sourceNamespace]),
    (error) => error?.message?.includes("telemetry_source_membership_invalid"),
    "v1 event publication requires the exact admitted record count");
    await pool.query(`INSERT INTO ${table("typed_v1_record_admissions")} (typed_record_id,chunk_id) VALUES ($1,$2)`,
      [v1Records[1].storageRowId, v1ChunkId]);
    await assert.rejects(pool.query(`INSERT INTO ${table("typed_v1_event_sources")} (
        event_digest,owner_digest,participant_id,chunk_id,source_namespace
      ) VALUES ($1,$2,$3,$4,$5)`,
    [randomBytes(32).toString("hex"), ownerDigest, participantId, v1ChunkId, `${sourceNamespace}-other`]),
    (error) => error?.message?.includes("telemetry_source_membership_invalid"),
    "v1 event publication is pinned to the admitted source namespace");
    const v1EventDigest = randomBytes(32).toString("hex");
    await pool.query(`INSERT INTO ${table("typed_v1_event_sources")} (
        event_digest,owner_digest,participant_id,chunk_id,source_namespace
      ) VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$7,$5)`,
    [v1EventDigest, ownerDigest, participantId, v1ChunkId, sourceNamespace,
      randomBytes(32).toString("hex"), v1QuotaChunkId]);
    await pool.query(`INSERT INTO ${table("storage_v11_event_sources")} (
        event_digest,owner_digest,participant_id,device_id,generation_id,manifest_digest,
        from_day,through_day,head_revision,input_revision,recorded_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$7::date,1,0,$8)`,
    [randomBytes(32).toString("hex"), ownerDigest, participantId, deviceId, v11Generation.generationId,
      v11Generation.manifestDigest, day, Date.now()]);

    await assert.rejects(reader.finalizePostgresTypedLegacyFamilyReceipts(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema }, receipts,
    }), (error) => error?.code === "POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT",
    "a typed v1.1 record without its explicit proof cannot complete family lineage");
    const lastV11 = v11Records.at(-1);
    const lastV11Fields = typedFields.get(lastV11.storageRowId);
    await pool.query(`INSERT INTO ${table("typed_v11_record_proofs")} (
        typed_record_id,chunk_key,manifest_key,stream_code,occurrence_blob,base_digest,
        legacy_occurrence_blob,legacy_digest,observed_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7)`,
    [lastV11.storageRowId, lastV11.chunkId, lastV11.manifestId, lastV11.stream,
      Buffer.from(lastV11Fields.occurrenceId), typedDigests.get(lastV11.storageRowId), lastV11Fields.observedAtMs]);

    await assert.rejects(reader.finalizePostgresTypedLegacyFamilyReceipts(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema },
      receipts: receipts.map((receipt) => receipt.sourceFormat === 10
        ? { ...receipt, sourceRowCount: 2 } : receipt),
    }), (error) => error?.code === "POSTGRES_LEGACY_EFFECTIVE_SOURCE_CONFLICT",
    "the finalizer independently rechecks source and membership counts");
    assert.equal((await pool.query(`SELECT count(*) AS count FROM ${table("typed_telemetry_source_family_receipts")}`)).rows[0].count, "0",
      "the atomic receipt set is not partially written after a count mismatch");

    await reader.finalizePostgresTypedLegacyFamilyReceipts(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema }, receipts,
    });
    await assert.rejects(reader.listPostgresEffectiveOwners(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema },
    }), (error) => error?.code === "POSTGRES_LEGACY_EFFECTIVE_UNAVAILABLE",
    "base family receipts alone cannot activate typed reads without the 0033 lineage receipt");
    await pool.query(`INSERT INTO ${table("typed_telemetry_admission_transfer_receipts")} (
      transfer_id,v1_source_namespace,v1_source_format,v11_source_namespace,v11_source_format,
        v1_base_generation,v11_base_generation,source_snapshot_sha256,lineage_manifest_sha256,table_row_counts
      ) VALUES ($1,$2,10,$2,11,1,1,$3,$4,$5::jsonb)`,
    [`synthetic-admission-transfer-${randomUUID()}`, sourceNamespace, randomBytes(32).toString("hex"),
      randomBytes(32).toString("hex"), JSON.stringify({
        typed_v1_chunk_allocations: 2,
        typed_v1_record_admissions: 3,
        typed_v1_event_sources: 2,
        typed_v11_chunk_allocations: 2,
        typed_v11_manifest_memberships: 1,
        typed_v11_record_proofs: 3,
        storage_v11_event_sources: 1,
      })]);
    const page = await reader.listPostgresEffectiveOwners(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema }, limit: 1,
    });
    assert.equal(page.available, true);
    assert.equal(page.sourcePin.storageAuthorityEpoch, 3);
    assert.equal(page.sourcePin.sourceCursorSequence, 41);
    assert.equal(page.sourcePin.sourceCursorAuthorityEpoch, 7);
    assert.equal(page.owners.length, 1);
    assert.deepEqual({
      ownerDigest: page.owners[0].ownerDigest,
      participantId: page.owners[0].participantId,
      hasV1: page.owners[0].hasV1,
      hasV11: page.owners[0].hasV11,
      hasV12: page.owners[0].hasV12,
      hasLegacy: page.owners[0].hasLegacy,
      hasEffective: page.owners[0].hasEffective,
    }, { ownerDigest, participantId, hasV1: true, hasV11: true, hasV12: false, hasLegacy: true, hasEffective: false });

    const options = { sourceId, sourceNamespace, ownerDigest, day, stream: "session", limit: 1, sourceFetchBatchSize: 1,
      expectedPin: page.owners[0].pin, schema: { primarySchema: schema } };
    const first = await reader.readPostgresEffectiveHistoryPage(pool, options);
    assert.equal(first.available, true);
    assert.equal(first.correctionFamilyAvailable, null);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].status, "compatible");
    assert.deepEqual(first.rows[0].sourceFormats, ["v1", "v11"]);
    assert.equal(first.rows[0].sourceCount, 2);
    assert.match(first.rows[0].sourceFingerprint, /^[a-f0-9]{64}$/u);
    const largerFetch = await reader.readPostgresEffectiveHistoryPage(pool, { ...options, sourceFetchBatchSize: 2 });
    assert.equal(largerFetch.rows[0].sourceFingerprint, first.rows[0].sourceFingerprint,
      "the occurrence fingerprint stays stable when database source rows cross a different number of fetch pages");
    assert.ok(first.next);
    const second = await reader.readPostgresEffectiveHistoryPage(pool, { ...options, after: first.next });
    assert.equal(second.rows.length, 1);
    assert.equal(second.rows[0].status, "conflict");
    assert.equal(second.rows[0].eventTimeConflict, true);
    assert.equal(second.rows[0].recordJson, null);
    assert.equal(second.next, null);
    const quota = await reader.readPostgresEffectiveHistoryPage(pool, { ...options, stream: "quota" });
    assert.equal(quota.available, true);
    assert.equal(quota.rows.length, 1);
    assert.equal(quota.rows[0].status, "compatible");
    assert.deepEqual(quota.rows[0].sourceFormats, ["v1", "v11"]);
    assert.equal(quota.rows[0].sourceCount, 2);
    assert.equal(quota.rows[0].eventTimeConflict, false);
    assert.equal(JSON.parse(quota.rows[0].recordJson).usedPercent, 35,
      "v1/v1.1 quota fields agree after applying the legacy attribution projection");
    const usage = await reader.readPostgresEffectiveHistoryPage(pool, { ...options, stream: "usage" });
    assert.deepEqual({ available: usage.available, correctionFamilyAvailable: usage.correctionFamilyAvailable },
      { available: false, correctionFamilyAvailable: false },
      "legacy usage remains explicitly unavailable without the correction transfer");

    await pool.query(`UPDATE ${table("storage_v11_owner_links")} SET state='withdrawn' WHERE participant_id=$1`, [participantId]);
    await assert.rejects(reader.assertPostgresEffectiveHistoryCurrent(pool, {
      sourceId, sourceNamespace, ownerDigest, pin: page.owners[0].pin, schema: { primarySchema: schema },
    }), (error) => error?.code === "POSTGRES_LEGACY_EFFECTIVE_CAS_MISMATCH",
    "withdrawn owner authority invalidates the pinned history read");
    const afterWithdrawal = await reader.listPostgresEffectiveOwners(pool, {
      sourceId, sourceNamespace, schema: { primarySchema: schema },
    });
    assert.equal(afterWithdrawal.owners.length, 0);
  } finally {
    if (vite) await vite.close();
    if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
});
