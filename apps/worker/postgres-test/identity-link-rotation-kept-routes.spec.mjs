// Round 16 (owner decisions 2026-10-02): the lost IDENTITY_LINK_SECRET is
// rotated at the cutover, which is safe only because round 12 retires every
// route that consumes the pin, a link key or a cooldown digest (the origin
// still keys its 60-second rate-limit subjects with the secret, which carry
// no continuity). The routes round 12 and OD-CR-1 KEEP (the social
// session, credential renew and disconnect, which keep the 14 native social
// devices uploading until their 180-day sunsets) must work unchanged with the
// rotated pin. This spec proves it on PostgreSQL 17: the session read, renew
// and disconnect succeed with the pin row at the rotated label and a new
// secret's fingerprint, and again with a pin no secret matches, because none
// of them reads the pin, the secret or a link key.
//
// Synthetic, content-free fixtures only; the schema is created and dropped
// here (prefix idlink_kept_).
//
//   PG_TEST_SOCKET=/private/tmp/tibotattle-pg-<name>/socket PG_TEST_PORT=<port> \
//     node --test postgres-test/identity-link-rotation-kept-routes.spec.mjs

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 24 * 60 * 60_000;
const FINGERPRINT_DOMAIN = "app-usagemonitor/identity-link-secret-fingerprint/v1\0";
const ROTATED_SECRET = "idlink-kept-routes-synthetic-rotated-secret-0000001";

async function localSocket() {
  assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.equal(metadata.isDirectory(), true);
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return host;
}

const q = (schema, name) => `"${schema}"."${name}"`;
const fingerprint = (secret) => createHmac("sha256", secret).update(FINGERPRINT_DOMAIN).digest("hex");

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

