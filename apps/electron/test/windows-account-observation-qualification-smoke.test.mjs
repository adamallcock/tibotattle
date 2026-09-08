import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  WindowsCredentialManagerError,
} from "../../../src/platform/windows-credential-manager.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const CHILD_PATH = fileURLToPath(new URL(
  "../windows-account-observation-qualification-smoke-child.mjs",
  import.meta.url,
));

function fixture({ failPhase = null, childExitCode = null, failStopPhase = null } = {}) {
  const calls = [];
  const context = Object.freeze({ kind: "synthetic-packaged-context" });
  const environment = Object.freeze({
    USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: RUN_ID,
  });
  const handover = Object.freeze({
    attachWindowsAccountObservationBroker() {},
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
          calls.push(["start", phase]);
          if (phase === failPhase) {
            child.emitExit(childExitCode);
            throw new Error("private child failure");
          }
        },
        async stop() {
          calls.push(["stop", phase]);
          if (phase === failStopPhase) throw new Error("private shutdown failure");
        },
      });
    },
    spawnChild(command, args, options) {
      calls.push(["spawn", { args, command, options }]);
      let exitHandler = null;
      return Object.freeze({
        once(event, handler) {
          if (event === "exit") exitHandler = handler;
          return this;
        },
        emitExit(code) { exitHandler?.(code); },
      });
    },
  });
  return Object.freeze({ calls, context, dependencies, environment, handover });
}

function smokeError(error) {
  assert.equal(error?.code, "windows_account_observation_qualification_smoke_failed");
  assert.equal(error?.message, "Windows account-observation qualification smoke failed");
  return true;
}

function childEnvironment() {
  const environment = {
    ...process.env,
    USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_BROKER_FD: "4",
  };
  delete environment.USAGE_MONITOR_KEYCHAIN_BROKER_FD;
  delete environment.USAGE_MONITOR_LINUX_SECRET_SERVICE_BROKER_FD;
  return environment;
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

async function runChildWithBroker(read) {
  const manager = syntheticManager(read);
  const backend = createWindowsAccountObservationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    createCredentialManagerBackend: () => manager,
  });
  const child = spawn(process.execPath, [CHILD_PATH, "create-v1", RUN_ID], {
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  const result = childResult(child);
  let broker = null;
  try {
    broker = attachDesktopWindowsAccountObservationBroker({
      stream: child.stdio[4],
      createBackend: () => backend,
    });
    return await result;
  } finally {
    broker?.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* The owned child may have exited. */ }
      await once(child, "close").catch(() => undefined);
    }
  }
}

async function runChildWithMalformedBrokerResponse() {
  const child = spawn(process.execPath, [CHILD_PATH, "create-v1", RUN_ID], {
    env: childEnvironment(),
    stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  const result = childResult(child);
  const stream = child.stdio[4];
  stream.on("error", () => {});
  stream.on("data", () => {
    try { stream.write('{"id":1,"ok":true}\n'); } catch { /* The child owns closure. */ }
  });
  try {
    return await result;
  } finally {
    stream.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* The owned child may have exited. */ }
      await once(child, "close").catch(() => undefined);
    }
  }
}

test("Windows account-observation smoke owns two sequential FD4 supervisors with a fixed restart boundary", async () => {
  const value = fixture();
  const result = await runWindowsAccountObservationQualificationSmokeForTest({
    environment: value.environment,
    qualificationContext: value.context,
  }, value.dependencies);
  assert.deepEqual(result, { status: "passed-v1" });
  assert.deepEqual(value.calls.map(([name, detail]) => [name, detail]), [
    ["run-id", RUN_ID],
    ["handover", { qualificationContext: value.context, environment: value.environment }],
    ["supervisor", value.calls[2][1]],
    ["spawn", value.calls[3][1]],
    ["start", "create-v1"],
    ["stop", "create-v1"],
    ["supervisor", value.calls[6][1]],
    ["spawn", value.calls[7][1]],
    ["start", "restart-read-v1"],
    ["stop", "restart-read-v1"],
  ]);
  const supervisors = value.calls.filter(([name]) => name === "supervisor").map(([, options]) => options);
  assert.equal(supervisors.length, 2);
  for (const [index, options] of supervisors.entries()) {
    assert.equal(options.command, process.execPath);
    assert.equal(options.args.length, 3);
    assert.equal(options.args[0].endsWith("windows-account-observation-qualification-smoke-child.mjs"), true);
    assert.equal(options.args[1], index === 0 ? "create-v1" : "restart-read-v1");
    assert.equal(options.args[2], RUN_ID);
    assert.equal(options.environment, value.environment);
    assert.equal(options.attachWindowsAccountObservationBroker,
      value.handover.attachWindowsAccountObservationBroker);
  }
});

