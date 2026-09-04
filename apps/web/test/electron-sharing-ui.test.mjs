import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { normalizeElectronSharingPreference } from "../public/electron-settings.js";

const APP_SOURCE_URL = new URL("../public/app.js", import.meta.url);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `production source defines ${name}`);
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`production source closes ${name}`);
}

function validProjection(overrides = {}) {
  return {
    available: true,
    current: true,
    enabled: false,
    state: "pending_notices",
    basis: "default_off",
    noticeCount: 0,
    nextNoticeIndex: 1,
    noticeDue: true,
    nextNoticeAt: "2026-09-04T00:00:00.000Z",
    earliestActivationAt: "2026-09-11T00:00:00.000Z",
    transportStatus: "unavailable",
    ...overrides,
  };
}

test("Electron sharing projection is bounded and fail-closed", () => {
  const pending = normalizeElectronSharingPreference(validProjection());
  assert.deepEqual(Object.keys(pending), [
    "available", "current", "enabled", "state", "basis", "noticeCount",
    "nextNoticeIndex", "noticeDue", "nextNoticeAt", "earliestActivationAt",
    "transportStatus",
  ]);
  assert.equal(pending.enabled, false);
  assert.equal(pending.transportStatus, "unavailable");

  const enabled = normalizeElectronSharingPreference(validProjection({
    enabled: true,
    state: "enabled",
    basis: "default_on",
    noticeDue: false,
    nextNoticeIndex: null,
    nextNoticeAt: null,
    earliestActivationAt: null,
  }));
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.transportStatus, "unavailable");
  assert.equal(
    normalizeElectronSharingPreference(validProjection({ nextNoticeAt: "not-a-date" })),
    null,
  );
  assert.equal(
    normalizeElectronSharingPreference(validProjection({ earliestActivationAt: "not-a-date" })),
    null,
  );
  assert.equal(
    normalizeElectronSharingPreference(validProjection({
      available: false,
      current: false,
      enabled: true,
      transportStatus: "unexpected",
    })).enabled,
    false,
  );
});

