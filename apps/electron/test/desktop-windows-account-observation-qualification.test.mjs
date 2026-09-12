import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWindowsDevelopmentEnvironment,
} from "../../../scripts/launch-electron-windows-development.mjs";

import {
  WINDOWS_ACCOUNT_OBSERVATION_MAIN_COMPOSITION_STATUS,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_ENVIRONMENT_KEY,
  WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_MARKER,
  createWindowsQualificationAccountObservationHandover,
  createWindowsQualificationAccountObservationHandoverForTest,
} from "../desktop-windows-account-observation-qualification.js";

function configurationError(error) {
  assert.equal(error?.code, "electron_shell_electron_configuration_invalid");
  assert.equal(error?.message, "Electron shell operation failed");
  return true;
}

function qualificationEnvironment(root = "C:\\qualification\\profile") {
  return Object.freeze({
    GITHUB_ACTIONS: "true",
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
    [WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_ENVIRONMENT_KEY]:
      WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_MARKER,
    TEMP: `${root}\\tmp`,
    TMP: `${root}\\tmp`,
    TMPDIR: `${root}\\tmp`,
    USERPROFILE: `${root}\\home`,
    HOME: `${root}\\home`,
    APPDATA: `${root}\\appdata`,
    LOCALAPPDATA: `${root}\\localappdata`,
    CODEX_HOME: `${root}\\codex`,
    CLAUDE_CONFIG_DIR: `${root}\\claude`,
    XDG_CONFIG_HOME: `${root}\\config`,
    XDG_DATA_HOME: `${root}\\data`,
    XDG_CACHE_HOME: `${root}\\cache`,
    XDG_RUNTIME_DIR: `${root}\\runtime`,
    USAGE_MONITOR_STATE_ROOT: `${root}\\state`,
  });
}

function launcherDerivedQualificationEnvironment() {
  const profile = Object.freeze({
    root: "/launcher-profile",
    userData: "/launcher-profile/user-data",
    home: "/launcher-profile/home",
    appdata: "/launcher-profile/appdata",
    localappdata: "/launcher-profile/localappdata",
    codex: "/launcher-profile/codex",
    claude: "/launcher-profile/claude",
    state: "/launcher-profile/state",
    config: "/launcher-profile/config",
    data: "/launcher-profile/data",
    cache: "/launcher-profile/cache",
    runtime: "/launcher-profile/runtime",
    tmp: "/launcher-profile/tmp",
  });
  const launcherEnvironment = buildWindowsDevelopmentEnvironment({
    environment: { PATH: "/safe/bin" },
    profile,
  });
  const root = "C:\\qualification\\launcher-profile";
  const paths = new Map([
    [profile.home, `${root}\\home`],
    [profile.appdata, `${root}\\appdata`],
    [profile.localappdata, `${root}\\localappdata`],
    [profile.codex, `${root}\\codex`],
    [profile.claude, `${root}\\claude`],
    [profile.state, `${root}\\state`],
    [profile.config, `${root}\\config`],
    [profile.data, `${root}\\data`],
    [profile.cache, `${root}\\cache`],
    [profile.runtime, `${root}\\runtime`],
    [profile.tmp, `${root}\\tmp`],
  ]);
  return Object.freeze({
    ...Object.fromEntries(Object.entries(launcherEnvironment).map(([key, value]) => [
      key,
      paths.get(value) ?? value,
    ])),
    GITHUB_ACTIONS: "true",
    [WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_ENVIRONMENT_KEY]:
      WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION_MARKER,
  });
}

function fixture({ contextAccepted = true } = {}) {
  const calls = [];
  const adapter = Object.freeze({ kind: "synthetic-windows-filesystem-adapter" });
  const platformContext = Object.freeze({
    kind: "branded-synthetic-platform-context",
    stateRoot: "C:\\qualification\\profile\\state",
  });
  const qualificationContext = Object.freeze({
    resourceRoot: "C:\\qualification\\package\\app.asar",
  });
  const backend = Object.freeze({ close() {} });
  const dependencies = Object.freeze({
    assertElectronQualificationContext(options) {
      calls.push(["electron-context", options]);
      if (!contextAccepted) throw new Error("private context canary");
      return qualificationContext;
    },
    createAdapter(options) {
      calls.push(["adapter", options]);
      return adapter;
    },
    createQualificationContext(options) {
      calls.push(["platform-context", options]);
      return platformContext;
    },
    createQualifiedBackend(options) {
      calls.push(["backend", options]);
      return backend;
    },
    attachBroker(options) {
      calls.push(["broker", {
        channel: options.channel,
        isBackendError: options.isBackendError,
      }]);
      const selected = options.createBackend();
      assert.equal(selected, backend);
      return Object.freeze({ dispose() {} });
    },
    isBackendError() { return false; },
  });
  const options = Object.freeze({
    platform: "win32",
    architecture: "x64",
    environment: qualificationEnvironment(),
    qualificationContext,
  });
  return Object.freeze({
    adapter,
    backend,
    calls,
    dependencies,
    options,
    platformContext,
    qualificationContext,
  });
}

