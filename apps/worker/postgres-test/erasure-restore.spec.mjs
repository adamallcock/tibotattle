import { afterAll, beforeAll, expect, it } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { ApiError } from "../src/errors.ts";
import { eraseParticipantWithStore } from "../src/participant-erasure-store.ts";
import { createPostgresParticipantErasureStores } from "../src/postgres-participant-erasure-canonical.ts";
import { createPostgresRestoreSuppressionGate } from "../src/postgres-participant-erasure-canonical.ts";
import {
  preparePostgresStorageParticipantErasure,
  requirePostgresStorageParticipantErasureComplete,
} from "../src/postgres-storage-erasure.ts";

const { Pool } = pg;
const primarySchema = "tibotattle";
const ledgerSchema = "tibotattle_ledger";
const primaryDatabaseName = `tibotattle_erasure_primary_${randomBytes(10).toString("hex")}`;
const ledgerDatabaseName = `tibotattle_erasure_ledger_${randomBytes(10).toString("hex")}`;
const participantId = "participant:00000000-0000-4000-8000-000000000001";
const deviceId = "device-00000000-0000-4000-8000-000000000001";
const pairingId = "pairing-00000000-0000-4000-8000-000000000001";
const sessionId = "session-00000000-0000-4000-8000-000000000001";
const now = Date.parse("2026-09-21T12:00:00.000Z");
const hash = "a".repeat(64);
const zeros = "0".repeat(64);
const manifestV11 = "00000000-0000-4000-8000-000000000011";
const manifestV12 = "00000000-0000-4000-8000-000000000012";
let admin;
let primary;
let ledger;
let created = false;

function poolOptions(database, applicationName) {
  return {
    host: process.env.PG_TEST_SOCKET,
    port: Number(process.env.PG_TEST_PORT ?? "55432"),
    user: "postgres",
    password: "localtrust",
    database,
    ssl: false,
    options: "",
    application_name: applicationName,
    connectionTimeoutMillis: 3000,
    statement_timeout: 12000,
    idleTimeoutMillis: 1000,
    max: 3,
  };
}

