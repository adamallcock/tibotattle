import { env, reset } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { appendSharedAnalyticsFeaturePage, createSharedAnalyticsFeaturePending,
  finishSharedAnalyticsFeatureDay } from '../src/analytics-shared-features';
import { appendEffectiveUsageDay, mapEffectiveUsagePageRow } from '../src/effective-usage-day';
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, mapEffectiveQuotaPageRow } from '../src/effective-quota-day';
import { cacheRetentionEventFromRecord, cacheRetentionSessionDigest } from '../src/cache-retention-events';
import { prepareV11UsageFeature, prepareV11UsageRowInputs, v11PreparedUsageDayRow } from '../src/quota-analysis-v11';
import * as pricing from '../src/quota-analysis-v1';
import { priceChunkUsageRecord, priceChunkUsageRecordValue } from '../src/quota-analysis-v1';
import { createV11DailyProjectionValues, foldV11DailyProjectionValues } from '../src/v11-daily-projection-values';
import { graphDayUsageSessionDigest } from '../src/graph-day-projection';
import { readEffectiveTelemetryOwnerDayPage } from '../src/telemetry-usage-effective-reader';
import type { EffectiveTelemetryOccurrence, EffectiveTelemetryStream } from '../src/telemetry-usage-effective-reader';
import type { CacheRetentionItem } from '../src/cache-retention-values';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus,
  type SharedAnalyticsCorpusMigrations } from './fixtures/shared-analytics-corpus';

