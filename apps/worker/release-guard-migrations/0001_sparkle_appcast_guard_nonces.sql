-- The release guard D1 (RELEASE_GUARD_DB) holds only the Sparkle appcast
-- guard's nonces once the edge runs in gcp mode; the edge's facade refuses
-- every statement that does not name this table. The two statements below
-- are byte-identical to migrations/0029_sparkle_appcast_guard_nonces.sql.
-- Release guard nonces are short-lived coordination state, not release data.
-- The unique key makes a signed request single-use even when two Workers race.
CREATE TABLE IF NOT EXISTS sparkle_appcast_guard_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sparkle_appcast_guard_nonces_expires_at
  ON sparkle_appcast_guard_nonces(expires_at);
