import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, chmod, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { identityDigest, readOperation } from '../../../scripts/lib/release-operation.mjs';
import {
  createExistingAccountlessBootstrapTransport,
  existingAccountlessBootstrapConfig,
  existingAccountlessBootstrapRuntimePlan,
  prepareExistingAccountlessBootstrapPackage,
  reconcileExistingAccountlessBootstrapOperator,
  runExistingAccountlessBootstrapOperator,
} from './storage-existing-owner-bootstrap-operator.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const cli = resolve(root, 'node_modules/wrangler/wrangler-dist/cli.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const cliSha = sha(await readFile(cli));
const future = Date.now() + 60 * 60 * 1000;
const temporaryRoot = await realpath(tmpdir());
const plan = Object.freeze({ schema: 'storage-existing-accountless-bootstrap-operator-v1', toolingCommit: 'a'.repeat(40),
  accountId: 'a'.repeat(32), workerName: 'tibotattle-existing-bootstrap-test', queueName: 'tibotattle-existing-bootstrap-queue-test',
  sourceDatabase: { id: '11111111-1111-4111-8111-111111111111', name: 'tibotattle-existing-source-test' },
  catalogDatabase: { id: '22222222-2222-4222-8222-222222222222', name: 'tibotattle-routing-catalog-test' },
  sourceId: 'existing-accountless-source-a', shardId: 'a', bindingName: 'STORAGE_INGESTION_A',
  perOwnerFutureHeadroomBytes: 16_777_216, newOwnerCutoffBytes: 6_000_000_000,
  databaseBudgetBytes: 9_000_000_000, expiresAt: future,
  wranglerSha256: cliSha, maintenance: { planDigest: 'b'.repeat(64),
    operationId: '33333333-3333-4333-8333-333333333333', versionId: '44444444-4444-4444-8444-444444444444', owner: 'c'.repeat(40) } });

async function migrations(database, directories) {
  for (const directory of directories) {
    for (const migration of await readD1Migrations(join(root, directory)))
      await database.batch(migration.queries.map(sql => database.prepare(sql)));
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(temporaryRoot, 'bootstrap-operator-')); await chmod(directory, 0o700);
  const candidate = join(directory, 'candidate');
  await prepareExistingAccountlessBootstrapPackage({ workerRoot: root, directory: candidate, plan,
    checkSource: async () => {} });
  const mf = new Miniflare({ host: '127.0.0.1', cf: false, modules: true,
    script: 'export default {fetch(){return new Response(null,{status:404})}}', compatibilityDate: '2026-07-26',
    d1Databases: { SOURCE: 'source', CATALOG: 'catalog' }, log: new Log(LogLevel.NONE) });
  t.after(() => mf.dispose());
  const source = await mf.getD1Database('SOURCE'), catalog = await mf.getD1Database('CATALOG');
  await migrations(source, ['migrations', 'ingestion-routing-migrations', 'typed-ingestion-migrations', 'ingestion-bridge-migrations']);
  await migrations(catalog, ['routing-migrations']);
  return { directory, candidate, source, catalog };
}

