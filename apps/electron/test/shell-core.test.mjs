import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

import {
  createCompanionSupervisor,
} from "../companion-supervisor.js";
import {
  createDesktopLifecycle,
} from "../desktop-lifecycle.js";
import {
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
} from "../desktop-first-run.js";
import {
  assertElectronQualificationLaunchOptions,
  companionEnvironment,
  installWindowsSmokeControl,
  installWindowsSmokeControlForTest,
  launchElectronShell,
  MACOS_ELECTRON_LOCAL_QA_TEST_LANE,
} from "../main.js";
import {
  ELECTRON_ENTRY_FAILURE_DIAGNOSTIC,
  ElectronShellError,
} from "../errors.js";
import {
  assertElectronPlatformGate,
} from "../platform-gate.js";
import {
  assertWindowsElectronQualificationContext,
  createWindowsElectronQualificationContext,
  runWindowsElectronQualificationCredentialCommandForTest,
} from "../windows-qualification.js";
import {
  createLoopbackNavigationPolicy,
  installLoopbackNavigationPolicy,
  isAllowedCompanionBlobDownload,
  isAllowedCompanionURL,
} from "../loopback-policy.js";
import {
  COMPANION_READY_LINE_PREFIX,
  createCompanionReadyLineParser,
  parseCompanionReadyLine,
} from "../ready-line.js";
import {
  WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
} from "../../../src/platform/windows-qualification-mode.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const WINDOWS_KEYTAR_PATH = require.resolve(
  "@github/keytar/prebuilds/win32-x64/keytar.node",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function withTestTimeout(promise, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withWindowsQualificationFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-qualification-"));
  const appPath = join(root, "app");
  const bindingPath = join(appPath, "native/windows-filesystem/build/Release/windows_filesystem.node");
  const bindingManifestPath = `${bindingPath}.manifest.json`;
  const keytarPath = join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node");
  const binding = Buffer.from("synthetic Windows qualification binding\n");
  const keytar = await readFile(WINDOWS_KEYTAR_PATH);
  const bindingManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: binding.byteLength,
    sha256: sha256(binding),
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
  })}\n`);
  const runtimeSourcePaths = [...WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS];
  const runtimeFiles = [
    ...runtimeSourcePaths.map((path) => {
      const content = Buffer.from(path, "utf8");
      return {
        bytes: content.byteLength,
        kind: path.startsWith("apps/web/")
          ? "dashboard_asset"
          : path === "apps/local/server.js"
            ? "companion_source"
            : "electron_shell",
        path,
        sha256: sha256(content),
      };
    }),
    {
      bytes: binding.byteLength,
      kind: "windows_native_binding",
      path: "native/windows-filesystem/build/Release/windows_filesystem.node",
      sha256: sha256(binding),
    },
    {
      bytes: bindingManifest.byteLength,
      kind: "windows_native_binding",
      path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      sha256: sha256(bindingManifest),
    },
    {
      bytes: keytar.byteLength,
      kind: "third_party_dependency",
      path: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
      sha256: sha256(keytar),
    },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const payloadHash = createHash("sha256");
  let payloadBytes = 0;
  for (const row of runtimeFiles) {
    payloadBytes += row.bytes;
    payloadHash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  const bindingRow = runtimeFiles.find((row) =>
    row.path === "native/windows-filesystem/build/Release/windows_filesystem.node");
  const runtimeManifest = {
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    architecture: "x64",
    releaseVersion: "0.1.0-dev",
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files: runtimeFiles,
    payload: {
      bytes: payloadBytes,
      sha256: payloadHash.digest("hex"),
    },
    windowsBinding: {
      binding: {
        bytes: bindingRow.bytes,
        path: bindingRow.path,
        sha256: bindingRow.sha256,
      },
      included: true,
      manifest: {
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      },
      status: "included_unverified",
      verified: false,
    },
  };
  await mkdir(join(appPath, "native/windows-filesystem/build/Release"), { recursive: true });
  await mkdir(join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64"), {
    recursive: true,
  });
  await writeFile(bindingPath, binding);
  await writeFile(bindingManifestPath, bindingManifest);
  await writeFile(keytarPath, keytar);
  for (const row of runtimeSourcePaths) {
    const content = Buffer.from(row, "utf8");
    const path = join(appPath, ...row.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(
    join(appPath, "electron-runtime-manifest.json"),
    `${JSON.stringify(runtimeManifest)}\n`,
  );
  const app = {
    isPackaged: true,
    getAppPath: () => appPath,
    getName: () => "TiboTattle Dev",
  };
  const environment = {
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
  };
  try {
    const context = await createWindowsElectronQualificationContext({
      app,
      environment,
      platform: "win32",
      architecture: "x64",
    });
    return await run({ root, appPath, context, environment, runtimeManifest });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function errorCode(code) {
  return (error) => {
    assert.equal(error instanceof ElectronShellError, true);
    assert.equal(error.code, `electron_shell_${code}`);
    assert.equal(error.message, "Electron shell operation failed");
    return true;
  };
}

function electronEntryCompositionFailure(error) {
  if (process.platform === "win32") {
    return error instanceof ElectronShellError
      && error.code === "electron_shell_windows_readiness_unavailable"
      && error.message === "Electron shell operation failed";
  }
  return /BrowserWindow is required/u.test(error?.message ?? "");
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }
}

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.quitCalls = 0;
    this.showCalls = 0;
    this.focusCalls = [];
    this.lockCalls = 0;
    this.readyCalls = 0;
  }

  requestSingleInstanceLock() {
    this.lockCalls += 1;
    return true;
  }

  async whenReady() {
    this.readyCalls += 1;
  }

  quit() {
    this.quitCalls += 1;
  }

  show() {
    this.showCalls += 1;
  }

  focus(options) {
    this.focusCalls.push(options);
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = { isMainFrame: true, parent: null };
    this.sent = [];
    this.session = {
      setPermissionRequestHandler: (handler) => {
        this.permissionHandler = handler;
      },
      setPermissionCheckHandler: (handler) => {
        this.permissionCheckHandler = handler;
      },
      webRequest: {
        onBeforeRequest: (filter, listener) => {
          this.requestFilter = filter;
          this.requestListener = listener;
        },
      },
    };
    this.windowOpenHandler = null;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  send(channel, command) {
    this.sent.push({ channel, command });
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.loaded = [];
  }

  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  focus() {}

  isVisible() {
    return this.visible;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }
}

function downloadSession() {
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.webRequest = {
    onBeforeRequest() {},
  };
  return session;
}

class DownloadSessionWindow extends FakeWindow {
  constructor(options) {
    super(options);
    this.webContents.session = downloadSession();
    this.webContents.getURL = () => this.loaded.at(-1) ?? "";
  }
}

class LifecycleDownloadItem extends EventEmitter {
  constructor() {
    super();
    this.url = "blob:http://127.0.0.1:4001/4a4e02e8-2cbf-4dfb-bb2a-4f6e4c0efb90";
    this.mime = "image/png";
    this.filename = "tibotattle-results-TT-012345.png";
    this.savePath = null;
    this.cancelled = false;
  }

  getURL() { return this.url; }
  getMimeType() { return this.mime; }
  getFilename() { return this.filename; }
  setSavePath(value) { this.savePath = value; }
  cancel() { this.cancelled = true; }
  finish(state) { this.emit("done", {}, state); }
}

class FakeTray extends EventEmitter {
  constructor(icon) {
    super();
    this.icon = icon;
    this.menu = null;
    this.destroyed = false;
  }

  setToolTip(value) {
    this.tooltip = value;
  }

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

function dashboardWindowsForTest(windows) {
  return windows.filter((candidate) => (
    candidate.options?.webPreferences?.preload === "/private/preload.cjs"
  ));
}

test("ready-line parser accepts only the fixed loopback contract", () => {
  assert.equal(parseCompanionReadyLine("diagnostic\n"), null);
  assert.deepEqual(
    parseCompanionReadyLine("USAGE_MONITOR_READY http://127.0.0.1:8791/\n"),
    {
      origin: "http://127.0.0.1:8791",
      url: "http://127.0.0.1:8791/",
      port: 8791,
    },
  );
  for (const line of [
    "USAGE_MONITOR_READY http://localhost:8791/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:0/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:65536/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:8791/\r\n",
    "USAGE_MONITOR_READY http://127.0.0.1:8791/ extra\n",
  ]) {
    assert.throws(() => parseCompanionReadyLine(line), errorCode("companion_ready_invalid"), line);
  }
});

test("ready-line parser is bounded and works across stdout chunks", () => {
  const observed = [];
  const parser = createCompanionReadyLineParser({ onReady: (value) => observed.push(value) });
  parser.feed(Buffer.from(`${COMPANION_READY_LINE_PREFIX}http://127.0.`));
  assert.equal(parser.ready, null);
  parser.feed(Buffer.from("0.1:3456/\nignored after ready\n"));
  assert.equal(parser.ready.origin, "http://127.0.0.1:3456");
  assert.equal(observed.length, 1);
  assert.equal(parser.finish().port, 3456);
  assert.throws(
    () => createCompanionReadyLineParser().feed(`${COMPANION_READY_LINE_PREFIX}${"x".repeat(2_000)}`),
    errorCode("companion_ready_overflow"),
  );
});

test("loopback policy allows the selected origin and denies remote navigation and permissions", () => {
  const origin = "http://127.0.0.1:3456";
  const policy = createLoopbackNavigationPolicy({ origin });
  assert.equal(isAllowedCompanionURL(`${origin}/api/local/health`, origin), true);
  assert.equal(policy.isAllowedURL(`${origin}/`), true);
  assert.equal(policy.isAllowedURL("http://127.0.0.1:3457/"), false);
  assert.equal(policy.isAllowedURL("https://127.0.0.1:3456/"), false);
  assert.equal(policy.isAllowedURL("http://127.0.0.1:3456@evil.example/"), false);
  let prevented = false;
  assert.equal(policy.handleWillNavigate({ preventDefault() { prevented = true; } }, "https://example.test/"), false);
  assert.equal(prevented, true);
  prevented = false;
  assert.equal(policy.handleWillFrameNavigate(
    { preventDefault() { prevented = true; } },
    { url: `${origin}/report`, isMainFrame: true },
  ), true);
  assert.equal(prevented, false);
  assert.equal(policy.handleWillFrameNavigate(
    { preventDefault() { prevented = true; } },
    { url: `${origin}/embedded`, isMainFrame: false },
  ), false);
  assert.equal(prevented, true);
  prevented = false;
  assert.equal(policy.handleWillAttachWebview({ preventDefault() { prevented = true; } }), false);
  assert.equal(prevented, true);
  let callbackValue = null;
  assert.equal(policy.handlePermissionRequest({ callback: (value) => { callbackValue = value; } }), false);
  assert.equal(callbackValue, false);
  assert.deepEqual(policy.handleWindowOpen(), { action: "deny" });
  assert.throws(() => createLoopbackNavigationPolicy({ origin: "http://localhost:3456" }), errorCode("invalid_loopback_origin"));
});

