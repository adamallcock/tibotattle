import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { createValidatedSnapshotStore } from '../../src/platform/index.js';

export const MODEL_PERFORMANCE_PERIODS = Object.freeze(['1', '7', '30', 'all']);
export const MODEL_PERFORMANCE_MAX_WINDOWS = 8;
const DAY = 86_400_000;
const MODEL_NAMES = Object.freeze({
  'gpt-5.6-luna': 'Luna', 'gpt-5.6-terra': 'Terra', 'gpt-5.6-sol': 'Sol',
  'gpt-6-astra': 'Astra', 'gpt-5.5': 'GPT-5.5', 'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 mini', 'gpt-5.3-codex-spark': 'Spark',
  'gpt-5.3-codex': 'GPT-5.3 Codex', 'gpt-5.2-codex': 'GPT-5.2 Codex', 'gpt-5.2': 'GPT-5.2',
});
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Closed content-free display data only. Validate worker messages as well as
// disk receipts so future or malformed projections cannot become saved state.
export function isModelPerformanceSnapshot(value) {
  if (!exact(value, ['schemaVersion', 'method', 'status', 'collecting', 'stale', 'updatedAt',
    'period', 'interval', 'start', 'end', 'historyProgress', 'models'])
      || value.schemaVersion !== 4 || value.method !== 5 || value.status !== 'ready'
      || typeof value.collecting !== 'boolean' || typeof value.stale !== 'boolean'
      || !MODEL_PERFORMANCE_PERIODS.includes(value.period) || !['day', 'week'].includes(value.interval)
      || !timestamp(value.end) || !(value.start === null || timestamp(value.start) && value.start <= value.end)
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || new Date(value.updatedAt).toISOString() !== value.updatedAt
      || Date.parse(value.updatedAt) < value.end
      || !(value.historyProgress === null || exact(value.historyProgress, ['checked', 'total'])
        && count(value.historyProgress.checked) && count(value.historyProgress.total)
        && value.historyProgress.checked <= value.historyProgress.total)
      || !Array.isArray(value.models) || value.models.length > Object.keys(MODEL_NAMES).length) return false;
  const step = value.interval === 'week' ? 7 * DAY : DAY;
  const validPoints = (points, maximum) => {
    if (!Array.isArray(points) || points.length > 2048) return false;
    let previous = -1, total = 0;
    for (const point of points) {
      if (!exact(point, ['at', 'n', 'p10', 'p25', 'median', 'p75', 'p90']) || !timestamp(point.at)
          || point.at <= previous || point.at > value.end || (value.start !== null && point.at < value.start - step)
          || !count(point.n) || point.n < 1 || !Number.isFinite(point.median) || point.median < 0
          || point.median > 1e9) return false;
      if (point.n < 5 ? [point.p10, point.p25, point.p75, point.p90].some(n => n !== null)
        : ![point.p10, point.p25, point.p75, point.p90].every(Number.isFinite)
          || point.p10 < 0 || point.p10 > point.p25 || point.p25 > point.median
          || point.p75 < point.median || point.p90 < point.p75 || point.p90 > 1e9) return false;
      previous = point.at;
      total += point.n;
    }
    return total === maximum;
  };
  const seen = new Set();
  for (const model of value.models) {
    if (!exact(model, ['id', 'label', 'turns', 'speedTurns', 'ttftTurns', 'timedResponses', 'speed', 'ttft',
      'toolFreeTurns', 'toolFree'])
        || !Object.hasOwn(MODEL_NAMES, model.id) || model.label !== MODEL_NAMES[model.id] || seen.has(model.id)
        || ![model.turns, model.speedTurns, model.ttftTurns, model.timedResponses, model.toolFreeTurns].every(count)
        || model.speedTurns > model.turns || model.ttftTurns > model.turns || model.toolFreeTurns > model.speedTurns
        || model.timedResponses < model.speedTurns - model.toolFreeTurns
        || model.speedTurns === model.toolFreeTurns && model.timedResponses !== 0
        || !Array.isArray(model.speed) || model.speed.length > 1 || !validPoints(model.ttft, model.ttftTurns)
        || !validPoints(model.toolFree, model.toolFreeTurns)) return false;
    seen.add(model.id);
    for (const series of model.speed) {
      if (!exact(series, ['method', 'points']) || series.method !== 'speed'
          || !validPoints(series.points, model.speedTurns)) return false;
    }
    const speedBins = new Map(model.speed.flatMap(series => series.points).map(point => [point.at, point.n]));
    if (model.speed.length === 0 && model.speedTurns !== 0
        || model.toolFree.some(point => point.n > (speedBins.get(point.at) ?? 0))) return false;
  }
  return true;
}

export const isCompleteModelPerformanceSnapshot = value => isModelPerformanceSnapshot(value)
  && !value.collecting && !value.stale && (value.historyProgress === null
    || value.historyProgress.checked === value.historyProgress.total);

// Pinned results carry the exact requested end in their key. Their collection
// timestamp may be later, but a stored rolling window must keep its bounds.
export function readModelPerformanceSnapshotEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { requestKey, ...snapshot } = value;
  if (!isModelPerformanceSnapshot(snapshot)) return null;
  if (Object.hasOwn(value, 'requestKey')) {
    if (requestKey !== `${snapshot.period}:${snapshot.end}`
        || (snapshot.period !== 'all' && snapshot.start !== Math.max(0, snapshot.end - Number(snapshot.period) * DAY))) return null;
    return { key: requestKey, snapshot };
  }
  return Date.parse(snapshot.updatedAt) === snapshot.end ? { key: snapshot.period, snapshot } : null;
}

export function modelPerformanceSourceScope(codexHome) {
  return typeof codexHome === 'string' && codexHome.length > 0
    ? createHash('sha256').update(`model-performance-v1\0${resolve(codexHome)}`).digest('hex') : null;
}

export function createModelPerformanceSnapshotStore({ directory, codexHome, now = () => Date.now() }) {
  // Relative paths are used by in-memory clients/tests and must never create a
  // cache in the working directory. The production composition supplies both.
  if (typeof directory !== 'string' || !isAbsolute(directory)
      || typeof codexHome !== 'string' || !isAbsolute(codexHome)) return null;
  const source = modelPerformanceSourceScope(codexHome);
  const store = createValidatedSnapshotStore({
    snapshotFile: join(directory, 'model-performance-snapshot.json'),
    // Earlier receipts hold independent percentile distributions. Rebuild from
    // retained turn evidence; never relabel those aggregates as combined speed.
    schemaVersion: 'local-model-performance-snapshot-v4',
    maximumBytes: 4 * 1024 * 1024,
    now,
    validate: value => {
      if (!exact(value, ['source', 'values']) || value.source !== source
          || !Array.isArray(value.values) || value.values.length < 1
          || value.values.length > MODEL_PERFORMANCE_PERIODS.length + MODEL_PERFORMANCE_MAX_WINDOWS) return false;
      const entries = value.values.map(readModelPerformanceSnapshotEntry);
      return entries.every(entry => entry && isCompleteModelPerformanceSnapshot(entry.snapshot))
        && new Set(entries.map(entry => entry.key)).size === entries.length
        && entries.filter(entry => entry.key !== entry.snapshot.period).length <= MODEL_PERFORMANCE_MAX_WINDOWS;
    },
  });
  return {
    async read() {
      const receipt = await store.read();
      return receipt ? { values: receipt.snapshot.values, savedAt: receipt.savedAt } : null;
    },
    write(values) { return store.write({ source, values }); },
  };
}
