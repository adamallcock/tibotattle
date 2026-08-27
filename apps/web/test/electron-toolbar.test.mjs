import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import {
  SUPPORTED_LOCALES,
  translate,
} from "../public/localization.js";

const readPublic = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
const [appSource, html] = await Promise.all([
  readPublic("app.js"),
  readPublic("index.html"),
]);

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
  constructor({ id = "", className = "" } = {}) {
    this.id = id;
    this.className = className;
    this.dataset = {};
    this.textContent = "";
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.focusCalls = [];
    this.parentElement = null;
    this.isConnected = true;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  querySelector(selector) {
    if (selector === ".electron-sidebar-toggle-label") {
      return this.children.find((child) => child.className === selector.slice(1)) ?? null;
    }
    return null;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type) {
    this.listeners.get(type)?.({
      currentTarget: this,
      target: this,
      preventDefault() {},
    });
  }

  focus(options) {
    this.focusCalls.push(options);
  }
}

function extractToolbarHelpers() {
  const start = appSource.indexOf("function renderElectronToolbarAllowance");
  const end = appSource.indexOf("\nfunction updateLocalActionButtons", start);
  assert.ok(start >= 0, "Electron toolbar helpers must exist");
  assert.ok(end > start, "Electron toolbar helper block must be bounded");
  return appSource.slice(start, end);
}

function makeHarness({ electron = true, bridge = null } = {}) {
  const elements = new Map();
  const make = (id, className = "") => {
    const element = new FakeElement({ id, className });
    elements.set(id, element);
    return element;
  };
  const shell = make("dashboard-shell");
  const sidebar = make("dashboard-sidebar");
  const main = make("main");
  const status = make("electron-toolbar-status", "electron-toolbar-status");
  const allowance = make("electron-toolbar-allowance");
  const toggle = make("electron-sidebar-toggle");
  const toggleLabel = new FakeElement({ className: "electron-sidebar-toggle-label" });
  toggle.appendChild(toggleLabel);
  const refresh = make("refresh-button");
  const documentRef = {
    activeElement: null,
    querySelector(selector) {
      if (selector === ".dashboard-shell") return shell;
      if (selector === ".dashboard-sidebar") return sidebar;
      if (selector === ".electron-toolbar-status") return status;
      if (selector.startsWith("#")) return elements.get(selector.slice(1)) ?? null;
      return null;
    },
  };

  const messages = {
    "electron.shell.allowanceUnavailable": "Allowance unavailable",
    "electron.shell.allowanceRemaining": "{value} remaining",
    "electron.shell.refreshTooltip": "Refresh local usage",
    "electron.shell.hideSidebar": "Hide sidebar",
    "electron.shell.showSidebar": "Show sidebar",
    "status.running": "Running",
  };
  const t = (key, values = {}) => String(messages[key] ?? key).replace(
    /\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu,
    (token, name) => Object.hasOwn(values, name) ? String(values[name]) : token,
  );
  const context = vm.createContext({
    Promise,
    document: documentRef,
    setTimeout,
    clearTimeout,
    $: (selector) => documentRef.querySelector(selector),
    t,
    tibotattleDesktop: bridge,
    runsInsideElectronDashboard: () => electron,
    selectPrimaryCodexQuotaWindow(windows) {
      return windows.reduce((selected, window) => (
        selected === null
          || window.durationMinutes > selected.durationMinutes
          || (window.durationMinutes === selected.durationMinutes
            && window.slot === "primary" && selected.slot !== "primary")
          ? window
          : selected
      ), null);
    },
    isPrimaryCodexQuotaWindow(window) {
      return window?.limitId === "codex"
        && Number.isSafeInteger(window?.durationMinutes)
        && window.durationMinutes >= 1;
    },
    finite(value, fallback = null) {
      return typeof value === "number" && Number.isFinite(value) ? value : fallback;
    },
    formatPercent(value) {
      return `${Math.round(value)}%`;
    },
    setRawText(element, value) {
      element.textContent = String(value);
    },
    setLocalizedText(element, key, values = {}) {
      element.textContent = t(key, values);
    },
  });
  // The VM global object is also `globalThis`, so the bridge is visible to
  // helper code that deliberately reads the global boundary.
  context.tibotattleDesktop = bridge;
  vm.runInContext(`
    let dashboard = null;
    let globalState = null;
    let localRefreshInProgress = false;
    ${extractToolbarHelpers()}
    globalThis.__api = {
      applyElectronSidebarState,
      renderElectronRefreshControl,
      renderElectronSidebarToggle,
      renderElectronToolbarAllowance,
      setDashboard(value) { dashboard = value; },
      setGlobalState(value) { globalState = value; },
      setRefreshBusy(value) { localRefreshInProgress = value; },
      toggleElectronSidebar,
    };
  `, context);

  return {
    api: context.__api,
    elements: { allowance, main, refresh, shell, sidebar, status, toggle, toggleLabel },
    documentRef,
  };
}

