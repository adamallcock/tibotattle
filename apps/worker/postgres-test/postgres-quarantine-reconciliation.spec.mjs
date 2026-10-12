import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
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
const SAFETY_WINDOW = 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-09-24T20:00:00.000Z");

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "PostgreSQL quarantine tests require a loopback host or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT, socket: true };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
  return null;
}

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function makeSyntheticObjectStore() {
  const objects = new Map();
  const calls = { head: [], delete: [] };
  let deleteFailure = null;
  return {
    objects,
    calls,
    failNextDeleteAfterRemoving() { deleteFailure = new Error("synthetic lost delete acknowledgement"); },
    async head(key) {
      calls.head.push(key);
      return objects.has(key) ? { version: "synthetic-generation-1", size: objects.get(key).byteLength } : null;
    },
    async delete(key) {
      calls.delete.push(key);
      objects.delete(key);
      if (deleteFailure) {
        const error = deleteFailure;
        deleteFailure = null;
        throw error;
      }
    },
  };
}

async function insertPending(pool, schema, contributionId, objectKey, registeredAt, state = "registered", leaseId = null) {
  await pool.query(
    `INSERT INTO ${q(schema, "pending_objects")} (
       contribution_id, object_key, object_kind, registered_at,
       reconciliation_state, reconciliation_lease_id
     ) VALUES ($1,$2,'telemetry_v12',$3,$4,$5)`,
    [contributionId, objectKey, new Date(registeredAt).toISOString(), state, leaseId],
  );
}

async function seedV12Authorities(pool, schema, nowEpoch) {
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 7 * 24 * 60 * 60_000).toISOString();
  const participantId = `synthetic-reconcile-participant-${randomBytes(5).toString("hex")}`;
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const deviceId = randomUUID();
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, created_at)
     VALUES ($1,'social','active',$2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, expires],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at,
       consumed_at, claimed_device_id
     ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1',
              'consumed',$5,$6,$5,$7)`,
    [pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5)`,
    [deviceId, participantId, pairingId, randomBytes(32), now, expires],
  );
  return { participantId, deviceId, now, expires };
}

