import assert from "node:assert/strict";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEPLOYMENT_ENDPOINTS } from "../config/deployment-endpoints.js";
import {
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  runAccountlessContributionSyncOnce,
} from "../src/contribution-accountless-client.js";
import {
  ensureContributionDeviceCapability,
  removeContributionDeviceCapability,
  withContributionDeviceSecret,
} from "../src/contribution-device-capability.js";
import { writeAttributionFixture } from "./helpers/local-attribution-fixture.js";

const acknowledgement = "RUN_SYNTHETIC_ACCOUNTLESS_STAGING_REHEARSAL_V1";
const enabled = process.env.TIBOTATTLE_RUN_HOSTED_ACCOUNTLESS_REHEARSAL === "1"
  && process.env.TIBOTATTLE_ACCOUNTLESS_HOSTED_REHEARSAL_ACK === acknowledgement;
const HOSTED_SYNTHETIC_DISCONNECT_UNCERTAIN =
  "HOSTED_SYNTHETIC_DISCONNECT_UNCERTAIN";
const HOSTED_SYNTHETIC_LOCAL_CLEANUP_FAILED =
  "HOSTED_SYNTHETIC_LOCAL_CLEANUP_FAILED";

function syntheticBackend() {
  let secret = null;
  return {
    async createIfMissing(_capability, candidate) {
      if (secret !== null) return "existing";
      if (!Buffer.isBuffer(candidate) || candidate.byteLength !== 32) return "conflict";
      secret = Buffer.from(candidate);
      return "created";
    },
    async deleteExact(_capability, expected = null) {
      if (secret === null) return "missing";
      if (expected !== null && (!Buffer.isBuffer(expected)
          || expected.byteLength !== secret.byteLength
          || !timingSafeEqual(expected, secret))) {
        return "conflict";
      }
      secret?.fill(0);
      secret = null;
      return "deleted";
    },
    async read() {
      return secret === null ? null : Buffer.from(secret);
    },
  };
}

function syntheticPreference(origin, enabled) {
  return Object.freeze({
    available: true,
    basis: enabled ? "default_on" : "default_off",
    current: enabled,
    destinationOrigin: origin,
    enabled,
    policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    schemaVersion: "local-contribution-preference-v1",
    updatedAt: "2026-09-08T00:00:00.000Z",
  });
}

function fixedCleanupFailure(code) {
  return Object.assign(new Error(code), { code });
}

async function retainSyntheticRecoveryState(indexFile) {
  try {
    await Promise.all([
      rm(indexFile, { force: true }),
      rm(`${indexFile}-shm`, { force: true }),
      rm(`${indexFile}-wal`, { force: true }),
    ]);
  } catch {
    throw fixedCleanupFailure(HOSTED_SYNTHETIC_LOCAL_CLEANUP_FAILED);
  }
}

/**
 * A remote disconnect is the authority boundary: after it is uncertain, leave
 * the owner-only synthetic state in place for manual recovery and remove only
 * the disposable index. This test helper never retries a failed disconnect.
 */
export async function cleanupHostedSyntheticClient({
  backend,
  deviceId,
  disconnect,
  disconnectAttempted,
  disconnected,
  enrollmentRequested,
  indexFile,
  origin,
  root,
  stateFile,
  removeCapability = removeContributionDeviceCapability,
} = {}) {
  let remotelyRevoked = disconnected === true;
  if (enrollmentRequested === true && !remotelyRevoked) {
    if (disconnectAttempted === true) {
      await retainSyntheticRecoveryState(indexFile);
      throw fixedCleanupFailure(HOSTED_SYNTHETIC_DISCONNECT_UNCERTAIN);
    }
    try {
      await disconnect({ backend, origin, stateFile });
      remotelyRevoked = true;
    } catch {
      await retainSyntheticRecoveryState(indexFile);
      throw fixedCleanupFailure(HOSTED_SYNTHETIC_DISCONNECT_UNCERTAIN);
    }
  }
  try {
    if (remotelyRevoked) {
      await removeCapability({
        backend,
        confirmDeviceId: deviceId,
        expectedOrigin: origin,
        remoteRevocationConfirmed: true,
        stateFile,
      });
    } else {
      await backend.deleteExact();
    }
    await rm(root, { force: true, recursive: true });
  } catch {
    throw fixedCleanupFailure(HOSTED_SYNTHETIC_LOCAL_CLEANUP_FAILED);
  }
}

