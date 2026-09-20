import {env,reset,applyD1Migrations,type D1Migration} from 'cloudflare:test';
import {beforeEach,describe,expect,it} from 'vitest';
import {canonicalJson} from '../src/canonical-json';
import {sha256Hex} from '../src/crypto';
import {
 CACHE_RETENTION_BAND_IDS,
 CACHE_RETENTION_CAPTION,
 CACHE_RETENTION_METHOD,
 CACHE_RETENTION_METRIC_ID,
 CACHE_RETENTION_TITLE,
 CacheRetentionRefusedError,
 cacheRetentionBandFor,
 mergeCacheRetentionBands,
 reduceCacheRetentionDay,
 validCacheRetentionDayAggregate,
 type CacheRetentionBandId,
 type CacheRetentionBandRow,
 type CacheRetentionDayAggregate,
 type CacheRetentionEvent,
 type CacheRetentionItem,
} from '../src/cache-retention-values';
import {
 CACHE_RETENTION_SESSION_DIGEST_METHOD,
 advanceCacheRetentionDayLane,
 cacheRetentionCarryDigest,
 cacheRetentionDayMarkKey,
 cacheRetentionDayValueKey,
 cacheRetentionEventFromRecord,
 cacheRetentionLookbackDays,
 cacheRetentionSessionDigest,
 createCacheRetentionDayBuild,
 createCacheRetentionDaySourceBuild,
 readCacheRetentionCarryDays,
 readCacheRetentionCommunityBands,
 readCacheRetentionDay,
 retireCacheRetentionDayPage,
 writeCacheRetentionDay,
 type CacheRetentionCarryDay,
 type CacheRetentionDayBuild,
 type CacheRetentionDayCandidate,
} from '../src/cache-retention-day';
import {cacheRetentionBuildEnabled,runCacheRetentionDaySchedule} from '../src/cache-retention-day-worker';
import {initializeStorageSource,readIngestionChanges} from '../src/analytics-delivery';
import {initializeStorageAnalyticsRuntime,advanceStorageAnalytics} from '../src/storage-analytics-runtime';
import {initializeTypedV11Admission,persistTypedV11StagedChunk} from '../src/typed-v11-admission';
import {initializeTypedV1Admission} from '../src/typed-v1-admission';
import {registerTelemetryV11DayManifest} from '../src/telemetry-v11-repository';
import {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor,loadV11SourcePin} from '../src/telemetry-v11-domain';
import {loadTypedV11GenerationSnapshot} from '../src/typed-v11-quota-reader';
import {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from '../src/device-auth';
import {telemetryV11DomainManifestDigestInput,type TelemetryV11DomainManifest} from '@app-usagemonitor/telemetry-contract';
import {createV11DeviceFixture,makeV11Day,v11UsageRecord} from './helpers/telemetry-v11';

const b=env as Env&{STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[];
 TEST_MIGRATIONS:D1Migration[];TEST_TYPED_INGESTION_MIGRATIONS:D1Migration[];
 TEST_INGESTION_BRIDGE_MIGRATIONS:D1Migration[];TEST_TYPED_V11_ADMISSION_MIGRATIONS:D1Migration[];
 TEST_TYPED_V1_ADMISSION_MIGRATIONS:D1Migration[];TEST_INGESTION_ISOLATION_MIGRATIONS:D1Migration[];
 TEST_DELETION_LEDGER_MIGRATIONS:D1Migration[]};
const target=()=>b.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-retention',sourceNamespace='synthetic-retention-original';
const OWNER='a'.repeat(64),MANIFEST='b'.repeat(64),REGISTRY='c'.repeat(64);
const DAY='2026-09-10',DAY_MS=Date.parse(`${DAY}T00:00:00.000Z`);
const SESSION_A='1'.repeat(64),SESSION_B='2'.repeat(64);

const key=(overrides:Partial<CacheRetentionDayCandidate>={}):CacheRetentionDayCandidate=>({
 sourceId,sourceLayout:'typed-v11',sourceNamespace,ownerDigest:OWNER,deviceId:'device-1',
 manifestId:'manifest-1',manifestDigest:MANIFEST,day:DAY,...overrides});

/** Seven contiguous lookback entries, oldest first, as the store requires. */
const carryFor=(day=DAY,delivered:Record<string,string>={}):CacheRetentionCarryDay[]=>
 cacheRetentionLookbackDays(day).map(back=>({day:back,manifestDigest:delivered[back]??''}));

let sequence=0;
const ev=(offsetMs:number,overrides:Partial<CacheRetentionEvent>={}):CacheRetentionEvent=>({
 sessionDigest:SESSION_A,observedAtMs:DAY_MS+offsetMs,
 orderKey:`occ-${(sequence+=1).toString().padStart(8,'0')}`,
 model:'gpt-5.6-sol',effort:'high',speedMode:'standard',surface:'local_interactive_unclassified',
 cacheReadTokens:900,uncachedTokens:100,cacheWriteTokens:0,...overrides});

const reduce=(events:readonly CacheRetentionItem[],carry:readonly CacheRetentionEvent[]=[],
 eventsRead=events.length):CacheRetentionDayAggregate=>
 reduceCacheRetentionDay({day:DAY,events,carry,eventsRead});

const bandOf=(aggregate:CacheRetentionDayAggregate,band:CacheRetentionBandId,group=0)=>
 aggregate.groups[group]!.bands.find(entry=>entry.band===band)!;

beforeEach(async()=>{
 sequence=0;
 await reset();
 await applyD1Migrations(target(),b.TEST_ANALYTICS_MIGRATIONS);
 await target().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)')
  .bind(sourceId,sourceNamespace).run();
 await target().prepare('INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,?)')
  .bind(sourceId,OWNER,'active').run();
});

