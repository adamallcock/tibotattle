import { applyD1Migrations, env, reset, type D1Migration } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { canonicalOccurrenceKey, canonicalFieldPresence, normalizeNativeEffectiveOccurrence,
  normalizeSelectedTelemetryRecord, compareCanonicalFacts, type CanonicalScope, type CanonicalFact } from '../src/canonical-analytics-facts';
import { canonicalAnalyticsAvailable, materializeCanonicalPage, materializeCanonicalPartition,
  readCanonicalFacts, readCanonicalPartition, validateCanonicalFact, type CanonicalPageUpdate } from '../src/storage-canonical-analytics-facts';
import { sha256Hex } from '../src/crypto';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createAnalyticsProfile,profileAnalyticsDatabase} from './helpers/analytics-profile';
import { canonicalJson } from '../src/canonical-json';
import type { EffectiveUsageOccurrence, EffectiveCanonicalEvidence } from '../src/telemetry-usage-effective-reader';

const bindings=env as Env & {STORAGE_ANALYTICS_DB:D1Database;TEST_ANALYTICS_MIGRATIONS:D1Migration[]};
const db=()=>bindings.STORAGE_ANALYTICS_DB;
const sourceId='synthetic-canonical';
const scope:CanonicalScope={sourceNamespace:sourceId,ownerDigest:'a'.repeat(64),selectionMethod:'effective-union-v1'};
const other:CanonicalScope={...scope,ownerDigest:'b'.repeat(64)};
const day='2026-09-20';
const unknown={presence:'unknown' as const,value:null};
function evidence(date=day,coordinate='v11:1'):EffectiveCanonicalEvidence {
  return {linkedDays:[date],variants:[{coordinate,format:'v11',observedAtMs:Date.parse(date+'T12:05:00.000Z')}],
    boundaryFlags:unknown,tieOrder:unknown,cacheWriteFiveMinuteTokens:unknown,cacheWriteOneHourTokens:unknown};
}
function oracle(selectedScope=scope,date=day,fill='a',overrides:Partial<EffectiveUsageOccurrence>={}):EffectiveUsageOccurrence {
  const record=v11UsageRecord(date,fill);
  return {methodVersion:'effective-usage-owner-day-v1',participantId:'synthetic-private-participant',ownerDigest:selectedScope.ownerDigest,
    occurrenceId:record.eventId,eventTime:record.eventTime,eventTimeConflict:false,status:'compatible',sourceCount:1,
    sourceFormats:['v11'],sourceRowIds:[1],sourceRecordKeys:['v11:1'],correctionHistoryIds:[],recordJson:null,
    analyticalRecordJson:canonicalTelemetryV11Json(record),canonicalEvidence:evidence(date),...overrides};
}
async function fact(selectedScope=scope,date=day,fill='a',rank=0) {
  return normalizeNativeEffectiveOccurrence(selectedScope,oracle(selectedScope,date,fill),rank);
}
async function apply(facts:readonly CanonicalFact[],stamp:string,selectedScope=scope,prior:readonly (string|null)[]=facts.map(()=>null)) {
  return materializeCanonicalPage({db:db(),sourceId,scope:selectedScope,ownerRevision:1,authorityEpoch:1,
    pageKey:await sha256Hex('synthetic-page'),sourceRevision:await sha256Hex(stamp),stillCurrent:async()=>true,
    load:async()=>facts.map((fact,index)=>({occurrenceKey:fact.occurrenceKey,stream:fact.stream,expectedRevision:prior[index]!,fact}))});
}
beforeEach(async()=>{
  await reset();await applyD1Migrations(db(),bindings.TEST_ANALYTICS_MIGRATIONS);
  await db().prepare('INSERT INTO analytics_runtime_sources(source_id,source_namespace,contract_version) VALUES(?,?,1)').bind(sourceId,sourceId).run();
  for(const selected of [scope,other])await db().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
    VALUES(?,?,1,1,'active')`).bind(sourceId,selected.ownerDigest).run();
});

it('stores closed facts and replays an accepted revision without invoking source normalization',async()=>{
  const original=await fact(),first=await apply([original],'first');
  expect(first).toMatchObject({state:'complete',reused:false,effects:[{kind:'insert'}]});
  expect(await readCanonicalFacts(db(),[original.revision])).toEqual([original]);
  const replay=await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,
    pageKey:await sha256Hex('synthetic-page'),sourceRevision:await sha256Hex('first'),stillCurrent:async()=>true,
    load:async()=>{throw new Error('normalization must not repeat');}});
  expect(replay).toEqual({...first,reused:true});
  const stored=(await db().prepare('SELECT * FROM analytics_canonical_facts').all()).results;
  const serialized=JSON.stringify(stored);
  expect(serialized).not.toContain(v11UsageRecord(day).sessionUuid);
  expect(serialized).not.toContain(v11UsageRecord(day).eventId);
  expect(serialized).not.toContain('synthetic-private-participant');
  expect(serialized).not.toContain('record_json');
  expect(original.values.outputCombinedTokens).toBeNull();
  expect(canonicalFieldPresence(original,'outputCombinedTokens')).toBe('unknown');
  expect(original.tieOrder).toEqual(unknown);
  expect(original.values.accountScopeKey).toBeNull();
  const manifest=await materializeCanonicalPartition(db(),original.location.partitionKey);
  expect(manifest).toMatchObject({state:'complete',reused:false,manifest:{rowCount:1}});
  expect(await materializeCanonicalPartition(db(),original.location.partitionKey)).toMatchObject({state:'complete',reused:true});
  const noop=await apply([original],'new-proof-same-content',scope,[original.revision]);
  expect(noop.effects[0]!.kind).toBe('noop');
  expect(await materializeCanonicalPartition(db(),original.location.partitionKey)).toMatchObject({state:'complete',reused:true});
});

it('keeps occurrence identity through time moves and emits old/new linked locations and withdrawals',async()=>{
  const old=await fact();await apply([old],'initial');
  const moved=await fact(scope,'2026-09-21');
  expect(moved.occurrenceKey).toBe(old.occurrenceKey);expect(moved.revision).not.toBe(old.revision);
  const replacement=await apply([moved],'move',scope,[old.revision]);
  expect(replacement.effects[0]).toMatchObject({kind:'replace',old:{location:{day}},new:{location:{day:'2026-09-21'}}});
  expect(await materializeCanonicalPartition(db(),old.location.partitionKey)).toMatchObject({state:'complete',manifest:{rowCount:0}});
  const withdrawal=await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,
    pageKey:await sha256Hex('withdrawal'),sourceRevision:await sha256Hex('withdrawal-proof'),stillCurrent:async()=>true,
    load:async()=>[{occurrenceKey:moved.occurrenceKey,stream:'usage',expectedRevision:moved.revision,fact:null}]});
  expect(withdrawal.effects[0]).toMatchObject({kind:'withdraw',old:{revision:moved.revision},new:null});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(0);
});

it('preserves conflict and complete retained variant days instead of making up a time or value',async()=>{
  const row=oracle(scope,day,'a',{status:'base_conflict',eventTime:null,eventTimeConflict:true,analyticalRecordJson:null,
    canonicalEvidence:{...evidence(),linkedDays:[day,'2026-09-21'],variants:[...evidence().variants,
      {coordinate:'v1:history:2',format:'v1',observedAtMs:Date.parse('2026-09-21T12:05:00.000Z')}],
      tieOrder:{presence:'conflict',value:null}}});
  const canonical=await normalizeNativeEffectiveOccurrence(scope,row,0);
  expect(canonical.location).toMatchObject({day:null,observedAtMs:null});
  expect(canonicalFieldPresence(canonical,'totalInputContextTokens')).toBe('conflict');
  expect(canonical.provenance.linkedDays).toEqual([day,'2026-09-21']);
  expect(canonical.provenance.variants.map(v=>v.kind).sort()).toEqual(['correction','typed']);
  await apply([canonical],'conflict');
  expect(await readCanonicalFacts(db(),[canonical.revision])).toEqual([canonical]);
});

it('keeps cross-subject IDs separate and preserves exact native tie order',async()=>{
  const a=await fact(scope,day,'a',9),b=await fact(other,day,'a',9),earlier=await fact(scope,day,'z',3);
  expect(a.occurrenceKey).not.toBe(b.occurrenceKey);
  expect(a.values.sessionKey).not.toBe(b.values.sessionKey);
  expect(a.provenance.variants[0]!.sourceVariantKey).not.toBe(b.provenance.variants[0]!.sourceVariantKey);
  expect([a,earlier].sort(compareCanonicalFacts).map(v=>v.location.nativeOrder)).toEqual([3,9]);
  await apply([a],'owner-a');await apply([b],'owner-b',other);
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(2);
});

it('rolls back a whole bounded page on stale head CAS and resumes without a partial checkpoint',async()=>{
  const a=await fact(),b=await fact(scope,day,'b');await apply([a],'seed');
  await expect(apply([b,a],'page')).rejects.toMatchObject({code:'CANONICAL_CONFLICT'});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(1);
  expect(await readCanonicalFacts(db(),[b.revision])).toEqual([]);
  expect(await apply([b,a],'page',scope,[null,a.revision])).toMatchObject({reused:false});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(2);
  const foreign=await fact(other,day,'c');
  await expect(apply([foreign],'foreign-owner')).rejects.toMatchObject({code:'CANONICAL_INVALID'});
});

it('erases all subject revisions and mixed manifests, keeps the survivor and fences restoration',async()=>{
  const a=await fact();
  let candidate='';
  for(let n=0;n<4096;n++) {
    const native=`event:v2:${n.toString(16).padStart(64,'0')}`;
    if((await canonicalOccurrenceKey(other,'usage',native)).slice(0,2)===a.occurrenceKey.slice(0,2)){candidate=native;break;}
  }
  expect(candidate).not.toBe('');
  const raw=oracle(other);const record={...v11UsageRecord(day),eventId:candidate};
  const b=await normalizeNativeEffectiveOccurrence(other,{...raw,occurrenceId:candidate,analyticalRecordJson:canonicalTelemetryV11Json(record)},1);
  await apply([a],'a');await apply([b],'b',other);
  const manifest=await materializeCanonicalPartition(db(),a.location.partitionKey);
  expect(manifest).toMatchObject({state:'complete',manifest:{rowCount:2}});
  await db().prepare(`INSERT INTO analytics_storage_erasure_fences(source_id,owner_digest,terminal_event_digest,terminal_sequence,
    terminal_revision,authority_epoch,public_authority_epoch) VALUES(?,?,?,1,2,2,2)`).bind(sourceId,scope.ownerDigest,'e'.repeat(64)).run();
  expect(await readCanonicalFacts(db(),[a.revision,b.revision])).toEqual([b]);
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_manifests').first<number>('n')).toBe(0);
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_pages WHERE owner_digest=?').bind(scope.ownerDigest).first<number>('n')).toBe(0);
  expect(await materializeCanonicalPartition(db(),b.location.partitionKey)).toMatchObject({state:'complete',manifest:{rowCount:1}});
  await expect(apply([a],'restore')).rejects.toMatchObject({code:'CANONICAL_CONFLICT'});
  expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

it('refuses incomplete coverage, source changes, unknown fact fields and a missing migration trigger',async()=>{
  const incomplete=await normalizeNativeEffectiveOccurrence(scope,oracle(scope,day,'a',{canonicalEvidence:undefined}),0);
  await expect(apply([incomplete],'incomplete')).rejects.toMatchObject({code:'CANONICAL_INVALID'});
  const original=await fact();
  await expect(validateCanonicalFact({...original,privateSource:'never stored'} as CanonicalFact)).rejects.toMatchObject({code:'CANONICAL_INVALID'});
  await expect(materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,pageKey:'f'.repeat(64),sourceRevision:'e'.repeat(64),
    load:async()=>[{occurrenceKey:original.occurrenceKey,stream:'usage',expectedRevision:null,fact:original}],stillCurrent:async()=>false}))
    .rejects.toMatchObject({code:'CANONICAL_CONFLICT'});
  await db().prepare('DROP TRIGGER analytics_canonical_effect_apply').run();
  expect(await canonicalAnalyticsAvailable(db())).toBe(false);
  await expect(apply([original],'partial-schema')).rejects.toMatchObject({code:'CANONICAL_UNAVAILABLE'});
});

it('makes legacy selected normalization explicit without changing its selected input',async()=>{
  const selectedScope:CanonicalScope={...scope,selectionMethod:'legacy-selected-v1'},record=v11UsageRecord(day);
  const selected=await normalizeSelectedTelemetryRecord(selectedScope,{stream:'usage',occurrenceId:record.eventId,eventTime:record.eventTime,
    recordJson:canonicalTelemetryV11Json(record),evidence:evidence(),nativeOrder:0,
      selectedSlotKey:'f'.repeat(64),sourceFamily:'v11',occurrenceTieOrder:0});
  const effective=await fact();
  expect(selected.occurrenceKey).not.toBe(effective.occurrenceKey);
  expect(selected.nativeScopes.logicalOccurrenceKey).toBe(effective.occurrenceKey);
  expect(selected.revision).not.toBe(effective.revision);
  expect(selected.values).toEqual(effective.values);
  await expect(normalizeNativeEffectiveOccurrence(selectedScope,oracle(),0)).rejects.toMatchObject({code:'CANONICAL_INVALID'});
});

it('splits an oversized logical partition into bounded leaves and seals explicit empty leaves',async()=>{
  const original=await fact(),facts:CanonicalFact[]=[];
  for(let index=0;index<129;index++) {
    const occurrenceKey='aa'+index.toString(16).padStart(62,'0');
    const {revision:_revision,...body}={...original,occurrenceKey,nativeScopes:{...original.nativeScopes,logicalOccurrenceKey:occurrenceKey},
      location:{...original.location,partitionKey:`effective-union-v1/usage/${day}/aa`,nativeOrder:index}};
    facts.push({...body,revision:await sha256Hex(canonicalJson(body))});
  }
  for(let offset=0;offset<facts.length;offset+=16)await apply(facts.slice(offset,offset+16),'split-page-'+offset);
  const root=facts[0]!.location.partitionKey;
  const split=await materializeCanonicalPartition(db(),root);
  expect(split.state).toBe('split');
  if(split.state!=='split')throw new Error('expected bounded split');
  expect(split.partitions).toHaveLength(16);
  expect(await materializeCanonicalPartition(db(),split.partitions[1]!)).toMatchObject({state:'complete',manifest:{rowCount:0}});
  expect(await materializeCanonicalPartition(db(),split.partitions[0]!)).toMatchObject({state:'split'});
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(129);
},30_000);

it('keeps legacy and effective selected heads independent and refuses a stale sealed manifest read',async()=>{
  const effective=await fact();await apply([effective],'effective');
  const selectedScope:CanonicalScope={...scope,selectionMethod:'legacy-selected-v1'},record=v11UsageRecord(day);
  const selected=await normalizeSelectedTelemetryRecord(selectedScope,{stream:'usage',occurrenceId:record.eventId,eventTime:record.eventTime,
    recordJson:canonicalTelemetryV11Json(record),evidence:evidence(),nativeOrder:0,
      selectedSlotKey:'f'.repeat(64),sourceFamily:'v11',occurrenceTieOrder:0});
  await apply([selected],'selected',selectedScope);
  expect(await db().prepare('SELECT count(*) n FROM analytics_canonical_heads').first<number>('n')).toBe(2);
  await materializeCanonicalPartition(db(),effective.location.partitionKey);
  expect((await readCanonicalPartition(db(),effective.location.partitionKey))!.facts).toEqual([effective]);
  const moved=await fact(scope,'2026-09-21');await apply([moved],'move-effective',scope,[effective.revision]);
  expect(await readCanonicalPartition(db(),effective.location.partitionKey)).toBeNull();
  expect(await materializeCanonicalPartition(db(),selected.location.partitionKey)).toMatchObject({state:'complete',manifest:{rowCount:1}});
});

it('distinguishes conflicting account evidence from missing account evidence',async()=>{
  const row=oracle(scope,day,'a',{canonicalEvidence:{...evidence(),accountScopeConflict:true}});
  const canonical=await normalizeNativeEffectiveOccurrence(scope,row,0);
  expect(canonical.values.accountScopeKey).toBeNull();
  expect(canonicalFieldPresence(canonical,'accountScopeKey')).toBe('conflict');
  expect(canonicalFieldPresence(await fact(),'accountScopeKey')).toBe('unknown');
  await apply([canonical],'account-conflict');
  expect(await readCanonicalFacts(db(),[canonical.revision])).toEqual([canonical]);
});

it('refuses before migration without acquiring or normalizing source data',async()=>{
  await reset();await applyD1Migrations(db(),bindings.TEST_ANALYTICS_MIGRATIONS.filter(m=>m.name<'0036_'));
  expect(await canonicalAnalyticsAvailable(db())).toBe(false);
  let loaded=false;
  await expect(materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,
    pageKey:'1'.repeat(64),sourceRevision:'2'.repeat(64),stillCurrent:async()=>true,
    load:async()=>{loaded=true;return [];}})).rejects.toMatchObject({code:'CANONICAL_UNAVAILABLE'});
  expect(loaded).toBe(false);
});

it('preserves native quota plan evidence and refuses inconsistent plan attribution',async()=>{
  const record={schemaVersion:'quota-observation-v1.1',observationId:'quota:synthetic:1',observedTime:day+'T12:05:00.000Z',
    provider:'openai_codex',planType:'pro',planVariant:'unknown',limitId:'codex',slot:'primary',usedPercent:10,
    windowDurationMinutes:300,resetsAt:null,accountPlanAttribution:{accountBasis:'unavailable',accountTrackId:null,
      planBasis:'same_source_occurrence',planType:'pro',planEraId:null}};
  const canonical=await normalizeNativeEffectiveOccurrence(scope,{methodVersion:'effective-telemetry-owner-day-v1',stream:'quota',
    ownerDigest:scope.ownerDigest,participantId:'synthetic-private-participant',occurrenceId:record.observationId,eventTime:record.observedTime,
    eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],sourceRowIds:[1],sourceRecordKeys:['v11:1'],
    canonicalEvidence:evidence(),recordJson:canonicalTelemetryV11Json(record)},0);
  expect(canonical.values.planType).toBe('pro');expect(canonical.values.attributionPlanType).toBe('pro');
  expect(canonicalFieldPresence(canonical,'planType')).toBe('reported');
  expect(canonicalFieldPresence(canonical,'attributionPlanType')).toBe('reported');
  await expect(normalizeNativeEffectiveOccurrence(scope,{methodVersion:'effective-telemetry-owner-day-v1',stream:'quota',
    ownerDigest:scope.ownerDigest,participantId:'synthetic-private-participant',occurrenceId:record.observationId,eventTime:record.observedTime,
    eventTimeConflict:false,status:'compatible',sourceCount:1,sourceFormats:['v11'],sourceRowIds:[1],sourceRecordKeys:['v11:1'],
    canonicalEvidence:evidence(),recordJson:canonicalTelemetryV11Json({...record,
      accountPlanAttribution:{...record.accountPlanAttribution,planBasis:'unavailable',planType:'unknown'}})},0))
    .rejects.toMatchObject({code:'CANONICAL_INVALID'});
  await apply([canonical],'quota-plan');
  expect(await readCanonicalFacts(db(),[canonical.revision])).toEqual([canonical]);
});


it('retains exact native analytical digests and approved client pseudonyms without source identifiers',async()=>{
  const {cacheRetentionSessionDigest}=await import('../src/cache-retention-events');
  const {graphDayUsageSessionDigest}=await import('../src/graph-day-projection');
  const {v11PreparedUsageSessionDigest,prepareV11UsageFeature}=await import('../src/quota-analysis-v11');
  const record=v11UsageRecord(day,'a',{accountPlanAttribution:{accountBasis:'same_source',
    accountTrackId:'account-track:v2:'+ 'c'.repeat(64),planBasis:'same_source_occurrence',
    planType:'pro',planEraId:'plan-era:v1:'+ 'd'.repeat(64)}});
  const canonical=await normalizeNativeEffectiveOccurrence(scope,{...oracle(),analyticalRecordJson:canonicalTelemetryV11Json(record)},0);
  const identity={ownerDigest:scope.ownerDigest,provider:record.provider,sessionUuid:record.sessionUuid};
  const native=await prepareV11UsageFeature({occurrence_id:record.eventId,observed_at:record.eventTime,
    provider:record.provider,session_uuid:record.sessionUuid,record_json:canonicalTelemetryV11Json(record)},scope.ownerDigest);
  expect(canonical.nativeScopes).toEqual({schema:'canonical-native-scopes-v2',sourceFamily:'effective',selectedSlotKey:null,
    logicalOccurrenceKey:canonical.occurrenceKey,occurrenceTieOrder:0,quotaOccurrenceId:null,
    cacheSessionDigest:await cacheRetentionSessionDigest(identity),graphSessionDigest:await graphDayUsageSessionDigest(identity),
    scalarSessionDigest:await v11PreparedUsageSessionDigest(identity),accountTrackId:record.accountPlanAttribution.accountTrackId,
    planEraId:record.accountPlanAttribution.planEraId});
  expect(canonical.nativeScopes.scalarSessionDigest).toBe(native.sessionDigest);
  expect(new Set([canonical.nativeScopes.cacheSessionDigest,canonical.nativeScopes.graphSessionDigest,canonical.nativeScopes.scalarSessionDigest]).size).toBe(3);
  await apply([canonical],'native-scopes');
  expect(await readCanonicalFacts(db(),[canonical.revision])).toEqual([canonical]);
  const serialized=JSON.stringify((await db().prepare('SELECT * FROM analytics_canonical_facts').all()).results);
  expect(serialized).not.toContain(record.sessionUuid);expect(serialized).not.toContain(record.eventId);
  const bad={...canonical,nativeScopes:{...canonical.nativeScopes,accountTrackId:'private-account'}};
  const {revision,...body}=bad;
  await expect(validateCanonicalFact({...bad,revision:await sha256Hex(canonicalJson(body))})).rejects.toMatchObject({code:'CANONICAL_INVALID'});
});


it('hands off bounded immutable effects and retires only acknowledged unreferenced derived artifacts',async()=>{
  const {readCanonicalWorkEffects,retireCanonicalAnalyticsPage}=await import('../src/storage-canonical-analytics-facts');
  const a=await fact();const initial=await apply([a],'cleanup-initial');
  await materializeCanonicalPartition(db(),a.location.partitionKey);
  const b=await fact(scope,'2026-09-21');const replaced=await apply([b],'cleanup-move',scope,[a.revision]);
  const read=await readCanonicalWorkEffects(db(),[replaced.effects[0]!.effectKey]);
  expect(read).toMatchObject([{sourceId,ownerDigest:scope.ownerDigest,kind:'replace',partitions:[
    {partitionKey:a.location.partitionKey,day},{partitionKey:b.location.partitionKey,day:'2026-09-21'}]}]);
  await expect(readCanonicalWorkEffects(db(),Array(17).fill('a'.repeat(64)))).rejects.toMatchObject({code:'CANONICAL_LIMIT'});
  expect(await retireCanonicalAnalyticsPage(db(),sourceId,1)).toMatchObject({partitionHeadsRetired:1,manifestsRetired:1,pagesRetired:0,factsRetired:0});
  await materializeCanonicalPartition(db(),a.location.partitionKey);
  await materializeCanonicalPartition(db(),b.location.partitionKey);
  const emptyCleanup=await retireCanonicalAnalyticsPage(db(),sourceId,1);
  expect(emptyCleanup.pagesRetired).toBe(0);expect(emptyCleanup.factsRetired).toBe(0);
  await db().prepare("UPDATE analytics_partition_canonical_effects SET state='accepted'").run();
  await db().prepare(`INSERT INTO analytics_partition_work(work_key,head_key,source_id,owner_digest,partition_key,input_revision,
    policy_revision,stage,lane,state,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms)
    VALUES(?,?,?,?,?,?,?,'features','recovery','ready',1024,20,1,1,1)`)
    .bind('1'.repeat(64),'2'.repeat(64),sourceId,scope.ownerDigest,a.location.partitionKey,'3'.repeat(64),'4'.repeat(64)).run();
  expect(await retireCanonicalAnalyticsPage(db(),sourceId,1)).toMatchObject({pagesRetired:0,factsRetired:0});
  await db().prepare("UPDATE analytics_partition_work SET state='complete',revision=revision+1 WHERE work_key=?").bind('1'.repeat(64)).run();
  await db().prepare('INSERT INTO analytics_partition_effect_refs(work_key,effect_key) VALUES(?,?)')
    .bind('1'.repeat(64),initial.effects[0]!.effectKey).run();
  expect(await retireCanonicalAnalyticsPage(db(),sourceId,1)).toMatchObject({pagesRetired:0,factsRetired:0});
  await db().prepare('DELETE FROM analytics_partition_work WHERE work_key=?').bind('1'.repeat(64)).run();
  const retired=await retireCanonicalAnalyticsPage(db(),sourceId,1);
  expect(retired.pagesRetired).toBe(1);expect(retired.factsRetired).toBe(0); // replacement effect still references the old fact
  expect(await readCanonicalWorkEffects(db(),[initial.effects[0]!.effectKey])).toEqual([]);
  expect((await readCanonicalWorkEffects(db(),[replaced.effects[0]!.effectKey])).length).toBe(1);
  expect(await readCanonicalFacts(db(),[b.revision])).toEqual([b]);
  const c=await fact(scope,'2026-09-22');await apply([c],'cleanup-next',scope,[b.revision]);
  await db().prepare("UPDATE analytics_partition_canonical_effects SET state='accepted'").run();
  const next=await retireCanonicalAnalyticsPage(db(),sourceId,1);
  expect(next.pagesRetired).toBe(1);expect(next.factsRetired).toBe(1);
  expect(await readCanonicalFacts(db(),[a.revision])).toEqual([]);
  expect(await readCanonicalFacts(db(),[c.revision])).toEqual([c]);
  expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  await db().prepare('DROP TABLE analytics_partition_effect_refs').run();
  expect(await retireCanonicalAnalyticsPage(db(),sourceId,1)).toMatchObject({state:'unavailable',pagesRetired:0,factsRetired:0});
});


it('saves a full sixteen-occurrence page within one bounded typed-column batch',async()=>{
 const facts=await Promise.all(Array.from({length:16},(_,index)=>fact(scope,day,index.toString(16),index)));
 const meter=createD1InvocationBudget(12);
 const saved=await materializeCanonicalPage({db:meter.wrap(db()),sourceId,scope,ownerRevision:1,authorityEpoch:1,
  pageKey:'c'.repeat(64),sourceRevision:'d'.repeat(64),stillCurrent:async()=>true,
  load:async()=>facts.map(value=>({occurrenceKey:value.occurrenceKey,stream:value.stream,expectedRevision:null,fact:value}))});
 expect(saved.effects).toHaveLength(16);expect(saved.state).toBe('complete');
 expect(meter.queriesUsed).toBeLessThanOrEqual(10);
 expect(await readCanonicalFacts(db(),facts.map(value=>value.revision))).toEqual(facts.sort(compareCanonicalFacts));
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});


it('retires only abandoned empty generations and globally unreferenced dirty roots',async()=>{
 const {retireCanonicalAnalyticsPage}=await import('../src/storage-canonical-analytics-facts');
 const root='effective-union-v1/usage/2026-09-20/00';
 const first=await materializeCanonicalPartition(db(),root);if(first.state!=='complete')throw Error('unexpected split');
 await db().prepare('INSERT INTO analytics_canonical_dirty_partitions VALUES(?,1)').bind(root).run();
 const foreignSource='synthetic-canonical-other';await db().prepare('INSERT INTO analytics_runtime_sources VALUES(?,?,1)').bind(foreignSource,foreignSource).run();
 await db().prepare(`INSERT INTO analytics_partition_work(work_key,head_key,source_id,partition_key,input_revision,policy_revision,
  stage,lane,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms) VALUES(?,?,?,?,?,?,'features','recovery',1,1,0,0,0)`)
  .bind('1'.repeat(64),'2'.repeat(64),foreignSource,root,first.manifest.contentRevision,'3'.repeat(64)).run();
 expect(await retireCanonicalAnalyticsPage(db(),sourceId,1)).toMatchObject({partitionHeadsRetired:0,manifestsRetired:0,dirtyPartitionsRetired:0});
 await db().prepare("UPDATE analytics_partition_work SET state='complete',revision=revision+1 WHERE work_key=?").bind('1'.repeat(64)).run();
 const current=await materializeCanonicalPartition(db(),root);if(current.state!=='complete')throw Error('unexpected split');
 const closure='4'.repeat(64);await db().prepare(`INSERT INTO analytics_canonical_publication_closures VALUES(?,?,?,'activity',1,?,1,'capturing',0)`)
  .bind(closure,sourceId,day,'5'.repeat(64)).run();
 await db().prepare("INSERT INTO analytics_canonical_publication_expected(closure_key,partition_key,content_revision,outcome) VALUES(?,?,?,'pending')")
  .bind(closure,root,first.manifest.contentRevision).run();
 expect((await retireCanonicalAnalyticsPage(db(),sourceId,1)).manifestsRetired).toBe(0);
 await db().prepare('DELETE FROM analytics_canonical_publication_closures WHERE closure_key=?').bind(closure).run();
 expect((await retireCanonicalAnalyticsPage(db(),sourceId,1)).manifestsRetired).toBe(1);
 expect(await readCanonicalPartition(db(),root)).toMatchObject({manifest:{contentRevision:current.manifest.contentRevision,rowCount:0}});
 const orphan='effective-union-v1/usage/2026-09-20/01';await materializeCanonicalPartition(db(),orphan);
 await db().prepare('INSERT INTO analytics_canonical_dirty_partitions VALUES(?,1)').bind(orphan).run();
 const retired=await retireCanonicalAnalyticsPage(db(),sourceId,1);
 expect(retired).toMatchObject({partitionHeadsRetired:1,manifestsRetired:1,dirtyPartitionsRetired:1});
 expect(await db().prepare('SELECT 1 present FROM analytics_canonical_dirty_partitions WHERE partition_key=?').bind(root).first()).not.toBeNull();
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});


it('G06 bounds obsolete fact provenance and preserves current heads and cache pins',async()=>{
 const {retireCanonicalAnalyticsPage}=await import('../src/storage-canonical-analytics-facts');
 const old=await normalizeNativeEffectiveOccurrence(scope,oracle(scope,day,'a',{
  canonicalEvidence:{...evidence(),variants:Array.from({length:2048},(_,n)=>({coordinate:'synthetic-variant:'+n,
   format:'v11' as const,observedAtMs:Date.parse(day+'T12:05:00.000Z')}))}}),0);
 const survivor=await fact(other,day,'b');await apply([old],'skew-provenance');await apply([survivor],'skew-survivor',other);
 await db().prepare(`INSERT INTO analytics_canonical_cache_slots(slot_key,fact_revision,occurrence_key,root_partition_key,logical_key,
  source_id,owner_digest,selection_method,day,observed_ms,native_order,payload) VALUES(?,?,?,?,?,?,?,?,?,?,0,'{}')`)
  .bind('cache-slot',old.revision,old.occurrenceKey,old.location.partitionKey,'cache-logical',sourceId,scope.ownerDigest,
   scope.selectionMethod,day,old.location.observedAtMs).run();
 // Retained rolling input and window membership must be released by their owner.
 const inputKey='7'.repeat(64),segment='8'.repeat(64),window='9'.repeat(64),stamp='a'.repeat(64),method='b'.repeat(64);
 await db().prepare(`INSERT INTO analytics_canonical_input_work(scope_key,source_id,owner_digest,selection_method,stream,
  source_day,source_stamp,owner_revision,authority_epoch,state,seen_count) VALUES(?,?,?,?,'usage',?,?,1,1,'reading',1)`)
  .bind(inputKey,sourceId,scope.ownerDigest,scope.selectionMethod,day,stamp).run();
 await db().prepare('INSERT INTO analytics_canonical_input_seen VALUES(?,?)').bind(inputKey,old.occurrenceKey).run();
 await db().prepare("UPDATE analytics_canonical_input_work SET state='draining' WHERE scope_key=?").bind(inputKey).run();
 await db().prepare("UPDATE analytics_canonical_input_work SET state='sealed' WHERE scope_key=?").bind(inputKey).run();
 await db().prepare(`INSERT INTO analytics_canonical_rolling_segments(segment_key,source_id,owner_digest,scope_key,source_stamp,
  selection_method,day,stream,method_digest,state) VALUES(?,?,?,?,?,?,?,'usage',?,'building')`)
  .bind(segment,sourceId,scope.ownerDigest,inputKey,stamp,scope.selectionMethod,day,method).run();
 await db().prepare(`INSERT INTO analytics_canonical_rolling_rows(segment_key,fact_revision,observed_ms,native_order,payload,payload_digest)
  VALUES(?,?,?,0,?,?)`).bind(segment,old.revision,old.location.observedAtMs,'{}',await sha256Hex('{}')).run();
 await db().prepare("UPDATE analytics_canonical_rolling_segments SET state='complete',row_count=1 WHERE segment_key=?").bind(segment).run();
 await db().prepare(`INSERT INTO analytics_canonical_rolling_windows(window_key,source_id,owner_digest,kind,from_ms,native_dependency,
  method_digest,state,member_count) VALUES(?,?,?,'effective-scalar',0,?,?,'building',1)`)
  .bind(window,sourceId,scope.ownerDigest,stamp,method).run();
 await db().prepare('INSERT INTO analytics_canonical_rolling_members VALUES(?,?)').bind(window,segment).run();
 await db().prepare("UPDATE analytics_canonical_rolling_windows SET state='complete' WHERE window_key=?").bind(window).run();
 await materializeCanonicalPage({db:db(),sourceId,scope,ownerRevision:1,authorityEpoch:1,pageKey:'5'.repeat(64),
  sourceRevision:'6'.repeat(64),stillCurrent:async()=>true,load:async()=>[
   {occurrenceKey:old.occurrenceKey,stream:'usage',expectedRevision:old.revision,fact:null}]});
 await db().prepare("UPDATE analytics_partition_canonical_effects SET state='accepted'").run();
 const pinned=await retireCanonicalAnalyticsPage(db(),sourceId,16);
 expect(pinned.factChildrenRetired).toBe(0);expect(await readCanonicalFacts(db(),[old.revision])).toEqual([old]);
 // The owning cache adapter has retired the old slot; ordinary fact GC may now drain.
 await db().prepare('DELETE FROM analytics_canonical_cache_slots WHERE fact_revision=?').bind(old.revision).run();
 const held=await retireCanonicalAnalyticsPage(db(),sourceId,16);
 expect(held.factChildrenRetired).toBe(0);expect(await readCanonicalFacts(db(),[old.revision])).toEqual([old]);
 expect(await db().prepare('SELECT 1 pinned FROM analytics_canonical_rolling_members WHERE window_key=? AND segment_key=?').bind(window,segment).first()).not.toBeNull();
 expect(await db().prepare('SELECT 1 pinned FROM analytics_canonical_rolling_rows WHERE fact_revision=?').bind(old.revision).first()).not.toBeNull();
 // Simulate the owning rolling adapter's child-first retirement after unpinning.
 await db().prepare('DELETE FROM analytics_canonical_rolling_members WHERE window_key=?').bind(window).run();
 await db().prepare('DELETE FROM analytics_canonical_rolling_windows WHERE window_key=?').bind(window).run();
 await db().prepare('DELETE FROM analytics_canonical_rolling_rows WHERE segment_key=?').bind(segment).run();
 await db().prepare('DELETE FROM analytics_canonical_rolling_segments WHERE segment_key=?').bind(segment).run();
 let removed=0,rootDeleted=false;
 for(let turn=0;turn<18;turn++) {
  const profile=createAnalyticsProfile();
  const result=await retireCanonicalAnalyticsPage(profileAnalyticsDatabase(db(),'target',profile,()=> 'fact-drain'),sourceId,16);
  removed+=result.factChildrenRetired;expect(result.factChildrenRetired).toBeLessThanOrEqual(128);
  expect(Object.values(profile.costs).reduce((sum,cost)=>sum+cost.rowsWritten,0)).toBeLessThanOrEqual(700);
  const remaining=await db().prepare('SELECT count(*) n FROM analytics_canonical_variants WHERE revision=?').bind(old.revision).first<number>('n');
  const root=await db().prepare('SELECT 1 alive FROM analytics_canonical_facts WHERE revision=?').bind(old.revision).first();
  if(remaining!>0)expect(root).not.toBeNull();
  expect(await readCanonicalFacts(db(),[survivor.revision])).toEqual([survivor]);
  if(!root){rootDeleted=true;break;}
 }
 expect(rootDeleted).toBe(true);expect(removed).toBe(2049); // complete variants plus its linked day
 expect(await readCanonicalFacts(db(),[old.revision])).toEqual([]);
 expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
