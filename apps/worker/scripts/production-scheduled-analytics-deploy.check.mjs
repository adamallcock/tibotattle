import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { identityDigest, readOperation, openOperation } from '../../../scripts/lib/release-operation.mjs';
import { DIRECT_OCCURRENCE_FORWARD_SCHEMA, DIRECT_OCCURRENCE_FORWARD_PREVIOUS, loadExistingRoleForwardSteps, verifyExistingRoleForwardReceipt } from './existing-role-forward-migration.mjs';
import { createScheduledAnalyticsProvider, runScheduledAnalyticsRollout, scheduledSettingsStableDigest } from './production-scheduled-analytics-deploy.mjs';

const source='a'.repeat(40),previous='b'.repeat(40),account='c'.repeat(32),database='11111111-1111-4111-8111-111111111111';
const refreshPrevious='3216e2258830841c37f17c1a0b7d8703e0a72293';
const primaryDatabase='22222222-2222-4222-8222-222222222222';
const roles=['analytics','publication','cache'];
const files={analytics:'storage-analytics-worker.js',publication:'storage-publication-worker.js',cache:'cache-retention-day-worker.js'};
const flags={analytics:['STORAGE_ANALYTICS_SHARED_FEATURES','STORAGE_ANALYTICS_MODEL_BLOCKS'],publication:['STORAGE_ANALYTICS_SHARED_FEATURES','STORAGE_ANALYTICS_MODEL_BLOCKS'],cache:['CACHE_RETENTION_SHARED_FEATURES']};
const hash=x=>createHash('sha256').update(x).digest('hex');
const write=async(path,bytes)=>writeFile(path,bytes,{mode:0o600});
async function fixture(t,{refresh=false,indexRefresh=false}={}){
  refresh=refresh||indexRefresh;
  const priorSource=indexRefresh?DIRECT_OCCURRENCE_FORWARD_PREVIOUS:refreshPrevious;
  const root=await realpath(await mkdtemp(join(tmpdir(),'scheduled-analytics-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const pkg=join(root,'package'),operation=join(root,'operation');await mkdir(pkg,{mode:0o700});await mkdir(join(pkg,'artifacts'),{mode:0o700});
  const snapshots={},versions=new Map(),tags=new Map(),events=[],entries=[],rolePlans=[];
  for(const [index,role] of roles.entries()){
    await mkdir(join(pkg,'artifacts',role),{mode:0o700});
    const bundle=Buffer.from(`synthetic-${role}`),bundleSha256=hash(bundle),bundlePath=join(pkg,'artifacts',role,files[role]);await write(bundlePath,bundle);
    const vars={DEPLOYMENT_SOURCE_COMMIT:source,KEEP:'same',
      ...Object.fromEntries(flags[role].map(k=>[k,refresh&&!(role==='publication'&&k==='STORAGE_ANALYTICS_MODEL_BLOCKS')?'enabled':'disabled'])),
      ...(refresh&&role==='cache'?{CACHE_RETENTION_BUILD:'enabled'}:{})};
    const runtime={compatibility_date:'2026-07-26',compatibility_flags:[],limits:{cpu_ms:300000}};
    const settings={logpush:false,observability:{enabled:true},tail_consumers:[],
      annotations:{'workers/message':`previous-${role}`,'workers/tag':`previous-${role}`,'workers/triggered_by':'synthetic'},bindings:[]};
    const config={name:role==='cache'?'tibotattle-cache-retention-synthetic':`tibotattle-${role}-synthetic`,main:bundlePath,no_bundle:true,keep_vars:true,workers_dev:false,
      vars,d1_databases:[{binding:'STORAGE_ANALYTICS_DB',database_id:database},
        ...(refresh?[{binding:'STORAGE_INGESTION_DB',database_id:primaryDatabase}]:[])],triggers:{crons:['* * * * *']},
      compatibility_date:runtime.compatibility_date,compatibility_flags:runtime.compatibility_flags,limits:runtime.limits,
      logpush:settings.logpush,observability:settings.observability,tail_consumers:settings.tail_consumers};
    const configPath=join(pkg,'artifacts',`${role}-retained-upload.json`),configBytes=JSON.stringify(config)+'\n';await write(configPath,configBytes);
    entries.push({path:`artifacts/${role}/${files[role]}`,sha256:bundleSha256},{path:`artifacts/${role}-retained-upload.json`,sha256:hash(configBytes)});
    const bindings=[{type:'d1',name:'STORAGE_ANALYTICS_DB',id:database},
      ...(refresh?[{type:'d1',name:'STORAGE_INGESTION_DB',id:primaryDatabase}]:[]),{type:'secret_text',name:'API_KEY'},
      {type:'plain_text',name:'DEPLOYMENT_SOURCE_COMMIT',text:refresh?priorSource:previous},
      {type:'plain_text',name:'KEEP',text:'same'},
      ...flags[role].map(name=>({type:'plain_text',name,text:refresh&&!(role==='publication'&&name==='STORAGE_ANALYTICS_MODEL_BLOCKS')?'enabled':'disabled'})),
      ...(refresh&&role==='cache'?[{type:'plain_text',name:'CACHE_RETENTION_BUILD',text:'enabled'}]:[])];
    const activeVersionId=`0000000${index+2}-1111-4111-8111-111111111111`;
    const ingress={subdomainEnabled:false,previewsEnabled:false,routes:0,domains:0};
    settings.bindings=structuredClone(bindings);
    snapshots[role]={activeVersionId,sourceCommit:refresh?priorSource:previous,bindings,runtime,settings,ingress,
      settingsSha256:identityDigest(settings),settingsStableSha256:scheduledSettingsStableDigest(settings),schedules:['* * * * *']};
    versions.set(activeVersionId,{id:activeVersionId,tag:settings.annotations['workers/tag'],
      message:settings.annotations['workers/message'],bindings:structuredClone(bindings),runtime});
    rolePlans.push({role,name:config.name,bundleSha256,configPath,configSha256:hash(configBytes),d1Bindings:[{binding:'STORAGE_ANALYTICS_DB',databaseId:database},
      ...(refresh?[{binding:'STORAGE_INGESTION_DB',databaseId:primaryDatabase}]:[])],
      predecessor:{versionId:activeVersionId,sourceCommit:refresh?priorSource:previous,bindingsSha256:identityDigest(bindings),settingsSha256:identityDigest(settings),settingsStableSha256:scheduledSettingsStableDigest(settings),runtimeSha256:identityDigest(runtime),ingressSha256:identityDigest(ingress),schedules:['* * * * *'],
        secretNames:['secret_text:API_KEY'],otherBindingsSha256:identityDigest([]),provenanceOperation:null}});
  }
  const migrations=Array.from({length:28},(_,i)=>({name:`${String(i+1).padStart(4,'0')}_old.sql`,sha256:hash(String(i))}));
  migrations.push(...['0030_analytics_model_blocks.sql','0031_analytics_model_block_clipped_ranges.sql','0032_analytics_shared_features.sql'].map(name=>({name,sha256:hash(name)})));
  if(refresh){const steps=await loadExistingRoleForwardSteps({workerDirectory:join(dirname(fileURLToPath(import.meta.url)),'..')});
    migrations.push({name:steps[1].name,sha256:steps[1].sha256});}
  const qualificationDirectory=join(pkg,'migrations','worker','analytics-migrations');await mkdir(qualificationDirectory,{recursive:true,mode:0o700});
  const qualification={status:'qualified',role:'analytics',sourceCommit:source,
    migrations:migrations.map((m,i)=>({...m,afterSchemaSha256:i===migrations.length-1?hash('schema'):hash(`step-${i}`)}))};
  const qualificationBytes=JSON.stringify(qualification)+'\n';await write(join(qualificationDirectory,'qualification.json'),qualificationBytes);
  entries.push({path:'migrations/worker/analytics-migrations/qualification.json',sha256:hash(qualificationBytes)});
  const manifestBytes=JSON.stringify({sourceCommit:source,status:'local-qualified',remoteWrites:false,files:entries})+'\n';await write(join(pkg,'manifest.json'),manifestBytes);
  const plan={schema:'scheduled-analytics-rollout-v1',createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),
    stage:indexRefresh?'index-refresh':refresh?'refresh-enabled':'deploy-disabled',candidateSourceCommit:source,previousSourceCommit:refresh?priorSource:previous,accountId:account,wranglerSha256:hash('wrangler'),
    packageManifestSha256:hash(manifestBytes),database:{id:database,schemaSha256:hash('schema'),migrations},disabledOperation:null,roles:rolePlans};
  let held=null;
  const lock={createOwner:()=> 'f'.repeat(40),isAncestor:()=>true,acquire(owner){assert.equal(held,null);held=owner;events.push('lock');},
    assertOwned(owner){assert.equal(held,owner);},release(owner){assert.equal(held,owner);held=null;events.push('release');},status:()=>held};
  let uploadFails=false,uploadSerial=0;
  let sourceDatabaseState=null;
  const refreshSettings=role=>{const snapshot=snapshots[role];snapshot.settingsSha256=identityDigest(snapshot.settings);
    snapshot.settingsStableSha256=scheduledSettingsStableDigest(snapshot.settings);};
  const provider={
    async snapshot(item){return structuredClone(snapshots[item.role]);},
    async versionInventory(){return true;},
    async databaseState(item){return structuredClone(refresh&&item.id===primaryDatabase
      ?sourceDatabaseState:{schemaSha256:plan.database.schemaSha256,migrations});},
    async upload(item,tag){events.push(`upload:${item.role}`);
      const id=`${(0x10000000+(++uploadSerial)).toString(16)}-1111-4111-8111-111111111111`;
      const config=JSON.parse(await readFile(item.configPath,'utf8'));
      const bindings=[{type:'d1',name:'STORAGE_ANALYTICS_DB',id:database},
        ...(refresh?[{type:'d1',name:'STORAGE_INGESTION_DB',id:primaryDatabase}]:[]),{type:'secret_text',name:'API_KEY'},
        ...Object.entries(config.vars).map(([name,text])=>({type:'plain_text',name,text}))];
      const version={id,tag,message:tag,bindings,runtime:snapshots[item.role].runtime};versions.set(id,version);tags.set(tag,id);
      const settings=snapshots[item.role].settings;
      settings.annotations['workers/message']=tag;settings.annotations['workers/tag']=tag;
      settings.bindings=structuredClone(bindings);refreshSettings(item.role);
      if(uploadFails)throw Error('lost response');},
    async findTagged(item,tag){const id=tags.get(tag);return id?structuredClone(versions.get(id)):null;},
    async version(item,id){return structuredClone(versions.get(id));},
    async deploy(item,id){events.push(`deploy:${item.role}`);const version=versions.get(id);snapshots[item.role]={...snapshots[item.role],activeVersionId:id,sourceCommit:source,bindings:version.bindings};},
  };
  if(refresh){
    const currentSteps=await loadExistingRoleForwardSteps({workerDirectory:join(dirname(fileURLToPath(import.meta.url)),'..')});
    const steps=indexRefresh?[...(await loadExistingRoleForwardSteps({workerDirectory:join(dirname(fileURLToPath(import.meta.url)),'..'),schema:DIRECT_OCCURRENCE_FORWARD_SCHEMA})),currentSteps[1]]:currentSteps;
    for(const role of rolePlans){
      const directory=join(root,`predecessor-${role.role}`);
      const prior=await openOperation({directory,kind:'production',binding:{role:role.role}});
      await prior.save({status:'completed',stage:{analytics:'model-batches',publication:'shared-publication',cache:'shared-cache'}[role.role],
        candidateSourceCommit:priorSource,...(indexRefresh?{dispatchTracking:'scheduled-refresh-dispatch-v1',index:3}:{}),deployed:{[role.role]:{versionId:role.predecessor.versionId,
          bundleSha256:hash(`previous-${role.role}`)}}});prior.close();
      role.predecessor.provenanceOperation=directory;
    }
    const primaryLedger=[{name:'0004_prior.sql',sha256:hash('primary-prior')}];
    const targets=[{role:'primary',binding:'USAGE_MONITOR_DB',databaseId:primaryDatabase,
      name:'synthetic-primary',beforeBytes:100,
      migrationName:steps[0].name,migrationSha256:steps[0].sha256,
      beforeSchemaSha256:hash('primary-before'),afterSchemaSha256:hash('primary-after'),
      beforeLedger:primaryLedger,controlInvariantSha256:hash('primary-controls')},
    {role:'analytics',binding:'ANALYTICS_DB',databaseId:database,
      name:'synthetic-analytics',beforeBytes:100,
      migrationName:steps[1].name,migrationSha256:steps[1].sha256,
      beforeSchemaSha256:hash('analytics-before'),afterSchemaSha256:plan.database.schemaSha256,
      beforeLedger:migrations.slice(0,-1),controlInvariantSha256:hash('analytics-controls')}];
    if(indexRefresh)targets.splice(1,1);
    const createdAt=new Date(Date.now()-2000).toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
    const backupValue={schema:'typed-forward-backup-receipt-v2',provider:'cloudflare-d1-time-travel',
      capturedAt:createdAt,expiresAt,
      targetsSha256:identityDigest(targets.map(target=>({role:target.role,databaseId:target.databaseId}))),
      targetBookmarks:targets.map(target=>({role:target.role,databaseId:target.databaseId,bookmark:'synthetic'}))};
    const migration={schema:indexRefresh?DIRECT_OCCURRENCE_FORWARD_SCHEMA:'existing-role-forward-plan-v1',operationId:randomUUID(),environment:'production',
      accountId:account,sourceCommit:source,
      previousPublicSourceCommit:indexRefresh?priorSource:'c7dcdc6f4f9df0b9d006b69ac287f0a253cf2b6d',
      previousScheduledSourceCommit:priorSource,createdAt,expiresAt,
      sourceNamespace:'synthetic',wranglerSha256:hash('wrangler'),
      workerPins:[{workerName:'tibotattle-public-synthetic',versionId:'00000001-1111-4111-8111-111111111111',
        sourceCommit:indexRefresh?priorSource:'c7dcdc6f4f9df0b9d006b69ac287f0a253cf2b6d',fingerprint:hash('public'),
        bindings:{primary:primaryDatabase,analytics:database}},
      ...rolePlans.map(role=>({workerName:role.name,versionId:role.predecessor.versionId,
        sourceCommit:priorSource,fingerprint:hash(role.role),
        bindings:{primary:primaryDatabase,analytics:database}}))],
      expectedInputSha256:hash('inputs'),controlsSha256:hash('controls'),
      projectedPreflightSha256:hash('preflight'),
      backup:{...backupValue,receiptSha256:identityDigest(backupValue)},targets};
    const directory=join(root,'forward-migration');
    const operationRecord=await openOperation({directory,kind:'production',binding:migration});
    await operationRecord.save({status:'complete',owner:'f'.repeat(40),nextRole:targets.length,lastFailure:null});
    operationRecord.close();
    const migrationBytes=JSON.stringify(migration)+'\n';await write(join(directory,'plan.json'),migrationBytes);
    const receiptValue={schema:'existing-role-forward-receipt-v1',status:'complete',planSha256:identityDigest(migration),
      sourceCommit:source,workerPinsSha256:identityDigest(migration.workerPins),
      backupReceiptSha256:migration.backup.receiptSha256,
      projectedPreflightSha256:migration.projectedPreflightSha256,
      targets:targets.map(target=>({role:target.role,binding:target.binding,databaseId:target.databaseId,
        migrationName:target.migrationName,migrationSha256:target.migrationSha256,
        beforeSchemaSha256:target.beforeSchemaSha256,afterSchemaSha256:target.afterSchemaSha256,
        beforeLedgerSha256:identityDigest(target.beforeLedger),
        afterLedgerSha256:identityDigest([...target.beforeLedger,
          {name:target.migrationName,sha256:target.migrationSha256}]),
        controlInvariantSha256:target.controlInvariantSha256})),completedAt:new Date().toISOString()};
    const receiptBytes=JSON.stringify({...receiptValue,receiptSha256:identityDigest(receiptValue)})+'\n';
    await write(join(directory,'receipt.json'),receiptBytes);
    verifyExistingRoleForwardReceipt({plan:migration,receipt:JSON.parse(receiptBytes),
      operation:await readOperation(directory)});
    plan.forwardMigration={operationDirectory:directory,planSha256:hash(migrationBytes),receiptSha256:hash(receiptBytes)};
    sourceDatabaseState={schemaSha256:targets[0].afterSchemaSha256,
      migrations:[...primaryLedger,{name:steps[0].name,sha256:steps[0].sha256}]};
  }
  const input={plan,packageRoot:pkg,operationDirectory:operation,repositoryRoot:root,approvedPlanSha256:identityDigest(plan),provider,lockFactory:()=>lock};
  return {root,pkg,operation,plan,input,provider,events,snapshots,lock,refreshSettings,
    sourceDatabaseState,setUploadFails:x=>{uploadFails=x;}};
}

test('plan-only validates hashes without provider calls or lock',async t=>{
  const f=await fixture(t);const result=await runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg});
  assert.equal(result.status,'planned');assert.deepEqual(f.events,[]);
});

