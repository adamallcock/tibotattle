import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const PG_TEST_MIGRATIONS_ROOT = process.env.PG_TEST_MIGRATIONS_ROOT;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

function digest() { return randomBytes(32).toString("hex"); }

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "social erasure preflight requires loopback or a private Unix socket");
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

async function createSchema(pool, schema, role = "primary") {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const migrationOptions = PG_TEST_MIGRATIONS_ROOT === undefined
    ? {} : { rootDirectory: PG_TEST_MIGRATIONS_ROOT };
  const expected = await readPostgresMigrations({ role, ...migrationOptions });
  const applied = await applyPostgresMigrations({ role, schema, pool, ...migrationOptions });
  assert.equal(applied.applied, expected.length);
}

async function seedSocialOwner(pool, schema, options = {}) {
  const participantId = options.participantId ?? `participant:${randomUUID()}`;
  const identityLinkKey = options.identityLinkKey === undefined ? digest() : options.identityLinkKey;
  const now = new Date("2026-09-25T12:00:00.000Z");
  const later = new Date("2026-10-25T12:00:00.000Z");
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (
       id,owner_kind,state,consent_version,consented_at,created_at,identity_link_key
     ) VALUES ($1,'social','active','ongoing-privacy-safe-telemetry-v0.1',$2,$2,$3)`,
    [participantId, now, identityLinkKey],
  );
  const devices = [];
  for (let index = 0; index < 2; index += 1) {
    const sessionId = randomUUID();
    const pairingId = randomUUID();
    const deviceId = randomUUID();
    await pool.query(
      `INSERT INTO ${q(schema, "web_sessions")} (
         id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at
       ) VALUES ($1,$2,$3,$4,'personal','active',$5,$6,$5)`,
      [sessionId, participantId, randomBytes(32), randomBytes(32), now, later],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "device_pairings")} (
         id,participant_id,issued_by_session_id,secret_hash,consent_version,
         transport_consent_version,state,issued_at,expires_at,consumed_at,claimed_device_id
       ) VALUES ($1,$2,$3,$4,'ongoing-privacy-safe-telemetry-v0.1',
         'ongoing-privacy-safe-telemetry-v0.1','consumed',$5,$6,$5,$7)`,
      [pairingId, participantId, sessionId, randomBytes(32), now, later, deviceId],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "device_credentials")} (
         id,participant_id,authority_kind,paired_via_pairing_id,secret_hash,state,
         issued_at,expires_at,last_used_at,social_verified_at
       ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
      [deviceId, participantId, pairingId, randomBytes(32), now, later],
    );
    devices.push({ deviceId, pairingId });
  }
  const ownerDigest = digest();
  await pool.query(
    `INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
     VALUES ($1,$2,'active')`, [participantId, ownerDigest],
  );
  const authorizationId = randomUUID();
  const chunkId = `chunk:${randomUUID()}`;
  const objectKey = `synthetic/social-erasure/${randomUUID()}`;
  await pool.query(
    `INSERT INTO ${q(schema, "device_upload_authorizations")} (
       id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
       content_type,state,issued_at,expires_at,consumed_at,consumed_contribution_id
     ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consumed',$6,$7,$6,$8)`,
    [authorizationId, participantId, devices[0].deviceId, randomBytes(32), digest(), now, later, chunkId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "pending_objects")} (contribution_id,object_key,object_kind)
     VALUES ($1,$2,'telemetry_v1')`, [chunkId, objectKey],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v1_chunks")} (
       id,participant_id,device_id,stream,chunk_day,chunk_seq,revision,chunk_digest,
       envelope_digest,parser_version,record_count,accepted_record_count,r2_key,
       device_upload_authorization_id,created_at
     ) VALUES ($1,$2,$3,'usage',DATE '2026-09-25',0,1,$4,$5,'synthetic-v1',1,1,$6,$7,$8)`,
    [chunkId, participantId, devices[0].deviceId, digest(), digest(), objectKey, authorizationId, now],
  );
  return { participantId, identityLinkKey, ownerDigest, devices, chunkId, objectKey, now, later };
}

