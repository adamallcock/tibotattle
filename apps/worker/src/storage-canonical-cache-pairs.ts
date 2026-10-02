import type {AnalyticsWorkLease,AnalyticsStoredWork} from './analytics-partition-work';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { canonicalCacheItems } from './cache-retention-events';
import { canonicalCachePair,CANONICAL_CACHE_PAIR_METHOD } from './canonical-cache-pairs';
import { readCanonicalPartition,readCanonicalPartitionManifests,type CanonicalPartitionManifest } from './storage-canonical-analytics-facts';
import { type CanonicalFact,type CanonicalScope } from './canonical-analytics-facts';
import { D1InvocationBudgetExceededError,readD1SchemaObjectsAvailable } from './d1-invocation-budget';
import { CACHE_RETENTION_BAND_IDS,CACHE_RETENTION_METHOD,CACHE_RETENTION_GROUP_LIMIT,CACHE_RETENTION_SESSION_LIMIT,
 CacheRetentionRefusedError,cacheRetentionGroupOrder,validCacheRetentionDayAggregate,validCacheRetentionDayLabel,
 validCacheRetentionEvent,validCacheRetentionSessionBreak,mergeCacheRetentionBands,publicCacheRetentionWindow,
 CACHE_RETENTION_WINDOWS,CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,CACHE_RETENTION_METRIC_ID,
 type CacheRetentionItem,type CacheRetentionBandCounters,type CacheRetentionBandId,type CacheRetentionDayAggregate,
 type CacheRetentionGroup,type CacheRetentionBandRow,type PublicCacheRetentionSeries } from './cache-retention-values';

export const CANONICAL_CACHE_TABLES=Object.freeze(['analytics_canonical_cache_clock','analytics_canonical_cache_logical_work',
 'analytics_canonical_cache_pair_work','analytics_canonical_cache_slots','analytics_canonical_cache_nodes','analytics_canonical_cache_days',
 'analytics_canonical_cache_session_proofs','analytics_canonical_cache_groups','analytics_canonical_cache_window_heads','analytics_canonical_cache_windows',
 'analytics_canonical_cache_pairs','analytics_canonical_cache_counters','analytics_canonical_cache_sessions','analytics_canonical_cache_partitions']);
export const CANONICAL_CACHE_TRIGGERS=Object.freeze(['analytics_canonical_cache_clock_cas','analytics_canonical_cache_effect',
 'analytics_canonical_cache_group_insert','analytics_canonical_cache_group_delete','analytics_canonical_cache_slot_insert','analytics_canonical_cache_slot_delete','analytics_canonical_cache_node_insert',
 'analytics_canonical_cache_node_delete','analytics_canonical_cache_pair_insert','analytics_canonical_cache_pair_delete',
 'analytics_canonical_cache_slot_admit','analytics_canonical_cache_node_admit','analytics_canonical_cache_pair_admit',
 'analytics_canonical_cache_slots_immutable','analytics_canonical_cache_nodes_immutable','analytics_canonical_cache_pairs_immutable',
 'analytics_canonical_cache_fact_remove','analytics_canonical_cache_owner_terminal','analytics_canonical_cache_erasure','analytics_canonical_cache_erasure_update','analytics_canonical_cache_owner_delete']);
export interface CanonicalCacheScope {readonly sourceId:string;readonly ownerDigest:string;readonly selectionMethod:CanonicalScope['selectionMethod']}
export interface CanonicalCacheBudget {remainingQueries():number;now():number;deadlineMs:number}
export interface CanonicalCachePartitionInput {
 readonly target:D1Database;readonly partitionKey:string;readonly budget:CanonicalCacheBudget;
 readonly stillCurrent:()=>Promise<boolean>;readonly maxRepairs?:number;
 /** Cheap live-lease check for each atomic repair; source closure is rechecked at stage boundaries. */
 readonly canCommit?:()=>Promise<boolean>;
 readonly lease?:AnalyticsWorkLease;
}
export interface CanonicalCacheMetrics {slotsWritten:number;logicalRepairs:number;pairRepairs:number;pairEvaluations:number;sourceRecordDecodes:0}
export type CanonicalCachePartitionResult={state:'complete';manifest:CanonicalPartitionManifest;method:typeof CANONICAL_CACHE_PAIR_METHOD;metrics:CanonicalCacheMetrics}
 |{state:'deferred'|'refused';reason:string;metrics:CanonicalCacheMetrics};
interface SlotRow {slot_key:string;fact_revision:string;logical_key:string;source_id:string;owner_digest:string;selection_method:string;day:string;
 observed_ms:number;native_order:number;payload:string}
interface NodeRow {node_key:string;fact_revision:string;source_id:string;owner_digest:string;selection_method:string;day:string;
 session_digest:string|null;observed_ms:number;order_key:string;payload:string;unreadable:number}
interface WorkRow {logical_key?:string;node_key?:string;source_id:string;owner_digest:string;selection_method:string;day:string;generation:number}
interface CounterRow {model:string;effort:string;band:CacheRetentionBandId;adjacencies:number;reused:number;matched:number;ties:number;insufficient:number;contracted:number;sessions:number}
interface CacheRepairSubject extends CanonicalCacheScope {readonly throughDay?:string}
const fail=()=>new TypeError('CANONICAL_CACHE_INVALID');
const sameUtcDay=(ms:number,day:string)=>Number.isSafeInteger(ms)&&Number.isFinite(new Date(ms).getTime())
 &&new Date(ms).toISOString().slice(0,10)===day;
const decode=(payload:string):CacheRetentionItem|null=>{
 if(payload.length>4096)throw fail();const value:unknown=JSON.parse(payload);
 if(value!==null&&!validCacheRetentionEvent(value)&&!validCacheRetentionSessionBreak(value))throw fail();
 return value;
};
const logicalKey=(fact:CanonicalFact)=>[fact.provenance.selectionMethod,fact.provenance.erasureKey,fact.location.day,fact.nativeScopes.logicalOccurrenceKey].join('/');
const enough=(budget:CanonicalCacheBudget,reserve=24)=>budget.remainingQueries()>=reserve&&budget.now()<budget.deadlineMs-1500;
const clock=(db:D1Database)=>db.prepare('SELECT revision FROM analytics_canonical_cache_clock WHERE id=1').first<number>('revision');
const guard=(db:D1Database,revision:number,lease?:AnalyticsWorkLease,nowMs=Date.now())=>lease
 ?db.prepare(`UPDATE analytics_canonical_cache_clock SET expected_revision=COALESCE((SELECT ? FROM analytics_partition_work
   WHERE work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?),-1),revision=revision+1 WHERE id=1`)
  .bind(revision,lease.workKey,lease.revision,lease.claimToken,nowMs)
 :db.prepare('UPDATE analytics_canonical_cache_clock SET expected_revision=?,revision=revision+1 WHERE id=1').bind(revision);
function scopeValues(scope:CanonicalCacheScope):[string,string,string] {
 if(!/^[A-Za-z0-9._:-]{1,128}$/u.test(scope.sourceId)||!/^[a-f0-9]{64}$/u.test(scope.ownerDigest)
  ||!['effective-union-v1','legacy-selected-v1'].includes(scope.selectionMethod))throw fail();
 return [scope.sourceId,scope.ownerDigest,scope.selectionMethod];
}
export async function canonicalCacheAvailable(db:D1Database):Promise<boolean> {
 return readD1SchemaObjectsAvailable(db,[...CANONICAL_CACHE_TABLES.map(name=>['table',name] as const),
  ...CANONICAL_CACHE_TRIGGERS.map(name=>['trigger',name] as const)]);
}
// Day indexes retain public-range reads; these indexes bound an exact subject's
// repair page in native key order across all days without a temporary sort.
const cacheSubjectRepairIndexes=['analytics_canonical_cache_logical_page','analytics_canonical_cache_pair_page'] as const;
const cacheDayRepairIndexes=['analytics_canonical_cache_logical_subject','analytics_canonical_cache_pair_work_subject'] as const;
const subjectPendingSql=`SELECT 1 pending FROM analytics_canonical_cache_logical_work
 INDEXED BY analytics_canonical_cache_logical_page WHERE source_id=? AND owner_digest=? AND selection_method=?
 UNION ALL SELECT 1 FROM analytics_canonical_cache_pair_work INDEXED BY analytics_canonical_cache_pair_page
 WHERE source_id=? AND owner_digest=? AND selection_method=? LIMIT 1`;
const dayPendingSql=`SELECT 1 pending FROM analytics_canonical_cache_logical_work
 INDEXED BY analytics_canonical_cache_logical_subject WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=?
 UNION ALL SELECT 1 FROM analytics_canonical_cache_pair_work INDEXED BY analytics_canonical_cache_pair_work_subject
 WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=? LIMIT 1`;
const futureSubjectWorkSql=`SELECT 1 pending FROM analytics_canonical_cache_logical_work
 INDEXED BY analytics_canonical_cache_logical_subject WHERE source_id=? AND owner_digest=? AND selection_method=? AND day>?
 UNION ALL SELECT 1 FROM analytics_canonical_cache_pair_work INDEXED BY analytics_canonical_cache_pair_work_subject
 WHERE source_id=? AND owner_digest=? AND selection_method=? AND day>? LIMIT 1`;
const subjectPendingValues=(subject:CacheRepairSubject)=>subject.throughDay
 ?[...scopeValues(subject),subject.throughDay,...scopeValues(subject),subject.throughDay]
 :[...scopeValues(subject),...scopeValues(subject)];
