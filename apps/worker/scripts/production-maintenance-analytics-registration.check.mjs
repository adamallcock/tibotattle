import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { dependencyTreeDigest } from './production-deploy.mjs';
import { SYNTHETIC_D1_WORKER,syntheticD1Binding,closeSyntheticD1Bindings } from './d1-storage-local-d1.mjs';
import { MAINTENANCE_ANALYTICS_REGISTRATION_SQL,MAINTENANCE_ANALYTICS_REGISTRATION_INSERT,
 maintenanceAnalyticsRegistrationIntent,readMaintenanceAnalyticsRegistration,initializeMaintenanceAnalyticsRegistration } from './production-maintenance-analytics-registration.mjs';

const workerRoot=fileURLToPath(new URL('..',import.meta.url)),ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
const sourceId='synthetic-registration',namespace='synthetic:registration';
let runtimeBytes;
async function runtime(){
 if(!runtimeBytes){const result=await build({stdin:{contents:"export {initializeStorageAnalyticsRuntime} from './storage-analytics-runtime';",resolveDir:join(workerRoot,'src'),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',mainFields:['module','main'],logLevel:'silent'});runtimeBytes=result.outputFiles[0].contents;}
 return runtimeBytes;
}
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'maintenance-registration-'))),sourceDirectory=join(root,'apps/worker');t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(sourceDirectory,'src'),{recursive:true});await mkdir(join(sourceDirectory,'node_modules'));
 // The synthetic frozen repository contains the ACTUAL maintained initializer
 // bundled from this checkout. No mock initializer or readiness callback is
 // provided. This is adapter/recovery qualification, not a production artifact.
 await writeFile(join(sourceDirectory,'src/storage-analytics-runtime.ts'),await runtime());
 await writeFile(join(root,'.gitignore'),'node_modules/\n.release-build/\n');
 await writeFile(join(sourceDirectory,'node_modules/fixture.txt'),'synthetic dependency bytes\n');
 const git=args=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8'}).trim();git(['init','-q']);git(['add','.']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic maintained initializer']);
 const cutover={candidate:{sourceCommit:git(['rev-parse','HEAD']),dependencyDigest:await dependencyTreeDigest(join(sourceDirectory,'node_modules')),ingestionDatabaseId:ids[0],analyticsDatabaseId:ids[1],sourceId,sourceNamespace:namespace}};
 const dbs=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];t.after(()=>dbs.forEach(db=>db.close()));
 // Source role semantics are separately admitted by the cutover proof. These
 // minimal source pin tables exercise the initializer's exact guarded join.
 const sourceSQL=`CREATE TABLE storage_source_state(singleton INTEGER PRIMARY KEY,source_id TEXT NOT NULL);
 CREATE TABLE typed_v1_admission_state(id INTEGER PRIMARY KEY,source_namespace TEXT NOT NULL,runtime_contract_version INTEGER NOT NULL);
 CREATE TABLE typed_v11_admission_state(id INTEGER PRIMARY KEY,source_namespace TEXT NOT NULL,runtime_contract_version INTEGER NOT NULL);
 CREATE TABLE storage_ingestion_changes(sequence INTEGER PRIMARY KEY,event_digest TEXT,owner_digest TEXT,revision INTEGER,kind TEXT,object_digest TEXT,content_digest TEXT,authority_epoch INTEGER,public_authority_epoch INTEGER,recorded_ms INTEGER);`;
 dbs[0].exec(sourceSQL);dbs[0].prepare('INSERT INTO storage_source_state VALUES(1,?)').run(sourceId);
 for(const version of ['v1','v11'])dbs[0].prepare(`INSERT INTO typed_${version}_admission_state VALUES(1,?,1)`).run(namespace);
 for(const name of (await readdir(join(workerRoot,'analytics-migrations'))).filter(name=>name.endsWith('.sql')).sort())dbs[1].exec(await readFile(join(workerRoot,'analytics-migrations',name),'utf8'));
 const calls=[];const queryDatabase=async(id,sql,params)=>{assert.ok(MAINTENANCE_ANALYTICS_REGISTRATION_SQL.includes(sql));assert.ok(ids.includes(id));calls.push({id,sql,params});return {success:true,results:dbs[ids.indexOf(id)].prepare(sql).all(...params).map(row=>({...row})),meta:{size_after:8000000}};};
 return {root,sourceDirectory,cutover,dbs,calls,options:{cutover,sourceDirectory,queryDatabase},queryDatabase,writes:()=>calls.filter(x=>x.sql===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT).length};
}

