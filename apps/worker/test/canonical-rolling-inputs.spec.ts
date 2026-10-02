import {env,reset} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {readEffectiveTelemetryOwnerDayPage} from '../src/telemetry-usage-effective-reader';
import {normalizeNativeEffectiveOccurrence,type CanonicalFact} from '../src/canonical-analytics-facts';
import {prepareCanonicalFeatureContribution,priceCanonicalFeatureContribution,CANONICAL_FIT_PRICE_METHOD,type CanonicalPriceProduct} from '../src/canonical-feature-contributions';
import {createSharedAnalyticsFeaturePending,appendSharedAnalyticsFeaturePage,finishSharedAnalyticsFeatureDay} from '../src/analytics-shared-features';
import {prepareCanonicalRollingDay,canonicalRollingOccurrenceId,canonicalEffectiveUsageInputs} from '../src/canonical-rolling-inputs';
import {appendEffectiveUsageDay,type EffectiveUsageDayPending} from '../src/effective-usage-day';
import {evaluatePreparedModelDate} from '../src/analytics-model-block-contract';
import {modelHistoryWindow} from '../src/model-history-window';
const b=env as Env & SharedAnalyticsCorpusMigrations & {USAGE_MONITOR_DB:D1Database;STORAGE_ANALYTICS_DB:D1Database};
it('prepares native quota/model/scalar evidence from actual selected v1/v11/v12 facts before and after cross-day correction',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-rolling';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 let owner=corpus.owner;
 for(const corrected of [false,true]){
  if(corrected)owner=await corpus.mutateCorrection();
  const nativeDays=new Map<string,Awaited<ReturnType<typeof finishSharedAnalyticsFeatureDay>>>();
  const preparedDays=new Map<string,Awaited<ReturnType<typeof prepareCanonicalRollingDay>>>();
  for(const day of corpus.populatedDates){
   let pending=createSharedAnalyticsFeaturePending(day,owner.ownerDigest);
   const facts:CanonicalFact[]=[],prices:CanonicalPriceProduct[]=[];
   for(const stream of ['usage','quota','session'] as const){
    const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
     ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:200});
    expect(page.next).toBeNull();pending=await appendSharedAnalyticsFeaturePage(pending,stream,page.rows,null);
    for(const [rank,row]of page.rows.entries()){
     const fact=await normalizeNativeEffectiveOccurrence({sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
      selectionMethod:'effective-union-v1'},row,rank);facts.push(fact);
     if(stream==='usage')prices.push(priceCanonicalFeatureContribution(await prepareCanonicalFeatureContribution(fact),CANONICAL_FIT_PRICE_METHOD));
    }
   }
   const native=await finishSharedAnalyticsFeatureDay(pending),canonical=await prepareCanonicalRollingDay({day,ownerDigest:owner.ownerDigest,facts,prices});
   const expectedQuota=structuredClone(native.quota);
   for(const endpoint of expectedQuota.projection.runEndpoints.endpoints)endpoint.row.occurrence_id=canonicalRollingOccurrenceId(
    facts.filter(fact=>fact.stream==='quota')[endpoint.sourceRowId-1]!);
   expect(canonical.quota).toEqual(expectedQuota);expect(canonical.modelUsage).toEqual(native.modelUsage);
   let paged:EffectiveUsageDayPending|null=null;
   const usageFacts=facts.filter(fact=>fact.stream==='usage');
   for(let offset=0;offset<usageFacts.length;offset+=7){
    const page=usageFacts.slice(offset,offset+7),inputs=page.map(fact=>canonicalEffectiveUsageInputs(fact,prices.find(price=>price.factRevision===fact.revision)!));
    paged=await appendEffectiveUsageDay(paged,day,inputs.map(value=>value.row),owner.ownerDigest,
     inputs.map(value=>value.inputs),page.map(fact=>fact.nativeScopes.graphSessionDigest!));
   }
   if(paged)expect(paged.projection).toEqual(native.modelUsage.projection);
   await expect(appendEffectiveUsageDay(null,day,[],owner.ownerDigest,[],['invalid']))
    .rejects.toThrow('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');
   nativeDays.set(day,native);preparedDays.set(day,canonical);
   expect(canonical.scalarUsage).toEqual(native.scalarUsage.map((value,index)=>({...value,
    occurrenceId:canonicalRollingOccurrenceId(facts.filter(fact=>fact.stream==='usage')[index]!)})));
   if(prices.length){await expect(prepareCanonicalRollingDay({day,ownerDigest:owner.ownerDigest,facts,prices:[]})).rejects.toThrow('missing_fit_price');
    await expect(prepareCanonicalRollingDay({day,ownerDigest:owner.ownerDigest,facts,prices:prices.map(price=>({...price,method:{...price.method,family:'daily' as const}}))})).rejects.toThrow('missing_fit_price');}
  }
  for(const day of corpus.modelFitDates){
   const window=modelHistoryWindow(day),days=Array.from({length:101},(_,index)=>new Date(Date.parse(window.observedAtCutoff)+index*86_400_000).toISOString().slice(0,10));
   const pin={source:'v1.1' as const,participantId:owner.participantId,generationId:'effective:'+owner.ownerDigest,fromDay:window.fromDay,
    throughDay:day,inputRevision:owner.inputRevision,mutationEpoch:owner.authorityEpoch,fingerprint:'a'.repeat(64)};
   const empty=await Promise.all(days.map(label=>prepareCanonicalRollingDay({day:label,ownerDigest:owner.ownerDigest,facts:[],prices:[]})));
   const native=await evaluatePreparedModelDate({pin,day,quotaDays:days.map((label,i)=>nativeDays.get(label)?.quota??empty[i]!.quota),
    usageDays:days.map((label,i)=>nativeDays.get(label)?.modelUsage??empty[i]!.modelUsage)});
   const prepared=await evaluatePreparedModelDate({pin,day,quotaDays:days.map((label,i)=>preparedDays.get(label)?.quota??empty[i]!.quota),
    usageDays:days.map((label,i)=>preparedDays.get(label)?.modelUsage??empty[i]!.modelUsage)});
   expect(prepared).toEqual(native);expect(prepared.status).toBe('complete');
  }
 }
},30_000);
