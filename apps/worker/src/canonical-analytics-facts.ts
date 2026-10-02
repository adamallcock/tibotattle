import { parseTelemetryV11Record, type TelemetryV11UsageEvent,
  type TelemetryV11QuotaObservation, type TelemetryV11SessionDimension } from '@app-usagemonitor/telemetry-contract';
import { cacheRetentionSessionDigest } from './cache-retention-session';
import { graphDayUsageSessionDigest } from './graph-day-projection';
import { v11PreparedUsageSessionDigest } from './quota-analysis-v11';
import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import type { EffectiveCanonicalEvidence, EffectiveOptionalNumber, EffectiveTelemetryOccurrence,
  EffectiveUsageOccurrence, EffectiveTelemetryStream } from './telemetry-usage-effective-reader';

export const CANONICAL_ANALYTICS_SCHEMA = 'canonical-analytics-v1' as const;
export const MAX_CANONICAL_EFFECT_PAGE = 16;
export const MAX_CANONICAL_PARTITION_ROWS = 128;
export type CanonicalSelectionMethod = 'effective-union-v1' | 'legacy-selected-v1';
export type CanonicalPresence = 'unknown' | 'reported' | 'conflict';
export interface CanonicalScope {
  readonly sourceNamespace: string;
  readonly ownerDigest: string;
  readonly selectionMethod: CanonicalSelectionMethod;
}
export interface CanonicalLocation {
  readonly partitionKey: string;
  readonly day: string | null;
  readonly observedAtMs: number | null;
  readonly sessionKey: string | null;
  readonly orderScopeKey: string;
  /** Exact native rank within an equal-time group, including across pages.
   * An earlier event at a different time never renumbers this group.
   * A newly inserted tie requires repairing the complete affected tie group. */
  readonly nativeOrder: number;
}
export interface CanonicalSourceVariant {
  readonly sourceVariantKey: string;
  readonly kind: 'typed' | 'correction' | 'v12';
  readonly format: 'v1' | 'v11' | 'v12';
  readonly observedAtMs: number;
}
export interface CanonicalProvenance {
  readonly digest: string;
  readonly selectionMethod: CanonicalSelectionMethod;
  readonly erasureKey: string;
  readonly linkedDays: readonly string[];
  readonly variants: readonly CanonicalSourceVariant[];
  /** A materializer may not turn incomplete reverse coverage into absence. */
  readonly coverage: 'complete' | 'unknown';
}
export const CANONICAL_NULLABLE_FIELDS = ['provider','modelId','sessionKey','speedMode','apiServiceTier','surface',
  'billingSurface','reasoningEffort','agentScope','outcome','totalInputContextTokens','inputUncachedTokens',
  'inputCacheReadTokens','inputCacheWriteTokens','outputTextTokens','outputReasoningTokens','outputCombinedTokens',
  'planType','planVariant','limitId','slot','usedPercent','windowDurationMinutes','resetsAtMs',
  'accountScopeKey','planEraKey','attributionPlanType'] as const;
export type CanonicalNullableField = typeof CANONICAL_NULLABLE_FIELDS[number];
export type CanonicalValues = { readonly [K in CanonicalNullableField]: K extends 'totalInputContextTokens'
  | 'inputUncachedTokens' | 'inputCacheReadTokens' | 'inputCacheWriteTokens' | 'outputTextTokens'
  | 'outputReasoningTokens' | 'outputCombinedTokens' | 'usedPercent' | 'windowDurationMinutes' | 'resetsAtMs'
  ? number | null : string | null };
/** Native kernel identities are not interchangeable. These contain only approved
 * opaque analytical digests and schema-validated client account/era pseudonyms. */
