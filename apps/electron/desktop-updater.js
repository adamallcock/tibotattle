import distribution from "../../config/electron-production-distribution.cjs";

export const PRODUCTION_ELECTRON_APP_ID = distribution.PRODUCTION_ELECTRON_APP_ID;
export const PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN =
  distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN;
export const PRODUCTION_ELECTRON_CHANNEL = distribution.PRODUCTION_ELECTRON_CHANNEL;
export const PRODUCTION_ELECTRON_CONTRIBUTION_POLICY =
  distribution.PRODUCTION_ELECTRON_CONTRIBUTION_POLICY;
export const PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION =
  distribution.PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION;
export const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CANDIDATES =
  distribution.PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CANDIDATES;
export const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL =
  distribution.PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL;
export const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CONTRIBUTION_POLICY =
  distribution.PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CONTRIBUTION_POLICY;
export const PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_SCHEMA_VERSION =
  distribution.PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_SCHEMA_VERSION;
export const PRODUCTION_ELECTRON_TARGETS = distribution.PRODUCTION_ELECTRON_TARGETS;
export const PRODUCTION_ELECTRON_UPDATE_ORIGIN = distribution.PRODUCTION_ELECTRON_UPDATE_ORIGIN;
export const PRODUCTION_ELECTRON_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000;

const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const UPDATE_STATES = new Set([
  "unavailable",
  "ready",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "current",
  "installing",
  "error",
]);
const UPDATE_ERRORS = new Set([
  "none",
  "configuration_failed",
  "check_failed",
  "download_failed",
  "install_failed",
  "preferences_unavailable",
  "shutdown_failed",
  "unavailable",
]);

export class DesktopUpdaterError extends Error {
  constructor(code) {
    super("Desktop updater operation failed");
    this.name = "DesktopUpdaterError";
    this.code = `desktop_updater_${code}`;
  }
}

function fail(code) {
  throw new DesktopUpdaterError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function targetFor(platform, architecture) {
  if (typeof platform !== "string" || typeof architecture !== "string") return null;
  return distribution.productionElectronTargetFor(platform, architecture);
}

export function productionUpdateFeedForTarget({ platform, architecture } = {}) {
  const target = targetFor(platform, architecture);
  return target === null ? null : distribution.productionElectronFeedForTarget(target);
}

function rehearsalForMetadata(value) {
  if (!isPlainRecord(value)
      || typeof value.rehearsalCurrentVersion !== "string"
      || typeof value.rehearsalNextVersion !== "string") return null;
  if (value.semanticVersion === value.rehearsalCurrentVersion) return "current";
  if (value.semanticVersion === value.rehearsalNextVersion) return "next";
  return null;
}

export function createProductionDistributionMetadata({
  buildNumber,
  target,
  sourceRevision,
  channel,
  rehearsal = null,
  rehearsalCurrentVersion,
  rehearsalNextVersion,
} = {}) {
  const selected = distribution.productionElectronDistributionForTarget({
    target,
    rehearsal,
    rehearsalCurrentVersion,
    rehearsalNextVersion,
  });
  if (selected === null
      || (channel !== undefined && channel !== selected.channel)
      || typeof buildNumber !== "string"
      || !PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)
      || typeof sourceRevision !== "string" || !SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new TypeError("production Electron distribution metadata is invalid");
  }
  const metadata = {
    appId: PRODUCTION_ELECTRON_APP_ID,
    buildNumber,
    channel: selected.channel,
    contributionPolicy: selected.contributionPolicy,
    schemaVersion: selected.schemaVersion,
    sourceRevision,
    target,
    updateFeed: selected.feedURL,
  };
  if (selected.semanticVersion !== null) {
    metadata.semanticVersion = selected.semanticVersion;
    metadata.rehearsalCurrentVersion = selected.rehearsalCurrentVersion;
    metadata.rehearsalNextVersion = selected.rehearsalNextVersion;
  }
  return Object.freeze(metadata);
}

