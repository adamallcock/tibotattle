/** Concrete, bounded P1 -> P4 -> P5 preparation for the native v1 engines.
 * A complete window reuses metadata and ordered products across isolates. */
import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
import {createD1InvocationBudget,D1InvocationBudgetExceededError} from './d1-invocation-budget';
import {canonicalAnalyticsAvailable} from './storage-canonical-analytics-facts';
import {advanceCanonicalInputWork,readCanonicalInputPreparationSeal,canonicalInputReadContextCurrent,createCanonicalInputReadContext,closeCanonicalInputReadContext,type CanonicalInputReadContext,type CanonicalInputScope} from './storage-canonical-analytics-input';
import {canonicalFeatureContributionsAvailable,materializeCanonicalFeatureRows} from './storage-canonical-feature-contributions';
import {CANONICAL_FIT_PRICE_METHOD,canonicalPriceMethodDigest} from './canonical-feature-contributions';
import {effectiveSelectiveSchemaAvailable,advanceEffectiveDependencyCoverage,readEffectiveDependencySourceFence} from './storage-effective-selective-dependencies';
import {loadTypedV1AnalysisScope} from './typed-v1-analysis-reader';
import {assertV1SourcePinCurrent,loadV1SourcePin,type V1SourcePin} from './telemetry-v1-source-selection';
import {canonicalRollingInputsAvailable,canonicalRollingMethodDigest,advanceCanonicalRollingSegment,
 createCanonicalV1RollingReader,type CanonicalRollingWindow} from './storage-canonical-rolling-inputs';
export interface CanonicalV1Pipeline {target:D1Database;sourceId:string;sourceNamespace:string;ownerDigest:string}
export type CanonicalV1WindowReadiness={state:'ready';windowKey:string;queriesUsed:number;
 reader:Awaited<ReturnType<typeof createCanonicalV1RollingReader>>}
 |{state:'deferred'|'unavailable';reason:string;queriesUsed:number};
