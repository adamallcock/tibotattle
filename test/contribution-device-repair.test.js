import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimContributionDevicePairing } from "../src/contribution-device-client.js";
import { ensureContributionDeviceCapability } from "../src/contribution-device-capability.js";

const ORIGIN = "https://usage.example";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const PAIRING = "um_pair_22222222-2222-4222-8222-222222222222." + "A".repeat(43);
const EXPIRY = "2027-02-01T12:00:00.000Z";
const deviceHash = (value) => createHash("sha256").update("app-usagemonitor/device/v1\0")
  .update(DEVICE).update("\0").update(value).digest("hex");
const response = (payload, status = 201) => new Response(JSON.stringify(payload), {
  status, headers: { "cache-control": "no-store", "content-type": "application/json" },
});
const continuity = () => response({ error: { code: "DEVICE_CONTINUITY_REQUIRED" } }, 409);
const receipt = () => response({ deviceId: DEVICE, state: "active", scope: "upload_registration", expiresAt: EXPIRY });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "tibotattle-pairing-repair-"));
  let current = null;
  const leased = [];
  const replacements = [];
  const backend = {
    async read() { const value = current && Buffer.from(current); if (value) leased.push(value); return value; },
    async createIfMissing(_capability, secret) { if (current) return "existing"; current = Buffer.from(secret); return "created"; },
    async deleteExact() { throw new Error("Repair must not delete credentials"); },
    async replaceExact(_capability, expected, next) {
      if (!current?.equals(expected)) return "conflict";
      replacements.push({ expected: Buffer.from(expected), next: Buffer.from(next) });
      current.fill(0); current = Buffer.from(next); return "replaced";
    },
  };
  const stateFile = join(directory, "binding.json");
  try {
    await ensureContributionDeviceCapability({ backend, origin: ORIGIN, stateFile,
      generateDeviceId: () => DEVICE, generateSecret: () => Buffer.alloc(32, 19),
      clock: () => Date.parse("2026-01-01T00:00:00.000Z") });
    await run({ capabilityOptions: { backend, stateFile }, current: () => Buffer.from(current), replacements, leased, directory });
  } finally {
    current?.fill(0);
    for (const value of replacements) { value.expected.fill(0); value.next.fill(0); }
    await rm(directory, { recursive: true, force: true });
  }
}

test("real pairing client and capability reconstruct a lost-ack replacement without persisting secrets", async () => {
  await fixture(async ({ capabilityOptions, current, replacements, leased, directory }) => {
    const old = current();
    let lostResponse = true;
    let committedHash = null;
    const claims = [];
    const request = () => claimContributionDevicePairing({ origin: ORIGIN, pairingCode: PAIRING, capabilityOptions,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init.headers);
        const body = JSON.parse(init.body);
        assert.equal(init.credentials, "omit");
        assert.equal(init.redirect, "error");
        if (!headers.has("x-previous-device-authorization")) return continuity();
        assert.equal(headers.get("x-previous-device-authorization"), "Device um_device_" + DEVICE + "." + old.toString("base64url"));
        assert.deepEqual(Object.keys(body).sort(), ["deviceId", "deviceSecretHash"]);
        assert.equal(body.deviceId, DEVICE);
        claims.push(body.deviceSecretHash);
        if (committedHash !== null) assert.equal(body.deviceSecretHash, committedHash);
        committedHash = body.deviceSecretHash;
        if (lostResponse) { lostResponse = false; throw new Error("synthetic lost commit response"); }
        return receipt();
      },
    });
    await assert.rejects(request(), { code: "contribution_device_operation_failed" });
    assert.deepEqual(current(), old);
    assert.equal(replacements.length, 0);
    assert.deepEqual(await request(), { status: "paired", origin: ORIGIN, deviceId: DEVICE,
      scope: "upload_registration", expiresAt: EXPIRY });
    assert.equal(claims.length, 2);
    assert.equal(claims[0], claims[1]);
    assert.notEqual(claims[0], deviceHash(old));
    assert.equal(deviceHash(current()), committedHash);
    assert.equal(replacements.length, 1);
    assert(leased.every((value) => value.equals(Buffer.alloc(32))), "all leased copies were zeroized");
    assert.deepEqual(await readdir(directory), ["binding.json"]);
    const state = await readFile(join(directory, "binding.json"), "utf8");
    for (const forbidden of [PAIRING, old.toString("hex"), current().toString("hex"), committedHash]) {
      assert.equal(state.includes(forbidden), false);
    }
    old.fill(0);
  });
});

test("an initial lost pairing response retries the unchanged first claim without rotation", async () => {
  await fixture(async ({ capabilityOptions, current, replacements }) => {
    const old = current();
    let calls = 0;
    const request = () => claimContributionDevicePairing({ origin: ORIGIN, pairingCode: PAIRING, capabilityOptions,
      fetchImpl: async (_url, init) => {
        calls += 1;
        assert.equal(new Headers(init.headers).has("x-previous-device-authorization"), false);
        assert.equal(JSON.parse(init.body).deviceSecretHash, deviceHash(old));
        if (calls === 1) throw new Error("synthetic initial lost receipt");
        return receipt();
      },
    });
    await assert.rejects(request(), { code: "contribution_device_client_service_unavailable" });
    assert.equal((await request()).status, "paired");
    assert.equal(calls, 2);
    assert.deepEqual(current(), old);
    assert.equal(replacements.length, 0);
    old.fill(0);
  });
});

test("a forged or unrelated rejection never leases the prior secret", async () => {
  for (const payload of [
    { error: { code: "PAIRING_AUTH_INVALID" } },
    { error: { code: "DEVICE_CONTINUITY_REQUIRED", privateDetail: "not allowed" } },
  ]) {
    let rotated = false;
    await assert.rejects(claimContributionDevicePairing({
      origin: ORIGIN, pairingCode: PAIRING,
      ensureCapability: async () => ({ origin: ORIGIN, deviceId: DEVICE, deviceSecretHash: "a".repeat(64) }),
      rotate: async () => { rotated = true; },
      fetchImpl: async () => response(payload, 409),
    }), { code: "contribution_device_client_pairing_rejected" });
    assert.equal(rotated, false);
  }
});
