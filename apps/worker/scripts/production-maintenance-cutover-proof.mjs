import { constants } from 'node:fs';
import { open, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { MIGRATION_JOURNAL_DDL } from './d1-storage-migration-worker.mjs';
import { identityDigest, operationError } from '../../../scripts/lib/release-operation.mjs';
import { loadStorageQualification, storageSchemaDigest, storageSha256, D1_STORAGE_SCHEMA_DIRECTORIES } from './d1-storage-plan.mjs';

const fail = suffix => { throw operationError(`PRODUCTION_MAINTENANCE_PROOF_${suffix}`); };
const SHA=/^[a-f0-9]{64}$/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, MAX_ROWS=10_000, MAX_BYTES=16*1024*1024;
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.split(' ').sort().join())fail('SHAPE');};
const integer=value=>{if(!Number.isSafeInteger(value)||value<0)fail('COUNTER');return value;};
const equal=(actual,expected,code)=>{if(identityDigest(actual)!==identityDigest(expected))fail(code);};
const text=(value,max=256)=>{if(typeof value!=='string'||!value.length||value.length>max)fail('VALUE');return value;};
const instant=value=>{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail('TIME');return value;};
const one=rows=>{if(rows.length!==1)fail('CARDINALITY');return rows[0];};
const q=name=>{if(!NAME.test(name))fail('IDENTIFIER');return `"${name}"`;};

