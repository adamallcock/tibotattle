-- PostgreSQL primary migration 0032: preserve last-good publications while
-- ordinary input is queued, and tombstone only explicit terminal owner events.
-- The invalidation row is durable and keyed to one immutable generation.

CREATE FUNCTION invalidate_analytics_publications_for_owner(
  source_id_value text,
  owner_digest_value text,
  reason_value text
) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF source_id_value IS NULL OR source_id_value !~ '^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$'
      OR owner_digest_value IS NULL
      OR owner_digest_value !~ '^[0-9a-f]{64}$'
      OR reason_value NOT IN ('owner-erased', 'owner-withdrawn') THEN
    RAISE EXCEPTION 'analytics_publication_invalidation_invalid' USING ERRCODE = 'P1005';
  END IF;
  INSERT INTO analytics_publication_invalidations
    (source_id, day, metric, generation, owner_digest, reason, invalidated_at)
  SELECT member.source_id, member.day, member.metric, member.generation,
         member.owner_digest, reason_value, clock_timestamp()
    FROM analytics_publication_owner_members member
   WHERE member.source_id = source_id_value
     AND member.owner_digest = owner_digest_value
  ON CONFLICT (source_id, day, metric, generation, owner_digest) DO UPDATE
     SET reason = CASE
       WHEN analytics_publication_invalidations.reason = 'owner-erased'
         OR EXCLUDED.reason = 'owner-erased' THEN 'owner-erased'
       ELSE 'owner-withdrawn'
     END,
     invalidated_at = GREATEST(analytics_publication_invalidations.invalidated_at, EXCLUDED.invalidated_at);
END;
$$;

-- Source terminal events are the public/security withdrawal authority. Lock in
-- the same order as graph publication (source, cursor, owner) before recording
-- invalidation so a candidate publication either commits before this fence
-- and is tombstoned, or observes the terminal state and defers.
CREATE FUNCTION terminal_event_publication_invalidation()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM storage_source_state source
   WHERE source.singleton = 1 AND source.source_id = NEW.source_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analytics_publication_source_missing' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM analytics_source_cursors cursor
   WHERE cursor.source_id = NEW.source_id
   FOR UPDATE;
  -- A freshly imported or partially initialized source may have a durable
  -- terminal event before analytics delivery has created its cursor. The
  -- source-row lock still serializes the journal write with graph publication;
  -- public reads join the cursor and therefore remain fail-closed until it
  -- exists. Do not reject the authoritative journal event for missing cursor.
  PERFORM 1 FROM analytics_owner_state owner
   WHERE owner.source_id = NEW.source_id AND owner.owner_digest = NEW.owner_digest
   FOR UPDATE;
  PERFORM invalidate_analytics_publications_for_owner(
    NEW.source_id,
    NEW.owner_digest,
    CASE WHEN NEW.kind = 'owner-erased' THEN 'owner-erased' ELSE 'owner-withdrawn' END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER terminal_event_publication_invalidation
AFTER INSERT ON storage_ingestion_changes
FOR EACH ROW WHEN (NEW.kind IN ('owner-withdrawn', 'owner-erased'))
EXECUTE FUNCTION terminal_event_publication_invalidation();

-- Local owner erasure has a separate, receipt-backed terminal proof and may
-- happen even when the source journal is being retired. Ordinary owner-link
-- state changes, including upload-capability updates, are not hard graph fences.
CREATE FUNCTION erased_owner_link_publication_invalidation()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  source_id_value text;
BEGIN
  IF OLD.state IS NOT DISTINCT FROM NEW.state OR NEW.state <> 'erased' THEN RETURN NEW; END IF;
  FOR source_id_value IN
    SELECT DISTINCT member.source_id
      FROM analytics_publication_owner_members member
     WHERE member.owner_digest = NEW.owner_digest
  LOOP
    PERFORM invalidate_analytics_publications_for_owner(source_id_value, NEW.owner_digest, 'owner-erased');
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER erased_owner_link_publication_invalidation
AFTER UPDATE OF state ON storage_v11_owner_links
FOR EACH ROW EXECUTE FUNCTION erased_owner_link_publication_invalidation();
