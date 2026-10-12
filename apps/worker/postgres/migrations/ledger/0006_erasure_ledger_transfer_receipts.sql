-- Historical D1 erasure-ledger transfer and authority-parity guards.
--
-- The source ledger contains only purpose-separated digests and bounded
-- terminal proof. Transfer rows are staged and reconciled before a single
-- transaction promotes them into the operational ledger tables.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deletion_tombstones
     WHERE schema_version <> 'participant-deletion-tombstone-v0.1'
        OR retain_until <= deleted_at
  ) THEN
    RAISE EXCEPTION 'erasure_ledger_tombstone_reconciliation_required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity_reenrollment_cooldowns
     WHERE schema_version <> 'identity-reenrollment-cooldown-v0.1'
        OR retain_until <= deleted_at
  ) THEN
    RAISE EXCEPTION 'erasure_ledger_cooldown_reconciliation_required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM storage_erasure_jobs job
     WHERE length(job.source_namespace) NOT BETWEEN 1 AND 256
        OR job.source_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'
        OR (job.terminal_json IS NOT NULL AND (
          length(job.terminal_json) > 65536 OR NOT pg_input_is_valid(job.terminal_json, 'json')
        ))
        OR (job.state = 'complete' AND job.terminal_json IS NULL)
        OR NOT EXISTS (
          SELECT 1 FROM deletion_tombstones tombstone
           WHERE tombstone.participant_digest = job.participant_digest
        )
  ) THEN
    RAISE EXCEPTION 'erasure_ledger_job_reconciliation_required';
  END IF;
END;
$$;

ALTER TABLE deletion_tombstones
  ADD CONSTRAINT deletion_tombstones_schema_version_transfer_check
    CHECK (schema_version = 'participant-deletion-tombstone-v0.1'),
  ADD CONSTRAINT deletion_tombstones_retention_strict_transfer_check
    CHECK (retain_until > deleted_at);

ALTER TABLE identity_reenrollment_cooldowns
  ADD CONSTRAINT identity_reenrollment_cooldowns_schema_version_transfer_check
    CHECK (schema_version = 'identity-reenrollment-cooldown-v0.1'),
  ADD CONSTRAINT identity_reenrollment_cooldowns_retention_strict_transfer_check
    CHECK (retain_until > deleted_at);

ALTER TABLE storage_erasure_jobs
  ADD CONSTRAINT storage_erasure_jobs_source_id_transfer_check
    CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$'),
  ADD CONSTRAINT storage_erasure_jobs_source_namespace_transfer_check
    CHECK (length(source_namespace) BETWEEN 1 AND 256),
  ADD CONSTRAINT storage_erasure_jobs_terminal_json_transfer_check
    CHECK (terminal_json IS NULL OR (length(terminal_json) <= 65536 AND pg_input_is_valid(terminal_json, 'json'))),
  ADD CONSTRAINT storage_erasure_jobs_terminal_complete_transfer_check
    CHECK (state <> 'complete' OR terminal_json IS NOT NULL),
  ADD CONSTRAINT storage_erasure_jobs_tombstone_transfer_fk
    FOREIGN KEY (participant_digest) REFERENCES deletion_tombstones(participant_digest) ON DELETE CASCADE;

CREATE FUNCTION erasure_ledger_tombstone_delete_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage_erasure_jobs job
     WHERE job.participant_digest = OLD.participant_digest AND job.state = 'pending'
  ) THEN
    RAISE EXCEPTION 'storage_erasure_pending' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER deletion_tombstones_pending_erasure_guard
  BEFORE DELETE ON deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_tombstone_delete_guard();