async function seedExistingOwners(f, count, { observedBytes = 1_000, validUntil = Date.now() + 100_000 } = {}) {
  await f.source.prepare("INSERT INTO storage_source_state(singleton,source_id,authority_epoch) VALUES(1,?,0)")
    .bind(plan.sourceId).run();
  await f.source.prepare("UPDATE accountless_enrollment_issuance SET budget_day='2026-09-13',daily_issued=0,lifetime_issued=0,last_issue_token='',updated_at='2026-09-13T12:00:00.000Z' WHERE singleton=1").run();
  for (let index = 0; index < count; index++) {
    const digit = String(index + 1), deviceId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    await f.source.prepare(`INSERT INTO accountless_enrollment_ledger(device_id,device_secret_hash,installation_principal_id,
     schema_version,policy_version,authorization_basis,state,issued_at,expires_at,revoked_at,revocation_reason)
     VALUES(?,randomblob(32),?,'accountless-device-enrollment-v1','accountless-enrollment-policy-v1',
     'accountless-installation-possession-v1','active','2026-09-13T12:00:00.000Z','2026-10-13T12:00:00.000Z',NULL,NULL)`)
      .bind(deviceId, `existing-installation-owner-${String.fromCharCode(97 + index)}`).run();
  }
  await f.source.prepare("UPDATE accountless_enrollment_issuance SET daily_issued=?,lifetime_issued=?,last_issue_token=?")
    .bind(count, count, count ? `existing-installation-owner-${String.fromCharCode(96 + count)}` : '').run();
  await f.catalog.batch([
    f.catalog.prepare("INSERT INTO storage_shards(shard_id,binding_name,state) VALUES('a','STORAGE_INGESTION_A','active')"),
    f.catalog.prepare("INSERT INTO storage_shard_capacity_observations(shard_id,observed_bytes,observed_at,valid_until,pressure_state) VALUES('a',?,?,?,'normal')")
      .bind(observedBytes, Math.min(Date.now(), validUntil - 1), validUntil),
    f.catalog.prepare(`INSERT INTO storage_shard_runtime_readiness(
      readiness_digest,qualification_id,shard_id,catalog_database_id,catalog_binding_name,catalog_schema_digest,binding_name,
      ingestion_database_id,source_id,source_namespace,ingestion_schema_digest,analytics_target_id,
      analytics_binding_name,analytics_database_id,analytics_schema_digest,erasure_target_id,
      deletion_ledger_binding_name,deletion_ledger_database_id,deletion_schema_digest,
      publication_binding_name,publication_database_id,publication_schema_digest,qualified_at,state)
      VALUES(?,?,'a',?,'STORAGE_ROUTING_DB',?,'STORAGE_INGESTION_A',?,?,?,?,'analytics-a','STORAGE_ANALYTICS_A',?,?,
       'analytics-a','DELETION_LEDGER',?,?,'STORAGE_PUBLICATION_DB',?,?,?,'active')`)
      .bind('f'.repeat(64),'55555555-5555-4555-8555-555555555555',plan.catalogDatabase.id,
        '0'.repeat(64),plan.sourceDatabase.id,plan.sourceId,'existing-source-namespace','1'.repeat(64),
        '66666666-6666-4666-8666-666666666666','2'.repeat(64),
        '77777777-7777-4777-8777-777777777777','3'.repeat(64),
        '88888888-8888-4888-8888-888888888888','4'.repeat(64),Date.now()),
    f.catalog.prepare(`INSERT INTO storage_shard_allocation_policy
      (shard_id,allocation_tier,allocation_enabled,updated_at,qualification_digest)
      VALUES('a','active',1,?,?)`).bind(Date.now(),'f'.repeat(64)),
  ]);
}

