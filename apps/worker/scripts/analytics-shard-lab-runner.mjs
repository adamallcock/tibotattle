import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LAB_MAX_ROWS, LAB_PAGE_ROWS, continuityBucket, planLabPlacement, targetSegments,
  initializeLabDatabase, inspectLabDatabase, advanceLabSeed, boundedLabPool,
  lookupLabSegment, scanLabSegment } from './analytics-shard-lab-core.mjs';

export const OBSERVED_RECORDS = 9_811_828;
export const OBSERVED_LARGEST = 2_521_345;
// Only total cardinality, number of physical owners and the largest observed
// weight are measured. Every other weight and identifier below is synthetic.
export function syntheticLabPlan(rows = 100_000) {
  if (!Number.isSafeInteger(rows) || rows < 1_000 || rows > LAB_MAX_ROWS) throw Error('SHARD_LAB_ROW_LIMIT');
  const largest = Math.floor(rows * OBSERVED_LARGEST / OBSERVED_RECORDS);
  const weights = Array.from({ length: 53 }, (_, i) => 1 / Math.pow(i + 1, 0.7));
  const denominator = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map(w => Math.floor((rows - largest) * w / denominator));
  counts[counts.length - 1] += rows - largest - counts.reduce((a, b) => a + b, 0);
  return planLabPlacement([largest, ...counts].map((records, i) => ({ group: i + 1, records,
    bucket: continuityBucket('synthetic-analytics-shard-lab', createHash('sha256').update(`synthetic-group-${i}`).digest('hex')) })), 4);
}
const costZero = () => ({ rowsRead: 0, rowsWritten: 0, databaseMs: 0 });
const addCost = (a, b) => { for (const key of Object.keys(a)) a[key] += b[key]; };
export async function seedLabTarget(db, plan, target, report = () => {}) {
  const start = performance.now(), before = await initializeLabDatabase(db, plan, target);
  const expected = targetSegments(plan, target).reduce((n, s) => n + s.through - s.from + 1, 0);
  const cost = costZero(); let pages = 0, measurementComplete = before.records === 0;
  for (let i = 0; i <= Math.ceil(expected / LAB_PAGE_ROWS) + plan.segments.length + 1; i++) {
    const result = await advanceLabSeed(db, plan, target);
    if (result.cost) addCost(cost, result.cost);
    if (result.measurementComplete === false) measurementComplete = false;
    pages++;
    if (pages % 25 === 0 || result.state === 'ready') report({ target, records: result.records, expected });
    if (result.state === 'ready') return { target, records: result.records, resumedRecords: before.records,
      pages, wallMs: performance.now() - start, measurementComplete, ...cost };
  }
  throw Error('SHARD_LAB_SEED_STEP_LIMIT');
}
export async function seedLabDatabases(databases, plan, report) {
  if (!Array.isArray(databases) || databases.length !== 5) throw Error('SHARD_LAB_DATABASE_SET');
  const baseline = await seedLabTarget(databases[0], plan, -1, report);
  const start = performance.now();
  const shards = await boundedLabPool([0, 1, 2, 3], 4, target => seedLabTarget(databases[target + 1], plan, target, report));
  return { baseline, shards, shardWallMs: performance.now() - start };
}
export async function measureLabDatabases(databases, plan, trials = 3) {
  if (!Array.isArray(databases) || databases.length !== 5 || !Number.isInteger(trials) || trials < 1 || trials > 3)
    throw Error('SHARD_LAB_MEASUREMENT_LIMIT');
  for (let i = 0; i < databases.length; i++) {
    if ((await inspectLabDatabase(databases[i], plan, i - 1)).state !== 'ready') throw Error('SHARD_LAB_NOT_READY');
  }
  const results = [];
  for (const workload of ['occurrence', 'range']) {
    const execute = workload === 'occurrence' ? lookupLabSegment : scanLabSegment;
    // Warm both physical layouts with identical keys; warm evidence only.
    for (const layout of ['baseline', 'shards'])
      await boundedLabPool(plan.segments, 4, s => execute(databases[layout === 'baseline' ? 0 : s.target + 1], s));
    for (const concurrency of [1, 2, 4]) for (let trial = 0; trial < trials; trial++) {
      for (const layout of trial % 2 ? ['shards', 'baseline'] : ['baseline', 'shards']) {
        const start = performance.now();
        const values = await boundedLabPool(plan.segments, concurrency,
          s => execute(databases[layout === 'baseline' ? 0 : s.target + 1], s));
        const cost = costZero(); for (const value of values) addCost(cost, value);
        results.push({ workload, concurrency, trial, layout, queries: values.length,
          records: values.reduce((n, v) => n + v.records, 0),
          checksum: values.reduce((n, v) => n + v.checksum, 0), wallMs: performance.now() - start, ...cost });
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = [];
  for (const workload of ['occurrence', 'range']) for (const concurrency of [1, 2, 4]) {
    const a = results.filter(r => r.workload === workload && r.concurrency === concurrency && r.layout === 'baseline');
    const b = results.filter(r => r.workload === workload && r.concurrency === concurrency && r.layout === 'shards');
    if ([...a, ...b].some(r => r.records !== a[0].records || r.checksum !== a[0].checksum || r.rowsWritten !== 0))
      throw Error('SHARD_LAB_COMPARISON_PARITY');
    const baselineMs = median(a.map(r => r.wallMs)), shardMs = median(b.map(r => r.wallMs));
    summary.push({ workload, concurrency, baselineMs, shardMs, wallRatio: baselineMs / shardMs,
      baselineRowsRead: median(a.map(r => r.rowsRead)), shardRowsRead: median(b.map(r => r.rowsRead)),
      baselineDatabaseMs: median(a.map(r => r.databaseMs)), shardDatabaseMs: median(b.map(r => r.databaseMs)),
      records: a[0].records, parity: true });
  }
  return { results, summary, claim: 'synthetic indexed count/checksum queries; no header transfer, application output or production throughput' };
}
