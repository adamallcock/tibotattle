import {ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS} from './admin-community-allowance';
import type {AnalyticsPublicationWorkInput,AnalyticsPublicationWorkResult} from './storage-analytics-work-contract';
export type {AnalyticsPublicationWorkInput,AnalyticsPublicationWorkResult} from './storage-analytics-work-contract';
import {closeObsoleteAnalyticsManifestWork} from './storage-analytics-maintained-work';
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import type {AnalyticsWorkLease,AnalyticsWorkExecutionBudget,AnalyticsWorkOutcome} from './analytics-partition-work';
import {readAnalyticsPartitionWork,completeAnalyticsPartitionWork,type AnalyticsWorkRequest,type AnalyticsStoredWork} from './storage-analytics-partition-work';
import {captureAnalyticsManifestWorkProof} from './storage-analytics-work-proof';
import {readAnalyticsWorkClosureFence,type AnalyticsWorkClosureFence} from './storage-analytics-closure-fence';
import {readCanonicalPartition} from './storage-canonical-analytics-facts';
import {materializeCanonicalFeaturePartition} from './storage-canonical-feature-contributions';
import {readCanonicalInputMembership,type CanonicalInputScope} from './storage-canonical-analytics-input';
import {readStorageCanonicalSourceMembership} from './storage-community-daily-devices';
import {readStorageCommunityOwner} from './storage-community-authority';
import {advanceStorageCommunityDaily,type StorageDailyCanonicalPreparation} from './storage-community-daily';
import {replaceCanonicalPublicationPart,canonicalPublicationAvailable,canonicalPublicationProducerCoverage,beginCanonicalPublicationClosure,
 appendCanonicalPublicationExpected,sealCanonicalPublicationExpected,readCanonicalPublicationClosure,
 commitCanonicalPublicationClosure} from './storage-canonical-publication';
import {advanceCanonicalCachePublication} from './storage-community-cache-publication';
import {publishStorageCommunityModelDay,publishStorageCommunityGraphPreview} from './storage-community-graph-publication';
import type {CanonicalActivityMembership} from './canonical-feature-contributions';

const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
/** Preserve the original publication successor for every independently completed
 * activity leaf, whether preparation was singleton or grouped. */
export async function activityPublicationWorkSuccessor(work:AnalyticsStoredWork,partRevision:string):Promise<AnalyticsWorkRequest> {
 return {sourceId:work.sourceId,ownerDigest:null,stage:'publication',lane:work.lane,
  partitionKey:'activity/'+work.day,headKey:await digest(['activity-publication',work.sourceId,work.day]),
  inputRevision:partRevision,policyRevision:work.policyRevision,day:work.day,stream:null,selectionMethod:null,
  residentBytes:8*1024*1024,admissionQueries:600};
}
const INVENTORY=`SELECT DISTINCT w.partition_key,w.input_revision AS content_revision FROM analytics_partition_work w
 JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key AND h.content_revision=w.input_revision
 JOIN analytics_canonical_manifests m ON m.content_revision=w.input_revision AND m.state='complete'
 WHERE w.source_id=? AND w.stage='activity' AND w.day=?
 AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)`;
/** Execute retained contribution work under its exact lease and immutable
 * manifest. Source-private membership is resolved once per scope in this call;
 * the final source seals and target transaction independently fence adoption. */
