PRAGMA foreign_keys = ON;

-- A device credential's expiry is deliberately independent from its idle and
-- social-account recheck policy.  Existing credentials are considered
-- socially verified when they were originally paired; new pairings set this
-- value explicitly in device-auth.ts.
ALTER TABLE device_credentials ADD COLUMN social_verified_at TEXT;
ALTER TABLE device_credentials ADD COLUMN credential_generation INTEGER NOT NULL
  DEFAULT 1 CHECK (credential_generation >= 1);
UPDATE device_credentials
   SET social_verified_at = issued_at
 WHERE social_verified_at IS NULL;

CREATE INDEX device_credentials_social_recheck
  ON device_credentials(participant_id, state, social_verified_at);

-- Rotation keeps the logical device id stable while replacing the bearer
-- secret.  The prior hash is retained only for a bounded replay/reuse check;
-- raw device secrets never enter this table.
CREATE TABLE device_credential_rotations (
  id TEXT PRIMARY KEY NOT NULL,
  device_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  prior_secret_hash BLOB NOT NULL CHECK (length(prior_secret_hash) = 32),
  replacement_secret_hash BLOB NOT NULL
    CHECK (length(replacement_secret_hash) = 32),
  attempt_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 2),
  rotated_at TEXT NOT NULL,
  retire_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES device_credentials(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE (device_id, prior_secret_hash),
  UNIQUE (device_id, attempt_id)
) STRICT;

CREATE INDEX device_credential_rotations_retire
  ON device_credential_rotations(retire_at);

-- This small event ledger is available for redacted operational accounting
-- without retaining bearer material or request data. The lifecycle helper
-- uses the canonical pairing timestamps directly for admission, so an
-- interrupted event write can never grant or deny a pairing.
CREATE TABLE device_pairing_events (
  id TEXT PRIMARY KEY NOT NULL,
  pairing_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issued', 'claimed')),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (pairing_id) REFERENCES device_pairings(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  UNIQUE (pairing_id, kind)
) STRICT;

CREATE INDEX device_pairing_events_velocity
  ON device_pairing_events(participant_id, kind, occurred_at);

-- Backfill rows created before this migration for operators that choose to
-- inspect the event ledger; admission does not depend on this auxiliary data.
INSERT OR IGNORE INTO device_pairing_events (
  id, pairing_id, participant_id, kind, occurred_at
)
SELECT 'pairing-issued-' || id, id, participant_id, 'issued', issued_at
  FROM device_pairings;

INSERT OR IGNORE INTO device_pairing_events (
  id, pairing_id, participant_id, kind, occurred_at
)
SELECT 'pairing-claimed-' || id, id, participant_id, 'claimed', consumed_at
  FROM device_pairings
 WHERE state = 'consumed' AND consumed_at IS NOT NULL;
