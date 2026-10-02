import type {AnalyticsCanonicalSource} from './storage-analytics-work-contract';
export type {AnalyticsCanonicalSource} from './storage-analytics-work-contract';
import { type AnalyticsWorkExecutionBudget,type AnalyticsWorkLease,type AnalyticsWorkOutcome } from './analytics-partition-work';
import { captureAnalyticsManifestWorkProof } from './storage-analytics-work-proof';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import {completeMaintainedCanonicalInput,closeObsoleteAnalyticsManifestWork} from './storage-analytics-maintained-work';
import { advanceCanonicalInputWork,createCanonicalInputReadContext,closeCanonicalInputReadContext,type CanonicalInputScope } from './storage-canonical-analytics-input';
import { materializeCanonicalPartition } from './storage-canonical-analytics-facts';
import { materializeCanonicalFeaturePartition,type CanonicalFeaturePartitionResult } from './storage-canonical-feature-contributions';
import { CACHE_RETENTION_METHOD } from './cache-retention-values';
import { readStorageCommunityOwner } from './storage-community-authority';
import { readAnalyticsPartitionWork,completeAnalyticsPartitionWork,type AnalyticsStoredWork,type AnalyticsWorkRequest } from './storage-analytics-partition-work';

export interface AnalyticsCanonicalWorkInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];
 readonly lease:AnalyticsWorkLease;readonly budget:AnalyticsWorkExecutionBudget;
}
export interface AnalyticsCanonicalWorkResult {
 readonly outcome:AnalyticsWorkOutcome;
 readonly reason:string;
 /** True when split or concrete downstream admission closed this lease in D1. */
 readonly completedWithinLease:boolean;
 readonly featurePartition?:Extract<CanonicalFeaturePartitionResult,{state:'complete'}>;
 readonly canonicalPages:number;
 readonly statements:number;
}
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
function asRequest(work:AnalyticsStoredWork):AnalyticsWorkRequest {
 const {workKey:_key,attempts:_attempts,...request}=work;return request;
}
/** Concrete P1 acquisition and P4 feature producers. Unimplemented consumers
 * remain deferred, and final publication always belongs to P7's closure. */
