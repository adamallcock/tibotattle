PRAGMA foreign_keys = ON;

-- The original five-minute handoff tables carried raw provider id_tokens.
-- Drop them rather than migrating their contents: any in-flight handoff is
-- safely restarted, and no bearer credential survives this migration. New
-- rows hold only a verified pairwise identity key and an opaque, one-use proof
-- which is deleted atomically during enrollment.
DROP TABLE apple_signin_handoffs;
DROP TABLE google_signin_handoffs;

CREATE TABLE apple_signin_handoffs (
  state TEXT PRIMARY KEY NOT NULL,
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

CREATE TABLE google_signin_handoffs (
  state TEXT PRIMARY KEY NOT NULL,
  code_verifier TEXT,
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

CREATE INDEX google_signin_handoffs_expires_at
  ON google_signin_handoffs (expires_at);
