import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCleanSource,
  createTypedForwardWranglerAdapter,
  captureTypedForwardBackupReceipt,
  prepareTypedForwardPlan,
  parseTypedForwardArguments,
  plannedMigrationOperations,
  rehearseTypedForwardMigration,
  runTypedForwardMigration,
  TYPED_FORWARD_CONFIRMATION,
  TYPED_FORWARD_DATA_INVARIANT_SQL,
  TYPED_FORWARD_MAINTENANCE_HOLD_SCHEMA,
  TYPED_FORWARD_MIGRATIONS,
  TYPED_FORWARD_OPERATING_CAP_BYTES,
  TYPED_FORWARD_PREVIOUS_SOURCE,
  TYPED_FORWARD_ROLE_BINDINGS,
  previousReceiptDigest,
} from './typed-forward-migration.mjs';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { storageSha256 } from './d1-storage-plan.mjs';

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

function makeHold() {
  const hold = { schema: TYPED_FORWARD_MAINTENANCE_HOLD_SCHEMA, state: 'contained', revision: 7,
    capturedAt: '2026-09-22T12:00:00.000Z', expiresAt: '2026-09-23T12:00:00.000Z' };
  return { ...hold, holdSha256: identityDigest({ schema: hold.schema, state: hold.state, revision: hold.revision }) };
}

function makeBackup(targets) {
  const receipt = { schema: 'typed-forward-backup-receipt-v2', provider: 'cloudflare-d1-time-travel',
    capturedAt: '2026-09-22T12:00:00.000Z', expiresAt: '2026-09-23T12:00:00.000Z',
    targetsSha256: identityDigest(targets.map(target => ({ role: target.role, databaseId: target.databaseId }))),
    targetBookmarks: targets.map(target => ({ role: target.role, databaseId: target.databaseId, bookmark: `synthetic-${target.role}-bookmark` })) };
  return { ...receipt, receiptSha256: identityDigest(receipt) };
}

function roleSteps(plan, role) { return plan.steps.filter(step => step.role === role); }
function ledger(target, count) {
  return [...target.previous.ledger, ...TYPED_FORWARD_MIGRATIONS.filter(step => step.role === target.role).slice(0, count).map(step => ({ name: step.name, sha256: step.sha256 }))];
}
function observation(plan, target, position) {
  const steps = roleSteps(plan, target.role);
  const count = position.applied;
  let schemaSha256 = target.previous.schemaSha256;
  let dataInvariantSha256 = target.previous.dataInvariantSha256;
  if (count > 0) schemaSha256 = steps[count - 1].afterSchemaSha256;
  if (count < steps.length && position.statementIndex > 0) {
    const checkpoint = steps[count].statements[position.statementIndex - 1];
    schemaSha256 = checkpoint.afterSchemaSha256;
    dataInvariantSha256 = checkpoint.afterProgressSha256;
  }
  const migrations = ledger(target, count);
  return { schemaSha256, dataInvariantSha256, ledgerSha256: identityDigest(migrations), migrations, bytes: target.bytes };
}

