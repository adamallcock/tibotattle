-- PostgreSQL primary migration 0014: bounded cross-format source revision.
--
-- v1.2 domain predecessor/activation reads a participant input_versions row
-- instead of scanning every historical source row. Keep that fence current
-- for admitted/effective source changes. Staged manifests and chunks are
-- immutable candidates, so their arrival must not invalidate a predecessor
-- issued before the client uploads its vector.

-- Keep a bounded mutation-chain digest beside the cheap monotone revision.
-- Predecessor operations commit to this digest instead of scanning every
-- historical retained row or domain membership.
CREATE TABLE input_source_digests (
  participant_id text PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{32}$')
);

CREATE OR REPLACE FUNCTION telemetry_append_source_digest(owner_id text, event_key text)
RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Erasure enters `deleting` before its child cascade. Do not recreate source
  -- state while that authoritative cleanup is in flight.
  IF owner_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM participants WHERE id=owner_id AND state='active'
  ) THEN
    RETURN;
  END IF;
  INSERT INTO input_source_digests(participant_id,digest)
    VALUES(owner_id,md5(event_key))
    ON CONFLICT(participant_id) DO UPDATE
      SET digest=md5(input_source_digests.digest || ':' || event_key);
END;
$$;

-- Emit one scheduler event for an admitted owner.  The participant input
-- revision is part of the digest: two valid mutations of the same row must
-- enqueue two source-updated events, while a retry of the same trigger
-- execution remains conflict-safe.
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
  -- Lock the source authority before reading its sequence so every producer
  -- serializes with the analytics worker and other source mutations.
  SELECT state.source_id,state.authority_epoch
    INTO source_id_value,source_authority_epoch
    FROM storage_source_state state
   WHERE state.singleton=1
   FOR UPDATE;
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

CREATE OR REPLACE FUNCTION telemetry_legacy_source_revision()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_id text;
        old_owner_id text;
        event_key text;
        old_event_key text;
        input_revision_value bigint;
        old_input_revision_value bigint;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  event_key := TG_TABLE_NAME || ':' || TG_OP || ':' || owner_id || ':' || coalesce(
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)->>'generation_id' ELSE to_jsonb(NEW)->>'generation_id' END,
    CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)->>'id' ELSE to_jsonb(NEW)->>'id' END, '');
  IF owner_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM participants WHERE id = owner_id AND state='active'
  ) THEN
    PERFORM telemetry_append_source_digest(owner_id,event_key);
    INSERT INTO input_versions(participant_id, revision)
      VALUES (owner_id, 1)
      ON CONFLICT (participant_id)
      DO UPDATE SET revision = input_versions.revision + 1
      RETURNING revision INTO input_revision_value;
    PERFORM telemetry_emit_source_event(owner_id,event_key,input_revision_value);
  END IF;

  -- A participant reassignment changes both authoritative source sets.  Bump
  -- and publish an event for the old owner as well as the new owner.
  IF TG_OP = 'UPDATE'
     AND OLD.participant_id IS DISTINCT FROM NEW.participant_id
     AND OLD.participant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM participants WHERE id = OLD.participant_id AND state='active') THEN
    old_owner_id := OLD.participant_id;
    old_event_key := TG_TABLE_NAME || ':UPDATE:old:' || old_owner_id || ':' || coalesce(
      to_jsonb(OLD)->>'generation_id', to_jsonb(OLD)->>'id', '');
    PERFORM telemetry_append_source_digest(old_owner_id,old_event_key);
    INSERT INTO input_versions(participant_id, revision)
      VALUES (old_owner_id, 1)
      ON CONFLICT (participant_id)
      DO UPDATE SET revision = input_versions.revision + 1
      RETURNING revision INTO old_input_revision_value;
    PERFORM telemetry_emit_source_event(old_owner_id,old_event_key,old_input_revision_value);
  END IF;
  RETURN NULL;
END;
$$;