test("loopback policy installs exact navigation handlers and removable listeners", () => {
  const webContents = new FakeWebContents();
  const permissionCalls = [];
  const session = {
    setPermissionRequestHandler(handler) {
      this.handler = handler;
    },
    setPermissionCheckHandler(handler) {
      this.checkHandler = handler;
    },
    webRequest: {
      onBeforeRequest(filter, listener) {
        this.filter = filter;
        this.listener = listener;
      },
    },
  };
  const policy = createLoopbackNavigationPolicy({ origin: "http://127.0.0.1:3456" });
  const installed = installLoopbackNavigationPolicy({ webContents, session, policy });
  let prevented = false;
  webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://example.test/");
  assert.equal(prevented, true);
  session.handler(null, "geolocation", (value) => permissionCalls.push(value));
  assert.deepEqual(permissionCalls, [false]);
  assert.equal(session.checkHandler(), false);
  const requests = [];
  session.webRequest.listener(
    { url: "http://127.0.0.1:3456/api/local/health" },
    (decision) => requests.push(decision),
  );
  session.webRequest.listener(
    { url: "https://example.test/" },
    (decision) => requests.push(decision),
  );
  assert.deepEqual(requests, [{ cancel: false }, { cancel: true }]);
  assert.deepEqual(session.webRequest.filter, { urls: ["<all_urls>"] });
  webContents.emit("will-frame-navigate", { preventDefault() { prevented = true; } }, {
    url: "https://example.test/",
    isMainFrame: true,
  });
  assert.equal(prevented, true);
  assert.deepEqual(webContents.windowOpenHandler().action, "deny");
  installed.remove();
  assert.equal(session.webRequest.listener, null);
  prevented = false;
  webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://example.test/");
  assert.equal(prevented, false);
});

test("loopback session admits only the dashboard same-origin Blob download", () => {
  const origin = "http://127.0.0.1:3456";
  const blob = `blob:${origin}/4a4e02e8-2cbf-4dfb-bb2a-4f6e4c0efb90`;
  const session = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    webRequest: {
      onBeforeRequest(filter, listener) {
        this.filter = filter;
        this.listener = listener;
      },
    },
  };
  const dashboard = new FakeWebContents();
  dashboard.id = 41;
  const settings = new FakeWebContents();
  settings.id = 42;
  const dashboardInstall = installLoopbackNavigationPolicy({
    webContents: dashboard,
    session,
    policy: createLoopbackNavigationPolicy({ origin }),
    allowBlobDownloads: true,
  });
  const settingsInstall = installLoopbackNavigationPolicy({
    webContents: settings,
    session,
    policy: createLoopbackNavigationPolicy({ origin }),
  });
  const download = {
    url: blob,
    method: "GET",
    resourceType: "other",
    webContentsId: dashboard.id,
  };
  const decisions = [];
  const request = (details) => session.webRequest.listener(details, (value) => decisions.push(value));
  assert.equal(isAllowedCompanionBlobDownload(download, origin, dashboard.id), true);
  request(download);
  request({ ...download, webContentsId: settings.id });
  request({ ...download, url: "blob:http://127.0.0.1:3457/id" });
  request({ ...download, url: "blob:https://evil.example/id" });
  request({ ...download, resourceType: "image" });
  assert.deepEqual(decisions, [
    { cancel: false },
    { cancel: true },
    { cancel: true },
    { cancel: true },
    { cancel: true },
  ]);
  settingsInstall.remove();
  dashboardInstall.remove();
});

test("companion supervisor owns one child, injects a parent contract, and strips child output", async () => {
  const child = new FakeChild();
  const spawnCalls = [];
  const supervisor = createCompanionSupervisor({
    spawnChild(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    command: "node",
    args: ["apps/local/server.js"],
    cwd: REPOSITORY_ROOT,
    environment: {
      PRIVATE_CANARY: "must-not-escape",
      PATH: "/safe/path",
      CODEX_HOME: "/safe/codex",
      CLAUDE_CONFIG_DIR: "/safe/claude",
      USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792",
      APP_USAGEMONITOR_EXPORT_SECRET: "secret-must-not-escape",
      APP_USAGEMONITOR_ACCOUNT_HMAC_KEY: "hmac-must-not-escape",
      USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK: "1",
      USAGE_MONITOR_WINDOWS_FILESYSTEM_DEVELOPMENT: "1",
      USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
      USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID:
        "550e8400-e29b-41d4-a716-446655440000",
      ELECTRON_RUN_AS_NODE: "0",
    },
    parentPid: 4242,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
  const firstStart = supervisor.start();
  assert.equal(supervisor.start(), firstStart);
  child.stderr.emit("data", Buffer.from("secret child diagnostics"));
  child.stdout.emit("data", Buffer.from("ordinary child line\n"));
  child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4545/\n"));
  const ready = await firstStart;
  assert.equal(ready.origin, "http://127.0.0.1:4545");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.env.PRIVATE_CANARY, undefined);
  assert.equal(spawnCalls[0].options.env.PATH, "/safe/path");
  assert.equal(spawnCalls[0].options.env.CODEX_HOME, "/safe/codex");
  assert.equal(spawnCalls[0].options.env.CLAUDE_CONFIG_DIR, "/safe/claude");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_CENTRAL_ORIGIN, "http://127.0.0.1:8792");
  assert.equal(spawnCalls[0].options.env.APP_USAGEMONITOR_EXPORT_SECRET, undefined);
  assert.equal(spawnCalls[0].options.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY, undefined);
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY, undefined);
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK, undefined);
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_WINDOWS_FILESYSTEM_DEVELOPMENT, undefined);
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION,
    "windows-electron-v1",
  );
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_TEST_LANE, "windows-electron-smoke");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID, undefined);
  assert.equal(spawnCalls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_PORT, "0");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_PARENT_PID, "4242");
  assert.deepEqual(supervisor.state, {
    state: "ready",
    hasChild: true,
    origin: "http://127.0.0.1:4545",
  });
  const stopped = supervisor.stop();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("exit", 0, null);
  await stopped;
  assert.equal(supervisor.state.hasChild, false);
});

test("packaged macOS local QA withholds the production central origin", () => {
  const app = { isPackaged: true };
  const production = companionEnvironment({
    app,
    environment: { USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792" },
    qualificationContext: null,
    platform: "darwin",
  });
  assert.equal(production.USAGE_MONITOR_CENTRAL_ORIGIN, "https://tibotattle.com");

  const qaEnvironment = {
    USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792",
    USAGE_MONITOR_TEST_LANE: MACOS_ELECTRON_LOCAL_QA_TEST_LANE,
  };
  const qa = companionEnvironment({
    app,
    environment: qaEnvironment,
    qualificationContext: null,
    platform: "darwin",
  });
  assert.equal(qa.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
  assert.equal(qa.USAGE_MONITOR_TEST_LANE, MACOS_ELECTRON_LOCAL_QA_TEST_LANE);
  assert.equal(qaEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN, "http://127.0.0.1:8792");

  const nonMac = companionEnvironment({
    app,
    environment: qaEnvironment,
    qualificationContext: null,
    platform: "linux",
  });
  assert.equal(nonMac.USAGE_MONITOR_CENTRAL_ORIGIN, "https://tibotattle.com");
});

test("companion supervisor fails closed on malformed readiness and bounded startup timeout", async () => {
  const malformedChild = new FakeChild();
  const malformed = createCompanionSupervisor({
    spawnChild: () => malformedChild,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
  });
  const malformedStart = malformed.start();
  malformedChild.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY https://evil.test/\n"));
  await assert.rejects(malformedStart, errorCode("companion_ready_invalid"));
  assert.deepEqual(malformedChild.kills, ["SIGKILL"]);

  const timeoutChild = new FakeChild();
  const timeout = createCompanionSupervisor({
    spawnChild: () => timeoutChild,
    startupTimeoutMs: 10,
    shutdownTimeoutMs: 10,
  });
  await assert.rejects(timeout.start(), errorCode("companion_start_timeout"));
  assert.deepEqual(timeoutChild.kills, ["SIGKILL"]);

  const stubbornChild = new FakeChild();
  const stubborn = createCompanionSupervisor({
    spawnChild: () => stubbornChild,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
  });
  const stubbornStart = stubborn.start();
  stubbornChild.stdout.emit("data", "USAGE_MONITOR_READY http://127.0.0.1:4567/\n");
  await stubbornStart;
  await assert.rejects(stubborn.stop(), errorCode("companion_shutdown_timeout"));
  assert.deepEqual(stubbornChild.kills, ["SIGTERM", "SIGKILL"]);
});

test("platform gate leaves macOS/Linux available and refuses unqualified Windows readiness", () => {
  assert.deepEqual(assertElectronPlatformGate({ platform: "darwin", architecture: "arm64" }), {
    platform: "darwin",
    architecture: "arm64",
    windowsProductionReady: false,
  });
  assert.throws(
    () => assertElectronPlatformGate({ platform: "win32", architecture: "x64" }),
    errorCode("windows_readiness_unavailable"),
  );
});

test("Windows qualification context is branded, content-free, and accepted only for the smoke lane", async () => {
  await withWindowsQualificationFixture(async ({ context }) => {
    assert.equal(context.windowsProductionReady, false);
    assert.equal(context.windowsQualificationOnly, true);
    assert.deepEqual(
      assertElectronPlatformGate({
        platform: "win32",
        architecture: "x64",
        qualificationContext: context,
      }),
      {
        platform: "win32",
        architecture: "x64",
        windowsProductionReady: false,
        windowsQualificationOnly: true,
      },
    );
    assert.equal(
      assertWindowsElectronQualificationContext({
        context,
        platform: "win32",
        architecture: "x64",
      }),
      context,
    );
    assert.throws(
      () => assertWindowsElectronQualificationContext({
        context: { ...context },
        platform: "win32",
        architecture: "x64",
      }),
      /Windows Electron qualification is unavailable/u,
    );
    assert.throws(
      () => assertElectronPlatformGate({
        platform: "win32",
        architecture: "x64",
        qualificationContext: { ...context },
      }),
      errorCode("windows_readiness_unavailable"),
    );
  });
});

test("Windows smoke control is qualification-only Node IPC with bounded cleanup", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const source = new EventEmitter();
    const sent = [];
    let quitCalls = 0;
    const lifecycle = {
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
      invokeTrayCommand(command) {
        assert.equal(command, "show");
        this.state.windowVisible = true;
      },
      requestQuit() {
        quitCalls += 1;
      },
    };
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    const cleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        callback?.();
      },
      qualificationContext: context,
    });
    assert.equal(source.listenerCount("message"), 1);
    assert.equal(source.listenerCount("disconnect"), 1);
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "tray-show-v1",
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
      extra: "reject",
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "unknown-v1",
    });
    source.emit("message", "status-v1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(Object.isFrozen(sent[0]), true);
    assert.deepEqual(sent[0], {
      type: "windows-electron-smoke-v1",
      message: "state-v1",
      started: true,
      primary: true,
      window: true,
      visible: false,
      tray: true,
    });
    assert.deepEqual(sent[1], {
      type: "windows-electron-smoke-v1",
      message: "state-v1",
      started: true,
      primary: true,
      window: true,
      visible: true,
      tray: true,
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "quit-v1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quitCalls, 1);
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
    });
    assert.equal(sent.length, 3);
    cleanup();

    const unqualifiedSource = new EventEmitter();
    const unqualifiedSent = [];
    const unqualifiedCleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment,
      messageSource: unqualifiedSource,
      sendMessage: (message) => unqualifiedSent.push(message),
      qualificationContext: context,
    });
    assert.equal(unqualifiedSource.listenerCount("message"), 0);
    unqualifiedSource.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
    });
    assert.deepEqual(unqualifiedSent, []);
    unqualifiedCleanup();
  });
});

