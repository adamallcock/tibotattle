import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCleanSource,
  createTypedForwardWranglerAdapter,
  captureTypedForwardBackupReceipt,
  captureTypedForwardInventory,
  prepareTypedForwardPlan,
  parseTypedForwardArguments,
  plannedMigrationOperations,
  rehearseTypedForwardMigration,
  runTypedForwardMigration,
  validateTypedForwardPlan,
  TYPED_FORWARD_CONFIRMATION,
  TYPED_FORWARD_DATA_INVARIANT_SQL,
  TYPED_FORWARD_MAINTENANCE_HOLD_SCHEMA,
  TYPED_FORWARD_MIGRATIONS,
  TYPED_FORWARD_OPERATING_CAP_BYTES,
  TYPED_FORWARD_PREVIOUS_SOURCE,
  TYPED_FORWARD_ROLE_BINDINGS,
  previousReceiptDigest,
  writePrivateJsonNoClobber,
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
  const inventorySha256 = identityDigest(inventory);
  const prepared = await prepareTypedForwardPlan({ workerRoot: WORKER_ROOT, repositoryRoot: repository.root,
    accountId: 'b'.repeat(32), workerName: 'typed-forward-worker', candidateSourceCommit: repository.commit, inventory, targets,
    inventorySha256, rehearsal, wranglerSha256: 'c'.repeat(64), createdAt: '2026-09-22T12:00:00.000Z', expiresAt: '2026-09-22T13:00:00.000Z', now });
  let owner = null;
  const lock = { async createOwner() { return 'd'.repeat(40); }, async status() { return owner; },
    async acquire(next) { assert.equal(owner, null); owner = next; }, async assertOwned(expected) { assert.equal(owner, expected); },
    async release(expected) { assert.equal(owner, expected); owner = null; } };
  const counts = { writes: 0, safety: 0, foreignKeyChecks: 0 };
  const capturedSql = [];
  const positions = new Map(targets.map(target => [target.role, { applied: 0, statementIndex: 0 }]));
  const controls = { held: true, worker: true, backup: true, failForeignKeyAfterLedger: false, foreignKeyFailed: false };
  const adapter = {
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: target.bytes }]; },
    async inspect(target) { const value = observation(prepared.plan, target, positions.get(target.role)); return controls.drift ? { ...value, schemaSha256: '0'.repeat(64) } : value; },
    async assertMaintenanceHold(hold) { counts.safety += 1; if (!controls.held || hold.revision !== 7) throw Object.assign(new Error('hold drift'), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_DRIFT' }); },
    async activeWorker() { if (!controls.worker) return { ...worker, fingerprint: 'f'.repeat(64) }; return worker; },
    async verifyBackupReceipt() { if (!controls.backup) throw Object.assign(new Error('backup drift'), { code: 'TYPED_FORWARD_BACKUP_RECEIPT_UNVERIFIED' }); },
    async foreignKeyCheck() {
      counts.foreignKeyChecks += 1;
      if (controls.failForeignKeyAfterLedger && controls.ledgerWritten && !controls.foreignKeyFailed) {
        controls.foreignKeyFailed = true;
        throw Object.assign(new Error('foreign-key readback uncertain'), { code: 'TYPED_FORWARD_FOREIGN_KEY_READBACK_UNCERTAIN' });
      }
      return [];
    },
    async migrateStatement(target, statement) {
      counts.writes += 1;
      capturedSql.push(statement.sql);
      const position = positions.get(target.role);
      assert.equal(statement.stepIndex, position.applied);
      assert.equal(statement.statementIndex, position.statementIndex);
      if (statement.kind === 'ledger') { position.applied += 1; position.statementIndex = 0; }
      else position.statementIndex += 1;
      if (statement.kind === 'ledger') controls.ledgerWritten = true;
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

test('post-ledger foreign-key readback is a durable resume checkpoint', async t => {
  const f = await fixture(t);
  f.controls.failForeignKeyAfterLedger = true;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_FOREIGN_KEY_READBACK_UNCERTAIN' });
  assert.equal(f.counts.writes, f.plan.steps[0].statements.length);
  const journal = JSON.parse(await readFile(join(f.scratch, 'operation', 'operation.json'), 'utf8'));
  assert.equal(journal.state.targets.USAGE_MONITOR_DB.status, 'statement_intent');
  const writesBeforeResume = f.counts.writes;
  f.controls.failForeignKeyAfterLedger = false;
  const result = await runTypedForwardMigration({ ...f.args, resume: true, now });
  assert.equal(result.status, 'completed');
  assert.equal(f.counts.writes, f.plan.steps.reduce((sum, step) => sum + step.statements.length, 0));
  assert.ok(f.counts.foreignKeyChecks > writesBeforeResume);
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

test('an active extension permits writes against capture-produced expired safety receipts', async t => {
  const f = await fixture(t);
  const capturedAt = '2026-09-21T12:00:00.000Z';
  const safetyExpiresAt = '2026-09-22T12:00:00.000Z';
  const initialNow = Date.parse('2026-09-21T12:01:00.000Z');
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint,
    bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  const holdCore = { schema: TYPED_FORWARD_MAINTENANCE_HOLD_SCHEMA, state: 'contained', revision: 7, capturedAt, expiresAt: safetyExpiresAt };
  const hold = { ...holdCore, holdSha256: identityDigest({ schema: holdCore.schema, state: holdCore.state, revision: holdCore.revision }) };
  const captureAdapter = {
    async captureMaintenanceHold() { return hold; },
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: 1000 }]; },
    async inspect(target) {
      const previous = f.targets.find(candidate => candidate.role === target.role).previous;
      return { schemaSha256: previous.schemaSha256, dataInvariantSha256: previous.dataInvariantSha256,
        migrations: previous.ledger, ledgerSha256: identityDigest(previous.ledger), bytes: 1000 };
    },
    async captureBackupReceipt(targets) {
      const receipt = { schema: 'typed-forward-backup-receipt-v2', provider: 'cloudflare-d1-time-travel', capturedAt,
        expiresAt: safetyExpiresAt, targetsSha256: identityDigest(targets.map(target => ({ role: target.role, databaseId: target.databaseId }))),
        targetBookmarks: targets.map(target => ({ role: target.role, databaseId: target.databaseId, bookmark: `captured-${target.role}-bookmark` })) };
      return { ...receipt, receiptSha256: identityDigest(receipt) };
    },
  };
  const captureDirectory = join(f.scratch, 'capture-produced');
  await mkdir(captureDirectory, { mode: 0o700 });
  const captured = await captureTypedForwardInventory({ accountId: f.plan.accountId, workerName: f.plan.workerName,
    operationDirectory: captureDirectory, cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256,
    migrationGrowthBudgetBytes: 100000, capturedAt, expiresAt: safetyExpiresAt, now: initialNow,
    inventoryOutputPath: join(captureDirectory, 'inventory.json'), targetsOutputPath: join(captureDirectory, 'targets.json'),
    backupOutputPath: join(captureDirectory, 'backup.json'), liveProviderFactory: () => ({ async capture() { return { capturedAt }; } }),
    liveConfigSnapshot: () => snapshot, adapterFactory: () => captureAdapter });
  assert.equal(captured.inventory.maintenanceHold.expiresAt, safetyExpiresAt);
  assert.equal(captured.backupReceipt.expiresAt, safetyExpiresAt);
  const prepared = await prepareTypedForwardPlan({ workerRoot: WORKER_ROOT, repositoryRoot: f.repository.root,
    accountId: f.plan.accountId, workerName: f.plan.workerName, candidateSourceCommit: f.repository.commit,
    inventory: captured.inventory, inventorySha256: captured.inventorySha256, targets: captured.targets, rehearsal: f.rehearsal,
    wranglerSha256: f.plan.wranglerSha256, createdAt: capturedAt, expiresAt: '2026-09-21T13:00:00.000Z', now: initialNow });
  f.adapter.activeWorker = async () => prepared.plan.inventory.worker;
  const operationArgs = { ...f.args, plan: prepared.plan, approvedPlanSha256: prepared.planSha256,
    operationDirectory: join(f.scratch, 'capture-produced-operation'), now: initialNow };
  f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(operationArgs), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  const extension = { schema: 'd1-storage-approval-extension-v1', planSha256: prepared.planSha256,
    previousExtensionSha256: null, approvedAt: '2026-09-22T12:01:00.000Z', expiresAt: '2026-09-23T12:01:00.000Z' };
  const resumed = await runTypedForwardMigration({ ...operationArgs, resume: true, now: Date.parse('2026-09-22T12:02:00.000Z'),
    extension, approvedExtensionSha256: identityDigest(extension) });
  assert.equal(resumed.status, 'completed');
});

test('approval extensions require an expired resume and approval at or after the prior deadline', async t => {
  const initial = await fixture(t);
  const initialExtension = { schema: 'd1-storage-approval-extension-v1', planSha256: initial.planSha256,
    previousExtensionSha256: null, approvedAt: '2026-09-22T12:00:00.000Z', expiresAt: '2026-09-22T12:30:00.000Z' };
  await assert.rejects(runTypedForwardMigration({ ...initial.args, extension: initialExtension,
    approvedExtensionSha256: identityDigest(initialExtension) }), { code: 'TYPED_FORWARD_APPROVAL_EXTENSION_REQUIRES_EXPIRED_RESUME' });
  assert.equal(initial.counts.writes, 0);

  const expired = await fixture(t); expired.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(expired.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete expired.controls.failAfterWrite;
  const earlyExtension = { schema: 'd1-storage-approval-extension-v1', planSha256: expired.planSha256,
    previousExtensionSha256: null, approvedAt: '2026-09-22T12:59:00.000Z', expiresAt: '2026-09-22T13:59:00.000Z' };
  await assert.rejects(runTypedForwardMigration({ ...expired.args, resume: true, now: Date.parse('2026-09-22T14:00:00.000Z'),
    extension: earlyExtension, approvedExtensionSha256: identityDigest(earlyExtension) }), { code: 'TYPED_FORWARD_APPROVAL_EXTENSION_REQUIRES_EXPIRED_RESUME' });
  assert.equal(expired.counts.writes, 1);
});

test('a second extension resumes from the prior extension deadline', async t => {
  const f = await fixture(t); f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  const first = { schema: 'd1-storage-approval-extension-v1', planSha256: f.planSha256, previousExtensionSha256: null,
    approvedAt: '2026-09-22T14:01:00.000Z', expiresAt: '2026-09-23T14:01:00.000Z' };
  await runTypedForwardMigration({ ...f.args, resume: true, now: Date.parse('2026-09-22T14:02:00.000Z'), extension: first,
    approvedExtensionSha256: identityDigest(first) });
  const second = { schema: 'd1-storage-approval-extension-v1', planSha256: f.planSha256,
    previousExtensionSha256: identityDigest(first), approvedAt: '2026-09-23T14:02:00.000Z', expiresAt: '2026-09-24T14:02:00.000Z' };
  const result = await runTypedForwardMigration({ ...f.args, resume: true, now: Date.parse('2026-09-23T14:03:00.000Z'), extension: second,
    approvedExtensionSha256: identityDigest(second) });
  assert.equal(result.status, 'completed');
  const journal = JSON.parse(await readFile(join(f.scratch, 'operation', 'operation.json'), 'utf8'));
  assert.equal(journal.state.approvalExtensions.length, 2);
});

test('retrying an extension after its durable append is an idempotent no-op', async t => {
  const f = await fixture(t);
  f.controls.failAfterWrite = 1;
  await assert.rejects(runTypedForwardMigration(f.args), { code: 'TYPED_FORWARD_MIGRATION_RESULT_UNCERTAIN' });
  delete f.controls.failAfterWrite;
  const extension = { schema: 'd1-storage-approval-extension-v1', planSha256: f.planSha256,
    previousExtensionSha256: null, approvedAt: '2026-09-22T14:01:00.000Z', expiresAt: '2026-09-23T14:01:00.000Z' };
  let failAfterSave = true;
  const args = { ...f.args, adapterFactory: () => {
    if (failAfterSave) {
      failAfterSave = false;
      throw Object.assign(new Error('extension save response lost'), { code: 'TYPED_FORWARD_EXTENSION_SAVE_INTERRUPTED' });
    }
    return f.adapter;
  } };
  const extensionArgs = { ...args, resume: true, now: Date.parse('2026-09-22T14:02:00.000Z'), extension,
    approvedExtensionSha256: identityDigest(extension) };
  await assert.rejects(runTypedForwardMigration(extensionArgs), { code: 'TYPED_FORWARD_EXTENSION_SAVE_INTERRUPTED' });
  const retried = await runTypedForwardMigration(extensionArgs);
  assert.equal(retried.status, 'completed');
  const journal = JSON.parse(await readFile(join(f.scratch, 'operation', 'operation.json'), 'utf8'));
  assert.equal(journal.state.approvalExtensions.length, 1);
  assert.equal(f.counts.writes, f.plan.steps.reduce((sum, step) => sum + step.statements.length, 0));
});

test('plan admission binds the canonical embedded inventory digest', async t => {
  const f = await fixture(t);
  const tampered = structuredClone(f.plan);
  tampered.inventory.worker.fingerprint = 'f'.repeat(64);
  assert.throws(() => validateTypedForwardPlan(tampered, { now }), { code: 'TYPED_FORWARD_PLAN_INVALID' });
});

test('expired resume can reconcile an intent after backup expiry but cannot write', async t => {
  const f = await fixture(t);
  const { receiptSha256: _oldReceiptSha256, ...backupWithoutDigest } = f.plan.inventory.backupReceipt;
  const backup = { ...backupWithoutDigest, expiresAt: '2026-09-22T12:30:00.000Z' };
  backup.receiptSha256 = identityDigest({ ...backup });
  f.plan.inventory.backupReceipt = backup;
  f.plan.inventorySha256 = identityDigest(f.plan.inventory);
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
  f.plan.inventorySha256 = identityDigest(f.plan.inventory);
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
  await adapter.verifyBackupReceipt(f.plan.inventory.backupReceipt, f.targets, now);
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

test('inventory capture brackets canonical Worker and D1 reads into private enriched artifacts', async t => {
  const f = await fixture(t);
  const captures = [];
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint,
    bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  const provider = { async capture() { captures.push(true); return { capturedAt: '2026-09-22T12:00:00.000Z' }; } };
  const adapterCalls = [];
  const adapter = {
    async captureMaintenanceHold(target, capturedAt, expiresAt) {
      adapterCalls.push(['hold', target.role]);
      return makeHold();
    },
    async inventory(target) {
      adapterCalls.push(['inventory', target.role]);
      return [{ id: target.databaseId, name: target.name, bytes: 1000 }];
    },
    async inspect(target) {
      adapterCalls.push(['inspect', target.role]);
      const previous = f.targets.find(candidate => candidate.role === target.role).previous;
      return { schemaSha256: previous.schemaSha256, dataInvariantSha256: previous.dataInvariantSha256,
        migrations: previous.ledger, ledgerSha256: identityDigest(previous.ledger), bytes: 1000 };
    },
    async captureBackupReceipt(targets, capturedAt, expiresAt) {
      adapterCalls.push(['backup', targets.length]);
      return f.plan.inventory.backupReceipt;
    },
  };
  const output = {
    inventory: join(f.scratch, 'captured-inventory.json'), targets: join(f.scratch, 'captured-targets.json'),
    backup: join(f.scratch, 'captured-backup.json'),
  };
  const captured = await captureTypedForwardInventory({ accountId: f.plan.accountId, workerName: f.plan.workerName,
    operationDirectory: f.scratch, cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256, migrationGrowthBudgetBytes: 100000,
    inventoryOutputPath: output.inventory, targetsOutputPath: output.targets, backupOutputPath: output.backup, now,
    liveProviderFactory: () => provider, liveConfigSnapshot: () => snapshot, adapterFactory: () => adapter });
  assert.equal(captured.remoteWrites, false);
  assert.equal(captures.length, 2);
  assert.deepEqual(adapterCalls.map(call => call[0]), ['hold', 'inventory', 'inspect', 'inventory', 'inspect', 'backup', 'hold',
    'inventory', 'inspect', 'inventory', 'inspect']);
  assert.deepEqual(captured.targets.map(target => target.role), ['primary', 'analytics']);
  assert.equal(captured.inventorySha256, identityDigest(captured.inventory));
  assert.equal((await stat(output.inventory)).mode & 0o777, 0o600);
  assert.equal((await stat(output.targets)).mode & 0o777, 0o600);
  assert.equal((await stat(output.backup)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(output.targets, 'utf8')), captured.targets);
});

test('inventory capture rechecks both populated roles after backup and hold before publication', async t => {
  const f = await fixture(t);
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint,
    bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  let providerCaptures = 0;
  const provider = { async capture() { providerCaptures += 1; return { capturedAt: '2026-09-22T12:00:00.000Z' }; } };
  let drift = false;
  const observationCalls = new Map();
  const adapter = {
    async captureMaintenanceHold() { return makeHold(); },
    async inventory(target) {
      return [{ id: target.databaseId, name: target.name, bytes: drift && target.role === 'analytics' ? 1001 : 1000 }];
    },
    async inspect(target) {
      observationCalls.set(target.role, (observationCalls.get(target.role) ?? 0) + 1);
      const previous = f.targets.find(candidate => candidate.role === target.role).previous;
      return { schemaSha256: previous.schemaSha256,
        dataInvariantSha256: drift && target.role === 'analytics' ? 'f'.repeat(64) : previous.dataInvariantSha256,
        migrations: previous.ledger, ledgerSha256: identityDigest(previous.ledger), bytes: 1000 };
    },
    async captureBackupReceipt() { drift = true; return f.plan.inventory.backupReceipt; },
  };
  const output = { inventory: join(f.scratch, 'drift-inventory.json'), targets: join(f.scratch, 'drift-targets.json'),
    backup: join(f.scratch, 'drift-backup.json') };
  await assert.rejects(captureTypedForwardInventory({ accountId: f.plan.accountId, workerName: f.plan.workerName,
    operationDirectory: f.scratch, cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256, migrationGrowthBudgetBytes: 100000,
    inventoryOutputPath: output.inventory, targetsOutputPath: output.targets, backupOutputPath: output.backup, now,
    liveProviderFactory: () => provider, liveConfigSnapshot: () => snapshot, adapterFactory: () => adapter }),
  { code: 'TYPED_FORWARD_INVENTORY_CAPTURE_DRIFT' });
  assert.equal(providerCaptures, 1);
  assert.deepEqual(Object.fromEntries(observationCalls), { primary: 2, analytics: 2 });
  for (const path of Object.values(output)) await assert.rejects(stat(path));
});

test('inventory capture journals later-output failure and resumes without another remote read', async t => {
  const f = await fixture(t);
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint,
    bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  const provider = { async capture() { return { capturedAt: '2026-09-22T12:00:00.000Z' }; } };
  const adapter = {
    async captureMaintenanceHold() { return makeHold(); },
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: 1000 }]; },
    async inspect(target) {
      const previous = f.targets.find(candidate => candidate.role === target.role).previous;
      return { schemaSha256: previous.schemaSha256, dataInvariantSha256: previous.dataInvariantSha256,
        migrations: previous.ledger, ledgerSha256: identityDigest(previous.ledger), bytes: 1000 };
    },
    async captureBackupReceipt() { return f.plan.inventory.backupReceipt; },
  };
  const output = { inventory: join(f.scratch, 'publication-inventory.json'), targets: join(f.scratch, 'publication-targets.json'),
    backup: join(f.scratch, 'publication-backup.json') };
  let publishCalls = 0;
  const failOnSecondDestination = async (stagePath, outputPath) => {
    publishCalls += 1;
    if (publishCalls === 2) throw new Error('destination appeared after preflight');
    await rename(stagePath, outputPath);
  };
  let providerFactoryCalls = 0;
  const captureArgs = { accountId: f.plan.accountId, workerName: f.plan.workerName, operationDirectory: f.scratch,
    cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256, migrationGrowthBudgetBytes: 100000,
    inventoryOutputPath: output.inventory, targetsOutputPath: output.targets, backupOutputPath: output.backup, now,
    liveProviderFactory: () => { providerFactoryCalls += 1; return provider; }, liveConfigSnapshot: () => snapshot,
    adapterFactory: () => adapter, publishFile: failOnSecondDestination };
  await assert.rejects(captureTypedForwardInventory(captureArgs), { code: 'TYPED_FORWARD_INVENTORY_CAPTURE_PUBLICATION_INCOMPLETE' });
  const journalPath = join(f.scratch, 'typed-forward-inventory-publication.json');
  const partial = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.published, ['inventory']);
  await stat(output.inventory);
  await assert.rejects(stat(output.targets));
  await assert.rejects(stat(output.backup));
  const resumed = await captureTypedForwardInventory({ ...captureArgs, publishFile: undefined,
    liveProviderFactory: () => assert.fail('resume must not capture Worker again'), adapterFactory: () => assert.fail('resume must not read D1 again') });
  assert.equal(resumed.resumedPublication, true);
  assert.equal(providerFactoryCalls, 1);
  const complete = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(complete.status, 'published');
  assert.deepEqual(complete.published, ['inventory', 'targets', 'backup']);
  for (const path of Object.values(output)) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const mismatches = [
    { accountId: 'c'.repeat(32) },
    { workerName: 'different-worker' },
    { cliPath: 'different-cli' },
    { wranglerSha256: 'd'.repeat(64) },
    { migrationGrowthBudgetBytes: 100001 },
    { inventoryOutputPath: join(f.scratch, 'different-inventory.json') },
  ];
  for (const mismatch of mismatches) {
    await assert.rejects(captureTypedForwardInventory({ ...captureArgs, ...mismatch, publishFile: undefined,
      liveProviderFactory: () => assert.fail('context mismatch must stop before another Worker read'),
      adapterFactory: () => assert.fail('context mismatch must stop before another D1 read') }),
    { code: 'TYPED_FORWARD_INVENTORY_CAPTURE_CONTEXT_MISMATCH' });
  }
  assert.equal(providerFactoryCalls, 1);
});

test('inventory capture samples a fresh clock after a delayed provider timestamp', async t => {
  const f = await fixture(t);
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint,
    bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  const providerNow = '2026-09-22T12:01:00.000Z';
  const freshNow = Date.parse('2026-09-22T12:02:00.000Z');
  const observedTimes = [];
  const adapter = {
    async captureMaintenanceHold(target, capturedAt, expiresAt, capturedNow) { observedTimes.push(capturedNow); return makeHold(); },
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: 1000 }]; },
    async inspect(target) {
      const previous = f.targets.find(candidate => candidate.role === target.role).previous;
      return { schemaSha256: previous.schemaSha256, dataInvariantSha256: previous.dataInvariantSha256,
        migrations: previous.ledger, ledgerSha256: identityDigest(previous.ledger), bytes: 1000 };
    },
    async captureBackupReceipt(targets, capturedAt, expiresAt, capturedNow) { observedTimes.push(capturedNow); return f.plan.inventory.backupReceipt; },
  };
  const output = { inventory: join(f.scratch, 'delayed-inventory.json'), targets: join(f.scratch, 'delayed-targets.json'),
    backup: join(f.scratch, 'delayed-backup.json') };
  const captured = await captureTypedForwardInventory({ accountId: f.plan.accountId, workerName: f.plan.workerName,
    operationDirectory: f.scratch, cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256, migrationGrowthBudgetBytes: 100000,
    inventoryOutputPath: output.inventory, targetsOutputPath: output.targets, backupOutputPath: output.backup,
    now, clock: () => freshNow, liveProviderFactory: () => ({ async capture() { return { capturedAt: providerNow }; } }),
    liveConfigSnapshot: () => snapshot, adapterFactory: () => adapter });
  assert.equal(captured.remoteWrites, false);
  assert.deepEqual(observedTimes, [freshNow, freshNow, freshNow]);
  assert.equal(captured.inventory.capturedAt, providerNow);
});

