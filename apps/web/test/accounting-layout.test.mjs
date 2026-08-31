import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function appFunction(name, nextName, dependencies) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} is available`);
  return Function(...Object.keys(dependencies),
    `${appSource.slice(start, end)}\nreturn ${name};`)(...Object.values(dependencies));
}

function localizedDependencies(locale = "en-US") {
  return {
    t: (key, values) => translate(key, values, locale),
    formatCount: String,
    formatApiMoney: (value) => `$${value.toFixed(2)}`,
  };
}

test("the live price headline shows one amount and moves its Standard comparison into help", () => {
  const headline = appFunction("accountingPriceHeadline", "renderAccounting", localizedDependencies());
  const period = Object.freeze({
    fastMode: { metricShortLabel: "Speed-priced API equivalent" },
    quotaWeightedApiPriceEquivalentUsd: 6_200,
    apiPriceEquivalentUsd: 5_929.64,
    periodLabel: "Last 7 days",
  });
  const [label, explanation, value, note] = headline(period);
  assert.equal(label, "Speed-priced API equivalent");
  assert.equal(value, "$6200.00");
  assert.equal(note, "Last 7 days");
  assert.match(explanation, /not a bill or a subscription limit/u);
  assert.match(explanation, /\$5929\.64 at Standard rates before Fast weighting/u);
  assert.doesNotMatch(note, /\$|Standard|Fast/u);
  assert.match(appSource, /:\s*\[\s*accountingPriceHeadline\(accounting\),/u);

  const samePrice = headline({ ...period, quotaWeightedApiPriceEquivalentUsd: 5_929.64 });
  assert.equal(samePrice[2], "$5929.64");
  assert.equal(samePrice[3], "Last 7 days");
  const absent = headline({ ...period, quotaWeightedApiPriceEquivalentUsd: null });
  assert.equal(absent[2], "—");
  assert.equal(absent[3], "No increment in this period could be weighted");
  assert.doesNotMatch(absent[1], /\$/u);
  assert.equal(headline({ ...period, quotaWeightedApiPriceEquivalentUsd: 0 })[2], "$0.00");
});

test("short accounting headings retain Standard-rate context in every locale", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const table = html.match(/<table class="cache-continuity-recent-table">[\s\S]*?<\/table>/u)?.[0];
  assert.ok(table);
  assert.equal((table.match(/<th\b/gu) ?? []).length, 5);
  assert.match(table, /column\.configuration">Configuration<\/th>/u);
  assert.doesNotMatch(table, /lostTokens|Estimated lost reuse|Unchanged configuration/u);
  assert.equal((html.match(/<th[^>]+data-i18n-title="accounting\.apiEquivalent\.standardRateBasis"[^>]*>API equivalent<\/th>/gu) ?? []).length, 3);
  for (const kind of ["cacheSwitch", "cacheContinuity"]) {
    const caption = html.match(new RegExp(`data-i18n="accounting\\.${kind}\\.tableCaption">([^<]+)<`, "u"))?.[1];
    assert.equal(caption, translate(`accounting.${kind}.tableCaption`, {}, "en-US"));
  }
  assert.deepEqual(SUPPORTED_LOCALES.map((locale) => translate("accounting.cacheContinuity.column.configuration", {}, locale)),
    ["Configuration", "配置", "Configuración"]);
  for (const kind of ["cacheSwitch", "cacheContinuity"]) {
    assert.deepEqual(SUPPORTED_LOCALES.map((locale) => translate(`accounting.${kind}.column.apiEquivalent`, {}, locale)),
      ["API equivalent", "API 等值", "Equivalente de API"]);
  }
  for (const locale of SUPPORTED_LOCALES) {
    const headline = appFunction("accountingPriceHeadline", "renderAccounting", localizedDependencies(locale));
    const row = headline({ fastMode: { metricShortLabel: "API" }, quotaWeightedApiPriceEquivalentUsd: 2, apiPriceEquivalentUsd: 1, periodLabel: "period" });
    assert.match(row[1], /\$1\.00/u);
    assert.doesNotMatch(row[1], /accounting\.|\{amount\}/u);
    assert.doesNotMatch(translate("accounting.apiEquivalent.standardRateBasis", {}, locale), /accounting\./u);
  }
});

test("cache continuity rows and empty states retain five correctly aligned cells", () => {
  const element = (tagName, className = "", textContent = "") => ({ tagName, className, textContent, children: [], append(...items) { this.children.push(...items); } });
  const disclosure = { hidden: true, open: false };
  const rows = element("tbody");
  const render = appFunction("renderAccountingCacheContinuityDetails", "sideChatConfigurationDescription", {
    $: (selector) => ({ "#cache-continuity-details": disclosure, "#cache-continuity-rows": rows })[selector] ?? null,
    clear: (target) => { target.children.length = 0; },
    node: element,
    rawNode: element,
    localizedNode: (tag, className, key) => element(tag, className, translate(key, {}, "en-US")),
    renderAccountingCacheReuseOutcome: () => {},
    renderCacheImpactPagination: () => {},
    cacheContinuityTablePagination: { page: 0, signature: "" },
    paginateCacheImpactRows: (values) => ({ rows: values }),
    cacheImpactTableSignature: () => "test",
    formatLocal: (value) => value,
    formatCacheContinuityGap: (value) => `${value}s`,
    cacheContinuityConfigurationDescription: () => "GPT-5.6 Sol · High",
    ...localizedDependencies(),
  });
  const recent = { observedAt: "synthetic time", gapSeconds: 60, previousCacheReadTokens: 100, currentCacheReadTokens: 20, lostCacheTokens: 80, estimatedPremiumUsd: 0.25 };
  render({ status: "available", recent: [recent] });
  assert.equal(disclosure.hidden, false);
  assert.deepEqual(rows.children[0].children.map((cell) => cell.textContent),
    ["synthetic time", "60s", "GPT-5.6 Sol · High", "100 → 20", "$0.25"]);
  render({ status: "available", recent: [{ ...recent, estimatedPremiumUsd: null }] });
  assert.equal(rows.children[0].children.length, 5);
  assert.equal(rows.children[0].children[4].textContent, "—");
  render({ status: "available", recent: [] });
  assert.equal(rows.children[0].children.length, 1);
  assert.equal(rows.children[0].children[0].colSpan, 5);
  assert.match(rows.children[0].children[0].textContent, /No qualifying/u);
  render(null);
  assert.equal(disclosure.hidden, true);
  assert.equal(rows.children.length, 0);
});

test("one chart-level note describes only actual global exclusions", () => {
  const base = { status: "available", coverageStatus: "complete", orderingCoverageGaps: 0, uncoveredReturns: 0, unpricedDrops: 0 };
  for (const locale of SUPPORTED_LOCALES) {
    const note = appFunction("cacheReuseCoverageNote", "renderAccountingCacheReuseOutcome", localizedDependencies(locale));
    assert.equal(note(base), "");
    assert.equal(note(null), "");
    assert.equal(note({ ...base, status: "unavailable", unpricedDrops: 1 }), "");
    const ordering = note({ ...base, coverageStatus: "incomplete", orderingCoverageGaps: 1 });
    assert.match(ordering, /1/u);
    assert.doesNotMatch(ordering, /accounting\.|\{count\}|(?:^|\D)0(?:\D|$)/u);
    const price = note({ ...base, unpricedDrops: 3 });
    assert.match(price, /3/u, "unpriced drops are disclosed even with complete ordering coverage");
    const boundary = note({ ...base, uncoveredReturns: 2 });
    assert.match(boundary, /2/u);
    const combined = note({ ...base, coverageStatus: "incomplete", orderingCoverageGaps: 1, uncoveredReturns: 2, unpricedDrops: 3 });
    for (const count of [1, 2, 3]) assert.ok(combined.includes(String(count)));
    assert.equal(note(base), "", "coverage clears when the selected period becomes complete");
    if (locale === "en-US") {
      assert.match(ordering, /not a complete period total/u);
      assert.match(ordering, /uncertain event order: 1/u);
      assert.doesNotMatch(ordering, /unavailable|without supported prices/u);
      assert.match(price, /without supported prices: 3/u);
    }
  }
});

test("speed attribution occupies a disclosure row without displacing overhead cards", async () => {
  const [styles, source] = await Promise.all([
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(source, /node\("p", "annotation accounting-speed-coverage"\)/u);
  assert.match(
    styles,
    /\.accounting-summary > \.accounting-speed-coverage\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/u,
  );
  // This rule still stretches a lone allowance card, but must not mistake the
  // accounting disclosure for a card when deciding which metric is alone.
  assert.match(
    styles,
    /\.metric-grid:not\(\.accounting-summary\) > :last-child:nth-child\(odd\)/u,
  );
  assert.doesNotMatch(styles, /\.metric-grid > :last-child:nth-child\(odd\)/u);
});
