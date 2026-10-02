/** Native quota/usage preparation over closed canonical facts. Pricing is an
 * explicit P4 product; this module never decodes or reconstructs source JSON. */
import { parseTelemetryV11Attribution } from '@app-usagemonitor/telemetry-contract';
import { canonicalJson } from './canonical-json';
import { canonicalDay, canonicalDigest, compareCanonicalFacts, type CanonicalFact } from './canonical-analytics-facts';
import { validateCanonicalFact } from './storage-canonical-analytics-facts';
import { CANONICAL_FIT_PRICE_METHOD, validCanonicalPriceProduct, type CanonicalPriceProduct } from './canonical-feature-contributions';
import { prepareV11UsageFeatureWithSession, v11PreparedUsageDayRow,
  type V11PreparedUsageFeature, type V11UsageRowInputs, type UsageRow } from './quota-analysis-v11';
import { appendEffectiveQuotaDay, finishEffectiveQuotaDay, type EffectiveQuotaDay } from './effective-quota-day';
import { type EffectiveUsageDay } from './effective-usage-day';
import { GraphDayProjectionRefusedError, reduceGraphDayProjection, type GraphDayUsageInput } from './graph-day-projection';
import { GRAPH_DAY_USAGE_SESSION_LIMIT } from './graph-day-projection-values';
import type { V11QuotaPageRow } from './typed-v11-quota-reader';

export const CANONICAL_ROLLING_INPUT_METHOD='canonical-rolling-inputs-v1';
export const CANONICAL_ROLLING_DAY_ROWS=6_000;
export class CanonicalRollingRefused extends Error {
  constructor(readonly reason:string){super(`CANONICAL_ROLLING_REFUSED:${reason}`);}
}
const refuse=(reason:string):never=>{throw new CanonicalRollingRefused(reason);};
/** Surrogate preserves the native lexical tie order without retaining source
 * occurrence IDs. The same-time rank is stable across canonical partitions. */
export function canonicalRollingOccurrenceId(fact:CanonicalFact):string {
  return `canonical:${String(fact.location.nativeOrder).padStart(16,'0')}:${fact.occurrenceKey}`;
}
export async function validateCanonicalRollingFact(fact:CanonicalFact):Promise<void> {
  await validateCanonicalFact(fact);
  if(fact.status!=='compatible'||fact.provenance.coverage!=='complete'||fact.location.day===null
    ||fact.location.observedAtMs===null||fact.values.provider===null)refuse('canonical_unavailable');
}
/** Quota rows still enter the native day reducer, which alone owns plan/reset
 * admission, DROP semantics and endpoint run collapse. */
export function canonicalEffectiveQuotaRow(fact:CanonicalFact,ordinal:number,options:{nativeIdentity?:boolean}={}):V11QuotaPageRow {
  if(fact.stream!=='quota'||fact.location.day===null||fact.location.observedAtMs===null
    ||!Number.isSafeInteger(ordinal)||ordinal<1)refuse('invalid_quota');
  const value=fact.values,scope=fact.nativeScopes,at=fact.location.observedAtMs!;
  if(options.nativeIdentity&&!scope.quotaOccurrenceId)refuse('quota_native_identity_unavailable');
  const attribution=parseTelemetryV11Attribution({accountBasis:fact.accountBasis,accountTrackId:scope.accountTrackId,
    planBasis:fact.planBasis,planType:value.attributionPlanType??'unknown',planEraId:scope.planEraId});
  return {physicalId:ordinal,sourceRowId:ordinal,observedAtMs:at,
    active:{id:ordinal,observedAtMs:at,observedAt:new Date(at).toISOString(),observedDay:fact.location.day!,
      deviceId:'effective-owner',provider:value.provider!,limitId:value.limitId,planType:value.planType??'unknown',
      planVariant:value.planVariant,accountBasis:attribution.accountBasis,accountTrackId:attribution.accountTrackId,
      planBasis:attribution.planBasis,planEraId:attribution.planEraId,occurrenceId:options.nativeIdentity?scope.quotaOccurrenceId!:canonicalRollingOccurrenceId(fact),
      slot:value.slot,usedPercent:value.usedPercent,windowDurationMinutes:value.windowDurationMinutes,
      resetsAt:value.resetsAtMs===null?null:new Date(value.resetsAtMs).toISOString(),resetsAtMs:value.resetsAtMs}};
}
export function canonicalEffectiveUsageInputs(fact:CanonicalFact,price:CanonicalPriceProduct):{
  row:UsageRow;inputs:V11UsageRowInputs;
} {
  if(fact.stream!=='usage'||fact.location.observedAtMs===null||fact.values.provider===null
    ||!validCanonicalPriceProduct(price)||price.factRevision!==fact.revision||price.method.family!=='fit'
    ||canonicalJson(price.method)!==canonicalJson(CANONICAL_FIT_PRICE_METHOD))refuse('invalid_fit_price');
  const scopes=fact.nativeScopes,at=fact.location.observedAtMs!,provider=fact.values.provider!;
  const attribution=parseTelemetryV11Attribution({accountBasis:fact.accountBasis,accountTrackId:scopes.accountTrackId,
    planBasis:fact.planBasis,planType:fact.values.attributionPlanType??'unknown',planEraId:scopes.planEraId});
  if(scopes.scalarSessionDigest===null||scopes.graphSessionDigest===null)refuse('session_scope_unavailable');
  // This transient shape supplies native metadata only. Every decoder/pricer
  // receives prevalidated evidence, so record_json is intentionally empty.
  const row:UsageRow={occurrence_id:canonicalRollingOccurrenceId(fact),observed_at:new Date(at).toISOString(),
    provider,session_uuid:scopes.scalarSessionDigest,record_json:''};
  const inputs:V11UsageRowInputs={evidence:{attribution,end:at,
    scope:attribution.accountBasis==='same_source'?attribution.accountTrackId:null,
    sessionKey:scopes.scalarSessionDigest},price:()=>price.value};
  return {row,inputs};
}
export interface CanonicalRollingDay {
  readonly quota:EffectiveQuotaDay;
  readonly modelUsage:EffectiveUsageDay;
  readonly scalarUsage:readonly V11PreparedUsageFeature[];
}
/** Complete day assembly from bounded P4 partitions. All streams must belong to
 * one selection method and owner. Caller proves completeness and seals B02. */
