import {env,reset} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import * as nativeKernels from '../src/quota-analysis-v1';
import type {V1PreparedFinishEvidence} from '../src/quota-analysis-v1';
import {CanonicalRollingRefused} from '../src/canonical-rolling-inputs';
import {storageGraphFailureDetail} from '../src/storage-analytics-failure';
import {createCanonicalInputReadContext,closeCanonicalInputReadContext,readCanonicalInputSeal,advanceCanonicalInputWork,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {createV11DeviceFixture,v11UsageRecord} from './helpers/telemetry-v11';
import {readEffectiveTelemetryOwnerDayPage} from '../src/telemetry-usage-effective-reader';
import {telemetryV11LegacyProjection} from '../src/telemetry-v11-compatibility';
import {parseTelemetryV1Chunk} from '../src/telemetry-v1';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {insertTypedTelemetryV1Chunk} from '../src/typed-v1-admission';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {loadV1SourcePin} from '../src/telemetry-v1-source-selection';
import {advanceStorageV1HistoricalAnalysis,advanceStorageV1CurrentFitAnalysis,type StorageV1HistoryCheckpoint} from '../src/storage-v1-history';
import {advanceCanonicalV1Window,executeCanonicalV1WindowRequest} from '../src/storage-canonical-v1-window';
import {canonicalRollingSqlProfile} from './helpers/canonical-rolling-profile';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import {modelHistoryWindow} from '../src/model-history-window';
import {canonicalRollingInputsAvailable,canonicalRollingMethodDigest,retireCanonicalRollingInputs} from '../src/storage-canonical-rolling-inputs';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-rolling-store';
async function setup(){
 await reset();await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 const device=await createV11DeviceFixture(source,{participantId:'synthetic-rolling-v1'});
 const alternate=await createV11DeviceFixture(source,{participantId:device.participantId});
 let index=0;
 for(const day of corpus.populatedDates){
 const selectedDevice=day===corpus.modelFitDates[1]?alternate:device;
 for(const stream of ['quota','usage'] as const){
  const native=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:corpus.owner.ownerDigest,
   ownerRevision:corpus.owner.ownerRevision,authorityEpoch:corpus.owner.authorityEpoch,day,stream,limit:200});
  const records=native.rows.map(row=>JSON.parse(telemetryV11LegacyProjection(stream,JSON.parse(row.recordJson!))!.canonicalRecord));
  if(!records.length)continue;
  if(stream==='usage'){
   // Same logical identity in distinct selected days must keep both events.
   if(corpus.modelFitDates.slice(0,2).includes(day))records[0].eventId='event:v2:'+'c'.repeat(64);
   if(day===corpus.modelFitDates[0])for(let n=0;n<20;n++)records.push({...records[0],
    eventId:'event:v2:'+(9000-n).toString(16).padStart(64,'0'),totalInputContextTokens:0,
    components:{inputUncachedTokens:0,inputCacheReadTokens:0,inputCacheWriteTokens:0,outputTextTokens:0,outputReasoningTokens:0,outputCombinedTokens:null}});
   if(day>corpus.modelFitDates.at(-1)!)records[0].modelId='synthetic-unpriced-model';
  }

  const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:stream+':'+day+':0',chunkRevision:1,
   chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-rolling-v1',
   consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
    privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
  const envelopeDigest=await sha256Hex('synthetic-rolling-'+index),principal=await authenticateDevice(source,selectedDevice.authorization);
  const authorization=await createDeviceUploadAuthorization(source,principal,envelopeDigest,4096);
  const claimed=await claimDeviceUploadAuthorization(source,'Upload '+authorization.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
  await insertTypedTelemetryV1Chunk(source,{chunkRowId:'chunk:synthetic-rolling-'+index,participantId:device.participantId,
   deviceId:selectedDevice.deviceId,chunk,envelopeDigest,deviceUploadAuthorizationId:claimed.authorizationId,r2Key:'synthetic/rolling-'+index++,
   createdAt:new Date().toISOString(),supersedes:null},sourceId);
 }}
 const owner=(await readStorageCommunityOwnerPage(source)).find(row=>row.participantId===device.participantId)!;
 expect(owner.hasV11).toBe(false);
 await target.prepare("INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,'active')")
  .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
 return {corpus,owner,device,pipeline:{target,sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest!}};
}
it('durably prepares selected v1 windows and preserves actual historical and open-ended scalar analyses',async({task})=>{
 const {corpus,owner,pipeline}=await setup(),day=corpus.modelFitDates.at(-1)!,window=modelHistoryWindow(day);
 const pin=await loadV1SourcePin(source,{participantId:owner.participantId,fromDay:window.fromDay,throughDay:day});
 const profile=createAnalyticsProfile();let phase='native';const sqlProfile=canonicalRollingSqlProfile(()=>phase);
 const invocations:Record<string,{count:number;maxStatements:number}>={};
 const statements=(label:string)=>Object.entries(profile.costs).filter(([key])=>key.startsWith(label+'.')).reduce((sum,[,cost])=>sum+cost.statements,0);
 const profiledSource=profileAnalyticsDatabase(sqlProfile.wrap(source,'source'),'source',profile,()=>phase),profiledTarget=profileAnalyticsDatabase(sqlProfile.wrap(target,'target'),'target',profile,()=>phase);
 async function historical(canonical:boolean,label=canonical?'canonical_cold':'native'){let checkpoint:StorageV1HistoryCheckpoint|null=null;phase=label;
  for(let n=0;n<400;n++){const before=statements(label);const result=await advanceStorageV1HistoricalAnalysis({source:profiledSource,participantId:owner.participantId,day,sourcePin:pin,
   budget:{remainingQueries:950,deadlineMs:Date.now()+30_000},checkpoint,maxPages:32,...(canonical?{canonicalPipeline:{...pipeline,target:profiledTarget}}:{})});
   const used=statements(label)-before,prior=invocations[label]??{count:0,maxStatements:0};
   invocations[label]={count:prior.count+1,maxStatements:Math.max(prior.maxStatements,used)};
   expect(used).toBeLessThanOrEqual(950);
   if(result.status==='complete')return result.analysis;checkpoint=result.checkpoint;}
  throw new Error('historical window did not finish');}
 const native=await historical(false);
 expect(native.status).toBe('ready');
 const prepared=await historical(true);
 expect(prepared).toEqual(native);
 expect(profile.measurementFailures).toBe(0);
 expect(await historical(true,'canonical_warm')).toEqual(native);
 Reflect.set(task.meta,'rollingProfile',Object.fromEntries(['native','canonical_cold','canonical_warm'].map(label=>[label,Object.entries(profile.costs).filter(([key])=>key.startsWith(label+'.')).reduce((sum,[,cost])=>({statements:sum.statements+cost.statements,rowsRead:sum.rowsRead+cost.rowsRead,rowsWritten:sum.rowsWritten+cost.rowsWritten}),{statements:0,rowsRead:0,rowsWritten:0})])));
 Reflect.set(task.meta,'rollingSqlProfile',await sqlProfile.report());
 Reflect.set(task.meta,'rollingInvocations',invocations);
 const rows=await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_rows').first<number>('n');
 const historicalIds=(await target.prepare('SELECT native_id FROM analytics_canonical_rolling_rows ORDER BY native_id').all<{native_id:number}>()).results;
 const warm=await advanceCanonicalV1Window({...pipeline,source,pin,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+30_000});
 expect(warm.state).toBe('ready');expect(warm.queriesUsed).toBeLessThan(30);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_rows').first<number>('n')).toBe(rows);
 // Evaluate an earlier date while retaining all later selected days: the native
 // current scalar contract deliberately has no upper bound.
 const scalarDay=corpus.modelFitDates[1]!,scalarWindow=modelHistoryWindow(scalarDay);
 const scalarPin=await loadV1SourcePin(source,{participantId:owner.participantId,fromDay:scalarWindow.fromDay});
 expect(scalarPin.winners.some(row=>row.observed_day>scalarDay)).toBe(true);
 async function scalar(canonical:boolean){let checkpoint:StorageV1HistoryCheckpoint|null=null;
  for(let n=0;n<400;n++){const result=await advanceStorageV1CurrentFitAnalysis({source,participantId:owner.participantId,day:scalarDay,sourcePin:scalarPin,
   budget:{remainingQueries:950,deadlineMs:Date.now()+30_000},checkpoint,maxPages:32,...(canonical?{canonicalPipeline:pipeline}:{})});
   if(result.status==='complete')return result.analysis;checkpoint=result.checkpoint;}
  throw new Error('scalar window did not finish');}
 expect(await scalar(true)).toEqual(await scalar(false));
 expect((await target.prepare('SELECT native_id FROM analytics_canonical_rolling_rows ORDER BY native_id LIMIT ?').bind(rows).all()).results).toEqual(historicalIds);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_rows').first<number>('n')).toBeGreaterThan(rows!);
 const windows=(await target.prepare('SELECT window_key FROM analytics_canonical_rolling_windows').all<{window_key:string}>()).results;
 expect(windows).toHaveLength(2);
 const heldWindow=windows[0]!.window_key;
 const heldSegment=await target.prepare('SELECT segment_key FROM analytics_canonical_rolling_segments ORDER BY segment_key LIMIT 1').first<string>('segment_key');
 for(const [i,key]of ['rolling-window/'+heldWindow,'rolling-segment/'+heldSegment].entries())await target.prepare(`INSERT INTO analytics_partition_work
  (work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,state,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
  VALUES(?,?,?,?,?,?,?,'fits','new','ready',1024,200,0,0,0)`).bind(String(i+1).repeat(64),String(i+3).repeat(64),sourceId,owner.ownerDigest,key,'a'.repeat(64),'b'.repeat(64)).run();
 // Withdrawal invalidates exactly the selected windows even while a reader is
 // held in this isolate. It must never serve the former complete generation.
 await target.prepare(`DELETE FROM analytics_canonical_heads WHERE revision=(SELECT r.fact_revision FROM analytics_canonical_rolling_rows r
  JOIN analytics_canonical_rolling_members m ON m.segment_key=r.segment_key WHERE m.window_key=? LIMIT 1)`).bind(warm.state==='ready'?warm.windowKey:'').run();
 expect(await target.prepare("SELECT count(*) n FROM analytics_canonical_rolling_windows WHERE state='dirty'").first<number>('n')).toBeGreaterThan(0);
 if(warm.state==='ready')await expect(warm.reader.usageReader.readPage(window.observedAtCutoff,0,128,window.observedAtBefore)).rejects.toThrow('window_changed');
 await target.prepare("UPDATE analytics_canonical_rolling_windows SET state='dirty'").run();
 await target.prepare("UPDATE analytics_canonical_rolling_segments SET state='dirty'").run();
 const removableMembers=await target.prepare(`SELECT count(*) n FROM analytics_canonical_rolling_members
  WHERE window_key!=?`).bind(heldWindow).first<number>('n');
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(removableMembers!+1);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_windows').first<number>('n')).toBe(1);
 await retireCanonicalRollingInputs(target,sourceId,128);
 expect(await target.prepare('SELECT window_key FROM analytics_canonical_rolling_windows').first<string>('window_key')).toBe(heldWindow);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_rolling_segments WHERE segment_key=?').bind(heldSegment).first<number>('present')).toBe(1);
 await target.prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
  VALUES(?,?,?,1,1,1,1)`).bind(sourceId,owner.ownerDigest,'e'.repeat(64)).run();
 for(const table of ['analytics_canonical_rolling_rows','analytics_canonical_rolling_segments','analytics_canonical_rolling_windows','analytics_canonical_rolling_members'])
  expect(await target.prepare('SELECT count(*) n FROM '+table).first<number>('n')).toBe(0);
 expect(await canonicalRollingInputsAvailable(target)).toBe(true);
 await target.exec('DROP TRIGGER analytics_canonical_rolling_window_update');
 expect(await canonicalRollingInputsAvailable(target)).toBe(false);
 expect(await advanceCanonicalV1Window({...pipeline,source,pin,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+30_000}))
  .toMatchObject({state:'unavailable',reason:'migration_required'});
},120_000);

it('executes a persisted exact empty request and refuses mismatched ownership or retired metadata',async()=>{
 const {owner,pipeline}=await setup();
 const pin=await loadV1SourcePin(source,{participantId:owner.participantId,fromDay:'2099-01-01',throughDay:'2099-01-01'});
 expect(pin.winners).toEqual([]);
 const prepared=await advanceCanonicalV1Window({...pipeline,source,pin,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+30_000});
 expect(prepared.state).toBe('ready');if(prepared.state!=='ready')throw new Error('empty native scope did not seal');
 const request={...pipeline,source,participantId:owner.participantId,windowKey:prepared.windowKey,maxQueries:950,deadlineMs:Date.now()+30_000};
 expect(await executeCanonicalV1WindowRequest(request)).toMatchObject({state:'complete'});
 expect(await executeCanonicalV1WindowRequest({...request,ownerDigest:'f'.repeat(64)})).toMatchObject({state:'refused',reason:'request_retired'});
 const guard=await source.prepare("SELECT sql FROM sqlite_schema WHERE name='storage_effective_selective_sequence_guard'").first<string>('sql');
 await source.exec('DROP TRIGGER storage_effective_selective_sequence_guard');
 await expect(prepared.reader.assertCurrent()).rejects.toThrow('window_changed');
 await expect(advanceCanonicalV1Window({...pipeline,source,pin,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+30_000}))
  .rejects.toThrow('window_changed');
 await source.prepare(guard!).run();
 await target.prepare("UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE window_key=?").bind(prepared.windowKey).run();
 expect(await executeCanonicalV1WindowRequest(request)).toMatchObject({state:'refused',reason:'request_retired'});
},30_000);


it('expires invocation proofs on source mutations, lost capability and target terminal authority',async()=>{
 const {owner,pipeline}=await setup();
 const scope:CanonicalInputScope={...pipeline,participantId:owner.participantId,day:'2099-01-01',
  stream:'usage',selectionMethod:'legacy-selected-v1'};
 // Only an explicitly covered native empty scope is reusable.
 expect(await createCanonicalInputReadContext(source,target,[scope],Date.now()+30_000)).toBeNull();
 for(let n=0;n<20;n++){
  const progress=await advanceEffectiveDependencyCoverage(source,{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128});
  if(progress.status==='complete')break;
 }
 const create=()=>createCanonicalInputReadContext(source,target,[scope],Date.now()+30_000);
 let context=await create();expect(context).not.toBeNull();
 // The opaque handle contains no subject, source values or selected records.
 expect(JSON.stringify(context)).toBe('{}');
 const meter=createD1InvocationBudget(950);
 // The context is tied to the exact metered handles used to acquire it.
 const wrappedSource=meter.wrap(source),wrappedTarget=meter.wrap(target);
 let meteredContext=await createCanonicalInputReadContext(wrappedSource,wrappedTarget,[scope],Date.now()+30_000);
 expect(meteredContext).not.toBeNull();
 const first=await advanceCanonicalInputWork(source,target,{...scope,context:meteredContext!,
  budget:{meter,maxSteps:1,deadlineMs:Date.now()+30_000,now:Date.now}});
 expect(first).toMatchObject({state:'progress',pages:1,seal:null});
 const guard=await source.prepare("SELECT sql FROM sqlite_schema WHERE name='storage_effective_selective_sequence_guard'").first<string>('sql');
 await source.exec('DROP TRIGGER storage_effective_selective_sequence_guard');
 // Initial proof was complete, but a missing trigger must prevent the later
 // scope promotion even when intermediate generation counters are unchanged.
 expect((await advanceCanonicalInputWork(source,target,{...scope,context:meteredContext!,
  budget:{meter,maxSteps:32,deadlineMs:Date.now()+30_000,now:Date.now}})).state).toBe('unavailable');
 expect(await target.prepare("SELECT state FROM analytics_canonical_input_work WHERE source_day='2099-01-01'").first<string>('state')).toBe('draining');
 expect(await readCanonicalInputSeal(source,target,scope)).toBeNull();
 await source.prepare('UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?').bind(owner.participantId).run();
 expect((await advanceCanonicalInputWork(source,target,{...scope,context:meteredContext!,
  budget:{meter,maxSteps:1,deadlineMs:Date.now()+30_000,now:Date.now}})).state).toBe('unavailable');
 await source.prepare(guard!).run();
 context=await create();
 meteredContext=await createCanonicalInputReadContext(wrappedSource,wrappedTarget,[scope],Date.now()+30_000);
 const prepared=await advanceCanonicalInputWork(source,target,{...scope,context:meteredContext!,
  budget:{meter,maxSteps:32,deadlineMs:Date.now()+30_000,now:Date.now}});
 expect(prepared).toMatchObject({state:'complete',seal:{empty:true,seenCount:0}});
 const native=await readCanonicalInputSeal(source,target,scope);
 expect(await readCanonicalInputSeal(source,target,scope,context!)).toEqual(native);
 closeCanonicalInputReadContext(context!);
 expect(await readCanonicalInputSeal(source,target,scope,context!)).toBeNull();
 const beforeMutation=await create();expect(beforeMutation).not.toBeNull();
 // A source revision change ends a request proof even though a closed empty
 // day's native dependency remains unchanged and can be reused next request.
 await source.prepare('UPDATE community_analytical_input_versions SET revision=revision+1 WHERE participant_id=?').bind(owner.participantId).run();
 expect(await readCanonicalInputSeal(source,target,scope,beforeMutation!)).toBeNull();
 const afterMutation=await create();expect(afterMutation).not.toBeNull();
 expect((await readCanonicalInputSeal(source,target,scope,afterMutation!))?.sourceStamp).toBe(native?.sourceStamp);
 const trigger=await source.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='storage_effective_selective_sequence_guard'").first<string>('sql');
 await source.exec('DROP TRIGGER storage_effective_selective_sequence_guard');
 expect(await readCanonicalInputSeal(source,target,scope,afterMutation!)).toBeNull();
 expect(await create()).toBeNull();
 await source.prepare(trigger!).run();
 const afterRestore=await create();expect(afterRestore).not.toBeNull();
 expect((await readCanonicalInputSeal(source,target,scope,afterRestore!))?.sourceStamp).toBe(native?.sourceStamp);
 const marker=await source.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='typed_v1_analytical_schema'").first<string>('sql');
 await source.exec('DROP TABLE typed_v1_analytical_schema');
 expect(await readCanonicalInputSeal(source,target,scope,afterRestore!)).toBeNull();
 expect(await create()).toBeNull();
 await source.prepare(marker!).run();
 await target.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
  .bind(sourceId,owner.ownerDigest).run();
 expect(await readCanonicalInputSeal(source,target,scope,afterMutation!)).toBeNull();
 expect((await advanceCanonicalInputWork(source,target,{...scope,context:meteredContext!,
  budget:{meter,maxSteps:1,deadlineMs:Date.now()+30_000,now:Date.now}})).state).toBe('unavailable');
 await source.exec('DROP TRIGGER storage_effective_selective_sequence_guard');
 expect(await create()).toBeNull();
 expect((await advanceCanonicalInputWork(source,target,{...scope,context:meteredContext!,
  budget:{meter,maxSteps:1,deadlineMs:Date.now()+30_000,now:Date.now}})).state).toBe('unavailable');
},120_000);


it('keeps a closed warm window after an outside append and rebuilds an elected-day correction',async()=>{
 const {owner,pipeline,corpus,device}=await setup(),day=corpus.modelFitDates[0]!;
 async function upload(selected:typeof device,at:string,label:string,used:number){
  const records=[JSON.parse(telemetryV11LegacyProjection('usage',v11UsageRecord(at,'a',{
   eventId:'event:v2:'+'d'.repeat(64),components:{inputUncachedTokens:used,inputCacheReadTokens:null,
    inputCacheWriteTokens:null,outputTextTokens:1,outputReasoningTokens:null,outputCombinedTokens:null}}))!.canonicalRecord)];
  const chunk=parseTelemetryV1Chunk({schemaVersion:'telemetry-contribution-v1.0',chunkId:'usage:'+at+':0',chunkRevision:1,
   chunkDigest:await sha256Hex(canonicalJson(records)),parserVersion:'synthetic-rolling-change',
   consent:{telemetrySchemaVersion:'telemetry-contribution-v1.0',fieldDictionaryVersion:'telemetry-v1.0-registry-2026-08-07.1',
    privacyContractVersion:'ongoing-privacy-safe-telemetry-v1.0'},records});
  const envelopeDigest=await sha256Hex(label),principal=await authenticateDevice(source,selected.authorization);
  const auth=await createDeviceUploadAuthorization(source,principal,envelopeDigest,4096);
  const claim=await claimDeviceUploadAuthorization(source,'Upload '+auth.uploadAuthorization,{envelopeDigest,bodyBytes:4096,contentType:'application/json'});
  await insertTypedTelemetryV1Chunk(source,{chunkRowId:'chunk:'+label,participantId:owner.participantId,deviceId:selected.deviceId,
   chunk,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId,r2Key:'synthetic/'+label,
   createdAt:new Date(Date.now()+5_000).toISOString(),supersedes:null},sourceId);
 }
 const scope={participantId:owner.participantId,fromDay:day,throughDay:day};
 const pin=await loadV1SourcePin(source,scope);
 async function prepare(current:typeof pin){for(let n=0;n<40;n++){
  const result=await advanceCanonicalV1Window({...pipeline,source,pin:current,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+30_000});
  if(result.state==='ready')return result;
 }throw new Error('changed canonical window did not finish');}
 const first=await prepare(pin);
 const rows=(await target.prepare('SELECT native_id,fact_revision FROM analytics_canonical_rolling_rows ORDER BY native_id').all()).results;
 const outside=new Date(Date.parse(corpus.populatedDates.at(-1)!+'T00:00:00.000Z')+86_400_000).toISOString().slice(0,10);
 await upload(device,outside,'synthetic-rolling-outside',7);
 const outsidePin=await loadV1SourcePin(source,scope);
 expect(outsidePin.fingerprint).toBe(pin.fingerprint);expect(outsidePin.inputRevision).not.toBe(pin.inputRevision);
 const warm=await prepare(outsidePin);expect(warm.windowKey).toBe(first.windowKey);expect(warm.queriesUsed).toBeLessThan(30);
 expect((await target.prepare('SELECT native_id,fact_revision FROM analytics_canonical_rolling_rows ORDER BY native_id').all()).results).toEqual(rows);
 // A newly accepted elected device is a real source replacement. Its sparse
 // evidence must replace the prior day and keep the native whole-kernel result.
 const changed=await createV11DeviceFixture(source,{participantId:owner.participantId});
 await upload(changed,day,'synthetic-rolling-correction',17);
 const changedPin=await loadV1SourcePin(source,scope);expect(changedPin.fingerprint).not.toBe(pin.fingerprint);
 await expect(advanceCanonicalV1Window({...pipeline,source,pin,kind:'legacy-model',maxQueries:950,deadlineMs:Date.now()+30_000}))
  .rejects.toThrow('v1 source changed during analysis');
 const freshOwner=(await readStorageCommunityOwnerPage(source)).find(value=>value.participantId===owner.participantId)!;
 await target.prepare('UPDATE analytics_owner_state SET revision=?,authority_epoch=? WHERE source_id=? AND owner_digest=?')
  .bind(freshOwner.ownerRevision,freshOwner.authorityEpoch,sourceId,owner.ownerDigest).run();
 const rebuilt=await prepare(changedPin);expect(rebuilt.windowKey).not.toBe(first.windowKey);
 const expectedPin=await loadV1SourcePin(source,{participantId:owner.participantId,fromDay:modelHistoryWindow(day).fromDay,throughDay:day});
 async function analysis(canonical:boolean){let checkpoint:StorageV1HistoryCheckpoint|null=null;
  for(let n=0;n<80;n++){
   const result=await advanceStorageV1HistoricalAnalysis({source,participantId:owner.participantId,day,sourcePin:expectedPin,
    budget:{remainingQueries:950,deadlineMs:Date.now()+30_000},checkpoint,maxPages:32,...(canonical?{canonicalPipeline:pipeline}:{})});
   if(result.status==='complete')return result.analysis;checkpoint=result.checkpoint;
  }throw new Error('corrected native analysis did not finish');}
 expect(await analysis(true)).toEqual(await analysis(false));
},120_000);


for(const kind of ['historical','scalar'] as const)it(`refuses the ${kind} consumer candidate when its final canonical fence changes`,async({task})=>{
 const {owner,pipeline,corpus}=await setup(),day=corpus.modelFitDates.at(-1)!,window=modelHistoryWindow(day);
 const pin=await loadV1SourcePin(source,{participantId:owner.participantId,fromDay:window.fromDay,
  ...(kind==='historical'?{throughDay:day}:{})});
 const consume=kind==='historical'?advanceStorageV1HistoricalAnalysis:advanceStorageV1CurrentFitAnalysis;
 let activeMeter=createD1InvocationBudget(950),maxStatements=0;
 async function invoke(canonical:boolean,checkpoint:StorageV1HistoryCheckpoint|null){
  activeMeter=createD1InvocationBudget(950);
  try{return await consume({source:activeMeter.wrap(source),participantId:owner.participantId,day,sourcePin:pin,
   budget:{remainingQueries:950,deadlineMs:Date.now()+30_000},checkpoint,maxPages:32,
   ...(canonical?{canonicalPipeline:{...pipeline,target:activeMeter.wrap(target)}}:{})});}
  finally{maxStatements=Math.max(maxStatements,activeMeter.queriesUsed);expect(activeMeter.queriesUsed).toBeLessThanOrEqual(950);}
 }
 let reference:Awaited<ReturnType<typeof consume>>|null=null,nativeCheckpoint:StorageV1HistoryCheckpoint|null=null;
 for(let n=0;n<20;n++){
  const result=await invoke(false,nativeCheckpoint);
  if(result.status==='complete'){reference=result;break;}
  nativeCheckpoint=result.checkpoint;
 }
 if(reference?.status!=='complete')throw new Error('native final-fence oracle did not complete');
 let checkpoint:StorageV1HistoryCheckpoint|null=null;
 for(let n=0;n<80&&checkpoint?.phase!=='finish';n++){
  const result=await invoke(true,checkpoint);
  if(result.status!=='deferred')throw new Error('expected real native acquisition before the final calculation');
  checkpoint=result.checkpoint;
 }
 if(checkpoint?.phase!=='finish'||!checkpoint.layout.startsWith('canonical:'))throw new Error('canonical finish checkpoint unavailable');
 const savedCheckpoint=structuredClone(checkpoint),windowKey=checkpoint.layout.slice('canonical:'.length);
 let candidate:object|null=null,usageReads=0,injected=false;
 const track=(evidence:V1PreparedFinishEvidence):V1PreparedFinishEvidence=>({...evidence,
  usageReader:{...evidence.usageReader,async readPage(...args){usageReads++;return evidence.usageReader.readPage(...args);}},
  usageBins:{...evidence.usageBins,async readPage(...args){usageReads++;return evidence.usageBins.readPage(...args);}}});
 const trigger=kind==='historical'?await source.prepare("SELECT sql FROM sqlite_schema WHERE name='storage_effective_selective_sequence_guard'")
  .first<string>('sql'):null;
 const inject=async(value:object)=>{
  // This is the actual native candidate, calculated through real persisted
  // quota/usage pages. Mutate at the final kernel return boundary so page
  // guards cannot hide a missing consumer final fence.
  candidate=value;expect(candidate).toEqual(reference!.status==='complete'?reference!.analysis:null);
  expect(usageReads).toBeGreaterThan(0);expect(injected).toBe(false);injected=true;
  if(kind==='historical')await activeMeter.wrap(source).prepare('DROP TRIGGER storage_effective_selective_sequence_guard').run();
  else{
   const removed=await activeMeter.wrap(target).prepare(`DELETE FROM analytics_canonical_heads WHERE revision=(
    SELECT r.fact_revision FROM analytics_canonical_rolling_rows r JOIN analytics_canonical_rolling_members m
     ON m.segment_key=r.segment_key WHERE m.window_key=? LIMIT 1) RETURNING occurrence_key`).bind(windowKey).first();
   expect(removed).not.toBeNull();
   expect(await activeMeter.wrap(target).prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=?')
    .bind(windowKey).first<string>('state')).toBe('dirty');
  }
 };
 let restore:()=>void;
 if(kind==='historical'){
  const original=nativeKernels.finishHistoricalModelCompositionV1;
  const spy=vi.spyOn(nativeKernels,'finishHistoricalModelCompositionV1').mockImplementation(async(...args)=>{
   const evidence=args[5].preparedEvidence;if(!evidence)throw new Error('canonical native evidence missing');
   const result=await original(args[0],args[1],args[2],args[3],args[4],
    {...args[5],preparedEvidence:track(evidence)});
   if(result.status==='complete')await inject(result.analysis);
   return result;
  });restore=()=>spy.mockRestore();
 }else{
  const original=nativeKernels.advanceV1UsageReduction;
  const spy=vi.spyOn(nativeKernels,'advanceV1UsageReduction').mockImplementation(async(...args)=>{
   const evidence=args[4].preparedEvidence;if(!evidence)throw new Error('canonical native evidence missing');
   const result=await original(args[0],args[1],args[2],args[3],{...args[4],preparedEvidence:track(evidence)},args[5],args[6]);
   if(result.status==='complete')await inject(result.analysis);
   return result;
  });restore=()=>spy.mockRestore();
 }
 try{
  const attempt=invoke(true,checkpoint);
  if(kind==='historical')await expect(attempt).rejects.toMatchObject({reason:'window_changed'});
  else await expect(attempt).rejects.toMatchObject({message:'STORAGE_GRAPH_OPERATION_UNAVAILABLE',stage:'graph_current_fit_compute',
   reason:'application',detail:storageGraphFailureDetail(new CanonicalRollingRefused('window_changed'))});
  expect(injected).toBe(true);expect(candidate).not.toBeNull();expect(checkpoint).toEqual(savedCheckpoint);
  Reflect.set(task.meta,'canonicalFinalFence',{kind,nativeStatus:Reflect.get(candidate!,'status'),usageReads,maxStatements});
 }finally{
  restore();
  if(trigger&&injected)await source.prepare(trigger).run();
 }
},120_000);


it('retires sealed-stamp supersession in bounded child pages while preserving live and current rolling inputs',async()=>{
 const {owner}=await setup(),digest=(n:number)=>n.toString(16).padStart(64,'0');
 const oldStamp='a'.repeat(64),currentStamp='b'.repeat(64),method=await canonicalRollingMethodDigest();
 const emptyScope=digest(700),rowScope=digest(701),buildingScope=digest(702),oldWindow=digest(900),currentWindow=digest(901);
 const oldRowSegment=digest(500),currentSegment=digest(501),buildingSegment=digest(502),day='2099-01-01',fromMs=Date.parse(day);
 const nativePayload=canonicalJson({synthetic:'retirement-only'}),payloadDigest=await sha256Hex(nativePayload);
 // The old row segment has more than one page of structurally valid canonical
 // references. Heads stay fixed throughout the stamp replacement below.
 for(let offset=0;offset<129;offset+=16){
  const facts:D1PreparedStatement[]=[],heads:D1PreparedStatement[]=[];
  for(let n=offset;n<Math.min(offset+16,129);n++){
   const revision=digest(2000+n),occurrence=digest(3000+n),partition='legacy-selected-v1/usage/'+day+'/synthetic';
   facts.push(target.prepare(`INSERT INTO analytics_canonical_facts
    (revision,occurrence_key,source_id,owner_digest,erasure_key,stream,selection_method,status,partition_key,
     observed_day,observed_at_ms,order_scope_key,native_order,provenance_digest,coverage,reported_fields,
     conflicted_fields,account_basis,plan_basis,native_source_family,native_logical_occurrence_key,
     native_occurrence_tie_order,boundary_flags_presence,tie_order_presence,
     cache_write_five_minute_tokens_presence,cache_write_one_hour_tokens_presence)
    VALUES(?,?,?,?,?,'usage','legacy-selected-v1','compatible',?,?,?,?,?,?,'complete',0,0,
     'unknown','unknown','v1',?,?,'unknown','unknown','unknown','unknown')`)
    .bind(revision,occurrence,sourceId,owner.ownerDigest,digest(6000),partition,day,fromMs+n*1000,
     digest(6001),n,digest(6002),digest(4000+n),n));
   heads.push(target.prepare(`INSERT INTO analytics_canonical_heads
    (occurrence_key,selection_method,revision,partition_key) VALUES(?,'legacy-selected-v1',?,?)`)
    .bind(occurrence,revision,partition));
  }
  await target.batch(facts);await target.batch(heads);
 }
 for(const [scope,count] of [[emptyScope,0],[rowScope,129],[buildingScope,0]] as const)
  await target.prepare(`INSERT INTO analytics_canonical_input_work
   (scope_key,source_id,owner_digest,selection_method,stream,source_day,source_stamp,owner_revision,
    authority_epoch,state,seen_count) VALUES(?,?,?,'legacy-selected-v1','usage',?,?,?,?,'sealed',?)`)
   .bind(scope,sourceId,owner.ownerDigest,day,oldStamp,owner.ownerRevision,owner.authorityEpoch,count).run();
 const segment=(key:string,scope:string,state:'building'|'complete',stamp=oldStamp)=>target.prepare(`INSERT INTO analytics_canonical_rolling_segments
  (segment_key,source_id,owner_digest,scope_key,source_stamp,selection_method,day,stream,method_digest,state)
  VALUES(?,?,?,?,?,'legacy-selected-v1',?,'usage',?,?)`)
  .bind(key,sourceId,owner.ownerDigest,scope,stamp,day,method,state);
 await segment(oldRowSegment,rowScope,'building').run();
 for(let offset=0;offset<129;offset+=16){
  const writes:D1PreparedStatement[]=[];
  for(let n=offset;n<Math.min(offset+16,129);n++)writes.push(target.prepare(`INSERT INTO analytics_canonical_rolling_rows
   (segment_key,fact_revision,observed_ms,native_order,payload,payload_digest) VALUES(?,?,?,?,?,?)`)
   .bind(oldRowSegment,digest(2000+n),fromMs+n*1000,n,nativePayload,payloadDigest));
  await target.batch(writes);
 }
 await target.prepare("UPDATE analytics_canonical_rolling_segments SET row_count=129,state='complete' WHERE segment_key=?")
  .bind(oldRowSegment).run();
 for(let offset=0;offset<129;offset+=16){
  const writes:D1PreparedStatement[]=[];
  for(let n=offset;n<Math.min(offset+16,129);n++)writes.push(segment(digest(1+n),emptyScope,'complete'));
  await target.batch(writes);
 }
 const window=(key:string,count:number)=>target.prepare(`INSERT INTO analytics_canonical_rolling_windows
  (window_key,source_id,owner_digest,kind,from_ms,through_ms,native_dependency,method_digest,state,member_count)
  VALUES(?,?,?,'legacy-scalar',?,NULL,?,?,'building',?)`)
  .bind(key,sourceId,owner.ownerDigest,fromMs,digest(902),method,count);
 await window(oldWindow,129).run();
 for(let offset=0;offset<129;offset+=16){
  const writes:D1PreparedStatement[]=[];
  for(let n=offset;n<Math.min(offset+16,129);n++)writes.push(target.prepare(`INSERT INTO analytics_canonical_rolling_members(window_key,segment_key) VALUES(?,?)`)
   .bind(oldWindow,digest(1+n)));
  await target.batch(writes);
 }
 await target.prepare("UPDATE analytics_canonical_rolling_windows SET state='complete' WHERE window_key=?").bind(oldWindow).run();
 // No canonical head changes: the new sealed source stamp alone supersedes the old frames.
 await target.prepare('UPDATE analytics_canonical_input_work SET source_stamp=?,seen_count=0 WHERE scope_key=?')
  .bind(currentStamp,emptyScope).run();
 await target.prepare('UPDATE analytics_canonical_input_work SET source_stamp=? WHERE scope_key=?')
  .bind(currentStamp,rowScope).run();
 await segment(currentSegment,emptyScope,'complete',currentStamp).run();
 await segment(buildingSegment,buildingScope,'complete').run();
 await target.prepare("UPDATE analytics_canonical_input_work SET state='reading',source_stamp=? WHERE scope_key=?")
  .bind(currentStamp,buildingScope).run();
 await window(currentWindow,1).run();
 await target.prepare('INSERT INTO analytics_canonical_rolling_members(window_key,segment_key) VALUES(?,?)')
  .bind(currentWindow,currentSegment).run();
 await target.prepare("UPDATE analytics_canonical_rolling_windows SET state='complete' WHERE window_key=?")
  .bind(currentWindow).run();
 const headsBefore=await target.prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n');
 const liveWork=digest(8000);
 await target.prepare(`INSERT INTO analytics_partition_work
  (work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,state,
   resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
  VALUES(?,?,?,?,?,?,?,'fits','new','ready',1024,200,0,0,0)`)
  .bind(liveWork,digest(8001),sourceId,owner.ownerDigest,'graph/fits/'+owner.ownerDigest,
   digest(8002),digest(8003)).run();
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_members WHERE window_key=?')
  .bind(oldWindow).first<number>('n')).toBe(129);
 await target.prepare('DELETE FROM analytics_partition_work WHERE work_key=?').bind(liveWork).run();
 const checkpoint=digest(8100),generation=digest(8101);
 await target.prepare(`INSERT INTO analytics_history_checkpoint_stages
  (key_digest,generation,source_id,owner_digest,day,dependency_digest,source_namespace,method,expected_head,
   owner_revision,authority_epoch,control_json,manifest_json,part_count)
  VALUES(?,?,?,?,?,?,?,?,NULL,?,?,'{}','[]',0)`)
  .bind(checkpoint,generation,sourceId,owner.ownerDigest,day,digest(8102),sourceId,'synthetic-retirement',
   owner.ownerRevision,owner.authorityEpoch).run();
 await target.prepare('INSERT INTO analytics_history_checkpoint_heads(key_digest,generation,retired) VALUES(?,?,0)')
  .bind(checkpoint,generation).run();
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(0);
 await target.prepare('UPDATE analytics_history_checkpoint_heads SET retired=1 WHERE key_digest=?')
  .bind(checkpoint).run();
 for(const [n,key] of [[8200,'rolling-window/'+oldWindow],[8201,'rolling-segment/'+oldRowSegment]] as const)
  await target.prepare(`INSERT INTO analytics_partition_work
   (work_key,head_key,source_id,partition_key,input_revision,policy_revision,stage,lane,state,
    resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
   VALUES(?,?,?,?,?,?,'fits','new','ready',1024,200,0,0,0)`)
   .bind(digest(n),digest(n+10),sourceId,key,digest(8202),digest(8203)).run();
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(0);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_members WHERE window_key=?')
  .bind(oldWindow).first<number>('n')).toBe(129);
 await target.prepare('DELETE FROM analytics_partition_work WHERE work_key IN (?,?)')
  .bind(digest(8200),digest(8201)).run();
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(258);
 expect(await target.prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=?')
  .bind(oldWindow).first<string>('state')).toBe('dirty');
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_members WHERE window_key=?')
  .bind(oldWindow).first<number>('n')).toBe(1);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_rows WHERE segment_key=?')
  .bind(oldRowSegment).first<number>('n')).toBe(1);
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(2);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_rolling_windows WHERE window_key=?')
  .bind(oldWindow).first<number>('present')).toBeNull();
 expect(await retireCanonicalRollingInputs(target,sourceId,1)).toBe(2);
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_rolling_rows WHERE segment_key=?')
  .bind(oldRowSegment).first<number>('n')).toBe(0);
 for(let n=0;n<4;n++)await retireCanonicalRollingInputs(target,sourceId,128);
 expect(await target.prepare('SELECT 1 present FROM analytics_canonical_rolling_segments WHERE segment_key=?')
  .bind(oldRowSegment).first<number>('present')).toBeNull();
 expect(await target.prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=?')
  .bind(currentWindow).first<string>('state')).toBe('complete');
 expect(await target.prepare('SELECT state FROM analytics_canonical_rolling_segments WHERE segment_key=?')
  .bind(currentSegment).first<string>('state')).toBe('complete');
 expect(await target.prepare('SELECT state FROM analytics_canonical_rolling_segments WHERE segment_key=?')
  .bind(buildingSegment).first<string>('state')).toBe('complete');
 expect(await target.prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(headsBefore);
},120_000);
