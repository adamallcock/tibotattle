import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,readdir,realpath,rm,symlink,lstat,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { INGESTION_ROLE_INPUT_DIRECTORIES } from './d1-storage-role.mjs';
import { D1_STORAGE_SCHEMA_DIRECTORIES,loadStorageQualification,storageSchemaDigest,storageSha256 } from './d1-storage-plan.mjs';
import { parseRoleQualificationArguments,qualifyStorageRole,readStorageRoleQualificationInputs,verifyStorageOwningGate } from './d1-storage-qualify-role.mjs';

const actualWorker=dirname(dirname(fileURLToPath(import.meta.url)));
const emitter=join(actualWorker,'scripts','d1-storage-qualify-role.mjs');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const missing=async path=>assert.rejects(access(path),{code:'ENOENT'});
const simpleRole=[['0001_parent.sql','CREATE TABLE parent(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(1);'],
 ['0002_child.sql','CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO child VALUES(1,1); CREATE INDEX child_parent ON child(parent_id);']];
async function fixture(t,{actual=false,migrations=simpleRole}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'d1-role-qualification-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const repository=join(root,'source'),workerRoot=join(repository,'apps','worker');
 await mkdir(join(workerRoot,'scripts'),{recursive:true});
 await writeFile(join(repository,'.gitignore'),'node_modules/\n');
 await writeFile(join(workerRoot,'package.json'),'{}\n');
 await writeFile(join(workerRoot,'scripts','d1-storage-qualify-role.mjs'),await readFile(emitter));
 // These input pins exercise the maintained source reader, not an ingestion
 // rehearsal. Each non-ingestion test applies only its own role's SQL.
 for(const directory of INGESTION_ROLE_INPUT_DIRECTORIES){await mkdir(join(workerRoot,directory));
  await writeFile(join(workerRoot,directory,'0001_synthetic.sql'),'CREATE TABLE ignored_ingestion_fixture(id INTEGER PRIMARY KEY);\n');}
 for(const role of ['control','analytics']){
  const directory=D1_STORAGE_SCHEMA_DIRECTORIES[role];await mkdir(join(workerRoot,directory));
  const files=actual?(await readdir(join(actualWorker,directory))).filter(name=>name.endsWith('.sql')).sort():migrations.map(([name])=>name);
  for(const name of files)await writeFile(join(workerRoot,directory,name),actual?await readFile(join(actualWorker,directory,name)):migrations.find(([n])=>n===name)[1]);
 }
 await symlink(join(actualWorker,'node_modules'),join(workerRoot,'node_modules'),'dir');
 const git=args=>{const r=spawnSync('git',args,{cwd:repository,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 git(['init','--quiet']);git(['add','.']);
 git(['-c','user.name=Synthetic qualification test','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic role qualification fixture']);
 return {root,repository,workerRoot,sourceCommit:git(['rev-parse','HEAD']),git};
}
async function gate(f,{overrides={},name='gate'}={}){
 const directory=join(f.root,name);await mkdir(directory);
 // Explicit synthetic receipt/parser fixture. This text is never represented
 // as a real Worker check invocation or retained as production qualification.
 const stdout=Buffer.from('Synthetic owning-gate receipt test fixture.\n'),stderr=Buffer.alloc(0);
 const receipt={schema:'d1-storage-owning-gate-v1',sourceCommit:f.sourceCommit,command:'npm run check',
  workingDirectory:'apps/worker',roles:['analytics','control'],exitCode:0,
  startedAt:'2026-01-01T00:00:00.000Z',completedAt:'2026-01-01T00:01:00.000Z',
  stdoutSha256:storageSha256(stdout),stderrSha256:storageSha256(stderr),...overrides};
 const bytes=Buffer.from(`${JSON.stringify(receipt)}\n`),gateReceipt=join(directory,'receipt.json'),gateStdout=join(directory,'stdout.log'),gateStderr=join(directory,'stderr.log');
 await writeFile(gateReceipt,bytes);await writeFile(gateStdout,stdout);await writeFile(gateStderr,stderr);
 return {gateReceipt,gateReceiptSha256:storageSha256(bytes),gateStdout,gateStderr};
}

test('closed local CLI rejects remote, ingestion, duplicate and incomplete qualification arguments',()=>{
 const base=['--worker-root','/synthetic','--directory','/synthetic-output','--role','analytics'];
 assert.deepEqual(parseRoleQualificationArguments(base),{qualify:false,allowUnfrozen:false,workerRoot:'/synthetic',directory:'/synthetic-output',role:'analytics'});
 for(const extra of [['--remote'],['--binding','PRODUCTION'],['--role','control'],['--qualify'],['--gate-stdout','log'],['--allow-unfrozen','--allow-unfrozen']])
  assert.throws(()=>parseRoleQualificationArguments([...base,...extra]),/D1_STORAGE_ARGUMENTS/);
 assert.throws(()=>parseRoleQualificationArguments(base.map(value=>value==='analytics'?'ingestion':value)),/D1_STORAGE_ARGUMENTS/);
 assert.throws(()=>parseRoleQualificationArguments([...base,'--qualify','--allow-unfrozen']),/D1_STORAGE_ARGUMENTS/);
});

test('owning gate binds exact source, roles, successful command, timestamps, receipt and log bytes',async t=>{
 const f=await fixture(t),options=await gate(f),pin={sourceCommit:f.sourceCommit,role:'control'};
 assert.equal((await verifyStorageOwningGate(options,pin)).receipt.exitCode,0);
 await assert.rejects(verifyStorageOwningGate({...options,gateReceiptSha256:'0'.repeat(64)},pin),/OWNING_GATE_CHANGED/);
 await assert.rejects(verifyStorageOwningGate(options,{...pin,sourceCommit:'0'.repeat(40)}),/OWNING_GATE_INVALID/);
 const cases=[{command:'npm test'},{workingDirectory:'.'},{exitCode:1},{roles:['analytics']},{roles:['control','control']},
  {roles:['control','ingestion']},{completedAt:'2025-12-31T00:00:00.000Z'},{completedAt:'2999-01-01T00:00:00.000Z'},
  {startedAt:'not a timestamp'},{unexpected:true}];
 for(let i=0;i<cases.length;i++)await assert.rejects(verifyStorageOwningGate(await gate(f,{overrides:cases[i],name:`invalid-${i}`}),pin));
 await writeFile(options.gateStdout,'Changed fixture log.');
 await assert.rejects(verifyStorageOwningGate(options,pin),/OWNING_GATE_LOG_CHANGED/);
 const unsafe=await gate(f,{name:'symlink'}),link=join(f.root,'linked-log');await symlink(unsafe.gateStdout,link);
 await assert.rejects(verifyStorageOwningGate({...unsafe,gateStdout:link},pin),/QUALIFICATION_FILE_UNSAFE/);
});

for(const role of ['control','analytics'])test(`actual ordered ${role} migrations produce source-bound, loader-accepted native D1 schema evidence`,async t=>{
 const f=await fixture(t,{actual:true}),options=await gate(f),directory=join(f.root,'result'),progress=[];
 const input=await readStorageRoleQualificationInputs(f.workerRoot,role);
 const result=await qualifyStorageRole({workerRoot:f.workerRoot,directory,role,qualify:true,...options,onProgress:step=>progress.push(step)});
 assert.equal(result.status,'qualified');assert.equal(result.runtimeReady,false);assert.equal(result.remoteOperations,false);
 assert.equal(result.sourceCommit,f.sourceCommit);assert.equal(result.migrationsApplied,input.migrations.length);
 assert.deepEqual(progress.map(step=>step.migrationsApplied),input.migrations.map((_,i)=>i+1));
 const roleDirectory=join(result.workerRoot,D1_STORAGE_SCHEMA_DIRECTORIES[role]);
 const loaded=await loadStorageQualification({workerRoot:result.workerRoot,plan:{sourceCommit:f.sourceCommit},target:{role,qualificationSha256:result.qualificationSha256}});
 const proof=await json(join(roleDirectory,'qualification-evidence.json')),schemaBytes=await readFile(join(directory,'final-schema.json'));
 assert.equal(proof.scope,'fresh-synthetic-role-schema');assert.equal(proof.runtimeReady,false);
 assert.equal(proof.owningGateLogsVerified,true);assert.equal(proof.owningGate.receiptSha256,options.gateReceiptSha256);
 assert.equal(proof.initialSchemaSha256,storageSchemaDigest([]));
 assert.equal(proof.finalSchemaSha256,storageSchemaDigest(JSON.parse(schemaBytes)));
 assert.equal(proof.finalSchemaFileSha256,storageSha256(schemaBytes));assert.equal(proof.foreignKeyViolations,0);
 assert.equal(loaded.schemaSha256,result.schemaSha256);assert.equal(proof.sourceCommit,f.sourceCommit);
 assert.equal(storageSha256(await readFile(join(roleDirectory,'owning-gate.stdout.log'))),proof.owningGate.stdoutSha256);
 assert.equal(storageSha256(await readFile(join(roleDirectory,'owning-gate.stderr.log'))),proof.owningGate.stderrSha256);
 assert.equal((await lstat(directory)).mode&0o077,0);
 for(let i=0;i<loaded.migrations.length;i++){
  const step=loaded.migrations[i],receipt=await json(join(directory,`${step.name}.result.json`));
  assert.equal(step.sha256,input.migrations[i].sha256);assert.equal(receipt.afterSchemaSha256,step.afterSchemaSha256);
  assert.equal(receipt.foreignKeyViolations,0);assert.ok(receipt.statements>=1&&receipt.statements<=900);
  assert.equal(step.beforeSchemaSha256,i===0?storageSchemaDigest([]):loaded.migrations[i-1].afterSchemaSha256);
 }
 assert.ok(JSON.parse(schemaBytes).some(row=>row.type==='table'&&row.name===(role==='analytics'?'analytics_source_cursors':'storage_shards')));
 await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role,qualify:true,...options}),{code:'EEXIST'});
 await writeFile(join(roleDirectory,input.migrations[0].name),'Changed immutable migration.');
 await assert.rejects(loadStorageQualification({workerRoot:result.workerRoot,plan:{sourceCommit:f.sourceCommit},target:{role,qualificationSha256:result.qualificationSha256}}),/MIGRATION_CHANGED_OR_RESERVED/);
});

