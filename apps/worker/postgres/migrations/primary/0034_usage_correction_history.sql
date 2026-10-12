-- PostgreSQL storage for the staged D1 usage-correction evidence family.
--
-- This migration retains source row IDs, typed references, owner authority,
-- occurrence bytes, counters, and cryptographic lineage exactly. The copied
-- runtime is always operationally staged; `source_state` records whether the
-- sealed D1 source was staged or active. Applying this schema or transferring
-- rows does not enable correction writes, a reader, owner erasure, or cutover.
-- Receipts below prove archived-byte parity only. Dictionary/source-reference
-- closure and semantic reconstruction remain unqualified until a reader has
-- its own authority and reference-completeness proof.

CREATE TABLE telemetry_usage_correction_runtime (
  id smallint PRIMARY KEY CHECK (id = 1),
  schema_version text NOT NULL CHECK (schema_version = 'telemetry-usage-correction-v1'),
  method_version text NOT NULL CHECK (method_version = 'usage-total-correction-v1'),
  state text NOT NULL DEFAULT 'staged' CHECK (state = 'staged'),
  source_state text NOT NULL CHECK (source_state IN ('staged', 'active')),
  max_capture_rows integer NOT NULL CHECK (max_capture_rows BETWEEN 1 AND 200),
  max_history_page integer NOT NULL CHECK (max_history_page BETWEEN 1 AND 200)
);

CREATE FUNCTION telemetry_usage_correction_runtime_retained()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'telemetry_usage_correction_runtime_retained' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER telemetry_usage_correction_runtime_immutable
  BEFORE UPDATE OR DELETE ON telemetry_usage_correction_runtime
  FOR EACH ROW EXECUTE FUNCTION telemetry_usage_correction_runtime_retained();

