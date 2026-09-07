import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatModelName, finite } from "../public/ui-format.js";
import { translate, SUPPORTED_LOCALES } from "../public/localization.js";

test("model names format Astra while preserving reviewed names and unknown identifiers", () => {
  for (const [id, label] of [
    ["gpt-6-astra", "GPT-6 Astra"],
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
    t, finite, formatModelName,
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
    assert.equal(astra.children[0].children[1].title, "gpt-6-astra");
    assert.equal(contents(astra.children[4]), "$5.00");
    const unavailable = byName(t("accounting.model.identityUnavailable"));
    assert.ok(unavailable, locale);
    assert.equal(unavailable.children[0].children[1].title, t("accounting.model.identityUnavailableTitle"));
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
    render({ modelUsage: [] }, { unavailable: true });
    assert.equal(contents(body), t("accounting.model.unavailable"));
    render({ modelUsage: [] });
    assert.equal(contents(body), t("accounting.model.noneInPeriod"));
  }
});
