import { modelUsagePresentation, modelThemeIcon } from "../public/model-visuals.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatModelName, finite } from "../public/ui-format.js";
import { translate, SUPPORTED_LOCALES } from "../public/localization.js";

test("model names format Astra while preserving reviewed names and unknown identifiers", () => {
  for (const [id, label] of [
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-sol", "GPT-6 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
    ["codex-auto-review", "Codex Auto Review"],
  ]) {
    assert.equal(formatModelName(id), label, id);
    assert.equal(formatModelName(` ${id.toUpperCase()} `), label, id);
  }
  assert.equal(formatModelName("gpt-5.6-sol-wm"), "GPT-5.6 Sol WM");
  assert.equal(formatModelName("gpt-5.2-preview"), "GPT-5.2 Preview");
  assert.equal(formatModelName("gpt-6-unreviewed"), "gpt-6-unreviewed");
  assert.equal(formatModelName(null), "");
});

function element(tag, className = "", text = "") {
  return {
    tag, className, textContent: text, children: [], dataset: {}, attributes: {}, listeners: {},
    classList: { add() {} },
    append(...children) { this.children.push(...children); },
    prepend(child) { this.children.unshift(child); },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
  };
}
const contents = (node) => node.textContent + node.children.map(contents).join("");

async function modelTable(locale) {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const body = element("tbody");
  const t = (key, values) => translate(key, values, locale);
  const environment = {
    $: (selector) => selector === "#accounting-models" ? body : null,
    clear: (node) => { node.children = []; },
    node: element,
    rawNode: element,
    localizedNode: (tag, className, key, values) => element(tag, className, t(key, values)),
    setRawText: (node, text) => { node.textContent = text; },
    setLocalizedText: (node, key) => { node.textContent = t(key); },
    t, finite, formatModelName, modelUsagePresentation, modelThemeIcon,
    formatSharePercent: (part, whole) => whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : null,
    formatCount: String,
    formatApiMoney: (value) => `$${value.toFixed(2)}`,
    formatPercent: (value) => `${value.toFixed(1)}%`,
    accountingModelsTablePagination: {},
    accountingExpandedModels: new Set(),
    paginateCacheImpactRows: (rows) => ({ rows }),
    cacheImpactTableSignature: () => "models",
    renderCacheImpactPagination() {},
    document: { createElementNS: (_namespace, tag) => element(tag) },
  };
  const start = source.indexOf("function modelUsageRows(accounting) {");
  const end = source.indexOf("function fastModeCoverageSentence(", start);
  assert.ok(start >= 0 && end > start);
  const render = Function(...Object.keys(environment),
    `${source.slice(start, end)}; return renderAccountingModels;`)(...Object.values(environment));
  return { render, body, t };
}

