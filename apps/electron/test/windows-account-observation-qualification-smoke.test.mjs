import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachDesktopWindowsAccountObservationBroker,
} from "../desktop-windows-account-observation-broker.js";
import {
  classifyWindowsAccountObservationSmokeFailure,
  runWindowsAccountObservationQualificationSmoke,
  runWindowsAccountObservationQualificationSmokeForTest,
} from "../windows-account-observation-qualification-smoke.js";
import {
  createWindowsAccountObservationCredentialBackend,
} from "../../../src/platform/windows-account-observation-credential.js";
import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
} from "../../../src/platform/windows-account-observation-broker.js";
import {
  WindowsCredentialManagerError,
} from "../../../src/platform/windows-credential-manager.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const CONTROL_SCHEMA = "windows-account-observation-qualification-smoke-ipc-v1";
const CHILD_PATH = fileURLToPath(new URL(
  "../windows-account-observation-qualification-smoke-child.mjs",
  import.meta.url,
));

function smokeError(error) {
  assert.equal(error?.code, "windows_account_observation_qualification_smoke_failed");
  assert.equal(error?.message, "Windows account-observation qualification smoke failed");
  return true;
}

function childEnvironment() {
  const environment = {
    ...process.env,
    [WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV]: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
  };
  delete environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD;
  delete environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
  delete environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;
  return environment;
}

function isReadyMessage(message) {
  try {
    return message !== null && typeof message === "object" && !Array.isArray(message)
      && Object.keys(message).sort().join(",") === "kind,schemaVersion"
      && message.schemaVersion === CONTROL_SCHEMA
      && message.kind === "ready-v1";
  } catch {
    return false;
  }
}

function startMessage(phase = "create-v1") {
  return Object.freeze({
    schemaVersion: CONTROL_SCHEMA,
    kind: "start-v1",
    phase,
    runId: RUN_ID,
  });
}

function syntheticManager(read) {
  return Object.freeze({
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    productionSafe: false,
    read,
    async createIfMissing() { return "created"; },
    async withOperationLease(_capability, _options, callback) {
      return callback(Object.freeze({}));
    },
    close() {},
  });
}

function workingManager() {
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

function childResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* The owned child may have exited. */ }
      reject(new Error("Windows observation diagnostic child timed out"));
    }, 5_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Windows observation diagnostic child failed to start"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve(Object.freeze({ code, signal, stdout, stderr }));
    });
  });
}

function childReady(child) {
  let stdout = "";
  child.stdout.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Windows observation child readiness timed out")), 5_000);
    const onData = (chunk) => {
      stdout += chunk;
      if (!stdout.includes("USAGE_MONITOR_READY http://127.0.0.1:4545/\n")) return;
      cleanup();
      resolve();
    };
    const onError = () => { cleanup(); reject(new Error("Windows observation child failed to start")); };
    const onClose = () => { cleanup(); reject(new Error("Windows observation child exited before ready")); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

function launchChild({
  phase = "create-v1",
  attachBroker = null,
  onMessage = null,
} = {}) {
  const child = spawn(process.execPath, [CHILD_PATH, phase, RUN_ID], {
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let broker = null;
  let started = false;
  const control = (message) => {
    if (isReadyMessage(message)) {
      if (started) return;
      started = true;
      try {
        child.send(startMessage(phase), () => {});
      } catch {
        // The result observer exposes only a fixed local failure assertion.
      }
      return;
    }
    onMessage?.(message, child);
  };
  child.on("message", control);
  try {
    broker = attachBroker?.(child) ?? null;
  } catch (error) {
    child.off("message", control);
    try { child.kill("SIGKILL"); } catch { /* The owned child may already be gone. */ }
    throw error;
  }
  return Object.freeze({
    child,
    async dispose() {
      child.off("message", control);
      broker?.dispose?.();
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* The owned child may have exited. */ }
        await once(child, "close").catch(() => undefined);
      }
    },
  });
}

async function runChildWithBroker(read) {
  const manager = syntheticManager(read);
  const backend = createWindowsAccountObservationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    createCredentialManagerBackend: () => manager,
  });
  const launched = launchChild({
    attachBroker(channel) {
      return attachDesktopWindowsAccountObservationBroker({
        channel,
        createBackend: () => backend,
      });
    },
  });
  const result = childResult(launched.child);
  try {
    return await result;
  } finally {
    await launched.dispose();
  }
}

