import type { AnalyticsWorkLease } from './analytics-partition-work';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { canonicalDay,canonicalDigest } from './canonical-analytics-facts';
import { foldCanonicalActivityContributions,type CanonicalActivityContribution } from './canonical-feature-contributions';
import type { CanonicalFeaturePartitionResult } from './storage-canonical-feature-contributions';
import { returnedD1Target } from './d1-direct-write';
import { D1InvocationBudgetExceededError,readD1SchemaObjectsAvailable } from './d1-invocation-budget';

export const CANONICAL_PUBLICATION_TABLES=Object.freeze(['analytics_canonical_publication_parts',
 'analytics_canonical_publication_part_facts','analytics_canonical_publication_part_subjects','analytics_canonical_publication_part_heads','analytics_canonical_publication_replacements',
 'analytics_canonical_publication_closures','analytics_canonical_publication_expected','analytics_canonical_publication_subjects',
 'analytics_canonical_publication_graph_refs','analytics_canonical_publication_cohorts','analytics_canonical_publication_cohort_members','analytics_canonical_cache_publications']);
export const CANONICAL_PUBLICATION_TRIGGERS=Object.freeze(['analytics_canonical_publication_part_admit',
 'analytics_canonical_publication_part_immutable','analytics_canonical_publication_part_delete',
 'analytics_canonical_publication_fact_delete','analytics_canonical_publication_owner_terminal','analytics_canonical_publication_erasure',
 'analytics_canonical_publication_expected_revision','analytics_canonical_publication_expected_immutable','analytics_canonical_publication_subject_admit',
 'analytics_canonical_publication_cohort_admit','analytics_canonical_publication_cohort_terminal','analytics_canonical_publication_cohort_erasure',
 'analytics_canonical_publication_cohort_owner_delete','analytics_canonical_publication_graph_admit','analytics_canonical_publication_graph_change','analytics_canonical_publication_graph_delete','analytics_canonical_publication_head_changed','analytics_canonical_publication_partition_dirty','analytics_canonical_publication_part_subject_admit',
 'analytics_canonical_publication_part_subject_terminal','analytics_canonical_publication_part_subject_erasure',
 'analytics_canonical_publication_owner_delete','analytics_canonical_publication_fence_replay','analytics_canonical_cache_publication_admit','analytics_canonical_cache_publication_update']);
const invalid=()=>new Error('CANONICAL_PUBLICATION_INVALID');
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
const hash=(value:unknown)=>sha256Hex(canonicalJson(value));
const source=(value:string)=>{if(!/^[-A-Za-z0-9._:]{1,128}$/u.test(value))throw invalid();};
const key=(value:string)=>{if(!/^[-A-Za-z0-9._:/]{1,256}$/u.test(value))throw invalid();};
const integer=(value:number)=>{if(!Number.isSafeInteger(value)||value<0)throw invalid();};
export async function canonicalPublicationAvailable(db:D1Database):Promise<boolean> {
 return readD1SchemaObjectsAvailable(db,[...CANONICAL_PUBLICATION_TABLES.map(name=>['table',name] as const),
  ...CANONICAL_PUBLICATION_TRIGGERS.map(name=>['trigger',name] as const)]);
}
/** Exact producer incidence for every current fact. The reverse manifest
 * index is read first; the inner probe has the complete producer index prefix.
 * Absence still refuses publication. Completion, generation, source authority
 * and leases are checked separately by the caller's closure/commit proofs. */
export async function canonicalPublicationProducerCoverage(db:D1Database,input:
 {sourceId:string;family:'activity';day:string}|{sourceId:string;family:'cache'}):Promise<boolean> {
 source(input.sourceId);
 if(input.family==='activity')canonicalDay(input.day);else if(input.family!=='cache')throw invalid();
 const filter=input.family==='cache'?"f.stream='usage'":"f.observed_day=?";
 const missing=await db.prepare(`SELECT 1 missing FROM analytics_canonical_heads h JOIN analytics_canonical_facts f ON f.revision=h.revision
 WHERE f.source_id=? AND ${filter} AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r WHERE r.revision=f.revision
 AND EXISTS(SELECT 1 FROM analytics_partition_work w JOIN analytics_canonical_partition_heads p
 ON p.partition_key=w.partition_key AND p.content_revision=w.input_revision
 WHERE w.source_id=f.source_id AND w.stage=? AND w.input_revision=r.content_revision)) LIMIT 1`)
 .bind(input.sourceId,...(input.family==='activity'?[input.day]:[]),input.family).first<number>('missing');
 return missing!==1;
}
export interface CanonicalPublicationPart {
 readonly revision:string;readonly sourceId:string;readonly partitionKey:string;readonly contentRevision:string;
 readonly value:CanonicalActivityContribution;
}
export type CanonicalPublicationPartResult={state:'complete';reused:boolean;part:CanonicalPublicationPart}
 |{state:'deferred';reason:'head_changed'|'membership_unavailable'|'authority_changed'};
