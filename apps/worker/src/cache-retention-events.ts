import {cacheRetentionSessionDigest} from './cache-retention-session';
export {cacheRetentionSessionDigest,CACHE_RETENTION_SESSION_DIGEST_METHOD} from './cache-retention-session';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { validCacheRetentionToken, type CacheRetentionItem } from './cache-retention-values';
import type { CanonicalFact } from './canonical-analytics-facts';
import { parseStoredRecordJson } from './stored-record';

const HASH = /^[a-f0-9]{64}$/u;
const fail = (): Error => new Error('CACHE_RETENTION_UNAVAILABLE');


const TOKENS=(value:unknown):number|null=>{
  if(value===null||value===undefined)return null;
  return Number.isSafeInteger(value)&&(value as number)>=0&&(value as number)<=1e12
    ?value as number:null;
};

/** Both admitted schemas use the same closed fields for this measurement. */
export const CACHE_RETENTION_RECORD_SCHEMAS:ReadonlySet<string>=
  new Set(['usage-event-v1.1','usage-event-v1.0']);

/** Map only allowlisted event fields; malformed evidence remains unreadable. */
export function cacheRetentionEventFromRecord(input:{sessionDigest:string;observedAtMs:number;
  orderKey:string;recordJson:string}):CacheRetentionItem|null {
  return cacheRetentionEventFromRecordValue(input, parseStoredRecordJson(input.recordJson));
}

/** Allowlisted cache mapping over the same transient decoded source record. */
export function cacheRetentionEventFromRecordValue(input:{sessionDigest:string;observedAtMs:number;
  orderKey:string}, record:Record<string,unknown>|null):CacheRetentionItem|null {
  const unreadable:CacheRetentionItem={sessionDigest:input.sessionDigest,
    observedAtMs:input.observedAtMs,orderKey:input.orderKey,unreadable:true};
  if(!record||typeof record.schemaVersion!=='string'
    ||!CACHE_RETENTION_RECORD_SCHEMAS.has(record.schemaVersion))return unreadable;
  const components=record.components;
  if(!components||typeof components!=='object'||Array.isArray(components))return unreadable;
  const {modelId,reasoningEffort,speedMode,surface}=record;
  if(!validCacheRetentionToken(modelId)||!validCacheRetentionToken(reasoningEffort)
    ||!validCacheRetentionToken(speedMode)||!validCacheRetentionToken(surface))return unreadable;
  const parts=components as Record<string,unknown>;
  const cacheReadTokens=TOKENS(parts.inputCacheReadTokens);
  const uncachedTokens=TOKENS(parts.inputUncachedTokens);
  const cacheWriteTokens=TOKENS(parts.inputCacheWriteTokens);
  if((cacheReadTokens??0)+(uncachedTokens??0)+(cacheWriteTokens??0)<=0)return null;
  return {sessionDigest:input.sessionDigest,observedAtMs:input.observedAtMs,
    orderKey:input.orderKey,model:modelId,effort:reasoningEffort,speedMode,surface,
    cacheReadTokens,uncachedTokens,cacheWriteTokens};
}

/** Native cache preparation over closed canonical facts. Legacy readers count
 * every selected physical row, then keep the first occurrence in native reader
 * order per UTC day. Cache ordering itself remains lexical within time ties. */
export async function canonicalCacheItems(facts:readonly CanonicalFact[]):Promise<{
  items:readonly CacheRetentionItem[];eventsRead:number;
}> {
  const usage=facts.filter(fact=>fact.stream==='usage');
  if(usage.length>128_000)throw fail();
  const seen=new Set<string>(),modes=new Set<string>(),items:CacheRetentionItem[]=[];
  for(const fact of [...usage].sort((a,b)=>a.location.observedAtMs!-b.location.observedAtMs!
    ||a.location.nativeOrder-b.location.nativeOrder||a.occurrenceKey.localeCompare(b.occurrenceKey))) {
    if(fact.schema!=='canonical-analytics-v1'||!HASH.test(fact.revision)||!HASH.test(fact.provenance.erasureKey)
      ||!HASH.test(fact.nativeScopes.logicalOccurrenceKey)||!Number.isSafeInteger(fact.nativeScopes.occurrenceTieOrder)
      ||fact.nativeScopes.occurrenceTieOrder<0)throw fail();
    if(fact.status!=='compatible'||fact.provenance.coverage!=='complete'||fact.location.day===null
      ||fact.location.observedAtMs===null||fact.nativeScopes.cacheSessionDigest===null)throw fail();
    modes.add(fact.provenance.selectionMethod);if(modes.size>1)throw fail();
    const logical=JSON.stringify([fact.provenance.erasureKey,fact.location.day,fact.nativeScopes.logicalOccurrenceKey]);
    if(seen.has(logical))continue;seen.add(logical);
    const value=fact.values;
    const item=cacheRetentionEventFromRecordValue({sessionDigest:fact.nativeScopes.cacheSessionDigest,
      observedAtMs:fact.location.observedAtMs,orderKey:canonicalCacheOrderKey(fact)},
      {schemaVersion:'usage-event-v1.1',modelId:value.modelId,reasoningEffort:value.reasoningEffort,
        speedMode:value.speedMode,surface:value.surface,components:{inputCacheReadTokens:value.inputCacheReadTokens,
          inputUncachedTokens:value.inputUncachedTokens,inputCacheWriteTokens:value.inputCacheWriteTokens}});
    if(item!==null)items.push(item);
  }
  items.sort((a,b)=>a.observedAtMs-b.observedAtMs||a.orderKey.localeCompare(b.orderKey));
  return {items,eventsRead:usage.length};
}
export function canonicalCacheOrderKey(fact:CanonicalFact):string {
  return `canonical:${String(fact.nativeScopes.occurrenceTieOrder).padStart(16,'0')}:${fact.nativeScopes.logicalOccurrenceKey}`;
}