async function runChildWithMalformedBrokerResponse() {
  const launched = launchChild({
    onMessage(message, child) {
      if (message?.schemaVersion !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA
          || message?.kind !== WINDOWS_ACCOUNT_OBSERVATION_BROKER_REQUEST_KIND) return;
      try {
        child.send(Object.freeze({
          schemaVersion: WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_SCHEMA,
          kind: WINDOWS_ACCOUNT_OBSERVATION_BROKER_RESPONSE_KIND,
          v: WINDOWS_ACCOUNT_OBSERVATION_BROKER_PROTOCOL_VERSION,
          id: message.id + 1,
          ok: true,
          secret: null,
        }), () => {});
      } catch {
        // The child owns bounded closure.
      }
    },
  });
  const result = childResult(launched.child);
  try {
    return await result;
  } finally {
    await launched.dispose();
  }
}

function controlFixture({ failPhase = null, childExitCode = null, failStopPhase = null } = {}) {
  const calls = [];
  const context = Object.freeze({ kind: "synthetic-packaged-context" });
  const environment = Object.freeze({
    USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: RUN_ID,
  });
  const handover = Object.freeze({
    attachWindowsAccountObservationBroker(channel) {
      calls.push(["handover-attach", channel]);
      return Object.freeze({ dispose() { calls.push(["handover-dispose"]); } });
    },
  });
  const dependencies = Object.freeze({
    validateRunId(value) {
      calls.push(["run-id", value]);
      if (value !== RUN_ID) throw new Error("invalid run id");
      return RUN_ID;
    },
    createHandover(options) {
      calls.push(["handover", options]);
      return handover;
    },
    createSupervisor(options) {
      calls.push(["supervisor", options]);
      const phase = options.args[1];
      return Object.freeze({
        async start() {
          const child = options.spawnChild("synthetic-child", [], {});
          const broker = options.attachWindowsAccountObservationBroker(child);
          calls.push(["start", phase]);
          if (phase === failPhase) {
            child.emit("exit", childExitCode);
            throw new Error("private child failure");
          }
          child.emit("message", Object.freeze({ schemaVersion: CONTROL_SCHEMA, kind: "ready-v1" }));
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual(child.sent, [startMessage(phase)]);
          broker.dispose();
        },
        async stop() {
          calls.push(["stop", phase]);
          if (phase === failStopPhase) throw new Error("private shutdown failure");
        },
      });
    },
    spawnChild(command, args, options) {
      calls.push(["spawn", { args, command, options }]);
      const child = new EventEmitter();
      child.connected = true;
      child.sent = [];
      child.send = (message, callback) => {
        child.sent.push(message);
        queueMicrotask(() => callback?.(null));
        return false;
      };
      child.kill = () => true;
      return child;
    },
  });
  return Object.freeze({ calls, context, dependencies, environment, handover });
}

test("Windows observation smoke attaches the parent before one explicit IPC start per phase", async () => {
  const value = controlFixture();
  const result = await runWindowsAccountObservationQualificationSmokeForTest({
    environment: value.environment,
    qualificationContext: value.context,
  }, value.dependencies);
  assert.deepEqual(result, { status: "passed-v1" });
  assert.deepEqual(value.calls.filter(([name]) => name === "handover-attach").map(([, channel]) =>
    channel.sent), [[startMessage("create-v1")], [startMessage("restart-read-v1")]]);
  const supervisors = value.calls.filter(([name]) => name === "supervisor").map(([, options]) => options);
  assert.equal(supervisors.length, 2);
  for (const [index, options] of supervisors.entries()) {
    assert.equal(options.command, process.execPath);
    assert.equal(options.args.length, 3);
    assert.equal(options.args[0].endsWith("windows-account-observation-qualification-smoke-child.mjs"), true);
    assert.equal(options.args[1], index === 0 ? "create-v1" : "restart-read-v1");
    assert.equal(options.args[2], RUN_ID);
    assert.equal(options.environment, value.environment);
    assert.equal(typeof options.attachWindowsAccountObservationBroker, "function");
  }
});

