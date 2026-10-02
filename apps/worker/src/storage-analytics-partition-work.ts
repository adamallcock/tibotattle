import { ANALYTICS_WORK_CONTRACT, type AnalyticsWorkLease, type AnalyticsWorkOutcome,
  type AnalyticsWorkStage, type AnalyticsWorkLane, type AnalyticsWorkRequest, type AnalyticsStoredWork } from './analytics-partition-work';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { returnedD1Target } from './d1-direct-write';
import {readD1SchemaObjectsAvailable} from './d1-invocation-budget';
import {CANONICAL_CACHE_PREPARED_READY_PREDICATE} from './storage-canonical-cache-pairs';

export type {AnalyticsWorkLane,AnalyticsWorkRequest,AnalyticsStoredWork} from './analytics-partition-work';
export const ANALYTICS_PARTITION_WORK_TABLES=Object.freeze(['analytics_partition_work','analytics_partition_schedule',
  'analytics_partition_subject_schedule','analytics_partition_canonical_effects','analytics_partition_reconciliation',
  'analytics_partition_ranges','analytics_partition_global_changes','analytics_partition_dirty_work',
  'analytics_partition_effect_refs','analytics_partition_work_links','analytics_partition_work_subjects','analytics_partition_work_counts','analytics_pipeline_runtime','analytics_partition_graph_dirty','analytics_partition_policy_work',
  'analytics_partition_graph_subjects','analytics_partition_graph_input_refs','analytics_partition_graph_demands','analytics_partition_graph_control','analytics_partition_empty_outcomes','analytics_partition_maintenance']);
export const ANALYTICS_PARTITION_WORK_TRIGGERS=Object.freeze(['analytics_partition_canonical_outbox',
  'analytics_partition_work_admit','analytics_partition_work_immutable','analytics_partition_range_admit',
  'analytics_partition_owner_terminal','analytics_partition_erasure','analytics_partition_owner_delete',
  'analytics_partition_dirty_insert','analytics_partition_dirty_update','analytics_partition_work_link_acyclic',
  'analytics_partition_manifest_admit','analytics_partition_manifest_subjects','analytics_partition_subject_terminal',
  'analytics_partition_subject_erasure','analytics_partition_subject_owner_delete',
 'analytics_partition_capacity_insert','analytics_partition_capacity_reopen','analytics_partition_counts_insert',
 'analytics_partition_counts_state','analytics_partition_counts_delete','analytics_partition_counts_claim','analytics_partition_graph_insert','analytics_partition_graph_update','analytics_partition_graph_delete',
 'analytics_partition_graph_subject_admit','analytics_partition_graph_subject_update','analytics_partition_graph_ref_admit',
 'analytics_partition_graph_ref_update','analytics_partition_graph_demand_admit','analytics_partition_graph_demand_update',
 'analytics_partition_graph_input_sealed','analytics_partition_graph_input_insert','analytics_partition_graph_subject_added',
 'analytics_partition_graph_subject_terminal','analytics_partition_graph_subject_erasure','analytics_partition_graph_subject_replay',
 'analytics_partition_graph_subject_delete',
 'analytics_partition_empty_admit','analytics_partition_empty_update','analytics_partition_empty_terminal',
 'analytics_partition_empty_erasure','analytics_partition_empty_erasure_replay']);
