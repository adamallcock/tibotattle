import { beforeAll, afterAll, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { createPostgresTelemetryAuthorityBackend } from "../src/postgres-telemetry-authority-backend.ts";
import { createPostgresIdentityHandoffBackend } from "../src/postgres-identity-handoff-backend.ts";
import { readTelemetryV11Capabilities } from "../../src/contribution/telemetry-v11-sync.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const hash = (value) => Buffer.alloc(32, value);
const baseEpoch = Date.now();
const now = new Date(baseEpoch).toISOString();
const later = new Date(baseEpoch + 60 * 60 * 1000).toISOString();
const muchLater = new Date(baseEpoch + 2 * 60 * 60 * 1000).toISOString();
const past = new Date(baseEpoch - 60 * 60 * 1000).toISOString();
const participantId = "authority-participant";
const sessionId = "authority-session";
const deviceId = "authority-device";
const pairingId = "authority-pairing";
const sessionDigest = digest("session-envelope");
const deviceDigest = digest("device-envelope");

let admin;
let pool;
let database;
let primarySchema;
let ledgerSchema;
let authority;
let identity;

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function applyOperationalMigrations() {
  const root = join(process.cwd(), "postgres", "migrations");
  for (const role of ["primary", "ledger"]) {
    const schema = role === "primary" ? primarySchema : ledgerSchema;
    const files = (await readdir(join(root, role))).sort();
    for (const name of files) {
      const sql = await readFile(join(root, role, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      await pool.query("BEGIN");
      try {
        await pool.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
        await pool.query(sql);
        await pool.query(
          `INSERT INTO "${schema}"."_tibotattle_migration_history"
             (version, name, checksum_sha256) VALUES ($1, $2, $3)`,
          [Number(name.slice(0, 4)), name, checksum],
        );
        await pool.query("COMMIT");
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  }
}

async function clearAuthority() {
  await pool.query(`TRUNCATE
    "${primarySchema}".telemetry_v12_records,
    "${primarySchema}".telemetry_v12_chunks,
    "${primarySchema}".telemetry_v12_day_manifests,
    "${primarySchema}".telemetry_v12_device_capabilities,
    "${primarySchema}".accountless_v12_device_authorizations,
    "${primarySchema}".telemetry_v11_records,
    "${primarySchema}".telemetry_v11_chunks,
    "${primarySchema}".telemetry_v11_day_manifests,
    "${primarySchema}".telemetry_v11_device_consents,
    "${primarySchema}".device_upload_authorizations,
    "${primarySchema}".device_credentials,
    "${primarySchema}".device_pairings,
    "${primarySchema}".upload_authorizations,
    "${primarySchema}".web_sessions,
    "${primarySchema}".participants CASCADE`);
  await pool.query(`INSERT INTO "${primarySchema}".participants
    (id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
     recovery_token_hash, state, consent_version, consented_at, created_at)
    VALUES ($1, 'social', 'access-authority', $2, 'recovery-authority', $3,
      'active', 'ongoing-privacy-safe-telemetry-v1.0', $4, $4)`,
  [participantId, hash(1), hash(2), now]);
}

async function insertSession() {
  await authority.sessions.insert({
    id: sessionId,
    participantId,
    secretHash: new Uint8Array(hash(3)),
    csrfHash: new Uint8Array(hash(4)),
    scope: "personal",
    issuedAt: now,
    expiresAt: muchLater,
  });
}

async function insertSessionGrant(id = "session-grant") {
  await authority.sessionUploads.insert({
    id,
    participantId,
    issuedBySessionId: sessionId,
    secretHash: new Uint8Array(hash(5)),
    envelopeDigest: sessionDigest,
    bodyBytes: 32,
    contentType: "application/json",
    issuedAt: now,
    expiresAt: muchLater,
  });
  return id;
}

async function insertPairingAndDevice() {
  await authority.devices.insertPairing({
    id: pairingId,
    participantId,
    issuedBySessionId: sessionId,
    secretHash: new Uint8Array(hash(6)),
    consentVersion: "ongoing-privacy-safe-telemetry-v1.0",
    transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.0",
    issuedAt: now,
    expiresAt: muchLater,
  });
  expect(await authority.devices.claimPairing({
    pairingId,
    participantId,
    now,
    device: {
      id: deviceId,
      participantId,
      pairingId,
      secretHash: new Uint8Array(hash(7)),
      issuedAt: now,
      expiresAt: muchLater,
      lastUsedAt: now,
      socialVerifiedAt: now,
      credentialGeneration: 1,
    },
  })).toBe(true);
}

async function insertTransportCapabilityRows() {
  await pool.query(`INSERT INTO "${primarySchema}".attribution_enrollments
    (participant_id, namespace, created_at) VALUES ($1, $2, $3)`,
  [participantId, "e".repeat(64), now]);
  await pool.query(`INSERT INTO "${primarySchema}".telemetry_transport_participant_floors
    (participant_id, minimum_rank, revision, changed_at) VALUES ($1, 1, 0, $2)`,
  [participantId, now]);
}

async function insertDeviceGrant(id = "device-grant") {
  await authority.devices.insertUpload({
    id,
    participantId,
    issuedByDeviceId: deviceId,
    secretHash: new Uint8Array(hash(8)),
    envelopeDigest: deviceDigest,
    bodyBytes: 64,
    contentType: "application/json",
    issuedAt: now,
    expiresAt: muchLater,
  });
  return id;
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
    max: 1,
  };
  admin = new pg.Pool(options);
  database = `tibotattle_authority_${randomBytes(10).toString("hex")}`;
  primarySchema = `tibotattle_${randomBytes(5).toString("hex")}`;
  ledgerSchema = `tibotattle_ledger_${randomBytes(5).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${database}"`);
  pool = new pg.Pool({ ...options, database, max: 3 });
  await pool.query(`CREATE SCHEMA "${primarySchema}"`);
  await pool.query(`CREATE SCHEMA "${ledgerSchema}"`);
  await applyOperationalMigrations();
  authority = createPostgresTelemetryAuthorityBackend(pool, {
    primarySchema,
    ledgerSchema,
  });
  identity = createPostgresIdentityHandoffBackend(pool, {
    primarySchema,
    ledgerSchema,
  });
});

afterAll(async () => {
  await pool?.end();
  if (database) await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
  await admin?.end();
});

it("creates, claims, consumes, and fences a social session grant", async () => {
  await clearAuthority();
  await insertSession();
  expect((await authority.sessions.read(sessionId))?.participantId).toBe(participantId);
  const id = await insertSessionGrant();
  const lease = await authority.sessionUploads.claim({
    authorizationId: id,
    participantId,
    envelopeDigest: sessionDigest,
    bodyBytes: 32,
    contentType: "application/json",
    leaseExpiresAt: later,
    now,
  });
  expect(lease).toBe(later);
  expect(await authority.sessionUploads.claim({
    authorizationId: id,
    participantId,
    envelopeDigest: sessionDigest,
    bodyBytes: 32,
    contentType: "application/json",
    leaseExpiresAt: muchLater,
    now,
  })).toBeNull();
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "contribution-a", leaseExpiresAt: muchLater, now,
  })).toBe(false);
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "contribution-a", leaseExpiresAt: later, now,
  })).toBe(true);
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "contribution-a", leaseExpiresAt: later, now,
  })).toBe(true);
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "contribution-b", leaseExpiresAt: later, now,
  })).toBe(false);
});