async function insertV12Chunk(pool, schema, authorities, { contributionId, objectKey, nowEpoch }) {
  const manifestId = randomUUID();
  const authorizationId = `synthetic-upload-${randomUUID()}`;
  const digest = "a".repeat(64);
  const day = "2026-09-24";
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v12_day_manifests")} (
       id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
       manifest_json, expected_chunk_count, state, created_at
     ) VALUES ($1,$2,$3,$4,$5,'synthetic-v12','{}',1,'staged',$6)`,
    [manifestId, authorities.participantId, authorities.deviceId, day, digest,
      new Date(nowEpoch).toISOString()],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at
     ) VALUES ($1,$2,$3,$4,$5,1,'application/json','unused',$6,$7)`,
    [authorizationId, authorities.participantId, authorities.deviceId, randomBytes(32),
      digest, authorities.now, authorities.expires],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v12_chunks")} (
       id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
       chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
       r2_key, device_upload_authorization_id, created_at
     ) VALUES ($1,$2,$3,$4,'usage',$5,0,$6,$7,$8,'synthetic-v12',1,$9,$10,$11)`,
    [contributionId, manifestId, authorities.participantId, authorities.deviceId, day,
      `usage:${day}:${randomUUID()}`, digest, "b".repeat(64), objectKey, authorizationId,
      new Date(nowEpoch).toISOString()],
  );
}

function racePool(pool, schema) {
  let scans = 0;
  let openBarrier;
  const barrier = new Promise((resolveBarrier) => { openBarrier = resolveBarrier; });
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text.includes(`FROM "${schema}"."pending_objects" pending`)) {
            scans += 1;
            if (scans === 2) openBarrier();
            if (scans <= 2) await barrier;
          }
          return result;
        },
        release(discard) { return client.release(discard); },
      };
    },
  };
}

test("PostgreSQL pending-object reconciliation fences late uploads and retries idempotently", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 60_000,
}, async () => {
  const endpoint = await localEndpoint();
  const schema = `quarantine_reconcile_${randomBytes(6).toString("hex")}`;
  let pool;
  let vite;
  let schemaCreated = false;
  try {
    pool = new pg.Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: PG_TEST_USER,
      ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
      database: PG_TEST_DATABASE,
      ssl: false,
      max: 6,
      connectionTimeoutMillis: 3_000,
    });
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "this qualification test requires PostgreSQL 17");
    if (endpoint.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));

    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const module = await vite.ssrLoadModule("/src/postgres-quarantine-reconciliation.ts");
    const options = {
      schema: { primarySchema: schema },
      nowEpoch: FIXED_NOW,
      safetyWindowMilliseconds: SAFETY_WINDOW,
      maximumRegistrations: 10,
    };
    const store = makeSyntheticObjectStore();
    const authorities = await seedV12Authorities(pool, schema, FIXED_NOW);

    // A committed v1.2 chunk protects its referenced object. Its old journal
    // row is removed under the same lock after a fresh reference check.
    const referencedKey = "telemetry/v12-synthetic-referenced";
    const referencedId = `chunk:${randomUUID()}`;
    await insertPending(pool, schema, referencedId, referencedKey, FIXED_NOW - 3 * SAFETY_WINDOW,
      "registered");
    await insertV12Chunk(pool, schema, authorities, {
      contributionId: referencedId, objectKey: referencedKey, nowEpoch: FIXED_NOW,
    });
    store.objects.set(referencedKey, new Uint8Array([1, 2, 3]));
    await pool.query(
      `UPDATE ${q(schema, "pending_objects")}
          SET reconciliation_state='deleting', reconciliation_lease_id='legacy-v4-lease'
        WHERE contribution_id=$1`,
      [referencedId],
    );

    const lateKey = "telemetry/v12-synthetic-late-put";
    const lateId = `chunk:${randomUUID()}`;
    await insertPending(pool, schema, lateId, lateKey, FIXED_NOW - 3 * SAFETY_WINDOW);
    store.objects.set(lateKey, new Uint8Array([4, 5, 6]));
    const legacyKey = "telemetry/v12-synthetic-legacy-lease";
    const legacyId = `chunk:${randomUUID()}`;
    await insertPending(pool, schema, legacyId, legacyKey, FIXED_NOW - 3 * SAFETY_WINDOW,
      "deleting", randomUUID());
    store.objects.set(legacyKey, new Uint8Array([12]));
    const nullLeaseKey = "telemetry/v12-synthetic-null-lease";
    const nullLeaseId = `chunk:${randomUUID()}`;
    await insertPending(pool, schema, nullLeaseId, nullLeaseKey, FIXED_NOW - 3 * SAFETY_WINDOW,
      "deleting", null);
    store.objects.set(nullLeaseKey, new Uint8Array([13]));
    const firstPass = await module.reconcilePostgresPendingObjects(pool, store, options);
    assert.equal(firstPass.deletionGraceStarted, 3);
    assert.equal(firstPass.legacyLeasesAdopted, 2);
    assert.equal(firstPass.referencedObjectsPreserved, 1);
    assert.equal(firstPass.orphanObjectsDeleted, 0);
    assert.deepEqual(store.calls.head, [], "first pass must not call the object provider");
    assert.ok(store.objects.has(lateKey));
    const cleanedReference = await pool.query(
      `SELECT 1 FROM ${q(schema, "pending_objects")} WHERE contribution_id=$1`,
      [referencedId],
    );
    assert.equal(cleanedReference.rows.length, 0);
    const preservedChunk = await pool.query(
      `SELECT 1 FROM ${q(schema, "telemetry_v12_chunks")} WHERE id=$1`, [referencedId],
    );
    assert.equal(preservedChunk.rows.length, 1);
    assert.ok(store.objects.has(referencedKey));
    const adopted = await pool.query(
      `SELECT reconciliation_state, reconciliation_lease_id
         FROM ${q(schema, "pending_objects")} WHERE contribution_id=$1`,
      [legacyId],
    );
    assert.equal(adopted.rows[0]?.reconciliation_state, "deleting");
    assert.match(adopted.rows[0]?.reconciliation_lease_id ?? "", /^pgq1:/u);
    const adoptedNullLease = await pool.query(
      `SELECT reconciliation_state, reconciliation_lease_id
         FROM ${q(schema, "pending_objects")} WHERE contribution_id=$1`,
      [nullLeaseId],
    );
    assert.equal(adoptedNullLease.rows[0]?.reconciliation_state, "deleting");
    assert.match(adoptedNullLease.rows[0]?.reconciliation_lease_id ?? "", /^pgq1:/u);

    // A PUT completing after the initial deleting claim remains present until
    // the second full window; the chunk insert trigger rejects publication.
    store.objects.set(lateKey, new Uint8Array([7, 8, 9]));
    const lateManifest = randomUUID();
    const lateAuthorization = `synthetic-upload-${randomUUID()}`;
    const digest = "c".repeat(64);
    await pool.query(
      `INSERT INTO ${q(schema, "telemetry_v12_day_manifests")} (
         id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
         manifest_json, expected_chunk_count, state, created_at
       ) VALUES ($1,$2,$3,'2026-09-24',$4,'synthetic-v12','{}',1,'staged',$5)`,
      [lateManifest, authorities.participantId, authorities.deviceId, digest, authorities.now],
    );
    await pool.query(
      `INSERT INTO ${q(schema, "device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,1,'application/json','unused',$6,$7)`,
      [lateAuthorization, authorities.participantId, authorities.deviceId, randomBytes(32),
        digest, authorities.now, authorities.expires],
    );
    await assert.rejects(pool.query(
      `INSERT INTO ${q(schema, "telemetry_v12_chunks")} (
         id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
         chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
         r2_key, device_upload_authorization_id, created_at
       ) VALUES ($1,$2,$3,$4,'usage','2026-09-24',0,'usage:2026-09-24:late',$5,$6,
                'synthetic-v12',1,$7,$8,$9)`,
      [lateId, lateManifest, authorities.participantId, authorities.deviceId, digest,
        "d".repeat(64), lateKey, lateAuthorization, authorities.now],
    ), (error) => error?.code === "P1005");

    const beforeLeaseExpiry = await module.reconcilePostgresPendingObjects(pool, store, options);
    assert.equal(beforeLeaseExpiry.registrationsExamined, 0);
    assert.deepEqual(store.calls.head, []);
    const secondPass = await module.reconcilePostgresPendingObjects(pool, store, {
      ...options, nowEpoch: FIXED_NOW + SAFETY_WINDOW + 1,
    });
    assert.equal(secondPass.orphanObjectsDeleted, 3);
    assert.equal(store.objects.has(lateKey), false);
    assert.equal(store.objects.has(legacyKey), false);
    assert.equal(store.objects.has(nullLeaseKey), false);
    const lateRow = await pool.query(
      `SELECT 1 FROM ${q(schema, "pending_objects")} WHERE contribution_id=$1`, [lateId],
    );
    assert.equal(lateRow.rows.length, 0);
    const referencedRow = await pool.query(
      `SELECT 1 FROM ${q(schema, "pending_objects")} WHERE contribution_id=$1`,
      [referencedId],
    );
    assert.equal(referencedRow.rows.length, 0);
    assert.ok(store.objects.has(referencedKey));

    // Simulate process loss after the provider removed bytes but before the
    // database journal was cleared. A stale lease checks authoritative absence.
    const crashKey = "telemetry/v12-synthetic-crash-retry";
    const crashId = `chunk:${randomUUID()}`;
    await insertPending(pool, schema, crashId, crashKey, FIXED_NOW - 3 * SAFETY_WINDOW);
    store.objects.set(crashKey, new Uint8Array([10]));
    await module.reconcilePostgresPendingObjects(pool, store, options);
    store.failNextDeleteAfterRemoving();
    const failAt = FIXED_NOW + SAFETY_WINDOW + 2;
    await assert.rejects(
      module.reconcilePostgresPendingObjects(pool, store, { ...options, nowEpoch: failAt }),
      { name: "QuarantineObjectStorageUnavailableError" },
    );
    const heldLease = await pool.query(
      `SELECT reconciliation_state, reconciliation_lease_id FROM ${q(schema, "pending_objects")}
        WHERE contribution_id=$1`,
      [crashId],
    );
    assert.equal(heldLease.rows[0]?.reconciliation_state, "deleting");
    assert.ok(heldLease.rows[0]?.reconciliation_lease_id);
    const noEarlyRetry = await module.reconcilePostgresPendingObjects(pool, store, {
      ...options, nowEpoch: failAt + SAFETY_WINDOW - 1,
    });
    assert.equal(noEarlyRetry.registrationsExamined, 0);
    const retry = await module.reconcilePostgresPendingObjects(pool, store, {
      ...options, nowEpoch: failAt + SAFETY_WINDOW + 1,
    });
    assert.equal(retry.orphanObjectsAlreadyAbsent, 1);
    assert.equal(store.objects.has(crashKey), false);
    const crashRow = await pool.query(
      `SELECT 1 FROM ${q(schema, "pending_objects")} WHERE contribution_id=$1`, [crashId],
    );
    assert.equal(crashRow.rows.length, 0);

    // Both reconcilers see one stale registration before either claims it. The
    // row lock and fresh lease allow exactly one to start the grace period.
    const raceKey = "telemetry/v12-synthetic-race";
    const raceId = `chunk:${randomUUID()}`;
    await insertPending(pool, schema, raceId, raceKey, FIXED_NOW - 3 * SAFETY_WINDOW);
    store.objects.set(raceKey, new Uint8Array([11]));
    const coordinatedPool = racePool(pool, schema);
    const [raceA, raceB] = await Promise.all([
      module.reconcilePostgresPendingObjects(coordinatedPool, store, options),
      module.reconcilePostgresPendingObjects(coordinatedPool, store, options),
    ]);
    assert.equal(raceA.deletionGraceStarted + raceB.deletionGraceStarted, 1);
    assert.equal(raceA.candidatesDeferred + raceB.candidatesDeferred, 1);
    assert.equal(store.calls.head.includes(raceKey), false);
    const raceRow = await pool.query(
      `SELECT reconciliation_state, reconciliation_lease_id FROM ${q(schema, "pending_objects")}
        WHERE contribution_id=$1`,
      [raceId],
    );
    assert.equal(raceRow.rows[0]?.reconciliation_state, "deleting");
    assert.match(raceRow.rows[0]?.reconciliation_lease_id ?? "", /^pgq1:/u);
  } finally {
    if (pool && schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (pool) await pool.end();
    if (vite) await vite.close();
  }
});
