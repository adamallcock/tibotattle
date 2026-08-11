import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_COMPOSITION_POLICY,
  blendedCompositionCapacityUsd,
  buildCompositionObservations,
  calibrateCompositionCapacities,
  compositionExpectedPp,
  solveNonNegativeLeastSquares,
} from "../index.js";

const HOUR_MS = 60 * 60 * 1_000;
const GRAIN_MS = MODEL_COMPOSITION_POLICY.grainMs;

// Deterministic pseudo-noise so recovery tests exercise a non-trivial corpus
// without flaking.
function noise(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) - 0.5;
}

function syntheticObservations({
  capacities,
  observationCount = 60,
  noisePp = 0,
}) {
  const models = Object.keys(capacities);
  return Array.from({ length: observationCount }, (_, index) => {
    const costByModel = {};
    let ppDelta = 0;
    for (const [modelIndex, model] of models.entries()) {
      // Vary the mix across observations so the design matrix has rank.
      const cost = 50 + 40 * Math.abs(noise(index * 7 + modelIndex * 13));
      const share = (index + modelIndex) % (models.length + 1) === 0 ? 0.2 : 1;
      costByModel[model] = cost * share;
      ppDelta += costByModel[model] * 100 / capacities[model];
    }
    ppDelta += noisePp * noise(index * 3 + 1);
    return { binStartMs: index * GRAIN_MS, ppDelta, costByModel };
  });
}

test("NNLS solves a plain non-negative system exactly", () => {
  // x = [2, 0.5] with a well-conditioned design.
  const rows = [
    [1, 0],
    [0, 2],
    [1, 1],
    [2, 1],
  ];
  const target = rows.map(([a, b]) => a * 2 + b * 0.5);
  const { solution, converged } = solveNonNegativeLeastSquares(rows, target);
  assert.equal(converged, true);
  assert.ok(Math.abs(solution[0] - 2) < 1e-8);
  assert.ok(Math.abs(solution[1] - 0.5) < 1e-8);
});

test("NNLS clamps negative-optimal coordinates to zero", () => {
  // Unconstrained least squares wants a negative weight on the second
  // column; NNLS must zero it and stay non-negative.
  const rows = [
    [1, 1],
    [1, 1.01],
    [1, 0.99],
  ];
  const target = [1, 0.97, 1.03];
  const { solution, converged } = solveNonNegativeLeastSquares(rows, target);
  assert.equal(converged, true);
  for (const value of solution) {
    assert.ok(value >= 0);
    assert.ok(Number.isFinite(value));
  }
});

test("calibration recovers known per-model capacities within tolerance", () => {
  const capacities = {
    "gpt-5.6-sol": 2_500,
    "gpt-5.6-terra": 900,
    "gpt-5.5": 2_200,
  };
  const observations = syntheticObservations({ capacities, noisePp: 0.4 });
  const fit = calibrateCompositionCapacities(observations, {
    minimumModelCostShare: 0.01,
  });
  assert.equal(fit.status, "fitted");
  assert.equal(fit.solverConverged, true);
  for (const [model, expected] of Object.entries(capacities)) {
    const fitted = fit.capacityUsdByModel[model];
    assert.ok(Number.isFinite(fitted), `${model} capacity missing`);
    assert.ok(
      Math.abs(fitted - expected) / expected < 0.05,
      `${model}: fitted ${fitted} not within 5% of ${expected}`,
    );
  }
  assert.ok(fit.r2 > fit.singleConstantR2);
});

test("a noiseless single-model corpus reproduces its constant exactly", () => {
  const observations = syntheticObservations({
    capacities: { "gpt-5.5": 2_200 },
    noisePp: 0,
  });
  const fit = calibrateCompositionCapacities(observations);
  // With one model the composition fit cannot beat the (identical) single
  // constant, so the honest answer is the blended fallback, never a fake
  // multi-model vector.
  assert.equal(fit.status, "fallback_blended");
  assert.ok(Math.abs(fit.singleConstantUsd - 2_200) < 1);
  assert.equal(fit.capacityUsdByModel, null);
});

