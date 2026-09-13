import { encodeTypedTelemetryId } from './typed-telemetry-codec';
import { decodeTypedTelemetryUsageAnalysisRows } from './typed-telemetry-compatibility';
import { V1_ORIGIN_CURSOR_VERSION, type V1QuotaPageReader,type V1PlanSourceRow,type V1FitSourceRow } from './quota-analysis-v1-reader';
import { V1_WINNER_FILTER_SQL } from './telemetry-v1-source-selection';
import { MAX_TYPED_TELEMETRY_OWNER_ORIGINS,readQualifiedTypedTelemetryOwnerOrigins } from './typed-telemetry-origins';

export interface TypedV1AnalysisScope {sourceNamespace:string;participantId:string;ownerId:number;
 origins:ReadonlyArray<{namespaceId:number;sourceNamespace:string;typedOwnerId:number;accessMode:'current-write'|'retained-read'}>}
const fail=()=>new Error('TYPED_V1_ANALYSIS_NOT_READY');
const blob=(text:string)=>Uint8Array.from(encodeTypedTelemetryId(text)).buffer;
const GROUP=`CASE WHEN q.resets_at_ms>253402300799999 THEN 0 WHEN q.resets_at_ms< -62167219200000 THEN 1 ELSE 2 END`;
const VALUE=`CASE WHEN q.resets_at_ms< -62167219200000 THEN -q.resets_at_ms ELSE q.resets_at_ms END`;
function instant(value:string,empty=false):number{
 if(empty&&value==='')return -8640000000000000;
 const n=Date.parse(value);if(!Number.isSafeInteger(n)||new Date(n).toISOString()!==value)throw fail();return n;
}
function resetKey(value:string):[number,number]{const n=instant(value);return n>253402300799999?[0,n]:n< -62167219200000?[1,-n]:[2,n];}
function limit(value:number,max:number){if(!Number.isSafeInteger(value)||value<1||value>max)throw fail();}

/** Resolve once per analytical invocation. No cached cross-reset DB state and
 * no fallback from an initialized but unqualified typed layout. Page callbacks
 * themselves keep the original one-query quota / two-query usage contracts. */