export const CANONICAL_NATIVE_SCOPES_SCHEMA = 'canonical-native-scopes-v2' as const;
export const CANONICAL_NATIVE_SCOPE_FIELDS = ['cacheSessionDigest','graphSessionDigest','scalarSessionDigest','accountTrackId','planEraId','sourceFamily','selectedSlotKey','logicalOccurrenceKey','occurrenceTieOrder','quotaOccurrenceId'] as const;
export interface CanonicalNativeScopes {
  readonly schema: typeof CANONICAL_NATIVE_SCOPES_SCHEMA;
  readonly cacheSessionDigest: string|null;
  readonly graphSessionDigest: string|null;
  readonly scalarSessionDigest: string|null;
  readonly accountTrackId: string|null;
  readonly planEraId: string|null;
  readonly sourceFamily: 'effective'|'v1'|'v11';
  readonly selectedSlotKey: string|null;
  readonly logicalOccurrenceKey: string;
  /** Lexical source occurrence order inside the complete selected time tie. */
  readonly occurrenceTieOrder: number;
  /** Only the existing content-free quota pseudonym, never arbitrary source labels. */
  readonly quotaOccurrenceId: string|null;
}
export interface CanonicalFact {
  readonly schema: typeof CANONICAL_ANALYTICS_SCHEMA;
  readonly occurrenceKey: string;
  readonly revision: string;
  readonly stream: EffectiveTelemetryStream;
  readonly status: 'compatible' | 'conflict' | 'total_conflict' | 'base_conflict';
  readonly location: CanonicalLocation;
  readonly provenance: CanonicalProvenance;
  readonly values: CanonicalValues;
  readonly nativeScopes: CanonicalNativeScopes;
  /** Bit positions are CANONICAL_NULLABLE_FIELDS. Unknown is neither bit set. */
  readonly reportedFields: number;
  readonly conflictedFields: number;
  readonly accountBasis: string;
  readonly planBasis: string;
  readonly boundaryFlags: EffectiveOptionalNumber;
  readonly tieOrder: EffectiveOptionalNumber;
  readonly cacheWriteFiveMinuteTokens: EffectiveOptionalNumber;
  readonly cacheWriteOneHourTokens: EffectiveOptionalNumber;
  readonly toolCounts: readonly { readonly toolClass: string; readonly count: number }[];
}
export interface CanonicalRevisionRef {
  readonly revision: string;
  readonly location: CanonicalLocation;
  readonly provenanceDigest: string;
  readonly sourceVariantKeys: readonly string[];
  readonly linkedDays: readonly string[];
}
export interface CanonicalEffect {
  readonly schema: typeof CANONICAL_ANALYTICS_SCHEMA;
  readonly effectKey: string;
  readonly selectionMethod: CanonicalSelectionMethod;
  readonly kind: 'insert' | 'replace' | 'withdraw' | 'noop';
  readonly occurrenceKey: string;
  readonly stream: EffectiveTelemetryStream;
  readonly erasureKey: string;
  readonly authorityRevision: number;
  readonly old: CanonicalRevisionRef | null;
  readonly new: CanonicalRevisionRef | null;
}
export class CanonicalAnalyticsError extends Error {
  constructor(readonly code: 'CANONICAL_INVALID' | 'CANONICAL_UNAVAILABLE' | 'CANONICAL_CONFLICT' | 'CANONICAL_LIMIT') {
    super(code); this.name = 'CanonicalAnalyticsError';
  }
}
export function canonicalFail(code: CanonicalAnalyticsError['code'] = 'CANONICAL_INVALID'): never {
  throw new CanonicalAnalyticsError(code);
}
export function canonicalDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) canonicalFail(); return value;
}
export function canonicalInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) canonicalFail(); return value;
}
export function canonicalDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
    || !Number.isFinite(Date.parse(value+'T00:00:00.000Z'))
    || new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)!==value) canonicalFail(); return value;
}
function scopeValue(scope: CanonicalScope) {
  canonicalDigest(scope.ownerDigest);
  if (!scope.sourceNamespace || scope.sourceNamespace.length > 256
    || !['effective-union-v1','legacy-selected-v1'].includes(scope.selectionMethod)) canonicalFail();
  return [scope.sourceNamespace,scope.ownerDigest];
}
export async function canonicalOccurrenceKey(scope: CanonicalScope, stream: EffectiveTelemetryStream,
  nativeOccurrenceId: string): Promise<string> {
  if (!['usage','quota','session'].includes(stream) || !/^[A-Za-z0-9._:-]{8,128}$/u.test(nativeOccurrenceId)) canonicalFail();
  return sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'occurrence',...scopeValue(scope),stream,nativeOccurrenceId]));
}
export async function canonicalSelectedSlotKey(scope:CanonicalScope,stream:EffectiveTelemetryStream,
  slot:{format:'v1'|'v11';deviceId:string;day:string}):Promise<string> {
  canonicalDay(slot.day);
  if(scope.selectionMethod!=='legacy-selected-v1'||!['v1','v11'].includes(slot.format)
    ||typeof slot.deviceId!=='string'||slot.deviceId.length<1||slot.deviceId.length>256)canonicalFail();
  return sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'selected-slot',...scopeValue(scope),stream,slot.format,slot.deviceId,slot.day]));
}
export async function canonicalSelectedOccurrenceKey(scope:CanonicalScope,stream:EffectiveTelemetryStream,
  nativeOccurrenceId:string,selectedSlotKey:string):Promise<string> {
  if(scope.selectionMethod!=='legacy-selected-v1')canonicalFail();canonicalDigest(selectedSlotKey);
  return sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'selected-occurrence',selectedSlotKey,
    await canonicalOccurrenceKey(scope,stream,nativeOccurrenceId)]));
}
export async function canonicalErasureKey(scope: CanonicalScope): Promise<string> {
  return sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'erasure',...scopeValue(scope)]));
}
export async function canonicalSourceVariantKey(scope: CanonicalScope, stream: EffectiveTelemetryStream,
  coordinate: string): Promise<string> {
  if (typeof coordinate !== 'string' || coordinate.length < 1 || coordinate.length > 1024) canonicalFail();
  return sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'variant',...scopeValue(scope),stream,coordinate]));
}
const UNKNOWN = Object.freeze({presence:'unknown' as const,value:null});
function optional(value: EffectiveOptionalNumber | undefined): EffectiveOptionalNumber {
  if (!value) return UNKNOWN;
  if (!['unknown','reported','conflict'].includes(value.presence)
    || (value.presence === 'reported' ? !Number.isSafeInteger(value.value) || value.value! < 0 : value.value !== null)) canonicalFail();
  return Object.freeze({presence:value.presence,value:value.value});
}
/** Only complete occurrence groups returned by the native reader enter this
 * boundary. Source JSON is parsed once and projected into closed scalar fields;
 * it is never copied into facts, provenance, manifests or effects. */
