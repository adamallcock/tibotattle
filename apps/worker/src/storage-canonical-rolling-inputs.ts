import {MODEL_COMPOSITION_POLICY} from '@app-usagemonitor/quota-analysis';
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {canonicalDay,canonicalDigest,type CanonicalFact,type CanonicalSelectionMethod} from './canonical-analytics-facts';
import {readCanonicalFacts} from './storage-canonical-analytics-facts';
import type {CanonicalInputSeal} from './storage-canonical-analytics-input';
import {CANONICAL_FIT_PRICE_METHOD,canonicalPriceMethodDigest,validCanonicalPriceProduct,type CanonicalPriceProduct} from './canonical-feature-contributions';
import {CANONICAL_ROLLING_INPUT_METHOD,CanonicalRollingRefused,validateCanonicalRollingFact} from './canonical-rolling-inputs';
import type {V1PreparedFinishEvidence,WindowedUsageRow} from './quota-analysis-v1';
import type {V1QuotaPageReader,V1PlanSourceRow,V1FitSourceRow} from './quota-analysis-v1-reader';
import {V1_PREPARED_READER_POLICY} from './prepared-v1-evidence';
import {readD1SchemaObjectsAvailable} from './d1-invocation-budget';

export const CANONICAL_ROLLING_TABLES=['analytics_canonical_rolling_segments','analytics_canonical_rolling_rows',
 'analytics_canonical_rolling_windows','analytics_canonical_rolling_members'] as const;
export const CANONICAL_ROLLING_TRIGGERS=['segment_admit','segment_update','row_admit','row_immutable',
 'row_remove','window_admit','window_update','member_admit','member_immutable','head_insert','head_update','head_delete','erasure','owner_terminal']
 .map(name=>'analytics_canonical_rolling_'+name);
const PAGE_SIZE=128,encoder=new TextEncoder();
const unavailable=(reason:string):never=>{throw new CanonicalRollingRefused(reason);};
const closed=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>
 !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export interface CanonicalRollingBudget {remainingQueries():number;now():number;deadlineMs:number}
export interface CanonicalRollingSegmentRef {readonly key:string;readonly day:string;readonly stream:'usage'|'quota';readonly rowCount:number}
export type CanonicalRollingSegmentResult={state:'complete';segment:CanonicalRollingSegmentRef;reused:boolean}
 |{state:'progress';preparedRows:number}|{state:'deferred'|'refused';reason:string};
