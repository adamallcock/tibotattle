PRAGMA foreign_keys = ON;

CREATE TABLE community_snapshot_mutation_control (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  mutation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (mutation_epoch >= 0)
) STRICT;

INSERT INTO community_snapshot_mutation_control(singleton_id, mutation_epoch)
VALUES (1, 0);

CREATE TABLE community_snapshot_builders (
  week_start TEXT PRIMARY KEY NOT NULL,
  owner_nonce TEXT NOT NULL,
  mutation_epoch INTEGER NOT NULL CHECK (mutation_epoch >= 0),
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE community_weekly_snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  week_start TEXT NOT NULL UNIQUE,
  week_end TEXT NOT NULL,
  ingestion_cutoff_at TEXT NOT NULL,
  released_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64
      AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  release_state TEXT NOT NULL CHECK (
    release_state IN ('published', 'suppressed', 'withdrawn')
  ),
  sealed_at TEXT NOT NULL,
  withdrawn_at TEXT,
  withdrawal_epoch INTEGER,
  CHECK (
    (release_state = 'withdrawn'
      AND withdrawn_at IS NOT NULL AND withdrawal_epoch IS NOT NULL)
    OR
    (release_state IN ('published', 'suppressed')
      AND withdrawn_at IS NULL AND withdrawal_epoch IS NULL)
  )
) STRICT;

CREATE INDEX community_weekly_snapshots_latest
  ON community_weekly_snapshots(week_end DESC, sealed_at DESC);

CREATE TRIGGER community_weekly_snapshots_immutable
BEFORE UPDATE ON community_weekly_snapshots
FOR EACH ROW
WHEN NEW.snapshot_id IS NOT OLD.snapshot_id
  OR NEW.week_start IS NOT OLD.week_start
  OR NEW.week_end IS NOT OLD.week_end
  OR NEW.ingestion_cutoff_at IS NOT OLD.ingestion_cutoff_at
  OR NEW.released_at IS NOT OLD.released_at
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.sealed_at IS NOT OLD.sealed_at
  OR OLD.release_state = 'withdrawn'
  OR NEW.release_state NOT IN ('withdrawn')
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot immutable');
END;

CREATE TRIGGER community_weekly_snapshots_no_delete
BEFORE DELETE ON community_weekly_snapshots
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot immutable');
END;

CREATE TRIGGER community_snapshot_participant_withdrawal
BEFORE UPDATE OF state ON participants
FOR EACH ROW
WHEN OLD.state = 'active' AND NEW.state = 'deleting'
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

CREATE TRIGGER community_snapshot_contribution_deleting
BEFORE UPDATE OF status ON telemetry_contributions
FOR EACH ROW
WHEN OLD.status = 'accepted' AND NEW.status = 'deleting'
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

CREATE TRIGGER community_snapshot_contribution_direct_delete
BEFORE DELETE ON telemetry_contributions
FOR EACH ROW
WHEN OLD.status != 'deleting'
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;
