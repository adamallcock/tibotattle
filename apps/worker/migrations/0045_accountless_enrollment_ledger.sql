PRAGMA foreign_keys = ON;

-- Accountless enrollment is deliberately an enrollment-only boundary in this
-- tranche.  It records the versioned enrollment policy and its stable
-- device key without creating a participant, web session, pairing, device
-- credential, upload authority, identity link, or community eligibility row.
-- The installation principal is opaque and is retained only so a later
-- identity/device design can bind the row without reinterpreting a device id
-- as a person.
CREATE TABLE accountless_enrollment_ledger (
  device_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(device_id) = 36),
  device_secret_hash BLOB NOT NULL
    CHECK (length(device_secret_hash) = 32),
  installation_principal_id TEXT NOT NULL UNIQUE
    CHECK (length(installation_principal_id) BETWEEN 1 AND 120),
  schema_version TEXT NOT NULL
    CHECK (length(schema_version) BETWEEN 1 AND 80),
  policy_version TEXT NOT NULL
    CHECK (length(policy_version) BETWEEN 1 AND 120),
  authorization_basis TEXT NOT NULL
    CHECK (length(authorization_basis) BETWEEN 1 AND 120),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT
    CHECK (revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 120),
  CHECK (expires_at > issued_at),
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX accountless_enrollment_ledger_state
  ON accountless_enrollment_ledger(state, expires_at);

-- This counter is the hard issuance fence.  Cloudflare Rate Limit remains a
-- coarse, eventually consistent flood breaker; this D1 row is the atomic
-- global budget for new ledger rows.  The daily budget and lifetime ceiling
-- are fixed in the schema so an accidentally enabled deployment cannot grow
-- tombstones without bound.  Replays and revoked-row lookups happen before
-- this counter is touched.
CREATE TABLE accountless_enrollment_issuance (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  budget_day TEXT NOT NULL CHECK (length(budget_day) = 10),
  daily_issued INTEGER NOT NULL DEFAULT 0
    CHECK (daily_issued BETWEEN 0 AND 1000),
  lifetime_issued INTEGER NOT NULL DEFAULT 0
    CHECK (lifetime_issued BETWEEN 0 AND 10000),
  last_issue_token TEXT NOT NULL
    CHECK (length(last_issue_token) BETWEEN 0 AND 120),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO accountless_enrollment_issuance (
  singleton, budget_day, daily_issued, lifetime_issued, last_issue_token, updated_at
) VALUES (1, '1970-01-01', 0, 0, '', '1970-01-01T00:00:00.000Z');
