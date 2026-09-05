import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DEPLOYMENT_ENDPOINTS } from "../../config/deployment-endpoints.js";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import {
  createDesktopAutomaticRefreshCadence,
  createDesktopAutomaticRefreshCadenceBackend,
} from "./desktop-automatic-refresh-cadence.js";
import { createDesktopCommand } from "./desktop-command.js";
import { createDesktopController } from "./desktop-controller.js";
import { createDesktopDeepLinkQueue } from "./desktop-deep-links.js";
import { createDesktopLifecycle } from "./desktop-lifecycle.js";
import { installDesktopIpc } from "./desktop-ipc.js";
import {
  createDesktopPlatformServices,
  validateDesktopCodexHome,
} from "./desktop-platform-services.js";
import {
  createPosixDesktopSettingsBackend,
  createWindowsDesktopSettingsBackend,
} from "./desktop-settings-backends.js";
import { createDesktopSettingsStore } from "./desktop-settings-store.js";
import { DESKTOP_APPEARANCES } from "./desktop-contract.js";
import {
  isAbsoluteCodexPath,
  normalizeCodexHomes,
  normalizeCodexPathForComparison,
} from "./desktop-codex-roots.js";
import { desktopText } from "./desktop-copy.js";
import {
  createDesktopDiagnostics,
  formatDesktopDiagnostics,
} from "./desktop-diagnostics.js";
import {
  createDesktopFirstRunReceiptBackend,
  ensureDesktopFirstRunAcknowledged,
} from "./desktop-first-run.js";
import { createDesktopFirstRunLoginRegistrar } from "./desktop-first-run-login.js";
import { createDesktopRecoverySettingsAction } from "./desktop-recovery-settings.js";
import { createDesktopOwnedDownloadRegistry } from "./desktop-owned-downloads.js";
import { createDesktopSharingBackend, createDesktopSharingCoordinator } from "./desktop-sharing.js";
import { classifyDesktopSharingInstallation } from "./desktop-sharing-installation.js";
import {
  createDesktopNotificationCoordinator,
  createDesktopNotificationPolicyCodec,
  DESKTOP_NOTIFICATION_POLICY_FILE_NAME,
} from "./desktop-notification-coordinator.js";
import { createDesktopNotificationDelivery } from "./desktop-notification-delivery.js";
import { shellError } from "./errors.js";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  defaultExportStateDirectory,
} from "../../src/platform/index.js";

const DESKTOP_SETTINGS_DIRECTORY = "desktop-settings";

const SETTINGS_CODEX_ROOT_ACTIONS = new Set([
  "getCodexHomesForSettings",
  "chooseCodexHome",
  "addCodexHome",
  "editCodexHome",
  "removeCodexHome",
  "setPrimaryCodexHome",
  "reorderCodexHomes",
  "useDefaultCodexHome",
]);

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function userDataPath(app) {
  const selected = app?.getPath?.("userData");
  if (typeof selected !== "string" || selected.length === 0) {
    throw new TypeError("Electron userData path is unavailable");
  }
  return resolve(selected);
}

function electronSystemLocales(app) {
  const locales = [];
  try {
    const preferred = app?.getPreferredSystemLanguages?.();
    if (Array.isArray(preferred)) locales.push(...preferred);
  } catch {
    // Locale discovery is presentation-only; the desktop runtime can still
    // start with the catalog's English fallback.
  }
  try {
    const selected = app?.getLocale?.();
    if (typeof selected === "string") locales.push(selected);
  } catch {
    // See the preferred-languages fallback above.
  }
  return locales;
}

function applyElectronAppearance(nativeTheme, preference) {
  if (!DESKTOP_APPEARANCES.includes(preference)
      || nativeTheme === null
      || typeof nativeTheme !== "object") {
    return null;
  }
  try {
    nativeTheme.themeSource = preference;
  } catch {
    return null;
  }
  const resolvedTheme = preference === "dark"
    ? "dark"
    : preference === "light"
      ? "light"
      : nativeTheme.shouldUseDarkColors === true ? "dark" : "light";
  return resolvedTheme;
}

function childEnvironmentWithStateRoot({ app, environment }) {
  const selected = { ...environment };
  if (!Object.hasOwn(selected, "USAGE_MONITOR_STATE_ROOT")) {
    selected.USAGE_MONITOR_STATE_ROOT = join(
      userDataPath(app),
      "companion-state",
    );
  }
  return selected;
}

function runtimeHomeDirectory({ platform, environment }) {
  const preferredKeys = platform === "win32"
    ? ["USERPROFILE", "HOME"]
    : ["HOME", "USERPROFILE"];
  for (const key of preferredKeys) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return homedir();
}

function isWindowsCodexPath(value) {
  return typeof value === "string"
    && (/^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value));
}