async function seedParticipant() {
  const secret = Buffer.alloc(32, 1);
  const issued = new Date(now - 60_000);
  const expires = new Date(now + 86_400_000);
  await primary.query(`INSERT INTO ${primarySchema}.participants
    (id,owner_kind,state,created_at) VALUES($1,'social','active',$2)`, [participantId, issued]);
  await primary.query(`INSERT INTO ${primarySchema}.web_sessions
    (id,participant_id,secret_hash,csrf_hash,state,issued_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$3,'active',$4,$5,$4)`, [sessionId, participantId, secret, issued, expires]);
  await primary.query(`INSERT INTO ${primarySchema}.device_pairings
    (id,participant_id,issued_by_session_id,secret_hash,consent_version,transport_consent_version,
     state,issued_at,expires_at)
    VALUES($1,$2,$3,$4,'consent-v1','transport-v1','consumed',$5,$6)`,
  [pairingId, participantId, sessionId, secret, issued, expires]);
  await primary.query(`INSERT INTO ${primarySchema}.device_credentials
    (id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,issued_at,expires_at,last_used_at)
    VALUES($1,$2,'social',$3,$4,'active',$5,$6,$5)`,
  [deviceId, participantId, pairingId, secret, issued, expires]);
  for (const [id, envelope] of [
    ["auth-v1", "1".repeat(64)], ["auth-v11", "2".repeat(64)], ["auth-v12", "3".repeat(64)],
  ]) {
    await primary.query(`INSERT INTO ${primarySchema}.device_upload_authorizations
      (id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,
       state,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,1,'application/json','unused',$6,$7)`,
    [id, participantId, deviceId, secret, envelope, issued, expires]);
  }
  await primary.query(`INSERT INTO ${primarySchema}.telemetry_v1_chunks
    (id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,envelope_digest,
     parser_version,record_count,accepted_record_count,r2_key,device_upload_authorization_id,created_at)
    VALUES('chunk-v1',$1,$2,'quota','2026-09-21',1,1,$3,$4,'test',1,1,'objects/v1','auth-v1',$5)`,
  [participantId, deviceId, hash, "1".repeat(64), issued]);
  await primary.query(`INSERT INTO ${primarySchema}.telemetry_v11_day_manifests
    (id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
     expected_chunk_count,state,created_at,ready_at)
    VALUES($1,$2,$3,'2026-09-21',$4,'test','{}',1,'ready',$5,$5)`,
  [manifestV11, participantId, deviceId, hash, issued]);
  await primary.query(`INSERT INTO ${primarySchema}.telemetry_v11_chunks
    (id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
     envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
    VALUES('chunk-v11',$1,$2,$3,'quota','2026-09-21',1,'chunk-v11',$4,$5,'test',1,'objects/v11','auth-v11',$6)`,
  [manifestV11, participantId, deviceId, "4".repeat(64), "5".repeat(64), issued]);
  await primary.query(`INSERT INTO ${primarySchema}.telemetry_v12_day_manifests
    (id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,
     expected_chunk_count,state,created_at,ready_at)
    VALUES($1,$2,$3,'2026-09-21',$4,'test','{}',1,'ready',$5,$5)`,
  [manifestV12, participantId, deviceId, "6".repeat(64), issued]);
  await primary.query(`INSERT INTO ${primarySchema}.telemetry_v12_chunks
    (id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,
     envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at)
    VALUES('chunk-v12',$1,$2,$3,'quota','2026-09-21',1,'chunk-v12',$4,$5,'test',1,'objects/v12','auth-v12',$6)`,
  [manifestV12, participantId, deviceId, "7".repeat(64), "8".repeat(64), issued]);
  await primary.query(`INSERT INTO ${primarySchema}.pending_objects(contribution_id,object_key)
    VALUES('chunk-v1','objects/v1'),('chunk-v11','objects/v11'),('chunk-v12','objects/v12')`);
  await primary.query(`INSERT INTO ${primarySchema}.analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state)
    VALUES($1,$2,1,1,'active')`, [participantId, hash]);
  await primary.query(`INSERT INTO ${primarySchema}.analytics_prepared_source_heads
    (source_id,source_namespace,owner_digest,day,generation,input_revision,owner_revision,
     dependency_digest,method,authority_epoch,source_epoch,sequence,state,progress_revision,
     rows_written) VALUES($1,'telemetry-v1',$2,'2026-09-21','g-1',1,1,$3,'test',1,1,1,'ready',0,0)`,
  [participantId, hash, zeros]);
}

async function restorePrimaryParticipant() {
  await primary.query(`INSERT INTO ${primarySchema}.participants(id,owner_kind,state,created_at)
    VALUES($1,'social','active',$2)`, [participantId, new Date(now)]);
  await primary.query(`INSERT INTO ${primarySchema}.analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state)
    VALUES($1,$2,1,1,'active')`, [participantId, hash]);
}

beforeAll(async () => {
  const socket = process.env.PG_TEST_SOCKET;
  if (typeof socket !== "string" || !isAbsolute(socket)
      || !socket.startsWith("/private/tmp/tibotattle-pg-")) throw new Error("unsafe PG_TEST_SOCKET");
  const stat = await lstat(socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(socket) !== socket
      || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) throw new Error("unsafe PG_TEST_SOCKET");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PG") && !key.startsWith("PG_TEST_")) delete process.env[key];
  }
  admin = new Pool({ ...poolOptions("postgres", "tibotattle-erasure-admin"), max: 2 });
  await admin.query(`CREATE DATABASE "${primaryDatabaseName}"`);
  await admin.query(`CREATE DATABASE "${ledgerDatabaseName}"`);
  created = true;
  primary = new Pool(poolOptions(primaryDatabaseName, "tibotattle-erasure-primary"));
  ledger = new Pool(poolOptions(ledgerDatabaseName, "tibotattle-erasure-ledger"));
  await primary.query(`CREATE SCHEMA ${primarySchema}`);
  await ledger.query(`CREATE SCHEMA ${ledgerSchema}`);
  await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primary });
  await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledger });
});

