import {beforeEach,expect,it,vi} from 'vitest';
import {appendSharedAnalyticsFeaturePage,createSharedAnalyticsFeaturePending,finishSharedAnalyticsFeatureDay,
  SHARED_ANALYTICS_FEATURE_METHOD} from '../src/analytics-shared-features';
import {canonicalJson} from '../src/canonical-json';
import {storageGraphScalarSharedResumeEligible} from '../src/storage-community-graph';
import {createV11QuotaAcquisitionIdentity} from '../src/quota-analysis-v11';
import {createV11QuotaAcquisitionCheckpoint} from '../src/quota-analysis-v11-reader';
import type {StorageEffectiveHistoryCheckpoint} from '../src/storage-effective-history';
import type {V11SourcePin} from '../src/telemetry-v11-domain';
import {sha256Hex} from '../src/crypto';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from '../src/d1-invocation-budget';
import {createEffectiveHistoryDayDependencyReader} from '../src/storage-effective-history';
import {readEffectiveTelemetryOwnerDays,type EffectiveTelemetryOccurrence} from '../src/telemetry-usage-effective-reader';
import {readSharedAnalyticsFeatureWindowPlan,SharedAnalyticsFeatureWindowDeferredError,
  type SharedAnalyticsFeatureInput,type SharedAnalyticsFeatureWindowPlan} from '../src/storage-analytics-shared-features';
import {v11UsageRecord} from '../test/helpers/telemetry-v11';

// Closed protocol doubles only. These cases are not accepted-source/D1 cost
// or graph qualification; the genuine101-day fixture supplies that evidence.
vi.mock('../src/storage-effective-history',async importOriginal=>({...await importOriginal<typeof import('../src/storage-effective-history')>(),
  assertEffectiveHistoryOwner:vi.fn(async()=>{}),createEffectiveHistoryDayDependencyReader:vi.fn(),effectiveHistoryDependency:vi.fn()}));
vi.mock('../src/telemetry-usage-effective-reader',()=>({readEffectiveTelemetryOwnerDays:vi.fn(),
  readEffectiveTelemetryOwnerDayPage:vi.fn(),EFFECTIVE_USAGE_READER_METHOD:'effective-telemetry-owner-day-v1'}));
