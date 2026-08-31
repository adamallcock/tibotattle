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
  it("repair receipts allow only the same current attempt or the immediate real predecessor", async () => {
    const fixture = await pair();
    const now = fixture.nowEpoch;
    const sessionId = await freshLoginSession(fixture.db, fixture.participantId, now);
    const firstPairing = await createDevicePairing(fixture.db, fixture.participantId, sessionId, CONSENT, now);
    const secondSecret = crypto.getRandomValues(new Uint8Array(32));
    const secondHash = await deviceSecretHash(fixture.deviceId, secondSecret);
    await claimDevicePairing(fixture.db, "Pairing " + firstPairing.pairingCode, fixture.deviceId,
      secondHash, now, {}, fixture.authorization);
    const recoveryPairing = await createDevicePairing(fixture.db, fixture.participantId, sessionId, CONSENT, now + 1);
    const thirdHash = await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32)));
    const recovery = await claimDevicePairing(fixture.db, "Pairing " + recoveryPairing.pairingCode, fixture.deviceId,
      thirdHash, now + 1, {}, fixture.authorization);
    expect(await claimDevicePairing(fixture.db, "Pairing " + recoveryPairing.pairingCode, fixture.deviceId,
      thirdHash, now + 2, {}, fixture.authorization)).toEqual(recovery);
    // The initial attempt is no longer current, even though its secrets remain
    // in the bounded journal. It cannot roll the device back.
    await expect(claimDevicePairing(fixture.db, "Pairing " + firstPairing.pairingCode, fixture.deviceId,
      secondHash, now + 2, {}, fixture.authorization)).rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    const later = now + DEFAULT_DEVICE_LIFECYCLE_POLICY.pairingIssueWindowMilliseconds + 1;
    const laterSession = await freshLoginSession(fixture.db, fixture.participantId, later);
    const newerPairing = await createDevicePairing(fixture.db, fixture.participantId, laterSession, CONSENT, later);
    await expect(claimDevicePairing(fixture.db, "Pairing " + newerPairing.pairingCode, fixture.deviceId,
      await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32))), later, {}, fixture.authorization))
      .rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    expect((await fixture.db.prepare("SELECT credential_generation FROM device_credentials WHERE id = ?")
      .bind(fixture.deviceId).first<{ credential_generation: number }>())?.credential_generation).toBe(3);
    await revokeParticipantDevice(fixture.db, fixture.participantId, fixture.deviceId);
    await expect(claimDevicePairing(fixture.db, "Pairing " + recoveryPairing.pairingCode, fixture.deviceId,
      thirdHash, now + 4, {}, fixture.authorization)).rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    expect((await fixture.db.prepare("SELECT state FROM device_credentials WHERE id = ?")
      .bind(fixture.deviceId).first<{ state: string }>())?.state).toBe("revoked");
  });

  it("fresh social recovery never accepts the immediate predecessor on another participant or a deleting owner", async () => {
    const fixture = await pair();
    const pairing = await createDevicePairing(fixture.db, fixture.participantId, fixture.sessionId, CONSENT, fixture.nowEpoch);
    const nextHash = await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32)));
    await claimDevicePairing(fixture.db, "Pairing " + pairing.pairingCode, fixture.deviceId,
      nextHash, fixture.nowEpoch, {}, fixture.authorization);
    const other = await participantFixture(fixture.nowEpoch);
    const foreignPairing = await createDevicePairing(fixture.db, other.participantId, other.sessionId, CONSENT, fixture.nowEpoch);
    await expect(claimDevicePairing(fixture.db, "Pairing " + foreignPairing.pairingCode, fixture.deviceId,
      await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32))), fixture.nowEpoch, {}, fixture.authorization))
      .rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    const ownPairing = await createDevicePairing(fixture.db, fixture.participantId, fixture.sessionId, CONSENT, fixture.nowEpoch + 1);
    await fixture.db.prepare("UPDATE participants SET state = 'deleting' WHERE id = ?").bind(fixture.participantId).run();
    await expect(claimDevicePairing(fixture.db, "Pairing " + ownPairing.pairingCode, fixture.deviceId,
      await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32))), fixture.nowEpoch + 1, {}, fixture.authorization))
      .rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    expect((await fixture.db.prepare("SELECT credential_generation FROM device_credentials WHERE id = ?")
      .bind(fixture.deviceId).first<{ credential_generation: number }>())?.credential_generation).toBe(2);
  });

  it("fresh pairing renews an expired-but-active device in place, preserving enrollment and consent", async () => {
    const now = Date.now();
    const fixture = await pair({ nowEpoch: now });
    // D1's admission triggers use their own wall clock. Age only the already
    // authenticated fixture instead of pretending an expired pairing can mint.
    await fixture.db.prepare(`UPDATE device_credentials
      SET issued_at = ?, social_verified_at = ?, expires_at = ? WHERE id = ?`).bind(
      new Date(now - 181 * 86_400_000).toISOString(), new Date(now - 181 * 86_400_000).toISOString(),
      new Date(now - 86_400_000).toISOString(), fixture.deviceId,
    ).run();
    const before = await fixture.db.prepare("SELECT issued_at, credential_generation FROM device_credentials WHERE id = ?")
      .bind(fixture.deviceId).first<{ issued_at: string; credential_generation: number }>();
    const namespace = await fixture.db.prepare("SELECT namespace FROM attribution_enrollments WHERE participant_id = ?")
      .bind(fixture.participantId).first<{ namespace: string }>();
    await expect(authenticateDevice(fixture.db, fixture.authorization)).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });
    const sessionId = await freshLoginSession(fixture.db, fixture.participantId, now);
    const pairing = await createDevicePairing(fixture.db, fixture.participantId, sessionId, CONSENT, now);
    const nextSecret = crypto.getRandomValues(new Uint8Array(32));
    const nextHash = await deviceSecretHash(fixture.deviceId, nextSecret);
    const renewed = await claimDevicePairing(fixture.db, `Pairing ${pairing.pairingCode}`,
      fixture.deviceId, nextHash, now, {}, fixture.authorization);
    expect(renewed.deviceId).toBe(fixture.deviceId);
    expect(await claimDevicePairing(fixture.db, `Pairing ${pairing.pairingCode}`,
      fixture.deviceId, nextHash, now, {}, fixture.authorization)).toEqual(renewed);
    const current = await fixture.db.prepare("SELECT issued_at, credential_generation, social_verified_at FROM device_credentials WHERE id = ?")
      .bind(fixture.deviceId).first<{ issued_at: string; credential_generation: number; social_verified_at: string }>();
    expect(current).toEqual({ issued_at: before!.issued_at, credential_generation: before!.credential_generation + 1,
      social_verified_at: new Date(now).toISOString() });
    expect(await fixture.db.prepare("SELECT namespace FROM attribution_enrollments WHERE participant_id = ?")
      .bind(fixture.participantId).first()).toEqual(namespace);
    expect((await authenticateDevice(fixture.db,
      `Device um_device_${fixture.deviceId}.${encodeBase64Url(nextSecret)}`, { nowEpoch: now + 1 })).deviceId).toBe(fixture.deviceId);
  });

  it("a reauthentication cannot renew a revoked credential or erase its revoked state", async () => {
    const fixture = await pair();
    const sessionId = await freshLoginSession(fixture.db, fixture.participantId, fixture.nowEpoch + 1);
    const pairing = await createDevicePairing(fixture.db, fixture.participantId, sessionId, CONSENT, fixture.nowEpoch + 1);
    await revokeParticipantDevice(fixture.db, fixture.participantId, fixture.deviceId);
    const nextHash = await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32)));
    await expect(claimDevicePairing(fixture.db, `Pairing ${pairing.pairingCode}`, fixture.deviceId,
      nextHash, fixture.nowEpoch + 2, {}, fixture.authorization)).rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    expect((await fixture.db.prepare("SELECT state FROM device_credentials WHERE id = ?")
      .bind(fixture.deviceId).first<{ state: string }>())?.state).toBe("revoked");
  });

  it("continuity proof cannot cross participants, survive deletion, or use a stale browser session", async () => {
    const fixture = await pair();
    const other = await participantFixture(fixture.nowEpoch + 1);
    const otherPairing = await createDevicePairing(other.db, other.participantId, other.sessionId, CONSENT, other.nowEpoch);
    const nextHash = await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32)));
    await expect(claimDevicePairing(fixture.db, `Pairing ${otherPairing.pairingCode}`, fixture.deviceId,
      nextHash, other.nowEpoch, {}, fixture.authorization)).rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    const staleNow = fixture.nowEpoch + 11 * 60_000;
    const stalePairing = await createDevicePairing(fixture.db, fixture.participantId, fixture.sessionId, CONSENT, staleNow);
    await expect(claimDevicePairing(fixture.db, `Pairing ${stalePairing.pairingCode}`, fixture.deviceId,
      nextHash, staleNow, {}, fixture.authorization)).rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    await fixture.db.prepare("DELETE FROM participants WHERE id = ?").bind(fixture.participantId).run();
    await expect(claimDevicePairing(fixture.db, `Pairing ${stalePairing.pairingCode}`, fixture.deviceId,
      nextHash, staleNow, {}, fixture.authorization)).rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    expect(await fixture.db.prepare("SELECT id FROM device_credentials WHERE id = ?").bind(fixture.deviceId).first()).toBeNull();
  });

  it("wrong previous proof leaves both credential and fresh pairing untouched", async () => {
    const fixture = await pair();
    const pairing = await createDevicePairing(fixture.db, fixture.participantId, fixture.sessionId, CONSENT, fixture.nowEpoch);
    const nextHash = await deviceSecretHash(fixture.deviceId, crypto.getRandomValues(new Uint8Array(32)));
    await expect(claimDevicePairing(fixture.db, `Pairing ${pairing.pairingCode}`, fixture.deviceId, nextHash,
      fixture.nowEpoch, {}, `Device um_device_${fixture.deviceId}.${encodeBase64Url(new Uint8Array(32))}`))
      .rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
    expect((await authenticateDevice(fixture.db, fixture.authorization, { nowEpoch: fixture.nowEpoch })).credentialGeneration).toBe(1);
    const states = await fixture.db.prepare("SELECT state FROM device_pairings WHERE participant_id = ? ORDER BY state")
      .bind(fixture.participantId).all<{ state: string }>();
    expect(states.results.map((row) => row.state)).toEqual(["consumed", "unused"]);
  });

  it("a consumed pairing retry does not report a revoked device as active", async () => {
    const base = await participantFixture();
    const pairing = await createDevicePairing(base.db, base.participantId, base.sessionId, CONSENT, base.nowEpoch);
    const deviceId = crypto.randomUUID();
    const hash = await deviceSecretHash(deviceId, crypto.getRandomValues(new Uint8Array(32)));
    await claimDevicePairing(base.db, `Pairing ${pairing.pairingCode}`, deviceId, hash, base.nowEpoch);
    await revokeParticipantDevice(base.db, base.participantId, deviceId);
    await expect(claimDevicePairing(base.db, `Pairing ${pairing.pairingCode}`, deviceId, hash, base.nowEpoch))
      .rejects.toMatchObject({ code: "PAIRING_AUTH_INVALID" });
  });

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

    const bounded = await pair({ nowEpoch: fixture.nowEpoch + 10_000 });
    const day = 24 * 60 * 60 * 1_000;
    const policy = { socialRecheckMaxAgeMilliseconds: 90 * day };
    const firstUse = await authenticateDevice(bounded.db, bounded.authorization, {
      nowEpoch: bounded.nowEpoch + 29 * day,
      policy,
    });
    expect(firstUse.expiresAt).toBe(
      new Date(bounded.nowEpoch + 59 * day).toISOString(),
    );
    const secondUse = await authenticateDevice(bounded.db, bounded.authorization, {
      nowEpoch: bounded.nowEpoch + 58 * day,
      policy,
    });
    expect(secondUse.expiresAt).toBe(
      new Date(bounded.nowEpoch + 88 * day).toISOString(),
    );
    const lastBoundedUse = await authenticateDevice(
      bounded.db,
      bounded.authorization,
      { nowEpoch: bounded.nowEpoch + 87 * day, policy },
    );
    expect(lastBoundedUse.expiresAt).toBe(
      new Date(bounded.nowEpoch + 90 * day).toISOString(),
    );
    const nextSecret = crypto.getRandomValues(new Uint8Array(32));
    const rotated = await rotateDeviceCredential(
      bounded.db,
      bounded.authorization,
      await deviceSecretHash(bounded.deviceId, nextSecret),
      crypto.randomUUID(),
      { nowEpoch: bounded.nowEpoch + 87 * day, policy },
    );
    expect(rotated.expiresAt).toBe(
      new Date(bounded.nowEpoch + 90 * day).toISOString(),
    );
    const nextAuthorization =
      `Device um_device_${bounded.deviceId}.${encodeBase64Url(nextSecret)}`;
    await expect(authenticateDevice(bounded.db, nextAuthorization, {
      nowEpoch: bounded.nowEpoch + 90 * day,
      policy,
    })).rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });
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
