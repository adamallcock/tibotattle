import { requireAuthorityRestoreServingReady } from './authority-restore';
import { maintainedAnalyticsPolicyRevision } from './storage-analytics-maintained-work';
import { storageTerminalPayloadAbsent } from './storage-erasure';
import { readIngestionChanges } from './analytics-delivery';
import { lookupV11StorageSource } from './v11-storage-journal';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { D1InvocationBudgetExceededError,type D1InvocationBudget } from './d1-invocation-budget';
import { readStorageCommunityOwner,type StorageCommunityOwner } from './storage-community-authority';
import { acknowledgeEffectiveDependencyAffectedRanges,acknowledgeEffectiveDependencyGlobalChange,
  advanceEffectiveDependencyCoverage,readEffectiveDependencyAffectedRanges,readEffectiveDependencyGlobalChange,
  readEffectiveScopeMutationToken,readEffectiveDependencySourceFence,
  type EffectiveDependencyAffectedRange } from './storage-effective-selective-dependencies';
import { analyticsPartitionWorkAvailable,analyticsWorkAdmissionStatements,type AnalyticsWorkRequest,
  type AnalyticsWorkLane } from './storage-analytics-partition-work';
import { readCanonicalWorkEffects } from './storage-canonical-analytics-facts';
import { returnedD1Target } from './d1-direct-write';

export interface AnalyticsWorkEffectsInput {
 readonly source:D1Database;readonly target:D1Database;readonly sourceId:string;readonly sourceNamespace:string;
 readonly meter:D1InvocationBudget;readonly now:()=>number;readonly deadlineMs:number;
 readonly maxEffects?:number;readonly maxDays?:number;
}
export interface AnalyticsWorkEffectsProgress {
 readonly state:'idle'|'progress'|'deferred'|'unavailable';readonly reason?:'capacity'|'query_budget';readonly rangesAdmitted:number;readonly rangesAcknowledged:number;
 readonly daysAdmitted:number;readonly canonicalEffects:number;readonly globalOwners:number;readonly statements:number;
}
interface RangeRow {
 effect_key:string;source_id:string;owner_digest:string;from_day:string;through_day:string;next_day:string;
 stream:EffectiveDependencyAffectedRange['stream'];source_stamp:number;source_from_day:string|null;source_through_day:string|null;
 selection_method:AnalyticsWorkRequest['selectionMethod'];lane:AnalyticsWorkLane;version:number;acknowledged:number;
}
const policy=maintainedAnalyticsPolicyRevision;
const shift=(day:string,count:number)=>new Date(Date.parse(day+'T00:00:00.000Z')+count*86_400_000).toISOString().slice(0,10);
const digest=(value:unknown)=>sha256Hex(canonicalJson(value));
const invalid=()=>new Error('ANALYTICS_WORK_EFFECTS_INVALID');
const available=(input:AnalyticsWorkEffectsInput,reserve=100)=>input.meter.remainingQueries>=reserve&&input.now()<input.deadlineMs-1500;
function valid(input:AnalyticsWorkEffectsInput):void {
 if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(input.sourceId)||!input.sourceNamespace||input.sourceNamespace.length>256
 ||!Number.isSafeInteger(input.maxEffects??4)||(input.maxEffects??4)<1||(input.maxEffects??4)>16
 ||!Number.isSafeInteger(input.maxDays??2)||(input.maxDays??2)<1||(input.maxDays??2)>4)throw invalid();
}
async function ownerByParticipant(source:D1Database,participantId:string):Promise<StorageCommunityOwner|null> {
 const owner=await source.prepare(`SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=? AND state='active'`)
 .bind(participantId).first<{owner_digest:string}>();
 return owner?readStorageCommunityOwner(source,{ownerDigest:owner.owner_digest}):null;
}
async function targetReady(target:D1Database,sourceId:string,ownerDigest:string):Promise<boolean> {
 return await target.prepare(`SELECT 1 ready FROM analytics_owner_state o WHERE source_id=? AND owner_digest=? AND state='active'
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)`)
 .bind(sourceId,ownerDigest).first<number>('ready')===1;
}
async function retainedRange(source:D1Database,target:D1Database,sourceId:string,owner:StorageCommunityOwner):Promise<{from:string;through:string}|null> {
 const sourceRange=await source.prepare(`SELECT MIN(source_day) AS first,MAX(source_day) AS last
 FROM storage_effective_source_days WHERE participant_id=?`).bind(owner.participantId).first<{first:string|null;last:string|null}>();
 const targetRange=await target.prepare(`SELECT MIN(source_day) AS first,MAX(source_day) AS last FROM analytics_canonical_input_work
 WHERE source_id=? AND owner_digest=?`).bind(sourceId,owner.ownerDigest).first<{first:string|null;last:string|null}>();
 const first=[sourceRange?.first,targetRange?.first].filter((v):v is string=>!!v).sort();
 const last=[sourceRange?.last,targetRange?.last].filter((v):v is string=>!!v).sort();
 return first.length&&last.length?{from:first[0]!,through:last.at(-1)!}:null;
}
interface EmptyProof {digest:string;generation:number;ownerRevision:number;authorityEpoch:number}
interface EmptyRow {effect_key:string;owner_digest:string;source_stamp:number;from_day:string|null;through_day:string|null;
 stream:EffectiveDependencyAffectedRange['stream'];global_change:number}
