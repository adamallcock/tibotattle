-- Keep the short anti-reissue cooldown in the primary D1 database as well as
-- the independent deletion ledger.  The value is a purpose-separated HMAC
-- digest; neither the provider subject nor the persisted identity-link key is
-- copied into this table.
--
-- `identity_cooldown_digest` is an insert-time guard input. The enrollment
-- transaction clears it immediately after this trigger has admitted the row,
-- so the participant row continues to retain only its existing identity-link
-- key.
ALTER TABLE participants ADD COLUMN identity_cooldown_digest TEXT
  CHECK (
    identity_cooldown_digest IS NULL
    OR (
      length(identity_cooldown_digest) = 64
      AND identity_cooldown_digest NOT GLOB '*[^0-9a-f]*'
    )
  );

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

-- The old participant row keeps its unique identity-link key until deletion
-- writes this marker.  Once that row is gone, this trigger is the final,
-- atomic enrollment sink: no request timing can insert a replacement while a
-- live cooldown marker exists.
CREATE TRIGGER participants_identity_reenrollment_cooldown_guard
BEFORE INSERT ON participants
WHEN NEW.identity_cooldown_digest IS NOT NULL
  AND EXISTS (
    SELECT 1
      FROM identity_reenrollment_cooldowns
     WHERE identity_cooldown_digest = NEW.identity_cooldown_digest
       AND retain_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
BEGIN
  SELECT RAISE(ABORT, 'identity reenrollment cooldown active');
END;