it("reclaims an expired session lease and fences the old worker", async () => {
  await clearAuthority();
  await insertSession();
  const id = await insertSessionGrant("session-expiry-grant");
  expect(await authority.sessionUploads.claim({
    authorizationId: id, participantId, envelopeDigest: sessionDigest, bodyBytes: 32,
    contentType: "application/json", leaseExpiresAt: later, now,
  })).toBe(later);
  await pool.query(`UPDATE "${primarySchema}".upload_authorizations
    SET consume_lease_expires_at = $1 WHERE id = $2`, [past, id]);
  expect(await authority.sessionUploads.claim({
    authorizationId: id, participantId, envelopeDigest: sessionDigest, bodyBytes: 32,
    contentType: "application/json", leaseExpiresAt: muchLater, now,
  })).toBe(muchLater);
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "stale", leaseExpiresAt: later, now,
  })).toBe(false);
  expect(await authority.sessionUploads.abandon({
    authorizationId: id, participantId, leaseExpiresAt: later, now,
  })).toBe(false);
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "current", leaseExpiresAt: muchLater, now,
  })).toBe(true);
});

it("rechecks participant revocation after a blocked claim lock", async () => {
  await clearAuthority();
  await insertSession();
  const id = await insertSessionGrant("session-revoke-race");
  const revoker = await pool.connect();
  try {
    await revoker.query("BEGIN");
    await revoker.query(`UPDATE "${primarySchema}".participants SET state = 'deleting' WHERE id = $1`, [participantId]);
    const blockedClaim = authority.sessionUploads.claim({
      authorizationId: id, participantId, envelopeDigest: sessionDigest, bodyBytes: 32,
      contentType: "application/json", leaseExpiresAt: later, now,
    });
    await sleep(100);
    await revoker.query("COMMIT");
    expect(await blockedClaim).toBeNull();
  } finally {
    await revoker.query("ROLLBACK").catch(() => {});
    revoker.release();
  }
});

