import { canonicalJson } from './canonical-json';
import { sha256Hex } from './crypto';
import { canonicalFail,canonicalSelectedSlotKey } from './canonical-analytics-facts';
import { readStorageCommunityOwner } from './storage-community-authority';
import { loadV11SourcePin, type V11SourcePin } from './telemetry-v11-domain';
import { loadV1SourcePin, V1_WINNER_FILTER_SQL, type V1SourcePin } from './telemetry-v1-source-selection';
import { loadTypedV1AnalysisScope, type TypedV1AnalysisScope } from './typed-v1-analysis-reader';
import { readTypedTelemetryRowsByStorageIds } from './typed-telemetry-compatibility';
import { selectedTypedTelemetryAnalyticalJson, type EffectiveCanonicalEvidence, type EffectiveTelemetryStream,
  type EffectiveUsageReaderCursor } from './telemetry-usage-effective-reader';

export interface CanonicalLegacySourceScope {sourceNamespace:string;ownerDigest:string;participantId:string;day:string;stream:EffectiveTelemetryStream}
export type CanonicalLegacySourcePin = {format:'v11';pin:V11SourcePin}|{format:'v1';pin:V1SourcePin};
export interface CanonicalSelectedOccurrence {
  readonly selection:'legacy-selected-v1';readonly selectedSlotKey:string;readonly sourceFamily:'v1'|'v11';
  readonly occurrenceTieOrder:number|null;readonly stream:EffectiveTelemetryStream;
  readonly occurrenceId:string;readonly eventTime:string;readonly recordJson:string;
  readonly canonicalEvidence:EffectiveCanonicalEvidence;
}
/** Matches the native legacy branch: a complete v1.1 owner head takes precedence
 * for its whole domain, including its empty days. Otherwise elect the v1 device. */
export async function loadCanonicalLegacySourcePin(source:D1Database,scope:CanonicalLegacySourceScope):Promise<CanonicalLegacySourcePin> {
  const owner=await readStorageCommunityOwner(source,{ownerDigest:scope.ownerDigest});
  if(!owner||owner.participantId!==scope.participantId)canonicalFail('CANONICAL_UNAVAILABLE');
  if(owner.hasV11){const pin=await loadV11SourcePin(source,scope.participantId);
    if(!pin)canonicalFail('CANONICAL_UNAVAILABLE');return {format:'v11',pin};}
  return {format:'v1',pin:await loadV1SourcePin(source,{participantId:scope.participantId,fromDay:scope.day,throughDay:scope.day})};
}
export async function canonicalLegacySourceStamp(source:D1Database,scope:CanonicalLegacySourceScope,mutationStamp:string,context?:CanonicalLegacyReadContext):Promise<string> {
  const selected=context?await selectedFromContext(source,scope,context):await loadCanonicalLegacySourcePin(source,scope);
  let selectionRevision=selected.pin.fingerprint;
  if(selected.format==='v11'){
    // A successor head may reuse this exact immutable day manifest while
    // appending elsewhere. Pin the selected day coordinates, then revalidate
    // the fresh native head/owner around each acquisition instead of making
    // its unrelated whole-generation revision a content dependency.
    const day=await source.prepare(`SELECT g.device_id,d.manifest_id,m.manifest_digest,m.state
      FROM telemetry_v11_domains g LEFT JOIN telemetry_v11_domain_days d ON d.generation_id=g.id AND d.observed_day=?
      LEFT JOIN telemetry_v11_day_manifests m ON m.id=d.manifest_id AND m.participant_id=g.participant_id AND m.device_id=g.device_id
      WHERE g.id=? AND g.participant_id=?`)
      .bind(scope.day,selected.pin.generationId,scope.participantId)
      .first<{device_id:string;manifest_id:string|null;manifest_digest:string|null;state:string|null}>();
    if(!day||day.manifest_id!==null&&(day.manifest_digest===null||day.state!=='ready'))canonicalFail('CANONICAL_UNAVAILABLE');
    selectionRevision=await sha256Hex(canonicalJson(day.manifest_id===null?['empty',scope.day]
      :[scope.day,day.device_id,day.manifest_id,day.manifest_digest]));
  }
  return sha256Hex(canonicalJson(['canonical-legacy-selection-v1',mutationStamp,selected.format,selectionRevision]));
}
/** Source-local keysets preserve native ordering. Only the caller's opaque
 * occurrence digest and time are checkpointed; physical IDs stay in this call. */