CREATE TABLE telemetry_usage_correction_history (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  owner_digest bytea NOT NULL CHECK (octet_length(owner_digest) = 32),
  owner_revision bigint NOT NULL CHECK (owner_revision > 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  source_format smallint NOT NULL CHECK (source_format = 10),
  namespace_id bigint NOT NULL CHECK (namespace_id > 0),
  owner_id bigint NOT NULL CHECK (owner_id > 0),
  device_id bigint NOT NULL CHECK (device_id > 0),
  chunk_id bigint NOT NULL CHECK (chunk_id > 0),
  manifest_id bigint CHECK (manifest_id IS NULL OR manifest_id > 0),
  source_storage_row_id bigint NOT NULL CHECK (source_storage_row_id BETWEEN 1 AND 9007199254740991),
  source_row_id bigint NOT NULL CHECK (source_row_id BETWEEN 1 AND 9007199254740991),
  occurrence_id bytea NOT NULL CHECK (octet_length(occurrence_id) BETWEEN 2 AND 257),
  event_time_ms bigint NOT NULL CHECK (event_time_ms BETWEEN -8640000000000000 AND 8640000000000000),
  provider_id bigint NOT NULL CHECK (provider_id > 0),
  session_id bigint NOT NULL CHECK (session_id > 0),
  model_id bigint NOT NULL CHECK (model_id > 0),
  speed_mode_id bigint NOT NULL CHECK (speed_mode_id > 0),
  api_service_tier_id bigint NOT NULL CHECK (api_service_tier_id > 0),
  surface_id bigint NOT NULL CHECK (surface_id > 0),
  billing_surface_id bigint NOT NULL CHECK (billing_surface_id > 0),
  reasoning_effort_id bigint NOT NULL CHECK (reasoning_effort_id > 0),
  agent_scope_id bigint NOT NULL CHECK (agent_scope_id > 0),
  outcome_id bigint NOT NULL CHECK (outcome_id > 0),
  attribution_id bigint,
  total_input_context_tokens bigint CHECK (total_input_context_tokens BETWEEN 0 AND 1000000000000),
  input_uncached_tokens bigint CHECK (input_uncached_tokens BETWEEN 0 AND 1000000000000),
  input_cache_read_tokens bigint CHECK (input_cache_read_tokens BETWEEN 0 AND 1000000000000),
  input_cache_write_tokens bigint CHECK (input_cache_write_tokens BETWEEN 0 AND 1000000000000),
  output_text_tokens bigint CHECK (output_text_tokens BETWEEN 0 AND 1000000000000),
  output_reasoning_tokens bigint CHECK (output_reasoning_tokens BETWEEN 0 AND 1000000000000),
  output_combined_tokens bigint CHECK (output_combined_tokens BETWEEN 0 AND 1000000000000),
  source_chunk_digest bytea NOT NULL CHECK (octet_length(source_chunk_digest) = 32),
  source_event_digest bytea NOT NULL CHECK (octet_length(source_event_digest) = 32),
  record_digest bytea NOT NULL CHECK (octet_length(record_digest) = 32),
  base_digest bytea NOT NULL CHECK (octet_length(base_digest) = 32),
  captured_at_ms bigint NOT NULL CHECK (captured_at_ms BETWEEN 0 AND 8640000000000000),
  CHECK (source_format = 10 AND manifest_id IS NULL)
);

CREATE UNIQUE INDEX telemetry_usage_correction_history_identity
  ON telemetry_usage_correction_history(
    participant_id, owner_digest, source_format, namespace_id, owner_id, device_id,
    chunk_id, coalesce(manifest_id, 0), source_chunk_digest, source_event_digest,
    source_row_id, record_digest
  );
CREATE INDEX telemetry_usage_correction_history_owner_time
  ON telemetry_usage_correction_history(owner_digest, occurrence_id, event_time_ms, id);
CREATE INDEX telemetry_usage_correction_history_source
  ON telemetry_usage_correction_history(participant_id, source_format, source_storage_row_id, id);

CREATE TABLE telemetry_usage_correction_facts (
  id bigint PRIMARY KEY CHECK (id BETWEEN 1 AND 9007199254740991),
  history_id bigint NOT NULL REFERENCES telemetry_usage_correction_history(id) ON DELETE CASCADE,
  method_version smallint NOT NULL CHECK (method_version = 1),
  captured_at_ms bigint NOT NULL CHECK (captured_at_ms BETWEEN 0 AND 8640000000000000),
  UNIQUE (history_id, method_version)
);
CREATE INDEX telemetry_usage_correction_facts_history
  ON telemetry_usage_correction_facts(history_id, id);

CREATE FUNCTION telemetry_usage_correction_history_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'telemetry_usage_correction_history_immutable' USING ERRCODE = 'P1005';
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM storage_owner_erasure_receipts receipt
     WHERE receipt.owner_digest = encode(OLD.owner_digest, 'hex')
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'telemetry_usage_correction_history_retained' USING ERRCODE = 'P1005';
    END IF;
    RETURN OLD;
  END IF;

  PERFORM 1 FROM participants participant
   WHERE participant.id = NEW.participant_id AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_usage_correction_owner_conflict' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_v11_owner_links owner_link
   WHERE owner_link.participant_id = NEW.participant_id
     AND owner_link.owner_digest = encode(NEW.owner_digest, 'hex')
     AND owner_link.state = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_usage_correction_owner_conflict' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_usage_correction_history_guard
  BEFORE INSERT OR UPDATE OR DELETE ON telemetry_usage_correction_history
  FOR EACH ROW EXECUTE FUNCTION telemetry_usage_correction_history_guard();

CREATE FUNCTION telemetry_usage_correction_fact_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  participant_value text;
  owner_digest_value bytea;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'telemetry_usage_correction_fact_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT history.participant_id, history.owner_digest
    INTO participant_value, owner_digest_value
    FROM telemetry_usage_correction_history history
   WHERE history.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.history_id ELSE NEW.history_id END;
  IF NOT FOUND THEN
    -- During an FK cascade the parent history row may already be hidden from
    -- this trigger. Its own delete guard has already proved terminal erasure.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'telemetry_usage_correction_fact_proof' USING ERRCODE = 'P1005';
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM storage_owner_erasure_receipts receipt
     WHERE receipt.owner_digest = encode(owner_digest_value, 'hex')
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'telemetry_usage_correction_fact_retained' USING ERRCODE = 'P1005';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM participants participant
   WHERE participant.id = participant_value AND participant.state = 'active'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_usage_correction_fact_proof' USING ERRCODE = 'P1005';
  END IF;
  PERFORM 1 FROM storage_v11_owner_links owner_link
   JOIN telemetry_usage_correction_history history
     ON history.participant_id = owner_link.participant_id
    AND encode(history.owner_digest, 'hex') = owner_link.owner_digest
   WHERE history.id = NEW.history_id AND owner_link.state = 'active'
   FOR UPDATE OF owner_link;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_usage_correction_fact_proof' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_usage_correction_fact_guard
  BEFORE INSERT OR UPDATE OR DELETE ON telemetry_usage_correction_facts
  FOR EACH ROW EXECUTE FUNCTION telemetry_usage_correction_fact_guard();

-- Transfer receipts contain only counts and SHA-256 digests. Per-table
-- checkpoints are committed in the same transaction as each inserted page.
CREATE TABLE postgres_usage_correction_transfer_runs (
  transfer_id text PRIMARY KEY CHECK (length(transfer_id) BETWEEN 1 AND 128),
  schema_version text NOT NULL CHECK (schema_version = 'postgres-usage-correction-transfer-v1'),
  target_schema text NOT NULL CHECK (target_schema ~ '^[a-z_][a-z0-9_]{0,62}$'),
  source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  target_manifest_sha256 text CHECK (target_manifest_sha256 IS NULL OR target_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_runtime_state text NOT NULL CHECK (source_runtime_state IN ('staged', 'active')),
  status text NOT NULL CHECK (status IN ('running', 'complete')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((status = 'running' AND completed_at IS NULL AND target_manifest_sha256 IS NULL)
    OR (status = 'complete' AND completed_at IS NOT NULL AND target_manifest_sha256 IS NOT NULL))
);

CREATE FUNCTION postgres_usage_correction_transfer_run_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  checkpoint_count integer;
  receipt_count integer;
  checkpoint_receipt_mismatch boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'usage_correction_transfer_run_retained' USING ERRCODE = 'P1005';
  END IF;
  IF OLD.status <> 'running' OR NEW.status <> 'complete'
     OR OLD.transfer_id IS DISTINCT FROM NEW.transfer_id
     OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
     OR OLD.target_schema IS DISTINCT FROM NEW.target_schema
     OR OLD.source_snapshot_sha256 IS DISTINCT FROM NEW.source_snapshot_sha256
     OR OLD.source_manifest_sha256 IS DISTINCT FROM NEW.source_manifest_sha256
     OR OLD.source_runtime_state IS DISTINCT FROM NEW.source_runtime_state
     OR OLD.started_at IS DISTINCT FROM NEW.started_at
     OR NEW.target_manifest_sha256 IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'usage_correction_transfer_run_transition_invalid' USING ERRCODE = 'P1005';
  END IF;
  SELECT count(*)::integer INTO checkpoint_count
    FROM postgres_usage_correction_transfer_checkpoints checkpoint
   WHERE checkpoint.transfer_id = OLD.transfer_id AND checkpoint.complete;
  SELECT count(*)::integer INTO receipt_count
    FROM postgres_usage_correction_transfer_table_receipts receipt
   WHERE receipt.transfer_id = OLD.transfer_id;
  SELECT EXISTS (
    SELECT 1 FROM postgres_usage_correction_transfer_checkpoints checkpoint
    JOIN postgres_usage_correction_transfer_table_receipts receipt
      ON receipt.transfer_id = checkpoint.transfer_id AND receipt.table_name = checkpoint.table_name
    WHERE checkpoint.transfer_id = OLD.transfer_id
      AND (NOT checkpoint.complete OR checkpoint.row_count <> receipt.source_row_count)
  ) INTO checkpoint_receipt_mismatch;
  IF checkpoint_count <> 3 OR receipt_count <> 3 OR checkpoint_receipt_mismatch THEN
    RAISE EXCEPTION 'usage_correction_transfer_run_incomplete' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_usage_correction_transfer_run_guard
  BEFORE UPDATE OR DELETE ON postgres_usage_correction_transfer_runs
  FOR EACH ROW EXECUTE FUNCTION postgres_usage_correction_transfer_run_guard();

CREATE TABLE postgres_usage_correction_transfer_checkpoints (
  transfer_id text NOT NULL REFERENCES postgres_usage_correction_transfer_runs(transfer_id) ON DELETE CASCADE,
  table_name text NOT NULL CHECK (table_name IN ('telemetry_usage_correction_runtime',
    'telemetry_usage_correction_history', 'telemetry_usage_correction_facts')),
  last_id bigint CHECK (last_id IS NULL OR last_id BETWEEN 1 AND 9007199254740991),
  row_count bigint NOT NULL CHECK (row_count >= 0),
  page_count bigint NOT NULL CHECK (page_count >= 0),
  complete boolean NOT NULL,
  PRIMARY KEY (transfer_id, table_name)
);

CREATE FUNCTION postgres_usage_correction_transfer_checkpoint_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE run_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'usage_correction_transfer_checkpoint_retained' USING ERRCODE = 'P1005';
  END IF;
  SELECT status INTO run_status FROM postgres_usage_correction_transfer_runs
   WHERE transfer_id = CASE WHEN TG_OP = 'UPDATE' THEN OLD.transfer_id ELSE NEW.transfer_id END;
  IF NOT FOUND OR run_status <> 'running' THEN
    RAISE EXCEPTION 'usage_correction_transfer_checkpoint_closed' USING ERRCODE = 'P1005';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.complete OR OLD.transfer_id IS DISTINCT FROM NEW.transfer_id
       OR OLD.table_name IS DISTINCT FROM NEW.table_name
       OR NEW.row_count < OLD.row_count OR NEW.page_count < OLD.page_count
       OR (OLD.last_id IS NOT NULL AND NEW.last_id IS NOT NULL AND NEW.last_id < OLD.last_id)
       OR (OLD.complete AND NOT NEW.complete) THEN
      RAISE EXCEPTION 'usage_correction_transfer_checkpoint_transition_invalid' USING ERRCODE = 'P1005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_usage_correction_transfer_checkpoint_guard
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_usage_correction_transfer_checkpoints
  FOR EACH ROW EXECUTE FUNCTION postgres_usage_correction_transfer_checkpoint_guard();

CREATE TABLE postgres_usage_correction_transfer_table_receipts (
  transfer_id text NOT NULL REFERENCES postgres_usage_correction_transfer_runs(transfer_id) ON DELETE CASCADE,
  table_name text NOT NULL CHECK (table_name IN ('telemetry_usage_correction_runtime',
    'telemetry_usage_correction_history', 'telemetry_usage_correction_facts')),
  source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  target_row_count bigint NOT NULL CHECK (target_row_count >= 0),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
  semantic_reconstruction_qualified boolean NOT NULL DEFAULT false
    CHECK (semantic_reconstruction_qualified = false),
  PRIMARY KEY (transfer_id, table_name),
  CHECK (source_row_count = target_row_count AND source_sha256 = target_sha256)
);

CREATE FUNCTION postgres_usage_correction_transfer_table_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE run_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'usage_correction_transfer_table_receipt_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT status INTO run_status FROM postgres_usage_correction_transfer_runs
   WHERE transfer_id = NEW.transfer_id;
  IF NOT FOUND OR run_status <> 'running' THEN
    RAISE EXCEPTION 'usage_correction_transfer_table_receipt_closed' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_usage_correction_transfer_table_receipt_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_usage_correction_transfer_table_receipts
  FOR EACH ROW EXECUTE FUNCTION postgres_usage_correction_transfer_table_receipt_guard();

COMMENT ON TABLE postgres_usage_correction_transfer_table_receipts IS
  'Sealed-source archival-byte parity only; dictionary/reference closure and semantic reconstruction remain unqualified.';
