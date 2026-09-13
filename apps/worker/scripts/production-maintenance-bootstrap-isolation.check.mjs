import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaintenanceProvider, maintenanceBindingDigest } from './production-maintenance-provider.mjs';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { maintenanceHash } from './production-maintenance.mjs';

const sourceId = '11111111-1111-4111-8111-111111111111', maintenanceVersion = '22222222-2222-4222-8222-222222222222';
const bootstrapVersion = '33333333-3333-4333-8333-333333333333', operationId = '44444444-4444-4444-8444-444444444444';
const queueId = '5'.repeat(32), catalogId = '66666666-6666-4666-8666-666666666666';
const bootstrap = { schema: 'storage-existing-accountless-bootstrap-isolation-v1', phase: 'enabled',
  operationDigest: '7'.repeat(64), workerName: 'tibotattle-existing-bootstrap-test',
  queueName: 'tibotattle-existing-bootstrap-queue-test', queueId, sourceDatabaseId: sourceId,
  catalogDatabaseId: catalogId, bundleSha256: '8'.repeat(64), disabledConfigSha256: '9'.repeat(64),
  enabledConfigSha256: 'a'.repeat(64) };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maintenance-isolation-')));
  await mkdir(join(root, 'wrangler-dist')); await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'wrangler',
    version: '4.114.0', main: 'wrangler-dist/cli.js' }));
  const cliPath = join(root, 'wrangler-dist/cli.js'); await writeFile(cliPath, '// synthetic pinned executable\n');
  await writeFile(join(root, 'wrangler.json'), '{}'); await writeFile(join(root, 'restore-triggers.json'), '{}');
  const main = 'synthetic-worker', oldBindings = [{ type: 'd1', name: 'DB', id: sourceId }];
  const plan = { schema: 'production-maintenance-v1', toolingCommit: 'b'.repeat(40), expiresAt: Date.now() + 3600000,
    accountId: 'c'.repeat(32), workerName: main, databaseId: sourceId, origin: 'https://synthetic.example',
    restoreSchemaDigest: 'd'.repeat(64), wranglerSha256: maintenanceHash(await readFile(cliPath)),
    predecessor: { sourceCommit: 'e'.repeat(40), versionId: sourceId, bindingDigest: maintenanceBindingDigest(oldBindings),
      inventoryDigest: identityDigest({ workers: [{ name: main }], queues: [] }), cron: ['* * * * *'],
      durableNamespaceId: 'f'.repeat(32), migrationTag: 'upload-ingress-budget-v1', secretBindings: [] },
    assets: Array.from({ length: 24 }, (_, index) => ({ path: index === 0 ? 'index.html'
      : index === 1 ? 'release-site-manifest.json' : `asset-${index}.js`, bytes: 5, sha256: maintenanceHash('bytes') })) };
  const mainBindings = [{ type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'MAINTENANCE_PLAN_DIGEST', text: identityDigest(plan) }];
  const state = { phase: 'enabled', rogue: false, wrongBinding: false, extraBinding: false, extraConsumer: false,
    wrongTag: false, consumerChange: null };
  const isolatedBindings = () => [{ type: 'd1', name: 'SOURCE', id: state.wrongBinding ? catalogId : sourceId },
    { type: 'd1', name: 'STORAGE_ROUTING_DB', id: catalogId },
    { type: 'plain_text', name: 'STORAGE_EXISTING_BOOTSTRAP_MODE', text: state.phase },
    { type: 'plain_text', name: 'STORAGE_EXISTING_BOOTSTRAP_OPERATION_DIGEST', text: bootstrap.operationDigest },
    { type: 'plain_text', name: 'STORAGE_EXISTING_BOOTSTRAP_BUNDLE_SHA256', text: bootstrap.bundleSha256 },
    ...(state.extraBinding ? [{ type: 'plain_text', name: 'EXTRA', text: 'bad' }] : [])];
  const fetcher = async (url, options) => {
    if (!url.startsWith('https://api.cloudflare.com/')) return url.includes('/api/')
      ? new Response('{"error":{"code":"MAINTENANCE_ACTIVE"}}', { status: 503, headers: { 'retry-after': '300' } })
      : new Response('bytes');
    const parsed = new URL(url), path = parsed.pathname,
      isolated = path.includes(bootstrap.workerName) || parsed.searchParams.get('service') === bootstrap.workerName; let result;
    if (path.endsWith('/workers/scripts')) result = [{ id: main }, ...(['queue-only', 'gone'].includes(state.phase) ? [] : [{ id: bootstrap.workerName }]),
      ...(state.rogue ? [{ id: 'rogue-worker' }] : [])];
    else if (path.endsWith('/deployments')) result = { deployments: [{ versions: [{ version_id: isolated ? bootstrapVersion : maintenanceVersion, percentage: 100 }] }] };
    else if (path.includes('/versions/')) result = { id: path.split('/').at(-1), annotations: isolated
      ? { 'workers/tag': state.wrongTag ? 'wrong' : `existing-bootstrap-${state.phase}-${state.phase === 'enabled' ? bootstrap.enabledConfigSha256 : bootstrap.disabledConfigSha256}` }
      : { 'workers/tag': `maintenance-${operationId}` }, resources: { bindings: isolated ? isolatedBindings() : mainBindings } };
    else if (path.endsWith('/settings')) result = { bindings: isolated ? isolatedBindings() : mainBindings };
    else if (path.endsWith('/subdomain')) result = { enabled: false, previews_enabled: false };
    else if (path.endsWith('/routes')) result = [];
    else if (path.endsWith('/records')) result = isolated ? [] : ['synthetic.example', 'www.synthetic.example', 'admin.synthetic.example'].map(hostname => ({ hostname }));
    else if (path.endsWith('/namespaces')) result = [{ id: plan.predecessor.durableNamespaceId, class: 'UploadIngressBudget', script: main }];
    else if (path.endsWith('/queues')) result = state.phase === 'gone' ? [] : [{ queue_id: queueId, queue_name: bootstrap.queueName }];
    else if (path.endsWith('/consumers')) { const consumer = { script: bootstrap.workerName, type: 'worker',
      queue_name: bootstrap.queueName, queue_id: queueId, consumer_id: '6'.repeat(32),
      created_on: '2026-09-13T19:50:49.046911Z', settings: { batch_size: 1, max_retries: 0,
        max_wait_time_ms: 1000, max_concurrency: 1, retry_delay: 0 } };
      if(state.consumerChange)state.consumerChange(consumer);
      result = state.phase === 'enabled' ? [consumer,...(state.extraConsumer ? [{ ...consumer,consumer_id:'7'.repeat(32),script:'rogue-worker' }] : [])] : []; }
    else if (path.endsWith('/schedules')) result = { schedules: [] };
    else throw Error(`unexpected ${path}`);
    return Response.json({ success: true, result });
  };
  const make = phase => createMaintenanceProvider({ plan, packageDirectory: root, operationDirectory: root,
    operationId, cliPath, fetcher, environment: { PATH: '/usr/bin', HOME: root, CLOUDFLARE_API_TOKEN: 'synthetic-token-value' },
    isolatedBootstrap: phase === null ? null : { ...bootstrap, phase } });
  return { state, make, verify: async phase => { state.phase = phase; await (await make(phase)).verifyContained(maintenanceVersion); } };
}

