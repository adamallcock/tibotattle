import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "accountless erasure tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT };
  return null;
}

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

function randomDigest() {
  return randomBytes(32).toString("hex");
}

async function seedAccountlessOwner(pool, schema, supplied = {}) {
  const participantId = supplied.participantId ?? `participant:${randomUUID()}`;
  const deviceId = supplied.deviceId ?? randomUUID();
  const ownerDigest = supplied.ownerDigest ?? randomDigest();
  const sourceImportId = supplied.sourceImportId ?? randomDigest();
  const now = new Date("2026-09-24T12:00:00.000Z");
  const later = new Date("2026-10-24T12:00:00.000Z");
  const secretHash = randomBytes(32);

  await pool.query(
    `INSERT INTO ${q(schema, "accountless_enrollment_ledger")} (
       device_id,device_secret_hash,installation_principal_id,schema_version,policy_version,
       authorization_basis,state,issued_at,expires_at
     ) VALUES ($1,$2,$3,'accountless-enrollment-v0.1','accountless-opt-out-v1',
       'accountless-policy-v1','active',$4,$5)`,
    [deviceId, secretHash, `synthetic-install-${randomUUID()}`, now, later],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (
       id,owner_kind,state,consent_version,consented_at,created_at
     ) VALUES ($1,'accountless','active',NULL,NULL,$2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id,participant_id,authority_kind,paired_via_pairing_id,accountless_enrollment_device_id,
       secret_hash,state,issued_at,expires_at,last_used_at,revoked_at,social_verified_at
     ) VALUES ($1,$2,'accountless',NULL,$1,$3,'active',$4,$5,$4,NULL,NULL)`,
    [deviceId, participantId, secretHash, now, later],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_upload_owners")} (
       enrollment_device_id,participant_id,device_credential_id,policy_version,authorization_basis,
       authorized_at,expires_at,state
     ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`,
    [deviceId, participantId, now, later],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_v11_device_authorizations")} (
       enrollment_device_id,participant_id,device_credential_id,telemetry_schema_version,
       field_dictionary_version,privacy_contract_version,authorized_at,expires_at,state
     ) VALUES ($1,$2,$1,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
       'ongoing-privacy-safe-telemetry-v1.1',$3,$4,'active')`,
    [deviceId, participantId, now, later],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_v12_device_authorizations")} (
       enrollment_device_id,participant_id,device_credential_id,schema_version,policy_version,
       authorization_basis,telemetry_schema_version,field_dictionary_version,privacy_contract_version,
       authorized_at,expires_at,state
     ) VALUES ($1,$2,$1,'accountless-upload-owner-v1.2','accountless-telemetry-v1.2-policy-v1',
       'accountless-policy-v1.2','telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
       'ongoing-privacy-safe-telemetry-v1.2',$3,$4,'active')`,
    [deviceId, participantId, now, later],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v1_device_consents")} (
       participant_id,device_id,telemetry_schema_version,field_dictionary_version,
       privacy_contract_version,consented_at
     ) VALUES ($1,$2,'telemetry-contribution-v1.0','telemetry-v1.0-registry-2026-08-07.1',
       'ongoing-privacy-safe-telemetry-v1.0',$3)`,
    [participantId, deviceId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_device_consents")} (
       participant_id,device_id,telemetry_schema_version,field_dictionary_version,
       privacy_contract_version,consented_at
     ) VALUES ($1,$2,'telemetry-contribution-v1.1','telemetry-v1.1-registry-2026-08-31.1',
       'ongoing-privacy-safe-telemetry-v1.1',$3)`,
    [participantId, deviceId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v12_device_capabilities")} (
       participant_id,device_id,telemetry_schema_version,field_dictionary_version,
       privacy_contract_version,state,consented_at
     ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
       'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`,
    [participantId, deviceId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
     VALUES ($1,$2,'active')`,
    [participantId, ownerDigest],
  );

  const v11ManifestId = randomUUID();
  const v11GenerationId = randomUUID();
  const v11Predecessor = randomDigest();
  const v11Digest = randomDigest();
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_domain_predecessors")} (
       token_hash,participant_id,device_id,legacy_fingerprint,input_revision,from_day,through_day,
       winners_json,created_at,expires_at
     ) VALUES ($1,$2,$3,$4,0,DATE '2026-09-24',DATE '2026-09-24','[]',$5,$6)`,
    [v11Predecessor, participantId, deviceId, randomDigest(), now, later],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_domains")} (
       id,participant_id,device_id,predecessor_token_hash,manifest_digest,legacy_fingerprint,
       input_revision,from_day,through_day,days_json,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,0,DATE '2026-09-24',DATE '2026-09-24','[]',$7)`,
    [v11GenerationId, participantId, deviceId, v11Predecessor, randomDigest(), randomDigest(), now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_domain_heads")} (participant_id,generation_id,revision,updated_at)
     VALUES ($1,$2,1,$3)`,
    [participantId, v11GenerationId, now],
  );

  const upload = async (kind) => {
    const authorizationId = randomUUID();
    const contributionId = `chunk:${randomUUID()}`;
    const objectKey = `synthetic/erasure/${kind}/${randomUUID()}`;
    const digest = randomDigest();
    await pool.query(
      `INSERT INTO ${q(schema, "device_upload_authorizations")} (
         id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,
         state,issued_at,expires_at,consumed_at,consumed_contribution_id
       ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7,$6,$8)`,
      [authorizationId, participantId, deviceId, randomBytes(32), digest, now, later, contributionId],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "pending_objects")} (contribution_id,object_key,object_kind)
       VALUES ($1,$2,$3)`,
      [contributionId, objectKey, kind],
    );
    return { authorizationId, contributionId, objectKey, digest };
  };

  const v1 = await upload("telemetry_v1");
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v1_chunks")} (
       id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
       parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at
     ) VALUES ($1,$2,$3,'usage',DATE '2026-09-24',0,1,$4,$5,'synthetic-v1',1,1,$6,$7,$8)`,
    [v1.contributionId, participantId, deviceId, v1.digest, randomDigest(), v1.objectKey, v1.authorizationId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v1_records")} (
       chunk_row_id,participant_id,device_id,stream,occurrence_id,observed_at,observed_day,record_json
     ) VALUES ($1,$2,$3,'usage',$4,$5,DATE '2026-09-24','{}'::jsonb)`,
    [v1.contributionId, participantId, deviceId, randomUUID(), now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "typed_v1_event_sources")} (
       event_digest,owner_digest,participant_id,chunk_id,source_namespace
     ) VALUES ($1,$2,$3,$4,'synthetic-accountless-erasure')`,
    [randomDigest(), ownerDigest, participantId, v1.contributionId],
  );

  const v11 = await upload("telemetry_v11");
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_day_manifests")} (
       id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
       expected_chunk_count,state,created_at
     ) VALUES ($1,$2,$3,DATE '2026-09-24',$4,'synthetic-v1.1','{}',1,'staged',$5)`,
    [v11ManifestId, participantId, deviceId, v11Digest, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v11_chunks")} (
       id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
       envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at
     ) VALUES ($1,$2,$3,$4,'usage',DATE '2026-09-24',0,$5,$6,$7,'synthetic-v1.1',1,$8,$9,$10)`,
    [v11.contributionId, v11ManifestId, participantId, deviceId, randomUUID(), v11.digest,
      randomDigest(), v11.objectKey, v11.authorizationId, now],
  );

  const v12 = await upload("telemetry_v12");
  const v12ManifestId = randomUUID();
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v12_day_manifests")} (
       id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
       expected_chunk_count,state,created_at
     ) VALUES ($1,$2,$3,DATE '2026-09-24',$4,'synthetic-v1.2','{"day":"2026-09-24","chunks":[]}',1,'staged',$5)`,
    [v12ManifestId, participantId, deviceId, v12.digest, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v12_chunks")} (
       id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
       envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at
     ) VALUES ($1,$2,$3,$4,'usage',DATE '2026-09-24',0,$5,$6,$7,'synthetic-v1.2',1,$8,$9,$10)`,
    [v12.contributionId, v12ManifestId, participantId, deviceId, randomUUID(), v12.digest,
      randomDigest(), v12.objectKey, v12.authorizationId, now],
  );

  const headerCounts = {
    telemetry_v11_chunks: 1,
    telemetry_v11_day_manifests: 1,
    telemetry_v1_chunks: 1,
  };
  const headerDigests = Object.fromEntries(Object.keys(headerCounts).map((name) => [name, randomDigest()]));
  const archiveClient = await pool.connect();
  try {
    await archiveClient.query("BEGIN");
    await archiveClient.query(`SET LOCAL search_path TO ${q(schema, "participants").split(".")[0]}, pg_catalog`);
    await archiveClient.query(
      `INSERT INTO ${q(schema, "historical_transport_header_imports")} (
         source_import_id,target_schema,source_snapshot_id,source_snapshot_kind,source_snapshot_sha256,
         source_manifest_sha256,v1_source_namespace,v11_source_namespace,header_manifest_sha256,
         header_table_row_counts,header_table_sha256,mirror_control_schema,mirror_transfer_id,mirror_receipt_sha256
       ) VALUES ($1,$2,'synthetic-accountless-erasure','synthetic-d1-fixture',$3,$4,
         'synthetic-v1-namespace','synthetic-v11-namespace',$5,$6::jsonb,$7::jsonb,
         'typed_legacy_admission_transfer_aaaaaaaa','synthetic-accountless-erasure',$8)`,
      [sourceImportId, schema, randomDigest(), randomDigest(), randomDigest(),
        JSON.stringify(headerCounts), JSON.stringify(headerDigests), randomDigest()],
    );
    await archiveClient.query("SELECT set_config('tibotattle.legacy_header_promotion',$1,true)", [sourceImportId]);
    const archivedV11ManifestId = randomUUID();
    const archivedV11ChunkId = `chunk:${randomUUID()}`;
    const archivedV11ChunkDigest = randomDigest();
    const archivedV11Manifest = JSON.stringify({ day: "2026-09-23", chunks: [{
      chunkId: archivedV11ChunkId,
      chunkDigest: archivedV11ChunkDigest,
      recordCount: 1,
    }] });
    await archiveClient.query(
      `INSERT INTO ${q(schema, "historical_telemetry_v11_manifest_headers")} (
         source_import_id,id,participant_id,device_id,chunk_day,manifest_digest,parser_version,
         manifest_json,expected_chunk_count,state,created_at
       ) VALUES ($1,$2,$3,$4,'2026-09-23',$5,'synthetic-archived-v1.1',$6,1,'staged',
         '2026-09-23T10:00:00.000Z')`,
      [sourceImportId, archivedV11ManifestId, participantId, deviceId, randomDigest(), archivedV11Manifest],
    );
    await archiveClient.query(
      `INSERT INTO ${q(schema, "historical_telemetry_v11_chunk_headers")} (
         source_import_id,id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,
         chunk_id,chunk_digest,envelope_digest,parser_version,record_count,r2_key,
         device_upload_authorization_id,created_at
       ) VALUES ($1,$2,$3,$4,$5,'usage','2026-09-23',0,$6,$7,$8,'synthetic-archived-v1.1',1,
         'synthetic/erasure/archive/v1.1','synthetic-archive-v1.1-grant','2026-09-23T10:00:00.000Z')`,
      [sourceImportId, archivedV11ChunkId, archivedV11ManifestId, participantId, deviceId,
        archivedV11ChunkId, archivedV11ChunkDigest, randomDigest()],
    );
    await archiveClient.query(
      `INSERT INTO ${q(schema, "historical_telemetry_v1_chunk_headers")} (
         source_import_id,id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,
         chunk_digest,envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
         device_upload_authorization_id,created_at
       ) VALUES ($1,'synthetic-archived-v1-header',$2,$3,'usage','2026-09-23',0,1,$4,$5,
         'synthetic-archived-v1',1,1,'synthetic/erasure/archive/v1','synthetic-archive-grant',
         '2026-09-23T10:00:00.000Z')`,
      [sourceImportId, participantId, deviceId, randomDigest(), randomDigest()],
    );
    await archiveClient.query("COMMIT");
  } catch (error) {
    await archiveClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    archiveClient.release();
  }

  // Reproduce opt-out: the marker is pinned while every accountless grant is
  // still accepted, then renewal/upload authority is revoked. Public history
  // stays source-bound until this separate owner erasure runs.
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_public_history_retention")} (
       participant_id,enrollment_device_id,device_credential_id,generation_id,head_revision,retained_at
     ) VALUES ($1,$2,$2,$3,1,$4)`,
    [participantId, deviceId, v11GenerationId, now],
  );
  await pool.query(
    `UPDATE ${q(schema, "accountless_enrollment_ledger")}
        SET state='revoked',revoked_at=$2,revocation_reason='user_opt_out' WHERE device_id=$1`,
    [deviceId, now],
  );
  await pool.query(
    `UPDATE ${q(schema, "accountless_upload_owners")}
        SET state='revoked',revoked_at=$2,revocation_reason='user_opt_out' WHERE participant_id=$1`,
    [participantId, now],
  );
  await pool.query(
    `UPDATE ${q(schema, "accountless_v11_device_authorizations")}
        SET state='revoked',revoked_at=$2,revocation_reason='user_opt_out' WHERE participant_id=$1`,
    [participantId, now],
  );
  await pool.query(
    `UPDATE ${q(schema, "accountless_v12_device_authorizations")}
        SET state='revoked',revoked_at=$2,revocation_reason='user_opt_out' WHERE participant_id=$1`,
    [participantId, now],
  );
  await pool.query(
    `UPDATE ${q(schema, "device_credentials")} SET state='revoked',revoked_at=$2 WHERE id=$1`,
    [deviceId, now],
  );

  return {
    participantId,
    deviceId,
    ownerDigest,
    sourceImportId,
    objectKeys: [v1.objectKey, v11.objectKey, v12.objectKey,
      "synthetic/erasure/archive/v1", "synthetic/erasure/archive/v1.1"].sort(),
  };
}

function failParticipantDeleteOnce(pool, schema) {
  let failed = false;
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query(text, values) {
          if (!failed && typeof text === "string"
              && text.includes(`DELETE FROM ${q(schema, "participants")}`)) {
            failed = true;
            return Promise.reject(new Error("synthetic transaction interruption"));
          }
          return client.query(text, values);
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

async function loadEraser(vite) {
  return vite.ssrLoadModule("/src/postgres-accountless-owner-erasure.ts");
}

async function createSchema(pool, schema, role = "primary") {
  await pool.query(`CREATE SCHEMA ${q(schema, "unused").split(".")[0]}`);
  await applyPostgresMigrations({ role, schema, pool });
}

async function count(pool, schema, name, column, value) {
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM ${q(schema, name)} WHERE ${column}=$1`, [value],
  );
  return result.rows[0].count;
}

