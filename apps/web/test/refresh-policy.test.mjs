import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function productionFunction(name) {
  const match = source.match(new RegExp(
    `^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu",
  ));
  assert.ok(match, `${name} is exercised from production source`);
  return match[0];
}

function refreshHarness({ rejection = null, native = false, electron = false, bridge = undefined } = {}) {
  const calls = [];
  const notices = [];
  const timers = [];
  const buttons = new Map();
  const priorDashboard = { mode: "local", state: "stale", activity: { lastScanAt: "2026-09-02T00:00:00.000Z" } };
  const context = createContext({
    dashboard: priorDashboard,
    localActionBusy: false,
    localRefreshInProgress: false,
    localRefreshCancelRequested: false,
    archiveHistoryScanActive: false,
    reindexAutoContinuations: 0,
    lastReindexProgressReceipt: null,
    returnRefreshScheduled: false,
    returnRefreshDeferrals: 0,
    electronStartupRefreshTriggered: false,
    ELECTRON_REFRESH_LIFECYCLE_SIGNAL_TIMEOUT_MS: 1_000,
    tibotattleDesktop: bridge,
    $: (selector) => {
      if (!buttons.has(selector)) buttons.set(selector, {
        textContent: "Refresh",
        addEventListener(name, handler) { this[name] = handler; },
      });
      return buttons.get(selector);
    },
    localClient: {
      async refresh() { calls.push("quick"); if (rejection) throw rejection; },
      async recalculateDetailedAccounting() { calls.push("detailed"); if (rejection) throw rejection; },
      async refreshStatus() { calls.push("status"); return { refresh: { status: "succeeded" } }; },
    },
    createRefreshPollingBudget: () => ({ hasTime: () => true }),
    historyProgressReceipt: () => "prior-generation",
    currentHistoryContinuationDecision: () => ({ terminalGap: false }),
    localAnalysisAllowed: () => true,
    runsInsideNativeDashboard: () => native,
    runsInsideElectronDashboard: () => electron,
    updateLocalActionButtons() {},
    setGlobalState() {},
    setTimeout: (resolve) => resolve(),
    clearTimeout() {},
    window: { setTimeout: (callback) => timers.push(callback) },
    showConnectionNotice: (notice) => notices.push(notice),
    refreshNeedsContinuation: () => false,
    scheduleReindexAutoContinuation: () => calls.push("continuation-check"),
    loadLocalDashboard: async () => calls.push("reload"),
    describeFailure: async () => { calls.push("diagnostic"); return { text: "An update could not be started." }; },
    t: (key) => translate(key, {}, "en-US"),
  });
  runInContext(productionFunction("signalElectronRefreshLifecycle"), context);
  runInContext(productionFunction("requestRefresh"), context);
  runInContext(productionFunction("scheduleReturningUserRefresh"), context);
  return { context, calls, notices, timers, buttons, priorDashboard };
}

test("both visible manual refresh controls request detailed accounting once", async (t) => {
  for (const selector of ["#refresh-button", "#setup-refresh"]) {
    await t.test(selector, async () => {
      const harness = refreshHarness();
      const binding = source.match(new RegExp(
        `\\$\\("${selector}"\\)\\.addEventListener\\("click", \\(\\) => \\{[\\s\\S]*?\\n\\}\\);`, "u",
      ));
      assert.ok(binding, `${selector} binds explicit manual intent`);
      runInContext(binding[0], harness.context);
      // A DOM event cannot accidentally supply the quick/default options.
      harness.buttons.get(selector).click({ type: "click", detailed: false });
      await new Promise(setImmediate);
      assert.deepEqual(harness.calls, ["detailed", "status", "reload", "continuation-check"]);
      assert.equal(harness.context.localActionBusy, false);
      assert.equal(harness.context.localRefreshInProgress, false);
      assert.equal(harness.context.dashboard, harness.priorDashboard,
        "refresh does not clear the last-good result while replacing evidence");
    });
  }
});

test("the shared default and automatic browser return refresh stay quick", async () => {
  const direct = refreshHarness();
  await direct.context.requestRefresh();
  assert.deepEqual(direct.calls, ["quick", "status", "reload"]);

  const returning = refreshHarness();
  returning.context.scheduleReturningUserRefresh();
  assert.equal(returning.timers.length, 1);
  returning.timers[0]();
  await new Promise(setImmediate);
  assert.deepEqual(returning.calls, ["quick", "status", "reload"]);

  const native = refreshHarness({ native: true });
  native.context.scheduleReturningUserRefresh();
  assert.deepEqual(native.timers, [], "the native host retains sole cadence ownership");
  assert.deepEqual(native.calls, []);
});

test("Electron startup performs one guarded quick refresh after readiness", async () => {
  const harness = refreshHarness({ electron: true });
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  assert.equal(harness.context.startElectronStartupRefresh(), true);
  assert.equal(harness.context.electronStartupRefreshTriggered, true);
  assert.equal(harness.context.startElectronStartupRefresh(), false);
  await new Promise(setImmediate);

  assert.deepEqual(harness.calls, ["quick", "status", "reload"]);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshInProgress, false);
});

test("qualified Electron startup waits for the preload smoke barrier", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = refreshHarness({ electron: true });
  harness.context.__TIBOTATTLE_ELECTRON_MACOS_SMOKE__ = {
    version: "v1",
    waitForStartupRefresh: () => gate,
  };
  runInContext(productionFunction("startElectronStartupRefresh"), harness.context);

  assert.equal(harness.context.startElectronStartupRefresh(), true);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, [], "the renderer waits for qualified observation");

  release();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(harness.calls, ["quick", "status", "reload"]);
});

test("accepted Electron refreshes acquire and settle the main-process lease", async () => {
  const lifecycle = [];
  const harness = refreshHarness({
    electron: true,
    bridge: {
      refreshStarted() {
        lifecycle.push("started");
        return 41;
      },
      refreshSettled({ lease }) {
        lifecycle.push(["settled", lease]);
        return true;
      },
    },
  });

  await harness.context.requestRefresh();
  await new Promise(setImmediate);

  assert.deepEqual(harness.calls, ["quick", "status", "reload"]);
  assert.deepEqual(lifecycle, ["started", ["settled", 41]]);
});

test("an initial controller conflict is informational and cannot queue detailed work", async () => {
  const harness = refreshHarness({ rejection: { status: 409 } });
  await harness.context.requestRefresh({ detailed: true });
  assert.deepEqual(harness.calls, ["detailed"],
    "the rejected request does not post again, escalate, or claim a detailed completion");
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].kind, "info");
  assert.match(harness.notices[0].copy, /did not start another update/u);
  assert.match(harness.notices[0].copy, /choose Refresh again if detailed accounting still needs updating/u);
  assert.equal(harness.context.dashboard, harness.priorDashboard);
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localRefreshInProgress, false);
});

test("a non-conflict request failure remains a failure and a busy page makes no request", async () => {
  const failed = refreshHarness({ rejection: { status: 503 } });
  await failed.context.requestRefresh({ detailed: true });
  assert.deepEqual(failed.calls, ["detailed", "diagnostic"]);
  assert.equal(failed.notices[0].kind, "error");
  assert.equal(failed.context.localActionBusy, false);

  const busy = refreshHarness();
  busy.context.localActionBusy = true;
  await busy.context.requestRefresh({ detailed: true });
  assert.deepEqual(busy.calls, []);
  assert.equal(busy.context.localActionBusy, true, "another action's busy state is preserved");
});

test("already-running guidance is translated and the duplicate action copy is retired", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["refresh.alreadyRunningTitle", "refresh.alreadyRunningCopy"]) {
      const copy = translate(key, {}, locale);
      assert.ok(copy.length > 0 && copy !== key, `${locale}: ${key}`);
    }
  }
  assert.doesNotMatch(source, /recalculate-detailed-accounting|refresh\.recalculateDetailed/u);
});
