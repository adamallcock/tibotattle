/** Prepares immutable synthetic SQL only; never creates or contacts a remote D1. */
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountlessMovementSelection, planAccountlessMovementBatch } from './accountless-migration-movement.mjs';
import { buildMutationBarrierPermissionStatements, buildMutationBarrierSetupStatements, buildMutationBarrierReinstallStatements, mutationBarrierProductTablesFromSchema } from '../src/mutation-barrier.ts';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const QUALIFICATION_NAME='tibotattle-bounded58-20260909-70c70f1d';
const operation='bounded58-20260909-70c70f1d';
const baseRevision='70c70f1dbebffe1a75f0fdbc93037a8c0e2d25ac';
const sha=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw new Error('BOUNDED_QUALIFICATION_'+code)};
const assert=(value,code)=>{if(!value)fail(code)};
const literal=value=>value===null?'NULL':typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'?"'"+value.replaceAll("'","''")+"'":fail('PARAM_INVALID');
// Only fixed generated statement templates reach this function, never canonical SQL.
function render(statement){assert((statement.sql.match(/\?/g)||[]).length===statement.params.length,'PARAM_COUNT');let i=0;return statement.sql.replace(/\?/g,()=>literal(statement.params[i++]));}
const pack=statements=>statements.map(render).join(';\n')+';';
const ledgerRead="SELECT name FROM d1_migrations ORDER BY id";
const movementRead=`SELECT (SELECT metadata FROM _accountless_move_journal WHERE id=1) AS metadata,
(SELECT COUNT(*) FROM bounded_probe_parent) AS parents,(SELECT COUNT(*) FROM bounded_probe_child) AS children,
(SELECT COUNT(*) FROM _accountless_move_bounded_probe_parent) AS saved_parents,(SELECT COUNT(*) FROM _accountless_move_bounded_probe_child) AS saved_children,
(SELECT COUNT(*) FROM _accountless_migration_barrier_permission_v1) AS permissions`;
function read(db,sql){return db.prepare(sql).all();}
function atomic(db,sql){db.exec('BEGIN IMMEDIATE');try{db.exec(sql);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}

export async function prepareBoundedQualification({outputDirectory}={}) {
 assert(typeof outputDirectory==='string'&&outputDirectory.length>0,'OUTPUT_REQUIRED');
 const names=(await readdir(join(root,'migrations'))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort();assert(names.length===59,'SOURCE_COUNT');
 const sources=await Promise.all(names.map(async name=>({name,sql:await readFile(join(root,'migrations',name),'utf8')})));
 assert(sha(sources[57].sql)==='b435fd92d41e7ce8067cc183d7ac153359a9c130a971cba2e1b8b8c1c9cab61b'&&sha(sources[58].sql)==='98afb99dd91e56a96960e6d99096e44c41eec0cd52d5a1e2969dea4ddee3d312','SOURCE_HASH');
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:1024});
 assert(head.status===0&&/^[a-f0-9]{40}\s*$/.test(head.stdout),'SOURCE_REVISION');const sourceRevision=head.stdout.trim();
 const committedNames=spawnSync('git',['ls-tree','--full-tree','--name-only',`${sourceRevision}:apps/worker/migrations`],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:32768});
 assert(committedNames.status===0&&JSON.stringify(committedNames.stdout.trim().split('\n').sort())===JSON.stringify(names),'CANONICAL_NAME_DRIFT');
 for(const source of sources){const committed=spawnSync('git',['show',`${sourceRevision}:apps/worker/migrations/${source.name}`],{cwd:root,timeout:5000,maxBuffer:2*1024*1024});source.matchesCommit=committed.status===0&&sha(committed.stdout)===sha(source.sql);}
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;PRAGMA max_page_count=32768');
 const steps=[];
 function step(name,sql,readback=ledgerRead,expectedFailure=false){
  assert(Buffer.byteLength(sql)<=120*1024,'QUERY_BYTES');const start=performance.now();let failed=false;
  try{atomic(db,sql)}catch(e){if(!expectedFailure||!String(e.message).includes(expectedFailure===true?'CHECK constraint failed':expectedFailure))throw e;failed=true;}
  assert(failed===Boolean(expectedFailure),'EXPECTED_FAILURE_NOT_OBSERVED');
  steps.push({name,sql,sqlSha256:sha(sql),sqlBytes:Buffer.byteLength(sql),readback,expectedRows:read(db,readback),expectedFailure:Boolean(expectedFailure),expectedError:expectedFailure===true?'CHECK constraint failed':expectedFailure||null,localDurationMs:Math.ceil(performance.now()-start)});
 }
 try{
  // Same ledger schema used by pinned Wrangler migrations apply; every original SQL
  // file and its ordinary name append execute atomically. No fabricated prefix.
  step('create-ledger',`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`);
  for(const source of sources.slice(0,57))step(source.name,source.sql+`\nINSERT INTO d1_migrations(name) VALUES(${literal(source.name)});`);
  const current={digest:sha(JSON.stringify(sources.map(s=>[s.name,sha(s.sql)]))),phase:'evacuate',revision:0,tableIndex:0,cursor:0,order:['bounded_probe_parent','bounded_probe_child'],sequences:[],canonicalObjects:null,descriptors:{
   bounded_probe_parent:{columns:['id','payload'],hasRowid:true,keys:['rowid'],integerKeys:['rowid']},
   bounded_probe_child:{columns:['id','parent_id','note'],hasRowid:true,keys:['rowid'],integerKeys:['rowid']},
  }};
  step('synthetic-fixture',`CREATE TABLE bounded_probe_parent(id INTEGER PRIMARY KEY,payload BLOB NOT NULL);
CREATE TABLE bounded_probe_child(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES bounded_probe_parent(id) ON DELETE CASCADE,note TEXT);
INSERT INTO bounded_probe_parent VALUES(1,zeroblob(1048575));
INSERT INTO bounded_probe_child VALUES(9007199254741007,1,NULL),(9007199254741011,1,'synthetic');
CREATE TABLE _accountless_move_journal(id INTEGER PRIMARY KEY CHECK(id=1),metadata TEXT NOT NULL);
CREATE TABLE _accountless_move_assertion(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO _accountless_move_journal VALUES(1,${literal(JSON.stringify(current))});
CREATE TABLE _accountless_move_bounded_probe_parent(_move_key INTEGER PRIMARY KEY,_original_rowid INTEGER,id,payload);
CREATE TABLE _accountless_move_bounded_probe_child(_move_key INTEGER PRIMARY KEY,_original_rowid INTEGER,id,parent_id,note);`);
  const owned=['_accountless_move_bounded_probe_parent','_accountless_move_bounded_probe_child'];
  const productTables=()=>mutationBarrierProductTablesFromSchema(read(db,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),owned);
  const setup=buildMutationBarrierSetupStatements({operationId:operation,sourceRevision,createdAt:'2026-09-09T00:00:00.000Z',productTables:productTables()});
  // Fresh disposable target has no existing app traffic. Install generated guards
  // in fixed small groups; do not infer that this is a production drain protocol.
  for(let i=0;i<setup.length;i+=18)step(`barrier-setup-${i/18}`,pack(setup.slice(i,i+18)));
  const permission=buildMutationBarrierPermissionStatements(operation);
  const permitted=statements=>pack([permission.begin,...statements,...permission.end]);
  const state=()=>JSON.parse(read(db,'SELECT metadata FROM _accountless_move_journal WHERE id=1')[0].metadata);
  const next=()=>{const now=state(),selection=accountlessMovementSelection(now,{maxRows:2});return planAccountlessMovementBatch({current:now,selectedRows:read(db,selection.sql),expectedRevision:now.revision,maxRows:2,maxBytes:1048576,permission});};
  step('old-writer-refused','DELETE FROM bounded_probe_parent WHERE id=1;',movementRead,'ACCOUNTLESS_MIGRATION_MUTATION_BARRIER');
  const first=next();
  step('late-failure-rollback',pack(first.statements)+'\nINSERT INTO _accountless_move_assertion VALUES(1,0);',movementRead,true);
  step('children-evacuated',pack(first.statements),movementRead);
  step('batch-replay-refused',pack(first.statements),movementRead,true);
  const large=next();assert(large.result.bytes===1048576&&large.result.rows===1,'MAX_ROW_NOT_EXERCISED');
  step('one-mib-parent-evacuated',pack(large.statements),movementRead);
  const restored={...state(),phase:'restore',tableIndex:0,cursor:0};
  step('restore-phase',permitted([{sql:'UPDATE _accountless_move_journal SET metadata=? WHERE id=1',params:[JSON.stringify(restored)]}]),movementRead);
  step('one-mib-parent-restored',pack(next().statements),movementRead);
  step('children-restored',pack(next().statements),movementRead);
  step('exact-restored-rowids','SELECT 1;',"SELECT CAST(id AS TEXT) AS id,note FROM bounded_probe_child ORDER BY id");
  step('exact-restored-large-row','SELECT 1;',"SELECT length(payload) AS payload_bytes FROM bounded_probe_parent WHERE id=1");
  const beforeTables=productTables();
  // Canonical 0058 recreates two roots and adds tables. Only those guards need
  // reinstalling in this same query; unchanged tables retain their guards.
  const control=new DatabaseSync(':memory:');
  try{control.exec('PRAGMA foreign_keys=ON');for(const source of sources.slice(0,58))control.exec(source.sql);
   const after=read(control,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r=>r.name).filter(n=>!n.startsWith('sqlite_'));
   const reinstall=buildMutationBarrierReinstallStatements([...new Set(['participants','device_credentials',...after.filter(n=>!beforeTables.includes(n))])]);
   step('canonical-0058',render(permission.begin)+';\n'+sources[57].sql+`\nINSERT INTO d1_migrations(name) VALUES(${literal(sources[57].name)});\n`+pack([...reinstall,...permission.end]));
  }finally{control.close();}
  step('canonical-0059',render(permission.begin)+';\n'+sources[58].sql+`\nINSERT INTO d1_migrations(name) VALUES(${literal(sources[58].name)});\n`+pack(permission.end));
  step('final-foreign-keys','SELECT 1;','PRAGMA foreign_key_check');
  step('final-guard-count','SELECT 1;',"SELECT COUNT(*) AS guards FROM sqlite_master WHERE type='trigger' AND name GLOB '_accountless_migration_barrier_v1_*'");
  step('canonical-ledger-once','SELECT 1;',"SELECT COUNT(*) AS n,COUNT(DISTINCT name) AS distinct_names,MAX(id) AS last_id FROM d1_migrations");
  step('post-migration-old-writer-refused','DELETE FROM bounded_probe_parent WHERE id=1;',movementRead,'ACCOUNTLESS_MIGRATION_MUTATION_BARRIER');
  step('post-migration-root-refused',"INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,consent_version,consented_at,created_at) VALUES('synthetic-refused','synthetic-access',zeroblob(32),'synthetic-recovery',zeroblob(32),'synthetic','2026-09-09','2026-09-09');",movementRead,'ACCOUNTLESS_MIGRATION_MUTATION_BARRIER');
  assert(read(db,'PRAGMA foreign_key_check').length===0,'LOCAL_FOREIGN_KEY_CHECK');
  const directory=resolve(outputDirectory);await mkdir(directory,{mode:0o700});
  await mkdir(join(directory,'sql'),{mode:0o700});await mkdir(join(directory,'canonical'),{mode:0o700});
  for(const source of sources)await writeFile(join(directory,'canonical',source.name),source.sql,{flag:'wx',mode:0o444});
  const records=[];
  for(const [i,{sql,...record}] of steps.entries()){const file=`sql/${String(i).padStart(3,'0')}.sql`;await writeFile(join(directory,file),sql,{flag:'wx',mode:0o444});records.push({...record,file});}
  const codeFiles=['scripts/prepare-bounded-migration-qualification.mjs','scripts/accountless-migration-movement.mjs','src/mutation-barrier.ts','scripts/run-bounded-migration-qualification.mjs'];
  const code=await Promise.all(codeFiles.map(async file=>{const bytes=await readFile(join(root,file));const committed=spawnSync('git',['show',`${sourceRevision}:apps/worker/${file}`],{cwd:root,timeout:5000,maxBuffer:2*1024*1024});return {file,sha256:sha(bytes),matchesCommit:committed.status===0&&sha(committed.stdout)===sha(bytes)};}));
  const manifest={schemaVersion:'bounded-migration-qualification-v1',mode:'plan-only',databaseName:QUALIFICATION_NAME,baseRevision,sourceRevision,code,codeCommitted:code.every(c=>c.matchesCommit),canonicalCommitted:sources.every(s=>s.matchesCommit),
   migrations:sources.map(s=>({name:s.name,sha256:sha(s.sql),matchesCommit:s.matchesCommit})),limits:{maxRowBytes:1048576,maxRows:2,maxQueryBytes:120*1024,queryTimeoutMs:45000,totalTimeoutMs:600000},
   steps:records,localSqliteVersion:process.versions.sqlite,localOnlyPassed:true,hostedExecuted:false,productionReady:false,
   proofBoundary:'SQL viability only; no production data, read draining, R2 quiescence or migration throughput qualification',cleanup:'Delete only the newly created exact database after every readback succeeds; retain failed target for inspection, never retry migration automatically.'};
  const bytes=JSON.stringify(manifest,null,2)+'\n';await writeFile(join(directory,'manifest.json'),bytes,{flag:'wx',mode:0o444});
  return {manifestSha256:sha(bytes),steps:records.length,maxQueryBytes:Math.max(...records.map(s=>s.sqlBytes)),localOnlyPassed:true,hostedExecuted:false};
 }finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--output')fail('PLAN_ARGUMENTS');
 prepareBoundedQualification({outputDirectory:args[1]}).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('BOUNDED_QUALIFICATION_PLAN_FAILED');process.exitCode=1;});
}
