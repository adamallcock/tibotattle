import { captureStorageCommunityAuthority, sameStorageCommunityAuthority, storageCommunityAuthorityIsCurrent,
 type StorageCommunityAuthority } from './storage-community-authority';
import { STORAGE_GRAPH_METHOD } from './storage-community-graph';
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from './admin-community-allowance';
import type { StorageAnalyticsBindings } from './analytics-delivery';
import { ApiError } from './errors';
import { validStorageModelPublication, type StorageModelPublicationValue } from './storage-community-publication-value';

/** Owner-only progress reads bounded analytical metadata. A cached point is
 * counted only under the current hard authority; pending owners are not inferred
 * from row totals, nor are source records read to manufacture a progress estimate. */
export async function readStorageCommunityProgress(bindings:StorageAnalyticsBindings,nowMs:number,
 options:{includePreparation?:boolean}={}) {
 try {
  const authority=await captureStorageCommunityAuthority(bindings.source,bindings);
  const generatedAt=new Date(nowMs).toISOString(),today=generatedAt.slice(0,10);
  const requiredDays=ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1;
  const from=new Date(Date.parse(today)-requiredDays*86400000).toISOString().slice(0,10);
  const metadata=await bindings.target.batch([
   bindings.target.prepare(`SELECT day,authority_json,payload_json,payload_sha256 FROM analytics_community_model_publications
    WHERE source_id=? AND day>=? AND day<? AND method=? ORDER BY day LIMIT ?`)
    .bind(bindings.sourceId,from,today,STORAGE_GRAPH_METHOD,requiredDays+1),
   bindings.target.prepare(`SELECT authority_json,generated_at,inputs_current FROM analytics_community_graph_previews
    WHERE source_id=? AND method=?`).bind(bindings.sourceId,STORAGE_GRAPH_METHOD),
   bindings.target.prepare('SELECT updated_ms FROM analytics_community_graph_scan WHERE source_id=?').bind(bindings.sourceId),
   bindings.target.prepare('SELECT day FROM analytics_community_daily_queue WHERE source_id=? ORDER BY day LIMIT 1').bind(bindings.sourceId),
  ]);
  const days=new Set<string>();
  for(const raw of metadata[0]!.results){
   const row=raw as StorageModelPublicationValue;
   if(await validStorageModelPublication(row,authority))days.add(row.day);
  }
  if(days.size>requiredDays)throw new Error('history count unavailable');
  let activeDay:string|null=null;
  for(let offset=1;offset<=requiredDays;offset++){
   const day=new Date(Date.parse(today)-offset*86400000).toISOString().slice(0,10);
   if(!days.has(day)){activeDay=day;break;}
  }
  const preview=metadata[1]!.results[0] as {authority_json:string;generated_at:string;inputs_current:number}|undefined;
  const published=preview?JSON.parse(preview.authority_json) as StorageCommunityAuthority:null;
  const ready=published!==null&&sameStorageCommunityAuthority(published,authority);
  const current=ready&&preview!.inputs_current===1&&published!.sourceEpoch===authority.sourceEpoch&&preview!.generated_at.slice(0,10)===today;
  const phase=!current?'current' as const:activeDay!==null?'history' as const
   :metadata[3]!.results.length?'daily' as const:null;
  const updatedMs=Number((metadata[2]!.results[0] as {updated_ms:number}|undefined)?.updated_ms??0);
  if(!Number.isSafeInteger(updatedMs)||updatedMs<0)throw new Error('work time unavailable');
  if(!await storageCommunityAuthorityIsCurrent(bindings.source,authority,true))throw new Error('source changed');
  return {...(options.includePreparation?{schemaVersion:2 as const,preparation:null}:{schemaVersion:1 as const}),generatedAt,
   publication:{state:ready?'ready' as const:preview?'invalidated' as const:'empty' as const,
    requestedGeneration:authority.sourceEpoch,preparedGeneration:phase===null?authority.sourceEpoch:null,
    publishedGeneration:ready?published!.sourceEpoch:null,publishedAt:ready?preview!.generated_at:null},
   work:{state:phase===null?'idle' as const:'queued' as const,phase,
    updatedAt:updatedMs?new Date(updatedMs).toISOString():null,trigger:null,restartReason:null},
   history:{resolvedDays:days.size,requiredDays,activeDay,completeAccounts:null,requiredAccounts:null}};
 }catch{throw new ApiError(503,'ADMIN_RECONSTRUCTION_PROGRESS_UNAVAILABLE');}
}
