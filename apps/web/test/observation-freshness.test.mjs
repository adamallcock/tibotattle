import test from "node:test";
import assert from "node:assert/strict";
import {
  createObservationFreshnessClock,
  observationFreshness,
  observationRecency,
} from "../public/dashboard-ui.js";
const fresh = { latestObservedAt: "2026-09-13T12:00:00Z", ageSeconds: 60, staleAfterSeconds: 1800 };
test("observation freshness stays independent of accounting and running jobs", () => {
  const now = Date.parse(fresh.latestObservedAt) + 60_000;
  for (const state of ["live", "stale", "updating", "insufficient"]) {
    assert.equal(observationFreshness(
      { state, freshness: { ...fresh, accountingStatus: "stale", ageSeconds: 999_999 } },
      now,
    ), "current");
  }
  assert.equal(observationFreshness({ freshness: fresh }, Date.parse(fresh.latestObservedAt) + 1_800_000), "current");
  assert.equal(observationFreshness({ freshness: fresh }, Date.parse(fresh.latestObservedAt) + 1_800_001), "stale");
});
test("missing or invalid observation evidence never claims current", () => {
  const now = Date.parse(fresh.latestObservedAt) + 60_000;
  for (const replacement of [{ latestObservedAt: null }, { latestObservedAt: "bad" }, { staleAfterSeconds: undefined }, { staleAfterSeconds: -1 }]) {
    assert.equal(observationFreshness({ freshness: { ...fresh, ...replacement } }, now), "unknown");
  }
  assert.equal(observationFreshness({ freshness: fresh }, Number.NaN), "unknown");
  assert.equal(observationFreshness({ freshness: fresh }, Date.parse(fresh.latestObservedAt) - 1), "unknown");
  assert.equal(observationFreshness(null, now), "unknown");
  assert.equal(observationFreshness({ mode: "demo", freshness: fresh }, now), "demo");
});

test("an open freshness clock crosses the stale boundary without a new payload", () => {
  let now = Date.parse(fresh.latestObservedAt) + 1_799_000;
  const timers = [];
  const cancelled = [];
  const states = [];
  const clock = createObservationFreshnessClock({
    onTick: (recency) => states.push(recency.status),
    now: () => now,
    schedule(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => cancelled.push(timer),
  });
  clock.update({ freshness: fresh });
  assert.deepEqual(states, ["current"]);
  assert.equal(timers[0].delay, 1_001);

  now += 1_001;
  timers.shift().callback();
  assert.deepEqual(states, ["current", "stale"]);
  assert.equal(observationRecency({ freshness: fresh }, now).ageSeconds, 1800.001);
  clock.stop();
  assert.equal(cancelled.length, 1);
});

test("dashboard stale transition qualifies allowance and pacing inputs together", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("function dashboardObservationPresentation"),
    source.indexOf("\nfunction renderObservationConnectionState"),
  );
  const project = new Function(`${body}; return dashboardObservationPresentation;`)();
  const input = {
    state: "live",
    freshness: { status: "live", latestObservedAt: fresh.latestObservedAt, staleAfterSeconds: 1800 },
    quotaWindows: [
      { id: "weekly", status: "live" },
      { id: "retained", status: "stale" },
    ],
  };
  const output = project(input, {
    status: "stale",
    latestObservedAt: "2026-09-13T12:00:00.000Z",
    ageSeconds: 1800.001,
    staleAfterSeconds: 1800,
  });
  assert.equal(output.state, "stale");
  assert.equal(output.freshness.status, "stale");
  assert.deepEqual(output.quotaWindows.map((window) => window.status), ["stale", "stale"]);
  assert.equal(input.state, "live");
  assert.equal(input.quotaWindows[0].status, "live");

  const unknown = project(input, {
    status: "unknown",
    latestObservedAt: null,
    ageSeconds: null,
    staleAfterSeconds: null,
  });
  assert.equal(unknown.state, "insufficient");
  assert.equal(unknown.freshness.status, "insufficient");
  assert.equal(unknown.quotaWindows[0].status, "stale");
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
    assert.equal(descendants(card).some(child => /^allowance\.observation:/u.test(child.textContent)), false,
      "observation time is disclosed once above the allowance section");
  }
});