/** The old and replacement contributions are immutable vectors, not reduced
 * medians. A single D1 batch replaces the pointer and journals the exact pair.
 * A lost response is accepted only after reading its identical receipt. */
export async function replaceCanonicalPublicationPart(db:D1Database,input:{sourceId:string;
 expectedRevision:string|null;feature:Pick<Extract<CanonicalFeaturePartitionResult,{state:'complete'}>,'manifest'|'facts'|'activityInputs'>;
 nowMs:number;stillCurrent:()=>Promise<boolean>;lease?:AnalyticsWorkLease}):Promise<CanonicalPublicationPartResult> {
 source(input.sourceId);integer(input.nowMs);if(input.expectedRevision!==null)canonicalDigest(input.expectedRevision);
 const {manifest,facts,activityInputs}=input.feature;key(manifest.partitionKey);
 const pieces=manifest.partitionKey.split('/'),day=pieces[2]!;canonicalDay(day);
 if(activityInputs.length!==manifest.rowCount||facts.length!==manifest.rowCount
  ||new Set(activityInputs.map(item=>item.contribution.factRevision)).size!==facts.length
  ||facts.some(fact=>!activityInputs.some(item=>item.contribution.factRevision===fact.revision)))throw invalid();
 const sourceFacts=(await db.prepare(`SELECT r.revision FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f ON f.revision=r.revision
  WHERE r.content_revision=? AND f.source_id=? ORDER BY r.ordinal LIMIT 129`).bind(manifest.contentRevision,input.sourceId).all<{revision:string}>()).results;
 const sourceRevisions=new Set(sourceFacts.map(row=>row.revision));
 const selectedInputs=activityInputs.filter(item=>sourceRevisions.has(item.contribution.factRevision));
 const value=foldCanonicalActivityContributions(day,pieces[0] as CanonicalActivityContribution['selectionMethod'],selectedInputs);
 if(value.membershipCoverage!=='complete')return {state:'deferred',reason:'membership_unavailable'};
 const payload=canonicalJson(value);if(bytes(payload)>1024*1024)throw invalid();
 const payloadDigest=await sha256Hex(payload),revision=await hash(['canonical-publication-part-v1',input.sourceId,manifest.contentRevision,payloadDigest]);
 const part={revision,sourceId:input.sourceId,partitionKey:manifest.partitionKey,contentRevision:manifest.contentRevision,value};
 const replacement=await hash(['canonical-publication-replacement-v1',input.sourceId,manifest.partitionKey,input.expectedRevision,revision]);
 const receipt=async()=>db.prepare(`SELECT 1 ready FROM analytics_canonical_publication_replacements r
 JOIN analytics_canonical_publication_part_heads h ON h.source_id=r.source_id AND h.partition_key=r.partition_key AND h.revision=r.new_revision
 JOIN analytics_canonical_publication_parts p ON p.revision=r.new_revision
 WHERE r.replacement_key=? AND p.payload_digest=? AND p.payload=?`).bind(replacement,payloadDigest,payload).first<number>('ready');
 if(await receipt()===1)return await input.stillCurrent()?{state:'complete',reused:true,part}:{state:'deferred',reason:'authority_changed'};
 if(!await input.stillCurrent())return {state:'deferred',reason:'authority_changed'};
 const current=await db.prepare(`SELECT revision FROM analytics_canonical_publication_part_heads WHERE source_id=? AND partition_key=?`)
 .bind(input.sourceId,manifest.partitionKey).first<string>('revision');
 if(current!==input.expectedRevision)return {state:'deferred',reason:'head_changed'};
 // Every mutation is guarded by the same old-head comparison. Target authority
 // and manifest triggers run inside the batch, independently of source proof.
 const lease=input.lease;
 const cas=`COALESCE((SELECT revision FROM analytics_canonical_publication_part_heads WHERE source_id=? AND partition_key=?),'')=?`
  +(lease?` AND EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.work_key=? AND w.revision=? AND w.claim_token=?
   AND w.state='leased' AND w.claim_expires_ms>? AND w.input_revision=?)`:'');
 const casValues:(string|number)[]=[input.sourceId,manifest.partitionKey,input.expectedRevision??'',
  ...(lease?[lease.workKey,lease.revision,lease.claimToken,input.nowMs,manifest.contentRevision]:[])];
 const subjects=(await db.prepare(`WITH RECURSIVE ancestors(key) AS(
 SELECT work_key FROM analytics_partition_work WHERE work_key=?
 UNION SELECT l.parent_work_key FROM analytics_partition_work_links l JOIN ancestors a ON l.child_work_key=a.key
 ) SELECT DISTINCT f.source_id,f.owner_digest FROM analytics_canonical_manifest_rows r
 JOIN analytics_canonical_facts f ON f.revision=r.revision WHERE r.content_revision=? AND f.source_id=?
 UNION SELECT source_id,owner_digest FROM analytics_canonical_publication_part_subjects WHERE part_revision=?
 UNION SELECT s.source_id,s.owner_digest FROM analytics_partition_work_subjects s WHERE s.work_key=?
 UNION SELECT p.source_id,p.owner_digest FROM ancestors a JOIN analytics_partition_effect_refs r ON r.work_key=a.key
 JOIN analytics_canonical_effects e ON e.effect_key=r.effect_key JOIN analytics_canonical_pages p ON p.change_key=e.change_key LIMIT 129`)
 .bind(lease?.workKey??'',manifest.contentRevision,input.sourceId,input.expectedRevision,lease?.workKey??'').all<{source_id:string;owner_digest:string}>()).results;
 if(subjects.length>128)throw invalid();
 const statements=[db.prepare(`INSERT INTO analytics_canonical_publication_parts
 (revision,source_id,day,partition_key,content_revision,payload,payload_digest,fact_count,created_ms)
 SELECT ?,?,?,?,?,?,?,?,? WHERE ${cas} ON CONFLICT(revision) DO NOTHING`)
 .bind(revision,input.sourceId,day,manifest.partitionKey,manifest.contentRevision,payload,payloadDigest,sourceFacts.length,input.nowMs,...casValues),
 db.prepare(`INSERT INTO analytics_canonical_publication_part_facts(part_revision,fact_revision)
 SELECT ?,value FROM json_each(?) WHERE ${cas} ON CONFLICT DO NOTHING`)
 .bind(revision,JSON.stringify(sourceFacts.map(fact=>fact.revision)),...casValues),
 db.prepare(`INSERT INTO analytics_canonical_publication_part_subjects(part_revision,source_id,owner_digest)
 SELECT ?,json_extract(value,'$.source_id'),json_extract(value,'$.owner_digest') FROM json_each(?) WHERE ${cas} ON CONFLICT DO NOTHING`)
 .bind(revision,JSON.stringify(subjects),...casValues),
 db.prepare(`INSERT INTO analytics_canonical_publication_replacements(replacement_key,source_id,partition_key,old_revision,new_revision,created_ms)
 SELECT ?,?,?,?,?,? WHERE ${cas} ON CONFLICT(replacement_key) DO NOTHING`)
 .bind(replacement,input.sourceId,manifest.partitionKey,input.expectedRevision,revision,input.nowMs,...casValues),
 db.prepare(`INSERT INTO analytics_canonical_publication_part_heads(source_id,partition_key,revision)
 SELECT ?,?,? WHERE ${cas} ON CONFLICT(source_id,partition_key) DO UPDATE SET revision=excluded.revision`)
 .bind(input.sourceId,manifest.partitionKey,revision,...casValues)];
 try{await db.batch(statements);}catch(error){
  if(error instanceof D1InvocationBudgetExceededError)throw error;
  if(/canonical_publication_authority|FOREIGN KEY/iu.test(String(error)))return {state:'deferred',reason:'authority_changed'};
  if(await receipt()!==1)throw error;
 }
 return await receipt()===1&&await input.stillCurrent()?{state:'complete',reused:false,part}:{state:'deferred',reason:'head_changed'};
}
export interface CanonicalPublicationClosureInput {
 readonly sourceId:string;readonly day:string;readonly family:'activity'|'fits'|'model'|'cache';
 readonly watermark:number;readonly authorityDigest:string;readonly expectedCount:number;readonly nowMs:number;
}
export interface CanonicalPublicationExpected {readonly partitionKey:string;readonly contentRevision:string}
function closureInput(input:CanonicalPublicationClosureInput):void {
 source(input.sourceId);canonicalDay(input.day);canonicalDigest(input.authorityDigest);integer(input.watermark);integer(input.nowMs);
 integer(input.expectedCount);if(input.expectedCount>65536||!['activity','fits','model','cache'].includes(input.family))throw invalid();
}
/** Expected membership is captured once from the changed-work index at the
 * accepted source watermark, then appended in bounded pages. No source cohort
 * is rediscovered when readers check closure. Empty closure must be explicit. */