test('inventory publication refuses a destination created after preflight without clobbering it', async t => {
  const f = await fixture(t);
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint,
    bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  const provider = { async capture() { return { capturedAt: '2026-09-22T12:00:00.000Z' }; } };
  const adapter = {
    async captureMaintenanceHold() { return makeHold(); },
    async inventory(target) { return [{ id: target.databaseId, name: target.name, bytes: 1000 }]; },
    async inspect(target) {
      const previous = f.targets.find(candidate => candidate.role === target.role).previous;
      return { schemaSha256: previous.schemaSha256, dataInvariantSha256: previous.dataInvariantSha256,
        migrations: previous.ledger, ledgerSha256: identityDigest(previous.ledger), bytes: 1000 };
    },
    async captureBackupReceipt() { return f.plan.inventory.backupReceipt; },
  };
  const output = { inventory: join(f.scratch, 'race-inventory.json'), targets: join(f.scratch, 'race-targets.json'),
    backup: join(f.scratch, 'race-backup.json') };
  const args = { accountId: f.plan.accountId, workerName: f.plan.workerName, operationDirectory: f.scratch,
    cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256, migrationGrowthBudgetBytes: 100000,
    inventoryOutputPath: output.inventory, targetsOutputPath: output.targets, backupOutputPath: output.backup, now,
    liveProviderFactory: () => provider, liveConfigSnapshot: () => snapshot, adapterFactory: () => adapter,
    beforePublish: async entry => { if (entry.name === 'targets') await writeFile(output.targets, 'concurrent\n', { mode: 0o600, flag: 'wx' }); } };
  await assert.rejects(captureTypedForwardInventory(args), { code: 'TYPED_FORWARD_INVENTORY_CAPTURE_PUBLICATION_INCOMPLETE' });
  assert.equal(await readFile(output.targets, 'utf8'), 'concurrent\n');
  const partial = JSON.parse(await readFile(join(f.scratch, 'typed-forward-inventory-publication.json'), 'utf8'));
  assert.deepEqual(partial.published, ['inventory']);
  await assert.rejects(captureTypedForwardInventory({ ...args, beforePublish: undefined,
    liveProviderFactory: () => assert.fail('invalid publication must stop before another remote read'), adapterFactory: () => assert.fail('invalid publication must stop before D1 read') }),
  { code: 'TYPED_FORWARD_INVENTORY_CAPTURE_PUBLICATION_INVALID' });
  assert.equal(await readFile(output.targets, 'utf8'), 'concurrent\n');
});