const stages=['canonical','features','activity','fits','cache','publication','cleanup'];
const lanes=['withdrawal','new','recovery','history'];
// Each six claims within a stage reserves two withdrawal and two fresh slots.
// Other-stage claims cannot consume its recovery/history opportunities.
const turns:readonly AnalyticsWorkLane[]=['withdrawal','new','recovery','withdrawal','new','history'];
const invalid=()=>new Error('ANALYTICS_PARTITION_WORK_INVALID');
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const integer=(value:number,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export function validateAnalyticsWorkRequest(value:AnalyticsWorkRequest):void {
  if(!value||Object.keys(value).sort().join(',')!=='admissionQueries,day,headKey,inputRevision,lane,ownerDigest,partitionKey,policyRevision,residentBytes,selectionMethod,sourceId,stage,stream'
    ||!/^[-A-Za-z0-9._:]{1,128}$/u.test(value.sourceId)||value.ownerDigest!==null&&!hash(value.ownerDigest)
    ||!stages.includes(value.stage)||!lanes.includes(value.lane)||!hash(value.headKey)||!hash(value.inputRevision)||!hash(value.policyRevision)
    ||typeof value.partitionKey!=='string'||!/^[-A-Za-z0-9._:/]{1,256}$/u.test(value.partitionKey)
    ||value.day!==null&&(!/^\d{4}-\d{2}-\d{2}$/u.test(value.day)||new Date(value.day+'T00:00:00.000Z').toISOString().slice(0,10)!==value.day)
    ||value.stream!==null&&!['usage','quota','session'].includes(value.stream)
    ||value.selectionMethod!==null&&!['effective-union-v1','legacy-selected-v1'].includes(value.selectionMethod)
    ||!integer(value.residentBytes,0,64*1024*1024)||!integer(value.admissionQueries,1,900))throw invalid();
}
export async function analyticsWorkKey(request:AnalyticsWorkRequest):Promise<string> {
  validateAnalyticsWorkRequest(request);
  return sha256Hex(canonicalJson([ANALYTICS_WORK_CONTRACT,request.sourceId,request.stage,
    request.partitionKey,request.headKey,request.inputRevision,request.policyRevision]));
}
export async function analyticsPartitionWorkAvailable(db:D1Database):Promise<boolean> {
  return readD1SchemaObjectsAvailable(db,[...ANALYTICS_PARTITION_WORK_TABLES.map(name=>['table',name] as const),
    ...ANALYTICS_PARTITION_WORK_TRIGGERS.map(name=>['trigger',name] as const),
    ['index','analytics_partition_work_head'],['index','analytics_partition_work_head_recency']]);
}
const columns=`work_key,head_key,source_id,owner_digest,partition_key,input_revision,policy_revision,stage,lane,
 day,stream,selection_method,resident_bytes,admission_queries,ready_ms,created_ms,updated_ms`;
const leaseCondition=`work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?`;
function leaseValues(lease:AnalyticsWorkLease,nowMs:number):[string,number,string,number] {
  if(!hash(lease.workKey)||!integer(lease.revision,1)||!/^[-A-Za-z0-9_]{16,128}$/u.test(lease.claimToken)||!integer(nowMs))throw invalid();
  return [lease.workKey,lease.revision,lease.claimToken,nowMs];
}
export async function analyticsWorkAdmissionStatements(db:D1Database,requests:readonly AnalyticsWorkRequest[],nowMs:number,
  guard?:{lease:AnalyticsWorkLease}):Promise<{statements:D1PreparedStatement[];workKeys:readonly string[]}> {
  if(!Array.isArray(requests)||requests.length>32||!integer(nowMs))throw invalid();
  const workKeys=await Promise.all(requests.map(analyticsWorkKey));
  if(new Set(workKeys).size!==workKeys.length)throw invalid();
  const rows=requests.map((request,index)=>[workKeys[index],request.headKey,request.sourceId,request.ownerDigest,request.partitionKey,
    request.inputRevision,request.policyRevision,request.stage,request.lane,request.day,request.stream,request.selectionMethod,
    request.residentBytes,request.admissionQueries,nowMs,nowMs,nowMs]);
  if(!rows.length)return {statements:[],workKeys};
  const guarded=guard?` AND EXISTS(SELECT 1 FROM analytics_partition_work WHERE ${leaseCondition})`:'';
  const values=guard?leaseValues(guard.lease,nowMs):[];
  // Anonymous revisions retain the recency of their logical head. A new
  // input/policy revision must not reset an already busy partition to priority0.
  const statement=db.prepare(`INSERT INTO analytics_partition_work(${columns},last_claimed)
    SELECT ${Array.from({length:17},(_,index)=>`json_extract(admitted.value,'$[${index}]')`).join(',')},
     CASE WHEN json_extract(admitted.value,'$[3]') IS NULL THEN COALESCE((
      SELECT MAX(previous.last_claimed) FROM analytics_partition_work previous INDEXED BY analytics_partition_work_head_recency
      WHERE previous.head_key=json_extract(admitted.value,'$[1]') AND previous.source_id=json_extract(admitted.value,'$[2]')
      AND previous.owner_digest IS NULL),0) ELSE 0 END
    FROM json_each(?) admitted WHERE true${guarded} ON CONFLICT(work_key) DO NOTHING`).bind(JSON.stringify(rows),...values);
  return {statements:[statement],workKeys};
}
/** Idempotent immutable admission. Caller carries the actual invocation meter. */
export async function admitAnalyticsPartitionWork(db:D1Database,requests:readonly AnalyticsWorkRequest[],nowMs=Date.now()):Promise<readonly string[]> {
  const {statements,workKeys}=await analyticsWorkAdmissionStatements(db,requests,nowMs);
  if(statements.length)await db.batch(statements);
  return workKeys;
}
interface WorkRow {
 work_key:string;head_key:string;source_id:string;owner_digest:string|null;partition_key:string;input_revision:string;policy_revision:string;
 stage:AnalyticsWorkStage;lane:AnalyticsWorkLane;day:string|null;stream:AnalyticsWorkRequest['stream'];selection_method:AnalyticsWorkRequest['selectionMethod'];
 resident_bytes:number;admission_queries:number;revision:number;claim_token:string;claim_expires_ms:number;attempts:number;
 last_claimed:number;created_ms:number;ready_ms:number;state:string;
}
/** One selector owns both durable claims and the read-only preview. Virtual
 * updates model precisely the subject/head changes made by earlier claims;
 * they never skip a candidate because it is unsuitable for a feature group. */
function claimSelection(projection:string,preview=false,cacheRepairBlocked=false,budgetEligible=false):string {
 // Anonymous jobs rotate by bounded logical head, independently of cache
 // or other-stage claims. The legacy empty owner bucket supplies no priority.
 // Real owners retain the original skew reserve; no synthetic owner is added.
 const ownerFair=preview?`MAX(COALESCE(fair.last_claimed,0),COALESCE((SELECT json_extract(value,'$[1]')
  FROM json_each(?) WHERE json_extract(value,'$[0]')=w.owner_digest),0))`:'COALESCE(fair.last_claimed,0)';
 const fair=`CASE WHEN w.owner_digest IS NULL THEN COALESCE((SELECT MAX(previous.last_claimed)
  FROM analytics_partition_work previous INDEXED BY analytics_partition_work_head_recency
  WHERE previous.head_key=w.head_key AND previous.source_id=w.source_id AND previous.owner_digest IS NULL),0)
  ELSE ${ownerFair} END`;
 const stageFair=preview?`MAX(COALESCE(stage_fair.last_claimed,0),COALESCE((SELECT json_extract(value,'$[1]')
  FROM json_each(?) WHERE json_extract(value,'$[0]')=w.stage),0))`:'COALESCE(stage_fair.last_claimed,0)';
 const stageClaims=preview?`COALESCE(stage_fair.claim_count,0)+COALESCE((SELECT json_extract(value,'$[2]')
  FROM json_each(?) WHERE json_extract(value,'$[0]')=w.stage),0)`:'COALESCE(stage_fair.claim_count,0)';
 // A stage's first funded claim retains the source's natural admission turn;
 // thereafter only its own acknowledged claims advance the lane cycle.
 const preferredLane=`CASE WHEN (${stageClaims})=0 THEN ? ELSE CASE ((${stageClaims})%${turns.length}) ${turns.map((lane,index)=>`WHEN ${index} THEN '${lane}'`).join(' ')} END END`;
 // Alternate calendar priority with the original recency/FIFO order. Even an
 // indefinitely deferred oldest date yields six stage claims every cycle.
 const dateTurn=`(((${stageClaims})/${turns.length})%2)=0`;
 // Each ready stage gets a turn, then its actual named/anonymous classes
 // alternate. A permanent stream of fresh anonymous heads cannot suppress a
 // named job; cache-only claims cannot change another stage's rank.
 return `SELECT ${projection} FROM analytics_partition_work w
  LEFT JOIN analytics_partition_work_counts stage_fair ON stage_fair.source_id=w.source_id AND stage_fair.stage=w.stage AND stage_fair.state='leased'
  LEFT JOIN analytics_partition_subject_schedule fair ON fair.source_id=w.source_id AND fair.owner_digest=w.owner_digest
  WHERE w.source_id=? AND w.stage IN(SELECT value FROM json_each(?))
  AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='analytics_partition_counts_claim')
  AND ((w.state='ready' AND w.ready_ms<=?) OR (w.state='leased' AND w.claim_expires_ms<=?))
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work held WHERE held.head_key=w.head_key AND held.state='leased' AND held.claim_expires_ms>?)
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work pacing WHERE pacing.source_id=w.source_id
    AND pacing.head_key=w.head_key AND pacing.input_revision=w.input_revision AND pacing.stage=w.stage
    AND pacing.partition_key=w.partition_key AND pacing.owner_digest IS w.owner_digest
    AND pacing.state='ready' AND pacing.ready_ms>?)
  ${budgetEligible?'AND w.admission_queries<=?':''}
  AND (w.owner_digest IS NULL OR EXISTS(SELECT 1 FROM analytics_owner_state o WHERE o.source_id=w.source_id
   AND o.owner_digest=w.owner_digest AND o.state='active' AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f
   WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)))
  ${cacheRepairBlocked?`AND NOT (${CANONICAL_CACHE_PREPARED_READY_PREDICATE})`:''}
  ${preview?'AND w.head_key NOT IN(SELECT value FROM json_each(?))':''}
  ORDER BY ${stageFair},CASE WHEN w.lane=(${preferredLane}) THEN 0 ELSE 1 END,
   CASE w.lane WHEN 'withdrawal' THEN 0 WHEN 'new' THEN 1 WHEN 'recovery' THEN 2 ELSE 3 END,
   CASE WHEN (w.owner_digest IS NULL)=((${stageClaims})%2) THEN 0 ELSE 1 END,
   CASE WHEN (${dateTurn}) AND w.lane IN('new','recovery') AND w.day IS NOT NULL THEN 0 ELSE 1 END,
   CASE WHEN (${dateTurn}) AND w.day IS NOT NULL THEN CASE WHEN w.lane='new' THEN -CAST(julianday(w.day) AS INTEGER)
    WHEN w.lane='recovery' THEN CAST(julianday(w.day) AS INTEGER) ELSE 0 END ELSE 0 END,
   ${fair},w.last_claimed,w.created_ms,w.work_key LIMIT 1`;
}
/** An optional per-job ceiling keeps underfunded ready/expired work out of
 * this invocation's claim set. Its stage/head/owner opportunity remains intact;
 * the source schedule tick may advance. It does not sum a shared group's leaf
 * estimates or replace the dispatcher's actual cumulative budget check.
 * Every individual UPDATE selects and claims atomically. A supplied exact
 * prefix stops on the first changed ordinary candidate, without skipping it.
 * An unexpired head
 * lease excludes competing revisions even across independent invocations. */
export async function claimAnalyticsPartitionWork(db:D1Database,input:{sourceId:string;limit:number;nowMs:number;leaseMs?:number;stages?:readonly AnalyticsWorkStage[];expectedWorkKeys?:readonly string[];cacheRepairBlocked?:boolean;maxAdmissionQueries?:number}):Promise<readonly AnalyticsWorkLease[]> {
  const leaseMs=input.leaseMs??120_000;
  if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(input.sourceId)||!integer(input.limit,1,8)||!integer(input.nowMs)||!integer(leaseMs,1_000,300_000)
    ||input.cacheRepairBlocked!==undefined&&typeof input.cacheRepairBlocked!=='boolean'
    ||input.maxAdmissionQueries!==undefined&&!integer(input.maxAdmissionQueries,0,900)
    ||input.stages!==undefined&&(!input.stages.length||input.stages.some(stage=>!stages.includes(stage))||new Set(input.stages).size!==input.stages.length)
    ||input.expectedWorkKeys!==undefined&&(!Array.isArray(input.expectedWorkKeys)||input.expectedWorkKeys.length!==input.limit
      ||input.expectedWorkKeys.some(key=>!hash(key))||new Set(input.expectedWorkKeys).size!==input.expectedWorkKeys.length))throw invalid();
  const reserveTicks=async(count:number)=>{
    const cursor=await db.prepare(`INSERT INTO analytics_partition_schedule(source_id,turn) VALUES(?,?)
    ON CONFLICT(source_id) DO UPDATE SET turn=turn+excluded.turn RETURNING turn`).bind(input.sourceId,count).first<{turn:number}>();
    if(!cursor)throw invalid();return cursor.turn;
  };
  // Default callers retain their exact bulk reservation and query cost. A
  // guarded prefix reserves only each attempted ordinary turn, so stopping
  // cannot consume the unattempted tail or unwind another caller's cursor.
  const lastTick=input.expectedWorkKeys?undefined:await reserveTicks(input.limit);
  const leases:AnalyticsWorkLease[]=[];
  for(let index=0;index<input.limit;index++) {
    const tick=input.expectedWorkKeys?await reserveTicks(1):lastTick!-input.limit+index+1;
    const token=crypto.randomUUID();
    // An earlier reserved tick may reach SQL after a later claimant released
    // this row. Preserve its durable recency rather than rewind that head.
    const row=await db.prepare(`UPDATE analytics_partition_work SET state='leased',revision=revision+1,
      claim_token=?,claim_expires_ms=?,attempts=attempts+1,last_claimed=MAX(last_claimed,?),updated_ms=?
      WHERE work_key=(${claimSelection('w.work_key',false,input.cacheRepairBlocked===true,input.maxAdmissionQueries!==undefined)})${input.expectedWorkKeys?' AND work_key=?':''}
      RETURNING *`).bind(token,input.nowMs+leaseMs,tick,input.nowMs,input.sourceId,JSON.stringify(input.stages??stages),input.nowMs,input.nowMs,input.nowMs,input.nowMs,...(input.maxAdmissionQueries!==undefined?[input.maxAdmissionQueries]:[]),turns[(tick-1)%turns.length]!,
        ...(input.expectedWorkKeys?[input.expectedWorkKeys[index]!]:[])).first<WorkRow>();
    // The expected key only verifies the ordinary atomic selection. It never
    // selects a hinted key or crosses a changed prefix to claim a later job.
    if(!row){if(input.expectedWorkKeys)break;continue;}
    // A failed fairness bookkeeping response cannot lose the already durable
    // claim. It remains reclaimable by expiry under the same head fence.
    if(row.owner_digest!==null)await db.prepare(`INSERT INTO analytics_partition_subject_schedule(source_id,owner_digest,last_claimed) VALUES(?,?,?)
      ON CONFLICT(source_id,owner_digest) DO UPDATE SET last_claimed=MAX(last_claimed,excluded.last_claimed)`)
      .bind(row.source_id,row.owner_digest,tick).run();
    leases.push(Object.freeze({contract:ANALYTICS_WORK_CONTRACT,workKey:row.work_key,headKey:row.head_key,claimToken:row.claim_token,
      revision:row.revision,stage:row.stage,residentBytes:row.resident_bytes,admissionQueries:row.admission_queries,expiresAtMs:row.claim_expires_ms}));
  }
  return Object.freeze(leases);
}
export type AnalyticsFeatureGroupPreview={readonly state:'eligible';readonly workKeys:readonly string[];
 readonly facts:number;readonly scopes:1;readonly residentBytes:number}
 |{readonly state:'ineligible';readonly reason:'first_claim_changed'|'singleton_retry_required'|'fair_prefix_incomplete'
  |'incompatible_prefix'|'group_bounds'|'canonical_scope_changed'};
