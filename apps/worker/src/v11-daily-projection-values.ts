import { canonicalTelemetryV11Json } from '@app-usagemonitor/telemetry-contract';
import { encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords } from './typed-telemetry-codec';
import { priceChunkUsageRecord } from './quota-analysis-v1';
import { COMMUNITY_DAILY_SPEND_PRICING_METHOD, COMMUNITY_DAILY_SPEND_REGISTRY_SHA256 } from './community-daily-spend';

export const V11_DAILY_VALUES_SCHEMA = 'v11-daily-projection-values-v1';
export const MAX_V11_DAILY_FOLD_RECORDS = 200;
export const MAX_V11_DAILY_VALUES_RECORDS = 6_000_000;
export const MAX_V11_DAILY_MODEL_CELLS = 100;
const COMPONENTS = ['inputUncachedTokens','inputCacheReadTokens','inputCacheWriteTokens',
  'outputTextTokens','outputReasoningTokens','outputCombinedTokens'] as const;
const TOKEN_KEYS = [...COMPONENTS,'effectiveOutput','nonOverlappingTotal'] as const;
type TokenKey = typeof TOKEN_KEYS[number];
/** knownSum includes known portions even when some events are incomplete.
 * unavailable counts events with any unknown portion for this field.
 * outputCombinedTokens is the raw component; effectiveOutput alone applies
 * combined-or-split fallback. Only nonOverlappingTotal sums input plus output. */
export interface ExactTokenSum { knownSum: string; unavailable: number }
type Tokens = Record<TokenKey, ExactTokenSum>;
interface Pricing { knownNanousd: string; fullyPriced: number; partiallyPriced: number; unpriced: number }
export interface V11DailyModelCell { provider: string; modelId: string; usageEvents: number; tokens: Tokens; pricing: Pricing }
export interface V11DailyProjectionValues {
  schemaVersion: typeof V11_DAILY_VALUES_SCHEMA; day: string;
  pricingMethodVersion: string; registrySha256: string;
  counts: { usage: number; quota: number; session: number };
  tokens: Tokens; pricing: Pricing; cells: V11DailyModelCell[];
}
function fail(): never { throw new Error('V11_DAILY_PROJECTION_VALUES_INVALID'); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail();
}
function count(value: unknown, max = MAX_V11_DAILY_VALUES_RECORDS): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail();
}
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,24})$/.test(value)) fail();
  return BigInt(value);
}
function validDay(day: unknown): asserts day is string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))
    || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0,10) !== day) fail();
}
function token(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) fail();
}
function zeroTokens(): Tokens {
  return Object.fromEntries(TOKEN_KEYS.map(key=>[key,{knownSum:'0',unavailable:0}])) as Tokens;
}
function zeroPricing(): Pricing { return {knownNanousd:'0',fullyPriced:0,partiallyPriced:0,unpriced:0}; }
function addTokens(a: Tokens, b: Tokens): Tokens {
  return Object.fromEntries(TOKEN_KEYS.map(key=>[key, {
    knownSum:(decimal(a[key].knownSum)+decimal(b[key].knownSum)).toString(),
    unavailable:a[key].unavailable+b[key].unavailable,
  }])) as Tokens;
}
function addPricing(a: Pricing, b: Pricing): Pricing {
  return {knownNanousd:(decimal(a.knownNanousd)+decimal(b.knownNanousd)).toString(),
    fullyPriced:a.fullyPriced+b.fullyPriced,partiallyPriced:a.partiallyPriced+b.partiallyPriced,unpriced:a.unpriced+b.unpriced};
}
function validateTokens(value: unknown, usage: number): asserts value is Tokens {
  closed(value,TOKEN_KEYS);
  for (const key of TOKEN_KEYS) {
    const entry=value[key]; closed(entry,['knownSum','unavailable']); count(entry.unavailable,usage);
    const sum=decimal(entry.knownSum);
    if (sum>BigInt(usage)*BigInt(Number.MAX_SAFE_INTEGER)*5n) fail();
  }
}
function validatePricing(value: unknown, usage: number): asserts value is Pricing {
  closed(value,['knownNanousd','fullyPriced','partiallyPriced','unpriced']);
  count(value.fullyPriced,usage); count(value.partiallyPriced,usage); count(value.unpriced,usage);
  if(value.fullyPriced+value.partiallyPriced+value.unpriced!==usage
    ||decimal(value.knownNanousd)>BigInt(value.fullyPriced+value.partiallyPriced)*BigInt(Number.MAX_SAFE_INTEGER))fail();
}
const keyOf=(cell: Pick<V11DailyModelCell,'provider'|'modelId'>)=>JSON.stringify([cell.provider,cell.modelId]);
const compare=(a: V11DailyModelCell,b: V11DailyModelCell)=> a.provider<b.provider?-1:a.provider>b.provider?1:a.modelId<b.modelId?-1:a.modelId>b.modelId?1:0;
/** Closed persisted-state validation. This is an arithmetic checkpoint, not a
 * receipt proving source identity, disjoint pages, completion or eligibility. */
