import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { buildTypedProductionExpectedSchemas } from './production-typed-schema.mjs';
import { storageSha256 } from './d1-storage-plan.mjs';
import { identityDigest, readOperation } from '../../../scripts/lib/release-operation.mjs';
import { EXISTING_ROLE_FORWARD_CONFIRMATION, EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC,
  EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED, EXISTING_ROLE_FORWARD_STEPS,
  createExistingRoleProductionAdapter, existingRoleAtomicSql, loadExistingRoleForwardSteps, normalizeScheduledInventory,
  projectExistingRoleSchema, runExistingRoleForwardMigration, validateExistingRoleInventory,
  verifyExistingRoleForwardReceipt } from './existing-role-forward-migration.mjs';

const sourceWorker=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha='a'.repeat(64),account='a'.repeat(32);
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const controls={collection:{schema_version:'collection-controls-v0.1',control_state:'operational',revision:9,
  enrollment_enabled:1,upload_registration_enabled:1,processing_enabled:1,publication_enabled:1},
correction:{schema_version:'telemetry-usage-correction-v1',method_version:'usage-total-correction-v1',state:'active'}};
let fixturePromise;
after(async()=>{if(fixturePromise)rmSync((await fixturePromise).root,{recursive:true,force:true});});
async function fixture(){
  if(fixturePromise)return fixturePromise;
  fixturePromise=(async()=>{
    const root=await mkdtemp(join('/private/tmp','existing-role-check-')),worker=join(root,'apps','worker');
    mkdirSync(worker,{recursive:true});
    for(const folder of ['src','scripts','migrations','typed-ingestion-migrations','ingestion-bridge-migrations',
      'typed-v11-admission-migrations','typed-v1-admission-migrations','ingestion-isolation-migrations',
      'analytics-migrations','deletion-ledger-migrations'])
      cpSync(join(sourceWorker,folder),join(worker,folder),{recursive:true});
    cpSync(join(sourceWorker,'package.json'),join(worker,'package.json'));
    symlinkSync(join(sourceWorker,'node_modules'),join(worker,'node_modules'));
    writeFileSync(join(root,'.gitignore'),'apps/worker/node_modules\n');
    const git=args=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',
      env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',
      GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'}});
      assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    git(['init','-q']);git(['add','.']);git(['-c','commit.gpgSign=false','commit','-qm','fixture']);
    return {root,worker,commit:git(['rev-parse','HEAD']),
      steps:await loadExistingRoleForwardSteps({workerDirectory:worker}),
      expected:await buildTypedProductionExpectedSchemas({workerDirectory:worker})};
  })();
  return fixturePromise;
}
function scheduledRaw(name,version){return {accountId:account,workerName:name,version:{id:version,
  resources:{script_runtime:{compatibility_date:'2026-09-29'},bindings:[
    {type:'plain_text',name:'DEPLOYMENT_SOURCE_COMMIT',text:EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED},
    {type:'d1',name:'STORAGE_INGESTION_DB',id:ids[0]},
    {type:'d1',name:'STORAGE_ANALYTICS_DB',id:ids[1]}]}},
  settings:{observability:{}},schedules:{schedules:[{cron:'0 * * * *'}]},
  subdomain:{enabled:false},routes:[],domains:[],namespaces:[]};}
