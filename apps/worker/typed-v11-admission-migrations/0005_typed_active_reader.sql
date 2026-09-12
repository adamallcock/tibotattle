-- Read only the same complete domain selected by the authoritative head. The
-- original namespace/source row IDs survive migration; destination rowids do not
-- become analytical identities. Canonical JSON is decoded in bounded JS pages.
-- The text occurrence is already part of the admission proof. One integer time
-- supplies chronological keyset seeks without duplicating payload or sorting a
-- whole manifest for every page. Existing proofs retain their exact bytes.
ALTER TABLE typed_v11_record_admissions ADD COLUMN observed_at_ms INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER typed_v11_record_proof_immutable;
UPDATE typed_v11_record_admissions SET observed_at_ms=(
  SELECT observed_at_ms FROM typed_telemetry_records r WHERE r.id=typed_record_id);
CREATE TRIGGER typed_v11_record_proof_immutable BEFORE UPDATE ON typed_v11_record_admissions
BEGIN SELECT RAISE(ABORT,'typed_v11_record_proof_immutable'); END;
CREATE TRIGGER typed_v11_record_time_guard BEFORE INSERT ON typed_v11_record_admissions
WHEN NEW.observed_at_ms IS NOT (SELECT observed_at_ms FROM typed_telemetry_records WHERE id=NEW.typed_record_id)
BEGIN SELECT RAISE(ABORT,'typed_v11_record_time_conflict'); END;
CREATE INDEX typed_v11_manifest_observed
  ON typed_v11_record_admissions(manifest_id,stream,observed_at_ms,occurrence_id);

CREATE VIEW typed_v11_active_records AS
SELECT r.storage_row_id, r.id, s.source_namespace, h.participant_id,
  h.generation_id, g.device_id, p.chunk_id AS chunk_row_id, p.manifest_id,
  d.observed_day, p.stream, p.occurrence_id,
  p.observed_at_ms, r.observed_at, r.provider, r.session_uuid,
  r.plan_type, r.plan_variant, r.limit_id, r.slot, r.used_percent,
  r.window_duration_minutes, r.resets_at,
  r.account_basis, r.account_track_id, r.plan_era_id, r.plan_basis
FROM typed_v11_admission_state s
JOIN telemetry_v11_domain_heads h
JOIN telemetry_v11_domains g ON g.id=h.generation_id
JOIN telemetry_v11_domain_days d ON d.generation_id=h.generation_id
JOIN typed_v11_record_admissions p ON p.manifest_id=d.manifest_id
JOIN typed_telemetry_compatibility_records r ON r.storage_row_id=p.typed_record_id
WHERE s.id=1 AND s.runtime_contract_version=1 AND r.namespace_id=s.namespace_id
  AND r.format_code=11 AND r.participant_id=h.participant_id AND r.device_id=g.device_id;
