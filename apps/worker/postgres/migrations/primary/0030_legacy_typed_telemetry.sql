-- PostgreSQL import shape for the retained typed v1 and v1.1 source family.
--
-- The D1 numeric primary keys, original opaque IDs, namespace/format-scoped
-- source_row_id values, owner/device relationships, and typed child columns
-- are preserved. typed_telemetry_dictionary is shared with migration 0025.
-- This is only a base schema: it adds no allocator, admission/proof rows,
-- publication receipts, active reader, or evidence that any source rows have
-- been transferred. Those are separate transfer and authority qualifications.

CREATE TABLE typed_telemetry_namespaces (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  original_id bytea NOT NULL UNIQUE CHECK (octet_length(original_id) BETWEEN 2 AND 257)
);

CREATE TABLE typed_telemetry_owners (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL REFERENCES typed_telemetry_namespaces(id) ON DELETE CASCADE,
  original_id bytea NOT NULL CHECK (octet_length(original_id) BETWEEN 2 AND 257),
  UNIQUE (namespace_id, original_id),
  UNIQUE (id, namespace_id)
);

CREATE TABLE typed_telemetry_devices (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  owner_id bigint NOT NULL,
  original_id bytea NOT NULL CHECK (octet_length(original_id) BETWEEN 2 AND 257),
  FOREIGN KEY (owner_id, namespace_id)
    REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, original_id),
  UNIQUE (id, namespace_id, owner_id)
);

CREATE TABLE typed_telemetry_manifests (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  owner_id bigint NOT NULL,
  device_id bigint NOT NULL,
  original_id bytea NOT NULL CHECK (octet_length(original_id) BETWEEN 2 AND 257),
  chunk_day integer NOT NULL CHECK (chunk_day BETWEEN -100000 AND 100000),
  FOREIGN KEY (device_id, namespace_id, owner_id)
    REFERENCES typed_telemetry_devices(id, namespace_id, owner_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, original_id),
  UNIQUE (id, namespace_id, owner_id, device_id)
);

-- The D1 v1 and v1.1 admission databases each carry one participant-to-typed
-- owner mapping. Keep the source format in the key because the two formats
-- have independent namespaces and owner history. This mapping is source
-- identity only: the optional storage_v11_owner_links row is a separate
-- erasure authority. Some valid v1.1 memberships have no owner link, and no
-- digest is inferred for them.
CREATE TABLE typed_telemetry_owner_memberships (
  namespace_id bigint NOT NULL,
  source_format smallint NOT NULL CHECK (source_format IN (10, 11)),
  owner_id bigint NOT NULL,
  -- These RESTRICT edges intentionally stop participant/owner erasure while
  -- typed source rows still depend on the mapping. A later explicit erasure
  -- adapter must remove the typed family in dependency order first.
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE RESTRICT,
  source_namespace text NOT NULL CHECK (length(source_namespace) BETWEEN 1 AND 256),
  PRIMARY KEY (namespace_id, source_format, owner_id),
  UNIQUE (source_format, participant_id),
  FOREIGN KEY (owner_id, namespace_id)
    REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE RESTRICT
);
CREATE INDEX typed_telemetry_owner_memberships_participant
  ON typed_telemetry_owner_memberships(participant_id, source_format);

