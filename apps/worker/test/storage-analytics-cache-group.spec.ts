import {env,reset} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {canonicalOccurrenceKey} from '../src/canonical-analytics-facts';
import {runCanonicalAnalyticsWorkPass} from '../src/storage-analytics-canonical-runtime';
import {CANONICAL_CACHE_PAIR_METHOD} from '../src/canonical-cache-pairs';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {dispatchAnalyticsCacheGroup,dispatchAnalyticsWork,type AnalyticsWorkLease} from '../src/analytics-partition-work';
import {advanceAnalyticsCacheGroup,type AnalyticsCacheGroupInput,type AnalyticsCacheGroupResult} from '../src/storage-analytics-cache-group';
import {advanceAnalyticsCacheWork,cachePublicationWorkSuccessor} from '../src/storage-analytics-cache-work';
import {advanceAnalyticsCanonicalWork} from '../src/storage-analytics-canonical-work';
import {captureAnalyticsManifestGroupProof} from '../src/storage-analytics-work-proof';
import {claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,readAnalyticsPartitionWork,previewAnalyticsCacheGroup,analyticsWorkKey,type AnalyticsWorkRequest,type AnalyticsStoredWork} from '../src/storage-analytics-partition-work';
import {advanceCanonicalInputWork,createCanonicalInputReadContext,readCanonicalInputSeal,closeCanonicalInputReadContext} from '../src/storage-canonical-analytics-input';
import {readCanonicalCacheDay,readCanonicalCacheSeriesResult,CANONICAL_CACHE_PREPARED_READY_PREDICATE} from '../src/storage-canonical-cache-pairs';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {advanceAnalyticsWorkEffects} from '../src/storage-analytics-work-effects';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {captureAcceptedSourceTransfer,importAcceptedSourceTransfer,type AcceptedSourceTransfer} from './helpers/analytics-source-snapshot';
import {createAnalyticsProfile,profileAnalyticsDatabase,summarizeAnalyticsProfile} from './helpers/analytics-profile';
import {telemetryV11DomainManifestDigestInput} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import {createTelemetryV11DomainPredecessor,activateTelemetryV11Domain} from '../src/telemetry-v11-domain';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const sourceId='synthetic-cache-group',source=()=>b.USAGE_MONITOR_DB,target=()=>b.STORAGE_ANALYTICS_DB;
let snapshot:{source:AcceptedSourceTransfer;target:AcceptedSourceTransfer},readyJobs=0,ownerDigest:string,laboratoryReceipt:unknown;
async function fixture(common=true){
 const minimumLeaves=common?8:1;
 await reset();const started=performance.now();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const initializationMs=performance.now()-started,profile=createAnalyticsProfile();
 const ingestion=profileAnalyticsDatabase(source(),'source',profile,()=> 'laboratory'),database=profileAnalyticsDatabase(target(),'target',profile,()=> 'laboratory');
 const corpus=await seedSharedAnalyticsCorpus({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  denseUsageRows:common?8:0,anchorDay:new Date(Date.now()-86400000).toISOString().slice(0,10)});
 ownerDigest=corpus.owner.ownerDigest;const day=common?corpus.graphDates[0]!:corpus.equivalentDay;
 const owners=(await readStorageCommunityOwnerPage(ingestion)).filter(owner=>owner.ownerDigest&&(!common||owner.ownerDigest===ownerDigest));
 expect(owners.length).toBe(common?1:2);
 for(const owner of owners){
  await database.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')
   ON CONFLICT(source_id,owner_digest) DO NOTHING`).bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  let covered=false;for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(ingestion,{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128})).status==='complete'){covered=true;break;}expect(covered).toBe(true);
  let sealed=false;for(let n=0;n<32;n++)if((await advanceCanonicalInputWork(ingestion,database,{sourceId,sourceNamespace:sourceId,
   ownerDigest:owner.ownerDigest!,participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1',
   budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}})).state==='complete'){sealed=true;break;}expect(sealed).toBe(true);
 }
 for(let n=0;n<16;n++){
  await advanceAnalyticsWorkEffects({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,meter:createD1InvocationBudget(950),
   now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});
  if(await database.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')===0)break;
 }
 expect(await database.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')).toBe(0);
 // Actual predecessor feature consumers create the original cache jobs.
 // Retain activity jobs, unrelated source ranges and all lineage/evidence.
 let featuresCompleted=0;for(let n=0;n<128;n++){
  if(await database.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')===0)break;
  const invocation=createD1InvocationBudget(950),db=invocation.wrap(database),src=invocation.wrap(ingestion);
  const result=await dispatchAnalyticsWork({degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,invocation,now:Date.now,deadlineMs:Date.now()+60_000,
   claim:limit=>claimAnalyticsPartitionWork(db,{sourceId,limit,nowMs:Date.now(),stages:['features']}),
   execute:async(lease,budget)=>(await advanceAnalyticsCanonicalWork({target:db,sources:[{sourceId,sourceNamespace:sourceId,database:src}],lease,budget})).outcome,
   release:async(lease,outcome)=>{await releaseAnalyticsPartitionWork(db,lease,outcome,Date.now());}});
  expect(result.complete).toBe(1);featuresCompleted+=result.complete;expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 }
 readyJobs=await database.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='ready'").first<number>('n')??0;
 expect(readyJobs).toBe(featuresCompleted);expect(readyJobs).toBeGreaterThanOrEqual(minimumLeaves);expect(readyJobs).toBeLessThanOrEqual(128);
 const left=await captureAcceptedSourceTransfer(source()),right=await captureAcceptedSourceTransfer(target());snapshot={source:left.transfer,target:right.transfer};
 const summary=summarizeAnalyticsProfile(profile);laboratoryReceipt={common,readyJobs,featuresCompleted,elapsedMs:performance.now()-started,
  initializationMs,initializationStatements:null,statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,
  source:left.transfer.proof,target:right.transfer.proof,contract:'Acceptance, coverage, original feature consumers and snapshot copying are laboratory setup.'};
}
beforeAll(()=>fixture(),120_000);
async function restore(){await reset();const started=performance.now(),left=await importAcceptedSourceTransfer(snapshot.source,source()),right=await importAcceptedSourceTransfer(snapshot.target,target());
 expect(left.proof).toEqual(snapshot.source.proof);expect(right.proof).toEqual(snapshot.target.proof);
 return {elapsedMs:performance.now()-started,statements:left.importProfile.statements+left.proofProfile.statements+right.importProfile.statements+right.proofProfile.statements};}

const exactQueries={
 facts:'SELECT * FROM analytics_canonical_facts ORDER BY revision',heads:'SELECT * FROM analytics_canonical_heads ORDER BY occurrence_key,selection_method',
 quantities:'SELECT * FROM analytics_canonical_feature_quantities ORDER BY fact_revision',prices:'SELECT * FROM analytics_canonical_feature_prices ORDER BY fact_revision,family,dependency_digest',
 membership:'SELECT * FROM analytics_canonical_feature_membership ORDER BY fact_revision,dependency_revision',activityHeads:'SELECT * FROM analytics_canonical_activity_heads ORDER BY content_revision',
 manifests:'SELECT * FROM analytics_canonical_manifests ORDER BY content_revision',manifestRows:'SELECT * FROM analytics_canonical_manifest_rows ORDER BY content_revision,ordinal',
 slots:'SELECT * FROM analytics_canonical_cache_slots ORDER BY slot_key',nodes:'SELECT * FROM analytics_canonical_cache_nodes ORDER BY node_key',
 logicalWork:'SELECT * FROM analytics_canonical_cache_logical_work ORDER BY logical_key',pairWork:'SELECT * FROM analytics_canonical_cache_pair_work ORDER BY node_key',
 pairs:'SELECT * FROM analytics_canonical_cache_pairs ORDER BY later_key',counters:'SELECT * FROM analytics_canonical_cache_counters ORDER BY source_id,owner_digest,selection_method,day,model,effort,band',
 days:'SELECT * FROM analytics_canonical_cache_days ORDER BY source_id,owner_digest,selection_method,day',
 groups:'SELECT * FROM analytics_canonical_cache_groups ORDER BY source_id,owner_digest,selection_method,day,model,effort',
 sessions:'SELECT * FROM analytics_canonical_cache_sessions ORDER BY source_id,owner_digest,selection_method,day,model,effort,band,session_digest',
 partitions:'SELECT * FROM analytics_canonical_cache_partitions ORDER BY partition_key',receipts:'SELECT * FROM analytics_canonical_cache_prepared_receipts ORDER BY work_key',
 work:'SELECT work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,day,stream,selection_method,resident_bytes,admission_queries,state FROM analytics_partition_work ORDER BY work_key',
 links:'SELECT * FROM analytics_partition_work_links ORDER BY parent_work_key,child_work_key',subjects:'SELECT * FROM analytics_partition_work_subjects ORDER BY work_key,source_id,owner_digest',
 effects:'SELECT * FROM analytics_partition_effect_refs ORDER BY work_key,effect_key',closures:'SELECT * FROM analytics_canonical_publication_closures ORDER BY closure_key',publicHeads:'SELECT * FROM analytics_community_daily_heads ORDER BY day',
} as const;
async function exact(){const values:Record<string,unknown>={};for(const [name,sql] of Object.entries(exactQueries))values[name]=(await target().prepare(sql).all()).results;return values;}
function projectionDifference(expected:Record<string,unknown>,actual:Record<string,unknown>){
 const differences:Record<string,unknown>={};
 for(const category of Object.keys(exactQueries)){
  const before=expected[category] as Record<string,unknown>[],after=actual[category] as Record<string,unknown>[];
  if(canonicalJson(before)===canonicalJson(after))continue;
  const columns=[...new Set([...before,...after].flatMap(row=>Object.keys(row)))];
  const changedColumns=columns.filter(column=>canonicalJson(before.map(row=>row[column]??null))!==canonicalJson(after.map(row=>row[column]??null)));
  differences[category]={expectedRows:before.length,actualRows:after.length,changedColumns,
   ...(category==='days'?{expectedControlRevisions:before.map(row=>row.revision),actualControlRevisions:after.map(row=>row.revision)}:{}),
   ...(category==='receipts'?{expectedLeaseRevisions:before.map(row=>row.work_revision),actualLeaseRevisions:after.map(row=>row.work_revision)}:{})};
 }
 return differences;
}
async function run(mode:'group'|'single',factory?:AnalyticsCacheGroupInput['captureGroupProof'],adapter?:(db:D1Database)=>D1Database){
 const profile=createAnalyticsProfile(),invocation=createD1InvocationBudget(950),started=performance.now();let phase='claim';
 const database=invocation.wrap(profileAnalyticsDatabase(adapter?adapter(target()):target(),'target',profile,()=>phase));
 const ingestion=invocation.wrap(profileAnalyticsDatabase(source(),'source',profile,()=>phase));const claims:AnalyticsWorkLease[]=[];let group:AnalyticsCacheGroupResult|undefined,single:Awaited<ReturnType<typeof advanceAnalyticsCacheWork>>|undefined;
 const proofFactory:NonNullable<AnalyticsCacheGroupInput['captureGroupProof']>=async input=>{
  phase='proof';const proof=await (factory??captureAnalyticsManifestGroupProof)(input);phase='preparation';
  if(proof.state!=='complete')return proof;
  return {...proof,forMember:key=>{phase='adoption';return proof.forMember(key);}};
 };
 const common={invocation,now:Date.now,deadlineMs:Date.now()+60_000,
  claim:async(limit:number)=>{phase='claim';const leases=await claimAnalyticsPartitionWork(database,{sourceId,limit,nowMs:Date.now(),stages:['cache']});claims.push(...leases);return leases;},
  release:async(lease:Parameters<typeof releaseAnalyticsPartitionWork>[1],outcome:Parameters<typeof releaseAnalyticsPartitionWork>[2])=>{phase='release';await releaseAnalyticsPartitionWork(database,lease,outcome,Date.now());}};
 const progress=mode==='group'?await dispatchAnalyticsCacheGroup({...common,execute:async(leases,budget)=>{
  phase='discovery';group=await advanceAnalyticsCacheGroup({target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],leases,budget,captureGroupProof:proofFactory});return group.members;
 }}):await dispatchAnalyticsWork({...common,degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,execute:async(lease,budget)=>{phase='singleton';single=await advanceAnalyticsCacheWork({
  target:database,sources:[{sourceId,sourceNamespace:sourceId,database:ingestion}],lease,budget});return single.outcome;}});
 profile.wallMs=performance.now()-started;profile.invocations=1;profile.maximumStatementsPerInvocation=invocation.queriesUsed;
 const summary=summarizeAnalyticsProfile(profile);expect(summary.statements).toBe(invocation.queriesUsed);expect(progress.statements).toBe(invocation.queriesUsed);
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);
 return {progress,group,single,claims,receipt:{statements:summary.statements,metadataSamples:summary.metadataSamples,failedStatements:summary.failedStatements,
  rowMetadataComplete:summary.metadataSamples===summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,elapsedMs:summary.wallMs,
  phaseStatements:Object.fromEntries(['claim','discovery','proof','preparation','adoption','release'].map(label=>[label,Object.entries(summary.costs).filter(([key])=>key.startsWith(label+'.')).reduce((n,[,value])=>n+value.statements,0)])),cpuMs:null,peakHeapBytes:null}};
}

async function drain(){
 const passes=[];for(let n=0;n<256;n++){
  const ready=await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND (state='ready' OR (state='leased' AND claim_expires_ms<=?))").bind(Date.now()).first<number>('n')??0;
  if(!ready)break;const value=await run('single');passes.push(value);
  expect(value.progress.failed,JSON.stringify(value)).toBe(0);expect(value.progress.claimed,JSON.stringify(value)).toBe(1);
 }
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state!='complete'").first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_logical_work').first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_pair_work').first<number>('n')).toBe(0);
 return passes;
}
const aggregate=(passes:readonly Awaited<ReturnType<typeof run>>[])=>({invocations:passes.length,
 claimed:passes.reduce((n,v)=>n+v.progress.claimed,0),completed:passes.reduce((n,v)=>n+v.progress.complete,0),deferred:passes.reduce((n,v)=>n+v.progress.deferred,0),
 statements:passes.reduce((n,v)=>n+v.receipt.statements,0),metadataSamples:passes.reduce((n,v)=>n+v.receipt.metadataSamples,0),
 failedStatements:passes.reduce((n,v)=>n+v.receipt.failedStatements,0),rowMetadataComplete:passes.every(v=>v.receipt.rowMetadataComplete),rowsRead:passes.reduce((n,v)=>n+v.receipt.rowsRead,0),rowsWritten:passes.reduce((n,v)=>n+v.receipt.rowsWritten,0),elapsedMs:passes.reduce((n,v)=>n+v.receipt.elapsedMs,0),
 reasons:passes.reduce<Record<string,number>>((out,v)=>{const key=v.single?.reason??'group';out[key]=(out[key]??0)+1;return out;},{}),
 maximumStatements:Math.max(...passes.map(v=>v.receipt.statements)),cpuMs:null,peakHeapBytes:null});
it('matches original native singleton cache staging, repair and receipts from the same accepted ready snapshot',async({task})=>{
 await restore();const singles=await drain(),expected=await exact(),imported=await restore(),group=await run('group');
 expect(group.progress,JSON.stringify(group)).toMatchObject({claimed:8,admitted:8,failed:0,releaseDeferred:0});
 expect(group.group).toMatchObject({scopes:1,residentBytes:32*1024*1024,fallbackRequired:false});expect(group.group!.facts).toBeLessThanOrEqual(16);expect(group.group!.statements).toBeLessThanOrEqual(850);
 const originalKeys=group.group!.selectedWorkKeys;expect(originalKeys).toHaveLength(8);
 const retries=await drain();
 expect(await target().prepare(`SELECT count(*) n FROM analytics_partition_work w WHERE w.work_key IN(SELECT value FROM json_each(?))
  AND w.state='complete' AND w.claim_token IS NULL AND w.claim_expires_ms=0
  AND(SELECT count(*) FROM analytics_partition_work_links WHERE parent_work_key=w.work_key)=1
  AND EXISTS(SELECT 1 FROM analytics_partition_work_links l JOIN analytics_partition_work c ON c.work_key=l.child_work_key
   WHERE l.parent_work_key=w.work_key AND c.stage='publication' AND c.input_revision=w.input_revision)`)
  .bind(JSON.stringify(originalKeys)).first<number>('n')).toBe(8);
 const receipt={laboratory:laboratoryReceipt,imported,
  originalSingletons:aggregate(singles),groupThenOriginalSingletonRetries:aggregate([group,...retries]),
  initialGroup:{...group.receipt,claimed:group.progress.claimed,completed:group.progress.complete,deferred:group.progress.deferred,facts:group.group?.facts,scopes:group.group?.scopes,metrics:group.group?.metrics,
   reasons:group.group?.members.map(value=>value.reason)},
  computeReserve:850,releasePerMember:2,executors:1,outputHash:await sha256Hex(canonicalJson(expected)),
  contract:'All actual deferrals, bounded native repair and fair original singleton retries are measured under fresh950invocations; accepted setup/import costs stay separate.',
  operationalClocks:'Only real lease/scheduler counters and private cache-clock CAS revision are excluded; canonical facts, evidence times, ordering, products, original receipts and successors are exact.'};
 Object.assign(task.meta,{cacheGroupReceipt:receipt});console.info('A04_CACHE_GROUP_COMMON_PROFILE '+JSON.stringify(receipt));
 expect(await exact()).toEqual(expected);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_heads').first<number>('n')).toBe(0);
},120_000);

let sparseSnapshot:{snapshot:typeof snapshot;readyJobs:number;ownerDigest:string;laboratoryReceipt:unknown}|undefined;
async function nativeFixture(kind:'sparse'|'dense'='sparse'){
 await reset();const started=performance.now();await initializeSharedAnalyticsCorpusDatabases(source(),target(),b,sourceId);
 const initializationMs=performance.now()-started,profile=createAnalyticsProfile();
 const ingestion=profileAnalyticsDatabase(source(),'source',profile,()=> 'laboratory'),database=profileAnalyticsDatabase(target(),'target',profile,()=> 'laboratory');
 const device=await createV11DeviceFixture(ingestion,{grant:true}),day=new Date(Date.now()-86400000).toISOString().slice(0,10),throughDay=new Date().toISOString().slice(0,10);
 const activateNativeDays=async(ready:readonly Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>[])=>{
  const predecessor=await createTelemetryV11DomainPredecessor(ingestion,device),manifest={schemaVersion:'telemetry-domain-manifest-v1.1' as const,
   fromDay:day,throughDay,predecessor:{token:predecessor.token,previousGenerationId:predecessor.previousGenerationId,legacyFingerprint:predecessor.legacyFingerprint},
   days:ready.map(value=>({day:value.day,manifestId:value.manifestId,manifestDigest:value.manifestDigest})),manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));await activateTelemetryV11Domain(ingestion,device,manifest);
 };
 // A genuine empty accepted generation creates the native owner identity.
 // Keep its evidence; admit the selected data only in a real successor domain.
 const emptyReady=[];for(const label of [day,throughDay]){
  const empty=await makeV11Day(label,{usage:[]},'synthetic-cache-group-sparse');
  emptyReady.push(await registerTelemetryV11DayManifest(ingestion,device,empty.manifest));
 }await activateNativeDays(emptyReady);
 const nativeOwner=(await readStorageCommunityOwnerPage(ingestion)).find(value=>value.participantId===device.participantId);
 expect(nativeOwner?.ownerDigest).toBeTruthy();
 const canonicalScope={sourceNamespace:sourceId,ownerDigest:nativeOwner!.ownerDigest!,selectionMethod:'effective-union-v1' as const};
 const acceptedIds:string[]=[],acceptedKeys:string[]=[],prefixes=new Set<string>();let candidateIdCount=0,hotRows=0;
 const expectedFacts=kind==='sparse'?8:17,maxCandidateIds=kind==='sparse'?128:4096;
 // Select only synthetic native IDs before acceptance. Root identities remain
 // the production canonicalOccurrenceKey result for this actual owner scope.
 const candidates=new Map<string,{eventId:string;key:string}[]>();
 for(let i=0;i<maxCandidateIds;i++){
  candidateIdCount++;const eventId='event:v2:'+await sha256Hex('synthetic-cache-group-'+kind+':'+i);
  const key=await canonicalOccurrenceKey(canonicalScope,'usage',eventId),prefix=key.slice(0,2);
  if(kind==='sparse'){if(prefixes.has(prefix))continue;prefixes.add(prefix);acceptedIds.push(eventId);acceptedKeys.push(key);
   if(acceptedIds.length===8)break;
  }else{
   const rows=candidates.get(prefix)??[];rows.push({eventId,key});candidates.set(prefix,rows);
   if(rows.length===10&&candidates.size>=8){const selected=[...rows,...[...candidates].filter(([other])=>other!==prefix).slice(0,7).map(([,values])=>values[0]!)];
    for(const value of selected){acceptedIds.push(value.eventId);acceptedKeys.push(value.key);prefixes.add(value.key.slice(0,2));}hotRows=10;break;}
  }
 }
 expect(candidateIdCount).toBeLessThanOrEqual(maxCandidateIds);expect(acceptedIds).toHaveLength(expectedFacts);expect(prefixes.size).toBe(8);
 if(kind==='dense')expect(hotRows).toBe(10);
 const ready=[];
 for(const label of [day,throughDay]){
  const records=label===day?acceptedIds.map((eventId,i)=>v11UsageRecord(day,'a',{
   eventId,eventTime:new Date(Date.parse(day+'T12:00:00Z')+i*60_000).toISOString()})):[];
  const prepared=await makeV11Day(label,{usage:records},'synthetic-cache-group-sparse');
  await registerTelemetryV11DayManifest(ingestion,device,prepared.manifest);
  for(const chunk of prepared.chunks){
   const envelopeDigest=await sha256Hex('synthetic-cache-group-upload:'+chunk.chunkDigest),principal=await authenticateDevice(ingestion,device.authorization);
   const upload=await createDeviceUploadAuthorization(ingestion,principal,envelopeDigest,4096),claim=await claimDeviceUploadAuthorization(ingestion,'Upload '+upload.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
   await persistTypedV11StagedChunk(ingestion,device,chunk,{sourceNamespace:sourceId,chunkRowId:'chunk:'+crypto.randomUUID(),
    r2Key:'synthetic/cache-group/'+chunk.chunkDigest,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
  }
  ready.push(await registerTelemetryV11DayManifest(ingestion,device,prepared.manifest));
 }
 await activateNativeDays(ready);
 const owners=(await readStorageCommunityOwnerPage(ingestion)).filter(value=>value.participantId===device.participantId);expect(owners).toHaveLength(1);
 ownerDigest=owners[0]!.ownerDigest!;expect(ownerDigest).toBeTruthy();const minimumLeaves=8;
 for(const owner of owners){
  await database.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')
   ON CONFLICT(source_id,owner_digest) DO NOTHING`).bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
  let covered=false;for(let n=0;n<48;n++)if((await advanceEffectiveDependencyCoverage(ingestion,{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128})).status==='complete'){covered=true;break;}expect(covered).toBe(true);
  let sealed=false;for(let n=0;n<32;n++)if((await advanceCanonicalInputWork(ingestion,database,{sourceId,sourceNamespace:sourceId,
   ownerDigest:owner.ownerDigest!,participantId:owner.participantId,day,stream:'usage',selectionMethod:'effective-union-v1',
   budget:{meter:createD1InvocationBudget(950),maxSteps:1,now:Date.now,deadlineMs:Date.now()+60_000}})).state==='complete'){sealed=true;break;}expect(sealed).toBe(true);
 }
 for(let n=0;n<16;n++){
  await advanceAnalyticsWorkEffects({source:ingestion,target:database,sourceId,sourceNamespace:sourceId,meter:createD1InvocationBudget(950),
   now:Date.now,deadlineMs:Date.now()+60_000,maxEffects:16,maxDays:1});
  if(await database.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')===0)break;
 }
 expect(await database.prepare("SELECT count(*) n FROM analytics_partition_canonical_effects WHERE state='pending'").first<number>('n')).toBe(0);
 // Actual predecessor feature consumers create the original cache jobs.
 // Retain activity jobs, unrelated source ranges and all lineage/evidence.
 let featuresCompleted=0;for(let n=0;n<128;n++){
  if(await database.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='features' AND state='ready'").first<number>('n')===0)break;
  const invocation=createD1InvocationBudget(950),db=invocation.wrap(database),src=invocation.wrap(ingestion);
  const result=await dispatchAnalyticsWork({degree:1,maxResidentBytes:32*1024*1024,releaseQueries:2,invocation,now:Date.now,deadlineMs:Date.now()+60_000,
   claim:limit=>claimAnalyticsPartitionWork(db,{sourceId,limit,nowMs:Date.now(),stages:['features']}),
   execute:async(lease,budget)=>(await advanceAnalyticsCanonicalWork({target:db,sources:[{sourceId,sourceNamespace:sourceId,database:src}],lease,budget})).outcome,
   release:async(lease,outcome)=>{await releaseAnalyticsPartitionWork(db,lease,outcome,Date.now());}});
  expect(result.complete).toBe(1);featuresCompleted+=result.complete;expect(invocation.queriesUsed).toBeLessThanOrEqual(950);
 }
 readyJobs=await database.prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='ready'").first<number>('n')??0;
 expect(readyJobs).toBe(featuresCompleted);expect(readyJobs).toBeGreaterThanOrEqual(minimumLeaves);expect(readyJobs).toBeLessThanOrEqual(128);

 expect(readyJobs).toBe(8);expect(await database.prepare('SELECT count(*) n FROM analytics_canonical_facts').first<number>('n')).toBe(expectedFacts);
 expect((await database.prepare('SELECT occurrence_key FROM analytics_canonical_facts ORDER BY occurrence_key').all<{occurrence_key:string}>()).results
  .map(row=>row.occurrence_key)).toEqual([...acceptedKeys].sort());
 const left=await captureAcceptedSourceTransfer(source()),right=await captureAcceptedSourceTransfer(target());snapshot={source:left.transfer,target:right.transfer};
 const summary=summarizeAnalyticsProfile(profile);laboratoryReceipt={fixture:kind+'actual typedv1.1 rows,1owner/day,2native accepted domain days',initialEmptyDomain:true,candidateIdCount,maxCandidateIds,acceptedRows:expectedFacts,hotRows,readyJobs,featuresCompleted,
  elapsedMs:performance.now()-started,initializationMs,initializationStatements:null,statements:summary.statements,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,
  source:left.transfer.proof,target:right.transfer.proof,contract:'Native acceptance/coverage/input/feature producers and snapshot copy are separate laboratory setup; no synthetic jobs or ACKs.'};
}
async function sparse<T>(execute:()=>Promise<T>){const original={snapshot,readyJobs,ownerDigest,laboratoryReceipt};try{
 if(!sparseSnapshot){await nativeFixture();sparseSnapshot={snapshot,readyJobs,ownerDigest,laboratoryReceipt};}
 ({snapshot,readyJobs,ownerDigest,laboratoryReceipt}=sparseSnapshot);return await execute();
 }finally{({snapshot,readyJobs,ownerDigest,laboratoryReceipt}=original);}}

const additionalSnapshots=new Map<'mixed'|'dense',{snapshot:typeof snapshot;readyJobs:number;ownerDigest:string;laboratoryReceipt:unknown}>();
async function additionalFixture<T>(kind:'mixed'|'dense',execute:()=>Promise<T>){const original={snapshot,readyJobs,ownerDigest,laboratoryReceipt};try{
 let accepted=additionalSnapshots.get(kind);if(!accepted){if(kind==='mixed')await fixture(false);else await nativeFixture('dense');
  accepted={snapshot,readyJobs,ownerDigest,laboratoryReceipt};additionalSnapshots.set(kind,accepted);}
 ({snapshot,readyJobs,ownerDigest,laboratoryReceipt}=accepted);return await execute();
 }finally{({snapshot,readyJobs,ownerDigest,laboratoryReceipt}=original);}}

async function assertOwnCompleteLeases(passes:readonly Awaited<ReturnType<typeof run>>[]){
 let completed=0;
 for(const pass of passes)for(const lease of pass.claims){
  if(!(pass.single?.completedWithinLease||pass.group?.members.find(member=>member.workKey===lease.workKey)?.completedWithinLease))continue;
  expect(await target().prepare('SELECT state,revision,claim_token,claim_expires_ms FROM analytics_partition_work WHERE work_key=?').bind(lease.workKey).first())
   .toEqual({state:'complete',revision:lease.revision+1,claim_token:null,claim_expires_ms:0});completed++;
 }
 return completed;
}
async function assertTerminalPreparationHints(){
 const rows=await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_prepared_receipts').first<number>('n')??0;
 const valid=await target().prepare(`SELECT count(*) n FROM analytics_canonical_cache_prepared_receipts r
  JOIN analytics_partition_work w ON w.work_key=r.work_key JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key
  JOIN analytics_canonical_manifests m ON m.content_revision=h.content_revision
  WHERE w.stage='cache' AND w.state='complete' AND w.claim_token IS NULL AND w.claim_expires_ms=0
  AND w.revision>r.work_revision AND r.work_revision>=1 AND w.input_revision=r.input_revision AND h.content_revision=r.input_revision
  AND m.partition_key=w.partition_key AND r.partition_key=w.partition_key AND r.method=?
  AND m.generation=r.manifest_generation AND m.row_count=r.row_count AND m.state='complete'
  AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
  AND(SELECT count(*) FROM analytics_canonical_manifest_rows WHERE content_revision=m.content_revision)=m.row_count
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows mr LEFT JOIN analytics_canonical_facts f ON f.revision=mr.revision
   LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision WHERE mr.content_revision=m.content_revision
   AND(f.revision IS NULL OR s.fact_revision IS NULL OR f.stream!='usage' OR s.slot_key!=f.selection_method||'/'||f.occurrence_key
    OR s.root_partition_key!=m.root_partition_key OR s.source_id!=f.source_id OR s.owner_digest!=f.owner_digest OR s.selection_method!=f.selection_method))`).bind(CANONICAL_CACHE_PAIR_METHOD).first<number>('n');
 expect(valid).toBe(rows);
 expect(await target().prepare(`SELECT count(*) n FROM analytics_partition_work w WHERE w.state='complete' AND(${CANONICAL_CACHE_PREPARED_READY_PREDICATE})`).first<number>('n')).toBe(0);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);return {rows,valid,completedReadyHints:0};
}
async function publicCacheProducts(){
 const meter=createD1InvocationBudget(950),db=meter.wrap(target()),src=meter.wrap(source());
 const owner=(await readStorageCommunityOwnerPage(src)).find(value=>value.ownerDigest===ownerDigest);expect(owner).toBeTruthy();
 const day=await db.prepare('SELECT min(observed_day) day FROM analytics_canonical_facts WHERE source_id=? AND owner_digest=?').bind(sourceId,ownerDigest).first<string>('day');expect(day).toBeTruthy();
 const scope={sourceId,sourceNamespace:sourceId,participantId:owner!.participantId,ownerDigest,selectionMethod:'effective-union-v1' as const,day:day!,stream:'usage' as const};
 const context=await createCanonicalInputReadContext(src,db,[scope],Date.now()+60_000);expect(context).not.toBeNull();
 try{
  const pin=await readCanonicalInputSeal(src,db,scope,context!);expect(pin).not.toBeNull();
  const stillCurrent=async()=>{const next=await readCanonicalInputSeal(src,db,scope,context!);return next!==null&&next.sourceStamp===pin!.sourceStamp&&next.scopeKey===pin!.scopeKey;};
  const aggregate=await readCanonicalCacheDay({target:db,scope:{sourceId,ownerDigest,selectionMethod:scope.selectionMethod},day:day!,stillCurrent});expect(aggregate).not.toBeNull();
  const series=await readCanonicalCacheSeriesResult({target:db,scopes:[{sourceId,ownerDigest,selectionMethod:scope.selectionMethod}],nowMs:Date.parse(day+'T20:00:00Z'),stillCurrent,
   budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+60_000}});
  expect(series.state).toBe('complete');expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  if(series.state!=='complete')throw Error('NATIVE_CACHE_PUBLIC_READER_PENDING');
  return {aggregate,series:series.value,membershipDigest:series.membershipDigest,anchorDay:series.anchorDay};
 }finally{closeCanonicalInputReadContext(context!);}
}
it('completes eight sparse accepted native cache leaves within850 computation and exact original singleton products',async({task})=>sparse(async()=>{
 await restore();const singles=await drain(),expected=await exact(),referenceLeases=await assertOwnCompleteLeases(singles),referenceHints=await assertTerminalPreparationHints(),expectedPublic=await publicCacheProducts(),imported=await restore(),group=await run('group');
 Object.assign(task.meta,{cacheGroupReceipt:{laboratory:laboratoryReceipt,imported,originalSingletons:aggregate(singles),group:group.receipt,
  outcome:group.progress,facts:group.group?.facts,scopes:group.group?.scopes,residentBytes:group.group?.residentBytes,computeStatements:group.group?.statements,
  metrics:group.group?.metrics,outputHash:await sha256Hex(canonicalJson(expected)),computeReserve:850,releasePerMember:2,executors:1}});
 expect(group.progress,JSON.stringify(group)).toMatchObject({claimed:8,admitted:8,complete:8,failed:0,releaseDeferred:0});
 expect(group.group).toMatchObject({facts:8,scopes:1,residentBytes:32*1024*1024,fallbackRequired:false});expect(group.group!.statements).toBeLessThanOrEqual(850);
 const actual=await exact(),candidateLeases=await assertOwnCompleteLeases([group]),candidateHints=await assertTerminalPreparationHints();
 Object.assign(task.meta,{privateProjectionDifference:projectionDifference(expected,actual),controls:{referenceLeases,candidateLeases,referenceHints,candidateHints}});
 expect(referenceLeases).toBe(8);expect(candidateLeases).toBe(8);
 const {receipts:_referenceHints,...referenceProducts}=expected,{receipts:_candidateHints,...candidateProducts}=actual;
 expect(candidateProducts).toEqual(referenceProducts);expect(await publicCacheProducts()).toEqual(expectedPublic);
 Object.assign(task.meta,{publicOutputHash:await sha256Hex(canonicalJson(expectedPublic))});
}),120_000);


