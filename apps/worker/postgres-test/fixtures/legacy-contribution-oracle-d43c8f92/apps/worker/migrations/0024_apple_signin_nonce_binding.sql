PRAGMA foreign_keys = ON;

-- Bind every Apple ID Token to the authorization transaction that requested
-- it.  The raw nonce is deliberately not retained: start handlers send it to
-- Apple and store only SHA-256(nonce) here.  Existing handoffs are safe to
-- discard during this forward-only rebuild because they are five-minute,
-- one-use browser transactions and can be restarted after migration.
DROP TABLE apple_signin_handoffs;

CREATE TABLE apple_signin_handoffs (
  state TEXT PRIMARY KEY NOT NULL,
  nonce_hash TEXT NOT NULL
    CHECK (
      length(nonce_hash) = 64
      AND nonce_hash NOT GLOB '*[^0-9a-f]*'
    ),
  identity_link_key TEXT
    CHECK (identity_link_key IS NULL OR (
      length(identity_link_key) = 64
      AND identity_link_key NOT GLOB '*[^0-9a-f]*'
    )),
  proof TEXT UNIQUE
    CHECK (proof IS NULL OR (
      length(proof) = 64
      AND proof NOT GLOB '*[^A-Za-z0-9_-]*'
    )),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  delivered_at TEXT
) STRICT;

CREATE INDEX apple_signin_handoffs_expires_at
  ON apple_signin_handoffs (expires_at);
