import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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
const DAY = 24 * 60 * 60 * 1_000;

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "device lifecycle tests require a loopback host or private Unix socket");
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

function q(schema, table) { return `"${schema}"."${table}"`; }

async function seedParticipant(pool, schema, { id, ownerKind = "social", now, createdAt = now }) {
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, created_at)
     VALUES ($1, $2, 'active', $3::timestamptz)`,
    [id, ownerKind, createdAt],
  );
}

async function seedSession(pool, schema, { id, participantId, nowEpoch }) {
  const issuedAt = new Date(nowEpoch - DAY).toISOString();
  await pool.query(
    `INSERT INTO ${q(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
    [id, participantId, randomBytes(32), randomBytes(32), issuedAt,
      new Date(nowEpoch + 30 * DAY).toISOString()],
  );
}

async function seedPairing(pool, schema, { id, participantId, sessionId, nowEpoch, state = "unused", expiresAt }) {
  const expiry = expiresAt ?? new Date(nowEpoch + 7 * DAY).toISOString();
  const issuedAt = new Date(Date.parse(expiry) - DAY).toISOString();
  await pool.query(
    `INSERT INTO ${q(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at
     ) VALUES ($1, $2, $3, $4, 'privacy-safe-telemetry-v0.1',
       'privacy-safe-telemetry-v0.1', $5, $6::timestamptz, $7::timestamptz,
       CASE WHEN $5 = 'consumed' THEN $6::timestamptz ELSE NULL END)`,
    [id, participantId, sessionId, randomBytes(32), state, issuedAt, expiry],
  );
}

