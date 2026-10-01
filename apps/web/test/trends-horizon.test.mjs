import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { horizonAt, advanceHorizonTime, sampleAt, hourlySpend, createSpendRateLookup, resetMarkerGroups, mountTrendsHorizon, presentationSegments, differenceLobes } from "../public/trends-horizon.js";
import { translate, SUPPORTED_LOCALES } from "../public/localization.js";

test("the sun and moon cross midnight continuously, with an unmistakably brighter day", () => {
  const before = horizonAt(24 - 1 / 3600), after = horizonAt(1 / 3600);
  for (const body of ["sun", "moon"]) {
    for (const axis of ["x", "y", "opacity"]) assert.ok(Math.abs(before[body][axis] - after[body][axis]) < .01);
  }
  assert.deepEqual(horizonAt(0), horizonAt(24));
  const brightness = color => color.match(/\d+/g).map(Number).reduce((a, b) => a + b);
  assert.ok(brightness(horizonAt(12).bottom) > 3 * brightness(horizonAt(0).bottom));
  assert.equal(horizonAt(12).stars, 0);
  assert.equal(horizonAt(0).sun.opacity, 0);
  assert.equal(horizonAt(12).moon.opacity, 0);
});

test("history advances in one direction through midnight and repeated replay wraps", () => {
  const startMs = Date.parse("2026-09-07T00:00:00Z"), endMs = startMs + 7 * 86_400_000;
  const domain = { startMs, endMs };
  const midnight = startMs + 86_400_000;
  assert.ok(advanceHorizonTime(midnight - 1000, 100, domain) > midnight);
  let at = startMs, wraps = 0;
  for (let i = 0; i < 4000; i += 1) {
    const next = advanceHorizonTime(at, 100, domain);
    if (next < at) { wraps += 1; assert.ok(at > endMs - 2_000_000); }
    assert.ok(next >= startMs && next < endMs);
    at = next;
  }
  assert.ok(wraps >= 9);
  assert.equal(advanceHorizonTime(startMs, 100, { startMs, endMs: startMs }), startMs);
});

test("cursor samples never borrow future evidence, turn null into zero, or extrapolate across a stale gap", () => {
  const points = [{ timestampMs: 1000, remaining: 0 }, { timestampMs: 3000, remaining: null }, { timestampMs: 5000, remaining: 70 }];
  assert.equal(sampleAt(points, 999), null);
  assert.equal(sampleAt(points, 2999).remaining, 0);
  assert.equal(sampleAt(points, 4000).remaining, null);
  assert.equal(sampleAt(points, 9000, 2000), null);
  assert.equal(sampleAt([], 5000), null);
});

test("reservoir and cycle paths break at missing values, time gaps, and actual anchor changes", () => {
  const p = (timestampMs, value, cycle = 1, reanchor = false) => ({ timestampMs, value, cycle, reanchor });
  const rows = [p(0, 100), p(1, 90), p(2, null), p(3, 70), p(4, 100, 2), p(5, 90, 2), p(50, 60, 2)];
  assert.deepEqual(presentationSegments(rows, ["value"], { segmentKey: "cycle", maxGapMs: 10 }).map(r => r.length), [2, 1, 2, 1]);
  assert.deepEqual(presentationSegments([p(0, 2), p(1, 3), p(2, 0, 1, true), p(3, -1)], ["value"], { breakBefore: "reanchor" }).map(r => r.length), [2, 2]);
});

test("hourly readouts normalize the measured window and preserve unknown versus actual zero", () => {
  assert.equal(hourlySpend({ allowanceWeightedUsd: 180, measuredSpanMs: 3 * 3_600_000 }), 60);
  assert.equal(hourlySpend({ allowanceWeightedUsd: 15, measuredSpanMs: 30 * 60_000 }), 30);
  assert.equal(hourlySpend({ allowanceWeightedUsd: 0, measuredSpanMs: 3_600_000 }), 0);
  for (const amount of [null, undefined, -1, NaN, Infinity]) {
    assert.equal(hourlySpend({ allowanceWeightedUsd: amount, measuredSpanMs: 3_600_000 }), null);
  }
  for (const duration of [null, undefined, -1, 0, NaN, Infinity]) {
    assert.equal(hourlySpend({ allowanceWeightedUsd: 30, measuredSpanMs: duration }), null);
  }
  assert.equal(hourlySpend(null), null);
  assert.equal(hourlySpend({ allowanceWeightedUsd: Number.MAX_VALUE, measuredSpanMs: 1 }), null);
});

