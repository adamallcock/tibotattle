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
});
