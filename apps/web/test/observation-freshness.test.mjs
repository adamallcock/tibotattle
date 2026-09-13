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
    tag, className, textContent, children: [], style: {}, attributes: {}, dataset: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  const container = node("div");
  const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
  const render = new Function("$", "clear", "node", "finite", "isPrimaryCodexQuotaWindow", "isSparkQuotaLimitId", "isValidQuotaWindowDuration", "selectPrimaryCodexQuotaWindow", "localizedQuotaWindowLabel", "providerReportedPlanEvidence", "setLocalizedText", "t", "formatPercent", "formatLocal", "formatTimeRemaining", "localizedQuotaWindowDuration", "isPrimaryCodexWeeklyQuotaWindow", "forecastTimestamp", "allowanceTimestamp", "CODEX_FIVE_HOUR_ALLOWANCE_MINUTES", `const closeInformationPopover = () => {}; ${body}; return renderQuotaCards;`)(
    () => container, element => { element.children = []; }, node, finite,
    () => true, () => false, () => true, windows => windows[0] ?? null,
    () => "Seven-day allowance", () => "", (element, key, params) => { element.textContent = key; element.params = params; },
    key => key, value => `${value}%`, value => value, () => "Remaining time",
    () => "7 days", () => true, value => value ? Date.parse(value) : null,
    (label, timestamp) => node("span", "allowance-timestamp", `${label}: ${timestamp}`), 300,
  );
  const descendants = element => [element, ...element.children.flatMap(descendants)];
  for (const remainingPercent of [null, undefined, -1, 101, 0, 61]) {
    render({ quotaWindows: [{ remainingPercent, status: "stale", durationMinutes: 10080, observedAt: "2026-09-13T12:00:00Z" }] });
    const card = container.children[0];
    const unknown = remainingPercent == null || remainingPercent < 0 || remainingPercent > 100;
    const progress = card.children.find(child => child.className === "quota-tank-fuel");
    assert.equal(Boolean(progress), !unknown);
    if (progress) {
      assert.equal(progress.attributes["aria-hidden"], "true");
      assert.equal(progress.style.blockSize, `${remainingPercent}%`);
    }
    const value = descendants(card).find(child => child.className === "quota-tank-value");
    assert.equal(value.textContent, unknown ? "—" : `${remainingPercent}%`);
    assert.equal(descendants(card).some(child => child.textContent === "allowance.stale"), true);
    assert.match(card.children.at(-1).textContent, /^allowance\.observation:/u);
  }
});
