import type {AnalyticsCanonicalWorkInput} from './storage-analytics-canonical-work';
import type {AnalyticsWorkOutcome} from './analytics-partition-work';
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {readCanonicalPartition} from './storage-canonical-analytics-facts';
import {captureAnalyticsManifestWorkProof} from './storage-analytics-work-proof';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from './d1-invocation-budget';
import {advanceCanonicalInputWork,closeCanonicalInputReadContext,createCanonicalInputReadContext,
 type CanonicalInputScope} from './storage-canonical-analytics-input';
import {readStorageCommunityOwner} from './storage-community-authority';
import {readAnalyticsPartitionWork,completeAnalyticsPartitionWork,type AnalyticsWorkRequest,type AnalyticsStoredWork} from './storage-analytics-partition-work';
import {canonicalCachePreparedRepairBlocked,materializeCanonicalCachePartition,recordCanonicalCachePreparedReceipt,
 type CanonicalCacheMetrics} from './storage-canonical-cache-pairs';
export interface AnalyticsCacheWorkResult {
 readonly outcome:AnalyticsWorkOutcome;readonly reason:string;readonly completedWithinLease:boolean;
 readonly statements:number;readonly metrics?:CanonicalCacheMetrics;
}
/** One reviewed successor identity shared by singleton and original-leaf groups. */
export async function cachePublicationWorkSuccessor(work:AnalyticsStoredWork,contentRevision:string):Promise<AnalyticsWorkRequest> {
 const {workKey:_key,attempts:_attempts,...request}=work;
 return {...request,ownerDigest:null,stage:'publication',
  headKey:await sha256Hex(canonicalJson(['publication-cache',work.sourceId,work.partitionKey])),
  inputRevision:contentRevision,residentBytes:2*1024*1024,admissionQueries:400};
}
/** A failed source seal may be prepared under this same cache lease. This is
 * never a cache proof: even a completed input must await a fresh ordinary
 * claim, manifest proof, source fence, and completion CAS. */
async function prepareCanonicalInputPrerequisite(input:AnalyticsCanonicalWorkInput,target:D1Database,
 work:AnalyticsStoredWork,partition:NonNullable<Awaited<ReturnType<typeof readCanonicalPartition>>>):Promise<void> {
 const now=input.budget.now;
 if(work.inputRevision!==partition.manifest.contentRevision||!work.day||!work.stream||!work.selectionMethod
  ||partition.manifest.rowCount<1||partition.manifest.rowCount>128)return;
 if(input.budget.remainingQueries()<340||Math.max(now(),Date.now())>=input.budget.deadlineMs-5_000)return;
 // A full manifest contains at most 128 admitted facts. LIMIT 2 distinguishes
 // a singleton from every mixed owner/day/stream/method leaf without scanning
 // source history or treating a mixed leaf as a new owner work boundary.
 const scopes=(await target.prepare(`SELECT DISTINCT f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
  FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  WHERE r.content_revision=? LIMIT 2`).bind(partition.manifest.contentRevision)
  .all<{source_id:string;owner_digest:string;observed_day:string|null;
   stream:NonNullable<AnalyticsStoredWork['stream']>;selection_method:NonNullable<AnalyticsStoredWork['selectionMethod']>}>()).results;
 if(scopes.length!==1)return;
 const row=scopes[0]!;
 if(!row.owner_digest||row.source_id!==work.sourceId||row.observed_day!==work.day
  ||row.stream!==work.stream||row.selection_method!==work.selectionMethod)return;
 const bindings=input.sources.filter(source=>source.sourceId===row.source_id);
 if(bindings.length!==1)return;
 const binding=bindings[0]!,source=input.budget.meter.wrap(binding.database);
 const owner=await readStorageCommunityOwner(source,{ownerDigest:row.owner_digest});
 if(!owner?.ownerDigest||owner.ownerDigest!==row.owner_digest||!owner.participantId)return;
 // Admission is freshly checked after the metadata reads. The independent
 // input producer still performs its own source/authority/erasure and write CAS.
 if(!await readAnalyticsPartitionWork(target,input.lease,now()))return;
 const current=await target.prepare(`SELECT 1 ready FROM analytics_canonical_partition_heads h
  JOIN analytics_canonical_manifests m ON m.content_revision=h.content_revision
  WHERE h.partition_key=? AND h.content_revision=? AND m.state='complete' AND m.row_count=?
   AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions
    WHERE partition_key=m.root_partition_key),0)`).bind(work.partitionKey,
   partition.manifest.contentRevision,partition.manifest.rowCount).first<number>('ready');
 if(current!==1||input.budget.remainingQueries()<332
  ||Math.max(now(),Date.now())>=input.budget.deadlineMs-5_000)return;
 const scope:CanonicalInputScope={sourceId:binding.sourceId,sourceNamespace:binding.sourceNamespace,
  ownerDigest:owner.ownerDigest,participantId:owner.participantId,day:row.observed_day,
  stream:row.stream,selectionMethod:row.selection_method};
 // Both context and producer receive the *same* child-wrapped handles. Each
 // statement is charged to the child, original work meter, and outer request.
 const child=createD1InvocationBudget(300),childSource=child.wrap(source),childTarget=child.wrap(target);
 let context:Awaited<ReturnType<typeof createCanonicalInputReadContext>>=null;
 try {
  context=await createCanonicalInputReadContext(childSource,childTarget,[scope],input.budget.deadlineMs);
  if(!context)return;
  if(!await readAnalyticsPartitionWork(childTarget,input.lease,now()))return;
  await advanceCanonicalInputWork(childSource,childTarget,{...scope,context,
   budget:{meter:child,maxSteps:4,now,deadlineMs:input.budget.deadlineMs}});
 } catch(error) {
  if(!(error instanceof D1InvocationBudgetExceededError))throw error;
 } finally {if(context)closeCanonicalInputReadContext(context);}
}
/** Concrete manifest cache producer. The successor means a private cache
 * product is ready for P7 closure; it never grants publication eligibility. */
