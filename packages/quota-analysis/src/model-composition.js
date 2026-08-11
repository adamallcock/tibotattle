// Composition-aware quota calibration kernel.
//
// The weekly quota's `used_percent` is consumed by tokens weighted at a
// per-model quota-credit rate, while dollar cost weights the same tokens at a
// per-model price. Their ratio — dollars per percentage point — is therefore
// model-specific, not one constant (design:
// docs/design/composition-aware-expected-line.md; evidence: implied capacity
// across historical windows correlates +0.87 with sol cost-share and −0.88
// with terra share, while gpt-5.5-pure June weeks imply one constant within
// ±1%). The provider's credit weighting is not observable, so the per-model
// $/100pp vector is calibrated empirically by non-negative least squares over
// (per-bin percentage movement, per-bin per-model cost) observations.
//
// Everything here is runtime-neutral and dependency-free: plain rows in,
// plain fit out. The corpus builder mirrors, at observation grain, the same
// refusals the calibration reporting makes at reset grain — monotone
// envelopes per pool, stale interleaved readings ignored, ambiguous bins
// (multiple pools or multiple reset-separated segments moving in one bin)
// voided — so the fit never trains on double-attributed evidence.

export const MODEL_COMPOSITION_POLICY = Object.freeze({
  // Observation grain. Two hours is the finest grain at which the displayed
  // whole-percentage quota moves enough to dominate its ±0.5pp rounding on
  // the observed corpus; the fitted vector is stable from 2h through 4h.
  grainMs: 2 * 60 * 60 * 1_000,
  // Quota pools restate `resets_at` with seconds-level jitter, and a fresh
  // pool spawns hours-to-days away. Clustering within three hours unifies
  // jitter without ever merging two distinct weekly pools.
  poolToleranceMs: 3 * 60 * 60 * 1_000,
  // A displayed drop larger than this inside one pool is a genuine boundary
  // (banked or automatic reset); anything smaller is display jitter absorbed
  // by the monotone envelope.
  resetDropPp: 5,
  // A boundary crossing whose bracketing observations are further apart than
  // this cannot honestly attribute its movement to one bin (display lag or a
  // collection silence smeared it), so the crossing and the bins it spans are
  // voided.
  maxCrossingElapsedMs: 3 * 60 * 60 * 1_000,
  // Models below this share of corpus cost fold into one "other" column so a
  // sliver of spend can never claim its own free parameter.
  minimumModelCostShare: 0.02,
  // Fewer observations than this cannot support a multi-model fit at all.
  minimumObservations: 24,
  // The label the folded remainder fits under.
  otherModelKey: "other",
  // Identification guard for near-collinear corpora: the single-constant
  // model is NESTED in the NNLS feasible set (a uniform vector is feasible),
  // so raw training R² can only tie or beat the constant's — it can never
  // reject a fit. Each named model's capacity must therefore also be STABLE:
  // refitting on interleaved half-corpora may move no identified capacity by
  // more than this fraction of its full-fit value, or the whole fit degrades
  // to the blended constant instead of shipping a confident noise split.
  maxSplitHalfCapacityDriftFraction: 0.35,
});

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Build calibration observations from raw usage costs and weekly quota
 * readings.
 *
 * @param {Object} inputs
 * @param {Array} inputs.usageRows  [{observedAtMs, model, costUsd}] — one row
 *   per priced usage event (or any finer/coarser aggregation; only the bin
 *   sums matter).
 * @param {Array} inputs.quotaRows  [{observedAtMs, planType, resetsAtMs,
 *   usedPercent}] — weekly-window readings for ONE limit id, any slot (slot is
 *   a server-assigned UI role, never identity).
 * @returns {{observations: Array, voidedBinCount: number, poolCount: number}}
 *   observations: [{binStartMs, poolKey, segmentIndex, ppDelta, costByModel}]
 *   — strictly-positive envelope movement per bin with that bin's per-model
 *   cost. Saturated spans produce no observations by construction: a pegged
 *   pool has no envelope crossings, so post-peg cost never trains the fit.
 */
