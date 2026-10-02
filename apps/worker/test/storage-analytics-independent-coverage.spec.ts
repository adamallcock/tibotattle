import {env,reset} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from '../src/telemetry-v11-domain';
import {advanceEffectiveDependencyCoverage,readEffectiveScopeMutationToken} from '../src/storage-effective-selective-dependencies';
import {advanceCanonicalInputWork,readCanonicalInputSeal,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {readAnalyticsWorkClosureFence} from '../src/storage-analytics-closure-fence';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';

const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-independent-coverage',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
let corpus:SharedAnalyticsCorpus,scope:CanonicalInputScope,otherParticipant:string;
let snapshot:{source:AcceptedSourceTransfer;target:AcceptedSourceTransfer};
let laboratorySetup:unknown;
let pendingDevice:Awaited<ReturnType<typeof createV11DeviceFixture>>;

async function acceptedOtherUsage(database:D1Database,day:string,dense=true) {
 const device=pendingDevice;
 // One genuine accepted chunk at the existing 200-record native admission
 // bound. Initial empty domain activation precedes global bootstrap; later
 // v1.1 acceptance preserves the unrelated owner's narrow selective stamp.
 const records=dense?Array.from({length:200},(_,index)=>v11UsageRecord(day,'a',{
  eventId:'event:v2:'+(index+50000).toString(16).padStart(64,'0')})):[];
 const prepared=await makeV11Day(day,{usage:records},'synthetic-independent-coverage');
 await registerTelemetryV11DayManifest(database,device,prepared.manifest);
 for(const chunk of prepared.chunks){
  const envelopeDigest=await sha256Hex(canonicalJson(['synthetic-independent-coverage-upload',chunk.chunkDigest]));
  const principal=await authenticateDevice(database,device.authorization);
  const upload=await createDeviceUploadAuthorization(database,principal,envelopeDigest,1_000_000);
  const claimed=await claimDeviceUploadAuthorization(database,`Upload ${upload.uploadAuthorization}`,
   {envelopeDigest,bodyBytes:1_000_000,contentType:'application/json'});
  await persistTypedV11StagedChunk(database,device,chunk,{sourceNamespace:sourceId,
   chunkRowId:'chunk:'+(await sha256Hex(chunk.chunkDigest)).slice(0,36),envelopeDigest,
   deviceUploadAuthorizationId:claimed.authorizationId,r2Key:'synthetic/independent-coverage'});
 }
 const ready=await registerTelemetryV11DayManifest(database,device,prepared.manifest);
 const predecessor=await createTelemetryV11DomainPredecessor(database,device);
 const fromDay=day<predecessor.fromDay?day:predecessor.fromDay,throughDay=day>predecessor.throughDay?day:predecessor.throughDay;
 const days:TelemetryV11DomainManifest['days']=[];
 for(let at=Date.parse(fromDay+'T00:00:00.000Z');at<=Date.parse(throughDay+'T00:00:00.000Z');at+=86400000){
  const currentDay=new Date(at).toISOString().slice(0,10);
  const value=currentDay===day?ready:await registerTelemetryV11DayManifest(database,device,
   (await makeV11Day(currentDay,{},'synthetic-independent-coverage')).manifest);
  days.push({day:currentDay,manifestId:value.manifestId,manifestDigest:value.manifestDigest});
 }
 const domain:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay,throughDay,
  predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,
   legacyFingerprint:predecessor.legacyFingerprint},days,manifestDigest:'0'.repeat(64)};
 domain.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(domain));
 await activateTelemetryV11Domain(database,device,domain);
 return device.participantId;
}
async function pending(participantId=otherParticipant) {
 return source().prepare(`SELECT o.needs_work,o.seeded,
  (SELECT count(*) FROM storage_effective_selective_work w WHERE w.participant_id=o.participant_id) AS work,
  (SELECT count(*) FROM storage_effective_selective_reverse_work w WHERE w.participant_id=o.participant_id) AS reverse_work
  FROM storage_effective_selective_owners o WHERE o.participant_id=?`).bind(participantId)
  .first<{needs_work:number;seeded:number;work:number;reverse_work:number}>();
}
const token=()=>readEffectiveScopeMutationToken(source(),{sourceId,sourceNamespace:sourceId,
 participantId:scope.participantId,ownerDigest:scope.ownerDigest,fromDay:scope.day,throughDay:scope.day,includeSessions:false});

