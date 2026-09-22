import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import worker from "../src/index.ts";
import { createPostgresWorkerBackend } from "../src/backend-composition.ts";
import { deviceHash } from "../src/device-auth.ts";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  claimPendingGoogleSignInHandoff,
  completeGoogleSignInHandoff,
  consumeGoogleSignInHandoff,
  deliverGoogleSignInHandoff,
  insertGoogleSignInHandoff,
  readPendingGoogleSignInHandoff,
} from "../src/identity-handoff-repository.ts";
import {
  createSessionMaterialFromSecret,
  sessionCookie,
} from "../src/session.ts";

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

async function applyMigrations() {
  await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: primary });
  await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledger });
}

function rateLimiter() {
  return { limit: async () => ({ success: true }) };
}

function throwingD1() {
  return new Proxy({}, {
    get() {
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
    USAGE_MONITOR_DB: throwingD1(),
    DELETION_LEDGER: throwingD1(),
    ENROLLMENT_RATE_LIMIT: rateLimiter(),
    RECOVERY_RATE_LIMIT: rateLimiter(),
    CLIENT_ATTEMPT_RATE_LIMIT: rateLimiter(),
    PUBLIC_READ_RATE_LIMIT: rateLimiter(),
    IDENTITY_LINK_SECRET: "synthetic-route-secret-012345678901234567890123",
  };
}

beforeAll(async () => {
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

describe("PostgreSQL-backed Worker route composition", () => {
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
});