-- v1 chunks are admitted source as soon as their ingest transaction commits.
-- The established analytical trigger owns revision increments; this companion
-- records only the bounded identity chain.
CREATE OR REPLACE FUNCTION telemetry_v1_source_digest()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_id text;
        old_owner_id text;
        chunk_id text;
        event_key text;
        old_event_key text;
        input_revision_value bigint;
        old_input_revision_value bigint;
BEGIN
  owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  chunk_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  event_key := TG_TABLE_NAME || ':' || TG_OP || ':' || coalesce(chunk_id,'');
  IF owner_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM participants WHERE id=owner_id AND state='active'
  ) THEN
    PERFORM telemetry_append_source_digest(owner_id,event_key);
    SELECT revision INTO input_revision_value
      FROM input_versions WHERE participant_id=owner_id;
    PERFORM telemetry_emit_source_event(owner_id,event_key,input_revision_value);
  END IF;
  IF TG_OP='UPDATE' AND OLD.participant_id IS DISTINCT FROM NEW.participant_id
     AND OLD.participant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM participants WHERE id=OLD.participant_id AND state='active') THEN
    old_owner_id := OLD.participant_id;
    old_event_key := TG_TABLE_NAME || ':UPDATE:old:' || old_owner_id || ':' || coalesce(OLD.id,'');
    PERFORM telemetry_append_source_digest(old_owner_id,old_event_key);
    SELECT revision INTO old_input_revision_value
      FROM input_versions WHERE participant_id=old_owner_id;
    PERFORM telemetry_emit_source_event(old_owner_id,old_event_key,old_input_revision_value);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS telemetry_v1_source_digest ON telemetry_v1_chunks;
CREATE TRIGGER telemetry_v1_source_digest
AFTER INSERT OR UPDATE OR DELETE ON telemetry_v1_chunks
FOR EACH ROW EXECUTE FUNCTION telemetry_v1_source_digest();

-- Earlier development snapshots created staging triggers here. Remove them
-- when this forward fragment is applied; only domain publication is an
-- analytical source change for v1.1/v1.2.
DROP TRIGGER IF EXISTS telemetry_v11_manifest_source_revision ON telemetry_v11_day_manifests;
DROP TRIGGER IF EXISTS telemetry_v11_chunk_source_revision ON telemetry_v11_chunks;

DROP TRIGGER IF EXISTS telemetry_retained_source_revision ON telemetry_contributions;
CREATE TRIGGER telemetry_retained_source_revision
AFTER INSERT OR DELETE OR UPDATE OF participant_id,plaintext_digest,envelope_digest,r2_key,status,
  schema_version,transport_schema_version,dataset_id,dataset_part_index,dataset_part_count,
  dataset_completeness,dataset_range_start,dataset_range_end,range_start,range_end,
  client_platform,provider_policy_epoch,estimated_api_cost_usd,priced_event_coverage_percent,
  unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,
  accepted_record_count,upload_authorization_id,device_upload_authorization_id,created_at
ON telemetry_contributions
FOR EACH ROW EXECUTE FUNCTION telemetry_legacy_source_revision();

-- Retained records are admitted at insert time and are read directly by the
-- effective-source adapter.  Keep their content mutations on the same
-- revision/digest chain; operational contribution quarantine timestamp changes
-- intentionally do not use the contribution trigger above.
DROP TRIGGER IF EXISTS telemetry_retained_record_source_revision ON telemetry_records;
CREATE TRIGGER telemetry_retained_record_source_revision
AFTER INSERT OR UPDATE OR DELETE ON telemetry_records
FOR EACH ROW EXECUTE FUNCTION telemetry_legacy_source_revision();

-- 0011's chunk INSERT hook also treated staged data as an analytical source.
-- Remove it; domain heads below advance the same admitted-source revision on
-- activation or withdrawal.
DROP TRIGGER IF EXISTS telemetry_v12_source_revision_insert ON telemetry_v12_chunks;
DROP TRIGGER IF EXISTS telemetry_v12_manifest_source_revision ON telemetry_v12_day_manifests;
DROP TRIGGER IF EXISTS telemetry_v12_chunk_lifecycle_source_revision ON telemetry_v12_chunks;
DROP TRIGGER IF EXISTS telemetry_v12_domain_revision_publish ON telemetry_v12_domain_heads;