test("nearby reset markers group without dropping evidence or inventing a display timestamp", () => {
  const events = [90, 10, 25, 30, 35].map(timestampMs => ({ timestampMs }));
  const groups = resetMarkerGroups(events, event => event.timestampMs);
  assert.deepEqual(groups.map(group => group.map(event => event.timestampMs)), [[10, 25, 30], [35], [90]]);
  assert.deepEqual(groups.flat(), [...events].sort((a, b) => a.timestampMs - b.timestampMs));
  assert.deepEqual(resetMarkerGroups(events, event => event.timestampMs * 10).map(group => group.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(resetMarkerGroups([], event => event.timestampMs), []);
});

test("spending averages survive quota gaps and decay through covered quiet time", () => {
  const hour = 3_600_000, step = hour / 4;
  const buckets = [{ startMs: 0, endMs: step, usd: 90 }, { startMs: 5 * hour, endMs: 5 * hour + step, usd: 30 }];
  const at = createSpendRateLookup(buckets, { intervals: [[0, 6 * hour]] });
  assert.equal(at(step - 1), null, "unfinished buckets cannot reveal future cost");
  assert.equal(hourlySpend(at(step)), 360);
  assert.equal(hourlySpend(at(2 * hour)), 45, "last usage being over an hour old does not erase spending in the rolling window");
  assert.equal(hourlySpend(at(3 * hour)), 30);
  assert.equal(hourlySpend(at(3 * hour + step)), 0, "fully covered quiet time is a real recorded zero");
  assert.equal(hourlySpend(at(5 * hour + step)), 10);
  assert.equal(at(6 * hour), null, "do not extend beyond the retained usage horizon");
});

test("spending windows shorten at plan-coverage breaks instead of hiding valid activity or treating gaps as zero", () => {
  const step = 900_000;
  const buckets = [0, 1, 4, 5].map(i => ({ startMs: i * step, endMs: (i + 1) * step, usd: 10 }));
  const at = createSpendRateLookup(buckets, { intervals: [[0, 2 * step], [4 * step, 6 * step]] });
  assert.equal(at(3 * step), null);
  assert.equal(at(4 * step), null);
  assert.deepEqual(at(5 * step), { timestampMs: 5 * step, allowanceWeightedUsd: 10, measuredSpanMs: step });
  assert.equal(hourlySpend(at(5 * step)), 40);
  assert.equal(hourlySpend(at(6 * step)), 40);
  assert.equal(createSpendRateLookup(buckets)(3 * step), null, "legacy gaps have no implied coverage");
  assert.equal(createSpendRateLookup(buckets, { intervals: [] })(step), null);
});

test("spending cannot borrow future pricing or silently fill unpriced buckets", () => {
  const step = 900_000;
  const buckets = Array.from({ length: 20 }, (_, i) => ({ startMs: i * step, endMs: (i + 1) * step, usd: i === 2 ? null : 10 }));
  const at = createSpendRateLookup(buckets);
  assert.equal(hourlySpend(at(2.5 * step)), 40, "only completed buckets contribute");
  assert.equal(at(3 * step), null);
  assert.equal(at(14 * step), null);
  assert.equal(hourlySpend(at(15 * step)), 40, "the missing-price bucket has now left the three-hour window");
  assert.equal(createSpendRateLookup([...buckets, buckets[0]])(step), null, "overlapping buckets cannot double count");
  assert.equal(createSpendRateLookup([{ ...buckets[0], endMs: 2 * step }])(step), null);
});

test("header spending needs no quota-comparison chart, uses exact observations, and clears on an unavailable view", () => {
  class Element {
    constructor() { this.attributes = {}; this.children = []; this.style = {}; this.dataset = {}; this.isConnected = true; this.hidden = false; this.textContent = ""; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.unshift(child); }
    addEventListener() {}
    removeEventListener() {}
    querySelector(selector) { return elements.get(selector) ?? null; }
  }
  const elements = new Map(["#trends-time", "#trends-replay", "#trends-latest", ".trends-sky", ".trends-sun", ".trends-moon", ".trends-stars", "#trends-date", "#trends-clock", "#trends-allowance-value", "#trends-spend-value", "#trends-spend-basis"].map(key => [key, new Element()]));
  const win = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    cancelAnimationFrame() {}, MutationObserver: class { observe() {} disconnect() {} } };
  const document = { defaultView: win, createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}, removeEventListener() {} };
  const root = new Element(); root.ownerDocument = document;
  const controller = mountTrendsHorizon(root, { t: key => key, locale: "en-US", timeZone: "UTC", formatMoney: String, formatPercent: String, formatDuration: String });
  const hour = 3_600_000;
  const shell = new Element(); shell.id = "usage-timeline-chart";
  controller.register(shell, { svg: new Element(), points: [
    { timestampMs: 2 * hour, allowanceWeightedUsd: 120, measuredSpanMs: 3 * hour },
    { timestampMs: 3 * hour, allowanceWeightedUsd: null, measuredSpanMs: 3 * hour },
  ], series: [{ key: "observed", label: "Observed", format: String }], x: point => point.timestampMs / hour, y: value => value,
  domain: { startMs: 0, endMs: 4 * hour }, margin: { top: 12, bottom: 30, left: 72, right: 24 }, width: 900, height: 270 });
  controller.setAllowanceSamples([
    { timestampMs: 3.5 * hour, allowanceRemaining: 20 },
    { timestampMs: 2.5 * hour, allowanceRemaining: 90 },
    { timestampMs: 3 * hour, allowanceRemaining: null },
  ]);
  controller.setSpendLookup(createSpendRateLookup(Array.from({ length: 20 }, (_, i) => ({
    startMs: -hour + i * hour / 4, endMs: -hour + (i + 1) * hour / 4, usd: i === 16 ? null : 10,
  }))));
  controller.refresh();
  const text = selector => elements.get(selector).textContent;
  assert.equal(text("#trends-allowance-value"), "20", "the first refresh must populate data received after chart registration");
  controller.select(2.75 * hour);
  assert.equal(text("#trends-allowance-value"), "90", "a within-hour observation must not lag until the next chart bucket");
  assert.equal(text("#trends-spend-value"), "40");
  controller.select(3.25 * hour);
  assert.equal(text("#trends-allowance-value"), "—");
  assert.equal(text("#trends-spend-value"), "—");
  controller.select(2 * hour);
  assert.equal(text("#trends-allowance-value"), "—", "a future observation cannot be borrowed");
  shell.hidden = true;
  controller.refresh();
  assert.equal(text("#trends-spend-value"), "—");
  assert.equal(elements.get("#trends-time").disabled, true);
  controller.dispose();
});

