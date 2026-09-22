import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import worker from "../src/index.ts";
import { createPostgresWorkerBackend } from "../src/backend-composition.ts";
import { deviceHash } from "../src/device-auth.ts";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  claimPendingAppleSignInHandoff,
  claimPendingGoogleSignInHandoff,
  completeAppleSignInHandoff,
  completeGoogleSignInHandoff,
  consumeAppleSignInHandoff,
  consumeGoogleSignInHandoff,
  deliverAppleSignInHandoff,
  deliverGoogleSignInHandoff,
  insertAppleSignInHandoff,
  insertGoogleSignInHandoff,
  readPendingAppleSignInHandoff,
  readPendingGoogleSignInHandoff,
} from "../src/identity-handoff-repository.ts";
import {
  createSessionMaterialFromSecret,
  sessionCookie,
} from "../src/session.ts";
import { canonicalJson } from "../src/canonical-json.ts";
import { encodeBase64Url, sha256Hex } from "../src/crypto.ts";

const participantId = `route-participant-${randomUUID()}`;
const sessionId = randomUUID();
const deviceId = randomUUID();
const pairingId = randomUUID();
const sessionSecret = randomBytes(32).toString("base64url");
const deviceSecret = randomBytes(32).toString("base64url");
const baseEpoch = Date.now();
const now = new Date(baseEpoch).toISOString();
const expiresAt = new Date(baseEpoch + 60 * 60 * 1000).toISOString();
let admin;
let primary;
let ledger;
let primaryDatabase;
let ledgerDatabase;
let primarySchema;
let ledgerSchema;
let backend;
let session;
let environment;
let d1Touches = 0;
let envelopePublicJwk;
let envelopePrivateJwk;
const keyId = "key:postgres-route";
const objectValues = new Map();

function objectStore() {
  return {
    async put(key, value) {
      objectValues.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
    },
    async head(key) {
      const value = objectValues.get(key);
      return value === undefined ? null : { version: createHash("sha256").update(value).digest("hex"), size: new TextEncoder().encode(value).byteLength };
    },
    async delete(key) {
      objectValues.delete(key);
    },
    async deleteMany(keys) {
      for (const key of keys) objectValues.delete(key);
    },
  };
}

function ingressBudget() {
  return {
    getByName() {
      return {
        async acquire() { return { allowed: true, leaseId: randomUUID(), retryAfterSeconds: 0 }; },
        async probe() { return true; },
        async release() {},
        async renew() { return true; },
        async status() { return { activeLeases: 0, maximumConcurrent: 64, availableStartTokens: 64, burst: 64, concurrencyDenials: 0, startRateDenials: 0, lastDeniedAtEpoch: null }; },
      };
    },
  };
}

async function applyMigrations() {
  await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primary });
  await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledger });
}

function rateLimiter() {
  return { limit: async () => ({ success: true }) };
}

function throwingD1() {
  return new Proxy({}, {
    get(_target, key) {
      d1Touches += 1;
      throw new Error("D1 must not be touched by the PostgreSQL route harness");
    },
  });
}

function makeEnvironment() {
  return {
    POSTGRES_WORKER_BACKEND: backend,
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ENROLLMENT_MODE: "local_open",
    USAGE_MONITOR_DB: throwingD1(),
    DELETION_LEDGER: throwingD1(),
    ENROLLMENT_RATE_LIMIT: rateLimiter(),
    RECOVERY_RATE_LIMIT: rateLimiter(),
    CLIENT_ATTEMPT_RATE_LIMIT: rateLimiter(),
    PUBLIC_READ_RATE_LIMIT: rateLimiter(),
    UPLOAD_AUTHORIZATION_RATE_LIMIT: rateLimiter(),
    UPLOAD_PRINCIPAL_RATE_LIMIT: rateLimiter(),
    UPLOAD_INGRESS_REQUEST_RATE_LIMIT: rateLimiter(),
    UPLOAD_INGRESS_CLIENT_RATE_LIMIT: rateLimiter(),
    UPLOAD_INGRESS_BUDGET: ingressBudget(),
    UPLOAD_INGRESS_QUEUE_MODE: "disabled",
    UPLOAD_INGRESS_MAX_CONCURRENT: "64",
    UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "1200",
    UPLOAD_INGRESS_BURST: "64",
    UPLOAD_INGRESS_LEASE_SECONDS: "90",
    UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
    UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
    ENVELOPE_PUBLIC_JWK: envelopePublicJwk,
    ENVELOPE_PRIVATE_JWK: envelopePrivateJwk,
    POSTGRES_OBJECT_STORE: objectStore(),
    IDENTITY_LINK_SECRET: "synthetic-route-secret-012345678901234567890123",
  };
}