/** One delivered v1.1 day, in the reusable shape the lane selects from. */
async function deliverDay(day=DAY,manifestDigest=MANIFEST,manifestId='manifest-1',
 owner=OWNER,deviceId='device-1'):Promise<void>{
 const values=canonicalJson({counts:{quota:0,session:0,usage:1},day,pricingMethodVersion:'synthetic-pricing',
  registrySha256:REGISTRY,schemaVersion:'synthetic-values-v1'});
 await target().prepare(`INSERT INTO analytics_v11_reusable_values
  (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,
   schema_version,pricing_method,registry_sha256,record_count,values_digest,values_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(await sha256Hex(`${owner}:${deviceId}:${day}:${manifestDigest}:${manifestId}`),sourceId,
   'typed-v11',sourceNamespace,owner,deviceId,manifestId,manifestDigest,day,'synthetic-values-v1',
   'synthetic-pricing',REGISTRY,1,await sha256Hex(values),values).run();
}

describe('the cache-retention method contract',()=>{
 it('names a retention curve, never a hit rate, and says what it measured',()=>{
  expect(CACHE_RETENTION_METRIC_ID).toBe('cache_retention_by_pause');
  expect(CACHE_RETENTION_METHOD.metric).toBe(CACHE_RETENTION_METRIC_ID);
  expect(CACHE_RETENTION_TITLE).toBe('How long a cached prefix survives a pause');
  // The measured reason this caption exists: sub-minute adjacencies are 97.6%
  // intra-turn, which inflates apparent reuse from 94.8% to 99.1% and
  // over-weights that band 49x. A reader must see that these are consecutive
  // requests, not user turns.
  expect(CACHE_RETENTION_CAPTION).toContain('consecutive requests');
  expect(CACHE_RETENTION_CAPTION).toContain('not across user turns');
  expect(CACHE_RETENTION_CAPTION).toContain('not comparable');
  expect(CACHE_RETENTION_CAPTION).toContain('not a cache hit rate');
  for(const text of [CACHE_RETENTION_METRIC_ID,CACHE_RETENTION_TITLE]){
   expect(text.toLowerCase()).not.toContain('hit rate');
   expect(text.toLowerCase()).not.toContain('continuity');
  }
 });
 it('pins the whole governing method to its own version',async()=>{
  // The ratchet. Every rule the reduction reads lives on this one object and
  // so does the version written into every stored row, so a change to any of
  // them fails here until `version` is bumped AND the migration's closed
  // `method_version` enum is widened. This repository has already shipped the
  // opposite arrangement once -- a runtime switch that changed behaviour while
  // a separate constant named the key -- and this is what makes that
  // impossible here.
  expect(await sha256Hex(canonicalJson(CACHE_RETENTION_METHOD)))
   .toBe('52e81da46d7b09607d1382ddd9f375f4a8e08689d6d6ff06f1d3dfb92938748e');
  expect(CACHE_RETENTION_METHOD.version).toBe('cache-retention-v2');
  expect(CACHE_RETENTION_METHOD.merge).toBe('pooled');
  expect(CACHE_RETENTION_METHOD.lookbackDays).toBe(7);
  expect(CACHE_RETENTION_METHOD.minimumGapMs).toBe(0);
 });
 it('carries the method version inside every row identity',async()=>{
  const carry=carryFor(),carryDigest=await cacheRetentionCarryDigest(carry);
  const identity={sourceId,sourceLayout:'typed-v11',sourceNamespace,ownerDigest:OWNER,
   deviceId:'device-1',manifestId:'manifest-1',manifestDigest:MANIFEST,day:DAY};
  expect(await cacheRetentionDayMarkKey(key(),carryDigest)).toBe(
   await sha256Hex(canonicalJson({...identity,methodVersion:CACHE_RETENTION_METHOD.version,carryDigest})));
  expect(await cacheRetentionDayValueKey(key(),carryDigest,'gpt-5.6-sol','high')).toBe(
   await sha256Hex(canonicalJson({...identity,methodVersion:CACHE_RETENTION_METHOD.version,
    carryDigest,model:'gpt-5.6-sol',effort:'high'})));
  // The two dimensions separate rows, and so does the carry.
  expect(await cacheRetentionDayValueKey(key(),carryDigest,'gpt-5.6-sol','medium'))
   .not.toBe(await cacheRetentionDayValueKey(key(),carryDigest,'gpt-5.6-sol','high'));
  const other=await cacheRetentionCarryDigest(carryFor(DAY,{[cacheRetentionLookbackDays(DAY)[0]!]:MANIFEST}));
  expect(await cacheRetentionDayMarkKey(key(),other)).not.toBe(await cacheRetentionDayMarkKey(key(),carryDigest));
 });
 it('cuts the local lens\'s nine bands, plus a split of its 1-6h bucket',()=>{
  // The vocabulary is the local dashboard's nine, with 1-6h split at two hours.
  // The seven-band first cut merged 1-2m with 2-5m and 5-10m with 10-30m, which
  // is precisely where the measured curve bends, so it reported their mean and
  // hid the bend.
  expect(CACHE_RETENTION_BAND_IDS).toEqual(['under_one_minute','one_to_two_minutes',
   'two_to_five_minutes','five_to_ten_minutes','ten_to_thirty_minutes',
   'thirty_minutes_to_one_hour','one_to_two_hours','two_to_six_hours',
   'six_to_twenty_four_hours','over_twenty_four_hours']);
  // Half-open [start, end): a boundary instant belongs to the band it opens.
  expect(cacheRetentionBandFor(0)).toBe('under_one_minute');
  expect(cacheRetentionBandFor(59_999)).toBe('under_one_minute');
  expect(cacheRetentionBandFor(60_000)).toBe('one_to_two_minutes');
  expect(cacheRetentionBandFor(2*60_000)).toBe('two_to_five_minutes');
  expect(cacheRetentionBandFor(5*60_000)).toBe('five_to_ten_minutes');
  expect(cacheRetentionBandFor(10*60_000)).toBe('ten_to_thirty_minutes');
  expect(cacheRetentionBandFor(30*60_000)).toBe('thirty_minutes_to_one_hour');
  expect(cacheRetentionBandFor(60*60_000)).toBe('one_to_two_hours');
  expect(cacheRetentionBandFor(2*60*60_000)).toBe('two_to_six_hours');
  expect(cacheRetentionBandFor(6*60*60_000)).toBe('six_to_twenty_four_hours');
  expect(cacheRetentionBandFor(86_400_000)).toBe('over_twenty_four_hours');
  // The lens is bounded by the same 7 days the local display maximum uses, and
  // a gap outside it is outside the lens rather than folded into the last band.
  expect(cacheRetentionBandFor(7*86_400_000)).toBe('over_twenty_four_hours');
  expect(cacheRetentionBandFor(7*86_400_000+1)).toBeNull();
  expect(cacheRetentionBandFor(-1)).toBeNull();
 });
});

describe('the cache-retention reduction',()=>{
 it('bands a pair by its gap and scores the prefix that survived it',()=>{
  // `uncachedTokens` grows as the cache gives way, so every pair still has a
  // prompt large enough to have held the previous prefix; a shrinking one is
  // the context-contracted exclusion, exercised separately below.
  const aggregate=reduce([
   ev(0,{cacheReadTokens:1_000}),
   ev(30_000,{cacheReadTokens:1_000}),                     // under a minute, matched
   ev(30_000+10*60_000,{cacheReadTokens:600,uncachedTokens:500}),  // 5-30 min, more than half
   ev(30_000+10*60_000+2*3_600_000,{cacheReadTokens:100,uncachedTokens:1_000}), // 1-6 h, half or less
  ]);
  expect(aggregate.groups).toHaveLength(1);
  expect(aggregate.groups[0]).toMatchObject({model:'gpt-5.6-sol',effort:'high',adjacencies:3,sessions:1});
  expect(bandOf(aggregate,'under_one_minute')).toMatchObject({adjacencies:1,
   reusedMoreThanHalf:1,matchedOrExceeded:1,unorderedTies:0,sessions:1});
  expect(bandOf(aggregate,'ten_to_thirty_minutes')).toMatchObject({adjacencies:1,
   reusedMoreThanHalf:1,matchedOrExceeded:0});
  expect(bandOf(aggregate,'two_to_six_hours')).toMatchObject({adjacencies:1,
   reusedMoreThanHalf:0,matchedOrExceeded:0});
  expect(validCacheRetentionDayAggregate(aggregate)).toBe(true);
 });
 it('treats "more than half" as strictly more than half',()=>{
  const exactly=reduce([ev(0,{cacheReadTokens:1_000}),
   ev(1_000,{cacheReadTokens:500,uncachedTokens:600})]);
  expect(bandOf(exactly,'under_one_minute')).toMatchObject({adjacencies:1,reusedMoreThanHalf:0});
  const over=reduce([ev(0,{cacheReadTokens:1_000}),
   ev(1_000,{cacheReadTokens:501,uncachedTokens:600})]);
  expect(bandOf(over,'under_one_minute')).toMatchObject({adjacencies:1,reusedMoreThanHalf:1,
   matchedOrExceeded:0});
 });
 it('counts an equal instant as an unordered tie rather than proven order',()=>{
  const aggregate=reduce([ev(5_000),ev(5_000)]);
  expect(bandOf(aggregate,'under_one_minute')).toMatchObject({adjacencies:1,unorderedTies:1});
 });
 it('is not an adjacency at all when the configuration changed',()=>{
  for(const change of [{model:'gpt-5.6-terra'},{effort:'medium'},{speedMode:'priority'},
   {surface:'cloud_task'}]){
   const aggregate=reduce([ev(0),ev(1_000,change)]);
   // No group at all: a changed configuration is a different question, not a
   // failed return, and must never land in a retention band.
   expect(aggregate.groups).toHaveLength(0);
  }
 });
 it('separates two sessions and never pairs across them',()=>{
  const aggregate=reduce([ev(0,{sessionDigest:SESSION_A,cacheReadTokens:1_000}),
   ev(1_000,{sessionDigest:SESSION_B,cacheReadTokens:1_000}),
   ev(2_000,{sessionDigest:SESSION_A,cacheReadTokens:1_000}),
   ev(3_000,{sessionDigest:SESSION_B,cacheReadTokens:1_000})]);
  expect(aggregate.groups[0]).toMatchObject({adjacencies:2,sessions:2});
 });
 it('counts the two exclusions per band instead of scoring them as reuse',()=>{
  const aggregate=reduce([
   ev(0,{cacheReadTokens:0}),
   ev(1_000,{cacheReadTokens:500}),                       // previous cache read 0
   ev(2_000,{cacheReadTokens:100,uncachedTokens:10}),      // total input below the prefix
   ev(3_000,{cacheReadTokens:100,uncachedTokens:1_000}),   // comparable
   ev(4_000,{cacheReadTokens:null,uncachedTokens:1_000}),  // current cache read absent
  ]);
  const band=bandOf(aggregate,'under_one_minute');
  expect(band.excludedInsufficientEvidence).toBe(2);
  expect(band.excludedContextContracted).toBe(1);
  expect(band.adjacencies).toBe(1);
 });
 it('never coerces an absent token component to zero',()=>{
  // A missing component is the difference between "no reuse" and "unknown".
  const aggregate=reduce([ev(0,{cacheReadTokens:1_000}),
   ev(1_000,{cacheReadTokens:1_000,uncachedTokens:null})]);
  const band=bandOf(aggregate,'under_one_minute');
  expect(band.adjacencies).toBe(0);
  expect(band.excludedInsufficientEvidence).toBe(1);
  expect(band.reusedMoreThanHalf).toBe(0);
 });
 it('breaks the session chain on an unreadable row instead of dropping it',()=>{
  // Dropping it would pair the following event with an older one and overstate
  // retention; the break is what keeps the number honest.
  const first=ev(0,{cacheReadTokens:1_000});
  const broken:CacheRetentionItem={sessionDigest:SESSION_A,observedAtMs:DAY_MS+1_000,
   orderKey:'occ-99999999',unreadable:true};
  const third=ev(2_000,{cacheReadTokens:1_000});
  expect(reduce([first,broken,third],[],3).groups).toHaveLength(0);
  expect(reduce([first,broken,third],[],3).unreadableEvents).toBe(1);
  // Without the break the same three rows would have produced one adjacency.
  expect(bandOf(reduce([first,third]),'under_one_minute').adjacencies).toBe(1);
 });
 it('attributes a pair crossing midnight to the current day, from the carry',()=>{
  const previous:CacheRetentionEvent={...ev(0,{cacheReadTokens:1_000}),
   observedAtMs:DAY_MS-2*3_600_000};
  const aggregate=reduce([ev(0,{cacheReadTokens:900})],[previous]);
  expect(bandOf(aggregate,'two_to_six_hours')).toMatchObject({adjacencies:1,reusedMoreThanHalf:1});
 });
 it('drops a pair whose gap is outside the bounded lookback',()=>{
  const previous:CacheRetentionEvent={...ev(0,{cacheReadTokens:1_000}),
   observedAtMs:DAY_MS-7*86_400_000};
  const aggregate=reduce([ev(23*3_600_000,{cacheReadTokens:900})],[previous]);
  expect(aggregate.groups).toHaveLength(0);
 });
 it('keeps only the last carry event per session whatever order it arrives in',()=>{
  const older:CacheRetentionEvent={...ev(0,{cacheReadTokens:1_000}),observedAtMs:DAY_MS-6*86_400_000};
  const newer:CacheRetentionEvent={...ev(0,{cacheReadTokens:200}),observedAtMs:DAY_MS-45*60_000};
  const aggregate=reduce([ev(0,{cacheReadTokens:180})],[newer,older]);
  expect(bandOf(aggregate,'thirty_minutes_to_one_hour')).toMatchObject({adjacencies:1,
   reusedMoreThanHalf:1});
  expect(bandOf(aggregate,'over_twenty_four_hours').adjacencies).toBe(0);
 });
 it('refuses an out-of-order or out-of-day stream rather than sorting it silently',()=>{
  expect(()=>reduce([ev(2_000),{...ev(0),orderKey:'occ-00000001'}])).toThrow('CACHE_RETENTION_ORDER_INVALID');
  expect(()=>reduce([{...ev(0),observedAtMs:DAY_MS-1}])).toThrow('CACHE_RETENTION_EVENT_INVALID');
  expect(()=>reduce([{...ev(0),observedAtMs:DAY_MS+86_400_000}])).toThrow('CACHE_RETENTION_EVENT_INVALID');
  expect(()=>reduceCacheRetentionDay({day:'2026-09-31',events:[],carry:[],eventsRead:0}))
   .toThrow('CACHE_RETENTION_INPUT_INVALID');
 });
 it('cuts one row per model and effort',()=>{
  const aggregate=reduce([
   ev(0,{cacheReadTokens:1_000}),ev(1_000,{cacheReadTokens:1_000}),
   ev(2_000,{sessionDigest:SESSION_B,model:'gpt-5.6-terra',cacheReadTokens:1_000}),
   ev(3_000,{sessionDigest:SESSION_B,model:'gpt-5.6-terra',cacheReadTokens:1_000}),
  ]);
  expect(aggregate.groups.map(group=>[group.model,group.effort]))
   .toEqual([['gpt-5.6-sol','high'],['gpt-5.6-terra','high']]);
 });
 it('maps a stored usage record without reading anything outside the allowlist',()=>{
  const record=v11UsageRecord(DAY);
  const mapped=cacheRetentionEventFromRecord({sessionDigest:SESSION_A,observedAtMs:DAY_MS,
   orderKey:'occ-1',recordJson:JSON.stringify(record)});
  expect(mapped).toEqual({sessionDigest:SESSION_A,observedAtMs:DAY_MS,orderKey:'occ-1',
   model:'gpt-5.6-sol',effort:'high',speedMode:'standard',
   surface:'local_interactive_unclassified',cacheReadTokens:900,uncachedTokens:100,cacheWriteTokens:0});
  // Outside the population: a quota-only or bookkeeping row must not consume
  // an adjacency boundary, so it is dropped rather than made a break.
  expect(cacheRetentionEventFromRecord({sessionDigest:SESSION_A,observedAtMs:DAY_MS,orderKey:'occ-2',
   recordJson:JSON.stringify({...record,components:{...record.components,inputUncachedTokens:0,
    inputCacheReadTokens:0,inputCacheWriteTokens:0}})})).toBeNull();
  // Unreadable configuration is a break, never a guess.
  for(const broken of ['not json',JSON.stringify({schemaVersion:'usage-event-v1.0'}),
   JSON.stringify({...record,modelId:'a model with spaces'}),
   JSON.stringify({...record,components:null})]){
   expect(cacheRetentionEventFromRecord({sessionDigest:SESSION_A,observedAtMs:DAY_MS,
    orderKey:'occ-3',recordJson:broken})).toMatchObject({unreadable:true});
  }
 });
});

describe('the community merge',()=>{
 const row=(ownerDigest:string,band:CacheRetentionBandId,adjacencies:number,
  reused:number):CacheRetentionBandRow=>({ownerDigest,band,adjacencies,
   reusedMoreThanHalf:reused,matchedOrExceeded:0,unorderedTies:0,
   excludedInsufficientEvidence:0,excludedContextContracted:0,sessions:Math.min(1,adjacencies)});
 it('pools, so the participant holding the most evidence carries the most weight',()=>{
  // The owner's decision, and the one the plan originally advised against. The
  // subject being measured is the provider's caching behaviour, not the
  // contributors, so a 900-pair contributor SHOULD outweigh two 50-pair ones.
  const merged=mergeCacheRetentionBands([
   row('1'.repeat(64),'under_one_minute',900,891),
   row('2'.repeat(64),'under_one_minute',50,25),
   row('3'.repeat(64),'under_one_minute',50,25),
  ]);
  const band=merged.find(entry=>entry.band==='under_one_minute')!;
  expect(band.adjacencies).toBe(1_000);
  expect(band.reusedMoreThanHalfRate).toBeCloseTo(0.941,3);
  // A per-contributor median would have answered 0.5 here.
  expect(band.reusedMoreThanHalfRate).toBeGreaterThan(0.9);
 });
 it('publishes the contributor count and concentration with every band',()=>{
  const merged=mergeCacheRetentionBands([
   row('1'.repeat(64),'over_twenty_four_hours',100,6),
   row('2'.repeat(64),'over_twenty_four_hours',26,2),
  ]);
  const band=merged.find(entry=>entry.band==='over_twenty_four_hours')!;
  // The plan advised withholding this band at two contributors. The owner's
  // decision is to publish it WITH its count visible instead.
  expect(band.contributors).toBe(2);
  expect(band.adjacencies).toBe(126);
  expect(band.topContributorShare).toBeCloseTo(100/126,6);
  expect(band.reusedMoreThanHalfRate).toBeCloseTo(8/126,6);
 });
 it('returns every band, and null rather than zero where there is no evidence',()=>{
  const merged=mergeCacheRetentionBands([row('1'.repeat(64),'under_one_minute',10,9)]);
  expect(merged.map(band=>band.band)).toEqual([...CACHE_RETENTION_BAND_IDS]);
  const empty=merged.find(band=>band.band==='two_to_six_hours')!;
  expect(empty.adjacencies).toBe(0);
  expect(empty.contributors).toBe(0);
  expect(empty.reusedMoreThanHalfRate).toBeNull();
  expect(empty.topContributorShare).toBeNull();
 });
 it('refuses a malformed row rather than folding it in',()=>{
  expect(()=>mergeCacheRetentionBands([{...row('1'.repeat(64),'under_one_minute',1,2)}]))
   .toThrow('CACHE_RETENTION_ROW_INVALID');
  expect(()=>mergeCacheRetentionBands([{...row('zz','under_one_minute',1,1)}]))
   .toThrow('CACHE_RETENTION_ROW_INVALID');
 });
});

describe('the prepared cache-retention store',()=>{
 const aggregate=()=>reduce([ev(0,{cacheReadTokens:1_000}),ev(1_000,{cacheReadTokens:1_000}),
  ev(3*3_600_000,{cacheReadTokens:100}),
  ev(3*3_600_000+1_000,{sessionDigest:SESSION_B,model:'gpt-5.6-terra',cacheReadTokens:1_000}),
  ev(3*3_600_000+2_000,{sessionDigest:SESSION_B,model:'gpt-5.6-terra',cacheReadTokens:900})],[],9);
 it('writes and reads back the identical aggregate',async()=>{
  const carry=carryFor(),built=aggregate();
  const write=await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:built});
  expect(write).toMatchObject({status:'stored',valueCount:2});
  const read=await readCacheRetentionDay({target:target(),key:key(),carry});
  expect(read.status).toBe('ready');
  if(read.status!=='ready')throw new Error('unreachable');
  expect(canonicalJson(read.aggregate)).toBe(canonicalJson(built));
  const rows=await target().prepare(`SELECT COUNT(*) n FROM analytics_cache_retention_day_bands`)
   .first<number>('n');
  expect(rows).toBe(20);
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_cache_retention_day_carry')
   .first<number>('n')).toBe(7);
 });
 it('pools every retained owner-day into one band row per owner',async()=>{
  // The community reader: what the published curve is computed from. Two
  // owners, two days each, so the aggregate has to fold across BOTH axes -- a
  // reader that grouped by day, or dropped an owner, still returns rows.
  const dayAggregate=(day:string)=>{
   const shift=Date.parse(`${day}T00:00:00.000Z`)-DAY_MS;
   return reduceCacheRetentionDay({day,carry:[],eventsRead:9,events:[
    ev(shift,{cacheReadTokens:1_000}),ev(shift+1_000,{cacheReadTokens:1_000}),
    ev(shift+3*3_600_000,{cacheReadTokens:100}),
    ev(shift+3*3_600_000+1_000,{sessionDigest:SESSION_B,model:'gpt-5.6-terra',cacheReadTokens:1_000}),
    ev(shift+3*3_600_000+2_000,{sessionDigest:SESSION_B,model:'gpt-5.6-terra',cacheReadTokens:900})]});
  };
  const second='9'.repeat(64),days=['2026-09-10','2026-09-11'];
  for(const owner of [OWNER,second]){
   for(const day of days){
    await writeCacheRetentionDay({target:target(),key:key({ownerDigest:owner,day}),
     carry:carryFor(day),aggregate:dayAggregate(day)});
   }
  }
  const rows=await readCacheRetentionCommunityBands({target:target(),sourceId});
  expect(new Set(rows.map(row=>row.ownerDigest))).toEqual(new Set([OWNER,second]));
  // One row per (owner, band), never one per day: the count cannot grow with
  // the corpus, which is what makes a single statement safe here.
  expect(rows.length).toBeLessThanOrEqual(2*CACHE_RETENTION_BAND_IDS.length);
  expect(rows.every(row=>CACHE_RETENTION_BAND_IDS.includes(row.band))).toBe(true);
  const merged=mergeCacheRetentionBands(rows);
  const alone=mergeCacheRetentionBands(rows.filter(row=>row.ownerDigest===OWNER));
  let evidence=0;
  for(const band of merged){
   const single=alone.find(other=>other.band===band.band)!;
   // Two identical owners, so every total doubles...
   expect(band.adjacencies).toBe(single.adjacencies*2);
   // ...and pooling equal contributors must not move the rate.
   expect(band.reusedMoreThanHalfRate).toBe(single.reusedMoreThanHalfRate);
   if(band.adjacencies>0){
    evidence+=1;
    expect(band.contributors).toBe(2);
    expect(band.topContributorShare).toBeCloseTo(0.5,10);
   }
  }
  expect(evidence).toBeGreaterThan(0);
  // A method version nothing wrote returns nothing, rather than everything.
  expect(await readCacheRetentionCommunityBands({target:target(),sourceId,
   methodVersion:`${CACHE_RETENTION_METHOD.version}-successor`})).toEqual([]);
 });
 it('is replay-safe, and refuses different bytes under the same identity',async()=>{
  const carry=carryFor();
  await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:aggregate()});
  // The same aggregate again stores nothing new.
  expect(await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:aggregate()}))
   .toMatchObject({status:'stored',valueCount:2});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_cache_retention_day_marks')
   .first<number>('n')).toBe(1);
  // Different bytes under the same identity is a refusal, never an overwrite.
  await expect(writeCacheRetentionDay({target:target(),key:key(),carry,
   aggregate:reduce([ev(0,{cacheReadTokens:1_000}),ev(1_000,{cacheReadTokens:1_000})])}))
   .rejects.toThrow('CACHE_RETENTION_UNAVAILABLE');
 });
 it('resumes a day cut mid-write and promotes the identical aggregate',async()=>{
  const carry=carryFor(),built=aggregate();
  // Enough for the carry plus exactly ONE values row and its band set, so the
  // second is deliberately cut and must resume. Derived, because a values row
  // costs `bands + 1` writes and the vocabulary is not fixed.
  // carry upserts + the reserved mark insert + one values row and its bands.
  const oneRow=CACHE_RETENTION_METHOD.lookbackDays+1+CACHE_RETENTION_BAND_IDS.length+1;
  const cut=await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:built,maxWrites:oneRow});
  expect(cut).toMatchObject({status:'staging',storedValues:1,totalValues:2});
  // Nothing is readable while the day is partial: no mark authorizes it.
  expect((await readCacheRetentionDay({target:target(),key:key(),carry})).status).toBe('absent');
  const done=await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:built,maxWrites:oneRow});
  expect(done).toMatchObject({status:'stored',valueCount:2});
  const read=await readCacheRetentionDay({target:target(),key:key(),carry});
  if(read.status!=='ready')throw new Error('unreachable');
  expect(canonicalJson(read.aggregate)).toBe(canonicalJson(built));
 });
 it('records an empty day, which is a result and not a gap',async()=>{
  const carry=carryFor();
  const empty=reduce([ev(0)],[],1);
  expect(empty.groups).toHaveLength(0);
  expect(await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:empty}))
   .toMatchObject({status:'stored',valueCount:0});
  const read=await readCacheRetentionDay({target:target(),key:key(),carry});
  if(read.status!=='ready')throw new Error('unreachable');
  expect(read.aggregate).toMatchObject({groups:[],eventsRead:1});
 });
 it('keeps a promoted row immutable at every tier',async()=>{
  const carry=carryFor();
  await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:aggregate()});
  await expect(target().prepare('UPDATE analytics_cache_retention_day_marks SET events_read=99').run())
   .rejects.toThrow('analytics_cache_retention_day_mark_conflict');
  await expect(target().prepare('UPDATE analytics_cache_retention_day_values SET adjacencies=99').run())
   .rejects.toThrow('analytics_cache_retention_day_value_retained');
  await expect(target().prepare('UPDATE analytics_cache_retention_day_bands SET adjacencies=99').run())
   .rejects.toThrow('analytics_cache_retention_day_band_retained');
  await expect(target().prepare('DELETE FROM analytics_cache_retention_day_carry').run())
   .rejects.toThrow('analytics_cache_retention_day_carry_retained');
 });
 it('admits a row only once everything it claims exists and agrees',async()=>{
  const carry=carryFor(),carryDigest=await cacheRetentionCarryDigest(carry);
  const valueKey=await cacheRetentionDayValueKey(key(),carryDigest,'gpt-5.6-sol','high');
  const markKey=await cacheRetentionDayMarkKey(key(),carryDigest);
  const insertValue=(overrides:Record<string,unknown>={})=>target().prepare(
   `INSERT INTO analytics_cache_retention_day_values(value_key,mark_key,source_id,owner_digest,day,
     method_version,carry_digest,model,effort,adjacencies,sessions,bands_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(...Object.values({value_key:valueKey,mark_key:markKey,source_id:sourceId,owner_digest:OWNER,
    day:DAY,method_version:'cache-retention-v2',carry_digest:carryDigest,model:'gpt-5.6-sol',
    effort:'high',adjacencies:0,sessions:0,bands_digest:'d'.repeat(64),...overrides})).run();
  // No bands at all.
  await expect(insertValue()).rejects.toThrow('analytics_cache_retention_day_bands_incomplete');
  for(const band of CACHE_RETENTION_BAND_IDS){
   await target().prepare(`INSERT INTO analytics_cache_retention_day_bands(value_key,band,source_id,
     owner_digest,day,method_version,adjacencies,reused_more_than_half,matched_or_exceeded,
     unordered_ties,excluded_insufficient_evidence,excluded_context_contracted,sessions)
     VALUES(?,?,?,?,?,?,0,0,0,0,0,0,0)`)
    .bind(valueKey,band,sourceId,OWNER,DAY,'cache-retention-v2').run();
  }
  // Bands present but the totals disagree.
  await expect(insertValue({adjacencies:3})).rejects.toThrow('analytics_cache_retention_day_bands_incomplete');
  await insertValue();
  // The mark claims a values row count and a carry it does not have.
  const insertMark=(overrides:Record<string,unknown>={})=>target().prepare(
   `INSERT INTO analytics_cache_retention_day_marks(mark_key,source_id,source_layout,source_namespace,
     owner_digest,device_id,manifest_id,manifest_digest,day,method_version,carry_digest,carry_days,
     value_count,events_read,unreadable_events,values_digest,refusal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(...Object.values({mark_key:markKey,source_id:sourceId,source_layout:'typed-v11',
    source_namespace:sourceNamespace,owner_digest:OWNER,device_id:'device-1',manifest_id:'manifest-1',
    manifest_digest:MANIFEST,day:DAY,method_version:'cache-retention-v2',carry_digest:carryDigest,
    carry_days:7,value_count:1,events_read:0,unreadable_events:0,values_digest:'e'.repeat(64),
    refusal:null,...overrides})).run();
  await expect(insertMark()).rejects.toThrow('analytics_cache_retention_day_values_incomplete');
  await expect(insertMark({value_count:2,carry_days:0}))
   .rejects.toThrow('analytics_cache_retention_day_values_incomplete');
  // A band or method the closed enums do not admit never reaches a row.
  await expect(target().prepare(`INSERT INTO analytics_cache_retention_day_bands(value_key,band,
    source_id,owner_digest,day,method_version,adjacencies,reused_more_than_half,matched_or_exceeded,
    unordered_ties,excluded_insufficient_evidence,excluded_context_contracted,sessions)
    VALUES(?,'one_to_two_minutes',?,?,?,'cache-retention-v2',0,0,0,0,0,0,0)`)
   .bind(valueKey,sourceId,OWNER,DAY).run()).rejects.toThrow();
  await expect(insertMark({method_version:'cache-retention-v3'})).rejects.toThrow();
 });
 it('fences every tier against an erased owner',async()=>{
  await target().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,
    terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
    VALUES(?,?,?,1,1,1,1)`).bind(sourceId,OWNER,'f'.repeat(64)).run();
  await expect(writeCacheRetentionDay({target:target(),key:key(),carry:carryFor(),
   aggregate:aggregate()})).rejects.toThrow('storage_owner_erased');
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_cache_retention_day_bands')
   .first<number>('n')).toBe(0);
 });
 it('retires a superseded method version, an erased owner and an undelivered day',async()=>{
  const carry=carryFor();
  await deliverDay();
  await writeCacheRetentionDay({target:target(),key:key(),carry,aggregate:aggregate()});
  // Still delivered under the current method: nothing to retire.
  expect(await retireCacheRetentionDayPage(target(),sourceId)).toMatchObject({state:'idle'});
  // A method bump misses every key. Derived from the live version rather than
  // written out, because a literal successor becomes the CURRENT version on
  // the next bump and the assertion then silently tests nothing: this test
  // asserted against `cache-retention-v3` until v3 shipped.
  const successor=`${CACHE_RETENTION_METHOD.version}-successor`;
  const bumped=await retireCacheRetentionDayPage(target(),sourceId,{methodVersion:successor});
  expect(bumped).toMatchObject({state:'retiring',marks:1});
  let page=await retireCacheRetentionDayPage(target(),sourceId,{methodVersion:successor});
  for(let attempt=0;attempt<8&&page.state!=='idle';attempt+=1){
   page=await retireCacheRetentionDayPage(target(),sourceId,{methodVersion:successor});
  }
  for(const table of ['marks','carry','values','bands']){
   expect(await target().prepare(`SELECT COUNT(*) n FROM analytics_cache_retention_day_${table}`)
    .first<number>('n')).toBe(0);
  }
 });
});

