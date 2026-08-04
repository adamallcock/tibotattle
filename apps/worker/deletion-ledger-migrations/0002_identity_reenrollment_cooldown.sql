-- A deletion leaves a short-lived, purpose-separated anti-reissue marker.
-- Only the keyed digest is retained: the identity-link key and provider
-- subject are never copied into this ledger.
CREATE TABLE identity_reenrollment_cooldowns (
  identity_cooldown_digest TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(identity_cooldown_digest) = 64
      AND identity_cooldown_digest NOT GLOB '*[^0-9a-f]*'
    ),
  schema_version TEXT NOT NULL
    CHECK (schema_version = 'identity-reenrollment-cooldown-v0.1'),
  deleted_at TEXT NOT NULL,
  retain_until TEXT NOT NULL,
  CHECK (retain_until > deleted_at)
) STRICT;

CREATE INDEX identity_reenrollment_cooldowns_retention
  ON identity_reenrollment_cooldowns(retain_until, identity_cooldown_digest);
