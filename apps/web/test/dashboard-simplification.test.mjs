import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function productionFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, `exercise production ${name}`);
  return match[0];
}

test("collection retains companion readiness without an extra dashboard mode", () => {
  const ready = { state: "ready", sessionsReadable: true, rolloutFilesPresent: true,
    stateWritable: true, explicitRefresh: true };
  const context = createContext({ localOnboarding: ready });
  runInContext(productionFunction("localAnalysisAllowed"), context);
  assert.equal(context.localAnalysisAllowed(), true);
  assert.equal(context.localAnalysisAllowed(null), false);
  for (const change of [{ state: "unavailable" }, { sessionsReadable: false },
    { rolloutFilesPresent: false }, { stateWritable: false }, { explicitRefresh: false }]) {
    assert.equal(context.localAnalysisAllowed({ ...ready, ...change }), false);
  }
  assert.equal(context.localAnalysisAllowed({ ...ready, sessionsReadable: false,
    archivedSessionsReadable: true }), true);
});

test("accountless sharing uses the existing versioned Electron bridge", () => {
  const resolveBridge = new Function("ELECTRON_SHARING_API_VERSION",
    `${productionFunction("electronSharingBridge")}\nreturn electronSharingBridge;`)("v1");
  const bridge = { version: "v1", getSharingPreference() {}, setSharingEnabled() {}, sharingNoticePresented() {} };
  assert.equal(resolveBridge({ tibotattleDesktop: bridge }), bridge);
  assert.equal(resolveBridge({}), null);
  assert.equal(resolveBridge({ tibotattleDesktop: { ...bridge, version: "v2" } }), null);
  for (const method of ["getSharingPreference", "setSharingEnabled", "sharingNoticePresented"]) {
    assert.equal(resolveBridge({ tibotattleDesktop: { ...bridge, [method]: null } }), null);
  }
});

test("diagnostics keep fixed copy and require an exact write receipt", async () => {
  for (const outcome of ["recorded", "refused", "unreachable"]) {
    const calls = [];
    const errors = [];
    const context = createContext({
      createDiagnosticReference: () => "TT-ABC123",
      diagnosticErrorCode: value => value ?? null,
      serviceRequestId: () => null,
      diagnosticSurface: () => "local_refresh",
      diagnosticReferenceSentence: ({ writtenToLocalLog }) => writtenToLocalLog ? "Recorded." : "Reference only.",
      LOCAL_COMPANION_ERROR_COPY: { refresh_not_authorized: "Fixed collection failure." },
      localClient: { async recordDiagnosticNote(note) {
        calls.push(note);
        if (outcome === "unreachable") throw new Error("private untrusted error");
        return { status: "recorded", reference: outcome === "recorded" ? note.reference : "TT-OTHER1" };
      } },
      console: { error(message) { errors.push(message); } },
    });
    runInContext(productionFunction("fixedCopy"), context);
    runInContext(productionFunction("describeFailure"), context);
    const result = await context.describeFailure({ surface: "local_refresh",
      error: { code: "refresh_not_authorized", message: "private untrusted error" }, fallback: "Fallback." });
    assert.equal(result.text, `Fixed collection failure. ${outcome === "recorded" ? "Recorded." : "Reference only."}`);
    assert.equal(result.localNote, outcome);
    assert.equal(calls.length, 1);
    assert.equal(errors.length, outcome === "refused" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify([result, calls, errors]), /private untrusted error/u);
    const unknown = await context.describeFailure({ surface: "local_refresh",
      error: { code: "constructor", message: "private untrusted error" }, fallback: "Fallback." });
    assert.match(unknown.text, /^Fallback\./u);
  }
});

test("readiness retries remain bounded and generation fenced", async () => {
  const timers = [];
  const calls = [];
  let current = true;
  const context = createContext({
    localCompanionHealth: null, localOnboarding: null,
    localReadinessPollTimer: null, localReadinessPollCount: 0,
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } },
    loadLocalDashboardSecondaryState: async () => { calls.push("read"); },
  });
  runInContext(productionFunction("scheduleLocalReadinessPoll"), context);
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
  context.localCompanionHealth = { status: "ready" };
  context.localOnboarding = { state: "ready" };
  context.scheduleLocalReadinessPoll(() => current);
  assert.equal(timers.length, 0);
  context.localCompanionHealth = null;
  context.localReadinessPollCount = 450;
  context.scheduleLocalReadinessPoll(() => current);
  assert.equal(timers.length, 0);
});

test("the shared dashboard retains accountless controls and removes retired social presentation", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const text of [source, html, styles]) {
    assert.doesNotMatch(text, /identity-google-signin|identity-apple-signin|provider-button-google|provider-button-apple|beginHostedSignIn|approveIncrementalContribution|disconnect-device-dialog|usage-monitor-google-client-id/u);
  }
  assert.match(html, /id="electron-accountless-community-state"/u);
  assert.match(html, /id="electron-accountless-community-transport"/u);
  assert.match(html, /id="electron-accountless-sharing-enabled"/u);
  assert.doesNotMatch(html, /id="(?:refresh-button|setup-refresh)"[^>]*hidden/u);
  assert.doesNotMatch(source, /dashboardCapabilities|communityClient|prepareContribution\(|restoreCommunitySession|resumePendingHostedSignIn/u);
});
