-- Device credentials, upload grants, and accountless enrollment authority.
-- All rows remain in the primary schema because ingest must observe revocation
-- and deletion state atomically with the grant it consumes.
CREATE TABLE device_pairings (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  issued_by_session_id text NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  consent_version text NOT NULL,
  transport_consent_version text NOT NULL,
  state text NOT NULL DEFAULT 'unused'
    CHECK (state IN ('unused', 'consumed', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  claimed_device_id text
);
CREATE INDEX device_pairings_participant_state
  ON device_pairings(participant_id, state, expires_at);

CREATE TABLE accountless_enrollment_ledger (
  device_id text PRIMARY KEY,
  device_secret_hash bytea NOT NULL CHECK (octet_length(device_secret_hash) = 32),
  installation_principal_id text NOT NULL UNIQUE CHECK (length(installation_principal_id) BETWEEN 1 AND 120),
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 80),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 120),
  authorization_basis text NOT NULL CHECK (length(authorization_basis) BETWEEN 1 AND 120),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  renewal_generation integer NOT NULL DEFAULT 0 CHECK (renewal_generation >= 0),
  renewed_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX accountless_enrollment_ledger_state
  ON accountless_enrollment_ledger(state, expires_at, device_id);

CREATE TABLE accountless_enrollment_issuance (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  budget_day date NOT NULL,
  daily_issued integer NOT NULL DEFAULT 0 CHECK (daily_issued BETWEEN 0 AND 1000),
  lifetime_issued integer NOT NULL DEFAULT 0 CHECK (lifetime_issued BETWEEN 0 AND 10000),
  last_issue_token text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL
);
INSERT INTO accountless_enrollment_issuance(singleton, budget_day, updated_at)
VALUES (1, DATE '1970-01-01', TIMESTAMPTZ '1970-01-01 00:00:00+00');

CREATE TABLE device_credentials (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  authority_kind text NOT NULL DEFAULT 'social'
    CHECK (authority_kind IN ('social', 'accountless')),
  paired_via_pairing_id text UNIQUE REFERENCES device_pairings(id) ON DELETE CASCADE,
  accountless_enrollment_device_id text UNIQUE
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  revoked_at timestamptz,
  social_verified_at timestamptz,
  credential_generation integer NOT NULL DEFAULT 1 CHECK (credential_generation >= 1),
  CHECK ((authority_kind = 'social' AND paired_via_pairing_id IS NOT NULL
      AND accountless_enrollment_device_id IS NULL)
    OR (authority_kind = 'accountless' AND paired_via_pairing_id IS NULL
      AND accountless_enrollment_device_id IS NOT NULL))
);
CREATE INDEX device_credentials_participant_state
  ON device_credentials(participant_id, state, expires_at);
CREATE INDEX device_credentials_social_recheck
  ON device_credentials(participant_id, state, social_verified_at);

CREATE TABLE device_upload_authorizations (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  issued_by_device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  body_bytes integer NOT NULL CHECK (body_bytes > 0),
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  state text NOT NULL DEFAULT 'unused'
    CHECK (state IN ('unused', 'consuming', 'consumed', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  consume_lease_expires_at timestamptz,
  consumed_contribution_id text
);
CREATE INDEX device_upload_authorizations_participant_state
  ON device_upload_authorizations(participant_id, state, expires_at);
CREATE INDEX device_upload_authorizations_device_state
  ON device_upload_authorizations(issued_by_device_id, state, expires_at);

CREATE TABLE accountless_upload_owners (
  enrollment_device_id text PRIMARY KEY REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id text NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id text NOT NULL UNIQUE REFERENCES device_credentials(id) ON DELETE CASCADE,
  policy_version text NOT NULL CHECK (policy_version = 'accountless-opt-out-v1'),
  authorization_basis text NOT NULL CHECK (authorization_basis = 'accountless-policy-v1'),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz,
  revocation_reason text CHECK (revocation_reason IS NULL OR
    revocation_reason IN ('user_opt_out', 'security_reset', 'operator_containment')),
  CHECK (expires_at > authorized_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX accountless_upload_owners_active ON accountless_upload_owners(state, expires_at);

CREATE TABLE device_credential_rotations (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  prior_secret_hash bytea NOT NULL CHECK (octet_length(prior_secret_hash) = 32),
  replacement_secret_hash bytea NOT NULL CHECK (octet_length(replacement_secret_hash) = 32),
  attempt_id text NOT NULL,
  generation integer NOT NULL CHECK (generation >= 2),
  rotated_at timestamptz NOT NULL,
  retire_at timestamptz NOT NULL,
  recovery_proof_hash bytea CHECK (recovery_proof_hash IS NULL OR octet_length(recovery_proof_hash) = 32),
  UNIQUE (device_id, prior_secret_hash),
  UNIQUE (device_id, attempt_id)
);
CREATE INDEX device_credential_rotations_retire ON device_credential_rotations(retire_at, id);

CREATE TABLE device_pairing_events (
  id text PRIMARY KEY,
  pairing_id text NOT NULL REFERENCES device_pairings(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('issued', 'claimed')),
  occurred_at timestamptz NOT NULL,
  UNIQUE (pairing_id, kind)
);
CREATE INDEX device_pairing_events_velocity ON device_pairing_events(participant_id, kind, occurred_at);

CREATE TABLE accountless_v11_device_authorizations (
  enrollment_device_id text PRIMARY KEY REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id text NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id text NOT NULL UNIQUE REFERENCES device_credentials(id) ON DELETE CASCADE,
  telemetry_schema_version text NOT NULL CHECK (telemetry_schema_version = 'telemetry-contribution-v1.1'),
  field_dictionary_version text NOT NULL CHECK (field_dictionary_version = 'telemetry-v1.1-registry-2026-08-31.1'),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'ongoing-privacy-safe-telemetry-v1.1'),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz,
  revocation_reason text,
  CHECK (expires_at > authorized_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX accountless_v11_device_authorizations_active
  ON accountless_v11_device_authorizations(state, expires_at);
