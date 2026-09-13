import { initializeStorageAnalyticsRuntime, runStorageAnalyticsPass,
  type StorageAnalyticsPass } from './storage-analytics-runtime';
import type { StorageAnalyticsBindings } from './analytics-delivery';

export interface StorageAnalyticsSource extends StorageAnalyticsBindings {
  /** Stable operator name for the derived target. It is never source provenance. */
  targetId: string;
}

export interface MultiSourceAnalyticsResult {
  sourceId: string;
  targetId: string;
  state: StorageAnalyticsPass['state']|'unavailable';
  pass?: StorageAnalyticsPass;
}

const identifier=/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const invalid=()=>new Error('STORAGE_ANALYTICS_CONFIGURATION_INVALID');

function validate(sources:readonly StorageAnalyticsSource[]):void {
  if(!Array.isArray(sources)||sources.length<1||sources.length>4)throw invalid();
  const sourceIds=new Set<string>(),targetIds=new Set<string>();
  for(const source of sources){
    if(!identifier.test(source.sourceId)||!identifier.test(source.targetId)
      ||sourceIds.has(source.sourceId)||targetIds.has(source.targetId)
      ||source.source===source.target)throw invalid();
    sourceIds.add(source.sourceId);targetIds.add(source.targetId);
  }
}

/**
 * Runs finite, independent source jobs. A failed source is reported with a
 * content-free state and does not prevent another source from advancing. The
 * per-source query cap also bounds the aggregate invocation to four finite
 * jobs; no cross-D1 transaction or shared acknowledgement is claimed.
 */
export async function runMultiSourceAnalyticsPass(options:{
  sources:readonly StorageAnalyticsSource[];
  ledger?:D1Database;
  maxStepsPerSource?:number;
  maxQueriesPerSource?:number;
  deadlineMs?:number;
  signal?:AbortSignal;
  publishCommunity?:boolean;
}):Promise<MultiSourceAnalyticsResult[]> {
  validate(options.sources);
  const maxQueries=options.maxQueriesPerSource??200;
  if(!Number.isSafeInteger(maxQueries)||maxQueries<100||maxQueries>900)throw invalid();
  // Runtime/source contract initialization performs a small fixed set of D1
  // reads/writes outside the pass meter. Refuse a configuration whose declared
  // maximum could exceed one Worker invocation before issuing any query.
  const initializationQueries=8;
  if(options.sources.length*(maxQueries+initializationQueries)>900)throw invalid();
  const results=new Array<MultiSourceAnalyticsResult>(options.sources.length);
  const run=async(source:StorageAnalyticsSource,index:number)=>{
    options.signal?.throwIfAborted();
    if(options.deadlineMs!==undefined&&Date.now()>=options.deadlineMs){
      results[index]={sourceId:source.sourceId,targetId:source.targetId,state:'unavailable'};return;
    }
    try{
      await initializeStorageAnalyticsRuntime(source);
      const pass=await runStorageAnalyticsPass({...source,ledger:options.ledger,
        erasureTargetId:options.ledger?source.targetId:undefined,
        maxSteps:options.maxStepsPerSource??2,maxQueries,deadlineMs:options.deadlineMs,
        signal:options.signal,publishCommunity:options.publishCommunity??true});
      results[index]={sourceId:source.sourceId,targetId:source.targetId,state:pass.state,pass};
    }catch(error){
      if(options.signal?.aborted)throw error;
      results[index]={sourceId:source.sourceId,targetId:source.targetId,state:'unavailable'};
    }
  };
  // At most two source/target pairs are active at once (four D1 bindings).
  // A source failure cannot short-circuit its peer or later pool members.
  for(let offset=0;offset<options.sources.length;offset+=2){
    await Promise.all(options.sources.slice(offset,offset+2).map((source,index)=>run(source,offset+index)));
  }
  return results;
}
