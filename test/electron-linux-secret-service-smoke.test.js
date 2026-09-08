import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  assertLinuxPackagedSmokeReceiptIdentity,
  parseLinuxPackagedSecretServiceSmokeArguments,
  runLinuxPackagedSecretServiceSession,
  runLinuxPackagedSecretServiceSmoke,
  runLinuxPackagedSecretServiceSmokeInside,
  verifyLinuxPackagedSecretServiceSmokePackage,
} from "../scripts/smoke-electron-linux-secret-service.mjs";

const REVISION = "a".repeat(40);
const ARTIFACT = "b".repeat(64);
const EXECUTABLE = Object.freeze({ bytes: 123, sha256: "c".repeat(64) });
const ASAR = Object.freeze({ bytes: 456, sha256: ARTIFACT });
const APP = "/trusted/linux-unpacked/tibotattle-dev";
const STAGED = "/trusted/staged-app";
const PACKAGE_RECEIPT = "/trusted/development-package.json";
const OUTPUT_RECEIPT = "/tmp/tibotattle-smoke-receipt.json";

function packageReceipt(overrides = {}) {
  return {
    sourceRevision: REVISION,
    status: "development_package_verified",
    target: "linux-x64",
    format: "distribution",
    nativeHost: true,
    runtimeExecuted: false,
    signed: false,
    published: false,
    appImageLauncherContractChecked: true,
    executable: { ...EXECUTABLE },
    asar: { ...ASAR },
    ...overrides,
  };
}

function identity() {
  return Object.freeze({
    target: "linux-x64",
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
    executableSha256: EXECUTABLE.sha256,
  });
}

function innerReceipt(overrides = {}) {
  return {
    schemaVersion: "tibotattle-electron-linux-secret-service-smoke-v1",
    status: "passed",
    scope: "development_only",
    target: "linux-x64",
    execution: "packaged_electron_run_as_node",
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
    credentialStoreMode: "isolated-secret-service",
    capabilities: 2,
    lifecycle: "two_capability_round_trip_absence_confirmed",
    cleanup: "owned_companion_stopped",
    productionReady: false,
    ...overrides,
  };
}

function smokeError(code) {
  return (error) => error?.code === `ELECTRON_LINUX_SECRET_SERVICE_SMOKE_${code}`;
}

function successfulInsideRuntime({ electronProcess, digest }) {
  return {
    platform: "linux",
    architecture: "x64",
    executable: APP,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    electronVersion: "43.2.0",
    electronProcess,
    async canonicalize(path) { return path; },
    digest,
    startDaemon() { return { status: "started" }; },
    async importModule(url) {
      if (url.endsWith("linux-qualification.js")) {
        return {
          createLinuxQualificationContext() { return Object.freeze({ private: true }); },
        };
      }
      if (url.endsWith("linux-secret-service-qualification-smoke.js")) {
        return {
          async runLinuxSecretServiceQualificationSmoke() { return { status: "passed" }; },
        };
      }
      assert.fail(`unexpected import ${url}`);
    },
  };
}

test("Linux packaged smoke accepts only the closed outer and inner argument contracts", () => {
  assert.deepEqual(parseLinuxPackagedSecretServiceSmokeArguments([
    "--app", APP,
    "--staged-app", STAGED,
    "--package-receipt", PACKAGE_RECEIPT,
    "--source-revision", REVISION,
    "--receipt", OUTPUT_RECEIPT,
  ]), {
    mode: "outer",
    appPath: APP,
    stagedAppPath: STAGED,
    packageReceiptPath: PACKAGE_RECEIPT,
    sourceRevision: REVISION,
    receiptPath: OUTPUT_RECEIPT,
  });
  assert.deepEqual(parseLinuxPackagedSecretServiceSmokeArguments([
    "--inside-isolated-session",
    "--app", APP,
    "--source-revision", REVISION,
    "--artifact-digest", ARTIFACT,
  ]), {
    mode: "inside",
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  });
  for (const args of [
    ["--app", APP],
    ["--app", APP, "--app", APP, "--staged-app", STAGED, "--package-receipt", PACKAGE_RECEIPT, "--source-revision", REVISION, "--receipt", OUTPUT_RECEIPT],
    ["--inside-isolated-session", "--app", APP, "--source-revision", REVISION, "--artifact-digest", ARTIFACT, "--receipt", OUTPUT_RECEIPT],
    ["--app", "relative", "--staged-app", STAGED, "--package-receipt", PACKAGE_RECEIPT, "--source-revision", REVISION, "--receipt", OUTPUT_RECEIPT],
  ]) {
    assert.throws(() => parseLinuxPackagedSecretServiceSmokeArguments(args), smokeError("ARGUMENT_INVALID"));
  }
});