test("model table preserves unavailable, unreviewed, separate-allowance and priced states in each locale", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const { render, body, t } = await modelTable(locale);
    const rows = [
      { model: "gpt-6-astra", pricingStatus: "priced", apiPriceEquivalentUsd: 5 },
      { model: "unknown", pricingStatus: "unrecognized", apiPriceEquivalentUsd: 0 },
      { model: "unreviewed", pricingStatus: "unrecognized", apiPriceEquivalentUsd: 0 },
      { model: "gpt-5.3-codex-spark", pricingStatus: "known_unpriced", allowanceTrack: "spark", apiPriceEquivalentUsd: 0 },
      { model: "codex-auto-review", pricingStatus: "known_unpriced", apiPriceEquivalentUsd: 0 },
      { model: "gpt-5.5", pricingStatus: "priced", apiPriceEquivalentUsd: 0 },
    ].map((row) => ({ events: 1, totalTokens: 10, components: { input_cache_read_tokens: 10 }, ...row }));
    render({ modelUsage: rows, totalTokens: 50, apiPriceEquivalentUsd: 5 });
    const modelRows = body.children.filter((row) => !row.dataset.componentOf);
    const byName = (name) => modelRows.find((row) => contents(row.children[0]).replace("*", "") === name);
    const astra = byName("GPT-6 Astra");
    assert.equal(astra.children[0].children[2].title, "gpt-6-astra");
    assert.equal(contents(astra.children[4]), "$5.00");
    const astraIcon = astra.children[0].children.find((child) => child.getAttribute("class") === "allowance-model-icon");
    assert.equal(astraIcon.getAttribute("aria-hidden"), "true");
    assert.equal(astraIcon.getAttribute("focusable"), "false");
    const unavailable = byName(t("accounting.model.identityUnavailable"));
    assert.ok(unavailable, locale);
    assert.equal(unavailable.children[0].children[1].tag, "svg");
    assert.equal(unavailable.children[0].children[1].attributes["aria-hidden"], "true");
    assert.equal(unavailable.children[0].children[2].title, t("accounting.model.identityUnavailableTitle"));
    assert.equal(unavailable.children[4].title, t("accounting.model.identityUnavailableTitle"));
    assert.equal(contents(unavailable.children[4]), t("accounting.model.notPricedUnknown"));
    assert.equal(contents(unavailable.children[5]), t("accounting.model.shareWithheld"));
    assert.equal(unavailable.attributes["aria-label"], t("accounting.model.expand", { model: t("accounting.model.identityUnavailable") }));
    let prevented = false;
    unavailable.listeners.keydown({ key: "Enter", preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(unavailable.attributes["aria-expanded"], "true");
    assert.equal(unavailable.attributes["aria-label"], t("accounting.model.collapse", { model: t("accounting.model.identityUnavailable") }));
    assert.equal(contents(byName(t("accounting.model.unrecognized")).children[4]), t("accounting.model.notPricedUnknown"));
    assert.equal(contents(byName("GPT-5.3 Codex Spark").children[4]), t("accounting.model.separateAllowance"));
    assert.equal(contents(byName("Codex Auto Review").children[4]), t("accounting.model.noPublishedPrice"));
    assert.equal(contents(byName("GPT-5.5").children[4]), "$0.00");
    for (const name of [t("accounting.model.identityUnavailable"), t("accounting.model.unrecognized"), "Codex Auto Review"]) {
      const icon = byName(name).children[0].children.find((child) => child.getAttribute("class") === "allowance-model-icon");
      assert.ok(icon, name);
      assert.equal(icon.getAttribute("aria-hidden"), "true");
      assert.equal(icon.getAttribute("focusable"), "false");
    }
    assert.ok(byName("GPT-5.3 Codex Spark").children[0].children.some((child) => child.getAttribute("class") === "allowance-model-icon"));
    render({ modelUsage: [] }, { unavailable: true });
    assert.equal(contents(body), t("accounting.model.unavailable"));
    render({ modelUsage: [] });
    assert.equal(contents(body), t("accounting.model.noneInPeriod"));
  }
});

test("shared model icons preserve established aliases without inventing unknown identities", () => {
  const documentRef = { createElementNS: (_namespace, tag) => element(tag) };
  for (const [id, theme] of [
    ["gpt-6-astra", "astra"], ["gpt-6.1-sol", "sol"], ["gpt-6-sol", "sol"],
    ["gpt-6-luna", "luna"], ["gpt-5.6-sol-wm", "sol"],
    ["gpt-5.6-terra", "terra"], ["gpt-5.6-luna", "luna"],
    ["gpt-5.5-codex", "classic"], ["gpt-5.3-codex-spark", "spark"],
  ]) {
    const presentation = modelUsagePresentation(id);
    assert.equal(presentation.theme, theme);
    assert.equal(modelThemeIcon(documentRef, presentation.theme).tag, "svg");
  }
  for (const id of ["unknown", "gpt-6-unreviewed", null]) {
    assert.equal(modelUsagePresentation(id).theme, "generic");
    assert.equal(modelThemeIcon(documentRef, modelUsagePresentation(id).theme).tag, "svg");
  }
  assert.equal(modelUsagePresentation("codex-auto-review").theme, "review");
  assert.equal(modelThemeIcon(documentRef, "review").tag, "svg");
});


