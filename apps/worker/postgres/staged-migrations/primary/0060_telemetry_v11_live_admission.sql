-- PostgreSQL primary migration 0060 (staged, number assigned by the
-- integration lead at landing): live v1.1 admission on the retained typed
-- v1/v1.1 family (GCP fast path, IN-2).
--
-- Migrations 0005, 0030 and 0033 give PostgreSQL the v1.1 transport headers
-- and the typed v1.1 family in import shape only: every row arrives from a
-- completed D1 transfer, already ready and already proven. Live admission
-- (src/postgres-telemetry-v11-live-admission.ts) instead writes a staged
-- manifest, then one chunk at a time, then flips the manifest to ready, which
-- is the order D1's typed-v1.1 admission uses (typed-v11-admission 0001,
-- 0004, 0006). This file adapts the import-shaped guards to that order and
-- ports the D1 live guards the import never needed. 0014's published-row
-- guard (telemetry_published_source_row_immutable) already serves the v1.1
-- header tables and is unchanged:
--
--   (1) typed_v11_record_admissions, D1 0006's view over the compact proofs,
--       so admission and activation read the same relation D1 reads.
--   (2) The staged-to-ready flip is admitted only when the manifest is
--       complete through typed proofs (D1 typed-v11 0001
--       telemetry_v11_manifest_ready).
--   (3) 0033's proof guard required a ready manifest: an import proves rows
--       of complete days only. A live chunk is proven while its manifest is
--       still staged, so the guard also admits a staged manifest whose chunk
--       is not yet fully proven (D1 0006 typed_v11_record_membership: state
--       'staged' and fewer proofs than the chunk declares). 0033 also
--       required base_digest = the typed canonical digest, which no attributed
--       usage or quota proof D1 writes can satisfy (see the predicate); that
--       equality now binds session rows only. Every other lineage predicate
--       is unchanged. OWNER/LEAD REVIEW: this corrects an import guard too.
--   (4) The admission state allocator only moves forward by exactly one
--       committed allocation, and the runtime contract only qualifies 0 -> 1
--       (D1 typed-v11 0001 typed_v11_state_immutable, 0004
--       typed_v11_runtime_contract_qualify, without the D1-only migration
--       inventory).
--   (5) Once the typed runtime contract is qualified, a raw JSON v1.1 record
--       is refused (D1 typed-v11 0001 typed_v11_legacy_record_refusal).
--
--   (6) The v1.1 owner bridge (D1 ingestion-bridge 0001 with the
--       ingestion-isolation 0002 event classification): an eligible accepted
--       head change records a storage_v11_event_sources receipt and one exact
--       journal row, 'source-updated' (no epoch change) for a classified
--       append-only successor and 'owner-active' otherwise.
--   (7) The bridge's pending read (storage_v11_bridge_pending_count) and
--       bounded maintenance backfill (storage_v11_bridge_backfill), as 0055
--       has for v1.2, without a one-time backfill (imported heads carry D1's
--       receipts).
--   (8) D1 ingestion-isolation 0002 storage_v11_append_transitions and its
--       BEFORE UPDATE head classification, which (6) reads.
--
-- Not here (documented gaps, IN-2 continuation): D1's
-- community_snapshot_mutation_control / community_daily_aggregate_rebuilds
-- head side effects, and the chunk admission window counter
-- (telemetry_v1_chunk_admission_windows), which the admission module
-- enforces in its transaction instead.
--
-- Every RAISE carries a constant message and ERRCODE; no value is
-- interpolated. Nothing here deletes, rewrites or backfills a row.

-- (1) D1 typed-v11 0006 typed_v11_record_admissions.
CREATE VIEW typed_v11_record_admissions AS
SELECT proof.typed_record_id,
       allocation.chunk_id,
       membership.manifest_id,
       CASE proof.stream_code WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END AS stream,
       typed_legacy_admission_decode_id(proof.occurrence_blob) AS occurrence_id,
       proof.base_digest,
       typed_legacy_admission_decode_id(proof.legacy_occurrence_blob) AS legacy_occurrence_id,
       proof.legacy_digest,
       proof.observed_at_ms
  FROM typed_v11_record_proofs proof
  JOIN typed_telemetry_chunks typed_chunk ON typed_chunk.id = proof.chunk_key
  JOIN typed_v11_chunk_allocations allocation
    ON allocation.namespace_id = typed_chunk.namespace_id
   AND allocation.chunk_original = typed_chunk.original_id
  JOIN typed_v11_manifest_memberships membership
    ON membership.typed_manifest_id = proof.manifest_key;

