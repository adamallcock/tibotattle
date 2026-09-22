import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { runStorageRestorePage,runStorageRestoreStep } from './d1-storage-restore-runner.mjs';
import { parseRestoreArguments } from './d1-storage-restore.mjs';
import { SYNTHETIC_D1_WORKER,syntheticD1Binding,closeSyntheticD1Bindings } from './d1-storage-local-d1.mjs';
import { createStorageMigrationWorker } from './d1-storage-migration-worker.mjs';
const contract={targetBaseSchemaDigest:'base'},contractDigest=identityDigest(contract),source={},target={};
const apiBase={authorityRestoreContractDigest:async value=>identityDigest(value)};
const initial=()=>({schema:'d1-storage-restore-progress-v1',contractDigest,intent:null,stage:'freeze-source',steps:0});
const restoreMessage=(body)=>({body,ack(){}});
test('closed CLI refuses remote switches and false qualification',()=>{
 assert.deepEqual(parseRestoreArguments(['--worker-root','/synthetic']),{workerRoot:'/synthetic',rehearse:false,qualify:false,allowUnfrozen:false});
 for(const args of [['--remote'],['--worker-root','/synthetic','--qualify'],['--worker-root','/synthetic','--rehearse','--directory','/synthetic','--qualify','--allow-unfrozen']])assert.throws(()=>parseRestoreArguments(args));
});
test('intent is durable before calling and failed calls are never automatically replayed',async()=>{
 const saves=[];let calls=0;
 const api={...apiBase,freezeAuthorityRestoreSource:async()=>{calls++;assert.equal(saves.at(-1).intent,'freeze-source');throw Error('response lost');}};
 const input={state:initial(),save:async value=>saves.push(structuredClone(value)),api,source,target,contract,contractDigest};
 await assert.rejects(runStorageRestorePage(input),/response lost/);
 await assert.rejects(runStorageRestorePage({...input,state:saves.at(-1)}),/RECONCILE_REQUIRED/);assert.equal(calls,1);
});
test('incomplete pages retain stage and counters cannot leak record fields',async()=>{
 const api={...apiBase,copyAuthorityPage:async()=>({state:'copying',copied:32,secret:'must not escape'})};
 const result=await runStorageRestoreStep({api,source,target,contract,contractDigest,stage:'copy-authority'});
 assert.deepEqual(result,{stage:'copy-authority',complete:false,counters:{copied:32},nextStage:'copy-authority'});
 await assert.rejects(runStorageRestoreStep({api,source,target,contract,contractDigest:'0'.repeat(64),stage:'copy-authority'}));
 await assert.rejects(runStorageRestorePage({state:initial(),save:async()=>{},api,source,target,contract,contractDigest,maxSteps:33}));
});
test('local transport preserves native batch rollback, exact BLOB and null',async()=>{
 const mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:['SOURCE','TARGET','REFERENCE']});
 try{
 const db=syntheticD1Binding(mf,'TARGET');await db.prepare('CREATE TABLE sample(id INTEGER PRIMARY KEY,b BLOB,n TEXT)').run();
 await assert.rejects(db.batch([db.prepare('INSERT INTO sample VALUES(1,?,?)').bind(new Uint8Array([0,255]),null),db.prepare('INSERT INTO sample VALUES(1,NULL,NULL)')]));
 assert.equal(await db.prepare('SELECT count(*) FROM sample').first('count(*)'),0);
 await db.batch([db.prepare('INSERT INTO sample VALUES(1,?,?)').bind(new Uint8Array([0,255]),null)]);
 assert.deepEqual(await db.prepare('SELECT hex(b) b,n FROM sample').first(),{b:'00FF',n:null});
 }finally{await closeSyntheticD1Bindings(mf);await mf.dispose();}
});
test('temporary worker is disabled, fetch refuses, and unknown outcome leaves durable intent',async()=>{
 const mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:['SOURCE','TARGET','REFERENCE']});
 try{
 const db=syntheticD1Binding(mf,'TARGET');let calls=0;
 const api={...apiBase,authoritySchemaInventory:async()=>[],authoritySchemaDigest:async()=>'base',freezeAuthorityRestoreSource:async()=>{calls++;throw Error('response lost');}};
 const worker=createStorageMigrationWorker({api,contract,contractDigest,expiresAt:2000,frozenSource:true,clock:()=>1000});
 assert.equal(worker.fetch().status,404);await worker.scheduled({},{});assert.equal(calls,0);
 const pending=[];
 const env={STORAGE_RESTORE_MODE:'enabled',SOURCE:source,TARGET:db,STORAGE_RESTORE_QUEUE:{send:async body=>pending.push(body)}};
 await worker.scheduled({},env);assert.equal(calls,0);
 await assert.rejects(worker.queue({messages:[restoreMessage(pending[0])]},env),/response lost/);
 assert.equal(await db.prepare('SELECT intent FROM _authority_operator_progress').first('intent'),'freeze-source');
 await assert.rejects(worker.scheduled({},env),/RECONCILE_REQUIRED/);assert.equal(calls,1);
 const expired=createStorageMigrationWorker({api,contract,contractDigest,expiresAt:999,frozenSource:true,clock:()=>1000});
 await assert.rejects(expired.scheduled({},env),/CONFIGURATION_INVALID/);
 }finally{await closeSyntheticD1Bindings(mf);await mf.dispose();}
});
test('temporary worker claims one page under concurrent schedules and advances once',async()=>{
 const mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:['SOURCE','TARGET','REFERENCE']});
 try{
 const db=syntheticD1Binding(mf,'TARGET');let calls=0,release,started;
 const entered=new Promise(resolve=>{started=resolve;}),paused=new Promise(resolve=>{release=resolve;});
 const api={...apiBase,authoritySchemaInventory:async()=>[],authoritySchemaDigest:async()=>'base',freezeAuthorityRestoreSource:async()=>{calls++;started();await paused;}};
 const worker=createStorageMigrationWorker({api,contract,contractDigest,expiresAt:2000,frozenSource:true,clock:()=>1000});
 const pending=[];
 const env={STORAGE_RESTORE_MODE:'enabled',SOURCE:source,TARGET:db,STORAGE_RESTORE_QUEUE:{send:async body=>pending.push(body)}};
 await worker.scheduled({},env);
 const first=worker.queue({messages:[restoreMessage(pending[0])]},env);await entered;
 await assert.rejects(worker.queue({messages:[restoreMessage(pending[0])]},env),/RECONCILE_REQUIRED/);release();await first;
 assert.equal(calls,1);assert.deepEqual(await db.prepare('SELECT stage,steps,intent FROM _authority_operator_progress').first(),{stage:'begin',steps:1,intent:null});
 const unqualified=createStorageMigrationWorker({api,contract,contractDigest,expiresAt:2000,clock:()=>1000});
 await assert.rejects(unqualified.scheduled({},env),/CONFIGURATION_INVALID/);
 }finally{await closeSyntheticD1Bindings(mf);await mf.dispose();}
});
test('ingestion qualification binds tested restore base and complete ordered role inputs',async t=>{
 const {mkdtemp,mkdir,writeFile,rm,realpath}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {loadStorageQualification,storageSha256,storageSchemaDigest}=await import('./d1-storage-plan.mjs');
 const {INGESTION_ROLE_INPUT_DIRECTORIES}=await import('./d1-storage-role.mjs');
 const root=await realpath(await mkdtemp(join(tmpdir(),'storage-role-parser-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'.release-build/ingestion-role-migrations');await mkdir(directory,{recursive:true});
 const sourceCommit='a'.repeat(40),migrations=[];
 for(const name of INGESTION_ROLE_INPUT_DIRECTORIES){await mkdir(join(root,name));const sql='CREATE TABLE synthetic(id INTEGER PRIMARY KEY);';await writeFile(join(root,name,'0001_synthetic.sql'),sql);
  migrations.push({directory:name,name:'0001_synthetic.sql',sha256:storageSha256(sql),bytes:Buffer.byteLength(sql)});}
 const objects=['participants','device_credentials','upload_authorizations','accountless_enrollment_ledger','telemetry_contributions','telemetry_records',
  'telemetry_contribution_occurrences','typed_telemetry_records','typed_v1_admission_state','typed_v11_record_proofs','typed_v11_manifest_memberships','telemetry_v11_domain_heads',
  'storage_v11_owner_links','storage_legacy_event_sources','ingestion_analytics_separation','storage_v11_append_transitions']
  .map(name=>({type:'table',name,tbl_name:name,sql:`CREATE TABLE ${name}(id INTEGER PRIMARY KEY)`}));
 objects.push({type:'view',name:'typed_v11_record_admissions',tbl_name:'typed_v11_record_admissions',sql:'CREATE VIEW typed_v11_record_admissions AS SELECT * FROM typed_v11_record_proofs'});
 const inputs={schema:'d1-ingestion-role-inputs-v1',sourceCommit,frozen:true,migrations,inputSha256:identityDigest(migrations)};
 const finalRole=JSON.stringify(objects),roleInputs=JSON.stringify(inputs),base='CREATE TABLE synthetic(id INTEGER PRIMARY KEY);';
 await writeFile(join(directory,'final-role-schema.json'),finalRole);await writeFile(join(directory,'role-inputs.json'),roleInputs);await writeFile(join(directory,'0001_restore_base.sql'),base);
 // Synthetic parser fixture only: the actual generator is exercised separately
 // against real D1 and cannot qualify dirty source.
 const proof={schema:'d1-storage-restore-rehearsal-v1',status:'passed',scope:'synthetic-v11-authority-copy-and-bootstrap',runnerSha256:'b'.repeat(64),contractDigest:'c'.repeat(64),
  frozenSource:true,sourceCommit,runtimeReady:false,remoteOperations:false,finalRoleSchemaSha256:storageSha256(finalRole),roleInputsSha256:storageSha256(roleInputs),
  inputSha256:inputs.inputSha256,baseSqlSha256:storageSha256(base),finalSchemaSha256:storageSchemaDigest(objects),sourceRowsPreserved:true,typedEvidenceVerified:true,
  authorityVerified:true,finalRoleInstalled:true,publicSourceBootstrapComplete:true};
 const manifest={schema:'d1-storage-schema-qualification-v1',status:'qualified',role:'ingestion',directory:'.release-build/ingestion-role-migrations',sourceCommit,
  qualificationScope:'restore-base-schema-only',runtimeReady:false,finalRoleSchemaSha256:proof.finalRoleSchemaSha256,roleInputsSha256:proof.roleInputsSha256,
  migrations:[{name:'0001_restore_base.sql',sha256:storageSha256(base),beforeSchemaSha256:storageSchemaDigest([]),afterSchemaSha256:'d'.repeat(64)}]};
 const save=async()=>{const evidence=JSON.stringify(proof);await writeFile(join(directory,'qualification-evidence.json'),evidence);manifest.evidenceSha256=storageSha256(evidence);
  const bytes=JSON.stringify(manifest);await writeFile(join(directory,'qualification.json'),bytes);return {workerRoot:root,plan:{sourceCommit},target:{role:'ingestion',qualificationSha256:storageSha256(bytes)}};};
 assert.equal((await loadStorageQualification(await save())).migrations.length,1);
 proof.baseSqlSha256='f'.repeat(64);await assert.rejects(loadStorageQualification(await save()),/ROLE_QUALIFICATION_INVALID/);proof.baseSqlSha256=storageSha256(base);
 proof.frozenSource=false;await assert.rejects(loadStorageQualification(await save()),/ROLE_QUALIFICATION_INVALID/);proof.frozenSource=true;
 manifest.runtimeReady=true;await assert.rejects(loadStorageQualification(await save()),/ROLE_QUALIFICATION_INVALID/);manifest.runtimeReady=false;
 await writeFile(join(root,'ingestion-isolation-migrations','0001_synthetic.sql'),'changed');await assert.rejects(loadStorageQualification(await save()),/ROLE_INPUT_CHANGED/);
});
