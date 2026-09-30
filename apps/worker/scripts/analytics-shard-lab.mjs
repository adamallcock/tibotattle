import { Miniflare } from 'miniflare';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syntheticD1Binding, closeSyntheticD1Bindings, SYNTHETIC_D1_WORKER } from './d1-storage-local-d1.mjs';
import { syntheticLabPlan, seedLabDatabases, measureLabDatabases } from './analytics-shard-lab-runner.mjs';

// Local only, no token or external API. An existing output directory refuses.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--rows' || args[2] !== '--out') throw Error('SHARD_LAB_USAGE');
const rows = Number(args[1]), out = resolve(args[3]);
if (!/^\/private\/tmp\/tibotattle-shard-local-[a-z0-9-]+$/.test(out)) throw Error('SHARD_LAB_OUTPUT_PATH');
const plan = syntheticLabPlan(rows);
await mkdir(out, { mode: 0o700 });
const runtimes = [];
try {
  // Distinct workerd instances and transports; one shared HTTP agent would
  // serialize the test before it reaches independent database queues.
  for (let i = 0; i < 5; i++) runtimes.push(new Miniflare({ host: '127.0.0.1', cf: false,
    modules: true, script: SYNTHETIC_D1_WORKER, compatibilityDate: '2026-07-26',
    d1Databases: { TARGET: `synthetic-shard-${i}` } }));
  const databases = runtimes.map(mf => syntheticD1Binding(mf, 'TARGET'));
  const seed = await seedLabDatabases(databases, plan, p => console.log(JSON.stringify({ phase: 'seed', ...p })));
  const measurements = await measureLabDatabases(databases, plan);
  const receipt = { method: plan.method, dataKind: 'synthetic', environment: 'local-native-d1',
    completedAt: new Date().toISOString(), rows, loads: plan.loads, seed, ...measurements };
  await writeFile(resolve(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ phase: 'complete', rows, loads: plan.loads, summary: measurements.summary }));
} finally {
  for (const mf of runtimes) { await closeSyntheticD1Bindings(mf); await mf.dispose(); }
}
