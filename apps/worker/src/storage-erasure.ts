import {ApiError} from './errors';
import {canonicalJson} from './canonical-json';
import {participantDeletionDigest} from './participant-deletion-digest';
import {parseTelemetryStorageMode} from './telemetry-storage-mode';
import {readIngestionChanges,type StorageChange} from './analytics-delivery';
import {lookupV11StorageSource} from './v11-storage-journal';
import {prepareV1ProjectionOwnerFence,retireV1DailyProjectionPage} from './v1-daily-projection';
import {retireV11DailyProjectionPage} from './v11-daily-projection';
import {retireStorageGraphPage} from './storage-graph-retirement';
import {retireStorageCommunityDailyPage} from './storage-community-daily';
import {retireStorageCommunityGraphPublications} from './storage-community-graph-publication';
import type {StorageAnalyticsBindings} from './analytics-delivery';
export type StorageErasureBindings=StorageAnalyticsBindings&{ledger:D1Database};
interface Job {participant_digest:string;source_id:string;owner_digest:string;source_namespace:string;
 state:'pending'|'complete';terminal_json:string|null;}
const unavailable=()=>new ApiError(503,'BACKEND_STORAGE_UNAVAILABLE');
/** Deployment selection remains explicit. A missing analytics binding must never
 * turn a typed erasure into a successful source-only operation. */
export async function storageErasureBindings(env:Env):Promise<StorageErasureBindings|null>{
 const mode=parseTelemetryStorageMode(env);if(mode.kind==='json')return null;
 const target:unknown=Reflect.get(env,'ANALYTICS_DB');
 if(!target||typeof target!=='object'||typeof Reflect.get(target,'prepare')!=='function'
  ||typeof Reflect.get(target,'batch')!=='function')throw unavailable();
 const sourceId=await env.USAGE_MONITOR_DB.prepare('SELECT source_id FROM storage_source_state WHERE singleton=1').first<string>('source_id');
 if(!sourceId)throw unavailable();
 return {source:env.USAGE_MONITOR_DB,target:target as D1Database,ledger:env.DELETION_LEDGER,sourceId,sourceNamespace:mode.sourceNamespace};
}
async function scope(b:StorageErasureBindings):Promise<void>{
 const row=await b.source.prepare(`SELECT s.source_id,a.source_namespace AS v1,b.source_namespace AS v11
 FROM storage_source_state s JOIN typed_v1_admission_state a ON a.id=1 AND a.runtime_contract_version=1
 JOIN typed_v11_admission_state b ON b.id=1 AND b.runtime_contract_version=1 WHERE s.singleton=1`).first<{source_id:string;v1:string;v11:string}>();
 if(!row||row.source_id!==b.sourceId||row.v1!==b.sourceNamespace||row.v11!==b.sourceNamespace||b.source===b.target)throw unavailable();
}
/** Called after the independent tombstone is durable but BEFORE deleting the
 * last participant->opaque-owner mapping. Existing completed jobs reopen on
 * restore replay, retaining their irreversible original terminal evidence. */
export async function prepareStorageParticipantErasure(b:StorageErasureBindings,participantId:string):Promise<void>{
 await scope(b);const participantDigest=await participantDeletionDigest(participantId);
 const link=await b.source.prepare('SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?')
  .bind(participantId).first<{owner_digest:string}>();
 if(!link)return;
 await b.ledger.prepare(`INSERT INTO storage_erasure_jobs
 (participant_digest,source_id,owner_digest,source_namespace,state,terminal_json,completed_at)
 VALUES(?,?,?,?,'pending',NULL,NULL) ON CONFLICT(participant_digest,source_id,owner_digest) DO UPDATE SET
 state='pending',completed_at=NULL WHERE source_namespace=excluded.source_namespace`)
 .bind(participantDigest,b.sourceId,link.owner_digest,b.sourceNamespace).run();
 const job=await b.ledger.prepare(`SELECT * FROM storage_erasure_jobs WHERE participant_digest=? AND source_id=? AND owner_digest=?`)
 .bind(participantDigest,b.sourceId,link.owner_digest).first<Job>();
 if(!job||job.source_namespace!==b.sourceNamespace||job.state!=='pending')throw unavailable();
}
const payloadAbsence=`
 NOT EXISTS(SELECT 1 FROM analytics_v1_chunk_values WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_v11_projection_work WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_v11_reusable_values WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_v11_value_pages WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_results WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_execution WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_owners WHERE source_id=?1 AND owner_digest=?2)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_daily_publications WHERE source_id=?1
   AND COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?4)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_model_publications WHERE source_id=?1
   AND COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?4)
 AND NOT EXISTS(SELECT 1 FROM analytics_community_graph_previews WHERE source_id=?1
   AND COALESCE(json_extract(authority_json,'$.publicAuthorityEpoch'),-1)<?4)`;
