import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createProductionDesktopUpdater,
  createProductionDistributionMetadata,
  DesktopUpdaterError,
  PRODUCTION_ELECTRON_UPDATE_CHECK_INTERVAL_MS,
  productionUpdateFeedForTarget,
} from "../desktop-updater.js";

const SOURCE_REVISION = "a".repeat(40);

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function metadata(target = "darwin-arm64") {
  return createProductionDistributionMetadata({
    buildNumber: "20260906",
    sourceRevision: SOURCE_REVISION,
    target,
  });
}

function preferences({ automaticDownload = true, available = true } = {}) {
  return {
    async get() {
      return { automaticDownload, available };
    },
    async setAutomaticDownload(value) {
      if (!available) throw new Error("unavailable");
      automaticDownload = value;
      return { automaticDownload, available };
    },
  };
}

class FakeElectronUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = null;
    this.autoInstallOnAppQuit = null;
    this.allowPrerelease = null;
    this.allowDowngrade = null;
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
    this.quitAndInstallResult = undefined;
  }

  async checkForUpdates() {
    this.checks += 1;
    this.emit("update-not-available", { version: "0.1.18" });
    return { updateInfo: null };
  }

  async downloadUpdate() {
    this.downloads += 1;
    this.emit("update-downloaded", { version: "0.1.19" });
    return [];
  }

  quitAndInstall(...args) {
    this.installs += 1;
    this.quitAndInstallArgs = args;
    return this.onQuitAndInstall?.() ?? this.quitAndInstallResult;
  }
}

function packagedUpdater({
  autoUpdater = new FakeElectronUpdater(),
  automaticDownload = true,
  prepareForUpdate,
  cancelPreparedUpdate,
  setIntervalImpl,
  clearIntervalImpl,
} = {}) {
  const app = { isPackaged: true, quitCalls: 0, quit() { this.quitCalls += 1; } };
  return {
    app,
    autoUpdater,
    updater: createProductionDesktopUpdater({
      app,
      autoUpdater,
      distributionMetadata: metadata(),
      platform: "darwin",
      architecture: "arm64",
      preferences: preferences({ automaticDownload }),
      prepareForUpdate,
      cancelPreparedUpdate,
      setIntervalImpl,
      clearIntervalImpl,
    }),
  };
}

test("production updater has fixed target feeds and refuses malformed candidate metadata", () => {
  assert.equal(
    productionUpdateFeedForTarget({ platform: "darwin", architecture: "arm64" }),
    "https://updates.tibotattle.com/electron/stable/darwin-arm64",
  );
  assert.equal(productionUpdateFeedForTarget({ platform: "darwin", architecture: "ia32" }), null);
  assert.throws(() => createProductionDistributionMetadata({
    buildNumber: "0", sourceRevision: SOURCE_REVISION, target: "darwin-arm64",
  }), /invalid/u);
  assert.throws(() => createProductionDistributionMetadata({
    buildNumber: "20260906", sourceRevision: SOURCE_REVISION, target: "darwin-arm64",
    channel: "preview",
  }), /invalid/u);
});

test("development updater is unavailable and never loads or checks an update feed", async () => {
  const updater = createProductionDesktopUpdater({
    app: { isPackaged: false },
    preferences: preferences(),
  });
  assert.deepEqual(await updater.start(), {
    automaticDownload: false,
    automaticDownloadAvailable: false,
    canCheck: false,
    canDownload: false,
    canInstall: false,
    error: "unavailable",
    progress: null,
    state: "unavailable",
  });
  await assert.rejects(
    updater.checkForUpdates(),
    (error) => error instanceof DesktopUpdaterError && error.code === "desktop_updater_unavailable",
  );
});

test("packaged updater configures the real EventEmitter adapter and performs one bounded startup check", async () => {
  const { autoUpdater, updater } = packagedUpdater({ automaticDownload: false });
  assert.equal((await updater.start()).state, "ready");
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(autoUpdater.allowPrerelease, false);
  assert.equal(autoUpdater.allowDowngrade, false);
  assert.equal(typeof autoUpdater.setFeedURL, "undefined");
  await nextTurn();
  assert.equal(autoUpdater.checks, 1);
  assert.deepEqual(updater.getStatus(), {
    automaticDownload: false,
    automaticDownloadAvailable: true,
    canCheck: true,
    canDownload: false,
    canInstall: false,
    error: "none",
    progress: null,
    state: "current",
  });
});

