import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
const DAY = 24 * 60 * 60_000;

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "credential renewal tests require loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
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
    return { host, port: PG_TEST_PORT };
  }
  if (PG_TEST_HOST) return { host: PG_TEST_HOST, port: PG_TEST_PORT };
  return null;
}

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

function authorization(deviceId, secret) {
  return `Device um_device_${deviceId}.${secret}`;
}

async function seedSocialDevice({ pool, schema, nowEpoch, socialVerifiedAt = nowEpoch, lastUsedAt = nowEpoch, withPendingUpload = false }) {
  const deviceId = randomUUID();
  const participantId = `participant:${randomUUID()}`;
  const pairingId = randomUUID();
  const sessionId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 7 * DAY).toISOString();
  const verified = socialVerifiedAt === null ? null : new Date(socialVerifiedAt).toISOString();
  const lastUsed = new Date(lastUsedAt).toISOString();
  const consent = "privacy-safe-telemetry-v0.1";

  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (
       id, owner_kind, state, consent_version, created_at
     ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
    [participantId, consent, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now,
      new Date(nowEpoch + 30 * DAY).toISOString()],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at,
       claimed_device_id
     ) VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6::timestamptz,
       $7::timestamptz, $6::timestamptz, $8)`,
    [pairingId, participantId, sessionId, randomBytes(32), consent, now, expiresAt, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
       $6::timestamptz, $7::timestamptz, $8::timestamptz)`,
    [deviceId, participantId, pairingId, deviceSecretHash(deviceId, secret), now,
      expiresAt, lastUsed, verified],
  );
  let uploadId;
  if (withPendingUpload) {
    uploadId = randomUUID();
    await pool.query(
      `INSERT INTO ${q(schema, "device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 1, 'application/json', 'unused',
         $6::timestamptz, $7::timestamptz)`,
      [uploadId, participantId, deviceId, randomBytes(32), "a".repeat(64), now,
        new Date(nowEpoch + DAY).toISOString()],
    );
  }
  return {
    deviceId,
    participantId,
    pairingId,
    secret,
    authorization: authorization(deviceId, secret),
    uploadId,
  };
}

