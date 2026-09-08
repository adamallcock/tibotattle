import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { DesktopSettingsBackendError } from "../apps/electron/desktop-settings-backends.js";
import { WindowsProtectedStateStoreError } from "../src/platform/windows-protected-state-store.js";
import {
  buildWindowsNormalCandidateEnvironment,
  buildWindowsNormalCandidateLaunchSpec,
  prepareWindowsDevelopmentProfile,
} from "../scripts/launch-electron-windows-development.mjs";
import {
  buildWindowsNormalCandidateFirewallCreateArguments,
  buildWindowsNormalCandidateFirewallRemoveArguments,
  createWindowsNormalCandidateQuitProtocol,
  jsonFetch,
  parseWindowsNormalCandidateSmokeArguments,
  prepareWindowsNormalCandidateProfile,
  runWindowsNormalCandidateSmoke,
  selectWindowsNormalCandidateDashboardTarget,
  selectWindowsNormalCandidateSettingsTarget,
  validateWindowsNormalCandidateSmokeMetadata,
  verifyWindowsNormalCandidateSmokePackage,
} from "../scripts/smoke-electron-windows-normal-candidate.mjs";

const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const APP_PATH = String.raw`C:\candidate\artifacts\win-unpacked\TiboTattle.exe`;
const STAGED_APP_PATH = String.raw`C:\candidate\app`;
const SOURCE_CANDIDATE_PATH = String.raw`C:\candidate\production-source-candidate.json`;
const RECEIPT_PATH = String.raw`C:\workspace\.release-build\electron-windows-normal-candidate\normal-candidate-smoke.json`;
const FIREWALL_RULE = "tibotattle-normal-candidate-550e8400-e29b-41d4-a716-446655440000";

test("normal candidate loopback requests refuse redirects and bound response waits", async () => {
  let options;
  await assert.rejects(jsonFetch("http://127.0.0.1:12345/api/local/health", {
    fetchImpl: async (_url, selected) => {
      options = selected;
      return { ok: true, redirected: true, json: async () => ({ status: "ready" }) };
    },
  }), /loopback response unavailable/u);
  assert.equal(options.redirect, "error");
  assert.equal(options.signal.aborted, true);
  await assert.rejects(jsonFetch("http://127.0.0.1:12345/api/local/health", {
    timeoutMs: 10,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  }), /loopback response unavailable/u);
});

function smokeOptions() {
  return {
    appPath: APP_PATH,
    stagedAppPath: STAGED_APP_PATH,
    sourceCandidatePath: SOURCE_CANDIDATE_PATH,
    sourceRevision: SOURCE_REVISION,
    receiptPath: RECEIPT_PATH,
  };
}

function sourceCandidate() {
  return {
    schemaVersion: "tibotattle-electron-production-source-candidate-v1",
    status: "production_source_staged",
    target: "win32-x64",
    sourceRevision: SOURCE_REVISION,
    version: "0.1.0",
    stagingDirectory: ".release-build/electron-production/win32-x64/app",
    builderConfiguration: "apps/electron/electron-builder.production.config.cjs",
    updaterEnabled: true,
    signingRequired: true,
    signingPerformed: false,
    publishingPerformed: false,
    windowsRuntimeQualification: "required",
  };
}

function candidateMetadata() {
  return createProductionDistributionMetadata({
    buildNumber: "12345",
    sourceRevision: SOURCE_REVISION,
    target: "win32-x64",
  });
}

function packageStageFailure(code) {
  return Object.assign(new Error(code), {
    code: `ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_${code}`,
  });
}

function packageVerificationDependencies({
  verifyPaths = async () => {},
  readJsonFile,
  digest = async () => ({ bytes: 1, sha256: "a".repeat(64) }),
  asar,
  validateNative,
  useNativePair = false,
} = {}) {
  const manifest = { version: "0.1.0", tibotattleDistribution: candidateMetadata() };
  const selectedValidateNative = validateNative ?? (useNativePair ? undefined : async () => ({
    windowsFilesystemSha256: "b".repeat(64),
    keytarSha256: "c".repeat(64),
  }));
  return {
    platform: "win32",
    architecture: "x64",
    verifyPaths,
    readJsonFile: readJsonFile ?? (async (_path, code) => {
      if (code === "SOURCE_CANDIDATE_INVALID") return sourceCandidate();
      assert.equal(code, "PACKAGE_STAGED_MANIFEST_INVALID");
      return manifest;
    }),
    digest,
    asar: asar ?? {
      extractFile: () => Buffer.from(JSON.stringify(manifest)),
    },
    ...(selectedValidateNative === undefined ? {} : { validateNative: selectedValidateNative }),
  };
}