async function runRuntime(){
 const claims:{work_key:string;revision:number;claim_token:string;stage:string}[]=[],invocation=createD1InvocationBudget(950),profile=createAnalyticsProfile();
 const raw=new Proxy(target(),{get(database,key){if(key==='prepare')return(sql:string)=>{
  const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(inner,property){
   if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values));
   // The profiler implements first() through native all() to retain D1 cost.
   if(property==='all')return async(...args:unknown[])=>{const result=await Reflect.apply(inner.all,inner,args);
    if(sql.includes("UPDATE analytics_partition_work SET state='leased'"))for(const row of result.results)claims.push(row);return result;};
   const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
  }});return wrap(database.prepare(sql));}
  const value:unknown=Reflect.get(database,key);return typeof value==='function'?value.bind(database):value;
 }});
 const started=performance.now(),progress=await runCanonicalAnalyticsWorkPass({source:profileAnalyticsDatabase(source(),'source',profile,()=> 'runtime'),
  target:profileAnalyticsDatabase(raw,'target',profile,()=> 'runtime'),sourceId,sourceNamespace:sourceId,invocation,now:Date.now,
  deadlineMs:Date.now()+60_000,degree:1,maxWaves:1,stages:['cache'],bridge:false});
 const summary=summarizeAnalyticsProfile(profile);expect(summary.statements).toBe(invocation.queriesUsed);expect(progress.statements).toBe(invocation.queriesUsed);
 expect(invocation.queriesUsed).toBeLessThanOrEqual(950);expect(invocation.reserveQueries).toBe(0);
 return {progress,claims,receipt:{statements:invocation.queriesUsed,rowsRead:summary.rowsRead,rowsWritten:summary.rowsWritten,elapsedMs:performance.now()-started,cpuMs:null,peakHeapBytes:null}};
}
async function assertRuntimeCompleteLeases(claims:readonly {work_key:string;revision:number;claim_token:string;stage:string}[]){
 for(const claim of claims){expect(claim.stage).toBe('cache');expect(claim.claim_token).toBeTruthy();
  expect(await target().prepare('SELECT state,revision,claim_token,claim_expires_ms FROM analytics_partition_work WHERE work_key=?').bind(claim.work_key).first())
   .toEqual({state:'complete',revision:claim.revision+1,claim_token:null,claim_expires_ms:0});}
}
it('uses the real runtime for all eight sparse cache heads and exact original singleton products',async({task})=>sparse(async()=>{
 await restore();const singles=await drain(),expected=await exact(),expectedPublic=await publicCacheProducts(),imported=await restore();
 const runtime=await runRuntime();
 Object.assign(task.meta,{cacheRuntimeReceipt:{laboratory:laboratoryReceipt,imported,originalSingletons:aggregate(singles),progress:runtime.progress,
  ...runtime.receipt,actualLeases:runtime.claims.length,configuredDegree:1,computeReserve:850,releasePerMember:2}});
 expect(runtime.progress).toMatchObject({claimed:8,admitted:8,complete:8,deferred:0,failed:0,releaseDeferred:0});
 expect(runtime.claims).toHaveLength(8);expect(new Set(runtime.claims.map(claim=>claim.work_key)).size).toBe(8);
 await assertRuntimeCompleteLeases(runtime.claims);
 const {receipts:_referenceHints,...referenceProducts}=expected,{receipts:_candidateHints,...candidateProducts}=await exact();
 expect(candidateProducts).toEqual(referenceProducts);const hints=await assertTerminalPreparationHints();expect(hints.rows).toBe(0);
 expect(await publicCacheProducts()).toEqual(expectedPublic);await noPublicOutput();
 Object.assign(task.meta,{publicOutputHash:await sha256Hex(canonicalJson(expectedPublic))});
}),120_000);

