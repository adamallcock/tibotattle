-- Owner deletion tombstones and identity reenrollment cooldowns live in the
-- independent ledger schema. The primary application pool never deletes these
-- rows as part of ordinary retention.

CREATE TABLE deletion_tombstones (
  participant_digest text PRIMARY KEY CHECK (participant_digest ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL,
  deleted_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  CHECK (retain_until >= deleted_at)
);

CREATE TABLE identity_reenrollment_cooldowns (
  identity_cooldown_digest text PRIMARY KEY CHECK (identity_cooldown_digest ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL,
  deleted_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  CHECK (retain_until >= deleted_at)
);
