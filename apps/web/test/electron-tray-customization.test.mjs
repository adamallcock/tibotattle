import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TRAY_DEFAULTS, normalizeTrayPreferences, validTrayPreferences } from "../public/electron-tray-preferences.js";
import { createTraySettingsController } from "../public/electron-tray-settings.js";
import { applyTrayPopupPreferences, createTrayPopupProjection } from "../public/electron-tray-popup.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

class Element {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.classList = { toggle() {} }; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(k, f) { this.listeners.set(k, f); }
  removeEventListener(k) { this.listeners.delete(k); }
  querySelector(selector) { return this.all().find((n) => selector.startsWith("#") ? n.id === selector.slice(1) : selector.startsWith("[data-tray-move=") ? n.dataset.trayMove === selector.split('"')[1] : false) ?? null; }
  all() { return [this, ...this.children.flatMap((child) => child.all?.() ?? [])]; }
  focus() { this.doc.activeElement = this; }
  async dispatch(type) { this.listeners.get(type)?.({ target: this }); await new Promise((resolve) => setImmediate(resolve)); }
}
function documentFixture() {
  const document = { createElement(tag) { return new Element(tag, this); }, querySelector(selector) { return this.root.querySelector(selector); }, getElementById(id) { return this.querySelector(`#${id}`); } };
  document.root = document.createElement("div"); document.root.id = "settings-tray-controls";
  return document;
}
function text(element) { return element.all().map((node) => node.textContent).join(" "); }

test("renderer admits only the exact tray schema and enforces meaningful usage content", () => {
  assert.equal(validTrayPreferences(TRAY_DEFAULTS), true);
  for (const invalid of [{ ...TRAY_DEFAULTS, schemaVersion: 2 }, { ...TRAY_DEFAULTS, extra: true }, { ...TRAY_DEFAULTS, sections: ["usage", "usage"] }, { ...TRAY_DEFAULTS, metrics: ["requests"] }, { ...TRAY_DEFAULTS, showChart: false, metrics: [] }, { ...TRAY_DEFAULTS, preset: "both", barMetric: "reset" }]) assert.equal(validTrayPreferences(invalid), false);
  assert.equal(validTrayPreferences({ ...TRAY_DEFAULTS, sections: [], metrics: [], showChart: false }), true);
  const copy = normalizeTrayPreferences(TRAY_DEFAULTS); copy.sections.pop();
  assert.equal(TRAY_DEFAULTS.sections.length, 3);
});

test("settings saves full preferences, undoes and restores without optimistic persistence claims", async () => {
  const doc = documentFixture();
  const calls = [];
  const bridge = { async setTrayPreferences(tray) { calls.push(tray); return { settings: { tray } }; }, async restoreTrayDefaults() { return { settings: { tray: TRAY_DEFAULTS } }; } };
  const controller = createTraySettingsController({ documentRef: doc, bridge });
  controller.update({ tray: TRAY_DEFAULTS });
  const preset = doc.getElementById("tray-preset");
  preset.value = "both"; await preset.dispatch("change");
  assert.equal(calls.at(-1).preset, "both");
  assert.equal(calls.at(-1).barMetric, "remaining");
  assert.match(text(doc.root), /preferences saved/);
  const undo = doc.root.all().find((n) => n.textContent === "Undo last change");
  await undo.dispatch("click");
  assert.equal(calls.at(-1).preset, "weekly");
  assert.equal(undo.disabled, true);
  preset.value = "five-hour"; await preset.dispatch("change");
  await doc.root.all().find((n) => n.textContent === "Restore tray defaults").dispatch("click");
  assert.equal(preset.value, "weekly");
  controller.teardown();
});

test("a rejected save retains confirmed values and readable error; newer settings remain read only", async () => {
  const doc = documentFixture();
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences() { throw new Error("private path must never render"); }, async restoreTrayDefaults() { return { settings: { tray: TRAY_DEFAULTS } }; } } });
  controller.update({ tray: TRAY_DEFAULTS });
  const preset = doc.getElementById("tray-preset"); preset.value = "both";
  await preset.dispatch("change");
  assert.equal(preset.value, "weekly");
  assert.match(text(doc.root), /Could not save/);
  assert.doesNotMatch(text(doc.root), /private path/);
  controller.update({ tray: TRAY_DEFAULTS, traySettingsStatus: "future" });
  assert.equal(preset.disabled, true);
  assert.equal(doc.root.all().find((n) => n.textContent === "Restore tray defaults").disabled, true);
  assert.match(text(doc.root), /newer app version/);
});

test("section controls preserve exact order, keyboard focus and prevent empty visible usage", async () => {
  const doc = documentFixture(); const calls = [];
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences(tray) { calls.push(tray); return { settings: { tray } }; }, async restoreTrayDefaults() {} } });
  controller.update({ tray: TRAY_DEFAULTS });
  const move = doc.root.querySelector('[data-tray-move="usage-up"]'); move.focus(); await move.dispatch("click");
  assert.deepEqual(calls.at(-1).sections, ["allowances", "usage", "pace"]);
  assert.equal(doc.activeElement.dataset.trayMove, "usage-up");
  const usage = doc.getElementById("tray-section-usage"); usage.checked = false; usage.focus(); await usage.dispatch("change");
  assert.deepEqual(calls.at(-1).sections, ["allowances", "pace"]);
  assert.equal(doc.activeElement.id, "tray-section-usage");
});

