import {captureStorageCommunityAuthority} from '../src/storage-community-authority';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {advanceSharedAnalyticsFeatureDay} from '../src/storage-analytics-shared-features';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createModelBlockCheckpoint,modelBlockInputDays,MODEL_BLOCK_METHOD,type ModelBlockIdentity} from '../src/analytics-model-block-contract';
import {claimModelBlockJob,ensureModelBlockJob,saveModelBlockJob} from '../src/storage-analytics-model-block';
import {saveStorageHistoryCheckpoint} from '../src/storage-history-checkpoint';
import {reduceGraphDayProjection,writeGraphDayProjection} from '../src/graph-day-projection';
import {createV1QuotaAcquisitionCheckpoint} from '../src/quota-analysis-v1-reader';
import {MODEL_HISTORY_METHOD_VERSION} from '../src/quota-analysis-v1';
import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,it,expect} from 'vitest';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {initializeStorageSource,readIngestionChanges} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission,persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {sha256Hex} from '../src/crypto';
import {canonicalJson} from '../src/canonical-json';
import {modelHistoryWindow} from '../src/model-history-window';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {eraseParticipantAsOwner} from '../src/participant-erasure';
import {advanceStorageErasureJobs,prepareStorageParticipantErasure,requireStorageParticipantErasureComplete} from '../src/storage-erasure';
import {recordDeletionTombstone,purgeExpiredDeletionTombstones,hasDeletionTombstone,participantDeletionDigest,replayDeletionTombstones} from '../src/retention';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,sourceId='synthetic-erasure',sourceNamespace='synthetic-erasure-original';
const bindings=()=>({source:source(),target:target(),ledger:b.DELETION_LEDGER,sourceId,sourceNamespace});
const runtime=(t=target())=>{const configured={...b,ENVIRONMENT:'synthetic-development'} as Env;
 Reflect.set(configured,'TELEMETRY_STORAGE_MODE','typed');Reflect.set(configured,'TELEMETRY_STORAGE_NAMESPACE',sourceNamespace);Reflect.set(configured,'ANALYTICS_DB',t);return configured;};