interface Segment {segment_key:string;state:'building'|'complete'|'dirty';row_count:number;cursor_ms:number;cursor_order:number;revision:number}
/** The payload is a closed native preparation product, never a source record. */
export interface CanonicalRollingNativeRow {
 readonly version:1;readonly family:'v1'|'v11'|'effective';readonly stream:'usage'|'quota';
 readonly occurrenceId:string;readonly provider:string;readonly sessionDigest:string|null;
 readonly planType:string|null;readonly planVariant:string|null;readonly limitId:string|null;readonly slot:string|null;
 readonly usedPercent:number|null;readonly windowMinutes:number|null;readonly resetsAt:string|null;
 readonly price:CanonicalPriceProduct['value'];
}
function occurrence(fact:CanonicalFact):string {
 return `canonical:${String(fact.nativeScopes.occurrenceTieOrder).padStart(16,'0')}:${fact.nativeScopes.logicalOccurrenceKey}`;
}
function validNative(value:unknown):value is CanonicalRollingNativeRow {
 if(!closed(value,['version','family','stream','occurrenceId','provider','sessionDigest','planType','planVariant',
  'limitId','slot','usedPercent','windowMinutes','resetsAt','price'])||value.version!==1
  ||!['v1','v11','effective'].includes(String(value.family))||!['usage','quota'].includes(String(value.stream))
  ||typeof value.occurrenceId!=='string'||!/^canonical:[0-9]{16}:[a-f0-9]{64}$/u.test(value.occurrenceId)
  ||typeof value.provider!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/u.test(value.provider)
  ||value.sessionDigest!==null&&(typeof value.sessionDigest!=='string'||!/^[a-f0-9]{64}$/u.test(value.sessionDigest)))return false;
 for(const field of ['planType','planVariant','limitId','slot'] as const)
  if(value[field]!==null&&(typeof value[field]!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/u.test(value[field] as string)))return false;
 if(value.usedPercent!==null&&(typeof value.usedPercent!=='number'||!Number.isFinite(value.usedPercent)||value.usedPercent<0||value.usedPercent>100)
  ||value.windowMinutes!==null&&(!Number.isSafeInteger(value.windowMinutes)||(value.windowMinutes as number)<1)
  ||value.resetsAt!==null&&(typeof value.resetsAt!=='string'||!Number.isSafeInteger(Date.parse(value.resetsAt))
   ||new Date(value.resetsAt).toISOString()!==value.resetsAt))return false;
 return validCanonicalPriceProduct({factRevision:'0'.repeat(64),method:CANONICAL_FIT_PRICE_METHOD,value:value.price})
  &&(value.stream==='usage'||value.price===null&&value.sessionDigest===null);
}
async function prepareNative(fact:CanonicalFact,price:CanonicalPriceProduct|undefined):Promise<CanonicalRollingNativeRow> {
 await validateCanonicalRollingFact(fact);
 if(fact.stream==='session')unavailable('invalid_stream');
 if(fact.stream==='usage'&&(!price||!validCanonicalPriceProduct(price)||price.factRevision!==fact.revision
  ||canonicalJson(price.method)!==canonicalJson(CANONICAL_FIT_PRICE_METHOD)))unavailable('fit_price_unavailable');
 const row:CanonicalRollingNativeRow={version:1,family:fact.nativeScopes.sourceFamily,stream:fact.stream as 'usage'|'quota',
  occurrenceId:occurrence(fact),provider:fact.values.provider!,sessionDigest:fact.stream==='usage'?fact.nativeScopes.scalarSessionDigest:null,
  planType:fact.values.planType??'unknown',planVariant:fact.values.planVariant,limitId:fact.values.limitId,
  slot:fact.values.slot,usedPercent:fact.values.usedPercent,windowMinutes:fact.values.windowDurationMinutes,
  resetsAt:fact.values.resetsAtMs===null?null:new Date(fact.values.resetsAtMs).toISOString(),price:price?.value??null};
 if(!validNative(row))unavailable('invalid_native_input');return row;
}
export async function canonicalRollingMethodDigest():Promise<string> {
 return sha256Hex(canonicalJson([CANONICAL_ROLLING_INPUT_METHOD,CANONICAL_FIT_PRICE_METHOD]));
}
export async function canonicalRollingInputsAvailable(db:D1Database):Promise<boolean> {
 return readD1SchemaObjectsAvailable(db,[...CANONICAL_ROLLING_TABLES.map(name=>['table',name] as const),
  ...CANONICAL_ROLLING_TRIGGERS.map(name=>['trigger',name] as const)]);
}
/** One bounded ordered page, native prices already materialized by P4. The
 * source seal and target CAS fence both row insertion and header advancement.
 * IDs are allocated in native order without a maximum-day cardinality guess. */