const pendingSql=(subject:CacheRepairSubject)=>subject.throughDay?dayPendingSql:subjectPendingSql;
async function subjectRepairAvailable(db:D1Database,dayBounded=false):Promise<boolean> {
 const indexes=dayBounded?cacheDayRepairIndexes:cacheSubjectRepairIndexes;
 if(!await readD1SchemaObjectsAvailable(db,indexes.map(name=>['index',name] as const)))return false;
 for(const [index,table,key] of dayBounded
  ?[[indexes[0],'analytics_canonical_cache_logical_work','day'],[indexes[1],'analytics_canonical_cache_pair_work','day']] as const
  :[[indexes[0],'analytics_canonical_cache_logical_work','logical_key'],[indexes[1],'analytics_canonical_cache_pair_work','node_key']] as const){
  const rows=(await db.prepare(`SELECT i.seqno,i.name,l."unique" unique_index,l.partial,l.origin
   FROM pragma_index_list(?) l JOIN pragma_index_info(l.name) i WHERE l.name=? ORDER BY i.seqno`)
   .bind(table,index).all<{seqno:number;name:string;unique_index:number;partial:number;origin:string}>()).results;
  const columns=['source_id','owner_digest','selection_method',key];
  if(rows.length!==columns.length||rows.some((row,n)=>row.seqno!==n||row.name!==columns[n]
   ||row.unique_index!==0||row.partial!==0||row.origin!=='c'))return false;
 }
 return true;
}
const preparedReceiptTable='analytics_canonical_cache_prepared_receipts';
async function preparedReceiptAvailable(db:D1Database):Promise<boolean> {
 if(!await readD1SchemaObjectsAvailable(db,[['table',preparedReceiptTable]]))return false;
 const table=await db.prepare(`SELECT type,wr,strict FROM pragma_table_list(?)
  WHERE schema='main' AND name=?`).bind(preparedReceiptTable,preparedReceiptTable)
  .first<{type:string;wr:number;strict:number}>();
 if(table?.type!=='table'||table.wr!==1||table.strict!==1)return false;
 const columns=(await db.prepare(`SELECT name,type,pk,"notnull" required FROM pragma_table_info(?) ORDER BY cid`)
  .bind(preparedReceiptTable).all<{name:string;type:string;pk:number;required:number}>()).results;
 const expected=['work_key','work_revision','input_revision','partition_key','method','manifest_generation','row_count'];
 if(columns.length!==expected.length||columns.some((column,index)=>column.name!==expected[index]
  ||column.type!==(index===1||index>=5?'INTEGER':'TEXT')||column.pk!==(index===0?1:0)||column.required!==1))return false;
 const foreign=(await db.prepare(`SELECT "table" target,"from" child,"to" parent,on_delete action
  FROM pragma_foreign_key_list(?)`).bind(preparedReceiptTable)
  .all<{target:string;child:string;parent:string;action:string}>()).results;
 return foreign.length===1&&foreign[0]?.target==='analytics_partition_work'&&foreign[0].child==='work_key'
  &&foreign[0].parent==='work_key'&&foreign[0].action==='CASCADE';
}
// Both the producer and the fair claim selector use this same bounded, exact
// target-state predicate. The manifest row PK and slot fact-revision UNIQUE
// index seek at most sixteen rows; a receipt never proves source freshness.
// Only closed source literals enter this builder. A balanced boolean tree
// retains every proof while fitting the native SQLite depth100 limit when the
// predicate is nested inside atomic fair claim selection and UPDATE triggers.
function cacheProofSql(clauses:readonly string[],operator:'AND'|'OR'='AND'):string {
 if(clauses.length===1)return clauses[0]!;
 const middle=Math.floor(clauses.length/2);
 return `(${cacheProofSql(clauses.slice(0,middle),operator)} ${operator} ${cacheProofSql(clauses.slice(middle),operator)})`;
}
const preparedSlotsCurrentSql=cacheProofSql([
  `m.state='complete'`, `m.partition_key=w.partition_key`,
  `m.partition_key=m.root_partition_key||substr(m.hash_prefix,3)`,
  `substr(m.root_partition_key,-2)=substr(m.hash_prefix,1,2)`,
 `m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)`,
 `m.row_count BETWEEN 1 AND 16`, `m.row_count=r.row_count`, `m.generation=r.manifest_generation`,
 `(SELECT count(*) FROM analytics_canonical_manifest_rows mr WHERE mr.content_revision=m.content_revision)=m.row_count`,
 `NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows mr
  LEFT JOIN analytics_canonical_facts f ON f.revision=mr.revision
  LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=mr.revision
  WHERE mr.content_revision=m.content_revision AND ${cacheProofSql([
   'f.revision IS NULL', 's.fact_revision IS NULL', "f.stream!='usage'", 'f.selection_method IS NOT w.selection_method',
   "s.slot_key!=f.selection_method||'/'||f.occurrence_key", 's.occurrence_key!=f.occurrence_key',
   's.root_partition_key!=m.root_partition_key', 's.source_id!=f.source_id', 's.owner_digest!=f.owner_digest',
   's.selection_method!=f.selection_method','f.partition_key!=m.root_partition_key',
   'substr(f.occurrence_key,1,length(m.hash_prefix))!=m.hash_prefix','s.day IS NOT subject.observed_day',
   "date(s.observed_ms/1000,'unixepoch') IS NOT subject.observed_day"],'OR')})`,
]);
/** Alias `w` is the ordinary fair selector's analytics_partition_work row.
 * Use only after a fresh sidecar presence check. The global negative probe is
 * insufficient for subject repair: an unrelated blocked owner must never hide
 * a healthy prepared leaf. This predicate freshly checks its own bounded page. */
export const CANONICAL_CACHE_PREPARED_READY_PREDICATE=`EXISTS(SELECT 1 FROM ${preparedReceiptTable} r
 JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key AND h.content_revision=r.input_revision
 JOIN analytics_canonical_manifests m ON m.content_revision=h.content_revision
 JOIN analytics_canonical_manifest_rows first_row ON first_row.content_revision=m.content_revision AND first_row.ordinal=0
 JOIN analytics_canonical_facts subject ON subject.revision=first_row.revision
 WHERE ${cacheProofSql([
  'r.work_key=w.work_key', "w.stage='cache'", "w.stream='usage'", "w.state='ready'",
  "w.reason_code='cache_repairs_pending'", 'w.revision=r.work_revision+1',
  'w.input_revision=r.input_revision', 'r.partition_key=w.partition_key',
  `r.method='${CANONICAL_CACHE_PAIR_METHOD}'`, preparedSlotsCurrentSql,
  'w.day=subject.observed_day', "date(subject.observed_at_ms/1000,'unixepoch')=subject.observed_day",
  "EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='analytics_canonical_cache_logical_subject')",
  "EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='analytics_canonical_cache_pair_work_subject')",
  `NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows mr JOIN analytics_canonical_facts f USING(revision)
   WHERE mr.content_revision=m.content_revision AND ${cacheProofSql(['f.source_id!=subject.source_id',
    'f.owner_digest!=subject.owner_digest','f.selection_method!=subject.selection_method',
    'f.observed_day IS NOT subject.observed_day',"date(f.observed_at_ms/1000,'unixepoch') IS NOT subject.observed_day"],'OR')})`,
  `NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_pair_work WHERE ${cacheProofSql([
   'source_id=subject.source_id','owner_digest=subject.owner_digest','selection_method=subject.selection_method','day<=subject.observed_day'])})`,
  `EXISTS(SELECT 1 FROM analytics_canonical_cache_logical_work WHERE ${cacheProofSql([
   'source_id=subject.source_id','owner_digest=subject.owner_digest','selection_method=subject.selection_method','day<=subject.observed_day'])})`,
  `NOT EXISTS(SELECT 1 FROM(SELECT logical_key,selection_method,day FROM analytics_canonical_cache_logical_work
   WHERE ${cacheProofSql(['source_id=subject.source_id',
    'owner_digest=subject.owner_digest','selection_method=subject.selection_method','day<=subject.observed_day'])}
   ORDER BY day,logical_key LIMIT 8) pending WHERE NOT EXISTS(
    SELECT 1 FROM analytics_canonical_facts f INDEXED BY analytics_canonical_cache_fact_logical
    JOIN analytics_canonical_heads fh ON fh.revision=f.revision
    LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision
    WHERE ${cacheProofSql(['f.selection_method=pending.selection_method',
     'f.erasure_key=substr(pending.logical_key,length(pending.selection_method)+2,64)',
     'f.observed_day=pending.day',
     'f.native_logical_occurrence_key=substr(pending.logical_key,length(pending.selection_method)+78)',
     's.slot_key IS NULL'])} LIMIT 1))`,
 ])})`;
/** A producer stores only a target preparation receipt after its full source
 * proof and guarded slot write. An interrupted lease cannot create one. */
export async function recordCanonicalCachePreparedReceipt(input:{target:D1Database;lease:AnalyticsWorkLease;
 partition:{manifest:CanonicalPartitionManifest;facts:readonly CanonicalFact[]};budget:CanonicalCacheBudget}):Promise<boolean> {
 const {target,lease,partition,budget}=input,{manifest,facts}=partition;
 const match=/^(effective-union-v1|legacy-selected-v1)\/usage\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u.exec(manifest.partitionKey);
 if(!match||!enough(budget,8)||manifest.rowCount<1||manifest.rowCount>16||facts.length!==manifest.rowCount)return false;
 const root=manifest.partitionKey.slice(0,-match[3]!.length)+match[3]!.slice(0,2);
 if(facts.some(fact=>fact.stream!=='usage'||fact.location.partitionKey!==root
  ||!fact.occurrenceKey.startsWith(match[3]!)))return false;
 try {
  if(!await preparedReceiptAvailable(target))return false;
  const inserted=await target.prepare(`INSERT INTO ${preparedReceiptTable}
   (work_key,work_revision,input_revision,partition_key,method,manifest_generation,row_count)
   SELECT w.work_key,w.revision,w.input_revision,w.partition_key,?,m.generation,m.row_count
   FROM analytics_partition_work w JOIN analytics_canonical_partition_heads h
    ON h.partition_key=w.partition_key AND h.content_revision=w.input_revision
   JOIN analytics_canonical_manifests m ON m.content_revision=h.content_revision
   WHERE w.work_key=? AND w.revision=? AND w.claim_token=? AND w.state='leased' AND w.claim_expires_ms>?
   AND w.stage='cache' AND w.stream='usage' AND w.input_revision=? AND w.partition_key=?
   AND m.partition_key=w.partition_key AND m.generation=? AND m.row_count=? AND m.row_count BETWEEN 1 AND 16
   AND m.partition_key=m.root_partition_key||substr(m.hash_prefix,3)
   AND substr(m.root_partition_key,-2)=substr(m.hash_prefix,1,2)
   AND (SELECT count(*) FROM analytics_canonical_manifest_rows mr WHERE mr.content_revision=m.content_revision)=m.row_count
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows mr
    LEFT JOIN analytics_canonical_facts f ON f.revision=mr.revision
    LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=mr.revision
    WHERE mr.content_revision=m.content_revision AND (f.revision IS NULL OR s.fact_revision IS NULL
     OR f.stream!='usage' OR f.selection_method IS NOT w.selection_method
     OR s.slot_key!=f.selection_method||'/'||f.occurrence_key
     OR s.occurrence_key!=f.occurrence_key OR s.root_partition_key!=m.root_partition_key
     OR s.source_id!=f.source_id OR s.owner_digest!=f.owner_digest OR s.selection_method!=f.selection_method
     OR f.partition_key!=m.root_partition_key OR substr(f.occurrence_key,1,length(m.hash_prefix))!=m.hash_prefix))
   AND m.state='complete' AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions
    WHERE partition_key=m.root_partition_key),0)
   ON CONFLICT(work_key) DO UPDATE SET work_revision=excluded.work_revision,input_revision=excluded.input_revision,
    partition_key=excluded.partition_key,method=excluded.method,manifest_generation=excluded.manifest_generation,
    row_count=excluded.row_count RETURNING work_key`)
   .bind(CANONICAL_CACHE_PAIR_METHOD,lease.workKey,lease.revision,lease.claimToken,budget.now(),manifest.contentRevision,
    manifest.partitionKey,manifest.generation,manifest.rowCount).first<string>('work_key');
  return inserted===lease.workKey;
 }catch(error){if(error instanceof Error&&/no such table|no such column|no such index/iu.test(error.message))return false;throw error;}
}
/** Fresh global negative probe for exactly the repair page used by cache
 * materialization. Unknown schema, index, deadline or budget takes the normal
 * claim path. This boolean is valid only during its current invocation. */
