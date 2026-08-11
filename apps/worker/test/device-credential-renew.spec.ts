import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authenticateDevice,
  claimDevicePairing,
  createDevicePairing,
} from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { createSessionMaterial, sessionInsert } from "../src/session";
import { handleRequest } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
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

async function pairDevice(nowEpoch = Date.now()): Promise<{
  db: D1Database;
  deviceId: string;
  rawSecret: Uint8Array;
  authorization: string;
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
  const pairing = await createDevicePairing(
    db, participantId, session.id, CONSENT, nowEpoch,
  );
  const deviceId = crypto.randomUUID();
  const rawSecret = crypto.getRandomValues(new Uint8Array(32));
  await claimDevicePairing(
    db,
    `Pairing ${pairing.pairingCode}`,
    deviceId,
    await deviceSecretHash(deviceId, rawSecret),
    nowEpoch,
  );
  return {
    db,
    deviceId,
    rawSecret,
    authorization: `Device um_device_${deviceId}.${encodeBase64Url(rawSecret)}`,
    nowEpoch,
  };
}

function renewRequest(authorization: string, body: unknown): Request {
  return new Request("https://example.test/api/v1/device/credential/renew", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("device credential renew route", () => {
  it("rotates a valid credential in place and supersedes the old secret", async () => {
    const fixture = await pairDevice();
    const nextSecret = crypto.getRandomValues(new Uint8Array(32));
    const nextHash = await deviceSecretHash(fixture.deviceId, nextSecret);
    const attemptId = crypto.randomUUID();

    const response = await handleRequest(
      renewRequest(fixture.authorization, {
        nextDeviceSecretHash: nextHash,
        rotationAttemptId: attemptId,
      }),
      bindings(),
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      schemaVersion: string;
      deviceId: string;
      state: string;
      scope: string;
      expiresAt: string;
      credentialGeneration: number;
      commit: boolean;
    };
    expect(payload).toMatchObject({
      schemaVersion: "device-credential-renewal-v1.0",
      deviceId: fixture.deviceId,
      state: "active",
      scope: "upload_registration",
      credentialGeneration: 2,
      commit: true,
    });
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(fixture.nowEpoch);

    // The freshly rotated secret authenticates; the superseded one does not.
    // The route rotates at real time, so authenticate at real time too.
    const nextAuthorization =
      `Device um_device_${fixture.deviceId}.${encodeBase64Url(nextSecret)}`;
    await expect(authenticateDevice(fixture.db, nextAuthorization)).resolves
      .toMatchObject({
        deviceId: fixture.deviceId,
        credentialGeneration: 2,
      });
    await expect(authenticateDevice(fixture.db, fixture.authorization))
      .rejects.toMatchObject({ code: "DEVICE_AUTH_INVALID" });

    // Still a single device row — renewal replaced in place, it did not
    // consume a new active-device slot.
    await expect(fixture.db.prepare(
      "SELECT COUNT(*) AS total FROM device_credentials WHERE id = ?",
    ).bind(fixture.deviceId).first<{ total: number }>())
      .resolves.toEqual({ total: 1 });
  });

  it("makes the same rotation attempt idempotent", async () => {
    const fixture = await pairDevice();
    const nextSecret = crypto.getRandomValues(new Uint8Array(32));
    const nextHash = await deviceSecretHash(fixture.deviceId, nextSecret);
    const attemptId = crypto.randomUUID();
    const body = { nextDeviceSecretHash: nextHash, rotationAttemptId: attemptId };

    const first = await handleRequest(
      renewRequest(fixture.authorization, body), bindings(),
    );
    expect(first.status).toBe(200);
    const second = await handleRequest(
      renewRequest(fixture.authorization, body), bindings(),
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      deviceId: fixture.deviceId,
      commit: true,
      credentialGeneration: 2,
    });
  });

  it("rejects an invalid or unknown device bearer", async () => {
    await pairDevice();
    const bogus =
      `Device um_device_${crypto.randomUUID()}.${encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(32)),
      )}`;
    const response = await handleRequest(
      renewRequest(bogus, {
        nextDeviceSecretHash: "a".repeat(64),
        rotationAttemptId: crypto.randomUUID(),
      }),
      bindings(),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a malformed rotation body", async () => {
    const fixture = await pairDevice();
    const response = await handleRequest(
      renewRequest(fixture.authorization, { nextDeviceSecretHash: "0".repeat(64) }),
      bindings(),
    );
    expect(response.status).toBe(400);
  });
});
