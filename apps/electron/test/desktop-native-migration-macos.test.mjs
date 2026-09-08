import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createMacNativeHandoverAdapter,
  inspectNativeElectronHandoverBridge,
  inspectNativeMacHandover,
  nativeElectronHandoverBridgePath,
  nativeElectronGuidedBackupRoot,
  nativeElectronGuidedNativeAppBackupPath,
  nativeElectronLegacyStateRoot,
  runProductionNativeMacHandover,
} from "../desktop-native-migration-macos.js";

const CANDIDATE = {
  route: "guided_signed_install",
  native: {
    appId: "com.usagemonitor.local",
    version: "0.1.18",
    build: "20260905.1",
    signingLineage: "TEAM:source-lineage",
  },
  electron: {
    appId: "com.usagemonitor.local",
    version: "0.1.19",
    build: "20260906.1",
    signingLineage: "TEAM:source-lineage",
  },
  signatureEvidence: {
    nativeCodeHash: "a".repeat(40),
    electronCodeHash: "b".repeat(40),
    helperCodeHash: "c".repeat(40),
  },
};

function responseSpawn(reply, calls, { exitCode = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify(reply)}\n`);
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

function preparedReply() {
  return {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
    status: "prepared",
    nativeWriterStopped: true,
    loginItemDisabled: true,
    preferences: {
      language: "en-US",
      appearance: "light",
      refreshIntervalSeconds: 300,
      startAtLogin: true,
    },
    credentialState: "unchanged",
  };
}

test("macOS bridge calls only the fixed helper operation and validates its reply", async () => {
  const calls = [];
  let loginStatus = { openAtLogin: false, status: "not-registered" };
  const app = {
    setLoginItemSettings({ openAtLogin }) {
      loginStatus = openAtLogin
        ? { openAtLogin: true, status: "enabled" }
        : { openAtLogin: false, status: "not-registered" };
    },
    getLoginItemSettings() { return loginStatus; },
  };
  const adapter = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app,
    spawnProcess: responseSpawn(preparedReply(), calls),
  });
  const prepared = await adapter.prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle.app",
    candidate: CANDIDATE,
  });
  assert.deepEqual(prepared, {
    status: "prepared",
    nativeWriterStopped: true,
    loginItemDisabled: true,
    preferences: {
      language: "en",
      appearance: "light",
      refreshIntervalSeconds: 300,
      startAtLogin: true,
    },
    credentialState: "unchanged",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command.endsWith("TiboTattleNativeHandover"), true);
  assert.deepEqual(calls[0].args, ["--prepare", "--native-app", "/Applications/TiboTattle.app"]);
  assert.deepEqual(calls[0].options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  assert.equal(await adapter.claimElectronLoginItem({ startAtLogin: true, candidate: CANDIDATE }), "owned");
  assert.equal(await adapter.claimElectronLoginItem({ startAtLogin: false, candidate: CANDIDATE }), "owned");
});

test("macOS bridge preparation preflight is a fixed no-side-effect helper operation", async () => {
  const calls = [];
  let loginWrites = 0;
  const adapter = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: {
      setLoginItemSettings() { loginWrites += 1; },
      getLoginItemSettings() { return { openAtLogin: false, status: "not-registered" }; },
    },
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "preflight_ready",
    }, calls),
  });
  assert.deepEqual(await adapter.preflightNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app",
    candidate: CANDIDATE,
  }), { status: "preflight_ready" });
  assert.equal(loginWrites, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--prepare-preflight", "--native-app", "/Applications/TiboTattle-old.app"]);
  assert.deepEqual(calls[0].options, {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const refusingAdapter = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: {
      setLoginItemSettings() { loginWrites += 1; },
      getLoginItemSettings() { return { openAtLogin: false, status: "not-registered" }; },
    },
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
    }, [], { exitCode: 1 }),
  });
  await assert.rejects(refusingAdapter.preflightNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_preflight_invalid_reply");
  assert.equal(loginWrites, 0, "a refusing preflight cannot alter Electron login ownership");

  const stagedRefusal = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: {
      setLoginItemSettings() { loginWrites += 1; },
      getLoginItemSettings() { return { openAtLogin: false, status: "not-registered" }; },
    },
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
      failureStage: "native_writer",
    }, [], { exitCode: 1 }),
  });
  await assert.rejects(stagedRefusal.preflightNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_preflight_native_writer");
  assert.equal(loginWrites, 0, "a staged preflight refusal cannot alter Electron login ownership");
});

test("macOS bridge fails closed on an incomplete reply or unverified candidate", async () => {
  const app = {
    setLoginItemSettings() {},
    getLoginItemSettings() { return { openAtLogin: true, status: "enabled" }; },
  };
  const adapter = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app,
    spawnProcess: responseSpawn({ status: "prepared" }, []),
  });
  await assert.rejects(adapter.prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle.app",
    candidate: CANDIDATE,
  }), (error) => {
    assert.equal(error.code, "native_electron_mac_bridge_invalid_reply");
    return true;
  });
  await assert.rejects(adapter.claimElectronLoginItem({
    startAtLogin: true,
    candidate: { ...CANDIDATE, signatureEvidence: {
      ...CANDIDATE.signatureEvidence,
      helperCodeHash: "invalid",
    } },
  }), (error) => {
    assert.equal(error.code, "native_electron_handover_signature_evidence_invalid");
    return true;
  });
});

test("macOS bridge accepts only closed preparation failure stages and retains legacy failed replies", async () => {
  const app = {
    setLoginItemSettings() {},
    getLoginItemSettings() { return { openAtLogin: false, status: "not-registered" }; },
  };
  const stagedFailure = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app,
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
      failureStage: "login_item_unregister",
    }, [], { exitCode: 1 }),
  });
  await assert.rejects(stagedFailure.prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_prepare_login_item_unregister");

  const legacyFailure = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app,
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
    }, [], { exitCode: 1 }),
  });
  await assert.rejects(legacyFailure.prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_failed");

  const malformedFailure = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app,
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
      status: "failed",
      failureStage: "raw_os_error",
    }, [], { exitCode: 1 }),
  });
  await assert.rejects(malformedFailure.prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_invalid_reply");
});

test("bridge availability is an explicit packaged-resource probe", async () => {
  assert.equal(
    nativeElectronHandoverBridgePath("/Applications/TiboTattle.app/Contents/Resources"),
    "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
  );
  assert.deepEqual(await inspectNativeElectronHandoverBridge({
    resourcesPath: "/Applications/TiboTattle.app/Contents/Resources",
    async lstatPath() {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  }), {
    available: false,
    path: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
  });
});

function inspectionLstat(path) {
  const directory = path.endsWith(".app") || path.endsWith("Usage Monitor");
  return {
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  };
}

function inspectionCommand(command, args) {
  const target = args.at(-1);
  if (command === "/usr/bin/codesign" && args[0] === "--verify") {
    return { code: 0, signal: null, stdout: "", stderr: "" };
  }
  if (command === "/usr/bin/codesign") {
    const helper = target.endsWith("TiboTattleNativeHandover");
    return {
      code: 0,
      signal: null,
      stdout: "",
      stderr: `${helper ? "Identifier=node" : "Identifier=com.usagemonitor.local"}\nTeamIdentifier=TEAM123\nCDHash=${helper ? "c".repeat(40) : target.includes("old") ? "a".repeat(40) : "b".repeat(40)}\ndesignated => identifier \"com.usagemonitor.local\" and anchor apple generic\n`,
    };
  }
  if (command === "/usr/bin/plutil") {
    const old = target.includes("old");
    const value = args[1] === "CFBundleShortVersionString"
      ? (old ? "0.1.18" : "0.1.19")
      : (old ? "20260905.1" : "20260906.1");
    return { code: 0, signal: null, stdout: `${value}\n`, stderr: "" };
  }
  throw new Error("unexpected command");
}