test("PostgreSQL device credential renewal fences replay, reuse, and social expiry", {
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
  const schema = `credential_renew_${randomBytes(6).toString("hex")}`;
  const options = { schema: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };
  let createdSchema = false;
  let vite;
  let restoreTimingSafeEqual;
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "credential renewal regression requires PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    createdSchema = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const adapter = await vite.ssrLoadModule("/src/postgres-device-credential-renewal.ts");
    const cryptoModule = await vite.ssrLoadModule("/src/crypto.ts");
    restoreTimingSafeEqual = cryptoModule.setTimingSafeEqualImplementation((left, right) => {
      if (left.byteLength !== right.byteLength) return false;
      return nodeTimingSafeEqual(Buffer.from(left), Buffer.from(right));
    });

    const nowEpoch = Date.UTC(2026, 0, 1, 12, 0, 0);
    const replacementSecret = randomBytes(32).toString("base64url");
    const fixture = await seedSocialDevice({
      pool, schema, nowEpoch, withPendingUpload: true,
    });
    const request = Object.freeze({
      nextDeviceSecretHash: deviceSecretHash(fixture.deviceId, replacementSecret).toString("hex"),
      rotationAttemptId: randomUUID(),
    });
    const rotate = (body = request, auth = fixture.authorization) =>
      adapter.renewPostgresDeviceCredential(pool, auth, body, { ...options, nowEpoch });

    const concurrent = await Promise.all([rotate(), rotate()]);
    assert.deepEqual(concurrent[0], concurrent[1],
      "simultaneous exact attempts converge on one committed receipt");
    assert.equal(concurrent[0].credentialGeneration, 2);
    assert.equal(Date.parse(concurrent[0].expiresAt), nowEpoch + 30 * DAY);
    const replay = await rotate();
    assert.deepEqual(replay, concurrent[0]);
    const rotationRows = await pool.query(
      `SELECT count(*)::integer AS count FROM ${q(schema, "device_credential_rotations")}
        WHERE device_id=$1`, [fixture.deviceId],
    );
    assert.equal(rotationRows.rows[0].count, 1);

    const wrongAttemptHash = { ...request, nextDeviceSecretHash: "b".repeat(64) };
    await assert.rejects(rotate(wrongAttemptHash), (error) => error?.status === 401
      && error?.code === "DEVICE_AUTH_INVALID");
    const stillActive = await pool.query(
      `SELECT state, credential_generation FROM ${q(schema, "device_credentials")} WHERE id=$1`,
      [fixture.deviceId],
    );
    assert.deepEqual(stillActive.rows[0], { state: "active", credential_generation: 2 },
      "a mismatched attempt id replay does not revoke the active credential");

    const reusedOldSecretAttempt = {
      ...request,
      rotationAttemptId: randomUUID(),
    };
    await assert.rejects(rotate(reusedOldSecretAttempt), (error) => error?.status === 401
      && error?.code === "DEVICE_AUTH_INVALID");
    const revoked = await pool.query(
      `SELECT state FROM ${q(schema, "device_credentials")} WHERE id=$1`, [fixture.deviceId],
    );
    assert.equal(revoked.rows[0].state, "revoked",
      "a different attempt presenting a retained prior secret revokes the device");
    const upload = await pool.query(
      `SELECT state, consume_lease_expires_at FROM ${q(schema, "device_upload_authorizations")}
        WHERE id=$1`, [fixture.uploadId],
    );
    assert.deepEqual(upload.rows[0], { state: "revoked", consume_lease_expires_at: null },
      "reuse revocation also clears pending upload authority");

    const justWithinHorizon = await seedSocialDevice({
      pool, schema, nowEpoch,
      socialVerifiedAt: nowEpoch - 180 * DAY + 1,
      lastUsedAt: nowEpoch - 30 * DAY + 1,
    });
    const horizonRequest = {
      nextDeviceSecretHash: deviceSecretHash(justWithinHorizon.deviceId, randomBytes(32).toString("base64url")).toString("hex"),
      rotationAttemptId: randomUUID(),
    };
    const horizonReceipt = await adapter.renewPostgresDeviceCredential(
      pool, justWithinHorizon.authorization, horizonRequest, { ...options, nowEpoch },
    );
    assert.equal(Date.parse(horizonReceipt.expiresAt), nowEpoch + 1,
      "the strict social recheck boundary remains one millisecond inside the horizon");

    const atSocialDeadline = await seedSocialDevice({
      pool, schema, nowEpoch,
      socialVerifiedAt: nowEpoch - 180 * DAY,
    });
    await assert.rejects(adapter.renewPostgresDeviceCredential(
      pool,
      atSocialDeadline.authorization,
      {
        nextDeviceSecretHash: deviceSecretHash(atSocialDeadline.deviceId, randomBytes(32).toString("base64url")).toString("hex"),
        rotationAttemptId: randomUUID(),
      },
      { ...options, nowEpoch },
    ), (error) => error?.status === 401 && error?.code === "DEVICE_AUTH_INVALID");
    const unchangedDeadline = await pool.query(
      `SELECT credential_generation FROM ${q(schema, "device_credentials")} WHERE id=$1`,
      [atSocialDeadline.deviceId],
    );
    assert.equal(unchangedDeadline.rows[0].credential_generation, 1,
      "the exact social deadline cannot renew");

    const staleIdle = await seedSocialDevice({
      pool, schema, nowEpoch,
      lastUsedAt: nowEpoch - 30 * DAY,
    });
    await assert.rejects(adapter.renewPostgresDeviceCredential(
      pool,
      staleIdle.authorization,
      {
        nextDeviceSecretHash: deviceSecretHash(staleIdle.deviceId, randomBytes(32).toString("base64url")).toString("hex"),
        rotationAttemptId: randomUUID(),
      },
      { ...options, nowEpoch },
    ), (error) => error?.status === 401 && error?.code === "DEVICE_AUTH_INVALID");

    const rollbackFixture = await seedSocialDevice({ pool, schema, nowEpoch });
    const rollbackAttempt = randomUUID();
    await pool.query(
      `CREATE FUNCTION ${q(schema, "reject_credential_renewal_update")}()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '${rollbackFixture.deviceId}' AND NEW.credential_generation > OLD.credential_generation THEN
           RAISE EXCEPTION 'synthetic renewal update failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await pool.query(
      `CREATE TRIGGER reject_credential_renewal_update
       BEFORE UPDATE ON ${q(schema, "device_credentials")}
       FOR EACH ROW EXECUTE FUNCTION ${q(schema, "reject_credential_renewal_update")}()`,
    );
    const rollbackRequest = {
      nextDeviceSecretHash: deviceSecretHash(rollbackFixture.deviceId, randomBytes(32).toString("base64url")).toString("hex"),
      rotationAttemptId: rollbackAttempt,
    };
    await assert.rejects(adapter.renewPostgresDeviceCredential(
      pool, rollbackFixture.authorization, rollbackRequest, { ...options, nowEpoch },
    ), (error) => error?.status === 503 && error?.code === "BACKEND_STORAGE_UNAVAILABLE");
    await pool.query(`DROP TRIGGER reject_credential_renewal_update ON ${q(schema, "device_credentials")}`);
    await pool.query(`DROP FUNCTION ${q(schema, "reject_credential_renewal_update")}()`);
    const rolledBack = await pool.query(
      `SELECT device.credential_generation, count(rotation.id)::integer AS rotations
         FROM ${q(schema, "device_credentials")} device
         LEFT JOIN ${q(schema, "device_credential_rotations")} rotation
           ON rotation.device_id = device.id AND rotation.attempt_id = $2
        WHERE device.id = $1 GROUP BY device.credential_generation`,
      [rollbackFixture.deviceId, rollbackAttempt],
    );
    assert.deepEqual(rolledBack.rows[0], { credential_generation: 1, rotations: 0 },
      "an update failure rolls back the preceding rotation insert");

    const parser = adapter.parsePostgresDeviceCredentialRenewalJson;
    assert.throws(() => parser("{}"), (error) => error?.status === 400);
    assert.throws(() => parser('{"nextDeviceSecretHash":"a","nextDeviceSecretHash":"b","rotationAttemptId":"x"}'),
      (error) => error?.status === 400);
  } finally {
    restoreTimingSafeEqual?.();
    await vite?.close();
    if (createdSchema) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await pool.end();
  }
});
