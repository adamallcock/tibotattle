/** Last controls actually observed by a Worker role, not an inferred deployment. */
export interface AnalyticsPipelineRuntimeControl {
 readonly role:'analytics'|'publication'|'cache';readonly method:'maintained-analytics-v1';
 readonly canonicalPipeline:boolean;readonly sharedFeatures:boolean;readonly modelBlocks:boolean;
 readonly degree:1|2|4|8;readonly queryLimit:number;readonly observedMs:number;
}
const TABLE='analytics_pipeline_runtime';
async function available(target:D1Database):Promise<boolean>{
 return await target.prepare("SELECT 1 ready FROM sqlite_schema WHERE type='table' AND name=?").bind(TABLE).first<number>('ready')===1;
}
function validate(value:AnalyticsPipelineRuntimeControl):void{
 if(!['analytics','publication','cache'].includes(value.role)||value.method!=='maintained-analytics-v1'
  ||[value.canonicalPipeline,value.sharedFeatures,value.modelBlocks].some(item=>typeof item!=='boolean')
  ||![1,2,4,8].includes(value.degree)||!Number.isSafeInteger(value.queryLimit)||value.queryLimit<1||value.queryLimit>950
  ||!Number.isSafeInteger(value.observedMs)||value.observedMs<0)throw new Error('ANALYTICS_RUNTIME_CONTROL_INVALID');
}
export async function recordAnalyticsPipelineRuntime(target:D1Database,sourceId:string,value:AnalyticsPipelineRuntimeControl):Promise<boolean>{
 validate(value);if(!availableSource(sourceId))throw new Error('ANALYTICS_RUNTIME_CONTROL_INVALID');
 if(!await available(target))return false;
 await target.prepare(`INSERT INTO analytics_pipeline_runtime(source_id,role,method,canonical_enabled,shared_features_enabled,
  model_blocks_enabled,degree,max_queries,updated_ms) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,role) DO UPDATE SET
  method=excluded.method,canonical_enabled=excluded.canonical_enabled,shared_features_enabled=excluded.shared_features_enabled,
  model_blocks_enabled=excluded.model_blocks_enabled,degree=excluded.degree,max_queries=excluded.max_queries,updated_ms=excluded.updated_ms
  WHERE excluded.updated_ms>=analytics_pipeline_runtime.updated_ms`).bind(sourceId,value.role,value.method,+value.canonicalPipeline,
  +value.sharedFeatures,+value.modelBlocks,value.degree,value.queryLimit,value.observedMs).run();return true;
}
const availableSource=(value:string)=>/^[-A-Za-z0-9._:]{1,128}$/u.test(value);
/** Three compact rows maximum. Null means schema unavailable; an empty array
 * means the schema exists but no role has reported its controls. */
export async function readAnalyticsPipelineRuntime(target:D1Database,sourceId:string):Promise<readonly AnalyticsPipelineRuntimeControl[]|null>{
 if(!availableSource(sourceId))throw new Error('ANALYTICS_RUNTIME_CONTROL_INVALID');if(!await available(target))return null;
 const rows=(await target.prepare(`SELECT role,method,canonical_enabled,shared_features_enabled,model_blocks_enabled,degree,max_queries,
  updated_ms FROM analytics_pipeline_runtime WHERE source_id=? ORDER BY role LIMIT 4`).bind(sourceId)
  .all<{role:AnalyticsPipelineRuntimeControl['role'];method:AnalyticsPipelineRuntimeControl['method'];canonical_enabled:number;
   shared_features_enabled:number;model_blocks_enabled:number;degree:AnalyticsPipelineRuntimeControl['degree'];max_queries:number;updated_ms:number}>()).results;
 if(rows.length>3)throw new Error('ANALYTICS_RUNTIME_CONTROL_INVALID');
 return rows.map(row=>{
  if([row.canonical_enabled,row.shared_features_enabled,row.model_blocks_enabled].some(value=>value!==0&&value!==1))
    throw new Error('ANALYTICS_RUNTIME_CONTROL_INVALID');
  const value={role:row.role,method:row.method,canonicalPipeline:row.canonical_enabled===1,sharedFeatures:row.shared_features_enabled===1,
   modelBlocks:row.model_blocks_enabled===1,degree:row.degree,queryLimit:row.max_queries,observedMs:row.updated_ms};validate(value);return value;
 });
}