async function emptyProof(input:AnalyticsWorkEffectsInput,source:D1Database,target:D1Database,owner:StorageCommunityOwner):Promise<EmptyProof|null>{
 if(!owner.ownerDigest||owner.hasV1||owner.hasV11||owner.hasV12||owner.hasLegacy||owner.hasEffective)return null;
 const before=await readEffectiveDependencySourceFence(source);if(!before)return null;
 // The token proves complete owner coverage even for an empty requested day;
 // the following indexed existence checks prove there is no retained day at all.
 const day=new Date(input.now()).toISOString().slice(0,10);
 const token=await readEffectiveScopeMutationToken(source,{participantId:owner.participantId,ownerDigest:owner.ownerDigest,
  sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,fromDay:day,throughDay:day,includeSessions:true});
 if(!token)return null;
 const empty=await source.prepare(`SELECT 1 FROM storage_effective_selective_owners c
 WHERE c.participant_id=? AND c.owner_digest=? AND c.source_namespace=? AND c.seeded=1 AND c.needs_work=0
 AND NOT EXISTS(SELECT 1 FROM storage_effective_source_days d WHERE d.participant_id=c.participant_id)
 AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_variants v WHERE v.participant_id=c.participant_id)
 AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_work w WHERE w.participant_id=c.participant_id)
 AND NOT EXISTS(SELECT 1 FROM storage_effective_selective_reverse_work w WHERE w.participant_id=c.participant_id)`)
 .bind(owner.participantId,owner.ownerDigest,input.sourceNamespace).first();if(!empty)return null;
 const targetEmpty=await target.prepare(`SELECT 1 FROM analytics_owner_state o JOIN analytics_runtime_sources r USING(source_id)
 WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.revision=? AND o.authority_epoch=?
 AND r.source_namespace=? AND r.contract_version=1
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work w WHERE w.source_id=o.source_id AND w.owner_digest=o.owner_digest)
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_facts f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)`)
 .bind(input.sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch,input.sourceNamespace).first();
 const after=await readEffectiveDependencySourceFence(source);
 if(!targetEmpty||!after||after.generation!==before.generation||token.validUntilMs<=input.now())return null;
 return {digest:await digest(['source-empty-outcome-v1',input.sourceId,input.sourceNamespace,owner.ownerDigest,owner.ownerRevision,
  owner.authorityEpoch,token.stamp,after]),generation:after.generation,ownerRevision:owner.ownerRevision,authorityEpoch:owner.authorityEpoch};
}
async function saveEmpty(input:AnalyticsWorkEffectsInput,source:D1Database,target:D1Database,owner:StorageCommunityOwner,
 range:EffectiveDependencyAffectedRange,global=false):Promise<{key:string;proof:EmptyProof}|null>{
 const proof=await emptyProof(input,source,target,owner);if(!proof)return null;
 const key=await digest(['source-empty-outcome-v1',global,input.sourceId,owner.ownerDigest,range.fromDay,range.throughDay,range.stream,range.stamp]);
 await target.prepare(`INSERT INTO analytics_partition_empty_outcomes(effect_key,source_id,owner_digest,source_namespace,source_stamp,
 from_day,through_day,stream,global_change,proof_digest,owner_revision,authority_epoch,source_generation,updated_ms)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(effect_key) DO UPDATE SET proof_digest=excluded.proof_digest,
 owner_revision=excluded.owner_revision,authority_epoch=excluded.authority_epoch,source_generation=excluded.source_generation,updated_ms=excluded.updated_ms`)
 .bind(key,input.sourceId,owner.ownerDigest,input.sourceNamespace,range.stamp,range.fromDay,range.throughDay,range.stream,
 global?1:0,proof.digest,proof.ownerRevision,proof.authorityEpoch,proof.generation,input.now()).run();
 const fresh=await emptyProof(input,source,target,owner);
 return fresh?.digest===proof.digest?{key,proof}:null;
}
async function terminalProof(input:AnalyticsWorkEffectsInput,source:D1Database,target:D1Database,subject:{participantId:string}|{ownerDigest:string}):Promise<string|null>{
 const before=await readEffectiveDependencySourceFence(source);if(!before)return null;
 const row=await source.prepare(`SELECT r.owner_digest,c.sequence FROM storage_owner_revisions r JOIN storage_ingestion_changes c ON c.owner_digest=r.owner_digest AND c.revision=r.revision
 JOIN storage_source_state s ON s.singleton=1 AND s.source_id=?
 JOIN typed_v1_admission_state a ON a.id=1 AND a.source_namespace=? AND a.runtime_contract_version=1
 JOIN typed_v11_admission_state b ON b.id=1 AND b.source_namespace=a.source_namespace AND b.runtime_contract_version=1
 WHERE ${'participantId' in subject?'EXISTS(SELECT 1 FROM storage_v11_owner_links l WHERE l.owner_digest=r.owner_digest AND l.participant_id=?)':'r.owner_digest=?'} AND r.state IN('withdrawn','erased')
 AND c.kind=CASE r.state WHEN 'erased' THEN 'owner-erased' ELSE 'owner-withdrawn' END`)
 .bind(input.sourceId,input.sourceNamespace,'participantId' in subject?subject.participantId:subject.ownerDigest).first<{owner_digest:string;sequence:number}>();if(!row)return null;
 const event=(await readIngestionChanges(source,input.sourceId,row.sequence-1,1))[0];
 if(!event||event.ownerDigest!==row.owner_digest||!['owner-erased','owner-withdrawn'].includes(event.kind))return null;
 const native=await lookupV11StorageSource(source,event);if(native.disposition!=='discard'||native.reason!==event.kind)return null;
 const receipt=await target.prepare(`SELECT 1 FROM analytics_applied_events e JOIN analytics_source_cursors c USING(source_id)
 JOIN analytics_owner_state o ON o.source_id=e.source_id AND o.owner_digest=e.owner_digest
 JOIN analytics_runtime_sources runtime ON runtime.source_id=e.source_id AND runtime.source_namespace=? AND runtime.contract_version=1
 JOIN analytics_v1_owner_fences f ON f.source_id=o.source_id AND f.owner_digest=o.owner_digest
 WHERE e.source_id=? AND e.sequence=? AND e.event_digest=? AND e.owner_digest=? AND e.revision=? AND e.kind=?
 AND e.object_digest=? AND e.content_digest=? AND e.authority_epoch=? AND e.public_authority_epoch=? AND e.recorded_ms=?
 AND c.sequence>=e.sequence AND c.authority_epoch>=e.public_authority_epoch AND o.revision=e.revision AND o.authority_epoch=e.authority_epoch
 AND o.state=CASE e.kind WHEN 'owner-erased' THEN 'erased' ELSE 'withdrawn' END
 AND f.state=e.kind AND (?='owner-erased' OR (f.terminal_revision=e.revision AND f.terminal_sequence=e.sequence))
 AND (?!='owner-erased' OR EXISTS(SELECT 1 FROM analytics_storage_erasure_fences erased JOIN analytics_storage_erasure_receipts done
 ON done.source_id=erased.source_id AND done.owner_digest=erased.owner_digest AND done.terminal_event_digest=erased.terminal_event_digest
 WHERE erased.source_id=e.source_id AND erased.owner_digest=e.owner_digest AND done.payload_contract=1))`)
 .bind(input.sourceNamespace,input.sourceId,event.sequence,event.eventDigest,event.ownerDigest,event.revision,event.kind,event.objectDigest,
 event.contentDigest,event.authorityEpoch,event.publicAuthorityEpoch,event.recordedMs,event.kind,event.kind).first();
 if(!receipt||!await storageTerminalPayloadAbsent({source,target,sourceId:input.sourceId,sourceNamespace:input.sourceNamespace},event.ownerDigest,event.publicAuthorityEpoch))return null;
 const after=await readEffectiveDependencySourceFence(source);if(!after||after.generation!==before.generation)return null;
 return digest(['source-terminal-outcome-v1',event,after]);
}
async function outcomeSchema(target:D1Database):Promise<boolean>{
 return (await target.prepare(`SELECT count(*) n FROM sqlite_schema WHERE (type='table' AND name='analytics_partition_empty_outcomes')
 OR (type='trigger' AND name IN('analytics_partition_empty_admit','analytics_partition_empty_update','analytics_partition_empty_terminal',
 'analytics_partition_empty_erasure','analytics_partition_empty_erasure_replay'))`).first<number>('n'))===6;
}
function methods(owner:StorageCommunityOwner):readonly NonNullable<AnalyticsWorkRequest['selectionMethod']>[] {
 return owner.hasEffective?(owner.hasLegacy?['effective-union-v1','legacy-selected-v1']:['effective-union-v1']):['legacy-selected-v1'];
}
async function rangeStatements(target:D1Database,input:AnalyticsWorkEffectsInput,owner:StorageCommunityOwner,
 range:EffectiveDependencyAffectedRange,bounds:{from:string;through:string},lane:AnalyticsWorkLane,global=false):Promise<{keys:string[];statements:D1PreparedStatement[]}> {
 if(!owner.ownerDigest)throw invalid();const keys:string[]=[],statements:D1PreparedStatement[]=[];
 for(const method of methods(owner)) {
  const key=await digest(['analytics-source-effect-v1',global,input.sourceId,owner.ownerDigest,range.fromDay,range.throughDay,range.stream,range.stamp,method]);keys.push(key);
  statements.push(target.prepare(`INSERT INTO analytics_partition_ranges(effect_key,source_id,owner_digest,from_day,through_day,next_day,
   stream,selection_method,source_stamp,source_from_day,source_through_day,acknowledged,lane,updated_ms)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(effect_key) DO NOTHING`)
   .bind(key,input.sourceId,owner.ownerDigest,bounds.from,bounds.through,bounds.from,range.stream,method,range.stamp,
    range.fromDay,range.throughDay,global?1:0,lane,input.now()));
 }
 // An exact durable receipt fences a pending correction once. Advancing the
 // dirty generation refuses the old manifest and gives rebuilt empty/identical
 // content a distinct revision. Retry cannot repeatedly invalidate new work.
 statements.push(target.prepare(`INSERT INTO analytics_canonical_dirty_partitions(partition_key,generation)
  SELECT f.partition_key,1 FROM analytics_canonical_facts f
  WHERE f.source_id=? AND f.owner_digest=? AND (f.observed_day BETWEEN ? AND ? OR f.observed_day IS NULL)
  AND EXISTS(SELECT 1 FROM analytics_partition_ranges r WHERE r.effect_key IN(SELECT value FROM json_each(?)) AND r.invalidated=0)
  GROUP BY f.partition_key ON CONFLICT(partition_key) DO UPDATE SET generation=generation+1`)
  .bind(input.sourceId,owner.ownerDigest,bounds.from,bounds.through,JSON.stringify(keys)));
 statements.push(target.prepare(`UPDATE analytics_partition_ranges SET invalidated=1 WHERE effect_key IN(SELECT value FROM json_each(?))`)
  .bind(JSON.stringify(keys)));
 return {keys,statements};
}
/** Exact source ACKs are intentionally outside target D1 transactions. A failed
 * ACK or lost response leaves the same durable receipt/cursor safe to replay. */
