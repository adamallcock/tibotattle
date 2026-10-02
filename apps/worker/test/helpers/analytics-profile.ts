import {C06_STATEMENT_SCOPE,isC06OperationScope,type C06OperationScope} from './analytics-c06-operation-scope';
import {logicalBytes,recordLogicalSubmission,LOGICAL_BYTE_CONTRACT,type StoreSubmission} from './analytics-logical-bytes';
/** Local benchmark instrumentation. It records counts and timing only: SQL,
 * bind values, result rows and owner identifiers never enter the report. */
export interface AnalyticsProfileCost {
  statements: number;
  failedStatements: number;
  rowsRead: number;
  rowsWritten: number;
  databaseMs: number;
  statementCallWallMs: number;
  /** Batch elapsed time divided equally among its statements, not an
   * independently measured duration for this family. */
  allocatedBatchWallMs: number;
  metadataSamples: number;
  /** Statements accessing physical raw-history tables, including dependency proofs. */
  rawHistoryAccessStatements: number;
  /** UTF-8 JSON representation sizes; these are not network or disk bytes. */
  serializedBoundBytesSubmitted: number;
  serializedResultBytesRead: number;
}

export interface AnalyticsProfile {
  costs: Record<string, AnalyticsProfileCost>;
  /** Sticky: optional production fallbacks may catch a profiling exception,
   * but they cannot turn this profile back into publishable measurements. */
  measurementFailures: number;
  /** Known once an observer is attached to this profile; failures stay sticky.
   * Absent without an observer. Lazy profiles become known on first record. */
  statementObserverFailures?: number;
  storeSubmissions: Record<string,StoreSubmission>;
  checkpointPartInsertStatements: number;
  checkpointPayloadBytesSubmitted: number;
  wallMs: number;
  operationWallMs: Record<string,number>;
  operationInvocations: Record<string,number>;
  databaseSizeObservations: Partial<Record<Side,{firstBytes:number|null;lastBytes:number|null;maximumBytes:number|null;samples:number;unavailableSamples:number}>>;
  invocations: number;
  maximumStatementsPerInvocation: number;
}

export type AnalyticsProfileSide = 'source' | 'target' | 'ledger';
type Side = AnalyticsProfileSide;
export type AnalyticsProfileMethod = 'first' | 'all' | 'run' | 'raw' | 'batch';
/** SQL is ephemeral collector input. No bindings, results or error objects. */
export interface AnalyticsStatementObservation {
  sql:string;phase:string;side:Side;family:string;method:AnalyticsProfileMethod;
  /** Private test-only immutable prepared-statement tag; never inferred from SQL. */
  operationScope?:C06OperationScope;
  outcome:'success'|'failed'|'invalid_metadata';
  rowsRead:number|null;rowsWritten:number|null;databaseMs:number|null;
  callWallMs:number;batchWallAllocation:boolean;
  boundLogicalBytes:number;resultLogicalBytes:number|null;
}
export type AnalyticsStatementObserver=(observation:AnalyticsStatementObservation)=>void;
type ResultMeta = {rows_read?:number; rows_written?:number; duration?:number;size_after?:number};
type CompleteMeta = Required<Pick<ResultMeta,'rows_read'|'rows_written'|'duration'>>&Pick<ResultMeta,'size_after'>;

const serializedBytes=logicalBytes;

function rawHistoryAccess(sql:string):boolean {
  return /\b(?:FROM|JOIN)\s+(?:telemetry_v12_records|typed_telemetry_records|telemetry_v1_chunks|telemetry_v1_records|telemetry_usage_corrections)\b/iu.test(sql);
}

function completeMetadata(result:unknown):CompleteMeta {
  const meta=(result as {meta?:ResultMeta}|null)?.meta;
  for(const field of ['rows_read','rows_written','duration'] as const){
    const value=meta?.[field];
    if(typeof value!=='number'||!Number.isFinite(value)||value<0)
      throw new Error(`analytics benchmark requires finite nonnegative D1 metadata: ${field}`);
  }
  return meta as CompleteMeta;
}

export function createAnalyticsProfile(): AnalyticsProfile {
  return {costs:{},measurementFailures:0,storeSubmissions:{},checkpointPartInsertStatements:0,checkpointPayloadBytesSubmitted:0,
    wallMs:0,operationWallMs:{},operationInvocations:{},databaseSizeObservations:{},invocations:0,maximumStatementsPerInvocation:0};
}

