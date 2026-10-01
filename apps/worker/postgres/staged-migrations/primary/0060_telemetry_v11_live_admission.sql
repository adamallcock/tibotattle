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
-- Not here (documented gaps, IN-2 continuation): the v1.1 owner bridge
-- (D1 ingestion-bridge 0001 storage_v11_head_* -> storage_v11_event_sources
-- -> storage_ingestion_changes), D1's community_snapshot_mutation_control /
-- community_daily_aggregate_rebuilds head side effects, and the chunk
-- admission window counter (telemetry_v1_chunk_admission_windows), which the
-- admission module enforces in its transaction instead.
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