test("auto-review separate rows display the main-allowance zero without merging historical rows or changing Spark", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const { render, body, t } = await modelTable(locale);
    const usage = [
      { model: "codex-auto-review", allowanceTrack: "primary", apiPriceEquivalentApplicable: true, apiPriceEquivalentUsd: 3 },
      { model: "codex-auto-review", allowanceTrack: "separate", apiPriceEquivalentApplicable: false, apiPriceEquivalentUsd: 7 },
      { model: "gpt-5.3-codex-spark", allowanceTrack: "spark", apiPriceEquivalentApplicable: false, apiPriceEquivalentUsd: 0 },
    ].map(row => ({ pricingStatus: "priced", events: 1, totalTokens: 10, components: { input_cache_read_tokens: 10 }, ...row }));
    const accounting = { modelUsage: usage, totalTokens: 10, apiPriceEquivalentUsd: 3 };
    render(accounting);
    const modelRows = () => body.children.filter(row => !row.dataset.componentOf);
    const [historical, separate, spark] = modelRows();
    assert.equal(contents(historical.children[4]), "$3.00");
    assert.equal(contents(historical.children[5]), "100.0%");
    assert.equal(contents(separate.children[4]), "$0.00*");
    assert.equal(separate.children[4].title, t("accounting.model.separateMainAllowanceTitle"));
    assert.equal(separate.attributes["aria-describedby"], "accounting-model-allowance-footnote");
    assert.equal(separate.attributes["aria-label"], t("accounting.model.expand", {
      model: t("accounting.model.separateMainAllowanceLabel", { model: "Codex Auto Review" }),
    }));
    assert.notEqual(separate.attributes["aria-label"], historical.attributes["aria-label"]);
    const separateComponent = body.children[body.children.indexOf(separate) + 1];
    assert.equal(separateComponent.children[4].title, t("accounting.model.separateMainAllowanceTitle"));
    assert.equal(contents(separateComponent.children[4]), t("accounting.model.componentCostWithheld"));
    assert.equal(contents(separateComponent.children[3]), t("accounting.model.shareWithheld"));
    assert.equal(contents(separate.children[3]), t("accounting.model.shareWithheld"));
    assert.equal(contents(separate.children[5]), t("accounting.model.shareWithheld"));
    assert.equal(contents(spark.children[4]), t("accounting.model.separateAllowance"));
    assert.equal(usage[1].apiPriceEquivalentUsd, 7, "rendering must preserve the retained API quote");
    separate.listeners.click();
    render(accounting);
    assert.equal(modelRows()[0].attributes["aria-expanded"], "false");
    assert.equal(modelRows()[1].attributes["aria-expanded"], "true");
    assert.equal(modelRows()[2].attributes["aria-expanded"], "false");
    assert.equal(modelRows()[1].attributes["aria-label"], t("accounting.model.collapse", {
      model: t("accounting.model.separateMainAllowanceLabel", { model: "Codex Auto Review" }),
    }));
  }
});


test("metadata-qualified unknown models show main-allowance zero without inventing API-price evidence", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const { render, body, t } = await modelTable(locale);
    const usage = ["primary", "separate"].map(allowanceTrack => ({
      model: "unknown", pricingStatus: "unrecognized", allowanceTrack,
      apiPriceEquivalentApplicable: allowanceTrack === "primary",
      apiPriceEquivalentUsd: null, events: 1, totalTokens: 10,
      components: { input_cache_read_tokens: 10 }, componentCosts: null,
    }));
    render({ modelUsage: usage, events: 1, totalTokens: 10, apiPriceEquivalentUsd: 0 });
    const [ordinary, review] = body.children.filter(row => !row.dataset.componentOf);
    assert.equal(contents(ordinary.children[4]), t("accounting.model.notPricedUnknown"));
    assert.equal(contents(review.children[4]), "$0.00*");
    assert.equal(contents(review.children[0]).replace("*", ""), t("accounting.model.identityUnavailable"));
    assert.equal(contents(review.children[3]), t("accounting.model.shareWithheld"));
    assert.equal(contents(review.children[5]), t("accounting.model.shareWithheld"));
    assert.equal(usage[1].apiPriceEquivalentUsd, null);
    assert.equal(usage[1].componentCosts, null);
    const component = body.children[body.children.indexOf(review) + 1];
    assert.equal(contents(component.children[4]), t("accounting.model.componentCostWithheld"));
    assert.equal(component.children[4].title, t("accounting.model.separateMainAllowanceTitle"));
  }
});

test("the shared separate-allowance explanation is localized and linked from accessible rows", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="accounting-model-allowance-footnote"[^>]+data-i18n="accounting.model.separateAllowanceFootnote"/u);
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "accounting.model.separateMainAllowanceTitle",
      "accounting.model.separateMainAllowanceLabel",
      "accounting.model.separateAllowanceFootnote",
    ]) {
      const text = translate(key, { model: "GPT-6.1 Sol" }, locale);
      assert.notEqual(text, key);
      assert.ok(text.length > 0);
      if (key.endsWith("Title")) assert.match(text, /2026.*UTC/u);
    }
  }
});