function isPlatformCodexPath(value, platform) {
  if (!isAbsoluteCodexPath(value)) return false;
  if (platform === "win32") {
    // The lexical root model is deliberately cross-platform, but a child on
    // Windows must never receive a POSIX spelling that the Win32 APIs would
    // reinterpret as relative/current-drive state.
    return isWindowsCodexPath(value);
  }
  // Conversely, do not reinterpret a drive/UNC path on macOS or Linux. The
  // native picker and the companion must agree on the host path grammar.
  return value.startsWith("/") && !isWindowsCodexPath(value);
}

function assertNoWindowsTestOverrides({
  qualificationContext,
  platformServices,
  settingsBackend,
  settingsStore,
  notificationBackend,
  sharingBackend,
  sharingInstallationState,
  firstRunReceiptBackend,
  ownedDownloadsRegistry,
  automaticRefreshCadence,
  argv,
} = {}) {
  if (qualificationContext === null || qualificationContext === undefined) return;
  if (platformServices !== undefined
      || settingsBackend !== undefined
      || settingsStore !== undefined
      || firstRunReceiptBackend !== undefined
      || ownedDownloadsRegistry !== undefined
      || notificationBackend !== undefined
      || sharingBackend !== undefined
      || sharingInstallationState !== undefined
      || automaticRefreshCadence !== undefined
      || argv !== undefined) {
    throw shellError("windows_qualification_launch_override_forbidden");
  }
}

function createUnavailableElectronNotificationConstructor() {
  return class UnavailableElectronNotification {
    static isSupported() {
      return false;
    }
  };
}

function electronNotificationConstructor(runtime) {
  return typeof runtime?.Notification === "function"
    && typeof runtime.Notification.isSupported === "function"
    ? runtime.Notification
    : createUnavailableElectronNotificationConstructor();
}

function createNotificationPolicyBackend({
  app,
  platform,
  notificationBackend,
  windowsProtectedStateStore,
  qualificationContext,
  architecture = process.arch,
} = {}) {
  if (notificationBackend !== undefined) {
    if (qualificationContext !== null && qualificationContext !== undefined) {
      throw shellError("windows_qualification_launch_override_forbidden");
    }
    return notificationBackend;
  }
  const rootPath = join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  const codec = createDesktopNotificationPolicyCodec();
  if (platform === "win32") {
    // The qualified Windows lane must use the branded protected store for
    // every desktop record. A test backend is intentionally impossible in
    // that lane, and there is no ordinary Node filesystem fallback.
    if (qualificationContext === null || qualificationContext === undefined) {
      throw shellError("windows_readiness_unavailable");
    }
    const adapter = createWindowsFilesystemAdapter({
      platform: "win32",
      architecture,
    });
    const protectedStore = windowsProtectedStateStore ?? createWindowsProtectedStateStore({
      adapter,
      rootPath,
    });
    return createWindowsDesktopSettingsBackend({
      platform: "win32",
      windowsProtectedStateStore: protectedStore,
      childName: DESKTOP_NOTIFICATION_POLICY_FILE_NAME,
      codec,
    });
  }
  return createPosixDesktopSettingsBackend({
    platform,
    rootPath,
    filename: DESKTOP_NOTIFICATION_POLICY_FILE_NAME,
    codec,
  });
}

async function createRuntimeOwnedDownloadsRegistry({
  app,
  runtime,
  qualificationContext,
  ownedDownloadsRegistry,
} = {}) {
  if (ownedDownloadsRegistry !== undefined) {
    if (qualificationContext !== null && qualificationContext !== undefined) {
      throw shellError("windows_qualification_launch_override_forbidden");
    }
    return ownedDownloadsRegistry;
  }
  // Electron supplies both the Downloads path and shell.showItemInFolder in
  // a real desktop runtime. Plain-Node composition tests may omit them; the
  // rest of the shell remains testable and the reveal action is unavailable.
  if (typeof app?.getPath !== "function"
      || typeof runtime?.shell?.showItemInFolder !== "function") {
    return null;
  }
  let rootPath;
  try {
    rootPath = app.getPath("downloads");
  } catch {
    return null;
  }
  if (typeof rootPath !== "string" || rootPath.length === 0) return null;
  try {
    return await createDesktopOwnedDownloadRegistry({
      rootPath,
      reveal: (path) => runtime.shell.showItemInFolder(path),
    });
  } catch {
    // A real Electron runtime must not silently fall back to the browser's
    // unmanaged default Downloads path. Fail closed before the dashboard can
    // offer a save action whose destination the main process does not own.
    throw shellError("electron_configuration_invalid");
  }
}

function runtimePlatformServices({
  runtime,
  app,
  platform,
  homeDirectory,
  environment,
}) {
  // Electron always supplies these modules in a real launch.  The bounded
  // fallback keeps the plain-Node composition tests independent of Electron;
  // it is never selected for the qualified Windows lane.
  const dialog = runtime?.dialog ?? {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  };
  const shell = runtime?.shell ?? {
    openExternal: async () => true,
  };
  const Notification = runtime?.Notification ?? {
    isSupported: () => false,
  };
  return createDesktopPlatformServices({
    app,
    dialog,
    shell,
    Notification,
    platform,
    homeDirectory,
    environment,
  });
}

