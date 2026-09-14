import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { createStorageOwnerMovementWorker } from './storage-owner-movement-runtime.mjs';
import { runStorageOwnerMovementOperator, storageOwnerMovementConfig,
  validateStorageOwnerMovementOperatorPlan,prepareStorageOwnerMovementPackage,
  createStorageOwnerMovementTransport }
  from './storage-owner-movement-operator.mjs';

const ownerId = 'accountless:synthetic-owner';
const plan = { schema: 'storage-owner-movement-operator-v1', toolingCommit: '1'.repeat(40),sourceTree:'2'.repeat(40),
  workerLockSha256:createHash('sha256').update(await readFile(new URL('../package-lock.json',import.meta.url))).digest('hex'),
  dependencyDigest:'c'.repeat(64),runtimeBundleSha256:'d'.repeat(64),
  accountId: '2'.repeat(32), workerName: 'tibotattle-owner-move-test', queueName: 'tibotattle-owner-move-queue',
  moveId: 'move-one', ownerId,
  ownerDigest: createHash('sha256').update(`app-usagemonitor/storage-owner-movement-owner/v1\0${ownerId}`).digest('hex'),
  sourceRoute: { ownerId, shardId: 'a', bindingName: 'STORAGE_INGESTION_A', generation: 1, mode: 'catalog' },
  destinationShardId: 'b', sourceNamespace: 'origin-a',
  catalogDatabase: { id: '11111111-1111-4111-8111-111111111111', name: 'routing-test', bindingName: 'STORAGE_ROUTING_DB' },
  sourceDatabase: { id: '22222222-2222-4222-8222-222222222222', name: 'source-test', bindingName: 'STORAGE_INGESTION_A' },
  destinationDatabase: { id: '33333333-3333-4333-8333-333333333333', name: 'destination-test', bindingName: 'STORAGE_INGESTION_B' },
  sourceReadinessDigest: '4'.repeat(64), destinationReadinessDigest: '5'.repeat(64),
  destinationReservationBytes: 16_777_216, newOwnerCutoffBytes: 6_000_000_000,
  operatingBudgetBytes: 9_000_000_000, expiresAt: 100_000, wranglerSha256: '6'.repeat(64),
  qualification: { receiptPath: '/private/synthetic/receipt.json', receiptSha256: '7'.repeat(64) },
  maintenance: { planDigest: '8'.repeat(64), operationId: '44444444-4444-4444-8444-444444444444',
    versionId: '55555555-5555-4555-8555-555555555555', owner: '9'.repeat(40) },
  limits: { pageSize: 100, maxDeliveries: 32, deadlineMs: 20_000,
    maxOperationMs: 3_600_000, pauseTargetMs: 60_000 } };

async function fakePackage({ directory }) {
  await mkdir(directory, { mode: 0o700 });
  for (const name of ['movement-worker.mjs', 'wrangler.disabled.jsonc', 'wrangler.enabled.jsonc',
    'plan.json', 'preparation.json']) await writeFile(join(directory, name), `${name}\n`, { mode: 0o600 });
}
async function operationDirectory(prefix) {
  const directory = await mkdtemp(join('/private/tmp', prefix)); await chmod(directory, 0o700); return directory;
}

