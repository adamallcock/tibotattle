-- Forward namespace-aware read/deletion prerequisite. This migration neither
-- imports retained rows nor opens the current-write allocator to another
-- origin. Existing unexplained origins or v1 ownership fail the upgrade.
PRAGMA legacy_alter_table=ON;
CREATE TABLE typed_v1_origin_upgrade_guard (n INTEGER CHECK(n=0));
INSERT INTO typed_v1_origin_upgrade_guard SELECT
 (SELECT count(*) FROM typed_v1_owner_memberships m
   LEFT JOIN typed_telemetry_owners o ON o.id=m.typed_owner_id
   LEFT JOIN typed_v1_admission_state s ON s.id=1
   WHERE o.id IS NULL OR o.namespace_id IS NOT s.namespace_id)
 +(SELECT count(*) FROM typed_telemetry_owners o
   JOIN typed_v1_admission_state s ON s.id=1
   WHERE o.namespace_id IS NOT s.namespace_id)
 +(SELECT count(*) FROM typed_telemetry_records r WHERE r.format=10 AND NOT EXISTS(
   SELECT 1 FROM typed_v1_owner_memberships m
   JOIN typed_telemetry_owners o ON o.id=m.typed_owner_id AND o.namespace_id=r.namespace_id
   JOIN typed_telemetry_compatibility_records c ON c.storage_row_id=r.id
   WHERE m.typed_owner_id=r.owner_id AND m.participant_id=c.participant_id))
 +(SELECT count(*) FROM typed_v1_event_sources e LEFT JOIN typed_v1_admission_state s
   ON s.id=1 AND s.source_namespace=e.source_namespace WHERE s.id IS NULL)
 +(SELECT count(*) FROM typed_telemetry_origin_contracts c
   WHERE EXISTS(SELECT 1 FROM typed_v1_admission_state s WHERE s.id=1)
    AND NOT EXISTS(SELECT 1 FROM typed_v1_admission_state s
      WHERE s.id=1 AND s.namespace_id=c.namespace_id AND s.source_namespace=c.source_namespace
       AND c.access_mode='current-write' AND c.registered_move_id IS NULL
       AND c.source_schema_digest='50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643'))
 +(SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM typed_v1_admission_state WHERE id=1)
    AND (EXISTS(SELECT 1 FROM typed_v1_owner_memberships)
      OR EXISTS(SELECT 1 FROM typed_telemetry_records WHERE format=10)
      OR EXISTS(SELECT 1 FROM typed_v1_event_sources)) THEN 1 ELSE 0 END);
DROP TABLE typed_v1_origin_upgrade_guard;

INSERT INTO typed_telemetry_origin_contracts(
 namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
 source_schema_digest,registered_move_id,registered_at)
SELECT s.namespace_id,n.original_id,'current-write',0,0,
 '50a6e8e2aa5325fab5e5efee7bd90c0464342ec3b1fa064f304c966f9b1ae643',NULL,
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM typed_v1_admission_state s JOIN typed_telemetry_namespaces n ON n.id=s.namespace_id
WHERE s.id=1 ON CONFLICT(namespace_id) DO NOTHING;

DROP VIEW typed_v1_current_records;
DROP TRIGGER typed_v1_record_membership;
DROP TRIGGER typed_v1_chunk_delete;

ALTER TABLE typed_v1_owner_memberships RENAME TO typed_v1_owner_memberships_single_origin;
CREATE TABLE typed_v1_owner_memberships (
 participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 namespace_id INTEGER NOT NULL,
 typed_owner_id INTEGER NOT NULL,
 PRIMARY KEY(participant_id,namespace_id),
 UNIQUE(typed_owner_id),
 FOREIGN KEY(typed_owner_id,namespace_id)
   REFERENCES typed_telemetry_owners(id,namespace_id) ON DELETE CASCADE
) STRICT;
INSERT INTO typed_v1_owner_memberships(participant_id,namespace_id,typed_owner_id)
 SELECT old.participant_id,owner.namespace_id,old.typed_owner_id
 FROM typed_v1_owner_memberships_single_origin old
 JOIN typed_telemetry_owners owner ON owner.id=old.typed_owner_id;
