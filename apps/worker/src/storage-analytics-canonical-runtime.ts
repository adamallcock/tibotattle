/** Composition of maintained changed work. Every statement carries the caller's
 * invocation meter; no consumer's estimate grants publication or source ACK. */
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {createD1InvocationBudget,D1InvocationBudgetExceededError,type D1InvocationBudget} from './d1-invocation-budget';
import {dispatchAnalyticsWork,dispatchAnalyticsFeatureGroup,dispatchAnalyticsActivityGroup,dispatchAnalyticsCacheGroup,type AnalyticsWorkDegree,type AnalyticsWorkStage,
 type AnalyticsWorkLease,type AnalyticsWorkExecutionBudget,type AnalyticsWorkOutcome} from './analytics-partition-work';
import {advanceAnalyticsFeatureGroup} from './storage-analytics-feature-group';
import {advanceAnalyticsActivityGroup} from './storage-analytics-activity-group';
import {advanceAnalyticsCacheGroup} from './storage-analytics-cache-group';
import {analyticsPartitionWorkAvailable,claimAnalyticsPartitionWork,releaseAnalyticsPartitionWork,
 readAnalyticsPartitionWork,completeAnalyticsPartitionWork,admitAnalyticsPartitionWork,recordAnalyticsPartitionWorkReason,previewAnalyticsFeatureGroup,previewAnalyticsActivityGroup,previewAnalyticsCacheGroup,
 type AnalyticsWorkRequest} from './storage-analytics-partition-work';
import {advanceEffectiveDependencyCoverage,effectiveSelectiveSchemaAvailable,type EffectiveDependencyCoverageProgress} from './storage-effective-selective-dependencies';
import {advanceAnalyticsWorkEffects,type AnalyticsWorkEffectsProgress} from './storage-analytics-work-effects';
import {advanceAnalyticsCanonicalWork} from './storage-analytics-canonical-work';
import {advanceAnalyticsCacheWork} from './storage-analytics-cache-work';
import {advanceAnalyticsPublicationWork} from './storage-analytics-publication-work';
import {createCanonicalSharedFeaturePreparation} from './storage-analytics-canonical-day';
import {advanceStorageCommunityGraphWork} from './storage-community-graph-work';
import {executeCanonicalV1WindowRequest} from './storage-canonical-v1-window';
import {readStorageCommunityOwner} from './storage-community-authority';
import {canonicalRollingInputsAvailable} from './storage-canonical-rolling-inputs';
import {canonicalPublicationAvailable} from './storage-canonical-publication';
import {canonicalCacheAvailable,canonicalCacheRepairPageBlocked} from './storage-canonical-cache-pairs';
import {admitCanonicalCachePublicationRefresh} from './storage-community-cache-publication';
import {maintainedAnalyticsPolicyRevision,admitMaintainedAnalyticsPolicyWork,admitMaintainedGraphPublications,
 admitMaintainedGraphComputations,maintainedGraphWorkIsCurrent,closeObsoleteAnalyticsManifestWork} from './storage-analytics-maintained-work';
import {advanceAnalyticsWorkRetirement} from './storage-analytics-work-retirement';
import {StorageGraphOperationError} from './storage-analytics-failure';
import {requireAuthorityRestoreServingReady} from './authority-restore';
import {readAnalyticsWorkTargetSettled} from './storage-analytics-closure-fence';

