PRAGMA foreign_keys = ON;

-- Local proposal only: resumable, content-free derived acquisition state.
-- No existing telemetry is rewritten or indexed by this migration.
CREATE TABLE community_analysis_work (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
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

CREATE TABLE community_analysis_work_parts (
  participant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('plan-anchors', 'plan-runs', 'plan-equal-time', 'fit-stats', 'eligible', 'endpoint-runs', 'endpoints')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 131072 AND payload_bytes = length(CAST(payload_json AS BLOB))),
  PRIMARY KEY (participant_id, run_id, component, payload_sha256),
  FOREIGN KEY (participant_id, run_id) REFERENCES community_analysis_work(participant_id, run_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- Content-addressed payloads are immutable. The active and staged manifests
-- may share a chunk; no late writer may change a verified payload in place.
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
