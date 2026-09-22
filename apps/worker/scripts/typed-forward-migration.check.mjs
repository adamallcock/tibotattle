import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCleanSource,
  createTypedForwardWranglerAdapter,
  prepareTypedForwardPlan,
  parseTypedForwardArguments,
  rehearseTypedForwardMigration,
  runTypedForwardMigration,
  TYPED_FORWARD_CONFIRMATION,
  TYPED_FORWARD_MIGRATIONS,
  TYPED_FORWARD_OPERATING_CAP_BYTES,
  TYPED_FORWARD_PREVIOUS_SOURCE,
  TYPED_FORWARD_ROLE_BINDINGS,
  validateTypedForwardPlan,
  previousReceiptDigest,
} from './typed-forward-migration.mjs';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';

const now = Date.parse('2026-09-22T12:00:00.000Z');
const WORKER_ROOT = process.cwd().endsWith('/apps/worker') ? '.' : 'apps/worker';

async function cleanRepository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'typed-forward-git-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'typed-forward-check@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'typed-forward-check'], { cwd: root });
  await writeFile(join(root, 'source.txt'), 'candidate\n', { mode: 0o600 });
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'candidate'], { cwd: root });
  return { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
}

async function fixture(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'typed-forward-check-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repository = await cleanRepository(t);
  const rehearsal = await rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT });
  const targets = ['primary', 'analytics'].map((role, index) => {
    const evidence = rehearsal.targets[role];
    const previous = { capturedAt: '2026-09-22T00:00:00.000Z', schemaSha256: evidence.schemaSha256,
      dataInvariantSha256: evidence.dataInvariantSha256, ledger: evidence.ledger };
    previous.receiptSha256 = previousReceiptDigest(previous);
    return { role, binding: TYPED_FORWARD_ROLE_BINDINGS[role], name: `typed-forward-${role}`,
      databaseId: `${index + 1}1111111-1111-4111-8111-111111111111`, bytes: 1000,
      migrationGrowthBudgetBytes: 100000, previous };
  });
  const steps = [];
  for (const [index, migration] of TYPED_FORWARD_MIGRATIONS.entries()) {
    const target = targets.find(item => item.role === migration.role);
    const previous = steps.filter(item => item.role === migration.role).at(-1);
    steps.push({ ...migration, beforeSchemaSha256: previous?.afterSchemaSha256 ?? target.previous.schemaSha256,
      afterSchemaSha256: identityDigest({ role: migration.role, name: migration.name, index }) });
  }
  const inventory = { capturedAt: '2026-09-22T00:00:00.000Z', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE,
    versionId: '11111111-1111-4111-8111-111111111111', fingerprint: 'a'.repeat(64),
    targetsSha256: identityDigest(targets.map(target => ({ role: target.role, binding: target.binding, name: target.name,
      databaseId: target.databaseId, bytes: target.bytes }))) };
  const plan = { schema: 'typed-forward-migration-plan-v1', operationId: '11111111-1111-4111-8111-111111111111',
    environment: 'production', accountId: 'b'.repeat(32), workerName: 'typed-forward-worker', previousSourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE,
    candidateSourceCommit: repository.commit, createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86_399_000).toISOString(),
    operatingCapBytes: TYPED_FORWARD_OPERATING_CAP_BYTES, wranglerSha256: 'c'.repeat(64), rehearsalSha256: identityDigest(rehearsal),
    inventory, targets, steps };
  validateTypedForwardPlan(plan, { now });
  let owner = null;
  const lock = { async createOwner() { return 'd'.repeat(40); }, async status() { return owner; },
    async acquire(next) { assert.equal(owner, null); owner = next; }, async assertOwned(expected) { assert.equal(owner, expected); },
    async release(expected) { assert.equal(owner, expected); owner = null; } };
  const counts = { writes: 0 };
  const applied = new Map();
  const adapter = {
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: target.bytes }]; },
    async inspect(target) {
      const count = applied.get(target.role) ?? 0;
      const roleSteps = steps.filter(step => step.role === target.role);
      return { schemaSha256: count ? roleSteps[count - 1].afterSchemaSha256 : target.previous.schemaSha256,
        dataInvariantSha256: target.previous.dataInvariantSha256, bytes: target.bytes,
        migrations: [...target.previous.ledger, ...roleSteps.slice(0, count).map(step => ({ name: step.name, sha256: step.sha256 }))] };
    },
    async migrate(target) { counts.writes += 1; applied.set(target.role, (applied.get(target.role) ?? 0) + 1); },
  };
  return { scratch, repository, rehearsal, targets, plan, lock, adapter, applied, counts, owner: () => owner,
    args: { plan, workerRoot: WORKER_ROOT, repositoryRoot: repository.root, operationDirectory: join(scratch, 'operation'),
      execute: true, confirmation: TYPED_FORWARD_CONFIRMATION, approvedPlanSha256: identityDigest(plan), adapterFactory: () => adapter,
      lockFactory: () => lock, now } };
}