export async function advanceCanonicalRollingSegment(input:{target:D1Database;sourceId:string;ownerDigest:string;
 selectionMethod:CanonicalSelectionMethod;seal:CanonicalInputSeal;budget:CanonicalRollingBudget;
 stillCurrent():Promise<boolean>}):Promise<CanonicalRollingSegmentResult> {
 const {target,seal}=input;
 const available=()=>input.budget.remainingQueries()>=24&&input.budget.now()<input.budget.deadlineMs-500;
 if(!available())return {state:'deferred',reason:'query_budget'};
 canonicalDigest(input.ownerDigest);canonicalDay(seal.day);canonicalDigest(seal.scopeKey);canonicalDigest(seal.sourceStamp);
 if(seal.stream==='session')return {state:'refused',reason:'invalid_stream'};
 if(!await canonicalRollingInputsAvailable(target))return {state:'refused',reason:'migration_required'};
 if(!await input.stillCurrent())return {state:'deferred',reason:'source_changed'};
 const method=await canonicalRollingMethodDigest(),key=await sha256Hex(canonicalJson([method,input.sourceId,input.ownerDigest,
  seal.scopeKey,seal.sourceStamp]));
 await target.prepare(`INSERT INTO analytics_canonical_rolling_segments(segment_key,source_id,owner_digest,scope_key,source_stamp,
 selection_method,day,stream,method_digest,state) VALUES(?,?,?,?,?,?,?,?,?,'building') ON CONFLICT(segment_key) DO NOTHING`)
 .bind(key,input.sourceId,input.ownerDigest,seal.scopeKey,seal.sourceStamp,input.selectionMethod,seal.day,seal.stream,method).run();
 const segment=await target.prepare('SELECT segment_key,state,row_count,cursor_ms,cursor_order,revision FROM analytics_canonical_rolling_segments WHERE segment_key=?')
  .bind(key).first<Segment>();
 if(!segment||segment.state==='dirty')return {state:'deferred',reason:'source_changed'};
 const ref=():CanonicalRollingSegmentRef=>({key,day:seal.day,stream:seal.stream as 'usage'|'quota',rowCount:seal.seenCount});
 if(segment.state==='complete')return await input.stillCurrent()?{state:'complete',segment:ref(),reused:true}:{state:'deferred',reason:'source_changed'};
 const refs=(await target.prepare(`SELECT f.revision FROM analytics_canonical_facts f JOIN analytics_canonical_heads h ON h.revision=f.revision
 WHERE f.source_id=? AND f.owner_digest=? AND f.selection_method=? AND f.stream=? AND f.observed_day=?
 AND (f.observed_at_ms>? OR f.observed_at_ms=? AND f.native_order>?) ORDER BY f.observed_at_ms,f.native_order LIMIT ?`)
 .bind(input.sourceId,input.ownerDigest,input.selectionMethod,seal.stream,seal.day,segment.cursor_ms,segment.cursor_ms,segment.cursor_order,PAGE_SIZE)
 .all<{revision:string}>()).results;
 const facts=await readCanonicalFacts(target,refs.map(row=>row.revision));
 facts.sort((a,b)=>a.location.observedAtMs!-b.location.observedAtMs!||a.location.nativeOrder-b.location.nativeOrder);
 if(facts.length!==refs.length)unavailable('canonical_changed');
 const prices=new Map<string,CanonicalPriceProduct>();
 if(seal.stream==='usage'&&facts.length){
  const stored=(await target.prepare(`SELECT fact_revision,payload,payload_digest FROM analytics_canonical_feature_prices
   WHERE fact_revision IN(SELECT value FROM json_each(?)) AND family='fit' AND method_digest=?`)
   .bind(JSON.stringify(facts.map(fact=>fact.revision)),await canonicalPriceMethodDigest(CANONICAL_FIT_PRICE_METHOD))
   .all<{fact_revision:string;payload:string;payload_digest:string}>()).results;
  for(const row of stored){if(encoder.encode(row.payload).byteLength>4096||await sha256Hex(row.payload)!==row.payload_digest)unavailable('invalid_price');
   const value:unknown=JSON.parse(row.payload);if(!validCanonicalPriceProduct(value)||value.factRevision!==row.fact_revision)unavailable('invalid_price');
   prices.set(row.fact_revision,value as CanonicalPriceProduct);}
  if(facts.some(fact=>!prices.has(fact.revision)))return {state:'deferred',reason:'fit_price_pending'};
 }
 const values=[];
 for(const fact of facts){const row=await prepareNative(fact,prices.get(fact.revision)),payload=canonicalJson(row);
  values.push({revision:fact.revision,ms:fact.location.observedAtMs,order:fact.location.nativeOrder,reset:row.resetsAt,payload,digest:await sha256Hex(payload)});}
 if(!available()||!await input.stillCurrent())return {state:'deferred',reason:'source_changed_or_budget'};
 const last=facts.at(-1),done=facts.length<PAGE_SIZE,count=segment.row_count+facts.length;
 if(count>seal.seenCount||done&&count!==seal.seenCount)unavailable('canonical_count_mismatch');
 const writes:D1PreparedStatement[]=[];
 // Bind pages stay below the existing 128KiB transport bound.
 for(let offset=0;offset<values.length;offset+=16)writes.push(target.prepare(`INSERT INTO analytics_canonical_rolling_rows
 (segment_key,fact_revision,observed_ms,native_order,resets_at,payload,payload_digest)
 SELECT ?,json_extract(value,'$.revision'),json_extract(value,'$.ms'),json_extract(value,'$.order'),json_extract(value,'$.reset'),
 json_extract(value,'$.payload'),json_extract(value,'$.digest') FROM json_each(?)
 WHERE EXISTS(SELECT 1 FROM analytics_canonical_rolling_segments WHERE segment_key=? AND revision=? AND state='building')
 ORDER BY CAST(key AS INTEGER)`).bind(key,JSON.stringify(values.slice(offset,offset+16)),key,segment.revision));
 writes.push(target.prepare(`UPDATE analytics_canonical_rolling_segments SET row_count=?,cursor_ms=?,cursor_order=?,state=?,revision=revision+1
 WHERE segment_key=? AND revision=? AND state='building'`).bind(count,last?.location.observedAtMs??segment.cursor_ms,
 last?.location.nativeOrder??segment.cursor_order,done?'complete':'building',key,segment.revision));
 const result=await target.batch(writes);
 if(result.at(-1)!.meta.changes!==1||!await input.stillCurrent())return {state:'deferred',reason:'source_changed'};
 return done?{state:'complete',segment:ref(),reused:false}:{state:'progress',preparedRows:facts.length};
}
export interface CanonicalRollingWindow {
 readonly sourceId:string;readonly ownerDigest:string;
 readonly kind:'legacy-scalar'|'legacy-model'|'effective-model'|'effective-scalar';
 readonly fromMs:number;readonly throughMs:number|null;readonly nativeDependency:string;
 readonly segments:readonly CanonicalRollingSegmentRef[];
}
export async function sealCanonicalRollingWindow(target:D1Database,input:CanonicalRollingWindow,
 stillCurrent:()=>Promise<boolean>):Promise<string|null> {
 canonicalDigest(input.ownerDigest);canonicalDigest(input.nativeDependency);
 if(!Number.isSafeInteger(input.fromMs)||input.throughMs!==null&&(!Number.isSafeInteger(input.throughMs)||input.throughMs<=input.fromMs)
  ||input.kind==='legacy-scalar'&&input.throughMs!==null||new Set(input.segments.map(s=>s.key)).size!==input.segments.length)unavailable('invalid_window');
 const method=await canonicalRollingMethodDigest();
 const key=await sha256Hex(canonicalJson([method,input.sourceId,input.ownerDigest,input.kind,input.fromMs,input.throughMs,input.nativeDependency,
  input.segments.map(s=>s.key)]));
 if(!await stillCurrent())return null;
 const old=await target.prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=?').bind(key).first<{state:string}>();
 if(old?.state==='dirty')return null;
 if(old?.state==='complete')return await stillCurrent()?key:null;
 await target.prepare(`INSERT INTO analytics_canonical_rolling_windows(window_key,source_id,owner_digest,kind,from_ms,through_ms,
 native_dependency,method_digest,state,member_count) VALUES(?,?,?,?,?,?,?,?,'building',?) ON CONFLICT(window_key) DO NOTHING`)
 .bind(key,input.sourceId,input.ownerDigest,input.kind,input.fromMs,input.throughMs,input.nativeDependency,method,input.segments.length).run();
 for(let offset=0;offset<input.segments.length;offset+=128){
  if(!await stillCurrent())return null;
  await target.prepare(`INSERT INTO analytics_canonical_rolling_members(window_key,segment_key) SELECT ?,value FROM json_each(?)
   WHERE true ON CONFLICT(window_key,segment_key) DO NOTHING`).bind(key,JSON.stringify(input.segments.slice(offset,offset+128).map(s=>s.key))).run();
 }
 if(!await stillCurrent())return null;
 await target.prepare("UPDATE analytics_canonical_rolling_windows SET state='complete' WHERE window_key=? AND state='building'").bind(key).run();
 return await stillCurrent()?key:null;
}
const WINDOW_GUARD=`EXISTS(SELECT 1 FROM analytics_canonical_rolling_windows w JOIN analytics_owner_state o
 ON o.source_id=w.source_id AND o.owner_digest=w.owner_digest AND o.state='active'
 WHERE w.window_key=?1 AND w.state='complete'
 AND w.member_count=(SELECT count(*) FROM analytics_canonical_rolling_members WHERE window_key=w.window_key)
 AND NOT EXISTS(SELECT 1 FROM analytics_storage_erasure_fences e WHERE e.source_id=w.source_id AND e.owner_digest=w.owner_digest)
 AND NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
 JOIN analytics_canonical_input_work i ON i.scope_key=s.scope_key WHERE m.window_key=w.window_key
 AND (s.state!='complete' OR i.state!='sealed' OR i.source_stamp!=s.source_stamp)))`;