test("Windows smoke IPC maps every credential operation to a fixed result", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const source = new EventEmitter();
    const sent = [];
    const callbacks = [];
    const operations = [];
    const lifecycle = {
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
    };
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    const cleanup = installWindowsSmokeControlForTest(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        callbacks.push(callback);
        return false;
      },
      credentialProbe(receivedContext) {
        assert.equal(receivedContext, context);
        operations.push("probe-v1");
      },
      credentialCommand({ context: receivedContext, command, runId }) {
        assert.equal(receivedContext, context);
        assert.equal(runId, qualifiedEnvironment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID);
        operations.push(command);
      },
      qualificationContext: context,
    });
    for (const [command, operation] of [
      ["credential-probe-v1", "probe-v1"],
      ["credential-create-v1", "create-v1"],
      ["credential-read-v1", "read-v1"],
      ["credential-delete-v1", "delete-v1"],
    ]) {
      source.emit("message", {
        type: "windows-electron-smoke-v1",
        message: "command-v1",
        command,
      });
      await nextTick();
      assert.equal(typeof callbacks.at(-1), "function");
      assert.deepEqual(sent.at(-1), {
        type: "windows-electron-smoke-v1",
        message: "credential-v1",
        operation,
        status: "passed-v1",
      });
      // Simulate a sender reporting an asynchronous channel error after
      // returning false for backpressure. The control handler must consume it.
      callbacks.at(-1)(new Error("ERR_IPC_CHANNEL_CLOSED"));
    }
    assert.deepEqual(operations, ["probe-v1", "create-v1", "read-v1", "delete-v1"]);
    cleanup();
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
  });
});

test("Windows smoke IPC drops in-flight credential replies after disconnect", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const source = new EventEmitter();
    const sent = [];
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    let resolveCredential;
    let credentialStarted;
    const credentialStartedPromise = new Promise((resolve) => {
      credentialStarted = resolve;
    });
    const credentialPending = new Promise((resolve) => {
      resolveCredential = resolve;
    });
    const cleanup = installWindowsSmokeControlForTest({
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
    }, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        callback?.();
      },
      credentialProbe: async () => {},
      async credentialCommand() {
        credentialStarted();
        await credentialPending;
      },
      qualificationContext: context,
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "credential-create-v1",
    });
    await credentialStartedPromise;
    assert.equal(source.listenerCount("message"), 1);
    source.emit("disconnect");
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
    resolveCredential();
    await nextTick();
    assert.deepEqual(sent, []);
    cleanup();
  });
});

test("Windows smoke IPC fails closed without a connected sender and orders quit after ack", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    const makeLifecycle = () => ({
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
      quitCalls: 0,
      requestQuit() {
        this.quitCalls += 1;
      },
    });
    const source = new EventEmitter();
    const lifecycle = makeLifecycle();
    const sent = [];
    let quitAcknowledgement = null;
    const cleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        if (message.message === "quit-v1") quitAcknowledgement = callback;
        else callback?.(new Error("ERR_IPC_CHANNEL_CLOSED"));
        return false;
      },
      qualificationContext: context,
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "quit-v1",
    });
    await nextTick();
    assert.equal(typeof quitAcknowledgement, "function");
    assert.equal(lifecycle.quitCalls, 0);
    assert.equal(source.listenerCount("message"), 1);
    quitAcknowledgement();
    await nextTick();
    assert.equal(lifecycle.quitCalls, 1);
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
    assert.deepEqual(sent, [{
      type: "windows-electron-smoke-v1",
      message: "quit-v1",
      status: "accepted-v1",
    }]);
    cleanup();

    const disconnectedSource = new EventEmitter();
    disconnectedSource.connected = false;
    const disconnectedCleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: disconnectedSource,
      sendMessage() {
        throw new Error("must not send");
      },
      qualificationContext: context,
    });
    assert.equal(disconnectedSource.listenerCount("message"), 0);
    disconnectedCleanup();

    const missingSenderSource = new EventEmitter();
    const missingSenderCleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: missingSenderSource,
      qualificationContext: context,
    });
    assert.equal(missingSenderSource.listenerCount("message"), 0);
    missingSenderCleanup();
  });
});

test("Node child-process IPC roundtrip uses the portable ignored-stdio contract", async () => {
  const childSource = [
    "process.on('message', (message) => {",
    "  if (message !== 'ping-v1') return;",
    "  process.send?.('pong-v1', () => process.disconnect?.());",
    "});",
    "process.send?.('ready-v1');",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childSource], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const messages = [];
  let sendError = null;
  let exit;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const received = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      messages.push(message);
      if (message === "ready-v1") {
        child.send("ping-v1", (error) => {
          sendError = error ?? null;
        });
      }
      if (message === "pong-v1") resolve();
    });
    child.once("error", reject);
  });
  try {
    await withTestTimeout(received, "IPC roundtrip timeout");
    await withTestTimeout(exited, "IPC child exit timeout");
  } finally {
    if (exit === undefined) child.kill();
  }
  assert.equal(sendError, null);
  assert.deepEqual(messages, ["ready-v1", "pong-v1"]);
  assert.deepEqual(exit, { code: 0, signal: null });
});

test("Windows qualification forbids launch-path and supervisor overrides", async () => {
  await withWindowsQualificationFixture(async ({ context }) => {
    assert.doesNotThrow(() => assertElectronQualificationLaunchOptions({
      qualificationContext: context,
    }));
    for (const options of [
      { companionScript: "C:\\forged\\server.js" },
      { resourceRoot: "C:\\forged\\resources" },
      { resourcesPath: "C:\\forged\\resources" },
      { ownedDownloadsRegistry: {} },
      { notificationBackend: {} },
      { supervisorOptions: { command: "forged.exe" } },
      { lifecycleOptions: { appName: "Forged" } },
    ]) {
      assert.throws(
        () => assertElectronQualificationLaunchOptions({
          qualificationContext: context,
          ...options,
        }),
        errorCode("windows_qualification_launch_override_forbidden"),
      );
    }
  });
});

