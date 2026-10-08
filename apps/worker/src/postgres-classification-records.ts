import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { decodeTypedTelemetryId, typedTelemetryCanonicalRecords, type TypedTelemetryFields } from "./typed-telemetry-codec";
import { decodeTelemetryV12Record, type TelemetryV12TypedRecordRow } from "./telemetry-v12-typed-codec";
import { sha256Hex } from "./crypto";
import { quotePostgresIdentifier, type PostgresClient } from "./postgres-client";
import { PostgresClassificationCorrectionError, type PostgresClassificationFormat } from "./postgres-classification-correction";
const STREAMS = ["usage", "quota", "session"] as const;
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;
function unavailable(): Error { return new PostgresClassificationCorrectionError(); }
function count(value: unknown): number { const result = Number(value); if (!Number.isSafeInteger(result)) throw unavailable(); return result; }
function t(s: string, name: string): string { return `${s}.${quotePostgresIdentifier(name)}`; }
const table = t;
function hex(value: Uint8Array): string { return [...value].map(v=>v.toString(16).padStart(2,"0")).join(""); }
export interface PostgresClassificationRecord {
 readonly format: PostgresClassificationFormat; readonly recordId: string; readonly sourceNamespace: string;
 readonly deviceId: string; readonly chunkId: string; readonly manifestId: string | null;
 readonly stream: "usage"|"quota"|"session"; readonly occurrenceId: string; readonly observedAtMs: number;
 readonly canonicalDigest: string; readonly recordJson: string; readonly record: Readonly<Record<string, unknown>>;
}

export async function readPostgresClassificationHeaderProofs(client: PostgresClient, s: string,
 records: readonly PostgresClassificationRecord[], participantId: string, deviceId: string): Promise<Map<string, {
 readonly chunkDigest: string; readonly manifestDigest: string | null;
}>> {
 if(records.length>200) throw unavailable();
 const proofs=new Map<string,{readonly chunkDigest:string;readonly manifestDigest:string|null}>();
 for(const format of [10,11,12] as const){
  const selected=records.filter(record=>record.format===format); if(!selected.length) continue;
  const prefix=format===10?"telemetry_v1":format===11?"telemetry_v11":"telemetry_v12";
  const sql=format===10
   ? `SELECT chunk.id,chunk.chunk_digest,NULL::text AS manifest_id,NULL::text AS manifest_digest
       FROM ${t(s,`${prefix}_chunks`)} chunk WHERE chunk.id=ANY($1::text[])
       AND chunk.participant_id=$2 AND chunk.device_id=$3`
   : `SELECT chunk.id,chunk.chunk_digest,chunk.manifest_id,manifest.manifest_digest
       FROM ${t(s,`${prefix}_chunks`)} chunk JOIN ${t(s,`${prefix}_day_manifests`)} manifest ON manifest.id=chunk.manifest_id
       WHERE chunk.id=ANY($1::text[]) AND chunk.participant_id=$2 AND chunk.device_id=$3
       AND manifest.participant_id=$2 AND manifest.device_id=$3 AND manifest.state='ready'`;
  const rows=(await client.query<{id:string;chunk_digest:string;manifest_id:string|null;manifest_digest:string|null}>(sql,
   [[...new Set(selected.map(record=>record.chunkId))],participantId,deviceId])).rows;
  const byId=new Map(rows.map(row=>[row.id,row]));
  for(const record of selected){
   const row=byId.get(record.chunkId);
   if(!row||row.manifest_id!==record.manifestId||!/^[0-9a-f]{64}$/u.test(row.chunk_digest)
    ||(format!==10 && (row.manifest_digest===null||!/^[0-9a-f]{64}$/u.test(row.manifest_digest)))) throw unavailable();
   proofs.set(`${format}:${record.recordId}`,Object.freeze({chunkDigest:row.chunk_digest,manifestDigest:row.manifest_digest}));
  }
 }
 return proofs;
}
interface StoredTypedRow {
  format: number; canonical_digest: Uint8Array; source_namespace: string; device_blob: Uint8Array; chunk_original: Uint8Array; manifest_original: Uint8Array | null;
  typed_record_id: string;
  stream: number;
  occurrence_id: Uint8Array;
  observed_at_ms: string;
  provider: string;
  attribution_id: string | null;
  account_basis: number | null;
  account_track: Uint8Array | null;
  plan_basis: number | null;
  plan_type: string | null;
  plan_era: Uint8Array | null;
  session_value: Uint8Array | null;
  model: string | null; speed_mode: string | null; api_service_tier: string | null;
  surface: string | null; billing_surface: string | null; reasoning_effort: string | null;
  agent_scope: string | null; outcome: string | null;
  total_input_context_tokens: string | null; input_uncached_tokens: string | null;
  input_cache_read_tokens: string | null; input_cache_write_tokens: string | null;
  output_text_tokens: string | null; output_reasoning_tokens: string | null;
  output_combined_tokens: string | null;
  quota_plan_type: string | null; quota_plan_variant: string | null; limit_value: string | null;
  slot_value: string | null; used_percent: number | null; window_duration_minutes: number | null;
  resets_at_ms: string | null;
  tools: Record<string, string | number> | null;
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw unavailable();
  return parsed;
}

