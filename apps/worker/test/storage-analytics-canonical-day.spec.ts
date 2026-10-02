import {env,reset} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import * as featureProducts from '../src/storage-canonical-feature-contributions';
import {initializeSharedAnalyticsCorpusDatabases,seedSharedAnalyticsCorpus,type SharedAnalyticsCorpusMigrations} from './fixtures/shared-analytics-corpus';
import {readEffectiveTelemetryOwnerDayPage} from '../src/telemetry-usage-effective-reader';
import {createSharedAnalyticsFeaturePending,appendSharedAnalyticsFeaturePage,finishSharedAnalyticsFeatureDay} from '../src/analytics-shared-features';
import {advanceSharedAnalyticsFeatureDay,type SharedAnalyticsFeatureInput} from '../src/storage-analytics-shared-features';
import {createCanonicalSharedFeaturePreparation} from '../src/storage-analytics-canonical-day';
import {createD1InvocationBudget} from '../src/d1-invocation-budget';
import {withMaintainedEffectiveDependencies} from '../src/storage-effective-dependency-summaries';
const b=env as Env&SharedAnalyticsCorpusMigrations&{STORAGE_ANALYTICS_DB:D1Database};
it('resumes ordered canonical pages into the exact native shared bundle and reuses unchanged/corrected admitted evidence within950 statements',async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-shared-day';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:12,graphDays:2,
  denseUsageRows:260,anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 let owner=corpus.owner;
 const mirror=()=>target.prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
  VALUES(?,?,?,?,'active') ON CONFLICT(source_id,owner_digest) DO UPDATE SET revision=excluded.revision,authority_epoch=excluded.authority_epoch`)
  .bind(sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).run();
 const makeInput=(day:string)=>{
  const meter=createD1InvocationBudget(950),input:SharedAnalyticsFeatureInput={source:meter.wrap(withMaintainedEffectiveDependencies(source,target,sourceId,sourceId)),
   target:meter.wrap(target),sourceId,sourceNamespace:sourceId,owner,day,budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+60_000}};
  return {meter,input:{...input,canonicalPreparation:createCanonicalSharedFeaturePreparation(input)}};
 };
 const native=async(day:string)=>{
  let pending=createSharedAnalyticsFeaturePending(day,owner.ownerDigest);
  for(const stream of ['usage','quota','session'] as const){
   let after:Parameters<typeof readEffectiveTelemetryOwnerDayPage>[1]['after'];
   do {const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:200,...(after?{after}:{})});
    pending=await appendSharedAnalyticsFeaturePage(pending,stream,page.rows,page.next);after=page.next??undefined;
   }while(after);
  }
  return finishSharedAnalyticsFeatureDay(pending);
 };
 const build=async(day:string)=>{
  const reasons:string[]=[];
  for(let turn=0;turn<120;turn++){
   const {meter,input}=makeInput(day),result=await advanceSharedAnalyticsFeatureDay(input);
   expect(meter.queriesUsed).toBeLessThanOrEqual(950);
   if(result.state==='complete')return result;
   expect(result.state,JSON.stringify({turn,result,reasons:reasons.slice(-4)})).toBe('deferred');
   reasons.push(result.reason);
  }
  throw new Error('canonical day did not converge: '+reasons.slice(-10).join(','));
 };
 await mirror();const dense=corpus.graphDates[0]!,denseResult=await build(dense);
 const denseNative=await native(dense);
 expect(denseResult.value).toEqual(denseNative);
 expect(denseResult.value.cacheEventsRead).toBeGreaterThan(256);
 const changed=corpus.correctionDay;
 const before=await build(changed);expect(before.value).toEqual(await native(changed));
 const warm=makeInput(changed),producer=vi.fn(warm.input.canonicalPreparation!);
 expect(await advanceSharedAnalyticsFeatureDay({...warm.input,canonicalPreparation:producer})).toMatchObject({state:'complete',reused:true,value:before.value});
 expect(producer).not.toHaveBeenCalled();
 owner=await corpus.appendOutsideV11();await mirror();
 const unrelated=await build(changed);expect(unrelated).toMatchObject({reused:true,value:before.value});
 owner=await corpus.mutateCorrection();await mirror();
 const corrected=await build(changed);
 expect(corrected.value).toEqual(await native(changed));
 expect(corrected.value).not.toEqual(before.value);
},120_000);

for(const change of ['none','capability','target'] as const)it(`folds three sealed streams in one invocation and fences ${change} before B02 completion`,async()=>{
 await reset();const source=b.USAGE_MONITOR_DB,target=b.STORAGE_ANALYTICS_DB,sourceId='synthetic-canonical-batch-fence';
 await initializeSharedAnalyticsCorpusDatabases(source,target,b,sourceId);
 const corpus=await seedSharedAnalyticsCorpus({source,target,sourceId,sourceNamespace:sourceId,calendarDays:10,graphDays:2,
  anchorDay:new Date(Date.now()-86_400_000).toISOString().slice(0,10)});
 const owner=corpus.owner,day=corpus.sessionDay;
 const input=()=>{const meter=createD1InvocationBudget(950),value:SharedAnalyticsFeatureInput={
  source:meter.wrap(withMaintainedEffectiveDependencies(source,target,sourceId,sourceId)),target:meter.wrap(target),sourceId,
  sourceNamespace:sourceId,owner,day,budget:{remainingQueries:()=>meter.remainingQueries,now:Date.now,deadlineMs:Date.now()+60_000}};
  return {meter,value:{...value,canonicalPreparation:createCanonicalSharedFeaturePreparation(value)}};};
 let expected:Awaited<ReturnType<typeof advanceSharedAnalyticsFeatureDay>>|undefined;
 for(let attempt=0;attempt<40;attempt++){
  const run=input();expected=await advanceSharedAnalyticsFeatureDay(run.value);
  expect(run.meter.queriesUsed).toBeLessThanOrEqual(950);
  if(expected.state==='complete')break;
  expect(expected.state).toBe('deferred');
 }
 expect(expected?.state).toBe('complete');
 if(expected?.state!=='complete')throw new Error('canonical fixture did not complete');
 const native=await (async()=>{
  let pending=createSharedAnalyticsFeaturePending(day,owner.ownerDigest);
  for(const stream of ['usage','quota','session'] as const){
   const page=await readEffectiveTelemetryOwnerDayPage(source,{sourceNamespace:sourceId,ownerDigest:owner.ownerDigest,
    ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,day,stream,limit:200});
   expect(page.next).toBeNull();pending=await appendSharedAnalyticsFeaturePage(pending,stream,page.rows,null);
  }
  return finishSharedAnalyticsFeatureDay(pending);
 })();
 expect(expected.value).toEqual(native);
 // Preserve immutable facts/products; rerun only the final B02 consumer fold.
 await target.prepare('DELETE FROM analytics_shared_feature_days WHERE source_id=? AND day=?').bind(sourceId,day).run();
 let calls=0;
 const original=featureProducts.materializeCanonicalFeatureRows;
 const products=vi.spyOn(featureProducts,'materializeCanonicalFeatureRows').mockImplementation(async options=>{
  const result=await original(options);
  if(result.state==='complete')expect(result.metrics).toMatchObject({quantitiesPrepared:0,dailyPriceCalls:0,fitPriceCalls:0});
  if(result.state==='complete'&&++calls===3){
   if(change==='capability')await source.prepare('DROP TRIGGER storage_effective_selective_correction_fact_insert').run();
   if(change==='target')await target.prepare("UPDATE analytics_owner_state SET state='erased',revision=revision+1,authority_epoch=authority_epoch+1 WHERE source_id=? AND owner_digest=?")
    .bind(sourceId,owner.ownerDigest).run();
  }
  return result;
 });
 const run=input();
 try{
  const result=await advanceSharedAnalyticsFeatureDay(run.value);
  expect(calls).toBe(3);expect(run.meter.queriesUsed).toBeLessThanOrEqual(950);
  if(change==='none')expect(result).toMatchObject({state:'complete',reused:false,value:native});
  else {
   expect(result.state).toBe('deferred');
   expect(await target.prepare("SELECT count(*) AS n FROM analytics_shared_feature_days WHERE source_id=? AND day=? AND state='complete'")
    .bind(sourceId,day).first<number>('n')).toBe(0);
  }
 }finally{products.mockRestore();}
},120_000);
