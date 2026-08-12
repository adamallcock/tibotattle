PRAGMA foreign_keys = ON;

-- Per-participant fit cache for the community allowance collector.
--
-- Collecting a v1-source participant's qualifying seven-day Codex reset fits
-- reads the participant's full chunk record history, reprices every usage
-- event from tokens, and runs the shared calibration per reset. That work only
-- changes when the participant's v1 chunk journal changes, yet the hourly cron
-- pass recollects the whole cross-account corpus for every day it rebuilds.
--
-- This cache lets the collector skip the read + reprice + fit when a cheap
-- content epoch is unchanged: the cache_key folds the participant's current
-- chunk count, newest created_at, and revision sum together with the pricing
-- registry digest and the fit-adapter version, so any chunk supersession, a
-- registry roll, or an adapter change misses the cache and recomputes. One row
-- per participant; the newest computed epoch replaces the prior one on write.
-- ON DELETE CASCADE clears a deleted participant's row with the rest of their
-- subtree, so the cache never outlives its participant.
CREATE TABLE community_allowance_fit_cache (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  fits_json TEXT NOT NULL,
  computed_at TEXT NOT NULL
) STRICT;