CREATE TRIGGER telemetry_v11_domain_head_source_revision
AFTER INSERT OR UPDATE OR DELETE ON telemetry_v11_domain_heads
FOR EACH ROW EXECUTE FUNCTION telemetry_legacy_source_revision();

CREATE TRIGGER telemetry_v12_domain_head_source_revision
AFTER INSERT OR UPDATE OR DELETE ON telemetry_v12_domain_heads
FOR EACH ROW EXECUTE FUNCTION telemetry_legacy_source_revision();

-- Once a domain generation is published, its manifest, chunks and records are
-- immutable while the owner is active. Staged candidates remain mutable until
-- publication, so normal upload completion still works. This prevents an
-- admitted historical row from changing without advancing the source fence.
CREATE OR REPLACE FUNCTION telemetry_published_source_row_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_id text;
        target_manifest_id text;
        old_owner_id text;
        old_manifest_id text;
        old_published boolean := false;
        published boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'telemetry_v11_day_manifests' THEN
    owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
    target_manifest_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP='UPDATE' THEN
      old_owner_id := OLD.participant_id;
      old_manifest_id := OLD.id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM telemetry_v11_domain_days d
      JOIN telemetry_v11_domains g ON g.id=d.generation_id
      JOIN participants p ON p.id=g.participant_id AND p.state='active'
      WHERE d.manifest_id=target_manifest_id AND g.participant_id=owner_id
    ) INTO published;
  ELSIF TG_TABLE_NAME = 'telemetry_v11_chunks' THEN
    owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
    target_manifest_id := CASE WHEN TG_OP='DELETE' THEN OLD.manifest_id ELSE NEW.manifest_id END;
    IF TG_OP='UPDATE' THEN
      old_owner_id := OLD.participant_id;
      old_manifest_id := OLD.manifest_id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM telemetry_v11_domain_days d
      JOIN telemetry_v11_domains g ON g.id=d.generation_id
      JOIN participants p ON p.id=g.participant_id AND p.state='active'
      WHERE d.manifest_id=target_manifest_id AND g.participant_id=owner_id
    ) INTO published;
  ELSIF TG_TABLE_NAME = 'telemetry_v11_records' THEN
    IF TG_OP='DELETE' THEN
      SELECT m.participant_id,r.manifest_id INTO owner_id,target_manifest_id
        FROM telemetry_v11_records r JOIN telemetry_v11_day_manifests m ON m.id=r.manifest_id
       WHERE r.chunk_id=OLD.chunk_id AND r.occurrence_id=OLD.occurrence_id;
    ELSE
      SELECT m.participant_id,NEW.manifest_id INTO owner_id,target_manifest_id
        FROM telemetry_v11_day_manifests m WHERE m.id=NEW.manifest_id;
    END IF;
    IF TG_OP='UPDATE' THEN
      SELECT m.participant_id,r.manifest_id INTO old_owner_id,old_manifest_id
        FROM telemetry_v11_records r JOIN telemetry_v11_day_manifests m ON m.id=r.manifest_id
       WHERE r.chunk_id=OLD.chunk_id AND r.occurrence_id=OLD.occurrence_id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM telemetry_v11_domain_days d
      JOIN telemetry_v11_domains g ON g.id=d.generation_id
      JOIN participants p ON p.id=g.participant_id AND p.state='active'
      WHERE d.manifest_id=target_manifest_id AND g.participant_id=owner_id
    ) INTO published;
  ELSIF TG_TABLE_NAME = 'telemetry_v12_day_manifests' THEN
    owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
    target_manifest_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
    IF TG_OP='UPDATE' THEN
      old_owner_id := OLD.participant_id;
      old_manifest_id := OLD.id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM telemetry_v12_domain_days d
      JOIN telemetry_v12_domains g ON g.id=d.generation_id
      JOIN participants p ON p.id=g.participant_id AND p.state='active'
      WHERE d.manifest_id=target_manifest_id AND g.participant_id=owner_id
    ) INTO published;
  ELSIF TG_TABLE_NAME = 'telemetry_v12_chunks' THEN
    owner_id := CASE WHEN TG_OP='DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
    target_manifest_id := CASE WHEN TG_OP='DELETE' THEN OLD.manifest_id ELSE NEW.manifest_id END;
    IF TG_OP='UPDATE' THEN
      old_owner_id := OLD.participant_id;
      old_manifest_id := OLD.manifest_id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM telemetry_v12_domain_days d
      JOIN telemetry_v12_domains g ON g.id=d.generation_id
      JOIN participants p ON p.id=g.participant_id AND p.state='active'
      WHERE d.manifest_id=target_manifest_id AND g.participant_id=owner_id
    ) INTO published;
  ELSIF TG_TABLE_NAME = 'telemetry_v12_records' THEN
    IF TG_OP='DELETE' THEN
      SELECT m.participant_id,r.manifest_id INTO owner_id,target_manifest_id
        FROM telemetry_v12_records r JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id
       WHERE r.chunk_id=OLD.chunk_id AND r.occurrence_id=OLD.occurrence_id;
    ELSE
      SELECT m.participant_id,NEW.manifest_id INTO owner_id,target_manifest_id
        FROM telemetry_v12_day_manifests m WHERE m.id=NEW.manifest_id;
    END IF;
    IF TG_OP='UPDATE' THEN
      SELECT m.participant_id,r.manifest_id INTO old_owner_id,old_manifest_id
        FROM telemetry_v12_records r JOIN telemetry_v12_day_manifests m ON m.id=r.manifest_id
       WHERE r.chunk_id=OLD.chunk_id AND r.occurrence_id=OLD.occurrence_id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM telemetry_v12_domain_days d
      JOIN telemetry_v12_domains g ON g.id=d.generation_id
      JOIN participants p ON p.id=g.participant_id AND p.state='active'
      WHERE d.manifest_id=target_manifest_id AND g.participant_id=owner_id
    ) INTO published;
  END IF;
  IF TG_OP='UPDATE' AND old_owner_id IS NOT NULL THEN
    IF TG_TABLE_NAME LIKE 'telemetry_v11_%' THEN
      SELECT EXISTS(
        SELECT 1 FROM telemetry_v11_domain_days d
        JOIN telemetry_v11_domains g ON g.id=d.generation_id
        JOIN participants p ON p.id=g.participant_id AND p.state='active'
        WHERE d.manifest_id=old_manifest_id AND g.participant_id=old_owner_id
      ) INTO old_published;
    ELSE
      SELECT EXISTS(
        SELECT 1 FROM telemetry_v12_domain_days d
        JOIN telemetry_v12_domains g ON g.id=d.generation_id
        JOIN participants p ON p.id=g.participant_id AND p.state='active'
        WHERE d.manifest_id=old_manifest_id AND g.participant_id=old_owner_id
      ) INTO old_published;
    END IF;
  END IF;
  IF published OR old_published THEN
    RAISE EXCEPTION 'telemetry_source_immutable' USING ERRCODE='P1005';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS telemetry_v11_manifest_immutable_guard ON telemetry_v11_day_manifests;