async function admitSourceRanges(input:AnalyticsWorkEffectsInput,source:D1Database,target:D1Database,
 counts:{rangesAdmitted:number;rangesAcknowledged:number}):Promise<void> {
 const ranges=await readEffectiveDependencyAffectedRanges(source,input.maxEffects??4);
 for(const range of ranges) {
  if(!available(input,40))return;
  const owner=await ownerByParticipant(source,range.participantId);
  if(!owner?.ownerDigest){
   if(available(input,100)&&await terminalProof(input,source,target,{participantId:range.participantId})){
    await acknowledgeEffectiveDependencyAffectedRanges(source,[range]);counts.rangesAcknowledged++;
   }continue;
  }
  if(!await targetReady(target,input.sourceId,owner.ownerDigest))continue;
  const bounds=range.fromDay&&range.throughDay?{from:range.fromDay,through:range.throughDay}:await retainedRange(source,target,input.sourceId,owner);
  // No proven retained range is not a zero-result proof. Keep the effect until
  // catalog coverage or ordered source delivery makes its bounds available.
  if(!bounds){
   if(!available(input,100))return;
   const empty=await saveEmpty(input,source,target,owner,range);if(!empty)continue;
   await acknowledgeEffectiveDependencyAffectedRanges(source,[range]);
   await target.prepare('UPDATE analytics_partition_empty_outcomes SET acknowledged=1 WHERE effect_key=? AND proof_digest=?')
    .bind(empty.key,empty.proof.digest).run();counts.rangesAcknowledged++;continue;
  }
  const admission=await rangeStatements(target,input,owner,range,bounds,range.fromDay===null?'withdrawal':'new');
  await target.batch(admission.statements);counts.rangesAdmitted+=admission.keys.length;
  await acknowledgeEffectiveDependencyAffectedRanges(source,[range]);
  await target.prepare(`UPDATE analytics_partition_ranges SET acknowledged=1 WHERE effect_key IN(SELECT value FROM json_each(?))`)
   .bind(JSON.stringify(admission.keys)).run();counts.rangesAcknowledged++;
 }
 if(available(input,100)){
  const emptyRows=(await target.prepare(`SELECT * FROM analytics_partition_empty_outcomes WHERE source_id=? AND acknowledged=0 AND global_change=0
   ORDER BY updated_ms,effect_key LIMIT ?`).bind(input.sourceId,input.maxEffects??4).all<EmptyRow>()).results;
  for(const row of emptyRows){if(!available(input,100))break;
   const owner=await readStorageCommunityOwner(source,{ownerDigest:row.owner_digest});if(!owner)continue;
   const range={participantId:owner.participantId,fromDay:row.from_day,throughDay:row.through_day,stream:row.stream,stamp:row.source_stamp};
   const saved=await saveEmpty(input,source,target,owner,range);if(!saved)continue;
   await acknowledgeEffectiveDependencyAffectedRanges(source,[range]);
   await target.prepare('UPDATE analytics_partition_empty_outcomes SET acknowledged=1 WHERE effect_key=? AND proof_digest=?')
    .bind(saved.key,saved.proof.digest).run();counts.rangesAcknowledged++;
  }
 }
 // Repair the specific accepted-but-response-lost ACK. Only digest metadata is
 // durable; private source identity is resolved immediately before exact ACK.
 if(!available(input,30))return;
 const pending=(await target.prepare(`SELECT * FROM analytics_partition_ranges WHERE source_id=? AND acknowledged=0
  ORDER BY updated_ms,effect_key LIMIT ?`).bind(input.sourceId,input.maxEffects??4).all<RangeRow>()).results;
 for(const row of pending) {
  if(!available(input,12))return;
  const link=await source.prepare(`SELECT participant_id FROM storage_v11_owner_links WHERE owner_digest=?`)
   .bind(row.owner_digest).first<{participant_id:string}>();
  if(!link)continue;
  await acknowledgeEffectiveDependencyAffectedRanges(source,[{participantId:link.participant_id,fromDay:row.source_from_day,
   throughDay:row.source_through_day,stream:row.stream,stamp:row.source_stamp}]);
  await target.prepare(`UPDATE analytics_partition_ranges SET acknowledged=1 WHERE effect_key=?`).bind(row.effect_key).run();
  counts.rangesAcknowledged++;
 }
}
async function expandSourceRange(input:AnalyticsWorkEffectsInput,target:D1Database):Promise<number> {
 const row=await target.prepare(`SELECT * FROM analytics_partition_ranges WHERE source_id=? AND state='pending'
  ORDER BY updated_ms,effect_key LIMIT 1`).bind(input.sourceId).first<RangeRow>();
 if(!row)return 0;const jobs:AnalyticsWorkRequest[]=[];let day=row.next_day,days=0;
 const methodRevision=await policy(),streams=row.stream==='all'?['usage','quota','session'] as const:[row.stream];
 while(day<=row.through_day&&days<(input.maxDays??2)) {
  for(const stream of streams) {
   const partitionKey='input/'+await digest([input.sourceId,row.owner_digest,day,stream,row.selection_method]);
   jobs.push({sourceId:input.sourceId,ownerDigest:row.owner_digest,stage:'canonical',lane:row.lane,partitionKey,
    headKey:await digest(['canonical',partitionKey]),inputRevision:await digest([row.effect_key,day,stream]),policyRevision:methodRevision,
    day,stream,selectionMethod:row.selection_method,residentBytes:4*1024*1024,admissionQueries:160});
  }
  days++;day=shift(day,1);
 }
 const admission=await analyticsWorkAdmissionStatements(target,jobs,input.now());
 admission.statements.push(target.prepare(`UPDATE analytics_partition_ranges SET next_day=?,state=?,version=version+1,updated_ms=?
  WHERE effect_key=? AND version=? AND state='pending' RETURNING effect_key`)
  .bind(day,day>row.through_day?'complete':'pending',input.now(),row.effect_key,row.version));
 const results=await target.batch(admission.statements);
 return returnedD1Target(results.at(-1),'effect_key',row.effect_key)?days:0;
}
/** A global cursor reaching EOF is only enumeration. The catalog must also
 * finish bootstrap and every active owner's journal/reverse work before ACK. */
