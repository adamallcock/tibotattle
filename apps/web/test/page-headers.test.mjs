import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const render = source.slice(source.indexOf("function renderLocalOnboarding(value) {"), source.indexOf("\nfunction renderDashboard(data) {"));

function onboardingHarness() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true, open: true, dataset: {}, classList: { toggle() {} },
      removeAttribute() {}, setAttribute() {}, append() {},
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: get, localOnboarding: null, dashboard: { collector: {} },
    runsInsideNativeDashboard: () => false,
    setJourneyState() {}, updateLocalActionButtons() {}, setGlobalState() {},
    onboardingSourceGuidance: () => ({ title: "Source needs attention", summary: "Check source", check: "Unavailable" }),
    localAnalysisAllowed: (value) => value.sourceStatus === "ready" && value.stateWritable,
    clear() {}, node: () => ({}), compact: String, t: (key) => translate(key, {}, "en"),
  });
  vm.runInContext(render, context);
  const ready = { state: "ready", sourceStatus: "ready", stateWritable: true, rolloutFilesPresent: true, rolloutFilesObserved: 3 };
  return { context, card: get("#setup-card"), ready, update: (value = ready) => context.renderLocalOnboarding(value) };
}

test("setup disclosure preserves manual expansion but opens when readiness needs attention", () => {
  const h = onboardingHarness();
  h.update();
  assert.equal(h.card.open, false);
  h.card.open = true;
  h.update();
  assert.equal(h.card.open, true, "a refresh preserves manual expansion");
  h.card.open = false;
  h.context.dashboard.collector.indexing = { status: "bounded_pause", filesProcessed: 1, filesSelected: 3 };
  h.update();
  assert.equal(h.card.open, true, "a bounded pass needs an accessible continuation action");
  h.context.dashboard.collector.indexing = null;
  h.update();
  assert.equal(h.card.open, false);
  h.update({ ...h.ready, stateWritable: false, stateStatus: "unwritable" });
  assert.equal(h.card.open, true, "an unwritable state must expose recovery guidance");
  h.context.dashboard.collector.indexing = { status: "recent_7d_indexing" };
  h.update();
  assert.equal(h.card.open, false, "ready setup stays compact while collection runs in the header");
  h.update({ state: "unavailable" });
  assert.equal(h.card.hidden, true, "unavailable onboarding is not a ready status");
});

test("setup stays expanded before any dashboard results exist", () => {
  const h = onboardingHarness();
  h.context.dashboard = null;
  h.update();
  assert.equal(h.card.open, true);
});

test("every static page header is available through the browser locale entrypoint", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const keys = [...html.matchAll(/data-i18n="(page\.[^"]+)"/gu)].map((match) => match[1]);
  assert.equal(keys.length, 10);
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      const value = translate(key, {}, locale);
      assert.ok(value && value !== key, `${locale} resolves ${key} instead of displaying its key`);
    }
  }
});

test("setup status labels resolve through the browser catalog", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["setup.title", "setup.ready"]) {
      assert.notEqual(translate(key, {}, locale), key);
    }
  }
});
