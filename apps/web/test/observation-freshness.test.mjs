import test from "node:test";
import assert from "node:assert/strict";
import { observationFreshness } from "../public/dashboard-ui.js";
const fresh = { latestObservedAt: "2026-09-13T12:00:00Z", ageSeconds: 60, staleAfterSeconds: 1800 };
test("observation freshness stays independent of accounting and running jobs", () => {
  for (const state of ["live", "stale", "updating", "insufficient"]) {
    assert.equal(observationFreshness({ state, freshness: { ...fresh, accountingStatus: "stale" } }), "current");
  }
  assert.equal(observationFreshness({ freshness: { ...fresh, ageSeconds: 1800 } }), "current");
  assert.equal(observationFreshness({ freshness: { ...fresh, ageSeconds: 1801 } }), "stale");
});
test("missing or invalid observation evidence never claims current", () => {
  for (const replacement of [{ latestObservedAt: null }, { latestObservedAt: "bad" }, { ageSeconds: null }, { ageSeconds: -1 }, { ageSeconds: "60" }, { staleAfterSeconds: undefined }, { staleAfterSeconds: -1 }]) {
    assert.equal(observationFreshness({ freshness: { ...fresh, ...replacement } }), "unknown");
  }
  assert.equal(observationFreshness(null), "unknown");
  assert.equal(observationFreshness({ mode: "demo", freshness: fresh }), "demo");
});

test("quota cards preserve unknown percentages and label stale observations", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function renderQuotaCards(data) {"), source.indexOf("\nfunction providerReportedPlanEvidence"));
  const node = (tag, className = "", textContent = "") => ({
    tag, className, textContent, children: [], style: {}, attributes: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  const container = node("div");
  const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  const render = new Function("$", "clear", "node", "finite", "isPrimaryCodexQuotaWindow", "isSparkQuotaLimitId", "isValidQuotaWindowDuration", "selectPrimaryCodexQuotaWindow", "localizedQuotaWindowLabel", "providerReportedPlanEvidence", "setLocalizedText", "t", "formatPercent", "formatLocal", "formatTimeRemaining", `${body}; return renderQuotaCards;`)(
    () => container, element => { element.children = []; }, node, finite,
    () => true, () => false, () => true, windows => windows[0] ?? null,
    () => "Seven-day allowance", () => "", (element, key, params) => { element.textContent = key; element.params = params; },
    key => key, value => `${value}%`, value => value, () => "Remaining time",
  );
  for (const remainingPercent of [null, undefined, 0, 61]) {
    render({ quotaWindows: [{ remainingPercent, status: "stale", durationMinutes: 10080, observedAt: "2026-09-13T12:00:00Z" }] });
    const card = container.children[0];
    const progress = card.children.find(child => child.className === "mini-progress");
    assert.equal(progress.hidden, remainingPercent == null);
    assert.equal(progress.attributes["aria-hidden"], "true");
    const value = card.children.find(child => child.className === "metric-value");
    assert.equal(value.params.value, remainingPercent == null ? "—" : `${remainingPercent}%`);
    assert.equal(card.children[0].children.at(-1).textContent, "dashboard.quota.stale");
    assert.equal(card.children.at(-1).children[0].children[0].textContent, "dashboard.quota.usedUnknown");
  }
});