function liveDashboard(remainingPercent = 81.4) {
  return {
    mode: "real_local_evidence",
    state: "live",
    quotaWindows: [
      {
        limitId: "codex",
        durationMinutes: 300,
        remainingPercent: 71.2,
        status: "live",
        slot: "primary",
      },
      {
        limitId: "codex",
        durationMinutes: 10_080,
        remainingPercent,
        status: "live",
        slot: "secondary",
      },
    ],
  };
}

test("Electron toolbar markup is labelled and its toolbar key resolves in every supported locale", () => {
  const toolbar = html.match(/<div[\s\S]*?class="top-actions"[\s\S]*?<\/div>/u)?.[0] ?? "";
  assert.ok(toolbar, "dashboard toolbar markup exists");
  assert.match(toolbar, /role="toolbar"/u);
  assert.match(toolbar, /data-i18n-aria-label="aria\.dashboardToolbar"/u);
  assert.doesNotMatch(toolbar, /\saria-label="aria\.dashboardToolbar"/u);
  assert.match(toolbar, /id="electron-sidebar-toggle"[\s\S]*?aria-controls="dashboard-sidebar"/u);
  assert.match(toolbar, /id="refresh-button"[\s\S]*?aria-busy="false"/u);
  for (const [locale, expected] of [
    ["en-US", "Dashboard toolbar"],
    ["zh-Hans", "仪表板工具栏"],
    ["es", "Barra de herramientas del panel"],
  ]) {
    assert.ok(SUPPORTED_LOCALES.includes(locale));
    assert.equal(translate("aria.dashboardToolbar", {}, locale), expected, locale);
    assert.notEqual(translate("aria.dashboardToolbar", {}, locale), "aria.dashboardToolbar");
  }
});

test("Electron allowance readout uses only live normal-Codex evidence and the longest valid window", () => {
  const harness = makeHarness();
  harness.api.renderElectronToolbarAllowance(liveDashboard(81.4));
  assert.equal(harness.elements.allowance.textContent, "81%");
  assert.equal(harness.elements.allowance.dataset.available, "true");
  assert.equal(harness.elements.allowance.getAttribute("aria-label"), "81% remaining");
  assert.equal(harness.elements.status.getAttribute("aria-label"), "81% remaining");
  assert.equal(harness.elements.allowance.getAttribute("data-i18n-aria-label"), null);
  assert.equal(harness.elements.status.getAttribute("data-i18n-aria-label"), null);
});

test("Electron allowance readout falls back to an honest dash for stale, demo, invalid, or unavailable data", () => {
  const cases = [
    { state: "stale", mode: "real_local_evidence" },
    { state: "live", mode: "demo" },
    {
      state: "live",
      mode: "real_local_evidence",
      quotaWindows: [{
        limitId: "codex",
        durationMinutes: 10_080,
        remainingPercent: 101,
        status: "live",
      }],
    },
    { state: "offline", mode: "real_local_evidence" },
  ];
  for (const data of cases) {
    const harness = makeHarness();
    harness.api.renderElectronToolbarAllowance({
      ...liveDashboard(),
      ...data,
      quotaWindows: data.quotaWindows ?? liveDashboard().quotaWindows,
    });
    assert.equal(harness.elements.allowance.textContent, "—", JSON.stringify(data));
    assert.equal(harness.elements.allowance.dataset.available, "false", JSON.stringify(data));
    assert.equal(
      harness.elements.allowance.getAttribute("aria-label"),
      "Allowance unavailable",
      JSON.stringify(data),
    );
    assert.equal(harness.elements.status.getAttribute("aria-label"), "Allowance unavailable");
  }
});

