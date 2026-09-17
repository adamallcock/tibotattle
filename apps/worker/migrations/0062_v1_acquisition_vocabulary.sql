PRAGMA foreign_keys = ON;

-- The v1 quota acquisition gained a pool-hull component and an endpoint-hold
-- component. SQLite cannot widen a CHECK in place, so rebuild the two work
-- families rather than weaken their vocabularies. This migration changes no
-- behaviour: it only stops the schema pinning a component vocabulary the
-- reader has outgrown. The phase vocabulary is deliberately unchanged -- the
-- reader settles pool hulls as a second leg of `plan`, so no new phase name is
-- ever written, and admitting one the loader rejects would be dead schema.
--
-- Children are copied into plain carry tables before their parent is dropped,
-- so an ON DELETE CASCADE can never reach a row and the rebuild does not
-- depend on `PRAGMA foreign_keys = OFF`, which SQLite ignores inside a
-- transaction. Every row is restored under the widened checks.

-- community_analysis_work: copy both children out before the parent is touched, so no
-- cascade can ever reach a row, then restore them under the widened checks.
CREATE TABLE community_analysis_work_parts_carry AS SELECT participant_id, run_id, component, payload_json, payload_sha256, payload_bytes FROM community_analysis_work_parts;
CREATE TABLE community_analysis_work_stage_carry AS SELECT participant_id, run_id, stage_id, base_progress_revision, stage_revision, mode, target_phase, target_control_json, target_manifest_json, write_manifest_json, target_state_sha256, replay_json, write_offset, verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256 FROM community_analysis_work_stage;
DROP TABLE community_analysis_work_stage;
DROP TABLE community_analysis_work_parts;

CREATE TABLE community_analysis_work_next (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  reader_policy TEXT NOT NULL DEFAULT 'raw-source-pages-1'
    CHECK (reader_policy IN ('raw-source-pages-1', 'prepared-source-days-1')),
  run_id TEXT NOT NULL,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0 AND input_revision < 9007199254740991),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  source_kind TEXT NOT NULL CHECK (source_kind = 'v1'),
  source_method_version TEXT NOT NULL CHECK (length(source_method_version) BETWEEN 1 AND 2048),
  fixed_now TEXT NOT NULL,
  observed_at_cutoff TEXT NOT NULL,
  resets_at_cutoff TEXT NOT NULL,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  max_quota_rows INTEGER NOT NULL CHECK (max_quota_rows BETWEEN 1 AND 60000),
  phase TEXT NOT NULL CHECK (phase IN ('plan', 'fitability', 'endpoints', 'complete')),
  progress_revision INTEGER NOT NULL CHECK (progress_revision >= 0 AND progress_revision < 9007199254740991),
  control_json TEXT NOT NULL CHECK (json_valid(control_json) AND length(CAST(control_json AS BLOB)) <= 16384),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) <= 131072),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (participant_id, run_id)
) STRICT;

INSERT INTO community_analysis_work_next (participant_id, run_id, input_revision, input_fingerprint, source_kind, source_method_version, fixed_now, observed_at_cutoff, resets_at_cutoff, window_minutes, max_quota_rows, phase, progress_revision, control_json, manifest_json, state_sha256, reader_policy)
SELECT participant_id, run_id, input_revision, input_fingerprint, source_kind, source_method_version, fixed_now, observed_at_cutoff, resets_at_cutoff, window_minutes, max_quota_rows, phase, progress_revision, control_json, manifest_json, state_sha256, reader_policy FROM community_analysis_work;
DROP TABLE community_analysis_work;
ALTER TABLE community_analysis_work_next RENAME TO community_analysis_work;

