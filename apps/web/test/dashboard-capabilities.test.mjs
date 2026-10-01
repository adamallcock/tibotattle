import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { dashboardCapabilities } from "../public/dashboard-capabilities.js";
import { mountDesktopShell } from "../public/desktop-shell.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const readonly = { collection: false, settings: false, accountlessSharing: false };
const windowWith = (capabilities, version = "v1") => ({
  tibotattleDesktop: { version, dashboardCapabilities: capabilities },
});
function productionFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, `exercise production ${name}`);
  return match[0];
}

test("dashboard capabilities default to read-only and require explicit booleans", () => {
  for (const windowRef of [undefined, {}, windowWith(undefined), windowWith(null),
    windowWith([]), windowWith(true), windowWith({ collection: true }, "v2"),
    windowWith({ collection: "true", settings: 1, accountlessSharing: {} }),
    windowWith(Object.create({ collection: true, settings: true, accountlessSharing: true })),
  ]) assert.deepEqual(dashboardCapabilities(windowRef), readonly);
  assert.deepEqual(dashboardCapabilities(windowWith({ collection: true })), {
    ...readonly, collection: true,
  });
  assert.deepEqual(dashboardCapabilities(windowWith({ settings: true })), {
    ...readonly, settings: true,
  });
  assert.deepEqual(dashboardCapabilities(windowWith({ accountlessSharing: true })), {
    ...readonly, accountlessSharing: true,
  });
  assert.ok(Object.isFrozen(dashboardCapabilities({})));
});

test("read-only actions cannot collect, cancel or acknowledge sharing", async () => {
  const calls = [];
  const context = createContext({
    window: windowWith(undefined),
    dashboardCapabilities: () => readonly,
    localActionBusy: false,
    localRefreshInProgress: true,
    localRefreshCancelRequested: false,
    localClient: new Proxy({}, { get: (_target, key) => () => { calls.push(key); } }),
    ELECTRON_SHARING_API_VERSION: "v1",
    localOnboarding: { state: "ready", sessionsReadable: true, rolloutFilesPresent: true,
      stateWritable: true, explicitRefresh: true },
  });
  for (const name of ["requestRefresh", "cancelLocalAnalysis", "localAnalysisAllowed", "electronSharingBridge"]) {
    runInContext(productionFunction(name), context);
  }
  await context.requestRefresh({ detailed: true });
  await context.cancelLocalAnalysis();
  assert.equal(context.localAnalysisAllowed(), false);
  assert.equal(context.electronSharingBridge(context.window), null);
  assert.deepEqual(calls, []);
});

test("diagnostics keep fixed error copy and write only with collection enabled", async () => {
  for (const collection of [false, true]) {
    const calls = [];
    const context = createContext({
      dashboardCapabilities: () => ({ collection }),
      createDiagnosticReference: () => "TT-ABC123",
      diagnosticErrorCode: value => value ?? null,
      serviceRequestId: () => null,
      diagnosticSurface: () => "local_refresh",
      diagnosticReferenceSentence: ({ writtenToLocalLog }) => writtenToLocalLog ? "Recorded." : "Reference only.",
      LOCAL_COMPANION_ERROR_COPY: { refresh_not_authorized: "Fixed collection failure." },
      localClient: { async recordDiagnosticNote(note) {
        calls.push(note);
        return { status: "recorded", reference: note.reference };
      } },
      console: { error() { assert.fail("a confirmed write never reports refusal"); } },
    });
    runInContext(productionFunction("fixedCopy"), context);
    runInContext(productionFunction("describeFailure"), context);
    const result = await context.describeFailure({ surface: "local_refresh",
      error: { code: "refresh_not_authorized", message: "private untrusted error" }, fallback: "Fallback." });
    assert.equal(result.text, `Fixed collection failure. ${collection ? "Recorded." : "Reference only."}`);
    assert.equal(result.localNote, collection ? "recorded" : "unreachable");
    assert.equal(calls.length, collection ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(result), /private untrusted error/u);
    const unknown = await context.describeFailure({ surface: "local_refresh",
      error: { code: "constructor", message: "private untrusted error" }, fallback: "Fallback." });
    assert.match(unknown.text, /^Fallback\./u);
  }
});