export async function beginCanonicalPublicationClosure(db:D1Database,input:CanonicalPublicationClosureInput):Promise<string> {
 closureInput(input);const closureKey=await hash(['canonical-publication-closure-v1',input.sourceId,input.day,input.family,
 input.watermark,input.authorityDigest,input.expectedCount]);
 await db.prepare(`INSERT INTO analytics_canonical_publication_closures
 (closure_key,source_id,day,family,watermark,authority_digest,expected_count,state,created_ms) VALUES(?,?,?,?,?,?,?,'capturing',?)
 ON CONFLICT(closure_key) DO NOTHING`).bind(closureKey,input.sourceId,input.day,input.family,input.watermark,input.authorityDigest,input.expectedCount,input.nowMs).run();
 return closureKey;
}
export async function appendCanonicalPublicationExpected(db:D1Database,closureKey:string,expected:readonly CanonicalPublicationExpected[]):Promise<void> {
 canonicalDigest(closureKey);if(expected.length>128||new Set(expected.map(row=>row.partitionKey)).size!==expected.length)throw invalid();
 for(const row of expected){key(row.partitionKey);canonicalDigest(row.contentRevision);}
 const rows=JSON.stringify(expected);
 const mismatch=await db.prepare(`SELECT 1 bad FROM json_each(?) j JOIN analytics_canonical_publication_expected e
 ON e.closure_key=? AND e.partition_key=json_extract(j.value,'$.partitionKey')
 WHERE e.content_revision!=json_extract(j.value,'$.contentRevision') LIMIT 1`).bind(rows,closureKey).first<number>('bad');
 if(mismatch===1)throw invalid();
 await db.batch([db.prepare(`INSERT INTO analytics_canonical_publication_expected(closure_key,partition_key,content_revision,outcome)
 SELECT ?,json_extract(value,'$.partitionKey'),json_extract(value,'$.contentRevision'),'pending' FROM json_each(?)
 WHERE EXISTS(SELECT 1 FROM analytics_canonical_publication_closures c WHERE c.closure_key=? AND c.state='capturing')
 ON CONFLICT(closure_key,partition_key) DO NOTHING`).bind(closureKey,rows,closureKey),
 db.prepare(`INSERT INTO analytics_canonical_publication_subjects(closure_key,source_id,owner_digest)
 SELECT DISTINCT ?,f.source_id,f.owner_digest FROM json_each(?) j JOIN analytics_canonical_manifest_rows r
 ON r.content_revision=json_extract(j.value,'$.contentRevision') JOIN analytics_canonical_facts f ON f.revision=r.revision
 WHERE EXISTS(SELECT 1 FROM analytics_canonical_publication_closures c WHERE c.closure_key=? AND c.state='capturing')
 ON CONFLICT DO NOTHING`).bind(closureKey,rows,closureKey)]);
}
export async function sealCanonicalPublicationExpected(db:D1Database,closureKey:string):Promise<boolean> {
 canonicalDigest(closureKey);
 const result=await db.prepare(`UPDATE analytics_canonical_publication_closures SET state='sealed'
 WHERE closure_key=? AND state IN('capturing','sealed') AND expected_count=(SELECT count(*) FROM analytics_canonical_publication_expected e
 WHERE e.closure_key=analytics_canonical_publication_closures.closure_key) RETURNING closure_key`).bind(closureKey).run();
 return returnedD1Target(result,'closure_key',closureKey);
}
/** Explicit unchanged reuse and explicit empty partitions are first-class
 * completion evidence. Completing the same revision again is idempotent. */
