-- community_aggregate_exclusions: the operator abuse and quality exclusions
-- (N-EXCL, round 5: "Port them").
--
-- NUMBER. 0901 is a PLACEHOLDER (the stream brief's NNNN), chosen outside the
-- range any sibling stream stages so two staged files never share a version.
-- The integrator assigns the next free primary number at promotion and renames
-- the file; specs find it by its name suffix, so no spec changes then. The
-- migration is purely additive (one table, one index, one function, one
-- trigger), so it needs no CONTRACT_MIGRATIONS entry.
--
-- The table is the D1 table of migrations/0023 (rewritten verbatim by 0058),
-- with D1's TEXT instants as timestamptz and the same CHECKs:
--   * one row per operator decision, keyed by exclusion_id;
--   * participant_id is the excluded participant. Like D1 there is
--     deliberately no foreign key: D1 keeps the audit row after the participant
--     is removed. The cutover importer (scripts/postgres-legacy-contribution-
--     transfer.mjs) imports only rows whose participant is a sealed
--     participant, so no erased participant's id enters PostgreSQL; the
--     skipped rows are counted in its receipt;
--   * scope is the single D1 scope 'community_weekly';
--   * created_by_digest and revoked_by_digest are 64-hex pairwise digests of
--     the operator, never an identity.
--
-- Append-only like D1 (its community_aggregate_exclusion_no_delete trigger): a
-- row is never deleted; revocation is an UPDATE to state 'revoked' with
-- revoked_at and revoked_by_digest. D1's insert and update triggers that
-- withdrew and requeued the legacy WEEKLY snapshots are not ported: that
-- machinery does not exist on PostgreSQL, where analytics is recomputed.
--
-- READERS. Applying the exclusions in GCP analytics is the K-CORE-A stream's
-- job. The read contract is recorded in docs/receipts/2026-10-02-gcp-d-pt4x.md
-- ("Exclusion read contract"): an owner is excluded from community aggregates
-- for an analysis day D when a row has scope 'community_weekly', state
-- 'active', effective_at < the end of D and (expires_at IS NULL OR expires_at
-- > the start of D). At d43c8f92 only the legacy weekly builder read the table.
--
-- Grants: none, consistent with every other primary migration. The migrate job
-- grants the runtime role its table privileges.

CREATE TABLE community_aggregate_exclusions (
  exclusion_id text PRIMARY KEY CHECK (char_length(exclusion_id) BETWEEN 1 AND 120),
  participant_id text NOT NULL CHECK (char_length(participant_id) BETWEEN 1 AND 200),
  scope text NOT NULL CHECK (scope = 'community_weekly'),
  reason_code text NOT NULL CHECK (
    reason_code IN ('abuse_signal', 'data_quality', 'account_compromise', 'manual_review', 'other')
  ),
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_digest text NOT NULL CHECK (created_by_digest ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz,
  revoked_by_digest text CHECK (revoked_by_digest IS NULL OR revoked_by_digest ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (
    (state = 'active' AND revoked_at IS NULL AND revoked_by_digest IS NULL)
    OR
    (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_by_digest IS NOT NULL)
  )
);

CREATE INDEX community_aggregate_exclusions_participant
  ON community_aggregate_exclusions(participant_id, scope, state, effective_at);

CREATE FUNCTION community_aggregate_exclusion_no_delete()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_aggregate_exclusion_append_only' USING ERRCODE = 'P1005';
END;
$$;

CREATE TRIGGER community_aggregate_exclusion_no_delete
  BEFORE DELETE ON community_aggregate_exclusions
  FOR EACH ROW EXECUTE FUNCTION community_aggregate_exclusion_no_delete();
