CREATE TABLE IF NOT EXISTS sparkle_appcast_guard_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sparkle_appcast_guard_nonces_expires_at
  ON sparkle_appcast_guard_nonces(expires_at);
