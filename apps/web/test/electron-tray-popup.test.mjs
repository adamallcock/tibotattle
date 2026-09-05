import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bootstrapTrayPopup,
  createTrayPopupProjection,
  renderTrayPopup,
  requestTrayPopupAction,
  TRAY_POPUP_SCHEMA_VERSION,
} from "../public/electron-tray-popup.js";
import {
  SUPPORTED_LOCALES,
  translate,
} from "../public/localization.js";

const NOW = "2026-09-04T18:00:00.000Z";

function usageRow(day, hour, {
  events = 1,
  tokens = 100,
  cost = 0.01,
  partial = 0,
  unpriced = 0,
} = {}) {
  return {
    startAt: `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`,
    endAt: `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:15:00.000Z`,
    usageEvents: events,
    totalTokens: tokens,
    apiPriceEquivalentUsd: cost,
    pricingCoverage: {
      fullyPricedEvents: events - partial - unpriced,
      partiallyPricedEvents: partial,
      unpricedEvents: unpriced,
    },
  };
}

function period(periodId, overrides = {}) {
  const events = overrides.events ?? 12;
  return {
    periodId,
    periodLabel: periodId === "7d" ? "Last seven days" : "Last thirty days",
    events,
    totalTokens: overrides.totalTokens ?? 1_200,
    apiPriceEquivalentUsd: overrides.apiPriceEquivalentUsd ?? 1.25,
    pricingCoverage: {
      fullyPricedEvents: overrides.fullyPricedEvents ?? events,
      partiallyPricedEvents: overrides.partiallyPricedEvents ?? 0,
      unpricedEvents: overrides.unpricedEvents ?? 0,
    },
  };
}

function fixture({ accountingProjection = "available", historyStatus = "complete" } = {}) {
  return {
    state: "live",
    freshness: {
      status: "live",
      latestObservedAt: NOW,
      ageSeconds: 15,
      accountingStatus: accountingProjection,
      accountingAgeSeconds: 15,
    },
    quotaWindows: [
      {
        id: "codex-5h",
        limitId: "codex",
        durationMinutes: 300,
        usedPercent: 25,
        remainingPercent: 75,
        resetAt: "2026-09-04T20:00:00.000Z",
        status: "live",
      },
      {
        id: "codex-7d",
        limitId: "codex",
        durationMinutes: 10_080,
        usedPercent: 40,
        remainingPercent: 60,
        resetAt: "2026-09-07T20:00:00.000Z",
        status: "live",
      },
      {
        id: "spark",
        limitId: "codex_bengalfox",
        durationMinutes: 300,
        usedPercent: 1,
        remainingPercent: 99,
        status: "live",
      },
    ],
    weekly: {
      paceOutlook: {
        schemaVersion: "local-weekly-pace-outlook-v0.1",
        status: "available",
        standing: "under",
        critical: false,
        earlyEstimate: false,
        remainingPercent: 60,
        resetsAt: "2026-09-07T20:00:00.000Z",
        observationCount: 5,
        elapsedHours: 72,
        rates: {
          activePercentagePointsPerHour: 0.3,
          overallPercentagePointsPerHour: 0.2,
          headlinePercentagePointsPerHour: 0.2,
          sustainablePercentagePointsPerHour: 60 / 74,
          ratio: 0.2 / (60 / 74),
        },
        projection: {
          hoursToReset: 74,
          coveredHours: 74,
          dryHours: 0,
          sparePercent: 45.2,
          projectedExhaustionAt: null,
        },
        track: {
          coveredFraction: 1,
          activeExhaustionFraction: null,
        },
      },
      paceForecast: {
        schemaVersion: "local-weekly-pace-forecast-v0.2",
        status: "available",
        currentUsedPercent: 40,
        remainingPercent: 60,
        resetsAt: "2026-09-07T20:00:00.000Z",
        pace: {
          method: "median_adjacent_quota_slope",
          sampleCount: 4,
          elapsedHours: 72,
          movementPp: 15,
          activePercentagePointsPerHour: 0.3,
          overallPercentagePointsPerHour: 0.2,
        },
        observationCount: 5,
        etaAt: "2026-09-07T10:00:00.000Z",
        hoursToExhaustion: 64,
        hoursToReset: 74,
      },
    },
    accounting: {
      projection: accountingProjection === "retained"
        ? {
          status: "retained",
          retainedAt: "2026-09-04T17:00:00.000Z",
          coveredAt: {
            startAt: "2026-08-06T00:00:00.000Z",
            endAt: "2026-09-04T17:00:00.000Z",
          },
        }
        : {
          status: accountingProjection,
          reason: accountingProjection === "available" ? null : "local_unified_index_unavailable",
          terminal: accountingProjection !== "available",
        },
      periods: [
        period("7d"),
        period("30d", { events: 42, totalTokens: 4_200 }),
      ],
      historyCoverage: {
        status: "complete",
        sourceCount: 8,
        indexedSourceCount: 8,
        pendingSourceCount: 0,
        skippedSourceCount: 0,
      },
    },
    timeline: {
      bucketMinutes: 15,
      usage: [
        usageRow(4, 17, { events: 2, tokens: 200, cost: 0.02 }),
        usageRow(3, 13, { events: 3, tokens: 300, cost: 0.03 }),
        usageRow(2, 8, { events: 0, tokens: 0, cost: 0 }),
        usageRow(1, 9, { events: 1, tokens: 100, cost: 0.01 }),
        usageRow(28, 9, { events: 1, tokens: 100, cost: 0.01 }),
        usageRow(20, 9, { events: 1, tokens: 100, cost: 0.01 }),
      ],
      history: {
        status: historyStatus,
        source: "unified_local_index",
        coveredAt: {
          startAt: "2026-08-06T00:00:00.000Z",
          endAt: NOW,
        },
      },
    },
  };
}

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = { ...dataset };
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this.style = {};
    this.attributes = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.nodeType = 1;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

