-- Import shape for the admission, preservation-proof, and publication
-- memberships that accompany the typed v1/v1.1 base family from 0030.
--
-- This is transfer storage only. Rows here do not attest to a complete source
-- snapshot, enable an effective reader, or authorize owner erasure. The
-- transfer runner writes its receipt only after both formats and every
-- admission/event table have passed source-to-target parity.

CREATE TABLE typed_v1_admission_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  source_namespace text NOT NULL UNIQUE CHECK (length(source_namespace) BETWEEN 1 AND 256),
  namespace_id bigint NOT NULL UNIQUE REFERENCES typed_telemetry_namespaces(id) ON DELETE CASCADE,
  runtime_contract_version smallint NOT NULL CHECK (runtime_contract_version IN (0, 1)),
  next_source_row_id bigint NOT NULL CHECK (next_source_row_id BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE typed_v11_admission_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  source_namespace text NOT NULL UNIQUE CHECK (length(source_namespace) BETWEEN 1 AND 256),
  namespace_id bigint NOT NULL UNIQUE REFERENCES typed_telemetry_namespaces(id) ON DELETE CASCADE,
  runtime_contract_version smallint NOT NULL CHECK (runtime_contract_version IN (0, 1)),
  next_source_row_id bigint NOT NULL CHECK (next_source_row_id BETWEEN 1 AND 9007199254740991)
);

CREATE TABLE typed_v1_chunk_allocations (
  chunk_id text PRIMARY KEY REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
  namespace_id bigint NOT NULL REFERENCES typed_telemetry_namespaces(id) ON DELETE CASCADE,
  chunk_original bytea NOT NULL CHECK (octet_length(chunk_original) BETWEEN 2 AND 257),
  first_source_row_id bigint NOT NULL CHECK (first_source_row_id >= 1),
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  CHECK (first_source_row_id + record_count <= 9007199254740991),
  UNIQUE (namespace_id, first_source_row_id),
  UNIQUE (namespace_id, chunk_original)
);

CREATE TABLE typed_v1_record_admissions (
  typed_record_id bigint PRIMARY KEY REFERENCES typed_telemetry_records(id) ON DELETE CASCADE,
  chunk_id text NOT NULL REFERENCES telemetry_v1_chunks(id) ON DELETE CASCADE,
  UNIQUE (chunk_id, typed_record_id)
);
CREATE INDEX typed_v1_admissions_chunk ON typed_v1_record_admissions(chunk_id, typed_record_id);

CREATE TABLE typed_v1_preservation_proofs (
  source_row_id bigint PRIMARY KEY REFERENCES telemetry_v1_records(id) ON DELETE CASCADE,
  canonical_digest bytea NOT NULL CHECK (octet_length(canonical_digest) = 32)
);

CREATE TABLE typed_v11_chunk_allocations (
  chunk_id text PRIMARY KEY REFERENCES telemetry_v11_chunks(id) ON DELETE CASCADE,
  namespace_id bigint NOT NULL REFERENCES typed_telemetry_namespaces(id) ON DELETE CASCADE,
  chunk_original bytea NOT NULL CHECK (octet_length(chunk_original) BETWEEN 2 AND 257),
  first_source_row_id bigint NOT NULL CHECK (first_source_row_id >= 1),
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  CHECK (first_source_row_id + record_count <= 9007199254740991),
  UNIQUE (namespace_id, first_source_row_id),
  UNIQUE (namespace_id, chunk_original)
);

CREATE TABLE typed_v11_manifest_memberships (
  manifest_id text PRIMARY KEY REFERENCES telemetry_v11_day_manifests(id) ON DELETE CASCADE,
  typed_manifest_id bigint NOT NULL UNIQUE REFERENCES typed_telemetry_manifests(id) ON DELETE CASCADE
);

