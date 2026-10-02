/** Shared source/target authority proof for concrete manifest consumers. */
import type { AnalyticsWorkExecutionBudget, AnalyticsWorkLease } from './analytics-partition-work';
import type { AnalyticsCanonicalSource } from './storage-analytics-work-contract';
import type { CanonicalPartitionManifest } from './storage-canonical-analytics-facts';
import { readAnalyticsPartitionWork, type AnalyticsStoredWork } from './storage-analytics-partition-work';
import { readStorageCommunityOwner, captureStorageCommunityAuthority,
  sameStorageCommunityAuthority, sameStorageCommunityCalculationAuthority } from './storage-community-authority';
import { readCanonicalInputSeal, createCanonicalInputReadContext, closeCanonicalInputReadContext,
 type CanonicalInputReadContext, type CanonicalInputScope, type CanonicalInputSeal } from './storage-canonical-analytics-input';

export interface AnalyticsManifestWorkProofInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];
 readonly lease:AnalyticsWorkLease;readonly work:AnalyticsStoredWork;readonly manifest:CanonicalPartitionManifest;
 readonly budget:AnalyticsWorkExecutionBudget;
}
export type AnalyticsManifestWorkProof=
 | {state:'complete';canCommit:()=>Promise<boolean>;stillCurrent:()=>Promise<boolean>;close:()=>void;
    contextFor:(source:D1Database,target:D1Database,scope:CanonicalInputScope)=>CanonicalInputReadContext|null}
 | {state:'deferred'|'refused';reason:string};
/** A cheap lease/head proof permits bounded private repair checkpoints. A full
 * source proof is required before and after output stage sealing/publication. */
export async function captureAnalyticsManifestWorkProof(input:AnalyticsManifestWorkProofInput):Promise<AnalyticsManifestWorkProof> {
 const target=input.budget.meter.wrap(input.target),sources=input.sources.map(source=>({...source,database:input.budget.meter.wrap(source.database)}));
 if(input.work.workKey!==input.lease.workKey||input.work.partitionKey!==input.manifest.partitionKey
   ||input.work.stage!=='features'&&input.work.inputRevision!==input.manifest.contentRevision)return {state:'deferred',reason:'manifest_changed'};
 const scopes=(await target.prepare(`SELECT DISTINCT f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
   FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
   WHERE r.content_revision=? LIMIT 5`).bind(input.manifest.contentRevision)
   .all<{source_id:string;owner_digest:string;observed_day:string|null;stream:NonNullable<AnalyticsStoredWork['stream']>;
     selection_method:NonNullable<AnalyticsStoredWork['selectionMethod']>}>()).results;
 if(scopes.length>4)return {state:'refused',reason:'scope_capacity'};
 const canCommit=async()=>{
  if(!await readAnalyticsPartitionWork(target,input.lease,input.budget.now()))return false;
  return await target.prepare(`SELECT h.content_revision FROM analytics_canonical_partition_heads h
    JOIN analytics_canonical_manifests m USING(content_revision) WHERE h.partition_key=? AND m.generation=
      COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)`)
    .bind(input.work.partitionKey).first<string>('content_revision')===input.manifest.contentRevision;
 };
 return captureSourceProof({target,sources,budget:input.budget,scopes,emptySourceIds:scopes.length?[]:[input.work.sourceId],canCommit});
}

interface ManifestScopeRow {source_id:string;owner_digest:string;observed_day:string|null;
 stream:NonNullable<AnalyticsStoredWork['stream']>;selection_method:NonNullable<AnalyticsStoredWork['selectionMethod']>}