export async function completeCanonicalPublicationExpected(db:D1Database,input:{closureKey:string;partitionKey:string;
 partRevision:string;outcome:'changed'|'unchanged'|'empty'}):Promise<boolean> {
 canonicalDigest(input.closureKey);canonicalDigest(input.partRevision);key(input.partitionKey);
 if(!['changed','unchanged','empty'].includes(input.outcome))throw invalid();
 await db.prepare(`INSERT INTO analytics_canonical_publication_subjects(closure_key,source_id,owner_digest)
 SELECT ?,s.source_id,s.owner_digest FROM analytics_canonical_publication_part_subjects s
 WHERE s.part_revision=? AND EXISTS(SELECT 1 FROM analytics_canonical_publication_closures WHERE closure_key=? AND state='sealed')
 ON CONFLICT DO NOTHING`).bind(input.closureKey,input.partRevision,input.closureKey).run();
 const result=await db.prepare(`UPDATE analytics_canonical_publication_expected SET outcome=?,part_revision=?
 WHERE closure_key=? AND partition_key=? AND EXISTS(SELECT 1 FROM analytics_canonical_publication_closures c
 JOIN analytics_canonical_publication_part_heads h ON h.source_id=c.source_id AND h.partition_key=analytics_canonical_publication_expected.partition_key
 JOIN analytics_canonical_publication_parts p ON p.revision=h.revision
 WHERE c.closure_key=analytics_canonical_publication_expected.closure_key AND c.state='sealed' AND p.revision=?
 AND p.content_revision=analytics_canonical_publication_expected.content_revision AND (?!='empty' OR p.fact_count=0))
 RETURNING partition_key`).bind(input.outcome,input.partRevision,input.closureKey,input.partitionKey,input.partRevision,input.outcome).run();
 return returnedD1Target(result,'partition_key',input.partitionKey);
}
export async function readCanonicalPublicationClosure(db:D1Database,closureKey:string):Promise<{
 state:'capturing'|'sealed'|'complete'|'invalidated';expected:number;completed:number;watermark:number;authorityDigest:string}|null> {
 canonicalDigest(closureKey);
 const row=await db.prepare(`SELECT c.state,c.expected_count expected,c.watermark,c.authority_digest authorityDigest,
 (SELECT count(*) FROM analytics_canonical_publication_expected e JOIN analytics_canonical_publication_parts p ON p.revision=e.part_revision
 JOIN analytics_canonical_publication_part_heads h ON h.source_id=c.source_id AND h.partition_key=e.partition_key AND h.revision=p.revision
 WHERE e.closure_key=c.closure_key AND e.outcome!='pending' AND p.content_revision=e.content_revision)
 +(SELECT count(*) FROM analytics_canonical_publication_expected e JOIN analytics_canonical_publication_graph_refs r
 ON r.closure_key=e.closure_key AND r.partition_key=e.partition_key AND r.content_revision=e.content_revision
 JOIN analytics_community_graph_results g ON g.source_id=r.source_id AND g.owner_digest=r.owner_digest AND g.metric=r.metric AND g.day=r.day
 WHERE e.closure_key=c.closure_key AND e.outcome!='pending' AND g.method=r.method AND g.dependency_digest=r.dependency_digest AND g.payload_sha256=r.payload_sha256)
 +(SELECT count(*) FROM analytics_canonical_publication_expected e JOIN analytics_canonical_cache_partitions p
 ON p.partition_key=e.partition_key AND p.content_revision=e.content_revision JOIN analytics_canonical_partition_heads h
 ON h.partition_key=e.partition_key AND h.content_revision=e.content_revision
 WHERE c.family='cache' AND e.closure_key=c.closure_key AND e.outcome!='pending' AND p.method='cache-retention-v2') completed
 FROM analytics_canonical_publication_closures c WHERE c.closure_key=?`).bind(closureKey)
 .first<{state:'capturing'|'sealed'|'complete'|'invalidated';expected:number;completed:number;watermark:number;authorityDigest:string}>();
 return row;
}
export async function commitCanonicalPublicationClosure(db:D1Database,closureKey:string):Promise<boolean> {
 canonicalDigest(closureKey);
 const result=await db.prepare(`UPDATE analytics_canonical_publication_closures SET state='complete'
 WHERE closure_key=? AND state IN('sealed','complete') AND expected_count=(SELECT count(*) FROM analytics_canonical_publication_expected e
 WHERE e.closure_key=analytics_canonical_publication_closures.closure_key)
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_expected e
 LEFT JOIN analytics_canonical_publication_parts p ON p.revision=e.part_revision
 LEFT JOIN analytics_canonical_publication_part_heads h ON h.source_id=analytics_canonical_publication_closures.source_id
 AND h.partition_key=e.partition_key AND h.revision=e.part_revision
 LEFT JOIN analytics_canonical_manifests m ON m.content_revision=e.content_revision
 LEFT JOIN analytics_canonical_partition_heads native ON native.partition_key=e.partition_key AND native.content_revision=e.content_revision
 WHERE e.closure_key=analytics_canonical_publication_closures.closure_key AND (e.outcome='pending' OR p.revision IS NULL
 OR h.revision IS NULL OR native.content_revision IS NULL OR m.generation IS NOT COALESCE((SELECT generation
 FROM analytics_canonical_dirty_partitions d WHERE d.partition_key=m.root_partition_key),0)))
 RETURNING closure_key`).bind(closureKey).run();
 return returnedD1Target(result,'closure_key',closureKey);
}
/** Old unpinned closures become invalidated before their children are drained.
 * Subject provenance stays until payload-bearing references are gone. The
 * numeric result counts changed/deleted rows, including the bounded final
 * subject cascade, so a productive child page keeps the sweep immediately due. */
