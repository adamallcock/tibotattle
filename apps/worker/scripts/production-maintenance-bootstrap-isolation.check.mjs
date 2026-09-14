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
const destinationId='77777777-7777-4777-8777-777777777777';
const bootstrap = { schema: 'storage-existing-accountless-bootstrap-isolation-v1', phase: 'enabled',
  operationDigest: '7'.repeat(64), workerName: 'tibotattle-existing-bootstrap-test',
  queueName: 'tibotattle-existing-bootstrap-queue-test', queueId, sourceDatabaseId: sourceId,
  catalogDatabaseId: catalogId, bundleSha256: '8'.repeat(64), disabledConfigSha256: '9'.repeat(64),
  enabledConfigSha256: 'a'.repeat(64) };
const movement={schema:'storage-owner-movement-isolation-v1',phase:'enabled',operationDigest:'c'.repeat(64),
  workerName:'tibotattle-owner-movement-test',queueName:'tibotattle-owner-movement-queue-test',queueId,
  catalogDatabaseId:catalogId,sourceDatabaseId:sourceId,destinationDatabaseId:destinationId,
  sourceBinding:'STORAGE_INGESTION_A',destinationBinding:'STORAGE_INGESTION_B',bundleSha256:'d'.repeat(64),
  disabledConfigSha256:'e'.repeat(64),enabledConfigSha256:'f'.repeat(64),workerVersionId:bootstrapVersion};

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
  const state = { phase: 'enabled', consumerAttached: true, rogue: false, wrongBinding: false, extraBinding: false, extraConsumer: false,
    wrongTag: false, wrongVersion:false, wrongRuntime:false, contradictoryAlias:false,
    consumerChange: null, movement:false, route:false, cron:false };
  const isolation=()=>state.movement?movement:bootstrap;
  const bootstrapMode = () => state.phase === 'enabled' ? 'enabled' : 'disabled';
  const isolatedBindings = () => state.movement?[{type:'d1',name:'STORAGE_ROUTING_DB',id:catalogId},
    {type:'d1',name:'STORAGE_INGESTION_A',id:state.wrongBinding?destinationId:sourceId},
    {type:'d1',name:'STORAGE_INGESTION_B',id:destinationId},
    {type:'plain_text',name:'STORAGE_OWNER_MOVEMENT_MODE',text:bootstrapMode()},
    {type:'plain_text',name:'STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST',text:movement.operationDigest},
    {type:'plain_text',name:'STORAGE_OWNER_MOVEMENT_BUNDLE_SHA256',text:movement.bundleSha256},
    ...(state.extraBinding?[{type:'plain_text',name:'EXTRA',text:'bad'}]:[])]:[{ type: 'd1', name: 'SOURCE', id: state.wrongBinding ? catalogId : sourceId },
    { type: 'd1', name: 'STORAGE_ROUTING_DB', id: catalogId },
    { type: 'plain_text', name: 'STORAGE_EXISTING_BOOTSTRAP_MODE', text: bootstrapMode() },
    { type: 'plain_text', name: 'STORAGE_EXISTING_BOOTSTRAP_OPERATION_DIGEST', text: bootstrap.operationDigest },
    { type: 'plain_text', name: 'STORAGE_EXISTING_BOOTSTRAP_BUNDLE_SHA256', text: bootstrap.bundleSha256 },
    ...(state.extraBinding ? [{ type: 'plain_text', name: 'EXTRA', text: 'bad' }] : [])];
  const returnedBindings=()=>isolatedBindings().map((binding,index)=>state.contradictoryAlias&&index===0
    ?{...binding,database_id:destinationId}:binding);
  const fetcher = async (url, options) => {
    if (!url.startsWith('https://api.cloudflare.com/')) return url.includes('/api/')
      ? new Response('{"error":{"code":"MAINTENANCE_ACTIVE"}}', { status: 503, headers: { 'retry-after': '300' } })
      : new Response('bytes');
    const parsed = new URL(url), path = parsed.pathname,
      isolated = path.includes(isolation().workerName) || parsed.searchParams.get('service') === isolation().workerName; let result;
    if (path.endsWith('/workers/scripts')) result = [{ id: main }, ...(['queue-only', 'gone'].includes(state.phase) ? [] : [{ id: isolation().workerName }]),
      ...(state.rogue ? [{ id: 'rogue-worker' }] : [])];
    else if (path.endsWith('/deployments')) result = { deployments: [{ versions: [{ version_id: isolated
      ?state.wrongVersion?'88888888-8888-4888-8888-888888888888':bootstrapVersion : maintenanceVersion, percentage: 100 }] }] };
    else if (path.includes('/versions/')) result = { id: path.split('/').at(-1), annotations: isolated
      ? { 'workers/tag': state.wrongTag ? 'wrong' : `${state.movement?'owner-movement':'existing-bootstrap'}-${bootstrapMode()}-${bootstrapMode() === 'enabled' ? isolation().enabledConfigSha256 : isolation().disabledConfigSha256}` }
      : { 'workers/tag': `maintenance-${operationId}` }, resources: { bindings: isolated ? returnedBindings() : mainBindings,
        ...(state.movement?{script_runtime:{compatibility_date:state.wrongRuntime?'2026-07-25':'2026-07-26',
          compatibility_flags:['nodejs_compat']}}:{}) } };
    else if (path.endsWith('/settings')) result = { bindings: isolated ? returnedBindings() : mainBindings };
    else if (path.endsWith('/subdomain')) result = { enabled: false, previews_enabled: false };
    else if (path.endsWith('/routes')) result = state.route?[{id:'unexpected'}]:[];
    else if (path.endsWith('/records')) result = isolated ? [] : ['synthetic.example', 'www.synthetic.example', 'admin.synthetic.example'].map(hostname => ({ hostname }));
    else if (path.endsWith('/namespaces')) result = [{ id: plan.predecessor.durableNamespaceId, class: 'UploadIngressBudget', script: main }];
    else if (path.endsWith('/queues')) result = state.phase === 'gone' ? [] : [{ queue_id: queueId, queue_name: isolation().queueName }];
    else if (path.endsWith('/consumers')) { const consumer = { script: isolation().workerName, type: 'worker',
      queue_name: isolation().queueName, queue_id: queueId, consumer_id: '6'.repeat(32),
      created_on: '2026-09-13T19:50:49.046911Z', settings: { batch_size: 1, max_retries: 0,
        max_wait_time_ms: 1000, max_concurrency: 1, retry_delay: 0 } };
      if(state.consumerChange)state.consumerChange(consumer);
      result = state.consumerAttached ? [consumer,...(state.extraConsumer ? [{ ...consumer,consumer_id:'7'.repeat(32),script:'rogue-worker' }] : [])] : []; }
    else if (path.endsWith('/schedules')) result = { schedules: state.cron?[{cron:'* * * * *'}]:[] };
    else throw Error(`unexpected ${path}`);
    return Response.json({ success: true, result });
  };
  const make = phase => createMaintenanceProvider({ plan, packageDirectory: root, operationDirectory: root,
    operationId, cliPath, fetcher, environment: { PATH: '/usr/bin', HOME: root, CLOUDFLARE_API_TOKEN: 'synthetic-token-value' },
    isolatedBootstrap: phase === null ? null : { ...bootstrap, phase } });
  const makeMovement=(phase,override={})=>{state.movement=true;return createMaintenanceProvider({plan,packageDirectory:root,
    operationDirectory:root,operationId,cliPath,fetcher,
    environment:{PATH:'/usr/bin',HOME:root,CLOUDFLARE_API_TOKEN:'synthetic-token-value'},
    isolatedMovement:phase===null?null:{...movement,workerVersionId:phase==='queue-only'?null:bootstrapVersion,...override,phase}});};
  return { state, make, verify: async (phase,consumerAttached=phase==='enabled') => {
    state.movement=false;state.phase = phase; state.consumerAttached = consumerAttached; await (await make(phase)).verifyContained(maintenanceVersion); },
    makeMovement,verifyMovement:async(phase,consumerAttached=phase==='enabled')=>{state.movement=true;state.phase=phase;
      state.consumerAttached=consumerAttached;await(await makeMovement(phase)).verifyContained(maintenanceVersion);} };
}