test('exact operation-bound queue-only, disabled and enabled bootstrap topology is admitted without changing baseline inventory', async t => {
  const f = await fixture(t); for (const phase of ['queue-only', 'disabled', 'enabled']) await f.verify(phase);
});

test('wrong source binding, config tag, extra binding, consumer or unrelated Worker all refuse containment', async t => {
  const f = await fixture(t);
  for (const key of ['wrongBinding', 'wrongTag', 'extraBinding', 'extraConsumer', 'rogue']) {
    f.state[key] = true; await assert.rejects(f.verify('enabled'), { code: key === 'rogue'
      ? 'PRODUCTION_MAINTENANCE_WRITER_INVENTORY_CHANGED' : 'PRODUCTION_MAINTENANCE_ISOLATION_CHANGED' }); f.state[key] = false;
  }
});

test('actual nested Queue consumer shape is exact and contradictory, missing or broadened values refuse',async t=>{
  const f=await fixture(t);
  const changes=[
    value=>{value.script='foreign-worker';},value=>{value.script_name=value.script;},value=>{delete value.script;},
    value=>{value.type='http_pull';},value=>{value.queue_name='foreign-queue';},value=>{value.queue_id='8'.repeat(32);},
    value=>{value.consumer_id='not-an-id';},value=>{value.created_on='not-an-instant';},
    value=>{value.settings.batch_size=2;},value=>{value.settings.max_retries=1;},
    value=>{value.settings.max_wait_time_ms=1001;},value=>{value.settings.max_concurrency=2;},
    value=>{value.settings.retry_delay=1;},value=>{value.settings.unreviewed=true;},
  ];
  for(const change of changes){f.state.consumerChange=change;
    await assert.rejects(f.verify('enabled'),{code:'PRODUCTION_MAINTENANCE_ISOLATION_CHANGED'});}
  f.state.consumerChange=null;await f.verify('enabled');
});

test('ordinary containment is restored only after the isolated Worker and Queue are gone', async t => {
  const f = await fixture(t); f.state.phase = 'queue-only';
  await assert.rejects((await f.make(null)).verifyContained(maintenanceVersion));
  f.state.phase = 'gone'; await (await f.make(null)).verifyContained(maintenanceVersion);
});
