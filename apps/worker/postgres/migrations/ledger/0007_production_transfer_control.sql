-- PT-1 production transfer control schema (ledger).
--
-- The ledger database carries its own tibotattle_transfer schema: a mirror of
-- the primary transfer run (same run id, contract id and seal id, moved
-- forward in lockstep by the transfer module) and the same whole-schema live
-- lock. The erasure-ledger import binds to this run; once it is live every
-- relation of the schema refuses writes. Nothing is granted to any role; the
-- owner is the migration role, reached by transfer tools through SET ROLE.
--
-- As in primary 0056 the schema is database-scoped and installed once per
-- database under a transaction advisory lock. The shared block is identical
-- to the primary migration's, so either role may install first when both
-- share a database. Every name is qualified; functions pin search_path to
-- pg_catalog. Guards raise constant messages with ERRCODE P1005. No backfill.

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
                 WHERE installation.component = 'ledger') THEN
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

  -- The ledger mirror of the primary transfer run. States move forward only;
  -- 'live' and 'abandoned' are terminal, and at most one run is not abandoned.
  CREATE TABLE tibotattle_transfer.ledger_transfer_runs (
    run_id text PRIMARY KEY
      CHECK (run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    contract_id text NOT NULL CHECK (contract_id ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
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
  CREATE UNIQUE INDEX ledger_transfer_runs_one_open
    ON tibotattle_transfer.ledger_transfer_runs ((true)) WHERE state <> 'abandoned';

  CREATE FUNCTION tibotattle_transfer.ledger_transfer_runs_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'TRANSFER_RUN_IMMUTABLE' USING ERRCODE = 'P1005';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF NEW.state IS DISTINCT FROM 'preflight'
         OR EXISTS (SELECT 1 FROM tibotattle_transfer.ledger_transfer_runs run WHERE run.state = 'live') THEN
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
  CREATE TRIGGER ledger_transfer_runs_guard
    BEFORE INSERT OR UPDATE OR DELETE ON tibotattle_transfer.ledger_transfer_runs
    FOR EACH ROW EXECUTE FUNCTION tibotattle_transfer.ledger_transfer_runs_guard();
  CREATE TRIGGER ledger_transfer_runs_no_truncate
    BEFORE TRUNCATE ON tibotattle_transfer.ledger_transfer_runs
    FOR EACH STATEMENT EXECUTE FUNCTION tibotattle_transfer.transfer_control_row_immutable();

  INSERT INTO tibotattle_transfer.transfer_control_installations(component, migration_name)
  VALUES ('ledger', '0007_production_transfer_control.sql');

  REVOKE ALL ON SCHEMA tibotattle_transfer FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA tibotattle_transfer FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tibotattle_transfer FROM PUBLIC;
END;
$install$;
