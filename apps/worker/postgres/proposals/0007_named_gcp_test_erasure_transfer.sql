-- DRAFT ONLY: outside the executable migration stream and not qualified for
-- deployment. The named transfer wrapper and private sealed-source egress
-- require separate authorization; no GCP service account or IAM DB user has
-- been created for this proposal. Disposable transfer schemas retain 0006.
-- Proposed scope: historical erasure-ledger import into one named GCP test
-- ledger after exact source, destination, and role review.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM postgres_erasure_ledger_transfer_runs
     WHERE target_schema !~ '^erasure_ledger_transfer_target_[a-z0-9_]{8,}$'
  ) THEN
    RAISE EXCEPTION 'erasure_ledger_named_target_preflight_failed';
  END IF;
END;
$$;

CREATE TABLE postgres_erasure_ledger_transfer_target_contracts (
  target_contract_id text PRIMARY KEY CHECK (target_contract_id = 'gcp-tibotattle-ledger-test-v1'),
  mode text NOT NULL CHECK (mode = 'gcp_named_test'),
  project_id text NOT NULL CHECK (project_id = 'tibotattle'),
  project_number text NOT NULL CHECK (project_number = '806510610397'),
  instance_connection_name text NOT NULL
    CHECK (instance_connection_name = 'tibotattle:us-east1:tibotattle-test-ledger-20260922'),
  database_name text NOT NULL CHECK (database_name = 'tibotattle_ledger'),
  schema_name text NOT NULL CHECK (schema_name = 'tibotattle_ledger'),
  cloud_run_job_name text NOT NULL CHECK (cloud_run_job_name = 'tibotattle-test-erasure-ledger-transfer'),
  service_account_email text NOT NULL
    CHECK (service_account_email = 'tibotattle-test-transfer@tibotattle.iam.gserviceaccount.com'),
  iam_database_role text NOT NULL CHECK (iam_database_role = 'tibotattle-test-transfer@tibotattle.iam'),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO postgres_erasure_ledger_transfer_target_contracts (
  target_contract_id,mode,project_id,project_number,instance_connection_name,database_name,
  schema_name,cloud_run_job_name,service_account_email,iam_database_role
) VALUES (
  'gcp-tibotattle-ledger-test-v1','gcp_named_test','tibotattle','806510610397',
  'tibotattle:us-east1:tibotattle-test-ledger-20260922','tibotattle_ledger','tibotattle_ledger',
  'tibotattle-test-erasure-ledger-transfer',
  'tibotattle-test-transfer@tibotattle.iam.gserviceaccount.com',
  'tibotattle-test-transfer@tibotattle.iam'
);

CREATE FUNCTION erasure_ledger_transfer_contract_immutable_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'erasure_ledger_transfer_target_contract_immutable' USING ERRCODE = 'P1005';
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_target_contracts_immutable
  BEFORE UPDATE OR DELETE ON postgres_erasure_ledger_transfer_target_contracts
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_contract_immutable_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_target_contracts_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_target_contracts
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_contract_immutable_guard();

ALTER TABLE postgres_erasure_ledger_transfer_runs
  ADD COLUMN target_mode text NOT NULL DEFAULT 'disposable',
  ADD COLUMN target_contract_id text,
  ADD COLUMN source_seal_manifest_sha256 text;

ALTER TABLE postgres_erasure_ledger_transfer_runs
  DROP CONSTRAINT IF EXISTS postgres_erasure_ledger_transfer_runs_target_schema_check;

ALTER TABLE postgres_erasure_ledger_transfer_runs
  ADD CONSTRAINT postgres_erasure_ledger_transfer_runs_target_schema_check
    CHECK (
      (target_mode = 'disposable'
        AND target_schema ~ '^erasure_ledger_transfer_target_[a-z0-9_]{8,}$'
        AND target_contract_id IS NULL
        AND source_seal_manifest_sha256 IS NULL)
      OR
      (target_mode = 'gcp_named_test'
        AND target_schema = 'tibotattle_ledger'
        AND target_contract_id = 'gcp-tibotattle-ledger-test-v1'
        AND source_seal_manifest_sha256 IS NOT NULL
        AND source_seal_manifest_sha256 ~ '^[0-9a-f]{64}$')
    ),
  ADD CONSTRAINT postgres_erasure_ledger_transfer_runs_target_contract_fk
    FOREIGN KEY (target_contract_id)
    REFERENCES postgres_erasure_ledger_transfer_target_contracts(target_contract_id);

CREATE FUNCTION erasure_ledger_transfer_named_run_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  expected postgres_erasure_ledger_transfer_target_contracts%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE'
       OR OLD.target_mode IS DISTINCT FROM NEW.target_mode
       OR OLD.target_contract_id IS DISTINCT FROM NEW.target_contract_id
       OR OLD.source_seal_manifest_sha256 IS DISTINCT FROM NEW.source_seal_manifest_sha256 THEN
      RAISE EXCEPTION 'erasure_ledger_named_target_immutable' USING ERRCODE = 'P1005';
    END IF;
  END IF;

  IF NEW.target_mode = 'disposable' THEN
    IF NEW.target_contract_id IS NOT NULL OR NEW.source_seal_manifest_sha256 IS NOT NULL
       OR NEW.target_schema !~ '^erasure_ledger_transfer_target_[a-z0-9_]{8,}$' THEN
      RAISE EXCEPTION 'erasure_ledger_disposable_target_invalid' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.target_mode <> 'gcp_named_test'
     OR NEW.target_schema <> 'tibotattle_ledger'
     OR NEW.target_contract_id IS DISTINCT FROM 'gcp-tibotattle-ledger-test-v1'
     OR NEW.source_seal_manifest_sha256 IS NULL
     OR NEW.source_seal_manifest_sha256 !~ '^[0-9a-f]{64}$'
     OR current_database() <> 'tibotattle_ledger'
     OR current_user <> 'tibotattle-test-transfer@tibotattle.iam' THEN
    RAISE EXCEPTION 'erasure_ledger_named_target_identity_invalid' USING ERRCODE = 'P1005';
  END IF;

  SELECT * INTO expected FROM postgres_erasure_ledger_transfer_target_contracts
   WHERE target_contract_id = NEW.target_contract_id;
  IF NOT FOUND
     OR expected.mode <> 'gcp_named_test'
     OR expected.project_id <> 'tibotattle'
     OR expected.project_number <> '806510610397'
     OR expected.instance_connection_name <> 'tibotattle:us-east1:tibotattle-test-ledger-20260922'
     OR expected.database_name <> 'tibotattle_ledger'
     OR expected.schema_name <> NEW.target_schema
     OR expected.cloud_run_job_name <> 'tibotattle-test-erasure-ledger-transfer'
     OR expected.service_account_email <> 'tibotattle-test-transfer@tibotattle.iam.gserviceaccount.com'
     OR expected.iam_database_role <> current_user THEN
    RAISE EXCEPTION 'erasure_ledger_named_target_contract_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_named_run_guard
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_erasure_ledger_transfer_runs
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_named_run_guard();

CREATE TABLE postgres_erasure_ledger_transfer_named_attempts (
  transfer_id text NOT NULL REFERENCES postgres_erasure_ledger_transfer_runs(transfer_id),
  target_contract_id text NOT NULL REFERENCES postgres_erasure_ledger_transfer_target_contracts(target_contract_id),
  cloud_run_execution text NOT NULL CHECK (cloud_run_execution ~ '^[a-z][a-z0-9-]{0,62}$'),
  cloud_run_job_name text NOT NULL CHECK (cloud_run_job_name = 'tibotattle-test-erasure-ledger-transfer'),
  service_account_email text NOT NULL
    CHECK (service_account_email = 'tibotattle-test-transfer@tibotattle.iam.gserviceaccount.com'),
  iam_database_role text NOT NULL CHECK (iam_database_role = 'tibotattle-test-transfer@tibotattle.iam'),
  source_snapshot_sha256 text NOT NULL CHECK (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  source_seal_manifest_sha256 text NOT NULL CHECK (source_seal_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transfer_id,cloud_run_execution)
);

CREATE FUNCTION erasure_ledger_transfer_named_attempt_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  run_row postgres_erasure_ledger_transfer_runs%ROWTYPE;
  expected postgres_erasure_ledger_transfer_target_contracts%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'erasure_ledger_transfer_evidence_immutable' USING ERRCODE = 'P1005';
  END IF;
  SELECT * INTO run_row FROM postgres_erasure_ledger_transfer_runs
   WHERE transfer_id = NEW.transfer_id;
  SELECT * INTO expected FROM postgres_erasure_ledger_transfer_target_contracts
   WHERE target_contract_id = NEW.target_contract_id;
  IF current_database() <> 'tibotattle_ledger'
     OR current_user <> 'tibotattle-test-transfer@tibotattle.iam'
     OR run_row.transfer_id IS NULL
     OR run_row.target_mode <> 'gcp_named_test'
     OR run_row.target_schema <> 'tibotattle_ledger'
     OR run_row.target_contract_id <> NEW.target_contract_id
     OR run_row.source_snapshot_sha256 <> NEW.source_snapshot_sha256
     OR run_row.source_seal_manifest_sha256 <> NEW.source_seal_manifest_sha256
     OR expected.target_contract_id IS NULL
     OR NEW.cloud_run_job_name <> expected.cloud_run_job_name
     OR NEW.service_account_email <> expected.service_account_email
     OR expected.service_account_email <> 'tibotattle-test-transfer@tibotattle.iam.gserviceaccount.com'
     OR expected.iam_database_role <> current_user THEN
    RAISE EXCEPTION 'erasure_ledger_named_attempt_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER postgres_erasure_ledger_transfer_named_attempts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON postgres_erasure_ledger_transfer_named_attempts
  FOR EACH ROW EXECUTE FUNCTION erasure_ledger_transfer_named_attempt_guard();
CREATE TRIGGER postgres_erasure_ledger_transfer_named_attempts_no_truncate
  BEFORE TRUNCATE ON postgres_erasure_ledger_transfer_named_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_ledger_transfer_contract_immutable_guard();

DO $$
DECLARE
  transfer_role text := 'tibotattle-test-transfer@tibotattle.iam';
BEGIN
  IF current_database() = 'tibotattle_ledger' AND current_schema() = 'tibotattle_ledger' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = transfer_role) THEN
      RAISE EXCEPTION 'erasure_ledger_named_transfer_iam_role_required';
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), transfer_role);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON postgres_erasure_ledger_transfer_runs TO %I', transfer_role);
    EXECUTE format('GRANT SELECT,INSERT ON postgres_erasure_ledger_transfer_checkpoints,
      postgres_erasure_ledger_transfer_table_receipts,postgres_erasure_ledger_transfer_named_attempts,
      postgres_erasure_ledger_transfer_tombstones,postgres_erasure_ledger_transfer_cooldowns,
      postgres_erasure_ledger_transfer_jobs,deletion_tombstones,identity_reenrollment_cooldowns,
      storage_erasure_jobs TO %I', transfer_role);
    EXECUTE format('GRANT SELECT ON postgres_erasure_ledger_transfer_target_contracts TO %I', transfer_role);
  END IF;
END;
$$;

COMMENT ON TABLE postgres_erasure_ledger_transfer_target_contracts IS
  'One immutable named test destination. It does not authorize runtime routing, test activation, or production cutover.';
COMMENT ON TABLE postgres_erasure_ledger_transfer_named_attempts IS
  'Append-only Cloud Run attempt identity receipts for exact sealed-source imports into the fixed GCP test ledger.';