test("PG17 accountless erasure removes opt-out history markers across v1/v1.1/v1.2, resumes after interruption, and suppresses restored state", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `typed_legacy_target_erasure_${suffix}`;
  const restoredSchema = `typed_legacy_target_restore_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const poolOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 8,
    connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool(poolOptions);
  const restoredPool = new pg.Pool(poolOptions);
  const ledgerPool = new pg.Pool(poolOptions);
  const schemas = [];
  let vite;
  try {
    const version = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17,
      "accountless erasure is qualified against PostgreSQL 17");
    await createSchema(primaryPool, primarySchema);
    schemas.push(primarySchema);
    await createSchema(primaryPool, ledgerSchema, "ledger");
    schemas.push(ledgerSchema);
    await createSchema(restoredPool, restoredSchema);
    schemas.push(restoredSchema);
    vite = await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
    const { erasePostgresAccountlessOwner } = await loadEraser(vite);
    const fixture = await seedAccountlessOwner(primaryPool, primarySchema);
    const calls = [];
    let failObjectDelete = true;
    const objectStore = {
      async deleteBatch(refs) {
        assert.ok(refs.length <= 100);
        calls.push(refs.map((ref) => ({ source: ref.source, id: ref.id, key: ref.key, version: ref.version })));
        if (failObjectDelete) {
          failObjectDelete = false;
          throw new Error("synthetic provider interruption");
        }
      },
    };
    const options = {
      primaryPool,
      ledgerPool,
      objectStore,
      participantId: fixture.participantId,
      schema: { primarySchema, ledgerSchema },
    };

    const providerFailure = await erasePostgresAccountlessOwner(options);
    assert.deepEqual(providerFailure, {
      status: "incomplete", code: "ACCOUNTLESS_OWNER_ERASURE_OBJECT_STORE_FAILED",
    });
    assert.equal(await count(primaryPool, primarySchema, "participants", "id", fixture.participantId), 1);
    assert.equal(await count(primaryPool, primarySchema, "accountless_public_history_retention", "participant_id", fixture.participantId), 1);
    assert.equal(await count(primaryPool, primarySchema, "accountless_enrollment_ledger", "device_id", fixture.deviceId), 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map((ref) => ref.key).sort(), fixture.objectKeys);
    assert.deepEqual(new Set(calls[0].map((ref) => ref.source)), new Set(["telemetry_v1", "telemetry_v11", "telemetry_v12"]));
    assert.ok(calls[0].every((ref) => ref.version === null));

    const interruptedAfterObjectDelete = await erasePostgresAccountlessOwner({
      ...options,
      primaryPool: failParticipantDeleteOnce(primaryPool, primarySchema),
    });
    assert.deepEqual(interruptedAfterObjectDelete, {
      status: "incomplete", code: "ACCOUNTLESS_OWNER_ERASURE_READBACK_FAILED",
    });
    assert.equal(calls.length, 2, "provider success before primary failure is replayed idempotently");
    assert.deepEqual(calls[1].map((ref) => ref.key).sort(), fixture.objectKeys);
    assert.equal(await count(primaryPool, primarySchema, "participants", "id", fixture.participantId), 1);
    assert.equal(await count(primaryPool, primarySchema, "accountless_public_history_retention", "participant_id", fixture.participantId), 1,
      "the pinned public-history marker remains until the primary erasure transaction commits");
    const retainedMarker = await primaryPool.query(
      `SELECT generation_id,head_revision FROM ${q(primarySchema, "accountless_public_history_retention")}
        WHERE participant_id=$1`, [fixture.participantId],
    );
    assert.equal(retainedMarker.rowCount, 1);
    const interruptedReceipt = await ledgerPool.query(
      `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(interruptedReceipt.rows[0]?.outcome, "failed");
    assert.equal(JSON.parse(interruptedReceipt.rows[0]?.details_json).phase, "objects_deleted");
    assert.equal(interruptedReceipt.rows[0]?.details_json.includes(fixture.participantId), false);
    assert.equal(interruptedReceipt.rows[0]?.details_json.includes("synthetic/erasure"), false);

    const completed = await erasePostgresAccountlessOwner(options);
    assert.deepEqual(completed, { status: "complete", objectsDeleted: 5 });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].map((ref) => ref.key).sort(), fixture.objectKeys);
    assert.equal(await count(primaryPool, primarySchema, "participants", "id", fixture.participantId), 0);
    assert.equal(await count(primaryPool, primarySchema, "accountless_public_history_retention", "participant_id", fixture.participantId), 0,
      "participant erasure cascades the accountless opt-out retained-history marker");
    assert.equal(await count(primaryPool, primarySchema, "accountless_upload_owners", "participant_id", fixture.participantId), 0);
    assert.equal(await count(primaryPool, primarySchema, "accountless_enrollment_ledger", "device_id", fixture.deviceId), 0,
      "accountless installation identity is removed after all restrict references cascade");
    assert.equal(await count(primaryPool, primarySchema, "pending_objects", "object_key", fixture.objectKeys[0]), 0);
    const proof = await primaryPool.query(
      `SELECT owner_digest FROM ${q(primarySchema, "storage_owner_erasure_receipts")} WHERE owner_digest=$1`,
      [fixture.ownerDigest],
    );
    assert.equal(proof.rowCount, 1);
    const durable = await ledgerPool.query(
      `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(durable.rows[0]?.outcome, "completed");
    assert.equal(JSON.parse(durable.rows[0]?.details_json).objectCount, 5);
    const repeated = await erasePostgresAccountlessOwner(options);
    assert.deepEqual(repeated, { status: "already_complete", objectsDeleted: 5 });
    assert.equal(calls.length, 3, "already-complete retry performs no provider operations");

    // Restore the participant and its retained marker from a pre-erasure
    // backup into a separate primary schema while keeping the independent
    // ledger. A completed ledger receipt must cause cleanup to run again.
    await seedAccountlessOwner(restoredPool, restoredSchema, fixture);
    assert.equal(await count(restoredPool, restoredSchema, "accountless_public_history_retention", "participant_id", fixture.participantId), 1);
    const restored = await erasePostgresAccountlessOwner({
      ...options,
      primaryPool: restoredPool,
      schema: { primarySchema: restoredSchema, ledgerSchema },
    });
    assert.deepEqual(restored, { status: "complete", objectsDeleted: 5 });
    assert.equal(await count(restoredPool, restoredSchema, "participants", "id", fixture.participantId), 0);
    assert.equal(await count(restoredPool, restoredSchema, "accountless_public_history_retention", "participant_id", fixture.participantId), 0,
      "a restored marker is removed again under the prior durable owner-erasure receipt");
    assert.equal(calls.length, 4);
    const stillCompleted = await ledgerPool.query(
      `SELECT outcome FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(stillCompleted.rows[0]?.outcome, "completed",
      "restore replay does not downgrade terminal ledger receipt authority");
  } finally {
    if (vite) await vite.close();
    for (const schema of schemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS ${q(schema, "unused").split(".")[0]} CASCADE`); } catch {}
    }
    await Promise.all([primaryPool.end(), restoredPool.end(), ledgerPool.end()]);
  }
});

test("PG17 accountless erasure refuses unattributable telemetry objects before provider deletion", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `typed_legacy_target_orphan_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const options = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 6,
    connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool(options);
  const ledgerPool = new pg.Pool(options);
  const schemas = [];
  let vite;
  try {
    const version = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17);
    await createSchema(primaryPool, primarySchema);
    schemas.push(primarySchema);
    await createSchema(primaryPool, ledgerSchema, "ledger");
    schemas.push(ledgerSchema);
    vite = await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
    const { erasePostgresAccountlessOwner } = await loadEraser(vite);
    const fixture = await seedAccountlessOwner(primaryPool, primarySchema);
    const orphanId = `chunk:${randomUUID()}`;
    const orphanKey = `synthetic/erasure/orphan/${randomUUID()}`;
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "pending_objects")} (contribution_id,object_key,object_kind)
       VALUES ($1,$2,'telemetry_v11')`,
      [orphanId, orphanKey],
    );
    let deletes = 0;
    const result = await erasePostgresAccountlessOwner({
      primaryPool,
      ledgerPool,
      participantId: fixture.participantId,
      schema: { primarySchema, ledgerSchema },
      objectStore: { async deleteBatch() { deletes += 1; } },
    });
    assert.deepEqual(result, {
      status: "incomplete", code: "ACCOUNTLESS_OWNER_ERASURE_PENDING_UNATTRIBUTED",
    });
    assert.equal(deletes, 0);
    assert.equal(await count(primaryPool, primarySchema, "participants", "id", fixture.participantId), 1);
    assert.equal(await count(primaryPool, primarySchema, "accountless_public_history_retention", "participant_id", fixture.participantId), 1);
    assert.equal(await count(primaryPool, primarySchema, "pending_objects", "contribution_id", orphanId), 1);
    const receipts = await ledgerPool.query(
      `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
    );
    assert.equal(receipts.rows[0]?.outcome, "failed");
    assert.equal(JSON.parse(receipts.rows[0]?.details_json).phase, "pending_unattributed");
    assert.equal(receipts.rows[0]?.details_json.includes(orphanKey), false);
  } finally {
    if (vite) await vite.close();
    for (const schema of schemas.reverse()) {
      try { await primaryPool.query(`DROP SCHEMA IF EXISTS ${q(schema, "unused").split(".")[0]} CASCADE`); } catch {}
    }
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});
