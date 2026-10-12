// FROZEN ORACLE: the edca848 (production since 2026-10-10) v1.1 domain
// closure probes, byte-for-byte SQL from postgres-telemetry-v11-live-admission.ts
// assertTypedV1Transition (uncovered) and assertDomainClosure (legacyGap,
// previousGap). Each takes the same bind values as the live statement. The
// parity spec pins this file's sha256. Do not edit.
import { quotePostgresIdentifier } from "../../../src/postgres-client";
import { postgresClassificationLinkPredicate } from "./activation-oracle";

function t(s: string, name: string): string {
  return `${s}.${quotePostgresIdentifier(name)}`;
}

function correctedUsageEquivalent(s: string, beforeId: string, afterId: string): string {
  const shared = (row: string, usage: string) => `ROW(${row}.namespace_id, ${row}.owner_id, ${row}.occurrence_id,
      ${row}.observed_at_ms, ${row}.observed_day, ${row}.provider_id, ${usage}.session_id, ${usage}.model_id,
      ${usage}.speed_mode_id, ${usage}.api_service_tier_id, ${usage}.surface_id, ${usage}.billing_surface_id,
      ${usage}.reasoning_effort_id, ${usage}.agent_scope_id, ${usage}.outcome_id, ${usage}.input_uncached_tokens,
      ${usage}.input_cache_read_tokens, ${usage}.input_cache_write_tokens, ${usage}.output_text_tokens,
      ${usage}.output_reasoning_tokens)`;
  return `EXISTS (
    SELECT 1 FROM ${t(s, "typed_telemetry_records")} before_row
      JOIN ${t(s, "typed_telemetry_usage")} before_usage ON before_usage.record_id = before_row.id
      JOIN ${t(s, "typed_telemetry_records")} after_row ON after_row.id = ${afterId}
      JOIN ${t(s, "typed_telemetry_usage")} after_usage ON after_usage.record_id = after_row.id
     WHERE before_row.id = ${beforeId}
       AND EXISTS (SELECT 1 FROM ${t(s, "telemetry_usage_correction_runtime")} runtime
                    WHERE runtime.id = 1 AND runtime.source_state = 'active')
       AND before_row.stream = 1 AND after_row.stream = 1
       AND ${shared("after_row", "after_usage")} IS NOT DISTINCT FROM ${shared("before_row", "before_usage")}
       AND (before_usage.total_input_context_tokens IS NULL OR after_usage.total_input_context_tokens IS NULL
         OR after_usage.total_input_context_tokens = before_usage.total_input_context_tokens)
       AND (before_usage.output_combined_tokens IS NULL OR after_usage.output_combined_tokens IS NULL
         OR after_usage.output_combined_tokens = before_usage.output_combined_tokens))`;
}

/** [participantId, winners_json, candidateDays, activationDigest] */
export function frozenUncoveredSql(s: string): string {
  const winners = `winners AS MATERIALIZED (
       SELECT winner->>0 AS participant_id, (winner->>1)::date AS chunk_day, winner->>2 AS device_id
         FROM jsonb_array_elements($2::jsonb) winner)`;
  return `WITH ${winners},
     candidate_days AS MATERIALIZED (
       SELECT entry.day::date AS day, entry.manifest_id
         FROM jsonb_to_recordset($3::jsonb) AS entry(day text, manifest_id text))
     SELECT 1 FROM ${t(s, "telemetry_v1_chunks")} c
       JOIN ${t(s, "typed_v1_record_admissions")} p ON p.chunk_id = c.id
       JOIN ${t(s, "typed_telemetry_records")} r ON r.id = p.typed_record_id
       JOIN ${t(s, "typed_telemetry_owners")} old_owner ON old_owner.id = r.owner_id
       JOIN ${t(s, "typed_telemetry_devices")} old_device ON old_device.id = r.device_id
       JOIN ${t(s, "typed_telemetry_chunks")} old_chunk ON old_chunk.id = r.chunk_id
       LEFT JOIN candidate_days candidate ON candidate.day = c.chunk_day
      WHERE c.participant_id = $1 AND c.superseded_at IS NULL
        AND (c.participant_id, c.chunk_day, c.device_id) IN (SELECT participant_id, chunk_day, device_id FROM winners)
        AND (candidate.manifest_id IS NULL OR r.format <> 10
          OR r.namespace_id <> (SELECT namespace_id FROM ${t(s, "typed_v1_admission_state")})
          OR ${t(s, "typed_legacy_admission_decode_id")}(old_owner.original_id) <> c.participant_id
          OR ${t(s, "typed_legacy_admission_decode_id")}(old_device.original_id) <> c.device_id
          OR ${t(s, "typed_legacy_admission_decode_id")}(old_chunk.original_id) <> c.id
          OR r.observed_day <> (c.chunk_day - DATE '1970-01-01')
          OR NOT EXISTS (
            SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} successor
             WHERE successor.manifest_id = candidate.manifest_id AND successor.stream = c.stream
               AND successor.legacy_occurrence_id = ${t(s, "typed_legacy_admission_decode_id")}(r.occurrence_id)
               AND (successor.legacy_digest = r.canonical_digest
                 OR ${correctedUsageEquivalent(s, "r.id", "successor.typed_record_id")}
                 OR ${postgresClassificationLinkPredicate(s,"r.id","successor.typed_record_id",10,11,"$4::text")})))
      LIMIT 1`;
}