async function disconnectSyntheticDevice({ backend, origin, stateFile }) {
  return withContributionDeviceSecret({
    backend,
    expectedOrigin: origin,
    stateFile,
    operation: async (secret, device) => {
      const response = await fetch(new URL("/api/v1/device/disconnect", origin), {
        credentials: "omit",
        headers: {
          Accept: "application/json",
          Authorization: `Device um_device_${device.deviceId}.${secret.toString("base64url")}`,
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, "synthetic device disconnect must succeed");
      const body = await response.json();
      assert.equal(body?.disconnected, true);
      return Object.freeze({ disconnected: true });
    },
  });
}

test("hosted synthetic cleanup retains private recovery state after an uncertain disconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-hosted-accountless-recovery-"));
  const indexFile = join(root, "synthetic-index.sqlite");
  const recoveryDirectory = join(root, "recovery");
  const stateFile = join(recoveryDirectory, "synthetic-device-state.json");
  let backendDeleted = false;
  try {
    await writeFile(indexFile, "synthetic-index", { encoding: "utf8", mode: 0o600 });
    await mkdir(recoveryDirectory, { mode: 0o700 });
    await writeFile(stateFile, "synthetic-recovery-state", {
      encoding: "utf8",
      mode: 0o600,
    });
    await assert.rejects(
      cleanupHostedSyntheticClient({
        backend: {
          async deleteExact() {
            backendDeleted = true;
            return "deleted";
          },
        },
        deviceId: randomUUID(),
        disconnect: async () => assert.fail("a failed disconnect is never retried"),
        disconnectAttempted: true,
        disconnected: false,
        enrollmentRequested: true,
        indexFile,
        origin: DEPLOYMENT_ENDPOINTS.staging.origin,
        root,
        stateFile,
      }),
      (error) => error?.code === HOSTED_SYNTHETIC_DISCONNECT_UNCERTAIN,
    );
    assert.equal(backendDeleted, false);
    await stat(stateFile);
    assert.deepEqual(await readdir(root), ["recovery"]);
    assert.deepEqual(await readdir(recoveryDirectory), ["synthetic-device-state.json"]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("synthetic hosted accountless client proof uses the one reviewed staging origin and disconnects", {
  timeout: 90_000,
  skip: enabled
    ? false
    : "set the explicit hosted rehearsal gate and acknowledgement to run against the reviewed staging Worker",
}, async (t) => {
  const origin = DEPLOYMENT_ENDPOINTS.staging.origin;
  const root = await mkdtemp(join(tmpdir(), "tibotattle-hosted-accountless-rehearsal-"));
  const indexFile = join(root, "synthetic-index.sqlite");
  const stateFile = join(root, "recovery", "synthetic-device-state.json");
  const syntheticDeviceId = randomUUID();
  const backend = syntheticBackend();
  let preferenceEnabled = true;
  let disconnected = false;
  let disconnectAttempted = false;
  let enrollmentRequested = false;
  const requests = [];
  t.after(async () => {
    await cleanupHostedSyntheticClient({
      backend,
      deviceId: syntheticDeviceId,
      disconnect: disconnectSyntheticDevice,
      disconnectAttempted,
      disconnected,
      enrollmentRequested,
      indexFile,
      origin,
      root,
      stateFile,
    });
  });

  await writeAttributionFixture(indexFile, { observedAtMs: Date.now() });
  const result = await runAccountlessContributionSyncOnce({
    backend,
    fetchImpl: async (url, request) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, origin);
      if (parsed.pathname === "/api/v1/accountless/enrollment") {
        enrollmentRequested = true;
      }
      const response = await fetch(url, request);
      requests.push(Object.freeze({ path: parsed.pathname, status: response.status }));
      return response;
    },
    ensureCapability: (options) => ensureContributionDeviceCapability({
      ...options,
      generateDeviceId: () => syntheticDeviceId,
      generateSecret: () => Buffer.alloc(32, 31),
    }),
    indexFile,
    maximumChunks: 20,
    maximumDurationMilliseconds: 60_000,
    origin,
    readPreference: async () => syntheticPreference(origin, preferenceEnabled),
    rehearsal: true,
    requestTimeoutMilliseconds: 10_000,
    stateFile,
  });
  assert.equal(result.status, "complete", JSON.stringify({
    status: result.status,
    failure: result.failure,
    requests,
  }));
  assert.equal(result.failure, null);
  assert.equal(requests.some(({ path }) => path === "/api/v1/accountless/enrollment"), true);
  assert.equal(requests.some(({ path }) => path === "/api/v1/accountless/ownership"), true);
  assert.equal(requests.some(({ path }) => path === "/api/v1/contributions"), true);

  disconnectAttempted = true;
  await disconnectSyntheticDevice({ backend, origin, stateFile });
  disconnected = true;
  preferenceEnabled = false;
  const optOut = await runAccountlessContributionSyncOnce({
    backend,
    indexFile,
    origin,
    readPreference: async () => syntheticPreference(origin, preferenceEnabled),
    rehearsal: true,
    stateFile,
  });
  assert.equal(optOut.failure?.code, "preference_ineligible");
});
