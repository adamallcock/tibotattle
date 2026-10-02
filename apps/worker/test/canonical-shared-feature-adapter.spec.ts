import {env,reset} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,
 type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {readEffectiveTelemetryOwnerDayPage} from '../src/telemetry-usage-effective-reader';
import {normalizeNativeEffectiveOccurrence} from '../src/canonical-analytics-facts';
import {prepareCanonicalFeatureContribution,priceCanonicalFeatureContribution,CANONICAL_DAILY_PRICE_METHOD,
 foldCanonicalActivityContributions,type CanonicalActivityInput} from '../src/canonical-feature-contributions';
import {appendSharedAnalyticsFeaturePage,createSharedAnalyticsFeaturePending,finishSharedAnalyticsFeatureDay} from '../src/analytics-shared-features';
import {advanceSharedAnalyticsFeatureDay,readSharedAnalyticsFeatureDay} from '../src/storage-analytics-shared-features';
import {createV11DailyProjectionValues,foldV11DailyProjectionValues} from '../src/v11-daily-projection-values';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {advanceCanonicalInputWork,type CanonicalInputScope} from '../src/storage-canonical-analytics-input';
import {advanceEffectiveDependencyCoverage} from '../src/storage-effective-selective-dependencies';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
it('matches admitted mixed-format overlap and corrected native daily values through canonical facts',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-contribution-parity';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 let owner=corpus.owner;
 for(const corrected of [false,true]){
  if(corrected)owner=await corpus.mutateCorrection();
  for(const day of [...new Set([corpus.equivalentDay,corpus.correctionDay,corpus.sessionDay,corpus.modelFitDates[0]!])]){
   let native=createV11DailyProjectionValues(day);const inputs:CanonicalActivityInput[]=[];
   for(const stream of ['usage','quota','session'] as const){
    const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
     ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:200});
    expect(page.next).toBeNull();
    for(const [rank,row]of page.rows.entries()){
     native=foldV11DailyProjectionValues(native,[JSON.parse(row.recordJson!)]);
     const fact=await normalizeNativeEffectiveOccurrence({sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
      selectionMethod:'effective-union-v1'},row,rank);
     const contribution=await prepareCanonicalFeatureContribution(fact);
     inputs.push({contribution,dailyPrice:stream==='usage'?priceCanonicalFeatureContribution(contribution,CANONICAL_DAILY_PRICE_METHOD):null,membership:null});
    }
   }
   expect(foldCanonicalActivityContributions(day,'effective-union-v1',inputs).daily).toEqual(native);
  }
 }
},30_000);
it('uses B02 claims and parts for canonical day output, releases deferred claims, and reuses without invoking the producer',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-b02';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 const owner=corpus.owner,day=corpus.equivalentDay;
 let pending=createSharedAnalyticsFeaturePending(day,owner.ownerDigest);
 for(const stream of ['usage','quota','session'] as const){
  const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
   ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:200});
  expect(page.next).toBeNull();pending=await appendSharedAnalyticsFeaturePage(pending,stream,page.rows,null);
 }
 const value=await finishSharedAnalyticsFeatureDay(pending);
 const makeInput=()=>{const meter=createD1InvocationBudget(950);return {source:meter.wrap(source),target:meter.wrap(target),
  sourceId,sourceNamespace:sourceId,owner,day,budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+60_000}};};
 expect(await advanceSharedAnalyticsFeatureDay({...makeInput(),canonicalPreparation:async()=>({state:'deferred',reason:'partition_pending'})}))
  .toEqual({state:'deferred',reason:'partition_pending'});
 expect(await target.prepare('SELECT claim_token FROM analytics_shared_feature_days').first<string>('claim_token')).toBeNull();
 const producer=vi.fn(async()=>({state:'complete' as const,value}));
 expect(await advanceSharedAnalyticsFeatureDay({...makeInput(),canonicalPreparation:producer})).toMatchObject({state:'complete',value,reused:false});
 expect(producer).toHaveBeenCalledOnce();
 expect(await readSharedAnalyticsFeatureDay({...makeInput(),canonicalPreparation:producer})).toMatchObject({state:'complete',value,reused:true});
 expect(await advanceSharedAnalyticsFeatureDay({...makeInput(),canonicalPreparation:producer})).toMatchObject({state:'complete',value,reused:true});
 expect(producer).toHaveBeenCalledOnce();
 expect(await target.prepare('SELECT count(*) n FROM analytics_shared_feature_parts').first<number>('n')).toBeGreaterThan(0);
},30_000);


it('folds a real bounded canonical preparation group with full final proof and native parity',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-private-canonical-day';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 const owner=corpus.owner,day=corpus.equivalentDay;
 let native=createSharedAnalyticsFeaturePending(day,owner.ownerDigest);
 for(let n=0;n<48;n++) {
  const coverage=await advanceEffectiveDependencyCoverage(source,{sourceId,sourceNamespace:sourceId,
   participantId:owner.participantId,maxSteps:64,maxRows:128});
  expect(coverage.status).not.toBe('unavailable');if(coverage.status==='complete')break;
 }
 for(const stream of ['usage','quota','session'] as const) {
  const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
   ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:200});
  expect(page.next).toBeNull();native=await appendSharedAnalyticsFeaturePage(native,stream,page.rows,null);
  const scope:CanonicalInputScope={sourceId,sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
   participantId:owner.participantId,day,stream,selectionMethod:'effective-union-v1'};
  let sealed=false;
  for(let n=0;n<20&&!sealed;n++) {
   const progress=await advanceCanonicalInputWork(source,target,{...scope,
    budget:{meter:createD1InvocationBudget(950),maxSteps:32,deadlineMs:Date.now()+60_000,now:Date.now}});
   expect(progress.state).not.toBe('unavailable');sealed=progress.state==='complete';
  }
  expect(sealed).toBe(true);
 }
 const meter=createD1InvocationBudget(950),input={source:meter.wrap(source),target:meter.wrap(target),sourceId,
  sourceNamespace:sourceId,owner,day,budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+60_000}};
 const preparation=createCanonicalSharedFeaturePreparation(input);
 const result=await preparation({dependencyDigest:'a'.repeat(64),pending:createSharedAnalyticsFeaturePending(day,owner.ownerDigest)});
 expect(result).toEqual({state:'complete',value:await finishSharedAnalyticsFeatureDay(native)});
 expect(meter.queriesUsed).toBeLessThan(800);
},120_000);