function status(state, overrides = {}) {
  const terminal=state==='committed';
  return { state,destinationGeneration:state==='absent'?null:2,
    reservationBytes:state==='absent'?null:plan.destinationReservationBytes,
    sourceNamespace:state==='absent'?null:'origin-a',precopyCursor: state === 'ready' ? 2 : 0, precopyHighWater: 2,
    finalHighWater: ['finalizing', 'verified', 'committed'].includes(state) ? 2 : null,
    materializedCursor: ['verified','committed'].includes(state)?2:0,
    verifyCursor: ['verified','committed'].includes(state)?2:0,
    verifyChainDigest: ['verified','committed'].includes(state)?'e'.repeat(64):null,
    authorityDigest: ['verified', 'committed'].includes(state) ? 'a'.repeat(64) : null,
    copyDigest: ['verified', 'committed'].includes(state) ? 'b'.repeat(64) : null,
    route: { shardId: state === 'committed' ? 'b' : 'a',
      bindingName: state === 'committed' ? 'STORAGE_INGESTION_B' : 'STORAGE_INGESTION_A',
      generation: state === 'committed' ? 2 : 1 },
    sourceFence: { shardId: 'a', generation: 1,
      state: ['finalizing', 'verified', 'committed'].includes(state) ? 'fenced' : 'active',
      moveId: ['finalizing', 'verified', 'committed'].includes(state) ? 'move-one' : null,copyDigest:null },
    destinationFence: state === 'committed' ? { shardId: 'b', generation: 2,
      state: 'active', moveId: 'move-one', copyDigest: 'b'.repeat(64) } : null,
    move:terminal?{moveId:'move-one',ownerId,sourceShardId:'a',destinationShardId:'b',sourceGeneration:1,
      destinationGeneration:2,reservationBytes:plan.destinationReservationBytes,state:'committed',copyDigest:'b'.repeat(64)}:null,
    authority:terminal?{ownerId,authorityDigest:'a'.repeat(64),state:'materialized'}:null,
    history:terminal?{ownerId,sourceNamespace:'origin-a',state:'complete',completedDigest:'f'.repeat(64)}:null,
    copyControl: state === 'absent' ? null : ['verified', 'committed', 'abandoned'].includes(state) ? 'closed' : 'open',
    stagedCount: state === 'absent' || state === 'abandoned' ? 0 : 2,stagedInvalidCount:0,
    stagedMaximum:state === 'absent' || state === 'abandoned'?0:2, ...overrides };
}

