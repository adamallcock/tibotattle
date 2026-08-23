import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  LOCAL_COMPANION_STATIC_FILES,
} from "../../local/static-assets.js";
import {
  SUPPORTED_LOCALES,
  WEB_MESSAGES,
  translate,
} from "../public/localization.js";
import {
  DESKTOP_SETTINGS_API_VERSION,
  SETTINGS_ACTION_NAMES,
  SETTINGS_EXTERNAL_TARGETS,
  SETTINGS_LANGUAGE_VALUES,
  SETTINGS_NOTIFICATION_THRESHOLD_VALUES,
  SETTINGS_REFRESH_INTERVAL_VALUES,
  mountSettingsPage,
} from "../public/electron-settings.js";
import { mountDesktopShell } from "../public/desktop-shell.js";

const readPublic = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

class FakeClassList {
  #values = new Set();

  add(value) { this.#values.add(value); }
  remove(value) { this.#values.delete(value); }
  contains(value) { return this.#values.has(value); }
  toggle(value, force) {
    const next = force === undefined ? !this.#values.has(value) : force;
    if (next) this.#values.add(value);
    else this.#values.delete(value);
    return next;
  }
}

class FakeElement {
  constructor({ id = "", dataset = {}, value = "" } = {}) {
    this.id = id;
    this.dataset = { ...dataset };
    this.value = value;
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.tabIndex = 0;
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.focusCalls = [];
    this.scrollCalls = [];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  dispatch(type, details = {}) {
    const listener = this.listeners.get(type);
    if (!listener) return {};
    let prevented = false;
    listener({
      ...details,
      currentTarget: this,
      target: this,
      preventDefault() { prevented = true; },
    });
    return { prevented };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus(options) { this.focusCalls.push(options); }
  scrollIntoView(options) { this.scrollCalls.push(options); }
  dispatchEvent(event) {
    return this.dispatch(event.type, event);
  }
  click() {
    return this.dispatch("click");
  }
}

function makeSettingsDocument({ electron = false } = {}) {
  const byId = new Map();
  const make = (id, options = {}) => {
    const element = new FakeElement({ id, ...options });
    byId.set(id, element);
    return element;
  };
  make("settings-bridge-status");
  make("settings-language", { value: "system" });
  make("settings-codex-folder-status");
  make("settings-refresh-interval", { value: "300" });
  make("settings-start-at-login");
  make("settings-start-at-login-summary");
  make("settings-notifications-enabled");
  make("settings-notification-status");
  make("settings-automatic-updates");
  make("settings-check-for-updates");
  make("settings-updates-status");
  make("settings-version");
  make("settings-build");
  make("settings-operation-status");
  make("settings-choose-codex-folder");
  make("settings-use-default-codex-folder");
  make("settings-open-login-items");
  make("settings-refresh-login-status");
  make("settings-open-notification-settings");
  const languagePicker = make("dashboard-language-picker", {
    dataset: { languagePicker: "true" },
    value: "system",
  });
  const refreshButton = make("refresh-button");
  for (const [id, tab] of [
    ["settings-tab-general", "general"],
    ["settings-tab-notifications", "notifications"],
    ["settings-tab-about", "about"],
  ]) make(id, { dataset: { settingsTab: tab } });
  for (const panel of ["general", "notifications", "about"]) {
    make(`settings-panel-${panel}`, { dataset: { settingsPanel: panel } });
  }
  const thresholds = ["off", "ninety", "eighty_and_ninety"].map((value) => (
    new FakeElement({ value })
  ));
  const links = ["website", "github", "x"].map((target) => (
    new FakeElement({ dataset: { externalTarget: target } })
  ));
  const shareButton = make("electron-share-button");
  const settingsButton = make("electron-settings-button");
  const sharePanel = make("share-panel");
  const documentRef = {
    documentElement: { classList: new FakeClassList() },
    body: { classList: new FakeClassList() },
    querySelector(selector) {
      if (selector.startsWith("#")) return byId.get(selector.slice(1)) ?? null;
      if (selector === "[data-settings-tab]") return [...byId.values()].filter((item) => item.dataset.settingsTab);
      if (selector === "[data-settings-panel]") return [...byId.values()].filter((item) => item.dataset.settingsPanel);
      if (selector === "[data-external-target]") return links;
      if (selector === "[data-language-picker]") return languagePicker;
      if (selector === "input[name=\"settings-notification-threshold\"]") return thresholds;
      return null;
    },
    querySelectorAll(selector) {
      return this.querySelector(selector) ?? [];
    },
    byId,
    thresholds,
    links,
    shareButton,
    settingsButton,
    sharePanel,
    languagePicker,
    refreshButton,
  };
  if (electron) {
    documentRef.documentElement.classList.add("electron-dashboard");
  }
  return documentRef;
}

function settingsState(overrides = {}) {
  return {
    version: "0.1.16",
    build: "2826517",
    language: "en",
    refreshIntervalSeconds: 300,
    codexFolder: { kind: "default" },
    startAtLogin: { status: "disabled", canSet: true },
    notifications: {
      enabled: true,
      threshold: "ninety",
      canSet: true,
      state: "ready",
      delivery: "ready",
      lastOutcome: "initialized",
      lastReason: "none",
      lastDelivery: "not_attempted",
      permission: "authorized",
      detail: "Local allowance alerts are ready.",
    },
    about: {
      version: "0.1.16",
      build: "2826517",
      update: { status: "unavailable", canCheck: false },
    },
    ...overrides,
  };
}

function bridgeFixture(calls, state = settingsState(), commandSlot = null) {
  const result = async (name, value) => {
    calls.push(value === undefined ? [name] : [name, value]);
    return state;
  };
  return Object.freeze({
    version: DESKTOP_SETTINGS_API_VERSION,
    getSettings: async () => state,
    onCommand: (callback) => {
      if (commandSlot) commandSlot.callback = callback;
      return () => {
        if (commandSlot) commandSlot.unsubscribed = true;
      };
    },
    openSettings: async () => result("openSettings"),
    chooseCodexHome: async (...args) => {
      assert.equal(args.length, 0);
      return result("chooseCodexHome");
    },
    useDefaultCodexHome: async (...args) => {
      assert.equal(args.length, 0);
      return result("useDefaultCodexHome");
    },
    setLanguage: async (value) => result("setLanguage", value),
    setRefreshInterval: async (value) => result("setRefreshInterval", value),
    setStartAtLogin: async (value) => result("setStartAtLogin", value),
    setNotificationPreferences: async (value) => result("setNotificationPreferences", value),
    openSystemSettings: async (value) => result("openSystemSettings", value),
    openExternal: async (value) => result("openExternal", value),
    checkForUpdates: async (...args) => {
      assert.equal(args.length, 0);
      return result("checkForUpdates");
    },
  });
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("settings assets expose the exact v1 bridge, finite values, and fixed links", async () => {
  const html = await readPublic("electron-settings.html");
  const css = await readPublic("electron-settings.css");
  const source = await readPublic("electron-settings.js");

  for (const [route, file] of [
    ["/electron-settings.html", "electron-settings.html"],
    ["/electron-settings.js", "electron-settings.js"],
    ["/electron-settings.css", "electron-settings.css"],
    ["/desktop-shell.js", "desktop-shell.js"],
  ]) assert.equal(LOCAL_COMPANION_STATIC_FILES[route].file, file);
  assert.match(html, /role="tablist"/u);
  assert.match(html, /id="settings-panel-general"/u);
  assert.match(html, /id="settings-panel-notifications"/u);
  assert.match(html, /id="settings-panel-about"/u);
  assert.match(html, /value="zh-Hans"/u);
  assert.match(html, /value="eighty_and_ninety"/u);
  assert.match(html, /data-i18n-root/u);
  assert.match(html, /role="switch"[^>]*disabled/u);
  assert.match(html, /name="settings-notification-threshold"[^>]*disabled/u);
  assert.match(html, /fresh provider-reported evidence/u);
  assert.doesNotMatch(html, /alert delivery is not implemented in this prototype/u);
  assert.match(css, /\.electron-settings-page/u);
  assert.match(css, /@media \(max-width: 760px\)/u);
  assert.deepEqual(SETTINGS_LANGUAGE_VALUES, ["system", "en", "zh-Hans", "es"]);
  assert.deepEqual(SETTINGS_REFRESH_INTERVAL_VALUES, [60, 300, 900, 1800]);
  assert.deepEqual(SETTINGS_NOTIFICATION_THRESHOLD_VALUES, ["off", "ninety", "eighty_and_ninety"]);
  assert.deepEqual(Object.keys(SETTINGS_EXTERNAL_TARGETS), ["website", "github", "x"]);
  assert.deepEqual(SETTINGS_ACTION_NAMES, [
    "getSettings",
    "openSettings",
    "setLanguage",
    "chooseCodexHome",
    "useDefaultCodexHome",
    "setRefreshInterval",
    "setStartAtLogin",
    "setNotificationPreferences",
    "openSystemSettings",
    "checkForUpdates",
    "openExternal",
  ]);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/u);
  assert.doesNotMatch(source, /window\.tibotattleDesktop\.actions/u);
});

test("Electron Settings catalog covers every semantic label in all supported locales", async () => {
  const html = await readPublic("electron-settings.html");
  const keys = [...html.matchAll(
    /data-i18n(?:-(?:aria-label|title|placeholder))?="([^"]+)"/gu,
  )].map(([, key]) => key);
  assert.ok(keys.length > 40);
  for (const key of new Set(keys)) {
    assert.ok(Object.hasOwn(WEB_MESSAGES, key), `missing catalog key ${key}`);
    const values = SUPPORTED_LOCALES.map((locale) => translate(key, {}, locale));
    assert.ok(values.every((value) => value.trim().length > 0), key);
    assert.ok(values.every((value) => value !== key), `${key} fell back to its key`);
  }
  for (const locale of SUPPORTED_LOCALES) {
    assert.doesNotMatch(translate("electron.settings.notifications.description", {}, locale), /not implemented|尚未实现|no está implementado/u);
    assert.match(translate("electron.settings.notifications.status.unavailable", {}, locale), /No alerts|不会发送|No se enviarán/u);
  }
});

test("settings bridge renders native-parity controls and supports keyboard tabs", async () => {
  const documentRef = makeSettingsDocument();
  const calls = [];
  const state = settingsState();
  const commandSlot = {};
  const bridge = bridgeFixture(calls, state, commandSlot);
  const mounted = await mountSettingsPage({
    documentRef,
    windowRef: { tibotattleDesktop: bridge },
    bridge,
  });

  assert.equal(documentRef.byId.get("settings-bridge-status").textContent, "Desktop settings connected");
  assert.equal(documentRef.byId.get("settings-language").value, "en");
  assert.equal(documentRef.byId.get("settings-refresh-interval").value, "300");
  assert.equal(
    documentRef.byId.get("settings-codex-folder-status").textContent,
    "Default location (~/.codex)",
  );
  assert.equal(documentRef.byId.get("settings-version").textContent, "Version 0.1.16");
  assert.equal(documentRef.byId.get("settings-build").textContent, "Build 2826517");
  assert.equal(documentRef.byId.get("settings-notifications-enabled").checked, true);
  assert.equal(documentRef.byId.get("settings-notifications-enabled").disabled, false);
  assert.equal(documentRef.thresholds[0].checked, false);
  assert.equal(documentRef.thresholds[1].checked, true);
  assert.equal(documentRef.thresholds.every((input) => input.disabled), false);

  const notificationsTab = documentRef.byId.get("settings-tab-notifications");
  notificationsTab.dispatch("click");
  assert.equal(notificationsTab.getAttribute("aria-selected"), "true");
  assert.equal(documentRef.byId.get("settings-panel-notifications").hidden, false);
  notificationsTab.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(documentRef.byId.get("settings-tab-about").focusCalls.length, 1);
  assert.equal(documentRef.byId.get("settings-tab-about").getAttribute("aria-selected"), "true");

  const language = documentRef.byId.get("settings-language");
  language.value = "es";
  language.dispatch("change");
  await settle();
  assert.deepEqual(calls.at(-1), ["setLanguage", "es"]);

  documentRef.byId.get("settings-refresh-interval").value = "900";
  documentRef.byId.get("settings-refresh-interval").dispatch("change");
  await settle();
  assert.deepEqual(calls.at(-1), ["setRefreshInterval", 900]);

  documentRef.byId.get("settings-open-login-items").dispatch("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["openSystemSettings", "startup"]);

  documentRef.byId.get("settings-choose-codex-folder").dispatch("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["chooseCodexHome"]);

  documentRef.byId.get("settings-use-default-codex-folder").dispatch("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["useDefaultCodexHome"]);

  documentRef.byId.get("settings-check-for-updates").dispatch("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["checkForUpdates"]);

  documentRef.byId.get("settings-notifications-enabled").checked = false;
  documentRef.byId.get("settings-notifications-enabled").dispatch("change");
  await settle();
  assert.deepEqual(calls.at(-1), ["setNotificationPreferences", { enabled: false, threshold: "off" }]);
  documentRef.thresholds[2].checked = true;
  documentRef.thresholds[2].dispatch("change");
  await settle();
  assert.deepEqual(calls.at(-1), ["setNotificationPreferences", { enabled: true, threshold: "eighty_and_ninety" }]);

  const githubLink = documentRef.links[1];
  const click = githubLink.dispatch("click");
  await settle();
  assert.equal(click.prevented, true);
  assert.deepEqual(calls.at(-1), ["openExternal", "github"]);

  state.language = "zh-Hans";
  commandSlot.callback({ command: "language", value: "zh-Hans" });
  await settle();
  assert.equal(documentRef.byId.get("settings-language").value, "zh-Hans");

  mounted.teardown();
  assert.equal(commandSlot.unsubscribed, true);
});

test("settings renders a truthful custom-folder state without exposing its path", async () => {
  const documentRef = makeSettingsDocument();
  const customPath = "/Users/adam/custom-codex";
  const bridge = bridgeFixture([], settingsState({
    codexFolder: { kind: "custom", displayPath: customPath },
  }));

  await mountSettingsPage({
    documentRef,
    windowRef: { tibotattleDesktop: bridge },
    bridge,
  });

  const status = documentRef.byId.get("settings-codex-folder-status");
  assert.equal(status.textContent, "Custom Codex folder");
  assert.doesNotMatch(status.textContent, /Users\/adam|custom-codex/u);
});

test("settings fail closed without the desktop bridge and reject unlisted values", async () => {
  const absent = makeSettingsDocument();
  await mountSettingsPage({ documentRef: absent, windowRef: {} });
  assert.match(absent.byId.get("settings-bridge-status").textContent, /unavailable/u);
  assert.equal(absent.byId.get("settings-start-at-login").disabled, true);
  assert.equal(absent.byId.get("settings-notifications-enabled").disabled, true);
  assert.equal(absent.byId.get("settings-check-for-updates").disabled, true);
  const absentLinkClick = absent.links[0].dispatch("click");
  assert.equal(absentLinkClick.prevented, true);

  const documentRef = makeSettingsDocument();
  const calls = [];
  const bridge = bridgeFixture(calls);
  await mountSettingsPage({ documentRef, windowRef: { tibotattleDesktop: bridge }, bridge });
  const language = documentRef.byId.get("settings-language");
  language.value = "fr";
  language.dispatch("change");
  await settle();
  assert.equal(calls.length, 0);
  assert.match(documentRef.byId.get("settings-operation-status").textContent, /not confirmed/u);
});

test("settings fail closed for unavailable or malformed notification capability snapshots", async () => {
  const unavailable = makeSettingsDocument();
  const unavailableBridge = bridgeFixture([], settingsState({
    notifications: {
      enabled: true,
      threshold: "ninety",
      canSet: true,
      state: "ready",
      delivery: "windows_identity_unavailable",
      lastOutcome: "notification",
      lastReason: "fresh",
      lastDelivery: "delivered",
      permission: "authorized",
      detail: "Windows identity unavailable",
    },
  }));
  await mountSettingsPage({ documentRef: unavailable, windowRef: { tibotattleDesktop: unavailableBridge }, bridge: unavailableBridge });
  assert.equal(unavailable.byId.get("settings-notifications-enabled").checked, false);
  assert.equal(unavailable.byId.get("settings-notifications-enabled").disabled, true);
  assert.equal(unavailable.thresholds.every((input) => input.disabled), true);

  const malformed = makeSettingsDocument();
  const malformedBridge = bridgeFixture([], settingsState({
    notifications: {
      enabled: "yes",
      threshold: "custom",
      canSet: true,
      state: "ready",
      delivery: "ready",
      lastOutcome: { arbitrary: true },
      lastReason: "custom",
      lastDelivery: "custom",
      permission: "authorized",
    },
  }));
  await mountSettingsPage({ documentRef: malformed, windowRef: { tibotattleDesktop: malformedBridge }, bridge: malformedBridge });
  assert.equal(malformed.byId.get("settings-notifications-enabled").checked, false);
  assert.equal(malformed.byId.get("settings-notifications-enabled").disabled, true);
  assert.equal(malformed.thresholds[0].checked, true);
});

test("settings opens the bounded tab named by its hash and falls back to General", async () => {
  const aboutDocument = makeSettingsDocument();
  const bridge = bridgeFixture([]);
  await mountSettingsPage({
    documentRef: aboutDocument,
    windowRef: { location: { hash: "#about" }, tibotattleDesktop: bridge },
    bridge,
  });
  assert.equal(aboutDocument.byId.get("settings-panel-about").hidden, false);
  assert.equal(aboutDocument.byId.get("settings-panel-general").hidden, true);

  const fallbackDocument = makeSettingsDocument();
  await mountSettingsPage({
    documentRef: fallbackDocument,
    windowRef: { location: { hash: "#not-a-settings-tab" }, tibotattleDesktop: bridge },
    bridge,
  });
  assert.equal(fallbackDocument.byId.get("settings-panel-general").hidden, false);
});

test("Electron-only Share focuses the share panel, commands bridge to bounded controls, and Settings uses the enumerated action", async () => {
  const documentRef = makeSettingsDocument({ electron: true });
  const calls = [];
  let openedSettings = 0;
  let refreshClicks = 0;
  const dispatchedEvents = [];
  documentRef.refreshButton.addEventListener("click", () => { refreshClicks += 1; });
  const commandSlot = {};
  const windowRef = {
    location: { hash: "#trends", href: "" },
    Event: class {
      constructor(type) { this.type = type; }
    },
    dispatchEvent(event) { dispatchedEvents.push(event); },
    requestAnimationFrame(callback) { callback(); },
    tibotattleDesktop: Object.freeze({
      version: DESKTOP_SETTINGS_API_VERSION,
      getSettings: async () => ({ language: "es" }),
      setLanguage: async (value) => { calls.push(["setLanguage", value]); },
      onCommand(callback) {
        commandSlot.callback = callback;
        return () => { commandSlot.unsubscribed = true; };
      },
      openSettings: async () => { openedSettings += 1; },
    }),
  };
  const mounted = mountDesktopShell({ documentRef, windowRef });
  await settle();
  assert.equal(documentRef.languagePicker.value, "es");
  commandSlot.callback({ command: "refresh" });
  assert.equal(refreshClicks, 1);
  commandSlot.callback({ command: "hostedSignInReturn" });
  commandSlot.callback({
    command: "shareCardDownloadCompleted",
    path: "/private/opaque-download.png",
  });
  commandSlot.callback({
    command: "shareCardDownloadFailed",
    error: "private detail",
  });
  assert.deepEqual(dispatchedEvents.map((event) => event.type), [
    "tibotattle:hosted-sign-in-return",
    "tibotattle:share-card-download-completed",
    "tibotattle:share-card-download-failed",
  ]);
  assert.ok(dispatchedEvents.every((event) => event.detail === undefined));
  commandSlot.callback({ command: "language", value: "zh-Hans" });
  assert.equal(documentRef.languagePicker.value, "zh-Hans");
  assert.equal(calls.length, 0, "command-applied language must not echo back to the bridge");
  commandSlot.callback({ command: "language", value: "en" });
  assert.equal(documentRef.languagePicker.value, "en-US");
  assert.equal(calls.length, 0, "mapped command-applied language must not echo back to the bridge");
  commandSlot.callback({ command: "language", value: "file:///tmp/not-a-language" });
  assert.equal(documentRef.languagePicker.value, "en-US");
  documentRef.languagePicker.value = "en-US";
  documentRef.languagePicker.dispatch("change");
  await settle();
  assert.deepEqual(calls, [["setLanguage", "en"]]);
  documentRef.shareButton.dispatch("click");
  assert.equal(windowRef.location.hash, "#overview");
  assert.equal(documentRef.sharePanel.getAttribute("tabindex"), "-1");
  assert.equal(documentRef.sharePanel.focusCalls.length, 1);
  assert.equal(documentRef.sharePanel.scrollCalls.length, 1);
  documentRef.settingsButton.dispatch("click");
  assert.equal(openedSettings, 1);

  const hosted = makeSettingsDocument();
  const hostedWindow = { location: { hash: "#overview", href: "" } };
  const hostedShell = mountDesktopShell({ documentRef: hosted, windowRef: hostedWindow });
  hosted.shareButton.dispatch("click");
  assert.equal(hosted.sharePanel.focusCalls.length, 0);
  hosted.settingsButton.dispatch("click");
  assert.equal(hostedWindow.location.href, "");
  hostedShell.teardown();
  mounted.teardown();
  assert.equal(commandSlot.unsubscribed, true);
});

test("Electron Share honors the operating system reduced-motion preference", () => {
  const documentRef = makeSettingsDocument({ electron: true });
  const windowRef = {
    location: { hash: "#trends", href: "" },
    matchMedia(query) {
      assert.equal(query, "(prefers-reduced-motion: reduce)");
      return { matches: true };
    },
    requestAnimationFrame(callback) { callback(); },
    tibotattleDesktop: Object.freeze({
      version: DESKTOP_SETTINGS_API_VERSION,
      getSettings: async () => ({ language: "system" }),
      onCommand() { return () => {}; },
      openSettings: async () => {},
    }),
  };

  const mounted = mountDesktopShell({ documentRef, windowRef });
  documentRef.shareButton.dispatch("click");
  assert.deepEqual(documentRef.sharePanel.scrollCalls, [{
    block: "start",
    behavior: "auto",
  }]);
  mounted.teardown();
});
