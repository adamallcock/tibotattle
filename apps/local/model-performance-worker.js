import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../../src/platform/index.js';
import { createModelPerformanceContext } from '../../src/application/index.js';

// Separate from accounting: no startup work, no accounting DB, and only while
// a recent page reader holds the controller's lease. Fixed, bounded errors only.
async function run() {
  const context = createModelPerformanceContext({ openStore: openTimingStore });
  const abort = new AbortController();
  let timer, store, files = null, cursor = 0, discoveryAt = 0, stopped = false, degraded = false, passFailed = false;
  const stop = () => { stopped = true; clearTimeout(timer); abort.abort(); };
  parentPort.on('message', message => { if (message?.type === 'stop') stop(); });
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
    const rows = readTimingRows(store), now = Date.now();
    lastPublished = now; lastCollecting = collecting;
    parentPort.postMessage({ type: 'snapshots', values: ['7', '30', 'all'].map(period => ({
      ...context.project(rows, { period, now, historyProgress: files === null ? null : {
        checked: Math.min(cursor, files.length), total: files.length,
      } }), collecting, stale: degraded,
    })) });
  }
  try {
    // The existing sidecar permission contract is POSIX. Unsupported platforms
    // stay unavailable until their protected-state adapter has been qualified.
    if (typeof process.getuid !== 'function') throw new Error('unsupported_platform');
    store = await context.open(workerData.directory);
    publish(true);
    while (!stopped) {
      try {
        if (files === null || (cursor >= files.length && Date.now() - discoveryAt >= 60_000)) {
          files = await discover(); cursor = 0; discoveryAt = Date.now(); passFailed = false;
        }
        const started = performance.now(); let bytes = 0;
        while (!stopped && cursor < files.length && bytes < 32 * 1024 ** 2 && performance.now() - started < 750) {
          try {
            const result = await ingestTimingFile(store, files[cursor].path, { maxBytes: 4 * 1024 ** 2, signal: abort.signal });
            bytes += result.bytes;
            if (!result.remaining || result.unchanged || (result.partial && result.bytes < 4 * 1024 ** 2)) cursor++;
          } catch (e) {
            if (stopped) break;
            bytes += e.attemptedBytes ?? 0; cursor++; degraded = true; passFailed = true;
          }
          await yieldTurn();
        }
        if (files && cursor >= files.length) degraded = passFailed;
        const collecting = cursor < files.length;
        if (!stopped && (lastCollecting !== collecting || Date.now() - lastPublished >= 5_000))
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
  finally { store?.close(); parentPort.close(); }
}
if (!isMainThread && workerData?.modelPerformance === true) void run();