test("Windows account-observation handover authenticates the packaged context and CI lane before native construction", () => {
  assert.equal(WINDOWS_ACCOUNT_OBSERVATION_MAIN_COMPOSITION_STATUS, "qualification_only");
  const rejected = fixture({ contextAccepted: false });
  assert.throws(
    () => createWindowsQualificationAccountObservationHandoverForTest(
      rejected.options,
      rejected.dependencies,
    ),
    configurationError,
  );
  assert.deepEqual(rejected.calls.map(([name]) => name), ["electron-context"]);

  const noCi = fixture();
  assert.throws(
    () => createWindowsQualificationAccountObservationHandoverForTest({
      ...noCi.options,
      environment: Object.freeze({
        ...noCi.options.environment,
        GITHUB_ACTIONS: "false",
      }),
    }, noCi.dependencies),
    configurationError,
  );
  assert.deepEqual(noCi.calls.map(([name]) => name), ["electron-context"]);
});

test("Windows account-observation handover binds the exact disposable profile and fixed Node IPC backend", () => {
  const value = fixture();
  const handover = createWindowsQualificationAccountObservationHandoverForTest(
    value.options,
    value.dependencies,
  );
  const channel = Object.freeze({ kind: "synthetic-ipc" });
  const broker = handover.attachWindowsAccountObservationBroker(channel);
  assert.equal(typeof broker.dispose, "function");
  assert.deepEqual(value.calls.map(([name]) => name), [
    "electron-context", "adapter", "platform-context", "broker", "backend",
  ]);
  assert.deepEqual(value.calls[0][1], {
    context: value.qualificationContext,
    platform: "win32",
    architecture: "x64",
  });
  assert.deepEqual(value.calls[1][1], { platform: "win32", architecture: "x64" });
  const platformOptions = value.calls[2][1];
  assert.deepEqual(Object.keys(platformOptions).sort(), [
    "adapter", "architecture", "environment", "platform", "resourceRoot",
  ]);
  assert.equal(platformOptions.adapter, value.adapter);
  assert.equal(platformOptions.environment.TEMP, "C:\\qualification\\profile");
  assert.equal(platformOptions.environment.USAGE_MONITOR_STATE_ROOT,
    "C:\\qualification\\profile\\state");
  assert.equal(platformOptions.resourceRoot, value.qualificationContext.resourceRoot);
  assert.deepEqual(value.calls[3][1].channel, channel);
  assert.deepEqual(value.calls[4][1], {
    adapter: value.adapter,
    resourceRoot: value.qualificationContext.resourceRoot,
    windowsQualificationModeContext: value.platformContext,
  });
});

test("Windows account-observation handover accepts the actual launcher environment shape plus its explicit CI marker", () => {
  const value = fixture();
  const environment = launcherDerivedQualificationEnvironment();
  assert.equal(environment.USAGE_MONITOR_WINDOWS_QUALIFICATION, undefined);
  const handover = createWindowsQualificationAccountObservationHandoverForTest({
    ...value.options,
    environment,
  }, value.dependencies);
  handover.attachWindowsAccountObservationBroker(Object.freeze({ kind: "derived-ipc" }));
  const platformOptions = value.calls.find(([name]) => name === "platform-context")[1];
  assert.equal(platformOptions.environment.TEMP, "C:\\qualification\\launcher-profile");
  assert.equal(platformOptions.environment.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE, "unified");
  assert.equal(platformOptions.environment.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION,
    "windows-electron-v1");
  assert.equal(platformOptions.environment.USAGE_MONITOR_TEST_LANE, "windows-electron-smoke");
});

test("production handover cannot be enabled by a synthetic context outside an actual Windows qualification process", () => {
  assert.throws(
    () => createWindowsQualificationAccountObservationHandover({
      environment: qualificationEnvironment(),
      qualificationContext: Object.freeze({
        resourceRoot: "C:\\qualification\\package\\app.asar",
      }),
    }),
    configurationError,
  );
});
