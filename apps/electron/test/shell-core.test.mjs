import assert from "node:assert/strict";
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
  assertElectronQualificationLaunchOptions,
  launchElectronShell,
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
  isAllowedCompanionURL,
} from "../loopback-policy.js";
import {
  COMPANION_READY_LINE_PREFIX,
  createCompanionReadyLineParser,
  parseCompanionReadyLine,
} from "../ready-line.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const WINDOWS_KEYTAR_PATH = require.resolve(
  "@github/keytar/prebuilds/win32-x64/keytar.node",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  const runtimeSourcePaths = [
    "apps/electron/companion-supervisor.js",
    "apps/electron/desktop-lifecycle.js",
    "apps/electron/errors.js",
    "apps/electron/loopback-policy.js",
    "apps/electron/main.js",
    "apps/electron/platform-gate.js",
    "apps/electron/preload.js",
    "apps/electron/ready-line.js",
    "apps/electron/windows-qualification.js",
    "apps/local/server.js",
    "apps/web/public/index.html",
  ];
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
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
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

test("Windows qualification forbids launch-path and supervisor overrides", async () => {
  await withWindowsQualificationFixture(async ({ context }) => {
    assert.doesNotThrow(() => assertElectronQualificationLaunchOptions({
      qualificationContext: context,
    }));
    for (const options of [
      { companionScript: "C:\\forged\\server.js" },
      { resourceRoot: "C:\\forged\\resources" },
      { resourcesPath: "C:\\forged\\resources" },
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
    preloadPath: "/private/preload.js",
    supervisor,
  });
  const started = await lifecycle.start();
  assert.deepEqual(started, { status: "ready", origin: "http://127.0.0.1:4001" });
  assert.equal(app.lockCalls, 1);
  assert.equal(app.readyCalls, 1);
  assert.equal(windows.length, 1);
  assert.equal(trays.length, 1);
  assert.equal(trays[0].menu.template.some((item) => item.label === "Retry"), true);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.equal(windows[0].options.webPreferences.preload, "/private/preload.js");
  assert.deepEqual(windows[0].loaded, ["http://127.0.0.1:4001/"]);
  windows[0].emit("ready-to-show");
  assert.equal(windows[0].visible, true);
  assert.equal(lifecycle.state.windowVisible, true);
  trays[0].menu.template.find((item) => item.label === "Hide TiboTattle").click();
  assert.equal(lifecycle.state.windowVisible, false);
  trays[0].menu.template.find((item) => item.label === "Show TiboTattle").click();
  assert.equal(lifecycle.state.windowVisible, true);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, false);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, true);
  windows[0].emit("close", { preventDefault() {} });
  assert.equal(windows[0].visible, false);
  assert.equal(lifecycle.state.windowVisible, false);
  app.emit("second-instance");
  assert.equal(windows[0].visible, true);
  await lifecycle.retry();
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[1].loaded, ["http://127.0.0.1:4002/"]);
  await lifecycle.requestQuit();
  assert.equal(supervisor.stops, 2);
  assert.equal(app.quitCalls, 1);
});

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
    preloadPath: "/private/preload.js",
    supervisor,
  });
  await lifecycle.start();
  const firstWindow = windows[0];
  supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(firstWindow.destroyed, true);
  assert.equal(lifecycle.state.origin, null);
  // Let the queued bounded automatic restart settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  assert.equal(windows.length, 2);

  supervisor.exitHandler({ kind: "companion_exit" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(windows[1].destroyed, true);

  const retryItem = trays[0].menu.template.find((item) => item.label === "Retry");
  const manualRetry = retryItem.click();
  await manualRetry;
  assert.equal(supervisor.starts, 3);
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
    preloadPath: "/private/preload.js",
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
      BrowserWindow: FakeWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      nativeImage: { createEmpty: () => "empty-icon" },
    },
    resourcesPath: "/private/TiboTattle.app/Contents/Resources",
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
  child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4711/\n"));
  const lifecycle = await launch;
  const dispose = lifecycle.dispose();
  child.emit("exit", 0, null);
  await dispose;
});

test("preload is only a frozen marker and does not import filesystem or IPC APIs", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.js"), "utf8");
  assert.doesNotMatch(source, /(?:fs|ipcRenderer|contextBridge|readFile|writeFile)/u);
  const context = {};
  vm.runInNewContext(source, context, { filename: "preload.js" });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__TIBOTATTLE_PRELOAD_MARKER__)), {
    name: "tibotattle-electron-preload",
    version: "v1",
    capabilities: { filesystem: false, ipc: false },
  });
  assert.equal(Object.isFrozen(context.__TIBOTATTLE_PRELOAD_MARKER__), true);
  assert.equal(Object.isFrozen(context.__TIBOTATTLE_PRELOAD_MARKER__.capabilities), true);
});

test("preload marks both document roots as native-dashboard across DOM readiness", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.js"), "utf8");
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
  vm.runInNewContext(source, { document }, { filename: "preload.js" });
  assert.equal(documentElement.classList.contains("native-dashboard"), true);
  assert.equal(document.body, null);
  document.body = { classList: classList() };
  document.domReady();
  assert.equal(documentElement.classList.contains("native-dashboard"), true);
  assert.equal(document.body.classList.contains("native-dashboard"), true);
});
