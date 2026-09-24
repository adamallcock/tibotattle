-- Analytics work, prepared-source lifecycle, publication, administration,
-- delivery, routing, quarantine, and release-guard persistence.
--
-- The migration runner sets search_path to the validated primary schema for
-- this fragment. These tables intentionally keep the provider-neutral
-- operation keys explicit so every CAS/fence is checked in one transaction.

CREATE TABLE analytics_owner_state (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL CHECK (revision >= 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  state text NOT NULL CHECK (state IN ('active', 'withdrawn', 'erased')),
  PRIMARY KEY (source_id, owner_digest)
);

CREATE TABLE analytics_prepared_source_heads (
  source_id text NOT NULL,
  source_namespace text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  generation text NOT NULL,
  input_revision bigint NOT NULL CHECK (input_revision >= 0),
  owner_revision bigint NOT NULL CHECK (owner_revision >= 0),
  dependency_digest text NOT NULL CHECK (dependency_digest ~ '^[0-9a-f]{64}$'),
  method text NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  state text NOT NULL CHECK (state IN ('building', 'ready', 'discarding', 'retired')),
  progress_revision bigint NOT NULL CHECK (progress_revision >= 0),
  next_cursor_time bigint,
  next_cursor_id text,
  rows_written bigint NOT NULL CHECK (rows_written >= 0),
  PRIMARY KEY (source_id, owner_digest, day, generation),
  CHECK ((next_cursor_time IS NULL) = (next_cursor_id IS NULL))
);

CREATE TABLE analytics_prepared_source_rows (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  observed_day date NOT NULL,
  generation text NOT NULL,
  occurrence_id text NOT NULL,
  observed_at_ms bigint NOT NULL,
  input_revision bigint NOT NULL CHECK (input_revision >= 0),
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_id, owner_digest, observed_day, generation, occurrence_id)
);
CREATE INDEX analytics_prepared_source_page
  ON analytics_prepared_source_rows(source_id, owner_digest, observed_day, generation,
                                     observed_at_ms, occurrence_id);

CREATE TABLE analytics_analysis_work_heads (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('fits', 'model')),
  identity_json text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'claimed', 'checkpointing', 'complete', 'discarding', 'retired')),
  revision bigint NOT NULL CHECK (revision >= 0),
  head_digest text,
  checkpoint_generation text,
  claim_token text,
  lease_expires_ms bigint,
  PRIMARY KEY (source_id, owner_digest, day, metric)
);
CREATE TABLE analytics_analysis_work_parts (
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('fits', 'model')),
  generation text NOT NULL,
  part_index integer NOT NULL CHECK (part_index BETWEEN 0 AND 1023),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  payload_json text NOT NULL,
  expected_head text,
  control_json text NOT NULL,
  manifest_json text NOT NULL,
  complete boolean NOT NULL,
  PRIMARY KEY (source_id, owner_digest, day, metric, generation, part_index)
);

CREATE TABLE analytics_publication_captures (
  source_id text NOT NULL,
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('daily', 'model', 'graph')),
  generation text NOT NULL,
  cohort_digest text NOT NULL CHECK (cohort_digest ~ '^[0-9a-f]{64}$'),
  expected_members bigint NOT NULL CHECK (expected_members >= 0),
  payload_json text NOT NULL,
  policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
  collection_revision bigint NOT NULL CHECK (collection_revision >= 0),
  PRIMARY KEY (source_id, day, metric, generation)
);
CREATE TABLE analytics_publications (
  source_id text NOT NULL,
  day date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('daily', 'model', 'graph')),
  generation text NOT NULL,
  cohort_digest text NOT NULL CHECK (cohort_digest ~ '^[0-9a-f]{64}$'),
  authority_json text NOT NULL,
  payload_json text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  computed_at_ms bigint NOT NULL,
  policy_revision bigint NOT NULL CHECK (policy_revision >= 0),
  collection_revision bigint NOT NULL CHECK (collection_revision >= 0),
  PRIMARY KEY (source_id, day, metric)
);

CREATE TABLE collection_controls (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  revision bigint NOT NULL CHECK (revision >= 0),
  control_state text NOT NULL CHECK (control_state IN ('operational', 'degraded', 'contained')),
  enrollment_enabled boolean NOT NULL,
  upload_registration_enabled boolean NOT NULL,
  processing_enabled boolean NOT NULL,
  publication_enabled boolean NOT NULL,
  reason_code text,
  updated_at timestamptz NOT NULL
);
INSERT INTO collection_controls(singleton, revision, control_state,
  enrollment_enabled, upload_registration_enabled, processing_enabled,
  publication_enabled, updated_at)
VALUES (1, 0, 'contained', false, false, false, false, clock_timestamp())
ON CONFLICT (singleton) DO NOTHING;
CREATE TABLE admin_action_audit (
  operation_id text PRIMARY KEY,
  action text NOT NULL,
  actor_identity_digest text NOT NULL CHECK (actor_identity_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('started', 'success', 'failure')),
  details_json text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE pending_quarantine_objects (
  r2_key text PRIMARY KEY,
  contribution_id text NOT NULL,
  object_kind text NOT NULL CHECK (object_kind IN ('synthetic', 'telemetry', 'telemetry_v1', 'telemetry_v11', 'telemetry_v12')),
  registered_at timestamptz NOT NULL,
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('registered', 'deleting')),
  reconciliation_lease_id text
);
CREATE TABLE retention_state (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  state text NOT NULL CHECK (state IN ('idle', 'running', 'completed')),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  restored_participants_suppressed bigint NOT NULL DEFAULT 0,
  restore_replay_complete boolean NOT NULL DEFAULT false,
  quarantine_objects_deleted bigint NOT NULL DEFAULT 0,
  quarantine_retention_complete boolean NOT NULL DEFAULT false,
  failure_code text
);
INSERT INTO retention_state(singleton, state)
VALUES (1, 'idle') ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE storage_ingestion_changes (
  source_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  owner_revision bigint NOT NULL CHECK (owner_revision >= 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  kind text NOT NULL CHECK (kind IN ('source-updated', 'owner-active', 'owner-withdrawn', 'owner-erased')),
  recorded_ms bigint NOT NULL,
  PRIMARY KEY (source_id, sequence),
  UNIQUE (source_id, event_digest)
);
CREATE TABLE analytics_applied_events (
  source_id text NOT NULL,
  sequence bigint NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  projection_json text NOT NULL,
  PRIMARY KEY (source_id, sequence),
  UNIQUE (source_id, sequence, event_digest)
);
CREATE TABLE analytics_source_cursors (
  source_id text PRIMARY KEY,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0)
);
CREATE TABLE storage_source_state (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  source_id text NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0)
);

CREATE TABLE storage_owner_routes (
  owner_id text PRIMARY KEY,
  shard_id text NOT NULL,
  route_generation bigint NOT NULL CHECK (route_generation >= 0),
  state text NOT NULL CHECK (state IN ('active', 'moving'))
);
CREATE TABLE storage_owner_fences (
  owner_id text NOT NULL,
  shard_id text NOT NULL,
  route_generation bigint NOT NULL CHECK (route_generation >= 0),
  state text NOT NULL CHECK (state IN ('active', 'retired')),
  PRIMARY KEY (owner_id, shard_id, route_generation)
);

CREATE TABLE sparkle_appcast_guard_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