export async function advanceCanonicalV1Window(input:CanonicalV1Pipeline&{source:D1Database;pin:V1SourcePin;
 kind:'legacy-scalar'|'legacy-model';maxQueries:number;deadlineMs:number;now?:()=>number}):Promise<CanonicalV1WindowReadiness> {
 const now=input.now??Date.now,meter=createD1InvocationBudget(input.maxQueries);
 const source=meter.wrap(input.source),target=meter.wrap(input.target);
 const result=(state:'deferred'|'unavailable',reason:string):CanonicalV1WindowReadiness=>({state,reason,queriesUsed:meter.queriesUsed});
 const available=(reserve=80)=>meter.remainingQueries>=reserve&&now()<input.deadlineMs-1500;
 if(!('participantId'in input.pin.scope)||!input.pin.scope.fromDay||input.kind==='legacy-scalar'&&input.pin.scope.throughDay!==undefined
  ||input.kind==='legacy-model'&&input.pin.scope.throughDay===undefined)throw new Error('CANONICAL_V1_WINDOW_SCOPE');
 const participantId=input.pin.scope.participantId;
 const fromMs=Date.parse(input.pin.scope.fromDay+'T00:00:00.000Z');
 const throughMs=input.pin.scope.throughDay===undefined?null:Date.parse(input.pin.scope.throughDay+'T00:00:00.000Z')+86_400_000;
 const servingCurrent=async()=>!!await readEffectiveDependencySourceFence(source,'typed-v1-analysis')&&await stillCurrent();
 const stillCurrent=async()=>{
  if(!available(6))return false;
  await assertV1SourcePinCurrent(source,input.pin);
  return !await source.prepare('SELECT 1 FROM telemetry_v11_domain_heads WHERE participant_id=? LIMIT 1').bind(participantId).first();
 };
 let context:CanonicalInputReadContext|null=null,lastScope:CanonicalInputScope|undefined;
 const preparationCurrent=async()=>!context||!!lastScope&&await canonicalInputReadContextCurrent(source,target,lastScope,context);
 try{
  if(!available(40))return result('deferred','query_budget');
  if(!await canonicalRollingInputsAvailable(target))return result('unavailable','migration_required');
  if(!await loadTypedV1AnalysisScope(source,participantId))return result('unavailable','typed_source_unavailable');
  const method=await canonicalRollingMethodDigest();
  const key=await sha256Hex(canonicalJson([method,input.sourceId,input.ownerDigest,input.kind,fromMs,throughMs,input.pin.fingerprint]));
  const old=await target.prepare('SELECT state FROM analytics_canonical_rolling_windows WHERE window_key=?').bind(key).first<{state:string}>();
  // Complete windows consume persisted native inputs. They need the live
  // native pin and rolling read guard, not the acquisition/pricing schemas or
  // a cold-path retirement write on every reuse.
  if(old?.state==='complete'){
   const reader=await createCanonicalV1RollingReader(target,key,input.pin.fingerprint,servingCurrent);
   return {state:'ready',windowKey:key,reader,queriesUsed:meter.queriesUsed};
  }
  if(old?.state==='dirty')return result('deferred','source_changed');
  if(!await canonicalAnalyticsAvailable(target)||!await canonicalFeatureContributionsAvailable(target)
   ||!await effectiveSelectiveSchemaAvailable(source))return result('unavailable','migration_required');
  if(!await stillCurrent())return result('deferred','source_changed');
  // A fresh native proof can retire abandoned preparation of this exact
  // window. Complete generations retain their consumer references.
  await target.prepare(`UPDATE analytics_canonical_rolling_windows SET state='dirty' WHERE source_id=? AND owner_digest=?
   AND kind=? AND from_ms=? AND through_ms IS ? AND native_dependency!=? AND state='building'`)
   .bind(input.sourceId,input.ownerDigest,input.kind,fromMs,throughMs,input.pin.fingerprint).run();
  const days=[...new Set(input.pin.winners.map(winner=>winner.observed_day))].sort();
  await target.prepare(`INSERT INTO analytics_canonical_rolling_windows(window_key,source_id,owner_digest,kind,from_ms,through_ms,
   native_dependency,method_digest,state,member_count) VALUES(?,?,?,?,?,?,?,?,'building',?) ON CONFLICT(window_key) DO NOTHING`)
   .bind(key,input.sourceId,input.ownerDigest,input.kind,fromMs,throughMs,input.pin.fingerprint,method,days.length*2).run();
  const done=(await target.prepare(`SELECT s.day,s.stream,s.state FROM analytics_canonical_rolling_members m
   JOIN analytics_canonical_rolling_segments s ON s.segment_key=m.segment_key WHERE m.window_key=?`).bind(key)
   .all<{day:string;stream:string;state:string}>()).results;
  if(done.some(row=>row.state!=='complete'))return result('deferred','source_changed');
  const requested=days.flatMap(day=>['quota','usage'].map(stream=>({day,stream:stream as 'quota'|'usage'})));
  const finish=async():Promise<CanonicalV1WindowReadiness>=>{
   if(!available(24)||!await preparationCurrent()||!await servingCurrent())return result('deferred','source_changed_or_budget');
   await target.prepare("UPDATE analytics_canonical_rolling_windows SET state='complete' WHERE window_key=? AND state='building'").bind(key).run();
   const reader=await createCanonicalV1RollingReader(target,key,input.pin.fingerprint,servingCurrent);
   return {state:'ready',windowKey:key,reader,queriesUsed:meter.queriesUsed};
  };
  const pending=requested.filter(value=>!done.some(row=>row.day===value.day&&row.stream===value.stream)).slice(0,8);
  context=pending.length?await createCanonicalInputReadContext(source,target,pending.map(next=>({sourceId:input.sourceId,
   sourceNamespace:input.sourceNamespace,ownerDigest:input.ownerDigest,participantId,...next,
   selectionMethod:'legacy-selected-v1'})),input.deadlineMs):null;
  if(pending.length&&!context){
   if(available(100))await advanceEffectiveDependencyCoverage(source,{sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,
    participantId,maxSteps:32,maxRows:128,budget:meter});
   return result('deferred','canonical_input_pending');
  }
  // One invocation can finish several small or empty segments. Large segments
  // still checkpoint through P1's bounded pages and the same actual meter.
  for(let advanced=0;advanced<8;advanced++){
   const next=requested.find(value=>!done.some(row=>row.day===value.day&&row.stream===value.stream));
   if(!next)return await finish();
   if(!available(180))return result('deferred','query_budget');
   const scope:CanonicalInputScope={sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,ownerDigest:input.ownerDigest,
    participantId,...next,selectionMethod:'legacy-selected-v1'};
   lastScope=scope;
   let seal=await readCanonicalInputPreparationSeal(source,target,scope,context!);
   if(!seal){
    const prepared=await advanceCanonicalInputWork(input.source,input.target,{...scope,context:context??undefined,budget:{meter,maxSteps:32,deadlineMs:input.deadlineMs,now}});
    seal=prepared.seal;
    if(!seal){
     if(prepared.state==='unavailable'&&available(100))await advanceEffectiveDependencyCoverage(source,
      {sourceId:input.sourceId,sourceNamespace:input.sourceNamespace,participantId,maxSteps:32,maxRows:128,budget:meter});
     return result('deferred','canonical_input_pending');
    }
   }
   if(next.stream==='usage'){
    if(!available(100))return result('deferred','query_budget');
    const missing=(await target.prepare(`SELECT f.revision,f.occurrence_key AS occurrenceKey FROM analytics_canonical_input_seen i
     JOIN analytics_canonical_heads h ON h.occurrence_key=i.occurrence_key AND h.selection_method='legacy-selected-v1'
     JOIN analytics_canonical_facts f ON f.revision=h.revision WHERE i.scope_key=? AND NOT EXISTS(
      SELECT 1 FROM analytics_canonical_feature_prices p WHERE p.fact_revision=f.revision AND p.family='fit' AND p.method_digest=?)
     ORDER BY f.observed_at_ms,f.native_order LIMIT 128`)
     .bind(seal.scopeKey,await canonicalPriceMethodDigest(CANONICAL_FIT_PRICE_METHOD)).all<{revision:string;occurrenceKey:string}>()).results;
    if(missing.length){
     const products=await materializeCanonicalFeatureRows({target,refs:missing,
      budget:{remainingQueries:()=>meter.remainingQueries,now,deadlineMs:input.deadlineMs},stillCurrent,
      methods:[CANONICAL_FIT_PRICE_METHOD]});
     if(products.state!=='complete')return result('deferred',products.reason);
    }
   }
   const segment=await advanceCanonicalRollingSegment({target,sourceId:input.sourceId,ownerDigest:input.ownerDigest,
    selectionMethod:'legacy-selected-v1',seal,budget:{remainingQueries:()=>meter.remainingQueries,now,deadlineMs:input.deadlineMs},stillCurrent});
   if(segment.state!=='complete')return result('deferred',segment.state==='progress'?'rolling_segment_progress':segment.reason);
   if(!available(12)||!await stillCurrent())return result('deferred','source_changed_or_budget');
   await target.prepare(`INSERT INTO analytics_canonical_rolling_members(window_key,segment_key) VALUES(?,?)
    ON CONFLICT(window_key,segment_key) DO NOTHING`).bind(key,segment.segment.key).run();
   done.push({...next,state:'complete'});
  }
  if(done.length===requested.length)return await finish();
  if(!await preparationCurrent())return result('deferred','source_changed');
  return result('deferred','rolling_window_progress');
 }catch(error){if(error instanceof D1InvocationBudgetExceededError)return result('deferred','query_budget');throw error;}
 finally{if(context)closeCanonicalInputReadContext(context);}
}

