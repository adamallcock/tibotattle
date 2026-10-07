-- Release and asset rows are retained before the completion manifest is written
-- last (github-distribution-history.ts writeSnapshot). An interrupted sync may
-- therefore leave valid history without a completed distribution snapshot.
-- All readers select observed times through github_distribution_snapshots;
-- that manifest controls visibility, not the existence of retained releases.
-- Preserve every row, both primary keys and the asset-to-release foreign key.
ALTER TABLE github_release_snapshots
  DROP CONSTRAINT github_release_snapshots_observed_at_fkey;
