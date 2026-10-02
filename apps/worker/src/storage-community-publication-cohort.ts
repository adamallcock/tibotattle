import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {readStorageCommunityOwnerPage,type StorageCommunityOwner} from './storage-community-authority';
import {readAnalyticsWorkClosureFence,type AnalyticsWorkClosureFence} from './storage-analytics-closure-fence';
import {returnedD1Target} from './d1-direct-write';

export interface MaintainedPublicationCohort {readonly fence:AnalyticsWorkClosureFence;readonly members:readonly StorageCommunityOwner[]}
interface Bindings {source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string}
interface Header {member_count:number;valid_until_ms:number;cursor_count:number;revision:number;state:'capturing'|'complete'}
const MAX_BYTES=2*1024*1024,bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
const descriptor=(owner:StorageCommunityOwner)=>({ownerDigest:owner.ownerDigest,inputRevision:owner.inputRevision,
 ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch,hasV1:owner.hasV1,hasV11:owner.hasV11,
 hasV12:owner.hasV12,hasLegacy:owner.hasLegacy,hasEffective:owner.hasEffective===true});
const eligible=(owner:StorageCommunityOwner)=>owner.hasV1||owner.hasV11||owner.hasV12||owner.hasEffective||owner.hasLegacy;
/** One native 64-owner census page is captured per call at a settled source
 * watermark. The cursor is a row count at that immutable source fence, never a
 * private participant ID. Later phases reuse exact opaque membership and only
 * resolve transient participant IDs through source-local indexed links. */
export async function readMaintainedPublicationCohort(bindings:Bindings,expectedFence?:AnalyticsWorkClosureFence):Promise<MaintainedPublicationCohort|null> {
 const fence=expectedFence??await readAnalyticsWorkClosureFence(bindings);if(!fence||fence.validUntilMs<=Date.now())return null;
 const cohortKey=await sha256Hex(canonicalJson(['native-publication-cohort-v1',fence.proofDigest]));
 const header=()=>bindings.target.prepare(`SELECT member_count,valid_until_ms,cursor_count,revision,state FROM analytics_canonical_publication_cohorts
 WHERE cohort_key=? AND source_id=? AND proof_digest=?`).bind(cohortKey,bindings.sourceId,fence.proofDigest).first<Header>();
 let stored=await header();
 if(!stored){
  await bindings.target.prepare(`INSERT INTO analytics_canonical_publication_cohorts
   (cohort_key,source_id,proof_digest,member_count,valid_until_ms,created_ms) VALUES(?,?,?,0,?,?) ON CONFLICT(cohort_key) DO NOTHING`)
   .bind(cohortKey,bindings.sourceId,fence.proofDigest,fence.validUntilMs,Date.now()).run();stored=await header();
 }
 if(!stored||stored.valid_until_ms<=Date.now())return null;
 if(stored.state==='capturing') {
  // This exact base predicate/order is the native readOwnerPage population.
  // The immutable source fence makes an ordinal a safe, privacy-preserving
  // restart cursor; it never declares an unobserved suffix complete.
  const after=stored.cursor_count===0?'':await bindings.source.prepare(`SELECT p.id FROM participants p
   WHERE p.state='active' AND EXISTS(SELECT 1 FROM community_public_source_owners eligible WHERE eligible.participant_id=p.id)
   ORDER BY p.id LIMIT 1 OFFSET ?`).bind(stored.cursor_count-1).first<string>('id');
  if(after===null)return null;
  const page=await readStorageCommunityOwnerPage(bindings.source,{afterParticipantId:after});
  const accepted=page.filter(eligible);if(accepted.some(owner=>!owner.ownerDigest||owner.ownerRevision<1))return null;
  const rows=accepted.map((owner,index)=>({ownerDigest:owner.ownerDigest,ordinal:stored!.member_count+index,descriptor:canonicalJson(descriptor(owner))}));
  const priorBytes=await bindings.target.prepare(`SELECT COALESCE(sum(length(CAST(descriptor AS BLOB))),0) n
   FROM analytics_canonical_publication_cohort_members WHERE cohort_key=?`).bind(cohortKey).first<number>('n');
  if(priorBytes===null||priorBytes+rows.reduce((n,row)=>n+bytes(row.descriptor),0)>MAX_BYTES||stored.member_count+rows.length>65536)return null;
  const fresh=await readAnalyticsWorkClosureFence(bindings);if(!fresh||fresh.proofDigest!==fence.proofDigest)return null;
  const commit=await bindings.target.batch([
   bindings.target.prepare(`INSERT INTO analytics_canonical_publication_cohort_members(cohort_key,source_id,owner_digest,ordinal,descriptor)
    SELECT ?,?,json_extract(value,'$.ownerDigest'),json_extract(value,'$.ordinal'),json_extract(value,'$.descriptor') FROM json_each(?)
    WHERE EXISTS(SELECT 1 FROM analytics_canonical_publication_cohorts WHERE cohort_key=? AND revision=? AND state='capturing')
    ON CONFLICT(cohort_key,owner_digest) DO NOTHING`).bind(cohortKey,bindings.sourceId,JSON.stringify(rows),cohortKey,stored.revision),
   bindings.target.prepare(`UPDATE analytics_canonical_publication_cohorts SET member_count=member_count+?,cursor_count=cursor_count+?,
    state=?,revision=revision+1 WHERE cohort_key=? AND revision=? AND state='capturing' RETURNING cohort_key`)
    .bind(rows.length,page.length,page.length<64?'complete':'capturing',cohortKey,stored.revision),
  ]).catch(error=>{if(/canonical_publication_authority|FOREIGN KEY/iu.test(String(error)))return null;throw error;});
  if(!commit||!returnedD1Target(commit.at(-1),'cohort_key',cohortKey))return null;
  stored=await header();if(!stored||stored.state!=='complete')return null;
 }
 const members:StorageCommunityOwner[]=[];let after=-1,size=0;
 for(;;) {
  const page=(await bindings.target.prepare(`SELECT owner_digest,ordinal,descriptor FROM analytics_canonical_publication_cohort_members
   WHERE cohort_key=? AND ordinal>? ORDER BY ordinal LIMIT 64`).bind(cohortKey,after)
   .all<{owner_digest:string;ordinal:number;descriptor:string}>()).results;
  for(const row of page){size+=bytes(row.descriptor);if(size>MAX_BYTES)return null;}
  if(page.length) {
   const links=(await bindings.source.prepare(`SELECT owner_digest,participant_id FROM storage_v11_owner_links
    WHERE owner_digest IN(SELECT value FROM json_each(?)) AND state='active'`)
    .bind(JSON.stringify(page.map(row=>row.owner_digest))).all<{owner_digest:string;participant_id:string}>()).results;
   if(links.length!==page.length)return null;
   const byOwner=new Map(links.map(row=>[row.owner_digest,row.participant_id]));
   for(const row of page){
    const value=JSON.parse(row.descriptor) as Omit<StorageCommunityOwner,'participantId'>;
    if(value.ownerDigest!==row.owner_digest||canonicalJson(descriptor({...value,participantId:''}))!==row.descriptor)return null;
    const participantId=byOwner.get(row.owner_digest);if(!participantId)return null;
    members.push({...value,participantId});
   }
  }
  if(page.length<64)break;after=page.at(-1)!.ordinal;
 }
 if(members.length!==stored.member_count)return null;
 const final=await readAnalyticsWorkClosureFence(bindings);
 return final&&final.proofDigest===fence.proofDigest&&fence.validUntilMs>Date.now()?{fence:final,members}:null;
}
/** Expired or positively superseded unpinned cohorts drain one bounded member
 * page. Expiration prevents recapture/serving of a partially drained census. */
