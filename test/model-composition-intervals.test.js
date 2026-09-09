import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildCompositionObservations,
  buildCompositionObservationsFromOrderedUsage,
} from "../packages/quota-analysis/index.js";

const POLICY = { grainMs: 10, maxCrossingElapsedMs: 5, poolToleranceMs: 0 };

// Each descriptor is an independent pool with exactly one known crossing.
// This oracle deliberately does not reuse the kernel's interval representation,
// topology helpers, or membership search. Only small fixtures enter its Set loop.
function fixture(crossings, grainMs = POLICY.grainMs) {
  const pools = crossings.map(([first, last, delta = 1], index) => ({
    first, last, delta, planType: `synthetic-pool-${index}`, resetsAtMs: Number.MAX_SAFE_INTEGER,
  }));
  const quotaRows = pools.flatMap(pool => [
    { observedAtMs: pool.first, planType: pool.planType, resetsAtMs: pool.resetsAtMs, usedPercent: 0 },
    { observedAtMs: pool.last, planType: pool.planType, resetsAtMs: pool.resetsAtMs, usedPercent: pool.delta },
  ]);
  const bins = [...new Set(pools.map(pool => Math.floor(pool.last / grainMs) * grainMs))].sort((a, b) => a - b);
  const usageRows = bins.flatMap((bin, index) => [
    { observedAtMs: bin, model: "synthetic-model-b", costUsd: index + 0.25 },
    { observedAtMs: bin, model: "synthetic-model-a", costUsd: 2 },
    { observedAtMs: bin, model: "synthetic-model-b", costUsd: 0.5 },
  ]);
  return { pools, quotaRows, usageRows };
}

function legacySetOracle({ pools, usageRows }, policy) {
  const { grainMs, maxCrossingElapsedMs } = policy;
  const voided = new Set(), entries = [], counts = new Map(), binCosts = new Map();
  let steps = 0;
  for (const pool of pools) {
    const firstBin = Math.floor(pool.first / grainMs) * grainMs;
    const lastBin = Math.floor(pool.last / grainMs) * grainMs;
    if (pool.last - pool.first > maxCrossingElapsedMs) {
      for (let bin = firstBin; bin <= lastBin; bin += grainMs) {
        assert.ok(++steps <= 10_000, "legacy oracle only accepts bounded small fixtures");
        voided.add(bin);
      }
    } else {
      entries.push({ binStartMs: lastBin, poolKey: `${pool.planType}\0${pool.resetsAtMs}`, segmentIndex: 0, ppDelta: pool.delta });
      counts.set(lastBin, (counts.get(lastBin) ?? 0) + 1);
    }
  }
  for (const [bin, count] of counts) if (count > 1) voided.add(bin);
  for (const row of usageRows) {
    const bin = Math.floor(row.observedAtMs / grainMs) * grainMs;
    let costs = binCosts.get(bin);
    if (!costs) { costs = new Map(); binCosts.set(bin, costs); }
    costs.set(row.model, (costs.get(row.model) ?? 0) + row.costUsd);
  }
  return {
    observations: entries.filter(entry => !voided.has(entry.binStartMs) && entry.ppDelta > 0)
      .map(entry => ({ ...entry, costByModel: Object.fromEntries(binCosts.get(entry.binStartMs) ?? []) }))
      .filter(entry => Object.values(entry.costByModel).reduce((sum, value) => sum + value, 0) > 0)
      .sort((a, b) => a.binStartMs - b.binStartMs),
    voidedBinCount: voided.size,
    poolCount: pools.length,
  };
}

function assertParity(input, policy = POLICY, quotaRows = input.quotaRows) {
  const expected = legacySetOracle(input, policy);
  assert.deepEqual(buildCompositionObservations({ usageRows: input.usageRows, quotaRows }, policy), expected);
  function* usage() { for (const row of input.usageRows) yield row; }
  assert.deepEqual(buildCompositionObservationsFromOrderedUsage({ usageRows: usage(), quotaRows }, policy), expected);
  return expected;
}

test("interval union matches the legacy Set for overlapping, nested, adjacent and duplicate gaps", () => {
  for (const [ranges, count] of [
    [[[0, 50], [30, 80]], 9],
    [[[0, 80], [20, 40]], 9],
    [[[0, 20], [30, 50]], 6],
    [[[0, 20], [0, 20]], 3],
    [[[-50, -20], [-10, 20]], 8],
  ]) {
    const input = fixture(ranges);
    assert.equal(assertParity(input).voidedBinCount, count);
  }
});

