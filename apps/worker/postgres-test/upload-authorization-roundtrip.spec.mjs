import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "PostgreSQL upload authorization tests require a loopback host or a private Unix socket");
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
  return PG_TEST_HOST ? { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false } : null;
}

function q(schema, name) {
  return `"${schema}"."${name}"`;
}

function bearerSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

function uploadSecretHash(authorizationId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device-upload/v1\0${authorizationId}\0${secret}`)
    .digest();
}

async function seedSocialDevice({ pool, schema, nowEpoch, consentVersion }) {
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 30 * 24 * 60 * 60_000).toISOString();
  const participantId = `synthetic-upload-${randomBytes(6).toString("hex")}`;
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1,'social','active',$2,$3)`,
    [participantId, consentVersion, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1,$2,$3,$4,$5,$5,'consumed',$6,$7,$6,$8)`,
    [pairingId, participantId, sessionId, randomBytes(32), consentVersion,
      now, expiresAt, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
    [deviceId, participantId, pairingId, bearerSecretHash(deviceId, secret), now, expiresAt],
  );
  return {
    principal: {
      deviceId,
      participantId,
      participantConsentVersion: consentVersion,
      expiresAt,
      credentialGeneration: 1,
      socialVerifiedAt: now,
      authorityKind: "social",
    },
    authorization: `Device um_device_${deviceId}.${secret}`,
  };
}

async function seedAccountlessDevice({ pool, schema, nowEpoch, ttlMilliseconds = 30 * 24 * 60 * 60_000 }) {
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + ttlMilliseconds).toISOString();
  const participantId = `synthetic-accountless-upload-${randomBytes(6).toString("hex")}`;
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1,'accountless','active',NULL,$2)`,
    [participantId, now],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_enrollment_ledger")} (
       device_id, device_secret_hash, installation_principal_id, schema_version,
       policy_version, authorization_basis, state, issued_at, expires_at
     ) VALUES ($1,$2,$3,'accountless-enrollment-v1','accountless-opt-out-v1',
       'accountless-policy-v1','active',$4,$5)`,
    [deviceId, bearerSecretHash(deviceId, secret), `synthetic-install-${deviceId}`, now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, accountless_enrollment_device_id,
       secret_hash, state, issued_at, expires_at, last_used_at
     ) VALUES ($1,$2,'accountless',$1,$3,'active',$4,$5,$4)`,
    [deviceId, participantId, bearerSecretHash(deviceId, secret), now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_upload_owners")} (
       enrollment_device_id, participant_id, device_credential_id, policy_version,
       authorization_basis, authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'accountless-opt-out-v1','accountless-policy-v1',$3,$4,'active')`,
    [deviceId, participantId, now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_v11_device_authorizations")} (
       enrollment_device_id, participant_id, device_credential_id,
       telemetry_schema_version, field_dictionary_version, privacy_contract_version,
       authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'telemetry-contribution-v1.1',
       'telemetry-v1.1-registry-2026-08-31.1',
       'ongoing-privacy-safe-telemetry-v1.1',$3,$4,'active')`,
    [deviceId, participantId, now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "accountless_v12_device_authorizations")} (
       enrollment_device_id, participant_id, device_credential_id,
       telemetry_schema_version, field_dictionary_version, privacy_contract_version,
       authorized_at, expires_at, state
     ) VALUES ($1,$2,$1,'telemetry-contribution-v1.2',
       'telemetry-v1.2-registry-2026-09-20.1',
       'ongoing-privacy-safe-telemetry-v1.2',$3,$4,'active')`,
    [deviceId, participantId, now, expiresAt],
  );
  return {
    principal: {
      deviceId,
      participantId,
      participantConsentVersion: null,
      expiresAt,
      credentialGeneration: 1,
      socialVerifiedAt: null,
      authorityKind: "accountless",
    },
    authorization: `Device um_device_${deviceId}.${secret}`,
    expiresAt,
  };
}

function uploadCredential(authorization) {
  const match = /^um_device_upload_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(authorization);
  assert.ok(match, "issuer returns the documented upload credential format");
  assert.match(match[1], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  return { authorizationId: match[1], secret: match[2] };
}

test("PostgreSQL issues bounded upload grants under current device authority and claim remains one-use", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 60_000,
}, async () => {
  const endpoint = await localEndpoint();
  let pool;
  let vite;
  const schema = `upload_auth_${randomBytes(6).toString("hex")}`;
  let schemaCreated = false;
  try {
    pool = new pg.Pool({
      host: endpoint.host,
      port: endpoint.port,
      user: PG_TEST_USER,
      ...(PG_TEST_PASSWORD === undefined ? { password: "synthetic-local-only" } : { password: PG_TEST_PASSWORD }),
      database: PG_TEST_DATABASE,
      ssl: false,
      max: 3,
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
    const options = { schema: { primarySchema: schema } };
    vite = await createServer({
      root: WORKER_ROOT,
      configFile: false,
      server: { middlewareMode: true },
      appType: "custom",
    });
    const issuer = await vite.ssrLoadModule("/src/postgres-upload-authorization.ts");
    const transport = await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts");
    const constants = await vite.ssrLoadModule("/src/constants.ts");
    const nowEpoch = Date.now();
    const request = { envelopeDigest: "a".repeat(64), bodyBytes: 4096 };
    const validationPrincipal = {
      deviceId: randomUUID(),
      participantId: `synthetic-validation-${randomBytes(5).toString("hex")}`,
      participantConsentVersion: constants.TELEMETRY_CONSENT_VERSION,
      expiresAt: new Date(nowEpoch + 60_000).toISOString(),
      credentialGeneration: 1,
      socialVerifiedAt: new Date(nowEpoch).toISOString(),
      authorityKind: "social",
    };

    for (const invalid of [
      { envelopeDigest: "A".repeat(64), bodyBytes: 4096 },
      { envelopeDigest: "a".repeat(63), bodyBytes: 4096 },
      { envelopeDigest: "a".repeat(64), bodyBytes: 0 },
      { envelopeDigest: "a".repeat(64), bodyBytes: constants.MAX_REQUEST_BYTES + 1 },
    ]) {
      await assert.rejects(
        issuer.createPostgresDeviceUploadAuthorization(pool, validationPrincipal, invalid, { ...options, nowEpoch }),
        { code: "BODY_INVALID" },
      );
    }

    const social = await seedSocialDevice({
      pool,
      schema,
      nowEpoch,
      consentVersion: constants.TELEMETRY_CONSENT_VERSION,
    });
    const principal = await transport.authenticatePostgresDevice(
      pool, social.authorization, { ...options, nowEpoch },
    );
    await assert.rejects(
      transport.authenticatePostgresDevice(pool, `Upload ${social.authorization.slice("Device ".length)}`, {
        ...options, nowEpoch,
      }),
      { code: "DEVICE_AUTH_INVALID" },
    );

    const issued = await issuer.createPostgresDeviceUploadAuthorization(
      pool, principal, request, { ...options, nowEpoch },
    );
    assert.equal(issued.expiresAt, new Date(nowEpoch + constants.UPLOAD_AUTHORIZATION_TTL_MILLISECONDS).toISOString());
    const { authorizationId, secret } = uploadCredential(issued.uploadAuthorization);
    const issuedRow = await pool.query(
      `SELECT participant_id, issued_by_device_id, secret_hash, envelope_digest,
              body_bytes, content_type, state, expires_at
         FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [authorizationId],
    );
    assert.equal(issuedRow.rowCount, 1);
    assert.equal(issuedRow.rows[0].participant_id, principal.participantId);
    assert.equal(issuedRow.rows[0].issued_by_device_id, principal.deviceId);
    assert.deepEqual(issuedRow.rows[0].secret_hash, uploadSecretHash(authorizationId, secret));
    assert.equal(issuedRow.rows[0].envelope_digest, request.envelopeDigest);
    assert.equal(issuedRow.rows[0].body_bytes, request.bodyBytes);
    assert.equal(issuedRow.rows[0].content_type, "application/json");
    assert.equal(issuedRow.rows[0].state, "unused");
    assert.equal(new Date(issuedRow.rows[0].expires_at).toISOString(), issued.expiresAt);

    const claimRequest = { ...request, contentType: "application/json" };
    await assert.rejects(
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${issued.uploadAuthorization}`, {
        ...claimRequest,
        bodyBytes: request.bodyBytes + 1,
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    const competingClaims = await Promise.allSettled([
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${issued.uploadAuthorization}`, claimRequest, {
        ...options, nowEpoch,
      }),
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${issued.uploadAuthorization}`, claimRequest, {
        ...options, nowEpoch,
      }),
    ]);
    assert.equal(competingClaims.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(competingClaims.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal((await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`, [authorizationId],
    )).rows[0].state, "consuming");
    await assert.rejects(
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${issued.uploadAuthorization}`, claimRequest, {
        ...options, nowEpoch,
      }),
      { code: "UPLOAD_AUTH_INVALID" },
    );

    const expiresSoon = await seedAccountlessDevice({
      pool, schema, nowEpoch, ttlMilliseconds: 2 * 60_000,
    });
    const shortGrant = await issuer.createPostgresDeviceUploadAuthorization(
      pool, expiresSoon.principal, request, { ...options, nowEpoch },
    );
    assert.equal(shortGrant.expiresAt, expiresSoon.expiresAt,
      "accountless grant expiry is capped by the device/enrollment authority");
    const shortCredential = uploadCredential(shortGrant.uploadAuthorization);
    await assert.rejects(
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${shortGrant.uploadAuthorization}`, {
        ...request, contentType: "application/json",
      }, { ...options, nowEpoch: Date.parse(shortGrant.expiresAt) + 1 }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    assert.equal((await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [shortCredential.authorizationId],
    )).rows[0].state, "unused");

    const revoked = await seedSocialDevice({
      pool, schema, nowEpoch, consentVersion: constants.TELEMETRY_CONSENT_VERSION,
    });
    const revokedPrincipal = await transport.authenticatePostgresDevice(
      pool, revoked.authorization, { ...options, nowEpoch },
    );
    const revokedGrant = await issuer.createPostgresDeviceUploadAuthorization(
      pool, revokedPrincipal, request, { ...options, nowEpoch },
    );
    const revokedCredential = uploadCredential(revokedGrant.uploadAuthorization);
    await pool.query(
      `UPDATE ${q(schema, "device_credentials")} SET state='revoked', revoked_at=$2 WHERE id=$1`,
      [revokedPrincipal.deviceId, new Date(nowEpoch).toISOString()],
    );
    await assert.rejects(
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${revokedGrant.uploadAuthorization}`, {
        ...request, contentType: "application/json",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    assert.equal((await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [revokedCredential.authorizationId],
    )).rows[0].state, "unused");

    const accountless = await seedAccountlessDevice({ pool, schema, nowEpoch });
    const accountlessPrincipal = await transport.authenticatePostgresDevice(
      pool, accountless.authorization, { ...options, nowEpoch },
    );
    const accountlessGrant = await issuer.createPostgresDeviceUploadAuthorization(
      pool, accountlessPrincipal, request, { ...options, nowEpoch },
    );
    const accountlessCredential = uploadCredential(accountlessGrant.uploadAuthorization);
    await pool.query(
      `UPDATE ${q(schema, "accountless_v11_device_authorizations")}
          SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out'
        WHERE enrollment_device_id=$1`,
      [accountless.principal.deviceId, new Date(nowEpoch).toISOString()],
    );
    const v12State = await pool.query(
      `SELECT state FROM ${q(schema, "accountless_v12_device_authorizations")} WHERE enrollment_device_id=$1`,
      [accountless.principal.deviceId],
    );
    assert.equal(v12State.rows[0].state, "active",
      "the v1.1 transport authority is an additional required gate even while v1.2 authority remains active");
    await assert.rejects(
      issuer.createPostgresDeviceUploadAuthorization(
        pool, accountlessPrincipal, request, { ...options, nowEpoch },
      ),
      { code: "DEVICE_AUTH_INVALID" },
    );
    await assert.rejects(
      transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${accountlessGrant.uploadAuthorization}`, {
        ...request, contentType: "application/json",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    assert.equal((await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [accountlessCredential.authorizationId],
    )).rows[0].state, "unused");
  } finally {
    if (pool && schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (pool) await pool.end();
    if (vite) await vite.close();
  }
});
