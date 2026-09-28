-- PostgreSQL primary migration 0094 (staged): gate the public-source
-- bootstrap on exact social v0.2 source receipts.
--
-- D1 ingestion-bridge 0002 stores one immutable
-- (event_digest, owner_digest, participant_id, input_revision, change_kind)
-- row per participant/input revision. This target relation is only the
-- receipt representation; this migration imports no source rows and creates
-- no synthetic receipt. Until a reviewed source transfer supplies the exact
-- D1 tuple, eligible social v0.2 evidence keeps bootstrap pending.

CREATE TABLE storage_legacy_event_sources (
  event_digest text PRIMARY KEY CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  input_revision bigint NOT NULL CHECK (input_revision >= 0),
  change_kind text NOT NULL CHECK (change_kind IN ('owner-active', 'source-updated')),
  UNIQUE (participant_id, input_revision)
);
CREATE INDEX storage_legacy_events_owner
  ON storage_legacy_event_sources(owner_digest, event_digest);

-- D1 only creates these receipts from an owner link. Keep that identity
-- relation exact for source-imported rows while allowing historical withdrawn
-- or erased links to retain their source evidence.
CREATE FUNCTION storage_legacy_event_source_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = NEW.participant_id
     AND owner_link.owner_digest = NEW.owner_digest
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_legacy_event_source_membership_guard
  BEFORE INSERT ON storage_legacy_event_sources
  FOR EACH ROW EXECUTE FUNCTION storage_legacy_event_source_membership_guard();

-- Match D1's immutable receipt and owner-erasure-only deletion contract.
CREATE FUNCTION storage_legacy_event_source_retention_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'storage_legacy_event_immutable' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_owner_revisions revision
   WHERE revision.owner_digest = OLD.owner_digest
     AND revision.state = 'erased'
     AND revision.source_id = (
       SELECT source.source_id FROM storage_source_state source WHERE source.singleton = 1
     )
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storage_legacy_terminal_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER storage_legacy_event_source_retention_guard
  BEFORE UPDATE OR DELETE ON storage_legacy_event_sources
  FOR EACH ROW EXECUTE FUNCTION storage_legacy_event_source_retention_guard();

CREATE FUNCTION storage_legacy_event_source_truncate_refused()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'storage_legacy_event_immutable' USING ERRCODE = 'P1005';
  RETURN NULL;
END;
$$;
CREATE TRIGGER storage_legacy_event_source_truncate_refused
  BEFORE TRUNCATE ON storage_legacy_event_sources
  FOR EACH STATEMENT EXECUTE FUNCTION storage_legacy_event_source_truncate_refused();

-- Preserve 0053's bounded v1/v1.1/v1.2 discovery and add the missing D1
-- legacy-family rule. A matching receipt must name the current input revision,
-- exact participant/owner link, exact version-1 journal event from the active
-- source, and an active owner-revision head at or beyond that event in the
-- same monotonic owner chain. The head may be newer because later events do
-- not make an earlier exact event unapplied. A missing input-version row is
-- also pending: D1's bootstrap requests a revision and receipt for that case.
CREATE OR REPLACE FUNCTION community_public_source_bootstrap_pending()
RETURNS bigint
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT
    (SELECT count(*) FROM (
       SELECT 1 FROM telemetry_v1_chunks chunk
        WHERE chunk.superseded_at IS NULL AND chunk.accepted_record_count > 0
          AND EXISTS (SELECT 1 FROM community_public_source_owners eligible
                       WHERE eligible.participant_id = chunk.participant_id)
          AND NOT EXISTS (SELECT 1 FROM telemetry_v11_domain_heads head
                           WHERE head.participant_id = chunk.participant_id)
          AND NOT EXISTS (SELECT 1 FROM typed_v1_event_sources source
                           WHERE source.chunk_id = chunk.id)
        LIMIT 10000) v1)
  + (SELECT count(*) FROM (
       SELECT 1 FROM telemetry_v11_domain_heads head
        WHERE EXISTS (SELECT 1 FROM community_public_source_owners eligible
                       WHERE eligible.participant_id = head.participant_id)
          AND NOT EXISTS (SELECT 1 FROM storage_v11_event_sources source
                           WHERE source.participant_id = head.participant_id
                             AND source.generation_id = head.generation_id)
        LIMIT 10000) v11)
  + (SELECT count(*) FROM (
       SELECT 1 FROM telemetry_v12_domain_heads head
         JOIN telemetry_v12_domains domain
           ON domain.id = head.generation_id AND domain.participant_id = head.participant_id
        WHERE EXISTS (SELECT 1 FROM community_public_source_owners eligible
                       WHERE eligible.participant_id = head.participant_id
                         AND (eligible.device_id IS NULL OR eligible.device_id = domain.device_id))
          AND NOT EXISTS (SELECT 1 FROM storage_v12_event_sources source
                           WHERE source.participant_id = head.participant_id
                             AND source.generation_id = head.generation_id
                             AND source.head_revision = head.revision)
        LIMIT 10000) v12)
  + (SELECT count(*) FROM (
       SELECT 1 FROM community_public_source_owners eligible
        WHERE eligible.owner_kind = 'social' AND eligible.device_id IS NULL
          AND EXISTS (SELECT 1 FROM telemetry_contributions contribution
                       WHERE contribution.participant_id = eligible.participant_id
                         AND contribution.status = 'accepted'
                         AND contribution.transport_schema_version = 'telemetry-contribution-v0.2')
          AND NOT EXISTS (
            SELECT 1
              FROM community_analytical_input_versions current_input
              JOIN storage_legacy_event_sources source
                ON source.participant_id = current_input.participant_id
               AND source.input_revision = current_input.revision
              JOIN storage_v11_owner_links owner_link
                ON owner_link.participant_id = source.participant_id
               AND owner_link.owner_digest = source.owner_digest
               AND owner_link.state = 'active'
              JOIN storage_source_state current_source
                ON current_source.singleton = 1
              JOIN storage_ingestion_changes change
                ON change.source_id = current_source.source_id
               AND change.event_digest = source.event_digest
               AND change.owner_digest = source.owner_digest
               AND change.kind = source.change_kind
               AND change.event_tuple_version = 1
               AND change.object_digest = source.event_digest
               AND change.content_digest = source.event_digest
              JOIN storage_owner_revisions applied_head
                ON applied_head.source_id = change.source_id
               AND applied_head.owner_digest = change.owner_digest
               AND applied_head.revision >= change.revision
               AND applied_head.authority_epoch >= change.authority_epoch
               AND applied_head.last_sequence >= change.sequence
               AND applied_head.state = 'active'
             WHERE current_input.participant_id = eligible.participant_id
          )
        LIMIT 10000) legacy)
$$;

-- 0053 may already have marked the singleton complete because it did not
-- count this family. Repair only that unsafe completed state; do not invent
-- source receipts or alter cursors/policy metadata.
UPDATE community_public_source_bootstrap bootstrap
   SET completed = 0
 WHERE bootstrap.singleton = 1
   AND bootstrap.policy_version = 'community-public-sources-v1'
   AND bootstrap.completed = 1
   AND community_public_source_bootstrap_pending() > 0;
