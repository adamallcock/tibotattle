import {sha256Hex} from '../../src/crypto';
import {typedTelemetryDayNumber,typedTelemetryDayString} from '../../src/typed-telemetry-codec';
import {logicalBytes} from './analytics-logical-bytes';
type ProjectionType='number'|'text'|'binary'|'tools'|'observed-day'|'account-basis'|'plan-basis';
// Output-column names only: these are not inferred aliases or a SQL lineage
// proof. Unknown names/types stay unclassified, even alongside known payloads.
const analyticalProjectionColumns=new Map<string,ProjectionType>();
const metadataProjectionColumns=new Map<string,ProjectionType>();
const projectionColumns=(target:Map<string,ProjectionType>,type:ProjectionType,names:string)=>{
 for(const name of names.split(' '))target.set(name,type);
};
projectionColumns(analyticalProjectionColumns,'text',
 'record_json recordJson analytical_record_json analyticalRecordJson legacy_record_json legacyRecordJson payload_json payloadJson records_json recordsJson '+
 'provider model model_id speed_mode api_service_tier surface billing_surface reasoning_effort agent_scope outcome '+
 'plan_type plan_variant limit_id slot resets_at account_track_id attribution_plan_type plan_era_id '+
 'tool_json session_uuid');
projectionColumns(analyticalProjectionColumns,'number',
 'total_input_context_tokens input_uncached_tokens input_cache_read_tokens input_cache_write_tokens '+
 'output_text_tokens output_reasoning_tokens output_combined_tokens used_percent window_duration_minutes resets_at_ms '+
 'boundary_flags tie_order cache_write_ttl_five_minute_tokens cache_write_ttl_one_hour_tokens');
projectionColumns(analyticalProjectionColumns,'binary','session_id account_track plan_era');
projectionColumns(analyticalProjectionColumns,'tools','tool_class_counts');
projectionColumns(analyticalProjectionColumns,'account-basis','account_basis');
projectionColumns(analyticalProjectionColumns,'plan-basis','plan_basis');
projectionColumns(metadataProjectionColumns,'text',
 'participantId ownerDigest sourceId sourceNamespace participant_id owner_digest source_id source_namespace '+
 'stream source_day record_day event_day family source_key source_digest canonical_sha256 record_digest base_digest '+
 'device_id manifest_id manifest_digest chunk_day chunk_digest');
projectionColumns(metadataProjectionColumns,'number',
 'inputRevision ownerRevision authorityEpoch publicAuthorityEpoch policyRevision collectionRevision sourceEpoch sequence '+
 'hasV1 hasV11 hasV12 hasEffective hasLegacy member_count identified_count cached_count '+
 'id storage_row_id record_index observed_at_ms source_row_id chunk_seq revision accepted_record_count record_count '+
 'history_fact_count max_history_id max_fact_id');
projectionColumns(metadataProjectionColumns,'binary','occurrence_id canonical_digest');
projectionColumns(metadataProjectionColumns,'observed-day','observed_day');
// These same output names carry physical integer codes or decoded view text.
// This checks returned representations only; it does not prove SQL lineage,
// record consistency, or the narrower v1.2-only physical day bound.
const accountBases=['unavailable','same_source','provisional_marker'] as const;
const planBases=['unavailable','same_source_occurrence','provisional_marker','conflicted'] as const;
function projectedDay(value:unknown):boolean {
 try {
  if(typeof value==='number'){typedTelemetryDayString(value);return true;}
  if(typeof value==='string'){typedTelemetryDayNumber(value);return true;}
 }catch{return false;}
 return false;
}
function projectedBasis(value:unknown,names:readonly string[]):boolean {
 return typeof value==='number'?Number.isInteger(value)&&value>=0&&value<names.length
  :typeof value==='string'&&names.some(name=>name===value);
}
function projectedType(value:unknown,type:ProjectionType):boolean {
 if(value===null)return true;
 if(type==='observed-day')return projectedDay(value);
 if(type==='account-basis')return projectedBasis(value,accountBases);
 if(type==='plan-basis')return projectedBasis(value,planBases);
 if(type==='number')return typeof value==='number'&&Number.isFinite(value);
 if(type==='text')return typeof value==='string';
 if(type==='binary')return typeof value==='string'||value instanceof ArrayBuffer||ArrayBuffer.isView(value)
  ||Array.isArray(value)&&value.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255);
 return !!value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.values(value).every(count=>Number.isSafeInteger(count)&&Number(count)>=0);
}
interface ResultProjectionCounts {
 analyticalProjectionRows:number;metadataOnlyRows:number;unclassifiedRows:number;unclassifiedFields:number;
 invalidTypeFields:number;schemaUnobservedStatements:number;
}
const resultProjectionCounts=():ResultProjectionCounts=>({analyticalProjectionRows:0,metadataOnlyRows:0,
 unclassifiedRows:0,unclassifiedFields:0,invalidTypeFields:0,schemaUnobservedStatements:0});
