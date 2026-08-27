import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { LocalCompanionClient } from "../public/data-client.js";

test("loadQuick uses the fixed quick-overview route and the dashboard normalizer", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "local-companion-v0.1",
        mode: "real_local_evidence",
        evidenceStatus: "available",
        freshness: { status: "live" },
        quotaWindows: [{
          limitId: "codex",
          durationMinutes: 10_080,
          usedPercent: 25,
        }],
        pricing: {
          totalCostUsd: 2,
          periodLabel: "Last seven days",
          eventCount: 4,
        },
        // This is intentionally outside the quick overview. A normalized
        // quick result must not accidentally expose or depend on raw fields.
        privatePath: "/Users/private",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await client.loadQuick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/local/quick-overview");
  assert.equal(calls[0].options.method, undefined);
  assert.deepEqual(calls[0].options.headers, { Accept: "application/json" });
  assert.equal(result.schemaVersion, "local-companion-v0.1");
  assert.equal(result.state, "live");
  assert.equal(result.quotaWindows.length, 1);
  assert.equal(result.quotaWindows[0].remainingPercent, 75);
  assert.equal(result.usagePeriods.length, 0);
  assert.equal(result.pricing.eventCount, 4);
  assert.equal(result.pricing.totalCostUsd, 2);
  assert.equal(Object.hasOwn(result, "privatePath"), false);
});

test("Electron quick-result loading uses loadQuick while ordinary shells use load", async () => {
  const appSource = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const start = appSource.indexOf(
    "async function loadQuickResultDashboard({ lightweight = false } = {}) {",
  );
  const end = appSource.indexOf("\n}\n\n/**", start);
  assert.ok(start >= 0 && end > start, "quick-result loader should exist");
  const loaderSource = appSource.slice(start, end + 2);
  assert.match(loaderSource, /lightweight \? localClient\.loadQuick\(\) : localClient\.load\(\)/u);

  const calls = [];
  const context = vm.createContext({
    localClient: {
      load: async () => {
        calls.push("load");
        return { source: "full" };
      },
      loadQuick: async () => {
        calls.push("loadQuick");
        return { source: "quick" };
      },
      refreshStatus: async () => {
        calls.push("refreshStatus");
        return null;
      },
    },
    observeLocalRootCoverage: () => calls.push("observeCoverage"),
    renderQuickResultDashboard: (data) => calls.push(`render:${data.source}`),
    renderDashboard: (data) => calls.push(`render:${data.source}`),
    localOnboarding: null,
    renderLocalOnboarding: () => calls.push("renderOnboarding"),
  });
  vm.runInContext(`globalThis.loadQuickResultDashboard = ${loaderSource};`, context);

  await context.loadQuickResultDashboard({ lightweight: true });
  assert.deepEqual(calls, ["loadQuick", "refreshStatus", "render:quick"]);

  calls.length = 0;
  await context.loadQuickResultDashboard();
  assert.deepEqual(calls, ["load", "refreshStatus", "render:full"]);
});