export async function readCanonicalLegacySourcePage(source:D1Database,scope:CanonicalLegacySourceScope,
  after:EffectiveUsageReaderCursor|undefined,limit:number,context?:CanonicalLegacyReadContext):Promise<{
    participantId:string;ownerDigest:string;day:string;rows:readonly CanonicalSelectedOccurrence[];
    next:EffectiveUsageReaderCursor|null;
  }> {
  if(!Number.isSafeInteger(limit)||limit<1||limit>16)canonicalFail();
  const selected=context?await selectedFromContext(source,scope,context):await loadCanonicalLegacySourcePin(source,scope);
  let ids: {storage_row_id:number;observed_at_ms:number;occurrence_id:string}[]=[];
  if(selected.format==='v11') {
    ids=(await source.prepare(`SELECT storage_row_id,observed_at_ms,occurrence_id FROM typed_v11_active_records
      WHERE source_namespace=? AND participant_id=? AND generation_id=? AND observed_day=? AND stream=?
        AND (observed_at_ms,occurrence_id)>(?,?) ORDER BY observed_at_ms,occurrence_id LIMIT ?`)
      .bind(scope.sourceNamespace,scope.participantId,selected.pin.generationId,scope.day,scope.stream,
        after?.observedAtMs??Date.parse(scope.day+'T00:00:00.000Z')-1,after?.occurrenceId??'',limit)
      .all<{storage_row_id:number;observed_at_ms:number;occurrence_id:string}>()).results;
  } else {
    const typed=context?legacyContexts.get(context)?.typed:await loadTypedV1AnalysisScope(source,scope.participantId);
    if(!typed||typed.sourceNamespace!==scope.sourceNamespace)canonicalFail('CANONICAL_UNAVAILABLE');
    let sourceRowId=0;
    if(after){
      const cursors=(await source.prepare(`SELECT r.source_row_id FROM typed_v1_current_records r
        WHERE r.source_namespace=? AND r.participant_id=? AND r.stream=? AND r.observed_day=?
          AND r.observed_at_ms=? AND r.occurrence_id=? AND ${V1_WINNER_FILTER_SQL} LIMIT 2`)
        .bind(scope.sourceNamespace,scope.participantId,scope.stream,scope.day,after.observedAtMs,after.occurrenceId,
          selected.pin.winnersJson).all<{source_row_id:number}>()).results;
      if(cursors.length!==1)canonicalFail('CANONICAL_CONFLICT');sourceRowId=cursors[0]!.source_row_id;
    }
    ids=(await source.prepare(`SELECT r.storage_row_id,r.observed_at_ms,r.occurrence_id FROM typed_telemetry_records base
      INDEXED BY typed_v1_owner_observed CROSS JOIN typed_v1_current_records r ON r.storage_row_id=base.id
      WHERE base.format=10 AND base.owner_id=? AND base.stream=? AND r.observed_day=?
        AND ${V1_WINNER_FILTER_SQL} AND (base.observed_at_ms,base.source_row_id)>(?,?)
      ORDER BY base.observed_at_ms,base.source_row_id LIMIT ?`)
      .bind(typed.ownerId,{usage:1,quota:2,session:3}[scope.stream],scope.day,selected.pin.winnersJson,
        after?.observedAtMs??Date.parse(scope.day+'T00:00:00.000Z')-1,sourceRowId,limit)
      .all<{storage_row_id:number;observed_at_ms:number;occurrence_id:string}>()).results;
  }
  const decoded=await readTypedTelemetryRowsByStorageIds(source,{sourceNamespace:scope.sourceNamespace,
    participantId:scope.participantId,storageRowIds:ids.map(row=>row.storage_row_id)});
  if(decoded.length!==ids.length)canonicalFail('CANONICAL_CONFLICT');
  const lexicalRanks=new Map<number,number>();
  if(selected.format==='v1'&&decoded.length){
    // Compute ranks before restricting to this physical page. The indexed
    // timestamp scope includes every selected row in these ties, across pages.
    const ranks=(await source.prepare(`WITH ranked AS MATERIALIZED(
      SELECT r.storage_row_id,row_number() OVER(PARTITION BY r.observed_at_ms ORDER BY r.occurrence_id)-1 AS tie_order
      FROM typed_v1_current_records r WHERE r.source_namespace=? AND r.participant_id=? AND r.stream=? AND r.observed_day=?
        AND r.observed_at_ms IN(SELECT value FROM json_each(?)) AND ${V1_WINNER_FILTER_SQL})
      SELECT storage_row_id,tie_order FROM ranked WHERE storage_row_id IN(SELECT value FROM json_each(?)) LIMIT 17`)
      .bind(scope.sourceNamespace,scope.participantId,scope.stream,scope.day,JSON.stringify([...new Set(ids.map(row=>row.observed_at_ms))]),
        selected.pin.winnersJson,JSON.stringify(ids.map(row=>row.storage_row_id))).all<{storage_row_id:number;tie_order:number}>()).results;
    for(const row of ranks)lexicalRanks.set(row.storage_row_id,row.tie_order);
    if(lexicalRanks.size!==ids.length)canonicalFail('CANONICAL_CONFLICT');
  }
  const rows:CanonicalSelectedOccurrence[]=await Promise.all(decoded.map(async(row,index)=>{
    if(row.format!==selected.format||row.stream!==scope.stream||row.observed_day!==scope.day
      ||row.occurrence_id!==ids[index]!.occurrence_id||row.observed_at_ms!==ids[index]!.observed_at_ms)canonicalFail('CANONICAL_CONFLICT');
    return {selection:'legacy-selected-v1',sourceFamily:row.format,
      selectedSlotKey:await canonicalSelectedSlotKey({...scope,selectionMethod:'legacy-selected-v1'},scope.stream,
        {format:row.format,deviceId:row.device_id,day:row.observed_day}),
      occurrenceTieOrder:selected.format==='v1'?lexicalRanks.get(ids[index]!.storage_row_id)!:null,stream:scope.stream,occurrenceId:row.occurrence_id,eventTime:row.observed_at,
      recordJson:selectedTypedTelemetryAnalyticalJson(row),canonicalEvidence:{linkedDays:[scope.day],
        boundaryFlags:{presence:'unknown',value:null},tieOrder:{presence:'unknown',value:null},
        cacheWriteFiveMinuteTokens:{presence:'unknown',value:null},cacheWriteOneHourTokens:{presence:'unknown',value:null},
        variants:[{coordinate:`${row.format}:${row.source_row_id}`,format:row.format,observedAtMs:row.observed_at_ms}]}};
  }));
  const last=rows.at(-1);
  return {participantId:scope.participantId,ownerDigest:scope.ownerDigest,day:scope.day,rows,
    next:last?{observedAtMs:Date.parse(last.eventTime),occurrenceId:last.occurrenceId}:null};
}

