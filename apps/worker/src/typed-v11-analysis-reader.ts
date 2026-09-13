import { decodeTypedTelemetryUsageAnalysisRows, readTypedTelemetryRowsByStorageIds } from "./typed-telemetry-compatibility";
import type { V11SourcePin } from "./telemetry-v11-domain";
import { encodeTypedTelemetryId } from "./typed-telemetry-codec";
import { TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from "./typed-telemetry-origins";
import { MAX_TYPED_TELEMETRY_OWNER_ORIGINS, readQualifiedTypedTelemetryOwnerOrigins,
  type TypedTelemetryOwnerOrigin } from "./typed-telemetry-origins";

const binary = (value: string): ArrayBuffer => Uint8Array.from(encodeTypedTelemetryId(value)).buffer;

export const TYPED_V11_ANALYSIS_PAGE_SIZE = 5_000;
export interface TypedV11AnalysisScope {
  participantId: string;
  origins: readonly TypedTelemetryOwnerOrigin[];
}

export async function loadTypedV11AnalysisScope(db:D1Database,participantId:string):Promise<TypedV11AnalysisScope|null>{
  const present=await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='typed_v11_admission_state'").first();
  if(!present)return null;
  const state=await db.prepare(`SELECT s.runtime_contract_version,
    EXISTS(SELECT 1 FROM participants WHERE id=? AND state='active') active,
    EXISTS(SELECT 1 FROM sqlite_schema WHERE type='view' AND name='typed_v11_active_records') ready,
    EXISTS(SELECT 1 FROM typed_telemetry_origin_contracts origin WHERE origin.namespace_id=s.namespace_id
      AND origin.source_namespace=s.source_namespace AND origin.access_mode='current-write'
      AND origin.v11_read_contract_version=2) origin_ready
    FROM typed_v11_admission_state s
    WHERE s.id=1`).bind(participantId).first<{runtime_contract_version:number;active:number;ready:number;origin_ready:number}>();
  if(!state)return null;
  if(state.runtime_contract_version!==1||state.active!==1||state.ready!==1||state.origin_ready!==1)
    throw new Error("TYPED_V11_ANALYSIS_NOT_READY");
  return {participantId,origins:await readQualifiedTypedTelemetryOwnerOrigins(db,participantId,"v11")};
}

export const TYPED_V11_USAGE_PAGE_SQL = `WITH page AS MATERIALIZED (
  SELECT storage_row_id,observed_at_ms,occurrence_id,source_namespace
  FROM typed_v11_active_records
  WHERE participant_id=? AND generation_id=? AND stream='usage' AND observed_day=?
    AND observed_at_ms>=? AND observed_at_ms<?
    AND (observed_at_ms,occurrence_id,source_namespace)>(?,?,?)
  ORDER BY observed_at_ms,occurrence_id,source_namespace COLLATE BINARY LIMIT ?
) SELECT r.*,(SELECT count(*) FROM (SELECT duplicate.storage_row_id FROM typed_v11_active_records duplicate
    WHERE duplicate.participant_id=?1 AND duplicate.generation_id=?2 AND duplicate.stream='usage'
      AND duplicate.observed_day=?3 AND duplicate.observed_at_ms>=?4 AND duplicate.observed_at_ms<?5
      AND duplicate.observed_at_ms=page.observed_at_ms AND duplicate.occurrence_id=page.occurrence_id
    LIMIT 2)) occurrence_count
  FROM page CROSS JOIN typed_telemetry_compatibility_records r
  ON r.storage_row_id=page.storage_row_id
  ORDER BY page.observed_at_ms,page.occurrence_id,page.source_namespace COLLATE BINARY`;

export async function readTypedV11UsageAnalysisPage(db: D1Database, options: {
  scope:TypedV11AnalysisScope; pin: V11SourcePin; day: string; from: string; to: string;
  afterTime: string; afterOccurrence: string; afterSourceNamespace?:string; pageSize?: number;
}): Promise<Array<{ occurrence_id: string; observed_at: string; provider: string; session_uuid: string | null;
  record_json: string; source_namespace:string }>> {
  const { day, from, to, afterTime, afterOccurrence } = options;
  const afterSourceNamespace=options.afterSourceNamespace??"";
  const pin = { ...options.pin };
  const pageSize = options.pageSize ?? TYPED_V11_ANALYSIS_PAGE_SIZE;
  if (![from,to,afterTime].every(value => Number.isSafeInteger(Date.parse(value)))
      || Date.parse(from)>=Date.parse(to) || typeof afterOccurrence!=="string" || typeof afterSourceNamespace!=="string"
      || (afterOccurrence!==""&&options.afterSourceNamespace===undefined)
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TYPED_V11_ANALYSIS_PAGE_SIZE) {
    throw new Error("TYPED_V11_ANALYSIS_CURSOR_INVALID");
  }
  // The query itself selects the initialized, authoritative domain. Analytical
  // entrypoints check the complete source pin before and after all pages; a
  // concurrent head change cannot become an accepted truncated result.
  const rows = (await db.prepare(TYPED_V11_USAGE_PAGE_SQL).bind(pin.participantId, pin.generationId,
    day, Date.parse(from), Date.parse(to), Date.parse(afterTime), afterOccurrence,afterSourceNamespace,
    pageSize).all<Record<string, unknown>>()).results;
  const allowed=new Set(options.scope.participantId===pin.participantId
    ? options.scope.origins.map(origin=>origin.sourceNamespace):[]);
  if(allowed.size!==options.scope.origins.length||allowed.size<1||allowed.size>MAX_TYPED_TELEMETRY_OWNER_ORIGINS)
    throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
  const grouped=new Map<string,Array<{row:Record<string,unknown>;index:number}>>();
  rows.forEach((row,index)=>{const source=row.source_namespace;
    if(typeof source!=="string"||!allowed.has(source)||row.occurrence_count!==1)throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
    const group=grouped.get(source)??[];group.push({row,index});grouped.set(source,group);});
  const records=new Array<Awaited<ReturnType<typeof decodeTypedTelemetryUsageAnalysisRows>>[number]>(rows.length);
  for(const [source,group] of grouped){const decoded=await decodeTypedTelemetryUsageAnalysisRows(db,group.map(item=>item.row),{
    sourceNamespace:source,participantId:pin.participantId,format:"v11"});
    decoded.forEach((record,index)=>{records[group[index]!.index]=record;});}
  return records.map((record, index) => {
    const row = rows[index]!;
    if (record.format !== "v11" || record.stream !== "usage"
        || record.observed_day !== day || record.occurrence_id !== row.occurrence_id
        || record.observed_at !== row.observed_at) throw new Error("TYPED_V11_ANALYSIS_MEMBERSHIP_CONFLICT");
    return { occurrence_id: record.occurrence_id, observed_at: record.observed_at,
      provider: record.provider, session_uuid: record.session_uuid, record_json: record.record_json,
      source_namespace:row.source_namespace as string };
  });
}

/** Private exports include staging as well as active evidence, so they use the
 * authenticated chunk membership instead of the active-domain view. */
export async function readTypedV11ChunkRecords(db: D1Database, options: {
  sourceNamespace: string; participantId: string; chunkId: string; expectedCount: number;
}): Promise<Array<{ record_json: string }>> {
  const { sourceNamespace, participantId, chunkId, expectedCount } = options;
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 200) {
    throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  }
  const qualified = await db.prepare(`SELECT 1 AS present FROM telemetry_v11_chunks c
    JOIN typed_v11_chunk_allocations allocation ON allocation.chunk_id=c.id
    JOIN typed_telemetry_chunks typed_chunk ON typed_chunk.namespace_id=allocation.namespace_id
      AND typed_chunk.format=11 AND typed_chunk.original_id=allocation.chunk_original
    JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=allocation.namespace_id
      AND origin.namespace_original=? AND origin.source_namespace=?
      AND origin.v11_read_contract_version=2 AND origin.source_schema_digest=?
    JOIN typed_v11_owner_memberships membership ON membership.participant_id=c.participant_id
      AND membership.namespace_id=allocation.namespace_id AND membership.typed_owner_id=typed_chunk.owner_id
    WHERE c.id=? AND c.participant_id=? AND typed_chunk.original_id=?`)
    .bind(binary(sourceNamespace), sourceNamespace, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST,
      chunkId, participantId, binary(chunkId)).first();
  if (!qualified) throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  const rows = (await db.prepare(`SELECT p.typed_record_id FROM typed_v11_record_admissions p
    JOIN telemetry_v11_chunks c ON c.id=p.chunk_id
    WHERE p.chunk_id=? AND c.participant_id=? ORDER BY p.occurrence_id LIMIT 201`)
    .bind(chunkId, participantId).all<{ typed_record_id: number }>()).results;
  if (rows.length !== expectedCount) throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  const records = await readTypedTelemetryRowsByStorageIds(db, { sourceNamespace, participantId,
    storageRowIds: rows.map(row => row.typed_record_id) });
  if (records.some(row => row.format !== "v11" || row.chunk_row_id !== chunkId)) throw new Error("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
  return records.sort((a,b) => a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1
    : a.occurrence_id < b.occurrence_id ? -1 : a.occurrence_id > b.occurrence_id ? 1 : 0)
    .map(row => ({ record_json: row.record_json }));
}
