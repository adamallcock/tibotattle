import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { checkLocalWorkspacePackages } from './check-local-workspace-packages.mjs';

export function parseArguments(args) {
  const result = { full: false, modelBlock: false, dense: false, output: null, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full' && !result.full) result.full = true;
    else if (args[i] === '--model-block' && !result.modelBlock) result.modelBlock = true;
    else if (args[i] === '--dense' && !result.dense) result.dense = true;
    else if (args[i] === '--help' && !result.help) result.help = true;
    else if (args[i] === '--output' && result.output === null && args[i + 1] && !args[i + 1].startsWith('--')) {
      result.output = path.resolve(args[++i]);
    } else throw new Error('Expected --full, --model-block, --dense, --output <new-json-file>, or --help');
  }
  if (result.dense && (!result.modelBlock || !result.full))
    throw new Error('--dense requires --model-block --full');
  return result;
}

export function readBenchmarkSummary(output, modelBlock = false) {
  const prefix = modelBlock ? 'model-block-benchmark' : 'shared-analytics-benchmark';
  const version = modelBlock ? 'model-block-benchmark-v1' : 'shared-analytics-benchmark-v2';
  const matches = output.split('\n').filter(line => line.includes(`${prefix} {`));
  if (matches.length !== 1) throw new Error('Expected one complete benchmark summary');
  const line = matches[0];
  const summary = JSON.parse(line.slice(line.indexOf('{')));
  if (summary.schemaVersion !== version || !summary.phases)
    throw new Error('Invalid benchmark summary');
  return summary;
}

async function inputFingerprint(root) {
  const files = ['package.json', 'package-lock.json', 'wrangler.jsonc', 'vitest.config.ts', 'tsconfig.json'];
  for (const directory of ['src', 'test', 'scripts', 'migrations', 'analytics-migrations',
    'deletion-ledger-migrations', 'routing-migrations', 'typed-ingestion-migrations',
    'ingestion-bridge-migrations', 'typed-v1-admission-migrations', 'typed-v11-admission-migrations',
    'ingestion-isolation-migrations']) {
    for (const entry of await readdir(path.join(root, directory), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(path.relative(root, path.join(entry.parentPath, entry.name)));
    }
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(createHash('sha256').update(await readFile(path.join(root, file))).digest());
  }
  return { sha256: hash.digest('hex'), files: files.length };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    process.stdout.write('Local synthetic analytics benchmark\n'
      + 'Usage: npm run analytics:shared:benchmark -- [--full] [--output <new-json-file>]\n'
      + 'Add --model-block for resumable model-date jobs versus independent current graph jobs.\n'
      + 'Add --dense with --model-block --full for populated days, multi-page usage and the normal 20-second work deadline.\n'
      + 'Default: 14 calendar days / 2 model dates. --full: 130 days / 30 model dates.\n'
      + 'Uses disposable local D1 fixtures. No production credentials, writes or deployment.\n'
      + 'Output files are created exclusively; existing files are never replaced.\n');
    return;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const packages = await checkLocalWorkspacePackages();
  const fingerprint = await inputFingerprint(root);
  const binary = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const testFile = options.modelBlock ? 'test/analytics-model-block-benchmark.spec.ts' : 'test/analytics-shared-benchmark.spec.ts';
  const child = spawn(process.execPath, [binary, 'run', testFile, '--disableConsoleIntercept'], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0', VITE_SHARED_ANALYTICS_BENCHMARK: options.full ? 'full' : 'small',
      VITE_MODEL_BLOCK_DENSITY: options.dense ? 'dense' : 'sparse' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '', overflow = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    if (output.length + chunk.length > 8 * 1024 * 1024) { overflow = true; child.kill('SIGTERM'); }
    else output += chunk;
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  if (overflow) throw new Error('Benchmark output exceeded its local capture bound');
  if (code !== 0) throw new Error('Benchmark did not pass; no result file was written');
  const summary = readBenchmarkSummary(output, options.modelBlock);
  const after = await inputFingerprint(root);
  if (after.sha256 !== fingerprint.sha256) throw new Error('Benchmark inputs changed during the run; rerun before recording results');
  const packagesAfter = await checkLocalWorkspacePackages();
  if (JSON.stringify(packagesAfter) !== JSON.stringify(packages))
    throw new Error('Workspace package copies changed during the run; rerun before recording results');
  if (summary.mode !== (options.full ? 'full' : 'small')) throw new Error('Benchmark workload selection did not match the requested mode');
  if (options.modelBlock && summary.corpus?.density !== (options.dense ? 'dense' : 'sparse'))
    throw new Error('Benchmark density did not match the requested workload');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  summary.evidence = { recordedAt: new Date().toISOString(), nodeVersion: process.version,
    baseCommit: revision.status === 0 ? revision.stdout.trim() : null,
    workingTreeDirty: status.status === 0 ? status.stdout.length > 0 : null,
    workerInputFingerprint: fingerprint,
    fingerprintScope: 'Worker src, test, scripts, source and analytics migrations, package/lockfile, Wrangler and TypeScript/Vitest config.',
    workspacePackageCopies: { verifiedBeforeAndAfter: true,
      packages: packages.packages.map(({ packageName, fileCount, sha256 }) => ({ packageName, fileCount, sha256 })) } };
  if (options.output) {
    await writeFile(options.output, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write('Benchmark summary saved.\n');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
