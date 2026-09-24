-- PostgreSQL primary migration 0022: owner-only GitHub distribution history.
--
-- GitHub exposes cumulative release-asset counters rather than an install
-- time series. These bounded, content-free snapshots mirror the existing D1
-- distribution history contract so the owner dashboard and scheduled sync can
-- run against the same provider-neutral DTO. A snapshot manifest is written
-- last and makes all rows at one observed time visible atomically.

CREATE TABLE github_distribution_sync_state (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  last_attempted_at timestamptz,
  last_success_at timestamptz,
  last_failure_code text,
  last_observed_at timestamptz,
  lease_token text,
  lease_expires_at timestamptz
);

INSERT INTO github_distribution_sync_state (singleton)
VALUES (1);

CREATE TABLE github_distribution_snapshots (
  observed_at timestamptz PRIMARY KEY,
  completed_at timestamptz NOT NULL
);

CREATE TABLE github_release_snapshots (
  observed_at timestamptz NOT NULL,
  release_id bigint NOT NULL CHECK (release_id >= 0),
  release_tag text NOT NULL CHECK (char_length(release_tag) BETWEEN 1 AND 256),
  release_published_at timestamptz NOT NULL,
  release_prerelease boolean NOT NULL,
  PRIMARY KEY (observed_at, release_id),
  FOREIGN KEY (observed_at) REFERENCES github_distribution_snapshots(observed_at)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE github_release_asset_snapshots (
  observed_at timestamptz NOT NULL,
  release_id bigint NOT NULL CHECK (release_id >= 0),
  release_tag text NOT NULL CHECK (char_length(release_tag) BETWEEN 1 AND 256),
  release_published_at timestamptz NOT NULL,
  release_prerelease boolean NOT NULL,
  asset_id bigint NOT NULL CHECK (asset_id >= 0),
  asset_name text NOT NULL CHECK (char_length(asset_name) BETWEEN 1 AND 512),
  asset_digest text,
  asset_download_count bigint NOT NULL CHECK (asset_download_count >= 0),
  is_dmg boolean NOT NULL,
  PRIMARY KEY (observed_at, asset_id),
  FOREIGN KEY (observed_at, release_id)
    REFERENCES github_release_snapshots(observed_at, release_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX github_release_asset_snapshots_current
  ON github_release_asset_snapshots(observed_at, release_published_at DESC, release_id, asset_id);

CREATE INDEX github_release_asset_snapshots_asset_history
  ON github_release_asset_snapshots(asset_id, observed_at DESC);

CREATE INDEX github_release_snapshots_current
  ON github_release_snapshots(observed_at, release_published_at DESC, release_id);
