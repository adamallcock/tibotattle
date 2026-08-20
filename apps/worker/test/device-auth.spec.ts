import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authenticateDevice,
  claimDevicePairing,
  createDevicePairingMaterial,
  createDevicePairing,
  createDeviceUploadAuthorization,
  claimDeviceUploadAuthorization,
  DEFAULT_DEVICE_LIFECYCLE_POLICY,
  devicePairingInsert,
  disconnectAuthenticatedDevice,
  listParticipantDevices,
  purgeStaleDeviceLifecycleRows,
  revokeParticipantDevice,
  rotateDeviceCredential,
} from "../src/device-auth";
import { DEVICE_CREDENTIAL_TTL_MILLISECONDS } from "../src/constants";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { createSessionMaterial, sessionInsert } from "../src/session";
import { handleRequest, runScheduledMaintenance } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

interface DeviceFixture {
  db: D1Database;
  participantId: string;
  sessionId: string;
  nowEpoch: number;
  deviceId: string;
  rawSecret: Uint8Array;
  authorization: string;
}

const CONSENT = "privacy-safe-telemetry-v0.1";
const bindings = (): TestBindings => env as TestBindings;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings().USAGE_MONITOR_DB, bindings().TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

async function deviceSecretHash(
  deviceId: string,
  rawSecret: Uint8Array,
): Promise<string> {
  const prefix = new TextEncoder().encode(
    `app-usagemonitor/device/v1\0${deviceId}\0`,
  );
  const input = new Uint8Array(prefix.byteLength + rawSecret.byteLength);
  input.set(prefix);
  input.set(rawSecret, prefix.byteLength);
  return sha256Hex(input);
}

