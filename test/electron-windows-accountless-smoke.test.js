import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  parseWindowsAccountlessSmokeArguments,
  assertWindowsAccountlessPackageIdentity,
  createWindowsAccountlessSmokeProtocol,
  exerciseWindowsAccountlessSmoke,
  observeWindowsSmokeStderr,
  prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest,
} from "../scripts/smoke-electron-windows-accountless.mjs";
import {
  buildWindowsDevelopmentLaunchSpec,
  prepareWindowsDevelopmentProfile,
} from "../scripts/launch-electron-windows-development.mjs";
import {
  accountlessQualificationEnvironmentForTest,
} from "../apps/electron/windows-qualification.js";

const type = "windows-electron-smoke-v1";
const state = { type, message: "state-v1", started: true, primary: true, window: true, visible: true, tray: true };
const storage = { type, message: "credential-v1", operation: "accountless-storage-v1", status: "passed-v1" };
const quit = { type, message: "quit-v1", status: "accepted-v1" };
function fakeChild(reply) {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.commands = [];
  child.send = (message, callback) => {
    child.commands.push(message);
    callback(null);
    queueMicrotask(() => reply(child, message));
  };
  return child;
}

function disposableWindowsProfile() {
  return Object.freeze({
    root: "C:\\smoke",
    userData: "C:\\smoke\\user-data",
    home: "C:\\smoke\\home",
    codex: "C:\\smoke\\codex",
    claude: "C:\\smoke\\claude",
    state: "C:\\smoke\\state",
    tmp: "C:\\smoke\\tmp",
  });
}

function qualificationEnvironment(profile) {
  return Object.freeze({
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    USAGE_MONITOR_STATE_ROOT: profile.state,
    USERPROFILE: profile.home,
    HOME: profile.home,
    CODEX_HOME: profile.codex,
    CLAUDE_CONFIG_DIR: profile.claude,
    TEMP: profile.tmp,
  });
}

test("Windows accountless runner requires exact absolute inputs and refuses endpoint/credential options", () => {
  const argv = ["--app", resolve("TiboTattle Dev.exe"), "--staged-app", resolve("staged"), "--package-receipt", resolve("package.json"), "--source-revision", "a".repeat(40), "--receipt", resolve("receipt.json")];
  assert.equal(parseWindowsAccountlessSmokeArguments(argv).sourceRevision, "a".repeat(40));
  for (const invalid of [[], argv.slice(0, -1), [...argv, "--app", resolve("other.exe")], [...argv, "--endpoint", "https://invalid.test"], [...argv, "--value", "synthetic"], argv.map((v) => v === resolve("staged") ? "relative" : v)]) {
    assert.throws(() => parseWindowsAccountlessSmokeArguments(invalid), /ARGUMENT_INVALID/u);
  }
});

test("identity requires matching source, executable and ASAR instead of accepting a green older package", () => {
  const sourceRevision = "a".repeat(40);
  const executable = { bytes: 128, sha256: "b".repeat(64) };
  const asar = { bytes: 256, sha256: "c".repeat(64) };
  const receipt = { sourceRevision, target: "win32-x64", status: "development_package_verified", runtimeExecuted: false, executable, asar };
  assertWindowsAccountlessPackageIdentity({ receipt, sourceRevision, executable, asar });
  for (const changed of [{ sourceRevision: "d".repeat(40) }, { target: "darwin-arm64" }, { runtimeExecuted: true }, { asar: { ...asar, bytes: 1 } }, { executable: { ...executable, sha256: "e".repeat(64) } }]) {
    assert.throws(() => assertWindowsAccountlessPackageIdentity({ receipt: { ...receipt, ...changed }, sourceRevision, executable, asar }), /PACKAGE_IDENTITY_INVALID/u);
  }
});