const readers=vi.mocked(createEffectiveHistoryDayDependencyReader),inventory=vi.mocked(readEffectiveTelemetryOwnerDays);
beforeEach(()=>vi.resetAllMocks());
const days=['2026-09-28','2026-09-30'],digest='a'.repeat(64),ownerDigest='b'.repeat(64);
async function feature(day:string,rows:number){
  let pending=createSharedAnalyticsFeaturePending(day,ownerDigest);
  for(let offset=0;offset<rows;offset+=200){
    const page:EffectiveTelemetryOccurrence[]=Array.from({length:Math.min(200,rows-offset)},(_,local)=>{
      const ordinal=offset+local,time=new Date(Date.parse(`${day}T12:00:00.000Z`)+ordinal).toISOString();
      const occurrenceId=`event:v2:${(ordinal+1).toString(16).padStart(64,'0')}`;
      const record=v11UsageRecord(day,'a',{eventId:occurrenceId,eventTime:time});
      return {methodVersion:'effective-telemetry-owner-day-v1',stream:'usage',participantId:'synthetic',ownerDigest,
        occurrenceId,eventTime:time,eventTimeConflict:false,status:'compatible',sourceCount:1,
        sourceFormats:['v11'],sourceRowIds:[ordinal+1],sourceRecordKeys:[occurrenceId],recordJson:canonicalJson(record)};
    });
    const last=page.at(-1)!;
    pending=await appendSharedAnalyticsFeaturePage(pending,'usage',page,offset+page.length<rows
      ?{observedAtMs:Date.parse(last.eventTime!),occurrenceId:last.occurrenceId}:null);
  }
  if(rows===0)pending=await appendSharedAnalyticsFeaturePage(pending,'usage',[],null);
  for(const stream of ['quota','session'] as const)pending=await appendSharedAnalyticsFeaturePage(pending,stream,[],null);
  return finishSharedAnalyticsFeatureDay(pending);
}
async function fixture(){
  const values=[await feature(days[0]!,401),await feature(days[1]!,1)];
  const method=await sha256Hex(canonicalJson(SHARED_ANALYTICS_FEATURE_METHOD));
  const jobs=await Promise.all(values.map(async(value,index)=>{
    const payload=canonicalJson({kind:'complete',value}),payload_digest=await sha256Hex(payload);
    const parts=[];
    for(let at=0;at<payload.length;at+=128*1024){
      const part=payload.slice(at,at+128*1024);
      parts.push({revision:1,part_index:parts.length,payload:part,payload_bytes:new TextEncoder().encode(part).byteLength,
        payload_digest:await sha256Hex(part)});
    }
    return {job:{job_key:String(index+1).repeat(64),source_id:'synthetic',source_namespace:'synthetic',
      owner_digest:ownerDigest,day:value.day,method_digest:method,dependency_digest:digest,owner_revision:1,
      authority_epoch:1,input_revision:1,head_revision:1,state:'complete',payload_digest,
      payload_bytes:new TextEncoder().encode(payload).byteLength,part_count:parts.length,
      claim_token:null,claim_expires_ms:null,updated_ms:0},parts};
  }));
  const owner:SharedAnalyticsFeatureInput['owner']={participantId:'synthetic',ownerDigest,inputRevision:1,
    ownerRevision:1,authorityEpoch:1,hasV1:false,hasV11:true,hasV12:false,hasLegacy:false,hasEffective:true};
  let active=true,inputRevision=1,clock=Date.now(),throwBudget=false,partLoads=0;
  let sourceDigest=digest,inventoryDays:readonly string[]=days;
  const source={prepare:()=>({bind(){return this;},first:async()=>{
    if(throwBudget)throw new D1InvocationBudgetExceededError();
    return {input_revision:inputRevision,owner_revision:1,authority_epoch:1};
  }})} as unknown as D1Database;
  const target={prepare:(sql:string)=>{
    let binds:unknown[]=[];
    return {bind(...values:unknown[]){binds=values;return this;},first:async()=>{
      if(sql.includes('sqlite_schema'))return sql.includes('sweep_cursor')?1:3;
      if(sql.includes('SELECT h.*'))return active?jobs.find(row=>row.job.job_key===binds[0])?.job??null:null;
      if(sql.includes('analytics_owner_state'))return active?1:null;
      throw Error('UNEXPECTED_WINDOW_PROTOCOL_FIRST');
    },all:async()=>{
      if(sql.includes('FROM analytics_shared_feature_parts')){
        partLoads++;return {results:active?jobs.find(row=>row.job.job_key===binds[0])!.parts:[]};
      }
      if(sql.includes('SELECT * FROM analytics_shared_feature_days'))return {results:jobs.map(row=>row.job)};
      if(sql.includes('SELECT h.*'))return {results:active?jobs.map(row=>row.job):[]};
      throw Error('UNEXPECTED_WINDOW_PROTOCOL_ALL');
    }};
  }} as unknown as D1Database;
  readers.mockImplementation(async(_source,_owner,_namespace,requested)=>({
    readDigest:async()=>sourceDigest,readDigests:async()=>requested.map(()=>sourceDigest)}));
  inventory.mockImplementation(async(_db,input)=>input.stream==='usage'?inventoryDays:[]);
  const meter=createD1InvocationBudget(950);
  const input={source:meter.wrap(source),target:meter.wrap(target),owner,sourceId:'synthetic',sourceNamespace:'synthetic',
    days,fromDay:days[0]!,throughDay:days[1]!,metric:'fits' as const,
    budget:{remainingQueries:()=>meter.remainingQueries,now:()=>clock,deadlineMs:clock+60_000}};
  return {values,jobs,input,meter,partLoads:()=>partLoads,revoke:()=>{active=false;},
    mutateDigest:()=>{sourceDigest='c'.repeat(64);},mutateInput:()=>{inputRevision++;},
    addDay:()=>{inventoryDays=[...days,'2026-09-29'].sort();},expire:()=>{clock+=60_000;},
    exhaust:()=>{throwBudget=true;}};
}
async function acquire(f:Awaited<ReturnType<typeof fixture>>):Promise<SharedAnalyticsFeatureWindowPlan>{
  const result=await readSharedAnalyticsFeatureWindowPlan(f.input);
  expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('PLAN_PROTOCOL_FIXTURE_REFUSED');
  return result.plan;
}
it('retains one validated day and resumes401 scalar rows exactly200/200/1',async()=>{
  const f=await fixture(),plan=await acquire(f);
  expect(f.partLoads()).toBe(2);
  expect(await plan.loadQuota(days)).toEqual(f.values.map(value=>value.quota));
  expect(await plan.loadModelUsage(days)).toEqual(f.values.map(value=>value.modelUsage));
  const observed=[];
  let afterTime=`${days[0]}T00:00:00.000Z`,afterOccurrence='';
  for(const expected of [200,200,1]){
    const page=await plan.usageReader.readPage({day:days[0]!,afterTime,afterOccurrence});
    expect(page.state).toBe('ready');if(page.state!=='ready')throw Error('PAGE_PROTOCOL_FIXTURE_REFUSED');
    expect(page.rows).toHaveLength(expected);observed.push(...page.rows);
    const last=page.rows.at(-1)!;afterTime=new Date(last.observedAtMs).toISOString();afterOccurrence=last.occurrenceId;
  }
  expect(observed).toEqual(f.values[0]!.scalarUsage);expect(f.partLoads()).toBe(3);
  const next=await plan.usageReader.readPage({day:days[1]!,afterTime:`${days[1]}T00:00:00.000Z`,afterOccurrence:''});
  expect(next).toMatchObject({state:'ready',complete:true});expect(f.partLoads()).toBe(4);
  expect(plan.logicalBytes().fullDayBytes).toBe(f.jobs[1]!.job.payload_bytes);
  expect(plan.logicalBytes().compactBytes).toBeLessThanOrEqual(8*1024*1024);
  expect(plan.logicalBytes().maximumRetainedBytes).toBeLessThanOrEqual(12*1024*1024);
  expect(f.meter.queriesUsed).toBeLessThanOrEqual(950);
  plan.close();plan.close();expect(plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
  expect(await plan.seal()).toEqual({state:'deferred',reason:'window_closed'});
});
it('chooses native admission before any proof when the original200 headroom cannot fit',async()=>{
  const f=await fixture(),minimum=4*days.length+2*64+16+200;
  expect(await readSharedAnalyticsFeatureWindowPlan({...f.input,budget:{...f.input.budget,remainingQueries:()=>minimum-1}}))
    .toEqual({state:'refused',reason:'window_plan_admission'});
  expect(f.meter.queriesUsed).toBe(0);expect(readers).not.toHaveBeenCalled();
});
it('withholds compact projections when same-owner correction/proof digest changes during acquisition',async()=>{
  const f=await fixture();let calls=0;
  readers.mockImplementation(async(_source,_owner,_namespace,requested)=>({readDigest:async()=>digest,
    readDigests:async()=>{calls++;return requested.map(()=>calls===1?digest:'c'.repeat(64));}}));
  expect(await readSharedAnalyticsFeatureWindowPlan(f.input)).toEqual({state:'deferred',reason:'source_changed'});
  expect(calls).toBe(2);
});
it.each(['digest','input','erasure','head','inventory'] as const)('freshly seals%s before compact reuse or checkpoint',async boundary=>{
  const f=await fixture(),plan=await acquire(f);
  if(boundary==='digest')f.mutateDigest();else if(boundary==='input')f.mutateInput();
  else if(boundary==='erasure')f.revoke();else if(boundary==='inventory')f.addDay();else f.jobs[0]!.job.head_revision++;
  await expect(plan.loadQuota(days)).rejects.toBeInstanceOf(SharedAnalyticsFeatureWindowDeferredError);
  expect(plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
});
it('checks a fresh day dependency before reusing its already decoded scalar cache',async()=>{
  const f=await fixture(),plan=await acquire(f),request={day:days[0]!,afterTime:`${days[0]}T00:00:00.000Z`,afterOccurrence:''};
  expect((await plan.usageReader.readPage(request)).state).toBe('ready');
  f.mutateDigest();expect(await plan.usageReader.readPage(request)).toEqual({state:'deferred',reason:'source_changed'});
});
it('retains integrity failure for missing parts under the exact unchanged complete head',async()=>{
  const f=await fixture();f.jobs[0]!.parts.pop();
  await expect(readSharedAnalyticsFeatureWindowPlan(f.input)).rejects.toThrow('SHARED_ANALYTICS_FEATURE_UNAVAILABLE');
});
it.each(['deadline','budget'] as const)('closes an accepted plan on%s rather than offering empty/native inputs',async boundary=>{
  const f=await fixture(),plan=await acquire(f);
  if(boundary==='deadline')f.expire();else f.exhaust();
  await expect(plan.loadQuota(days)).rejects.toBeInstanceOf(SharedAnalyticsFeatureWindowDeferredError);
  expect(plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
});

// Scalar resume's acquisition is metadata-only. Page consumption retains the
// same native dependency/head guards and original one-full-day integrity load.
it('scalar-only plan skips all initial full frames then validates one401-row day lazily',async()=>{
  const f=await fixture();
  const result=await readSharedAnalyticsFeatureWindowPlan({...f.input,consumer:'scalar'});
  expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('SCALAR_PLAN_PROTOCOL_REFUSED');
  const plan=result.plan;
  expect(f.partLoads()).toBe(0);expect(readers).toHaveBeenCalledTimes(2);
  expect(plan.scalarDays).toEqual(days);
  let afterTime=`${days[0]}T00:00:00.000Z`,afterOccurrence='';
  const rows=[];
  for(const expected of [200,200,1]){
    const page=await plan.usageReader.readPage({day:days[0]!,afterTime,afterOccurrence});
    expect(page.state).toBe('ready');if(page.state!=='ready')throw Error('SCALAR_PAGE_PROTOCOL_REFUSED');
    expect(page.rows).toHaveLength(expected);rows.push(...page.rows);
    const last=page.rows.at(-1)!;afterTime=new Date(last.observedAtMs).toISOString();afterOccurrence=last.occurrenceId;
  }
  expect(rows).toEqual(f.values[0]!.scalarUsage);expect(f.partLoads()).toBe(1);
  expect(await plan.seal()).toEqual({state:'current'});
  expect(plan.logicalBytes().maximumRetainedBytes).toBeLessThanOrEqual(12*1024*1024);
  plan.close();expect(plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
});
it('scalar-only plan refuses projection access instead of returning empty or native coverage',async()=>{
  const f=await fixture(),result=await readSharedAnalyticsFeatureWindowPlan({...f.input,consumer:'scalar'});
  expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('SCALAR_PLAN_PROTOCOL_REFUSED');
  await expect(result.plan.loadQuota(days)).rejects.toMatchObject({reason:'projection_not_available'});
  expect(result.plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
});
it('scalar-only plan keeps same-head part corruption as an integrity error at first consumption',async()=>{
  const f=await fixture(),result=await readSharedAnalyticsFeatureWindowPlan({...f.input,consumer:'scalar'});
  expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('SCALAR_PLAN_PROTOCOL_REFUSED');
  f.jobs[0]!.parts.pop();
  await expect(result.plan.usageReader.readPage({day:days[0]!,afterTime:`${days[0]}T00:00:00.000Z`,afterOccurrence:''}))
    .rejects.toThrow('SHARED_ANALYTICS_FEATURE_UNAVAILABLE');
});
it.each(['digest','head','inventory'] as const)('scalar-only plan preserves fresh%s sealing without compact projections',async boundary=>{
  const f=await fixture(),result=await readSharedAnalyticsFeatureWindowPlan({...f.input,consumer:'scalar'});
  expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('SCALAR_PLAN_PROTOCOL_REFUSED');
  if(boundary==='digest')f.mutateDigest();else if(boundary==='inventory')f.addDay();else f.jobs[0]!.job.head_revision++;
  expect(await result.plan.seal()).toEqual({state:'deferred',reason:'source_changed'});
  expect(result.plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
});

it('scalar-only plan refuses changed usage inventory even when the union of populated days stays exact',async()=>{
  const f=await fixture(),result=await readSharedAnalyticsFeatureWindowPlan({...f.input,consumer:'scalar'});
  expect(result.state).toBe('complete');if(result.state!=='complete')throw Error('SCALAR_PLAN_PROTOCOL_REFUSED');
  inventory.mockImplementation(async(_db,input)=>input.stream==='usage'?[days[0]!]:days);
  expect(await result.plan.seal()).toEqual({state:'deferred',reason:'source_changed'});
  expect(result.plan.logicalBytes()).toMatchObject({compactBytes:0,fullDayBytes:0});
});

const pin:V11SourcePin={source:'v1.1',participantId:'synthetic',generationId:'synthetic',fromDay:'2026-09-28',
 throughDay:'2026-09-30',inputRevision:1,mutationEpoch:1,fingerprint:'a'.repeat(64)};
const nowMs=Date.parse('2026-10-01T00:00:00.000Z'),identity=createV11QuotaAcquisitionIdentity(pin,nowMs);
const finish:StorageEffectiveHistoryCheckpoint={version:1,source:'effective',day:pin.throughDay,layout:'effective:synthetic',identity,
 phase:'finish',effectiveDays:{quota:[pin.fromDay],usage:[pin.fromDay]},
 effectiveCursor:{phase:'endpoints',day:pin.fromDay,after:null,ordinal:0,complete:true},
 acquisition:{identity,planAnchors:[],quotaRows:[]}};
const eligible=(checkpoint:StorageEffectiveHistoryCheckpoint,overrides:Partial<typeof pin>={})=>
 storageGraphScalarSharedResumeEligible({checkpoint,pin:{...pin,...overrides},sourceNamespace:'synthetic',day:pin.throughDay,nowMs});
// These are pure classification controls, not native storage/accepted-input proof.
it('classifies only the matching decoded completed quota acquisition for scalar resume',()=>{
 expect(eligible(finish)).toBe(true);
 expect(eligible({...finish,layout:'effective:other'})).toBe(false);
 expect(eligible(finish,{fingerprint:'b'.repeat(64)})).toBe(false);
 expect(eligible({...finish,identity:{...identity,inputFingerprint:'b'.repeat(64)}})).toBe(false);
 expect(eligible({...finish,acquisition:{...finish.acquisition,identity:{...identity,inputFingerprint:'b'.repeat(64)}}})).toBe(false);
});
it('keeps acquisition and optional cache-gap buffers on the original full plan',()=>{
 const acquisition:StorageEffectiveHistoryCheckpoint={...finish,phase:'acquisition',acquisition:createV11QuotaAcquisitionCheckpoint(identity)};
 expect(eligible(acquisition)).toBe(false);
 expect(eligible({...finish,quotaCoverage:{next:'analysis',refusedDays:[],pending:null}})).toBe(false);
});

it('keeps wrong usage identity or raw-session scalar mode out of scalar resume',()=>{
 const usage={version:1 as const,identity,days:[pin.fromDay],dayIndex:0,cursorTime:identity.observedAtCutoff,cursorOccurrence:'',
  rowsRead:0,complete:false,commonRefusal:null,scalarReduced:true,scalarRefusal:null,modelRefusal:null,
  previous:[],hazards:[],scalarBuckets:[],modelCosts:[],poisoned:[],usageEventCount:0,unpricedUsageEventCount:0,attributionUnresolved:false};
 const checkpoint:StorageEffectiveHistoryCheckpoint={...finish,phase:'usage',usage};
 expect(eligible(checkpoint)).toBe(true);
 expect(eligible({...checkpoint,usage:{...usage,scalarReduced:false}})).toBe(false);
 expect(eligible({...checkpoint,usage:{...usage,identity:{...identity,inputFingerprint:'b'.repeat(64)}}})).toBe(false);
});
