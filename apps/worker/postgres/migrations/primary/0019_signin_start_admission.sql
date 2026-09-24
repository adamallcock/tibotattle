-- Hosted sign-in starts use one authoritative minute bucket across Worker
-- instances. Keep only aggregate admission data: no address, provider
-- account, browser state, handoff proof, or credential crosses this boundary.
CREATE TABLE sign_in_start_admission_windows (
  window_started_at timestamptz PRIMARY KEY,
  accepted_count integer NOT NULL CHECK (accepted_count BETWEEN 1 AND 1200),
  last_accepted_at timestamptz NOT NULL
);

CREATE INDEX sign_in_start_admission_windows_retention
  ON sign_in_start_admission_windows(window_started_at);
