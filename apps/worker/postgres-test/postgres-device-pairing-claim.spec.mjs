import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTestDevicePairingClaimDispatch } from "../cloud-run/postgres-test-dispatch.mjs";

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

function expectApiError(response, status, code) {
  assert.equal(response.status, status);
  return response.json().then((body) => {
    assert.equal(body?.error?.code, code);
    assert.match(body?.error?.requestId ?? "", /^[0-9a-f-]{36}$/u);
  });
}

test("Cloud Run PostgreSQL pairing claim preserves one-use, consent, replay, continuity, and limits", {
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
  const primaryPool = new pg.Pool({ ...poolOptions, application_name: "pg-pair-claim-primary-test" });
  const ledgerPool = new pg.Pool({ ...poolOptions, application_name: "pg-pair-claim-ledger-test" });
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `pair_claim_${suffix}`;
  const ledgerSchema = `pair_claim_l_${suffix}`;
  const schemaOptions = { primarySchema, ledgerSchema };
  let primaryCreated = false;
  let ledgerCreated = false;
  try {
    const server = await primaryPool.query(
      "SELECT current_setting('server_version_num')::integer AS version, inet_server_addr() AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17,
      "pairing claim qualification requires PostgreSQL 17");
    assert.equal(server.rows[0].address, null,
      "pairing claim qualification requires the private local Unix socket");
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

    const claimModule = await vite.ssrLoadModule("/src/postgres-device-pairing-claim.ts");
    const issueModule = await vite.ssrLoadModule("/src/postgres-device-pairing.ts");
    const sessionModule = await vite.ssrLoadModule("/src/session.ts");
    const authModule = await vite.ssrLoadModule("/src/device-auth.ts");
    const cryptoModule = await vite.ssrLoadModule("/src/crypto.ts");
    const constants = await vite.ssrLoadModule("/src/constants.ts");
    const boundedBody = await vite.ssrLoadModule("/src/bounded-body.ts");
    const ledgerAuthority = await vite.ssrLoadModule("/src/postgres-ledger-authority.ts");
    const newOwner = async (label, nowEpoch = Date.now()) => {
      const participantId = `${label}-${suffix}`;
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
      return { participantId, session, nowEpoch };
    };
    const owner = await newOwner("claim-owner");
    const controls = async () => new Response(null, { status: 200 });
    const createDispatch = (claimPostgresDevicePairing = claimModule.claimPostgresDevicePairing) => (
      createPostgresTestDevicePairingClaimDispatch({
        primaryPool,
        ledgerPool,
        schemaOptions,
        claimPostgresDevicePairing,
        healthDispatch: controls,
        readBoundedRequestBody: boundedBody.readBoundedRequestBody,
        maxRequestBytes: constants.MAX_REQUEST_BYTES,
        privateOrigin: PRIVATE_ORIGIN,
      })
    );
    const dispatch = createDispatch();
    const wrongPrivateOrigin = await dispatch(new Request(
      "https://attacker.example/api/v1/device-pairings/claim",
      { method: "POST" },
    ));
    assert.equal(wrongPrivateOrigin.status, 503);
    assert.equal((await wrongPrivateOrigin.json()).error, "POSTGRES_TEST_ROUTE_UNSUPPORTED");
    const issue = (participantId, session, nowEpoch, transportConsentVersion = ONGOING_INCREMENTAL_CONSENT_VERSION) => (
      issueModule.createPostgresDevicePairing(
        primaryPool,
        participantId,
        session.id,
        TELEMETRY_CONSENT_VERSION,
        transportConsentVersion,
        { schema: { primarySchema }, nowEpoch },
      )
    );
    const claimRequest = ({ pairingCode, deviceId, secretHash, previousAuthorization, cookie, method, rawBody } = {}) => {
      const body = { deviceId, deviceSecretHash: secretHash };
      return new Request(`${PRIVATE_ORIGIN}/api/v1/device-pairings/claim`, {
        method: method ?? "POST",
        headers: {
          ...(pairingCode === undefined ? {} : { authorization: `Pairing ${pairingCode}` }),
          ...(cookie === undefined ? {} : { cookie }),
          ...(previousAuthorization === undefined ? {} : {
            "x-previous-device-authorization": previousAuthorization,
          }),
          "content-type": "application/json",
        },
        ...(method === "GET" ? {} : { body: rawBody ?? JSON.stringify(body) }),
      });
    };
    const credential = async (deviceId) => {
      const result = await primaryPool.query(
        `SELECT participant_id, paired_via_pairing_id, authority_kind,
                secret_hash, state, issued_at, expires_at, last_used_at,
                social_verified_at, credential_generation
           FROM ${table(primarySchema, "device_credentials")}
          WHERE id = $1`,
        [deviceId],
      );
      return result.rows[0] ?? null;
    };
    const freshSecret = async (deviceId) => {
      const secret = cryptoModule.encodeBase64Url(randomBytes(32));
      const hash = await authModule.deviceHash(deviceId, secret);
      return { secret, hashHex: Buffer.from(hash).toString("hex") };
    };

    const firstPairing = await issue(owner.participantId, owner.session, owner.nowEpoch);
    const firstDeviceId = randomUUID();
    const firstSecret = await freshSecret(firstDeviceId);
    await expectApiError(await dispatch(claimRequest({
      deviceId: firstDeviceId,
      secretHash: firstSecret.hashHex,
    })), 401, "PAIRING_AUTH_INVALID");
    await expectApiError(await dispatch(claimRequest({
      pairingCode: firstPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: firstSecret.hashHex,
      cookie: "",
    })), 401, "PAIRING_AUTH_INVALID");
    await expectApiError(await dispatch(claimRequest({
      pairingCode: firstPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: firstSecret.hashHex,
      rawBody: JSON.stringify({ deviceId: firstDeviceId, deviceSecretHash: firstSecret.hashHex, extra: true }),
    })), 400, "BODY_INVALID");
    await expectApiError(await dispatch(claimRequest({
      pairingCode: firstPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: firstSecret.hashHex,
      method: "GET",
    })), 405, "METHOD_NOT_ALLOWED");
    const wrongContentType = claimRequest({
      pairingCode: firstPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: firstSecret.hashHex,
    });
    wrongContentType.headers.set("content-type", "text/plain");
    await expectApiError(await dispatch(wrongContentType), 415, "CONTENT_TYPE_INVALID");

    const firstRequest = () => claimRequest({
      pairingCode: firstPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: firstSecret.hashHex,
    });
    const firstClaimStarted = Date.now();
    const [firstResponse, concurrentResponse] = await Promise.all([
      dispatch(firstRequest()), dispatch(firstRequest()),
    ]);
    assert.equal(firstResponse.status, 201);
    assert.equal(concurrentResponse.status, 201);
    const firstResult = await firstResponse.json();
    assert.deepEqual(await concurrentResponse.json(), firstResult);
    assert.deepEqual(Object.keys(firstResult).sort(), ["deviceId", "expiresAt", "scope", "state"]);
    assert.equal(firstResult.deviceId, firstDeviceId);
    assert.equal(firstResult.state, "active");
    assert.equal(firstResult.scope, "upload_registration");
    assert.ok(Date.parse(firstResult.expiresAt)
      >= firstClaimStarted + constants.DEVICE_CREDENTIAL_TTL_MILLISECONDS);
    assert.ok(Date.parse(firstResult.expiresAt)
      <= Date.now() + constants.DEVICE_CREDENTIAL_TTL_MILLISECONDS);
    const firstRow = await credential(firstDeviceId);
    assert.equal(firstRow.participant_id, owner.participantId);
    assert.equal(firstRow.paired_via_pairing_id, firstPairing.pairingCode.slice(8, 44));
    assert.equal(firstRow.authority_kind, "social");
    assert.equal(firstRow.state, "active");
    assert.equal(firstRow.credential_generation, 1);
    assert.deepEqual(firstRow.secret_hash, Buffer.from(firstSecret.hashHex, "hex"));
    const granted = await primaryPool.query(
      `SELECT telemetry_schema_version, field_dictionary_version,
              privacy_contract_version, consented_at
         FROM ${table(primarySchema, "telemetry_v1_device_consents")}
        WHERE participant_id = $1 AND device_id = $2`,
      [owner.participantId, firstDeviceId],
    );
    assert.deepEqual(granted.rows[0], {
      telemetry_schema_version: "telemetry-contribution-v1.0",
      field_dictionary_version: constants.INCREMENTAL_TELEMETRY_FIELD_DICTIONARY_VERSION,
      privacy_contract_version: ONGOING_INCREMENTAL_CONSENT_VERSION,
      consented_at: firstRow.issued_at,
    });
    const replay = await dispatch(firstRequest());
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), firstResult);
    const differentDeviceId = randomUUID();
    await expectApiError(await dispatch(claimRequest({
      pairingCode: firstPairing.pairingCode,
      deviceId: differentDeviceId,
      secretHash: (await freshSecret(differentDeviceId)).hashHex,
    })), 401, "PAIRING_AUTH_INVALID");

    const continuityPairing = await issue(owner.participantId, owner.session, Date.now());
    const replacement = await freshSecret(firstDeviceId);
    const continuityRequest = (previousAuthorization) => claimRequest({
      pairingCode: continuityPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: replacement.hashHex,
      previousAuthorization,
    });
    await expectApiError(await dispatch(claimRequest({
      pairingCode: continuityPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: replacement.hashHex,
    })), 409, "DEVICE_CONTINUITY_REQUIRED");
    await primaryPool.query(
      `INSERT INTO ${table(primarySchema, "device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,100,'application/json','unused',$6::timestamptz,$7::timestamptz)`,
      [randomUUID(), owner.participantId, firstDeviceId, randomBytes(32), "b".repeat(64),
        new Date().toISOString(), new Date(Date.now() + 5 * 60_000).toISOString()],
    );
    const oldAuthorization = `Device um_device_${firstDeviceId}.${firstSecret.secret}`;
    const continuityResponse = await dispatch(continuityRequest(oldAuthorization));
    assert.equal(continuityResponse.status, 201);
    const continuityResult = await continuityResponse.json();
    assert.equal(continuityResult.deviceId, firstDeviceId);
    const rotated = await credential(firstDeviceId);
    assert.equal(rotated.credential_generation, 2);
    assert.equal(rotated.paired_via_pairing_id, continuityPairing.pairingCode.slice(8, 44));
    assert.deepEqual(rotated.secret_hash, Buffer.from(replacement.hashHex, "hex"));
    const upload = await primaryPool.query(
      `SELECT state, consume_lease_expires_at FROM ${table(primarySchema, "device_upload_authorizations")}
        WHERE issued_by_device_id = $1`,
      [firstDeviceId],
    );
    assert.equal(upload.rows.length, 1);
    assert.equal(upload.rows[0].state, "revoked");
    assert.equal(upload.rows[0].consume_lease_expires_at, null);
    const continuityReplay = await dispatch(continuityRequest(oldAuthorization));
    assert.equal(continuityReplay.status, 201);
    assert.deepEqual(await continuityReplay.json(), continuityResult);
    assert.equal((await credential(firstDeviceId)).credential_generation, 2);

    const wrongProofPairing = await issue(owner.participantId, owner.session, Date.now());
    const wrongSecret = cryptoModule.encodeBase64Url(randomBytes(32));
    await expectApiError(await dispatch(claimRequest({
      pairingCode: wrongProofPairing.pairingCode,
      deviceId: firstDeviceId,
      secretHash: (await freshSecret(firstDeviceId)).hashHex,
      previousAuthorization: `Device um_device_${firstDeviceId}.${wrongSecret}`,
    })), 401, "PAIRING_AUTH_INVALID");
    const untouched = await primaryPool.query(
      `SELECT state FROM ${table(primarySchema, "device_pairings")} WHERE id = $1`,
      [wrongProofPairing.pairingCode.slice(8, 44)],
    );
    assert.equal(untouched.rows[0].state, "unused");
    assert.equal((await credential(firstDeviceId)).credential_generation, 2);

    const legacyOwner = await newOwner("claim-legacy-owner");
    const legacyPairing = await issue(
      legacyOwner.participantId, legacyOwner.session, legacyOwner.nowEpoch,
      constants.ONGOING_TELEMETRY_CONSENT_VERSION,
    );
    const legacyDeviceId = randomUUID();
    const legacySecret = await freshSecret(legacyDeviceId);
    assert.equal((await dispatch(claimRequest({
      pairingCode: legacyPairing.pairingCode,
      deviceId: legacyDeviceId,
      secretHash: legacySecret.hashHex,
    }))).status, 201);
    const legacyConsent = await primaryPool.query(
      `SELECT count(*)::integer AS count FROM ${table(primarySchema, "telemetry_v1_device_consents")}
        WHERE participant_id = $1 AND device_id = $2`,
      [legacyOwner.participantId, legacyDeviceId],
    );
    assert.equal(legacyConsent.rows[0].count, 0);

    const expiredOwner = await newOwner("claim-expired-owner");
    const expiredPairing = await issue(expiredOwner.participantId, expiredOwner.session, expiredOwner.nowEpoch);
    await primaryPool.query(
      `UPDATE ${table(primarySchema, "device_pairings")}
          SET expires_at = $2::timestamptz WHERE id = $1`,
      [expiredPairing.pairingCode.slice(8, 44), new Date(Date.now() - 1_000).toISOString()],
    );
    const expiredDeviceId = randomUUID();
    const expiredSecret = await freshSecret(expiredDeviceId);
    await expectApiError(await dispatch(claimRequest({
      pairingCode: expiredPairing.pairingCode,
      deviceId: expiredDeviceId,
      secretHash: expiredSecret.hashHex,
    })), 401, "PAIRING_AUTH_INVALID");

    const erasedOwner = await newOwner("claim-erased-owner");
    const erasedPairing = await issue(erasedOwner.participantId, erasedOwner.session, erasedOwner.nowEpoch);
    await ledgerAuthority.recordPostgresDeletionTombstone(
      ledgerPool, erasedOwner.participantId, Date.now(), { schema: { primarySchema, ledgerSchema } },
    );
    const erasedDeviceId = randomUUID();
    const erasedSecret = await freshSecret(erasedDeviceId);
    await expectApiError(await dispatch(claimRequest({
      pairingCode: erasedPairing.pairingCode,
      deviceId: erasedDeviceId,
      secretHash: erasedSecret.hashHex,
    })), 401, "PAIRING_AUTH_INVALID");

    const capOwner = await newOwner("claim-cap-owner", Date.now() - 15 * 60_000);
    const capPairing = await issue(capOwner.participantId, capOwner.session, Date.now());
    for (let index = 0; index < authModule.DEFAULT_DEVICE_LIFECYCLE_POLICY.activeDeviceLimit; index += 1) {
      const existingDeviceId = randomUUID();
      const existingPairingId = randomUUID();
      const issuedAt = new Date(capOwner.nowEpoch - 3 * 86_400_000).toISOString();
      const pairingExpiry = new Date(Date.parse(issuedAt) + constants.DEVICE_PAIRING_TTL_MILLISECONDS).toISOString();
      const credentialExpiry = new Date(Date.now() + constants.DEVICE_CREDENTIAL_TTL_MILLISECONDS).toISOString();
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "device_pairings")} (
           id, participant_id, issued_by_session_id, secret_hash, consent_version,
           transport_consent_version, state, issued_at, expires_at, consumed_at,
           claimed_device_id
         ) VALUES ($1,$2,$3,$4,'ongoing-privacy-safe-telemetry-v0.1',
                   'ongoing-privacy-safe-telemetry-v0.1','consumed',$5::timestamptz,
                   $6::timestamptz,$5::timestamptz,$7)`,
        [existingPairingId, capOwner.participantId, capOwner.session.id, randomBytes(32),
          issuedAt, pairingExpiry, existingDeviceId],
      );
      await primaryPool.query(
        `INSERT INTO ${table(primarySchema, "device_credentials")} (
           id, participant_id, authority_kind, paired_via_pairing_id,
           secret_hash, state, issued_at, expires_at, last_used_at, social_verified_at
         ) VALUES ($1,$2,'social',$3,$4,'active',$5::timestamptz,
                   $6::timestamptz,$7::timestamptz,$5::timestamptz)`,
        [existingDeviceId, capOwner.participantId, existingPairingId, randomBytes(32),
          issuedAt, credentialExpiry, new Date(Date.now()).toISOString()],
      );
    }
    const capDeviceId = randomUUID();
    const capSecret = await freshSecret(capDeviceId);
    await expectApiError(await dispatch(claimRequest({
      pairingCode: capPairing.pairingCode,
      deviceId: capDeviceId,
      secretHash: capSecret.hashHex,
    })), 401, "PAIRING_AUTH_INVALID");
    const capState = await primaryPool.query(
      `SELECT count(*) FILTER (WHERE state = 'active')::integer AS active,
              count(*) FILTER (WHERE paired_via_pairing_id = $2)::integer AS new_device
         FROM ${table(primarySchema, "device_credentials")}
        WHERE participant_id = $1`,
      [capOwner.participantId, capPairing.pairingCode.slice(8, 44)],
    );
    assert.deepEqual(capState.rows[0], { active: 3, new_device: 0 });

    const rateOwner = await newOwner("claim-rate-owner");
    const [ratePairingOne, ratePairingTwo] = await Promise.all([
      issue(rateOwner.participantId, rateOwner.session, rateOwner.nowEpoch),
      issue(rateOwner.participantId, rateOwner.session, rateOwner.nowEpoch),
    ]);
    const limitedDispatch = createDispatch((...args) => {
      const options = args[6] ?? {};
      return claimModule.claimPostgresDevicePairing(
        ...args.slice(0, 6),
        { ...options, policy: { pairingClaimLimit: 1 } },
      );
    });
    const firstRateDeviceId = randomUUID();
    const firstRateSecret = await freshSecret(firstRateDeviceId);
    assert.equal((await limitedDispatch(claimRequest({
      pairingCode: ratePairingOne.pairingCode,
      deviceId: firstRateDeviceId,
      secretHash: firstRateSecret.hashHex,
    }))).status, 201);
    const overLimitDeviceId = randomUUID();
    const overLimitSecret = await freshSecret(overLimitDeviceId);
    await expectApiError(await limitedDispatch(claimRequest({
      pairingCode: ratePairingTwo.pairingCode,
      deviceId: overLimitDeviceId,
      secretHash: overLimitSecret.hashHex,
    })), 429, "LIFECYCLE_BOUNDS_EXCEEDED");
    const rateOwnerDevices = await primaryPool.query(
      `SELECT count(*)::integer AS count FROM ${table(primarySchema, "device_credentials")}
        WHERE participant_id = $1`,
      [rateOwner.participantId],
    );
    assert.equal(rateOwnerDevices.rows[0].count, 1);
  } finally {
    if (primaryCreated) await primaryPool.query(`DROP SCHEMA IF EXISTS "${primarySchema}" CASCADE`);
    if (ledgerCreated) await ledgerPool.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
    await Promise.all([primaryPool.end(), ledgerPool.end()]);
  }
});