afterAll(async () => {
  await primary?.end();
  await ledger?.end();
  if (created) await admin.query(`DROP DATABASE "${primaryDatabaseName}"`);
  if (created) await admin.query(`DROP DATABASE "${ledgerDatabaseName}"`);
  await admin?.end();
});

it("retries owner erasure, then suppresses a restored primary from the independent ledger", async () => {
  await seedParticipant();
  const stores = createPostgresParticipantErasureStores(primary, ledger, {
    schemaOptions: { primarySchema, ledgerSchema },
  });
  const storageErasure = { primaryPool: primary, ledgerPool: ledger,
    schemaOptions: { primarySchema, ledgerSchema } };
  let failed = true;
  const deleted = [];
  const objects = {
    async deleteBatch(refs) {
      if (failed) {
        failed = false;
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      deleted.push(...refs.map((ref) => ({ source: ref.source, key: ref.key, version: ref.version })));
    },
  };
  const dependencies = {
    ...stores,
    objects,
    hooks: {
      async revokeAccountlessEnrollment() {},
      async assertIdentityConfiguration() {},
      async recordIdentityCooldown() {},
      async afterLedgerTombstone() {
        await preparePostgresStorageParticipantErasure(storageErasure, participantId);
      },
      async afterPrimaryFinish() {
        await requirePostgresStorageParticipantErasureComplete(storageErasure, participantId);
      },
    },
  };
  await expect(eraseParticipantWithStore(
    dependencies, participantId, "00000000-0000-4000-8000-000000000101", now,
  )).rejects.toMatchObject({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
  expect((await ledger.query(`SELECT COUNT(*)::int AS count FROM ${ledgerSchema}.deletion_tombstones`)).rows[0].count)
    .toBe(1);
  expect((await primary.query(`SELECT state FROM ${primarySchema}.participants WHERE id=$1`, [participantId])).rows[0].state)
    .toBe("deleting");
  expect((await ledger.query(`SELECT state FROM ${ledgerSchema}.storage_erasure_jobs`)).rows[0].state)
    .toBe("pending");

  const retry = await eraseParticipantWithStore(
    dependencies, participantId, "00000000-0000-4000-8000-000000000102", now + 1_000,
  );
  expect(retry).toMatchObject({ deleted: true, contributionsDeleted: 3 });
  expect(deleted.map((row) => row.source)).toEqual(["telemetry_v1", "telemetry_v11", "telemetry_v12"]);
  expect((await primary.query(`SELECT COUNT(*)::int AS count FROM ${primarySchema}.analytics_owner_state`)).rows[0].count)
    .toBe(0);
  expect((await ledger.query(`SELECT state FROM ${ledgerSchema}.storage_erasure_jobs`)).rows[0].state)
    .toBe("complete");

  await restorePrimaryParticipant();
  const gate = createPostgresRestoreSuppressionGate(primary, ledger, {
    schemaOptions: { primarySchema, ledgerSchema },
  });
  await expect(gate.assertReady(participantId, now + 2_000)).rejects.toMatchObject({
    status: 409, code: "PARTICIPANT_DELETING",
  });
  expect(await gate.check(participantId, now + 2_000)).toBe("already_suppressed");
  expect((await primary.query(`SELECT state,deletion_session_id FROM ${primarySchema}.participants WHERE id=$1`, [participantId])).rows[0])
    .toMatchObject({ state: "deleting" });
  expect((await ledger.query(`SELECT COUNT(*)::int AS count FROM ${ledgerSchema}.restore_suppression_receipts`)).rows[0].count)
    .toBe(1);

  const unavailableGate = createPostgresRestoreSuppressionGate(primary, {
    connect: async () => { throw new Error("ledger offline"); },
  }, { schemaOptions: { primarySchema, ledgerSchema } });
  await expect(unavailableGate.check(participantId, now + 2_000)).rejects.toMatchObject({
    status: 503, code: "DELETION_LEDGER_UNAVAILABLE",
  });
});
