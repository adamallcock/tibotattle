#!/usr/bin/env node

import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import { GoogleAuth } from "google-auth-library";
import {
  canonicalTelemetryV12Json,
  TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION,
  TELEMETRY_V12_FIELD_DICTIONARY_VERSION,
  TELEMETRY_V12_PRIVACY_CONTRACT_VERSION,
  parseTelemetryV12Chunk,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  validateTelemetryV12Envelope,
} from "@app-usagemonitor/telemetry-contract";
import { TELEMETRY_CONSENT_VERSION } from "../src/constants.ts";
import {
  closeCloudSqlResources,
  createIamPool,
  createGoogleAccessTokenProvider,
  normalizeIamUser,
} from "./cloud-sql.mjs";
import { CLOUD_RUN_IAM_TEST_TARGET } from "./postgres-test-dispatch.mjs";

export const SYNTHETIC_V12_SMOKE_JOB = "tibotattle-v12-smoke";
export const SYNTHETIC_V12_SMOKE_BUCKET = CLOUD_RUN_IAM_TEST_TARGET.gcsBucket;
export const SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX = "synthetic-v12-smoke-";
export const SYNTHETIC_V12_SMOKE_DATABASE_TARGET = Object.freeze({
  primaryDatabase: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.database,
  primarySchema: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.schema,
  primaryInstance: CLOUD_RUN_IAM_TEST_TARGET.postgres.primary.instanceConnectionName,
  ledgerDatabase: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.database,
  ledgerSchema: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.schema,
  ledgerInstance: CLOUD_RUN_IAM_TEST_TARGET.postgres.ledger.instanceConnectionName,
  postgresIamUser: CLOUD_RUN_IAM_TEST_TARGET.postgres.iamUser,
});
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;
const DATABASE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const INSTANCE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTRIBUTION_ID_PATTERN = /^chunk:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_EXECUTION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const SMOKE_ORIGIN = CLOUD_RUN_IAM_TEST_TARGET.origin;
const GCS_MEDIA_ORIGIN = "https://storage.googleapis.com";
const MAX_ENVELOPE_BYTES = 2_100_000;
const MAX_HTTP_REQUEST_BYTES = MAX_ENVELOPE_BYTES + 16_384;
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const MAX_EFFECTIVE_RECORD_BYTES = 64 * 1024;
const MANIFEST_PATH = "/api/v1/device/telemetry/v1.2/day-manifests";
const GRANT_PATH = "/api/v1/device/upload-authorizations";
const CHUNK_PATH = "/api/v1/contributions";
const SYNC_STATE_PATH = "/api/v1/device/sync/state";
const DOMAIN_PREDECESSOR_PATH = "/api/v1/me/telemetry-v12/domain-predecessor";
const DOMAIN_ACTIVATE_PATH = "/api/v1/me/telemetry-v12/domain-activate";
const encoder = new TextEncoder();

function fail(code, extras = {}) {
  throw Object.assign(new Error(code), { code, ...extras });
}

function required(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || !pattern.test(value)) {
    fail(`${name}_INVALID`);
  }
  return value;
}

function requiredDay(value) {
  required(value, "SYNTHETIC_V12_SMOKE_DAY", DAY_PATTERN);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail("SYNTHETIC_V12_SMOKE_DAY_INVALID");
  }
  return value;
}

function publicJwkFrom(value) {
  let jwk;
  try { jwk = JSON.parse(value); } catch { fail("ENVELOPE_PUBLIC_JWK_INVALID"); }
  const privateNames = ["d", "p", "q", "dp", "dq", "qi", "oth"];
  if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)
      || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string"
      || typeof jwk.kid !== "string" || jwk.kid.length < 1 || jwk.kid.length > 128
      || privateNames.some((name) => Object.hasOwn(jwk, name))) {
    fail("ENVELOPE_PUBLIC_JWK_INVALID");
  }
  return Object.freeze(jwk);
}

/** Validate the one-use job contract before reading any credential material. */
export function parseSyntheticV12SmokeConfig(env) {
  if (env === null || typeof env !== "object") fail("SMOKE_CONFIGURATION_INVALID");
  if (env.CLOUD_RUN_JOB !== SYNTHETIC_V12_SMOKE_JOB
      || !RUN_EXECUTION_PATTERN.test(env.CLOUD_RUN_EXECUTION ?? "")
      || env.CLOUD_RUN_TASK_INDEX !== "0"
      || env.CLOUD_RUN_TASK_COUNT !== "1"
      || env.CLOUD_RUN_TASK_ATTEMPT !== "0"
      || env.GOOGLE_CLOUD_PROJECT !== CLOUD_RUN_IAM_TEST_TARGET.project
      || env.K_SERVICE !== undefined) {
    fail("CLOUD_RUN_JOB_CONTEXT_INVALID");
  }
  if (env.HOST_ORIGIN !== SMOKE_ORIGIN) fail("HOST_ORIGIN_INVALID");
  if (env.GCS_BUCKET_NAME !== SYNTHETIC_V12_SMOKE_BUCKET) fail("GCS_BUCKET_NAME_INVALID");

  const primarySchema = required(env.PRIMARY_SCHEMA, "PRIMARY_SCHEMA", SCHEMA_PATTERN);
  const ledgerSchema = required(env.LEDGER_SCHEMA, "LEDGER_SCHEMA", SCHEMA_PATTERN);
  if (!SCHEMA_PATTERN.test(primarySchema) || primarySchema.startsWith("pg_")
      || primarySchema === "information_schema"
      || !SCHEMA_PATTERN.test(ledgerSchema) || ledgerSchema.startsWith("pg_")
      || ledgerSchema === "information_schema" || primarySchema === ledgerSchema) {
    fail("POSTGRES_SCHEMA_CONFIGURATION_INVALID");
  }

  const primaryDatabase = required(env.PRIMARY_DATABASE, "PRIMARY_DATABASE", DATABASE_PATTERN);
  const ledgerDatabase = required(env.LEDGER_DATABASE, "LEDGER_DATABASE", DATABASE_PATTERN);
  const primaryInstance = required(
    env.PRIMARY_INSTANCE_CONNECTION_NAME, "PRIMARY_INSTANCE_CONNECTION_NAME", INSTANCE_PATTERN,
  );
  const ledgerInstance = required(
    env.LEDGER_INSTANCE_CONNECTION_NAME, "LEDGER_INSTANCE_CONNECTION_NAME", INSTANCE_PATTERN,
  );
  const postgresIamUser = normalizeIamUser(required(env.POSTGRES_IAM_USER, "POSTGRES_IAM_USER", /.+/u));
  if (primaryDatabase !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.primaryDatabase
      || primarySchema !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.primarySchema
      || primaryInstance !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.primaryInstance
      || ledgerDatabase !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.ledgerDatabase
      || ledgerSchema !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.ledgerSchema
      || ledgerInstance !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.ledgerInstance
      || postgresIamUser !== SYNTHETIC_V12_SMOKE_DATABASE_TARGET.postgresIamUser) {
    fail("POSTGRES_TEST_TARGET_CONFIGURATION_INVALID");
  }
  const envelopePublicJwk = publicJwkFrom(required(env.ENVELOPE_PUBLIC_JWK, "ENVELOPE_PUBLIC_JWK", /[\s\S]+/u));
  const day = requiredDay(env.SYNTHETIC_V12_SMOKE_DAY);
  return Object.freeze({
    job: env.CLOUD_RUN_JOB,
    execution: env.CLOUD_RUN_EXECUTION,
    project: env.GOOGLE_CLOUD_PROJECT,
    origin: SMOKE_ORIGIN,
    primarySchema,
    ledgerSchema,
    primaryDatabase,
    ledgerDatabase,
    primaryInstance,
    ledgerInstance,
    postgresIamUser,
    bucket: SYNTHETIC_V12_SMOKE_BUCKET,
    envelopePublicJwk,
    day,
  });
}

