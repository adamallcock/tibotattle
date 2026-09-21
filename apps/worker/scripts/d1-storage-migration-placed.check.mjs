// Native transport/driver tests use bounded synthetic APIs; populated restoration
// is separately exercised by d1-storage-restore.mjs --transport placed.
import test from 'node:test';import assert from 'node:assert/strict';import {Miniflare} from 'miniflare';import {build} from 'esbuild';import {createHash} from 'node:crypto';
import {createStorageMigrationFront} from './d1-storage-migration-placed.mjs';
import {SYNTHETIC_D1_WORKER,syntheticD1Binding,closeSyntheticD1Bindings} from './d1-storage-local-d1.mjs';
const contract={targetBaseSchemaDigest:'synthetic-base'},contractDigest=createHash('sha256').update(JSON.stringify(contract)).digest('hex'),expiresAt=Date.now()+600_000;
const wake=(steps=0,stage='freeze-source')=>({schema:'d1-storage-restore-wakeup-v1',contractDigest,stage,steps});
async function bundle(code){return (await build({stdin:{contents:code,resolveDir:import.meta.dirname,loader:'js'},bundle:true,write:false,format:'esm',platform:'browser',logLevel:'silent'})).outputFiles[0].text;}
async function fixture(t,{fault='none',nativeQueue=false,backendExpiresAt=expiresAt}={}){
 const backend=await bundle(`import {createStorageMigrationBackend} from './d1-storage-migration-placed.mjs';
 const api={authorityRestoreContractDigest:async()=>${JSON.stringify(contractDigest)},authoritySchemaInventory:async()=>[],authoritySchemaDigest:async()=>'synthetic-base'};
 const record=(name,result)=>async(db)=>{await db.prepare('INSERT INTO synthetic_calls(name) VALUES(?)').bind(name).run();if(${JSON.stringify(fault)}==='before-commit'&&name==='freezeAuthorityRestoreSource')throw Error('synthetic unknown write');return result;};
 for(const name of ['freezeAuthorityRestoreSource','beginAuthorityRestore','sealAuthorityRestore','completeAuthorityVerification','promoteAuthorityRestore','finalizeAuthorityRestore','initializeAuthorityRestoreBootstrap'])api[name]=record(name,{});
 api.copyAuthorityPage=record('copyAuthorityPage',{state:'complete'});api.copyAuthorityTypedPage=record('copyAuthorityTypedPage',{reachedEnd:true});api.verifyAuthorityTypedPage=record('verifyAuthorityTypedPage',{reachedEnd:true});api.adoptAuthorityTypedPage=record('adoptAuthorityTypedPage',{done:true});api.bootstrapAuthorityRestorePage=record('bootstrapAuthorityRestorePage',{completed:true});
 const backend=createStorageMigrationBackend({api,executionDigest:${JSON.stringify(contractDigest)},contract:${JSON.stringify(contract)},contractDigest:${JSON.stringify(contractDigest)},expiresAt:${backendExpiresAt},frozenSource:true});let lost=false;
 export default {async fetch(request,env){const input=await request.clone().json().catch(()=>null);const response=await backend.fetch(request,env);
 if(${JSON.stringify(fault)}==='after-commit'&&!lost&&input?.operation==='step'&&input.message.steps===0&&response.status===200){lost=true;return new Response('synthetic lost response',{status:503});}return response;}};`);
 const front=await bundle(`import {createStorageMigrationFront} from './d1-storage-migration-placed.mjs';export default createStorageMigrationFront({executionDigest:${JSON.stringify(contractDigest)},contractDigest:${JSON.stringify(contractDigest)},expiresAt:${expiresAt}});`);
 const mf=new Miniflare({host:'127.0.0.1',cf:false,workers:[
  {name:'inspector',modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:{SOURCE:'source',TARGET:'target'}},
  {name:'backend',modules:true,script:backend,compatibilityDate:'2026-07-26',bindings:{STORAGE_RESTORE_MODE:'enabled'},d1Databases:{SOURCE:'source',TARGET:'target'}},
  {name:'relay',modules:true,script:'export default {fetch(request,env){return env.EXEC.fetch(request);}}',compatibilityDate:'2026-07-26',serviceBindings:{EXEC:'backend'}},
  {name:'front',modules:true,script:front,compatibilityDate:'2026-07-26',bindings:{STORAGE_RESTORE_MODE:'enabled'},serviceBindings:{STORAGE_RESTORE_EXECUTOR:'backend'},queueProducers:{STORAGE_RESTORE_QUEUE:'restore'},...(nativeQueue?{queueConsumers:{restore:{maxBatchSize:1,maxBatchTimeout:0,maxRetries:0}}}:{})},
 ]});
 t.after(async()=>{await closeSyntheticD1Bindings(mf);await mf.dispose();});
 const source=syntheticD1Binding(mf,'SOURCE'),target=syntheticD1Binding(mf,'TARGET');await source.prepare('CREATE TABLE synthetic_calls(name TEXT NOT NULL)').run();await target.prepare('CREATE TABLE synthetic_calls(name TEXT NOT NULL)').run();
 const relay=await mf.getWorker('relay'),pending=[];let acks=0;
 const driver=createStorageMigrationFront({executionDigest:contractDigest,contractDigest,expiresAt});const env={STORAGE_RESTORE_MODE:'enabled',STORAGE_RESTORE_EXECUTOR:{fetch:async request=>relay.fetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()})},STORAGE_RESTORE_QUEUE:{send:async next=>pending.push(next)}};
 const deliver=body=>driver.queue({messages:[{body,ack(){acks++;}}]},env);
 return {mf,source,target,relay,driver,env,pending,acks:()=>acks,deliver};
}
test('actual native Queue to private ServiceBinding.fetch runs the unchanged 19-stage frame',async t=>{
 const f=await fixture(t,{nativeQueue:true});const producer=await f.mf.getQueueProducer('STORAGE_RESTORE_QUEUE','front');await producer.send(wake());
 const deadline=Date.now()+15000;let state;
 while(Date.now()<deadline){try{state=await f.target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first();}catch{}if(state?.stage===null)break;await new Promise(r=>setTimeout(r,20));}
 assert.deepEqual(state,{stage:null,steps:19,intent:null});
 assert.equal(await f.source.prepare("SELECT count(*) n FROM synthetic_calls WHERE name='freezeAuthorityRestoreSource'").first('n'),1);
 assert.equal((await(await f.mf.getWorker('front')).fetch('https://private.invalid/private/restore')).status,404);
 assert.equal((await f.relay.fetch('https://private.invalid/unknown')).status,404);
});
test('response lost after committed backend step is not acknowledged; Cron resumes the next step exactly',async t=>{
 const f=await fixture(t,{fault:'after-commit'});await f.driver.scheduled({},f.env);assert.deepEqual(f.pending.shift(),wake());
 await assert.rejects(f.deliver(wake()),/PRIVATE_EXECUTION_UNCERTAIN/);assert.equal(f.acks(),0);assert.equal(f.pending.length,0);
 assert.deepEqual(await f.target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first(),{stage:'begin',steps:1,intent:null});
 await f.deliver(wake());assert.equal(f.acks(),1);assert.equal(f.pending.length,0);
 await f.driver.scheduled({},f.env);assert.deepEqual(f.pending.shift(),wake(1,'begin'));
 await f.deliver(wake(1,'begin'));assert.equal(f.acks(),2);assert.deepEqual(f.pending.shift(),wake(2,'copy-authority'));
 assert.equal(await f.source.prepare("SELECT count(*) n FROM synthetic_calls WHERE name='freezeAuthorityRestoreSource'").first('n'),1);
});
test('unknown page effect leaves the backend durable intent and blocks duplicate Queue and Cron work',async t=>{
 const f=await fixture(t,{fault:'before-commit'});await f.driver.scheduled({},f.env);f.pending.shift();
 await assert.rejects(f.deliver(wake()),/PRIVATE_EXECUTION_UNCERTAIN/);await assert.rejects(f.deliver(wake()),/PRIVATE_EXECUTION_UNCERTAIN/);await assert.rejects(f.driver.scheduled({},f.env),/PRIVATE_EXECUTION_UNCERTAIN/);
 assert.deepEqual(await f.target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first(),{stage:'freeze-source',steps:0,intent:'freeze-source'});
 assert.equal(await f.source.prepare('SELECT count(*) n FROM synthetic_calls').first('n'),1);assert.equal(f.acks(),0);assert.equal(f.pending.length,0);
});
test('wrong, future, malformed and expired requests do not execute or acknowledge',async t=>{
 const f=await fixture(t);await f.driver.scheduled({},f.env);f.pending.shift();
 for(const invalid of [{...wake(),contractDigest:'0'.repeat(64)},wake(1),{...wake(),extra:true}])await assert.rejects(f.deliver(invalid),/PRIVATE_EXECUTION_UNCERTAIN/);
 const expired=createStorageMigrationFront({executionDigest:contractDigest,contractDigest,expiresAt:1});await assert.rejects(expired.queue({messages:[{body:wake(),ack(){throw Error('must not ack');}}]},f.env),/PRIVATE_EXECUTION_UNCERTAIN/);
 assert.equal(await f.source.prepare('SELECT count(*) n FROM synthetic_calls').first('n'),0);assert.equal(f.acks(),0);
 const response=await f.relay.fetch('https://private.invalid/private/restore',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(2049)});assert.equal(response.status,503);
});
test('malformed success cannot cause a front Queue send or acknowledgement',async t=>{
 const f=await fixture(t);f.env.STORAGE_RESTORE_EXECUTOR={fetch:async()=>Response.json({schema:'forged',next:wake(1,'begin')})};
 await assert.rejects(f.deliver(wake()),/PRIVATE_EXECUTION_UNCERTAIN/);assert.equal(f.acks(),0);assert.equal(f.pending.length,0);
});