/** Contexts belong to this one bounded proof, including all exceptional exits. */
async function captureSourceProof(input:{target:D1Database;sources:readonly AnalyticsCanonicalSource[];
 budget:AnalyticsWorkExecutionBudget;scopes:readonly ManifestScopeRow[];emptySourceIds:readonly string[];
 canCommit:()=>Promise<boolean>}):Promise<AnalyticsManifestWorkProof> {
 const {target,sources}=input;
 const proofs:{binding:AnalyticsCanonicalSource;scope:CanonicalInputScope;seal:CanonicalInputSeal;context:CanonicalInputReadContext}[]=[];
 const groups:{binding:AnalyticsCanonicalSource;identity:string;scopes:CanonicalInputScope[];context?:CanonicalInputReadContext}[]=[];
 const identity=(scope:CanonicalInputScope)=>JSON.stringify([scope.sourceId,scope.sourceNamespace,scope.ownerDigest,scope.participantId,scope.selectionMethod]);
 let closed=false,handedOff=false;
 const close=()=>{if(closed)return;closed=true;for(const group of groups)if(group.context)closeCanonicalInputReadContext(group.context);};
 try {
 const authority=new Map<string,Awaited<ReturnType<typeof captureStorageCommunityAuthority>>>();
 for(const scope of input.scopes) {
  const binding=sources.find(source=>source.sourceId===scope.source_id);
  if(!binding||!scope.observed_day)return {state:'deferred',reason:'source_scope_unavailable'};
  const owner=await readStorageCommunityOwner(binding.database,{ownerDigest:scope.owner_digest});
  if(!owner)return {state:'deferred',reason:'owner_unavailable'};
  const identity:CanonicalInputScope={sourceId:binding.sourceId,sourceNamespace:binding.sourceNamespace,ownerDigest:scope.owner_digest,
    participantId:owner.participantId,day:scope.observed_day,stream:scope.stream,selectionMethod:scope.selection_method};
  const key=JSON.stringify([identity.sourceId,identity.sourceNamespace,identity.ownerDigest,identity.participantId,identity.selectionMethod]);
  let group=groups.find(value=>value.binding.database===binding.database&&value.identity===key);
  if(!group){group={binding,identity:key,scopes:[]};groups.push(group);}
  group.scopes.push(identity);
  if(!authority.has(binding.sourceId))authority.set(binding.sourceId,await captureStorageCommunityAuthority(binding.database,binding));
 }
 for(const group of groups) {
  const context=await createCanonicalInputReadContext(group.binding.database,target,group.scopes,
   Math.min(input.budget.deadlineMs,Date.now()+120_000));
  if(!context)return {state:'deferred',reason:'canonical_input_unsealed'};
  group.context=context;
  for(const scope of group.scopes) {
   const seal=await readCanonicalInputSeal(group.binding.database,target,scope,context);
   if(!seal)return {state:'deferred',reason:'canonical_input_unsealed'};
   proofs.push({binding:group.binding,scope,seal,context});
  }
 }
 for(const sourceId of input.emptySourceIds) {
  const binding=sources.find(source=>source.sourceId===sourceId);
  if(!binding)return {state:'deferred',reason:'source_binding_unavailable'};
  authority.set(binding.sourceId,await captureStorageCommunityAuthority(binding.database,binding));
 }
 const canCommit=async()=>!closed&&await input.canCommit();
 const stillCurrent=async()=>{
  if(!await canCommit())return false;
  for(const [sourceId,pin] of authority) {
   const binding=sources.find(source=>source.sourceId===sourceId)!;
   const current=await captureStorageCommunityAuthority(binding.database,binding);
   const matches=input.emptySourceIds.includes(sourceId)?sameStorageCommunityAuthority(pin,current,true)
    :sameStorageCommunityCalculationAuthority(pin,current);
   if(!matches)return false;
  }
  for(const proof of proofs) {
   const seal=await readCanonicalInputSeal(proof.binding.database,target,proof.scope,proof.context);
   if(!seal||seal.sourceStamp!==proof.seal.sourceStamp||seal.scopeKey!==proof.seal.scopeKey)return false;
  }
  return true;
 };
 const contextFor=(source:D1Database,expectedTarget:D1Database,scope:CanonicalInputScope):CanonicalInputReadContext|null=>{
  if(closed||expectedTarget!==target)return null;
  const group=groups.find(value=>value.binding.database===source&&value.identity===identity(scope)
   &&value.scopes.some(value=>value.day===scope.day&&value.stream===scope.stream));
  return group?.context??null;
 };
 handedOff=true;
 return {state:'complete',canCommit,stillCurrent,close,contextFor};
 } finally {if(!handedOff)close();}
}

export interface AnalyticsManifestGroupProofInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];readonly budget:AnalyticsWorkExecutionBudget;
 readonly members:readonly {readonly lease:AnalyticsWorkLease;readonly work:AnalyticsStoredWork;readonly manifest:CanonicalPartitionManifest}[];
}
export type AnalyticsManifestGroupProof=
 | {state:'complete';
    /** Joint target-only proof for bounded private preparation; never output sealing or leaf completion. */
    canCommit:()=>Promise<boolean>;stillCurrent:()=>Promise<boolean>;close:()=>void;
    contextFor:(source:D1Database,target:D1Database,scope:CanonicalInputScope)=>CanonicalInputReadContext|null;
    forMember:(workKey:string)=>{canCommit:()=>Promise<boolean>;stillCurrent:()=>Promise<boolean>}|null}
 | {state:'deferred'|'refused';reason:string};
/** A bounded homogeneous manifest group keeps every original lease receipt.
 * Only exact completed receipts may replace another member's live lease; the
 * member currently being adopted always needs its own original live lease. */
