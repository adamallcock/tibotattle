import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, chmod, readdir, readFile, lstat } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fileValidation from './d1-storage-file-preload.cjs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { createStorageWranglerAdapter, storageWranglerEnvironment } from './d1-storage-wrangler.mjs';
import { storageSha256, storageSchemaDigest } from './d1-storage-plan.mjs';

async function setup(t, { phase = 'migrate', fail = false, sql: suppliedSql, importResult } = {}) {
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
  const sql = suppliedSql ?? 'CREATE TABLE values_kept(id INTEGER PRIMARY KEY, value TEXT);';
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
      assert.equal(args.includes(fileValidation.PLACEHOLDER), true);
      const rewritten = fileValidation.fileArguments(args.slice(4), args[3]);
      assert.equal(rewritten.includes('--file'), true); assert.equal(rewritten.includes('--yes'), true);
      assert.equal(rewritten.some(arg => arg.startsWith('--command')), false);
      assert.equal(readFileSync(rewritten[rewritten.indexOf('--file') + 1], 'utf8'), query);
      db.exec('BEGIN');
      try { db.exec(query); db.exec('COMMIT'); }
      catch { db.exec('ROLLBACK'); return { status: 1, stdout: '', stderr: 'synthetic import failure' }; }
      return importResult ?? { status: 0, stdout: '├ Checking if file needs uploading\n│\n' + JSON.stringify([{ success: true, results: [], finalBookmark: 'synthetic-bookmark', meta: { duration: 1 } }]) };
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

test('failed invocations preserve bounded private diagnostics and exact hashes without retrying', async (t) => {
  const key='D1_DIAGNOSTIC_TEST_SECRET', prior=process.env[key];
  process.env[key]='synthetic-private-token-123456';
  t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});
  for (const [result, classification] of [
    [{status: 1, stdout: 'partial output', stderr: 'Authorization: Bearer synthetic-private-token-123456'}, 'nonzero_exit'],
    [{status: null, signal: 'SIGTERM', error: Object.assign(new Error('synthetic timeout'), {code:'ETIMEDOUT'}), stderr: 'a'.repeat(200000)}, 'timeout'],
    [{status: null, error: Object.assign(new Error('synthetic buffer limit'), {code:'ENOBUFS'}), stdout: 'x'.repeat(200000)}, 'output_limit'],
    [{status: null, signal: 'SIGKILL', stderr:'synthetic signal'}, 'signal'],
  ]) {
    const f=await setup(t);let calls=0;
    const adapter=await createStorageWranglerAdapter({plan:f.plan,directory:f.directory,cliPath:f.cliPath,
      spawn:()=>{calls++;return result;}});
    let failure;await assert.rejects(adapter.inventory(f.target), error=>{
      failure=error;return error.code==='D1_STORAGE_WRANGLER_RESULT_UNCERTAIN' && !error.message.includes('synthetic');
    });
    assert.equal(calls,1);assert.equal(failure.diagnostics.classification,classification);
    const dir=join(f.directory,'wrangler');
    const names=(await readdir(dir)).filter(name=>name.endsWith('.failure.json'));
    assert.equal(names.length,1);
    const bytes=await readFile(join(dir,names[0])),receipt=JSON.parse(bytes);
    assert.equal(storageSha256(bytes),failure.diagnostics.sha256);
    assert.equal(receipt.retryPerformed,false);assert.equal(receipt.outcome,'uncertain');
    assert.match(receipt.invocationSha256,/^[a-f0-9]{64}$/);assert.match(receipt.configSha256,/^[a-f0-9]{64}$/);
    for(const [name,output] of Object.entries(receipt.outputs)){
      const path=join(dir,output.file),content=await readFile(path),info=await lstat(path);
      assert.equal(info.mode&0o777,0o600);assert.equal(info.nlink,1);
      assert.equal(content.length,output.bytes);assert.equal(storageSha256(content),output.sha256);
      assert.ok(content.length<=(name==='error'?4096:64*1024));
      assert.equal(content.includes(Buffer.from('synthetic-private-token-123456')),false);
    }
    assert.equal((await lstat(join(dir,names[0]))).mode&0o777,0o600);
    if(classification==='timeout')assert.equal(receipt.outputs.stderr.truncated,true);
    if(classification==='output_limit')assert.equal(receipt.outputs.stdout.truncated,true);
  }
});
test('synchronous spawn failures retain a closed process classification and never repeat',async(t)=>{
 const f=await setup(t);let calls=0;
 const adapter=await createStorageWranglerAdapter({plan:f.plan,directory:f.directory,cliPath:f.cliPath,
  spawn:()=>{calls++;throw Object.assign(new Error('synthetic missing child'),{code:'ENOENT'});}});
 await assert.rejects(adapter.inventory(f.target),error=>error.code==='D1_STORAGE_WRANGLER_RESULT_UNCERTAIN'
  &&error.diagnostics.classification==='spawn_error'&&!error.message.includes('missing child'));
 assert.equal(calls,1);
});
test('diagnostic persistence failure cannot hide an uncertain operation or cause a retry',async(t)=>{
 const f=await setup(t);let calls=0;
 const adapter=await createStorageWranglerAdapter({plan:f.plan,directory:f.directory,cliPath:f.cliPath,
  spawn:()=>{calls++;rmSync(join(f.directory,'wrangler'),{recursive:true,force:true});return {status:1,stderr:'synthetic failure'};}});
 await assert.rejects(adapter.inventory(f.target),error=>error.code==='D1_STORAGE_WRANGLER_RESULT_UNCERTAIN'
  &&error.diagnostics.classification==='unavailable');
 assert.equal(calls,1);
});


