import {selectAnalyticsCacheGroup,type AnalyticsWorkExecutionBudget,type AnalyticsWorkLease,type AnalyticsWorkOutcome} from './analytics-partition-work';
import {canonicalJson} from './canonical-json';
import {CACHE_RETENTION_METHOD} from './cache-retention-values';
import {D1InvocationBudgetExceededError} from './d1-invocation-budget';
import {type CanonicalFact} from './canonical-analytics-facts';
import {readCanonicalFacts,readCanonicalPartitionManifests,type CanonicalPartitionManifest} from './storage-canonical-analytics-facts';
import {materializeCanonicalCachePartitionGroup,recordCanonicalCachePreparedReceipt,type CanonicalCacheMetrics} from './storage-canonical-cache-pairs';
import {captureAnalyticsManifestGroupProof} from './storage-analytics-work-proof';
import {readAnalyticsPartitionWork,completeAnalyticsPartitionWork,analyticsWorkKey,type AnalyticsStoredWork} from './storage-analytics-partition-work';
import {closeObsoleteAnalyticsManifestWork} from './storage-analytics-maintained-work';
import {cachePublicationWorkSuccessor} from './storage-analytics-cache-work';
import type {AnalyticsCanonicalSource} from './storage-analytics-work-contract';

export interface AnalyticsCacheGroupInput {
 readonly target:D1Database;readonly sources:readonly AnalyticsCanonicalSource[];readonly leases:readonly AnalyticsWorkLease[];
 readonly budget:AnalyticsWorkExecutionBudget;readonly captureGroupProof?:typeof captureAnalyticsManifestGroupProof;
}
export interface AnalyticsCacheGroupMemberResult {
 readonly workKey:string;readonly outcome:AnalyticsWorkOutcome;readonly admitted:boolean;readonly reason:string;readonly completedWithinLease:boolean;
}
export interface AnalyticsCacheGroupResult {
 readonly members:readonly AnalyticsCacheGroupMemberResult[];readonly selectedWorkKeys:readonly string[];
 readonly fallbackWorkKeys:readonly string[];readonly fallbackRequired:boolean;
 readonly facts:number;readonly scopes:number;readonly residentBytes:number;readonly statements:number;readonly metrics?:CanonicalCacheMetrics;
}
interface Member {lease:AnalyticsWorkLease;work:AnalyticsStoredWork;manifest:CanonicalPartitionManifest;facts:readonly CanonicalFact[]}
interface Receipt {member:Member;childWorkKey:string;completed:boolean}
const match=/^(effective-union-v1|legacy-selected-v1)\/(usage)\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{2,64})$/u;
/** Shared physical-slot preparation and one native bounded repair page. The
 * caller initially reserves850 computation plus2 releases/member under950;
 * runtime eligibility remains gated by actual qualification of that bound.
 * Every original leaf keeps its immutable input, live lease and successor. */
