-- Core participant, session, upload-authority, and hosted sign-in state.
--
-- These names deliberately match the D1 authority tables.  PostgreSQL is a
-- storage replacement for the same application state; it must not create a
-- second authority vocabulary that ingest cannot see.
CREATE TABLE participants (
  id text PRIMARY KEY,
  owner_kind text NOT NULL DEFAULT 'social'
    CHECK (owner_kind IN ('social', 'accountless')),
  access_token_id text UNIQUE,
  access_token_hash bytea,
  recovery_token_id text UNIQUE,
  recovery_token_hash bytea,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleting')),
  consent_version text,
  consented_at timestamptz,
  created_at timestamptz NOT NULL,
  deletion_session_id text,
  identity_link_key text
    CHECK (identity_link_key IS NULL OR identity_link_key ~ '^[0-9a-f]{64}$'),
  identity_cooldown_digest text
    CHECK (identity_cooldown_digest IS NULL OR identity_cooldown_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX participants_state ON participants(state, created_at, id);
CREATE INDEX participants_identity_link ON participants(identity_link_key)
  WHERE identity_link_key IS NOT NULL;

CREATE TABLE web_sessions (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  scope text NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'deletion_only')),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE INDEX web_sessions_participant_state ON web_sessions(participant_id, state, expires_at);
CREATE INDEX web_sessions_expiry ON web_sessions(state, expires_at);

CREATE TABLE upload_authorizations (
  id text PRIMARY KEY,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  issued_by_session_id text NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
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
CREATE INDEX upload_authorizations_participant_state
  ON upload_authorizations(participant_id, state, expires_at);
CREATE INDEX upload_authorizations_expiry ON upload_authorizations(state, expires_at);

CREATE TABLE recovery_retry_receipts (
  old_recovery_token_id text PRIMARY KEY,
  old_recovery_token_hash bytea NOT NULL CHECK (octet_length(old_recovery_token_hash) = 32),
  recovery_attempt_hash bytea NOT NULL CHECK (octet_length(recovery_attempt_hash) = 32),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  derivation_nonce text NOT NULL CHECK (derivation_nonce ~ '^[A-Za-z0-9_-]{43}$'),
  replacement_recovery_token_id text NOT NULL,
  replacement_session_id text NOT NULL UNIQUE REFERENCES web_sessions(id) ON DELETE CASCADE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count BETWEEN 0 AND 2)
);
CREATE INDEX recovery_retry_receipts_expiry ON recovery_retry_receipts(expires_at, old_recovery_token_id);

CREATE TABLE identity_reenrollment_cooldowns (
  identity_cooldown_digest text PRIMARY KEY
    CHECK (identity_cooldown_digest ~ '^[0-9a-f]{64}$'),
  participant_id text REFERENCES participants(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX identity_reenrollment_cooldowns_retention
  ON identity_reenrollment_cooldowns(expires_at, identity_cooldown_digest);

CREATE TABLE apple_signin_handoffs (
  state text PRIMARY KEY,
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  binding_hash text CHECK (binding_hash IS NULL OR binding_hash ~ '^[0-9a-f]{64}$'),
  claim_id text,
  claimed_at timestamptz,
  identity_link_key text CHECK (identity_link_key IS NULL OR identity_link_key ~ '^[0-9a-f]{64}$'),
  proof text UNIQUE CHECK (proof IS NULL OR proof ~ '^[A-Za-z0-9_-]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz
);
CREATE INDEX apple_signin_handoffs_expires_at ON apple_signin_handoffs(expires_at, state);
CREATE INDEX apple_signin_handoffs_claim ON apple_signin_handoffs(state, claim_id, claimed_at);

CREATE TABLE google_signin_handoffs (
  state text PRIMARY KEY,
  code_verifier text,
  binding_hash text CHECK (binding_hash IS NULL OR binding_hash ~ '^[0-9a-f]{64}$'),
  claim_id text,
  claimed_at timestamptz,
  identity_link_key text CHECK (identity_link_key IS NULL OR identity_link_key ~ '^[0-9a-f]{64}$'),
  proof text UNIQUE CHECK (proof IS NULL OR proof ~ '^[A-Za-z0-9_-]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz
);
CREATE INDEX google_signin_handoffs_expires_at ON google_signin_handoffs(expires_at, state);
CREATE INDEX google_signin_handoffs_claim ON google_signin_handoffs(state, claim_id, claimed_at);