function makePlan(f,expiresAt=new Date(Date.now()+30_000).toISOString()){
  const workerPins=['public','analytics','publication','cache'].map((workerName,i)=>({
    workerName,versionId:`${i+1}0000000-0000-4000-8000-000000000000`,
    sourceCommit:i===0?EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC:EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED,
    fingerprint:sha,bindings:{primary:ids[0],analytics:ids[1]}}));
  const before=[
    [{type:'table',name:'typed_telemetry_devices',tbl_name:'typed_telemetry_devices',
      sql:'CREATE TABLE typed_telemetry_devices(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL)'},
    {type:'table',name:'typed_telemetry_manifests',tbl_name:'typed_telemetry_manifests',
      sql:'CREATE TABLE typed_telemetry_manifests(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL)'}],
    [{type:'table',name:'analytics_runtime_sources',tbl_name:'analytics_runtime_sources',
      sql:'CREATE TABLE analytics_runtime_sources(source_id TEXT PRIMARY KEY)'}]];
  const targets=f.steps.map((step,i)=>{
    const p=projectExistingRoleSchema(before[i],step);
    return {role:step.role,binding:step.binding,name:`synthetic-${step.role}`,databaseId:ids[i],
      migrationName:step.name,migrationSha256:step.sha256,beforeSchemaSha256:p.beforeSha256,
      afterSchemaSha256:p.afterSha256,beforeLedger:[{name:'0000_seed.sql',sha256:sha}],
      controlInvariantSha256:sha,beforeBytes:4096};});
  const createdAt=new Date(Date.now()-1000).toISOString();
  const backupValue={schema:'typed-forward-backup-receipt-v2',provider:'cloudflare-d1-time-travel',
    capturedAt:createdAt,expiresAt,targetsSha256:identityDigest(targets.map(x=>({role:x.role,databaseId:x.databaseId}))),
    targetBookmarks:targets.map(x=>({role:x.role,databaseId:x.databaseId,bookmark:'synthetic-bookmark'}))};
  return {schema:'existing-role-forward-plan-v1',operationId:randomUUID(),environment:'production',
    accountId:account,sourceCommit:f.commit,previousPublicSourceCommit:EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC,
    previousScheduledSourceCommit:EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED,createdAt,expiresAt,
    sourceNamespace:'synthetic',wranglerSha256:sha,workerPins,expectedInputSha256:f.expected.inputSha256,
    controlsSha256:identityDigest(controls),projectedPreflightSha256:identityDigest({ok:true}),
    backup:{...backupValue,receiptSha256:identityDigest(backupValue)},targets};
}
function fakeRuntime(plan,{lost='none',delay=0,acquireUnknown=false}={}){
  const state={schema:plan.targets.map(x=>x.beforeSchemaSha256),
    ledger:plan.targets.map(x=>structuredClone(x.beforeLedger)),calls:[],owner:null,inspections:0};
  const lock=()=>({status:async()=>state.owner,createOwner:async()=>('f'.repeat(40)),
    acquire:async owner=>{if(acquireUnknown)throw Error('lost acquire');state.owner=owner;},
    assertOwned:async owner=>{assert.equal(state.owner,owner);},
    release:async owner=>{assert.equal(state.owner,owner);state.owner=null;}});
  const adapter=()=>({wranglerSha256:plan.wranglerSha256,workerPins:async()=>plan.workerPins,
    controls:async()=>controls,verifyBackup:async()=>{},
    inspect:async target=>{
      if(delay&&state.inspections++===0)await new Promise(done=>setTimeout(done,delay));
      const i=plan.targets.findIndex(x=>x.role===target.role);
      return {schemaSha256:state.schema[i],ledger:structuredClone(state.ledger[i]),
        controlInvariantSha256:target.controlInvariantSha256};},
    migrateAtomic:async(target,statement)=>{
      const i=plan.targets.findIndex(x=>x.role===target.role);state.calls.push(target.role);
      assert.equal(statement.resultCount,i===0?3:2);
      assert.equal(statement.atomic,true);
      if(lost==='before'&&state.calls.length===1)throw Error('lost before commit');
      state.schema[i]=target.afterSchemaSha256;
      state.ledger[i].push({name:target.migrationName,sha256:target.migrationSha256});
      if(lost==='after'&&state.calls.length===1)throw Error('lost after commit');},
    preflight:async()=>({ok:true})});
  return {state,lock,adapter};
}
async function run(f,plan,op,runtime,extra={}){return runExistingRoleForwardMigration({
  plan,workerDirectory:f.worker,repositoryRoot:f.root,operationDirectory:op,execute:true,
  confirmation:EXISTING_ROLE_FORWARD_CONFIRMATION,approvedPlanSha256:identityDigest(plan),
  adapterFactory:runtime.adapter,lockFactory:runtime.lock,...extra});}

