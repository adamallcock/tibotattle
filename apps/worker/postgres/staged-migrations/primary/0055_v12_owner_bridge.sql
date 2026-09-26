-- PostgreSQL primary migration 0055 (staged): v1.2 owner bridge.
--
-- D1 journals every eligible accepted v1.2 head change as one owner-active
-- event (ingestion-isolation 0011:259-348): the head change mints or reuses
-- the shared owner link, records one storage_v12_event_sources receipt and
-- appends one exact journal row whose object digest is that receipt. Before
-- this migration a PostgreSQL v1.2 head change reached only the 0014
-- telemetry_legacy_source_revision trigger, which journals nothing for an
-- owner without an analytics state, so GCP-native v1.2 owners never became
-- visible to analytics.
--
-- This migration replaces that trigger on telemetry_v12_domain_heads with
-- storage_v12_head_publication(), which:
--   (a) always reproduces the 0014 input_versions and input_source_digests
--       effect exactly (event keys, old-owner branch and upsert), and never
--       calls telemetry_emit_source_event, so no v1.2 head change writes a
--       version-0 row;
--   (b) on INSERT, or an UPDATE that changes generation_id or revision,
--       bridges the head through storage_v12_bridge_head();
--   (c) on DELETE, does only (a).
-- storage_v12_bridge_pending_count() and storage_v12_bridge_backfill() let
-- maintenance report and repair heads that could not be bridged when they
-- changed (for example before storage_source_state existed); the migration
-- ends with a one-time backfill of the same heads.
--
-- Every exact journal row still comes from storage_journal_append (0046).
-- Every RAISE carries a constant message and ERRCODE; no value, digest or
-- identifier is interpolated.
--
-- Lock order. 0046 states participant, owner link, v1.2 head,
-- storage_source_state, owner revision head. The bridge keeps the participant
-- first and storage_source_state and the owner revision head last (both inside
-- storage_journal_append), but takes the v1.2 head before the owner link:
--   activation: participant (FOR SHARE, with its device, grant, upload owner
--     and ledger, in assertPostgresTypedV12WriteAllowed), v1.2 head (the
--     statement that fires the trigger), retention marker, owner link, source;
--   backfill: participant, v1.2 head, device, retention marker, owner link,
--     each with SKIP LOCKED, then source.
-- A head trigger cannot lock the link before the head its statement already
-- holds. The inversion cannot deadlock: the other paths that lock a v1.2
-- owner's link and then its head hold that participant first, erasure FOR
-- UPDATE (so it serializes with the bridge's FOR SHARE at the participant)
-- and the receipt membership guard only inside this bridge, after both rows
-- are held; and the backfill never waits on any of its SKIP LOCKED rows.
-- storage_source_state is a singleton every journal producer takes last, so
-- no transaction may wait on another owner's rows while it holds it: the
-- maintenance backfill bridges at most one head per call (its caller commits
-- after each call), and the one-time backfill takes every candidate's rows
-- before its first append.
--
-- Eligibility (community_public_source_owners) depends on rows the bridge
-- does not write. It cannot change under the bridge because:
--   * the activation path already holds the participant, device, grant,
--     upload-owner and ledger rows FOR SHARE when its head change fires the
--     trigger, and the backfill takes the participant and the head's device
--     FOR SHARE (every PostgreSQL revocation updates that device row);
--   * the bridge takes the owner's retention marker FOR SHARE before it reads
--     eligibility, and a marker retirement (0041) locks the marker before it
--     withdraws the link, so the retirement either committed before the read
--     or waits for the bridge;
--   * eligibility is read again under the link lock, so a withdrawal that
--     committed while the bridge waited on the link is never reversed;
--   * a link the bridge mints starts 'withdrawn' and turns 'active' only with
--     its owner-active row, so no refusal leaves a new link active.

-- (1) Retire the 0014 head trigger. Every other trigger on the table stays.
DROP TRIGGER telemetry_v12_domain_head_source_revision ON telemetry_v12_domain_heads;

-- (2) D1 0011 head eligibility: a community_public_source_owners row for the
-- participant whose device is NULL (social) or the head's domain device. The
-- function reads the calling statement's snapshot, so a call made after a
-- lock wait sees what committed during the wait.
CREATE FUNCTION storage_v12_bridge_eligible(participant_id_value text, device_id_value text)
RETURNS boolean
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM community_public_source_owners public_owner
     WHERE public_owner.participant_id = participant_id_value
       AND (public_owner.device_id IS NULL OR public_owner.device_id = device_id_value))
