import {ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS} from './admin-community-allowance';
import {modelHistoryWindow,V1_ANALYSIS_WINDOW_DAYS} from './model-history-window';
import type {CanonicalInputSeal} from './storage-canonical-analytics-input';
import type {AnalyticsWorkLease} from './analytics-partition-work';
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {SHARED_ANALYTICS_FEATURE_METHOD} from './analytics-shared-features';
import {CANONICAL_FEATURE_QUANTITY_METHOD,CANONICAL_DAILY_PRICE_METHOD,CANONICAL_FIT_PRICE_METHOD} from './canonical-feature-contributions';
import {CANONICAL_CACHE_PAIR_METHOD} from './canonical-cache-pairs';
import {STORAGE_GRAPH_METHOD} from './storage-community-graph';
import {analyticsWorkAdmissionStatements,readAnalyticsPartitionWork,type AnalyticsWorkRequest,type AnalyticsStoredWork} from './storage-analytics-partition-work';
import type {AnalyticsWorkStage} from './analytics-partition-work';
import {returnedD1Target} from './d1-direct-write';
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
export const maintainedAnalyticsPolicyRevision=()=>digest(['maintained-analytics-producer-v2',
 SHARED_ANALYTICS_FEATURE_METHOD,CANONICAL_FEATURE_QUANTITY_METHOD,CANONICAL_DAILY_PRICE_METHOD,
 CANONICAL_FIT_PRICE_METHOD,CANONICAL_CACHE_PAIR_METHOD,STORAGE_GRAPH_METHOD]);
/** A policy change replaces only compatible derived products. Input revisions
 * remain immutable. Work admission and cursor advancement commit together. */
export async function admitMaintainedAnalyticsPolicyWork(input:{target:D1Database;sourceId:string;nowMs:number;
 policyRevision:string}):Promise<number> {
 const {target,sourceId,nowMs,policyRevision}=input;
 await target.prepare(`INSERT INTO analytics_partition_policy_work(source_id,policy_revision,updated_ms) VALUES(?,?,?)
 ON CONFLICT(source_id) DO UPDATE SET policy_revision=excluded.policy_revision,after_partition_key='',state='pending',
 version=version+1,updated_ms=excluded.updated_ms WHERE policy_revision!=excluded.policy_revision`)
 .bind(sourceId,policyRevision,nowMs).run();
 const cursor=await target.prepare(`SELECT after_partition_key,version FROM analytics_partition_policy_work
 WHERE source_id=? AND policy_revision=? AND state='pending'`).bind(sourceId,policyRevision)
 .first<{after_partition_key:string;version:number}>();if(!cursor)return 0;
 const page=(await target.prepare(`SELECT partition_key,generation FROM analytics_partition_dirty_work
 WHERE source_id=? AND partition_key>? ORDER BY partition_key LIMIT 4`).bind(sourceId,cursor.after_partition_key)
 .all<{partition_key:string;generation:number}>()).results;
 const requests:AnalyticsWorkRequest[]=[];
 for(const row of page){const parts=row.partition_key.split('/');requests.push({sourceId,ownerDigest:null,stage:'features',lane:'recovery',
 partitionKey:row.partition_key,headKey:await digest(['features',sourceId,row.partition_key]),
 inputRevision:await digest([row.partition_key,row.generation]),policyRevision,day:parts[2]==='unknown'?null:parts[2]!,
 stream:parts[1] as AnalyticsWorkRequest['stream'],selectionMethod:parts[0] as AnalyticsWorkRequest['selectionMethod'],
 residentBytes:4*1024*1024,admissionQueries:600});}
 const admission=await analyticsWorkAdmissionStatements(target,requests,nowMs);
 admission.statements.push(target.prepare(`UPDATE analytics_partition_policy_work SET after_partition_key=?,state=?,version=version+1,updated_ms=?
 WHERE source_id=? AND policy_revision=? AND version=? AND state='pending' RETURNING source_id`)
 .bind(page.at(-1)?.partition_key??cursor.after_partition_key,page.length<4?'complete':'pending',nowMs,sourceId,policyRevision,cursor.version));
 const result=await target.batch(admission.statements);
 return returnedD1Target(result.at(-1),'source_id',sourceId)?requests.length:0;
}
/** This compact outbox is filled in the native adoption transaction. A crash
 * before queue admission cannot lose any adopted date. Publication still uses
 * P7's exact current cohort, source closure and final lease/CAS guards. */
