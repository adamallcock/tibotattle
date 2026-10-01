-- NEW target database only. This is a storage foundation, not upload authority:
-- consent, credentials, activation, retention and routing are separate owners.
-- No JSON payload, original source row, or source-version membership is discarded.
CREATE TABLE typed_telemetry_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version = 1)
) STRICT;
INSERT INTO typed_telemetry_schema (id, version) VALUES (1, 1);

CREATE TABLE typed_telemetry_namespaces (
  id INTEGER PRIMARY KEY,
  original_id BLOB NOT NULL UNIQUE CHECK (length(original_id) BETWEEN 2 AND 257)
) STRICT;
CREATE TABLE typed_telemetry_owners (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL REFERENCES typed_telemetry_namespaces(id),
  original_id BLOB NOT NULL CHECK (length(original_id) BETWEEN 2 AND 257),
  UNIQUE (namespace_id, original_id),
  UNIQUE (id, namespace_id)
) STRICT;
CREATE TABLE typed_telemetry_devices (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  original_id BLOB NOT NULL CHECK (length(original_id) BETWEEN 2 AND 257),
  FOREIGN KEY (owner_id, namespace_id) REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, original_id),
  UNIQUE (id, namespace_id, owner_id)
) STRICT;
CREATE TABLE typed_telemetry_manifests (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  original_id BLOB NOT NULL CHECK (length(original_id) BETWEEN 2 AND 257),
  chunk_day INTEGER NOT NULL,
  FOREIGN KEY (device_id, namespace_id, owner_id) REFERENCES typed_telemetry_devices(id, namespace_id, owner_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, original_id),
  UNIQUE (id, namespace_id, owner_id, device_id)
) STRICT;
CREATE TABLE typed_telemetry_chunks (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  format INTEGER NOT NULL CHECK (format IN (10, 11)),
  owner_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  manifest_id INTEGER,
  original_id BLOB NOT NULL CHECK (length(original_id) BETWEEN 2 AND 257),
  stream INTEGER NOT NULL CHECK (stream IN (1, 2, 3)),
  chunk_day INTEGER NOT NULL,
  CHECK ((format = 10 AND manifest_id IS NULL) OR (format = 11 AND manifest_id IS NOT NULL)),
  FOREIGN KEY (device_id, namespace_id, owner_id) REFERENCES typed_telemetry_devices(id, namespace_id, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (manifest_id, namespace_id, owner_id, device_id) REFERENCES typed_telemetry_manifests(id, namespace_id, owner_id, device_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, format, original_id),
  UNIQUE (id, namespace_id, format, owner_id, device_id, stream)
) STRICT;

-- Dictionary values preserve admitted unknown/future bounded tokens exactly;
-- these integers are internal storage keys, not wire enum ordinals.
CREATE TABLE typed_telemetry_dictionary (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL UNIQUE CHECK (length(value) BETWEEN 1 AND 64)
) STRICT;
CREATE TABLE typed_telemetry_identifiers (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  value BLOB NOT NULL CHECK (length(value) BETWEEN 2 AND 257),
  FOREIGN KEY (owner_id, namespace_id) REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, owner_id, value)
) STRICT;
CREATE TABLE typed_telemetry_attributions (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  account_basis INTEGER NOT NULL CHECK (account_basis BETWEEN 0 AND 2),
  account_track BLOB NOT NULL,
  plan_basis INTEGER NOT NULL CHECK (plan_basis BETWEEN 0 AND 3),
  plan_type_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  plan_era BLOB NOT NULL,
  CHECK ((account_basis = 0 AND length(account_track) = 0) OR (account_basis != 0 AND length(account_track) BETWEEN 2 AND 257)),
  CHECK (length(plan_era) = 0 OR length(plan_era) BETWEEN 2 AND 257),
  CHECK (plan_basis IN (1, 2) OR length(plan_era) = 0),
  FOREIGN KEY (owner_id, namespace_id) REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, owner_id, account_basis, account_track, plan_basis, plan_type_id, plan_era),
  UNIQUE (id, namespace_id, owner_id)
) STRICT;