export async function advanceAnalyticsPublicationWork(input:AnalyticsPublicationWorkInput):Promise<AnalyticsPublicationWorkResult> {
 const start=input.budget.meter.queriesUsed,target=input.budget.meter.wrap(input.target),now=input.budget.now;
 const sources=input.sources.map(binding=>({...binding,database:input.budget.meter.wrap(binding.database)}));
 const result=(outcome:AnalyticsWorkOutcome,reason:string,completedWithinLease=false,closureKey?:string):AnalyticsPublicationWorkResult=>
 ({outcome,reason,completedWithinLease,statements:input.budget.meter.queriesUsed-start,...(closureKey?{closureKey}:{})});
 const available=(reserve=80)=>input.budget.remainingQueries()>=reserve&&now()<input.budget.deadlineMs-1500;
 if(!available())return result('deferred','query_budget');
 if(!await canonicalPublicationAvailable(target))return result('refused','migration_required');
 const work=await readAnalyticsPartitionWork(target,input.lease,now());if(!work)return result('deferred','lease_changed');
 const source=sources.find(binding=>binding.sourceId===work.sourceId);
 if(!source||!work.day)return result('refused','source_scope_unavailable');
 if(work.stage==='activity') {
  if(await closeObsoleteAnalyticsManifestWork(target,input.lease,now()))return result('refused','obsolete_input',true);
  const partition=await readCanonicalPartition(target,work.partitionKey);
  if(!partition||partition.manifest.contentRevision!==work.inputRevision)return result('deferred','canonical_partition_changed');
  const workProof=await captureAnalyticsManifestWorkProof({target,sources,lease:input.lease,work,manifest:partition.manifest,budget:input.budget});
  if(workProof.state!=='complete')return result(workProof.state,workProof.reason);
 try {
  const metadata=(await target.prepare(`SELECT f.revision,f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
   FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
   WHERE r.content_revision=? ORDER BY r.ordinal LIMIT 129`).bind(work.inputRevision)
   .all<{revision:string;source_id:string;owner_digest:string;observed_day:string;stream:NonNullable<AnalyticsWorkRequest['stream']>;
    selection_method:NonNullable<AnalyticsWorkRequest['selectionMethod']>}>()).results;
  if(metadata.length!==partition.manifest.rowCount)return result('deferred','manifest_incomplete');
  const memberships=new Map<string,CanonicalActivityMembership>();
  const byScope=new Map<string,CanonicalActivityMembership>();
  for(const row of metadata) {
   const scopeKey=JSON.stringify([row.source_id,row.owner_digest,row.observed_day,row.stream,row.selection_method]);
   let value=byScope.get(scopeKey);
   if(!value) {
    if(!available(60))return result('deferred','query_budget');
    const binding=sources.find(binding=>binding.sourceId===row.source_id);if(!binding)return result('deferred','source_binding_unavailable');
    const owner=await readStorageCommunityOwner(binding.database,{ownerDigest:row.owner_digest});if(!owner)return result('deferred','owner_unavailable');
    const scope:CanonicalInputScope={sourceId:row.source_id,sourceNamespace:binding.sourceNamespace,ownerDigest:row.owner_digest,
     participantId:owner.participantId,day:row.observed_day,stream:row.stream,selectionMethod:row.selection_method};
    const context=workProof.contextFor(binding.database,target,scope);
    if(!context)return result('deferred','source_scope_unavailable');
    const proof=await readCanonicalInputMembership(binding.database,target,scope,readStorageCanonicalSourceMembership,context);
    if(proof.state!=='complete'||proof.deviceKeys.length===0)return result('deferred','membership_unavailable');
    value={method:proof.method,dependencyRevision:proof.dependencyRevision,contributorKey:proof.contributorKey,deviceKeys:proof.deviceKeys};
    byScope.set(scopeKey,value);
   }
   memberships.set(row.revision,value);
  }
  const stillCurrent=workProof.stillCurrent;
  const feature=await materializeCanonicalFeaturePartition({target,partitionKey:work.partitionKey,budget:input.budget,
   stillCurrent:workProof.canCommit,membership:async fact=>memberships.get(fact.revision)??null});
  if(feature.state!=='complete')return result(feature.state,feature.reason);
  const previous=await target.prepare(`SELECT revision FROM analytics_canonical_publication_part_heads WHERE source_id=? AND partition_key=?`)
   .bind(work.sourceId,work.partitionKey).first<string>('revision');
  const replaced=await replaceCanonicalPublicationPart(target,{sourceId:work.sourceId,feature,expectedRevision:previous,
   nowMs:now(),stillCurrent,lease:input.lease});
  if(replaced.state!=='complete')return result(replaced.state,replaced.reason);
  const successor=await activityPublicationWorkSuccessor(work,replaced.part.revision);
  const completed=await completeAnalyticsPartitionWork(target,input.lease,[successor],now());
  return result(completed?'complete':'deferred',completed?'activity_replaced':'lease_changed',completed);
 } finally {workProof.close();}
 }
 if(work.stage==='publication'&&/^(effective-union-v1|legacy-selected-v1)\//u.test(work.partitionKey))return advanceCanonicalCachePublication(input);
 if(work.stage==='publication'&&(work.partitionKey==='model/'+work.day||work.partitionKey==='fits/'+work.day)) {
  const nowMs=now(),today=new Date(nowMs).toISOString().slice(0,10);
  const oldest=new Date(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*86400000).toISOString().slice(0,10);
  if(work.day>today)return result('deferred','clock_pending');
  if(work.partitionKey.startsWith('fits/')&&work.day<today
    ||work.partitionKey.startsWith('model/')&&work.day<oldest)return result('refused','obsolete_input');
  const bindings={source:source.database,target,sourceId:source.sourceId,sourceNamespace:source.sourceNamespace};
  if(!available(120))return result('deferred','query_budget');
  // Fits always adopts the native current-day preview. Historical model jobs
  // retain their own output day and the preview keeps its original window.
  const publication=work.partitionKey.startsWith('model/')
   ?await publishStorageCommunityModelDay(bindings,{day:work.day,nowMs:now(),canonicalClosure:true,publicationLease:input.lease})
   :await publishStorageCommunityGraphPreview(bindings,{nowMs:now(),canonicalClosure:true,publicationLease:input.lease});
  if(publication.state!=='published'&&publication.state!=='unchanged')return result('deferred','reason' in publication?publication.reason:'graph_pending');
  const completed=await completeAnalyticsPartitionWork(target,input.lease,[],now());
  return result(completed?'complete':'deferred',completed?'graph_published':'lease_changed',completed);
 }
 if(work.stage!=='publication'||work.partitionKey!=='activity/'+work.day)return result('deferred','publication_family_pending');
 const bindings={source:source.database,target,sourceId:source.sourceId,sourceNamespace:source.sourceNamespace};
 const fence=await readAnalyticsWorkClosureFence(bindings);if(!fence)return result('deferred','source_prefix_pending');
 if(!available())return result('deferred','query_budget');
 // Current activity work is the maintained expected partition index. Verify
 // that its manifests cover every canonical fact on the output day, including
 // all source formats; an absent producer is never an inferred empty result.
 if(!await canonicalPublicationProducerCoverage(target,{sourceId:work.sourceId,family:'activity',day:work.day}))
  return result('deferred','activity_coverage_pending');
 const expected=await target.prepare('SELECT count(*) n FROM ('+INVENTORY+')').bind(work.sourceId,work.day).first<number>('n');
 if(expected===null||expected>65536)return result('refused','publication_capacity');
 const closureKey=await beginCanonicalPublicationClosure(target,{sourceId:work.sourceId,day:work.day,family:'activity',
  watermark:fence.acceptedSequence,authorityDigest:fence.proofDigest,expectedCount:expected,nowMs:now()});
 const closure=await readCanonicalPublicationClosure(target,closureKey);if(!closure)return result('deferred','closure_changed');
 if(closure.state==='invalidated')return result('deferred','closure_invalidated',false,closureKey);
 if(closure.state==='capturing') {
  const after=await target.prepare('SELECT MAX(partition_key) after_key FROM analytics_canonical_publication_expected WHERE closure_key=?')
   .bind(closureKey).first<string>('after_key')??'';
  const page=(await target.prepare('SELECT * FROM ('+INVENTORY+') WHERE partition_key>? ORDER BY partition_key LIMIT 128')
   .bind(work.sourceId,work.day,after).all<{partition_key:string;content_revision:string}>()).results;
  await appendCanonicalPublicationExpected(target,closureKey,page.map(row=>({partitionKey:row.partition_key,contentRevision:row.content_revision})));
  if(!await sealCanonicalPublicationExpected(target,closureKey))return result('deferred','expected_capture_pending',false,closureKey);
 }
 // One bounded completion page records changed/empty/explicit unchanged
 // outcomes from durable exact part heads. Already completed rows stay intact.
 await target.prepare(`UPDATE analytics_canonical_publication_expected SET part_revision=(SELECT h.revision
 FROM analytics_canonical_publication_part_heads h JOIN analytics_canonical_publication_parts p ON p.revision=h.revision
 WHERE h.source_id=? AND h.partition_key=analytics_canonical_publication_expected.partition_key
 AND p.content_revision=analytics_canonical_publication_expected.content_revision),outcome=CASE WHEN
 (SELECT fact_count FROM analytics_canonical_publication_parts p JOIN analytics_canonical_publication_part_heads h ON h.revision=p.revision
 WHERE h.source_id=? AND h.partition_key=analytics_canonical_publication_expected.partition_key)=0 THEN 'empty' ELSE 'unchanged' END
 WHERE (closure_key,partition_key) IN(SELECT e.closure_key,e.partition_key FROM analytics_canonical_publication_expected e
 JOIN analytics_canonical_publication_part_heads h ON h.source_id=? AND h.partition_key=e.partition_key
 JOIN analytics_canonical_publication_parts p ON p.revision=h.revision AND p.content_revision=e.content_revision
 WHERE e.closure_key=? AND e.outcome='pending' ORDER BY e.partition_key LIMIT 128)`)
 .bind(work.sourceId,work.sourceId,work.sourceId,closureKey).run();
 await target.prepare(`INSERT INTO analytics_canonical_publication_subjects(closure_key,source_id,owner_digest)
 SELECT e.closure_key,s.source_id,s.owner_digest FROM analytics_canonical_publication_expected e
 JOIN analytics_canonical_publication_part_subjects s ON s.part_revision=e.part_revision
 WHERE e.closure_key=? ON CONFLICT DO NOTHING`).bind(closureKey).run();
 if(!await commitCanonicalPublicationClosure(target,closureKey))return result('deferred','activity_completion_pending',false,closureKey);
 const fresh:AnalyticsWorkClosureFence|null=await readAnalyticsWorkClosureFence(bindings);
 if(!fresh||fresh.proofDigest!==fence.proofDigest||!await readAnalyticsPartitionWork(target,input.lease,now()))
  return result('deferred','source_prefix_changed',false,closureKey);
 if(!available(100))return result('deferred','query_budget',false,closureKey);
 const publication=await advanceStorageCommunityDaily({...bindings,day:work.day,maxOwners:1,nowMs:now(),sharedFeatures:true,
  canonicalPreparation:input.canonicalPreparation,publicationClosureKey:closureKey,publicationLease:input.lease,sharedFeatureBudget:input.budget});
 if(publication.state!=='published'&&publication.state!=='unchanged')return result('deferred',publication.reason??'daily_progress',false,closureKey);
 const completed=await completeAnalyticsPartitionWork(target,input.lease,[],now());
 return result(completed?'complete':'deferred',completed?'activity_published':'lease_changed',completed,closureKey);
}
