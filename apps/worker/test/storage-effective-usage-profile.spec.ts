import {applyD1Migrations,env,reset,type D1Migration} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {
 canonicalTelemetryV12Json,telemetryV12DayManifestDigestInput,telemetryV12DomainManifestDigestInput,
 telemetryV12RequiredConsent,type TelemetryV12Chunk,type TelemetryV12DayManifest,
 type TelemetryV12Record,type TelemetryV12QuotaObservation,type TelemetryV12UsageEvent,
} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture} from './helpers/telemetry-v11';
import {MODEL_HISTORY_TEST_CAPACITIES,pricedModelHistoryUsage} from './helpers/model-history';
import {authenticateDevice,claimDeviceUploadAuthorization,createDeviceUploadAuthorization} from '../src/device-auth';
import {grantTelemetryV12Consent} from '../src/telemetry-transport-policy';
import {registerTelemetryV12DayManifest,persistTelemetryV12StagedChunk} from '../src/telemetry-v12-repository';
import {activateTelemetryV12Domain,createTelemetryV12DomainPredecessor} from '../src/telemetry-v12-domain';
import {initializeStorageSource} from '../src/analytics-delivery';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {initializeTypedV11Admission} from '../src/typed-v11-admission';
import {drainCommunityPublicSourceBootstrap} from '../src/community-daily-aggregates';
import {initializeStorageAnalyticsRuntime} from '../src/storage-analytics-runtime';
import {readStorageCommunityOwnerPage} from '../src/storage-community-authority';
import {readEffectiveTelemetryOwnerDayPage,type EffectiveUsageReaderCursor} from '../src/telemetry-usage-effective-reader';
import {captureStorageGraphScope,computeStorageGraphResult,type StorageGraphScope} from '../src/storage-community-graph';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {sha256Hex} from '../src/crypto';
import {canonicalJson} from '../src/canonical-json';

const bindings=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_MIGRATIONS:D1Migration[];
 TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const source=()=>bindings.USAGE_MONITOR_DB,target=()=>bindings.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-effective-usage-profile',sourceNamespace='synthetic-effective-usage-profile';
const firstDay='2026-09-01',modelDay='2026-09-05',adjacentDay='2026-09-06';
const baseMs=Date.parse(`${firstDay}T00:00:00.000Z`),hour=3_600_000;
const at=(hours:number)=>new Date(baseMs+hours*hour).toISOString();
const dayOf=(time:string)=>time.slice(0,10);
const accountTrackId=`account-track:v2:${'f'.repeat(64)}`;
const extraUsage=Number((import.meta as ImportMeta & {env?:{VITE_EFFECTIVE_USAGE_PROFILE_RECORDS?:string}})
 .env?.VITE_EFFECTIVE_USAGE_PROFILE_RECORDS??1_200);
type Device=Awaited<ReturnType<typeof createV11DeviceFixture>>;
type V12Uploaded=Awaited<ReturnType<typeof registerTelemetryV12DayManifest>>;

