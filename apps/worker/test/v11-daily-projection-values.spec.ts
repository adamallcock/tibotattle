import { describe,it,expect } from 'vitest';
import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { v11UsageRecord } from './helpers/telemetry-v11';
import { priceChunkUsageRecord } from '../src/quota-analysis-v1';
import { createV11DailyProjectionValues as initial, foldV11DailyProjectionValues as fold,
  mergeV11DailyProjectionValues as merge, finalizeV11DailyProjectionValues as final,
  validateV11DailyProjectionValues as validate, MAX_V11_DAILY_FOLD_RECORDS } from '../src/v11-daily-projection-values';
const day='2026-09-11', time=`${day}T12:00:00.000Z`;
const usage=(index:number,overrides:Parameters<typeof v11UsageRecord>[2]={})=>v11UsageRecord(day,'a',{
  eventId:`event:v2:${index.toString(16).padStart(64,'0')}`,...overrides});
const quota={schemaVersion:'quota-observation-v1.1',observationId:`quota-occurrence:v1:${'d'.repeat(64)}`,
  provider:'openai_codex',observedTime:time,planType:'pro',planVariant:'unknown',limitId:'codex',slot:'secondary',
  usedPercent:null,windowDurationMinutes:null,resetsAt:null,accountPlanAttribution:{accountBasis:'unavailable',accountTrackId:null,
  planBasis:'same_source_occurrence',planType:'pro',planEraId:null}};
const session={schemaVersion:'session-dimension-v1.1',sessionUuid:'0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b',
  firstEventTime:time,provider:'openai_codex',toolClassCounts:{shell:0,other:3}};
const zeroComponents={inputUncachedTokens:0,inputCacheReadTokens:0,inputCacheWriteTokens:0,
  outputTextTokens:0,outputReasoningTokens:0,outputCombinedTokens:null};