test("packaged updater repeats bounded checks only while idle and clears its fixed timer", async () => {
  const timers = [];
  const cleared = [];
  const { autoUpdater, updater } = packagedUpdater({
    setIntervalImpl(callback, milliseconds) {
      const timer = {
        callback,
        milliseconds,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
          return this;
        },
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) {
      cleared.push(timer);
    },
  });
  await updater.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, PRODUCTION_ELECTRON_UPDATE_CHECK_INTERVAL_MS);
  assert.equal(timers[0].unrefCalls, 1);
  await nextTurn();
  assert.equal(autoUpdater.checks, 1);

  let settleCheck;
  autoUpdater.checkForUpdates = () => {
    autoUpdater.checks += 1;
    return new Promise((resolve) => { settleCheck = resolve; });
  };
  timers[0].callback();
  await nextTurn();
  assert.equal(autoUpdater.checks, 2);
  assert.equal(updater.getStatus().state, "checking");
  timers[0].callback();
  await nextTurn();
  assert.equal(autoUpdater.checks, 2, "a periodic tick cannot overlap an active check");

  settleCheck({ updateInfo: null });
  await nextTurn();
  assert.equal(updater.getStatus().state, "current");
  autoUpdater.emit("download-progress", { percent: 40 });
  timers[0].callback();
  await nextTurn();
  assert.equal(autoUpdater.checks, 2, "a periodic tick cannot interrupt a download");

  updater.dispose();
  assert.deepEqual(cleared, [timers[0]]);
  timers[0].callback();
  await nextTurn();
  assert.equal(autoUpdater.checks, 2, "disposed updater never contacts the feed");
});

test("packaged updater exposes explicit download and persisted automatic preference operations", async () => {
  const { autoUpdater, updater } = packagedUpdater();
  await updater.start();
  autoUpdater.emit("update-available", { version: "0.1.19" });
  assert.equal(updater.getStatus().canDownload, true);
  await updater.downloadUpdate();
  assert.equal(autoUpdater.downloads, 1);
  assert.equal(updater.getStatus().state, "downloaded");
  await updater.setAutomaticDownload(false);
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(updater.getStatus().automaticDownload, false);
});

test("installation stops the owned companion before electron-updater restarts and recovers after a handoff failure", async () => {
  const order = [];
  const { app, autoUpdater, updater } = packagedUpdater({
    prepareForUpdate: async () => order.push("prepare"),
    cancelPreparedUpdate: async () => order.push("cancel"),
  });
  await updater.start();
  autoUpdater.emit("update-downloaded", { version: "0.1.19" });
  await updater.installAndRestart();
  assert.deepEqual(order, ["prepare"]);
  assert.deepEqual(autoUpdater.quitAndInstallArgs, [false, true]);
  assert.equal(app.quitCalls, 0);

  const failed = packagedUpdater({
    prepareForUpdate: async () => order.push("failed-prepare"),
    cancelPreparedUpdate: async () => order.push("failed-cancel"),
  });
  failed.autoUpdater.onQuitAndInstall = () => {
    failed.autoUpdater.emit("error", new Error("installer failed"));
    throw new Error("installer failed");
  };
  await failed.updater.start();
  failed.autoUpdater.emit("update-downloaded", { version: "0.1.19" });
  const status = await failed.updater.installAndRestart();
  assert.equal(status.state, "error");
  assert.equal(status.error, "install_failed");
  assert.deepEqual(order, ["prepare", "failed-prepare", "failed-cancel"]);
  assert.equal(failed.app.quitCalls, 0);
});

test("a late native installer error restores a prepared companion exactly once", async () => {
  const order = [];
  let releaseCancel;
  const { app, autoUpdater, updater } = packagedUpdater({
    prepareForUpdate: async () => order.push("prepare"),
    cancelPreparedUpdate: async () => {
      order.push("cancel");
      await new Promise((resolve) => { releaseCancel = resolve; });
    },
  });
  await updater.start();
  autoUpdater.emit("update-downloaded", { version: "0.1.19" });
  const handoff = await updater.installAndRestart();
  assert.equal(handoff.state, "installing");
  assert.equal(autoUpdater.installs, 1);
  assert.equal(app.quitCalls, 0);

  // BaseUpdater.quitAndInstall() returns void, while platform adapters can
  // emit their installer error later. Repeated events must share one recovery.
  autoUpdater.emit("error", new Error("installer launch failed"));
  autoUpdater.emit("error", new Error("installer launch failed again"));
  assert.deepEqual(order, ["prepare", "cancel"]);
  releaseCancel();
  await nextTurn();
  assert.equal(updater.getStatus().state, "error");
  assert.equal(updater.getStatus().error, "install_failed");
  assert.deepEqual(order, ["prepare", "cancel"]);
  assert.equal(app.quitCalls, 0);
});