it("creates, claims, consumes, and fences a device grant across revocation", async () => {
  await clearAuthority();
  await insertSession();
  await insertPairingAndDevice();
  const id = await insertDeviceGrant();
  const lease = await authority.devices.claimUpload({
    authorizationId: id, participantId, deviceId, envelopeDigest: deviceDigest,
    bodyBytes: 64, contentType: "application/json", leaseExpiresAt: later, now,
  });
  expect(lease).toBe(later);
  expect(await authority.devices.recordUploadReceipt({
    authorizationId: id, participantId, deviceId, contributionId: "device-contribution",
    leaseExpiresAt: later, now,
  })).toBe(true);
  expect(await authority.devices.recordUploadReceipt({
    authorizationId: id, participantId, deviceId, contributionId: "other",
    leaseExpiresAt: later, now,
  })).toBe(false);

  const raceId = await insertDeviceGrant("device-revoke-race");
  const revoker = await pool.connect();
  try {
    await revoker.query("BEGIN");
    await revoker.query(`UPDATE "${primarySchema}".device_credentials SET state = 'revoked', revoked_at = $1 WHERE id = $2`, [now, deviceId]);
    const blockedClaim = authority.devices.claimUpload({
      authorizationId: raceId, participantId, deviceId, envelopeDigest: deviceDigest,
      bodyBytes: 64, contentType: "application/json", leaseExpiresAt: later, now,
    });
    await sleep(100);
    await revoker.query("COMMIT");
    expect(await blockedClaim).toBeNull();
  } finally {
    await revoker.query("ROLLBACK").catch(() => {});
    revoker.release();
  }
});

it("does not double-consume when the receipt commit acknowledgement is lost", async () => {
  await clearAuthority();
  await insertSession();
  const id = await insertSessionGrant("session-ack-loss");
  expect(await authority.sessionUploads.claim({
    authorizationId: id, participantId, envelopeDigest: sessionDigest, bodyBytes: 32,
    contentType: "application/json", leaseExpiresAt: later, now,
  })).toBe(later);
  let loseCommit = true;
  const uncertainPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          const result = await client.query(text, values);
          if (text === "COMMIT" && loseCommit) {
            loseCommit = false;
            throw new Error("synthetic acknowledgement loss");
          }
          return result;
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
  const uncertain = createPostgresTelemetryAuthorityBackend(uncertainPool, { primarySchema, ledgerSchema });
  await expect(uncertain.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "ack-loss", leaseExpiresAt: later, now,
  })).rejects.toMatchObject({ code: "unavailable" });
  expect((await authority.sessionUploads.read(id))?.state).toBe("consumed");
  expect(await authority.sessionUploads.recordReceipt({
    authorizationId: id, participantId, contributionId: "ack-loss", leaseExpiresAt: later, now,
  })).toBe(true);
});

