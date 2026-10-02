import {selectAnalyticsFeatureGroup,type AnalyticsFeatureGroupEstimate,type AnalyticsFeatureGroupMemberOutcome,
 type AnalyticsWorkExecutionBudget,type AnalyticsWorkLease} from './analytics-partition-work';
import {readAnalyticsPartitionWork,completeAnalyticsPartitionWork,analyticsWorkKey,
 type AnalyticsStoredWork,type AnalyticsWorkRequest} from './storage-analytics-partition-work';
import {closeObsoleteAnalyticsManifestWork} from './storage-analytics-maintained-work';
import {materializeCanonicalPartition,type CanonicalPartitionManifest} from './storage-canonical-analytics-facts';
import {materializeCanonicalFeaturePartitionGroup,type CanonicalFeaturePartitionMetrics} from './storage-canonical-feature-contributions';
import {captureAnalyticsManifestGroupProof,type AnalyticsManifestGroupProofInput} from './storage-analytics-work-proof';
import type {AnalyticsCanonicalSource} from './storage-analytics-work-contract';
import {CACHE_RETENTION_METHOD} from './cache-retention-values';
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {D1InvocationBudgetExceededError} from './d1-invocation-budget';

export interface AnalyticsFeatureGroupInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];
 readonly leases:readonly AnalyticsWorkLease[];readonly budget:AnalyticsWorkExecutionBudget;
 readonly captureGroupProof?:typeof captureAnalyticsManifestGroupProof;
}
export interface AnalyticsFeatureGroupMemberResult extends AnalyticsFeatureGroupMemberOutcome {
 readonly admitted:boolean;readonly reason:string;readonly completedWithinLease:boolean;
}
export interface AnalyticsFeatureGroupResult {
 readonly members:readonly AnalyticsFeatureGroupMemberResult[];
 /** Root may execute one excluded hot/incompatible singleton through the
  * existing producer under the same meter before releasing these claims. */
 readonly fallbackWorkKeys:readonly string[];
 readonly fallbackRequired:boolean;
 readonly selectedWorkKeys:readonly string[];readonly facts:number;readonly scopes:number;
 readonly residentBytes:number;readonly statements:number;readonly metrics?:CanonicalFeaturePartitionMetrics;
}
type Member=AnalyticsManifestGroupProofInput['members'][number];
interface Metadata {revision:string;occurrence_key:string;provenance_digest:string;erasure_key:string;
 source_id:string;owner_digest:string;observed_day:string|null;stream:string;selection_method:string}
const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u;
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
const request=(work:AnalyticsStoredWork):AnalyticsWorkRequest=>{const {workKey:_key,attempts:_attempts,...value}=work;return value;};

async function partition(target:D1Database,key:string):Promise<{manifest:CanonicalPartitionManifest;metadata:readonly Metadata[]}|null> {
 const parsed=match.exec(key)!;const root=key.slice(0,-parsed[4]!.length)+parsed[4]!.slice(0,2);
 const current=await target.prepare(`SELECT m.content_revision,m.content_digest,m.generation,m.row_count,m.min_observed_ms,m.max_observed_ms
  FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
  WHERE h.partition_key=? AND m.state='complete' AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?),0)`)
  .bind(key,root).first<{content_revision:string;content_digest:string;generation:number;row_count:number;min_observed_ms:number|null;max_observed_ms:number|null}>();
 let manifest:CanonicalPartitionManifest;
 if(current){
  if(current.row_count>16)return null;
  manifest={schema:'canonical-analytics-v1',partitionKey:key,contentRevision:current.content_revision,contentDigest:current.content_digest,
   generation:current.generation,rowCount:current.row_count,minObservedAtMs:current.min_observed_ms,maxObservedAtMs:current.max_observed_ms,rows:[]};
 }else{
  // Refuse hot discovery before hydrating its complete provenance. The owning
  // single producer remains responsible for the existing sixteen-way split.
  const hot=await target.prepare(`SELECT h.revision FROM analytics_canonical_heads h WHERE h.partition_key=?
   AND h.occurrence_key>=? AND h.occurrence_key<? LIMIT 17`).bind(root,parsed[4]!,parsed[4]!+'g').all();
  if(hot.results.length>16)return null;
  const created=await materializeCanonicalPartition(target,key);if(created.state!=='complete'||created.manifest.rowCount>16)return null;
  manifest=created.manifest;
 }
 const metadata=(await target.prepare(`SELECT f.revision,f.occurrence_key,f.provenance_digest,f.erasure_key,
  f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method FROM analytics_canonical_manifest_rows r
  JOIN analytics_canonical_facts f ON f.revision=r.revision WHERE r.content_revision=? ORDER BY r.ordinal LIMIT 17`)
  .bind(manifest.contentRevision).all<Metadata>()).results;
 if(metadata.length!==manifest.rowCount)return null;
 return {manifest:{...manifest,rows:metadata.map(row=>({occurrenceKey:row.occurrence_key,revision:row.revision,
  provenanceDigest:row.provenance_digest,erasureKey:row.erasure_key}))},metadata};
}
async function completedReceipt(target:D1Database,member:Member,successors:readonly AnalyticsWorkRequest[]):Promise<boolean> {
 const keys=await Promise.all(successors.map(analyticsWorkKey)),{lease,work,manifest}=member;
 return await target.prepare(`SELECT 1 complete FROM analytics_partition_work w
  JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key JOIN analytics_canonical_manifests m USING(content_revision)
  WHERE w.work_key=? AND w.state='complete' AND w.revision=? AND w.claim_token IS NULL AND w.claim_expires_ms=0
  AND w.head_key=? AND w.source_id=? AND w.input_revision=? AND w.policy_revision=? AND w.partition_key=? AND w.stage='features'
  AND w.day IS ? AND w.stream IS ? AND w.selection_method IS ? AND h.content_revision=? AND m.state='complete'
  AND m.generation=? AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
  AND (SELECT count(*) FROM analytics_partition_work_links WHERE parent_work_key=w.work_key)=?
  AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM analytics_partition_work_links l
    JOIN analytics_partition_work child ON child.work_key=l.child_work_key WHERE l.parent_work_key=w.work_key AND child.work_key=expected.value))`)
  .bind(work.workKey,lease.revision+1,work.headKey,work.sourceId,work.inputRevision,work.policyRevision,work.partitionKey,
   work.day,work.stream,work.selectionMethod,manifest.contentRevision,manifest.generation,keys.length,JSON.stringify(keys))
  .first<number>('complete')===1;
}
/** Real sparse feature production over original leaf claims. A group has one
 * bounded immutable value union, but every completion/successor remains an
 * independent durable leaf transaction. Publication, activity and cache group
 * execution are deliberately outside this first producer slice. */