export async function advanceAnalyticsCacheWork(input:AnalyticsCanonicalWorkInput):Promise<AnalyticsCacheWorkResult> {
 const started=input.budget.meter.queriesUsed,target=input.budget.meter.wrap(input.target),now=input.budget.now;
 const result=(outcome:AnalyticsWorkOutcome,reason:string,completedWithinLease=false,metrics?:CanonicalCacheMetrics):AnalyticsCacheWorkResult=>
  ({outcome,reason,completedWithinLease,statements:input.budget.meter.queriesUsed-started,...(metrics?{metrics}:{})});
 if(input.budget.remainingQueries()<100||now()>=input.budget.deadlineMs-1500)return result('deferred','query_budget');
 const work=await readAnalyticsPartitionWork(target,input.lease,now());if(!work)return result('deferred','lease_changed');
 if(work.stage!=='cache')return result('refused','cache_stage_required');
 const partition=await readCanonicalPartition(target,work.partitionKey);if(!partition)return result('deferred','manifest_changed');
 // Existing immutable slots are durable preparation, but never a source or
 // publication proof. Defer only when this exact leased/current leaf has no
 // slot work AND the ordinary bounded repair page cannot yet make progress.
 // Every other case retains the full source, authority, lease and CAS path.
 if(work.inputRevision===partition.manifest.contentRevision&&await canonicalCachePreparedRepairBlocked({target,partition,
  lease:input.lease,budget:input.budget}))return result('deferred','cache_repairs_pending');
 const proof=await captureAnalyticsManifestWorkProof({...input,target,work,manifest:partition.manifest});
 if(proof.state!=='complete'){
  if(proof.state==='deferred'&&proof.reason==='canonical_input_unsealed')
   await prepareCanonicalInputPrerequisite(input,target,work,partition);
  return result(proof.state,proof.reason);
 }
 try {
 const prepared=await materializeCanonicalCachePartition({target,partitionKey:work.partitionKey,
  budget:input.budget,stillCurrent:proof.stillCurrent,canCommit:proof.canCommit,lease:input.lease,maxRepairs:8});
 if(prepared.state!=='complete'){
  // A blocked repair can leave this exact leaf's physical slots prepared.
  // The durable receipt helps one invocation avoid repeat claims; it does not
  // close this lease or replace the full source proof on eventual resume.
  if(prepared.state==='deferred'&&prepared.reason==='cache_repairs_pending'
   &&input.budget.remainingQueries()>=12&&now()<input.budget.deadlineMs-1500&&await proof.canCommit())
   await recordCanonicalCachePreparedReceipt({target,lease:input.lease,partition,budget:input.budget});
  return result(prepared.state,prepared.reason,false,prepared.metrics);
 }
 if(!await proof.stillCurrent())return result('deferred','source_changed',false,prepared.metrics);
 const successor=await cachePublicationWorkSuccessor(work,prepared.manifest.contentRevision);
 const closed=await completeAnalyticsPartitionWork(target,input.lease,[successor],now());
 return result(closed?'complete':'deferred',closed?'cache_prepared':'lease_changed',closed,prepared.metrics);
 } finally {proof.close();}
}