interface NativeRead {native_id:number;observed_ms:number;day:string;payload:string;payload_digest:string}
async function decodeNative(rows:readonly NativeRead[]):Promise<Array<{id:number;observedAt:string;day:string;value:CanonicalRollingNativeRow}>> {
 const result=[];
 for(const row of rows){if(encoder.encode(row.payload).byteLength>16384||await sha256Hex(row.payload)!==row.payload_digest)unavailable('invalid_input');
  const value:unknown=JSON.parse(row.payload);if(!validNative(value))unavailable('invalid_input');
  result.push({id:row.native_id,observedAt:new Date(row.observed_ms).toISOString(),day:row.day,value:value as CanonicalRollingNativeRow});}
 return result;
}
/** A concrete native v1 reader over persisted segments. Open-ended scalar
 * windows retain every selected day after the lower cutoff. The reset-major
 * sweep includes all restated reset instants; eligibility remains native. */
export async function createCanonicalV1RollingReader(target:D1Database,windowKey:string,sourceFingerprint:string,
 stillCurrent:()=>Promise<boolean>):Promise<V1PreparedFinishEvidence&{quotaReader:V1QuotaPageReader;
 replayPolicy:typeof V1_PREPARED_READER_POLICY;winningDayDevices:ReadonlyMap<string,string>;assertCurrent():Promise<void>}> {
 canonicalDigest(windowKey);canonicalDigest(sourceFingerprint);
 const found=await target.prepare(`SELECT w.* FROM analytics_canonical_rolling_windows w WHERE w.window_key=?1 AND ${WINDOW_GUARD}`)
 .bind(windowKey).first<{kind:string;native_dependency:string;from_ms:number;through_ms:number|null}>();
 if(!found||!['legacy-scalar','legacy-model'].includes(found.kind)||found.native_dependency!==sourceFingerprint||!await stillCurrent())unavailable('window_changed');
 const header=found!;
 const members=(await target.prepare(`SELECT s.day,s.stream,s.row_count FROM analytics_canonical_rolling_members m
 JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key WHERE m.window_key=?`).bind(windowKey)
 .all<{day:string;stream:string;row_count:number}>()).results;
 const winners=new Map(members.map(row=>[row.day,'canonical-selected']));
 const total=members.filter(row=>row.stream==='usage').reduce((sum,row)=>sum+row.row_count,0);
 const read=async(stream:'quota'|'usage',where:string,args:unknown[],order:string,n:number)=>{
  if(!Number.isSafeInteger(n)||n<1||n>5000)unavailable('invalid_page_bound');
  // A sentinel makes an invalid window distinct from an authoritative empty page.
  const rows=(await target.prepare(`WITH page AS MATERIALIZED(SELECT x.native_id,x.observed_ms,s.day,x.payload,x.payload_digest
   FROM analytics_canonical_rolling_members m JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
   JOIN analytics_canonical_rolling_rows x ON x.segment_key=s.segment_key WHERE m.window_key=?1 AND s.stream='${stream}'
   AND ${where} ORDER BY ${order} LIMIT ?${args.length+2})
   SELECT page.*,CASE WHEN ${WINDOW_GUARD} THEN 1 ELSE 0 END valid FROM (SELECT 1) LEFT JOIN page ON true`)
   .bind(windowKey,...args,n).all<NativeRead&{valid:number}>()).results;
  if(rows.some(row=>row.valid!==1))unavailable('window_changed');
  const decoded=await decodeNative(rows.filter(row=>row.native_id!==null));
  if(decoded.some(row=>row.value.family!=='v1'))unavailable('legacy_family_changed');return decoded;
 };
 const plan=(row:Awaited<ReturnType<typeof read>>[number]):V1PlanSourceRow=>({id:row.id,observed_at:row.observedAt,observed_day:row.day,
  device_id:'canonical-selected',provider:row.value.provider,limit_id:row.value.limitId,plan_type:row.value.planType,plan_variant:row.value.planVariant});
 const assertCurrent=async()=>{
  const current=await target.prepare(`SELECT 1 ready FROM analytics_canonical_rolling_windows w WHERE w.window_key=?1
   AND w.native_dependency=?2 AND ${WINDOW_GUARD}`).bind(windowKey,sourceFingerprint).first<number>('ready');
  if(current!==1||!await stillCurrent())unavailable('window_changed');
 };
 return {sourceFingerprint,replayPolicy:V1_PREPARED_READER_POLICY,winningDayDevices:winners,assertCurrent,
  quotaReader:{pageSize:128,
   async readPlanPage(cursor,n){return (await read('quota',`(x.observed_ms>?2 OR x.observed_ms=?2 AND x.native_id>?3)
    ${header.through_ms===null?'':`AND x.observed_ms<${header.through_ms}`}`,[Date.parse(cursor.observedAt),cursor.id],
    'x.observed_ms,x.native_id',n)).map(plan);},
   async readFitPage(cursor,n){return (await read('quota',`(x.resets_at>?2 OR x.resets_at=?2 AND (x.observed_ms>?3 OR x.observed_ms=?3 AND x.native_id>?4))
    AND json_extract(x.payload,'$.limitId')='codex' AND json_extract(x.payload,'$.windowMinutes')=10080
    AND json_extract(x.payload,'$.usedPercent') IS NOT NULL`,[cursor.resetsAt,Date.parse(cursor.observedAt),cursor.id],
    'x.resets_at,x.observed_ms,x.native_id',n)).map(row=>({...plan(row),occurrence_id:row.value.occurrenceId,provider:row.value.provider,
     limit_id:row.value.limitId!,plan_type:row.value.planType!,plan_variant:row.value.planVariant!,slot:row.value.slot!,used_percent:row.value.usedPercent!,
     window_duration_minutes:row.value.windowMinutes!,resets_at:row.value.resetsAt!} satisfies V1FitSourceRow));}},
  usageReader:{async readPage(time,id,n,before){
   if(Date.parse(time)<header.from_ms||before!==undefined&&Date.parse(before)!==header.through_ms)unavailable('invalid_usage_bounds');
   const rows=await read('usage',`(x.observed_ms>?2 OR x.observed_ms=?2 AND x.native_id>?3)
    ${header.through_ms===null?'':`AND x.observed_ms<${header.through_ms}`}`,[Date.parse(time),id],'x.observed_ms,x.native_id',n);
   return rows.map(row=>({id:row.id,occurrence_id:row.value.occurrenceId,observed_at:row.observedAt,provider:row.value.provider,
    session_uuid:row.value.sessionDigest,record_json:'',preparedPrice:row.value.price} satisfies WindowedUsageRow));}},
  // One fragment per native event is deliberately conservative. Native
  // composition owns accumulation, poisoning, overflow and solver behavior.
  usageBins:{totalRowCount:total,fragmentCount:total,async readPage(time,id,n){
   const grain=MODEL_COMPOSITION_POLICY.grainMs,bin=`(x.observed_ms-((x.observed_ms%${grain})+${grain})%${grain})`;
   const rows=await read('usage',`(${bin}>?2 OR ${bin}=?2 AND x.native_id>?3)
    ${header.through_ms===null?'':`AND x.observed_ms<${header.through_ms}`}`,[Date.parse(time),id],`${bin},x.native_id`,n);
   return rows.map(row=>{const price=row.value.price,binStartMs=Math.floor(Date.parse(row.observedAt)/grain)*grain;
    const fully=price?.pricingStatus==='fully_priced';
    return {id:row.id,observed_at:new Date(binStartMs).toISOString(),provider:row.value.provider,binStartMs,
     usageEventCount:fully?1:0,unpricedUsageEventCount:price!==null&&!fully?1:0,
     cells:fully?[{model:price.modelId??'unknown',costNanousd:price.costNanousd,overflowed:false,
      firstObservedAt:row.observedAt,firstOccurrenceId:row.value.occurrenceId}]:[]};});
  }},
 };
}
/** Retire invalid generations only after their child pages have drained. Mark a
 * window dirty before removing members so a reader never observes a partial
 * complete generation. A sealed replacement stamp is positive supersession;
 * missing or still-building input evidence is not. */