// Fixed read-only statements. The provider must also restrict database UUIDs to
// this operation's four explicit bindings. No caller-supplied SQL is admitted.
const SQL=Object.freeze({
 schema:"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 4097",
 fk:'PRAGMA foreign_key_check',
 capacity:'SELECT 1 AS capacity_probe',
 sourceSnapshot:'SELECT contract_digest,namespace,snapshot_digest FROM _authority_snapshot WHERE id=1',
 sequences:'SELECT name,seq FROM sqlite_sequence ORDER BY name LIMIT 129',
 sourceCounts:"SELECT 'v1' format,count(*) records,COALESCE(max(id),0) last_id FROM telemetry_v1_records UNION ALL SELECT 'v11',count(*),COALESCE(max(rowid),0) FROM telemetry_v11_records",
 progress:'SELECT contract_digest,execution_digest,stage,steps,intent FROM _authority_operator_progress WHERE id=1',
 restore:'SELECT run_id,contract_digest,limit_bytes,phase FROM _authority_restore_run WHERE id=1',
 tables:'SELECT name,copied,verified,copy_done,verify_done,copy_cursor,verify_cursor FROM _authority_restore_tables ORDER BY name LIMIT 129',
 typed:'SELECT format,run_id,verify_cursor,verified,done FROM _authority_restore_typed ORDER BY format LIMIT 3',
 copies:'SELECT run_id,source_namespace,source_snapshot_digest,format,last_source_row_id,copied_rows FROM storage_raw_copy_runs ORDER BY format LIMIT 3',
 adoption:'SELECT format,high_water,after_id,copied,done,verify_after,verified,verify_done FROM _authority_restore_adoption ORDER BY format LIMIT 3',
 expected:'SELECT type,name,tbl_name,sql FROM _authority_restore_expected ORDER BY type,name LIMIT 1025',
 permission:'SELECT count(*) n FROM _authority_restore_permission',
 bootstrap:'SELECT contract_digest,phase FROM _authority_restore_bootstrap WHERE id=1',
 publicBootstrap:'SELECT policy_version,completed FROM community_public_source_bootstrap WHERE singleton=1',
 admission:"SELECT 'v1' format,s.source_namespace,s.namespace_id,s.next_source_row_id,s.runtime_contract_version,hex(n.original_id) namespace_hex FROM typed_v1_admission_state s JOIN typed_telemetry_namespaces n ON n.id=s.namespace_id WHERE s.id=1 UNION ALL SELECT 'v11',s.source_namespace,s.namespace_id,s.next_source_row_id,s.runtime_contract_version,hex(n.original_id) FROM typed_v11_admission_state s JOIN typed_telemetry_namespaces n ON n.id=s.namespace_id WHERE s.id=1",
 separation:'SELECT phase,policy_revision,empty_source_check FROM ingestion_analytics_separation WHERE id=1',
 operatorLedger:'SELECT name,sha256 FROM d1_storage_migrations ORDER BY name LIMIT 129',
 migrations:'SELECT id,name,applied_at FROM d1_migrations ORDER BY id LIMIT 129',
 participants:'SELECT id FROM participants ORDER BY id LIMIT 10001',
 primaryCooldowns:'SELECT identity_cooldown_digest,schema_version,deleted_at,retain_until FROM identity_reenrollment_cooldowns ORDER BY identity_cooldown_digest LIMIT 10001',
 tombstones:'SELECT participant_digest,schema_version,deleted_at,retain_until FROM deletion_tombstones ORDER BY participant_digest LIMIT 10001',
 cooldowns:'SELECT identity_cooldown_digest,schema_version,deleted_at,retain_until FROM identity_reenrollment_cooldowns ORDER BY identity_cooldown_digest LIMIT 10001',
 jobs:'SELECT participant_digest,source_id,owner_digest,source_namespace,state,terminal_json,completed_at,attempted_ms FROM storage_erasure_jobs ORDER BY participant_digest,source_id,owner_digest LIMIT 10001',
 sourceState:'SELECT source_id,authority_epoch FROM storage_source_state WHERE singleton=1',
 sourceHead:'SELECT sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms FROM storage_ingestion_changes ORDER BY sequence DESC LIMIT 1',
 sourceOwners:'SELECT owner_digest,revision,authority_epoch,state FROM storage_owner_revisions ORDER BY owner_digest LIMIT 10001',
 erasureTerminal:"SELECT 1 AS complete FROM storage_ingestion_changes WHERE sequence=? AND event_digest=? AND owner_digest=? AND revision=? AND kind='owner-erased' AND object_digest=? AND content_digest=? AND authority_epoch=? AND public_authority_epoch=? AND recorded_ms=?",
 runtime:'SELECT source_id,source_namespace,contract_version FROM analytics_runtime_sources ORDER BY source_id LIMIT 2',
 cursor:'SELECT sequence,authority_epoch FROM analytics_source_cursors WHERE source_id=?',
 appliedHead:'SELECT sequence,event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms FROM analytics_applied_events WHERE source_id=? ORDER BY sequence DESC LIMIT 1',
 appliedRange:'SELECT count(*) n,COALESCE(min(sequence),0) first_sequence,COALESCE(max(sequence),0) last_sequence FROM analytics_applied_events WHERE source_id=?',
 analyticOwners:'SELECT owner_digest,revision,authority_epoch,state FROM analytics_owner_state WHERE source_id=? ORDER BY owner_digest LIMIT 10001',
 // Same physical completion contract as storage-erasure.ts readCompletion.
 // Its public helper may advance/reopen jobs, so this admission uses only the
 // explicit read-side proof, never that mutating lifecycle entrypoint.
 erasureCompletion:`SELECT 1 AS complete FROM analytics_storage_erasure_receipts r
 JOIN analytics_storage_erasure_fences f ON f.source_id=r.source_id AND f.owner_digest=r.owner_digest
 AND f.terminal_event_digest=r.terminal_event_digest
 WHERE r.source_id=?1 AND r.owner_digest=?2 AND r.terminal_event_digest=?3 AND r.payload_contract=1 AND f.public_authority_epoch=?4
 AND NOT EXISTS(SELECT 1 FROM analytics_v1_chunk_values WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_v11_value_pages WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_results WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_execution WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_publications WHERE source_id=?1 AND COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?4)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_model_publications WHERE source_id=?1 AND COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?4)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_previews WHERE source_id=?1 AND COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?4)`,
});
export const MAINTENANCE_CUTOVER_PROOF_SQL=Object.freeze([...new Set(Object.values(SQL))]);

export function validateMaintenanceCutoverProof(proof){
 exact(proof,'schema restoreContractSha256 restoreContractDigest migrationExecutionDigest ingestionQualificationSha256 analyticsQualificationSha256 ledgerSchemaFileSha256 ledgerMigrationInputsSha256 ledgerStateSha256');
 if(proof.schema!=='production-maintenance-typed-proof-v1'||Object.entries(proof).some(([key,value])=>key!=='schema'&&(typeof value!=='string'||!SHA.test(value))))fail('DESCRIPTOR');
 return structuredClone(proof);
}

async function file(path,expectedHash,max=MAX_BYTES){
 const absolute=resolve(path);if(await realpath(absolute)!==absolute)fail('FILE_UNSAFE');
 const handle=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size>max)fail('FILE_UNSAFE');
  const bytes=await handle.readFile(),after=await handle.stat();
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size)fail('FILE_CHANGED');
  if(expectedHash&&storageSha256(bytes)!==expectedHash)fail('FILE_CHANGED');
  return bytes;
 }finally{await handle.close();}
}
const parse=bytes=>{try{return JSON.parse(bytes);}catch{fail('JSON');}};

