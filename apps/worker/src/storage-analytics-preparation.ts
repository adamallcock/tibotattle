import { captureStorageCommunityAuthority, readStorageCommunityOwner,
  readStorageCommunityOwnerPage, type StorageCommunityOwner } from './storage-community-authority';
import { EFFECTIVE_DAY_CATALOG_TABLES, EFFECTIVE_DAY_CATALOG_TRIGGERS,
  effectiveDayCatalogAvailable } from './storage-effective-dependency-days';
import { advanceSharedAnalyticsFeatureDay, type SharedAnalyticsFeatureBudget } from './storage-analytics-shared-features';

/** This lane maintains exact day features. Its positions are scheduling hints,
 * never coverage evidence; consumers retain their source proof and fallback. */
export interface StorageAnalyticsPreparationInput {
 source:D1Database;target:D1Database;sourceId:string;sourceNamespace:string;
 budget:SharedAnalyticsFeatureBudget;sharedFeatures?:boolean;maxAttempts?:number;
 /** Fixed calendar horizon for deterministic local qualification. */
 throughDay?:string;
}
export interface StorageAnalyticsPreparationResult {
 state:'idle'|'progress'|'deferred'|'refused';reason:string;
 attempts:number;prepared:number;reused:number;refused:number;deferred:number;
 resumeAttempts:number;recentAttempts:number;dirtyAttempts:number;historyAttempts:number;
}
type Lane='resume'|'recent'|'dirty'|'history';
type Owner=StorageCommunityOwner&{ownerDigest:string};
interface Cursor {
 turn:number;revision:number;after_recent_owner:string;after_dirty_owner:string;
 after_history_owner:string;after_resume_rowid:number;
}
interface Range {
 history_from_day:string;history_through_day:string;history_next_day:string;
 recent_next_day:string;dirty_after_day:string;revision:number;
}
const DAY_MS=86_400_000, LANES:readonly Lane[]=['resume','recent','dirty','history'];
const fail=()=>new Error('STORAGE_ANALYTICS_PREPARATION_UNAVAILABLE');
function validDay(day:string):boolean {
 const epoch=Date.parse(`${day}T00:00:00.000Z`);
 return /^\d{4}-\d{2}-\d{2}$/u.test(day)&&Number.isFinite(epoch)
  &&new Date(epoch).toISOString().slice(0,10)===day;
}
function shift(day:string,n:number):string {return new Date(Date.parse(`${day}T00:00:00.000Z`)+n*DAY_MS).toISOString().slice(0,10);}
function available(input:StorageAnalyticsPreparationInput,reserve=130):boolean {
 return input.budget.remainingQueries()>=reserve&&input.budget.now()<input.budget.deadlineMs-2_000;
}
async function supported(input:StorageAnalyticsPreparationInput):Promise<boolean> {
 const names=['analytics_shared_preparation_cursor','analytics_shared_preparation_ranges',
  'analytics_shared_feature_days','analytics_shared_feature_parts'];
 const target=await input.target.prepare(`SELECT count(*) n FROM sqlite_schema
  WHERE type='table' AND name IN(?,?,?,?)`).bind(...names).first<number>('n');
 if(target!==4)return false;
 const contract=await input.target.prepare(`SELECT count(*) n FROM sqlite_schema WHERE
  (type='trigger' AND name IN('analytics_shared_preparation_range_insert','analytics_shared_preparation_range_update',
   'analytics_shared_preparation_owner_terminal','analytics_shared_preparation_erasure'))
  OR (type='index' AND name='analytics_shared_preparation_pending')`).first<number>('n');
 if(contract!==5)return false;
 const rows=(await input.source.prepare(`SELECT name,type FROM sqlite_schema WHERE
  (type='table' AND name IN(?,?)) OR (type='trigger' AND name IN(${EFFECTIVE_DAY_CATALOG_TRIGGERS.map(()=>'?').join(',')}))`)
  .bind(...EFFECTIVE_DAY_CATALOG_TABLES,...EFFECTIVE_DAY_CATALOG_TRIGGERS).all<{name:string;type:string}>()).results;
 return effectiveDayCatalogAvailable(rows)&&await input.source.prepare(`SELECT 1 ready FROM storage_effective_source_days_runtime
  WHERE id=1 AND method='effective-source-day-presence-v1'`).first<number>('ready')===1;
}
async function nextOwner(input:StorageAnalyticsPreparationInput,afterDigest:string):Promise<Owner|null> {
 const after=afterDigest?await input.source.prepare(`SELECT participant_id FROM storage_v11_owner_links
  WHERE owner_digest=? AND state='active'`).bind(afterDigest).first<string>('participant_id'):null;
 let rows=await readStorageCommunityOwnerPage(input.source,{afterParticipantId:after??'',limit:1,requireLinkedOwner:true});
 if(rows.length===0&&after)rows=await readStorageCommunityOwnerPage(input.source,{limit:1,requireLinkedOwner:true});
 const owner=rows[0];
 return owner?.ownerDigest&&owner.ownerRevision>0&&owner.authorityEpoch>0?owner as Owner:null;
}
async function earliestDay(input:StorageAnalyticsPreparationInput,owner:Owner,throughDay:string):Promise<string|null> {
 // Three indexed seeks, never an all-history payload scan. Coarse presence
 // chooses work only; advanceSharedAnalyticsFeatureDay establishes eligibility.
 const rows=await input.source.batch([1,2,3].map(stream=>input.source.prepare(`SELECT source_day FROM storage_effective_source_days
  WHERE participant_id=? AND stream=? AND source_day<=? ORDER BY source_day LIMIT 1`)
  .bind(owner.participantId,stream,throughDay)));
 const days=rows.flatMap(row=>(row.results as {source_day:string}[]).map(value=>value.source_day));
 if(days.some(day=>!validDay(day)))throw fail();
 return days.sort()[0]??null;
}
async function select(input:StorageAnalyticsPreparationInput,throughDay:string):Promise<
 {state:'selected';owner:Owner;day:string;lane:Lane}|{state:'idle';reason:string}|{state:'deferred';reason:string}> {
 await input.target.prepare(`INSERT INTO analytics_shared_preparation_cursor(source_id) VALUES(?)
  ON CONFLICT(source_id) DO NOTHING`).bind(input.sourceId).run();
 const cursor=await input.target.prepare(`SELECT turn,revision,after_recent_owner,after_dirty_owner,
  after_history_owner,after_resume_rowid FROM analytics_shared_preparation_cursor WHERE source_id=?`)
  .bind(input.sourceId).first<Cursor>();
 if(!cursor||![cursor.turn,cursor.revision,cursor.after_resume_rowid].every(n=>Number.isSafeInteger(n)&&n>=0))throw fail();
 const now=Math.trunc(input.budget.now()),claim=crypto.randomUUID(),leaseUntil=now+30_000;
 const claimed=await input.target.prepare(`UPDATE analytics_shared_preparation_cursor SET claim_token=?,claim_expires_ms=?,updated_ms=?
  WHERE source_id=? AND revision=? AND (claim_token IS NULL OR claim_expires_ms<=?)`)
  .bind(claim,leaseUntil,now,input.sourceId,cursor.revision,now).run();
 if(claimed.meta.changes!==1)return {state:'deferred',reason:'claim_busy'};
 let lane=LANES[cursor.turn%4]!,owner:Owner|null=null,day:string|null=null,range:Range|null=null,next:Range|null=null;
 let afterResume=cursor.after_resume_rowid;
 try {
  if(lane==='resume') {
   const page=async(after:number)=>(await input.target.prepare(`SELECT h.rowid AS position,h.owner_digest,h.day
    FROM analytics_shared_feature_days h JOIN analytics_owner_state o
     ON o.source_id=h.source_id AND o.owner_digest=h.owner_digest AND o.state='active'
    WHERE h.source_id=? AND h.state='building' AND h.rowid>?
     AND (h.claim_token IS NULL OR h.claim_expires_ms<=?)
     AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=h.source_id AND f.owner_digest=h.owner_digest)
    ORDER BY h.rowid LIMIT 1`).bind(input.sourceId,after,now).first<{position:number;owner_digest:string;day:string}>());
   let pending=await page(afterResume);
   if(!pending&&afterResume>0)pending=await page(0);
   afterResume=pending?.position??0;
   if(pending) {
    const found=await readStorageCommunityOwner(input.source,{ownerDigest:pending.owner_digest});
    if(found?.ownerDigest&&validDay(pending.day)&&pending.day<=throughDay){owner=found as Owner;day=pending.day;}
   }
  } else {
   const afterDigest=cursor[`after_${lane}_owner`];
   owner=await nextOwner(input,afterDigest);
   if(owner) {
    const ready=await input.target.prepare(`SELECT 1 ready FROM analytics_owner_state o
     WHERE o.source_id=? AND o.owner_digest=? AND o.state='active' AND o.revision=? AND o.authority_epoch=?
     AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences f WHERE f.source_id=o.source_id AND f.owner_digest=o.owner_digest)`)
     .bind(input.sourceId,owner.ownerDigest,owner.ownerRevision,owner.authorityEpoch).first<number>('ready');
    if(ready===1) {
    range=await input.target.prepare(`SELECT history_from_day,history_through_day,history_next_day,
     recent_next_day,dirty_after_day,revision FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=?`)
     .bind(input.sourceId,owner.ownerDigest).first<Range>();
    const earliest=await earliestDay(input,owner,throughDay);
    if(earliest) {
     const recentFrom=shift(throughDay,-100);
     if(range&&(![range.history_from_day,range.history_through_day,range.history_next_day,range.recent_next_day]
      .every(validDay)||!Number.isSafeInteger(range.revision)||range.revision<1))throw fail();
     next=range?{...range,revision:range.revision+1}:{history_from_day:earliest,
      history_through_day:shift(earliest,100)<throughDay?shift(earliest,100):throughDay,
      history_next_day:earliest,recent_next_day:throughDay,dirty_after_day:'',revision:1};
     if(lane==='dirty') {
      const dirty=async(after:string)=>input.target.prepare(`SELECT day FROM analytics_community_daily_queue
       WHERE source_id=? AND day<=? AND (?='' OR day<?) ORDER BY day DESC LIMIT 1`)
       .bind(input.sourceId,throughDay,after,after).first<string>('day');
      day=await dirty(next.dirty_after_day);
      if(!day&&next.dirty_after_day)day=await dirty('');
      if(day){if(!validDay(day))throw fail();next.dirty_after_day=day;}
     }
     if(lane==='recent'||lane==='dirty'&&!day) {
      day=next.recent_next_day>=recentFrom&&next.recent_next_day<=throughDay?next.recent_next_day:throughDay;
      next.recent_next_day=day===recentFrom?throughDay:shift(day,-1);
     }
     if(lane==='history') {
      if(next.history_from_day<earliest||next.history_from_day>throughDay) {
       next.history_from_day=earliest;next.history_through_day=shift(earliest,100)<throughDay?shift(earliest,100):throughDay;
       next.history_next_day=earliest;
      }
      if(next.history_next_day>next.history_through_day) {
       const from=next.history_through_day>=throughDay?earliest:shift(next.history_through_day,1);
       next.history_from_day=from;next.history_through_day=shift(from,100)<throughDay?shift(from,100):throughDay;
       next.history_next_day=from;
      }
      day=next.history_next_day;next.history_next_day=shift(day,1);
     }
    }
    }
   }
  }
  if(input.budget.now()>=leaseUntil||!available(input,110))return {state:'deferred',reason:'selection_budget'};
  const statements:D1PreparedStatement[]=[];
  if(owner&&next)statements.push(input.target.prepare(`INSERT INTO analytics_shared_preparation_ranges
   (source_id,owner_digest,history_from_day,history_through_day,history_next_day,recent_next_day,dirty_after_day,revision,updated_ms)
   SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM analytics_shared_preparation_cursor
    WHERE source_id=? AND revision=? AND claim_token=? AND claim_expires_ms>?)
   ON CONFLICT(source_id,owner_digest) DO UPDATE SET history_from_day=excluded.history_from_day,
    history_through_day=excluded.history_through_day,history_next_day=excluded.history_next_day,
    recent_next_day=excluded.recent_next_day,dirty_after_day=excluded.dirty_after_day,
    revision=excluded.revision,updated_ms=excluded.updated_ms WHERE analytics_shared_preparation_ranges.revision=?`)
   .bind(input.sourceId,owner.ownerDigest,next.history_from_day,next.history_through_day,next.history_next_day,
    next.recent_next_day,next.dirty_after_day,next.revision,Math.trunc(input.budget.now()),
    input.sourceId,cursor.revision,claim,Math.trunc(input.budget.now()),range?.revision??0));
  const column=lane==='resume'?null:`after_${lane}_owner`;
  statements.push(input.target.prepare(`UPDATE analytics_shared_preparation_cursor SET turn=turn+1,revision=revision+1,
   after_resume_rowid=?,${column?`${column}=?,`:''}claim_token=NULL,claim_expires_ms=NULL
   WHERE source_id=? AND revision=? AND claim_token=? AND claim_expires_ms>?
   ${owner&&next?'AND EXISTS(SELECT 1 FROM analytics_shared_preparation_ranges WHERE source_id=? AND owner_digest=? AND revision=?)':''}`)
   .bind(afterResume,...(column?[owner?.ownerDigest??'']:[]),input.sourceId,cursor.revision,claim,
    Math.trunc(input.budget.now()),...(owner&&next?[input.sourceId,owner.ownerDigest,next.revision]:[])));
  const saved=await input.target.batch(statements);
  if(saved.some(row=>row.meta.changes!==1))return {state:'deferred',reason:'cursor_changed'};
  return owner&&day?{state:'selected',owner,day,lane}:{state:'idle',reason:'no_candidate'};
 } finally {
  // A failed/expired selector cannot clear a replacement claimant. Killed
  // invocations recover through expiry; no durable day completion is asserted.
  if(input.budget.remainingQueries()>0)await input.target.prepare(`UPDATE analytics_shared_preparation_cursor
   SET claim_token=NULL,claim_expires_ms=NULL WHERE source_id=? AND revision=? AND claim_token=?`)
   .bind(input.sourceId,cursor.revision,claim).run();
 }
}
export async function advanceStorageAnalyticsPreparation(input:StorageAnalyticsPreparationInput):Promise<StorageAnalyticsPreparationResult> {
 const result:StorageAnalyticsPreparationResult={state:'idle',reason:'complete',attempts:0,prepared:0,reused:0,
  refused:0,deferred:0,resumeAttempts:0,recentAttempts:0,dirtyAttempts:0,historyAttempts:0};
 if(input.sharedFeatures!==true)return {...result,reason:'disabled'};
 const throughDay=input.throughDay??new Date(input.budget.now()).toISOString().slice(0,10),maxAttempts=input.maxAttempts??4;
 if(input.source===input.target||!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.sourceId)
  ||typeof input.sourceNamespace!=='string'||input.sourceNamespace.length<1||input.sourceNamespace.length>256
  ||!validDay(throughDay)||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>4)throw fail();
 if(!available(input))return {...result,state:'deferred',reason:'query_budget_or_deadline'};
 if(!await supported(input))return {...result,state:'refused',reason:'migration_required'};
 await captureStorageCommunityAuthority(input.source,input);
 const target=await input.target.prepare(`SELECT 1 ready FROM analytics_runtime_sources WHERE source_id=?
  AND source_namespace=? AND contract_version=1`).bind(input.sourceId,input.sourceNamespace).first<number>('ready');
 if(target!==1)return {...result,state:'deferred',reason:'source_changed'};
 for(let attempt=0;attempt<maxAttempts;attempt++) {
  if(!available(input)){result.state='deferred';result.reason='query_budget_or_deadline';break;}
  const selected=await select(input,throughDay);
  if(selected.state==='deferred'){result.state='deferred';result.reason=selected.reason;break;}
  if(selected.state==='idle')continue;
  result.attempts++;result[`${selected.lane}Attempts`]++;
  const feature=await advanceSharedAnalyticsFeatureDay({...input,owner:selected.owner,day:selected.day});
  if(feature.state==='complete'){feature.reused?result.reused++:result.prepared++;result.state='progress';}
  else if(feature.state==='refused'){result.refused++;result.reason=feature.reason;}
  else {result.deferred++;result.reason=feature.reason;}
 }
 if(result.attempts&&result.prepared+result.reused===0)result.state=result.refused?'refused':'deferred';
 return result;
}
