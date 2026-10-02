import type {AnalyticsWorkExecutionBudget,AnalyticsWorkLease,AnalyticsWorkOutcome} from './analytics-partition-work';
import {readAnalyticsPartitionWork,completeAnalyticsPartitionWork,analyticsWorkKey,type AnalyticsStoredWork,type AnalyticsWorkRequest} from './storage-analytics-partition-work';
import {readCanonicalPartitionManifests,type CanonicalPartitionManifest} from './storage-canonical-analytics-facts';
import {captureAnalyticsManifestGroupProof} from './storage-analytics-work-proof';
import {materializeCanonicalFeaturePartitionGroup,type CanonicalFeaturePartitionMetrics} from './storage-canonical-feature-contributions';
import {canonicalPublicationAvailable,replaceCanonicalPublicationPart} from './storage-canonical-publication';
import {activityPublicationWorkSuccessor} from './storage-analytics-publication-work';
import {closeObsoleteAnalyticsManifestWork} from './storage-analytics-maintained-work';
import {readCanonicalInputMembership,type CanonicalInputScope} from './storage-canonical-analytics-input';
import {readStorageCanonicalSourceMembership} from './storage-community-daily-devices';
import {readStorageCommunityOwner} from './storage-community-authority';
import type {CanonicalActivityMembership} from './canonical-feature-contributions';
import type {AnalyticsCanonicalSource} from './storage-analytics-work-contract';
import {D1InvocationBudgetExceededError} from './d1-invocation-budget';

export interface AnalyticsActivityGroupInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];readonly leases:readonly AnalyticsWorkLease[];
 readonly budget:AnalyticsWorkExecutionBudget;readonly captureGroupProof?:typeof captureAnalyticsManifestGroupProof;
}
export interface AnalyticsActivityGroupMemberResult {
 readonly workKey:string;readonly outcome:AnalyticsWorkOutcome;readonly admitted:boolean;readonly reason:string;readonly completedWithinLease:boolean;
}
export interface AnalyticsActivityGroupResult {
 readonly members:readonly AnalyticsActivityGroupMemberResult[];readonly selectedWorkKeys:readonly string[];
 readonly fallbackWorkKeys:readonly string[];readonly fallbackRequired:boolean;
 readonly facts:number;readonly scopes:number;readonly residentBytes:number;readonly statements:number;readonly metrics?:CanonicalFeaturePartitionMetrics;
}
interface Member {lease:AnalyticsWorkLease;work:AnalyticsStoredWork;manifest:CanonicalPartitionManifest}
interface Receipt {member:Member;partRevision:string;previousRevision:string|null;child:AnalyticsWorkRequest;childWorkKey:string;completed:boolean}
const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{2,64})$/u;
/** One value/membership preparation, original serial part CAS and leaf receipts.
 * Caller admits850 computation plus2 releases/member under its
 * actual950 meter. Activity/publication identity and the public writer stay native. */