export function validateV11DailyProjectionValues(value: unknown): asserts value is V11DailyProjectionValues {
  closed(value,['schemaVersion','day','pricingMethodVersion','registrySha256','counts','tokens','pricing','cells']);
  if(value.schemaVersion!==V11_DAILY_VALUES_SCHEMA || value.pricingMethodVersion!==COMMUNITY_DAILY_SPEND_PRICING_METHOD
    ||value.registrySha256!==COMMUNITY_DAILY_SPEND_REGISTRY_SHA256)fail();
  validDay(value.day); closed(value.counts,['usage','quota','session']);
  count(value.counts.usage);count(value.counts.quota);count(value.counts.session);
  count(value.counts.usage+value.counts.quota+value.counts.session);
  validateTokens(value.tokens,value.counts.usage);validatePricing(value.pricing,value.counts.usage);
  if(!Array.isArray(value.cells)||value.cells.length>MAX_V11_DAILY_MODEL_CELLS)fail();
  let total=0, sums=zeroTokens(), prices=zeroPricing(), previous: V11DailyModelCell|undefined;
  for(const entry of value.cells) {
    closed(entry,['provider','modelId','usageEvents','tokens','pricing']);token(entry.provider);token(entry.modelId);
    count(entry.usageEvents);if(entry.usageEvents===0)fail();
    validateTokens(entry.tokens,entry.usageEvents);validatePricing(entry.pricing,entry.usageEvents);
    const cell=entry as unknown as V11DailyModelCell;
    if(previous&&compare(previous,cell)>=0)fail();previous=cell;
    total+=cell.usageEvents;sums=addTokens(sums,cell.tokens);prices=addPricing(prices,cell.pricing);
  }
  if(total!==value.counts.usage || canonicalTelemetryV11Json(sums)!==canonicalTelemetryV11Json(value.tokens)
    ||canonicalTelemetryV11Json(prices)!==canonicalTelemetryV11Json(value.pricing))fail();
}
export function createV11DailyProjectionValues(day: string): V11DailyProjectionValues {
  validDay(day);
  return {schemaVersion:V11_DAILY_VALUES_SCHEMA,day,pricingMethodVersion:COMMUNITY_DAILY_SPEND_PRICING_METHOD,
    registrySha256:COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,counts:{usage:0,quota:0,session:0},tokens:zeroTokens(),pricing:zeroPricing(),cells:[]};
}
/** Merge only source-proven disjoint pages from the SAME immutable generation.
 * Bounded state intentionally does not retain a day-sized occurrence-ID set. */
export function mergeV11DailyProjectionValues(a: V11DailyProjectionValues,b: V11DailyProjectionValues): V11DailyProjectionValues {
  validateV11DailyProjectionValues(a);validateV11DailyProjectionValues(b);if(a.day!==b.day)fail();
  const result=createV11DailyProjectionValues(a.day);
  result.counts={usage:a.counts.usage+b.counts.usage,quota:a.counts.quota+b.counts.quota,session:a.counts.session+b.counts.session};
  result.tokens=addTokens(a.tokens,b.tokens);result.pricing=addPricing(a.pricing,b.pricing);
  const cells=new Map<string,V11DailyModelCell>();
  for(const cell of [...a.cells,...b.cells]) {
    const key=keyOf(cell),old=cells.get(key);
    cells.set(key,old?{...cell,usageEvents:old.usageEvents+cell.usageEvents,tokens:addTokens(old.tokens,cell.tokens),pricing:addPricing(old.pricing,cell.pricing)}
      :{...cell,tokens:addTokens(zeroTokens(),cell.tokens),pricing:addPricing(zeroPricing(),cell.pricing)});
  }
  result.cells=[...cells.values()].sort(compare);validateV11DailyProjectionValues(result);return result;
}
function sumKnown(values: readonly (number|null)[]): ExactTokenSum {
  return {knownSum:values.reduce<bigint>((sum,value)=>sum+BigInt(value??0),0n).toString(),unavailable:values.some(v=>v===null)?1:0};
}
/** All three streams are validated; only usage contributes tokens and spend.
 * No DB/network writes, raw persistence, quota fit or source selection occurs. */
