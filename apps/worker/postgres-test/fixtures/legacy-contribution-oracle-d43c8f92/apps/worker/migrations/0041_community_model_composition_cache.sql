PRAGMA foreign_keys = ON;

-- Compact personal-plan two-hour model-composition observations produced during
-- the existing v1 allowance scan. Keeping them beside the reset fits means a
-- chunk epoch is priced exactly once, while scheduled admin aggregation can
-- reconstruct rolling model capacities without touching raw telemetry.
--
-- Existing rows remain nullable during rollout. The adapter-version component
-- of cache_key changes with this migration's consumer, so every active v1
-- participant is recomputed before a model preview is considered current.
ALTER TABLE community_allowance_fit_cache
  ADD COLUMN model_observations_json TEXT;

-- Scheduled-only retry throttle. A stale/malformed participant cache can
-- require a full bounded reprice, while an unapplied migration or legacy-only
-- source cannot be repaired by retrying every minute. Recording the attempt
-- before raw analysis bounds unavailable-preview recovery to once per hour.
CREATE TABLE admin_community_allowance_preview_refresh_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_attempted_at TEXT NOT NULL
) STRICT;

INSERT INTO admin_community_allowance_preview_refresh_state (
  singleton,
  last_attempted_at
) VALUES (1, '1970-01-01T00:00:00.000Z');