function fixture() {
  let current = status('absent'), queue = null, worker = 'absent', consumer=false, lose = null;
  const calls = [];
  const transport = {
    async assertAdmission(){calls.push('admission');},
    async findQueue() { return queue && { queue_id: queue, queue_name: plan.queueName }; },
    async findWorker() { return worker === 'deleted' || worker === 'absent' ? null : { id: plan.workerName }; },
    async createQueue() { calls.push('createQueue'); queue = 'a'.repeat(32); return queue; },
    async deploy(mode, dry) { calls.push(`deploy:${mode}:${dry}`); if (!dry){worker = mode;if(mode==='enabled')consumer=true;} },
    async inspectWorker(mode, allowOwnedConsumer = false) { if (worker !== mode) throw Error('wrong worker mode');
      if (mode === 'disabled' && consumer && !allowOwnedConsumer) throw Error('consumer remains');
      return mode === 'enabled' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'; },
    async status() { return structuredClone(current); },
    async push(_queue, body) { calls.push(`push:${body.action}`);
      if (body.action === 'prepare') current = status('copying');
      else if (body.action === 'copy') current = status('ready');
      else if (body.action === 'fence') current = status('finalizing');
      else if (body.action === 'resume') current = status(current.state === 'finalizing' ? 'verified' : 'committed');
      else current = status('abandoned');
      if (lose === body.action) { lose = null; throw Error('lost acknowledgement'); } },
    async disable() { calls.push('disable'); worker = 'disabled'; },
    async inspectDetached(){if(consumer)throw Error('consumer remains');},
    async detach() { calls.push('detach'); consumer=false; },
    async deleteWorker() { calls.push('deleteWorker'); worker = 'deleted'; },
    async deleteQueue() { calls.push('deleteQueue'); queue = null; },
  };
  return { transport, calls, setLose(value) { lose = value; },
    setStatus(value,overrides={}) { current = status(value,overrides); } };
}

async function invoke(directory, action, fixture, options = {}) {
  const confirmations = { apply: 'ADVANCE_ACCOUNTLESS_V11_OWNER_PRECOPY',
    finalize: 'FENCE_AND_SWITCH_ACCOUNTLESS_V11_OWNER', abort: 'ABORT_ACCOUNTLESS_V11_OWNER_PRECOPY',
    cleanup: 'CLEAN_UP_OWNER_MOVEMENT_OPERATOR' };
  return runStorageOwnerMovementOperator({ plan, workerRoot: '.', operationDirectory: directory, action,
    confirmation: confirmations[action] ?? null, approvedPlanSha256: identityDigest(plan),
    transport: fixture?.transport ?? null, assertContained: options.assertContained ?? (async () => {}), prepare: fakePackage,
    checkProvenance:async()=>{},clock: options.clock ?? (() => 2_000),
    monotonicClock:options.monotonicClock??options.clock??(()=>2_000) });
}

test('validates closed resource identity and produces no-ingress max-one configs', () => {
  assert.deepEqual(validateStorageOwnerMovementOperatorPlan(plan), plan);
  const enabled = storageOwnerMovementConfig(plan, 'enabled');
  assert.equal(enabled.workers_dev, false); assert.deepEqual(enabled.routes, []);
  assert.deepEqual(enabled.triggers.crons, []); assert.equal(enabled.queues.consumers[0].max_concurrency, 1);
  assert.equal(enabled.queues.consumers[0].max_retries, 0);
  for (const changed of [{ ...plan, extra: true }, { ...plan, destinationDatabase: plan.sourceDatabase },
    { ...plan, ownerDigest: '0'.repeat(64) }, { ...plan, sourceReadinessDigest: null }])
    assert.throws(() => validateStorageOwnerMovementOperatorPlan(changed), /PLAN_INVALID/);
});

test('private runtime accepts one exact message and calls one canonical primitive', async () => {
  const calls = [], mover = Object.fromEntries(['prepare', 'copyPage', 'fenceSource', 'resumeFinalization', 'rollbackPage']
    .map(name => [name, async (...args) => calls.push([name, ...args])]));
  const runtimePlan = { schema: 'storage-owner-movement-runtime-v1', operationDigest: 'a'.repeat(64),
    moveId: 'move-one', ownerDigest: 'b'.repeat(64), sourceRoute: plan.sourceRoute,
    destinationShardId: 'b', sourceNamespace: 'origin-a', catalogBinding: 'STORAGE_ROUTING_DB',
    sourceBinding: 'STORAGE_INGESTION_A', destinationBinding: 'STORAGE_INGESTION_B', pageSize: 100, expiresAt: 9_000 };
  const worker = createStorageOwnerMovementWorker({ createMovement: () => mover, plan: runtimePlan, clock: () => 2_000 });
  const db = { prepare() {}, batch() {} }, env = { STORAGE_OWNER_MOVEMENT_MODE: 'enabled',
    STORAGE_OWNER_MOVEMENT_OPERATION_DIGEST: runtimePlan.operationDigest,
    STORAGE_ROUTING_DB: db, STORAGE_INGESTION_A: { ...db }, STORAGE_INGESTION_B: { ...db } };
  let acked = false;
  await worker.queue({ messages: [{ body: { schema: 'storage-owner-movement-wakeup-v1',
    operationDigest: runtimePlan.operationDigest, action: 'copy', sequence: 1 }, ack() { acked = true; } }] }, env);
  assert.deepEqual(calls, [['copyPage', 'move-one', 100]]); assert.equal(acked, true);
  await assert.rejects(worker.queue({ messages: [{ body: { schema: 'storage-owner-movement-wakeup-v1',
    operationDigest: runtimePlan.operationDigest, action: 'copy', sequence: 2, extra: true }, ack() {} }] }, env), /MESSAGE_INVALID/);
  assert.equal((await worker.fetch()).status, 404);
});

test('prepares the canonical bundled runtime from an exact qualification receipt',async()=>{
  const root=await operationDirectory('owner-movement-package-'),receiptPath=join(root,'qualification.json');
  const receipt={schema:'owner-movement-local-qualification-completion-v1',sourceCommit:plan.toolingCommit,sourceTreeSha256:plan.sourceTree,
    sourceClean:true,priorOwningGate:{exitCode:0,testFiles:130,tests:1557},allFourWorkerDryBuildsPassed:true,
    completionChecks:[{exitCode:0},{exitCode:0},{exitCode:0},{exitCode:0}]};
  const bytes=Buffer.from(JSON.stringify(receipt));await writeFile(receiptPath,bytes,{mode:0o600});
  const qualified={...plan,qualification:{receiptPath,receiptSha256:createHash('sha256').update(bytes).digest('hex')}};
  const output=join(root,'candidate'),prepared=await prepareStorageOwnerMovementPackage({workerRoot:process.cwd(),
    directory:output,plan:qualified,checkSource:async()=>{},checkProvenance:async()=>{}});
  assert.equal(prepared.remoteOperations,false);assert.equal(prepared.queueMaxConcurrency,1);
  assert.equal(prepared.queueMaxRetries,0);assert.equal(prepared.bundleSha256,
    createHash('sha256').update(await readFile(join(output,'movement-worker.mjs'))).digest('hex'));
  const config=JSON.parse(await readFile(join(output,'wrangler.enabled.jsonc'),'utf8'));
  assert.equal(config.d1_databases.length,3);assert.equal(config.routes.length,0);
  assert.equal(config.queues.consumers[0].max_batch_size,1);
});

test('concrete Cloudflare transport verifies the active module, version, bindings and Queue consumer',async()=>{
  const root=await operationDirectory('owner-movement-transport-'),candidate=join(root,'candidate');await mkdir(candidate,{mode:0o700});
  const cliPath=resolve('node_modules/wrangler/wrangler-dist/cli.js'),bundle=Buffer.from('export default{}');
  const live={...plan,wranglerSha256:createHash('sha256').update(await readFile(cliPath)).digest('hex')};
  const bundleSha256=createHash('sha256').update(bundle).digest('hex'),enabled=storageOwnerMovementConfig(live,'enabled',bundleSha256);
  const configBytes=Buffer.from(JSON.stringify(enabled)),configSha256=createHash('sha256').update(configBytes).digest('hex');
  await writeFile(join(candidate,'movement-worker.mjs'),bundle,{mode:0o600});
  await writeFile(join(candidate,'wrangler.enabled.jsonc'),configBytes,{mode:0o600});
  await writeFile(join(candidate,'wrangler.disabled.jsonc'),JSON.stringify(storageOwnerMovementConfig(live,'disabled',bundleSha256)),{mode:0o600});
  await writeFile(join(candidate,'preparation.json'),JSON.stringify({bundleSha256}),{mode:0o600});
  const versionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',queueId='b'.repeat(32);
  const bindings=[...enabled.d1_databases.map(row=>({type:'d1',name:row.binding,id:row.database_id})),
    ...Object.entries(enabled.vars).map(([name,text])=>({type:'plain_text',name,text}))];
  let extraModule=false,consumerPresent=true,wrongRuntime=false,contradictoryAlias=false,loseDelete=false,deleteCalls=0;
  const admissionRequests=[];
  const currentBindings=()=>bindings.map((binding,index)=>contradictoryAlias&&index===0
    ?{...binding,database_id:live.destinationDatabase.id}:binding);
  const response=result=>Response.json({success:true,result});
  const fetcher=async(url,options={})=>{const path=new URL(url).pathname;
    if(path.includes('/d1/database/')&&path.endsWith('/query')){const request=JSON.parse(options.body);admissionRequests.push(request);
      return response([{success:true,results:[{n:1}],meta:{}}]);}
    for(const database of [live.catalogDatabase,live.sourceDatabase,live.destinationDatabase])
      if(path.endsWith(`/d1/database/${database.id}`))return response({uuid:database.id,name:database.name});
    if(path.endsWith('/content/v2')){const form=new FormData();form.append('movement-worker.mjs',new File([bundle],'movement-worker.mjs'));
      if(extraModule)form.append('foreign.mjs',new File(['export{}'],'foreign.mjs'));const result=new Response(form);
      result.headers.set('cf-entrypoint','movement-worker.mjs');return result;}
    if(path.endsWith('/deployments'))return response({deployments:[{versions:[{version_id:versionId,percentage:100}]}]});
    if(path.endsWith(`/versions/${versionId}`))return response({id:versionId,
      annotations:{'workers/tag':`owner-movement-enabled-${configSha256}`},resources:{bindings:currentBindings(),
        script_runtime:{compatibility_date:wrongRuntime?'2026-07-25':'2026-07-26',compatibility_flags:['nodejs_compat']}}});
    if(path.endsWith('/settings'))return response({bindings:currentBindings()});
    if(path.endsWith('/subdomain'))return response({enabled:false,previews_enabled:false});
    if(path.endsWith('/routes'))return response([]);if(path.endsWith('/schedules'))return response({schedules:[]});
    if(path.endsWith('/queues'))return response({queues:[{queue_id:queueId,queue_name:live.queueName}]});
    if(path.endsWith(`/queues/${queueId}`))return response({queue_id:queueId,queue_name:live.queueName});
    if(options.method==='DELETE'&&path.endsWith(`/${'c'.repeat(32)}`)){deleteCalls++;consumerPresent=false;
      if(loseDelete){loseDelete=false;throw Error('lost deletion acknowledgement');}return response(null);}
    if(path.endsWith('/consumers'))return response(consumerPresent?[{script:live.workerName,type:'worker',queue_name:live.queueName,
      queue_id:queueId,consumer_id:'c'.repeat(32),created_on:'2026-09-14T00:00:00.000Z',
      settings:{batch_size:1,max_retries:0,max_wait_time_ms:1000,max_concurrency:1,retry_delay:0}}]:[]);
    throw Error(`unexpected ${path}`);};
  const spawnOptions=[];const transport=createStorageOwnerMovementTransport({plan:live,packageDirectory:candidate,operationDirectory:root,
    cliPath,fetcher,spawn:(_command,_args,options)=>{spawnOptions.push(options);return {status:0,signal:null,stdout:'',stderr:''};},
    environment:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,
      CLOUDFLARE_API_TOKEN:'synthetic-token-value'}});
  await transport.assertAdmission();const sourceAdmission=admissionRequests.find(request=>request.sql.includes('route.reservation_bytes=?'));
  assert.equal(sourceAdmission.params[3],live.destinationReservationBytes);
  assert.equal(await transport.inspectWorker('enabled'),versionId);
  await transport.deploy('enabled',false);assert.equal(spawnOptions[0].timeout,live.limits.deadlineMs);
  contradictoryAlias=true;await assert.rejects(transport.inspectWorker('enabled'),/WORKER_CHANGED/);contradictoryAlias=false;
  wrongRuntime=true;await assert.rejects(transport.inspectWorker('enabled'),/WORKER_CHANGED/);wrongRuntime=false;
  loseDelete=true;await assert.rejects(transport.detach(queueId),/MUTATION_UNCERTAIN/);
  assert.equal(deleteCalls,1);assert.equal(await transport.inspectDetached(queueId),true);
  consumerPresent=true;await transport.detach(queueId);assert.equal(deleteCalls,2);
  assert.equal(consumerPresent,false);consumerPresent=true;extraModule=true;
  await assert.rejects(transport.inspectWorker('enabled'),/WORKER_CHANGED/);
});