-- (2) D1 typed-v11 0001 telemetry_v11_manifest_ready.
CREATE FUNCTION telemetry_v11_manifest_ready_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF OLD.state <> 'staged' OR NEW.state <> 'ready'
       OR NEW.expected_chunk_count <> (
         SELECT count(*) FROM telemetry_v11_chunks chunk WHERE chunk.manifest_id = NEW.id)
       OR EXISTS (
         SELECT 1 FROM telemetry_v11_chunks chunk
          WHERE chunk.manifest_id = NEW.id
            AND chunk.record_count <> (
              SELECT count(*) FROM typed_v11_record_admissions admission
               WHERE admission.chunk_id = chunk.id))
    THEN
      RAISE EXCEPTION 'telemetry_manifest_incomplete' USING ERRCODE = 'P1005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_v11_manifest_ready_guard
  BEFORE UPDATE OF state ON telemetry_v11_day_manifests
  FOR EACH ROW EXECUTE FUNCTION telemetry_v11_manifest_ready_guard();

-- (3) 0033's proof guard, admitting a live staged manifest. Only the
-- manifest-state predicate changes; every lineage predicate is 0033's.
CREATE OR REPLACE FUNCTION typed_legacy_v11_record_proof_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM typed_telemetry_records record
    JOIN typed_v11_chunk_allocations allocation
      ON allocation.namespace_id = record.namespace_id
    JOIN typed_telemetry_chunks chunk
      ON chunk.id = record.chunk_id AND chunk.original_id = allocation.chunk_original
     AND chunk.namespace_id = record.namespace_id AND chunk.format = 11
    JOIN typed_telemetry_manifests manifest
      ON manifest.id = record.manifest_id AND manifest.namespace_id = record.namespace_id
    JOIN typed_v11_manifest_memberships member
      ON member.typed_manifest_id = manifest.id
    JOIN telemetry_v11_chunks source_chunk
      ON source_chunk.id = allocation.chunk_id AND source_chunk.manifest_id = member.manifest_id
    JOIN telemetry_v11_day_manifests source_manifest ON source_manifest.id = source_chunk.manifest_id
    JOIN typed_v11_admission_state admission
      ON admission.namespace_id = allocation.namespace_id
    JOIN typed_telemetry_owner_memberships owner_membership
      ON owner_membership.namespace_id = record.namespace_id AND owner_membership.source_format = 11
     AND owner_membership.owner_id = record.owner_id AND owner_membership.source_namespace = admission.source_namespace
    JOIN typed_telemetry_devices device
      ON device.id = record.device_id AND device.namespace_id = record.namespace_id
     AND device.owner_id = record.owner_id
    WHERE record.id = NEW.typed_record_id AND record.format = 11
      AND record.chunk_id = NEW.chunk_key AND record.manifest_id = NEW.manifest_key
      AND record.stream = NEW.stream_code AND record.occurrence_id = NEW.occurrence_blob
      -- D1's base digest is the record WITHOUT accountPlanAttribution
      -- (typed-v11-admission.ts), while the typed canonical digest keeps it.
      -- They agree only for session rows, which carry no attribution; for an
      -- attributed usage or quota row 0033's equality refused every
      -- production-shaped proof (Q-1 dump: a quota row's canonical and base
      -- digests differ). Bind the session digest exactly; usage and quota
      -- base digests stay bound to the occurrence, time and lineage below.
      AND (record.stream IN (1, 2) OR record.canonical_digest = NEW.base_digest)
      AND record.observed_at_ms = NEW.observed_at_ms
      AND admission.runtime_contract_version = 1
      AND source_chunk.record_count = allocation.record_count
      AND source_chunk.chunk_day = source_manifest.chunk_day
      AND (
        -- Import: a complete, ready day.
        (source_manifest.state = 'ready'
          AND source_manifest.expected_chunk_count = (
            SELECT count(*) FROM telemetry_v11_chunks manifest_chunk
             WHERE manifest_chunk.manifest_id = source_manifest.id))
        OR
        -- Live admission (D1 typed-v11 0006): a staged day whose chunk still
        -- has fewer proofs than it declares.
        (source_manifest.state = 'staged'
          AND (SELECT count(*) FROM typed_v11_record_proofs existing
                WHERE existing.chunk_key = NEW.chunk_key) < source_chunk.record_count)
      )
      AND typed_legacy_admission_decode_id(chunk.original_id) = source_chunk.id
      AND source_chunk.participant_id = owner_membership.participant_id
      AND source_manifest.participant_id = owner_membership.participant_id
      AND source_manifest.device_id = source_chunk.device_id
      AND manifest.chunk_day = (source_manifest.chunk_day - DATE '1970-01-01')
      AND typed_legacy_admission_decode_id(manifest.original_id) = source_manifest.id
      AND typed_legacy_admission_decode_id(device.original_id) = source_chunk.device_id
      AND NOT EXISTS (
        SELECT 1 FROM telemetry_v11_records raw_record
         WHERE raw_record.chunk_id = source_chunk.id
      )
      AND (NEW.legacy_occurrence_blob IS NULL
        OR (NEW.stream_code IN (1, 3) AND NEW.legacy_occurrence_blob = NEW.occurrence_blob)
        OR (NEW.stream_code = 2 AND typed_legacy_admission_decode_id(NEW.legacy_occurrence_blob) LIKE 'q:%'))
      AND record.source_row_id >= allocation.first_source_row_id
      AND record.source_row_id < allocation.first_source_row_id + allocation.record_count
      AND source_chunk.stream = CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
  ) THEN
    RAISE EXCEPTION 'typed_legacy_admission_parent_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;