test("Linux packaged smoke binds the existing distribution receipt to both executable and ASAR bytes", () => {
  assert.doesNotThrow(() => assertLinuxPackagedSmokeReceiptIdentity({
    receipt: packageReceipt(),
    sourceRevision: REVISION,
    executable: EXECUTABLE,
    asar: ASAR,
  }));
  for (const receipt of [
    packageReceipt({ format: "dir" }),
    packageReceipt({ nativeHost: false }),
    packageReceipt({ asar: { ...ASAR, sha256: "d".repeat(64) } }),
    packageReceipt({ executable: { ...EXECUTABLE, bytes: EXECUTABLE.bytes + 1 } }),
  ]) {
    assert.throws(() => assertLinuxPackagedSmokeReceiptIdentity({
      receipt,
      sourceRevision: REVISION,
      executable: EXECUTABLE,
      asar: ASAR,
    }), smokeError("PACKAGE_IDENTITY_INVALID"));
  }
});

test("Linux packaged smoke verifies the exact staged/archive/unpacked union before session spawn", async () => {
  const calls = [];
  const result = await verifyLinuxPackagedSecretServiceSmokePackage({
    appPath: APP,
    stagedAppPath: STAGED,
    packageReceiptPath: PACKAGE_RECEIPT,
    sourceRevision: REVISION,
  }, {
    platform: "linux",
    architecture: "x64",
    async assertLayout(options) {
      calls.push(["layout", options]);
      return { target: "linux-x64", format: "unpacked" };
    },
    async digest(path) {
      calls.push(["digest", path]);
      return path === APP ? EXECUTABLE : ASAR;
    },
    async readJson(path) {
      calls.push(["receipt", path]);
      return packageReceipt();
    },
    async verifyArtifact(options) {
      calls.push(["verify", options]);
      return {
        target: "linux-x64",
        nativeFileCount: 2,
        binding: { status: "included_unverified" },
      };
    },
  });
  assert.deepEqual(result, identity());
  assert.deepEqual(calls[0], ["layout", { appPath: APP, platform: "linux", architecture: "x64" }]);
  assert.deepEqual(calls.at(-1), ["verify", {
    target: "linux-x64",
    appPath: STAGED,
    asarPath: "/trusted/linux-unpacked/resources/app.asar",
    unpackedPath: "/trusted/linux-unpacked/resources/app.asar.unpacked",
  }]);
  await assert.rejects(verifyLinuxPackagedSecretServiceSmokePackage({
    appPath: APP,
    stagedAppPath: STAGED,
    packageReceiptPath: PACKAGE_RECEIPT,
    sourceRevision: REVISION,
  }, {
    platform: "linux",
    architecture: "x64",
    async assertLayout() { return { target: "linux-x64", format: "unpacked" }; },
    async digest(path) { return path === APP ? EXECUTABLE : ASAR; },
    async readJson() { return packageReceipt(); },
    async verifyArtifact() { return { target: "linux-x64", nativeFileCount: 1, binding: { status: "included_unverified" } }; },
  }), smokeError("PACKAGE_IDENTITY_INVALID"));
});