test("difference fills split sign at the crossing and leave missing windows empty", () => {
  const points = [{ timestampMs: 0, observed: 4, expected: 2 }, { timestampMs: 10, observed: 0, expected: 2 }];
  const x = p => p.timestampMs, y = v => v;
  const result = differenceLobes(points, x, y);
  assert.equal(result.above, "M0,4L5,2L5,2L0,2Z");
  assert.equal(result.below, "M5,2L10,0L10,2L5,2Z");
  assert.deepEqual(differenceLobes([points[0], { ...points[1], observed: null }], x, y), { above: "", below: "" });
  assert.deepEqual(differenceLobes(points.map((p, residualSegment) => ({ ...p, residualSegment })), x, y), { above: "", below: "" });
});

test("all three analyses are visible and time navigation has one visible range control", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(html.indexOf('id="allowance-timeline-chart"') < html.indexOf('id="timeline-chart"'));
  assert.ok(html.indexOf('id="difference-timeline-chart"') < html.indexOf('id="residual-chart"'));
  assert.doesNotMatch(html, /<details class="advanced-calibration"/);
  assert.match(html, /class="calibration-controls" hidden/);
  assert.match(source, /activeCalibrationRangeDays = activeUsageRangeDays/);
  assert.match(source, /format: formatPp, breakBefore: "driftReanchor"/);
  assert.match(source, /series: \[\{\s*key: "cumulativeResidual"/);
});

test("Horizon messages are available in every shipped locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["trends.localClock", "trends.play", "trends.pause", "trends.allowance", "trends.driftCopy", "trends.noSample", "trends.headerAllowance", "trends.headerSpend", "trends.rollingAverage", "trends.resetObserved", "trends.resetBoundary", "trends.resetConfirmed", "trends.gapExplanation", "trends.viewPeriod"]) {
      const text = translate(key, {}, locale);
      assert.ok(text && text !== key);
    }
    assert.ok(translate("trends.sample", { time: "12:00" }, locale).includes("12:00"));
  }
});