export async function advanceAnalyticsCacheGroup(input:AnalyticsCacheGroupInput):Promise<AnalyticsCacheGroupResult> {
 if(!input.leases.length||input.leases.length>8||new Set(input.leases.map(lease=>lease.workKey)).size!==input.leases.length)
  throw Error('ANALYTICS_CACHE_GROUP_INVALID');
 const {budget}=input,started=budget.meter.queriesUsed,target=budget.meter.wrap(input.target),now=budget.now;
 const outcomes=new Map<string,AnalyticsCacheGroupMemberResult>(input.leases.map(lease=>[lease.workKey,
  {workKey:lease.workKey,outcome:'deferred',admitted:false,reason:'group_pending',completedWithinLease:false}]));
 let selected:readonly string[]=[],fallbackRequired=false,facts=0,scopes=0,residentBytes=0,metrics:CanonicalCacheMetrics|undefined;
 const done=():AnalyticsCacheGroupResult=>({members:input.leases.map(lease=>outcomes.get(lease.workKey)!),selectedWorkKeys:selected,
  fallbackWorkKeys:fallbackRequired?input.leases.filter(lease=>!outcomes.get(lease.workKey)!.completedWithinLease).map(lease=>lease.workKey):[],
  fallbackRequired,facts,scopes,residentBytes,statements:budget.meter.queriesUsed-started,...(metrics?{metrics}:{})});
 const refuse=(reason:string,fallback=false)=>{for(const [key,value] of outcomes)if(!value.completedWithinLease)outcomes.set(key,{...value,reason});fallbackRequired=fallback;return done();};
 const available=(reserve=80)=>budget.remainingQueries()>=reserve&&now()<budget.deadlineMs-1500;
 if(!available())return refuse('query_budget');
 const works:AnalyticsStoredWork[]=[];
 for(const lease of input.leases){
  const work=await readAnalyticsPartitionWork(target,lease,now());if(!work)return refuse('lease_changed');
  if(work.attempts!==1)return refuse('singleton_retry_required',true);
  const parsed=match.exec(work.partitionKey);
  if(work.stage!=='cache'||lease.stage!=='cache'||work.headKey!==lease.headKey||!parsed||work.day!==parsed[3]
   ||work.stream!=='usage'||work.selectionMethod!==parsed[1])return refuse('cache_group_incompatible',true);
  if(works[0]&&(['sourceId','policyRevision','day','stream','selectionMethod'] as const).some(key=>work[key]!==works[0]![key]))
   return refuse('cache_group_incompatible',true);
  if(!Number.isSafeInteger(work.residentBytes)||work.residentBytes<0||(residentBytes+=work.residentBytes)>32*1024*1024)
   return refuse('group_capacity',true);
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
 if(facts<1||facts>16||manifests.some(manifest=>manifest.rowCount<1))return refuse('group_capacity',true);
 const metadata=(await target.prepare(`SELECT f.revision,f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
  FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  WHERE r.content_revision IN(SELECT value FROM json_each(?)) ORDER BY r.content_revision,r.ordinal LIMIT 17`)
  .bind(JSON.stringify(manifests.map(manifest=>manifest.contentRevision))).all<{revision:string;source_id:string;owner_digest:string;
   observed_day:string;stream:string;selection_method:string}>()).results;
 if(metadata.length!==facts)return refuse('manifest_incomplete');
 scopes=new Set(metadata.map(row=>canonicalJson([row.source_id,row.owner_digest,row.observed_day,row.stream,row.selection_method]))).size;
 if(scopes!==1)return refuse('scope_capacity',true);
 if(metadata.some(row=>row.source_id!==works[0]!.sourceId||row.observed_day!==works[0]!.day||row.stream!=='usage'
  ||row.selection_method!==works[0]!.selectionMethod))return refuse('cache_group_incompatible',true);
 const eligibility=selectAnalyticsCacheGroup(works.map((work,index)=>({...work,refs:manifests[index]!.rows,
  scopeKeys:metadata.filter(row=>manifests[index]!.rows.some(ref=>ref.revision===row.revision))
   .map(row=>canonicalJson([row.source_id,row.owner_digest,row.observed_day,row.stream,row.selection_method]))})));
 // A concrete group keeps the complete original claim prefix. The shared
 // selector may suggest a subset for other callers; this path never skips.
 if(eligibility.excluded.length||eligibility.selected.length!==works.length)return refuse('group_capacity',true);
 const union=await readCanonicalFacts(target,manifests.flatMap(manifest=>manifest.rows.map(row=>row.revision)));
 if(union.length!==facts)return refuse('canonical_partition_changed');
 const members:Member[]=works.map((work,index)=>({work,lease:input.leases[index]!,manifest:manifests[index]!,
  facts:manifests[index]!.rows.map(row=>union.find(fact=>fact.revision===row.revision)!)}));
 if(members.some(member=>member.facts.some(fact=>!fact)))return refuse('manifest_incomplete');
 const proof=await (input.captureGroupProof??captureAnalyticsManifestGroupProof)({target:input.target,sources:input.sources,budget,members});
 if(proof.state!=='complete')return refuse(proof.reason,proof.state==='refused');
 const receipts=new Map<string,Receipt>();
 const receiptCurrent=async(values:readonly Receipt[]):Promise<boolean>=>{
  if(!values.length)return true;
  const expected=values.map(({member:{work,lease,manifest},childWorkKey,completed})=>({
   workKey:work.workKey,sourceId:work.sourceId,partitionKey:work.partitionKey,inputRevision:work.inputRevision,policyRevision:work.policyRevision,
   headKey:work.headKey,ownerDigest:work.ownerDigest,day:work.day,stream:work.stream,selectionMethod:work.selectionMethod,
   revision:lease.revision,contentRevision:manifest.contentRevision,childWorkKey,completed:completed?1:0}));
  return await target.prepare(`SELECT count(*) n FROM json_each(?) e
   JOIN analytics_canonical_cache_partitions p ON p.partition_key=json_extract(e.value,'$.partitionKey')
   JOIN analytics_partition_work w ON w.work_key=json_extract(e.value,'$.workKey')
   WHERE p.content_revision=json_extract(e.value,'$.contentRevision') AND p.method=?
   AND (json_extract(e.value,'$.completed')=0 OR(w.state='complete' AND w.revision=json_extract(e.value,'$.revision')+1
    AND w.claim_token IS NULL AND w.claim_expires_ms=0 AND w.stage='cache' AND w.source_id=json_extract(e.value,'$.sourceId')
    AND w.partition_key=json_extract(e.value,'$.partitionKey') AND w.head_key=json_extract(e.value,'$.headKey')
    AND w.owner_digest IS json_extract(e.value,'$.ownerDigest') AND w.input_revision=json_extract(e.value,'$.inputRevision')
    AND w.policy_revision=json_extract(e.value,'$.policyRevision') AND w.day IS json_extract(e.value,'$.day')
    AND w.stream IS json_extract(e.value,'$.stream') AND w.selection_method IS json_extract(e.value,'$.selectionMethod')
    AND (SELECT count(*) FROM analytics_partition_work_links WHERE parent_work_key=w.work_key)=1
    AND EXISTS(SELECT 1 FROM analytics_partition_work_links l JOIN analytics_partition_work c ON c.work_key=l.child_work_key
     WHERE l.parent_work_key=w.work_key AND c.work_key=json_extract(e.value,'$.childWorkKey'))))`)
   .bind(JSON.stringify(expected),CACHE_RETENTION_METHOD.version).first<number>('n')===values.length;
 };
 const stillCurrent=async()=>await proof.stillCurrent()&&await receiptCurrent([...receipts.values()]);
 try{
  selected=works.map(work=>work.workKey);for(const key of selected)outcomes.set(key,{...outcomes.get(key)!,admitted:true});
  const prepared=await materializeCanonicalCachePartitionGroup({target,members,budget,stillCurrent,canCommit:proof.canCommit,maxRepairs:8});
  metrics=prepared.metrics;
  if(prepared.state!=='complete'){
   if(prepared.state==='deferred'&&prepared.reason==='cache_repairs_pending'&&await proof.stillCurrent())
    for(const member of members)if(available(20)&&await proof.forMember(member.work.workKey)?.canCommit())
     await recordCanonicalCachePreparedReceipt({target,lease:member.lease,partition:member,budget});
   return refuse(prepared.reason,prepared.state==='refused');
  }
  for(const member of members){
   const {work,lease}=member,memberProof=proof.forMember(work.workKey);
   if(!available(24)||!memberProof||!await memberProof.stillCurrent()||!await receiptCurrent([...receipts.values()])){
    outcomes.set(work.workKey,{...outcomes.get(work.workKey)!,reason:'source_changed_or_budget'});continue;
   }
   const child=await cachePublicationWorkSuccessor(work,member.manifest.contentRevision);
   const receipt:Receipt={member,childWorkKey:await analyticsWorkKey(child),completed:false};receipts.set(work.workKey,receipt);
   let completed=false;
   try{completed=await completeAnalyticsPartitionWork(target,lease,[child],now());}
   catch(error){if(error instanceof D1InvocationBudgetExceededError)throw error;
    if(!await receiptCurrent([{...receipt,completed:true}]))throw error;completed=true;}
   if(!completed)completed=await receiptCurrent([{...receipt,completed:true}]);
   receipt.completed=completed;
   const fresh=completed&&await stillCurrent();
   outcomes.set(work.workKey,{workKey:work.workKey,outcome:fresh?'complete':'deferred',admitted:true,
    reason:fresh?'cache_prepared':completed?'source_changed':'lease_changed',completedWithinLease:completed});
  }
  return done();
 }finally{proof.close();}
}
