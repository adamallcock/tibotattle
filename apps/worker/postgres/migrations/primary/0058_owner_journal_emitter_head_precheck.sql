-- PostgreSQL primary migration 0091 (staged; provisional number, assigned at
-- promotion): the owner-journal emitter checks for a head before it locks.
--
-- 0046 (13) made telemetry_emit_source_event write nothing for an owner that
-- already has a storage_owner_revisions head, but it still took
-- storage_source_state FOR UPDATE first. That row is the one global journal
-- lock. Every raw source change calls the emitter through the 0014 triggers:
-- each telemetry_records row, each contribution, each v1 chunk and each
-- v1.1/v1.2 domain-head change. So an upload for a headed owner held the
-- global lock from its first raw row until commit, although it journals
-- nothing there.
--
-- This forward replacement looks for the owner's head before taking the lock.
-- The answer cannot go stale:
--   * heads are retained: never deleted or truncated, never out of 'erased'
--     (0046 (5));
--   * an owner link's participant and digest never change, and the link is
--     deleted only after its participant row is gone (0029);
--   * the singleton source_id is never rewritten.
-- So a committed hit is exactly what the check under the lock would decide,
-- and the function returns without locking. A miss proves nothing, because
-- another transaction may be committing the owner's first exact row. It falls
-- through to the 0046 body unchanged, which takes the lock and checks again
-- under it.
--
-- Everything after the pre-check is the 0046 body verbatim. Journal rows do
-- not change: a headed owner gets none, an unheaded owner keeps its version-0
-- row, and sequences are still allocated under the lock. The pre-check takes
-- no row lock. The lock order stays participant, owner link, v1.1/v1.2 domain
-- head, storage_source_state, owner revision head.
--
-- Recorded for LF-2 (review 2026-09-26, recommendation 5): unheaded v0.x-only
-- owners keep the version-0 path, and every unheaded owner still reaches the
-- locked check. For such an owner, the first 0014 row of a v0.2 contribution
-- takes the global lock. The transaction then holds it across every
-- remaining record insert until commit, journaling one version-0 row per
-- record while the owner's analytics state is active. Recommendation 6
-- (OPS-11) sizes that hold. If it is long, LF-2 switches to one append per
-- contribution under a D1 parity oracle. LF-2 defines none yet, because D1's
-- legacy bridge is not ported, so that switch must add one. Until then, the
-- differential oracle in postgres-owner-journal-emitter-precheck.spec.mjs
-- stands in: every emitter outcome equals 0046's, row for row.

CREATE OR REPLACE FUNCTION telemetry_emit_source_event(
  event_owner_id text,
  event_key_value text,
  input_revision_value bigint
)
RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE source_id_value text;
        event_digest_value text;
        source_authority_epoch bigint;
        event_sequence bigint;
        event_owner_digest text;
        event_owner_revision bigint;
        event_owner_epoch bigint;
BEGIN
  IF event_owner_id IS NULL OR input_revision_value IS NULL THEN
    RETURN;
  END IF;
  -- A retained head behind an immutable owner link is a stable answer, so a
  -- hit needs no lock. A miss is checked again below, under the source lock,
  -- where a concurrently committed first head becomes visible.
  IF EXISTS (
    SELECT 1
      FROM storage_source_state state
      JOIN storage_v11_owner_links link
        ON link.participant_id=event_owner_id
      JOIN storage_owner_revisions head
        ON head.source_id=state.source_id AND head.owner_digest=link.owner_digest
     WHERE state.singleton=1
  ) THEN
    RETURN;
  END IF;
  -- Lock the source authority before reading its sequence so every producer
  -- serializes with the analytics worker and other source mutations.
  SELECT state.source_id,state.authority_epoch
    INTO source_id_value,source_authority_epoch
    FROM storage_source_state state
   WHERE state.singleton=1
   FOR UPDATE;
  IF source_id_value IS NOT NULL AND EXISTS (
    SELECT 1
      FROM storage_v11_owner_links link
      JOIN storage_owner_revisions head
        ON head.source_id=source_id_value AND head.owner_digest=link.owner_digest
     WHERE link.participant_id=event_owner_id
  ) THEN
    RETURN;
  END IF;
  SELECT link.owner_digest,owner.revision,owner.authority_epoch
    INTO event_owner_digest,event_owner_revision,event_owner_epoch
    FROM storage_v11_owner_links link
    JOIN analytics_owner_state owner
      ON owner.source_id=source_id_value AND owner.owner_digest=link.owner_digest
   WHERE link.participant_id=event_owner_id
     AND link.state='active' AND owner.state='active';
  IF source_id_value IS NULL
     OR event_owner_digest IS NULL
     OR event_owner_revision IS NULL
     OR event_owner_epoch IS NULL THEN
    RETURN;
  END IF;
  event_digest_value := md5(event_key_value || ':' || input_revision_value::text)
    || md5(event_owner_id || ':' || event_key_value || ':' || input_revision_value::text);
  SELECT COALESCE(MAX(changes.sequence),0)+1
    INTO event_sequence
    FROM storage_ingestion_changes changes
   WHERE changes.source_id=source_id_value;
  INSERT INTO storage_ingestion_changes
    (source_id,sequence,event_digest,owner_digest,owner_revision,authority_epoch,kind,recorded_ms)
  VALUES (source_id_value,event_sequence,event_digest_value,event_owner_digest,event_owner_revision,
    event_owner_epoch,'source-updated',floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
  ON CONFLICT (source_id,event_digest) DO NOTHING;
END;
$$;
