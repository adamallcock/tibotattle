import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import { createDesktopLifecycle } from "./desktop-lifecycle.js";
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
const DEFAULT_COMPANION_STATE_DIRECTORY = "companion-state";
const ELECTRON_SMOKE_CONTROL = "quit-v1";
const WINDOWS_ELECTRON_SMOKE_CONTROL = "windows-v1";
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

function companionStateRoot(app, environment) {
  if (Object.hasOwn(environment, "USAGE_MONITOR_STATE_ROOT")) {
    return environment.USAGE_MONITOR_STATE_ROOT;
  }
  const userData = app?.getPath?.("userData");
  if (typeof userData !== "string" || userData.length === 0) return undefined;
  return join(resolve(userData), DEFAULT_COMPANION_STATE_DIRECTORY);
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

function windowsSmokeStateLine(lifecycle) {
  const state = lifecycle?.state ?? {};
  return `TIBOTATTLE_ELECTRON_SMOKE_STATE started=${state.started === true ? 1 : 0}`
    + ` primary=${state.primaryInstance === true ? 1 : 0}`
    + ` window=${state.hasWindow === true ? 1 : 0}`
    + ` visible=${state.windowVisible === true ? 1 : 0}`
    + ` tray=${state.hasTray === true ? 1 : 0}\n`;
}

/**
 * Install the packaged Windows smoke control only for the exact opt-in test
 * environment.  It is deliberately stdin-only: no renderer, preload, IPC,
 * loopback endpoint, or production readiness override is introduced. Unknown
 * commands are ignored and every accepted response is fixed/content-free.
 */
export function installWindowsSmokeControl(lifecycle, {
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  qualificationContext = null,
} = {}) {
  if (process.platform !== "win32"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL
        !== WINDOWS_ELECTRON_SMOKE_CONTROL
      || environment.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION
        !== WINDOWS_ELECTRON_QUALIFICATION_MARKER
      || environment.USAGE_MONITOR_TEST_LANE !== WINDOWS_ELECTRON_TEST_LANE
      || lifecycle?.state?.primaryInstance !== true
      || !qualificationContext
      || typeof input?.on !== "function") {
    return () => {};
  }
  try {
    assertWindowsElectronQualificationContext({
      context: qualificationContext,
      platform: "win32",
      architecture: "x64",
    });
  } catch {
    return () => {};
  }
  let buffered = "";
  let active = true;
  let credentialOperation = Promise.resolve();
  const write = (value) => {
    try {
      output?.write?.(value);
    } catch {
      // The smoke harness owns process lifetime; a closed control pipe must
      // never change the shell's normal shutdown policy.
    }
  };
  const handleCommand = (command) => {
    if (!WINDOWS_ELECTRON_SMOKE_COMMANDS.has(command)) return;
    if (command === "status-v1") {
      write(windowsSmokeStateLine(lifecycle));
      return;
    }
    if (command === "tray-show-v1") {
      lifecycle.invokeTrayCommand?.("show");
      write(windowsSmokeStateLine(lifecycle));
      return;
    }
    if (command === "tray-hide-v1") {
      lifecycle.invokeTrayCommand?.("hide");
      write(windowsSmokeStateLine(lifecycle));
      return;
    }
    if (command === "tray-toggle-v1") {
      lifecycle.invokeTrayCommand?.("toggle");
      write(windowsSmokeStateLine(lifecycle));
      return;
    }
    if (command === "credential-probe-v1") {
      credentialOperation = credentialOperation.then(async () => {
        try {
          await runWindowsElectronQualificationCredentialProbe(qualificationContext);
          write("TIBOTATTLE_ELECTRON_SMOKE_CREDENTIAL_PROBE_PASSED\n");
        } catch {
          write("TIBOTATTLE_ELECTRON_SMOKE_CREDENTIAL_PROBE_FAILED\n");
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    if (command.startsWith("credential-") && command.endsWith("-v1")) {
      credentialOperation = credentialOperation.then(async () => {
        try {
          await runWindowsElectronQualificationCredentialCommand({
            context: qualificationContext,
            command: command.slice("credential-".length),
            runId: environment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID,
          });
          write(`TIBOTATTLE_ELECTRON_SMOKE_CREDENTIAL_${command
            .slice("credential-".length, -3).toUpperCase()}_PASSED\n`);
        } catch {
          write(`TIBOTATTLE_ELECTRON_SMOKE_CREDENTIAL_${command
            .slice("credential-".length, -3).toUpperCase()}_FAILED\n`);
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    // Quit is acknowledged before the window/tray and child are torn down so
    // the harness can distinguish a requested clean quit from a forced kill.
    write("TIBOTATTLE_ELECTRON_SMOKE_QUIT_ACCEPTED\n");
    input.pause?.();
    void Promise.resolve(lifecycle.requestQuit?.()).catch(() => {
      process.exitCode = 1;
    });
  };
  const onData = (chunk) => {
    if (!active) return;
    buffered += String(chunk);
    while (true) {
      const lineEnd = buffered.indexOf("\n");
      if (lineEnd < 0) break;
      const line = buffered.slice(0, lineEnd).replace(/\r$/u, "");
      buffered = buffered.slice(lineEnd + 1);
      handleCommand(line);
    }
    // A control line is intentionally tiny. Drop an unbounded unterminated
    // input rather than allowing a test pipe to become a memory sink.
    if (buffered.length > 256) buffered = "";
  };
  input.setEncoding?.("utf8");
  input.on("data", onData);
  input.resume?.();
  return () => {
    active = false;
    input.off?.("data", onData);
    input.pause?.();
  };
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
    const supervisor = createCompanionSupervisor({
      command: process.execPath,
      args: [paths.companionScript],
      cwd: paths.companionCwd,
      environment: {
        ...environment,
        USAGE_MONITOR_RESOURCE_ROOT: paths.resourceRoot,
        ...(Object.hasOwn(environment, "USAGE_MONITOR_STATE_ROOT")
          ? {}
          : (() => {
            const selectedStateRoot = companionStateRoot(app, environment);
            return selectedStateRoot === undefined
              ? {}
              : { USAGE_MONITOR_STATE_ROOT: selectedStateRoot };
          })()),
      },
      ...supervisorOptions,
    });
    const lifecycle = createDesktopLifecycle({
      app,
      BrowserWindow: runtime.BrowserWindow,
      Tray: runtime.Tray,
      Menu: runtime.Menu,
      icon: runtime.nativeImage?.createEmpty?.(),
      preloadPath: resolve(MODULE_DIRECTORY, "preload.js"),
      supervisor,
      appName: isPackagedElectronApp(app) ? "TiboTattle Dev" : "TiboTattle",
      ...lifecycleOptions,
    });
    await lifecycle.start();
    installWindowsSmokeControl(lifecycle, {
      environment,
      qualificationContext,
    });
    return lifecycle;
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
      // The Linux GUI smoke needs a deterministic way to exercise the same
      // main-process shutdown path as the tray's Quit action. Keep that
      // control test-only, opt-in, and out of the renderer/preload boundary.
      // SIGUSR2 is not installed on Windows, so this cannot become a Windows
      // production contract by accident.
      if (process.platform !== "win32"
          && process.env.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL === ELECTRON_SMOKE_CONTROL) {
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