test('backend independently refuses expired execution even while the front deadline remains valid',async t=>{
 const f=await fixture(t,{backendExpiresAt:1});await assert.rejects(f.driver.scheduled({},f.env),/PRIVATE_EXECUTION_UNCERTAIN/);
 assert.equal(await f.source.prepare('SELECT count(*) n FROM synthetic_calls').first('n'),0);
 assert.equal(await f.target.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_authority_operator_progress'").first('n'),0);
 assert.equal(f.pending.length,0);assert.equal(f.acks(),0);
});
test('concurrent private fetches share the original durable claim and cannot execute a page twice',async t=>{
 const f=await fixture(t);await f.driver.scheduled({},f.env);f.pending.shift();
 const result=await Promise.allSettled([f.deliver(wake()),f.deliver(wake())]);assert.ok(result.some(x=>x.status==='fulfilled'));
 assert.equal(await f.source.prepare("SELECT count(*) n FROM synthetic_calls WHERE name='freezeAuthorityRestoreSource'").first('n'),1);
 assert.deepEqual(await f.target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first(),{stage:'begin',steps:1,intent:null});
 assert.deepEqual(f.pending,[wake(1,'begin')]);
});

test('placed package pins both bundles and exact disabled topology to its actual source',async t=>{
 const {mkdtemp,writeFile,readFile,rm,realpath}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join,resolve}=await import('node:path');
 const {identityDigest}=await import('../../../scripts/lib/release-operation.mjs');
 const {prepareStorageMigrationWorker,validatePlacedMigrationTopology}=await import('./d1-storage-migration-package.mjs');
 const directory=await realpath(await mkdtemp(join(tmpdir(),'storage-placed-package-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const workerRoot=resolve(import.meta.dirname,'..'),schema=[];
 const fixed={version:'authority-restore-v1',sourceId:'synthetic',sourceNamespace:'synthetic',runId:'synthetic',
  sourceSchema:schema,sourceSchemaDigest:identityDigest(schema),targetBaseSchema:schema,targetBaseSchemaDigest:identityDigest(schema),finalSchema:schema,finalSchemaDigest:identityDigest(schema)};
 const topology={schema:'d1-storage-placed-topology-v1',frontName:'synthetic-front',backendName:'synthetic-backend',queueName:'synthetic-queue',queueId:'a'.repeat(32),
  source:{name:'synthetic-source',id:'11111111-1111-4111-8111-111111111111'},target:{name:'tibotattle-staging-ingestion-22222222-2222-4222-8222-222222222222',id:'22222222-2222-4222-8222-222222222222'},region:'gcp:us-east4'};
 const contractPath=join(directory,'contract.json'),placedTopologyPath=join(directory,'topology.json');
 await writeFile(contractPath,JSON.stringify(fixed),{mode:0o600});await writeFile(placedTopologyPath,JSON.stringify(topology),{mode:0o600});
 const options={workerRoot,contractPath,contractDigest:identityDigest(fixed),directory:join(directory,'package'),expiresAt:new Date(Date.now()+600000).toISOString(),allowUnfrozen:true,placedTopologyPath,placedTopologyDigest:identityDigest(topology)};
 const result=await prepareStorageMigrationWorker(options),json=async name=>JSON.parse(await readFile(join(options.directory,name),'utf8'));
 const prep=await json('preparation.json'),front=await json('wrangler.jsonc'),backend=await json('wrangler.backend.jsonc');
 assert.equal(prep.executionDigest,identityDigest({sourceCommit:prep.sourceCommit,roleInputSha256:prep.roleInputSha256,contractDigest:options.contractDigest,expiresAt:options.expiresAt,topology}));
 assert.equal(validatePlacedMigrationTopology({...topology,target:{...topology.target,name:'tibotattle-production-ingestion-22222222-2222-4222-8222-222222222222'}}).target.id,topology.target.id);
 assert.equal(prep.sourceCommit,result.sourceCommit);assert.equal(prep.topologyDigest,identityDigest(topology));assert.deepEqual(prep.topology,topology);
 for(const [file,pin]of [['migration-worker.mjs','bundleSha256'],['migration-backend.mjs','backendBundleSha256'],['wrangler.jsonc','frontConfigSha256'],['wrangler.backend.jsonc','backendConfigSha256']])
  assert.equal(createHash('sha256').update(await readFile(join(options.directory,file))).digest('hex'),prep[pin]);
 assert.deepEqual(front.services,[{binding:'STORAGE_RESTORE_EXECUTOR',service:topology.backendName}]);assert.equal(front.d1_databases,undefined);
 assert.deepEqual(backend.placement,{region:'gcp:us-east4'});assert.equal(backend.queues,undefined);assert.equal(backend.services,undefined);
 assert.deepEqual(backend.d1_databases.map(x=>x.database_id),[topology.source.id,topology.target.id]);
 for(const config of [front,backend]){assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers.crons,[]);assert.equal(config.vars.STORAGE_RESTORE_MODE,'disabled');}
 assert.deepEqual(front.queues.consumers[0],{queue:topology.queueName,max_batch_size:1,max_batch_timeout:1,max_concurrency:1,max_retries:0});
 await assert.rejects(prepareStorageMigrationWorker({...options,directory:join(directory,'wrong'),placedTopologyDigest:'0'.repeat(64)}),/TOPOLOGY_INVALID/);
 for(const altered of [{...topology,queueId:topology.source.id},{...topology,region:'auto'},{...topology,frontName:topology.backendName},{...topology,target:topology.source},{...topology,extra:true}])assert.throws(()=>validatePlacedMigrationTopology(altered),/TOPOLOGY_INVALID/);
 const direct=join(directory,'direct');await prepareStorageMigrationWorker({...options,directory:direct,placedTopologyPath:undefined,placedTopologyDigest:undefined});
 assert.equal(JSON.parse(await readFile(join(direct,'preparation.json'),'utf8')).driver,'queue-checkpoint-continuation');
 assert.equal(JSON.parse(await readFile(join(direct,'wrangler.jsonc'),'utf8')).services,undefined);
});

test('a different backend execution pin refuses even the same contract and message',async t=>{
 const f=await fixture(t);const front=createStorageMigrationFront({contractDigest,executionDigest:'e'.repeat(64),expiresAt});
 await assert.rejects(front.queue({messages:[{body:wake(),ack(){throw Error('must not ack');}}]},f.env),/PRIVATE_EXECUTION_UNCERTAIN/);
 assert.equal(await f.source.prepare('SELECT count(*) n FROM synthetic_calls').first('n'),0);
 assert.equal(await f.target.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_authority_operator_progress'").first('n'),0);
});

test('front Queue send failure after backend commit never acknowledges or repeats the page',async t=>{
 for(const accepted of [false,true])await t.test(accepted?'accepted send with lost response':'send failed before acceptance',async t=>{
  const f=await fixture(t);await f.driver.scheduled({},f.env);f.pending.shift();
  const send=f.env.STORAGE_RESTORE_QUEUE.send;
  f.env.STORAGE_RESTORE_QUEUE.send=async body=>{if(accepted)await send(body);throw Error('synthetic send uncertain');};
  await assert.rejects(f.deliver(wake()),/synthetic send uncertain/);assert.equal(f.acks(),0);
  assert.deepEqual(await f.target.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first(),{stage:'begin',steps:1,intent:null});
  assert.equal(f.pending.length,accepted?1:0);
  f.env.STORAGE_RESTORE_QUEUE.send=send;
  await f.deliver(wake());assert.equal(f.acks(),1);
  await f.driver.scheduled({},f.env);
  const duplicates=f.pending.splice(0);assert.equal(duplicates.length,accepted?2:1);
  for(const body of duplicates){assert.deepEqual(body,wake(1,'begin'));await f.deliver(body);}
  assert.equal(await f.source.prepare("SELECT count(*) n FROM synthetic_calls WHERE name='freezeAuthorityRestoreSource'").first('n'),1);
  assert.equal(await f.source.prepare("SELECT count(*) n FROM synthetic_calls WHERE name='beginAuthorityRestore'").first('n'),1);
  assert.deepEqual(f.pending,[wake(2,'copy-authority')]);
  assert.equal(f.acks(),accepted?3:2);
 });
});

test('malformed private success JSON cannot leak its text in the front error',async t=>{
 const f=await fixture(t);f.env.STORAGE_RESTORE_EXECUTOR={fetch:async()=>new Response('synthetic-private-marker',{headers:{'content-type':'application/json'}})};
 await assert.rejects(f.deliver(wake()),error=>error.message==='D1_STORAGE_PRIVATE_EXECUTION_UNCERTAIN');
 assert.equal(f.acks(),0);assert.equal(f.pending.length,0);
});