export function buildCompositionObservations({
  usageRows = [],
  quotaRows = [],
} = {}, {
  grainMs = MODEL_COMPOSITION_POLICY.grainMs,
  poolToleranceMs = MODEL_COMPOSITION_POLICY.poolToleranceMs,
  resetDropPp = MODEL_COMPOSITION_POLICY.resetDropPp,
  maxCrossingElapsedMs = MODEL_COMPOSITION_POLICY.maxCrossingElapsedMs,
} = {}) {
  if (!Array.isArray(usageRows) || !Array.isArray(quotaRows)) {
    throw new TypeError("usageRows and quotaRows must be arrays");
  }
  const readings = quotaRows
    .filter((row) => row
      && Number.isFinite(row.observedAtMs)
      && Number.isFinite(row.resetsAtMs)
      && Number.isFinite(row.usedPercent)
      && row.usedPercent >= 0
      && row.usedPercent <= 100)
    .map((row) => ({
      observedAtMs: row.observedAtMs,
      planType: typeof row.planType === "string" && row.planType.length > 0
        ? row.planType
        : "unknown",
      resetsAtMs: row.resetsAtMs,
      usedPercent: row.usedPercent,
    }))
    .sort((left, right) => left.observedAtMs - right.observedAtMs
      || left.resetsAtMs - right.resetsAtMs);

  // Pool identity: (planType, resets_at clustered within tolerance).
  const clusterKeyByReset = new Map();
  const planTypes = new Set(readings.map((row) => row.planType));
  for (const planType of planTypes) {
    const resets = [...new Set(
      readings.filter((row) => row.planType === planType)
        .map((row) => row.resetsAtMs),
    )].sort((left, right) => left - right);
    let clusterStart = null;
    let clusterMax = null;
    for (const resetMs of resets) {
      if (clusterStart === null || resetMs - clusterMax > poolToleranceMs) {
        clusterStart = resetMs;
      }
      clusterMax = resetMs;
      clusterKeyByReset.set(
        `${planType}\0${resetMs}`,
        `${planType}\0${clusterStart}`,
      );
    }
  }

  // Monotone envelope per pool with the stale-reading and persistent-drop
  // rules. A single reading below envelope − resetDropPp that immediately
  // recovers is an interleaved stale source and never moves anything; two
  // consecutive such readings are a genuine reset boundary and start a new
  // segment.
  const pools = new Map();
  for (const row of readings) {
    const poolKey = clusterKeyByReset.get(`${row.planType}\0${row.resetsAtMs}`);
    let pool = pools.get(poolKey);
    if (pool === undefined) {
      pool = { key: poolKey, segments: [], pendingDrop: null };
      pools.set(poolKey, pool);
    }
    const segment = pool.segments.at(-1);
    if (segment === undefined) {
      pool.segments.push({
        crossings: [],
        envelope: row.usedPercent,
        envelopeMs: row.observedAtMs,
      });
      continue;
    }
    if (row.usedPercent < segment.envelope - resetDropPp) {
      if (pool.pendingDrop !== null
          && row.usedPercent <= pool.pendingDrop + resetDropPp) {
        pool.segments.push({
          crossings: [],
          envelope: row.usedPercent,
          envelopeMs: row.observedAtMs,
        });
        pool.pendingDrop = null;
      } else {
        pool.pendingDrop = row.usedPercent;
      }
      continue;
    }
    pool.pendingDrop = null;
    if (row.usedPercent > segment.envelope) {
      segment.crossings.push({
        atMs: row.observedAtMs,
        priorMs: segment.envelopeMs,
        deltaPp: row.usedPercent - segment.envelope,
      });
      segment.envelope = row.usedPercent;
      segment.envelopeMs = row.observedAtMs;
    } else if (row.usedPercent === segment.envelope) {
      segment.envelopeMs = row.observedAtMs;
    }
  }

  // Per-model cost per bin.
  const binCosts = new Map();
  for (const row of usageRows) {
    if (!row
        || !Number.isFinite(row.observedAtMs)
        || typeof row.model !== "string"
        || row.model.length === 0
        || !finiteNonNegative(row.costUsd)) continue;
    const bin = Math.floor(row.observedAtMs / grainMs) * grainMs;
    let costs = binCosts.get(bin);
    if (costs === undefined) {
      costs = new Map();
      binCosts.set(bin, costs);
    }
    costs.set(row.model, (costs.get(row.model) ?? 0) + row.costUsd);
  }

  // Crossings -> bins, voiding smeared crossings and ambiguous bins.
  const entries = new Map();
  const voidedBins = new Set();
  for (const pool of pools.values()) {
    for (const [segmentIndex, segment] of pool.segments.entries()) {
      for (const crossing of segment.crossings) {
        const firstBin = Math.floor(crossing.priorMs / grainMs) * grainMs;
        const lastBin = Math.floor(crossing.atMs / grainMs) * grainMs;
        if (crossing.atMs - crossing.priorMs > maxCrossingElapsedMs) {
          for (let bin = firstBin; bin <= lastBin; bin += grainMs) {
            voidedBins.add(bin);
          }
          continue;
        }
        const key = `${pool.key}\0${segmentIndex}\0${lastBin}`;
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = {
            poolKey: pool.key,
            segmentIndex,
            binStartMs: lastBin,
            ppDelta: 0,
          };
          entries.set(key, entry);
        }
        entry.ppDelta += crossing.deltaPp;
      }
    }
  }
  const entriesPerBin = new Map();
  for (const entry of entries.values()) {
    entriesPerBin.set(
      entry.binStartMs,
      (entriesPerBin.get(entry.binStartMs) ?? 0) + 1,
    );
  }
  for (const [bin, count] of entriesPerBin) {
    // More than one observation in a bin — concurrent pools moving, or two
    // segments of ONE pool bracketing a mid-bin reset — makes that bin's
    // cost unattributable between them: each observation would otherwise
    // copy the bin's FULL cost and the corpus would train on double-counted
    // dollars. Void the bin — the same refusal the reset-grain calibration
    // makes for overlapping observation windows.
    if (count > 1) voidedBins.add(bin);
  }
  const observations = [...entries.values()]
    .filter((entry) => !voidedBins.has(entry.binStartMs) && entry.ppDelta > 0)
    .map((entry) => ({
      ...entry,
      costByModel: Object.fromEntries(binCosts.get(entry.binStartMs) ?? []),
    }))
    .filter((entry) => Object.values(entry.costByModel)
      .reduce((sum, value) => sum + value, 0) > 0)
    .sort((left, right) => left.binStartMs - right.binStartMs);
  return {
    observations,
    voidedBinCount: voidedBins.size,
    poolCount: pools.size,
  };
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) {
        best = row;
      }
    }
    if (Math.abs(augmented[best][pivot]) < 1e-12) return null;
    const swap = augmented[pivot];
    augmented[pivot] = augmented[best];
    augmented[best] = swap;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot] / augmented[pivot][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row, index) => row[size] / row[index]);
}

