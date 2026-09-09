import { Worker } from 'node:worker_threads';
// Keep the worker reachable to the native runtime dependency scanner.
import './model-performance-worker.js';

const PERIODS = ['7', '30', 'all'];
export function createModelPerformanceController({ directory, codexHome,
  idleMs = 60_000, workerFactory = options => new Worker(new URL('./model-performance-worker.js', import.meta.url), options) }) {
  const cache = new Map();
  let worker = null, idle = null, closed = false, failedAt = 0, stopping = null;
  const empty = (period, status) => ({ schemaVersion: 1, method: 2, status, collecting: false, stale: false,
    updatedAt: null, period, interval: 'day', start: null, end: Date.now(), models: [] });
  function fail() {
    failedAt = Date.now();
    for (const [period, value] of cache) cache.set(period, { ...value, collecting: false, stale: true });
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
          for (const value of message.values) if (PERIODS.includes(value.period)) cache.set(value.period, value);
        } else if (message?.type === 'unavailable') fail();
      });
      current.on('error', fail);
      current.on('exit', code => {
        if (worker === current) { worker = null; if (code !== 0) fail(); }
      });
      current.unref?.();
    } catch { fail(); }
  }
  return {
    async read(period) {
      if (!PERIODS.includes(period)) throw new Error('invalid_timing_period');
      if (closed) return empty(period, 'unavailable');
      start();
      clearTimeout(idle);
      idle = setTimeout(() => { void stop(); }, idleMs); idle.unref?.();
      return cache.get(period) ?? empty(period, failedAt ? 'unavailable' : 'loading');
    },
    async close() { closed = true; await stop(); },
  };
}
