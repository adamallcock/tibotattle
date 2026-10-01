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
const SOURCE_ID = "canonical-v1-primary";
const IDENTITY_SECRET = "synthetic-social-erasure-identity-secret-0123456789";
const IDENTITY_VERSION = "synthetic-v1";

function q(schema, name) {
  assert.match(schema, /^[a-z_][a-z0-9_]{0,62}$/u);
  assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/u);
  return `"${schema}"."${name}"`;
}

function digest() { return randomBytes(32).toString("hex"); }

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "social erasure requires loopback or a private Unix socket");
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

async function pinIdentitySecret(pool, schema, fingerprint) {
  await pool.query(
    `INSERT INTO ${q(schema, "identity_link_secret_configuration")}
       (singleton,key_version,secret_fingerprint,recorded_at)
     VALUES (1,$1,$2,clock_timestamp())`, [IDENTITY_VERSION, fingerprint],
  );
}

/** Two paired social devices, one registered v1 chunk, and optional analytics rows. */
async function seedSocialOwner(pool, schema, supplied = {}) {
  const participantId = supplied.participantId ?? `participant:${randomUUID()}`;
  const identityLinkKey = supplied.identityLinkKey ?? digest();
  const ownerDigest = supplied.ownerDigest ?? digest();
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
  await pool.query(
    `INSERT INTO ${q(schema, "storage_v11_owner_links")} (participant_id,owner_digest,state)
     VALUES ($1,$2,'active')`, [participantId, ownerDigest],
  );
  const authorizationId = randomUUID();
  const chunkId = supplied.chunkId ?? `chunk:${randomUUID()}`;
  const objectKey = supplied.objectKey ?? `synthetic/social-erasure/${randomUUID()}`;
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
  if (supplied.analytics !== false) {
    await pool.query(
      `INSERT INTO ${q(schema, "storage_source_state")} (singleton,source_id,authority_epoch)
       VALUES (1,$1,2) ON CONFLICT (singleton) DO NOTHING`, [SOURCE_ID],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "analytics_owner_state")} (source_id,owner_digest,revision,authority_epoch,state)
       VALUES ($1,$2,1,2,'active')`, [SOURCE_ID, ownerDigest],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "analytics_owner_results")} (
         source_id,source_namespace,observed_day,metric,owner_digest,input_revision,owner_revision,
         authority_epoch,public_authority_epoch,source_epoch,sequence,method,status,payload_json,
         payload_sha256,computed_at_ms
       ) VALUES ($1,'telemetry-v1.2','2026-09-20','daily',$2,1,1,2,2,1,0,'synthetic','ready','{}',$3,0)`,
      [SOURCE_ID, ownerDigest, digest()],
    );
  }
  return { participantId, identityLinkKey, ownerDigest, devices, chunkId, objectKey };
}