test("packaged Electron creates the isolated context only after the default-proof seam starts the daemon", async () => {
  const calls = [];
  const asarModeChanges = [];
  let noAsar = false;
  const electronProcess = {
    get noAsar() { return noAsar; },
    set noAsar(value) {
      asarModeChanges.push(value);
      noAsar = value;
    },
  };
  const originalNoAsarDescriptor = Object.getOwnPropertyDescriptor(electronProcess, "noAsar");
  const result = await runLinuxPackagedSecretServiceSmokeInside({
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  }, {
    platform: "linux",
    architecture: "x64",
    executable: APP,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    electronVersion: "43.2.0",
    electronProcess,
    async canonicalize(path) { return path; },
    async digest(path) {
      assert.equal(noAsar, true);
      calls.push(["digest", path]);
      return ASAR;
    },
    startDaemon() {
      calls.push(["daemon"]);
      return { status: "started" };
    },
    async importModule(url) {
      if (url.endsWith("linux-qualification.js")) {
        calls.push(["qualification"]);
        return {
          createLinuxQualificationContext(context) {
            calls.push(["context", context]);
            return Object.freeze({ private: true });
          },
        };
      }
      if (url.endsWith("linux-secret-service-qualification-smoke.js")) {
        calls.push(["smoke"]);
        return {
          async runLinuxSecretServiceQualificationSmoke({ qualificationContext }) {
            calls.push(["run", qualificationContext]);
            return { status: "passed" };
          },
        };
      }
      assert.fail(`unexpected import ${url}`);
    },
  });
  assert.deepEqual(result, innerReceipt());
  assert.deepEqual(calls.map(([name]) => name), [
    "digest", "daemon", "qualification", "smoke", "context", "run",
  ]);
  const context = calls.find(([name]) => name === "context")[1];
  assert.equal(context.credentialStoreMode, "isolated-secret-service");
  assert.equal(context.artifactDigest, ARTIFACT);
  assert.equal(context.developmentOnly, true);
  assert.deepEqual(asarModeChanges, [true, false]);
  assert.equal(noAsar, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(electronProcess, "noAsar"), originalNoAsarDescriptor);
});

test("packaged Electron emits bounded runtime and isolation stage failures before context construction", async () => {
  let daemonCalls = 0;
  let imports = 0;
  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside({
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  }, {
    platform: "linux",
    architecture: "x64",
    executable: APP,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    electronVersion: "",
    async canonicalize(path) { return path; },
    async digest() { return ASAR; },
    startDaemon() { daemonCalls += 1; return { status: "started" }; },
    async importModule() { imports += 1; return {}; },
  }), smokeError("RUNTIME_IDENTITY_FAILED"));
  assert.equal(daemonCalls, 0);
  assert.equal(imports, 0);

  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside({
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  }, {
    platform: "linux",
    architecture: "x64",
    executable: APP,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    electronVersion: "43.2.0",
    async canonicalize(path) { return path; },
    async digest() { return ASAR; },
    startDaemon() { daemonCalls += 1; throw new Error("canary"); },
    async importModule() { imports += 1; return {}; },
  }), smokeError("ISOLATION_FAILED"));
  assert.equal(daemonCalls, 1);
  assert.equal(imports, 0);
});

test("packaged Electron emits bounded module and native round-trip stage failures", async () => {
  const options = {
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  };
  const runtime = {
    platform: "linux",
    architecture: "x64",
    executable: APP,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    electronVersion: "43.2.0",
    async canonicalize(path) { return path; },
    async digest() { return ASAR; },
    startDaemon() { return { status: "started" }; },
  };
  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside(options, {
    ...runtime,
    async digest() { return { ...ASAR, sha256: "d".repeat(64) }; },
    async importModule() { assert.fail("artifact mismatch must precede module loading"); },
  }), smokeError("ARTIFACT_IDENTITY_FAILED"));

  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside(options, {
    ...runtime,
    async importModule() { throw new Error("private-module-path"); },
  }), smokeError("MODULE_LOAD_FAILED"));

  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside(options, {
    ...runtime,
    async importModule(url) {
      if (url.endsWith("linux-qualification.js")) {
        return { createLinuxQualificationContext() { return Object.freeze({}); } };
      }
      return {
        async runLinuxSecretServiceQualificationSmoke() {
          throw new Error("private-native-detail");
        },
      };
    },
  }), smokeError("NATIVE_ROUND_TRIP_FAILED"));
});