test('default and rehearsal modes remain local and refuse injected mutation', async t => {
  const f = await fixture(t);
  const planned = await runTypedForwardMigration({ ...f.args, execute: false, adapterFactory: () => assert.fail('remote adapter constructed'), lockFactory: () => assert.fail('lock constructed') });
  assert.equal(planned.remoteWrites, false);
  await assert.rejects(rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT, injectFailureAt: 'primary:0008_telemetry_v12.sql' }), { code: 'TYPED_FORWARD_INJECTED_REHEARSAL_FAILURE' });
});

test('plan closure binds rehearsal receipt and rejects inventory, source, ledger and order drift', async t => {
  const f = await fixture(t);
  assert.equal(f.plan.rehearsalSha256, identityDigest(f.rehearsal));
  assert.equal(f.plan.steps[0].beforeSchemaSha256, f.targets[0].previous.schemaSha256);
  assert.throws(() => validateTypedForwardPlan({ ...f.plan, inventory: { ...f.plan.inventory, targetsSha256: '0'.repeat(64) } }, { now }), { code: 'TYPED_FORWARD_INVENTORY_INVALID' });
  assert.throws(() => validateTypedForwardPlan({ ...f.plan, previousSourceCommit: 'a'.repeat(40) }, { now }), { code: 'TYPED_FORWARD_PLAN_INVALID' });
  const reordered = structuredClone(f.plan); [reordered.steps[0], reordered.steps[1]] = [reordered.steps[1], reordered.steps[0]];
  assert.throws(() => validateTypedForwardPlan(reordered, { now }), { code: 'TYPED_FORWARD_STEP_ORDER_INVALID' });
  assert.throws(() => assertCleanSource(f.repository.root, 'a'.repeat(40)), { code: 'TYPED_FORWARD_SOURCE_CHECK_FAILED' });
});

test('happy path applies both roles in closed order and releases the shared lock', async t => {
  const f = await fixture(t);
  const result = await runTypedForwardMigration(f.args);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.counts.writes, TYPED_FORWARD_MIGRATIONS.length);
  assert.equal(f.owner(), null);
});

test('schema drift is read-only and retains the lock for operator recovery', async t => {
  const f = await fixture(t);
  f.adapter.inspect = async target => ({ ...(await (async () => ({ schemaSha256: '0'.repeat(64), dataInvariantSha256: target.previous.dataInvariantSha256,
    bytes: target.bytes, migrations: target.previous.ledger }))()) });
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_SCHEMA_PREFIX_DRIFT' });
  assert.equal(f.counts.writes, 0);
  assert.notEqual(f.owner(), null);
});

test('uncertain migration keeps intent and resumes only after an exact read-first reconciliation', async t => {
  const f = await fixture(t);
  const migrate = f.adapter.migrate;
  let first = true;
  f.adapter.migrate = async (...args) => { await migrate.apply(f.adapter, args); if (first) { first = false; throw new Error('provider timeout'); } };
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  assert.equal(f.counts.writes, 1);
  f.adapter.migrate = migrate;
  assert.equal((await runTypedForwardMigration({ ...f.args, resume: true })).status, 'completed');
  assert.equal(f.counts.writes, TYPED_FORWARD_MIGRATIONS.length);
  assert.equal(f.owner(), null);
});