async function count(pool, schema, name, where, values) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${q(schema, name)} WHERE ${where}`, values);
  return result.rows[0].count;
}

function recordingStore() {
  const calls = [];
  let failures = 0;
  return {
    calls,
    failNext() { failures += 1; },
    store: {
      async deleteBatch(refs) {
        assert.ok(refs.length <= 100);
        calls.push(refs.map((ref) => ({ source: ref.source, id: ref.id, key: ref.key, version: ref.version })));
        if (failures > 0) {
          failures -= 1;
          throw new Error("synthetic provider interruption");
        }
      },
    },
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

async function withHarness(run, { restored = false } = {}) {
  const endpoint = await localEndpoint();
  assert.ok(endpoint);
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `social_erasure_${suffix}`;
  const ledgerSchema = `${primarySchema}_ledger`;
  const restoredSchema = `${primarySchema}_restored`;
  const poolOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 6,
    connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool(poolOptions);
  const ledgerPool = new pg.Pool(poolOptions);
  const schemas = [];
  let vite;
  try {
    const version = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(version.rows[0].version / 10_000), 17, "social erasure is qualified against PostgreSQL 17");
    await createSchema(primaryPool, primarySchema);
    schemas.push(primarySchema);
    await createSchema(primaryPool, ledgerSchema, "ledger");
    schemas.push(ledgerSchema);
    if (restored) {
      await createSchema(primaryPool, restoredSchema);
      schemas.push(restoredSchema);
    }
    vite = await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
    const eraser = await vite.ssrLoadModule("/src/postgres-social-owner-erasure.ts");
    const identity = await vite.ssrLoadModule("/src/identity-link-configuration.ts");
    const fingerprint = await identity.identityLinkSecretFingerprint(IDENTITY_SECRET);
    await pinIdentitySecret(primaryPool, primarySchema, fingerprint);
    if (restored) await pinIdentitySecret(primaryPool, restoredSchema, fingerprint);
    await run({ primaryPool, ledgerPool, primarySchema, ledgerSchema, restoredSchema, fingerprint, ...eraser });
  } finally {
    if (vite) await vite.close();
    for (const schema of schemas.reverse()) {
      await primaryPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    }
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
}

test("PG17 social owner erasure resumes through provider and primary failures, retires analytics, and replays", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({
  primaryPool, ledgerPool, primarySchema, ledgerSchema, restoredSchema, erasePostgresSocialOwner,
}) => {
  const owner = await seedSocialOwner(primaryPool, primarySchema);
  const provider = recordingStore();
  const options = {
    primaryPool,
    ledgerPool,
    objectStore: provider.store,
    participantId: owner.participantId,
    identityLinkSecret: IDENTITY_SECRET,
    identityLinkSecretVersion: IDENTITY_VERSION,
    schema: { primarySchema, ledgerSchema },
  };
  const receipt = async () => (await ledgerPool.query(
    `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
  )).rows;

  provider.failNext();
  assert.deepEqual(await erasePostgresSocialOwner(options),
    { status: "incomplete", code: "SOCIAL_OWNER_ERASURE_OBJECT_STORE_FAILED" });
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0], [{ source: "telemetry_v1", id: owner.chunkId, key: owner.objectKey, version: null }]);
  assert.equal(await count(primaryPool, primarySchema, "participants", "id=$1 AND state='deleting'", [owner.participantId]), 1,
    "the fence persists so a retry resumes the same deletion");
  assert.equal(await count(primaryPool, primarySchema, "web_sessions", "participant_id=$1 AND state='active'", [owner.participantId]), 0);
  assert.equal(await count(primaryPool, primarySchema, "device_credentials", "participant_id=$1 AND state='active'", [owner.participantId]), 0);
  assert.equal(await count(ledgerPool, ledgerSchema, "deletion_tombstones", "true", []), 1);
  assert.equal(await count(ledgerPool, ledgerSchema, "identity_reenrollment_cooldowns", "true", []), 1);
  const providerReceipt = await receipt();
  assert.equal(providerReceipt[0].outcome, "failed");
  assert.equal(JSON.parse(providerReceipt[0].details_json).phase, "object_delete_retry");

  const interrupted = await erasePostgresSocialOwner({
    ...options, primaryPool: failParticipantDeleteOnce(primaryPool, primarySchema),
  });
  assert.deepEqual(interrupted, { status: "incomplete", code: "SOCIAL_OWNER_ERASURE_READBACK_FAILED" });
  assert.equal(provider.calls.length, 2, "provider deletion is replayed idempotently before the primary retry");
  assert.equal(await count(primaryPool, primarySchema, "participants", "id=$1", [owner.participantId]), 1);
  assert.equal(await count(primaryPool, primarySchema, "pending_objects", "contribution_id=$1", [owner.chunkId]), 1,
    "the rolled-back primary transaction keeps the exact object registration");
  const interruptedReceipt = await receipt();
  assert.equal(interruptedReceipt[0].outcome, "failed");
  assert.equal(JSON.parse(interruptedReceipt[0].details_json).phase, "objects_deleted");

  const completed = await erasePostgresSocialOwner(options);
  assert.deepEqual(completed, { status: "complete", objectsDeleted: 1 });
  assert.equal(provider.calls.length, 3);
  for (const name of ["participants", "web_sessions", "device_pairings", "device_credentials",
    "device_upload_authorizations", "telemetry_v1_chunks", "storage_v11_owner_links"]) {
    const where = name === "participants" ? "id=$1" : "participant_id=$1";
    assert.equal(await count(primaryPool, primarySchema, name, where, [owner.participantId]), 0, `${name} is erased`);
  }
  assert.equal(await count(primaryPool, primarySchema, "pending_objects", "contribution_id=$1", [owner.chunkId]), 0);
  assert.equal(await count(primaryPool, primarySchema, "storage_owner_erasure_receipts", "owner_digest=$1", [owner.ownerDigest]), 1);
  assert.equal(await count(primaryPool, primarySchema, "identity_reenrollment_cooldowns", "participant_id IS NULL", []), 1,
    "the primary cooldown digest survives without a participant reference");
  assert.equal(await count(primaryPool, primarySchema, "analytics_owner_results", "owner_digest=$1", [owner.ownerDigest]), 0,
    "derived analytics for the erased owner are retired");
  assert.equal(await count(primaryPool, primarySchema, "analytics_owner_state",
    "owner_digest=$1 AND state='erased'", [owner.ownerDigest]), 1);
  const durable = await receipt();
  assert.equal(durable.length, 1);
  assert.equal(durable[0].outcome, "completed");
  const durableDetails = JSON.parse(durable[0].details_json);
  assert.deepEqual(Object.keys(durableDetails).sort(),
    ["identityCooldownRecorded", "objectCount", "ownerDigest", "phase", "schemaVersion"]);
  assert.equal(durableDetails.phase, "completed");
  assert.equal(durableDetails.identityCooldownRecorded, true);
  for (const secretish of [owner.participantId, owner.objectKey, owner.chunkId, owner.identityLinkKey]) {
    assert.equal(durable[0].details_json.includes(secretish), false, "the ledger receipt holds no raw identifiers");
  }

  assert.deepEqual(await erasePostgresSocialOwner(options), { status: "already_complete", objectsDeleted: 1 });
  assert.equal(provider.calls.length, 3, "an already-complete retry performs no provider operations");

  // A primary restored from a pre-erasure backup must be erased again under the
  // independent ledger, without downgrading its completed receipt.
  await seedSocialOwner(primaryPool, restoredSchema, owner);
  const restoredResult = await erasePostgresSocialOwner({ ...options, schema: { primarySchema: restoredSchema, ledgerSchema } });
  assert.deepEqual(restoredResult, { status: "complete", objectsDeleted: 1 });
  assert.equal(await count(primaryPool, restoredSchema, "participants", "id=$1", [owner.participantId]), 0);
  assert.equal(await count(primaryPool, restoredSchema, "analytics_owner_results", "owner_digest=$1", [owner.ownerDigest]), 0);
  assert.equal((await receipt())[0].outcome, "completed", "restore replay keeps the terminal ledger receipt");
}, { restored: true }));

