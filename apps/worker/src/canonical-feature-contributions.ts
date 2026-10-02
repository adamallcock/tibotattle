/** Closed, price-independent occurrence contributions and separate native price
 * products. Canonical fact identity owns deduplication; equal quantities do not. */
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { canonicalDay,
  type CanonicalFact, type CanonicalSelectionMethod } from './canonical-analytics-facts';
import { validateCanonicalFact } from './storage-canonical-analytics-facts';
import { priceChunkUsageRecordValue } from './quota-analysis-v1';
import { COMMUNITY_DAILY_SPEND_PRICING_METHOD, COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 } from './community-daily-spend';
import { COMPOSITION_CACHE_KEY_SUFFIX } from './community-allowance';
import { createV11DailyProjectionValues, foldV11DailyContribution, v11DailyPricingContribution,
  v11DailyTokenQuantities, type V11DailyTokens, type V11DailyProjectionValues } from './v11-daily-projection-values';

export const CANONICAL_FEATURE_QUANTITY_METHOD='canonical-feature-quantities-v1' as const;
export const CANONICAL_ACTIVITY_METHOD='canonical-activity-contributions-v1' as const;
export const CANONICAL_FEATURE_MAX_PARTITION_ROWS=128;
const COMPONENTS=['inputUncachedTokens','inputCacheReadTokens','inputCacheWriteTokens',
  'outputTextTokens','outputReasoningTokens','outputCombinedTokens'] as const;
const LABELS=['provider','modelId','speedMode','apiServiceTier','billingSurface','reasoningEffort'] as const;
const HASH=/^[a-f0-9]{64}$/u, TOKEN=/^[A-Za-z0-9._:-]{1,64}$/u;
export class CanonicalFeatureRefused extends Error {
  constructor(readonly reason:string){super(`CANONICAL_FEATURE_REFUSED:${reason}`);}
}
const refuse=(reason:string):never=>{throw new CanonicalFeatureRefused(reason);};
const closed=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>
  !!value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export interface CanonicalPriceInput {
  readonly provider:string;readonly modelId:string;readonly speedMode:string|null;
  readonly apiServiceTier:string|null;readonly billingSurface:string|null;readonly reasoningEffort:string|null;
  readonly totalInputContextTokens:number|null;
  readonly components:Readonly<Record<typeof COMPONENTS[number],number|null>>;
}
/** Explicit role metadata from the source selection adapter. Device keys mean
 * selected upload credentials under the native daily metric, never hardware.
 * The dependency revision includes linkage changes even if arithmetic is equal. */
export interface CanonicalActivityMembership {
  readonly method:string;readonly dependencyRevision:string;
  readonly contributorKey:string;readonly deviceKeys:readonly string[];
}
export interface CanonicalFeatureContribution {
  readonly schema:typeof CANONICAL_FEATURE_QUANTITY_METHOD;
  readonly factRevision:string;readonly occurrenceKey:string;readonly erasureKey:string;
  readonly selectionMethod:CanonicalSelectionMethod;readonly stream:CanonicalFact['stream'];
  readonly day:string;readonly observedAtMs:number;readonly orderScopeKey:string;readonly nativeOrder:number;
  readonly provider:string;readonly modelId:string|null;readonly sessionKey:string|null;
  readonly tokens:V11DailyTokens|null;readonly pricingInput:CanonicalPriceInput|null;
  readonly tools:readonly {readonly toolClass:string;readonly count:number}[];
}
export interface CanonicalPriceMethod {
  readonly family:'daily'|'fit';readonly methodVersion:string;readonly registrySha256:string;
}
export const CANONICAL_DAILY_PRICE_METHOD:CanonicalPriceMethod=Object.freeze({family:'daily',
  methodVersion:COMMUNITY_DAILY_SPEND_PRICING_METHOD,registrySha256:COMMUNITY_DAILY_SPEND_REGISTRY_SHA256});
export const CANONICAL_FIT_PRICE_METHOD:CanonicalPriceMethod=Object.freeze({family:'fit',
  methodVersion:COMPOSITION_CACHE_KEY_SUFFIX,registrySha256:COMMUNITY_DAILY_SPEND_REGISTRY_SHA256});
