import { captureStorageGraphScope, computeStorageGraphResult, STORAGE_GRAPH_METHOD } from './storage-community-graph';
import { readStorageCommunityOwnerPage, captureStorageCommunityAuthority,
 type StorageCommunityOwner } from './storage-community-authority';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';
import { COMMUNITY_MODEL_CACHE_MAX_BYTES, COMMUNITY_MODEL_CACHE_MAX_PAGES } from './community-allowance';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { validStorageModelPublication, type StorageModelPublicationValue } from './storage-community-publication-value';

const fail=()=>new Error('STORAGE_GRAPH_WORK_UNAVAILABLE');
export interface StorageGraphWorkProgress {
 state:'complete'|'reused'|'deferred'|'idle';metric?:'fits'|'model';day?:string;reason?:string;
}

/** Fair selection is durable BEFORE an expensive query. One problematic source
 * cannot prevent every other source from advancing. One third of the service
 * goes to current fits/models, two thirds to the newest unfinished historical
 * day. Finish that cohort before opening another day's checkpoints. */
export async function advanceStorageCommunityGraphWork(options:StorageAnalyticsBindings & {
 nowMs?:number;remainingQueries?:number;deadlineMs?:number;
}):Promise<StorageGraphWorkProgress> {
 const nowMs=options.nowMs??Date.now();
 if(!Number.isFinite(nowMs))throw fail();
 if((options.remainingQueries??900)<550 || Date.now()>=(options.deadlineMs??Date.now()+20_000)) {
  return {state:'deferred',reason:'budget'};
 }
 const owners:StorageCommunityOwner[]=[];let after='',bytes=0;
 for(let page=0;;page++) {
  if(page>=COMMUNITY_MODEL_CACHE_MAX_PAGES)return {state:'deferred',reason:'cohort_capacity'};
  const rows=await readStorageCommunityOwnerPage(options.source,{afterParticipantId:after});
  for(const owner of rows) {
   if(!owner.hasV1&&!owner.hasV11&&!owner.hasLegacy)continue;
   bytes+=new TextEncoder().encode(JSON.stringify(owner)).byteLength;
   if(bytes>COMMUNITY_MODEL_CACHE_MAX_BYTES)return {state:'deferred',reason:'cohort_capacity'};
   owners.push(owner);
  }
  if(rows.length<64)break;
  after=rows.at(-1)!.participantId;
 }
 if(!owners.length)return {state:'idle'};
 await options.target.prepare(`INSERT INTO analytics_community_graph_scan(source_id,revision,tick,current_position,history_position) VALUES(?,1,0,0,0)
  ON CONFLICT(source_id) DO NOTHING`).bind(options.sourceId).run();
 const scan=await options.target.prepare(`SELECT revision,tick,current_position,history_position
  FROM analytics_community_graph_scan WHERE source_id=?`).bind(options.sourceId)
  .first<{revision:number;tick:number;current_position:number;history_position:number}>();
 if(!scan||![scan.revision,scan.tick,scan.current_position,scan.history_position].every(Number.isSafeInteger)
  ||scan.revision<1||scan.tick<0||scan.tick>2||scan.current_position<0||scan.history_position<0)throw fail();
 const current=scan.tick===0;
 const position=current?scan.current_position%(owners.length*2)
  :scan.history_position%owners.length;
 const owner=owners[current?Math.floor(position/2):position%owners.length]!;
 const metric=current&&position%2===0?'fits':'model';
 const today=new Date(nowMs).toISOString().slice(0,10);
 let day:string|null=today;
 if(!current) {
  const authority=await captureStorageCommunityAuthority(options.source,options);
  const from=new Date(Date.parse(today)-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);
  const published=(await options.target.prepare(`SELECT day,authority_json,payload_json,payload_sha256 FROM analytics_community_model_publications
   WHERE source_id=? AND day>=? AND day<? AND method=? ORDER BY day LIMIT ?`)
   .bind(options.sourceId,from,today,STORAGE_GRAPH_METHOD,ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS).all<StorageModelPublicationValue>()).results;
  const completed=new Set<string>();
  for(const row of published)if(await validStorageModelPublication(row,authority))completed.add(row.day);
  day=null;
  for(let offset=1;offset<ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS;offset++) {
   const candidate=new Date(Date.parse(today)-offset*86400000).toISOString().slice(0,10);
   if(!completed.has(candidate)){day=candidate;break;}
  }
 }
 const claimed=await options.target.prepare(`UPDATE analytics_community_graph_scan SET revision=revision+1,
  tick=(tick+1)%3,current_position=?,history_position=?,updated_ms=? WHERE source_id=? AND revision=?`)
  .bind(current?position+1:scan.current_position,current?scan.history_position:position+1,nowMs,options.sourceId,scan.revision).run();
 if(claimed.meta.changes!==1)return {state:'deferred',reason:'claim_changed'};
 if(day===null)return {state:'idle'};
 if(!owner.ownerDigest)return {state:'deferred',metric,day,reason:'source_bootstrap_pending'};
 const scope=await captureStorageGraphScope(options.source,{owner,day,metric,
  sourceId:options.sourceId,sourceNamespace:options.sourceNamespace});
 const result=await computeStorageGraphResult(options,scope,{maxQueries:Math.max(1,(options.remainingQueries??900)-40),deadlineMs:options.deadlineMs});
 return result.state==='complete'?{state:result.reused?'reused':'complete',metric,day}
  :{state:'deferred',metric,day,reason:result.reason};
}