test("a perfectly collinear corpus degrades to the blended constant, never NaN", () => {
  // Two models always spent in exact lockstep are unidentifiable.
  const observations = Array.from({ length: 40 }, (_, index) => {
    const cost = 80 + 15 * Math.abs(noise(index));
    return {
      binStartMs: index * GRAIN_MS,
      ppDelta: (2 * cost) * 100 / 1_800,
      costByModel: { "model-a": cost, "model-b": cost },
    };
  });
  const fit = calibrateCompositionCapacities(observations, {
    minimumModelCostShare: 0.01,
  });
  assert.equal(fit.status, "fallback_blended");
  assert.equal(fit.capacityUsdByModel, null);
  assert.ok(Number.isFinite(fit.singleConstantUsd));
  // Total cost per observation is 2·cost, and that total consumes pp at
  // $1,800/100pp, so the blended constant reproduces exactly that.
  assert.ok(Math.abs(fit.singleConstantUsd - 1_800) < 1);
  assert.equal(Number.isNaN(fit.singleConstantUsd), false);
  assert.equal(Number.isNaN(fit.r2 ?? 0), false);
});

test("a NEAR-collinear corpus falls back instead of shipping a confident noise split", () => {
  // One true constant, split into two pseudo-models at a random 50-70%
  // fraction per bin: the models are identical by construction, so any
  // per-model divergence the solver finds is noise. Raw R² still ties or
  // marginally beats the constant (the constant is nested in the NNLS
  // feasible set), which is exactly why the gate must be df-adjusted and
  // stability-checked rather than a raw nested-R² comparison.
  let seed = 999;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const observations = Array.from({ length: 120 }, (_, index) => {
    const cost = 60 + 45 * Math.abs(noise(index * 5 + 2));
    const fraction = 0.5 + 0.2 * rand();
    return {
      binStartMs: index * GRAIN_MS,
      // True capacity $2,000/100pp with mild noise on the movement.
      ppDelta: cost * 100 / 2_000 + 0.35 * noise(index * 11 + 3),
      costByModel: {
        "pseudo-a": cost * fraction,
        "pseudo-b": cost * (1 - fraction),
      },
    };
  });
  const fit = calibrateCompositionCapacities(observations);
  assert.equal(fit.status, "fallback_blended");
  assert.equal(fit.capacityUsdByModel, null);
  assert.ok(Math.abs(fit.singleConstantUsd - 2_000) < 40);
  assert.ok(fit.identification !== undefined);
});

test("a thin corpus reports insufficient observations with the constant intact", () => {
  const observations = syntheticObservations({
    capacities: { "gpt-5.6-sol": 2_500 },
  }).slice(0, 5);
  const fit = calibrateCompositionCapacities(observations);
  assert.equal(fit.status, "insufficient_observations");
  assert.equal(fit.capacityUsdByModel, null);
  assert.ok(Number.isFinite(fit.singleConstantUsd));
});

test("an empty corpus is typed, not thrown or NaN", () => {
  const fit = calibrateCompositionCapacities([]);
  assert.equal(fit.status, "insufficient_observations");
  assert.equal(fit.capacityUsdByModel, null);
  assert.equal(fit.singleConstantUsd, null);
  assert.equal(fit.observationCount, 0);
});

test("models below the cost-share floor fold into the other column", () => {
  const capacities = { "gpt-5.6-sol": 2_500, "gpt-5.6-terra": 900 };
  const observations = syntheticObservations({ capacities, noisePp: 0.2 })
    .map((observation, index) => ({
      ...observation,
      costByModel: {
        ...observation.costByModel,
        // A sliver model: far below the 2% share floor.
        "gpt-5.4-mini": 0.05 + 0.01 * Math.abs(noise(index)),
      },
    }));
  const fit = calibrateCompositionCapacities(observations);
  assert.equal(fit.status, "fitted");
  assert.equal(Object.hasOwn(fit.capacityUsdByModel, "gpt-5.4-mini"), false);
  assert.equal(
    Object.hasOwn(fit.capacityUsdByModel, MODEL_COMPOSITION_POLICY.otherModelKey),
    true,
  );
});