function atBatch(db:D1Database,predicate:(sql:readonly string[])=>boolean,action:()=>Promise<void>,when:'before'|'after'='after',lost=false):D1Database{
 const entries=new WeakMap<D1PreparedStatement,{sql:string;original:D1PreparedStatement}>();let fired=false;
 const wrap=(original:D1PreparedStatement,sql:string):D1PreparedStatement=>{const proxy=new Proxy(original,{get(inner,key){
  if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql);const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});entries.set(proxy,{sql,original});return proxy;};
 return new Proxy(db,{get(inner,key){if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const values=statements.map(statement=>entries.get(statement)!);expect(values.every(Boolean)).toBe(true);
   const trigger=!fired&&predicate(values.map(value=>value.sql));if(trigger&&when==='before'){fired=true;await action();}
   const result=await inner.batch(values.map(value=>value.original));if(trigger&&when==='after'){fired=true;await action();}
   if(trigger&&lost)throw Error('synthetic accepted response lost');return result;};
  const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
 }});
}
const slotBatch=(sql:readonly string[])=>sql.some(value=>value.includes('INSERT INTO analytics_canonical_cache_slots'));
const sealBatch=(sql:readonly string[])=>sql.some(value=>value.includes('INSERT INTO analytics_canonical_cache_partitions'));
const completeBatch=(sql:readonly string[])=>sql.some(value=>/UPDATE\s+analytics_partition_work\s+SET\s+state='complete'/iu.test(value));
async function noPublicOutput(){expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_publication_closures').first<number>('n')).toBe(0);
 expect(await target().prepare('SELECT count(*) n FROM analytics_community_daily_heads').first<number>('n')).toBe(0);}