test("Windows account-observation smoke fails closed before handover and exposes only fixed child stages", async () => {
  const invalid = fixture();
  await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
    environment: Object.freeze({ USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "invalid" }),
    qualificationContext: invalid.context,
  }, invalid.dependencies), (error) => {
    assert.equal(smokeError(error), true);
    assert.equal(classifyWindowsAccountObservationSmokeFailure(error), "preparation");
    return true;
  });
  assert.deepEqual(invalid.calls, [["run-id", "invalid"]]);

  const failed = fixture({ failPhase: "restart-read-v1" });
  await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
    environment: failed.environment,
    qualificationContext: failed.context,
  }, failed.dependencies), (error) => {
    assert.equal(smokeError(error), true);
    assert.equal(classifyWindowsAccountObservationSmokeFailure(error), "startup");
    return true;
  });
  assert.deepEqual(failed.calls.map(([name, detail]) => [name, detail]), [
    ["run-id", RUN_ID],
    ["handover", { qualificationContext: failed.context, environment: failed.environment }],
    ["supervisor", failed.calls[2][1]],
    ["spawn", failed.calls[3][1]],
    ["start", "create-v1"],
    ["stop", "create-v1"],
    ["supervisor", failed.calls[6][1]],
    ["spawn", failed.calls[7][1]],
    ["start", "restart-read-v1"],
    ["stop", "restart-read-v1"],
  ]);

  const classified = fixture({ failPhase: "create-v1", childExitCode: 44 });
  await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
    environment: classified.environment,
    qualificationContext: classified.context,
  }, classified.dependencies), (error) => {
    assert.equal(smokeError(error), true);
    assert.equal(classifyWindowsAccountObservationSmokeFailure(error), "child_readback");
    return true;
  });
  assert.equal(classifyWindowsAccountObservationSmokeFailure(new Error("foreign")), null);

  for (const [childExitCode, stage] of [
    [46, "child_initial_read_existing_record"],
    [47, "child_initial_read_broker_unavailable"],
    [48, "child_initial_read_broker_locked"],
    [49, "child_initial_read_broker_denied"],
    [50, "child_initial_read_broker_recovery_required"],
    [51, "child_initial_read_broker_timeout"],
    [52, "child_initial_read_broker_protocol"],
    [53, "child_initial_read_broker_invalid_configuration"],
  ]) {
    const diagnostic = fixture({ failPhase: "create-v1", childExitCode });
    await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
      environment: diagnostic.environment,
      qualificationContext: diagnostic.context,
    }, diagnostic.dependencies), (error) => {
      assert.equal(smokeError(error), true);
      assert.equal(classifyWindowsAccountObservationSmokeFailure(error), stage);
      return true;
    });
  }

  const shutdown = fixture({ failStopPhase: "restart-read-v1" });
  await assert.rejects(runWindowsAccountObservationQualificationSmokeForTest({
    environment: shutdown.environment,
    qualificationContext: shutdown.context,
  }, shutdown.dependencies), (error) => {
    assert.equal(smokeError(error), true);
    assert.equal(classifyWindowsAccountObservationSmokeFailure(error), "shutdown");
    return true;
  });
});

test("Windows FD4 child distinguishes an existing fixed record from closed parent and protocol failures", async () => {
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

test("production smoke accepts the established context option and the FD4 child contains no native manager or fallback route", async () => {
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
  assert.equal(source.includes("createWindowsAccountObservationBrokerBackendFromEnvironment"), true);
});