export async function retireCanonicalPublicationPage(db:D1Database,input:{sourceId:string;beforeMs:number;limit?:number;nowMs?:number}):Promise<number> {
 source(input.sourceId);integer(input.beforeMs);const limit=input.limit??16,nowMs=input.nowMs??Date.now();integer(nowMs);
 if(!Number.isSafeInteger(limit)||limit<1||limit>32)throw invalid();
 const pageLimit=Math.min(128,limit*8);let changed=0;
 const noLease=`NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=? AND w.state='leased' AND w.claim_expires_ms>?)`;
 const closureGuard=`source_id=? AND created_ms<? AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_publications p
  WHERE p.closure_key=analytics_canonical_publication_closures.closure_key) AND ${noLease}`;
 const closure=await db.prepare(`SELECT closure_key FROM analytics_canonical_publication_closures WHERE ${closureGuard}
  ORDER BY created_ms,closure_key LIMIT 1`).bind(input.sourceId,input.beforeMs,input.sourceId,nowMs).first<string>('closure_key');
 if(closure) {
  const guard=`EXISTS(SELECT 1 FROM analytics_canonical_publication_closures WHERE closure_key=? AND state='invalidated' AND ${closureGuard})`;
  const values=[closure,input.sourceId,input.beforeMs,input.sourceId,nowMs];
  const marked=await db.prepare(`UPDATE analytics_canonical_publication_closures SET state='invalidated'
   WHERE closure_key=? AND state!='invalidated' AND ${closureGuard} RETURNING closure_key`).bind(...values).all<{closure_key:string}>();
  changed+=marked.results.length;let remaining=pageLimit;
  for(const [table,columns,order] of [
   ['analytics_canonical_publication_expected','closure_key,partition_key','partition_key'],
   ['analytics_canonical_publication_graph_refs','closure_key,source_id,owner_digest,metric,day','source_id,owner_digest,metric,day'],
   ['analytics_canonical_publication_subjects','closure_key,source_id,owner_digest','source_id,owner_digest'],
  ]) {
   if(!remaining)break;
   // Keep subject erasure links until all preceding private reference rows are gone.
   const preceding=table==='analytics_canonical_publication_expected'?'':` AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_expected WHERE closure_key=?)`
    +(table==='analytics_canonical_publication_subjects'?` AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_graph_refs WHERE closure_key=?)`:'');
   const removed=await db.prepare(`DELETE FROM ${table} WHERE (${columns}) IN(SELECT ${columns} FROM ${table}
    WHERE closure_key=? AND ${guard}${preceding} ORDER BY ${order} LIMIT ?) RETURNING closure_key`)
    .bind(closure,...values,...(table==='analytics_canonical_publication_expected'?[]:table==='analytics_canonical_publication_subjects'?[closure,closure]:[closure]),remaining)
    .all<{closure_key:string}>();
   remaining-=removed.results.length;changed+=removed.results.length;
  }
  const removed=await db.prepare(`DELETE FROM analytics_canonical_publication_closures WHERE closure_key=? AND ${closureGuard}
   AND state='invalidated' AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_expected WHERE closure_key=?)
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_graph_refs WHERE closure_key=?)
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_subjects WHERE closure_key=?) RETURNING closure_key`)
   .bind(...values,closure,closure,closure).all<{closure_key:string}>();changed+=removed.results.length;
 }
 const partGuard=`p.source_id=? AND p.created_ms<? AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_part_heads h WHERE h.revision=p.revision)
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_expected e WHERE e.part_revision=p.revision) AND ${noLease}`;
 const part=await db.prepare(`SELECT p.revision FROM analytics_canonical_publication_parts p WHERE ${partGuard}
  ORDER BY p.created_ms,p.revision LIMIT 1`).bind(input.sourceId,input.beforeMs,input.sourceId,nowMs).first<string>('revision');
 if(part) {
  const guard=`EXISTS(SELECT 1 FROM analytics_canonical_publication_parts p WHERE p.revision=? AND ${partGuard})`;
  const values=[part,input.sourceId,input.beforeMs,input.sourceId,nowMs];let remaining=pageLimit;
  for(const [table,column,match] of [
   ['analytics_canonical_publication_part_facts','fact_revision','part_revision=?'],
   ['analytics_canonical_publication_replacements','replacement_key','(old_revision=? OR new_revision=?)'],
  ]) {
   if(!remaining)break;
   const removed=await db.prepare(`DELETE FROM ${table} WHERE ${column} IN(SELECT ${column} FROM ${table}
    WHERE ${match} AND ${guard} ORDER BY ${column} LIMIT ?) ${table==='analytics_canonical_publication_part_facts'?'AND part_revision=? ':''}RETURNING ${column}`)
    .bind(...(table==='analytics_canonical_publication_part_facts'?[part]:[part,part]),...values,remaining,
     ...(table==='analytics_canonical_publication_part_facts'?[part]:[])).all<Record<string,string>>();
   remaining-=removed.results.length;changed+=removed.results.length;
  }
  // The reviewed writer admits at most128 subjects plus the header. Keep every subject until
  // its aggregate payload disappears in this same bounded cascade.
  if(remaining>0) {
   // The count and delete share one transaction; concurrent subject changes
   // cannot make the reported cascade differ from its actual bounded writes.
   const result=await db.batch<{n?:number;revision?:string}>([
    db.prepare('SELECT count(*) n FROM analytics_canonical_publication_part_subjects WHERE part_revision=?').bind(part),
    db.prepare(`DELETE FROM analytics_canonical_publication_parts WHERE revision=? AND ${guard}
     AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_part_facts WHERE part_revision=?)
     AND NOT EXISTS(SELECT 1 FROM analytics_canonical_publication_replacements WHERE old_revision=? OR new_revision=?)
     AND (SELECT count(*) FROM analytics_canonical_publication_part_subjects WHERE part_revision=?)<=? RETURNING revision`)
     .bind(part,...values,part,part,part,part,remaining),
   ]);
   changed+=result[1]!.results.length*(1+(result[0]!.results[0]?.n??0));
  }
 }
 return changed;
}