test("expected movement sums per-model cost over the fitted capacities", () => {
  const calibration = {
    capacityUsdByModel: { "gpt-5.6-sol": 2_500, "gpt-5.6-terra": 900 },
    fallbackCapacityUsd: 2_000,
  };
  const mixed = compositionExpectedPp(
    { "gpt-5.6-sol": 25, "gpt-5.6-terra": 9 },
    calibration,
  );
  assert.ok(Math.abs(mixed - (25 * 100 / 2_500 + 9 * 100 / 900)) < 1e-9);
  // Pure buckets price at their own capacities.
  const solPure = compositionExpectedPp({ "gpt-5.6-sol": 25 }, calibration);
  assert.ok(Math.abs(solPure - 1) < 1e-9);
  const terraPure = compositionExpectedPp({ "gpt-5.6-terra": 9 }, calibration);
  assert.ok(Math.abs(terraPure - 1) < 1e-9);
  // Unfitted model cost prices at the fallback constant.
  const unfitted = compositionExpectedPp({ "gpt-9-new": 20 }, calibration);
  assert.ok(Math.abs(unfitted - 1) < 1e-9);
  // A model NNLS zeroed out (null capacity) also prices at the fallback —
  // its cost is never treated as free.
  const zeroed = compositionExpectedPp({ "gpt-5.6-luna": 20 }, {
    ...calibration,
    capacityUsdByModel: { ...calibration.capacityUsdByModel, "gpt-5.6-luna": null },
  });
  assert.ok(Math.abs(zeroed - 1) < 1e-9);
  // No capacity anywhere -> null, never zero.
  assert.equal(
    compositionExpectedPp({ "gpt-9-new": 20 }, {
      capacityUsdByModel: null,
      fallbackCapacityUsd: null,
    }),
    null,
  );
});

test("the blended headline equals total dollars over composition-expected points", () => {
  const calibration = {
    capacityUsdByModel: { "gpt-5.6-sol": 2_500, "gpt-5.6-terra": 900 },
    fallbackCapacityUsd: 2_000,
  };
  const mix = { "gpt-5.6-sol": 90, "gpt-5.6-terra": 10 };
  const blended = blendedCompositionCapacityUsd(mix, calibration);
  const expectedPp = compositionExpectedPp(mix, calibration);
  assert.ok(Math.abs(blended - 100 * 100 / expectedPp) < 1e-9);
  // A pure mix blends to exactly its own capacity.
  assert.ok(Math.abs(
    blendedCompositionCapacityUsd({ "gpt-5.6-sol": 42 }, calibration) - 2_500,
  ) < 1e-9);
  assert.equal(blendedCompositionCapacityUsd({}, calibration), null);
});

// --- Corpus construction ----------------------------------------------------

function quotaReading(hoursFromStart, usedPercent, {
  planType = "pro",
  resetsAtMs = 700 * HOUR_MS,
} = {}) {
  return {
    observedAtMs: hoursFromStart * HOUR_MS,
    planType,
    resetsAtMs,
    usedPercent,
  };
}

function usageRow(hoursFromStart, model, costUsd) {
  return { observedAtMs: hoursFromStart * HOUR_MS, model, costUsd };
}

test("observations pair envelope movement with the bin's per-model cost", () => {
  const { observations } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 10),
      quotaReading(1, 12),
      quotaReading(1.5, 13),
      quotaReading(3, 15),
    ],
    usageRows: [
      usageRow(0.5, "gpt-5.6-sol", 40),
      usageRow(1.2, "gpt-5.6-terra", 10),
      usageRow(2.5, "gpt-5.6-sol", 30),
    ],
  });
  assert.equal(observations.length, 2);
  assert.equal(observations[0].ppDelta, 3);
  assert.deepEqual(observations[0].costByModel, {
    "gpt-5.6-sol": 40,
    "gpt-5.6-terra": 10,
  });
  assert.equal(observations[1].ppDelta, 2);
  assert.deepEqual(observations[1].costByModel, { "gpt-5.6-sol": 30 });
});

test("a stale interleaved reading never moves the envelope or fabricates movement", () => {
  const { observations } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 30),
      quotaReading(0.5, 31),
      // One stale reading from an out-of-date source, immediately recovered.
      quotaReading(0.6, 22),
      quotaReading(0.7, 31),
      quotaReading(1, 32),
    ],
    usageRows: [usageRow(0.5, "gpt-5.6-sol", 20)],
  });
  // Envelope 30 -> 32: exactly 2pp, in one bin; the dip contributed nothing.
  assert.equal(observations.length, 1);
  assert.equal(observations[0].ppDelta, 2);
});

