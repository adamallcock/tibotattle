-- Focused owner-erasure extension for the canonical v1 qualification schema.
-- Load schema.sql and projections.sql first. This is a test-only extension,
-- not a deployable migration and not a claim of full PostgreSQL parity.

SET search_path = tibotattle_v1_test, pg_catalog;

-- The participant/chunk/record/admission graph is the same canonical v1
-- universe used by the transaction qualification. Erasure adds only the
-- lifecycle columns absent from that narrower ingestion schema.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS deletion_session_id text;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS identity_link_key text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS object_version text;

CREATE TABLE accountless_upload_owners (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  enrollment_device_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked'))
);

CREATE TABLE admin_action_audit (
  operation_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('started', 'completed', 'failed')),
  created_at timestamptz NOT NULL
);

CREATE TABLE web_sessions (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz
);

-- `authorizations` in schema.sql is the canonical v1 upload authorization.
-- The device table covers the additional accountless admission path.
CREATE TABLE device_upload_authorizations (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('unused', 'consuming', 'consumed', 'revoked')),
  consume_lease_expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE device_pairings (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('unused', 'active', 'revoked')),
  revoked_at timestamptz
);

CREATE TABLE device_credentials (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz
);

-- These are the legacy and staged v0.1 object journals. v1 objects stay in
-- canonical `chunks` and carry `object_key` plus the nullable version above.
CREATE TABLE contributions (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  r2_key text NOT NULL,
  object_version text,
  created_at timestamptz NOT NULL
);

CREATE TABLE telemetry_contributions (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  r2_key text NOT NULL,
  object_version text,
  created_at timestamptz NOT NULL
);

CREATE TABLE telemetry_v11_chunks (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  r2_key text NOT NULL,
  object_version text,
  created_at timestamptz NOT NULL
);

CREATE INDEX erasure_contributions_page
  ON contributions(participant_id, created_at, id);
CREATE INDEX erasure_telemetry_page
  ON telemetry_contributions(participant_id, created_at, id);
CREATE INDEX erasure_v11_page
  ON telemetry_v11_chunks(participant_id, created_at, id);

RESET search_path;
