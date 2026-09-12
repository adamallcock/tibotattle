import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { storageSha256, storageSchemaDigest } from './d1-storage-plan.mjs';
import { INGESTION_ROLE_INPUT_DIRECTORIES } from './d1-storage-role.mjs';
import { SYNTHETIC_D1_WORKER, syntheticD1Binding, closeSyntheticD1Bindings } from './d1-storage-local-d1.mjs';
import { MAINTENANCE_CUTOVER_PROOF_SQL, validateMaintenanceCutoverProof, verifyMaintenanceCutoverProof } from './production-maintenance-cutover-proof.mjs';

const workerRoot=fileURLToPath(new URL('..',import.meta.url)),sourceCommit='a'.repeat(40),namespace='synthetic:cutover',sourceId='synthetic-source';
const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004'];
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name").all().map(row=>({...row}));
const normalized=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Uint8Array?Array.from(value):value])));
const quote=name=>`"${name.replaceAll('"','""')}"`;
let apiPromise;
const api=()=>apiPromise??=(async()=>{const built=await build({stdin:{contents:"export {AUTHORITY_RESTORE_SCHEMA} from './authority-restore-schema'; export {authorityRestoreRetainedTableNames} from './authority-restore'; export {encodeTypedTelemetryId} from './typed-telemetry-codec'; export {participantDeletionDigest} from './participant-deletion-digest';",resolveDir:join(workerRoot,'src'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',mainFields:['module','main'],logLevel:'silent'});return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);})();
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'maintenance-proof-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const databases=ids.map(()=>new DatabaseSync(':memory:'));t.after(()=>databases.forEach(db=>db.close()));
 const [source,target,analytics,ledger]=databases,maintained=await api(),inputs=[];
 const apply=async(db,directory)=>{for(const name of (await readdir(join(workerRoot,directory))).filter(name=>name.endsWith('.sql')).sort())db.exec(await readFile(join(workerRoot,directory,name),'utf8'));};
 await apply(source,'migrations');
 for(const directory of INGESTION_ROLE_INPUT_DIRECTORIES){
  await mkdir(join(root,directory),{recursive:true});
  for(const name of (await readdir(join(workerRoot,directory))).filter(name=>name.endsWith('.sql')).sort()){
   const sql=await readFile(join(workerRoot,directory,name));target.exec(sql.toString());await writeFile(join(root,directory,name),sql);
   inputs.push({directory,name,sha256:storageSha256(sql),bytes:sql.length});
  }
 }
 const finalRole=schema(target),operatorSQL='CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT';
 target.exec(operatorSQL);
 const baseSQL='CREATE TABLE fixture_restore_base(id INTEGER PRIMARY KEY);',operatorRows=[{name:'0001_restore_base.sql',sha256:storageSha256(baseSQL)}];
 target.prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').run(operatorRows[0].name,operatorRows[0].sha256);
 const finalSchema=schema(target),retained=new Set(maintained.authorityRestoreRetainedTableNames()),sourceSchema=schema(source);
 const tables=sourceSchema.filter(row=>row.type==='table').map(row=>({name:row.name,disposition:retained.has(row.name)?'authority':row.name==='telemetry_v1_records'?'typed-v1':row.name==='telemetry_v11_records'?'typed-v11':'analytics'}));
 const authoritySequences=sourceSchema.filter(row=>row.type==='table'&&(retained.has(row.name)||row.name==='telemetry_v1_records')&&/\bAUTOINCREMENT\b/.test(row.sql)).map(row=>({name:row.name,sequence:0})).sort((a,b)=>a.name<b.name?-1:1);
 const contract={version:'authority-restore-v1',runId:'synthetic-copy',sourceId,sourceNamespace:namespace,sourceSnapshotDigest:'b'.repeat(64),
  sourceSchema,sourceSchemaDigest:identityDigest(sourceSchema),targetBaseSchema:[],targetBaseSchemaDigest:identityDigest([]),targetOperatorLedgerDigest:identityDigest(operatorRows),
  tables,finalSchema,finalSchemaDigest:identityDigest(finalSchema),typedCopies:['v1','v11'].map(format=>({runId:`synthetic-${format}`,sourceNamespace:namespace,sourceSnapshotDigest:'b'.repeat(64),format})),
  admissionContract:'typed-v1-v11-restore-v1',authoritySequences,operatingLimitBytes:9_000_000_000};
 const contractDigest=identityDigest(contract),contractBytes=JSON.stringify(contract);
 const restoreContractPath=join(root,'contract.json');await writeFile(restoreContractPath,contractBytes,{mode:0o600});
 source.exec('CREATE TABLE _authority_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,namespace TEXT NOT NULL,snapshot_digest TEXT NOT NULL) STRICT');
 source.prepare('INSERT INTO _authority_snapshot VALUES(1,?,?,?)').run(contractDigest,namespace,contract.sourceSnapshotDigest);
 for(const name of [...tables.map(row=>row.name),'_authority_snapshot'])for(const verb of ['INSERT','UPDATE','DELETE'])source.exec(`CREATE TRIGGER ${quote(`_authority_freeze_${verb.toLowerCase()}_${name}`)} BEFORE ${verb} ON ${quote(name)} BEGIN SELECT RAISE(ABORT,'AUTHORITY_SNAPSHOT_FROZEN'); END`);
 // These are protocol-verifier fixtures, not forged release qualifications.
 // Apply the real application schemas, then construct a sealed empty-copy
 // state before installing its actual guards. Full copying/runtime has its own
 // maintained native D1 qualification; this suite attacks admission readbacks.
 const triggers=schema(target).filter(row=>row.type==='trigger');for(const row of triggers)target.exec(`DROP TRIGGER ${quote(row.name)}`);
 for(const sql of maintained.AUTHORITY_RESTORE_SCHEMA)target.exec(sql);
 target.prepare("INSERT INTO _authority_restore_run VALUES(1,?,?,?,'ready')").run(contract.runId,contractDigest,contract.operatingLimitBytes);
 let ordinal=0;for(const row of tables.filter(row=>row.disposition==='authority').sort((a,b)=>a.name<b.name?-1:1)){
  const count=source.prepare(`SELECT count(*) n FROM ${quote(row.name)}`).get().n;
  target.prepare("INSERT INTO _authority_restore_tables(name,ordinal,descriptor,copied,verified,copy_done,verify_done) VALUES(?,?,?, ?,?,1,1)").run(row.name,ordinal++,'{}',count,count);
 }
 for(const row of finalSchema)target.prepare('INSERT INTO _authority_restore_expected(name,type,tbl_name,sql) VALUES(?,?,?,?)').run(row.name,row.type,row.tbl_name,row.sql);
 for(const format of ['v1','v11']){
  target.prepare('INSERT INTO _authority_restore_typed VALUES(?,?,0,0,1)').run(format,`synthetic-${format}`);
  target.prepare('INSERT INTO storage_raw_copy_runs VALUES(?,?,?,?,0,0)').run(`synthetic-${format}`,namespace,contract.sourceSnapshotDigest,format);
  target.prepare('INSERT INTO _authority_restore_adoption VALUES(?,0,0,0,1,0,0,1)').run(format);
 }
 target.prepare('INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?)').run(maintained.encodeTypedTelemetryId(namespace));
 for(const format of ['v1','v11'])target.prepare(`INSERT INTO typed_${format}_admission_state(id,source_namespace,namespace_id,next_source_row_id,runtime_contract_version) VALUES(1,?,1,1,1)`).run(namespace);
 target.prepare('INSERT INTO storage_source_state VALUES(1,?,0)').run(sourceId);
 target.exec("CREATE TABLE _authority_operator_progress(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,stage TEXT,steps INTEGER NOT NULL CHECK(steps>=0),intent TEXT) STRICT");
 target.prepare('INSERT INTO _authority_operator_progress VALUES(1,?,NULL,19,NULL)').run(contractDigest);
 target.exec("CREATE TABLE _authority_restore_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,\n phase TEXT NOT NULL CHECK(phase IN ('walking','complete')),participant_cursor TEXT NOT NULL,chunk_cursor TEXT NOT NULL) STRICT");
 target.exec('CREATE TABLE _authority_restore_bootstrap_assert(id INTEGER CHECK(id=0)) STRICT');
 target.prepare("INSERT INTO _authority_restore_bootstrap VALUES(1,?,'complete','','')").run(contractDigest);
 target.exec("INSERT INTO community_public_source_bootstrap(singleton,policy_version,participant_cursor,source_day_cursor,completed) VALUES(1,'community-public-sources-v1','','',1) ON CONFLICT(singleton) DO UPDATE SET completed=1");
 for(const row of triggers)target.exec(row.sql);
 const proofDirectory=join(root,'.release-build/ingestion-role-migrations');await mkdir(proofDirectory,{recursive:true});
 const roleBytes=JSON.stringify(finalRole),roleInput={schema:'d1-ingestion-role-inputs-v1',sourceCommit,frozen:true,migrations:inputs,inputSha256:identityDigest(inputs)},inputBytes=JSON.stringify(roleInput);
 await writeFile(join(proofDirectory,'final-role-schema.json'),roleBytes);await writeFile(join(proofDirectory,'role-inputs.json'),inputBytes);await writeFile(join(proofDirectory,'0001_restore_base.sql'),baseSQL);
 const qualificationEvidence={schema:'d1-storage-restore-rehearsal-v1',status:'passed',scope:'synthetic-v11-authority-copy-and-bootstrap',runnerSha256:'c'.repeat(64),contractDigest,
  frozenSource:true,sourceCommit,runtimeReady:false,remoteOperations:false,finalRoleSchemaSha256:storageSha256(roleBytes),roleInputsSha256:storageSha256(inputBytes),inputSha256:roleInput.inputSha256,
  baseSqlSha256:storageSha256(baseSQL),finalSchemaSha256:storageSchemaDigest(finalRole),sourceRowsPreserved:true,typedEvidenceVerified:true,authorityVerified:true,finalRoleInstalled:true,publicSourceBootstrapComplete:true};
 const evidenceBytes=JSON.stringify(qualificationEvidence);await writeFile(join(proofDirectory,'qualification-evidence.json'),evidenceBytes);
 const qualification={schema:'d1-storage-schema-qualification-v1',status:'qualified',role:'ingestion',directory:'.release-build/ingestion-role-migrations',sourceCommit,evidenceSha256:storageSha256(evidenceBytes),
  qualificationScope:'restore-base-schema-only',runtimeReady:false,finalRoleSchemaSha256:storageSha256(roleBytes),roleInputsSha256:storageSha256(inputBytes),migrations:[{name:operatorRows[0].name,sha256:operatorRows[0].sha256,beforeSchemaSha256:storageSchemaDigest([]),afterSchemaSha256:storageSchemaDigest([])}]};
 const qualificationBytes=JSON.stringify(qualification);await writeFile(join(proofDirectory,'qualification.json'),qualificationBytes);
 const analyticDirectory=join(root,'analytics-migrations');await mkdir(analyticDirectory);const analyticSteps=[];
 for(const name of (await readdir(join(workerRoot,'analytics-migrations'))).filter(name=>name.endsWith('.sql')).sort()){
  const sql=await readFile(join(workerRoot,'analytics-migrations',name)),beforeSchemaSha256=storageSchemaDigest(schema(analytics));analytics.exec(sql.toString());
  await writeFile(join(analyticDirectory,name),sql);analyticSteps.push({name,sha256:storageSha256(sql),beforeSchemaSha256,afterSchemaSha256:storageSchemaDigest(schema(analytics))});
 }
 const analyticManifest={schema:'d1-storage-schema-qualification-v1',status:'qualified',role:'analytics',directory:'analytics-migrations',sourceCommit,evidenceSha256:storageSha256('{}'),migrations:analyticSteps};
 const analyticBytes=JSON.stringify(analyticManifest);await writeFile(join(analyticDirectory,'qualification.json'),analyticBytes);await writeFile(join(analyticDirectory,'qualification-evidence.json'),'{}');
 analytics.exec(operatorSQL);for(const step of analyticSteps)analytics.prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').run(step.name,step.sha256);
 analytics.prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').run(sourceId,namespace);
 const ledgerDirectory=join(root,'deletion-ledger-migrations');await mkdir(ledgerDirectory);const ledgerInputs=[];
 for(const name of (await readdir(join(workerRoot,'deletion-ledger-migrations'))).filter(name=>name.endsWith('.sql')).sort()){
  const sql=await readFile(join(workerRoot,'deletion-ledger-migrations',name));ledger.exec(sql.toString());await writeFile(join(ledgerDirectory,name),sql);ledgerInputs.push({name,sha256:storageSha256(sql)});
 }
 ledger.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
 for(const row of ledgerInputs)ledger.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(row.name);
 const deletedDigest=await maintained.participantDeletionDigest('synthetic-deleted-owner');
 ledger.prepare("INSERT INTO deletion_tombstones VALUES(?,'participant-deletion-tombstone-v0.1','2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z')").run(deletedDigest);
 const ledgerState={tombstones:normalized(ledger.prepare('SELECT * FROM deletion_tombstones ORDER BY participant_digest').all()),cooldowns:[],jobs:[]};
 const ledgerSchemaPath=join(root,'ledger-schema.json'),ledgerSchemaBytes=JSON.stringify(schema(ledger));await writeFile(ledgerSchemaPath,ledgerSchemaBytes,{mode:0o600});
 const proof={schema:'production-maintenance-typed-proof-v1',restoreContractSha256:storageSha256(contractBytes),restoreContractDigest:contractDigest,ingestionQualificationSha256:storageSha256(qualificationBytes),analyticsQualificationSha256:storageSha256(analyticBytes),
  ledgerSchemaFileSha256:storageSha256(ledgerSchemaBytes),ledgerMigrationInputsSha256:identityDigest(ledgerInputs),ledgerStateSha256:identityDigest(ledgerState)};
 const calls=[],options={plan:{databaseId:ids[0]},cutover:{candidate:{sourceCommit,ingestionDatabaseId:ids[1],analyticsDatabaseId:ids[2],deletionLedgerDatabaseId:ids[3],sourceNamespace:namespace,sourceId},proof},qualificationRoot:root,restoreContractPath,ledgerSchemaPath,
  readDatabase:async(id,sql,params)=>{assert.ok(MAINTENANCE_CUTOVER_PROOF_SQL.includes(sql));calls.push({id,sql,params});return {success:true,results:normalized(databases[ids.indexOf(id)].prepare(sql).all(...params)),meta:{size_after:8_000_000}};}};
 return {root,options,databases,source,target,analytics,ledger,proof,contract,calls,deletedDigest,run:()=>verifyMaintenanceCutoverProof(options)};
}

test('closed descriptor, binding and source pins fail before database reads',async t=>{
 const f=await fixture(t);assert.deepEqual(validateMaintenanceCutoverProof(f.proof),f.proof);
 for(const proof of [{...f.proof,ready:true},{...f.proof,restoreContractDigest:'invalid'}])assert.throws(()=>validateMaintenanceCutoverProof(proof));
 f.options.cutover.candidate.analyticsDatabaseId=ids[1];await assert.rejects(f.run(),/BINDINGS/);assert.equal(f.calls.length,0);
});
test('actual schema and bounded SQL observations admit copy/bootstrap and independent deletion coverage',async t=>{
 const f=await fixture(t),receipt=await f.run();assert.equal(receipt.status,'verified');assert.equal(receipt.admissionOnly,true);assert.equal(receipt.httpRuntimeVerified,false);
 assert.equal(receipt.oldSourceRollbackPermitted,false);assert.equal(receipt.journalSequence,0);assert.ok(receipt.queries<100);
 assert.equal(receipt.stage,'full');assert.equal(receipt.analyticsCaughtUp,true);
 assert.equal(receipt.ledgerStateSha256,f.proof.ledgerStateSha256);assert.ok(!JSON.stringify(receipt).includes(f.deletedDigest));
 assert.ok(f.calls.every(call=>/^SELECT|^PRAGMA foreign_key_check$/.test(call.sql)));
});
test('pre-analytics is explicit, cannot bless a wrong registration or incomplete privacy reconciliation',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 f.options.readDatabase=async(...args)=>{const result=await read(...args);if(args[1].includes('FROM analytics_runtime_sources'))result.results=[];return result;};
 await assert.rejects(f.run(),/ANALYTICS_RUNTIME/);
 const receipt=await verifyMaintenanceCutoverProof({...f.options,stage:'pre-analytics'});
 assert.equal(receipt.stage,'pre-analytics');assert.equal(receipt.analyticsCaughtUp,false);assert.equal(receipt.httpRuntimeVerified,false);
 await assert.rejects(verifyMaintenanceCutoverProof({...f.options,stage:'partial'}),/PROOF_STAGE/);
 f.options.readDatabase=async(...args)=>{const result=await read(...args);if(args[1].includes('FROM analytics_runtime_sources'))result.results=[{source_id:sourceId,source_namespace:'wrong',contract_version:1}];return result;};
 await assert.rejects(verifyMaintenanceCutoverProof({...f.options,stage:'pre-analytics'}),/ANALYTICS_RUNTIME/);
 f.options.readDatabase=read;
 f.ledger.prepare('INSERT INTO storage_erasure_jobs(participant_digest,source_id,owner_digest,source_namespace,state) VALUES(?,?,?,?,?)').run(f.deletedDigest,sourceId,'8'.repeat(64),namespace,'pending');
 await assert.rejects(verifyMaintenanceCutoverProof({...f.options,stage:'pre-analytics'}),/LEDGER_PENDING/);
});
test('source freeze, exact restore metadata, pending intent and copy verification cannot be omitted',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 const cases=[
  [sql=>sql.includes('sqlite_schema'),value=>value.filter(row=>row.name!=='_authority_freeze_update_participants'),ids[0]],
  [sql=>sql.includes('sqlite_schema'),value=>value.filter(row=>row.name!=='_authority_restore_run_guard'),ids[1]],
  [sql=>sql.includes('FROM _authority_operator_progress'),value=>value.map(row=>({...row,intent:'bootstrap'})),ids[1]],
  [sql=>sql.includes('FROM _authority_restore_tables'),value=>value.map((row,i)=>i?row:{...row,verify_done:0}),ids[1]],
  [sql=>sql.includes('FROM _authority_restore_typed'),value=>value.map((row,i)=>i?row:{...row,verified:1}),ids[1]],
  [sql=>sql.includes('FROM _authority_restore_adoption'),value=>value.map((row,i)=>i?row:{...row,verify_done:0}),ids[1]],
  [sql=>sql.includes('FROM _authority_restore_bootstrap'),value=>value.map(row=>({...row,phase:'walking'})),ids[1]],
 ];
 for(const [match,change,id] of cases){f.options.readDatabase=async(...args)=>{const value=await read(...args);if(args[0]===id&&match(args[1]))value.results=change(value.results);return value;};await assert.rejects(f.run(),/PRODUCTION_MAINTENANCE_PROOF_/);}
});
test('schema-qualified empty alternate ledger and resurrected owner refuse',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 f.options.readDatabase=async(...args)=>{const value=await read(...args);if(args[0]===ids[1]&&args[1].startsWith('SELECT id FROM participants'))value.results=[{id:'synthetic-deleted-owner'}];return value;};
 await assert.rejects(f.run(),/DELETED_OWNER_PRESENT/);
 f.options.readDatabase=read;f.ledger.prepare('DELETE FROM deletion_tombstones').run();await assert.rejects(f.run(),/LEDGER_CHANGED/);
});
test('retained cooldowns require primary coverage and pending erasure cannot be asserted complete',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 const cooldown={identity_cooldown_digest:'9'.repeat(64),schema_version:'identity-reenrollment-cooldown-v0.1',deleted_at:'2026-01-01T00:00:00.000Z',retain_until:'2027-01-01T00:00:00.000Z'};
 f.ledger.prepare('INSERT INTO identity_reenrollment_cooldowns VALUES(?,?,?,?)').run(...Object.values(cooldown));
 f.proof.ledgerStateSha256=identityDigest({tombstones:normalized(f.ledger.prepare('SELECT * FROM deletion_tombstones').all()),cooldowns:[cooldown],jobs:[]});
 await assert.rejects(f.run(),/COOLDOWN_COVERAGE/);
 f.options.readDatabase=async(...args)=>{const value=await read(...args);if(args[0]===ids[1]&&args[1].startsWith('SELECT identity_cooldown_digest'))value.results=[cooldown];return value;};
 assert.equal((await f.run()).status,'verified');
 f.ledger.prepare('INSERT INTO storage_erasure_jobs(participant_digest,source_id,owner_digest,source_namespace,state) VALUES(?,?,?,?,?)').run(f.deletedDigest,sourceId,'8'.repeat(64),namespace,'pending');
 await assert.rejects(f.run(),/LEDGER_PENDING/);
});
test('completed erasure requires the exact retained terminal and actual target physical completion receipt',async t=>{
 const f=await fixture(t),owner='8'.repeat(64),event='7'.repeat(64);
 const terminal={sourceId,sequence:2,eventDigest:event,ownerDigest:owner,revision:2,kind:'owner-erased',objectDigest:'6'.repeat(64),contentDigest:'5'.repeat(64),authorityEpoch:2,publicAuthorityEpoch:2,recordedMs:1000};
 f.ledger.prepare('INSERT INTO storage_erasure_jobs VALUES(?,?,?,?,?,?,?,?)').run(f.deletedDigest,sourceId,owner,namespace,'complete',JSON.stringify(terminal),'2026-01-02T00:00:00.000Z',1000);
 f.proof.ledgerStateSha256=identityDigest({tombstones:normalized(f.ledger.prepare('SELECT * FROM deletion_tombstones').all()),cooldowns:[],jobs:normalized(f.ledger.prepare('SELECT * FROM storage_erasure_jobs').all())});
 // Real delivery triggers produce owner states and cursors. Another owner's
 // later event ensures the erased owner's terminal is not the current head.
 for(const values of [
  [1,'4'.repeat(64),owner,1,'owner-active','6'.repeat(64),'5'.repeat(64),1,1,900],
  [2,event,owner,2,'owner-erased',terminal.objectDigest,terminal.contentDigest,2,2,1000],
  [3,'3'.repeat(64),'2'.repeat(64),1,'owner-active','1'.repeat(64),'0'.repeat(64),1,3,1100],
 ]){
  f.target.prepare('INSERT INTO storage_ingestion_changes VALUES(?,?,?,?,?,?,?,?,?,?)').run(...values);
  f.analytics.prepare('INSERT INTO analytics_applied_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(sourceId,...values);
 }
 await assert.rejects(f.run(),/ERASURE_INCOMPLETE/);
 f.analytics.prepare('INSERT INTO analytics_storage_erasure_fences VALUES(?,?,?,?,?,?,?)').run(sourceId,owner,event,2,2,2,2);
 f.analytics.prepare('INSERT INTO analytics_storage_erasure_receipts VALUES(?,?,?,1)').run(sourceId,owner,event);
 const receipt=await f.run();assert.equal(receipt.journalSequence,3);assert.equal(receipt.status,'verified');
 // The ledger's own trigger already refuses terminal changes. Also refuse a
 // malformed persisted/readback observation even with a freshly pinned digest.
 assert.throws(()=>f.ledger.prepare('UPDATE storage_erasure_jobs SET terminal_json=?').run(JSON.stringify({...terminal,recordedMs:1001})),/storage_erasure_job_conflict/);
 const read=f.options.readDatabase,ledgerState=f.proof.ledgerStateSha256;
 const changedJobs=normalized(f.ledger.prepare('SELECT * FROM storage_erasure_jobs').all()).map(row=>({...row,terminal_json:JSON.stringify({...terminal,recordedMs:1001})}));
 f.options.readDatabase=async(...args)=>{const result=await read(...args);if(args[0]===ids[3]&&args[1].includes('FROM storage_erasure_jobs'))result.results=changedJobs;return result;};
 f.proof.ledgerStateSha256=identityDigest({tombstones:normalized(f.ledger.prepare('SELECT * FROM deletion_tombstones').all()),cooldowns:[],jobs:changedJobs});
 await assert.rejects(f.run(),/ERASURE_TERMINAL_SOURCE/);
 f.options.readDatabase=read;f.proof.ledgerStateSha256=ledgerState;
 // A durable completed ledger bit cannot replace missing physical evidence.
 f.analytics.prepare('DELETE FROM analytics_storage_erasure_receipts').run();
 await assert.rejects(f.run(),/ERASURE_INCOMPLETE/);
});
test('future allocator, mismatched namespace, incomplete analytic cursor and runtime registration refuse',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 for(const [match,change,id] of [
  [sql=>sql.startsWith("SELECT 'v1' format,s.source_namespace"),value=>value.map((row,i)=>i?row:{...row,next_source_row_id:2}),ids[1]],
  [sql=>sql.startsWith("SELECT 'v1' format,s.source_namespace"),value=>value.map((row,i)=>i?row:{...row,namespace_hex:'FF'}),ids[1]],
  [sql=>sql.includes('FROM analytics_runtime_sources'),value=>value.map(row=>({...row,source_namespace:'different'})),ids[2]],
  [sql=>sql.includes('FROM analytics_source_cursors'),()=>[{sequence:1,authority_epoch:1}],ids[2]],
  [sql=>sql.includes('FROM analytics_owner_state'),()=>[{owner_digest:'d'.repeat(64),revision:1,authority_epoch:1,state:'active'}],ids[2]],
 ]){f.options.readDatabase=async(...args)=>{const value=await read(...args);if(args[0]===id&&match(args[1]))value.results=change(value.results);return value;};await assert.rejects(f.run(),/PRODUCTION_MAINTENANCE_PROOF_/);}
});
test('fresh fences detect source, target and ledger changes during the read window',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 for(const [id,match,change] of [
  [ids[0],sql=>sql.includes('FROM _authority_snapshot'),rows=>rows.map(row=>({...row,snapshot_digest:'e'.repeat(64)}))],
  [ids[1],sql=>sql.includes('FROM storage_source_state'),rows=>rows.map(row=>({...row,authority_epoch:1}))],
  [ids[3],sql=>sql.includes('FROM deletion_tombstones'),()=>[]],
  [ids[1],sql=>sql.includes('FROM sqlite_schema'),rows=>rows.filter(row=>row.name!=='typed_telemetry_records')],
 ]){let seen=0;f.options.readDatabase=async(...args)=>{const result=await read(...args);if(args[0]===id&&match(args[1])&&++seen===2)result.results=change(result.results);return result;};await assert.rejects(f.run(),/PRODUCTION_MAINTENANCE_PROOF_/);}
});
test('failed, oversized, malformed and capacity-exceeded reads never emit admitted evidence',async t=>{
 const f=await fixture(t),read=f.options.readDatabase;
 for(const modify of [value=>({...value,success:false}),value=>({...value,results:null}),value=>({...value,results:Array.from({length:10001},()=>({}))})]){
  f.options.readDatabase=async(...args)=>modify(await read(...args));await assert.rejects(f.run(),/PRODUCTION_MAINTENANCE_PROOF_/);
 }
 f.options.readDatabase=async(...args)=>{const value=await read(...args);value.meta.size_after=9_000_000_001;return value;};await assert.rejects(f.run(),/CAPACITY/);
 f.options.readDatabase=read;await writeFile(f.options.restoreContractPath,'{}');await assert.rejects(f.run(),/FILE_CHANGED/);
});
test('fixed queries run unchanged through the existing native D1 transport', {timeout:60000},async t=>{
 const f=await fixture(t),mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:['SOURCE','TARGET','ANALYTICS','LEDGER']});
 try{
  const natives=['SOURCE','TARGET','ANALYTICS','LEDGER'].map(binding=>syntheticD1Binding(mf,binding));
  for(const [index,db] of f.databases.entries()){
   const objects=schema(db),native=natives[index];
   for(const type of ['table','index','view']){const statements=objects.filter(row=>row.type===type).map(row=>native.prepare(row.sql));if(statements.length)await native.batch(statements);}
   const inserts=[];for(const table of objects.filter(row=>row.type==='table'))for(const row of db.prepare(`SELECT * FROM ${quote(table.name)}`).all()){
    const keys=Object.keys(row);inserts.push(native.prepare(`INSERT INTO ${quote(table.name)}(${keys.map(quote).join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...Object.values(row)));
   }
   if(inserts.length)await native.batch(inserts);
   const triggers=objects.filter(row=>row.type==='trigger').map(row=>native.prepare(row.sql));if(triggers.length)await native.batch(triggers);
  }
  f.options.readDatabase=(id,sql,params)=>natives[ids.indexOf(id)].prepare(sql).bind(...params).all();
  const receipt=await f.run();assert.equal(receipt.status,'verified');assert.ok(receipt.queries<100);
 }finally{await closeSyntheticD1Bindings(mf);await mf.dispose();}
});