CREATE TRIGGER telemetry_v11_manifest_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_day_manifests
FOR EACH ROW EXECUTE FUNCTION telemetry_published_source_row_immutable();
DROP TRIGGER IF EXISTS telemetry_v11_chunk_immutable_guard ON telemetry_v11_chunks;
CREATE TRIGGER telemetry_v11_chunk_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_chunks
FOR EACH ROW EXECUTE FUNCTION telemetry_published_source_row_immutable();
DROP TRIGGER IF EXISTS telemetry_v11_record_immutable_guard ON telemetry_v11_records;
CREATE TRIGGER telemetry_v11_record_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_records
FOR EACH ROW EXECUTE FUNCTION telemetry_published_source_row_immutable();
DROP TRIGGER IF EXISTS telemetry_v12_manifest_immutable_guard ON telemetry_v12_day_manifests;
CREATE TRIGGER telemetry_v12_manifest_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_day_manifests
FOR EACH ROW EXECUTE FUNCTION telemetry_published_source_row_immutable();
DROP TRIGGER IF EXISTS telemetry_v12_chunk_immutable_guard ON telemetry_v12_chunks;
CREATE TRIGGER telemetry_v12_chunk_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_chunks
FOR EACH ROW EXECUTE FUNCTION telemetry_published_source_row_immutable();
DROP TRIGGER IF EXISTS telemetry_v12_record_immutable_guard ON telemetry_v12_records;
CREATE TRIGGER telemetry_v12_record_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_records
FOR EACH ROW EXECUTE FUNCTION telemetry_published_source_row_immutable();