function createSettingsBackend({
  app,
  platform,
  settingsBackend,
  windowsProtectedStateStore,
  qualificationContext,
  architecture = process.arch,
} = {}) {
  if (settingsBackend !== undefined) return settingsBackend;
  const rootPath = join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  if (platform === "win32") {
    // Windows never falls back to Node filesystem state. The repository's
    // branded adapter and protected store are the only accepted backend.
    if (qualificationContext === null || qualificationContext === undefined) {
      // The platform gate normally prevents this branch. Keeping the check
      // explicit prevents a future caller from silently enabling an unqualified
      // Windows desktop state path.
      throw shellError("windows_readiness_unavailable");
    }
    const adapter = createWindowsFilesystemAdapter({
      platform: "win32",
      architecture,
    });
    const protectedStore = windowsProtectedStateStore ?? createWindowsProtectedStateStore({
      adapter,
      rootPath,
    });
    return createWindowsDesktopSettingsBackend({
      platform: "win32",
      windowsProtectedStateStore: protectedStore,
    });
  }
  return createPosixDesktopSettingsBackend({
    platform,
    rootPath,
  });
}

function createNoopIpcInstallation() {
  return Object.freeze({
    channel: null,
    dispose() {},
  });
}

/**
 * Compose and start the real Electron desktop runtime.
 *
 * The child environment is intentionally mutable only inside this module. A
 * persisted custom CODEX_HOME is applied before the first supervisor.start;
 * later changes mutate that private environment and use lifecycle.retry().
 * The controller owns persistence rollback when a restart or write fails.
 */
