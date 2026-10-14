PRAGMA foreign_keys = ON;

-- Public open-enrollment aggregates are descriptive provider-account cohorts,
-- not independently sampled people. Keep the release controls in D1 so an
-- operator can tune maturity and account-level clipping without changing the
-- Worker bundle. Only pairwise digests are retained for policy authorship;
-- this table must never receive a provider subject, email, or request address.
CREATE TABLE community_snapshot_policy (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  -- Policy may only tighten the public account-cohort guarantees. A lower
  -- threshold or larger cap requires a new reviewed public contract rather
  -- than an operational D1 edit.
  maturity_days INTEGER NOT NULL CHECK (maturity_days BETWEEN 7 AND 3650),
  minimum_accepted_collection_days INTEGER NOT NULL
    CHECK (minimum_accepted_collection_days BETWEEN 2 AND 366),
  account_usage_events_cap INTEGER NOT NULL
    CHECK (account_usage_events_cap BETWEEN 1 AND 1000),
  account_token_components_cap INTEGER NOT NULL
    CHECK (account_token_components_cap BETWEEN 1 AND 5000000),
  account_tool_units_cap INTEGER NOT NULL
    CHECK (account_tool_units_cap BETWEEN 1 AND 1000),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision >= 1),
  updated_at TEXT NOT NULL,
  updated_by_digest TEXT NOT NULL
    CHECK (length(updated_by_digest) = 64
      AND updated_by_digest NOT GLOB '*[^0-9a-f]*')
) STRICT;

INSERT INTO community_snapshot_policy (
  singleton_id, maturity_days, minimum_accepted_collection_days,
  account_usage_events_cap, account_token_components_cap,
  account_tool_units_cap, policy_revision, updated_at, updated_by_digest
) VALUES (
  1, 7, 2, 1000, 5000000, 1000, 1,
  '1970-01-01T00:00:00.000Z',
  '0000000000000000000000000000000000000000000000000000000000000000'
);

-- A policy update changes every aggregate's source semantics. Withdraw first,
-- enqueue one deterministic rebuild per affected period, then let the normal
-- leased builder seal the replacement revision. The trigger is deliberately
-- no-op for timestamp/author-only updates so an audit write cannot churn
-- snapshots.
CREATE TRIGGER community_snapshot_policy_changed
AFTER UPDATE ON community_snapshot_policy
FOR EACH ROW
WHEN OLD.maturity_days IS NOT NEW.maturity_days
  OR OLD.minimum_accepted_collection_days IS NOT NEW.minimum_accepted_collection_days
  OR OLD.account_usage_events_cap IS NOT NEW.account_usage_events_cap
  OR OLD.account_token_components_cap IS NOT NEW.account_token_components_cap
  OR OLD.account_tool_units_cap IS NOT NEW.account_tool_units_cap
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

CREATE TRIGGER community_snapshot_policy_no_delete
BEFORE DELETE ON community_snapshot_policy
BEGIN
  SELECT RAISE(ABORT, 'community snapshot policy immutable');
END;

-- Exclusions are append/update-audited operational decisions, separate from
-- retention/quarantine state. A row is never deleted; revocation records who
-- (as a pairwise digest) changed the decision and when. `expires_at` permits a
-- bounded exclusion without retaining a hidden identity forever.
CREATE TABLE community_aggregate_exclusions (
  exclusion_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(exclusion_id) BETWEEN 1 AND 120),
  participant_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'community_weekly'),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('abuse_signal', 'data_quality', 'account_compromise', 'manual_review', 'other')
  ),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  effective_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by_digest TEXT NOT NULL
    CHECK (length(created_by_digest) = 64
      AND created_by_digest NOT GLOB '*[^0-9a-f]*'),
  revoked_at TEXT,
  revoked_by_digest TEXT
    CHECK (revoked_by_digest IS NULL OR (
      length(revoked_by_digest) = 64
      AND revoked_by_digest NOT GLOB '*[^0-9a-f]*'
    )),
  -- Deliberately no foreign key: deletion must preserve this audit row after
  -- a participant is removed, and the participant ID is already opaque.
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revoked_by_digest IS NULL)
    OR
    (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_digest IS NOT NULL)
  )
) STRICT;

CREATE INDEX community_aggregate_exclusions_participant
  ON community_aggregate_exclusions(participant_id, scope, state, effective_at);

CREATE TRIGGER community_aggregate_exclusion_inserted
AFTER INSERT ON community_aggregate_exclusions
FOR EACH ROW
WHEN NEW.state = 'active'
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

CREATE TRIGGER community_aggregate_exclusion_changed
AFTER UPDATE ON community_aggregate_exclusions
FOR EACH ROW
WHEN OLD.participant_id IS NOT NEW.participant_id
  OR OLD.scope IS NOT NEW.scope
  OR OLD.reason_code IS NOT NEW.reason_code
  OR OLD.state IS NOT NEW.state
  OR OLD.effective_at IS NOT NEW.effective_at
  OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.revoked_at IS NOT NEW.revoked_at
  OR OLD.revoked_by_digest IS NOT NEW.revoked_by_digest
BEGIN
  UPDATE community_snapshot_mutation_control
     SET mutation_epoch = mutation_epoch + 1
   WHERE singleton_id = 1;
  DELETE FROM community_snapshot_builders;
  INSERT INTO community_weekly_snapshot_rebuilds (
    week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
  )
  SELECT week_start, week_end, ingestion_cutoff_at,
         (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         ),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM community_weekly_snapshots
   WHERE release_state IN ('published', 'suppressed')
  ON CONFLICT(week_start) DO UPDATE SET
    requested_epoch = excluded.requested_epoch,
    requested_at = excluded.requested_at;
  UPDATE community_weekly_snapshots
     SET release_state = 'withdrawn',
         withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         withdrawal_epoch = (
           SELECT mutation_epoch FROM community_snapshot_mutation_control
            WHERE singleton_id = 1
         )
   WHERE release_state IN ('published', 'suppressed');
END;

CREATE TRIGGER community_aggregate_exclusion_no_delete
BEFORE DELETE ON community_aggregate_exclusions
BEGIN
  SELECT RAISE(ABORT, 'aggregate exclusion is append-only');
END;

-- The new social-provider-account and maturity semantics are not equivalent
-- to the prior aggregate contract. Do not leave a previously sealed current
-- snapshot publicly active after this migration: withdraw it, queue its exact
-- period for the normal leased builder, and let the v0.3 payload replace it.
-- This is deliberately the same narrow mutation/rebuild sequence used by a
-- meaningful policy change above.
UPDATE community_snapshot_mutation_control
   SET mutation_epoch = mutation_epoch + 1
 WHERE singleton_id = 1;

DELETE FROM community_snapshot_builders;

INSERT INTO community_weekly_snapshot_rebuilds (
  week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at
)
SELECT week_start, week_end, ingestion_cutoff_at,
       (
         SELECT mutation_epoch FROM community_snapshot_mutation_control
          WHERE singleton_id = 1
       ),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM community_weekly_snapshots
 WHERE release_state IN ('published', 'suppressed')
ON CONFLICT(week_start) DO UPDATE SET
  requested_epoch = excluded.requested_epoch,
  requested_at = excluded.requested_at;

UPDATE community_weekly_snapshots
   SET release_state = 'withdrawn',
       withdrawn_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       withdrawal_epoch = (
         SELECT mutation_epoch FROM community_snapshot_mutation_control
          WHERE singleton_id = 1
       )
 WHERE release_state IN ('published', 'suppressed');