export interface CanonicalPriceProduct {
  readonly factRevision:string;readonly method:CanonicalPriceMethod;
  readonly value:ReturnType<typeof priceChunkUsageRecordValue>;
}
export function validCanonicalMembership(value:unknown):value is CanonicalActivityMembership {
  return closed(value,['method','dependencyRevision','contributorKey','deviceKeys'])
    &&typeof value.method==='string'&&/^[A-Za-z0-9._:-]{1,128}$/u.test(value.method)
    &&HASH.test(String(value.dependencyRevision))&&HASH.test(String(value.contributorKey))
    &&Array.isArray(value.deviceKeys)&&value.deviceKeys.length>0&&value.deviceKeys.length<=128
    &&value.deviceKeys.every((key,index,keys)=>typeof key==='string'&&HASH.test(key)
      &&(index===0||keys[index-1]<key));
}
export function validCanonicalPriceMethod(value:unknown):value is CanonicalPriceMethod {
  return closed(value,['family','methodVersion','registrySha256'])
    &&(value.family==='daily'||value.family==='fit')&&typeof value.methodVersion==='string'
    &&value.methodVersion.length>0&&value.methodVersion.length<=512&&HASH.test(String(value.registrySha256));
}
export async function canonicalPriceMethodDigest(method:CanonicalPriceMethod):Promise<string> {
  if(!validCanonicalPriceMethod(method))refuse('invalid_price_method');
  return sha256Hex(canonicalJson(method));
}
export function validCanonicalPriceProduct(value:unknown):value is CanonicalPriceProduct {
  if(!closed(value,['factRevision','method','value'])||!HASH.test(String(value.factRevision))
    ||!validCanonicalPriceMethod(value.method))return false;
  const price=value.value;
  return price===null||closed(price,['costNanousd','pricingStatus','modelId'])
    &&Number.isSafeInteger(price.costNanousd)&&(price.costNanousd as number)>=0
    &&['fully_priced','partially_priced','unpriced'].includes(String(price.pricingStatus))
    &&(price.modelId===null||typeof price.modelId==='string'&&TOKEN.test(price.modelId));
}
export function validCanonicalFeatureContribution(value:unknown):value is CanonicalFeatureContribution {
  if(!closed(value,['schema','factRevision','occurrenceKey','erasureKey','selectionMethod','stream','day',
    'observedAtMs','orderScopeKey','nativeOrder','provider','modelId','sessionKey','tokens','pricingInput','tools'])
    ||value.schema!==CANONICAL_FEATURE_QUANTITY_METHOD
    ||![value.factRevision,value.occurrenceKey,value.erasureKey,value.orderScopeKey].every(key=>HASH.test(String(key)))
    ||!['effective-union-v1','legacy-selected-v1'].includes(String(value.selectionMethod))
    ||!['usage','quota','session'].includes(String(value.stream))
    ||typeof value.provider!=='string'||!TOKEN.test(value.provider)
    ||!Number.isSafeInteger(value.observedAtMs)||!Number.isSafeInteger(value.nativeOrder)||(value.nativeOrder as number)<0
    ||value.sessionKey!==null&&!HASH.test(String(value.sessionKey))
    ||!Array.isArray(value.tools)||value.tools.length>256
    ||!value.tools.every((tool,index,tools)=>closed(tool,['toolClass','count'])&&typeof tool.toolClass==='string'
      &&TOKEN.test(tool.toolClass)&&Number.isSafeInteger(tool.count)&&(tool.count as number)>=0
      &&(index===0||tools[index-1].toolClass<tool.toolClass)))return false;
  try {
    canonicalDay(value.day);
    if(new Date(value.observedAtMs as number).toISOString().slice(0,10)!==value.day)return false;
    if(value.stream!=='usage')return value.modelId===null&&value.tokens===null&&value.pricingInput===null
      &&(value.stream==='session'||value.tools.length===0);
    if(typeof value.modelId!=='string'||!TOKEN.test(value.modelId)||value.tools.length!==0)return false;
    const input=value.pricingInput;
    if(!closed(input,[...LABELS,'totalInputContextTokens','components'])
      ||input.provider!==value.provider||input.modelId!==value.modelId
      ||LABELS.some(key=>input[key]!==null&&(typeof input[key]!=='string'||!TOKEN.test(input[key] as string)))
      ||input.totalInputContextTokens!==null&&(!Number.isSafeInteger(input.totalInputContextTokens)||(input.totalInputContextTokens as number)<0)
      ||!closed(input.components,COMPONENTS))return false;
    const quantities=v11DailyTokenQuantities(input.components as CanonicalPriceInput['components']);
    return canonicalJson(value.tokens)===canonicalJson(quantities);
  } catch{return false;}
}
export async function prepareCanonicalFeatureContribution(fact:CanonicalFact):Promise<CanonicalFeatureContribution> {
  await validateCanonicalFact(fact);
  if(fact.status!=='compatible'||fact.location.day===null||fact.location.observedAtMs===null
    ||fact.provenance.coverage!=='complete')refuse('canonical_unavailable');
  const values=fact.values;
  if(values.provider===null||fact.stream==='usage'&&values.modelId===null)refuse('canonical_unavailable');
  const components=Object.fromEntries(COMPONENTS.map(key=>[key,values[key]])) as CanonicalPriceInput['components'];
  const pricingInput:CanonicalPriceInput|null=fact.stream==='usage'?{
    provider:values.provider!,modelId:values.modelId!,speedMode:values.speedMode,apiServiceTier:values.apiServiceTier,
    billingSurface:values.billingSurface,reasoningEffort:values.reasoningEffort,
    totalInputContextTokens:values.totalInputContextTokens,components}:null;
  const value:CanonicalFeatureContribution={schema:CANONICAL_FEATURE_QUANTITY_METHOD,
    factRevision:fact.revision,occurrenceKey:fact.occurrenceKey,erasureKey:fact.provenance.erasureKey,
    selectionMethod:fact.provenance.selectionMethod,stream:fact.stream,day:fact.location.day!,
    observedAtMs:fact.location.observedAtMs!,orderScopeKey:fact.location.orderScopeKey,nativeOrder:fact.location.nativeOrder,
    provider:values.provider!,modelId:fact.stream==='usage'?values.modelId:null,sessionKey:values.sessionKey,
    tokens:fact.stream==='usage'?v11DailyTokenQuantities(components):null,pricingInput,tools:fact.toolCounts};
  if(!validCanonicalFeatureContribution(value))refuse('invalid_contribution');
  return Object.freeze(value);
}
/** The injectable pricing implementation must carry its own method identity.
 * Calls remain per occurrence, preserving integer rounding and context bands. */