-- Shared VALUES, not a claim of common capture identity. Every reading keeps
-- its own occurrence, timestamp, NULL values and original chunk/manifest below.
CREATE TABLE typed_telemetry_quota_dimensions (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  plan_type_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  plan_variant_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  attribution_id INTEGER,
  FOREIGN KEY (owner_id, namespace_id) REFERENCES typed_telemetry_owners(id, namespace_id) ON DELETE CASCADE,
  FOREIGN KEY (attribution_id, namespace_id, owner_id) REFERENCES typed_telemetry_attributions(id, namespace_id, owner_id)
) STRICT;
CREATE UNIQUE INDEX typed_telemetry_quota_dimensions_identity
  ON typed_telemetry_quota_dimensions(namespace_id, owner_id, plan_type_id, plan_variant_id, coalesce(attribution_id, 0));

CREATE TABLE typed_telemetry_records (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL,
  format INTEGER NOT NULL CHECK (format IN (10, 11)),
  source_row_id INTEGER NOT NULL CHECK (source_row_id BETWEEN 1 AND 9007199254740991),
  owner_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  chunk_id INTEGER NOT NULL,
  manifest_id INTEGER,
  stream INTEGER NOT NULL CHECK (stream IN (1, 2, 3)),
  occurrence_id BLOB NOT NULL CHECK (length(occurrence_id) BETWEEN 2 AND 257),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  observed_day INTEGER NOT NULL,
  provider_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  canonical_digest BLOB NOT NULL CHECK (length(canonical_digest) = 32),
  CHECK ((format = 10 AND manifest_id IS NULL) OR (format = 11 AND manifest_id IS NOT NULL)),
  FOREIGN KEY (chunk_id, namespace_id, format, owner_id, device_id, stream)
    REFERENCES typed_telemetry_chunks(id, namespace_id, format, owner_id, device_id, stream) ON DELETE CASCADE,
  FOREIGN KEY (manifest_id, namespace_id, owner_id, device_id)
    REFERENCES typed_telemetry_manifests(id, namespace_id, owner_id, device_id) ON DELETE CASCADE,
  UNIQUE (namespace_id, format, source_row_id),
  UNIQUE (chunk_id, occurrence_id),
  UNIQUE (id, stream)
) STRICT;
-- Same scoped duplicate rules as the retained v1 and v1.1 source tables. This
-- raw layer does not decide which revision/device/domain is currently active.
CREATE UNIQUE INDEX typed_telemetry_v1_occurrence
  ON typed_telemetry_records(device_id, stream, occurrence_id) WHERE format = 10;
CREATE UNIQUE INDEX typed_telemetry_v11_occurrence
  ON typed_telemetry_records(manifest_id, stream, occurrence_id) WHERE format = 11;
CREATE INDEX typed_telemetry_owner_time
  ON typed_telemetry_records(owner_id, stream, observed_at_ms, format, source_row_id);
CREATE INDEX typed_telemetry_day ON typed_telemetry_records(observed_day, stream);