test("readiness retries are bounded, generation fenced and limited to collection hosts", async () => {
  const timers = [];
  const calls = [];
  let collection = false;
  let current = true;
  const context = createContext({
    dashboardCapabilities: () => ({ collection }),
    localCompanionHealth: null, localOnboarding: null,
    localReadinessPollTimer: null, localReadinessPollCount: 0,
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } },
    loadLocalDashboardSecondaryState: async () => { calls.push("read"); },
  });
  runInContext(productionFunction("scheduleLocalReadinessPoll"), context);
  context.scheduleLocalReadinessPoll(() => current);
  assert.equal(timers.length, 0);
  collection = true;
  context.scheduleLocalReadinessPoll(() => current);
  context.scheduleLocalReadinessPoll(() => current);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 4_000);
  current = false;
  timers.shift().callback();
  assert.deepEqual(calls, []);
  current = true;
  context.scheduleLocalReadinessPoll(() => current);
  timers.shift().callback();
  await Promise.resolve();
  assert.deepEqual(calls, ["read"]);
  assert.equal(context.localReadinessPollCount, 1);
  context.localReadinessPollCount = 450;
  context.scheduleLocalReadinessPoll(() => current);
  assert.equal(timers.length, 0);
});

test("sharing methods and desktop markers alone do not enable the sharing bridge", () => {
  const resolveBridge = new Function("dashboardCapabilities", "ELECTRON_SHARING_API_VERSION",
    `${productionFunction("electronSharingBridge")}\nreturn electronSharingBridge;`)(dashboardCapabilities, "v1");
  const bridge = { version: "v1", getSharingPreference() {}, setSharingEnabled() {}, sharingNoticePresented() {} };
  assert.equal(resolveBridge({ tibotattleDesktop: bridge }), null);
  bridge.dashboardCapabilities = { accountlessSharing: true };
  assert.equal(resolveBridge({ tibotattleDesktop: bridge }), bridge);
  delete bridge.sharingNoticePresented;
  assert.equal(resolveBridge({ tibotattleDesktop: bridge }), null);
});

test("read-only shell commands cannot open settings or start automatic collection", () => {
  let listener;
  const calls = [];
  const button = () => ({ hidden: true, addEventListener(_type, callback) { this.click = callback; },
    removeEventListener() {} });
  const settings = button();
  const refresh = { click() { calls.push("refresh"); } };
  const documentRef = { querySelector(selector) {
    return ({ "#electron-settings-button": settings, "#refresh-button": refresh })[selector] ?? null;
  } };
  const windowRef = { ...windowWith({}), dispatchEvent() { calls.push("event"); },
    tibotattleDesktop: { ...windowWith({}).tibotattleDesktop,
      openSettings() { calls.push("settings"); }, getSettings() { calls.push("getSettings"); },
      onCommand(callback) { listener = callback; return () => {}; },
    },
  };
  const mounted = mountDesktopShell({ documentRef, windowRef });
  assert.equal(settings.hidden, true);
  assert.equal(settings.disabled, true);
  settings.click();
  listener({ command: "refresh" });
  listener({ command: "automaticRefresh", mode: "detailed" });
  assert.deepEqual(calls, []);
  mounted.teardown();
});

test("retired social presentation is absent from the single dashboard source", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const text of [source, html, styles]) {
    assert.doesNotMatch(text, /identity-google-signin|identity-apple-signin|provider-button-google|provider-button-apple|beginHostedSignIn|approveIncrementalContribution|disconnect-device-dialog|usage-monitor-google-client-id/u);
  }
  assert.match(html, /id="refresh-button"[^>]*hidden[^>]*disabled/u);
  assert.match(html, /hidden\s+id="electron-settings-button"/u);
  assert.match(source, /dashboardCapabilities\(\)\.collection/u);
  assert.doesNotMatch(source, /communityClient|prepareContribution\(|restoreCommunitySession|resumePendingHostedSignIn/u);
});
