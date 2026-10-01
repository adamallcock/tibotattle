import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { validCacheRetentionToken, type CacheRetentionItem } from './cache-retention-values';
import { parseStoredRecordJson } from './stored-record';

const HASH = /^[a-f0-9]{64}$/u;
const fail = (): Error => new Error('CACHE_RETENTION_UNAVAILABLE');

/** Owner-scoped digest; a raw session UUID never enters derived output. */
export const CACHE_RETENTION_SESSION_DIGEST_METHOD = 'cache-retention-session-v1';
export async function cacheRetentionSessionDigest(input:{ownerDigest:string;provider:string;
  sessionUuid:string}):Promise<string> {
  if(!HASH.test(input.ownerDigest)||typeof input.provider!=='string'
    ||typeof input.sessionUuid!=='string'||input.sessionUuid.length===0)throw fail();
  return sha256Hex(canonicalJson({method:CACHE_RETENTION_SESSION_DIGEST_METHOD,kind:'session',
    ownerDigest:input.ownerDigest,value:[input.provider,input.sessionUuid]}));
}

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
  const record=parseStoredRecordJson(input.recordJson) as Record<string,unknown>|null;
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
