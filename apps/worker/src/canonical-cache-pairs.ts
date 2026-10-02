import { CACHE_RETENTION_METHOD,reduceCacheRetentionDay,validCacheRetentionEvent,
  type CacheRetentionBandCounters,type CacheRetentionItem } from './cache-retention-values';

export const CANONICAL_CACHE_PAIR_METHOD='canonical-cache-neighbors-v1' as const;
export interface CanonicalCachePairValue {
 readonly model:string;readonly effort:string;readonly sessionDigest:string;readonly counters:CacheRetentionBandCounters;
}
/** Two adjacent readable nodes are evaluated by the native whole-day kernel.
 * Breaks, configuration changes and gaps retain their native no-pair meaning. */
export function canonicalCachePair(prior:CacheRetentionItem|null,later:CacheRetentionItem|null):CanonicalCachePairValue|null {
 if(!validCacheRetentionEvent(prior)||!validCacheRetentionEvent(later))return null;
 if(prior.sessionDigest!==later.sessionDigest)throw new TypeError('CANONICAL_CACHE_SESSION_INVALID');
 const gap=later.observedAtMs-prior.observedAtMs;
 if(gap<0||gap===0&&prior.orderKey>=later.orderKey)throw new TypeError('CANONICAL_CACHE_ORDER_INVALID');
 if(gap>CACHE_RETENTION_METHOD.maximumGapMs)return null;
 const day=new Date(later.observedAtMs).toISOString().slice(0,10),start=Date.parse(day+'T00:00:00.000Z');
 const result=reduceCacheRetentionDay({day,events:prior.observedAtMs>=start?[prior,later]:[later],
  carry:prior.observedAtMs<start?[prior]:[],eventsRead:1});
 const group=result.groups[0];if(!group)return null;
 const counters=group.bands.find(band=>band.adjacencies+band.excludedInsufficientEvidence+band.excludedContextContracted>0);
 if(!counters)throw new TypeError('CANONICAL_CACHE_PAIR_INVALID');
 return {model:group.model,effort:group.effort,sessionDigest:later.sessionDigest,counters};
}
