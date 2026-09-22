import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, link, rm, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { reconcileProductionCandidate, parseProductionReconciliationArgs,
  readPrivateProductionInventory, createPrivateReconciliationOutputDirectory } from './production-reconcile.mjs';

const previous = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const fingerprint = 'c'.repeat(64);
const inventory = { versionId: 'synthetic-version', sourceCommit: previous, fingerprint };

function fixture({ driftBefore = false, driftAfter = false, typedOk = true, sourceClean = true, preserved = true } = {}) {
  let captures = 0;
  let probes = 0;
  const options = { inventory, trackedConfig: {}, sourceCommit: candidate,
    expectedPreviousSourceCommit: previous, workerDirectory: '/synthetic/worker', sourceClean,
    provider: { capture: async () => { captures += 1;
      return { ...inventory, fingerprint: driftBefore || (driftAfter && captures > 1) ? 'd'.repeat(64) : fingerprint }; },
    query: async () => { probes += 1; return { success: true, results: [] }; } },
    buildSchemas: async () => ({ expectedSchemas: {}, inputSha256: {} }),
    inspectTyped: async ({ roles, config, runQuery }) => {
      assert.deepEqual(roles.map(r => r.binding), ['USAGE_MONITOR_DB', 'ANALYTICS_DB', 'DELETION_LEDGER']);
      assert.equal(config.sourceNamespace, 'synthetic.namespace');
      await runQuery('USAGE_MONITOR_DB', 'synthetic-fixed-probe');
      return { ok: typedOk, code: typedOk ? null : 'TYPED_PREFLIGHT_SCHEMA_MISMATCH' };
    },
    configTools: { createSnapshot: value => value,
      render: () => ({ env: { production: { vars: { TELEMETRY_STORAGE_MODE: 'typed', TELEMETRY_STORAGE_NAMESPACE: 'synthetic.namespace' } } } }),
      verify: () => ({ ok: preserved }) },
  };
  return { options, probes: () => probes, captures: () => captures };
}

test('inspection requires fresh configuration before and after schema reads and never qualifies deployment', async () => {
  const f = fixture();
  const { report } = await reconcileProductionCandidate(f.options);
  assert.equal(report.state, 'compatible');
  assert.equal(report.deploymentQualified, false);
  assert.equal(report.publicAssetsVerified, false);
  assert.equal(report.productionWritesPerformed, false);
  assert.equal(report.deploymentPerformed, false);
  assert.equal(f.captures(), 2);
  assert.equal(f.probes(), 1);
});

test('private outputs require a new owner-only directory under a safe parent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'production-output-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await createPrivateReconciliationOutputDirectory(join(root, 'new'));
  assert.equal((await lstat(output)).mode & 0o077, 0);
  await assert.rejects(createPrivateReconciliationOutputDirectory(output), { code: 'EEXIST' });
  await symlink(output, join(root, 'alias'));
  await assert.rejects(createPrivateReconciliationOutputDirectory(join(root, 'alias')), { code: 'EEXIST' });
  const shared = join(root, 'shared');
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o777);
  await assert.rejects(createPrivateReconciliationOutputDirectory(join(shared, 'new')), { code: 'PRODUCTION_RECONCILE_OUTPUT_UNSAFE' });
});

test('predecessor and pre-read configuration drift prevent all database reads', async () => {
  const f = fixture({ driftBefore: true });
  await assert.rejects(reconcileProductionCandidate(f.options), { code: 'PRODUCTION_RECONCILE_LIVE_CHANGED' });
  assert.equal(f.probes(), 0);
  await assert.rejects(reconcileProductionCandidate({ ...f.options, expectedPreviousSourceCommit: candidate }),
    { code: 'PRODUCTION_RECONCILE_PREDECESSOR_MISMATCH' });
  assert.equal(f.probes(), 0);
});

test('post-read drift and unverified config prevent a reconciliation receipt', async () => {
  await assert.rejects(reconcileProductionCandidate(fixture({ driftAfter: true }).options),
    { code: 'PRODUCTION_RECONCILE_LIVE_CHANGED' });
  const f = fixture({ preserved: false });
  await assert.rejects(reconcileProductionCandidate(f.options), { code: 'PRODUCTION_RECONCILE_CONFIG_UNVERIFIED' });
  assert.equal(f.probes(), 0);
});

test('dirty source or incompatible typed schema remains blocked without hiding diagnostic evidence', async () => {
  for (const options of [{ typedOk: false }, { sourceClean: false }]) {
    const { report } = await reconcileProductionCandidate(fixture(options).options);
    assert.equal(report.state, 'blocked');
    assert.equal(report.configurationPreserved, true);
    assert.equal(report.deploymentQualified, false);
  }
});

test('arguments require an exact baseline hash and predecessor and reject duplicates and mutation flags', () => {
  const args = ['--inventory', '/synthetic/input.json', '--inventory-sha256', fingerprint,
    '--expected-previous-source', previous, '--output-directory', '/synthetic/new-output'];
  assert.equal(parseProductionReconciliationArgs(args).expectedPreviousSourceCommit, previous);
  for (const invalid of [[], args.slice(0, -2), [...args, '--deploy'], [...args, '--inventory', '/other'],
    args.map(v => v === fingerprint ? 'short' : v)]) {
    assert.throws(() => parseProductionReconciliationArgs(invalid), { code: 'PRODUCTION_RECONCILE_ARGUMENTS_INVALID' });
  }
});

test('private baseline loader refuses changed bytes, public permissions, symlinks, and hardlinks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'production-reconcile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'inventory.json');
  const bytes = Buffer.from('{"synthetic":true}');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes, { mode: 0o600 });
  assert.deepEqual(await readPrivateProductionInventory(path, hash), { synthetic: true });
  await assert.rejects(readPrivateProductionInventory(path, fingerprint), { code: 'PRODUCTION_RECONCILE_INVENTORY_CHANGED' });
  await chmod(path, 0o644);
  await assert.rejects(readPrivateProductionInventory(path, hash), { code: 'PRODUCTION_RECONCILE_INVENTORY_UNSAFE' });
  await chmod(path, 0o600);
  await symlink(path, join(directory, 'symbolic.json'));
  await assert.rejects(readPrivateProductionInventory(join(directory, 'symbolic.json'), hash), { code: 'PRODUCTION_RECONCILE_INVENTORY_UNSAFE' });
  await link(path, join(directory, 'hard.json'));
  await assert.rejects(readPrivateProductionInventory(path, hash), { code: 'PRODUCTION_RECONCILE_INVENTORY_UNSAFE' });
});
