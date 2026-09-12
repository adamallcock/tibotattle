import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachDesktopWindowsAccountObservationBroker,
} from "../desktop-windows-account-observation-broker.js";
import {
  attachAccountlessParentChannel,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
} from "../../../src/platform/index.js";
import {
  createWindowsAccountObservationCredentialBackend,
} from "../../../src/platform/windows-account-observation-credential.js";

const SCHEMA = "windows-account-observation-ipc-coexistence-test-v1";
const CHILD_PATH = fileURLToPath(new URL(
  "./windows-account-observation-ipc-coexistence-child.mjs",
  import.meta.url,
));

function observationManager() {
  let stored = null;
  const leases = new WeakSet();
  return Object.freeze({
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    productionSafe: false,
    async read() { return stored === null ? null : Buffer.from(stored); },
    async withOperationLease(_capability, _options, callback) {
      const lease = Object.freeze({});
      leases.add(lease);
      return callback(lease);
    },
    async createIfMissing(_capability, secret, lease) {
      assert.equal(leases.has(lease), true);
      if (stored !== null) return "existing";
      stored = Buffer.from(secret);
      return "created";
    },
    close() {},
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

test("one real child process roundtrips accountless and observation credentials over distinct IPC schemas", async () => {
  const environment = {
    ...process.env,
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  };
  delete environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD;
  delete environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
  delete environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;

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
      rejectResult(new Error("Windows IPC coexistence child failed"));
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
    const observation = createWindowsAccountObservationCredentialBackend({
      platform: "win32",
      architecture: "x64",
      createCredentialManagerBackend: observationManager,
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
    observationBroker = attachDesktopWindowsAccountObservationBroker({
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