$$;

-- (3) Bridge one accepted head, D1 0011 storage_v12_head_request_apply and
-- storage_v12_event_publish. Returns true only when this call recorded a new
-- receipt and its owner-active row. It does nothing (and raises nothing) in a
-- transfer session, without storage_source_state, for an inactive or
-- ineligible participant, for an erased owner, or when the receipt already
-- exists. The participant is locked, and eligibility read, before the link is
-- minted, so a concurrent erasure can never make the membership guard below
-- abort the head change itself.
CREATE FUNCTION storage_v12_bridge_head(
  participant_id_value text,
  generation_id_value text,
  head_revision_value bigint
)
RETURNS boolean
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  domain_row telemetry_v12_domains%ROWTYPE;
  owner_digest_value text;
  link_state text;
  event_digest_value text;
BEGIN
  IF participant_id_value IS NULL OR generation_id_value IS NULL
     OR head_revision_value IS NULL OR head_revision_value < 1 THEN
    RETURN false;
  END IF;
  IF storage_journal_transfer_session() THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_source_state source WHERE source.singleton = 1) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM participants participant
   WHERE participant.id = participant_id_value AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT * INTO domain_row
    FROM telemetry_v12_domains domain
   WHERE domain.id = generation_id_value AND domain.participant_id = participant_id_value;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- A retained owner's marker cannot be retired between this lock and the end
  -- of the transaction; a retirement already under way is waited for.
  PERFORM 1 FROM accountless_public_history_retention marker
   WHERE marker.participant_id = participant_id_value
   FOR SHARE;
  IF NOT storage_v12_bridge_eligible(participant_id_value, domain_row.device_id) THEN
    RETURN false;
  END IF;

  -- A new link starts withdrawn; the owner-active row below activates it.
  owner_digest_value := storage_owner_link_ensure(participant_id_value, 'withdrawn');
  SELECT owner_link.state INTO link_state
    FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = participant_id_value
     AND owner_link.owner_digest = owner_digest_value
   FOR UPDATE;
  IF NOT FOUND OR link_state = 'erased' THEN
    RETURN false;
  END IF;
  -- An erased owner is never re-bridged, whichever of its link or its
  -- journal head recorded the erasure first.
  IF EXISTS (
    SELECT 1 FROM storage_owner_revisions head
     WHERE head.owner_digest = owner_digest_value AND head.state = 'erased'
  ) THEN
    RETURN false;
  END IF;
  -- A fresh read under the link lock; the read above may predate the wait.
  IF NOT storage_v12_bridge_eligible(participant_id_value, domain_row.device_id) THEN
    RETURN false;
  END IF;

  -- The digest is random and opaque, like D1's lower(hex(randomblob(32))),
  -- and recorded_ms is whole seconds, like D1's strftime('%s','now')*1000.
  event_digest_value := encode(
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  INSERT INTO storage_v12_event_sources (
    event_digest, owner_digest, participant_id, device_id, generation_id,
    previous_generation_id, manifest_digest, head_revision, recorded_ms
  ) VALUES (
    event_digest_value, owner_digest_value, participant_id_value, domain_row.device_id,
    domain_row.id, domain_row.previous_generation_id, domain_row.manifest_digest,
    head_revision_value, floor(extract(epoch FROM clock_timestamp()))::bigint * 1000
  )
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM storage_journal_append('owner-active', owner_digest_value, event_digest_value,
    event_digest_value, domain_row.manifest_digest);
  -- An owner without a v1.1 generation carries this event as its terminal
  -- object, so a later withdrawal or erasure row has exact digests.
  UPDATE storage_v11_owner_links
     SET object_digest = event_digest_value, manifest_digest = domain_row.manifest_digest
   WHERE participant_id = participant_id_value AND generation_id IS NULL;
  -- A new link, or a later eligible head of a withdrawn (never an erased)
  -- owner, becomes active with its owner-active row.
  UPDATE storage_v11_owner_links
     SET state = 'active'
   WHERE participant_id = participant_id_value AND state = 'withdrawn';
  RETURN true;
END;
$$;

-- (4) The head trigger. (a) is the 0014 telemetry_legacy_source_revision body
-- for this table without its telemetry_emit_source_event calls: the same
-- event keys (the table has no id column, so its coalesce reduces to the
-- generation), the same active-participant conditions and the same
-- input_versions upsert, including the old-owner branch.
CREATE FUNCTION storage_v12_head_publication()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_id text;
        old_owner_id text;
        event_key text;
        old_event_key text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  event_key := TG_TABLE_NAME || ':' || TG_OP || ':' || owner_id || ':' || coalesce(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.generation_id ELSE NEW.generation_id END, '');
  IF owner_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM participants WHERE id = owner_id AND state='active'
  ) THEN
    PERFORM telemetry_append_source_digest(owner_id,event_key);
    INSERT INTO input_versions(participant_id, revision)
      VALUES (owner_id, 1)
      ON CONFLICT (participant_id)
      DO UPDATE SET revision = input_versions.revision + 1;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.participant_id IS DISTINCT FROM NEW.participant_id
     AND OLD.participant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM participants WHERE id = OLD.participant_id AND state='active') THEN
    old_owner_id := OLD.participant_id;
    old_event_key := TG_TABLE_NAME || ':UPDATE:old:' || old_owner_id || ':' || coalesce(
      OLD.generation_id, '');
    PERFORM telemetry_append_source_digest(old_owner_id,old_event_key);
    INSERT INTO input_versions(participant_id, revision)
      VALUES (old_owner_id, 1)
      ON CONFLICT (participant_id)
      DO UPDATE SET revision = input_versions.revision + 1;
  END IF;

  -- (b) D1 fires its bridge on head insert and on a changed generation or
  -- revision (0011 storage_v12_head_insert / storage_v12_head_update).
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND (OLD.generation_id IS DISTINCT FROM NEW.generation_id
                               OR OLD.revision IS DISTINCT FROM NEW.revision)) THEN
    PERFORM storage_v12_bridge_head(NEW.participant_id, NEW.generation_id, NEW.revision);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER storage_v12_head_publication
  AFTER INSERT OR UPDATE OR DELETE ON telemetry_v12_domain_heads
  FOR EACH ROW EXECUTE FUNCTION storage_v12_head_publication();