export async function admitMaintainedGraphPublications(input:{target:D1Database;sourceId:string;nowMs:number;
 policyRevision:string;stages?:readonly AnalyticsWorkStage[]}):Promise<number> {
 if(input.stages&&!input.stages.includes('publication'))return 0;
 const today=new Date(input.nowMs).toISOString().slice(0,10);
 const oldest=dateAt(input.nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);
 const rows=(await input.target.prepare(`SELECT metric,day,generation FROM analytics_partition_graph_dirty
 WHERE source_id=? AND generation>admitted_generation
 AND ((metric='model' AND day BETWEEN ? AND ?) OR (metric='fits' AND day=?)) ORDER BY metric,day LIMIT 4`)
 .bind(input.sourceId,oldest,today,today).all<{metric:'fits'|'model';day:string;generation:number}>()).results;
 const requests:AnalyticsWorkRequest[]=[];
 for(const row of rows)requests.push({sourceId:input.sourceId,ownerDigest:null,stage:'publication',lane:row.day===today?'new':'history',
 partitionKey:row.metric+'/'+row.day,headKey:await digest(['graph-publication',input.sourceId,row.metric,row.day]),
 inputRevision:await digest([row.metric,row.day,row.generation]),policyRevision:input.policyRevision,
 day:row.day,stream:null,selectionMethod:null,residentBytes:16*1024*1024,admissionQueries:600});
 const admission=await analyticsWorkAdmissionStatements(input.target,requests,input.nowMs);
 for(const row of rows)admission.statements.push(input.target.prepare(`UPDATE analytics_partition_graph_dirty SET admitted_generation=?
 WHERE source_id=? AND metric=? AND day=? AND generation=?`).bind(row.generation,input.sourceId,row.metric,row.day,row.generation));
 if(admission.statements.length)await input.target.batch(admission.statements);return requests.length;
}

interface GraphSubject {subject_key:string;source_id:string;owner_digest:string;selection_method:'effective-union-v1'|'legacy-selected-v1';policy_revision:string;clock_day:string;version:number}
interface GraphDemand {metric:'fits'|'model';day:string;input_revision:string;policy_revision:string;generation:number;admitted_generation:number}
interface GraphInputRef {scope_key:string;subject_key:string;source_day:string;source_stamp:string;generation:number}
const DAY_MS=86_400_000;
const dateAt=(ms:number)=>new Date(ms).toISOString().slice(0,10);
const subjectSql=`SELECT subject_key,source_id,owner_digest,selection_method,policy_revision,clock_day,version FROM analytics_partition_graph_subjects`;
function outputDays(today:string,inputDay?:string):string[] {
 const end=Date.parse(today),start=end-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS;
 const from=inputDay===undefined?start:Math.max(start,Date.parse(inputDay));
 const through=inputDay===undefined?end:Math.min(end,Date.parse(inputDay)+V1_ANALYSIS_WINDOW_DAYS*DAY_MS);
 const result:string[]=[];for(let ms=from;ms<=through;ms+=DAY_MS)result.push(dateAt(ms));return result;
}
/** Public for exact boundary tests; model dependencies include both cutoff and
 * output days. Legacy current fits retain the native open upper bound. */