beforeAll(async()=>{
 await reset();const started=performance.now();
 await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const profile=createAnalyticsProfile(),left=profileAnalyticsDatabase(source(),'source',profile,()=> 'laboratory_setup'),
  right=profileAnalyticsDatabase(target(),'target',profile,()=> 'laboratory_setup');
 corpus=await seedSharedAnalyticsCorpus({source:left,target:right,sourceId,sourceNamespace:sourceId,
  calendarDays:10,graphDays:2,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 scope={sourceId,sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,participantId:corpus.participantId,
  day:corpus.correctionDay,stream:'usage',selectionMethod:'effective-union-v1'};
 pendingDevice=await createV11DeviceFixture(left,{participantId:'synthetic-independent-pending-owner',grant:true});
 await acceptedOtherUsage(left,scope.day,false);
 otherParticipant=pendingDevice.participantId;
 for(const owner of (await readStorageCommunityOwnerPage(left)).filter(owner=>owner.ownerDigest))
  await right.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
   VALUES(?,?,?,?,'active') ON CONFLICT(source_id,owner_digest) DO NOTHING`)
   .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
 // Complete actual global discovery before the later independent accepted
 // update, so this is not merely a cold-bootstrap control.
 let covered=false;
 for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(left,{sourceId,sourceNamespace:sourceId,
  maxSteps:64,maxRows:128})).status==='complete'){covered=true;break;}
 expect(covered).toBe(true);
 let sealed=false;
 for(let n=0;n<32;n++)if((await advanceCanonicalInputWork(left,right,{...scope,
  budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}})).state==='complete'){
  sealed=true;break;
 }
 expect(sealed).toBe(true);
 // Real outbox admission; pending unrelated ranges/jobs are retained. No ACK
 // is manufactured to make the targeted input or its feature job available.
 for(let n=0;n<16;n++){
  await advanceAnalyticsWorkEffects({source:left,target:right,sourceId,sourceNamespace:sourceId,
   meter:createD1InvocationBudget(950),now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});
  if(await right.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')===0)break;
 }
 expect(await right.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')).toBe(0);
 const ready=(await right.prepare("SELECT work_key,admission_queries FROM analytics_partition_work WHERE stage='features' AND state='ready'")
  .all<{work_key:string;admission_queries:number}>()).results;
 expect(ready.length).toBeGreaterThan(0);expect(ready.every(row=>row.admission_queries===600)).toBe(true);
 expect(await readCanonicalInputSeal(left,right,scope)).not.toBeNull();
 otherParticipant=await acceptedOtherUsage(left,scope.day);
 expect(otherParticipant).not.toBe(scope.participantId);
 expect(await pending()).toMatchObject({needs_work:1});
 expect(await source().prepare('SELECT complete FROM storage_effective_selective_bootstrap WHERE id=1').first<number>('complete')).toBe(1);
 expect(await token()).toBeDefined();expect(await readCanonicalInputSeal(source(),target(),scope)).not.toBeNull();
 const owners=await readStorageCommunityOwnerPage(source());expect(owners.filter(owner=>owner.ownerDigest).length).toBeGreaterThanOrEqual(3);
 const a=await captureAcceptedSourceTransfer(source()),z=await captureAcceptedSourceTransfer(target());
 snapshot={source:a.transfer,target:z.transfer};
 const summary=summarizeAnalyticsProfile(profile);
 laboratorySetup={elapsedMs:performance.now()-started,acceptedIndependentRows:200,readyFeatureJobs:ready.length,
  acceptanceCoverageInputBridge:{statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten},
  source:a.transfer.proof,target:z.transfer.proof,
  basis:'Local synthetic acceptance/coverage/input/bridge/snapshot is separate laboratory setup, outside measured scheduled invocation.'};
},120_000);

async function restore() {
 await reset();const started=performance.now();
 const a=await importAcceptedSourceTransfer(snapshot.source,source()),z=await importAcceptedSourceTransfer(snapshot.target,target());
 expect(a.proof).toEqual(snapshot.source.proof);expect(z.proof).toEqual(snapshot.target.proof);
 return {elapsedMs:performance.now()-started,
  statements:a.importProfile.statements+a.proofProfile.statements+z.importProfile.statements+z.proofProfile.statements,
  exportResourceMetadata:null,physicalSnapshotBytes:null};
}
async function exactProducts() {
 const queries={
  facts:'SELECT * FROM analytics_canonical_facts ORDER BY revision',
  quantities:'SELECT * FROM analytics_canonical_feature_quantities ORDER BY fact_revision',
  prices:'SELECT * FROM analytics_canonical_feature_prices ORDER BY fact_revision,family,dependency_digest',
  membership:'SELECT * FROM analytics_canonical_feature_membership ORDER BY fact_revision,dependency_revision',
  featureHeads:'SELECT * FROM analytics_canonical_activity_heads ORDER BY content_revision',
  manifests:'SELECT * FROM analytics_canonical_manifests ORDER BY content_revision',
  manifestRows:'SELECT * FROM analytics_canonical_manifest_rows ORDER BY content_revision,ordinal',
  partitionHeads:'SELECT * FROM analytics_canonical_partition_heads ORDER BY partition_key',
  successors:`SELECT work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,
   stage,day,stream,selection_method,resident_bytes,admission_queries FROM analytics_partition_work
   WHERE stage IN('activity','cache') ORDER BY work_key`,
  links:'SELECT * FROM analytics_partition_work_links ORDER BY parent_work_key,child_work_key',
 };
 const values:Record<string,unknown>={};for(const [name,sql]of Object.entries(queries))values[name]=(await target().prepare(sql).all()).results;
 return values;
}
async function run(bridge:boolean) {
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();
 const progress=await runCanonicalAnalyticsWorkPass({source:profileAnalyticsDatabase(source(),'source',profile,()=> 'scheduled'),
  target:profileAnalyticsDatabase(target(),'target',profile,()=> 'scheduled'),sourceId,sourceNamespace:sourceId,
  invocation,now:Date.now,deadlineMs:Date.now()+60_000,maxWaves:1,degree:1,stages:['features'],bridge});
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(progress.failed).toBe(0);
 const receipt={bridge,elapsedMs:performance.now()-started,statements:invocation.queriesUsed,
  rowsRead:summarizeAnalyticsProfile(profile).rowsRead,rowsWritten:summarizeAnalyticsProfile(profile).rowsWritten,progress};
 return {progress,receipt};
}

it('completes an exact600-admission unaffected leaf while a later independent accepted owner still needs coverage',async()=>{
 const referenceImport=await restore();expect(await token()).toBeDefined();
 const reference=await run(false);expect(reference.progress).toMatchObject({claimed:1,admitted:1,complete:1});
 const expected=await exactProducts();
 const candidateImport=await restore(),before=await token();expect(before).toBeDefined();
 expect(await readCanonicalInputSeal(source(),target(),scope)).not.toBeNull();
 const candidate=await run(true);expect(candidate.progress).toMatchObject({claimed:1,admitted:1,complete:1});
 expect(candidate.progress.coverage?.status).not.toBe('complete');expect(candidate.progress.coverage?.steps).toBeGreaterThan(0);
 expect(await pending()).toMatchObject({needs_work:1});
 expect(await token()).toEqual(before);expect(await exactProducts()).toEqual(expected);
 // Global publication closure remains false despite the independent private
 // leaf completion; no accepted source range/job is deleted to grant it.
 expect(await readAnalyticsWorkClosureFence({source:source(),target:target(),sourceId,sourceNamespace:sourceId})).toBeNull();
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
 expect(await source().prepare('SELECT count(*) n FROM storage_effective_selective_effects WHERE participant_id=?')
  .bind(otherParticipant).first<number>('n')).toBeGreaterThan(0);
 console.info(JSON.stringify({event:'independent_coverage_component',laboratorySetup,referenceImport,candidateImport,
  reference:reference.receipt,candidate:candidate.receipt,cpu:null,heap:null}));
},120_000);

it('retains the original ready leaf when its own accepted day changes instead of adopting stale source proof',async()=>{
 await restore();await corpus.mutateCorrection();
 expect(await token()).toBeUndefined();expect(await readCanonicalInputSeal(source(),target(),scope)).toBeNull();
 const result=await run(true);expect(result.progress.complete).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')).toBeGreaterThan(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_feature_quantities').first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_publications').first<number>('n')).toBe(0);
 expect(await readAnalyticsWorkClosureFence({source:source(),target:target(),sourceId,sourceNamespace:sourceId})).toBeNull();
},120_000);

it('keeps partial-source migration refusal ahead of target bookkeeping and every consumer claim',async()=>{
 await restore();const before=(await captureAcceptedSourceTransfer(target())).transfer.proof;
 await source().prepare('DROP TRIGGER storage_effective_selective_collection_controls_update').run();
 const result=await run(true);expect(result.progress).toMatchObject({state:'unavailable',reason:'source_migration_required',claimed:0,admitted:0,complete:0});
 expect((await captureAcceptedSourceTransfer(target())).transfer.proof).toEqual(before);
},60_000);

it('does not claim or spend a fresh950 meter after the cooperative invocation deadline',async()=>{
 await restore();const before=(await captureAcceptedSourceTransfer(target())).transfer.proof,invocation=createD1InvocationBudget(950),nowMs=Date.now();
 const result=await runCanonicalAnalyticsWorkPass({source:source(),target:target(),sourceId,sourceNamespace:sourceId,
  invocation,now:()=>nowMs,deadlineMs:nowMs,maxWaves:1,stages:['features']});
 expect(result).toMatchObject({state:'deferred',reason:'query_budget',claimed:0,admitted:0,complete:0});
 expect(invocation.queriesUsed).toBe(0);expect((await captureAcceptedSourceTransfer(target())).transfer.proof).toEqual(before);
},60_000);