it("keeps the legacy capability parser compatible while v1.2 moves from staged to accepted", async () => {
  await clearAuthority();
  await insertSession();
  await insertPairingAndDevice();
  await insertTransportCapabilityRows();
  const deviceAuthorization = "Device um_device_550e8400-e29b-41d4-a716-446655440000." + "A".repeat(43);
  const readLegacyCapabilities = async () => {
    const value = await authority.transport.capabilities({
      principal: { participantId, deviceId },
      destinationOrigin: "https://example.test",
      now,
      schemaVersion: "telemetry-contribution-v1.1",
    });
    return readTelemetryV11Capabilities({
      serverBaseUrl: "https://example.test",
      deviceAuthorization,
      clock: () => baseEpoch,
      fetchImpl: async (url) => {
        expect(url.pathname).toBe("/api/v1/device/sync-capabilities");
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { "cache-control": "no-store", "content-type": "application/json" },
        });
      },
    });
  };

  const staged = await readLegacyCapabilities();
  expect(staged.schemaVersion).toBe("device-sync-capabilities-v1.1");
  expect(staged.formats).toHaveLength(4);
  expect(staged.formats.map((format) => format.rank)).toEqual([1, 2, 10, 11]);
  expect(staged.formats.find((format) => format.rank === 11)?.lifecycle).toBe("staged");

  await pool.query(`UPDATE "${primarySchema}".telemetry_transport_formats
    SET lifecycle = 'accepted' WHERE format_rank = 12`);
  const accepted = await readLegacyCapabilities();
  expect(accepted.formats).toHaveLength(4);
  expect(accepted.formats.find((format) => format.rank === 11)?.lifecycle).toBe("staged");

  const successor = await authority.transport.capabilities({
    principal: { participantId, deviceId },
    destinationOrigin: "https://example.test",
    now,
    schemaVersion: "telemetry-contribution-v1.2",
  });
  expect(successor.formats).toHaveLength(5);
  expect(successor.formats.find((format) => format.rank === 12)?.lifecycle).toBe("accepted");
});

it("keeps Apple identity handoffs fenced and bounded", async () => {
  await clearAuthority();
  const state = randomUUID();
  const nonceHash = "a".repeat(64);
  const bindingHash = "b".repeat(64);
  const identityLinkKey = "c".repeat(64);
  const proof = "d".repeat(64);
  await identity.apple.insert({ state, nonceHash, bindingHash, createdAt: now, expiresAt: later });
  expect(await identity.apple.readPending({ state, nowIso: now })).toEqual({ state, nonceHash });
  expect(await identity.apple.claim({ state, claimId: "claim-one", nowIso: now, staleClaimBeforeIso: past }))
    .toEqual({ state, nonceHash });
  expect(await identity.apple.complete({
    state, claimId: "stale-claim", identityLinkKey, proof, nowIso: now, deliveryExpiresAtIso: later,
  })).toBe(false);
  expect(await identity.apple.complete({
    state, claimId: "claim-one", identityLinkKey, proof, nowIso: now, deliveryExpiresAtIso: later,
  })).toBe(true);
  expect(await identity.apple.deliver({ state, nowIso: now, bindingHash })).toEqual({ proof });
  expect(await identity.apple.deliver({ state, nowIso: now, bindingHash })).toEqual({ proof });
  const expired = randomUUID();
  await identity.apple.insert({ state: expired, nonceHash, bindingHash, createdAt: past, expiresAt: past });
  expect(await identity.apple.purge({ nowIso: now, maximumRows: 10 })).toBe(1);
});

it("denies an Apple claim whose lock wait carries it past expiry", async () => {
  await clearAuthority();
  const state = randomUUID();
  const expiresAt = new Date(Date.now() + 150).toISOString();
  await identity.apple.insert({
    state,
    nonceHash: "a".repeat(64),
    bindingHash: "b".repeat(64),
    createdAt: new Date().toISOString(),
    expiresAt,
  });

  const locker = await pool.connect();
  let claim;
  try {
    await locker.query("BEGIN");
    await locker.query(`SELECT state FROM "${primarySchema}".apple_signin_handoffs
      WHERE state = $1 FOR UPDATE`, [state]);
    claim = identity.apple.claim({
      state,
      claimId: "late-claim",
      nowIso: now,
      staleClaimBeforeIso: past,
    });
    await sleep(350);
    await locker.query("COMMIT");
  } finally {
    locker.release();
  }
  await expect(claim).resolves.toBeNull();
});
