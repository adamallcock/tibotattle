import { canonicalTelemetryV11Json, type TelemetryV11Record, type TelemetryV12Record } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { prepareAnalyticsReplayUsageCorrectionAssertion } from "./telemetry-usage-reconciliation";
import { quotePostgresIdentifier, type PostgresClient } from "./postgres-client";
import { decodeTypedTelemetryId, encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import { telemetryV12AnalyticalProjection } from "./telemetry-v12-compatibility";
import {
  POSTGRES_CLASSIFICATION_CORRECTION_METHOD, PostgresClassificationCorrectionError,
  preparePostgresClassificationCorrection, type PostgresClassificationFormat, type PostgresClassificationStream,
} from "./postgres-classification-correction";
import { readPostgresClassificationRecords, readPostgresClassificationHeaderProofs, type PostgresClassificationRecord } from "./postgres-classification-records";

const PAGE = 200;
const HEX = /^[0-9a-f]{64}$/u;
const MAX_LINK_PAGE_BYTES = 1_250_000;
const MAX_VARIANT_LINKS = 40_000;
function fail(): never { throw new PostgresClassificationCorrectionError(); }
function t(s: string, name: string): string { return `${s}.${quotePostgresIdentifier(name)}`; }
function hex(value: unknown): string {
  if (!(value instanceof Uint8Array)) fail();
  return [...value].map(v => v.toString(16).padStart(2, "0")).join("");
}
function number(value: unknown): number { const result=Number(value); if(!Number.isSafeInteger(result)) fail(); return result; }

interface LinkRow {
  id:string;method_version:string;kind:string;participant_id:string;device_id:string;owner_digest:Uint8Array;
  stream:PostgresClassificationStream;occurrence_id:Uint8Array;observed_at_ms:string;
  before_format:PostgresClassificationFormat;after_format:PostgresClassificationFormat;
  before_record_id:string;after_record_id:string;before_namespace:string;after_namespace:string;
  before_chunk_id:string;after_chunk_id:string;before_manifest_id:string|null;after_manifest_id:string;
  before_chunk_digest:string;after_chunk_digest:string;before_manifest_digest:string|null;after_manifest_digest:string;
  before_digest:Uint8Array;after_digest:Uint8Array;invariant_digest:Uint8Array;link_digest:Uint8Array;
  before_record_json:string;after_record_json:string;generation_id:string;activation_manifest_digest:string;
  owner_revision:string;authority_epoch:string;predecessor_token_hash:string;previous_generation_id:string|null;input_revision:string;
}

function acceptedLinkSql(s:string,allowPending:string):string{
  return `(link.generation_id=${allowPending} OR (
    link.after_format=11 AND EXISTS (SELECT 1 FROM ${t(s,"telemetry_v11_domains")} generation
      JOIN ${t(s,"storage_v11_event_sources")} receipt ON receipt.generation_id=generation.id
       AND receipt.participant_id=generation.participant_id AND receipt.manifest_digest=generation.manifest_digest
      WHERE generation.id=link.generation_id AND generation.participant_id=link.participant_id AND generation.device_id=link.device_id
       AND generation.manifest_digest=link.activation_manifest_digest AND receipt.owner_digest=encode(link.owner_digest,'hex')
       AND generation.predecessor_token_hash=link.predecessor_token_hash AND generation.previous_generation_id IS NOT DISTINCT FROM link.previous_generation_id
       AND generation.input_revision=link.input_revision AND receipt.device_id=link.device_id))
    OR (link.after_format=12 AND EXISTS (SELECT 1 FROM ${t(s,"telemetry_v12_domains")} generation
      JOIN ${t(s,"storage_v12_event_sources")} receipt ON receipt.generation_id=generation.id
       AND receipt.participant_id=generation.participant_id AND receipt.manifest_digest=generation.manifest_digest
      WHERE generation.id=link.generation_id AND generation.participant_id=link.participant_id AND generation.device_id=link.device_id
       AND generation.manifest_digest=link.activation_manifest_digest AND receipt.owner_digest=encode(link.owner_digest,'hex')
       AND generation.predecessor_token_hash=link.predecessor_token_hash AND generation.previous_generation_id IS NOT DISTINCT FROM link.previous_generation_id
       AND generation.input_revision=link.input_revision AND receipt.device_id=link.device_id)))`;
}

function linkTuple(row:LinkRow):readonly unknown[]{
  return [POSTGRES_CLASSIFICATION_CORRECTION_METHOD,row.kind,row.participant_id,row.device_id,hex(row.owner_digest),
    row.stream,decodeOccurrence(row.occurrence_id),number(row.observed_at_ms),row.before_format,row.after_format,
    row.before_namespace,row.after_namespace,row.before_chunk_id,row.after_chunk_id,row.before_manifest_id,row.after_manifest_id,
    row.before_chunk_digest,row.after_chunk_digest,row.before_manifest_digest,row.after_manifest_digest,
    hex(row.before_digest),hex(row.after_digest),hex(row.invariant_digest),number(row.owner_revision),number(row.authority_epoch),
    row.predecessor_token_hash,row.previous_generation_id,number(row.input_revision),row.generation_id,row.activation_manifest_digest];
}

function decodeOccurrence(value:Uint8Array):string {try{return decodeTypedTelemetryId(value);}catch{return fail();}}

/** Same snapshot, count-first bounded payload transfer. Every committed link
 * is reconstructed against immutable source rows before it can consume a variant. */
async function readLinks(client:PostgresClient,s:string,participantId:string,stream:PostgresClassificationStream,
 occurrenceIds:readonly string[],pendingGenerationId:string|null=null):Promise<LinkRow[]>{
  if(occurrenceIds.length>PAGE) fail();
  const output:LinkRow[]=[];let cursor="0";
  const scope=`link.participant_id=$1 AND link.stream=$2 AND link.occurrence_id=ANY($3::bytea[])
    AND link.id>$4::bigint AND ${acceptedLinkSql(s,"$5::text")}`;
  for(;;){
    const binds=[participantId,stream,occurrenceIds.map(encodeTypedTelemetryId),cursor,pendingGenerationId];
    const sizes=(await client.query<{id:string;bytes:number}>(`SELECT link.id::text,
      octet_length(link.before_record_json)+octet_length(link.after_record_json) AS bytes
      FROM ${t(s,"telemetry_classification_correction_links")} link WHERE ${scope} ORDER BY link.id LIMIT 201`,binds)).rows;
    if(!sizes.length) break;
    let bytes=0;const ids:string[]=[];
    for(const row of sizes.slice(0,PAGE)){const size=number(row.bytes);if(size<2||size>32768) fail();
      if(bytes+size>MAX_LINK_PAGE_BYTES) break;bytes+=size;ids.push(row.id);}
    if(!ids.length) fail();
    const rows=(await client.query<LinkRow>(`SELECT link.* FROM ${t(s,"telemetry_classification_correction_links")} link
      WHERE ${scope} AND link.id=ANY($6::bigint[]) ORDER BY link.id`,[...binds,ids])).rows;
    if(rows.length!==ids.length || output.length+rows.length>MAX_VARIANT_LINKS) fail();
    for(const row of rows){
      if(row.method_version!==POSTGRES_CLASSIFICATION_CORRECTION_METHOD||row.participant_id!==participantId||row.stream!==stream) fail();
      const proof=await preparePostgresClassificationCorrection({beforeFormat:row.before_format,afterFormat:row.after_format,stream,
        beforeRecordJson:row.before_record_json,afterRecordJson:row.after_record_json});
      if(!proof||proof.kind!==row.kind||proof.beforeDigest!==hex(row.before_digest)||proof.afterDigest!==hex(row.after_digest)
        ||proof.invariantDigest!==hex(row.invariant_digest)||proof.beforeRecordJson!==row.before_record_json
        ||proof.afterRecordJson!==row.after_record_json||await sha256Hex(canonicalTelemetryV11Json(linkTuple(row)))!==hex(row.link_digest)) fail();
    }
    for(const format of [10,11,12] as const){
      const beforeRows=rows.filter(row=>row.before_format===format),afterRows=rows.filter(row=>row.after_format===format);
      for(const [side,selected] of [["before",beforeRows],["after",afterRows]] as const){
        if(!selected.length) continue;
        const records=await readPostgresClassificationRecords(client,s,format,selected.map(row=>side==="before"?row.before_record_id:row.after_record_id));
        const devices=[...new Set(selected.map(row=>row.device_id))];
        const headers=new Map<string,{readonly chunkDigest:string;readonly manifestDigest:string|null}>();
        for(const device of devices){
          const selectedRecords=[...records.values()].filter(record=>record.deviceId===device);
          for(const [key,value] of await readPostgresClassificationHeaderProofs(client,s,selectedRecords,participantId,device)) headers.set(key,value);
        }
        for(const row of selected){
          const record=records.get(side==="before"?row.before_record_id:row.after_record_id);
          if(!record||record.deviceId!==row.device_id||record.stream!==row.stream||record.occurrenceId!==decodeOccurrence(row.occurrence_id)
            ||record.observedAtMs!==number(row.observed_at_ms)
            ||record.recordJson!==(side==="before"?row.before_record_json:row.after_record_json)
            ||record.sourceNamespace!==(side==="before"?row.before_namespace:row.after_namespace)
            ||record.chunkId!==(side==="before"?row.before_chunk_id:row.after_chunk_id)
            ||record.manifestId!==(side==="before"?row.before_manifest_id:row.after_manifest_id)) fail();
          const header=headers.get(`${format}:${record.recordId}`);
          if(!header||header.chunkDigest!==(side==="before"?row.before_chunk_digest:row.after_chunk_digest)
            ||header.manifestDigest!==(side==="before"?row.before_manifest_digest:row.after_manifest_digest)) fail();
        }
      }
    }
    output.push(...rows);cursor=ids.at(-1)!;
    if(ids.length===sizes.length) break;
  }
  return output;
}

function resolveLinks(record:PostgresClassificationRecord,links:readonly LinkRow[]):{
 readonly format:PostgresClassificationFormat;readonly recordId:string;readonly sourceNamespace:string;readonly recordJson:string
}{
  let current={format:record.format,recordId:record.recordId,sourceNamespace:record.sourceNamespace,recordJson:record.recordJson};
  const seen=new Set<string>();
  for(let step=0;step<4;step++){
    const matches=links.filter(link=>link.before_format===current.format&&link.before_namespace===current.sourceNamespace
      &&link.device_id===record.deviceId&&link.stream===record.stream&&decodeOccurrence(link.occurrence_id)===record.occurrenceId
      &&link.before_record_json===current.recordJson);
    if(!matches.length) return current;if(matches.length!==1) fail();const link=matches[0]!;
    const digest=hex(link.link_digest);if(seen.has(digest)) fail();seen.add(digest);
    current={format:link.after_format,recordId:link.after_record_id,sourceNamespace:link.after_namespace,recordJson:link.after_record_json};
  }
  return fail();
}

export async function applyPostgresClassificationOverlays(client:PostgresClient,s:string,participantId:string,
 stream:PostgresClassificationStream,records:readonly PostgresClassificationRecord[]):Promise<readonly PostgresClassificationRecord[]>{
  const output:PostgresClassificationRecord[]=[];
  for(let offset=0;offset<records.length;offset+=PAGE){
    const page=records.slice(offset,offset+PAGE);const links=await readLinks(client,s,participantId,stream,[...new Set(page.map(row=>row.occurrenceId))]);
    for(const record of page){
      const resolved=resolveLinks(record,links);let json=resolved.recordJson;
      if(record.format<12&&resolved.format===12) json=telemetryV12AnalyticalProjection(stream,JSON.parse(json) as TelemetryV12Record);
      if(record.format===10&&resolved.format>10){const projection=telemetryV11LegacyProjection(stream,JSON.parse(json) as TelemetryV11Record);if(!projection) fail();json=projection.canonicalRecord;}
      output.push(Object.freeze({...record,recordJson:json,record:Object.freeze(JSON.parse(json)),canonicalDigest:await sha256Hex(json)}));
    }
  }
  return Object.freeze(output);
}

export async function postgresClassificationEvidenceIdentities(client:PostgresClient,s:string,participantId:string,
 stream:PostgresClassificationStream,occurrenceIds:readonly string[]):Promise<Map<string,string>>{
 const links=await readLinks(client,s,participantId,stream,occurrenceIds);
 const result=new Map<string,string>();
 for(const id of occurrenceIds){
  const selected=links.filter(link=>decodeOccurrence(link.occurrence_id)===id);
  if(!selected.length) continue;
  result.set(id,await sha256Hex(canonicalTelemetryV11Json([POSTGRES_CLASSIFICATION_CORRECTION_METHOD,
   selected.map(link=>[hex(link.link_digest),link.generation_id,link.activation_manifest_digest])])));
 }
 return result;
}

export interface PostgresClassificationActivation {
  readonly participantId: string; readonly deviceId: string; readonly format: 11 | 12;
  readonly previousGenerationId: string | null; readonly generationId: string;
  readonly predecessorTokenHash: string; readonly inputRevision: number;
  readonly manifestDigest: string;
  readonly days: readonly { readonly day: string; readonly manifestId: string; readonly manifestDigest?: string }[];
  readonly predecessorDays?: readonly { readonly day:string;readonly manifestId:string;readonly manifestDigest:string }[];
}

/** Only server-controlled SQL references may be supplied to this internal seam. */
export function postgresClassificationLinkPredicate(s: string, beforeId: string, afterId: string,
  beforeFormat: 10 | 11 | 12, afterFormat: 11 | 12, activationDigest: string): string {
  const beforeTable=beforeFormat===12?"telemetry_v12_typed_records":"typed_telemetry_records";
  const afterTable=afterFormat===12?"telemetry_v12_typed_records":"typed_telemetry_records";
  const beforeScope=beforeFormat===12
    ? `JOIN ${t(s,"telemetry_v12_chunks")} before_chunk ON before_chunk.id=classification_original.chunk_id`
    : `JOIN ${t(s,"typed_telemetry_namespaces")} before_namespace ON before_namespace.id=classification_original.namespace_id
       JOIN ${t(s,"typed_telemetry_devices")} before_device ON before_device.id=classification_original.device_id`;
  const afterScope=afterFormat===12
    ? `JOIN ${t(s,"telemetry_v12_chunks")} after_chunk ON after_chunk.id=classification_successor.chunk_id`
    : `JOIN ${t(s,"typed_telemetry_devices")} after_device ON after_device.id=classification_successor.device_id`;
  const device=beforeFormat===12?"before_chunk.device_id":`${t(s,"typed_legacy_admission_decode_id")}(before_device.original_id)`;
  const successorDevice=afterFormat===12?"after_chunk.device_id":`${t(s,"typed_legacy_admission_decode_id")}(after_device.original_id)`;
  const namespace=beforeFormat===12?`'typed-v12:${s}'`:`${t(s,"typed_legacy_admission_decode_id")}(before_namespace.original_id)`;
  const accepted=`(${acceptedLinkSql(s,"NULL::text")} OR link.activation_manifest_digest=${activationDigest})`;
  return `EXISTS (WITH RECURSIVE classification_path AS (
    SELECT link.after_format,link.after_namespace,link.after_digest,link.device_id,link.stream,link.occurrence_id,1 AS depth
      FROM ${t(s,beforeTable)} classification_original ${beforeScope}
      JOIN ${t(s,"telemetry_classification_correction_links")} link
        ON link.before_format=${beforeFormat} AND link.before_namespace=${namespace}
       AND link.before_digest=classification_original.canonical_digest AND link.device_id=${device} AND link.occurrence_id=classification_original.occurrence_id
       AND link.method_version='${POSTGRES_CLASSIFICATION_CORRECTION_METHOD}'
      WHERE classification_original.id=${beforeId} AND ${accepted}
    UNION ALL SELECT link.after_format,link.after_namespace,link.after_digest,link.device_id,link.stream,link.occurrence_id,path.depth+1
      FROM classification_path path JOIN ${t(s,"telemetry_classification_correction_links")} link
        ON link.before_format=path.after_format AND link.before_namespace=path.after_namespace AND link.before_digest=path.after_digest
       AND link.device_id=path.device_id AND link.stream=path.stream AND link.occurrence_id=path.occurrence_id
       AND link.method_version='${POSTGRES_CLASSIFICATION_CORRECTION_METHOD}'
      WHERE path.depth<2 AND ${accepted})
    SELECT 1 FROM classification_path path JOIN ${t(s,afterTable)} classification_successor ON classification_successor.id=${afterId}
      ${afterScope} WHERE path.after_format=${afterFormat} AND path.after_digest=classification_successor.canonical_digest
        AND path.device_id=${successorDevice} AND path.occurrence_id=classification_successor.occurrence_id)`;
}

function candidateSql(s: string, format: 11 | 12): string {
  if(format===11) return `SELECT record.id,record.stream,record.occurrence_id,record.observed_at_ms,record.observed_day,
      record.canonical_digest,record.provider_id,usage.model_id,session.value AS session_id,$3::text AS source_device_id
    FROM ${t(s,"typed_telemetry_records")} record
    JOIN ${t(s,"typed_v11_record_admissions")} admission ON admission.typed_record_id=record.id
    JOIN candidate_days day ON day.manifest_id=admission.manifest_id
    JOIN ${t(s,"telemetry_v11_day_manifests")} manifest ON manifest.id=admission.manifest_id
    LEFT JOIN ${t(s,"typed_telemetry_usage")} usage ON usage.record_id=record.id
    LEFT JOIN ${t(s,"typed_telemetry_identifiers")} session ON session.id=usage.session_id
    WHERE record.format=11 AND manifest.participant_id=$2 AND manifest.device_id=$3 AND manifest.state='ready'
      AND manifest.chunk_day=day.day`;
  return `SELECT record.id,CASE record.stream WHEN 'usage' THEN 1 WHEN 'session' THEN 3 ELSE 2 END AS stream,
      record.occurrence_id,record.observed_at_ms,record.observed_day,record.canonical_digest,
      record.provider_id,usage.model_id,usage.session_id,chunk.device_id AS source_device_id
    FROM ${t(s,"telemetry_v12_typed_records")} record
    JOIN ${t(s,"telemetry_v12_chunks")} chunk ON chunk.id=record.chunk_id
    JOIN candidate_days day ON day.manifest_id=record.manifest_id
    JOIN ${t(s,"telemetry_v12_day_manifests")} manifest ON manifest.id=record.manifest_id
    LEFT JOIN ${t(s,"telemetry_v12_typed_usage")} usage ON usage.record_id=record.id
    WHERE chunk.participant_id=$2 AND chunk.device_id=$3 AND manifest.state='ready' AND manifest.chunk_day=day.day`;
}

function oldSql(s: string, format: PostgresClassificationFormat, allDevices=false): string {
  if(format===12) return `SELECT record.id,CASE record.stream WHEN 'usage' THEN 1 WHEN 'session' THEN 3 ELSE 2 END AS stream,
      record.occurrence_id,record.observed_at_ms,record.observed_day,record.canonical_digest,record.provider_id,usage.model_id,usage.session_id,
      chunk.device_id AS source_device_id
    FROM ${t(s,"telemetry_v12_typed_records")} record
    JOIN ${t(s,"telemetry_v12_chunks")} chunk ON chunk.id=record.chunk_id
    JOIN ${t(s,"telemetry_v12_day_manifests")} retained_manifest ON retained_manifest.id=record.manifest_id
    LEFT JOIN ${t(s,"telemetry_v12_typed_usage")} usage ON usage.record_id=record.id
    WHERE chunk.participant_id=$2 ${allDevices?"":"AND chunk.device_id=$3"} AND (
      EXISTS (SELECT 1 FROM ${t(s,"telemetry_v12_domain_heads")} head
        JOIN ${t(s,"telemetry_v12_domain_days")} day ON day.generation_id=head.generation_id
        WHERE head.participant_id=$2 AND day.manifest_id=record.manifest_id)
      OR (chunk.device_id=$3 AND retained_manifest.participant_id=$2 AND retained_manifest.device_id=$3 AND retained_manifest.state='ready'
        AND EXISTS (SELECT 1 FROM predecessor_days bound WHERE bound.manifest_id=retained_manifest.id
          AND bound.manifest_digest=retained_manifest.manifest_digest AND bound.day=retained_manifest.chunk_day)))`;
  const parent=format===11
    ? `JOIN ${t(s,"typed_v11_record_admissions")} admission ON admission.typed_record_id=record.id
       JOIN ${t(s,"telemetry_v11_day_manifests")} retained_manifest ON retained_manifest.id=admission.manifest_id AND retained_manifest.state='ready'
       AND retained_manifest.participant_id=$2
`
    : `JOIN ${t(s,"typed_v1_record_admissions")} admission ON admission.typed_record_id=record.id
       JOIN ${t(s,"telemetry_v1_chunks")} retained_chunk ON retained_chunk.id=admission.chunk_id AND retained_chunk.participant_id=$2
       AND retained_chunk.superseded_at IS NULL AND retained_chunk.accepted_record_count=retained_chunk.record_count`;
  const accepted=format===11?`AND EXISTS (SELECT 1 FROM ${t(s,"telemetry_v11_domain_days")} retained_day
       JOIN ${t(s,"storage_v11_event_sources")} receipt ON receipt.generation_id=retained_day.generation_id
        AND receipt.participant_id=$2 AND receipt.device_id=${t(s,"typed_legacy_admission_decode_id")}(device.original_id)
       WHERE retained_day.manifest_id=admission.manifest_id)`:"";
  return `SELECT record.id,record.stream,record.occurrence_id,record.observed_at_ms,record.observed_day,
      record.canonical_digest,record.provider_id,usage.model_id,session.value AS session_id,${t(s,"typed_legacy_admission_decode_id")}(device.original_id) AS source_device_id
    FROM ${t(s,"typed_telemetry_records")} record
    JOIN ${t(s,"typed_telemetry_owner_memberships")} membership ON membership.namespace_id=record.namespace_id
      AND membership.owner_id=record.owner_id AND membership.source_format=record.format AND membership.participant_id=$2
    JOIN ${t(s,"typed_telemetry_devices")} device ON device.id=record.device_id
    LEFT JOIN ${t(s,"typed_telemetry_usage")} usage ON usage.record_id=record.id
    LEFT JOIN ${t(s,"typed_telemetry_identifiers")} session ON session.id=usage.session_id ${parent}
    WHERE record.format=${format} ${allDevices?"":`AND ${t(s,"typed_legacy_admission_decode_id")}(device.original_id)=$3`} ${accepted}`;
}

function vector(input: PostgresClassificationActivation): string {
  return JSON.stringify({candidate:input.days.map(day=>({day:day.day,manifest_id:day.manifestId})),
    predecessor:(input.predecessorDays??[]).map(day=>({day:day.day,manifest_id:day.manifestId,manifest_digest:day.manifestDigest}))});
}
function predecessorCte():string{
  return `predecessor_days AS MATERIALIZED (SELECT day::date,manifest_id,manifest_digest
    FROM jsonb_to_recordset($1::jsonb->'predecessor') AS bound(day text,manifest_id text,manifest_digest text))`;
}

/** Prepare links within the caller's existing activation transaction. Nothing
 * can become visible if any later closure, head CAS or journal write refuses. */
export async function preparePostgresClassificationActivation(client: PostgresClient, s: string,
  input: PostgresClassificationActivation): Promise<void> {
  // A READY predecessor is an additional bound source, never a substitute
  // for corrupt accepted-head evidence. Recheck that head in this same CAS tx.
  for(const format of [11,12] as const){
    const prefix=format===11?"telemetry_v11":"telemetry_v12";
    const expected=format===11
      ? `bound_days AS MATERIALIZED (SELECT domain.id AS generation_id,entry.day,entry."manifestId",entry."manifestDigest"
          FROM ${t(s,`${prefix}_domain_heads`)} head JOIN ${t(s,`${prefix}_domains`)} domain ON domain.id=head.generation_id
          CROSS JOIN LATERAL jsonb_to_recordset(domain.days_json::jsonb) AS entry(day date,"manifestId" text,"manifestDigest" text)
          WHERE head.participant_id=$1)`
      : `bound_days AS MATERIALIZED (SELECT day.generation_id,day.observed_day AS day,day.manifest_id AS "manifestId",day.manifest_digest AS "manifestDigest"
          FROM ${t(s,`${prefix}_domain_heads`)} head JOIN ${t(s,`${prefix}_domain_days`)} day ON day.generation_id=head.generation_id
          WHERE head.participant_id=$1)`;
    const corrupt=(await client.query(`WITH ${expected}
      SELECT 1 FROM ${t(s,`${prefix}_domain_heads`)} head
      JOIN ${t(s,`${prefix}_domains`)} domain ON domain.id=head.generation_id
      JOIN ${t(s,`${prefix}_domain_days`)} day ON day.generation_id=head.generation_id
      LEFT JOIN bound_days bound ON bound.generation_id=head.generation_id AND bound.day=day.observed_day AND bound."manifestId"=day.manifest_id
      LEFT JOIN ${t(s,`${prefix}_day_manifests`)} manifest ON manifest.id=day.manifest_id
      WHERE head.participant_id=$1 AND (manifest.id IS NULL OR manifest.state<>'ready'
        OR manifest.participant_id<>head.participant_id OR manifest.device_id<>domain.device_id
        OR manifest.manifest_digest IS DISTINCT FROM bound."manifestDigest" OR manifest.chunk_day<>day.observed_day) LIMIT 1`,
      [input.participantId])).rows;
    if(corrupt.length) fail();
  }
  const ownership=(await client.query<{owner_digest:string;revision:string;authority_epoch:string}>(
    `SELECT link.owner_digest,owner.revision::text,owner.authority_epoch::text
       FROM ${t(s,"storage_v11_owner_links")} link
       JOIN ${t(s,"storage_source_state")} state ON state.singleton=1
       JOIN ${t(s,"analytics_owner_state")} owner ON owner.source_id=state.source_id AND owner.owner_digest=link.owner_digest
      WHERE link.participant_id=$1 AND link.state='active' AND owner.state='active'`,[input.participantId])).rows;
  // An ordinary owner without a journal bridge may still take the exact path.
  // A differing classification can never invent an owner link.
  let owner=ownership.length===1?ownership[0]:null;
  if(ownership.length>1) fail();
  for(const beforeFormat of [10,11,12] as const){
    if(beforeFormat>input.format) continue;
    let foreignOldCursor="0",foreignNewCursor="0";
    for(;;){
      const foreign=(await client.query<{before_id:string;after_id:string}>(`WITH candidate_days AS MATERIALIZED (
        SELECT day::date,manifest_id FROM jsonb_to_recordset($1::jsonb->'candidate') AS input(day text,manifest_id text)),${predecessorCte()},
        candidate AS MATERIALIZED (${candidateSql(s,input.format)}),old_source AS MATERIALIZED (${oldSql(s,beforeFormat,true)})
        SELECT old_source.id::text AS before_id,candidate.id::text AS after_id
        FROM old_source JOIN candidate ON candidate.stream=old_source.stream AND candidate.occurrence_id=old_source.occurrence_id
        WHERE old_source.source_device_id<>$3 AND old_source.stream IN (1,3)
          AND (old_source.id,candidate.id)>($4::bigint,$5::bigint)
        ORDER BY old_source.id,candidate.id LIMIT 201`,
        [vector(input),input.participantId,input.deviceId,foreignOldCursor,foreignNewCursor])).rows;
      const page=foreign.slice(0,PAGE);if(!page.length) break;
      const before=await readPostgresClassificationRecords(client,s,beforeFormat,page.map(row=>row.before_id));
      const after=await readPostgresClassificationRecords(client,s,input.format,page.map(row=>row.after_id));
      const links:LinkRow[]=[];
      for(const stream of ["usage","session"] as const){
        const ids=[...new Set([...before.values()].filter(record=>record.stream===stream).map(record=>record.occurrenceId))];
        if(ids.length) links.push(...await readLinks(client,s,input.participantId,stream,ids,input.generationId));
      }
      for(const pair of page){
        const original=before.get(pair.before_id),candidate=after.get(pair.after_id);if(!original||!candidate) fail();
        const effective=JSON.parse(resolveLinks(original,links).recordJson) as {provider:unknown;modelId?:unknown};
        if(effective.provider!==candidate.record.provider
          ||(original.stream==="usage"&&effective.modelId!==candidate.record.modelId)) fail();
      }
      foreignOldCursor=page.at(-1)!.before_id;foreignNewCursor=page.at(-1)!.after_id;if(foreign.length<=PAGE) break;
    }
    let oldCursor="0",newCursor="0";
    for(;;){
      const rows=(await client.query<{before_id:string;after_id:string;stream:number}>(
        `WITH candidate_days AS MATERIALIZED (SELECT day::date,manifest_id FROM jsonb_to_recordset($1::jsonb->'candidate') AS input(day text,manifest_id text)),${predecessorCte()},
          candidate AS MATERIALIZED (${candidateSql(s,input.format)}),old_source AS MATERIALIZED (${oldSql(s,beforeFormat)})
         SELECT old_source.id::text AS before_id,candidate.id::text AS after_id,old_source.stream
           FROM old_source JOIN candidate ON candidate.stream=old_source.stream AND candidate.occurrence_id=old_source.occurrence_id
             AND candidate.observed_at_ms=old_source.observed_at_ms AND candidate.observed_day=old_source.observed_day
          WHERE old_source.stream IN (1,3) AND (old_source.provider_id IS DISTINCT FROM candidate.provider_id
            OR (old_source.stream=1 AND old_source.model_id IS DISTINCT FROM candidate.model_id))
            AND (old_source.id,candidate.id)>($4::bigint,$5::bigint)
          ORDER BY old_source.id,candidate.id LIMIT 201`,[vector(input),input.participantId,input.deviceId,oldCursor,newCursor])).rows;
      const page=rows.slice(0,PAGE); if(!page.length) break;
      if(!owner || !HEX.test(owner.owner_digest)) fail();
      const before=await readPostgresClassificationRecords(client,s,beforeFormat,page.map(row=>row.before_id));
      const after=await readPostgresClassificationRecords(client,s,input.format,page.map(row=>row.after_id));

      const afterHeaders=await readPostgresClassificationHeaderProofs(client,s,[...after.values()],input.participantId,input.deviceId);
      for(const row of page){
        let oldRecord=before.get(row.before_id);const newRecord=after.get(row.after_id);
        if(!oldRecord||!newRecord||oldRecord.deviceId!==input.deviceId||newRecord.deviceId!==input.deviceId
          ||oldRecord.stream!==newRecord.stream||oldRecord.occurrenceId!==newRecord.occurrenceId
          ||oldRecord.observedAtMs!==newRecord.observedAtMs||oldRecord.stream==="quota") fail();
        const links=await readLinks(client,s,input.participantId,oldRecord.stream,[oldRecord.occurrenceId],input.generationId);
        const terminal=resolveLinks(oldRecord,links);
        if(terminal.recordId!==oldRecord.recordId||terminal.format!==oldRecord.format){
          oldRecord=(await readPostgresClassificationRecords(client,s,terminal.format,[terminal.recordId])).get(terminal.recordId)!;
          if(!oldRecord) fail();
        }
        if(oldRecord.stream==="quota") fail();
        const actualBeforeFormat=oldRecord.format;
        const proof=await preparePostgresClassificationCorrection({beforeFormat:actualBeforeFormat,afterFormat:input.format,stream:oldRecord.stream,
          beforeRecordJson:oldRecord.recordJson,afterRecordJson:newRecord.recordJson});
        if(!proof){
          let candidateJson=newRecord.recordJson;
          if(actualBeforeFormat<12&&input.format===12) candidateJson=telemetryV12AnalyticalProjection(oldRecord.stream,JSON.parse(candidateJson) as TelemetryV12Record);
          if(actualBeforeFormat===10&&input.format>10){const projection=telemetryV11LegacyProjection(oldRecord.stream,JSON.parse(candidateJson) as TelemetryV11Record);if(!projection) fail();candidateJson=projection.canonicalRecord;}
          if(candidateJson!==oldRecord.recordJson) fail();
          continue;
        }
        const oldHeader=(await readPostgresClassificationHeaderProofs(client,s,[oldRecord],input.participantId,input.deviceId)).get(`${actualBeforeFormat}:${oldRecord.recordId}`)!;
        const newHeader=afterHeaders.get(`${input.format}:${newRecord.recordId}`)!;
        const tuple=[POSTGRES_CLASSIFICATION_CORRECTION_METHOD,proof.kind,input.participantId,input.deviceId,owner.owner_digest,
          oldRecord.stream,oldRecord.occurrenceId,oldRecord.observedAtMs,actualBeforeFormat,input.format,
          oldRecord.sourceNamespace,newRecord.sourceNamespace,oldRecord.chunkId,newRecord.chunkId,
          oldRecord.manifestId,newRecord.manifestId,oldHeader.chunkDigest,newHeader.chunkDigest,oldHeader.manifestDigest,newHeader.manifestDigest,
          proof.beforeDigest,proof.afterDigest,proof.invariantDigest,number(owner.revision),number(owner.authority_epoch),
          input.predecessorTokenHash,input.previousGenerationId,input.inputRevision,input.generationId,input.manifestDigest];
        const linkDigest=await sha256Hex(canonicalTelemetryV11Json(tuple));
        const inserted=await client.query<{link_digest:Uint8Array}>(`INSERT INTO ${t(s,"telemetry_classification_correction_links")} (
          method_version,kind,participant_id,device_id,owner_digest,owner_revision,authority_epoch,stream,occurrence_id,observed_at_ms,
          before_format,after_format,before_record_id,after_record_id,before_namespace,after_namespace,before_chunk_id,after_chunk_id,
          before_manifest_id,after_manifest_id,before_chunk_digest,after_chunk_digest,before_manifest_digest,after_manifest_digest,
          before_digest,after_digest,invariant_digest,link_digest,before_record_json,after_record_json,
          predecessor_token_hash,previous_generation_id,input_revision,generation_id,activation_manifest_digest,created_at)
          VALUES ($1,$2,$3,$4,decode($5,'hex'),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
            decode($25,'hex'),decode($26,'hex'),decode($27,'hex'),decode($28,'hex'),$29,$30,$31,$32,$33,$34,$35,clock_timestamp())
          ON CONFLICT (participant_id,device_id,stream,occurrence_id,before_format,before_namespace,before_digest) DO NOTHING RETURNING link_digest`,
          [POSTGRES_CLASSIFICATION_CORRECTION_METHOD,proof.kind,input.participantId,input.deviceId,owner.owner_digest,
            owner.revision,owner.authority_epoch,oldRecord.stream,encodeTypedTelemetryId(oldRecord.occurrenceId),oldRecord.observedAtMs,
            actualBeforeFormat,input.format,oldRecord.recordId,newRecord.recordId,oldRecord.sourceNamespace,newRecord.sourceNamespace,
            oldRecord.chunkId,newRecord.chunkId,oldRecord.manifestId,newRecord.manifestId,oldHeader.chunkDigest,newHeader.chunkDigest,
            oldHeader.manifestDigest,newHeader.manifestDigest,proof.beforeDigest,proof.afterDigest,proof.invariantDigest,linkDigest,
            proof.beforeRecordJson,proof.afterRecordJson,input.predecessorTokenHash,input.previousGenerationId,input.inputRevision,
            input.generationId,input.manifestDigest]);
        if(!inserted.rows.length){
          const prior=(await client.query<{link_digest:Uint8Array}>(`SELECT link_digest FROM ${t(s,"telemetry_classification_correction_links")}
            WHERE participant_id=$1 AND device_id=$2 AND stream=$3 AND occurrence_id=$4 AND before_format=$5
              AND before_namespace=$6 AND before_digest=decode($7,'hex')`,[input.participantId,input.deviceId,oldRecord.stream,
              encodeTypedTelemetryId(oldRecord.occurrenceId),actualBeforeFormat,oldRecord.sourceNamespace,proof.beforeDigest])).rows;
          if(prior.length!==1||hex(prior[0]!.link_digest)!==linkDigest) fail();
        }
      }
      oldCursor=page.at(-1)!.before_id;newCursor=page.at(-1)!.after_id;
      if(rows.length<=PAGE) break;
    }
  }
  await assertSessionClassificationClosure(client,s,input);
}

/** Archived method1 variants remain independent evidence. Consume only an
 * exact physical canonical variant; missing or differing source evidence is
 * incomplete for a session-provider amendment, never silently known. */
async function assertArchivedSessionProviders(client:PostgresClient,s:string,input:PostgresClassificationActivation,
 sessionId:string,providers:Set<string>):Promise<void>{
  const runtime=(await client.query<{state:string;source_state:string}>(`SELECT state,source_state
    FROM ${t(s,"telemetry_usage_correction_runtime")} WHERE id=1`)).rows;
  if(runtime.length!==1||runtime[0]!.state!=="staged"||!["staged","active"].includes(runtime[0]!.source_state)) fail();
  if(runtime[0]!.source_state!=="active") return;
  const columns=[
    ["source_format","format"],["namespace_id","namespace_id"],["owner_id","owner_id"],["device_id","device_id"],
    ["chunk_id","chunk_id"],["manifest_id","manifest_id"],["source_row_id","source_row_id"],
    ["occurrence_id","occurrence_id"],["event_time_ms","observed_at_ms"],["provider_id","provider_id"],
  ].map(([archive,record])=>[`h.${archive}`,`record.${record}`]);
  const usageColumns=["session_id","model_id","speed_mode_id","api_service_tier_id","surface_id","billing_surface_id",
    "reasoning_effort_id","agent_scope_id","outcome_id","attribution_id","total_input_context_tokens","input_uncached_tokens",
    "input_cache_read_tokens","input_cache_write_tokens","output_text_tokens","output_reasoning_tokens","output_combined_tokens"];
  for(const name of usageColumns) columns.push([`h.${name}`,`usage.${name}`]);
  let cursor="0";
  for(;;){
    const rows=(await client.query<{id:string;source_storage_row_id:string;record_digest:Uint8Array;base_digest:Uint8Array;
      source_chunk_digest:Uint8Array;exact:boolean}>(`SELECT h.id::text,h.source_storage_row_id::text,
      h.record_digest,h.base_digest,h.source_chunk_digest,
      (record.id IS NOT NULL AND record.stream=1 AND record.canonical_digest=h.record_digest
        AND ROW(${columns.map(pair=>pair[0]).join(",")}) IS NOT DISTINCT FROM ROW(${columns.map(pair=>pair[1]).join(",")})
        AND EXISTS (SELECT 1 FROM ${t(s,"typed_telemetry_owner_memberships")} membership
          WHERE membership.namespace_id=record.namespace_id AND membership.owner_id=record.owner_id
           AND membership.source_format=record.format AND membership.participant_id=h.participant_id)) AS exact
      FROM ${t(s,"telemetry_usage_correction_history")} h
      JOIN ${t(s,"telemetry_usage_correction_facts")} fact ON fact.history_id=h.id AND fact.method_version=1
      JOIN ${t(s,"typed_telemetry_identifiers")} session ON session.id=h.session_id
      LEFT JOIN ${t(s,"typed_telemetry_records")} record ON record.id=h.source_storage_row_id AND record.format=h.source_format
      LEFT JOIN ${t(s,"typed_telemetry_usage")} usage ON usage.record_id=record.id
      WHERE h.participant_id=$1 AND h.owner_digest=(SELECT decode(owner.owner_digest,'hex')
        FROM ${t(s,"storage_v11_owner_links")} owner WHERE owner.participant_id=$1 AND owner.state='active')
        AND session.value=$2 AND h.id>$3::bigint ORDER BY h.id LIMIT 201`,
      [input.participantId,encodeTypedTelemetryId(sessionId),cursor])).rows;
    const page=rows.slice(0,PAGE);if(!page.length) break;
    if(page.some(row=>row.exact!==true)) fail();
    const records=await readPostgresClassificationRecords(client,s,10,page.map(row=>row.source_storage_row_id));
    const links=await readLinks(client,s,input.participantId,"usage",[...new Set([...records.values()].map(record=>record.occurrenceId))],input.generationId);
    const headers=new Map<string,{readonly chunkDigest:string;readonly manifestDigest:string|null}>();
    for(const device of new Set([...records.values()].map(record=>record.deviceId))){
      for(const [key,value] of await readPostgresClassificationHeaderProofs(client,s,[...records.values()].filter(record=>record.deviceId===device),input.participantId,device)) headers.set(key,value);
    }
    for(const row of page){
      const record=records.get(row.source_storage_row_id);if(!record||record.stream!=="usage") fail();
      let assertion:Awaited<ReturnType<typeof prepareAnalyticsReplayUsageCorrectionAssertion>>;
      try{assertion=await prepareAnalyticsReplayUsageCorrectionAssertion({format:"v1",recordJson:record.recordJson});}catch{return fail();}
      if(assertion.recordDigest!==hex(row.record_digest)||assertion.baseDigest!==hex(row.base_digest)
        ||headers.get(`10:${record.recordId}`)?.chunkDigest!==hex(row.source_chunk_digest)) fail();
      const provider=(JSON.parse(resolveLinks(record,links).recordJson) as {provider?:unknown}).provider;
      if(provider!=="openai_codex") fail();providers.add(provider);
    }
    cursor=page.at(-1)!.id;if(rows.length<=PAGE) break;
  }
}

/** Unknown sessions stay pending. An attempted known session must prove the
 * complete current/candidate usage set across every day at final activation. */
async function assertSessionClassificationClosure(client: PostgresClient,s:string,input:PostgresClassificationActivation):Promise<void>{
  let sessionCursor="0";
  for(;;){
    const sessions=(await client.query<{id:string}>(`SELECT DISTINCT after_record_id AS id
      FROM ${t(s,"telemetry_classification_correction_links")}
      WHERE participant_id=$1 AND device_id=$2 AND generation_id=$3 AND stream='session'
        AND after_record_id>$4::bigint ORDER BY id LIMIT 201`,
      [input.participantId,input.deviceId,input.generationId,sessionCursor])).rows;
    const sessionPage=sessions.slice(0,PAGE);if(!sessionPage.length) break;
    const after=await readPostgresClassificationRecords(client,s,input.format,sessionPage.map(row=>row.id));
    for(const session of after.values()){
      let formatCursor=0,recordCursor="0";const providers=new Set<string>();
      for(;;){
        const rows=(await client.query<{format:PostgresClassificationFormat;id:string}>(`WITH candidate_days AS MATERIALIZED (
          SELECT day::date,manifest_id FROM jsonb_to_recordset($1::jsonb->'candidate') AS input(day text,manifest_id text)),${predecessorCte()},
          candidate AS MATERIALIZED (${candidateSql(s,input.format)}),
          original AS MATERIALIZED (
            SELECT 10 AS format,* FROM (${oldSql(s,10,true)}) old_v1
            UNION ALL SELECT 11,* FROM (${oldSql(s,11,true)}) old_v11
            UNION ALL SELECT 12,* FROM (${oldSql(s,12,true)}) old_v12),
          selected AS (SELECT format,id FROM original WHERE stream=1 AND session_id=$4
            UNION SELECT $5::integer,id FROM candidate WHERE stream=1 AND session_id=$4)
          SELECT format,id::text FROM selected WHERE (format,id)>($6::integer,$7::bigint) ORDER BY format,id LIMIT 201`,
          [vector(input),input.participantId,input.deviceId,encodeTypedTelemetryId(session.occurrenceId),input.format,formatCursor,recordCursor])).rows;
        const page=rows.slice(0,PAGE);if(!page.length) break;
        for(const format of [10,11,12] as const){
          const ids=page.filter(row=>row.format===format).map(row=>row.id);if(!ids.length) continue;
          const records=await readPostgresClassificationRecords(client,s,format,ids);
          const links=await readLinks(client,s,input.participantId,"usage",[...new Set([...records.values()].map(row=>row.occurrenceId))],input.generationId);
          for(const record of records.values()){
            const effective=resolveLinks(record,links);
            const provider=(JSON.parse(effective.recordJson) as {provider?:unknown}).provider;
            if(typeof provider!=="string") fail();providers.add(provider);
            if(provider!=="openai_codex"||providers.size>1) fail();
          }
        }
        formatCursor=page.at(-1)!.format;recordCursor=page.at(-1)!.id;if(rows.length<=PAGE) break;
      }
      await assertArchivedSessionProviders(client,s,input,session.occurrenceId,providers);
      if(providers.size!==1) fail();
    }
    sessionCursor=sessionPage.at(-1)!.id;if(sessions.length<=PAGE) break;
  }
}