async function readCompletion(b:StorageErasureBindings,job:Job,change:StorageChange):Promise<boolean>{
 return !!await b.target.prepare(`SELECT 1 AS complete FROM analytics_storage_erasure_receipts r
 JOIN analytics_storage_erasure_fences f ON f.source_id=r.source_id AND f.owner_digest=r.owner_digest
  AND f.terminal_event_digest=r.terminal_event_digest
 WHERE r.source_id=?1 AND r.owner_digest=?2 AND r.terminal_event_digest=?3 AND r.payload_contract=1
  AND f.public_authority_epoch=?4 AND ${payloadAbsence}`)
  .bind(b.sourceId,job.owner_digest,change.eventDigest,change.publicAuthorityEpoch).first();
}
function terminal(value:unknown,job:Job):StorageChange{
 if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();
 const v=value as StorageChange;
 if(Object.keys(v).sort().join(',')!==['sourceId','sequence','eventDigest','ownerDigest','revision','kind','objectDigest','contentDigest','authorityEpoch','publicAuthorityEpoch','recordedMs'].sort().join(',')
  ||v.sourceId!==job.source_id||v.ownerDigest!==job.owner_digest||v.kind!=='owner-erased'
  ||![v.eventDigest,v.ownerDigest,v.objectDigest,v.contentDigest].every(d=>typeof d==='string'&&/^[a-f0-9]{64}$/.test(d))
  ||![v.sequence,v.revision,v.authorityEpoch,v.publicAuthorityEpoch].every(n=>Number.isSafeInteger(n)&&n>0)
  ||!Number.isSafeInteger(v.recordedMs)||v.recordedMs<0)throw unavailable();return v;
}
async function advanceJob(b:StorageErasureBindings,job:Job):Promise<boolean>{
 if(job.source_id!==b.sourceId||job.source_namespace!==b.sourceNamespace)throw unavailable();
 await scope(b);
 const ready=await b.target.prepare('SELECT source_namespace,contract_version FROM analytics_runtime_sources WHERE source_id=?')
  .bind(b.sourceId).first<{source_namespace:string;contract_version:number}>();
 if(!ready||ready.source_namespace!==b.sourceNamespace||ready.contract_version!==1)throw unavailable();
 const current=await b.source.prepare(`SELECT c.sequence FROM storage_owner_revisions r
 JOIN storage_ingestion_changes c ON c.owner_digest=r.owner_digest AND c.revision=r.revision
 WHERE r.owner_digest=? AND r.state='erased' AND c.kind='owner-erased'`).bind(job.owner_digest).first<{sequence:number}>();
 if(!current)return false;
 const fresh=(await readIngestionChanges(b.source,b.sourceId,current.sequence-1,1))[0];
 if(!fresh||fresh.ownerDigest!==job.owner_digest)throw unavailable();
 const proof=await lookupV11StorageSource(b.source,fresh);
 if(proof.disposition!=='discard'||proof.reason!=='owner-erased')throw unavailable();
 // The independent ledger's first terminal survives source backup restoration.
 // A restored source must again prove this SAME opaque owner erased; it cannot
 // revoke or replace the earlier durable terminal authorization.
 const change=job.terminal_json?terminal(JSON.parse(job.terminal_json),job):terminal(fresh,job);
 const json=canonicalJson(change);
 await b.ledger.prepare(`UPDATE storage_erasure_jobs SET terminal_json=? WHERE participant_digest=? AND source_id=? AND owner_digest=?
 AND state='pending' AND (terminal_json IS NULL OR terminal_json=?)`).bind(json,job.participant_digest,b.sourceId,job.owner_digest,json).run();
 const saved=await b.ledger.prepare('SELECT terminal_json FROM storage_erasure_jobs WHERE participant_digest=? AND source_id=? AND owner_digest=?')
  .bind(job.participant_digest,b.sourceId,job.owner_digest).first<string>('terminal_json');if(saved!==json)throw unavailable();
 const terminalProof={disposition:'discard' as const,reason:'owner-erased' as const,sourceId:b.sourceId,ownerDigest:job.owner_digest,
 terminalRevision:change.revision,terminalSequence:change.sequence,authorityEpoch:change.authorityEpoch,publicAuthorityEpoch:change.publicAuthorityEpoch};
 await b.target.batch([
  b.target.prepare(`INSERT INTO analytics_storage_erasure_fences
   (source_id,owner_digest,terminal_event_digest,terminal_sequence,terminal_revision,authority_epoch,public_authority_epoch)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,owner_digest) DO UPDATE SET terminal_event_digest=excluded.terminal_event_digest,
   terminal_sequence=excluded.terminal_sequence,terminal_revision=excluded.terminal_revision,
   authority_epoch=excluded.authority_epoch,public_authority_epoch=excluded.public_authority_epoch`)
   .bind(b.sourceId,job.owner_digest,change.eventDigest,change.sequence,change.revision,change.authorityEpoch,change.publicAuthorityEpoch),
  ...prepareV1ProjectionOwnerFence(b.target,change,terminalProof),
  b.target.prepare('DELETE FROM analytics_v11_owner_heads WHERE source_id=? AND owner_digest=?').bind(b.sourceId,job.owner_digest),
  b.target.prepare("UPDATE analytics_v11_projection_work SET phase='retiring' WHERE source_id=? AND owner_digest=? AND phase!='retiring'")
   .bind(b.sourceId,job.owner_digest),
 ]);
 // No capacity guard here: finite retirement must remain possible when the
 // analytics DB is at its operating cap. No new analytical payload is created.
 await retireV1DailyProjectionPage(b.target,b.sourceId);
 await retireV11DailyProjectionPage(b.target,b.sourceId);
 await retireStorageGraphPage(b.target,b.sourceId);
 await retireStorageCommunityDailyPage(b);
 await retireStorageCommunityGraphPublications(b);
 await b.target.prepare(`INSERT INTO analytics_storage_erasure_receipts(source_id,owner_digest,terminal_event_digest,payload_contract)
 SELECT ?1,?2,?3,1 WHERE EXISTS(SELECT 1 FROM analytics_storage_erasure_fences
 WHERE source_id=?1 AND owner_digest=?2 AND terminal_event_digest=?3 AND public_authority_epoch=?4) AND ${payloadAbsence}
 ON CONFLICT(source_id,owner_digest) DO NOTHING`).bind(b.sourceId,job.owner_digest,change.eventDigest,change.publicAuthorityEpoch).run();
 const complete=await readCompletion(b,job,change);
 if(!complete)return false;
 await b.ledger.prepare(`UPDATE storage_erasure_jobs SET state='complete',completed_at=?
 WHERE participant_digest=? AND source_id=? AND owner_digest=? AND terminal_json=?`).bind(new Date().toISOString(),job.participant_digest,b.sourceId,job.owner_digest,json).run();
 return true;
}
/** One automatic bounded retry page, independent of ordered ingestion backlog. */
export async function advanceStorageErasureJobs(b:StorageErasureBindings,options:{maxJobs?:number}={}):Promise<{completed:number;pending:boolean}>{
 const max=options.maxJobs??1;if(!Number.isSafeInteger(max)||max<1||max>4)throw unavailable();
 const jobs=(await b.ledger.prepare(`SELECT * FROM storage_erasure_jobs WHERE source_id=? AND state='pending'
 ORDER BY attempted_ms,participant_digest,owner_digest LIMIT ?`).bind(b.sourceId,max).all<Job>()).results;
 let completed=0;for(const job of jobs){
  // A mapping saved before an interrupted source deletion must not starve
  // already-erased owners later in the independent queue.
  await b.ledger.prepare("UPDATE storage_erasure_jobs SET attempted_ms=MAX(attempted_ms+1,?) WHERE participant_digest=? AND source_id=? AND owner_digest=? AND state='pending'")
   .bind(Date.now(),job.participant_digest,b.sourceId,job.owner_digest).run();
  if(await advanceJob(b,job))completed++;
 }
 return {completed,pending:!!await b.ledger.prepare("SELECT 1 FROM storage_erasure_jobs WHERE source_id=? AND state='pending' LIMIT 1").bind(b.sourceId).first()};
}
/** Both first response and missing-participant retry require durable completion.
 * Schema absence is tolerated only for a legacy JSON deployment with no jobs. */
