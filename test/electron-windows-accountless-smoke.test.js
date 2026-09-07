import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseWindowsAccountlessSmokeArguments,
  assertWindowsAccountlessPackageIdentity,
  createWindowsAccountlessSmokeProtocol,
  exerciseWindowsAccountlessSmoke,
  observeWindowsSmokeStderr,
} from "../scripts/smoke-electron-windows-accountless.mjs";

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