async function participantFixture(nowEpoch = Date.now()): Promise<{
  db: D1Database;
  participantId: string;
  sessionId: string;
  nowEpoch: number;
}> {
  const db = bindings().USAGE_MONITOR_DB;
  const participantId = crypto.randomUUID();
  const session = await createSessionMaterial(participantId, nowEpoch);
  await db.prepare(
    `INSERT INTO participants (
      id, access_token_id, access_token_hash, recovery_token_id,
      recovery_token_hash, state, consent_version, consented_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(
    participantId,
    crypto.randomUUID(), new Uint8Array(32),
    crypto.randomUUID(), new Uint8Array(32),
    CONSENT,
    new Date(nowEpoch).toISOString(), new Date(nowEpoch).toISOString(),
  ).run();
  await sessionInsert(db, session).run();
  return { db, participantId, sessionId: session.id, nowEpoch };
}

async function pair(
  options: {
    nowEpoch?: number;
    policy?: Parameters<typeof createDevicePairing>[5];
  } = {},
): Promise<DeviceFixture> {
  const base = await participantFixture(options.nowEpoch);
  const pairing = await createDevicePairing(
    base.db,
    base.participantId,
    base.sessionId,
    CONSENT,
    base.nowEpoch,
    options.policy,
  );
  const deviceId = crypto.randomUUID();
  const rawSecret = crypto.getRandomValues(new Uint8Array(32));
  const hash = await deviceSecretHash(deviceId, rawSecret);
  await claimDevicePairing(
    base.db,
    `Pairing ${pairing.pairingCode}`,
    deviceId,
    hash,
    base.nowEpoch,
    options.policy,
  );
  return {
    ...base,
    deviceId,
    rawSecret,
    authorization: `Device um_device_${deviceId}.${encodeBase64Url(rawSecret)}`,
  };
}

async function issueAndClaim(
  fixture: Awaited<ReturnType<typeof participantFixture>>,
  nowEpoch: number,
  policy: Parameters<typeof createDevicePairing>[5],
): Promise<void> {
  const pairing = await createDevicePairing(
    fixture.db,
    fixture.participantId,
    fixture.sessionId,
    CONSENT,
    nowEpoch,
    policy,
  );
  const deviceId = crypto.randomUUID();
  const rawSecret = crypto.getRandomValues(new Uint8Array(32));
  await claimDevicePairing(
    fixture.db,
    `Pairing ${pairing.pairingCode}`,
    deviceId,
    await deviceSecretHash(deviceId, rawSecret),
    nowEpoch,
    policy,
  );
}

async function seedActiveDevice(
  fixture: Awaited<ReturnType<typeof participantFixture>>,
  nowEpoch: number,
  policy: Parameters<typeof createDevicePairing>[5],
): Promise<string> {
  const pairing = await createDevicePairing(
    fixture.db,
    fixture.participantId,
    fixture.sessionId,
    CONSENT,
    nowEpoch,
    policy,
  );
  const deviceId = crypto.randomUUID();
  const rawSecret = crypto.getRandomValues(new Uint8Array(32));
  await claimDevicePairing(
    fixture.db,
    `Pairing ${pairing.pairingCode}`,
    deviceId,
    await deviceSecretHash(deviceId, rawSecret),
    nowEpoch,
    policy,
  );
  return deviceId;
}

async function freshLoginSession(
  db: D1Database,
  participantId: string,
  nowEpoch: number,
): Promise<string> {
  const session = await createSessionMaterial(participantId, nowEpoch);
  await sessionInsert(db, session).run();
  return session.id;
}

describe("device lifecycle primitives", () => {
  it("atomically rotates a hash-only credential and makes same-attempt retry idempotent", async () => {
    const fixture = await pair();
    const nextSecret = crypto.getRandomValues(new Uint8Array(32));
    const nextHash = await deviceSecretHash(fixture.deviceId, nextSecret);
    const attempt = crypto.randomUUID();
    const first = await rotateDeviceCredential(
      fixture.db,
      fixture.authorization,
      nextHash,
      attempt,
      { nowEpoch: fixture.nowEpoch },
    );
    expect(first).toMatchObject({
      deviceId: fixture.deviceId,
      state: "active",
      scope: "upload_registration",
      commit: true,
      credentialGeneration: 2,
    });
    const nextAuthorization =
      `Device um_device_${fixture.deviceId}.${encodeBase64Url(nextSecret)}`;
    await expect(authenticateDevice(fixture.db, nextAuthorization, {
      nowEpoch: fixture.nowEpoch + 1,
    })).resolves.toMatchObject({
      deviceId: fixture.deviceId,
      credentialGeneration: 2,
    });
    await expect(rotateDeviceCredential(
      fixture.db,
      fixture.authorization,
      nextHash,
      attempt,
      { nowEpoch: fixture.nowEpoch + 2 },
    )).resolves.toMatchObject({ commit: true, credentialGeneration: 2 });
    await expect(authenticateDevice(fixture.db, fixture.authorization, {
      nowEpoch: fixture.nowEpoch + 3,
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });
    await expect(fixture.db.prepare(
      "SELECT state FROM device_credentials WHERE id = ?",
    ).bind(fixture.deviceId).first<{ state: string }>()).resolves.toEqual({
      state: "revoked",
    });
  });

  it("slides active expiry without bypassing idle or absolute social recheck", async () => {
    const fixture = await pair();
    const idlePolicy = { idleMilliseconds: 1000 };
    await expect(authenticateDevice(fixture.db, fixture.authorization, {
      nowEpoch: fixture.nowEpoch + 1001,
      policy: idlePolicy,
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });

    const fresh = await pair({ nowEpoch: fixture.nowEpoch + 10_000 });
    await expect(authenticateDevice(fresh.db, fresh.authorization, {
      nowEpoch: fresh.nowEpoch + 1,
      policy: { socialRecheckMaxAgeMilliseconds: 1 },
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });

    // Stated as multiples of the credential TTL, not as a day count, so the
    // property under test survives the TTL being repriced.
    const bounded = await pair({ nowEpoch: fixture.nowEpoch + 10_000 });
    const day = 24 * 60 * 60 * 1_000;
    const ttl = DEVICE_CREDENTIAL_TTL_MILLISECONDS;
    const policy = { socialRecheckMaxAgeMilliseconds: 3 * ttl };
    const firstUse = await authenticateDevice(bounded.db, bounded.authorization, {
      nowEpoch: bounded.nowEpoch + ttl - day,
      policy,
    });
    expect(firstUse.expiresAt).toBe(
      new Date(bounded.nowEpoch + 2 * ttl - day).toISOString(),
    );
    const secondUse = await authenticateDevice(bounded.db, bounded.authorization, {
      nowEpoch: bounded.nowEpoch + 2 * ttl - 2 * day,
      policy,
    });
    expect(secondUse.expiresAt).toBe(
      new Date(bounded.nowEpoch + 3 * ttl - 2 * day).toISOString(),
    );
    const lastBoundedUse = await authenticateDevice(
      bounded.db,
      bounded.authorization,
      { nowEpoch: bounded.nowEpoch + 3 * ttl - 3 * day, policy },
    );
    expect(lastBoundedUse.expiresAt).toBe(
      new Date(bounded.nowEpoch + 3 * ttl).toISOString(),
    );
    const nextSecret = crypto.getRandomValues(new Uint8Array(32));
    const rotated = await rotateDeviceCredential(
      bounded.db,
      bounded.authorization,
      await deviceSecretHash(bounded.deviceId, nextSecret),
      crypto.randomUUID(),
      { nowEpoch: bounded.nowEpoch + 3 * ttl - 3 * day, policy },
    );
    expect(rotated.expiresAt).toBe(
      new Date(bounded.nowEpoch + 3 * ttl).toISOString(),
    );
    const nextAuthorization =
      `Device um_device_${bounded.deviceId}.${encodeBase64Url(nextSecret)}`;
    await expect(authenticateDevice(bounded.db, nextAuthorization, {
      nowEpoch: bounded.nowEpoch + 3 * ttl,
      policy,
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });
  });

  it("keeps the idle window and the credential TTL answering the same question", async () => {
    // Both run from the same last authenticated use, so an idle window shorter
    // than the TTL would reject — and then sweep away — a device whose own
    // `expires_at` the service still reports as unexpired, and a longer one
    // would keep a device row past the credentials it can authorize.
    expect(DEFAULT_DEVICE_LIFECYCLE_POLICY.idleMilliseconds)
      .toBe(DEVICE_CREDENTIAL_TTL_MILLISECONDS);
    // No renewal may cross the absolute social-recheck horizon, so the TTL has
    // to sit inside it or every credential is capped from the moment it is
    // minted and the TTL stops meaning anything.
    expect(DEVICE_CREDENTIAL_TTL_MILLISECONDS)
      .toBeLessThan(DEFAULT_DEVICE_LIFECYCLE_POLICY.socialRecheckMaxAgeMilliseconds);

    // The coherence, exercised rather than asserted: a device dormant for just
    // under the TTL still authenticates, and the sweep leaves it alone.
    const fixture = await pair();
    const justInside = fixture.nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS - 1;
    await expect(purgeStaleDeviceLifecycleRows(fixture.db, {
      nowEpoch: justInside,
    })).resolves.toMatchObject({ devicesRevoked: 0 });
    await expect(authenticateDevice(fixture.db, fixture.authorization, {
      nowEpoch: justInside,
    })).resolves.toMatchObject({ deviceId: fixture.deviceId });

    // And one dormant past it is retired by both, in agreement.
    const lapsed = await pair();
    const justOutside = lapsed.nowEpoch + DEVICE_CREDENTIAL_TTL_MILLISECONDS;
    await expect(authenticateDevice(lapsed.db, lapsed.authorization, {
      nowEpoch: justOutside,
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });
    await expect(purgeStaleDeviceLifecycleRows(lapsed.db, {
      nowEpoch: justOutside,
    })).resolves.toMatchObject({ devicesRevoked: 1 });
  });

  it("caps pairing issuance and claims without increasing contributor count", async () => {
    const base = await participantFixture();
    const policy = {
      ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
      pairingIssueLimit: 3,
      activeDeviceLimit: 10,
      pairingClaimLimit: 10,
    };
    await issueAndClaim(base, base.nowEpoch, policy);
    await issueAndClaim(base, base.nowEpoch + 1, policy);
    await issueAndClaim(base, base.nowEpoch + 2, policy);
    await expect(createDevicePairing(
      base.db,
      base.participantId,
      base.sessionId,
      CONSENT,
      base.nowEpoch + 3,
      policy,
    )).rejects.toMatchObject({ code: "LIFECYCLE_BOUNDS_EXCEEDED" });
  });

  it("rejects a claim after the participant claim velocity budget", async () => {
    const base = await participantFixture();
    const policy = {
      ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
      pairingIssueLimit: 10,
      activeDeviceLimit: 10,
      pairingClaimLimit: 2,
    };
    const pairings = await Promise.all([0, 1, 2].map(() => createDevicePairing(
      base.db,
      base.participantId,
      base.sessionId,
      CONSENT,
      base.nowEpoch,
      policy,
    )));
    for (const pairing of pairings.slice(0, 2)) {
      const id = crypto.randomUUID();
      const secret = crypto.getRandomValues(new Uint8Array(32));
      await claimDevicePairing(
        base.db,
        `Pairing ${pairing.pairingCode}`,
        id,
        await deviceSecretHash(id, secret),
        base.nowEpoch,
        policy,
      );
    }
    const id = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await expect(claimDevicePairing(
      base.db,
      `Pairing ${pairings[2]!.pairingCode}`,
      id,
      await deviceSecretHash(id, secret),
      base.nowEpoch,
      policy,
    )).rejects.toMatchObject({ code: "LIFECYCLE_BOUNDS_EXCEEDED" });
  });

  it("disconnects without a browser session and purges stale authority", async () => {
    const fixture = await pair();
    const principal = await authenticateDevice(
      fixture.db,
      fixture.authorization,
      { nowEpoch: fixture.nowEpoch + 1 },
    );
    const upload = await createDeviceUploadAuthorization(
      fixture.db,
      principal,
      "a".repeat(64),
      1,
      fixture.nowEpoch,
    );
    await expect(disconnectAuthenticatedDevice(
      fixture.db,
      fixture.authorization,
    )).resolves.toEqual({ deviceId: fixture.deviceId, revoked: true });
    const uploadId = upload.uploadAuthorization.slice(
      "um_device_upload_".length,
    ).split(".", 1)[0]!;
    await expect(fixture.db.prepare(
      `SELECT device.state AS device_state, upload.state AS upload_state
         FROM device_credentials device
         JOIN device_upload_authorizations upload
           ON upload.issued_by_device_id = device.id
        WHERE device.id = ? AND upload.id = ?`,
    ).bind(fixture.deviceId, uploadId)
      .first<{ device_state: string; upload_state: string }>()).resolves.toEqual({
      device_state: "revoked",
      upload_state: "revoked",
    });

    const stale = await pair({ nowEpoch: fixture.nowEpoch + 10_000 });
    const stalePrincipal = await authenticateDevice(
      stale.db,
      stale.authorization,
      { nowEpoch: stale.nowEpoch + 1 },
    );
    await createDeviceUploadAuthorization(
      stale.db,
      stalePrincipal,
      "b".repeat(64),
      1,
      stale.nowEpoch,
    );
    await stale.db.prepare(
      "UPDATE device_credentials SET last_used_at = ? WHERE id = ?",
    ).bind(
      new Date(stale.nowEpoch - 86_400_000).toISOString(),
      stale.deviceId,
    ).run();
    const maintenance = await purgeStaleDeviceLifecycleRows(stale.db, {
      nowEpoch: stale.nowEpoch,
      policy: { idleMilliseconds: 60_000 },
    });
    expect(maintenance.devicesRevoked).toBe(1);
    expect(maintenance.uploadsRevoked).toBe(1);
  });

  it("revokes a consuming upload authorization when a participant removes a device", async () => {
    const fixture = await pair();
    const principal = await authenticateDevice(
      fixture.db,
      fixture.authorization,
      { nowEpoch: fixture.nowEpoch + 1 },
    );
    const upload = await createDeviceUploadAuthorization(
      fixture.db,
      principal,
      "b".repeat(64),
      2,
      fixture.nowEpoch + 1,
    );
    await claimDeviceUploadAuthorization(
      fixture.db,
      `Upload ${upload.uploadAuthorization}`,
      {
        envelopeDigest: "b".repeat(64),
        bodyBytes: 2,
        contentType: "application/json",
      },
    );
    await expect(revokeParticipantDevice(
      fixture.db,
      fixture.participantId,
      fixture.deviceId,
    )).resolves.toBe(true);
    const uploadId = upload.uploadAuthorization.slice(
      "um_device_upload_".length,
    ).split(".", 1)[0]!;
    await expect(fixture.db.prepare(
      `SELECT device.state AS device_state, upload.state AS upload_state,
              upload.consume_lease_expires_at AS consume_lease_expires_at
         FROM device_credentials device
         JOIN device_upload_authorizations upload
           ON upload.issued_by_device_id = device.id
        WHERE device.id = ? AND upload.id = ?`,
    ).bind(fixture.deviceId, uploadId).first<{
      device_state: string;
      upload_state: string;
      consume_lease_expires_at: string | null;
    }>()).resolves.toEqual({
      device_state: "revoked",
      upload_state: "revoked",
      consume_lease_expires_at: null,
    });
  });

  it("runs bounded device cleanup in scheduled maintenance", async () => {
    const fixture = await pair();
    const principal = await authenticateDevice(
      fixture.db,
      fixture.authorization,
      { nowEpoch: fixture.nowEpoch + 1 },
    );
    await createDeviceUploadAuthorization(
      fixture.db,
      principal,
      "c".repeat(64),
      1,
      fixture.nowEpoch + 1,
    );
    const expired = new Date(Date.now() - 1_000).toISOString();
    await fixture.db.prepare(
      `UPDATE device_credentials
          SET expires_at = ?, last_used_at = ?
        WHERE id = ?`,
    ).bind(expired, expired, fixture.deviceId).run();

    const result = await runScheduledMaintenance(bindings(), Date.now());
    expect(result).toMatchObject({
      staleDevicePairingsRevoked: 0,
      staleDeviceCredentialsRevoked: 1,
      staleDeviceUploadAuthorizationsRevoked: 1,
    });
    await expect(fixture.db.prepare(
      `SELECT device.state AS device_state, upload.state AS upload_state
         FROM device_credentials device
         JOIN device_upload_authorizations upload
           ON upload.issued_by_device_id = device.id
        WHERE device.id = ?`,
    ).bind(fixture.deviceId).first<{
      device_state: string;
      upload_state: string;
    }>()).resolves.toEqual({
      device_state: "revoked",
      upload_state: "revoked",
    });
  });

  it("exposes device self-disconnect without requiring an enabled upload flow", async () => {
    const fixture = await pair();
    const response = await handleRequest(
      new Request("https://example.test/api/v1/device/disconnect", {
        method: "POST",
        headers: { authorization: fixture.authorization },
      }),
      bindings(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      schemaVersion: "device-disconnect-v0.1",
      disconnected: true,
      deviceId: fixture.deviceId,
    });
    await expect(handleRequest(
      new Request("https://example.test/api/v1/device/disconnect", {
        method: "POST",
        headers: { authorization: fixture.authorization },
      }),
      bindings(),
    )).resolves.toMatchObject({ status: 200 });
  });

  it("keeps the pairing insert contract compatible with repository bootstrap", async () => {
    const fixture = await participantFixture();
    const material = await createDevicePairingMaterial(
      fixture.participantId,
      fixture.sessionId,
      CONSENT,
      fixture.nowEpoch,
    );
    const result = await devicePairingInsert(
      fixture.db,
      material,
      CONSENT,
    ).run();
    expect(result.meta.changes).toBe(1);
  });

  it("self-heals a capped re-pair by revoking the credential the login superseded", async () => {
    const t0 = Date.now();
    const base = await participantFixture(t0);
    const policy = {
      ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
      activeDeviceLimit: 3,
      pairingIssueLimit: 10,
      pairingClaimLimit: 10,
    };
    const oldest = await seedActiveDevice(base, t0, policy);
    const middle = await seedActiveDevice(base, t0 + 1, policy);
    const newest = await seedActiveDevice(base, t0 + 2, policy);

    // The person lost their local secret and signs in afresh to re-pair; the
    // new login post-dates every existing credential's last use.
    const loginEpoch = t0 + 10_000;
    const sessionId = await freshLoginSession(base.db, base.participantId, loginEpoch);
    const pairing = await createDevicePairing(
      base.db,
      base.participantId,
      sessionId,
      CONSENT,
      loginEpoch,
      policy,
    );
    expect(pairing.pairingCode).toMatch(/^um_pair_/u);

    const afterHeal = await base.db.prepare(
      `SELECT id, state FROM device_credentials
        WHERE participant_id = ? ORDER BY issued_at ASC`,
    ).bind(base.participantId).all<{ id: string; state: string }>();
    expect(afterHeal.results
      .filter((row) => row.state === "active").map((row) => row.id))
      .toEqual([middle, newest]);
    expect(afterHeal.results
      .filter((row) => row.state === "revoked").map((row) => row.id))
      .toEqual([oldest]);

    // Claiming the freshly minted pairing returns the account to exactly the
    // cap: three active credentials, never cap + 1.
    const reDeviceId = crypto.randomUUID();
    const reSecret = crypto.getRandomValues(new Uint8Array(32));
    await claimDevicePairing(
      base.db,
      `Pairing ${pairing.pairingCode}`,
      reDeviceId,
      await deviceSecretHash(reDeviceId, reSecret),
      loginEpoch,
      policy,
    );
    const counts = await base.db.prepare(
      `SELECT
         SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN state = 'revoked' THEN 1 ELSE 0 END) AS revoked
       FROM device_credentials WHERE participant_id = ?`,
    ).bind(base.participantId).first<{ active: number; revoked: number }>();
    expect(counts).toEqual({ active: 3, revoked: 1 });
  });

  it("returns the honest cap error when no credential predates the login", async () => {
    const t0 = Date.now();
    const base = await participantFixture(t0);
    const policy = {
      ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
      activeDeviceLimit: 3,
      pairingIssueLimit: 10,
      pairingClaimLimit: 10,
    };
    const loginEpoch = t0;
    const sessionId = await freshLoginSession(base.db, base.participantId, loginEpoch);
    // Three genuinely concurrent Macs, each used after this login began.
    const usedEpoch = loginEpoch + 5_000;
    await seedActiveDevice(base, usedEpoch, policy);
    await seedActiveDevice(base, usedEpoch + 1, policy);
    await seedActiveDevice(base, usedEpoch + 2, policy);

    await expect(createDevicePairing(
      base.db,
      base.participantId,
      sessionId,
      CONSENT,
      usedEpoch + 10,
      policy,
    )).rejects.toMatchObject({ code: "LIFECYCLE_BOUNDS_EXCEEDED" });

    const revoked = await base.db.prepare(
      `SELECT COUNT(*) AS n FROM device_credentials
        WHERE participant_id = ? AND state = 'revoked'`,
    ).bind(base.participantId).first<{ n: number }>();
    expect(revoked?.n).toBe(0);
  });

  it("keeps same-device re-pair idempotent without consuming a slot or revoking", async () => {
    const t0 = Date.now();
    const base = await participantFixture(t0);
    const policy = {
      ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
      activeDeviceLimit: 3,
      pairingIssueLimit: 10,
      pairingClaimLimit: 10,
    };
    const pairing = await createDevicePairing(
      base.db,
      base.participantId,
      base.sessionId,
      CONSENT,
      t0,
      policy,
    );
    const deviceId = crypto.randomUUID();
    const rawSecret = crypto.getRandomValues(new Uint8Array(32));
    const hash = await deviceSecretHash(deviceId, rawSecret);
    const firstClaim = await claimDevicePairing(
      base.db,
      `Pairing ${pairing.pairingCode}`,
      deviceId,
      hash,
      t0,
      policy,
    );
    // Re-claiming the same pairing with the same device id must dedupe via the
    // (pairing_id, claimed_device_id) replay path, not consume a second slot.
    const replayClaim = await claimDevicePairing(
      base.db,
      `Pairing ${pairing.pairingCode}`,
      deviceId,
      hash,
      t0 + 1,
      policy,
    );
    expect(replayClaim).toEqual(firstClaim);

    const counts = await base.db.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN state = 'revoked' THEN 1 ELSE 0 END) AS revoked
       FROM device_credentials WHERE participant_id = ?`,
    ).bind(base.participantId).first<{
      total: number;
      active: number;
      revoked: number;
    }>();
    expect(counts).toEqual({ total: 1, active: 1, revoked: 0 });
  });

  it("records the self-heal revocation in the device list and revokes its uploads", async () => {
    const t0 = Date.now();
    const base = await participantFixture(t0);
    const policy = {
      ...DEFAULT_DEVICE_LIFECYCLE_POLICY,
      activeDeviceLimit: 3,
      pairingIssueLimit: 10,
      pairingClaimLimit: 10,
    };
    const oldest = await seedActiveDevice(base, t0, policy);
    await seedActiveDevice(base, t0 + 1, policy);
    await seedActiveDevice(base, t0 + 2, policy);

    // A pending upload authorization on the superseded device must be revoked
    // with it, exactly as every other credential-revoke path in this file does.
    const upload = await createDeviceUploadAuthorization(
      base.db,
      {
        deviceId: oldest,
        participantId: base.participantId,
        participantConsentVersion: CONSENT,
        expiresAt: new Date(t0).toISOString(),
        credentialGeneration: 1,
        socialVerifiedAt: new Date(t0).toISOString(),
      },
      "a".repeat(64),
      1,
      t0 + 3,
    );
    const uploadId = upload.uploadAuthorization
      .slice("um_device_upload_".length).split(".", 1)[0]!;

    const loginEpoch = t0 + 10_000;
    const sessionId = await freshLoginSession(base.db, base.participantId, loginEpoch);
    await createDevicePairing(
      base.db,
      base.participantId,
      sessionId,
      CONSENT,
      loginEpoch,
      policy,
    );

    const devices = await listParticipantDevices(base.db, base.participantId);
    const revokedEntry = devices.find((device) => device.deviceId === oldest);
    expect(revokedEntry?.state).toBe("revoked");
    expect(revokedEntry?.revokedAt).toBe(new Date(loginEpoch).toISOString());
    expect(devices.filter((device) => device.state === "active")).toHaveLength(2);

    const uploadState = await base.db.prepare(
      "SELECT state FROM device_upload_authorizations WHERE id = ?",
    ).bind(uploadId).first<{ state: string }>();
    expect(uploadState?.state).toBe("revoked");
  });
});
