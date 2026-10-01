import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identityDigest, readOperation } from '../../../scripts/lib/release-operation.mjs';
import { prepareStoragePlan, storageSha256, storageSchemaDigest, D1_STORAGE_CONFIRMATION, validateStoragePlan, resolveStorageApproval } from './d1-storage-plan.mjs';
import { runStorageOperation } from './d1-storage-operator.mjs';
import { parseStorageArguments } from './d1-storage-wrangler.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const resourceId = '22222222-2222-4222-8222-222222222222';
const source = 'a'.repeat(40);
const extensionFor = (plan, previousExtensionSha256 = null, now = Date.now()) => ({
  schema: 'd1-storage-approval-extension-v1', planSha256: identityDigest(plan), previousExtensionSha256,
  approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
});
async function fixture(t, phase = 'migrate', targetCount = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'd1-storage-check-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'routing-migrations'); await mkdir(path);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const schema = () => storageSchemaDigest(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema').all());
  const migrations = [];
  for (const [name, sql] of [['0001_first.sql', 'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT);'],
    ['0002_second.sql', 'ALTER TABLE sample ADD COLUMN approved INTEGER;']]) {
    const beforeSchemaSha256 = schema(); db.exec(sql);
    migrations.push({ name, sha256: storageSha256(sql), beforeSchemaSha256, afterSchemaSha256: schema() });
    await writeFile(join(path, name), sql);
  }
  const evidence = JSON.stringify({ schema: 'synthetic-qualification', status: 'passed' });
  await writeFile(join(path, 'qualification-evidence.json'), evidence);
  const qualification = JSON.stringify({ schema: 'd1-storage-schema-qualification-v1', status: 'qualified', role: 'control',
    directory: 'routing-migrations', sourceCommit: source, evidenceSha256: storageSha256(evidence), migrations });
  await writeFile(join(path, 'qualification.json'), qualification);
  const plan = { schema: 'd1-storage-plan-v1', operationId: id, environment: 'staging', accountId: 'b'.repeat(32), sourceCommit: source,
    previousSourceCommit: 'c'.repeat(40), createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    phase, operatingCapBytes: 9_000_000_000, targets: Array.from({ length: targetCount }, (_, i) => ({ role: 'control',
      name: `tibotattle-staging-control-${i}-${id}`, binding: `CONTROL_${i}`, databaseId: phase === 'create' ? null : `${i + 2}2222222-2222-4222-8222-222222222222`,
      qualificationSha256: storageSha256(qualification), migrationGrowthBudgetBytes: 1_000_000 })) };
  let owner = null, releases = 0, creates = 0, writes = 0;
  const resources = new Map(), ledgers = new Map();
  if (phase === 'migrate') for (const target of plan.targets) resources.set(target.binding, { id: target.databaseId, name: target.name, bytes: 16384 });
  const lock = { createOwner: () => 'd'.repeat(40), acquire: (next) => { assert.equal(owner, null); owner = next; },
    assertOwned: (expected) => assert.equal(owner, expected), release: (expected) => { assert.equal(owner, expected); releases++; owner = null; }, status: () => owner };
  const adapter = { inventory: async (target) => resources.has(target.binding) ? [resources.get(target.binding)] : [],
    create: async (target) => { creates++; resources.set(target.binding, { id: resourceId, name: target.name, bytes: 16384 }); },
    inspect: async (target) => {
      const count = ledgers.get(target.binding) ?? 0;
      return { schemaSha256: count ? migrations[count - 1].afterSchemaSha256 : migrations[0].beforeSchemaSha256,
        migrations: migrations.slice(0, count).map(({ name, sha256 }) => ({ name, sha256 })) };
    },
    migrate: async (target) => { writes++; ledgers.set(target.binding, (ledgers.get(target.binding) ?? 0) + 1); } };
  const args = { plan, workerRoot: root, repositoryRoot: root, directory: join(root, 'operation'), execute: true,
    confirmation: D1_STORAGE_CONFIRMATION, approvedPlanSha256: identityDigest(plan), adapterFactory: () => adapter, lockFactory: () => lock };
  return { root, path, plan, args, adapter, lock, resources, ledgers, migrations,
    counts: () => ({ creates, writes, releases, owner }) };
}