/** Rebuild one typed v1.1 record exactly as D1's codec decodes it. */
function decodeStoredRow(row: StoredTypedRow): Record<string, unknown> {
  const stream = STREAMS[row.stream - 1];
  if (!stream) throw unavailable();
  const attribution = row.attribution_id === null ? null : {
    accountBasis: ACCOUNT_BASES[row.account_basis ?? -1],
    accountTrackId: row.account_track === null || row.account_track.byteLength === 0
      ? null : decodeTypedTelemetryId(Uint8Array.from(row.account_track)),
    planBasis: PLAN_BASES[row.plan_basis ?? -1],
    planType: row.plan_type,
    planEraId: row.plan_era === null || row.plan_era.byteLength === 0
      ? null : decodeTypedTelemetryId(Uint8Array.from(row.plan_era)),
  };
  const fields: TypedTelemetryFields = {
    format: row.format === 10 ? "v1" : "v11",
    stream,
    occurrenceId: Uint8Array.from(row.occurrence_id),
    observedAtMs: count(row.observed_at_ms),
    provider: row.provider,
    attribution: attribution as TypedTelemetryFields["attribution"],
    usage: stream === "usage" ? {
      sessionId: Uint8Array.from(row.session_value ?? new Uint8Array()),
      modelId: row.model ?? "", speedMode: row.speed_mode ?? "", apiServiceTier: row.api_service_tier ?? "",
      surface: row.surface ?? "", billingSurface: row.billing_surface ?? "",
      reasoningEffort: row.reasoning_effort ?? "", agentScope: row.agent_scope ?? "", outcome: row.outcome ?? "",
      totalInputContextTokens: nullableNumber(row.total_input_context_tokens),
      components: {
        inputUncachedTokens: nullableNumber(row.input_uncached_tokens),
        inputCacheReadTokens: nullableNumber(row.input_cache_read_tokens),
        inputCacheWriteTokens: nullableNumber(row.input_cache_write_tokens),
        outputTextTokens: nullableNumber(row.output_text_tokens),
        outputReasoningTokens: nullableNumber(row.output_reasoning_tokens),
        outputCombinedTokens: nullableNumber(row.output_combined_tokens),
      } as NonNullable<TypedTelemetryFields["usage"]>["components"],
    } : null,
    quota: stream === "quota" ? {
      planType: row.quota_plan_type ?? "", planVariant: row.quota_plan_variant ?? "",
      limitId: row.limit_value ?? "", slot: row.slot_value ?? "",
      usedPercent: row.used_percent, windowDurationMinutes: row.window_duration_minutes,
      resetsAtMs: nullableNumber(row.resets_at_ms),
    } : null,
    tools: stream === "session"
      ? Object.fromEntries(Object.entries(row.tools ?? {}).map(([key, value]) => [key, count(value)]))
      : null,
  };
  return typedTelemetryCanonicalRecords(fields).record as unknown as Record<string, unknown>;
}