test("Windows smoke prepares and readbacks only the fixed first-run receipt in its authenticated disposable profile", async () => {
  const profile = disposableWindowsProfile();
  const environment = qualificationEnvironment(profile);
  const resourceRoot = "C:\\staged-app";
  const adapter = Object.freeze({ productionSafe: false });
  const context = Object.freeze({
    qualificationOnly: true,
    productionSafe: false,
    resourceRoot,
    stateRoot: profile.userData,
  });
  const store = Object.freeze({ kind: "protected-store" });
  const calls = [];
  const result = await prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest({
    profile,
    environment,
    stagedAppPath: resourceRoot,
    createAdapter(options) {
      calls.push(["adapter", options]);
      return adapter;
    },
    createQualificationContext(options) {
      calls.push(["context", options]);
      return context;
    },
    createProtectedStore(options) {
      calls.push(["store", options]);
      return store;
    },
    createReceiptBackend(options) {
      calls.push(["backend", options]);
      return Object.freeze({
        async save(value) {
          calls.push(["save", value]);
        },
        async load() {
          calls.push(["load"]);
          return {
            schemaVersion: "tibotattle-desktop-first-run-v1",
            acknowledged: true,
          };
        },
      });
    },
  });

  assert.deepEqual(result, { status: "prepared-v1" });
  assert.deepEqual(calls[0][1].bindingPath,
    "C:\\staged-app\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node");
  assert.equal(calls[0][1].platform, "win32");
  assert.equal(calls[0][1].architecture, "x64");
  assert.equal(calls[1][1].resourceRoot, resourceRoot);
  assert.equal(calls[1][1].environment.TEMP, profile.root);
  assert.equal(calls[1][1].environment.USAGE_MONITOR_STATE_ROOT, profile.userData);
  assert.equal(environment.TEMP, profile.tmp);
  assert.equal(environment.USAGE_MONITOR_STATE_ROOT, profile.state);
  assert.equal(calls[2][1].rootPath, "C:\\smoke\\user-data\\desktop-settings");
  assert.equal(calls[2][1].windowsQualificationModeContext, context);
  assert.equal(calls[2][1].resourceRoot, resourceRoot);
  assert.deepEqual(calls[3][1], {
    platform: "win32",
    windowsProtectedStateStore: store,
  });
  assert.deepEqual(calls[4][1], {
    schemaVersion: "tibotattle-desktop-first-run-v1",
    acknowledged: true,
  });
  assert.deepEqual(calls[5], ["load"]);
});

