// W2-SEAL fixture: one synthetic usage-correction history row and its fact for
// the ingestion D1 (the Q-1 corpus leaves both tables empty). Test-only and
// content-free: every number is a small constant, every digest is zeroblob(32),
// and the participant and owner are named by the caller from the sealed file.
//
// The caller drops D1's triggers on telemetry_usage_correction_history and
// _facts first (their provenance guards demand the exact typed row), and
// chooses the participant and owner link state it wants to test.

const PARTICIPANT = /^[A-Za-z0-9:_-]{1,128}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;

/**
 * INSERT statements for one history row (id) and its method-1 fact.
 * `ownerDigestHex` is the owner digest the history carries; pass the owner
 * link's digest for a matching link or another value for a mismatch.
 */
export function correctionHistorySql({ participantId, ownerDigestHex, ownerId, id = 1 }) {
  if (!PARTICIPANT.test(participantId) || !HEX_DIGEST.test(ownerDigestHex)
      || !Number.isSafeInteger(ownerId) || !Number.isSafeInteger(id)) {
    throw new TypeError("synthetic correction history arguments invalid");
  }
  const zero = "zeroblob(32)";
  return `INSERT INTO telemetry_usage_correction_history(id, participant_id, owner_digest, owner_revision, authority_epoch, source_format,
        namespace_id, owner_id, device_id, chunk_id, manifest_id, source_storage_row_id, source_row_id, occurrence_id, event_time_ms,
        provider_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id, billing_surface_id, reasoning_effort_id,
        agent_scope_id, outcome_id, attribution_id, total_input_context_tokens, input_uncached_tokens, input_cache_read_tokens,
        input_cache_write_tokens, output_text_tokens, output_reasoning_tokens, output_combined_tokens, source_chunk_digest,
        source_event_digest, record_digest, base_digest, captured_at_ms)
      VALUES (${id}, '${participantId}', X'${ownerDigestHex}', 1, 1, 10, 1, ${ownerId}, 1, 1, NULL, 1, 1, X'0102',
        1790000000000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, NULL, 100, 40, 30, 20, 10, 5, 15, ${zero}, ${zero}, ${zero}, ${zero}, 1790000000001);
    INSERT INTO telemetry_usage_correction_facts(id, history_id, method_version, captured_at_ms) VALUES (${id}, ${id}, 1, 1790000000001);`;
}
