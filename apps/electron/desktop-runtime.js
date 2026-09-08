import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import distribution from "../../config/electron-production-distribution.cjs";
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
import {
  createDesktopContributionCredentialBackend,
  createDesktopContributionCredentialLegacyProbe,
  createDesktopContributionCredentialLegacyRecoveryBackend,
} from "./desktop-contribution-credential.js";
import { classifyDesktopSharingInstallation } from "./desktop-sharing-installation.js";
import { attachAccountlessParentChannel } from "../../src/platform/index.js";
import {
  createDesktopNotificationCoordinator,
  createDesktopNotificationPolicyCodec,
  DESKTOP_NOTIFICATION_POLICY_FILE_NAME,
} from "./desktop-notification-coordinator.js";
import { createDesktopNotificationDelivery } from "./desktop-notification-delivery.js";
import { shellError } from "./errors.js";
import {
  createProductionDesktopUpdater,
  PRODUCTION_ELECTRON_CHANNEL,
  validateProductionDistributionMetadata,
} from "./desktop-updater.js";
import { createDesktopUpdatePreferences, createDesktopUpdatePreferencesBackend } from "./desktop-update-preferences.js";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  defaultExportStateDirectory,
} from "../../src/platform/index.js";

const DESKTOP_SETTINGS_DIRECTORY = "desktop-settings";
const ACCOUNTLESS_HOSTED_REHEARSAL_DIRECTORY = "accountless-hosted-rehearsal-v1";
const ACCOUNTLESS_HOSTED_REHEARSAL_METADATA_KEYS = Object.freeze([
  "appId",
  "channel",
  "credentialStorage",
  "origin",
  "schemaVersion",
  "sourceRevision",
  "target",
]);
const ACCOUNTLESS_HOSTED_REHEARSAL_ENVIRONMENT_KEYS = Object.freeze([
  "CODEX_BIN",
  "CODEX_HOME",
  "CODEX_THREAD_ID",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIRECTORY",
  "HOME",
  "USERPROFILE",
  "USAGE_MONITOR_ACCOUNTING_SOURCE_MODE",
  "USAGE_MONITOR_ACCOUNTLESS_MODE",
  "USAGE_MONITOR_ACCOUNTLESS_ORIGIN",
  "USAGE_MONITOR_CENTRAL_ORIGIN",
  "USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE",
  "USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE",
  "USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY",
  "USAGE_MONITOR_PREPARED_DIRECTORY",
  "USAGE_MONITOR_RESOURCE_ROOT",
  "USAGE_MONITOR_STATE_ROOT",
  "USAGE_MONITOR_TEST_LANE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;

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

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * The staged package itself is the only authority that may select this
 * private hosted rehearsal. Renderer settings and launch environment values
 * cannot supply an origin, storage mode, target, or profile identity.
 */
export function validateAccountlessHostedRehearsalMetadata(value, {
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (platform !== "darwin" || architecture !== "arm64"
      || !hasExactKeys(value, ACCOUNTLESS_HOSTED_REHEARSAL_METADATA_KEYS)
      || value.appId !== distribution.ACCOUNTLESS_HOSTED_REHEARSAL_APP_ID
      || value.channel !== distribution.ACCOUNTLESS_HOSTED_REHEARSAL_CHANNEL
      || value.credentialStorage
        !== distribution.ACCOUNTLESS_HOSTED_REHEARSAL_CREDENTIAL_STORAGE
      || value.origin !== DEPLOYMENT_ENDPOINTS.staging.origin
      || value.schemaVersion
        !== distribution.ACCOUNTLESS_HOSTED_REHEARSAL_SCHEMA_VERSION
      || typeof value.sourceRevision !== "string"
      || !SOURCE_REVISION_PATTERN.test(value.sourceRevision)
      || value.target !== distribution.ACCOUNTLESS_HOSTED_REHEARSAL_TARGET) {
    throw new TypeError("accountless hosted rehearsal metadata is invalid");
  }
  return Object.freeze({
    appId: distribution.ACCOUNTLESS_HOSTED_REHEARSAL_APP_ID,
    channel: distribution.ACCOUNTLESS_HOSTED_REHEARSAL_CHANNEL,
    credentialStorage: distribution.ACCOUNTLESS_HOSTED_REHEARSAL_CREDENTIAL_STORAGE,
    origin: DEPLOYMENT_ENDPOINTS.staging.origin,
    schemaVersion: distribution.ACCOUNTLESS_HOSTED_REHEARSAL_SCHEMA_VERSION,
    sourceRevision: value.sourceRevision,
    target: distribution.ACCOUNTLESS_HOSTED_REHEARSAL_TARGET,
  });
}

function userDataPath(app) {
  const selected = app?.getPath?.("userData");
  if (typeof selected !== "string" || selected.length === 0) {
    throw new TypeError("Electron userData path is unavailable");
  }
  return resolve(selected);
}

function accountlessHostedRehearsalPaths(app) {
  const rootPath = join(userDataPath(app), ACCOUNTLESS_HOSTED_REHEARSAL_DIRECTORY);
  const syntheticHome = join(rootPath, "synthetic-home");
  return Object.freeze({
    codexHome: join(syntheticHome, ".codex"),
    profileRoot: rootPath,
    settingsRoot: join(rootPath, DESKTOP_SETTINGS_DIRECTORY),
    stateRoot: join(rootPath, "companion-state"),
    syntheticClaudeConfig: join(syntheticHome, ".claude"),
    syntheticHome,
    syntheticProject: join(syntheticHome, "project"),
    xdgCacheHome: join(rootPath, "xdg-cache"),
    xdgConfigHome: join(rootPath, "xdg-config"),
    xdgDataHome: join(rootPath, "xdg-data"),
    xdgRuntimeDirectory: join(rootPath, "xdg-runtime"),
    xdgStateHome: join(rootPath, "xdg-state"),
  });
}

function accountlessHostedRehearsalEnvironment({ environment, paths, resourceRoot }) {
  const selected = { ...environment };
  for (const key of ACCOUNTLESS_HOSTED_REHEARSAL_ENVIRONMENT_KEYS) delete selected[key];
  // This profile owns every root used by the companion. In particular, a
  // future explicit Claude shadow selection cannot inherit a user config or
  // project root through the child environment.
  selected.HOME = paths.syntheticHome;
  selected.USERPROFILE = paths.syntheticHome;
  selected.CODEX_HOME = paths.codexHome;
  selected.CLAUDE_CONFIG_DIR = paths.syntheticClaudeConfig;
  selected.CLAUDE_PROJECT_DIR = paths.syntheticProject;
  selected.CLAUDE_PROJECT_DIRECTORY = paths.syntheticProject;
  selected.USAGE_MONITOR_ACCOUNTING_SOURCE_MODE = "unified";
  selected.USAGE_MONITOR_STATE_ROOT = paths.stateRoot;
  // This root identifies only reviewed packaged static/runtime assets. It is
  // supplied by main.js after resolving the bundle, never inherited from a
  // caller's environment or renderer setting.
  selected.USAGE_MONITOR_RESOURCE_ROOT = resourceRoot;
  selected.XDG_CACHE_HOME = paths.xdgCacheHome;
  selected.XDG_CONFIG_HOME = paths.xdgConfigHome;
  selected.XDG_DATA_HOME = paths.xdgDataHome;
  selected.XDG_RUNTIME_DIR = paths.xdgRuntimeDirectory;
  selected.XDG_STATE_HOME = paths.xdgStateHome;
  return selected;
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
  rootPath,
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
  const selectedRootPath = rootPath ?? join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
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
      rootPath: selectedRootPath,
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
    rootPath: selectedRootPath,
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
  getUpdater,
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
    getUpdater,
  });
}

function createSettingsBackend({
  app,
  platform,
  settingsBackend,
  rootPath,
  windowsProtectedStateStore,
  qualificationContext,
  architecture = process.arch,
} = {}) {
  if (settingsBackend !== undefined) return settingsBackend;
  const selectedRootPath = rootPath ?? join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
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
      rootPath: selectedRootPath,
    });
    return createWindowsDesktopSettingsBackend({
      platform: "win32",
      windowsProtectedStateStore: protectedStore,
    });
  }
  return createPosixDesktopSettingsBackend({
    platform,
    rootPath: selectedRootPath,
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
  accountlessLaboratory,
  accountlessProduction,
  accountlessHostedRehearsal,
  productionDistribution,
  prepareNativeHandover,
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
  // Test-only loopback composition. Normal main.js does not provide this port.
  // Production is a separate packaged-manifest selection below.
  if (accountlessLaboratory !== undefined) {
    let url;
    try { url = new URL(accountlessLaboratory.origin); } catch { throw shellError("electron_configuration_invalid"); }
    const credentialBackend = accountlessLaboratory.backend;
    if (credentialBackend !== undefined && (!credentialBackend
        || typeof credentialBackend !== "object" || Array.isArray(credentialBackend)
        || ["read", "createIfMissing", "deleteExact"]
          .some((operation) => typeof credentialBackend[operation] !== "function"))) {
      throw shellError("electron_configuration_invalid");
    }
    if (url.origin !== accountlessLaboratory.origin || url.protocol !== "http:"
        || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
        || environment.USAGE_MONITOR_TEST_LANE !== "accountless-local-lab-v1"
        || sharingBackend === undefined || sharingInstallationState === undefined
        || qualificationContext !== null) throw shellError("electron_configuration_invalid");
  }
  const accountlessProductionUsesMacNativeCredential = accountlessProduction !== undefined
    && platform === "darwin";
  const accountlessProductionUsesLinuxNativeCredential = accountlessProduction !== undefined
    && platform === "linux";
  const accountlessProductionUsesWindowsNativeCredential = accountlessProduction !== undefined
    && platform === "win32";
  if (accountlessProduction !== undefined && (
    accountlessProduction === null || typeof accountlessProduction !== "object"
      || Array.isArray(accountlessProduction)
      || Object.keys(accountlessProduction).sort().join(",") !== (
        accountlessProductionUsesMacNativeCredential
          ? "createMacOSCredentialBackend,origin,policyVersion"
          : accountlessProductionUsesLinuxNativeCredential
            ? "createLinuxCredentialBackend,origin,policyVersion"
            : accountlessProductionUsesWindowsNativeCredential
              ? "createWindowsCredentialBackend,origin,policyVersion"
              : "origin,policyVersion")
      || (accountlessProductionUsesMacNativeCredential
        && typeof accountlessProduction.createMacOSCredentialBackend !== "function")
      || (accountlessProductionUsesLinuxNativeCredential
        && typeof accountlessProduction.createLinuxCredentialBackend !== "function")
      || (accountlessProductionUsesWindowsNativeCredential
        && typeof accountlessProduction.createWindowsCredentialBackend !== "function")
      || accountlessProduction.origin !== DEPLOYMENT_ENDPOINTS.public.origin
      || accountlessProduction.policyVersion !== "accountless-opt-out-v1"
      || accountlessLaboratory !== undefined || app.isPackaged !== true
      || app.getName?.() !== "TiboTattle"
      || environment.USAGE_MONITOR_TEST_LANE !== undefined
      || qualificationContext !== null)) throw shellError("electron_configuration_invalid");
  let selectedAccountlessHostedRehearsal;
  if (accountlessHostedRehearsal !== undefined) {
    try {
      selectedAccountlessHostedRehearsal = validateAccountlessHostedRehearsalMetadata(
        accountlessHostedRehearsal,
        { platform, architecture },
      );
    } catch {
      throw shellError("electron_configuration_invalid");
    }
    if (accountlessLaboratory !== undefined
        || accountlessProduction !== undefined
        || productionDistribution !== undefined
        || prepareNativeHandover !== undefined
        || qualificationContext !== null
        || app.isPackaged !== true
        || app.getName?.() !== "TiboTattle Dev"
        || platformServices !== undefined
        || settingsBackend !== undefined
        || settingsStore !== undefined
        || notificationBackend !== undefined
        || sharingBackend !== undefined
        || sharingInstallationState !== undefined
        || firstRunReceiptBackend !== undefined
        || ownedDownloadsRegistry !== undefined
        || automaticRefreshCadence !== undefined
        || argv !== undefined) {
      throw shellError("electron_configuration_invalid");
    }
  }
  const accountlessEnabled = accountlessLaboratory !== undefined
    || accountlessProduction !== undefined
    || selectedAccountlessHostedRehearsal !== undefined;
  if (productionDistribution !== undefined) {
    const distribution = validateProductionDistributionMetadata(productionDistribution, {
      platform,
      architecture,
    });
    if (distribution.channel !== PRODUCTION_ELECTRON_CHANNEL
        && accountlessProduction !== undefined) {
      throw shellError("electron_configuration_invalid");
    }
    if (app.isPackaged !== true || app.getName?.() !== "TiboTattle"
        || environment.USAGE_MONITOR_TEST_LANE !== undefined
        || qualificationContext !== null || platformServices !== undefined) {
      throw shellError("electron_configuration_invalid");
    }
  }
  if (prepareNativeHandover !== undefined && (typeof prepareNativeHandover !== "function"
      || productionDistribution === undefined || platform !== "darwin")) {
    throw shellError("electron_configuration_invalid");
  }
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
  const hostedRehearsalPaths = selectedAccountlessHostedRehearsal === undefined
    ? null
    : accountlessHostedRehearsalPaths(app);
  const runtimeEnvironment = hostedRehearsalPaths === null
    ? environment
    : accountlessHostedRehearsalEnvironment({
      environment,
      paths: hostedRehearsalPaths,
      resourceRoot: paths.resourceRoot,
    });
  const childEnvironment = childEnvironmentWithStateRoot({
    app,
    environment: runtimeEnvironment,
  });
  if (productionDistribution !== undefined) {
    childEnvironment.USAGE_MONITOR_STATE_ROOT = join(userDataPath(app), "companion-state");
  }
  const sharingDestinationOrigin = selectedAccountlessHostedRehearsal?.origin
    ?? accountlessProduction?.origin ?? accountlessLaboratory?.origin
    ?? childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN
    ?? DEPLOYMENT_ENDPOINTS.public.origin;
  // Never run the legacy scheduler beside the installation policy. The
  // selected accountless mode still requires current server upload authority.
  // Local provider capture and offline analysis remain independently available.
  delete childEnvironment.USAGE_MONITOR_CENTRAL_ORIGIN;
  delete childEnvironment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN;
  delete childEnvironment.USAGE_MONITOR_ACCOUNTLESS_MODE;
  if (accountlessLaboratory) childEnvironment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN = accountlessLaboratory.origin;
  if (accountlessProduction) {
    // The accountless companion owns its fixed binding and progress paths.
    // Retired manual-upload inputs must not select a second queue or spool.
    delete childEnvironment.USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE;
    delete childEnvironment.USAGE_MONITOR_PREPARED_DIRECTORY;
    childEnvironment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN = accountlessProduction.origin;
    childEnvironment.USAGE_MONITOR_ACCOUNTLESS_MODE = "production-v1";
  }
  if (selectedAccountlessHostedRehearsal) {
    // The package marker selects the one reviewed nonproduction endpoint. No
    // renderer or inherited environment value can alter the scheduler mode,
    // destination, queue, or state root.
    delete childEnvironment.USAGE_MONITOR_CONTRIBUTION_QUEUE_FILE;
    delete childEnvironment.USAGE_MONITOR_PREPARED_DIRECTORY;
    childEnvironment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN =
      selectedAccountlessHostedRehearsal.origin;
    childEnvironment.USAGE_MONITOR_ACCOUNTLESS_MODE = "rehearsal-v1";
  }
  let sharingCoordinator;
  let installationCredentialBackend;
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
    attachPrivateChannel: accountlessEnabled ? (channel) => attachAccountlessParentChannel({
      channel,
      readPreference: () => sharingCoordinator.readAuthorization(),
      backend: installationCredentialBackend,
      onStatus: (value) => sharingCoordinator.updateTransport?.(value),
    }) : undefined,
  });
  let updater = null;
  const selectedPlatformServices = platformServices ?? runtimePlatformServices({
    runtime,
    app,
    platform,
    homeDirectory: runtimeHomeDirectory({ platform, environment: runtimeEnvironment }),
    environment: runtimeEnvironment,
    getUpdater: () => updater,
  });
  const services = hostedRehearsalPaths === null
    ? selectedPlatformServices
    : Object.freeze({
      ...selectedPlatformServices,
      // Renderer settings must not pick a host directory for the compiled
      // rehearsal. The default root is the profile's synthetic CODEX_HOME.
      chooseCodexHome: async () => null,
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
  if (prepareNativeHandover !== undefined) {
    let handover;
    try {
      handover = await prepareNativeHandover({
        homeDirectory: runtimeHomeDirectory({ platform, environment }),
      });
    } catch {
      handover = { status: "migration_blocked" };
    }
    if (!["no_legacy_state", "migrated", "already_migrated"].includes(handover?.status)) {
      const credentialPreflightBlocked = handover?.status === "credential_preflight_blocked";
      await runtime.dialog?.showMessageBox?.({
        type: "warning",
        title: credentialPreflightBlocked
          ? "Unable to prepare secure storage"
          : "Finish moving to TiboTattle",
        message: credentialPreflightBlocked
          ? "TiboTattle could not complete its secure startup checks."
          : "Your Mac app data needs to be transferred before TiboTattle can start.",
        detail: credentialPreflightBlocked
          ? "Your existing app data has not been changed. Quit and try again."
          : "Run the guided migration again. Your existing data has been preserved.",
        buttons: ["Quit"], defaultId: 0, cancelId: 0, noLink: true,
      });
      deepLinkIntakeCleanup();
      app.quit?.();
      return Object.freeze({ status: "native_handover_blocked", firstRun: null,
        lifecycle: null, supervisor: null, controller: null, settingsStore: null,
        settingsBackend: null, ipc: createNoopIpcInstallation(), childEnvironment: null });
    }
  }
  const desktopSystemLocales = requestedDesktopSystemLocales
    ?? electronSystemLocales(app);
  const settingsRootPath = hostedRehearsalPaths?.settingsRoot
    ?? join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  const injectedSettings = settingsBackend !== undefined || settingsStore !== undefined
    || firstRunReceiptBackend !== undefined;
  const homeDirectory = runtimeHomeDirectory({
    platform,
    environment: runtimeEnvironment,
  });
  const legacyStateRoots = hostedRehearsalPaths === null
    ? [defaultExportStateDirectory({
      platform,
      homeDirectory,
      environment: runtimeEnvironment,
    })]
    : [];
  if (hostedRehearsalPaths === null && platform === "darwin") {
    legacyStateRoots.push(join(homeDirectory, "Library", "Application Support", "Usage Monitor"));
  }
  // Establish provenance before the first-run receipt or settings create a new
  // managed marker. Injected test backends never inspect real profile state.
  const installationState = sharingInstallationState ?? (injectedSettings
    ? "unknown"
    : await classifyDesktopSharingInstallation({
      profileRoot: hostedRehearsalPaths?.profileRoot ?? userDataPath(app),
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
  // Production macOS, Linux, and Windows composition uses a main-process
  // native adapter. Windows has no selected factory today, so an explicit
  // factory requirement prevents a future production flag from falling back
  // to Electron safeStorage before its native credential route qualifies.
  // Do not call Electron safeStorage there: its asynchronous availability probe
  // can initialize a platform credential provider. Existing encrypted records
  // are inspected without decrypting or changing them so a prior installation
  // stops for explicit recovery instead of rotating identity.
  if (accountlessEnabled) {
    if (accountlessProductionUsesMacNativeCredential
        || accountlessProductionUsesLinuxNativeCredential
        || accountlessProductionUsesWindowsNativeCredential) {
      const legacyCredentialProbe = createDesktopContributionCredentialLegacyProbe({
        platform,
        rootPath: settingsRootPath,
        windowsProtectedStateStore,
      });
      const nativeBackend = accountlessProduction[
        accountlessProductionUsesMacNativeCredential
          ? "createMacOSCredentialBackend"
          : accountlessProductionUsesLinuxNativeCredential
            ? "createLinuxCredentialBackend"
            : "createWindowsCredentialBackend"
      ]({
        legacyCredentialProbe: legacyCredentialProbe.inspect,
      });
      if (!nativeBackend
          || typeof nativeBackend !== "object"
          || ["read", "createIfMissing", "deleteExact"].some(
            (operation) => typeof nativeBackend[operation] !== "function",
          )) {
        throw shellError("electron_configuration_invalid");
      }
      // macOS owns this recovery check within its signed adapter. Linux and
      // Windows keep the equivalent metadata-only boundary in this generic
      // main-process wrapper until their reviewed native backends are selected
      // by an entrypoint.
      installationCredentialBackend = (accountlessProductionUsesLinuxNativeCredential
        || accountlessProductionUsesWindowsNativeCredential)
        ? createDesktopContributionCredentialLegacyRecoveryBackend({
          backend: nativeBackend,
          legacyCredentialProbe: legacyCredentialProbe.inspect,
        })
        : nativeBackend;
    } else {
      installationCredentialBackend = accountlessLaboratory?.backend
        ?? createDesktopContributionCredentialBackend({
          safeStorage: runtime.safeStorage,
          platform,
          rootPath: settingsRootPath,
          windowsProtectedStateStore,
        });
    }
  }
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
    production: productionDistribution !== undefined,
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
  try {
    const selectedSharingBackend = sharingBackend ?? (injectedSettings
      ? { load: async () => { throw new Error("Sharing unavailable"); },
        save: async () => { throw new Error("Sharing unavailable"); } }
      : createDesktopSharingBackend({ platform, rootPath: settingsRootPath,
        windowsProtectedStateStore }));
    sharingCoordinator = createDesktopSharingCoordinator({ backend: selectedSharingBackend,
      installationState, destinationOrigin: sharingDestinationOrigin,
      onAuthorizationChanged: () => supervisor.invalidatePrivateChannel() });
    await sharingCoordinator.initialize();
  } catch {
    // Preference or protected-store failure blocks contribution, never local use.
    const unavailable = async () => { throw shellError("desktop_sharing_unavailable"); };
    sharingCoordinator = { inspect: unavailable, setEnabled: unavailable,
      markNoticePresented: unavailable,
      readAuthorization: async () => ({ available: false, current: false,
        enabled: false, policyVersion: null, destinationOrigin: null }),
      updateTransport() {}, dispose() {} };
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
      rootPath: settingsRootPath,
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
    rootPath: settingsRootPath,
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
    if (hostedRehearsalPaths !== null && home.mode !== "default") {
      throw shellError("desktop_codex_roots_invalid");
    }
    if (home.mode === "custom") {
      childEnvironment.CODEX_HOME = home.path;
    } else {
      childEnvironment.CODEX_HOME = services.defaultCodexHome
        ?? join(runtimeHomeDirectory({ platform, environment: runtimeEnvironment }), ".codex");
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
    if (hostedRehearsalPaths !== null && (
      selected.activityRoots.length !== 1
      || primary.kind !== "default"
    )) {
      // This package can rehearse the real scheduler only from its compiled
      // synthetic source. A saved UI choice may make the private test profile
      // unusable, but it can never redirect a companion to host history.
      throw shellError("desktop_codex_roots_invalid");
    }
    let primaryPath = primary.kind === "default"
      ? services.defaultCodexHome
        ?? join(runtimeHomeDirectory({ platform, environment: runtimeEnvironment }), ".codex")
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
    desktopPlatform: platform,
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
    initialTrayPreferences: initialDesktopSnapshot.settings.tray,
    onTrayHistoryRange: async (historyRange) => {
      const current = await store.getSettings();
      return controller.handlers.setTrayPreferences({ value: { ...current.tray, historyRange } });
    },
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
      updater?.dispose();
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
    if (productionDistribution !== undefined) {
      // Load the third-party native updater only in the selected production
      // package, after Electron readiness and ownership of the child lifecycle.
      const updaterModule = runtime.autoUpdater ? null : await import("electron-updater");
      const autoUpdater = runtime.autoUpdater ?? updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
      updater = createProductionDesktopUpdater({
        app, autoUpdater, distributionMetadata: productionDistribution,
        platform, architecture,
        preferences: createDesktopUpdatePreferences({
          backend: createDesktopUpdatePreferencesBackend({
            platform, rootPath: settingsRootPath, windowsProtectedStateStore,
          }),
        }),
        prepareForUpdate: () => lifecycle.prepareForUpdate(),
        cancelPreparedUpdate: () => lifecycle.cancelUpdatePreparation(),
      });
      await updater.start();
    }
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
    setDesktopTrayPreferences: lifecycle.setDesktopTrayPreferences,
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