CREATE TABLE community_analysis_work_parts (
  participant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('plan-anchors', 'plan-runs', 'plan-equal-time', 'reset-clusters', 'fit-stats', 'eligible', 'endpoint-runs', 'endpoint-holds', 'endpoints')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 131072 AND payload_bytes = length(CAST(payload_json AS BLOB))),
  PRIMARY KEY (participant_id, run_id, component, payload_sha256),
  FOREIGN KEY (participant_id, run_id) REFERENCES community_analysis_work(participant_id, run_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO community_analysis_work_parts (participant_id, run_id, component, payload_json, payload_sha256, payload_bytes)
SELECT participant_id, run_id, component, payload_json, payload_sha256, payload_bytes FROM community_analysis_work_parts_carry;
DROP TABLE community_analysis_work_parts_carry;

CREATE TRIGGER community_analysis_work_parts_immutable
BEFORE UPDATE ON community_analysis_work_parts
BEGIN
  SELECT RAISE(ABORT, 'community analysis part immutable');
END;

CREATE TABLE community_analysis_work_stage (
  participant_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  base_progress_revision INTEGER NOT NULL CHECK (base_progress_revision >= 0 AND base_progress_revision < 9007199254740990),
  stage_revision INTEGER NOT NULL CHECK (stage_revision >= 0 AND stage_revision < 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('writing', 'verifying', 'garbage_collecting', 'discarding')),
  target_phase TEXT NOT NULL CHECK (target_phase IN ('plan', 'fitability', 'endpoints', 'complete')),
  target_control_json TEXT NOT NULL CHECK (json_valid(target_control_json) AND length(CAST(target_control_json AS BLOB)) <= 16384),
  target_manifest_json TEXT NOT NULL CHECK (json_valid(target_manifest_json) AND json_type(target_manifest_json) = 'array' AND json_array_length(target_manifest_json) <= 1024 AND length(CAST(target_manifest_json AS BLOB)) <= 131072),
  write_manifest_json TEXT NOT NULL CHECK (json_valid(write_manifest_json) AND json_type(write_manifest_json) = 'array' AND json_array_length(write_manifest_json) <= 1024 AND length(CAST(write_manifest_json AS BLOB)) <= 131072),
  target_state_sha256 TEXT NOT NULL CHECK (length(target_state_sha256) = 64 AND target_state_sha256 NOT GLOB '*[^0-9a-f]*'),
  replay_json TEXT NOT NULL CHECK (json_valid(replay_json) AND length(CAST(replay_json AS BLOB)) <= 16384),
  write_offset INTEGER NOT NULL CHECK (write_offset BETWEEN 0 AND 1024),
  verified_offset INTEGER NOT NULL CHECK (verified_offset BETWEEN 0 AND 1024),
  gc_component TEXT NOT NULL,
  gc_sha256 TEXT NOT NULL,
  discard_input_revision INTEGER CHECK (discard_input_revision >= 0 AND discard_input_revision < 9007199254740991),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (participant_id, run_id) REFERENCES community_analysis_work(participant_id, run_id) ON DELETE CASCADE
) STRICT;

INSERT INTO community_analysis_work_stage (participant_id, run_id, stage_id, base_progress_revision, stage_revision, mode, target_phase, target_control_json, target_manifest_json, write_manifest_json, target_state_sha256, replay_json, write_offset, verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256)
SELECT participant_id, run_id, stage_id, base_progress_revision, stage_revision, mode, target_phase, target_control_json, target_manifest_json, write_manifest_json, target_state_sha256, replay_json, write_offset, verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256 FROM community_analysis_work_stage_carry;
DROP TABLE community_analysis_work_stage_carry;

DROP TRIGGER community_model_history_participant_state;

-- community_model_history_work: copy both children out before the parent is touched, so no
-- cascade can ever reach a row, then restore them under the widened checks.
CREATE TABLE community_model_history_work_parts_carry AS SELECT participant_id, run_id, component, payload_json, payload_sha256, payload_bytes FROM community_model_history_work_parts;
CREATE TABLE community_model_history_work_stage_carry AS SELECT participant_id, run_id, stage_id, base_progress_revision, stage_revision, mode, target_phase, target_control_json, target_manifest_json, write_manifest_json, target_state_sha256, replay_json, write_offset, verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256 FROM community_model_history_work_stage;
DROP TABLE community_model_history_work_stage;
DROP TABLE community_model_history_work_parts;

CREATE TABLE community_model_history_work_next (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  reader_policy TEXT NOT NULL DEFAULT 'raw-source-pages-1'
    CHECK (reader_policy IN ('raw-source-pages-1', 'prepared-source-days-1')),
  run_id TEXT NOT NULL,
  input_revision INTEGER NOT NULL CHECK (input_revision >= 0 AND input_revision < 9007199254740991),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  source_kind TEXT NOT NULL CHECK (source_kind = 'v1'),
  source_method_version TEXT NOT NULL CHECK (length(source_method_version) BETWEEN 1 AND 2048),
  fixed_now TEXT NOT NULL,
  observed_at_cutoff TEXT NOT NULL,
  resets_at_cutoff TEXT NOT NULL,
  window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
  max_quota_rows INTEGER NOT NULL CHECK (max_quota_rows BETWEEN 1 AND 60000),
  phase TEXT NOT NULL CHECK (phase IN ('plan', 'fitability', 'endpoints', 'complete')),
  progress_revision INTEGER NOT NULL CHECK (progress_revision >= 0 AND progress_revision < 9007199254740991),
  control_json TEXT NOT NULL CHECK (json_valid(control_json) AND length(CAST(control_json AS BLOB)) <= 16384),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) <= 131072),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (participant_id, run_id)
) STRICT;

INSERT INTO community_model_history_work_next (participant_id, run_id, input_revision, input_fingerprint, source_kind, source_method_version, fixed_now, observed_at_cutoff, resets_at_cutoff, window_minutes, max_quota_rows, phase, progress_revision, control_json, manifest_json, state_sha256, reader_policy)
SELECT participant_id, run_id, input_revision, input_fingerprint, source_kind, source_method_version, fixed_now, observed_at_cutoff, resets_at_cutoff, window_minutes, max_quota_rows, phase, progress_revision, control_json, manifest_json, state_sha256, reader_policy FROM community_model_history_work;
DROP TABLE community_model_history_work;
ALTER TABLE community_model_history_work_next RENAME TO community_model_history_work;

