-- Explicit PostgreSQL membership for the retained v1 and v1.1 source families.
--
-- D1 stores v1 chunk publication in typed_v1_event_sources and v1.1 domain
-- publication in storage_v11_event_sources. PostgreSQL keeps the legacy
-- telemetry rows directly, so these receipts point at the existing raw chunk
-- and domain rows. storage_v11_owner_links remains the single participant to
-- owner-digest mapping; domain_days remains the manifest membership map.
--
-- The participant-delete transition records terminal proof before FK
-- cascades. A preexisting `erased` owner link is not proof: earlier PostgreSQL
-- state could be changed without an immutable receipt. Such rows remain
-- fail-closed until separately reconciled. This migration does not backfill
-- source memberships, activate a reader, or establish source-data parity.

-- PostgreSQL cannot distinguish a preexisting `erased` state from historical
-- direct state mutation. Require a separately reviewed reconciliation before
-- this receipt contract is installed; never promote old state to proof.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage_v11_owner_links WHERE state = 'erased'
  ) THEN
    RAISE EXCEPTION 'telemetry_owner_erasure_reconciliation_required'
      USING ERRCODE = 'P1005';
  END IF;
END;
$$;

ALTER TABLE telemetry_v11_domains
  ADD CONSTRAINT telemetry_v11_domains_membership_identity
  UNIQUE (id, participant_id, device_id, manifest_digest, from_day, through_day, input_revision);

CREATE TABLE typed_v1_event_sources (
  event_digest text PRIMARY KEY CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  chunk_id text NOT NULL UNIQUE REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
  source_namespace text NOT NULL CHECK (length(source_namespace) BETWEEN 1 AND 256)
);
CREATE INDEX typed_v1_events_owner
  ON typed_v1_event_sources(owner_digest, participant_id, chunk_id);
CREATE INDEX typed_v1_events_namespace_owner
  ON typed_v1_event_sources(source_namespace, owner_digest, participant_id, chunk_id);

CREATE FUNCTION telemetry_v1_event_source_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Keep the erasure lock order: participant, owner link, then source chunk.
  -- Participant deletion takes the participant row before its trigger records
  -- owner proof and its FK cascades reach source rows.
  PERFORM 1 FROM participants participant
   WHERE participant.id = NEW.participant_id AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = NEW.participant_id
     AND owner_link.owner_digest = NEW.owner_digest
     AND owner_link.state <> 'erased'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM telemetry_v1_chunks chunk
   WHERE chunk.id = NEW.chunk_id AND chunk.participant_id = NEW.participant_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM telemetry_v1_chunks chunk
      JOIN storage_v11_owner_links owner_link
        ON owner_link.participant_id = chunk.participant_id
       AND owner_link.owner_digest = NEW.owner_digest
       AND owner_link.state <> 'erased'
     WHERE chunk.id = NEW.chunk_id
       AND chunk.participant_id = NEW.participant_id
       AND chunk.accepted_record_count = chunk.record_count
       AND chunk.record_count = (
         SELECT count(*) FROM telemetry_v1_records record
          WHERE record.chunk_row_id = chunk.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_v1_records record
          WHERE record.chunk_row_id = chunk.id
            AND (record.participant_id <> chunk.participant_id
              OR record.device_id <> chunk.device_id
              OR record.stream <> chunk.stream
              OR record.observed_day <> chunk.chunk_day)
       )
  ) THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_v1_event_source_membership_guard
  BEFORE INSERT ON typed_v1_event_sources
  FOR EACH ROW EXECUTE FUNCTION telemetry_v1_event_source_membership_guard();

CREATE TABLE storage_v11_event_sources (
  event_digest text PRIMARY KEY CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  generation_id text NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  from_day date NOT NULL,
  through_day date NOT NULL CHECK (through_day >= from_day),
  head_revision bigint NOT NULL CHECK (head_revision > 0),
  input_revision bigint NOT NULL CHECK (input_revision >= 0),
  recorded_ms bigint NOT NULL CHECK (recorded_ms >= 0),
  FOREIGN KEY (generation_id, participant_id, device_id, manifest_digest, from_day, through_day, input_revision)
    REFERENCES telemetry_v11_domains(id, participant_id, device_id, manifest_digest, from_day, through_day, input_revision)
    ON DELETE CASCADE
);
CREATE INDEX storage_v11_event_owner
  ON storage_v11_event_sources(owner_digest, event_digest);
CREATE INDEX storage_v11_event_generation
  ON storage_v11_event_sources(generation_id, owner_digest);

-- The owner-link state is the live index; this receipt survives deletion of
-- that index row and is the durable proof used by source-retention guards.
CREATE TABLE storage_owner_erasure_receipts (
  owner_digest text PRIMARY KEY CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL
);

CREATE FUNCTION storage_owner_erasure_receipt_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'telemetry_owner_erasure_receipt_immutable' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage_v11_owner_links owner_link
     WHERE owner_link.owner_digest = NEW.owner_digest
       AND owner_link.state = 'erased'
  ) THEN
    RAISE EXCEPTION 'telemetry_owner_erasure_receipt_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_owner_erasure_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storage_owner_erasure_receipts
  FOR EACH ROW EXECUTE FUNCTION storage_owner_erasure_receipt_guard();

