-- pending_object_transfer_holds: the E-PT4 reconciliation guard.
--
-- NUMBER. Primary 0067, assigned by the integrator at the D-PT4X merge
-- (2026-10-02), right after community_aggregate_exclusions (0066). Until then
-- it was staged as staged-migrations/primary/0902_pending_object_transfer_holds.sql
-- (a placeholder number); specs find it by its name suffix. Purely additive
-- (one table, one function, one trigger): no CONTRACT_MIGRATIONS entry.
--
-- WHY. The cutover imports every sealed D1 pending_quarantine_objects row into
-- pending_objects (the 'pending-registrations' stage). Those registrations name
-- objects that, until the post-switch PT-7 copy, exist only in Cloudflare R2.
-- Without this guard, C-MAINT's reconciler (src/postgres-quarantine-
-- reconciliation.ts) would age such a row, find the object absent in GCS and
-- clear it as "already absent"; after PT-7 copied the object it would then sit
-- in GCS untracked forever.
--
-- CONTRACT.
--   * The importer writes one hold per sealed registration (object_key =
--     the sealed r2_key) in the same transaction as the registration.
--     seal_sha256 binds the hold to the PT-2-lite seal that produced it.
--   * The reconciler never selects or claims a pending_objects row whose
--     object_key has an unreleased hold. It touches neither the row nor the
--     object store for it, so readiness is unaffected.
--   * PT-7 releases a hold only after the object is copied to GCS or proven
--     absent from R2, through releasePostgresPendingObjectTransferHolds, with
--     the sha256 of its owner-directory receipt. The released row then
--     reconciles normally (grace, then head and delete if still unreferenced).
--   * A hold is never deleted and never re-held: the only permitted change is
--     the one-way release below. PT-8 preflight P13 checks this guard exists
--     (or the owner flag accept-orphan-registration-clearing).
--
-- Content-free: an object key (already stored in pending_objects), the
-- contribution id it was registered for, a seal digest, instants and a receipt
-- digest. Grants: none; the migrate job grants the runtime role.

CREATE TABLE pending_object_transfer_holds (
  object_key text PRIMARY KEY CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  contribution_id text NOT NULL UNIQUE CHECK (char_length(contribution_id) BETWEEN 1 AND 200),
  seal_sha256 text NOT NULL CHECK (seal_sha256 ~ '^[0-9a-f]{64}$'),
  held_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  release_receipt_sha256 text CHECK (release_receipt_sha256 IS NULL OR release_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK ((released_at IS NULL) = (release_receipt_sha256 IS NULL))
);

CREATE FUNCTION pending_object_transfer_hold_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pending_object_transfer_hold_immutable' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.contribution_id IS DISTINCT FROM OLD.contribution_id
     OR NEW.seal_sha256 IS DISTINCT FROM OLD.seal_sha256
     OR NEW.held_at IS DISTINCT FROM OLD.held_at
     OR OLD.released_at IS NOT NULL
     OR NEW.released_at IS NULL
     OR NEW.release_receipt_sha256 IS NULL THEN
    RAISE EXCEPTION 'pending_object_transfer_hold_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pending_object_transfer_hold_guard
  BEFORE UPDATE OR DELETE ON pending_object_transfer_holds
  FOR EACH ROW EXECUTE FUNCTION pending_object_transfer_hold_guard();