function recordColumns(schema: string): string {
  return [
  "r.stream, r.occurrence_id, r.observed_at_ms, r.observed_day, r.canonical_digest",
  "provider.value AS provider",
  "u.session_id, model.value AS model, speed.value AS speed_mode",
  "tier.value AS api_service_tier, surface.value AS surface",
  "billing.value AS billing_surface, effort.value AS reasoning_effort",
  "scope.value AS agent_scope, outcome.value AS outcome",
  "u.total_input_context_tokens, u.input_uncached_tokens, u.input_cache_read_tokens",
  "u.input_cache_write_tokens, u.output_text_tokens, u.output_reasoning_tokens, u.output_combined_tokens",
  "u.boundary_flags, u.tie_order, u.cache_write_ttl_five_minute_tokens, u.cache_write_ttl_one_hour_tokens",
  "qplan.value AS plan_type, qvariant.value AS plan_variant, qlimit.value AS limit_id, qslot.value AS slot",
  "q.used_percent, q.window_duration_minutes, q.resets_at_ms",
  "COALESCE(ua.account_basis, qa.account_basis) AS account_basis",
  "COALESCE(ua.account_track, qa.account_track) AS account_track",
  "COALESCE(ua.plan_basis, qa.plan_basis) AS plan_basis",
  "COALESCE(uaplan.value, qaplan.value) AS attribution_plan_type",
  "COALESCE(ua.plan_era, qa.plan_era) AS plan_era",
  `CASE WHEN r.stream = 'session' THEN COALESCE((SELECT jsonb_object_agg(tool.value, session_tool.count)::text FROM ${table(schema, "telemetry_v12_typed_session_tools")} session_tool JOIN ${table(schema, "typed_telemetry_dictionary")} tool ON tool.id=session_tool.tool_class_id WHERE session_tool.record_id=r.id), '{}') ELSE NULL END AS tool_json`,
  ].join(",\n       ");
}

function recordJoins(schema: string): string {
  return [
    `JOIN ${table(schema, "typed_telemetry_dictionary")} provider ON provider.id=r.provider_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_usage")} u ON u.record_id=r.id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} model ON model.id=u.model_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} speed ON speed.id=u.speed_mode_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} tier ON tier.id=u.api_service_tier_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} surface ON surface.id=u.surface_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} billing ON billing.id=u.billing_surface_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} effort ON effort.id=u.reasoning_effort_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} scope ON scope.id=u.agent_scope_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} outcome ON outcome.id=u.outcome_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_attributions")} ua ON ua.id=u.attribution_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} uaplan ON uaplan.id=ua.plan_type_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_quota")} q ON q.record_id=r.id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qplan ON qplan.id=q.plan_type_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qvariant ON qvariant.id=q.plan_variant_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qlimit ON qlimit.id=q.limit_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qslot ON qslot.id=q.slot_id`,
    `LEFT JOIN ${table(schema, "telemetry_v12_typed_attributions")} qa ON qa.id=q.attribution_id`,
    `LEFT JOIN ${table(schema, "typed_telemetry_dictionary")} qaplan ON qaplan.id=qa.plan_type_id`,
  ].join("\n       ");
}



/** Exact bounded record reconstruction through maintained source-format codecs.
 * IDs and all parent authority are independently fenced by the activation caller. */