test("read-only inspection derives a candidate from fixed legacy roots and codesign facts", async () => {
  const homeDirectory = "/Users/synthetic";
  const backupRoot = nativeElectronGuidedBackupRoot(homeDirectory);
  const nativeAppPath = "/Applications/TiboTattle-old.app";
  const result = await inspectNativeMacHandover({
    homeDirectory,
    backupRoot,
    nativeAppPath,
    electronAppPath: "/Applications/TiboTattle.app",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    lstatPath: async (path) => inspectionLstat(path),
    commandRunner: async (command, args) => inspectionCommand(command, args),
  });
  assert.equal(nativeElectronLegacyStateRoot(homeDirectory), "/Users/synthetic/Library/Application Support/Usage Monitor");
  assert.equal(
    nativeElectronGuidedNativeAppBackupPath(backupRoot),
    "/Users/synthetic/Library/Application Support/TiboTattle Native Handover/native-app/TiboTattle.app",
  );
  assert.equal(result.status, "ready");
  assert.equal(result.nativeStateRoot, "/Users/synthetic/Library/Application Support/Usage Monitor");
  assert.equal(result.nativeAppPath, nativeAppPath);
  assert.equal(result.candidate.native.version, "0.1.18");
  assert.equal(result.candidate.electron.build, "20260906.1");
  assert.equal(result.candidate.signatureEvidence.helperCodeHash, "c".repeat(40));
});

