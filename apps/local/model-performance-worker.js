import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../../src/platform/index.js';
import { createModelPerformanceContext } from '../../src/application/index.js';

// Separate from accounting: no accounting DB, and starts only when a dashboard
// reader requests it (including background preparation after first paint).
// Fixed, bounded errors only.
async function run() {
  const context = createModelPerformanceContext({ openStore: openTimingStore });
  const abort = new AbortController();
  let timer, store, supplement, files = null, cursor = 0, discoveryAt = 0, stopped = false, degraded = false, passFailed = false;
  const windows = new Map();
  let windowsChanged = false;
  const stop = () => { stopped = true; clearTimeout(timer); abort.abort(); };
  parentPort.on('message', message => {
    if (message?.type === 'stop') stop();
    else if (message?.type === 'window' && ['1','7','30','all'].includes(message.period)
      && Number.isSafeInteger(message.end) && message.end >= 0 && message.end <= Date.now()
      && message.requestKey === `${message.period}:${message.end}`) {
      windows.set(message.requestKey, message); windowsChanged = true;
      while (windows.size > 8) windows.delete(windows.keys().next().value);
    }
  });
  async function discover() {
    const result = []; let entries = 0;
    async function walk(path, depth) {
      if (depth > 3 || stopped) return;
      let directory;
      try { directory = await opendir(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for await (const entry of directory) {
        if (stopped) return;
        if (++entries > 50000) throw new Error('discovery_limit');
        const next = join(path, entry.name);
        if (entry.isDirectory()) await walk(next, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const stat = await lstat(next);
          result.push({ path: next, at: stat.mtimeMs });
        }
      }
    }
    await walk(join(workerData.codexHome, 'sessions'), 0);
    await walk(join(workerData.codexHome, 'archived_sessions'), 0);
    return result.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
  }
  let lastPublished = 0, lastCollecting = null;
  function publish(collecting) {
    let rows;
    try { rows = readTimingRows(store, { supplement }); }
    catch { degraded = true; passFailed = true; rows = readTimingRows(store); }
    const now = Date.now();
    lastPublished = now; lastCollecting = collecting; windowsChanged = false;
    parentPort.postMessage({ type: 'snapshots', values: [
      ...['1', '7', '30', 'all'].map(period => ({ period, end: now })), ...windows.values(),
    ].map(({period, end, requestKey}) => ({
      ...(requestKey ? { requestKey } : {}),
      ...context.project(rows, { period, now: end, rolling: Boolean(requestKey), historyProgress: files === null ? null : {
        checked: Math.min(cursor, files.length), total: files.length,
      } }), updatedAt: new Date(now).toISOString(), collecting, stale: degraded,
    })) });
  }
  try {
    store = await context.open(workerData.directory);
    publish(true);
    // Additive, independently checkpointed backfill. Failure leaves all original
    // saved measurements usable. The original store/schema is never converted.
    try { supplement = await context.openSupplement(join(workerData.directory, 'tool-free-v1'), store.key); }
    catch { degraded = true; }
    while (!stopped) {
      try {
        if (files === null || (cursor >= files.length && Date.now() - discoveryAt >= 60_000)) {
          files = await discover(); cursor = 0; discoveryAt = Date.now(); passFailed = !supplement;
        }
        const started = performance.now(); let bytes = 0;
        while (!stopped && cursor < files.length && bytes < 32 * 1024 ** 2 && performance.now() - started < 750) {
          try {
            let done = true;
            // Two 2-MiB chunks preserve the original total 4-MiB slice budget.
            for (const target of [store, supplement].filter(Boolean)) {
              try {
                const result = await ingestTimingFile(target, files[cursor].path, { maxBytes: 2 * 1024 ** 2, signal: abort.signal });
                bytes += result.bytes;
                if (result.remaining && !result.unchanged && !(result.partial && result.bytes < 2 * 1024 ** 2)) done = false;
              } catch (e) {
                if (stopped) break;
                bytes += e.attemptedBytes ?? 0; degraded = true; passFailed = true;
              }
            }
            if (done) cursor++;
          } catch (e) {
            if (stopped) break;
            bytes += e.attemptedBytes ?? 0; cursor++; degraded = true; passFailed = true;
          }
          await yieldTurn();
        }
        if (files && cursor >= files.length) degraded = passFailed;
        const collecting = cursor < files.length;
        if (!stopped && (windowsChanged || lastCollecting !== collecting || Date.now() - lastPublished >= 5_000))
          publish(collecting);
      } catch {
        degraded = true; passFailed = true;
        if (!stopped) { try { publish(false); } catch { parentPort.postMessage({ type: 'unavailable' }); } }
      }
      if (!stopped) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
        timer = setTimeout(done, files && cursor < files.length ? 250 : 5000);
        abort.signal.addEventListener('abort', done, { once: true });
      });
    }
  } catch { parentPort.postMessage({ type: 'unavailable' }); }
  finally { try { supplement?.close(); } finally { store?.close(); parentPort.close(); } }
}
if (!isMainThread && workerData?.modelPerformance === true) void run();