test('package is disabled/no-ingress, enabled only by one private queue, and real Wrangler accepts both dry builds', async t => {
  const f = await fixture(t), runtime = existingAccountlessBootstrapRuntimePlan(plan);
  const disabled = JSON.parse(await readFile(join(f.candidate, 'wrangler.disabled.jsonc')));
  const enabled = JSON.parse(await readFile(join(f.candidate, 'wrangler.enabled.jsonc')));
  assert.deepEqual(disabled.routes, []); assert.deepEqual(disabled.triggers.crons, []); assert.equal(disabled.workers_dev, false);
  assert.equal(disabled.preview_urls, false); assert.equal(disabled.queues, undefined);
  assert.deepEqual(enabled.queues.consumers, [{ queue: plan.queueName, max_batch_size: 1,
    max_batch_timeout: 1, max_concurrency: 1, max_retries: 0 }]);
  assert.equal(disabled.vars.STORAGE_EXISTING_BOOTSTRAP_OPERATION_DIGEST, runtime.operationDigest);
  const transport = createExistingAccountlessBootstrapTransport({ plan, packageDirectory: f.candidate, cliPath: cli,
    token: null, fetcher: async () => { throw Error('dry run must not use cloud'); }, environment: { PATH: process.env.PATH,
      HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, receipt: async () => {} });
  await transport.deploy('disabled', true); await transport.deploy('enabled', true);
});

test('real bundled worker freezes exact source writes, imports catalog baseline, and only exact reviewed release thaws them', async t => {
  const f = await fixture(t);
  await seedExistingOwners(f, 3);
  const worker = (await import(`${pathToFileURL(join(f.candidate, 'bootstrap-worker.mjs')).href}?${Date.now()}`)).default;
  const runtime = existingAccountlessBootstrapRuntimePlan(plan), env = { SOURCE: f.source, STORAGE_ROUTING_DB: f.catalog,
    STORAGE_EXISTING_BOOTSTRAP_MODE: 'enabled' };
  const invoke = async body => { let ack = 0; await worker.queue({ messages: [{ body, ack() { ack++; } }] }, env); assert.equal(ack, 1); };
  await invoke({ schema: 'storage-existing-accountless-bootstrap-wakeup-v1', operationDigest: runtime.operationDigest, action: 'freeze' });
  await assert.rejects(f.source.prepare("UPDATE accountless_enrollment_issuance SET updated_at='2026-09-13T12:01:00.000Z'").run(), /SOURCE_CLOSED/);
  await invoke({ schema: 'storage-existing-accountless-bootstrap-wakeup-v1', operationDigest: runtime.operationDigest, action: 'advance' });
  const marker = await f.source.prepare('SELECT * FROM storage_existing_accountless_bootstrap_source_closure').first();
  assert.equal(marker.state, 'ready');
  assert.deepEqual(await f.catalog.prepare('SELECT initialization_state,daily_reserved,lifetime_reserved FROM storage_accountless_issuance_state').first(),
    { initialization_state: 'ready', daily_reserved: 3, lifetime_reserved: 3 });
  assert.deepEqual(await f.catalog.prepare(`SELECT r.owner_id,r.shard_id,s.binding_name,r.route_generation AS generation,r.reservation_bytes
   FROM storage_owner_routes r JOIN storage_shards s ON s.shard_id=r.shard_id WHERE r.owner_id='existing-installation-owner-a'`).first(),
    { owner_id: 'existing-installation-owner-a', shard_id: 'a', binding_name: 'STORAGE_INGESTION_A', generation: 1,
      reservation_bytes: 16_777_216 });
  assert.equal(await f.catalog.prepare('SELECT count(*) n FROM storage_owner_routes').first('n'), 3);
  assert.equal(await f.catalog.prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes'), 3 * 16_777_216);
  await assert.rejects(invoke({ schema: 'storage-existing-accountless-bootstrap-wakeup-v1', operationDigest: runtime.operationDigest,
    action: 'release', releaseAuthorization: '0'.repeat(64) }), /RELEASE_NOT_AUTHORIZED/);
  const authorization = sha(`app-usagemonitor/storage-existing-accountless-bootstrap-release/v1\0${runtime.operationDigest}\0${marker.manifest_digest}\0${marker.owner_roster_digest}\0${marker.revision}`);
  await invoke({ schema: 'storage-existing-accountless-bootstrap-wakeup-v1', operationDigest: runtime.operationDigest,
    action: 'release', releaseAuthorization: authorization });
  assert.equal(await f.source.prepare('SELECT state FROM storage_existing_accountless_bootstrap_source_closure').first('state'), 'released');
  await f.source.prepare("UPDATE accountless_enrollment_issuance SET updated_at='2026-09-13T12:01:00.000Z'").run();
  assert.equal(await f.source.prepare('SELECT count(*) n FROM sqlite_schema WHERE type=\'trigger\' AND name GLOB \'storage_bootstrap_*\'').first('n'), 0);
});

test('stale and six-gigabyte source observations refuse all owner routes; a fresh below-cutoff sample resumes without historical-byte double counting', async t => {
  const f = await fixture(t); await seedExistingOwners(f, 3, { validUntil: Date.now() - 1 });
  const worker = (await import(`${pathToFileURL(join(f.candidate, 'bootstrap-worker.mjs')).href}?capacity-${Date.now()}`)).default;
  const runtime = existingAccountlessBootstrapRuntimePlan(plan), env = { SOURCE: f.source, STORAGE_ROUTING_DB: f.catalog,
    STORAGE_EXISTING_BOOTSTRAP_MODE: 'enabled' };
  const invoke = action => worker.queue({ messages: [{ body: { schema: 'storage-existing-accountless-bootstrap-wakeup-v1',
    operationDigest: runtime.operationDigest, action }, ack() {} }] }, env);
  await invoke('freeze'); await assert.rejects(invoke('advance'));
  assert.equal(await f.catalog.prepare('SELECT count(*) n FROM storage_owner_routes').first('n'), 0);
  assert.equal(await f.source.prepare('SELECT state FROM storage_existing_accountless_bootstrap_source_closure').first('state'), 'frozen');
  await f.catalog.prepare('UPDATE storage_shard_capacity_observations SET observed_bytes=6000000000,observed_at=?,valid_until=? WHERE shard_id=\'a\'')
    .bind(Date.now(), Date.now() + 100_000).run();
  await assert.rejects(invoke('advance'));
  assert.equal(await f.catalog.prepare('SELECT count(*) n FROM storage_owner_routes').first('n'), 0);
  await f.catalog.prepare('UPDATE storage_shard_capacity_observations SET observed_bytes=5900000000,observed_at=?,valid_until=? WHERE shard_id=\'a\'')
    .bind(Date.now(), Date.now() + 100_000).run();
  await invoke('advance');
  assert.equal(await f.catalog.prepare('SELECT count(*) n FROM storage_owner_routes').first('n'), 3);
  assert.equal(await f.catalog.prepare("SELECT reserved_bytes FROM storage_shards WHERE shard_id='a'").first('reserved_bytes'), 3 * 16_777_216);
});

function json(result, resultInfo) { return new Response(JSON.stringify({ success: true, result, ...(resultInfo ? { result_info: resultInfo } : {}) }),
  { status: 200, headers: { 'content-type': 'application/json' } }); }

test('concrete API transport binds exact D1 and queue identities and sends a JSON Queue message without exposing token', async t => {
  const f = await fixture(t), events = [], token = 'synthetic-secret-token-value', queueId = 'd'.repeat(32);
  const fetcher = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${token}`); events.push([init.method, new URL(url).pathname, init.body]);
    const parsed = new URL(url), path = parsed.pathname;
    if (path.endsWith(`/d1/database/${plan.sourceDatabase.id}/query`)) return json([{ success: true,
      results: [{ operation_digest: identityDigest(plan), state: 'frozen' }] }]);
    if (path.endsWith(`/d1/database/${plan.catalogDatabase.id}/query`)) return json([{ success: true,
      results: [{ state: 'importing', imported_count: 1 }] }]);
    if (path.endsWith(`/d1/database/${plan.sourceDatabase.id}`)) return json({ uuid: plan.sourceDatabase.id, name: plan.sourceDatabase.name });
    if (path.endsWith(`/d1/database/${plan.catalogDatabase.id}`)) return json({ uuid: plan.catalogDatabase.id, name: plan.catalogDatabase.name });
    if (path.endsWith('/queues') && init.method === 'POST') return json({ queue_id: queueId, queue_name: plan.queueName });
    if (path.endsWith('/queues') && parsed.search === '?page=1&per_page=100') return json([]);
    if (path.endsWith(`/queues/${queueId}`)) return json({ queue_id: queueId, queue_name: plan.queueName });
    if (path.endsWith(`/queues/${queueId}/messages`)) return json({ metadata: {} });
    throw Error(`unexpected ${path}`);
  };
  const transport = createExistingAccountlessBootstrapTransport({ plan, packageDirectory: f.candidate, cliPath: cli,
    token, fetcher, environment: {}, receipt: async value => assert.equal(JSON.stringify(value).includes(token), false) });
  assert.equal(await transport.createQueue(), queueId);
  const body = { schema: 'storage-existing-accountless-bootstrap-wakeup-v1', operationDigest: identityDigest(plan), action: 'freeze' };
  await transport.push(queueId, body);
  const sent = JSON.parse(events.at(-1)[2]); assert.deepEqual(sent, { body, content_type: 'json' });
  assert.equal((await transport.sourceStatus()).state, 'frozen');
  assert.equal((await transport.catalogStatus()).imported_count, 1);
  const queryBodies = events.filter(([, path]) => path.endsWith('/query')).map(event => JSON.parse(event[2]));
  assert.equal(queryBodies.length, 2); assert.ok(queryBodies.every(value => Array.isArray(value.params) && value.params.length === 0));
  assert.equal(JSON.stringify(events).includes(token), false);
});

test('transport accepts the observed nested Queue consumer and refuses identity or delivery-policy drift',async t=>{
  const f=await fixture(t),queueId='d'.repeat(32),consumerId='e'.repeat(32);
  const preparation=JSON.parse(await readFile(join(f.candidate,'preparation.json')));
  const bindings=[
    {type:'d1',name:'SOURCE',id:plan.sourceDatabase.id},
    {type:'d1',name:'STORAGE_ROUTING_DB',database_id:plan.catalogDatabase.id},
    {type:'plain_text',name:'STORAGE_EXISTING_BOOTSTRAP_MODE',text:'enabled'},
    {type:'plain_text',name:'STORAGE_EXISTING_BOOTSTRAP_OPERATION_DIGEST',text:identityDigest(plan)},
    {type:'plain_text',name:'STORAGE_EXISTING_BOOTSTRAP_BUNDLE_SHA256',text:preparation.bundleSha256},
  ];
  let change=null;
  const fetcher=async(url)=>{const parsed=new URL(url),path=parsed.pathname;let result;
    if(path.endsWith(`/workers/scripts/${plan.workerName}/settings`))result={bindings};
    else if(path.endsWith(`/workers/scripts/${plan.workerName}/subdomain`))result={enabled:false,previews_enabled:false};
    else if(path.endsWith('/routes'))result=[];
    else if(path.endsWith('/schedules'))result=[];
    else if(path.endsWith('/queues'))result=[{queue_id:queueId,queue_name:plan.queueName}];
    else if(path.endsWith(`/queues/${queueId}/consumers`)){const consumer={script:plan.workerName,type:'worker',
      queue_name:plan.queueName,queue_id:queueId,consumer_id:consumerId,created_on:'2026-09-13T19:50:49.046911Z',
      settings:{batch_size:1,max_retries:0,max_wait_time_ms:1000,max_concurrency:1,retry_delay:0}};
      if(change)change(consumer);result=[consumer];}
    else throw Error(`unexpected ${path}`);
    return json(result);
  };
  const make=()=>createExistingAccountlessBootstrapTransport({plan,packageDirectory:f.candidate,cliPath:cli,
    token:'synthetic-secret-token-value',fetcher,environment:{},receipt:async()=>{}});
  await make().inspectWorker('enabled');
  for(const mutate of [value=>{value.script_name='contradictory-worker';},value=>{delete value.script;},
    value=>{value.queue_id='f'.repeat(32);},value=>{value.type='http_pull';},
    value=>{value.settings.max_wait_time_ms=999;},value=>{value.settings.extra=true;}]){
    change=mutate;await assert.rejects(make().inspectWorker('enabled'),
      {code:'D1_STORAGE_EXISTING_BOOTSTRAP_QUEUE_CONSUMER_CHANGED'});
  }
});

test('same database id with wrong name refuses before queue creation', async t => {
  const f = await fixture(t), calls = [];
  const transport = createExistingAccountlessBootstrapTransport({ plan, packageDirectory: f.candidate, cliPath: cli,
    token: 'synthetic-secret-token-value', environment: {}, receipt: async () => {}, fetcher: async (url, init) => {
      calls.push([init.method, new URL(url).pathname]); const path = new URL(url).pathname;
      if (path.endsWith(`/d1/database/${plan.sourceDatabase.id}`)) return json({ uuid: plan.sourceDatabase.id, name: 'renamed-source' });
      throw Error('must stop');
    } });
  await assert.rejects(transport.createQueue(), { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_DATABASE_IDENTITY_CHANGED' });
  assert.equal(calls.some(([, path]) => path.endsWith('/queues')), false);
});

test('staged operator re-proves containment before mutations and requires a separate release confirmation', async t => {
  const parent = await mkdtemp(join(temporaryRoot, 'bootstrap-operation-parent-')); await chmod(parent, 0o700);
  const directory = join(parent, 'operation');
  const candidate = join(directory, 'candidate'), events = []; let queueId = 'e'.repeat(32), source = null, catalog = null;
  const transport = { deploy: async mode => events.push(`deploy:${mode}`), createQueue: async () => (events.push('create-queue'), queueId),
    push: async (_id, body) => events.push(`push:${body.action}`), sourceStatus: async () => source,
    catalogStatus: async () => catalog, deleteWorker: async () => events.push('delete-worker'),
    deleteQueue: async () => events.push('delete-queue') };
  const contained = async () => events.push('contained'); const options = { plan, workerRoot: root, operationDirectory: directory,
    approvedPlanSha256: identityDigest(plan), transport, assertContained: contained,
    prepare: async ({ directory: path }) => { await mkdir(path, { mode: 0o700 });
      for (const name of ['bootstrap-worker.mjs', 'wrangler.disabled.jsonc', 'wrangler.enabled.jsonc', 'plan.json', 'preparation.json'])
        await writeFile(join(path, name), 'synthetic prepared file', { mode: 0o600 }); } };
  await runExistingAccountlessBootstrapOperator({ ...options, action: 'prepare' });
  const preparedFile = join(candidate, 'bootstrap-worker.mjs');
  const originalBytes = await readFile(preparedFile);
  await writeFile(preparedFile, 'tampered bundle', { mode: 0o600 });
  await assert.rejects(runExistingAccountlessBootstrapOperator({ ...options, action: 'apply',
    confirmation: 'ADVANCE_EXISTING_ACCOUNTLESS_BOOTSTRAP' }), { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_PACKAGE_CHANGED' });
  assert.deepEqual(events, []);
  await writeFile(preparedFile, originalBytes, { mode: 0o600 });
  await assert.rejects(runExistingAccountlessBootstrapOperator({ ...options, action: 'apply',
    confirmation: 'ADVANCE_EXISTING_ACCOUNTLESS_BOOTSTRAP', clock: () => plan.expiresAt }),
    { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_OPERATION_EXPIRED' });
  assert.deepEqual(events, []);
  assert.equal((await readOperation(directory)).state.intent, null);
  for (let i = 0; i < 4; i++) await runExistingAccountlessBootstrapOperator({ ...options, action: 'apply',
    confirmation: 'ADVANCE_EXISTING_ACCOUNTLESS_BOOTSTRAP' });
  await reconcileExistingAccountlessBootstrapOperator({ plan, operationDirectory: directory,
    transport: { ...transport, sourceStatus: async () => ({ operation_digest: identityDigest(plan), state: 'frozen', manifest_digest: null,
      owner_roster_digest: null }), catalogStatus: async () => null }, assertContained: contained });
  await assert.rejects(runExistingAccountlessBootstrapOperator({ ...options, action: 'release', confirmation: 'wrong' }),
    { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_CONFIRMATION_REQUIRED' });
  const runtime = existingAccountlessBootstrapRuntimePlan(plan);
  source = { operation_digest: runtime.operationDigest, state: 'ready', manifest_digest: 'f'.repeat(64),
    owner_roster_digest: '1'.repeat(64), revision: 4 };
  catalog = { state: 'ready', manifest_digest: source.manifest_digest, owner_roster_digest: source.owner_roster_digest };
  await reconcileExistingAccountlessBootstrapOperator({ plan, operationDirectory: directory, transport, assertContained: contained });
  await runExistingAccountlessBootstrapOperator({ ...options, action: 'release',
    confirmation: 'RELEASE_IMPORTED_ACCOUNTLESS_SOURCE_WRITES' });
  assert.deepEqual(events.slice(0, 10), ['contained', 'create-queue', 'contained', 'deploy:disabled', 'contained',
    'deploy:enabled', 'contained', 'push:freeze', 'contained', 'contained']);
  assert.equal(events.at(-1), 'push:release');
  await reconcileExistingAccountlessBootstrapOperator({ plan, operationDirectory: directory,
    transport: { ...transport, sourceStatus: async () => ({ ...source, state: 'released' }) }, assertContained: contained });
  for (let i = 0; i < 3; i++) await runExistingAccountlessBootstrapOperator({ ...options, action: 'cleanup',
    confirmation: 'CLEAN_UP_EXISTING_ACCOUNTLESS_BOOTSTRAP_OPERATOR' });
  const record = await readOperation(directory); assert.equal(record.state.phase, 'complete'); assert.equal(record.state.intent, null);
  assert.deepEqual(events.slice(-7), ['push:release', 'contained', 'deploy:disabled', 'contained', 'delete-worker',
    'contained', 'delete-queue', 'contained'].slice(-7));
  assert.equal(events.at(-1), 'contained');
});

test('plan separates bounded per-owner future headroom from the six/nine-gigabyte shard thresholds', () => {
  assert.throws(() => existingAccountlessBootstrapConfig({ ...plan, perOwnerFutureHeadroomBytes: 0 }, 'disabled'),
    { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_PLAN_INVALID' });
  assert.throws(() => existingAccountlessBootstrapConfig({ ...plan, newOwnerCutoffBytes: 6_000_000_001 }, 'disabled'),
    { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_PLAN_INVALID' });
  assert.throws(() => existingAccountlessBootstrapConfig({ ...plan, databaseBudgetBytes: 9_000_000_001 }, 'disabled'),
    { code: 'D1_STORAGE_EXISTING_BOOTSTRAP_PLAN_INVALID' });
});