const day='2026-09-11', owner='a'.repeat(64), time=`${day}T12:05:00.000Z`;
function occurrence(stream:EffectiveTelemetryStream,record:unknown,index:number):EffectiveTelemetryOccurrence {
  return {methodVersion:'effective-telemetry-owner-day-v1',stream,participantId:'synthetic-participant',
    ownerDigest:owner,occurrenceId:`synthetic-occurrence-${String(index).padStart(3,'0')}`,eventTime:time,
    eventTimeConflict:false,status:'compatible',sourceCount:index%3+1,
    sourceFormats:index%3===0?['v1']:index%3===1?['v11']:['v1','v11','v12'],
    sourceRowIds:[],sourceRecordKeys:[],recordJson:canonicalTelemetryV11Json(record)};
}
function fixture() {
  const usage=Array.from({length:6},(_,index)=>{
    const record=v11UsageRecord(day,'a',{eventId:`event:v2:${index.toString(16).padStart(64,'0')}`,
      modelId:index===2?'synthetic-unpriced-model':'gpt-5.6-sol',
      accountPlanAttribution:{accountBasis:'same_source',accountTrackId:`account-track:v2:${(index<3?'b':'c').repeat(64)}`,
        planBasis:'same_source_occurrence',planType:'pro',planEraId:null}});
    if(index===3)record.components.inputUncachedTokens=null;
    if(index===4)record.components={inputUncachedTokens:null,inputCacheReadTokens:null,inputCacheWriteTokens:null,
      outputTextTokens:null,outputReasoningTokens:null,outputCombinedTokens:null};
    if(index===5)record.components={inputUncachedTokens:0,inputCacheReadTokens:0,inputCacheWriteTokens:0,
      outputTextTokens:0,outputReasoningTokens:0,outputCombinedTokens:null};
    return occurrence('usage',record,index);
  });
  const quota=Array.from({length:2},(_,index)=>occurrence('quota',{
    schemaVersion:'quota-observation-v1.1',observationId:`quota-occurrence:v1:${(index?'e':'d').repeat(64)}`,
    provider:'openai_codex',observedTime:time,planType:'pro',planVariant:'unknown',limitId:'codex',slot:'secondary',
    usedPercent:10+index,windowDurationMinutes:10_080,resetsAt:'2026-09-14T00:00:00.000Z',
    accountPlanAttribution:{accountBasis:'unavailable',accountTrackId:null,
      planBasis:'same_source_occurrence',planType:'pro',planEraId:null}},index));
  const session=Array.from({length:2},(_,index)=>occurrence('session',{
    schemaVersion:'session-dimension-v1.1',sessionUuid:`0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0${index}`,
    firstEventTime:time,provider:'openai_codex',toolClassCounts:{shell:0,other:3}},index));
  return {usage,quota,session};
}
async function nativePagePreparation(rows:ReturnType<typeof fixture>,scope={day,owner}) {
  const {day,owner}=scope;
  let daily=createV11DailyProjectionValues(day);
  for(const page of [rows.usage,rows.quota,rows.session])for(const row of page)
    daily=foldV11DailyProjectionValues(daily,[JSON.parse(row.recordJson!)]);
  const quotaPending=appendEffectiveQuotaDay(null,day,
    rows.quota.map((row,index)=>mapEffectiveQuotaPageRow(row,day,index+1)),10_080)!;
  const usageRows=rows.usage.map(mapEffectiveUsagePageRow);
  let modelUsage=await appendEffectiveUsageDay(null,day,usageRows.slice(0,3),owner);
  modelUsage=await appendEffectiveUsageDay(modelUsage,day,usageRows.slice(3),owner);
  const scalarUsage=await Promise.all(usageRows.map((row,index)=>prepareV11UsageFeature(row,owner)
    .then(feature=>({...feature,occurrenceId:`ord:${String(index+1).padStart(6,'0')}`}))));
  const cacheItems:CacheRetentionItem[]=[];
  for(const [index,row] of rows.usage.entries()) {
    const record=JSON.parse(row.recordJson!);
    const sessionDigest=await cacheRetentionSessionDigest({ownerDigest:owner,provider:record.provider,sessionUuid:record.sessionUuid});
    const item=cacheRetentionEventFromRecord({sessionDigest,observedAtMs:Date.parse(row.eventTime!),
      orderKey:`ord:${String(index+1).padStart(6,'0')}`,recordJson:row.recordJson!});
    if(item)cacheItems.push(item);
  }
  return {daily,quota:finishEffectiveQuotaDay(quotaPending),modelUsage:{projection:modelUsage!.projection},scalarUsage,cacheItems};
}
async function sharedPagePreparation(rows:ReturnType<typeof fixture>,scope={day,owner}) {
  const {day,owner}=scope;
  let pending=createSharedAnalyticsFeaturePending(day,owner);
  const split=Math.min(3,rows.usage.length),tail=rows.usage[split-1];
  pending=await appendSharedAnalyticsFeaturePage(pending,'usage',rows.usage.slice(0,split),
    split<rows.usage.length?{observedAtMs:Date.parse(tail!.eventTime!),occurrenceId:tail!.occurrenceId}:null);
  if(split<rows.usage.length)pending=await appendSharedAnalyticsFeaturePage(pending,'usage',rows.usage.slice(split),null);
  pending=await appendSharedAnalyticsFeaturePage(pending,'quota',rows.quota,null);
  pending=await appendSharedAnalyticsFeaturePage(pending,'session',rows.session,null);
  return finishSharedAnalyticsFeatureDay(pending);
}
async function counted<T>(operation:()=>Promise<T>) {
  let decodes=0;
  const prices=vi.spyOn(pricing,'priceChunkUsageRecordValue');
  const original=JSON.parse;
  const spy=vi.spyOn(JSON,'parse').mockImplementation((raw,...rest)=>{
    if(typeof raw==='string'&&/"schemaVersion":"(?:usage-event|quota-observation|session-dimension)-v1\./u.test(raw))decodes++;
    return original(raw,...rest);
  });
  try {return {value:await operation(),decodes,prices:prices.mock.calls.length};}
  finally {spy.mockRestore();prices.mockRestore();}
}
describe('shared source page preparation',()=>{
  it('matches native daily, scalar, model, quota and cache preparation and decodes each compatible analytical row only twice',async()=>{
    // Effective rows are already reconciled analytical v1.1; these pages cover
    // v1, v1.1 and mixed v1/v1.1/v1.2 source provenance without reselecting it.
    const rows=fixture();
    const native=await counted(()=>nativePagePreparation(rows));
    const shared=await counted(()=>sharedPagePreparation(rows));
    expect(shared.value).toMatchObject(native.value);
    expect(shared.value.cacheEventsRead).toBe(6);
    expect(shared.decodes).toBe(20); // Source decode plus typed immutable snapshot, once per row.
    expect(native.decodes).toBe(52); // Independently prepared native lanes over these same pages.
    expect(native.prices).toBe(18); // Daily, model and scalar separately.
    expect(shared.prices).toBe(12); // Daily stays separate; only model/scalar share pricing.
    const durable=JSON.stringify(shared.value);
    for(const forbidden of ['recordJson','record_json','sessionUuid','session_uuid','0a49f9db'])
      expect(durable).not.toContain(forbidden);
  });
  it('preserves exact preparation for accepted overlapping v1, v1.1 and v1.2 source evidence',async()=>{
    await reset();
    const bindings=env as Env & SharedAnalyticsCorpusMigrations & {STORAGE_ANALYTICS_DB:D1Database};
    const sourceId='synthetic-preparation-parity',sourceNamespace=sourceId;
    const source=bindings.USAGE_MONITOR_DB,target=bindings.STORAGE_ANALYTICS_DB;
    await initializeSharedAnalyticsCorpusDatabases(source,target,bindings,sourceId,sourceNamespace);
    const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace,
      anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10),calendarDays:14,graphDays:2});
    const rows:ReturnType<typeof fixture>={usage:[],quota:[],session:[]};
    for(const stream of ['usage','quota','session'] as const) {
      const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace,ownerDigest:corpus.owner.ownerDigest,
        ownerRevision:corpus.owner.ownerRevision,authorityEpoch:corpus.owner.authorityEpoch,
        day:corpus.equivalentDay,stream,limit:200});
      expect(page.next).toBeNull();
      rows[stream]=[...page.rows];
    }
    expect(rows.usage.some(row=>row.sourceFormats.join(',')==='v1,v11,v12'&&row.status==='compatible')).toBe(true);
    const scope={day:corpus.equivalentDay,owner:corpus.owner.ownerDigest};
    const native=await nativePagePreparation(rows,scope),shared=await sharedPagePreparation(rows,scope);
    expect(shared).toMatchObject(native);
    expect(shared.scalarUsage).toHaveLength(rows.usage.length);
    expect(shared.cacheEventsRead).toBe(rows.usage.length);
  });
  it('keeps session refusal ahead of lazy pricing when compatible row inputs are reused',async()=>{
    const source=fixture().usage[0]!,row=mapEffectiveUsagePageRow(source);
    const inputs=prepareV11UsageRowInputs(row,JSON.parse(source.recordJson!));
    const price=vi.fn(inputs.price),prepared={...inputs,price};
    const digest=(provider:string,sessionUuid:string)=>graphDayUsageSessionDigest({ownerDigest:owner,provider,sessionUuid});
    expect(await v11PreparedUsageDayRow(row,digest,new Set(),0,prepared))
      .toEqual({status:'refused',reason:'session_interval_scope_limit_exceeded'});
    expect(price).not.toHaveBeenCalled();
    const native=await v11PreparedUsageDayRow(row,digest);
    expect(await v11PreparedUsageDayRow(row,digest,new Set(),10,prepared)).toEqual(native);
    expect(await prepareV11UsageFeature(row,owner,prepared)).toEqual(await prepareV11UsageFeature(row,owner));
  });
  it('keeps the parsed-record pricer identical for full, partial, unknown and unmeasurable evidence',()=>{
    for(const source of fixture().usage) {
      const record=JSON.parse(source.recordJson!);
      expect(priceChunkUsageRecordValue(record,time)).toEqual(priceChunkUsageRecord(source.recordJson!,time));
    }
    expect(priceChunkUsageRecordValue(null,time)).toBeNull();
    expect(priceChunkUsageRecord('invalid json',time)).toBeNull();
  });
});