/**
 * Non-negative least squares via the Lawson–Hanson active-set method: find
 * x ≥ 0 minimizing ‖Ax − b‖². Dependency-free; the normal-equation
 * subproblems are solved by Gaussian elimination with partial pivoting.
 *
 * @param {Array<Array<number>>} rows  A, row-major.
 * @param {Array<number>} target  b.
 * @returns {{solution: Array<number>, converged: boolean, iterations: number}}
 *   `converged` is false only when the iteration cap fired before the
 *   optimality condition held; the partial solution is still non-negative.
 */
export function solveNonNegativeLeastSquares(rows, target, {
  maxIterations = null,
  tolerance = 1e-10,
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(target)
      || rows.length !== target.length) {
    throw new TypeError("rows and target must be arrays of the same length");
  }
  const columns = rows[0]?.length ?? 0;
  if (rows.some((row) => !Array.isArray(row) || row.length !== columns)) {
    throw new TypeError("every row must have the same number of columns");
  }
  const cap = maxIterations ?? 3 * columns + 12;
  const passive = new Set();
  const solution = new Array(columns).fill(0);
  let converged = false;
  let iterations = 0;
  for (; iterations < cap; iterations += 1) {
    const residual = rows.map((row, index) => target[index]
      - row.reduce((sum, value, column) => sum + value * solution[column], 0));
    const gradient = Array.from({ length: columns }, (_, column) => rows
      .reduce((sum, row, index) => sum + row[column] * residual[index], 0));
    let candidate = -1;
    let bestGradient = tolerance;
    for (let column = 0; column < columns; column += 1) {
      if (!passive.has(column) && gradient[column] > bestGradient) {
        bestGradient = gradient[column];
        candidate = column;
      }
    }
    if (candidate === -1) {
      converged = true;
      break;
    }
    passive.add(candidate);
    for (;;) {
      const active = [...passive];
      const normal = active.map((left) => active.map((right) => rows
        .reduce((sum, row) => sum + row[left] * row[right], 0)));
      const projected = active.map((column) => rows
        .reduce((sum, row, index) => sum + row[column] * target[index], 0));
      const subSolution = solveLinearSystem(normal, projected);
      if (subSolution === null) {
        // The candidate made the passive set singular (an exactly collinear
        // column); withdraw it. The gradient test will not re-nominate a
        // column that adds no information.
        passive.delete(candidate);
        break;
      }
      if (subSolution.every((value) => value > tolerance)) {
        solution.fill(0);
        active.forEach((column, index) => {
          solution[column] = subSolution[index];
        });
        break;
      }
      let alpha = Number.POSITIVE_INFINITY;
      active.forEach((column, index) => {
        if (subSolution[index] <= tolerance) {
          const ratio = solution[column]
            / (solution[column] - subSolution[index]);
          if (ratio < alpha) alpha = ratio;
        }
      });
      active.forEach((column, index) => {
        solution[column] += alpha * (subSolution[index] - solution[column]);
        if (solution[column] <= tolerance) {
          solution[column] = 0;
          passive.delete(column);
        }
      });
    }
  }
  return { solution, converged, iterations };
}