function runtimeApp(userDataRoot = "/Users/synthetic/Library/Application Support/TiboTattle") {
  return {
    getPath(name) {
      return name === "exe"
        ? "/Applications/TiboTattle.app/Contents/MacOS/TiboTattle"
        : userDataRoot;
    },
    setLoginItemSettings() {},
    getLoginItemSettings() { return { openAtLogin: false, status: "not-registered" }; },
  };
}

test("fresh orchestration returns no legacy state before probing a missing embedded bridge", async () => {
  const result = await runProductionNativeMacHandover({
    platform: "darwin",
    electronApp: runtimeApp(),
    resourcesPath: "/Applications/TiboTattle.app/Contents/Resources",
    homeDirectory: "/Users/synthetic",
    lstatPath: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(result, { status: "no_legacy_state" });
});

test("existing native state blocks startup when the embedded bridge is absent", async () => {
  const result = await runProductionNativeMacHandover({
    platform: "darwin",
    electronApp: runtimeApp(),
    resourcesPath: "/Applications/TiboTattle.app/Contents/Resources",
    homeDirectory: "/Users/synthetic",
    lstatPath: async (path) => {
      if (path.endsWith("Usage Monitor")) return inspectionLstat(path);
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(result, { status: "bridge_unavailable" });
});

test("a durable completed marker skips old-native discovery for later Electron updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-migration-completion-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await mkdir(join(root, "companion-state"), { mode: 0o700 });
  await mkdir(join(root, "desktop-settings"), { mode: 0o700 });
  await mkdir(join(root, ".native-electron-handover-v1"), { mode: 0o700 });
  const marker = join(root, ".native-electron-handover-v1", "completed-v1.json");
  await writeFile(marker, `${JSON.stringify({
    schemaVersion: "tibotattle-native-electron-handover-v1",
    operationId: "11111111-1111-4111-8111-111111111111",
    candidateDigest: "a".repeat(64),
    phase: "completed",
  })}\n`, { mode: 0o600 });
  await chmod(marker, 0o600);
  const result = await runProductionNativeMacHandover({
    platform: "darwin",
    electronApp: runtimeApp(root),
    resourcesPath: "/not-a-bundled-resource",
    homeDirectory: "/Users/synthetic",
  });
  assert.deepEqual(result, { status: "already_migrated" });
});
