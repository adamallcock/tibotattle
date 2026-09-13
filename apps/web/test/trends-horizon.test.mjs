import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { horizonAt, advanceHorizonTime, sampleAt, presentationSegments, differenceLobes } from "../public/trends-horizon.js";
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
    for (const key of ["trends.localClock", "trends.play", "trends.pause", "trends.allowance", "trends.driftCopy", "trends.noSample"]) {
      const text = translate(key, {}, locale);
      assert.ok(text && text !== key);
    }
    assert.ok(translate("trends.sample", { time: "12:00" }, locale).includes("12:00"));
  }
});