CREATE TABLE typed_v11_record_proofs (
  typed_record_id bigint PRIMARY KEY REFERENCES typed_telemetry_records(id) ON DELETE CASCADE,
  chunk_key bigint NOT NULL,
  manifest_key bigint NOT NULL,
  stream_code smallint NOT NULL CHECK (stream_code IN (1, 2, 3)),
  occurrence_blob bytea NOT NULL CHECK (octet_length(occurrence_blob) BETWEEN 2 AND 257),
  base_digest bytea NOT NULL CHECK (octet_length(base_digest) = 32),
  legacy_occurrence_blob bytea,
  legacy_digest bytea CHECK (legacy_digest IS NULL OR octet_length(legacy_digest) = 32),
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  CHECK ((legacy_occurrence_blob IS NULL) = (legacy_digest IS NULL)),
  CHECK (legacy_occurrence_blob IS NULL OR octet_length(legacy_occurrence_blob) BETWEEN 2 AND 257),
  FOREIGN KEY (chunk_key) REFERENCES typed_telemetry_chunks(id) ON DELETE CASCADE,
  FOREIGN KEY (manifest_key) REFERENCES typed_telemetry_manifests(id) ON DELETE CASCADE
);
CREATE INDEX typed_v11_proof_chunk ON typed_v11_record_proofs(chunk_key);
CREATE INDEX typed_v11_proof_manifest ON typed_v11_record_proofs(manifest_key, stream_code, typed_record_id);

CREATE FUNCTION typed_legacy_admission_decode_id(value bytea)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path FROM CURRENT AS $$
  SELECT CASE
    WHEN octet_length(value) BETWEEN 2 AND 257 AND get_byte(value, 0) = 0
      THEN convert_from(substring(value FROM 2), 'UTF8')
    WHEN octet_length(value) = 17 AND get_byte(value, 0) IN (1,2,3,4,5,11)
      THEN (CASE get_byte(value, 0) WHEN 2 THEN 'participant:' WHEN 3 THEN 'device:'
        WHEN 4 THEN 'v1:' WHEN 5 THEN 'contribution:' WHEN 11 THEN 'chunk:' ELSE '' END)
        || (SELECT lower(substr(hex,1,8)||'-'||substr(hex,9,4)||'-'||substr(hex,13,4)||'-'||substr(hex,17,4)||'-'||substr(hex,21,12))
              FROM (SELECT encode(substring(value FROM 2), 'hex') AS hex) encoded)
    WHEN octet_length(value) = 33 AND get_byte(value, 0) IN (6,7,8,9,10)
      THEN (CASE get_byte(value, 0) WHEN 7 THEN 'event:v2:' WHEN 8 THEN 'quota-occurrence:v1:'
        WHEN 9 THEN 'account-track:v2:' WHEN 10 THEN 'plan-era:v1:' ELSE '' END)
        || encode(substring(value FROM 2), 'hex')
    ELSE NULL
  END
$$;

CREATE FUNCTION typed_legacy_v1_chunk_allocation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF typed_legacy_admission_decode_id(NEW.chunk_original) IS DISTINCT FROM NEW.chunk_id
     OR NOT EXISTS (
       SELECT 1 FROM typed_v1_admission_state state
       JOIN telemetry_v1_chunks source_chunk ON source_chunk.id = NEW.chunk_id
       WHERE state.id = 1 AND state.namespace_id = NEW.namespace_id
         AND source_chunk.record_count = NEW.record_count
     ) THEN
    RAISE EXCEPTION 'typed_legacy_admission_parent_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_legacy_v1_chunk_allocation_guard
  BEFORE INSERT ON typed_v1_chunk_allocations
  FOR EACH ROW EXECUTE FUNCTION typed_legacy_v1_chunk_allocation_guard();

CREATE FUNCTION typed_legacy_v11_chunk_allocation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF typed_legacy_admission_decode_id(NEW.chunk_original) IS DISTINCT FROM NEW.chunk_id
     OR NOT EXISTS (
       SELECT 1 FROM typed_v11_admission_state state
       JOIN telemetry_v11_chunks source_chunk ON source_chunk.id = NEW.chunk_id
       WHERE state.id = 1 AND state.namespace_id = NEW.namespace_id
         AND source_chunk.record_count = NEW.record_count
     ) THEN
    RAISE EXCEPTION 'typed_legacy_admission_parent_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_legacy_v11_chunk_allocation_guard
  BEFORE INSERT ON typed_v11_chunk_allocations
  FOR EACH ROW EXECUTE FUNCTION typed_legacy_v11_chunk_allocation_guard();