test('exact operation-bound queue-only, disabled and enabled bootstrap topology is admitted without changing baseline inventory', async t => {
  const f = await fixture(t); for (const phase of ['queue-only', 'disabled', 'enabled']) await f.verify(phase);
  await f.verify('disabled-before-detach',true);await f.verify('disabled-before-detach',false);
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
  for(const change of changes){f.state.consumerChange=change;
    await assert.rejects(f.verify('disabled-before-detach',true),{code:'PRODUCTION_MAINTENANCE_ISOLATION_CHANGED'});}
  f.state.consumerChange=null;await f.verify('enabled');
});

test('ordinary containment is restored only after the isolated Worker and Queue are gone', async t => {
  const f = await fixture(t); f.state.phase = 'queue-only';
  await assert.rejects((await f.make(null)).verifyContained(maintenanceVersion));
  f.state.phase = 'gone'; await (await f.make(null)).verifyContained(maintenanceVersion);
});

test('movement containment binds three exact databases, runtime tag and ingress-free single consumer',async t=>{
  const f=await fixture(t);for(const phase of ['queue-only','disabled','enabled'])await f.verifyMovement(phase);
  for(const key of ['wrongBinding','wrongTag','wrongVersion','wrongRuntime','contradictoryAlias','extraBinding','extraConsumer','route','cron']){
    f.state[key]=true;await assert.rejects(f.verifyMovement('enabled'),{code:'PRODUCTION_MAINTENANCE_ISOLATION_CHANGED'});
    f.state[key]=false;
  }
  await assert.rejects(createMaintenanceProvider({plan:{},isolatedMovement:{...movement,unknown:true}}),
    {code:'PRODUCTION_MAINTENANCE_ISOLATION_INVALID'});
});

test('movement containment refuses swapped destination and foreign source identity',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.makeMovement('enabled',{destinationDatabaseId:sourceId}),
    {code:'PRODUCTION_MAINTENANCE_ISOLATION_INVALID'});
  await assert.rejects(f.makeMovement('enabled',{sourceDatabaseId:destinationId}),
    {code:'PRODUCTION_MAINTENANCE_ISOLATION_INVALID'});
});
