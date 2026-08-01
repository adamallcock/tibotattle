-- Mandatory hosted identity: each participant may hold one pairwise
-- identity link key, HMAC-SHA256(server secret, issuer + "|" + subject),
-- stored as lowercase hex. The raw OIDC subject, email, and name are never
-- persisted. The unique index makes one signed-in identity resolve to one
-- participant forever; enrollment with an existing key reattaches instead of
-- minting a duplicate. Hosted deletion clears the key so a deleted
-- participant is no longer linkable.
ALTER TABLE participants ADD COLUMN identity_link_key TEXT;

CREATE UNIQUE INDEX participants_identity_link_key
  ON participants (identity_link_key)
  WHERE identity_link_key IS NOT NULL;