test('disabled deployment journals each upload/deploy and releases exact owner',async t=>{
  const f=await fixture(t);const result=await runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(result.status,'completed');assert.deepEqual(f.events,['lock','upload:analytics','deploy:analytics','upload:publication','deploy:publication','upload:cache','deploy:cache','release']);
  const journal=await readOperation(f.operation);assert.equal(journal.state.status,'completed');assert.equal(journal.state.deployed.analytics.bundleSha256,f.plan.roles[0].bundleSha256);
  assert.equal(JSON.stringify(journal).includes('API_KEY'),false);
});

test('enabled successor refresh keeps all controls active across three version deployments',async t=>{
  const f=await fixture(t,{refresh:true});
  assert.equal((await runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg})).status,'planned');
  const result=await runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(result.status,'completed');
  assert.deepEqual(f.events,['lock','upload:analytics','deploy:analytics','upload:publication',
    'deploy:publication','upload:cache','deploy:cache','release']);
  for(const role of roles){
    assert.equal(f.snapshots[role].sourceCommit,source);
    const vars=Object.fromEntries(f.snapshots[role].bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text]));
    assert.equal(vars.DEPLOYMENT_SOURCE_COMMIT,source);
    assert.equal(vars[role==='cache'?'CACHE_RETENTION_SHARED_FEATURES':'STORAGE_ANALYTICS_SHARED_FEATURES'],'enabled');
    if(role==='analytics')assert.equal(vars.STORAGE_ANALYTICS_MODEL_BLOCKS,'enabled');
    if(role==='publication')assert.equal(vars.STORAGE_ANALYTICS_MODEL_BLOCKS,'disabled');
    if(role==='cache')assert.equal(vars.CACHE_RETENTION_BUILD,'enabled');
  }
  assert.equal((await readOperation(f.operation)).state.status,'completed');
});

