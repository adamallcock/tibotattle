-- PostgreSQL primary migration 0063 (PT-3, W2-SEAL): an imported
-- enrollment grant may keep an erased redeemer.
--
-- D1 migrations/0003 has no shape CHECK on enrollment_grants, and its
-- redeemed_participant_id is ON DELETE SET NULL: a grant redeemed by a
-- participant that Cloudflare later erased stays 'redeemed' with a NULL
-- redeemer. Primary 0015 refuses that row (enrollment_grants_check1 requires
-- a redeemer for 'redeemed'), so the identity importer could not carry the
-- sealed grant, and a grant once redeemed must never become issuable again.
--
-- This forward migration (PT-3's 0075, promoted as primary 0063 at the
-- wave-2 integration):
--   * replaces 0015's shape CHECK with one that no longer requires the
--     redeemer of a redeemed grant (issued grants keep every field NULL);
--   * adds a BEFORE INSERT OR UPDATE trigger that refuses a redeemed grant
--     without a redeemer on every live path, and admits it only as an INSERT
--     inside an import transfer session (OJ-1's
--     storage_journal_transfer_session(): a deliberate, non-escalating
--     member of tibotattle_source_transfer, never a superuser).
-- An UPDATE that would leave a redeemed grant without a redeemer (including
-- the ON DELETE SET NULL action of a later participant delete) is still
-- refused, exactly as 0015's CHECK refused it, so a live erasure keeps its
-- present behaviour. The refusal is the CHECK class (23514) with a constant
-- message; no value is interpolated.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint con
     WHERE con.conrelid = 'enrollment_grants'::regclass
       AND con.conname = 'enrollment_grants_check1'
       AND con.contype = 'c'
       AND pg_catalog.pg_get_constraintdef(con.oid) = 'CHECK ((((state = ''issued''::text) AND (redeemed_at IS NULL) AND (redeemed_participant_id IS NULL)) OR ((state = ''redeemed''::text) AND (redeemed_at IS NOT NULL) AND (redeemed_participant_id IS NOT NULL))))'
  ) THEN
    RAISE EXCEPTION 'enrollment_grants_shape_check_unexpected' USING ERRCODE = 'P1005';
  END IF;
END;
$$;

ALTER TABLE enrollment_grants DROP CONSTRAINT enrollment_grants_check1;
ALTER TABLE enrollment_grants
  ADD CONSTRAINT enrollment_grants_state_shape CHECK (
    (state = 'issued' AND redeemed_at IS NULL AND redeemed_participant_id IS NULL)
    OR (state = 'redeemed' AND redeemed_at IS NOT NULL)
  );

CREATE FUNCTION enrollment_grants_redeemer_required()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.state = 'redeemed' AND NEW.redeemed_participant_id IS NULL THEN
    IF TG_OP = 'INSERT' AND storage_journal_transfer_session() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'enrollment_grant_redeemer_required' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enrollment_grants_redeemer_required
BEFORE INSERT OR UPDATE ON enrollment_grants
FOR EACH ROW EXECUTE FUNCTION enrollment_grants_redeemer_required();