test("Electron refresh control exposes idle and analyzing states without owning a second request", () => {
  const harness = makeHarness();
  harness.elements.refresh.textContent = "Analyze local usage";
  harness.api.setGlobalState({ state: "live" });
  harness.api.renderElectronRefreshControl();
  assert.equal(harness.elements.refresh.getAttribute("aria-busy"), "false");
  assert.equal(harness.elements.refresh.dataset.refreshState, "live");
  assert.equal(harness.elements.refresh.title, "Refresh local usage");

  harness.elements.refresh.textContent = "Headline ready; finishing deeper accounting… 4s";
  harness.api.setRefreshBusy(true);
  harness.api.renderElectronRefreshControl();
  assert.equal(harness.elements.refresh.getAttribute("aria-busy"), "true");
  assert.equal(harness.elements.refresh.dataset.refreshState, "analyzing");
  assert.equal(harness.elements.refresh.title, "Headline ready; finishing deeper accounting… 4s");
});

test("Electron sidebar rescue toggles visual state, focus safety, and optional persisted bridge state", async () => {
  const bridgeCalls = [];
  const harness = makeHarness({
    bridge: {
      toggleSidebar() {
        bridgeCalls.push("toggleSidebar");
        return Promise.resolve({ settings: { sidebarCollapsed: false } });
      },
    },
  });
  harness.api.renderElectronSidebarToggle();
  assert.equal(harness.elements.toggle.getAttribute("aria-expanded"), "true");
  assert.equal(
    harness.elements.toggle.getAttribute("data-i18n-aria-label"),
    "electron.shell.hideSidebar",
  );

  harness.elements.sidebar.appendChild(new FakeElement());
  harness.documentRef.activeElement = harness.elements.sidebar.children[0];
  harness.api.applyElectronSidebarState(true);
  assert.equal(harness.elements.shell.classList.contains("sidebar-collapsed"), true);
  assert.equal(harness.elements.sidebar.getAttribute("aria-hidden"), "true");
  assert.equal(harness.elements.sidebar.getAttribute("inert"), "");
  assert.equal(harness.elements.toggle.getAttribute("aria-expanded"), "false");
  assert.equal(harness.elements.toggle.getAttribute("aria-label"), "Show sidebar");
  assert.equal(
    harness.elements.toggle.getAttribute("data-i18n-aria-label"),
    "electron.shell.showSidebar",
  );
  assert.equal(
    harness.elements.toggleLabel.getAttribute("data-i18n"),
    "electron.shell.showSidebar",
  );
  assert.equal(harness.elements.main.focusCalls.length, 1);

  assert.equal(harness.api.toggleElectronSidebar(), true);
  assert.deepEqual(bridgeCalls, ["toggleSidebar"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.elements.shell.classList.contains("sidebar-collapsed"), false);
  assert.equal(harness.elements.sidebar.getAttribute("aria-hidden"), "false");
  assert.equal(harness.elements.toggle.getAttribute("aria-expanded"), "true");
  assert.equal(harness.elements.toggle.getAttribute("aria-label"), "Hide sidebar");
});

test("Electron refresh remains bound to the existing requestRefresh and cancel guards", () => {
  assert.match(
    appSource,
    /\$\("#refresh-button"\)\.addEventListener\("click", requestRefresh\)/u,
  );
  assert.match(appSource, /localActionBusy\s*=\s*true[\s\S]*?localRefreshInProgress\s*=\s*true/u);
  assert.match(appSource, /if \(localActionBusy\) return;/u);
  assert.match(appSource, /cancelLocalAnalysis/u);
});

test("companion-unavailable sidebar hiding is the existing evidence-gated fallback", () => {
  const start = appSource.indexOf("function setJourneyState(state)");
  const end = appSource.indexOf("\n}\n\nfunction localAnalysisAllowed", start);
  assert.ok(start >= 0 && end > start, "journey state helper exists");
  const source = appSource.slice(start, end);
  assert.match(source, /const hasEvidence = state === "local-ready" \|\| state === "demo-mode"/u);
  assert.match(source, /element\.hidden = !hasEvidence/u);
  assert.match(html, /data-nav="overview"[^>]*data-requires-evidence/u);
  assert.match(html, /data-nav="community"[^>]*data-requires-evidence/u);
});