export async function measureAnalyticsWork<T>(profile:AnalyticsProfile,operation:string,
  run:()=>Promise<T>):Promise<T> {
  const started=performance.now();
  try{return await run();}
  finally{profile.operationInvocations[operation]=(profile.operationInvocations[operation]??0)+1;profile.operationWallMs[operation]=(profile.operationWallMs[operation]??0)+performance.now()-started;}
}

function family(sql:string,bound:readonly unknown[]):string {
  if(sql.includes('analytics_canonical'))return 'canonical';
  if(sql.includes('analytics_effective_dependency'))return 'dependency_summary';
  if(sql.includes('effective_dependency_mutation'))return 'mutation_metadata';
  if(sql.includes('analytics_preparation'))return 'preparation';
  if(sql.includes('analytics_shared_feature'))return 'shared_feature';
  if(sql.includes('analytics_model_block'))return 'model_block';
  if(sql.includes('analytics_history_checkpoint'))return 'checkpoint';
  if(sql.includes('analytics_graph_day_'))return 'prepared_graph_day';
  if(sql.includes('analytics_community_graph_results'))return 'graph_result';
  if(sql.includes('analytics_community_daily_'))return 'daily_result';
  if(sql.includes('analytics_cache_retention_'))return 'cache_retention';
  if(sql.includes('selected(occurrence_id)')||sql.includes('/* batched occurrence links */'))return 'dependency_links';
  if(sql.includes('telemetry_usage_correction'))return 'correction';
  const stream=bound.includes('usage')||sql.includes("stream='usage'")||sql.includes('stream = 1')?'usage'
    :bound.includes('quota')||sql.includes("stream='quota'")||sql.includes('stream = 2')?'quota'
      :bound.includes('session')||sql.includes("stream='session'")||sql.includes('stream = 3')?'session':'other';
  if(sql.includes('telemetry_v12_records')||sql.includes('telemetry_v12_chunks'))return `v12_${stream}`;
  if(sql.includes('typed_telemetry_records'))return `typed_${stream}`;
  if(sql.includes('storage_owner_revisions')||sql.includes('storage_v11_owner_links')
    ||sql.includes('analytics_owner_state'))return 'owner_fence';
  return 'other';
}

/** first() is observed through the identical prepared statement's all() call
 * so D1's physical rows/duration metadata remains available. No query text or
 * bindings change. Other methods retain their normal result shape. */