test("PG17 social owner preflight inventories paired devices and source refs, then refuses unsafe boundaries read-only", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `social_erasure_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const poolOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool(poolOptions);
  const schemas = [];
  let vite;
  try {
    const version = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "preflight qualification requires PostgreSQL 17");
    assert.equal(version.rows[0].address, null, "preflight qualification requires the private local Unix socket");
    await createSchema(primaryPool, primarySchema);
    schemas.push(primarySchema);
    await createSchema(primaryPool, ledgerSchema, "ledger");
    schemas.push(ledgerSchema);
    vite = await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
    const module = await vite.ssrLoadModule("/src/postgres-social-owner-erasure-preflight.ts");
    const inspect = (participantId) => module.inspectPostgresSocialOwnerErasureTarget({
      primaryPool, participantId, schema: { primarySchema, ledgerSchema },
    });

    const owner = await seedSocialOwner(primaryPool, primarySchema);
    const inventory = await inspect(owner.participantId);
    assert.equal(inventory.status, "inspectable");
    assert.equal(inventory.erasureAuthorized, false,
      "preflight inventory is not authorization or proof of erasure");
    assert.equal(inventory.identityCooldownRequired, true);
    assert.equal(inventory.ownerDigest, owner.ownerDigest);
    assert.ok(inventory.participantFamilyTables >= 40);
    assert.equal(inventory.webSessions, 2);
    assert.equal(inventory.pairings, 2);
    assert.equal(inventory.deviceCredentials, 2);
    assert.equal(inventory.communityGrants, 0);
    assert.deepEqual(inventory.objectCounts,
      { telemetry: 0, telemetry_v1: 1, telemetry_v11: 0, telemetry_v12: 0 });
    await primaryPool.query(`DELETE FROM ${q(primarySchema, "pending_objects")} WHERE contribution_id=$1`,
      [owner.chunkId]);
    const reconciledInventory = await inspect(owner.participantId);
    assert.equal(reconciledInventory.objectCounts.telemetry_v1, 1,
      "a reconciled source row still inventories its durable object key after the temporary marker clears");
    const typedOwner = await seedSocialOwner(primaryPool, primarySchema, { identityLinkKey: null });
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "pending_objects")} (contribution_id,object_key,object_kind)
       VALUES ($1,$2,'telemetry_v1')`, [owner.chunkId, owner.objectKey],
    );
    const unchanged = await primaryPool.query(
      `SELECT state,deletion_session_id FROM ${q(primarySchema, "participants")} WHERE id=$1`,
      [owner.participantId],
    );
    assert.deepEqual(unchanged.rows[0], { state: "active", deletion_session_id: null },
      "preflight does not create a delete fence");

    await primaryPool.query(
      `UPDATE ${q(primarySchema, "device_pairings")} SET claimed_device_id=$2 WHERE id=$1`,
      [owner.devices[0].pairingId, owner.devices[1].deviceId],
    );
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_AUTHORITY_MISMATCH");
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "device_pairings")} SET claimed_device_id=$2 WHERE id=$1`,
      [owner.devices[0].pairingId, owner.devices[0].deviceId],
    );

    await primaryPool.query(
      `UPDATE ${q(primarySchema, "pending_objects")} SET object_kind='telemetry_v11' WHERE contribution_id=$1`,
      [owner.chunkId],
    );
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH");
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "pending_objects")} SET object_kind='telemetry_v1' WHERE contribution_id=$1`,
      [owner.chunkId],
    );

    const accountlessId = `participant:${randomUUID()}`;
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "participants")} (id,owner_kind,state,created_at)
       VALUES ($1,'accountless','active',clock_timestamp())`, [accountlessId],
    );
    await assert.rejects(inspect(accountlessId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_STATE_UNEXPECTED");

    const unknownTable = `social_extra_${suffix}`;
    await primaryPool.query(
      `CREATE TABLE ${q(primarySchema, unknownTable)} (
         participant_id text NOT NULL REFERENCES ${q(primarySchema, "participants")}(id) ON DELETE CASCADE
       )`,
    );
    await primaryPool.query(`INSERT INTO ${q(primarySchema, unknownTable)} VALUES ($1)`, [owner.participantId]);
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED");
    await primaryPool.query(`DROP TABLE ${q(primarySchema, unknownTable)}`);

    const webSession = await primaryPool.query(
      `SELECT id FROM ${q(primarySchema, "web_sessions")} WHERE participant_id=$1 ORDER BY id LIMIT 1`,
      [owner.participantId],
    );
    assert.equal(webSession.rows.length, 1);
    const webUploadId = randomUUID();
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "upload_authorizations")} (
         id,participant_id,issued_by_session_id,secret_hash,envelope_digest,body_bytes,
         content_type,state,issued_at,expires_at,consume_lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consuming',$6,$7,$7)`,
      [webUploadId, owner.participantId, webSession.rows[0].id,
        randomBytes(32), digest(), owner.now, owner.later],
    );
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_UPLOAD_IN_PROGRESS");
    await primaryPool.query(`DELETE FROM ${q(primarySchema, "upload_authorizations")} WHERE id=$1`,
      [webUploadId]);

    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "typed_telemetry_namespaces")} (id,original_id)
       VALUES (1,decode('0102','hex'))`,
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "typed_telemetry_owners")} (id,namespace_id,original_id)
       VALUES (1,1,decode('0304','hex'))`,
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "typed_telemetry_owner_memberships")} (
       namespace_id,source_format,owner_id,participant_id,source_namespace
       ) VALUES (1,10,1,$1,'typed-social-test')`, [typedOwner.participantId],
    );
    await assert.rejects(inspect(typedOwner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_FAMILY_UNSUPPORTED");

    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_upload_authorizations")} (
         id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,
         content_type,state,issued_at,expires_at,consume_lease_expires_at
       ) VALUES ($1,$2,$3,$4,$5,1,'application/json','consuming',$6,$7,$7)`,
      [randomUUID(), owner.participantId, owner.devices[1].deviceId, randomBytes(32), digest(), owner.now, owner.later],
    );
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_UPLOAD_IN_PROGRESS");
    await primaryPool.query(`DELETE FROM ${q(primarySchema, "device_upload_authorizations")} WHERE state='consuming' AND participant_id=$1`,
      [owner.participantId]);

    const orphanId = `chunk:${randomUUID()}`;
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "pending_objects")} (contribution_id,object_key,object_kind)
       VALUES ($1,$2,'telemetry_v1')`, [orphanId, `synthetic/orphan/${randomUUID()}`],
    );
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_PENDING_UNATTRIBUTED");
    await primaryPool.query(`DELETE FROM ${q(primarySchema, "pending_objects")} WHERE contribution_id=$1`, [orphanId]);

    const grantId = randomUUID();
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "enrollment_grants")} (
         id,secret_hash,state,issued_at,expires_at,redeemed_at,redeemed_participant_id
       ) VALUES ($1,$2,'redeemed',$3,$4,$3,$5)`,
      [grantId, randomBytes(32), owner.now, owner.later, owner.participantId],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "participant_community_eligibility")} (id,participant_id,grant_id,created_at)
       VALUES ($1,$2,$3,$4)`, [randomUUID(), owner.participantId, grantId, owner.now],
    );
    await assert.rejects(inspect(owner.participantId), (error) =>
      error.code === "SOCIAL_OWNER_ERASURE_GRANT_POLICY_REQUIRED");

    const after = await primaryPool.query(
      `SELECT state,deletion_session_id FROM ${q(primarySchema, "participants")} WHERE id=$1`,
      [owner.participantId],
    );
    assert.deepEqual(after.rows[0], { state: "active", deletion_session_id: null },
      "all refused preflight cases leave primary rows unchanged");
    const authorityReadback = await primaryPool.query(
      `SELECT (SELECT count(*)::int FROM ${q(primarySchema, "web_sessions")}
                WHERE participant_id=$1 AND state='active') AS active_sessions,
              (SELECT count(*)::int FROM ${q(primarySchema, "device_pairings")}
                WHERE participant_id=$1 AND state='consumed') AS consumed_pairings,
              (SELECT count(*)::int FROM ${q(primarySchema, "device_credentials")}
                WHERE participant_id=$1 AND state='active') AS active_credentials,
              (SELECT count(*)::int FROM ${q(primarySchema, "pending_objects")}
                WHERE contribution_id=$2 AND object_kind='telemetry_v1') AS retained_object_markers`,
      [owner.participantId, owner.chunkId],
    );
    assert.deepEqual(authorityReadback.rows[0], {
      active_sessions: 2, consumed_pairings: 2, active_credentials: 2, retained_object_markers: 1,
    }, "preflight and each refusal leave source authority and object markers intact");
  } finally {
    await vite?.close();
    for (const schema of schemas.reverse()) {
      await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await primaryPool.end();
  }
});
