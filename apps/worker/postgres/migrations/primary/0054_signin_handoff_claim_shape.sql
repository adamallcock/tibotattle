-- PostgreSQL primary migration 0054: sign-in handoff claim-id shape.
--
-- D1 0033 constrains each handoff processing claim to 64 base64url
-- characters or NULL. Primary 0002 created claim_id as unconstrained text, so
-- mirror that shape check on both provider tables. The claim is a server
-- minted randomSecret(48); any other value is a defect, never data.
--
-- Each constraint is added NOT VALID and then explicitly validated, so every
-- existing row is checked: a violating row fails the whole migration and is
-- never rewritten or deleted here. The migration runner applies this file in
-- one transaction, so both constraints land together or not at all. No table,
-- column or row is added or removed.

ALTER TABLE apple_signin_handoffs
  ADD CONSTRAINT apple_signin_handoffs_claim_id_shape
    CHECK (claim_id IS NULL OR claim_id ~ '^[A-Za-z0-9_-]{64}$') NOT VALID;
ALTER TABLE apple_signin_handoffs
  VALIDATE CONSTRAINT apple_signin_handoffs_claim_id_shape;

ALTER TABLE google_signin_handoffs
  ADD CONSTRAINT google_signin_handoffs_claim_id_shape
    CHECK (claim_id IS NULL OR claim_id ~ '^[A-Za-z0-9_-]{64}$') NOT VALID;
ALTER TABLE google_signin_handoffs
  VALIDATE CONSTRAINT google_signin_handoffs_claim_id_shape;
