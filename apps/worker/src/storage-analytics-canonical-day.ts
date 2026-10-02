/** Composition of canonical facts into the existing shared day checkpoint.
 * Immutable quantities/prices are shared with partition work. The day fold
 * persists its opaque cursor, so later invocations process only the next page. */
import { createD1InvocationBudget, D1InvocationBudgetExceededError } from './d1-invocation-budget';
import { canonicalJson } from './canonical-json';
import { compareCanonicalFacts, type CanonicalFact } from './canonical-analytics-facts';
import { advanceCanonicalInputWork, readCanonicalInputPreparationFactPage, createCanonicalInputReadContext,
  closeCanonicalInputReadContext, canonicalInputReadContextCurrent, type CanonicalInputScope } from './storage-canonical-analytics-input';
import { advanceEffectiveDependencyCoverage } from './storage-effective-selective-dependencies';
import { materializeCanonicalFeatureRows, type CanonicalFeatureRowsResult } from './storage-canonical-feature-contributions';
import { CanonicalRollingRefused, canonicalEffectiveQuotaRow, canonicalEffectiveUsageInputs } from './canonical-rolling-inputs';
import { CANONICAL_DAILY_PRICE_METHOD, type CanonicalPriceProduct } from './canonical-feature-contributions';
import { canonicalCacheItems, canonicalCacheOrderKey } from './cache-retention-events';
import { appendEffectiveQuotaDay } from './effective-quota-day';
import { appendEffectiveUsageDay } from './effective-usage-day';
import { prepareV11UsageFeatureWithSession } from './quota-analysis-v11';
import { foldV11DailyContribution, v11DailyPricingContribution } from './v11-daily-projection-values';
import { finishSharedAnalyticsFeatureDay, validSharedAnalyticsFeaturePending, SharedFeatureRefused,
  SHARED_ANALYTICS_FEATURE_MAX_ROWS, type SharedAnalyticsFeaturePending } from './analytics-shared-features';
import type { SharedAnalyticsFeatureInput } from './storage-analytics-shared-features';

const STREAMS=['usage','quota','session'] as const;
const ordinal=(n:number)=>`ord:${String(n).padStart(6,'0')}`;
type Products=Extract<CanonicalFeatureRowsResult,{state:'complete'}>;
/** Pure page fold; native graph/session/price semantics are supplied explicitly. */
export async function appendCanonicalSharedFeaturePage(pending:SharedAnalyticsFeaturePending,
  products:Products,next:string|null):Promise<SharedAnalyticsFeaturePending> {
  if(!validSharedAnalyticsFeaturePending(pending)||pending.streamIndex>=STREAMS.length
    ||products.facts.length>128||products.facts.length===0&&next!==null)throw new SharedFeatureRefused('invalid_page');
  const stream=STREAMS[pending.streamIndex]!,facts=[...products.facts].sort(compareCanonicalFacts);
  const quantities=new Map(products.contributions.map(value=>[value.factRevision,value]));
  const fitPrices=new Map<string,CanonicalPriceProduct>(),dailyPrices=new Map<string,CanonicalPriceProduct>();
  for(const price of products.prices) {
    const map=price.method.family==='daily'?dailyPrices:fitPrices;
    if(map.has(price.factRevision))throw new SharedFeatureRefused('invalid_price');
    map.set(price.factRevision,price);
  }
  let daily=pending.daily;
  for(const fact of facts) {
    const quantity=quantities.get(fact.revision);
    if(!quantity||fact.stream!==stream||fact.provenance.selectionMethod!=='effective-union-v1'
      ||fact.location.day!==pending.day||fact.location.observedAtMs===null
      ||pending.after!==null&&fact.location.observedAtMs<pending.after.observedAtMs)
      throw new SharedFeatureRefused('source_conflict_or_order');
    const price=dailyPrices.get(fact.revision);
    if(stream==='usage'&&(!price||canonicalJson(price.method)!==canonicalJson(CANONICAL_DAILY_PRICE_METHOD)))
      throw new SharedFeatureRefused('daily_price_unavailable');
    daily=foldV11DailyContribution(daily,{stream,provider:quantity.provider,modelId:quantity.modelId,
      tokens:quantity.tokens,pricing:stream==='usage'?v11DailyPricingContribution(price!.value):null});
  }
  const sourceRowsRead=pending.sourceRowsRead+facts.length;
  if(sourceRowsRead>SHARED_ANALYTICS_FEATURE_MAX_ROWS)throw new SharedFeatureRefused('day_row_limit');
  let quotaPending=pending.quotaPending,usagePending=pending.usagePending;
  const scalarUsage=[...pending.scalarUsage],cacheItems=[...pending.cacheItems];
  let cacheEventsRead=pending.cacheEventsRead;
  if(stream==='quota') {
    const offset=quotaPending?.quotaRowsRead??0;
    quotaPending=appendEffectiveQuotaDay(quotaPending,pending.day,
      facts.map((fact,index)=>canonicalEffectiveQuotaRow(fact,offset+index+1,{nativeIdentity:true})),10_080);
    if(quotaPending===null)throw new SharedFeatureRefused('quota_day_limit');
  } else if(stream==='usage') {
    const rows=facts.map(fact=>{
      const price=fitPrices.get(fact.revision);if(!price)throw new SharedFeatureRefused('fit_price_unavailable');
      return canonicalEffectiveUsageInputs(fact,price);
    });
    usagePending=await appendEffectiveUsageDay(usagePending,pending.day,rows.map(value=>value.row),pending.ownerDigest,
      rows.map(value=>value.inputs),facts.map(fact=>fact.nativeScopes.graphSessionDigest!));
    if(usagePending===null)throw new SharedFeatureRefused('usage_day_limit');
    for(const [index,value] of rows.entries())scalarUsage.push({...await prepareV11UsageFeatureWithSession(value.row,
      async()=>facts[index]!.nativeScopes.scalarSessionDigest!,value.inputs),occurrenceId:ordinal(cacheEventsRead+index+1)});
    const order=new Map(facts.map((fact,index)=>[canonicalCacheOrderKey(fact),ordinal(cacheEventsRead+index+1)]));
    const cache=await canonicalCacheItems(facts);
    if(cache.eventsRead!==facts.length)throw new SharedFeatureRefused('cache_row_unavailable');
    for(const item of cache.items) {
      const orderKey=order.get(item.orderKey);if(!orderKey)throw new SharedFeatureRefused('cache_row_unavailable');
      cacheItems.push({...item,orderKey});
    }
    cacheEventsRead+=facts.length;
  }
  const result:SharedAnalyticsFeaturePending={...pending,daily,quotaPending,usagePending,scalarUsage,cacheItems,
    cacheEventsRead,sourceRowsRead,streamIndex:next===null?pending.streamIndex+1:pending.streamIndex,
    after:next===null?null:{occurrenceId:next,observedAtMs:facts.at(-1)!.location.observedAtMs!}};
  if(!validSharedAnalyticsFeaturePending(result))throw new SharedFeatureRefused('day_feature_limit');
  return result;
}

