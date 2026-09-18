import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {QUOTA_CALIBRATION_POLICY} from '@app-usagemonitor/quota-analysis';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {
 GRAPH_DAY_PROJECTION_PART_BYTES,
 advanceGraphDayProjectionLane,
 createGraphDayProjectionBuild,
 createGraphDayProjectionSourceBuild,
 GraphDayProjectionRefusedError,
 graphDayUsageSessionDigest,
 type GraphDayProjectionBuild,
 graphDayProjectionValueKey,
 readGraphDayProjection,
 reduceGraphDayProjection,
 retireGraphDayProjectionPage,
 writeGraphDayProjection,
 type GraphDayProjectionCandidate,
 type GraphDayQuotaInput,
 type GraphDayUsageInput,
} from '../src/graph-day-projection';
import {
 GRAPH_DAY_PROJECTION_VERSION,
 graphDayPlanSignature,
 graphDayRunKey,
 validGraphDayRunKey,
 graphDayProjectionFromComponents,
 graphDayProjectionRecordCount,
 validGraphDayPlanSignature,
 validGraphDayProjection,
} from '../src/graph-day-projection-values';
import {graphDayProjectionBuildEnabled,advanceStorageAnalytics,initializeStorageAnalyticsRuntime,
 runStorageAnalyticsPass} from '../src/storage-analytics-runtime';
import {runStorageAnalyticsSchedule} from '../src/storage-analytics-worker';
import {initializeStorageSource,readIngestionChanges} from '../src/analytics-delivery';
import {initializeTypedV11Admission,persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor,loadV11SourcePin} from '../src/telemetry-v11-domain';
import {loadTypedV11GenerationSnapshot} from '../src/typed-v11-quota-reader';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';
import type {V11PlanAnchor} from '../src/quota-analysis-v11-reader';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[];
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-projection',sourceNamespace='synthetic-projection-original';
const OWNER='a'.repeat(64),MANIFEST='b'.repeat(64),REGISTRY='c'.repeat(64);
const DAY='2026-09-10',DAY_MS=Date.parse(`${DAY}T00:00:00.000Z`);
const key=(overrides:Partial<GraphDayProjectionCandidate>={}):GraphDayProjectionCandidate=>({
 sourceId,sourceLayout:'typed-v11',sourceNamespace,ownerDigest:OWNER,deviceId:'device-1',
 manifestId:'manifest-1',manifestDigest:MANIFEST,day:DAY,...overrides});

beforeEach(async()=>{
 await reset();
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await target().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)')
  .bind(sourceId,sourceNamespace).run();
 await target().prepare('INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,?)')
  .bind(sourceId,OWNER,'active').run();
});

