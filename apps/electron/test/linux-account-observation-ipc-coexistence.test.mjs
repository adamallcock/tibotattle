import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachDesktopLinuxAccountObservationBroker,
} from "../desktop-linux-account-observation-broker.js";
import {
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  attachAccountlessParentChannel,
} from "../../../src/platform/index.js";
import {
  createLinuxAccountObservationCredentialBackend,
} from "../../../src/platform/linux-account-observation-credential.js";

const SCHEMA = "linux-account-observation-ipc-coexistence-test-v1";
const CHILD_PATH = fileURLToPath(new URL(
  "./linux-account-observation-ipc-coexistence-child.mjs",
  import.meta.url,
));

function observationBinding() {
  let stored = null;
  return Object.freeze({
    credentialMutexContractVersion: "linux-credential-mutex-v1",
    credentialMutexCrossProcessSafe: true,
    credentialMutexSameNetworkNamespaceOnly: true,
    credentialMutexDurableMarker: true,
    productionSafe: false,
    async readAccountObservationCredential() {
      return stored === null ? null : Buffer.from(stored);
    },
    async createAccountObservationCredentialIfMissing(candidate) {
      assert.equal(Buffer.isBuffer(candidate), true);
      assert.equal(candidate.byteLength, 32);
      if (stored !== null) return "existing";
      stored = Buffer.from(candidate);
      return "created";
    },
  });
}

function accountlessBackend() {
  let stored = null;
  return Object.freeze({
    async read() { return stored === null ? null : Buffer.from(stored); },
    async createIfMissing(secret) {
      if (stored !== null) return "existing";
      stored = Buffer.from(secret);
      return "created";
    },
    async deleteExact(secret) {
      if (stored === null || !Buffer.isBuffer(secret) || !stored.equals(secret)) return "missing";
      stored.fill(0);
      stored = null;
      return "deleted";
    },
  });
}

function isControl(message, kind) {
  try {
    const keys = kind === "result-v1" ? "kind,schemaVersion,status" : "kind,schemaVersion";
    return message !== null && typeof message === "object" && !Array.isArray(message)
      && Object.keys(message).sort().join(",") === keys
      && message.schemaVersion === SCHEMA && message.kind === kind;
  } catch {
    return false;
  }
}

test("one real child process roundtrips accountless and Linux observation credentials over distinct IPC schemas", async () => {
  const environment = {
    ...process.env,
    [LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: LINUX_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  };
  delete environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
  delete environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;
  delete environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC;
  delete environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD;

  const child = spawn(process.execPath, [CHILD_PATH], {
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let accountless = null;
  let observationBroker = null;
  let attached = false;
  let childReady = false;
  let started = false;
  let resultReceived = false;
  let finished = false;
  let resolveResult = null;
  let rejectResult = null;
  let resolveExit = null;
  let lifecycleTimer = null;
  const cleanup = () => {
    if (lifecycleTimer !== null) clearTimeout(lifecycleTimer);
    lifecycleTimer = null;
    child.off("message", onMessage);
    child.off("error", onError);
    child.off("exit", onExit);
  };
  const fail = () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (!resultReceived) {
      rejectResult(new Error("Linux IPC coexistence child failed"));
    } else {
      resolveExit(Object.freeze({ code: null, signal: "failed" }));
    }
  };
  const maybeStart = () => {
    if (!attached || !childReady || started || finished) return;
    started = true;
    try {
      // A false return is backpressure only. The callback is the delivery result.
      child.send(Object.freeze({ schemaVersion: SCHEMA, kind: "start-v1" }), (error) => {
        if (error && !finished) fail();
      });
    } catch {
      fail();
    }
  };
  const onMessage = (message) => {
    if (isControl(message, "ready-v1")) {
      if (childReady) { fail(); return; }
      childReady = true;
      maybeStart();
      return;
    }
    if (!isControl(message, "result-v1") || resultReceived) return;
    resultReceived = true;
    resolveResult(message.status);
  };
  const onError = fail;
  const onExit = (code, signal) => {
    if (!resultReceived) {
      fail();
      return;
    }
    if (finished) return;
    finished = true;
    cleanup();
    resolveExit(Object.freeze({ code, signal }));
  };
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  lifecycleTimer = setTimeout(fail, 5_000);
  child.on("message", onMessage);
  child.on("error", onError);
  child.on("exit", onExit);

  try {
    const observation = createLinuxAccountObservationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      binding: observationBinding(),
    });
    accountless = attachAccountlessParentChannel({
      channel: child,
      backend: accountlessBackend(),
      readPreference: async () => Object.freeze({
        available: true,
        current: true,
        enabled: true,
        policyVersion: "accountless-test-v1",
        destinationOrigin: "https://example.invalid",
      }),
    });
    observationBroker = attachDesktopLinuxAccountObservationBroker({
      channel: child,
      createBackend: () => observation,
    });
    attached = true;
    maybeStart();
    assert.equal(await result, "passed-v1");
    child.send(Object.freeze({ schemaVersion: SCHEMA, kind: "stop-v1" }), (error) => {
      if (error) fail();
    });
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    cleanup();
    accountless?.dispose();
    observationBroker?.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* The owned child may already be gone. */ }
    }
  }
});