beforeAll(async () => {
  const envelopeKeys = await webcrypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  );
  if (!("publicKey" in envelopeKeys)) throw new Error("synthetic RSA pair required");
  const publicKey = await webcrypto.subtle.exportKey("jwk", envelopeKeys.publicKey);
  const privateKey = await webcrypto.subtle.exportKey("jwk", envelopeKeys.privateKey);
  envelopePublicJwk = JSON.stringify({ ...publicKey, kid: keyId });
  envelopePrivateJwk = JSON.stringify({ ...privateKey, kid: keyId });
  const socket = process.env.PG_TEST_SOCKET;
  if (!socket || !isAbsolute(socket) || !socket.startsWith("/private/tmp/tibotattle-pg-")) {
    throw new Error("PG_TEST_SOCKET must identify the provisioned local PostgreSQL socket");
  }
  const stat = await lstat(socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(socket) !== socket
      || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) {
    throw new Error("PG_TEST_SOCKET must be a canonical owner-only directory");
  }
  const port = Number(process.env.PG_TEST_PORT ?? "5432");
  const options = {
    host: socket,
    port,
    user: "postgres",
    password: "synthetic-local-only",
    database: "postgres",
    ssl: false,
    options: "",
    connectionTimeoutMillis: 3000,
    statement_timeout: 12000,
    idleTimeoutMillis: 1000,
    max: 2,
  };
  admin = new pg.Pool(options);
  primaryDatabase = `tibotattle_routes_primary_${randomBytes(8).toString("hex")}`;
  ledgerDatabase = `tibotattle_routes_ledger_${randomBytes(8).toString("hex")}`;
  primarySchema = "tibotattle";
  ledgerSchema = "tibotattle_ledger";
  await admin.query(`CREATE DATABASE "${primaryDatabase}"`);
  await admin.query(`CREATE DATABASE "${ledgerDatabase}"`);
  primary = new pg.Pool({ ...options, database: primaryDatabase, max: 4 });
  ledger = new pg.Pool({ ...options, database: ledgerDatabase, max: 4 });
  await primary.query(`CREATE SCHEMA "${primarySchema}"`);
  await ledger.query(`CREATE SCHEMA "${ledgerSchema}"`);
  await applyMigrations();
  await primary.query(`UPDATE "${primarySchema}".collection_controls
    SET revision=1, control_state='operational', enrollment_enabled=true,
        upload_registration_enabled=true, processing_enabled=true,
        publication_enabled=true, updated_at=clock_timestamp()
    WHERE singleton=1`);

  backend = createPostgresWorkerBackend({
    primaryPool: primary,
    ledgerPool: ledger,
    schemaOptions: { primarySchema, ledgerSchema },
  });
  const participantCreated = await primary.query(`INSERT INTO "${primarySchema}".participants
    (id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
     recovery_token_hash, state, consent_version, consented_at, created_at)
    VALUES ($1, 'social', 'route-access', $2, 'route-recovery', $3,
      'active', 'privacy-safe-telemetry-v0.1', $4, $4)`,
  [participantId, Buffer.alloc(32, 1), Buffer.alloc(32, 2), now]);
  expect(participantCreated.rowCount).toBe(1);
  // Seed only the canonical runtime identity/restore checkpoint needed by the
  // readiness barrier. The participant itself remains an existing authority
  // fixture in this legacy route regression; the enrollment journey below
  // uses the real shared enrollment path.
  const ownerDigest = "a".repeat(64);
  await primary.query(`INSERT INTO "${primarySchema}".storage_source_state
    (singleton, source_id, authority_epoch) VALUES (1, 'canonical-v1-primary', 1)`);
  await primary.query(`INSERT INTO "${primarySchema}".attribution_enrollments
    (participant_id, namespace, created_at) VALUES ($1, $2, $3)`,
  [participantId, "b".repeat(64), now]);
  await primary.query(`INSERT INTO "${primarySchema}".storage_v11_owner_links
    (participant_id, owner_digest, state, generation_id, head_revision, object_digest, manifest_digest)
    VALUES ($1, $2, 'active', 'route-generation-1', 0, $2, $2)`,
  [participantId, ownerDigest]);
  await primary.query(`INSERT INTO "${primarySchema}".analytics_owner_state
    (source_id, owner_digest, revision, authority_epoch, state)
    VALUES ('canonical-v1-primary', $1, 0, 1, 'active')`, [ownerDigest]);
  await primary.query(`INSERT INTO "${primarySchema}".input_versions
    (participant_id, revision) VALUES ($1, 0)
    ON CONFLICT (participant_id) DO NOTHING`, [participantId]);
  await primary.query(`INSERT INTO "${primarySchema}".telemetry_transport_participant_floors
    (participant_id, minimum_rank, revision, changed_at) VALUES ($1, 1, 0, $2)
    ON CONFLICT (participant_id) DO NOTHING`, [participantId, now]);
  await primary.query(`UPDATE "${primarySchema}".retention_state
    SET restore_replay_complete = true, quarantine_retention_complete = true,
        state = 'completed', last_completed_at = $1 WHERE singleton = 1`, [now]);

  session = await createSessionMaterialFromSecret(
    participantId,
    sessionId,
    sessionSecret,
    now,
    expiresAt,
  );
  await backend.authority.sessions.insert({
    id: session.id,
    participantId,
    secretHash: session.secretHash,
    csrfHash: session.csrfHash,
    scope: session.scope,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  });

  await backend.authority.devices.insertPairing({
    id: pairingId,
    participantId,
    issuedBySessionId: sessionId,
    secretHash: new Uint8Array(Buffer.alloc(32, 3)),
    consentVersion: "privacy-safe-telemetry-v0.1",
    transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.0",
    issuedAt: now,
    expiresAt,
  });
  const deviceSecretHash = await deviceHash(deviceId, deviceSecret);
  expect(await backend.authority.devices.claimPairing({
    pairingId,
    participantId,
    now,
    device: {
      id: deviceId,
      participantId,
      pairingId,
      secretHash: deviceSecretHash,
      issuedAt: now,
      expiresAt,
      lastUsedAt: now,
      socialVerifiedAt: now,
      credentialGeneration: 1,
    },
  })).toBe(true);
  environment = makeEnvironment();
});