-- (4) D1 typed-v11 0001 typed_v11_state_immutable and 0004
-- typed_v11_runtime_contract_qualify (without D1's migration inventory).
CREATE FUNCTION typed_v11_admission_state_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_namespace IS DISTINCT FROM OLD.source_namespace
     OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id THEN
    RAISE EXCEPTION 'typed_v11_namespace_or_allocator_conflict' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.next_source_row_id IS DISTINCT FROM OLD.next_source_row_id
     AND (NEW.next_source_row_id <= OLD.next_source_row_id OR NOT EXISTS (
       SELECT 1 FROM typed_v11_chunk_allocations allocation
        WHERE allocation.namespace_id = OLD.namespace_id
          AND allocation.first_source_row_id = OLD.next_source_row_id
          AND allocation.first_source_row_id + allocation.record_count = NEW.next_source_row_id)) THEN
    RAISE EXCEPTION 'typed_v11_allocator_race' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.runtime_contract_version IS DISTINCT FROM OLD.runtime_contract_version
     AND (OLD.runtime_contract_version <> 0 OR NEW.runtime_contract_version <> 1) THEN
    RAISE EXCEPTION 'typed_v11_runtime_contract_unqualified' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_v11_admission_state_guard
  BEFORE UPDATE ON typed_v11_admission_state
  FOR EACH ROW EXECUTE FUNCTION typed_v11_admission_state_guard();

-- (5) D1 typed-v11 0001 typed_v11_legacy_record_refusal, once qualified.
CREATE FUNCTION telemetry_v11_typed_json_refusal()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM typed_v11_admission_state admission
     WHERE admission.id = 1 AND admission.runtime_contract_version = 1
  ) THEN
    RAISE EXCEPTION 'typed_v11_json_write_disabled' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_v11_typed_json_refusal
  BEFORE INSERT ON telemetry_v11_records
  FOR EACH ROW EXECUTE FUNCTION telemetry_v11_typed_json_refusal();