test("PG17 social owner erasure keeps the participant erased when analytics retirement must be resumed", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ primaryPool, ledgerPool, primarySchema, ledgerSchema, erasePostgresSocialOwner }) => {
  const owner = await seedSocialOwner(primaryPool, primarySchema);
  const provider = recordingStore();
  const options = {
    primaryPool, ledgerPool, objectStore: provider.store, participantId: owner.participantId,
    identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: IDENTITY_VERSION,
    schema: { primarySchema, ledgerSchema },
  };
  // An unreviewed owner-bearing relation makes analytics retirement refuse.
  const unreviewed = `future_owner_family_${randomBytes(3).toString("hex")}`;
  await primaryPool.query(`CREATE TABLE ${q(primarySchema, unreviewed)} (owner_digest text NOT NULL)`);

  assert.deepEqual(await erasePostgresSocialOwner(options),
    { status: "incomplete", code: "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED" });
  assert.equal(await count(primaryPool, primarySchema, "participants", "id=$1", [owner.participantId]), 0,
    "the primary erasure commits before derived analytics retirement");
  assert.equal(await count(primaryPool, primarySchema, "analytics_owner_results", "owner_digest=$1", [owner.ownerDigest]), 1);
  const pending = (await ledgerPool.query(
    `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
  )).rows[0];
  assert.equal(pending.outcome, "failed");
  assert.equal(JSON.parse(pending.details_json).phase, "primary_deleted");

  await primaryPool.query(`DROP TABLE ${q(primarySchema, unreviewed)}`);
  assert.deepEqual(await erasePostgresSocialOwner(options), { status: "already_complete", objectsDeleted: 1 });
  assert.equal(provider.calls.length, 1, "resuming analytics retirement repeats no provider deletion");
  assert.equal(await count(primaryPool, primarySchema, "analytics_owner_results", "owner_digest=$1", [owner.ownerDigest]), 0);
  const done = (await ledgerPool.query(
    `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
  )).rows[0];
  assert.equal(done.outcome, "completed");
}));