CREATE TABLE typed_telemetry_usage (
  record_id INTEGER PRIMARY KEY,
  stream INTEGER NOT NULL DEFAULT 1 CHECK (stream = 1),
  session_id INTEGER NOT NULL REFERENCES typed_telemetry_identifiers(id),
  model_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  speed_mode_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  api_service_tier_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  surface_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  billing_surface_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  reasoning_effort_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  agent_scope_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  outcome_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  attribution_id INTEGER REFERENCES typed_telemetry_attributions(id),
  total_input_context_tokens INTEGER CHECK (total_input_context_tokens BETWEEN 0 AND 1000000000000),
  input_uncached_tokens INTEGER CHECK (input_uncached_tokens BETWEEN 0 AND 1000000000000),
  input_cache_read_tokens INTEGER CHECK (input_cache_read_tokens BETWEEN 0 AND 1000000000000),
  input_cache_write_tokens INTEGER CHECK (input_cache_write_tokens BETWEEN 0 AND 1000000000000),
  output_text_tokens INTEGER CHECK (output_text_tokens BETWEEN 0 AND 1000000000000),
  output_reasoning_tokens INTEGER CHECK (output_reasoning_tokens BETWEEN 0 AND 1000000000000),
  output_combined_tokens INTEGER CHECK (output_combined_tokens BETWEEN 0 AND 1000000000000),
  FOREIGN KEY (record_id, stream) REFERENCES typed_telemetry_records(id, stream) ON DELETE CASCADE
) STRICT;
CREATE TABLE typed_telemetry_quota (
  record_id INTEGER PRIMARY KEY,
  stream INTEGER NOT NULL DEFAULT 2 CHECK (stream = 2),
  dimensions_id INTEGER NOT NULL REFERENCES typed_telemetry_quota_dimensions(id),
  limit_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  slot_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  used_percent REAL CHECK (used_percent BETWEEN 0 AND 100),
  window_duration_minutes INTEGER CHECK (window_duration_minutes BETWEEN 1 AND 527040),
  resets_at_ms INTEGER CHECK (resets_at_ms BETWEEN -8640000000000000 AND 8640000000000000),
  FOREIGN KEY (record_id, stream) REFERENCES typed_telemetry_records(id, stream) ON DELETE CASCADE
) STRICT;
CREATE TABLE typed_telemetry_session_tools (
  record_id INTEGER NOT NULL,
  stream INTEGER NOT NULL DEFAULT 3 CHECK (stream = 3),
  tool_class_id INTEGER NOT NULL REFERENCES typed_telemetry_dictionary(id),
  count INTEGER NOT NULL CHECK (count BETWEEN 0 AND 1000000000),
  FOREIGN KEY (record_id, stream) REFERENCES typed_telemetry_records(id, stream) ON DELETE CASCADE,
  PRIMARY KEY (record_id, tool_class_id)
) STRICT;

CREATE TRIGGER typed_telemetry_manifest_membership BEFORE INSERT ON typed_telemetry_chunks
WHEN NEW.format = 11 AND NOT EXISTS (
  SELECT 1 FROM typed_telemetry_manifests m WHERE m.id = NEW.manifest_id
    AND m.namespace_id = NEW.namespace_id AND m.owner_id = NEW.owner_id
    AND m.device_id = NEW.device_id AND m.chunk_day = NEW.chunk_day
)
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_membership_conflict'); END;
-- Every prepared batch inserts/replays its namespace. This guard runs inside
-- that batch, so a missing/newer layout rolls back earlier dictionary writes.
CREATE TRIGGER typed_telemetry_schema_admission BEFORE INSERT ON typed_telemetry_namespaces
WHEN NOT EXISTS (SELECT 1 FROM typed_telemetry_schema WHERE id = 1 AND version = 1)
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_schema_incompatible'); END;
CREATE TRIGGER typed_telemetry_record_membership BEFORE INSERT ON typed_telemetry_records
WHEN NOT EXISTS (
  SELECT 1 FROM typed_telemetry_chunks c WHERE c.id = NEW.chunk_id
    AND c.namespace_id = NEW.namespace_id AND c.format = NEW.format
    AND c.owner_id = NEW.owner_id AND c.device_id = NEW.device_id
    AND c.stream = NEW.stream AND c.manifest_id IS NEW.manifest_id
)
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_membership_conflict'); END;
CREATE TRIGGER typed_telemetry_usage_attribution BEFORE INSERT ON typed_telemetry_usage
WHEN NOT EXISTS (
  SELECT 1 FROM typed_telemetry_records r
    JOIN typed_telemetry_identifiers i ON i.id = NEW.session_id AND i.namespace_id = r.namespace_id AND i.owner_id = r.owner_id
    LEFT JOIN typed_telemetry_attributions a ON a.id = NEW.attribution_id
    WHERE r.id = NEW.record_id
    AND ((r.format = 10 AND NEW.attribution_id IS NULL) OR (r.format = 11 AND NEW.attribution_id IS NOT NULL))
    AND (NEW.attribution_id IS NULL OR (a.namespace_id = r.namespace_id AND a.owner_id = r.owner_id))
)
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_membership_conflict'); END;
CREATE TRIGGER typed_telemetry_quota_attribution BEFORE INSERT ON typed_telemetry_quota
WHEN NOT EXISTS (
  SELECT 1 FROM typed_telemetry_records r JOIN typed_telemetry_quota_dimensions d ON d.id = NEW.dimensions_id
    AND d.namespace_id = r.namespace_id AND d.owner_id = r.owner_id
    WHERE r.id = NEW.record_id
      AND ((r.format = 10 AND d.attribution_id IS NULL AND NEW.used_percent IS NOT NULL
        AND NEW.window_duration_minutes IS NOT NULL AND NEW.resets_at_ms IS NOT NULL)
        OR (r.format = 11 AND d.attribution_id IS NOT NULL))
)
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_membership_conflict'); END;

