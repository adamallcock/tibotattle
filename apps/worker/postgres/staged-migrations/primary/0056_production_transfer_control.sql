-- PT-1 production transfer control schema (primary).
--
-- tibotattle_transfer sits beside the application schema, so the runtime
-- role's grants on the application schema never reach it. It holds only
-- content-free control state: the registered target contract, run state,
-- receipts (counts, digests, states, stage and table names, timestamps),
-- transient checkpoint cursors that must be NULL once complete, the sealed
-- collection-controls record and drop receipts for tool staging relations.
-- Nothing is granted to any role. The owner is the migration role; transfer
-- tools reach the schema only through SET ROLE to that owner.
--
-- The control schema is database-scoped. Production places one application
-- schema in each Cloud SQL database. Test databases may apply this migration
-- to many application schemas, so the first application schema to run it
-- installs the control objects under a transaction advisory lock and later
-- ones leave them unchanged. The registered target contract, not the
-- installer, binds the one application schema a transfer serves. The shared
-- block below is carried verbatim by the ledger migration too, so either
-- role may install first when both share a database.
--
-- Every name is qualified; functions pin search_path to pg_catalog. Guards
-- raise constant messages with ERRCODE P1005. No backfill.

SELECT pg_advisory_xact_lock(hashtextextended('tibotattle_transfer:control-schema', 0));

