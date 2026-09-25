import assert from "node:assert/strict";
import { after, test } from "node:test";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createServer } from "vite";
import { telemetryV12RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTestTelemetryV12ConsentDispatch } from "../cloud-run/postgres-test-dispatch.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_ORIGIN = "http://127.0.0.1:8080";
const ROUTE = "/api/v1/me/device-telemetry-v12-consents";
const TELEMETRY_CONSENT_VERSION = "privacy-safe-telemetry-v0.1";

const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const consentAdapter = await vite.ssrLoadModule("/src/postgres-telemetry-v12-consent.ts");
const personalSession = await vite.ssrLoadModule("/src/postgres-personal-session.ts");
const personalDevices = await vite.ssrLoadModule("/src/postgres-personal-devices.ts");
const ledgerAuthority = await vite.ssrLoadModule("/src/postgres-ledger-authority.ts");
const sessionModule = await vite.ssrLoadModule("/src/session.ts");
const constants = await vite.ssrLoadModule("/src/constants.ts");
const boundedBody = await vite.ssrLoadModule("/src/bounded-body.ts");

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

test("private PostgreSQL v1.2 consent route requires a live social session and persists idempotently", {
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
  const primaryPool = new pg.Pool({ ...poolOptions, application_name: "pg-v12-consent-primary-test" });
  const ledgerPool = new pg.Pool({ ...poolOptions, application_name: "pg-v12-consent-ledger-test" });
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `v12consent_${suffix}`;
  const ledgerSchema = `v12consent_l_${suffix}`;
  const schemaOptions = { primarySchema, ledgerSchema };
  let primaryCreated = false;
  let ledgerCreated = false;
  try {
    const server = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "consent qualification requires PostgreSQL 17");
    assert.equal(server.rows[0].address, null, "qualification requires the private local Unix socket");

    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    primaryCreated = true;
    await ledgerPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    ledgerCreated = true;
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primaryPool });
    await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool });
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "collection_controls")}
          SET control_state = 'operational', enrollment_enabled = true,
              upload_registration_enabled = true, processing_enabled = true,
              publication_enabled = true, revision = revision + 1,
              updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_runtime")}
          SET state = 'active', changed_at = clock_timestamp() WHERE id = 1`,
    );
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_typed_runtime")}
          SET state = 'active', changed_at = clock_timestamp() WHERE id = 1`,
    );

    const healthDispatch = async () => new Response(null, { status: 200 });
    const dispatch = createPostgresTestTelemetryV12ConsentDispatch({
      primaryPool,
      ledgerPool,
      schemaOptions,
      authenticatePostgresPersonalSession: personalSession.authenticatePostgresPersonalSessionForRead,
      assertPostgresPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
      grantPostgresTelemetryV12Consent: consentAdapter.grantPostgresTelemetryV12Consent,
      hasPostgresDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
      healthDispatch,
      readBoundedRequestBody: boundedBody.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
      privateOrigin: PRIVATE_ORIGIN,
    });

    async function seedSocialOwner(label) {
      const participantId = `${label}-${suffix}`;
      const nowEpoch = Date.now();
      const now = new Date(nowEpoch).toISOString();
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "participants")} (
           id, owner_kind, state, consent_version, created_at
         ) VALUES ($1, 'social', 'active', $2, $3::timestamptz)`,
        [participantId, TELEMETRY_CONSENT_VERSION, now],
      );
      const session = await sessionModule.createSessionMaterial(participantId, nowEpoch);
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "web_sessions")} (
           id, participant_id, secret_hash, csrf_hash, scope, state,
           issued_at, expires_at, last_used_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6::timestamptz,
                  $7::timestamptz, $6::timestamptz)`,
        [session.id, participantId, session.secretHash, session.csrfHash,
          session.scope, session.issuedAt, session.expiresAt],
      );
      const pairingId = randomUUID();
      const deviceId = randomUUID();
      const expiry = new Date(nowEpoch + 30 * 86_400_000).toISOString();
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "device_pairings")} (
           id, participant_id, issued_by_session_id, secret_hash, consent_version,
           transport_consent_version, state, issued_at, expires_at,
           consumed_at, claimed_device_id
         ) VALUES ($1, $2, $3, $4, 'ongoing-privacy-safe-telemetry-v0.1',
                   'ongoing-privacy-safe-telemetry-v1.2', 'consumed', $5::timestamptz,
                   $6::timestamptz, $5::timestamptz, $7)`,
        [pairingId, participantId, session.id, randomBytes(32), now, expiry, deviceId],
      );
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
           state, issued_at, expires_at, last_used_at, social_verified_at
         ) VALUES ($1, $2, 'social', $3, $4, 'active', $5::timestamptz,
                   $6::timestamptz, $5::timestamptz, $5::timestamptz)`,
        [deviceId, participantId, pairingId, randomBytes(32), now, expiry],
      );
      return { participantId, deviceId, session, cookie: sessionModule.sessionCookie(session) };
    }

    const owner = await seedSocialOwner("consent-owner");
    const foreignOwner = await seedSocialOwner("consent-foreign");
    const request = (body, overrides = {}) => new Request(
      `${overrides.origin ?? PRIVATE_ORIGIN}${ROUTE}${overrides.query ?? ""}`,
      {
        method: overrides.method ?? "POST",
        headers: {
          origin: overrides.requestOrigin ?? PRIVATE_ORIGIN,
          "sec-fetch-site": overrides.fetchSite ?? "same-origin",
          "content-type": overrides.contentType ?? "application/json",
          cookie: overrides.cookie ?? owner.cookie,
          "x-usage-monitor-csrf": overrides.csrf ?? owner.session.csrfToken,
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
      return body;
    };
    const consent = telemetryV12RequiredConsent();
    const validBody = (deviceId = owner.deviceId) => ({
      deviceId,
      consent,
      ongoingUpload: true,
    });

    await apiError(await dispatch(request(validBody(), { cookie: "" })), 401, "AUTH_REQUIRED");
    await apiError(await dispatch(request(validBody(), { authorization: "Bearer invalid" })), 401, "AUTH_INVALID");
    await apiError(await dispatch(request(validBody(), { requestOrigin: "https://attacker.example" })), 403, "CSRF_INVALID");
    await apiError(await dispatch(request(validBody(), { csrf: "wrong" })), 403, "CSRF_INVALID");
    await apiError(await dispatch(request(validBody(), { method: "GET" })), 405, "METHOD_NOT_ALLOWED");
    await apiError(await dispatch(request(validBody(), { contentType: "text/plain" })), 415, "CONTENT_TYPE_INVALID");
    await apiError(await dispatch(request(validBody(), { query: "?unexpected=1" })), 400, "BODY_INVALID");
    await apiError(await dispatch(request({
      ...validBody(),
      unexpected: true,
    })), 400, "BODY_INVALID");
    await apiError(await dispatch(request({
      ...validBody(),
      ongoingUpload: false,
    })), 400, "BODY_INVALID");
    await apiError(await dispatch(request({
      deviceId: owner.deviceId,
      consent: { ...consent, unexpected: true },
      ongoingUpload: true,
    })), 403, "TELEMETRY_CONSENT_INVALID");

    const first = await dispatch(request(validBody()));
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("vary"), "Cookie");
    assert.deepEqual(await first.json(), {
      consent,
      schemaVersion: "telemetry-contribution-v1.2",
    });
    const capabilityPath = `FROM ${table(primarySchema, "telemetry_v12_device_capabilities")}`;
    const firstStored = await primaryPool.query(
      `SELECT state, revoked_at, consented_at, telemetry_schema_version,
              field_dictionary_version, privacy_contract_version
         ${capabilityPath} WHERE participant_id = $1 AND device_id = $2`,
      [owner.participantId, owner.deviceId],
    );
    assert.equal(firstStored.rows.length, 1);
    assert.equal(firstStored.rows[0].state, "accepted");
    assert.equal(firstStored.rows[0].revoked_at, null);
    assert.equal(firstStored.rows[0].telemetry_schema_version, consent.telemetrySchemaVersion);
    assert.equal(firstStored.rows[0].field_dictionary_version, consent.fieldDictionaryVersion);
    assert.equal(firstStored.rows[0].privacy_contract_version, consent.privacyContractVersion);
    const originalConsentedAt = firstStored.rows[0].consented_at.toISOString();

    const replay = await dispatch(request(validBody()));
    assert.equal(replay.status, 201);
    const replayStored = await primaryPool.query(
      `SELECT count(*)::integer AS count, min(consented_at) AS consented_at
         ${capabilityPath} WHERE participant_id = $1 AND device_id = $2`,
      [owner.participantId, owner.deviceId],
    );
    assert.equal(replayStored.rows[0].count, 1);
    assert.equal(replayStored.rows[0].consented_at.toISOString(), originalConsentedAt,
      "an idempotent retry preserves the original consent timestamp");

    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_device_capabilities")}
          SET state = 'revoked', revoked_at = clock_timestamp()
        WHERE participant_id = $1 AND device_id = $2`,
      [owner.participantId, owner.deviceId],
    );
    assert.equal((await dispatch(request(validBody()))).status, 201,
      "a fresh explicit owner grant can reactivate a revoked capability");
    const reinstated = await primaryPool.query(
      `SELECT state, revoked_at, consented_at ${capabilityPath}
        WHERE participant_id = $1 AND device_id = $2`,
      [owner.participantId, owner.deviceId],
    );
    assert.equal(reinstated.rows[0].state, "accepted");
    assert.equal(reinstated.rows[0].revoked_at, null);
    assert.equal(reinstated.rows[0].consented_at.toISOString(), originalConsentedAt);

    await apiError(await dispatch(request(validBody(foreignOwner.deviceId))), 403, "TELEMETRY_TRANSPORT_BLOCKED");
    const foreignCapability = await primaryPool.query(
      `SELECT count(*)::integer AS count ${capabilityPath}
        WHERE device_id = $1`,
      [foreignOwner.deviceId],
    );
    assert.equal(foreignCapability.rows[0].count, 0,
      "the signed-in owner cannot grant consent to another participant's device");

    await primaryPool.query(
      `UPDATE ${table(primarySchema, "participants")}
          SET consent_version = 'privacy-safe-telemetry-v0.2' WHERE id = $1`,
      [owner.participantId],
    );
    await apiError(await dispatch(request(validBody())), 400, "TELEMETRY_REQUIRED");
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "participants")}
          SET consent_version = $2 WHERE id = $1`,
      [owner.participantId, TELEMETRY_CONSENT_VERSION],
    );

    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_typed_runtime")}
          SET state = 'staged', changed_at = clock_timestamp() WHERE id = 1`,
    );
    await apiError(await dispatch(request(validBody())), 403, "TELEMETRY_TRANSPORT_BLOCKED");
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_typed_runtime")}
          SET state = 'active', changed_at = clock_timestamp() WHERE id = 1`,
    );
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_runtime")}
          SET state = 'blocked', changed_at = clock_timestamp() WHERE id = 1`,
    );
    await apiError(await dispatch(request(validBody())), 403, "TELEMETRY_TRANSPORT_BLOCKED");
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "telemetry_v12_runtime")}
          SET state = 'active', changed_at = clock_timestamp() WHERE id = 1`,
    );

    await primaryPool.query(
      `UPDATE ${table(primarySchema, "collection_controls")}
          SET control_state = 'degraded', upload_registration_enabled = false,
              revision = revision + 1, updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );
    await apiError(await dispatch(request(validBody())), 503, "UPLOAD_REGISTRATION_DISABLED");
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "collection_controls")}
          SET control_state = 'operational', upload_registration_enabled = true,
              revision = revision + 1, updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );

    await ledgerAuthority.recordPostgresDeletionTombstone(
      ledgerPool,
      owner.participantId,
      Date.now(),
      { schema: { ledgerSchema } },
    );
    await apiError(await dispatch(request(validBody())), 401, "AUTH_INVALID");
    const finalStored = await primaryPool.query(
      `SELECT count(*)::integer AS count, min(consented_at) AS consented_at
         ${capabilityPath} WHERE participant_id = $1 AND device_id = $2`,
      [owner.participantId, owner.deviceId],
    );
    assert.equal(finalStored.rows[0].count, 1);
    assert.equal(finalStored.rows[0].consented_at.toISOString(), originalConsentedAt);
  } finally {
    if (primaryCreated) await primaryPool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    if (ledgerCreated) await ledgerPool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});