function designFor(observations, fittedModels, otherKey) {
  const columns = [...fittedModels, otherKey];
  const rows = observations.map((observation) => {
    const vector = new Array(columns.length).fill(0);
    for (const [model, cost] of Object.entries(observation.costByModel)) {
      const index = columns.indexOf(
        fittedModels.includes(model) ? model : otherKey,
      );
      vector[index] += cost;
    }
    return vector;
  });
  return { columns, rows };
}

function rSquared(target, predictions) {
  const mean = target.reduce((sum, value) => sum + value, 0) / target.length;
  let ssTotal = 0;
  let ssResidual = 0;
  for (let index = 0; index < target.length; index += 1) {
    ssTotal += (target[index] - mean) ** 2;
    ssResidual += (target[index] - predictions[index]) ** 2;
  }
  if (!(ssTotal > 0)) return null;
  return 1 - ssResidual / ssTotal;
}

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

/**
 * Calibrate the per-model $/100pp capacity vector by NNLS over composition
 * observations, against the single-constant baseline.
 *
 * Degenerate corpora degrade explicitly, never to NaN:
 * - fewer than `minimumObservations` usable rows → status
 *   `"insufficient_observations"`, capacities null;
 * - a fit that fails to beat the single constant on the DF-ADJUSTED
 *   comparison (the constant is nested in the NNLS feasible set, so raw
 *   training R² can only tie or beat it — the adjustment charges each free
 *   per-model parameter) → status `"fallback_blended"`, capacities null;
 * - a fit whose named-model capacities are UNSTABLE across interleaved
 *   half-corpus refits (near-collinear mixes produce arbitrary splits with a
 *   vanishing R² edge) → status `"fallback_blended"`, capacities null;
 * - all fall back to `singleConstantUsd`, which is always emitted when any
 *   usable observation exists.
 *
 * A model NNLS zeroes out keeps `null` capacity (its cost showed no quota
 * consumption at this grain); `compositionExpectedPp` prices such cost at the
 * caller's fallback constant rather than pretending it is free.
 */
