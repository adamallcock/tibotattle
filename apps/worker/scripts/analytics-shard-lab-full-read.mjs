import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { boundedLabPool, inspectLabDatabase, targetSegments, labDigest } from './analytics-shard-lab-core.mjs';
import { validateOnlineLabPlan, parseOnlineLabArgs, makeLabApi, makeRemoteLabDatabase } from './analytics-shard-lab-online.mjs';

const fail = code => { throw Object.assign(Error(`SHARD_LAB_FULL_${code}`), { code: `SHARD_LAB_FULL_${code}` }); };
export async function readWholeLabPartition(db, segments) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 54
    || segments.some(s => !Number.isSafeInteger(s.group) || s.group < 1 || !Number.isSafeInteger(s.from)
      || s.from < 1 || !Number.isSafeInteger(s.through) || s.through < s.from)
    || new Set(segments.map(s => s.group)).size !== segments.length) fail('RANGE_INVALID');
  const expected = segments.reduce((n, s) => n + s.through - s.from + 1, 0);
  if (expected > 3_000_000) fail('RANGE_LIMIT');
  const expectedSum = segments.reduce((n, s) => n + (s.from + s.through) * (s.through - s.from + 1) / 2, 0);
  const ranges = segments.map(s => ({ group: s.group, from: s.from, through: s.through }));
  const result = await db.prepare("WITH ranges AS(SELECT json_extract(value,'$.group') AS owner_id,json_extract(value,'$.from') AS first_id,json_extract(value,'$.through') AS last_id FROM json_each(?)) SELECT count(*) AS records,coalesce(sum(r.id),0) AS checksum FROM ranges w CROSS JOIN shard_lab_records r INDEXED BY shard_lab_owner_occurrence ON r.owner_id=w.owner_id AND r.occurrence_id BETWEEN CAST(printf('%042d',w.first_id) AS BLOB) AND CAST(printf('%042d',w.last_id) AS BLOB)")
    .bind(JSON.stringify(ranges)).all();
  const row = result.results?.[0];
  if (result.success !== true || result.results?.length !== 1 || row.records !== expected || row.checksum !== expectedSum)
    fail('PARITY_FAILED');
  if (['rows_read', 'rows_written', 'duration'].some(k => !Number.isFinite(result.meta?.[k]) || result.meta[k] < 0)
    || result.meta.rows_written !== 0) fail('MEASUREMENT_INVALID');
  return { records: row.records, checksum: row.checksum, rowsRead: result.meta.rows_read, databaseMs: result.meta.duration };
}
export async function measureFullLabRead(databases, plan, trials = 3) {
  if (!Array.isArray(databases) || databases.length !== 5 || !Number.isInteger(trials) || trials < 1 || trials > 3) fail('INPUT_INVALID');
  for (let i = 0; i < 5; i++) if ((await inspectLabDatabase(databases[i], plan, i - 1)).state !== 'ready') fail('NOT_READY');
  const partitions = [0, 1, 2, 3].map(t => targetSegments(plan, t));
  const run = (layout, concurrency) => boundedLabPool(partitions, concurrency,
    (segments, target) => readWholeLabPartition(databases[layout === 'baseline' ? 0 : target + 1], segments));
  for (const layout of ['baseline', 'shards']) await run(layout, 4);
  const results = [];
  for (const concurrency of [1, 2, 4]) for (let trial = 0; trial < trials; trial++) {
    for (const layout of trial % 2 ? ['shards', 'baseline'] : ['baseline', 'shards']) {
      const start = performance.now(), rows = await run(layout, concurrency);
      const records = rows.reduce((n, r) => n + r.records, 0), checksum = rows.reduce((n, r) => n + r.checksum, 0);
      if (records !== plan.totalRows || checksum !== plan.totalRows * (plan.totalRows + 1) / 2) fail('PARITY_FAILED');
      results.push({ layout, concurrency, trial, queries: 4, records, checksum, wallMs: performance.now() - start,
        rowsRead: rows.reduce((n, r) => n + r.rowsRead, 0), databaseMs: rows.reduce((n, r) => n + r.databaseMs, 0) });
    }
  }
  const median = a => [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)];
  const summary = [1, 2, 4].map(concurrency => {
    const base = results.filter(r => r.layout === 'baseline' && r.concurrency === concurrency);
    const shard = results.filter(r => r.layout === 'shards' && r.concurrency === concurrency);
    const baselineMs = median(base.map(r => r.wallMs)), shardMs = median(shard.map(r => r.wallMs));
    return { concurrency, baselineMs, shardMs, wallRatio: baselineMs / shardMs,
      baselineRowsRead: median(base.map(r => r.rowsRead)), shardRowsRead: median(shard.map(r => r.rowsRead)),
      baselineDatabaseMs: median(base.map(r => r.databaseMs)), shardDatabaseMs: median(shard.map(r => r.databaseMs)), parity: true };
  });
  return { workload: 'whole-synthetic-header-count-scan', rows: plan.totalRows, results, summary,
    claim: 'four bounded indexed count/checksum scans; only four aggregate rows returned, no header transfer or application throughput measured' };
}
async function privateJson(path) {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await h.stat();
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o077) || s.size > 1024 * 1024) fail('FILE_UNSAFE');
    return JSON.parse(await h.readFile('utf8'));
  } finally { await h.close(); }
}
async function main() {
  const args = parseOnlineLabArgs(['--mode', 'measure', ...process.argv.slice(2)]), dir = args['--dir'];
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail('DIRECTORY_UNSAFE');
  const plan = validateOnlineLabPlan(await privateJson(resolve(dir, 'plan.json'))), state = await privateJson(resolve(dir, 'state.json'));
  const scriptDir = dirname(fileURLToPath(import.meta.url)), hash = b => createHash('sha256').update(b).digest('hex');
  const selfSha = hash(await readFile(fileURLToPath(import.meta.url)));
  const guard = async write => {
    if (write || labDigest(plan) !== args['--approve-plan'] || labDigest(await privateJson(resolve(dir, 'plan.json'))) !== labDigest(plan)
      || hash(await readFile(fileURLToPath(import.meta.url))) !== selfSha) fail('PLAN_DRIFT');
    for (const source of plan.sources) if (hash(await readFile(resolve(scriptDir, source.path))) !== source.sha256) fail('SOURCE_DRIFT');
  };
  await guard(false);
  if (state.planSha256 !== labDigest(plan) || state.targets?.length !== 5 || new Set(state.targets.map(t => t.id)).size !== 5) fail('STATE_DRIFT');
  const api = makeLabApi({ accountId: plan.accountId, token: process.env.CLOUDFLARE_API_TOKEN });
  for (let i = 0; i < 5; i++) {
    const t = state.targets[i], actual = await api('/' + t.id);
    if (t.status !== 'created' || actual.uuid !== t.id || actual.name !== plan.targets[i].name || actual.read_replication?.mode !== 'disabled') fail('RESOURCE_DRIFT');
  }
  const measurements = await measureFullLabRead(state.targets.map(t => makeRemoteLabDatabase(api, t.id, guard)), plan.placement);
  const receipt = { schema: 'whole-synthetic-header-read-v1', recordedAt: new Date().toISOString(),
    planSha256: labDigest(plan), toolSha256: selfSha, environment: plan.environment, dataKind: 'synthetic', remoteWrites: false, ...measurements };
  await writeFile(resolve(dir, `whole-read-${randomUUID()}.json`), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase: 'whole-read-complete', rows: measurements.rows, summary: measurements.summary }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(JSON.stringify({ status: 'stopped', code: /^SHARD_LAB_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'SHARD_LAB_FULL_OPERATION_FAILED' }));
  process.exitCode = 1;
});