export function foldV11DailyProjectionValues(state: V11DailyProjectionValues, records: readonly unknown[]): V11DailyProjectionValues {
  validateV11DailyProjectionValues(state);
  if(!Array.isArray(records)||records.length>MAX_V11_DAILY_FOLD_RECORDS)fail();
  const page=createV11DailyProjectionValues(state.day), cells=new Map<string,V11DailyModelCell>();const identities=new Set<string>();
  for(const value of records) {
    const fields=encodeTypedTelemetryRecord('v11',value),canonical=typedTelemetryCanonicalRecords(fields);
    if(new Date(fields.observedAtMs).toISOString().slice(0,10)!==state.day)fail();
    const identity=`${fields.stream}:${Array.from(fields.occurrenceId).join(',')}`;
    if(identities.has(identity))fail();identities.add(identity);
    if(fields.stream!=='usage'){page.counts[fields.stream]++;continue;}
    const u=fields.usage!; const tokens=zeroTokens();
    for(const key of COMPONENTS)tokens[key]=sumKnown([u.components[key]]);
    const output=u.components.outputCombinedTokens===null
      ?[u.components.outputTextTokens,u.components.outputReasoningTokens]:[u.components.outputCombinedTokens];
    tokens.effectiveOutput=sumKnown(output);
    tokens.nonOverlappingTotal=sumKnown([u.components.inputUncachedTokens,u.components.inputCacheReadTokens,u.components.inputCacheWriteTokens,...output]);
    const priced=priceChunkUsageRecord(canonical.canonicalRecord,new Date(fields.observedAtMs).toISOString());
    const pricing=zeroPricing();
    if(priced===null||priced.pricingStatus==='unpriced')pricing.unpriced=1;
    else {
      if(!Number.isSafeInteger(priced.costNanousd)||priced.costNanousd<0)fail();
      pricing.knownNanousd=String(priced.costNanousd);
      if(priced.pricingStatus==='fully_priced')pricing.fullyPriced=1;else if(priced.pricingStatus==='partially_priced')pricing.partiallyPriced=1;else fail();
    }
    page.counts.usage++;page.tokens=addTokens(page.tokens,tokens);page.pricing=addPricing(page.pricing,pricing);
    const key=keyOf({provider:fields.provider,modelId:u.modelId}),old=cells.get(key);
    cells.set(key,{provider:fields.provider,modelId:u.modelId,usageEvents:(old?.usageEvents??0)+1,
      tokens:old?addTokens(old.tokens,tokens):tokens,pricing:old?addPricing(old.pricing,pricing):pricing});
    if(cells.size>MAX_V11_DAILY_MODEL_CELLS)fail();
  }
  page.cells=[...cells.values()].sort(compare);
  return mergeV11DailyProjectionValues(state,page);
}
/** Final arithmetic output only. The caller retains existing daily capacity,
 * suppression and source/authority/completion gates before public publication. */
export function finalizeV11DailyProjectionValues(state: V11DailyProjectionValues) {
  validateV11DailyProjectionValues(state);
  const copy=mergeV11DailyProjectionValues(createV11DailyProjectionValues(state.day),state);
  const priced=state.pricing.fullyPriced+state.pricing.partiallyPriced;
  return {...copy,coverage:state.counts.usage===0||state.pricing.fullyPriced===state.counts.usage?'complete' as const
    :priced===0?'unavailable' as const:'partial' as const,
    knownCostNanousd:state.counts.usage===0||priced>0?state.pricing.knownNanousd:null};
}
