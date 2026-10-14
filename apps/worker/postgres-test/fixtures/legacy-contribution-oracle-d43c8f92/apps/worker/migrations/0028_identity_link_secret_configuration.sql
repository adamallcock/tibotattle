-- Pin the HMAC identity-link key configuration in primary D1. The stored
-- fingerprint is HMAC(IDENTITY_LINK_SECRET, fixed-domain), not a raw secret
-- or provider identity. It prevents an in-place secret rotation from silently
-- creating a new account/cooldown namespace.
CREATE TABLE identity_link_secret_configuration (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  key_version TEXT NOT NULL
    CHECK (
      length(key_version) BETWEEN 1 AND 64
      AND key_version NOT GLOB '*[^A-Za-z0-9._-]*'
    ),
  secret_fingerprint TEXT NOT NULL
    CHECK (
      length(secret_fingerprint) = 64
      AND secret_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at TEXT NOT NULL
) STRICT;