async function fixture(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'typed-forward-check-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repository = await cleanRepository(t);
  const rehearsal = await rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT });
  const targets = ['primary', 'analytics'].map((role, index) => {
    const evidence = rehearsal.targets[role];
    const previous = { capturedAt: '2026-09-22T12:00:00.000Z', schemaSha256: evidence.schemaSha256,
      // This deliberately differs from the synthetic rehearsal content digest.
      dataInvariantSha256: '0'.repeat(64), ledger: [{ name: `000${index + 1}_prior_${role}.sql`, sha256: '1'.repeat(64) }] };
    previous.receiptSha256 = previousReceiptDigest(previous);
    return { role, binding: TYPED_FORWARD_ROLE_BINDINGS[role], name: `typed-forward-${role}`,
      databaseId: `${index + 1}1111111-1111-4111-8111-111111111111`, bytes: 1000,
      migrationGrowthBudgetBytes: 100000, previous };
  });
  const worker = { sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: '11111111-1111-4111-8111-111111111111', configSha256: 'a'.repeat(64), fingerprint: 'b'.repeat(64) };
  const inventory = { capturedAt: '2026-09-22T12:00:00.000Z', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE,
    versionId: worker.versionId, fingerprint: worker.fingerprint, worker, maintenanceHold: makeHold(), backupReceipt: makeBackup(targets),
    targetsSha256: identityDigest(targets.map(target => ({ role: target.role, binding: target.binding, name: target.name, databaseId: target.databaseId, bytes: target.bytes }))) };
  const inventorySha256 = storageSha256(`${JSON.stringify(inventory)}\n`);
  const prepared = await prepareTypedForwardPlan({ workerRoot: WORKER_ROOT, repositoryRoot: repository.root,
    accountId: 'b'.repeat(32), workerName: 'typed-forward-worker', candidateSourceCommit: repository.commit, inventory, targets,
    inventorySha256, rehearsal, wranglerSha256: 'c'.repeat(64), createdAt: '2026-09-22T12:00:00.000Z', expiresAt: '2026-09-22T13:00:00.000Z', now });
  let owner = null;
  const lock = { async createOwner() { return 'd'.repeat(40); }, async status() { return owner; },
    async acquire(next) { assert.equal(owner, null); owner = next; }, async assertOwned(expected) { assert.equal(owner, expected); },
    async release(expected) { assert.equal(owner, expected); owner = null; } };
  const counts = { writes: 0, safety: 0 };
  const capturedSql = [];
  const positions = new Map(targets.map(target => [target.role, { applied: 0, statementIndex: 0 }]));
  const controls = { held: true, worker: true, backup: true };
  const adapter = {
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: target.bytes }]; },
    async inspect(target) { const value = observation(prepared.plan, target, positions.get(target.role)); return controls.drift ? { ...value, schemaSha256: '0'.repeat(64) } : value; },
    async assertMaintenanceHold(hold) { counts.safety += 1; if (!controls.held || hold.revision !== 7) throw Object.assign(new Error('hold drift'), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_DRIFT' }); },
    async activeWorker() { if (!controls.worker) return { ...worker, fingerprint: 'f'.repeat(64) }; return worker; },
    async verifyBackupReceipt() { if (!controls.backup) throw Object.assign(new Error('backup drift'), { code: 'TYPED_FORWARD_BACKUP_RECEIPT_UNVERIFIED' }); },
    async foreignKeyCheck() { return []; },
    async migrateStatement(target, statement) {
      counts.writes += 1;
      capturedSql.push(statement.sql);
      const position = positions.get(target.role);
      assert.equal(statement.stepIndex, position.applied);
      assert.equal(statement.statementIndex, position.statementIndex);
      if (statement.kind === 'ledger') { position.applied += 1; position.statementIndex = 0; }
      else position.statementIndex += 1;
      if (controls.failAfterWrite && counts.writes === controls.failAfterWrite) throw Object.assign(new Error('provider timeout'), { diagnostics: { classification: 'uncertain', file: 'provider-failure-0.json', sha256: 'e'.repeat(64) } });
    },
  };
  return { scratch, repository, rehearsal, targets, plan: prepared.plan, planSha256: prepared.planSha256, lock, adapter, positions, controls, counts, capturedSql,
    owner: () => owner, worker, args: { plan: prepared.plan, workerRoot: WORKER_ROOT, repositoryRoot: repository.root,
      operationDirectory: join(scratch, 'operation'), execute: true, confirmation: TYPED_FORWARD_CONFIRMATION,
      approvedPlanSha256: prepared.planSha256, adapterFactory: () => adapter, lockFactory: () => lock, now } };
}

test('local rehearsal journals statements, preserves populated rows and leaves no partial mutation', async t => {
  const f = await fixture(t);
  assert.equal(f.rehearsal.status, 'passed');
  assert.ok(f.rehearsal.steps.every(step => step.statements.at(-1).kind === 'ledger'));
  assert.notEqual(f.rehearsal.targets.analytics.dataInvariantSha256, f.plan.targets[1].previous.dataInvariantSha256);
  await assert.rejects(rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT, injectFailureAt: 'primary:0006_usage_correction_facts.sql:after:1' }), { code: 'TYPED_FORWARD_INJECTED_REHEARSAL_FAILURE' });
  await assert.rejects(rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT, injectFailureAt: 'analytics:0025_effective_graph_source.sql:after:0' }), { code: 'TYPED_FORWARD_INJECTED_REHEARSAL_FAILURE' });
  await assert.rejects(rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT, injectFailureAt: 'analytics:0025_effective_graph_source.sql:after-commit:0' }), { code: 'TYPED_FORWARD_INJECTED_REHEARSAL_FAILURE' });
});