export async function advanceAnalyticsFeatureGroup(input:AnalyticsFeatureGroupInput):Promise<AnalyticsFeatureGroupResult> {
 if(!input.leases.length||input.leases.length>8||new Set(input.leases.map(lease=>lease.workKey)).size!==input.leases.length)
  throw new Error('ANALYTICS_FEATURE_GROUP_INVALID');
 const started=input.budget.meter.queriesUsed,target=input.budget.meter.wrap(input.target),now=input.budget.now;
 const members=new Map<string,AnalyticsFeatureGroupMemberResult>(input.leases.map(lease=>[lease.workKey,
  {workKey:lease.workKey,outcome:'deferred',admitted:false,reason:'group_excluded',completedWithinLease:false}]));
 const fallback:string[]=[],candidates:Member[]=[],estimates:AnalyticsFeatureGroupEstimate[]=[];
 let selected:readonly string[]=[],facts=0,scopes=0,residentBytes=0,fallbackRequired=false,metrics:CanonicalFeaturePartitionMetrics|undefined;
 const done=():AnalyticsFeatureGroupResult=>({members:input.leases.map(lease=>members.get(lease.workKey)!),fallbackWorkKeys:Object.freeze([...fallback]),
  fallbackRequired,selectedWorkKeys:selected,facts,scopes,residentBytes,statements:input.budget.meter.queriesUsed-started,...(metrics?{metrics}:{})});
 const available=(reserve=80)=>input.budget.remainingQueries()>=reserve&&now()<input.budget.deadlineMs-1500;
 let compatible:AnalyticsStoredWork|undefined;
 for(const lease of input.leases){
  if(!available())break;
  const work=await readAnalyticsPartitionWork(target,lease,now());if(!work){members.set(lease.workKey,{...members.get(lease.workKey)!,reason:'lease_changed'});continue;}
  // Attempts belong to the durable original leaf. A deferred/partial group
  // gets one grouping attempt; its next claimant uses the original producer.
  if(work.attempts!==1){fallback.push(lease.workKey);members.set(lease.workKey,{...members.get(lease.workKey)!,reason:'singleton_retry_required'});continue;}
  const identity=match.exec(work.partitionKey);
  if(work.stage!=='features'||!identity||work.selectionMethod!==identity[1]||work.stream!==identity[2]
    ||work.day!==(identity[3]==='unknown'?null:identity[3])){fallback.push(lease.workKey);continue;}
  if(await closeObsoleteAnalyticsManifestWork(target,lease,now())){
   members.set(lease.workKey,{workKey:lease.workKey,outcome:'refused',admitted:false,reason:'obsolete_input',completedWithinLease:true});continue;}
  if(compatible&&['sourceId','policyRevision','day','stream','selectionMethod'].some(key=>work[key as keyof AnalyticsStoredWork]!==compatible![key as keyof AnalyticsStoredWork])){
   fallback.push(lease.workKey);continue;}
  const parsed=match.exec(work.partitionKey)!,root=work.partitionKey.slice(0,-parsed[4]!.length)+parsed[4]!.slice(0,2);
  const pending=await target.prepare(`SELECT 1 pending FROM analytics_partition_canonical_effects q JOIN analytics_canonical_effects e USING(effect_key)
   LEFT JOIN analytics_canonical_facts old ON old.revision=e.old_revision LEFT JOIN analytics_canonical_facts new ON new.revision=e.new_revision
   WHERE q.state='pending' AND (old.partition_key=? OR new.partition_key=?) LIMIT 1`).bind(root,root).first<number>('pending');
  if(pending===1){members.set(lease.workKey,{...members.get(lease.workKey)!,reason:'canonical_effects_pending'});continue;}
  const prepared=await partition(target,work.partitionKey);
  if(!prepared){fallback.push(lease.workKey);members.set(lease.workKey,{...members.get(lease.workKey)!,reason:'partition_split_required'});continue;}
  const estimate:AnalyticsFeatureGroupEstimate={...work,refs:prepared.manifest.rows,
   scopeKeys:[...new Set(prepared.metadata.map(row=>canonicalJson([row.source_id,row.owner_digest,row.observed_day,row.stream,row.selection_method])))]};
  // Establish compatibility from the first individually eligible leaf, rather
  // than an oversized first claim that would otherwise starve the whole wave.
  const singleton=selectAnalyticsFeatureGroup([estimate]);if(!singleton.selected.length){fallback.push(lease.workKey);continue;}
  compatible??=work;candidates.push({lease,work,manifest:prepared.manifest});estimates.push(estimate);
 }
 const choice=selectAnalyticsFeatureGroup(estimates);({selected,facts,scopes,residentBytes}=choice);
 for(const key of choice.excluded)fallback.push(key);
 if(!selected.length)return done();
 const chosen=candidates.filter(member=>selected.includes(member.work.workKey));
 for(const key of selected)members.set(key,{...members.get(key)!,admitted:true,reason:'group_pending'});
 const proof=await (input.captureGroupProof??captureAnalyticsManifestGroupProof)({target:input.target,sources:input.sources,budget:input.budget,members:chosen});
 if(proof.state!=='complete'){for(const key of selected)members.set(key,{...members.get(key)!,outcome:'deferred',reason:proof.reason});return done();}
 try{
  const prepared=await materializeCanonicalFeaturePartitionGroup({target,manifests:chosen.map(member=>member.manifest),
   budget:input.budget,stillCurrent:proof.stillCurrent,canCommit:proof.canCommit});
  if(prepared.state!=='complete'){
   for(const key of selected)members.set(key,{...members.get(key)!,reason:prepared.reason});
   if(prepared.state==='refused'){fallback.push(...selected);fallbackRequired=true;}
   return done();
  }
  metrics=prepared.metrics;
  for(const member of chosen){
   const {lease,work,manifest}=member,memberProof=proof.forMember(work.workKey);
   if(!available(20)||!memberProof||!await memberProof.stillCurrent()){
    members.set(work.workKey,{...members.get(work.workKey)!,reason:'source_changed_or_budget'});continue;}
   const cacheCurrent=await target.prepare(`SELECT 1 current FROM analytics_canonical_cache_partitions WHERE partition_key=? AND content_revision=? AND method=?`)
    .bind(work.partitionKey,manifest.contentRevision,CACHE_RETENTION_METHOD.version).first<number>('current')===1;
   const successors:AnalyticsWorkRequest[]=[];
   for(const stage of (cacheCurrent?['activity']:['activity','cache']) as readonly ('activity'|'cache')[])successors.push({...request(work),ownerDigest:null,stage,
    headKey:await digest([stage,work.sourceId,work.partitionKey]),inputRevision:manifest.contentRevision,residentBytes:4*1024*1024,admissionQueries:160});
   let completed=false;
   try{completed=await completeAnalyticsPartitionWork(target,lease,successors,now());}
   catch(error){if(error instanceof D1InvocationBudgetExceededError)throw error;
    // An accepted write with a lost response is not a second admission. Only
    // the exact original lease and successor receipt can recover completion.
    if(!await completedReceipt(target,member,successors))throw error;
    completed=true;}
   if(!completed)completed=await completedReceipt(target,member,successors);
   const current=completed&&await proof.stillCurrent();
   members.set(work.workKey,{workKey:work.workKey,outcome:current?'complete':'deferred',admitted:true,
    reason:current?'features_prepared':completed?'source_changed':'lease_changed',completedWithinLease:completed});
  }
  return done();
 }finally{proof.close();}
}