test("Windows accountless factory derives its private context from the actual launcher profile", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-accountless-profile-"));
  try {
    const appPath = join(root, "candidate", "TiboTattle Dev.exe");
    const profile = await prepareWindowsDevelopmentProfile({
      appPath,
      profilePath: join(root, "profile"),
    });
    const spec = buildWindowsDevelopmentLaunchSpec({ appPath, profile });
    const privateEnvironment = accountlessQualificationEnvironmentForTest(
      spec.options.env,
    );
    assert.equal(spec.options.env.TEMP, profile.tmp);
    assert.equal(privateEnvironment.TEMP, profile.root);
    assert.equal(privateEnvironment.USAGE_MONITOR_STATE_ROOT, profile.state);
    assert.equal(privateEnvironment.USERPROFILE, profile.home);
    assert.equal(privateEnvironment.CODEX_HOME, profile.codex);
    assert.notEqual(privateEnvironment, spec.options.env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows smoke refuses an unauthenticated first-run context before it writes a receipt", async () => {
  const profile = disposableWindowsProfile();
  let receiptWrites = 0;
  await assert.rejects(
    prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest({
      profile,
      environment: qualificationEnvironment(profile),
      stagedAppPath: "C:\\staged-app",
      createAdapter: () => ({ productionSafe: false }),
      createQualificationContext: () => ({
        qualificationOnly: true,
        productionSafe: true,
        resourceRoot: "C:\\staged-app",
        stateRoot: profile.userData,
      }),
      createProtectedStore: () => ({ kind: "unreachable" }),
      createReceiptBackend: () => ({
        save: async () => { receiptWrites += 1; },
        load: async () => null,
      }),
    }),
    /FIRST_RUN_CONTEXT_INVALID/u,
  );
  assert.equal(receiptWrites, 0);
});

test("runner waits for ready then completes only the fixed storage and clean quit sequence", async () => {
  const child = fakeChild((target, { command }) => {
    target.emit("message", command === "status-v1" ? state : command === "accountless-storage-v1" ? storage : quit);
    if (command === "quit-v1") setImmediate(() => { target.exitCode = 0; target.emit("exit", 0, null); });
  });
  await exerciseWindowsAccountlessSmoke(child, { timeoutMs: 1000 });
  assert.deepEqual(child.commands, ["status-v1", "accountless-storage-v1", "quit-v1"].map((command) => ({ type, message: "command-v1", command })));
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("storage failure or extra fields cannot produce a success receipt", async () => {
  for (const response of [{ ...storage, status: "failed-v1" }, { ...storage, privateValue: "unexpected" }, { ...storage, operation: "credential-read-v1" }]) {
    const child = fakeChild((target) => target.emit("message", response));
    const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 50 });
    await assert.rejects(protocol.request("accountless-storage-v1"), /STORAGE_FAILED/u);
    protocol.close();
  }
});

test("unknown commands and concurrent requests are refused; silent or exited children terminate the request", async () => {
  const child = fakeChild(() => {});
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 25 });
  await assert.rejects(protocol.request("credential-create-v1"), /COMMAND_REFUSED/u);
  const waiting = protocol.request("status-v1");
  await assert.rejects(protocol.request("status-v1"), /COMMAND_REFUSED/u);
  await assert.rejects(waiting, /TIMEOUT/u);
  const interrupted = protocol.request("status-v1");
  child.emit("exit", 1, null);
  await assert.rejects(interrupted, /CHILD_EXITED/u);
  protocol.close();
});

test("malformed lifecycle state and asynchronous send errors fail without leaking underlying errors", async () => {
  const child = fakeChild((target) => target.emit("message", { ...state, started: "yes" }));
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 50 });
  await assert.rejects(protocol.request("status-v1"), /RESPONSE_INVALID/u);
  child.send = (_message, callback) => callback(new Error("private process detail"));
  await assert.rejects(protocol.request("status-v1"), (error) => error.message === "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_SEND_FAILED");
  protocol.close();
});

test("startup observation can be retried while a storage request is never replayed", async () => {
  let statusCount = 0;
  const child = fakeChild((target, { command }) => {
    if (command === "status-v1" && ++statusCount === 2) target.emit("message", state);
  });
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 600 });
  assert.equal((await protocol.request("status-v1")).started, true);
  await assert.rejects(protocol.request("accountless-storage-v1"), /TIMEOUT/u);
  assert.equal(child.commands.filter(({ command }) => command === "status-v1").length, 2);
  assert.equal(child.commands.filter(({ command }) => command === "accountless-storage-v1").length, 1);
  protocol.close();
});

test("failure observations expose only a fixed startup marker and allowlisted IPC class", async () => {
  const stream = new EventEmitter(); stream.setEncoding = () => {};
  const observations = { entryFailureObserved: false, sendFailureCode: null };
  observeWindowsSmokeStderr(stream, observations);
  stream.emit("data", "private path and credential\n" + "x".repeat(500) + "electron_shell_entry_failed\n");
  assert.equal(observations.entryFailureObserved, false);
  stream.emit("data", "electron_shell_"); stream.emit("data", "entry_failed\r\n");
  assert.equal(observations.entryFailureObserved, true);
  const child = fakeChild(() => {});
  child.send = (_message, callback) => callback(Object.assign(new Error("private detail"), { code: "EPIPE" }));
  const protocol = createWindowsAccountlessSmokeProtocol(child, { observations });
  await assert.rejects(protocol.request("status-v1"), /SEND_FAILED/u);
  assert.deepEqual(observations, { entryFailureObserved: true, sendFailureCode: "EPIPE" });
  protocol.close();
});