export function maintainedGraphAffectedDates(input:{day:string;today:string;selectionMethod:'effective-union-v1'|'legacy-selected-v1'}):{model:readonly string[];fits:boolean} {
 modelHistoryWindow(input.day);const history=modelHistoryWindow(input.today);
 return {model:outputDays(input.today,input.day),fits:input.day>=history.fromDay
  &&(input.selectionMethod==='legacy-selected-v1'||input.day<=input.today)};
}
async function updateGraphDemands(input:{target:D1Database;subject:GraphSubject;policyRevision:string;nowMs:number;
 dates:readonly {metric:'fits'|'model';day:string}[];cause:unknown;ref?:GraphInputRef;clockDay?:string}):Promise<boolean> {
 const {target,subject,ref}=input;
 const prior=(await target.prepare(`SELECT metric,day,input_revision,policy_revision,generation,admitted_generation
 FROM analytics_partition_graph_demands WHERE subject_key=? AND day BETWEEN ? AND ?`).bind(subject.subject_key,
 dateAt(input.nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS),dateAt(input.nowMs)).all<GraphDemand>()).results;
 const byKey=new Map(prior.map(row=>[row.metric+'/'+row.day,row]));
 const rows=await Promise.all(input.dates.map(async row=>{const previous=byKey.get(row.metric+'/'+row.day);
  return {...row,revision:await digest(['maintained-graph-demand-v1',previous?.input_revision??null,input.cause,
   input.policyRevision,row.metric,row.day]),generation:(previous?.generation??0)+1};}));
 const guard=`EXISTS(SELECT 1 FROM analytics_partition_graph_subjects s WHERE s.subject_key=? AND s.version=?)`
  +(ref?` AND EXISTS(SELECT 1 FROM analytics_partition_graph_input_refs r JOIN analytics_canonical_input_work w USING(scope_key)
   WHERE r.scope_key=? AND r.generation=? AND r.applied_generation<r.generation AND w.state='sealed' AND w.source_stamp=r.source_stamp)`:'');
 const values:(string|number)[]=[subject.subject_key,subject.version,...(ref?[ref.scope_key,ref.generation]:[])];
 const statements=[target.prepare(`INSERT INTO analytics_partition_graph_demands
 (subject_key,source_id,owner_digest,metric,day,input_revision,policy_revision,generation,updated_ms)
 SELECT ?,?,?,json_extract(value,'$.metric'),json_extract(value,'$.day'),json_extract(value,'$.revision'),?,json_extract(value,'$.generation'),?
 FROM json_each(?) WHERE ${guard}
 ON CONFLICT(subject_key,metric,day) DO UPDATE SET input_revision=excluded.input_revision,policy_revision=excluded.policy_revision,
 generation=excluded.generation,updated_ms=excluded.updated_ms`)
 .bind(subject.subject_key,subject.source_id,subject.owner_digest,input.policyRevision,input.nowMs,JSON.stringify(rows),...values)];
 if(ref)statements.push(target.prepare(`UPDATE analytics_partition_graph_input_refs SET applied_generation=generation
 WHERE scope_key=? AND generation=? AND ${guard}`).bind(ref.scope_key,ref.generation,...values));
 // The ref was advanced by the preceding statement. The subject CAS remains
 // the common transaction guard, without requiring the ref to stay pending.
 statements.push(target.prepare(`UPDATE analytics_partition_graph_subjects SET version=version+1${input.clockDay?',clock_day=?,policy_revision=?':''}
 WHERE subject_key=? AND version=? ${ref?`AND EXISTS(SELECT 1 FROM analytics_partition_graph_input_refs r JOIN analytics_canonical_input_work w USING(scope_key)
 WHERE r.scope_key=? AND r.generation=? AND r.applied_generation=r.generation AND w.state='sealed' AND w.source_stamp=r.source_stamp)`:''} RETURNING subject_key`)
 .bind(...(input.clockDay?[input.clockDay,input.policyRevision]:[]),subject.subject_key,subject.version,...(ref?[ref.scope_key,ref.generation]:[])));
 const result=await target.batch(statements);return returnedD1Target(result.at(-1),'subject_key',subject.subject_key);
}
export interface MaintainedGraphComputationsInput {target:D1Database;sourceId:string;nowMs:number;policyRevision:string;stages?:readonly AnalyticsWorkStage[]}
/** Bounded exact scope outbox + clock/policy pages. Individual dates preserve
 * disjoint influence; no median or fit arithmetic occurs in this module. */
