import { encodeTypedTelemetryId } from './typed-telemetry-codec';
import { decodeTypedTelemetryUsageAnalysisRows } from './typed-telemetry-compatibility';
import type { V1QuotaPageReader,V1PlanSourceRow,V1FitSourceRow } from './quota-analysis-v1-reader';
import { V1_WINNER_FILTER_SQL } from './telemetry-v1-source-selection';

export interface TypedV1AnalysisScope {sourceNamespace:string;participantId:string;ownerId:number}
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
  EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='typed_v1_analytical_schema') ready
  FROM typed_v1_admission_state s WHERE s.id=1`).bind(blob(participantId),participantId)
  .first<{source_namespace:string;runtime_contract_version:number;owner_id:number|null;active:number;ready:number}>();
 if(!state)return null;
 if(state.runtime_contract_version!==1||state.ready!==1||state.active!==1)throw fail();
 return {sourceNamespace:state.source_namespace,participantId,ownerId:state.owner_id??-1};
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
function quotaRow(row:Row,scope:TypedV1AnalysisScope):V1PlanSourceRow{
 if(row.physical_id!==row.storage_row_id||row.source_namespace!==scope.sourceNamespace||row.participant_id!==scope.participantId
  ||row.owner_id!==scope.ownerId||row.format_code!==10||row.stream!=='quota'||row.quota_record_id!==row.storage_row_id
  ||!Number.isSafeInteger(row.source_row_id)||Number(row.source_row_id)<1)throw fail();
 return {id:row.source_row_id as number,observed_at:row.observed_at as string,observed_day:row.observed_day as string,
  device_id:row.device_id as string,provider:row.provider as string,limit_id:row.limit_id as string,
  plan_type:row.plan_type as string,plan_variant:row.plan_variant as string};
}
export function createTypedV1QuotaPageReader(db:D1Database,input:TypedV1AnalysisScope,observedAtBefore?:string):V1QuotaPageReader{
 const scope={...input},before=observedAtBefore===undefined?undefined:instant(observedAtBefore);
 return {
  async readPlanPage(cursor,n){limit(n,1024);if(!Number.isSafeInteger(cursor.id)||cursor.id<0)throw fail();
   const args=[scope.ownerId,instant(cursor.observedAt,true),cursor.id,n];if(before!==undefined)args.push(before);
   const rows=(await db.prepare(before===undefined?TYPED_V1_PLAN_PAGE_SQL:TYPED_V1_HISTORY_PLAN_PAGE_SQL).bind(...args).all<Row>()).results;
   return rows.map(row=>quotaRow(row,scope));},
  async readFitPage(cursor,n){limit(n,1024);if(!Number.isSafeInteger(cursor.id)||cursor.id<0)throw fail();
   const [group,value]=resetKey(cursor.resetsAt);
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
export async function readTypedV1UsageAnalysisPage(db:D1Database,scopeValue:TypedV1AnalysisScope,winnersJson:string,
 observedAt:string,id:number,pageSize:number,observedAtBefore?:string){
 const scope={...scopeValue};limit(pageSize,5000);if(!Number.isSafeInteger(id)||id<0)throw fail();
 const args:unknown[]=[scope.ownerId,winnersJson,instant(observedAt,true),id,pageSize];
 if(observedAtBefore!==undefined)args.push(instant(observedAtBefore));
 const rows=(await db.prepare(usageSql(true,observedAtBefore!==undefined)).bind(...args).all<Row>()).results;
 if(rows.length<pageSize){args[4]=pageSize-rows.length;
  rows.push(...(await db.prepare(usageSql(false,observedAtBefore!==undefined)).bind(...args).all<Row>()).results);}
 const decoded=await decodeTypedTelemetryUsageAnalysisRows(db,rows,scope);
 return decoded.map(row=>({id:row.id,occurrence_id:row.occurrence_id,observed_at:row.observed_at,
  provider:row.provider,session_uuid:row.session_uuid,record_json:row.record_json}));
}