test("PG17 social owner erasure completes a retirement refused while re-erasing a restored primary", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({
  primaryPool, ledgerPool, primarySchema, ledgerSchema, restoredSchema, erasePostgresSocialOwner,
}) => {
  const owner = await seedSocialOwner(primaryPool, primarySchema);
  const provider = recordingStore();
  const options = {
    primaryPool, ledgerPool, objectStore: provider.store, participantId: owner.participantId,
    identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: IDENTITY_VERSION,
    schema: { primarySchema, ledgerSchema },
  };
  const restored = { ...options, schema: { primarySchema: restoredSchema, ledgerSchema } };
  assert.deepEqual(await erasePostgresSocialOwner(options), { status: "complete", objectsDeleted: 1 });

  // A pre-erasure backup restores the participant and its derived analytics.
  await seedSocialOwner(primaryPool, restoredSchema, owner);
  const unreviewed = `future_owner_family_${randomBytes(3).toString("hex")}`;
  await primaryPool.query(`CREATE TABLE ${q(restoredSchema, unreviewed)} (owner_digest text NOT NULL)`);
  assert.deepEqual(await erasePostgresSocialOwner(restored),
    { status: "incomplete", code: "SOCIAL_OWNER_ERASURE_ANALYTICS_RETIREMENT_FAILED" });
  assert.equal(await count(primaryPool, restoredSchema, "participants", "id=$1", [owner.participantId]), 0);
  assert.equal(await count(primaryPool, restoredSchema, "analytics_owner_results", "owner_digest=$1", [owner.ownerDigest]), 1);
  const receipt = async () => (await ledgerPool.query(
    `SELECT outcome FROM ${q(ledgerSchema, "participant_erasure_receipts")}`)).rows[0].outcome;
  assert.equal(await receipt(), "completed", "the terminal receipt is never downgraded");

  await primaryPool.query(`DROP TABLE ${q(restoredSchema, unreviewed)}`);
  assert.deepEqual(await erasePostgresSocialOwner(restored), { status: "already_complete", objectsDeleted: 1 });
  assert.equal(await count(primaryPool, restoredSchema, "analytics_owner_results", "owner_digest=$1", [owner.ownerDigest]), 0,
    "the retry retires analytics the terminal receipt could not track");
  assert.equal(await count(primaryPool, restoredSchema, "analytics_owner_state",
    "owner_digest=$1 AND state='erased'", [owner.ownerDigest]), 1);

  // With no residue, a replay performs no retirement and leaves shared caches alone.
  await primaryPool.query(`INSERT INTO ${q(restoredSchema, "preview_cache")} (id,payload) VALUES ('replay-cache','{}'::jsonb)`);
  assert.deepEqual(await erasePostgresSocialOwner(restored), { status: "already_complete", objectsDeleted: 1 });
  assert.equal(await count(primaryPool, restoredSchema, "preview_cache", "id='replay-cache'", []), 1);
  assert.equal(await receipt(), "completed");
}, { restored: true }));