CREATE FUNCTION erasure_ledger_monotonic_row_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME = 'deletion_tombstones' THEN
    IF OLD.participant_digest IS DISTINCT FROM NEW.participant_digest
       OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
       OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
       OR NEW.retain_until < OLD.retain_until THEN
      RAISE EXCEPTION 'erasure_ledger_tombstone_regression' USING ERRCODE = 'P1005';
    END IF;
  ELSIF TG_TABLE_NAME = 'identity_reenrollment_cooldowns' THEN
    IF OLD.identity_cooldown_digest IS DISTINCT FROM NEW.identity_cooldown_digest
       OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
       OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
       OR NEW.retain_until < OLD.retain_until THEN
      RAISE EXCEPTION 'erasure_ledger_cooldown_regression' USING ERRCODE = 'P1005';
    END IF;
  ELSE
    IF OLD.participant_digest IS DISTINCT FROM NEW.participant_digest
       OR OLD.source_id IS DISTINCT FROM NEW.source_id
       OR OLD.owner_digest IS DISTINCT FROM NEW.owner_digest
       OR OLD.source_namespace IS DISTINCT FROM NEW.source_namespace
       OR OLD.attempted_ms > NEW.attempted_ms
       OR (OLD.terminal_json IS NOT NULL AND OLD.terminal_json IS DISTINCT FROM NEW.terminal_json) THEN
      RAISE EXCEPTION 'storage_erasure_job_conflict' USING ERRCODE = 'P1005';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deletion_tombstones_monotonic_guard
  BEFORE UPDATE ON deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_monotonic_row_guard();
CREATE TRIGGER identity_reenrollment_cooldowns_monotonic_guard
  BEFORE UPDATE ON identity_reenrollment_cooldowns
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_monotonic_row_guard();
CREATE TRIGGER storage_erasure_jobs_monotonic_guard
  BEFORE UPDATE ON storage_erasure_jobs
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_monotonic_row_guard();