-- A published generation remains part of the admitted cross-format source
-- history even after a successor head is selected. Prevent direct edits or
-- deletion while the owner is active; owner erasure first moves the
-- participant to deleting, so its cascading cleanup remains possible.
CREATE OR REPLACE FUNCTION telemetry_v11_domain_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_state text;
        owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  SELECT state INTO owner_state FROM participants WHERE id=owner_id;
  IF owner_state = 'active' THEN
    RAISE EXCEPTION 'telemetry_domain_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry_v12_domain_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_state text;
        owner_id text;
BEGIN
  owner_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.participant_id ELSE NEW.participant_id END;
  SELECT state INTO owner_state FROM participants WHERE id=owner_id;
  IF owner_state = 'active' THEN
    RAISE EXCEPTION 'telemetry_domain_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER telemetry_v11_domain_immutable_guard
BEFORE UPDATE OR DELETE ON telemetry_v11_domains
FOR EACH ROW EXECUTE FUNCTION telemetry_v11_domain_immutable();

CREATE TRIGGER telemetry_v12_domain_immutable_guard
BEFORE UPDATE OR DELETE ON telemetry_v12_domains
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_domain_immutable();

CREATE OR REPLACE FUNCTION telemetry_v11_domain_day_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_state text;
        target_generation_id text;