beforeEach(async()=>{
 await reset();
 for(const migrations of [bindings.TEST_MIGRATIONS,bindings.TEST_TYPED_INGESTION_MIGRATIONS,
  bindings.TEST_INGESTION_BRIDGE_MIGRATIONS,bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
  bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS])await applyD1Migrations(source(),migrations);
 await initializeStorageSource(source(),sourceId);
 await initializeTypedV1Admission(source(),sourceNamespace);
 await initializeTypedV11Admission(source(),sourceNamespace);
 await applyD1Migrations(source(),bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
 await applyD1Migrations(target(),bindings.TEST_ANALYTICS_MIGRATIONS);
 expect((await drainCommunityPublicSourceBootstrap(source())).completed).toBe(true);
 await initializeStorageAnalyticsRuntime({source:source(),target:target(),sourceId,sourceNamespace});
 await source().prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
});

function accountAttribution(){return {accountBasis:'same_source' as const,accountTrackId,
 planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null};}

function usageRecord(index:number,time:string,modelId:string,costUsd:number,sessionUuid:string):TelemetryV12UsageEvent{
 const priced=pricedModelHistoryUsage(modelId,costUsd,time);
 const value=JSON.parse(priced.record.recordJson!) as Pick<TelemetryV12UsageEvent,'components'|'totalInputContextTokens'>;
 return {schemaVersion:'usage-event-v1.2',eventId:`event:v2:${(index+1).toString(16).padStart(64,'0')}`,
  eventTime:time,sessionUuid,provider:'openai_codex',modelId,speedMode:'standard',apiServiceTier:'default',
  surface:'local_interactive_unclassified',billingSurface:'chatgpt_subscription',reasoningEffort:'high',
  agentScope:'root',outcome:'completed',totalInputContextTokens:value.totalInputContextTokens,
  components:value.components,accountPlanAttribution:accountAttribution(),boundaryFlags:null,tieOrder:null,cacheWriteTtl:null};
}

function quotaRecord(index:number,time:string,usedPercent:number):TelemetryV12QuotaObservation{
 return {schemaVersion:'quota-observation-v1.2',observationId:`quota-occurrence:v1:${(index+1).toString(16).padStart(64,'0')}`,
  observedTime:time,provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',
  slot:'seven_day',usedPercent,windowDurationMinutes:10_080,resetsAt:at(168),
  accountPlanAttribution:accountAttribution()};
}

async function prepareOwner(device:Device){
 const ownerDigest='a'.repeat(64);
 await source().prepare(`INSERT INTO storage_v11_owner_links
  (participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,?,?,?)`)
  .bind(device.participantId,ownerDigest,'active',ownerDigest,ownerDigest).run();
 await source().prepare(`INSERT INTO storage_owner_revisions
  (owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?)`)
  .bind(ownerDigest,1,1,'active').run();
}

async function stageDay(device:Device,day:string,records:readonly TelemetryV12Record[],revision=1):Promise<V12Uploaded>{
 const consent=telemetryV12RequiredConsent(),parserVersion=revision===1
  ?'synthetic-effective-usage-profile':`synthetic-effective-usage-profile-${revision}`;
 const chunks:TelemetryV12Chunk[]=[];
 for(const stream of ['quota','usage'] as const){
  const selected=records.filter(record=>record.schemaVersion.startsWith(`${stream}-`));
  for(let offset=0;offset<selected.length;offset+=200){
   const chunkRecords=selected.slice(offset,offset+200);
   chunks.push({schemaVersion:'telemetry-contribution-v1.2',manifestDigest:'0'.repeat(64),
    chunkId:`${stream}:${day}:${offset/200}`,chunkRevision:1,parserVersion,consent,records:chunkRecords,
    chunkDigest:await sha256Hex(canonicalTelemetryV12Json(chunkRecords))});
  }
 }
 const manifest:TelemetryV12DayManifest={schemaVersion:'telemetry-day-manifest-v1.2',day,parserVersion,consent,
  chunks:chunks.map(chunk=>({chunkId:chunk.chunkId,chunkDigest:chunk.chunkDigest,recordCount:chunk.records.length})),
  excluded:{quota:0,session:0,usage:0},manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
 await registerTelemetryV12DayManifest(source(),device,manifest);
 for(const chunk of chunks){
  chunk.manifestDigest=manifest.manifestDigest;
  const principal=await authenticateDevice(source(),device.authorization);
  const envelopeDigest=await sha256Hex(`synthetic-profile:${crypto.randomUUID()}`);
  const upload=await createDeviceUploadAuthorization(source(),principal,envelopeDigest,4096);
  const claimed=await claimDeviceUploadAuthorization(source(),`Upload ${upload.uploadAuthorization}`,
   {envelopeDigest,bodyBytes:4096,contentType:'application/json'});
  await persistTelemetryV12StagedChunk(source(),device,chunk,{chunkRowId:`chunk:${crypto.randomUUID()}`,
   r2Key:`synthetic/effective-usage-profile/${crypto.randomUUID()}`,envelopeDigest,
   deviceUploadAuthorizationId:claimed.authorizationId});
 }
 return registerTelemetryV12DayManifest(source(),device,manifest);
}

async function activate(device:Device,candidates:readonly V12Uploaded[]){
 const predecessor=await createTelemetryV12DomainPredecessor(source(),device,Date.now());
 const ordered=[...candidates].sort((left,right)=>left.day.localeCompare(right.day));
 const manifest={schemaVersion:'telemetry-domain-manifest-v1.2' as const,fromDay:ordered[0]!.day,
  throughDay:ordered.at(-1)!.day,predecessor:{token:predecessor.token,
   previousGenerationId:predecessor.previousGenerationId,legacyFingerprint:predecessor.legacyFingerprint},
  days:ordered.map(row=>({day:row.day,manifestId:row.manifestId,manifestDigest:row.manifestDigest})),
  manifestDigest:'0'.repeat(64)};
 manifest.manifestDigest=await sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
 await activateTelemetryV12Domain(source(),device,manifest,Date.now());
}

async function denseV12Owner(extraUsage=1_200){
 const device=await createV11DeviceFixture(source());
 await grantTelemetryV12Consent(source(),device,telemetryV12RequiredConsent());
 await prepareOwner(device);
 const grouped=new Map<string,TelemetryV12Record[]>();
 const add=(record:TelemetryV12Record,time:string)=>{const day=dayOf(time),rows=grouped.get(day)??[];
  rows.push(record);grouped.set(day,rows);};
 let usedPercent=0,usageIndex=0,quotaIndex=0;
 add(quotaRecord(quotaIndex++,at(0),0),at(0));
 for(let bin=0;bin<60;bin++){
  const time=at(bin*2+0.5);
  for(const [index,[model,capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()){
   const cost=(5+((bin*7+index*11)%17)/4)*((bin+index)%3===0?0.2:1);
   const priced=pricedModelHistoryUsage(model,cost,time);
   add(usageRecord(usageIndex++,time,model,cost,'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b'),time);
   usedPercent+=priced.costUsd*100/capacity;
  }
  const quotaTime=at(bin*2+1);
  add(quotaRecord(quotaIndex++,quotaTime,usedPercent),quotaTime);
 }
 expect(usedPercent).toBeLessThan(100);
 // One session crosses a UTC day boundary. The extra records make each
 // source day span several 200-occurrence pages without inventing identities.
 const crossingSession='17539c1b-61da-4d9d-8b1f-6e464470d88b';
 const crossings=[] as TelemetryV12UsageEvent[];
 for(const time of ['2026-09-02T23:59:00.000Z','2026-09-03T00:01:00.000Z']){
  const record=usageRecord(usageIndex++,time,'gpt-5.6-sol',0.0001,crossingSession);
  crossings.push(record);add(record,time);
 }
 for(let index=0;index<extraUsage;index++){
  const time=new Date(baseMs+(index+0.5)*5*24*hour/extraUsage).toISOString();
  const model=index%2===0?'gpt-5.6-sol':'gpt-5.6-terra';
  add(usageRecord(usageIndex++,time,model,0.0001,
   index%17===0?crossingSession:'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b'),time);
 }
 const staged:V12Uploaded[]=[];
 for(const [day,records] of [...grouped].sort(([a],[b])=>a.localeCompare(b)))
  staged.push(await stageDay(device,day,records));
 await activate(device,staged);
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 expect(owner).toMatchObject({hasV12:true,hasEffective:true});
 // The synthetic source owner link is prepared directly above. Mirror that
 // exact authority in the derived target, as the ordinary journal does.
 await target().prepare(`INSERT INTO analytics_owner_state
  (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
  .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch,'active').run();
 expect(await target().prepare(`SELECT state FROM analytics_owner_state WHERE source_id=? AND owner_digest=?`)
  .bind(sourceId,owner.ownerDigest).first<string>('state')).toBe('active');
 for(const crossing of crossings){
  let after:EffectiveUsageReaderCursor|undefined,matched=false;
  for(let pageNumber=0;pageNumber<20;pageNumber++){
   const page=await readEffectiveTelemetryOwnerDayPage(source(),{sourceNamespace,ownerDigest:owner.ownerDigest!,
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day:dayOf(crossing.eventTime),
    stream:'usage',limit:200,...(after?{after}:{})});
   const row=page.rows.find(value=>value.occurrenceId===crossing.eventId);
   if(row){
    expect(row.status).toBe('compatible');
    const value=JSON.parse(row.recordJson!) as TelemetryV12UsageEvent;
    expect(value.sessionUuid).toBe(crossingSession);
    expect(value.accountPlanAttribution).toEqual(accountAttribution());
    matched=true;break;
   }
   if(!page.next)break;
   after=page.next;
  }
  expect(matched).toBe(true);
 }
 return {device,staged,records:grouped,owner,usageRecords:usageIndex,quotaRecords:quotaIndex,days:grouped.size};
}

type Family='dependency_links'|'v12_usage'|'v12_quota'|'v12_other'|'typed_usage'|'typed_quota'|'typed_other'
 |'correction'|'checkpoint'|'day_cache'|'graph_result'|'owner_fence'|'other';
type Phase='scope'|'compute';
type FamilyCost={statements:number;rowsRead:number;dbDurationMs:number;wallMs:number;metaSamples:number};
type Profile={families:Record<string,FamilyCost>;checkpointPartInserts:number;checkpointPayloadBytes:number;
 usagePageQueries:number;dayCacheWrites:number;
 scopeMs:number;computeMs:number;invocations:number;maxStatementsPerInvocation:number};
function family(sql:string,bound:readonly unknown[]):Family{
 const usage=bound.includes('usage')||sql.includes("stream='usage'")||sql.includes('stream = 1');
 const quota=bound.includes('quota')||sql.includes("stream='quota'")||sql.includes('stream = 2');
 if(sql.includes('analytics_history_checkpoint'))return 'checkpoint';
 if(sql.includes('analytics_graph_day_'))return 'day_cache';
 if(sql.includes('analytics_community_graph_results'))return 'graph_result';
 if(sql.includes('selected(occurrence_id)'))return 'dependency_links';
 if(sql.includes('telemetry_v12_records')||sql.includes('telemetry_v12_chunks'))
  return usage?'v12_usage':quota?'v12_quota':'v12_other';
 if(sql.includes('typed_telemetry_records'))return usage?'typed_usage':quota?'typed_quota':'typed_other';
 if(sql.includes('telemetry_usage_correction'))return 'correction';
 if(sql.includes('storage_owner_revisions')||sql.includes('storage_v11_owner_links')
  ||sql.includes('analytics_owner_state'))return 'owner_fence';
 return 'other';
}
function profiledDatabase(database:D1Database,side:'source'|'target',profile:Profile,phase:()=>Phase):D1Database{
 const originals=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string;bound:unknown[]}>();
 const record=(sql:string,bound:unknown[],result:unknown,elapsed:number)=>{
  const key=`${phase()}.${side}.${family(sql,bound)}`;
  const cost=profile.families[key]??={statements:0,rowsRead:0,dbDurationMs:0,wallMs:0,metaSamples:0};
  cost.statements++;cost.wallMs+=elapsed;
  const meta=(result as {meta?:{rows_read?:number;duration?:number}}|null)?.meta;
  if(meta){cost.metaSamples++;if(Number.isFinite(meta.rows_read))cost.rowsRead+=meta.rows_read!;
   if(Number.isFinite(meta.duration))cost.dbDurationMs+=meta.duration!;}
  if(sql.includes('INSERT INTO analytics_history_checkpoint_parts')){
   profile.checkpointPartInserts++;
   if(typeof bound[4]==='number')profile.checkpointPayloadBytes+=bound[4];
  }
  if(sql.includes('SELECT occurrence_id,observed_at_ms FROM grouped')&&sql.includes('selected_window')
   &&sql.includes("chunk.stream='usage'"))profile.usagePageQueries++;
  if(sql.includes('INSERT INTO analytics_graph_day_values'))profile.dayCacheWrites++;
 };
 const wrap=(statement:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>{
  const proxy=new Proxy(statement,{get(inner,property){
   if(property==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql,values);
   if(['first','all','run','raw'].includes(String(property)))return async(...args:unknown[])=>{
    const started=performance.now();
    const method=Reflect.get(inner,property) as (...values:unknown[])=>Promise<unknown>;
    const result=await Reflect.apply(method,inner,args);record(sql,bound,result,performance.now()-started);return result;
   };
   const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
  }});
  originals.set(proxy,{original:statement,sql,bound});return proxy;
 };
 return new Proxy(database,{get(inner,property){
  if(property==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
  if(property==='batch')return async(statements:D1PreparedStatement[])=>{
   const prepared=statements.map(statement=>originals.get(statement));
   if(prepared.some(value=>!value))throw new Error('unprofiled batch statement');
   const started=performance.now();
   const results=await inner.batch(prepared.map(value=>value!.original));
   const elapsed=(performance.now()-started)/statements.length;
   for(let index=0;index<results.length;index++)record(prepared[index]!.sql,prepared[index]!.bound,results[index],elapsed);
   return results;
  };
  const value:unknown=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value;
 }});
}

async function measuredModel(day:string,preparedEffectiveUsage:boolean):Promise<{result:Extract<Awaited<ReturnType<typeof computeStorageGraphResult>>,{state:'complete'}>;
 profile:Profile;digest:string}>{
 const profile:Profile={families:{},checkpointPartInserts:0,checkpointPayloadBytes:0,
  usagePageQueries:0,dayCacheWrites:0,
  scopeMs:0,computeMs:0,invocations:0,maxStatementsPerInvocation:0};
 let phase:Phase='scope';
 const observedSource=profiledDatabase(source(),'source',profile,()=>phase);
 const observedTarget=profiledDatabase(target(),'target',profile,()=>phase);
 for(let invocation=0;invocation<30;invocation++){
  const meter=createD1InvocationBudget(950);
  const meteredSource=meter.wrap(observedSource),meteredTarget=meter.wrap(observedTarget);
  const owner=(await readStorageCommunityOwnerPage(meteredSource))[0]!;
  phase='scope';const scopeStart=performance.now();
  const scope:StorageGraphScope=await captureStorageGraphScope(meteredSource,
   {owner,day,metric:'model',sourceId,sourceNamespace,preparedFold:true});
  profile.scopeMs+=performance.now()-scopeStart;
  expect(scope.source).toBe('effective');
  phase='compute';const computeStart=performance.now();
  const result=await computeStorageGraphResult({source:meteredSource,target:meteredTarget,sourceId,sourceNamespace},
   scope,{maxQueries:meter.remainingQueries,deadlineMs:Date.now()+60_000,preparedFold:true,preparedEffectiveUsage});
  profile.computeMs+=performance.now()-computeStart;
  profile.invocations++;profile.maxStatementsPerInvocation=Math.max(profile.maxStatementsPerInvocation,meter.queriesUsed);
  expect(meter.queriesUsed).toBeLessThanOrEqual(950);
  if(result.state==='complete')return {result,profile,digest:await sha256Hex(canonicalJson(result.result))};
  expect(result.reason).toBe('effective_checkpoint');
 }
 throw new Error('synthetic effective model did not finish within 30 bounded invocations');
}

async function clearDisposableTargetCalculations(){
 await target().prepare('DELETE FROM analytics_community_graph_results').run();
 await target().prepare('DELETE FROM analytics_history_checkpoint_heads').run();
 await target().prepare('DELETE FROM analytics_history_checkpoint_parts').run();
 await target().prepare('DELETE FROM analytics_history_checkpoint_stages').run();
 await target().prepare('DELETE FROM analytics_graph_day_values').run();
 await target().prepare('DELETE FROM analytics_graph_day_pages').run();
}
async function usageHeads(){return target().prepare(`SELECT day,value_key,manifest_digest,record_count,part_count FROM analytics_graph_day_values
 WHERE source_id=? AND source_layout='effective-usage' ORDER BY day`).bind(sourceId)
 .all<{day:string;value_key:string;manifest_digest:string;record_count:number;part_count:number}>();}
function combined(cold:Profile,warm:Profile){
 const costs=[cold,warm],sourceKeys=['compute.source.','scope.source.'];
 return {statements:costs.reduce((sum,profile)=>sum+Object.values(profile.families)
  .reduce((total,cost)=>total+cost.statements,0),0),
  sourceRowsRead:costs.reduce((sum,profile)=>sum+Object.entries(profile.families)
   .filter(([key])=>sourceKeys.some(prefix=>key.startsWith(prefix)))
   .reduce((total,[,cost])=>total+cost.rowsRead,0),0),
  checkpointPayloadBytes:cold.checkpointPayloadBytes+warm.checkpointPayloadBytes,
  checkpointPartInserts:cold.checkpointPartInserts+warm.checkpointPartInserts,
  dayCacheWrites:cold.dayCacheWrites+warm.dayCacheWrites,
  usagePageQueries:cold.usagePageQueries+warm.usagePageQueries};
}

it('profiles paired complete v1.2 effective model work and an adjacent warm model',async()=>{
 expect(Number.isSafeInteger(extraUsage)&&extraUsage>=1_200&&extraUsage<=12_000).toBe(true);
 const fixture=await denseV12Owner(extraUsage);
 const controlCold=await measuredModel(modelDay,false);
 const controlWarm=await measuredModel(adjacentDay,false);
 expect(controlCold.result.reused).toBe(false);
 expect(controlWarm.result.reused).toBe(false);
 expect(controlCold.result.result.composition?.status).toBe('ready');
 expect(controlWarm.result.result.composition?.status).toBe('ready');
 expect(controlCold.profile.usagePageQueries).toBeGreaterThan(0);
 expect(controlWarm.profile.usagePageQueries).toBeGreaterThan(0);
 await clearDisposableTargetCalculations();
 expect((await usageHeads()).results).toEqual([]);
 const cold=await measuredModel(modelDay,true);
 const headsAfterCold=(await usageHeads()).results;
 const warm=await measuredModel(adjacentDay,true);
 const headsAfterWarm=(await usageHeads()).results;
 expect(cold.result.reused).toBe(false);
 expect(warm.result.reused).toBe(false);
 expect(cold.result.result.composition?.status).toBe('ready');
 expect(warm.result.result.composition?.status).toBe('ready');
 expect(canonicalJson(cold.result.result)).toBe(canonicalJson(controlCold.result.result));
 expect(canonicalJson(warm.result.result)).toBe(canonicalJson(controlWarm.result.result));
 expect(headsAfterCold.map(head=>head.day)).toEqual([firstDay,'2026-09-02','2026-09-03','2026-09-04',modelDay]);
 expect(headsAfterWarm).toEqual(headsAfterCold);
 expect(warm.profile.usagePageQueries).toBe(0);
 // A completed result must round-trip under the same captured dependency.
 const owner=(await readStorageCommunityOwnerPage(source()))[0]!;
 const scope=await captureStorageGraphScope(source(),{owner,day:adjacentDay,metric:'model',sourceId,sourceNamespace,preparedFold:true});
 const replay=await computeStorageGraphResult({source:source(),target:target(),sourceId,sourceNamespace},scope,
  {maxQueries:950,deadlineMs:Date.now()+60_000,preparedFold:true});
 expect(replay).toMatchObject({state:'complete',reused:true});
 if(replay.state!=='complete')throw new Error('synthetic completed model unavailable');
 expect(await sha256Hex(canonicalJson(replay.result))).toBe(warm.digest);
 // A second genuine v1.2 domain generation adds one event to a prior day.
 // Its old day cache remains immutable, while the new dependency must create
 // only a replacement for that day and retain the four unchanged heads.
 const correctedDay='2026-09-03';
 const correctedRecords=[...fixture.records.get(correctedDay)!,usageRecord(fixture.usageRecords,
  `${correctedDay}T12:00:00.000Z`,'gpt-5.6-sol',1.5,
  '17539c1b-61da-4d9d-8b1f-6e464470d88b')];
 const correctedUpload=await stageDay(fixture.device,correctedDay,correctedRecords,2);
 await activate(fixture.device,fixture.staged.map(upload=>upload.day===correctedDay?correctedUpload:upload));
 const correctedOwner=(await readStorageCommunityOwnerPage(source()))[0]!;
 await target().prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?,state='active'
  WHERE source_id=? AND owner_digest=?`)
  .bind(correctedOwner.ownerRevision,correctedOwner.authorityEpoch,sourceId,correctedOwner.ownerDigest).run();
 const corrected=await measuredModel(modelDay,true);
 expect(corrected.result.reused).toBe(false);
 const correctedHeads=(await usageHeads()).results;
 expect(correctedHeads.filter(head=>head.day===correctedDay)).toHaveLength(2);
 expect(correctedHeads.filter(head=>head.day!==correctedDay)).toEqual(
  headsAfterWarm.filter(head=>head.day!==correctedDay));
 expect(correctedHeads.find(head=>head.day===correctedDay&&
  !headsAfterWarm.some(old=>old.value_key===head.value_key))).toBeDefined();
 await target().prepare(`DELETE FROM analytics_community_graph_results
  WHERE source_id=? AND owner_digest=? AND metric='model' AND day=?`)
  .bind(sourceId,correctedOwner.ownerDigest,modelDay).run();
 const correctedControl=await measuredModel(modelDay,false);
 expect(canonicalJson(corrected.result.result)).toBe(canonicalJson(correctedControl.result.result));
 const summary={revision:'effective-usage-profile-paired-v1',fixture:{usageRecords:fixture.usageRecords,
  quotaRecords:fixture.quotaRecords,days:fixture.days},
  control:{cold:{digest:controlCold.digest,profile:controlCold.profile},
   adjacent:{digest:controlWarm.digest,profile:controlWarm.profile},
   combined:combined(controlCold.profile,controlWarm.profile)},
  prepared:{cold:{digest:cold.digest,profile:cold.profile},
   adjacent:{digest:warm.digest,profile:warm.profile},combined:combined(cold.profile,warm.profile),
   usageHeads:headsAfterWarm},correction:{preparedDigest:corrected.digest,
    controlDigest:correctedControl.digest,preparedProfile:corrected.profile,
    headCountBefore:headsAfterWarm.length,headCountAfter:correctedHeads.length}};
 console.info('effective-usage-profile',JSON.stringify(summary));
},240_000);
