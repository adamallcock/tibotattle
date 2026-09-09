import { opendir, lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { openStore, ingestFile, report } from './store.mjs';
import { forEachRolloutLine } from '../../../src/rollout-line-reader.js';

export function argumentsFor(argv) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    root: { type: 'string' }, output: { type: 'string' }, since: { type: 'string' },
    'max-bytes': { type: 'string', default: '1073741824' },
    'max-files': { type: 'string', default: '50' },
    'max-seconds': { type: 'string', default: '60' }, baseline: { type: 'boolean', default: false },
  } });
  if (!values.root || !values.output || !/^\d{4}-\d{2}-\d{2}$/.test(values.since ?? '')
    || !Number.isFinite(Date.parse(values.since))) throw new Error('invalid_arguments');
  for (const [name, upper] of [['max-bytes', 8 * 1024 ** 3], ['max-files', 5000], ['max-seconds', 300]]) {
    const n = Number(values[name]);
    if (!Number.isSafeInteger(n) || n < 1 || n > upper) throw new Error('invalid_budget');
    values[name] = n;
  }
  return values;
}

async function discover(root, since, maxFiles) {
  const files = []; let entries = 0;
  async function walk(path, depth) {
    if (depth > 3) return;
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (++entries > 50000) throw new Error('discovery_limit');
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const s = await lstat(next);
        if (s.mtimeMs >= since) files.push({ path: next, mtime: s.mtimeMs, size: s.size });
      }
    }
  }
  await walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return { files: files.slice(0, maxFiles), candidates: files.length };
}

const ERROR_CODES = new Set(['cancelled', 'source_replaced', 'source_rewritten', 'source_changed',
  'line_exceeds_budget', 'unsafe_source', 'SQLITE_BUSY', 'SQLITE_FULL']);
export async function run(options, signal) {
  const started = performance.now();
  const selection = await discover(resolve(options.root), Date.parse(options.since), options['max-files']);
  const output = resolve(options.output);
  await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 });
  const store = await openStore(output);
  const summary = { baseline: options.baseline, selected: selection.files.length,
    candidates: selection.candidates, scanned: 0, unchanged: 0, scanBytes: 0, failures: {}, limited: false };
  try {
    for (const file of selection.files) {
      let remaining = 1;
      do {
        const budget = options['max-bytes'] - summary.scanBytes;
        if (signal?.aborted || budget <= 0 || performance.now() - started >= options['max-seconds'] * 1000) {
          summary.limited = true; break;
        }
        try {
          if (options.baseline) {
            const bytes = Math.min(file.size, budget);
            await forEachRolloutLine(file.path, { start: 0, end: bytes, signal, onLine: () => {} });
            summary.scanBytes += bytes; remaining = 0;
          } else {
            const r = await ingestFile(store, file.path, { maxBytes: Math.min(budget, 16 * 1024 ** 2), signal });
            summary.scanBytes += r.bytes; remaining = r.remaining ?? 0;
            if (r.unchanged) summary.unchanged++;
            // Avoid re-reading a trailing partial record until the source grows.
            if (r.partial && r.remaining < 16 * 1024 ** 2 && r.bytes < 16 * 1024 ** 2) remaining = 0;
          }
        } catch (e) {
          // Reserve the attempted range even if the transaction rolls back.
          summary.scanBytes += e.attemptedBytes ?? 0;
          const code = ERROR_CODES.has(e.message) ? e.message : ERROR_CODES.has(e.code) ? e.code : 'source_unavailable';
          summary.failures[code] = (summary.failures[code] ?? 0) + 1;
          remaining = 0;
        }
      } while (remaining > 0);
      if (summary.limited) break;
      summary.scanned++;
    }
    summary.elapsedMs = Math.round(performance.now() - started);
    summary.peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
    summary.databaseBytes = (await lstat(store.file)).size;
    const data = report(store);
    summary.turns = data.turns.length;
    summary.completeTps = data.turns.filter(t => t.duration !== null).length;
    summary.recordedTtft = data.turns.filter(t => t.ttft !== null).length;
    // No-clobber output artifacts; repeated runs create separate receipts.
    const name = `${options.baseline ? 'baseline' : 'measurements'}-${Date.now()}.json`;
    const h = await open(join(output, name), 'wx', 0o600);
    try { await h.writeFile(JSON.stringify({ summary, ...data })); await h.sync(); } finally { await h.close(); }
    return { summary, artifact: join(output, name) };
  } finally { store.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    const result = await run(argumentsFor(process.argv.slice(2)), controller.signal);
    console.log(JSON.stringify(result.summary));
  } catch { console.error('Timing experiment unavailable; accounting is unaffected.'); process.exitCode = 1; }
}