test('enabled successor refresh refuses migration proof or source schema drift before upload',async t=>{
  await t.test('receipt bytes changed',async sub=>{
    const f=await fixture(sub,{refresh:true});
    await write(join(f.plan.forwardMigration.operationDirectory,'receipt.json'),'{}\n');
    await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
      confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_MIGRATION_PROOF_INVALID'});
    assert.deepEqual(f.events,[]);
  });
  await t.test('source migration ledger drift',async sub=>{
    const f=await fixture(sub,{refresh:true}),databaseState=f.provider.databaseState;
    f.provider.databaseState=async item=>item.id===primaryDatabase
      ?{...await databaseState(item),migrations:[]} :databaseState(item);
    await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
      confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_SOURCE_SCHEMA_OR_LEDGER_CHANGED'});
    assert.deepEqual(f.events,[]);
  });
});

test('enabled refresh rechecks migration proof before the next role upload',async t=>{
  const f=await fixture(t,{refresh:true}),deploy=f.provider.deploy;
  f.provider.deploy=async(item,id)=>{
    await deploy(item,id);
    if(item.role==='analytics')await write(join(f.plan.forwardMigration.operationDirectory,'receipt.json'),'{}\n');
  };
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
  {code:'SCHEDULED_ANALYTICS_MIGRATION_PROOF_INVALID'});
  assert.deepEqual(f.events,['lock','upload:analytics','deploy:analytics']);
  const journal=await readOperation(f.operation);
  assert.equal(journal.state.status,'running');assert.equal(journal.state.index,1);
  assert.equal(f.lock.status(),journal.state.owner);
});