export async function normalizeNativeEffectiveOccurrence(scope: CanonicalScope,
  row: EffectiveTelemetryOccurrence | EffectiveUsageOccurrence, nativeOrder: number): Promise<CanonicalFact> {
  if (scope.selectionMethod !== 'effective-union-v1' || row.ownerDigest !== scope.ownerDigest
    || !['effective-telemetry-owner-day-v1','effective-usage-owner-day-v1'].includes(row.methodVersion)) canonicalFail();
  const stream = 'stream' in row ? row.stream : 'usage';
  const recordJson = 'analyticalRecordJson' in row ? row.analyticalRecordJson : row.recordJson;
  return normalize(scope,stream,row.occurrenceId,row.eventTime,row.status,recordJson,row.canonicalEvidence,nativeOrder);
}
/** Adapter for an already selected legacy record. Selection stays with its
 * owning reader; this function never unions it with another source family. */
export async function normalizeSelectedTelemetryRecord(scope: CanonicalScope, input: {
  stream: EffectiveTelemetryStream; occurrenceId: string; eventTime: string; recordJson: string;
  evidence: EffectiveCanonicalEvidence; nativeOrder: number;selectedSlotKey:string;sourceFamily:'v1'|'v11';occurrenceTieOrder:number;
}): Promise<CanonicalFact> {
  if (scope.selectionMethod !== 'legacy-selected-v1') canonicalFail();
  return normalize(scope,input.stream,input.occurrenceId,input.eventTime,'compatible',input.recordJson,input.evidence,input.nativeOrder,input);
}
async function normalize(scope: CanonicalScope, stream: EffectiveTelemetryStream, nativeId: string,
  eventTime: string | null, status: CanonicalFact['status'], recordJson: string | null,
  evidence: EffectiveCanonicalEvidence | undefined, nativeOrder: number,selected?:{selectedSlotKey:string;sourceFamily:'v1'|'v11';occurrenceTieOrder:number}): Promise<CanonicalFact> {
  canonicalInteger(nativeOrder);
  // Conflicts have no consumable temporal order and may be discovered from
  // several linked days. Their immutable revision must not depend on which
  // day happened to acquire the same complete occurrence group.
  if(status!=='compatible')nativeOrder=0;
  if (!['compatible','conflict','total_conflict','base_conflict'].includes(status)
    || (status === 'compatible') !== (recordJson !== null)) canonicalFail();
  const logicalOccurrenceKey = await canonicalOccurrenceKey(scope,stream,nativeId);
  if(selected){canonicalDigest(selected.selectedSlotKey);canonicalInteger(selected.occurrenceTieOrder);
    if(!['v1','v11'].includes(selected.sourceFamily))canonicalFail();}
  const occurrenceKey = selected ? await canonicalSelectedOccurrenceKey(scope,stream,nativeId,selected.selectedSlotKey) : logicalOccurrenceKey;
  const erasureKey = await canonicalErasureKey(scope);
  const orderScopeKey = await sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,'order',...scopeValue(scope),stream,scope.selectionMethod]));
  const scopedKey = (kind: string, value: string) => sha256Hex(canonicalJson([CANONICAL_ANALYTICS_SCHEMA,kind,...scopeValue(scope),value]));
  const observedAtMs = eventTime === null ? null : Date.parse(eventTime);
  if (observedAtMs !== null && (!Number.isSafeInteger(observedAtMs) || new Date(observedAtMs).toISOString() !== eventTime)) canonicalFail();
  const day = observedAtMs === null ? null : new Date(observedAtMs).toISOString().slice(0,10);
  const variants: CanonicalSourceVariant[] = [];
  if (evidence) {
    if (evidence.variants.length > 16_384 || evidence.linkedDays.length > 16_384) canonicalFail('CANONICAL_LIMIT');
    for (const variant of evidence.variants) {
      if (!['v1','v11','v12'].includes(variant.format) || !Number.isSafeInteger(variant.observedAtMs)) canonicalFail();
      variants.push(Object.freeze({sourceVariantKey:await canonicalSourceVariantKey(scope,stream,variant.coordinate),
        kind:variant.format === 'v12' ? 'v12' : variant.coordinate.includes(':history:') ? 'correction' : 'typed',
        format:variant.format, observedAtMs:variant.observedAtMs}));
    }
  }
  variants.sort((a,b)=>a.sourceVariantKey < b.sourceVariantKey ? -1 : a.sourceVariantKey > b.sourceVariantKey ? 1 : 0);
  if (new Set(variants.map(row=>row.sourceVariantKey)).size !== variants.length) canonicalFail();
  const linkedDays = Object.freeze([...new Set(evidence?.linkedDays.map(canonicalDay) ?? (day ? [day] : []))].sort());
  if (variants.some(variant=>!linkedDays.includes(new Date(variant.observedAtMs).toISOString().slice(0,10)))
    || day !== null && !linkedDays.includes(day)) canonicalFail();
  const provenanceValue = {selectionMethod:scope.selectionMethod,erasureKey,linkedDays,variants:Object.freeze(variants),
    coverage:evidence ? 'complete' as const : 'unknown' as const};
  const provenance = Object.freeze({...provenanceValue,digest:await sha256Hex(canonicalJson(provenanceValue))});
  const values = Object.fromEntries(CANONICAL_NULLABLE_FIELDS.map(name=>[name,null])) as {-readonly [K in keyof CanonicalValues]: CanonicalValues[K]};
  const nativeScopes: {-readonly [K in keyof CanonicalNativeScopes]: CanonicalNativeScopes[K]} = {
    schema:CANONICAL_NATIVE_SCOPES_SCHEMA,cacheSessionDigest:null,graphSessionDigest:null,scalarSessionDigest:null,
    accountTrackId:null,planEraId:null,sourceFamily:selected?.sourceFamily??'effective',selectedSlotKey:selected?.selectedSlotKey??null,
    logicalOccurrenceKey,occurrenceTieOrder:selected?.occurrenceTieOrder??nativeOrder,quotaOccurrenceId:null};
  let accountBasis = 'unavailable', planBasis = 'unavailable';
  let toolCounts: CanonicalFact['toolCounts'] = [];
  if (recordJson !== null) {
    if (recordJson.length > 16_384) canonicalFail('CANONICAL_LIMIT');
    // Native typed readers validate the admitted shape before cache mapping.
    // Their defensive unreadable mapper branch does not admit malformed JSON
    // or null labels; nullable quantities remain valid unknown evidence here.
    let record;
    try {record = parseTelemetryV11Record(stream,JSON.parse(recordJson));} catch {canonicalFail();}
    values.provider = record.provider;
    if (stream === 'usage') {
      const usage = record as TelemetryV11UsageEvent;
      if (usage.eventId !== nativeId || usage.eventTime !== eventTime) canonicalFail();
      values.sessionKey = await scopedKey('session',usage.sessionUuid);
      for (const key of ['modelId','speedMode','apiServiceTier','surface','billingSurface','reasoningEffort','agentScope','outcome'] as const) values[key] = usage[key];
      values.totalInputContextTokens = usage.totalInputContextTokens;
      for (const key of ['inputUncachedTokens','inputCacheReadTokens','inputCacheWriteTokens','outputTextTokens','outputReasoningTokens','outputCombinedTokens'] as const) values[key] = usage.components[key];
    } else if (stream === 'quota') {
      const quota = record as TelemetryV11QuotaObservation;
      if (quota.observationId !== nativeId || quota.observedTime !== eventTime) canonicalFail();
      if(/^quota-occurrence:v1:[a-f0-9]{64}$/u.test(quota.observationId))nativeScopes.quotaOccurrenceId=quota.observationId;
      values.planType = quota.planType === 'unknown' ? null : quota.planType; values.planVariant = quota.planVariant; values.limitId = quota.limitId;
      values.slot = quota.slot; values.usedPercent = quota.usedPercent; values.windowDurationMinutes = quota.windowDurationMinutes;
      values.resetsAtMs = quota.resetsAt === null ? null : Date.parse(quota.resetsAt);
    } else {
      const session = record as TelemetryV11SessionDimension;
      if (session.sessionUuid !== nativeId || session.firstEventTime !== eventTime) canonicalFail();
      values.sessionKey = await scopedKey('session',session.sessionUuid);
      toolCounts = Object.entries(session.toolClassCounts).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0)
        .map(([toolClass,count])=>Object.freeze({toolClass,count}));
    }
    if ('sessionUuid' in record) {
      const identity={ownerDigest:scope.ownerDigest,provider:record.provider,sessionUuid:record.sessionUuid};
      [nativeScopes.cacheSessionDigest,nativeScopes.graphSessionDigest,nativeScopes.scalarSessionDigest]=await Promise.all([
        cacheRetentionSessionDigest(identity),graphDayUsageSessionDigest(identity),v11PreparedUsageSessionDigest(identity)]);
    }
    if ('accountPlanAttribution' in record) {
      const a = record.accountPlanAttribution;
      accountBasis = a.accountBasis; planBasis = a.planBasis;
      nativeScopes.accountTrackId = a.accountTrackId; nativeScopes.planEraId = a.planEraId;
      values.attributionPlanType = a.planType === 'unknown' ? null : a.planType;
      if(stream === 'usage')values.planType = values.attributionPlanType;
      // Unknown scopes remain occurrence-isolated, never pooled into a fictitious meter.
      values.accountScopeKey = a.accountTrackId === null ? null : await scopedKey('account',a.accountTrackId);
      values.planEraKey = a.planEraId === null ? null : await scopedKey('plan-era',a.planEraId);
    }
  }
  const reportedFields = CANONICAL_NULLABLE_FIELDS.reduce((mask,name,index)=>mask + (values[name] !== null ? 2**index : 0),0);
  const conflictedFields = status === 'compatible' ? ((planBasis === 'conflicted' ? 2**CANONICAL_NULLABLE_FIELDS.indexOf('attributionPlanType')
      + (stream==='usage'?2**CANONICAL_NULLABLE_FIELDS.indexOf('planType'):0) : 0)
    + (evidence?.accountScopeConflict === true ? 2**CANONICAL_NULLABLE_FIELDS.indexOf('accountScopeKey') : 0))
    : 2**CANONICAL_NULLABLE_FIELDS.length-1;
  const body = {schema:CANONICAL_ANALYTICS_SCHEMA,occurrenceKey,stream,status,
    location:Object.freeze({partitionKey:`${scope.selectionMethod}/${stream}/${day ?? 'unknown'}/${occurrenceKey.slice(0,2)}`,day,observedAtMs,
      sessionKey:values.sessionKey,orderScopeKey,nativeOrder}),provenance,values:Object.freeze(values),reportedFields,conflictedFields,
    accountBasis,planBasis,nativeScopes:Object.freeze(nativeScopes),boundaryFlags:optional(evidence?.boundaryFlags),tieOrder:optional(evidence?.tieOrder),
    cacheWriteFiveMinuteTokens:optional(evidence?.cacheWriteFiveMinuteTokens),cacheWriteOneHourTokens:optional(evidence?.cacheWriteOneHourTokens),
    toolCounts:Object.freeze(toolCounts)};
  return Object.freeze({...body,revision:await sha256Hex(canonicalJson(body))});
}
export function canonicalFieldPresence(fact: CanonicalFact, field: CanonicalNullableField): CanonicalPresence {
  const bit = 2**CANONICAL_NULLABLE_FIELDS.indexOf(field);
  return fact.conflictedFields & bit ? 'conflict' : fact.reportedFields & bit ? 'reported' : 'unknown';
}
export function canonicalRevisionRef(fact: CanonicalFact): CanonicalRevisionRef {
  return Object.freeze({revision:fact.revision,location:fact.location,provenanceDigest:fact.provenance.digest,
    sourceVariantKeys:Object.freeze(fact.provenance.variants.map(row=>row.sourceVariantKey)),linkedDays:fact.provenance.linkedDays});
}
export async function reconcileCanonicalEffect(input: {changeKey:string;authorityRevision:number;selectionMethod:CanonicalSelectionMethod;
  occurrenceKey:string;stream:EffectiveTelemetryStream;erasureKey:string;old:CanonicalRevisionRef|null;new:CanonicalRevisionRef|null}): Promise<CanonicalEffect> {
  canonicalDigest(input.changeKey); canonicalDigest(input.occurrenceKey); canonicalDigest(input.erasureKey); canonicalInteger(input.authorityRevision,1);
  const kind: CanonicalEffect['kind'] = input.old?.revision === input.new?.revision ? 'noop' : input.old === null ? 'insert' : input.new === null ? 'withdraw' : 'replace';
  const body = {schema:CANONICAL_ANALYTICS_SCHEMA,kind,selectionMethod:input.selectionMethod,occurrenceKey:input.occurrenceKey,stream:input.stream,
    erasureKey:input.erasureKey,authorityRevision:input.authorityRevision,old:input.old,new:input.new};
  return Object.freeze({...body,effectKey:await sha256Hex(canonicalJson([input.changeKey,body]))});
}
export function compareCanonicalFacts(a: CanonicalFact,b: CanonicalFact): number {
  return (a.location.observedAtMs ?? Number.MAX_SAFE_INTEGER)-(b.location.observedAtMs ?? Number.MAX_SAFE_INTEGER)
    || a.location.orderScopeKey.localeCompare(b.location.orderScopeKey) || a.location.nativeOrder-b.location.nativeOrder
    || a.occurrenceKey.localeCompare(b.occurrenceKey);
}