function passedJourney() {
  return {
    dashboardRendered: true,
    localRefreshObserved: true,
    localRefreshTerminal: "succeeded",
    sharingOptOutRetained: true,
    settingsPersisted: true,
    cleanQuit: true,
  };
}

function normalCandidateSeedDependencies(overrides = {}) {
  let receipt = null;
  return {
    createAdapter: () => Object.freeze({ productionSafe: false }),
    createStore: () => Object.freeze({}),
    createReceiptBackend: () => Object.freeze({
      async load() { return receipt; },
      async save(value) { receipt = value; return value; },
    }),
    createSharingBackend: () => Object.freeze({
      async load() { return null; },
      async save() {},
    }),
    createCoordinator: () => Object.freeze({
      async initialize() {},
      async setEnabled() { return Object.freeze({ enabled: false }); },
      async readAuthorization() {
        return Object.freeze({ enabled: false, transportStatus: "off" });
      },
      dispose() {},
    }),
    ...overrides,
  };
}

const NORMAL_CANDIDATE_PROFILE = Object.freeze({
  userData: String.raw`C:\tibotattle-normal-candidate-test-${randomUUID()}\user-data`,
});

test("Windows normal candidate smoke accepts only its exact unpacked invocation", () => {
  assert.deepEqual(parseWindowsNormalCandidateSmokeArguments([
    "--app", APP_PATH,
    "--staged-app", STAGED_APP_PATH,
    "--source-candidate", SOURCE_CANDIDATE_PATH,
    "--source-revision", SOURCE_REVISION,
    "--receipt", RECEIPT_PATH,
  ]), smokeOptions());
  for (const invalid of [
    ["--app", APP_PATH],
    ["--app", APP_PATH, "--app", APP_PATH,
      "--staged-app", STAGED_APP_PATH,
      "--source-candidate", SOURCE_CANDIDATE_PATH,
      "--source-revision", SOURCE_REVISION,
      "--receipt", RECEIPT_PATH],
    ["--app", String.raw`C:\candidate\artifacts\win-unpacked\other.exe`,
      "--staged-app", STAGED_APP_PATH,
      "--source-candidate", SOURCE_CANDIDATE_PATH,
      "--source-revision", SOURCE_REVISION,
      "--receipt", RECEIPT_PATH],
    ["--app", APP_PATH,
      "--staged-app", String.raw`C:\other\app`,
      "--source-candidate", SOURCE_CANDIDATE_PATH,
      "--source-revision", SOURCE_REVISION,
      "--receipt", RECEIPT_PATH],
  ]) {
    assert.throws(() => parseWindowsNormalCandidateSmokeArguments(invalid), {
      code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_ARGUMENT_INVALID",
    });
  }
});

test("Windows normal candidate smoke binds source staging and archived metadata to stable win32-x64", () => {
  const distribution = candidateMetadata();
  const manifest = { version: "0.1.0", tibotattleDistribution: distribution };
  assert.deepEqual(validateWindowsNormalCandidateSmokeMetadata({
    sourceCandidate: sourceCandidate(),
    stagedManifest: manifest,
    archiveManifest: manifest,
    sourceRevision: SOURCE_REVISION,
  }), {
    sourceRevision: SOURCE_REVISION,
    target: "win32-x64",
    distribution,
  });
  for (const invalid of [
    { ...sourceCandidate(), target: "linux-x64" },
    { ...sourceCandidate(), signingRequired: false },
    { ...sourceCandidate(), windowsRuntimeQualification: "not_applicable" },
  ]) {
    assert.throws(() => validateWindowsNormalCandidateSmokeMetadata({
      sourceCandidate: invalid,
      stagedManifest: manifest,
      archiveManifest: manifest,
      sourceRevision: SOURCE_REVISION,
    }), /ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_SOURCE_CANDIDATE_INVALID/u);
  }
  assert.throws(() => validateWindowsNormalCandidateSmokeMetadata({
    sourceCandidate: sourceCandidate(),
    stagedManifest: manifest,
    archiveManifest: { version: "0.1.0", tibotattleDistribution: { ...distribution, channel: "beta" } },
    sourceRevision: SOURCE_REVISION,
  }), /ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_METADATA_INVALID/u);
});