test('whole-file migration retains triggers and receipt atomically; readonly inspection keeps query transport', async (t) => {
  const f = await setup(t, { sql: `CREATE TABLE values_kept(id INTEGER PRIMARY KEY, value TEXT);
CREATE TRIGGER preserve_value AFTER INSERT ON values_kept BEGIN UPDATE values_kept SET value='kept' WHERE id=NEW.id; END;` });
  await f.adapter.migrate(f.target, f.step);
  f.db.exec("INSERT INTO values_kept VALUES(1,'original');");
  assert.equal(f.db.prepare('SELECT value FROM values_kept').get().value, 'kept');
  assert.equal((await f.adapter.inspect(f.target)).migrations[0].sha256, f.step.sha256);
  assert.equal(f.calls.filter(call => call.args.includes(fileValidation.PLACEHOLDER)).length, 1);
  assert.ok(f.calls.some(call => call.args.includes('--command=__TIBOTATTLE_FROZEN_QUERY__')));
});

test('failed file import rolls back schema and ledger without automatic retry', async (t) => {
  const f = await setup(t, { sql: 'CREATE TABLE values_kept(id INTEGER); INSERT INTO absent VALUES(1);' });
  await assert.rejects(f.adapter.migrate(f.target, f.step), {code: 'D1_STORAGE_WRANGLER_RESULT_UNCERTAIN'});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name IN ('values_kept','d1_storage_migrations')").get().n, 0);
  assert.equal(f.calls.filter(call => call.args.includes(fileValidation.PLACEHOLDER)).length, 1);
  assert.deepEqual((await f.adapter.inspect(f.target)).migrations, []);
});

test('lost or malformed terminal responses remain uncertain until explicit schema and ledger readback', async (t) => {
  for (const [importResult, classification] of [
    [{status: 1, stdout: '', stderr: 'synthetic response lost after commit'}, 'nonzero_exit'],
    [{status: 0, stdout: '[{"success":true,"results":[]}]'}, 'invalid_response'],
  ]) {
    const f = await setup(t, { importResult });
    await assert.rejects(f.adapter.migrate(f.target, f.step), error => {
      assert.equal(error.code, 'D1_STORAGE_WRANGLER_RESULT_UNCERTAIN');
      assert.equal(error.diagnostics.classification, classification); return true;
    });
    assert.equal(f.calls.filter(call => call.args.includes(fileValidation.PLACEHOLDER)).length, 1);
    assert.deepEqual((await f.adapter.inspect(f.target)).migrations, [{name:f.step.name,sha256:f.step.sha256}]);
  }
});

test('file preload executes only the pinned local fake CLI and refuses changed file, configuration and CLI pins', async (t) => {
  for (const change of [null, 'file', 'config', 'cli']) {
    const f = await setup(t);
    await writeFile(f.cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const adapter = await createStorageWranglerAdapter({plan:f.plan,directory:f.directory,cliPath:f.cliPath,spawn:f.spawn,qualifications:{CONTROL:{migrations:[f.step]}}});
    await adapter.migrate(f.target, f.step);
    const args = f.calls.find(call=>call.args.includes(fileValidation.PLACEHOLDER)).args;
    if(change==='file')await writeFile(args.find(arg=>arg.startsWith('--tibo-query-path=')).split('=').slice(1).join('='), 'SELECT 1;');
    if(change==='config')await writeFile(args[args.indexOf('--config')+1], '{}');
    if(change==='cli')await writeFile(f.cliPath, '// changed');
    const result=spawnSync(process.execPath,args,{encoding:'utf8',timeout:5000,env:{...process.env,NODE_OPTIONS:''}});
    if(change){assert.equal(result.status,1);assert.equal(result.stderr,'D1_STORAGE_FILE_INPUT_INVALID\n');assert.equal(result.stdout,'');}
    else {assert.equal(result.status,0);const actual=JSON.parse(result.stdout);assert.ok(actual.includes('--file'));assert.ok(actual.includes('--yes'));assert.ok(!actual.some(arg=>arg.startsWith('--command')));}
  }
});
