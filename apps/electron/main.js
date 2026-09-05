import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEPLOYMENT_ENDPOINTS } from "../../config/deployment-endpoints.js";
import { launchDesktopRuntime } from "./desktop-runtime.js";
import { resolveDesktopTrayIcon } from "./desktop-tray.js";
import { ELECTRON_ENTRY_FAILURE_DIAGNOSTIC, shellError } from "./errors.js";
import { assertElectronPlatformGate } from "./platform-gate.js";
import {
  createWindowsElectronQualificationContext,
  WINDOWS_ELECTRON_QUALIFICATION_MARKER,
  WINDOWS_ELECTRON_TEST_LANE,
  runWindowsElectronQualificationCredentialCommand,
  runWindowsElectronQualificationCredentialProbe,
  assertWindowsElectronQualificationContext,
} from "./windows-qualification.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPANION_SCRIPT = resolve(MODULE_DIRECTORY, "../local/server.js");
const DEFAULT_RESOURCE_ROOT = resolve(MODULE_DIRECTORY, "../..");
const ELECTRON_SMOKE_CONTROL = "quit-v1";
export const MACOS_ELECTRON_LOCAL_QA_TEST_LANE =
  "macos-electron-local-qa-v1";
const MACOS_ELECTRON_SMOKE_OBSERVE_MESSAGE_TYPE =
  "tibotattle-macos-smoke-observe-v1";
const MACOS_ELECTRON_SMOKE_STATE_MESSAGE_TYPE =
  "tibotattle-macos-smoke-state-v1";
const WINDOWS_ELECTRON_SMOKE_CONTROL = "windows-v1";
const WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE = "windows-electron-smoke-v1";
const WINDOWS_ELECTRON_SMOKE_COMMAND_MESSAGE = "command-v1";
const WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE = "state-v1";
const WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE = "credential-v1";
const WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE = "quit-v1";
const WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS = "accepted-v1";
const WINDOWS_ELECTRON_SMOKE_PASSED_STATUS = "passed-v1";
const WINDOWS_ELECTRON_SMOKE_FAILED_STATUS = "failed-v1";
const WINDOWS_ELECTRON_SMOKE_COMMANDS = new Set([
  "status-v1",
  "tray-show-v1",
  "tray-hide-v1",
  "tray-toggle-v1",
  "credential-probe-v1",
  "credential-create-v1",
  "credential-read-v1",
  "credential-delete-v1",
  "quit-v1",
]);
const WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS = Object.freeze({
  "credential-probe-v1": "probe-v1",
  "credential-create-v1": "create-v1",
  "credential-read-v1": "read-v1",
  "credential-delete-v1": "delete-v1",
});

function isPackagedElectronApp(app) {
  return app?.isPackaged === true;
}

function packagedAppPath(app) {
  const value = app?.getAppPath?.();
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

function packagedResourcesPath(app, appPath, resourcesPath) {
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    return resolve(resourcesPath);
  }
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    return resolve(process.resourcesPath);
  }
  return appPath === null ? null : dirname(appPath);
}

export function companionEnvironment({
  app,
  environment,
  qualificationContext,
  platform = process.platform,
}) {
  if (!isPackagedElectronApp(app)
      || qualificationContext !== null) {
    return environment;
  }
  if (platform === "darwin"
      && environment.USAGE_MONITOR_TEST_LANE
        === MACOS_ELECTRON_LOCAL_QA_TEST_LANE) {
    const selected = { ...environment };
    delete selected.USAGE_MONITOR_CENTRAL_ORIGIN;
    return selected;
  }
  return {
    ...environment,
    USAGE_MONITOR_CENTRAL_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin,
  };
}

function resolveCompanionLaunchPaths({
  app,
  companionScript,
  resourceRoot,
  resourcesPath,
} = {}) {
  const packaged = isPackagedElectronApp(app);
  const appPath = packaged ? packagedAppPath(app) : null;
  const selectedResourceRoot = resourceRoot
    ?? appPath
    ?? DEFAULT_RESOURCE_ROOT;
  const selectedCompanionScript = companionScript
    ?? (appPath === null
      ? DEFAULT_COMPANION_SCRIPT
      : resolve(appPath, "apps/local/server.js"));
  const selectedCwd = packaged
    ? packagedResourcesPath(app, appPath, resourcesPath) ?? selectedResourceRoot
    : selectedResourceRoot;
  return Object.freeze({
    companionScript: selectedCompanionScript,
    companionCwd: selectedCwd,
    resourceRoot: selectedResourceRoot,
  });
}

