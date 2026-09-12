-- Optional same-source typed v1 -> typed v1.1 transition. Existing complete
-- domain admission, predecessor CAS, raw-v1 and v0.2 checks remain untouched.
-- The original header vector already pins typed v1's current winning device.
-- Only the physical occurrence/proof lookup changes; no JSON is synthesized.
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
      AND successor.legacy_occurrence_id=old_row.occurrence_id AND successor.legacy_digest=r.canonical_digest))
 ) THEN RAISE(ABORT,'telemetry_domain_compatibility_unproven') END;
END;
