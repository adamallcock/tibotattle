import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {COMPOSITION_CACHE_KEY_SUFFIX} from './community-allowance';
import {validEffectiveUsageDay,effectiveUsageWindowRepresentable,type EffectiveUsageDay,
  type StorageEffectiveUsagePreparation} from './effective-usage-day';
import {GRAPH_DAY_EFFECTIVE_DEVICE_ID,GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX,
  graphDayEffectiveUsageSupported,readGraphDayEffectiveUsageHeads,readGraphDayProjection,writeGraphDayProjection,
  type GraphDayProjectionKey,type GraphDayProjectionLoadCursor,type GraphDayProjectionWriteCursor} from './graph-day-projection';
import {assertEffectiveHistoryOwner,effectiveHistoryDependency,createEffectiveHistoryDayDependencyReader} from './storage-effective-history';
import type {StorageCommunityOwner} from './storage-community-authority';

export const STORAGE_EFFECTIVE_USAGE_WINDOW_BYTES=8*1024*1024;
export type {StorageEffectiveUsagePreparation} from './effective-usage-day';
const fail=()=>new Error('STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE');

/** A source-fenced, pricing-versioned model input cache. A miss never licenses
 * a partial fold; cold models prepare one complete missing day at a time under
 * their existing graph claim and retain their analytical checkpoint fallback. */
export async function createStorageEffectiveUsagePreparation(input:{
  source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;
  owner:StorageCommunityOwner&{ownerDigest:string};remainingQueries:()=>number;
  deadlineMs:number;now:()=>number;
}):Promise<StorageEffectiveUsagePreparation|undefined> {
  if(!await graphDayEffectiveUsageSupported(input.target))return undefined;
  const manifestId=GRAPH_DAY_EFFECTIVE_USAGE_MANIFEST_PREFIX+await sha256Hex(COMPOSITION_CACHE_KEY_SUFFIX);
  const available=(reserve:number)=>input.remainingQueries()>=reserve&&input.now()<input.deadlineMs;
  const digests=new Map<string,string>(),validDays=new Set<string>(),missingDays=new Set<string>();
  let attempted=false,coverageKnown=false,refusal=false;
  const keyFor=async(day:string):Promise<GraphDayProjectionKey>=>{
    let digest=digests.get(day);
    if(digest===undefined){digest=await sha256Hex(canonicalJson(await effectiveHistoryDependency(input.source,
      input.owner,input.sourceNamespace,day,day,{includeSessions:true})));digests.set(day,digest);}
    return {sourceId:input.sourceId,sourceLayout:'effective-usage',sourceNamespace:input.sourceNamespace,
      ownerDigest:input.owner.ownerDigest,deviceId:GRAPH_DAY_EFFECTIVE_DEVICE_ID,manifestId,manifestDigest:digest,day};
  };
  return {
    refused:()=>refusal,
    async nextMissingDay(days){
      return coverageKnown&&!refusal&&available(200)?days.find(day=>missingDays.has(day)&&!validDays.has(day)):undefined;
    },
    async load(days){
      if(attempted||refusal)return undefined;
      attempted=true;coverageKnown=false;missingDays.clear();
      if(days.length===0)return [];
      if(!available(260))return undefined;
      const heads=await readGraphDayEffectiveUsageHeads({target:input.target,sourceId:input.sourceId,
        sourceNamespace:input.sourceNamespace,ownerDigest:input.owner.ownerDigest,manifestId,
        fromDay:days[0]!,throughDay:days.at(-1)!});
      // The store returns undefined only for its bounded retained-head count.
      // Persist this deterministic refusal instead of retrying optional work
      // on every invocation of a window that the cache cannot represent.
      if(!heads){refusal=true;return undefined;}
      const candidates=days.map(day=>heads.filter(head=>head.key.day===day));
      const payloadBytes=candidates.reduce((sum,values)=>sum+Math.max(0,...values.map(head=>head.payloadBytes)),0);
      const payloadReads=candidates.reduce((sum,values)=>sum+Math.max(0,...values.map(head=>Math.ceil(head.cursor.partCount/32))),0);
      if(payloadBytes>STORAGE_EFFECTIVE_USAGE_WINDOW_BYTES){refusal=true;return undefined;}
      for(const [index,values]of candidates.entries())if(values.length===0)missingDays.add(days[index]!);
      if(missingDays.size){coverageKnown=true;return undefined;}
      const dependencyDays=days.filter(day=>!digests.has(day));
      if(!available((dependencyDays.length?5+dependencyDays.length:0)+Math.max(200,payloadReads+120)+2))return undefined;
      await assertEffectiveHistoryOwner(input.source,input.owner);
      const dependencies=await createEffectiveHistoryDayDependencyReader(input.source,input.owner,input.sourceNamespace,
        dependencyDays,{includeSessions:true,canContinue:()=>input.now()<input.deadlineMs});
      if(!dependencies)return undefined;
      const selected:typeof heads[number][]=[];
      for(const [index,day]of days.entries()){
        if(input.now()>=input.deadlineMs)return undefined;
        const digest=digests.get(day)??await dependencies.readDigest(day);
        if(digest===undefined)return undefined;
        digests.set(day,digest);
        const head=candidates[index]!.find(candidate=>candidate.key.manifestDigest===digest);
        if(!head){missingDays.add(day);coverageKnown=true;return undefined;}
        validDays.add(day);selected.push(head);
      }
      const values:EffectiveUsageDay[]=[];
      for(const head of selected){
        let cursor:GraphDayProjectionLoadCursor=head.cursor;
        for(;;){
          if(!available(121))return undefined;
          const loaded=await readGraphDayProjection({target:input.target,key:head.key,maxParts:32,cursor});
          if(loaded.status==='absent')return undefined;
          if(loaded.status==='deferred'){cursor=loaded.cursor;continue;}
          if(!loaded.effectiveUsage||loaded.effectiveUsage.ownerRevision>input.owner.ownerRevision)throw fail();
          const day={projection:loaded.projection};if(!validEffectiveUsageDay(day))throw fail();
          values.push(day);break;
        }
      }
      await assertEffectiveHistoryOwner(input.source,input.owner);
      if(!effectiveUsageWindowRepresentable(values)){refusal=true;return undefined;}
      return values;
    },
    async store(day){
      if(!available(160))return 'deferred';
      if(!validEffectiveUsageDay(day))throw fail();
      await assertEffectiveHistoryOwner(input.source,input.owner);
      const key=await keyFor(day.projection.day);
      await assertEffectiveHistoryOwner(input.source,input.owner);
      const ready=await input.target.prepare(`SELECT 1 AS ready FROM analytics_owner_state
        WHERE source_id=? AND owner_digest=? AND state='active' AND authority_epoch=?`)
        .bind(input.sourceId,input.owner.ownerDigest,input.owner.authorityEpoch).first<number>('ready');
      if(ready!==1)throw fail();
      let cursor:GraphDayProjectionWriteCursor|undefined;
      while(available(130)){
        const saved=await writeGraphDayProjection({target:input.target,key,projection:day.projection,
          effectiveUsage:{ownerRevision:input.owner.ownerRevision},...(cursor?{cursor}:{})});
        if(saved.status==='stored'){
          validDays.add(day.projection.day);missingDays.delete(day.projection.day);
          // Only a completed, durable day rearms validation. No page-by-page
          // probes and no loop that re-scans an adopted partial prefix.
          if(coverageKnown&&missingDays.size===0)attempted=false;
          return 'stored';
        }
        cursor=saved.cursor;
      }
      return 'deferred';
    },
  };
}
