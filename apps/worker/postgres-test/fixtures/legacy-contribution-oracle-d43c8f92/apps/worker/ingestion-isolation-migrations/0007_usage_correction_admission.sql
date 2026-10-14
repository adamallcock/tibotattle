-- Forward exact-total correction admission. Every predecessor/CAS/completeness
-- guard remains in force. Only usage rows may tolerate NULL versus reported
-- exact totals, and only while the separately qualified correction runtime is
-- active. The two totals may not contradict another known total. Every other
-- shared field, split, occurrence, clock, provider, namespace and owner must be
-- byte-equivalent through immutable typed identifiers. Old source rows remain
-- retained for effective reconciliation; source digests are never rewritten.
-- Row-value IS compares nullable typed columns exactly without exceeding D1's
-- expression-depth budget through the existing nested admission views.
-- Raw legacy JSON proof and non-usage streams keep their exact old contract.
DROP TRIGGER telemetry_v11_domain_complete_before_insert;

CREATE TRIGGER telemetry_v11_domain_complete_before_insert
BEFORE INSERT ON telemetry_v11_domains
BEGIN
  -- This local new-target adapter does not constitute a qualified raw-v1.1
  -- migration. Never ignore retained JSON evidence, even outside the new range.
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_v11_admission_state WHERE id=1)
    OR EXISTS(SELECT 1 FROM telemetry_v11_records LIMIT 1)
    THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END;
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM telemetry_v11_current_predecessors x
    WHERE x.token_hash = NEW.predecessor_token_hash AND x.participant_id = NEW.participant_id
      AND x.device_id = NEW.device_id AND x.previous_generation_id IS NEW.previous_generation_id
      AND x.legacy_fingerprint = NEW.legacy_fingerprint AND x.input_revision = NEW.input_revision
      AND x.from_day >= NEW.from_day AND x.through_day <= NEW.through_day
  ) THEN RAISE(ABORT, 'telemetry_domain_predecessor_changed') END);
  -- Journal-only bound before any record-level closure scan: at most 30,000
  -- chunks / 6,000,000 records, matching the legacy source-pin journal budget.
  SELECT (CASE WHEN (SELECT COALESCE(SUM(m.expected_chunk_count), 0)
    FROM json_each(NEW.days_json) e JOIN telemetry_v11_day_manifests m
      ON m.id = json_extract(e.value, '$.manifestId')) > 30000
    THEN RAISE(ABORT, 'telemetry_domain_range_too_large') END);
  SELECT (CASE WHEN json_array_length(NEW.days_json) NOT BETWEEN 1 AND 4096
    OR json_array_length(NEW.days_json) != CAST(julianday(NEW.through_day) - julianday(NEW.from_day) + 1 AS INTEGER)
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.days_json) e
      LEFT JOIN telemetry_v11_day_manifests m ON m.id = json_extract(e.value, '$.manifestId')
      WHERE json_extract(e.value, '$.day') IS NOT date(NEW.from_day, '+' || e.key || ' days')
        OR m.id IS NULL OR m.participant_id != NEW.participant_id OR m.device_id != NEW.device_id
        OR m.chunk_day != json_extract(e.value, '$.day') OR m.manifest_digest != json_extract(e.value, '$.manifestDigest')
        OR m.state != 'ready'
        OR m.expected_chunk_count != (SELECT count(*) FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id)
        OR EXISTS (SELECT 1 FROM telemetry_v11_chunks c WHERE c.manifest_id = m.id
          AND c.record_count != (SELECT count(*) FROM typed_v11_record_admissions r WHERE r.chunk_id = c.id))
    ) THEN RAISE(ABORT, 'telemetry_domain_incomplete') END);
  SELECT (CASE WHEN EXISTS (
    SELECT r.stream, r.occurrence_id FROM json_each(NEW.days_json) e
    JOIN typed_v11_record_admissions r ON r.manifest_id = json_extract(e.value, '$.manifestId')
    GROUP BY r.stream, r.occurrence_id HAVING count(*) > 1
  ) THEN RAISE(ABORT, 'telemetry_domain_occurrence_conflict') END);
  -- Every legacy winning occurrence must survive with identical base semantics.
  -- A declared excluded count, equal row count, or same wire version is not proof.
  SELECT (CASE WHEN EXISTS (
    WITH candidate_days AS MATERIALIZED (
      SELECT json_extract(e.value, '$.day') AS day,
        json_extract(e.value, '$.manifestId') AS manifest_id FROM json_each(NEW.days_json) e
    ) SELECT 1 FROM telemetry_v1_records old_row
    JOIN telemetry_v11_domain_predecessors x ON x.token_hash = NEW.predecessor_token_hash
    LEFT JOIN typed_v1_preservation_proofs old_proof ON old_proof.source_row_id = old_row.id
    LEFT JOIN candidate_days candidate ON candidate.day = old_row.observed_day
    WHERE old_row.participant_id = NEW.participant_id
      AND (old_row.participant_id, old_row.observed_day, old_row.device_id) IN (
        SELECT json_extract(w.value, '$[0]'), json_extract(w.value, '$[1]'), json_extract(w.value, '$[2]') FROM json_each(x.winners_json) w)
      AND (old_proof.source_row_id IS NULL OR candidate.manifest_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM typed_v11_record_admissions new_row
        WHERE new_row.manifest_id = candidate.manifest_id
          AND new_row.stream = old_row.stream AND new_row.legacy_occurrence_id = old_row.occurrence_id
          AND new_row.legacy_digest = old_proof.canonical_digest
      ))
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
  SELECT (CASE WHEN EXISTS (
    WITH candidate_days AS MATERIALIZED (
      SELECT json_extract(e.value, '$.day') AS day,
        json_extract(e.value, '$.manifestId') AS manifest_id FROM json_each(NEW.days_json) e
    ) SELECT 1 FROM telemetry_v11_domain_days previous_day
    JOIN typed_v11_record_admissions old_row ON old_row.manifest_id = previous_day.manifest_id
    LEFT JOIN candidate_days candidate ON candidate.day = previous_day.observed_day
    WHERE previous_day.generation_id = NEW.previous_generation_id AND (candidate.manifest_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM typed_v11_record_admissions new_row
      WHERE new_row.manifest_id = candidate.manifest_id
        AND new_row.stream = old_row.stream AND new_row.occurrence_id = old_row.occurrence_id
        AND (new_row.base_digest = old_row.base_digest OR EXISTS(SELECT 1 FROM typed_telemetry_records before_row
        JOIN typed_telemetry_usage before_usage ON before_usage.record_id=before_row.id
        JOIN typed_telemetry_records after_row ON after_row.id=new_row.typed_record_id
        JOIN typed_telemetry_usage after_usage ON after_usage.record_id=after_row.id
        WHERE before_row.id=old_row.typed_record_id
          AND EXISTS(SELECT 1 FROM telemetry_usage_correction_runtime WHERE id=1 AND state='active')
          AND before_row.stream=1
          AND after_row.stream=1
          AND (after_row.namespace_id, after_row.owner_id, after_row.occurrence_id, after_row.observed_at_ms, after_row.observed_day, after_row.provider_id, after_usage.session_id, after_usage.model_id, after_usage.speed_mode_id, after_usage.api_service_tier_id, after_usage.surface_id, after_usage.billing_surface_id, after_usage.reasoning_effort_id, after_usage.agent_scope_id, after_usage.outcome_id, after_usage.input_uncached_tokens, after_usage.input_cache_read_tokens, after_usage.input_cache_write_tokens, after_usage.output_text_tokens, after_usage.output_reasoning_tokens)
            IS (before_row.namespace_id, before_row.owner_id, before_row.occurrence_id, before_row.observed_at_ms, before_row.observed_day, before_row.provider_id, before_usage.session_id, before_usage.model_id, before_usage.speed_mode_id, before_usage.api_service_tier_id, before_usage.surface_id, before_usage.billing_surface_id, before_usage.reasoning_effort_id, before_usage.agent_scope_id, before_usage.outcome_id, before_usage.input_uncached_tokens, before_usage.input_cache_read_tokens, before_usage.input_cache_write_tokens, before_usage.output_text_tokens, before_usage.output_reasoning_tokens)
          AND (before_usage.total_input_context_tokens IS NULL OR after_usage.total_input_context_tokens IS NULL OR after_usage.total_input_context_tokens=before_usage.total_input_context_tokens)
          AND (before_usage.output_combined_tokens IS NULL OR after_usage.output_combined_tokens IS NULL OR after_usage.output_combined_tokens=before_usage.output_combined_tokens)))
    ))
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
  -- A domain head is participant-wide analytical authority, not a day-level
  -- overlay. Even disjoint v0.2 history would disappear at cutover without a
  -- reviewed semantic replacement proof. Preserve the old lane until then.
  SELECT (CASE WHEN EXISTS (SELECT 1 FROM telemetry_contributions legacy
    WHERE legacy.participant_id = NEW.participant_id AND legacy.status = 'accepted'
      AND legacy.transport_schema_version = 'telemetry-contribution-v0.2'
  ) THEN RAISE(ABORT, 'telemetry_domain_compatibility_unproven') END);
END;

DROP TRIGGER typed_v1_v11_transition_unqualified;
CREATE TRIGGER typed_v1_v11_transition_unqualified BEFORE INSERT ON telemetry_v11_domains
WHEN EXISTS(SELECT 1 FROM typed_v1_admission_state)
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM typed_v1_admission_state a JOIN typed_v11_admission_state b
   ON b.namespace_id=a.namespace_id AND b.source_namespace=a.source_namespace
  WHERE a.id=1 AND b.id=1 AND a.runtime_contract_version=1 AND b.runtime_contract_version=1
 ) THEN RAISE(ABORT,'telemetry_domain_compatibility_unproven') END;
 -- Refuse a partially admitted current winner before proving its rows. The
 -- header count is authoritative, so an absent mapping cannot look like zero.
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM telemetry_v1_chunks c JOIN telemetry_v11_domain_predecessors x
   ON x.token_hash=NEW.predecessor_token_hash
  WHERE c.participant_id=NEW.participant_id AND c.superseded_at IS NULL
   AND (c.participant_id,c.chunk_day,c.device_id) IN (
    SELECT json_extract(w.value,'$[0]'),json_extract(w.value,'$[1]'),json_extract(w.value,'$[2]')
    FROM json_each(x.winners_json) w)
   AND (c.record_count!=c.accepted_record_count
    OR c.record_count!=(SELECT count(*) FROM typed_v1_record_admissions p WHERE p.chunk_id=c.id)
    OR NOT EXISTS(SELECT 1 FROM typed_v1_event_sources e WHERE e.chunk_id=c.id AND e.participant_id=c.participant_id
      AND e.source_namespace=(SELECT source_namespace FROM typed_v1_admission_state)))
 ) THEN RAISE(ABORT,'telemetry_domain_compatibility_unproven') END;
 SELECT CASE WHEN EXISTS(
  WITH candidate_days AS MATERIALIZED (
   SELECT json_extract(e.value,'$.day') day,json_extract(e.value,'$.manifestId') manifest_id
   FROM json_each(NEW.days_json) e
  )
  SELECT 1 FROM telemetry_v1_chunks c
  JOIN telemetry_v11_domain_predecessors x ON x.token_hash=NEW.predecessor_token_hash
  JOIN typed_v1_record_admissions p ON p.chunk_id=c.id
  JOIN typed_telemetry_records r ON r.id=p.typed_record_id
  JOIN typed_telemetry_compatibility_records old_row ON old_row.storage_row_id=r.id
  LEFT JOIN candidate_days candidate ON candidate.day=c.chunk_day
  WHERE c.participant_id=NEW.participant_id AND c.superseded_at IS NULL
   AND (c.participant_id,c.chunk_day,c.device_id) IN (
    SELECT json_extract(w.value,'$[0]'),json_extract(w.value,'$[1]'),json_extract(w.value,'$[2]')
    FROM json_each(x.winners_json) w)
   AND (candidate.manifest_id IS NULL OR r.format!=10
    OR r.namespace_id!=(SELECT namespace_id FROM typed_v1_admission_state)
    OR old_row.participant_id!=c.participant_id OR old_row.device_id!=c.device_id
    OR old_row.chunk_row_id!=c.id OR old_row.observed_day!=c.chunk_day
    OR NOT EXISTS(SELECT 1 FROM typed_v11_record_admissions successor
     WHERE successor.manifest_id=candidate.manifest_id AND successor.stream=c.stream
      AND successor.legacy_occurrence_id=old_row.occurrence_id
      AND (successor.legacy_digest=r.canonical_digest OR EXISTS(SELECT 1 FROM typed_telemetry_records before_row
        JOIN typed_telemetry_usage before_usage ON before_usage.record_id=before_row.id
        JOIN typed_telemetry_records after_row ON after_row.id=successor.typed_record_id
        JOIN typed_telemetry_usage after_usage ON after_usage.record_id=after_row.id
        WHERE before_row.id=r.id
          AND EXISTS(SELECT 1 FROM telemetry_usage_correction_runtime WHERE id=1 AND state='active')
          AND before_row.stream=1
          AND after_row.stream=1
          AND (after_row.namespace_id, after_row.owner_id, after_row.occurrence_id, after_row.observed_at_ms, after_row.observed_day, after_row.provider_id, after_usage.session_id, after_usage.model_id, after_usage.speed_mode_id, after_usage.api_service_tier_id, after_usage.surface_id, after_usage.billing_surface_id, after_usage.reasoning_effort_id, after_usage.agent_scope_id, after_usage.outcome_id, after_usage.input_uncached_tokens, after_usage.input_cache_read_tokens, after_usage.input_cache_write_tokens, after_usage.output_text_tokens, after_usage.output_reasoning_tokens)
            IS (before_row.namespace_id, before_row.owner_id, before_row.occurrence_id, before_row.observed_at_ms, before_row.observed_day, before_row.provider_id, before_usage.session_id, before_usage.model_id, before_usage.speed_mode_id, before_usage.api_service_tier_id, before_usage.surface_id, before_usage.billing_surface_id, before_usage.reasoning_effort_id, before_usage.agent_scope_id, before_usage.outcome_id, before_usage.input_uncached_tokens, before_usage.input_cache_read_tokens, before_usage.input_cache_write_tokens, before_usage.output_text_tokens, before_usage.output_reasoning_tokens)
          AND (before_usage.total_input_context_tokens IS NULL OR after_usage.total_input_context_tokens IS NULL OR after_usage.total_input_context_tokens=before_usage.total_input_context_tokens)
          AND (before_usage.output_combined_tokens IS NULL OR after_usage.output_combined_tokens IS NULL OR after_usage.output_combined_tokens=before_usage.output_combined_tokens)))))
 ) THEN RAISE(ABORT,'telemetry_domain_compatibility_unproven') END;
END;