-- (5) Heads the bridge still owes: an eligible current head of an owner that
-- is not erased, with no receipt for its (participant, generation, revision).
-- The eligibility predicate is storage_v12_bridge_eligible's, set-based, so
-- everything the count reports is something the backfill can bridge.
CREATE FUNCTION storage_v12_bridge_pending_heads()
RETURNS TABLE (participant_id text, generation_id text, head_revision bigint)
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT head.participant_id, head.generation_id, head.revision::bigint
    FROM telemetry_v12_domain_heads head
    JOIN telemetry_v12_domains domain
      ON domain.id = head.generation_id AND domain.participant_id = head.participant_id
   WHERE EXISTS (
           SELECT 1 FROM community_public_source_owners public_owner
            WHERE public_owner.participant_id = head.participant_id
              AND (public_owner.device_id IS NULL OR public_owner.device_id = domain.device_id))
     AND NOT EXISTS (
           SELECT 1 FROM storage_v12_event_sources receipt
            WHERE receipt.participant_id = head.participant_id
              AND receipt.generation_id = head.generation_id
              AND receipt.head_revision = head.revision)
     AND NOT EXISTS (
           SELECT 1 FROM storage_v11_owner_links owner_link
            WHERE owner_link.participant_id = head.participant_id
              AND (owner_link.state = 'erased' OR EXISTS (
                SELECT 1 FROM storage_owner_revisions owner_head
                 WHERE owner_head.owner_digest = owner_link.owner_digest
                   AND owner_head.state = 'erased')))
$$;

-- A content-free health count; it does not require storage_source_state.
CREATE FUNCTION storage_v12_bridge_pending_count()
RETURNS bigint
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT count(*)::bigint FROM storage_v12_bridge_pending_heads()
$$;

-- (6) Take every row the bridge needs for one pending head without waiting
-- on another transaction's row lock: the participant (share), the v1.2 head,
-- the head's device (share), the retention marker if there is one (share) and
-- the owner link. A candidate any of whose rows another transaction holds (an
-- activation bridging its own new head, an eraser, a revocation, a marker
-- retirement, another backfill) is skipped and stays pending for a later
-- run. Eligibility is read once those rows are held, and only an eligible
-- owner without a link has one minted ('withdrawn', as storage_v12_bridge_head
-- would); that insert can wait only on a concurrent first mint, before any
-- append. Returns true when every row is held.
CREATE FUNCTION storage_v12_bridge_lock_pending(participant_id_value text)
RETURNS boolean
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  device_id_value text;
BEGIN
  PERFORM 1 FROM participants participant
   WHERE participant.id = participant_id_value AND participant.state = 'active'
   FOR SHARE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT domain.device_id INTO device_id_value
    FROM telemetry_v12_domain_heads head
    JOIN telemetry_v12_domains domain
      ON domain.id = head.generation_id AND domain.participant_id = head.participant_id
   WHERE head.participant_id = participant_id_value
   FOR UPDATE OF head SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM device_credentials device
   WHERE device.id = device_id_value
   FOR SHARE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM accountless_public_history_retention marker
              WHERE marker.participant_id = participant_id_value) THEN
    PERFORM 1 FROM accountless_public_history_retention marker
     WHERE marker.participant_id = participant_id_value
     FOR SHARE SKIP LOCKED;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  IF NOT storage_v12_bridge_eligible(participant_id_value, device_id_value) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_v11_owner_links owner_link
                  WHERE owner_link.participant_id = participant_id_value) THEN
    PERFORM storage_owner_link_ensure(participant_id_value, 'withdrawn');
  END IF;
  PERFORM 1 FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = participant_id_value
   FOR UPDATE SKIP LOCKED;
  RETURN FOUND;
