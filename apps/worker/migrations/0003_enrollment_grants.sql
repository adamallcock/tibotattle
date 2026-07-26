PRAGMA foreign_keys = ON;

CREATE TABLE enrollment_grants (
  id TEXT PRIMARY KEY NOT NULL,
  secret_hash BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued'
    CHECK (state IN ('issued', 'redeemed')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_participant_id TEXT UNIQUE,
  FOREIGN KEY (redeemed_participant_id) REFERENCES participants(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE participant_community_eligibility (
  id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL UNIQUE,
  grant_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id) REFERENCES enrollment_grants(id)
) STRICT;

CREATE TRIGGER participant_community_eligibility_requires_redeemed_grant
BEFORE INSERT ON participant_community_eligibility
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment_grants
   WHERE id = NEW.grant_id
     AND state = 'redeemed'
     AND redeemed_participant_id = NEW.participant_id
)
BEGIN
  SELECT RAISE(ABORT, 'grant unavailable');
END;