/** Real canonical producer used by daily, fits/model blocks and cache. Missing
 * supported work defers with durable progress; it never selects a raw producer. */
export function createCanonicalSharedFeaturePreparation(input:SharedAnalyticsFeatureInput):
  NonNullable<SharedAnalyticsFeatureInput['canonicalPreparation']> {
  return async ({pending})=>{
    if(!validSharedAnalyticsFeaturePending(pending)||pending.day!==input.day||pending.ownerDigest!==input.owner.ownerDigest)
      throw new SharedFeatureRefused('invalid_checkpoint');
    if(pending.streamIndex===STREAMS.length)return {state:'complete',value:await finishSharedAnalyticsFeatureDay(pending)};
    const allocation=Math.min(800,Math.max(0,input.budget.remainingQueries()-90));
    if(allocation<80||input.budget.now()>=input.budget.deadlineMs-1500)return {state:'deferred',reason:'query_budget'};
    const meter=createD1InvocationBudget(allocation),source=meter.wrap(input.source),target=meter.wrap(input.target);
    const scopes:CanonicalInputScope[]=STREAMS.slice(pending.streamIndex).map(stream=>({
      sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,ownerDigest:input.owner.ownerDigest,
      participantId:input.owner.participantId,day:input.day,stream,selectionMethod:'effective-union-v1'}));
    let context:Awaited<ReturnType<typeof createCanonicalInputReadContext>>=null;
    let next=pending,lastScope=scopes[0]!;
    try {
      context=await createCanonicalInputReadContext(source,target,scopes,input.budget.deadlineMs);
      if(!context) {
        if(meter.remainingQueries>=150)await advanceEffectiveDependencyCoverage(source,
          {sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,participantId:input.owner.participantId,
            maxSteps:16,maxRows:128,budget:meter});
        return {state:'deferred',reason:'canonical_input_pending'};
      }
      let reason='canonical_page_pending';
      // The checkpoint is saved once for this bounded group. Ordering and page
      // cursors remain native; durable input work may also advance independently.
      for(let pages=0;pages<4&&next.streamIndex<STREAMS.length;pages++) {
        if(meter.remainingQueries<150||input.budget.now()>=input.budget.deadlineMs-2000){reason='query_budget';break;}
        const scope=scopes.find(value=>value.stream===STREAMS[next.streamIndex])!;
        lastScope=scope;
        const pageOptions={order:'native' as const,limit:128,
          ...(next.after?{afterKey:next.after.occurrenceId}:{})};
        let page=await readCanonicalInputPreparationFactPage(source,target,scope,context,pageOptions);
        if(!page) {
          const acquired=await advanceCanonicalInputWork(source,target,{...scope,context,
            budget:{meter,maxSteps:32,now:input.budget.now,deadlineMs:input.budget.deadlineMs}});
          if(!acquired.seal||meter.remainingQueries<150){reason='canonical_input_pending';break;}
          page=await readCanonicalInputPreparationFactPage(source,target,scope,context,pageOptions);
          if(!page){reason='source_changed';break;}
        }
        const products=await materializeCanonicalFeatureRows({target,refs:page.refs,
          budget:{remainingQueries:()=>Math.min(meter.remainingQueries,Math.max(0,input.budget.remainingQueries()-90)),
            now:input.budget.now,deadlineMs:input.budget.deadlineMs},
          stillCurrent:()=>canonicalInputReadContextCurrent(source,target,scope,context!,false)});
        if(products.state!=='complete'){if(products.state==='refused')return products;reason=products.reason;break;}
        next=await appendCanonicalSharedFeaturePage(next,products,page.next);
      }
      const value=next.streamIndex===STREAMS.length?await finishSharedAnalyticsFeatureDay(next):null;
      // No prepared checkpoint or complete native value escapes a context whose
      // capabilities, source generation, clock or target authority were lost.
      if(!await canonicalInputReadContextCurrent(source,target,lastScope,context))
        return {state:'deferred',reason:'source_changed'};
      return value?{state:'complete',value}:{state:'deferred',reason,...(next!==pending?{pending:next}:{})};
    } catch(error) {
      if(error instanceof D1InvocationBudgetExceededError)return {state:'deferred',reason:'query_budget'};
      if(error instanceof SharedFeatureRefused||error instanceof CanonicalRollingRefused)return {state:'refused',reason:error.reason};
      throw error;
    } finally {if(context)closeCanonicalInputReadContext(context);}
  };
}