test("packaged Electron restores ASAR mode after a physical archive digest failure", async () => {
  let noAsar = false;
  const changes = [];
  const electronProcess = {
    get noAsar() { return noAsar; },
    set noAsar(value) {
      changes.push(value);
      noAsar = value;
    },
  };
  const originalNoAsarDescriptor = Object.getOwnPropertyDescriptor(electronProcess, "noAsar");
  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside({
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  }, {
    platform: "linux",
    architecture: "x64",
    executable: APP,
    environment: { ELECTRON_RUN_AS_NODE: "1" },
    electronVersion: "43.2.0",
    electronProcess,
    async canonicalize(path) { return path; },
    async digest() {
      assert.equal(noAsar, true);
      throw new Error("private-archive-read-detail");
    },
    startDaemon() { assert.fail("archive digest failure must precede daemon startup"); },
    async importModule() { assert.fail("archive digest failure must precede module loading"); },
  }), smokeError("ARTIFACT_IDENTITY_FAILED"));
  assert.deepEqual(changes, [true, false]);
  assert.equal(noAsar, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(electronProcess, "noAsar"), originalNoAsarDescriptor);
});

test("packaged Electron deletes an initially absent ASAR override after a physical archive digest", async () => {
  const electronProcess = {};
  assert.equal(Object.hasOwn(electronProcess, "noAsar"), false);
  const result = await runLinuxPackagedSecretServiceSmokeInside({
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  }, successfulInsideRuntime({
    electronProcess,
    async digest() {
      assert.equal(Object.hasOwn(electronProcess, "noAsar"), true);
      assert.equal(electronProcess.noAsar, true);
      return ASAR;
    },
  }));
  assert.deepEqual(result, innerReceipt());
  assert.equal(Object.hasOwn(electronProcess, "noAsar"), false);
  assert.equal(electronProcess.noAsar, undefined);
});

test("packaged Electron deletes an initially absent ASAR override after a physical archive digest failure", async () => {
  const electronProcess = {};
  assert.equal(Object.hasOwn(electronProcess, "noAsar"), false);
  await assert.rejects(runLinuxPackagedSecretServiceSmokeInside({
    appPath: APP,
    sourceRevision: REVISION,
    artifactSha256: ARTIFACT,
  }, successfulInsideRuntime({
    electronProcess,
    async digest() {
      assert.equal(Object.hasOwn(electronProcess, "noAsar"), true);
      assert.equal(electronProcess.noAsar, true);
      throw new Error("private-archive-read-detail");
    },
  })), smokeError("ARTIFACT_IDENTITY_FAILED"));
  assert.equal(Object.hasOwn(electronProcess, "noAsar"), false);
  assert.equal(electronProcess.noAsar, undefined);
});

class SessionChild extends EventEmitter {
  constructor(receipt, { stderr = "", code = 0 } = {}) {
    super();
    this.pid = 42;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    queueMicrotask(() => {
      this.stdout.end(receipt === null ? "not-json" : `${JSON.stringify(receipt)}\n`);
      this.stderr.end(stderr);
      this.exitCode = code;
      this.emit("close", code, null);
    });
  }
}

class FastErrorChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 43;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    queueMicrotask(() => this.emit("error", new Error("fast child failure")));
  }
}