export async function canonicalCacheRepairPageBlocked(input:{target:D1Database;budget:CanonicalCacheBudget}):Promise<boolean> {
 const {target,budget}=input;
 if(!enough(budget,120))return false;
 try {
  if(!await preparedReceiptAvailable(target)||!await canonicalCacheAvailable(target)
   ||!await subjectRepairAvailable(target)||!await subjectRepairAvailable(target,true))return false;
  if(!enough(budget,111))return false;
  // The resumed producer's exact leaf-slot walk must stay indexed too. A
  // zero-row probe checks the physical index without reading any slot rows.
  await target.prepare(`SELECT 1 FROM analytics_canonical_cache_slots
   INDEXED BY analytics_canonical_cache_slots_partition
   WHERE root_partition_key='' LIMIT 0`).first();
  const pair=await target.prepare('SELECT 1 pending FROM analytics_canonical_cache_pair_work LIMIT 1').first<number>('pending');
  if(pair!==null||!enough(budget,110))return false;
  const logicals=(await target.prepare(`SELECT logical_key,selection_method,day FROM analytics_canonical_cache_logical_work
   ORDER BY logical_key LIMIT 8`).all<{logical_key:string;selection_method:string;day:string}>()).results;
  if(!logicals.length)return false;
  for(const work of logicals){
   if(!enough(budget,100))return false;
   const parts=work.logical_key.split('/');
   if(parts.length!==4||parts[0]!==work.selection_method||parts[2]!==work.day)return false;
   const missing=await target.prepare(`SELECT 1 missing FROM analytics_canonical_facts f INDEXED BY analytics_canonical_cache_fact_logical
    JOIN analytics_canonical_heads h ON h.revision=f.revision
    LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision
    WHERE f.selection_method=? AND f.erasure_key=? AND f.observed_day=? AND f.native_logical_occurrence_key=?
    AND s.slot_key IS NULL LIMIT 1`).bind(work.selection_method,parts[1],work.day,parts[3]).first<number>('missing');
   if(missing!==1)return false;
  }
  return true;
 }catch(error){if(error instanceof Error&&/no such table|no such column|no such index/iu.test(error.message))return false;throw error;}
}
/** Negative scheduling hint for a cache leaf whose exact physical slots are
 * already present but whose bounded own-subject repair page cannot yet advance.
 * It never proves source freshness or cache completion. A false/uncertain hint
 * takes the original, fully guarded materialization path. */
export async function canonicalCachePreparedRepairBlocked(input:{target:D1Database;
 partition:{manifest:CanonicalPartitionManifest;facts:readonly CanonicalFact[]};
 lease:AnalyticsWorkLease;budget:CanonicalCacheBudget}):Promise<boolean> {
 const {target,partition,lease,budget}=input,{manifest,facts}=partition;
 const match=/^(effective-union-v1|legacy-selected-v1)\/(usage)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u.exec(manifest.partitionKey);
 if(!match||manifest.rowCount<1||manifest.rowCount>16||facts.length!==manifest.rowCount
  ||facts.some(fact=>fact.stream!=='usage'||fact.provenance.selectionMethod!==match[1]))return false;
 // The common two-page path retains its sixteen-statement bound. A future
 // page uses five more queries only when enough budget remains above 100.
 // Never spend the last source-proof allowance to decide a negative hint.
 if(!enough(budget,116))return false;
 const root=manifest.partitionKey.slice(0,-match[4]!.length)+match[4]!.slice(0,2),prefix=match[4]!;
 try {
  // Name presence alone cannot qualify INDEXED BY: a same-name partial or
  // differently ordered index must take the ordinary guarded producer path.
  if(!await subjectRepairAvailable(target)||!enough(budget,113))return false;
  const current=await target.prepare(`SELECT subject.source_id,subject.owner_digest,subject.selection_method,subject.observed_day,subject.observed_at_ms FROM analytics_canonical_partition_heads h
   JOIN analytics_canonical_manifests m USING(content_revision)
   JOIN analytics_canonical_manifest_rows first_row ON first_row.content_revision=m.content_revision AND first_row.ordinal=0
   JOIN analytics_canonical_facts subject ON subject.revision=first_row.revision
   WHERE h.partition_key=? AND h.content_revision=? AND m.state='complete'
   AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
   AND EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.work_key=? AND w.revision=?
    AND w.claim_token=? AND w.state='leased' AND w.claim_expires_ms>?)
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows mr JOIN analytics_canonical_facts f USING(revision)
    WHERE mr.content_revision=m.content_revision AND (f.source_id!=subject.source_id OR f.owner_digest!=subject.owner_digest
     OR f.selection_method!=subject.selection_method))`)
   .bind(manifest.partitionKey,manifest.contentRevision,lease.workKey,lease.revision,lease.claimToken,budget.now())
   .first<{source_id:string;owner_digest:string;selection_method:CanonicalScope['selectionMethod'];observed_day:string|null;observed_at_ms:number|null}>();
  if(!current||!enough(budget,111))return false;
  const slots=(await target.prepare(`SELECT slot_key,fact_revision,occurrence_key,root_partition_key,day,observed_ms
   FROM analytics_canonical_cache_slots INDEXED BY analytics_canonical_cache_slots_partition
   WHERE root_partition_key=? AND occurrence_key>=? AND occurrence_key<?
   ORDER BY occurrence_key LIMIT 17`).bind(root,prefix,prefix+'g')
   .all<{slot_key:string;fact_revision:string;occurrence_key:string;root_partition_key:string;day:string;observed_ms:number}>()).results;
  if(slots.length!==facts.length||!facts.every(fact=>slots.some(slot=>slot.fact_revision===fact.revision
   &&slot.occurrence_key===fact.occurrenceKey&&slot.root_partition_key===root
   &&slot.slot_key===fact.provenance.selectionMethod+'/'+fact.occurrenceKey
   &&slot.day===fact.location.day&&sameUtcDay(slot.observed_ms,slot.day))))return false;
  if(!enough(budget,110))return false;
  // The ordinary repair call reads the first eight logical keys, then the
  // first eight pair keys. A pair key is always processable; a logical key
  // blocked by an unprepared current slot makes no write in that repair page.
  const values=scopeValues({sourceId:current.source_id,ownerDigest:current.owner_digest,selectionMethod:current.selection_method});
  const currentDay=current.observed_day;
  if(!validCacheRetentionDayLabel(currentDay)||currentDay!==match[3]
   ||current.observed_at_ms===null||!sameUtcDay(current.observed_at_ms,currentDay)
   ||facts.some(fact=>fact.location.day!==currentDay
    ||fact.location.observedAtMs===null||!sameUtcDay(fact.location.observedAtMs,currentDay)))return false;
  // Preserve the original two physical page-index probes. Their exact
  // no-future result is cheaper and retains the original negative contract.
  const originalPair=await target.prepare(`SELECT day FROM analytics_canonical_cache_pair_work
   INDEXED BY analytics_canonical_cache_pair_page WHERE source_id=? AND owner_digest=? AND selection_method=? LIMIT 1`)
   .bind(...values).first<string>('day');
  if(!enough(budget,109))return false;
  const originalLogicals=(await target.prepare(`SELECT logical_key,selection_method,day FROM analytics_canonical_cache_logical_work
   INDEXED BY analytics_canonical_cache_logical_page WHERE source_id=? AND owner_digest=? AND selection_method=?
   ORDER BY logical_key LIMIT 8`).bind(...values).all<{logical_key:string;selection_method:string;day:string}>()).results;
  const needsDayScope=(originalPair!==null&&originalPair>currentDay)
   ||originalLogicals.some(work=>work.day>currentDay);
  if(originalPair!==null&&!needsDayScope)return false;
  let logicals=originalLogicals;
  if(needsDayScope){
   if(!enough(budget,114)||!await subjectRepairAvailable(target,true)||!enough(budget,108))return false;
   const dayPair=await target.prepare(`SELECT 1 pending FROM analytics_canonical_cache_pair_work
    INDEXED BY analytics_canonical_cache_pair_work_subject WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=? LIMIT 1`)
    .bind(...values,currentDay).first<number>('pending');
   if(dayPair!==null||!enough(budget,107))return false;
   logicals=(await target.prepare(`SELECT logical_key,selection_method,day FROM analytics_canonical_cache_logical_work
    INDEXED BY analytics_canonical_cache_logical_subject WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=?
    ORDER BY day,logical_key LIMIT 8`).bind(...values,currentDay).all<{logical_key:string;selection_method:string;day:string}>()).results;
  }
  if(!logicals.length)return false;
  for(const work of logicals){
   if(!enough(budget,100))return false;
   const parts=work.logical_key.split('/');
   if(parts.length!==4||parts[0]!==work.selection_method||parts[2]!==work.day)return false;
   const missing=await target.prepare(`SELECT 1 missing FROM analytics_canonical_facts f INDEXED BY analytics_canonical_cache_fact_logical
    JOIN analytics_canonical_heads h ON h.revision=f.revision
    LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision
    WHERE f.selection_method=? AND f.erasure_key=? AND f.observed_day=? AND f.native_logical_occurrence_key=?
    AND s.slot_key IS NULL LIMIT 1`).bind(work.selection_method,parts[1],work.day,parts[3]).first<number>('missing');
   if(missing!==1)return false;
  }
  // The ordinary stage refuses a partial cache schema. A negative shortcut
  // cannot indefinitely defer that same refusal after a required object goes.
  if(!enough(budget,101)||!await canonicalCacheAvailable(target))return false;
  return true;
 }catch(error){
  if(error instanceof Error&&/no such table|no such column|no such index/iu.test(error.message))return false;
  throw error;
 }
}
/** Persist every selected physical slot, then elect one logical/day node and
 * repair only each changed node's incoming pair and immediate successor. No
 * source records or source-day scans occur here. Atomic CAS batches make a
 * killed repair replayable; pending work makes readers refuse partial totals. */