/** [participantId, winners_json, candidateDays, manifestDigest] */
export function frozenLegacyGapSql(s: string): string {
  return `WITH candidate_days AS MATERIALIZED (
       SELECT entry.day::date AS day, entry.manifest_id
         FROM jsonb_to_recordset($3::jsonb) AS entry(day text, manifest_id text)),
     winners AS MATERIALIZED (
       SELECT winner->>0 AS participant_id, (winner->>1)::date AS observed_day, winner->>2 AS device_id
         FROM jsonb_array_elements($2::jsonb) winner)
     SELECT 1 FROM ${t(s, "telemetry_v1_records")} old_row
       LEFT JOIN ${t(s, "typed_v1_preservation_proofs")} old_proof ON old_proof.source_row_id = old_row.id
       LEFT JOIN candidate_days candidate ON candidate.day = old_row.observed_day
      WHERE old_row.participant_id = $1
        AND (old_row.participant_id, old_row.observed_day, old_row.device_id) IN (
          SELECT participant_id, observed_day, device_id FROM winners)
        AND (old_proof.source_row_id IS NULL OR candidate.manifest_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} new_row
           WHERE new_row.manifest_id = candidate.manifest_id AND new_row.stream = old_row.stream
             AND new_row.legacy_occurrence_id = old_row.occurrence_id
             AND (new_row.legacy_digest = old_proof.canonical_digest OR EXISTS (
               SELECT 1 FROM ${t(s,"typed_telemetry_records")} old_typed
                WHERE old_typed.format=10 AND old_typed.source_row_id=old_row.id
                  AND ${postgresClassificationLinkPredicate(s,"old_typed.id","new_row.typed_record_id",10,11,"$4::text")}))))
      LIMIT 1`;
}

/** [previousGenerationId, candidateDays, manifestDigest] */
export function frozenPreviousGapSql(s: string): string {
  return `WITH candidate_days AS MATERIALIZED (
         SELECT entry.day::date AS day, entry.manifest_id
           FROM jsonb_to_recordset($2::jsonb) AS entry(day text, manifest_id text))
       SELECT 1 FROM ${t(s, "telemetry_v11_domain_days")} previous_day
         JOIN ${t(s, "typed_v11_record_admissions")} old_row ON old_row.manifest_id = previous_day.manifest_id
         LEFT JOIN candidate_days candidate ON candidate.day = previous_day.observed_day
        WHERE previous_day.generation_id = $1 AND (candidate.manifest_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${t(s, "typed_v11_record_admissions")} new_row
           WHERE new_row.manifest_id = candidate.manifest_id AND new_row.stream = old_row.stream
             AND new_row.occurrence_id = old_row.occurrence_id
             AND (new_row.base_digest = old_row.base_digest
               OR ${correctedUsageEquivalent(s, "old_row.typed_record_id", "new_row.typed_record_id")}
               OR ${postgresClassificationLinkPredicate(s,"old_row.typed_record_id","new_row.typed_record_id",11,11,"$3::text")})))
        LIMIT 1`;
}