// Reuse the maintained restore guard definitions, namespace codec, privacy
// digest and source policy. This small trusted-source bundle is memory-only;
// no test module, generated receipt, credential or remote code is evaluated.
let primitives;
async function maintained(){
 if(!primitives)primitives=(async()=>{
  const result=await build({stdin:{contents:"export {AUTHORITY_RESTORE_SCHEMA} from './authority-restore-schema'; export {authorityRestoreRetainedTableNames} from './authority-restore'; export {participantDeletionDigest} from './participant-deletion-digest'; export {encodeTypedTelemetryId} from './typed-telemetry-codec'; export {COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION} from './telemetry-v1-source-selection';",resolveDir:fileURLToPath(new URL('../src/',import.meta.url)),loader:'ts'},bundle:true,platform:'node',mainFields:['module','main'],format:'esm',write:false,logLevel:'silent'});
  if(result.outputFiles.length!==1||result.outputFiles[0].contents.length>2*1024*1024)fail('MAINTAINED_CONTRACT');
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`).catch(()=>fail('MAINTAINED_CONTRACT'));
 })();
 return primitives;
}
const operatorDDL=MIGRATION_JOURNAL_DDL;
const snapshotDDL='CREATE TABLE _authority_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,namespace TEXT NOT NULL,snapshot_digest TEXT NOT NULL) STRICT';
const bootstrapDDL="CREATE TABLE _authority_restore_bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),contract_digest TEXT NOT NULL,\n phase TEXT NOT NULL CHECK(phase IN ('walking','complete')),participant_cursor TEXT NOT NULL,chunk_cursor TEXT NOT NULL) STRICT";
const bootstrapAssertDDL='CREATE TABLE _authority_restore_bootstrap_assert(id INTEGER CHECK(id=0)) STRICT';
function metadataDDL(rows,expected){
 const actual=rows.filter(row=>row.name.startsWith('_authority_')).map(row=>({name:row.name,sql:row.sql})).sort((a,b)=>a.name<b.name?-1:1);
 const wanted=expected.map(sql=>{const match=/^CREATE (?:TABLE|TRIGGER) ([A-Za-z_][A-Za-z0-9_]*)\b/.exec(sql);if(!match)fail('MAINTAINED_CONTRACT');return {name:match[1],sql};}).sort((a,b)=>a.name<b.name?-1:1);
 equal(actual,wanted,'RESTORE_METADATA_SCHEMA');
}
function sourceMetadata(rows,contract){
 const expected=[{name:'_authority_snapshot',sql:snapshotDDL}];
 for(const table of [...contract.tables.map(row=>row.name),'_authority_snapshot'])for(const verb of ['INSERT','UPDATE','DELETE']){
  const name=`_authority_freeze_${verb.toLowerCase()}_${table}`;
  expected.push({name,sql:`CREATE TRIGGER ${q(name)} BEFORE ${verb} ON ${q(table)} BEGIN SELECT RAISE(ABORT,'AUTHORITY_SNAPSHOT_FROZEN'); END`});
 }
 equal(rows.filter(row=>row.name.startsWith('_authority_')).map(({name,sql})=>({name,sql})).sort((a,b)=>a.name<b.name?-1:1),expected.sort((a,b)=>a.name<b.name?-1:1),'SOURCE_FREEZE');
}
function sequences(rows,contract){
 if(rows.length>128||rows.some(row=>!NAME.test(row.name)||!Number.isSafeInteger(row.seq)||row.seq<0))fail('SEQUENCE');
 for(const expected of contract.authoritySequences)if((rows.find(row=>row.name===expected.name)?.seq??0)!==expected.sequence)fail('SEQUENCE');
}
function administrativeLedger(schema,rows,expected){
 const objects=schema.filter(row=>row.tbl_name==='d1_storage_migrations');
 equal(objects,[{type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',sql:'CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT'}],'OPERATOR_SCHEMA');
 equal(rows,expected,'OPERATOR_MIGRATIONS');
}

/** Admission only, before ANY new-target traffic. This verifies immutable copy
 * receipts plus live source/target/ledger readbacks. It neither reconciles nor
 * mutates a database and does not certify HTTP/credential/public graph behavior.
 * The owning maintenance journal must forbid old-source rollback before it
 * attempts activation, including an uncertain activation outcome. */
export async function verifyMaintenanceCutoverProof({plan,cutover,qualificationRoot,restoreContractPath,ledgerSchemaPath,readDatabase,stage='full'}){
 if(!['pre-analytics','full'].includes(stage))fail('STAGE');
 const proof=validateMaintenanceCutoverProof(cutover.proof),candidate=cutover.candidate;
 const ids=[plan.databaseId,candidate.ingestionDatabaseId,candidate.analyticsDatabaseId,candidate.deletionLedgerDatabaseId];
 if(ids.some(id=>!UUID.test(id))||new Set(ids).size!==4||typeof readDatabase!=='function'||!/^[a-f0-9]{40}$/.test(candidate.sourceCommit))fail('BINDINGS');
 const api=await maintained();
 const contractBytes=await file(restoreContractPath,proof.restoreContractSha256),contract=parse(contractBytes);
 exact(contract,`version runId sourceId sourceNamespace sourceSnapshotDigest sourceSchema sourceSchemaDigest targetBaseSchema targetBaseSchemaDigest tables finalSchema finalSchemaDigest typedCopies admissionContract authoritySequences operatingLimitBytes${contract.targetMigrationLedgerDigest===undefined?'':' targetMigrationLedgerDigest'}${contract.targetOperatorLedgerDigest===undefined?'':' targetOperatorLedgerDigest'}`);
 if(identityDigest(contract)!==proof.restoreContractDigest||contract.version!=='authority-restore-v1'||contract.admissionContract!=='typed-v1-v11-restore-v1'
  ||contract.sourceId!==candidate.sourceId||contract.sourceNamespace!==candidate.sourceNamespace||!SHA.test(contract.sourceSnapshotDigest)
  ||!Number.isSafeInteger(contract.operatingLimitBytes)||contract.operatingLimitBytes<33554432||contract.operatingLimitBytes>9_000_000_000)fail('RESTORE_CONTRACT');
 text(contract.runId,128);text(candidate.sourceId,128);text(candidate.sourceNamespace);
 const namespaceHex=Buffer.from(api.encodeTypedTelemetryId(candidate.sourceNamespace)).toString('hex').toUpperCase();
 for(const [objects,digest] of [[contract.sourceSchema,contract.sourceSchemaDigest],[contract.targetBaseSchema,contract.targetBaseSchemaDigest],[contract.finalSchema,contract.finalSchemaDigest]]){
  if(!Array.isArray(objects)||objects.length>1024||new Set(objects.map(row=>row.name)).size!==objects.length||identityDigest(objects)!==digest)fail('RESTORE_SCHEMA');
  for(const row of objects){exact(row,'type name tbl_name sql');if(!NAME.test(row.name)||!NAME.test(row.tbl_name)||row.name.startsWith('_authority_')||typeof row.sql!=='string'||row.sql.length>100000)fail('RESTORE_SCHEMA');}
 }
 if(!Array.isArray(contract.tables)||contract.tables.length>128||!Array.isArray(contract.authoritySequences)||contract.authoritySequences.length>128||!Array.isArray(contract.typedCopies))fail('RESTORE_CONTRACT');
 equal(contract.tables.map(row=>row.name).sort(),contract.sourceSchema.filter(row=>row.type==='table').map(row=>row.name).sort(),'SOURCE_COVERAGE');
 const retained=new Set(api.authorityRestoreRetainedTableNames());
 for(const row of contract.tables){exact(row,'name disposition');
  const expected=retained.has(row.name)?'authority':row.name==='telemetry_v1_records'?'typed-v1':row.name==='telemetry_v11_records'?'typed-v11':row.name==='d1_migrations'?'outside-role':'analytics';
  if(row.disposition!==expected)fail('SOURCE_COVERAGE');
 }
 const sequenceNames=contract.sourceSchema.filter(row=>row.type==='table'&&(retained.has(row.name)||row.name==='telemetry_v1_records')&&/\bAUTOINCREMENT\b/i.test(row.sql)).map(row=>row.name).sort();
 equal(contract.authoritySequences.map(row=>row.name),sequenceNames,'SEQUENCE_COVERAGE');
 for(const row of contract.authoritySequences){exact(row,'name sequence');integer(row.sequence);}
 equal(contract.typedCopies.map(row=>row.format).sort(),['v1','v11'],'COPY_FORMATS');
 for(const row of contract.typedCopies){exact(row,'runId sourceNamespace sourceSnapshotDigest format');if(row.sourceNamespace!==contract.sourceNamespace||row.sourceSnapshotDigest!==contract.sourceSnapshotDigest)fail('COPY_IDENTITY');text(row.runId,128);}
 const [ingestion,analytics]=await Promise.all(['ingestion','analytics'].map(role=>loadStorageQualification({workerRoot:qualificationRoot,plan:{sourceCommit:candidate.sourceCommit},target:{role,qualificationSha256:proof[`${role}QualificationSha256`]}})));
 const roleSchemaBytes=await file(join(qualificationRoot,D1_STORAGE_SCHEMA_DIRECTORIES.ingestion,'final-role-schema.json'),ingestion.manifest.finalRoleSchemaSha256);
 // The restore-base loader's runtimeReady:false remains truthful. Final role
 // schema and runtime state are independently checked below against live D1.
 equal(parse(roleSchemaBytes),contract.finalSchema.filter(row=>row.tbl_name!=='d1_storage_migrations'),'QUALIFIED_FINAL_ROLE');
 const ledgerSchemaBytes=await file(ledgerSchemaPath,proof.ledgerSchemaFileSha256),ledgerSchema=parse(ledgerSchemaBytes);
 storageSchemaDigest(ledgerSchema);
 const ledgerDirectory=join(qualificationRoot,'deletion-ledger-migrations');
 const migrationNames=(await readdir(ledgerDirectory)).filter(name=>name.endsWith('.sql')).sort();
 if(!migrationNames.length||migrationNames.length>128||migrationNames.some(name=>!/^\d{4}_[a-z0-9_-]+\.sql$/.test(name)))fail('LEDGER_MIGRATIONS');
 const migrationInputs=await Promise.all(migrationNames.map(async name=>({name,sha256:storageSha256(await file(join(ledgerDirectory,name),null,240*1024))})));
 if(identityDigest(migrationInputs)!==proof.ledgerMigrationInputsSha256)fail('LEDGER_MIGRATIONS');
 const evidence=[];let bytesRead=0,queries=0;
 const read=async(id,sql,params=[],limit=MAX_ROWS)=>{
  if(!ids.includes(id)||!MAINTENANCE_CUTOVER_PROOF_SQL.includes(sql)||++queries>100)fail('QUERY');
  const response=await readDatabase(id,sql,params);
  if(response?.success!==true||!Array.isArray(response.results)||response.results.length>limit)fail('RESULT');
  const encoded=JSON.stringify(response.results);bytesRead+=Buffer.byteLength(encoded);
  if(bytesRead>MAX_BYTES)fail('RESULT_BUDGET');
  evidence.push({databaseId:id,querySha256:storageSha256(sql),parametersSha256:identityDigest(params),resultSha256:storageSha256(encoded)});
  return response;
 };
 const rows=async(id,key,params=[],limit)=> (await read(id,SQL[key],params,limit)).results;
 const source=ids[0],target=ids[1],derived=ids[2],ledger=ids[3];
 const sourceFence=async()=>{
  const schema=await rows(source,'schema',[],4096),snapshot=one(await rows(source,'sourceSnapshot',[],1)),seq=await rows(source,'sequences',[],128);
  sourceMetadata(schema,contract);if(storageSchemaDigest(schema.filter(row=>!row.name.startsWith('_authority_')))!==storageSchemaDigest(contract.sourceSchema))fail('SOURCE_SCHEMA');
  equal(snapshot,{contract_digest:proof.restoreContractDigest,namespace:contract.sourceNamespace,snapshot_digest:contract.sourceSnapshotDigest},'SOURCE_SNAPSHOT');sequences(seq,contract);
  return {schema,snapshot,seq};
 };
 const ledgerFence=async()=>{
  const tombstones=await rows(ledger,'tombstones'),cooldowns=await rows(ledger,'cooldowns'),jobs=await rows(ledger,'jobs');
  for(const [records,key,version] of [[tombstones,'participant_digest','participant-deletion-tombstone-v0.1'],[cooldowns,'identity_cooldown_digest','identity-reenrollment-cooldown-v0.1']]){
   let previous='';for(const row of records){exact(row,`${key} schema_version deleted_at retain_until`);if(!SHA.test(row[key])||row[key]<=previous||row.schema_version!==version||instant(row.retain_until)<=instant(row.deleted_at))fail('LEDGER_ROW');previous=row[key];}
  }
  for(const row of jobs){exact(row,'participant_digest source_id owner_digest source_namespace state terminal_json completed_at attempted_ms');
   if(!SHA.test(row.participant_digest)||!SHA.test(row.owner_digest)||row.state!=='complete'||typeof row.terminal_json!=='string'||!tombstones.some(t=>t.participant_digest===row.participant_digest))fail('LEDGER_PENDING');
   if(row.source_id!==candidate.sourceId||row.source_namespace!==candidate.sourceNamespace)fail('LEDGER_JOB_SCOPE');
   integer(row.attempted_ms);instant(row.completed_at);const terminal=parse(row.terminal_json);
   exact(terminal,'sourceId sequence eventDigest ownerDigest revision kind objectDigest contentDigest authorityEpoch publicAuthorityEpoch recordedMs');
   if(terminal.sourceId!==row.source_id||terminal.ownerDigest!==row.owner_digest||terminal.kind!=='owner-erased'
    ||![terminal.eventDigest,terminal.ownerDigest,terminal.objectDigest,terminal.contentDigest].every(value=>typeof value==='string'&&SHA.test(value))
    ||![terminal.sequence,terminal.revision,terminal.authorityEpoch,terminal.publicAuthorityEpoch].every(value=>Number.isSafeInteger(value)&&value>0))fail('LEDGER_TERMINAL');
   integer(terminal.recordedMs);
  }
  const value={tombstones,cooldowns,jobs};if(identityDigest(value)!==proof.ledgerStateSha256)fail('LEDGER_CHANGED');return value;
 };
 const beforeSource=await sourceFence(),beforeLedger=await ledgerFence();
 const targetSchema=await rows(target,'schema',[],4096);
 metadataDDL(targetSchema,[...api.AUTHORITY_RESTORE_SCHEMA,operatorDDL,bootstrapDDL,bootstrapAssertDDL]);
 if(storageSchemaDigest(targetSchema.filter(row=>!row.name.startsWith('_authority_')))!==storageSchemaDigest(contract.finalSchema))fail('TARGET_SCHEMA');
 const operatorExpected=ingestion.migrations.map(({name,sha256})=>({name,sha256}));
 administrativeLedger(targetSchema,await rows(target,'operatorLedger',[],128),operatorExpected);
 if(identityDigest(operatorExpected)!==contract.targetOperatorLedgerDigest)fail('OPERATOR_PIN');
 const actualExpected=await rows(target,'expected',[],1024);equal(actualExpected,contract.finalSchema,'RESTORE_EXPECTED');
 const progress=one(await rows(target,'progress',[],1)),run=one(await rows(target,'restore',[],1));
 if(progress.execution_digest!==proof.migrationExecutionDigest)fail('MIGRATION_EXECUTION');
 if(progress.contract_digest!==proof.restoreContractDigest||progress.stage!==null||progress.intent!==null||integer(progress.steps)<19)fail('COPY_PENDING');
 equal(run,{run_id:contract.runId,contract_digest:proof.restoreContractDigest,limit_bytes:contract.operatingLimitBytes,phase:'ready'},'COPY_PENDING');
 if(one(await rows(target,'permission',[],1)).n!==0)fail('COPY_PERMISSION');
 const tables=await rows(target,'tables',[],128);
 equal(tables.map(row=>row.name),contract.tables.filter(row=>row.disposition==='authority').map(row=>row.name).sort(),'AUTHORITY_COVERAGE');
 for(const row of tables)if(row.copy_done!==1||row.verify_done!==1||integer(row.copied)!==integer(row.verified)||row.copy_cursor!==row.verify_cursor)fail('AUTHORITY_UNVERIFIED');
 const sourceCounts=await rows(source,'sourceCounts',[],2),typed=await rows(target,'typed',[],2),copies=await rows(target,'copies',[],2),adopted=await rows(target,'adoption',[],2),admission=await rows(target,'admission',[],2);
 for(const collection of [sourceCounts,typed,copies,adopted,admission])equal(collection.map(row=>row.format),['v1','v11'],'COPY_COVERAGE');
 for(const [i,format] of ['v1','v11'].entries()){
  const original=sourceCounts[i],copy=contract.typedCopies.find(row=>row.format===format),verified=typed[i],checkpoint=copies[i],mapping=adopted[i],state=admission[i];
  const count=integer(original.records),last=integer(original.last_id),high=format==='v1'?(contract.authoritySequences.find(row=>row.name==='telemetry_v1_records')?.sequence??0):0;
  if(verified.run_id!==copy.runId||verified.done!==1||verified.verified!==count||verified.verify_cursor!==last)fail('TYPED_UNVERIFIED');
  equal(checkpoint,{run_id:copy.runId,source_namespace:contract.sourceNamespace,source_snapshot_digest:contract.sourceSnapshotDigest,format,last_source_row_id:last,copied_rows:count},'TYPED_COPY');
  equal(mapping,{format,high_water:high,after_id:last,copied:count,done:1,verify_after:last,verified:count,verify_done:1},'ADOPTION_UNVERIFIED');
  if(state.source_namespace!==contract.sourceNamespace||state.runtime_contract_version!==1||state.namespace_hex!==namespaceHex||!integer(state.namespace_id)
    ||state.next_source_row_id!==Math.max(last,high)+1||!Number.isSafeInteger(state.next_source_row_id))fail('RUNTIME_ADMISSION');
 }
 if(admission[0].namespace_id!==admission[1].namespace_id)fail('NAMESPACE');
 sequences(await rows(target,'sequences',[],128),contract);
 equal(one(await rows(target,'bootstrap',[],1)),{contract_digest:proof.restoreContractDigest,phase:'complete'},'BOOTSTRAP');
 equal(one(await rows(target,'publicBootstrap',[],1)),{policy_version:api.COMMUNITY_PUBLIC_SOURCE_POLICY_VERSION,completed:1},'BOOTSTRAP');
 const separation=one(await rows(target,'separation',[],1));if(separation.phase!=='prepared'||separation.empty_source_check!==1||integer(separation.policy_revision)<1)fail('ISOLATION');
 const currentParticipants=await rows(target,'participants'),primaryCooldowns=await rows(target,'primaryCooldowns');
 const deletions=new Set(beforeLedger.tombstones.map(row=>row.participant_digest));
 // Conservative: even expired-but-retained tombstones must be reconciled before
 // this cutover. Never infer an empty independent ledger from a restored source.
 for(const row of currentParticipants){exact(row,'id');if(deletions.has(await api.participantDeletionDigest(text(row.id))))fail('DELETED_OWNER_PRESENT');}
 for(const row of beforeLedger.cooldowns){const current=primaryCooldowns.find(value=>value.identity_cooldown_digest===row.identity_cooldown_digest);
  if(!current||current.schema_version!==row.schema_version||instant(current.retain_until)<row.retain_until)fail('COOLDOWN_COVERAGE');}
 const actualLedgerSchema=await rows(ledger,'schema',[],4096);
 // d1_migrations is retained as evidence. Its exact provider-administrative
 // schema may be included in the pinned expected inventory; no broad filter.
 if(storageSchemaDigest(actualLedgerSchema)!==storageSchemaDigest(ledgerSchema))fail('LEDGER_SCHEMA');
 const appliedMigrations=await rows(ledger,'migrations',[],128);
 equal(appliedMigrations.map(({id,name})=>({id,name})),migrationInputs.map(({name},index)=>({id:index+1,name})),'LEDGER_MIGRATIONS');
 for(const row of appliedMigrations)if(typeof row.applied_at!=='string'||!Number.isFinite(Date.parse(row.applied_at)))fail('LEDGER_MIGRATIONS');
 const analyticsSchema=await rows(derived,'schema',[],4096);
 if(storageSchemaDigest(analyticsSchema)!==analytics.schemaSha256)fail('ANALYTICS_SCHEMA');
 administrativeLedger(analyticsSchema,await rows(derived,'operatorLedger',[],128),analytics.migrations.map(({name,sha256})=>({name,sha256})));
 const runtime=await rows(derived,'runtime',[],1);
 // Before the independent worker initializes its immutable registration, an
 // empty exact analytics role can be prepared. An existing wrong registration
 // still refuses. This stage never certifies analytics/privacy completion.
 if(stage==='full'||runtime.length)equal(runtime,[{source_id:candidate.sourceId,source_namespace:candidate.sourceNamespace,contract_version:1}],'ANALYTICS_RUNTIME');
 const targetFence=async()=>({state:one(await rows(target,'sourceState',[],1)),head:await rows(target,'sourceHead',[],1),owners:await rows(target,'sourceOwners')});
 const beforeTarget=await targetFence(),state=beforeTarget.state,head=beforeTarget.head;
 if(state.source_id!==candidate.sourceId)fail('SOURCE_ID');integer(state.authority_epoch);
 const sequence=head.length?integer(head[0].sequence):0;if(head.length&&head[0].public_authority_epoch!==state.authority_epoch)fail('SOURCE_EPOCH');
 if(stage==='full'){
  const cursor=await rows(derived,'cursor',[candidate.sourceId],1);
  if(sequence===0){if(state.authority_epoch!==0||beforeTarget.owners.length||(cursor.length&&(cursor[0].sequence!==0||cursor[0].authority_epoch!==0)))fail('ANALYTICS_CURSOR');}
  else equal(one(cursor),{sequence,authority_epoch:state.authority_epoch},'ANALYTICS_BEHIND');
  equal(await rows(derived,'appliedHead',[candidate.sourceId],1),head,'ANALYTICS_CONTINUITY');
  equal(one(await rows(derived,'appliedRange',[candidate.sourceId],1)),{n:sequence,first_sequence:sequence?1:0,last_sequence:sequence},'ANALYTICS_GAP');
  equal(await rows(derived,'analyticOwners',[candidate.sourceId]),beforeTarget.owners,'ANALYTICS_OWNER_COVERAGE');
 }
 for(const job of beforeLedger.jobs){
  const terminal=parse(job.terminal_json),owner=beforeTarget.owners.find(row=>row.owner_digest===job.owner_digest);
  if(owner?.state!=='erased')fail('ERASURE_SOURCE');
  equal(await rows(target,'erasureTerminal',[terminal.sequence,terminal.eventDigest,terminal.ownerDigest,terminal.revision,terminal.objectDigest,terminal.contentDigest,terminal.authorityEpoch,terminal.publicAuthorityEpoch,terminal.recordedMs],1),[{complete:1}],'ERASURE_TERMINAL_SOURCE');
  if(stage==='full')equal(await rows(derived,'erasureCompletion',[candidate.sourceId,job.owner_digest,terminal.eventDigest,terminal.publicAuthorityEpoch],1),[{complete:1}],'ERASURE_INCOMPLETE');
 }
 for(const databaseId of [target,derived,ledger]){
  if((await rows(databaseId,'fk')).length)fail('FOREIGN_KEYS');
  const capacity=await read(databaseId,SQL.capacity,[],1),size=capacity.meta?.size_after;
  if(!Number.isSafeInteger(size)||size<0||size>contract.operatingLimitBytes)fail('CAPACITY');
 }
 equal(await targetFence(),beforeTarget,'TARGET_CHANGED');
 equal(await rows(target,'participants'),currentParticipants,'PARTICIPANTS_CHANGED');
 equal(await rows(target,'primaryCooldowns'),primaryCooldowns,'COOLDOWNS_CHANGED');
 equal(await ledgerFence(),beforeLedger,'LEDGER_CHANGED');
 equal(await rows(target,'schema',[],4096),targetSchema,'TARGET_SCHEMA_CHANGED');
 equal(one(await rows(target,'progress',[],1)),progress,'MIGRATION_EXECUTION_CHANGED');
 equal(await rows(derived,'schema',[],4096),analyticsSchema,'ANALYTICS_SCHEMA_CHANGED');
 equal(await rows(ledger,'schema',[],4096),actualLedgerSchema,'LEDGER_SCHEMA_CHANGED');
 equal(await sourceFence(),beforeSource,'SOURCE_CHANGED');
 // Detect local input replacement during the provider reads as well.
 await file(restoreContractPath,proof.restoreContractSha256);await file(ledgerSchemaPath,proof.ledgerSchemaFileSha256);
 return {schema:'production-maintenance-typed-admission-v1',status:'verified',stage,analyticsCaughtUp:stage==='full',candidateSourceCommit:candidate.sourceCommit,
  proofDigest:identityDigest(proof),migrationExecutionDigest:proof.migrationExecutionDigest,restoreContractDigest:proof.restoreContractDigest,sourceSnapshotDigest:contract.sourceSnapshotDigest,
  databaseBindingDigest:identityDigest(ids),sourceId:candidate.sourceId,sourceNamespace:candidate.sourceNamespace,
  sourceAuthorityEpoch:state.authority_epoch,journalSequence:sequence,ledgerStateSha256:proof.ledgerStateSha256,
  ingestionSchemaSha256:storageSchemaDigest(contract.finalSchema),analyticsSchemaSha256:analytics.schemaSha256,
  ledgerSchemaSha256:storageSchemaDigest(ledgerSchema),queries,readEvidenceSha256:identityDigest(evidence),
  admissionOnly:true,httpRuntimeVerified:false,oldSourceRollbackPermitted:false};
}