async function globalCoverageComplete(input:AnalyticsWorkEffectsInput,source:D1Database):Promise<boolean>{
 const before=await readEffectiveDependencySourceFence(source);if(!before)return false;
 const complete=await source.prepare(`SELECT 1 FROM storage_effective_selective_bootstrap b
 JOIN storage_source_state s ON s.singleton=1 AND s.source_id=?
 JOIN typed_v1_admission_state v1 ON v1.id=1 AND v1.source_namespace=? AND v1.runtime_contract_version=1
 JOIN typed_v11_admission_state v11 ON v11.id=1 AND v11.source_namespace=v1.source_namespace AND v11.runtime_contract_version=1
 WHERE b.id=1 AND b.complete=1 AND NOT EXISTS(
 SELECT 1 FROM storage_v11_owner_links l JOIN storage_owner_revisions o USING(owner_digest)
 JOIN participants p ON p.id=l.participant_id LEFT JOIN storage_effective_selective_owners c ON c.participant_id=l.participant_id
 WHERE l.state='active' AND o.state='active' AND p.state='active' AND
 (c.participant_id IS NULL OR c.owner_digest!=l.owner_digest OR c.source_namespace!=v1.source_namespace OR c.seeded!=1 OR c.needs_work!=0
 OR EXISTS(SELECT 1 FROM storage_effective_selective_work w WHERE w.participant_id=l.participant_id)
 OR EXISTS(SELECT 1 FROM storage_effective_selective_reverse_work w WHERE w.participant_id=l.participant_id)))`)
 .bind(input.sourceId,input.sourceNamespace).first();
 const after=await readEffectiveDependencySourceFence(source);
 return !!complete&&!!after&&after.generation===before.generation;
}
async function advanceGlobal(input:AnalyticsWorkEffectsInput,source:D1Database,target:D1Database):Promise<number> {
 const change=await readEffectiveDependencyGlobalChange(source);
 if(change)await target.prepare(`INSERT INTO analytics_partition_global_changes(source_id,source_stamp,updated_ms)
 VALUES(?,?,?) ON CONFLICT(source_id,source_stamp) DO NOTHING`).bind(input.sourceId,change.stamp,input.now()).run();
 const current=await target.prepare(`SELECT source_stamp,after_owner_digest,state,version FROM analytics_partition_global_changes
 WHERE source_id=? AND acknowledged=0 ORDER BY source_stamp LIMIT 1`).bind(input.sourceId)
 .first<{source_stamp:number;after_owner_digest:string;state:'pending'|'complete';version:number}>();
 if(!current)return 0;
 if(current.state==='complete') {
  if(!await globalCoverageComplete(input,source))return 0;
  await acknowledgeEffectiveDependencyGlobalChange(source,{stamp:current.source_stamp});
  await target.prepare(`UPDATE analytics_partition_global_changes SET acknowledged=1 WHERE source_id=? AND source_stamp=?`)
   .bind(input.sourceId,current.source_stamp).run();return 0;
 }
 const next=await source.prepare(`SELECT owner_digest FROM storage_owner_revisions WHERE owner_digest>?
 ORDER BY owner_digest LIMIT 1`).bind(current.after_owner_digest).first<{owner_digest:string}>();
 if(!next) {
  if(!await globalCoverageComplete(input,source))return 0;
  await target.prepare(`UPDATE analytics_partition_global_changes SET state='complete',version=version+1,updated_ms=?
   WHERE source_id=? AND source_stamp=? AND version=?`).bind(input.now(),input.sourceId,current.source_stamp,current.version).run();return 0;
 }
 const owner=await readStorageCommunityOwner(source,{ownerDigest:next.owner_digest});
 const statements:D1PreparedStatement[]=[];
 if(!owner?.ownerDigest&&!await terminalProof(input,source,target,{ownerDigest:next.owner_digest}))return 0;
 if(owner?.ownerDigest) {
  if(!await targetReady(target,input.sourceId,owner.ownerDigest))return 0;
  const bounds=await retainedRange(source,target,input.sourceId,owner);
  if(!bounds){
   if(!available(input,100))return 0;
   const empty=await saveEmpty(input,source,target,owner,{participantId:owner.participantId,fromDay:null,throughDay:null,stream:'all',stamp:current.source_stamp},true);
   if(!empty)return 0;
   statements.push(target.prepare('UPDATE analytics_partition_empty_outcomes SET acknowledged=1 WHERE effect_key=? AND proof_digest=?').bind(empty.key,empty.proof.digest));
  }else{
  const admission=await rangeStatements(target,input,owner,{participantId:owner.participantId,fromDay:null,throughDay:null,
   stream:'all',stamp:current.source_stamp},bounds,'recovery',true);statements.push(...admission.statements);
  }
 }
 statements.push(target.prepare(`UPDATE analytics_partition_global_changes SET after_owner_digest=?,version=version+1,updated_ms=?
  WHERE source_id=? AND source_stamp=? AND version=? RETURNING source_stamp`)
  .bind(next.owner_digest,input.now(),input.sourceId,current.source_stamp,current.version));
 const result=await target.batch(statements);
 return returnedD1Target(result.at(-1),'source_stamp',current.source_stamp)?1:0;
}
/** One-time, bounded migration reconciliation. New effects enter the outbox in
 * the canonical save transaction, so subsequent schedules never scan history. */
