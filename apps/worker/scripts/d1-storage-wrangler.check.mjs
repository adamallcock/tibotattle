import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { createStorageWranglerAdapter, storageWranglerEnvironment } from './d1-storage-wrangler.mjs';
import { storageSha256, storageSchemaDigest } from './d1-storage-plan.mjs';

async function setup(t, { phase = 'migrate', fail = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'd1-storage-wrangler-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cliPath = join(directory, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
  await mkdir(join(directory, 'node_modules', 'wrangler', 'wrangler-dist'), { recursive: true });
  await writeFile(cliPath, '// synthetic CLI, never executed\n');
  await writeFile(join(directory, 'node_modules', 'wrangler', 'package.json'), JSON.stringify({ name: 'wrangler', version: '4.114.0', main: 'wrangler-dist/cli.js' }));
  const id = '11111111-1111-4111-8111-111111111111', databaseId = '22222222-2222-4222-8222-222222222222';
  const target = { role: 'control', name: `tibotattle-staging-control-${id}`, binding: 'CONTROL', databaseId: phase === 'create' ? null : databaseId,
    qualificationSha256: 'd'.repeat(64), migrationGrowthBudgetBytes: 1000 };
  const plan = { schema: 'd1-storage-plan-v1', operationId: id, environment: 'staging', accountId: 'b'.repeat(32),
    sourceCommit: 'a'.repeat(40), previousSourceCommit: 'c'.repeat(40), createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(), phase, operatingCapBytes: 9000000000, targets: [target] };
  const sql = 'CREATE TABLE values_kept(id INTEGER PRIMARY KEY, value TEXT);';
  const step = { name: '0001_values.sql', sql, sha256: storageSha256(sql) };
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(options.timeout, 45000); assert.equal(options.maxBuffer, 512 * 1024);
    const configPath = args[args.indexOf('--config') + 1];
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(config.account_id, plan.accountId);
    assert.equal(config.env, undefined); assert.equal(args.includes('--env'), false);
    for (const key of ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_ENV']) assert.equal(Object.hasOwn(options.env, key), false);
    if (fail) return { status: 1, stderr: 'secret account identifier must not escape', stdout: '' };
    const queryArg = args.find((arg) => arg.startsWith('--tibo-query-path='));
    if (queryArg) {
      assert.equal(args.includes('--remote'), true);
      assert.equal(config.d1_databases.length, 1); assert.equal(config.d1_databases[0].database_id, databaseId);
      assert.equal(args.some((arg) => arg.includes('CREATE TABLE') || arg.includes('SELECT ')), false);
      const query = readFileSync(queryArg.slice('--tibo-query-path='.length), 'utf8');
      if (query.startsWith('SELECT')) return { status: 0, stdout: JSON.stringify([{ success: true, results: db.prepare(query).all() }]) };
      db.exec(query); return { status: 0, stdout: JSON.stringify([{ success: true, results: [] }]) };
    }
    if (args.includes('list')) return { status: 0, stdout: JSON.stringify([{ uuid: databaseId, name: target.name }]) };
    if (args.includes('info')) return { status: 0, stdout: JSON.stringify({ uuid: databaseId, name: target.name, database_size: 16384 }) };
    if (args.includes('create')) { assert.equal(args.includes('--no-update-config'), true); return { status: 0, stdout: 'unstructured human output, not an identity receipt' }; }
    assert.fail('unexpected external command');
  };
  const adapter = await createStorageWranglerAdapter({ plan, directory, cliPath, spawn,
    qualifications: { CONTROL: { migrations: [step] } } });
  return { adapter, calls, target, step, directory, cliPath, db, plan, spawn };
}
test('pinned Wrangler adapter validates single-account configs and real SQLite schema/ledger readback', async (t) => {
  const f = await setup(t);
  assert.equal(f.calls.length, 0, 'construction must not run CLI');
  assert.equal((await f.adapter.inventory(f.target))[0].bytes, 16384);
  const before = await f.adapter.inspect(f.target); assert.deepEqual(before.migrations, []);
  await f.adapter.migrate(f.target, f.step);
  const after = await f.adapter.inspect(f.target);
  assert.notEqual(after.schemaSha256, before.schemaSha256);
  assert.equal(after.schemaSha256, storageSchemaDigest(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema').all()));
  assert.deepEqual(after.migrations, [{ name: f.step.name, sha256: f.step.sha256 }]);
  assert.equal(f.calls.some((call) => call.args.includes('delete')), false);
});
test('adapter refuses cross-plan database and arbitrary SQL before invoking Wrangler', async (t) => {
  const f = await setup(t);
  await assert.rejects(f.adapter.inventory({ ...f.target, databaseId: '33333333-3333-4333-8333-333333333333' }), { code: 'D1_STORAGE_TRANSPORT_TARGET_INVALID' });
  const sql = 'DROP TABLE kept;';
  await assert.rejects(f.adapter.migrate(f.target, { name: '0002_drop.sql', sql, sha256: storageSha256(sql) }), { code: 'D1_STORAGE_MIGRATION_NOT_PLANNED' });
  assert.equal(f.calls.length, 0);
});
test('create disables config mutation and never parses human output as a resource ID', async (t) => {
  const f = await setup(t, { phase: 'create' });
  assert.equal(await f.adapter.create(f.target), undefined); assert.equal(f.calls.length, 1);
});
test('CLI/config changes and provider failures produce closed errors without raw output', async (t) => {
  const f = await setup(t, { fail: true });
  await assert.rejects(f.adapter.inventory(f.target), (error) => error.code === 'D1_STORAGE_WRANGLER_RESULT_UNCERTAIN'
    && !error.message.includes('secret') && !error.message.includes('identifier'));
  const g = await setup(t); await writeFile(g.cliPath, '// changed CLI\n');
  await assert.rejects(g.adapter.inventory(g.target), { code: 'D1_STORAGE_TRANSPORT_PIN_CHANGED' }); assert.equal(g.calls.length, 0);
  const h = await setup(t);
  await h.adapter.inventory(h.target);
  const config = join(h.directory, 'wrangler', 'account.json'); await chmod(config, 0o644);
  await assert.rejects(h.adapter.inventory(h.target), { code: 'D1_STORAGE_TRANSPORT_FILE_CHANGED' });
});
test('ledger DDL, attached triggers and extra indexes cannot hide behind unchanged ledger row values', async (t) => {
  for (const alteration of [
    'ALTER TABLE d1_storage_migrations ADD COLUMN extra TEXT;',
    'CREATE TRIGGER unreviewed AFTER INSERT ON d1_storage_migrations BEGIN DELETE FROM values_kept; END;',
    'CREATE INDEX unreviewed ON d1_storage_migrations(sha256);',
  ]) {
    const f = await setup(t); await f.adapter.migrate(f.target, f.step);
    f.db.exec("INSERT INTO values_kept VALUES(1,'preserved');");
    const ledger = f.db.prepare('SELECT name,sha256 FROM d1_storage_migrations').all();
    f.db.exec(alteration);
    assert.deepEqual(f.db.prepare('SELECT name,sha256 FROM d1_storage_migrations').all(), ledger);
    await assert.rejects(f.adapter.inspect(f.target), { code: 'D1_STORAGE_LEDGER_SCHEMA_MISMATCH' });
    await assert.rejects(f.adapter.migrate(f.target, f.step), { code: 'D1_STORAGE_LEDGER_SCHEMA_MISMATCH' });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM values_kept').get().n, 1);
  }
});
test('all API origin/environment overrides are refused without disclosing their values', () => {
  for (const key of ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'CLOUDFLARE_ENV']) {
    assert.throws(() => storageWranglerEnvironment({ [key]: 'private-override' }, 'b'.repeat(32), '/private/log'),
      (error) => error.code === 'D1_STORAGE_TRANSPORT_ENVIRONMENT_OVERRIDE' && !error.message.includes('private-override'));
  }
  const environment = storageWranglerEnvironment({ PATH: '/safe/bin', CLOUDFLARE_ACCOUNT_ID: 'old' }, 'b'.repeat(32), '/private/log');
  assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, 'b'.repeat(32)); assert.equal(environment.PATH, '/safe/bin');
});
test('transport readback remains available after expiry but create and migrate never do', async (t) => {
  const f = await setup(t); await f.adapter.migrate(f.target, f.step);
  t.mock.method(Date, 'now', () => Date.parse(f.plan.expiresAt) + 1000);
  assert.equal((await f.adapter.inspect(f.target)).migrations.length, 1);
  await assert.rejects(f.adapter.migrate(f.target, f.step), { code: 'D1_STORAGE_APPROVAL_EXPIRED' });
});
test('adapter enforces the linked effective deadline without changing original account, target or source', async (t) => {
  const f = await setup(t);
  const future = Date.parse(f.plan.expiresAt) + 1000;
  let clock = future; t.mock.method(Date, 'now', () => clock);
  const extension = { schema: 'd1-storage-approval-extension-v1', planSha256: identityDigest(f.plan), previousExtensionSha256: null,
    approvedAt: new Date(future).toISOString(), expiresAt: new Date(future + 1000).toISOString() };
  const adapter = await createStorageWranglerAdapter({ plan: f.plan, directory: f.directory, cliPath: f.cliPath, spawn: f.spawn,
    allowExpiredPlan: true, approvalExtensions: [extension], qualifications: { CONTROL: { migrations: [f.step] } } });
  await adapter.migrate(f.target, f.step);
  assert.equal((await adapter.inspect(f.target)).migrations.length, 1);
  const before = f.calls.length; clock = future + 1001;
  await assert.rejects(adapter.migrate(f.target, f.step), { code: 'D1_STORAGE_APPROVAL_EXPIRED' });
  assert.equal(f.calls.length, before, 'expired extension must not issue even a preliminary migration query');
});
