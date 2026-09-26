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
-- identifier is interpolated. Lock order: v1.2 head (held by the statement
-- that changed it), participant, owner link, storage_source_state and owner
-- revision head (inside the append). The backfill takes the participant share
-- lock before the head, as the activation path does, so it never inverts
-- against an eraser that holds the participant.

-- (1) Retire the 0014 head trigger. Every other trigger on the table stays.
DROP TRIGGER telemetry_v12_domain_head_source_revision ON telemetry_v12_domain_heads;

-- (2) Bridge one accepted head, D1 0011 storage_v12_head_request_apply and
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
  IF NOT EXISTS (
    SELECT 1 FROM community_public_source_owners public_owner
     WHERE public_owner.participant_id = participant_id_value
       AND (public_owner.device_id IS NULL OR public_owner.device_id = domain_row.device_id)
  ) THEN
    RETURN false;
  END IF;

  owner_digest_value := storage_owner_link_ensure(participant_id_value, 'active');
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
  -- A later eligible head re-activates a withdrawn (never an erased) owner.
  UPDATE storage_v11_owner_links
     SET state = 'active'
   WHERE participant_id = participant_id_value AND state = 'withdrawn';
  RETURN true;
END;
$$;

-- (3) The head trigger. (a) is the 0014 telemetry_legacy_source_revision body
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

-- (4) Heads the bridge still owes: an eligible current head of an owner that
-- is not erased, with no receipt for its (participant, generation, revision).
-- The same predicate drives the count and the backfill, so everything the
-- count reports is something the backfill can bridge.
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

-- (5) Bounded, idempotent repair. Refused in transfer sessions, where the
-- bridge is bypassed by design; without storage_source_state it bridges
-- nothing. Heads are visited in participant_id COLLATE "C" order; each takes
-- the participant share lock, then the head lock, then bridges the head as it
-- is now, so a concurrent activation that already bridged it adds nothing.
CREATE FUNCTION storage_v12_bridge_backfill(limit_value integer)
RETURNS integer
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  candidate record;
  current_generation text;
  current_revision bigint;
  bridged integer := 0;
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
    PERFORM 1 FROM participants participant
     WHERE participant.id = candidate.participant_id AND participant.state = 'active'
     FOR SHARE;
    CONTINUE WHEN NOT FOUND;
    SELECT head.generation_id, head.revision::bigint
      INTO current_generation, current_revision
      FROM telemetry_v12_domain_heads head
     WHERE head.participant_id = candidate.participant_id
     FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    IF storage_v12_bridge_head(candidate.participant_id, current_generation, current_revision) THEN
      bridged := bridged + 1;
    END IF;
  END LOOP;
  RETURN bridged;
END;
$$;
-- A maintenance entrypoint, granted deliberately like storage_journal_append.
REVOKE ALL ON FUNCTION storage_v12_bridge_backfill(integer) FROM PUBLIC;

-- (6) One-time backfill of every head that is eligible now. It is a no-op
-- without storage_source_state (the pending count then reports the heads)
-- and in a transfer session, and bridges each head at most once: a second
-- run finds nothing pending.
DO $$
DECLARE
  bridged integer;
BEGIN
  IF storage_journal_transfer_session()
     OR NOT EXISTS (SELECT 1 FROM storage_source_state source WHERE source.singleton = 1) THEN
    RETURN;
  END IF;
  LOOP
    bridged := storage_v12_bridge_backfill(500);
    EXIT WHEN bridged = 0;
  END LOOP;
END;
$$;