export function validateProductionDistributionMetadata(value, {
  platform,
  architecture,
} = {}) {
  const target = targetFor(platform, architecture);
  const stable = target === null
    ? null
    : distribution.productionElectronDistributionForTarget({ target });
  const validStable = stable !== null && hasExactKeys(value, [
    "appId",
    "buildNumber",
    "channel",
    "contributionPolicy",
    "schemaVersion",
    "sourceRevision",
    "target",
    "updateFeed",
  ])
      && value.appId === PRODUCTION_ELECTRON_APP_ID
      && typeof value.buildNumber === "string"
      && PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(value.buildNumber)
      && value.channel === stable.channel
      && value.contributionPolicy === stable.contributionPolicy
      && value.schemaVersion === stable.schemaVersion
      && value.target === target
      && typeof value.sourceRevision === "string"
      && SOURCE_REVISION_PATTERN.test(value.sourceRevision)
      && value.updateFeed === stable.feedURL;
  if (validStable) {
    return createProductionDistributionMetadata({
      buildNumber: value.buildNumber,
      target: value.target,
      sourceRevision: value.sourceRevision,
    });
  }
  const rehearsal = rehearsalForMetadata(value);
  const selected = target === null || rehearsal === null
    ? null
    : distribution.productionElectronDistributionForTarget({
      target,
      rehearsal,
      rehearsalCurrentVersion: value.rehearsalCurrentVersion,
      rehearsalNextVersion: value.rehearsalNextVersion,
    });
  if (selected === null || !hasExactKeys(value, [
    "appId",
    "buildNumber",
    "channel",
    "contributionPolicy",
    "schemaVersion",
    "sourceRevision",
    "target",
    "updateFeed",
    "semanticVersion",
    "rehearsalCurrentVersion",
    "rehearsalNextVersion",
  ])
      || value.appId !== PRODUCTION_ELECTRON_APP_ID
      || typeof value.buildNumber !== "string"
      || !PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(value.buildNumber)
      || value.channel !== selected.channel
      || value.contributionPolicy !== selected.contributionPolicy
      || value.schemaVersion !== selected.schemaVersion
      || value.target !== target
      || typeof value.sourceRevision !== "string"
      || !SOURCE_REVISION_PATTERN.test(value.sourceRevision)
      || value.updateFeed !== selected.feedURL
      || value.semanticVersion !== selected.semanticVersion
      || value.rehearsalCurrentVersion !== selected.rehearsalCurrentVersion
      || value.rehearsalNextVersion !== selected.rehearsalNextVersion) {
    throw new TypeError("production Electron distribution metadata is invalid");
  }
  return createProductionDistributionMetadata({
    buildNumber: value.buildNumber,
    target: value.target,
    sourceRevision: value.sourceRevision,
    rehearsal,
    rehearsalCurrentVersion: value.rehearsalCurrentVersion,
    rehearsalNextVersion: value.rehearsalNextVersion,
  });
}

function assertPreferences(value) {
  if (!isPlainRecord(value)
      || typeof value.get !== "function"
      || typeof value.setAutomaticDownload !== "function") {
    throw new TypeError("desktop update preferences are required");
  }
  return value;
}

function assertUpdater(value) {
  // electron-updater exports an EventEmitter-derived instance, not a plain
  // object. Keep the contract narrow without rejecting the real adapter.
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || typeof value.checkForUpdates !== "function"
      || typeof value.downloadUpdate !== "function"
      || typeof value.quitAndInstall !== "function"
      || typeof value.on !== "function") {
    throw new TypeError("electron updater is required");
  }
  return value;
}

function safePercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function statusSnapshot({
  state,
  automaticDownload,
  automaticDownloadAvailable,
  progress,
  error,
} = {}) {
  const selectedState = UPDATE_STATES.has(state) ? state : "unavailable";
  const selectedError = UPDATE_ERRORS.has(error) ? error : "unavailable";
  const canCheck = selectedState === "ready" || selectedState === "available"
    || selectedState === "current" || selectedState === "error";
  return Object.freeze({
    automaticDownload: automaticDownload === true,
    automaticDownloadAvailable: automaticDownloadAvailable === true,
    canCheck,
    canDownload: selectedState === "available",
    canInstall: selectedState === "downloaded",
    error: selectedError,
    progress: safePercent(progress),
    state: selectedState,
  });
}

function updaterUnavailableStatus() {
  return statusSnapshot({
    state: "unavailable",
    automaticDownload: false,
    automaticDownloadAvailable: false,
    progress: null,
    error: "unavailable",
  });
}

function invokeListener(listener, status) {
  if (typeof listener !== "function") return;
  try {
    listener(status);
  } catch {
    // Status observers are presentation-only.  A consumer failure cannot
    // change updater behavior or expose an updater/library exception.
  }
}

function removeUpdaterListener(updater, event, listener) {
  try {
    if (typeof updater.off === "function") updater.off(event, listener);
    else updater.removeListener?.(event, listener);
  } catch {
    // Disposal is best effort; no updater operation is retried from cleanup.
  }
}