DROP TABLE typed_v1_owner_memberships_single_origin;
CREATE INDEX typed_v1_memberships_participant
 ON typed_v1_owner_memberships(participant_id,namespace_id,typed_owner_id);

CREATE TRIGGER typed_v1_owner_membership_guard BEFORE INSERT ON typed_v1_owner_memberships
BEGIN SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM typed_telemetry_owners candidate
 JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=candidate.namespace_id
 WHERE candidate.id=NEW.typed_owner_id AND candidate.namespace_id=NEW.namespace_id
  AND origin.v1_read_contract_version=2 AND (
   EXISTS(SELECT 1 FROM typed_telemetry_compatibility_records r
    WHERE r.owner_id=candidate.id AND r.namespace_id=candidate.namespace_id
     AND r.participant_id=NEW.participant_id AND r.format_code=10)
   OR EXISTS(SELECT 1 FROM typed_v1_owner_memberships existing
    JOIN typed_telemetry_owners existing_owner ON existing_owner.id=existing.typed_owner_id
    WHERE existing.participant_id=NEW.participant_id
     AND existing_owner.original_id=candidate.original_id))
) THEN RAISE(ABORT,'typed_v1_owner_mismatch') END; END;
CREATE TRIGGER typed_v1_owner_membership_immutable BEFORE UPDATE ON typed_v1_owner_memberships
WHEN OLD.participant_id IS NOT NEW.participant_id OR OLD.namespace_id IS NOT NEW.namespace_id
 OR OLD.typed_owner_id IS NOT NEW.typed_owner_id
BEGIN SELECT RAISE(ABORT,'typed_v1_owner_mismatch'); END;
CREATE TRIGGER typed_v1_owner_membership_retained BEFORE DELETE ON typed_v1_owner_memberships
WHEN EXISTS(SELECT 1 FROM participants WHERE id=OLD.participant_id)
BEGIN SELECT RAISE(ABORT,'typed_v1_owner_retained'); END;
CREATE TRIGGER typed_v1_owner_delete AFTER DELETE ON typed_v1_owner_memberships
BEGIN DELETE FROM typed_telemetry_owners
 WHERE id=OLD.typed_owner_id AND namespace_id=OLD.namespace_id; END;

CREATE TRIGGER typed_v1_record_membership BEFORE INSERT ON typed_v1_record_admissions
BEGIN SELECT CASE WHEN NOT EXISTS(
 SELECT 1 FROM typed_telemetry_compatibility_records r
 JOIN typed_v1_chunk_allocations a ON a.chunk_id=NEW.chunk_id AND a.namespace_id=r.namespace_id
 JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=r.namespace_id
 JOIN telemetry_v1_chunks c ON c.id=a.chunk_id
 WHERE r.storage_row_id=NEW.typed_record_id AND r.format_code=10 AND r.chunk_row_id=c.id
  AND r.participant_id=c.participant_id AND r.device_id=c.device_id AND r.stream=c.stream
  AND r.observed_day=c.chunk_day AND r.chunk_day=c.chunk_day AND substr(r.observed_at,1,10)=c.chunk_day
  AND r.source_row_id>=a.first_source_row_id AND r.source_row_id<a.first_source_row_id+a.record_count
  AND c.superseded_at IS NULL AND origin.v1_read_contract_version=2
  AND EXISTS(SELECT 1 FROM typed_v1_owner_memberships m
    WHERE m.participant_id=c.participant_id AND m.namespace_id=r.namespace_id AND m.typed_owner_id=r.owner_id)
  AND (SELECT count(*) FROM typed_v1_record_admissions WHERE chunk_id=c.id)<c.record_count
) THEN RAISE(ABORT,'typed_v1_record_membership_conflict') END; END;