-- (8) first, because (6) reads it. D1 ingestion-isolation 0002: every head
-- UPDATE records whether the successor only appends to the generation the
-- head named before. A successor is an append when the owner's link and
-- journal head were active at that generation and revision, the typed
-- runtime is qualified, the successor names that generation as its
-- predecessor for the same participant and device, every previous day is
-- still present with a ready manifest of the same participant, device, day,
-- parser, consent and exclusions, and every usage or quota row of a
-- replaced chunk (at most 200 rows compared) reappears in the successor's
-- day with the same full typed canonical digest. Session chunks and reused
-- chunks need no row scan. The row is immutable and lives as long as its
-- generation.
CREATE TABLE storage_v11_append_transitions (
  generation_id text PRIMARY KEY REFERENCES telemetry_v11_domains(id) ON DELETE CASCADE,
  previous_generation_id text NOT NULL,
  participant_id text NOT NULL,
  head_revision bigint NOT NULL CHECK (head_revision > 1),
  is_append smallint NOT NULL CHECK (is_append IN (0, 1)),
  compared_records integer NOT NULL CHECK (compared_records BETWEEN 0 AND 201)
);

CREATE FUNCTION storage_v11_append_transition_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'storage_v11_transition_immutable' USING ERRCODE = 'P1005';
  END IF;
  IF EXISTS (SELECT 1 FROM telemetry_v11_domains domain WHERE domain.id = OLD.generation_id) THEN
    RAISE EXCEPTION 'storage_v11_transition_retained' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER storage_v11_append_transition_guard
  BEFORE UPDATE OR DELETE ON storage_v11_append_transitions
  FOR EACH ROW EXECUTE FUNCTION storage_v11_append_transition_guard();