test('dirty source can rehearse but cannot emit a qualified role',async t=>{
 const f=await fixture(t),directory=join(f.root,'dirty-result');await writeFile(join(f.repository,'dirty.txt'),'synthetic change');
 await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',qualify:true,...await gate(f)}),/SOURCE_NOT_FROZEN/);
 await missing(directory);
 const result=await qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',allowUnfrozen:true});
 assert.equal(result.status,'unqualified');assert.equal(result.frozenSource,false);
 const proof=await json(join(result.workerRoot,'routing-migrations','qualification-evidence.json'));
 assert.equal(proof.owningGate,null);assert.equal(proof.owningGateLogsVerified,false);assert.equal(proof.runtimeReady,false);
 await assert.rejects(loadStorageQualification({workerRoot:result.workerRoot,plan:{sourceCommit:f.sourceCommit},target:{role:'control',qualificationSha256:result.qualificationSha256}}),/QUALIFICATION_INVALID/);
});

test('changed source or gate logs during rehearsal leave receipts but no qualified manifest',async t=>{
 for(const change of ['source','log']){
  const f=await fixture(t),options=await gate(f),directory=join(f.root,`${change}-changed`);let calls=0;
  await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',qualify:true,...options,onProgress:async()=>{
   if(calls++===0)await writeFile(change==='source'?join(f.repository,'new-source.txt'):options.gateStdout,'Synthetic mutation during rehearsal.');
  }}),change==='source'?/SOURCE_NOT_FROZEN/:/OWNING_GATE_LOG_CHANGED/);
  assert.equal(calls,2);assert.equal((await json(join(directory,'failure.json'))).qualified,false);
  await access(join(directory,'0001_parent.sql.intent.json'));await access(join(directory,'0002_child.sql.result.json'));
  await missing(join(directory,'worker','routing-migrations','qualification.json'));
 }
});