CREATE TRIGGER typed_v1_chunk_delete BEFORE DELETE ON telemetry_v1_chunks
BEGIN DELETE FROM typed_telemetry_chunks WHERE format=10
 AND namespace_id=(SELECT namespace_id FROM typed_v1_chunk_allocations WHERE chunk_id=OLD.id)
 AND original_id=(SELECT chunk_original FROM typed_v1_chunk_allocations WHERE chunk_id=OLD.id); END;

CREATE VIEW typed_v1_current_records AS
SELECT v.storage_row_id AS storage_row_id,
 v.namespace_id AS namespace_id,
 v.owner_id AS owner_id,
 v.format_code AS format_code,
 v.stream_code AS stream_code,
 origin.source_namespace AS source_namespace,
 v.format AS format,
 v.source_row_id AS source_row_id,
 v.id AS id,
 c.participant_id AS participant_id,
 c.device_id AS device_id,
 c.id AS chunk_row_id,
 v.manifest_id AS manifest_id,
 v.stream AS stream,
 v.schema_version AS schema_version,
 v.occurrence_id AS occurrence_id,
 v.observed_at_ms AS observed_at_ms,
 v.observed_at AS observed_at,
 v.observed_day AS observed_day,
 c.chunk_day AS chunk_day,
 v.provider AS provider,
 v.model_id AS model_id,
 v.session_uuid AS session_uuid,
 v.speed_mode AS speed_mode,
 v.api_service_tier AS api_service_tier,
 v.surface AS surface,
 v.billing_surface AS billing_surface,
 v.reasoning_effort AS reasoning_effort,
 v.agent_scope AS agent_scope,
 v.outcome AS outcome,
 v.total_input_context_tokens AS total_input_context_tokens,
 v.input_uncached_tokens AS input_uncached_tokens,
 v.input_cache_read_tokens AS input_cache_read_tokens,
 v.input_cache_write_tokens AS input_cache_write_tokens,
 v.output_text_tokens AS output_text_tokens,
 v.output_reasoning_tokens AS output_reasoning_tokens,
 v.output_combined_tokens AS output_combined_tokens,
 v.plan_type AS plan_type,
 v.plan_variant AS plan_variant,
 v.limit_id AS limit_id,
 v.slot AS slot,
 v.used_percent AS used_percent,
 v.window_duration_minutes AS window_duration_minutes,
 v.resets_at_ms AS resets_at_ms,
 v.resets_at AS resets_at,
 v.attribution_id AS attribution_id,
 v.account_basis AS account_basis,
 v.account_track_id AS account_track_id,
 v.plan_basis AS plan_basis,
 v.attribution_plan_type AS attribution_plan_type,
 v.plan_era_id AS plan_era_id,
 v.usage_record_id AS usage_record_id,
 v.quota_record_id AS quota_record_id,
 v.canonical_sha256 AS canonical_sha256,
 v._namespace_blob AS _namespace_blob,
 v._owner_blob AS _owner_blob,
 v._device_blob AS _device_blob,
 v._chunk_blob AS _chunk_blob,
 v._manifest_blob AS _manifest_blob,
 v._occurrence_blob AS _occurrence_blob,
 v._session_blob AS _session_blob,
 v._account_track_blob AS _account_track_blob,
 v._plan_era_blob AS _plan_era_blob
FROM typed_v1_record_admissions proof
JOIN telemetry_v1_chunks c ON c.id=proof.chunk_id AND c.superseded_at IS NULL
JOIN typed_v1_chunk_allocations allocation ON allocation.chunk_id=c.id
JOIN typed_telemetry_compatibility_records v ON v.storage_row_id=proof.typed_record_id
 AND v.namespace_id=allocation.namespace_id
JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=v.namespace_id
 AND origin.v1_read_contract_version=2
JOIN typed_v1_owner_memberships owner ON owner.participant_id=c.participant_id
 AND owner.namespace_id=v.namespace_id AND owner.typed_owner_id=v.owner_id
WHERE v.format_code=10 AND v.participant_id=c.participant_id
 AND v.device_id=c.device_id AND v.chunk_row_id=c.id;
PRAGMA legacy_alter_table=OFF;