test('operator executes bounded pre-copy, explicit fence, forward recovery and exact cleanup', async () => {
  const directory = await operationDirectory('owner-movement-'); const f = fixture(); let now = 2_000;
  await invoke(directory, 'prepare', null); await invoke(directory, 'dry-run', f);
  await invoke(directory, 'apply', f); await invoke(directory, 'apply', f); await invoke(directory, 'apply', f);
  await invoke(directory, 'apply', f); const ready = await invoke(directory, 'apply', f);
  assert.equal(ready.moveState, 'ready');
  await invoke(directory, 'finalize', f, { clock: () => now }); now += 10_000;
  await invoke(directory, 'finalize', f, { clock: () => now }); now += 10_000;
  await invoke(directory, 'finalize', f, { clock: () => now });
  const committed = await invoke(directory, 'finalize', f, { clock: () => now });
  assert.equal(committed.moveState, 'committed'); assert.equal(committed.pause.passed, true);
  for (let step = 0; step < 5; step++) await invoke(directory, 'cleanup', f, { clock: () => now });
  const contained=[];const completed=await invoke(directory,'cleanup',f,{clock:()=>now,
    assertContained:async context=>contained.push(context.phase)});assert.equal(completed.code,'OWNER_MOVEMENT_COMPLETE');
  assert.deepEqual(contained,['complete']);
  assert.deepEqual(f.calls.filter(value => value.startsWith('push:')),
    ['push:prepare', 'push:copy', 'push:fence', 'push:resume', 'push:resume']);
  assert.deepEqual(f.calls.slice(-4), ['disable', 'detach', 'deleteWorker', 'deleteQueue']);
});

