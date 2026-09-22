// Robust LOWESS presentation trend over already validated reset estimates.
// This summary is neither a quota measurement nor a confidence interval.
const DAY_MS = 86_400_000;
const MAX_POINTS = 250;
const MIN_DURATION_MS = 14 * DAY_MS;
const MAX_GAP_MS = 28 * DAY_MS;

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasDuration(points, start, end) {
  return points[end].time - points[start].time >= MIN_DURATION_MS;
}

function lowess(points) {
  const count = points.length;
  if (count < 6 || !hasDuration(points, 0, count - 1)) return null;
  const neighbours = Math.max(6, Math.ceil(count * 0.5));
  const local = points.map((target) => {
    const distances = points.map((point) => Math.abs(point.time - target.time));
    // A tiny expansion gives the furthest selected neighbour nonzero weight.
    const bandwidth = [...distances].sort((a, b) => a - b)[neighbours - 1] * 1.000001;
    return points.flatMap((point, index) => {
      const distance = distances[index];
      if (distance > bandwidth) return [];
      const x = (point.time - target.time) / bandwidth;
      return [{ index, x, weight: (1 - Math.abs(x) ** 3) ** 3, value: point.value }];
    });
  });
  let robustWeights = Array(count).fill(1);
  let fitted;
  // Initial fit followed by three residual-bisquare robustness iterations.
  for (let iteration = 0; iteration <= 3; iteration += 1) {
    fitted = local.map((neighbourhood) => {
      let sw = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
      for (const point of neighbourhood) {
        const weight = point.weight * robustWeights[point.index];
        sw += weight;
        sx += weight * point.x;
        sy += weight * point.value;
        sxx += weight * point.x * point.x;
        sxy += weight * point.x * point.value;
      }
      if (sw <= 1e-12) return null;
      const determinant = sw * sxx - sx * sx;
      const prediction = determinant > 1e-12 ? (sy * sxx - sx * sxy) / determinant : sy / sw;
      const values = neighbourhood.map((point) => point.value);
      return Math.max(Math.min(...values), Math.min(Math.max(...values), prediction));
    });
    if (iteration === 3) break;
    const residuals = points.map((point, index) => fitted[index] === null ? Infinity : Math.abs(point.value - fitted[index]));
    const finiteResiduals = residuals.filter(Number.isFinite).sort((a, b) => a - b);
    if (!finiteResiduals.length) break;
    // A numerical floor handles exactly flat observations with an isolated spike.
    const floor = Math.max(1, median(points.map((point) => point.value).sort((a, b) => a - b))) * 1e-10;
    const cutoff = 6 * Math.max(floor, median(finiteResiduals));
    robustWeights = residuals.map((residual) => residual >= cutoff ? 0 : (1 - (residual / cutoff) ** 2) ** 2);
  }
  return fitted;
}

/**
 * Summarise chronological reset estimates without mutating source observations.
 * Numeric `at` is epoch milliseconds; strings must be parseable timestamps.
 * Duplicate timestamps, invalid estimates and long gaps do not provide fit support.
 * The point cap bounds fitting work; larger inputs are rejected, never truncated.
 */
export function buildAllowanceTrends(input) {
  const points = input.map((point) => ({ ...point, allowanceLowess: null }));
  const result = { points, lowessCount: 0, reason: null };
  if (points.length > MAX_POINTS) return { ...result, reason: "tooMany" };
  const times = points.map((point) => timestamp(point.at));
  const frequency = new Map();
  for (const time of times) if (time !== null) frequency.set(time, (frequency.get(time) ?? 0) + 1);
  const eligible = points.flatMap((point, index) => {
    const time = times[index];
    return time !== null && frequency.get(time) === 1 && typeof point.value === "number" && Number.isFinite(point.value) && point.value > 0
      ? [{ index, time, value: point.value }]
      : [];
  }).sort((a, b) => a.time - b.time);
  const blocks = [];
  for (const point of eligible) {
    const block = blocks.at(-1);
    if (!block || point.time - block.at(-1).time > MAX_GAP_MS) blocks.push([point]);
    else block.push(point);
  }
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const fitted = lowess(block);
    if (fitted) fitted.forEach((value, index) => {
      // A null at each later block's first point breaks a single chart series.
      if (blockIndex > 0 && index === 0) return;
      points[block[index].index].allowanceLowess = value;
      if (value !== null) result.lowessCount += 1;
    });
  }
  if (!result.lowessCount) result.reason = "insufficient";
  return result;
}