CREATE TABLE postgres_erasure_ledger_transfer_runs (
  transfer_id text PRIMARY KEY CHECK (transfer_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  schema_version text NOT NULL CHECK (schema_version = 'postgres-erasure-ledger-transfer-v1'),
  target_schema text NOT NULL CHECK (target_schema ~ '^erasure_ledger_transfer_target_[a-z0-9_]{8,}$'),
  source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256 text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  page_size integer NOT NULL CHECK (page_size BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('copying', 'staged', 'complete')),
  target_manifest_sha256 text CHECK (target_manifest_sha256 IS NULL OR target_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK ((status = 'copying') = (target_manifest_sha256 IS NULL))
);

CREATE TABLE postgres_erasure_ledger_transfer_checkpoints (
  transfer_id text NOT NULL REFERENCES postgres_erasure_ledger_transfer_runs(transfer_id),
  table_name text NOT NULL CHECK (table_name IN ('deletion_tombstones', 'identity_reenrollment_cooldowns', 'storage_erasure_jobs')),
  checkpoint_no bigint NOT NULL CHECK (checkpoint_no >= 1),
  last_key jsonb,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  page_count bigint NOT NULL CHECK (page_count >= 0),
  page_row_count integer NOT NULL CHECK (page_row_count >= 0),
  prefix_sha256 text NOT NULL CHECK (prefix_sha256 ~ '^[0-9a-f]{64}$'),
  complete boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((row_count = 0) = (last_key IS NULL)),
  CHECK (last_key IS NULL OR jsonb_typeof(last_key) = 'array'),
  CHECK (last_key IS NULL OR (table_name = 'storage_erasure_jobs' AND jsonb_array_length(last_key) = 3)
    OR (table_name <> 'storage_erasure_jobs' AND jsonb_array_length(last_key) = 1)),
  PRIMARY KEY (transfer_id, table_name, checkpoint_no)
);

CREATE TABLE postgres_erasure_ledger_transfer_table_receipts (
  transfer_id text NOT NULL REFERENCES postgres_erasure_ledger_transfer_runs(transfer_id),
  table_name text NOT NULL CHECK (table_name IN ('deletion_tombstones', 'identity_reenrollment_cooldowns', 'storage_erasure_jobs')),
  source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  target_row_count bigint NOT NULL CHECK (target_row_count >= 0),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_row_count = target_row_count AND source_sha256 = target_sha256),
  PRIMARY KEY (transfer_id, table_name)
);

CREATE TABLE postgres_erasure_ledger_transfer_tombstones (
  transfer_id text NOT NULL REFERENCES postgres_erasure_ledger_transfer_runs(transfer_id),
  participant_digest text NOT NULL CHECK (participant_digest ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (schema_version = 'participant-deletion-tombstone-v0.1'),
  deleted_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL CHECK (retain_until > deleted_at),
  PRIMARY KEY (transfer_id, participant_digest)
);

CREATE TABLE postgres_erasure_ledger_transfer_cooldowns (
  transfer_id text NOT NULL REFERENCES postgres_erasure_ledger_transfer_runs(transfer_id),
  identity_cooldown_digest text NOT NULL CHECK (identity_cooldown_digest ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL CHECK (schema_version = 'identity-reenrollment-cooldown-v0.1'),
  deleted_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL CHECK (retain_until > deleted_at),
  PRIMARY KEY (transfer_id, identity_cooldown_digest)
);

CREATE TABLE postgres_erasure_ledger_transfer_jobs (
  transfer_id text NOT NULL,
  participant_digest text NOT NULL,
  source_id text NOT NULL,
  owner_digest text NOT NULL CHECK (owner_digest ~ '^[0-9a-f]{64}$'),
  source_namespace text NOT NULL CHECK (length(source_namespace) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('pending', 'complete')),
  terminal_json text CHECK (terminal_json IS NULL OR (length(terminal_json) <= 65536 AND terminal_json::json IS NOT NULL)),
  attempted_ms bigint NOT NULL CHECK (attempted_ms >= 0),
  completed_at timestamptz,
  CHECK ((state = 'pending' AND completed_at IS NULL)
    OR (state = 'complete' AND completed_at IS NOT NULL AND terminal_json IS NOT NULL)),
  PRIMARY KEY (transfer_id, participant_digest, source_id, owner_digest),
  FOREIGN KEY (transfer_id, participant_digest)
    REFERENCES postgres_erasure_ledger_transfer_tombstones(transfer_id, participant_digest) ON DELETE CASCADE
);

CREATE FUNCTION erasure_ledger_transfer_append_only_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'erasure_ledger_transfer_evidence_immutable' USING ERRCODE = 'P1005';
END;
$$;

CREATE FUNCTION erasure_ledger_transfer_stage_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE run_status text;
BEGIN
  SELECT status INTO run_status FROM postgres_erasure_ledger_transfer_runs
   WHERE transfer_id = NEW.transfer_id;
  IF run_status IS DISTINCT FROM 'copying' THEN
    RAISE EXCEPTION 'erasure_ledger_transfer_state_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_tombstones_insert_guard
  BEFORE INSERT ON postgres_erasure_ledger_transfer_tombstones
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_stage_insert_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_cooldowns_insert_guard
  BEFORE INSERT ON postgres_erasure_ledger_transfer_cooldowns
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_stage_insert_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_jobs_insert_guard
  BEFORE INSERT ON postgres_erasure_ledger_transfer_jobs
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_stage_insert_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_tombstones_immutable
  BEFORE UPDATE OR DELETE ON postgres_erasure_ledger_transfer_tombstones
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_append_only_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_cooldowns_immutable
  BEFORE UPDATE OR DELETE ON postgres_erasure_ledger_transfer_cooldowns
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_append_only_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_jobs_immutable
  BEFORE UPDATE OR DELETE ON postgres_erasure_ledger_transfer_jobs
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_append_only_guard();

CREATE FUNCTION erasure_ledger_transfer_truncate_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'erasure_ledger_transfer_evidence_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_runs_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_runs
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_truncate_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_checkpoints_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_truncate_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_table_receipts_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_table_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_truncate_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_tombstones_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_truncate_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_cooldowns_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_cooldowns
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_truncate_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_jobs_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_truncate_guard();

CREATE FUNCTION erasure_ledger_transfer_checkpoint_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run_status text;
  transfer_page_size integer;
  prior postgres_erasure_ledger_transfer_checkpoints%ROWTYPE;
  expected_checkpoint_no bigint;
  expected_row_count bigint;
  expected_page_count bigint;
  expected_last_key jsonb;
  expected_prefix text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'erasure_ledger_transfer_evidence_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT erasure_run.status, erasure_run.page_size INTO run_status, transfer_page_size
    FROM postgres_erasure_ledger_transfer_runs erasure_run
   WHERE erasure_run.transfer_id = NEW.transfer_id;
  IF run_status IS DISTINCT FROM 'copying' THEN
    RAISE EXCEPTION 'erasure_ledger_transfer_state_invalid' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.page_row_count > transfer_page_size THEN
    RAISE EXCEPTION 'erasure_ledger_checkpoint_invalid' USING ERRCODE = 'P1005';
  END IF;

  SELECT * INTO prior FROM postgres_erasure_ledger_transfer_checkpoints
   WHERE transfer_id = NEW.transfer_id AND table_name = NEW.table_name
   ORDER BY checkpoint_no DESC LIMIT 1;
  IF FOUND THEN
    IF prior.complete THEN
      RAISE EXCEPTION 'erasure_ledger_checkpoint_complete' USING ERRCODE = 'P1005';
    END IF;
    expected_checkpoint_no := prior.checkpoint_no + 1;
    expected_row_count := prior.row_count + NEW.page_row_count;
    expected_page_count := prior.page_count + CASE WHEN NEW.page_row_count > 0 THEN 1 ELSE 0 END;
    expected_last_key := CASE WHEN NEW.page_row_count > 0 THEN NEW.last_key ELSE prior.last_key END;
    expected_prefix := CASE WHEN NEW.page_row_count > 0 THEN NEW.prefix_sha256 ELSE prior.prefix_sha256 END;
    IF NEW.page_row_count > 0 AND (NEW.last_key IS NULL OR prior.last_key IS NOT NULL AND NEW.last_key <= prior.last_key) THEN
      RAISE EXCEPTION 'erasure_ledger_checkpoint_invalid' USING ERRCODE = 'P1005';
    END IF;
  ELSE
    expected_checkpoint_no := 1;
    expected_row_count := NEW.page_row_count;
    expected_page_count := CASE WHEN NEW.page_row_count > 0 THEN 1 ELSE 0 END;
    expected_last_key := CASE WHEN NEW.page_row_count > 0 THEN NEW.last_key ELSE NULL END;
    expected_prefix := NEW.prefix_sha256;
    IF NEW.page_row_count > 0 AND NEW.last_key IS NULL THEN
      RAISE EXCEPTION 'erasure_ledger_checkpoint_invalid' USING ERRCODE = 'P1005';
    END IF;
    IF NEW.page_row_count = 0 AND NEW.prefix_sha256 <> repeat('0',64) THEN
      RAISE EXCEPTION 'erasure_ledger_checkpoint_invalid' USING ERRCODE = 'P1005';
    END IF;
  END IF;

  IF NEW.checkpoint_no <> expected_checkpoint_no
     OR NEW.row_count <> expected_row_count
     OR NEW.page_count <> expected_page_count
     OR NEW.last_key IS DISTINCT FROM expected_last_key
     OR NEW.prefix_sha256 <> expected_prefix
     OR NEW.complete <> (NEW.page_row_count < transfer_page_size) THEN
    RAISE EXCEPTION 'erasure_ledger_checkpoint_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_checkpoints_guard
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_erasure_ledger_transfer_checkpoints
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_checkpoint_guard();

CREATE FUNCTION erasure_ledger_transfer_table_receipt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run_status text;
  last_checkpoint postgres_erasure_ledger_transfer_checkpoints%ROWTYPE;
  staged_row_count bigint;
  checkpoint_found boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'erasure_ledger_transfer_evidence_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT status INTO run_status FROM postgres_erasure_ledger_transfer_runs
   WHERE transfer_id = NEW.transfer_id;
  SELECT * INTO last_checkpoint FROM postgres_erasure_ledger_transfer_checkpoints checkpoint
   WHERE checkpoint.transfer_id = NEW.transfer_id AND checkpoint.table_name = NEW.table_name
   ORDER BY checkpoint_no DESC LIMIT 1;
  checkpoint_found := FOUND;
  IF checkpoint_found THEN
    IF NEW.table_name = 'deletion_tombstones' THEN
      SELECT count(*) INTO staged_row_count FROM postgres_erasure_ledger_transfer_tombstones
       WHERE transfer_id = NEW.transfer_id;
    ELSIF NEW.table_name = 'identity_reenrollment_cooldowns' THEN
      SELECT count(*) INTO staged_row_count FROM postgres_erasure_ledger_transfer_cooldowns
       WHERE transfer_id = NEW.transfer_id;
    ELSE
      SELECT count(*) INTO staged_row_count FROM postgres_erasure_ledger_transfer_jobs
       WHERE transfer_id = NEW.transfer_id;
    END IF;
  END IF;
  IF run_status IS DISTINCT FROM 'copying' OR NOT checkpoint_found OR NOT last_checkpoint.complete
     OR last_checkpoint.row_count <> NEW.source_row_count
     OR staged_row_count <> NEW.source_row_count
     OR NEW.source_row_count <> NEW.target_row_count
     OR NEW.source_sha256 <> NEW.target_sha256 THEN
    RAISE EXCEPTION 'erasure_ledger_transfer_parity_required' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_table_receipts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_erasure_ledger_transfer_table_receipts
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_table_receipt_guard();

CREATE FUNCTION erasure_ledger_transfer_run_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  receipt_count bigint;
  checkpoint_count bigint;
  unmatched_receipt_count bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'copying' OR NEW.target_manifest_sha256 IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'erasure_ledger_transfer_run_invalid' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE'
       OR OLD.transfer_id IS DISTINCT FROM NEW.transfer_id
       OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
       OR OLD.target_schema IS DISTINCT FROM NEW.target_schema
       OR OLD.source_snapshot_sha256 IS DISTINCT FROM NEW.source_snapshot_sha256
       OR OLD.source_manifest_sha256 IS DISTINCT FROM NEW.source_manifest_sha256
       OR OLD.page_size IS DISTINCT FROM NEW.page_size
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.status NOT IN ('copying', 'staged')
       OR (OLD.status = 'copying' AND NEW.status <> 'staged')
       OR (OLD.status = 'staged' AND NEW.status <> 'complete')
       OR (OLD.status = 'staged'
         AND OLD.target_manifest_sha256 IS DISTINCT FROM NEW.target_manifest_sha256) THEN
      RAISE EXCEPTION 'erasure_ledger_transfer_run_immutable' USING ERRCODE = 'P1005';
    END IF;
    SELECT count(*) INTO receipt_count
      FROM postgres_erasure_ledger_transfer_table_receipts receipt
     WHERE receipt.transfer_id = NEW.transfer_id;
    SELECT count(*) INTO checkpoint_count
      FROM postgres_erasure_ledger_transfer_checkpoints checkpoint
     WHERE checkpoint.transfer_id = NEW.transfer_id AND checkpoint.complete;
    SELECT count(*) INTO unmatched_receipt_count
      FROM postgres_erasure_ledger_transfer_table_receipts receipt
      LEFT JOIN LATERAL (
        SELECT checkpoint.row_count
          FROM postgres_erasure_ledger_transfer_checkpoints checkpoint
         WHERE checkpoint.transfer_id = receipt.transfer_id AND checkpoint.table_name = receipt.table_name
         ORDER BY checkpoint.checkpoint_no DESC LIMIT 1
      ) checkpoint ON true
     WHERE receipt.transfer_id = NEW.transfer_id
       AND checkpoint.row_count IS DISTINCT FROM receipt.source_row_count;
    IF receipt_count <> 3 OR EXISTS (
      SELECT 1 FROM postgres_erasure_ledger_transfer_table_receipts receipt
       WHERE receipt.transfer_id = NEW.transfer_id
         AND (receipt.source_row_count <> receipt.target_row_count
           OR receipt.source_sha256 <> receipt.target_sha256)
    ) OR checkpoint_count <> 3 OR unmatched_receipt_count <> 0 THEN
      RAISE EXCEPTION 'erasure_ledger_transfer_parity_required' USING ERRCODE = 'P1005';
    END IF;
    IF NEW.status = 'staged' AND (NEW.target_manifest_sha256 IS NULL OR NEW.completed_at IS NOT NULL)
       OR NEW.status = 'complete' AND (NEW.target_manifest_sha256 IS NULL OR NEW.completed_at IS NULL) THEN
      RAISE EXCEPTION 'erasure_ledger_transfer_run_invalid' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_runs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_erasure_ledger_transfer_runs
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_run_guard();

COMMENT ON TABLE postgres_erasure_ledger_transfer_runs IS
  'Digest-only historical transfer evidence. Completion proves exact source/target row parity for that sealed snapshot, not runtime activation or production cutover.';