describe('the cache-retention lane',()=>{
 const build:CacheRetentionDayBuild=async candidate=>reduceCacheRetentionDay({day:candidate.day,
  events:[{...ev(0,{cacheReadTokens:1_000}),observedAtMs:Date.parse(`${candidate.day}T00:00:00.000Z`)},
   {...ev(1_000,{cacheReadTokens:900}),observedAtMs:Date.parse(`${candidate.day}T00:00:01.000Z`)}],
  carry:[],eventsRead:2});
 it('is off unless the deployment switch is explicitly set',()=>{
  expect(cacheRetentionBuildEnabled(undefined)).toBe(false);
  expect(cacheRetentionBuildEnabled({})).toBe(false);
  expect(cacheRetentionBuildEnabled({CACHE_RETENTION_BUILD:'disabled'})).toBe(false);
  expect(cacheRetentionBuildEnabled({CACHE_RETENTION_BUILD:true})).toBe(false);
  expect(cacheRetentionBuildEnabled({CACHE_RETENTION_BUILD:'enabled'})).toBe(true);
 });
 it('prepares each delivered day once, oldest first',async()=>{
  await deliverDay('2026-09-11','f'.repeat(64),'manifest-2');
  await deliverDay();
  const first=await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(first).toMatchObject({state:'progress',built:2,staged:0,refused:0,skipped:0});
  const days=(await target().prepare('SELECT day FROM analytics_cache_retention_day_marks ORDER BY day')
   .all<{day:string}>()).results.map(row=>row.day);
  expect(days).toEqual([DAY,'2026-09-11']);
  const second=await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(second).toMatchObject({state:'idle',reason:'complete',candidates:0});
 });
 it('never re-selects an empty day',async()=>{
  // Without the day mark, a day that aggregates to nothing would be selected
  // every pass forever and the oldest-first lane would never advance past it.
  await deliverDay();
  const empty:CacheRetentionDayBuild=async candidate=>reduceCacheRetentionDay({day:candidate.day,
   events:[],carry:[],eventsRead:0});
  expect(await advanceCacheRetentionDayLane({target:target(),sourceId,build:empty,
   deadlineMs:Date.now()+30_000,remainingQueries:900})).toMatchObject({built:1});
  expect(await advanceCacheRetentionDayLane({target:target(),sourceId,build:empty,
   deadlineMs:Date.now()+30_000,remainingQueries:900}))
   .toMatchObject({state:'idle',reason:'complete',candidates:0});
  expect(await target().prepare('SELECT value_count,events_read FROM analytics_cache_retention_day_marks')
   .first<{value_count:number;events_read:number}>()).toMatchObject({value_count:0,events_read:0});
 });
 it('re-selects a day when a day it depended on is restated or arrives late',async()=>{
  const lookback=cacheRetentionLookbackDays(DAY);
  await deliverDay();
  await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  const before=await target().prepare('SELECT mark_key FROM analytics_cache_retention_day_marks')
   .first<string>('mark_key');
  expect((await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900})).candidates).toBe(0);
  // A lookback day delivered AFTER the fact is a new input, exactly as a
  // restatement is: the recorded dependency said "nothing delivered".
  await deliverDay(lookback[6]!,'e'.repeat(64),'manifest-late');
  const again=await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(again).toMatchObject({built:2});
  const marks=(await target().prepare(`SELECT mark_key,day FROM analytics_cache_retention_day_marks
   WHERE day=? ORDER BY mark_key`).bind(DAY).all<{mark_key:string}>()).results;
  // The old mark is still there until retirement sweeps it; the point is that
  // a NEW one exists under a new carry digest rather than the stale one being
  // served as current.
  expect(marks.length).toBe(2);
  expect(marks.map(row=>row.mark_key)).toContain(before);
 });
 it('records a refusal so the day is not rediscovered, and does not record a transient skip',async()=>{
  await deliverDay();
  await deliverDay('2026-09-11','f'.repeat(64),'manifest-2');
  const refusing:CacheRetentionDayBuild=async(candidate,carry,budget)=>{
   if(candidate.day===DAY)throw new CacheRetentionRefusedError('day_page_limit_exceeded');
   return build(candidate,carry,budget);
  };
  expect(await advanceCacheRetentionDayLane({target:target(),sourceId,build:refusing,
   deadlineMs:Date.now()+30_000,remainingQueries:900}))
   .toMatchObject({state:'progress',built:1,refused:1,skipped:0,candidates:2});
  expect(await target().prepare('SELECT day,refusal,value_count FROM analytics_cache_retention_day_marks WHERE refusal IS NOT NULL')
   .first<{day:string;refusal:string;value_count:number}>())
   .toMatchObject({day:DAY,refusal:'day_page_limit_exceeded',value_count:0});
  expect((await advanceCacheRetentionDayLane({target:target(),sourceId,build:refusing,
   deadlineMs:Date.now()+30_000,remainingQueries:900})).candidates).toBe(0);
  const read=await readCacheRetentionDay({target:target(),key:key(),carry:carryFor()});
  expect(read).toMatchObject({status:'refused',reason:'day_page_limit_exceeded'});
 });
 it('skips an owner-scoped transient refusal without recording it',async()=>{
  await deliverDay();
  const unavailable:CacheRetentionDayBuild=async()=>{
   throw new CacheRetentionRefusedError('owner_source_unavailable');
  };
  const pass=await advanceCacheRetentionDayLane({target:target(),sourceId,build:unavailable,
   deadlineMs:Date.now()+30_000,remainingQueries:900});
  expect(pass).toMatchObject({skipped:1,refused:0,built:0,candidates:1});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_cache_retention_day_marks')
   .first<number>('n')).toBe(0);
  // The same day is selected again, which is what makes an outage recoverable.
  expect((await advanceCacheRetentionDayLane({target:target(),sourceId,build:unavailable,
   deadlineMs:Date.now()+30_000,remainingQueries:900})).candidates).toBe(1);
 });
 it('never opens a day it cannot pay for, and reports which bound stopped it',async()=>{
  await deliverDay();
  await deliverDay('2026-09-11','f'.repeat(64),'manifest-2');
  expect(await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:4}))
   .toMatchObject({state:'deferred',reason:'query_budget',built:0,candidates:0});
  expect(await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()-1,remainingQueries:900}))
   .toMatchObject({state:'deferred',reason:'deadline',built:0});
  expect(await target().prepare('SELECT COUNT(*) n FROM analytics_cache_retention_day_marks')
   .first<number>('n')).toBe(0);
  // A day costs 5 statements plus its write batches. A batch carries one values
  // row and its whole band set, so widening the vocabulary from 7 bands to 10
  // widened the batch with it; the budget that afforded exactly one day is
  // derived from the vocabulary rather than frozen, so it cannot rot the next
  // time the bands move.

  // TWO budgets bound a day, and the test is about the query one. A day's write
  // batch is the carry upserts, the reserved mark insert and one values row with
  // its whole band set, so it grows with the vocabulary: at seven bands 16
  // writes was enough and at ten it is not, which silently turned this into a
  // test of a partial write instead. The write budget is therefore derived and
  // generous, leaving the query budget as the only thing under test.
  const dayWrites=CACHE_RETENTION_METHOD.lookbackDays+1+CACHE_RETENTION_BAND_IDS.length+1;
  const partial=await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:30,maxWrites:dayWrites});
  expect(partial).toMatchObject({state:'progress',reason:'query_budget',built:1,staged:0,candidates:2});
 });
 it('ignores an erased owner and a day outside its floor',async()=>{
  await deliverDay();
  await deliverDay('2026-09-11','f'.repeat(64),'manifest-2');
  expect((await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900,fromDay:'2026-09-11'})).candidates).toBe(1);
  await target().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,
    terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
    VALUES(?,?,?,1,1,1,1)`).bind(sourceId,OWNER,'f'.repeat(64)).run();
  expect((await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900})).candidates).toBe(0);
 });
 it('partitions owners across shards so two instances never select the same day',async()=>{
  const second='b'.repeat(64);
  await target().prepare('INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,1,1,?)')
   .bind(sourceId,second,'active').run();
  await deliverDay();
  await deliverDay(DAY,'f'.repeat(64),'manifest-2',second,'device-2');
  const shard=async(index:number)=>(await advanceCacheRetentionDayLane({target:target(),sourceId,
   build,deadlineMs:Date.now()+30_000,remainingQueries:900,shardCount:2,shardIndex:index})).candidates;
  const zero=await shard(0),one=await shard(1);
  // 'a'*64 is bucket 170 and 'b'*64 is bucket 187: opposite parities, so each
  // shard sees exactly one of them and together they cover both.
  expect(zero+one).toBe(2);
  expect(zero).toBe(1);
  expect(one).toBe(1);
  await expect(advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+30_000,remainingQueries:900,shardCount:2,shardIndex:2})).rejects.toThrow();
 });
 it('reads the lookback dependency as delivered, absent days included',async()=>{
  const lookback=cacheRetentionLookbackDays(DAY);
  await deliverDay(lookback[0]!,'1'.repeat(64),'manifest-old');
  await deliverDay(lookback[6]!,'2'.repeat(64),'manifest-yesterday');
  const carry=await readCacheRetentionCarryDays(target(),key());
  expect(carry).toEqual(lookback.map(day=>({day,
   manifestDigest:day===lookback[0]?'1'.repeat(64):day===lookback[6]?'2'.repeat(64):''})));
 });
});

describe('the cache-retention builder over the real source readers',()=>{
 const sourceDb=()=>b.USAGE_MONITOR_DB;
 const bindings=()=>({source:sourceDb(),target:target(),sourceId,sourceNamespace});
 let occurrence=0;
 const eventId=()=>`event:v2:${(occurrence+=1).toString(16).padStart(64,'0')}`;
 async function source(days:number){
  for(const migrations of [b.TEST_MIGRATIONS,b.TEST_TYPED_INGESTION_MIGRATIONS,
   b.TEST_INGESTION_BRIDGE_MIGRATIONS,b.TEST_TYPED_V11_ADMISSION_MIGRATIONS,
   b.TEST_TYPED_V1_ADMISSION_MIGRATIONS])await applyD1Migrations(sourceDb(),migrations);
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
   // Two same-configuration requests 30 seconds apart in one session, then a
   // third an hour later whose prefix mostly survived.
   const prepared=await makeV11Day(day,{usage:[
    v11UsageRecord(day,'a',{eventId:eventId(),eventTime:`${day}T09:00:00.000Z`,
     components:{inputUncachedTokens:100,inputCacheReadTokens:1000,inputCacheWriteTokens:0,
      outputTextTokens:50,outputReasoningTokens:25,outputCombinedTokens:null}}),
    v11UsageRecord(day,'b',{eventId:eventId(),eventTime:`${day}T09:00:30.000Z`,
     components:{inputUncachedTokens:100,inputCacheReadTokens:1000,inputCacheWriteTokens:0,
      outputTextTokens:50,outputReasoningTokens:25,outputCombinedTokens:null}}),
    v11UsageRecord(day,'c',{eventId:eventId(),eventTime:`${day}T10:00:30.000Z`,
     components:{inputUncachedTokens:400,inputCacheReadTokens:800,inputCacheWriteTokens:0,
      outputTextTokens:50,outputReasoningTokens:25,outputCombinedTokens:null}})]});
   const staged=await registerTelemetryV11DayManifest(sourceDb(),device,prepared.manifest);
   for(const chunk of prepared.chunks){
    const envelopeDigest=await sha256Hex(`synthetic:${crypto.randomUUID()}`);
    const upload=await createDeviceUploadAuthorization(sourceDb(),
     await authenticateDevice(sourceDb(),device.authorization),envelopeDigest,200);
    const claim=await claimDeviceUploadAuthorization(sourceDb(),`Upload ${upload.uploadAuthorization}`,
     {envelopeDigest,bodyBytes:200,contentType:'application/json'});
    await persistTypedV11StagedChunk(sourceDb(),device,chunk,{sourceNamespace,
     chunkRowId:`chunk:${crypto.randomUUID()}`,r2Key:`synthetic/${crypto.randomUUID()}`,
     envelopeDigest,deviceUploadAuthorizationId:claim.authorizationId});
   }
   entries.push({day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest});
  }
  const prior=await createTelemetryV11DomainPredecessor(sourceDb(),device);
  const manifest:TelemetryV11DomainManifest={schemaVersion:'telemetry-domain-manifest-v1.1',
   fromDay:entries[0]!.day,throughDay:today,predecessor:{token:prior.token,
    previousGenerationId:prior.previousGenerationId,legacyFingerprint:prior.legacyFingerprint},
   days:entries,manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(sourceDb(),device,manifest);
  for(let i=0;i<40;i++)if((await advanceStorageAnalytics(bindings())).state==='idle')break;
  const pin=(await loadV11SourcePin(sourceDb(),device.participantId))!;
  const snapshot=await loadTypedV11GenerationSnapshot(sourceDb(),{sourceNamespace,pin});
  const ownerDigest=(await readIngestionChanges(sourceDb(),sourceId,0)).at(-1)!.ownerDigest;
  return {device,snapshot,ownerDigest,days:entries.map(entry=>entry.day)};
 }
 it('builds, stores and reads back the same aggregate the reduction produces',async()=>{
  const fixture=await source(2);
  const build=createCacheRetentionDayBuild({source:sourceDb(),sourceNamespace,
   snapshot:fixture.snapshot,ownerDigest:fixture.ownerDigest});
  const lane=await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:900,sourceQueries:900});
  expect(lane).toMatchObject({state:'progress',built:2,staged:0,refused:0,skipped:0});
  const rows=(await target().prepare(`SELECT owner_digest,device_id,manifest_id,manifest_digest,day,
    source_namespace FROM analytics_cache_retention_day_marks ORDER BY day`)
   .all<Record<string,string>>()).results;
  expect(rows.map(row=>row.day)).toEqual(fixture.days);
  for(const [index,row] of rows.entries()){
   const dayKey={sourceId,sourceLayout:'typed-v11' as const,sourceNamespace,
    ownerDigest:row.owner_digest!,deviceId:row.device_id!,manifestId:row.manifest_id!,
    manifestDigest:row.manifest_digest!,day:row.day!};
   const carry=await readCacheRetentionCarryDays(target(),dayKey);
   const stored=await readCacheRetentionDay({target:target(),key:dayKey,carry});
   expect(stored.status).toBe('ready');
   if(stored.status!=='ready')throw new Error('unreachable');
   // Byte-identical to reducing the same source rows directly.
   const direct=await build(dayKey,carry,{deadlineMs:Date.now()+60_000,remainingQueries:256});
   expect(canonicalJson(stored.aggregate)).toBe(canonicalJson(direct));
   expect(stored.aggregate.groups).toHaveLength(1);
   expect(stored.aggregate.eventsRead).toBe(3);
   const group=stored.aggregate.groups[0]!;
   expect(group).toMatchObject({model:'gpt-5.6-sol',effort:'high',sessions:1});
   expect(group.bands.find(band=>band.band==='under_one_minute'))
    .toMatchObject({adjacencies:1,reusedMoreThanHalf:1,matchedOrExceeded:1});
   // Under two hours, so the new split puts it in `one_to_two_hours` where the
   // old six-hour bucket would have absorbed it. This is the contrast the
   // widened vocabulary exists to show.
   expect(group.bands.find(band=>band.band==='one_to_two_hours'))
    .toMatchObject({adjacencies:1,reusedMoreThanHalf:1,matchedOrExceeded:0});
   // The second day pairs its first request against the previous day's last
   // one through the bounded lookback, so it holds one more adjacency than the
   // first -- which is the cross-midnight attribution working end to end.
   const overnight=group.bands.find(band=>band.band==='six_to_twenty_four_hours')!;
   expect(group.adjacencies).toBe(index===0?2:3);
   expect(overnight.adjacencies).toBe(index===0?0:1);
  }
 });
 it('never lets a raw session identifier reach a stored row',async()=>{
  const fixture=await source(1);
  const build=createCacheRetentionDaySourceBuild({source:sourceDb(),sourceNamespace});
  await advanceCacheRetentionDayLane({target:target(),sourceId,build,
   deadlineMs:Date.now()+60_000,remainingQueries:900,sourceQueries:900});
  const raw=v11UsageRecord(fixture.days[0]!).sessionUuid;
  const digest=await cacheRetentionSessionDigest({ownerDigest:fixture.ownerDigest,
   provider:'openai_codex',sessionUuid:raw});
  expect(digest).toBe(await sha256Hex(canonicalJson({method:CACHE_RETENTION_SESSION_DIGEST_METHOD,
   kind:'session',ownerDigest:fixture.ownerDigest,value:['openai_codex',raw]})));
  for(const table of ['marks','carry','values','bands']){
   const rows=(await target().prepare(`SELECT * FROM analytics_cache_retention_day_${table}`)
    .all<Record<string,unknown>>()).results;
   expect(rows.length).toBeGreaterThan(0);
   const text=JSON.stringify(rows);
   expect(text).not.toContain(raw);
   // Not even the opaque digest: only its cardinality reaches a row.
   expect(text).not.toContain(digest);
   // Nor the per-event occurrence id the ordering tiebreak uses in memory: it
   // is an `event:v2:` identifier and no stored column carries one.
   expect(text).not.toContain('event:v2:');
  }
 });
 it('runs as its own scheduled Worker, and does nothing with the switch unset',async()=>{
  const fixture=await source(2);
  const env2={STORAGE_SOURCE_ID:sourceId,TELEMETRY_STORAGE_NAMESPACE:sourceNamespace,
   STORAGE_INGESTION_DB:sourceDb(),STORAGE_ANALYTICS_DB:target()};
  const marks=async()=>(await target().prepare('SELECT COUNT(*) n FROM analytics_cache_retention_day_marks')
   .first<number>('n'))!;
  await runCacheRetentionDaySchedule(env2);
  expect(await marks()).toBe(0);
  await runCacheRetentionDaySchedule({...env2,CACHE_RETENTION_BUILD:'disabled'});
  expect(await marks()).toBe(0);
  await runCacheRetentionDaySchedule({...env2,CACHE_RETENTION_BUILD:'enabled'});
  const days=(await target().prepare('SELECT day FROM analytics_cache_retention_day_marks ORDER BY day')
   .all<{day:string}>()).results.map(row=>row.day);
  expect(days).toEqual(fixture.days);
  // A shard index outside its count is a configuration error, not a silent
  // pass that would leave those owners unreachable.
  await expect(runCacheRetentionDaySchedule({...env2,CACHE_RETENTION_BUILD:'enabled',
   CACHE_RETENTION_SHARDS:'2',CACHE_RETENTION_SHARD:'2'}))
   .rejects.toThrow('CACHE_RETENTION_CONFIGURATION_INVALID');
 });
});