test("round 16: session, renew and disconnect work against a rotated identity-link pin", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const pool = new pg.Pool({ host: await localSocket(), port: PG_TEST_PORT, user: PG_TEST_USER,
    password: PG_TEST_PASSWORD ?? "synthetic-local-only", database: PG_TEST_DATABASE, ssl: false, max: 4,
    connectionTimeoutMillis: 5_000 });
  const schema = `idlink_kept_${randomBytes(5).toString("hex")}`;
  const options = { schema: { primarySchema: schema } };
  let created = false;
  let vite;
  let restoreTimingSafeEqual;
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the kept-routes proof requires PostgreSQL 17");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
    const crypto = await vite.ssrLoadModule("/src/crypto.ts");
    const { SESSION_COOKIE_NAME } = await vite.ssrLoadModule("/src/constants.ts");
    const devices = await vite.ssrLoadModule("/src/postgres-personal-devices.ts");
    const renewal = await vite.ssrLoadModule("/src/postgres-device-credential-renewal.ts");
    const disconnect = await vite.ssrLoadModule("/src/postgres-device-disconnect.ts");
    restoreTimingSafeEqual = crypto.setTimingSafeEqualImplementation((left, right) =>
      left.byteLength === right.byteLength && nodeTimingSafeEqual(Buffer.from(left), Buffer.from(right)));

    // The cutover's end state: PT-3 imported the sealed pin, the
    // identity-link-rotation stage moved it to production-v2 and a NEW
    // secret's fingerprint.
    const nowEpoch = Date.now() - (Date.now() % 1000);
    const now = new Date(nowEpoch).toISOString();
    await pool.query(`INSERT INTO ${q(schema, "identity_link_secret_configuration")}
        (singleton, key_version, secret_fingerprint, recorded_at) VALUES (1, 'production-v2', $1, $2::timestamptz)`,
    [fingerprint(ROTATED_SECRET), now]);

    // An imported social participant: its session and its native device
    // (paired via a consumed pairing), verified within the 180-day sunset.
    const participantId = `participant:${randomUUID()}`;
    const consent = "privacy-safe-telemetry-v0.1";
    await pool.query(`INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
      VALUES ($1, 'social', 'active', $2, $3::timestamptz)`, [participantId, consent, now]);
    const sessionId = randomUUID();
    const sessionSecret = randomBytes(32).toString("base64url");
    const csrfToken = `um_csrf_${crypto.encodeBase64Url(await crypto.hashCapability("csrf", sessionId, sessionSecret))}`;
    await pool.query(`INSERT INTO ${q(schema, "web_sessions")}
        (id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at)
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz)`,
    [sessionId, participantId, Buffer.from(await crypto.hashCapability("session", sessionId, sessionSecret)),
      Buffer.from(await crypto.hashCapability("csrf-binding", sessionId, csrfToken)), now,
      new Date(nowEpoch + 30 * DAY).toISOString()]);
    const cookie = `${SESSION_COOKIE_NAME}=um_session_${sessionId}.${sessionSecret}`;
    const deviceId = randomUUID();
    const pairingId = randomUUID();
    const deviceSecret = randomBytes(32).toString("base64url");
    await pool.query(`INSERT INTO ${q(schema, "device_pairings")}
        (id, participant_id, issued_by_session_id, secret_hash, consent_version, transport_consent_version, state,
         issued_at, expires_at, consumed_at, claimed_device_id)
      VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6::timestamptz, $7::timestamptz, $6::timestamptz, $8)`,
    [pairingId, participantId, sessionId, randomBytes(32), consent, now, new Date(nowEpoch + 7 * DAY).toISOString(),
      deviceId]);
    await pool.query(`INSERT INTO ${q(schema, "device_credentials")}
        (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash, state, issued_at, expires_at,
         last_used_at, social_verified_at)
      VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz, $6::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [deviceId, participantId, pairingId, deviceSecretHash(deviceId, deviceSecret), now,
      new Date(nowEpoch + 7 * DAY).toISOString()]);

    const exercise = async (label) => {
      // The session (OD-CR-1 kept): authenticated against web_sessions only.
      const principal = await devices.authenticatePostgresPersonalSession(pool, cookie, options);
      assert.equal(principal.participantId, participantId, label);
      assert.equal(principal.csrfToken, csrfToken, label);
      return principal;
    };
    await exercise("rotated pin");

    // Credential renew (kept): a new generation, capped by social_verified_at.
    const nextSecret = randomBytes(32).toString("base64url");
    const renewed = await renewal.renewPostgresDeviceCredential(pool, `Device um_device_${deviceId}.${deviceSecret}`, {
      nextDeviceSecretHash: deviceSecretHash(deviceId, nextSecret).toString("hex"), rotationAttemptId: randomUUID(),
    }, { ...options, nowEpoch });
    assert.equal(renewed.credentialGeneration, 2);

    // A pin that no secret matches (as an unrotated import would leave it
    // against the new secret): the kept routes do not notice either.
    await pool.query(`UPDATE ${q(schema, "identity_link_secret_configuration")}
      SET key_version = 'production-v1', secret_fingerprint = $1`, ["0".repeat(64)]);
    await exercise("a pin no secret matches");

    // Disconnect (kept): revokes the device with its renewed credential.
    const disconnected = await disconnect.disconnectPostgresAuthenticatedDevice(pool,
      `Device um_device_${deviceId}.${nextSecret}`, options);
    assert.deepEqual({ ...disconnected }, { deviceId, revoked: true });
    const { rows } = await pool.query(`SELECT state FROM ${q(schema, "device_credentials")} WHERE id = $1`, [deviceId]);
    assert.equal(rows[0].state, "revoked");
    // Nothing touched the pin row.
    const { rows: pin } = await pool.query(`SELECT key_version, secret_fingerprint
      FROM ${q(schema, "identity_link_secret_configuration")}`);
    assert.deepEqual(pin, [{ key_version: "production-v1", secret_fingerprint: "0".repeat(64) }]);
  } finally {
    restoreTimingSafeEqual?.();
    await vite?.close();
    if (created) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    await pool.end();
  }
});