test('maintained initializer inserts exactly once; read-only reconciliation and repeat preserve exact registration',async t=>{
 const f=await fixture(t),intent=maintenanceAnalyticsRegistrationIntent(f.cutover);
 assert.equal(intent.databaseId,ids[1]);assert.match(intent.statementDigest,/^[a-f0-9]{64}$/);
 assert.equal((await readMaintenanceAnalyticsRegistration(f.options)).state,'absent');assert.equal(f.writes(),0);
 const r=await initializeMaintenanceAnalyticsRegistration(f.options);assert.equal(r.state,'present');assert.equal(r.writeAttempted,true);assert.equal(r.registrationOnly,true);assert.equal(r.analyticsCaughtUp,false);assert.equal(r.privacyReady,false);assert.ok(r.queries<=24);assert.equal(f.writes(),1);
 assert.deepEqual(f.dbs[1].prepare('SELECT * FROM analytics_runtime_sources').all().map(row=>({...row})),[{source_id:sourceId,source_namespace:namespace,contract_version:1}]);
 assert.equal((await readMaintenanceAnalyticsRegistration(f.options)).writeAttempted,false);
 assert.equal((await initializeMaintenanceAnalyticsRegistration(f.options)).writeAttempted,false);assert.equal(f.writes(),1);
});
test('source, namespace, target role and existing registration conflicts refuse before writes',async t=>{
 const f=await fixture(t);
 for(const key of ['ingestionDatabaseId','analyticsDatabaseId']){const cutover=structuredClone(f.cutover);cutover.candidate[key]='invalid';await assert.rejects(initializeMaintenanceAnalyticsRegistration({...f.options,cutover}),/PINS_INVALID/);}
 f.dbs[0].prepare('UPDATE typed_v1_admission_state SET source_namespace=?').run('wrong');await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),/SOURCE_ROLE_INVALID/);
 f.dbs[0].prepare('UPDATE typed_v1_admission_state SET source_namespace=?').run(namespace);
 f.dbs[1].exec('CREATE TABLE participants(id TEXT)');await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),/TARGET_ROLE_INVALID/);f.dbs[1].exec('DROP TABLE participants');
 f.dbs[1].prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').run(sourceId,'wrong');await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),/REGISTRATION_CONFLICT/);
 assert.equal(f.writes(),0);
});
test('write loss before effect stays absent; loss after effect is recovered without a second INSERT',async t=>{
 const f=await fixture(t);let effects=0;
 f.options.queryDatabase=async(...args)=>{if(args[1]===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT){effects++;throw new Error('private provider detail');}return f.queryDatabase(...args);};
 await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),{code:'PRODUCTION_MAINTENANCE_REGISTRATION_WRITE_UNCERTAIN'});assert.equal(effects,1);
 assert.equal((await readMaintenanceAnalyticsRegistration(f.options)).state,'absent');assert.equal(effects,1);
 f.options.queryDatabase=async(...args)=>{const r=await f.queryDatabase(...args);if(args[1]===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT){effects++;throw new Error('lost committed response');}return r;};
 await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),{code:'PRODUCTION_MAINTENANCE_REGISTRATION_WRITE_UNCERTAIN'});assert.equal(effects,2);
 assert.equal((await readMaintenanceAnalyticsRegistration(f.options)).state,'present');assert.equal(effects,2);
 assert.equal((await initializeMaintenanceAnalyticsRegistration(f.options)).writeAttempted,false);assert.equal(effects,2);assert.equal(f.writes(),1);
});
test('malformed write reply and post-write source changes remain unresolved instead of retrying',async t=>{
 const f=await fixture(t);f.options.queryDatabase=async(...args)=>{const r=await f.queryDatabase(...args);return args[1]===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT?{success:false,results:[]}:r;};
 await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),/WRITE_UNCERTAIN/);assert.equal(f.writes(),1);
 assert.equal((await readMaintenanceAnalyticsRegistration({...f.options,queryDatabase:f.queryDatabase})).state,'present');
 const g=await fixture(t);g.options.queryDatabase=async(...args)=>{const r=await g.queryDatabase(...args);if(args[1]===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT)await writeFile(join(g.sourceDirectory,'src/drift.ts'),'export const drift=1;');return r;};
 await assert.rejects(initializeMaintenanceAnalyticsRegistration(g.options),/SOURCE_CHANGED/);assert.equal(g.writes(),1);
});
test('frozen source/dependency drift and unreviewed maintained SQL fail closed',async t=>{
 const f=await fixture(t);await writeFile(join(f.sourceDirectory,'node_modules/fixture.txt'),'changed');await assert.rejects(initializeMaintenanceAnalyticsRegistration(f.options),/DEPENDENCIES_CHANGED/);assert.equal(f.calls.length,0);
 const g=await fixture(t);const path=join(g.sourceDirectory,'src/storage-analytics-runtime.ts');await writeFile(path,(await readFile(path,'utf8')).replace("SELECT 1 FROM sqlite_schema","SELECT 2 FROM sqlite_schema"));
 execFileSync('/usr/bin/git',['-C',g.root,'add','.']);execFileSync('/usr/bin/git',['-C',g.root,'-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','unreviewed query drift']);g.cutover.candidate.sourceCommit=execFileSync('/usr/bin/git',['-C',g.root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 await assert.rejects(initializeMaintenanceAnalyticsRegistration(g.options),/QUERY_NOT_ADMITTED/);assert.equal(g.writes(),0);
});
test('present registration still demands exact source journal continuity and bounded read responses',async t=>{
 const f=await fixture(t);await initializeMaintenanceAnalyticsRegistration(f.options);
 const row=[1,'1'.repeat(64),'2'.repeat(64),1,'owner-active','3'.repeat(64),'4'.repeat(64),1,1,1000];
 f.dbs[0].prepare('INSERT INTO storage_ingestion_changes VALUES(?,?,?,?,?,?,?,?,?,?)').run(...row);
 f.dbs[1].prepare('INSERT INTO analytics_applied_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(sourceId,...row);
 assert.equal((await readMaintenanceAnalyticsRegistration(f.options)).state,'present');
 f.dbs[0].prepare('UPDATE storage_ingestion_changes SET content_digest=?').run('5'.repeat(64));await assert.rejects(readMaintenanceAnalyticsRegistration(f.options),/CONTINUITY_REQUIRED/);
 await assert.rejects(readMaintenanceAnalyticsRegistration({...f.options,queryDatabase:async()=>({success:true,results:[{},{}]})}),/READ_INVALID/);
 await assert.rejects(readMaintenanceAnalyticsRegistration({...f.options,queryDatabase:async()=>({success:true,results:[{oversize:'x'.repeat(65537)}]})}),/READ_INVALID/);
 assert.equal(f.writes(),1);
});
test('actual maintained initializer and fixed adapter execute on native local D1',async t=>{
 const f=await fixture(t),mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:['SOURCE','TARGET']});
 try{
  const dbs=[await syntheticD1Binding(mf,'SOURCE'),await syntheticD1Binding(mf,'TARGET')];
  for(const [i,db]of dbs.entries()){
   const schema=f.dbs[i].prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all();
   for(const row of schema.filter(x=>x.type!=='trigger'))await db.prepare(row.sql).run();
   for(const row of schema.filter(x=>x.type==='table')){
    const values=f.dbs[i].prepare(`SELECT * FROM "${row.name}"`).all();for(const value of values){const columns=Object.keys(value);await db.prepare(`INSERT INTO "${row.name}"(${columns.map(c=>`"${c}"`).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...Object.values(value)).run();}
   }
   for(const row of schema.filter(x=>x.type==='trigger'))await db.prepare(row.sql).run();
  }
  let writes=0;const queryDatabase=async(id,sql,params)=>{if(sql===MAINTENANCE_ANALYTICS_REGISTRATION_INSERT)writes++;return dbs[ids.indexOf(id)].prepare(sql).bind(...params).all();};
  const r=await initializeMaintenanceAnalyticsRegistration({...f.options,queryDatabase});assert.equal(r.state,'present');assert.equal(writes,1);
  assert.equal((await readMaintenanceAnalyticsRegistration({...f.options,queryDatabase})).state,'present');assert.equal(writes,1);
 }finally{await closeSyntheticD1Bindings(mf);await mf.dispose();}
});