export async function admitMaintainedGraphComputations(input:MaintainedGraphComputationsInput):Promise<number> {
 if(input.stages&&!input.stages.includes('fits'))return 0;
 const {target,sourceId,policyRevision,nowMs}=input,today=dateAt(nowMs);
 await target.prepare(`INSERT INTO analytics_partition_graph_control(source_id,policy_revision,anchor_day) VALUES(?,?,?)
 ON CONFLICT(source_id) DO UPDATE SET policy_revision=excluded.policy_revision,anchor_day=excluded.anchor_day,
 after_subject_key=NULL,scan_complete=0,version=version+1 WHERE policy_revision!=excluded.policy_revision OR anchor_day!=excluded.anchor_day`)
 .bind(sourceId,policyRevision,today).run();
 const afterInput=await target.prepare('SELECT after_input_key FROM analytics_partition_graph_control WHERE source_id=?')
 .bind(sourceId).first<string|null>('after_input_key');
 const readRefs=async(after:string)=>(await target.prepare(`SELECT r.scope_key,r.subject_key,r.source_day,r.source_stamp,r.generation
 FROM analytics_partition_graph_input_refs r JOIN analytics_canonical_input_work w USING(scope_key)
 WHERE r.source_id=? AND r.generation>r.applied_generation AND r.scope_key>? AND w.state='sealed' AND w.source_stamp=r.source_stamp
 ORDER BY r.scope_key LIMIT 4`).bind(sourceId,after).all<GraphInputRef>()).results;
 let refs=await readRefs(afterInput??'');if(!refs.length&&afterInput)refs=await readRefs('');
 for(const ref of refs){const subject=await target.prepare(subjectSql+' WHERE subject_key=?').bind(ref.subject_key).first<GraphSubject>();if(!subject)continue;
  const affected=maintainedGraphAffectedDates({day:ref.source_day,today,selectionMethod:subject.selection_method});
  await updateGraphDemands({target,subject,policyRevision,nowMs,ref,cause:['input',ref.scope_key,ref.source_stamp,ref.generation],
   dates:[...affected.model.map(day=>({metric:'model' as const,day})),...(affected.fits?[{metric:'fits' as const,day:today}]:[])]});
 }
 if(refs.length)await target.prepare(`UPDATE analytics_partition_graph_control SET after_input_key=
 (SELECT scope_key FROM analytics_partition_graph_input_refs WHERE scope_key=?) WHERE source_id=?`)
 .bind(refs.at(-1)!.scope_key,sourceId).run();
 const control=await target.prepare(`SELECT after_subject_key,scan_complete,turn,version FROM analytics_partition_graph_control WHERE source_id=?`)
 .bind(sourceId).first<{after_subject_key:string|null;scan_complete:number;turn:number;version:number}>();if(!control)return 0;
 // Sealed new subjects reopen this cursor atomically. A warm completed scan
 // performs no owner enumeration, and a concurrent addition changes its CAS.
 if(!control.scan_complete) {
 const page=(await target.prepare(subjectSql+` WHERE source_id=? AND subject_key>? AND (policy_revision!=? OR clock_day!=?)
 ORDER BY subject_key LIMIT 4`).bind(sourceId,control.after_subject_key??'',policyRevision,today).all<GraphSubject>()).results;
 let advanced=true;
 for(const subject of page){const policyChanged=subject.policy_revision!==policyRevision;
  advanced=await updateGraphDemands({target,subject,policyRevision,nowMs,clockDay:today,cause:['clock-policy',today,policyRevision],
   dates:[{metric:'fits',day:today},...(policyChanged?outputDays(today):[today]).map(day=>({metric:'model' as const,day}))]})&&advanced;
 }
 if(advanced)await target.prepare(`UPDATE analytics_partition_graph_control SET after_subject_key=
 (SELECT subject_key FROM analytics_partition_graph_subjects WHERE subject_key=?),scan_complete=?,version=version+1
 WHERE source_id=? AND version=?`).bind(page.at(-1)?.subject_key??control.after_subject_key,page.length<4?1:0,sourceId,control.version).run();
 }
 let turn=control.turn,admitted=0;
 for(let count=0;count<4;count++) {
  let chosen:(GraphDemand&GraphSubject)|null=null;
  for(let probe=0;probe<3;probe++) {
   const lane=(turn+probe)%3;
   const condition=lane===0?"d.metric='fits' AND d.day=?":lane===1?"d.metric='model' AND d.day>=?":"d.metric='model' AND d.day<?";
   const date=lane===0?today:dateAt(nowMs-6*DAY_MS);
   chosen=await target.prepare(`SELECT d.metric,d.day,d.input_revision,d.policy_revision,d.generation,d.admitted_generation,
    s.subject_key,s.source_id,s.owner_digest,s.selection_method,s.clock_day,s.version FROM analytics_partition_graph_demands d
    JOIN analytics_partition_graph_subjects s USING(subject_key) JOIN analytics_owner_state o ON o.source_id=s.source_id AND o.owner_digest=s.owner_digest
    WHERE d.source_id=? AND d.generation>d.admitted_generation AND d.policy_revision=? AND s.policy_revision=? AND s.clock_day=?
    AND o.state='active' AND d.day>=? AND d.day<=? AND ${condition}
    AND NOT EXISTS(SELECT 1 FROM analytics_partition_graph_input_refs r WHERE r.subject_key=s.subject_key AND r.generation>r.applied_generation
     AND r.source_day>=date(d.day,?) AND (r.source_day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
    AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work pending WHERE pending.source_id=s.source_id AND pending.owner_digest=s.owner_digest
     AND pending.selection_method=s.selection_method AND pending.state!='sealed' AND pending.source_day>=date(d.day,'-${V1_ANALYSIS_WINDOW_DAYS} days')
     AND (pending.source_day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
    AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=s.source_id AND w.owner_digest=s.owner_digest
     AND w.stage='canonical' AND w.selection_method=s.selection_method AND w.state!='complete' AND NOT(w.state='refused' AND w.reason_code='obsolete_input')
     AND w.day>=date(d.day,?) AND (w.day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
    AND NOT EXISTS(SELECT 1 FROM analytics_partition_ranges r WHERE r.source_id=s.source_id AND r.owner_digest=s.owner_digest
     AND (r.state!='complete' OR r.acknowledged=0) AND r.through_day>=date(d.day,?)
     AND (r.from_day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
    ORDER BY d.updated_ms,d.day DESC,s.subject_key LIMIT 1`)
   .bind(sourceId,policyRevision,policyRevision,today,dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS),today,date,
    '-'+V1_ANALYSIS_WINDOW_DAYS+' days','-'+V1_ANALYSIS_WINDOW_DAYS+' days','-'+V1_ANALYSIS_WINDOW_DAYS+' days').first<GraphDemand&GraphSubject>();
   if(chosen){turn=(lane+1)%3;break;}
  }
  if(!chosen)break;const row=chosen;
  const request:AnalyticsWorkRequest={sourceId,ownerDigest:row.owner_digest,stage:'fits',lane:row.metric==='fits'||row.day===today?'new':'history',
   partitionKey:'graph/'+row.metric+'/'+row.owner_digest,headKey:await digest(['graph-computation',sourceId,row.owner_digest,row.selection_method,row.metric,row.day]),
   inputRevision:row.input_revision,policyRevision,day:row.day,stream:null,selectionMethod:row.selection_method,residentBytes:8*1024*1024,admissionQueries:600};
  const admission=await analyticsWorkAdmissionStatements(target,[request],nowMs);
  admission.statements.push(target.prepare(`UPDATE analytics_partition_graph_demands SET admitted_generation=generation
   WHERE subject_key=? AND metric=? AND day=? AND generation=? AND input_revision=?`).bind(row.subject_key,row.metric,row.day,row.generation,row.input_revision));
  admission.statements.push(target.prepare('UPDATE analytics_partition_graph_control SET turn=? WHERE source_id=?').bind(turn,sourceId));
  await target.batch(admission.statements);admitted++;
 }
 // Product output retention, never source-data retention. Subject input refs
 // remain until their owning source proof is physically retired or erased.
 await target.prepare(`DELETE FROM analytics_partition_graph_demands WHERE (subject_key,metric,day) IN(
 SELECT subject_key,metric,day FROM analytics_partition_graph_demands WHERE source_id=?
 AND ((metric='fits' AND day!=?) OR day<?) ORDER BY day,subject_key LIMIT 16)`)
 .bind(sourceId,today,dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS)).run();
 return admitted;
}
/** Canonical completion cannot outrun the sealed-input outbox. Its trigger was
 * committed with the native seal; this writer checks it under the live lease. */