test('lost movement acknowledgement reconciles exact durable progress without a second send', async () => {
  const directory = await operationDirectory('owner-movement-lost-'); const f = fixture();
  await invoke(directory, 'prepare', null); await invoke(directory, 'apply', f); await invoke(directory, 'apply', f);
  await invoke(directory, 'apply', f); f.setLose('prepare');
  await assert.rejects(invoke(directory, 'apply', f), /RECONCILIATION_REQUIRED/);
  assert.equal(f.calls.filter(value => value === 'push:prepare').length, 1);
  const reconciled = await invoke(directory, 'reconcile', f);
  assert.equal(reconciled.moveState, 'copying'); assert.equal(f.calls.filter(value => value === 'push:prepare').length, 1);
});

test('lost disable acknowledgement reconciles before detaching the retained owned consumer', async () => {
  const directory = await operationDirectory('owner-movement-disable-lost-'), f = fixture();
  await invoke(directory, 'prepare', null);
  for (let step = 0; step < 3; step++) await invoke(directory, 'apply', f);
  f.setStatus('committed');
  const disable = f.transport.disable.bind(f.transport);
  f.transport.disable = async () => { await disable(); throw Error('lost disable acknowledgement'); };
  await assert.rejects(invoke(directory, 'cleanup', f), /RECONCILIATION_REQUIRED/);
  const reconciled = await invoke(directory, 'reconcile', f);
  assert.equal(reconciled.phase, 'worker-disabled');
  await invoke(directory, 'cleanup', f);
  assert.deepEqual(f.calls.slice(-2), ['disable', 'detach']);
  assert.equal(f.calls.filter(value => value === 'disable').length, 1);
});