export function calibrateCompositionCapacities(observations, {
  minimumModelCostShare = MODEL_COMPOSITION_POLICY.minimumModelCostShare,
  minimumObservations = MODEL_COMPOSITION_POLICY.minimumObservations,
  otherModelKey = MODEL_COMPOSITION_POLICY.otherModelKey,
  maxSplitHalfCapacityDriftFraction =
    MODEL_COMPOSITION_POLICY.maxSplitHalfCapacityDriftFraction,
} = {}) {
  const usable = (Array.isArray(observations) ? observations : [])
    .filter((observation) => observation
      && finitePositive(observation.ppDelta)
      && observation.costByModel
      && typeof observation.costByModel === "object");
  const totalsByModel = {};
  let totalCost = 0;
  for (const observation of usable) {
    for (const [model, cost] of Object.entries(observation.costByModel)) {
      if (!finiteNonNegative(cost)) continue;
      totalsByModel[model] = (totalsByModel[model] ?? 0) + cost;
      totalCost += cost;
    }
  }
  const base = {
    observationCount: usable.length,
    totalCostUsd: round(totalCost, 2),
    modelCostShares: totalCost > 0
      ? Object.fromEntries(Object.entries(totalsByModel)
        .sort(([, left], [, right]) => right - left)
        .map(([model, cost]) => [model, round(cost / totalCost)]))
      : {},
  };
  if (usable.length === 0 || !(totalCost > 0)) {
    return {
      ...base,
      status: "insufficient_observations",
      capacityUsdByModel: null,
      singleConstantUsd: null,
      r2: null,
      singleConstantR2: null,
      solverConverged: null,
    };
  }
  const target = usable.map((observation) => observation.ppDelta);
  const flatCost = usable.map((observation) => Object.values(observation.costByModel)
    .reduce((sum, value) => sum + (finiteNonNegative(value) ? value : 0), 0));
  // Least-squares through the origin: the one capacity that best explains
  // pp = cost / capacity over this corpus.
  const flatDenominator = flatCost
    .reduce((sum, value) => sum + value * value, 0);
  const flatBeta = flatDenominator > 0
    ? flatCost.reduce((sum, value, index) => sum + value * target[index], 0)
      / flatDenominator
    : 0;
  const singleConstantUsd = flatBeta > 0 ? 100 / flatBeta : null;
  const singleConstantR2 = rSquared(
    target,
    flatCost.map((value) => value * flatBeta),
  );
  if (usable.length < minimumObservations) {
    return {
      ...base,
      status: "insufficient_observations",
      capacityUsdByModel: null,
      singleConstantUsd: round(singleConstantUsd, 2),
      r2: null,
      singleConstantR2: round(singleConstantR2),
      solverConverged: null,
    };
  }
  const fittedModels = Object.entries(totalsByModel)
    .filter(([, cost]) => cost / totalCost >= minimumModelCostShare)
    .map(([model]) => model)
    .sort();
  const { columns, rows } = designFor(usable, fittedModels, otherModelKey);
  const { solution, converged } = solveNonNegativeLeastSquares(rows, target);
  const predictions = rows.map((row) => row
    .reduce((sum, value, column) => sum + value * solution[column], 0));
  const r2 = rSquared(target, predictions);
  const capacityUsdByModel = Object.fromEntries(columns.map((model, index) => [
    model,
    solution[index] > 1e-9 ? round(100 / solution[index], 2) : null,
  ]));
  // Degrees-of-freedom-adjusted comparison for through-origin models: the
  // single constant is nested inside the NNLS feasible set, so raw training
  // R² for the multi-model fit can NEVER fall below the constant's — only an
  // adjustment that charges the extra parameters can reject the fit.
  const adjustedOf = (value, parameters) => (
    Number.isFinite(value) && usable.length > parameters
      ? 1 - (1 - value) * usable.length / (usable.length - parameters)
      : null
  );
  const adjustedR2 = adjustedOf(r2, columns.length);
  const singleConstantAdjustedR2 = adjustedOf(singleConstantR2, 1);
  // Split-half stability: refit on interleaved halves of the time-ordered
  // corpus. A genuinely identified capacity reappears near its full-fit
  // value in every half that actually CARRIES the model's cost; a
  // near-collinear noise split lands wherever each half's noise points. A
  // half holding less than the share floor of a model's cost is absence of
  // evidence, not instability, and is skipped for that model (a corpus of
  // alternating pure-model bins must not fail on its own alternation). Only
  // NAMED fitted models are held to this — the folded "other" sliver never
  // carries enough cost for its drift to matter.
  const ordered = [...usable].sort((left, right) => (
    (Number.isFinite(left.binStartMs) ? left.binStartMs : 0)
      - (Number.isFinite(right.binStartMs) ? right.binStartMs : 0)
  ));
  let splitHalfMaxDriftFraction = 0;
  let splitHalfIdentified = true;
  for (const parity of [0, 1]) {
    const half = ordered.filter((_, index) => index % 2 === parity);
    const halfDesign = designFor(half, fittedModels, otherModelKey);
    const halfFit = solveNonNegativeLeastSquares(
      halfDesign.rows,
      half.map((observation) => observation.ppDelta),
    );
    const halfColumnCosts = columns.map((_, column) => halfDesign.rows
      .reduce((sum, row) => sum + row[column], 0));
    const halfTotalCost = halfColumnCosts
      .reduce((sum, value) => sum + value, 0);
    for (const [index, model] of columns.entries()) {
      if (!fittedModels.includes(model)) continue;
      if (!(solution[index] > 1e-9)) continue;
      if (!(halfTotalCost > 0)
          || halfColumnCosts[index]
            < minimumModelCostShare * halfTotalCost) continue;
      if (!halfFit.converged || !(halfFit.solution[index] > 1e-9)) {
        splitHalfIdentified = false;
        continue;
      }
      const fullCapacity = 100 / solution[index];
      const halfCapacity = 100 / halfFit.solution[index];
      splitHalfMaxDriftFraction = Math.max(
        splitHalfMaxDriftFraction,
        Math.abs(halfCapacity - fullCapacity) / fullCapacity,
      );
    }
  }
  const identification = {
    adjustedR2: round(adjustedR2),
    singleConstantAdjustedR2: round(singleConstantAdjustedR2),
    splitHalfIdentified,
    splitHalfMaxCapacityDriftFraction: round(splitHalfMaxDriftFraction, 4),
  };
  const improved = converged
    && Number.isFinite(r2)
    && (singleConstantAdjustedR2 === null
      || (adjustedR2 !== null && adjustedR2 > singleConstantAdjustedR2))
    && splitHalfIdentified
    && splitHalfMaxDriftFraction <= maxSplitHalfCapacityDriftFraction
    && Object.values(capacityUsdByModel).some((value) => value !== null);
  if (!improved) {
    return {
      ...base,
      status: "fallback_blended",
      capacityUsdByModel: null,
      singleConstantUsd: round(singleConstantUsd, 2),
      r2: round(r2),
      singleConstantR2: round(singleConstantR2),
      solverConverged: converged,
      identification,
    };
  }
  return {
    ...base,
    status: "fitted",
    capacityUsdByModel,
    singleConstantUsd: round(singleConstantUsd, 2),
    r2: round(r2),
    singleConstantR2: round(singleConstantR2),
    solverConverged: converged,
    identification,
  };
}