test("normal candidate package verification keeps its closed failure stages distinct", async () => {
  const verify = (dependencies) => verifyWindowsNormalCandidateSmokePackage(
    smokeOptions(),
    packageVerificationDependencies(dependencies),
  );
  const valid = await verify({
    validateNative: async ({ failureCode }) => {
      assert.equal(failureCode, "PACKAGE_NATIVE_MEMBERS_INVALID");
      return {
        windowsFilesystemSha256: "b".repeat(64),
        keytarSha256: "c".repeat(64),
      };
    },
  });
  assert.equal(valid.target, "win32-x64");

  await assert.rejects(verify({
    verifyPaths: async () => { throw packageStageFailure("PACKAGE_PATHS_INVALID"); },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_PATHS_INVALID" });

  const readCodes = [];
  await assert.rejects(verify({
    readJsonFile: async (_path, code) => {
      readCodes.push(code);
      if (code === "SOURCE_CANDIDATE_INVALID") return sourceCandidate();
      throw packageStageFailure("PACKAGE_STAGED_MANIFEST_INVALID");
    },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_STAGED_MANIFEST_INVALID" });
  assert.deepEqual(readCodes, ["SOURCE_CANDIDATE_INVALID", "PACKAGE_STAGED_MANIFEST_INVALID"]);

  await assert.rejects(verify({
    asar: { extractFile: () => { throw new Error("unavailable"); } },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID" });

  const manifest = { version: "0.1.0", tibotattleDistribution: {
    ...candidateMetadata(), channel: "beta",
  } };
  await assert.rejects(verify({
    asar: { extractFile: () => Buffer.from(JSON.stringify(manifest)) },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_METADATA_INVALID" });

  let nativeFailureCode = null;
  await assert.rejects(verify({
    validateNative: async ({ failureCode }) => {
      nativeFailureCode = failureCode;
      throw packageStageFailure("PACKAGE_NATIVE_MEMBERS_INVALID");
    },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_NATIVE_MEMBERS_INVALID" });
  assert.equal(nativeFailureCode, "PACKAGE_NATIVE_MEMBERS_INVALID");
});

test("normal candidate package verification uses Windows ASAR separators for the virtual native sidecar", async () => {
  const nativeManifest = Buffer.from("fixed-native-sidecar", "utf8");
  const nativeDigest = Object.freeze({
    bytes: nativeManifest.byteLength,
    sha256: createHash("sha256").update(nativeManifest).digest("hex"),
  });
  const virtualManifest = String.raw`native\windows-filesystem\build\Release\windows_filesystem.node.manifest.json`;
  const members = [];
  const result = await verifyWindowsNormalCandidateSmokePackage(
    smokeOptions(),
    packageVerificationDependencies({
      useNativePair: true,
      digest: async () => nativeDigest,
      asar: {
        extractFile: (_archive, member) => {
          members.push(member);
          if (member === "package.json") {
            return Buffer.from(JSON.stringify({
              version: "0.1.0",
              tibotattleDistribution: candidateMetadata(),
            }));
          }
          if (member === virtualManifest) return nativeManifest;
          throw new Error("unexpected archive member");
        },
      },
    }),
  );
  assert.equal(result.target, "win32-x64");
  assert.deepEqual(members, ["package.json", virtualManifest]);
});

test("normal candidate protected opt-out seeding retains closed source causes by stage", async () => {
  const seed = (dependencies) => prepareWindowsNormalCandidateProfile({
    profile: NORMAL_CANDIDATE_PROFILE,
    stagedAppPath: STAGED_APP_PATH,
  }, normalCandidateSeedDependencies(dependencies));

  await assert.rejects(seed({
    createAdapter() {
      throw Object.assign(new Error("unavailable"), {
        code: "WINDOWS_FILESYSTEM_BINDING_UNAVAILABLE",
      });
    },
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_ADAPTER_UNAVAILABLE_WINDOWS_FILESYSTEM_BINDING_UNAVAILABLE",
  });

  await assert.rejects(seed({
    createStore() { throw new WindowsProtectedStateStoreError("security_policy"); },
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_STORE_UNAVAILABLE_WINDOWS_PROTECTED_STATE_STORE_SECURITY_POLICY",
  });

  await assert.rejects(seed({
    createReceiptBackend: () => Object.freeze({
      async load() { throw new DesktopSettingsBackendError("store_unsafe"); },
      async save() {},
    }),
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE_DESKTOP_SETTINGS_BACKEND_STORE_UNSAFE",
  });

  await assert.rejects(seed({
    createReceiptBackend: () => Object.freeze({
      async load() { return null; },
      async save() { throw new DesktopSettingsBackendError("write_failed"); },
    }),
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE_DESKTOP_SETTINGS_BACKEND_WRITE_FAILED",
  });

  await assert.rejects(seed({
    createCoordinator: () => Object.freeze({
      async initialize() {},
      async setEnabled() { throw new DesktopSettingsBackendError("unavailable"); },
      async readAuthorization() { return null; },
      dispose() {},
    }),
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PROTECTED_OPT_OUT_SHARING_UNAVAILABLE_DESKTOP_SETTINGS_BACKEND_UNAVAILABLE",
  });

  const unknownStages = [
    {
      stage: "PROTECTED_OPT_OUT_ADAPTER_UNAVAILABLE",
      dependencies: {
        createAdapter() { throw new Error("private adapter detail"); },
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_STORE_UNAVAILABLE",
      dependencies: {
        createStore() { throw new Error("private store detail"); },
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_INITIAL_READ_UNAVAILABLE",
      dependencies: {
        createReceiptBackend: () => Object.freeze({
          async load() { throw new Error("private initial detail"); },
          async save() {},
        }),
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_FIRST_RUN_UNAVAILABLE",
      dependencies: {
        createReceiptBackend: () => Object.freeze({
          async load() { return null; },
          async save() { throw new Error("private receipt detail"); },
        }),
      },
    },
    {
      stage: "PROTECTED_OPT_OUT_SHARING_UNAVAILABLE",
      dependencies: {
        createCoordinator: () => Object.freeze({
          async initialize() {},
          async setEnabled() { throw new Error("private sharing detail"); },
          async readAuthorization() { return null; },
          dispose() {},
        }),
      },
    },
  ];
  for (const { stage, dependencies } of unknownStages) {
    await assert.rejects(seed(dependencies), (error) => {
      assert.equal(error.code, `ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_${stage}`);
      assert.equal(error.message, error.code);
      assert.doesNotMatch(error.message, /private/u);
      return true;
    });
  }
});

test("normal candidate runner preserves a package stage in its content-free receipt", async () => {
  let receipt = null;
  await assert.rejects(runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\\runner\\temp` },
    ensureReceiptParent: async () => {},
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => { throw packageStageFailure("PACKAGE_ARCHIVE_MANIFEST_INVALID"); },
  }), { code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID" });
  assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_PACKAGE_ARCHIVE_MANIFEST_INVALID");
  assert.equal(receipt.packageArtifactVerified, false);
  assert.equal(receipt.packagedElectronExecutionVerified, false);
});

test("normal candidate launcher keeps only the private profile, unified mode, and quit-only control", async () => {
  const root = await mkdtemp(join(
    await realpath(tmpdir()),
    "tibotattle-windows-normal-candidate-test-",
  ));
  try {
    const profile = await prepareWindowsDevelopmentProfile({
      appPath: join(root, "candidate", "TiboTattle.exe"),
      profilePath: join(root, "profile"),
    });
    const environment = buildWindowsNormalCandidateEnvironment({
      profile,
      environment: {
        PATH: "/safe/bin",
        SystemRoot: "/windows",
        NODE_OPTIONS: "--require=private.js",
        USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
        USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
        USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://example.invalid",
        USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid",
      },
    });
    assert.equal(environment.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE, "unified");
    assert.equal(environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL, "quit-v1");
    for (const key of [
      "NODE_OPTIONS",
      "USAGE_MONITOR_TEST_LANE",
      "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION",
      "USAGE_MONITOR_ACCOUNTLESS_ORIGIN",
      "USAGE_MONITOR_CENTRAL_ORIGIN",
    ]) assert.equal(Object.hasOwn(environment, key), false, key);
    const spec = buildWindowsNormalCandidateLaunchSpec({
      appPath: join(root, "candidate", "TiboTattle.exe"),
      profile,
      remoteDebuggingPort: 9222,
      environment: { PATH: "/safe/bin" },
    });
    assert.deepEqual(spec.args, [
      `--user-data-dir=${profile.userData}`,
      "--remote-debugging-port=9222",
      "--remote-debugging-address=127.0.0.1",
      "--disable-gpu",
    ]);
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.env.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL, "quit-v1");
    assert.throws(() => buildWindowsNormalCandidateLaunchSpec({
      appPath: join(root, "candidate", "TiboTattle Dev.exe"),
      profile,
      remoteDebuggingPort: 9222,
    }), /ELECTRON_WINDOWS_DEVELOPMENT_APP_INVALID/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal candidate firewall scripts use only fixed child environment values and recheck ownership before removal", () => {
  const create = buildWindowsNormalCandidateFirewallCreateArguments();
  const remove = buildWindowsNormalCandidateFirewallRemoveArguments();
  assert.equal(create.length, 5);
  assert.equal(remove.length, 5);
  for (const command of [create[4], remove[4]]) {
    assert.match(command, /USAGE_MONITOR_WINDOWS_NORMAL_CANDIDATE_APP/u);
    assert.match(command, /USAGE_MONITOR_WINDOWS_NORMAL_CANDIDATE_FIREWALL_RULE/u);
    assert.match(command, /Get-NetFirewallApplicationFilter/u);
    assert.doesNotMatch(command, /C:\\candidate|tibotattle-normal-candidate-550e/u);
  }
  assert.match(create[4], /-Direction Outbound -Action Block/u);
  assert.ok(remove[4].indexOf("Get-NetFirewallApplicationFilter") < remove[4].indexOf("Remove-NetFirewallRule"));
  assert.match(remove[4], /\$rule\.Name -ne \$name/u);
  assert.match(remove[4], /\$filters\.Count -ne 1/u);
});

test("normal candidate CDP selection accepts the real trailing-slash root and rejects other origins", () => {
  const targets = [
    {
      type: "page",
      url: "http://127.0.0.1:43123/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/dashboard",
    },
    {
      type: "page",
      url: "https://example.invalid/",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/remote",
    },
  ];
  assert.equal(selectWindowsNormalCandidateDashboardTarget(targets, 9222), targets[0]);
  assert.equal(selectWindowsNormalCandidateDashboardTarget([
    { ...targets[0], url: "http://127.0.0.1:43123" },
  ], 9222), undefined);
  const settings = {
    type: "page",
    url: "http://127.0.0.1:43123/electron-settings.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/settings",
  };
  assert.equal(selectWindowsNormalCandidateSettingsTarget([settings], "http://127.0.0.1:43123", 9222), settings);
  assert.equal(selectWindowsNormalCandidateSettingsTarget([settings], "http://127.0.0.1:43124", 9222), undefined);
});

test("normal candidate quit protocol accepts only the fixed lifecycle acknowledgement", async () => {
  const child = new EventEmitter();
  child.connected = true;
  const sent = [];
  child.send = (message, callback) => {
    sent.push(message);
    callback?.();
    child.emit("message", { type: "unexpected" });
    setImmediate(() => child.emit("message", { type: "tibotattle-electron-smoke-quit-accepted-v1" }));
  };
  const protocol = createWindowsNormalCandidateQuitProtocol(child, { timeoutMs: 1_000 });
  await protocol.requestQuit();
  protocol.close();
  assert.deepEqual(sent, [{ type: "tibotattle-electron-smoke-quit-v1" }]);
});

test("normal candidate runner orders firewall coverage around both ordinary launches and writes a content-free receipt", async () => {
  const events = [];
  let receipt = null;
  let launchNumber = 0;
  const result = await runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\runner\temp` },
    ensureReceiptParent: async () => { events.push("receipt-parent"); },
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => {
      events.push("package");
      return { sourceRevision: SOURCE_REVISION, artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64) };
    },
    createRoot: async () => { events.push("root"); return String.raw`C:\runner\temp\owned`; },
    prepareProfile: async () => ({ root: String.raw`C:\runner\temp\owned\profile` }),
    seedProfile: async () => ({ shareBackend: {} }),
    assertProcessAbsence: async () => { events.push("absent"); return true; },
    installFirewall: async () => { events.push("firewall-add"); return FIREWALL_RULE; },
    launchJourney: async ({ candidateState, changeSettings }) => {
      events.push(changeSettings ? "first" : "second");
      candidateState.quiescent = false;
      candidateState.tracked = [];
      candidateState.quiescent = true;
      launchNumber += 1;
      return passedJourney();
    },
    verifyOptOut: async () => { events.push("opt-out"); return true; },
    removeFirewall: async () => { events.push("firewall-remove"); return true; },
    removeProfile: async () => { events.push("profile-remove"); },
  });
  assert.equal(launchNumber, 2);
  assert.equal(result.status, "passed");
  assert.ok(events.indexOf("firewall-add") < events.indexOf("first"));
  assert.ok(events.indexOf("second") < events.indexOf("firewall-remove"));
  assert.deepEqual(events, [
    "receipt-parent", "package", "root", "absent", "firewall-add", "first", "second", "opt-out", "firewall-remove", "profile-remove",
  ]);
  assert.deepEqual(receipt, {
    schemaVersion: "tibotattle-electron-windows-normal-candidate-smoke-v1",
    status: "passed",
    scope: "candidate_only",
    target: "win32-x64",
    sourceRevision: SOURCE_REVISION,
    artifactSha256: "a".repeat(64),
    executableSha256: "b".repeat(64),
    packageArtifactVerified: true,
    packagedElectronExecutionVerified: true,
    dashboardRendered: true,
    localRefreshObserved: true,
    localRefreshTerminal: "succeeded",
    settingsPersistedAcrossRestart: true,
    durableContributionOptOutRetained: true,
    loopbackJourneyVerified: true,
    outboundFirewallRuleVerified: true,
    outboundFirewallRuleRemoved: true,
    ownedProfileRemoved: true,
    errorCode: null,
    productionReady: false,
  });
});

test("normal candidate runner retains the outbound block and profile when process cleanup is uncertain", async () => {
  let receipt = null;
  let removedFirewall = false;
  let removedProfile = false;
  await assert.rejects(() => runWindowsNormalCandidateSmoke(smokeOptions(), {
    platform: "win32",
    architecture: "x64",
    environment: { GITHUB_ACTIONS: "true", RUNNER_TEMP: String.raw`C:\runner\temp` },
    ensureReceiptParent: async () => {},
    reserveReceipt: async () => ({
      writeFile: async (value) => { receipt = JSON.parse(value); },
      sync: async () => {},
      close: async () => {},
    }),
    verifyPackage: async () => ({ sourceRevision: SOURCE_REVISION, artifactSha256: "a".repeat(64), executableSha256: "b".repeat(64) }),
    createRoot: async () => String.raw`C:\runner\temp\owned`,
    prepareProfile: async () => ({ root: String.raw`C:\runner\temp\owned\profile` }),
    seedProfile: async () => ({ shareBackend: {} }),
    assertProcessAbsence: async () => true,
    installFirewall: async () => FIREWALL_RULE,
    launchJourney: async ({ candidateState }) => {
      candidateState.quiescent = false;
      throw Object.assign(new Error("dashboard"), {
        code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_DASHBOARD_UNAVAILABLE",
      });
    },
    verifyOptOut: async () => true,
    removeFirewall: async () => { removedFirewall = true; return true; },
    removeProfile: async () => { removedProfile = true; },
  }), {
    code: "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_OWNED_PROCESS_REMAINS",
  });
  assert.equal(removedFirewall, false);
  assert.equal(removedProfile, false);
  assert.equal(receipt.outboundFirewallRuleVerified, true);
  assert.equal(receipt.outboundFirewallRuleRemoved, false);
  assert.equal(receipt.ownedProfileRemoved, false);
  assert.equal(receipt.errorCode, "ELECTRON_WINDOWS_NORMAL_CANDIDATE_SMOKE_OWNED_PROCESS_REMAINS");
});