test('default mode is read-only and local plan binds exact SQL/checkpoints', async t => {
  const f = await fixture(t);
  const planned = await runTypedForwardMigration({ ...f.args, execute: false, adapterFactory: () => assert.fail('remote adapter constructed'), lockFactory: () => assert.fail('lock constructed') });
  assert.equal(planned.remoteWrites, false);
  assert.equal(f.plan.rehearsalSha256, identityDigest(f.rehearsal));
  assert.equal(f.plan.steps[0].statements.at(-1).kind, 'ledger');
  assertCleanSource(f.repository.root, f.plan.candidateSourceCommit);
});

test('happy path applies every statement in role and releases shared lock', async t => {
  const f = await fixture(t);
  const result = await runTypedForwardMigration(f.args);
  assert.equal(result.status, 'completed');
  assert.equal(f.counts.writes, f.plan.steps.reduce((sum, step) => sum + step.statements.length, 0));
  assert.equal(f.owner(), null);
});

test('former foreign-key-off migration regions are one deferred atomic D1 request', async t => {
  const f = await fixture(t);
  await runTypedForwardMigration(f.args);
  const rebuild = f.capturedSql.filter(sql => sql.includes('analytics_community_graph_results_0025'));
  assert.equal(rebuild.length, 1);
  assert.match(rebuild[0], /^PRAGMA defer_foreign_keys = ON;/u);
  assert.doesNotMatch(rebuild[0], /PRAGMA foreign_keys\s*=/iu);
  assert.match(rebuild[0], /DROP TABLE analytics_community_graph_results_0025;/u);
  assert.equal(f.capturedSql.some(sql => /^PRAGMA foreign_keys\s*=\s*(?:OFF|ON)\s*;?$/iu.test(sql.trim())), false);
});

test('deferred foreign-key violation rolls back only the atomic rebuild region', async t => {
  const f = await fixture(t);
  await assert.rejects(rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT,
    injectForeignKeyViolationAt: 'analytics:0025_effective_graph_source.sql:0' }), { code: 'TYPED_FORWARD_REHEARSAL_FOREIGN_KEY_FAILED' });
  const clean = await rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT });
  assert.equal(clean.status, 'passed');
  assert.ok(f.rehearsal.steps.find(step => step.name.startsWith('0025')).statements.some(statement => statement.atomic));
});

test('partial statement uncertainty retains intent and resumes only after exact read-first reconciliation', async t => {
  const f = await fixture(t); f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  assert.equal(f.counts.writes, 1); assert.notEqual(f.owner(), null);
  const journal = JSON.parse(await readFile(join(f.scratch, 'operation', 'operation.json'), 'utf8'));
  assert.equal(journal.state.targets.USAGE_MONITOR_DB.status, 'statement_intent');
  delete f.controls.failAfterWrite;
  await assert.rejects(runTypedForwardMigration({ ...f.args, resume: true, now: Date.parse('2026-09-22T14:00:00.000Z') }), { code: 'TYPED_FORWARD_APPROVAL_EXPIRED' });
});

test('uncertain migration resumes when still within plan window without replaying applied statement', async t => {
  const f = await fixture(t); f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  const result = await runTypedForwardMigration({ ...f.args, resume: true, now });
  assert.equal(result.status, 'completed'); assert.equal(f.owner(), null);
  assert.equal(f.counts.writes, f.plan.steps.reduce((sum, step) => sum + step.statements.length, 0));
});