export interface CanonicalAnalyticsWorkPassInput {
 readonly source:D1Database;readonly target:D1Database;readonly sourceId:string;readonly sourceNamespace:string;
 readonly invocation:D1InvocationBudget;readonly deadlineMs:number;readonly now:()=>number;
 readonly degree?:AnalyticsWorkDegree;readonly maxWaves?:number;readonly stages?:readonly AnalyticsWorkStage[];
 readonly bridge?:boolean;readonly modelBlocks?:boolean;
}
export interface CanonicalAnalyticsWorkPassProgress {
 readonly state:'progress'|'idle'|'deferred'|'unavailable';readonly reason:string;
 readonly claimed:number;readonly admitted:number;readonly complete:number;readonly deferred:number;
 readonly refused:number;readonly failed:number;readonly releaseDeferred:number;readonly statements:number;
 readonly effects?:AnalyticsWorkEffectsProgress;readonly coverage?:EffectiveDependencyCoverageProgress;
 readonly retirement?:Awaited<ReturnType<typeof advanceAnalyticsWorkRetirement>>;
}
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
const NON_PUBLICATION_STAGES:readonly AnalyticsWorkStage[]=['canonical','features','activity','fits','cache','cleanup'];
async function admitRollingRequests(input:CanonicalAnalyticsWorkPassInput,source:D1Database,target:D1Database):Promise<void> {
 if(input.invocation.remainingQueries<90||input.stages&&!input.stages.includes('fits'))return;
 if(!await canonicalRollingInputsAvailable(target))return;
 const oldPolicy=await digest(['rolling-window-producer-v1']);
 const policyRevision=await digest(['rolling-window-producer-v2',300]);
 const nowMs=input.now();
 // The second arm keeps a superseded v1 request discoverable after the v2
 // insert, including when a live old lease expires in a later invocation.
 // A dirty artifact has no serving path and needs no replacement work.
 const rows=(await target.prepare(`SELECT r.window_key,r.owner_digest,r.native_dependency,r.state
 FROM analytics_canonical_rolling_windows r INDEXED BY analytics_canonical_rolling_window_scope
 WHERE r.source_id=? AND r.kind IN('legacy-scalar','legacy-model')
 AND ((r.state='building' AND NOT EXISTS(
   SELECT 1 FROM analytics_partition_work next INDEXED BY analytics_partition_work_producer
   WHERE next.source_id=r.source_id AND next.stage='fits' AND next.input_revision=r.native_dependency
    AND next.partition_key='rolling-window/'||r.window_key AND next.owner_digest=r.owner_digest
    AND next.policy_revision=?)
  AND NOT EXISTS(
   SELECT 1 FROM analytics_partition_work held INDEXED BY analytics_partition_work_producer
   WHERE held.source_id=r.source_id AND held.stage='fits' AND held.input_revision=r.native_dependency
    AND held.partition_key='rolling-window/'||r.window_key AND held.owner_digest=r.owner_digest
    AND held.policy_revision=? AND (held.state='leased' AND held.claim_expires_ms>?
     OR held.state='ready' AND held.ready_ms>?)))
  OR (r.state IN('building','complete','dirty') AND EXISTS(
   SELECT 1 FROM analytics_partition_work old INDEXED BY analytics_partition_work_producer
   WHERE old.source_id=r.source_id AND old.stage='fits' AND old.input_revision=r.native_dependency
    AND old.partition_key='rolling-window/'||r.window_key AND old.owner_digest=r.owner_digest
    AND old.policy_revision=? AND (old.state='ready' AND old.ready_ms<=?
     OR old.state='leased' AND old.claim_expires_ms<=?))))
 ORDER BY r.window_key LIMIT 8`).bind(input.sourceId,policyRevision,oldPolicy,nowMs,nowMs,oldPolicy,nowMs,nowMs)
 .all<{window_key:string;owner_digest:string;native_dependency:string;state:'building'|'complete'|'dirty'}>()).results;
 if(!rows.length)return;
 const requests:AnalyticsWorkRequest[]=[];
 const candidates:{windowKey:string;headKey:string;inputRevision:string;ownerDigest:string;newWorkKey:string|null}[]=[];
 for(const row of rows){
  const headKey=await digest(['rolling-window',input.sourceId,row.window_key]);
  if(row.state!=='dirty')requests.push({sourceId:input.sourceId,ownerDigest:row.owner_digest,stage:'fits',lane:'history',
   partitionKey:'rolling-window/'+row.window_key,headKey,inputRevision:row.native_dependency,policyRevision,
   day:null,stream:null,selectionMethod:'legacy-selected-v1',residentBytes:8*1024*1024,admissionQueries:300});
  candidates.push({windowKey:row.window_key,headKey,inputRevision:row.native_dependency,
   ownerDigest:row.owner_digest,newWorkKey:null});
 }
 // Work keys are calculated from reviewed immutable request fields. The
 // returned keys alone are not proof of insert; the UPDATE below re-reads the
 // exact v2 row after this durable batch.
 const workKeys=requests.length?await admitAnalyticsPartitionWork(target,requests,nowMs):[];
 let index=0;
 for(let offset=0;offset<candidates.length;offset++)if(rows[offset]!.state!=='dirty')
  candidates[offset]!.newWorkKey=workKeys[index++]!;
 await target.prepare(`UPDATE analytics_partition_work SET state='refused',reason_code='obsolete_input',
  revision=revision+1,claim_token=NULL,claim_expires_ms=0,updated_ms=?
 WHERE work_key IN(SELECT old.work_key FROM json_each(?) candidate
  CROSS JOIN analytics_canonical_rolling_windows r
  CROSS JOIN analytics_partition_work old INDEXED BY analytics_partition_work_producer
  WHERE r.window_key=json_extract(candidate.value,'$.windowKey') AND r.source_id=?
   AND r.kind IN('legacy-scalar','legacy-model') AND r.owner_digest=json_extract(candidate.value,'$.ownerDigest')
   AND r.native_dependency=json_extract(candidate.value,'$.inputRevision')
   AND old.source_id=r.source_id AND old.stage='fits' AND old.input_revision=r.native_dependency
   AND old.partition_key='rolling-window/'||r.window_key AND old.owner_digest=r.owner_digest
   AND old.head_key=json_extract(candidate.value,'$.headKey') AND old.policy_revision=?
   AND (old.state='ready' AND old.ready_ms<=? OR old.state='leased' AND old.claim_expires_ms<=?)
   AND (r.state='dirty' OR r.state IN('building','complete') AND EXISTS(
    SELECT 1 FROM analytics_partition_work next WHERE next.work_key=json_extract(candidate.value,'$.newWorkKey')
     AND next.source_id=old.source_id AND next.stage=old.stage AND next.partition_key=old.partition_key
     AND next.owner_digest=old.owner_digest AND next.head_key=old.head_key
     AND next.input_revision=old.input_revision AND next.policy_revision=?
     AND next.state IN('ready','leased','complete')))
 ) AND (state='ready' AND ready_ms<=? OR state='leased' AND claim_expires_ms<=?)`)
  .bind(nowMs,JSON.stringify(candidates),input.sourceId,oldPolicy,nowMs,nowMs,policyRevision,nowMs,nowMs).run();
}
export async function runCanonicalAnalyticsWorkPass(input:CanonicalAnalyticsWorkPassInput):Promise<CanonicalAnalyticsWorkPassProgress> {
 const degree=input.degree??1,maxWaves=input.maxWaves??4;
 if(![1,2,4,8].includes(degree)||!Number.isSafeInteger(maxWaves)||maxWaves<1||maxWaves>16
  ||!Number.isFinite(input.deadlineMs))throw new Error('CANONICAL_ANALYTICS_RUNTIME_INVALID');
 const start=input.invocation.queriesUsed,source=input.invocation.wrap(input.source),target=input.invocation.wrap(input.target);
 const counts={claimed:0,admitted:0,complete:0,deferred:0,refused:0,failed:0,releaseDeferred:0};
 let effects:AnalyticsWorkEffectsProgress|undefined,coverage:EffectiveDependencyCoverageProgress|undefined;
 let publicationSuppressed=false,claimsPending=false;
 let retirement:CanonicalAnalyticsWorkPassProgress['retirement'];
 const done=(state:CanonicalAnalyticsWorkPassProgress['state'],reason:string):CanonicalAnalyticsWorkPassProgress=>
  ({state,reason,...counts,statements:input.invocation.queriesUsed-start,...(effects?{effects}:{}),...(coverage?{coverage}:{}),...(retirement?{retirement}:{})});
 if(input.invocation.remainingQueries<180||input.now()>=input.deadlineMs-2000)return done('deferred','query_budget');
 try {
  await requireAuthorityRestoreServingReady(source);
  if(!await analyticsPartitionWorkAvailable(target))return done('unavailable','migration_required');
  // A partial source migration cannot activate target cleanup bookkeeping.
  // Coverage also verifies this capability; check it before any bridge write.
  if(input.bridge!==false&&!await effectiveSelectiveSchemaAvailable(source))
   return done('unavailable','source_migration_required');
  // Due lifecycle work gets its bounded turn before coverage or consumer waves
  // can consume the budget. The store paces empty sweeps and protects current
  // heads, descendants and active leases; productive pages stay discoverable.
  if(input.bridge!==false&&input.invocation.remainingQueries>=140&&input.now()<input.deadlineMs-3000)
   retirement=await advanceAnalyticsWorkRetirement({target,sourceId:input.sourceId,meter:input.invocation,now:input.now,
    deadlineMs:input.deadlineMs,completedBeforeMs:Math.max(0,input.now()-86400000)});
  // Ready populations reserve room for an existing heavy consumer step. This
  // bounded stage-count lookup is a scheduling hint, never source readiness.
  // Source pages retain their own meter and every consumer keeps its full proof.
  const readyConsumer=input.bridge!==false&&await target.prepare(`SELECT 1 ready
   FROM analytics_partition_work_counts WHERE source_id=? AND state='ready' AND jobs>0
   AND stage IN(SELECT value FROM json_each(?)) LIMIT 1`)
   .bind(input.sourceId,JSON.stringify(input.stages??NON_PUBLICATION_STAGES)).first<number>('ready')===1;
  const consumerReserve=readyConsumer?700:160;
  // Bootstrap is real producer work. Admit it before consumer claims, with
  // enough space for bounded native coverage pages. A cold catalog must not
  // turn every invocation into repeated unsupported acquisition attempts.
  if(input.bridge!==false&&input.invocation.remainingQueries>=250
    &&input.invocation.remainingQueries-consumerReserve>=60){
   const coverageMeter=createD1InvocationBudget(Math.min(450,input.invocation.remainingQueries-consumerReserve));
   coverage=await advanceEffectiveDependencyCoverage(source,{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,
    maxSteps:16,maxRows:128,budget:coverageMeter});
   if(coverage.status==='unavailable')return done('unavailable','source_migration_required');
   // Pending bootstrap/drain for another owner is not a global claim barrier.
   // Scoped source proofs still refuse this owner's incomplete evidence; the
   // separate publication closure retains its global completeness requirement.
  }
  // Coverage/effects get a bounded turn. Consumer work gets the rest; source
  // admission is recoverable independently of a queued consumer's readiness.
  if(input.bridge!==false&&input.invocation.remainingQueries>=250
    &&input.invocation.remainingQueries-consumerReserve>=36){
   const meter=createD1InvocationBudget(Math.min(180,input.invocation.remainingQueries-consumerReserve));
   effects=await advanceAnalyticsWorkEffects({source,target,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,
    meter,now:input.now,deadlineMs:input.deadlineMs,maxEffects:4,maxDays:2});
   if(effects.state==='unavailable')return done('unavailable','effects_migration_required');
  }
  const policyRevision=await maintainedAnalyticsPolicyRevision();
  if(input.bridge!==false&&input.invocation.remainingQueries>=180&&(!input.stages||input.stages.includes('features')))
   await admitMaintainedAnalyticsPolicyWork({target,sourceId:input.sourceId,policyRevision,nowMs:input.now()});
  if(input.invocation.remainingQueries>=180){
   await admitMaintainedGraphPublications({target,sourceId:input.sourceId,policyRevision,nowMs:input.now(),stages:input.stages});
   if((!input.stages||input.stages.includes('publication'))&&await canonicalPublicationAvailable(target)&&await canonicalCacheAvailable(target))
    await admitCanonicalCachePublicationRefresh({source,target,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,
     policyRevision,nowMs:input.now()});
  }
  if(input.invocation.remainingQueries>=180)await admitMaintainedGraphComputations({target,sourceId:input.sourceId,
   policyRevision,nowMs:input.now(),stages:input.stages});
  await admitRollingRequests(input,source,target);
  const executeWork=async(lease:AnalyticsWorkLease,budget:AnalyticsWorkExecutionBudget):Promise<AnalyticsWorkOutcome>=>{
     const shared={target,sources:[{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,database:source}],lease,budget};
     let outcome:'complete'|'deferred'|'refused',reason:string;
     if(lease.stage!=='canonical'&&await closeObsoleteAnalyticsManifestWork(budget.meter.wrap(target),lease,input.now()))return 'refused';
     if(lease.stage==='canonical'||lease.stage==='features')({outcome,reason}=await advanceAnalyticsCanonicalWork(shared));
     else if(lease.stage==='cache')({outcome,reason}=await advanceAnalyticsCacheWork(shared));
     else if(lease.stage==='activity'||lease.stage==='publication')({outcome,reason}=await advanceAnalyticsPublicationWork({
      ...shared,canonicalPreparation:createCanonicalSharedFeaturePreparation}));
     else if(lease.stage==='fits'){
      const work=await readAnalyticsPartitionWork(budget.meter.wrap(target),lease,input.now());
      const graph=work&&/^graph\/(fits|model)\/([a-f0-9]{64})$/u.exec(work.partitionKey);
      const key=work&&/^rolling-window\/([a-f0-9]{64})$/u.exec(work.partitionKey)?.[1];
      const owner=work?.ownerDigest?await readStorageCommunityOwner(budget.meter.wrap(source),{ownerDigest:work.ownerDigest}):null;
      if(graph&&work&&!await maintainedGraphWorkIsCurrent(budget.meter.wrap(target),work,input.now())){
       outcome='deferred';reason='graph_demand_pending';
      }else if(graph&&owner?.ownerDigest&&work?.day){
       const remaining=()=>Math.max(0,budget.remainingQueries()-8);
       const computed=await advanceStorageCommunityGraphWork({source:budget.meter.wrap(source),target:budget.meter.wrap(target),
        sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,nowMs:budget.now(),deadlineMs:budget.deadlineMs,
        get remainingQueries(){return remaining();},admissionQueries:50,canonicalPipeline:true,sharedFeatures:true,modelBlocks:input.modelBlocks===true,
        request:{ownerDigest:owner.ownerDigest,metric:graph[1] as 'fits'|'model',day:work.day},
        assertCurrent:async()=>{
         if(!await maintainedGraphWorkIsCurrent(budget.meter.wrap(target),work,input.now()))
          throw new StorageGraphOperationError('graph_work','source_changed');
        }});
       outcome=computed.state==='complete'||computed.state==='reused'?'complete':'deferred';reason=computed.reason??'graph_pending';
       if(outcome==='complete'&&!await completeAnalyticsPartitionWork(target,lease,[],input.now())){outcome='deferred';reason='lease_changed';}
      }else if(!key||!owner?.ownerDigest){outcome='deferred';reason='rolling_scope_pending';}
      else {
       const prepared=await executeCanonicalV1WindowRequest({source:budget.meter.wrap(source),target:budget.meter.wrap(target),
        sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,ownerDigest:owner.ownerDigest,participantId:owner.participantId,
        windowKey:key,maxQueries:Math.max(1,budget.remainingQueries()-8),deadlineMs:budget.deadlineMs,now:budget.now});
       outcome=prepared.state;reason=prepared.reason??(prepared.state==='complete'?'rolling_prepared':'rolling_pending');
       if(outcome==='complete'&&!await completeAnalyticsPartitionWork(target,lease,[],input.now())){outcome='deferred';reason='lease_changed';}
      }
     }else {outcome='refused';reason='unsupported_work_stage';}
     if(input.invocation.remainingQueries>2)await recordAnalyticsPartitionWorkReason(target,lease,
       /^[a-z_]{1,64}$/u.test(reason)?reason:'producer_deferred',input.now());
     return outcome;
  };
  // A fresh negative scheduling hint lasts for this invocation only. It can
  // defer already source-proven ready leaves; it never admits or completes work.
  // Unknown/pre-0048 schema and newly unprepared leaves keep ordinary claims.
  const cacheRepairBlocked=(!input.stages||input.stages.includes('cache'))
   &&await canonicalCacheRepairPageBlocked({target,budget:{remainingQueries:()=>input.invocation.remainingQueries,
    now:input.now,deadlineMs:input.deadlineMs}});
  for(let wave=0;wave<maxWaves&&input.invocation.remainingQueries>=180&&input.now()<input.deadlineMs-2000;wave++){
   let claimStages=input.stages;
   if((!claimStages||claimStages.includes('publication'))
     &&!await readAnalyticsWorkTargetSettled({target,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace})){
    publicationSuppressed=true;
    claimStages=claimStages?claimStages.filter(stage=>stage!=='publication'):NON_PUBLICATION_STAGES;
    if(!claimStages.length)break;
   }
   // Select the first head through the ordinary fair scheduler. A group can
   // share preparation for that homogeneous stage; it never jumps ahead of a
   // canonical, withdrawal or other-stage turn selected by the existing policy.
   // Reserve the actual claim cursor, each possible named bookkeeping write
   // and the dispatcher's release allowance before assigning a fairness turn.
   // This per-job ceiling fixes the default singleton path; multi-claim waves
   // retain the dispatcher's cumulative admission and group compute guards.
   const maxAdmissionQueries=Math.max(0,Math.min(900,input.invocation.remainingQueries-(1+5*degree)));
   const first=await claimAnalyticsPartitionWork(target,{sourceId:input.sourceId,limit:degree,nowMs:input.now(),maxAdmissionQueries,
    ...(claimStages?{stages:claimStages}:{}),...(cacheRepairBlocked?{cacheRepairBlocked:true}:{})});
   if(!first.length){
    // Budget-ineligible or currently held work is still pending. The compact
    // counters report it without inventing a claim or a producer admission.
    claimsPending=await target.prepare(`SELECT 1 pending FROM analytics_partition_work_counts
     WHERE source_id=? AND state IN('ready','leased') AND jobs>0
     AND stage IN(SELECT value FROM json_each(?)) LIMIT 1`)
     .bind(input.sourceId,JSON.stringify(claimStages??NON_PUBLICATION_STAGES)).first<number>('pending')===1;
    break;
   }
   const release=async(lease:AnalyticsWorkLease,outcome:AnalyticsWorkOutcome|'failure'|'not_admitted')=>{
    await releaseAnalyticsPartitionWork(target,lease,outcome,input.now());
   };
   const groupStage=first[0]?.stage==='features'?'features':first[0]?.stage==='activity'?'activity':first[0]?.stage==='cache'?'cache':undefined;
   const heavyGroup=groupStage==='activity'||groupStage==='cache';
   const previewGroup=groupStage==='cache'?previewAnalyticsCacheGroup:groupStage==='activity'?previewAnalyticsActivityGroup:previewAnalyticsFeatureGroup;
   const preview=degree===1&&groupStage&&input.invocation.remainingQueries>=(heavyGroup?911:740)
    ?await previewGroup
     ({target,first:first[0]!,sourceId:input.sourceId,nowMs:input.now(),maxAdmissionQueries,
      ...(claimStages?{stages:claimStages}:{}),...(cacheRepairBlocked?{cacheRepairBlocked:true}:{})}):undefined;
   const groupDispatcher=groupStage==='cache'?dispatchAnalyticsCacheGroup:groupStage==='activity'?dispatchAnalyticsActivityGroup:dispatchAnalyticsFeatureGroup;
   // Activity and cache groups are qualified for eight one-fact leaves. The
   // cache preview also requires one exact scope. Dense, mixed and retried
   // prefixes retain the ordinary fair singleton path.
   const groupEligible=preview?.state==='eligible'&&(!heavyGroup||preview.facts===8);
   const progress=groupEligible&&preview?.state==='eligible'&&input.invocation.remainingQueries>=(heavyGroup?886:700)
    ?await groupDispatcher({invocation:input.invocation,deadlineMs:input.deadlineMs,now:input.now,
     claim:async limit=>[...first,...await claimAnalyticsPartitionWork(target,{sourceId:input.sourceId,limit:limit-1,
      nowMs:input.now(),maxAdmissionQueries,...(claimStages?{stages:claimStages}:{}),...(cacheRepairBlocked?{cacheRepairBlocked:true}:{}),expectedWorkKeys:preview.workKeys.slice(1)})],release,
     async execute(leases,budget){
      // The preview is a performance hint, not a claim. A concurrent queue
      // change must not turn a different fair prefix into an assumed group.
      if(leases.length!==preview.workKeys.length||leases.some((lease,index)=>lease.workKey!==preview.workKeys[index])){
       const original=leases.find(lease=>lease.workKey===first[0]?.workKey);
       const admitted=!!original&&budget.remainingQueries()>=original.admissionQueries&&input.now()<budget.deadlineMs-2000;
       const outcome=admitted?await executeWork(original!,budget):'deferred';
       return leases.map(lease=>({workKey:lease.workKey,outcome:lease===original?outcome:'deferred' as const,
        admitted:lease===original&&admitted}));
      }
      const grouped=await (groupStage==='cache'?advanceAnalyticsCacheGroup:groupStage==='activity'?advanceAnalyticsActivityGroup:advanceAnalyticsFeatureGroup)
       ({target,sources:[{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,database:source}],leases,budget});
      const outcomes=[...grouped.members];
      // A hot/incompatible singleton remains on the same original lease and
      // actual meter. Its existing split path must remain able to progress.
      if(grouped.fallbackRequired||!outcomes.some(member=>member.admitted)){
       const fallback=leases.find(lease=>grouped.fallbackWorkKeys.includes(lease.workKey));
       if(fallback&&budget.remainingQueries()>=fallback.admissionQueries
        &&input.now()<budget.deadlineMs-2000){
        const outcome=await executeWork(fallback,budget);
        const index=outcomes.findIndex(member=>member.workKey===fallback.workKey);
        if(index>=0)outcomes[index]={...outcomes[index]!,outcome,admitted:true};
       }
      }
      for(const member of outcomes)if(member.admitted&&!member.completedWithinLease&&budget.remainingQueries()>2){
       const lease=leases.find(value=>value.workKey===member.workKey)!;
       await recordAnalyticsPartitionWorkReason(budget.meter.wrap(target),lease,
        /^[a-z_]{1,64}$/u.test(member.reason)?member.reason:'producer_deferred',input.now());
      }
      return outcomes;
     }})
    :await dispatchAnalyticsWork({degree,maxResidentBytes:32*1024*1024,invocation:input.invocation,
     deadlineMs:input.deadlineMs,now:input.now,releaseQueries:2,claim:async()=>first,execute:executeWork,release});
   // The fair first claim is already durable. A deadline can cross during
   // that SQL call before the dispatcher accepts it; release those exact
   // leases here rather than leaving an unreported live head until expiry.
   if(progress.claimed===0&&first.length){
    counts.claimed+=first.length;counts.deferred+=first.length;
    for(const lease of first)try{await release(lease,'not_admitted');}catch{counts.releaseDeferred++;}
    break;
   }
   for(const key of Object.keys(counts) as (keyof typeof counts)[])counts[key]+=progress[key];
   if(progress.claimed===0)break;
   // Not enough room for the job's full step: stop claiming the same ready
   // head in this invocation; the next scheduled opportunity has a fresh meter.
   if(progress.admitted===0)break;
  }
  if(publicationSuppressed){
   const pending=await target.prepare(`SELECT 1 pending FROM analytics_partition_work_counts WHERE source_id=?
    AND stage='publication' AND state IN('ready','leased') AND jobs>0 LIMIT 1`).bind(input.sourceId).first<number>('pending');
   publicationSuppressed=pending===1;
  }
  return done(counts.complete||(coverage?.steps??0)>0||effects?.state==='progress'||retirement?.state==='progress'?'progress':
   counts.deferred||counts.failed||publicationSuppressed||claimsPending?'deferred':'idle',
   counts.failed?'execution_failed':counts.deferred||claimsPending?'work_pending':publicationSuppressed?'source_prefix_pending':
    coverage&&coverage.status!=='complete'?'coverage_pending':'complete');
 }catch(error){
  if(error instanceof D1InvocationBudgetExceededError)return done('deferred','query_budget');
  if(/analytics_work_capacity/u.test(String(error)))return done('deferred','capacity');
  throw error;
 }
}
