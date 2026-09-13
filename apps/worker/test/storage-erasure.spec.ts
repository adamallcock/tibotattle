import {captureStorageCommunityAuthority} from '../src/storage-community-authority';
import {saveStorageHistoryCheckpoint} from '../src/storage-history-checkpoint';
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
import {encodeBase64Url,sha256,sha256Hex} from '../src/crypto';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {eraseParticipantAsOwner} from '../src/participant-erasure';
import {advanceStorageErasureJobs,prepareStorageParticipantErasure,requireStorageParticipantErasureComplete} from '../src/storage-erasure';
import {advanceMultiSourceStorageErasureJobs,prepareMultiSourceParticipantErasure,
 requireMultiSourceParticipantErasureComplete} from '../src/storage-multi-source-erasure';
import {recordDeletionTombstone,purgeExpiredDeletionTombstones,hasDeletionTombstone,participantDeletionDigest,replayDeletionTombstones} from '../src/retention';
import {ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
 ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,enrollAccountlessDevice} from '../src/accountless-enrollment';
import {ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
 ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
 createAccountlessUploadOwner} from '../src/accountless-ownership';
import {createCatalogStorageRouter,createOwnerMoveCoordinator} from '../src/storage-routing';
import {configureStorageShardAllocation,recordStorageCapacityObservation} from '../src/storage-capacity';
import {registerParticipantOwnerRoute} from '../src/storage-routing-runtime';
import {publishMultiSourceCommunityDaily,readMultiSourcePublication} from '../src/storage-multi-source-publication';
import {createV11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {STORAGE_COMMUNITY_DAILY_METHOD} from '../src/storage-community-daily';
import {canonicalJson} from '../src/canonical-json';
const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;STORAGE_PUBLICATION_DB:D1Database;
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[];
 TEST_ROUTING_MIGRATIONS:D1Migration[];TEST_INGESTION_ROUTING_MIGRATIONS:D1Migration[];STORAGE_ROUTING_DB:D1Database;
 STORAGE_INGESTION_A:D1Database;STORAGE_INGESTION_B:D1Database;STORAGE_INGESTION_C:D1Database;
 STORAGE_ANALYTICS_A:D1Database;STORAGE_ANALYTICS_B:D1Database};
const source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB,sourceId='synthetic-erasure',sourceNamespace='synthetic-erasure-original';
const bindings=()=>({source:source(),target:target(),ledger:b.DELETION_LEDGER,sourceId,sourceNamespace});
const runtime=(t=target())=>{const configured={...b,ENVIRONMENT:'synthetic-development'} as Env;
 Reflect.set(configured,'TELEMETRY_STORAGE_MODE','typed');Reflect.set(configured,'TELEMETRY_STORAGE_NAMESPACE',sourceNamespace);Reflect.set(configured,'ANALYTICS_DB',t);return configured;};