test('enabled refresh rejects disabled controls and a 31-migration target at plan time',async t=>{
  await t.test('control config',async sub=>{
    const f=await fixture(sub,{refresh:true}),cache=f.plan.roles[2];
    const config=JSON.parse(await readFile(cache.configPath,'utf8'));
    config.vars.CACHE_RETENTION_SHARED_FEATURES='disabled';
    cache.configPath=join(f.root,'cache-disabled.json');
    const bytes=JSON.stringify(config)+'\n';await write(cache.configPath,bytes);cache.configSha256=hash(bytes);
    await assert.rejects(runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg}),
      {code:'SCHEDULED_ANALYTICS_CONTROL_STAGE_INVALID'});
    assert.deepEqual(f.events,[]);
  });
  await t.test('missing cursor migration',async sub=>{
    const f=await fixture(sub,{refresh:true});f.plan.database.migrations.pop();
    await assert.rejects(runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg}),
      {code:'SCHEDULED_ANALYTICS_DATABASE_PIN_INVALID'});
    assert.deepEqual(f.events,[]);
  });
});

test('enabled successor refresh refuses control, provenance and ancestry drift before upload',async t=>{
  await t.test('cache build disabled',async sub=>{
    const f=await fixture(sub,{refresh:true});
    f.snapshots.cache.bindings.find(x=>x.name==='CACHE_RETENTION_BUILD').text='disabled';
    f.snapshots.cache.settings.bindings=f.snapshots.cache.bindings;f.refreshSettings('cache');
    await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
      confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_PREDECESSOR_CHANGED'});
    assert.deepEqual(f.events,[]);
  });
  await t.test('prior role operation missing',async sub=>{
    const f=await fixture(sub,{refresh:true});
    f.plan.roles[1].predecessor.provenanceOperation=join(f.root,'missing-prior');
    f.input.approvedPlanSha256=identityDigest(f.plan);
    await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
      confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_PREDECESSOR_PROOF_MISSING'});
    assert.deepEqual(f.events,[]);
  });
  await t.test('source ancestry missing',async sub=>{
    const f=await fixture(sub,{refresh:true});f.lock.isAncestor=()=>false;
    await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
      confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_SOURCE_ANCESTRY_INVALID'});
    assert.deepEqual(f.events,[]);
  });
});