test("PG17 social owner erasure refuses to orphan an object registered after provider deletion", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ primaryPool, ledgerPool, primarySchema, ledgerSchema, erasePostgresSocialOwner }) => {
  const owner = await seedSocialOwner(primaryPool, primarySchema, { analytics: false });
  const lateContributionId = `synthetic-history-${randomUUID()}`;
  const lateObjectKey = `telemetry/erasure/late-legacy/${randomUUID()}`;
  let raced = false;
  const deleted = [];
  const objectStore = {
    async deleteBatch(refs) {
      deleted.push(...refs.map((ref) => ref.key));
      if (raced) return;
      raced = true;
      // Every schema writer already rejects rows for a deleting participant.
      // Replica mode simulates a writer outside those guards; the late legacy
      // row sorts before the listed v1 object, so provider paging cannot see
      // it and only the eraser's locked primary inventory check can.
      const client = await primaryPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${primarySchema}", pg_catalog`);
        await client.query("SET LOCAL session_replication_role = replica");
        const now = new Date("2026-09-25T12:30:00.000Z");
        await client.query(
          `INSERT INTO ${q(primarySchema, "telemetry_contributions")} (
             id,participant_id,plaintext_digest,envelope_digest,r2_key,status,schema_version,
             transport_schema_version,range_start,range_end,client_platform,provider_policy_epoch,
             priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,
             price_basis,declared_record_count,created_at
           ) VALUES ($1,$2,$3,$4,$5,'accepted','telemetry-contribution-v0.1',
             'telemetry-contribution-v0.2',$6,$6,'synthetic','synthetic-policy',0,0,0,'synthetic',0,$6)`,
          [lateContributionId, owner.participantId, digest(), digest(), lateObjectKey, now],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const options = {
    primaryPool, ledgerPool, objectStore, participantId: owner.participantId,
    identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: IDENTITY_VERSION,
    schema: { primarySchema, ledgerSchema },
  };

  assert.deepEqual(await erasePostgresSocialOwner(options),
    { status: "incomplete", code: "SOCIAL_OWNER_ERASURE_REFERENCE_MISMATCH" });
  assert.deepEqual(deleted, [owner.objectKey]);
  assert.equal(await count(primaryPool, primarySchema, "telemetry_contributions", "id=$1", [lateContributionId]), 1,
    "the late object's source row survives until its stored object is deleted");
  assert.equal(await count(primaryPool, primarySchema, "participants", "id=$1", [owner.participantId]), 1);
  const pending = (await ledgerPool.query(
    `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
  )).rows[0];
  assert.equal(pending.outcome, "failed");
  assert.equal(JSON.parse(pending.details_json).phase, "objects_deleted");

  assert.deepEqual(await erasePostgresSocialOwner(options), { status: "complete", objectsDeleted: 2 });
  assert.deepEqual([...deleted.slice(1)].sort(), [lateObjectKey, owner.objectKey].sort(),
    "the retry deletes both stored objects before removing their rows");
  assert.equal(await count(primaryPool, primarySchema, "telemetry_contributions", "participant_id=$1", [owner.participantId]), 0);
  assert.equal(await count(primaryPool, primarySchema, "telemetry_v1_chunks", "participant_id=$1", [owner.participantId]), 0);
}));

test("PG17 social owner erasure requires the pinned identity secret and erases a participant with no owner link", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({
  primaryPool, ledgerPool, primarySchema, ledgerSchema, erasePostgresSocialOwner, PostgresSocialOwnerErasureError,
}) => {
  // Sign-in only: no device, upload, owner link, or analytics state.
  const participantId = `participant:${randomUUID()}`;
  const now = new Date("2026-09-25T12:00:00.000Z");
  await primaryPool.query(
    `INSERT INTO ${q(primarySchema, "participants")} (
       id,owner_kind,state,consent_version,consented_at,created_at,identity_link_key
     ) VALUES ($1,'social','active','ongoing-privacy-safe-telemetry-v0.1',$2,$2,$3)`,
    [participantId, now, digest()],
  );
  await primaryPool.query(
    `INSERT INTO ${q(primarySchema, "web_sessions")} (
       id,participant_id,secret_hash,csrf_hash,scope,state,issued_at,expires_at,last_used_at
     ) VALUES ($1,$2,$3,$4,'personal','active',$5,$6,$5)`,
    [randomUUID(), participantId, randomBytes(32), randomBytes(32), now, new Date("2026-10-25T12:00:00.000Z")],
  );
  const provider = recordingStore();
  const options = {
    primaryPool, ledgerPool, objectStore: provider.store, participantId,
    schema: { primarySchema, ledgerSchema },
  };
  const refused = async (overrides) => assert.rejects(erasePostgresSocialOwner({ ...options, ...overrides }),
    (error) => error instanceof PostgresSocialOwnerErasureError
      && error.code === "SOCIAL_OWNER_ERASURE_IDENTITY_CONFIGURATION_INVALID");
  await refused({});
  await refused({ identityLinkSecret: IDENTITY_SECRET });
  await refused({ identityLinkSecret: `${IDENTITY_SECRET}-rotated`, identityLinkSecretVersion: IDENTITY_VERSION });
  await refused({ identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: "synthetic-v2" });
  assert.equal(await count(primaryPool, primarySchema, "participants",
    "id=$1 AND state='active' AND deletion_session_id IS NULL", [participantId]), 1,
    "an unverifiable cooldown secret refuses before the fence");
  assert.equal(await count(ledgerPool, ledgerSchema, "participant_erasure_receipts", "true", []), 0);

  const result = await erasePostgresSocialOwner({
    ...options, identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: IDENTITY_VERSION,
  });
  assert.deepEqual(result, { status: "complete", objectsDeleted: 0 });
  assert.equal(provider.calls.length, 0);
  assert.equal(await count(primaryPool, primarySchema, "participants", "id=$1", [participantId]), 0);
  assert.equal(await count(primaryPool, primarySchema, "web_sessions", "participant_id=$1", [participantId]), 0);
  assert.equal(await count(primaryPool, primarySchema, "identity_reenrollment_cooldowns", "participant_id IS NULL", []), 1);
  assert.equal(await count(ledgerPool, ledgerSchema, "identity_reenrollment_cooldowns", "true", []), 1);
  const durable = (await ledgerPool.query(
    `SELECT outcome,details_json FROM ${q(ledgerSchema, "participant_erasure_receipts")}`,
  )).rows[0];
  assert.equal(durable.outcome, "completed");
  assert.equal(JSON.parse(durable.details_json).ownerDigest, null);
  assert.deepEqual(await erasePostgresSocialOwner({
    ...options, identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: IDENTITY_VERSION,
  }), { status: "already_complete", objectsDeleted: 0 });

  const grantOwner = await seedSocialOwner(primaryPool, primarySchema, { analytics: false });
  const grantId = randomUUID();
  await primaryPool.query(
    `INSERT INTO ${q(primarySchema, "enrollment_grants")} (
       id,secret_hash,state,issued_at,expires_at,redeemed_at,redeemed_participant_id
     ) VALUES ($1,$2,'redeemed',$3,$4,$3,$5)`,
    [grantId, randomBytes(32), now, new Date("2026-10-25T12:00:00.000Z"), grantOwner.participantId],
  );
  await assert.rejects(erasePostgresSocialOwner({
    ...options, participantId: grantOwner.participantId,
    identityLinkSecret: IDENTITY_SECRET, identityLinkSecretVersion: IDENTITY_VERSION,
  }), (error) => error instanceof PostgresSocialOwnerErasureError
    && error.code === "SOCIAL_OWNER_ERASURE_GRANT_POLICY_REQUIRED");
  assert.equal(await count(primaryPool, primarySchema, "participants",
    "id=$1 AND state='active'", [grantOwner.participantId]), 1, "a preflight refusal makes no mutation");
}));

test("PG17 participant deletion cascades every participant family except reviewed exceptions", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => withHarness(async ({ primaryPool, primarySchema }) => {
  // The social eraser proves completeness by deleting the participant row; a
  // non-cascading participant edge would silently retain personal rows.
  const edges = await primaryPool.query(
    `SELECT child.relname::text AS table_name, constraint_row.confdeltype::text AS rule
       FROM pg_constraint constraint_row
       JOIN pg_class child ON child.oid=constraint_row.conrelid
       JOIN pg_class parent ON parent.oid=constraint_row.confrelid
       JOIN pg_namespace namespace ON namespace.oid=parent.relnamespace
      WHERE constraint_row.contype='f' AND parent.relname='participants' AND namespace.nspname=$1
      ORDER BY table_name`, [primarySchema],
  );
  const exceptions = {
    enrollment_grants: "n",
    identity_reenrollment_cooldowns: "n",
    typed_telemetry_owner_memberships: "r",
  };
  for (const { table_name: name, rule } of edges.rows) {
    assert.equal(rule, exceptions[name] ?? "c", `${name} participant edge`);
  }
  const unlinked = await primaryPool.query(
    `SELECT columns.table_name::text AS table_name
       FROM information_schema.columns columns
       JOIN pg_class relation ON relation.relname=columns.table_name
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace AND namespace.nspname=columns.table_schema
      WHERE columns.table_schema=$1 AND columns.column_name='participant_id' AND relation.relkind='r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint constraint_row
           JOIN pg_class parent ON parent.oid=constraint_row.confrelid AND parent.relname='participants'
          WHERE constraint_row.conrelid=relation.oid AND constraint_row.contype='f'
        )
      ORDER BY table_name`, [primarySchema],
  );
  assert.deepEqual(unlinked.rows.map((row) => row.table_name),
    ["storage_v11_append_transitions", "telemetry_contribution_occurrences"],
    "the only participant columns without a direct edge cascade through their parents");
  // Primary 0060's storage_v11_append_transitions cascades through its v1.1
  // generation, which cascades from the participant.
  const generationEdges = await primaryPool.query(
    `SELECT child.relname::text AS child, parent.relname::text AS parent, constraint_row.confdeltype::text AS rule
       FROM pg_constraint constraint_row
       JOIN pg_class child ON child.oid=constraint_row.conrelid
       JOIN pg_class parent ON parent.oid=constraint_row.confrelid
       JOIN pg_namespace namespace ON namespace.oid=child.relnamespace
      WHERE constraint_row.contype='f' AND namespace.nspname=$1
        AND ((child.relname='storage_v11_append_transitions' AND parent.relname='telemetry_v11_domains')
          OR (child.relname='telemetry_v11_domains' AND parent.relname='participants'))
      ORDER BY child`, [primarySchema],
  );
  assert.deepEqual(generationEdges.rows, [
    { child: "storage_v11_append_transitions", parent: "telemetry_v11_domains", rule: "c" },
    { child: "telemetry_v11_domains", parent: "participants", rule: "c" },
  ]);
}));
