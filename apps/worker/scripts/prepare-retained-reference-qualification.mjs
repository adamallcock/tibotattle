/** Frozen synthetic SQL preparation only. Never contacts or creates a remote resource. */
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedStatements } from './rehearse-release-migrations.mjs';
import { accountlessMovementSelection, planAccountlessMovementSetup, planAccountlessMovementBatch, planAccountlessMovementTransition } from './accountless-migration-movement.mjs';
import { usesRangeRecordBatch, accountlessRangeSelection, planAccountlessRangeBatch } from './accountless-migration-range.mjs';
import { renderMovementSql } from './accountless-migration-operator.mjs';
import { buildMutationBarrierSetupStatements, buildMutationBarrierPermissionStatements, buildMutationBarrierReinstallStatements, mutationBarrierProductTablesFromSchema } from '../src/mutation-barrier.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const RETAINED_QUALIFICATION_NAME='tibotattle-reference58-20260909-01';
export const RETAINED_QUALIFICATION_CODE_FILES=Object.freeze([
 'scripts/prepare-retained-reference-qualification.mjs','scripts/run-retained-reference-qualification.mjs',
 'scripts/accountless-migration-movement.mjs','scripts/accountless-migration-range.mjs','scripts/accountless-migration-operator.mjs','src/mutation-barrier.ts',
 'scripts/wrangler-query-launcher.mjs','scripts/wrangler-query-preload.cjs',
 'scripts/rehearse-release-migrations.mjs','scripts/release-preflight.mjs',
 'scripts/staging-readiness-lib.mjs','../../config/deployment-endpoints.js',
]);
const retained=['contributions','device_credentials','device_pairings','device_upload_authorizations','participants','telemetry_contributions','telemetry_v11_chunks','telemetry_v11_day_manifests','telemetry_v1_chunks','upload_authorizations','web_sessions'];
const operation='reference58-20260909-01',sha=value=>createHash('sha256').update(value).digest('hex');
const q=value=>'"'+value.replaceAll('"','""')+'"',literal=value=>renderMovementSql([{sql:'SELECT ?',params:[value]}]).slice(7,-2);
const fail=code=>{throw new Error('RETAINED_QUALIFICATION_'+code)},check=(value,code)=>{if(!value)fail(code)};
const schema=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_accountless_*' ORDER BY type,name").all();
const ledgerRead='SELECT name FROM d1_migrations ORDER BY id';
const referenceRead=`SELECT ${retained.map(t=>`(SELECT COUNT(*) FROM ${q(t)}) AS ${q(t)}`).join(',')},
 (SELECT r2_key FROM contributions WHERE id='synthetic-contribution') AS synthetic_key,
 (SELECT r2_key FROM telemetry_contributions WHERE id='synthetic-legacy') AS legacy_key,
 (SELECT r2_key FROM telemetry_v1_chunks WHERE participant_id='synthetic-rehearsal-0' AND device_id='synthetic-rehearsal-0' AND stream='usage' AND chunk_day='2025-10-01' AND chunk_seq=0 AND superseded_at IS NULL) AS v1_key,
 (SELECT c.r2_key FROM telemetry_v11_chunks c JOIN telemetry_v11_day_manifests m ON m.id=c.manifest_id WHERE m.participant_id='synthetic-rehearsal-0' AND m.device_id='synthetic-rehearsal-0' AND m.chunk_day='2026-09-01' AND m.manifest_digest='${'a'.repeat(64)}' AND c.chunk_id='synthetic') AS v11_key`;
const movementRead=`SELECT metadata,(SELECT COUNT(*) FROM _accountless_migration_barrier_permission_v1) AS permissions FROM _accountless_move_journal WHERE id=1`;
const combinedRead=`SELECT journal.metadata,journal.permissions,refs.* FROM (${movementRead}) journal CROSS JOIN (${referenceRead}) refs`;