-- Upserts may replay identical values; changing immutable evidence or moving
-- a parent between owners aborts the entire caller's batch, including its journal.
CREATE TRIGGER typed_telemetry_namespace_immutable BEFORE UPDATE ON typed_telemetry_namespaces
WHEN NEW.id IS NOT OLD.id OR NEW.original_id IS NOT OLD.original_id
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_owner_immutable BEFORE UPDATE ON typed_telemetry_owners
WHEN NEW.id IS NOT OLD.id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.original_id IS NOT OLD.original_id
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_device_immutable BEFORE UPDATE ON typed_telemetry_devices
WHEN NEW.id IS NOT OLD.id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.original_id IS NOT OLD.original_id OR NEW.owner_id IS NOT OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_manifest_immutable BEFORE UPDATE ON typed_telemetry_manifests
WHEN NEW.id IS NOT OLD.id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.original_id IS NOT OLD.original_id
  OR NEW.owner_id IS NOT OLD.owner_id OR NEW.device_id IS NOT OLD.device_id OR NEW.chunk_day IS NOT OLD.chunk_day
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_chunk_immutable BEFORE UPDATE ON typed_telemetry_chunks
WHEN NEW.id IS NOT OLD.id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.original_id IS NOT OLD.original_id
  OR NEW.format IS NOT OLD.format OR NEW.owner_id IS NOT OLD.owner_id OR NEW.device_id IS NOT OLD.device_id
  OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.stream IS NOT OLD.stream OR NEW.chunk_day IS NOT OLD.chunk_day
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_record_immutable BEFORE UPDATE ON typed_telemetry_records
WHEN NEW.id IS NOT OLD.id OR NEW.namespace_id IS NOT OLD.namespace_id OR NEW.format IS NOT OLD.format
  OR NEW.source_row_id IS NOT OLD.source_row_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.device_id IS NOT OLD.device_id
  OR NEW.chunk_id IS NOT OLD.chunk_id OR NEW.manifest_id IS NOT OLD.manifest_id OR NEW.stream IS NOT OLD.stream
  OR NEW.occurrence_id IS NOT OLD.occurrence_id OR NEW.observed_at_ms IS NOT OLD.observed_at_ms
  OR NEW.observed_day IS NOT OLD.observed_day OR NEW.provider_id IS NOT OLD.provider_id OR NEW.canonical_digest IS NOT OLD.canonical_digest
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_dictionary_immutable BEFORE UPDATE ON typed_telemetry_dictionary
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_identifiers_immutable BEFORE UPDATE ON typed_telemetry_identifiers
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_attributions_immutable BEFORE UPDATE ON typed_telemetry_attributions
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_quota_dimensions_immutable BEFORE UPDATE ON typed_telemetry_quota_dimensions
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_usage_immutable BEFORE UPDATE ON typed_telemetry_usage
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_quota_immutable BEFORE UPDATE ON typed_telemetry_quota
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
CREATE TRIGGER typed_telemetry_session_tools_immutable BEFORE UPDATE ON typed_telemetry_session_tools
BEGIN SELECT RAISE(ABORT, 'typed_telemetry_identity_conflict'); END;