const featurePartition=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u;
/** Advisory preview of exactly the ordinary next seven feature claims. Reads
 * only indexed current canonical metadata (at most seventeen rows per leaf).
 * Caller compares the actual claim prefix and retains every producer proof. */
export async function previewAnalyticsFeatureGroup(input:{target:D1Database;first:AnalyticsWorkLease;sourceId:string;nowMs:number;stages?:readonly AnalyticsWorkStage[];cacheRepairBlocked?:boolean;maxAdmissionQueries?:number}):Promise<AnalyticsFeatureGroupPreview> {
 return previewAnalyticsManifestGroup(input,'features');
}
/** Activity shares the ordinary fair prefix, with exact original manifest
 * revisions required in addition to the current canonical metadata bounds. */
export async function previewAnalyticsActivityGroup(input:{target:D1Database;first:AnalyticsWorkLease;sourceId:string;nowMs:number;stages?:readonly AnalyticsWorkStage[];cacheRepairBlocked?:boolean;maxAdmissionQueries?:number}):Promise<AnalyticsFeatureGroupPreview> {
 return previewAnalyticsManifestGroup(input,'activity');
}
/** Cache shares the ordinary fair prefix for exact current usage manifests. */
export async function previewAnalyticsCacheGroup(input:{target:D1Database;first:AnalyticsWorkLease;sourceId:string;nowMs:number;stages?:readonly AnalyticsWorkStage[];cacheRepairBlocked?:boolean;maxAdmissionQueries?:number}):Promise<AnalyticsFeatureGroupPreview> {
 return previewAnalyticsManifestGroup(input,'cache');
}
async function previewAnalyticsManifestGroup(input:{target:D1Database;first:AnalyticsWorkLease;sourceId:string;nowMs:number;stages?:readonly AnalyticsWorkStage[];cacheRepairBlocked?:boolean;maxAdmissionQueries?:number},stage:'features'|'activity'|'cache'):Promise<AnalyticsFeatureGroupPreview> {
 const {target,first,sourceId,nowMs}=input;
 if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(sourceId)||!integer(nowMs)
  ||input.cacheRepairBlocked!==undefined&&typeof input.cacheRepairBlocked!=='boolean'
  ||input.maxAdmissionQueries!==undefined&&!integer(input.maxAdmissionQueries,0,900)
  ||input.stages!==undefined&&(!input.stages.length||input.stages.some(value=>!stages.includes(value))||new Set(input.stages).size!==input.stages.length))throw invalid();
 const no=(reason:Extract<AnalyticsFeatureGroupPreview,{state:'ineligible'}>['reason']):AnalyticsFeatureGroupPreview=>({state:'ineligible',reason});
 const pinned=await target.prepare(`SELECT w.*,s.turn FROM analytics_partition_work w
  JOIN analytics_partition_schedule s ON s.source_id=w.source_id WHERE ${leaseCondition}`)
  .bind(...leaseValues(first,nowMs)).first<WorkRow&{turn:number}>();
 if(!pinned||pinned.source_id!==sourceId||pinned.head_key!==first.headKey||pinned.stage!==stage
  ||pinned.last_claimed!==pinned.turn)return no('first_claim_changed');
 if(pinned.attempts!==1)return no('singleton_retry_required');
 const rows:WorkRow[]=[pinned],held=[pinned.head_key],subjects=new Map<string,number>(),stageUpdates=new Map<string,{tick:number;claims:number}>();
 for(let index=1;index<8;index++){
  const tick=pinned.turn+index;if(!integer(tick,1))return no('first_claim_changed');
  const row=await target.prepare(claimSelection('w.*',true,input.cacheRepairBlocked===true,input.maxAdmissionQueries!==undefined)).bind(sourceId,JSON.stringify(input.stages??stages),nowMs,nowMs,nowMs,nowMs,
   ...(input.maxAdmissionQueries!==undefined?[input.maxAdmissionQueries]:[]),JSON.stringify(held),
   ...[1,2].map(()=>JSON.stringify([...stageUpdates].map(([key,value])=>[key,value.tick,value.claims]))),turns[(tick-1)%turns.length]!,
   ...[3,4,5,6].map(()=>JSON.stringify([...stageUpdates].map(([key,value])=>[key,value.tick,value.claims]))),JSON.stringify([...subjects])).first<WorkRow>();
  if(!row)return no('fair_prefix_incomplete');
  if(row.stage!==stage)return no('incompatible_prefix');
  if(row.attempts!==0||row.state!=='ready')return no('singleton_retry_required');
  rows.push(row);held.push(row.head_key);if(row.owner_digest!==null)subjects.set(row.owner_digest,tick);
  stageUpdates.set(row.stage,{tick,claims:(stageUpdates.get(row.stage)?.claims??0)+1});
 }
 const prefixes:string[]=[],refs=new Set<string>(),occurrences=new Set<string>(),scopes=new Set<string>();
 let residentBytes=0;
 for(const row of rows){
  const parsed=featurePartition.exec(row.partition_key);
  if(!parsed||row.source_id!==sourceId||row.policy_revision!==pinned.policy_revision||row.day!==pinned.day
   ||row.stream!==pinned.stream||row.selection_method!==pinned.selection_method
   ||row.selection_method!==parsed[1]||row.stream!==parsed[2]||row.day!==(parsed[3]==='unknown'?null:parsed[3])
   ||prefixes.some(prefix=>prefix.startsWith(row.partition_key)||row.partition_key.startsWith(prefix)))return no('incompatible_prefix');
  prefixes.push(row.partition_key);residentBytes+=row.resident_bytes;
  if(!integer(row.resident_bytes,0,32*1024*1024)||residentBytes>32*1024*1024)return no('group_bounds');
  if(stage==='cache'&&row.stream!=='usage')return no('incompatible_prefix');
  if(stage!=='features'){
   const current=await target.prepare(`SELECT m.content_revision FROM analytics_canonical_partition_heads h
    JOIN analytics_canonical_manifests m USING(content_revision) WHERE h.partition_key=? AND m.state='complete'
    AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)`)
    .bind(row.partition_key).first<string>('content_revision');
   if(current!==row.input_revision)return no('canonical_scope_changed');
  }
  const root=row.partition_key.slice(0,-parsed[4]!.length)+parsed[4]!.slice(0,2);
  const facts=(await target.prepare(`SELECT f.revision,f.occurrence_key,f.source_id,f.owner_digest,f.observed_day,f.stream,f.selection_method
   FROM analytics_canonical_heads h INDEXED BY analytics_canonical_head_partition JOIN analytics_canonical_facts f ON f.revision=h.revision
   WHERE h.partition_key=? AND h.occurrence_key>=? AND h.occurrence_key<? ORDER BY h.occurrence_key LIMIT 17`)
   .bind(root,parsed[4]!,parsed[4]!+'g').all<{revision:string;occurrence_key:string;source_id:string;owner_digest:string;
    observed_day:string|null;stream:string;selection_method:string}>()).results;
  if(!facts.length)return no('canonical_scope_changed');
  if(facts.length>16)return no('group_bounds');
  for(const fact of facts){
   if(fact.source_id!==sourceId||!hash(fact.owner_digest)||fact.observed_day!==row.day||fact.stream!==row.stream
    ||fact.selection_method!==row.selection_method||!hash(fact.revision)||!hash(fact.occurrence_key)
    ||refs.has(fact.revision)||occurrences.has(fact.occurrence_key))return no('canonical_scope_changed');
   scopes.add(canonicalJson([fact.source_id,fact.owner_digest,fact.observed_day,fact.stream,fact.selection_method]));
   refs.add(fact.revision);occurrences.add(fact.occurrence_key);
   if(refs.size>16||scopes.size>1)return no('group_bounds');
  }
 }
 // A concurrent claimant makes this preview unusable, rather than permitting
 // a compatible-head search beyond the ordinary fair prefix.
 const current=await target.prepare(`SELECT s.turn FROM analytics_partition_work w JOIN analytics_partition_schedule s ON s.source_id=w.source_id
  WHERE ${leaseCondition} AND w.last_claimed=? AND w.attempts=1`).bind(...leaseValues(first,nowMs),pinned.turn).first<number>('turn');
 if(current!==pinned.turn)return no('first_claim_changed');
 return Object.freeze({state:'eligible',workKeys:Object.freeze(rows.map(row=>row.work_key)),facts:refs.size,scopes:1,residentBytes});
}
export async function readAnalyticsPartitionWork(db:D1Database,lease:AnalyticsWorkLease,nowMs=Date.now()):Promise<AnalyticsStoredWork|null> {
  const row=await db.prepare(`SELECT * FROM analytics_partition_work WHERE ${leaseCondition}`).bind(...leaseValues(lease,nowMs)).first<WorkRow>();
  if(!row)return null;
  return Object.freeze({workKey:row.work_key,headKey:row.head_key,sourceId:row.source_id,ownerDigest:row.owner_digest,
    stage:row.stage,lane:row.lane,partitionKey:row.partition_key,inputRevision:row.input_revision,policyRevision:row.policy_revision,
    day:row.day,stream:row.stream,selectionMethod:row.selection_method,residentBytes:row.resident_bytes,
    admissionQueries:row.admission_queries,attempts:row.attempts});
}
export type AnalyticsWorkReleaseOutcome=AnalyticsWorkOutcome|'failure'|'not_admitted';
export async function releaseAnalyticsPartitionWork(db:D1Database,lease:AnalyticsWorkLease,outcome:AnalyticsWorkReleaseOutcome,
  nowMs=Date.now()):Promise<boolean> {
  if(!['complete','deferred','refused','failure','not_admitted'].includes(outcome))throw invalid();
  const state=outcome==='complete'||outcome==='refused'?outcome:'ready';
  const result=await db.prepare(`UPDATE analytics_partition_work SET state=?,revision=revision+1,claim_token=NULL,claim_expires_ms=0,
    lane=CASE WHEN ?='failure' THEN 'recovery' ELSE lane END,ready_ms=?,updated_ms=? WHERE ${leaseCondition} RETURNING work_key`)
    .bind(state,outcome,nowMs+(outcome==='failure'?5_000:0),nowMs,...leaseValues(lease,nowMs)).run();
  return returnedD1Target(result,'work_key',lease.workKey);
}
/** Accepted result and successors must be durable before completion. This
 * transaction closes scheduling only: artifact stores retain their own exact
 * source, dependency and public-head commit contracts. */
