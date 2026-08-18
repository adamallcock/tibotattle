import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import { createDesktopLifecycle } from "./desktop-lifecycle.js";
import { assertElectronPlatformGate } from "./platform-gate.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPANION_SCRIPT = resolve(MODULE_DIRECTORY, "../local/server.js");
const DEFAULT_RESOURCE_ROOT = resolve(MODULE_DIRECTORY, "../..");

/**
 * Compose the real Electron runtime. The function is intentionally separate
 * from module evaluation so all policy/lifecycle code remains plain-Node
 * testable when Electron is not installed in the source checkout.
 */
export async function launchElectronShell({
  electron,
  companionScript = DEFAULT_COMPANION_SCRIPT,
  resourceRoot = DEFAULT_RESOURCE_ROOT,
  environment = process.env,
  readiness = null,
  supervisorOptions = {},
  lifecycleOptions = {},
} = {}) {
  const runtime = electron ?? await import("electron");
  const app = runtime?.app;
  if (!app || typeof app.on !== "function") {
    throw new TypeError("Electron app runtime is unavailable");
  }
  try {
    assertElectronPlatformGate({
      platform: process.platform,
      architecture: process.arch,
      readiness,
    });
    const supervisor = createCompanionSupervisor({
      command: process.execPath,
      args: [companionScript],
      cwd: resourceRoot,
      environment: {
        ...environment,
        USAGE_MONITOR_RESOURCE_ROOT: resourceRoot,
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
    app.quit?.();
    throw error;
  }
}

// Node-based tests and repository tooling import this entry without executing
// a desktop launch. An actual Electron process is the only executable caller.
if (process.versions.electron) {
  launchElectronShell().catch(() => {
    process.exitCode = 1;
  });
}
