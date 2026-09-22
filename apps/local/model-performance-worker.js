import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { opendir, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../../src/platform/index.js';
import {
  createModelPerformanceContext,
  prepareTelemetryPerformanceDay,
  projectTelemetryPerformanceDay,
} from '../../src/application/index.js';

// The Windows native SQLite guard retains the two nearest parent-directory
// handles with delete sharing disabled. A nested supplemental store would
// therefore be unable to reopen its guarded parent while the primary store is
// live. Keep the sidecar under a sibling root on Windows so both stores can be
// opened concurrently without weakening the native guard.
export function modelPerformanceSupplementDirectory({ directory, timingRoot, platform = process.platform }) {
  if (platform !== 'win32' || typeof timingRoot !== 'string' || timingRoot.length === 0
      || typeof directory !== 'string' || directory.length === 0) {
    return join(directory, 'tool-free-v1');
  }
  return join(dirname(timingRoot), 'inference-timing-tool-free-v1', basename(directory));
}

const PERFORMANCE_PARSER_VERSION = 'codex-inference-timing-v17';
const PERFORMANCE_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const PERFORMANCE_PROVIDER = 'openai_codex';

// Separate from accounting: no accounting DB. The worker serves bounded
// dashboard reads and the independently approved daily performance scheduler;
// neither path starts before its own caller opts in. Fixed, bounded errors only.
async function run() {
  const context = createModelPerformanceContext({ openStore: openTimingStore });
  const abort = new AbortController();
  let timer, store, supplement, files = null, cursor = 0, discoveryAt = 0, stopped = false, degraded = false, passFailed = false;
  let publishedRevision = null;
  const windows = new Map();
  let windowsChanged = false;
  const pendingPerformanceRequests = [];
  async function performanceReport(message) {
    if (!store || typeof message?.requestId !== 'string'
        || !PERFORMANCE_DAY.test(message.day)
        || message.provider !== PERFORMANCE_PROVIDER
        || !Number.isSafeInteger(message.nowEpoch)
        || message.nowEpoch < 0) {
      if (typeof message?.requestId === 'string') {
        parentPort.postMessage({ type: 'performance-unavailable', requestId: message.requestId });
      }
      return;
    }
    try {
      const result = readTimingRows(store, { supplement, withRevision: true, day: message.day });
      const rows = projectTelemetryPerformanceDay(result.rows, {
        day: message.day,
        provider: message.provider,
        now: message.nowEpoch,
      });
      const facts = JSON.stringify(result.sources.map(({ id, digest, fingerprint, revision, telemetryRevision, exhausted, role }) => ({
        id, digest, fingerprint, revision, telemetryRevision, exhausted, role,
      })));
      // The timing store's persistent mutation counter advances for every
      // source write, including ordinary appends and replay corrections.  It
      // is content-free and independent of the cache/replay generation fence.
      const sourceRevisionBigInt = result.sources.reduce((sum, source) => sum + BigInt(source.telemetryRevision), 0n);
      if (sourceRevisionBigInt > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('performance_source_revision_overflow');
      const sourceRevision = Number(sourceRevisionBigInt);
      const sourceDigest = createHash('sha256').update(facts).digest('hex');
      const report = await prepareTelemetryPerformanceDay({
        records: rows,
        day: message.day,
        sourceGeneration: `timing:${result.revision}`,
        sourceDigest,
        sourceRevision,
        parserVersion: PERFORMANCE_PARSER_VERSION,
      });
      parentPort.postMessage({ type: 'performance-report', requestId: message.requestId, report });
    } catch {
      parentPort.postMessage({ type: 'performance-unavailable', requestId: message.requestId });
    }
  }
  async function drainPerformanceRequests() {
    while (pendingPerformanceRequests.length > 0 && !stopped) {
      const message = pendingPerformanceRequests.shift();
      if (message) await performanceReport(message);
    }
  }
  const stop = () => { stopped = true; clearTimeout(timer); abort.abort(); };
  parentPort.on('message', message => {
    if (message?.type === 'stop') stop();
    else if (message?.type === 'window' && ['1','7','30','all'].includes(message.period)
      && Number.isSafeInteger(message.end) && message.end >= 0 && message.end <= Date.now()
      && ['standard', 'fast'].includes(message.speedMode)
      && message.requestKey === `${message.period}:${message.speedMode}:${message.end}`) {
      windows.set(message.requestKey, message); windowsChanged = true;
      while (windows.size > 8) windows.delete(windows.keys().next().value);
    } else if (message?.type === 'performance-day') {
      if (!store) {
        if (pendingPerformanceRequests.length < 2) pendingPerformanceRequests.push(message);
        else if (typeof message.requestId === 'string') {
          parentPort.postMessage({ type: 'performance-unavailable', requestId: message.requestId });
        }
      } else {
        void performanceReport(message);
      }
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
    let rows, revision;
    try {
      const result = readTimingRows(store, { supplement, withRevision: true });
      rows = result.rows; revision = result.revision;
    } catch {
      degraded = true; passFailed = true;
      const result = readTimingRows(store, { withRevision: true });
      rows = result.rows; revision = result.revision;
    }
    if (publishedRevision !== null && revision !== publishedRevision) {
      // A completed source grew after its last scan. The store replay has
      // already removed/rebuilt affected logical rows; invalidate any durable
      // dashboard snapshot before publishing the replacement projection.
      parentPort.postMessage({ type: 'invalidate', revision });
    }
    publishedRevision = revision;
    const now = Date.now();
    lastPublished = now; lastCollecting = collecting; windowsChanged = false;
    parentPort.postMessage({ type: 'snapshots', revision, values: [
      ...['1', '7', '30', 'all'].flatMap(period => ['standard', 'fast'].map(speedMode => ({ period, speedMode, end: now }))), ...windows.values(),
    ].map(({period, speedMode, end, requestKey}) => ({
      ...(requestKey ? { requestKey } : {}),
      ...context.project(rows, { period, speedMode, now: end, rolling: Boolean(requestKey), historyProgress: files === null ? null : {
        checked: Math.min(cursor, files.length), total: files.length,
      } }), updatedAt: new Date(now).toISOString(), collecting, stale: degraded,
    })) });
  }
  try {
    // Windows' qualified filesystem adapter creates and verifies both parent
    // directories through its native owner-protection boundary inside open().
    if (process.platform !== 'win32' && workerData.timingRoot !== undefined) {
      const root = resolve(workerData.timingRoot);
      if (await realpath(dirname(root)) !== dirname(root)) throw new Error('unsafe_directory');
      await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const metadata = await lstat(root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
          || (metadata.mode & 0o077)) throw new Error('unsafe_directory');
    }
    // Additive, independently checkpointed backfill. Failure leaves all
    // original saved measurements usable; neither store is converted to the
    // other's method or correlation key.
    store = await context.open(workerData.directory);
    // Publish only after both independent stores are opened so the first
    // revision token does not spuriously change when the supplement appears.
    try {
      supplement = await context.openSupplement(modelPerformanceSupplementDirectory({
        directory: workerData.directory,
        timingRoot: workerData.timingRoot,
      }), store.key);
    }
    catch { degraded = true; }
    await drainPerformanceRequests();
    publish(true);
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