/** Concrete P8 executor for a persisted rolling-window request. The caller
 * supplies its source binding and resolved active owner; request metadata is
 * loaded from the admitted store and its native dependency is proved again. */
export async function executeCanonicalV1WindowRequest(input:CanonicalV1Pipeline&{
 source:D1Database;participantId:string;windowKey:string;maxQueries:number;deadlineMs:number;now?:()=>number;
}):Promise<{state:'complete'|'deferred'|'refused';reason?:string;queriesUsed:number}> {
 const now=input.now??Date.now,meter=createD1InvocationBudget(input.maxQueries);
 const source=meter.wrap(input.source),target=meter.wrap(input.target);
 const result=(state:'complete'|'deferred'|'refused',reason?:string)=>({state,...(reason?{reason}:{}),queriesUsed:meter.queriesUsed});
 if(!/^[a-f0-9]{64}$/u.test(input.windowKey))throw new Error('CANONICAL_V1_WINDOW_REQUEST');
 if(meter.remainingQueries<48||now()>=input.deadlineMs-1500)return result('deferred','query_budget');
 try {
  if(!await canonicalRollingInputsAvailable(target))return result('refused','migration_required');
  const request=await target.prepare(`SELECT kind,from_ms,through_ms,native_dependency,state FROM analytics_canonical_rolling_windows
   WHERE window_key=? AND source_id=? AND owner_digest=?`).bind(input.windowKey,input.sourceId,input.ownerDigest)
   .first<{kind:string;from_ms:number;through_ms:number|null;native_dependency:string;state:string}>();
  if(!request||request.state==='dirty')return result('refused','request_retired');
  if(request.kind!=='legacy-model'&&request.kind!=='legacy-scalar')return result('refused','native_family');
  const pin=await loadV1SourcePin(source,{participantId:input.participantId,
   fromDay:new Date(request.from_ms).toISOString().slice(0,10),
   ...(request.through_ms===null?{}:{throughDay:new Date(request.through_ms-1).toISOString().slice(0,10)})});
  if(pin.fingerprint!==request.native_dependency)return result('refused','source_changed');
  if(meter.remainingQueries<40)return result('deferred','query_budget');
  const prepared=await advanceCanonicalV1Window({...input,source,target,pin,kind:request.kind,
   maxQueries:Math.min(950,meter.remainingQueries)});
  if(prepared.state==='ready')return prepared.windowKey===input.windowKey?result('complete'):result('refused','request_changed');
  return result(prepared.state==='deferred'?'deferred':'refused',prepared.reason);
 } catch(error) {if(error instanceof D1InvocationBudgetExceededError)return result('deferred','query_budget');throw error;}
}
