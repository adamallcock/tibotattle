PRAGMA foreign_keys = ON;

ALTER TABLE participants
  ADD COLUMN deletion_session_id TEXT;

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  csrf_hash BLOB NOT NULL CHECK (length(csrf_hash) = 32),
  scope TEXT NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'deletion_only')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX web_sessions_participant_state
  ON web_sessions(participant_id, state, expires_at);

CREATE INDEX web_sessions_expiry
  ON web_sessions(state, expires_at);

CREATE TRIGGER web_sessions_require_active_participant
BEFORE INSERT ON web_sessions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM participants
   WHERE id = NEW.participant_id
     AND (
       (state = 'active' AND NEW.scope = 'personal')
       OR (
         state = 'deleting'
         AND NEW.scope = 'deletion_only'
         AND deletion_session_id = NEW.id
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;

CREATE TABLE upload_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  issued_by_session_id TEXT NOT NULL,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  envelope_digest TEXT NOT NULL
    CHECK (length(envelope_digest) = 64
      AND envelope_digest NOT GLOB '*[^0-9a-f]*'),
  body_bytes INTEGER NOT NULL CHECK (body_bytes > 0),
  content_type TEXT NOT NULL CHECK (content_type = 'application/json'),
  state TEXT NOT NULL DEFAULT 'unused'
    CHECK (state IN ('unused', 'consuming', 'consumed', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  consume_lease_expires_at TEXT,
  consumed_contribution_id TEXT,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (issued_by_session_id) REFERENCES web_sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX upload_authorizations_participant_state
  ON upload_authorizations(participant_id, state, expires_at);

CREATE INDEX upload_authorizations_expiry
  ON upload_authorizations(state, expires_at);

CREATE TRIGGER upload_authorizations_require_active_participant
BEFORE INSERT ON upload_authorizations
FOR EACH ROW
WHEN (SELECT state FROM participants WHERE id = NEW.participant_id) IS NOT 'active'
BEGIN
  SELECT RAISE(ABORT, 'participant unavailable');
END;

ALTER TABLE contributions
  ADD COLUMN upload_authorization_id TEXT
  REFERENCES upload_authorizations(id);

CREATE UNIQUE INDEX contributions_upload_authorization
  ON contributions(upload_authorization_id)
  WHERE upload_authorization_id IS NOT NULL;

CREATE TRIGGER contributions_require_consuming_upload
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN NEW.upload_authorization_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM upload_authorizations
   WHERE id = NEW.upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming'
     AND consume_lease_expires_at >
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;

CREATE TRIGGER contributions_consume_upload
AFTER INSERT ON contributions
FOR EACH ROW
BEGIN
  UPDATE upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;

ALTER TABLE telemetry_contributions
  ADD COLUMN upload_authorization_id TEXT
  REFERENCES upload_authorizations(id);

CREATE UNIQUE INDEX telemetry_contributions_upload_authorization
  ON telemetry_contributions(upload_authorization_id)
  WHERE upload_authorization_id IS NOT NULL;

CREATE TRIGGER telemetry_contributions_require_consuming_upload
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NEW.upload_authorization_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM upload_authorizations
   WHERE id = NEW.upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming'
     AND consume_lease_expires_at >
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;

CREATE TRIGGER telemetry_contributions_consume_upload
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
BEGIN
  UPDATE upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;

CREATE TABLE recovery_retry_receipts (
  old_recovery_token_id TEXT PRIMARY KEY NOT NULL,
  old_recovery_token_hash BLOB NOT NULL CHECK (length(old_recovery_token_hash) = 32),
  recovery_attempt_hash BLOB NOT NULL CHECK (length(recovery_attempt_hash) = 32),
  participant_id TEXT NOT NULL,
  derivation_nonce TEXT NOT NULL
    CHECK (length(derivation_nonce) = 43
      AND derivation_nonce NOT GLOB '*[^A-Za-z0-9_-]*'),
  replacement_recovery_token_id TEXT NOT NULL,
  replacement_session_id TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count BETWEEN 0 AND 2),
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (replacement_session_id) REFERENCES web_sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX recovery_retry_receipts_expiry
  ON recovery_retry_receipts(expires_at);
