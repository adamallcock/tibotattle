-- LOCAL SAME-INGESTION TARGET ONLY. Apply after baseline 0060, typed storage,
-- typed-v1.1 admission 0001 and exact legacy preservation proofs 0002.
-- Replace only record completeness/identity/preservation reads. The baseline
-- predecessor authority, range bounds, day vector, old-v0.2 refusal, head CAS,
-- admission limits, consumption, publication and withdrawal guards are retained.
-- Digests are codec-generated and transaction-bound by the owning admission /
-- legacy-proof lanes; SQLite never reserializes canonical numeric JSON here.
-- This migration neither deletes evidence nor qualifies a retained-v1.1 import.
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
        AND new_row.base_digest = old_row.base_digest
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
