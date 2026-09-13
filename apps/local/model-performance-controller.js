import { Worker } from 'node:worker_threads';
// Keep the worker reachable to the native runtime dependency scanner.
import './model-performance-worker.js';

const PERIODS = ['1', '7', '30', 'all'];
const MAX_WINDOWS = 8;
export function createModelPerformanceController({ directory, codexHome, platform = process.platform,
  idleMs = 60_000, workerFactory = options => new Worker(new URL('./model-performance-worker.js', import.meta.url), options) }) {
  const cache = new Map();
  const windows = new Map();
  let worker = null, idle = null, closed = false, failedAt = 0, stopping = null;
  const empty = (period, status) => ({ schemaVersion: 2, method: 3, status, collecting: false, stale: false,
    updatedAt: null, period, interval: 'day', start: null, end: Date.now(), historyProgress: null, models: [] });
  function fail() {
    failedAt = Date.now();
    for (const [period, value] of cache) cache.set(period, { ...value, collecting: false, stale: true });
  }
  function scheduleIdleStop() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idle = null;
      // Once explicitly requested, finish the discovered history pass even if
      // its page becomes hidden. This remains lazy and off-main; completed
      // workers still stop after the ordinary idle lease.
      if ([...cache.values()].some(value => value.collecting)) scheduleIdleStop();
      else void stop();
    }, idleMs);
    idle.unref?.();
  }
  async function stop() {
    clearTimeout(idle); idle = null;
    if (stopping) return stopping;
    const old = worker; worker = null;
    if (!old) return;
    stopping = new Promise(resolve => {
      const timer = setTimeout(() => { void old.terminate().then(resolve, resolve); }, 2000);
      timer.unref?.();
      old.once('exit', () => { clearTimeout(timer); resolve(); });
      old.postMessage({ type: 'stop' });
    }).finally(() => { stopping = null; });
    return stopping;
  }
  function start() {
    if (closed || worker || stopping || Date.now() - failedAt < 60_000) return;
    try {
      const current = workerFactory({ workerData: { modelPerformance: true, directory, codexHome },
        resourceLimits: { maxOldGenerationSizeMb: 128 } });
      worker = current;
      current.on('message', message => {
        if (worker !== current) return;
        if (message?.type === 'snapshots' && Array.isArray(message.values)) {
          for (const value of message.values) {
            if (!PERIODS.includes(value.period)) continue;
            const key = value.requestKey ?? value.period;
            if (key !== value.period && !windows.has(key)) continue;
            const { requestKey, ...snapshot } = value;
            cache.set(key, snapshot);
            while (cache.size > MAX_WINDOWS + PERIODS.length) cache.delete(cache.keys().next().value);
          }
        } else if (message?.type === 'unavailable') fail();
      });
      current.on('error', fail);
      current.on('exit', code => {
        if (worker === current) { worker = null; if (code !== 0) fail(); }
      });
      for (const value of windows.values()) current.postMessage({ type: 'window', ...value });
      current.unref?.();
    } catch { fail(); }
  }
  return {
    async read(period, { endAt } = {}) {
      if (!PERIODS.includes(period)) throw new Error('invalid_timing_period');
      const end = endAt === undefined ? null : Date.parse(endAt);
      if (endAt !== undefined && (typeof endAt !== 'string' || !Number.isSafeInteger(end)
          || end < 0 || end > Date.now() || new Date(end).toISOString() !== endAt)) throw new Error('invalid_timing_window');
      const key = end === null ? period : `${period}:${end}`;
      const fallback = status => ({ ...empty(period, status), ...(end === null ? {} : { end, start: period === 'all' ? null : Math.max(0, end - Number(period) * 86400000) }) });
      // The timing sidecar currently requires POSIX owner protection. Report
      // this fixed platform boundary without starting a worker or retry timer.
      if (closed || platform === 'win32') return fallback('unavailable');
      if (end !== null && !windows.has(key)) {
        windows.set(key, { period, end, requestKey: key });
        while (windows.size > MAX_WINDOWS) { const oldest = windows.keys().next().value; windows.delete(oldest); cache.delete(oldest); }
        worker?.postMessage({ type: 'window', period, end, requestKey: key });
      }
      start();
      scheduleIdleStop();
      return cache.get(key) ?? fallback(failedAt ? 'unavailable' : 'loading');
    },
    async close() { closed = true; await stop(); },
  };
}