test("preview states are isolated examples and partial allowances never borrow the available lane", async () => {
  const doc = documentFixture();
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences() {}, async restoreTrayDefaults() {} } });
  controller.update({ tray: { ...TRAY_DEFAULTS, preset: "both" } });
  const previewState = doc.root.all().find((n) => n.tagName === "select" && n.children.some((c) => c.value === "partial"));
  previewState.value = "partial"; await previewState.dispatch("change");
  assert.match(text(doc.root), /5h —/);
  assert.match(text(doc.root), /7d 8%/);
  assert.match(text(doc.root), /Example data only/);
});

test("popup composition applies selected metrics, density and cache evidence qualifiers", () => {
  const ids = ["tray-popup", "allowances-section", "usage-section", "pace-section", "cache-section", "history-tokens", "history-events", "history-price", "history-bars", "history-endpoints", "cache-period", "cache-summary", "cache-coverage", "cache-retained"];
  const elements = new Map(ids.map((id) => [id, { dataset: {}, style: {}, textContent: "", hidden: false }]));
  const doc = { getElementById(id) { return elements.get(id); } };
  const preferences = { ...TRAY_DEFAULTS, sections: ["cache", "usage"], metrics: ["cost"], showChart: false, density: "compact" };
  applyTrayPopupPreferences(doc, { accounting: { retained: true }, cacheSummary: { status: "available", comparableReturns: 10, reusedMoreThanHalfReturns: 8, reusePercent: 80, coverageStatus: "incomplete" } }, preferences);
  assert.equal(elements.get("allowances-section").hidden, true);
  assert.equal(elements.get("cache-section").style.order, "0");
  assert.equal(elements.get("history-tokens").hidden, true);
  assert.equal(elements.get("history-price").hidden, false);
  assert.equal(elements.get("history-bars").hidden, true);
  assert.equal(elements.get("tray-popup").dataset.density, "compact");
  assert.match(elements.get("cache-summary").textContent, /80% of comparable follow-ups/);
  assert.match(elements.get("cache-coverage").textContent, /incomplete/);
  assert.match(elements.get("cache-retained").textContent, /Last known/);
  applyTrayPopupPreferences(doc, { accounting: {}, cacheSummary: { status: "available", comparableReturns: 0, reusePercent: null, coverageStatus: "complete" } }, preferences);
  assert.match(elements.get("cache-summary").textContent, /No comparable/);
  assert.doesNotMatch(elements.get("cache-summary").textContent, /0%/);
  assert.equal(createTrayPopupProjection({ accounting: { trayCacheSummary: { periods: [{ periodId: "7d", status: "available", reusePercent: 80 }] } } }).cacheSummary, null);
});

test("every customization message is present in each shipped language", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["title", "saveFailed", "cachePercent", "platformTooltip", "example", "future"]) {
      const id = `electron.trayCustomization.${key}`;
      assert.notEqual(translate(id, { value: 80 }, locale), id);
    }
  }
});

test("tray customization uses the shared Settings typography instead of browser defaults", async () => {
  const css = await readFile(new URL("../public/electron-settings.css", import.meta.url), "utf8");
  assert.match(css, /settings-panel\[data-settings-panel="tray"\][\s\S]*?font-family: var\(--sans\)/u);
  assert.match(css, /\.settings-tray-group legend[\s\S]*?font-family: var\(--sans\)/u);
  assert.match(css, /\.settings-tray-checkbox[\s\S]*?font-family: var\(--sans\)/u);
  assert.match(css, /\.settings-tray-preview-popup > strong[\s\S]*?font-family: var\(--sans\)/u);
  assert.doesNotMatch(css, /#267466/u);
});


test("platforms without tray titles hide text controls but retain tooltip selection", () => {
  const doc = documentFixture();
  const controller = createTraySettingsController({ documentRef: doc, bridge: { async setTrayPreferences() {}, async restoreTrayDefaults() {} } });
  controller.update({ tray: TRAY_DEFAULTS, trayCapabilities: { title: false } });
  const metric = doc.getElementById("tray-barMetric");
  assert.equal(doc.root.all().find((n) => n.tagName === "label" && n.children.includes(metric)).hidden, true);
  assert.match(text(doc.root), /Tooltip information/);
  assert.match(text(doc.root), /text beside the icon is unavailable/);
  const preview = doc.root.all().find((n) => n.className === "settings-tray-preview-bar");
  assert.equal(preview.children.length, 1);
  assert.equal(preview.title, "7d 8%");
  controller.update({ tray: TRAY_DEFAULTS, trayCapabilities: { title: true } });
  assert.equal(doc.root.all().find((n) => n.tagName === "label" && n.children.includes(metric)).hidden, false);
});