export async function loadTypedV1AnalysisScope(db:D1Database,participantId:string,tableKnown=false):Promise<TypedV1AnalysisScope|null>{
 if(!tableKnown&&!await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='typed_v1_admission_state'").first())return null;
 const state=await db.prepare(`SELECT s.source_namespace,s.runtime_contract_version,
  (SELECT id FROM typed_telemetry_owners WHERE namespace_id=s.namespace_id AND original_id=?) owner_id,
  EXISTS(SELECT 1 FROM participants WHERE id=? AND state='active') active,
  EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='typed_v1_analytical_schema') ready,
  EXISTS(SELECT 1 FROM typed_telemetry_origin_contracts origin WHERE origin.namespace_id=s.namespace_id
   AND origin.source_namespace=s.source_namespace AND origin.access_mode='current-write'
   AND origin.v1_read_contract_version=2) origin_ready
  FROM typed_v1_admission_state s
  WHERE s.id=1`).bind(blob(participantId),participantId)
  .first<{source_namespace:string;runtime_contract_version:number;owner_id:number|null;active:number;ready:number;origin_ready:number}>();
 if(!state)return null;
 if(state.runtime_contract_version!==1||state.ready!==1||state.active!==1||state.origin_ready!==1)throw fail();
 const origins=await readQualifiedTypedTelemetryOwnerOrigins(db,participantId,'v1');
 const current=origins.filter(origin=>origin.accessMode==='current-write');
 if(current.length>1 || (state.owner_id===null ? current.length!==0
   : current.length!==1 || current[0]!.sourceNamespace!==state.source_namespace || current[0]!.typedOwnerId!==state.owner_id))throw fail();
 return {sourceNamespace:state.source_namespace,participantId,ownerId:state.owner_id??-1,origins};
}

function planSql(upper:boolean){return `WITH same_time AS MATERIALIZED (
 SELECT r.id,r.observed_at_ms,r.source_row_id FROM typed_telemetry_records r INDEXED BY typed_v1_owner_observed
 WHERE r.format=10 AND r.owner_id=?1 AND r.stream=2 AND r.observed_at_ms=?2 AND r.source_row_id>?3${upper?' AND r.observed_at_ms<?5':''}
 ORDER BY r.source_row_id LIMIT ?4
),later AS MATERIALIZED (
 SELECT r.id,r.observed_at_ms,r.source_row_id FROM typed_telemetry_records r INDEXED BY typed_v1_owner_observed
 WHERE r.format=10 AND r.owner_id=?1 AND r.stream=2 AND r.observed_at_ms>?2${upper?' AND r.observed_at_ms<?5':''}
 ORDER BY r.observed_at_ms,r.source_row_id LIMIT (SELECT ?4-count(*) FROM same_time)
),page AS MATERIALIZED (SELECT * FROM same_time UNION ALL SELECT * FROM later)
SELECT page.id physical_id,v.* FROM page LEFT JOIN typed_v1_current_records v ON v.storage_row_id=page.id
ORDER BY page.observed_at_ms,page.source_row_id`;}
export const TYPED_V1_PLAN_PAGE_SQL=planSql(false);
export const TYPED_V1_HISTORY_PLAN_PAGE_SQL=planSql(true);
const fitScope=`q.analysis_owner_id=?1 AND q.limit_id=(SELECT id FROM typed_telemetry_dictionary WHERE value='codex')
 AND q.window_duration_minutes=10080 AND q.resets_at_ms IS NOT NULL AND q.used_percent IS NOT NULL`;
export const TYPED_V1_FIT_PAGE_SQL=`WITH same_key AS MATERIALIZED (
 SELECT q.record_id,${GROUP} sort_group,${VALUE} sort_value,q.analysis_observed_at_ms,q.analysis_source_row_id
 FROM typed_telemetry_quota q INDEXED BY typed_v1_quota_reset WHERE ${fitScope}
 AND (${GROUP})=?2 AND (${VALUE})=?3 AND q.analysis_observed_at_ms=?4 AND q.analysis_source_row_id>?5
 ORDER BY q.analysis_source_row_id LIMIT ?6
),later AS MATERIALIZED (
 SELECT q.record_id,${GROUP} sort_group,${VALUE} sort_value,q.analysis_observed_at_ms,q.analysis_source_row_id
 FROM typed_telemetry_quota q INDEXED BY typed_v1_quota_reset WHERE ${fitScope}
 AND ((${GROUP}),(${VALUE}),q.analysis_observed_at_ms)>(?2,?3,?4)
 ORDER BY (${GROUP}),(${VALUE}),q.analysis_observed_at_ms,q.analysis_source_row_id LIMIT (SELECT ?6-count(*) FROM same_key)
),page AS MATERIALIZED (SELECT * FROM same_key UNION ALL SELECT * FROM later)
SELECT page.record_id physical_id,v.* FROM page LEFT JOIN typed_v1_current_records v ON v.storage_row_id=page.record_id
ORDER BY page.sort_group,page.sort_value,page.analysis_observed_at_ms,page.analysis_source_row_id`;
type Row=Record<string,unknown>;
function scopeOrigin(row:Row,scope:TypedV1AnalysisScope){
 return scope.origins.find(origin=>origin.sourceNamespace===row.source_namespace&&origin.namespaceId===row.namespace_id
  &&origin.typedOwnerId===row.owner_id);
}
function originCursorRequired(scope:TypedV1AnalysisScope){return scope.origins.length>1
 ||(scope.origins.length===1&&(scope.origins[0]!.accessMode!=='current-write'
  ||scope.origins[0]!.sourceNamespace!==scope.sourceNamespace||scope.origins[0]!.typedOwnerId!==scope.ownerId));}
function boundedOrigins(scope:TypedV1AnalysisScope){
 const origins=scope.origins.map(origin=>({...origin})).sort((left,right)=>left.sourceNamespace<right.sourceNamespace?-1:
  left.sourceNamespace>right.sourceNamespace?1:left.typedOwnerId-right.typedOwnerId);
 if(origins.length<1||origins.length>MAX_TYPED_TELEMETRY_OWNER_ORIGINS
  ||new Set(origins.map(origin=>origin.sourceNamespace)).size!==origins.length
  ||new Set(origins.map(origin=>origin.typedOwnerId)).size!==origins.length
  ||origins.some(origin=>!Number.isSafeInteger(origin.namespaceId)||origin.namespaceId<1
   ||!Number.isSafeInteger(origin.typedOwnerId)||origin.typedOwnerId<1
   ||!['current-write','retained-read'].includes(origin.accessMode)))throw fail();
 for(const origin of origins)blob(origin.sourceNamespace);
 return origins;
}
function quotaRow(row:Row,scope:TypedV1AnalysisScope,multi=false):V1PlanSourceRow{
 if(row.physical_id!==row.storage_row_id||!scopeOrigin(row,scope)||row.participant_id!==scope.participantId
  ||row.format_code!==10||row.stream!=='quota'||row.quota_record_id!==row.storage_row_id
  ||!Number.isSafeInteger(row.source_row_id)||Number(row.source_row_id)<1)throw fail();
 return {id:row.source_row_id as number,...(multi?{source_namespace:row.source_namespace as string}:{}),
  observed_at:row.observed_at as string,observed_day:row.observed_day as string,
  device_id:row.device_id as string,provider:row.provider as string,limit_id:row.limit_id as string,
  plan_type:row.plan_type as string,plan_variant:row.plan_variant as string};
}
const MULTI_QUOTA_COLUMNS=`v.storage_row_id,v.namespace_id,v.owner_id,v.participant_id,v.format_code,v.stream,
 v.quota_record_id,v.source_row_id,v.source_namespace,v.observed_at,v.observed_day,v.device_id,v.provider,
 v.limit_id,v.plan_type,v.plan_variant,v.occurrence_id,v.slot,v.used_percent,v.window_duration_minutes,v.resets_at`;
export function typedV1MultiPlanPageSql(originCount:number){
 if(!Number.isSafeInteger(originCount)||originCount<1||originCount>MAX_TYPED_TELEMETRY_OWNER_ORIGINS)throw fail();
 const arms=Array.from({length:originCount},(_,index)=>{const namespace=6+index*2,owner=namespace+1;return `SELECT * FROM (
  SELECT r.id physical_id,r.observed_at_ms cursor_observed_at_ms,r.source_row_id cursor_source_row_id,
   ?${namespace} cursor_source_namespace,${MULTI_QUOTA_COLUMNS}
  FROM typed_telemetry_records r INDEXED BY typed_v1_owner_observed
  JOIN typed_v1_current_records v ON v.storage_row_id=r.id
  WHERE r.format=10 AND r.owner_id=?${owner} AND r.stream=2 AND r.observed_at_ms<?5
   AND (r.observed_at_ms>?1 OR (r.observed_at_ms=?1 AND (?${namespace}>?2 COLLATE BINARY
    OR (?${namespace}=?2 AND r.source_row_id>?3))))
  ORDER BY r.observed_at_ms,r.source_row_id LIMIT ?4)`;});
 return `WITH candidates AS MATERIALIZED (${arms.join(' UNION ALL ')})
 SELECT * FROM candidates ORDER BY cursor_observed_at_ms,cursor_source_namespace COLLATE BINARY,cursor_source_row_id LIMIT ?4`;
}
export function typedV1MultiFitPageSql(originCount:number){
 if(!Number.isSafeInteger(originCount)||originCount<1||originCount>MAX_TYPED_TELEMETRY_OWNER_ORIGINS)throw fail();
 const qGroup=GROUP,qValue=VALUE;
 const arms=Array.from({length:originCount},(_,index)=>{const namespace=7+index*2,owner=namespace+1;return `SELECT * FROM (
  SELECT q.record_id physical_id,${qGroup} sort_group,${qValue} sort_value,q.analysis_observed_at_ms,
   q.analysis_source_row_id,?${namespace} cursor_source_namespace,${MULTI_QUOTA_COLUMNS}
  FROM typed_telemetry_quota q INDEXED BY typed_v1_quota_reset
  JOIN typed_v1_current_records v ON v.storage_row_id=q.record_id
  WHERE q.analysis_owner_id=?${owner} AND q.limit_id=(SELECT id FROM typed_telemetry_dictionary WHERE value='codex')
   AND q.window_duration_minutes=10080 AND q.resets_at_ms IS NOT NULL AND q.used_percent IS NOT NULL
   AND ((${qGroup})>?1 OR ((${qGroup})=?1 AND ((${qValue})>?2 OR ((${qValue})=?2
    AND (q.analysis_observed_at_ms>?3 OR (q.analysis_observed_at_ms=?3 AND (?${namespace}>?4 COLLATE BINARY
     OR (?${namespace}=?4 AND q.analysis_source_row_id>?5))))))))
  ORDER BY (${qGroup}),(${qValue}),q.analysis_observed_at_ms,q.analysis_source_row_id LIMIT ?6)`;});
 return `WITH candidates AS MATERIALIZED (${arms.join(' UNION ALL ')})
 SELECT * FROM candidates ORDER BY sort_group,sort_value,analysis_observed_at_ms,cursor_source_namespace COLLATE BINARY,
  analysis_source_row_id LIMIT ?6`;
}
export function createTypedV1QuotaPageReader(db:D1Database,input:TypedV1AnalysisScope,observedAtBefore?:string):V1QuotaPageReader{
 const scope={...input},before=observedAtBefore===undefined?undefined:instant(observedAtBefore);
 const multi=originCursorRequired(scope);
 const origins=multi?boundedOrigins(scope):[];
 return {
  ...(multi?{cursorVersion:V1_ORIGIN_CURSOR_VERSION as typeof V1_ORIGIN_CURSOR_VERSION}:{}),
  async readPlanPage(cursor,n){limit(n,1024);if(!Number.isSafeInteger(cursor.id)||cursor.id<0)throw fail();
   if(multi){if(!('sourceNamespace'in cursor)||cursor.cursorVersion!==V1_ORIGIN_CURSOR_VERSION)throw fail();
    const args=[instant(cursor.observedAt,true),cursor.sourceNamespace,cursor.id,n,before??8_640_000_000_000_001,
      ...origins.flatMap(origin=>[origin.sourceNamespace,origin.typedOwnerId])];
    const rows=(await db.prepare(typedV1MultiPlanPageSql(origins.length)).bind(...args).all<Row>()).results;
    return rows.map(row=>quotaRow(row,scope,true));}
   const args=[scope.ownerId,instant(cursor.observedAt,true),cursor.id,n];if(before!==undefined)args.push(before);
   const rows=(await db.prepare(before===undefined?TYPED_V1_PLAN_PAGE_SQL:TYPED_V1_HISTORY_PLAN_PAGE_SQL).bind(...args).all<Row>()).results;
   return rows.map(row=>quotaRow(row,scope));},
  async readFitPage(cursor,n){limit(n,1024);if(!Number.isSafeInteger(cursor.id)||cursor.id<0)throw fail();
   const [group,value]=resetKey(cursor.resetsAt);
   if(multi){if(!('sourceNamespace'in cursor)||cursor.cursorVersion!==V1_ORIGIN_CURSOR_VERSION)throw fail();
    const rows=(await db.prepare(typedV1MultiFitPageSql(origins.length)).bind(group,value,instant(cursor.observedAt,true),
      cursor.sourceNamespace,cursor.id,n,...origins.flatMap(origin=>[origin.sourceNamespace,origin.typedOwnerId])).all<Row>()).results;
    return rows.map(row=>({...quotaRow(row,scope,true),occurrence_id:row.occurrence_id as string,slot:row.slot as string,
      used_percent:row.used_percent as number,window_duration_minutes:row.window_duration_minutes as number,resets_at:row.resets_at as string}) as V1FitSourceRow);}
   const rows=(await db.prepare(TYPED_V1_FIT_PAGE_SQL).bind(scope.ownerId,group,value,instant(cursor.observedAt,true),cursor.id,n).all<Row>()).results;
   return rows.map(row=>({...quotaRow(row,scope),occurrence_id:row.occurrence_id as string,slot:row.slot as string,
    used_percent:row.used_percent as number,window_duration_minutes:row.window_duration_minutes as number,resets_at:row.resets_at as string}) as V1FitSourceRow);},
 };
}

function usageSql(same:boolean,upper:boolean){return `WITH page AS MATERIALIZED (
 SELECT r.storage_row_id,r.observed_at_ms,r.source_row_id FROM typed_telemetry_records base INDEXED BY typed_v1_owner_observed
 JOIN typed_v1_current_records r ON r.storage_row_id=base.id
 WHERE base.format=10 AND base.owner_id=?1 AND base.stream=1
 AND ${V1_WINNER_FILTER_SQL.replace('json_each(?)','json_each(?2)')}
 AND base.observed_at_ms${same?'=':'>'}?3${same?' AND base.source_row_id>?4':''}${upper?' AND base.observed_at_ms<?6':''}
 ORDER BY base.observed_at_ms,base.source_row_id LIMIT ?5
)
SELECT r.* FROM page CROSS JOIN typed_v1_current_records r ON r.storage_row_id=page.storage_row_id
ORDER BY page.observed_at_ms,page.source_row_id`;}
export const TYPED_V1_USAGE_AT_TIME_SQL=usageSql(true,false);
export const TYPED_V1_USAGE_AFTER_TIME_SQL=usageSql(false,false);
export function typedV1MultiUsagePageSql(originCount:number){
 if(!Number.isSafeInteger(originCount)||originCount<1||originCount>MAX_TYPED_TELEMETRY_OWNER_ORIGINS)throw fail();
 const winner=V1_WINNER_FILTER_SQL.replaceAll('r.','candidate.').replace('json_each(?)','json_each(?1)');
 const arms=Array.from({length:originCount},(_,index)=>{const namespace=7+index*2,owner=namespace+1;return `SELECT * FROM (
  SELECT base.id physical_id,base.observed_at_ms,base.source_row_id,?${namespace} source_namespace
  FROM typed_telemetry_records base INDEXED BY typed_v1_owner_observed
  JOIN typed_v1_current_records candidate ON candidate.storage_row_id=base.id
  WHERE base.format=10 AND base.owner_id=?${owner} AND base.stream=1 AND ${winner}
   AND base.observed_at_ms<?6 AND (base.observed_at_ms>?2 OR (base.observed_at_ms=?2
    AND (?${namespace}>?3 COLLATE BINARY OR (?${namespace}=?3 AND base.source_row_id>?4))))
  ORDER BY base.observed_at_ms,base.source_row_id LIMIT ?5)`;});
 return `WITH candidates AS MATERIALIZED (${arms.join(' UNION ALL ')}),page AS MATERIALIZED (
  SELECT * FROM candidates ORDER BY observed_at_ms,source_namespace COLLATE BINARY,source_row_id LIMIT ?5)
 SELECT r.* FROM page CROSS JOIN typed_v1_current_records r ON r.storage_row_id=page.physical_id
 ORDER BY page.observed_at_ms,page.source_namespace COLLATE BINARY,page.source_row_id`;
}
export async function readTypedV1UsageAnalysisPage(db:D1Database,scopeValue:TypedV1AnalysisScope,winnersJson:string,
 observedAt:string,id:number,pageSize:number,observedAtBefore?:string,cursorSourceNamespace=''){
 const scope={...scopeValue};limit(pageSize,5000);if(!Number.isSafeInteger(id)||id<0)throw fail();
 if(originCursorRequired(scope)){
  const origins=boundedOrigins(scope);
  const args:unknown[]=[winnersJson,instant(observedAt,true),cursorSourceNamespace,id,pageSize,
    observedAtBefore===undefined?8_640_000_000_000_001:instant(observedAtBefore),
    ...origins.flatMap(origin=>[origin.sourceNamespace,origin.typedOwnerId])];
  const rows=(await db.prepare(typedV1MultiUsagePageSql(origins.length)).bind(...args).all<Row>()).results;
  const indexed=new Map<string,Array<{row:Row;index:number}>>();
  rows.forEach((row,index)=>{if(!scopeOrigin(row,scope))throw fail();const source=row.source_namespace;
   if(typeof source!=='string')throw fail();const group=indexed.get(source)??[];group.push({row,index});indexed.set(source,group);});
  const decoded=new Array<Awaited<ReturnType<typeof decodeTypedTelemetryUsageAnalysisRows>>[number]>(rows.length);
  for(const [source,group] of indexed){const records=await decodeTypedTelemetryUsageAnalysisRows(db,group.map(item=>item.row),
    {sourceNamespace:source,participantId:scope.participantId});records.forEach((record,index)=>{decoded[group[index]!.index]=record;});}
  return decoded.map((row,index)=>({id:row.id,source_namespace:rows[index]!.source_namespace as string,
    occurrence_id:row.occurrence_id,observed_at:row.observed_at,provider:row.provider,
    session_uuid:row.session_uuid,record_json:row.record_json}));
 }
 const args:unknown[]=[scope.ownerId,winnersJson,instant(observedAt,true),id,pageSize];
 if(observedAtBefore!==undefined)args.push(instant(observedAtBefore));
 const rows=(await db.prepare(usageSql(true,observedAtBefore!==undefined)).bind(...args).all<Row>()).results;
 if(rows.length<pageSize){args[4]=pageSize-rows.length;
  rows.push(...(await db.prepare(usageSql(false,observedAtBefore!==undefined)).bind(...args).all<Row>()).results);}
 const decoded=await decodeTypedTelemetryUsageAnalysisRows(db,rows,scope);
 return decoded.map(row=>({id:row.id,occurrence_id:row.occurrence_id,observed_at:row.observed_at,
  provider:row.provider,session_uuid:row.session_uuid,record_json:row.record_json}));
}