/** One selected day may span several physical pages. Keep its exact native pin
 * and typed scope only under the caller's fresh source proof, for this request. */
declare const legacyReadContextBrand:unique symbol;
export interface CanonicalLegacyReadContext {readonly [legacyReadContextBrand]:true}
const legacyContexts=new WeakMap<CanonicalLegacyReadContext,{source:D1Database;identity:string;
 selected:CanonicalLegacySourcePin;typed:TypedV1AnalysisScope|null;current:()=>Promise<boolean>;expiresMs:number}>();
function legacyIdentity(scope:CanonicalLegacySourceScope):string {
 return canonicalJson([scope.sourceNamespace,scope.ownerDigest,scope.participantId,scope.day]);
}
export async function createCanonicalLegacyReadContext(source:D1Database,scope:CanonicalLegacySourceScope,
 current:()=>Promise<boolean>,deadlineMs:number):Promise<CanonicalLegacyReadContext|null> {
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=Date.now()||deadlineMs>Date.now()+120_000||!await current())return null;
 const selected=await loadCanonicalLegacySourcePin(source,scope);
 const typed=selected.format==='v1'?await loadTypedV1AnalysisScope(source,scope.participantId):null;
 if(selected.format==='v1'&&(!typed||typed.sourceNamespace!==scope.sourceNamespace)||!await current())return null;
 const context=Object.freeze({}) as CanonicalLegacyReadContext;
 legacyContexts.set(context,{source,identity:legacyIdentity(scope),selected,typed,current,expiresMs:deadlineMs});
 return context;
}
async function selectedFromContext(source:D1Database,scope:CanonicalLegacySourceScope,
 context:CanonicalLegacyReadContext):Promise<CanonicalLegacySourcePin> {
 const state=legacyContexts.get(context);
 if(!state||state.source!==source||state.identity!==legacyIdentity(scope)||Date.now()>=state.expiresMs
  ||!await state.current())canonicalFail('CANONICAL_UNAVAILABLE');
 return state.selected;
}

/** Promotion re-reads the exact native vector rather than inferring its identity
 * from the request's generation/owner guard. */
export async function canonicalLegacyReadContextCurrent(source:D1Database,scope:CanonicalLegacySourceScope,
 context:CanonicalLegacyReadContext):Promise<boolean> {
 const selected=await selectedFromContext(source,scope,context);
 const current=await loadCanonicalLegacySourcePin(source,scope);
 return current.format===selected.format&&current.pin.fingerprint===selected.pin.fingerprint;
}