function emitEntryFailureDiagnostic(writeDiagnostic = process.stderr?.write?.bind(process.stderr)) {
  if (typeof writeDiagnostic === "function") {
    try {
      writeDiagnostic(`${ELECTRON_ENTRY_FAILURE_DIAGNOSTIC}\n`);
    } catch {
      // Diagnostic delivery must never prevent fail-closed shutdown.
    }
  }
}

export function assertElectronQualificationLaunchOptions({
  qualificationContext,
  companionScript,
  resourceRoot,
  resourcesPath,
  supervisorOptions = {},
  lifecycleOptions = {},
  firstRunReceiptBackend,
  ownedDownloadsRegistry,
  notificationBackend,
} = {}) {
  if (qualificationContext === null) return;
  assertWindowsElectronQualificationContext({
    context: qualificationContext,
    platform: "win32",
    architecture: "x64",
  });
  if (companionScript !== undefined
      || resourceRoot !== undefined
      || resourcesPath !== undefined
      || firstRunReceiptBackend !== undefined
      || ownedDownloadsRegistry !== undefined
      || notificationBackend !== undefined
      || supervisorOptions === null
      || typeof supervisorOptions !== "object"
      || Array.isArray(supervisorOptions)
      || Object.keys(supervisorOptions).length !== 0
      || lifecycleOptions === null
      || typeof lifecycleOptions !== "object"
      || Array.isArray(lifecycleOptions)
      || Object.keys(lifecycleOptions).length !== 0) {
    throw shellError("windows_qualification_launch_override_forbidden");
  }
}

function windowsSmokeStateMessage(lifecycle) {
  const state = lifecycle?.state ?? {};
  return Object.freeze({
    type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
    message: WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE,
    started: state.started === true,
    primary: state.primaryInstance === true,
    window: state.hasWindow === true,
    visible: state.windowVisible === true,
    tray: state.hasTray === true,
  });
}

function windowsSmokeCredentialMessage(operation, status) {
  return Object.freeze({
    type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
    message: WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE,
    operation,
    status,
  });
}

/**
 * Observe only native BrowserWindow visibility for the exact local macOS
 * smoke lane. This parent-process IPC seam intentionally accepts a single
 * fixed request and emits two lifecycle-derived booleans. It is never exposed
 * to a renderer, preload bridge, loopback route, or production environment.
 */
export function installMacosSmokeObservation(lifecycle, {
  environment = process.env,
  messageSource = process,
  sendMessage = null,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL !== ELECTRON_SMOKE_CONTROL
      || environment.USAGE_MONITOR_TEST_LANE !== MACOS_ELECTRON_LOCAL_QA_TEST_LANE
      || typeof messageSource?.on !== "function"
      || messageSource?.connected !== true
      || typeof messageSource?.send !== "function") {
    return () => {};
  }
  const sendControlMessage = sendMessage ?? messageSource.send;
  if (typeof sendControlMessage !== "function") return () => {};
  let active = true;
  const sendState = () => {
    if (!active) return;
    const state = lifecycle?.state ?? {};
    const message = Object.freeze({
      type: MACOS_ELECTRON_SMOKE_STATE_MESSAGE_TYPE,
      windowVisible: state.windowVisible === true,
      settingsWindowVisible: state.settingsWindowVisible === true,
    });
    try {
      sendControlMessage.call(messageSource, message, () => {});
    } catch {
      // A closed smoke parent channel must never change normal app behavior.
    }
  };
  const onMessage = (message) => {
    if (!active
        || message === null
        || typeof message !== "object"
        || Array.isArray(message)
        || Reflect.ownKeys(message).length !== 1
        || message.type !== MACOS_ELECTRON_SMOKE_OBSERVE_MESSAGE_TYPE) {
      return;
    }
    sendState();
  };
  const onDisconnect = () => cleanup();
  const cleanup = () => {
    if (!active) return;
    active = false;
    messageSource.off?.("message", onMessage);
    messageSource.off?.("disconnect", onDisconnect);
  };
  messageSource.on("message", onMessage);
  messageSource.on("disconnect", onDisconnect);
  return cleanup;
}

/**
 * Install the packaged Windows smoke control only for the exact opt-in test
 * environment. It uses the Node child-process IPC channel because a packaged
 * Windows GUI Electron process has no usable stdin/stdout stream. This is not
 * renderer IPC, a loopback endpoint, or a production readiness override.
 * Unknown or malformed messages are ignored and every response is fixed and
 * content-free.
 */