export function priceCanonicalFeatureContribution(value:CanonicalFeatureContribution,method:CanonicalPriceMethod,
  price:typeof priceChunkUsageRecordValue=priceChunkUsageRecordValue):CanonicalPriceProduct {
  if(!validCanonicalFeatureContribution(value)||!validCanonicalPriceMethod(method))refuse('invalid_contribution');
  if(value.stream!=='usage'||value.pricingInput===null)refuse('not_usage');
  const result:CanonicalPriceProduct={factRevision:value.factRevision,method,
    value:price({...value.pricingInput},new Date(value.observedAtMs).toISOString())};
  if(!validCanonicalPriceProduct(result))refuse('invalid_price');
  return result;
}
export interface CanonicalActivityInput {
  readonly contribution:CanonicalFeatureContribution;readonly dailyPrice:CanonicalPriceProduct|null;
  readonly membership:CanonicalActivityMembership|null;
}
export interface CanonicalActivityContribution {
  readonly method:typeof CANONICAL_ACTIVITY_METHOD;readonly day:string;readonly selectionMethod:CanonicalSelectionMethod;
  readonly daily:V11DailyProjectionValues;
  readonly lastTimeCandidates:readonly {readonly factRevision:string;readonly observedAtMs:number}[];
  readonly lastObservedAtMs:number|null;
  readonly membershipCoverage:'complete'|'unknown';
  readonly members:readonly {readonly role:'contributor'|'device'|'session';readonly key:string;readonly references:number}[];
  readonly contributingParticipants:number|null;readonly contributingDevices:number|null;
  readonly tools:readonly {readonly toolClass:string;readonly count:string}[];
}
/** Call only for a complete disjoint union of partition contributions. Replaying
 * the same revision is idempotent; competing revisions refuse before any sum.
 * Candidates/references remain exact so withdrawal can reveal the next maximum.
 * No median, percentile or fit weight is reduced into an additive statistic. */
