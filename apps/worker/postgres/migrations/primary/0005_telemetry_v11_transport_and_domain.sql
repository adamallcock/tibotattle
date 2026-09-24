-- v1.1 transport staging and source-pinned domain tables.
CREATE TABLE attribution_enrollments (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  namespace text NOT NULL UNIQUE CHECK (namespace ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL
);

CREATE TABLE telemetry_transport_formats (
  schema_version text PRIMARY KEY,
  format_rank integer NOT NULL UNIQUE CHECK (format_rank IN (1, 2, 10, 11, 12)),
  lifecycle text NOT NULL CHECK (lifecycle IN ('accepted', 'staged', 'blocked'))
);
INSERT INTO telemetry_transport_formats(schema_version, format_rank, lifecycle) VALUES
  ('telemetry-contribution-v0.1', 1, 'accepted'),
  ('telemetry-contribution-v0.2', 2, 'blocked'),
  ('telemetry-contribution-v1.0', 10, 'accepted'),
  ('telemetry-contribution-v1.1', 11, 'staged');

CREATE TABLE telemetry_transport_participant_floors (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  minimum_rank integer NOT NULL DEFAULT 1 CHECK (minimum_rank IN (1, 2, 10, 11, 12)),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at timestamptz NOT NULL
);
CREATE TABLE telemetry_transport_device_floors (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  minimum_rank integer NOT NULL DEFAULT 1 CHECK (minimum_rank IN (1, 2, 10, 11, 12)),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (participant_id, device_id)
);
CREATE TABLE telemetry_transport_floor_rollbacks (
  operation_id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  participant_digest text NOT NULL CHECK (participant_digest ~ '^[0-9a-f]{64}$'),
  expected_revision integer NOT NULL CHECK (expected_revision >= 0),
  from_rank integer NOT NULL,
  to_rank integer NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (participant_id, expected_revision)
);

CREATE TABLE telemetry_v11_device_consents (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version text NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.1'),
  field_dictionary_version text NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'),
  consented_at timestamptz NOT NULL,
  PRIMARY KEY (participant_id, device_id)
);
CREATE INDEX telemetry_v11_consents_device ON telemetry_v11_device_consents(device_id);

CREATE TABLE telemetry_v11_day_manifests (
  id text PRIMARY KEY CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  chunk_day date NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  manifest_json text NOT NULL CHECK (length(manifest_json) <= 1250000),
  expected_chunk_count integer NOT NULL CHECK (expected_chunk_count BETWEEN 0 AND 4096),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'ready')),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  UNIQUE (participant_id, device_id, chunk_day, manifest_digest),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL))
);
CREATE INDEX telemetry_v11_manifests_device_day
  ON telemetry_v11_day_manifests(participant_id, device_id, chunk_day, created_at, id);
CREATE INDEX telemetry_v11_manifests_admission
  ON telemetry_v11_day_manifests(participant_id, device_id, created_at, id);
CREATE INDEX telemetry_v11_manifests_export
  ON telemetry_v11_day_manifests(participant_id, created_at, id);
CREATE INDEX telemetry_v11_manifests_device ON telemetry_v11_day_manifests(device_id);

CREATE TABLE telemetry_v11_chunks (
  id text PRIMARY KEY,
  manifest_id text NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  chunk_day date NOT NULL,
  chunk_seq integer NOT NULL CHECK (chunk_seq BETWEEN 0 AND 99999),
  chunk_id text NOT NULL,
  chunk_digest text NOT NULL CHECK (chunk_digest ~ '^[0-9a-f]{64}$'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  r2_key text NOT NULL UNIQUE,
  device_upload_authorization_id text NOT NULL UNIQUE REFERENCES device_upload_authorizations(id),
  quarantine_deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (manifest_id, chunk_id),
  UNIQUE (participant_id, envelope_digest)
);
CREATE INDEX telemetry_v11_chunks_participant ON telemetry_v11_chunks(participant_id, created_at, id);
CREATE INDEX telemetry_v11_chunks_device ON telemetry_v11_chunks(device_id);
CREATE INDEX telemetry_v11_chunks_retention ON telemetry_v11_chunks(created_at, id)
  WHERE quarantine_deleted_at IS NULL;

CREATE TABLE telemetry_v11_records (
  chunk_id text NOT NULL REFERENCES telemetry_v11_chunks(id) ON DELETE CASCADE,
  manifest_id text NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 8 AND 128),
  observed_at timestamptz NOT NULL,
  record_json text NOT NULL CHECK (length(record_json) <= 100000),
  legacy_occurrence_id text,
  legacy_record_json text,
  PRIMARY KEY (chunk_id, occurrence_id),
  UNIQUE (manifest_id, stream, occurrence_id),
  CHECK ((legacy_occurrence_id IS NULL) = (legacy_record_json IS NULL))
);
CREATE INDEX telemetry_v11_records_legacy_counterpart
  ON telemetry_v11_records(manifest_id, stream, legacy_occurrence_id);

CREATE TABLE telemetry_v11_domain_predecessors (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  previous_generation_id text,
  legacy_fingerprint text NOT NULL CHECK (legacy_fingerprint ~ '^[0-9a-f]{64}$'),
  input_revision integer NOT NULL CHECK (input_revision >= 0),
  from_day date NOT NULL,
  through_day date NOT NULL CHECK (through_day >= from_day),
  winners_json text NOT NULL CHECK (length(winners_json) <= 1250000),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX telemetry_v11_predecessors_participant
  ON telemetry_v11_domain_predecessors(participant_id, device_id, expires_at);
CREATE INDEX telemetry_v11_predecessors_device ON telemetry_v11_domain_predecessors(device_id);

CREATE TABLE telemetry_v11_domains (
  id text PRIMARY KEY CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  predecessor_token_hash text NOT NULL REFERENCES telemetry_v11_domain_predecessors(token_hash),
  previous_generation_id text,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  legacy_fingerprint text NOT NULL CHECK (legacy_fingerprint ~ '^[0-9a-f]{64}$'),
  input_revision integer NOT NULL CHECK (input_revision >= 0),
  from_day date NOT NULL,
  through_day date NOT NULL CHECK (through_day >= from_day),
  days_json text NOT NULL CHECK (length(days_json) <= 1250000),
  created_at timestamptz NOT NULL,
  UNIQUE (participant_id, device_id, manifest_digest)
);
CREATE INDEX telemetry_v11_domains_participant ON telemetry_v11_domains(participant_id, created_at, id);
CREATE INDEX telemetry_v11_domains_device ON telemetry_v11_domains(device_id);
CREATE INDEX telemetry_v11_domains_predecessor ON telemetry_v11_domains(predecessor_token_hash);

CREATE TABLE telemetry_v11_domain_days (
  generation_id text NOT NULL REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
  observed_day date NOT NULL,
  manifest_id text NOT NULL REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  PRIMARY KEY (generation_id, observed_day),
  UNIQUE (generation_id, manifest_id)
);
CREATE INDEX telemetry_v11_domain_days_manifest ON telemetry_v11_domain_days(manifest_id);

CREATE TABLE telemetry_v11_domain_heads (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  generation_id text NOT NULL UNIQUE REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL
);