function capacityFor(model, capacityUsdByModel, otherModelKey) {
  const own = capacityUsdByModel?.[model];
  if (finitePositive(own)) return own;
  if (Object.hasOwn(capacityUsdByModel ?? {}, model)) return null;
  const other = capacityUsdByModel?.[otherModelKey];
  return finitePositive(other) ? other : null;
}

/**
 * Expected percentage-point movement for one cost mix under a calibration:
 * Σ_model cost_model × 100 / capacity_model, with cost of unfitted or
 * unidentified models priced at `fallbackCapacityUsd`. Returns null when no
 * positive capacity can price any of the cost — never 0 for unpriceable cost.
 */
export function compositionExpectedPp(costByModel, {
  capacityUsdByModel = null,
  fallbackCapacityUsd = null,
  otherModelKey = MODEL_COMPOSITION_POLICY.otherModelKey,
} = {}) {
  let expected = 0;
  let priceable = false;
  for (const [model, cost] of Object.entries(costByModel ?? {})) {
    if (!finiteNonNegative(cost) || cost === 0) continue;
    const capacity = capacityUsdByModel === null
      ? null
      : capacityFor(model, capacityUsdByModel, otherModelKey);
    const effective = capacity ?? (
      finitePositive(fallbackCapacityUsd) ? fallbackCapacityUsd : null
    );
    if (effective === null) return null;
    expected += cost * 100 / effective;
    priceable = true;
  }
  return priceable ? expected : 0;
}

/**
 * The blended "$X per 100pp" headline for a cost mix: the one constant that
 * reproduces the composition-aware expected movement for exactly this mix
 * (total dollars ÷ expected points × 100 — a cost-weighted harmonic mean of
 * the per-model capacities). Returns null when the mix is empty or any of its
 * cost is unpriceable under the calibration and fallback.
 */
export function blendedCompositionCapacityUsd(costByModel, {
  capacityUsdByModel = null,
  fallbackCapacityUsd = null,
  otherModelKey = MODEL_COMPOSITION_POLICY.otherModelKey,
} = {}) {
  const totalCost = Object.values(costByModel ?? {})
    .reduce((sum, value) => sum + (finiteNonNegative(value) ? value : 0), 0);
  if (!(totalCost > 0)) return null;
  const expected = compositionExpectedPp(costByModel, {
    capacityUsdByModel,
    fallbackCapacityUsd,
    otherModelKey,
  });
  if (!finitePositive(expected)) return null;
  return totalCost * 100 / expected;
}