export async function advanceAnalyticsActivityGroup(input:AnalyticsActivityGroupInput):Promise<AnalyticsActivityGroupResult> {
 if(!input.leases.length||input.leases.length>8||new Set(input.leases.map(lease=>lease.workKey)).size!==input.leases.length)
  throw Error('ANALYTICS_ACTIVITY_GROUP_INVALID');
 const {budget}=input,started=budget.meter.queriesUsed,target=budget.meter.wrap(input.target),now=budget.now;
 const sources=input.sources.map(source=>({...source,database:budget.meter.wrap(source.database)}));
 const outcomes=new Map<string,AnalyticsActivityGroupMemberResult>(input.leases.map(lease=>[lease.workKey,
  {workKey:lease.workKey,outcome:'deferred',admitted:false,reason:'group_pending',completedWithinLease:false}]));
 let selected:readonly string[]=[],fallbackRequired=false,facts=0,scopes=0,residentBytes=0,metrics:CanonicalFeaturePartitionMetrics|undefined;
 const done=():AnalyticsActivityGroupResult=>({members:input.leases.map(lease=>outcomes.get(lease.workKey)!),selectedWorkKeys:selected,
  fallbackWorkKeys:fallbackRequired?input.leases.filter(lease=>!outcomes.get(lease.workKey)!.completedWithinLease).map(lease=>lease.workKey):[],
  fallbackRequired,facts,scopes,residentBytes,statements:budget.meter.queriesUsed-started,...(metrics?{metrics}:{})});
 const refuse=(reason:string,fallback=false)=>{for(const [key,value] of outcomes)if(!value.completedWithinLease)outcomes.set(key,{...value,reason});fallbackRequired=fallback;return done();};
 const available=(reserve=80)=>budget.remainingQueries()>=reserve&&now()<budget.deadlineMs-1500;
 if(!available())return refuse('query_budget');
 if(!await canonicalPublicationAvailable(target))return refuse('migration_required',true);
 const works:AnalyticsStoredWork[]=[];
 for(const lease of input.leases){
  const work=await readAnalyticsPartitionWork(target,lease,now());if(!work)return refuse('lease_changed');
  if(work.attempts!==1)return refuse('singleton_retry_required',true);
  const parsed=match.exec(work.partitionKey);
  if(work.stage!=='activity'||lease.stage!=='activity'||work.headKey!==lease.headKey||!parsed||work.day!==parsed[3]
   ||work.stream!==parsed[2]||work.selectionMethod!==parsed[1])return refuse('activity_group_incompatible',true);
  if(works[0]&&(['sourceId','policyRevision','day','stream','selectionMethod'] as const).some(key=>work[key]!==works[0]![key]))return refuse('activity_group_incompatible',true);
  if(!Number.isSafeInteger(work.residentBytes)||work.residentBytes<0||(residentBytes+=work.residentBytes)>32*1024*1024)return refuse('group_capacity',true);
  if(await closeObsoleteAnalyticsManifestWork(target,lease,now())){
   outcomes.set(work.workKey,{workKey:work.workKey,outcome:'refused',admitted:false,reason:'obsolete_input',completedWithinLease:true});
   return refuse('group_changed',true);
  }
  works.push(work);
 }
 if(works.some((work,index)=>works.some((other,otherIndex)=>index!==otherIndex&&work.partitionKey.startsWith(other.partitionKey)))
  ||new Set(works.map(work=>work.headKey)).size!==works.length)return refuse('group_capacity',true);
 const manifests=await readCanonicalPartitionManifests(target,works.map(work=>({partitionKey:work.partitionKey,contentRevision:work.inputRevision})));
 if(!manifests)return refuse('manifest_changed',true);
 facts=manifests.reduce((sum,manifest)=>sum+manifest.rowCount,0);
 const metadata=(await target.prepare(`SELECT f.revision,f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
  FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  WHERE r.content_revision IN(SELECT value FROM json_each(?)) ORDER BY r.content_revision,r.ordinal LIMIT 17`)
  .bind(JSON.stringify(manifests.map(manifest=>manifest.contentRevision))).all<{revision:string;source_id:string;owner_digest:string;
   observed_day:string;stream:NonNullable<AnalyticsStoredWork['stream']>;selection_method:NonNullable<AnalyticsStoredWork['selectionMethod']>}>()).results;
 if(metadata.length!==facts)return refuse('manifest_incomplete');
 const scopeKey=(row:typeof metadata[number])=>JSON.stringify([row.source_id,row.owner_digest,row.observed_day,row.stream,row.selection_method]);
 scopes=new Set(metadata.map(scopeKey)).size;if(scopes>4)return refuse('scope_capacity',true);
 if(metadata.some(row=>row.source_id!==works[0]!.sourceId||row.observed_day!==works[0]!.day||row.stream!==works[0]!.stream
  ||row.selection_method!==works[0]!.selectionMethod))return refuse('activity_group_incompatible',true);
 const members=works.map((work,index)=>({work,lease:input.leases[index]!,manifest:manifests[index]!}));
 const proof=await (input.captureGroupProof??captureAnalyticsManifestGroupProof)({target:input.target,sources:input.sources,budget,members});
 if(proof.state!=='complete')return refuse(proof.reason,proof.state==='refused');
 const receipts=new Map<string,Receipt>();
 const receiptCurrent=async(values:readonly Receipt[]):Promise<boolean>=>{
  if(!values.length)return true;
  const expected=values.map(({member:{work,lease,manifest},partRevision,previousRevision,childWorkKey,completed})=>({
   workKey:work.workKey,sourceId:work.sourceId,partitionKey:work.partitionKey,inputRevision:work.inputRevision,policyRevision:work.policyRevision,
   headKey:work.headKey,ownerDigest:work.ownerDigest,day:work.day,stream:work.stream,selectionMethod:work.selectionMethod,
   revision:lease.revision,contentRevision:manifest.contentRevision,partRevision,previousRevision,childWorkKey,completed:completed?1:0}));
  return await target.prepare(`SELECT count(*) n FROM json_each(?) e
   JOIN analytics_canonical_publication_part_heads h ON h.source_id=json_extract(e.value,'$.sourceId') AND h.partition_key=json_extract(e.value,'$.partitionKey')
   JOIN analytics_canonical_publication_parts p ON p.revision=h.revision
   JOIN analytics_partition_work w ON w.work_key=json_extract(e.value,'$.workKey')
   WHERE h.revision=json_extract(e.value,'$.partRevision') AND p.content_revision=json_extract(e.value,'$.contentRevision')
   AND EXISTS(SELECT 1 FROM analytics_canonical_publication_replacements r WHERE r.source_id=h.source_id AND r.partition_key=h.partition_key
    AND r.old_revision IS json_extract(e.value,'$.previousRevision') AND r.new_revision=h.revision)
   AND (json_extract(e.value,'$.completed')=0 OR(w.state='complete' AND w.revision=json_extract(e.value,'$.revision')+1
    AND w.claim_token IS NULL AND w.claim_expires_ms=0 AND w.stage='activity' AND w.source_id=json_extract(e.value,'$.sourceId')
    AND w.partition_key=json_extract(e.value,'$.partitionKey') AND w.head_key=json_extract(e.value,'$.headKey')
    AND w.owner_digest IS json_extract(e.value,'$.ownerDigest') AND w.input_revision=json_extract(e.value,'$.inputRevision')
    AND w.policy_revision=json_extract(e.value,'$.policyRevision') AND w.day IS json_extract(e.value,'$.day')
    AND w.stream IS json_extract(e.value,'$.stream') AND w.selection_method IS json_extract(e.value,'$.selectionMethod')
    AND (SELECT count(*) FROM analytics_partition_work_links WHERE parent_work_key=w.work_key)=1
    AND EXISTS(SELECT 1 FROM analytics_partition_work_links l JOIN analytics_partition_work c ON c.work_key=l.child_work_key
     WHERE l.parent_work_key=w.work_key AND c.work_key=json_extract(e.value,'$.childWorkKey'))))`)
   .bind(JSON.stringify(expected)).first<number>('n')===values.length;
 };
 const stillCurrent=async()=>await proof.stillCurrent()&&await receiptCurrent([...receipts.values()]);
 try{
  const memberships=new Map<string,CanonicalActivityMembership>(),byScope=new Map<string,CanonicalActivityMembership>();
  for(const row of metadata){
   let value=byScope.get(scopeKey(row));
   if(!value){
    if(!available(60))return refuse('query_budget');
    const binding=sources.find(source=>source.sourceId===row.source_id);if(!binding)return refuse('source_binding_unavailable');
    const owner=await readStorageCommunityOwner(binding.database,{ownerDigest:row.owner_digest});if(!owner)return refuse('owner_unavailable');
    const scope:CanonicalInputScope={sourceId:row.source_id,sourceNamespace:binding.sourceNamespace,ownerDigest:row.owner_digest,
     participantId:owner.participantId,day:row.observed_day,stream:row.stream,selectionMethod:row.selection_method};
    const context=proof.contextFor(binding.database,target,scope);if(!context)return refuse('source_scope_unavailable');
    const membership=await readCanonicalInputMembership(binding.database,target,scope,readStorageCanonicalSourceMembership,context);
    if(membership.state!=='complete'||membership.deviceKeys.length===0)return refuse('membership_unavailable');
    value={method:membership.method,dependencyRevision:membership.dependencyRevision,contributorKey:membership.contributorKey,deviceKeys:membership.deviceKeys};
    byScope.set(scopeKey(row),value);
   }
   memberships.set(row.revision,value);
  }
  selected=works.map(work=>work.workKey);for(const key of selected)outcomes.set(key,{...outcomes.get(key)!,admitted:true});
  const prepared=await materializeCanonicalFeaturePartitionGroup({target,manifests,budget,stillCurrent,canCommit:proof.canCommit,
   membership:async fact=>memberships.get(fact.revision)??null});
  if(prepared.state!=='complete')return refuse(prepared.reason,prepared.state==='refused');
  metrics=prepared.metrics;
  for(const member of members){
   const {work,lease}=member,memberProof=proof.forMember(work.workKey);
   const current=async()=>!!memberProof&&await memberProof.stillCurrent()&&await receiptCurrent([...receipts.values()]);
   if(!available(40)||!await current()){outcomes.set(work.workKey,{...outcomes.get(work.workKey)!,reason:'source_changed_or_budget'});continue;}
   if(!await canonicalPublicationAvailable(target))return refuse('migration_required');
   const previousRevision=await target.prepare('SELECT revision FROM analytics_canonical_publication_part_heads WHERE source_id=? AND partition_key=?')
    .bind(work.sourceId,work.partitionKey).first<string>('revision');
   const replaced=await replaceCanonicalPublicationPart(target,{sourceId:work.sourceId,feature:prepared.partitions.find(part=>part.manifest.partitionKey===work.partitionKey)!,
    expectedRevision:previousRevision,nowMs:now(),stillCurrent:current,lease});
   if(replaced.state!=='complete'){outcomes.set(work.workKey,{...outcomes.get(work.workKey)!,reason:replaced.reason});continue;}
   const child=await activityPublicationWorkSuccessor(work,replaced.part.revision);
   const receipt:Receipt={member,partRevision:replaced.part.revision,previousRevision,child,childWorkKey:await analyticsWorkKey(child),completed:false};
   receipts.set(work.workKey,receipt);let completed=false;
   try{completed=await completeAnalyticsPartitionWork(target,lease,[child],now());}
   catch(error){if(error instanceof D1InvocationBudgetExceededError)throw error;
    if(!await receiptCurrent([{...receipt,completed:true}]))throw error;completed=true;}
   if(!completed)completed=await receiptCurrent([{...receipt,completed:true}]);
   receipt.completed=completed;
   const fresh=completed&&await stillCurrent();
   outcomes.set(work.workKey,{workKey:work.workKey,outcome:fresh?'complete':'deferred',admitted:true,
    reason:fresh?'activity_replaced':completed?'source_changed':'lease_changed',completedWithinLease:completed});
  }
  return done();
 }finally{proof.close();}
}