test('unapproved execution and changed package refuse before lock',async t=>{
  const f=await fixture(t);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'wrong'}),{code:'SCHEDULED_ANALYTICS_EXECUTION_NOT_APPROVED'});
  await write(join(f.pkg,'artifacts','analytics',files.analytics),'changed');
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_BUNDLE_CHANGED'});
  assert.deepEqual(f.events,[]);
});

test('upload response loss leaves lock held and never retries blindly',async t=>{
  const f=await fixture(t);f.setUploadFails(true);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),/lost response/);
  assert.deepEqual(f.events,['lock','upload:analytics']);
  assert.equal((await readOperation(f.operation)).state.status,'upload_intent');
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,resume:true,executorStopped:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_RECONCILIATION_REQUIRED'});
  const reconciled=await runScheduledAnalyticsRollout({...f.input,reconcile:true,resume:true,executorStopped:true,confirmation:'RECONCILE_SCHEDULED_ANALYTICS'});
  assert.equal(reconciled.status,'reconciled');assert.equal((await readOperation(f.operation)).state.status,'uploaded');
  assert.deepEqual(f.events,['lock','upload:analytics']);
});

test('journaled upload resumes its exact version without a second upload',async t=>{
  const f=await fixture(t),readVersion=f.provider.version;let interrupted=false;
  f.provider.version=async(item,id)=>{
    if(!interrupted&&item.role==='analytics'&&id!==item.predecessor.versionId){
      interrupted=true;throw Error('stopped after journaled upload');
    }
    return readVersion(item,id);
  };
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),/stopped after journaled upload/);
  const journal=await readOperation(f.operation);
  assert.equal(journal.state.status,'uploaded');assert.equal(journal.state.index,0);
  assert.deepEqual(journal.state.deployed,{});
  assert.deepEqual(f.events,['lock','upload:analytics']);
  f.provider.version=readVersion;
  const resumed=await runScheduledAnalyticsRollout({...f.input,execute:true,resume:true,executorStopped:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(resumed.status,'completed');
  assert.equal(f.events.filter(event=>event==='upload:analytics').length,1);
  assert.deepEqual(f.events.slice(-1),['release']);
});

test('raw predecessor settings still refuse an annotation change before the first upload',async t=>{
  const f=await fixture(t);
  f.snapshots.analytics.settings.annotations['workers/tag']='unrelated';f.refreshSettings('analytics');
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_PREDECESSOR_CHANGED'});
  assert.deepEqual(f.events,[]);
});

test('journaled upload refuses unrelated metadata, tag, bindings, and active version before deploy',async t=>{
  const cases=[
    ['unrelated annotation',snapshot=>{snapshot.settings.annotations['workers/triggered_by']='other';}],
    ['foreign upload tag',snapshot=>{snapshot.settings.annotations['workers/tag']='foreign';}],
    ['different settings bindings',snapshot=>{snapshot.settings.bindings.find(b=>b.name==='KEEP').text='other';}],
    ['different active version',snapshot=>{snapshot.activeVersionId='99999999-1111-4111-8111-111111111111';}],
  ];
  for(const [label,mutate] of cases){
    await t.test(label,async sub=>{
      const f=await fixture(sub),upload=f.provider.upload;
      f.provider.upload=async(item,tag)=>{await upload(item,tag);mutate(f.snapshots[item.role]);f.refreshSettings(item.role);};
      await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
        confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_PREDECESSOR_CHANGED'});
      const journal=await readOperation(f.operation);
      assert.equal(journal.state.status,'uploaded');assert.equal(journal.state.index,0);
      assert.deepEqual(f.events,['lock','upload:analytics']);
    });
  }
});

test('journaled upload refuses a changed uploaded version before deploy',async t=>{
  const f=await fixture(t),readVersion=f.provider.version;
  f.provider.version=async(item,id)=>{
    const version=await readVersion(item,id);
    if(id!==item.predecessor.versionId)version.tag='foreign';
    return version;
  };
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_VERSION_INVALID'});
  const journal=await readOperation(f.operation);
  assert.equal(journal.state.status,'uploaded');assert.equal(journal.state.index,0);
  assert.deepEqual(f.events,['lock','upload:analytics']);
});

test('post-deploy settings metadata drift withholds completion and leaves deploy intent for reconcile',async t=>{
  const f=await fixture(t),deploy=f.provider.deploy;
  f.provider.deploy=async(item,id)=>{
    await deploy(item,id);
    f.snapshots[item.role].settings.annotations['workers/triggered_by']='other';f.refreshSettings(item.role);
  };
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_PREDECESSOR_CHANGED'});
  const journal=await readOperation(f.operation);
  assert.equal(journal.state.status,'deploy_intent');assert.equal(journal.state.index,0);
  assert.deepEqual(f.events,['lock','upload:analytics','deploy:analytics']);
});

