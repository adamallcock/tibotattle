import assert from "node:assert/strict";
import test from "node:test";

import {
  PERFORMANCE_HISTOGRAM_SCHEME_VERSION,
  SPEED_BUCKET_UPPER_CENTI_TPS,
  TTFT_BUCKET_UPPER_MS,
  TURN_DURATION_BUCKET_UPPER_MS,
  buildPerformanceHistogram,
  mergePerformanceHistograms,
  parsePerformanceHistogram,
  performanceHistogramQuantiles,
} from "../packages/telemetry-contract/src/performance-histogram.js";

function expectInvalid(callback) {
  assert.throws(callback, (error) => error?.code === "TELEMETRY_RECORD_INVALID");
}

function exactQuantile(values, probability) {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function ieeeNextDown(value) {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value);
  let bits = view.getBigUint64(0);
  bits = value > 0 ? bits - 1n : bits + 1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

function deterministicCohort(metric, size, random, variant) {
  return Array.from({ length: size }, (_, index) => {
    if (metric === "ttft" && (index + variant * 3) % 13 === 0) return 0;
    const exponent = metric === "speed"
      ? -3 + random() * 6
      : -1 + random() * 7;
    return metric === "speed"
      ? 10 ** exponent
      : Math.max(1, Math.floor(10 ** exponent));
  });
}

test("speed and TTFT schemes have bounded sparse bucket layouts", () => {
  assert.equal(PERFORMANCE_HISTOGRAM_SCHEME_VERSION, "performance-histogram-v1");
  assert.equal(SPEED_BUCKET_UPPER_CENTI_TPS.length, 60);
  assert.equal(SPEED_BUCKET_UPPER_CENTI_TPS.at(-1), 12000);
  assert.equal(TTFT_BUCKET_UPPER_MS.length, 57);
  assert.deepEqual(TTFT_BUCKET_UPPER_MS.slice(0, 3), [1, 500, 575]);
  assert.equal(TTFT_BUCKET_UPPER_MS.at(-1), 1089812);
  assert.ok(TTFT_BUCKET_UPPER_MS.every((value, index) => index === 0 || value > TTFT_BUCKET_UPPER_MS[index - 1]));
});

test("turn duration uses fixed positive millisecond bins and rejects unavailable zero", () => {
  assert.deepEqual(TURN_DURATION_BUCKET_UPPER_MS, TTFT_BUCKET_UPPER_MS);
  assert.equal(TURN_DURATION_BUCKET_UPPER_MS.length, 57);
  assert.equal(TURN_DURATION_BUCKET_UPPER_MS.at(-1), 1_089_812);

  const finalEdge = TURN_DURATION_BUCKET_UPPER_MS.at(-1);
  const histogram = buildPerformanceHistogram("turnDuration", [
    1,
    499,
    500,
    575,
    finalEdge,
    finalEdge + 1,
  ]);
  assert.deepEqual(histogram.buckets, { 1: 2, 2: 1, 3: 1, 57: 2 });
  assert.equal(histogram.min, 1);
  assert.equal(histogram.max, finalEdge + 1);
  assert.equal(performanceHistogramQuantiles(histogram).unit, "milliseconds");

  const empty = buildPerformanceHistogram("turnDuration", []);
  assert.equal(empty.min, null);
  assert.equal(empty.max, null);
  assert.equal(performanceHistogramQuantiles(empty).unit, "milliseconds");

  for (const value of [0, -1, 1.5, Number.NaN, Infinity]) {
    expectInvalid(() => buildPerformanceHistogram("turnDuration", [value]));
  }
});

test("empty, singleton, zero TTFT, edges, and overflow round-trip", () => {
  for (const metric of ["speed", "ttft"]) {
    const empty = buildPerformanceHistogram(metric, []);
    assert.deepEqual(parsePerformanceHistogram(empty), empty);
    assert.equal(empty.sampleCount, 0);
    assert.equal(empty.min, null);
    assert.equal(empty.max, null);
    assert.deepEqual(performanceHistogramQuantiles(empty), {
      methodVersion: "performance-histogram-type7-bounds-v1",
      approximate: true,
      unit: metric === "speed" ? "tokens_per_second" : "milliseconds",
      sampleCount: 0,
      p10: null, p25: null, median: null, p75: null, p90: null,
    });
  }
  const speed = buildPerformanceHistogram("speed", [0.01, 2, 2.01, 120, 120.01, 1000]);
  assert.deepEqual(speed.buckets, { 0: 1, 1: 2, 60: 3 });
  assert.equal(speed.min, 1);
  assert.equal(speed.max, 100000);
  const ttft = buildPerformanceHistogram("ttft", [0, 1, 499, 500, TTFT_BUCKET_UPPER_MS.at(-1), TTFT_BUCKET_UPPER_MS.at(-1) + 1]);
  assert.deepEqual(ttft.buckets, { 0: 1, 1: 2, 2: 1, 57: 2 });
  assert.equal(ttft.min, 0);
  assert.equal(ttft.max, TTFT_BUCKET_UPPER_MS.at(-1) + 1);
  assert.deepEqual(buildPerformanceHistogram("speed", [2]).buckets, { 1: 1 });
  assert.deepEqual(buildPerformanceHistogram("speed", [120]).buckets, { 60: 1 });
  assert.deepEqual(buildPerformanceHistogram("ttft", [499]).buckets, { 1: 1 });
  assert.deepEqual(buildPerformanceHistogram("ttft", [500]).buckets, { 2: 1 });
  assert.deepEqual(buildPerformanceHistogram("ttft", [575]).buckets, { 3: 1 });
});

test("values are snapshotted without mutating callers and speed bounds are conservative", () => {
  const values = [8.1, 8.2, 8.3, 9.4, 9.5];
  const before = [...values];
  const histogram = buildPerformanceHistogram("speed", values);
  assert.deepEqual(values, before);
  assert.equal(histogram.min, 810);
  assert.equal(histogram.max, 950);
  const quantiles = performanceHistogramQuantiles(histogram);
  for (const probability of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const name = probability === 0.5 ? "median" : `p${probability * 100}`;
    assert.ok(quantiles[name].lower <= exactQuantile(values, probability));
    assert.ok(quantiles[name].upper >= exactQuantile(values, probability));
  }
});

test("identical sparse payloads can hide different exact medians", () => {
  const left = [8.1, 8.2, 8.3, 9.4, 9.5];
  const right = [8.1, 8.5, 8.5, 8.9, 9.5];
  const leftHistogram = buildPerformanceHistogram("speed", left);
  const rightHistogram = buildPerformanceHistogram("speed", right);
  assert.deepEqual(leftHistogram, rightHistogram);
  assert.notEqual(exactQuantile(left, 0.5), exactQuantile(right, 0.5));
  const estimate = performanceHistogramQuantiles(leftHistogram).median;
  assert.ok(estimate.lower <= exactQuantile(left, 0.5));
  assert.ok(estimate.upper >= exactQuantile(left, 0.5));
  assert.ok(estimate.lower <= exactQuantile(right, 0.5));
  assert.ok(estimate.upper >= exactQuantile(right, 0.5));
});

test("sparse merge is method-agnostic, merge-tree invariant, and bounded", () => {
  const pages = [
    buildPerformanceHistogram("ttft", [0, 1, 500]),
    buildPerformanceHistogram("ttft", [575, 1000]),
    buildPerformanceHistogram("ttft", [TTFT_BUCKET_UPPER_MS.at(-1) + 1]),
  ];
  const direct = mergePerformanceHistograms(pages);
  const tree = mergePerformanceHistograms([mergePerformanceHistograms(pages.slice(0, 2)), pages[2]]);
  assert.deepEqual(tree, direct);
  assert.equal(direct.sampleCount, 6);
  assert.equal(Object.keys(direct.buckets).length, 6);
  assert.deepEqual(mergePerformanceHistograms([buildPerformanceHistogram("ttft", [])]), buildPerformanceHistogram("ttft", []));
  expectInvalid(() => mergePerformanceHistograms([]));
  expectInvalid(() => mergePerformanceHistograms([
    buildPerformanceHistogram("speed", [1]),
    buildPerformanceHistogram("ttft", [1]),
  ]));
  expectInvalid(() => mergePerformanceHistograms([
    buildPerformanceHistogram("turnDuration", [1]),
    buildPerformanceHistogram("ttft", [1]),
  ]));
  expectInvalid(() => mergePerformanceHistograms(new Array(201).fill(pages[0])));
});

test("quantile bands are null below five samples and all bounds contain exact local quantiles", () => {
  const short = performanceHistogramQuantiles(buildPerformanceHistogram("ttft", [1, 2, 3, 4]));
  assert.equal(short.median.estimate >= short.median.lower, true);
  assert.equal(short.p10, null);
  assert.equal(short.p25, null);
  assert.equal(short.p75, null);
  assert.equal(short.p90, null);
  const values = [0, 1, 499, 500, 575, 662, 761, 1000, 20_000, 2_000_000];
  const histogram = buildPerformanceHistogram("ttft", values);
  const result = performanceHistogramQuantiles(histogram);
  for (const [name, probability] of [["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9]]) {
    const exact = exactQuantile(values, probability);
    assert.ok(result[name].lower <= exact, `${name} lower bound`);
    assert.ok(result[name].upper >= exact, `${name} upper bound`);
  }
  const speedValues = [0.0001, 2, 2.01, 4, 8.1, 120, 120.01, 90_000_000_000_000];
  const speedResult = performanceHistogramQuantiles(buildPerformanceHistogram("speed", speedValues));
  for (const [name, probability] of [["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9]]) {
    const exact = exactQuantile(speedValues, probability);
    assert.ok(speedResult[name].lower <= exact, `${name} speed lower bound`);
    assert.ok(speedResult[name].upper >= exact, `${name} speed upper bound`);
  }
  const extremeSpeed = Number.MAX_SAFE_INTEGER / 100;
  const extremeSpeedQuantiles = performanceHistogramQuantiles(buildPerformanceHistogram("speed", [extremeSpeed]));
  assert.equal(extremeSpeedQuantiles.median.lower, extremeSpeed);
  assert.equal(extremeSpeedQuantiles.median.estimate, extremeSpeed);
  const extremeTtftQuantiles = performanceHistogramQuantiles(buildPerformanceHistogram("ttft", [Number.MAX_SAFE_INTEGER]));
  assert.equal(extremeTtftQuantiles.median.lower, Number.MAX_SAFE_INTEGER);
  assert.equal(extremeTtftQuantiles.median.estimate, Number.MAX_SAFE_INTEGER);
});

test("parser rejects unsafe, noncanonical, inconsistent, and private-shaped input", () => {
  const valid = buildPerformanceHistogram("speed", [1, 2]);
  const invalid = [
    { ...valid, extra: 1 },
    { ...valid, schemaVersion: "performance-histogram-v2" },
    { ...valid, metric: "private" },
    { ...valid, buckets: { ...valid.buckets, "01": 1 } },
    { ...valid, buckets: { 0: 1, 99: 1 }, sampleCount: 2 },
    { ...valid, buckets: { 0: 1 }, sampleCount: 2 },
    { ...valid, min: null },
    { ...valid, buckets: { ...valid.buckets, prompt: 1 } },
    { ...valid, buckets: Object.create({ privatePath: 1 }) },
    { ...valid, buckets: (() => { const value = { ...valid.buckets }; Object.defineProperty(value, "hidden", { value: 1, enumerable: false }); return value; })() },
  ];
  for (const value of invalid) expectInvalid(() => parsePerformanceHistogram(value));
  const speedSingleton = buildPerformanceHistogram("speed", [50]);
  expectInvalid(() => parsePerformanceHistogram({ ...speedSingleton, min: 4999 }));
  expectInvalid(() => parsePerformanceHistogram({ ...speedSingleton, min: 5000, max: 5100 }));
  expectInvalid(() => parsePerformanceHistogram({ ...speedSingleton, max: 5201 }));
  const ttftSingleton = buildPerformanceHistogram("ttft", [50]);
  expectInvalid(() => parsePerformanceHistogram({ ...ttftSingleton, min: 0 }));
  expectInvalid(() => parsePerformanceHistogram({ ...ttftSingleton, min: 1, max: 499 }));
  expectInvalid(() => parsePerformanceHistogram({ ...ttftSingleton, max: 500 }));
  const turnDurationSingleton = buildPerformanceHistogram("turnDuration", [50]);
  expectInvalid(() => parsePerformanceHistogram({ ...turnDurationSingleton, min: 49 }));
  expectInvalid(() => parsePerformanceHistogram({ ...turnDurationSingleton, max: 51 }));
  expectInvalid(() => parsePerformanceHistogram({
    ...turnDurationSingleton,
    buckets: { 0: 1 },
    min: 0,
    max: 0,
  }));
  const fractionalSpeedSingleton = buildPerformanceHistogram("speed", [50.005]);
  assert.equal(parsePerformanceHistogram(fractionalSpeedSingleton), fractionalSpeedSingleton);
  assert.ok(performanceHistogramQuantiles(fractionalSpeedSingleton).median.lower <= 50.005);
  assert.ok(performanceHistogramQuantiles(fractionalSpeedSingleton).median.upper >= 50.005);
  expectInvalid(() => buildPerformanceHistogram("speed", [0, 1]));
  expectInvalid(() => buildPerformanceHistogram("speed", [Number.NaN]));
  expectInvalid(() => buildPerformanceHistogram("speed", [Infinity]));
  expectInvalid(() => buildPerformanceHistogram("ttft", [-1]));
  expectInvalid(() => buildPerformanceHistogram("ttft", [1.5]));
  expectInvalid(() => buildPerformanceHistogram("speed", new Array(100_001).fill(1)));
});

test("seeded broad cohorts retain conservative Type-7 bounds across every sparse sample size", () => {
  const random = seededRandom(0x71_2a_2026);
  let cohorts = 0;
  for (const metric of ["speed", "ttft"]) {
    for (let size = 1; size <= 150; size += 1) {
      for (let variant = 0; variant < 2; variant += 1) {
        const values = deterministicCohort(metric, size, random, variant);
        const histogram = buildPerformanceHistogram(metric, values);
        const result = performanceHistogramQuantiles(histogram);
        assert.equal(result.sampleCount, size);
        assert.equal(result.approximate, true);
        assert.equal(result.unit, metric === "speed" ? "tokens_per_second" : "milliseconds");
        for (const [name, probability] of [["p10", .1], ["p25", .25], ["median", .5], ["p75", .75], ["p90", .9]]) {
          if (size < 5 && name !== "median") {
            assert.equal(result[name], null, `${metric} n=${size} ${name} sparse band`);
            continue;
          }
          const exact = exactQuantile(values, probability);
          assert.ok(result[name].lower <= exact, `${metric} n=${size} ${name} lower`);
          assert.ok(result[name].upper >= exact, `${metric} n=${size} ${name} upper`);
          assert.ok(result[name].estimate >= result[name].lower);
          assert.ok(result[name].estimate <= result[name].upper);
        }
        cohorts += 1;
      }
    }
  }
  assert.equal(cohorts, 600);
});

test("finite speed and TTFT edge predecessors use the intended upper-exclusive bucket", () => {
  for (const [index, upperCenti] of SPEED_BUCKET_UPPER_CENTI_TPS.entries()) {
    const edge = upperCenti / 100;
    assert.deepEqual(buildPerformanceHistogram("speed", [edge]).buckets, { [index + 1]: 1 });
    assert.deepEqual(buildPerformanceHistogram("speed", [ieeeNextDown(edge)]).buckets, { [index]: 1 });
  }
  for (const [index, edge] of TTFT_BUCKET_UPPER_MS.entries()) {
    assert.deepEqual(buildPerformanceHistogram("ttft", [edge]).buckets, { [index + 1]: 1 });
    assert.deepEqual(buildPerformanceHistogram("ttft", [edge - 1]).buckets, { [index]: 1 });
  }
});

test("turn duration edge predecessors use the fixed upper-exclusive buckets", () => {
  for (const [index, edge] of TURN_DURATION_BUCKET_UPPER_MS.entries()) {
    if (index === 0) {
      expectInvalid(() => buildPerformanceHistogram("turnDuration", [edge - 1]));
      assert.deepEqual(buildPerformanceHistogram("turnDuration", [edge]).buckets, { 1: 1 });
      continue;
    }
    assert.deepEqual(buildPerformanceHistogram("turnDuration", [edge - 1]).buckets, { [index]: 1 });
    assert.deepEqual(buildPerformanceHistogram("turnDuration", [edge]).buckets, { [index + 1]: 1 });
  }
});

test("merge rejects safe-count overflow before producing an unrepresentable total", () => {
  const count = Number.MAX_SAFE_INTEGER;
  const histogram = parsePerformanceHistogram({
    schemaVersion: PERFORMANCE_HISTOGRAM_SCHEME_VERSION,
    metric: "speed",
    sampleCount: count,
    buckets: { 0: count },
    min: 1,
    max: 1,
  });
  assert.equal(histogram.sampleCount, count);
  expectInvalid(() => mergePerformanceHistograms([histogram, histogram]));
});