test("Windows qualification rejects a runtime/native manifest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-qualification-mismatch-"));
  const appPath = join(root, "app");
  const bindingPath = join(appPath, "native/windows-filesystem/build/Release/windows_filesystem.node");
  const bindingManifestPath = `${bindingPath}.manifest.json`;
  const keytarPath = join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node");
  const binding = Buffer.from("binding\n");
  const bindingSha256 = sha256(binding);
  const bindingManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: binding.byteLength,
    sha256: bindingSha256,
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
  })}\n`);
  const keytar = await readFile(WINDOWS_KEYTAR_PATH);
  const runtimeManifest = {
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    architecture: "x64",
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files: [
      {
        bytes: binding.byteLength,
        kind: "windows_native_binding",
        path: "native/windows-filesystem/build/Release/windows_filesystem.node",
        sha256: bindingSha256,
      },
      {
        bytes: bindingManifest.byteLength,
        kind: "windows_native_binding",
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        sha256: sha256(bindingManifest),
      },
      {
        bytes: keytar.byteLength,
        kind: "third_party_dependency",
        path: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
        sha256: sha256(keytar),
      },
    ],
    windowsBinding: {
      binding: {
        bytes: binding.byteLength,
        path: "native/windows-filesystem/build/Release/windows_filesystem.node",
        sha256: "0".repeat(64),
      },
      included: true,
      manifest: {
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      },
      status: "included_unverified",
      verified: false,
    },
  };
  await mkdir(join(appPath, "native/windows-filesystem/build/Release"), { recursive: true });
  await mkdir(join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64"), {
    recursive: true,
  });
  await writeFile(bindingPath, binding);
  await writeFile(bindingManifestPath, bindingManifest);
  await writeFile(keytarPath, keytar);
  await writeFile(join(appPath, "electron-runtime-manifest.json"), JSON.stringify(runtimeManifest));
  try {
    await assert.rejects(
      createWindowsElectronQualificationContext({
        app: {
          isPackaged: true,
          getAppPath: () => appPath,
          getName: () => "TiboTattle Dev",
        },
        environment: {
          USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
          USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        },
        platform: "win32",
        architecture: "x64",
      }),
      /Windows Electron qualification is unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows qualification cannot inject a package reader authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-reader-seam-"));
  try {
    await assert.rejects(
      createWindowsElectronQualificationContext({
        app: {
          isPackaged: true,
          getAppPath: () => root,
          getName: () => "TiboTattle Dev",
        },
        environment: {
          USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
          USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        },
        platform: "win32",
        architecture: "x64",
        readFileImpl: async () => Buffer.from("caller-controlled bytes"),
      }),
      (error) => error?.code
        === "WINDOWS_ELECTRON_QUALIFICATION_RESOURCE_AUTHORITY_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows qualification rejects a payload inventory byte mismatch", async () => {
  await withWindowsQualificationFixture(async ({ appPath, environment }) => {
    await writeFile(
      join(appPath, "apps/electron/main.js"),
      Buffer.from("tampered Electron entrypoint\n"),
    );
    await assert.rejects(
      createWindowsElectronQualificationContext({
        app: {
          isPackaged: true,
          getAppPath: () => appPath,
          getName: () => "TiboTattle Dev",
        },
        environment,
        platform: "win32",
        architecture: "x64",
      }),
      (error) => error?.code
        === "WINDOWS_ELECTRON_QUALIFICATION_RUNTIME_INVENTORY_MISMATCH",
    );
  });
});

test("qualification credential commands use a deterministic disposable tuple and confirm deletion", async () => {
  await withWindowsQualificationFixture(async ({ context }) => {
    const values = new Map();
    const binding = {
      async setPassword(service, account, secret) {
        values.set(`${service}\0${account}`, secret);
      },
      async getPassword(service, account) {
        return values.get(`${service}\0${account}`) ?? null;
      },
      async deletePassword(service, account) {
        return values.delete(`${service}\0${account}`);
      },
    };
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    assert.deepEqual(
      await runWindowsElectronQualificationCredentialCommandForTest({
        context,
        command: "create-v1",
        runId,
        binding,
      }),
      { status: "passed", command: "create-v1", cleanup: "pending" },
    );
    assert.deepEqual(
      await runWindowsElectronQualificationCredentialCommandForTest({
        context,
        command: "read-v1",
        runId,
        binding,
      }),
      { status: "passed", command: "read-v1", cleanup: "pending" },
    );
    assert.deepEqual(
      await runWindowsElectronQualificationCredentialCommandForTest({
        context,
        command: "delete-v1",
        runId,
        binding,
      }),
      { status: "passed", command: "delete-v1", cleanup: "confirmed" },
    );
    assert.equal(values.size, 0);
  });
});

test("desktop lifecycle composes secure window, tray, single instance, retry, and quit", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4000 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });
  const started = await lifecycle.start();
  assert.deepEqual(started, { status: "ready", origin: "http://127.0.0.1:4001" });
  assert.equal(app.lockCalls, 1);
  assert.equal(app.readyCalls, 1);
  assert.equal(windows.length, 2);
  const dashboard = () => windows.find((candidate) => (
    candidate.options.webPreferences.preload === "/private/preload.cjs"
  ));
  const firstDashboard = dashboard();
  assert.equal(trays.length, 1);
  assert.equal(trays[0].menu.template.some((item) => item.label === "Retry"), false);
  assert.equal(firstDashboard.options.webPreferences.nodeIntegration, false);
  assert.equal(firstDashboard.options.webPreferences.contextIsolation, true);
  assert.equal(firstDashboard.options.webPreferences.sandbox, true);
  assert.equal(firstDashboard.options.webPreferences.preload, "/private/preload.cjs");
  assert.deepEqual(firstDashboard.loaded, ["http://127.0.0.1:4001/"]);
  firstDashboard.emit("ready-to-show");
  assert.equal(firstDashboard.visible, true);
  assert.equal(lifecycle.state.windowVisible, true);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, false);
  trays[0].menu.template.find((item) => item.label === "Open TiboTattle").click();
  assert.equal(lifecycle.state.windowVisible, true);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, false);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, true);
  firstDashboard.emit("close", { preventDefault() {} });
  assert.equal(firstDashboard.visible, false);
  assert.equal(lifecycle.state.windowVisible, false);
  app.emit("second-instance");
  assert.equal(firstDashboard.visible, true);
  await lifecycle.retry();
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  assert.equal(windows.length, 4);
  const secondDashboard = dashboardWindowsForTest(windows)[1];
  assert.deepEqual(secondDashboard.loaded, ["http://127.0.0.1:4002/"]);
  await lifecycle.requestQuit();
  assert.equal(supervisor.stops, 2);
  assert.equal(app.quitCalls, 1);
});

test("desktop lifecycle opens only its current validated dashboard origin", async () => {
  const app = new FakeApp();
  const opened = [];
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${61000 + this.starts}` };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    openDashboardExternal: async (url) => {
      opened.push(url);
      return true;
    },
  });
  await lifecycle.start();
  assert.equal(await lifecycle.openDashboardInBrowser(), true);
  assert.deepEqual(opened, ["http://127.0.0.1:61001/"]);
  await lifecycle.requestQuit();
});

test("desktop lifecycle restores the macOS application before reopening a hidden dashboard", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    setUnexpectedExitHandler() {},
    async start() {
      return { origin: "http://127.0.0.1:4021" };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    platform: "darwin",
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  await lifecycle.start();
  const dashboard = dashboardWindowsForTest(windows)[0];
  dashboard.emit("ready-to-show");
  dashboard.emit("close", { preventDefault() {} });
  assert.equal(dashboard.visible, false);
  assert.equal(app.showCalls, 1, "initial ready-to-show reveals the macOS app");
  assert.deepEqual(app.focusCalls, [{ steal: true }]);

  const openItem = trays[0].menu.template.find((item) => item.label === "Open TiboTattle");
  assert.equal(typeof openItem?.click, "function");
  openItem.click();
  assert.equal(app.showCalls, 2, "tray reopen restores application-level hidden state");
  assert.deepEqual(app.focusCalls, [{ steal: true }, { steal: true }]);
  assert.equal(dashboard.visible, true);
  assert.equal(lifecycle.state.windowVisible, true);

  await lifecycle.dispose();
});

test("desktop lifecycle leaves macOS app reveal and focus APIs unused on Windows", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    setUnexpectedExitHandler() {},
    async start() {
      return { origin: "http://127.0.0.1:4022" };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    platform: "win32",
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  await lifecycle.start();
  const dashboard = dashboardWindowsForTest(windows)[0];
  dashboard.emit("ready-to-show");
  const openItem = trays[0].menu.template.find((item) => item.label === "Open TiboTattle");
  openItem.click();
  assert.equal(app.showCalls, 0);
  assert.deepEqual(app.focusCalls, []);
  assert.equal(dashboard.visible, true);
  await lifecycle.dispose();
});

