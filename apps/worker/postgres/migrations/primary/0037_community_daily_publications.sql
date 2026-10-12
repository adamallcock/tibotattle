-- PostgreSQL's public daily lane uses immutable per-day revisions, independent
-- from the model/graph generation tables. This migration establishes storage
-- and read fences only; the daily calculation/publication producer is a
-- separate qualification step.

CREATE TABLE community_daily_aggregates (
  source_id text NOT NULL,
  source_namespace text NOT NULL,
  day date NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  payload_json text NOT NULL
    CHECK (octet_length(convert_to(payload_json, 'UTF8')) <= 262144),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_authority_epoch bigint NOT NULL CHECK (source_authority_epoch >= 0),
  source_cursor_sequence bigint NOT NULL CHECK (source_cursor_sequence >= 0),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  collection_revision bigint NOT NULL CHECK (collection_revision >= 1),
  release_state text NOT NULL CHECK (release_state IN ('published', 'withdrawn')),
  released_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  PRIMARY KEY (source_id, day, revision),
  CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  CHECK (length(source_namespace) BETWEEN 1 AND 200 AND source_namespace !~ '[[:cntrl:]]'),
  CHECK ((release_state = 'published' AND withdrawn_at IS NULL)
      OR (release_state = 'withdrawn' AND withdrawn_at IS NOT NULL))
);
CREATE INDEX community_daily_aggregates_public_read
  ON community_daily_aggregates(source_id, source_namespace, day, revision DESC);

CREATE FUNCTION community_daily_aggregate_revision_is_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.release_state = 'published' AND NEW.release_state = 'withdrawn'
      AND NEW.withdrawn_at IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY['release_state', 'withdrawn_at'])
          = (to_jsonb(OLD) - ARRAY['release_state', 'withdrawn_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'community_daily_revision_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER community_daily_aggregate_revision_is_immutable
BEFORE UPDATE ON community_daily_aggregates
FOR EACH ROW EXECUTE FUNCTION community_daily_aggregate_revision_is_immutable();

CREATE FUNCTION community_daily_aggregate_no_delete()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'community_daily_revision_no_delete' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER community_daily_aggregate_no_delete
BEFORE DELETE ON community_daily_aggregates
FOR EACH ROW EXECUTE FUNCTION community_daily_aggregate_no_delete();

CREATE TABLE community_daily_allowance_publication_state (
  source_id text PRIMARY KEY,
  source_namespace text NOT NULL,
  publication_state text NOT NULL CHECK (publication_state IN ('updating', 'ready')),
  expected_basis text NOT NULL,
  attribution_method_version text,
  safe_from_day date,
  safe_to_day date,
  source_authority_epoch bigint NOT NULL CHECK (source_authority_epoch >= 0),
  source_cursor_sequence bigint NOT NULL CHECK (source_cursor_sequence >= 0),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  collection_revision bigint NOT NULL CHECK (collection_revision >= 1),
  hard_invalidation_sequence bigint NOT NULL DEFAULT 0
    CHECK (hard_invalidation_sequence >= 0),
  updated_at timestamptz NOT NULL,
  CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  CHECK (length(source_namespace) BETWEEN 1 AND 200 AND source_namespace !~ '[[:cntrl:]]'),
  CHECK ((safe_from_day IS NULL) = (safe_to_day IS NULL)),
  CHECK (safe_from_day IS NULL OR safe_to_day >= safe_from_day),
  CHECK (publication_state <> 'ready' OR
    (attribution_method_version IS NOT NULL AND safe_from_day IS NOT NULL))
);

CREATE TABLE community_daily_allowance_preview_cache (
  source_id text PRIMARY KEY,
  source_namespace text NOT NULL,
  generated_at timestamptz NOT NULL,
  payload_json text NOT NULL
    CHECK (octet_length(convert_to(payload_json, 'UTF8')) <= 262144),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  attribution_method_version text NOT NULL,
  source_authority_epoch bigint NOT NULL CHECK (source_authority_epoch >= 0),
  source_cursor_sequence bigint NOT NULL CHECK (source_cursor_sequence >= 0),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  collection_revision bigint NOT NULL CHECK (collection_revision >= 1),
  CHECK (length(source_id) BETWEEN 1 AND 200 AND source_id !~ '[[:cntrl:]]'),
  CHECK (length(source_namespace) BETWEEN 1 AND 200 AND source_namespace !~ '[[:cntrl:]]')
);

-- A terminal source event withdraws every public daily revision for that
-- source. Ordinary appended input preserves the last complete publication;
-- its successor may publish after rebuilding against the newer cursor.
CREATE FUNCTION community_daily_terminal_event_withdrawal()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Migration 0032 owns the canonical source-state fence. A missing daily
  -- readiness row means there is nothing to invalidate; analytics tables must
  -- never become a prerequisite for committing an owner terminal event.
  PERFORM 1 FROM storage_source_state source
   WHERE source.singleton = 1 AND source.source_id = NEW.source_id
   FOR UPDATE;
  PERFORM 1 FROM analytics_source_cursors cursor
   WHERE cursor.source_id = NEW.source_id
   FOR UPDATE;

  UPDATE community_daily_aggregates
     SET release_state = 'withdrawn', withdrawn_at = clock_timestamp()
   WHERE source_id = NEW.source_id AND release_state = 'published';

  UPDATE community_daily_allowance_publication_state
     SET publication_state = 'updating',
         hard_invalidation_sequence = GREATEST(hard_invalidation_sequence, NEW.sequence),
         updated_at = clock_timestamp()
   WHERE source_id = NEW.source_id;
  DELETE FROM community_daily_allowance_preview_cache WHERE source_id = NEW.source_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_daily_terminal_event_withdrawal
AFTER INSERT ON storage_ingestion_changes
FOR EACH ROW WHEN (NEW.kind IN ('owner-withdrawn', 'owner-erased'))
EXECUTE FUNCTION community_daily_terminal_event_withdrawal();