export async function prepareCanonicalRollingDay(input:{day:string;ownerDigest:string;
  facts:readonly CanonicalFact[];prices:readonly CanonicalPriceProduct[]}):Promise<CanonicalRollingDay> {
  canonicalDay(input.day);canonicalDigest(input.ownerDigest);
  if(input.facts.length>CANONICAL_ROLLING_DAY_ROWS)refuse('day_row_limit');
  const facts=[...input.facts].sort(compareCanonicalFacts),seen=new Set<string>(),erasureKeys=new Set<string>();
  for(const fact of facts){
    await validateCanonicalRollingFact(fact);
    if(fact.location.day!==input.day||seen.has(fact.occurrenceKey))refuse('invalid_day_membership');
    seen.add(fact.occurrenceKey);erasureKeys.add(fact.provenance.erasureKey);
    if(fact.provenance.selectionMethod!=='effective-union-v1')refuse('legacy_reader_required');
  }
  if(erasureKeys.size>1)refuse('owner_scope_mismatch');
  const quotaRows=facts.filter(fact=>fact.stream==='quota').map((fact,index)=>canonicalEffectiveQuotaRow(fact,index+1));
  const pending=appendEffectiveQuotaDay(null,input.day,quotaRows,10_080);
  const quota=pending===null?undefined:finishEffectiveQuotaDay(pending);
  if(quota===undefined)refuse('quota_day_limit');
  const events:GraphDayUsageInput[]=[],scalarUsage:V11PreparedUsageFeature[]=[],sessions=new Set<string>();
  const prices=new Map<string,CanonicalPriceProduct>();
  for(const price of input.prices)if(price.method.family==='fit'){
    if(prices.has(price.factRevision))refuse('duplicate_fit_price');prices.set(price.factRevision,price);
  }
  const usage=facts.filter(fact=>fact.stream==='usage');
  for(const fact of usage){
    const price=prices.get(fact.revision);if(price===undefined)refuse('missing_fit_price');
    const {row,inputs}=canonicalEffectiveUsageInputs(fact,price!);
    scalarUsage.push(await prepareV11UsageFeatureWithSession(row,async()=>fact.nativeScopes.scalarSessionDigest!,inputs));
    const mapped=await v11PreparedUsageDayRow(row,async()=>fact.nativeScopes.graphSessionDigest!,sessions,
      GRAPH_DAY_USAGE_SESSION_LIMIT,inputs);
    if(mapped.status==='refused')refuse(mapped.reason);
    if(mapped.status==='row')events.push({...mapped.row,kind:mapped.row.model===null?'unpriced':'priced'});
    else if(mapped.status==='skipped'&&mapped.session!==null)events.push({...mapped.session,provider:row.provider,
      planBasis:null,planType:null,planEraId:null,kind:'unmeasurable',model:null,costNanousd:0});
  }
  try{return {quota:quota!,modelUsage:{projection:reduceGraphDayProjection(input.day,[],{events,rowsRead:usage.length})},scalarUsage};}
  catch(error){if(error instanceof GraphDayProjectionRefusedError)refuse(error.reason);throw error;}
}