test('lost queue creation acknowledgement reconciles the one exact resource without recreating it',async()=>{
  const directory=await operationDirectory('owner-movement-resource-lost-'),f=fixture();
  await invoke(directory,'prepare',null);const create=f.transport.createQueue.bind(f.transport);let calls=0;
  f.transport.createQueue=async()=>{calls++;const queue=await create();throw Object.assign(Error('lost queue acknowledgement'),{queue});};
  await assert.rejects(invoke(directory,'apply',f),/RECONCILIATION_REQUIRED/);assert.equal(calls,1);
  const reconciled=await invoke(directory,'reconcile',f);assert.equal(reconciled.phase,'queue-created');
  f.transport.createQueue=create;await invoke(directory,'apply',f);assert.equal(calls,1);
});

test('no-effect unknown send remains contained and never permits a second command', async () => {
  const directory = await operationDirectory('owner-movement-pending-'); const f = fixture();
  await invoke(directory, 'prepare', null); await invoke(directory, 'apply', f); await invoke(directory, 'apply', f);
  await invoke(directory, 'apply', f);
  const original = f.transport.push;let attempts=0;f.transport.push = async () => { attempts++;throw Error('unknown before delivery'); };
  await assert.rejects(invoke(directory, 'apply', f), /RECONCILIATION_REQUIRED/);
  const disabling=await invoke(directory,'reconcile',f);assert.equal(disabling.code,'OWNER_MOVEMENT_CONTAINMENT_PROGRESS');
  await assert.rejects(invoke(directory,'reconcile',f),/RECONCILIATION_REQUIRED/);
  await assert.rejects(invoke(directory,'reconcile',f),/RECONCILIATION_REQUIRED/);
  await assert.rejects(invoke(directory,'apply',f),/RECONCILIATION_REQUIRED/);
  assert.equal(attempts,1);assert.deepEqual(f.calls.slice(-2),['disable','detach']);
  f.setStatus('copying');const reconciled=await invoke(directory,'reconcile',f);
  assert.equal(reconciled.moveState,'copying');f.transport.push=original;
  await invoke(directory,'apply',f);await invoke(directory,'apply',f);
  assert.equal(f.calls.filter(value=>value==='push:prepare').length,0);
});