async function sourceChange(db:D1Database){const owner=(await readStorageCommunityOwnerPage(db)).find(value=>value.ownerDigest===ownerDigest);expect(owner).toBeTruthy();
 expect(await db.prepare('UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=? RETURNING revision').bind(owner!.participantId).first<number>('revision')).toBe(owner!.inputRevision+1);}
for(const [label,predicate,completed] of [['slot',slotBatch,0],['completion',completeBatch,1]] as const)it('fences source change after first durable '+label+' and retains unfinished original cache leaves',()=>sparse(async()=>{
 await restore();let measured:D1Database,changed=false;
 const result=await run('group',async input=>{measured=input.budget.meter.wrap(input.sources[0]!.database);return captureAnalyticsManifestGroupProof(input);},db=>atBatch(db,predicate,async()=>{await sourceChange(measured);changed=true;}));
 expect(changed).toBe(true);expect(result.progress.complete).toBe(0);expect(result.progress.failed).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='complete'").first<number>('n')).toBe(completed);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='ready'").first<number>('n')).toBe(8-completed);
 expect(await assertOwnCompleteLeases([result])).toBe(completed);await noPublicOutput();
}),120_000);
for(const mutation of ['source','head','expiry','erasure'] as const)it('preserves the final native group seal boundary after a real '+mutation+' change',()=>sparse(async()=>{
 await restore();let proofInput:Parameters<typeof captureAnalyticsManifestGroupProof>[0],changed=false;
 const result=await run('group',async input=>{proofInput=input;return captureAnalyticsManifestGroupProof(input);},db=>atBatch(db,sealBatch,async()=>{
  const last=proofInput.members.at(-1)!,metered=proofInput.budget.meter.wrap(proofInput.target);
  if(mutation==='source')await sourceChange(proofInput.budget.meter.wrap(proofInput.sources[0]!.database));
  else if(mutation==='head')await metered.prepare('DELETE FROM analytics_canonical_partition_heads WHERE partition_key=?').bind(last.work.partitionKey).run();
  else if(mutation==='expiry')await metered.prepare('UPDATE analytics_partition_work SET claim_expires_ms=?,revision=revision+1,updated_ms=? WHERE work_key=? AND revision=? AND claim_token=?')
   .bind(Date.now()-1,Date.now(),last.work.workKey,last.lease.revision,last.lease.claimToken).run();
  else await metered.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?").bind(sourceId,ownerDigest).run();
  changed=true;
 },'before'));
 expect(changed).toBe(true);expect(result.progress.complete).toBe(0);expect(result.progress.failed).toBe(0);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='complete'").first<number>('n')).toBe(0);
 if(mutation==='source')expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_partitions').first<number>('n')).toBe(8);
 else expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_partitions').first<number>('n')).toBe(0);
 if(mutation==='expiry'){
  expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='leased' AND claim_expires_ms<=?").bind(Date.now()).first<number>('n')).toBe(1);
  const retries=await drain();expect(await assertOwnCompleteLeases(retries)).toBe(8);
 }
 if(mutation==='erasure')for(const table of ['analytics_canonical_facts','analytics_canonical_cache_slots','analytics_canonical_cache_nodes','analytics_canonical_cache_pairs'])
  expect(await target().prepare('SELECT count(*) n FROM '+table).first<number>('n')).toBe(0);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);await noPublicOutput();
}),120_000);
it('recovers a lost original leaf completion response through exact durable receipts without duplicate successors',()=>sparse(async()=>{
 await restore();expect((await run('group')).progress.complete).toBe(8);const expected=await exact();await restore();let lost=false;
 const result=await run('group',undefined,db=>atBatch(db,completeBatch,async()=>{lost=true;},'after',true));
 expect(lost).toBe(true);expect(result.progress).toMatchObject({complete:8,failed:0,releaseDeferred:0});expect(await assertOwnCompleteLeases([result])).toBe(8);
 expect(await exact()).toEqual(expected);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work_links l JOIN analytics_partition_work w ON w.work_key=l.parent_work_key WHERE w.stage='cache'").first<number>('n')).toBe(8);
 await noPublicOutput();
}),120_000);
it('declines an exact-prefix race without claiming the competing original cache lease',()=>sparse(async()=>{
 await restore();const meter=createD1InvocationBudget(950),db=meter.wrap(target()),nowMs=Date.now(),first=(await claimAnalyticsPartitionWork(db,{sourceId,limit:1,nowMs,stages:['cache']}))[0]!;
 const preview=await previewAnalyticsCacheGroup({target:db,sourceId,first,nowMs,stages:['cache']});expect(preview.state).toBe('eligible');if(preview.state!=='eligible')throw Error('expected cache prefix');
 const competing=(await claimAnalyticsPartitionWork(createD1InvocationBudget(950).wrap(target()),{sourceId,limit:1,nowMs,stages:['cache']}))[0]!;expect(competing.workKey).toBe(preview.workKeys[1]);
 expect(await claimAnalyticsPartitionWork(db,{sourceId,limit:7,nowMs,stages:['cache'],expectedWorkKeys:preview.workKeys.slice(1)})).toEqual([]);
 expect(await readAnalyticsPartitionWork(db,competing,nowMs)).not.toBeNull();expect(await releaseAnalyticsPartitionWork(db,first,'not_admitted',nowMs)).toBe(true);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='leased'").first<number>('n')).toBe(1);
 expect(await releaseAnalyticsPartitionWork(db,competing,'not_admitted',nowMs)).toBe(true);const passes=await drain();expect(await assertOwnCompleteLeases(passes)).toBe(8);
 expect(meter.queriesUsed).toBeLessThanOrEqual(950);await noPublicOutput();
}),120_000);
it('never groups a retried cache leaf and preserves original fair singleton progress',()=>sparse(async()=>{
 await restore();const first=await run('group',async input=>{const proof=await captureAnalyticsManifestGroupProof(input);return proof.state==='complete'?{...proof,stillCurrent:async()=>false}:proof;});
 expect(first.progress).toMatchObject({claimed:8,complete:0,deferred:8});const retry=await run('group');
 expect(retry.progress).toMatchObject({claimed:8,admitted:0,complete:0});expect(retry.group).toMatchObject({fallbackRequired:true});
 expect(retry.group!.members.every(member=>member.reason==='singleton_retry_required')).toBe(true);
 const passes=await drain();expect(await assertOwnCompleteLeases(passes)).toBe(8);await noPublicOutput();
}),120_000);