test('failed migration is a single native transaction, preserves intent and refuses directory replay',async t=>{
 const f=await fixture(t,{migrations:[simpleRole[0],['0002_invalid.sql',
  'CREATE TABLE should_roll_back(id INTEGER PRIMARY KEY); INSERT INTO parent VALUES(2); INSERT INTO parent VALUES(1);']]}),directory=join(f.root,'failed'),options=await gate(f);
 await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',qualify:true,...options}),/SYNTHETIC_D1_OPERATION_FAILED/);
 const failure=await json(join(directory,'failure.json'));
 assert.equal(failure.migrationsApplied,1);assert.equal(failure.activeMigration,'0002_invalid.sql');assert.equal(failure.qualified,false);
 await access(join(directory,'0002_invalid.sql.intent.json'));await missing(join(directory,'0002_invalid.sql.result.json'));
 await missing(join(directory,'worker','routing-migrations','qualification.json'));
 const sqliteFiles=(await readdir(join(directory,'local-d1'),{recursive:true})).filter(name=>name.endsWith('.sqlite'));
 // Miniflare also persists its private metadata database. Find the one actual
 // synthetic D1 database by its tested schema instead of its hashed filename.
 let matchingDatabases=0;
 for(const name of sqliteFiles){const db=new DatabaseSync(join(directory,'local-d1',name),{readOnly:true});
  try{if(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='parent'").get().n===0)continue;
   matchingDatabases++;assert.equal(db.prepare('SELECT count(*) n FROM parent').get().n,1);
   assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='should_roll_back'").get().n,0);
  }finally{db.close();}}
 assert.equal(matchingDatabases,1);
 await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',qualify:true,...options}),{code:'EEXIST'});
});

test('qualification refuses an emitter outside the exact frozen source',async t=>{
 const f=await fixture(t),directory=join(f.root,'different-emitter');
 await writeFile(join(f.workerRoot,'scripts','d1-storage-qualify-role.mjs'),'// Different reviewed source emitter.\n');
 f.git(['add','.']);f.git(['-c','user.name=Synthetic qualification test','-c','user.email=synthetic@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic different emitter']);
 f.sourceCommit=f.git(['rev-parse','HEAD']);
 const newGate=await gate(f,{name:'different-emitter-gate'});
 await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',qualify:true,...newGate}),/QUALIFICATION_EMITTER_CHANGED/);
 await missing(directory);
});

test('a changed next migration is refused before its intent or SQL submission',async t=>{
 const f=await fixture(t),directory=join(f.root,'changed-sql');
 await assert.rejects(qualifyStorageRole({workerRoot:f.workerRoot,directory,role:'control',allowUnfrozen:true,onProgress:async()=>{
  await writeFile(join(f.workerRoot,'routing-migrations','0002_child.sql'),'CREATE TABLE changed(id INTEGER PRIMARY KEY);');
 }}),/ROLE_INPUT_CHANGED/);
 assert.equal((await json(join(directory,'failure.json'))).migrationsApplied,1);
 await access(join(directory,'0001_parent.sql.result.json'));await missing(join(directory,'0002_child.sql.intent.json'));
 await missing(join(directory,'worker','routing-migrations','qualification.json'));
});