CREATE TABLE community_model_history_work_parts (
  participant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('plan-anchors', 'plan-runs', 'plan-equal-time', 'reset-clusters', 'fit-stats', 'eligible', 'endpoint-runs', 'endpoint-holds', 'endpoints')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 131072 AND payload_bytes = length(CAST(payload_json AS BLOB))),
  PRIMARY KEY (participant_id, run_id, component, payload_sha256),
  FOREIGN KEY (participant_id, run_id) REFERENCES community_model_history_work(participant_id, run_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO community_model_history_work_parts (participant_id, run_id, component, payload_json, payload_sha256, payload_bytes)
SELECT participant_id, run_id, component, payload_json, payload_sha256, payload_bytes FROM community_model_history_work_parts_carry;
DROP TABLE community_model_history_work_parts_carry;

CREATE TRIGGER community_model_history_work_parts_immutable
BEFORE UPDATE ON community_model_history_work_parts
BEGIN
  SELECT RAISE(ABORT, 'community analysis part immutable');
END;

CREATE TABLE community_model_history_work_stage (
  participant_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  base_progress_revision INTEGER NOT NULL CHECK (base_progress_revision >= 0 AND base_progress_revision < 9007199254740990),
  stage_revision INTEGER NOT NULL CHECK (stage_revision >= 0 AND stage_revision < 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('writing', 'verifying', 'garbage_collecting', 'discarding')),
  target_phase TEXT NOT NULL CHECK (target_phase IN ('plan', 'fitability', 'endpoints', 'complete')),
  target_control_json TEXT NOT NULL CHECK (json_valid(target_control_json) AND length(CAST(target_control_json AS BLOB)) <= 16384),
  target_manifest_json TEXT NOT NULL CHECK (json_valid(target_manifest_json) AND json_type(target_manifest_json) = 'array' AND json_array_length(target_manifest_json) <= 1024 AND length(CAST(target_manifest_json AS BLOB)) <= 131072),
  write_manifest_json TEXT NOT NULL CHECK (json_valid(write_manifest_json) AND json_type(write_manifest_json) = 'array' AND json_array_length(write_manifest_json) <= 1024 AND length(CAST(write_manifest_json AS BLOB)) <= 131072),
  target_state_sha256 TEXT NOT NULL CHECK (length(target_state_sha256) = 64 AND target_state_sha256 NOT GLOB '*[^0-9a-f]*'),
  replay_json TEXT NOT NULL CHECK (json_valid(replay_json) AND length(CAST(replay_json AS BLOB)) <= 16384),
  write_offset INTEGER NOT NULL CHECK (write_offset BETWEEN 0 AND 1024),
  verified_offset INTEGER NOT NULL CHECK (verified_offset BETWEEN 0 AND 1024),
  gc_component TEXT NOT NULL,
  gc_sha256 TEXT NOT NULL,
  discard_input_revision INTEGER CHECK (discard_input_revision >= 0 AND discard_input_revision < 9007199254740991),
  state_sha256 TEXT NOT NULL CHECK (length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY (participant_id, run_id) REFERENCES community_model_history_work(participant_id, run_id) ON DELETE CASCADE
) STRICT;

-- One bounded terminal result per account/date; incomplete work never enters.

INSERT INTO community_model_history_work_stage (participant_id, run_id, stage_id, base_progress_revision, stage_revision, mode, target_phase, target_control_json, target_manifest_json, write_manifest_json, target_state_sha256, replay_json, write_offset, verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256)
SELECT participant_id, run_id, stage_id, base_progress_revision, stage_revision, mode, target_phase, target_control_json, target_manifest_json, write_manifest_json, target_state_sha256, replay_json, write_offset, verified_offset, gc_component, gc_sha256, discard_input_revision, state_sha256 FROM community_model_history_work_stage_carry;
DROP TABLE community_model_history_work_stage_carry;

-- Restored verbatim from its CURRENT definition in 0059, not the superseded
-- 0048 body: only a social owner's state change clears the derived composition
-- days. Dropping that predicate would let any accountless owner's state change
-- wipe every day in the table.
CREATE TRIGGER community_model_history_participant_state
AFTER UPDATE OF state ON participants FOR EACH ROW WHEN OLD.state IS NOT NEW.state
BEGIN
  DELETE FROM community_model_history_work WHERE participant_id = NEW.id;
  DELETE FROM community_model_history_results WHERE participant_id = NEW.id;
  DELETE FROM community_model_composition_days WHERE history_method_version IS NOT NULL AND NEW.owner_kind='social';
END;