export async function retireCanonicalRollingInputs(target:D1Database,sourceId:string,limit=16,options:{nowMs?:number}={}):Promise<number> {
 if(!Number.isSafeInteger(limit)||limit<1||limit>128)unavailable('invalid_retirement_bound');
 const method=await canonicalRollingMethodDigest(),nowMs=options.nowMs??Date.now();
 if(!Number.isSafeInteger(nowMs)||nowMs<0)unavailable('invalid_retirement_bound');
 const oldest=Date.parse(new Date(nowMs).toISOString().slice(0,10))-365*86400000;
 const windowPins=`NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages p
  JOIN analytics_history_checkpoint_heads h USING(key_digest) WHERE p.source_id=w.source_id
  AND p.owner_digest=w.owner_digest AND h.retired=0)
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work q WHERE q.source_id=w.source_id
   AND q.state IN('ready','leased')
   AND (q.partition_key='rolling-window/'||w.window_key OR q.owner_digest=w.owner_digest AND q.stage='fits'
    AND q.partition_key NOT LIKE 'rolling-window/%' AND q.partition_key NOT LIKE 'rolling-segment/%'))`;
 const windowCandidate=`w.source_id=? AND (w.state='dirty' OR w.method_digest!=? OR COALESCE(w.through_ms,w.from_ms)<?
  OR EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m
   JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
   JOIN analytics_canonical_input_work i ON i.scope_key=s.scope_key
   WHERE m.window_key=w.window_key AND i.state='sealed' AND i.source_stamp!=s.source_stamp))
  AND ${windowPins}
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m
   JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key
   JOIN analytics_canonical_input_work i ON i.scope_key=s.scope_key
   WHERE m.window_key=w.window_key AND i.state!='sealed')`;
 // The state change closes the live read guard before any member is removed.
 const marked=(await target.prepare(`UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE state!='dirty' AND window_key IN(
  SELECT w.window_key FROM analytics_canonical_rolling_windows w WHERE ${windowCandidate}
  ORDER BY w.window_key LIMIT ?) RETURNING window_key`)
  .bind(sourceId,method,oldest,limit).all<{window_key:string}>()).results.length;
 const members=(await target.prepare(`DELETE FROM analytics_canonical_rolling_members WHERE (window_key,segment_key) IN(
  SELECT m.window_key,m.segment_key FROM analytics_canonical_rolling_members m
  JOIN analytics_canonical_rolling_windows w ON w.window_key=m.window_key
  WHERE w.state='dirty' AND ${windowCandidate}
  ORDER BY m.window_key,m.segment_key LIMIT 128) RETURNING segment_key`)
  .bind(sourceId,method,oldest).all<{segment_key:string}>()).results.length;
 const windows=(await target.prepare(`DELETE FROM analytics_canonical_rolling_windows WHERE window_key IN(
  SELECT w.window_key FROM analytics_canonical_rolling_windows w WHERE w.state='dirty' AND ${windowCandidate}
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m WHERE m.window_key=w.window_key)
  ORDER BY w.window_key LIMIT ?) RETURNING window_key`)
  .bind(sourceId,method,oldest,limit).all<{window_key:string}>()).results.length;
 if(windows>=limit)return marked+members+windows;
 const segmentCandidate=`s.source_id=? AND (s.state='dirty' OR s.method_digest!=?
  OR EXISTS(SELECT 1 FROM analytics_canonical_input_work i WHERE i.scope_key=s.scope_key
   AND i.state='sealed' AND i.source_stamp!=s.source_stamp))
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_members m WHERE m.segment_key=s.segment_key)
  AND NOT EXISTS(SELECT 1 FROM analytics_canonical_input_work i WHERE i.scope_key=s.scope_key AND i.state!='sealed')
  AND NOT EXISTS(SELECT 1 FROM analytics_partition_work q WHERE q.source_id=s.source_id
   AND q.state IN('ready','leased')
   AND (q.partition_key='rolling-segment/'||s.segment_key OR q.owner_digest=s.owner_digest AND q.stage='fits'
    AND q.partition_key NOT LIKE 'rolling-window/%' AND q.partition_key NOT LIKE 'rolling-segment/%'))
  AND NOT EXISTS(SELECT 1 FROM analytics_history_checkpoint_stages p
   JOIN analytics_history_checkpoint_heads h USING(key_digest) WHERE p.source_id=s.source_id
   AND p.owner_digest=s.owner_digest AND h.retired=0)`;
 const rows=(await target.prepare(`DELETE FROM analytics_canonical_rolling_rows WHERE native_id IN(
  SELECT r.native_id FROM analytics_canonical_rolling_rows r
  JOIN analytics_canonical_rolling_segments s ON s.segment_key=r.segment_key
  WHERE ${segmentCandidate} ORDER BY s.segment_key,r.native_id LIMIT 128) RETURNING native_id`)
  .bind(sourceId,method).all<{native_id:number}>()).results.length;
 const segments=(await target.prepare(`DELETE FROM analytics_canonical_rolling_segments WHERE segment_key IN(
  SELECT s.segment_key FROM analytics_canonical_rolling_segments s WHERE ${segmentCandidate}
   AND NOT EXISTS(SELECT 1 FROM analytics_canonical_rolling_rows r WHERE r.segment_key=s.segment_key)
  ORDER BY s.segment_key LIMIT ?) RETURNING segment_key`)
  .bind(sourceId,method,limit-windows).all<{segment_key:string}>()).results.length;
 return marked+members+windows+rows+segments;
}