-- The owner link is the optional authority map from a typed participant to an
-- erasure digest. Keep it while typed memberships still depend on it; otherwise
-- a successful terminal delete would discard the only digest-to-participant
-- bridge needed by the later explicit typed-family cleanup.
CREATE FUNCTION typed_telemetry_owner_link_retention_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- A direct link delete while the participant row still exists would erase
  -- the only authority bridge and could race a new source membership. The
  -- participant FK cascade is the one allowed path: its parent row is gone by
  -- the time this child trigger runs.
  IF EXISTS (
    SELECT 1 FROM participants participant WHERE participant.id = OLD.participant_id
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_owner_link_retained' USING ERRCODE = 'P1005';
  END IF;
  IF EXISTS (
    SELECT 1 FROM typed_telemetry_owner_memberships membership
     WHERE membership.participant_id = OLD.participant_id
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_owner_link_retained' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER typed_telemetry_owner_link_delete_guard
  BEFORE DELETE ON storage_v11_owner_links
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_owner_link_retention_guard();

CREATE TABLE typed_telemetry_chunks (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  format smallint NOT NULL CHECK (format IN (10, 11)),
  owner_id bigint NOT NULL,
  device_id bigint NOT NULL,
  manifest_id bigint,
  original_id bytea NOT NULL CHECK (octet_length(original_id) BETWEEN 2 AND 257),
  stream smallint NOT NULL CHECK (stream IN (1, 2, 3)),
  chunk_day integer NOT NULL CHECK (chunk_day BETWEEN -100000 AND 100000),
  CHECK ((format = 10 AND manifest_id IS NULL) OR (format = 11 AND manifest_id IS NOT NULL)),
  FOREIGN KEY (namespace_id, format, owner_id)
    REFERENCES typed_telemetry_owner_memberships(namespace_id, source_format, owner_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (device_id, namespace_id, owner_id)
    REFERENCES typed_telemetry_devices(id, namespace_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (manifest_id, namespace_id, owner_id, device_id)
    REFERENCES typed_telemetry_manifests(id, namespace_id, owner_id, device_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, format, original_id),
  UNIQUE (id, namespace_id, format, owner_id, device_id, stream),
  UNIQUE (id, namespace_id, format, owner_id, device_id, stream, manifest_id)
);
CREATE INDEX typed_telemetry_chunks_owner_day
  ON typed_telemetry_chunks(namespace_id, format, owner_id, chunk_day, stream, id);

CREATE FUNCTION typed_telemetry_chunk_manifest_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.format = 11 AND NOT EXISTS (
    SELECT 1 FROM typed_telemetry_manifests manifest
     WHERE manifest.id = NEW.manifest_id
       AND manifest.namespace_id = NEW.namespace_id
       AND manifest.owner_id = NEW.owner_id
       AND manifest.device_id = NEW.device_id
       AND manifest.chunk_day = NEW.chunk_day
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_membership_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_telemetry_chunk_manifest_membership_guard
  BEFORE INSERT ON typed_telemetry_chunks
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_chunk_manifest_guard();

-- Shared VALUES, not capture identity. IDs and values are copied from the
-- source; this migration deliberately reuses the v1.2 dictionary from 0025.
CREATE TABLE typed_telemetry_identifiers (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  owner_id bigint NOT NULL,
  value bytea NOT NULL CHECK (octet_length(value) BETWEEN 2 AND 257),
  FOREIGN KEY (owner_id, namespace_id)
    REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, owner_id, value),
  UNIQUE (id, namespace_id, owner_id)
);

CREATE TABLE typed_telemetry_attributions (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  owner_id bigint NOT NULL,
  account_basis smallint NOT NULL CHECK (account_basis BETWEEN 0 AND 2),
  account_track bytea NOT NULL,
  plan_basis smallint NOT NULL CHECK (plan_basis BETWEEN 0 AND 3),
  plan_type_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  plan_era bytea NOT NULL,
  CHECK ((account_basis = 0 AND octet_length(account_track) = 0)
    OR (account_basis <> 0 AND octet_length(account_track) BETWEEN 2 AND 257)),
  CHECK (octet_length(plan_era) = 0 OR octet_length(plan_era) BETWEEN 2 AND 257),
  CHECK (plan_basis IN (1, 2) OR octet_length(plan_era) = 0),
  FOREIGN KEY (owner_id, namespace_id)
    REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, owner_id, account_basis, account_track, plan_basis, plan_type_id, plan_era),
  UNIQUE (id, namespace_id, owner_id)
);

CREATE TABLE typed_telemetry_quota_dimensions (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  owner_id bigint NOT NULL,
  plan_type_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  plan_variant_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  attribution_id bigint,
  FOREIGN KEY (owner_id, namespace_id)
    REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  FOREIGN KEY (attribution_id, namespace_id, owner_id)
    REFERENCES typed_telemetry_attributions(id, namespace_id, owner_id),
  UNIQUE (id, namespace_id, owner_id)
);
CREATE UNIQUE INDEX typed_telemetry_quota_dimensions_identity
  ON typed_telemetry_quota_dimensions(
    namespace_id, owner_id, plan_type_id, plan_variant_id, coalesce(attribution_id, 0)
  );

CREATE TABLE typed_telemetry_records (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  namespace_id bigint NOT NULL,
  format smallint NOT NULL CHECK (format IN (10, 11)),
  source_row_id bigint NOT NULL CHECK (source_row_id BETWEEN 1 AND 9007199254740991),
  owner_id bigint NOT NULL,
  device_id bigint NOT NULL,
  chunk_id bigint NOT NULL,
  manifest_id bigint,
  stream smallint NOT NULL CHECK (stream IN (1, 2, 3)),
  occurrence_id bytea NOT NULL CHECK (octet_length(occurrence_id) BETWEEN 2 AND 257),
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  observed_day integer NOT NULL CHECK (observed_day BETWEEN -100000 AND 100000
    AND observed_day = (observed_at_ms / 86400000
      - CASE WHEN observed_at_ms < 0 AND mod(observed_at_ms, 86400000) <> 0 THEN 1 ELSE 0 END)),
  provider_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  canonical_digest bytea NOT NULL CHECK (octet_length(canonical_digest) = 32),
  CHECK ((format = 10 AND manifest_id IS NULL) OR (format = 11 AND manifest_id IS NOT NULL)),
  FOREIGN KEY (namespace_id, format, owner_id)
    REFERENCES typed_telemetry_owner_memberships(namespace_id, source_format, owner_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (chunk_id, namespace_id, format, owner_id, device_id, stream)
    REFERENCES typed_telemetry_chunks(id, namespace_id, format, owner_id, device_id, stream)
    ON DELETE CASCADE,
  FOREIGN KEY (chunk_id, namespace_id, format, owner_id, device_id, stream, manifest_id)
    REFERENCES typed_telemetry_chunks(id, namespace_id, format, owner_id, device_id, stream, manifest_id)
    ON DELETE CASCADE,
  FOREIGN KEY (manifest_id, namespace_id, owner_id, device_id)
    REFERENCES typed_telemetry_manifests(id, namespace_id, owner_id, device_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, format, source_row_id),
  UNIQUE (chunk_id, occurrence_id),
  UNIQUE (id, stream)
);
CREATE UNIQUE INDEX typed_telemetry_v1_occurrence
  ON typed_telemetry_records(device_id, stream, occurrence_id) WHERE format = 10;
CREATE UNIQUE INDEX typed_telemetry_v11_occurrence
  ON typed_telemetry_records(manifest_id, stream, occurrence_id) WHERE format = 11;
CREATE INDEX typed_telemetry_owner_time
  ON typed_telemetry_records(owner_id, stream, observed_at_ms, format, source_row_id);
CREATE INDEX typed_telemetry_day ON typed_telemetry_records(observed_day, stream);

CREATE FUNCTION typed_telemetry_record_day_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM typed_telemetry_chunks chunk
     WHERE chunk.id = NEW.chunk_id
       AND chunk.namespace_id = NEW.namespace_id
       AND chunk.format = NEW.format
       AND chunk.owner_id = NEW.owner_id
       AND chunk.device_id = NEW.device_id
       AND chunk.stream = NEW.stream
       AND chunk.chunk_day = NEW.observed_day
       AND chunk.manifest_id IS NOT DISTINCT FROM NEW.manifest_id
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_membership_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_telemetry_record_day_membership_guard
  BEFORE INSERT ON typed_telemetry_records
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_record_day_guard();

CREATE TABLE typed_telemetry_usage (
  record_id bigint PRIMARY KEY,
  stream smallint NOT NULL DEFAULT 1 CHECK (stream = 1),
  session_id bigint NOT NULL REFERENCES typed_telemetry_identifiers(id),
  model_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  speed_mode_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  api_service_tier_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  surface_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  billing_surface_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  reasoning_effort_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  agent_scope_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  outcome_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  attribution_id bigint REFERENCES typed_telemetry_attributions(id),
  total_input_context_tokens bigint CHECK (total_input_context_tokens BETWEEN 0 AND 1000000000000),
  input_uncached_tokens bigint CHECK (input_uncached_tokens BETWEEN 0 AND 1000000000000),
  input_cache_read_tokens bigint CHECK (input_cache_read_tokens BETWEEN 0 AND 1000000000000),
  input_cache_write_tokens bigint CHECK (input_cache_write_tokens BETWEEN 0 AND 1000000000000),
  output_text_tokens bigint CHECK (output_text_tokens BETWEEN 0 AND 1000000000000),
  output_reasoning_tokens bigint CHECK (output_reasoning_tokens BETWEEN 0 AND 1000000000000),
  output_combined_tokens bigint CHECK (output_combined_tokens BETWEEN 0 AND 1000000000000),
  FOREIGN KEY (record_id, stream) REFERENCES typed_telemetry_records(id, stream) ON DELETE CASCADE
);

CREATE TABLE typed_telemetry_quota (
  record_id bigint PRIMARY KEY,
  stream smallint NOT NULL DEFAULT 2 CHECK (stream = 2),
  dimensions_id bigint NOT NULL REFERENCES typed_telemetry_quota_dimensions(id),
  limit_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  slot_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  used_percent double precision CHECK (used_percent BETWEEN 0 AND 100),
  window_duration_minutes integer CHECK (window_duration_minutes BETWEEN 1 AND 527040),
  resets_at_ms bigint CHECK (resets_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  FOREIGN KEY (record_id, stream) REFERENCES typed_telemetry_records(id, stream) ON DELETE CASCADE
);

CREATE TABLE typed_telemetry_session_tools (
  record_id bigint NOT NULL,
  stream smallint NOT NULL DEFAULT 3 CHECK (stream = 3),
  tool_class_id bigint NOT NULL REFERENCES typed_telemetry_dictionary(id),
  count bigint NOT NULL CHECK (count BETWEEN 0 AND 1000000000),
  FOREIGN KEY (record_id, stream) REFERENCES typed_telemetry_records(id, stream) ON DELETE CASCADE,
  PRIMARY KEY (record_id, tool_class_id)
);

-- D1 enforces these row scopes with insert triggers. Composite foreign keys
-- enforce parent/chunk/format/owner lineage here; child-specific owner scope
-- and format-10/11 attribution rules are checked below.
CREATE FUNCTION typed_telemetry_child_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE valid_membership boolean;
BEGIN
  IF TG_TABLE_NAME = 'typed_telemetry_usage' THEN
    SELECT EXISTS (
      SELECT 1
        FROM typed_telemetry_records record
        JOIN typed_telemetry_identifiers identifier
          ON identifier.id = NEW.session_id
         AND identifier.namespace_id = record.namespace_id
         AND identifier.owner_id = record.owner_id
        LEFT JOIN typed_telemetry_attributions attribution
          ON attribution.id = NEW.attribution_id
         AND attribution.namespace_id = record.namespace_id
         AND attribution.owner_id = record.owner_id
       WHERE record.id = NEW.record_id
         AND ((record.format = 10 AND NEW.attribution_id IS NULL)
           OR (record.format = 11 AND NEW.attribution_id IS NOT NULL AND attribution.id IS NOT NULL))
    ) INTO valid_membership;
  ELSIF TG_TABLE_NAME = 'typed_telemetry_quota' THEN
    SELECT EXISTS (
      SELECT 1
        FROM typed_telemetry_records record
        JOIN typed_telemetry_quota_dimensions dimensions
          ON dimensions.id = NEW.dimensions_id
         AND dimensions.namespace_id = record.namespace_id
         AND dimensions.owner_id = record.owner_id
        LEFT JOIN typed_telemetry_attributions attribution
          ON attribution.id = dimensions.attribution_id
         AND attribution.namespace_id = record.namespace_id
         AND attribution.owner_id = record.owner_id
       WHERE record.id = NEW.record_id
         AND ((record.format = 10 AND dimensions.attribution_id IS NULL
           AND NEW.used_percent IS NOT NULL AND NEW.window_duration_minutes IS NOT NULL
           AND NEW.resets_at_ms IS NOT NULL)
           OR (record.format = 11 AND dimensions.attribution_id IS NOT NULL
             AND attribution.id IS NOT NULL))
    ) INTO valid_membership;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM typed_telemetry_records record
       WHERE record.id = NEW.record_id AND record.stream = 3
    ) INTO valid_membership;
  END IF;
  IF NOT valid_membership THEN
    RAISE EXCEPTION 'typed_telemetry_membership_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_telemetry_usage_membership_guard
  BEFORE INSERT ON typed_telemetry_usage
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_child_membership_guard();
CREATE TRIGGER typed_telemetry_quota_membership_guard
  BEFORE INSERT ON typed_telemetry_quota
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_child_membership_guard();
CREATE TRIGGER typed_telemetry_session_membership_guard
  BEFORE INSERT ON typed_telemetry_session_tools
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_child_membership_guard();

CREATE FUNCTION typed_telemetry_owner_membership_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_state text;
BEGIN
  -- Source membership is identity, not publication or erasure authority. A
  -- linkless active participant is valid; an existing withdrawn/erased link
  -- cannot acquire a new mapping. Lock participant before owner to serialize
  -- the mapping with participant erasure.
  PERFORM 1 FROM participants participant
   WHERE participant.id = NEW.participant_id AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'typed_telemetry_owner_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  SELECT owner_link.state INTO owner_state
    FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = NEW.participant_id
   FOR UPDATE;
  IF FOUND AND owner_state <> 'active' THEN
    RAISE EXCEPTION 'typed_telemetry_owner_membership_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER typed_telemetry_owner_membership_insert_guard
  BEFORE INSERT ON typed_telemetry_owner_memberships
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_owner_membership_guard();
CREATE FUNCTION typed_telemetry_source_owner_retention_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  namespace_value bigint;
  owner_value bigint;
  format_value smallint;
BEGIN
  IF TG_TABLE_NAME = 'typed_telemetry_owner_memberships' THEN
    namespace_value := OLD.namespace_id;
    owner_value := OLD.owner_id;
    format_value := OLD.source_format;
  ELSIF TG_TABLE_NAME = 'typed_telemetry_owners' THEN
    namespace_value := OLD.namespace_id;
    owner_value := OLD.id;
  ELSIF TG_TABLE_NAME IN ('typed_telemetry_devices', 'typed_telemetry_manifests',
      'typed_telemetry_chunks', 'typed_telemetry_records', 'typed_telemetry_identifiers',
      'typed_telemetry_attributions', 'typed_telemetry_quota_dimensions') THEN
    namespace_value := OLD.namespace_id;
    owner_value := OLD.owner_id;
    IF TG_TABLE_NAME = 'typed_telemetry_chunks' OR TG_TABLE_NAME = 'typed_telemetry_records' THEN
      format_value := OLD.format;
    END IF;
  ELSE
    SELECT record.namespace_id, record.owner_id, record.format
      INTO namespace_value, owner_value, format_value
      FROM typed_telemetry_records record WHERE record.id = OLD.record_id;
  END IF;

  IF namespace_value IS NULL OR owner_value IS NULL THEN
    RETURN OLD;
  END IF;

  -- Shared source rows can be referenced by v1 and v1.1 memberships at once.
  -- Require terminal proof for every applicable membership; one linked format
  -- must not authorize deletion of a linkless or still-live sibling format.
  IF EXISTS (
    SELECT 1
      FROM typed_telemetry_owner_memberships membership
      LEFT JOIN storage_v11_owner_links owner_link
        ON owner_link.participant_id = membership.participant_id
      LEFT JOIN storage_owner_erasure_receipts receipt
        ON receipt.owner_digest = owner_link.owner_digest
     WHERE membership.namespace_id = namespace_value
       AND membership.owner_id = owner_value
       AND (format_value IS NULL OR membership.source_format = format_value)
       AND (owner_link.owner_digest IS NULL OR owner_link.state <> 'erased'
         OR receipt.owner_digest IS NULL)
  ) THEN
    RAISE EXCEPTION 'typed_telemetry_source_retained' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER typed_telemetry_owner_membership_delete_guard
  BEFORE DELETE ON typed_telemetry_owner_memberships
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_namespace_owner_delete_guard
  BEFORE DELETE ON typed_telemetry_owners
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_device_delete_guard
  BEFORE DELETE ON typed_telemetry_devices
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_manifest_delete_guard
  BEFORE DELETE ON typed_telemetry_manifests
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_chunk_delete_guard
  BEFORE DELETE ON typed_telemetry_chunks
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_record_delete_guard
  BEFORE DELETE ON typed_telemetry_records
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_identifier_delete_guard
  BEFORE DELETE ON typed_telemetry_identifiers
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_attribution_delete_guard
  BEFORE DELETE ON typed_telemetry_attributions
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_quota_dimensions_delete_guard
  BEFORE DELETE ON typed_telemetry_quota_dimensions
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_usage_delete_guard
  BEFORE DELETE ON typed_telemetry_usage
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_quota_delete_guard
  BEFORE DELETE ON typed_telemetry_quota
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();
CREATE TRIGGER typed_telemetry_session_delete_guard
  BEFORE DELETE ON typed_telemetry_session_tools
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_owner_retention_guard();

CREATE FUNCTION typed_telemetry_source_row_immutable()
RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'typed_telemetry_source_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER typed_telemetry_namespace_immutable BEFORE UPDATE ON typed_telemetry_namespaces
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_owner_membership_immutable BEFORE UPDATE ON typed_telemetry_owner_memberships
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_owner_immutable BEFORE UPDATE ON typed_telemetry_owners
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_device_immutable BEFORE UPDATE ON typed_telemetry_devices
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_manifest_immutable BEFORE UPDATE ON typed_telemetry_manifests
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_chunk_immutable BEFORE UPDATE ON typed_telemetry_chunks
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_identifier_immutable BEFORE UPDATE ON typed_telemetry_identifiers
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_attribution_immutable BEFORE UPDATE ON typed_telemetry_attributions
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_quota_dimensions_immutable BEFORE UPDATE ON typed_telemetry_quota_dimensions
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_record_immutable BEFORE UPDATE ON typed_telemetry_records
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_usage_immutable BEFORE UPDATE ON typed_telemetry_usage
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_quota_immutable BEFORE UPDATE ON typed_telemetry_quota
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
CREATE TRIGGER typed_telemetry_session_immutable BEFORE UPDATE ON typed_telemetry_session_tools
  FOR EACH ROW EXECUTE FUNCTION typed_telemetry_source_row_immutable();
