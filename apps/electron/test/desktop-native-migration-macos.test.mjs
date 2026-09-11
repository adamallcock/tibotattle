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

function responseSpawn(reply, calls, { exitCode = 0, signal = null } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify(reply)}\n`);
      child.stderr.end();
      child.emit("close", exitCode, signal);
    });
    return child;
  };
}

function preparedReply() {
  return {
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
    status: "native_writer_prepared",
    nativeWriterStopped: true,
    preferences: {
      language: "en-US",
      appearance: "light",
      refreshIntervalSeconds: 300,
    },
    credentialState: "unchanged",
  };
}

test("macOS bridge calls only the fixed helper operation and validates its reply", async () => {
  const calls = [];
  let loginStatus = { openAtLogin: true, status: "enabled" };
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
    checkpointPreferences: async () => {},
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

  for (const stage of [
    "login_item_requires_approval",
    "login_item_not_found",
    "login_item_status_unknown",
    "other_same_identity_running",
  ]) {
    const statusFailure = createMacNativeHandoverAdapter({
      platform: "darwin",
      helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
      electronApp: app,
      spawnProcess: responseSpawn({
        schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
        status: "failed",
        failureStage: stage,
      }, [], { exitCode: 1 }),
    });
    await assert.rejects(statusFailure.prepareNativeHandover({
      nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
    }), (error) => error?.code === `native_electron_mac_bridge_prepare_${stage}`);
  }

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
  }), (error) => error?.code === "native_electron_mac_bridge_failed");
});

test("macOS bridge rejects a non-zero success reply and every signalled reply", async () => {
  const app = {
    setLoginItemSettings() {},
    getLoginItemSettings() { return { openAtLogin: false, status: "not-registered" }; },
  };
  const makeAdapter = (reply, options) => createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app,
    spawnProcess: responseSpawn(reply, [], options),
  });

  await assert.rejects(makeAdapter(preparedReply(), { exitCode: 1 }).prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_failed");
  await assert.rejects(makeAdapter({
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
    status: "preflight_ready",
  }, { exitCode: 1 }).preflightNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_failed");
  await assert.rejects(makeAdapter({
    schemaVersion: "tibotattle-native-electron-handover-bridge-v1",
    status: "failed",
    failureStage: "native_writer",
  }, { exitCode: null, signal: "SIGTERM" }).prepareNativeHandover({
    nativeAppPath: "/Applications/TiboTattle-old.app", candidate: CANDIDATE,
  }), (error) => error?.code === "native_electron_mac_bridge_failed");
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

function retainedCandidate() {
  return {
    route: "automatic_retained_state",
    native: { appId: "com.usagemonitor.local", source: "retained_state" },
    electron: CANDIDATE.electron,
    signatureEvidence: {
      electronCodeHash: CANDIDATE.signatureEvidence.electronCodeHash,
      helperCodeHash: CANDIDATE.signatureEvidence.helperCodeHash,
    },
  };
}

test("ordinary replacement inspects retained state without a predecessor executable or fabricated metadata", async () => {
  const commands = [];
  const electronAppPath = "/Applications/TiboTattle.app";
  const result = await inspectNativeMacHandover({
    homeDirectory: "/Users/synthetic",
    electronAppPath,
    helperPath: `${electronAppPath}/Contents/MacOS/TiboTattleNativeHandover`,
    lstatPath: async (path) => {
      if (path.endsWith("Usage Monitor") || path === electronAppPath || path.endsWith("TiboTattleNativeHandover")) {
        return inspectionLstat(path);
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    commandRunner: async (command, args) => {
      commands.push({ command, args });
      return inspectionCommand(command, args);
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.nativeAppPath, null);
  assert.equal(result.candidate.route, "automatic_retained_state");
  assert.deepEqual(result.candidate.native, { appId: "com.usagemonitor.local", source: "retained_state" });
  assert.deepEqual(Object.keys(result.candidate.signatureEvidence).sort(), ["electronCodeHash", "helperCodeHash"]);
  assert.ok(commands.every(({ args }) => args.at(-1).startsWith(electronAppPath)));
});

test("a verified 0.1.16 predecessor uses retained schema compatibility instead of requiring an intermediate app", async () => {
  const result = await inspectNativeMacHandover({
    homeDirectory: "/Users/synthetic",
    nativeAppPath: "/Applications/TiboTattle-old.app",
    electronAppPath: "/Applications/TiboTattle.app",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    lstatPath: async (path) => inspectionLstat(path),
    commandRunner: async (command, args) => {
      if (command === "/usr/bin/plutil" && args.at(-1).includes("old") && args[1] === "CFBundleShortVersionString") {
        return { code: 0, signal: null, stdout: "0.1.16\n", stderr: "" };
      }
      return inspectionCommand(command, args);
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.nativeAppPath, null);
  assert.equal(result.candidate.route, "automatic_retained_state");
});

test("retained-state helper operations never accept or forward a caller path", async () => {
  const calls = [];
  const adapter = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: runtimeApp(),
    spawnProcess: responseSpawn(preparedReply(), calls),
  });
  await adapter.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(), checkpointPreferences: async () => {} });
  assert.deepEqual(calls[0].args, ["--prepare-retained-state"]);
  await assert.rejects(adapter.prepareNativeHandover({
    nativeAppPath: "/Applications/unrelated.app", candidate: retainedCandidate(),
  }), (error) => error.code === "native_electron_mac_bridge_invalid_native_app");
  assert.equal(calls.length, 1);
  const preflightCalls = [];
  const preflight = createMacNativeHandoverAdapter({
    platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: runtimeApp(),
    spawnProcess: responseSpawn({
      schemaVersion: "tibotattle-native-electron-handover-bridge-v1", status: "preflight_ready",
    }, preflightCalls),
  });
  await preflight.preflightNativeHandover({ nativeAppPath: null, candidate: retainedCandidate() });
  assert.deepEqual(preflightCalls[0].args, ["--prepare-retained-state-preflight"]);
});

test("retained-state discovery still rejects an unverified current application or foreign helper", async () => {
  for (const failure of ["signature", "helper-team"]) {
    const operation = inspectNativeMacHandover({
      homeDirectory: "/Users/synthetic",
      electronAppPath: "/Applications/TiboTattle.app",
      helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
      lstatPath: async (path) => {
        if (path.includes("Native Handover") || path.includes("/synthetic/Applications")) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return inspectionLstat(path);
      },
      commandRunner: async (command, args) => {
        const result = inspectionCommand(command, args);
        if (failure === "signature" && args[0] === "--verify") return { ...result, code: 1 };
        if (failure === "helper-team" && args.at(-1).endsWith("TiboTattleNativeHandover")) {
          return { ...result, stderr: result.stderr.replace("TEAM123", "OTHERTEAM") };
        }
        return result;
      },
    });
    if (failure === "signature") await assert.rejects(operation, { code: "native_electron_mac_inspection_code_unverified" });
    else assert.deepEqual(await operation, { status: "signature_or_build_mismatch" });
  }
});

test("actual main application owns startup transfer and helper cannot forge startup preference", async () => {
  const order = [];
  let enabled = true;
  const app = {
    getLoginItemSettings() { order.push("read-main"); return { openAtLogin: enabled, status: enabled ? "enabled" : "not-registered" }; },
    setLoginItemSettings({ openAtLogin }) { order.push(`write-main:${openAtLogin}`); enabled = openAtLogin; },
  };
  const adapter = createMacNativeHandoverAdapter({ platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover", electronApp: app,
    spawnProcess: (...args) => { order.push("stop-native-writer"); return responseSpawn(preparedReply(), [])(...args); },
  });
  const result = await adapter.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(), checkpointPreferences: async (value) => { order.push("durable-snapshot"); assert.equal(value.startAtLogin, true); } });
  assert.deepEqual(order, ["read-main", "stop-native-writer", "durable-snapshot", "write-main:false", "read-main"]);
  assert.equal(result.preferences.startAtLogin, true);
  assert.equal(result.loginItemDisabled, true);
  assert.equal(enabled, false);

  const forged = preparedReply(); forged.preferences.startAtLogin = false;
  const refused = createMacNativeHandoverAdapter({ platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover", electronApp: app,
    spawnProcess: responseSpawn(forged, []),
  });
  order.length = 0;
  await assert.rejects(refused.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate() }),
    (error) => error.code === "native_electron_mac_bridge_invalid_reply");
  assert.deepEqual(order, ["read-main"], "invalid helper data cannot change main-app startup registration");
});

test("unavailable or pending main-app registration is preserved through preflight, preparation and claim", async () => {
  for (const status of ["not-found", "requires-approval"]) {
    for (const candidate of [CANDIDATE, retainedCandidate()]) {
      const calls = [];
      const snapshots = [];
      let reads = 0;
      const nativeAppPath = candidate.route === "automatic_retained_state" ? null : "/Applications/TiboTattle-old.app";
      const app = {
        getLoginItemSettings() { reads += 1; return { openAtLogin: false, status }; },
        setLoginItemSettings: () => assert.fail("preserved registration must never be mutated"),
      };
      const adapter = createMacNativeHandoverAdapter({ platform: "darwin",
        helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
        electronApp: app,
        spawnProcess: (command, args, options) => responseSpawn(args[0].endsWith("preflight") ? {
          schemaVersion: "tibotattle-native-electron-handover-bridge-v1", status: "preflight_ready",
        } : preparedReply(), calls)(command, args, options),
      });
      assert.deepEqual(await adapter.preflightNativeHandover({ nativeAppPath, candidate }), { status: "preflight_ready" });
      const prepared = await adapter.prepareNativeHandover({ nativeAppPath, candidate,
        checkpointPreferences: async (value) => snapshots.push(value),
      });
      assert.deepEqual(prepared, {
        status: "prepared", nativeWriterStopped: true, loginItemDisabled: false,
        startupRegistration: "preserved",
        preferences: { language: "en", appearance: "light", refreshIntervalSeconds: 300, startAtLogin: null },
        credentialState: "unchanged",
      });
      assert.deepEqual(snapshots, [{ ...prepared.preferences, credentialState: "unchanged" }]);
      assert.equal(await adapter.claimElectronLoginItem({ startAtLogin: null, candidate }), "preserved");
      assert.equal(reads, 2, "claim leaves the registration alone, even if its status may have changed");
      assert.equal(calls.length, 2);
    }
  }
});

test("preserved startup retries never disable a now-readable registration", async () => {
  const snapshots = [];
  const adapter = createMacNativeHandoverAdapter({ platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: {
      getLoginItemSettings: () => ({ openAtLogin: true, status: "enabled" }),
      setLoginItemSettings: () => assert.fail("a durable unknown choice cannot become a startup mutation on retry"),
    },
    spawnProcess: responseSpawn(preparedReply(), []),
  });
  const prepared = await adapter.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(),
    preserveStartupRegistration: true, checkpointPreferences: async (value) => snapshots.push(value),
  });
  assert.equal(prepared.startupRegistration, "preserved");
  assert.equal(prepared.preferences.startAtLogin, null);
  assert.equal(snapshots[0].startAtLogin, null);
  for (const value of [null, "true", 1]) {
    await assert.rejects(adapter.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(),
      preserveStartupRegistration: value, checkpointPreferences: async () => assert.fail("invalid option cannot checkpoint"),
    }), { code: "native_electron_mac_bridge_invalid_login_item_request" });
  }
});

test("preserved startup still requires authentic candidate, valid helper reply and durable preferences", async () => {
  const app = {
    getLoginItemSettings: () => ({ openAtLogin: false, status: "not-found" }),
    setLoginItemSettings: () => assert.fail("unexpected startup mutation"),
  };
  const makeAdapter = (reply = preparedReply()) => createMacNativeHandoverAdapter({ platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: app, spawnProcess: responseSpawn(reply, []),
  });
  const forged = preparedReply(); forged.preferences.startAtLogin = null;
  await assert.rejects(makeAdapter(forged).prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(),
    checkpointPreferences: async () => assert.fail("forged reply cannot checkpoint"),
  }), { code: "native_electron_mac_bridge_invalid_reply" });
  await assert.rejects(makeAdapter().prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate() }),
    { code: "native_electron_mac_bridge_prepare_preferences" });
  const checkpointFailure = new Error("synthetic checkpoint failure");
  await assert.rejects(makeAdapter().prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(),
    checkpointPreferences: async () => { throw checkpointFailure; },
  }), (error) => error === checkpointFailure);
  const candidate = retainedCandidate(); candidate.signatureEvidence.helperCodeHash = "invalid";
  await assert.rejects(makeAdapter().claimElectronLoginItem({ startAtLogin: null, candidate }),
    { code: "native_electron_handover_signature_evidence_invalid" });
  for (const startAtLogin of [undefined, "false", 0]) {
    await assert.rejects(makeAdapter().claimElectronLoginItem({ startAtLogin, candidate: retainedCandidate() }),
      { code: "native_electron_mac_bridge_invalid_login_item_request" });
  }
});

test("malformed or contradictory main-app startup states block before stopping native writers", async () => {
  for (const value of [
    { openAtLogin: false, status: "unexpected" },
    { openAtLogin: true, status: "not-found" },
    { openAtLogin: true, status: "requires-approval" },
    { status: "not-found" },
    { openAtLogin: false, status: "enabled" },
    null,
  ]) {
    const calls = [];
    const adapter = createMacNativeHandoverAdapter({ platform: "darwin",
      helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
      electronApp: { getLoginItemSettings: () => value, setLoginItemSettings: () => assert.fail("unexpected startup mutation") },
      spawnProcess: responseSpawn(preparedReply(), calls),
    });
    await assert.rejects(adapter.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate() }),
      (error) => error.code === "native_electron_mac_bridge_prepare_login_item_status_unknown");
    assert.equal(calls.length, 0);
  }
});

test("startup disable must be verified before the coordinator can copy retained data", async () => {
  const adapter = createMacNativeHandoverAdapter({ platform: "darwin",
    helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
    electronApp: { getLoginItemSettings: () => ({ openAtLogin: true, status: "enabled" }), setLoginItemSettings() {} },
    spawnProcess: responseSpawn(preparedReply(), []),
  });
  await assert.rejects(adapter.prepareNativeHandover({ nativeAppPath: null, candidate: retainedCandidate(), checkpointPreferences: async () => {} }),
    (error) => error.code === "native_electron_mac_bridge_prepare_login_item_status");
});


test("claiming a known startup choice requires explicit matching OS status", async () => {
  for (const [startAtLogin, status] of [
    [false, { openAtLogin: false, status: "not-found" }],
    [false, { openAtLogin: false, status: "requires-approval" }],
    [false, { openAtLogin: false }],
    [false, { openAtLogin: false, status: "not-registered", executableWillLaunchAtLogin: true }],
    [true, { openAtLogin: true, status: "unexpected" }],
    [true, { openAtLogin: true, status: "enabled", executableWillLaunchAtLogin: false }],
  ]) {
    const writes = [];
    const adapter = createMacNativeHandoverAdapter({ platform: "darwin",
      helperPath: "/Applications/TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover",
      electronApp: { getLoginItemSettings: () => status, setLoginItemSettings: (value) => writes.push(value) },
      spawnProcess: () => assert.fail("claim must not invoke the helper"),
    });
    await assert.rejects(adapter.claimElectronLoginItem({ startAtLogin, candidate: retainedCandidate() }),
      { code: "native_electron_mac_bridge_login_item_unavailable" });
    assert.deepEqual(writes, [{ openAtLogin: startAtLogin }]);
  }
});