test("desktop lifecycle installs one dashboard-owned download handler and removes stale origins", async () => {
  const app = new FakeApp();
  const windows = [];
  const completed = [];
  const failed = [];
  let prepared = 0;
  let revealed = 0;
  let cleared = 0;
  const ownedDownloadsRegistry = {
    prepareDownload(value) {
      assert.deepEqual(value, {
        kind: "share_card",
        mime: "image/png",
        filename: "tibotattle-results-TT-012345.png",
      });
      prepared += 1;
      return {
        id: `00000000-0000-4000-8000-${String(prepared).padStart(12, "0")}`,
        destination: `/Users/adam/Downloads/owned-${prepared}.png`,
      };
    },
    async completeDownload(id) { completed.push(id); return true; },
    async failDownload(id) { failed.push(id); return true; },
    async revealLatest() { revealed += 1; return "revealed"; },
    clear() { cleared += 1; },
  };
  const supervisor = {
    starts: 0,
    stops: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4000 + this.starts}` };
    },
    async stop() { this.stops += 1; },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends DownloadSessionWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    ownedDownloadsRegistry,
  });
  await lifecycle.start();
  const dashboard = windows.find((candidate) => candidate.loaded[0] === "http://127.0.0.1:4001/");
  const dashboardSession = dashboard.webContents.session;
  // A download may settle before the dashboard is ready to receive renderer
  // commands. The registry records it, but lifecycle delivery stays silent.
  const beforeReadyItem = new LifecycleDownloadItem();
  dashboardSession.emit("will-download", { preventDefault() {} }, beforeReadyItem, dashboard.webContents);
  assert.equal(beforeReadyItem.savePath, "/Users/adam/Downloads/owned-1.png");
  beforeReadyItem.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dashboard.webContents.sent, []);

  dashboard.emit("ready-to-show");
  const item = new LifecycleDownloadItem();
  dashboardSession.emit("will-download", { preventDefault() {} }, item, dashboard.webContents);
  assert.equal(item.savePath, "/Users/adam/Downloads/owned-2.png");
  item.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ]);
  assert.deepEqual(dashboard.webContents.sent, [{
    channel: "tibotattle:desktop-command:v1",
    command: { command: "shareCardDownloadCompleted" },
  }]);
  assert.equal(lifecycle.isAuthorizedDesktopDownloadContext(
    dashboard.webContents,
    dashboard.webContents.mainFrame,
  ), true);
  assert.equal(await lifecycle.revealLatestDownload(), "revealed");
  assert.equal(revealed, 1);

  const oldSession = dashboardSession;
  const stalePending = new LifecycleDownloadItem();
  oldSession.emit("will-download", { preventDefault() {} }, stalePending, dashboard.webContents);
  assert.equal(stalePending.savePath, "/Users/adam/Downloads/owned-3.png");
  await lifecycle.retry();
  assert.equal(oldSession.listenerCount("will-download"), 0);
  stalePending.finish("completed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dashboard.webContents.sent, [{
    channel: "tibotattle:desktop-command:v1",
    command: { command: "shareCardDownloadCompleted" },
  }]);
  const staleItem = new LifecycleDownloadItem();
  oldSession.emit("will-download", { preventDefault() {} }, staleItem, dashboard.webContents);
  assert.equal(staleItem.savePath, null);
  assert.equal(lifecycle.isAuthorizedDesktopDownloadContext(
    dashboard.webContents,
    dashboard.webContents.mainFrame,
  ), false);
  await lifecycle.requestQuit();
  assert.equal(cleared, 1);
  assert.ok(failed.length >= 0);
});

test("desktop lifecycle keeps a visible recovery window after a startup exit", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      return { origin: "http://127.0.0.1:4051" };
    },
    async stop() {
      this.stops += 1;
    },
  };
  class StartupRaceWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      // Exercise the real race: the ready-to-show event makes the window
      // visible, then the child exits before lifecycle.start() publishes
      // started=true.
      this.emit("ready-to-show");
      supervisor.exitHandler?.({ kind: "companion_exit" });
      return Promise.resolve();
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: StartupRaceWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  const started = await lifecycle.start();
  assert.deepEqual(started, {
    status: "recovery",
    origin: null,
    failure: "companion_exit_before_ready",
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].destroyed, false);
  assert.equal(windows[1].destroyed, true);
  assert.equal(lifecycle.state.started, false);
  assert.equal(lifecycle.state.hasWindow, false);
  assert.equal(supervisor.stops, 1);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(app.quitCalls, 0);
});

test("desktop lifecycle settles a never-ending startup load after an exit and keeps recovery controls responsive", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4050 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  let hangFirstDashboardLoad = true;
  class StartupHangingWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      if (url.endsWith("/") && hangFirstDashboardLoad) {
        hangFirstDashboardLoad = false;
        this.emit("ready-to-show");
        supervisor.exitHandler?.({ kind: "companion_exit" });
        return new Promise(() => {});
      }
      this.emit("ready-to-show");
      return Promise.resolve();
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: StartupHangingWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  const initial = await withTestTimeout(
    lifecycle.start(),
    "startup remained pending after an unexpected companion exit",
  );
  assert.deepEqual(initial, {
    status: "recovery",
    origin: null,
    failure: "companion_exit_before_ready",
  });
  const failedDashboard = dashboardWindowsForTest(windows)[0];
  assert.equal(failedDashboard.destroyed, true);
  assert.equal(lifecycle.state.hasWindow, false);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(
    windows.filter((candidate) => candidate.options.show === true).length,
    1,
    "startup exit must not create duplicate recovery windows",
  );

  const retried = await withTestTimeout(
    lifecycle.retry(),
    "Retry remained pending after a settled startup exit",
  );
  assert.deepEqual(retried, {
    status: "ready",
    origin: "http://127.0.0.1:4052",
  });
  await withTestTimeout(
    lifecycle.requestQuit(),
    "Quit remained pending after a settled startup exit",
  );
  assert.equal(app.quitCalls, 1);
  assert.equal(supervisor.stops, 3);
});

test("dashboard load rejection keeps startup in fixed recovery and a later Retry can succeed", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4060 + this.starts}` };
    },
    async stop() {},
  };
  let rejectDashboard = true;
  class LoadFailWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      if (url.endsWith("/") && rejectDashboard) {
        rejectDashboard = false;
        return Promise.reject(new Error("private renderer load detail"));
      }
      return Promise.resolve();
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: LoadFailWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  const initial = await lifecycle.start();
  assert.deepEqual(initial, {
    status: "recovery",
    origin: null,
    failure: "companion_spawn_failed",
  });
  assert.equal(lifecycle.state.started, false);
  assert.equal(lifecycle.state.hasWindow, false);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(windows.filter((candidate) => candidate.options.show === false).at(-1).destroyed, true);
  assert.doesNotMatch(
    decodeURIComponent(windows.find((candidate) => candidate.options.show === true).loaded.at(-1)),
    /private|renderer|load detail/u,
  );

  const retried = await lifecycle.retry();
  assert.deepEqual(retried, {
    status: "ready",
    origin: "http://127.0.0.1:4062",
  });
  assert.equal(lifecycle.state.started, true);
  assert.equal(lifecycle.state.recoveryWindowVisible, false);
  assert.equal(windows.filter((candidate) => candidate.options.show === false).length, 2);
  await lifecycle.dispose();
});

for (const failureEvent of ["did-fail-load", "render-process-gone"]) {
  test(`dashboard ${failureEvent} invalidates the old window and uses one bounded retry`, async () => {
    const app = new FakeApp();
    const windows = [];
    const supervisor = {
      starts: 0,
      setUnexpectedExitHandler() {},
      async start() {
        this.starts += 1;
        return { origin: `http://127.0.0.1:${4070 + this.starts}` };
      },
      async stop() {},
    };
    class RuntimeFailWindow extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    }
    let invalidations = 0;
    const lifecycle = createDesktopLifecycle({
      app,
      BrowserWindow: RuntimeFailWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      icon: "empty-icon",
      preloadPath: "/private/preload.cjs",
      supervisor,
      onDashboardInvalidated: () => {
        invalidations += 1;
      },
    });

    await lifecycle.start();
    const oldDashboard = dashboardWindowsForTest(windows)[0];
    oldDashboard.emit("ready-to-show");
    assert.equal(lifecycle.state.dashboardReady, true);
    if (failureEvent === "did-fail-load") {
      oldDashboard.webContents.emit(
        failureEvent,
        {},
        -2,
        "private renderer detail",
        "http://127.0.0.1:4071/",
        true,
      );
    } else {
      oldDashboard.webContents.emit(failureEvent, {}, {
        reason: "crashed",
        exitCode: 17,
        privateDetail: "/private/secret",
      });
    }
    assert.equal(oldDashboard.destroyed, true);
    assert.equal(invalidations, 1, "renderer teardown invalidates its refresh session");
    assert.equal(oldDashboard.webContents.listenerCount("did-fail-load"), 0);
    assert.equal(oldDashboard.webContents.listenerCount("render-process-gone"), 0);
    assert.equal(lifecycle.state.started, false);
    assert.equal(lifecycle.state.hasWindow, false);
    assert.equal(lifecycle.state.origin, null);
    assert.equal(lifecycle.state.recoveryWindowVisible, true);

    await withTestTimeout((async () => {
      while (supervisor.starts < 2 || !lifecycle.state.started) await nextTick();
    })(), `bounded retry did not recover after ${failureEvent}`);
    assert.equal(lifecycle.state.origin, "http://127.0.0.1:4072");
    await lifecycle.dispose();
  });
}

for (const failureMode of ["loadURL", "did-fail-load", "render-process-gone"]) {
  test(`Settings ${failureMode} destroys the failed window and permits a fresh retry`, async () => {
    const app = new FakeApp();
    const windows = [];
    const supervisor = {
      setUnexpectedExitHandler() {},
      async start() {
        return { origin: "http://127.0.0.1:4081" };
      },
      async stop() {},
    };
    let failFirstSettingsLoad = failureMode === "loadURL";
    class SettingsFailWindow extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }

      loadURL(url) {
        this.loaded.push(url);
        if (url.includes("electron-settings.html") && failFirstSettingsLoad) {
          failFirstSettingsLoad = false;
          return Promise.reject(new Error("private Settings load detail"));
        }
        return Promise.resolve();
      }
    }
    const lifecycle = createDesktopLifecycle({
      app,
      BrowserWindow: SettingsFailWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      icon: "empty-icon",
      preloadPath: "/private/preload.cjs",
      supervisor,
    });

    await lifecycle.start();
    assert.equal(lifecycle.showSettingsWindow(), true);
    const firstSettings = windows.find((candidate) => (
      candidate.loaded[0]?.includes("electron-settings.html")
    ));
    assert.notEqual(firstSettings, undefined);
    if (failureMode === "did-fail-load") {
      firstSettings.webContents.emit(
        failureMode,
        {},
        -2,
        "private Settings detail",
        "http://127.0.0.1:4081/electron-settings.html",
        true,
      );
    } else if (failureMode === "render-process-gone") {
      firstSettings.webContents.emit(failureMode, {}, {
        reason: "crashed",
        exitCode: 17,
        privateDetail: "/private/secret",
      });
    } else {
      await nextTick();
    }
    assert.equal(firstSettings.destroyed, true);
    assert.equal(lifecycle.state.hasSettingsWindow, false);
    assert.equal(lifecycle.state.started, true);
    assert.equal(firstSettings.webContents.listenerCount("did-fail-load"), 0);
    assert.equal(firstSettings.webContents.listenerCount("render-process-gone"), 0);
    assert.doesNotMatch(firstSettings.loaded.join("\n"), /private|secret|detail/u);

    assert.equal(lifecycle.showSettingsWindow(), true);
    const replacement = windows.find((candidate) => (
      candidate !== firstSettings
        && candidate.loaded[0]?.includes("electron-settings.html")
    ));
    assert.notEqual(replacement, undefined);
    replacement.emit("ready-to-show");
    assert.equal(replacement.visible, true);
    assert.equal(lifecycle.state.hasSettingsWindow, true);
    await lifecycle.dispose();
  });
}

test("desktop lifecycle invalidates a dead companion, auto-restarts once, then requires tray Retry", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4500 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });
  await lifecycle.start();
  const firstWindow = dashboardWindowsForTest(windows)[0];
  supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(firstWindow.destroyed, true);
  assert.equal(lifecycle.state.origin, null);
  // Let the queued bounded automatic restart settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  assert.equal(windows.length, 4);

  supervisor.exitHandler({ kind: "companion_exit" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(dashboardWindowsForTest(windows)[1].destroyed, true);

  const retryItem = trays[0].menu.template.find((item) => item.label === "Retry");
  const manualRetry = retryItem.click();
  await manualRetry;
  assert.equal(supervisor.starts, 3);
});