export async function completeMaintainedCanonicalInput(input:{target:D1Database;lease:AnalyticsWorkLease;seal:CanonicalInputSeal;nowMs:number}):Promise<boolean> {
 const {target,lease,seal,nowMs}=input;
 const result=await target.prepare(`UPDATE analytics_partition_work SET state='complete',revision=revision+1,claim_token=NULL,claim_expires_ms=0,updated_ms=?
 WHERE work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?
 AND EXISTS(SELECT 1 FROM analytics_partition_graph_input_refs r JOIN analytics_canonical_input_work w USING(scope_key)
 WHERE r.scope_key=? AND r.source_stamp=? AND w.state='sealed' AND w.source_stamp=r.source_stamp
 AND w.source_id=analytics_partition_work.source_id AND w.owner_digest=analytics_partition_work.owner_digest
 AND w.source_day=analytics_partition_work.day AND w.stream=analytics_partition_work.stream AND w.selection_method=analytics_partition_work.selection_method)
 RETURNING work_key`).bind(nowMs,lease.workKey,lease.revision,lease.claimToken,nowMs,seal.scopeKey,seal.sourceStamp).run();
 return returnedD1Target(result,'work_key',lease.workKey);
}
export async function maintainedGraphWorkIsCurrent(target:D1Database,work:AnalyticsStoredWork,nowMs:number):Promise<boolean> {
 const match=/^graph\/(fits|model)\/([a-f0-9]{64})$/u.exec(work.partitionKey);if(!match||work.ownerDigest!==match[2]||!work.day)return false;
 const today=dateAt(nowMs);if(match[1]==='fits'&&work.day!==today||work.day<dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS)||work.day>today)return false;
 return await target.prepare(`SELECT 1 ready FROM analytics_partition_graph_demands d JOIN analytics_partition_graph_subjects s USING(subject_key)
 WHERE d.source_id=? AND d.owner_digest=? AND s.selection_method=? AND d.metric=? AND d.day=? AND d.input_revision=? AND d.policy_revision=?
 AND d.generation=d.admitted_generation AND s.policy_revision=d.policy_revision AND s.clock_day=?
 AND NOT EXISTS(SELECT 1 FROM analytics_partition_graph_input_refs r WHERE r.subject_key=s.subject_key AND r.generation>r.applied_generation
  AND r.source_day>=date(d.day,?) AND (r.source_day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work pending WHERE pending.source_id=s.source_id AND pending.owner_digest=s.owner_digest
     AND pending.selection_method=s.selection_method AND pending.state!='sealed' AND pending.source_day>=date(d.day,'-${V1_ANALYSIS_WINDOW_DAYS} days')
     AND (pending.source_day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
    AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=s.source_id AND w.owner_digest=s.owner_digest
  AND w.stage='canonical' AND w.selection_method=s.selection_method AND w.state!='complete' AND NOT(w.state='refused' AND w.reason_code='obsolete_input')
  AND w.day>=date(d.day,?) AND (w.day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))
 AND NOT EXISTS(SELECT 1 FROM analytics_partition_ranges r WHERE r.source_id=s.source_id AND r.owner_digest=s.owner_digest
  AND (r.state!='complete' OR r.acknowledged=0) AND r.through_day>=date(d.day,?)
  AND (r.from_day<=d.day OR d.metric='fits' AND s.selection_method='legacy-selected-v1'))`)
 .bind(work.sourceId,work.ownerDigest,work.selectionMethod,match[1],work.day,work.inputRevision,work.policyRevision,today,
 '-'+V1_ANALYSIS_WINDOW_DAYS+' days','-'+V1_ANALYSIS_WINDOW_DAYS+' days','-'+V1_ANALYSIS_WINDOW_DAYS+' days')
 .first<number>('ready')===1;
}