test('scheduled inventory has separate schema and rejects source or D1 drift',()=>{
  const raw=scheduledRaw('analytics','10000000-0000-4000-8000-000000000000');
  const normalized=normalizeScheduledInventory(raw);
  assert.equal(normalized.schema,'existing-role-scheduled-inventory-v1');
  assert.equal(normalized.bindings[1].database_id,ids[0]);
  const pins=validateExistingRoleInventory({accountId:account,
    publicWorker:{...normalized,schema:'production-live-config-v1',workerName:'public',
      sourceCommit:EXISTING_ROLE_FORWARD_PREVIOUS_PUBLIC,bindings:normalized.bindings.map(x=>
        x.name==='STORAGE_INGESTION_DB'?{...x,name:'USAGE_MONITOR_DB'}:
        x.name==='STORAGE_ANALYTICS_DB'?{...x,name:'ANALYTICS_DB'}:x)},
    scheduledWorkers:[normalized,normalizeScheduledInventory(scheduledRaw('publication','20000000-0000-4000-8000-000000000000')),
      normalizeScheduledInventory(scheduledRaw('cache','30000000-0000-4000-8000-000000000000'))]});
  assert.equal(pins.length,4);
  const altered=structuredClone(raw);altered.version.resources.bindings[0].text='b'.repeat(40);
  assert.throws(()=>normalizeScheduledInventory(altered),{code:'EXISTING_ROLE_FORWARD_SCHEDULED_SOURCE_DRIFT'});
  altered.version.resources.bindings[0].text=EXISTING_ROLE_FORWARD_PREVIOUS_SCHEDULED;
  altered.version.resources.bindings[1].database_id=ids[1];
  assert.throws(()=>normalizeScheduledInventory(altered),{code:'EXISTING_ROLE_FORWARD_SCHEDULED_BINDING_INVALID'});
});
test('reviewed SQL and ledger share a rollback on populated SQLite',async()=>{
  const f=await fixture();
  assert.deepEqual(f.steps.map(x=>x.sha256),EXISTING_ROLE_FORWARD_STEPS.map(x=>x.sha256));
  for(const [i,step] of f.steps.entries()){
    const db=new DatabaseSync(':memory:');
    try{
      if(i===0){
        db.exec('CREATE TABLE typed_telemetry_devices(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL)');
        db.exec('CREATE TABLE typed_telemetry_manifests(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL)');
      }else db.exec('CREATE TABLE analytics_runtime_sources(source_id TEXT PRIMARY KEY)');
      db.exec('CREATE TABLE d1_storage_migrations(name TEXT PRIMARY KEY,sha256 TEXT) STRICT');
      if(i===0){
        db.exec('INSERT INTO typed_telemetry_devices VALUES(1,7)');
        db.exec('INSERT INTO typed_telemetry_manifests VALUES(2,7)');
      }
      else db.exec("INSERT INTO analytics_runtime_sources VALUES('synthetic')");
      const before=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
      db.exec('BEGIN');db.exec(existingRoleAtomicSql(step));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_storage_migrations').get().n,1);
      if(i===0)assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('typed_telemetry_device_owner','typed_telemetry_manifest_owner') ORDER BY name").all().map(row=>row.name),
        ['typed_telemetry_device_owner','typed_telemetry_manifest_owner']);
      db.exec('ROLLBACK');
      assert.deepEqual(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),before);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_storage_migrations').get().n,0);
      assert.throws(()=>existingRoleAtomicSql({...step,sql:`${step.sql}\nDROP TABLE d1_storage_migrations;`}),
        {code:'EXISTING_ROLE_FORWARD_STEP_INVALID'});
    }finally{db.close();}
  }
});
test('primary schema projection rejects missing, extra, renamed, wrong-table and changed objects',async()=>{
  const f=await fixture(),step=f.steps[0],before=[
    {type:'table',name:'typed_telemetry_devices',tbl_name:'typed_telemetry_devices',
      sql:'CREATE TABLE typed_telemetry_devices(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL)'},
    {type:'table',name:'typed_telemetry_manifests',tbl_name:'typed_telemetry_manifests',
      sql:'CREATE TABLE typed_telemetry_manifests(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL)'}];
  assert.equal(step.addedObjects.length,2);
  assert.equal(projectExistingRoleSchema(before,step).rows.length,4);
  for(const changed of [
    {...step,addedObjects:step.addedObjects.slice(0,1)},
    {...step,addedObjects:[...step.addedObjects,step.addedObjects[0]]},
    {...step,addedObjects:[{...step.addedObjects[0],name:'wrong_index'},step.addedObjects[1]]},
    {...step,addedObjects:[{...step.addedObjects[0],tbl_name:'typed_telemetry_records'},step.addedObjects[1]]},
    {...step,addedObjects:[{...step.addedObjects[0],sql:`${step.addedObjects[0].sql} WHERE id>0`},step.addedObjects[1]]},
    {...step,sql:`${step.sql}\nCREATE INDEX unwanted ON typed_telemetry_devices(id);`},
  ])assert.throws(()=>projectExistingRoleSchema(before,changed));
  assert.throws(()=>projectExistingRoleSchema([...before,step.addedObjects[0]],step),
    {code:'EXISTING_ROLE_FORWARD_BEFORE_SCHEMA_INVALID'});
});
test('closed file pin rejects missing, extra, changed-column and wrong-table SQL',async()=>{
  const root=await mkdtemp(join('/private/tmp','existing-role-sql-negative-'));
  const worker=join(root,'apps','worker');mkdirSync(worker,{recursive:true});
  try{
    for(const folder of ['typed-ingestion-migrations','analytics-migrations'])
      cpSync(join(sourceWorker,folder),join(worker,folder),{recursive:true});
    cpSync(join(sourceWorker,'package.json'),join(worker,'package.json'));
    symlinkSync(join(sourceWorker,'node_modules'),join(worker,'node_modules'));
    const path=join(worker,'typed-ingestion-migrations','0005_owner_occurrence_lookup.sql');
    const original=await readFile(path,'utf8');
    const variants=[
      original.replace(/CREATE INDEX typed_telemetry_manifest_owner[\s\S]*?;/u,''),
      `${original}\nCREATE INDEX extra_owner ON typed_telemetry_devices(id);\n`,
      original.replace('typed_telemetry_devices(owner_id, id)','typed_telemetry_devices(id, owner_id)'),
      original.replace('ON typed_telemetry_manifests(owner_id, id)',
        'ON typed_telemetry_records(owner_id, id)'),
    ];
    for(const sql of variants){
      assert.notEqual(sql,original);
      writeFileSync(path,sql);
      await assert.rejects(loadExistingRoleForwardSteps({workerDirectory:worker}),
        {code:'EXISTING_ROLE_FORWARD_SQL_FILE_CHANGED'});
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('two roles complete and exact receipt verifier rejects forged proof',async()=>{
  const f=await fixture(),plan=makePlan(f),op=await mkdtemp(join('/private/tmp','existing-role-op-'));
  const runtime=fakeRuntime(plan),result=await run(f,plan,op,runtime);
  assert.equal(result.status,'complete');assert.deepEqual(runtime.state.calls,['primary','analytics']);
  const receipt=JSON.parse(await readFile(join(op,'receipt.json'),'utf8'));
  const operation=await readOperation(op);
  assert.equal(verifyExistingRoleForwardReceipt({plan,receipt,operation}).status,'verified');
  const changed={...receipt,sourceCommit:'b'.repeat(40)};
  changed.receiptSha256=identityDigest(Object.fromEntries(Object.entries(changed)
    .filter(([key])=>key!=='receiptSha256')));
  assert.throws(()=>verifyExistingRoleForwardReceipt({plan,receipt:changed,operation}),
    {code:'EXISTING_ROLE_FORWARD_RECEIPT_INVALID'});
  assert.throws(()=>verifyExistingRoleForwardReceipt({plan,receipt,operation:{...operation,state:{...operation.state,status:'running'}}}),
    {code:'EXISTING_ROLE_FORWARD_OPERATION_NOT_COMPLETE'});
  rmSync(op,{recursive:true,force:true});
});
test('lost response after primary reconciles read-only then resumes only analytics',async()=>{
  const f=await fixture(),plan=makePlan(f),op=await mkdtemp(join('/private/tmp','existing-role-op-'));
  const runtime=fakeRuntime(plan,{lost:'after'});
  await assert.rejects(run(f,plan,op,runtime),{code:'EXISTING_ROLE_FORWARD_PROVIDER_RESULT_UNCERTAIN'});
  const proof=await run(f,plan,op,runtime,{resume:true,reconcileOnly:true,execute:false});
  assert.equal(proof.status,'reconciled-applied');assert.deepEqual(runtime.state.calls,['primary']);
  const result=await run(f,plan,op,runtime,{resume:true,approvedReconciliationSha256:proof.reconciliationSha256});
  assert.equal(result.status,'complete');assert.deepEqual(runtime.state.calls,['primary','analytics']);
  rmSync(op,{recursive:true,force:true});
});
test('not-applied refuses blind retry, and unknown lock acquisition sends no DDL',async()=>{
  const f=await fixture(),plan=makePlan(f),op=await mkdtemp(join('/private/tmp','existing-role-op-'));
  const runtime=fakeRuntime(plan,{lost:'before'});
  await assert.rejects(run(f,plan,op,runtime),{code:'EXISTING_ROLE_FORWARD_PROVIDER_RESULT_UNCERTAIN'});
  const proof=await run(f,plan,op,runtime,{resume:true,reconcileOnly:true,execute:false});
  assert.equal(proof.status,'reconciled-not-applied');
  await assert.rejects(run(f,plan,op,runtime,{resume:true,approvedReconciliationSha256:proof.reconciliationSha256}),
    {code:'EXISTING_ROLE_FORWARD_RETRY_NOT_APPROVED'});
  assert.deepEqual(runtime.state.calls,['primary']);
  const retried=await run(f,plan,op,runtime,{resume:true,
    approvedReconciliationSha256:proof.reconciliationSha256,
    retryConfirmation:'RETRY_PROVEN_NOT_APPLIED_EXISTING_ROLE_FORWARD_MIGRATION'});
  assert.equal(retried.status,'complete');assert.deepEqual(runtime.state.calls,['primary','primary','analytics']);
  rmSync(op,{recursive:true,force:true});
  const op2=await mkdtemp(join('/private/tmp','existing-role-op-')),unknown=fakeRuntime(plan,{acquireUnknown:true});
  await assert.rejects(run(f,plan,op2,unknown),/lost acquire/);
  await assert.rejects(run(f,plan,op2,unknown,{resume:true}),{code:'EXISTING_ROLE_FORWARD_LOCK_ACQUIRE_UNCERTAIN'});
  assert.deepEqual(unknown.state.calls,[]);rmSync(op2,{recursive:true,force:true});
});
test('expiry during inspection prevents DDL',async()=>{
  const f=await fixture(),plan=makePlan(f,new Date(Date.now()+1200).toISOString());
  const op=await mkdtemp(join('/private/tmp','existing-role-op-')),runtime=fakeRuntime(plan,{delay:1500});
  await assert.rejects(run(f,plan,op,runtime),{code:'EXISTING_ROLE_FORWARD_APPROVAL_EXPIRED'});
  assert.ok(runtime.state.inspections>=1);assert.deepEqual(runtime.state.calls,[]);
  rmSync(op,{recursive:true,force:true});
});
test('expired uncertain plan still reconciles read-only and cannot resume DDL',async()=>{
  const f=await fixture(),plan=makePlan(f,new Date(Date.now()+1800).toISOString());
  const op=await mkdtemp(join('/private/tmp','existing-role-op-')),runtime=fakeRuntime(plan,{lost:'after'});
  await assert.rejects(run(f,plan,op,runtime),{code:'EXISTING_ROLE_FORWARD_PROVIDER_RESULT_UNCERTAIN'});
  await new Promise(done=>setTimeout(done,1900));
  const proof=await run(f,plan,op,runtime,{resume:true,reconcileOnly:true,execute:false});
  assert.equal(proof.status,'reconciled-applied');
  await assert.rejects(run(f,plan,op,runtime,{resume:true,
    approvedReconciliationSha256:proof.reconciliationSha256}),
    {code:'EXISTING_ROLE_FORWARD_APPROVAL_EXPIRED'});
  assert.deepEqual(runtime.state.calls,['primary']);rmSync(op,{recursive:true,force:true});
});
test('concrete transport uses a fresh private SQL namespace on resumed invocation',async()=>{
  const f=await fixture(),op=await mkdtemp(join('/private/tmp','existing-role-transport-'));
  const pkg=join(op,'wrangler');mkdirSync(join(pkg,'wrangler-dist'),{recursive:true});
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'wrangler',version:'4.114.0',main:'wrangler-dist/cli.js'}));
  const cli=join(pkg,'wrangler-dist','cli.js');
  writeFileSync(cli,"const n=process.argv.join(' ').includes('typed_telemetry_device_owner')?3:2;process.stdout.write(JSON.stringify(Array.from({length:n},()=>({success:true,results:[]}))))\n");
  const cliHash=storageSha256(await readFile(cli));
  const make=()=>createExistingRoleProductionAdapter({accountId:account,
    publicWorkerName:'public',scheduledWorkerNames:['analytics','publication','cache'],
    operationDirectory:op,cliPath:cli,wranglerSha256:cliHash,sourceNamespace:'synthetic',
    environment:{CLOUDFLARE_API_TOKEN:'synthetic-test-token-123'}});
  const target=(i)=>({role:f.steps[i].role,binding:f.steps[i].binding,
    name:`synthetic-${f.steps[i].role}`,databaseId:ids[i]});
  for(const i of [0,1]){
    const sql=existingRoleAtomicSql(f.steps[i]);
    await make().migrateAtomic(target(i),{sql,sha256:storageSha256(sql),
      resultCount:i===0?3:2,atomic:true});
  }
  const attempts=readdirSync(op).filter(name=>name.startsWith('transport-'));
  assert.equal(attempts.length,2);
  const statements=attempts.map(name=>readFile(join(op,name,'typed-forward-wrangler','mutation-0.sql'),'utf8'));
  const actual=await Promise.all(statements);
  assert.deepEqual(new Set(actual),new Set(f.steps.map(existingRoleAtomicSql)));
  rmSync(op,{recursive:true,force:true});
});