BEGIN
  target_generation_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.generation_id ELSE NEW.generation_id END;
  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM telemetry_v11_domain_heads h WHERE h.generation_id=target_generation_id
  ) THEN
    -- Activation inserts its new generation before publishing the head.  An
    -- admitted older generation, however, has a successor that points back
    -- to it and must remain immutable even after the head moves on.
    IF NOT EXISTS (
      SELECT 1 FROM telemetry_v11_domains d
      JOIN participants p ON p.id=d.participant_id
      WHERE d.id=target_generation_id AND p.state='active'
    ) OR NOT EXISTS (
      SELECT 1 FROM telemetry_v11_domains successor
      WHERE successor.previous_generation_id=target_generation_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT p.state INTO owner_state
    FROM telemetry_v11_domains d JOIN participants p ON p.id=d.participant_id
   WHERE d.id=target_generation_id;
  IF owner_state = 'active' THEN
    RAISE EXCEPTION 'telemetry_domain_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION telemetry_v12_domain_day_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_state text;
        target_generation_id text;
BEGIN
  target_generation_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.generation_id ELSE NEW.generation_id END;
  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM telemetry_v12_domain_heads h WHERE h.generation_id=target_generation_id
  ) THEN
    -- Activation inserts its new generation before publishing the head.  An
    -- admitted older generation, however, has a successor that points back
    -- to it and must remain immutable even after the head moves on.
    IF NOT EXISTS (
      SELECT 1 FROM telemetry_v12_domains d
      JOIN participants p ON p.id=d.participant_id
      WHERE d.id=target_generation_id AND p.state='active'
    ) OR NOT EXISTS (
      SELECT 1 FROM telemetry_v12_domains successor
      WHERE successor.previous_generation_id=target_generation_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT p.state INTO owner_state
    FROM telemetry_v12_domains d JOIN participants p ON p.id=d.participant_id
   WHERE d.id=target_generation_id;
  IF owner_state = 'active' THEN
    RAISE EXCEPTION 'telemetry_domain_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER telemetry_v11_domain_day_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v11_domain_days
FOR EACH ROW EXECUTE FUNCTION telemetry_v11_domain_day_immutable();

CREATE TRIGGER telemetry_v12_domain_day_immutable_guard
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_v12_domain_days
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_domain_day_immutable();

-- A correction receipt is part of the primary ingest transaction.  It is
-- keyed by the replacement chunk so an acknowledgement lost after commit
-- can be replayed without consuming a second upload authorization.  Keep the
-- bounded JSON outcome fields provider-neutral; the operation preparer owns
-- their closed shape and this table only enforces the storage ceiling.
CREATE TABLE telemetry_correction_receipts (
  replacement_chunk_id text PRIMARY KEY
    REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  predecessor_chunk_id text NOT NULL,
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  accepted_records integer NOT NULL CHECK (accepted_records BETWEEN 0 AND 200),
  outcomes_json text NOT NULL CHECK (length(outcomes_json) BETWEEN 2 AND 1250000),
  observed_days_json text NOT NULL CHECK (length(observed_days_json) BETWEEN 2 AND 1250000),
  occurrence_ids_json text NOT NULL CHECK (length(occurrence_ids_json) BETWEEN 2 AND 1250000),
  created_at timestamptz NOT NULL
);

CREATE INDEX telemetry_correction_receipts_participant
  ON telemetry_correction_receipts(participant_id, created_at, replacement_chunk_id);

-- Native additive corrections are separate from v1 replacement chunks.  They
-- retain facts and provenance for participants whose format floor is v1.1 or
-- v1.2, so a correction cannot bypass consent by inserting a rank-1 chunk.
CREATE TABLE telemetry_additive_correction_receipts (
  operation_id text PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('usage','quota','session')),
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  accepted_outcomes integer NOT NULL CHECK (accepted_outcomes BETWEEN 1 AND 800),
  observed_days_json text NOT NULL CHECK (length(observed_days_json) BETWEEN 2 AND 1250000),
  occurrence_ids_json text NOT NULL CHECK (length(occurrence_ids_json) BETWEEN 2 AND 1250000),
  outcomes_json text NOT NULL CHECK (length(outcomes_json) BETWEEN 2 AND 1250000),
  created_at timestamptz NOT NULL
);
CREATE INDEX telemetry_additive_correction_receipts_participant
  ON telemetry_additive_correction_receipts(participant_id, created_at, operation_id);

CREATE TABLE telemetry_additive_correction_facts (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('usage','quota','session')),
  occurrence_id text NOT NULL CHECK (length(occurrence_id) BETWEEN 8 AND 128),
  field text NOT NULL CHECK (field IN ('totalInputContextTokens','outputCombinedTokens','usedPercent',
    'resetsAt','sessionUuid','record')),
  status text NOT NULL CHECK (status IN ('known','unknown','later-null','conflict')),
  value_json text CHECK (value_json IS NULL OR length(value_json) BETWEEN 1 AND 100000),
  source_formats_json text NOT NULL CHECK (length(source_formats_json) BETWEEN 2 AND 10000),
  source_record_digests_json text NOT NULL CHECK (length(source_record_digests_json) BETWEEN 2 AND 1250000),
  source_snapshot_digest text NOT NULL CHECK (source_snapshot_digest ~ '^[0-9a-f]{64}$'),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  observed_day date NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (participant_id, device_id, stream, occurrence_id, field)
);
CREATE INDEX telemetry_additive_correction_facts_occurrence
  ON telemetry_additive_correction_facts(participant_id, stream, occurrence_id, observed_day);