CREATE FUNCTION typed_legacy_v1_record_admission_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM typed_telemetry_records record
    JOIN typed_telemetry_chunks typed_chunk
      ON typed_chunk.id = record.chunk_id AND typed_chunk.namespace_id = record.namespace_id
     AND typed_chunk.format = record.format AND typed_chunk.owner_id = record.owner_id
     AND typed_chunk.device_id = record.device_id AND typed_chunk.stream = record.stream
    JOIN typed_telemetry_devices typed_device
      ON typed_device.id = record.device_id AND typed_device.namespace_id = record.namespace_id
     AND typed_device.owner_id = record.owner_id
    JOIN typed_v1_chunk_allocations allocation
      ON allocation.namespace_id = record.namespace_id
     AND allocation.chunk_original = typed_chunk.original_id
    JOIN telemetry_v1_chunks source_chunk ON source_chunk.id = allocation.chunk_id
    JOIN typed_v1_admission_state admission ON admission.namespace_id = allocation.namespace_id
    JOIN typed_telemetry_owner_memberships membership
      ON membership.namespace_id = record.namespace_id AND membership.source_format = 10
     AND membership.owner_id = record.owner_id AND membership.source_namespace = admission.source_namespace
    WHERE record.id = NEW.typed_record_id AND record.format = 10
      AND allocation.chunk_id = NEW.chunk_id AND source_chunk.record_count = allocation.record_count
      AND typed_legacy_admission_decode_id(typed_chunk.original_id) = source_chunk.id
      AND typed_legacy_admission_decode_id(typed_device.original_id) = source_chunk.device_id
      AND record.source_row_id >= allocation.first_source_row_id
      AND record.source_row_id < allocation.first_source_row_id + allocation.record_count
      AND source_chunk.participant_id = membership.participant_id
      AND source_chunk.stream = CASE record.stream WHEN 1 THEN 'usage' WHEN 2 THEN 'quota' ELSE 'session' END
  ) THEN
    RAISE EXCEPTION 'typed_legacy_admission_parent_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_legacy_v1_record_admission_guard
  BEFORE INSERT ON typed_v1_record_admissions
  FOR EACH ROW EXECUTE FUNCTION typed_legacy_v1_record_admission_guard();

-- D1 typed v1 admission refuses legacy JSON records. Keep the original raw
-- membership branch for legacy runtimes, but validate typed-runtime events
-- against the imported allocation/admission lineage instead of requiring
-- rows in telemetry_v1_records. The erasure lock order remains participant,
-- owner link, then source chunk.
CREATE OR REPLACE FUNCTION telemetry_v1_event_source_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
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

  IF EXISTS (
    SELECT 1 FROM typed_v1_admission_state state
     WHERE state.id = 1 AND state.runtime_contract_version = 1
  ) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM typed_v1_admission_state state
        JOIN telemetry_v1_chunks source_chunk
          ON source_chunk.id = NEW.chunk_id
         AND source_chunk.participant_id = NEW.participant_id
        JOIN typed_v1_chunk_allocations allocation
          ON allocation.chunk_id = source_chunk.id
         AND allocation.namespace_id = state.namespace_id
        JOIN typed_telemetry_chunks typed_chunk
          ON typed_chunk.namespace_id = state.namespace_id
         AND typed_chunk.format = 10
         AND typed_chunk.original_id = allocation.chunk_original
        JOIN typed_telemetry_devices typed_device
          ON typed_device.id = typed_chunk.device_id
         AND typed_device.namespace_id = state.namespace_id
         AND typed_device.owner_id = typed_chunk.owner_id
        JOIN storage_v11_owner_links owner_link
          ON owner_link.participant_id = source_chunk.participant_id
         AND owner_link.owner_digest = NEW.owner_digest
         AND owner_link.state <> 'erased'
       WHERE state.id = 1
         AND state.runtime_contract_version = 1
         AND state.source_namespace = NEW.source_namespace
         AND source_chunk.superseded_at IS NULL
         AND source_chunk.accepted_record_count = source_chunk.record_count
         AND source_chunk.record_count = allocation.record_count
         AND allocation.first_source_row_id + allocation.record_count <= state.next_source_row_id
         AND typed_chunk.chunk_day = (source_chunk.chunk_day - DATE '1970-01-01')
         AND typed_legacy_admission_decode_id(typed_chunk.original_id) = source_chunk.id
         AND typed_legacy_admission_decode_id(typed_device.original_id) = source_chunk.device_id
         AND source_chunk.record_count = (
           SELECT count(*)
             FROM typed_v1_record_admissions admission
            WHERE admission.chunk_id = source_chunk.id
         )
         AND NOT EXISTS (
           SELECT 1
             FROM typed_v1_record_admissions admission
             LEFT JOIN typed_telemetry_records record
               ON record.id = admission.typed_record_id
             LEFT JOIN typed_telemetry_chunks record_chunk
               ON record_chunk.id = record.chunk_id
             LEFT JOIN typed_telemetry_devices record_device
               ON record_device.id = record.device_id
             LEFT JOIN typed_telemetry_owner_memberships membership
               ON membership.namespace_id = record.namespace_id
              AND membership.source_format = 10
              AND membership.owner_id = record.owner_id
              AND membership.source_namespace = state.source_namespace
            WHERE admission.chunk_id = source_chunk.id
              AND (
                record.id IS NULL
                OR record.namespace_id <> state.namespace_id
                OR record.format <> 10
                OR record_chunk.id IS NULL
                OR record_chunk.id <> typed_chunk.id
                OR record_chunk.namespace_id <> state.namespace_id
                OR record_chunk.format <> 10
                OR record_chunk.owner_id <> record.owner_id
                OR record_chunk.device_id <> record.device_id
                OR record_chunk.stream <> record.stream
                OR record_chunk.original_id <> allocation.chunk_original
                OR record_chunk.chunk_day <> typed_chunk.chunk_day
                OR record_device.id IS NULL
                OR record_device.namespace_id <> state.namespace_id
                OR record_device.owner_id <> record.owner_id
                OR membership.owner_id IS NULL
                OR membership.participant_id <> source_chunk.participant_id
                OR record.stream <> CASE source_chunk.stream
                  WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 ELSE 3 END
                OR record.observed_day <> record_chunk.chunk_day
                OR record.source_row_id < allocation.first_source_row_id
                OR record.source_row_id >= allocation.first_source_row_id + allocation.record_count
              )
         )
    ) THEN
      RAISE EXCEPTION 'telemetry_source_membership_invalid' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
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