export async function completeAnalyticsPartitionWork(db:D1Database,lease:AnalyticsWorkLease,
  successors:readonly AnalyticsWorkRequest[],nowMs=Date.now()):Promise<boolean> {
  const {statements,workKeys}=await analyticsWorkAdmissionStatements(db,successors,nowMs,{lease});
  if(workKeys.includes(lease.workKey))throw invalid();
  if(workKeys.length)statements.push(db.prepare(`INSERT INTO analytics_partition_work_links(parent_work_key,child_work_key)
    SELECT ?,value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM analytics_partition_work WHERE ${leaseCondition})
    ON CONFLICT(parent_work_key,child_work_key) DO NOTHING`).bind(lease.workKey,JSON.stringify(workKeys),...leaseValues(lease,nowMs)));
  statements.push(db.prepare(`UPDATE analytics_partition_work SET state='complete',revision=revision+1,claim_token=NULL,
    claim_expires_ms=0,updated_ms=? WHERE ${leaseCondition} RETURNING work_key`).bind(nowMs,...leaseValues(lease,nowMs)));
  const result=await db.batch(statements);
  return returnedD1Target(result.at(-1),'work_key',lease.workKey);
}
/** Bounded metadata retirement never touches ready or live leased work. The
 * caller separately invokes each artifact owner's bounded retirement API. */
