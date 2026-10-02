// Frozen pre-context implementation for the local proof acquisition comparison.
// Original source SHA256 d5f6f2b8a809cdb64fdb83a28ddcc339344cec63cc66d29157daa136e1f11846; not used by product code.
/** Shared source/target authority proof for concrete manifest consumers. */
import type { AnalyticsWorkExecutionBudget, AnalyticsWorkLease } from '../../src/analytics-partition-work';
import type { AnalyticsCanonicalSource } from '../../src/storage-analytics-work-contract';
import type { CanonicalPartitionManifest } from '../../src/storage-canonical-analytics-facts';
import { readAnalyticsPartitionWork, type AnalyticsStoredWork } from '../../src/storage-analytics-partition-work';
import { readStorageCommunityOwner, captureStorageCommunityAuthority,
  sameStorageCommunityAuthority, sameStorageCommunityCalculationAuthority } from '../../src/storage-community-authority';
import { readCanonicalInputSeal, type CanonicalInputScope, type CanonicalInputSeal } from '../../src/storage-canonical-analytics-input';

export interface AnalyticsManifestWorkProofInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];
 readonly lease:AnalyticsWorkLease;readonly work:AnalyticsStoredWork;readonly manifest:CanonicalPartitionManifest;
 readonly budget:AnalyticsWorkExecutionBudget;
}
export type AnalyticsManifestWorkProof=
 | {state:'complete';canCommit:()=>Promise<boolean>;stillCurrent:()=>Promise<boolean>}
 | {state:'deferred'|'refused';reason:string};
/** A cheap lease/head proof permits bounded private repair checkpoints. A full
 * source proof is required before and after output stage sealing/publication. */
export async function captureAnalyticsManifestWorkProofReference(input:AnalyticsManifestWorkProofInput):Promise<AnalyticsManifestWorkProof> {
 const target=input.budget.meter.wrap(input.target),sources=input.sources.map(source=>({...source,database:input.budget.meter.wrap(source.database)}));
 if(input.work.workKey!==input.lease.workKey||input.work.partitionKey!==input.manifest.partitionKey
   ||input.work.stage!=='features'&&input.work.inputRevision!==input.manifest.contentRevision)return {state:'deferred',reason:'manifest_changed'};
 const scopes=(await target.prepare(`SELECT DISTINCT f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
   FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
   WHERE r.content_revision=? LIMIT 5`).bind(input.manifest.contentRevision)
   .all<{source_id:string;owner_digest:string;observed_day:string|null;stream:NonNullable<AnalyticsStoredWork['stream']>;
     selection_method:NonNullable<AnalyticsStoredWork['selectionMethod']>}>()).results;
 if(scopes.length>4)return {state:'refused',reason:'scope_capacity'};
 const proofs:{binding:AnalyticsCanonicalSource;scope:CanonicalInputScope;seal:CanonicalInputSeal}[]=[];
 const authority=new Map<string,Awaited<ReturnType<typeof captureStorageCommunityAuthority>>>();
 for(const scope of scopes) {
  const binding=sources.find(source=>source.sourceId===scope.source_id);
  if(!binding||!scope.observed_day)return {state:'deferred',reason:'source_scope_unavailable'};
  const owner=await readStorageCommunityOwner(binding.database,{ownerDigest:scope.owner_digest});
  if(!owner)return {state:'deferred',reason:'owner_unavailable'};
  const identity:CanonicalInputScope={sourceId:binding.sourceId,sourceNamespace:binding.sourceNamespace,ownerDigest:scope.owner_digest,
    participantId:owner.participantId,day:scope.observed_day,stream:scope.stream,selectionMethod:scope.selection_method};
  const seal=await readCanonicalInputSeal(binding.database,target,identity);
  if(!seal)return {state:'deferred',reason:'canonical_input_unsealed'};
  proofs.push({binding,scope:identity,seal});
  if(!authority.has(binding.sourceId))authority.set(binding.sourceId,await captureStorageCommunityAuthority(binding.database,binding));
 }
 if(!authority.size) {
  const binding=sources.find(source=>source.sourceId===input.work.sourceId);
  if(!binding)return {state:'deferred',reason:'source_binding_unavailable'};
  authority.set(binding.sourceId,await captureStorageCommunityAuthority(binding.database,binding));
 }
 const canCommit=async()=>{
  if(!await readAnalyticsPartitionWork(target,input.lease,input.budget.now()))return false;
  return await target.prepare(`SELECT h.content_revision FROM analytics_canonical_partition_heads h
    JOIN analytics_canonical_manifests m USING(content_revision) WHERE h.partition_key=? AND m.generation=
      COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)`)
    .bind(input.work.partitionKey).first<string>('content_revision')===input.manifest.contentRevision;
 };
 const stillCurrent=async()=>{
  if(!await canCommit())return false;
  for(const [sourceId,pin] of authority) {
   const binding=sources.find(source=>source.sourceId===sourceId)!;
   const current=await captureStorageCommunityAuthority(binding.database,binding);
   if(proofs.length?!sameStorageCommunityCalculationAuthority(pin,current):!sameStorageCommunityAuthority(pin,current,true))return false;
  }
  for(const proof of proofs) {
   const seal=await readCanonicalInputSeal(proof.binding.database,target,proof.scope);
   if(!seal||seal.sourceStamp!==proof.seal.sourceStamp||seal.scopeKey!==proof.seal.scopeKey)return false;
  }
  return true;
 };
 return {state:'complete',canCommit,stillCurrent};
}