CREATE FUNCTION typed_legacy_v1_preservation_proof_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM telemetry_v1_records source_record
    JOIN typed_v1_admission_state state ON state.id = 1
    JOIN typed_telemetry_owner_memberships membership
      ON membership.namespace_id = state.namespace_id AND membership.source_format = 10
     AND membership.source_namespace = state.source_namespace
    JOIN typed_telemetry_records typed_record
      ON typed_record.namespace_id = membership.namespace_id AND typed_record.owner_id = membership.owner_id
     AND typed_record.format = 10 AND typed_record.source_row_id = source_record.id
    JOIN typed_telemetry_chunks typed_chunk ON typed_chunk.id = typed_record.chunk_id
    JOIN typed_telemetry_devices typed_device ON typed_device.id = typed_record.device_id
    WHERE source_record.id = NEW.source_row_id
      AND typed_record.canonical_digest = NEW.canonical_digest
      AND typed_legacy_admission_decode_id(typed_chunk.original_id) = source_record.chunk_row_id
      AND typed_legacy_admission_decode_id(typed_device.original_id) = source_record.device_id
      AND typed_record.stream = CASE source_record.stream WHEN 'usage' THEN 1 WHEN 'quota' THEN 2 ELSE 3 END
      AND source_record.participant_id = membership.participant_id
  ) THEN
    RAISE EXCEPTION 'typed_legacy_admission_parent_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_legacy_v1_preservation_proof_guard
  BEFORE INSERT ON typed_v1_preservation_proofs
  FOR EACH ROW EXECUTE FUNCTION typed_legacy_v1_preservation_proof_guard();

CREATE FUNCTION typed_legacy_v11_manifest_membership_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM telemetry_v11_day_manifests source_manifest
    JOIN typed_v11_admission_state state ON state.id = 1
    JOIN typed_telemetry_manifests manifest ON manifest.id = NEW.typed_manifest_id
     AND manifest.namespace_id = state.namespace_id
    JOIN typed_telemetry_owner_memberships membership
      ON membership.namespace_id = state.namespace_id AND membership.source_format = 11
     AND membership.source_namespace = state.source_namespace AND membership.owner_id = manifest.owner_id
    JOIN typed_telemetry_records record ON record.manifest_id = manifest.id
     AND record.format = 11 AND record.owner_id = membership.owner_id
    JOIN typed_telemetry_devices device ON device.id = record.device_id
    WHERE source_manifest.id = NEW.manifest_id
      AND source_manifest.participant_id = membership.participant_id
      AND typed_legacy_admission_decode_id(device.original_id) = source_manifest.device_id
      AND typed_legacy_admission_decode_id(manifest.original_id) = source_manifest.id
  ) THEN
    RAISE EXCEPTION 'typed_legacy_admission_parent_missing' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_legacy_v11_manifest_membership_guard
  BEFORE INSERT ON typed_v11_manifest_memberships
  FOR EACH ROW EXECUTE FUNCTION typed_legacy_v11_manifest_membership_guard();