test('deploy-intent reconcile refuses a different same-tag version than the journaled deploy target',async t=>{
  const f=await fixture(t),deploy=f.provider.deploy;
  f.provider.deploy=async(item,id)=>{await deploy(item,id);throw Error('lost deploy response');};
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),/lost deploy response/);
  const before=await readOperation(f.operation);
  assert.equal(before.state.status,'deploy_intent');assert.equal(before.state.index,0);
  const forgedId='99999999-1111-4111-8111-111111111111';
  const findTagged=f.provider.findTagged,snapshot=f.provider.snapshot;
  f.provider.findTagged=async(item,tag)=>({...await findTagged(item,tag),id:forgedId});
  f.provider.snapshot=async item=>({...await snapshot(item),activeVersionId:forgedId});
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,resume:true,reconcile:true,executorStopped:true,
    confirmation:'RECONCILE_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_REMOTE_OUTCOME_UNCERTAIN'});
  const after=await readOperation(f.operation);
  assert.equal(after.state.status,'deploy_intent');assert.equal(after.state.versionId,before.state.versionId);
  assert.deepEqual(after.state.deployed,{});
  assert.deepEqual(f.events,['lock','upload:analytics','deploy:analytics']);
});

test('publication activation requires completed erasure-aware deployment and changes one role',async t=>{
  const f=await fixture(t);
  await runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  const plan=structuredClone(f.plan);plan.stage='shared-publication';plan.disabledOperation=f.operation;
  const operation=join(f.root,'publication-operation');
  for(const role of plan.roles){
    const live=f.snapshots[role.role],p=role.predecessor;
    p.versionId=live.activeVersionId;p.sourceCommit=live.sourceCommit;p.bindingsSha256=identityDigest(live.bindings);
    p.settingsSha256=live.settingsSha256;p.settingsStableSha256=live.settingsStableSha256;p.provenanceOperation=f.operation;
  }
  const publication=plan.roles[1];
  const config=JSON.parse(await readFile(publication.configPath,'utf8'));
  config.vars.STORAGE_ANALYTICS_SHARED_FEATURES='enabled';
  publication.configPath=join(f.root,'publication-enabled.json');
  const bytes=JSON.stringify(config)+'\n';await write(publication.configPath,bytes);publication.configSha256=hash(bytes);
  const input={...f.input,plan,operationDirectory:operation,approvedPlanSha256:identityDigest(plan)};
  const result=await runScheduledAnalyticsRollout({...input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(result.status,'completed');assert.deepEqual(Object.keys(result.deployed),['publication']);
  assert.deepEqual(f.events.slice(-4),['lock','upload:publication','deploy:publication','release']);
  const disable=structuredClone(plan);disable.stage='disable-publication';
  for(const role of disable.roles){const live=f.snapshots[role.role];role.predecessor.versionId=live.activeVersionId;
    role.predecessor.sourceCommit=live.sourceCommit;role.predecessor.bindingsSha256=identityDigest(live.bindings);
    role.predecessor.settingsSha256=live.settingsSha256;role.predecessor.settingsStableSha256=live.settingsStableSha256;
    role.predecessor.provenanceOperation=role.role==='publication'?operation:f.operation;}
  disable.roles[1].configPath=join(f.pkg,'artifacts','publication-retained-upload.json');
  disable.roles[1].configSha256=hash(await readFile(disable.roles[1].configPath));
  const fallback=await runScheduledAnalyticsRollout({...f.input,plan:disable,operationDirectory:join(f.root,'disable-publication'),
    approvedPlanSha256:identityDigest(disable),execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(fallback.status,'completed');assert.deepEqual(Object.keys(fallback.deployed),['publication']);
  assert.equal(f.snapshots.publication.bindings.find(b=>b.name==='STORAGE_ANALYTICS_SHARED_FEATURES').text,'disabled');
});

test('activation refuses missing disabled-deployment proof before lock',async t=>{
  const f=await fixture(t);f.plan.stage='shared-publication';f.plan.disabledOperation=join(f.root,'missing');
  for(const role of f.plan.roles){
    const snapshot=f.snapshots[role.role];snapshot.sourceCommit=source;
    snapshot.bindings.find(b=>b.name==='DEPLOYMENT_SOURCE_COMMIT').text=source;
    role.predecessor.sourceCommit=source;role.predecessor.bindingsSha256=identityDigest(snapshot.bindings);role.predecessor.provenanceOperation=join(f.root,'missing');
  }
  const publication=f.plan.roles[1],config=JSON.parse(await readFile(publication.configPath,'utf8'));
  config.vars.STORAGE_ANALYTICS_SHARED_FEATURES='enabled';publication.configPath=join(f.root,'publication-enabled.json');
  const bytes=JSON.stringify(config)+'\n';await write(publication.configPath,bytes);publication.configSha256=hash(bytes);
  f.input.approvedPlanSha256=identityDigest(f.plan);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_ERASURE_PROOF_MISSING'});
  assert.deepEqual(f.events,[]);
});

test('final live drift blocks lock release after all three deployments',async t=>{
  const f=await fixture(t),deploy=f.provider.deploy;
  f.provider.deploy=async(item,id)=>{
    await deploy(item,id);
    if(item.role==='cache')f.snapshots.analytics.activeVersionId='99999999-1111-4111-8111-111111111111';
  };
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),
    {code:'SCHEDULED_ANALYTICS_DEPLOYMENT_DRIFT'});
  assert.equal(f.events.includes('release'),false);
  const journal=await readOperation(f.operation);assert.equal(journal.state.status,'running');assert.equal(journal.state.index,3);
});

test('ambiguous execute and reconcile flags refuse before reading the package',async t=>{
  const f=await fixture(t);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,reconcile:true,resume:true,executorStopped:true}),
    {code:'SCHEDULED_ANALYTICS_ARGUMENTS'});
  assert.deepEqual(f.events,[]);
});