export async function retireAnalyticsPartitionWork(db:D1Database,input:{sourceId:string;beforeMs:number;limit?:number}):Promise<number> {
  const limit=input.limit??16;
  if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(input.sourceId)||!integer(input.beforeMs)||!integer(limit,1,32))throw invalid();
  const terminal=`source_id=? AND state IN('complete','refused') AND updated_ms<?
    AND NOT EXISTS(SELECT 1 FROM analytics_partition_work_links l WHERE l.parent_work_key=w.work_key)`;
  const child=await db.prepare(`SELECT w.work_key FROM analytics_partition_work w WHERE ${terminal}
    ORDER BY updated_ms,work_key LIMIT 1`).bind(input.sourceId,input.beforeMs).first<string>('work_key');
  let childRows=0,remaining=128;
  if(child) {
    const guard=`EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.work_key=? AND ${terminal})`;
    // Keep erasure subject links until private effects and lineage have gone.
    for(const [table,columns,match,preceding] of [
      ['analytics_partition_effect_refs','work_key,effect_key','work_key=?',''],
      ['analytics_partition_work_links','parent_work_key,child_work_key','child_work_key=?',''],
      ['analytics_partition_work_subjects','work_key,source_id,owner_digest','work_key=?',
       ' AND NOT EXISTS(SELECT 1 FROM analytics_partition_effect_refs WHERE work_key=?) AND NOT EXISTS(SELECT 1 FROM analytics_partition_work_links WHERE child_work_key=?)'],
    ]) {
      if(!remaining)break;
      const removed=await db.prepare(`DELETE FROM ${table} WHERE (${columns}) IN(SELECT ${columns} FROM ${table}
        WHERE ${match} AND ${guard}${preceding} ORDER BY ${columns} LIMIT ?) RETURNING ${columns}`)
        .bind(child,child,input.sourceId,input.beforeMs,...(preceding?[child,child]:[]),remaining).all();
      remaining-=removed.results.length;childRows+=removed.results.length;
    }
  }
  const result=await db.batch([
    // Transfer only scheduling recency, in a bounded page, before retiring its
    // old revision. Ready rows have no live lease to invalidate. A surviving
    // lower-recency live lease keeps the old row until ordinary resume/release.
    // The immutable job trigger still requires a forward revision on UPDATE.
    db.prepare(`WITH retiring AS(SELECT source_id,head_key,last_claimed FROM analytics_partition_work w
      WHERE source_id=? AND owner_digest IS NULL AND state IN('complete','refused') AND updated_ms<?
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work_links l WHERE l.parent_work_key=w.work_key OR l.child_work_key=w.work_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_effect_refs r WHERE r.work_key=w.work_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work_subjects r WHERE r.work_key=w.work_key)
      ORDER BY updated_ms,work_key LIMIT ?)
     UPDATE analytics_partition_work SET revision=revision+1,last_claimed=MAX(last_claimed,COALESCE((
      SELECT MAX(previous.last_claimed) FROM analytics_partition_work previous INDEXED BY analytics_partition_work_head_recency
      WHERE previous.head_key=analytics_partition_work.head_key AND previous.source_id=analytics_partition_work.source_id
      AND previous.owner_digest IS NULL),0))
     WHERE work_key IN(SELECT survivor.work_key FROM analytics_partition_work survivor
      WHERE survivor.owner_digest IS NULL AND survivor.state='ready'
      AND EXISTS(SELECT 1 FROM retiring r WHERE r.source_id=survivor.source_id AND r.head_key=survivor.head_key AND r.last_claimed>survivor.last_claimed)
      ORDER BY survivor.head_key,survivor.work_key LIMIT 128)`)
      .bind(input.sourceId,input.beforeMs,limit),
    db.prepare(`DELETE FROM analytics_partition_work WHERE work_key IN(SELECT work_key FROM analytics_partition_work
      WHERE source_id=? AND state IN('complete','refused') AND updated_ms<?
      AND (owner_digest IS NOT NULL OR NOT EXISTS(SELECT 1 FROM analytics_partition_work survivor INDEXED BY analytics_partition_work_head
       WHERE survivor.head_key=analytics_partition_work.head_key AND survivor.source_id=analytics_partition_work.source_id
       AND survivor.owner_digest IS NULL AND survivor.state IN('ready','leased') AND survivor.last_claimed<analytics_partition_work.last_claimed))
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work_links l WHERE l.parent_work_key=analytics_partition_work.work_key OR l.child_work_key=analytics_partition_work.work_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_effect_refs r WHERE r.work_key=analytics_partition_work.work_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work_subjects r WHERE r.work_key=analytics_partition_work.work_key)
      ORDER BY updated_ms,work_key LIMIT ?) RETURNING work_key`)
      .bind(input.sourceId,input.beforeMs,limit),
    db.prepare(`DELETE FROM analytics_partition_ranges WHERE effect_key IN(SELECT effect_key FROM analytics_partition_ranges
      WHERE source_id=? AND state='complete' AND acknowledged=1 AND updated_ms<? ORDER BY updated_ms,effect_key LIMIT ?) RETURNING effect_key`)
      .bind(input.sourceId,input.beforeMs,limit),
    db.prepare(`DELETE FROM analytics_partition_global_changes WHERE (source_id,source_stamp) IN(SELECT source_id,source_stamp FROM analytics_partition_global_changes
      WHERE source_id=? AND state='complete' AND acknowledged=1 AND updated_ms<? ORDER BY updated_ms,source_stamp LIMIT ?) RETURNING source_stamp`)
      .bind(input.sourceId,input.beforeMs,limit),
    db.prepare(`DELETE FROM analytics_partition_dirty_work WHERE (source_id,partition_key) IN(
      SELECT d.source_id,d.partition_key FROM analytics_partition_dirty_work d WHERE d.source_id=? AND d.generation=d.admitted_generation
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f WHERE f.source_id=d.source_id AND f.partition_key=d.partition_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h WHERE substr(h.partition_key,1,length(d.partition_key))=d.partition_key)
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=d.source_id
        AND substr(w.partition_key,1,length(d.partition_key))=d.partition_key) ORDER BY d.partition_key LIMIT ?) RETURNING partition_key`)
      .bind(input.sourceId,limit),
    db.prepare(`DELETE FROM analytics_partition_subject_schedule WHERE (source_id,owner_digest) IN(
      SELECT f.source_id,f.owner_digest FROM analytics_partition_subject_schedule f WHERE f.source_id=?
      AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=f.source_id AND w.owner_digest=f.owner_digest)
      ORDER BY f.last_claimed,f.owner_digest LIMIT ?) RETURNING owner_digest`).bind(input.sourceId,limit),
  ]);
  return result.reduce((total,row)=>total+row.results.length,childRows);
}