function quotedTable(schema, table) {
  if (!SCHEMA_PATTERN.test(schema) || !/^[a-z_][a-z0-9_]*$/u.test(table)) {
    fail("POSTGRES_IDENTIFIER_INVALID");
  }
  return `"${schema}"."${table}"`;
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

export async function assertSyntheticV12RuntimeReady({ primaryPool, schema }) {
  try {
    const [baseRuntime, typedRuntime, controls] = await Promise.all([
      primaryPool.query(
        `SELECT state FROM ${quotedTable(schema, "telemetry_v12_runtime")} WHERE id = 1`,
      ),
      primaryPool.query(
        `SELECT state FROM ${quotedTable(schema, "telemetry_v12_typed_runtime")} WHERE id = 1`,
      ),
      primaryPool.query(
        `SELECT revision, control_state, enrollment_enabled, upload_registration_enabled,
                processing_enabled, publication_enabled
           FROM ${quotedTable(schema, "collection_controls")} WHERE singleton = 1`,
      ),
    ]);
    const control = controls.rows.length === 1 ? controls.rows[0] : null;
    const revision = control?.revision;
    const revisionReady = (typeof revision === "number" && Number.isSafeInteger(revision)
        && (revision === 2 || revision === 15))
      || (typeof revision === "string" && /^(?:2|15)$/u.test(revision));
    if (baseRuntime.rows.length !== 1 || baseRuntime.rows[0].state !== "active"
        || typedRuntime.rows.length !== 1 || typedRuntime.rows[0].state !== "active"
        || control === null || !revisionReady
        || control.control_state !== "degraded"
        || control.enrollment_enabled !== false
        || control.upload_registration_enabled !== true
        || control.processing_enabled !== true
        || control.publication_enabled !== false) {
      fail("SMOKE_RUNTIME_CONTROLS_NOT_READY");
    }
    return Object.freeze({
      controlState: control.control_state,
      publicationEnabled: control.publication_enabled,
    });
  } catch (error) {
    if (error?.code === "SMOKE_RUNTIME_CONTROLS_NOT_READY") throw error;
    fail("SMOKE_RUNTIME_CONTROLS_UNAVAILABLE");
  }
}

export async function validateSyntheticV12PublicKey(publicJwk) {
  if (!safeObject(publicJwk) || publicJwk.kty !== "RSA" || typeof publicJwk.kid !== "string") {
    fail("ENVELOPE_PUBLIC_JWK_INVALID");
  }
  const rsaJwk = { ...publicJwk };
  delete rsaJwk.kid;
  try {
    await webcrypto.subtle.importKey(
      "jwk", rsaJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
    );
  } catch {
    fail("ENVELOPE_PUBLIC_JWK_INVALID");
  }
}

/** Seed only unique synthetic authority rows; global runtime controls are read-only. */
export async function seedSyntheticV12Fixture({
  pool,
  schema,
  now = new Date(),
  randomBytesImpl = randomBytes,
  randomUUIDImpl = randomUUID,
}) {
  if (pool === null || typeof pool?.connect !== "function" || !SCHEMA_PATTERN.test(schema)) {
    fail("SMOKE_FIXTURE_CONFIGURATION_INVALID");
  }
  const participantId = `${SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX}${randomUUIDImpl()}`;
  const sessionId = randomUUIDImpl();
  const pairingId = randomUUIDImpl();
  const deviceId = randomUUIDImpl();
  const ownerDigest = randomBytesImpl(32).toString("hex");
  const enrollmentNamespace = randomBytesImpl(32).toString("hex");
  const deviceSecret = randomBytesImpl(32).toString("base64url");
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  const primary = (name) => quotedTable(schema, name);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `INSERT INTO ${primary("participants")} (
         id, owner_kind, state, consent_version, consented_at, created_at
       ) VALUES ($1, 'social', 'active', $2, $3, $3)`,
      [participantId, TELEMETRY_CONSENT_VERSION, nowIso],
    );
    await client.query(
      `INSERT INTO ${primary("attribution_enrollments")} (
         participant_id, namespace, created_at
       ) VALUES ($1, $2, $3)`,
      [participantId, enrollmentNamespace, nowIso],
    );
    await client.query(
      `INSERT INTO ${primary("web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
      [sessionId, participantId, randomBytesImpl(32), randomBytesImpl(32), nowIso, expiresAt],
    );
    await client.query(
      `INSERT INTO ${primary("device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1, $2, $3, $4, $5, $5, 'consumed', $6, $7, $6, $8)`,
      [pairingId, participantId, sessionId, randomBytesImpl(32), TELEMETRY_CONSENT_VERSION,
        nowIso, expiresAt, deviceId],
    );
    await client.query(
      `INSERT INTO ${primary("device_credentials")} (
         id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at
       ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
      [deviceId, participantId, pairingId, deviceSecretHash(deviceId, deviceSecret), nowIso, expiresAt],
    );
    await client.query(
      `INSERT INTO ${primary("telemetry_v12_device_capabilities")} (
         participant_id, device_id, telemetry_schema_version, field_dictionary_version,
         privacy_contract_version, state, consented_at
       ) VALUES ($1, $2, $3, $4, $5, 'accepted', $6)`,
      [participantId, deviceId, TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
        TELEMETRY_V12_FIELD_DICTIONARY_VERSION, TELEMETRY_V12_PRIVACY_CONTRACT_VERSION, nowIso],
    );
    await client.query(
      `INSERT INTO ${primary("storage_v11_owner_links")} (participant_id, owner_digest, state)
       VALUES ($1, $2, 'active')`,
      [participantId, ownerDigest],
    );
    await client.query("COMMIT");
    transactionOpen = false;
    return Object.freeze({
      participantId,
      sessionId,
      deviceId,
      deviceSecret,
      ownerDigest,
      enrollmentNamespace,
      deviceAuthorization: `Device um_device_${deviceId}.${deviceSecret}`,
    });
  } catch {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the sanitized failure. */ }
    }
    fail("SMOKE_FIXTURE_SEED_FAILED");
  } finally {
    client.release();
  }
}

function syntheticUsageRecord({ eventId, sessionId, day }) {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId,
    eventTime: `${day}T12:00:00.000Z`,
    sessionUuid: sessionId,
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 100,
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 90,
      inputCacheWriteTokens: 0,
      outputTextTokens: 8,
      outputReasoningTokens: 2,
      outputCombinedTokens: 10,
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

export async function encryptSyntheticV12Envelope(chunk, publicJwk) {
  parseTelemetryV12Chunk(chunk);
  const rsaJwk = { ...publicJwk };
  delete rsaJwk.kid;
  const rsa = await webcrypto.subtle.importKey(
    "jwk", rsaJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const aes = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = await webcrypto.subtle.exportKey("raw", aes);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await webcrypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey);
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv }, aes, encoder.encode(canonicalTelemetryV12Json(chunk)),
  );
  new Uint8Array(rawKey).fill(0);
  const envelope = {
    schemaVersion: "telemetry-envelope-v1.2",
    synthetic: false,
    keyId: publicJwk.kid,
    wrappedKey: Buffer.from(wrappedKey).toString("base64url"),
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
  validateTelemetryV12Envelope(envelope);
  return envelope;
}

function safeObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedHttpResponseBytes(response, maximumBytes) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
        || Number(declaredLength) > maximumBytes) fail("SMOKE_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("SMOKE_RESPONSE_INVALID");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail("SMOKE_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code === "SMOKE_RESPONSE_TOO_LARGE") throw error;
    fail("SMOKE_RESPONSE_INVALID");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(response) {
  try {
    const bytes = await boundedHttpResponseBytes(response, MAX_HTTP_RESPONSE_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!safeObject(value)) fail("SMOKE_RESPONSE_INVALID");
    return value;
  } catch (error) {
    if (error?.code === "SMOKE_RESPONSE_TOO_LARGE") throw error;
    fail("SMOKE_RESPONSE_INVALID");
  }
}

function routeCode(value) {
  const code = value?.error?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : "UNKNOWN";
}

function expectStatus(response, value, expected, stage) {
  if (response.status !== expected) fail(`${stage}_${routeCode(value)}`);
}

function safeRedirect(response, origin) {
  if (response === null || typeof response !== "object"
      || response.redirected === true
      || (Number.isInteger(response.status) && response.status >= 300 && response.status < 400)) {
    fail("SMOKE_REDIRECT_REJECTED");
  }
  if (typeof response.url === "string" && response.url !== "") {
    try {
      if (new URL(response.url).origin !== origin) fail("SMOKE_REDIRECT_REJECTED");
    } catch {
      fail("SMOKE_REDIRECT_REJECTED");
    }
  }
}

function responseUuid(value, field, code) {
  if (typeof value?.[field] !== "string" || !UUID_PATTERN.test(value[field])) fail(code);
  return value[field];
}

function responseContributionId(value) {
  if (typeof value?.contributionId !== "string" || !CONTRIBUTION_ID_PATTERN.test(value.contributionId)) {
    fail("SMOKE_CHUNK_RECEIPT_INVALID");
  }
  return value.contributionId;
}

export function makeManifestAndChunk({ day, sessionId, randomUUIDImpl = randomUUID }) {
  const consent = telemetryV12RequiredConsent();
  const records = [syntheticUsageRecord({
    eventId: `event:v2:${randomUUIDImpl()}`,
    sessionId,
    day,
  })];
  const canonicalRecords = canonicalTelemetryV12Json(records);
  const chunk = {
    schemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: createHash("sha256").update(canonicalRecords).digest("hex"),
    parserVersion: "synthetic-cloud-run-v12-smoke",
    consent,
    records,
  };
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion: chunk.parserVersion,
    consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: records.length }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = createHash("sha256")
    .update(telemetryV12DayManifestDigestInput(manifest))
    .digest("hex");
  chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunk };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requestJson({ fetchImpl, getIdToken, origin, method, path, authorization, body }) {
  const token = await getIdToken(origin);
  if (typeof token !== "string" || token.length < 1 || token.length > 8192
      || /[\r\n]/u.test(token)) fail("SMOKE_ID_TOKEN_UNAVAILABLE");
  const headers = {
    "x-serverless-authorization": `Bearer ${token}`,
    accept: "application/json",
  };
  if (authorization !== undefined) headers.authorization = authorization;
  if (body !== undefined) {
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_HTTP_REQUEST_BYTES) {
      fail("SMOKE_REQUEST_TOO_LARGE");
    }
    headers["content-type"] = "application/json; charset=utf-8";
  }
  const url = new URL(path, origin);
  const allowedPaths = [MANIFEST_PATH, GRANT_PATH, CHUNK_PATH, SYNC_STATE_PATH,
    DOMAIN_PREDECESSOR_PATH, DOMAIN_ACTIVATE_PATH, "/api/health"];
  if (url.origin !== origin || !allowedPaths.includes(path)
      || (["/api/health", SYNC_STATE_PATH].includes(path) ? method !== "GET" : method !== "POST")) {
    fail("SMOKE_ROUTE_INVALID");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    fail("SMOKE_HTTP_UNAVAILABLE");
  }
  safeRedirect(response, origin);
  return { response, value: await readJson(response) };
}

async function checkUnauthenticatedOrigin({ fetchImpl, origin }) {
  let response;
  try {
    response = await fetchImpl(new URL("/api/health", origin), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    fail("SMOKE_UNAUTHENTICATED_PROBE_UNAVAILABLE");
  }
  safeRedirect(response, origin);
  if (response.status !== 401 && response.status !== 403) {
    fail("SMOKE_UNAUTHENTICATED_ORIGIN_REACHABLE");
  }
}

function safeDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeSyntheticObjectKey(value) {
  return typeof value === "string"
    && /^telemetry\/v12-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function boundedResponseBytes(response, maximumBytes) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
        || Number(declaredLength) > maximumBytes) fail("SMOKE_GCS_OBJECT_TOO_LARGE");
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("SMOKE_GCS_READBACK_FAILED");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        fail("SMOKE_GCS_OBJECT_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code === "SMOKE_GCS_OBJECT_TOO_LARGE") throw error;
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch only the run-created envelope object through the fixed GCS media API. */
export async function readSyntheticGcsEnvelope({
  bucket,
  key,
  accessToken,
  fetchImpl = globalThis.fetch.bind(globalThis),
  maximumBytes = MAX_ENVELOPE_BYTES,
}) {
  if (bucket !== SYNTHETIC_V12_SMOKE_BUCKET || !safeSyntheticObjectKey(key)
      || typeof accessToken !== "function" || typeof fetchImpl !== "function"
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_ENVELOPE_BYTES) {
    fail("SMOKE_GCS_CONFIGURATION_INVALID");
  }
  let token;
  try { token = await accessToken(); } catch { fail("SMOKE_GCS_READBACK_FAILED"); }
  if (typeof token !== "string" || token.length < 1 || token.length > 8192
      || /[\r\n]/u.test(token)) fail("SMOKE_GCS_READBACK_FAILED");
  const url = new URL(
    `/download/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`,
    GCS_MEDIA_ORIGIN,
  );
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  let responseOrigin = GCS_MEDIA_ORIGIN;
  try {
    if (response.url) responseOrigin = new URL(response.url).origin;
  } catch {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  if (response.redirected === true || response.status < 200 || response.status >= 300
      || responseOrigin !== GCS_MEDIA_ORIGIN) {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  return boundedResponseBytes(response, maximumBytes);
}

async function readSyntheticGcsMetadata({ bucket, key, accessToken, fetchImpl }) {
  let token;
  try { token = await accessToken(); } catch { fail("SMOKE_GCS_READBACK_FAILED"); }
  if (typeof token !== "string" || token.length < 1 || token.length > 8192
      || /[\r\n]/u.test(token)) fail("SMOKE_GCS_READBACK_FAILED");
  const url = new URL(
    `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?fields=bucket%2Cname%2Csize%2Cgeneration`,
    GCS_MEDIA_ORIGIN,
  );
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  let responseOrigin = GCS_MEDIA_ORIGIN;
  try {
    if (response.url) responseOrigin = new URL(response.url).origin;
  } catch {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  if (response.redirected === true || response.status < 200 || response.status >= 300
      || responseOrigin !== GCS_MEDIA_ORIGIN) fail("SMOKE_GCS_READBACK_FAILED");
  let metadata;
  try {
    const bytes = await boundedResponseBytes(response, 16_384);
    metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  if (!safeObject(metadata) || metadata.bucket !== bucket || metadata.name !== key
      || typeof metadata.generation !== "string"
      || !/^[1-9][0-9]{0,18}$/u.test(metadata.generation)
      || typeof metadata.size !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/u.test(metadata.size)) {
    fail("SMOKE_GCS_READBACK_FAILED");
  }
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size > MAX_ENVELOPE_BYTES) fail("SMOKE_GCS_OBJECT_TOO_LARGE");
  return Object.freeze({ size });
}

export async function readSyntheticGcsObject({
  bucket,
  key,
  accessToken,
  fetchImpl = globalThis.fetch.bind(globalThis),
  maximumBytes = MAX_ENVELOPE_BYTES,
}) {
  if (bucket !== SYNTHETIC_V12_SMOKE_BUCKET || !safeSyntheticObjectKey(key)) {
    fail("SMOKE_GCS_CONFIGURATION_INVALID");
  }
  const metadata = await readSyntheticGcsMetadata({ bucket, key, accessToken, fetchImpl });
  const bytes = await readSyntheticGcsEnvelope({ bucket, key, accessToken, fetchImpl, maximumBytes });
  if (metadata.size !== bytes.byteLength) fail("SMOKE_GCS_READBACK_MISMATCH");
  return Object.freeze({ size: metadata.size, bytes });
}

/**
 * Run a single synthetic participant through the IAM-protected Cloud Run
 * manifest, grant, encrypted chunk, exact replay, and persistence readback.
 * Every external boundary is injected so tests cannot reach GCP.
 */
export async function runSyntheticV12Smoke({ config, dependencies }) {
  const deps = dependencies;
  for (const name of ["validateEnvelopeKey", "assertRuntimeReady", "seedFixture", "getIdToken", "fetchImpl",
    "encryptEnvelope", "readback", "randomUUID"]) {
    if (typeof deps?.[name] !== "function") fail("SMOKE_DEPENDENCIES_INVALID");
  }
  if (config?.origin !== SMOKE_ORIGIN || config?.bucket !== SYNTHETIC_V12_SMOKE_BUCKET
      || typeof config?.day !== "string" || !DAY_PATTERN.test(config.day)) {
    fail("SMOKE_CONFIGURATION_INVALID");
  }
  let seeded = false;
  try {
    await deps.validateEnvelopeKey(config.envelopePublicJwk);
    const controls = await deps.assertRuntimeReady(config);
    if (!safeObject(controls) || controls.controlState !== "degraded"
        || controls.publicationEnabled !== false) fail("SMOKE_RUNTIME_CONTROLS_NOT_READY");
    await checkUnauthenticatedOrigin({ fetchImpl: deps.fetchImpl, origin: config.origin });
    const { response: healthResponse, value: health } = await requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "GET",
      path: "/api/health",
    });
    expectStatus(healthResponse, health, 200, "SMOKE_HEALTH_FAILED");
    const primaryReceipt = health.checks?.primaryMigrationReceipt;
    const ledgerReceipt = health.checks?.ledgerMigrationReceipt;
    if (health.schemaVersion !== "gcp-postgres-test-health-v1"
        || health.scope !== "postgres_schema_and_migrations_only"
        || health.status !== "ready" || health.workerApplicationReady !== false
        || health.checks?.postgresMajor !== 17
        || primaryReceipt?.status !== "current" || primaryReceipt.version !== 36
        || ledgerReceipt?.status !== "current" || ledgerReceipt.version !== 6) {
      fail("SMOKE_HEALTH_CONTRACT_INVALID");
    }

    const fixture = await deps.seedFixture(config);
    seeded = true;
    if (!safeObject(fixture) || typeof fixture.participantId !== "string"
        || !fixture.participantId.startsWith(SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX)
        || !UUID_PATTERN.test(fixture.deviceId ?? "")
        || typeof fixture.deviceAuthorization !== "string"
        || !fixture.deviceAuthorization.startsWith("Device um_device_")) {
      fail("SMOKE_FIXTURE_INVALID", { orphaned: true });
    }

    const { response: syncResponse, value: syncState } = await requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "GET",
      path: SYNC_STATE_PATH,
      authorization: fixture.deviceAuthorization,
    });
    expectStatus(syncResponse, syncState, 200, "SMOKE_SYNC_STATE_FAILED");
    if (syncState.schemaVersion !== "device-sync-state-v1.0"
        || syncState.acknowledgedThroughDay !== null
        || syncState.historyDigest !== null
        || syncState.dayCount !== 0 || syncState.chunkCount !== 0
        || syncState.admission?.schemaVersion !== "telemetry-chunk-admission-v1.0"
        || syncState.admission?.state !== "available") {
      fail("SMOKE_SYNC_STATE_CONTRACT_INVALID");
    }

    const { manifest, chunk } = makeManifestAndChunk({
      day: config.day,
      sessionId: fixture.sessionId,
      randomUUIDImpl: deps.randomUUID,
    });
    const manifestBody = JSON.stringify(manifest);
    const postManifest = async () => requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "POST",
      path: MANIFEST_PATH,
      authorization: fixture.deviceAuthorization,
      body: manifestBody,
    });
    const firstManifest = await postManifest();
    expectStatus(firstManifest.response, firstManifest.value, 201, "SMOKE_MANIFEST_FAILED");
    const manifestId = responseUuid(firstManifest.value, "manifestId", "SMOKE_MANIFEST_RECEIPT_INVALID");
    if (firstManifest.value.manifestDigest !== manifest.manifestDigest
        || firstManifest.value.expectedChunks !== 1
        || firstManifest.value.state !== "staged") fail("SMOKE_MANIFEST_RECEIPT_INVALID");
    const manifestReplay = await postManifest();
    expectStatus(manifestReplay.response, manifestReplay.value, 201, "SMOKE_MANIFEST_REPLAY_FAILED");
    if (manifestReplay.value.manifestId !== manifestId
        || manifestReplay.value.manifestDigest !== manifest.manifestDigest) {
      fail("SMOKE_MANIFEST_REPLAY_MISMATCH");
    }

    const envelope = await deps.encryptEnvelope(chunk, config.envelopePublicJwk);
    const envelopeBody = JSON.stringify(envelope);
    const envelopeBytes = encoder.encode(envelopeBody);
    const envelopeDigest = sha256Hex(envelopeBytes);
    if (!safeDigest(envelopeDigest)) fail("SMOKE_ENVELOPE_INVALID");
    const grantBody = JSON.stringify({
      envelopeDigest,
      contentLengthBytes: envelopeBytes.byteLength,
      contentType: "application/json",
      telemetrySchemaVersion: TELEMETRY_V12_CONTRIBUTION_SCHEMA_VERSION,
    });
    const issueGrant = async () => requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "POST",
      path: GRANT_PATH,
      authorization: fixture.deviceAuthorization,
      body: grantBody,
    });
    const uploadChunk = async (uploadAuthorization) => requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "POST",
      path: CHUNK_PATH,
      authorization: uploadAuthorization,
      body: envelopeBody,
    });
    const firstGrant = await issueGrant();
    expectStatus(firstGrant.response, firstGrant.value, 201, "SMOKE_GRANT_FAILED");
    if (typeof firstGrant.value.uploadAuthorization !== "string"
        || !firstGrant.value.uploadAuthorization.startsWith("um_device_upload_")) {
      fail("SMOKE_GRANT_RECEIPT_INVALID");
    }
    const firstUploadAuthorization = `Upload ${firstGrant.value.uploadAuthorization}`;
    const firstUpload = await uploadChunk(firstUploadAuthorization);
    expectStatus(firstUpload.response, firstUpload.value, 202, "SMOKE_CHUNK_FAILED");
    const contributionId = responseContributionId(firstUpload.value);
    if (firstUpload.value.schemaVersion !== "telemetry-chunk-receipt-v1.2"
        || firstUpload.value.chunkId !== chunk.chunkId || firstUpload.value.replayed !== false) {
      fail("SMOKE_CHUNK_RECEIPT_INVALID");
    }

    const replayGrant = await issueGrant();
    expectStatus(replayGrant.response, replayGrant.value, 201, "SMOKE_REPLAY_GRANT_FAILED");
    if (typeof replayGrant.value.uploadAuthorization !== "string"
        || !replayGrant.value.uploadAuthorization.startsWith("um_device_upload_")) {
      fail("SMOKE_REPLAY_GRANT_RECEIPT_INVALID");
    }
    const replayUpload = await uploadChunk(`Upload ${replayGrant.value.uploadAuthorization}`);
    expectStatus(replayUpload.response, replayUpload.value, 202, "SMOKE_CHUNK_REPLAY_FAILED");
    if (replayUpload.value.contributionId !== contributionId
        || replayUpload.value.manifestId !== manifestId
        || replayUpload.value.chunkId !== chunk.chunkId
        || replayUpload.value.replayed !== true) {
      fail("SMOKE_CHUNK_REPLAY_MISMATCH");
    }

    const { response: predecessorResponse, value: predecessor } = await requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "POST",
      path: DOMAIN_PREDECESSOR_PATH,
      authorization: fixture.deviceAuthorization,
      body: "{}",
    });
    expectStatus(predecessorResponse, predecessor, 201, "SMOKE_DOMAIN_PREDECESSOR_FAILED");
    const predecessorToken = responseUuid(
      predecessor, "token", "SMOKE_DOMAIN_PREDECESSOR_RECEIPT_INVALID",
    );
    if (predecessor.schemaVersion !== "telemetry-domain-predecessor-v1.2"
        || predecessor.previousGenerationId !== null
        || !safeDigest(predecessor.legacyFingerprint)
        || predecessor.fromDay !== config.day || predecessor.throughDay !== config.day
        || typeof predecessor.expiresAt !== "string"
        || !Number.isFinite(Date.parse(predecessor.expiresAt))
        || Date.parse(predecessor.expiresAt) <= Date.now()) {
      fail("SMOKE_DOMAIN_PREDECESSOR_RECEIPT_INVALID");
    }
    const domainManifest = {
      schemaVersion: TELEMETRY_V12_DOMAIN_MANIFEST_SCHEMA_VERSION,
      fromDay: predecessor.fromDay,
      throughDay: predecessor.throughDay,
      predecessor: {
        token: predecessorToken,
        previousGenerationId: predecessor.previousGenerationId,
        legacyFingerprint: predecessor.legacyFingerprint,
      },
      days: [{ day: config.day, manifestId, manifestDigest: manifest.manifestDigest }],
      manifestDigest: "0".repeat(64),
    };
    domainManifest.manifestDigest = sha256Hex(Buffer.from(
      telemetryV12DomainManifestDigestInput(domainManifest),
    ));
    const domainManifestBody = JSON.stringify(domainManifest);
    const activateDomain = async () => requestJson({
      fetchImpl: deps.fetchImpl,
      getIdToken: deps.getIdToken,
      origin: config.origin,
      method: "POST",
      path: DOMAIN_ACTIVATE_PATH,
      authorization: fixture.deviceAuthorization,
      body: domainManifestBody,
    });
    const firstActivation = await activateDomain();
    expectStatus(firstActivation.response, firstActivation.value, 201, "SMOKE_DOMAIN_ACTIVATE_FAILED");
    const generationId = responseUuid(
      firstActivation.value, "generationId", "SMOKE_DOMAIN_ACTIVATION_RECEIPT_INVALID",
    );
    if (firstActivation.value.schemaVersion !== "telemetry-domain-activation-v1.2"
        || firstActivation.value.manifestDigest !== domainManifest.manifestDigest
        || firstActivation.value.fromDay !== config.day
        || firstActivation.value.throughDay !== config.day
        || firstActivation.value.replay !== false) {
      fail("SMOKE_DOMAIN_ACTIVATION_RECEIPT_INVALID");
    }
    const replayActivation = await activateDomain();
    expectStatus(replayActivation.response, replayActivation.value, 201, "SMOKE_DOMAIN_REPLAY_FAILED");
    if (replayActivation.value.schemaVersion !== firstActivation.value.schemaVersion
        || replayActivation.value.generationId !== generationId
        || replayActivation.value.manifestDigest !== domainManifest.manifestDigest
        || replayActivation.value.fromDay !== config.day
        || replayActivation.value.throughDay !== config.day
        || replayActivation.value.replay !== true) {
      fail("SMOKE_DOMAIN_REPLAY_MISMATCH");
    }

    const storage = await deps.readback({
      config,
      fixture,
      manifest,
      manifestId,
      chunk,
      envelopeDigest,
      envelopeByteLength: envelopeBytes.byteLength,
      contributionId,
      domainManifest,
      generationId,
      expectedRecord: chunk.records[0],
    });
    if (storage?.postgres !== true || storage?.gcs !== true || storage?.effectiveRecord !== true) {
      fail("SMOKE_STORAGE_READBACK_FAILED");
    }
    return Object.freeze({
      status: "ok",
      kind: "synthetic-v12-smoke",
      synthetic: true,
      participantId: fixture.participantId,
      origin: config.origin,
      manifest: "staged_and_exactly_replayed",
      chunk: "staged_and_exactly_replayed",
      domain: "activated_and_exactly_replayed",
      syncState: "empty_history_admission_available",
      postgresReadback: true,
      effectiveRecordReadback: true,
      gcsReadback: true,
      publication: "withheld_by_verified_degraded_controls",
      retainedFixturePrefix: SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX,
    });
  } catch (error) {
    const rawCode = error?.code;
    const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,100}$/u.test(rawCode)
      ? rawCode : "SYNTHETIC_V12_SMOKE_FAILED";
    throw Object.assign(new Error(code), {
      code,
      orphaned: seeded || error?.orphaned === true,
      orphanMarker: seeded || error?.orphaned === true
        ? SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX : undefined,
    });
  }
}

function safeReadbackFailure(error) {
  if (new Set([
    "SMOKE_POSTGRES_READBACK_MANIFEST_MISMATCH",
    "SMOKE_POSTGRES_READBACK_CHUNK_MISMATCH",
    "SMOKE_POSTGRES_READBACK_GRANTS_MISMATCH",
    "SMOKE_POSTGRES_READBACK_JOURNAL_MISMATCH",
    "SMOKE_POSTGRES_READBACK_DOMAIN_MISMATCH",
    "SMOKE_POSTGRES_READBACK_DOMAIN_DAYS_MISMATCH",
    "SMOKE_POSTGRES_EFFECTIVE_RECORD_MISMATCH",
    "SMOKE_POSTGRES_EFFECTIVE_READBACK_UNAVAILABLE",
  ]).has(error?.code)
      || error?.code === "SMOKE_GCS_OBJECT_MISSING"
      || typeof error?.code === "string" && error.code.startsWith("SMOKE_GCS_")) throw error;
  fail("SMOKE_POSTGRES_READBACK_FAILED");
}

export async function postgresAndGcsReadback({
  primaryPool,
  primarySchema,
  readGcsObject,
  bucket,
  fixture,
  manifest,
  manifestId,
  chunk,
  envelopeDigest,
  envelopeByteLength,
  contributionId,
  domainManifest,
  generationId,
  expectedRecord,
  readEffectivePage,
}) {
  try {
    if (!safeObject(domainManifest) || domainManifest.fromDay !== manifest.day
        || domainManifest.throughDay !== manifest.day || !Array.isArray(domainManifest.days)
        || domainManifest.days.length !== 1 || domainManifest.days[0]?.day !== manifest.day
        || typeof generationId !== "string" || !UUID_PATTERN.test(generationId)) {
      fail("SMOKE_POSTGRES_READBACK_DOMAIN_MISMATCH");
    }
    const manifests = await primaryPool.query(
      `SELECT id, manifest_digest, chunk_day::text AS chunk_day, expected_chunk_count
         FROM ${quotedTable(primarySchema, "telemetry_v12_day_manifests")}
        WHERE id = $1 AND participant_id = $2 AND device_id = $3`,
      [manifestId, fixture.participantId, fixture.deviceId],
    );
    if (manifests.rows.length !== 1 || manifests.rows[0].manifest_digest !== manifest.manifestDigest
        || manifests.rows[0].chunk_day !== manifest.day
        || Number(manifests.rows[0].expected_chunk_count) !== 1) {
      fail("SMOKE_POSTGRES_READBACK_MANIFEST_MISMATCH");
    }
    const chunks = await primaryPool.query(
      `SELECT id, chunk_id, chunk_digest, envelope_digest, record_count, r2_key,
              device_upload_authorization_id
         FROM ${quotedTable(primarySchema, "telemetry_v12_chunks")}
        WHERE id = $1 AND manifest_id = $2 AND participant_id = $3 AND device_id = $4`,
      [contributionId, manifestId, fixture.participantId, fixture.deviceId],
    );
    if (chunks.rows.length !== 1) fail("SMOKE_POSTGRES_READBACK_CHUNK_MISMATCH");
    const storedChunk = chunks.rows[0];
    if (storedChunk.chunk_id !== chunk.chunkId || storedChunk.chunk_digest !== chunk.chunkDigest
        || storedChunk.envelope_digest !== envelopeDigest || Number(storedChunk.record_count) !== 1
        || !safeSyntheticObjectKey(storedChunk.r2_key)) {
      fail("SMOKE_POSTGRES_READBACK_CHUNK_MISMATCH");
    }
    const grants = await primaryPool.query(
      `SELECT state, consumed_contribution_id
         FROM ${quotedTable(primarySchema, "device_upload_authorizations")}
        WHERE participant_id = $1 AND issued_by_device_id = $2 AND envelope_digest = $3`,
      [fixture.participantId, fixture.deviceId, envelopeDigest],
    );
    if (grants.rows.length !== 2
        || grants.rows.filter((row) => row.state === "consumed").length !== 1
        || grants.rows.filter((row) => row.state === "revoked").length !== 1
        || grants.rows.find((row) => row.state === "consumed")?.consumed_contribution_id !== contributionId) {
      fail("SMOKE_POSTGRES_READBACK_GRANTS_MISMATCH");
    }
    const journal = await primaryPool.query(
      `SELECT object_key, object_kind, reconciliation_state
         FROM ${quotedTable(primarySchema, "pending_objects")}
        WHERE contribution_id = $1 AND object_key = $2`,
      [contributionId, storedChunk.r2_key],
    );
    if (journal.rows.length !== 1 || journal.rows[0].object_kind !== "telemetry_v12"
        || journal.rows[0].reconciliation_state !== "registered") {
      fail("SMOKE_POSTGRES_READBACK_JOURNAL_MISMATCH");
    }
    const activeDomain = await primaryPool.query(
      `SELECT domain.id, domain.manifest_digest,
              to_char(domain.from_day, 'YYYY-MM-DD') AS from_day,
              to_char(domain.through_day, 'YYYY-MM-DD') AS through_day
         FROM ${quotedTable(primarySchema, "telemetry_v12_domain_heads")} head
         JOIN ${quotedTable(primarySchema, "telemetry_v12_domains")} domain
           ON domain.id = head.generation_id
        WHERE head.participant_id = $1 AND head.generation_id = $2 AND domain.device_id = $3`,
      [fixture.participantId, generationId, fixture.deviceId],
    );
    if (activeDomain.rows.length !== 1 || activeDomain.rows[0].id !== generationId
        || activeDomain.rows[0].manifest_digest !== domainManifest.manifestDigest
        || activeDomain.rows[0].from_day !== domainManifest.fromDay
        || activeDomain.rows[0].through_day !== domainManifest.throughDay) {
      fail("SMOKE_POSTGRES_READBACK_DOMAIN_MISMATCH");
    }
    const domainDays = await primaryPool.query(
      `SELECT to_char(observed_day, 'YYYY-MM-DD') AS observed_day, manifest_id, manifest_digest
         FROM ${quotedTable(primarySchema, "telemetry_v12_domain_days")}
        WHERE generation_id = $1 ORDER BY observed_day LIMIT 2`,
      [generationId],
    );
    const expectedDay = domainManifest.days[0];
    if (domainDays.rows.length !== 1
        || domainDays.rows[0].observed_day !== expectedDay.day
        || domainDays.rows[0].manifest_id !== expectedDay.manifestId
        || domainDays.rows[0].manifest_digest !== expectedDay.manifestDigest) {
      fail("SMOKE_POSTGRES_READBACK_DOMAIN_DAYS_MISMATCH");
    }
    if (bucket !== SYNTHETIC_V12_SMOKE_BUCKET || !safeSyntheticObjectKey(storedChunk.r2_key)
        || typeof readGcsObject !== "function") fail("SMOKE_GCS_CONFIGURATION_INVALID");
    const object = await readGcsObject({
      bucket,
      key: storedChunk.r2_key,
      maximumBytes: MAX_ENVELOPE_BYTES,
    });
    if (!safeObject(object) || object.size !== envelopeByteLength
        || !(object.bytes instanceof Uint8Array) || object.bytes.byteLength !== envelopeByteLength
        || sha256Hex(object.bytes) !== envelopeDigest) fail("SMOKE_GCS_READBACK_MISMATCH");
    if (typeof readEffectivePage !== "function" || !safeObject(expectedRecord)) {
      fail("SMOKE_POSTGRES_EFFECTIVE_READBACK_UNAVAILABLE");
    }
    const page = await readEffectivePage({
      participantId: fixture.participantId,
      day: manifest.day,
      stream: "usage",
      limit: 2,
    });
    if (!safeObject(page) || page.available !== true || !Array.isArray(page.records)
        || page.records.length !== 1 || page.next !== null) {
      fail("SMOKE_POSTGRES_EFFECTIVE_RECORD_MISMATCH");
    }
    const effective = page.records[0];
    if (!safeObject(effective) || effective.occurrenceId !== expectedRecord.eventId
        || typeof effective.sourceRecordJson !== "string"
        || Buffer.byteLength(effective.sourceRecordJson) > MAX_EFFECTIVE_RECORD_BYTES
        || typeof effective.recordJson !== "string"
        || Buffer.byteLength(effective.recordJson) > MAX_EFFECTIVE_RECORD_BYTES) {
      fail("SMOKE_POSTGRES_EFFECTIVE_RECORD_MISMATCH");
    }
    let sourceRecord;
    let projectedRecord;
    try {
      sourceRecord = JSON.parse(effective.sourceRecordJson);
      projectedRecord = JSON.parse(effective.recordJson);
    } catch {
      fail("SMOKE_POSTGRES_EFFECTIVE_RECORD_MISMATCH");
    }
    const expectedProjection = { ...expectedRecord, schemaVersion: "usage-event-v1.1" };
    delete expectedProjection.boundaryFlags;
    delete expectedProjection.tieOrder;
    delete expectedProjection.cacheWriteTtl;
    if (canonicalTelemetryV12Json(sourceRecord) !== canonicalTelemetryV12Json(expectedRecord)
        || canonicalTelemetryV12Json(projectedRecord) !== canonicalTelemetryV12Json(expectedProjection)) {
      fail("SMOKE_POSTGRES_EFFECTIVE_RECORD_MISMATCH");
    }
    return Object.freeze({ postgres: true, gcs: true, effectiveRecord: true });
  } catch (error) {
    safeReadbackFailure(error);
  }
}

async function createNativeDependencies(config) {
  const connector = new Connector();
  const pools = [];
  try {
    const primaryPool = await createIamPool({
      connector,
      instanceConnectionName: config.primaryInstance,
      database: config.primaryDatabase,
      user: config.postgresIamUser,
      max: 2,
      applicationName: "tibotattle-synthetic-v12-smoke",
    });
    pools.push(primaryPool);
    const ledgerPool = await createIamPool({
      connector,
      instanceConnectionName: config.ledgerInstance,
      database: config.ledgerDatabase,
      user: config.postgresIamUser,
      max: 2,
      applicationName: "tibotattle-synthetic-v12-smoke",
    });
    pools.push(ledgerPool);
    const accessToken = await createGoogleAccessTokenProvider();
    const auth = new GoogleAuth();
    let idTokenClient;
    const getIdToken = async (audience) => {
      if (audience !== config.origin) fail("SMOKE_ID_TOKEN_AUDIENCE_INVALID");
      try {
        idTokenClient ??= await auth.getIdTokenClient(config.origin);
        const headers = await idTokenClient.getRequestHeaders(config.origin);
        const authorization = headers.get?.("authorization") ?? headers.authorization;
        if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
          fail("SMOKE_ID_TOKEN_UNAVAILABLE");
        }
        return authorization.slice("Bearer ".length);
      } catch (error) {
        if (error?.code === "SMOKE_ID_TOKEN_AUDIENCE_INVALID") throw error;
        fail("SMOKE_ID_TOKEN_UNAVAILABLE");
      }
    };
    let effectiveReaderPromise;
    const readEffectivePage = async (options) => {
      try {
        effectiveReaderPromise ??= import("../src/postgres-typed-v12-effective-reader.ts")
          .then((module) => module.readPostgresTelemetryV12EffectivePage);
        const readPage = await effectiveReaderPromise;
        if (typeof readPage !== "function") fail("SMOKE_POSTGRES_EFFECTIVE_READBACK_UNAVAILABLE");
        return await readPage(primaryPool, options, {
          schema: {
            primarySchema: config.primarySchema,
            ledgerSchema: config.ledgerSchema,
          },
        });
      } catch {
        fail("SMOKE_POSTGRES_EFFECTIVE_READBACK_UNAVAILABLE");
      }
    };
    const fetchImpl = globalThis.fetch.bind(globalThis);
    return {
      dependencies: {
        validateEnvelopeKey: validateSyntheticV12PublicKey,
        assertRuntimeReady: () => assertSyntheticV12RuntimeReady({
          primaryPool,
          schema: config.primarySchema,
        }),
        seedFixture: () => seedSyntheticV12Fixture({
          pool: primaryPool,
          schema: config.primarySchema,
        }),
        getIdToken,
        fetchImpl,
        encryptEnvelope: encryptSyntheticV12Envelope,
        readback: (input) => postgresAndGcsReadback({
          primaryPool,
          primarySchema: config.primarySchema,
          bucket: config.bucket,
          readGcsObject: ({ key, maximumBytes }) => readSyntheticGcsObject({
            bucket: config.bucket,
            key,
            maximumBytes,
            accessToken,
            fetchImpl,
          }),
          readEffectivePage,
          ...input,
        }),
        randomUUID,
      },
      close: () => closeCloudSqlResources({ pools, connector }),
    };
  } catch {
    await closeCloudSqlResources({ pools, connector }).catch(() => undefined);
    throw new Error("SMOKE_RESOURCE_INITIALIZATION_FAILED");
  }
}

async function main() {
  let phase = "configuration";
  let native;
  let receipt;
  let failed = false;
  try {
    const config = parseSyntheticV12SmokeConfig(process.env);
    await validateSyntheticV12PublicKey(config.envelopePublicJwk);
    phase = "initialization";
    native = await createNativeDependencies(config);
    phase = "journey";
    receipt = await runSyntheticV12Smoke({ config, dependencies: native.dependencies });
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,100}$/u.test(error.code)
      ? error.code : "SYNTHETIC_V12_SMOKE_FAILED";
    receipt = {
      status: "failed",
      kind: "synthetic-v12-smoke",
      code,
      ...(error?.orphaned === true
        ? { orphanMarker: SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX } : {}),
    };
    failed = true;
  }
  try {
    await native?.close();
  } catch {
    receipt = {
      status: "failed",
      kind: "synthetic-v12-smoke",
      code: "SMOKE_RESOURCE_CLOSE_FAILED",
      ...((receipt?.orphanMarker !== undefined || receipt?.status === "ok")
        ? { orphanMarker: SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX } : {}),
    };
    failed = true;
  }
  (failed ? console.error : console.log)(JSON.stringify(receipt));
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