test('post-migration data invariant drift is uncertain and leaves no later writes', async t => {
  const f = await fixture(t);
  const inspect = f.adapter.inspect;
  let drift = false;
  const migrate = f.adapter.migrate;
  f.adapter.migrate = async (...args) => { await migrate.apply(f.adapter, args); drift = true; };
  f.adapter.inspect = async target => ({ ...(await inspect(target)), ...(drift ? { dataInvariantSha256: '0'.repeat(64) } : {}) });
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  assert.equal(f.counts.writes, 1);
  assert.notEqual(f.owner(), null);
});

test('uncertain lock release resumes read-only without reacquiring or replaying writes', async t => {
  const f = await fixture(t);
  const release = f.lock.release;
  f.lock.release = async owner => { await release.call(f.lock, owner); throw new Error('lost release response'); };
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_LOCK_RELEASE_UNCERTAIN' });
  const writes = f.counts.writes;
  assert.equal(f.owner(), null);
  assert.equal((await runTypedForwardMigration({ ...f.args, resume: true })).status, 'completed');
  assert.equal(f.counts.writes, writes);
});

test('prepare is read-only and creates a closed plan only from the clean candidate source', async t => {
  const f = await fixture(t);
  const prepared = await prepareTypedForwardPlan({ workerRoot: WORKER_ROOT, repositoryRoot: f.repository.root,
    accountId: f.plan.accountId, workerName: f.plan.workerName, candidateSourceCommit: f.plan.candidateSourceCommit,
    inventory: f.plan.inventory, targets: f.plan.targets, rehearsal: f.rehearsal, wranglerSha256: f.plan.wranglerSha256,
    createdAt: f.plan.createdAt, expiresAt: f.plan.expiresAt });
  assert.equal(prepared.plan.rehearsalSha256, identityDigest(f.rehearsal));
  assert.equal(prepared.plan.steps[0].beforeSchemaSha256, f.targets[0].previous.schemaSha256);
});

test('provider transport rejects endpoint overrides and retains bounded redacted uncertainty diagnostics', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = createHash('sha256').update(await readFile(cliPath)).digest('hex');
  const plan = { ...f.plan, wranglerSha256: cliSha256 };
  const original = process.env.CLOUDFLARE_API_BASE_URL;
  process.env.CLOUDFLARE_API_BASE_URL = 'https://provider-override.invalid';
  try {
    await assert.rejects(createTypedForwardWranglerAdapter({ plan, operationDirectory: f.scratch, cliPath }), { code: 'D1_STORAGE_TRANSPORT_ENVIRONMENT_OVERRIDE' });
  } finally {
    if (original === undefined) delete process.env.CLOUDFLARE_API_BASE_URL;
    else process.env.CLOUDFLARE_API_BASE_URL = original;
  }
  const adapter = await createTypedForwardWranglerAdapter({ plan, operationDirectory: f.scratch, cliPath,
    spawn: () => ({ status: 1, stdout: '', stderr: 'authorization: Bearer topsecret' }) });
  await assert.rejects(adapter.inventory(f.targets[0]), { code: 'TYPED_FORWARD_PROVIDER_RESULT_UNCERTAIN' });
  const files = await readdir(join(f.scratch, 'typed-forward-wrangler'));
  const failure = files.find(name => name.startsWith('provider-failure-'));
  assert.ok(failure);
  assert.equal((await readFile(join(f.scratch, 'typed-forward-wrangler', failure), 'utf8')).includes('topsecret'), false);
});

test('CLI prepare/inspect/execute modes have closed argument admission', () => {
  assert.equal(parseTypedForwardArguments(['--mode', 'prepare', '--worker-root', 'worker', '--repository-root', 'repo', '--inventory', 'inventory.json',
    '--targets', 'targets.json', '--rehearsal', 'rehearsal.json', '--candidate-source', 'a'.repeat(40), '--account-id', 'b'.repeat(32),
    '--worker-name', 'worker-name', '--wrangler-sha256', 'c'.repeat(64), '--output', 'plan.json']).mode, 'prepare');
  assert.throws(() => parseTypedForwardArguments(['--mode', 'prepare', '--worker-root', 'worker']), { code: 'TYPED_FORWARD_ARGUMENTS_INVALID' });
  assert.throws(() => parseTypedForwardArguments(['--mode', 'execute', '--plan', 'plan.json']), { code: 'TYPED_FORWARD_ARGUMENTS_INVALID' });
});