test('pre-fence abort converges without starting the final pause', async () => {
  const directory = await operationDirectory('owner-movement-abort-'); const f = fixture();
  await invoke(directory, 'prepare', null); await invoke(directory, 'apply', f); await invoke(directory, 'apply', f);
  await invoke(directory, 'apply', f); await invoke(directory, 'apply', f);
  const result = await invoke(directory, 'abort', f);
  assert.equal(result.moveState, 'abandoned'); assert.equal(result.pause, null);
  await assert.rejects(invoke(directory, 'finalize', f), /FINALIZE_NOT_READY/);
});

test('terminal cleanup refuses incomplete fences, journals or copied evidence',async()=>{
  const directory=await operationDirectory('owner-movement-terminal-'),f=fixture();
  await invoke(directory,'prepare',null);for(let i=0;i<3;i++)await invoke(directory,'apply',f);
  await invoke(directory,'apply',f);await invoke(directory,'apply',f);
  for(let i=0;i<3;i++)await invoke(directory,'finalize',f);
  f.setStatus('committed',{copyControl:'open'});
  await assert.rejects(invoke(directory,'cleanup',f),/TERMINAL_UNVERIFIED/);
  assert.equal(f.calls.includes('disable'),false);
});

test('final pause uses a monotonic clock even when wall time moves backwards',async()=>{
  const directory=await operationDirectory('owner-movement-monotonic-'),f=fixture();let wall=10_000,mono=50_000;
  const options=()=>({clock:()=>wall,monotonicClock:()=>mono});
  await invoke(directory,'prepare',null);for(let i=0;i<3;i++)await invoke(directory,'apply',f);
  await invoke(directory,'apply',f);await invoke(directory,'apply',f);
  await invoke(directory,'finalize',f,options());wall=5_000;mono+=1_000;
  await invoke(directory,'finalize',f,options());mono+=1_000;
  const committed=await invoke(directory,'finalize',f,options());
  assert.equal(committed.pause.elapsedMs,2_000);assert.equal(committed.pause.passed,true);
});

test('execution rechecks qualified dependency and runtime provenance',async()=>{
  const directory=await operationDirectory('owner-movement-provenance-'),f=fixture();
  await invoke(directory,'prepare',null);
  await assert.rejects(runStorageOwnerMovementOperator({plan,workerRoot:'.',operationDirectory:directory,
    action:'apply',confirmation:'ADVANCE_ACCOUNTLESS_V11_OWNER_PRECOPY',approvedPlanSha256:identityDigest(plan),
    transport:f.transport,assertContained:async()=>{},prepare:fakePackage,
    checkProvenance:async()=>{throw Error('D1_STORAGE_OWNER_MOVEMENT_PROVENANCE_CHANGED')},clock:()=>2_000}),
  /PROVENANCE_CHANGED/);
  assert.deepEqual(f.calls,[]);
});