export function profileAnalyticsDatabase(database:D1Database,side:Side,profile:AnalyticsProfile|(()=>AnalyticsProfile),
  phase:()=>string,observeStatement?:AnalyticsStatementObserver):D1Database {
  if(observeStatement&&typeof profile!=='function')profile.statementObserverFailures??=0;
  const originals=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string;bound:unknown[]}>();
  const record=(sql:string,bound:unknown[],result:unknown,elapsed:number,failed=false,batched=false,
    method:AnalyticsProfileMethod='all',dispatchPhase?:string,operationScope?:C06OperationScope)=>{
    const current=typeof profile==='function'?profile():profile;
    if(observeStatement)current.statementObserverFailures??=0;
    const label=dispatchPhase??phase(),sqlFamily=family(sql,bound);
    const key=`${label}.${side}.${sqlFamily}`;
    const cost=current.costs[key]??={statements:0,failedStatements:0,rowsRead:0,rowsWritten:0,
      databaseMs:0,statementCallWallMs:0,allocatedBatchWallMs:0,metadataSamples:0,
      rawHistoryAccessStatements:0,serializedBoundBytesSubmitted:0,serializedResultBytesRead:0};
    cost.statements++;
    recordLogicalSubmission(current.storeSubmissions,side,sql,bound,failed);
    if(rawHistoryAccess(sql))cost.rawHistoryAccessStatements++;
    const boundBytes=serializedBytes(bound),resultBytes=failed?null:serializedBytes((result as {results?:unknown}|null)?.results);
    cost.serializedBoundBytesSubmitted+=boundBytes;
    if(resultBytes!==null)cost.serializedResultBytesRead+=resultBytes;
    if(batched)cost.allocatedBatchWallMs+=elapsed;
    else cost.statementCallWallMs+=elapsed;
    if(failed)cost.failedStatements++;
    let meta:CompleteMeta|undefined;
    try {
    if(!failed){
      try{meta=completeMetadata(result);}
      catch(error){current.measurementFailures++;throw error;}
    }
    if(meta){
      cost.metadataSamples++;
      cost.rowsRead+=meta.rows_read;
      cost.rowsWritten+=meta.rows_written;
      cost.databaseMs+=meta.duration;
      const size=current.databaseSizeObservations[side]??={firstBytes:null,lastBytes:null,maximumBytes:null,samples:0,unavailableSamples:0};
      if(typeof meta.size_after==='number'&&Number.isSafeInteger(meta.size_after)&&meta.size_after>=0) {
        size.firstBytes??=meta.size_after;size.lastBytes=meta.size_after;
        size.maximumBytes=Math.max(size.maximumBytes??0,meta.size_after);size.samples++;
      } else size.unavailableSamples++;
    }
    if(!failed&&sql.includes('INSERT INTO analytics_history_checkpoint_parts')){
      current.checkpointPartInsertStatements++;
      if(typeof bound[4]==='number')current.checkpointPayloadBytesSubmitted+=bound[4];
    }
    if(!failed&&sql.includes('INSERT INTO analytics_model_block_parts')){
      current.checkpointPartInsertStatements++;
      if(typeof bound[3]==='number')current.checkpointPayloadBytesSubmitted+=bound[3];
    }
    } finally {
      if(observeStatement)try{observeStatement({sql,phase:label,side,family:sqlFamily,method,...(operationScope?{operationScope}:{}),
        outcome:failed?'failed':meta?'success':'invalid_metadata',rowsRead:meta?.rows_read??null,
        rowsWritten:meta?.rows_written??null,databaseMs:meta?.duration??null,
        callWallMs:elapsed,batchWallAllocation:batched,boundLogicalBytes:boundBytes,resultLogicalBytes:resultBytes});}
      catch{current.statementObserverFailures=(current.statementObserverFailures??0)+1;}
    }
  };
  const statementScope=(statement:D1PreparedStatement):C06OperationScope|undefined=>{
    if(!observeStatement)return;
    const tag:unknown=Reflect.get(statement,C06_STATEMENT_SCOPE);
    if(tag===undefined)return;
    if(typeof tag!=='function')throw Error('ANALYTICS_PROFILE_OPERATION_SCOPE');
    const scope:unknown=Reflect.apply(tag,statement,[]);
    if(scope!==undefined&&!isC06OperationScope(scope))throw Error('ANALYTICS_PROFILE_OPERATION_SCOPE');
    return scope;
  };
  const wrap=(statement:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(inner,key){
      if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql,values);
      if(key==='first')return async(column?:string)=>{
        const dispatchPhase=observeStatement?phase():undefined,operationScope=statementScope(inner),started=performance.now();let result:D1Result<Record<string,unknown>>;
        try{result=await inner.all<Record<string,unknown>>();}
        catch(error){record(sql,bound,null,performance.now()-started,true,false,'first',dispatchPhase,operationScope);throw error;}
        record(sql,bound,result,performance.now()-started,false,false,'first',dispatchPhase,operationScope);
        const row=result.results[0];
        if(row===undefined)return null;
        if(column===undefined)return row;
        if(!Object.hasOwn(row,column))throw new Error('analytics benchmark first() column unavailable');
        return row[column];
      };
      if(['all','run','raw'].includes(String(key)))return async(...args:unknown[])=>{
        const dispatchPhase=observeStatement?phase():undefined,operationScope=statementScope(inner),started=performance.now();
        const method=Reflect.get(inner,key) as (...values:unknown[])=>Promise<unknown>;
        let result:unknown;
        try{result=await Reflect.apply(method,inner,args);}
        catch(error){record(sql,bound,null,performance.now()-started,true,false,key as AnalyticsProfileMethod,dispatchPhase,operationScope);throw error;}
        record(sql,bound,result,performance.now()-started,false,false,key as AnalyticsProfileMethod,dispatchPhase,operationScope);return result;
      };
      const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
    }});
    originals.set(proxy,{original:statement,sql,bound});return proxy;
  };
  return new Proxy(database,{get(inner,key){
    if(key==='constructor')return inner.constructor;
    if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      const prepared=statements.map(statement=>originals.get(statement));
      if(prepared.some(value=>value===undefined))throw new Error('analytics benchmark unprofiled batch');
      const dispatchPhase=observeStatement?phase():undefined,operationScopes=prepared.map(entry=>statementScope(entry!.original)),started=performance.now();
      let results:D1Result[];
      try{results=await inner.batch(prepared.map(value=>value!.original));}
      catch(error){
        const elapsed=(performance.now()-started)/Math.max(1,statements.length);
        for(const [index,entry] of prepared.entries())record(entry!.sql,entry!.bound,null,elapsed,true,true,'batch',dispatchPhase,operationScopes[index]);
        throw error;
      }
      const elapsed=(performance.now()-started)/Math.max(1,statements.length);
      let measurementFailure:unknown;
      if(results.length!==prepared.length){
        const current=typeof profile==='function'?profile():profile;
        current.measurementFailures++;
        measurementFailure=new Error('analytics benchmark incomplete batch results');
      }
      for(let index=0;index<prepared.length;index++){
        try{record(prepared[index]!.sql,prepared[index]!.bound,results[index],elapsed,false,true,'batch',dispatchPhase,operationScopes[index]);}
        catch(error){measurementFailure??=error;}
      }
      if(measurementFailure!==undefined)throw measurementFailure;
      return results;
    };
    if(key==='exec')return()=>{throw new Error('analytics benchmark requires prepared statements');};
    const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
  }});
}

