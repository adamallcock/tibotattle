-- v1.2 usage, quota, and session transport.  Performance timing remains a
-- separate staged contract and has no table or activation path here.
INSERT INTO telemetry_transport_formats(schema_version, format_rank, lifecycle)
VALUES ('telemetry-contribution-v1.2', 12, 'staged');

CREATE TABLE telemetry_v12_runtime (
  id integer PRIMARY KEY CHECK (id = 1),
  state text NOT NULL CHECK (state IN ('staged', 'active', 'blocked')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at timestamptz NOT NULL
);
INSERT INTO telemetry_v12_runtime(id, state, changed_at)
VALUES (1, 'staged', TIMESTAMPTZ '1970-01-01 00:00:00+00');

CREATE TABLE telemetry_v12_device_capabilities (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version text NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.2'),
  field_dictionary_version text NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'),
  state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'revoked')),
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (participant_id, device_id)
);
CREATE INDEX telemetry_v12_capabilities_device ON telemetry_v12_device_capabilities(device_id, state);

CREATE TABLE accountless_v12_device_authorizations (
  enrollment_device_id text PRIMARY KEY REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id text NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id text NOT NULL UNIQUE REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version text NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.2'),
  field_dictionary_version text NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.2-registry-2026-09-20.1'),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.2'),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (expires_at > authorized_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX accountless_v12_device_authorizations_active
  ON accountless_v12_device_authorizations(state, expires_at);

CREATE TABLE telemetry_v12_day_manifests (
  id text PRIMARY KEY CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  chunk_day date NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  manifest_json text NOT NULL CHECK (length(manifest_json) <= 64000000),
  expected_chunk_count integer NOT NULL CHECK (expected_chunk_count BETWEEN 0 AND 4096),
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'ready')),
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  UNIQUE (participant_id, device_id, chunk_day, manifest_digest),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL))
);
CREATE INDEX telemetry_v12_manifests_device_day
  ON telemetry_v12_day_manifests(participant_id, device_id, chunk_day, created_at, id);
CREATE INDEX telemetry_v12_manifests_export
  ON telemetry_v12_day_manifests(participant_id, created_at, id);

CREATE TABLE telemetry_v12_chunks (
  id text PRIMARY KEY,
  manifest_id text NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE CASCADE,
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
CREATE INDEX telemetry_v12_chunks_participant ON telemetry_v12_chunks(participant_id, created_at, id);
CREATE INDEX telemetry_v12_chunks_device ON telemetry_v12_chunks(device_id);
CREATE INDEX telemetry_v12_chunks_retention ON telemetry_v12_chunks(created_at, id)
  WHERE quarantine_deleted_at IS NULL;

CREATE TABLE telemetry_v12_records (
  chunk_id text NOT NULL REFERENCES telemetry_v12_chunks(id) ON DELETE CASCADE,
  manifest_id text NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 8 AND 128),
  observed_at timestamptz NOT NULL,
  record_json text NOT NULL CHECK (length(record_json) <= 100000),
  PRIMARY KEY (chunk_id, occurrence_id),
  UNIQUE (manifest_id, stream, occurrence_id)
);
CREATE INDEX telemetry_v12_records_stream_time
  ON telemetry_v12_records(manifest_id, stream, observed_at, occurrence_id);

CREATE TABLE telemetry_v12_domain_predecessors (
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
CREATE INDEX telemetry_v12_predecessors_participant
  ON telemetry_v12_domain_predecessors(participant_id, device_id, expires_at);

CREATE TABLE telemetry_v12_domains (
  id text PRIMARY KEY CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  predecessor_token_hash text NOT NULL REFERENCES telemetry_v12_domain_predecessors(token_hash),
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
CREATE INDEX telemetry_v12_domains_participant ON telemetry_v12_domains(participant_id, created_at, id);

CREATE TABLE telemetry_v12_domain_days (
  generation_id text NOT NULL REFERENCES telemetry_v12_domains(id) ON DELETE CASCADE,
  observed_day date NOT NULL,
  manifest_id text NOT NULL REFERENCES telemetry_v12_day_manifests(id) ON DELETE CASCADE,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (generation_id, observed_day),
  UNIQUE (generation_id, manifest_id)
);
CREATE TABLE telemetry_v12_domain_heads (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  generation_id text NOT NULL UNIQUE REFERENCES telemetry_v12_domains(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL
);