test('schema drift and ledger prefix without a receipt are read-only refusals', async t => {
  const f = await fixture(t); f.controls.drift = true;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  assert.equal(f.counts.writes, 0); assert.notEqual(f.owner(), null);
  const g = await fixture(t); const original = g.adapter.inspect;
  g.adapter.inspect = async target => { const value = await original(target); return { ...value, migrations: [], ledgerSha256: identityDigest([]) }; };
  await assert.rejects(runTypedForwardMigration(g.args), { code: 'TYPED_FORWARD_LEDGER_PREFIX_DRIFT' });
  assert.equal(g.counts.writes, 0);
});

test('expired resume is read-only until a chained <=24h extension is approved', async t => {
  const f = await fixture(t); f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  const extension = { schema: 'd1-storage-approval-extension-v1', planSha256: f.planSha256, previousExtensionSha256: null,
    approvedAt: '2026-09-22T14:01:00.000Z', expiresAt: '2026-09-23T14:01:00.000Z' };
  const result = await runTypedForwardMigration({ ...f.args, resume: true, now: Date.parse('2026-09-22T14:02:00.000Z'), extension,
    approvedExtensionSha256: identityDigest(extension) });
  assert.equal(result.status, 'completed');
});

test('expired resume can reconcile an intent after backup expiry but cannot write', async t => {
  const f = await fixture(t);
  const { receiptSha256: _oldReceiptSha256, ...backupWithoutDigest } = f.plan.inventory.backupReceipt;
  const backup = { ...backupWithoutDigest, expiresAt: '2026-09-22T12:30:00.000Z' };
  backup.receiptSha256 = identityDigest({ ...backup });
  f.plan.inventory.backupReceipt = backup;
  f.args.plan = f.plan;
  f.args.approvedPlanSha256 = identityDigest(f.plan);
  f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  await assert.rejects(runTypedForwardMigration({ ...f.args, resume: true, now: Date.parse('2026-09-22T14:00:00.000Z') }), { code: 'TYPED_FORWARD_BACKUP_RECEIPT_EXPIRED' });
  assert.equal(f.counts.writes, 1);
  assert.notEqual(f.owner(), null);
});

test('expired resume can reconcile an intent after hold expiry but cannot write', async t => {
  const f = await fixture(t);
  f.plan.inventory.maintenanceHold.expiresAt = '2026-09-22T12:30:00.000Z';
  f.args.plan = f.plan;
  f.args.approvedPlanSha256 = identityDigest(f.plan);
  f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  await assert.rejects(runTypedForwardMigration({ ...f.args, resume: true, now: Date.parse('2026-09-22T14:00:00.000Z') }), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_EXPIRED' });
  assert.equal(f.counts.writes, 1);
  assert.notEqual(f.owner(), null);
});

test('maintenance hold, active worker and backup drift stop before the next statement', async t => {
  const f = await fixture(t); f.controls.held = false;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_DRIFT' });
  assert.equal(f.counts.writes, 0);
  const g = await fixture(t); g.controls.worker = false;
  await assert.rejects(runTypedForwardMigration(g.args), { code: 'TYPED_FORWARD_ACTIVE_WORKER_DRIFT' });
  assert.equal(g.counts.writes, 0);
});

test('a concurrent collection write after one statement stops the next write under the held lock', async t => {
  const f = await fixture(t);
  const original = f.adapter.assertMaintenanceHold;
  f.adapter.assertMaintenanceHold = async hold => {
    await original(hold);
    if (f.counts.writes > 0) throw Object.assign(new Error('collection resumed'), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_DRIFT' });
  };
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_DRIFT' });
  assert.equal(f.counts.writes, 1);
  assert.notEqual(f.owner(), null);
});

test('fresh mutation-boundary clock stops writes after plan expiry', async t => {
  const f = await fixture(t);
  let current = now;
  const original = f.adapter.migrateStatement;
  f.adapter.migrateStatement = async (...args) => {
    await original(...args);
    current = Date.parse(f.plan.expiresAt) + 1;
  };
  await assert.rejects(runTypedForwardMigration({ ...f.args, clock: () => current }), { code: 'TYPED_FORWARD_APPROVAL_EXPIRED' });
  assert.equal(f.counts.writes, 1);
  assert.notEqual(f.owner(), null);
});

test('analytics invariant returns bounded summaries for a 1 MiB JSON payload', async t => {
  const f = await fixture(t);
  assert.match(f.rehearsal.steps.find(step => step.name.startsWith('0025')).dataInvariantSha256, /^[a-f0-9]{64}$/);
  const large = await rehearseTypedForwardMigration({ workerRoot: WORKER_ROOT, largePayload: true });
  assert.equal(large.status, 'passed');
  assert.doesNotMatch(TYPED_FORWARD_DATA_INVARIANT_SQL.analytics, /MIN\((?:values_json|payload_json|authority_json)\)/u);
  assert.equal(JSON.stringify(large).includes('x'.repeat(1000)), false);
});

test('provider transport rejects endpoint overrides and retains bounded redacted uncertainty diagnostics', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await readFile(cliPath)).toString('hex').length ? (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex') : '';
  const original = process.env.CLOUDFLARE_API_BASE_URL; process.env.CLOUDFLARE_API_BASE_URL = 'https://provider-override.invalid';
  try { await assert.rejects(createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath }), { code: 'D1_STORAGE_TRANSPORT_ENVIRONMENT_OVERRIDE' }); }
  finally { if (original === undefined) delete process.env.CLOUDFLARE_API_BASE_URL; else process.env.CLOUDFLARE_API_BASE_URL = original; }
});