export async function advanceAnalyticsCanonicalWork(input:AnalyticsCanonicalWorkInput):Promise<AnalyticsCanonicalWorkResult> {
 const started=input.budget.meter.queriesUsed,target=input.budget.meter.wrap(input.target),now=input.budget.now;
 const sources=input.sources.map(source=>({...source,database:input.budget.meter.wrap(source.database)}));
 const result=(outcome:AnalyticsWorkOutcome,reason:string,completedWithinLease=false,canonicalPages=0,
  featurePartition?:Extract<CanonicalFeaturePartitionResult,{state:'complete'}>):AnalyticsCanonicalWorkResult=>
  ({outcome,reason,completedWithinLease,canonicalPages,statements:input.budget.meter.queriesUsed-started,...(featurePartition?{featurePartition}:{})});
 if(new Set(sources.map(source=>source.sourceId)).size!==sources.length||sources.length>16)throw new Error('ANALYTICS_WORK_SOURCE_INVALID');
 if(input.budget.remainingQueries()<40||now()>=input.budget.deadlineMs-1500)return result('deferred','query_budget');
 const work=await readAnalyticsPartitionWork(target,input.lease,now());if(!work)return result('deferred','lease_changed');
 const source=sources.find(source=>source.sourceId===work.sourceId);if(!source)return result('deferred','source_binding_unavailable');
 if(work.stage==='canonical') {
  if(!work.partitionKey.startsWith('input/')||!work.ownerDigest||!work.day||!work.stream||!work.selectionMethod)return result('refused','input_scope_invalid');
  const owner=await readStorageCommunityOwner(source.database,{ownerDigest:work.ownerDigest});
  if(!owner?.ownerDigest)return result('deferred','owner_unavailable');
  const scope:CanonicalInputScope={sourceId:work.sourceId,sourceNamespace:source.sourceNamespace,ownerDigest:owner.ownerDigest,
   participantId:owner.participantId,day:work.day,stream:work.stream,selectionMethod:work.selectionMethod};
  const context=await createCanonicalInputReadContext(source.database,target,[scope],input.budget.deadlineMs);
  if(!context)return result('deferred','canonical_context_pending');
  try {
   const progress=await advanceCanonicalInputWork(source.database,target,{...scope,context,
    budget:{meter:input.budget.meter,maxSteps:32,now,deadlineMs:input.budget.deadlineMs}});
   if(progress.state!=='complete'||!progress.seal)return result('deferred',progress.state,false,progress.pages);
   const closed=await completeMaintainedCanonicalInput({target,lease:input.lease,seal:progress.seal,nowMs:now()});
   return result(closed?'complete':'deferred',closed?'complete':'lease_changed',closed,progress.pages);
  }finally{closeCanonicalInputReadContext(context);}
 }
 if(work.stage!=='features')return result('deferred','producer_adapter_unavailable');
 if(await closeObsoleteAnalyticsManifestWork(target,input.lease,now()))return result('refused','obsolete_input',true);
 const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([0-9a-f]{2,64})$/u.exec(work.partitionKey);
 if(!match)return result('refused','partition_invalid');
 const root=work.partitionKey.slice(0,work.partitionKey.length-match[4]!.length+2);
 // Complete effect admission before constructing downstream references at this
 // generation, including pages committed before an earlier process was killed.
 const pending=await target.prepare(`SELECT 1 pending FROM analytics_partition_canonical_effects q
  JOIN analytics_canonical_effects e USING(effect_key) LEFT JOIN analytics_canonical_facts old ON old.revision=e.old_revision
  LEFT JOIN analytics_canonical_facts new ON new.revision=e.new_revision
  WHERE q.state='pending' AND (old.partition_key=? OR new.partition_key=?) LIMIT 1`).bind(root,root).first<number>('pending');
 if(pending===1)return result('deferred','canonical_effects_pending');
 const partition=await materializeCanonicalPartition(target,work.partitionKey);
 const split=async(keys:readonly string[])=>{
  const successors:AnalyticsWorkRequest[]=[];
  for(const key of keys)successors.push({...asRequest(work),partitionKey:key,ownerDigest:null,
   headKey:await digest(['features',work.sourceId,key])});
  const closed=await completeAnalyticsPartitionWork(target,input.lease,successors,now());
  return result(closed?'complete':'deferred',closed?'partition_split':'lease_changed',closed);
 };
 if(partition.state==='split')return split(partition.partitions);
 const scopes=(await target.prepare(`SELECT DISTINCT f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
  FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  WHERE r.content_revision=? LIMIT 5`).bind(partition.manifest.contentRevision)
  .all<{source_id:string;owner_digest:string;observed_day:string|null;stream:NonNullable<AnalyticsWorkRequest['stream']>;
   selection_method:NonNullable<AnalyticsWorkRequest['selectionMethod']>}>()).results;
 // Refine hot leaves for both CPU and exact source-proof cost. A source owner
 // remains eligibility metadata, never a new job hierarchy or work boundary.
 if(partition.manifest.rowCount>16||scopes.length>4) {
  if(match[4]!.length===64)return result('refused','partition_capacity');
  return split('0123456789abcdef'.split('').map(suffix=>work.partitionKey+suffix));
 }
 const proof=await captureAnalyticsManifestWorkProof({...input,target,sources,work,manifest:partition.manifest});
 if(proof.state!=='complete')return result(proof.state,proof.reason);
 try {
 const stillCurrent=proof.stillCurrent;
 const features=await materializeCanonicalFeaturePartition({target,partitionKey:work.partitionKey,
  budget:{remainingQueries:input.budget.remainingQueries,now,deadlineMs:input.budget.deadlineMs},stillCurrent});
 if(features.state!=='complete')return result(features.state,features.reason);
 const successors:AnalyticsWorkRequest[]=[];
 const cacheCurrent=await target.prepare('SELECT 1 current FROM analytics_canonical_cache_partitions WHERE partition_key=? AND content_revision=? AND method=?')
  .bind(work.partitionKey,features.manifest.contentRevision,CACHE_RETENTION_METHOD.version).first<number>('current')===1;
 for(const stage of (cacheCurrent?['activity']:['activity','cache']) as readonly ('activity'|'cache')[])successors.push({...asRequest(work),ownerDigest:null,stage,
  headKey:await digest([stage,work.sourceId,work.partitionKey]),inputRevision:features.manifest.contentRevision,
  residentBytes:4*1024*1024,admissionQueries:160});
 const closed=await completeAnalyticsPartitionWork(target,input.lease,successors,now());
 return result(closed?'complete':'deferred',closed?'features_prepared':'lease_changed',closed,0,features);
 } finally {proof.close();}
}