test('graph stage releases after verifying its enabled after-state',async t=>{
  const f=await fixture(t);
  await runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  for(const role of ['publication','cache']){
    const flag=role==='publication'?'STORAGE_ANALYTICS_SHARED_FEATURES':'CACHE_RETENTION_SHARED_FEATURES';
    f.snapshots[role].bindings.find(b=>b.name===flag).text='enabled';
  }
  const plan=structuredClone(f.plan);plan.stage='shared-graph';plan.disabledOperation=f.operation;
  for(const role of plan.roles){const live=f.snapshots[role.role];role.predecessor.versionId=live.activeVersionId;
    role.predecessor.sourceCommit=live.sourceCommit;role.predecessor.bindingsSha256=identityDigest(live.bindings);
    role.predecessor.settingsSha256=live.settingsSha256;role.predecessor.settingsStableSha256=live.settingsStableSha256;
    role.predecessor.provenanceOperation=role.role==='analytics'?f.operation:join(f.root,`${role.role}-synthetic-proof`);
    if(role.role!=='analytics'){
      const proof=await openOperation({directory:role.predecessor.provenanceOperation,kind:'production',binding:{synthetic:role.role}});
      await proof.save({status:'completed',candidateSourceCommit:source,deployed:{[role.role]:{versionId:live.activeVersionId,bundleSha256:role.bundleSha256}}});proof.close();
    }
  }
  const analytics=plan.roles[0],config=JSON.parse(await readFile(analytics.configPath,'utf8'));
  config.vars.STORAGE_ANALYTICS_SHARED_FEATURES='enabled';analytics.configPath=join(f.root,'analytics-graph.json');
  const bytes=JSON.stringify(config)+'\n';await write(analytics.configPath,bytes);analytics.configSha256=hash(bytes);
  const result=await runScheduledAnalyticsRollout({...f.input,plan,operationDirectory:join(f.root,'graph-operation'),
    approvedPlanSha256:identityDigest(plan),execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(result.status,'completed');assert.equal(f.snapshots.analytics.bindings.find(b=>b.name==='STORAGE_ANALYTICS_SHARED_FEATURES').text,'enabled');
});

test('lost lock acquire response reconciles exact owner without repeating acquisition',async t=>{
  const f=await fixture(t),acquire=f.lock.acquire;
  f.lock.acquire=owner=>{acquire(owner);throw Error('lost lock response');};
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),/lost lock response/);
  assert.equal((await readOperation(f.operation)).state.status,'lock_intent');
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,resume:true,executorStopped:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_RECONCILIATION_REQUIRED'});
  const result=await runScheduledAnalyticsRollout({...f.input,reconcile:true,resume:true,executorStopped:true,
    confirmation:'RECONCILE_SCHEDULED_ANALYTICS'});
  assert.equal(result.status,'reconciled');assert.equal((await readOperation(f.operation)).state.status,'running');
  assert.deepEqual(f.events,['lock']);
});

test('absent lock after interrupted acquire aborts without a remote mutation',async t=>{
  const f=await fixture(t);f.lock.acquire=()=>{throw Error('no lock');};
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),/no lock/);
  const result=await runScheduledAnalyticsRollout({...f.input,reconcile:true,resume:true,executorStopped:true,
    confirmation:'RECONCILE_SCHEDULED_ANALYTICS'});
  assert.equal(result.status,'aborted');assert.equal((await readOperation(f.operation)).state.status,'aborted');assert.deepEqual(f.events,[]);
});

test('expired interrupted operation needs an exact reviewed extension before new writes',async t=>{
  const f=await fixture(t);f.setUploadFails(true);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),/lost response/);
  const later=Date.parse(f.plan.expiresAt)+1000,clock=()=>later;
  await runScheduledAnalyticsRollout({...f.input,reconcile:true,resume:true,executorStopped:true,clock,
    confirmation:'RECONCILE_SCHEDULED_ANALYTICS'});
  const writes=[...f.events];f.setUploadFails(false);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,resume:true,executorStopped:true,clock,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_APPROVAL_EXPIRED'});
  assert.deepEqual(f.events,writes);assert.equal((await readOperation(f.operation)).state.status,'uploaded');
  const extension={schema:'scheduled-analytics-approval-extension-v1',planSha256:identityDigest(f.plan),
    approvedAt:new Date(later-1).toISOString(),expiresAt:new Date(later+3600000).toISOString()};
  const resumed=await runScheduledAnalyticsRollout({...f.input,execute:true,resume:true,executorStopped:true,clock,extension,
    approvedExtensionSha256:identityDigest(extension),confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'});
  assert.equal(resumed.status,'completed');assert.equal(f.events.at(-1),'release');
});

test('role names cannot cross roles or alias a Worker target',async t=>{
  const f=await fixture(t);f.plan.roles[1].name=f.plan.roles[0].name;
  await assert.rejects(runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg}),{code:'SCHEDULED_ANALYTICS_ROLES_INVALID'});
  f.plan.roles[1].name='tibotattle-cache-retention-other';
  await assert.rejects(runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg}),{code:'SCHEDULED_ANALYTICS_ROLE_INVALID'});
  assert.deepEqual(f.events,[]);
});