function classifyProjection(row:Record<string,unknown>,counts:ResultProjectionCounts):Record<string,unknown> {
 const fields=Object.entries(row),payload:Record<string,unknown>={};let analytical=false,unknown=fields.length===0;
 for(const [name,value] of fields){
  const analyticalType=analyticalProjectionColumns.get(name),type=analyticalType??metadataProjectionColumns.get(name);
  if(type===undefined){counts.unclassifiedFields++;unknown=true;continue;}
  if(!projectedType(value,type)){counts.invalidTypeFields++;unknown=true;continue;}
  if(analyticalType!==undefined){analytical=true;if(value!==null)payload[name]=value;}
 }
 if(analytical)counts.analyticalProjectionRows++;
 if(unknown)counts.unclassifiedRows++;
 else if(!analytical)counts.metadataOnlyRows++;
 return payload;
}
/** Synthetic-only SQL cost attribution. Bindings stay ephemeral and are used
 * only for read-only EXPLAIN; reports carry normalized SQL and aggregate cost. */
export function canonicalRollingSqlProfile(phase:()=>string){
 type Entry={phase:string;side:'source'|'target';category:string;sql:string;normalized:string;bindings:unknown[];
  db:D1Database;statements:number;rowsRead:number;rowsWritten:number;returnedRows:number;emptyResults:number;resultShapeGaps:number;resultBytes:number;payloadBearingRows:number;payloadBearingBytes:number;resultProjection:ResultProjectionCounts};
 const entries=new Map<string,Entry>();
 // Every direct physical-history shape survives top-ten truncation. This
 // classifies explicit SQL references, not an uninspected view expansion.
 const rawPhysical=(sql:string)=>/\b(?:FROM|JOIN)\s+(?:["`]?main["`]?\.)?["`\[]?(?:telemetry_v12_records|typed_telemetry_records|telemetry_v1_chunks|telemetry_v1_records|telemetry_usage_corrections|telemetry_usage_correction_history)\b/iu.test(sql);
 const category=(side:string,sql:string)=>/sqlite_schema/.test(sql)?'capability'
  :side==='source'&&/telemetry_analytical_chunks|community_snapshot_mutation_control/.test(sql)?'native_pin'
  :side==='source'&&/storage_owner|storage_v11_owner|community_analytical_input_versions|participants/.test(sql)?'source_authority'
  :side==='source'?'source_selected_data':/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)?'target_mutation':'target_inventory_and_inputs';
 function wrap(db:D1Database,side:'source'|'target'):D1Database{
  const statements=new WeakMap<D1PreparedStatement,{inner:D1PreparedStatement;sql:string;args:unknown[]}>();
  const record=(sql:string,args:unknown[],result:D1Result<unknown>)=>{
   const normalized=sql.replace(/\s+/gu,' ').trim().replace(/\b\d{10,}\b/gu,'<epoch>'),label=phase(),key=label+'|'+side+'|'+normalized;
   let item=entries.get(key);if(!item){if(entries.size>=4096)throw new Error('synthetic SQL attribution entry bound');item={phase:label,side,category:category(side,sql),sql,normalized,bindings:args,db,statements:0,rowsRead:0,rowsWritten:0,returnedRows:0,emptyResults:0,resultShapeGaps:0,resultBytes:0,payloadBearingRows:0,payloadBearingBytes:0,resultProjection:resultProjectionCounts()};entries.set(key,item);}
   item.statements++;item.rowsRead+=result.meta.rows_read;item.rowsWritten+=result.meta.rows_written;
   const rows:unknown=result.results;
   if(!Array.isArray(rows)){item.resultShapeGaps++;item.resultProjection.schemaUnobservedStatements++;}
   else {
    item.returnedRows+=rows.length;if(rows.length===0){item.emptyResults++;item.resultProjection.schemaUnobservedStatements++;}
    item.resultBytes+=logicalBytes(rows);
    for(const row of rows) {
     if(!row||typeof row!=='object'||Array.isArray(row)){item.resultShapeGaps++;item.resultProjection.unclassifiedRows++;continue;}
     const payload=classifyProjection(row as Record<string,unknown>,item.resultProjection);
     if(Object.keys(payload).length){item.payloadBearingRows++;item.payloadBearingBytes+=logicalBytes(payload);}
    }
   }
  };
  const statement=(inner:D1PreparedStatement,sql:string,args:unknown[]=[]):D1PreparedStatement=>{
   const value=new Proxy(inner,{get(_target,key){
    if(key==='bind')return(...bindings:unknown[])=>statement(inner.bind(...bindings),sql,bindings);
    if(key==='all'||key==='run')return async()=>{const result=await inner[key]();record(sql,args,result);return result;};
    if(key==='first')return async(column?:string)=>{const result=await inner.all<Record<string,unknown>>();record(sql,args,result);
     return result.results[0]===undefined?null:column===undefined?result.results[0]:result.results[0][column];};
    const member=Reflect.get(inner,key);return typeof member==='function'?member.bind(inner):member;
   }});statements.set(value,{inner,sql,args});return value;
  };
  return new Proxy(db,{get(_target,key){
   if(key==='prepare')return(sql:string)=>statement(db.prepare(sql),sql);
   if(key==='batch')return async(values:D1PreparedStatement[])=>{
    const selected=values.map(value=>{const found=statements.get(value);if(!found)throw new Error('synthetic foreign profile statement');return found;});
    const results=await db.batch(selected.map(value=>value.inner));results.forEach((result,index)=>record(selected[index]!.sql,selected[index]!.args,result));return results;};
   const member=Reflect.get(db,key);return typeof member==='function'?member.bind(db):member;
  }});
 }
 return {wrap,async report(){
  const classes:Record<string,{statements:number;rowsRead:number;rowsWritten:number}>={};
  for(const entry of entries.values()){const key=entry.phase+'.'+entry.side+'.'+entry.category,value=classes[key]??={statements:0,rowsRead:0,rowsWritten:0};
   value.statements+=entry.statements;value.rowsRead+=entry.rowsRead;value.rowsWritten+=entry.rowsWritten;}
  const top=[...entries.values()].sort((a,b)=>b.rowsRead-a.rowsRead).slice(0,10);
  const rawPhysicalHistory=await Promise.all([...entries.values()].filter(entry=>rawPhysical(entry.sql)).map(async entry=>({
   phase:entry.phase,side:entry.side,fingerprint:await sha256Hex(entry.normalized),category:entry.category,statements:entry.statements,rowsRead:entry.rowsRead,rowsWritten:entry.rowsWritten,
   returnedRows:entry.returnedRows,emptyResults:entry.emptyResults,resultShapeGaps:entry.resultShapeGaps,resultBytes:entry.resultBytes,payloadBearingRows:entry.payloadBearingRows,payloadBearingBytes:entry.payloadBearingBytes,
   resultProjection:{contract:'direct-history-projection-v3',...entry.resultProjection,
    observedSchemaComplete:entry.returnedRows>0&&entry.resultShapeGaps===0&&entry.resultProjection.unclassifiedRows===0
     &&entry.resultProjection.schemaUnobservedStatements===0,noRescanQualified:false},
  })));
  rawPhysicalHistory.sort((a,b)=>a.phase.localeCompare(b.phase)||a.side.localeCompare(b.side)||a.fingerprint.localeCompare(b.fingerprint));
  return {retention:{entries:entries.size,maximumEntries:4096,representativeBindingLogicalBytes:[...entries.values()].reduce((sum,entry)=>sum+logicalBytes(entry.bindings),0),contract:'One representative bind array per normalized SQL shape for diagnostic EXPLAIN; not per-call results or product retained memory.'},classes,
   rawPhysicalHistory,rawPhysicalHistoryContract:'Every successful direct physical-history SQL fingerprint, bounded by the shared4096-shape inventory; aggregate results and closed JSON/typed analytical column bytes only (direct-history-projection-v3). Bytes are logical selected nonnull-field JSON, not wire or a complete analytical record. Null analytical projections remain counted separately. No result rows/bind values/unknown column names in this histogram. Unknown names/types and unobserved empty-result schemas stay explicit; observedSchemaComplete concerns returned fields only, not SQL lineage. Known output names can also be arbitrary aliases; indirect view expansions and arbitrary payload aliases are not qualified; zero detected payload never establishes no-rescan qualification. Failed statements and their unknown resource dimensions are measured by the owning actual profile, not this success histogram.',top:await Promise.all(top.map(async(entry,index)=>({phase:entry.phase,side:entry.side,category:entry.category,
   fingerprint:await sha256Hex(entry.normalized),normalizedSql:entry.normalized,statements:entry.statements,rowsRead:entry.rowsRead,rowsWritten:entry.rowsWritten,
   ...(index<2?{queryPlan:(await entry.db.prepare('EXPLAIN QUERY PLAN '+entry.sql).bind(...entry.bindings).all()).results}:{})})))};
 }};
}