test("quick state survives locale and control interactions without entering the full renderer", async () => {
  const appSource = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  const frameStart = appSource.indexOf(
    "function renderDashboardFrame(data, { quick = false } = {})",
  );
  const frameEnd = appSource.indexOf(
    "\n}\n\nfunction renderQuickResultDashboard",
    frameStart,
  );
  const quickStart = appSource.indexOf("function renderQuickResultDashboard(data)");
  const quickEnd = appSource.indexOf("\n}\n\nfunction renderDashboard(data)", quickStart);
  const fullStart = appSource.indexOf("function renderDashboard(data)");
  const fullEnd = appSource.indexOf("\n}\n\nfunction renderQuotaCards", fullStart);
  const localeStart = appSource.indexOf("function rerenderLocalizedDashboard() {");
  const localeEnd = appSource.indexOf(
    '\n}\n\nwindow.addEventListener("tibotattle:locale-change"',
    localeStart,
  );
  const rangeStart = appSource.indexOf('$("#range-controls").addEventListener("click",');
  const rangeEnd = appSource.indexOf('\n});\n$("#usage-zoom-in")', rangeStart);
  for (const [name, start, end] of [
    ["frame", frameStart, frameEnd],
    ["quick", quickStart, quickEnd],
    ["full", fullStart, fullEnd],
    ["locale", localeStart, localeEnd],
    ["range", rangeStart, rangeEnd],
  ]) {
    assert.ok(start >= 0 && end > start, `${name} source should exist`);
  }

  const calls = [];
  const element = {
    hidden: false,
    textContent: "",
    classList: { toggle() {} },
    setAttribute() {},
  };
  const rangeButton = {
    dataset: { days: "30" },
    classList: { toggle() {} },
    setAttribute() {},
  };
  let vmContext = null;
  const rangeControls = {
    addEventListener(type, handler) {
      if (type === "click") vmContext.rangeHandler = handler;
    },
    querySelectorAll() {
      return [rangeButton];
    },
  };
  const context = vm.createContext({
    Date,
    document: {},
    $: (selector) => selector === "#range-controls" ? rangeControls : element,
    calls,
    rangeHandler: null,
    localization: { localizeTree: () => calls.push(["localize"]) },
    getFormattingLocale: () => "en-US",
    t: (key) => key,
    renderSharedInstallerJourney: () => calls.push(["installer"]),
    retranslateLocalizedNodes: () => calls.push(["retranslate"]),
    renderGlobalState: () => calls.push(["global"]),
    renderDashboardUnavailableState: () => calls.push(["unavailable"]),
    setJourneyState: () => {},
    setGlobalState: () => {},
    renderElectronToolbarAllowance: () => {},
    renderHistoryIndexBadge: (data) => calls.push(["frame", data]),
    formatAge: () => "now",
    formatLocal: () => "now",
    showConnectionNotice: () => {},
    hideConnectionNotice: () => {},
    finite: () => null,
    renderQuotaCards: () => {},
    renderEvidenceWarnings: () => {},
    renderPricing: (data) => calls.push(["pricing", data]),
    renderCommunityJourney: (data) => calls.push(["community", data]),
    renderComparison: (data) => calls.push(["comparison", data]),
    renderUsageTimeline: (data) => calls.push(["usage", data]),
    renderTimeline: (data) => calls.push(["timeline", data]),
    renderWeekly: (data) => calls.push(["weekly", data]),
    renderAccounting: (data) => calls.push(["accounting", data]),
    resetUsageTimelineViewport: () => calls.push(["resetUsage"]),
    syncQuickDashboardControls: (busy) => calls.push(["controls", busy]),
  });
  vmContext = context;
  vm.runInContext(`
    let dashboard = null;
    let quickDashboard = null;
    let dashboardUnavailableState = null;
    let globalState = null;
    let activeUsageRangeDays = 7;
    globalThis.quickDashboardControlsBusy = () => quickDashboard !== null;
    ${appSource.slice(frameStart, frameEnd + 2)}
    ${appSource.slice(quickStart, quickEnd + 2)}
    ${appSource.slice(fullStart, fullEnd + 2)}
    ${appSource.slice(localeStart, localeEnd + 2)}
    ${appSource.slice(rangeStart, rangeEnd + 4)}
    globalThis.renderFull = renderDashboard;
    globalThis.renderQuick = renderQuickResultDashboard;
    globalThis.rerender = rerenderLocalizedDashboard;
    globalThis.runRange = (button) => globalThis.rangeHandler({
      target: { closest: () => button },
    });
    globalThis.state = () => ({ dashboard, quickDashboard });
  `, context);

  const full = {
    mode: "real_local_evidence",
    state: "live",
    freshness: { latestObservedAt: "", ageSeconds: 0 },
  };
  const quick = {
    mode: "real_local_evidence",
    state: "live",
    freshness: { latestObservedAt: "", ageSeconds: 0 },
  };
  const terminal = {
    mode: "real_local_evidence",
    state: "live",
    freshness: { latestObservedAt: "", ageSeconds: 0 },
  };

  context.renderFull(full);
  assert.equal(context.state().dashboard, full);
  assert.equal(context.state().quickDashboard, null);

  calls.length = 0;
  context.renderQuick(quick);
  assert.equal(context.state().dashboard, full);
  assert.equal(context.state().quickDashboard, quick);

  calls.length = 0;
  context.rerender();
  assert.ok(calls.some(([kind, data]) => kind === "frame" && data === quick));
  assert.ok(calls.some(([kind, data]) => kind === "pricing" && data === quick));
  assert.ok(calls.some(([kind, data]) => kind === "community" && data === quick));
  assert.equal(calls.some(([kind]) => kind === "comparison"), false);
  assert.equal(calls.some(([kind]) => kind === "usage"), false);
  assert.equal(context.state().dashboard, full);
  assert.equal(context.state().quickDashboard, quick);

  calls.length = 0;
  context.runRange(rangeButton);
  assert.equal(
    calls.some(([kind]) => ["usage", "comparison", "weekly"].includes(kind)),
    false,
    "range controls must not invoke heavy renderers during a quick result",
  );
  assert.equal(context.state().dashboard, full);
  assert.equal(context.state().quickDashboard, quick);

  calls.length = 0;
  context.renderFull(terminal);
  assert.equal(context.state().dashboard, terminal);
  assert.equal(context.state().quickDashboard, null);
  assert.equal(
    calls.filter(([kind]) => kind === "controls").length,
    1,
    "terminal full data must ask the control gate to restore interaction",
  );

  calls.length = 0;
  context.runRange(rangeButton);
  assert.ok(calls.some(([kind, data]) => kind === "usage" && data === terminal));
  assert.ok(calls.some(([kind, data]) => kind === "comparison" && data === terminal));
  assert.ok(calls.some(([kind, data]) => kind === "weekly" && data === terminal));
});