test("Electron sharing UI uses the accountless bridge and visible receipt gate", async () => {
  const [appSource, indexHtml, settingsHtml, settingsSource] = await Promise.all([
    readFile(APP_SOURCE_URL, "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.html", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.js", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /getSharingPreference\(\)/u);
  assert.match(appSource, /setSharingEnabled\(enabled\)/u);
  assert.match(appSource, /sharingNoticePresented\(index\)/u);
  assert.match(appSource, /document\.visibilityState === "visible"/u);
  assert.match(appSource, /electronSharingNoticeReceiptIndex = index/u);
  assert.match(appSource, /preference\.noticeCount === receiptIndex/u);
  assert.match(indexHtml, /id="electron-sharing-notice"/u);
  assert.match(indexHtml, /id="electron-sharing-share-now"/u);
  assert.match(indexHtml, /id="electron-sharing-keep-off"/u);
  assert.match(settingsHtml, /id="settings-sharing-enabled"/u);
  assert.match(settingsSource, /settingsSharingBridge\.getSharingPreference\(\)/u);
  assert.match(settingsSource, /settingsSharingBridge\.setSharingEnabled\(enabled\)/u);
});

test("a successful visible notice receipt keeps its current banner actionable", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const functions = [
    "validSharingTimestamp",
    "normalizeElectronSharingPreference",
    "electronSharingBridge",
    "electronSharingTransportMessageKey",
    "clearElectronSharingNoticeAckSchedule",
    "electronSharingSurfaceIsVisible",
    "scheduleElectronSharingNoticeAck",
    "renderElectronSharingNotice",
  ].map((name) => extractFunction(source, name));
  const factory = new Function("bridge", "initialPreference", "initialVisibility", `
    const ELECTRON_SHARING_API_VERSION = "v1";
    const ELECTRON_SHARING_BASES = new Set([
      "default_on", "default_off", "migration_default_on", "user_choice", "legacy_preserved",
    ]);
    const ELECTRON_SHARING_STATES = new Set([
      "pending_notices", "enabled", "disabled", "legacy_preserved",
    ]);
    const ELECTRON_SHARING_TRANSPORT_STATUSES = new Set(["unavailable", "off"]);
    const frames = [];
    const documentListeners = new Map();
    const windowListeners = new Map();
    const elements = new Map();
    const makeElement = () => ({
      hidden: true,
      disabled: false,
      dataset: {},
      textContent: "",
      removeAttribute() {},
      classList: { toggle() {} },
    });
    const selectors = [
      "#electron-sharing-notice",
      "#electron-sharing-notice-copy",
      "#electron-sharing-notice-earliest",
      "#electron-sharing-notice-transport",
      "#electron-sharing-share-now",
      "#electron-sharing-keep-off",
      "#electron-sharing-notice-status",
    ];
    for (const selector of selectors) elements.set(selector, makeElement());
    const $ = (selector) => elements.get(selector) ?? null;
    const document = {
      visibilityState: initialVisibility,
      documentElement: { dataset: { localDashboardReady: "true" } },
      addEventListener(type, listener) {
        const values = documentListeners.get(type) ?? [];
        values.push(listener);
        documentListeners.set(type, values);
      },
      removeEventListener(type, listener) {
        documentListeners.set(type, (documentListeners.get(type) ?? []).filter((value) => value !== listener));
      },
    };
    const window = {
      tibotattleDesktop: bridge,
      requestAnimationFrame(callback) { frames.push(callback); },
      addEventListener(type, listener) {
        const values = windowListeners.get(type) ?? [];
        values.push(listener);
        windowListeners.set(type, values);
      },
      removeEventListener(type, listener) {
        windowListeners.set(type, (windowListeners.get(type) ?? []).filter((value) => value !== listener));
      },
    };
    const globalThis = { window, setTimeout(callback) { frames.push(callback); } };
    let electronSharingPreference = initialPreference;
    let electronSharingBusy = false;
    const electronSharingNoticeAcked = new Set();
    let electronSharingNoticeReceiptIndex = null;
    let electronSharingNoticeAckScheduled = null;
    let electronSharingNoticeAckCleanup = null;
    let electronSharingNoticeAckError = false;
    const dashboard = { marker: "synthetic" };
    const formatLocal = (value) => value.slice(0, 10);
    const setLocalizedText = (element, key, values = {}) => {
      if (element) element.textContent = key + JSON.stringify(values);
    };
    ${functions.join("\n")}
    return {
      renderElectronSharingNotice,
      notice: $("#electron-sharing-notice"),
      async drainFrames() {
        while (frames.length > 0) {
          const frame = frames.shift();
          await frame();
          await Promise.resolve();
        }
      },
      preference: () => electronSharingPreference,
      receiptIndex: () => electronSharingNoticeReceiptIndex,
      show() {
        document.visibilityState = "visible";
        for (const listener of documentListeners.get("visibilitychange") ?? []) listener();
      },
    };
  `);
  const initial = validProjection();
  const calls = [];
  const bridge = {
    version: "v1",
    getSharingPreference: async () => initial,
    setSharingEnabled: async () => initial,
    sharingNoticePresented: async (index) => {
      calls.push(index);
      return validProjection({
        noticeCount: 1,
        nextNoticeIndex: 2,
        noticeDue: false,
        nextNoticeAt: "2026-09-07T00:00:00.000Z",
      });
    },
  };
  const harness = factory(bridge, initial, "hidden");
  harness.renderElectronSharingNotice();
  await harness.drainFrames();
  assert.deepEqual(calls, [], "hidden renderer execution does not count a notice");
  assert.equal(harness.receiptIndex(), null);
  harness.show();
  await harness.drainFrames();
  assert.deepEqual(calls, [1]);
  assert.equal(harness.receiptIndex(), 1);
  assert.equal(harness.preference().noticeCount, 1);
  assert.equal(harness.notice.hidden, false);
  assert.equal(harness.notice.dataset.noticeIndex, "1");
});