export async function captureAnalyticsManifestGroupProof(input:AnalyticsManifestGroupProofInput):Promise<AnalyticsManifestGroupProof> {
 if(input.members.length<1||input.members.length>8||new Set(input.members.map(value=>value.work.workKey)).size!==input.members.length
  ||new Set(input.members.map(value=>value.manifest.partitionKey)).size!==input.members.length)
  return {state:'refused',reason:'group_capacity'};
 const stage=input.members[0]!.work.stage;
 if(stage!=='features'&&stage!=='activity'&&stage!=='cache')return {state:'refused',reason:'group_stage_required'};
 for(const {lease,work,manifest} of input.members) {
  if(!Number.isSafeInteger(manifest.rowCount)||manifest.rowCount<0||manifest.rowCount>16||manifest.rows.length>16)
   return {state:'refused',reason:'group_capacity'};
  if(work.stage!==stage||lease.stage!==stage||work.workKey!==lease.workKey||work.headKey!==lease.headKey
   ||work.partitionKey!==manifest.partitionKey||manifest.rowCount!==manifest.rows.length
   ||stage!=='features'&&work.inputRevision!==manifest.contentRevision
   ||stage==='cache'&&work.stream!=='usage')
   return {state:'deferred',reason:'manifest_changed'};
 }
 const refs=input.members.flatMap(value=>value.manifest.rows);
 if(input.members.reduce((sum,value)=>sum+value.manifest.rowCount,0)>16
  ||new Set(refs.map(row=>row.revision)).size!==refs.length
  ||new Set(refs.map(row=>row.occurrenceKey)).size!==refs.length)return {state:'refused',reason:'group_capacity'};
 const target=input.budget.meter.wrap(input.target),sources=input.sources.map(source=>({...source,database:input.budget.meter.wrap(source.database)}));
 const members=input.members.map(({lease,work,manifest})=>({workKey:work.workKey,headKey:work.headKey,sourceId:work.sourceId,
  partitionKey:work.partitionKey,ownerDigest:work.ownerDigest,stage:work.stage,inputRevision:work.inputRevision,policyRevision:work.policyRevision,day:work.day,
  stream:work.stream,selectionMethod:work.selectionMethod,revision:lease.revision,claimToken:lease.claimToken,
  contentRevision:manifest.contentRevision,generation:manifest.generation,rowCount:manifest.rowCount}));
 const expiresMs=Math.min(input.budget.deadlineMs,Date.now()+120_000);
 const check=async(selected:typeof members,completed:boolean):Promise<boolean>=>{
  if(Date.now()>=expiresMs||input.budget.now()>=input.budget.deadlineMs)return false;
  const current=await target.prepare(`SELECT count(*) n FROM json_each(?1) expected
   JOIN analytics_partition_work w ON w.work_key=json_extract(expected.value,'$.workKey')
   JOIN analytics_canonical_partition_heads h ON h.partition_key=json_extract(expected.value,'$.partitionKey')
   JOIN analytics_canonical_manifests m ON m.content_revision=h.content_revision
   WHERE w.head_key=json_extract(expected.value,'$.headKey') AND w.source_id=json_extract(expected.value,'$.sourceId')
   AND w.partition_key=h.partition_key AND w.owner_digest IS json_extract(expected.value,'$.ownerDigest')
   AND w.stage=json_extract(expected.value,'$.stage')
   AND w.input_revision=json_extract(expected.value,'$.inputRevision') AND w.policy_revision=json_extract(expected.value,'$.policyRevision')
   AND w.day IS json_extract(expected.value,'$.day') AND w.stream IS json_extract(expected.value,'$.stream')
   AND w.selection_method IS json_extract(expected.value,'$.selectionMethod')
   AND h.content_revision=json_extract(expected.value,'$.contentRevision') AND m.state='complete'
   AND m.generation=json_extract(expected.value,'$.generation') AND m.row_count=json_extract(expected.value,'$.rowCount')
   AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
   AND ((w.state='leased' AND w.revision=json_extract(expected.value,'$.revision')
     AND w.claim_token=json_extract(expected.value,'$.claimToken') AND w.claim_expires_ms>?2)
    OR (?3=1 AND w.state='complete' AND w.revision=json_extract(expected.value,'$.revision')+1
     AND w.claim_token IS NULL AND w.claim_expires_ms=0))`).bind(JSON.stringify(selected),input.budget.now(),completed?1:0).first<number>('n');
  return current===selected.length&&Date.now()<expiresMs&&input.budget.now()<input.budget.deadlineMs;
 };
 // A group may only begin from the claimed members it was actually offered.
 if(!await check(members,false))return {state:'deferred',reason:'lease_changed'};
 const scopes=(await target.prepare(`SELECT DISTINCT f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
  FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  WHERE r.content_revision IN(SELECT value FROM json_each(?)) LIMIT 5`)
  .bind(JSON.stringify(members.map(value=>value.contentRevision))).all<ManifestScopeRow>()).results;
 if(scopes.length>(stage==='cache'?1:4))return {state:'refused',reason:'scope_capacity'};
 const proof=await captureSourceProof({target,sources,budget:input.budget,scopes,
  emptySourceIds:[...new Set(input.members.filter(value=>value.manifest.rowCount===0).map(value=>value.work.sourceId))],
  canCommit:()=>check(members,true)});
 if(proof.state!=='complete')return proof;
 let closed=false;
 const close=()=>{closed=true;proof.close();};
 return {state:'complete',canCommit:proof.canCommit,stillCurrent:proof.stillCurrent,contextFor:proof.contextFor,close,
  forMember:(workKey:string)=>{
   const member=members.find(value=>value.workKey===workKey);if(closed||!member)return null;
   const canCommit=async()=>!closed&&await check([member],false);
   return {canCommit,stillCurrent:async()=>await canCommit()&&await proof.stillCurrent()};
  }};
}