test("session runner accepts only the bounded child receipt and cleans its exact session identity", async () => {
  const cleanupCalls = [];
  const result = await runLinuxPackagedSecretServiceSession(identity(), {
    appPath: APP,
    environment: { TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED: "1" },
    proveContainerIsolation() { return { status: "isolated" }; },
    async listProcesses() { return []; },
    spawnSession() { return new SessionChild(innerReceipt()); },
    async readSessionIdentity(pid) {
      assert.equal(pid, 42);
      return { pid, executable: "/usr/bin/dbus-run-session", startTime: "10" };
    },
    async cleanup(value, { listProcesses }) {
      cleanupCalls.push(value);
      assert.deepEqual(await listProcesses(), []);
      return true;
    },
  });
  assert.deepEqual(result, innerReceipt());
  assert.deepEqual(cleanupCalls, [{ pid: 42, executable: "/usr/bin/dbus-run-session", startTime: "10" }]);

  let cleanupCount = 0;
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    appPath: APP,
    proveContainerIsolation() { return { status: "isolated" }; },
    async listProcesses() { return []; },
    spawnSession() { return new SessionChild(null); },
    async readSessionIdentity(pid) { return { pid, executable: "/usr/bin/dbus-run-session", startTime: "10" }; },
    async cleanup() { cleanupCount += 1; return true; },
  }), smokeError("SESSION_RECEIPT_INVALID"));
  assert.equal(cleanupCount, 1);
});

test("outer session proves container isolation before it inventories or cleans daemon identities", async () => {
  let listCalls = 0;
  let spawnCalls = 0;
  let cleanupCalls = 0;
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    appPath: APP,
    proveContainerIsolation() { throw new Error("untrusted-host"); },
    async listProcesses() { listCalls += 1; return []; },
    spawnSession() { spawnCalls += 1; return new SessionChild(innerReceipt()); },
    async readSessionIdentity() { return null; },
    async cleanup() { cleanupCalls += 1; return true; },
  }), smokeError("ISOLATION_REQUIRED"));
  assert.equal(listCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.equal(cleanupCalls, 0);
});

test("outer session observes an immediate child error before async identity lookup", async () => {
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    appPath: APP,
    proveContainerIsolation() { return { status: "isolated" }; },
    async listProcesses() { return []; },
    spawnSession() { return new FastErrorChild(); },
    async readSessionIdentity(pid) {
      await new Promise((resolve) => setImmediate(resolve));
      return { pid, executable: "/usr/bin/dbus-run-session", startTime: "11" };
    },
    async cleanup() { return true; },
  }), smokeError("SESSION_EXECUTION_FAILED"));
});

test("outer session retains only bounded inner failure categories after owned cleanup", async () => {
  const common = {
    appPath: APP,
    proveContainerIsolation() { return { status: "isolated" }; },
    async listProcesses() { return []; },
    async readSessionIdentity(pid) {
      return { pid, executable: "/usr/bin/dbus-run-session", startTime: "12" };
    },
    async cleanup() { return true; },
  };
  let fixedMarkerError;
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    ...common,
    spawnSession() {
      return new SessionChild(null, {
        code: 1,
        stderr: "private-runtime-preamble\nELECTRON_LINUX_SECRET_SERVICE_SMOKE_NATIVE_ROUND_TRIP_FAILED\n",
      });
    },
  }), (error) => {
    fixedMarkerError = error;
    return smokeError("NATIVE_ROUND_TRIP_FAILED")(error);
  });
  assert.equal(String(fixedMarkerError?.message).includes("private-runtime-preamble"), false);

  let bootstrapError;
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    ...common,
    spawnSession() {
      return new SessionChild(null, {
        code: 1,
        stderr: "Error [ERR_MODULE_NOT_FOUND]: private-module-path\ncode: 'ERR_MODULE_NOT_FOUND'\n",
      });
    },
  }), (error) => {
    bootstrapError = error;
    return smokeError("MODULE_LOAD_FAILED")(error);
  });
  assert.equal(String(bootstrapError?.message).includes("private-module-path"), false);

  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    ...common,
    spawnSession() {
      return new SessionChild(null, {
        code: 1,
        stderr: "Error [ERR_DLOPEN_FAILED]: native loader detail\n",
      });
    },
  }), smokeError("NATIVE_ROUND_TRIP_FAILED"));

  let observed;
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    ...common,
    spawnSession() {
      return new SessionChild(null, {
        code: 1,
        stderr: "untrusted-private-secret ERR_NOT_ALLOWLISTED\n",
      });
    },
  }), (error) => {
    observed = error;
    return error?.code === "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_SESSION_EXECUTION_FAILED";
  });
  assert.equal(String(observed?.message).includes("untrusted-private-secret"), false);
});