test("Windows observation smoke fails closed before handover and exposes only fixed child stages", async () => {
  const invalid = controlFixture();
  await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
    environment: Object.freeze({ USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "invalid" }),
    qualificationContext: invalid.context,
  }, invalid.dependencies), (error) => {
    assert.equal(smokeError(error), true);
    assert.equal(classifyWindowsAccountObservationSmokeFailure(error), "preparation");
    return true;
  });
  assert.deepEqual(invalid.calls, [["run-id", "invalid"]]);

  for (const [childExitCode, stage] of [
    [null, "startup"],
    [44, "child_readback"],
    [46, "child_initial_read_existing_record"],
    [47, "child_initial_read_broker_unavailable"],
    [48, "child_initial_read_broker_locked"],
    [49, "child_initial_read_broker_denied"],
    [50, "child_initial_read_broker_recovery_required"],
    [51, "child_initial_read_broker_timeout"],
    [52, "child_initial_read_broker_protocol"],
    [53, "child_initial_read_broker_invalid_configuration"],
  ]) {
    const failed = controlFixture({ failPhase: "create-v1", childExitCode });
    await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
      environment: failed.environment,
      qualificationContext: failed.context,
    }, failed.dependencies), (error) => {
      assert.equal(smokeError(error), true);
      assert.equal(classifyWindowsAccountObservationSmokeFailure(error), stage);
      return true;
    });
  }
  assert.equal(classifyWindowsAccountObservationSmokeFailure(new Error("foreign")), null);

  const shutdown = controlFixture({ failStopPhase: "restart-read-v1" });
  await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
    environment: shutdown.environment,
    qualificationContext: shutdown.context,
  }, shutdown.dependencies), (error) => {
    assert.equal(smokeError(error), true);
    assert.equal(classifyWindowsAccountObservationSmokeFailure(error), "shutdown");
    return true;
  });
});

test("Windows observation child keeps the startup listener race closed with the actual delayed broker installation", async () => {
  const manager = workingManager();
  const backend = createWindowsAccountObservationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    createCredentialManagerBackend: () => manager,
  });
  const launched = launchChild({
    attachBroker(channel) {
      return attachDesktopWindowsAccountObservationBroker({
        channel,
        createBackend: () => backend,
      });
    },
  });
  try {
    await childReady(launched.child);
  } finally {
    await launched.dispose();
  }
});

test("Windows observation child distinguishes an existing fixed record from closed parent and protocol failures", async () => {
  const privateCanary = "WINDOWS-OBSERVATION-CHILD-PRIVATE-CANARY";
  const cases = [
    {
      name: "existing record",
      read: async () => Buffer.alloc(32, 18),
      exitCode: 46,
    },
    {
      name: "redacted unavailable parent failure",
      read: async () => { throw new Error(privateCanary); },
      exitCode: 47,
    },
    {
      name: "locked parent failure",
      read: async () => { throw new WindowsCredentialManagerError("locked"); },
      exitCode: 48,
    },
  ];
  for (const value of cases) {
    const result = await runChildWithBroker(value.read);
    assert.equal(result.code, value.exitCode, value.name);
    assert.equal(result.signal, null, value.name);
    assert.equal(result.stdout.includes(privateCanary), false, value.name);
    assert.equal(result.stderr.includes(privateCanary), false, value.name);
  }
  const protocol = await runChildWithMalformedBrokerResponse();
  assert.equal(protocol.code, 52);
  assert.equal(protocol.signal, null);
  assert.equal(protocol.stdout.includes(privateCanary), false);
  assert.equal(protocol.stderr.includes(privateCanary), false);
});

test("production smoke accepts the established context option and child source has no native or socket fallback", async () => {
  await assert.rejects(runWindowsAccountObservationQualificationSmoke({
    context: Object.freeze({}),
    environment: Object.freeze({ USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "invalid" }),
  }), smokeError);

  const source = await readFile(new URL(
    "../windows-account-observation-qualification-smoke-child.mjs",
    import.meta.url,
  ), "utf8");
  assert.equal(source.includes("windows-credential-manager"), false);
  assert.equal(source.includes("keytar"), false);
  assert.equal(source.includes("named pipe"), false);
  assert.equal(source.includes("node:net"), false);
  assert.equal(source.includes("createWindowsAccountObservationBrokerBackendFromEnvironment"), true);
});