const today=()=>new Date().toISOString().slice(0,10);
async function initialize(analyticsMigrations: D1Migration[] = b.TEST_ANALYTICS_MIGRATIONS){
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await applyD1Migrations(target(),analyticsMigrations);await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);await initializeTypedV11Admission(source(),sourceNamespace);await initializeTypedV1Admission(source(),sourceNamespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);await initializeStorageAnalyticsRuntime(bindings());
}
beforeEach(async()=>{await reset();await initialize();});
async function fixture(days=1){
 const device=await createV11DeviceFixture(source(),{grant:true});const entries:TelemetryV11DomainManifest['days']=[];
 for(let n=days-1;n>=0;n--){
  const day=new Date(Date.parse(today())-n*86400000).toISOString().slice(0,10),prepared=await makeV11Day(day,{usage:[v11UsageRecord(day,'a',{eventId:`event:v2:${n.toString(16).padStart(64,'0')}`})]});
  const staged=await registerTelemetryV11DayManifest(source(),device,prepared.manifest);
  for(const chunk of prepared.chunks){const envelopeDigest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
   const upload=await createDeviceUploadAuthorization(source(),await authenticateDevice(source(),device.authorization),envelopeDigest,200);
   const claim=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
   await persistTypedV11StagedChunk(source(),device,chunk,{sourceNamespace,chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/${crypto.randomUUID()}`,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  entries.push({day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest});
 }
 const prior=await createTelemetryV11DomainPredecessor(source(),device);
 const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:entries[0]!.day,throughDay:today(),
 predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},days:entries,manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));await activateTelemetryV11Domain(source(),device,manifest);
 return {...device,event:(await readIngestionChanges(source(),sourceId,0)).at(-1)!};
}
async function deliver(){for(let i=0;i<30;i++)if((await advanceStorageAnalytics(bindings())).state==='idle')return;throw new Error('synthetic delivery bound');}
const count=(table:string)=>target().prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>('n');
async function drain(){for(let n=0;n<20;n++)if(!(await advanceStorageErasureJobs(bindings())).pending)return;throw new Error('synthetic erasure bound');}
async function completedModelBlock(ownerDigest:string){
 const owner=await target().prepare('SELECT revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
  .bind(sourceId,ownerDigest).first<{revision:number;authority_epoch:number}>();
 if(!owner)throw new Error('synthetic missing model block owner');
 const identity:ModelBlockIdentity={version:1,method:MODEL_BLOCK_METHOD,sourceId,sourceNamespace,ownerDigest,
  ownerRevision:owner.revision,authorityEpoch:owner.authority_epoch,inputRevision:1,authorityDigest:'b'.repeat(64),
  outputFromDay:today(),outputThroughDay:today()};
 const initial=createModelBlockCheckpoint(identity,modelBlockInputDays(identity).map(day=>({day,digest:'c'.repeat(64),hasQuota:false,hasUsage:false})));
 expect(await ensureModelBlockJob({target:target(),identity,initial,now:Date.now()})).toBe(true);
 const claim=await claimModelBlockJob({target:target(),identity,now:Date.now()});if(!claim)throw new Error('synthetic missing model claim');
 expect(await saveModelBlockJob({target:target(),identity,claim,now:Date.now(),checkpoint:{...initial,phase:'complete',
  inputIndex:initial.dependencies.length,outputs:[{day:today(),fingerprint:'d'.repeat(64),
   value:{status:'not_testable',reason:'supported_quota_track_unavailable'}}]}})).toBe(true);
}
async function completedSharedFeature(ownerDigest:string){
 const owner=(await readStorageCommunityOwnerPage(source())).find(value=>value.ownerDigest===ownerDigest);
 if(!owner)throw new Error('synthetic missing shared feature owner');
 for(let attempt=0;attempt<12;attempt++){
  const meter=createD1InvocationBudget(950);
  const result=await advanceSharedAnalyticsFeatureDay({source:meter.wrap(source()),target:meter.wrap(target()),
   sourceId,sourceNamespace,owner:{...owner,ownerDigest},day:today(),
   budget:{remainingQueries:()=>meter.remainingQueries,deadlineMs:Date.now()+55_000,now:Date.now}});
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  if(result.state==='complete')return;
  expect(result.state).toBe('deferred');
 }
 throw new Error('synthetic shared feature bound');
}
async function seedNewAnalyticsFamilies(ownerDigest:string){
 const owner=await target().prepare('SELECT revision,authority_epoch FROM analytics_owner_state WHERE source_id=? AND owner_digest=?')
  .bind(sourceId,ownerDigest).first<{revision:number;authority_epoch:number}>();
 if(!owner)throw new Error('synthetic missing analytics owner');
 await target().prepare(`INSERT INTO analytics_model_block_policy
  (source_id,owner_digest,policy_revision,source_namespace,owner_revision,authority_epoch,
   input_revision,method,authority_digest,today_day,updated_ms) VALUES(?,?,1,?,?,?,?,?,?,?,?)`)
  .bind(sourceId,ownerDigest,sourceNamespace,owner.revision,owner.authority_epoch,1,
   'synthetic-erasure','b'.repeat(64),today(),Date.now()).run();
 await target().prepare(`INSERT INTO analytics_shared_feature_days
  (job_key,source_id,source_namespace,owner_digest,day,method_digest,dependency_digest,
   owner_revision,authority_epoch,input_revision,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
  .bind('a'.repeat(64),sourceId,sourceNamespace,ownerDigest,today(),'b'.repeat(64),'c'.repeat(64),
   owner.revision,owner.authority_epoch,1,Date.now()).run();
}
describe('cross-store physical erasure completion',()=>{
 it('uses the old public owner route with new model and shared-feature fence triggers',async()=>{
  const f=await fixture();await deliver();await seedNewAnalyticsFamilies(f.event.ownerDigest);
  expect(await count('analytics_model_block_policy')).toBe(1);
  expect(await count('analytics_shared_feature_days')).toBe(1);
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true});
  expect(await count('analytics_model_block_policy')).toBe(0);
  expect(await count('analytics_shared_feature_days')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('withholds the old public receipt when new-family cleanup triggers are absent',async()=>{
  const f=await fixture();await deliver();await seedNewAnalyticsFamilies(f.event.ownerDigest);
  for(const trigger of [
   'analytics_model_block_policy_terminal_insert','analytics_model_block_policy_terminal_update',
   'analytics_model_block_policy_owner_update','analytics_model_block_policy_owner_delete',
   'analytics_shared_feature_terminal_insert','analytics_shared_feature_terminal_update',
   'analytics_shared_feature_owner_update','analytics_shared_feature_owner_delete',
  ])await target().prepare(`DROP TRIGGER ${trigger}`).run();
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await count('analytics_model_block_policy')).toBe(1);
  expect(await count('analytics_shared_feature_days')).toBe(1);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
  await target().prepare('DELETE FROM analytics_model_block_policy').run();
  await target().prepare('DELETE FROM analytics_shared_feature_days').run();
  await drain();
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('keeps erasure completion compatible with analytics schemas before model blocks',async()=>{
  await reset();await initialize(b.TEST_ANALYTICS_MIGRATIONS.filter(migration=>migration.name<'0030_'));
  const f=await fixture();await deliver();
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true});
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('fails closed when a model block schema is only partly installed',async()=>{
  const f=await fixture();await deliver();
  await target().prepare('DROP TABLE analytics_model_block_policy').run();
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
 });
 it('withholds an erasure receipt while an owner model policy survives damaged cleanup',async()=>{
  const f=await fixture();await deliver();
  const owner=await target().prepare(`SELECT revision,authority_epoch FROM analytics_owner_state
   WHERE source_id=? AND owner_digest=?`).bind(sourceId,f.event.ownerDigest)
   .first<{revision:number;authority_epoch:number}>();
  expect(owner).toBeTruthy();
  await target().prepare(`INSERT INTO analytics_model_block_policy
   (source_id,owner_digest,policy_revision,source_namespace,owner_revision,authority_epoch,
    input_revision,method,authority_digest,today_day,updated_ms)
   VALUES(?,?,1,?,?,?,?,?,?,?,?)`)
   .bind(sourceId,f.event.ownerDigest,sourceNamespace,owner!.revision,owner!.authority_epoch,
    f.event.revision,MODEL_BLOCK_METHOD,'b'.repeat(64),today(),Date.now()).run();
  expect(await count('analytics_model_block_policy')).toBe(1);
  for(const trigger of ['analytics_model_block_policy_terminal_insert','analytics_model_block_policy_terminal_update',
   'analytics_model_block_policy_owner_update','analytics_model_block_policy_owner_delete'])
   await target().prepare(`DROP TRIGGER ${trigger}`).run();
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await count('analytics_model_block_policy')).toBe(1);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
  await target().prepare('DELETE FROM analytics_model_block_policy').run();await drain();
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('physically erases shared feature heads and parts before recording completion',async()=>{
  const f=await fixture();await deliver();await completedSharedFeature(f.event.ownerDigest);
  expect(await count('analytics_shared_feature_days')).toBe(1);
  expect(await count('analytics_shared_feature_parts')).toBeGreaterThan(0);
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true});
  expect(await count('analytics_shared_feature_days')).toBe(0);
  expect(await count('analytics_shared_feature_parts')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('withholds completion while interrupted shared feature retirement leaves a private payload',async()=>{
  const f=await fixture();await deliver();await completedSharedFeature(f.event.ownerDigest);
  for(const trigger of ['analytics_shared_feature_terminal_insert','analytics_shared_feature_terminal_update',
   'analytics_shared_feature_owner_update'])await target().prepare(`DROP TRIGGER ${trigger}`).run();
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId))
   .rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await count('analytics_shared_feature_days')).toBe(1);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  await target().prepare('DELETE FROM analytics_shared_feature_days').run();await drain();
  expect(await count('analytics_shared_feature_parts')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('erases completed experimental model heads and all private checkpoint parts before recording completion',async()=>{
  const f=await fixture();await deliver();await completedModelBlock(f.event.ownerDigest);
  expect(await count('analytics_model_blocks')).toBe(1);expect(await count('analytics_model_block_parts')).toBe(1);
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true});
  expect(await count('analytics_model_blocks')).toBe(0);expect(await count('analytics_model_block_parts')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('withholds an erasure receipt while any experimental model payload survives interrupted cleanup',async()=>{
  const f=await fixture();await deliver();await completedModelBlock(f.event.ownerDigest);
  // Simulate damaged/interrupted retirement, independently of the writer's
  // capability refusal. Receipt validation must still prove physical absence.
  for(const trigger of ['analytics_model_blocks_terminal_insert','analytics_model_blocks_terminal_update','analytics_model_blocks_owner_update'])
   await target().prepare(`DROP TRIGGER ${trigger}`).run();
  await expect(eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await count('analytics_model_blocks')).toBe(1);expect(await count('analytics_model_block_parts')).toBe(1);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
  await target().prepare('DELETE FROM analytics_model_blocks').run();await drain();
  expect(await count('analytics_model_block_parts')).toBe(0);expect(await count('analytics_storage_erasure_receipts')).toBe(1);
 });
 it('accepts only a structurally successful empty ledger result',async()=>{
  const malformed=new Proxy(b.DELETION_LEDGER,{get(db,key){if(key==='prepare')return(sql:string)=>{
   const statement=db.prepare(sql);if(!sql.includes("FROM storage_erasure_jobs WHERE source_id=? AND state='pending'"))return statement;
   return new Proxy(statement,{get(value,member){if(member==='bind')return(...args:unknown[])=>new Proxy(value.bind(...args),{
    get(bound,boundMember){if(boundMember==='all')return async()=>({success:false,results:[]});
     const candidate=Reflect.get(bound,boundMember);return typeof candidate==='function'?candidate.bind(bound):candidate;}});
    const candidate=Reflect.get(value,member);return typeof candidate==='function'?candidate.bind(value):candidate;}});};
   const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  await expect(advanceStorageErasureJobs({...bindings(),ledger:malformed})).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await advanceStorageErasureJobs(bindings())).toEqual({completed:0,pending:false});
 });
 it('fails closed when analytics is offline, then resumes from independent mapping after source deletion',async()=>{
  const f=await fixture(5);await deliver();expect(await count('analytics_v11_value_pages')).toBe(5);
  const offline=new Proxy(target(),{get(db,key){if(key==='prepare')return()=>{throw new Error('synthetic analytics offline');};const v=Reflect.get(db,key);return typeof v==='function'?v.bind(db):v;}});
  await expect(eraseParticipantAsOwner(runtime(offline),'synthetic-admin',f.participantId)).rejects.toThrow();
  expect(await source().prepare('SELECT 1 FROM participants WHERE id=?').bind(f.participantId).first()).toBeNull();
  expect(await source().prepare('SELECT 1 FROM storage_v11_owner_links WHERE participant_id=?').bind(f.participantId).first()).toBeNull();
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
  expect(await count('analytics_v11_value_pages')).toBe(5);
  const first=await advanceStorageErasureJobs(bindings());expect(first.pending).toBe(true);
  expect(await count('analytics_storage_erasure_fences')).toBe(1);
  expect(await target().prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId).first('sequence')).toBe(1);
  expect(await count('analytics_v11_value_pages')).toBe(1);
  await drain();expect(await count('analytics_v11_value_pages')).toBe(0);expect(await count('analytics_v11_reusable_values')).toBe(0);
  expect(await count('analytics_v11_projection_work')).toBe(0);expect(await count('analytics_storage_erasure_receipts')).toBe(1);
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true,alreadyDeleted:true,contributionsDeleted:null});
 });
 it('prioritizes erasure before any ordered delivery and does not invent a cursor acknowledgement',async()=>{
  const f=await fixture();
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true});
  expect(await count('analytics_source_cursors')).toBe(0);expect(await count('analytics_storage_erasure_receipts')).toBe(1);
  // Delayed legitimate source callbacks acknowledge only their exact ordered
  // source-proven discards and cannot recreate a removed payload.
  await deliver();expect(await count('analytics_v11_value_pages')).toBe(0);
  expect(await target().prepare('SELECT state FROM analytics_owner_state WHERE source_id=? AND owner_digest=?').bind(sourceId,f.event.ownerDigest).first('state')).toBe('erased');
  await expect(target().prepare(`INSERT INTO analytics_v11_projection_work
   (source_id,event_digest,owner_digest,generation_id,manifest_digest,from_day,through_day,next_day,values_json)
   VALUES(?,?,?,?,?,?,?,?,?)`).bind(sourceId,'f'.repeat(64),f.event.ownerDigest,'synthetic','a'.repeat(64),today(),today(),today(),'{}').run()).rejects.toThrow('storage_owner_erased');
 });
 it('reconciles a lost committed fence response without duplicate effects or cross-namespace admission',async()=>{
  const f=await fixture();await deliver();let lost=false;
  const flaky=new Proxy(target(),{get(db,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const result=await db.batch(statements);if(!lost){lost=true;throw new Error('synthetic lost committed fence');}return result;};
   const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  await expect(eraseParticipantAsOwner(runtime(flaky),'synthetic-admin',f.participantId)).rejects.toThrow();
  expect(await count('analytics_storage_erasure_fences')).toBe(1);expect(await count('analytics_v11_value_pages')).toBe(1);
  await expect(advanceStorageErasureJobs({...bindings(),sourceNamespace:'synthetic-wrong'})).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  await drain();expect(await count('analytics_storage_erasure_fences')).toBe(1);expect(await count('analytics_storage_erasure_receipts')).toBe(1);
  expect(await count('analytics_v11_value_pages')).toBe(0);
  expect(await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId)).toMatchObject({deleted:true,alreadyDeleted:true});
 });
 it('retains pending independent recipes past expiry and releases only completed tombstones',async()=>{
  const f=await fixture();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  await prepareStorageParticipantErasure(bindings(),f.participantId);
  const future=Date.now()+401*86400000;
  expect((await purgeExpiredDeletionTombstones(b.DELETION_LEDGER,future)).purged).toBe(0);
  expect(await hasDeletionTombstone(b.DELETION_LEDGER,f.participantId,future)).toBe(true);
  await expect(b.DELETION_LEDGER.prepare('DELETE FROM deletion_tombstones').run()).rejects.toThrow('storage_erasure_pending');
  await expect(requireStorageParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,null)).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId);
  expect((await purgeExpiredDeletionTombstones(b.DELETION_LEDGER,future)).purged).toBe(1);
  expect(await b.DELETION_LEDGER.prepare('SELECT COUNT(*) n FROM storage_erasure_jobs').first('n')).toBe(0);
 });
 it('does not let an interrupted source deletion starve another erased owner',async()=>{
  const a=await fixture(),z=await fixture();await recordDeletionTombstone(b.DELETION_LEDGER,a.participantId);
  await prepareStorageParticipantErasure(bindings(),a.participantId);
  const offline=new Proxy(target(),{get(db,key){if(key==='prepare')return()=>{throw new Error('synthetic offline');};const v=Reflect.get(db,key);return typeof v==='function'?v.bind(db):v;}});
  await expect(eraseParticipantAsOwner(runtime(offline),'synthetic-admin',z.participantId)).rejects.toThrow();
  // Pin the interrupted owner first regardless of random participant IDs.
  await b.DELETION_LEDGER.prepare('UPDATE storage_erasure_jobs SET attempted_ms=CASE owner_digest WHEN ? THEN 0 ELSE 1 END').bind(a.event.ownerDigest).run();
  expect((await advanceStorageErasureJobs(bindings())).completed).toBe(0);
  expect((await advanceStorageErasureJobs(bindings())).completed).toBe(1);
  expect(await source().prepare('SELECT state FROM participants WHERE id=?').bind(a.participantId).first('state')).toBe('active');
 });
 it('removes every payload family while keeping digest-only fences and rejects a late writer',async()=>{
  const f=await fixture();await deliver();const d='d'.repeat(64),o=f.event.ownerDigest;
  const authority=JSON.stringify(await captureStorageCommunityAuthority(source(),bindings()));
  await target().batch([
   target().prepare('INSERT INTO analytics_v1_chunk_values VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(sourceId,o,d,d,d,d,d,d,today(),1,1,'{}'),
   target().prepare('INSERT INTO analytics_community_graph_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(sourceId,o,'fits',today(),'synthetic',d,1,d,'{}',d,authority,Date.now(),'v1.1'),
   target().prepare('INSERT INTO analytics_community_graph_execution VALUES(?,?,?,?,?)').bind(sourceId,o,today(),d,'checkpoint'),
   target().prepare('INSERT INTO analytics_community_daily_owners VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(sourceId,today(),o,1,1,'v11','synthetic',1,0,null,1,'{}'),
   target().prepare('INSERT INTO analytics_community_daily_publications VALUES(?,?,?,?,?,?,?,?)').bind(sourceId,today(),1,d,authority,'{}',d,new Date().toISOString()),
   target().prepare('INSERT INTO analytics_community_model_publications VALUES(?,?,?,?,?,?,?,?,?)').bind(sourceId,today(),1,'synthetic',d,authority,'{}',d,Date.now()),
   target().prepare('INSERT INTO analytics_community_graph_previews VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(sourceId,1,'synthetic',d,authority,1,'{}',d,new Date().toISOString(),JSON.parse(authority).publicAuthorityEpoch,1,Date.now(),Date.now()),
   target().prepare(`INSERT INTO analytics_cache_retention_day_progress
    (progress_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,
     manifest_digest,day,method_version,carry_digest,progress_revision,state_json,state_digest)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
     'e'.repeat(64),sourceId,'effective',sourceNamespace,o,'effective-owner','effective-owner-day',
     d,today(),'cache-retention-v2',d,1,'{}',d),
  ]);
  const key={sourceId,ownerDigest:o,day:'2026-09-05',dependencyDigest:d,sourceNamespace,method:'synthetic-history'};
  const identity={participantId:'synthetic-history-participant',inputFingerprint:d,sourceMethodVersion:MODEL_HISTORY_METHOD_VERSION,
   observedAtCutoff:'2026-05-28T00:00:00.000Z',resetsAtCutoff:'2026-06-04T00:00:00.000Z',windowMinutes:10080,maxQuotaRows:60000};
  const checkpoint={version:1 as const,day:key.day,layout:`typed:${sourceNamespace}`,identity,phase:'acquisition' as const,acquisition:createV1QuotaAcquisitionCheckpoint(identity)};
  checkpoint.acquisition.plan.anchors=Array.from({length:1000},(_,i)=>({sourceContext:'["openai_codex","codex"]',contextKey:'openai_codex|codex',observedAtMs:Date.parse('2026-09-01T00:00:00Z')+i,planType:'pro',planVariant:'unknown',accountScopeId:null}));
  await saveStorageHistoryCheckpoint({target:target(),key,checkpoint,expectedHead:null});
  expect(await count('analytics_history_checkpoint_parts')).toBeGreaterThan(0);
  try{await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId);}catch{/* Finite cleanup may require another job step. */}
  await drain();await requireStorageParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,bindings());
  for(const table of ['analytics_v1_chunk_values','analytics_v11_projection_work','analytics_v11_value_pages','analytics_v11_reusable_values',
   'analytics_community_graph_results','analytics_community_graph_execution','analytics_history_checkpoint_stages','analytics_history_checkpoint_parts',
   'analytics_community_daily_owners','analytics_community_daily_publications','analytics_community_model_publications','analytics_community_graph_previews',
   'analytics_cache_retention_day_progress'])expect(await count(table),table).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);expect(await count('analytics_storage_erasure_fences')).toBe(1);
  await expect(saveStorageHistoryCheckpoint({target:target(),key,checkpoint,expectedHead:null})).rejects.toThrow();
  await expect(target().prepare('INSERT INTO analytics_community_graph_execution VALUES(?,?,?,?,?)').bind(sourceId,o,today(),d,'checkpoint').run()).rejects.toThrow('storage_owner_erased');
 });
 it.each(['typed-v11','effective','effective-usage'] as const)('refuses to complete while a %s prepared graph day survives, then removes it',async(sourceLayout)=>{
  const f=await fixture();await deliver();const o=f.event.ownerDigest;
  const day='2026-09-10',dayMs=Date.parse(`${day}T00:00:00.000Z`);
  const projectionKey={sourceId,sourceLayout,sourceNamespace,ownerDigest:o,
   deviceId:sourceLayout==='typed-v11'?'synthetic-device':'effective-owner',
   manifestId:sourceLayout==='effective-usage'?`effective-owner-usage-v1:${'e'.repeat(64)}`
    :sourceLayout==='effective'?'effective-owner-day':'synthetic-manifest',manifestDigest:'b'.repeat(64),day};
  const effectiveQuota=sourceLayout==='effective'?{quotaRowsRead:1,ownerRevision:f.event.revision}:undefined;
  const effectiveUsage=sourceLayout==='effective-usage'?{ownerRevision:f.event.revision}:undefined;
  const projection=reduceGraphDayProjection(day,sourceLayout==='effective-usage'?[]:[{sourceRowId:1,observedAtMs:dayMs+60000,
   anchor:{contextKey:'openai_codex|codex',observedAtMs:dayMs+60000,planType:'pro',planVariant:'unknown',
    continuityId:null,conflicted:false,accountScopeId:null,planBasis:'same_source_occurrence'},
   row:{occurrence_id:'occ-00000001',observed_at:new Date(dayMs+60000).toISOString(),provider:'openai_codex',
    account_scope_id:null,limit_id:'codex',plan_type:'pro',plan_variant:'unknown',continuity_id:null,
    plan_basis:'same_source_occurrence',slot:'primary',used_percent:12.5,window_duration_minutes:10080,
    resets_at:new Date(dayMs+7*86400000).toISOString()}}]);
  expect(await writeGraphDayProjection({target:target(),key:projectionKey,projection,effectiveQuota,effectiveUsage}))
   .toMatchObject({status:'stored'});
  expect(await count('analytics_graph_day_values')).toBe(1);
  // Hold the prepared day past one cleanup page. Erasure must not write a
  // completion receipt while any derived graph payload for this owner survives.
  let held=false;
  const stalled=new Proxy(target(),{get(db,key){if(key==='prepare')return(sql:string)=>{
   const statement=db.prepare(sql);
   if(held||!sql.includes('DELETE FROM analytics_graph_day_values'))return statement;
   return new Proxy(statement,{get(value,member){if(member==='bind')return(...args:unknown[])=>new Proxy(value.bind(...args),{
    get(bound,boundMember){if(boundMember==='all')return async()=>{held=true;return {success:true,results:[],meta:{}};};
     const candidate=Reflect.get(bound,boundMember);return typeof candidate==='function'?candidate.bind(bound):candidate;}});
    const candidate=Reflect.get(value,member);return typeof candidate==='function'?candidate.bind(value):candidate;}});};
   const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  await expect(eraseParticipantAsOwner(runtime(stalled),'synthetic-admin',f.participantId)).rejects.toThrow();
  expect(held).toBe(true);
  expect(await count('analytics_storage_erasure_fences')).toBe(1);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await count('analytics_graph_day_values')).toBe(1);
  expect(await count('analytics_graph_day_pages')).toBeGreaterThan(0);
  await drain();await requireStorageParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,bindings());
  expect(await count('analytics_graph_day_values')).toBe(0);expect(await count('analytics_graph_day_pages')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
  await expect(writeGraphDayProjection({target:target(),key:projectionKey,projection,effectiveQuota,effectiveUsage}))
   .rejects.toThrow();
 });
 it('refuses to complete while graph selection metadata survives, then drains it in bounded pages',async()=>{
  const f=await fixture();await deliver();const o=f.event.ownerDigest,nowMs=Date.now();
  let fenced=false,seeded=false,held=false;
  const stalled=new Proxy(target(),{get(db,key){
   if(key==='prepare')return(sql:string)=>{
    if(sql.includes('INSERT INTO analytics_storage_erasure_fences'))fenced=true;
    if(!held&&sql.includes('DELETE FROM analytics_community_graph_work_selection')){
     held=true;return db.prepare(sql.replace('WHERE (source_id','WHERE 0 AND (source_id'));
    }
    return db.prepare(sql);
   };
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    const result=await db.batch(statements);
    if(fenced&&!seeded){
     seeded=true;
     // Represent a delayed older writer after the one-time fence trigger.
     // Current admission refuses this owner; direct synthetic rows exercise
     // completion independently of that admission gate and exceed one page.
     for(let index=0;index<33;index++){
      const day=new Date(Date.parse(today())-index*86400000).toISOString().slice(0,10);
      const envelope=canonicalJson({version:2,source:'effective',sourceId,sourceNamespace,ownerDigest:o,
       day,metric:'model',fixedNow:modelHistoryWindow(day).fixedNow,dependencyDigest:'b'.repeat(64),
       checkpointDependencyDigest:'c'.repeat(64),targetAuthorityEpoch:f.event.authorityEpoch,
       participantId:f.participantId,ownerRevision:f.event.revision});
      await db.prepare(`INSERT INTO analytics_community_graph_work_selection
       (source_id,owner_digest,day,metric,authority_epoch,selection_revision,state,envelope_json,envelope_sha256,
        claim_token,claim_expires_ms,created_ms,updated_ms) VALUES(?,?,?,'model',?,1,'claimed',?,?,?,?,?,?)`)
       .bind(sourceId,o,day,f.event.authorityEpoch,envelope,await sha256Hex(envelope),
        'synthetic-delayed-erasure-claim',nowMs+60000,nowMs,nowMs).run();
     }
    }
    return result;
   };
   const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;
  }});
  await expect(eraseParticipantAsOwner(runtime(stalled),'synthetic-admin',f.participantId)).rejects.toThrow();
  expect(seeded).toBe(true);expect(held).toBe(true);
  expect(await count('analytics_storage_erasure_fences')).toBe(1);
  expect(await count('analytics_community_graph_work_selection')).toBe(33);
  expect(await count('analytics_graph_erasure_receipts')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
  expect(await advanceStorageErasureJobs(bindings())).toEqual({completed:0,pending:true});
  expect(await count('analytics_community_graph_work_selection')).toBe(1);
  expect(await count('analytics_graph_erasure_receipts')).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(0);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('pending');
  await drain();await requireStorageParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,bindings());
  expect(await count('analytics_community_graph_work_selection')).toBe(0);
  expect(await count('analytics_graph_erasure_receipts')).toBe(1);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_jobs').first('state')).toBe('complete');
 });
 it('uses the same durable mapping and completion gate during restore replay',async()=>{
  const f=await fixture(5);await deliver();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  await expect(replayDeletionTombstones(source(),b.DELETION_LEDGER,b.QUARANTINE,Date.now(),undefined,true,bindings())).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await b.DELETION_LEDGER.prepare('SELECT participant_digest FROM storage_erasure_jobs').first('participant_digest')).toBe(await participantDeletionDigest(f.participantId));
  await drain();await requireStorageParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,bindings());
  expect(await count('analytics_v11_value_pages')).toBe(0);
 });
});