export async function requireStorageParticipantErasureComplete(ledger:D1Database,participantId:string,b:StorageErasureBindings|null):Promise<void>{
 if(!b&&!await ledger.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='storage_erasure_jobs'").first())return;
 const digest=await participantDeletionDigest(participantId);
 const jobs=(await ledger.prepare('SELECT * FROM storage_erasure_jobs WHERE participant_digest=? ORDER BY source_id,owner_digest LIMIT 201')
  .bind(digest).all<Job>()).results;
 if(jobs.length>200)throw unavailable();
 if(jobs.length===0)return;
 if(!b)throw unavailable();await scope(b);
 const ready=await b.target.prepare('SELECT source_namespace FROM analytics_runtime_sources WHERE source_id=? AND contract_version=1')
  .bind(b.sourceId).first<string>('source_namespace');if(ready!==b.sourceNamespace)throw unavailable();
 let advanced=false;
 for(const job of jobs){
  if(job.source_id!==b.sourceId||job.source_namespace!==b.sourceNamespace)throw unavailable();
  if(job.state==='pending'){
   // At most one finite cleanup page per user request, regardless of how many
   // restored mappings were retained. The independent worker resumes the rest.
   if(advanced)throw unavailable();advanced=true;
   if(!await advanceJob(b,job))throw unavailable();
  }else{
   if(!job.terminal_json)throw unavailable();
   if(!await readCompletion(b,job,terminal(JSON.parse(job.terminal_json),job))){
    await b.ledger.prepare("UPDATE storage_erasure_jobs SET state='pending',completed_at=NULL WHERE participant_digest=? AND source_id=? AND owner_digest=?")
     .bind(job.participant_digest,job.source_id,job.owner_digest).run();throw unavailable();
   }
  }
 }
}