afterAll(async () => {
  await primary?.end();
  await ledger?.end();
  if (primaryDatabase) await admin.query(`DROP DATABASE IF EXISTS "${primaryDatabase}"`);
  if (ledgerDatabase) await admin.query(`DROP DATABASE IF EXISTS "${ledgerDatabase}"`);
  await admin?.end();
});

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("expected session cookie");
  return value.split(";", 1)[0];
}

async function encryptedV1Chunk(chunk) {
  const publicKey = JSON.parse(envelopePublicJwk);
  const rsa = await webcrypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const dataKey = await webcrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const rawKey = await webcrypto.subtle.exportKey("raw", dataKey);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKey,
    new TextEncoder().encode(canonicalJson(chunk)),
  );
  const wrappedKey = await webcrypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsa,
    rawKey,
  );
  return {
    schemaVersion: "telemetry-envelope-v1.0",
    synthetic: false,
    keyId,
    wrappedKey: encodeBase64Url(new Uint8Array(wrappedKey)),
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

async function routeV1Chunk() {
  const day = new Date().toISOString().slice(0, 10);
  const record = {
    schemaVersion: "usage-event-v1.0",
    eventId: `event:postgres-route:${randomBytes(24).toString("hex")}`,
    eventTime: `${day}T12:00:00.000Z`,
    sessionUuid: randomUUID(),
    provider: "openai_codex",
    modelId: "gpt-route",
    speedMode: "standard",
    apiServiceTier: "standard",
    surface: "api",
    billingSurface: "api",
    reasoningEffort: "none",
    agentScope: "local",
    outcome: "success",
    totalInputContextTokens: 1,
    components: {
      inputUncachedTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: 1,
    },
  };
  const chunk = {
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: await sha256Hex(canonicalJson([record])),
    parserVersion: "postgres-route-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records: [record],
  };
  return JSON.stringify(await encryptedV1Chunk(chunk));
}

describe("PostgreSQL-backed Worker route composition", () => {
  it("enrolls, pairs, authorizes, uploads, replays, and syncs through PostgreSQL while D1 throws", async () => {
    const originalEnvironment = environment.ENVIRONMENT;
    const originalEnrollmentMode = environment.ENROLLMENT_MODE;
    environment.ENVIRONMENT = "production";
    environment.ENROLLMENT_MODE = "open";
    const identityRequired = await worker.fetch(
      new Request("https://worker.test/api/v1/enroll", {
        method: "POST",
        headers: { origin: "https://worker.test", "content-type": "application/json" },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
        }),
      }),
      environment,
    );
    expect(identityRequired.status).toBe(401);
    environment.ENVIRONMENT = originalEnvironment;
    environment.ENROLLMENT_MODE = originalEnrollmentMode;

    const enrollment = await worker.fetch(
      new Request("https://worker.test/api/v1/enroll", {
        method: "POST",
        headers: { origin: "https://worker.test", "content-type": "application/json" },
        body: JSON.stringify({
          consentVersion: "privacy-safe-telemetry-v0.1",
          syntheticOnly: false,
        }),
      }),
      environment,
    );
    expect(enrollment.status).toBe(201);
    const enrollmentBody = await enrollment.json();
    const cookie = cookieFrom(enrollment);
    const participant = enrollmentBody.participantId;
    const csrfToken = enrollmentBody.csrfToken;

    const missingCsrf = await worker.fetch(
      new Request("https://worker.test/api/v1/me/device-pairings", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://worker.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v1.0",
        }),
      }),
      environment,
    );
    expect(missingCsrf.status).toBe(403);

    const pairingResponse = await worker.fetch(
      new Request("https://worker.test/api/v1/me/device-pairings", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://worker.test",
          "x-usage-monitor-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ongoingUpload: true,
          consentVersion: "ongoing-privacy-safe-telemetry-v1.0",
        }),
      }),
      environment,
    );
    expect(pairingResponse.status).toBe(201);
    const pairing = await pairingResponse.json();
    const deviceId = randomUUID();
    const deviceSecret = randomBytes(32).toString("base64url");
    const deviceSecretHash = Buffer.from(await deviceHash(deviceId, deviceSecret)).toString("hex");
    const deviceAuthorization = `Device um_device_${deviceId}.${deviceSecret}`;
    const claimResponse = await worker.fetch(
      new Request("https://worker.test/api/v1/device-pairings/claim", {
        method: "POST",
        headers: {
          authorization: `Pairing ${pairing.pairingCode}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ deviceId, deviceSecretHash }),
      }),
      environment,
    );
    expect(claimResponse.status).toBe(201);

    const raw = await routeV1Chunk();
    const envelopeDigest = await sha256Hex(raw);
    async function authorizeUpload() {
      const response = await worker.fetch(
        new Request("https://worker.test/api/v1/device/upload-authorizations", {
          method: "POST",
          headers: { authorization: deviceAuthorization, "content-type": "application/json" },
          body: JSON.stringify({
            envelopeDigest,
            contentLengthBytes: new TextEncoder().encode(raw).byteLength,
            contentType: "application/json",
            telemetrySchemaVersion: "telemetry-contribution-v1.0",
          }),
        }),
        environment,
      );
      expect(response.status).toBe(201);
      return (await response.json()).uploadAuthorization;
    }
    async function upload(authorization) {
      return worker.fetch(
        new Request("https://worker.test/api/v1/contributions", {
          method: "POST",
          headers: { authorization: `Upload ${authorization}`, "content-type": "application/json" },
          body: raw,
        }),
        environment,
      );
    }
    const first = await upload(await authorizeUpload());
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ status: "accepted", recordCounts: { declared: 1, accepted: 1 } });
    const replay = await upload(await authorizeUpload());
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ contributionId: firstBody.contributionId, replayed: true });

    const sync = await worker.fetch(
      new Request("https://worker.test/api/v1/device/sync/state", {
        headers: { authorization: deviceAuthorization, "cf-connecting-ip": "127.0.0.1" },
      }),
      environment,
    );
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ schemaVersion: "device-sync-state-v1.0" });
    expect(participant).toMatch(/^participant:/u);
    expect(d1Touches).toBe(0);
  });

  it("serves session and device sync state/manifest while D1 throws", async () => {
    const cookie = sessionCookie(session);
    const sessionResponse = await worker.fetch(
      new Request("https://worker.test/api/v1/session", {
        headers: { cookie },
      }),
      environment,
    );
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toMatchObject({
      participantId,
      csrfToken: session.csrfToken,
    });

    const authorization = `Device um_device_${deviceId}.${deviceSecret}`;
    const deviceHeaders = {
      authorization,
      "cf-connecting-ip": "127.0.0.1",
    };
    const state = await worker.fetch(
      new Request("https://worker.test/api/v1/device/sync/state", {
        headers: deviceHeaders,
      }),
      environment,
    );
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      schemaVersion: "device-sync-state-v1.0",
    });

    const manifest = await worker.fetch(
      new Request("https://worker.test/api/v1/device/sync/manifest?fromDay=2026-09-20&toDay=2026-09-21", {
        headers: deviceHeaders,
      }),
      environment,
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      schemaVersion: "device-sync-manifest-v1.0",
    });
    expect(d1Touches).toBe(0);
  });

  it("revokes the PostgreSQL session on logout while D1 remains untouched", async () => {
    const cookie = sessionCookie(session);
    const response = await worker.fetch(
      new Request("https://worker.test/api/v1/logout", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://worker.test",
          "sec-fetch-site": "same-origin",
          "x-usage-monitor-csrf": session.csrfToken,
        },
      }),
      environment,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ loggedOut: true });
    expect((await backend.authority.sessions.read(sessionId))?.state).toBe("revoked");
    expect(d1Touches).toBe(0);
  });

  it("runs the Google handoff claim, delivery, and one-use consume through PostgreSQL", async () => {
    const verifier = randomBytes(48).toString("base64url");
    const bindingHash = createHash("sha256").update(verifier).digest("hex");
    const state = randomBytes(48).toString("base64url");
    const claimId = randomBytes(48).toString("base64url");
    const proof = randomBytes(48).toString("base64url");
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const deliveryExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const identityLinkKey = "ab".repeat(32);

    await insertGoogleSignInHandoff(backend.identity, {
      state,
      codeVerifier: verifier,
      bindingHash,
      createdAt: nowIso,
      expiresAt,
    });
    expect(await readPendingGoogleSignInHandoff(
      backend.identity,
      state,
      nowIso,
      bindingHash,
    )).toEqual({ state, codeVerifier: verifier });
    expect(await claimPendingGoogleSignInHandoff(
      backend.identity,
      state,
      claimId,
      nowIso,
      new Date(Date.now() - 60_000).toISOString(),
    )).toEqual({ state, codeVerifier: verifier });
    expect(await completeGoogleSignInHandoff(
      backend.identity,
      state,
      claimId,
      identityLinkKey,
      proof,
      nowIso,
      deliveryExpiresAt,
    )).toBe(true);
    expect(await deliverGoogleSignInHandoff(
      backend.identity,
      state,
      nowIso,
      bindingHash,
    )).toEqual({ proof });
    expect(await consumeGoogleSignInHandoff(
      backend.identity,
      proof,
      bindingHash,
      nowIso,
    )).toEqual({ linkKeyHex: identityLinkKey });
    expect(await consumeGoogleSignInHandoff(
      backend.identity,
      proof,
      bindingHash,
      nowIso,
    )).toBeNull();
    expect(d1Touches).toBe(0);
  });

  it("rechecks Apple and Google proof expiry after a concurrent row lock", async () => {
    async function createDeliveredAppleHandoff() {
      const verifier = randomBytes(48).toString("base64url");
      const bindingHash = createHash("sha256").update(verifier).digest("hex");
      const state = randomBytes(48).toString("base64url");
      const claimId = randomBytes(48).toString("base64url");
      const proof = randomBytes(48).toString("base64url");
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const deliveryExpiresAtMs = Date.now() + 1_500;
      const deliveryExpiresAt = new Date(deliveryExpiresAtMs).toISOString();
      const identityLinkKey = "cd".repeat(32);
      const nonceHash = createHash("sha256").update(randomBytes(32)).digest("hex");

      await insertAppleSignInHandoff(backend.identity, {
        state,
        nonceHash,
        bindingHash,
        createdAt: nowIso,
        expiresAt,
      });
      expect(await readPendingAppleSignInHandoff(
        backend.identity,
        state,
        nowIso,
        bindingHash,
      )).toEqual({ state, nonceHash });
      expect(await claimPendingAppleSignInHandoff(
        backend.identity,
        state,
        claimId,
        nowIso,
        new Date(Date.now() - 60_000).toISOString(),
      )).toEqual({ state, nonceHash });
      expect(await completeAppleSignInHandoff(
        backend.identity,
        state,
        claimId,
        identityLinkKey,
        proof,
        nowIso,
        deliveryExpiresAt,
      )).toBe(true);
      expect(await deliverAppleSignInHandoff(
        backend.identity,
        state,
        nowIso,
        bindingHash,
      )).toEqual({ proof });
      return { bindingHash, proof, deliveryExpiresAtMs };
    }

    async function createDeliveredGoogleHandoff() {
      const verifier = randomBytes(48).toString("base64url");
      const bindingHash = createHash("sha256").update(verifier).digest("hex");
      const state = randomBytes(48).toString("base64url");
      const claimId = randomBytes(48).toString("base64url");
      const proof = randomBytes(48).toString("base64url");
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const deliveryExpiresAtMs = Date.now() + 1_500;
      const deliveryExpiresAt = new Date(deliveryExpiresAtMs).toISOString();
      const identityLinkKey = "ef".repeat(32);

      await insertGoogleSignInHandoff(backend.identity, {
        state,
        codeVerifier: verifier,
        bindingHash,
        createdAt: nowIso,
        expiresAt,
      });
      expect(await readPendingGoogleSignInHandoff(
        backend.identity,
        state,
        nowIso,
        bindingHash,
      )).toEqual({ state, codeVerifier: verifier });
      expect(await claimPendingGoogleSignInHandoff(
        backend.identity,
        state,
        claimId,
        nowIso,
        new Date(Date.now() - 60_000).toISOString(),
      )).toEqual({ state, codeVerifier: verifier });
      expect(await completeGoogleSignInHandoff(
        backend.identity,
        state,
        claimId,
        identityLinkKey,
        proof,
        nowIso,
        deliveryExpiresAt,
      )).toBe(true);
      expect(await deliverGoogleSignInHandoff(
        backend.identity,
        state,
        nowIso,
        bindingHash,
      )).toEqual({ proof });
      return { bindingHash, proof, deliveryExpiresAtMs };
    }

    async function expectExpiredAfterLock(
      tableName,
      proof,
      bindingHash,
      deliveryExpiresAtMs,
      consume,
    ) {
      const locker = await primary.connect();
      try {
        await locker.query("BEGIN");
        const locked = await locker.query(
          `SELECT state FROM "${primarySchema}"."${tableName}" WHERE proof = $1 FOR UPDATE`,
          [proof],
        );
        expect(locked.rowCount).toBe(1);
        const consuming = consume(proof, bindingHash, new Date().toISOString());
        // Prove the consume transaction reached the row lock while its
        // delivery deadline was still live. A fixed sleep alone could pass if
        // a broken implementation did not start until after expiry.
        const queryPattern = `%FROM "${primarySchema}"."${tableName}"%`;
        let waitingForRowLock = false;
        const pollUntil = deliveryExpiresAtMs - 100;
        while (Date.now() < pollUntil) {
          const activity = await locker.query(`SELECT wait_event_type, state
            FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND state = 'active'
              AND query LIKE $1`, [queryPattern]);
          if (activity.rowCount === 1) {
            waitingForRowLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waitingForRowLock).toBe(true);
        expect(Date.now()).toBeLessThan(deliveryExpiresAtMs);
        // Keep the row locked beyond the delivery deadline. The consume
        // transaction must acquire the row first, then evaluate clock_timestamp().
        await locker.query("SELECT pg_sleep(1.75)");
        await locker.query("ROLLBACK");
        expect(await consuming).toBeNull();
      } finally {
        await locker.query("ROLLBACK").catch(() => {});
        locker.release();
      }
    }

    const apple = await createDeliveredAppleHandoff();
    await expectExpiredAfterLock(
      "apple_signin_handoffs",
      apple.proof,
      apple.bindingHash,
      apple.deliveryExpiresAtMs,
      (proof, bindingHash, nowIso) => consumeAppleSignInHandoff(
        backend.identity,
        proof,
        bindingHash,
        nowIso,
      ),
    );

    const google = await createDeliveredGoogleHandoff();
    await expectExpiredAfterLock(
      "google_signin_handoffs",
      google.proof,
      google.bindingHash,
      google.deliveryExpiresAtMs,
      (proof, bindingHash, nowIso) => consumeGoogleSignInHandoff(
        backend.identity,
        proof,
        bindingHash,
        nowIso,
      ),
    );
    expect(d1Touches).toBe(0);
  });
});
