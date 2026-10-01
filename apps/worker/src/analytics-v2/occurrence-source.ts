/**
 * analytics-v2 occurrence adapter (A-1): one owner's effective telemetry
 * occurrences per OBSERVED day, read from the existing PostgreSQL tables.
 *
 * This is a PostgreSQL port of d43c8f92 telemetry-usage-effective-reader.ts
 * readEffectiveTelemetryOwnerDayPage (:793-830 for usage, and its quota/session
 * branch), run over a whole day range in one read-only snapshot instead of
 * one bounded page per day:
 *
 *  1. Candidates are selected per observed day, exactly as production's
 *     candidate SQL does: a v1 typed record whose observed day is D, a v1.1
 *     typed record admitted to a ready manifest of an owner-linked generation
 *     on day D, a v1.2 record of a ready manifest whose domain day is D, and
 *     (usage only, runtime active) a correction fact whose event time falls on
 *     D. An occurrence is a candidate of every day any of its sources names.
 *  2. Each candidate group is expanded across ALL days (no day filter), so a
 *     source with a different event time is folded into the same group.
 *  3. Groups are reconciled with the vendored d43c8f92 reconcileGroups (usage,
 *     correction-aware) and genericOccurrence/genericRecordJson (quota and
 *     session), unchanged.
 *
 * Corrections never move an event across days: an event-time disagreement
 * makes the occurrence a conflict (eventTime null, status 'conflict') on
 * every candidate day it appears on, which blocks those days downstream
 * (A-2/A-3). Rows are ordered by (candidate observedAtMs, occurrenceId),
 * production's page order; for compatible rows observedAtMs is the event time.
 *
 * Production-to-PostgreSQL mapping (data model only, no semantic change):
 * D1's typed_telemetry_compatibility_records view is the typed row decoded
 * with the same codec; typed_v1/v11_owner_memberships are
 * typed_telemetry_owner_memberships rows of source_format 10/11; D1's
 * typed_v11_record_admissions view is its definition over
 * typed_v11_record_proofs, typed_v11_chunk_allocations and
 * typed_v11_manifest_memberships; D1's compact v1.2 tables are 0025's
 * telemetry_v12_typed_* tables. The usage-correction family is read only
 * when the sealed source's runtime was active (owners.ts), and the retained
 * v1.2 authorization scope is evaluated at the pinned nowMs.
 */

import {
  canonicalTelemetryV11Json,
  parseTelemetryV11Record,
  type TelemetryV11Attribution,
  type TelemetryV11Record,
  type TelemetryV12Record,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../crypto";
import type { PostgresClient } from "../postgres-client";
import { decodeTelemetryV12Record, type TelemetryV12TypedRecordRow } from "../telemetry-v12-typed-codec";
import { prepareUsageCorrectionAssertion } from "../telemetry-usage-reconciliation";
import {
  decodeTypedTelemetryId,
  encodeTypedTelemetryId,
  typedTelemetryCanonicalRecords,
  type TypedTelemetryFields,
} from "../typed-telemetry-codec";
import {
  genericOccurrence,
  reconcileGroups,
  type EffectiveTelemetryOccurrence,
  type EffectiveTelemetryStream,
  type EffectiveUsageOccurrence,
  type TelemetryUsageCorrectionFactRow,
  type TelemetryV12EffectiveRecord,
  type TypedTelemetryCompatibilityRecord,
} from "../../vendor/analytics-d43c8f92/entry";
import {
  ANALYTICS_V2_OWNER_DIGEST_PATTERN,
  type AnalyticsV2Day,
} from "./contract";
import {
  DAY_MS,
  correctionRuntimeActiveSql,
  dayFromNumber,
  dayNumber,
  nowTimestamp,
  onReadSnapshot,
  quotedSchema,
  safeInteger,
  sourceFail,
  typedIdTextSql,
  v12RetainedAuthorizationScopeSql,
  type AnalyticsV2SnapshotContext,
} from "./owners";

export type { EffectiveTelemetryOccurrence, EffectiveTelemetryStream };

export interface ReadOwnerOccurrencesOptions {
  readonly ownerDigest: string;
  readonly stream: EffectiveTelemetryStream;
  readonly fromDay: AnalyticsV2Day;
  readonly throughDay: AnalyticsV2Day;
  /**
   * Distinct (day, occurrence) candidates this read may select before it
   * fails closed with ANALYTICS_V2_SOURCE_LIMIT, so a caller can refuse a
   * dense owner before expansion. Defaults to (and may not exceed)
   * MAX_ANALYTICS_V2_CANDIDATES.
   */
  readonly maxCandidates?: number;
}

/** Widest day range one call reads (the kernels' 170-day horizon plus slack). */
export const MAX_ANALYTICS_V2_OCCURRENCE_DAYS = 400;
/** Occurrence ids expanded per source batch (production's page bound). */
const EXPANSION_BATCH = 200;
/** Distinct source variants one batch may expand to (production's bound). */
const MAX_BATCH_SOURCE_ROWS = 3_200;
/** Distinct v1.2 variants one batch may expand to (production's bound). */
const MAX_BATCH_V12_ROWS = 16_384;
/** Candidate coordinates one call may select before failing closed. */
export const MAX_ANALYTICS_V2_CANDIDATES = 2_000_000;

const OCCURRENCE_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const MIN_MS = -8_640_000_000_000_000;
const MAX_MS = 8_640_000_000_000_000;
const STREAM_CODES: Readonly<Record<EffectiveTelemetryStream, number>> = Object.freeze({ usage: 1, quota: 2, session: 3 });
const ACCOUNT_BASES = ["unavailable", "same_source", "provisional_marker"] as const;
const PLAN_BASES = ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const;

// ---------------------------------------------------------------------------
// Small value guards
// ---------------------------------------------------------------------------

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
}

function hex(value: unknown): string {
  return Buffer.from(bytes(value)).toString("hex");
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  return value;
}

function nullableInteger(value: unknown, maximum = 1_000_000_000_000): number | null {
  return value === null || value === undefined ? null : safeInteger(value, 0, maximum);
}