class FakeDocument {
  constructor(visibilityState = "visible") {
    this.visibilityState = visibilityState;
    this.listeners = new Map();
    this.documentElement = new FakeElement();
    this.elements = new Map();
    for (const id of [
      "allowance-lanes", "allowance-unavailable", "pace-metrics", "pace-track",
      "pace-outlook", "pace-early", "pace-state", "pace-used", "pace-remaining",
      "pace-reset", "pace-rate", "pace-fill", "pace-active-marker",
      "history-summary", "history-cost", "history-coverage", "history-retained",
      "history-pricing", "history-bars", "tray-popup-freshness", "tray-popup-live",
    ]) this.elements.set(id, new FakeElement());
    this.ranges = [new FakeElement({ historyRange: "7d" }), new FakeElement({ historyRange: "30d" })];
    this.actions = [new FakeElement({ action: "open" }), new FakeElement({ action: "refresh" }), new FakeElement({ action: "more" })];
  }

  createElement() {
    return new FakeElement();
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-history-range]") return this.ranges;
    if (selector === "[data-action]") return this.actions;
    return [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }
}

function fakeWindow() {
  const listeners = new Map();
  return {
    navigator: { language: "en-US", languages: ["en-US"] },
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("tray popup assets are local, bounded, and wired as a visual surface", async () => {
  const html = await readFile(new URL("../public/electron-tray-popup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/electron-tray-popup.css", import.meta.url), "utf8");
  const js = await readFile(new URL("../public/electron-tray-popup.js", import.meta.url), "utf8");
  assert.match(html, /electron-tray-popup\.css/u);
  assert.match(html, /electron-tray-popup\.js/u);
  assert.match(html, /data-i18n-root/u);
  assert.match(html, /id="allowance-lanes"/u);
  assert.match(html, /id="pace-track"/u);
  assert.match(html, /id="history-bars"/u);
  assert.match(html, /data-history-range="7d"/u);
  assert.match(html, /data-history-range="30d"/u);
  assert.match(html, /data-action="open"/u);
  assert.match(html, /data-action="refresh"/u);
  assert.match(html, /data-action="more"/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.match(js, /pace-active-marker/u);
  assert.match(js, /totalTokens/u);
  assert.match(js, /visibilitychange/u);
  assert.match(js, /data-tray-popup-ready/u);
  assert.doesNotMatch(js, /recalculateDetailedAccounting/u);
  assert.match(css, /width:\s*min\(400px/u);
  assert.match(css, /height:\s*104px/u);
  assert.match(css, /\[hidden\][\s\S]*display:\s*none\s*!important/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /prefers-color-scheme:\s*dark/u);
});

test("rendered action labels interpolate the product name", () => {
  const documentRef = new FakeDocument();
  renderTrayPopup(documentRef, createTrayPopupProjection(fixture(), { now: NOW, timeZone: "UTC" }));
  assert.equal(documentRef.actions[0].textContent, "Open TiboTattle");
  assert.equal(documentRef.actions[1].textContent, "Update Local Usage");
  assert.equal(documentRef.actions[2].textContent, "⋯");
  assert.equal(documentRef.actions[2].attributes.get("aria-label"), "More actions");
  assert.doesNotMatch(documentRef.actions[0].textContent, /\{appName\}/u);
});

test("the popup's three new messages stay translated in every shipped locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "electron.trayPopover.weeklyPace",
      "electron.trayPopover.localHistory",
      "electron.trayPopover.pricingPartial",
    ]) {
      const value = translate(key, {}, locale);
      assert.equal(typeof value, "string");
      assert.notEqual(value.trim(), "", `${locale} ${key}`);
      assert.doesNotMatch(value, /\{[A-Za-z]/u, `${locale} ${key}`);
    }
  }
});

test("projection keeps the normal Codex lanes and exact shared pace outlook", () => {
  const projection = createTrayPopupProjection(fixture(), { now: NOW, timeZone: "UTC" });
  assert.equal(projection.schemaVersion, TRAY_POPUP_SCHEMA_VERSION);
  assert.deepEqual(projection.allowances.map((row) => row.durationMinutes), [300, 10_080]);
  assert.deepEqual(projection.allowances.map((row) => row.remainingPercent), [75, 60]);
  assert.equal(projection.weeklyPace.status, "available");
  assert.equal(projection.weeklyPace.pace.overallPercentagePointsPerHour, 0.2);
  assert.equal(projection.weeklyPace.resetsAt, "2026-09-07T20:00:00.000Z");
  assert.equal(projection.weeklyPace.outlook.kind, "reset_first");
  assert.equal(projection.weeklyPace.outlook.standing, "under");
  assert.equal(projection.weeklyPace.outlook.coveredFraction, 1);
  assert.equal(Object.hasOwn(projection, "accountId"), false);
  assert.equal(Object.hasOwn(projection, "raw"), false);
});

test("pace outlook rejects malformed geometry and a different weekly reset", () => {
  const malformed = fixture();
  malformed.weekly.paceOutlook.track.coveredFraction = 1.1;
  assert.equal(
    createTrayPopupProjection(malformed, { now: NOW, timeZone: "UTC" })
      .weeklyPace.status,
    "unavailable",
  );

  const mismatchedReset = fixture();
  mismatchedReset.quotaWindows[1].remainingPercent = 61;
  assert.equal(
    createTrayPopupProjection(mismatchedReset, { now: NOW, timeZone: "UTC" })
      .weeklyPace.status,
    "unavailable",
  );

  const malformedExhaustion = fixture();
  malformedExhaustion.weekly.paceOutlook.projection.projectedExhaustionAt = "later";
  assert.equal(
    createTrayPopupProjection(malformedExhaustion, { now: NOW, timeZone: "UTC" })
      .weeklyPace.status,
    "unavailable",
  );
});

test("pace outlook expires when its reset binding is stale or already passed", () => {
  const stale = createTrayPopupProjection(fixture(), {
    now: "2026-09-04T19:00:00.000Z",
    timeZone: "UTC",
  });
  assert.equal(stale.weeklyPace.status, "unavailable");

  const expired = createTrayPopupProjection(fixture(), {
    now: "2026-09-08T00:00:00.000Z",
    timeZone: "UTC",
  });
  assert.equal(expired.weeklyPace.status, "unavailable");
});

test("history uses existing 15-minute buckets, preserves measured zero, and leaves gaps unknown", () => {
  const seven = createTrayPopupProjection(fixture(), { now: NOW, range: "7d", timeZone: "UTC" });
  assert.equal(seven.history.dayCount, 7);
  assert.equal(seven.history.days.length, 7);
  const byDay = new Map(seven.history.days.map((day) => [day.key, day]));
  assert.equal(byDay.get("2026-09-02").usageEvents, 0);
  assert.equal(byDay.get("2026-09-02").evidence, "available");
  assert.equal(byDay.get("2026-08-30").usageEvents, null);
  assert.equal(byDay.get("2026-08-30").evidence, "unavailable");
  assert.equal(seven.history.status, "complete");

  const thirty = createTrayPopupProjection(fixture(), { now: NOW, range: "30d", timeZone: "UTC" });
  assert.equal(thirty.history.dayCount, 30);
  assert.equal(thirty.history.days.length, 30);
  assert.equal(thirty.history.days.some((day) => day.usageEvents === null), true);
  assert.equal(thirty.history.period.periodId, "30d");
});

test("partial pricing and retained accounting stay visibly qualified", () => {
  const data = fixture({ accountingProjection: "retained", historyStatus: "partial" });
  data.accounting.periods[0] = period("7d", {
    events: 3,
    totalTokens: 300,
    apiPriceEquivalentUsd: 0.02,
    fullyPricedEvents: 2,
    partiallyPricedEvents: 1,
  });
  const projection = createTrayPopupProjection(data, { now: NOW, timeZone: "UTC" });
  assert.equal(projection.accounting.status, "retained");
  assert.equal(projection.accounting.retained, true);
  assert.equal(projection.history.status, "partial");
  assert.equal(projection.history.pricingState, "partial");
  assert.equal(projection.history.period.pricingState, "partial");
});

test("unavailable accounting never turns absent history into zero", () => {
  const projection = createTrayPopupProjection(
    fixture({ accountingProjection: "unavailable", historyStatus: "complete" }),
    { now: NOW, timeZone: "UTC" },
  );
  assert.equal(projection.accounting.status, "unavailable");
  assert.equal(projection.accounting.period, null);
  assert.equal(projection.history.status, "unavailable");
  assert.equal(projection.history.days.every((day) => day.usageEvents === null), true);
});

test("history keeps fractional currency totals when rows include integer-priced buckets", () => {
  const data = fixture();
  data.timeline.usage.push(usageRow(4, 18, { events: 1, tokens: 100, cost: 1 }));
  const projection = createTrayPopupProjection(data, { now: NOW, timeZone: "UTC" });
  const day = projection.history.days.find((row) => row.key === "2026-09-04");
  assert.equal(day.apiPriceEquivalentUsd, 1.02);
  assert.equal(day.usageEvents, 3);
  assert.equal(day.totalTokens, 300);
});

test("oversized timeline input fails closed instead of silently showing a complete tail", () => {
  const data = fixture();
  data.timeline.usage = Array.from({ length: 3_001 }, () => usageRow(4, 17));
  const projection = createTrayPopupProjection(data, { now: NOW, timeZone: "UTC" });
  assert.equal(projection.history.status, "unavailable");
  assert.equal(projection.history.days.every((day) => day.usageEvents === null), true);
});

test("hidden popup model events wait for visibility before reading the companion", async () => {
  const documentRef = new FakeDocument("hidden");
  const windowRef = fakeWindow();
  let modelListener;
  let loadCalls = 0;
  const client = {
    async load() {
      loadCalls += 1;
      return {};
    },
  };
  const bridge = {
    onModel(listener) {
      modelListener = listener;
    },
    requestAction() {},
  };

  await bootstrapTrayPopup({ windowRef: { ...windowRef, tibotattleTrayPopover: bridge }, documentRef, client });
  assert.equal(loadCalls, 0);
  modelListener();
  assert.equal(loadCalls, 0);

  documentRef.visibilityState = "visible";
  documentRef.dispatch("visibilitychange");
  await tick();
  assert.equal(loadCalls, 1);
  assert.equal(documentRef.documentElement.attributes.get("data-tray-popup-ready"), "true");
});

test("native popup visibility gates visible-DOM loads and reopens on the host signal", async () => {
  const documentRef = new FakeDocument("visible");
  const windowRef = fakeWindow();
  let modelListener;
  let visibilityListener;
  let nativeVisible = false;
  let loadCalls = 0;
  const client = {
    async load() {
      loadCalls += 1;
      return {};
    },
  };
  const bridge = {
    getVisibility() {
      return nativeVisible;
    },
    onModel(listener) {
      modelListener = listener;
    },
    onVisibility(listener) {
      visibilityListener = listener;
    },
    requestAction() {},
  };

  await bootstrapTrayPopup({
    windowRef: { ...windowRef, tibotattleTrayPopover: bridge },
    documentRef,
    client,
  });
  assert.equal(loadCalls, 0);
  modelListener();
  documentRef.dispatch("visibilitychange");
  await tick();
  assert.equal(loadCalls, 0);

  nativeVisible = true;
  visibilityListener(true);
  await tick();
  assert.equal(loadCalls, 1);
  assert.equal(documentRef.documentElement.attributes.get("data-tray-popup-ready"), "true");
});

test("visible popup model events coalesce in-flight reads and fence one follow-up per burst", async () => {
  const documentRef = new FakeDocument("visible");
  const windowRef = fakeWindow();
  let modelListener;
  let loadCalls = 0;
  const resolvers = [];
  const client = {
    load() {
      loadCalls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };
  const bridge = {
    onModel(listener) {
      modelListener = listener;
    },
    requestAction() {},
  };

  const bootstrap = bootstrapTrayPopup({
    windowRef: { ...windowRef, tibotattleTrayPopover: bridge },
    documentRef,
    client,
  });
  await tick();
  assert.equal(loadCalls, 1);
  modelListener();
  modelListener();
  assert.equal(loadCalls, 1);
  resolvers.shift()({});
  await tick();
  assert.equal(loadCalls, 2);
  modelListener();
  modelListener();
  assert.equal(loadCalls, 2);
  resolvers.shift()({});
  await bootstrap;
  await tick();
  assert.equal(loadCalls, 3);
  resolvers.shift()({});
  await tick();
  assert.equal(loadCalls, 3);
});

test("tray bridge admits only the reviewed no-secret actions", () => {
  const calls = [];
  const bridge = { requestAction: (...args) => calls.push(args) };
  assert.equal(requestTrayPopupAction(bridge, "open"), true);
  assert.equal(requestTrayPopupAction(bridge, "refresh"), true);
  assert.equal(requestTrayPopupAction(bridge, "more"), true);
  assert.equal(requestTrayPopupAction(bridge, "weekly"), false);
  assert.equal(requestTrayPopupAction(bridge, "open", "unexpected"), false);
  assert.equal(requestTrayPopupAction(null, "open"), false);
  assert.deepEqual(calls, [["open"], ["refresh"], ["more"]]);
});