test('publication fallback refuses while downstream graph consumer remains enabled',async t=>{
  const f=await fixture(t);f.plan.stage='disable-publication';f.plan.disabledOperation=join(f.root,'disabled-proof');
  for(const role of f.plan.roles){
    const snapshot=f.snapshots[role.role];snapshot.sourceCommit=source;
    snapshot.bindings.find(b=>b.name==='DEPLOYMENT_SOURCE_COMMIT').text=source;
    role.predecessor.sourceCommit=source;role.predecessor.bindingsSha256=identityDigest(snapshot.bindings);
    role.predecessor.provenanceOperation=join(f.root,'synthetic-proof');
  }
  f.snapshots.publication.bindings.find(b=>b.name==='STORAGE_ANALYTICS_SHARED_FEATURES').text='enabled';
  f.snapshots.analytics.bindings.find(b=>b.name==='STORAGE_ANALYTICS_SHARED_FEATURES').text='enabled';
  f.plan.roles[0].predecessor.bindingsSha256=identityDigest(f.snapshots.analytics.bindings);
  f.plan.roles[1].predecessor.bindingsSha256=identityDigest(f.snapshots.publication.bindings);
  await assert.rejects(runScheduledAnalyticsRollout({...f.input,approvedPlanSha256:identityDigest(f.plan),execute:true,
    confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}),{code:'SCHEDULED_ANALYTICS_STAGE_ORDER'});
  assert.deepEqual(f.events,[]);
});

test('provider reads actual array-shaped routes and domains responses',async t=>{
  const f=await fixture(t),role=f.plan.roles[0];
  await mkdir(f.operation,{mode:0o700});
  const cliPath=join(dirname(fileURLToPath(import.meta.url)),'../node_modules/wrangler/wrangler-dist/cli.js');
  const wranglerSha256=hash(await readFile(cliPath));
  const active=role.predecessor.versionId,bindings=f.snapshots.analytics.bindings,runtime=f.snapshots.analytics.runtime;
  let wrappedRoutes=false,versionCount=1;
  const fetcher=async url=>{
    const path=new URL(url).pathname,query=new URL(url).search;
    let result;
    if(path.endsWith('/deployments')&&query==='?per_page=100')result={deployments:[
      {versions:[{version_id:active,percentage:100}]},...Array.from({length:61},()=>({versions:[]}))]};
    else if(path.endsWith(`/versions/${active}`))result={id:active,resources:{bindings,script_runtime:runtime}};
    else if(path.endsWith('/versions')&&query==='?deployable=true')result={items:Array.from({length:versionCount},()=>({id:active}))};
    else if(path.endsWith('/settings'))result=f.snapshots.analytics.settings;
    else if(path.endsWith('/schedules'))result={schedules:[{cron:'* * * * *'}]};
    else if(path.endsWith('/subdomain'))result={enabled:false,previews_enabled:false};
    else if(path.endsWith('/routes')&&query==='?show_zonename=true')result=wrappedRoutes?{routes:[]}:[];
    else if(path.endsWith('/domains/records'))result=[];
    else throw Error('unexpected synthetic endpoint');
    return Response.json({success:true,result,...(path.endsWith('/deployments')
      ?{result_info:{page:1,per_page:100,count:62,total_count:62,total_pages:1}}:{})});
  };
  const provider=createScheduledAnalyticsProvider({plan:{accountId:account,wranglerSha256},operationDirectory:f.operation,
    cliPath,fetcher,environment:{CLOUDFLARE_API_TOKEN:'synthetic-token-12345'}});
  const snapshot=await provider.snapshot(role);
  assert.deepEqual(snapshot.ingress,{subdomainEnabled:false,previewsEnabled:false,routes:0,domains:0});
  assert.deepEqual(snapshot.schedules,['* * * * *']);
  versionCount=127;assert.equal(await provider.versionInventory(role),true);
  versionCount=128;await assert.rejects(provider.versionInventory(role),{code:'SCHEDULED_ANALYTICS_REMOTE_SHAPE_INVALID'});
  wrappedRoutes=true;
  await assert.rejects(provider.snapshot(role),{code:'SCHEDULED_ANALYTICS_REMOTE_SHAPE_INVALID'});
});


test('index-only refresh adopts a verified one-role migration and preserves schedules and enabled controls',async t=>{
  const f=await fixture(t,{indexRefresh:true});
  assert.equal((await runScheduledAnalyticsRollout({plan:f.plan,packageRoot:f.pkg})).status,'planned');
  assert.equal((await runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'})).status,'completed');
  assert.deepEqual(f.events,['lock','upload:analytics','deploy:analytics','upload:publication','deploy:publication','upload:cache','deploy:cache','release']);
  for(const role of roles){
    assert.deepEqual(f.snapshots[role].schedules,['* * * * *']);
    assert.equal(f.snapshots[role].sourceCommit,source);
    const vars=Object.fromEntries(f.snapshots[role].bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text]));
    assert.equal(vars[role==='cache'?'CACHE_RETENTION_SHARED_FEATURES':'STORAGE_ANALYTICS_SHARED_FEATURES'],'enabled');
  }
});
test('index refresh refuses changed migration proof, predecessor operation and primary schema before upload',async t=>{
  for(const drift of ['proof','predecessor','schema'])await t.test(drift,async sub=>{
    const f=await fixture(sub,{indexRefresh:true});
    if(drift==='proof')await write(join(f.plan.forwardMigration.operationDirectory,'receipt.json'),'{}\n');
    if(drift==='predecessor'){
      const prior=await openOperation({directory:f.plan.roles[0].predecessor.provenanceOperation,kind:'production',binding:{role:'analytics'},resume:true});
      await prior.save({...prior.record.state,dispatchTracking:'unreviewed'});prior.close();
    }
    if(drift==='schema')f.sourceDatabaseState.schemaSha256=hash('unreviewed');
    await assert.rejects(runScheduledAnalyticsRollout({...f.input,execute:true,confirmation:'DEPLOY_REVIEWED_SCHEDULED_ANALYTICS'}));
    assert.deepEqual(f.events,[]);
  });
});