function occurrenceText(blob: unknown): string {
  let decoded: string;
  try {
    decoded = decodeTypedTelemetryId(bytes(blob));
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  if (!OCCURRENCE_ID.test(decoded)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  return decoded;
}

function occurrenceHex(id: string): string {
  try {
    return Buffer.from(encodeTypedTelemetryId(id)).toString("hex");
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
}

/** ASCII code-point order, which is SQLite BINARY TEXT order for these ids. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

function normalizeOptions(options: ReadOwnerOccurrencesOptions): {
  ownerDigest: string; stream: EffectiveTelemetryStream; fromDay: number; throughDay: number; maxCandidates: number;
} {
  if (!options || typeof options !== "object") sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  if (typeof options.ownerDigest !== "string" || !ANALYTICS_V2_OWNER_DIGEST_PATTERN.test(options.ownerDigest)) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  if (options.stream !== "usage" && options.stream !== "quota" && options.stream !== "session") {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const fromDay = dayNumber(options.fromDay);
  const throughDay = dayNumber(options.throughDay);
  if (throughDay < fromDay || throughDay - fromDay + 1 > MAX_ANALYTICS_V2_OCCURRENCE_DAYS) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  const maxCandidates = options.maxCandidates ?? MAX_ANALYTICS_V2_CANDIDATES;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_ANALYTICS_V2_CANDIDATES) {
    sourceFail("ANALYTICS_V2_SOURCE_INVALID");
  }
  return { ownerDigest: options.ownerDigest, stream: options.stream, fromDay, throughDay, maxCandidates };
}

// ---------------------------------------------------------------------------
// Owner scope (d43c8f92 readOwnerScope)
// ---------------------------------------------------------------------------

interface OwnerScope {
  readonly participantId: string;
  readonly v1Namespace: string | null;
  readonly v11Namespace: string | null;
  readonly correctionActive: boolean;
  /** v1.2 runtime active (production's `v12_state === "active"`). */
  readonly v12RuntimeActive: boolean;
  /** ...and the participant has a v1.2 head (production's candidate and usage-source gate). */
  readonly v12HeadActive: boolean;
}

async function readOwnerScope(client: PostgresClient, s: string, ownerDigest: string): Promise<OwnerScope> {
  const result = await client.query<{
    participant_id: unknown; v1_namespace: unknown; v11_namespace: unknown; correction_present: unknown;
    correction_active: unknown; v12_generation_id: unknown; v12_state: unknown;
  }>(`SELECT link.participant_id,v1.source_namespace AS v1_namespace,v11.source_namespace AS v11_namespace,
          EXISTS(SELECT 1 FROM ${s}.telemetry_usage_correction_runtime r WHERE r.id=1
            AND r.schema_version='telemetry-usage-correction-v1' AND r.method_version='usage-total-correction-v1')
            AS correction_present,
          ${correctionRuntimeActiveSql(s)} AS correction_active,
          v12head.generation_id AS v12_generation_id,v12runtime.state AS v12_state
     FROM ${s}.storage_v11_owner_links link
     JOIN ${s}.storage_source_state source ON source.singleton=1
     JOIN ${s}.storage_owner_revisions owner ON owner.source_id=source.source_id
      AND owner.owner_digest=link.owner_digest AND owner.state='active'
     JOIN ${s}.participants participant ON participant.id=link.participant_id AND participant.state='active'
     LEFT JOIN ${s}.typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
     LEFT JOIN ${s}.typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
     LEFT JOIN ${s}.telemetry_v12_domain_heads v12head ON v12head.participant_id=link.participant_id
     LEFT JOIN ${s}.telemetry_v12_runtime v12runtime ON v12runtime.id=1
    WHERE link.owner_digest=$1 AND link.state='active' LIMIT 2`, [ownerDigest]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || typeof row.participant_id !== "string"
      || row.correction_present !== true || typeof row.correction_active !== "boolean") {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  const v1Namespace = row.v1_namespace === null ? null : text(row.v1_namespace);
  const v11Namespace = row.v11_namespace === null ? null : text(row.v11_namespace);
  const v12RuntimeActive = row.v12_state === "active";
  const v12HeadActive = v12RuntimeActive && typeof row.v12_generation_id === "string";
  // One source namespace for both legacy families (authority capture's rule).
  if (v1Namespace !== null && v11Namespace !== null && v1Namespace !== v11Namespace) {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  // d43c8f92 readOwnerScope's CAS refusal: no legacy family and no active v1.2 runtime.
  if (v1Namespace === null && v11Namespace === null && !v12RuntimeActive) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  return Object.freeze({ participantId: row.participant_id, v1Namespace, v11Namespace,
    correctionActive: row.correction_active, v12RuntimeActive, v12HeadActive });
}

// ---------------------------------------------------------------------------
// v1 / v1.1 typed sources
// ---------------------------------------------------------------------------

/**
 * The typed v1 and v1.1 rows the effective reader admits for owner $1 /
 * participant $2 and stream ($3 code, $4 name), restricted by `filter` on the
 * typed `record` alias. Mirrors d43c8f92 CANDIDATE_SQL / DIRECT_SOURCE_SQL.
 */
function legacyDirectSql(s: string, filter: string): string {
  const v1Device = typedIdTextSql("typed_device.original_id");
  const columns = `record.id AS storage_row_id,record.format,record.occurrence_id,record.observed_at_ms,
         record.observed_day,record.canonical_digest,typed_device.original_id AS device_blob`;
  const v11ProofCount = `(SELECT count(*)
      FROM ${s}.typed_v11_chunk_allocations count_allocation
      JOIN ${s}.typed_telemetry_chunks physical_chunk
        ON physical_chunk.namespace_id=count_allocation.namespace_id AND physical_chunk.format=11
       AND physical_chunk.original_id=count_allocation.chunk_original
      JOIN ${s}.typed_v11_record_proofs count_proof ON count_proof.chunk_key=physical_chunk.id
      JOIN ${s}.typed_v11_manifest_memberships count_membership
        ON count_membership.typed_manifest_id=count_proof.manifest_key
     WHERE count_allocation.chunk_id=chunk.id)`;
  return `SELECT ${columns}
      FROM ${s}.typed_telemetry_owner_memberships membership
      JOIN ${s}.typed_v1_admission_state v1 ON v1.id=1 AND v1.runtime_contract_version=1
       AND v1.source_namespace=membership.source_namespace AND v1.namespace_id=membership.namespace_id
      JOIN ${s}.typed_telemetry_records record ON record.namespace_id=membership.namespace_id
       AND record.owner_id=membership.owner_id AND record.format=10 AND record.stream=$3
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
       AND typed_device.namespace_id=record.namespace_id
      JOIN ${s}.typed_v1_record_admissions admission ON admission.typed_record_id=record.id
      JOIN ${s}.telemetry_v1_chunks chunk ON chunk.id=admission.chunk_id
       AND chunk.participant_id=membership.participant_id AND chunk.device_id=(${v1Device})
       AND chunk.stream=$4 AND chunk.superseded_at IS NULL AND chunk.accepted_record_count=chunk.record_count
       AND chunk.record_count=(SELECT count(*) FROM ${s}.typed_v1_record_admissions complete
         WHERE complete.chunk_id=chunk.id)
      JOIN ${s}.typed_v1_event_sources event ON event.chunk_id=chunk.id AND event.owner_digest=$1
       AND event.source_namespace=v1.source_namespace
     WHERE membership.participant_id=$2 AND membership.source_format=10 AND ${filter}
    UNION ALL
    SELECT ${columns}
      FROM ${s}.typed_telemetry_owner_memberships membership
      JOIN ${s}.typed_v11_admission_state v11 ON v11.id=1 AND v11.runtime_contract_version=1
       AND v11.source_namespace=membership.source_namespace AND v11.namespace_id=membership.namespace_id
      JOIN ${s}.typed_telemetry_records record ON record.namespace_id=membership.namespace_id
       AND record.owner_id=membership.owner_id AND record.format=11 AND record.stream=$3
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
       AND typed_device.namespace_id=record.namespace_id
      JOIN ${s}.typed_v11_record_proofs proof ON proof.typed_record_id=record.id
      JOIN ${s}.typed_telemetry_chunks proof_chunk ON proof_chunk.id=proof.chunk_key
      JOIN ${s}.typed_v11_chunk_allocations allocation ON allocation.namespace_id=proof_chunk.namespace_id
       AND allocation.chunk_original=proof_chunk.original_id
      JOIN ${s}.typed_v11_manifest_memberships admitted_manifest
        ON admitted_manifest.typed_manifest_id=proof.manifest_key
      JOIN ${s}.telemetry_v11_chunks chunk ON chunk.id=allocation.chunk_id AND chunk.stream=$4
      JOIN ${s}.telemetry_v11_domain_days domain_day ON domain_day.manifest_id=admitted_manifest.manifest_id
      JOIN ${s}.telemetry_v11_day_manifests manifest ON manifest.id=domain_day.manifest_id AND manifest.state='ready'
      JOIN ${s}.storage_v11_event_sources event ON event.generation_id=domain_day.generation_id
       AND event.owner_digest=$1 AND event.participant_id=$2
      JOIN ${s}.telemetry_v11_domains generation ON generation.id=event.generation_id
       AND generation.id=domain_day.generation_id
       AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
       AND event.manifest_digest=generation.manifest_digest
       AND event.from_day=generation.from_day AND event.through_day=generation.through_day
       AND event.input_revision=generation.input_revision
      JOIN ${s}.device_credentials generation_device ON generation_device.id=generation.device_id
       AND generation_device.participant_id=generation.participant_id
     WHERE membership.participant_id=$2 AND membership.source_format=11
       AND chunk.record_count=${v11ProofCount} AND ${filter}`;
}

function legacyCandidatesSql(s: string): string {
  return `WITH direct AS (${legacyDirectSql(s, "record.observed_day BETWEEN $5 AND $6")})
    SELECT observed_day,occurrence_id,min(observed_at_ms)::text AS observed_at_ms
      FROM direct GROUP BY observed_day,occurrence_id`;
}

function legacySourcesSql(s: string): string {
  const filter = "record.occurrence_id IN (SELECT decode(value,'hex') FROM unnest($5::text[]) value)";
  return `WITH direct AS MATERIALIZED (${legacyDirectSql(s, filter)}),
    grouped AS MATERIALIZED (
      SELECT min(storage_row_id) AS storage_row_id FROM direct
       GROUP BY device_blob,occurrence_id,observed_at_ms,canonical_digest,format
    )
    SELECT record.id AS storage_row_id,record.source_row_id,record.format,record.stream,record.occurrence_id,
           record.observed_at_ms,record.canonical_digest,typed_device.original_id AS device_blob,
           provider.value AS provider,identifier.value AS session_id,
           model.value AS model,speed.value AS speed_mode,tier.value AS api_service_tier,
           surface.value AS surface,billing.value AS billing_surface,effort.value AS reasoning_effort,
           scope.value AS agent_scope,outcome.value AS outcome,
           usage.total_input_context_tokens,usage.input_uncached_tokens,usage.input_cache_read_tokens,
           usage.input_cache_write_tokens,usage.output_text_tokens,usage.output_reasoning_tokens,
           usage.output_combined_tokens,
           dimensions_plan.value AS plan_type,dimensions_variant.value AS plan_variant,
           limit_row.value AS limit_id,slot_row.value AS slot,quota.used_percent,
           quota.window_duration_minutes,quota.resets_at_ms,
           attribution.account_basis,attribution.account_track,attribution.plan_basis,
           attribution_plan.value AS attribution_plan_type,attribution.plan_era,
           CASE WHEN record.stream=3 THEN COALESCE((
             SELECT jsonb_object_agg(tool.value,tool_count.count)::text
               FROM ${s}.typed_telemetry_session_tools tool_count
               JOIN ${s}.typed_telemetry_dictionary tool ON tool.id=tool_count.tool_class_id
              WHERE tool_count.record_id=record.id
           ),'{}') ELSE NULL END AS tool_json
      FROM grouped
      JOIN ${s}.typed_telemetry_records record ON record.id=grouped.storage_row_id
      JOIN ${s}.typed_telemetry_devices typed_device ON typed_device.id=record.device_id
      JOIN ${s}.typed_telemetry_dictionary provider ON provider.id=record.provider_id
      LEFT JOIN ${s}.typed_telemetry_usage usage ON usage.record_id=record.id
      LEFT JOIN ${s}.typed_telemetry_identifiers identifier ON identifier.id=usage.session_id
      LEFT JOIN ${s}.typed_telemetry_dictionary model ON model.id=usage.model_id
      LEFT JOIN ${s}.typed_telemetry_dictionary speed ON speed.id=usage.speed_mode_id
      LEFT JOIN ${s}.typed_telemetry_dictionary tier ON tier.id=usage.api_service_tier_id
      LEFT JOIN ${s}.typed_telemetry_dictionary surface ON surface.id=usage.surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary billing ON billing.id=usage.billing_surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary effort ON effort.id=usage.reasoning_effort_id
      LEFT JOIN ${s}.typed_telemetry_dictionary scope ON scope.id=usage.agent_scope_id
      LEFT JOIN ${s}.typed_telemetry_dictionary outcome ON outcome.id=usage.outcome_id
      LEFT JOIN ${s}.typed_telemetry_quota quota ON quota.record_id=record.id
      LEFT JOIN ${s}.typed_telemetry_quota_dimensions dimensions ON dimensions.id=quota.dimensions_id
      LEFT JOIN ${s}.typed_telemetry_dictionary dimensions_plan ON dimensions_plan.id=dimensions.plan_type_id
      LEFT JOIN ${s}.typed_telemetry_dictionary dimensions_variant ON dimensions_variant.id=dimensions.plan_variant_id
      LEFT JOIN ${s}.typed_telemetry_dictionary limit_row ON limit_row.id=quota.limit_id
      LEFT JOIN ${s}.typed_telemetry_dictionary slot_row ON slot_row.id=quota.slot_id
      LEFT JOIN ${s}.typed_telemetry_attributions attribution
        ON attribution.id=COALESCE(usage.attribution_id,dimensions.attribution_id)
      LEFT JOIN ${s}.typed_telemetry_dictionary attribution_plan ON attribution_plan.id=attribution.plan_type_id`;
}

interface LegacyRow {
  readonly storage_row_id: unknown; readonly source_row_id: unknown; readonly format: unknown; readonly stream: unknown;
  readonly occurrence_id: unknown; readonly observed_at_ms: unknown; readonly canonical_digest: unknown;
  readonly device_blob: unknown; readonly provider: unknown; readonly session_id: unknown;
  readonly model: unknown; readonly speed_mode: unknown; readonly api_service_tier: unknown; readonly surface: unknown;
  readonly billing_surface: unknown; readonly reasoning_effort: unknown; readonly agent_scope: unknown;
  readonly outcome: unknown; readonly total_input_context_tokens: unknown; readonly input_uncached_tokens: unknown;
  readonly input_cache_read_tokens: unknown; readonly input_cache_write_tokens: unknown;
  readonly output_text_tokens: unknown; readonly output_reasoning_tokens: unknown;
  readonly output_combined_tokens: unknown; readonly plan_type: unknown; readonly plan_variant: unknown;
  readonly limit_id: unknown; readonly slot: unknown; readonly used_percent: unknown;
  readonly window_duration_minutes: unknown; readonly resets_at_ms: unknown; readonly account_basis: unknown;
  readonly account_track: unknown; readonly plan_basis: unknown; readonly attribution_plan_type: unknown;
  readonly plan_era: unknown; readonly tool_json: unknown;
}

function legacyAttribution(row: LegacyRow, format: "v1" | "v11", stream: EffectiveTelemetryStream): TelemetryV11Attribution | null {
  const present = row.account_basis !== null;
  if (format === "v1" || stream === "session") {
    if (present) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    return null;
  }
  if (!present) return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  const accountBasis = ACCOUNT_BASES[safeInteger(row.account_basis, 0, 2)]!;
  const planBasis = PLAN_BASES[safeInteger(row.plan_basis, 0, 3)]!;
  const track = bytes(row.account_track);
  const era = bytes(row.plan_era);
  return {
    accountBasis,
    accountTrackId: track.length === 0 ? null : decodeTypedTelemetryId(track),
    planBasis,
    planType: text(row.attribution_plan_type, 64),
    planEraId: era.length === 0 ? null : decodeTypedTelemetryId(era),
  } as TelemetryV11Attribution;
}

function sessionTools(value: unknown): Record<string, number> {
  if (typeof value !== "string") return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(parsed as Record<string, unknown>)) {
    result[key] = safeInteger(count, 0, 1_000_000_000);
  }
  return result;
}

/**
 * Decode one typed legacy row into the fields the vendored kernels read from
 * a TypedTelemetryCompatibilityRecord (format, source_row_id, stream,
 * occurrence_id, observed_at, record_json), after verifying its canonical
 * digest exactly as the D1 compatibility reader does.
 */
async function decodeLegacyRow(row: LegacyRow, participantId: string, sourceNamespace: string,
  stream: EffectiveTelemetryStream): Promise<TypedTelemetryCompatibilityRecord> {
  const formatCode = safeInteger(row.format, 10, 11);
  const format = formatCode === 10 ? "v1" : "v11";
  if (safeInteger(row.stream, 1, 3) !== STREAM_CODES[stream] || typeof row.provider !== "string") {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const observedAtMs = safeInteger(row.observed_at_ms, MIN_MS, MAX_MS);
  const fields: TypedTelemetryFields = {
    format, stream, occurrenceId: bytes(row.occurrence_id), observedAtMs, provider: text(row.provider, 64),
    attribution: legacyAttribution(row, format, stream), usage: null, quota: null, tools: null,
  };
  if (stream === "usage") {
    fields.usage = {
      sessionId: bytes(row.session_id),
      modelId: text(row.model, 64), speedMode: text(row.speed_mode, 64), apiServiceTier: text(row.api_service_tier, 64),
      surface: text(row.surface, 64), billingSurface: text(row.billing_surface, 64),
      reasoningEffort: text(row.reasoning_effort, 64), agentScope: text(row.agent_scope, 64), outcome: text(row.outcome, 64),
      totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
      components: {
        inputUncachedTokens: nullableInteger(row.input_uncached_tokens),
        inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens),
        inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens),
        outputTextTokens: nullableInteger(row.output_text_tokens),
        outputReasoningTokens: nullableInteger(row.output_reasoning_tokens),
        outputCombinedTokens: nullableInteger(row.output_combined_tokens),
      },
    };
  } else if (stream === "quota") {
    const usedPercent = row.used_percent === null ? null : Number(row.used_percent);
    if (usedPercent !== null && !Number.isFinite(usedPercent)) sourceFail("ANALYTICS_V2_SOURCE_UNAVAILABLE");
    fields.quota = {
      planType: text(row.plan_type, 64), planVariant: text(row.plan_variant, 64),
      limitId: text(row.limit_id, 64), slot: text(row.slot, 64), usedPercent,
      windowDurationMinutes: nullableInteger(row.window_duration_minutes, 527_040),
      resetsAtMs: row.resets_at_ms === null ? null : safeInteger(row.resets_at_ms, MIN_MS, MAX_MS),
    };
  } else {
    fields.tools = sessionTools(row.tool_json);
  }
  let canonical: ReturnType<typeof typedTelemetryCanonicalRecords>;
  try {
    canonical = typedTelemetryCanonicalRecords(fields);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  if (await sha256Hex(canonical.canonicalRecord) !== hex(row.canonical_digest)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  const sourceRowId = safeInteger(row.source_row_id, 1);
  // Only the fields the vendored reconcileGroups/genericOccurrence/
  // genericRecordJson read are populated; the rest of the D1 view's columns
  // are not analytical inputs.
  return Object.freeze({
    source_namespace: sourceNamespace,
    format,
    source_row_id: sourceRowId,
    id: sourceRowId,
    participant_id: participantId,
    device_id: decodeTypedTelemetryId(bytes(row.device_blob)),
    stream,
    occurrence_id: occurrenceText(row.occurrence_id),
    observed_at_ms: observedAtMs,
    observed_at: new Date(observedAtMs).toISOString(),
    record_json: canonical.canonicalRecord,
  }) as unknown as TypedTelemetryCompatibilityRecord;
}

// ---------------------------------------------------------------------------
// v1.2 typed sources (d43c8f92 telemetry-v12-effective-reader.ts)
// ---------------------------------------------------------------------------

function v12SourceJoins(s: string): string {
  return `JOIN ${s}.telemetry_v12_day_manifests manifest ON manifest.id=domain_day.manifest_id
      AND manifest.participant_id=generation.participant_id AND manifest.device_id=generation.device_id
      AND manifest.chunk_day=domain_day.observed_day AND manifest.manifest_digest=domain_day.manifest_digest
      AND manifest.state='ready'
    JOIN ${s}.telemetry_v12_chunks chunk ON chunk.manifest_id=manifest.id
      AND chunk.participant_id=generation.participant_id AND chunk.device_id=generation.device_id
      AND chunk.chunk_day=manifest.chunk_day AND chunk.stream=$2
      AND chunk.record_count=(SELECT count(*) FROM ${s}.telemetry_v12_typed_records complete
        WHERE complete.chunk_id=chunk.id)
    JOIN ${s}.telemetry_v12_typed_records r ON r.chunk_id=chunk.id AND r.manifest_id=manifest.id AND r.stream=$2
    JOIN (${v12RetainedAuthorizationScopeSql(s, "$3::timestamptz", "reader")}) retained_auth
      ON retained_auth.participant_id=generation.participant_id AND retained_auth.device_id=generation.device_id`;
}

/** $1 participant, $2 stream, $3 now, $4/$5 first/last day. */
function v12CandidatesSql(s: string): string {
  return `SELECT (domain_day.observed_day-DATE '1970-01-01')::integer AS observed_day,r.occurrence_id,
          min(r.observed_at_ms)::text AS observed_at_ms
     FROM ${s}.telemetry_v12_domains generation
     JOIN ${s}.telemetry_v12_domain_days domain_day ON domain_day.generation_id=generation.id
      AND domain_day.observed_day BETWEEN $4::date AND $5::date
     ${v12SourceJoins(s)}
    WHERE generation.participant_id=$1
    GROUP BY domain_day.observed_day,r.occurrence_id`;
}

/** $1 participant, $2 stream, $3 now, $4 occurrence ids (hex text[]), $5 limit. */
function v12OccurrencesSql(s: string): string {
  return `WITH requested AS MATERIALIZED (
      SELECT DISTINCT decode(value,'hex') AS occurrence_id FROM unnest($4::text[]) value
    ), eligible AS MATERIALIZED (
      SELECT r.id,r.occurrence_id,r.observed_at_ms,r.canonical_digest,generation.device_id AS source_device_id
        FROM requested wanted
        JOIN ${s}.telemetry_v12_typed_records r ON r.occurrence_id=wanted.occurrence_id AND r.stream=$2
        JOIN ${s}.telemetry_v12_chunks chunk ON chunk.id=r.chunk_id AND chunk.manifest_id=r.manifest_id
         AND chunk.stream=$2
         AND chunk.record_count=(SELECT count(*) FROM ${s}.telemetry_v12_typed_records complete
           WHERE complete.chunk_id=chunk.id)
        JOIN ${s}.telemetry_v12_day_manifests manifest ON manifest.id=r.manifest_id
         AND manifest.participant_id=chunk.participant_id AND manifest.device_id=chunk.device_id
         AND manifest.state='ready'
        JOIN ${s}.telemetry_v12_domain_days domain_day ON domain_day.manifest_id=manifest.id
         AND domain_day.manifest_digest=manifest.manifest_digest
        JOIN ${s}.telemetry_v12_domains generation ON generation.id=domain_day.generation_id
         AND generation.participant_id=chunk.participant_id AND generation.device_id=chunk.device_id
        JOIN (${v12RetainedAuthorizationScopeSql(s, "$3::timestamptz", "reader")}) retained_auth
          ON retained_auth.participant_id=generation.participant_id
         AND retained_auth.device_id=generation.device_id
       WHERE generation.participant_id=$1
    ), grouped AS MATERIALIZED (
      SELECT min(id) AS id FROM eligible
       GROUP BY source_device_id,occurrence_id,observed_at_ms,canonical_digest
    ), selected AS (
      SELECT id FROM grouped ORDER BY id LIMIT $5
    )
    SELECT selected.id::text AS storage_row_id,r.manifest_id,r.record_index,
           r.stream,r.occurrence_id,r.observed_at_ms,r.observed_day,r.canonical_digest,
           provider.value AS provider,
           u.session_id,model.value AS model,speed.value AS speed_mode,
           tier.value AS api_service_tier,surface.value AS surface,
           billing.value AS billing_surface,effort.value AS reasoning_effort,
           scope.value AS agent_scope,outcome.value AS outcome,
           u.total_input_context_tokens,u.input_uncached_tokens,u.input_cache_read_tokens,
           u.input_cache_write_tokens,u.output_text_tokens,u.output_reasoning_tokens,u.output_combined_tokens,
           u.boundary_flags,u.tie_order,u.cache_write_ttl_five_minute_tokens,u.cache_write_ttl_one_hour_tokens,
           qplan.value AS plan_type,qvariant.value AS plan_variant,qlimit.value AS limit_id,qslot.value AS slot,
           q.used_percent,q.window_duration_minutes,q.resets_at_ms,
           COALESCE(ua.account_basis,qa.account_basis) AS account_basis,
           COALESCE(ua.account_track,qa.account_track) AS account_track,
           COALESCE(ua.plan_basis,qa.plan_basis) AS plan_basis,
           COALESCE(uaplan.value,qaplan.value) AS attribution_plan_type,
           COALESCE(ua.plan_era,qa.plan_era) AS plan_era,
           CASE WHEN r.stream='session' THEN COALESCE((
             SELECT jsonb_object_agg(tool.value,session_tool.count)::text
               FROM ${s}.telemetry_v12_typed_session_tools session_tool
               JOIN ${s}.typed_telemetry_dictionary tool ON tool.id=session_tool.tool_class_id
              WHERE session_tool.record_id=r.id),'{}') ELSE NULL END AS tool_json
      FROM selected
      JOIN ${s}.telemetry_v12_typed_records r ON r.id=selected.id
      JOIN ${s}.typed_telemetry_dictionary provider ON provider.id=r.provider_id
      LEFT JOIN ${s}.telemetry_v12_typed_usage u ON u.record_id=r.id
      LEFT JOIN ${s}.typed_telemetry_dictionary model ON model.id=u.model_id
      LEFT JOIN ${s}.typed_telemetry_dictionary speed ON speed.id=u.speed_mode_id
      LEFT JOIN ${s}.typed_telemetry_dictionary tier ON tier.id=u.api_service_tier_id
      LEFT JOIN ${s}.typed_telemetry_dictionary surface ON surface.id=u.surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary billing ON billing.id=u.billing_surface_id
      LEFT JOIN ${s}.typed_telemetry_dictionary effort ON effort.id=u.reasoning_effort_id
      LEFT JOIN ${s}.typed_telemetry_dictionary scope ON scope.id=u.agent_scope_id
      LEFT JOIN ${s}.typed_telemetry_dictionary outcome ON outcome.id=u.outcome_id
      LEFT JOIN ${s}.telemetry_v12_typed_attributions ua ON ua.id=u.attribution_id
      LEFT JOIN ${s}.typed_telemetry_dictionary uaplan ON uaplan.id=ua.plan_type_id
      LEFT JOIN ${s}.telemetry_v12_typed_quota q ON q.record_id=r.id
      LEFT JOIN ${s}.typed_telemetry_dictionary qplan ON qplan.id=q.plan_type_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qvariant ON qvariant.id=q.plan_variant_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qlimit ON qlimit.id=q.limit_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qslot ON qslot.id=q.slot_id
      LEFT JOIN ${s}.telemetry_v12_typed_attributions qa ON qa.id=q.attribution_id
      LEFT JOIN ${s}.typed_telemetry_dictionary qaplan ON qaplan.id=qa.plan_type_id
     ORDER BY r.occurrence_id,r.observed_at_ms,r.manifest_id COLLATE "C",r.record_index`;
}

/** d43c8f92 telemetry-v12-effective-reader.ts normalizeV12Record. */
function v12AnalyticalRecord(stream: EffectiveTelemetryStream, value: TelemetryV12Record): string {
  const projected: Record<string, unknown> = { ...(value as unknown as Record<string, unknown>) };
  if (stream === "usage") {
    projected.schemaVersion = "usage-event-v1.1";
    delete projected.boundaryFlags;
    delete projected.tieOrder;
    delete projected.cacheWriteTtl;
  } else {
    projected.schemaVersion = stream === "quota" ? "quota-observation-v1.1" : "session-dimension-v1.1";
  }
  try {
    return canonicalTelemetryV11Json(parseTelemetryV11Record(stream, projected) as TelemetryV11Record);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
}

type V12StorageRow = Record<string, unknown>;

/** d43c8f92 telemetry-v12-effective-reader.ts decodedRow, over 0025's columns. */
async function decodeV12Row(stream: EffectiveTelemetryStream, row: V12StorageRow): Promise<TelemetryV12EffectiveRecord> {
  const storageRowId = safeInteger(row.storage_row_id, 1);
  if (typeof row.manifest_id !== "string" || !/^[0-9a-f-]{36}$/iu.test(row.manifest_id)
      || row.stream !== stream) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  safeInteger(row.record_index, 0, 199);
  const typed = {
    ...row,
    occurrence_id: bytes(row.occurrence_id),
    observed_at_ms: safeInteger(row.observed_at_ms, MIN_MS, MAX_MS),
    observed_day: safeInteger(row.observed_day, -100_000, 100_000),
    canonical_digest: bytes(row.canonical_digest),
    session_id: row.session_id === null || row.session_id === undefined ? null : bytes(row.session_id),
    total_input_context_tokens: nullableInteger(row.total_input_context_tokens),
    input_uncached_tokens: nullableInteger(row.input_uncached_tokens),
    input_cache_read_tokens: nullableInteger(row.input_cache_read_tokens),
    input_cache_write_tokens: nullableInteger(row.input_cache_write_tokens),
    output_text_tokens: nullableInteger(row.output_text_tokens),
    output_reasoning_tokens: nullableInteger(row.output_reasoning_tokens),
    output_combined_tokens: nullableInteger(row.output_combined_tokens),
    cache_write_ttl_five_minute_tokens: nullableInteger(row.cache_write_ttl_five_minute_tokens),
    cache_write_ttl_one_hour_tokens: nullableInteger(row.cache_write_ttl_one_hour_tokens),
    used_percent: row.used_percent === null ? null : Number(row.used_percent),
    window_duration_minutes: nullableInteger(row.window_duration_minutes, 527_040),
    resets_at_ms: row.resets_at_ms === null ? null : safeInteger(row.resets_at_ms, MIN_MS, MAX_MS),
    account_basis: row.account_basis === null ? null : safeInteger(row.account_basis, 0, 2),
    account_track: row.account_track === null || row.account_track === undefined ? null : bytes(row.account_track),
    plan_basis: row.plan_basis === null ? null : safeInteger(row.plan_basis, 0, 3),
    plan_era: row.plan_era === null || row.plan_era === undefined ? null : bytes(row.plan_era),
  } as unknown as TelemetryV12TypedRecordRow;
  let decoded: ReturnType<typeof decodeTelemetryV12Record>;
  try {
    decoded = decodeTelemetryV12Record(typed, stream === "session" ? sessionTools(row.tool_json) : null);
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  if (hex(typed.canonical_digest) !== await sha256Hex(decoded.canonicalRecord)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  let sourceRecord: TelemetryV12Record;
  try {
    sourceRecord = JSON.parse(decoded.canonicalRecord) as TelemetryV12Record;
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const record = sourceRecord as unknown as Record<string, unknown>;
  const occurrenceId = stream === "usage" ? record.eventId : stream === "quota" ? record.observationId : record.sessionUuid;
  if (typeof occurrenceId !== "string" || !OCCURRENCE_ID.test(occurrenceId)
      || occurrenceId !== occurrenceText(typed.occurrence_id)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  const observedAtMs = safeInteger(decoded.observedAtMs, MIN_MS, MAX_MS);
  if (Math.floor(observedAtMs / DAY_MS) !== typed.observed_day) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  return Object.freeze({
    stream, occurrenceId, observedAt: new Date(observedAtMs).toISOString(), observedAtMs,
    sourceRecordJson: decoded.canonicalRecord,
    recordJson: v12AnalyticalRecord(stream, sourceRecord),
    sourceRecordKey: `v12:record:${storageRowId}`,
  }) as TelemetryV12EffectiveRecord;
}

// ---------------------------------------------------------------------------
// Usage-correction facts (d43c8f92 telemetry-usage-correction-repository.ts)
// ---------------------------------------------------------------------------

/** $1 owner digest hex, $2/$3 event-time window [from, through). */
function correctionCandidatesSql(s: string): string {
  return `SELECT div(h.event_time_ms,${DAY_MS})::integer AS observed_day,h.occurrence_id,
          min(h.event_time_ms)::text AS observed_at_ms
     FROM ${s}.telemetry_usage_correction_history h
     JOIN ${s}.telemetry_usage_correction_facts f ON f.history_id=h.id
    WHERE h.owner_digest=decode($1,'hex') AND h.event_time_ms>=$2 AND h.event_time_ms<$3
    GROUP BY div(h.event_time_ms,${DAY_MS}),h.occurrence_id`;
}

/** $1 owner digest hex, $2 occurrence ids (hex text[]), $3 limit. */
function correctionVariantsSql(s: string): string {
  return `WITH requested AS MATERIALIZED (
      SELECT DISTINCT decode(value,'hex') AS occurrence_id FROM unnest($2::text[]) value
    ), representatives AS MATERIALIZED (
      SELECT min(f.id) AS fact_id
        FROM ${s}.telemetry_usage_correction_history h
        JOIN ${s}.telemetry_usage_correction_facts f ON f.history_id=h.id AND f.method_version=1
       WHERE h.owner_digest=decode($1,'hex') AND h.occurrence_id IN (SELECT occurrence_id FROM requested)
       GROUP BY h.source_format,h.device_id,h.occurrence_id,h.event_time_ms,h.record_digest
    ), selected AS (
      SELECT fact_id FROM representatives ORDER BY fact_id LIMIT $3
    )
    SELECT h.*,f.id AS fact_id,f.method_version AS fact_method_version,f.captured_at_ms AS fact_captured_at_ms,
           provider.value AS provider_value,session.value AS session_blob,model.value AS model_value,
           speed.value AS speed_mode_value,tier.value AS api_service_tier_value,surface.value AS surface_value,
           billing.value AS billing_surface_value,effort.value AS reasoning_effort_value,
           scope.value AS agent_scope_value,outcome.value AS outcome_value,
           attribution.account_basis AS attribution_account_basis,
           attribution.account_track AS attribution_account_track_blob,
           attribution.plan_basis AS attribution_plan_basis,
           attribution_plan.value AS attribution_plan_type_value,
           attribution.plan_era AS attribution_plan_era_blob
      FROM selected
      JOIN ${s}.telemetry_usage_correction_facts f ON f.id=selected.fact_id AND f.method_version=1
      JOIN ${s}.telemetry_usage_correction_history h ON h.id=f.history_id
      JOIN ${s}.typed_telemetry_dictionary provider ON provider.id=h.provider_id
      JOIN ${s}.typed_telemetry_identifiers session ON session.id=h.session_id
      JOIN ${s}.typed_telemetry_dictionary model ON model.id=h.model_id
      JOIN ${s}.typed_telemetry_dictionary speed ON speed.id=h.speed_mode_id
      JOIN ${s}.typed_telemetry_dictionary tier ON tier.id=h.api_service_tier_id
      JOIN ${s}.typed_telemetry_dictionary surface ON surface.id=h.surface_id
      JOIN ${s}.typed_telemetry_dictionary billing ON billing.id=h.billing_surface_id
      JOIN ${s}.typed_telemetry_dictionary effort ON effort.id=h.reasoning_effort_id
      JOIN ${s}.typed_telemetry_dictionary scope ON scope.id=h.agent_scope_id
      JOIN ${s}.typed_telemetry_dictionary outcome ON outcome.id=h.outcome_id
      LEFT JOIN ${s}.typed_telemetry_attributions attribution ON attribution.id=h.attribution_id
      LEFT JOIN ${s}.typed_telemetry_dictionary attribution_plan ON attribution_plan.id=attribution.plan_type_id
     ORDER BY f.id`;
}

function nullableId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const blob = bytes(value);
  return blob.length === 0 ? null : decodeTypedTelemetryId(blob);
}

/** d43c8f92 parseHistory/parseFact: rebuild, rehash and verify the source bytes. */
async function parseCorrectionFact(row: Record<string, unknown>): Promise<TelemetryUsageCorrectionFactRow> {
  const format = safeInteger(row.source_format, 10, 11) === 10 ? "v1" : "v11";
  const eventTimeMs = safeInteger(row.event_time_ms, MIN_MS, MAX_MS);
  const record: Record<string, unknown> = {
    schemaVersion: format === "v1" ? "usage-event-v1.0" : "usage-event-v1.1",
    eventId: occurrenceText(row.occurrence_id),
    eventTime: new Date(eventTimeMs).toISOString(),
    sessionUuid: decodeTypedTelemetryId(bytes(row.session_blob)),
    provider: text(row.provider_value, 64), modelId: text(row.model_value, 64),
    speedMode: text(row.speed_mode_value, 64), apiServiceTier: text(row.api_service_tier_value, 64),
    surface: text(row.surface_value, 64), billingSurface: text(row.billing_surface_value, 64),
    reasoningEffort: text(row.reasoning_effort_value, 64), agentScope: text(row.agent_scope_value, 64),
    outcome: text(row.outcome_value, 64), totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
    components: {
      inputUncachedTokens: nullableInteger(row.input_uncached_tokens),
      inputCacheReadTokens: nullableInteger(row.input_cache_read_tokens),
      inputCacheWriteTokens: nullableInteger(row.input_cache_write_tokens),
      outputTextTokens: nullableInteger(row.output_text_tokens),
      outputReasoningTokens: nullableInteger(row.output_reasoning_tokens),
      outputCombinedTokens: nullableInteger(row.output_combined_tokens),
    },
  };
  if (format === "v11") {
    record.accountPlanAttribution = {
      accountBasis: ACCOUNT_BASES[safeInteger(row.attribution_account_basis, 0, 2)],
      accountTrackId: nullableId(row.attribution_account_track_blob),
      planBasis: PLAN_BASES[safeInteger(row.attribution_plan_basis, 0, 3)],
      planType: text(row.attribution_plan_type_value, 64),
      planEraId: nullableId(row.attribution_plan_era_blob),
    };
  }
  const recordJson = canonicalTelemetryV11Json(record);
  let assertion: Awaited<ReturnType<typeof prepareUsageCorrectionAssertion>>;
  try {
    assertion = await prepareUsageCorrectionAssertion({ format, recordJson });
  } catch {
    return sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  if (assertion.recordDigest !== hex(row.record_digest) || assertion.baseDigest !== hex(row.base_digest)
      || safeInteger(row.fact_method_version, 1, 1) !== 1) {
    sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
  }
  const historyId = safeInteger(row.id, 1);
  // The fields reconcileGroups reads: id, source.format, source.occurrenceId
  // and recordJson. The remaining audit fields are filled from the same row.
  return Object.freeze({
    id: safeInteger(row.fact_id, 1),
    sourceHistoryId: historyId,
    participantId: text(row.participant_id),
    ownerDigest: hex(row.owner_digest),
    ownerRevision: safeInteger(row.owner_revision, 1),
    authorityEpoch: safeInteger(row.authority_epoch, 1),
    source: Object.freeze({
      format, namespaceId: safeInteger(row.namespace_id, 1), ownerId: safeInteger(row.owner_id, 1),
      deviceId: safeInteger(row.device_id, 1), chunkId: safeInteger(row.chunk_id, 1), manifestId: null,
      storageRowId: safeInteger(row.source_storage_row_id, 1), rowId: safeInteger(row.source_row_id, 1),
      occurrenceId: assertion.occurrenceId, eventTime: assertion.eventTime,
      chunkDigest: hex(row.source_chunk_digest), eventDigest: hex(row.source_event_digest),
      recordDigest: assertion.recordDigest, baseDigest: assertion.baseDigest,
    }),
    totalInputContextTokens: nullableInteger(row.total_input_context_tokens),
    outputCombinedTokens: nullableInteger(row.output_combined_tokens),
    recordJson,
    methodVersion: "usage-total-correction-v1",
    capturedAt: new Date(safeInteger(row.fact_captured_at_ms, 0, MAX_MS)).toISOString(),
  }) as TelemetryUsageCorrectionFactRow;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface Candidate {
  readonly occurrence_id: string;
  readonly observed_at_ms: number;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.observed_at_ms - right.observed_at_ms || compareText(left.occurrence_id, right.occurrence_id);
}

function addCandidates(target: Map<number, Map<string, Candidate>>, rows: readonly Record<string, unknown>[],
  fromDay: number, throughDay: number): void {
  for (const row of rows) {
    const day = safeInteger(row.observed_day, -100_000, 100_000);
    if (day < fromDay || day > throughDay) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
    const candidate = { occurrence_id: occurrenceText(row.occurrence_id),
      observed_at_ms: safeInteger(row.observed_at_ms, MIN_MS, MAX_MS) };
    let byOccurrence = target.get(day);
    if (!byOccurrence) target.set(day, byOccurrence = new Map());
    const previous = byOccurrence.get(candidate.occurrence_id);
    // Production keeps the earliest coordinate of an occurrence on a day.
    if (!previous || compareCandidates(candidate, previous) < 0) byOccurrence.set(candidate.occurrence_id, candidate);
  }
}

function usageRow(row: EffectiveUsageOccurrence): EffectiveTelemetryOccurrence {
  // d43c8f92 readEffectiveTelemetryOwnerDayPage's usage mapping.
  return Object.freeze({
    methodVersion: "effective-telemetry-owner-day-v1" as const, stream: "usage" as const,
    participantId: row.participantId, ownerDigest: row.ownerDigest, occurrenceId: row.occurrenceId,
    eventTime: row.eventTime, eventTimeConflict: row.eventTimeConflict,
    status: row.status === "compatible" ? "compatible" as const : "conflict" as const,
    sourceCount: row.sourceCount, sourceFormats: row.sourceFormats, sourceRowIds: row.sourceRowIds,
    sourceRecordKeys: row.sourceRecordKeys, recordJson: row.analyticalRecordJson,
  });
}

/**
 * Read one owner's effective occurrences for one stream over
 * [fromDay, throughDay], grouped by observed day. Days without candidates
 * are absent from the map (absence is "no evidence", never zero). Throws
 * AnalyticsV2SourceError (closed codes) or the vendored reader's
 * EffectiveUsageReaderError when a source group cannot be reconciled.
 */
export async function readOwnerOccurrences(
  context: AnalyticsV2SnapshotContext,
  options: ReadOwnerOccurrencesOptions,
): Promise<Map<AnalyticsV2Day, EffectiveTelemetryOccurrence[]>> {
  const s = quotedSchema(context.schema);
  const now = nowTimestamp(context.nowMs);
  const { ownerDigest, stream, fromDay, throughDay, maxCandidates } = normalizeOptions(options);
  return onReadSnapshot(context, async (client) => {
    const scope = await readOwnerScope(client, s, ownerDigest);
    const participantId = scope.participantId;
    const sourceNamespace = scope.v1Namespace ?? scope.v11Namespace ?? "";
    const streamBinds = [ownerDigest, participantId, STREAM_CODES[stream], stream];

    // 1. Candidates per observed day.
    const candidates = new Map<number, Map<string, Candidate>>();
    if (scope.v1Namespace !== null || scope.v11Namespace !== null) {
      const legacy = await client.query<Record<string, unknown>>(legacyCandidatesSql(s),
        [...streamBinds, fromDay, throughDay]);
      addCandidates(candidates, legacy.rows, fromDay, throughDay);
    }
    if (scope.v12HeadActive) {
      const v12 = await client.query<Record<string, unknown>>(v12CandidatesSql(s),
        [participantId, stream, now, dayFromNumber(fromDay), dayFromNumber(throughDay)]);
      addCandidates(candidates, v12.rows, fromDay, throughDay);
    }
    const corrections = stream === "usage" && scope.correctionActive;
    if (corrections) {
      const archive = await client.query<Record<string, unknown>>(correctionCandidatesSql(s),
        [ownerDigest, fromDay * DAY_MS, (throughDay + 1) * DAY_MS]);
      addCandidates(candidates, archive.rows, fromDay, throughDay);
    }
    let candidateCount = 0;
    for (const byOccurrence of candidates.values()) candidateCount += byOccurrence.size;
    if (candidateCount > maxCandidates) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");

    // 2. Expand every candidate group across all days. Production expands
    // v1.2 usage sources only for a participant with a v1.2 head
    // (readV12EffectiveUsageSources), and v1.2 quota/session sources whenever
    // the v1.2 runtime is active (readEffectiveTelemetryOwnerDayPage).
    const expandV12 = stream === "usage" ? scope.v12HeadActive : scope.v12RuntimeActive;
    const occurrenceIds = [...new Set([...candidates.values()].flatMap((byOccurrence) => [...byOccurrence.keys()]))]
      .sort(compareText);
    const direct = new Map<string, TypedTelemetryCompatibilityRecord[]>();
    const v12 = new Map<string, TelemetryV12EffectiveRecord[]>();
    const facts = new Map<string, TelemetryUsageCorrectionFactRow[]>();
    const push = <T>(target: Map<string, T[]>, id: string, value: T): void => {
      const group = target.get(id);
      if (group) group.push(value); else target.set(id, [value]);
    };
    for (const batch of chunks(occurrenceIds, EXPANSION_BATCH)) {
      const encoded = batch.map(occurrenceHex);
      const requested = new Set(batch);
      if (scope.v1Namespace !== null || scope.v11Namespace !== null) {
        const rows = await client.query<LegacyRow>(legacySourcesSql(s), [...streamBinds, encoded]);
        if (rows.rows.length > MAX_BATCH_SOURCE_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
        const decoded: TypedTelemetryCompatibilityRecord[] = [];
        for (const row of rows.rows) decoded.push(await decodeLegacyRow(row, participantId, sourceNamespace, stream));
        // d43c8f92 readSourceBatches order: (occurrence id, physical row id).
        const physical = new Map(rows.rows.map((row, index) => [decoded[index]!, safeInteger(row.storage_row_id, 1)]));
        decoded.sort((left, right) => compareText(left.occurrence_id, right.occurrence_id)
          || physical.get(left)! - physical.get(right)!);
        for (const row of decoded) {
          if (!requested.has(row.occurrence_id)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
          push(direct, row.occurrence_id, row);
        }
      }
      if (expandV12) {
        const rows = await client.query<V12StorageRow>(v12OccurrencesSql(s),
          [participantId, stream, now, encoded, MAX_BATCH_V12_ROWS + 1]);
        if (rows.rows.length > MAX_BATCH_V12_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
        for (const row of rows.rows) {
          const record = await decodeV12Row(stream, row);
          if (!requested.has(record.occurrenceId)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
          push(v12, record.occurrenceId, record);
        }
      }
      if (corrections) {
        const rows = await client.query<Record<string, unknown>>(correctionVariantsSql(s),
          [ownerDigest, encoded, MAX_BATCH_SOURCE_ROWS + 1]);
        if (rows.rows.length > MAX_BATCH_SOURCE_ROWS) sourceFail("ANALYTICS_V2_SOURCE_LIMIT");
        for (const row of rows.rows) {
          const fact = await parseCorrectionFact(row);
          if (fact.ownerDigest !== ownerDigest || fact.participantId !== participantId
              || !requested.has(fact.source.occurrenceId)) sourceFail("ANALYTICS_V2_SOURCE_CONFLICT");
          push(facts, fact.source.occurrenceId, fact);
        }
      }
    }

    // 3. Reconcile per observed day with the vendored d43c8f92 kernels.
    const output = new Map<AnalyticsV2Day, EffectiveTelemetryOccurrence[]>();
    for (const day of [...candidates.keys()].sort((left, right) => left - right)) {
      const ordered = [...candidates.get(day)!.values()].sort(compareCandidates);
      const ids = ordered.map((candidate) => candidate.occurrence_id);
      const dayDirect = ids.flatMap((id) => direct.get(id) ?? []);
      const dayV12 = ids.flatMap((id) => v12.get(id) ?? []);
      let rows: EffectiveTelemetryOccurrence[];
      if (stream === "usage") {
        const dayFacts = ids.flatMap((id) => facts.get(id) ?? []).sort((left, right) => left.id - right.id);
        const v12Sources = dayV12.map((record) => ({ source_record_key: record.sourceRecordKey,
          occurrence_id: record.occurrenceId, observed_at: record.observedAt,
          record_json: record.sourceRecordJson, canonical_digest: "" }));
        const reconciled = await reconcileGroups(ownerDigest, participantId, dayFromNumber(day), ordered,
          dayDirect, v12Sources, dayFacts);
        rows = reconciled.map(usageRow);
      } else {
        rows = ordered.map((candidate) => genericOccurrence(ownerDigest, participantId, stream, candidate,
          dayDirect, dayV12));
      }
      output.set(dayFromNumber(day), rows);
    }
    return output;
  });
}
