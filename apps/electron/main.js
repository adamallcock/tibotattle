import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import { createDesktopLifecycle } from "./desktop-lifecycle.js";
import { ELECTRON_ENTRY_FAILURE_DIAGNOSTIC } from "./errors.js";
import { assertElectronPlatformGate } from "./platform-gate.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPANION_SCRIPT = resolve(MODULE_DIRECTORY, "../local/server.js");
const DEFAULT_RESOURCE_ROOT = resolve(MODULE_DIRECTORY, "../..");
const DEFAULT_COMPANION_STATE_DIRECTORY = "companion-state";

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
  readiness = null,
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
    const paths = resolveCompanionLaunchPaths({
      app,
      companionScript,
      resourceRoot,
      resourcesPath,
    });
    assertElectronPlatformGate({
      platform: process.platform,
      architecture: process.arch,
      readiness,
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
      ...lifecycleOptions,
    });
    await lifecycle.start();
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
  launchElectronShell({ emitFailureDiagnostic: true }).catch(() => {
    process.exitCode = 1;
  });
}
