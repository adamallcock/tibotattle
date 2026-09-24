-- PostgreSQL primary migration 0016: publication policy authority.
--
-- `publication_state` already owns the aggregate publication lifecycle.  Keep
-- the policy revision on that same singleton so a publication cannot validate
-- only the collection-control revision while an analytical policy changed.
-- This is deliberately a forward, shape-checked ALTER: an existing table
-- with a different contract must fail the migration rather than be silently
-- certified by an IF NOT EXISTS clause.
ALTER TABLE publication_state
  ADD COLUMN policy_revision bigint NOT NULL DEFAULT 1
    CHECK (policy_revision >= 1);

-- The public admin contract starts collection controls at revision 1.  The
-- original 0007 bootstrap used zero only as an uninitialized placeholder;
-- promote that exact contained bootstrap before tightening the forward
-- invariant.  Any other pre-existing row is deliberately rejected by the
-- constraint instead of being silently rewritten.
UPDATE collection_controls
   SET revision=1
 WHERE singleton=1 AND revision=0
   AND control_state='contained'
   AND enrollment_enabled=false
   AND upload_registration_enabled=false
   AND processing_enabled=false
   AND publication_enabled=false;
ALTER TABLE collection_controls DROP CONSTRAINT collection_controls_revision_check;
ALTER TABLE collection_controls
  ADD CONSTRAINT collection_controls_revision_check CHECK (revision >= 1);

-- Each captured member carries the exact source and owner revision observed
-- with the cohort.  Publication may then reject a newer admitted source for
-- one owner even when a global epoch producer has not yet delivered its
-- journal receipt.  Defaults keep older staged receipts inspectable; new
-- capture operations always write the authoritative values.
ALTER TABLE analytics_publication_owner_members
  ADD COLUMN input_revision bigint NOT NULL DEFAULT 0
    CHECK (input_revision >= 0),
  ADD COLUMN owner_revision bigint NOT NULL DEFAULT 0
    CHECK (owner_revision >= 0),
  ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 0
    CHECK (authority_epoch >= 0);

-- Quarantine timestamps are display/retention metadata, not the identity of a
-- registration.  PostgreSQL may store a default clock_timestamp() with
-- microseconds while a JavaScript Date round trip exposes milliseconds.  An
-- opaque per-row token keeps a stale cleanup attempt from claiming a later
-- registration that reuses the same object key after the old row is cleared.
ALTER TABLE pending_objects
  ADD COLUMN registration_token text NOT NULL
    DEFAULT md5(random()::text || clock_timestamp()::text || txid_current()::text)
    CHECK (registration_token ~ '^[0-9a-f]{32}$');
CREATE UNIQUE INDEX pending_objects_registration_token
  ON pending_objects(registration_token);
