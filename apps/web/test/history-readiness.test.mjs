import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeDashboardPayload } from "../public/data-client.js";
import { historyIndexContinuationDecision } from "../public/lib.js";
import { finite, formatNumber, numberFormatter } from "../public/ui-format.js";
import { SUPPORTED_LOCALES, translate, translatePlural } from "../public/localization.js";

function completedScan(overrides = {}) {
  return {
    sourceMode: "unified",
    generationMatched: false,
    status: "partial",
    phase: "aggregate_unavailable",
    errorCode: "cache_missing",
    sourceCount: 3,
    indexedSourceCount: 3,
    pendingSourceCount: 0,
    skippedSourceCount: 0,
    skippedSourceBytes: 0,
    skippedThreadCount: 0,
    sourceBytes: 10_000,
    indexedBytes: 10_000,
    ...overrides,
  };
}

function dashboardFor(historyCoverage) {
  return normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    pricing: { historyCoverage },
  });
}

async function renderHistory(data, active = false, locale = "en-US") {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const functions = ["formatPercent", "renderHistoryIndexBadge", "renderHistoryProgress"]
    .map((name) => {
      const source = appSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "mu"))?.[0];
      assert.ok(source, `production ${name} function is present`);
      return source;
    });
  const unitsStart = appSource.indexOf("const BYTE_UNITS = Object.freeze(");
  const bytesEnd = appSource.indexOf("\n}\n", appSource.indexOf("function formatBytes(", unitsStart)) + 3;
  assert.ok(unitsStart >= 0 && bytesEnd > unitsStart);
  const elements = new Map();
  const select = (selector) => {
    if (!elements.has(selector)) {
      const attributes = new Map();
      const classes = new Set();
      elements.set(selector, {
        hidden: false,
        style: {},
        textContent: "",
        classes,
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: (name) => attributes.get(name),
        classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      });
    }
    return elements.get(selector);
  };
  const t = (key, values) => translate(key, values, locale);
  const tPlural = (key, count, values) => translatePlural(key, count, values, locale);
  const render = Function(
    "$", "finite", "formatNumber", "numberFormatter", "compact", "t", "tPlural",
    "setRawText", "setLocalizedText", "archiveHistoryScanActive",
    `${appSource.slice(unitsStart, bytesEnd)}\n${functions.join("\n")}\nreturn (data) => {
      renderHistoryProgress(data);
      renderHistoryIndexBadge(data);
    };`,
  )(
    select, finite, formatNumber, numberFormatter, (n) => formatNumber(n), t, tPlural,
    (element, text) => { element.textContent = String(text); },
    (element, key, values) => { element.textContent = t(key, values); }, active,
  );
  render(data);
  return select;
}

test("a fully scanned history keeps its accounting summary explicitly unavailable", () => {
  for (const errorCode of ["cache_missing", "cache_generation_mismatch", "cache_unavailable"]) {
    const data = dashboardFor(completedScan({ errorCode }));
    assert.equal(data.state, "live", "quota freshness remains separate from history readiness");
    assert.equal(data.pricing.historyCoverage.phase, "aggregate_unavailable");
    assert.equal(data.pricing.historyCoverage.status, "partial");
    assert.equal(data.pricing.historyCoverage.errorCode, errorCode);
    assert.equal(historyIndexContinuationDecision({ history: data.pricing.historyCoverage }).shouldContinue, false);
  }
});

test("finished scans retain excluded-source evidence and do not restart ingestion", () => {
  const data = dashboardFor(completedScan({
    indexedSourceCount: 1,
    indexedBytes: 4_000,
    skippedSourceCount: 2,
    skippedSourceBytes: 6_000,
    skippedThreadCount: 1,
  }));
  const history = data.pricing.historyCoverage;
  assert.equal(history.phase, "aggregate_unavailable");
  assert.equal(history.skippedSourceCount, 2);
  assert.equal(history.skippedThreadCount, 1);
  assert.equal(history.skippedSourceBytes, 6_000);
  assert.equal(historyIndexContinuationDecision({ history }).shouldContinue, false);
});

test("a completed-scan claim cannot conceal pending or incoherent source coverage", () => {
  for (const override of [
    { indexedSourceCount: 2 },
    { indexedBytes: 9_999 },
    { pendingSourceCount: 1 },
    { sourceMode: "legacy" },
    { skippedSourceCount: 1, skippedThreadCount: 1 },
    { skippedThreadCount: 1 },
    { status: "complete" },
  ]) {
    const history = dashboardFor(completedScan(override)).pricing.historyCoverage;
    assert.notEqual(history.phase, "aggregate_unavailable", JSON.stringify(override));
    assert.notEqual(history.status, "complete");
  }
  const history = dashboardFor(completedScan({ indexedSourceCount: 2, indexedBytes: 5_000 }))
    .pricing.historyCoverage;
  assert.equal(historyIndexContinuationDecision({ history }).shouldContinue, true);
});

test("completed scans render truthful copy at 100 percent even during an unrelated refresh", async () => {
  for (const active of [false, true]) {
    const select = await renderHistory(dashboardFor(completedScan()), active);
    assert.equal(select("#history-progress").hidden, false);
    assert.equal(select("#history-progress").classes.has("active"), false);
    assert.equal(select("#history-progress-headline").textContent, "History scan finished");
    assert.match(select("#history-progress-detail").textContent, /3 of 3 discovered sources indexed/u);
    assert.doesNotMatch(select("#history-progress-detail").textContent, /will change|advances/u);
    assert.match(select("#history-progress-note").textContent, /accounting summary is unavailable/u);
    assert.doesNotMatch(select("#history-progress-note").textContent, /continues|hidden|advancing/u);
    assert.equal(select("#history-progress-track").getAttribute("aria-valuenow"), "100");
    assert.equal(select("#history-progress-fill").style.width, "100%");
    assert.equal(select("#history-index-badge").hidden, true);
  }
});

test("finished scan rendering keeps excluded sources visible in the detail and badge", async () => {
  const select = await renderHistory(dashboardFor(completedScan({
    indexedSourceCount: 1,
    indexedBytes: 4_000,
    skippedSourceCount: 2,
    skippedSourceBytes: 6_000,
    skippedThreadCount: 1,
  })));
  assert.match(select("#history-progress-detail").textContent, /2 rollout sources that did not pass local validation/u);
  assert.equal(select("#history-index-badge").textContent, "History coverage · 2 unavailable");
  assert.doesNotMatch(select("#history-index-badge").textContent, /indexing/iu);
});

test("the completed-scan message is localized in every shipped locale", async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const select = await renderHistory(dashboardFor(completedScan()), false, locale);
    for (const id of ["headline", "detail", "note"]) {
      const text = select(`#history-progress-${id}`).textContent;
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /dashboard\.history|\{(?:indexed|total|bytesIndexed|bytesTotal)\}/u);
    }
  }
});
