PRAGMA foreign_keys = ON;

CREATE TABLE device_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  issued_by_session_id TEXT NOT NULL,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  consent_version TEXT NOT NULL
    CHECK (consent_version = 'ongoing-privacy-safe-telemetry-v0.1'),
  state TEXT NOT NULL DEFAULT 'unused'
    CHECK (state IN ('unused', 'consumed', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  claimed_device_id TEXT,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (issued_by_session_id) REFERENCES web_sessions(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX device_pairings_participant_state
  ON device_pairings(participant_id, state, expires_at);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  paired_via_pairing_id TEXT NOT NULL UNIQUE,
  secret_hash BLOB NOT NULL CHECK (length(secret_hash) = 32),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (paired_via_pairing_id) REFERENCES device_pairings(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX device_credentials_participant_state
  ON device_credentials(participant_id, state, expires_at);

CREATE TRIGGER device_credentials_require_active_pairing
BEFORE INSERT ON device_credentials
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM device_pairings pairing
    JOIN participants participant ON participant.id = pairing.participant_id
   WHERE pairing.id = NEW.paired_via_pairing_id
     AND pairing.participant_id = NEW.participant_id
     AND pairing.state = 'unused'
     AND pairing.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND participant.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'pairing unavailable');
END;

CREATE TABLE device_upload_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL,
  issued_by_device_id TEXT NOT NULL,
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
  FOREIGN KEY (issued_by_device_id) REFERENCES device_credentials(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX device_upload_authorizations_participant_state
  ON device_upload_authorizations(participant_id, state, expires_at);

CREATE INDEX device_upload_authorizations_device_state
  ON device_upload_authorizations(issued_by_device_id, state, expires_at);

CREATE TRIGGER device_upload_authorizations_require_active_device
BEFORE INSERT ON device_upload_authorizations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM device_credentials device
    JOIN participants participant ON participant.id = device.participant_id
   WHERE device.id = NEW.issued_by_device_id
     AND device.participant_id = NEW.participant_id
     AND device.state = 'active'
     AND device.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     AND participant.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'device unavailable');
END;

ALTER TABLE contributions
  ADD COLUMN device_upload_authorization_id TEXT
  REFERENCES device_upload_authorizations(id);

CREATE UNIQUE INDEX contributions_device_upload_authorization
  ON contributions(device_upload_authorization_id)
  WHERE device_upload_authorization_id IS NOT NULL;

ALTER TABLE telemetry_contributions
  ADD COLUMN device_upload_authorization_id TEXT
  REFERENCES device_upload_authorizations(id);

CREATE UNIQUE INDEX telemetry_contributions_device_upload_authorization
  ON telemetry_contributions(device_upload_authorization_id)
  WHERE device_upload_authorization_id IS NOT NULL;

DROP TRIGGER contributions_require_consuming_upload;
DROP TRIGGER contributions_consume_upload;
DROP TRIGGER telemetry_contributions_require_consuming_upload;
DROP TRIGGER telemetry_contributions_consume_upload;

CREATE TRIGGER contributions_require_consuming_upload
BEFORE INSERT ON contributions
FOR EACH ROW
WHEN NOT (
  (
    NEW.upload_authorization_id IS NOT NULL
    AND NEW.device_upload_authorization_id IS NULL
    AND EXISTS (
      SELECT 1 FROM upload_authorizations
       WHERE id = NEW.upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
  OR
  (
    NEW.upload_authorization_id IS NULL
    AND NEW.device_upload_authorization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM device_upload_authorizations
       WHERE id = NEW.device_upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;

CREATE TRIGGER contributions_consume_session_upload
AFTER INSERT ON contributions
FOR EACH ROW
WHEN NEW.upload_authorization_id IS NOT NULL
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

CREATE TRIGGER contributions_consume_device_upload
AFTER INSERT ON contributions
FOR EACH ROW
WHEN NEW.device_upload_authorization_id IS NOT NULL
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;

CREATE TRIGGER telemetry_contributions_require_consuming_upload
BEFORE INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NOT (
  (
    NEW.upload_authorization_id IS NOT NULL
    AND NEW.device_upload_authorization_id IS NULL
    AND EXISTS (
      SELECT 1 FROM upload_authorizations
       WHERE id = NEW.upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
  OR
  (
    NEW.upload_authorization_id IS NULL
    AND NEW.device_upload_authorization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM device_upload_authorizations
       WHERE id = NEW.device_upload_authorization_id
         AND participant_id = NEW.participant_id
         AND state = 'consuming'
         AND consume_lease_expires_at >
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'upload unavailable');
END;

CREATE TRIGGER telemetry_contributions_consume_session_upload
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NEW.upload_authorization_id IS NOT NULL
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

CREATE TRIGGER telemetry_contributions_consume_device_upload
AFTER INSERT ON telemetry_contributions
FOR EACH ROW
WHEN NEW.device_upload_authorization_id IS NOT NULL
BEGIN
  UPDATE device_upload_authorizations
     SET state = 'consumed',
         consumed_at = NEW.created_at,
         consume_lease_expires_at = NULL,
         consumed_contribution_id = NEW.id
   WHERE id = NEW.device_upload_authorization_id
     AND participant_id = NEW.participant_id
     AND state = 'consuming';
END;