/** One delivered v1.1 day, in the reusable shape the builder selects from. */
async function deliverDay(day=DAY,manifestDigest=MANIFEST,manifestId='manifest-1'):Promise<void>{
 const values=canonicalJson({counts:{quota:0,session:0,usage:1},day,pricingMethodVersion:'synthetic-pricing',
  registrySha256:REGISTRY,schemaVersion:'synthetic-values-v1'});
 await target().prepare(`INSERT INTO analytics_v11_reusable_values
  (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,
   schema_version,pricing_method,registry_sha256,record_count,values_digest,values_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(await sha256Hex(`${day}:${manifestDigest}:${manifestId}`),sourceId,'typed-v11',sourceNamespace,OWNER,
   'device-1',manifestId,manifestDigest,day,'synthetic-values-v1','synthetic-pricing',REGISTRY,1,
   await sha256Hex(values),values).run();
}

const anchor=(observedAtMs:number,overrides:Partial<V11PlanAnchor>={}):V11PlanAnchor=>({
 contextKey:'openai_codex|codex',observedAtMs,planType:'pro',planVariant:'unknown',continuityId:null,
 conflicted:false,accountScopeId:null,planBasis:'same_source_occurrence',...overrides});
const acquired=(observedAtMs:number,usedPercent:number,index:number,overrides:Record<string,unknown>={})=>({
 occurrence_id:`occ-${index.toString().padStart(8,'0')}`,observed_at:new Date(observedAtMs).toISOString(),
 provider:'openai_codex',account_scope_id:null,limit_id:'codex',plan_type:'pro',plan_variant:'unknown',
 continuity_id:null,plan_basis:'same_source_occurrence' as const,slot:'primary',used_percent:usedPercent,
 window_duration_minutes:10080,resets_at:new Date(DAY_MS+7*86400000).toISOString(),...overrides});
const input=(index:number,observedAtMs:number,usedPercent:number,
 overrides:Record<string,unknown>={}):GraphDayQuotaInput=>({
 sourceRowId:index,observedAtMs,
 anchor:anchor(observedAtMs,overrides.anchor as Partial<V11PlanAnchor>??{}),
 row:acquired(observedAtMs,usedPercent,index,overrides.row as Record<string,unknown>??{}),
});
const SESSION_A='1'.repeat(64),SESSION_B='2'.repeat(64);
const usageEvent=(offsetMs:number,overrides:Partial<GraphDayUsageInput>={}):GraphDayUsageInput=>({
 sessionDigest:SESSION_A,observedAtMs:DAY_MS+offsetMs,provider:'openai_codex',accountScopeId:null,
 planBasis:'same_source_occurrence',planType:'pro',planEraId:null,kind:'priced',
 model:'gpt-5.6',costNanousd:4321,...overrides});

const simple=()=>reduceGraphDayProjection(DAY,
 [input(1,DAY_MS+60000,10),input(2,DAY_MS+120000,20),input(3,DAY_MS+180000,30)],
 {events:[usageEvent(60000),usageEvent(120000)],rowsRead:2});

describe('prepared graph day value types',()=>{
 it('accepts the reduced artifact and refuses an unknown key anywhere in it',()=>{
  const projection=simple();
  expect(validGraphDayProjection(projection)).toBe(true);
  expect(validGraphDayProjection({...projection,extra:1})).toBe(false);
  expect(validGraphDayProjection({...projection,planAnchors:{anchors:projection.planAnchors.anchors,extra:1}})).toBe(false);
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:projection.runEndpoints.endpoints
   .map(endpoint=>({...endpoint,extra:1}))}})).toBe(false);
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:projection.runEndpoints.endpoints
   .map(endpoint=>({...endpoint,row:{...endpoint.row,plan_era_key:'["openai_codex|codex",null,"pro","unknown",0]'}}))}})).toBe(false);
  expect(validGraphDayProjection({...projection,version:'graph-day-projection-v0'})).toBe(false);
 });
 it('refuses out-of-range values and a non-canonical order',()=>{
  const projection=simple();
  const endpoints=projection.runEndpoints.endpoints;
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:endpoints.map(endpoint=>
   ({...endpoint,usedPercent:101,row:{...endpoint.row,used_percent:101}}))}})).toBe(false);
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:[...endpoints].reverse()}})).toBe(false);
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:[endpoints[0]!,endpoints[0]!]}})).toBe(false);
  // A denormalized key field that disagrees with its own row is refused.
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:endpoints.map(endpoint=>
   ({...endpoint,slot:'secondary'}))}})).toBe(false);
  expect(validGraphDayProjection({...projection,day:'2026-09-31'})).toBe(false);
  // A usage bin that does not start on the 2-hour grain cannot be a day-local
  // cell, and one outside the day belongs to another day's artifact.
  const cell=projection.usage.cells[0]!;
  expect(validGraphDayProjection({...projection,usage:{...projection.usage,
   cells:[{...cell,binStartMs:DAY_MS+60000}]}})).toBe(false);
  expect(validGraphDayProjection({...projection,usage:{...projection.usage,
   cells:[{...cell,binStartMs:DAY_MS+86400000}]}})).toBe(false);
  // An unpriced cell poisons its bin and can never carry a cost.
  expect(validGraphDayProjection({...projection,usage:{...projection.usage,
   cells:[{...cell,model:null}]}})).toBe(false);
  // An opener whose session the day never closed cannot be placed by the fold.
  expect(validGraphDayProjection({...projection,usage:{...projection.usage,sessions:[]}})).toBe(false);
  expect(validGraphDayProjection({...projection,fitFragments:{fragments:projection.fitFragments.fragments
   .map(fragment=>({...fragment,minimum:fragment.maximum+1}))}})).toBe(false);
 });
 it('validates a day-local plan signature through the reader own anchor fields',()=>{
  expect(validGraphDayPlanSignature(graphDayPlanSignature(anchor(0)))).toBe(true);
  expect(validGraphDayPlanSignature(graphDayPlanSignature(anchor(0,{planType:'not-a-plan'})))).toBe(false);
  expect(validGraphDayPlanSignature(graphDayPlanSignature(anchor(0,{contextKey:'openai_codex|other'})))).toBe(false);
  expect(validGraphDayPlanSignature(graphDayPlanSignature(anchor(0,{accountScopeId:'raw-account-id'})))).toBe(false);
  // A window era key is a different tuple and is never a day-local signature.
  expect(validGraphDayPlanSignature('["openai_codex|codex",null,"pro","unknown",0]')).toBe(false);
  expect(validGraphDayPlanSignature('[ "openai_codex|codex",null,"pro","unknown",null,null]')).toBe(false);
 });
 it('validates a run key and refuses a hull or fragment no endpoint can place',()=>{
  const signature=graphDayPlanSignature(anchor(0));
  expect(validGraphDayRunKey(graphDayRunKey(signature,DAY_MS))).toBe(true);
  expect(validGraphDayRunKey(signature)).toBe(false);
  expect(validGraphDayRunKey(graphDayRunKey(signature,1.5))).toBe(false);
  const projection=simple();
  // A fragment whose run no endpoint can place is refused: that is the whole
  // cross-component rule now that pools are re-derived from the fragments.
  expect(validGraphDayProjection({...projection,fitFragments:{fragments:projection.fitFragments.fragments
   .map(fragment=>({...fragment,runFirstObservedAtMs:fragment.runFirstObservedAtMs+1}))}})).toBe(false);
  expect(validGraphDayProjection({...projection,runEndpoints:{endpoints:projection.runEndpoints.endpoints
   .map(endpoint=>({...endpoint,runFirstObservedAtMs:endpoint.observedAtMs+1}))}})).toBe(false);
 });
});

describe('day reduction',()=>{
 it('collapses equal-value runs and applies no endpoint spacing',()=>{
  // Three runs of a constant value, each far closer together than the
  // 10-minute window spacing the fold applies over the whole window.
  const rows=[input(1,DAY_MS+60000,10),input(2,DAY_MS+120000,10),input(3,DAY_MS+180000,10),
   input(4,DAY_MS+240000,20),input(5,DAY_MS+300000,20)];
  const projection=reduceGraphDayProjection(DAY,rows);
  expect(projection.runEndpoints.endpoints.map(endpoint=>endpoint.sourceRowId)).toEqual([1,3,4,5]);
  expect(new Set(projection.runEndpoints.endpoints.map(endpoint=>endpoint.resetsAtMs)).size).toBe(1);
 });
 it('splits runs at a plan signature change and at an equal-time conflict instant',()=>{
  const conflict=DAY_MS+240000;
  const rows=[input(1,DAY_MS+60000,10),input(2,DAY_MS+120000,10),
   input(3,conflict,10),
   {...input(4,conflict,10),anchor:anchor(conflict,{planVariant:'other'}),
    row:acquired(conflict,10,4,{plan_variant:'other'})},
   input(5,DAY_MS+300000,10)];
  const projection=reduceGraphDayProjection(DAY,rows);
  // The conflicting instant is an indivisible barrier: no run spans it, so no
  // row is provably interior and every row survives.
  expect(projection.runEndpoints.endpoints.map(endpoint=>endpoint.sourceRowId)).toEqual([1,2,3,4,5]);
  expect(new Set(projection.planAnchors.anchors.map(value=>value.planVariant))).toEqual(new Set(['unknown','other']));
  // Day-local units: the block before the tie, each side of the tie itself, the
  // block that resumes after it, and the tail each run opens at its own last
  // retained anchor, which is where a resumed run's era actually begins.
  expect(new Set(projection.fitFragments.fragments
   .map(fragment=>graphDayRunKey(fragment.signature,fragment.runFirstObservedAtMs))).size).toBe(5);
  expect(new Set(projection.runEndpoints.endpoints.map(endpoint=>endpoint.runFirstObservedAtMs)))
   .toEqual(new Set([DAY_MS+60000,DAY_MS+120000,conflict,DAY_MS+300000]));
 });
 it('separates one signature that is interrupted and resumes inside a day',()=>{
  const conflict=DAY_MS+240000;
  const rows=[input(1,DAY_MS+60000,10),
   input(2,conflict,20),
   {...input(3,conflict,20),anchor:anchor(conflict,{planType:'plus'}),row:acquired(conflict,20,3,{plan_type:'plus'})},
   input(4,DAY_MS+300000,30)];
  const projection=reduceGraphDayProjection(DAY,rows);
  const runs=[...new Set(projection.fitFragments.fragments
   .map(fragment=>graphDayRunKey(fragment.signature,fragment.runFirstObservedAtMs)))]
   .map(key=>JSON.parse(key) as [string,number]);
  const signature=graphDayPlanSignature(anchor(0));
  // The `pro` signature reaches three separate runs, so its fit fragments are
  // no longer merged before the fold can place their eras.
  expect(runs.filter(([value])=>value===signature).map(([,first])=>first).sort())
   .toEqual([DAY_MS+60000,conflict,DAY_MS+300000].sort());
  expect(new Set(projection.fitFragments.fragments.map(fragment=>
   fragment.signature===signature?fragment.runFirstObservedAtMs:-1)))
   .toEqual(new Set([DAY_MS+60000,conflict,DAY_MS+300000,-1]));
 });
 it('keeps a row that is a pooled-run boundary but a raw-run interior',()=>{
  // One pool restated under two raw instants, with the value returning across
  // them. Collapsing under the raw instant alone would drop row 3, which is a
  // run boundary of the pooled stream the fold actually collapses.
  const second=DAY_MS+7*86400000+30*60000;
  const rows=[input(1,DAY_MS+60000,10),input(2,DAY_MS+120000,20,{row:{resets_at:new Date(second).toISOString()}}),
   input(3,DAY_MS+180000,10),input(4,DAY_MS+240000,10),
   input(5,DAY_MS+300000,30,{row:{resets_at:new Date(second).toISOString()}})];
  const projection=reduceGraphDayProjection(DAY,rows);
  expect(projection.runEndpoints.endpoints.map(endpoint=>endpoint.sourceRowId)).toContain(3);
 });
 it('retains the numerically smallest distinct values rather than the arrival order',()=>{
  const bound=QUOTA_CALIBRATION_POLICY.minimumBoundaries;
  const arrival=[90,80,70,60,50,40,30,20,10];
  const rows=arrival.map((usedPercent,index)=>input(index+1,DAY_MS+60000*(index+1),usedPercent));
  const projection=reduceGraphDayProjection(DAY,rows);
  // One run, split at its own last retained anchor, so the final row forms its
  // own unit; the fragment that carries the run's evidence is the first.
  expect(projection.fitFragments.fragments).toHaveLength(2);
  const fragment=projection.fitFragments.fragments[0]!;
  expect(fragment.minimum).toBe(20);
  expect(fragment.maximum).toBe(90);
  expect(fragment.values).toEqual([...arrival.slice(0,-1)].sort((left,right)=>left-right).slice(0,bound));
  expect(fragment.resetsAtMs).toBe(DAY_MS+7*86400000);
  expect(projection.fitFragments.fragments[1]!.values).toEqual([10]);
 });
 it('keys fit fragments and hulls by the raw reset instant, not a representative',()=>{
  const later=new Date(DAY_MS+7*86400000+60000).toISOString();
  const rows=[input(1,DAY_MS+60000,10),input(2,DAY_MS+120000,20,{row:{resets_at:later}})];
  const projection=reduceGraphDayProjection(DAY,rows);
  // The run splits at its own last retained anchor, so each raw instant lands
  // in its own unit here; neither is merged into a representative day-locally.
  expect(projection.fitFragments.fragments.map(fragment=>fragment.resetsAtMs))
   .toEqual([DAY_MS+7*86400000,DAY_MS+7*86400000+60000]);
  // Both raw instants survive as separate fragments; the fold clusters them.
  expect(new Set(projection.fitFragments.fragments
   .map(fragment=>graphDayRunKey(fragment.signature,fragment.runFirstObservedAtMs))).size).toBe(2);
 });
});

describe('usage model half',()=>{
 const reduce=(events:GraphDayUsageInput[])=>reduceGraphDayProjection(DAY,
  [input(1,DAY_MS+60000,10)],{events,rowsRead:events.length}).usage;
 it('aggregates a bin by attribution, break and model, and holds each session opener alone',()=>{
  const usage=reduce([
   usageEvent(60000),usageEvent(60001,{sessionDigest:SESSION_B}),usageEvent(120000),
   usageEvent(180000,{model:'gpt-5.5',costNanousd:100}),
   usageEvent(7200000+60000),
  ]);
  // One opener per session; everything after it is day-local and aggregates.
  expect(usage.openers.map(opener=>opener.sessionDigest)).toEqual([SESSION_A,SESSION_B]);
  expect(usage.sessions.map(session=>session.sessionDigest)).toEqual([SESSION_A,SESSION_B]);
  expect(usage.sessions[0]!.lastObservedAtMs).toBe(DAY_MS+7200000+60000);
  const first=usage.cells.filter(cell=>cell.binStartMs===DAY_MS);
  expect(first.map(cell=>[cell.model,cell.costNanousd,cell.eventCount]))
   .toEqual([[ 'gpt-5.5',100,1],['gpt-5.6',4321,1]]);
  expect(usage.cells.filter(cell=>cell.binStartMs===DAY_MS+7200000))
   .toEqual([expect.objectContaining({model:'gpt-5.6',costNanousd:4321,eventCount:1})]);
 });
 it('marks an account break day-locally and leaves the opener undecided',()=>{
  const scope=`account-track:v2:${'d'.repeat(64)}`;
  const usage=reduce([usageEvent(60000,{accountScopeId:scope}),usageEvent(120000)]);
  expect(usage.openers).toHaveLength(1);
  expect(usage.openers[0]!.accountScopeId).toBe(scope);
  // The second event's prior is day-local, so its break is decided here.
  expect(usage.cells).toEqual([expect.objectContaining({accountBreak:true,accountScopeId:null})]);
 });
 it('poisons a bin with an unpriced event and drops an unmeasurable one',()=>{
  const usage=reduce([
   usageEvent(60000),
   usageEvent(120000,{kind:'unpriced',model:null,costNanousd:0}),
   usageEvent(180000,{kind:'unmeasurable',model:null,costNanousd:0}),
  ]);
  expect(usage.cells.map(cell=>[cell.model,cell.eventCount])).toEqual([[null,1]]);
  // The unmeasurable record still advanced the session carry.
  expect(usage.sessions[0]!.lastObservedAtMs).toBe(DAY_MS+180000);
  expect(usage.openers[0]!.model).toBe('gpt-5.6');
 });
 it('carries a dropped last event of a session into the day carry-out',async()=>{
  // The kernel's own dropped-last-event case. A session's last row of day one
  // prices to nothing, so the reduction drops it AFTER advancing the carry to
  // its scope. Day two's event of that session then breaks the account only
  // because of that dropped row: without it the carry would still hold scope Y
  // and there would be no break at all.
  const scopeX=`account-track:v2:${'e'.repeat(64)}`,scopeY=`account-track:v2:${'f'.repeat(64)}`;
  const dayOne=reduceGraphDayProjection(DAY,[input(1,DAY_MS+60000,10)],{rowsRead:3,events:[
   usageEvent(3600000,{accountScopeId:scopeY}),
   usageEvent(7200000,{accountScopeId:scopeY}),
   usageEvent(10800000,{accountScopeId:scopeX,kind:'unmeasurable',model:null,costNanousd:0}),
  ]});
  // The carry-out is the DROPPED row's instant and scope, not the last priced
  // row's, which is the whole point of retaining it.
  expect(dayOne.usage.sessions).toEqual([{sessionDigest:SESSION_A,
   lastObservedAtMs:DAY_MS+10800000,lastAccountScopeId:scopeX}]);
  // The dropped row contributes no cell and no opener of its own.
  expect(dayOne.usage.cells.map(cell=>cell.eventCount)).toEqual([1]);
  expect(dayOne.usage.openers.map(opener=>opener.accountScopeId)).toEqual([scopeY]);
  // Day two's first event of the session stays undecided in the artifact; the
  // fold resolves the break from the carry above, which now says scopeX.
  const nextDay='2026-09-11',nextMs=Date.parse(`${nextDay}T00:00:00.000Z`);
  const dayTwo=reduceGraphDayProjection(nextDay,[],{rowsRead:1,events:[{sessionDigest:SESSION_A,
   observedAtMs:nextMs+3600000,provider:'openai_codex',accountScopeId:scopeY,
   planBasis:'same_source_occurrence',planType:'pro',planEraId:null,kind:'priced',
   model:'gpt-5.6',costNanousd:7}]});
  expect(dayTwo.usage.openers).toEqual([expect.objectContaining({sessionDigest:SESSION_A,
   accountScopeId:scopeY})]);
  expect(dayTwo.usage.cells).toEqual([]);
  // And it survives the artifact: stored and read back, the carry is the same.
  const stored=await writeGraphDayProjection({target:target(),key:key(),projection:dayOne});
  expect(stored.status).toBe('stored');
  const read=await readGraphDayProjection({target:target(),key:key()});
  if(read.status!=='ready')throw new Error('unreachable');
  expect(read.projection.usage.sessions).toEqual(dayOne.usage.sessions);
 });
 it('refuses a day whose cost cannot be summed below the kernel ceiling',()=>{
  expect(()=>reduce([usageEvent(60000,{sessionDigest:null,costNanousd:90_000_000_000_001})]))
   .toThrow('prepared graph day refused');
  expect(()=>reduce([usageEvent(60000,{sessionDigest:null,costNanousd:50_000_000_000_000}),
   usageEvent(120000,{sessionDigest:null,costNanousd:50_000_000_000_000})]))
   .toThrow('prepared graph day refused');
 });
 it('sizes an owner-day at the cardinalities production measures',()=>{
  // Production measures 9-11 distinct (bin, model) cells per owner-day with a
  // maximum of 46, and 21-44 sessions with a maximum of 444. Size both, since
  // the per-session carry, not the cells, is what grows at the maximum.
  const models=Array.from({length:8},(_,index)=>`model-${index}`);
  const build=(sessionCount:number,eventsPerSession:number)=>{
   const events:GraphDayUsageInput[]=[];
   for(let session=0;session<sessionCount;session++){
    const digest=session.toString(16).padStart(64,'0');
    for(let event=0;event<eventsPerSession;event++){
     events.push(usageEvent(session*120000+event*1000,{sessionDigest:digest,
      model:models[(session+event)%models.length]!,costNanousd:1_000+session}));
    }
   }
   const usage=reduce(events);
   return {bytes:canonicalJson(usage).length,cells:usage.cells.length,
    openers:usage.openers.length,sessions:usage.sessions.length};
  };
  const mean=build(32,6),maximum=build(444,2);
  expect(mean.sessions).toBe(32);
  expect(maximum.sessions).toBe(444);
  // A mean owner-day is a small fraction of one payload row; the measured
  // maximum still frames into a handful of them, which the part scheme exists
  // for. Nothing here approaches the cell or session bound.
  expect(mean.bytes).toBeLessThan(GRAPH_DAY_PROJECTION_PART_BYTES / 8);
  expect(maximum.bytes).toBeLessThan(4*GRAPH_DAY_PROJECTION_PART_BYTES);
  console.log(JSON.stringify({meanOwnerDay:mean,maximumOwnerDay:maximum}));
 });
});

describe('day reduction retention contract',()=>{
 /** mulberry32, so a divergence is replayable from its seed alone. */
 const seeded=(seed:number)=>()=>{
  seed=(seed+0x6d2b79f5)|0;let value=Math.imul(seed^(seed>>>15),1|seed);
  value=(value+Math.imul(value^(value>>>7),61|value))^value;
  return ((value^(value>>>14))>>>0)/4294967296;};
 /** The retention rule the fold needs, stated over the WHOLE day's
  * `(signature, slot)` stream: a row may be dropped only when every row of its
  * stream between its own raw-instant neighbours carries its value. The
  * reducer splits streams per RUN as well, so it keeps at least these rows —
  * and the fold re-runs the real collapse kernel, which discards any extra
  * interior row of a constant run. */
 const soundlyKept=(rows:GraphDayQuotaInput[]):number[]=>{
  const streams=new Map<string,GraphDayQuotaInput[]>();
  for(const row of rows){
   if(!row.row)continue;
   const key=JSON.stringify([graphDayPlanSignature(anchor(0,{planType:row.row.plan_type})),row.row.slot]);
   const stream=streams.get(key);if(stream)stream.push(row);else streams.set(key,[row]);
  }
  const kept:number[]=[];
  for(const stream of streams.values()){
   for(let index=0;index<stream.length;index++){
    const value=stream[index]!,reset=value.row!.resets_at;
    let before=-1,after=-1;
    for(let step=index-1;step>=0;step--)if(stream[step]!.row!.resets_at===reset){before=step;break;}
    for(let step=index+1;step<stream.length;step++)if(stream[step]!.row!.resets_at===reset){after=step;break;}
    if(before<0||after<0||stream.slice(before,after+1)
     .some(other=>other.row!.used_percent!==value.row!.used_percent))kept.push(value.sourceRowId);
   }
  }
  return kept;
 };
 it('retains every pooled-run boundary over 50 jittery corpora',()=>{
  const pools=[DAY_MS+9*86400000,DAY_MS+16*86400000];
  for(let seed=1;seed<=50;seed++){
   const random=seeded(seed);
   const rows:GraphDayQuotaInput[]=[];
   let used=5*(1+Math.floor(random()*12));
   const count=20+Math.floor(random()*30);
   for(let index=0;index<count;index++){
    // A small discrete jitter set, so one pool is restated under a handful of
    // RAW instants that repeat and a value RETURNS across them.
    const jitter=[0,11,23,37][Math.floor(random()*4)]!*60000;
    if(random()<0.5)used=5*(1+Math.floor(random()*12));
    rows.push(input(index+1,DAY_MS+(index+1)*60000,used,{row:{
     resets_at:new Date(pools[random()<0.5?1:0]!+jitter).toISOString(),
     slot:random()<0.25?'five_hour':'primary'}}));
   }
   const projection=reduceGraphDayProjection(DAY,rows);
   const retained=new Set(projection.runEndpoints.endpoints.map(endpoint=>endpoint.sourceRowId));
   for(const id of soundlyKept(rows))expect(retained.has(id),`seed ${seed} dropped row ${id}`).toBe(true);
  }
 });
});

describe('durable prepared day store',()=>{
 it('promotes a day whose run holds two pools in one run key',async()=>{
  // A run key carries no slot, so a normal owner-day mixes `five_hour` and
  // `seven_day` resets inside ONE hull group. The framed entry count and the
  // stored record count must agree on that group or the completeness trigger
  // refuses to promote the day at all.
  const far=new Date(DAY_MS+30*86400000).toISOString();
  const projection=reduceGraphDayProjection(DAY,[
   input(1,DAY_MS+60000,10),
   input(2,DAY_MS+120000,20,{row:{slot:'five_hour',resets_at:far}}),
   input(3,DAY_MS+180000,30),input(4,DAY_MS+240000,40)]);
  // One run key, two pools: the fold settles them from these fragments.
  const runs=new Set(projection.fitFragments.fragments
   .map(fragment=>graphDayRunKey(fragment.signature,fragment.runFirstObservedAtMs)));
  expect(runs.size).toBeLessThan(projection.fitFragments.fragments.length);
  // Plus the single-entry `usageRowsRead` component.
  expect(graphDayProjectionRecordCount(projection)).toBe(1+projection.planAnchors.anchors.length
   +projection.fitFragments.fragments.length+projection.runEndpoints.endpoints.length
   +projection.usage.cells.length+projection.usage.openers.length+projection.usage.sessions.length);
  const written=await writeGraphDayProjection({target:target(),key:key(),projection});
  expect(written.status).toBe('stored');
  const read=await readGraphDayProjection({target:target(),key:key()});
  expect(read.status).toBe('ready');
  if(read.status!=='ready')throw new Error('unreachable');
  expect(canonicalJson(read.projection)).toBe(canonicalJson(projection));
 });
 it('round-trips a prepared day and writes nothing new on replay',async()=>{
  const projection=simple();
  const first=await writeGraphDayProjection({target:target(),key:key(),projection});
  expect(first.status).toBe('stored');
  if(first.status!=='stored')throw new Error('unreachable');
  expect(first.recordCount).toBe(graphDayProjectionRecordCount(projection));
  const read=await readGraphDayProjection({target:target(),key:key()});
  expect(read.status).toBe('ready');
  if(read.status!=='ready')throw new Error('unreachable');
  expect(canonicalJson(read.projection)).toBe(canonicalJson(projection));
  const second=await writeGraphDayProjection({target:target(),key:key(),projection});
  expect(second).toMatchObject({status:'stored',valueKey:first.valueKey});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(1);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_pages').first<number>('n')).toBe(first.totalParts);
 });
 it('pages a day past one payload row and resumes an interrupted write',async()=>{
  const rows=Array.from({length:1200},(_,index)=>
   input(index+1,DAY_MS+60000*(index+1),index%2===0?10:20));
  const projection=reduceGraphDayProjection(DAY,rows);
  expect(projection.runEndpoints.endpoints.length).toBeGreaterThan(1000);
  const staged=await writeGraphDayProjection({target:target(),key:key(),projection,maxWrites:2});
  expect(staged.status).toBe('staging');
  if(staged.status!=='staging')throw new Error('unreachable');
  expect(staged.totalParts).toBeGreaterThan(1);
  expect(staged.storedParts).toBe(1);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
  // Every payload row stays inside the bound the SQL CHECK enforces.
  const largest=await target().prepare('SELECT MAX(length(CAST(payload_json AS BLOB))) n FROM analytics_graph_day_pages').first<number>('n');
  expect(largest).toBeLessThanOrEqual(GRAPH_DAY_PROJECTION_PART_BYTES);
  // A later pass re-frames the same immutable day and continues from the rows
  // already present rather than restarting it.
  let result=await writeGraphDayProjection({target:target(),key:key(),projection,maxWrites:2});
  for(let attempt=0;attempt<16&&result.status==='staging';attempt++){
   result=await writeGraphDayProjection({target:target(),key:key(),projection,maxWrites:2});
  }
  expect(result.status).toBe('stored');
  const read=await readGraphDayProjection({target:target(),key:key(),maxParts:1});
  expect(read.status).toBe('deferred');
  if(read.status!=='deferred')throw new Error('unreachable');
  let load=await readGraphDayProjection({target:target(),key:key(),maxParts:1,cursor:read.cursor});
  for(let attempt=0;attempt<16&&load.status==='deferred';attempt++){
   load=await readGraphDayProjection({target:target(),key:key(),maxParts:1,cursor:load.cursor});
  }
  expect(load.status).toBe('ready');
  if(load.status!=='ready')throw new Error('unreachable');
  expect(canonicalJson(load.projection)).toBe(canonicalJson(projection));
 });
 it('invalidates only the day whose input revision changed',async()=>{
  const projection=simple();
  await writeGraphDayProjection({target:target(),key:key(),projection});
  const other=key({day:'2026-09-11',manifestId:'manifest-2',manifestDigest:'d'.repeat(64)});
  await writeGraphDayProjection({target:target(),key:other,
   projection:reduceGraphDayProjection('2026-09-11',[])});
  // A restated day changes that day manifest digest, which changes only that
  // day key: the prepared row misses and the other day stays valid.
  const restated=key({manifestDigest:'e'.repeat(64)});
  expect(await graphDayProjectionValueKey(restated)).not.toBe(await graphDayProjectionValueKey(key()));
  expect((await readGraphDayProjection({target:target(),key:restated})).status).toBe('absent');
  expect((await readGraphDayProjection({target:target(),key:other})).status).toBe('ready');
 });
 it('refuses a rebuild that produced different bytes under one identity',async()=>{
  await writeGraphDayProjection({target:target(),key:key(),projection:simple()});
  const divergent=reduceGraphDayProjection(DAY,[input(1,DAY_MS+60000,11)]);
  await expect(writeGraphDayProjection({target:target(),key:key(),projection:divergent}))
   .rejects.toThrow('GRAPH_DAY_PROJECTION_UNAVAILABLE');
 });
 it('retires a row whose acquisition contract version is not current',async()=>{
  await deliverDay();
  await writeGraphDayProjection({target:target(),key:key(),projection:simple()});
  expect(await retireGraphDayProjectionPage(target(),sourceId)).toMatchObject({state:'idle',values:0,pages:0});
  // A kernel change retires the rows instead of silently reusing them.
  const retired=await retireGraphDayProjectionPage(target(),sourceId,
   {acquisitionVersion:'graph-day-projection-v2'});
  expect(retired.values).toBe(1);
  expect(retired.pages).toBeGreaterThan(0);
  let sweep=retired;
  for(let attempt=0;attempt<8&&sweep.state==='retiring';attempt++){
   sweep=await retireGraphDayProjectionPage(target(),sourceId,{acquisitionVersion:'graph-day-projection-v2'});
  }
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_pages').first<number>('n')).toBe(0);
 });
 it('retires a prepared day whose delivered manifest identity is gone',async()=>{
  await deliverDay();
  await writeGraphDayProjection({target:target(),key:key(),projection:simple()});
  expect(await retireGraphDayProjectionPage(target(),sourceId)).toMatchObject({state:'idle'});
  await target().prepare('DELETE FROM analytics_v11_reusable_values').run();
  expect((await retireGraphDayProjectionPage(target(),sourceId)).values).toBe(1);
  let sweep=await retireGraphDayProjectionPage(target(),sourceId);
  for(let attempt=0;attempt<8&&sweep.state==='retiring';attempt++)sweep=await retireGraphDayProjectionPage(target(),sourceId);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_pages').first<number>('n')).toBe(0);
 });
 it('keeps a promoted payload row immutable and retained',async()=>{
  await writeGraphDayProjection({target:target(),key:key(),projection:simple()});
  await expect(target().prepare('DELETE FROM analytics_graph_day_pages').run())
   .rejects.toThrow('analytics_graph_day_page_retained');
  await expect(target().prepare("UPDATE analytics_graph_day_values SET record_count=0").run())
   .rejects.toThrow('analytics_graph_day_value_conflict');
 });
});

describe('prepared graph day schema',()=>{
 const insertValues=(overrides:Record<string,unknown>={}):Promise<unknown>=>{
  const row={value_key:'1'.repeat(64),source_id:sourceId,source_layout:'typed-v11',source_namespace:sourceNamespace,
   owner_digest:OWNER,device_id:'device-1',manifest_id:'manifest-1',manifest_digest:MANIFEST,day:DAY,
   acquisition_version:GRAPH_DAY_PROJECTION_VERSION,record_count:0,part_count:1,values_digest:'2'.repeat(64),...overrides};
  return target().prepare(`INSERT INTO analytics_graph_day_values
   (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,
    acquisition_version,record_count,part_count,values_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(row.value_key,row.source_id,row.source_layout,row.source_namespace,row.owner_digest,row.device_id,
    row.manifest_id,row.manifest_digest,row.day,row.acquisition_version,row.record_count,row.part_count,
    row.values_digest).run();
 };
 const insertPage=(overrides:Record<string,unknown>={}):Promise<unknown>=>{
  const entries=(overrides.entries as unknown[])??[];
  const row={value_key:'1'.repeat(64),part_index:0,source_id:sourceId,owner_digest:OWNER,day:DAY,
   acquisition_version:GRAPH_DAY_PROJECTION_VERSION,component:'planAnchors',entry_count:entries.length,
   part_digest:'3'.repeat(64),payload_json:canonicalJson({component:overrides.component??'planAnchors',entries}),
   ...overrides};
  return target().prepare(`INSERT INTO analytics_graph_day_pages
   (value_key,part_index,source_id,owner_digest,day,acquisition_version,component,entry_count,part_digest,payload_json)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(row.value_key,row.part_index,row.source_id,row.owner_digest,row.day,
    row.acquisition_version,row.component,row.entry_count,row.part_digest,row.payload_json).run();
 };
 it('adds empty forward-only tables and rewrites no delivered state',async()=>{
  await deliverDay();
  for(const table of ['analytics_graph_day_values','analytics_graph_day_pages']){
   expect(await target().prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>('n'),table).toBe(0);
  }
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_v11_reusable_values').first<number>('n')).toBe(1);
 });
 it('refuses a payload whose usageRowsRead entry is missing or repeated',async()=>{
  const projection=simple();
  const components={planAnchors:[...projection.planAnchors.anchors],
   fitFragments:[...projection.fitFragments.fragments],
   runEndpoints:[...projection.runEndpoints.endpoints],
   usageCells:[...projection.usage.cells],usageOpeners:[...projection.usage.openers],
   usageSessions:[...projection.usage.sessions]};
  // Absent: a read count that never arrived must not decode as zero.
  expect(validGraphDayProjection(graphDayProjectionFromComponents(DAY,components))).toBe(false);
  expect(validGraphDayProjection(graphDayProjectionFromComponents(DAY,
   {...components,usageRowsRead:[projection.usage.rowsRead,projection.usage.rowsRead]}))).toBe(false);
  expect(validGraphDayProjection(graphDayProjectionFromComponents(DAY,
   {...components,usageRowsRead:[projection.usage.rowsRead]}))).toBe(true);
  // And a count below the entries the day retained is a wrong count.
  expect(validGraphDayProjection(graphDayProjectionFromComponents(DAY,
   {...components,usageRowsRead:[0]}))).toBe(false);
 });
 it('closes the stored vocabulary',async()=>{
  await expect(insertValues({acquisition_version:'graph-day-projection-v2'})).rejects.toThrow();
  await expect(insertValues({source_layout:'typed-v1'})).rejects.toThrow();
  await expect(insertValues({source_layout:'json-v11'})).rejects.toThrow();
  await expect(insertValues({day:'2026-9-10'})).rejects.toThrow();
  await expect(insertValues({owner_digest:'z'.repeat(64)})).rejects.toThrow();
  await expect(insertValues({part_count:0})).rejects.toThrow();
  await expect(insertPage({component:'plans'})).rejects.toThrow();
  await expect(insertPage({acquisition_version:'graph-day-projection-v2'})).rejects.toThrow();
  await expect(insertPage({entry_count:3})).rejects.toThrow();
  await expect(insertPage({payload_json:canonicalJson({component:'planAnchors',
   entries:[' '.repeat(300_000)]}),entry_count:1})).rejects.toThrow();
 });
 it('admits a values row only once its whole framed payload exists',async()=>{
  await expect(insertValues({part_count:2})).rejects.toThrow('analytics_graph_day_pages_incomplete');
  await insertPage();
  await expect(insertValues({part_count:2})).rejects.toThrow('analytics_graph_day_pages_incomplete');
  await expect(insertValues({record_count:3})).rejects.toThrow('analytics_graph_day_pages_incomplete');
  await expect(insertValues({day:'2026-09-11'})).rejects.toThrow('analytics_graph_day_pages_incomplete');
  await insertValues();
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(1);
 });
});

describe('prepared graph day builder lane',()=>{
 const build=async(candidate:GraphDayProjectionCandidate)=>reduceGraphDayProjection(candidate.day,
  [input(1,Date.parse(`${candidate.day}T00:01:00.000Z`),10)].map(row=>({...row,
   row:{...row.row!,observed_at:new Date(Date.parse(`${candidate.day}T00:01:00.000Z`)).toISOString(),
    resets_at:new Date(Date.parse(`${candidate.day}T00:00:00.000Z`)+7*86400000).toISOString()},
   observedAtMs:Date.parse(`${candidate.day}T00:01:00.000Z`),
   anchor:anchor(Date.parse(`${candidate.day}T00:01:00.000Z`))})));
 it('is off unless both the deployment switch and the pass option are open',()=>{
  expect(graphDayProjectionBuildEnabled(undefined)).toBe(false);
  expect(graphDayProjectionBuildEnabled({})).toBe(false);
  expect(graphDayProjectionBuildEnabled({GRAPH_DAY_PROJECTION_BUILD:'disabled'})).toBe(false);
  expect(graphDayProjectionBuildEnabled({GRAPH_DAY_PROJECTION_BUILD:true})).toBe(false);
  expect(graphDayProjectionBuildEnabled({GRAPH_DAY_PROJECTION_BUILD:'enabled'})).toBe(true);
 });
 it('prepares only delivered days it has not already prepared',async()=>{
  await deliverDay();
  await deliverDay('2026-09-11','f'.repeat(64),'manifest-2');
  const first=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(first).toMatchObject({state:'progress',built:2,staged:0});
  const second=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(second).toMatchObject({state:'idle',reason:'complete',built:0,candidates:0});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(2);
 });
 it('records a refusal and never re-selects that day until its inputs change',async()=>{
  await deliverDay();
  await deliverDay('2026-09-11','f'.repeat(64),'manifest-2');
  const refusing:GraphDayProjectionBuild=async candidate=>{
   if(candidate.day===DAY)throw new GraphDayProjectionRefusedError('usage_row_refused');
   return build(candidate);
  };
  const first=await advanceGraphDayProjectionLane({target:target(),sourceId,build:refusing,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  // A pass that refused still advanced: it recorded what the next one excludes.
  expect(first).toMatchObject({state:'progress',built:1,refused:1,skipped:0,candidates:2});
  const recorded=await target().prepare(`SELECT day,reason,acquisition_version FROM analytics_graph_day_refusals`)
   .first<{day:string;reason:string;acquisition_version:string}>();
  expect(recorded).toMatchObject({day:DAY,reason:'usage_row_refused',
   acquisition_version:GRAPH_DAY_PROJECTION_VERSION});
  // The refused day is gone from selection, so the lane is genuinely complete.
  const second=await advanceGraphDayProjectionLane({target:target(),sourceId,build:refusing,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(second).toMatchObject({state:'idle',reason:'complete',candidates:0,refused:0,skipped:0});
  // A re-upload of that day restates its manifest digest, which is part of the
  // refusal key, so the day is retried without any operator action.
  await deliverDay(DAY,'9'.repeat(64),'manifest-3');
  const retried=await advanceGraphDayProjectionLane({target:target(),sourceId,build:refusing,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(retried).toMatchObject({state:'progress',refused:1,candidates:1});
  // An owner-scoped, transient failure is NOT recorded: it would exclude that
  // owner's earliest days for good, with no retry short of re-uploading them.
  await deliverDay('2026-09-12','1'.repeat(64),'manifest-4');
  const unresolvable:GraphDayProjectionBuild=async()=>{
   throw new GraphDayProjectionRefusedError('owner_source_unavailable');};
  const before=await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_refusals').first<number>('n');
  const transient=await advanceGraphDayProjectionLane({target:target(),sourceId,build:unresolvable,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  // Skipped, not refused: the counters keep the two apart, which is what says
  // "selected days and prepared none of them" rather than "never opened".
  expect(transient).toMatchObject({state:'progress',built:0,refused:0,skipped:transient.candidates});
  expect(transient.candidates).toBeGreaterThan(0);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_refusals').first<number>('n')).toBe(before);
  // So the same days are still selectable on the next pass.
  const retry=await advanceGraphDayProjectionLane({target:target(),sourceId,build:unresolvable,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(retry.candidates).toBe(transient.candidates);
  // And an erasure fence removes the marker with the rest of the owner state.
  await target().prepare(`INSERT INTO analytics_storage_erasure_fences
   (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
   VALUES(?,?,?,1,1,1,1)`).bind(sourceId,OWNER,'8'.repeat(64)).run();
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_refusals').first<number>('n')).toBe(0);
 });
 it('never opens a statement for an erased owner or an inactive one',async()=>{
  await deliverDay();
  await target().prepare(`INSERT INTO analytics_storage_erasure_fences
   (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
   VALUES(?,?,?,1,1,1,1)`).bind(sourceId,OWNER,'9'.repeat(64)).run();
  expect(await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900})).toMatchObject({state:'idle',candidates:0});
 });
 it('stops on its deadline and on a cut budget, then resumes the same day',async()=>{
  await deliverDay();
  expect(await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()-1,remainingQueries:900})).toMatchObject({state:'deferred',reason:'deadline',built:0});
  expect(await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:3})).toMatchObject({state:'deferred',reason:'query_budget',built:0});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_pages').first<number>('n')).toBe(0);
  // A cut write leaves pages and no values row; the next pass continues from
  // exactly those pages rather than restarting the day.
  const cut=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900,maxWrites:2,maxDays:1});
  expect(cut).toMatchObject({state:'progress',built:0,staged:1});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
  const staged=await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_pages').first<number>('n');
  expect(staged).toBe(1);
  let resumed=cut;
  for(let attempt=0;attempt<16&&resumed.state!=='idle';attempt++){
   resumed=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
    deadlineMs:Date.now()+30_000,remainingQueries:900,maxWrites:2,maxDays:1});
  }
  expect(resumed).toMatchObject({state:'idle',candidates:0});
  const read=await readGraphDayProjection({target:target(),key:key()});
  expect(read.status).toBe('ready');
  if(read.status!=='ready')throw new Error('unreachable');
  expect(read.projection.version).toBe(GRAPH_DAY_PROJECTION_VERSION);
 });
});

describe('production builder over the real source readers',()=>{
 const sourceDb=()=>b.USAGE_MONITOR_DB;
 const bindings=()=>({source:sourceDb(),target:target(),sourceId,sourceNamespace});
 let occurrence=0;
 const quotaRecord=(day:string,hour:number,usedPercent:number)=>({
  schemaVersion:'quota-observation-v1.1' as const,
  observationId:`quota-occurrence:v1:${(occurrence+=1).toString(16).padStart(64,'0')}`,provider:'openai_codex',
  observedTime:`${day}T${hour.toString().padStart(2,'0')}:00:00.000Z`,planType:'pro' as const,planVariant:'unknown',
  limitId:'codex',slot:'seven_day' as const,usedPercent,windowDurationMinutes:10080,
  resetsAt:new Date(Date.parse(`${day}T00:00:00.000Z`)+7*86400000).toISOString(),
  accountPlanAttribution:{accountBasis:'unavailable' as const,accountTrackId:null,
   planBasis:'same_source_occurrence' as const,planType:'pro' as const,planEraId:null}});
 async function source(days:number){
  for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,b.TEST_INGESTION_BRIDGE_MIGRATIONS,
   b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(sourceDb(),migrations);
  await initializeStorageSource(sourceDb(),sourceId);
  await initializeTypedV11Admission(sourceDb(),sourceNamespace);
  await initializeTypedV1Admission(sourceDb(),sourceNamespace);
  await applyD1Migrations(sourceDb(),b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER,b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageAnalyticsRuntime(bindings());
  const device=await createV11DeviceFixture(sourceDb(),{grant:true});
  const today=new Date().toISOString().slice(0,10);
  const entries:TelemetryV11DomainManifest['days']=[];
  for(let n=days-1;n>=0;n--){
   const day=new Date(Date.parse(today)-n*86400000).toISOString().slice(0,10);
   const prepared=await makeV11Day(day,{quota:[quotaRecord(day,1,10+n),quotaRecord(day,5,10+n),quotaRecord(day,9,40+n)],
    usage:[v11UsageRecord(day,'a',{eventId:`event:v2:${(occurrence+=1).toString(16).padStart(64,'0')}`}),
     v11UsageRecord(day,'b',{eventId:`event:v2:${(occurrence+=1).toString(16).padStart(64,'0')}`})]});
   const staged=await registerTelemetryV11DayManifest(sourceDb(),device,prepared.manifest);
   for(const chunk of prepared.chunks){
    const envelopeDigest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const upload=await createDeviceUploadAuthorization(sourceDb(),await authenticateDevice(sourceDb(),device.authorization),envelopeDigest,200);
    const claim=await claimDeviceUploadAuthorization(sourceDb(),`Upload ${upload.uploadAuthorization}`,{envelopeDigest,bodyBytes:200,contentType:'application/json'});
    await persistTypedV11StagedChunk(sourceDb(),device,chunk,{sourceNamespace,chunkRowId:`chunk:${crypto.randomUUID()}`,
     r2Key:`synthetic/${crypto.randomUUID()}`,envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
   }
   entries.push({day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest});
  }
  const prior=await createTelemetryV11DomainPredecessor(sourceDb(),device);
  const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:entries[0]!.day,
   throughDay:today,predecessor:{token:prior.token,previousGenerationId:prior.previousGenerationId,
    legacyFingerprint:prior.legacyFingerprint},days:entries,manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(sourceDb(),device,manifest);
  for(let i=0;i<40;i++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
  const pin=(await loadV11SourcePin(sourceDb(),device.participantId))!;
  const snapshot=await loadTypedV11GenerationSnapshot(sourceDb(),{sourceNamespace,pin});
  const ownerDigest=(await readIngestionChanges(sourceDb(),sourceId,0)).at(-1)!.ownerDigest;
  return {device,snapshot,ownerDigest,days:entries.map(entry=>entry.day)};
 }
 it('builds, stores and reads back the same artifact the reducer produces',async()=>{
  const fixture=await source(3);
  const build=createGraphDayProjectionBuild({source:sourceDb(),sourceNamespace,snapshot:fixture.snapshot,
   windowMinutes:10080,ownerDigest:fixture.ownerDigest});
  const lane=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:900});
  expect(lane).toMatchObject({state:'progress',built:3,staged:0});
  // Cost pin: a day frames one part per non-empty component, so it fits in a
  // single write batch at the default `maxWrites` of 8 and the lane's per-day
  // estimate of 3 + maxWrites statements holds with usage included.
  const parts=await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_pages').first<number>('n');
  expect(parts!/3).toBeLessThanOrEqual(7);
  const prepared=(await target().prepare(`SELECT source_layout,source_namespace,owner_digest,device_id,
    manifest_id,manifest_digest,day FROM analytics_graph_day_values ORDER BY day`).all<Record<string,string>>()).results;
  expect(prepared.map(row=>row.day)).toEqual(fixture.days);
  for(const row of prepared){
   const stored=await readGraphDayProjection({target:target(),key:{sourceId,
    sourceLayout:row.source_layout as 'typed-v11',sourceNamespace,ownerDigest:row.owner_digest!,
    deviceId:row.device_id!,manifestId:row.manifest_id!,manifestDigest:row.manifest_digest!,day:row.day!}});
   expect(stored.status).toBe('ready');
   if(stored.status!=='ready')throw new Error('unreachable');
   // Byte-identical to reducing the same source rows directly.
   const direct=await build({sourceId,sourceLayout:'typed-v11',sourceNamespace,ownerDigest:row.owner_digest!,
    deviceId:row.device_id!,manifestId:row.manifest_id!,manifestDigest:row.manifest_digest!,day:row.day!},
    {deadlineMs:Date.now()+60_000,remainingQueries:256});
   expect(canonicalJson(stored.projection)).toBe(canonicalJson(direct));
   // Both halves are real: quota endpoints AND usage the kernel mapper produced.
   expect(stored.projection.runEndpoints.endpoints.length).toBeGreaterThan(0);
   expect(stored.projection.usage.cells.length+stored.projection.usage.openers.length).toBeGreaterThan(0);
   console.log(JSON.stringify({day:row.day,endpoints:stored.projection.runEndpoints.endpoints.length,
    usageCells:stored.projection.usage.cells.length,usageOpeners:stored.projection.usage.openers.length,
    usageSessions:stored.projection.usage.sessions.length,bytes:canonicalJson(stored.projection).length}));
  }
 });
 it('resumes a day cut mid-write and produces the identical artifact',async()=>{
  const fixture=await source(1);
  const build=createGraphDayProjectionBuild({source:sourceDb(),sourceNamespace,snapshot:fixture.snapshot,
   windowMinutes:10080,ownerDigest:fixture.ownerDigest});
  const cut=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:900,maxWrites:2,maxDays:1});
  expect(cut).toMatchObject({state:'progress',built:0,staged:1});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
  let lane=cut;
  for(let attempt=0;attempt<16&&lane.state!=='idle';attempt++){
   lane=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
    deadlineMs:Date.now()+60_000,remainingQueries:900,maxWrites:2,maxDays:1});
  }
  const row=(await target().prepare('SELECT owner_digest,device_id,manifest_id,manifest_digest,day FROM analytics_graph_day_values')
   .first<Record<string,string>>())!;
  const key={sourceId,sourceLayout:'typed-v11' as const,sourceNamespace,ownerDigest:row.owner_digest!,
   deviceId:row.device_id!,manifestId:row.manifest_id!,manifestDigest:row.manifest_digest!,day:row.day!};
  const stored=await readGraphDayProjection({target:target(),key});
  expect(stored.status).toBe('ready');
  if(stored.status!=='ready')throw new Error('unreachable');
  expect(canonicalJson(stored.projection)).toBe(canonicalJson(
   await build(key,{deadlineMs:Date.now()+60_000,remainingQueries:256})));
 });
 it('builds on its opening minute, and still leaves the graph lane a window',async()=>{
  // Running last is what stalled the builder in production: in steady state the
  // graph lane consumed the whole window, so a lane needing five seconds of
  // remaining clock never opened. On its opening minute it takes a bounded
  // slice first instead.
  const f=await source(1);
  expect(f.days).toHaveLength(1);
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const started=Date.now();
  const pass=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   buildGraphDayProjections:true,graphDayProjectionBuild:build,projectionLaneFirst:true,
   maxSteps:1,maxQueries:900,deadlineMs:started+30_000});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(1);
  // The slice is bounded, so the rest of the window and the meter survive it.
  expect(Date.now()-started).toBeLessThan(25_000);
  expect(pass.queriesUsed).toBeLessThan(900-550);
  expect(pass.reason).not.toBe('query_budget');
 });
 it('reports the lane in the pass summary, including when it prepares nothing',async()=>{
  const f=await source(1);
  expect(f.days).toHaveLength(1);
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const built=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   buildGraphDayProjections:true,graphDayProjectionBuild:build,projectionLaneFirst:true,
   maxSteps:1,maxQueries:900,deadlineMs:Date.now()+30_000});
  expect(built.graphDayProjection).toMatchObject({opened:true,built:1,refused:0,skipped:0,candidates:1});
  expect(built.graphDayProjection!.sourceQueriesUsed).toBeGreaterThan(0);
  // Selected days and prepared none of them: distinguishable from never opening.
  const stalled=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   buildGraphDayProjections:true,projectionLaneFirst:true,maxSteps:1,maxQueries:900,
   graphDayProjectionBuild:async()=>{throw new GraphDayProjectionRefusedError('owner_source_unavailable');},
   graphDayProjectionFromDay:'2020-01-01',deadlineMs:Date.now()+30_000});
  expect(stalled.graphDayProjection).toMatchObject({opened:true,built:0,refused:0});
  // Switched off entirely: no field at all, so absence is unambiguous.
  const off=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   maxSteps:1,maxQueries:900,deadlineMs:Date.now()+30_000});
  expect(off.graphDayProjection).toBeUndefined();
 });
 it('measures one day of source statements and completes many days per opening slot',async()=>{
  // The livelock was an opening slot whose source half was about 18 statements,
  // under the cost of one dense day: the lane started a day, exhausted the
  // allowance part way through and discarded the work, every pass.
  const f=await source(4);
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const first=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:900,sourceQueries:900,maxDays:1});
  expect(first.built).toBe(1);
  // One day: a reader scope, one page per 16,384 quota and 5,000 usage rows,
  // and two generation fences; the first day of an owner adds four more to
  // resolve its link, pin and snapshot.
  const firstDay=first.sourceQueriesUsed;
  const second=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:900,sourceQueries:900,maxDays:1});
  expect(second.built).toBe(1);
  const perDay=second.sourceQueriesUsed;
  console.log(JSON.stringify({firstDayWithOwnerResolution:firstDay,perDayAfterwards:perDay}));
  expect(firstDay).toBe(perDay+4);
  expect(perDay).toBe(5);
  // The opening slot's source half at a 250-statement allowance.
  const slot=await advanceGraphDayProjectionLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:125,sourceQueries:125,maxDays:8});
  expect(slot.built).toBe(2);
  expect(slot.state).toBe('progress');
  // Nothing is discarded: every day it started, it finished.
  expect(slot.staged).toBe(0);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(4);
 });
 it('funds the opening slot on a meter too small for the graph floor, and not otherwise',async()=>{
  // Production symptom: the public pass starts with the worker meter's
  // remainder, so reserving the graph lane's 550 floor first left the opening
  // slot with no source budget and it selected candidates it could never fund.
  const f=await source(2);
  expect(f.days).toHaveLength(2);
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const opening=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   buildGraphDayProjections:true,graphDayProjectionBuild:build,projectionLaneFirst:true,
   maxSteps:1,maxQueries:500,deadlineMs:Date.now()+30_000});
  // 500 is well under the 650 the trailing slot would reserve, yet the slice is
  // funded and days are built.
  expect(opening.graphDayProjection).toMatchObject({opened:true,state:'progress'});
  expect(opening.graphDayProjection!.sourceQueriesUsed).toBeGreaterThan(0);
  expect(opening.graphDayProjection!.built).toBeGreaterThan(0);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n'))
   .toBe(opening.graphDayProjection!.built);
  // The slice stays bounded even though the floor is not reserved ahead of it.
  expect(opening.graphDayProjection!.sourceQueriesUsed).toBeLessThanOrEqual(125);
 });
 it('leaves the graph lane its whole floor on an ordinary minute',async()=>{
  const f=await source(2);
  expect(f.days).toHaveLength(2);
  let built=0;
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const ordinary=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   buildGraphDayProjections:true,projectionLaneFirst:false,maxSteps:1,maxQueries:500,
   graphDayProjectionBuild:async(candidate,budget)=>{built+=1;return build(candidate,budget);},
   deadlineMs:Date.now()+30_000});
  // On a trailing minute the graph lane's 550 floor is still reserved first, so
  // a 500-statement pass funds no builder slice at all and nothing is spent.
  expect(built).toBe(0);
  expect(ordinary.graphDayProjection).toMatchObject({opened:false,built:0,sourceQueriesUsed:0});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
 });
 it('takes the bulk of the long pass while coverage is incomplete, and nothing once it is not',async()=>{
  const f=await source(3);
  expect(f.days).toHaveLength(3);
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const long=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   graphOnly:true,graphLeaseMs:570_000,buildGraphDayProjections:true,graphDayProjectionLongPass:true,
   graphDayProjectionBuild:build,maxSteps:2,maxQueries:900,deadlineMs:Date.now()+30_000});
  // The counters carry the split, so one line says how much of the long pass
  // each lane got.
  expect(long.graphDayProjection).toMatchObject({opened:true,slot:'long',sliceMs:6*60_000});
  // The counters accumulate across the pass's iterations rather than reporting
  // only the last, so a pass that finished its selection early still shows it.
  expect(long.graphDayProjection!.built).toBe(3);
  expect(long.graphDayProjection!.candidates).toBe(3);
  expect(long.graphDayProjection!.sourceQueriesUsed).toBeGreaterThan(0);
  expect(long.graphDayProjection!.elapsedMs).toBeLessThan(30_000);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(3);
  // Coverage complete: the lane costs one selection statement and the long pass
  // reverts to what it does today, so this ends by itself.
  const done=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   graphOnly:true,graphLeaseMs:570_000,buildGraphDayProjections:true,graphDayProjectionLongPass:true,
   graphDayProjectionBuild:build,maxSteps:2,maxQueries:900,deadlineMs:Date.now()+30_000});
  expect(done.graphDayProjection).toMatchObject({opened:true,slot:'long',built:0,candidates:0,
   state:'idle',reason:'complete',sourceQueriesUsed:0});
 });
 it('never opens the builder in a long pass without its own switch',async()=>{
  const f=await source(2);
  expect(f.days).toHaveLength(2);
  let called=0;
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  const pass=await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   graphOnly:true,graphLeaseMs:570_000,buildGraphDayProjections:true,maxSteps:2,maxQueries:900,
   graphDayProjectionBuild:async(candidate,budget)=>{called+=1;return build(candidate,budget);},
   deadlineMs:Date.now()+30_000});
  expect(called).toBe(0);
  expect(pass.graphDayProjection).toBeUndefined();
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
 });
 it('does not open the builder twice in one iteration',async()=>{
  const f=await source(1);
  expect(f.days).toHaveLength(1);
  let calls=0;
  const build=createGraphDayProjectionSourceBuild({source:sourceDb(),sourceNamespace});
  await runStorageAnalyticsPass({...bindings(),publishCommunity:true,publicOnly:true,
   buildGraphDayProjections:true,projectionLaneFirst:true,maxSteps:1,maxQueries:900,
   graphDayProjectionBuild:async(candidate,budget)=>{calls+=1;return build(candidate,budget);},
   deadlineMs:Date.now()+30_000});
  // One day, one build: the opening slot replaces the trailing run rather than
  // adding to it, so the lane cannot take two slices from one iteration.
  expect(calls).toBe(1);
 });
 it('builds a day from the scheduler only when the deployment switch is set',async()=>{
  const fixture=await source(1);
  const env={STORAGE_ANALYTICS_MODE:'enabled' as const,PUBLIC_ANALYTICS_MODE:'disabled' as const,
   STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,
   STORAGE_INGESTION_DB:sourceDb(),STORAGE_ANALYTICS_DB:target(),DELETION_LEDGER:b.DELETION_LEDGER};
  expect(fixture.days).toHaveLength(1);
  // Switch absent: the scheduler composes no builder and stores nothing.
  await runStorageAnalyticsSchedule(env);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
  await runStorageAnalyticsSchedule({...env,GRAPH_DAY_PROJECTION_BUILD:'disabled'});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_graph_day_values').first<number>('n')).toBe(0);
  // Switch set: the same scheduler call prepares the delivered day end to end.
  await runStorageAnalyticsSchedule({...env,GRAPH_DAY_PROJECTION_BUILD:'enabled'});
  const rows=(await target().prepare('SELECT day,owner_digest FROM analytics_graph_day_values').all<{day:string}>()).results;
  expect(rows.map(row=>row.day)).toEqual(fixture.days);
 });
 it('never lets a raw session identifier reach a stored payload',async()=>{
  const fixture=await source(1);
  const sessionUuid='0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b';
  const digest=await graphDayUsageSessionDigest({ownerDigest:'a'.repeat(64),provider:'openai_codex',sessionUuid});
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(digest).not.toContain(sessionUuid);
  // The same uuid under two owners is two different keys inside the store.
  expect(await graphDayUsageSessionDigest({ownerDigest:'b'.repeat(64),provider:'openai_codex',sessionUuid}))
   .not.toBe(digest);
  const build=createGraphDayProjectionBuild({source:sourceDb(),sourceNamespace,snapshot:fixture.snapshot,
   windowMinutes:10080,ownerDigest:fixture.ownerDigest});
  await advanceGraphDayProjectionLane({target:target(),sourceId,build,deadlineMs:Date.now()+60_000,remainingQueries:900});
  const payloads=(await target().prepare('SELECT payload_json FROM analytics_graph_day_pages').all<{payload_json:string}>()).results;
  expect(payloads.length).toBeGreaterThan(0);
  for(const row of payloads)expect(row.payload_json).not.toContain(sessionUuid);
  // The stored session keys are digests of this exact derivation, never uuids.
  const stored=payloads.flatMap(row=>(JSON.parse(row.payload_json) as {component:string;entries:unknown[]})
   .component==='usageSessions'?(JSON.parse(row.payload_json) as {entries:{sessionDigest:string}[]}).entries:[]);
  expect(stored.length).toBeGreaterThan(0);
  for(const session of stored)expect(session.sessionDigest).toMatch(/^[0-9a-f]{64}$/);
 });
});