async function reconcileCanonical(input:AnalyticsWorkEffectsInput,target:D1Database):Promise<void> {
 await target.prepare(`INSERT INTO analytics_partition_reconciliation(source_id) VALUES(?) ON CONFLICT(source_id) DO NOTHING`).bind(input.sourceId).run();
 const cursor=await target.prepare(`SELECT after_effect_key,complete FROM analytics_partition_reconciliation WHERE source_id=?`)
  .bind(input.sourceId).first<{after_effect_key:string;complete:number}>();
 if(!cursor||cursor.complete)return;
 const rows=(await target.prepare(`SELECT e.effect_key FROM analytics_canonical_effects e JOIN analytics_canonical_pages p USING(change_key)
  WHERE p.source_id=? AND e.effect_key>? ORDER BY e.effect_key LIMIT ?`).bind(input.sourceId,cursor.after_effect_key,input.maxEffects??4)
  .all<{effect_key:string}>()).results;
 await target.batch([
  target.prepare(`INSERT INTO analytics_partition_canonical_effects(effect_key) SELECT value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`)
   .bind(JSON.stringify(rows.map(row=>row.effect_key))),
  target.prepare(`UPDATE analytics_partition_reconciliation SET after_effect_key=?,complete=? WHERE source_id=? AND after_effect_key=? AND complete=0`)
   .bind(rows.at(-1)?.effect_key??cursor.after_effect_key,rows.length<(input.maxEffects??4)?1:0,input.sourceId,cursor.after_effect_key),
 ]);
}
async function partitionRequest(input:AnalyticsWorkEffectsInput,target:D1Database,key:string,lane:AnalyticsWorkLane):Promise<AnalyticsWorkRequest> {
 const generation=await target.prepare('SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=?')
  .bind(key).first<number>('generation');if(generation===null)throw invalid();
 const parts=key.split('/');
 return {sourceId:input.sourceId,ownerDigest:null,stage:'features',lane,partitionKey:key,
  headKey:await digest(['features',input.sourceId,key]),inputRevision:await digest([key,generation]),policyRevision:await policy(),
  day:parts[2]==='unknown'?null:parts[2]!,stream:parts[1] as AnalyticsWorkRequest['stream'],
  selectionMethod:parts[0] as AnalyticsWorkRequest['selectionMethod'],residentBytes:4*1024*1024,admissionQueries:600};
}
async function bridgeCanonical(input:AnalyticsWorkEffectsInput,target:D1Database):Promise<number> {
 const pending=(await target.prepare(`SELECT e.effect_key FROM analytics_partition_canonical_effects q
  JOIN analytics_canonical_effects e USING(effect_key) JOIN analytics_canonical_pages p USING(change_key)
  WHERE q.state='pending' AND p.state='complete' AND p.source_id=? ORDER BY e.effect_key LIMIT ?`)
  .bind(input.sourceId,input.maxEffects??4).all<{effect_key:string}>()).results;
 const rows=await readCanonicalWorkEffects(target,pending.map(row=>row.effect_key));let accepted=0;
 for(const row of rows) {
  if(!available(input,16))break;
  const jobs:AnalyticsWorkRequest[]=[];
  if(row.kind!=='noop')for(const part of row.partitions)jobs.push(await partitionRequest(input,target,part.partitionKey,row.kind==='withdraw'?'withdrawal':'new'));
  const admission=await analyticsWorkAdmissionStatements(target,jobs,input.now());
  if(admission.workKeys.length)admission.statements.push(target.prepare(`INSERT INTO analytics_partition_effect_refs(work_key,effect_key)
   SELECT value,? FROM json_each(?) WHERE true ON CONFLICT(work_key,effect_key) DO NOTHING`)
   .bind(row.effectKey,JSON.stringify(admission.workKeys)));
  admission.statements.push(target.prepare(`UPDATE analytics_partition_canonical_effects SET state='accepted' WHERE effect_key=? AND state='pending'`)
   .bind(row.effectKey));await target.batch(admission.statements);accepted++;
 }
 // Includes invalidations whose originating effects were physically erased.
 const dirty=(await target.prepare(`SELECT partition_key,generation FROM analytics_partition_dirty_work
  WHERE source_id=? AND generation>admitted_generation ORDER BY partition_key LIMIT ?`)
  .bind(input.sourceId,input.maxEffects??4).all<{partition_key:string;generation:number}>()).results;
 for(const row of dirty) {
  if(!available(input,12))break;
  const request=await partitionRequest(input,target,row.partition_key,'recovery');
  const admission=await analyticsWorkAdmissionStatements(target,[request],input.now());
  admission.statements.push(target.prepare(`UPDATE analytics_partition_dirty_work SET admitted_generation=?
   WHERE source_id=? AND partition_key=? AND generation=?`).bind(row.generation,input.sourceId,row.partition_key,row.generation));
  await target.batch(admission.statements);
 }
 return accepted;
}
export async function advanceAnalyticsWorkEffects(input:AnalyticsWorkEffectsInput):Promise<AnalyticsWorkEffectsProgress> {
 valid(input);const start=input.meter.queriesUsed,source=input.meter.wrap(input.source),target=input.meter.wrap(input.target);
 const counts={rangesAdmitted:0,rangesAcknowledged:0,daysAdmitted:0,canonicalEffects:0,globalOwners:0};
 const done=(state:AnalyticsWorkEffectsProgress['state'])=>Object.freeze({state,...counts,statements:input.meter.queriesUsed-start});
 if(!available(input))return done('deferred');if(!await analyticsPartitionWorkAvailable(target)||!await outcomeSchema(target))return done('unavailable');
 try {
 await requireAuthorityRestoreServingReady(source);
 await target.prepare(`DELETE FROM analytics_partition_empty_outcomes WHERE effect_key IN(
 SELECT effect_key FROM analytics_partition_empty_outcomes WHERE source_id=? AND acknowledged=1 ORDER BY updated_ms,effect_key LIMIT 16)`)
 .bind(input.sourceId).run();
 await advanceEffectiveDependencyCoverage(source,{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,maxSteps:1,maxRows:16,budget:input.meter});
 if(available(input))await admitSourceRanges(input,source,target,counts);
 if(available(input))counts.daysAdmitted=await expandSourceRange(input,target);
 if(available(input))counts.globalOwners=await advanceGlobal(input,source,target);
 if(available(input))await reconcileCanonical(input,target);
 if(available(input))counts.canonicalEffects=await bridgeCanonical(input,target);
 return done(Object.values(counts).some(n=>n>0)?'progress':available(input)?'idle':'deferred');
 }catch(error){
  if(error instanceof D1InvocationBudgetExceededError)return {...done('deferred'),reason:'query_budget'};
  if(/analytics_work_capacity/u.test(String(error)))return {...done('deferred'),reason:'capacity'};
  throw error;
 }
}