test('concrete backup verification performs a bounded read-only Time Travel check per exact target', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  const calls = [];
  let supplementalChecks = 0;
  const adapter = await createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath,
    backupVerifier: async () => { supplementalChecks += 1; },
    spawn(_command, args) {
      calls.push(args);
      const role = args.includes('USAGE_MONITOR_DB') ? 'primary' : 'analytics';
      return { status: 0, stdout: JSON.stringify({ bookmark: `synthetic-${role}-bookmark` }), stderr: '' };
    } });
  await adapter.verifyBackupReceipt(f.plan.inventory.backupReceipt, f.targets);
  assert.equal(calls.length, f.targets.length);
  assert.equal(supplementalChecks, 1);
  assert.ok(calls.every(args => args.includes('time-travel') && args.includes('info') && args.some(arg => arg.startsWith('--timestamp='))));
});

test('backup capture resolves one ordered timestamp and writes a private v2 receipt', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  const targets = f.targets.map(({ role, binding, name, databaseId }) => ({ role, binding, name, databaseId }));
  const calls = [];
  const outputPath = join(f.scratch, 'typed-forward-backup.json');
  const captured = await captureTypedForwardBackupReceipt({ accountId: f.plan.accountId, targets, operationDirectory: f.scratch,
    cliPath, wranglerSha256: cliSha256, capturedAt: '2026-09-22T12:00:00.000Z', expiresAt: '2026-09-23T12:00:00.000Z', now,
    outputPath, spawn(_command, args) {
      calls.push(args);
      const role = args.includes('USAGE_MONITOR_DB') ? 'primary' : 'analytics';
      return { status: 0, stdout: JSON.stringify({ bookmark: `capture-${role}-bookmark` }), stderr: '' };
    } });
  assert.equal(captured.remoteWrites, false);
  assert.equal(calls.length, targets.length);
  assert.ok(calls.every(args => args.includes('time-travel') && args.includes('info') && !args.includes('restore') && !args.includes('execute')));
  assert.deepEqual(captured.receipt.targetBookmarks.map(item => item.role), ['primary', 'analytics']);
  assert.equal(captured.receipt.schema, 'typed-forward-backup-receipt-v2');
  const written = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(written, captured.receipt);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});

test('backup capture refuses reordered targets and ambiguous Time Travel output', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  const targets = f.targets.map(({ role, binding, name, databaseId }) => ({ role, binding, name, databaseId }));
  await assert.rejects(captureTypedForwardBackupReceipt({ accountId: f.plan.accountId, targets: [...targets].reverse(), operationDirectory: f.scratch,
    cliPath, wranglerSha256: cliSha256, capturedAt: '2026-09-22T12:00:00.000Z', now, spawn: () => assert.fail('reordered targets invoked provider') }), { code: 'TYPED_FORWARD_BACKUP_CAPTURE_TARGETS_INVALID' });
  await assert.rejects(captureTypedForwardBackupReceipt({ accountId: f.plan.accountId, targets, operationDirectory: f.scratch,
    cliPath, wranglerSha256: cliSha256, capturedAt: '2026-09-22T12:00:00.000Z', now,
    spawn: () => ({ status: 0, stdout: JSON.stringify([{ bookmark: 'ambiguous' }]), stderr: '' }) }), { code: 'TYPED_FORWARD_BACKUP_RECEIPT_UNVERIFIED' });
});