/** Exact bounded old/new references follow durable partition successors. The
 * effect store owns hydration and privacy validation. Work lineage carries no
 * fact payloads and is cycle-rejected at admission. */
export async function readAnalyticsWorkEffectKeys(db:D1Database,workKey:string,after='',limit=16):Promise<readonly string[]> {
  if(!hash(workKey)||after!==''&&!hash(after)||!integer(limit,1,16))throw invalid();
  const rows=(await db.prepare(`WITH RECURSIVE ancestors(key) AS(
    SELECT work_key FROM analytics_partition_work WHERE work_key=?
    UNION SELECT l.parent_work_key FROM analytics_partition_work_links l JOIN ancestors a ON l.child_work_key=a.key
  ) SELECT DISTINCT r.effect_key FROM analytics_partition_effect_refs r JOIN ancestors a ON a.key=r.work_key
    WHERE r.effect_key>? ORDER BY r.effect_key LIMIT ?`).bind(workKey,after,limit).all<{effect_key:string}>()).results;
  return Object.freeze(rows.map(row=>row.effect_key));
}

/** An observed producer reason is metadata, never a public completion claim.
 * The exact lease revision also admits a result just closed by its owning
 * transaction; a later claimant cannot inherit another attempt's reason. */
export async function recordAnalyticsPartitionWorkReason(db:D1Database,lease:AnalyticsWorkLease,reason:string,nowMs=Date.now()):Promise<void> {
 if(!/^[a-z_]{1,64}$/u.test(reason))throw invalid();
 const values=leaseValues(lease,nowMs);
 await db.prepare(`UPDATE analytics_partition_work SET reason_code=? WHERE work_key=? AND
  ((revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?) OR
   (revision=? AND claim_token IS NULL AND state IN('complete','refused')))`)
 .bind(reason,...values,lease.revision+1).run();
}