export async function prepareRetainedReferenceQualification({outputDirectory}={}) {
 check(typeof outputDirectory==='string'&&outputDirectory.length>0,'OUTPUT_REQUIRED');
 try{await lstat(resolve(outputDirectory));const error=new Error('RETAINED_QUALIFICATION_OUTPUT_EXISTS');error.code='EEXIST';throw error;}catch(error){if(error.code!=='ENOENT')throw error;}
 const names=(await readdir(join(root,'migrations'))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort();check(names.length===59,'SOURCE_COUNT');
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:1024});check(head.status===0&&/^[a-f0-9]{40}\s*$/.test(head.stdout),'SOURCE_REVISION');const sourceRevision=head.stdout.trim();
 const tree=spawnSync('git',['ls-tree','--full-tree','--name-only',`${sourceRevision}:apps/worker/migrations`],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:32768});check(tree.status===0&&JSON.stringify(tree.stdout.trim().split('\n').sort())===JSON.stringify(names),'CANONICAL_NAMES');
 const sources=await Promise.all(names.map(async name=>{const sql=await readFile(join(root,'migrations',name),'utf8');const committed=spawnSync('git',['show',`${sourceRevision}:apps/worker/migrations/${name}`],{cwd:root,timeout:5000,maxBuffer:2*1024*1024});return{name,sql,sha256:sha(sql),matchesCommit:committed.status===0&&sha(committed.stdout)===sha(sql)};}));
 check(sources[57].sha256==='b435fd92d41e7ce8067cc183d7ac153359a9c130a971cba2e1b8b8c1c9cab61b'&&sources[58].sha256==='98afb99dd91e56a96960e6d99096e44c41eec0cd52d5a1e2969dea4ddee3d312','CANONICAL_HASH');
 const db=new DatabaseSync(':memory:'),control=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;PRAGMA max_page_count=24576;PRAGMA cache_size=-4096');control.exec('PRAGMA foreign_keys=ON');
 const steps=[],started=performance.now();let references=null,peakRss=0;
 const observe=()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);check(peakRss<512*1024*1024&&performance.now()-started<600000,'LOCAL_RESOURCE_CEILING');};
 function step(name,sql,readback=ledgerRead,expectedError=null){
  check(Buffer.byteLength(sql)<=256*1024&&steps.length<256,'QUERY_BOUND');let rejected=false;const start=performance.now();
  db.exec('BEGIN IMMEDIATE');try{db.exec(sql);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');const message=String(error.message);if(!expectedError)throw new Error('RETAINED_QUALIFICATION_LOCAL_STEP_'+name,{cause:error});check(expectedError==='CHECK_CONSTRAINT'?/CHECK constraint failed/i.test(message):expectedError==='MUTATION_BARRIER'&&message.includes('ACCOUNTLESS_MIGRATION_MUTATION_BARRIER'),'UNEXPECTED_LOCAL_FAILURE');rejected=true;}
  check(rejected===Boolean(expectedError),'EXPECTED_FAILURE_MISSING');observe();
  if(references)check(JSON.stringify(db.prepare(referenceRead).all())===references,'REFERENCE_DRIFT');
  const expectedRows=db.prepare(readback).all();steps.push({name,sql,sqlSha256:sha(sql),sqlBytes:Buffer.byteLength(sql),readback,expectedRows,expectedFailure:Boolean(expectedError),expectedError,localDurationMs:Math.ceil(performance.now()-start)});
 }
 function groups(name,statements,readback=ledgerRead){let sql='',index=0;for(const statement of statements){check(Buffer.byteLength(statement)<64*1024,'FIXTURE_STATEMENT_BOUND');if(sql&&Buffer.byteLength(sql+statement)>64*1024){step(`${name}-${index++}`,sql,readback);sql='';}sql+=statement+'\n;\n';}if(sql)step(`${name}-${index}`,sql,readback);}
 function insert(table,overrides){const info=db.prepare(`PRAGMA table_info(${q(table)})`).all();const fields=Object.fromEntries(info.filter(c=>c.notnull&&c.dflt_value===null).map(c=>[c.name,c.type==='BLOB'?null:['INTEGER','REAL'].includes(c.type)?0:'synthetic']));Object.assign(fields,overrides);return `INSERT INTO ${q(table)}(${Object.keys(fields).map(q).join(',')}) VALUES(${Object.entries(fields).map(([key,value])=>value===null&&info.find(c=>c.name===key).type==='BLOB'?'zeroblob(32)':literal(value)).join(',')});`;}
 try {
  step('create-ledger','CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);');
  for(const source of sources.slice(0,56))step(source.name,source.sql+`\nINSERT INTO d1_migrations(name) VALUES(${literal(source.name)});`);
  groups('maintained-small-seed',[...seedStatements('USAGE_MONITOR_DB',2,20)]);
  step(sources[56].name,sources[56].sql+`\nINSERT INTO d1_migrations(name) VALUES(${literal(sources[56].name)});`);
  const triggers=schema(db).filter(o=>o.type==='trigger');groups('synthetic-history-trigger-pause',triggers.map(t=>`DROP TRIGGER ${q(t.name)}`));
  const owner='synthetic-rehearsal-0',digest='a'.repeat(64),at='2026-09-01T00:00:00.000Z';
  groups('retained-journal-seed',[
   insert('upload_authorizations',{id:'synthetic-upload',participant_id:owner,issued_by_session_id:owner,envelope_digest:digest,body_bytes:20,content_type:'application/json',issued_at:at,expires_at:'9999-01-01T00:00:00.000Z'}),
   insert('contributions',{id:'synthetic-contribution',participant_id:owner,envelope_digest:digest,r2_key:'synthetic/preserved-envelope',status:'accepted_synthetic',created_at:at}),
   insert('telemetry_contributions',{id:'synthetic-legacy',participant_id:owner,plaintext_digest:digest,envelope_digest:digest,r2_key:'synthetic/preserved-legacy',schema_version:'telemetry-contribution-v0.1',created_at:at,declared_record_count:10,accepted_record_count:10}),
   `INSERT INTO telemetry_v11_day_manifests(id,participant_id,device_id,chunk_day,manifest_digest,parser_version,manifest_json,expected_chunk_count,created_at) VALUES('00000000-0000-4000-8000-000000000001',${literal(owner)},${literal(owner)},'2026-09-01',${literal(digest)},'synthetic','{}',1,${literal(at)})`,
   `INSERT INTO telemetry_v11_chunks(id,manifest_id,participant_id,device_id,stream,chunk_day,chunk_seq,chunk_id,chunk_digest,envelope_digest,parser_version,record_count,r2_key,device_upload_authorization_id,created_at) VALUES('chunk:00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',${literal(owner)},${literal(owner)},'usage','2026-09-01',0,'synthetic',${literal(digest)},${literal(digest)},'synthetic',1,'synthetic/v11','synthetic-rehearsal-0-chunk-0',${literal(at)})`,
   `INSERT INTO telemetry_v11_records(rowid,chunk_id,manifest_id,stream,occurrence_id,observed_at,record_json) VALUES(9007199254742001,'chunk:00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','usage','synthetic-occurrence',${literal(at)},'{}')`,
   `UPDATE telemetry_records SET id=id*101,origin_contribution_id=CASE WHEN participant_id=${literal(owner)} THEN 'synthetic-legacy' ELSE NULL END`,
   `UPDATE telemetry_records SET record_json='{"padding":"'||printf('%.*c',65536,'x')||'"}' WHERE id=101`,
   `INSERT INTO telemetry_contribution_occurrences(contribution_id,participant_id,record_kind,occurrence_id) SELECT 'synthetic-legacy',participant_id,record_kind,occurrence_id FROM telemetry_records WHERE participant_id=${literal(owner)}`,
   'UPDATE telemetry_v1_records SET id=id*103',
   "UPDATE sqlite_sequence SET seq=9007199254745000 WHERE name IN ('telemetry_records','telemetry_v1_records')",
  ]);
  for(let offset=0;offset<26000;offset+=2000){let sql='';for(const table of ['device_upload_authorizations','telemetry_v1_chunks']){
   const columns=db.prepare(`PRAGMA table_info(${q(table)})`).all().map(c=>c.name);
   const expression=c=>c==='id'?(table==='device_upload_authorizations'?"'synthetic-residual-'||printf('%077d',n)":"'synthetic-residual-'||n"):['envelope_digest','chunk_digest'].includes(c)?"printf('%064x',n+100000)":c==='chunk_seq'?'n+1000':c==='device_upload_authorization_id'?"'synthetic-residual-'||printf('%077d',n)":c==='r2_key'?"'synthetic/residual/'||n||printf('%.*c',64,'x')":c==='record_count'?'1':c==='accepted_record_count'?'0':'b.'+q(c);
   sql+=`WITH RECURSIVE numbers(n) AS(SELECT ${offset+1} UNION ALL SELECT n+1 FROM numbers WHERE n<${offset+2000}) INSERT INTO ${q(table)}(${columns.map(q).join(',')}) SELECT ${columns.map(expression).join(',')} FROM numbers CROSS JOIN (SELECT * FROM ${q(table)} ORDER BY rowid LIMIT 1) b;\n`;
  }step(`residual-seed-${offset/2000}`,sql,'SELECT (SELECT COUNT(*) FROM device_upload_authorizations) AS authorizations,(SELECT COUNT(*) FROM telemetry_v1_chunks) AS chunks');}
  const recordColumns=db.prepare('PRAGMA table_info(telemetry_v1_records)').all().map(c=>c.name);
  for(let offset=0;offset<8192;offset+=2048){
   const values=recordColumns.map(c=>c==='id'?'100000+n':c==='occurrence_id'?"'synthetic-range-'||n":c==='record_json'?"json_object('syntheticRange',n,'padding',printf('%.*c',1024,'x'))":'b.'+q(c));
   step(`range-record-seed-${offset/2048}`,`WITH RECURSIVE numbers(n) AS(SELECT ${offset+1} UNION ALL SELECT n+1 FROM numbers WHERE n<${offset+2048}) INSERT INTO telemetry_v1_records(${recordColumns.map(q).join(',')}) SELECT ${values.join(',')} FROM numbers CROSS JOIN (SELECT * FROM telemetry_v1_records ORDER BY id LIMIT 1) b;`,'SELECT COUNT(*) AS records,SUM(length(record_json)) AS json_bytes FROM telemetry_v1_records');
  }
  groups('synthetic-history-trigger-restore',triggers.map(t=>t.sql));
  references=JSON.stringify(db.prepare(referenceRead).all());const referenceCounts=db.prepare(referenceRead).get();check(retained.every(t=>referenceCounts[t]>0)&&['synthetic_key','legacy_key','v1_key','v11_key'].every(k=>typeof referenceCounts[k]==='string'&&referenceCounts[k].startsWith('synthetic/')),'RETAINED_FIXTURE_EMPTY');
  const original=schema(db),tables=original.filter(o=>o.type==='table');
  const setup=planAccountlessMovementSetup({sources,schemaObjects:original,foreignKeys:Object.fromEntries(tables.map(t=>[t.name,db.prepare(`PRAGMA foreign_key_list(${q(t.name)})`).all()])),tableInfo:Object.fromEntries(tables.map(t=>[t.name,db.prepare(`PRAGMA table_info(${q(t.name)})`).all()])),sequences:db.prepare('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence').all(),retainObjectReferences:true,rangeRecordBatches:true});
  check(setup.current.order.length===41&&JSON.stringify(setup.current.retainedObjectTables)===JSON.stringify(retained),'RETAIN_MODE');
  const preservationQueries=tables.filter(t=>t.name!=='d1_migrations').map(t=>{
   const columns=db.prepare(`PRAGMA table_info(${q(t.name)})`).all(),keys=columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>q(c.name));
   const moved=setup.current.order.includes(t.name),rowid=moved&&setup.current.descriptors[t.name].hasRowid;
   return `SELECT ${rowid?'rowid AS _proof_rowid,':''}${columns.map(c=>q(c.name)).join(',')} FROM ${q(t.name)} ORDER BY ${(keys.length?keys:['rowid']).join(',')}`;
  });
  const digestRows=sql=>{const hash=createHash('sha256'),statement=db.prepare(sql);statement.setReadBigInts(true);let count=0;for(const row of statement.iterate()){hash.update(JSON.stringify(row,(_,v)=>typeof v==='bigint'?v.toString():v)+'\n');count++;}return{count,sha256:hash.digest('hex')};};
  const preservedRows=preservationQueries.map(digestRows);
  const productTables=mutationBarrierProductTablesFromSchema(tables.map(t=>({name:t.name})));
  groups('barrier-setup',buildMutationBarrierSetupStatements({operationId:operation,sourceRevision,createdAt:at,productTables}).map(s=>renderMovementSql([s])),referenceRead);
  const permission=buildMutationBarrierPermissionStatements(operation);
  step('movement-setup',renderMovementSql([permission.begin,...setup.statements,...permission.end]),combinedRead);
  step('old-writer-refused',"DELETE FROM telemetry_v1_chunks WHERE id='synthetic-rehearsal-0-chunk-0';",combinedRead,'MUTATION_BARRIER');
  for(const source of sources.slice(0,58))control.exec(source.sql);const canonicalObjects=schema(control).filter(o=>['trigger','view'].includes(o.type));
  let current=setup.current,checkedReplay=false;
  for(const phase of ['evacuate','restore']){
   while(current.tableIndex<current.order.length){
    const range=usesRangeRecordBatch(current),rangeRows=current.cursor===0?1024:8192,selection=range?accountlessRangeSelection(current,{maxRows:rangeRows}):accountlessMovementSelection(current,{maxRows:32});
    const selected=db.prepare(selection.sql).all(...selection.params);
    const plan=range?planAccountlessRangeBatch({current,selection:selected[0],expectedRevision:current.revision,maxRows:rangeRows,maxBytes:16*1024*1024,permission}):planAccountlessMovementBatch({current,selectedRows:selected,expectedRevision:current.revision,maxRows:32,maxBytes:1024*1024,permission});
    const sql=renderMovementSql(plan.statements);
    if(!checkedReplay&&plan.result.rows>0){step('late-failure-rollback',sql+'\nINSERT INTO _accountless_move_assertion VALUES(1,0);',combinedRead,'CHECK_CONSTRAINT');}
    step(`${range?'range-':''}${phase}-${current.tableIndex}-${current.revision}`,sql,combinedRead);if(range)steps.at(-1).rangeBenchmark={maxRows:rangeRows,rows:plan.result.rows,logicalBytes:plan.result.bytes};current=JSON.parse(db.prepare(plan.readback.sql).get().metadata);
    if(!checkedReplay&&plan.result.rows>0){step('committed-replay-refused',sql,combinedRead,'CHECK_CONSTRAINT');checkedReplay=true;}
   }
   const beforeTables=schema(db).filter(o=>o.type==='table').map(t=>t.name),afterTables=schema(control).filter(o=>o.type==='table').map(t=>t.name);
   const guards=phase==='evacuate'?buildMutationBarrierReinstallStatements([...new Set(['participants','device_credentials',...afterTables.filter(t=>!beforeTables.includes(t))])]):[];
   const plan=planAccountlessMovementTransition({sources,current,expectedRevision:current.revision,canonicalObjects,permission,guardStatements:guards});step(`canonical-${phase==='evacuate'?'0058':'0059'}`,renderMovementSql(plan.statements),combinedRead);current=plan.current;
  }
  check(JSON.stringify(preservationQueries.map(digestRows))===JSON.stringify(preservedRows),'ORIGINAL_ROW_VALUES');
  step('final-record-rowids','SELECT 1;',"SELECT CAST(rowid AS TEXT) AS rowid FROM telemetry_v11_records ORDER BY rowid");
  step('final-record-highwater','SELECT 1;',"SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name IN ('telemetry_records','telemetry_v1_records') ORDER BY name");
  step('final-foreign-keys','SELECT 1;','PRAGMA foreign_key_check');
  step('final-ledger-once','SELECT 1;','SELECT COUNT(*) AS n,COUNT(DISTINCT name) AS unique_names,MAX(id) AS last_id FROM d1_migrations');
  step('post-migration-old-writer-refused',"DELETE FROM telemetry_v1_chunks WHERE id='synthetic-rehearsal-0-chunk-0';",combinedRead,'MUTATION_BARRIER');
  control.exec(sources[58].sql);check(JSON.stringify(schema(db).filter(o=>o.name!=='d1_migrations'))===JSON.stringify(schema(control)),'FINAL_SCHEMA');check(db.prepare('PRAGMA foreign_key_check').all().length===0,'FOREIGN_KEYS');
  const directory=resolve(outputDirectory);await mkdir(directory,{mode:0o700});await mkdir(join(directory,'sql'),{mode:0o700});await mkdir(join(directory,'canonical'),{mode:0o700});
  for(const source of sources)await writeFile(join(directory,'canonical',source.name),source.sql,{mode:0o600,flag:'wx'});
  const records=[];for(const [index,{sql,...entry}] of steps.entries()){const file=`sql/${String(index).padStart(3,'0')}.sql`;await writeFile(join(directory,file),sql,{mode:0o600,flag:'wx'});records.push({...entry,file});}
  const code=await Promise.all(RETAINED_QUALIFICATION_CODE_FILES.map(async file=>{const data=await readFile(join(root,file));const committed=spawnSync('git',['show',`${sourceRevision}:${posix.normalize('apps/worker/'+file)}`],{cwd:root,timeout:5000,maxBuffer:2*1024*1024});return{file,sha256:sha(data),matchesCommit:committed.status===0&&sha(committed.stdout)===sha(data)};}));
  const manifest={schemaVersion:'retained-reference-qualification-v1',mode:'plan-only',databaseName:RETAINED_QUALIFICATION_NAME,sourceRevision,code,codeCommitted:code.every(c=>c.matchesCommit),canonicalCommitted:sources.every(s=>s.matchesCommit),migrations:sources.map(({name,sha256,matchesCommit})=>({name,sha256,matchesCommit})),steps:records,
   limits:{maxQueryBytes:256*1024,maxSteps:256,queryTimeoutMs:45000,totalTimeoutMs:600000},fixture:{addedAuthorizations:26000,addedV1Chunks:26000,syntheticAuthorizationIdLength:96,syntheticR2KeyPaddingBytes:64,addedRangeRecords:8192,rangeRecordPaddingBytes:1024,localOriginalValuesAndMovedRowidsPreserved:true,retainedTables:retained,movedTables:setup.current.order,referenceCounts},localOnlyPassed:true,hostedExecuted:false,productionReady:false,localDurationMs:Math.ceil(performance.now()-started),peakRssBytes:peakRss,
   proofBoundary:'Synthetic retained-reference SQL qualification only; no production traffic, production size/CPU, R2 lock activation or drain guarantee. Historical fixtures bypass then restore source triggers before installing every product mutation guard.'};
  const data=JSON.stringify(manifest,null,2)+'\n';await writeFile(join(directory,'manifest.json'),data,{mode:0o600,flag:'wx'});return{manifestSha256:sha(data),steps:records.length,maxQueryBytes:Math.max(...records.map(r=>r.sqlBytes)),localOnlyPassed:true,hostedExecuted:false};
 }finally{db.close();control.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);check(args.length===2&&args[0]==='--output','ARGUMENTS');prepareRetainedReferenceQualification({outputDirectory:args[1]}).then(result=>console.log(JSON.stringify(result))).catch(()=>{console.error('RETAINED_QUALIFICATION_PREPARATION_FAILED');process.exitCode=1;});
}
