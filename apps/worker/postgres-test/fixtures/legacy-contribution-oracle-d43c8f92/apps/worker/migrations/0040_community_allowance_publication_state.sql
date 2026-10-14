-- Public allowance cutovers fail closed through one scheduled singleton.
-- Interactive reads join this row to the requested precomputed daily rows;
-- only scheduled reconciliation scans the current reconstructable history.
CREATE TABLE community_allowance_publication_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  publication_state TEXT NOT NULL
    CHECK (publication_state IN ('updating', 'ready')),
  expected_basis TEXT NOT NULL,
  safe_from_day TEXT NOT NULL
    CHECK (safe_from_day GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  safe_to_day TEXT NOT NULL
    CHECK (safe_to_day GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_at TEXT NOT NULL
) STRICT;

-- The first scheduled reconciliation replaces this sentinel window. Until
-- then the endpoint's exact current-window check keeps allowance hidden.
INSERT INTO community_allowance_publication_state (
  singleton,
  publication_state,
  expected_basis,
  safe_from_day,
  safe_to_day,
  changed_at
) VALUES (
  1,
  'updating',
  'seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d',
  '1970-01-01',
  '1970-01-01',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