export async function readPostgresClassificationRecords(client: PostgresClient, s: string,
 format: PostgresClassificationFormat, ids: readonly string[]): Promise<Map<string, PostgresClassificationRecord>> {
 if(ids.length>200 || ids.some(id=>!/^\d+$/u.test(id))) throw unavailable();
 if(ids.length===0) return new Map();
 const unique=[...new Set(ids)];
 const output=new Map<string,PostgresClassificationRecord>();
 if(format===10 || format===11){
  const rows=(await client.query<StoredTypedRow>(`SELECT record.id::text AS typed_record_id, record.format, record.canonical_digest, ${t(s,"typed_legacy_admission_decode_id")}(namespace.original_id) AS source_namespace, device.original_id AS device_blob, typed_chunk.original_id AS chunk_original, typed_manifest.original_id AS manifest_original, record.stream, record.occurrence_id,
            record.observed_at_ms::text AS observed_at_ms, provider.value AS provider,
            attribution.id::text AS attribution_id, attribution.account_basis, attribution.account_track,
            attribution.plan_basis, plan_type.value AS plan_type, attribution.plan_era,
            session_identifier.value AS session_value,
            model.value AS model, speed.value AS speed_mode, tier.value AS api_service_tier,
            surface.value AS surface, billing.value AS billing_surface, effort.value AS reasoning_effort,
            scope.value AS agent_scope, outcome.value AS outcome,
            usage.total_input_context_tokens::text AS total_input_context_tokens,
            usage.input_uncached_tokens::text AS input_uncached_tokens,
            usage.input_cache_read_tokens::text AS input_cache_read_tokens,
            usage.input_cache_write_tokens::text AS input_cache_write_tokens,
            usage.output_text_tokens::text AS output_text_tokens,
            usage.output_reasoning_tokens::text AS output_reasoning_tokens,
            usage.output_combined_tokens::text AS output_combined_tokens,
            quota_plan.value AS quota_plan_type, quota_variant.value AS quota_plan_variant,
            quota_limit.value AS limit_value, quota_slot.value AS slot_value,
            quota.used_percent, quota.window_duration_minutes, quota.resets_at_ms::text AS resets_at_ms,
            (SELECT jsonb_object_agg(tool.value, tools.count)
               FROM ${t(s, "typed_telemetry_session_tools")} tools
               JOIN ${t(s, "typed_telemetry_dictionary")} tool ON tool.id = tools.tool_class_id
              WHERE tools.record_id = record.id) AS tools
       FROM ${t(s, "typed_telemetry_records")} record
       JOIN ${t(s, "typed_telemetry_namespaces")} namespace ON namespace.id = record.namespace_id
       JOIN ${t(s, "typed_telemetry_chunks")} typed_chunk ON typed_chunk.id = record.chunk_id
       LEFT JOIN ${t(s, "typed_telemetry_manifests")} typed_manifest ON typed_manifest.id = record.manifest_id
       JOIN ${t(s, "typed_telemetry_devices")} device ON device.id = record.device_id
       JOIN ${t(s, "typed_telemetry_dictionary")} provider ON provider.id = record.provider_id
       LEFT JOIN ${t(s, "typed_telemetry_usage")} usage ON usage.record_id = record.id
       LEFT JOIN ${t(s, "typed_telemetry_quota")} quota ON quota.record_id = record.id
       LEFT JOIN ${t(s, "typed_telemetry_quota_dimensions")} dimensions ON dimensions.id = quota.dimensions_id
       LEFT JOIN ${t(s, "typed_telemetry_attributions")} attribution
         ON attribution.id = COALESCE(usage.attribution_id, dimensions.attribution_id)
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} plan_type ON plan_type.id = attribution.plan_type_id
       LEFT JOIN ${t(s, "typed_telemetry_identifiers")} session_identifier ON session_identifier.id = usage.session_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} model ON model.id = usage.model_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} speed ON speed.id = usage.speed_mode_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} tier ON tier.id = usage.api_service_tier_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} surface ON surface.id = usage.surface_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} billing ON billing.id = usage.billing_surface_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} effort ON effort.id = usage.reasoning_effort_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} scope ON scope.id = usage.agent_scope_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} outcome ON outcome.id = usage.outcome_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_plan ON quota_plan.id = dimensions.plan_type_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_variant ON quota_variant.id = dimensions.plan_variant_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_limit ON quota_limit.id = quota.limit_id
       LEFT JOIN ${t(s, "typed_telemetry_dictionary")} quota_slot ON quota_slot.id = quota.slot_id
      WHERE record.id = ANY($1::bigint[]) AND record.format IN (10,11)
      ORDER BY record.id LIMIT 201`,[unique])).rows;
  if(rows.length!==unique.length || rows.length>200) throw unavailable();
  for(const row of rows){
   if(row.format!==format) throw unavailable();
   const record=decodeStoredRow(row); const recordJson=canonicalTelemetryV11Json(record);
   if(await sha256Hex(recordJson)!==hex(row.canonical_digest)) throw unavailable();
   const stream=STREAMS[row.stream-1]; if(!stream) throw unavailable();
   output.set(row.typed_record_id,Object.freeze({format,recordId:row.typed_record_id,sourceNamespace:row.source_namespace,
    deviceId:decodeTypedTelemetryId(row.device_blob),chunkId:decodeTypedTelemetryId(row.chunk_original),
    manifestId:row.manifest_original===null?null:decodeTypedTelemetryId(row.manifest_original),stream,
    occurrenceId:String(stream==="usage"?record.eventId:stream==="quota"?record.observationId:record.sessionUuid),
    observedAtMs:count(row.observed_at_ms),canonicalDigest:hex(row.canonical_digest),recordJson,record:Object.freeze(record)}));
  }
 } else if(format===12){
  const rows=(await client.query<Record<string,unknown>>(`SELECT r.id::text AS storage_row_id,r.manifest_id,r.chunk_id,
   r.record_index,chunk.participant_id,chunk.device_id,${recordColumns(s)}
   FROM ${t(s,"telemetry_v12_typed_records")} r JOIN ${t(s,"telemetry_v12_chunks")} chunk ON chunk.id=r.chunk_id ${recordJoins(s)}
   WHERE r.id=ANY($1::bigint[]) ORDER BY r.id LIMIT 201`,[unique])).rows;
  if(rows.length!==unique.length || rows.length>200) throw unavailable();
  for(const row of rows){
   const normalized={...row};
   for(const key of ["observed_at_ms","observed_day","total_input_context_tokens","input_uncached_tokens","input_cache_read_tokens","input_cache_write_tokens","output_text_tokens","output_reasoning_tokens","output_combined_tokens","cache_write_ttl_five_minute_tokens","cache_write_ttl_one_hour_tokens","resets_at_ms","window_duration_minutes"]){
    normalized[key]=row[key]===null || row[key]===undefined?null:count(row[key]);
   }
   normalized.used_percent=row.used_percent===null?null:Number(row.used_percent);
   const stream=row.stream; if(stream!=="usage"&&stream!=="session"&&stream!=="quota") throw unavailable();
   const tools=stream==="session"?JSON.parse(String(row.tool_json)):null;
   const decoded=decodeTelemetryV12Record(normalized as unknown as TelemetryV12TypedRecordRow,tools);
   const digest=hex(row.canonical_digest as Uint8Array); if(await sha256Hex(decoded.canonicalRecord)!==digest) throw unavailable();
   const record=JSON.parse(decoded.canonicalRecord) as Record<string,unknown>; const id=String(row.storage_row_id);
   output.set(id,Object.freeze({format,recordId:id,sourceNamespace:`typed-v12:${s}`,deviceId:String(row.device_id),
    chunkId:String(row.chunk_id),manifestId:String(row.manifest_id),stream,
    occurrenceId:String(stream==="usage"?record.eventId:stream==="quota"?record.observationId:record.sessionUuid),
    observedAtMs:count(row.observed_at_ms),canonicalDigest:digest,recordJson:decoded.canonicalRecord,record:Object.freeze(record)}));
  }
 } else throw unavailable();
 if(output.size!==unique.length) throw unavailable();
 return output;
}