async function seedSocialDevice(pool, schema, {
  id,
  participantId,
  pairingId,
  nowEpoch,
  expiresAt = new Date(nowEpoch + 7 * DAY).toISOString(),
  lastUsedAt = new Date(nowEpoch).toISOString(),
}) {
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
       $6::timestamptz, $7::timestamptz, $5::timestamptz)`,
    [id, participantId, pairingId, randomBytes(32), new Date(nowEpoch - DAY).toISOString(),
      expiresAt, lastUsedAt],
  );
}

async function seedUpload(pool, schema, {
  id,
  participantId,
  deviceId,
  nowEpoch,
  state = "unused",
  expiresAt = new Date(nowEpoch + DAY).toISOString(),
  leaseExpiresAt = null,
}) {
  await pool.query(
    `INSERT INTO ${q(schema, "device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at
     ) VALUES ($1, $2, $3, $4, $5, 1, 'application/json', $6,
       $7::timestamptz, $8::timestamptz, $9::timestamptz)`,
    [id, participantId, deviceId, randomBytes(32), "a".repeat(64), state,
      new Date(nowEpoch - DAY).toISOString(), expiresAt, leaseExpiresAt],
  );
}

test("PostgreSQL device lifecycle maintenance mirrors D1, drains bounded pages, and is replay-safe", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localEndpoint();
  const pool = new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 8,
    connectionTimeoutMillis: 5_000,
  });
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `device_lifecycle_${suffix}`;
  const schema = { primarySchema };
  let primaryCreated = false;
  let vite;
  let lockHolder;
  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr()::text AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "device lifecycle qualification requires PostgreSQL 17");
    if (endpoint.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));

    await pool.query(`CREATE SCHEMA "${primarySchema}"`);
    primaryCreated = true;
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool });

    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
      logLevel: "silent",
    });
    const lifecycle = await vite.ssrLoadModule("/src/postgres-device-lifecycle.ts");
    const maintenance = await vite.ssrLoadModule("/src/postgres-maintenance.ts");
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    const past = new Date(nowEpoch - 2 * DAY).toISOString();
    const recent = new Date(nowEpoch - 30 * 60 * 1_000).toISOString();
    const future = new Date(nowEpoch + DAY).toISOString();
    const activeParticipant = `active-${suffix}`;
    const inactiveParticipant = `inactive-${suffix}`;
    const accountlessParticipant = `accountless-${suffix}`;
    await seedParticipant(pool, primarySchema, { id: activeParticipant, now });
    await seedParticipant(pool, primarySchema, { id: inactiveParticipant, now });
    await seedParticipant(pool, primarySchema, {
      id: accountlessParticipant, ownerKind: "accountless", now,
    });

    const sessionByParticipant = new Map();
    for (const participantId of [activeParticipant, inactiveParticipant, accountlessParticipant]) {
      const sessionId = `session-${randomUUID()}`;
      await seedSession(pool, primarySchema, { id: sessionId, participantId, nowEpoch });
      sessionByParticipant.set(participantId, sessionId);
    }

    const expiredPairingIds = Array.from({ length: 3 }, () => `expired-pairing-${randomUUID()}`);
    for (const id of expiredPairingIds) {
      await seedPairing(pool, primarySchema, {
        id,
        participantId: activeParticipant,
        sessionId: sessionByParticipant.get(activeParticipant),
        nowEpoch,
        expiresAt: new Date(nowEpoch - 1_000).toISOString(),
      });
    }
    const inactivePairingId = `inactive-pairing-${randomUUID()}`;
    await seedPairing(pool, primarySchema, {
      id: inactivePairingId,
      participantId: inactiveParticipant,
      sessionId: sessionByParticipant.get(inactiveParticipant),
      nowEpoch,
      expiresAt: future,
    });
    const freshPairingId = `fresh-pairing-${randomUUID()}`;
    await seedPairing(pool, primarySchema, {
      id: freshPairingId,
      participantId: activeParticipant,
      sessionId: sessionByParticipant.get(activeParticipant),
      nowEpoch,
      expiresAt: future,
    });

    const expiredDeviceId = `expired-device-${randomUUID()}`;
    const idleDeviceId = `idle-device-${randomUUID()}`;
    const inactiveDeviceId = `inactive-device-${randomUUID()}`;
    const freshDeviceId = `fresh-device-${randomUUID()}`;
    const devicePairingIds = [expiredDeviceId, idleDeviceId, inactiveDeviceId, freshDeviceId]
      .map(() => `consumed-pairing-${randomUUID()}`);
    for (let index = 0; index < devicePairingIds.length; index += 1) {
      const deviceId = [expiredDeviceId, idleDeviceId, inactiveDeviceId, freshDeviceId][index];
      const participantId = deviceId === inactiveDeviceId ? inactiveParticipant : activeParticipant;
      const pairingId = devicePairingIds[index];
      await seedPairing(pool, primarySchema, {
        id: pairingId,
        participantId,
        sessionId: sessionByParticipant.get(participantId),
        nowEpoch,
        state: "consumed",
        expiresAt: future,
      });
      await seedSocialDevice(pool, primarySchema, {
        id: deviceId,
        participantId,
        pairingId,
        nowEpoch,
        ...(deviceId === expiredDeviceId ? { expiresAt: new Date(nowEpoch - 1_000).toISOString() } : {}),
        ...(deviceId === idleDeviceId ? { lastUsedAt: new Date(nowEpoch - 31 * DAY).toISOString() } : {}),
      });
    }

    const expiredGrantId = `expired-grant-${randomUUID()}`;
    const revokedDeviceGrantIds = ["unused", "consuming", "unused"].map(
      (state) => `stale-device-grant-${state}-${randomUUID()}`,
    );
    const staleGrantDevices = [expiredDeviceId, idleDeviceId, inactiveDeviceId];
    for (let index = 0; index < staleGrantDevices.length; index += 1) {
      await seedUpload(pool, primarySchema, {
        id: revokedDeviceGrantIds[index],
        participantId: index === 2 ? inactiveParticipant : activeParticipant,
        deviceId: staleGrantDevices[index],
        nowEpoch,
        state: index === 1 ? "consuming" : "unused",
        leaseExpiresAt: index === 1 ? future : null,
      });
    }
    await seedUpload(pool, primarySchema, {
      id: expiredGrantId,
      participantId: activeParticipant,
      deviceId: freshDeviceId,
      nowEpoch,
      expiresAt: new Date(nowEpoch - 1_000).toISOString(),
    });
    const freshGrantId = `fresh-grant-${randomUUID()}`;
    await seedUpload(pool, primarySchema, {
      id: freshGrantId,
      participantId: activeParticipant,
      deviceId: freshDeviceId,
      nowEpoch,
    });
    const consumedGrantId = `consumed-grant-${randomUUID()}`;
    await seedUpload(pool, primarySchema, {
      id: consumedGrantId,
      participantId: activeParticipant,
      deviceId: freshDeviceId,
      nowEpoch,
      state: "consumed",
      expiresAt: new Date(nowEpoch - 1_000).toISOString(),
    });

    const accountlessDeviceId = `accountless-device-${randomUUID()}`;
    const enrollmentDeviceId = `enrollment-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${q(primarySchema, "accountless_enrollment_ledger")} (
         device_id, device_secret_hash, installation_principal_id, schema_version,
         policy_version, authorization_basis, state, issued_at, expires_at
       ) VALUES ($1,$2,$3,'synthetic-v1','synthetic-policy-v1',
         'synthetic-test-v1','active',$4::timestamptz,$5::timestamptz)`,
      [enrollmentDeviceId, randomBytes(32), `install-${suffix}`,
        new Date(nowEpoch - 2 * DAY).toISOString(), new Date(nowEpoch - DAY).toISOString()],
    );
    await pool.query(
      `INSERT INTO ${q(primarySchema, "device_credentials")} (
         id, participant_id, authority_kind, accountless_enrollment_device_id,
         secret_hash, state, issued_at, expires_at, last_used_at
       ) VALUES ($1,$2,'accountless',$3,$4,'active',$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
      [accountlessDeviceId, accountlessParticipant, enrollmentDeviceId, randomBytes(32),
        new Date(nowEpoch - 2 * DAY).toISOString(), new Date(nowEpoch - DAY).toISOString(),
        new Date(nowEpoch - 31 * DAY).toISOString()],
    );
    const accountlessGrantId = `accountless-expired-device-grant-${randomUUID()}`;
    await seedUpload(pool, primarySchema, {
      id: accountlessGrantId,
      participantId: accountlessParticipant,
      deviceId: accountlessDeviceId,
      nowEpoch,
    });

    await pool.query(
      `UPDATE ${q(primarySchema, "participants")} SET state='deleting' WHERE id=$1`,
      [inactiveParticipant],
    );

    const expiredRotationIds = Array.from({ length: 3 }, () => `expired-rotation-${randomUUID()}`);
    for (let index = 0; index < expiredRotationIds.length; index += 1) {
      await pool.query(
        `INSERT INTO ${q(primarySchema, "device_credential_rotations")} (
           id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
           attempt_id, generation, rotated_at, retire_at
         ) VALUES ($1,$2,$3,$4,$5,$6,2,$7::timestamptz,$8::timestamptz)`,
        [expiredRotationIds[index], [expiredDeviceId, idleDeviceId, freshDeviceId][index],
          activeParticipant, randomBytes(32), randomBytes(32), `attempt-${randomUUID()}`,
          now, past],
      );
    }
    const freshRotationId = `fresh-rotation-${randomUUID()}`;
    await pool.query(
      `INSERT INTO ${q(primarySchema, "device_credential_rotations")} (
         id, device_id, participant_id, prior_secret_hash, replacement_secret_hash,
         attempt_id, generation, rotated_at, retire_at
       ) VALUES ($1,$2,$3,$4,$5,$6,2,$7::timestamptz,$8::timestamptz)`,
      [freshRotationId, freshDeviceId, activeParticipant, randomBytes(32), randomBytes(32),
        `attempt-${randomUUID()}`, now, future],
    );

    const staleEventPairings = [...expiredPairingIds, inactivePairingId];
    for (const pairingId of staleEventPairings) {
      const participantId = pairingId === inactivePairingId ? inactiveParticipant : activeParticipant;
      await pool.query(
        `INSERT INTO ${q(primarySchema, "device_pairing_events")} (
           id, pairing_id, participant_id, kind, occurred_at
         ) VALUES ($1,$2,$3,'issued',$4::timestamptz)`,
        [`stale-event-${randomUUID()}`, pairingId, participantId, past],
      );
    }
    const freshEventPairingId = devicePairingIds[3];
    await pool.query(
      `INSERT INTO ${q(primarySchema, "device_pairing_events")} (
         id, pairing_id, participant_id, kind, occurred_at
       ) VALUES ($1,$2,$3,'claimed',$4::timestamptz)`,
      [`fresh-event-${randomUUID()}`, freshEventPairingId, activeParticipant, recent],
    );

    // A row locked by another transaction must be skipped rather than
    // blocking the scheduled pass; readback will keep this page incomplete.
    lockHolder = await pool.connect();
    await lockHolder.query("BEGIN");
    await lockHolder.query(
      `SELECT id FROM ${q(primarySchema, "device_pairings")} WHERE id=$1 FOR UPDATE`,
      [expiredPairingIds[0]],
    );

    const first = await lifecycle.purgePostgresStaleDeviceLifecycleRows(pool, {
      schema,
      nowEpoch,
      policy: { maintenanceBatchSize: 2 },
    });
    assert.deepEqual(first, {
      pairingsRevoked: 2,
      devicesRevoked: 2,
      uploadsRevoked: 2,
      rotationsPurged: 2,
      pairingEventsPurged: 2,
      complete: false,
    });
    assert.equal(JSON.stringify(first).includes(expiredDeviceId), false,
      "the maintenance receipt contains counts only");
    await lockHolder.query("COMMIT");
    lockHolder.release();
    lockHolder = null;

    const second = await lifecycle.purgePostgresStaleDeviceLifecycleRows(pool, {
      schema,
      nowEpoch,
      policy: { maintenanceBatchSize: 2 },
    });
    assert.deepEqual(second, {
      pairingsRevoked: 2,
      devicesRevoked: 1,
      uploadsRevoked: 2,
      rotationsPurged: 1,
      pairingEventsPurged: 2,
      complete: false,
    }, "the upload family still has one row beyond the bounded page");

    const third = await lifecycle.purgePostgresStaleDeviceLifecycleRows(pool, {
      schema,
      nowEpoch,
      policy: { maintenanceBatchSize: 2 },
    });
    assert.deepEqual(third, {
      pairingsRevoked: 0,
      devicesRevoked: 0,
      uploadsRevoked: 1,
      rotationsPurged: 0,
      pairingEventsPurged: 0,
      complete: true,
    });
    const replay = await lifecycle.purgePostgresStaleDeviceLifecycleRows(pool, {
      schema,
      nowEpoch,
      policy: { maintenanceBatchSize: 2 },
    });
    assert.deepEqual(replay, {
      pairingsRevoked: 0,
      devicesRevoked: 0,
      uploadsRevoked: 0,
      rotationsPurged: 0,
      pairingEventsPurged: 0,
      complete: true,
    }, "replaying a completed pass makes no additional changes");

    const pairings = await pool.query(
      `SELECT id,state FROM ${q(primarySchema, "device_pairings")} WHERE id = ANY($1::text[])`,
      [[...expiredPairingIds, inactivePairingId, freshPairingId]],
    );
    const pairingStates = new Map(pairings.rows.map((row) => [row.id, row.state]));
    for (const id of [...expiredPairingIds, inactivePairingId]) assert.equal(pairingStates.get(id), "revoked");
    assert.equal(pairingStates.get(freshPairingId), "unused");

    const deviceRows = await pool.query(
      `SELECT id,state FROM ${q(primarySchema, "device_credentials")}
        WHERE id = ANY($1::text[])`,
      [[expiredDeviceId, idleDeviceId, inactiveDeviceId, freshDeviceId, accountlessDeviceId]],
    );
    const deviceStates = new Map(deviceRows.rows.map((row) => [row.id, row.state]));
    assert.equal(deviceStates.get(expiredDeviceId), "revoked");
    assert.equal(deviceStates.get(idleDeviceId), "revoked");
    assert.equal(deviceStates.get(inactiveDeviceId), "revoked");
    assert.equal(deviceStates.get(freshDeviceId), "active");
    assert.equal(deviceStates.get(accountlessDeviceId), "active",
      "accountless device expiry and idleness alone do not revoke durable ownership");

    const uploadRows = await pool.query(
      `SELECT id,state,consume_lease_expires_at FROM ${q(primarySchema, "device_upload_authorizations")}
        WHERE id = ANY($1::text[])`,
      [[expiredGrantId, ...revokedDeviceGrantIds, freshGrantId, consumedGrantId, accountlessGrantId]],
    );
    const uploadStates = new Map(uploadRows.rows.map((row) => [row.id, row]));
    for (const id of [expiredGrantId, ...revokedDeviceGrantIds, accountlessGrantId]) {
      assert.equal(uploadStates.get(id)?.state, "revoked");
    }
    assert.equal(uploadStates.get(revokedDeviceGrantIds[1])?.consume_lease_expires_at, null,
      "revoking an interrupted consuming grant clears its lease");
    assert.equal(uploadStates.get(freshGrantId)?.state, "unused");
    assert.equal(uploadStates.get(consumedGrantId)?.state, "consumed",
      "consumed replay receipts are retained");

    const rotationRows = await pool.query(
      `SELECT id FROM ${q(primarySchema, "device_credential_rotations")}
        WHERE id = ANY($1::text[])`,
      [[...expiredRotationIds, freshRotationId]],
    );
    assert.deepEqual(rotationRows.rows.map((row) => row.id), [freshRotationId]);
    const eventRows = await pool.query(
      `SELECT occurred_at FROM ${q(primarySchema, "device_pairing_events")}
        WHERE pairing_id = ANY($1::text[])`,
      [[...staleEventPairings, freshEventPairingId]],
    );
    assert.equal(eventRows.rows.length, 1);
    assert.equal(new Date(eventRows.rows[0].occurred_at).toISOString(), recent);

    const scheduled = await maintenance.runPostgresScheduledMaintenance({
      primaryPool: pool,
      objectStore: { async head() { return null; }, async delete() {} },
      schema,
      nowEpoch,
    });
    assert.equal(scheduled.outcome, "partial");
    assert.equal(scheduled.code, "POSTGRES_MAINTENANCE_INCOMPLETE_UNSUPPORTED_PHASES");
    assert.equal(scheduled.complete, false);
    assert.equal(scheduled.deviceLifecycleComplete, true);
    assert.deepEqual(scheduled.deviceLifecycle, {
      pairingsRevoked: 0,
      devicesRevoked: 0,
      uploadsRevoked: 0,
      rotationsPurged: 0,
      pairingEventsPurged: 0,
      complete: true,
    });
    // OD-4: the erasure-era items are constant true and marked not applicable.
    assert.equal(scheduled.ownerErasureJobsComplete, true);
    assert.equal(scheduled.restoreReplayComplete, true);
    assert.equal(scheduled.telemetryRetentionComplete, false);
    assert.equal(scheduled.deletionTombstoneRetentionComplete, true);
    assert.deepEqual([...scheduled.notApplicable],
      ["deletionTombstoneRetentionComplete", "ownerErasureJobsComplete", "restoreReplayComplete"]);
    assert.equal(scheduled.analyticsMaintenanceComplete, false);
  } finally {
    if (lockHolder) {
      try { await lockHolder.query("ROLLBACK"); } catch { /* preserve primary assertion */ }
      lockHolder.release(true);
    }
    await vite?.close();
    if (primaryCreated) await pool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await pool.end();
  }
});
