PRAGMA foreign_keys = ON;

-- The owner-only distribution sync is an audited operation alongside existing
-- collection and maintenance actions. SQLite cannot widen a CHECK constraint
-- in place, so rebuild this small append-only table rather than weakening its
-- action vocabulary.
CREATE TABLE admin_action_audit_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT UNIQUE
    CHECK (operation_id IS NULL OR length(operation_id) = 36),
  action TEXT NOT NULL CHECK (
    action IN (
      'set_collection_controls',
      'run_maintenance',
      'sync_distribution'
    )
  ),
  actor_identity_digest TEXT NOT NULL
    CHECK (length(actor_identity_digest) = 64
      AND actor_identity_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'success', 'failure')),
  details_json TEXT NOT NULL CHECK (length(details_json) <= 2000),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO admin_action_audit_next (
  id, operation_id, action, actor_identity_digest, outcome, details_json, created_at
)
SELECT id, operation_id, action, actor_identity_digest, outcome, details_json, created_at
  FROM admin_action_audit;

DROP TABLE admin_action_audit;
ALTER TABLE admin_action_audit_next RENAME TO admin_action_audit;
CREATE INDEX admin_action_audit_recent
  ON admin_action_audit(created_at DESC, id DESC);

-- GitHub exposes cumulative release-asset counters, not a time series. Store
-- bounded, content-free snapshots of public release assets so the private
-- owner dashboard can show future deltas without claiming unavailable history.
-- No account, IP, user-agent, or end-user/device data is retained here.
CREATE TABLE github_distribution_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_attempted_at TEXT,
  last_success_at TEXT,
  last_failure_code TEXT,
  last_observed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT
) STRICT;

INSERT INTO github_distribution_sync_state (singleton)
VALUES (1);

-- A manifest makes a snapshot visible only after every release and asset row
-- was written. This keeps an interrupted multi-batch sync out of history and
-- retains releases that have no assets yet.
CREATE TABLE github_distribution_snapshots (
  observed_at TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE github_release_snapshots (
  observed_at TEXT NOT NULL,
  release_id INTEGER NOT NULL CHECK (release_id >= 0),
  release_tag TEXT NOT NULL,
  release_published_at TEXT NOT NULL,
  release_prerelease INTEGER NOT NULL CHECK (release_prerelease IN (0, 1)),
  PRIMARY KEY (observed_at, release_id)
) STRICT;

CREATE TABLE github_release_asset_snapshots (
  observed_at TEXT NOT NULL,
  release_id INTEGER NOT NULL CHECK (release_id >= 0),
  release_tag TEXT NOT NULL,
  release_published_at TEXT NOT NULL,
  release_prerelease INTEGER NOT NULL CHECK (release_prerelease IN (0, 1)),
  asset_id INTEGER NOT NULL CHECK (asset_id >= 0),
  asset_name TEXT NOT NULL,
  asset_digest TEXT,
  asset_download_count INTEGER NOT NULL CHECK (asset_download_count >= 0),
  is_dmg INTEGER NOT NULL CHECK (is_dmg IN (0, 1)),
  PRIMARY KEY (observed_at, asset_id)
) STRICT;

CREATE INDEX github_release_asset_snapshots_current
  ON github_release_asset_snapshots(observed_at, release_published_at DESC, release_id, asset_id);

CREATE INDEX github_release_asset_snapshots_asset_history
  ON github_release_asset_snapshots(asset_id, observed_at DESC);

CREATE INDEX github_release_snapshots_current
  ON github_release_snapshots(observed_at, release_published_at DESC, release_id);
