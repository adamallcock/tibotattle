-- NEW TARGET ONLY. Install before typed copy. No retained-record rewrite is
-- authorized here; incoming quota rows derive exact analytical keys on insert.
CREATE TABLE typed_v1_analytical_empty_guard (empty INTEGER CHECK(empty=1));
INSERT INTO typed_v1_analytical_empty_guard VALUES(NOT EXISTS(SELECT 1 FROM typed_telemetry_quota LIMIT 1));
DROP TABLE typed_v1_analytical_empty_guard;
ALTER TABLE typed_telemetry_quota ADD COLUMN analysis_owner_id INTEGER REFERENCES typed_telemetry_owners(id);
ALTER TABLE typed_telemetry_quota ADD COLUMN analysis_observed_at_ms INTEGER;
ALTER TABLE typed_telemetry_quota ADD COLUMN analysis_source_row_id INTEGER;
CREATE TRIGGER typed_v1_quota_analysis_initial BEFORE INSERT ON typed_telemetry_quota
WHEN NEW.analysis_owner_id IS NOT NULL OR NEW.analysis_observed_at_ms IS NOT NULL OR NEW.analysis_source_row_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'typed_v1_analysis_keys_conflict'); END;
DROP TRIGGER typed_telemetry_quota_immutable;
CREATE TRIGGER typed_telemetry_quota_immutable BEFORE UPDATE ON typed_telemetry_quota
WHEN NOT(
 OLD.analysis_owner_id IS NULL AND OLD.analysis_observed_at_ms IS NULL AND OLD.analysis_source_row_id IS NULL
 AND NEW.record_id IS OLD.record_id AND NEW.stream IS OLD.stream AND NEW.dimensions_id IS OLD.dimensions_id
 AND NEW.limit_id IS OLD.limit_id AND NEW.slot_id IS OLD.slot_id AND NEW.used_percent IS OLD.used_percent
 AND NEW.window_duration_minutes IS OLD.window_duration_minutes AND NEW.resets_at_ms IS OLD.resets_at_ms
 AND EXISTS(SELECT 1 FROM typed_telemetry_records r WHERE r.id=OLD.record_id AND r.format=10
  AND NEW.analysis_owner_id IS r.owner_id AND NEW.analysis_observed_at_ms IS r.observed_at_ms AND NEW.analysis_source_row_id IS r.source_row_id)
)
BEGIN SELECT RAISE(ABORT,'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_v1_quota_analysis_keys AFTER INSERT ON typed_telemetry_quota
WHEN EXISTS(SELECT 1 FROM typed_telemetry_records WHERE id=NEW.record_id AND format=10)
BEGIN UPDATE typed_telemetry_quota SET
 analysis_owner_id=(SELECT owner_id FROM typed_telemetry_records WHERE id=NEW.record_id),
 analysis_observed_at_ms=(SELECT observed_at_ms FROM typed_telemetry_records WHERE id=NEW.record_id),
 analysis_source_row_id=(SELECT source_row_id FROM typed_telemetry_records WHERE id=NEW.record_id)
 WHERE record_id=NEW.record_id; END;
CREATE INDEX typed_v1_owner_observed ON typed_telemetry_records(owner_id,stream,observed_at_ms,source_row_id) WHERE format=10;
CREATE INDEX typed_v1_quota_reset ON typed_telemetry_quota
 (analysis_owner_id,limit_id,window_duration_minutes,
 CASE WHEN resets_at_ms>253402300799999 THEN 0 WHEN resets_at_ms< -62167219200000 THEN 1 ELSE 2 END,
 CASE WHEN resets_at_ms< -62167219200000 THEN -resets_at_ms ELSE resets_at_ms END,
 analysis_observed_at_ms,analysis_source_row_id)
 WHERE analysis_owner_id IS NOT NULL AND resets_at_ms IS NOT NULL AND used_percent IS NOT NULL;
CREATE TABLE typed_v1_analytical_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
INSERT INTO typed_v1_analytical_schema VALUES(1,1);
CREATE VIEW typed_v1_current_records AS
SELECT v.storage_row_id AS storage_row_id,
 v.namespace_id AS namespace_id,
 v.owner_id AS owner_id,
 v.format_code AS format_code,
 v.stream_code AS stream_code,
 s.source_namespace AS source_namespace,
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
FROM typed_v1_admission_state s JOIN typed_v1_record_admissions proof
 JOIN telemetry_v1_chunks c ON c.id=proof.chunk_id AND c.superseded_at IS NULL
 JOIN typed_telemetry_compatibility_records v ON v.storage_row_id=proof.typed_record_id
WHERE s.id=1 AND s.runtime_contract_version=1 AND v.namespace_id=s.namespace_id AND v.format_code=10
 AND v.participant_id=c.participant_id AND v.device_id=c.device_id AND v.chunk_row_id=c.id;