type WorkProjection={work_key:string;head_key:string;source_id:string;owner_digest:string|null;partition_key:string;input_revision:string;
 policy_revision:string;stage:AnalyticsWorkRequest['stage'];lane:AnalyticsWorkRequest['lane'];day:string|null;stream:AnalyticsWorkRequest['stream'];
 selection_method:AnalyticsWorkRequest['selectionMethod'];resident_bytes:number;admission_queries:number;state:string};
const projectRequest=(work:AnalyticsWorkRequest,workKey:string,state:string):WorkProjection=>({work_key:workKey,head_key:work.headKey,source_id:work.sourceId,
 owner_digest:work.ownerDigest,partition_key:work.partitionKey,input_revision:work.inputRevision,policy_revision:work.policyRevision,stage:work.stage,lane:work.lane,
 day:work.day,stream:work.stream,selection_method:work.selectionMethod,resident_bytes:work.residentBytes,admission_queries:work.admissionQueries,state});
async function nativeRecoveryVector(reference:Record<string,unknown>,claims:readonly AnalyticsWorkLease[],completed:number,injectedMs:number):Promise<Record<string,unknown>> {
 expect(claims).toHaveLength(8);expect(new Set(claims.map(lease=>lease.workKey)).size).toBe(8);expect([0,1]).toContain(completed);
 const rows=new Map((reference.work as WorkProjection[]).map(row=>[row.work_key,row])),links=reference.links as {parent_work_key:string;child_work_key:string}[];
 for(let i=0;i<claims.length;i++){
  const lease=claims[i]!,before=rows.get(lease.workKey)!;expect(before).toBeTruthy();expect(before.stage).toBe('cache');expect(before.state).toBe('complete');
  const failed=i>=completed,predictedLane=failed?'recovery':before.lane;
  const control=await target().prepare('SELECT state,lane,revision,claim_token,claim_expires_ms,ready_ms,updated_ms,attempts FROM analytics_partition_work WHERE work_key=?')
   .bind(lease.workKey).first<{state:string;lane:string;revision:number;claim_token:string|null;claim_expires_ms:number;ready_ms:number;updated_ms:number;attempts:number}>();
  expect(control).not.toBeNull();expect(control).toMatchObject({state:failed?'ready':'complete',lane:predictedLane,revision:lease.revision+1,
   claim_token:null,claim_expires_ms:0,attempts:1});
  if(failed){expect(control!.updated_ms).toBeGreaterThanOrEqual(injectedMs);expect(control!.ready_ms).toBe(control!.updated_ms+5000);}
  // Predict the original parent's final lane from native failure-release
  // semantics. No observed candidate lane is copied into the expected vector.
  const parent:AnalyticsStoredWork={workKey:before.work_key,headKey:before.head_key,sourceId:before.source_id,ownerDigest:before.owner_digest,
   partitionKey:before.partition_key,inputRevision:before.input_revision,policyRevision:before.policy_revision,stage:before.stage,lane:predictedLane,
   day:before.day,stream:before.stream,selectionMethod:before.selection_method,residentBytes:before.resident_bytes,admissionQueries:before.admission_queries,
   attempts:failed?2:1};
  rows.set(lease.workKey,projectRequest(parent,lease.workKey,'complete'));
  const successor=await cachePublicationWorkSuccessor(parent,parent.inputRevision),childKey=await analyticsWorkKey(successor);
  expect(links.filter(link=>link.parent_work_key===lease.workKey)).toEqual([{parent_work_key:lease.workKey,child_work_key:childKey}]);
  expect(rows.has(childKey)).toBe(true);rows.set(childKey,projectRequest(successor,childKey,'ready'));
 }
 return {...reference,work:[...rows.values()].sort((a,b)=>a.work_key.localeCompare(b.work_key))};
}