export async function launchDesktopRuntime({
  runtime,
  app,
  paths,
  environment = process.env,
  supervisorOptions = {},
  lifecycleOptions = {},
  qualificationContext = null,
  platform = process.platform,
  architecture = process.arch,
  platformServices,
  settingsBackend,
  settingsStore,
  notificationBackend,
  sharingBackend,
  sharingInstallationState,
  firstRunReceiptBackend,
  ownedDownloadsRegistry,
  automaticRefreshCadence,
  argv,
} = {}) {
  assertObject(runtime, "runtime");
  if (!app || typeof app.on !== "function") throw new TypeError("app is required");
  assertObject(paths, "paths");
  if (typeof paths.companionScript !== "string"
      || typeof paths.companionCwd !== "string"
      || typeof paths.resourceRoot !== "string"
      || typeof paths.preloadPath !== "string") {
    throw new TypeError("companion launch paths are invalid");
  }
  assertObject(environment, "environment");
  assertObject(supervisorOptions, "supervisorOptions");
  assertObject(lifecycleOptions, "lifecycleOptions");
  assertNoWindowsTestOverrides({
    qualificationContext,
    platformServices,
    settingsBackend,
    settingsStore,
    notificationBackend,
    sharingBackend,
    sharingInstallationState,
    firstRunReceiptBackend,
    ownedDownloadsRegistry,
    automaticRefreshCadence,
    argv,
  });
  if (platform === "win32" && qualificationContext !== null
      && qualificationContext !== undefined && architecture !== "x64") {
    throw shellError("windows_readiness_unavailable");
  }

  if (typeof runtime.BrowserWindow !== "function") {
    throw new TypeError("BrowserWindow is required");
  }
  const childEnvironment = childEnvironmentWithStateRoot({ app, environment });
  const sharingDestinationOrigin = childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN
    ?? DEPLOYMENT_ENDPOINTS.public.origin;
  // The accountless candidate has no upload authority yet. Do not let an old
  // participant scheduler bypass its new opt-out or fall back to social login.
  // Local provider capture and offline analysis remain independently available.
  delete childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  // Keep one mutable argument vector for the lifetime of this runtime. The
  // supervisor snapshots it for each spawn, so a Settings root change can
  // persist first, update this vector, and then use the ordinary bounded
  // lifecycle Retry path without constructing a second supervisor.
  const companionArgs = [paths.companionScript];
  const {
    args: ignoredSupervisorArgs,
    command: ignoredSupervisorCommand,
    cwd: ignoredSupervisorCwd,
    environment: ignoredSupervisorEnvironment,
    ...safeSupervisorOptions
  } = supervisorOptions;
  void ignoredSupervisorArgs;
  void ignoredSupervisorCommand;
  void ignoredSupervisorCwd;
  void ignoredSupervisorEnvironment;
  const supervisor = createCompanionSupervisor({
    ...safeSupervisorOptions,
    command: process.execPath,
    args: companionArgs,
    cwd: paths.companionCwd,
    environment: childEnvironment,
  });
  const services = platformServices ?? runtimePlatformServices({
    runtime,
    app,
    platform,
    homeDirectory: runtimeHomeDirectory({ platform, environment }),
    environment,
  });
  const requestedDesktopSystemLocales = lifecycleOptions.desktopSystemLocales;
  const firstRunLocale = lifecycleOptions.desktopLocale ?? "system";
  const deepLinkQueue = createDesktopDeepLinkQueue();
  let lifecycle = null;
  let dashboardReady = false;
  let deepLinkIntakeCleanup = () => {};

  // This lock and the app-link listeners are intentionally established before
  // Electron readiness and before first-run/settings work. A secondary
  // process therefore cannot open a companion of its own, and macOS can
  // deliver `open-url` while the primary app is still starting.
  const singleInstanceLockAcquired = typeof app.requestSingleInstanceLock === "function"
    ? app.requestSingleInstanceLock()
    : true;
  if (!singleInstanceLockAcquired) {
    app.quit?.();
    return Object.freeze({
      firstRun: null,
      lifecycle: null,
      supervisor: null,
      controller: null,
      settingsStore: null,
      settingsBackend: null,
      ipc: createNoopIpcInstallation(),
      childEnvironment: null,
      status: "secondary_instance",
    });
  }

  const dispatchPendingDeepLinks = () => {
    if (!dashboardReady || lifecycle === null) return 0;
    const pending = deepLinkQueue.drain();
    let delivered = 0;
    for (const target of pending) {
      lifecycle.showWindow?.();
      const sent = lifecycle.sendDashboardCommand?.(
        createDesktopCommand("hostedSignInReturn"),
      ) === true;
      if (sent) {
        delivered += 1;
      } else {
        // Requeue only the fixed canonical target. The original URL/argv is
        // never retained or forwarded across the renderer boundary.
        deepLinkQueue.enqueue(target.canonicalURL);
      }
    }
    return delivered;
  };

  const acceptDeepLinkArgv = (values) => {
    if (!Array.isArray(values)) return 0;
    const accepted = deepLinkQueue.enqueueMany(values);
    dispatchPendingDeepLinks();
    return accepted.length;
  };
  const onOpenURL = (event, value) => {
    event?.preventDefault?.();
    deepLinkQueue.enqueue(value);
    dispatchPendingDeepLinks();
  };
  const onSecondInstance = (_event, commandLine) => {
    acceptDeepLinkArgv(commandLine);
  };
  if (platform === "darwin") app.on("open-url", onOpenURL);
  app.on("second-instance", onSecondInstance);
  deepLinkIntakeCleanup = () => {
    app.off?.("open-url", onOpenURL);
    app.off?.("second-instance", onSecondInstance);
    deepLinkIntakeCleanup = () => {};
  };
  if (platform !== "darwin") acceptDeepLinkArgv(argv ?? process.argv);
  // Electron's native dialog must be shown only after the app is ready. This
  // does not start the companion, register a login item, or enable updates.
  await app.whenReady?.();
  const desktopSystemLocales = requestedDesktopSystemLocales
    ?? electronSystemLocales(app);
  const settingsRootPath = join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  const injectedSettings = settingsBackend !== undefined || settingsStore !== undefined
    || firstRunReceiptBackend !== undefined;
  const homeDirectory = runtimeHomeDirectory({ platform, environment });
  const legacyStateRoots = [defaultExportStateDirectory({ platform, homeDirectory, environment })];
  if (platform === "darwin") {
    legacyStateRoots.push(join(homeDirectory, "Library", "Application Support", "Usage Monitor"));
  }
  // Establish provenance before the first-run receipt or settings create a new
  // managed marker. Injected test backends never inspect real profile state.
  const installationState = sharingInstallationState ?? (injectedSettings
    ? "unknown"
    : await classifyDesktopSharingInstallation({ profileRoot: userDataPath(app),
      stateRoot: childEnvironment.USAGE_MONITOR_STATE_ROOT, legacyStateRoots }));
  const needsWindowsProtectedStateStore = platform === "win32"
    && (qualificationContext !== null
      && qualificationContext !== undefined
      || firstRunReceiptBackend === undefined
      || settingsBackend === undefined
      || notificationBackend === undefined);
  const windowsProtectedStateStore = needsWindowsProtectedStateStore
    ? createWindowsProtectedStateStore({
      adapter: createWindowsFilesystemAdapter({
        platform: "win32",
        architecture,
      }),
      rootPath: settingsRootPath,
    })
    : null;
  const firstRunBackend = firstRunReceiptBackend
    ?? createDesktopFirstRunReceiptBackend({
      platform,
      rootPath: settingsRootPath,
      windowsProtectedStateStore,
    });
  const firstRun = await ensureDesktopFirstRunAcknowledged({
    dialog: runtime.dialog,
    receiptBackend: firstRunBackend,
    quit: () => app.quit?.(),
    locale: firstRunLocale,
    systemLocales: desktopSystemLocales,
  });
  if (firstRun.status !== "acknowledged") {
    deepLinkIntakeCleanup();
    return Object.freeze({
      firstRun,
      lifecycle: null,
      supervisor,
      controller: null,
      settingsStore: null,
      settingsBackend: null,
      ipc: createNoopIpcInstallation(),
      childEnvironment,
    });
  }
  let sharingCoordinator;
  try {
    const selectedSharingBackend = sharingBackend ?? (injectedSettings
      ? { load: async () => { throw new Error("Sharing unavailable"); },
        save: async () => { throw new Error("Sharing unavailable"); } }
      : createDesktopSharingBackend({ platform, rootPath: settingsRootPath,
        windowsProtectedStateStore }));
    sharingCoordinator = createDesktopSharingCoordinator({ backend: selectedSharingBackend,
      installationState, destinationOrigin: sharingDestinationOrigin });
    await sharingCoordinator.initialize();
  } catch {
    // Preference or protected-store failure blocks contribution, never local use.
    const unavailable = async () => { throw shellError("desktop_sharing_unavailable"); };
    sharingCoordinator = { inspect: unavailable, setEnabled: unavailable,
      markNoticePresented: unavailable, dispose() {} };
  }
  const runtimeOwnedDownloadsRegistry = await createRuntimeOwnedDownloadsRegistry({
    app,
    runtime,
    qualificationContext,
    ownedDownloadsRegistry,
  });
  const validateCodexHome = typeof services.validateCodexHome === "function"
    ? services.validateCodexHome
    : (path) => validateDesktopCodexHome(path, { platform });
  const backend = settingsStore === undefined
    ? createSettingsBackend({
      app,
      platform,
      settingsBackend,
      qualificationContext,
      architecture,
      windowsProtectedStateStore,
    })
    : null;
  const runtimeAutomaticRefreshCadence = automaticRefreshCadence
    ?? (!injectedSettings
      && (platform !== "win32" || windowsProtectedStateStore !== null)
      ? createDesktopAutomaticRefreshCadence({
        backend: createDesktopAutomaticRefreshCadenceBackend({
          platform,
          rootPath: settingsRootPath,
          windowsProtectedStateStore,
        }),
      })
      : undefined);
  const policyBackend = createNotificationPolicyBackend({
    app,
    platform,
    notificationBackend,
    qualificationContext,
    architecture,
    windowsProtectedStateStore,
  });
  const store = settingsStore ?? createDesktopSettingsStore({ backend });

  let activeDesktopLocale = lifecycleOptions.desktopLocale ?? firstRunLocale;
  let activeNotificationDelivery = createDesktopNotificationDelivery({
    Notification: electronNotificationConstructor(runtime),
    app,
    platform,
    locale: activeDesktopLocale,
    systemLocales: desktopSystemLocales,
    // A directory/qualification artifact does not prove the installed
    // Windows notification identity. Keep this false until the signed
    // installed identity is independently qualified.
    windowsIdentityReady: false,
  });
  const notificationDelivery = Object.freeze({
    status() {
      return activeNotificationDelivery.status();
    },
    deliver(value) {
      return activeNotificationDelivery.deliver(value);
    },
  });
  const notificationCoordinator = createDesktopNotificationCoordinator({
    backend: policyBackend,
    delivery: notificationDelivery,
  });

  let facade = null;
  let controller;
  let ipcInstallation = createNoopIpcInstallation();
  let cleanupPromise = null;
  let removeNativeThemeListener = () => {};

  async function collectDesktopDiagnostics() {
    let snapshot = null;
    try {
      snapshot = await controller?.snapshot?.();
    } catch {
      snapshot = null;
    }
    return formatDesktopDiagnostics(createDesktopDiagnostics({
      platform,
      architecture,
      version: snapshot?.about?.version ?? app.getVersion?.(),
      build: snapshot?.about?.build ?? environment.TIBOTATTLE_BUILD_ID,
      lifecycle: lifecycle?.state,
      settings: snapshot?.settings,
    }));
  }

  async function showDesktopDiagnostics() {
    if (typeof runtime.dialog?.showMessageBox !== "function") {
      throw shellError("desktop_diagnostics_unavailable");
    }
    const textOptions = {
      locale: activeDesktopLocale,
      systemLocales: desktopSystemLocales,
    };
    const detail = await collectDesktopDiagnostics();
    const response = await runtime.dialog.showMessageBox({
      type: "info",
      title: desktopText("electron.diagnostics.title", {}, textOptions),
      message: desktopText("electron.diagnostics.message", {}, textOptions),
      detail,
      buttons: [
        desktopText("electron.diagnostics.copy", {}, textOptions),
        desktopText("electron.diagnostics.done", {}, textOptions),
      ],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response?.response !== 0) return Object.freeze({ status: "shown" });
    if (typeof runtime.clipboard?.writeText !== "function") {
      return Object.freeze({ status: "copy_unavailable" });
    }
    try {
      runtime.clipboard.writeText(detail);
      return Object.freeze({ status: "copied" });
    } catch {
      return Object.freeze({ status: "copy_unavailable" });
    }
  }

  async function revealLocalData() {
    const selected = childEnvironment.USAGE_MONITOR_STATE_ROOT;
    if (typeof selected !== "string" || !isAbsolute(selected)
        || typeof runtime.shell?.showItemInFolder !== "function") {
      throw shellError("desktop_local_data_unavailable");
    }
    runtime.shell.showItemInFolder(resolve(selected));
    return true;
  }

  async function openDashboardInBrowser() {
    const selected = lifecycle;
    if (selected === null || typeof selected.openDashboardInBrowser !== "function") {
      throw shellError("desktop_dashboard_browser_unavailable");
    }
    return selected.openDashboardInBrowser();
  }

  const updateDesktopAppearance = (value) => applyElectronAppearance(
    runtime.nativeTheme,
    value,
  );

  function updateDesktopLanguage(value) {
    activeDesktopLocale = value;
    try {
      activeNotificationDelivery = createDesktopNotificationDelivery({
        Notification: electronNotificationConstructor(runtime),
        app,
        platform,
        locale: value,
        systemLocales: desktopSystemLocales,
        windowsIdentityReady: false,
      });
    } catch {
      // A copy/catalog failure must not make a persisted language change
      // fail. The previous delivery adapter remains authoritative in that
      // unlikely case, while its status stays capability-gated.
    }
    if (recoverySettingsAction !== undefined) {
      try {
        recoverySettingsAction = createDesktopRecoverySettingsAction({
          controller,
          dialog: runtime.dialog,
          locale: value,
          systemLocales: desktopSystemLocales,
        });
      } catch {
        // Recovery repair remains available in the previously resolved
        // language if a later catalog rebuild unexpectedly fails.
      }
    }
    const platformUpdated = typeof services.setLocale === "function"
      && services.setLocale(value) === true;
    const lifecycleUpdated = lifecycle?.setDesktopLanguage?.(value) === true;
    return platformUpdated || lifecycleUpdated;
  }

  function assignCodexHome(home) {
    if (home.mode === "custom") {
      childEnvironment.CODEX_HOME = home.path;
    } else {
      childEnvironment.CODEX_HOME = services.defaultCodexHome
        ?? join(runtimeHomeDirectory({ platform, environment }), ".codex");
    }
  }

  function effectiveCodexHomes(configuration) {
    let selected;
    try {
      selected = normalizeCodexHomes(configuration);
    } catch {
      throw shellError("desktop_codex_roots_invalid");
    }
    // v2 settings can retain additional roots for a future multi-folder
    // release. The current local companion supports one CODEX_HOME only, so
    // resolve and validate just the persisted primary rather than passing
    // ignored argv flags or treating retained roots as activity sources.
    const primary = selected.activityRoots.find(
      ({ rootId }) => rootId === selected.primaryRootId,
    );
    if (!primary) throw shellError("desktop_codex_roots_invalid");
    let primaryPath = primary.kind === "default"
      ? services.defaultCodexHome
        ?? join(runtimeHomeDirectory({ platform, environment }), ".codex")
      : primary.path;
    if (typeof primaryPath !== "string" || !isPlatformCodexPath(primaryPath, platform)) {
      throw shellError("desktop_codex_roots_invalid");
    }
    // Tests can compose a Win32 runtime on a POSIX host. Do not run a
    // Windows drive/UNC spelling through the host's node:path resolver; the
    // real Windows process already treats it as absolute.
    if (platform !== "win32" && !isWindowsCodexPath(primaryPath)) {
      primaryPath = resolve(primaryPath);
    }
    try {
      normalizeCodexPathForComparison(primaryPath);
    } catch {
      throw shellError("desktop_codex_roots_invalid");
    }
    return Object.freeze({
      configuration: selected,
      primaryPath,
    });
  }

  function assignCodexHomes(configuration) {
    const selected = effectiveCodexHomes(configuration);
    // The production companion reads CODEX_HOME. It does not implement the
    // historical multi-root argv proposal, so keep its invocation honest.
    // Mutate in place in case a previous runtime candidate supplied flags,
    // while preserving the server script at argv[0].
    companionArgs.splice(1);
    childEnvironment.CODEX_HOME = selected.primaryPath;
    return selected;
  }

  async function applyCodexHome(home, previous) {
    assignCodexHome(home);
    // Initialization has no running child. Every subsequent selection uses
    // the lifecycle's bounded stop/start path, so no unbounded direct spawn is
    // introduced by the settings bridge.
    if (previous !== null && previous !== undefined) {
      if (lifecycle === null) throw shellError("companion_not_running");
      await lifecycle.retry();
    }
  }

  async function applyCodexHomes(configuration, previous) {
    assignCodexHomes(configuration);
    // Initialization has no running child. All later updates are a bounded
    // stop/start through lifecycle.retry; if it fails the persisted config and
    // this argv/env candidate intentionally remain in place for Retry.
    if (previous !== null && previous !== undefined) {
      if (lifecycle === null) throw shellError("companion_not_running");
      await lifecycle.retry();
    }
  }

  function sendDashboardCommand(command) {
    return lifecycle?.sendDashboardCommand?.(command) === true;
  }

  controller = createDesktopController({
    sharingCoordinator,
    settingsStore: store,
    platformServices: services,
    notificationCoordinator,
    getLifecycle: () => facade ?? lifecycle,
    applyCodexHome,
    applyCodexHomes,
    validateCodexHome,
    sendDashboardCommand,
    onLanguageChanged: (value) => updateDesktopLanguage(value),
    onAppearanceChanged: updateDesktopAppearance,
    openDashboardInBrowserAction: openDashboardInBrowser,
    showDiagnosticsAction: showDesktopDiagnostics,
    revealLocalDataAction: revealLocalData,
    automaticRefreshCadence: runtimeAutomaticRefreshCadence,
  });

  // Load persisted settings before starting the child. This is what makes a
  // previously selected Codex root effective on the first launch.
  let initialDesktopSnapshot;
  let firstRunLogin = Object.freeze({ status: "not_requested" });
  let recoverySettingsAction;
  try {
    initialDesktopSnapshot = await controller.initialize();
    const firstRunLoginRegistrar = createDesktopFirstRunLoginRegistrar({
      controller,
      dialog: runtime.dialog,
      locale: firstRunLocale,
      systemLocales: desktopSystemLocales,
    });
    firstRunLogin = await firstRunLoginRegistrar.apply(firstRun);
    recoverySettingsAction = createDesktopRecoverySettingsAction({
      controller,
      dialog: runtime.dialog,
      locale: initialDesktopSnapshot.settings.language,
      systemLocales: desktopSystemLocales,
    });
  } catch (error) {
    deepLinkIntakeCleanup();
    await controller.dispose();
    await notificationCoordinator.drain().catch(() => {});
    await notificationCoordinator.dispose().catch(() => {});
    throw error;
  }
  const callerActions = lifecycleOptions.desktopActions;
  const callerOnDesktopStatus = lifecycleOptions.onDesktopStatus;
  const boundedCallerActions = callerActions !== null
    && typeof callerActions === "object"
    && !Array.isArray(callerActions)
    ? callerActions
    : {};
  const desktopActions = {
    ...boundedCallerActions,
    refresh: () => controller.refreshUsage(),
    toggleSidebar: () => {
      const operation = controller.toggleSidebar();
      operation?.catch?.(() => {});
      return operation;
    },
    retry: () => lifecycle?.retry?.(),
    settings: () => controller.showSettings("general"),
    about: () => controller.showSettings("about"),
    recoverySettings: () => recoverySettingsAction.show(),
    diagnostics: () => controller.handlers.showDiagnostics({}),
    quit: () => { void requestQuit(); },
  };
  const selectedLifecycleOptions = {
    ...lifecycleOptions,
    desktopActions,
    desktopLocale: initialDesktopSnapshot.settings.language,
    desktopSystemLocales,
    singleInstanceLockAcquired,
    openDashboardExternal: lifecycleOptions.openDashboardExternal
      ?? (async (url) => {
        if (typeof runtime.shell?.openExternal !== "function") return false;
        await runtime.shell.openExternal(url, { activate: true });
        return true;
      }),
    onDashboardReady: () => {
      dashboardReady = true;
      controller.reconcileDashboardSession?.();
      dispatchPendingDeepLinks();
    },
    onDashboardInvalidated: () => {
      controller.reconcileDashboardSession?.();
    },
    onDesktopStatus: (status) => {
      // The lifecycle has already validated this closed status contract. The
      // coordinator serializes persistence and delivery; a notification
      // failure is capability state, never a lifecycle failure.
      void notificationCoordinator.evaluate(status).catch(() => {});
      if (typeof callerOnDesktopStatus === "function") {
        try {
          callerOnDesktopStatus(status);
        } catch {
          // A caller observer is diagnostic/UI convenience only.
        }
      }
    },
  };
  try {
    lifecycle = createDesktopLifecycle({
      app,
      BrowserWindow: runtime.BrowserWindow,
      Tray: runtime.Tray,
      Menu: runtime.Menu,
      screen: runtime.screen,
      icon: runtime.icon,
      createTrayIcon: runtime.createTrayIcon,
      preloadPath: paths.preloadPath,
      supervisor,
      ...selectedLifecycleOptions,
      platform,
      ownedDownloadsRegistry: runtimeOwnedDownloadsRegistry,
    });
  } catch (error) {
    deepLinkIntakeCleanup();
    await controller.dispose();
    await notificationCoordinator.drain().catch(() => {});
    await notificationCoordinator.dispose().catch(() => {});
    throw error;
  }

  async function disposeControllerAndIpc() {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      removeNativeThemeListener();
      removeNativeThemeListener = () => {};
      ipcInstallation.dispose?.();
      sharingCoordinator.dispose();
      await controller.dispose();
      // Drain first so a final status evaluation cannot race disposal. The
      // coordinator is idempotent, which also tolerates a future controller
      // implementation that owns the same disposal seam.
      await notificationCoordinator.drain().catch(() => {});
      await notificationCoordinator.dispose().catch(() => {});
    })();
    cleanupPromise.catch(() => {});
    return cleanupPromise;
  }

  async function requestQuit() {
    deepLinkIntakeCleanup();
    await disposeControllerAndIpc();
    return lifecycle?.requestQuit?.();
  }

  const onBeforeQuit = () => {
    deepLinkIntakeCleanup();
    void disposeControllerAndIpc();
  };
  app.on("before-quit", onBeforeQuit);

  try {
    // Install the fixed bridge before lifecycle.start creates a visible
    // window. The renderer remains unauthorized until its BrowserWindow and
    // top frame exist.
    if (runtime.ipcMain?.handle) {
      ipcInstallation = installDesktopIpc({
        ipcMain: runtime.ipcMain,
        handlers: controller.handlers,
        trustedSender: (sender, event) => lifecycle?.isAuthorizedDesktopSender?.(sender, event) === true,
        trustedFrame: (frame, event) => lifecycle?.isAuthorizedDesktopFrame?.(frame, event) === true,
        trustedAction: (action, event) => {
          if (action === "sharingNoticePresented") {
            const context = { sender: event?.sender };
            // The scheduled notice is rendered only in the dashboard. Settings
            // can select a preference, but cannot supply a display receipt.
            return lifecycle?.state.windowVisible === true
              && lifecycle.isAuthorizedDashboardFrame?.(event?.senderFrame, context) === true;
          }
          if (SETTINGS_CODEX_ROOT_ACTIONS.has(action)) {
            return lifecycle?.isAuthorizedSettingsFrame?.(
              event?.senderFrame,
              { sender: event?.sender },
            ) === true;
          }
          if (action === "openCodexThread") {
            return lifecycle?.isAuthorizedCodexThreadNavigation?.(
              event?.senderFrame,
              { sender: event?.sender },
            ) === true;
          }
          if (action !== "refreshStarted"
              && action !== "refreshSettled"
              && action !== "toggleSidebar") return true;
          return lifecycle?.isAuthorizedDashboardFrame?.(
            event?.senderFrame,
            { sender: event?.sender },
          ) === true;
        },
      });
    } else if (qualificationContext !== null && qualificationContext !== undefined) {
      throw shellError("desktop_ipc_unavailable");
    }
    if (typeof runtime.nativeTheme?.on === "function") {
      const onNativeThemeUpdated = () => {
        void store.getSettings().then((settings) => {
          const resolvedTheme = updateDesktopAppearance(settings.appearance);
          if (resolvedTheme !== null) {
            facade?.sendDashboardCommand?.({
              command: "appearance",
              preference: settings.appearance,
              resolvedTheme,
            });
          }
        }).catch(() => {});
      };
      runtime.nativeTheme.on("updated", onNativeThemeUpdated);
      removeNativeThemeListener = () => {
        runtime.nativeTheme.removeListener?.("updated", onNativeThemeUpdated);
      };
    }
    await lifecycle.start();
  } catch (error) {
    deepLinkIntakeCleanup();
    await disposeControllerAndIpc();
    app.off?.("before-quit", onBeforeQuit);
    throw error;
  }

  facade = Object.freeze({
    start: lifecycle.start,
    retry: lifecycle.retry,
    showWindow: lifecycle.showWindow,
    showTrayPopover: lifecycle.showTrayPopover,
    showSettingsWindow: lifecycle.showSettingsWindow,
    hideWindow: lifecycle.hideWindow,
    toggleWindow: lifecycle.toggleWindow,
    sendDashboardCommand: lifecycle.sendDashboardCommand,
    navigateDashboardSection: lifecycle.navigateDashboardSection,
    setDesktopLanguage: lifecycle.setDesktopLanguage,
    invokeTrayCommand: lifecycle.invokeTrayCommand,
    requestQuit,
    openDashboardInBrowser: lifecycle.openDashboardInBrowser,
    dispose: async () => {
      deepLinkIntakeCleanup();
      await disposeControllerAndIpc();
      app.off?.("before-quit", onBeforeQuit);
      return lifecycle.dispose();
    },
    isAuthorizedDesktopSender: lifecycle.isAuthorizedDesktopSender,
    isAuthorizedDesktopFrame: lifecycle.isAuthorizedDesktopFrame,
    isAuthorizedDashboardSender: lifecycle.isAuthorizedDashboardSender,
    isAuthorizedDashboardFrame: lifecycle.isAuthorizedDashboardFrame,
    isAuthorizedCodexThreadNavigation: lifecycle.isAuthorizedCodexThreadNavigation,
    isAuthorizedSettingsFrame: lifecycle.isAuthorizedSettingsFrame,
    isAuthorizedDesktopDownloadContext: lifecycle.isAuthorizedDesktopDownloadContext,
    revealLatestDownload: lifecycle.revealLatestDownload,
    get state() {
      return lifecycle.state;
    },
  });

  return Object.freeze({
    firstRun,
    firstRunLogin,
    lifecycle: facade,
    supervisor,
    controller,
    notificationCoordinator,
    sharingCoordinator,
    settingsStore: store,
    settingsBackend: backend,
    ipc: ipcInstallation,
    childEnvironment,
  });
}

export const DESKTOP_SETTINGS_DIRECTORY_NAME = DESKTOP_SETTINGS_DIRECTORY;
