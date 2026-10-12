import { canonicalTelemetryV11Json, type TelemetryV11Record, type TelemetryV12Record } from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "./crypto";
import { quotePostgresIdentifier, type PostgresClient } from "./postgres-client";
import { decodeTypedTelemetryId, encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { telemetryV11LegacyProjection } from "./telemetry-v11-compatibility";
import { telemetryV12AnalyticalProjection } from "./telemetry-v12-compatibility";
import {
  POSTGRES_CLASSIFICATION_CORRECTION_METHOD, PostgresClassificationCorrectionError,
  preparePostgresClassificationCorrection, type PostgresClassificationFormat, type PostgresClassificationStream,
} from "./postgres-classification-correction";
import { readPostgresClassificationRecords, readPostgresClassificationHeaderProofs, type PostgresClassificationRecord } from "./postgres-classification-records";

export const PAGE = 200;
export const HEX = /^[0-9a-f]{64}$/u;
const MAX_LINK_PAGE_BYTES = 1_250_000;
const MAX_VARIANT_LINKS = 40_000;
export function fail(): never { throw new PostgresClassificationCorrectionError(); }
export function t(s: string, name: string): string { return `${s}.${quotePostgresIdentifier(name)}`; }
export function hex(value: unknown): string {
  if (!(value instanceof Uint8Array)) fail();
  return [...value].map(v => v.toString(16).padStart(2, "0")).join("");
}
export function number(value: unknown): number { const result=Number(value); if(!Number.isSafeInteger(result)) fail(); return result; }

export interface LinkRow {
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
export async function readLinks(client:PostgresClient,s:string,participantId:string,stream:PostgresClassificationStream,
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

export function resolveLinks(record:PostgresClassificationRecord,links:readonly LinkRow[]):{
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