test("desktop lifecycle owns a bounded Settings window and authorizes only its top frame", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const applicationMenus = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4700 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: {
      buildFromTemplate: (template) => ({ template }),
      setApplicationMenu(menu) {
        applicationMenus.push(menu);
      },
    },
    platform: "darwin",
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  await lifecycle.start();
  assert.deepEqual(lifecycle.state, {
    started: true,
    quitting: false,
    primaryInstance: true,
    hasWindow: true,
    dashboardReady: false,
    windowVisible: false,
    hasRecoveryWindow: false,
    recoveryWindowVisible: false,
    recoveryStatus: null,
    active: true,
    hasTray: true,
    hasSettingsWindow: false,
    settingsWindowVisible: false,
    origin: "http://127.0.0.1:4701",
  });

  assert.equal(lifecycle.showSettingsWindow(), true);
  assert.equal(windows.length, 3);
  const settings = windows.find((candidate) => (
    candidate.loaded[0]?.includes("electron-settings.html")
  ));
  assert.notEqual(settings, undefined);
  assert.deepEqual(settings.loaded, [
    "http://127.0.0.1:4701/electron-settings.html#general",
  ]);
  assert.equal(settings.options.webPreferences.nodeIntegration, false);
  assert.equal(settings.options.webPreferences.contextIsolation, true);
  assert.equal(settings.options.webPreferences.sandbox, true);
  assert.equal(settings.options.webPreferences.preload, "/private/preload.cjs");
  settings.emit("ready-to-show");
  assert.equal(settings.visible, true);
  assert.equal(lifecycle.state.hasSettingsWindow, true);
  assert.equal(lifecycle.state.settingsWindowVisible, true);

  assert.equal(lifecycle.showSettingsWindow("about"), true);
  assert.equal(windows.length, 3);
  assert.deepEqual(settings.loaded, [
    "http://127.0.0.1:4701/electron-settings.html#general",
    "http://127.0.0.1:4701/electron-settings.html#about",
  ]);
  assert.equal(settings.visible, true);
  assert.throws(
    () => lifecycle.showSettingsWindow("unsupported"),
    /settings section is invalid/u,
  );
  assert.equal(windows.length, 3);

  const aboutMenuItem = applicationMenus[0].template[0].submenu.find(
    (item) => item.label === "About TiboTattle",
  );
  const settingsMenuItem = applicationMenus[0].template[0].submenu.find(
    (item) => item.label === "Settings…",
  );
  assert.equal(typeof settingsMenuItem.click, "function");
  settingsMenuItem.click();
  assert.equal(settings.loaded.at(-1), "http://127.0.0.1:4701/electron-settings.html#general");
  assert.equal(typeof aboutMenuItem.click, "function");
  aboutMenuItem.click();
  assert.equal(settings.loaded.at(-1), "http://127.0.0.1:4701/electron-settings.html#about");
  const trayAboutItem = trays[0].menu.template.find(
    (item) => item.label === "About TiboTattle",
  );
  const traySettingsItem = trays[0].menu.template.find(
    (item) => item.label === "Settings…",
  );
  assert.equal(typeof traySettingsItem.click, "function");
  traySettingsItem.click();
  assert.equal(settings.loaded.at(-1), "http://127.0.0.1:4701/electron-settings.html#general");
  assert.equal(typeof trayAboutItem.click, "function");
  trayAboutItem.click();
  assert.equal(settings.visible, true);

  assert.equal(lifecycle.setDesktopLanguage("zh-Hans"), true);
  const localizedApplicationMenu = applicationMenus.at(-1).template[0].submenu;
  assert.ok(localizedApplicationMenu.some((item) => item.label === "关于 TiboTattle"));
  assert.ok(trays[0].menu.template.some((item) => item.label === "打开 TiboTattle"));
  assert.equal(lifecycle.setDesktopLanguage("es"), true);
  assert.ok(applicationMenus.at(-1).template[0].submenu.some((item) => item.label === "Acerca de TiboTattle"));

  const dashboardCommands = [];
  const settingsCommands = [];
  dashboardWindowsForTest(windows)[0].webContents.send = (channel, command) => {
    dashboardCommands.push([channel, command]);
  };
  settings.webContents.send = (channel, command) => {
    settingsCommands.push([channel, command]);
  };
  assert.equal(lifecycle.sendDashboardCommand({ command: "language", value: "zh-Hans" }), true);
  assert.deepEqual(dashboardCommands.at(-1), [
    "tibotattle:desktop-command:v1",
    { command: "language", value: "zh-Hans" },
  ]);
  assert.deepEqual(settingsCommands.at(-1), [
    "tibotattle:desktop-command:v1",
    { command: "language", value: "zh-Hans" },
  ]);
  assert.equal(lifecycle.sendDashboardCommand({ command: "refresh" }), true);
  assert.deepEqual(dashboardCommands.at(-1), [
    "tibotattle:desktop-command:v1",
    { command: "refresh" },
  ]);
  assert.equal(settingsCommands.length, 1, "refresh must remain dashboard-only");

  let closePrevented = false;
  settings.emit("close", {
    preventDefault() {
      closePrevented = true;
    },
  });
  assert.equal(closePrevented, true);
  assert.equal(settings.visible, false);
  assert.equal(settings.destroyed, false);
  assert.equal(app.quitCalls, 0);

  const primaryContents = dashboardWindowsForTest(windows)[0].webContents;
  const settingsContents = settings.webContents;
  settingsContents.getURL = () => settings.loaded.at(-1) ?? "";
  assert.equal(lifecycle.isAuthorizedDesktopSender(primaryContents), true);
  assert.equal(lifecycle.isAuthorizedDesktopSender(settingsContents), true);
  assert.equal(lifecycle.isAuthorizedDashboardSender(primaryContents), true);
  assert.equal(lifecycle.isAuthorizedDashboardSender(settingsContents), false);
  assert.equal(lifecycle.isAuthorizedDesktopSender({}), false);
  assert.equal(
    lifecycle.isAuthorizedDesktopFrame(
      primaryContents.mainFrame,
      { sender: primaryContents },
    ),
    true,
  );
  assert.equal(
    lifecycle.isAuthorizedDesktopFrame(
      settingsContents.mainFrame,
      { sender: settingsContents },
    ),
    true,
  );
  assert.equal(
    lifecycle.isAuthorizedDashboardFrame(
      primaryContents.mainFrame,
      { sender: primaryContents },
    ),
    true,
  );
  assert.equal(
    lifecycle.isAuthorizedDashboardFrame(
      settingsContents.mainFrame,
      { sender: settingsContents },
    ),
    false,
  );
  assert.equal(
    lifecycle.isAuthorizedSettingsFrame(
      settingsContents.mainFrame,
      { sender: settingsContents },
    ),
    true,
  );
  assert.equal(
    lifecycle.isAuthorizedSettingsFrame(
      primaryContents.mainFrame,
      { sender: primaryContents },
    ),
    false,
  );
  settingsContents.getURL = () => "http://user:pass@127.0.0.1:4701/electron-settings.html#general";
  assert.equal(
    lifecycle.isAuthorizedSettingsFrame(
      settingsContents.mainFrame,
      { sender: settingsContents },
    ),
    false,
    "credentials in the live Settings URL must fail closed",
  );
  settingsContents.getURL = () => settings.loaded.at(-1) ?? "";
  assert.equal(
    lifecycle.isAuthorizedDesktopFrame(
      { isMainFrame: false, parent: primaryContents.mainFrame },
      { sender: primaryContents },
    ),
    false,
  );
  assert.equal(
    lifecycle.isAuthorizedDesktopFrame(
      primaryContents.mainFrame,
      { sender: settingsContents },
    ),
    false,
  );
  assert.equal(lifecycle.isAuthorizedDesktopFrame(primaryContents.mainFrame), false);

  // Companion failure invalidates the separate settings origin before the
  // bounded automatic restart is queued.
  lifecycle.showSettingsWindow("notifications");
  assert.equal(lifecycle.state.hasSettingsWindow, true);
  supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(settings.destroyed, true);
  assert.equal(lifecycle.state.hasSettingsWindow, false);
  assert.equal(lifecycle.isAuthorizedDesktopSender(settingsContents), false);
  await new Promise((resolve) => setImmediate(resolve));

  lifecycle.showSettingsWindow();
  const restartedSettings = windows.at(-1);
  assert.notEqual(restartedSettings, settings);
  restartedSettings.emit("ready-to-show");
  await lifecycle.retry();
  assert.equal(restartedSettings.destroyed, true);
  assert.equal(lifecycle.state.hasSettingsWindow, false);

  lifecycle.showSettingsWindow();
  const finalSettings = windows.at(-1);
  await lifecycle.requestQuit();
  assert.equal(finalSettings.destroyed, true);
  assert.equal(lifecycle.state.hasSettingsWindow, false);
  assert.equal(app.quitCalls, 1);
});