export function foldCanonicalActivityContributions(day:string,selectionMethod:CanonicalSelectionMethod,
  inputs:readonly CanonicalActivityInput[]):CanonicalActivityContribution {
  canonicalDay(day);
  if(!['effective-union-v1','legacy-selected-v1'].includes(selectionMethod)||inputs.length>6000)refuse('activity_limit');
  const unique=new Map<string,CanonicalActivityInput>();
  for(const input of inputs) {
    const value=input.contribution;
    if(!validCanonicalFeatureContribution(value)||value.day!==day||value.selectionMethod!==selectionMethod
      ||input.membership!==null&&!validCanonicalMembership(input.membership))refuse('invalid_activity');
    const prior=unique.get(value.occurrenceKey);
    if(prior&&canonicalJson(prior)!==canonicalJson(input))refuse('overlapping_revisions');
    unique.set(value.occurrenceKey,input);
  }
  let daily=createV11DailyProjectionValues(day),membershipCoverage:CanonicalActivityContribution['membershipCoverage']='complete';
  const candidates:CanonicalActivityContribution['lastTimeCandidates'][number][]=[];
  const members=new Map<string,{role:'contributor'|'device'|'session';key:string;references:number}>();
  const add=(role:'contributor'|'device'|'session',key:string)=>{
    const id=JSON.stringify([role,key]),prior=members.get(id);
    members.set(id,{role,key,references:(prior?.references??0)+1});
  };
  const tools=new Map<string,bigint>();
  for(const {contribution:value,dailyPrice,membership} of [...unique.values()].sort((a,b)=>
    a.contribution.observedAtMs-b.contribution.observedAtMs||a.contribution.orderScopeKey.localeCompare(b.contribution.orderScopeKey)
      ||a.contribution.nativeOrder-b.contribution.nativeOrder||a.contribution.occurrenceKey.localeCompare(b.contribution.occurrenceKey))) {
    if(value.stream==='usage'&&(!dailyPrice||!validCanonicalPriceProduct(dailyPrice)
      ||dailyPrice.factRevision!==value.factRevision||canonicalJson(dailyPrice.method)!==canonicalJson(CANONICAL_DAILY_PRICE_METHOD))
      ||value.stream!=='usage'&&dailyPrice!==null)refuse('daily_price_unavailable');
    daily=foldV11DailyContribution(daily,{stream:value.stream,provider:value.provider,modelId:value.modelId,
      tokens:value.tokens,pricing:value.stream==='usage'?v11DailyPricingContribution(dailyPrice!.value):null});
    candidates.push({factRevision:value.factRevision,observedAtMs:value.observedAtMs});
    if(membership===null)membershipCoverage='unknown';
    else {add('contributor',membership.contributorKey);for(const key of membership.deviceKeys)add('device',key);}
    if(value.sessionKey!==null)add('session',value.sessionKey);
    for(const tool of value.tools)tools.set(tool.toolClass,(tools.get(tool.toolClass)??0n)+BigInt(tool.count));
  }
  const orderedMembers=[...members.values()].sort((a,b)=>a.role.localeCompare(b.role)||a.key.localeCompare(b.key));
  candidates.sort((a,b)=>b.observedAtMs-a.observedAtMs||a.factRevision.localeCompare(b.factRevision));
  return {method:CANONICAL_ACTIVITY_METHOD,day,selectionMethod,daily,lastTimeCandidates:candidates,
    lastObservedAtMs:candidates[0]?.observedAtMs??null,membershipCoverage,members:orderedMembers,
    contributingParticipants:membershipCoverage==='unknown'?null:orderedMembers.filter(row=>row.role==='contributor').length,
    contributingDevices:membershipCoverage==='unknown'?null:orderedMembers.filter(row=>row.role==='device').length,
    tools:[...tools].sort(([a],[b])=>a.localeCompare(b)).map(([toolClass,count])=>({toolClass,count:String(count)}))};
}