test("ambiguity singletons join existing gaps without double counting or voiding neighboring observations", () => {
  const input = fixture([
    [0, 20],
    [21, 22], [23, 24], // Same bin as the gap's inclusive endpoint.
    [31, 32], [33, 34], // Adjacent ambiguity singleton extends that union.
    [51, 52], [53, 54], // Separate ambiguity singleton.
    [41, 42], [61, 62], // Unambiguous, positive-cost observations must survive.
  ]);
  const result = assertParity(input);
  assert.equal(result.voidedBinCount, 5);
  assert.deepEqual(result.observations.map(row => row.binStartMs), [40, 60]);
  assert.deepEqual(result.observations.map(row => row.ppDelta), [1, 1]);
});

test("shuffled quota input preserves exact Set-oracle membership and counts across generated small unions", () => {
  let state = 0x51a7;
  const random = bound => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % bound; };
  for (let sample = 0; sample < 64; sample++) {
    const crossings = Array.from({ length: 12 }, () => {
      const first = random(200) - 100;
      return [first, first + 1 + random(50), 1 + random(4)];
    });
    const input = fixture(crossings), shuffled = [...input.quotaRows];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const other = random(index + 1);
      [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
    }
    assertParity(input, POLICY, shuffled);
  }
});

test("large safe offsets retain exact small union cardinality without high-endpoint cancellation", () => {
  const base = Number.MAX_SAFE_INTEGER - 100;
  const policy = { grainMs: 1, maxCrossingElapsedMs: 0, poolToleranceMs: 0 };
  const input = fixture([[base, base + 30], [base + 90, base + 95], [base + 98, base + 99]], 1);
  assert.equal(assertParity(input, policy).voidedBinCount, 39);
});

test("integer endpoints with an unsafe overall span retain bounded legacy fallback semantics", () => {
  const negative = -Number.MAX_SAFE_INTEGER + 10, positive = Number.MAX_SAFE_INTEGER - 20;
  const policy = { grainMs: 1, maxCrossingElapsedMs: 0, poolToleranceMs: 0 };
  const input = fixture([[negative, negative + 3], [positive, positive + 2]], 1);
  assert.equal(assertParity(input, policy).voidedBinCount, 7);
});

test("fractional grain preserves the original repeated-addition Set keys and union count", () => {
  for (const grainMs of [0.1, 0.25, 1.5]) {
    const policy = { grainMs, maxCrossingElapsedMs: grainMs / 2, poolToleranceMs: 0 };
    const input = fixture([
      [grainMs * 2, grainMs * 8], [grainMs * 3, grainMs * 9],
      [grainMs * 6.1, grainMs * 6.4], [grainMs * 11.1, grainMs * 11.4],
    ], grainMs);
    assertParity(input, policy);
  }
});

test("a far-future two-row gap is exact under a small isolated heap without enumerating millions of bins", () => {
  const moduleUrl = new URL("../packages/quota-analysis/index.js", import.meta.url).href;
  const script = `
    import { buildCompositionObservations, buildCompositionObservationsFromOrderedUsage,
      MODEL_COMPOSITION_POLICY } from ${JSON.stringify(moduleUrl)};
    const first = Date.UTC(2026, 0, 1), last = Date.UTC(9998, 0, 1), reset = last + 604800000;
    const quotaRows = [{ observedAtMs:first, resetsAtMs:reset, planType:"pro", usedPercent:0 },
      { observedAtMs:last, resetsAtMs:reset, planType:"pro", usedPercent:1 }];
    const before = process.memoryUsage().heapUsed;
    const array = buildCompositionObservations({ quotaRows, usageRows:[] });
    const ordered = buildCompositionObservationsFromOrderedUsage({ quotaRows, usageRows:[][Symbol.iterator]() });
    const grain = MODEL_COMPOSITION_POLICY.grainMs;
    console.log(JSON.stringify({ array, ordered,
      expected:Math.floor(last/grain)-Math.floor(first/grain)+1,
      heapGrowth:process.memoryUsage().heapUsed-before }));
  `;
  // A legacy Set with ~35 million entries cannot pass this heap bound. The
  // subprocess deadline also contains a regression without hanging the suite.
  const child = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.expected > 30_000_000);
  assert.deepEqual(result.array, { observations: [], voidedBinCount: result.expected, poolCount: 1 });
  assert.deepEqual(result.ordered, result.array);
  assert.ok(result.heapGrowth < 8 * 1024 * 1024, `two-row interval heap growth: ${result.heapGrowth}`);
});