async function waitForRealFailureBackoff(){
 const readyMs=await target().prepare("SELECT max(ready_ms) n FROM analytics_partition_work WHERE stage='cache' AND state='ready'").first<number>('n')??0;
 const waitMs=Math.max(0,readyMs-Date.now()+1);expect(waitMs).toBeLessThanOrEqual(5001);
 const started=performance.now();if(waitMs)await new Promise(resolve=>setTimeout(resolve,waitMs));return performance.now()-started;
}
for(const interruption of ['staging_response','second_completion'] as const)it('recovers original cache leaves after partial '+interruption+' loss without duplicate native products',async({task})=>sparse(async()=>{
 await restore();const singles=await drain(),expected=await exact(),expectedPublic=await publicCacheProducts();await restore();let injected=false,injectedMs=0,completionBatches=0,closed=0;
 const predicate=interruption==='staging_response'?slotBatch:(sql:readonly string[])=>completeBatch(sql)&&++completionBatches===2;
 const failed=await run('group',async input=>{const proof=await captureAnalyticsManifestGroupProof(input);return proof.state==='complete'?{...proof,close:()=>{closed++;proof.close();}}:proof;},
  db=>atBatch(db,predicate,async()=>{injected=true;injectedMs=Date.now();if(interruption==='second_completion')throw Error('synthetic interruption before second original completion');},
   interruption==='staging_response'?'after':'before',interruption==='staging_response'));
 expect(injected).toBe(true);expect(closed).toBe(1);expect(failed.progress).toMatchObject({claimed:8,failed:8,releaseDeferred:0});
 const completed=interruption==='staging_response'?0:1;
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='complete'").first<number>('n')).toBe(completed);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work WHERE stage='cache' AND state='ready' AND lane='recovery'").first<number>('n')).toBe(8-completed);
 expect(await target().prepare('SELECT count(*) n FROM analytics_canonical_cache_slots').first<number>('n')).toBe(8);
 expect(await target().prepare("SELECT count(*) n FROM analytics_partition_work_links l JOIN analytics_partition_work w ON w.work_key=l.parent_work_key WHERE w.stage='cache'").first<number>('n')).toBe(completed);
 if(completed){const lease=failed.claims[0]!;await assertRuntimeCompleteLeases([{work_key:lease.workKey,revision:lease.revision,claim_token:lease.claimToken,stage:lease.stage}]);}
 const recoveryExpected=await nativeRecoveryVector(expected,failed.claims,completed,injectedMs);
 const recoveryWaitMs=await waitForRealFailureBackoff(),retries=await drain();expect(await assertOwnCompleteLeases(retries)).toBe(8-completed);
 const hints=await assertTerminalPreparationHints(),actual=await exact(),{receipts:_referenceHints,...referenceProducts}=recoveryExpected,{receipts:_candidateHints,...candidateProducts}=actual;
 const actualPublic=await publicCacheProducts();expect(actualPublic).toEqual(expectedPublic);await noPublicOutput();
 Object.assign(task.meta,{privateProjectionDifference:projectionDifference(expected,actual),cachePartialLossReceipt:{laboratory:laboratoryReceipt,interruption,
  originalSingletons:aggregate(singles),failed:failed.receipt,reported:failed.progress,actualCompletedBeforeRetry:completed,proofsClosed:closed,
  recoveryWaitMs,singletonRecovery:aggregate(retries),hints,nativeRecoveryVector:{failedOriginals:8-completed,originalCompleted:completed,exactChildren:8,
   contract:'Native failure release and original successor builder predict full parent/child vectors; lane is retained and independently asserted.'},publicOutputHash:await sha256Hex(canonicalJson(actualPublic)),cpuMs:null,peakHeapBytes:null,
  failedResponseRowCostContract:'Rows read/written sum only observed metadata. Failed response statements remain charged to950; missing row-cost metadata is explicit.'}});
 expect(candidateProducts).toEqual(referenceProducts);
}),120_000);
it('refuses genuine mixed accepted source scopes and retains ordinary singleton runtime progress',async({task})=>additionalFixture('mixed',async()=>{
 await restore();expect(await target().prepare("SELECT count(DISTINCT owner_digest) n FROM analytics_canonical_facts WHERE stream='usage'").first<number>('n')).toBe(2);
 const singles=await drain(),expected=await exact();await restore();const group=await run('group');
 expect(group.progress).toMatchObject({admitted:0,complete:0,failed:0});expect(group.group).toMatchObject({scopes:2,fallbackRequired:true});
 expect(group.group!.members.every(member=>member.reason==='scope_capacity')).toBe(true);
 const retries=await drain();expect(await assertOwnCompleteLeases(retries)).toBe(readyJobs);
 const {receipts:_referenceHints,...referenceProducts}=expected,{receipts:_candidateHints,...candidateProducts}=await exact();expect(candidateProducts).toEqual(referenceProducts);
 await restore();const first=await run('single'),firstProducts=await exact();await restore();const runtime=await runRuntime();
 expect(runtime.progress).toMatchObject({claimed:1,complete:first.progress.complete,deferred:first.progress.deferred,failed:0,releaseDeferred:0});
 expect(runtime.claims.map(claim=>claim.work_key)).toEqual(first.claims.map(claim=>claim.workKey));expect(await exact()).toEqual(firstProducts);
 await noPublicOutput();Object.assign(task.meta,{cacheMixedReceipt:{laboratory:laboratoryReceipt,actualScopes:2,directGroup:group.receipt,
  originalSingletons:aggregate(singles),singletonRecovery:aggregate(retries),runtime:runtime.receipt,progress:runtime.progress}});
}),120_000);
it('keeps a genuine dense ten-fact leaf and seventeen-fact prefix on original singleton runtime admission',async({task})=>additionalFixture('dense',async()=>{
 await restore();expect(await target().prepare("SELECT max(row_count) n FROM analytics_canonical_manifests WHERE content_revision IN(SELECT input_revision FROM analytics_partition_work WHERE stage='cache')").first<number>('n')).toBe(10);
 const first=await run('single'),expected=await exact();await restore();const runtime=await runRuntime();
 expect(runtime.progress).toMatchObject({claimed:1,complete:first.progress.complete,deferred:first.progress.deferred,failed:0,releaseDeferred:0});
 expect(runtime.claims.map(claim=>claim.work_key)).toEqual(first.claims.map(claim=>claim.workKey));expect(await exact()).toEqual(expected);
 const remaining=await drain();expect(runtime.progress.complete+aggregate(remaining).completed).toBe(8);
 expect((await target().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);await noPublicOutput();
 Object.assign(task.meta,{cacheDenseReceipt:{laboratory:laboratoryReceipt,originalFirstSingleton:first.receipt,runtime:runtime.receipt,
  progress:runtime.progress,recovery:aggregate(remaining),leafFacts:10,prefixFacts:17,admittedRows:17,groupFactsLimit:16}});
}),120_000);
