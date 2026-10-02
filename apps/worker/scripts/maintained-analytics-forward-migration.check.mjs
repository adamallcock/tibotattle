import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, lstat, rm, cp, symlink, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { identityDigest, readOperation } from '../../../scripts/lib/release-operation.mjs';
import { storageSha256 } from './d1-storage-plan.mjs';
import { TYPED_SCHEMA_INPUT_DIRECTORIES } from './production-typed-schema.mjs';
import { MAINTAINED_FORWARD_LOCAL_CONFIRMATION, MAINTAINED_FORWARD_LOCAL_SQL_CAP, MAINTAINED_FORWARD_STEPS,
  createMaintainedAnalyticsSQLiteAdapter, loadMaintainedAnalyticsForwardLocalSteps,
  parseMaintainedForwardLocalArguments, prepareMaintainedAnalyticsForwardLocal,
  runMaintainedAnalyticsForwardLocal } from './maintained-analytics-forward-migration.mjs';

const workerDirectory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const codePins=Object.fromEntries(['public','analytics','publication','cache'].map(role=>[role,storageSha256(`synthetic-code-${role}`)]));
const localTargets={primary:'synthetic-source',analytics:'synthetic-analytics'};
const createdAt='2026-10-01T12:00:00.000Z';
const roots=[];
const planPromise=prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins,localTargets,createdAt});
after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
async function directory(){const root=await mkdtemp('/private/tmp/maintained-forward-check-');roots.push(root);return root;}
function seed({primary,analytics}){
  primary.exec("INSERT INTO participants(id,owner_kind,created_at) VALUES('synthetic-participant','accountless','2026-10-01T00:00:00.000Z')");
  analytics.exec("INSERT INTO analytics_runtime_sources VALUES('synthetic-source','synthetic-namespace',1)");
  analytics.exec("INSERT INTO analytics_source_cursors VALUES('synthetic-source',0,1)");
  analytics.prepare('INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)').run('synthetic-source','a'.repeat(64),1,1,'active');
  analytics.prepare(`INSERT INTO analytics_community_graph_results(source_id,owner_digest,metric,day,method,dependency_digest,
    input_revision,payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('synthetic-source','a'.repeat(64),'fits','2026-09-30','synthetic-local',
    'b'.repeat(64),1,'c'.repeat(64),'{}','d'.repeat(64),'{}',1,'effective');
}
async function runtime(options={}){
  const plan=await planPromise, adapter=await createMaintainedAnalyticsSQLiteAdapter({workerDirectory,plan,seed,...options});
  return {plan,adapter};
}
async function run(plan,adapter,operationDirectory,extra={}){
  return runMaintainedAnalyticsForwardLocal({plan,adapter,workerDirectory,operationDirectory,execute:true,
    confirmation:MAINTAINED_FORWARD_LOCAL_CONFIRMATION,approvedPlanSha256:identityDigest(plan),...extra});
}
const snapshot=async adapter=>({primary:await adapter.inspect('primary'),analytics:await adapter.inspect('analytics'),
  retained:await adapter.acceptedOutputSha256()});
async function copiedWorker(){
  const root=await directory(),worker=join(root,'worker');
  for(const folder of [...new Set([...TYPED_SCHEMA_INPUT_DIRECTORIES.primary,...TYPED_SCHEMA_INPUT_DIRECTORIES.analytics])])
    await cp(join(workerDirectory,folder),join(worker,folder),{recursive:true});
  await cp(join(workerDirectory,'package.json'),join(worker,'package.json'));
  await symlink(join(workerDirectory,'node_modules'),join(worker,'node_modules'));
  return worker;
}

test('closed eighteen-file plan pins complete prefixes, every frontier and local SQL sizes',async()=>{
  const plan=await planPromise;
  assert.equal(plan.status,'unreviewed-local');assert.equal(plan.hostedAcceptance,'unqualified');
  assert.equal(plan.sqlCapBytes,512*1024);assert.equal(plan.steps.length,18);assert.equal(plan.frontiers.length,19);
  assert.deepEqual(plan.steps.map(({role,directory,name})=>({role,directory,name})),MAINTAINED_FORWARD_STEPS);
  for(const step of plan.steps){
    assert.ok(step.atomicRequestBytes>step.bytes);assert.ok(step.atomicRequestBytes<=MAINTAINED_FORWARD_LOCAL_SQL_CAP);
    assert.ok(step.statementBytes.every(n=>n>0));
  }
  const selective=plan.steps[1];
  assert.ok(Math.max(...selective.statementBytes)<100_000);
  assert.ok(selective.statementBytes.length>100);
  for(let i=0;i<18;i++){
    const changed=plan.steps[i].role,other=changed==='primary'?'analytics':'primary';
    assert.notDeepEqual(plan.frontiers[i][changed],plan.frontiers[i+1][changed]);
    assert.deepEqual(plan.frontiers[i][other],plan.frontiers[i+1][other]);
  }
  assert.deepEqual(await prepareMaintainedAnalyticsForwardLocal({workerDirectory,codePins,localTargets,createdAt}),plan);
});

test('every exact migration and ledger append rolls back a late failure then commits once with retained output',async()=>{
  let failedName=null;
  const {plan,adapter}=await runtime({fault:async(stage,name)=>stage==='late'&&name===failedName});
  try{
    const steps=await loadMaintainedAnalyticsForwardLocalSteps({plan,workerDirectory});
    const retained=await adapter.acceptedOutputSha256();
    for(const [index,step]of steps.entries()){
      const sql=`${step.sql.trim()}\nINSERT INTO d1_storage_migrations(name,sha256) VALUES('${step.name}','${step.sha256}');\n`;
      const before=await snapshot(adapter);failedName=step.name;
      await assert.rejects(adapter.migrateAtomic(step,sql),/synthetic_missing_late_failure/u);
      assert.deepEqual(await snapshot(adapter),before);
      failedName=null;await adapter.migrateAtomic(step,sql);
      assert.equal(await adapter.acceptedOutputSha256(),retained);
      assert.deepEqual(await adapter.inspect(step.role),plan.frontiers[index+1][step.role]);
      assert.equal(adapter.databases[step.role].prepare('SELECT COUNT(*) n FROM d1_storage_migrations WHERE name=?').get(step.name).n,1);
      await assert.rejects(adapter.migrateAtomic(step,`${sql}DROP TABLE participants;`),{code:'MAINTAINED_FORWARD_LOCAL_MIGRATION_NOT_PINNED'});
    }
  }finally{adapter.close();}
});

test('full migration journal resumes without writes; activation and fallback preserve exact ledger, schema and retained rows',async()=>{
  const {plan,adapter}=await runtime();const root=await directory();
  try{
    const retained=await adapter.acceptedOutputSha256();
    assert.equal((await run(plan,adapter,join(root,'migrate'))).localSteps,18);
    const final=await snapshot(adapter);
    const journal=await readOperation(join(root,'migrate'));
    assert.equal(journal.kind,'qualification');assert.equal(journal.state.status,'complete');assert.equal(journal.state.next,18);
    assert.deepEqual(JSON.parse(await readFile(join(root,'migrate','plan.json'),'utf8')),plan);
    assert.equal((await lstat(join(root,'migrate','operation.json'))).mode&0o077,0);
    assert.equal((await run(plan,adapter,join(root,'migrate'),{resume:true})).remoteWrites,false);
    const writes=[];
    const set=adapter.setControls;adapter.setControls=async(...args)=>{writes.push(args);return set(...args);};
    await run(plan,adapter,join(root,'activate'),{phase:'activate'});
    assert.deepEqual(writes.map(x=>x[0]),['analytics','cache','publication','public']);
    writes.length=0;await run(plan,adapter,join(root,'fallback'),{phase:'fallback'});
    assert.deepEqual(writes.map(x=>x[0]),['public','publication','cache','analytics']);
    assert.ok(Object.values(await adapter.workers()).every(role=>Object.values(role.flags).every(value=>value==='disabled')));
    assert.equal(await adapter.acceptedOutputSha256(),retained);assert.deepEqual(await snapshot(adapter),final);
    assert.equal(adapter.databases.analytics.prepare("SELECT COUNT(*) n FROM d1_storage_migrations WHERE name='0047_analytics_cleanup_cadence.sql'").get().n,1);
    assert.equal(adapter.databases.analytics.prepare("SELECT COUNT(*) n FROM d1_storage_migrations WHERE name='0048_canonical_cache_prepared_receipts.sql'").get().n,1);
  }finally{adapter.close();}
});

test('0048 prepared scheduling receipts restore exactly and cascade only with their original parent work',async()=>{
  const {plan,adapter}=await runtime(),root=await directory();let restored;
  try{
    await run(plan,adapter,join(root,'migrate'));
    const db=adapter.databases.analytics,h=n=>String(n).padStart(64,'0');
    db.prepare("INSERT INTO analytics_owner_state VALUES(?,?,?,?,?)").run('synthetic-source','b'.repeat(64),1,1,'active');
    const parent=db.prepare(`INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,
      partition_key,input_revision,policy_revision,stage,state,lane,resident_bytes,admission_queries,revision,
      claim_token,claim_expires_ms,attempts,last_claimed,ready_ms,created_ms,updated_ms)
      VALUES(?,?,?,?,?,?,?,'cache','leased','new',1024,160,1,'11111111-1111-4111-8111-111111111111',10000,1,1,1,1,1)`);
    const receipt=db.prepare(`INSERT INTO analytics_canonical_cache_prepared_receipts
      VALUES(?,1,?,?,'canonical-cache-neighbors-v1',0,1)`);
    // These are scheduling-schema fixtures. No cache result or source proof
    // is manufactured, and the receipt itself never authorizes completion.
    for(const [n,owner]of [[1,'a'.repeat(64)],[2,'b'.repeat(64)]]){
      parent.run(h(n),h(n+10),'synthetic-source',owner,'synthetic-restore/'+n,h(n+20),h(99));
      receipt.run(h(n),h(n+20),'synthetic-restore/'+n);
    }
    const selected=db.prepare('SELECT * FROM analytics_canonical_cache_prepared_receipts ORDER BY work_key').all();
    assert.equal(selected.length,2);
    assert.throws(()=>receipt.run(h(9),h(29),'synthetic-orphan'),/FOREIGN KEY/u);
    const backup=join(root,'derived-snapshot.sqlite');db.prepare('VACUUM main INTO ?').run(backup);
    restored=new DatabaseSync(backup);restored.exec('PRAGMA foreign_keys=ON');
    assert.deepEqual(restored.prepare('SELECT * FROM analytics_canonical_cache_prepared_receipts ORDER BY work_key').all(),selected);
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_list(analytics_canonical_cache_prepared_receipts)').all()
      .map(({table,from,to,on_delete})=>({table,from,to,on_delete})),[
        {table:'analytics_partition_work',from:'work_key',to:'work_key',on_delete:'CASCADE'}]);
    restored.prepare(`UPDATE analytics_partition_work SET state='complete',revision=revision+1,
      claim_token=NULL,claim_expires_ms=0,updated_ms=2 WHERE work_key=?`).run(h(1));
    restored.prepare("DELETE FROM analytics_partition_work WHERE work_key=? AND state='complete'").run(h(1));
    assert.deepEqual(restored.prepare('SELECT work_key FROM analytics_canonical_cache_prepared_receipts').all()
      .map(row=>row.work_key),[h(2)]);
    restored.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
      .run('synthetic-source','b'.repeat(64));
    assert.equal(restored.prepare('SELECT count(*) n FROM analytics_canonical_cache_prepared_receipts').get().n,0);
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);
    // The frozen source copy was never modified by derived snapshot cleanup.
    assert.deepEqual(db.prepare('SELECT * FROM analytics_canonical_cache_prepared_receipts ORDER BY work_key').all(),selected);
    assert.equal(db.prepare("SELECT count(*) n FROM analytics_owner_state WHERE state='active'").get().n,2);
  }finally{restored?.close();adapter.close();}
});

for(const lost of ['before','after'])test(`lost ${lost}-commit reply requires exact read-only reconciliation before continuation`,async()=>{
  let injected=false,calls=0;
  const {plan,adapter}=await runtime({fault:async(stage,name)=>{
    if(stage==='before')calls++;
    if(!injected&&name===MAINTAINED_FORWARD_STEPS[5].name&&stage===lost){injected=true;throw Error('synthetic response loss');}
  }});
  const root=await directory(),op=join(root,'migrate');
  try{
    await assert.rejects(run(plan,adapter,op),/synthetic response loss/u);
    assert.equal((await readOperation(op)).state.status,'uncertain');
    const count=calls;
    const result=await run(plan,adapter,op,{resume:true,reconcileOnly:true});
    assert.equal(result.status,`reconciled-${lost==='after'?'applied':'not-applied'}`);assert.equal(calls,count);
    await assert.rejects(run(plan,adapter,op,{resume:true,approvedReconciliationSha256:'0'.repeat(64)}),{code:'MAINTAINED_FORWARD_LOCAL_RECONCILIATION_NOT_APPROVED'});
    if(lost==='before')await assert.rejects(run(plan,adapter,op,{resume:true,approvedReconciliationSha256:result.reconciliationSha256}),{code:'MAINTAINED_FORWARD_LOCAL_RETRY_NOT_APPROVED'});
    await run(plan,adapter,op,{resume:true,approvedReconciliationSha256:result.reconciliationSha256,retryNotApplied:lost==='before'});
    assert.equal(calls,lost==='after'?18:19);
    assert.deepEqual(await adapter.inspect('primary'),plan.frontiers[18].primary);
    assert.deepEqual(await adapter.inspect('analytics'),plan.frontiers[18].analytics);
  }finally{adapter.close();}
});

test('a response loss followed by other-database drift is ambiguous and cannot be replayed',async()=>{
  let writes=0;
  const {plan,adapter}=await runtime({fault:async stage=>{if(stage==='before'){writes++;throw Error('synthetic interrupted intent');}}});
  const root=await directory(),op=join(root,'migrate');
  try{
    await assert.rejects(run(plan,adapter,op),/synthetic interrupted intent/u);
    adapter.databases.analytics.exec('CREATE TABLE synthetic_unreviewed_schema(id INTEGER)');
    const result=await run(plan,adapter,op,{resume:true,reconcileOnly:true});assert.equal(result.status,'reconciled-ambiguous');
    await assert.rejects(run(plan,adapter,op,{resume:true,approvedReconciliationSha256:result.reconciliationSha256,retryNotApplied:true}),{code:'MAINTAINED_FORWARD_LOCAL_RECONCILIATION_NOT_APPROVED'});
    assert.equal(writes,1);
  }finally{adapter.close();}
});

test('partial ledger, enabled controls, incompatible code and premature activation refuse before mutation',async()=>{
  const {plan,adapter}=await runtime();const root=await directory();let calls=0;
  adapter.migrateAtomic=async()=>{calls++;};adapter.setControls=async()=>{calls++;};
  try{
    await assert.rejects(run(plan,adapter,join(root,'premature'),{phase:'activate'}),{code:'MAINTAINED_FORWARD_LOCAL_FRONTIER_OR_CONTROLS_DRIFT'});
    const workers=await adapter.workers();workers.analytics.flags.STORAGE_ANALYTICS_CANONICAL_PIPELINE='enabled';adapter.setWorkerEvidence(workers);
    await assert.rejects(run(plan,adapter,join(root,'enabled')),{code:'MAINTAINED_FORWARD_LOCAL_CONTROLS_NOT_DISABLED'});
    workers.analytics.flags.STORAGE_ANALYTICS_CANONICAL_PIPELINE='disabled';workers.public.codeSha256='0'.repeat(64);adapter.setWorkerEvidence(workers);
    await assert.rejects(run(plan,adapter,join(root,'code')),{code:'MAINTAINED_FORWARD_LOCAL_CODE_OR_CONTROLS_DRIFT'});
    workers.public.codeSha256=plan.codePins.public;adapter.setWorkerEvidence(workers);
    adapter.databases.primary.exec("UPDATE d1_storage_migrations SET sha256='0000000000000000000000000000000000000000000000000000000000000000' WHERE rowid=1");
    await assert.rejects(run(plan,adapter,join(root,'ledger')),{code:'MAINTAINED_FORWARD_LOCAL_FRONTIER_OR_CONTROLS_DRIFT'});
    assert.equal(calls,0);
  }finally{adapter.close();}
});

test('activation lost reply reconciles exact controls and fallback stops consumers before producer',async()=>{
  let lose=false;
  const {plan,adapter}=await runtime({fault:async(stage,name)=>{if(lose&&stage==='after'&&name==='cache:enabled'){lose=false;throw Error('lost controls reply');}}});
  const root=await directory();
  try{
    await run(plan,adapter,join(root,'migrate'));lose=true;
    const op=join(root,'activate');await assert.rejects(run(plan,adapter,op,{phase:'activate'}),/lost controls reply/u);
    const result=await run(plan,adapter,op,{phase:'activate',resume:true,reconcileOnly:true});assert.equal(result.status,'reconciled-applied');
    await run(plan,adapter,op,{phase:'activate',resume:true,approvedReconciliationSha256:result.reconciliationSha256});
    await run(plan,adapter,join(root,'fallback'),{phase:'fallback'});
  }finally{adapter.close();}
});

test('new SQL, changed pinned bytes, unsafe paths and hosted CLI flags are refused',async()=>{
  for(const args of [[],['execute'],['rehearse','--remote'],['inspect','--account-id','synthetic']])
    assert.throws(()=>parseMaintainedForwardLocalArguments(args),{code:'MAINTAINED_FORWARD_LOCAL_ARGUMENTS'});
  assert.deepEqual(parseMaintainedForwardLocalArguments(['inspect']),{mode:'inspect'});
  const worker=await copiedWorker();
  const local=await prepareMaintainedAnalyticsForwardLocal({workerDirectory:worker,codePins,localTargets,createdAt});
  const path=join(worker,'analytics-migrations','0047_analytics_cleanup_cadence.sql');
  const bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from('\n-- synthetic byte drift\n')]));
  await assert.rejects(runMaintainedAnalyticsForwardLocal({plan:local,workerDirectory:worker}),{code:'MAINTAINED_FORWARD_LOCAL_PLAN_OR_INPUT_CHANGED'});
  await writeFile(path,bytes);
  await writeFile(join(worker,'analytics-migrations','0049_synthetic_unreviewed.sql'),'CREATE TABLE synthetic_unreviewed(id INTEGER);\n');
  await assert.rejects(prepareMaintainedAnalyticsForwardLocal({workerDirectory:worker,codePins,localTargets,createdAt}),{code:'MAINTAINED_FORWARD_LOCAL_SUFFIX_NOT_CLOSED'});
  await rm(join(worker,'analytics-migrations','0049_synthetic_unreviewed.sql'));
  await rm(path);await symlink(join(workerDirectory,'analytics-migrations','0047_analytics_cleanup_cadence.sql'),path);
  await assert.rejects(prepareMaintainedAnalyticsForwardLocal({workerDirectory:worker,codePins,localTargets,createdAt}),{code:'MAINTAINED_FORWARD_LOCAL_SQL_FILE_UNSAFE'});
});

test('unapproved writes and another operation binding cannot use a private journal',async()=>{
  const {plan,adapter}=await runtime();const root=await directory(),op=join(root,'migrate');
  try{
    await assert.rejects(run(plan,adapter,op,{approvedPlanSha256:'0'.repeat(64)}),{code:'MAINTAINED_FORWARD_LOCAL_NOT_APPROVED'});
    await run(plan,adapter,op);
    await assert.rejects(run(plan,adapter,op,{resume:true,phase:'activate'}),{code:'RELEASE_OPERATION_INPUT_MISMATCH'});
    await assert.rejects(run(plan,adapter,op),{code:'RELEASE_OPERATION_EXISTS_USE_RESUME'});
    const link=join(root,'linked');await symlink(op,link);
    await assert.rejects(run(plan,adapter,link,{resume:true}),{code:'RELEASE_OPERATION_DIRECTORY_UNSAFE'});
  }finally{adapter.close();}
});