test('default plan performs no auth, lock, database or operation-directory effects', async (t) => {
  const f = await fixture(t);
  const result = await runStorageOperation({ ...f.args, execute: false,
    adapterFactory: () => assert.fail('adapter constructed'), lockFactory: () => assert.fail('lock constructed') });
  assert.equal(result.status, 'planned'); assert.equal(result.publishingPerformed, false);
  await assert.rejects(readFile(join(f.root, 'operation', 'operation.json')), { code: 'ENOENT' });
});
test('closed plans reject stale time, foreign IDs, extra options and an increased operating cap', async (t) => {
  const f = await fixture(t);
  for (const update of [{ expiresAt: new Date(0).toISOString() }, { accountId: 'not-an-account' },
    { operatingCapBytes: 10_000_000_000 }, { extra: true }]) assert.throws(() => validateStoragePlan({ ...f.plan, ...update }));
  await assert.rejects(runStorageOperation({ ...f.args, approvedPlanSha256: '0'.repeat(64) }), { code: 'D1_STORAGE_EXECUTE_NOT_APPROVED' });
  assert.deepEqual(parseStorageArguments(['--plan', 'plan.json', '--worker-root', '/worker']), { execute: false, resume: false, plan: 'plan.json', 'worker-root': '/worker' });
  assert.throws(() => parseStorageArguments(['--execute', '--execute']));
});
test('foundation-only, changed evidence, unlisted SQL and absent role directories refuse qualification', async (t) => {
  const f = await fixture(t);
  await rm(join(f.path, 'qualification.json'));
  await assert.rejects(prepareStoragePlan({ plan: f.plan, workerRoot: f.root }), { code: 'D1_STORAGE_SCHEMA_UNQUALIFIED' });
  const g = await fixture(t);
  await writeFile(join(g.path, 'qualification-evidence.json'), '{}');
  await assert.rejects(prepareStoragePlan({ plan: g.plan, workerRoot: g.root }), { code: 'D1_STORAGE_QUALIFICATION_EVIDENCE_CHANGED' });
  const h = await fixture(t);
  await writeFile(join(h.path, '9999_unreviewed.sql'), 'CREATE TABLE unknown(id);');
  await assert.rejects(prepareStoragePlan({ plan: h.plan, workerRoot: h.root }), { code: 'D1_STORAGE_UNQUALIFIED_MIGRATIONS' });
  const absent = structuredClone(h.plan); absent.targets[0].role = 'analytics'; absent.targets[0].name = absent.targets[0].name.replace('-control-', '-analytics-');
  await assert.rejects(prepareStoragePlan({ plan: absent, workerRoot: h.root }), { code: 'D1_STORAGE_SCHEMA_DIRECTORY_UNQUALIFIED' });
});
test('lost create response reconciles exact named server identity without another create', async (t) => {
  const f = await fixture(t, 'create'); const create = f.adapter.create;
  f.adapter.create = async (target) => { await create(target); throw new Error('private provider payload'); };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_CREATE_RESULT_UNCERTAIN' });
  assert.equal(f.counts().creates, 1); assert.notEqual(f.counts().owner, null);
  const result = await runStorageOperation({ ...f.args, resume: true });
  assert.equal(result.status, 'completed'); assert.equal(f.counts().creates, 1);
  const receipt = await readOperation(f.args.directory);
  assert.equal(receipt.state.targets.CONTROL_0.id, resourceId);
  assert.equal(JSON.stringify(receipt).includes('private provider'), false);
});
test('absent uncertain creation and preexisting name never cause duplicate resource creation', async (t) => {
  const f = await fixture(t, 'create'); f.adapter.create = async () => { throw new Error('lost'); };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_CREATE_RESULT_UNCERTAIN' });
  await assert.rejects(runStorageOperation({ ...f.args, resume: true }), { code: 'D1_STORAGE_CREATE_RESULT_UNCERTAIN' });
  assert.equal(f.counts().creates, 0);
  const g = await fixture(t, 'create'); g.resources.set('CONTROL_0', { id: resourceId, name: g.plan.targets[0].name, bytes: 16384 });
  await assert.rejects(runStorageOperation(g.args), { code: 'D1_STORAGE_RESOURCE_NAME_ALREADY_EXISTS' }); assert.equal(g.counts().creates, 0);
});
test('exact per-shard migration receipts, no completed-operation replay', async (t) => {
  const f = await fixture(t, 'migrate', 2);
  assert.equal((await runStorageOperation(f.args)).status, 'completed');
  assert.equal(f.counts().writes, 4);
  const state = (await readOperation(f.args.directory)).state;
  for (const target of f.plan.targets) {
    assert.equal(state.targets[target.binding].status, 'migrated');
    assert.equal(state.targets[target.binding].schemaSha256, f.migrations[1].afterSchemaSha256);
    assert.equal(state.targets[target.binding].databaseId, target.databaseId);
  }
  await runStorageOperation({ ...f.args, resume: true, adapterFactory: () => assert.fail('replayed'), lockFactory: () => assert.fail('replayed') });
  assert.equal(f.counts().writes, 4);
});
test('partial fleet failure preserves completed first shard and never blindly retries uncertain second step', async (t) => {
  const f = await fixture(t, 'migrate', 2); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => {
    if (target.binding === 'CONTROL_1' && step.name === '0002_second.sql') throw new Error('timeout');
    await migrate(target, step);
  };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_MIGRATION_RESULT_UNCERTAIN' });
  const receipt = await readOperation(f.args.directory);
  assert.equal(receipt.state.targets.CONTROL_0.status, 'migrated'); assert.equal(receipt.state.targets.CONTROL_1.status, 'migration_intent');
  await assert.rejects(runStorageOperation({ ...f.args, resume: true }), { code: 'D1_STORAGE_MIGRATION_RESULT_UNCERTAIN' });
  assert.equal(f.counts().writes, 3); assert.equal(f.counts().releases, 0);
});
test('lost migration result advances only after exact schema and ledger readback', async (t) => {
  const f = await fixture(t); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => { await migrate(target, step); throw new Error('lost'); };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_MIGRATION_RESULT_UNCERTAIN' });
  f.adapter.migrate = migrate;
  await runStorageOperation({ ...f.args, resume: true }); assert.equal(f.counts().writes, 2);
});
test('drifted IDs, capacity and ledger/schema disagreements refuse all writes', async (t) => {
  for (const mode of ['id', 'capacity', 'schema', 'ledger']) {
    const f = await fixture(t);
    if (mode === 'id') f.resources.get('CONTROL_0').id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    if (mode === 'capacity') f.resources.get('CONTROL_0').bytes = 8_999_999_999;
    if (mode === 'schema') f.adapter.inspect = async () => ({ schemaSha256: '0'.repeat(64), migrations: [] });
    if (mode === 'ledger') f.adapter.inspect = async () => ({ schemaSha256: f.migrations[0].afterSchemaSha256, migrations: [{ name: f.migrations[0].name, sha256: '0'.repeat(64) }] });
    await assert.rejects(runStorageOperation(f.args)); assert.equal(f.counts().writes, 0);
  }
});
test('schema source mutation between inspection and effect is caught at mutation guard', async (t) => {
  const f = await fixture(t); const inspect = f.adapter.inspect;
  f.adapter.inspect = async (target) => { await writeFile(join(f.path, '0001_first.sql'), 'DROP TABLE something;'); return inspect(target); };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_MIGRATION_CHANGED_OR_RESERVED' }); assert.equal(f.counts().writes, 0);
});
test('lost lock release response finishes by read-only reconciliation, without reacquisition', async (t) => {
  const f = await fixture(t); const release = f.lock.release;
  f.lock.release = (owner) => { release(owner); throw new Error('lost response'); };
  await assert.rejects(runStorageOperation(f.args));
  assert.equal((await runStorageOperation({ ...f.args, resume: true })).status, 'completed'); assert.equal(f.counts().writes, 2); assert.equal(f.counts().releases, 1);
});
test('an exact expired plan reconciles final committed migration and releases its existing owner', async (t) => {
  const f = await fixture(t); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => { await migrate(target, step); if (step.name === '0002_second.sql') throw new Error('lost final response'); };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_MIGRATION_RESULT_UNCERTAIN' });
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  assert.equal((await runStorageOperation({ ...f.args, resume: true })).status, 'completed');
  assert.deepEqual(f.counts(), { creates: 0, writes: 2, releases: 1, owner: null });
  await runStorageOperation({ ...f.args, resume: true, adapterFactory: () => assert.fail('completed replay'), lockFactory: () => assert.fail('completed replay') });
});
test('expired partial execution reconciles its accepted prefix but never starts the next migration', async (t) => {
  const f = await fixture(t); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => { await migrate(target, step); throw new Error('lost first response'); };
  await assert.rejects(runStorageOperation(f.args), { code: 'D1_STORAGE_MIGRATION_RESULT_UNCERTAIN' });
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  await assert.rejects(runStorageOperation({ ...f.args, resume: true }), { code: 'D1_STORAGE_APPROVAL_EXPIRED' });
  assert.equal((await readOperation(f.args.directory)).state.targets.CONTROL_0.applied, 1);
  assert.equal(f.counts().writes, 1); assert.equal(f.counts().releases, 0);
  const changed = { ...f.plan, expiresAt: new Date(Date.parse(f.plan.expiresAt) + 600_000).toISOString() };
  await assert.rejects(runStorageOperation({ ...f.args, plan: changed, approvedPlanSha256: identityDigest(changed), resume: true }), { code: 'RELEASE_OPERATION_INPUT_MISMATCH' });
});
test('expired lost create response is reconciled without issuing a second creation', async (t) => {
  const f = await fixture(t, 'create'); const create = f.adapter.create;
  f.adapter.create = async (target) => { await create(target); throw new Error('lost'); };
  await assert.rejects(runStorageOperation(f.args));
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  assert.equal((await runStorageOperation({ ...f.args, resume: true })).status, 'completed');
  assert.equal(f.counts().creates, 1);
});
test('expired release-intent reconciliation neither reacquires the lock nor repeats database effects', async (t) => {
  const f = await fixture(t); const release = f.lock.release;
  f.lock.release = (owner) => { release(owner); throw new Error('lost'); };
  await assert.rejects(runStorageOperation(f.args));
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  assert.equal((await runStorageOperation({ ...f.args, resume: true })).status, 'completed');
  assert.equal(f.counts().writes, 2); assert.equal(f.counts().releases, 1);
});
test('over-budget final commit reconciles truthfully after expiry while prohibiting additional writes', async (t) => {
  const f = await fixture(t); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => {
    await migrate(target, step);
    if (step.name === '0002_second.sql') { f.resources.get(target.binding).bytes = 9_100_000_000; throw new Error('lost response'); }
  };
  await assert.rejects(runStorageOperation(f.args));
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  assert.equal((await runStorageOperation({ ...f.args, resume: true })).status, 'completed-over-budget');
  assert.equal((await readOperation(f.args.directory)).state.targets.CONTROL_0.bytes, 9_100_000_000);
  assert.equal(f.counts().writes, 2); assert.equal(f.counts().releases, 1);
});
test('approved linked extension completes only the remaining migration under the original binding and owner', async (t) => {
  const f = await fixture(t); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => { await migrate(target, step); throw new Error('lost first result'); };
  await assert.rejects(runStorageOperation(f.args));
  const original = await readOperation(f.args.directory), owner = f.counts().owner;
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  const extension = extensionFor(f.plan), approvedExtensionSha256 = identityDigest(extension);
  f.adapter.migrate = migrate; f.lock.acquire = () => assert.fail('must retain original owner');
  const result = await runStorageOperation({ ...f.args, resume: true, extension, approvedExtensionSha256 });
  assert.equal(result.status, 'completed'); assert.equal(f.counts().writes, 2);
  const completed = await readOperation(f.args.directory);
  assert.equal(completed.binding, original.binding); assert.equal(completed.state.owner, owner);
  assert.deepEqual(completed.state.approvalExtensions, [extension]);
  await runStorageOperation({ ...f.args, resume: true, extension, approvedExtensionSha256,
    adapterFactory: () => assert.fail('exact replay must not write') });
  assert.equal((await readOperation(f.args.directory)).state.approvalExtensions.length, 1);
});
test('extensions reject wrong approval, changed source/target bindings, stale links and expired deadlines before more writes', async (t) => {
  const f = await fixture(t); const migrate = f.adapter.migrate;
  f.adapter.migrate = async (target, step) => { await migrate(target, step); throw new Error('lost first'); };
  await assert.rejects(runStorageOperation(f.args));
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  const good = extensionFor(f.plan);
  const sourceChanged = { ...f.plan, sourceCommit: 'e'.repeat(40) };
  const targetChanged = structuredClone(f.plan); targetChanged.targets[0].databaseId = '33333333-3333-4333-8333-333333333333';
  for (const document of [
    { ...good, planSha256: identityDigest(sourceChanged) }, { ...good, planSha256: identityDigest(targetChanged) },
    { ...good, previousExtensionSha256: 'e'.repeat(64) }, { ...good, targets: targetChanged.targets },
    { ...good, approvedAt: new Date(Date.now() - 900).toISOString(), expiresAt: new Date(Date.now() - 100).toISOString() },
  ]) await assert.rejects(runStorageOperation({ ...f.args, resume: true, extension: document, approvedExtensionSha256: identityDigest(document) }));
  await assert.rejects(runStorageOperation({ ...f.args, resume: true, extension: good, approvedExtensionSha256: '0'.repeat(64) }), { code: 'D1_STORAGE_EXTENSION_NOT_APPROVED' });
  assert.equal(f.counts().writes, 1); assert.equal(f.counts().releases, 0);
  assert.equal((await readOperation(f.args.directory)).state.approvalExtensions, undefined);
});
test('extension chains require the latest predecessor and exact replay never renews an expired approval', async (t) => {
  const f = await fixture(t), now = Date.parse(f.plan.expiresAt) + 1000;
  const first = extensionFor(f.plan, null, now);
  const next = extensionFor(f.plan, identityDigest(first), now + 600_001);
  const chain = resolveStorageApproval({ plan: f.plan, extensions: [first], extension: next, approvedExtensionSha256: identityDigest(next), now: now + 600_001 });
  assert.deepEqual(chain.extensions, [first, next]);
  assert.throws(() => resolveStorageApproval({ plan: f.plan, extensions: chain.extensions, extension: first,
    approvedExtensionSha256: identityDigest(first), now: now + 600_001 }));
  const replay = resolveStorageApproval({ plan: f.plan, extensions: chain.extensions, extension: next,
    approvedExtensionSha256: identityDigest(next), now: now + 2_000_000 });
  assert.equal(replay.expiresAt, next.expiresAt); assert.equal(replay.extensions.length, 2);
  const missingPrevious = { ...extensionFor(f.plan, null, now + 2_000_000) };
  assert.throws(() => resolveStorageApproval({ plan: f.plan, extensions: chain.extensions, extension: missingPrevious,
    approvedExtensionSha256: identityDigest(missingPrevious), now: now + 2_000_000 }), { code: 'D1_STORAGE_EXTENSION_CHAIN_INVALID' });
});

test('provider table exclusion requires exact DDL and no attached SQL',async()=>{
 const {default:providers}=await import('../src/d1-provider-schema.json',{with:{type:'json'}});
 const provider=providers[0];
 const empty=storageSchemaDigest([]);
 for(const known of providers)assert.equal(storageSchemaDigest([known]),empty);
 for(const rows of [
  [{...provider,sql:provider.sql.replace('value BLOB','value TEXT')}],
  [{...provider,name:'_cf_application',tbl_name:'_cf_application'}],
  [provider,{type:'trigger',name:'_authority_unreviewed_provider',tbl_name:'_cf_KV',sql:'CREATE TRIGGER synthetic AFTER INSERT ON _cf_KV BEGIN SELECT 1; END'}],
 ])assert.notEqual(storageSchemaDigest(rows),empty);
});