function unrefTimer(timer) {
  try {
    timer?.unref?.();
  } catch {
    // A timer is only an opportunistic background check. Failing to unref it
    // must not disable manual update actions.
  }
  return timer;
}

/**
 * Wrap electron-updater with the product's narrow lifecycle contract.
 *
 * electron-builder writes the generic-provider app-update.yml into a packaged
 * app from the matching target-specific builder config.  The official updater
 * integration deliberately owns that feed configuration, so this wrapper does
 * not call setFeedURL or accept renderer-provided endpoints.
 */
export function createProductionDesktopUpdater({
  app,
  autoUpdater,
  distributionMetadata,
  platform = process.platform,
  architecture = process.arch,
  preferences,
  prepareForUpdate = async () => {},
  cancelPreparedUpdate = async () => {},
  onStatus,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (app === null || typeof app !== "object" || typeof app.isPackaged !== "boolean") {
    throw new TypeError("Electron app is required");
  }
  if (typeof prepareForUpdate !== "function") {
    throw new TypeError("prepareForUpdate is required");
  }
  if (typeof cancelPreparedUpdate !== "function") {
    throw new TypeError("cancelPreparedUpdate is required");
  }
  if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
    throw new TypeError("desktop updater timers are required");
  }
  const preferenceStore = assertPreferences(preferences);
  const target = targetFor(platform, architecture);
  const packaged = app.isPackaged === true;
  let updater = null;
  let metadata = null;
  if (packaged) {
    if (target === null) throw new TypeError("production updater target is unsupported");
    metadata = validateProductionDistributionMetadata(distributionMetadata, {
      platform,
      architecture,
    });
    updater = assertUpdater(autoUpdater);
  }
  const handoverRehearsal = metadata?.channel
    === PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL;
  // The current candidate may consume only the named next candidate. The
  // second candidate closes the exercise: it never treats a later feed entry
  // as an update. Metadata validation above establishes the exact pair.
  const permittedRehearsalUpdateVersion = handoverRehearsal
      && metadata.semanticVersion === metadata.rehearsalCurrentVersion
    ? metadata.rehearsalNextVersion
    : null;

  let disposed = false;
  let started = false;
  let activeOperation = null;
  let initialCheckCancelled = false;
  let initialCheckScheduled = false;
  let periodicCheckTimer = null;
  let preparedForInstall = false;
  let installFailureRequested = false;
  let installationRecovery = null;
  let rehearsalUpdateAvailable = false;
  let status = updaterUnavailableStatus();
  const listeners = [];

  function publish(next) {
    status = statusSnapshot({
      automaticDownload: next.automaticDownload,
      automaticDownloadAvailable: next.automaticDownloadAvailable,
      error: next.error,
      progress: next.progress,
      state: next.state,
    });
    invokeListener(onStatus, status);
    return status;
  }

  function publishWith({
    state = status.state,
    automaticDownload = status.automaticDownload,
    automaticDownloadAvailable = status.automaticDownloadAvailable,
    progress = status.progress,
    error = status.error,
  } = {}) {
    return publish({ state, automaticDownload, automaticDownloadAvailable, progress, error });
  }

  function installEventHandlers() {
    const on = (event, listener) => {
      updater.on(event, listener);
      listeners.push([event, listener]);
    };
    on("checking-for-update", () => {
      if (!disposed) {
        rehearsalUpdateAvailable = false;
        publishWith({ state: "checking", progress: null, error: "none" });
      }
    });
    on("update-available", (updateInfo) => {
      if (disposed) return;
      if (handoverRehearsal
          && (permittedRehearsalUpdateVersion === null
            || updateInfo?.version !== permittedRehearsalUpdateVersion)) {
        // AppUpdater begins automatic downloads before this event returns.
        // Rehearsal startup therefore always sets autoDownload false, and this
        // guard makes the validated current-to-next edge the sole manual path.
        rehearsalUpdateAvailable = false;
        publishWith({ state: "error", progress: null, error: "check_failed" });
        return;
      }
      rehearsalUpdateAvailable = handoverRehearsal;
      publishWith({ state: "available", progress: null, error: "none" });
    });
    on("update-not-available", () => {
      if (!disposed) {
        rehearsalUpdateAvailable = false;
        publishWith({ state: "current", progress: null, error: "none" });
      }
    });
    on("download-progress", (progress) => {
      if (!disposed && (!handoverRehearsal || rehearsalUpdateAvailable)) publishWith({
        state: "downloading",
        progress: safePercent(progress?.percent),
        error: "none",
      });
    });
    on("update-downloaded", () => {
      if (!disposed && (!handoverRehearsal || rehearsalUpdateAvailable)) {
        publishWith({ state: "downloaded", progress: 100, error: "none" });
      }
    });
    on("error", () => {
      if (disposed) return;
      if (status.state === "installing") {
        // electron-updater's platform adapters can emit a later error after
        // quitAndInstall() has already returned. Keep the visible shell
        // gated until the lifecycle has restored its owned companion.
        installFailureRequested = true;
        void recoverFailedInstallation();
        return;
      }
      const error = status.state === "downloading" || status.state === "available"
        ? "download_failed"
        : "check_failed";
      publishWith({ state: "error", progress: null, error });
    });
  }

  async function start() {
    if (disposed) fail("disposed");
    if (started) return status;
    started = true;
    if (!packaged) return status;

    let saved;
    try {
      saved = await preferenceStore.get();
    } catch {
      saved = { automaticDownload: false, available: false };
    }
    // AppUpdater starts its automatic download before update-available
    // listeners can reject an unexpected feed entry. The closed rehearsal
    // therefore has no automatic path; the user may explicitly download only
    // after the exact metadata-bound next version was observed.
    const automaticDownloadAvailable = !handoverRehearsal && saved?.available === true;
    const automaticDownload = automaticDownloadAvailable
      && saved.automaticDownload === true;
    try {
      // Never delegate quit-time installation to electron-updater. A human
      // action reaches installAndRestart(), which first stops our child.
      updater.autoDownload = automaticDownload;
      updater.autoInstallOnAppQuit = false;
      // Generic feeds remain fixed by electron-builder. The isolated handover
      // lane deliberately uses an ordered prerelease pair, so preserve the
      // updater library's prerelease mode only for that closed metadata shape.
      updater.allowPrerelease = metadata?.channel
        === PRODUCTION_ELECTRON_NATIVE_TO_ELECTRON_HANDOVER_REHEARSAL_CHANNEL;
      updater.allowDowngrade = false;
      installEventHandlers();
    } catch {
      return publish({
        state: "error",
        automaticDownload: false,
        automaticDownloadAvailable,
        progress: null,
        error: "configuration_failed",
      });
    }
    const startedStatus = publish({
      state: "ready",
      automaticDownload,
      automaticDownloadAvailable,
      progress: null,
      error: automaticDownloadAvailable || handoverRehearsal ? "none" : "preferences_unavailable",
    });
    scheduleInitialCheck();
    schedulePeriodicChecks();
    return startedStatus;
  }

  function scheduleInitialCheck() {
    if (initialCheckScheduled || disposed || !packaged) return;
    initialCheckScheduled = true;
    // A packaged-only startup check gives the persisted automatic-download
    // preference an immediate bounded effect. Recurring checks are scheduled
    // separately and only run while no updater action owns the adapter.
    queueMicrotask(() => {
      if (disposed || initialCheckCancelled) return;
      void checkForUpdates({ initial: true }).catch(() => {});
    });
  }

  function schedulePeriodicChecks() {
    if (periodicCheckTimer !== null || disposed || !packaged) return;
    try {
      periodicCheckTimer = unrefTimer(setIntervalImpl(() => {
        if (disposed || activeOperation !== null || !status.canCheck) return;
        void checkForUpdates({ periodic: true }).catch(() => {});
      }, PRODUCTION_ELECTRON_UPDATE_CHECK_INTERVAL_MS));
    } catch {
      // Manual checks remain available if an embedding host cannot create an
      // opportunistic background timer.
      periodicCheckTimer = null;
    }
  }

  function clearPeriodicChecks() {
    if (periodicCheckTimer === null) return;
    const timer = periodicCheckTimer;
    periodicCheckTimer = null;
    try {
      clearIntervalImpl(timer);
    } catch {
      // Disposal continues even if a non-standard embedded timer rejects.
    }
  }

  async function requireStarted() {
    if (disposed) fail("disposed");
    await start();
    if (!packaged || status.state === "unavailable") fail("unavailable");
    return status;
  }

  async function runOperation(name, run) {
    if (activeOperation !== null) fail("busy");
    const operation = (async () => {
      try {
        return await run();
      } finally {
        activeOperation = null;
      }
    })();
    activeOperation = operation;
    return operation;
  }

  async function checkForUpdates({ initial = false, periodic = false } = {}) {
    if (!initial && !periodic) initialCheckCancelled = true;
    await requireStarted();
    // The queued startup check may already have entered its asynchronous
    // readiness boundary when a user selects an available update. Recheck the
    // cancellation gate before it contacts the feed so an explicit action
    // keeps the state the user saw.
    if (initial && initialCheckCancelled) return status;
    if (!status.canCheck) fail("busy");
    return runOperation("check", async () => {
      publishWith({ state: "checking", progress: null, error: "none" });
      try {
        const result = await updater.checkForUpdates();
        if (status.state === "checking"
            && (result === null || result?.updateInfo === null)) {
          // electron-updater emits update-available/update-not-available for
          // normal results. Only its explicit null result can safely settle a
          // listener-free check as current; inferring availability from an
          // opaque result would be unsafe.
          publishWith({ state: "current", progress: null, error: "none" });
        }
        return status;
      } catch {
        return publishWith({ state: "error", progress: null, error: "check_failed" });
      }
    });
  }

  async function downloadUpdate() {
    // A user who has already been shown an available update should not lose
    // that state to the queued one-shot startup check before this action gets
    // past its asynchronous readiness boundary.
    initialCheckCancelled = true;
    await requireStarted();
    if (status.state !== "available"
        || (handoverRehearsal && !rehearsalUpdateAvailable)) {
      fail("download_unavailable");
    }
    return runOperation("download", async () => {
      publishWith({ state: "downloading", progress: 0, error: "none" });
      try {
        await updater.downloadUpdate();
        if (status.state === "downloading") {
          publishWith({ state: "downloaded", progress: 100, error: "none" });
        }
        return status;
      } catch {
        return publishWith({ state: "error", progress: null, error: "download_failed" });
      }
    });
  }

  async function setAutomaticDownload(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("automaticDownload is invalid");
    await requireStarted();
    if (handoverRehearsal) fail("preferences_unavailable");
    if (!status.automaticDownloadAvailable) fail("preferences_unavailable");
    try {
      const saved = await preferenceStore.setAutomaticDownload(enabled);
      if (saved?.available !== true || saved.automaticDownload !== enabled) {
        return publishWith({
          automaticDownload: false,
          automaticDownloadAvailable: false,
          error: "preferences_unavailable",
        });
      }
      updater.autoDownload = enabled;
      return publishWith({ automaticDownload: enabled, error: "none" });
    } catch {
      fail("preferences_unavailable");
    }
  }

  async function recoverFailedInstallation() {
    if (installationRecovery !== null) return installationRecovery;
    if (!preparedForInstall) return status;
    preparedForInstall = false;
    const recovery = (async () => {
      try {
        await cancelPreparedUpdate();
      } catch {
        // The lifecycle's recovery hook is deliberately best effort. It is
        // still called once so an already-stopped companion can restart.
      }
      if (!disposed) {
        publishWith({ state: "error", progress: null, error: "install_failed" });
      }
      return status;
    })();
    installationRecovery = recovery;
    try {
      return await recovery;
    } finally {
      if (installationRecovery === recovery) installationRecovery = null;
    }
  }

  async function installAndRestart() {
    initialCheckCancelled = true;
    await requireStarted();
    if (status.state !== "downloaded") fail("install_unavailable");
    return runOperation("install", async () => {
      publishWith({ state: "installing", progress: 100, error: "none" });
      preparedForInstall = false;
      installFailureRequested = false;
      try {
        await prepareForUpdate();
      } catch {
        return publishWith({ state: "error", progress: null, error: "shutdown_failed" });
      }
      preparedForInstall = true;
      if (installFailureRequested) return recoverFailedInstallation();
      try {
        // electron-updater owns the native installer hand-off. Do not call
        // app.quit here: its quit path is intentionally sequenced by the
        // updater after the owned companion has stopped.
        await updater.quitAndInstall(false, true);
        return installFailureRequested ? recoverFailedInstallation() : status;
      } catch {
        installFailureRequested = true;
        return recoverFailedInstallation();
      }
    });
  }

  function getStatus() {
    return status;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    initialCheckCancelled = true;
    clearPeriodicChecks();
    for (const [event, listener] of listeners.splice(0)) {
      removeUpdaterListener(updater, event, listener);
    }
    if (packaged) publish({
      state: "unavailable",
      automaticDownload: false,
      automaticDownloadAvailable: false,
      progress: null,
      error: "unavailable",
    });
  }

  void target;
  void metadata;
  return Object.freeze({
    checkForUpdates,
    dispose,
    downloadUpdate,
    getStatus,
    installAndRestart,
    setAutomaticDownload,
    start,
  });
}