test("a persistent drop is a reset boundary that starts a fresh segment", () => {
  const { observations } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 80),
      quotaReading(1, 82),
      // A banked reset drops the display and STAYS down.
      quotaReading(1.2, 3),
      quotaReading(1.4, 3),
      quotaReading(2.5, 6),
    ],
    usageRows: [
      usageRow(0.5, "gpt-5.6-sol", 25),
      usageRow(2.2, "gpt-5.6-sol", 30),
    ],
  });
  // Segment one: 80->82 (2pp) against its own bin's $25. Segment two: 3->6
  // (3pp) in the next bin against that bin's $30 — never 82->6 smeared into
  // a phantom, and never one bin's dollars attributed twice.
  const deltas = observations.map((observation) => observation.ppDelta).sort();
  assert.deepEqual(deltas, [2, 3]);
  const segments = new Set(observations.map((observation) => observation.segmentIndex));
  assert.equal(segments.size, 2);
  assert.deepEqual(
    observations.map((observation) => observation.costByModel),
    [{ "gpt-5.6-sol": 25 }, { "gpt-5.6-sol": 30 }],
  );
});

test("a mid-bin reset voids the bin: one bin's cost is never attributed to two segments", () => {
  const { observations } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0.1, 80),
      quotaReading(0.6, 84),
      // Banked reset INSIDE the same 2h bin, confirmed by a second reading,
      // then movement resumes before the bin ends.
      quotaReading(1.0, 3),
      quotaReading(1.2, 3),
      quotaReading(1.8, 9),
    ],
    usageRows: [usageRow(0.5, "gpt-5.6-sol", 100)],
  });
  // Both segments moved in ONE bin holding $100. Emitting both observations
  // would attribute $200 for $100 spent (each copies the bin's full cost),
  // so the bin is voided — honest refusal over double-counted training data.
  assert.equal(observations.length, 0);
});

test("a pegged pool yields no observations, so post-peg cost cannot train the fit", () => {
  const { observations } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 99),
      quotaReading(1, 100),
      quotaReading(2, 100),
      quotaReading(5, 100),
    ],
    usageRows: [
      usageRow(0.5, "gpt-5.6-sol", 10),
      // Heavy spend while pegged.
      usageRow(3, "gpt-5.6-sol", 500),
      usageRow(4, "gpt-5.6-sol", 500),
    ],
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].ppDelta, 1);
  assert.deepEqual(observations[0].costByModel, { "gpt-5.6-sol": 10 });
});

test("a crossing smeared past the elapsed gate voids the bins it spans", () => {
  const { observations, voidedBinCount } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 10),
      // Next reading nine hours later: display lag / collection silence.
      quotaReading(9, 25),
      quotaReading(9.5, 26),
    ],
    usageRows: [
      usageRow(1, "gpt-5.6-sol", 40),
      usageRow(9.2, "gpt-5.6-sol", 10),
    ],
  });
  // The 15pp smear is voided; the 1pp crossing at 9.5h lands in the same
  // (voided) bin, so nothing survives — honest exclusion over misattribution.
  assert.equal(observations.length, 0);
  assert.ok(voidedBinCount >= 5);
});

test("resets_at jitter clusters into one pool; a fresh pool separates", () => {
  const jitterA = 700 * HOUR_MS;
  const jitterB = 700 * HOUR_MS + 22_000;
  const freshPool = 868 * HOUR_MS;
  const { observations, poolCount } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 10, { resetsAtMs: jitterA }),
      quotaReading(1, 12, { resetsAtMs: jitterB }),
      // Fresh pool days later.
      quotaReading(30, 0, { resetsAtMs: freshPool }),
      quotaReading(31, 4, { resetsAtMs: freshPool }),
    ],
    usageRows: [
      usageRow(0.5, "gpt-5.6-sol", 20),
      usageRow(30.5, "gpt-5.6-sol", 60),
    ],
  });
  assert.equal(poolCount, 2);
  assert.equal(observations.length, 2);
  assert.deepEqual(
    observations.map((observation) => observation.ppDelta),
    [2, 4],
  );
});

test("a bin where two pools both move is voided as unattributable", () => {
  const poolA = 700 * HOUR_MS;
  const poolB = 900 * HOUR_MS;
  const { observations } = buildCompositionObservations({
    quotaRows: [
      quotaReading(0, 10, { resetsAtMs: poolA }),
      quotaReading(1, 12, { resetsAtMs: poolA }),
      quotaReading(0.2, 50, { planType: "prolite", resetsAtMs: poolB }),
      quotaReading(1.2, 55, { planType: "prolite", resetsAtMs: poolB }),
    ],
    usageRows: [usageRow(0.5, "gpt-5.6-sol", 30)],
  });
  assert.equal(observations.length, 0);
});