test('injected backup verification cannot replace exact concrete bookmark comparison', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  let supplementalChecks = 0;
  const adapter = await createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath,
    backupVerifier: async () => { supplementalChecks += 1; },
    spawn() { return { status: 0, stdout: JSON.stringify({ bookmark: 'wrong-bookmark' }), stderr: '' }; } });
  await assert.rejects(adapter.verifyBackupReceipt(f.plan.inventory.backupReceipt, f.targets), { code: 'TYPED_FORWARD_BACKUP_RECEIPT_UNVERIFIED' });
  assert.equal(supplementalChecks, 0);
});

test('concrete mutation transport sends one deferred batch and decodes its exact result count', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  const step = f.plan.steps.find(candidate => candidate.name === '0025_effective_graph_source.sql');
  const statement = step.statements.find(candidate => candidate.atomic);
  const operations = await plannedMigrationOperations(WORKER_ROOT, step);
  const calls = [];
  const adapter = await createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath,
    spawn(_command, args) {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(Array.from({ length: statement.resultCount }, () => ({ success: true, results: [] }))), stderr: '' };
    } });
  await adapter.migrateStatement(f.targets[1], { ...statement, sql: operations[statement.index].sql });
  assert.equal(calls.length, 1);
  const sqlPath = calls[0].find(arg => arg.startsWith('--tibo-query-path=')).slice('--tibo-query-path='.length);
  const sent = await readFile(sqlPath, 'utf8');
  assert.match(sent, /^PRAGMA defer_foreign_keys = ON;/u);
  assert.doesNotMatch(sent, /PRAGMA foreign_keys\s*=/iu);

  const bad = await createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath,
    spawn() { return { status: 0, stdout: JSON.stringify([{ success: true, results: [] }]), stderr: '' }; } });
  await assert.rejects(bad.migrateStatement(f.targets[1], { ...statement, sql: operations[statement.index].sql }), { code: 'TYPED_FORWARD_MIGRATION_RESULT_INVALID' });
});

test('concrete active Worker verification uses the canonical live config fingerprint helper', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE,
    versionId: f.plan.inventory.versionId, fingerprint: f.plan.inventory.fingerprint };
  const adapter = await createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath,
    liveProviderFactory: () => ({ async capture() { return {}; } }), liveConfigSnapshot: () => snapshot,
    spawn() { return { status: 0, stdout: '[]', stderr: '' }; } });
  const observed = await adapter.activeWorker();
  assert.deepEqual(observed, { sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    configSha256: f.plan.inventory.fingerprint, fingerprint: f.plan.inventory.fingerprint });
});

test('CLI argument admission includes extension input and refuses incomplete execution', () => {
  assert.equal(parseTypedForwardArguments(['--mode', 'execute', '--plan', 'plan.json', '--worker-root', 'worker', '--operation', 'operation', '--repository-root', 'repo', '--cli', 'cli', '--confirmation', TYPED_FORWARD_CONFIRMATION, '--approved-plan-sha256', 'a'.repeat(64), '--extension', 'extension.json', '--approved-extension-sha256', 'b'.repeat(64)]).mode, 'execute');
  assert.equal(parseTypedForwardArguments(['--mode', 'capture-backup', '--targets', 'targets.json', '--operation', 'operation', '--cli', 'cli', '--account-id', 'a'.repeat(32), '--wrangler-sha256', 'b'.repeat(64), '--output', 'backup.json']).mode, 'capture-backup');
  assert.throws(() => parseTypedForwardArguments(['--mode', 'execute', '--plan', 'plan.json']), { code: 'TYPED_FORWARD_ARGUMENTS_INVALID' });
});