CREATE FUNCTION typed_legacy_v11_record_proof_guard()
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
      AND record.canonical_digest = NEW.base_digest
      AND record.observed_at_ms = NEW.observed_at_ms
      AND admission.runtime_contract_version = 1
      AND source_chunk.record_count = allocation.record_count
      AND source_chunk.chunk_day = source_manifest.chunk_day
      AND source_manifest.state = 'ready'
      AND source_manifest.expected_chunk_count = (
        SELECT count(*) FROM telemetry_v11_chunks manifest_chunk
         WHERE manifest_chunk.manifest_id = source_manifest.id
      )
      AND typed_legacy_admission_decode_id(chunk.original_id) = source_chunk.id
      AND source_chunk.participant_id = owner_membership.participant_id
      AND source_manifest.participant_id = owner_membership.participant_id
      AND source_manifest.device_id = source_chunk.device_id
      AND manifest.chunk_day = (source_manifest.chunk_day - DATE '1970-01-01')
      AND typed_legacy_admission_decode_id(manifest.original_id) = source_manifest.id
      AND typed_legacy_admission_decode_id(device.original_id) = source_chunk.device_id
      -- Typed v1.1 admission refuses raw telemetry_v11_records inserts. Its
      -- compact proof is the retained occurrence/digest/time lineage; bind
      -- the base fields to typed_telemetry_records and the immutable source
      -- chunk/manifest authorities rather than requiring a forbidden JSON row.
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
CREATE TRIGGER typed_legacy_v11_record_proof_guard
  BEFORE INSERT ON typed_v11_record_proofs
  FOR EACH ROW EXECUTE FUNCTION typed_legacy_v11_record_proof_guard();

-- This receipt identifies a completed base-plus-admission lineage rehearsal.
-- It is not consumed as reader activation or production-readiness evidence.
CREATE TABLE typed_telemetry_admission_transfer_receipts (
  transfer_id text PRIMARY KEY CHECK (length(transfer_id) BETWEEN 1 AND 128),
  v1_source_namespace text NOT NULL CHECK (length(v1_source_namespace) BETWEEN 1 AND 256),
  v1_source_format smallint NOT NULL DEFAULT 10 CHECK (v1_source_format = 10),
  v11_source_namespace text NOT NULL CHECK (length(v11_source_namespace) BETWEEN 1 AND 256),
  v11_source_format smallint NOT NULL DEFAULT 11 CHECK (v11_source_format = 11),
  v1_base_generation bigint NOT NULL CHECK (v1_base_generation >= 1),
  v11_base_generation bigint NOT NULL CHECK (v11_base_generation >= 1),
  source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  lineage_manifest_sha256 text NOT NULL CHECK (lineage_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  table_row_counts jsonb NOT NULL CHECK (jsonb_typeof(table_row_counts) = 'object'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (v1_source_namespace, v1_source_format)
    REFERENCES typed_telemetry_source_family_receipts(source_namespace, source_format),
  FOREIGN KEY (v11_source_namespace, v11_source_format)
    REFERENCES typed_telemetry_source_family_receipts(source_namespace, source_format),
  UNIQUE (v1_source_namespace, v11_source_namespace, v1_base_generation, v11_base_generation)
);

CREATE FUNCTION typed_telemetry_admission_transfer_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'typed_telemetry_admission_transfer_receipt_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_telemetry_admission_transfer_receipt_guard
  BEFORE UPDATE OR DELETE ON typed_telemetry_admission_transfer_receipts
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_admission_transfer_receipt_guard();

COMMENT ON TABLE typed_telemetry_admission_transfer_receipts IS
  'Historical completed-import evidence only. It does not attest to current target parity, reader activation, production readiness, or erasure authorization; consumers must recheck current rows.';