export async function retireMaintainedPublicationCohorts(target:D1Database,input:{sourceId:string;beforeMs:number;limit?:number;nowMs?:number}):Promise<number> {
 const limit=input.limit??8,nowMs=input.nowMs??Date.now();
 if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(input.sourceId)||!Number.isSafeInteger(input.beforeMs)||input.beforeMs<0
  ||!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(limit)||limit<1||limit>16)throw new Error('CANONICAL_COHORT_RETIRE_INVALID');
 const guard=`c.source_id=? AND c.created_ms<?
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_publications p WHERE p.cohort_key=c.cohort_key)
  AND (c.valid_until_ms<=? OR EXISTS(SELECT 1 FROM analytics_canonical_cache_publications p
   JOIN analytics_canonical_publication_cohorts newer ON newer.cohort_key=p.cohort_key
   WHERE p.source_id=c.source_id AND newer.source_id=c.source_id AND p.cohort_key!=c.cohort_key
   AND newer.created_ms>c.created_ms AND p.computed_ms>c.created_ms))
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=c.source_id AND w.state='leased' AND w.claim_expires_ms>?)`;
 const values=[input.sourceId,input.beforeMs,nowMs,nowMs];
 const key=await target.prepare(`SELECT c.cohort_key FROM analytics_canonical_publication_cohorts c WHERE ${guard}
  ORDER BY c.created_ms,c.cohort_key LIMIT 1`).bind(...values).first<string>('cohort_key');if(!key)return 0;
 const eligible=`EXISTS(SELECT 1 FROM analytics_canonical_publication_cohorts c WHERE c.cohort_key=? AND ${guard})`;
 const marked=await target.prepare(`UPDATE analytics_canonical_publication_cohorts SET valid_until_ms=?,revision=revision+1
  WHERE cohort_key=? AND valid_until_ms>? AND ${eligible} RETURNING cohort_key`).bind(nowMs,key,nowMs,key,...values).all<{cohort_key:string}>();
 const members=await target.prepare(`DELETE FROM analytics_canonical_publication_cohort_members WHERE (cohort_key,owner_digest) IN(
  SELECT cohort_key,owner_digest FROM analytics_canonical_publication_cohort_members WHERE cohort_key=? AND ${eligible}
  ORDER BY owner_digest LIMIT ?) RETURNING owner_digest`).bind(key,key,...values,Math.min(128,limit*8)).all<{owner_digest:string}>();
 const root=await target.prepare(`DELETE FROM analytics_canonical_publication_cohorts WHERE cohort_key=? AND ${eligible}
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_cohort_members WHERE cohort_key=?) RETURNING cohort_key`)
  .bind(key,key,...values,key).all<{cohort_key:string}>();
 return marked.results.length+members.results.length+root.results.length;
}