test("desktop lifecycle clears a destroyed Settings window without reading invalidated Electron properties", async () => {
  const app = new FakeApp();
  const windows = [];
  class DestroyedSettingsWindow extends FakeWindow {
    get webContents() {
      if (this.destroyed) throw new Error("Object has been destroyed");
      return this._webContents;
    }

    set webContents(value) {
      this._webContents = value;
    }
  }
  const supervisor = {
    setUnexpectedExitHandler() {},
    async start() {
      return { origin: "http://127.0.0.1:4711" };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends DestroyedSettingsWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  await lifecycle.start();
  assert.equal(lifecycle.showSettingsWindow(), true);
  const settings = windows.find((candidate) => (
    candidate.loaded[0]?.includes("electron-settings.html")
  ));
  assert.notEqual(settings, undefined);
  settings.destroyed = true;
  assert.doesNotThrow(() => settings.emit("closed"));
  assert.equal(lifecycle.state.hasSettingsWindow, false);
  await lifecycle.dispose();
});

test("closing Settings retains the dashboard's shared-session loopback filtering", async () => {
  const app = new FakeApp();
  const windows = [];
  const sharedSession = {
    setPermissionRequestHandler(handler) {
      this.permissionHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      this.permissionCheckHandler = handler;
    },
    webRequest: {
      onBeforeRequest(filter, listener) {
        this.filter = filter;
        this.listener = listener;
      },
    },
  };
  const supervisor = {
    setUnexpectedExitHandler() {},
    async start() {
      return { origin: "http://127.0.0.1:4751" };
    },
    async stop() {},
  };
  class SharedSessionWindow extends FakeWindow {
    constructor(options) {
      super(options);
      this.webContents.session = sharedSession;
      windows.push(this);
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: SharedSessionWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  await lifecycle.start();
  assert.equal(typeof sharedSession.webRequest.listener, "function");
  const beforeSettingsClose = [];
  sharedSession.webRequest.listener(
    { url: "https://example.test/" },
    (decision) => beforeSettingsClose.push(decision),
  );
  assert.deepEqual(beforeSettingsClose, [{ cancel: true }]);

  assert.equal(lifecycle.showSettingsWindow(), true);
  const settings = windows.find((candidate) => (
    candidate.loaded[0]?.includes("electron-settings.html")
  ));
  assert.notEqual(settings, undefined);
  settings.emit("closed");
  assert.equal(lifecycle.state.hasSettingsWindow, false);

  // The Settings release only drops its reference. The dashboard's
  // session-level handler must continue to reject remote requests.
  assert.equal(typeof sharedSession.webRequest.listener, "function");
  const afterSettingsClose = [];
  sharedSession.webRequest.listener(
    { url: "https://example.test/" },
    (decision) => afterSettingsClose.push(decision),
  );
  assert.deepEqual(afterSettingsClose, [{ cancel: true }]);
  const dashboardRequest = [];
  sharedSession.webRequest.listener(
    { url: "http://127.0.0.1:4751/api/local/health" },
    (decision) => dashboardRequest.push(decision),
  );
  assert.deepEqual(dashboardRequest, [{ cancel: false }]);

  await lifecycle.dispose();
  assert.equal(sharedSession.webRequest.listener, null);
});

test("desktop lifecycle cancels an in-flight retry before quit and serializes shutdown", async () => {
  const app = new FakeApp();
  let resolveStop;
  let stopCalls = 0;
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4600 + this.starts}` };
    },
    stop() {
      stopCalls += 1;
      if (stopCalls === 2) return Promise.resolve();
      return new Promise((resolve) => { resolveStop = resolve; });
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });
  await lifecycle.start();
  const retry = lifecycle.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1);
  const quit = lifecycle.requestQuit();
  resolveStop();
  await assert.rejects(retry, errorCode("companion_busy"));
  await quit;
  assert.equal(stopCalls, 2);
  assert.equal(app.quitCalls, 1);
});

test("Electron entry quits explicitly when composition fails before lifecycle ownership", async () => {
  const app = new FakeApp();
  const events = [];
  app.quit = () => {
    events.push("quit");
    app.quitCalls += 1;
  };
  const diagnostics = [];
  await assert.rejects(
    launchElectronShell({
      electron: { app },
      emitFailureDiagnostic: true,
      writeDiagnostic: (value) => {
        events.push("diagnostic");
        diagnostics.push(value);
      },
    }),
    electronEntryCompositionFailure,
  );
  assert.deepEqual(diagnostics, [`${ELECTRON_ENTRY_FAILURE_DIAGNOSTIC}\n`]);
  assert.deepEqual(events, ["diagnostic", "quit"]);
  assert.equal(app.quitCalls, 1);
});

test("Electron entry still quits when its fixed diagnostic cannot be written", async () => {
  const app = new FakeApp();
  await assert.rejects(
    launchElectronShell({
      electron: { app },
      emitFailureDiagnostic: true,
      writeDiagnostic() {
        throw new Error("synthetic diagnostic failure");
      },
    }),
    electronEntryCompositionFailure,
  );
  assert.equal(app.quitCalls, 1);
});

test("packaged Electron composition keeps the companion in app.asar and uses physical Resources as cwd", async () => {
  if (process.platform === "win32") {
    // The dependency-injected supervisor below is intentionally forbidden for
    // a Windows launch. Keep this unit active on Windows by proving that an
    // unqualified packaged composition fails closed before it can spawn a
    // companion; the native smoke supplies the real qualification context.
    const app = new FakeApp();
    app.isPackaged = true;
    await assert.rejects(
      launchElectronShell({ electron: { app } }),
      errorCode("windows_readiness_unavailable"),
    );
    assert.equal(app.quitCalls, 1);
    return;
  }
  const app = new FakeApp();
  app.isPackaged = true;
  app.getAppPath = () => "/private/TiboTattle.app/Contents/Resources/app.asar";
  app.getPath = (name) => {
    assert.equal(name, "userData");
    return "/private/TiboTattle-user-data";
  };
  const child = new FakeChild();
  const spawnCalls = [];
  const launch = launchElectronShell({
    electron: {
      app,
      dialog: {
        showMessageBox: async () => ({ response: 0 }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      BrowserWindow: FakeWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({
            isEmpty: () => false,
            setTemplateImage() {},
          }),
        }),
      },
    },
    resourcesPath: "/private/TiboTattle.app/Contents/Resources",
    environment: {
      USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792",
    },
    firstRunReceiptBackend: {
      load: async () => ({
        schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
        acknowledged: true,
      }),
      save: async () => {},
    },
    notificationBackend: {
      load: async () => null,
      save: async (value) => value,
    },
    supervisorOptions: {
      spawnChild(command, args, options) {
        spawnCalls.push({ command, args, options });
        return child;
      },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  await new Promise((resolveNext) => setImmediate(resolveNext));
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [
    "/private/TiboTattle.app/Contents/Resources/app.asar/apps/local/server.js",
    "--codex-home",
    "/Users/adamallcock/.codex",
    "--primary-codex-home",
    "/Users/adamallcock/.codex",
  ]);
  assert.equal(
    spawnCalls[0].options.cwd,
    "/private/TiboTattle.app/Contents/Resources",
  );
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_RESOURCE_ROOT,
    "/private/TiboTattle.app/Contents/Resources/app.asar",
  );
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_STATE_ROOT,
    "/private/TiboTattle-user-data/companion-state",
  );
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_CENTRAL_ORIGIN,
    "https://tibotattle.com",
  );
  child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4711/\n"));
  const lifecycle = await launch;
  const dispose = lifecycle.dispose();
  child.emit("exit", 0, null);
  await dispose;
});

test("preload exposes only the exact frozen v1 desktop bridge allowlist", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  assert.doesNotMatch(source, /\b(?:path|URL)\b/u);
  assert.doesNotMatch(source, /(?:readFile|writeFile|send\s*\()/u);
  const calls = [];
  const commandListeners = new Map();
  const exposed = {};
  const contextBridge = {
    exposeInMainWorld(name, bridge) {
      exposed[name] = bridge;
    },
  };
  const ipcRenderer = {
    invoke(channel, request) {
      calls.push({ channel, request });
      return Promise.resolve(request);
    },
    on(channel, listener) {
      commandListeners.set(channel, listener);
    },
    removeListener(channel, listener) {
      if (commandListeners.get(channel) === listener) commandListeners.delete(channel);
    },
  };
  const context = {
    Promise,
    contextBridge,
    ipcRenderer,
    require(specifier) {
      assert.equal(specifier, "electron");
      return { contextBridge, ipcRenderer };
    },
  };
  vm.runInNewContext(source, context, { filename: "preload.cjs" });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__TIBOTATTLE_PRELOAD_MARKER__)), {
    name: "tibotattle-electron-preload",
    version: "v1",
    capabilities: { filesystem: false, ipc: true },
  });
  assert.equal(Object.isFrozen(context.__TIBOTATTLE_PRELOAD_MARKER__), true);
  assert.equal(Object.isFrozen(context.__TIBOTATTLE_PRELOAD_MARKER__.capabilities), true);
  assert.deepEqual(Object.keys(exposed), ["tibotattleDesktop"]);
  const bridge = exposed.tibotattleDesktop;
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), [
    "version",
    "onCommand",
    "getSettings",
    "getCodexHomesForSettings",
    "openSettings",
    "toggleSidebar",
    "chooseCodexHome",
    "addCodexHome",
    "editCodexHome",
    "removeCodexHome",
    "setPrimaryCodexHome",
    "reorderCodexHomes",
    "useDefaultCodexHome",
    "setLanguage",
    "setAppearance",
    "setRefreshInterval",
    "setStartAtLogin",
    "setNotificationPreferences",
    "openSystemSettings",
    "openExternal",
    "openHostedSignIn",
    "checkForUpdates",
    "revealLatestDownload",
    "openDashboardInBrowser",
    "showDiagnostics",
    "revealLocalData",
    "refreshStarted",
    "refreshSettled",
  ]);
  assert.equal(bridge.version, "v1");
  const commands = [];
  const unsubscribe = bridge.onCommand((command) => commands.push(command));
  assert.equal(typeof unsubscribe, "function");
  const commandListener = commandListeners.get("tibotattle:desktop-command:v1");
  assert.equal(typeof commandListener, "function");
  commandListener({}, { command: "refresh" });
  commandListener({}, { command: "language", value: "es" });
  commandListener({}, { command: "sidebar", collapsed: true });
  commandListener({}, { command: "hostedSignInReturn" });
  commandListener({}, { command: "shareCardDownloadCompleted" });
  commandListener({}, { command: "shareCardDownloadFailed" });
  commandListener({}, {
    command: "shareCardDownloadCompleted",
    path: "/private/opaque-download.png",
  });
  commandListener({}, {
    command: "shareCardDownloadFailed",
    error: "private details",
  });
  commandListener({}, { command: "language", value: "fr" });
  commandListener({}, { command: "refresh", selector: "#private" });
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
    { command: "refresh" },
    { command: "language", value: "es" },
    { command: "sidebar", collapsed: true },
    { command: "hostedSignInReturn" },
    { command: "shareCardDownloadCompleted" },
    { command: "shareCardDownloadFailed" },
  ]);
  unsubscribe();
  assert.equal(commandListeners.size, 0);
  await bridge.getSettings();
  await bridge.getCodexHomesForSettings();
  await bridge.openSettings();
  await bridge.toggleSidebar();
  await bridge.chooseCodexHome();
  await bridge.addCodexHome();
  await bridge.editCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" });
  await bridge.removeCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" });
  await bridge.setPrimaryCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" });
  await bridge.reorderCodexHomes({
    rootIds: ["11111111-1111-4111-8111-111111111111"],
  });
  await bridge.useDefaultCodexHome();
  await bridge.setLanguage("en");
  await bridge.setAppearance("dark");
  await bridge.setRefreshInterval(300);
  await bridge.setStartAtLogin(true);
  await bridge.setNotificationPreferences({
    enabled: true,
    threshold: "ninety",
  });
  await bridge.openSystemSettings("notifications");
  await bridge.openExternal("github");
  await bridge.openHostedSignIn(
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
  );
  await bridge.checkForUpdates();
  await bridge.revealLatestDownload();
  await bridge.openDashboardInBrowser();
  await bridge.showDiagnostics();
  await bridge.revealLocalData();
  await bridge.refreshStarted();
  await bridge.refreshSettled(1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(({ channel, request }) => ({ channel, request })))), [
    { channel: "tibotattle:desktop:v1", request: { action: "getSettings", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "getCodexHomesForSettings", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "openSettings", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "toggleSidebar", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "chooseCodexHome", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "addCodexHome", args: {} } },
    {
      channel: "tibotattle:desktop:v1",
      request: {
        action: "editCodexHome",
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      },
    },
    {
      channel: "tibotattle:desktop:v1",
      request: {
        action: "removeCodexHome",
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      },
    },
    {
      channel: "tibotattle:desktop:v1",
      request: {
        action: "setPrimaryCodexHome",
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      },
    },
    {
      channel: "tibotattle:desktop:v1",
      request: {
        action: "reorderCodexHomes",
        args: { rootIds: ["11111111-1111-4111-8111-111111111111"] },
      },
    },
    { channel: "tibotattle:desktop:v1", request: { action: "useDefaultCodexHome", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "setLanguage", args: { value: "en" } } },
    { channel: "tibotattle:desktop:v1", request: { action: "setAppearance", args: { value: "dark" } } },
    { channel: "tibotattle:desktop:v1", request: { action: "setRefreshInterval", args: { seconds: 300 } } },
    { channel: "tibotattle:desktop:v1", request: { action: "setStartAtLogin", args: { enabled: true } } },
    {
      channel: "tibotattle:desktop:v1",
      request: {
        action: "setNotificationPreferences",
        args: { enabled: true, threshold: "ninety" },
      },
    },
    {
      channel: "tibotattle:desktop:v1",
      request: { action: "openSystemSettings", args: { target: "notifications" } },
    },
    {
      channel: "tibotattle:desktop:v1",
      request: { action: "openExternal", args: { target: "github" } },
    },
    {
      channel: "tibotattle:desktop:v1",
      request: {
        action: "openHostedSignIn",
        args: {
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
        },
      },
    },
    { channel: "tibotattle:desktop:v1", request: { action: "checkForUpdates", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "revealLatestDownload", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "openDashboardInBrowser", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "showDiagnostics", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "revealLocalData", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "refreshStarted", args: {} } },
    { channel: "tibotattle:desktop:v1", request: { action: "refreshSettled", args: { lease: 1 } } },
  ]);
  await assert.rejects(
    bridge.setNotificationPreferences({ enabled: true, threshold: "ninety", extra: true }),
    (error) => error?.name === "TypeError",
  );
  for (const operation of [
    () => bridge.onCommand(() => {}, "extra"),
    () => bridge.setLanguage("en", "extra"),
    () => bridge.toggleSidebar("extra"),
    () => bridge.getCodexHomesForSettings("extra"),
    () => bridge.addCodexHome("extra"),
    () => bridge.editCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }, "extra"),
    () => bridge.removeCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }, "extra"),
    () => bridge.setPrimaryCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }, "extra"),
    () => bridge.reorderCodexHomes({ rootIds: ["11111111-1111-4111-8111-111111111111"] }, "extra"),
    () => bridge.setAppearance("dark", "extra"),
    () => bridge.setRefreshInterval(300, "extra"),
    () => bridge.setStartAtLogin(true, "extra"),
    () => bridge.setNotificationPreferences(
      { enabled: true, threshold: "ninety" },
      "extra",
    ),
    () => bridge.openSystemSettings("startup", "extra"),
    () => bridge.openExternal("github", "extra"),
    () => bridge.openHostedSignIn(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
      "extra",
    ),
    () => bridge.revealLatestDownload("extra"),
    () => bridge.openDashboardInBrowser("extra"),
    () => bridge.showDiagnostics("extra"),
    () => bridge.revealLocalData("extra"),
    () => bridge.refreshStarted("extra"),
    () => bridge.refreshSettled("extra"),
    () => bridge.refreshSettled(0),
  ]) {
    await assert.rejects(operation(), (error) => error?.name === "TypeError");
  }
  const validRootId = "11111111-1111-4111-8111-111111111111";
  for (const operation of [
    () => bridge.editCodexHome({ rootId: "not-a-uuid" }),
    () => bridge.editCodexHome({ rootId: validRootId, extra: true }),
    () => bridge.removeCodexHome({ rootId: "not-a-uuid" }),
    () => bridge.setPrimaryCodexHome({ rootId: "11111111-1111-5111-8111-111111111111" }),
    () => bridge.reorderCodexHomes({ rootIds: [] }),
    () => bridge.reorderCodexHomes({ rootIds: [validRootId, validRootId] }),
    () => bridge.reorderCodexHomes({
      rootIds: Array.from({ length: 9 }, () => validRootId),
    }),
    () => bridge.reorderCodexHomes({ rootIds: ["not-a-uuid"] }),
  ]) {
    await assert.rejects(operation(), (error) => error?.name === "TypeError");
  }
  await assert.rejects(
    bridge.openHostedSignIn("https://accounts.google.com.evil/?client_id=test"),
    (error) => error?.name === "TypeError",
  );
});

test("preload exposes platform-qualified one-shot startup gates and rejects hostile calls", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  function runPreload({
    platform,
    control,
    qualificationMarker,
    testLane,
    lexicalProcess = false,
  } = {}) {
    const exposed = {};
    const calls = [];
    const contextBridge = {
      exposeInMainWorld(name, bridge) {
        exposed[name] = bridge;
      },
    };
    const ipcRenderer = {
      invoke(channel, request) {
        calls.push({ channel, request });
        return Promise.resolve(request);
      },
      on() {},
      removeListener() {},
    };
    const context = {
      Promise,
      contextBridge,
      ipcRenderer,
      require(specifier) {
        assert.equal(specifier, "electron");
        return { contextBridge, ipcRenderer };
      },
    };
    const processValue = {
      platform,
      env: {
        USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: control,
        USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: qualificationMarker,
        USAGE_MONITOR_TEST_LANE: testLane,
      },
    };
    if (lexicalProcess) {
      context.lexicalProcess = processValue;
      vm.runInNewContext(`const process = lexicalProcess;\n${source}`, context, {
        filename: "preload.cjs",
      });
    } else {
      context.process = processValue;
      vm.runInNewContext(source, context, { filename: "preload.cjs" });
    }
    return { exposed, calls };
  }

  async function assertSmokeGate(smoke, name) {
    const gate = smoke.exposed[name];
    assert.equal(Object.isFrozen(gate), true);
    assert.deepEqual(Object.keys(gate), [
      "version",
      "waitForStartupRefresh",
      "releaseStartupRefresh",
    ]);
    assert.equal(gate.version, "v1");
    const pending = gate.waitForStartupRefresh();
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(gate.releaseStartupRefresh(), true);
    await pending;
    assert.equal(gate.releaseStartupRefresh(), false);
    assert.throws(
      () => gate.waitForStartupRefresh("unexpected"),
      (error) => error?.name === "TypeError",
    );
    assert.throws(
      () => gate.releaseStartupRefresh("unexpected"),
      (error) => error?.name === "TypeError",
    );
    assert.deepEqual(smoke.calls, [], "the gate carries no IPC or private data");
  }

  const macSmoke = runPreload({
    platform: "darwin",
    control: "quit-v1",
    lexicalProcess: true,
  });
  assert.deepEqual(Object.keys(macSmoke.exposed), [
    "__TIBOTATTLE_ELECTRON_MACOS_SMOKE__",
    "tibotattleDesktop",
  ]);
  await assertSmokeGate(macSmoke, "__TIBOTATTLE_ELECTRON_MACOS_SMOKE__");

  const windowsSmoke = runPreload({
    platform: "win32",
    control: "windows-v1",
    qualificationMarker: "windows-electron-v1",
    testLane: "windows-electron-smoke",
    lexicalProcess: true,
  });
  assert.deepEqual(Object.keys(windowsSmoke.exposed), [
    "__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__",
    "tibotattleDesktop",
  ]);
  await assertSmokeGate(windowsSmoke, "__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__");

  for (const options of [
    { platform: "linux", control: "quit-v1" },
    { platform: "linux", control: "windows-v1" },
    { platform: "win32", control: "quit-v1" },
    { platform: "win32", control: "windows-v1" },
    { platform: "win32", control: undefined },
    {
      platform: "win32",
      control: "windows-v1",
      qualificationMarker: "wrong-marker",
      testLane: "windows-electron-smoke",
    },
    {
      platform: "win32",
      control: "windows-v1",
      qualificationMarker: "windows-electron-v1",
      testLane: "wrong-lane",
    },
    {
      platform: "win32",
      control: "windows-v1",
      qualificationMarker: "windows-electron-v1",
    },
    {
      platform: "win32",
      control: "windows-v1",
      testLane: "windows-electron-smoke",
    },
    { platform: "darwin", control: "other" },
    { platform: "darwin", control: "windows-v1" },
    { platform: "darwin", control: undefined },
  ]) {
    const unqualified = runPreload({ ...options, lexicalProcess: true });
    assert.equal(
      Object.hasOwn(unqualified.exposed, "__TIBOTATTLE_ELECTRON_MACOS_SMOKE__"),
      false,
      JSON.stringify(options),
    );
    assert.equal(
      Object.hasOwn(unqualified.exposed, "__TIBOTATTLE_ELECTRON_WINDOWS_SMOKE__"),
      false,
      JSON.stringify(options),
    );
  }
});

test("preload marks both document roots as electron-dashboard across DOM readiness", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  function classList() {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      contains(value) { return values.has(value); },
    };
  }
  const documentElement = { classList: classList() };
  const document = {
    documentElement,
    body: null,
    addEventListener(name, callback) {
      assert.equal(name, "DOMContentLoaded");
      this.domReady = callback;
    },
  };
  vm.runInNewContext(
    source,
    {
      document,
      require(specifier) {
        assert.equal(specifier, "electron");
        return { contextBridge: undefined, ipcRenderer: undefined };
      },
    },
    { filename: "preload.cjs" },
  );
  assert.equal(documentElement.classList.contains("electron-dashboard"), true);
  assert.equal(documentElement.classList.contains("native-dashboard"), false);
  assert.equal(document.body, null);
  document.body = { classList: classList() };
  document.domReady();
  assert.equal(documentElement.classList.contains("electron-dashboard"), true);
  assert.equal(document.body.classList.contains("electron-dashboard"), true);
  assert.equal(documentElement.classList.contains("native-dashboard"), false);
  assert.equal(document.body.classList.contains("native-dashboard"), false);
});
