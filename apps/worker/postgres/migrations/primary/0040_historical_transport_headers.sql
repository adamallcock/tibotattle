-- Historical D1 v1/v1.1 transport headers are not live uploads. Keep their
-- exact source tuples in a separate, source-bound archive so importing them
-- cannot consume upload authorizations or trigger live-ingest side effects.

CREATE TABLE historical_transport_header_imports (
  source_import_id text PRIMARY KEY CHECK (source_import_id ~ '^[0-9a-f]{64}$'),
  target_schema text NOT NULL CHECK (target_schema ~ '^typed_legacy_target_[a-z0-9_]+$'),
  source_snapshot_id text NOT NULL CHECK (length(source_snapshot_id) BETWEEN 8 AND 256),
  source_snapshot_kind text NOT NULL
    CHECK (source_snapshot_kind IN ('sealed-sqlite-rehearsal', 'synthetic-d1-fixture')),
  source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  v1_source_namespace text NOT NULL CHECK (length(v1_source_namespace) BETWEEN 1 AND 256),
  v11_source_namespace text NOT NULL CHECK (length(v11_source_namespace) BETWEEN 1 AND 256),
  header_manifest_sha256 text NOT NULL CHECK (header_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  header_table_row_counts jsonb NOT NULL CHECK (jsonb_typeof(header_table_row_counts) = 'object'),
  header_table_sha256 jsonb NOT NULL CHECK (jsonb_typeof(header_table_sha256) = 'object'),
  mirror_control_schema text NOT NULL CHECK (mirror_control_schema ~ '^typed_legacy_admission_transfer_[a-z0-9_]+$'),
  mirror_transfer_id text NOT NULL CHECK (length(mirror_transfer_id) BETWEEN 1 AND 128),
  mirror_receipt_sha256 text NOT NULL CHECK (mirror_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  permitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (target_schema)
);

CREATE FUNCTION historical_transport_header_import_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.target_schema IS DISTINCT FROM current_schema()
       OR jsonb_typeof(NEW.header_table_row_counts) <> 'object'
       OR jsonb_typeof(NEW.header_table_sha256) <> 'object'
       OR (SELECT array_agg(keys.key ORDER BY keys.key) FROM jsonb_object_keys(NEW.header_table_row_counts) AS keys(key))
          IS DISTINCT FROM ARRAY['telemetry_v11_chunks','telemetry_v11_day_manifests','telemetry_v1_chunks']::text[]
       OR (SELECT array_agg(keys.key ORDER BY keys.key) FROM jsonb_object_keys(NEW.header_table_sha256) AS keys(key))
          IS DISTINCT FROM ARRAY['telemetry_v11_chunks','telemetry_v11_day_manifests','telemetry_v1_chunks']::text[]
       OR EXISTS (
         SELECT 1 FROM jsonb_each(NEW.header_table_row_counts) item
          WHERE jsonb_typeof(item.value) <> 'number' OR (item.value #>> '{}') !~ '^(0|[1-9][0-9]*)$'
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_each_text(NEW.header_table_sha256) item
          WHERE item.value !~ '^[0-9a-f]{64}$'
       ) THEN
      RAISE EXCEPTION 'historical_transport_header_import_invalid' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'historical_transport_header_import_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER historical_transport_header_import_guard
  BEFORE INSERT OR UPDATE OR DELETE ON historical_transport_header_imports
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_import_guard();

-- Keep D1 date/timestamp text unchanged. Authorization ids are evidence only;
-- unlike the live tables, these archive rows intentionally do not reference
-- disposable or expired upload-authorization rows.
CREATE TABLE historical_telemetry_v1_chunk_headers (
  source_import_id text NOT NULL REFERENCES historical_transport_header_imports(source_import_id) ON DELETE RESTRICT,
  id text NOT NULL,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('usage', 'quota', 'session')),
  chunk_day text NOT NULL CHECK (chunk_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  chunk_seq integer NOT NULL CHECK (chunk_seq BETWEEN 0 AND 99999),
  revision integer NOT NULL CHECK (revision >= 1),
  chunk_digest text NOT NULL CHECK (chunk_digest ~ '^[0-9a-f]{64}$'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL,
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  accepted_record_count integer NOT NULL CHECK (accepted_record_count BETWEEN 0 AND record_count),
  r2_key text NOT NULL,
  device_upload_authorization_id text NOT NULL,
  superseded_at text,
  quarantine_deleted_at text,
  created_at text NOT NULL,
  PRIMARY KEY (source_import_id, id),
  UNIQUE (source_import_id, r2_key),
  UNIQUE (source_import_id, device_upload_authorization_id),
  UNIQUE (source_import_id, participant_id, device_id, stream, chunk_day, chunk_seq, revision),
  UNIQUE (source_import_id, participant_id, envelope_digest)
);
CREATE INDEX historical_telemetry_v1_headers_owner
  ON historical_telemetry_v1_chunk_headers(participant_id, created_at, id);

CREATE TABLE historical_telemetry_v11_manifest_headers (
  source_import_id text NOT NULL REFERENCES historical_transport_header_imports(source_import_id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  chunk_day text NOT NULL CHECK (length(chunk_day) = 10 AND chunk_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  manifest_json text NOT NULL CHECK (length(manifest_json) <= 1250000 AND jsonb_typeof(manifest_json::jsonb) = 'object'),
  expected_chunk_count integer NOT NULL CHECK (expected_chunk_count BETWEEN 0 AND 4096),
  state text NOT NULL CHECK (state IN ('staged', 'ready')),
  created_at text NOT NULL,
  ready_at text,
  PRIMARY KEY (source_import_id, id),
  UNIQUE (source_import_id, participant_id, device_id, chunk_day, manifest_digest),
  CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CHECK (CASE WHEN jsonb_typeof(manifest_json::jsonb -> 'chunks') = 'array'
    THEN jsonb_array_length(manifest_json::jsonb -> 'chunks') = expected_chunk_count ELSE false END)
);
CREATE INDEX historical_telemetry_v11_manifest_headers_owner
  ON historical_telemetry_v11_manifest_headers(participant_id, created_at, id);

CREATE TABLE historical_telemetry_v11_chunk_headers (
  source_import_id text NOT NULL REFERENCES historical_transport_header_imports(source_import_id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (length(id) = 42 AND substr(id, 1, 6) = 'chunk:'),
  manifest_id text NOT NULL,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  stream text NOT NULL CHECK (stream IN ('quota', 'session', 'usage')),
  chunk_day text NOT NULL,
  chunk_seq integer NOT NULL CHECK (chunk_seq BETWEEN 0 AND 99999),
  chunk_id text NOT NULL,
  chunk_digest text NOT NULL CHECK (chunk_digest ~ '^[0-9a-f]{64}$'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  parser_version text NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 64),
  record_count integer NOT NULL CHECK (record_count BETWEEN 1 AND 200),
  r2_key text NOT NULL,
  device_upload_authorization_id text NOT NULL,
  quarantine_deleted_at text,
  created_at text NOT NULL,
  PRIMARY KEY (source_import_id, id),
  FOREIGN KEY (source_import_id, manifest_id)
    REFERENCES historical_telemetry_v11_manifest_headers(source_import_id, id) ON DELETE CASCADE,
  UNIQUE (source_import_id, manifest_id, chunk_id),
  UNIQUE (source_import_id, r2_key),
  UNIQUE (source_import_id, device_upload_authorization_id),
  UNIQUE (source_import_id, participant_id, envelope_digest)
);
CREATE INDEX historical_telemetry_v11_chunk_headers_owner
  ON historical_telemetry_v11_chunk_headers(participant_id, created_at, id);

CREATE FUNCTION historical_transport_header_archive_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF current_setting('tibotattle.legacy_header_promotion', true) IS DISTINCT FROM NEW.source_import_id
     OR NOT EXISTS (
       SELECT 1 FROM historical_transport_header_imports permit
        WHERE permit.source_import_id = NEW.source_import_id
          AND permit.target_schema = current_schema()
     )
     OR EXISTS (
       SELECT 1 FROM historical_transport_header_promotion_receipts receipt
        WHERE receipt.source_import_id = NEW.source_import_id
     ) THEN
    RAISE EXCEPTION 'historical_transport_header_insert_refused' USING ERRCODE = 'P1005';
  END IF;
  -- Serialize with participant erasure fencing. If erasure commits first, the
  -- active-state predicate refuses this insert; if the page commits first, the
  -- erasure inventory sees the archive rows and refuses unknown object refs.
  PERFORM participant.id FROM participants participant
   WHERE participant.id = NEW.participant_id AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historical_transport_header_identity_missing' USING ERRCODE = 'P1005';
  END IF;
  PERFORM device.id FROM device_credentials device
   WHERE device.id = NEW.device_id AND device.participant_id = NEW.participant_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historical_transport_header_identity_missing' USING ERRCODE = 'P1005';
  END IF;
  IF TG_TABLE_NAME = 'historical_telemetry_v11_chunk_headers' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM historical_telemetry_v11_manifest_headers manifest
        CROSS JOIN LATERAL jsonb_array_elements(manifest.manifest_json::jsonb -> 'chunks') expected
       WHERE manifest.source_import_id = NEW.source_import_id
         AND manifest.id = NEW.manifest_id
         AND manifest.participant_id = NEW.participant_id
         AND manifest.device_id = NEW.device_id
         AND manifest.chunk_day = NEW.chunk_day
         AND manifest.parser_version = NEW.parser_version
         AND expected.value ->> 'chunkId' = NEW.chunk_id
         AND expected.value ->> 'chunkDigest' = NEW.chunk_digest
         AND (expected.value ->> 'recordCount')::integer = NEW.record_count
    ) THEN
      RAISE EXCEPTION 'historical_transport_header_manifest_mismatch' USING ERRCODE = 'P1005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER historical_telemetry_v1_header_insert_guard
  BEFORE INSERT ON historical_telemetry_v1_chunk_headers
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_archive_insert_guard();
CREATE TRIGGER historical_telemetry_v11_manifest_header_insert_guard
  BEFORE INSERT ON historical_telemetry_v11_manifest_headers
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_archive_insert_guard();
CREATE TRIGGER historical_telemetry_v11_chunk_header_insert_guard
  BEFORE INSERT ON historical_telemetry_v11_chunk_headers
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_archive_insert_guard();

CREATE FUNCTION historical_transport_header_archive_immutability_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'historical_transport_header_immutable' USING ERRCODE = 'P1005';
  END IF;
  -- Direct deletion and device-only cleanup are refused. Only participant
  -- erasure removes the archive's owner authority and permits the FK cascade.
  IF EXISTS (SELECT 1 FROM participants WHERE id = OLD.participant_id) THEN
    RAISE EXCEPTION 'historical_transport_header_retained' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER historical_telemetry_v1_header_immutable
  BEFORE UPDATE OR DELETE ON historical_telemetry_v1_chunk_headers
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_archive_immutability_guard();
CREATE TRIGGER historical_telemetry_v11_manifest_header_immutable
  BEFORE UPDATE OR DELETE ON historical_telemetry_v11_manifest_headers
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_archive_immutability_guard();
CREATE TRIGGER historical_telemetry_v11_chunk_header_immutable
  BEFORE UPDATE OR DELETE ON historical_telemetry_v11_chunk_headers
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_archive_immutability_guard();

CREATE TABLE historical_transport_header_promotion_receipts (
  source_import_id text PRIMARY KEY REFERENCES historical_transport_header_imports(source_import_id) ON DELETE RESTRICT,
  mirror_receipt_sha256 text NOT NULL CHECK (mirror_receipt_sha256 ~ '^[0-9a-f]{64}$'),
  promoted_table_row_counts jsonb NOT NULL CHECK (jsonb_typeof(promoted_table_row_counts) = 'object'),
  promoted_table_sha256 jsonb NOT NULL CHECK (jsonb_typeof(promoted_table_sha256) = 'object'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION historical_transport_header_promotion_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'historical_transport_header_promotion_receipt_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER historical_transport_header_promotion_receipt_guard
  BEFORE UPDATE OR DELETE ON historical_transport_header_promotion_receipts
  FOR EACH ROW EXECUTE FUNCTION historical_transport_header_promotion_receipt_guard();

COMMENT ON TABLE historical_transport_header_imports IS
  'Immutable, source-bound, non-authoritative permit for one synthetic historical header promotion; it grants no upload, reader, cursor, owner, or publication authority.';
COMMENT ON TABLE historical_telemetry_v1_chunk_headers IS
  'Exact historical D1 v1 chunk-header tuples. Upload authorization IDs are inert provenance; rows are separate from live ingestion.';
COMMENT ON TABLE historical_telemetry_v11_manifest_headers IS
  'Exact historical D1 v1.1 manifest-header tuples; ready state is preserved as source history and does not attest to PostgreSQL raw records.';
COMMENT ON TABLE historical_telemetry_v11_chunk_headers IS
  'Exact historical D1 v1.1 chunk-header tuples; upload authorization IDs are inert provenance.';
COMMENT ON TABLE historical_transport_header_promotion_receipts IS
  'Immutable row-count and digest receipt for a completed historical header promotion; it does not activate any reader or publication.';