DO $install$
BEGIN
  IF to_regnamespace('tibotattle_transfer') IS NULL THEN
    CREATE SCHEMA tibotattle_transfer;
  ELSIF (SELECT pg_get_userbyid(namespace.nspowner) FROM pg_catalog.pg_namespace namespace
          WHERE namespace.nspname = 'tibotattle_transfer') IS DISTINCT FROM current_user
     OR to_regclass('tibotattle_transfer.transfer_control_installations') IS NULL THEN
    RAISE EXCEPTION 'TRANSFER_CONTROL_SCHEMA_FOREIGN' USING ERRCODE = 'P1005';
  ELSIF EXISTS (SELECT 1 FROM tibotattle_transfer.transfer_control_installations installation
                 WHERE installation.component = 'primary') THEN
    RETURN;
  END IF;

  -- Shared control objects (identical in primary 0056 and ledger 0007).
  IF to_regprocedure('tibotattle_transfer.transfer_control_row_immutable()') IS NULL THEN
    CREATE FUNCTION tibotattle_transfer.transfer_control_row_immutable()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN
      RAISE EXCEPTION 'TRANSFER_CONTROL_ROW_IMMUTABLE' USING ERRCODE = 'P1005';
    END;
    $fn$;
  END IF;
  IF to_regclass('tibotattle_transfer.transfer_control_installations') IS NULL THEN
    CREATE TABLE tibotattle_transfer.transfer_control_installations (
      component text PRIMARY KEY CHECK (component IN ('primary', 'ledger')),
      migration_name text NOT NULL CHECK (migration_name ~ '^[0-9]{4}_[a-z0-9_]{1,80}[.]sql$'),
      installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER transfer_control_installations_immutable
      BEFORE UPDATE OR DELETE ON tibotattle_transfer.transfer_control_installations
      FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();
    CREATE TRIGGER transfer_control_installations_no_truncate
      BEFORE TRUNCATE ON tibotattle_transfer.transfer_control_installations
      FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();
  END IF;
  IF to_regprocedure('tibotattle_transfer.transfer_target_live_lock_guard()') IS NULL THEN
    CREATE FUNCTION tibotattle_transfer.transfer_target_live_lock_guard()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN
      RAISE EXCEPTION 'TRANSFER_TARGET_LIVE' USING ERRCODE = 'P1005';
    END;
    $fn$;
  END IF;
  IF to_regprocedure('tibotattle_transfer.install_transfer_live_lock()') IS NULL THEN
    -- Attach the statement-level live lock to every table in the schema,
    -- including tool-created relations, once a run is live, and revoke CREATE
    -- on the schema from its owner so no unlocked relation can follow. Refuses
    -- any relation kind that a statement trigger cannot lock.
    CREATE FUNCTION tibotattle_transfer.install_transfer_live_lock()
    RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
    DECLARE
      control_namespace oid := to_regnamespace('tibotattle_transfer');
      live boolean := false;
      relation record;
      installed integer := 0;
    BEGIN
      IF to_regclass('tibotattle_transfer.transfer_runs') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM tibotattle_transfer.transfer_runs WHERE state = ''live'')'
          INTO live;
      END IF;
      IF NOT live AND to_regclass('tibotattle_transfer.ledger_transfer_runs') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM tibotattle_transfer.ledger_transfer_runs WHERE state = ''live'')'
          INTO live;
      END IF;
      IF live IS NOT TRUE THEN
        RAISE EXCEPTION 'TRANSFER_LIVE_LOCK_NOT_LIVE' USING ERRCODE = 'P1005';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.relnamespace = control_namespace
                    AND c.relkind NOT IN ('r', 'p', 'i', 'I')) THEN
        RAISE EXCEPTION 'TRANSFER_LIVE_LOCK_RELATION_UNSUPPORTED' USING ERRCODE = 'P1005';
      END IF;
      FOR relation IN
        SELECT c.oid, c.relname FROM pg_class c
         WHERE c.relnamespace = control_namespace AND c.relkind IN ('r', 'p')
         ORDER BY c.relname
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgrelid = relation.oid AND t.tgname = 'transfer_target_live_lock') THEN
          EXECUTE format(
            'CREATE TRIGGER transfer_target_live_lock '
              || 'BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON tibotattle_transfer.%I '
              || 'FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_target_live_lock_guard()',
            relation.relname);
          EXECUTE format(
            'ALTER TABLE tibotattle_transfer.%I ENABLE ALWAYS TRIGGER transfer_target_live_lock',
            relation.relname);
          installed := installed + 1;
        END IF;
      END LOOP;
      EXECUTE format('REVOKE CREATE ON SCHEMA tibotattle_transfer FROM %I',
        (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.oid = control_namespace));
      IF EXISTS (
        SELECT 1 FROM pg_class c
         WHERE c.relnamespace = control_namespace AND c.relkind IN ('r', 'p')
           AND NOT EXISTS (
             SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = c.oid
                AND t.tgname = 'transfer_target_live_lock'
                AND t.tgfoid = 'tibotattle_transfer.transfer_target_live_lock_guard()'::regprocedure
                AND t.tgenabled = 'A'
                AND t.tgtype = 62
                AND NOT t.tgisinternal)
      ) OR EXISTS (
        SELECT 1 FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
         WHERE n.oid = control_namespace AND acl.privilege_type = 'CREATE'
      ) THEN
        RAISE EXCEPTION 'TRANSFER_LIVE_LOCK_INCOMPLETE' USING ERRCODE = 'P1005';
      END IF;
      RETURN installed;
    END;
    $fn$;
  END IF;

  -- The registered target contract: an immutable singleton naming the one
  -- application schema, databases, roles and bucket a transfer may touch.
  CREATE TABLE tibotattle_transfer.transfer_target_contract (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    contract_id text NOT NULL UNIQUE CHECK (contract_id ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
    mode text NOT NULL CHECK (mode IN ('production', 'staging_rehearsal')),
    project_id text NOT NULL CHECK (project_id ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'),
    project_number text NOT NULL CHECK (project_number ~ '^[1-9][0-9]{0,19}$'),
    instance_connection_name text NOT NULL
      CHECK (instance_connection_name ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z][a-z0-9-]{1,40}:[a-z][a-z0-9-]{0,97}$'),
    database_name text NOT NULL CHECK (database_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
    schema_name text NOT NULL
      CHECK (schema_name ~ '^[a-z_][a-z0-9_]{0,62}$' AND schema_name !~ '^pg_'
        AND schema_name NOT IN ('tibotattle_transfer', 'information_schema', 'public')),
    ledger_instance_connection_name text NOT NULL
      CHECK (ledger_instance_connection_name ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z][a-z0-9-]{1,40}:[a-z][a-z0-9-]{0,97}$'),
    ledger_database_name text NOT NULL CHECK (ledger_database_name ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
    ledger_schema_name text NOT NULL
      CHECK (ledger_schema_name ~ '^[a-z_][a-z0-9_]{0,62}$' AND ledger_schema_name !~ '^pg_'
        AND ledger_schema_name NOT IN ('tibotattle_transfer', 'information_schema', 'public')),
    iam_database_user text NOT NULL CHECK (iam_database_user ~ '^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$'),
    schema_owner_role text NOT NULL CHECK (schema_owner_role ~ '^[A-Za-z0-9][A-Za-z0-9@_.-]{0,62}$'),
    gcs_bucket text NOT NULL CHECK (gcs_bucket ~ '^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$'),
    gcs_bucket_generation text NOT NULL CHECK (gcs_bucket_generation ~ '^[1-9][0-9]{0,19}$'),
    registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (iam_database_user <> schema_owner_role)
  );
  CREATE TRIGGER transfer_target_contract_immutable
    BEFORE UPDATE OR DELETE ON tibotattle_transfer.transfer_target_contract
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();
  CREATE TRIGGER transfer_target_contract_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_target_contract
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  -- One orchestrator run per seal. States move forward only; 'live' and
  -- 'abandoned' are terminal, and at most one run is not abandoned.
  CREATE TABLE tibotattle_transfer.transfer_runs (
    run_id text PRIMARY KEY
      CHECK (run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    contract_id text NOT NULL REFERENCES tibotattle_transfer.transfer_target_contract(contract_id),
    seal_manifest_sha256 text NOT NULL CHECK (seal_manifest_sha256 ~ '^[0-9a-f]{64}$'),
    sealed_at timestamptz NOT NULL CHECK (date_trunc('milliseconds', sealed_at) = sealed_at),
    state text NOT NULL
      CHECK (state IN ('preflight', 'importing', 'verifying', 'verified', 'live', 'abandoned')),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    verified_at timestamptz,
    live_at timestamptz,
    abandoned_at timestamptz,
    flip_evidence_sha256 text CHECK (flip_evidence_sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (state NOT IN ('preflight', 'importing', 'verifying')
      OR (verified_at IS NULL AND live_at IS NULL AND abandoned_at IS NULL AND flip_evidence_sha256 IS NULL)),
    CHECK (state <> 'verified'
      OR (verified_at IS NOT NULL AND live_at IS NULL AND abandoned_at IS NULL AND flip_evidence_sha256 IS NULL)),
    CHECK (state <> 'live'
      OR (verified_at IS NOT NULL AND live_at IS NOT NULL AND abandoned_at IS NULL
        AND flip_evidence_sha256 IS NOT NULL)),
    CHECK (state <> 'abandoned'
      OR (abandoned_at IS NOT NULL AND live_at IS NULL AND flip_evidence_sha256 IS NULL))
  );
  CREATE UNIQUE INDEX transfer_runs_one_open
    ON tibotattle_transfer.transfer_runs ((true)) WHERE state <> 'abandoned';

  CREATE FUNCTION tibotattle_transfer.transfer_runs_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TRANSFER_RUN_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.state IS DISTINCT FROM 'preflight'
         OR EXISTS (SELECT 1 FROM tibotattle_transfer.transfer_runs run WHERE run.state = 'live') THEN
        RAISE EXCEPTION 'TRANSFER_RUN_REFUSED' USING ERRCODE = 'P1005';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
       OR NEW.seal_manifest_sha256 IS DISTINCT FROM OLD.seal_manifest_sha256
       OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
      RAISE EXCEPTION 'TRANSFER_RUN_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF NOT ((OLD.state = 'preflight' AND NEW.state IN ('importing', 'abandoned'))
         OR (OLD.state = 'importing' AND NEW.state IN ('verifying', 'abandoned'))
         OR (OLD.state = 'verifying' AND NEW.state IN ('verified', 'abandoned'))
         OR (OLD.state = 'verified' AND NEW.state IN ('live', 'abandoned'))) THEN
      RAISE EXCEPTION 'TRANSFER_RUN_TRANSITION_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER transfer_runs_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_runs
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_runs_guard();
  CREATE TRIGGER transfer_runs_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_runs
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  -- Receipts and checkpoints are written only while their run is importing
  -- or verifying, and never after any run is live.
  CREATE FUNCTION tibotattle_transfer.transfer_write_allowed(p_run_id text)
  RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
    SELECT EXISTS (
             SELECT 1 FROM tibotattle_transfer.transfer_runs run
              WHERE run.run_id = p_run_id AND run.state IN ('importing', 'verifying'))
       AND NOT EXISTS (
             SELECT 1 FROM tibotattle_transfer.transfer_runs run WHERE run.state = 'live')
  $fn$;

  CREATE TABLE tibotattle_transfer.transfer_stage_receipts (
    run_id text NOT NULL REFERENCES tibotattle_transfer.transfer_runs(run_id),
    stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(stage) <= 63),
    transfer_id text NOT NULL CHECK (transfer_id ~ '^production-[a-z0-9-]{1,63}-[0-9a-f]{16}$'),
    state text NOT NULL CHECK (state IN ('started', 'complete')),
    row_count bigint CHECK (row_count >= 0),
    byte_count bigint CHECK (byte_count >= 0),
    receipt_sha256 text CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    PRIMARY KEY (run_id, stage),
    CHECK ((state = 'complete') = (completed_at IS NOT NULL)),
    CHECK (state <> 'complete'
      OR (row_count IS NOT NULL AND byte_count IS NOT NULL AND receipt_sha256 IS NOT NULL)),
    CHECK (state <> 'started'
      OR (row_count IS NULL AND byte_count IS NULL AND receipt_sha256 IS NULL))
  );
  CREATE FUNCTION tibotattle_transfer.transfer_stage_receipts_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'UPDATE' AND (OLD.state = 'complete'
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.stage IS DISTINCT FROM OLD.stage
       OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF tibotattle_transfer.transfer_write_allowed(NEW.run_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'TRANSFER_WRITE_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    IF NEW.transfer_id IS DISTINCT FROM (
         SELECT 'production-' || NEW.stage || '-' || left(run.seal_manifest_sha256, 16)
           FROM tibotattle_transfer.transfer_runs run WHERE run.run_id = NEW.run_id) THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER transfer_stage_receipts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_stage_receipts
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_stage_receipts_guard();
  CREATE TRIGGER transfer_stage_receipts_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_stage_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  -- One disposition per sealed source table, owned by one stage.
  CREATE TABLE tibotattle_transfer.transfer_table_receipts (
    run_id text NOT NULL REFERENCES tibotattle_transfer.transfer_runs(run_id),
    source_role text NOT NULL CHECK (source_role IN ('ingestion', 'analytics', 'deletion-ledger', 'r2')),
    source_table text NOT NULL CHECK (source_table ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
    stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(stage) <= 63),
    disposition text NOT NULL CHECK (
      disposition ~ '^(imported|mapped|claimed-by):[a-z][a-z0-9]*(-[a-z0-9]+)*$'
      OR disposition IN ('verified-equal', 'must-be-empty', 'schema-marker', 'source-machinery',
        'runtime-reset', 'edge-retained', 'not-transferred-expiring', 'target-missing')),
    target_table text CHECK (target_table ~ '^[a-z_][a-z0-9_]{0,62}$'),
    state text NOT NULL CHECK (state IN ('started', 'complete')),
    source_row_count bigint CHECK (source_row_count >= 0),
    source_sha256 text CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    target_row_count bigint CHECK (target_row_count >= 0),
    target_sha256 text CHECK (target_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    PRIMARY KEY (run_id, source_role, source_table),
    CHECK ((state = 'complete') = (completed_at IS NOT NULL)),
    CHECK (state <> 'complete' OR (source_row_count IS NOT NULL AND source_sha256 IS NOT NULL)),
    CHECK ((target_row_count IS NULL) = (target_sha256 IS NULL))
  );
  CREATE FUNCTION tibotattle_transfer.transfer_table_receipts_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'UPDATE' AND (OLD.state = 'complete'
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.source_role IS DISTINCT FROM OLD.source_role
       OR NEW.source_table IS DISTINCT FROM OLD.source_table
       OR NEW.stage IS DISTINCT FROM OLD.stage
       OR NEW.disposition IS DISTINCT FROM OLD.disposition
       OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at) THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF tibotattle_transfer.transfer_write_allowed(NEW.run_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'TRANSFER_WRITE_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER transfer_table_receipts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_table_receipts
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_table_receipts_guard();
  CREATE TRIGGER transfer_table_receipts_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_table_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  -- Keyset checkpoints. A cursor is transient: a complete checkpoint holds
  -- no key, and finalization NULLs every remaining cursor. An abandoned
  -- run's checkpoint admits exactly one change, NULLing its cursor, so a
  -- run abandoned mid-import never keeps a source key.
  CREATE TABLE tibotattle_transfer.transfer_checkpoints (
    run_id text NOT NULL REFERENCES tibotattle_transfer.transfer_runs(run_id),
    stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(stage) <= 63),
    checkpoint_name text NOT NULL CHECK (checkpoint_name ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
    state text NOT NULL CHECK (state IN ('pending', 'complete')),
    last_key text CHECK (length(last_key) <= 8192),
    row_count bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    prefix_chain_sha256 text NOT NULL CHECK (prefix_chain_sha256 ~ '^[0-9a-f]{64}$'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id, stage, checkpoint_name),
    CHECK (state <> 'complete' OR last_key IS NULL)
  );
  CREATE FUNCTION tibotattle_transfer.transfer_checkpoints_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TRANSFER_CHECKPOINT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'UPDATE' AND (OLD.state = 'complete'
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.stage IS DISTINCT FROM OLD.stage
       OR NEW.checkpoint_name IS DISTINCT FROM OLD.checkpoint_name) THEN
      RAISE EXCEPTION 'TRANSFER_CHECKPOINT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.last_key IS NOT NULL AND NEW.last_key IS NULL
       AND NEW.state IS NOT DISTINCT FROM OLD.state
       AND NEW.row_count IS NOT DISTINCT FROM OLD.row_count
       AND NEW.prefix_chain_sha256 IS NOT DISTINCT FROM OLD.prefix_chain_sha256
       AND EXISTS (SELECT 1 FROM tibotattle_transfer.transfer_runs run
                    WHERE run.run_id = OLD.run_id AND run.state = 'abandoned')
       AND NOT EXISTS (SELECT 1 FROM tibotattle_transfer.transfer_runs run WHERE run.state = 'live') THEN
      NEW.updated_at := clock_timestamp();
      RETURN NEW;
    END IF;
    IF tibotattle_transfer.transfer_write_allowed(NEW.run_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'TRANSFER_WRITE_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER transfer_checkpoints_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_checkpoints
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_checkpoints_guard();
  CREATE TRIGGER transfer_checkpoints_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_checkpoints
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  -- Object receipts hold sha256(key), never the key.
  CREATE TABLE tibotattle_transfer.transfer_object_receipts (
    run_id text NOT NULL REFERENCES tibotattle_transfer.transfer_runs(run_id),
    key_sha256 text NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
    object_class text NOT NULL CHECK (object_class IN ('live', 'registered', 'live-registered')),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    metadata_sha256 text NOT NULL CHECK (metadata_sha256 ~ '^[0-9a-f]{64}$'),
    gcs_generation text NOT NULL CHECK (gcs_generation ~ '^[1-9][0-9]{0,19}$'),
    state text NOT NULL CHECK (state IN ('copied', 'verified')),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    verified_at timestamptz,
    PRIMARY KEY (run_id, key_sha256),
    CHECK ((state = 'verified') = (verified_at IS NOT NULL))
  );
  CREATE FUNCTION tibotattle_transfer.transfer_object_receipts_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'UPDATE' AND (OLD.state <> 'copied' OR NEW.state <> 'verified'
       OR (to_jsonb(NEW) - ARRAY['state', 'verified_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'verified_at'])) THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF tibotattle_transfer.transfer_write_allowed(NEW.run_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'TRANSFER_WRITE_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER transfer_object_receipts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_object_receipts
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_object_receipts_guard();
  CREATE TRIGGER transfer_object_receipts_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_object_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  -- Every erased GCS generation (stale pre-copies and objects outside the
  -- copy set) has a receipt keyed by the key digest.
  CREATE TABLE tibotattle_transfer.transfer_object_erasures (
    run_id text NOT NULL REFERENCES tibotattle_transfer.transfer_runs(run_id),
    key_sha256 text NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
    gcs_generation text NOT NULL CHECK (gcs_generation ~ '^[1-9][0-9]{0,19}$'),
    reason text NOT NULL CHECK (reason IN ('not-in-copy-set', 'tombstone', 'stale-generation')),
    erased_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id, key_sha256, gcs_generation)
  );

  -- Receipts taken immediately before a tool staging or mirror relation is
  -- dropped: row count and canonical digest only.
  CREATE TABLE tibotattle_transfer.transfer_dropped_relations (
    run_id text NOT NULL REFERENCES tibotattle_transfer.transfer_runs(run_id),
    relation_name text NOT NULL CHECK (relation_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
    stage text NOT NULL CHECK (stage ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(stage) <= 63),
    was_present boolean NOT NULL,
    row_count bigint NOT NULL CHECK (row_count >= 0),
    rows_sha256 text NOT NULL CHECK (rows_sha256 ~ '^[0-9a-f]{64}$'),
    dropped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id, relation_name),
    CHECK (was_present OR row_count = 0)
  );

  -- The sealed D1 collection_controls row (schema_version asserted constant
  -- and dropped). The application row is degraded from it for the import and
  -- restored to it exactly after the run is verified.
  CREATE TABLE tibotattle_transfer.sealed_collection_controls (
    run_id text PRIMARY KEY REFERENCES tibotattle_transfer.transfer_runs(run_id),
    revision bigint NOT NULL CHECK (revision >= 1),
    control_state text NOT NULL CHECK (control_state IN ('operational', 'degraded', 'contained')),
    enrollment_enabled boolean NOT NULL,
    upload_registration_enabled boolean NOT NULL,
    processing_enabled boolean NOT NULL,
    publication_enabled boolean NOT NULL,
    reason_code text NOT NULL CHECK (reason_code IN ('initial', 'drill_containment', 'drill_restore',
      'privacy_incident', 'security_incident', 'abuse_or_cost', 'maintenance')),
    updated_at timestamptz NOT NULL CHECK (date_trunc('milliseconds', updated_at) = updated_at),
    sealed_row_sha256 text NOT NULL CHECK (sealed_row_sha256 ~ '^[0-9a-f]{64}$'),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      (control_state = 'operational' AND enrollment_enabled AND upload_registration_enabled
        AND processing_enabled AND publication_enabled)
      OR (control_state = 'contained' AND NOT enrollment_enabled AND NOT upload_registration_enabled
        AND NOT processing_enabled AND NOT publication_enabled)
      OR (control_state = 'degraded'
        AND NOT (enrollment_enabled AND upload_registration_enabled
          AND processing_enabled AND publication_enabled)
        AND (enrollment_enabled OR upload_registration_enabled
          OR processing_enabled OR publication_enabled)))
  );

  -- Insert-only receipts: written while the run may write, never changed.
  CREATE FUNCTION tibotattle_transfer.transfer_insert_only_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'TRANSFER_RECEIPT_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF tibotattle_transfer.transfer_write_allowed(NEW.run_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'TRANSFER_WRITE_REFUSED' USING ERRCODE = 'P1005';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER transfer_object_erasures_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_object_erasures
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_insert_only_guard();
  CREATE TRIGGER transfer_object_erasures_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_object_erasures
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();
  CREATE TRIGGER transfer_dropped_relations_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.transfer_dropped_relations
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_insert_only_guard();
  CREATE TRIGGER transfer_dropped_relations_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.transfer_dropped_relations
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();
  CREATE TRIGGER sealed_collection_controls_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.sealed_collection_controls
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.transfer_insert_only_guard();
  CREATE TRIGGER sealed_collection_controls_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.sealed_collection_controls
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  INSERT INTO tibotattle_transfer.transfer_control_installations(component, migration_name)
  VALUES ('primary', '0056_production_transfer_control.sql');

  REVOKE ALL ON SCHEMA tibotattle_transfer FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA tibotattle_transfer FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tibotattle_transfer FROM PUBLIC;
END;
$install$;
