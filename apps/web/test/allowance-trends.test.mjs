import test from "node:test";
import assert from "node:assert/strict";
import { buildAllowanceTrends } from "../public/allowance-trends.js";

const DAY = 86_400_000;
const START = Date.parse("2026-06-01T00:00:00Z");
function series(values, spacing = 7, offset = 0) {
  return values.map((value, index) => ({ at: new Date(START + (offset + index * spacing) * DAY).toISOString(), value }));
}
function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

test("flat histories retain a flat LOWESS", () => {
  const input = series(Array(16).fill(2000));
  const result = buildAllowanceTrends(input);
  assert.equal(result.reason, null);
  assert.equal(result.lowessCount, 16);
  for (const point of result.points) close(point.allowanceLowess, 2000);
});

test("LOWESS recovers gradual linear change at actual irregular timestamps", () => {
  const days = [0, 3, 10, 14, 21, 28, 36, 42, 49, 55, 63, 70];
  const input = days.map((day) => ({ at: START + day * DAY, value: 2400 - day * 10 }));
  const result = buildAllowanceTrends(input);
  assert.equal(result.lowessCount, input.length);
  result.points.forEach((point, index) => close(point.allowanceLowess, input[index].value));
});

test("an isolated high estimate does not pull a flat robust trend upward", () => {
  const values = Array(17).fill(2000);
  values[8] = 8000;
  const result = buildAllowanceTrends(series(values));
  assert.equal(result.lowessCount, values.length);
  for (const point of result.points) close(point.allowanceLowess, 2000, 0.001);
});

test("missing, nonpositive and invalid data remain explicit and provide no fit support", () => {
  const input = series([2000, null, -1, 0, NaN, Infinity, "2000", 2000]);
  input.push({ at: "invalid-date", value: 2000 }, { at: null, value: 2000 });
  const result = buildAllowanceTrends(input);
  assert.equal(result.reason, "insufficient");
  assert.equal(result.lowessCount, 0);
  assert.ok(result.points.every((point) => point.allowanceLowess === null));
  assert.equal(buildAllowanceTrends([]).reason, "insufficient");
});

test("minimum support includes observed duration as well as reset count", () => {
  assert.equal(buildAllowanceTrends(series([2000, 2000, 2000], 14)).reason, "insufficient");
  assert.equal(buildAllowanceTrends(series(Array(10).fill(2000), 1)).reason, "insufficient");
  for (const count of [4, 5]) {
    const sparse = buildAllowanceTrends(series(Array(count).fill(2000), 7));
    assert.equal(sparse.reason, "insufficient");
    assert.equal(sparse.lowessCount, 0);
    assert.ok(sparse.points.every((point) => point.allowanceLowess === null));
  }
  const supported = buildAllowanceTrends(series(Array(6).fill(2000), 3));
  assert.equal(supported.reason, null);
  assert.equal(supported.lowessCount, 6);
});

test("gaps longer than 28 days break LOWESS lines", () => {
  const input = [...series(Array(8).fill(2200)), ...series(Array(8).fill(1300), 7, 100)];
  const result = buildAllowanceTrends(input);
  assert.equal(result.points[8].allowanceLowess, null);
  assert.equal(result.lowessCount, 15);
  assert.ok(result.points.slice(9).every((point) => point.allowanceLowess === 1300));
});

test("separate sparse blocks remain insufficient despite enough total observations", () => {
  const result = buildAllowanceTrends([...series(Array(5).fill(2200)), ...series(Array(5).fill(1300), 7, 100)]);
  assert.equal(result.reason, "insufficient");
  assert.equal(result.lowessCount, 0);
  assert.ok(result.points.every((point) => point.allowanceLowess === null));
});

test("invalid observations inside a supported block remain null line breaks", () => {
  const input = series(Array(12).fill(2000));
  input[6].value = null;
  const result = buildAllowanceTrends(input);
  assert.equal(result.reason, null);
  assert.equal(result.points[6].allowanceLowess, null);
  assert.equal(result.lowessCount, 11);
  close(result.points[5].allowanceLowess, 2000);
  close(result.points[7].allowanceLowess, 2000);
});

test("duplicate timestamps are excluded even when one duplicated estimate is invalid", () => {
  const input = series(Array(10).fill(2000));
  input.splice(5, 0, { at: input[4].at, value: 9000 });
  input.splice(8, 0, { at: input[7].at, value: null });
  const result = buildAllowanceTrends(input);
  for (const index of [4, 5, 7, 8]) {
    assert.equal(result.points[index].allowanceLowess, null);
  }
  assert.equal(result.lowessCount, 8);
});

test("large histories fail explicitly without truncating source observations", () => {
  const result = buildAllowanceTrends(series(Array(251).fill(2000), 1));
  assert.equal(result.reason, "tooMany");
  assert.equal(result.points.length, 251);
  assert.equal(result.lowessCount, 0);
  const boundary = buildAllowanceTrends(series(Array(250).fill(2000), 1));
  assert.equal(boundary.reason, null);
  assert.equal(boundary.lowessCount, 250);
});

test("fits are deterministic, do not mutate input, and stay within observed local values", () => {
  const input = series([1900, 2200, 1800, 2100, 7000, 2000, 1600, 1800, 1450, 1300, 1400, 1550]);
  const original = structuredClone(input);
  input.forEach(Object.freeze);
  Object.freeze(input);
  const result = buildAllowanceTrends(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result, buildAllowanceTrends(input));
  assert.notEqual(result.points, input);
  result.points.forEach((point, index) => {
    assert.notEqual(point, input[index]);
    const time = Date.parse(point.at);
    const distances = input.map((observation) => Math.abs(Date.parse(observation.at) - time)).sort((a, b) => a - b);
    const bandwidth = distances[5] * 1.000001;
    const local = input.filter((observation) => Math.abs(Date.parse(observation.at) - time) <= bandwidth).map((observation) => observation.value);
    assert.ok(point.allowanceLowess >= Math.min(...local));
    assert.ok(point.allowanceLowess <= Math.max(...local));
  });
});