CREATE FUNCTION storage_v11_classify_head()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO storage_v11_append_transitions (
    generation_id, previous_generation_id, participant_id, head_revision, is_append, compared_records
  )
  WITH days AS MATERIALIZED (
    SELECT prior_day.observed_day, prior_day.manifest_id AS old_manifest, next_day.manifest_id AS new_manifest
      FROM telemetry_v11_domain_days prior_day
      LEFT JOIN telemetry_v11_domain_days next_day
        ON next_day.generation_id = NEW.generation_id AND next_day.observed_day = prior_day.observed_day
     WHERE prior_day.generation_id = OLD.generation_id
  ), unmatched AS MATERIALIZED (
    SELECT chunk.id, chunk.manifest_id, chunk.stream, chunk.record_count, days.new_manifest
      FROM days
      JOIN telemetry_v11_chunks chunk ON chunk.manifest_id = days.old_manifest
     WHERE days.old_manifest IS DISTINCT FROM days.new_manifest AND chunk.stream IN ('usage', 'quota')
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_v11_chunks reused
          WHERE reused.manifest_id = days.new_manifest AND reused.chunk_id = chunk.chunk_id
            AND reused.stream = chunk.stream AND reused.chunk_digest = chunk.chunk_digest
            AND reused.record_count = chunk.record_count AND reused.parser_version = chunk.parser_version)
     LIMIT 201
  ), counted AS MATERIALIZED (
    SELECT least(201, COALESCE(sum(unmatched.record_count), 0))::integer AS n FROM unmatched
  )
  SELECT NEW.generation_id, OLD.generation_id, NEW.participant_id, NEW.revision,
    CASE
      WHEN NOT EXISTS (
             SELECT 1 FROM storage_v11_owner_links owner_link
               JOIN storage_source_state source ON source.singleton = 1
               JOIN storage_owner_revisions owner_head
                 ON owner_head.source_id = source.source_id AND owner_head.owner_digest = owner_link.owner_digest
              WHERE owner_link.participant_id = OLD.participant_id
                AND owner_link.generation_id = OLD.generation_id
                AND owner_link.head_revision = OLD.revision
                AND owner_link.state = 'active' AND owner_head.state = 'active')
        OR NOT EXISTS (
             SELECT 1 FROM typed_v11_admission_state admission
              WHERE admission.id = 1 AND admission.runtime_contract_version = 1)
        OR NOT EXISTS (
             SELECT 1 FROM telemetry_v11_domains next_domain
               JOIN telemetry_v11_domains old_domain ON old_domain.id = OLD.generation_id
              WHERE next_domain.id = NEW.generation_id AND next_domain.previous_generation_id = old_domain.id
                AND next_domain.participant_id = old_domain.participant_id
                AND next_domain.participant_id = NEW.participant_id
                AND next_domain.device_id = old_domain.device_id)
        OR EXISTS (
             SELECT 1 FROM days
               LEFT JOIN telemetry_v11_day_manifests old_manifest ON old_manifest.id = days.old_manifest
               LEFT JOIN telemetry_v11_day_manifests new_manifest ON new_manifest.id = days.new_manifest
              WHERE new_manifest.id IS NULL OR new_manifest.state <> 'ready' OR old_manifest.state <> 'ready'
                 OR new_manifest.participant_id IS DISTINCT FROM old_manifest.participant_id
                 OR new_manifest.device_id IS DISTINCT FROM old_manifest.device_id
                 OR new_manifest.chunk_day IS DISTINCT FROM old_manifest.chunk_day
                 OR new_manifest.parser_version IS DISTINCT FROM old_manifest.parser_version
                 -- Both columns hold canonical JSON, so jsonb equality is
                 -- D1's equality of the extracted canonical text.
                 OR (new_manifest.manifest_json::jsonb -> 'consent')
                      IS DISTINCT FROM (old_manifest.manifest_json::jsonb -> 'consent')
                 OR (new_manifest.manifest_json::jsonb -> 'excluded')
                      IS DISTINCT FROM (old_manifest.manifest_json::jsonb -> 'excluded'))
        THEN 0
      WHEN counted.n > 200 THEN 0
      WHEN EXISTS (
             SELECT 1 FROM unmatched replaced
               JOIN typed_v11_record_admissions old_row ON old_row.chunk_id = replaced.id
               JOIN typed_telemetry_records old_record ON old_record.id = old_row.typed_record_id
              WHERE NOT EXISTS (
                SELECT 1 FROM typed_v11_record_admissions next_row
                  JOIN typed_telemetry_records next_record ON next_record.id = next_row.typed_record_id
                 WHERE next_row.manifest_id = replaced.new_manifest AND next_row.stream = old_row.stream
                   AND next_row.occurrence_id = old_row.occurrence_id
                   AND next_record.canonical_digest = old_record.canonical_digest
                   AND next_record.namespace_id = old_record.namespace_id
                   AND next_record.format = 11 AND old_record.format = 11))
        THEN 0
      ELSE 1
    END,
    counted.n
  FROM counted;
  RETURN NEW;
END;
$$;
CREATE TRIGGER storage_v11_classify_head
  BEFORE UPDATE ON telemetry_v11_domain_heads
  FOR EACH ROW EXECUTE FUNCTION storage_v11_classify_head();