export function summarizeAnalyticsProfile(profile:AnalyticsProfile) {
  if(profile.measurementFailures!==0)throw new Error('analytics benchmark profile contains invalid measurements');
  const costs=Object.values(profile.costs);
  const total=(field:keyof AnalyticsProfileCost)=>costs.reduce((sum,cost)=>sum+cost[field],0);
  return {...profile,
    statements:total('statements'),failedStatements:total('failedStatements'),
    rowsRead:total('rowsRead'),rowsWritten:total('rowsWritten'),databaseMs:total('databaseMs'),
    databaseWallMs:total('statementCallWallMs')+total('allocatedBatchWallMs'),
    statementCallWallMs:total('statementCallWallMs'),allocatedBatchWallMs:total('allocatedBatchWallMs'),
    metadataSamples:total('metadataSamples'),
    rawHistoryAccessStatements:total('rawHistoryAccessStatements'),
    serializedBoundBytesSubmitted:total('serializedBoundBytesSubmitted'),
    serializedResultBytesRead:total('serializedResultBytesRead'),
    databaseSizeContract:'First, latest and maximum observed D1 meta.size_after per physical binding; local SQLite footprint, not bytes written, WAL/fsync, cloud storage or GB-month. Missing observations stay explicit.',
    checkpointPayloadByteContract:'Submitted payload-byte subset from analytics_history_checkpoint_parts and analytics_model_block_parts only; excludes maintained feature, canonical input/publication and other payload stores. Not physical writes or retained bytes.',
    logicalSubmissionInventoryComplete:Object.values(profile.storeSubmissions).every(store=>store.unknownPayloadStatements===0),
    totalCheckpointPayloadBytesSubmitted:Object.values(profile.storeSubmissions).some(store=>store.unknownPayloadStatements>0)?null:Object.values(profile.storeSubmissions).reduce((sum,store)=>sum+store.payloadBytes,0),
    byteContract:LOGICAL_BYTE_CONTRACT,
    queryPlans:null,queryPlansUnavailableReason:'This profile does not execute EXPLAIN probes inside the measured workload.',
    metadataContract:'Every successful statement has finite nonnegative rows_read, rows_written and duration.',
    batchWallTimeAllocation:'Per-family allocatedBatchWallMs divides each measured batch call equally among its statements; family durations are not independently measured.',
    cpuMs:null,cpuUnavailableReason:'Local Workerd test bindings do not expose per-operation CPU time.',
    peakMemoryBytes:null,peakMemoryUnavailableReason:'True peak isolate heap is not measured by this SQL/resource profile. Separately attached runtime observations contain sampled/barrier heap, not a true peak.',
  };
}

/** Scalar-only instrumentation: unlike a mock spy this never retains input
 * strings, parsed objects, revivers, errors, call stacks or per-call records. */
export function installAnalyticalDecodeCounter() {
  const descriptor=Object.getOwnPropertyDescriptor(JSON,'parse');
  if(!descriptor||typeof descriptor.value!=='function')throw new Error('JSON parse counter requires own function');
  const original=JSON.parse;let calls=0,analyticalDecodes=0,restored=false;
  const wrapper:typeof JSON.parse=function(this:unknown,text,reviver) {
    calls++;
    if(typeof text==='string'&&/"schemaVersion":"(?:usage-event|quota-observation|session-dimension)-v1(?:\.[12])?"/u.test(text))analyticalDecodes++;
    return Reflect.apply(original,this,arguments);
  };
  Object.defineProperty(JSON,'parse',{...descriptor,value:wrapper});
  return {read:()=>({calls,analyticalDecodes,retainedCallRecords:0 as const}),restore(){
    if(restored)return;
    if(JSON.parse!==wrapper)throw new Error('JSON parse instrumentation changed before restoration');
    Object.defineProperty(JSON,'parse',descriptor);restored=true;
  }};
}