CREATE FUNCTION storage_v11_owner_erasure_receipt_create()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.state <> 'erased' AND NEW.state = 'erased' THEN
    INSERT INTO storage_owner_erasure_receipts (owner_digest, recorded_at)
    VALUES (NEW.owner_digest, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_v11_owner_erasure_receipt_create
  AFTER UPDATE OF state ON storage_v11_owner_links
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM 'erased' AND NEW.state = 'erased')
  EXECUTE FUNCTION storage_v11_owner_erasure_receipt_create();

CREATE FUNCTION storage_v11_event_source_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Match participant erasure's lock order: participant, owner link, then
  -- head. This keeps deletion from taking the owner while publication holds
  -- the head and waits on that same owner.
  PERFORM 1 FROM participants participant
   WHERE participant.id = NEW.participant_id AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = NEW.participant_id
     AND owner_link.owner_digest = NEW.owner_digest
     AND owner_link.state <> 'erased'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM telemetry_v11_domain_heads head
   WHERE head.participant_id = NEW.participant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage_v11_owner_links owner_link
     WHERE owner_link.participant_id = NEW.participant_id
       AND owner_link.owner_digest = NEW.owner_digest
       AND owner_link.state <> 'erased'
  ) OR NOT EXISTS (
    WITH RECURSIVE published(generation_id, head_revision) AS (
      SELECT head.generation_id, head.revision::bigint
        FROM telemetry_v11_domain_heads head
       WHERE head.participant_id = NEW.participant_id
      UNION ALL
      SELECT prior.id, published.head_revision - 1
        FROM published
        JOIN telemetry_v11_domains current_generation
          ON current_generation.id = published.generation_id
        JOIN telemetry_v11_domains prior
          ON prior.id = current_generation.previous_generation_id
         AND prior.participant_id = current_generation.participant_id
       WHERE published.head_revision > 1
    )
    SELECT 1 FROM published
     WHERE generation_id = NEW.generation_id
       AND head_revision = NEW.head_revision
  ) THEN
    RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_v11_event_source_membership_guard
  BEFORE INSERT ON storage_v11_event_sources
  FOR EACH ROW EXECUTE FUNCTION storage_v11_event_source_membership_guard();

-- A durable erased owner link is the terminal deletion proof. Make that state
-- one-way and preserve it until membership rows have been released, matching
-- the D1 owner-revision and owner-link retention guards.
CREATE FUNCTION storage_v11_owner_link_terminal_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'erased' THEN
      RAISE EXCEPTION 'telemetry_owner_erasure_receipt_missing' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM participants participant
       WHERE participant.id = OLD.participant_id
    ) THEN
      RAISE EXCEPTION 'telemetry_owner_link_retained' USING ERRCODE = 'P1005';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM storage_owner_erasure_receipts receipt
       WHERE receipt.owner_digest = OLD.owner_digest
    ) THEN
      RAISE EXCEPTION 'telemetry_owner_not_erased' USING ERRCODE = 'P1005';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.participant_id IS DISTINCT FROM NEW.participant_id
     OR OLD.owner_digest IS DISTINCT FROM NEW.owner_digest
     OR (OLD.state = 'erased' AND NEW.state <> 'erased') THEN
    RAISE EXCEPTION 'telemetry_owner_identity_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_v11_owner_link_terminal_guard
  BEFORE INSERT OR UPDATE OR DELETE ON storage_v11_owner_links
  FOR EACH ROW EXECUTE FUNCTION storage_v11_owner_link_terminal_guard();

-- D1 makes participant deletion itself the terminal owner-erasure event. Keep
-- that transition before PostgreSQL's FK cascades remove the owner link and
-- source membership rows, so their guards observe durable proof in this same
-- transaction. Merely claiming deletion (participants.state='deleting') does
-- not invoke this transition.
CREATE FUNCTION telemetry_participant_owner_erasure_proof()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  UPDATE storage_v11_owner_links
     SET state = 'erased'
   WHERE participant_id = OLD.id AND state <> 'erased';
  RETURN OLD;
END;
$$;
CREATE TRIGGER telemetry_participant_owner_erasure_proof
  BEFORE DELETE ON participants
  FOR EACH ROW EXECUTE FUNCTION telemetry_participant_owner_erasure_proof();

-- Published memberships are append-only. A deleting participant alone is not
-- terminal erasure proof; concurrent erasure is serialized on the owner row.
CREATE FUNCTION telemetry_effective_membership_retention_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'telemetry_source_membership_immutable' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_owner_erasure_receipts
   WHERE owner_digest = OLD.owner_digest
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_source_membership_retained' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER typed_v1_event_source_retention_guard
  BEFORE UPDATE OR DELETE ON typed_v1_event_sources
  FOR EACH ROW EXECUTE FUNCTION telemetry_effective_membership_retention_guard();
CREATE TRIGGER storage_v11_event_source_retention_guard
  BEFORE UPDATE OR DELETE ON storage_v11_event_sources
  FOR EACH ROW EXECUTE FUNCTION telemetry_effective_membership_retention_guard();