function installWindowsSmokeControlWithRunners(lifecycle, {
  environment = process.env,
  messageSource = process,
  sendMessage = null,
  platform = process.platform,
  qualificationContext = null,
} = {}, {
  credentialProbe,
  credentialCommand,
} = {}) {
  if (platform !== "win32"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL
        !== WINDOWS_ELECTRON_SMOKE_CONTROL
      || environment.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION
        !== WINDOWS_ELECTRON_QUALIFICATION_MARKER
      || environment.USAGE_MONITOR_TEST_LANE !== WINDOWS_ELECTRON_TEST_LANE
      || lifecycle?.state?.primaryInstance !== true
      || !qualificationContext
      || typeof messageSource?.on !== "function"
      || messageSource?.connected === false) {
    return () => {};
  }
  const sendControlMessage = sendMessage ?? messageSource.send;
  if (typeof sendControlMessage !== "function") return () => {};
  try {
    assertWindowsElectronQualificationContext({
      context: qualificationContext,
      platform: "win32",
      architecture: "x64",
    });
  } catch {
    return () => {};
  }
  let active = true;
  let credentialOperation = Promise.resolve();
  const send = (value, acknowledged = null) => {
    let callbackCalled = false;
    const callback = (error) => {
      if (callbackCalled) return;
      callbackCalled = true;
      // Node supplies asynchronous IPC errors here. Consume the value so a
      // closed qualification child channel cannot create an unhandled error.
      void error;
      if (typeof acknowledged === "function") {
        try {
          acknowledged();
        } catch {
          // The test-only channel must never change normal shell shutdown.
        }
      }
    };
    try {
      sendControlMessage.call(
        messageSource,
        value,
        callback,
      );
    } catch {
      // The smoke harness owns process lifetime; a closed IPC channel must
      // never change the shell's normal shutdown policy.
      callback();
    }
  };
  let cleanup = () => {};
  const handleCommand = (message) => {
    if (!active
        || message === null
        || typeof message !== "object"
        || Array.isArray(message)
        || Object.keys(message).length !== 3
        || message.type !== WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE
        || message.message !== WINDOWS_ELECTRON_SMOKE_COMMAND_MESSAGE
        || !WINDOWS_ELECTRON_SMOKE_COMMANDS.has(message.command)) {
      return;
    }
    const command = message.command;
    if (command === "status-v1") {
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "tray-show-v1") {
      lifecycle.invokeTrayCommand?.("show");
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "tray-hide-v1") {
      lifecycle.invokeTrayCommand?.("hide");
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "tray-toggle-v1") {
      lifecycle.invokeTrayCommand?.("toggle");
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "credential-probe-v1") {
      credentialOperation = credentialOperation.then(async () => {
        if (!active) return;
        try {
          await credentialProbe(qualificationContext);
          if (!active) return;
          send(windowsSmokeCredentialMessage(
            WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[command],
            WINDOWS_ELECTRON_SMOKE_PASSED_STATUS,
          ));
        } catch {
          if (!active) return;
          send(windowsSmokeCredentialMessage(
            WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[command],
            WINDOWS_ELECTRON_SMOKE_FAILED_STATUS,
          ));
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    if (command.startsWith("credential-") && command.endsWith("-v1")) {
      const operation = WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[command];
      credentialOperation = credentialOperation.then(async () => {
        if (!active) return;
        try {
          await credentialCommand({
            context: qualificationContext,
            command: operation,
            runId: environment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID,
          });
          if (!active) return;
          send(windowsSmokeCredentialMessage(operation, WINDOWS_ELECTRON_SMOKE_PASSED_STATUS));
        } catch {
          if (!active) return;
          send(windowsSmokeCredentialMessage(operation, WINDOWS_ELECTRON_SMOKE_FAILED_STATUS));
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    // Quit is acknowledged before the window/tray and child are torn down so
    // the harness can distinguish a requested clean quit from a forced kill.
    send(Object.freeze({
      type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
      message: WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE,
      status: WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS,
    }), () => {
      cleanup();
      void Promise.resolve(lifecycle.requestQuit?.()).catch(() => {
        process.exitCode = 1;
      });
    });
  };
  const onMessage = (message) => handleCommand(message);
  const onDisconnect = () => cleanup();
  cleanup = () => {
    if (!active) return;
    active = false;
    messageSource.off?.("message", onMessage);
    messageSource.off?.("disconnect", onDisconnect);
  };
  messageSource.on("message", onMessage);
  messageSource.on("disconnect", onDisconnect);
  return cleanup;
}

export function installWindowsSmokeControl(lifecycle, options = {}) {
  return installWindowsSmokeControlWithRunners(lifecycle, options, {
    credentialProbe: runWindowsElectronQualificationCredentialProbe,
    credentialCommand: runWindowsElectronQualificationCredentialCommand,
  });
}

/** Dependency-injected seam for plain-Node IPC contract tests only. */
export function installWindowsSmokeControlForTest(lifecycle, {
  credentialProbe,
  credentialCommand,
  ...options
} = {}) {
  if (typeof credentialProbe !== "function"
      || typeof credentialCommand !== "function") {
    return () => {};
  }
  return installWindowsSmokeControlWithRunners(lifecycle, options, {
    credentialProbe,
    credentialCommand,
  });
}

/**
 * Compose the real Electron runtime. The function is intentionally separate
 * from module evaluation so all policy/lifecycle code remains plain-Node
 * testable when Electron is not installed in the source checkout.
 */
export async function launchElectronShell({
  electron,
  companionScript,
  resourceRoot,
  resourcesPath,
  environment = process.env,
  supervisorOptions = {},
  lifecycleOptions = {},
  firstRunReceiptBackend,
  ownedDownloadsRegistry,
  notificationBackend,
  emitFailureDiagnostic = false,
  writeDiagnostic,
} = {}) {
  const runtime = electron ?? await import("electron");
  const app = runtime?.app;
  if (!app || typeof app.on !== "function") {
    throw new TypeError("Electron app runtime is unavailable");
  }
  try {
    const qualificationContext = await createWindowsElectronQualificationContext({
      app,
      environment,
    });
    assertElectronQualificationLaunchOptions({
      qualificationContext,
      companionScript,
      resourceRoot,
      resourcesPath,
      supervisorOptions,
      lifecycleOptions,
      firstRunReceiptBackend,
      ownedDownloadsRegistry,
      notificationBackend,
    });
    const paths = resolveCompanionLaunchPaths({
      app,
      companionScript,
      resourceRoot,
      resourcesPath,
    });
    assertElectronPlatformGate({
      platform: process.platform,
      architecture: process.arch,
      qualificationContext,
    });
    const desktop = await launchDesktopRuntime({
      runtime: {
        ...runtime,
        icon: resolveDesktopTrayIcon({
          nativeImage: runtime.nativeImage,
          resourceRoot: paths.resourceRoot,
          platform: process.platform,
        }),
      },
      app,
      paths: {
        ...paths,
        preloadPath: resolve(MODULE_DIRECTORY, "preload.cjs"),
      },
      environment: {
        ...companionEnvironment({ app, environment, qualificationContext }),
        USAGE_MONITOR_RESOURCE_ROOT: paths.resourceRoot,
      },
      supervisorOptions,
      lifecycleOptions: {
        appName: isPackagedElectronApp(app) ? "TiboTattle Dev" : "TiboTattle",
        ...lifecycleOptions,
      },
      firstRunReceiptBackend,
      ownedDownloadsRegistry,
      notificationBackend,
      qualificationContext,
      platform: process.platform,
      architecture: process.arch,
    });
    installWindowsSmokeControl(desktop.lifecycle, {
      environment,
      qualificationContext,
    });
    return desktop.lifecycle;
  } catch (error) {
    // This includes platform-gate and dependency/configuration failures that
    // occur before the lifecycle owns a shutdown path.
    if (emitFailureDiagnostic) emitEntryFailureDiagnostic(writeDiagnostic);
    app.quit?.();
    throw error;
  }
}

// Node-based tests and repository tooling import this entry without executing
// a desktop launch. An actual Electron process is the only executable caller.
if (process.versions.electron) {
  launchElectronShell({ emitFailureDiagnostic: true })
    .then((lifecycle) => {
      if (lifecycle !== null) installMacosSmokeObservation(lifecycle);
      // The Linux GUI smoke needs a deterministic way to exercise the same
      // main-process shutdown path as the tray's Quit action. Keep that
      // control test-only, opt-in, and out of the renderer/preload boundary.
      // SIGUSR2 is not installed on Windows, so this cannot become a Windows
      // production contract by accident.
      if (lifecycle !== null
          && process.platform !== "win32"
          && process.env.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL === ELECTRON_SMOKE_CONTROL) {
        // This signal is installed only for the explicit local smoke lane. It
        // asks the lifecycle to open the validated loopback popup route, so
        // the harness can inspect the real tray renderer without accepting a
        // renderer-controlled URL or exposing a production command.
        process.once("SIGUSR1", () => {
          lifecycle.showTrayPopover?.();
        });
        process.once("SIGUSR2", () => {
          void lifecycle.requestQuit().catch(() => {
            process.exitCode = 1;
          });
        });
      }
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
