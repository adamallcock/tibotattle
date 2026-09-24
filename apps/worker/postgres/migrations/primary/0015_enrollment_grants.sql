-- PostgreSQL primary migration 0016: invite and community enrollment state.
--
-- Enrollment grants are authority state, not an analytics fixture.  The
-- composite enrollment write validates/redeems a grant and inserts the
-- participant eligibility row in the same transaction as the participant,
-- session, pairing, and owner bootstrap.

CREATE TABLE enrollment_grants (
  id text PRIMARY KEY,
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  state text NOT NULL DEFAULT 'issued'
    CHECK (state IN ('issued', 'redeemed')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_participant_id text UNIQUE REFERENCES participants(id) ON DELETE SET NULL,
  CHECK (expires_at > issued_at),
  CHECK ((state = 'issued' AND redeemed_at IS NULL AND redeemed_participant_id IS NULL)
      OR (state = 'redeemed' AND redeemed_at IS NOT NULL AND redeemed_participant_id IS NOT NULL))
);
CREATE INDEX enrollment_grants_state_expiry ON enrollment_grants(state, expires_at, id);

CREATE TABLE participant_community_eligibility (
  id text PRIMARY KEY,
  participant_id text NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  grant_id text NOT NULL UNIQUE REFERENCES enrollment_grants(id),
  created_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION participant_community_eligibility_requires_redeemed_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM enrollment_grants
     WHERE id = NEW.grant_id
       AND state = 'redeemed'
       AND redeemed_participant_id = NEW.participant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1010';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER participant_community_eligibility_requires_redeemed_grant
BEFORE INSERT ON participant_community_eligibility
FOR EACH ROW EXECUTE FUNCTION participant_community_eligibility_requires_redeemed_grant();
