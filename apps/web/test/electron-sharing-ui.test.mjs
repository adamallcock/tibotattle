import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  mountSettingsPage,
  normalizeElectronSharingPreference,
} from "../public/electron-settings.js";

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
  const [appSource, indexHtml, settingsHtml, settingsSource, settingsCss] = await Promise.all([
    readFile(APP_SOURCE_URL, "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.html", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.js", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.css", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /getSharingPreference\(\)/u);
  assert.match(appSource, /setSharingEnabled\(enabled\)/u);
  assert.match(appSource, /sharingNoticePresented\(index\)/u);
  assert.match(appSource, /document\.visibilityState === "visible"/u);
  assert.match(appSource, /getBoundingClientRect\(\)/u);
  assert.match(appSource, /innerWidth/u);
  assert.match(appSource, /listen\(globalThis\.window, "scroll", retry\)/u);
  assert.match(appSource, /listen\(globalThis\.window, "resize", retry\)/u);
  assert.match(appSource, /electronSharingNoticeReceiptIndex = index/u);
  assert.match(appSource, /preference\.noticeCount === receiptIndex/u);
  assert.match(indexHtml, /id="electron-sharing-notice"/u);
  assert.match(indexHtml, /id="electron-sharing-share-now"/u);
  assert.match(indexHtml, /id="electron-sharing-keep-off"/u);
  assert.match(settingsHtml, /id="settings-sharing-enabled"/u);
  assert.match(settingsSource, /settingsSharingBridge\.getSharingPreference\(\)/u);
  assert.match(settingsSource, /settingsSharingBridge\.setSharingEnabled\(enabled\)/u);
  assert.match(settingsSource, /function setOperationStatus\(documentRef, value, \{ error = false \} = \{\}\)/u);
  assert.match(settingsSource, /"is-success", hasMessage && !error/u);
  assert.match(settingsSource, /"is-error", hasMessage && error/u);
  assert.match(settingsCss, /\.settings-operation-status\.is-success\s*\{\s*color: var\(--green\);/u);
  assert.match(settingsCss, /\.settings-operation-status\.is-error\s*\{\s*color: var\(--rust\);/u);
});

test("Electron settings expose one analyzed Codex folder and retain extras without actions", async () => {
  const [settingsHtml, settingsSource] = await Promise.all([
    readFile(new URL("../public/electron-settings.html", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.js", import.meta.url), "utf8"),
  ]);
  const renderer = extractFunction(settingsSource, "renderCodexRoots");
  assert.match(settingsHtml, /TiboTattle analyzes the selected Codex folder/u);
  assert.match(settingsHtml, /retained for future multi-folder support and are not analyzed/u);
  assert.match(settingsHtml, /id="settings-add-codex-root"[^>]*hidden[^>]*disabled/u);
  assert.match(settingsHtml, /id="settings-use-default-codex-folder"[^>]*disabled/u);
  assert.match(renderer, /add\.hidden = true;[\s\S]*?add\.disabled = true;/u);
  assert.match(renderer, /useDefault\.hidden = false;[\s\S]*?useDefault\.disabled = !bridgeAvailable/u);
  assert.match(renderer, /electron\.settings\.codexRoots\.retained/u);
  assert.match(renderer, /if \(isPrimary && detailsAvailable && \(root\.kind === "custom" \|\| roots\.length === 1\)\)/u);
  assert.doesNotMatch(renderer, /addCodexHome|removeCodexHome|setPrimaryCodexHome|reorderCodexHomes/u);
  assert.match(
    settingsSource,
    /if \(roots\.length === 1\) \{\s*void invoke\("useDefaultCodexHome"\);/u,
  );
  assert.match(
    settingsSource,
    /void invoke\("setPrimaryCodexHome", \{ rootId: defaultRoot\.rootId \}\);/u,
  );

  const configureRootAction = extractFunction(settingsSource, "configureRootAction");
  const renderCodexRoots = new Function(
    "queryRequired",
    "translateSettingsMessage",
    "createSettingsElement",
    "configureRootAction",
    `${renderer}\nreturn renderCodexRoots;`,
  )(
    (documentRef, selector) => documentRef.elements.get(selector),
    (_localizer, key, values = {}) => `${key}${values.position === undefined ? "" : `:${values.position}`}`,
    (documentRef, tagName, className = "") => documentRef.createElement(tagName, className),
    new Function(`${configureRootAction}\nreturn configureRootAction;`)(),
  );
  const element = (tagName = "div", className = "") => ({
    tagName,
    className,
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    hidden: false,
    disabled: false,
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener() {},
  });
  const documentRef = {
    elements: new Map(),
    createElement(tagName, className) { return element(tagName, className); },
  };
  const list = element();
  const status = element();
  const add = element("button");
  const useDefault = element("button");
  documentRef.elements.set("#settings-codex-roots", list);
  documentRef.elements.set("#settings-codex-roots-status", status);
  documentRef.elements.set("#settings-add-codex-root", add);
  documentRef.elements.set("#settings-use-default-codex-folder", useDefault);
  renderCodexRoots(documentRef, {
    codexHomesForSettings: {
      primaryRootId: "11111111-1111-4111-8111-111111111111",
      activityRoots: [
        {
          rootId: "11111111-1111-4111-8111-111111111111",
          kind: "custom",
          path: "/synthetic/primary",
        },
        {
          rootId: "22222222-2222-4222-8222-222222222222",
          kind: "custom",
          path: "/synthetic/retained",
        },
      ],
    },
    codexHomes: { activityRoots: [], primaryRootId: "" },
  }, true, null, () => assert.fail("retained roots must not dispatch an action"));
  const descendants = (node) => [node, ...node.childNodes.flatMap(descendants)];
  assert.equal(add.hidden, true);
  assert.equal(add.disabled, true);
  assert.equal(useDefault.hidden, false);
  assert.equal(useDefault.disabled, true);
  assert.equal(list.childNodes.length, 2);
  const [primary, retained] = list.childNodes;
  assert.equal(primary.dataset.primary, "true");
  assert.equal(retained.dataset.primary, "false");
  assert.equal(primary.dataset.analysisScope, "primary");
  assert.equal(retained.dataset.analysisScope, "retained");
  assert.ok(descendants(primary).some((node) => (
    node.textContent === "electron.settings.codexRoots.primaryHelp"
  )));
  assert.ok(descendants(primary).some((node) => node.tagName === "button"));
  assert.ok(descendants(retained).some((node) => (
    node.textContent === "electron.settings.codexRoots.retained"
  )));
  assert.equal(descendants(retained).some((node) => node.tagName === "button"), false);

  const defaultList = element();
  const defaultStatus = element();
  const defaultAdd = element("button");
  const defaultUse = element("button");
  documentRef.elements.set("#settings-codex-roots", defaultList);
  documentRef.elements.set("#settings-codex-roots-status", defaultStatus);
  documentRef.elements.set("#settings-add-codex-root", defaultAdd);
  documentRef.elements.set("#settings-use-default-codex-folder", defaultUse);
  renderCodexRoots(documentRef, {
    codexHomesForSettings: {
      primaryRootId: "00000000-0000-4000-8000-000000000001",
      activityRoots: [{
        rootId: "00000000-0000-4000-8000-000000000001",
        kind: "default",
        path: null,
      }],
    },
    codexHomes: { activityRoots: [], primaryRootId: "" },
  }, true, null, () => assert.fail("rendering must not dispatch an action"));
  const defaultButton = descendants(defaultList).find((node) => node.tagName === "button");
  assert.equal(defaultButton?.dataset.rootAction, "chooseCodexHome");
  assert.equal(defaultUse.disabled, true, "the current default root needs no reset");

  const customList = element();
  const customStatus = element();
  const customAdd = element("button");
  const customUse = element("button");
  documentRef.elements.set("#settings-codex-roots", customList);
  documentRef.elements.set("#settings-codex-roots-status", customStatus);
  documentRef.elements.set("#settings-add-codex-root", customAdd);
  documentRef.elements.set("#settings-use-default-codex-folder", customUse);
  renderCodexRoots(documentRef, {
    codexHomesForSettings: {
      primaryRootId: "11111111-1111-4111-8111-111111111111",
      activityRoots: [{
        rootId: "11111111-1111-4111-8111-111111111111",
        kind: "custom",
        path: "/synthetic/only-root",
      }],
    },
    codexHomes: { activityRoots: [], primaryRootId: "" },
  }, true, null, () => assert.fail("rendering must not dispatch an action"));
  assert.equal(customUse.disabled, false, "a single selected custom folder can return to default");
});

test("the singleton default chooser refreshes the rendered folder card after selection", async () => {
  const listeners = new Map();
  const element = (tagName = "div", className = "") => ({
    tagName,
    className,
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    classList: { toggle() {} },
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(type, handler) { this.listeners ??= new Map(); this.listeners.set(type, handler); },
    removeEventListener(type, handler) { if (this.listeners?.get(type) === handler) this.listeners.delete(type); },
    click() { this.listeners?.get("click")?.({ preventDefault() {} }); },
  });
  const selectors = [
    "#settings-bridge-status", "#settings-language", "#settings-appearance",
    "#settings-codex-folder-status", "#settings-codex-roots",
    "#settings-codex-roots-status", "#settings-add-codex-root",
    "#settings-use-default-codex-folder", "#settings-refresh-interval",
    "#settings-start-at-login", "#settings-start-at-login-summary",
    "#settings-open-login-items", "#settings-refresh-login-status",
    "#settings-notifications-enabled", "#settings-notifications-detail",
    "#settings-notification-status", "#settings-open-notification-settings",
    "#settings-automatic-updates", "#settings-check-for-updates",
    "#settings-open-dashboard-browser", "#settings-show-diagnostics",
    "#settings-reveal-local-data", "#settings-version", "#settings-build",
    "#settings-updates-status", "#settings-operation-status",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const documentRef = {
    documentElement: { dataset: {}, classList: { toggle() {} } },
    createElement: element,
    querySelector(selector) { return elements.get(selector) ?? null; },
    querySelectorAll() { return []; },
  };
  const defaultRootId = "00000000-0000-4000-8000-000000000001";
  const customRootId = "11111111-1111-4111-8111-111111111111";
  let roots = {
    activityRoots: [{ rootId: defaultRootId, kind: "default", path: null, enabled: true }],
    primaryRootId: defaultRootId,
  };
  const bridge = {
    version: "v1",
    getSettings: async () => ({
      settings: {
        language: "en", appearance: "system", refreshIntervalSeconds: 300,
        codexHomes: roots,
        codexFolder: { kind: roots.activityRoots[0].kind },
        startAtLogin: { status: "disabled", canSet: false },
        notifications: { enabled: false, threshold: "off", canSet: false },
      },
      about: { version: "0.1.18", build: "test", update: {}, automaticUpdates: {} },
    }),
    getCodexHomesForSettings: async () => roots,
    chooseCodexHome: async () => {
      roots = {
        activityRoots: [{
          rootId: customRootId,
          kind: "custom",
          path: "/synthetic/chosen-codex",
          enabled: true,
        }],
        primaryRootId: customRootId,
      };
      return { settings: { codexHomes: roots, codexFolder: { kind: "custom" } } };
    },
  };
  const mounted = await mountSettingsPage({
    documentRef,
    windowRef: { tibotattleDesktop: bridge, location: { hash: "#general" } },
    bridge,
  });
  const list = elements.get("#settings-codex-roots");
  const beforeButton = list.childNodes[0].childNodes
    .flatMap((node) => node.childNodes)
    .find((node) => node.tagName === "button");
  assert.equal(beforeButton?.dataset.rootAction, "chooseCodexHome");
  beforeButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  const card = list.childNodes[0];
  assert.equal(card.dataset.primary, "true");
  assert.equal(card.dataset.analysisScope, "primary");
  assert.equal(card.getAttribute("aria-labelledby"), `settings-codex-root-${customRootId}`);
  const text = [card, ...card.childNodes, ...card.childNodes.flatMap((node) => node.childNodes)]
    .map((node) => node.textContent)
    .join(" ");
  assert.match(text, /\/synthetic\/chosen-codex/u);
  mounted.teardown();
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
  const factory = new Function("bridge", "initialPreference", "initialVisibility", "initialRect", `
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
    const rectangle = initialRect ?? {
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
    };
    const makeElement = () => ({
      hidden: true,
      disabled: false,
      isConnected: true,
      dataset: {},
      textContent: "",
      getBoundingClientRect() { return { ...rectangle }; },
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
      innerWidth: 100,
      innerHeight: 100,
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
      setRect(nextRect) {
        Object.assign(rectangle, nextRect);
      },
      emit(type) {
        for (const listener of documentListeners.get(type) ?? []) listener();
        for (const listener of windowListeners.get(type) ?? []) listener();
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

test("offscreen or zero-area notices wait for a visible scroll or resize", async () => {
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
  const factory = new Function("bridge", "initialPreference", "initialVisibility", "initialRect", `
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
    const rectangle = initialRect ?? {
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
    };
    const makeElement = () => ({
      hidden: true,
      disabled: false,
      isConnected: true,
      dataset: {},
      textContent: "",
      getBoundingClientRect() { return { ...rectangle }; },
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
      innerWidth: 100,
      innerHeight: 100,
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
      setRect(nextRect) {
        Object.assign(rectangle, nextRect);
      },
      emit(type) {
        for (const listener of documentListeners.get(type) ?? []) listener();
        for (const listener of windowListeners.get(type) ?? []) listener();
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
  const harness = factory(bridge, initial, "visible", {
    left: 0,
    top: 120,
    right: 100,
    bottom: 160,
    width: 100,
    height: 40,
  });
  harness.renderElectronSharingNotice();
  await harness.drainFrames();
  assert.deepEqual(calls, [], "an offscreen banner does not count as displayed");
  harness.setRect({ left: 0, top: 0, right: 0, bottom: 40, width: 0, height: 40 });
  harness.emit("resize");
  await harness.drainFrames();
  assert.deepEqual(calls, [], "a zero-area banner does not count as displayed");
  harness.setRect({ left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 });
  harness.emit("scroll");
  await harness.drainFrames();
  assert.deepEqual(calls, [1], "scrolling the banner into view permits one receipt");
  harness.emit("scroll");
  await harness.drainFrames();
  assert.deepEqual(calls, [1], "a retained banner cannot be receipted twice");
});
