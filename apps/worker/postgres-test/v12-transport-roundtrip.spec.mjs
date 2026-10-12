import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  canonicalTelemetryV12Json,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createTelemetryV12Day, runTelemetryV12Sync } from "../../../src/contribution/index.js";

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER ?? "postgres";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE ?? "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = "2026-09-24";

async function localEndpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "PostgreSQL transport tests require a loopback host or a private Unix socket");
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

function usageRecord(eventId, eventTime) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId,
    eventTime,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: 75,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

async function seedDevice({ pool, schema, nowEpoch, modules }) {
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 30 * 24 * 60 * 60_000).toISOString();
  const participantId = `synthetic-transport-${randomBytes(5).toString("hex")}`;
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const secret = randomBytes(32).toString("base64url");

  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1, 'social', 'active', $2, $3)`,
    [participantId, modules.TELEMETRY_CONSENT_VERSION, now],
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
    [pairingId, participantId, sessionId, randomBytes(32), modules.TELEMETRY_CONSENT_VERSION,
      now, expiresAt, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`,
    [deviceId, participantId, pairingId, bearerSecretHash(deviceId, secret), now, expiresAt],
  );
  await pool.query(
    `INSERT INTO ${q(schema, "telemetry_v12_device_capabilities")} (
       participant_id, device_id, telemetry_schema_version, field_dictionary_version,
       privacy_contract_version, state, consented_at
     ) VALUES ($1,$2,$3,$4,$5,'accepted',$6)`,
    [participantId, deviceId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, now],
  );
  await pool.query(`UPDATE ${q(schema, "telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  await pool.query(`UPDATE ${q(schema, "telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [now]);
  return {
    principal: { participantId, deviceId },
    authorization: `Device um_device_${deviceId}.${secret}`,
    nowEpoch,
    expiresAt,
    modules,
  };
}

async function seedAccountlessDevice({ pool, schema, nowEpoch, modules }) {
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + 30 * 24 * 60 * 60_000).toISOString();
  const participantId = `synthetic-accountless-${randomBytes(5).toString("hex")}`;
  const deviceId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO ${q(schema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1, 'accountless', 'active', NULL, $2)`,
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
     ) VALUES ($1,$2,$1,$3,$4,$5,$6,$7,'active')`,
    [deviceId, participantId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
      TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
      now, expiresAt],
  );
  return {
    principal: { participantId, deviceId },
    authorization: `Device um_device_${deviceId}.${secret}`,
    nowEpoch,
    expiresAt,
    modules,
  };
}

async function seedUploadGrant({ pool, schema, device, nowEpoch, modules, expiresAt }) {
  const authorizationId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const envelopeDigest = await modules.sha256Hex(`synthetic-envelope-${authorizationId}`);
  const bodyBytes = 4096;
  const grantExpiry = expiresAt ?? new Date(nowEpoch + 5 * 60_000).toISOString();
  await pool.query(
    `INSERT INTO ${q(schema, "device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'application/json','unused',$7,$8)`,
    [authorizationId, device.principal.participantId, device.principal.deviceId,
      uploadSecretHash(authorizationId, secret), envelopeDigest, bodyBytes,
      new Date(nowEpoch - 1000).toISOString(), grantExpiry],
  );
  return {
    authorizationId,
    authorization: `Upload um_device_upload_${authorizationId}.${secret}`,
    envelopeDigest,
    bodyBytes,
  };
}

test("PostgreSQL v1.2 authenticates a device and atomically claims a bounded one-use upload", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 60_000,
}, async () => {
  const endpoint = await localEndpoint();
  let pool;
  let vite;
  const schema = `v12_transport_${randomBytes(6).toString("hex")}`;
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
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "this qualification test requires PostgreSQL 17");
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
    const transport = await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts");
    const admission = await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts");
    const formatAuthority = await vite.ssrLoadModule("/src/postgres-telemetry-format-authority.ts");
    const crypto = await vite.ssrLoadModule("/src/crypto.ts");
    const constants = await vite.ssrLoadModule("/src/constants.ts");
    const modules = { ...transport, ...admission, ...formatAuthority, ...crypto, ...constants };

    const nowEpoch = Date.now();
    const device = await seedDevice({ pool, schema, nowEpoch, modules });
    const authenticated = await modules.authenticatePostgresDevice(
      pool, device.authorization, { ...options, nowEpoch },
    );
    assert.deepEqual(authenticated, {
      deviceId: device.principal.deviceId,
      participantId: device.principal.participantId,
      participantConsentVersion: modules.TELEMETRY_CONSENT_VERSION,
      expiresAt: new Date(nowEpoch + 30 * 24 * 60 * 60_000).toISOString(),
      credentialGeneration: 1,
      socialVerifiedAt: new Date(nowEpoch).toISOString(),
      authorityKind: "social",
    });
    await assert.rejects(
      modules.authenticatePostgresDevice(pool, `Upload ${device.authorization.slice("Device ".length)}`, { ...options, nowEpoch }),
      { code: "DEVICE_AUTH_INVALID" },
    );
    await assert.rejects(
      modules.authenticatePostgresDevice(pool, `Device um_device_${device.principal.deviceId}.${randomBytes(32).toString("base64url")}`, { ...options, nowEpoch }),
      { code: "DEVICE_AUTH_INVALID" },
    );
    await modules.assertPostgresTelemetryTransportWriteAllowed(
      pool, device.principal, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION, { ...options, nowEpoch },
    );
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version=$2 WHERE id=$1`,
      [device.principal.participantId, modules.ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION],
    );
    const stillAcceptedV12Capability = await pool.query(
      `SELECT state FROM ${q(schema, "telemetry_v12_device_capabilities")}
        WHERE participant_id=$1 AND device_id=$2`,
      [device.principal.participantId, device.principal.deviceId],
    );
    assert.equal(stillAcceptedV12Capability.rows[0]?.state, "accepted");
    await assert.rejects(
      modules.assertPostgresTelemetryTransportWriteAllowed(
        pool, device.principal, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION, { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_REQUIRED" },
    );
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version=$2 WHERE id=$1`,
      [device.principal.participantId, modules.TELEMETRY_CONSENT_VERSION],
    );

    const consent = telemetryV12RequiredConsent();
    const records = [usageRecord(`event:v2:${"a".repeat(64)}`, `${DAY}T12:05:00.000Z`)];
    const chunkId = `usage:${DAY}:0`;
    const parserVersion = "synthetic-pg-v12-transport";
    const chunkDigest = await modules.sha256Hex(canonicalTelemetryV12Json(records));
    const manifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day: DAY,
      parserVersion,
      consent,
      chunks: [{ chunkId, chunkDigest, recordCount: records.length }],
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = await modules.sha256Hex(telemetryV12DayManifestDigestInput(manifest));
    const chunk = {
      schemaVersion: "telemetry-contribution-v1.2",
      manifestDigest: manifest.manifestDigest,
      chunkId,
      chunkRevision: 1,
      chunkDigest,
      parserVersion,
      consent,
      records,
    };
    const candidate = await modules.registerPostgresTypedV12DayManifest(
      pool, device.principal, manifest, nowEpoch, options,
    );
    assert.equal(candidate.state, "staged");

    const consentMismatchGrant = await seedUploadGrant({ pool, schema, device, nowEpoch, modules });
    const consentMismatchClaim = await modules.claimPostgresDeviceUploadAuthorization(
      pool, consentMismatchGrant.authorization, {
        envelopeDigest: consentMismatchGrant.envelopeDigest,
        bodyBytes: consentMismatchGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch },
    );
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version=$2 WHERE id=$1`,
      [device.principal.participantId, modules.ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION],
    );
    await assert.rejects(
      modules.persistPostgresTypedV12StagedChunk(pool, device.principal, chunk, {
        chunkRowId: `chunk:${randomUUID()}`,
        r2Key: `synthetic/pg-v12-consent-mismatch-${randomBytes(8).toString("hex")}`,
        envelopeDigest: consentMismatchGrant.envelopeDigest,
        deviceUploadAuthorizationId: consentMismatchClaim.authorizationId,
      }, nowEpoch, options),
      { code: "TELEMETRY_REQUIRED" },
    );
    const unconsumedMismatchGrant = await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [consentMismatchGrant.authorizationId],
    );
    assert.equal(unconsumedMismatchGrant.rows[0]?.state, "consuming");
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version=$2 WHERE id=$1`,
      [device.principal.participantId, modules.TELEMETRY_CONSENT_VERSION],
    );

    const expiredGrant = await seedUploadGrant({
      pool, schema, device, nowEpoch, modules,
      expiresAt: new Date(nowEpoch - 1).toISOString(),
    });
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, expiredGrant.authorization, {
        envelopeDigest: expiredGrant.envelopeDigest,
        bodyBytes: expiredGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    for (const request of [
      { envelopeDigest: expiredGrant.envelopeDigest, bodyBytes: expiredGrant.bodyBytes, contentType: "text/plain" },
      { envelopeDigest: expiredGrant.envelopeDigest, bodyBytes: 0, contentType: "application/json" },
      { envelopeDigest: expiredGrant.envelopeDigest, bodyBytes: 2 * 1024 * 1024 + 1, contentType: "application/json" },
      { envelopeDigest: "f".repeat(64), bodyBytes: expiredGrant.bodyBytes, contentType: "application/json" },
    ]) {
      await assert.rejects(
        modules.claimPostgresDeviceUploadAuthorization(pool, expiredGrant.authorization, request, { ...options, nowEpoch }),
        { code: "UPLOAD_AUTH_INVALID" },
      );
    }
    const afterRejectedClaims = await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [expiredGrant.authorizationId],
    );
    assert.equal(afterRejectedClaims.rows[0].state, "unused");

    const grant = await seedUploadGrant({ pool, schema, device, nowEpoch, modules });
    const request = {
      envelopeDigest: grant.envelopeDigest,
      bodyBytes: grant.bodyBytes,
      contentType: "application/json",
    };
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, {
        ...request,
        bodyBytes: grant.bodyBytes + 1,
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, {
        ...request,
        envelopeDigest: "e".repeat(64),
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, {
        ...request,
        contentType: "text/plain",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    const wrongUploadSecret = `${grant.authorization.slice(0, grant.authorization.lastIndexOf(".") + 1)}${randomBytes(32).toString("base64url")}`;
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, wrongUploadSecret, request, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    const beforeAtomicClaim = await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [grant.authorizationId],
    );
    assert.equal(beforeAtomicClaim.rows[0].state, "unused");
    const competingClaims = await Promise.allSettled([
      modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, request, { ...options, nowEpoch }),
      modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, request, { ...options, nowEpoch }),
    ]);
    assert.equal(competingClaims.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(competingClaims.filter((entry) => entry.status === "rejected").length, 1);
    const claim = competingClaims.find((entry) => entry.status === "fulfilled").value;
    assert.deepEqual(claim, {
      authorizationId: grant.authorizationId,
      participantId: device.principal.participantId,
      authorizationKind: "device",
    });

    const chunkRowId = `chunk:${randomUUID()}`;
    const r2Key = `synthetic/pg-v12-transport-${randomBytes(8).toString("hex")}`;
    await pool.query(
      `INSERT INTO ${q(schema, "pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1,$2,'telemetry_v12')`,
      [chunkRowId, r2Key],
    );
    const persisted = await modules.persistPostgresTypedV12StagedChunk(pool, device.principal, chunk, {
      chunkRowId,
      r2Key,
      envelopeDigest: grant.envelopeDigest,
      deviceUploadAuthorizationId: claim.authorizationId,
    }, nowEpoch, options);
    assert.equal(persisted.replay, false);
    const state = await pool.query(
      `SELECT upload.state AS upload_state, manifest.state AS manifest_state,
              count(record.id)::integer AS typed_records
         FROM ${q(schema, "device_upload_authorizations")} upload
         JOIN ${q(schema, "telemetry_v12_day_manifests")} manifest ON manifest.id=$2
         LEFT JOIN ${q(schema, "telemetry_v12_typed_records")} record ON record.chunk_id=$3
        WHERE upload.id=$1
        GROUP BY upload.state, manifest.state`,
      [grant.authorizationId, candidate.manifestId, chunkRowId],
    );
    assert.deepEqual(state.rows[0], {
      upload_state: "consumed",
      manifest_state: "ready",
      typed_records: 1,
    });
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, request, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    assert.deepEqual(
      await modules.abandonPostgresDeviceUploadAuthorization(pool, claim, authenticated, { ...options, nowEpoch }),
      { abandoned: false },
    );

    const abandonedGrant = await seedUploadGrant({ pool, schema, device, nowEpoch, modules });
    const abandonedRequest = {
      envelopeDigest: abandonedGrant.envelopeDigest,
      bodyBytes: abandonedGrant.bodyBytes,
      contentType: "application/json",
    };
    const abandonedClaim = await modules.claimPostgresDeviceUploadAuthorization(
      pool, abandonedGrant.authorization, abandonedRequest, { ...options, nowEpoch },
    );
    assert.deepEqual(
      await modules.abandonPostgresDeviceUploadAuthorization(
        pool, abandonedClaim, authenticated, { ...options, nowEpoch },
      ),
      { abandoned: true },
    );
    assert.deepEqual(
      await modules.abandonPostgresDeviceUploadAuthorization(
        pool, abandonedClaim, authenticated, { ...options, nowEpoch },
      ),
      { abandoned: true },
    );
    const abandonedState = await pool.query(
      `SELECT state, consume_lease_expires_at
         FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [abandonedGrant.authorizationId],
    );
    assert.deepEqual(abandonedState.rows[0], {
      state: "revoked",
      consume_lease_expires_at: null,
    });
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(
        pool, abandonedGrant.authorization, abandonedRequest, { ...options, nowEpoch },
      ),
      { code: "UPLOAD_AUTH_INVALID" },
    );

    const raceDay = "2026-09-25";
    const raceRecords = [usageRecord(`event:v2:${"b".repeat(64)}`, `${raceDay}T12:15:00.000Z`)];
    const raceChunkId = `usage:${raceDay}:0`;
    const raceParserVersion = "synthetic-pg-v12-abandon-race";
    const raceChunkDigest = await modules.sha256Hex(canonicalTelemetryV12Json(raceRecords));
    const raceManifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day: raceDay,
      parserVersion: raceParserVersion,
      consent,
      chunks: [{ chunkId: raceChunkId, chunkDigest: raceChunkDigest, recordCount: 1 }],
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    raceManifest.manifestDigest = await modules.sha256Hex(
      telemetryV12DayManifestDigestInput(raceManifest),
    );
    const raceChunk = {
      schemaVersion: "telemetry-contribution-v1.2",
      manifestDigest: raceManifest.manifestDigest,
      chunkId: raceChunkId,
      chunkRevision: 1,
      chunkDigest: raceChunkDigest,
      parserVersion: raceParserVersion,
      consent,
      records: raceRecords,
    };
    const raceCandidate = await modules.registerPostgresTypedV12DayManifest(
      pool, device.principal, raceManifest, nowEpoch, options,
    );
    assert.equal(raceCandidate.state, "staged");
    const raceGrant = await seedUploadGrant({ pool, schema, device, nowEpoch, modules });
    const raceClaim = await modules.claimPostgresDeviceUploadAuthorization(
      pool, raceGrant.authorization, {
        envelopeDigest: raceGrant.envelopeDigest,
        bodyBytes: raceGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch },
    );
    const raceChunkRowId = `chunk:${randomUUID()}`;
    const raceR2Key = `synthetic/pg-v12-abandon-race-${randomBytes(8).toString("hex")}`;
    await pool.query(
      `INSERT INTO ${q(schema, "pending_objects")} (contribution_id, object_key, object_kind)
       VALUES ($1,$2,'telemetry_v12')`,
      [raceChunkRowId, raceR2Key],
    );
    let releaseRace;
    const raceStart = new Promise((resolve) => { releaseRace = resolve; });
    const abandonment = raceStart.then(() => modules.abandonPostgresDeviceUploadAuthorization(
      pool, raceClaim, authenticated, { ...options, nowEpoch },
    ));
    const persistence = raceStart.then(() => modules.persistPostgresTypedV12StagedChunk(
      pool, device.principal, raceChunk, {
        chunkRowId: raceChunkRowId,
        r2Key: raceR2Key,
        envelopeDigest: raceGrant.envelopeDigest,
        deviceUploadAuthorizationId: raceClaim.authorizationId,
      }, nowEpoch, options,
    ));
    releaseRace();
    const raceOutcomes = await Promise.allSettled([abandonment, persistence]);
    assert.equal(raceOutcomes[0].status, "fulfilled");
    const raceAbandonment = raceOutcomes[0].value;
    const racePersistence = raceOutcomes[1];
    const racedGrantState = await pool.query(
      `SELECT upload.state, upload.consumed_contribution_id,
              EXISTS (SELECT 1 FROM ${q(schema, "telemetry_v12_chunks")} chunk
                       WHERE chunk.device_upload_authorization_id = upload.id) AS referenced
         FROM ${q(schema, "device_upload_authorizations")} upload WHERE upload.id=$1`,
      [raceGrant.authorizationId],
    );
    if (raceAbandonment.abandoned) {
      assert.equal(racePersistence.status, "rejected");
      assert.equal(raceOutcomes[1].reason.code, "TELEMETRY_MANIFEST_CONFLICT");
      assert.deepEqual(racedGrantState.rows[0], {
        state: "revoked",
        consumed_contribution_id: null,
        referenced: false,
      });
    } else {
      assert.equal(racePersistence.status, "fulfilled");
      assert.equal(racePersistence.value.replay, false);
      assert.deepEqual(racedGrantState.rows[0], {
        state: "consumed",
        consumed_contribution_id: raceChunkRowId,
        referenced: true,
      });
    }

    const revokedGrant = await seedUploadGrant({ pool, schema, device, nowEpoch, modules });
    await pool.query(
      `UPDATE ${q(schema, "telemetry_v12_device_capabilities")}
          SET state='revoked', revoked_at=$3 WHERE participant_id=$1 AND device_id=$2`,
      [device.principal.participantId, device.principal.deviceId, new Date(nowEpoch).toISOString()],
    );
    await pool.query(
      `UPDATE ${q(schema, "device_credentials")} SET state='revoked', revoked_at=$2 WHERE id=$1`,
      [device.principal.deviceId, new Date(nowEpoch).toISOString()],
    );
    await assert.rejects(
      modules.authenticatePostgresDevice(pool, device.authorization, { ...options, nowEpoch }),
      { code: "DEVICE_AUTH_INVALID" },
    );
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, revokedGrant.authorization, {
        envelopeDigest: revokedGrant.envelopeDigest,
        bodyBytes: revokedGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );

    const accountless = await seedAccountlessDevice({ pool, schema, nowEpoch, modules });
    const accountlessPrincipal = await modules.authenticatePostgresDevice(
      pool, accountless.authorization, { ...options, nowEpoch },
    );
    assert.deepEqual(accountlessPrincipal, {
      deviceId: accountless.principal.deviceId,
      participantId: accountless.principal.participantId,
      participantConsentVersion: null,
      expiresAt: accountless.expiresAt,
      credentialGeneration: 1,
      socialVerifiedAt: null,
      authorityKind: "accountless",
    });
    const accountlessGrant = await seedUploadGrant({ pool, schema, device: accountless, nowEpoch, modules });
    const accountlessClaim = await modules.claimPostgresDeviceUploadAuthorization(
      pool, accountlessGrant.authorization, {
        envelopeDigest: accountlessGrant.envelopeDigest,
        bodyBytes: accountlessGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch },
    );
    assert.equal(accountlessClaim.authorizationId, accountlessGrant.authorizationId);
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version=$2 WHERE id=$1`,
      [accountless.principal.participantId, modules.TELEMETRY_CONSENT_VERSION],
    );
    await assert.rejects(
      modules.assertPostgresTelemetryTransportWriteAllowed(
        pool, accountless.principal, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION, { ...options, nowEpoch },
      ),
      { code: "TELEMETRY_REQUIRED" },
    );
    await pool.query(
      `UPDATE ${q(schema, "participants")} SET consent_version=NULL WHERE id=$1`,
      [accountless.principal.participantId],
    );

    const revokedSharedDevice = await seedAccountlessDevice({ pool, schema, nowEpoch, modules });
    const revokedSharedGrant = await seedUploadGrant({
      pool, schema, device: revokedSharedDevice, nowEpoch, modules,
    });
    await pool.query(
      `UPDATE ${q(schema, "accountless_v11_device_authorizations")}
          SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out'
        WHERE enrollment_device_id=$1`,
      [revokedSharedDevice.principal.deviceId, new Date(nowEpoch).toISOString()],
    );
    const stillActiveV12 = await pool.query(
      `SELECT state FROM ${q(schema, "accountless_v12_device_authorizations")}
        WHERE enrollment_device_id=$1`,
      [revokedSharedDevice.principal.deviceId],
    );
    assert.equal(stillActiveV12.rows[0]?.state, "active");
    await assert.rejects(
      modules.authenticatePostgresDevice(
        pool, revokedSharedDevice.authorization, { ...options, nowEpoch },
      ),
      { code: "DEVICE_AUTH_INVALID" },
    );
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, revokedSharedGrant.authorization, {
        envelopeDigest: revokedSharedGrant.envelopeDigest,
        bodyBytes: revokedSharedGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
    const revokedSharedGrantState = await pool.query(
      `SELECT state FROM ${q(schema, "device_upload_authorizations")} WHERE id=$1`,
      [revokedSharedGrant.authorizationId],
    );
    assert.equal(revokedSharedGrantState.rows[0]?.state, "unused");

    const revokedAccountlessGrant = await seedUploadGrant({ pool, schema, device: accountless, nowEpoch, modules });
    await pool.query(
      `UPDATE ${q(schema, "accountless_v12_device_authorizations")}
          SET state='revoked', revoked_at=$2, revocation_reason='user_opt_out'
        WHERE enrollment_device_id=$1`,
      [accountless.principal.deviceId, new Date(nowEpoch).toISOString()],
    );
    await assert.rejects(
      modules.authenticatePostgresDevice(pool, accountless.authorization, { ...options, nowEpoch }),
      { code: "DEVICE_AUTH_INVALID" },
    );
    await assert.rejects(
      modules.claimPostgresDeviceUploadAuthorization(pool, revokedAccountlessGrant.authorization, {
        envelopeDigest: revokedAccountlessGrant.envelopeDigest,
        bodyBytes: revokedAccountlessGrant.bodyBytes,
        contentType: "application/json",
      }, { ...options, nowEpoch }),
      { code: "UPLOAD_AUTH_INVALID" },
    );
  } finally {
    if (pool && schemaCreated) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch {}
    }
    if (pool) await pool.end();
    if (vite) await vite.close();
  }
});

