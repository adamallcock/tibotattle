-- A v1.2 day is visible only when its declared chunks and records are complete.
-- Keep the legacy record_json lane readable for already deployed 0006 writers,
-- while requiring normalized child completeness for the new typed lane.

CREATE FUNCTION telemetry_v12_manifest_ready_integrity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  document jsonb;
  declared_chunk_count integer;
  stored_chunk_count integer;
  legacy_record_count bigint;
  typed_record_count bigint;
  declared_record_count bigint;
BEGIN
  IF NEW.state <> 'ready' THEN
    RETURN NEW;
  END IF;

  BEGIN
    document := NEW.manifest_json::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
  END;

  IF jsonb_typeof(document) <> 'object'
     OR jsonb_typeof(document -> 'chunks') <> 'array'
     OR document ->> 'day' IS DISTINCT FROM to_char(NEW.chunk_day, 'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
  END IF;

  declared_chunk_count := jsonb_array_length(document -> 'chunks');
  SELECT count(*)::integer, COALESCE(sum(record_count), 0)::bigint
    INTO stored_chunk_count, declared_record_count
    FROM telemetry_v12_chunks WHERE manifest_id = NEW.id;
  IF declared_chunk_count <> NEW.expected_chunk_count
     OR stored_chunk_count <> NEW.expected_chunk_count THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
  END IF;

  -- Compare both directions so extra stored chunks and duplicate/missing
  -- manifest declarations cannot be hidden by matching aggregate counts.
  IF EXISTS (
    WITH declared AS (
      SELECT chunk."chunkId" AS chunk_id,
             chunk."chunkDigest" AS chunk_digest,
             chunk."recordCount" AS record_count
        FROM jsonb_to_recordset(document -> 'chunks') AS chunk(
          "chunkId" text, "chunkDigest" text, "recordCount" integer
        )
    )
    SELECT 1
      FROM declared
      FULL JOIN (
        SELECT id, chunk_id, chunk_digest, record_count
          FROM telemetry_v12_chunks WHERE manifest_id = NEW.id
      ) stored ON stored.chunk_id = declared.chunk_id
     WHERE declared.chunk_id IS NULL OR stored.id IS NULL
        OR stored.chunk_digest IS DISTINCT FROM declared.chunk_digest
        OR stored.record_count IS DISTINCT FROM declared.record_count
  ) OR EXISTS (
    SELECT 1
      FROM telemetry_v12_chunks stored
     WHERE stored.manifest_id = NEW.id
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(document -> 'chunks') AS chunk(
             "chunkId" text, "chunkDigest" text, "recordCount" integer
           )
          WHERE chunk."chunkId" = stored.chunk_id
            AND chunk."chunkDigest" = stored.chunk_digest
            AND chunk."recordCount" = stored.record_count
       )
  ) THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO legacy_record_count
    FROM telemetry_v12_records WHERE manifest_id = NEW.id;
  SELECT count(*) INTO typed_record_count
    FROM telemetry_v12_typed_records WHERE manifest_id = NEW.id;

  IF legacy_record_count > 0 AND typed_record_count > 0 THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_mixed_storage' USING ERRCODE = '23514';
  END IF;

  -- The old raw contract remains valid when it is the sole representation.
  IF legacy_record_count > 0 THEN
    IF legacy_record_count <> declared_record_count OR EXISTS (
      SELECT 1
        FROM telemetry_v12_chunks chunk
       WHERE chunk.manifest_id = NEW.id
         AND (SELECT count(*) FROM telemetry_v12_records record
               WHERE record.manifest_id = NEW.id AND record.chunk_id = chunk.id
                 AND record.stream = chunk.stream) <> chunk.record_count
    ) OR EXISTS (
      SELECT 1
        FROM telemetry_v12_records record
        JOIN telemetry_v12_chunks chunk ON chunk.id = record.chunk_id
       WHERE record.manifest_id = NEW.id
         AND (chunk.manifest_id <> NEW.id OR record.stream <> chunk.stream)
    ) THEN
      RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- An empty day is a valid complete manifest. A nonempty day must use exactly
  -- one complete representation; typed rows require one usage/quota child or
  -- at least one session-tool child for every parent record.
  IF typed_record_count <> declared_record_count
     OR (NEW.expected_chunk_count > 0 AND typed_record_count = 0) THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM telemetry_v12_chunks chunk
      LEFT JOIN telemetry_v12_typed_records record
        ON record.manifest_id = NEW.id AND record.chunk_id = chunk.id
     WHERE chunk.manifest_id = NEW.id
     GROUP BY chunk.id, chunk.record_count, chunk.stream
    HAVING count(record.id) <> chunk.record_count
        OR count(*) FILTER (WHERE record.id IS NOT NULL AND record.stream <> chunk.stream) > 0
        OR min(record.record_index) <> 0
        OR max(record.record_index) <> chunk.record_count - 1
  ) OR EXISTS (
    SELECT 1
      FROM telemetry_v12_typed_records record
     WHERE record.manifest_id = NEW.id
       AND (
         (record.stream = 'usage' AND (
           NOT EXISTS (SELECT 1 FROM telemetry_v12_typed_usage child WHERE child.record_id = record.id)
           OR EXISTS (SELECT 1 FROM telemetry_v12_typed_quota child WHERE child.record_id = record.id)
           OR EXISTS (SELECT 1 FROM telemetry_v12_typed_session_tools child WHERE child.record_id = record.id)
         ))
         OR (record.stream = 'quota' AND (
           NOT EXISTS (SELECT 1 FROM telemetry_v12_typed_quota child WHERE child.record_id = record.id)
           OR EXISTS (SELECT 1 FROM telemetry_v12_typed_usage child WHERE child.record_id = record.id)
           OR EXISTS (SELECT 1 FROM telemetry_v12_typed_session_tools child WHERE child.record_id = record.id)
         ))
         OR (record.stream = 'session' AND (
           NOT EXISTS (SELECT 1 FROM telemetry_v12_typed_session_tools child WHERE child.record_id = record.id)
           OR EXISTS (SELECT 1 FROM telemetry_v12_typed_usage child WHERE child.record_id = record.id)
           OR EXISTS (SELECT 1 FROM telemetry_v12_typed_quota child WHERE child.record_id = record.id)
         ))
       )
  ) THEN
    RAISE EXCEPTION 'telemetry_manifest_ready_incomplete' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER telemetry_v12_manifest_ready_integrity_guard
BEFORE INSERT OR UPDATE OF state ON telemetry_v12_day_manifests
FOR EACH ROW EXECUTE FUNCTION telemetry_v12_manifest_ready_integrity_guard();