/** Retire only a provably superseded immutable request. A missing manifest by
 * itself is insufficient: a current replacement head/job or all16 admitted
 * split children must exist. Refusal records obsolescence, never calculation. */
export async function closeObsoleteAnalyticsManifestWork(target:D1Database,lease:AnalyticsWorkLease,nowMs:number):Promise<boolean> {
 const work=await readAnalyticsPartitionWork(target,lease,nowMs);if(!work)return false;
 const graph=/^graph\/(fits|model)\/([a-f0-9]{64})$/u.exec(work.partitionKey);
 if(graph&&work.stage==='fits'&&work.ownerDigest&&work.day) {
  const today=dateAt(nowMs),oldDate=work.day<dateAt(nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);
  const result=await target.prepare(`UPDATE analytics_partition_work SET state='refused',reason_code='obsolete_input',revision=revision+1,
   claim_token=NULL,claim_expires_ms=0,updated_ms=? WHERE work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?
   AND (?=1 OR EXISTS(SELECT 1 FROM analytics_partition_graph_demands d JOIN analytics_partition_graph_subjects s USING(subject_key)
    JOIN analytics_partition_work next ON next.source_id=d.source_id AND next.owner_digest=d.owner_digest AND next.stage='fits'
     AND next.partition_key='graph/'||d.metric||'/'||d.owner_digest AND next.day=d.day AND next.input_revision=d.input_revision
     AND next.policy_revision=d.policy_revision AND next.selection_method=s.selection_method AND next.state IN('ready','leased','complete')
    WHERE d.source_id=? AND d.owner_digest=? AND s.selection_method=? AND d.metric=? AND d.day=?
     AND d.generation=d.admitted_generation AND (d.input_revision!=? OR d.policy_revision!=? OR d.day!=?))) RETURNING work_key`)
   .bind(nowMs,lease.workKey,lease.revision,lease.claimToken,nowMs,oldDate?1:0,work.sourceId,work.ownerDigest,work.selectionMethod,
    graph[1],graph[1]==='fits'?today:work.day,work.inputRevision,work.policyRevision,work.day).run();
  return returnedD1Target(result,'work_key',lease.workKey);
 }
 const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u.exec(work.partitionKey);
 if(!match||!['features','activity','cache','publication'].includes(work.stage))return false;
 const root=work.partitionKey.slice(0,-match[4]!.length)+match[4]!.slice(0,2);
 const dirty=await target.prepare(`SELECT d.generation,w.admitted_generation FROM analytics_canonical_dirty_partitions d
 JOIN analytics_partition_dirty_work w ON w.partition_key=d.partition_key AND w.source_id=? WHERE d.partition_key=?`)
 .bind(work.sourceId,root).first<{generation:number;admitted_generation:number}>();
 if(!dirty)return false;const replacementRevision=await digest([root,dirty.generation]);
 const result=await target.prepare(`UPDATE analytics_partition_work SET state='refused',reason_code='obsolete_input',revision=revision+1,
 claim_token=NULL,claim_expires_ms=0,updated_ms=? WHERE work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?
 AND (EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
  JOIN analytics_partition_work next ON next.source_id=? AND next.stage=? AND next.partition_key=h.partition_key AND next.input_revision=h.content_revision
  AND next.state IN('ready','leased','complete') WHERE h.partition_key=? AND h.content_revision!=? AND m.state='complete'
  AND m.generation=(SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?))
 OR EXISTS(SELECT 1 FROM analytics_partition_dirty_work d JOIN analytics_canonical_dirty_partitions native USING(partition_key)
  JOIN analytics_partition_work next ON next.source_id=d.source_id AND next.partition_key=d.partition_key AND next.stage='features'
   AND next.input_revision=? AND next.state IN('ready','leased','complete')
  WHERE d.source_id=? AND d.partition_key=? AND d.generation=? AND native.generation=d.generation AND d.admitted_generation>=d.generation
   AND ((?='features' AND ?!=?) OR EXISTS(SELECT 1 FROM analytics_canonical_manifests old WHERE old.content_revision=? AND old.generation<d.generation)))
 OR (SELECT count(DISTINCT substr(next.partition_key,length(?)+1,1)) FROM analytics_partition_work next
  WHERE next.source_id=? AND next.stage='features' AND next.input_revision=? AND next.state IN('ready','leased','complete')
  AND substr(next.partition_key,-1,1) GLOB '[0-9a-f]' AND length(next.partition_key)=length(?)+1 AND substr(next.partition_key,1,length(?))=?
  AND EXISTS(SELECT 1 FROM analytics_partition_dirty_work d JOIN analytics_canonical_dirty_partitions native USING(partition_key)
   WHERE d.source_id=? AND d.partition_key=? AND d.generation=? AND native.generation=d.generation AND d.admitted_generation>=d.generation))=16)
 RETURNING work_key`).bind(nowMs,lease.workKey,lease.revision,lease.claimToken,nowMs,
 work.sourceId,work.stage,work.partitionKey,work.inputRevision,root,
 replacementRevision,work.sourceId,root,dirty.generation,work.stage,work.inputRevision,replacementRevision,work.inputRevision,
 work.partitionKey,work.sourceId,replacementRevision,work.partitionKey,work.partitionKey,work.partitionKey,work.sourceId,root,dirty.generation).run();
 return returnedD1Target(result,'work_key',lease.workKey);
}

