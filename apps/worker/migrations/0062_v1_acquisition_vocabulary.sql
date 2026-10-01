PRAGMA foreign_keys = ON;

-- The v1 quota acquisition gained a pool-hull component (`reset-clusters`) and
-- an endpoint-hold component (`endpoint-holds`). SQLite cannot widen a CHECK in
-- place, so the two part tables are rebuilt rather than have their vocabularies
-- weakened. This migration changes no behaviour: it only stops the schema
-- pinning a component vocabulary the reader has outgrown.
--
-- Scope is deliberately the two `*_parts` tables and nothing else. The parent
-- work tables, the stage tables and every trigger on `participants` are left
-- untouched, because the databases this chain runs against do not all carry the
-- same set of them: the typed upload database has no
-- `community_model_history_participant_state` trigger, so dropping it would
-- fail there and recreating it would ADD a composition-day deletion that schema
-- deliberately lacks. Not rebuilding the parents also means `reader_policy`
-- (0052) and every other later column survive by construction rather than by a
-- copy list this file would have to keep in step.
--
-- The phase vocabulary is unchanged on purpose: the reader settles pool hulls
-- as a second leg of `plan`, so no new phase name is ever written, and
-- admitting one the loader rejects would be dead schema.
--
-- Each child is copied into a plain carry table before it is dropped, so no row
-- depends on `PRAGMA foreign_keys = OFF`, which SQLite ignores inside a
-- transaction. Dropping a child cannot cascade -- cascades run parent to child,
-- and the parents are never touched -- and the restored rows still satisfy the
-- unchanged foreign key because their parent rows never went away. Dropping a
-- table drops its triggers, so each `*_parts_immutable` trigger is recreated
-- verbatim.

CREATE TABLE community_analysis_work_parts_carry AS
  SELECT participant_id, run_id, component, payload_json, payload_sha256, payload_bytes
  FROM community_analysis_work_parts;
DROP TABLE community_analysis_work_parts;

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

CREATE TABLE community_model_history_work_parts_carry AS
  SELECT participant_id, run_id, component, payload_json, payload_sha256, payload_bytes
  FROM community_model_history_work_parts;
DROP TABLE community_model_history_work_parts;

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
