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
}

export interface AnalyticsProfile {
  costs: Record<string, AnalyticsProfileCost>;
  /** Sticky: optional production fallbacks may catch a profiling exception,
   * but they cannot turn this profile back into publishable measurements. */
  measurementFailures: number;
  checkpointPartInsertStatements: number;
  checkpointPayloadBytesSubmitted: number;
  wallMs: number;
  operationWallMs: Record<string,number>;
  invocations: number;
  maximumStatementsPerInvocation: number;
}

type Side = 'source' | 'target';
type ResultMeta = {rows_read?:number; rows_written?:number; duration?:number};

function completeMetadata(result:unknown):Required<ResultMeta> {
  const meta=(result as {meta?:ResultMeta}|null)?.meta;
  for(const field of ['rows_read','rows_written','duration'] as const){
    const value=meta?.[field];
    if(typeof value!=='number'||!Number.isFinite(value)||value<0)
      throw new Error(`analytics benchmark requires finite nonnegative D1 metadata: ${field}`);
  }
  return meta as Required<ResultMeta>;
}

export function createAnalyticsProfile(): AnalyticsProfile {
  return {costs:{},measurementFailures:0,checkpointPartInsertStatements:0,checkpointPayloadBytesSubmitted:0,
    wallMs:0,operationWallMs:{},invocations:0,maximumStatementsPerInvocation:0};
}

export async function measureAnalyticsWork<T>(profile:AnalyticsProfile,operation:string,
  run:()=>Promise<T>):Promise<T> {
  const started=performance.now();
  try{return await run();}
  finally{profile.operationWallMs[operation]=(profile.operationWallMs[operation]??0)+performance.now()-started;}
}

function family(sql:string,bound:readonly unknown[]):string {
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
  phase:()=>string):D1Database {
  const originals=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string;bound:unknown[]}>();
  const record=(sql:string,bound:unknown[],result:unknown,elapsed:number,failed=false,batched=false)=>{
    const current=typeof profile==='function'?profile():profile;
    const key=`${phase()}.${side}.${family(sql,bound)}`;
    const cost=current.costs[key]??={statements:0,failedStatements:0,rowsRead:0,rowsWritten:0,
      databaseMs:0,statementCallWallMs:0,allocatedBatchWallMs:0,metadataSamples:0};
    cost.statements++;
    if(batched)cost.allocatedBatchWallMs+=elapsed;
    else cost.statementCallWallMs+=elapsed;
    if(failed)cost.failedStatements++;
    let meta:Required<ResultMeta>|undefined;
    if(!failed){
      try{meta=completeMetadata(result);}
      catch(error){current.measurementFailures++;throw error;}
    }
    if(meta){
      cost.metadataSamples++;
      cost.rowsRead+=meta.rows_read;
      cost.rowsWritten+=meta.rows_written;
      cost.databaseMs+=meta.duration;
    }
    if(!failed&&sql.includes('INSERT INTO analytics_history_checkpoint_parts')){
      current.checkpointPartInsertStatements++;
      if(typeof bound[4]==='number')current.checkpointPayloadBytesSubmitted+=bound[4];
    }
    if(!failed&&sql.includes('INSERT INTO analytics_model_block_parts')){
      current.checkpointPartInsertStatements++;
      if(typeof bound[3]==='number')current.checkpointPayloadBytesSubmitted+=bound[3];
    }
  };
  const wrap=(statement:D1PreparedStatement,sql:string,bound:unknown[]=[]):D1PreparedStatement=>{
    const proxy=new Proxy(statement,{get(inner,key){
      if(key==='bind')return(...values:unknown[])=>wrap(inner.bind(...values),sql,values);
      if(key==='first')return async(column?:string)=>{
        const started=performance.now();let result:D1Result<Record<string,unknown>>;
        try{result=await inner.all<Record<string,unknown>>();}
        catch(error){record(sql,bound,null,performance.now()-started,true);throw error;}
        record(sql,bound,result,performance.now()-started);
        const row=result.results[0];
        if(row===undefined)return null;
        if(column===undefined)return row;
        if(!Object.hasOwn(row,column))throw new Error('analytics benchmark first() column unavailable');
        return row[column];
      };
      if(['all','run','raw'].includes(String(key)))return async(...args:unknown[])=>{
        const started=performance.now();
        const method=Reflect.get(inner,key) as (...values:unknown[])=>Promise<unknown>;
        let result:unknown;
        try{result=await Reflect.apply(method,inner,args);}
        catch(error){record(sql,bound,null,performance.now()-started,true);throw error;}
        record(sql,bound,result,performance.now()-started);return result;
      };
      const value:unknown=Reflect.get(inner,key);return typeof value==='function'?value.bind(inner):value;
    }});
    originals.set(proxy,{original:statement,sql,bound});return proxy;
  };
  return new Proxy(database,{get(inner,key){
    if(key==='prepare')return(sql:string)=>wrap(inner.prepare(sql),sql);
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      const prepared=statements.map(statement=>originals.get(statement));
      if(prepared.some(value=>value===undefined))throw new Error('analytics benchmark unprofiled batch');
      const started=performance.now();
      let results:D1Result[];
      try{results=await inner.batch(prepared.map(value=>value!.original));}
      catch(error){
        const elapsed=(performance.now()-started)/Math.max(1,statements.length);
        for(const entry of prepared)record(entry!.sql,entry!.bound,null,elapsed,true,true);
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
        try{record(prepared[index]!.sql,prepared[index]!.bound,results[index],elapsed,false,true);}
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
    metadataContract:'Every successful statement has finite nonnegative rows_read, rows_written and duration.',
    batchWallTimeAllocation:'Per-family allocatedBatchWallMs divides each measured batch call equally among its statements; family durations are not independently measured.',
    cpuMs:null,cpuUnavailableReason:'Local Workerd test bindings do not expose per-operation CPU time.',
    peakMemoryBytes:null,peakMemoryUnavailableReason:'Serialized retained bytes are measured; isolate peak heap is not exposed.',
  };
}