describe('bounded pure v11 daily projection values',()=>{
  it('folds all streams and multiple disjoint pages identically without modifying inputs',()=>{
    const records=[usage(1),quota,session,usage(2,{modelId:'gpt-5.4'})];
    const before=canonicalTelemetryV11Json(records),empty=initial(day);
    const complete=fold(empty,records),paged=fold(fold(empty,records.slice(0,2)),records.slice(2));
    expect(paged).toEqual(complete);expect(merge(fold(empty,records.slice(2)),fold(empty,records.slice(0,2)))).toEqual(complete);
    expect(complete.counts).toEqual({usage:2,quota:1,session:1});expect(complete.cells).toHaveLength(2);
    expect(canonicalTelemetryV11Json(records)).toBe(before);expect(empty).toEqual(initial(day));
    validate(JSON.parse(JSON.stringify(complete)));
  });
  it('keeps unknown components distinct from zero and never adds combined output to split output',()=>{
    const a=usage(1,{components:{...zeroComponents,inputUncachedTokens:10,inputCacheReadTokens:null,
      outputTextTokens:4,outputReasoningTokens:5,outputCombinedTokens:12}});
    const b=usage(2,{components:{...zeroComponents,outputTextTokens:3,outputReasoningTokens:null}});
    const state=fold(initial(day),[a,b]);
    expect(state.tokens.outputTextTokens).toEqual({knownSum:'7',unavailable:0});
    expect(state.tokens.outputCombinedTokens).toEqual({knownSum:'12',unavailable:1});
    expect(state.tokens.effectiveOutput).toEqual({knownSum:'15',unavailable:1});
    expect(state.tokens.nonOverlappingTotal).toEqual({knownSum:'25',unavailable:2});
    expect(state.tokens.inputCacheReadTokens).toEqual({knownSum:'0',unavailable:1});
    expect(state.tokens.inputCacheWriteTokens).toEqual({knownSum:'0',unavailable:0});
  });
  it('matches the existing event pricer for known, unknown, and separate Spark models',()=>{
    const records=[usage(1,{modelId:'gpt-5.4'}),usage(2,{modelId:'unknown-future-model'}),usage(3,{modelId:'gpt-5.3-codex-spark'})];
    const state=fold(initial(day),records);let known=0n,full=0,partial=0,unpriced=0;
    for(const record of records){const p=priceChunkUsageRecord(canonicalTelemetryV11Json(record),record.eventTime);
      if(p===null||p.pricingStatus==='unpriced')unpriced++;else{known+=BigInt(p.costNanousd);if(p.pricingStatus==='fully_priced')full++;else partial++;}}
    expect(state.pricing).toEqual({knownNanousd:known.toString(),fullyPriced:full,partiallyPriced:partial,unpriced});
    const unknown=final(fold(initial(day),[records[1]]));expect(unknown.knownCostNanousd).toBeNull();expect(unknown.coverage).toBe('unavailable');
    const spark=final(fold(initial(day),[records[2]]));expect(spark.knownCostNanousd).toBeNull();
    expect(state.cells.find(c=>c.modelId==='gpt-5.3-codex-spark')?.usageEvents).toBe(1);
  });
  it('distinguishes a known zero price from unavailable cost and preserves contract-valid token labels',()=>{
    const zero=final(fold(initial(day),[usage(1,{modelId:'gpt-5.4',components:zeroComponents})]));
    expect(zero.knownCostNanousd).toBe('0');expect(zero.coverage).toBe('complete');
    const partial=final(fold(initial(day),[usage(2,{modelId:'gpt-5.4',components:{...zeroComponents,inputUncachedTokens:10,inputCacheReadTokens:null}})]));
    expect(partial.pricing.partiallyPriced).toBe(1);expect(partial.coverage).toBe('partial');expect(partial.knownCostNanousd).not.toBeNull();
    const labels=fold(initial(day),[usage(3,{provider:'_future',modelId:'.future'})]);
    expect(labels.cells[0]).toMatchObject({provider:'_future',modelId:'.future'});
  });
  it('quota/session-only and empty days have no fabricated usage or model cells',()=>{
    for(const records of [[],[quota],[session],[quota,session]]){
      const state=final(fold(initial(day),records));expect(state.counts.usage).toBe(0);expect(state.cells).toEqual([]);
      expect(state.knownCostNanousd).toBe('0');expect(state.coverage).toBe('complete');
      expect(state.tokens.nonOverlappingTotal).toEqual({knownSum:'0',unavailable:0});
    }
  });
  it('retains integer totals beyond Number safe range without rounding and refuses count overflow',()=>{
    let state=fold(initial(day),[usage(1,{modelId:'unknown-future-model',components:{...zeroComponents,inputUncachedTokens:1_000_000_000_000}})]);
    for(let i=0;i<14;i++)state=merge(state,state); // arithmetic merge assumes separately proven disjoint sources
    expect(state.tokens.inputUncachedTokens.knownSum).toBe('16384000000000000');
    expect(state.counts.usage).toBe(16384);
    expect(()=>fold(initial(day),[usage(2,{components:{...zeroComponents,inputUncachedTokens:Number.MAX_SAFE_INTEGER+1}})])).toThrow();
    while(state.counts.usage<3_000_000)state=merge(state,state);
    expect(()=>merge(state,state)).toThrow('V11_DAILY_PROJECTION_VALUES_INVALID');
  });
  it('keeps a bounded associative summary and exact omitted unknown/price subtotals across model pages',()=>{
    const pages=Array.from({length:4},(_,p)=>fold(initial(day),Array.from({length:200},(_,i)=>usage(p*200+i,
      {modelId:`model-${String((799-(p*200+i))%401).padStart(4,'0')}`,
        components:{...zeroComponents,inputUncachedTokens:p*200+i,inputCacheReadTokens:i%2?null:0}}))));
    const forward=pages.reduce(merge,initial(day)),backward=[...pages].reverse().reduce(merge,initial(day));
    expect(forward).toEqual(backward);expect(merge(merge(pages[0]!,pages[1]!),merge(pages[2]!,pages[3]!))).toEqual(forward);
    expect(forward.cells).toHaveLength(200);expect(forward.cells[0]!.modelId).toBe('model-0000');
    expect(forward.cells.at(-1)!.modelId).toBe('model-0199');expect(forward.counts.usage).toBe(800);
    expect(forward.tokens.inputUncachedTokens.knownSum).toBe('319600');
    expect(forward.tokens.inputCacheReadTokens.unavailable).toBe(400);
    expect(forward.pricing.unpriced).toBe(799);expect(forward.pricing.fullyPriced).toBe(1);expect(forward.omitted.usageEvents).toBeGreaterThan(0);
    validate(JSON.parse(JSON.stringify(forward)));
    const corrupt=structuredClone(forward);corrupt.omitted.tokens.inputCacheReadTokens.unavailable++;
    expect(()=>validate(corrupt)).toThrow();
  });
  it('keeps priced, partially priced and unavailable portions exact even when their model is outside the display prefix',()=>{
    const prefix=fold(initial(day),Array.from({length:200},(_,i)=>usage(i,{modelId:`.model-${String(i).padStart(3,'0')}`})));
    const extra=[usage(200,{modelId:'gpt-5.4'}),usage(201,{modelId:'gpt-5.4',
      components:{...zeroComponents,inputUncachedTokens:10,inputCacheReadTokens:null}}),usage(202,{modelId:'unknown'})];
    const page=fold(initial(day),extra),state=merge(prefix,page);
    expect(state.cells.map(c=>c.modelId)).toEqual(prefix.cells.map(c=>c.modelId));
    expect(state.omitted).toEqual({usageEvents:3,tokens:page.tokens,pricing:page.pricing});
    expect(state.omitted.pricing).toMatchObject({fullyPriced:1,partiallyPriced:1,unpriced:1});
    expect(state.omitted.tokens.inputCacheReadTokens.unavailable).toBe(1);
  });
  it('normalizes only the exact complete legacy schema and refuses legacy-shaped omitted evidence',()=>{
    const state=fold(initial(day),[usage(1)]);
    const {omitted,...rest}=state;
    const legacy={...rest,schemaVersion:'v11-daily-projection-values-v1'};
    expect(fold(legacy as typeof state,[])).toEqual(state);
    expect(()=>fold({...legacy,omitted} as typeof state,[])).toThrow();
  });
  it('rejects wrong days, duplicate page identities, malformed state and mismatched pricing pins',()=>{
    expect(()=>initial('2026-02-31')).toThrow();expect(()=>fold(initial(day),[usage(1,{eventTime:'2026-09-10T00:00:00.000Z'})])).toThrow();
    expect(()=>fold(initial(day),[usage(1),usage(1)])).toThrow();
    expect(()=>merge(initial(day),initial('2026-09-10'))).toThrow();
    const state=fold(initial(day),[usage(1)]);
    for(const corrupt of [{...state,extra:true},{...state,registrySha256:'0'.repeat(64)},
      {...state,counts:{...state.counts,usage:2}},{...state,cells:[...state.cells,...state.cells]},
      {...state,pricing:{...state.pricing,knownNanousd:'01'}}])expect(()=>validate(corrupt)).toThrow();
    expect(()=>fold(initial(day),Array.from({length:MAX_V11_DAILY_FOLD_RECORDS+1},(_,i)=>usage(i)))).toThrow();
    const full=fold(initial(day),Array.from({length:200},(_,i)=>usage(i,{modelId:`unknown-${i}`})));
    expect(full.cells).toHaveLength(200);
    const over=fold(full,[usage(201,{modelId:'unknown-extra'})]);
    expect(over.cells).toHaveLength(200);expect(over.omitted.usageEvents).toBe(1);expect(over.counts.usage).toBe(201);
  });
});