test("outer session rejects a passing child receipt that emits any stderr", async () => {
  await assert.rejects(runLinuxPackagedSecretServiceSession(identity(), {
    appPath: APP,
    proveContainerIsolation() { return { status: "isolated" }; },
    async listProcesses() { return []; },
    spawnSession() { return new SessionChild(innerReceipt(), { stderr: "benign-looking warning\n" }); },
    async readSessionIdentity(pid) {
      return { pid, executable: "/usr/bin/dbus-run-session", startTime: "13" };
    },
    async cleanup() { return true; },
  }), smokeError("PASS_RECEIPT_STDERR_REJECTED"));
});

test("outer failure receipt preserves only proved post-session cleanup evidence", async () => {
  const handle = Object.freeze({ kind: "receipt" });
  let written = null;
  const result = await runLinuxPackagedSecretServiceSmoke({
    appPath: APP,
    stagedAppPath: STAGED,
    packageReceiptPath: PACKAGE_RECEIPT,
    sourceRevision: REVISION,
    receiptPath: OUTPUT_RECEIPT,
  }, {
    async reserve() { return handle; },
    async verifyPackage() { return identity(); },
    async runSession(currentIdentity, { appPath }) {
      return runLinuxPackagedSecretServiceSession(currentIdentity, {
        appPath,
        proveContainerIsolation() { return { status: "isolated" }; },
        async listProcesses() { return []; },
        spawnSession() {
          return new SessionChild(null, {
            code: 1,
            stderr: "private-preamble\nELECTRON_LINUX_SECRET_SERVICE_SMOKE_NATIVE_ROUND_TRIP_FAILED\n",
          });
        },
        async readSessionIdentity(pid) {
          return { pid, executable: "/usr/bin/dbus-run-session", startTime: "14" };
        },
        async cleanup() { return true; },
      });
    },
    async write(receiptHandle, receipt) {
      assert.equal(receiptHandle, handle);
      written = receipt;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_NATIVE_ROUND_TRIP_FAILED");
  assert.equal(result.packageArtifactVerified, true);
  assert.equal(result.packagedElectronExecutionVerified, false);
  assert.equal(result.credentialLifecycleVerified, false);
  assert.equal(result.sessionCleanupConfirmed, true);
  assert.equal(JSON.stringify(written).includes("private-preamble"), false);
});

test("outer smoke persists only a content-free failure receipt when package verification fails", async () => {
  let sessionCalls = 0;
  let written = null;
  const handle = Object.freeze({ kind: "receipt" });
  const result = await runLinuxPackagedSecretServiceSmoke({
    appPath: APP,
    stagedAppPath: STAGED,
    packageReceiptPath: PACKAGE_RECEIPT,
    sourceRevision: REVISION,
    receiptPath: OUTPUT_RECEIPT,
  }, {
    async reserve(path) {
      assert.equal(path, OUTPUT_RECEIPT);
      return handle;
    },
    async verifyPackage() { throw Object.assign(new Error("private-canary"), { code: "unknown" }); },
    async runSession() { sessionCalls += 1; },
    async write(receiptHandle, receipt) {
      assert.equal(receiptHandle, handle);
      written = receipt;
    },
  });
  assert.equal(sessionCalls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "ELECTRON_LINUX_SECRET_SERVICE_SMOKE_FAILED");
  assert.equal(result.packageArtifactVerified, false);
  assert.equal(result.packagedElectronExecutionVerified, false);
  assert.equal(result.productionReady, false);
  assert.equal(JSON.stringify(written).includes("private-canary"), false);
  assert.deepEqual(Object.keys(written).sort(), [
    "schemaVersion", "status", "scope", "target", "sourceRevision", "artifactSha256",
    "packageArtifactVerified", "packagedElectronExecutionVerified", "credentialLifecycleVerified",
    "sessionCleanupConfirmed", "errorCode", "productionReady",
  ].sort());
});
