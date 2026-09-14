import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,chmod,realpath,rm,readdir,readFile,appendFile,cp,mkdir,symlink,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Log,LogLevel,Miniflare} from 'miniflare';
import {createStorageShardReadinessHostedProvider,createStorageShardReadinessMutationCoordinator,
 captureStorageShardReadinessHostedProvenance,runHostedStorageShardReadiness,
 validateStorageShardReadinessHostedConfiguration} from './storage-shard-readiness-hosted-provider.mjs';
import {runStorageShardReadinessOperator,storageShardCapacityEvidence} from './storage-shard-readiness-operator.mjs';
import {maintenanceBindingDigest} from './production-maintenance-provider.mjs';
import {openOperation} from '../../../scripts/lib/release-operation.mjs';

const workerRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const now=2_000,observedBytes=4_096;
const capacityObservation=storageShardCapacityEvidence({
 databaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',observedBytes,observedAt:1_900,validUntil:2_100});
const plan={schema:'storage-shard-readiness-operator-v1',
 qualificationId:'11111111-1111-4111-8111-111111111111',shardId:'spare-a',
 catalogDatabaseId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
 bindingName:'STORAGE_INGESTION_A',ingestionDatabaseId:capacityObservation.databaseId,
 sourceId:'source-a',sourceNamespace:'namespace-a',analyticsTargetId:'analytics-a',
 analyticsBindingName:'STORAGE_ANALYTICS_A',analyticsDatabaseId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 erasureTargetId:'analytics-a',deletionLedgerBindingName:'DELETION_LEDGER',
 deletionLedgerDatabaseId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 publicationBindingName:'STORAGE_PUBLICATION_DB',publicationDatabaseId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
 allocationTier:'spare',capacityObservation,qualifiedAt:1_950,expiresAt:2_500,
 expectedSchemaDigests:{catalog:'0'.repeat(64),ingestion:'1'.repeat(64),analytics:'2'.repeat(64),
  deletionLedger:'3'.repeat(64),publication:'4'.repeat(64)}};
const rows=[
 ['STORAGE_ROUTING_DB',plan.catalogDatabaseId,'synthetic-routing'],
 [plan.bindingName,plan.ingestionDatabaseId,'synthetic-ingestion-a'],
 [plan.analyticsBindingName,plan.analyticsDatabaseId,'synthetic-analytics-a'],
 [plan.deletionLedgerBindingName,plan.deletionLedgerDatabaseId,'synthetic-deletion-ledger'],
 [plan.publicationBindingName,plan.publicationDatabaseId,'synthetic-publication'],
];
const configuration={d1_databases:rows.map(([binding,database_id,database_name])=>({binding,database_id,database_name}))};
const resources=rows.map(([bindingName,databaseId,databaseName],index)=>({
 role:['catalog','ingestion','analytics','deletionLedger','publication'][index],bindingName,databaseId,databaseName}));
const candidate={qualificationId:plan.qualificationId,shardId:plan.shardId,
 catalogDatabaseId:plan.catalogDatabaseId,catalogBindingName:'STORAGE_ROUTING_DB',catalogSchemaDigest:'0'.repeat(64),
 bindingName:plan.bindingName,ingestionDatabaseId:plan.ingestionDatabaseId,sourceId:plan.sourceId,
 sourceNamespace:plan.sourceNamespace,ingestionSchemaDigest:'1'.repeat(64),analyticsTargetId:plan.analyticsTargetId,
 analyticsBindingName:plan.analyticsBindingName,analyticsDatabaseId:plan.analyticsDatabaseId,
 analyticsSchemaDigest:'2'.repeat(64),erasureTargetId:plan.erasureTargetId,
 deletionLedgerBindingName:plan.deletionLedgerBindingName,deletionLedgerDatabaseId:plan.deletionLedgerDatabaseId,
 deletionSchemaDigest:'3'.repeat(64),publicationBindingName:plan.publicationBindingName,
 publicationDatabaseId:plan.publicationDatabaseId,publicationSchemaDigest:'4'.repeat(64),
 readinessDigest:'f'.repeat(64),qualifiedAt:plan.qualifiedAt,state:'active',revokedAt:null,contractVersion:1};
const deployedBindings=[...resources.map(resource=>({type:'d1',name:resource.bindingName,id:resource.databaseId})),
 {type:'plain_text',name:'DEPLOYMENT_SOURCE_COMMIT',text:'b'.repeat(40)}];
const deployment={sourceCommit:'b'.repeat(40),workerName:'synthetic-shard-worker',
 workerVersionId:'99999999-9999-4999-8999-999999999999',bindingDigest:maintenanceBindingDigest(deployedBindings)};

async function bundledRuntime(){
 const require=createRequire(join(workerRoot,'package.json')),{build}=require('esbuild');
 const source=`export {captureStorageShardReadinessSchemaDigests,qualifyStorageShardRuntimeTuple,
readStorageShardReadiness,recordStorageShardReadiness} from './src/storage-shard-readiness.ts';
export {recordStorageCapacityObservation,configureStorageShardAllocation,readStorageCapacityObservation,
readStorageShardAllocationPolicy} from './src/storage-capacity.ts';`;
 const built=await build({stdin:{contents:source,resolveDir:workerRoot,sourcefile:'hosted-readiness-test-runtime.ts',loader:'ts'},
  bundle:true,platform:'node',target:'node26',format:'esm',mainFields:['module','main'],write:false,logLevel:'silent'});
 return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
}

test('canonical hosted runtime provenance is independent of the launch directory',async t=>{
 const fixture=await realpath(await mkdtemp(join(tmpdir(),'storage-readiness-provenance-')));
 t.after(()=>rm(fixture,{recursive:true,force:true}));
 const sourceRoot=join(fixture,'worker'),launchA=join(fixture,'launch-a'),launchB=join(fixture,'launch-b');
 await mkdir(sourceRoot,{mode:0o700});await cp(join(workerRoot,'src'),join(sourceRoot,'src'),{recursive:true});
 await cp(join(workerRoot,'package.json'),join(sourceRoot,'package.json'));
 await symlink(join(workerRoot,'node_modules'),join(sourceRoot,'node_modules'));
 await writeFile(join(sourceRoot,'.gitignore'),'node_modules\n',{mode:0o600});
 execFileSync('/usr/bin/git',['init','-q',sourceRoot]);
 execFileSync('/usr/bin/git',['-C',sourceRoot,'config','user.name','Synthetic Test']);
 execFileSync('/usr/bin/git',['-C',sourceRoot,'config','user.email','synthetic@example.invalid']);
 execFileSync('/usr/bin/git',['-C',sourceRoot,'add','.']);
 execFileSync('/usr/bin/git',['-C',sourceRoot,'commit','-q','-m','synthetic source']);
 const sourceCommit=execFileSync('/usr/bin/git',['-C',sourceRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 await mkdir(launchA,{mode:0o700});await mkdir(launchB,{mode:0o700});
 const original=process.cwd();let first,second;
 try{
  process.chdir(launchA);first=await captureStorageShardReadinessHostedProvenance({workerRoot:sourceRoot,sourceCommit});
  process.chdir(launchB);second=await captureStorageShardReadinessHostedProvenance({workerRoot:sourceRoot,sourceCommit});
 }finally{process.chdir(original);}
 assert.equal(first.runtimeBundleSha256,second.runtimeBundleSha256);
 assert.equal(first.dependencyDigest,second.dependencyDigest);
 await appendFile(join(sourceRoot,'src','storage-capacity.ts'),'\n// synthetic source drift\n');
 await assert.rejects(captureStorageShardReadinessHostedProvenance({workerRoot:sourceRoot,sourceCommit}),
  {code:'STORAGE_SHARD_HOSTED_SOURCE_CHANGED'});
});

async function applyMigrations(database,directories){
 await database.exec('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT DEFAULT CURRENT_TIMESTAMP);');
 const require=createRequire(join(workerRoot,'package.json')),{unstable_splitSqlQuery:split}=require('wrangler');
 for(const directory of directories){
  const root=join(workerRoot,directory),names=(await readdir(root)).filter(name=>name.endsWith('.sql')).sort();
  for(const name of names){
   const statements=split(await readFile(join(root,name),'utf8')).map(sql=>database.prepare(sql));
   assert.ok(statements.length>0&&statements.length<900);
   await database.batch([...statements,database.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
  }
 }
}

async function initializeReadinessRoles(local){
 const raw=new TextEncoder().encode(plan.sourceNamespace),namespace=new Uint8Array(raw.length+1);
 namespace.set(raw,1);const original=namespace.buffer;
 await local.ingestion.prepare('INSERT INTO storage_source_state(singleton,source_id) VALUES(1,?)')
  .bind(plan.sourceId).run();
 await local.ingestion.prepare('INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?)')
  .bind(original).run();
 await local.ingestion.prepare(`INSERT INTO typed_v11_admission_state(
  id,source_namespace,namespace_id,next_source_row_id) VALUES(1,?,1,1)`).bind(plan.sourceNamespace).run();
 await local.ingestion.prepare(`UPDATE typed_v11_admission_state SET runtime_contract_version=1
  WHERE id=1 AND source_namespace=? AND runtime_contract_version=0`).bind(plan.sourceNamespace).run();
 await local.ingestion.prepare(`INSERT INTO typed_telemetry_origin_contracts(
  namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
  source_schema_digest,registered_move_id,registered_at)
  VALUES(1,?,'current-write',0,2,?,NULL,'2026-09-13T00:00:00.000Z')`)
  .bind(original,'50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643').run();
 await local.ingestion.prepare(`INSERT INTO typed_v1_admission_state(
  id,source_namespace,namespace_id,next_source_row_id) VALUES(1,?,1,1)`).bind(plan.sourceNamespace).run();
 await local.ingestion.prepare('UPDATE typed_v1_admission_state SET runtime_contract_version=1 WHERE id=1').run();
 await local.ingestion.prepare(`UPDATE typed_telemetry_origin_contracts SET v1_read_contract_version=2
  WHERE namespace_id=1 AND namespace_original=? AND source_namespace=? AND access_mode='current-write'
   AND source_schema_digest=? AND registered_move_id IS NULL AND v1_read_contract_version=0`)
  .bind(original,plan.sourceNamespace,'50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643').run();
 await local.analytics.prepare(`INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version)
  VALUES(?,?,1)`).bind(plan.sourceId,plan.sourceNamespace).run();
}

function fixture({wrongName=false,wrongBinding=false,conflictingAlias=false,deploymentDriftsOnRead=null,
 loseObservationAck=true,losePolicyAck=true}={}){
 const calls=[];let observation=null,policy=null,readiness=null;
 let deploymentReads=0;
 const byId=new Map(resources.map(row=>[row.databaseId,row]));
 const transport={accountPath:'/accounts/'+'a'.repeat(32),async api(path,body,options){
  calls.push({path,body:structuredClone(body),options:structuredClone(options)});
  if(path.endsWith(`/workers/scripts/${deployment.workerName}/deployments`)){
   deploymentReads++;
   return {deployments:[{versions:[{version_id:deploymentDriftsOnRead===deploymentReads
    ?'88888888-8888-4888-8888-888888888888':deployment.workerVersionId,percentage:100}]}]};
  }
  if(path.endsWith(`/workers/scripts/${deployment.workerName}/versions/${deployment.workerVersionId}`))return {
   id:deployment.workerVersionId,resources:{bindings:[
    ...resources.map(resource=>({type:'d1',name:wrongBinding&&resource.role==='analytics'
     ?'STORAGE_ANALYTICS_B':resource.bindingName,id:resource.databaseId,
     ...(conflictingAlias&&resource.role==='analytics'?{database_id:plan.catalogDatabaseId}:{})})),
    {type:'plain_text',name:'DEPLOYMENT_SOURCE_COMMIT',text:deployment.sourceCommit},
   ]}};
  const databaseId=/\/d1\/database\/([^/]+)$/u.exec(path)?.[1];
  if(databaseId){const resource=byId.get(databaseId);return {uuid:databaseId,
    name:wrongName&&resource.role==='analytics'?'wrong-analytics':resource.databaseName};}
  const queryId=/\/d1\/database\/([^/]+)\/query$/u.exec(path)?.[1];
  assert.ok(byId.has(queryId));const statements=body.batch??[body],results=[];
  for(const statement of statements){
   if(statement.sql.includes('storage_shard_size_probe'))results.push({success:true,results:[{storage_shard_size_probe:1}],meta:{size_after:observedBytes}});
   else if(statement.sql.includes('READINESS_PROBE'))results.push({success:true,results:[{ready:1}],meta:{size_after:observedBytes}});
   else if(statement.sql.includes('INSERT_READINESS')){readiness=structuredClone(candidate);results.push({success:true,results:[],meta:{changes:1}});}
   else if(statement.sql.includes('READINESS_READ'))results.push({success:true,results:readiness?[readiness]:[]});
   else if(statement.sql.includes('CAPACITY_UPSERT')){observation={shardId:statement.params[0],observedBytes:statement.params[1],
     observedAt:statement.params[2],validUntil:statement.params[3],pressureState:statement.params[4]};results.push({success:true,results:[]});}
   else if(statement.sql.includes('CAPACITY_SHARD_UPDATE'))results.push({success:true,results:[]});
   else if(statement.sql.includes('CAPACITY_READ'))results.push({success:true,results:observation?[observation]:[]});
   else if(statement.sql.includes('POLICY_UPSERT')){policy={shardId:statement.params[0],allocationTier:statement.params[1],
     allocationEnabled:statement.params[2]===1,updatedAt:statement.params[3],qualificationDigest:statement.params[4]};results.push({success:true,results:[]});}
   else if(statement.sql.includes('POLICY_READ'))results.push({success:true,results:policy?[policy]:[]});
   else assert.fail(`unexpected SQL ${statement.sql}`);
  }
  if(body.batch&&loseObservationAck){loseObservationAck=false;throw Error('synthetic response loss after commit');}
  if(statements.some(value=>value.sql.includes('POLICY_UPSERT'))&&losePolicyAck){losePolicyAck=false;throw Error('synthetic response loss after commit');}
  return results;
 }};
 const runtime={
  async qualifyStorageShardRuntimeTuple(_runtimePlan,databases){
   for(const database of Object.values(databases))await database.prepare('SELECT 1 AS READINESS_PROBE').all();
   return structuredClone(candidate);
  },
  async readStorageShardReadiness(catalog,digest){return catalog.prepare('READINESS_READ ?').bind(digest).first();},
  async recordStorageShardReadiness(catalog,value){await catalog.prepare('INSERT_READINESS ?').bind(value.readinessDigest).run();return structuredClone(value);},
  async recordStorageCapacityObservation(catalog,value){await catalog.batch([
   catalog.prepare('CAPACITY_UPSERT ?,?,?,?,?').bind(value.shardId,value.observedBytes,value.observedAt,value.validUntil,value.pressureState),
   catalog.prepare('CAPACITY_SHARD_UPDATE ?').bind(value.shardId)]);},
  async readStorageCapacityObservation(catalog,shardId){const row=await catalog.prepare('CAPACITY_READ ?').bind(shardId).first();return row;},
  async configureStorageShardAllocation(catalog,value){await catalog.prepare('POLICY_UPSERT ?,?,?,?,?')
   .bind(value.shardId,value.allocationTier,value.allocationEnabled?1:0,value.updatedAt,value.qualificationDigest).run();},
  async readStorageShardAllocationPolicy(catalog,shardId){return catalog.prepare('POLICY_READ ?').bind(shardId).first();},
 };
 const operation={record:{state:{}},async save(state){this.record.state=structuredClone(state);}};
 const mutationCoordinator=createStorageShardReadinessMutationCoordinator({operation,beforeMutation:async()=>{}});
 return {transport,runtime,mutationCoordinator,calls,state:()=>({observation,policy,readiness})};
}

test('executes one exact five-role activation and reconciles lost D1 batch and policy acknowledgements',async()=>{
 const f=fixture(),api=createStorageShardReadinessHostedProvider({plan,configuration,deployment,transport:f.transport,runtime:f.runtime,
  mutationCoordinator:f.mutationCoordinator});
 const result=await runStorageShardReadinessOperator({plan,configuration,api,clock:()=>now});
 assert.equal(result.readinessDigest,candidate.readinessDigest);
 assert.deepEqual(f.state(),{observation:{shardId:plan.shardId,observedBytes,observedAt:1_900,validUntil:2_100,pressureState:'normal'},
  policy:{shardId:plan.shardId,allocationTier:'spare',allocationEnabled:true,updatedAt:1_950,qualificationDigest:candidate.readinessDigest},
  readiness:candidate});
 const batch=f.calls.find(call=>call.body?.batch);assert.equal(batch.body.batch.length,2);
 assert.equal(batch.options.mutation,true);
 assert.deepEqual(batch.body.batch.map(statement=>statement.sql),['CAPACITY_UPSERT ?,?,?,?,?','CAPACITY_SHARD_UPDATE ?']);
 assert.equal(f.calls.filter(call=>call.body?.batch).length,1);
 assert.equal(f.calls.filter(call=>call.body?.sql?.includes('POLICY_UPSERT')).length,1);
 assert.equal(api.observation().queries,16);
});

test('refuses wrong resource identity before size or catalog mutation',async()=>{
 const f=fixture({wrongName:true}),api=createStorageShardReadinessHostedProvider({plan,configuration,deployment,transport:f.transport,runtime:f.runtime,
  mutationCoordinator:f.mutationCoordinator});
 await assert.rejects(runStorageShardReadinessOperator({plan,configuration,api,clock:()=>now}),
  {code:'STORAGE_SHARD_HOSTED_RESOURCE_IDENTITY_CHANGED'});
 assert.equal(f.calls.some(call=>call.path.endsWith('/query')),false);
});

test('rechecks the immutable freshness window after delayed qualification and before mutation',async()=>{
 const f=fixture(),api=createStorageShardReadinessHostedProvider({plan,configuration,deployment,transport:f.transport,runtime:f.runtime,
  mutationCoordinator:f.mutationCoordinator});let index=0;const times=[2_000,2_000,2_200];
 await assert.rejects(runStorageShardReadinessOperator({plan,configuration,api,
  clock:()=>times[Math.min(index++,times.length-1)]}),/WINDOW_CLOSED/);
 assert.equal(f.calls.some(call=>call.options?.mutation===true),false);
 assert.equal(f.state().readiness,null);
});

test('refuses policy activation when the window closes after durable readiness and observation',async()=>{
 const f=fixture({loseObservationAck:false,losePolicyAck:false}),api=createStorageShardReadinessHostedProvider({
  plan,configuration,deployment,transport:f.transport,runtime:f.runtime,mutationCoordinator:f.mutationCoordinator});
 let index=0;const times=Array.from({length:4},()=>2_000).concat(2_200);
 await assert.rejects(runStorageShardReadinessOperator({plan,configuration,api,
  clock:()=>times[Math.min(index++,times.length-1)]}),/WINDOW_CLOSED/);
 assert.ok(f.state().readiness);assert.ok(f.state().observation);assert.equal(f.state().policy,null);
 assert.equal(f.calls.filter(call=>call.options?.mutation===true).length,2);
});

test('rechecks the exact active deployment immediately before policy activation',async()=>{
 const f=fixture({deploymentDriftsOnRead:2,loseObservationAck:false,losePolicyAck:false});
 const api=createStorageShardReadinessHostedProvider({plan,configuration,deployment,transport:f.transport,runtime:f.runtime,
  mutationCoordinator:f.mutationCoordinator});
 await assert.rejects(runStorageShardReadinessOperator({plan,configuration,api,clock:()=>now}),
  {code:'STORAGE_SHARD_HOSTED_DEPLOYMENT_CHANGED'});
 assert.ok(f.state().readiness);assert.ok(f.state().observation);assert.equal(f.state().policy,null);
 assert.equal(f.calls.filter(call=>call.path.endsWith(`/workers/scripts/${deployment.workerName}/deployments`)).length,2);
 assert.equal(f.calls.filter(call=>call.options?.mutation===true).length,2);
});

test('refuses a deployed binding mismatch before database reads or mutation',async()=>{
 const f=fixture({wrongBinding:true}),changed={...deployment,bindingDigest:maintenanceBindingDigest([
  ...deployedBindings.slice(0,2),{...deployedBindings[2],name:'STORAGE_ANALYTICS_B'},...deployedBindings.slice(3)])};
 const api=createStorageShardReadinessHostedProvider({plan,configuration,deployment:changed,transport:f.transport,runtime:f.runtime,
  mutationCoordinator:f.mutationCoordinator});
 await assert.rejects(runStorageShardReadinessOperator({plan,configuration,api,clock:()=>now}),
  {code:'STORAGE_SHARD_HOSTED_BINDINGS_CHANGED'});
 assert.equal(f.calls.some(call=>call.path.includes('/d1/database/')),false);
});

test('refuses contradictory D1 id aliases in the active binding inventory',async()=>{
 const f=fixture({conflictingAlias:true}),changedBindings=structuredClone(deployedBindings);
 changedBindings[2].database_id=plan.catalogDatabaseId;
 const api=createStorageShardReadinessHostedProvider({plan,configuration,
  deployment:{...deployment,bindingDigest:maintenanceBindingDigest(changedBindings)},transport:f.transport,runtime:f.runtime,
  mutationCoordinator:f.mutationCoordinator});
 await assert.rejects(runStorageShardReadinessOperator({plan,configuration,api,clock:()=>now}),
  {code:'STORAGE_SHARD_HOSTED_BINDINGS_CHANGED'});
 assert.equal(f.calls.some(call=>call.path.includes('/d1/database/')),false);
});

test('requires the exact five binding, id and distinct physical-name composition',()=>{
 assert.deepEqual(validateStorageShardReadinessHostedConfiguration(configuration,plan),resources);
 const changed=[
  {d1_databases:configuration.d1_databases.map((row,index)=>index===1?{...row,database_id:plan.analyticsDatabaseId}:row)},
  {d1_databases:configuration.d1_databases.map((row,index)=>index===1?{...row,binding:plan.analyticsBindingName}:row)},
  {d1_databases:configuration.d1_databases.map((row,index)=>index===1?{...row,database_name:configuration.d1_databases[2].database_name}:row)},
  {d1_databases:[...configuration.d1_databases,{binding:'STORAGE_INGESTION_B',database_id:'99999999-9999-4999-8999-999999999999',database_name:'extra'}]},
 ];
 for(const value of changed)assert.throws(()=>validateStorageShardReadinessHostedConfiguration(value,plan));
});

test('real bundled qualification SQL crosses the REST adapter and local D1 with lost acknowledgements',async t=>{
 const runtime=await bundledRuntime();
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response(null,{status:404})}}',
  compatibilityDate:'2026-07-26',log:new Log(LogLevel.NONE),d1Databases:{CATALOG:'hosted-catalog',INGESTION:'hosted-ingestion',
   ANALYTICS:'hosted-analytics',DELETION:'hosted-deletion',PUBLICATION:'hosted-publication'}});
 t.after(()=>mf.dispose());
 const local={catalog:await mf.getD1Database('CATALOG'),ingestion:await mf.getD1Database('INGESTION'),
  analytics:await mf.getD1Database('ANALYTICS'),deletionLedger:await mf.getD1Database('DELETION'),
  publication:await mf.getD1Database('PUBLICATION')};
 await applyMigrations(local.catalog,['routing-migrations']);
 await applyMigrations(local.ingestion,['migrations','typed-ingestion-migrations','ingestion-bridge-migrations',
  'typed-v11-admission-migrations','typed-v1-admission-migrations','ingestion-isolation-migrations','ingestion-routing-migrations']);
 await applyMigrations(local.analytics,['analytics-migrations']);
 await applyMigrations(local.deletionLedger,['deletion-ledger-migrations']);
 await applyMigrations(local.publication,['analytics-migrations']);
 await initializeReadinessRoles(local);
 await local.catalog.prepare(`INSERT INTO storage_shards(shard_id,binding_name,state)
  VALUES(?,?,'active')`).bind(plan.shardId,plan.bindingName).run();
 const schema=await runtime.captureStorageShardReadinessSchemaDigests(local);
 const size=(await local.ingestion.prepare('SELECT 1').all()).meta.size_after;
 const localPlan={...plan,capacityObservation:storageShardCapacityEvidence({databaseId:plan.ingestionDatabaseId,
  observedBytes:size,observedAt:1_900,validUntil:2_100}),expectedSchemaDigests:schema};
 const byId=new Map([[plan.catalogDatabaseId,local.catalog],[plan.ingestionDatabaseId,local.ingestion],
  [plan.analyticsDatabaseId,local.analytics],[plan.deletionLedgerDatabaseId,local.deletionLedger],
  [plan.publicationDatabaseId,local.publication]]),names=new Map(rows.map(([,id,name])=>[id,name]));
 const mutationAttempts=new Map(),lost=new Set(['readiness','observation','policy']);
 const transport={accountPath:'/accounts/'+'a'.repeat(32),async api(path,body,options){
  if(path.endsWith(`/workers/scripts/${deployment.workerName}/deployments`))return {deployments:[{
   versions:[{version_id:deployment.workerVersionId,percentage:100}]}]};
  if(path.endsWith(`/workers/scripts/${deployment.workerName}/versions/${deployment.workerVersionId}`))return {
   id:deployment.workerVersionId,resources:{bindings:deployedBindings}};
  const identity=/\/d1\/database\/([^/]+)$/u.exec(path)?.[1];
  if(identity)return {uuid:identity,name:names.get(identity)};
  const databaseId=/\/d1\/database\/([^/]+)\/query$/u.exec(path)?.[1],database=byId.get(databaseId);
  assert.ok(database);const statements=body.batch??[body];let results;
  if(body.batch)results=await database.batch(statements.map(statement=>database.prepare(statement.sql).bind(...statement.params)));
  else results=[options?.mutation?await database.prepare(body.sql).bind(...body.params).run()
   :await database.prepare(body.sql).bind(...body.params).all()];
  const text=statements.map(value=>value.sql).join('\n'),step=text.includes('storage_shard_runtime_readiness')&&text.includes('INSERT INTO')
   ?'readiness':body.batch?'observation':text.includes('INSERT INTO storage_shard_allocation_policy')?'policy':null;
  if(step){mutationAttempts.set(step,(mutationAttempts.get(step)??0)+1);if(lost.delete(step))throw Error('synthetic response loss after D1 commit');}
  return results;
 }};
 const operation={record:{state:{}},async save(state){this.record.state=structuredClone(state);}};
 const mutationCoordinator=createStorageShardReadinessMutationCoordinator({operation,beforeMutation:async()=>{}});
 const api=createStorageShardReadinessHostedProvider({plan:localPlan,configuration,deployment,transport,runtime,mutationCoordinator});
 const result=await runStorageShardReadinessOperator({plan:localPlan,configuration,api,clock:()=>now});
 assert.match(result.readinessDigest,/^[a-f0-9]{64}$/u);
 assert.deepEqual(Object.fromEntries(mutationAttempts),{readiness:1,observation:1,policy:1});
 assert.deepEqual(await runtime.readStorageShardAllocationPolicy(local.catalog,plan.shardId),{
  shardId:plan.shardId,allocationTier:'spare',allocationEnabled:true,
  qualificationDigest:result.readinessDigest,updatedAt:plan.qualifiedAt});
});

test('source refusal happens before credentials, CLI validation or remote reads',async t=>{
 let requests=0;const directory=await realpath(await mkdtemp(join(tmpdir(),'storage-readiness-hosted-')));
 await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
 await assert.rejects(runHostedStorageShardReadiness({plan,configuration,
  host:{schema:'storage-shard-readiness-host-v1',accountId:'a'.repeat(32),sourceCommit:deployment.sourceCommit,
   dependencyDigest:'d'.repeat(64),runtimeBundleSha256:'e'.repeat(64),workerBindingDigest:deployment.bindingDigest,
   wranglerSha256:'c'.repeat(64),workerName:deployment.workerName,workerVersionId:deployment.workerVersionId},
  workerRoot,operationDirectory:directory,cliPath:'/does/not/exist',clock:()=>now,
  fetcher:async()=>{requests++;throw Error('must not call');},environment:{},checkSource:async()=>{}}),
  {code:'STORAGE_SHARD_HOSTED_SOURCE_CHANGED'});
 assert.equal(requests,0);
});

test('a retained mutation intent survives process loss, reconciles read-only and never reissues the write',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'storage-readiness-operation-')));
 await chmod(directory,0o700);let operation;t.after(async()=>{operation?.close();await rm(directory,{recursive:true,force:true});});
 const binding={schema:'synthetic-storage-readiness-operation-v1'};
 operation=await openOperation({directory,kind:'qualification',binding});
 let committed=false,writes=0,reads=0,failRead=true;
 const first=createStorageShardReadinessMutationCoordinator({operation,beforeMutation:async()=>{}});
 await assert.rejects(first.run({name:'readiness',intent:candidate,
  reconcile:async()=>{reads++;if(failRead&&committed)throw Error('read unavailable');return committed?candidate:null;},
  mutate:async()=>{writes++;committed=true;}}));
 assert.equal(writes,1);assert.equal(operation.record.state.steps.readiness.status,'intent');
 operation.close();operation=null;operation=await openOperation({directory,kind:'qualification',binding,resume:true});
 failRead=false;
 const resumed=createStorageShardReadinessMutationCoordinator({operation,beforeMutation:async()=>{}});
 await assert.doesNotReject(resumed.run({name:'readiness',intent:candidate,
  reconcile:async()=>{reads++;return committed?candidate:null;},mutate:async()=>{writes++;}}));
 assert.equal(writes,1);assert.equal(operation.record.state.steps.readiness.status,'committed');assert.ok(reads>=3);
 operation.close();operation=null;
});
