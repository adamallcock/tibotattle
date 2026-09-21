import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
// Keep the worker reachable to the native runtime dependency scanner.
import './model-performance-worker.js';
import { createModelPerformanceSnapshotStore, isCompleteModelPerformanceSnapshot,
  readModelPerformanceSnapshotEntry, modelPerformanceSourceScope,
  MODEL_PERFORMANCE_MAX_WINDOWS as MAX_WINDOWS, MODEL_PERFORMANCE_PERIODS as PERIODS } from './model-performance-snapshots.js';

export function createModelPerformanceController({ directory, codexHome,
  idleMs = 60_000, snapshotNow = () => Date.now(), snapshotWriteIntervalMs = 60 * 60 * 1_000,
  workerFactory = options => new Worker(new URL('./model-performance-worker.js', import.meta.url), options) }) {
  if (typeof snapshotNow !== 'function') throw new TypeError('snapshotNow must be a function');
  if (!Number.isSafeInteger(snapshotWriteIntervalMs) || snapshotWriteIntervalMs < 1)
    throw new TypeError('snapshotWriteIntervalMs must be a positive integer');
  const cache = new Map(), complete = new Map(), windows = new Map();
  const store = createModelPerformanceSnapshotStore({ directory, codexHome, now: snapshotNow });
  const sourceScope = modelPerformanceSourceScope(codexHome);
  const timingRoot = sourceScope && typeof directory === 'string' ? directory : undefined;
  // Keep each configured source's durable rows separate. The legacy unscoped
  // sidecar has no source provenance, so preserve it without opening/migrating it.
  const workerDirectory = timingRoot === undefined ? directory : join(timingRoot, `source-${sourceScope}`);
  let worker = null, idle = null, closed = false, failedAt = 0, stopping = null;
  let restoration = null, writing = null, pending = null;
  let lastPersistedAt = null, revision = 0, savedRevision = -1;
  const empty = (period, status) => ({ schemaVersion: 3, method: 4, status, collecting: false, stale: false,
    updatedAt: null, period, interval: 'day', start: null, end: Date.now(), historyProgress: null, models: [] });
  function restore() {
    restoration ??= (async () => {
      try {
        const receipt = await store?.read();
        if (closed || !receipt) return;
        lastPersistedAt = Date.parse(receipt.savedAt);
        savedRevision = revision;
        for (const entry of receipt.values) {
          const { key, snapshot: value } = readModelPerformanceSnapshotEntry(entry);
          if (key !== value.period) windows.set(key, { period: value.period, end: value.end, requestKey: key });
          complete.set(key, value);
          cache.set(key, { ...value, collecting: true, historyProgress: null });
        }
      } catch { /* A missing or rejected receipt never blocks live measurements. */ }
    })();
    return restoration;
  }
  const withinWriteInterval = nowMs => lastPersistedAt !== null && nowMs >= lastPersistedAt
    && nowMs - lastPersistedAt < snapshotWriteIntervalMs;
  function persist(force = false) {
    if (!store || !complete.size || savedRevision === revision) return;
    let nowMs;
    try { nowMs = snapshotNow(); } catch { return; }
    // Match the dashboard's first-result/hourly disk cadence. Live completed
    // measurements stay in memory between writes; close flushes the newest one.
    if (!Number.isFinite(nowMs) || (!force && withinWriteInterval(nowMs))) return;
    // Keep one queued immutable candidate: a slow disk cannot accumulate an
    // unbounded write queue, and older writes can never overtake newer ones.
    pending = { values: structuredClone([...complete].map(([key, snapshot]) => key === snapshot.period
      ? snapshot : { ...snapshot, requestKey: key })), revision, nowMs, force };
    if (writing) return;
    writing = (async () => {
      while (pending) {
        const candidate = pending; pending = null;
        if (candidate.revision === savedRevision || (!candidate.force && withinWriteInterval(candidate.nowMs))) continue;
        try {
          if (await store.write(candidate.values)) {
            lastPersistedAt = candidate.nowMs;
            savedRevision = candidate.revision;
          }
        } catch { /* Retain the previous atomic receipt. */ }
      }
    })().finally(() => {
      writing = null;
      if (pending) {
        const force = pending.force; pending = null;
        persist(force);
      }
    });
  }
  function fail() {
    failedAt = Date.now();
    for (const [period, value] of cache) cache.set(period, { ...value, collecting: false, stale: true });
  }
  function scheduleIdleStop() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idle = null;
      // Once requested by the dashboard, finish the discovered history pass
      // even if its page is inactive. This remains off-main; completed
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
      const current = workerFactory({ workerData: { modelPerformance: true,
        directory: workerDirectory, timingRoot, codexHome },
        resourceLimits: { maxOldGenerationSizeMb: 128 } });
      worker = current;
      for (const [period, value] of complete) cache.set(period, { ...value, collecting: true, historyProgress: null });
      current.on('message', message => {
        if (closed || worker !== current) return;
        if (message?.type === 'snapshots' && Array.isArray(message.values)) {
          if (message.values.length > MAX_WINDOWS + PERIODS.length) { fail(); return; }
          const entries = message.values.map(readModelPerformanceSnapshotEntry);
          if (entries.some(value => value === null)
              || new Set(entries.map(value => value.key)).size !== entries.length) { fail(); return; }
          let changed = false;
          for (const { key, snapshot: value } of entries) {
            // A late projection for an evicted window cannot resurrect it or
            // replace the requested period's independently keyed snapshot.
            if (key !== value.period && !windows.has(key)) continue;
            const previous = complete.get(key);
            if (isCompleteModelPerformanceSnapshot(value)) {
              complete.set(key, value);
              cache.set(key, value);
              changed = true;
            } else if (previous) {
              cache.set(key, { ...previous, collecting: value.collecting, stale: value.stale,
                historyProgress: value.historyProgress });
            } else cache.set(key, value);
          }
          if (changed) { revision++; persist(); }
        } else if (message?.type === 'unavailable') fail();
      });
      current.on('error', () => { if (!closed && worker === current) fail(); });
      current.on('exit', code => {
        if (worker === current) {
          worker = null;
          if (code !== 0) fail();
        }
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
      // Platform capability is checked inside the worker before source discovery.
      if (closed) return fallback('unavailable');
      await restore();
      if (closed) return fallback('unavailable');
      if (end !== null && !windows.has(key)) {
        windows.set(key, { period, end, requestKey: key });
        while (windows.size > MAX_WINDOWS) {
          const oldest = windows.keys().next().value;
          windows.delete(oldest); cache.delete(oldest);
          if (complete.delete(oldest)) revision++;
        }
        worker?.postMessage({ type: 'window', period, end, requestKey: key });
      }
      start();
      scheduleIdleStop();
      return cache.get(key) ?? fallback(failedAt ? 'unavailable' : 'loading');
    },
    async close() {
      closed = true;
      await stop();
      await restoration;
      persist(true);
      while (writing) await writing;
    },
  };
}
