PRAGMA foreign_keys = ON;

-- Cloudflare's per-edge rate-limit binding remains a useful first layer, but
-- public hosted sign-in starts also need one authoritative cross-edge budget.
-- This stores only an aggregate count for a UTC minute bucket: no address,
-- provider subject, browser state, handoff proof, or provider credential.
CREATE TABLE sign_in_start_admission_windows (
  window_started_at TEXT PRIMARY KEY NOT NULL,
  accepted_count INTEGER NOT NULL CHECK (accepted_count BETWEEN 1 AND 1200),
  last_accepted_at TEXT NOT NULL
) STRICT;

CREATE INDEX sign_in_start_admission_windows_retention
  ON sign_in_start_admission_windows(window_started_at);