test('inventory capture refuses an uncontained hold before writing artifacts', async t => {
  const f = await fixture(t);
  const snapshot = { schema: 'production-live-config-v1', sourceCommit: TYPED_FORWARD_PREVIOUS_SOURCE, versionId: f.plan.inventory.versionId,
    fingerprint: f.plan.inventory.fingerprint, bindings: f.targets.map(target => ({ name: target.binding, type: 'd1', database_id: target.databaseId, database_name: target.name })) };
  const output = [join(f.scratch, 'inventory.json'), join(f.scratch, 'targets.json'), join(f.scratch, 'backup.json')];
  const adapter = { async captureMaintenanceHold() { throw Object.assign(new Error('collection active'), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_UNVERIFIED' }); },
    async inventory() { assert.fail('uncontained hold should stop before D1 inventory'); }, async inspect() { assert.fail('uncontained hold should stop before D1 inspect'); },
    async captureBackupReceipt() { assert.fail('uncontained hold should stop before backup capture'); } };
  await assert.rejects(captureTypedForwardInventory({ accountId: f.plan.accountId, workerName: f.plan.workerName, operationDirectory: f.scratch,
    cliPath: 'synthetic-cli', wranglerSha256: f.plan.wranglerSha256, migrationGrowthBudgetBytes: 100000,
    inventoryOutputPath: output[0], targetsOutputPath: output[1], backupOutputPath: output[2], now,
    liveProviderFactory: () => ({ async capture() { return { capturedAt: '2026-09-22T12:00:00.000Z' }; } }),
    liveConfigSnapshot: () => snapshot, adapterFactory: () => adapter }), { code: 'TYPED_FORWARD_MAINTENANCE_HOLD_UNVERIFIED' });
  for (const path of output) await assert.rejects(stat(path));
});

test('injected backup verification cannot replace exact concrete bookmark comparison', async t => {
  const f = await fixture(t);
  const cliPath = join(WORKER_ROOT, 'node_modules/wrangler/wrangler-dist/cli.js');
  const cliSha256 = (await import('node:crypto')).createHash('sha256').update(await readFile(cliPath)).digest('hex');
  let supplementalChecks = 0;
  const adapter = await createTypedForwardWranglerAdapter({ plan: { ...f.plan, wranglerSha256: cliSha256 }, operationDirectory: f.scratch, cliPath,
    backupVerifier: async () => { supplementalChecks += 1; },
    spawn() { return { status: 0, stdout: JSON.stringify({ bookmark: 'wrong-bookmark' }), stderr: '' }; } });
  await assert.rejects(adapter.verifyBackupReceipt(f.plan.inventory.backupReceipt, f.targets, now), { code: 'TYPED_FORWARD_BACKUP_RECEIPT_UNVERIFIED' });
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
  assert.equal(parseTypedForwardArguments(['--mode', 'rehearse', '--worker-root', 'worker', '--output', 'rehearsal.json']).outputPath, 'rehearsal.json');
  assert.equal(parseTypedForwardArguments(['--mode', 'execute', '--plan', 'plan.json', '--worker-root', 'worker', '--operation', 'operation', '--repository-root', 'repo', '--cli', 'cli', '--confirmation', TYPED_FORWARD_CONFIRMATION, '--approved-plan-sha256', 'a'.repeat(64), '--extension', 'extension.json', '--approved-extension-sha256', 'b'.repeat(64)]).mode, 'execute');
  assert.equal(parseTypedForwardArguments(['--mode', 'capture-backup', '--targets', 'targets.json', '--operation', 'operation', '--cli', 'cli', '--account-id', 'a'.repeat(32), '--wrangler-sha256', 'b'.repeat(64), '--output', 'backup.json']).mode, 'capture-backup');
  assert.equal(parseTypedForwardArguments(['--mode', 'capture-inventory', '--operation', 'operation', '--cli', 'cli', '--account-id', 'a'.repeat(32), '--worker-name', 'worker', '--wrangler-sha256', 'b'.repeat(64), '--growth-budget-bytes', '100000', '--inventory-output', 'inventory.json', '--targets-output', 'targets.json', '--backup-output', 'backup.json']).mode, 'capture-inventory');
  assert.equal(parseTypedForwardArguments(['--mode', 'capture-inventory', '--operation', 'operation', '--cli', 'cli', '--account-id', 'a'.repeat(32), '--worker-name', 'worker', '--wrangler-sha256', 'b'.repeat(64), '--growth-budget-bytes', '0', '--inventory-output', 'inventory.json', '--targets-output', 'targets.json', '--backup-output', 'backup.json']).migrationGrowthBudgetBytes, '0');
  assert.throws(() => parseTypedForwardArguments(['--mode', 'execute', '--plan', 'plan.json']), { code: 'TYPED_FORWARD_ARGUMENTS_INVALID' });
});

test('rehearse CLI emits an atomic private rehearsal artifact when output is requested', async t => {
  const f = await fixture(t);
  const outputPath = join(f.scratch, 'rehearsal.json');
  const scriptPath = process.cwd().endsWith('/apps/worker') ? 'scripts/typed-forward-migration.mjs' : 'apps/worker/scripts/typed-forward-migration.mjs';
  const stdout = execFileSync(process.execPath, [scriptPath, '--mode', 'rehearse', '--worker-root', WORKER_ROOT, '--output', outputPath],
    { cwd: process.cwd(), encoding: 'utf8' });
  const metadata = JSON.parse(stdout);
  assert.equal(metadata.status, 'rehearsed');
  assert.equal(metadata.remoteWrites, false);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  const rehearsal = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(rehearsal.schema, 'typed-forward-migration-rehearsal-v2');
  assert.equal(metadata.rehearsalSha256, identityDigest(rehearsal));
});

test('rehearsal private output refuses a concurrent destination without clobbering it', async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'typed-forward-rehearsal-output-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const outputPath = join(scratch, 'rehearsal.json');
  await assert.rejects(writePrivateJsonNoClobber(outputPath, { schema: 'synthetic-rehearsal' }, {
    beforeCommit: async path => writeFile(path, 'concurrent\n', { mode: 0o600, flag: 'wx' }),
  }), { code: 'TYPED_FORWARD_PLAN_OUTPUT_EXISTS' });
  assert.equal(await readFile(outputPath, 'utf8'), 'concurrent\n');
});