export async function materializeCanonicalCachePartition(input:CanonicalCachePartitionInput):Promise<CanonicalCachePartitionResult> {
 const metrics:CanonicalCacheMetrics={slotsWritten:0,logicalRepairs:0,pairRepairs:0,pairEvaluations:0,sourceRecordDecodes:0};
 const result=(state:'deferred'|'refused',reason:string):CanonicalCachePartitionResult=>({state,reason,metrics});
 try {
  const db=input.target;if(!enough(input.budget,48))return result('deferred','query_budget');
  if(!await canonicalCacheAvailable(db))return result('refused','migration_required');
  if(!await input.stillCurrent())return result('deferred','source_changed');
  const partition=await readCanonicalPartition(db,input.partitionKey);if(!partition)return result('deferred','canonical_partition_changed');
  const {manifest,facts}=partition;let repairSubject:CacheRepairSubject|undefined;
  const match=/^(effective-union-v1|legacy-selected-v1)\/(usage|quota|session)\/(\d{4}-\d{2}-\d{2}|unknown)\/([a-f0-9]{2,64})$/u.exec(input.partitionKey);
  if(!match)throw fail();
  if(match[2]==='usage') {
   // Full validation is performed by the P1 sealed partition reader above.
   await canonicalCacheItems(facts);
   const root=input.partitionKey.slice(0,-match[4]!.length)+match[4]!.slice(0,2),prefix=match[4]!;
   const revision=await clock(db);if(revision===null)throw fail();
   const existing=(await db.prepare(`SELECT slot_key,fact_revision,source_id,owner_digest,selection_method,day,observed_ms FROM analytics_canonical_cache_slots
    WHERE root_partition_key=? AND occurrence_key>=? AND occurrence_key<?`).bind(root,prefix,prefix+'g')
    .all<{slot_key:string;fact_revision:string;source_id:string;owner_digest:string;selection_method:CanonicalScope['selectionMethod'];day:string;observed_ms:number}>()).results;
   const metadata=(await db.prepare(`SELECT revision,source_id,owner_digest FROM analytics_canonical_facts
    WHERE revision IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(facts.map(fact=>fact.revision)))
    .all<{revision:string;source_id:string;owner_digest:string}>()).results;
   const subjects=new Map<string,CanonicalCacheScope>();
   for(const row of metadata){const subject={sourceId:row.source_id,ownerDigest:row.owner_digest,selectionMethod:match[1] as CanonicalScope['selectionMethod']};
    subjects.set(JSON.stringify(scopeValues(subject)),subject);}
   for(const row of existing){const subject={sourceId:row.source_id,ownerDigest:row.owner_digest,selectionMethod:row.selection_method};
    subjects.set(JSON.stringify(scopeValues(subject)),subject);}
   // Current facts must prove the subject. Empty or mixed leaves retain the
   // original global path; an owner is never inferred from a manifest digest.
   if(facts.length&&metadata.length===facts.length&&subjects.size===1){
    const subject=subjects.values().next().value;
    if(!subject)return result('refused','scope_capacity');
    repairSubject=subject;
    if(!await subjectRepairAvailable(db))return result('refused','migration_required');
    // The native event's UTC day is its slot day. A later node can change
    // its own incoming pair, never an earlier node's incoming pair. The
    // singleton may therefore close through this proved day while later
    // subject work remains pending. Unknown/mixed rows keep the old path.
    if(input.lease&&validCacheRetentionDayLabel(match[3])
     &&facts.every(fact=>fact.location.day===match[3]
      &&fact.location.observedAtMs!==null&&sameUtcDay(fact.location.observedAtMs,match[3]!))
     &&existing.every(slot=>slot.day===match[3]&&sameUtcDay(slot.observed_ms,match[3]!))
     &&enough(input.budget,48)&&await subjectRepairAvailable(db,true)){
     const values=scopeValues(subject),day=match[3]!;
     if(!enough(input.budget,24))return result('deferred','query_budget');
     const future=await db.prepare(futureSubjectWorkSql).bind(...values,day,...values,day).first<number>('pending');
     if(future===1)repairSubject={...subject,throughDay:day};
    }
   }
   const writes:D1PreparedStatement[]=[];
   const current=new Set(facts.map(fact=>fact.revision));
   for(const row of existing)if(!current.has(row.fact_revision))writes.push(db.prepare('DELETE FROM analytics_canonical_cache_slots WHERE slot_key=? AND fact_revision=?').bind(row.slot_key,row.fact_revision));
   for(const fact of facts)if(!existing.some(row=>row.fact_revision===fact.revision)) {
    const meta=metadata.find(row=>row.revision===fact.revision);if(!meta)throw fail();
    const {items}=await canonicalCacheItems([fact]),payload=canonicalJson(items[0]??null);
    writes.push(db.prepare('DELETE FROM analytics_canonical_cache_slots WHERE slot_key=? AND fact_revision!=?')
     .bind(fact.provenance.selectionMethod+'/'+fact.occurrenceKey,fact.revision));
    writes.push(db.prepare(`INSERT INTO analytics_canonical_cache_slots(slot_key,fact_revision,occurrence_key,root_partition_key,
     logical_key,source_id,owner_digest,selection_method,day,observed_ms,native_order,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
     .bind(fact.provenance.selectionMethod+'/'+fact.occurrenceKey,fact.revision,fact.occurrenceKey,root,logicalKey(fact),
      meta.source_id,meta.owner_digest,fact.provenance.selectionMethod,fact.location.day,fact.location.observedAtMs,fact.location.nativeOrder,payload));
    metrics.slotsWritten++;
   }
   if(writes.length) {
    if(!enough(input.budget,writes.length+16)||!await (input.canCommit??input.stillCurrent)())return result('deferred','query_budget');
    await db.batch([guard(db,revision,input.lease,input.budget.now()),...writes]);
   }
  }
  if(!enough(input.budget))return result('deferred','query_budget');
  const repaired=await repairCanonicalCacheNeighborsGuarded({...input,metrics},
   revision=>guard(db,revision,input.lease,input.budget.now()),repairSubject);
  if(!repaired)return result('deferred','cache_repairs_pending');
  if(!await input.stillCurrent())return result('deferred','source_changed');
  // Manifest FK plus current-head admission prevent a stale worker marking a
  // replacement revision complete, including empty old partitions after moves.
  const leaseClause=input.lease?` AND EXISTS(SELECT 1 FROM analytics_partition_work WHERE work_key=? AND revision=? AND claim_token=? AND state='leased' AND claim_expires_ms>?)`:'';
  const leaseValues=input.lease?[input.lease.workKey,input.lease.revision,input.lease.claimToken,input.budget.now()]:[];
  await db.prepare(`INSERT INTO analytics_canonical_cache_partitions(partition_key,content_revision,method)
   SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM analytics_canonical_partition_heads h JOIN analytics_canonical_manifests m USING(content_revision)
   WHERE h.partition_key=? AND h.content_revision=? AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0))${leaseClause}${repairSubject?` AND NOT EXISTS(${pendingSql(repairSubject)})`:''}
   ON CONFLICT(partition_key) DO UPDATE SET content_revision=excluded.content_revision,method=excluded.method
   WHERE analytics_canonical_cache_partitions.content_revision!=excluded.content_revision OR analytics_canonical_cache_partitions.method!=excluded.method`)
   .bind(input.partitionKey,manifest.contentRevision,CACHE_RETENTION_METHOD.version,input.partitionKey,manifest.contentRevision,...leaseValues,
    ...(repairSubject?subjectPendingValues(repairSubject):[])).run();
  if(!await (input.canCommit??input.stillCurrent)())return result('deferred','source_changed');
  if(repairSubject&&(await db.prepare(`SELECT 1 ready FROM analytics_canonical_cache_partitions
   WHERE partition_key=? AND content_revision=? AND NOT EXISTS(${pendingSql(repairSubject)})`)
   .bind(input.partitionKey,manifest.contentRevision,...subjectPendingValues(repairSubject)).first<number>('ready'))!==1)
   return result('deferred','cache_repairs_pending');
  return {state:'complete',manifest,method:CANONICAL_CACHE_PAIR_METHOD,metrics};
 } catch(error) {
  if(error instanceof D1InvocationBudgetExceededError)throw error;
  if(error instanceof CacheRetentionRefusedError)return result('refused',error.reason);
  if(error instanceof Error&&error.message==='CACHE_RETENTION_UNAVAILABLE')return result('refused','usage_row_refused');
  if(String(error).includes('canonical_cache_changed')||String(error).includes('canonical_cache_authority'))return result('deferred','canonical_changed');
  throw error;
 }
}

export interface CanonicalCachePartitionGroupInput {
 readonly target:D1Database;readonly members:readonly {readonly lease:AnalyticsWorkLease;readonly work:AnalyticsStoredWork;
  readonly manifest:CanonicalPartitionManifest;readonly facts:readonly CanonicalFact[]}[];
 readonly budget:CanonicalCacheBudget;readonly stillCurrent:()=>Promise<boolean>;readonly canCommit:()=>Promise<boolean>;
 readonly maxRepairs?:number;
}
export type CanonicalCachePartitionGroupResult={state:'complete';manifests:readonly CanonicalPartitionManifest[];
 method:typeof CANONICAL_CACHE_PAIR_METHOD;metrics:CanonicalCacheMetrics}
 |{state:'deferred'|'refused';reason:string;metrics:CanonicalCacheMetrics};
/** Bounded original-leaf cache preparation. No durable group identity: every
 * member keeps its original immutable manifest, lease and sealed cache row.
 * Stage all physical candidates before one native logical/pair repair page. */
export async function materializeCanonicalCachePartitionGroup(input:CanonicalCachePartitionGroupInput):Promise<CanonicalCachePartitionGroupResult> {
 const metrics:CanonicalCacheMetrics={slotsWritten:0,logicalRepairs:0,pairRepairs:0,pairEvaluations:0,sourceRecordDecodes:0};
 const result=(state:'deferred'|'refused',reason:string):CanonicalCachePartitionGroupResult=>({state,reason,metrics});
 const {target:db,budget,members}=input;
 if(!Array.isArray(members)||!members.length||members.length>8
  ||new Set(members.map(member=>member.lease.workKey)).size!==members.length
  ||new Set(members.map(member=>member.manifest.partitionKey)).size!==members.length)throw fail();
 const parsed=members.map(member=>/^(effective-union-v1)\/(usage)\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{2,64})$/u.exec(member.manifest.partitionKey)
  ??/^(legacy-selected-v1)\/(usage)\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{2,64})$/u.exec(member.manifest.partitionKey));
 const facts=members.flatMap(member=>member.facts);
 if(facts.length<1||facts.length>16||new Set(facts.map(fact=>fact.revision)).size!==facts.length
  ||new Set(facts.map(fact=>fact.occurrenceKey)).size!==facts.length
  ||members.reduce((sum,member)=>sum+member.work.residentBytes,0)>32*1024*1024
  ||members.some((member,index)=>!parsed[index]||member.work.stage!=='cache'||member.lease.stage!=='cache'
   ||member.work.workKey!==member.lease.workKey||member.work.headKey!==member.lease.headKey||member.work.attempts!==1
   ||member.work.inputRevision!==member.manifest.contentRevision||member.work.partitionKey!==member.manifest.partitionKey
   ||member.manifest.rowCount<1||member.manifest.rowCount!==member.facts.length||member.manifest.rows.length!==member.facts.length
   ||!Number.isSafeInteger(member.work.residentBytes)||member.work.residentBytes<0
   ||member.work.sourceId!==members[0]!.work.sourceId||member.work.policyRevision!==members[0]!.work.policyRevision
   ||member.work.day!==parsed[index]![3]||member.work.stream!=='usage'||member.work.selectionMethod!==parsed[index]![1]
   ||member.work.day!==members[0]!.work.day||member.work.selectionMethod!==members[0]!.work.selectionMethod
   ||members.some((other,otherIndex)=>index!==otherIndex&&member.manifest.partitionKey.startsWith(other.manifest.partitionKey))))
  return result('refused','group_capacity');
 const expected=members.map(({lease,work,manifest})=>({workKey:work.workKey,headKey:work.headKey,sourceId:work.sourceId,
  ownerDigest:work.ownerDigest,partitionKey:work.partitionKey,inputRevision:work.inputRevision,policyRevision:work.policyRevision,
  day:work.day,stream:work.stream,selectionMethod:work.selectionMethod,revision:lease.revision,claimToken:lease.claimToken,
  contentRevision:manifest.contentRevision,generation:manifest.generation,rowCount:manifest.rowCount}));
 const encoded=JSON.stringify(expected);
 const memberGuard=(revision:number)=>db.prepare(`UPDATE analytics_canonical_cache_clock SET expected_revision=
  CASE WHEN(SELECT count(*) FROM json_each(?1) e
   JOIN analytics_partition_work w ON w.work_key=json_extract(e.value,'$.workKey')
   JOIN analytics_canonical_partition_heads h ON h.partition_key=w.partition_key
   JOIN analytics_canonical_manifests m ON m.content_revision=h.content_revision
   WHERE w.head_key=json_extract(e.value,'$.headKey') AND w.source_id=json_extract(e.value,'$.sourceId')
   AND w.owner_digest IS json_extract(e.value,'$.ownerDigest') AND w.partition_key=json_extract(e.value,'$.partitionKey')
   AND w.input_revision=json_extract(e.value,'$.inputRevision') AND w.policy_revision=json_extract(e.value,'$.policyRevision')
   AND w.day IS json_extract(e.value,'$.day') AND w.stream='usage' AND w.selection_method=json_extract(e.value,'$.selectionMethod')
   AND w.stage='cache' AND w.state='leased' AND w.revision=json_extract(e.value,'$.revision')
   AND w.claim_token=json_extract(e.value,'$.claimToken') AND w.claim_expires_ms>?2
   AND w.claim_expires_ms>(julianday('now')-2440587.5)*86400000
   AND h.content_revision=json_extract(e.value,'$.contentRevision') AND m.state='complete'
   AND m.generation=json_extract(e.value,'$.generation') AND m.row_count=json_extract(e.value,'$.rowCount')
   AND m.generation=COALESCE((SELECT generation FROM analytics_canonical_dirty_partitions WHERE partition_key=m.root_partition_key),0)
  )=?3 THEN ?4 ELSE -1 END,revision=revision+1 WHERE id=1`).bind(encoded,budget.now(),members.length,revision);
 try{
  if(!enough(budget,80))return result('deferred','query_budget');
  if(!await canonicalCacheAvailable(db))return result('refused','migration_required');
  if(!await input.stillCurrent())return result('deferred','source_changed');
  const currentManifests=await readCanonicalPartitionManifests(db,members.map(member=>({partitionKey:member.manifest.partitionKey,contentRevision:member.manifest.contentRevision})));
  if(!currentManifests||canonicalJson(currentManifests)!==canonicalJson(members.map(member=>member.manifest)))return result('deferred','canonical_partition_changed');
  const metadata=(await db.prepare(`SELECT revision,source_id,owner_digest,observed_day,stream,selection_method
   FROM analytics_canonical_facts WHERE revision IN(SELECT value FROM json_each(?)) ORDER BY revision`)
   .bind(JSON.stringify(facts.map(fact=>fact.revision))).all<{revision:string;source_id:string;owner_digest:string;
    observed_day:string;stream:string;selection_method:string}>()).results;
  if(metadata.length!==facts.length||new Set(metadata.map(row=>JSON.stringify([row.source_id,row.owner_digest,row.observed_day,row.stream,row.selection_method]))).size!==1
   ||metadata.some(row=>row.source_id!==members[0]!.work.sourceId||row.observed_day!==members[0]!.work.day
    ||row.stream!=='usage'||row.selection_method!==members[0]!.work.selectionMethod))return result('refused','scope_capacity');
  const repairSubject:CanonicalCacheScope={sourceId:metadata[0]!.source_id,ownerDigest:metadata[0]!.owner_digest,
   selectionMethod:metadata[0]!.selection_method as CanonicalScope['selectionMethod']};
  if(!await subjectRepairAvailable(db))return result('refused','migration_required');
  const payloads=new Map<string,string>();
  for(const member of members)for(const [index,fact] of member.facts.entries()){
   const row=member.manifest.rows[index],{revision,...body}=fact;
   if(!row||fact.revision!==row.revision||fact.occurrenceKey!==row.occurrenceKey||fact.provenance.digest!==row.provenanceDigest
    ||fact.provenance.erasureKey!==row.erasureKey||await sha256Hex(canonicalJson(body))!==revision)return result('refused','canonical_fact_invalid');
   // Keep every physical candidate. The native logical winner is elected by
   // the repair queue; converting a union would deduplicate these slots early.
   const {items}=await canonicalCacheItems([fact]);payloads.set(fact.revision,canonicalJson(items[0]??null));
  }
  const existing:{slot_key:string;fact_revision:string}[]=[];
  for(const [index,member] of members.entries()){
   if(!enough(budget,60))return result('deferred','query_budget');
   const prefix=parsed[index]![4]!,root=member.manifest.partitionKey.slice(0,-prefix.length)+prefix.slice(0,2);
   const rows=(await db.prepare(`SELECT slot_key,fact_revision FROM analytics_canonical_cache_slots
    INDEXED BY analytics_canonical_cache_slots_partition
    WHERE root_partition_key=? AND occurrence_key>=? AND occurrence_key<? LIMIT 17`).bind(root,prefix,prefix+'g')
    .all<{slot_key:string;fact_revision:string}>()).results;
   if(rows.length>16||existing.length+rows.length>16)return result('refused','old_slot_capacity');existing.push(...rows);
  }
  const writes:D1PreparedStatement[]=[],revisions=new Set(facts.map(fact=>fact.revision));
  for(const row of existing)if(!revisions.has(row.fact_revision))writes.push(db.prepare('DELETE FROM analytics_canonical_cache_slots WHERE slot_key=? AND fact_revision=?').bind(row.slot_key,row.fact_revision));
  for(const [index,member] of members.entries())for(const fact of member.facts)if(!existing.some(row=>row.fact_revision===fact.revision)){
   const prefix=parsed[index]![4]!,root=member.manifest.partitionKey.slice(0,-prefix.length)+prefix.slice(0,2),meta=metadata.find(row=>row.revision===fact.revision)!;
   writes.push(db.prepare('DELETE FROM analytics_canonical_cache_slots WHERE slot_key=? AND fact_revision!=?')
    .bind(fact.provenance.selectionMethod+'/'+fact.occurrenceKey,fact.revision));
   writes.push(db.prepare(`INSERT INTO analytics_canonical_cache_slots(slot_key,fact_revision,occurrence_key,root_partition_key,
    logical_key,source_id,owner_digest,selection_method,day,observed_ms,native_order,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(fact.provenance.selectionMethod+'/'+fact.occurrenceKey,fact.revision,fact.occurrenceKey,root,logicalKey(fact),
     meta.source_id,meta.owner_digest,fact.provenance.selectionMethod,fact.location.day,fact.location.observedAtMs,fact.location.nativeOrder,payloads.get(fact.revision)!));
   metrics.slotsWritten++;
  }
  if(writes.length){
   if(!enough(budget,writes.length+60)||!await input.canCommit())return result('deferred','query_budget');
   const revision=await clock(db);if(revision===null)throw fail();
   await db.batch([memberGuard(revision),...writes]);
  }
  if(!await input.stillCurrent())return result('deferred','source_changed');
  const repaired=await repairCanonicalCacheNeighborsGuarded({...input,metrics,maxRepairs:Math.min(8,input.maxRepairs??8)},memberGuard,repairSubject);
  if(!repaired)return result('deferred','cache_repairs_pending');
  if(!await input.stillCurrent())return result('deferred','source_changed');
  const finalManifests=await readCanonicalPartitionManifests(db,members.map(member=>({partitionKey:member.manifest.partitionKey,contentRevision:member.manifest.contentRevision})));
  if(!finalManifests||canonicalJson(finalManifests)!==canonicalJson(currentManifests))return result('deferred','canonical_partition_changed');
  if(!enough(budget,members.length+24)||!await input.canCommit())return result('deferred','query_budget');
  const revision=await clock(db);if(revision===null)throw fail();
  await db.batch([memberGuard(revision),...members.map(member=>db.prepare(`INSERT INTO analytics_canonical_cache_partitions(partition_key,content_revision,method)
   SELECT ?,?,? WHERE NOT EXISTS(${subjectPendingSql})
   ON CONFLICT(partition_key) DO UPDATE SET content_revision=excluded.content_revision,method=excluded.method
   WHERE analytics_canonical_cache_partitions.content_revision!=excluded.content_revision OR analytics_canonical_cache_partitions.method!=excluded.method`)
   .bind(member.manifest.partitionKey,member.manifest.contentRevision,CACHE_RETENTION_METHOD.version,...subjectPendingValues(repairSubject)))]);
  if(!await input.stillCurrent())return result('deferred','source_changed');
  if(await db.prepare(subjectPendingSql).bind(...subjectPendingValues(repairSubject)).first<number>('pending')!==null)
   return result('deferred','cache_repairs_pending');
  return {state:'complete',manifests:currentManifests,method:CANONICAL_CACHE_PAIR_METHOD,metrics};
 }catch(error){
  if(error instanceof D1InvocationBudgetExceededError)throw error;
  if(error instanceof CacheRetentionRefusedError)return result('refused',error.reason);
  if(error instanceof Error&&error.message==='CACHE_RETENTION_UNAVAILABLE')return result('refused','usage_row_refused');
  if(String(error).includes('canonical_cache_changed')||String(error).includes('canonical_cache_authority'))return result('deferred','canonical_changed');
  throw error;
 }
}

/** Bounded global repair queue. A blocked logical key does not prevent other
 * ready keys in this page from advancing. Source freshness belongs to the
 * supplied closure; own FK/clock checks also guard every transaction. */
type CanonicalCacheRepairInput={target:D1Database;budget:CanonicalCacheBudget;stillCurrent:()=>Promise<boolean>;
 maxRepairs?:number;metrics?:CanonicalCacheMetrics;canCommit?:()=>Promise<boolean>;lease?:AnalyticsWorkLease};
export async function repairCanonicalCacheNeighbors(input:CanonicalCacheRepairInput):Promise<boolean> {
 return repairCanonicalCacheNeighborsGuarded(input,revision=>guard(input.target,revision,input.lease,input.budget.now()));
}
async function repairCanonicalCacheNeighborsGuarded(input:CanonicalCacheRepairInput,atomicGuard:(revision:number)=>D1PreparedStatement,
 subject?:CacheRepairSubject):Promise<boolean> {
 const db=input.target,limit=Math.max(1,Math.min(16,input.maxRepairs??16)),values=subject?scopeValues(subject):[];
 const logicals=(await db.prepare(subject?.throughDay?`SELECT * FROM analytics_canonical_cache_logical_work
  INDEXED BY analytics_canonical_cache_logical_subject WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=?
  ORDER BY day,logical_key LIMIT ?`:subject?`SELECT * FROM analytics_canonical_cache_logical_work
  INDEXED BY analytics_canonical_cache_logical_page WHERE source_id=? AND owner_digest=? AND selection_method=?
  ORDER BY logical_key LIMIT ?`:'SELECT * FROM analytics_canonical_cache_logical_work ORDER BY logical_key LIMIT ?')
  .bind(...values,...(subject?.throughDay?[subject.throughDay]:[]),limit).all<WorkRow>()).results;
 for(const work of logicals) {
  if(!enough(input.budget)||!await (input.canCommit??input.stillCurrent)())return false;
  const revision=await clock(db);if(revision===null)throw fail();
  const missing=await db.prepare(`SELECT 1 missing FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision
   LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision
   WHERE f.selection_method=? AND f.erasure_key=? AND f.observed_day=? AND f.native_logical_occurrence_key=? AND s.slot_key IS NULL LIMIT 1`)
   .bind(work.selection_method,work.logical_key!.split('/')[1]!,work.day,work.logical_key!.split('/')[3]!).first<number>('missing');
  if(missing)continue;
  const winner=await db.prepare(`SELECT s.* FROM analytics_canonical_cache_slots s JOIN analytics_canonical_heads h ON h.revision=s.fact_revision
   WHERE s.logical_key=? ORDER BY s.observed_ms,s.native_order,s.slot_key LIMIT 1`).bind(work.logical_key!).first<SlotRow>();
  const held=await db.prepare('SELECT * FROM analytics_canonical_cache_nodes WHERE node_key=?').bind(work.logical_key!).first<NodeRow>();
  const writes:D1PreparedStatement[]=[atomicGuard(revision),db.prepare(`DELETE FROM analytics_canonical_cache_slots WHERE logical_key=?
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_heads h WHERE h.revision=analytics_canonical_cache_slots.fact_revision)`).bind(work.logical_key!)];
  if(held?.fact_revision!==winner?.fact_revision) {
   if(held)writes.push(db.prepare('DELETE FROM analytics_canonical_cache_nodes WHERE node_key=?').bind(work.logical_key!));
   if(winner) {
    const item=decode(winner.payload);
    writes.push(db.prepare(`INSERT INTO analytics_canonical_cache_nodes(node_key,fact_revision,source_id,owner_digest,selection_method,
     day,session_digest,observed_ms,order_key,payload,unreadable) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
     .bind(work.logical_key!,winner.fact_revision,winner.source_id,winner.owner_digest,winner.selection_method,winner.day,
      item?.sessionDigest??null,winner.observed_ms,item?.orderKey??'',winner.payload,item&&'unreadable'in item?1:0));
   }
  }
  // Deleting stale slots above can increment this logical work generation.
  // The clock guard proves no other mutation intervened, so this key is now
  // fully repaired and its new internal generation can be acknowledged too.
  writes.push(db.prepare('DELETE FROM analytics_canonical_cache_logical_work WHERE logical_key=?').bind(work.logical_key!));
  await db.batch(writes);if(input.metrics)input.metrics.logicalRepairs++;
 }
 // A pending logical selection can change any following node. Pair work is
 // cheap and may proceed; readers remain fenced until both queues are clear.
 const pairs=(await db.prepare(subject?.throughDay?`SELECT * FROM analytics_canonical_cache_pair_work
  INDEXED BY analytics_canonical_cache_pair_work_subject WHERE source_id=? AND owner_digest=? AND selection_method=? AND day<=?
  ORDER BY day,node_key LIMIT ?`:subject?`SELECT * FROM analytics_canonical_cache_pair_work
  INDEXED BY analytics_canonical_cache_pair_page WHERE source_id=? AND owner_digest=? AND selection_method=?
  ORDER BY node_key LIMIT ?`:'SELECT * FROM analytics_canonical_cache_pair_work ORDER BY node_key LIMIT ?')
  .bind(...values,...(subject?.throughDay?[subject.throughDay]:[]),limit).all<WorkRow>()).results;
 for(const work of pairs) {
  if(!enough(input.budget)||!await (input.canCommit??input.stillCurrent)())return false;
  const revision=await clock(db);if(revision===null)throw fail();
  const later=await db.prepare('SELECT * FROM analytics_canonical_cache_nodes WHERE node_key=?').bind(work.node_key!).first<NodeRow>();
  const prior=later?.session_digest?await db.prepare(`SELECT * FROM analytics_canonical_cache_nodes WHERE source_id=? AND owner_digest=? AND selection_method=? AND session_digest=?
   AND (observed_ms,order_key,node_key)<(?,?,?) ORDER BY observed_ms DESC,order_key DESC,node_key DESC LIMIT 1`)
   .bind(later.source_id,later.owner_digest,later.selection_method,later.session_digest,later.observed_ms,later.order_key,later.node_key).first<NodeRow>():null;
  const value=later&&prior?canonicalCachePair(decode(prior.payload),decode(later.payload)):null;
  if(input.metrics&&later&&prior)input.metrics.pairEvaluations++;
  const pairRevision=value?await sha256Hex(canonicalJson([CANONICAL_CACHE_PAIR_METHOD,prior!.fact_revision,later!.fact_revision,value])):null;
  const held=await db.prepare('SELECT pair_revision FROM analytics_canonical_cache_pairs WHERE later_key=?').bind(work.node_key!).first<string>('pair_revision');
  const writes:D1PreparedStatement[]=[atomicGuard(revision)];
  if(held!==pairRevision) {
   writes.push(db.prepare('DELETE FROM analytics_canonical_cache_pairs WHERE later_key=?').bind(work.node_key!));
   if(value&&later&&prior) {
    const c=value.counters;
    writes.push(db.prepare(`INSERT INTO analytics_canonical_cache_pairs(later_key,prior_key,pair_revision,method,source_id,owner_digest,
     selection_method,day,model,effort,band,session_digest,adjacencies,reused,matched,ties,insufficient,contracted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
     .bind(later.node_key,prior.node_key,pairRevision,CACHE_RETENTION_METHOD.version,later.source_id,later.owner_digest,later.selection_method,
      later.day,value.model,value.effort,c.band,value.sessionDigest,c.adjacencies,c.reusedMoreThanHalf,c.matchedOrExceeded,c.unorderedTies,
      c.excludedInsufficientEvidence,c.excludedContextContracted));
   }
  }
  writes.push(db.prepare('DELETE FROM analytics_canonical_cache_pair_work WHERE node_key=? AND generation=?').bind(work.node_key!,work.generation));
  await db.batch(writes);if(input.metrics)input.metrics.pairRepairs++;
 }
 return (await db.prepare(subject?pendingSql(subject):
  'SELECT 1 pending FROM analytics_canonical_cache_logical_work UNION ALL SELECT 1 FROM analytics_canonical_cache_pair_work LIMIT 1')
  .bind(...(subject?subjectPendingValues(subject):[])).first<number>('pending'))===null;
}
const counters=(row:CounterRow):CacheRetentionBandCounters=>({band:row.band,adjacencies:row.adjacencies,reusedMoreThanHalf:row.reused,
 matchedOrExceeded:row.matched,unorderedTies:row.ties,excludedInsufficientEvidence:row.insufficient,excludedContextContracted:row.contracted,sessions:row.sessions});
const empty=(band:CacheRetentionBandId):CacheRetentionBandCounters=>({band,adjacencies:0,reusedMoreThanHalf:0,matchedOrExceeded:0,unorderedTies:0,
 excludedInsufficientEvidence:0,excludedContextContracted:0,sessions:0});
/** Closed source authority is still mandatory, including authoritative empty
 * days. Canonical coverage and repair queues additionally prevent a partial
 * set of prepared partitions from masquerading as a complete native day. */
async function scopeReady(db:D1Database,scope:CanonicalCacheScope,from:string,to:string):Promise<boolean> {
 const values=scopeValues(scope);
 const active=await db.prepare(`SELECT 1 ready FROM analytics_owner_state o WHERE source_id=? AND owner_digest=? AND state='active'
  AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=o.source_id AND e.owner_digest=o.owner_digest)`)
  .bind(scope.sourceId,scope.ownerDigest).first<number>('ready');if(!active)return false;
 const pending=await db.prepare(`SELECT 1 pending FROM analytics_canonical_cache_logical_work WHERE source_id=? AND owner_digest=? AND selection_method=? AND day>=? AND day<=?
  UNION ALL SELECT 1 FROM analytics_canonical_cache_pair_work WHERE source_id=? AND owner_digest=? AND selection_method=? AND day>=? AND day<=? LIMIT 1`)
  .bind(...values,from,to,...values,from,to).first<number>('pending');if(pending)return false;
 const missing=await db.prepare(`SELECT 1 missing FROM analytics_canonical_heads h JOIN analytics_canonical_facts f ON f.revision=h.revision
  LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision WHERE f.source_id=? AND f.owner_digest=? AND f.selection_method=?
  AND f.stream='usage' AND (f.observed_day>=? AND f.observed_day<=? OR f.observed_day IS NULL
   AND EXISTS(SELECT 1 FROM analytics_canonical_days d WHERE d.revision=f.revision AND d.day>=? AND d.day<=?)) AND s.slot_key IS NULL LIMIT 1`)
  .bind(...values,from,to,from,to).first<number>('missing');if(missing)return false;
 const stale=await db.prepare(`SELECT 1 stale FROM analytics_canonical_cache_slots s LEFT JOIN analytics_canonical_heads h ON h.revision=s.fact_revision
  WHERE s.source_id=? AND s.owner_digest=? AND s.selection_method=? AND s.day>=? AND s.day<=? AND h.revision IS NULL LIMIT 1`)
  .bind(...values,from,to).first<number>('stale');return !stale;
}
/** Exact native session-map peak for unusually dense days. The usual case is
 * proved by eventsRead <= the native session cap and avoids this ordered scan.
 * Only sessions occurring in the own day participate in the native carry. */
async function nativeSessionPeak(db:D1Database,scope:CanonicalCacheScope,day:string):Promise<number> {
 const start=Date.parse(day+'T00:00:00.000Z');
 const peak=await db.prepare(`WITH own AS(SELECT * FROM analytics_canonical_cache_nodes WHERE source_id=? AND owner_digest=? AND selection_method=? AND day=? AND session_digest IS NOT NULL),
 prior_rank AS(SELECT p.*,row_number() OVER(PARTITION BY p.session_digest ORDER BY p.observed_ms DESC,p.order_key DESC,p.node_key DESC) rank
  FROM analytics_canonical_cache_nodes p WHERE p.source_id=? AND p.owner_digest=? AND p.selection_method=? AND p.observed_ms>=? AND p.observed_ms<?
  AND p.session_digest IN(SELECT session_digest FROM own)),
 all_nodes AS(SELECT session_digest,observed_ms,order_key,node_key,unreadable,1 own FROM own UNION ALL
  SELECT session_digest,observed_ms,order_key,node_key,unreadable,0 FROM prior_rank WHERE rank=1),
 transitions AS(SELECT *,lag(unreadable,1,1) OVER(PARTITION BY session_digest ORDER BY observed_ms,order_key,node_key) previous FROM all_nodes),
 totals AS(SELECT sum(CASE WHEN unreadable=0 AND previous=1 THEN 1 WHEN unreadable=1 AND previous=0 THEN -1 ELSE 0 END)
  OVER(ORDER BY observed_ms,order_key,node_key) active FROM transitions)
 SELECT COALESCE(max(active),0) peak FROM totals`).bind(...scopeValues(scope),day,...scopeValues(scope),start-CACHE_RETENTION_METHOD.maximumGapMs,start).first<number>('peak');
 if(peak===null)throw fail();return peak;
}
async function checkSessionLimit(db:D1Database,scope:CanonicalCacheScope,day:string,eventsRead:number):Promise<void> {
 if(eventsRead<=CACHE_RETENTION_SESSION_LIMIT)return;
 const saved=await db.prepare(`SELECT p.peak FROM analytics_canonical_cache_session_proofs p JOIN analytics_canonical_cache_days d
  USING(source_id,owner_digest,selection_method,day) WHERE p.source_id=? AND p.owner_digest=? AND p.selection_method=? AND p.day=? AND p.day_revision=d.revision`)
  .bind(...scopeValues(scope),day).first<number>('peak');
 const peak=saved??await nativeSessionPeak(db,scope,day);
 if(peak>CACHE_RETENTION_SESSION_LIMIT)throw new CacheRetentionRefusedError('session_limit_exceeded');
}
export async function readCanonicalCacheDay(input:{target:D1Database;scope:CanonicalCacheScope;day:string;stillCurrent:()=>Promise<boolean>}):Promise<CacheRetentionDayAggregate|null> {
 if(!validCacheRetentionDayLabel(input.day))throw fail();const db=input.target,values=scopeValues(input.scope);
 if(!await canonicalCacheAvailable(db)||!await input.stillCurrent())return null;
 const revision=await clock(db),from=new Date(Date.parse(input.day+'T00:00:00Z')-CACHE_RETENTION_METHOD.maximumGapMs).toISOString().slice(0,10);
 if(!await scopeReady(db,input.scope,input.day,input.day))return null;
 const hasItems=await db.prepare('SELECT 1 found FROM analytics_canonical_cache_nodes WHERE source_id=? AND owner_digest=? AND selection_method=? AND day=? AND session_digest IS NOT NULL LIMIT 1')
  .bind(...values,input.day).first<number>('found');
 // Native readers avoid all carry reads when the own day maps to no items.
 if(hasItems&&!await scopeReady(db,input.scope,from,input.day))return null;
 const day=await db.prepare(`SELECT events_read,unreadable_events FROM analytics_canonical_cache_days WHERE source_id=? AND owner_digest=? AND selection_method=? AND day=?`)
  .bind(...values,input.day).first<{events_read:number;unreadable_events:number}>();
 const rows=(await db.prepare(`SELECT c.*,(SELECT count(*) FROM analytics_canonical_cache_sessions s WHERE s.source_id=c.source_id AND s.owner_digest=c.owner_digest
  AND s.selection_method=c.selection_method AND s.day=c.day AND s.model=c.model AND s.effort=c.effort AND s.band=c.band) sessions
  FROM analytics_canonical_cache_counters c WHERE source_id=? AND owner_digest=? AND selection_method=? AND day=? ORDER BY model,effort,band LIMIT ?`)
  .bind(...values,input.day,CACHE_RETENTION_GROUP_LIMIT*CACHE_RETENTION_BAND_IDS.length+1).all<CounterRow>()).results;
 const groups=new Map<string,{model:string;effort:string;bands:CacheRetentionBandCounters[]}>();
 for(const row of rows) {const key=cacheRetentionGroupOrder(row);let group=groups.get(key);
  if(!group){group={model:row.model,effort:row.effort,bands:CACHE_RETENTION_BAND_IDS.map(empty)};groups.set(key,group);}
  group.bands[CACHE_RETENTION_BAND_IDS.indexOf(row.band)]=counters(row);
 }
 if(groups.size>CACHE_RETENTION_GROUP_LIMIT)throw new CacheRetentionRefusedError('group_limit_exceeded');
 const sessionCounts=(await db.prepare(`SELECT model,effort,count(DISTINCT session_digest) sessions FROM analytics_canonical_cache_sessions
  WHERE source_id=? AND owner_digest=? AND selection_method=? AND day=? GROUP BY model,effort`).bind(...values,input.day)
  .all<{model:string;effort:string;sessions:number}>()).results;
 await checkSessionLimit(db,input.scope,input.day,day?.events_read??0);
 const aggregate:CacheRetentionDayAggregate={methodVersion:CACHE_RETENTION_METHOD.version,day:input.day,eventsRead:day?.events_read??0,
  unreadableEvents:day?.unreadable_events??0,groups:[...groups.entries()].sort(([a],[b])=>a<b?-1:1).map(([key,group]):CacheRetentionGroup=>({...group,
   adjacencies:group.bands.reduce((sum,row)=>sum+row.adjacencies,0),sessions:sessionCounts.find(row=>cacheRetentionGroupOrder(row)===key)?.sessions??0}))};
 if(!validCacheRetentionDayAggregate(aggregate))throw fail();
 return await clock(db)===revision&&await input.stillCurrent()?aggregate:null;
}
/** Rebase calendar membership from prepared day counters once per UTC day.
 * Subsequent pair insert/delete triggers keep all four windows exact. */
export async function prepareCanonicalCacheWindows(db:D1Database,scope:CanonicalCacheScope,anchorDay:string):Promise<void> {
 if(!validCacheRetentionDayLabel(anchorDay))throw fail();const values=scopeValues(scope);
 const head=await db.prepare('SELECT anchor_day FROM analytics_canonical_cache_window_heads WHERE source_id=? AND owner_digest=? AND selection_method=?')
  .bind(...values).first<string>('anchor_day');if(head===anchorDay)return;
 const revision=await clock(db);if(revision===null)throw fail();
 await db.batch([guard(db,revision),
  db.prepare('DELETE FROM analytics_canonical_cache_window_heads WHERE source_id=? AND owner_digest=? AND selection_method=?').bind(...values),
  db.prepare(`INSERT INTO analytics_canonical_cache_window_heads(source_id,owner_digest,selection_method,anchor_day)
   SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM analytics_owner_state WHERE source_id=? AND owner_digest=? AND state='active')
   AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences WHERE source_id=? AND owner_digest=?)`)
   .bind(...values,anchorDay,scope.sourceId,scope.ownerDigest,scope.sourceId,scope.ownerDigest),
  db.prepare(`INSERT INTO analytics_canonical_cache_windows(source_id,owner_digest,selection_method,window,model,effort,band,
   adjacencies,reused,matched,ties,insufficient,contracted,sessions)
   SELECT c.source_id,c.owner_digest,c.selection_method,w.value,c.model,c.effort,c.band,
    sum(c.adjacencies),sum(c.reused),sum(c.matched),sum(c.ties),sum(c.insufficient),sum(c.contracted),
    sum((SELECT count(*) FROM analytics_canonical_cache_sessions s WHERE s.source_id=c.source_id AND s.owner_digest=c.owner_digest
     AND s.selection_method=c.selection_method AND s.day=c.day AND s.model=c.model AND s.effort=c.effort AND s.band=c.band))
   FROM analytics_canonical_cache_counters c JOIN analytics_canonical_cache_window_heads h
    ON h.source_id=c.source_id AND h.owner_digest=c.owner_digest AND h.selection_method=c.selection_method,
    json_each('["day","week","month","all"]') w
   WHERE c.source_id=? AND c.owner_digest=? AND c.selection_method=? AND (w.value='all'
    OR c.day>=date(h.anchor_day,CASE w.value WHEN 'day' THEN '+0 days' WHEN 'week' THEN '-6 days' ELSE '-29 days' END))
   GROUP BY c.source_id,c.owner_digest,c.selection_method,w.value,c.model,c.effort,c.band`).bind(...values)]);
}
export interface CanonicalCacheSeriesInput {
 readonly target:D1Database;readonly scopes:readonly CanonicalCacheScope[];readonly nowMs:number;
 readonly stillCurrent:()=>Promise<boolean>;readonly budget?:CanonicalCacheBudget;
}
export type CanonicalCacheSeriesResult=
 | {state:'complete';value:PublicCacheRetentionSeries|null;cacheRevision:number;membershipDigest:string;anchorDay:string}
 | {state:'deferred'|'refused';reason:string};
const memberMatch=(alias:string)=>`(${alias}.source_id,${alias}.owner_digest,${alias}.selection_method) IN
 (SELECT json_extract(m.value,'$[0]'),json_extract(m.value,'$[1]'),json_extract(m.value,'$[2]') FROM json_each(?) m)`;
/** Tagged, bounded public preparation. Null only means a closed no-evidence
 * population; pending window/session-proof pages cannot be mistaken for empty.
 * Durable heads and day-version proofs let the next invocation skip completed
 * preparation. Warm scope coverage and windows are read in set queries. */
export async function readCanonicalCacheSeriesResult(input:CanonicalCacheSeriesInput):Promise<CanonicalCacheSeriesResult> {
 const deferred=(reason:string):CanonicalCacheSeriesResult=>({state:'deferred',reason});
 const refused=(reason:string):CanonicalCacheSeriesResult=>({state:'refused',reason});
 const available=(reserve=48)=>!input.budget||enough(input.budget,reserve);
 if(!Number.isSafeInteger(input.nowMs)||input.scopes.length>1024)throw fail();
 const values=input.scopes.map(scope=>scopeValues(scope));
 const unique=new Set(values.map(value=>JSON.stringify(value))),subjects=new Set(values.map(value=>JSON.stringify(value.slice(0,2))));
 if(unique.size!==values.length||subjects.size!==values.length)throw fail();
 const members=JSON.stringify(values),anchorDay=new Date(input.nowMs).toISOString().slice(0,10),db=input.target;
 if(!available())return deferred('query_budget');
 if(!await canonicalCacheAvailable(db))return refused('migration_required');
 if(!await input.stillCurrent())return deferred('source_changed');
 try {
  const missing=(await db.prepare(`SELECT json_extract(m.value,'$[0]') source_id,json_extract(m.value,'$[1]') owner_digest,
   json_extract(m.value,'$[2]') selection_method FROM json_each(?) m LEFT JOIN analytics_canonical_cache_window_heads h
   ON h.source_id=json_extract(m.value,'$[0]') AND h.owner_digest=json_extract(m.value,'$[1]') AND h.selection_method=json_extract(m.value,'$[2]')
   WHERE h.anchor_day IS NULL OR h.anchor_day!=? LIMIT 5`).bind(members,anchorDay)
   .all<{source_id:string;owner_digest:string;selection_method:CanonicalScope['selectionMethod']}>()).results;
  for(const scope of missing.slice(0,4)) {
   if(!available())return deferred('query_budget');
   await prepareCanonicalCacheWindows(db,{sourceId:scope.source_id,ownerDigest:scope.owner_digest,selectionMethod:scope.selection_method},anchorDay);
  }
  if(missing.length>4)return deferred('window_preparation_pending');
  // Native session-map limits need an ordered proof only for unusually dense
  // days. Each immutable day revision is checked once, at most four per call.
  const dense=(await db.prepare(`SELECT d.source_id,d.owner_digest,d.selection_method,d.day,d.revision FROM analytics_canonical_cache_days d
   LEFT JOIN analytics_canonical_cache_session_proofs p USING(source_id,owner_digest,selection_method,day)
   WHERE ${memberMatch('d')} AND d.events_read>? AND (p.day_revision IS NULL OR p.day_revision!=d.revision) LIMIT 5`)
   .bind(members,CACHE_RETENTION_SESSION_LIMIT).all<{source_id:string;owner_digest:string;selection_method:CanonicalScope['selectionMethod'];day:string;revision:number}>()).results;
  for(const day of dense.slice(0,4)) {
   if(!available())return deferred('query_budget');
   const revision=await clock(db);if(revision===null)throw fail();
   const scope={sourceId:day.source_id,ownerDigest:day.owner_digest,selectionMethod:day.selection_method};
   const peak=await nativeSessionPeak(db,scope,day.day);
   await db.batch([guard(db,revision),db.prepare(`INSERT INTO analytics_canonical_cache_session_proofs(source_id,owner_digest,selection_method,day,day_revision,peak)
    SELECT source_id,owner_digest,selection_method,day,revision,? FROM analytics_canonical_cache_days
    WHERE source_id=? AND owner_digest=? AND selection_method=? AND day=? AND revision=?
    ON CONFLICT(source_id,owner_digest,selection_method,day) DO UPDATE SET day_revision=excluded.day_revision,peak=excluded.peak`)
    .bind(peak,...scopeValues(scope),day.day,day.revision)]);
  }
  if(dense.length>4)return deferred('session_proofs_pending');
 } catch(error) {if(String(error).includes('canonical_cache_changed'))return deferred('canonical_changed');throw error;}
 if(!available())return deferred('query_budget');
 const cacheRevision=await clock(db);if(cacheRevision===null)throw fail();
 const ready=await db.prepare(`SELECT count(*) ready FROM json_each(?) m JOIN analytics_owner_state o
  ON o.source_id=json_extract(m.value,'$[0]') AND o.owner_digest=json_extract(m.value,'$[1]') AND o.state='active'
  JOIN analytics_canonical_cache_window_heads h ON h.source_id=o.source_id AND h.owner_digest=o.owner_digest
  AND h.selection_method=json_extract(m.value,'$[2]') AND h.anchor_day=?
  WHERE NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=o.source_id AND e.owner_digest=o.owner_digest)`)
  .bind(members,anchorDay).first<number>('ready');
 if(ready!==values.length)return deferred('scope_unavailable');
 const pending=await db.prepare(`SELECT 1 pending FROM analytics_canonical_cache_logical_work w WHERE ${memberMatch('w')}
  UNION ALL SELECT 1 FROM analytics_canonical_cache_pair_work w WHERE ${memberMatch('w')} LIMIT 1`).bind(members,members).first<number>('pending');
 if(pending)return deferred('cache_repairs_pending');
 const missing=await db.prepare(`SELECT 1 missing FROM analytics_canonical_heads h JOIN analytics_canonical_facts f ON f.revision=h.revision
  LEFT JOIN analytics_canonical_cache_slots s ON s.fact_revision=f.revision WHERE f.stream='usage' AND ${memberMatch('f')} AND s.slot_key IS NULL LIMIT 1`)
  .bind(members).first<number>('missing');if(missing)return deferred('canonical_coverage_pending');
 const stale=await db.prepare(`SELECT 1 stale FROM analytics_canonical_cache_slots s LEFT JOIN analytics_canonical_heads h ON h.revision=s.fact_revision
  WHERE ${memberMatch('s')} AND h.revision IS NULL LIMIT 1`).bind(members).first<number>('stale');if(stale)return deferred('canonical_coverage_pending');
 const limits=await db.prepare(`SELECT d.group_count,p.peak FROM analytics_canonical_cache_days d LEFT JOIN analytics_canonical_cache_session_proofs p
  USING(source_id,owner_digest,selection_method,day) WHERE ${memberMatch('d')} AND (d.group_count>?
   OR d.events_read>? AND p.day_revision=d.revision AND p.peak>?) LIMIT 1`)
  .bind(members,CACHE_RETENTION_GROUP_LIMIT,CACHE_RETENTION_SESSION_LIMIT,CACHE_RETENTION_SESSION_LIMIT).first<{group_count:number;peak:number|null}>();
 if(limits)return refused(limits.group_count>CACHE_RETENTION_GROUP_LIMIT?'group_limit_exceeded':'session_limit_exceeded');
 const unproved=await db.prepare(`SELECT 1 pending FROM analytics_canonical_cache_days d LEFT JOIN analytics_canonical_cache_session_proofs p
  USING(source_id,owner_digest,selection_method,day) WHERE ${memberMatch('d')} AND d.events_read>?
  AND (p.day_revision IS NULL OR p.day_revision!=d.revision) LIMIT 1`).bind(members,CACHE_RETENTION_SESSION_LIMIT).first<number>('pending');
 if(unproved)return deferred('session_proofs_pending');
 const windows=[];let anyEvidence=false;
 for(const span of CACHE_RETENTION_WINDOWS) {
  if(!available(24))return deferred('query_budget');
  const pooled=(await db.prepare(`SELECT owner_digest,band,sum(adjacencies) adjacencies,sum(reused) reused,sum(matched) matched,sum(ties) ties,
   sum(insufficient) insufficient,sum(contracted) contracted,sum(sessions) sessions FROM analytics_canonical_cache_windows c
   WHERE window=? AND ${memberMatch('c')} GROUP BY owner_digest,band`).bind(span.id,members).all<CounterRow&{owner_digest:string}>()).results;
  if(pooled.length)anyEvidence=true;
  // Nine ranked models preserve the native top-eight truncation flag while
  // keeping Worker payload memory independent of historical catalogue size.
  const modelRows=(await db.prepare(`WITH models AS(SELECT model,sum(adjacencies) total FROM analytics_canonical_cache_windows c
   WHERE window=? AND ${memberMatch('c')} GROUP BY model HAVING total>0 ORDER BY total DESC,model LIMIT 9)
   SELECT owner_digest,c.model,band,sum(adjacencies) adjacencies,sum(reused) reused,sum(matched) matched,sum(ties) ties,
   sum(insufficient) insufficient,sum(contracted) contracted,sum(sessions) sessions FROM analytics_canonical_cache_windows c JOIN models USING(model)
   WHERE window=? AND ${memberMatch('c')} GROUP BY owner_digest,c.model,band`)
   .bind(span.id,members,span.id,members).all<CounterRow&{owner_digest:string}>()).results;
  const rows:CacheRetentionBandRow[]=modelRows.map(row=>({...counters(row),ownerDigest:row.owner_digest,model:row.model}));
  windows.push(publicCacheRetentionWindow({window:span.id,days:span.days,
   pooled:mergeCacheRetentionBands(pooled.map(row=>({...counters(row),ownerDigest:row.owner_digest}))),modelRows:rows}));
 }
 if(await clock(db)!==cacheRevision||!await input.stillCurrent())return deferred('source_changed');
 const membershipDigest=await sha256Hex(canonicalJson(['canonical-cache-publication-v1',values.map(value=>JSON.stringify(value)).sort()]));
 const value:PublicCacheRetentionSeries|null=anyEvidence?{schemaVersion:CACHE_RETENTION_PUBLIC_SCHEMA_VERSION,metric:CACHE_RETENTION_METRIC_ID,
  methodVersion:CACHE_RETENTION_METHOD.version,measures:'consecutive_requests',gapBasis:'response_end_to_response_end',windows}:null;
 return {state:'complete',value,cacheRevision,membershipDigest,anchorDay};
}
/** Native nullable facade. Publication uses the tagged API above, because an
 * unfinished result and a closed empty population are distinct outcomes. */
export async function readCanonicalCacheSeries(input:CanonicalCacheSeriesInput):Promise<PublicCacheRetentionSeries|null> {
 const result=await readCanonicalCacheSeriesResult(input);
 if(result.state==='complete')return result.value;
 if(result.state==='refused'&&(result.reason==='group_limit_exceeded'||result.reason==='session_limit_exceeded'))
  throw new CacheRetentionRefusedError(result.reason);
 return null;
}

/** Bounded local retirement of obsolete artifacts. Current facts, repair
 * queues and live work remain authoritative; this never removes source data. */
/** Check generation before the source and live-work joins. On a current warm
 * partition those joins must not scan retained facts or unrelated ready work. */
export const CANONICAL_CACHE_SUPERSEDED_DELETE_SQL=`DELETE FROM analytics_canonical_cache_partitions WHERE partition_key IN(
 SELECT c.partition_key FROM analytics_canonical_cache_partitions c JOIN analytics_canonical_manifests m USING(content_revision)
 LEFT JOIN analytics_canonical_dirty_partitions d ON d.partition_key=m.root_partition_key
 WHERE CASE WHEN m.generation!=COALESCE(d.generation,0) THEN
  EXISTS(SELECT 1 FROM analytics_canonical_manifest_rows r JOIN analytics_canonical_facts f USING(revision)
   WHERE r.content_revision=c.content_revision AND f.source_id=?)
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.partition_key=c.partition_key
   AND w.state='leased' AND w.claim_expires_ms>?)
  ELSE 0 END
 ORDER BY c.partition_key LIMIT ?) RETURNING partition_key`;
export async function retireCanonicalCachePage(db:D1Database,sourceId:string,limit=16,nowMs=Date.now()):Promise<{
 state:'complete'|'unavailable';slotsRetired:number;emptyDaysRetired:number;partitionsRetired:number}> {
 if(!/^[A-Za-z0-9._:-]{1,128}$/u.test(sourceId)||!Number.isSafeInteger(limit)||limit<1||limit>16||!Number.isSafeInteger(nowMs))throw fail();
 if(!await canonicalCacheAvailable(db))return {state:'unavailable',slotsRetired:0,emptyDaysRetired:0,partitionsRetired:0};
 const results=await db.batch([
  db.prepare(`DELETE FROM analytics_canonical_cache_slots WHERE slot_key IN(SELECT s.slot_key FROM analytics_canonical_cache_slots s
   WHERE s.source_id=? AND NOT EXISTS(SELECT 1 FROM analytics_canonical_heads h WHERE h.revision=s.fact_revision)
   AND NOT EXISTS(SELECT 1 FROM analytics_partition_work w WHERE w.source_id=s.source_id AND w.state='leased' AND w.claim_expires_ms>?
    AND (w.owner_digest=s.owner_digest OR substr(w.partition_key,1,length(s.root_partition_key))=s.root_partition_key))
   ORDER BY s.slot_key LIMIT ?) RETURNING slot_key`).bind(sourceId,nowMs,limit),
  db.prepare(`DELETE FROM analytics_canonical_cache_days WHERE (source_id,owner_digest,selection_method,day) IN(
   SELECT d.source_id,d.owner_digest,d.selection_method,d.day FROM analytics_canonical_cache_days d WHERE d.source_id=?
   AND d.events_read=0 AND d.unreadable_events=0 AND d.group_count=0
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_logical_work w WHERE w.source_id=d.source_id AND w.owner_digest=d.owner_digest AND w.selection_method=d.selection_method AND w.day=d.day)
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_cache_pair_work w WHERE w.source_id=d.source_id AND w.owner_digest=d.owner_digest AND w.selection_method=d.selection_method AND w.day=d.day)
   ORDER BY d.owner_digest,d.selection_method,d.day LIMIT ?) RETURNING day`).bind(sourceId,limit),
  db.prepare(CANONICAL_CACHE_SUPERSEDED_DELETE_SQL).bind(sourceId,nowMs,limit)]);
 return {state:'complete',slotsRetired:results[0]!.results.length,emptyDaysRetired:results[1]!.results.length,partitionsRetired:results[2]!.results.length};
}