/** Publication notifications outside the product horizon are metadata only.
 * Ready/live date work, current empty evidence and future dates are retained. */
export async function retireMaintainedGraphWork(target:D1Database,input:{sourceId:string;nowMs:number;limit?:number}):Promise<number> {
 const limit=input.limit??16;
 if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(input.sourceId)||!Number.isSafeInteger(input.nowMs)||input.nowMs<0
  ||!Number.isSafeInteger(limit)||limit<1||limit>32)throw new Error('ANALYTICS_RETIREMENT_INVALID');
 const today=dateAt(input.nowMs),oldest=dateAt(input.nowMs-(ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS-1)*DAY_MS);
 const result=await target.prepare(`DELETE FROM analytics_partition_graph_dirty WHERE (source_id,metric,day) IN(
  SELECT d.source_id,d.metric,d.day FROM analytics_partition_graph_dirty d WHERE d.source_id=?
  AND ((d.metric='fits' AND d.day<?) OR (d.metric='model' AND d.day<?))
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=d.source_id AND w.day=d.day
   AND w.stage IN('fits','publication') AND w.state IN('ready','leased'))
  ORDER BY d.day,d.metric LIMIT ?) RETURNING day`).bind(input.sourceId,today,oldest,limit).all<{day:string}>();
 return result.results.length;
}
