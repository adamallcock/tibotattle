import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTestDevicePairingDispatch } from "../cloud-run/postgres-test-dispatch.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_ORIGIN = "http://127.0.0.1:8080";
const TELEMETRY_CONSENT_VERSION = "privacy-safe-telemetry-v0.1";
const ONGOING_INCREMENTAL_CONSENT_VERSION = "ongoing-privacy-safe-telemetry-v1.0";

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

after(async () => vite.close());

function table(schema, name) {
  return `"${schema}"."${name}"`;
}

async function localPostgresEndpoint() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host, port: PG_TEST_PORT };
}

test("Cloud Run PostgreSQL device pairing issues bounded social pairing codes behind session and CSRF", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  const endpoint = await localPostgresEndpoint();
  const poolOptions = {
    ...endpoint,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    ssl: false,
    max: 5,
    connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool({ ...poolOptions, application_name: "pg-device-pairing-primary-test" });
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `device_pairing_${suffix}`;
  const schemaOptions = { primarySchema };
  let primaryCreated = false;
  try {
    const server = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "pairing qualification requires PostgreSQL 17");
    assert.equal(server.rows[0].address, null, "qualification requires the private local Unix socket");

    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    primaryCreated = true;
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool });
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "collection_controls")}
          SET control_state = 'operational', enrollment_enabled = true,
              upload_registration_enabled = true, processing_enabled = true,
              publication_enabled = true, revision = revision + 1,
              updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );

    const devicePairing = await vite.ssrLoadModule("/src/postgres-device-pairing.ts");
    const personalSession = await vite.ssrLoadModule("/src/postgres-personal-session.ts");
    const personalDevices = await vite.ssrLoadModule("/src/postgres-personal-devices.ts");
    const accountScoped = await vite.ssrLoadModule("/src/account-scoped-ingest.ts");
    const boundedBody = await vite.ssrLoadModule("/src/bounded-body.ts");
    const sessionModule = await vite.ssrLoadModule("/src/session.ts");
    const constants = await vite.ssrLoadModule("/src/constants.ts");

    const ownerId = `social-owner-${suffix}`;
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    await primaryPool.query(
      `INSERT INTO ${table(primarySchema, "participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
      [ownerId, TELEMETRY_CONSENT_VERSION, now],
    );
    const session = await sessionModule.createSessionMaterial(ownerId, nowEpoch);
    await primaryPool.query(
      `INSERT INTO ${table(primarySchema, "web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, scope, state,
         issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz,
                $7::timestamptz, $6::timestamptz)`,
      [session.id, ownerId, session.secretHash, session.csrfHash, session.scope,
        session.issuedAt, session.expiresAt],
    );

    const healthDispatch = async () => new Response(null, { status: 200 });
    const dispatch = createPostgresTestDevicePairingDispatch({
      primaryPool,
      schemaOptions,
      authenticatePostgresPersonalSession: personalSession.authenticatePostgresPersonalSessionForRead,
      assertPostgresPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
      assertAccountScopedLocalPreview: accountScoped.assertAccountScopedLocalPreview,
      createPostgresDevicePairing: devicePairing.createPostgresDevicePairing,
      healthDispatch,
      readBoundedRequestBody: boundedBody.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
      admissionEnv: {
        ENVIRONMENT: "hosted-test",
        ENROLLMENT_MODE: "disabled",
        ACCOUNT_SCOPED_INGEST_MODE: "disabled",
      },
      privateOrigin: PRIVATE_ORIGIN,
    });
    const cookie = sessionModule.sessionCookie(session);
    const request = (body, overrides = {}) => new Request(
      `${PRIVATE_ORIGIN}/api/v1/me/device-pairings`,
      {
        method: overrides.method ?? "POST",
        headers: {
          origin: overrides.origin ?? PRIVATE_ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": overrides.contentType ?? "application/json",
          cookie: overrides.cookie ?? cookie,
          "x-usage-monitor-csrf": overrides.csrf ?? session.csrfToken,
          ...(overrides.authorization === undefined
            ? {} : { authorization: overrides.authorization }),
        },
        ...(overrides.method === "GET" ? {} : {
          body: overrides.rawBody ?? JSON.stringify(body),
        }),
      },
    );
    const apiError = async (response, status, code) => {
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body?.error?.code, code);
      assert.match(body?.error?.requestId ?? "", /^[0-9a-f-]{36}$/u);
    };

    await apiError(await dispatch(request({}, { cookie: "" })), 401, "AUTH_REQUIRED");
    await apiError(await dispatch(request({}, { authorization: "Bearer invalid" })), 401, "AUTH_INVALID");
    await apiError(await dispatch(request({}, { origin: "https://attacker.example" })), 403, "CSRF_INVALID");
    await apiError(await dispatch(request({}, { csrf: "wrong" })), 403, "CSRF_INVALID");
    await apiError(await dispatch(request({}, { method: "GET" })), 405, "METHOD_NOT_ALLOWED");
    await apiError(await dispatch(request({
      consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
      ongoingUpload: true,
      unexpected: true,
    })), 400, "BODY_INVALID");
    await apiError(await dispatch(request({}, { contentType: "text/plain" })), 415, "CONTENT_TYPE_INVALID");

    const first = await dispatch(request({
      consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
      ongoingUpload: true,
    }));
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("vary"), "Cookie");
    const firstBody = await first.json();
    assert.deepEqual(Object.keys(firstBody).sort(), ["expiresAt", "pairingCode"]);
    const match = /^um_pair_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(firstBody.pairingCode);
    assert.ok(match?.[1] && match[2]);
    const stored = await primaryPool.query(
      `SELECT id, participant_id, issued_by_session_id, secret_hash,
              consent_version, transport_consent_version, state, expires_at
         FROM ${table(primarySchema, "device_pairings")} WHERE id = $1`,
      [match[1]],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].participant_id, ownerId);
    assert.equal(stored.rows[0].issued_by_session_id, session.id);
    assert.equal(stored.rows[0].state, "unused");
    assert.equal(stored.rows[0].consent_version, ONGOING_INCREMENTAL_CONSENT_VERSION);
    assert.equal(stored.rows[0].transport_consent_version, ONGOING_INCREMENTAL_CONSENT_VERSION);
    const expectedHash = createHash("sha256")
      .update(`app-usagemonitor/device-pairing/v1\0${match[1]}\0${match[2]}`)
      .digest();
    assert.deepEqual(stored.rows[0].secret_hash, expectedHash);

    const second = await dispatch(request({
      consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
      ongoingUpload: true,
    }));
    assert.equal(second.status, 201);
    assert.notEqual((await second.json()).pairingCode, firstBody.pairingCode);
    const third = await dispatch(request({
      consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
      ongoingUpload: true,
    }));
    assert.equal(third.status, 201);
    await apiError(await dispatch(request({
      consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
      ongoingUpload: true,
    })), 429, "LIFECYCLE_BOUNDS_EXCEEDED");
    const pairingCount = await primaryPool.query(
      `SELECT count(*)::integer AS count FROM ${table(primarySchema, "device_pairings")}
        WHERE participant_id = $1`,
      [ownerId],
    );
    assert.equal(pairingCount.rows[0].count, 3);

    const repairOwnerId = `repair-owner-${suffix}`;
    await primaryPool.query(
      `INSERT INTO ${table(primarySchema, "participants")} (
         id, owner_kind, state, consent_version, created_at
       ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
      [repairOwnerId, TELEMETRY_CONSENT_VERSION, now],
    );
    const oldSession = await sessionModule.createSessionMaterial(repairOwnerId, nowEpoch - 2 * 86_400_000);
    const repairSession = await sessionModule.createSessionMaterial(repairOwnerId, nowEpoch);
    await primaryPool.query(
      `INSERT INTO ${table(primarySchema, "web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, scope, state,
         issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz,
                $7::timestamptz, $6::timestamptz)`,
      [oldSession.id, repairOwnerId, oldSession.secretHash, oldSession.csrfHash,
        oldSession.scope, oldSession.issuedAt, oldSession.expiresAt],
    );
    await primaryPool.query(
      `INSERT INTO ${table(primarySchema, "web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, scope, state,
         issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz,
                $7::timestamptz, $6::timestamptz)`,
      [repairSession.id, repairOwnerId, repairSession.secretHash, repairSession.csrfHash,
        repairSession.scope, repairSession.issuedAt, repairSession.expiresAt],
    );
    for (let index = 0; index < 3; index += 1) {
      const pairingId = randomUUID();
      const deviceId = randomUUID();
      const deviceIssuedAt = new Date(nowEpoch - (5 - index) * 86_400_000).toISOString();
      const pairingIssuedAt = new Date(nowEpoch - 2 * 86_400_000).toISOString();
      const future = new Date(nowEpoch + 30 * 86_400_000).toISOString();
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "device_pairings")} (
           id, participant_id, issued_by_session_id, secret_hash, consent_version,
           transport_consent_version, state, issued_at, expires_at
         ) VALUES ($1, $2, $3, $4, 'ongoing-privacy-safe-telemetry-v0.1',
                   'ongoing-privacy-safe-telemetry-v0.1', 'unused', $5::timestamptz, $6::timestamptz)`,
        [pairingId, repairOwnerId, oldSession.id, randomBytes(32), pairingIssuedAt, future],
      );
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
           state, issued_at, expires_at, last_used_at, social_verified_at
         ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
                   $6::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [deviceId, repairOwnerId, pairingId, randomBytes(32), deviceIssuedAt, future],
      );
      await primaryPool.query(
        `UPDATE ${table(primarySchema, "device_pairings")}
            SET state = 'consumed', claimed_device_id = $2, consumed_at = $3::timestamptz
          WHERE id = $1`,
        [pairingId, deviceId, deviceIssuedAt],
      );
      if (index === 0) {
        await primaryPool.query(
          `INSERT INTO ${table(primarySchema, "device_upload_authorizations")} (
             id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
             body_bytes, content_type, state, issued_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5, 100, 'application/json', 'unused',
                     $6::timestamptz, $7::timestamptz)`,
          [randomUUID(), repairOwnerId, deviceId, randomBytes(32), "a".repeat(64),
            now, new Date(nowEpoch + 5 * 60_000).toISOString()],
        );
      }
    }
    const repairCookie = sessionModule.sessionCookie(repairSession);
    const repair = await dispatch(new Request(`${PRIVATE_ORIGIN}/api/v1/me/device-pairings`, {
      method: "POST",
      headers: {
        origin: PRIVATE_ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: repairCookie,
        "x-usage-monitor-csrf": repairSession.csrfToken,
      },
      body: JSON.stringify({
        consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
        ongoingUpload: true,
      }),
    }));
    assert.equal(repair.status, 201);
    const repairDevices = await primaryPool.query(
      `SELECT id, state FROM ${table(primarySchema, "device_credentials")}
        WHERE participant_id = $1 ORDER BY issued_at, id`,
      [repairOwnerId],
    );
    assert.equal(repairDevices.rows.length, 3);
    assert.deepEqual(repairDevices.rows.map((row) => row.state), ["revoked", "active", "active"]);
    const pendingUpload = await primaryPool.query(
      `SELECT state, consume_lease_expires_at FROM ${table(primarySchema, "device_upload_authorizations")}
        WHERE participant_id = $1`,
      [repairOwnerId],
    );
    assert.equal(pendingUpload.rows.length, 1);
    assert.equal(pendingUpload.rows[0].state, "revoked");
    assert.equal(pendingUpload.rows[0].consume_lease_expires_at, null);

    await primaryPool.query(
      `UPDATE ${table(primarySchema, "collection_controls")}
          SET control_state = 'degraded', upload_registration_enabled = false,
              revision = revision + 1, updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );
    await apiError(await dispatch(request({
      consentVersion: ONGOING_INCREMENTAL_CONSENT_VERSION,
      ongoingUpload: true,
    })), 503, "UPLOAD_REGISTRATION_DISABLED");
  } finally {
    if (primaryCreated) await primaryPool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    await primaryPool.end();
  }
});
