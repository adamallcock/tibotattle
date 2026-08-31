PRAGMA foreign_keys = ON;

-- Per-participant model-composition fit cache, and the published per-day
-- cohort series it feeds.
--
-- The per-model allowance fit answers a question the per-reset blended fit
-- cannot: how much Pro-20x-equivalent API value one hundred percentage points
-- of the weekly pool buys PER MODEL. It runs the shared NNLS composition
-- kernel over a participant's priced v1 usage (model identity preserved) and
-- the same lossless run-endpoint quota downsample the blended fit reads. That
-- work only changes when the participant's chunk journal, the price registry,
-- or the adapter changes, so it caches exactly like
-- community_allowance_fit_cache (0035): one row per participant, epoch-keyed,
-- newest computed epoch replaces the prior. ON DELETE CASCADE keeps the cache
-- inside the participant's deletion subtree.
CREATE TABLE community_model_composition_cache (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  composition_json TEXT NOT NULL CHECK (length(composition_json) <= 32768),
  computed_at TEXT NOT NULL
) STRICT;

-- One row per UTC day: the cohort-normalized per-model summary published to
-- the admin preview. History accrues forward from the feature's ship date;
-- days are upserted by the hourly preview warmer, never backfilled, so the
-- series is append-only evidence of what the fit said at the time.
--
-- Aggregate identity boundary: payload_json carries per-model medians,
-- participant counts, and identification gates only — no participant
-- identifiers.
CREATE TABLE community_model_composition_days (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 16384),
  computed_at TEXT NOT NULL
) STRICT;