export interface CanonicalGraphPublicationRef {
 readonly ownerDigest:string;readonly metric:'fits'|'model';readonly day:string;
 readonly method:string;readonly dependencyDigest:string;readonly payloadSha256:string;readonly empty:boolean;
}
/** Pin exact native fit sample vectors and weights. Every estimator remains in
 * the native finalizer; this store holds immutable result identities only. */
export async function pinCanonicalGraphPublication(db:D1Database,input:{sourceId:string;day:string;metric:'fits'|'model';
 watermark:number;authorityDigest:string;nowMs:number;refs:readonly CanonicalGraphPublicationRef[]}):Promise<string|null> {
 if(input.refs.length>65536||new Set(input.refs.map(row=>row.ownerDigest)).size!==input.refs.length)throw invalid();
 try {
 const refs=await Promise.all(input.refs.map(async row=>{
  canonicalDigest(row.ownerDigest);canonicalDigest(row.dependencyDigest);canonicalDigest(row.payloadSha256);canonicalDay(row.day);
  if(row.day!==input.day||row.metric!==input.metric||typeof row.empty!=='boolean'||!row.method||row.method.length>4096)throw invalid();
  return {...row,partitionKey:'graph/'+row.metric+'/'+row.day+'/'+row.ownerDigest,
   contentRevision:await hash([row.method,row.dependencyDigest,row.payloadSha256])};
 }));
 const authorityDigest=await hash(['native-graph-closure-v1',input.authorityDigest,refs.map(row=>[row.ownerDigest,row.contentRevision])]);
 const closureKey=await beginCanonicalPublicationClosure(db,{sourceId:input.sourceId,day:input.day,family:input.metric,
 watermark:input.watermark,authorityDigest,expectedCount:refs.length,nowMs:input.nowMs});
 for(let offset=0;offset<refs.length;offset+=64){const page=refs.slice(offset,offset+64);
  await appendCanonicalPublicationExpected(db,closureKey,page.map(row=>({partitionKey:row.partitionKey,contentRevision:row.contentRevision})));
 }
 const prior=await readCanonicalPublicationClosure(db,closureKey);
 if(!prior||prior.state==='invalidated')return null;
 if(prior.state==='complete')return prior.completed===prior.expected?closureKey:null;
 if(!await sealCanonicalPublicationExpected(db,closureKey))return null;
 for(let offset=0;offset<refs.length;offset+=64){const page=JSON.stringify(refs.slice(offset,offset+64));
  await db.batch([db.prepare(`INSERT INTO analytics_canonical_publication_graph_refs
   (closure_key,source_id,owner_digest,metric,day,partition_key,content_revision,method,dependency_digest,payload_sha256)
   SELECT ?,?,json_extract(value,'$.ownerDigest'),json_extract(value,'$.metric'),json_extract(value,'$.day'),
    json_extract(value,'$.partitionKey'),json_extract(value,'$.contentRevision'),json_extract(value,'$.method'),
    json_extract(value,'$.dependencyDigest'),json_extract(value,'$.payloadSha256') FROM json_each(?)
   WHERE true ON CONFLICT DO NOTHING`).bind(closureKey,input.sourceId,page),
  db.prepare(`INSERT INTO analytics_canonical_publication_subjects(closure_key,source_id,owner_digest)
   SELECT ?,?,json_extract(value,'$.ownerDigest') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`).bind(closureKey,input.sourceId,page),
  db.prepare(`UPDATE analytics_canonical_publication_expected SET outcome=COALESCE((SELECT CASE json_extract(value,'$.empty')
   WHEN 1 THEN 'empty' ELSE 'unchanged' END FROM json_each(?) WHERE json_extract(value,'$.partitionKey')=partition_key),'pending')
   WHERE closure_key=? AND partition_key IN(SELECT json_extract(value,'$.partitionKey') FROM json_each(?))`).bind(page,closureKey,page)]);
 }
 const committed=await db.prepare(`UPDATE analytics_canonical_publication_closures SET state='complete'
 WHERE closure_key=? AND state='sealed' AND expected_count=(SELECT count(*) FROM analytics_canonical_publication_expected e
 WHERE e.closure_key=analytics_canonical_publication_closures.closure_key) AND NOT EXISTS(
 SELECT 1 FROM analytics_canonical_publication_expected e LEFT JOIN analytics_canonical_publication_graph_refs r
 ON r.closure_key=e.closure_key AND r.partition_key=e.partition_key AND r.content_revision=e.content_revision
 LEFT JOIN analytics_community_graph_results g ON g.source_id=r.source_id AND g.owner_digest=r.owner_digest AND g.metric=r.metric AND g.day=r.day
 WHERE e.closure_key=analytics_canonical_publication_closures.closure_key AND (e.outcome='pending' OR r.content_revision IS NULL
 OR g.payload_sha256 IS NOT r.payload_sha256 OR g.dependency_digest IS NOT r.dependency_digest OR g.method IS NOT r.method))
 RETURNING closure_key`).bind(closureKey).run();
 return returnedD1Target(committed,'closure_key',closureKey)?closureKey:null;
 }catch(error){if(/canonical_publication_authority|FOREIGN KEY/iu.test(String(error)))return null;throw error;}
}