-- (6) v1.1 owner bridge: D1 ingestion-bridge 0001 storage_v11_head_insert /
-- storage_v11_head_update -> storage_v11_head_request_apply ->
-- storage_v11_event_publish (as ingestion-isolation 0002 replaced it), as
-- 0055 ports the v1.2 bridge. An eligible accepted v1.1 head change mints or
-- reuses the shared owner link, records one storage_v11_event_sources
-- receipt and appends one exact journal row (storage_journal_append, 0046)
-- whose object digest is that receipt and whose content digest is the
-- generation's manifest digest; the link then names the head (D1 updates
-- generation_id, head_revision, object_digest and manifest_digest). D1 skips
-- the receipt when the active link already names this generation and
-- revision. The row is 'source-updated' with both epochs unchanged when (8)
-- classified this exact head move as an append and the link and the owner's
-- journal head are active at the generation and revision it replaces;
-- otherwise it is 'owner-active' and both epochs advance.
--
-- The 0014 telemetry_v11_domain_head_source_revision trigger stays: AFTER
-- triggers fire in name order, so this bridge runs first, and once the owner
-- has a journal head the 0058 emitter writes no version-0 row for it. Lock
-- order is 0055's: participant (held FOR SHARE by the activation's TA-1
-- check), v1.1 head (the firing statement), retention marker, owner link,
-- then storage_source_state and the owner revision head inside the append.
-- Eligibility is 0055's storage_v12_bridge_eligible (community_public_source_
-- owners with the head's device), read again under the link lock. Without
-- storage_source_state, in a transfer session, or for an erased owner the
-- bridge does nothing; (7) reports and repairs such heads.
CREATE FUNCTION storage_v11_bridge_head(
  participant_id_value text,
  generation_id_value text,
  head_revision_value bigint
)
RETURNS boolean
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  domain_row telemetry_v11_domains%ROWTYPE;
  owner_digest_value text;
  link_state text;
  link_generation text;
  link_revision bigint;
  event_digest_value text;
  append_value boolean;
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
    FROM telemetry_v11_domains domain
   WHERE domain.id = generation_id_value AND domain.participant_id = participant_id_value;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM accountless_public_history_retention marker
   WHERE marker.participant_id = participant_id_value
   FOR SHARE;
  IF NOT storage_v12_bridge_eligible(participant_id_value, domain_row.device_id) THEN
    RETURN false;
  END IF;

  owner_digest_value := storage_owner_link_ensure(participant_id_value, 'withdrawn');
  SELECT owner_link.state, owner_link.generation_id, owner_link.head_revision
    INTO link_state, link_generation, link_revision
    FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = participant_id_value
     AND owner_link.owner_digest = owner_digest_value
   FOR UPDATE;
  IF NOT FOUND OR link_state = 'erased' THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM storage_owner_revisions head
     WHERE head.owner_digest = owner_digest_value AND head.state = 'erased'
  ) THEN
    RETURN false;
  END IF;
  IF NOT storage_v12_bridge_eligible(participant_id_value, domain_row.device_id) THEN
    RETURN false;
  END IF;
  -- D1: (link.generation_id IS NOT NEW.generation_id OR link.head_revision
  -- IS NOT NEW.head_revision OR link.state != 'active').
  IF link_state = 'active' AND link_generation IS NOT DISTINCT FROM generation_id_value
     AND link_revision IS NOT DISTINCT FROM head_revision_value THEN
    RETURN false;
  END IF;

  -- D1 ingestion-isolation 0002 storage_v11_event_publish: classified
  -- against the link as it stands before this head is recorded on it.
  append_value := link_state = 'active' AND EXISTS (
    SELECT 1 FROM storage_v11_append_transitions transition
      JOIN storage_source_state source ON source.singleton = 1
      JOIN storage_owner_revisions prior
        ON prior.source_id = source.source_id AND prior.owner_digest = owner_digest_value
       AND prior.state = 'active'
     WHERE transition.generation_id = generation_id_value
       AND transition.participant_id = participant_id_value
       AND transition.head_revision = head_revision_value AND transition.is_append = 1
       AND link_generation = transition.previous_generation_id
       AND link_revision + 1 = transition.head_revision);

  -- Random and opaque, like D1's lower(hex(randomblob(32))); recorded_ms is
  -- whole seconds, like D1's strftime('%s','now')*1000.
  event_digest_value := encode(
    sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  INSERT INTO storage_v11_event_sources (
    event_digest, owner_digest, participant_id, device_id, generation_id, manifest_digest,
    from_day, through_day, head_revision, input_revision, recorded_ms
  ) VALUES (
    event_digest_value, owner_digest_value, participant_id_value, domain_row.device_id,
    domain_row.id, domain_row.manifest_digest, domain_row.from_day, domain_row.through_day,
    head_revision_value, domain_row.input_revision,
    floor(extract(epoch FROM clock_timestamp()))::bigint * 1000
  );
  PERFORM storage_journal_append(
    CASE WHEN append_value THEN 'source-updated' ELSE 'owner-active' END,
    owner_digest_value, event_digest_value, event_digest_value, domain_row.manifest_digest);
  UPDATE storage_v11_owner_links
     SET state = 'active', generation_id = generation_id_value, head_revision = head_revision_value,
         object_digest = event_digest_value, manifest_digest = domain_row.manifest_digest
   WHERE participant_id = participant_id_value AND owner_digest = owner_digest_value;
  RETURN true;
END;
$$;

CREATE FUNCTION storage_v11_head_publication()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR OLD.generation_id IS DISTINCT FROM NEW.generation_id
     OR OLD.revision IS DISTINCT FROM NEW.revision THEN
    PERFORM storage_v11_bridge_head(NEW.participant_id, NEW.generation_id, NEW.revision::bigint);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER storage_v11_head_publication
  AFTER INSERT OR UPDATE ON telemetry_v11_domain_heads
  FOR EACH ROW EXECUTE FUNCTION storage_v11_head_publication();

-- (7) Heads the v1.1 bridge still owes, and their bounded repair: 0055
-- (5)-(7) for v1.1. A pending head is an eligible current head of an owner
-- that is not erased with no receipt for its (participant, generation,
-- revision), for example one accepted before storage_source_state existed.
-- There is no one-time backfill here: heads present when this migration runs
-- arrive from the D1 import together with D1's own receipts.
CREATE FUNCTION storage_v11_bridge_pending_heads()
RETURNS TABLE (participant_id text, generation_id text, head_revision bigint)
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT head.participant_id, head.generation_id, head.revision::bigint
    FROM telemetry_v11_domain_heads head
    JOIN telemetry_v11_domains domain
      ON domain.id = head.generation_id AND domain.participant_id = head.participant_id
   WHERE EXISTS (
           SELECT 1 FROM community_public_source_owners public_owner
            WHERE public_owner.participant_id = head.participant_id
              AND (public_owner.device_id IS NULL OR public_owner.device_id = domain.device_id))
     AND NOT EXISTS (
           SELECT 1 FROM storage_v11_event_sources receipt
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
CREATE FUNCTION storage_v11_bridge_pending_count()
RETURNS bigint
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT count(*)::bigint FROM storage_v11_bridge_pending_heads()
$$;

-- Take every row the bridge needs for one pending head without waiting on
-- another transaction's row lock (participant, v1.1 head, the head's device,
-- the retention marker if any, the owner link), as 0055's
-- storage_v12_bridge_lock_pending.
CREATE FUNCTION storage_v11_bridge_lock_pending(participant_id_value text)
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
    FROM telemetry_v11_domain_heads head
    JOIN telemetry_v11_domains domain
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

-- Bounded, idempotent repair: inspects at most limit_value pending heads in
-- participant_id COLLATE "C" order and bridges at most one, so its caller
-- commits before the next owner (the append takes storage_source_state).
CREATE FUNCTION storage_v11_bridge_backfill(limit_value integer)
RETURNS integer
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  candidate record;
  current_generation text;
  current_revision bigint;
BEGIN
  IF limit_value IS NULL OR limit_value < 1 OR limit_value > 500 THEN
    RAISE EXCEPTION 'storage_v11_bridge_limit_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF storage_journal_transfer_session() THEN
    RAISE EXCEPTION 'storage_v11_bridge_transfer_session' USING ERRCODE = 'P1005';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_source_state source WHERE source.singleton = 1) THEN
    RETURN 0;
  END IF;
  FOR candidate IN
    SELECT pending.participant_id
      FROM storage_v11_bridge_pending_heads() pending
     ORDER BY pending.participant_id COLLATE "C"
     LIMIT limit_value
  LOOP
    CONTINUE WHEN NOT storage_v11_bridge_lock_pending(candidate.participant_id);
    SELECT head.generation_id, head.revision::bigint
      INTO current_generation, current_revision
      FROM telemetry_v11_domain_heads head
     WHERE head.participant_id = candidate.participant_id;
    IF storage_v11_bridge_head(candidate.participant_id, current_generation, current_revision) THEN
      RETURN 1;
    END IF;
  END LOOP;
  RETURN 0;
END;
$$;
-- A maintenance entrypoint, granted deliberately like storage_journal_append.
REVOKE ALL ON FUNCTION storage_v11_bridge_backfill(integer) FROM PUBLIC;