test("PostgreSQL v1.2 reconciles imported staged replays for the strict desktop client through integrity checks", {
  skip: !PG_TEST_HOST && !PG_TEST_SOCKET,
  timeout: 60_000,
}, async () => {
  const endpoint = await localEndpoint();
  const pool = new pg.Pool({ ...endpoint, user: PG_TEST_USER, database: PG_TEST_DATABASE,
    password: PG_TEST_PASSWORD ?? "synthetic-local-only", ssl: false, max: 4, connectionTimeoutMillis: 3_000 });
  const schema = `v12_empty_replay_${randomBytes(6).toString("hex")}`;
  let created = false;
  let vite;
  try {
    const server = await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    vite = await createServer({ root: WORKER_ROOT, configFile: false,
      server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "silent" });
    const modules = {
      ...await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
      ...await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts"),
      ...await vite.ssrLoadModule("/src/crypto.ts"),
      ...await vite.ssrLoadModule("/src/constants.ts"),
    };
    const nowEpoch = Date.now();
    await seedDevice({ pool, schema, nowEpoch, modules }); // Activate both runtime mirrors.
    const owner = await seedAccountlessDevice({ pool, schema, nowEpoch, modules });
    const other = await seedAccountlessDevice({ pool, schema, nowEpoch, modules });
    const options = { schema: { primarySchema: schema } };
    const prepared = createTelemetryV12Day({ day: DAY, parserVersion: "synthetic-empty-replay", recordsByStream: {} });
    async function imported(manifest, device = owner, canonical = canonicalTelemetryV12Json(manifest)) {
      const id = randomUUID();
      await pool.query(`INSERT INTO ${q(schema, "telemetry_v12_day_manifests")} (
        id, participant_id, device_id, chunk_day, manifest_digest, parser_version,
        manifest_json, expected_chunk_count, state, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staged',$9)`,
      [id, device.principal.participantId, device.principal.deviceId, manifest.day, manifest.manifestDigest,
        manifest.parserVersion, canonical, manifest.chunks.length, new Date(nowEpoch).toISOString()]);
      return id;
    }
    const stored = async (id) => (await pool.query(`SELECT state, ready_at FROM ${q(schema, "telemetry_v12_day_manifests")} WHERE id=$1`, [id])).rows[0];
    const importedId = await imported(prepared.manifest);
    const foreignId = await imported(prepared.manifest, other);
    const origin = "http://127.0.0.1:8787";
    const calls = [];
    // Capabilities and activation are synthetic fixtures; manifest registration
    // is the real PostgreSQL transaction and the client retains every validator.
    const sync = (dayPrepared) => runTelemetryV12Sync({
      serverBaseUrl: origin, deviceAuthorization: owner.authorization,
      authorization: { schemaVersion: "accountless-upload-owner-v1.2",
        policyVersion: "accountless-telemetry-v1.2-policy-v1", authorizationBasis: "accountless-policy-v1.2",
        telemetrySchemaVersion: "telemetry-contribution-v1.2" },
      laboratory: true, days: [DAY], readDay: () => dayPrepared, clock: () => nowEpoch,
      createEnvelope: () => assert.fail("complete imported days never create an envelope"),
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push(path);
        let value;
        if (path.endsWith("/sync-capabilities-v1.2")) value = {
          schemaVersion: "device-sync-capabilities-v1.2", destinationOrigin: origin,
          enrollmentNamespace: "a".repeat(64), identityVersion: "account-track-v2", authorityKind: "accountless",
          successor: { schemaVersion: "telemetry-contribution-v1.2", envelopeSchemaVersion: "telemetry-envelope-v1.2",
            lifecycle: "accepted", requiredConsent: telemetryV12RequiredConsent(), consentCurrent: false,
            authorizationCurrent: true, activationTime: "2026-09-01T00:00:00.000Z" },
        };
        else if (path.endsWith("/domain-predecessor")) value = {
          schemaVersion: "telemetry-domain-predecessor-v1.2", token: randomUUID(), previousGenerationId: null,
          legacyFingerprint: "b".repeat(64), fromDay: DAY, throughDay: DAY,
          expiresAt: new Date(nowEpoch + 3_600_000).toISOString(),
        };
        else if (path.endsWith("/day-manifests")) {
          let candidate;
          try {
            candidate = await modules.registerPostgresTypedV12DayManifest(
              pool, owner.principal, JSON.parse(init.body), nowEpoch, options);
          } catch (error) {
            assert.ok(Number.isSafeInteger(error.status) && typeof error.code === "string");
            return Response.json({ error: { code: error.code, requestId: randomUUID() } },
              { status: error.status, headers: { "cache-control": "no-store" } });
          }
          const vector = await pool.query(`SELECT chunk_id AS "chunkId", chunk_digest AS "chunkDigest", record_count AS "recordCount"
            FROM ${q(schema, "telemetry_v12_chunks")} WHERE manifest_id=$1 ORDER BY stream, chunk_seq`, [candidate.manifestId]);
          value = { ...candidate, stagedChunks: vector.rows };
        }
        else if (path.endsWith("/domain-activate")) value = {
          schemaVersion: "telemetry-domain-activation-v1.2", generationId: randomUUID(),
          manifestDigest: JSON.parse(init.body).manifestDigest, fromDay: DAY, throughDay: DAY, replay: false,
        };
        else assert.fail("unexpected synthetic route");
        return Response.json(value, { status: 201, headers: { "cache-control": "no-store" } });
      },
    });
    const result = await sync(prepared);
    assert.equal(result.status, "complete", JSON.stringify(result.failure));
    assert.equal(calls.at(-1), "/api/v1/me/telemetry-v12/domain-activate");
    const ready = await stored(importedId);
    assert.equal(ready.state, "ready");
    assert.equal(ready.ready_at.toISOString(), new Date(nowEpoch).toISOString());
    assert.deepEqual(await stored(foreignId), { state: "staged", ready_at: null });
    const replays = await Promise.all([1, 2].map((offset) => modules.registerPostgresTypedV12DayManifest(
      pool, owner.principal, prepared.manifest, nowEpoch + offset, options)));
    assert.ok(replays.every((candidate) => candidate.manifestId === importedId && candidate.state === "ready"));
    assert.deepEqual(await stored(importedId), ready, "replays preserve the first ready timestamp");

    const fresh = createTelemetryV12Day({ day: DAY, parserVersion: "synthetic-new-empty", recordsByStream: {} });
    const inserted = await Promise.all([1, 2].map(() => modules.registerPostgresTypedV12DayManifest(
      pool, owner.principal, fresh.manifest, nowEpoch, options)));
    assert.equal(inserted[0].manifestId, inserted[1].manifestId);
    assert.ok(inserted.every((candidate) => candidate.state === "ready" && candidate.expectedChunks === 0));

    const incomplete = { ...prepared.manifest, chunks: [{ chunkId: `usage:${DAY}:0`, chunkDigest: "c".repeat(64), recordCount: 1 }] };
    incomplete.manifestDigest = createHash("sha256").update(telemetryV12DayManifestDigestInput(incomplete)).digest("hex");
    const incompleteId = await imported(incomplete);
    for (let replay = 0; replay < 2; replay += 1) {
      const candidate = await modules.registerPostgresTypedV12DayManifest(pool, owner.principal, incomplete, nowEpoch, options);
      assert.deepEqual({ id: candidate.manifestId, state: candidate.state, count: candidate.expectedChunks },
        { id: incompleteId, state: "staged", count: 1 });
    }
    assert.deepEqual(await stored(incompleteId), { state: "staged", ready_at: null });
    await assert.rejects(modules.registerPostgresTypedV12DayManifest(pool,
      { participantId: owner.principal.participantId, deviceId: other.principal.deviceId }, prepared.manifest, nowEpoch, options),
    { code: "DEVICE_AUTH_INVALID" });
    assert.deepEqual(await stored(foreignId), { state: "staged", ready_at: null });

    // Model the normalized transfer representation: admit a valid source day,
    // then copy its typed parent/child into an independently staged candidate
    // through live guards. No trigger disabling or ready-to-staged downgrade.
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    function usageDay(parserVersion) {
      const records = [usageRecord(`event:v2:${"d".repeat(64)}`, `${DAY}T12:05:00.000Z`)];
      const chunkDigest = digest(canonicalTelemetryV12Json(records));
      const manifest = { ...prepared.manifest, parserVersion,
        chunks: [{ chunkId: `usage:${DAY}:0`, chunkDigest, recordCount: 1 }] };
      manifest.manifestDigest = digest(telemetryV12DayManifestDigestInput(manifest));
      return { manifest, chunks: [{ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: manifest.manifestDigest,
        chunkId: `usage:${DAY}:0`, chunkRevision: 1, chunkDigest, parserVersion,
        consent: manifest.consent, records }] };
    }
    async function chunkAuthority() {
      const grant = await seedUploadGrant({ pool, schema, device: owner, nowEpoch, modules });
      const claim = await modules.claimPostgresDeviceUploadAuthorization(pool, grant.authorization, {
        envelopeDigest: grant.envelopeDigest, bodyBytes: grant.bodyBytes, contentType: "application/json",
      }, { ...options, nowEpoch, accountlessAuthorizationVersion: "v1.2" });
      const metadata = { chunkRowId: `chunk:${randomUUID()}`, r2Key: `synthetic/replay-${randomUUID()}`,
        envelopeDigest: grant.envelopeDigest, deviceUploadAuthorizationId: claim.authorizationId };
      await pool.query(`INSERT INTO ${q(schema, "pending_objects")} (contribution_id, object_key, object_kind)
        VALUES ($1,$2,'telemetry_v12')`, [metadata.chunkRowId, metadata.r2Key]);
      return metadata;
    }
    const source = usageDay("synthetic-admitted-replay-source");
    await modules.registerPostgresTypedV12DayManifest(pool, owner.principal, source.manifest, nowEpoch, options);
    const sourceMetadata = await chunkAuthority();
    await modules.persistPostgresTypedV12StagedChunk(pool, owner.principal, source.chunks[0], sourceMetadata, nowEpoch, options);
    const sourceRecordId = (await pool.query(`SELECT id FROM ${q(schema, "telemetry_v12_typed_records")}
      WHERE chunk_id=$1`, [sourceMetadata.chunkRowId])).rows[0].id;
    async function completeStaged(label, { chunkId, chunkDigest, copyParent = true, copyChild = true,
      canonicalDigest = null, recordIndex = 0, canonical = null, storedExpectedChunks = null, storedParser = null,
      rawRecord = false } = {}) {
      const dayPrepared = usageDay(`synthetic-complete-replay-${label}`);
      const manifestId = await imported(dayPrepared.manifest, owner, canonical ?? canonicalTelemetryV12Json(dayPrepared.manifest));
      const metadata = await chunkAuthority();
      await pool.query(`INSERT INTO ${q(schema, "telemetry_v12_chunks")} (
        id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq, chunk_id,
        chunk_digest, envelope_digest, parser_version, record_count, r2_key, device_upload_authorization_id, created_at
      ) VALUES ($1,$2,$3,$4,'usage',$5,$6,$7,$8,$9,$10,1,$11,$12,$13)`,
      [metadata.chunkRowId, manifestId, owner.principal.participantId, owner.principal.deviceId, DAY,
        chunkId ? 1 : 0, chunkId ?? dayPrepared.chunks[0].chunkId, chunkDigest ?? dayPrepared.chunks[0].chunkDigest,
        metadata.envelopeDigest, dayPrepared.manifest.parserVersion, metadata.r2Key,
        metadata.deviceUploadAuthorizationId, new Date(nowEpoch).toISOString()]);
      if (copyParent) {
        const recordId = (await pool.query(`INSERT INTO ${q(schema, "telemetry_v12_typed_records")} (
          chunk_id, manifest_id, stream, record_index, occurrence_id, observed_at_ms, observed_day, provider_id, canonical_digest
        ) SELECT $1,$2,stream,$3,occurrence_id,observed_at_ms,observed_day,provider_id,COALESCE($4::bytea,canonical_digest)
          FROM ${q(schema, "telemetry_v12_typed_records")} WHERE id=$5 RETURNING id`,
        [metadata.chunkRowId, manifestId, recordIndex, canonicalDigest, sourceRecordId])).rows[0].id;
        if (copyChild) await pool.query(`INSERT INTO ${q(schema, "telemetry_v12_typed_usage")} (
          record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id, billing_surface_id,
          reasoning_effort_id, agent_scope_id, outcome_id, attribution_id, total_input_context_tokens,
          input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens,
          output_reasoning_tokens, output_combined_tokens, boundary_flags, tie_order,
          cache_write_ttl_five_minute_tokens, cache_write_ttl_one_hour_tokens
        ) SELECT $1,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
          reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
          input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
          output_reasoning_tokens,output_combined_tokens,boundary_flags,tie_order,
          cache_write_ttl_five_minute_tokens,cache_write_ttl_one_hour_tokens
          FROM ${q(schema, "telemetry_v12_typed_usage")} WHERE record_id=$2`, [recordId, sourceRecordId]);
      }
      if (storedExpectedChunks !== null || storedParser !== null) await pool.query(
        `UPDATE ${q(schema, "telemetry_v12_day_manifests")}
          SET expected_chunk_count=COALESCE($2,expected_chunk_count), parser_version=COALESCE($3,parser_version)
          WHERE id=$1`, [manifestId, storedExpectedChunks, storedParser]);
      if (rawRecord) await pool.query(`INSERT INTO ${q(schema, "telemetry_v12_records")} (
        chunk_id, manifest_id, stream, occurrence_id, observed_at, record_json
      ) VALUES ($1,$2,'usage',$3,$4,$5)`, [metadata.chunkRowId, manifestId, source.chunks[0].records[0].eventId,
        source.chunks[0].records[0].eventTime, canonicalTelemetryV12Json(source.chunks[0].records[0])]);
      return { ...dayPrepared, manifestId };
    }
    const complete = await completeStaged("valid");
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM ${q(schema, "telemetry_v12_day_manifests")}) AS manifests,
      (SELECT count(*) FROM ${q(schema, "telemetry_v12_chunks")}) AS chunks,
      (SELECT count(*) FROM ${q(schema, "telemetry_v12_typed_records")}) AS records`)).rows[0];
    const beforeCounts = await counts();
    const createdAt = (await pool.query(`SELECT created_at FROM ${q(schema, "telemetry_v12_day_manifests")} WHERE id=$1`,
      [complete.manifestId])).rows[0].created_at;
    const completeResult = await sync({ manifest: complete.manifest, chunks: complete.chunks });
    assert.equal(completeResult.status, "complete", JSON.stringify(completeResult.failure));
    const completeReady = await stored(complete.manifestId);
    assert.equal(completeReady.state, "ready");
    assert.equal(completeReady.ready_at.toISOString(), new Date(nowEpoch).toISOString());
    assert.deepEqual(await counts(), beforeCounts, "reconciliation changes state only");
    assert.deepEqual((await pool.query(`SELECT created_at FROM ${q(schema, "telemetry_v12_day_manifests")} WHERE id=$1`,
      [complete.manifestId])).rows[0].created_at, createdAt);
    const completeReplays = await Promise.all([1, 2].map((offset) => modules.registerPostgresTypedV12DayManifest(
      pool, owner.principal, complete.manifest, nowEpoch + offset, options)));
    assert.ok(completeReplays.every((candidate) => candidate.manifestId === complete.manifestId && candidate.state === "ready"));
    assert.deepEqual(await stored(complete.manifestId), completeReady);

    for (const [label, changes, code] of [
      ["membership", { chunkId: `usage:${DAY}:1` }, "TELEMETRY_MANIFEST_CONFLICT"],
      ["chunk-digest", { chunkDigest: "e".repeat(64) }, "TELEMETRY_MANIFEST_CONFLICT"],
      ["record-digest", { canonicalDigest: Buffer.from("f".repeat(64), "hex") }, "BACKEND_STORAGE_UNAVAILABLE"],
      ["record-index", { recordIndex: 1 }, "TELEMETRY_MANIFEST_CONFLICT"],
      ["missing-child", { copyChild: false }, "BACKEND_STORAGE_UNAVAILABLE"],
      ["missing-record", { copyParent: false }, "TELEMETRY_MANIFEST_INCOMPLETE"],
      ["stored-count", { storedExpectedChunks: 2 }, "TELEMETRY_MANIFEST_CONFLICT"],
      ["stored-parser", { storedParser: "synthetic-mismatched-parser" }, "TELEMETRY_MANIFEST_CONFLICT"],
      ["stored-canonical", { canonical: canonicalTelemetryV12Json(prepared.manifest) }, "TELEMETRY_MANIFEST_CONFLICT"],
      ["raw-only", { copyParent: false, rawRecord: true }, "TELEMETRY_MANIFEST_INCOMPLETE"],
      ["mixed-storage", { rawRecord: true }, "TELEMETRY_MANIFEST_CONFLICT"],
    ]) {
      const rejected = await completeStaged(label, changes);
      await assert.rejects(modules.registerPostgresTypedV12DayManifest(
        pool, owner.principal, rejected.manifest, nowEpoch, options), { code });
      assert.deepEqual(await stored(rejected.manifestId), { state: "staged", ready_at: null }, label);
      if (label === "missing-record" || label === "raw-only") {
        const refused = await sync({ manifest: rejected.manifest, chunks: rejected.chunks });
        assert.equal(refused.status, "failed");
        assert.deepEqual({ code: refused.failure.code, retryable: refused.failure.retryable },
          { code: "revision_conflict", retryable: true });
        assert.deepEqual(await stored(rejected.manifestId), { state: "staged", ready_at: null });
      }
    }
    const unowned = await completeStaged("authority-refused");
    await assert.rejects(modules.registerPostgresTypedV12DayManifest(pool, owner.principal,
      { ...unowned.manifest, manifestDigest: "0".repeat(64) }, nowEpoch, options), { code: "CHUNK_DIGEST_MISMATCH" });
    assert.deepEqual(await stored(unowned.manifestId), { state: "staged", ready_at: null });
    await assert.rejects(modules.registerPostgresTypedV12DayManifest(pool,
      { participantId: other.principal.participantId, deviceId: owner.principal.deviceId }, unowned.manifest, nowEpoch, options),
    { code: "DEVICE_AUTH_INVALID" });
    assert.deepEqual(await stored(unowned.manifestId), { state: "staged", ready_at: null });
  } finally {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
    await vite?.close();
  }
});