const today=()=>new Date().toISOString().slice(0,10);
beforeEach(async()=>{
 await reset();for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await applyD1Migrations(b.STORAGE_PUBLICATION_DB,b.TEST_ANALYTICS_MIGRATIONS);
 await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
 await initializeStorageSource(source(),sourceId);await initializeTypedV11Admission(source(),sourceNamespace);await initializeTypedV1Admission(source(),sourceNamespace);
 await applyD1Migrations(source(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);await initializeStorageAnalyticsRuntime(bindings());
});
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

async function copyRows(table:string,from:D1Database,to:D1Database):Promise<void>{
 const columns=(await from.prepare(`PRAGMA table_info(${table})`).all<{name:string}>()).results.map(row=>row.name);
 const rows=(await from.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>()).results;
 for(const row of rows)await to.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`)
  .bind(...columns.map(column=>row[column])).run();
}

async function initializeCatalogErasureStore(source:D1Database,target:D1Database,sourceIdValue:string){
 for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
  b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(source,migrations);
 await initializeStorageSource(source,sourceIdValue);await initializeTypedV11Admission(source,sourceNamespace);
 await initializeTypedV1Admission(source,sourceNamespace);
 await applyD1Migrations(source,b.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await applyD1Migrations(source,b.TEST_INGESTION_ROUTING_MIGRATIONS);
 await applyD1Migrations(target,b.TEST_ANALYTICS_MIGRATIONS);
 await initializeStorageAnalyticsRuntime({source,target,sourceId:sourceIdValue,sourceNamespace});
}
describe('cross-store physical erasure completion',()=>{
 it('retains a durable per-target completion gate until the declared analytics target is clean',async()=>{
  const f=await fixture(5);await deliver();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  const targetBinding={...bindings(),targetId:'ANALYTICS_DB'};
  expect(await prepareMultiSourceParticipantErasure([targetBinding],f.participantId,
   {target:target(),routingGeneration:0,erasureGeneration:1})).toBe(1);
  expect(await target().prepare('SELECT erasure_generation FROM analytics_multi_source_control WHERE singleton=1')
   .first('erasure_generation')).toBe(1);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_targets').first('state')).toBe('pending');
  expect((await purgeExpiredDeletionTombstones(b.DELETION_LEDGER,Date.now()+401*86400000)).purged).toBe(0);
  try{await eraseParticipantAsOwner(runtime(),'synthetic-admin',f.participantId);}catch{/* Bounded cleanup resumes below. */}
  for(let n=0;n<20;n++){
   const result=await advanceMultiSourceStorageErasureJobs({targets:[targetBinding]});
   if(result.pendingTargets===0)break;
  }
  await requireMultiSourceParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,[targetBinding]);
  expect(await b.DELETION_LEDGER.prepare('SELECT state FROM storage_erasure_targets').first('state')).toBe('complete');
  expect(await count('analytics_v11_value_pages')).toBe(0);
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
   'analytics_community_daily_owners','analytics_community_daily_publications','analytics_community_model_publications','analytics_community_graph_previews'])expect(await count(table),table).toBe(0);
  expect(await count('analytics_storage_erasure_receipts')).toBe(1);expect(await count('analytics_storage_erasure_fences')).toBe(1);
  await expect(saveStorageHistoryCheckpoint({target:target(),key,checkpoint,expectedHead:null})).rejects.toThrow();
  await expect(target().prepare('INSERT INTO analytics_community_graph_execution VALUES(?,?,?,?,?)').bind(sourceId,o,today(),d,'checkpoint').run()).rejects.toThrow('storage_owner_erased');
 });
 it('uses the same durable mapping and completion gate during restore replay',async()=>{
  const f=await fixture(5);await deliver();await recordDeletionTombstone(b.DELETION_LEDGER,f.participantId);
  await expect(replayDeletionTombstones(source(),b.DELETION_LEDGER,b.QUARANTINE,Date.now(),undefined,true,bindings())).rejects.toMatchObject({code:'BACKEND_STORAGE_UNAVAILABLE'});
  expect(await b.DELETION_LEDGER.prepare('SELECT participant_digest FROM storage_erasure_jobs').first('participant_digest')).toBe(await participantDeletionDigest(f.participantId));
  await drain();await requireStorageParticipantErasureComplete(b.DELETION_LEDGER,f.participantId,bindings());
  expect(await count('analytics_v11_value_pages')).toBe(0);
 });
 it('removes a retained routed copy and resumes an unavailable derived target from durable receipts',async()=>{
  await applyD1Migrations(b.STORAGE_ROUTING_DB,b.TEST_ROUTING_MIGRATIONS);
  await initializeCatalogErasureStore(b.STORAGE_INGESTION_A,b.STORAGE_ANALYTICS_A,'routed-source-a');
  await initializeCatalogErasureStore(b.STORAGE_INGESTION_B,b.STORAGE_ANALYTICS_B,'routed-source-b');
  await applyD1Migrations(b.STORAGE_INGESTION_C,b.TEST_INGESTION_ROUTING_MIGRATIONS);
  await b.STORAGE_ROUTING_DB.batch(['a','b','c'].map(shard=>b.STORAGE_ROUTING_DB.prepare(
    'INSERT INTO storage_shards(shard_id,binding_name,state) VALUES(?,?,\'active\')')
    .bind(shard,`STORAGE_INGESTION_${shard.toUpperCase()}`)));
  for(const shardId of ['a','b','c']){
    await recordStorageCapacityObservation(b.STORAGE_ROUTING_DB,{shardId,observedBytes:0,observedAt:1000,
      validUntil:2000,pressureState:'normal'});
    await configureStorageShardAllocation(b.STORAGE_ROUTING_DB,{shardId,allocationTier:'active',
      allocationEnabled:true,updatedAt:1000});
  }
  const shardBindings={STORAGE_INGESTION_A:b.STORAGE_INGESTION_A,
    STORAGE_INGESTION_B:b.STORAGE_INGESTION_B,STORAGE_INGESTION_C:b.STORAGE_INGESTION_C};
  const router=createCatalogStorageRouter({catalog:b.STORAGE_ROUTING_DB,bindings:shardBindings,clock:()=>1500});
  const ownerId='accountless:retained-erasure-owner';
  const sourceRoute=await router.ensureOwner(ownerId,'a',1);
  const deviceId=crypto.randomUUID(),secret=crypto.getRandomValues(new Uint8Array(32));
  const prefix=new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const hashInput=new Uint8Array(prefix.length+secret.length);hashInput.set(prefix);hashInput.set(secret,prefix.length);
  const enrollment={schemaVersion:ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,deviceId,
    deviceSecretHash:await sha256(hashInput),policyVersion:ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
    authorizationBasis:ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS} as const;
  hashInput.fill(0);
  const authorization=`Device um_device_${deviceId}.${encodeBase64Url(secret)}`;secret.fill(0);
  const ownerNow=Date.now();
  await enrollAccountlessDevice(b.STORAGE_INGESTION_A,enrollment,ownerNow,sourceRoute);
  expect(await b.STORAGE_INGESTION_A.prepare('SELECT state FROM storage_owner_fences WHERE owner_id=?')
    .bind(ownerId).first('state')).toBe('active');
  expect(await b.STORAGE_INGESTION_A.prepare('SELECT installation_principal_id FROM accountless_enrollment_ledger WHERE device_id=?')
    .bind(deviceId).first('installation_principal_id')).toBe(ownerId);
  const owner=await createAccountlessUploadOwner(b.STORAGE_INGESTION_A,authorization,{
    schemaVersion:ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,policyVersion:ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis:ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion:ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION},ownerNow,sourceRoute);
  const participantId=owner.participantId,ownerDigest='7'.repeat(64),objectDigest='8'.repeat(64),contentDigest='9'.repeat(64);
  await b.STORAGE_INGESTION_A.batch([
    b.STORAGE_INGESTION_A.prepare(`INSERT INTO storage_v11_owner_links
      (participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,'active',?,?)`)
      .bind(participantId,ownerDigest,objectDigest,contentDigest),
    b.STORAGE_INGESTION_A.prepare(`INSERT INTO storage_ingestion_changes
      (event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms)
      VALUES(?,?,1,'owner-active',?,?,1,1,1500)`).bind(objectDigest,ownerDigest,objectDigest,contentDigest),
  ]);
  const mover=createOwnerMoveCoordinator({catalog:b.STORAGE_ROUTING_DB,bindings:shardBindings,clock:()=>1500,
    verifyDestinationCopy:async()=> 'a'.repeat(64)});
  await mover.begin('retained-erasure-move',sourceRoute,'b');await mover.fenceSource('retained-erasure-move');
  await mover.verifyCopied('retained-erasure-move');await mover.commit('retained-erasure-move');
  const currentRoute=await mover.activateDestination('retained-erasure-move');
  await enrollAccountlessDevice(b.STORAGE_INGESTION_B,enrollment,ownerNow,currentRoute);
  for(const table of ['participants','device_credentials','accountless_upload_owners','accountless_v11_device_authorizations']){
    await copyRows(table,b.STORAGE_INGESTION_A,b.STORAGE_INGESTION_B);
  }
  await b.STORAGE_INGESTION_B.batch([
    b.STORAGE_INGESTION_B.prepare(`INSERT INTO storage_v11_owner_links
      (participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,'active',?,?)`)
      .bind(participantId,ownerDigest,objectDigest,contentDigest),
    b.STORAGE_INGESTION_B.prepare(`INSERT INTO storage_ingestion_changes
      (event_digest,owner_digest,revision,kind,object_digest,content_digest,authority_epoch,public_authority_epoch,recorded_ms)
      VALUES(?,?,1,'owner-active',?,?,1,1,1500)`).bind(objectDigest,ownerDigest,objectDigest,contentDigest),
  ]);
  const publicationSources=[
    {source:b.STORAGE_INGESTION_A,target:b.STORAGE_ANALYTICS_A,sourceId:'routed-source-a',
      sourceNamespace,targetId:'analytics-a'},
    {source:b.STORAGE_INGESTION_B,target:b.STORAGE_ANALYTICS_B,sourceId:'routed-source-b',
      sourceNamespace,targetId:'analytics-b'},
  ];
  for(const binding of publicationSources){
    const authority=await captureStorageCommunityAuthority(binding.source,binding);
    await binding.target.prepare(`INSERT INTO analytics_source_cursors(source_id,sequence,authority_epoch)
      VALUES(?,?,?)`).bind(binding.sourceId,authority.sequence,authority.publicAuthorityEpoch).run();
  }
  await b.STORAGE_ANALYTICS_B.batch([
    b.STORAGE_ANALYTICS_B.prepare(`INSERT INTO analytics_owner_state
      (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,'active')`)
      .bind('routed-source-b',ownerDigest),
    b.STORAGE_ANALYTICS_B.prepare(`INSERT INTO analytics_community_daily_owners
      (source_id,day,owner_digest,input_revision,owner_revision,source_format,method,progress_revision,
       next_index,fingerprint,complete,values_json) VALUES(?,?,?,1,1,'v11',?,1,0,NULL,1,?)`)
      .bind('routed-source-b',today(),ownerDigest,STORAGE_COMMUNITY_DAILY_METHOD,
        canonicalJson(createV11DailyProjectionValues(today()))),
  ]);
  const publicationSet={sources:publicationSources,publicationTarget:b.STORAGE_PUBLICATION_DB,
    members:[{sourceId:'routed-source-b',ownerDigest,inputRevision:1,ownerRevision:1,
      routeGeneration:currentRoute.generation}],routingGeneration:currentRoute.generation,erasureGeneration:0};
  expect(await publishMultiSourceCommunityDaily(publicationSet,{day:today(),nowMs:ownerNow}))
    .toMatchObject({state:'published'});
  expect(await readMultiSourcePublication(b.STORAGE_PUBLICATION_DB,'daily',today())).not.toBeNull();
  const catalogRuntime={...b,ENVIRONMENT:'synthetic-development',STORAGE_ROUTING_MODE:'catalog',
    STORAGE_ROUTING_DB:b.STORAGE_ROUTING_DB,...shardBindings,STORAGE_ANALYTICS_A:b.STORAGE_ANALYTICS_A,
    STORAGE_ANALYTICS_B:b.STORAGE_ANALYTICS_B,STORAGE_PUBLICATION_DB:b.STORAGE_PUBLICATION_DB,
    STORAGE_ANALYTICS_DB:undefined} as unknown as Env;
  await registerParticipantOwnerRoute(catalogRuntime,participantId,currentRoute);
  const unavailableSource=new Proxy(b.STORAGE_INGESTION_A,{get(db,key){if(key==='prepare')return()=>{
    throw new Error('synthetic retained source unavailable');};const value=Reflect.get(db,key);
    return typeof value==='function'?value.bind(db):value;}});
  await expect(eraseParticipantAsOwner({...catalogRuntime,STORAGE_INGESTION_A:unavailableSource} as Env,
    'synthetic-admin',participantId)).rejects.toThrow();
  expect(await b.STORAGE_PUBLICATION_DB.prepare('SELECT erasure_generation FROM analytics_multi_source_control WHERE singleton=1')
    .first('erasure_generation')).toBe(1);
  expect(await readMultiSourcePublication(b.STORAGE_PUBLICATION_DB,'daily',today())).toBeNull();
  expect(await hasDeletionTombstone(b.DELETION_LEDGER,participantId)).toBe(true);
  for(const sourceDb of [b.STORAGE_INGESTION_A,b.STORAGE_INGESTION_B]){
    expect(await sourceDb.prepare('SELECT 1 FROM participants WHERE id=?').bind(participantId).first()).not.toBeNull();
  }
  const unavailable=new Proxy(b.STORAGE_ANALYTICS_B,{get(db,key){if(key==='prepare')return()=>{throw new Error('synthetic target unavailable');};
    const value=Reflect.get(db,key);return typeof value==='function'?value.bind(db):value;}});
  await expect(eraseParticipantAsOwner({...catalogRuntime,STORAGE_ANALYTICS_B:unavailable} as Env,
    'synthetic-admin',participantId)).rejects.toThrow();
  expect(await b.STORAGE_PUBLICATION_DB.prepare('SELECT erasure_generation FROM analytics_multi_source_control WHERE singleton=1')
    .first<number>('erasure_generation')).toBeGreaterThan(0);
  for(const sourceDb of [b.STORAGE_INGESTION_A,b.STORAGE_INGESTION_B]){
    expect(await sourceDb.prepare('SELECT 1 FROM participants WHERE id=?').bind(participantId).first()).toBeNull();
    expect(await sourceDb.prepare('SELECT 1 FROM storage_v11_owner_links WHERE participant_id=?').bind(participantId).first()).toBeNull();
  }
  expect(await b.DELETION_LEDGER.prepare("SELECT count(*) n FROM storage_erasure_targets WHERE state='complete'").first('n')).toBe(1);
  expect(await b.DELETION_LEDGER.prepare("SELECT count(*) n FROM storage_erasure_targets WHERE state='pending'").first('n')).toBe(1);
  await expect(eraseParticipantAsOwner(catalogRuntime,'synthetic-admin',participantId)).resolves
    .toMatchObject({deleted:true,alreadyDeleted:true,contributionsDeleted:null});
  expect(await b.DELETION_LEDGER.prepare("SELECT count(*) n FROM storage_erasure_targets WHERE state='complete'").first('n')).toBe(2);
  expect(await b.STORAGE_ANALYTICS_A.prepare('SELECT count(*) n FROM analytics_storage_erasure_receipts').first('n')).toBe(1);
  expect(await b.STORAGE_ANALYTICS_B.prepare('SELECT count(*) n FROM analytics_storage_erasure_receipts').first('n')).toBe(1);
 });
});