END;
$$;

-- (7) Bounded, idempotent repair. Refused in transfer sessions, where the
-- bridge is bypassed by design; without storage_source_state it bridges
-- nothing. It inspects at most limit_value pending heads in participant_id
-- COLLATE "C" order and bridges at most one: the append takes
-- storage_source_state, so the call returns (and its caller commits) before
-- it touches another owner. It returns 1 when it bridged a head, else 0.
-- Each candidate is taken through storage_v12_bridge_lock_pending and bridged
-- as it is now, so a head that an activation already bridged adds nothing.
CREATE FUNCTION storage_v12_bridge_backfill(limit_value integer)
RETURNS integer
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  candidate record;
  current_generation text;
  current_revision bigint;
BEGIN
  IF limit_value IS NULL OR limit_value < 1 OR limit_value > 500 THEN
    RAISE EXCEPTION 'storage_v12_bridge_limit_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF storage_journal_transfer_session() THEN
    RAISE EXCEPTION 'storage_v12_bridge_transfer_session' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_source_state source WHERE source.singleton = 1) THEN
    RETURN 0;
  END IF;
  FOR candidate IN
    SELECT pending.participant_id
      FROM storage_v12_bridge_pending_heads() pending
     ORDER BY pending.participant_id COLLATE "C"
     LIMIT limit_value
  LOOP
    CONTINUE WHEN NOT storage_v12_bridge_lock_pending(candidate.participant_id);
    SELECT head.generation_id, head.revision::bigint
      INTO current_generation, current_revision
      FROM telemetry_v12_domain_heads head
     WHERE head.participant_id = candidate.participant_id;
    IF storage_v12_bridge_head(candidate.participant_id, current_generation, current_revision) THEN
      RETURN 1;
    END IF;
  END LOOP;
  RETURN 0;
END;
$$;
-- A maintenance entrypoint, granted deliberately like storage_journal_append.
REVOKE ALL ON FUNCTION storage_v12_bridge_backfill(integer) FROM PUBLIC;

-- (8) One-time backfill of every head that is eligible now. It is a no-op
-- without storage_source_state (the pending count then reports the heads)
-- and in a transfer session, and bridges each head at most once: a second
-- run finds nothing pending. It runs in the migration's transaction, so it
-- first takes every candidate's rows through storage_v12_bridge_lock_pending,
-- skipping any that another transaction holds (those stay pending for the
-- maintenance backfill), and only then appends, so it never waits on another
-- owner's rows while it holds storage_source_state.
DO $$
DECLARE
  candidate record;
  held text[] := ARRAY[]::text[];
  participant_value text;
  current_generation text;
  current_revision bigint;
BEGIN
  IF storage_journal_transfer_session()
     OR NOT EXISTS (SELECT 1 FROM storage_source_state source WHERE source.singleton = 1) THEN
    RETURN;
  END IF;
  FOR candidate IN
    SELECT pending.participant_id
      FROM storage_v12_bridge_pending_heads() pending
     ORDER BY pending.participant_id COLLATE "C"
  LOOP
    IF storage_v12_bridge_lock_pending(candidate.participant_id) THEN
      held := held || candidate.participant_id;
    END IF;
  END LOOP;
  FOREACH participant_value IN ARRAY held LOOP
    SELECT head.generation_id, head.revision::bigint
      INTO current_generation, current_revision
      FROM telemetry_v12_domain_heads head
     WHERE head.participant_id = participant_value;
    PERFORM storage_v12_bridge_head(participant_value, current_generation, current_revision);
  END LOOP;
END;
$$;
