-- Accountless daily model-performance intake and its community publication
-- heads (owner decisions 2026-10-10, docs/decisions/2026-10-10-community-model-speed.md;
-- orchestrator gate answers 2026-10-11).
--
-- NUMBER. Promoted directly as primary 0079 (no staged step), so every later
-- item runs on the real chain. If the live head already holds 0079 or higher
-- when this ships, the integrator renumbers it and moves the same pin set.
--
-- ADDITIVE. Every relation and function is new. Nothing here drops, renames,
-- retypes, tightens or adds a constraint or unique index to a pre-existing
-- table, and there is no dynamic SQL, so the production migrate step's
-- classifier finds no contract operation and CONTRACT_MIGRATIONS gains no
-- entry. No grants: the migrate job's runtime-grant policy covers tables, and
-- no function here is revoked from PUBLIC.
--
-- CONTENT-FREE. Rows hold only closed labels, counts, histogram bucket counts,
-- digests, revisions and instants. No prompt, response, command, path,
-- filename, raw account id or session content has a column here. The
-- refusal counters and the publication heads hold no participant, device or
-- owner identifier at all.
--
-- APPEND-ONLY. Grants, capabilities, cohorts, buckets and receipts are
-- immutable; a grant or capability moves only active/accepted -> revoked, and
-- a report only current -> superseded. The three registry rows are the only
-- ones: INSERT, UPDATE and DELETE are all refused once they are seeded, so the
-- runtime role (which holds DML on every table) cannot add a dictionary that
-- the foreign keys would then accept. A later migration that registers a new
-- dictionary disables and re-enables that trigger around its own INSERT. The
-- runtime moves only staged -> active, one policy revision at a time, inside
-- the owner run_maintenance transaction that began its audit row. A
-- publication head only moves forward (0059's analytics_v2_published_daily
-- rule).
--
-- ERASURE. Accepted evidence is not withdrawn (decision D2, Variant B). A
-- direct DELETE of a grant, capability, report, cohort, bucket or receipt is
-- refused while its participant is active (0027's rule); the offline owner
-- purge's DELETE FROM participants cascades through every performance row,
-- while the enrollment ledger rows (ON DELETE RESTRICT) remain. The
-- publication heads and refusal counters carry no owner, so they stay out of
-- the offline-purge inventory and are recomputed.
--
-- LOCKS. The new foreign keys take SHARE ROW EXCLUSIVE on participants,
-- device_credentials, accountless_enrollment_ledger and analytics_v2_kernels
-- for the migration transaction, within the runner's 5 s lock timeout. Apply
-- it with the scheduler paused; a lock timeout rolls back and is rerun.
--
-- Source: D1 ingestion-isolation 0009 (client-line 0013 shapes), adapted:
--   * every released field dictionary is accepted; the dictionary -> bucket
--     scheme pairing lives in telemetry_performance_field_dictionaries and is
--     enforced by composite foreign keys down to every bucket row;
--   * 2026-09-21.1 keeps speed_mode_source 'turn_context_service_tier' (the
--     contract allows it); only its Ultrafast labels are refused;
--   * speed buckets 0..60 (v1) or 0..95 (v2); ttft 0..57; turnDuration 1..57;
--   * accountless only: the signed-in consent route stays retired;
--   * the grant records how its dictionary was chosen (dictionary_basis):
--     v1 grants by v1.2 parser inference, or the 2026-09-29.1 default when the
--     device has no v1.2 manifest or an unmapped parser (gate answer 1); v2
--     grants by client declaration.
-- Every function is plpgsql with a pinned search_path; every RAISE carries a
-- constant message and ERRCODE P1005, and no NEW or OLD value is ever
-- interpolated into a message.

-- ---------------------------------------------------------------------------
-- Advisory-lock keys. The triggers below and the TypeScript writers call the
-- same functions, so the key is derived in exactly one place. The report day
-- is rendered with to_char, never ::text, whose output follows DateStyle.
-- ---------------------------------------------------------------------------
CREATE FUNCTION telemetry_performance_grant_lock_key(enrollment_device_id text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF enrollment_device_id IS NULL THEN
    RAISE EXCEPTION 'telemetry_performance_lock_key_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN hashtextextended('tibotattle:performance-grant:' || enrollment_device_id, 0);
END;
$$;

CREATE FUNCTION telemetry_performance_capability_lock_key(participant_id text, device_id text) RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF participant_id IS NULL OR device_id IS NULL THEN
    RAISE EXCEPTION 'telemetry_performance_lock_key_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN hashtextextended('tibotattle:performance-capability:' || participant_id || ':' || device_id, 0);
END;
$$;

CREATE FUNCTION telemetry_performance_report_lock_key(participant_id text, device_id text, report_day date)
RETURNS bigint
LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF participant_id IS NULL OR device_id IS NULL OR report_day IS NULL THEN
    RAISE EXCEPTION 'telemetry_performance_lock_key_invalid' USING ERRCODE = 'P1005';
  END IF;
  RETURN hashtextextended('tibotattle:performance-report:' || participant_id || ':' || device_id
    || ':' || to_char(report_day, 'YYYY-MM-DD'), 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- (a) Field dictionary registry: three immutable seeded rows, and no others.
-- ---------------------------------------------------------------------------
CREATE TABLE telemetry_performance_field_dictionaries (
  field_dictionary_version text PRIMARY KEY
    CHECK (field_dictionary_version ~ '^telemetry-performance-registry-[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$'),
  bucket_scheme_version text NOT NULL
    CHECK (bucket_scheme_version IN ('performance-histogram-v1', 'performance-histogram-v2')),
  ultrafast_labels boolean NOT NULL,
  registered_at timestamptz NOT NULL,
  UNIQUE (field_dictionary_version, bucket_scheme_version)
);
INSERT INTO telemetry_performance_field_dictionaries
  (field_dictionary_version, bucket_scheme_version, ultrafast_labels, registered_at)
VALUES
  ('telemetry-performance-registry-2026-09-21.1', 'performance-histogram-v1', false, TIMESTAMPTZ '2026-09-21 00:00:00+00'),
  ('telemetry-performance-registry-2026-09-29.1', 'performance-histogram-v1', true, TIMESTAMPTZ '2026-09-29 00:00:00+00'),
  ('telemetry-performance-registry-2026-10-10.1', 'performance-histogram-v2', true, TIMESTAMPTZ '2026-10-10 00:00:00+00');

CREATE FUNCTION telemetry_performance_row_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'telemetry_performance_row_immutable' USING ERRCODE = 'P1005';
END;
$$;
-- INSERT is refused too: the seed above runs before the trigger exists, and
-- every later row would widen the dictionary foreign keys of grants,
-- capabilities and reports. (TRUNCATE is refused by those foreign keys, and
-- the runtime role holds no TRUNCATE privilege.)
CREATE TRIGGER telemetry_performance_field_dictionaries_immutable
BEFORE INSERT OR UPDATE OR DELETE ON telemetry_performance_field_dictionaries
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_row_immutable();

-- ---------------------------------------------------------------------------
-- (b) Runtime singleton, seeded staged at revision 1.
-- ---------------------------------------------------------------------------
CREATE TABLE telemetry_performance_runtime (
  id smallint PRIMARY KEY CHECK (id = 1),
  schema_version text NOT NULL CHECK (schema_version = 'model-performance-daily-v1'),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'privacy-safe-model-performance-v1'),
  method_version text NOT NULL CHECK (method_version = 'performance-daily-histogram-v1'),
  state text NOT NULL CHECK (state IN ('staged', 'active')),
  policy_revision integer NOT NULL CHECK (policy_revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
INSERT INTO telemetry_performance_runtime (
  id, schema_version, privacy_contract_version, method_version, state,
  policy_revision, created_at, updated_at
) VALUES (
  1, 'model-performance-daily-v1', 'privacy-safe-model-performance-v1',
  'performance-daily-histogram-v1', 'staged', 1,
  TIMESTAMPTZ '1970-01-01 00:00:00+00', TIMESTAMPTZ '1970-01-01 00:00:00+00'
);

-- Owner-only activation: exactly staged -> active, one policy revision, a
-- later updated_at, and only inside a transaction that names a 'started'
-- run_maintenance audit row in tibotattle.telemetry_performance_activation
-- (the activation task sets it with set_config(..., true) after beginning
-- that audit row in the same transaction). The audit row must have been
-- inserted by this very transaction, at its top level (xmin equals the
-- current transaction id, 0035's idiom): a 'started' row left behind by a
-- crashed or earlier activation can never be named again. There is no pause
-- and no delete. The runtime role can insert audit rows and set the GUC, so
-- owner-only activation stays an application-layer guarantee; this guard
-- makes every activation carry its own fresh audit row.
CREATE FUNCTION telemetry_performance_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'telemetry_performance_runtime_guarded' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.privacy_contract_version IS DISTINCT FROM OLD.privacy_contract_version
      OR NEW.method_version IS DISTINCT FROM OLD.method_version
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision + 1
      OR NOT (NEW.updated_at > OLD.updated_at)
      OR OLD.state IS DISTINCT FROM 'staged'
      OR NEW.state IS DISTINCT FROM 'active'
      OR NOT EXISTS (
        SELECT 1 FROM admin_action_audit audit_row
         WHERE audit_row.operation_id = current_setting('tibotattle.telemetry_performance_activation', true)
           AND audit_row.action = 'run_maintenance'
           AND audit_row.outcome = 'started'
           AND audit_row.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'telemetry_performance_runtime_guarded' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_performance_runtime_guard
BEFORE UPDATE OR DELETE ON telemetry_performance_runtime
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_runtime_guard();

-- ---------------------------------------------------------------------------
-- (c) Accountless performance grant (separate from the v1.2 usage grant).
-- ---------------------------------------------------------------------------
CREATE TABLE accountless_telemetry_performance_authorizations (
  enrollment_device_id text NOT NULL
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  schema_version text NOT NULL
    CHECK (schema_version IN ('accountless-performance-owner-v1', 'accountless-performance-owner-v2')),
  policy_version text NOT NULL CHECK (policy_version = 'accountless-telemetry-performance-policy-v1'),
  authorization_basis text NOT NULL CHECK (authorization_basis = 'accountless-performance-policy-v1'),
  performance_schema_version text NOT NULL CHECK (performance_schema_version = 'model-performance-daily-v1'),
  field_dictionary_version text NOT NULL
    REFERENCES telemetry_performance_field_dictionaries(field_dictionary_version),
  dictionary_basis text NOT NULL
    CHECK (dictionary_basis IN ('v12_parser_inference', 'default_no_manifest', 'client_declared')),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'privacy-safe-model-performance-v1'),
  scope text NOT NULL CHECK (scope = 'model-performance-daily'),
  capability_revision integer NOT NULL CHECK (capability_revision >= 1),
  authority_epoch integer NOT NULL CHECK (authority_epoch >= 1),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at timestamptz,
  revocation_reason text CHECK (revocation_reason IS NULL OR revocation_reason IN (
    'user_opt_out', 'security_reset', 'operator_containment')),
  PRIMARY KEY (enrollment_device_id, capability_revision, authority_epoch),
  CHECK (expires_at > authorized_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)),
  -- A v1 body names no dictionary: the server infers it from the device's
  -- newest v1.2 manifest parser, or defaults to 2026-09-29.1 when there is no
  -- manifest or the parser is unmapped. A v2 body declares it.
  CHECK ((schema_version = 'accountless-performance-owner-v1'
      AND dictionary_basis IN ('v12_parser_inference', 'default_no_manifest'))
    OR (schema_version = 'accountless-performance-owner-v2' AND dictionary_basis = 'client_declared')),
  CHECK (dictionary_basis <> 'v12_parser_inference' OR field_dictionary_version IN (
    'telemetry-performance-registry-2026-09-21.1', 'telemetry-performance-registry-2026-09-29.1')),
  CHECK (dictionary_basis <> 'default_no_manifest'
    OR field_dictionary_version = 'telemetry-performance-registry-2026-09-29.1')
);
CREATE INDEX accountless_telemetry_performance_authorizations_active
  ON accountless_telemetry_performance_authorizations(state, expires_at);
CREATE INDEX accountless_telemetry_performance_authorizations_participant
  ON accountless_telemetry_performance_authorizations(participant_id, device_credential_id);

-- The grant head is monotonic per enrollment: revision + 1 each time; the
-- authority epoch advances only on the first grant and after a revoked head,
-- so an expiry slide or dictionary change keeps the epoch. Admission re-proves
-- the active accountless owner graph, equal expiries and an active runtime.
CREATE FUNCTION accountless_telemetry_performance_authorization_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  head_revision integer;
  head_epoch integer;
  head_state text;
  expected_epoch integer;
BEGIN
  PERFORM pg_advisory_xact_lock(telemetry_performance_grant_lock_key(NEW.enrollment_device_id));
  SELECT prior.capability_revision, prior.authority_epoch, prior.state
    INTO head_revision, head_epoch, head_state
    FROM accountless_telemetry_performance_authorizations prior
   WHERE prior.enrollment_device_id = NEW.enrollment_device_id
   ORDER BY prior.capability_revision DESC, prior.authority_epoch DESC
   LIMIT 1;
  expected_epoch := COALESCE(head_epoch, 0);
  IF head_revision IS NULL OR head_state = 'revoked' THEN
    expected_epoch := expected_epoch + 1;
  END IF;
  IF NEW.capability_revision IS DISTINCT FROM COALESCE(head_revision, 0) + 1
      OR NEW.authority_epoch IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'accountless_telemetry_performance_authorization_revision_conflict' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.state IS DISTINCT FROM 'active' OR NOT EXISTS (
    SELECT 1
      FROM accountless_upload_owners owner
      JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
      JOIN participants p ON p.id = owner.participant_id
      JOIN device_credentials d ON d.id = owner.device_credential_id
      JOIN telemetry_performance_runtime r ON r.id = 1
     WHERE owner.enrollment_device_id = NEW.enrollment_device_id
       AND owner.participant_id = NEW.participant_id
       AND owner.device_credential_id = NEW.device_credential_id
       AND owner.state = 'active' AND owner.expires_at = NEW.expires_at
       AND ledger.state = 'active' AND ledger.expires_at = NEW.expires_at
       AND p.state = 'active' AND p.owner_kind = 'accountless'
       AND d.state = 'active' AND d.authority_kind = 'accountless'
       AND d.participant_id = p.id
       AND d.accountless_enrollment_device_id = NEW.enrollment_device_id
       AND d.expires_at = NEW.expires_at
       AND NEW.expires_at > now()
       AND r.state = 'active'
       AND NEW.performance_schema_version = r.schema_version
       AND NEW.privacy_contract_version = r.privacy_contract_version) THEN
    RAISE EXCEPTION 'accountless_telemetry_performance_authorization_unavailable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_telemetry_performance_authorization_admission
BEFORE INSERT ON accountless_telemetry_performance_authorizations
FOR EACH ROW EXECUTE FUNCTION accountless_telemetry_performance_authorization_admission();

-- Immutable but for the revocation that follows a revoked enrollment
-- (D1 ingestion-isolation 0009's rule, kept on purpose). The Worker never
-- revokes a performance grant on its own: its enrollment revocation batch
-- (src/accountless-enrollment.ts) revokes the ledger, then the owner and the
-- v1.1/v1.2 grants behind that revoked ledger, and leaves performance grants
-- and capabilities untouched. They go inert instead, because every
-- admission, capability and report fence requires the active owner graph.
-- So the reasons user_opt_out and operator_containment apply to a grant only
-- with its whole enrollment. The capability chain runs beside the grant
-- chain (D1 parity too): a writer appends a grant and its capability in one
-- transaction, and revokes them together, because a grant committed or
-- revoked without its capability leaves the capability head unable to follow
-- the grant head for that device.
CREATE FUNCTION accountless_telemetry_performance_authorization_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.enrollment_device_id, NEW.participant_id, NEW.device_credential_id, NEW.schema_version,
      NEW.policy_version, NEW.authorization_basis, NEW.performance_schema_version,
      NEW.field_dictionary_version, NEW.dictionary_basis, NEW.privacy_contract_version, NEW.scope,
      NEW.capability_revision, NEW.authority_epoch, NEW.authorized_at, NEW.expires_at)
      IS DISTINCT FROM
     (OLD.enrollment_device_id, OLD.participant_id, OLD.device_credential_id, OLD.schema_version,
      OLD.policy_version, OLD.authorization_basis, OLD.performance_schema_version,
      OLD.field_dictionary_version, OLD.dictionary_basis, OLD.privacy_contract_version, OLD.scope,
      OLD.capability_revision, OLD.authority_epoch, OLD.authorized_at, OLD.expires_at)
      OR OLD.state IS DISTINCT FROM 'active'
      OR NEW.state IS DISTINCT FROM 'revoked'
      OR NOT EXISTS (
        SELECT 1 FROM accountless_enrollment_ledger ledger
         WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked') THEN
    RAISE EXCEPTION 'accountless_telemetry_performance_authorization_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accountless_telemetry_performance_authorization_immutable
BEFORE UPDATE ON accountless_telemetry_performance_authorizations
FOR EACH ROW EXECUTE FUNCTION accountless_telemetry_performance_authorization_immutable();

-- ---------------------------------------------------------------------------
-- (d) The capability the device reads: accountless only; its tuple,
-- dictionary, basis and expiry equal the authorization head's.
-- ---------------------------------------------------------------------------
CREATE TABLE telemetry_performance_device_capabilities (
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  schema_version text NOT NULL CHECK (schema_version = 'model-performance-daily-v1'),
  field_dictionary_version text NOT NULL
    REFERENCES telemetry_performance_field_dictionaries(field_dictionary_version),
  dictionary_basis text NOT NULL
    CHECK (dictionary_basis IN ('v12_parser_inference', 'default_no_manifest', 'client_declared')),
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'privacy-safe-model-performance-v1'),
  scope text NOT NULL CHECK (scope = 'model-performance-daily'),
  capability_revision integer NOT NULL CHECK (capability_revision >= 1),
  authority_epoch integer NOT NULL CHECK (authority_epoch >= 1),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('accepted', 'revoked')),
  consented_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (participant_id, device_id, capability_revision, authority_epoch),
  CHECK (expires_at > issued_at),
  CHECK ((state = 'accepted' AND revoked_at IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX telemetry_performance_capabilities_device
  ON telemetry_performance_device_capabilities(device_id, state, expires_at);

CREATE FUNCTION telemetry_performance_capability_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  head_revision integer;
  head_epoch integer;
  head_state text;
  expected_epoch integer;
BEGIN
  PERFORM pg_advisory_xact_lock(telemetry_performance_capability_lock_key(NEW.participant_id, NEW.device_id));
  SELECT prior.capability_revision, prior.authority_epoch, prior.state
    INTO head_revision, head_epoch, head_state
    FROM telemetry_performance_device_capabilities prior
   WHERE prior.participant_id = NEW.participant_id AND prior.device_id = NEW.device_id
   ORDER BY prior.capability_revision DESC, prior.authority_epoch DESC
   LIMIT 1;
  expected_epoch := COALESCE(head_epoch, 0);
  IF head_revision IS NULL OR head_state = 'revoked' THEN
    expected_epoch := expected_epoch + 1;
  END IF;
  IF NEW.capability_revision IS DISTINCT FROM COALESCE(head_revision, 0) + 1
      OR NEW.authority_epoch IS DISTINCT FROM expected_epoch THEN
    RAISE EXCEPTION 'telemetry_performance_capability_revision_conflict' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.state IS DISTINCT FROM 'accepted' OR NOT EXISTS (
    SELECT 1
      FROM telemetry_performance_runtime r
      JOIN participants p ON p.id = NEW.participant_id
      JOIN device_credentials d ON d.id = NEW.device_id AND d.participant_id = p.id
      JOIN accountless_telemetry_performance_authorizations a
        ON a.participant_id = p.id AND a.device_credential_id = d.id
      JOIN accountless_upload_owners owner ON owner.enrollment_device_id = a.enrollment_device_id
      JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
     WHERE r.id = 1 AND r.state = 'active'
       AND NEW.schema_version = r.schema_version
       AND NEW.privacy_contract_version = r.privacy_contract_version
       AND p.state = 'active' AND p.owner_kind = 'accountless'
       AND d.state = 'active' AND d.authority_kind = 'accountless'
       AND d.accountless_enrollment_device_id = a.enrollment_device_id
       AND a.state = 'active' AND a.expires_at > now()
       AND a.capability_revision = NEW.capability_revision
       AND a.authority_epoch = NEW.authority_epoch
       AND a.field_dictionary_version = NEW.field_dictionary_version
       AND a.dictionary_basis = NEW.dictionary_basis
       AND a.performance_schema_version = NEW.schema_version
       AND a.privacy_contract_version = NEW.privacy_contract_version
       AND a.scope = NEW.scope
       AND a.expires_at = NEW.expires_at
       AND NOT EXISTS (
         SELECT 1 FROM accountless_telemetry_performance_authorizations later
          WHERE later.enrollment_device_id = a.enrollment_device_id
            AND (later.capability_revision, later.authority_epoch) > (a.capability_revision, a.authority_epoch))
       AND owner.state = 'active' AND ledger.state = 'active'
       AND owner.participant_id = a.participant_id
       AND owner.device_credential_id = a.device_credential_id
       AND owner.expires_at = a.expires_at AND ledger.expires_at = a.expires_at) THEN
    RAISE EXCEPTION 'telemetry_performance_capability_unavailable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_performance_capability_admission
BEFORE INSERT ON telemetry_performance_device_capabilities
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_capability_admission();

CREATE FUNCTION telemetry_performance_capability_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.participant_id, NEW.device_id, NEW.schema_version, NEW.field_dictionary_version,
      NEW.dictionary_basis, NEW.privacy_contract_version, NEW.scope, NEW.capability_revision,
      NEW.authority_epoch, NEW.issued_at, NEW.expires_at, NEW.consented_at)
      IS DISTINCT FROM
     (OLD.participant_id, OLD.device_id, OLD.schema_version, OLD.field_dictionary_version,
      OLD.dictionary_basis, OLD.privacy_contract_version, OLD.scope, OLD.capability_revision,
      OLD.authority_epoch, OLD.issued_at, OLD.expires_at, OLD.consented_at)
      OR OLD.state IS DISTINCT FROM 'accepted'
      OR NEW.state IS DISTINCT FROM 'revoked' THEN
    RAISE EXCEPTION 'telemetry_performance_capability_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_performance_capability_immutable
BEFORE UPDATE ON telemetry_performance_device_capabilities
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_capability_immutable();

-- ---------------------------------------------------------------------------
-- (e) Reports, cohorts, buckets and receipts. One revisioned report per
-- device/day; a zero-record report is a day tombstone (no fabricated cohort).
-- Supersession is the only update.
-- ---------------------------------------------------------------------------
CREATE TABLE telemetry_performance_reports (
  id text PRIMARY KEY CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  report_day date NOT NULL,
  report_revision text NOT NULL CHECK (report_revision ~ '^[0-9a-f]{64}$'),
  source_generation text NOT NULL CHECK (source_generation ~ '^[A-Za-z0-9._:-]{1,128}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 0 AND 9007199254740991),
  method_version text NOT NULL CHECK (method_version ~ '^[A-Za-z0-9._:-]{1,128}$'),
  parser_version text NOT NULL CHECK (parser_version ~ '^[A-Za-z0-9._:-]{1,128}$'),
  schema_version text NOT NULL CHECK (schema_version = 'model-performance-daily-v1'),
  field_dictionary_version text NOT NULL,
  bucket_scheme_version text NOT NULL,
  privacy_contract_version text NOT NULL CHECK (privacy_contract_version = 'privacy-safe-model-performance-v1'),
  measurement_version text NOT NULL CHECK (measurement_version = 'model-performance-samples-v1'),
  record_count integer NOT NULL CHECK (record_count BETWEEN 0 AND 1024),
  canonical_bytes integer NOT NULL CHECK (canonical_bytes BETWEEN 1 AND 1250000),
  capability_revision integer NOT NULL CHECK (capability_revision >= 1),
  authority_epoch integer NOT NULL CHECK (authority_epoch >= 1),
  state text NOT NULL CHECK (state IN ('current', 'superseded')),
  created_at timestamptz NOT NULL,
  superseded_at timestamptz,
  FOREIGN KEY (field_dictionary_version, bucket_scheme_version)
    REFERENCES telemetry_performance_field_dictionaries(field_dictionary_version, bucket_scheme_version),
  UNIQUE (participant_id, device_id, report_day, report_revision),
  UNIQUE (id, field_dictionary_version, bucket_scheme_version),
  -- The receipts' composite foreign key: a receipt names its report's owner,
  -- day and revision exactly.
  UNIQUE (id, participant_id, device_id, report_day, report_revision),
  CHECK ((state = 'current' AND superseded_at IS NULL)
    OR (state = 'superseded' AND superseded_at IS NOT NULL AND superseded_at >= created_at))
);
CREATE UNIQUE INDEX telemetry_performance_current_day
  ON telemetry_performance_reports(participant_id, device_id, report_day)
  WHERE state = 'current';
CREATE INDEX telemetry_performance_reports_owner_day
  ON telemetry_performance_reports(participant_id, report_day, state, created_at);
CREATE INDEX telemetry_performance_reports_community_day
  ON telemetry_performance_reports(report_day, id)
  WHERE state = 'current';

-- Admission: the report's tuple and dictionary equal the device's current,
-- unexpired capability head, which equals the current authorization head,
-- under an active runtime and an active accountless owner graph. Source
-- revisions only move forward per device/day.
CREATE FUNCTION telemetry_performance_report_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    telemetry_performance_report_lock_key(NEW.participant_id, NEW.device_id, NEW.report_day));
  IF EXISTS (
    SELECT 1 FROM telemetry_performance_reports prior
     WHERE prior.participant_id = NEW.participant_id
       AND prior.device_id = NEW.device_id
       AND prior.report_day = NEW.report_day
       AND (prior.source_revision > NEW.source_revision
         OR (prior.source_revision = NEW.source_revision
           AND (prior.source_generation IS DISTINCT FROM NEW.source_generation
             OR prior.source_digest IS DISTINCT FROM NEW.source_digest)))) THEN
    RAISE EXCEPTION 'telemetry_performance_report_revision_conflict' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.state IS DISTINCT FROM 'current' OR NOT EXISTS (
    SELECT 1
      FROM telemetry_performance_runtime r
      JOIN participants p ON p.id = NEW.participant_id
      JOIN device_credentials d ON d.id = NEW.device_id AND d.participant_id = p.id
      JOIN telemetry_performance_device_capabilities c
        ON c.participant_id = p.id AND c.device_id = d.id
      JOIN accountless_telemetry_performance_authorizations a
        ON a.participant_id = p.id AND a.device_credential_id = d.id
       AND a.capability_revision = c.capability_revision AND a.authority_epoch = c.authority_epoch
      JOIN accountless_upload_owners owner ON owner.enrollment_device_id = a.enrollment_device_id
      JOIN accountless_enrollment_ledger ledger ON ledger.device_id = owner.enrollment_device_id
     WHERE r.id = 1 AND r.state = 'active'
       AND NEW.schema_version = r.schema_version
       AND NEW.privacy_contract_version = r.privacy_contract_version
       AND NEW.method_version = r.method_version
       AND p.state = 'active' AND p.owner_kind = 'accountless'
       AND d.state = 'active' AND d.authority_kind = 'accountless'
       AND d.accountless_enrollment_device_id = a.enrollment_device_id
       AND c.state = 'accepted' AND c.expires_at > now()
       AND NOT EXISTS (
         SELECT 1 FROM telemetry_performance_device_capabilities later
          WHERE later.participant_id = c.participant_id AND later.device_id = c.device_id
            AND (later.capability_revision, later.authority_epoch) > (c.capability_revision, c.authority_epoch))
       AND NEW.capability_revision = c.capability_revision
       AND NEW.authority_epoch = c.authority_epoch
       AND NEW.field_dictionary_version = c.field_dictionary_version
       AND a.state = 'active' AND a.expires_at > now()
       AND a.field_dictionary_version = c.field_dictionary_version
       AND a.dictionary_basis = c.dictionary_basis
       AND a.expires_at = c.expires_at
       AND NOT EXISTS (
         SELECT 1 FROM accountless_telemetry_performance_authorizations later
          WHERE later.enrollment_device_id = a.enrollment_device_id
            AND (later.capability_revision, later.authority_epoch) > (a.capability_revision, a.authority_epoch))
       AND owner.state = 'active' AND ledger.state = 'active'
       AND owner.participant_id = a.participant_id
       AND owner.device_credential_id = a.device_credential_id
       AND owner.expires_at = a.expires_at AND ledger.expires_at = a.expires_at) THEN
    RAISE EXCEPTION 'telemetry_performance_report_admission_denied' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_performance_report_admission
BEFORE INSERT ON telemetry_performance_reports
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_report_admission();

CREATE FUNCTION telemetry_performance_report_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.id, NEW.participant_id, NEW.device_id, NEW.report_day, NEW.report_revision,
      NEW.source_generation, NEW.source_digest, NEW.source_revision, NEW.method_version,
      NEW.parser_version, NEW.schema_version, NEW.field_dictionary_version, NEW.bucket_scheme_version,
      NEW.privacy_contract_version, NEW.measurement_version, NEW.record_count, NEW.canonical_bytes,
      NEW.capability_revision, NEW.authority_epoch, NEW.created_at)
      IS DISTINCT FROM
     (OLD.id, OLD.participant_id, OLD.device_id, OLD.report_day, OLD.report_revision,
      OLD.source_generation, OLD.source_digest, OLD.source_revision, OLD.method_version,
      OLD.parser_version, OLD.schema_version, OLD.field_dictionary_version, OLD.bucket_scheme_version,
      OLD.privacy_contract_version, OLD.measurement_version, OLD.record_count, OLD.canonical_bytes,
      OLD.capability_revision, OLD.authority_epoch, OLD.created_at)
      OR OLD.state IS DISTINCT FROM 'current'
      OR NEW.state IS DISTINCT FROM 'superseded' THEN
    RAISE EXCEPTION 'telemetry_performance_report_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER telemetry_performance_report_immutable
BEFORE UPDATE ON telemetry_performance_reports
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_report_immutable();

CREATE TABLE telemetry_performance_cohorts (
  report_id text NOT NULL,
  cohort_index integer NOT NULL CHECK (cohort_index BETWEEN 0 AND 1023),
  field_dictionary_version text NOT NULL,
  bucket_scheme_version text NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9._:-]{1,64}$'),
  model_id text NOT NULL CHECK (model_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  reasoning_effort text NOT NULL CHECK (reasoning_effort ~ '^[A-Za-z0-9._:-]{1,16}$'),
  speed_method text NOT NULL CHECK (speed_method IN ('receipt', 'legacy', 'tool_free', 'unavailable')),
  speed_mode text NOT NULL CHECK (speed_mode IN ('fast', 'standard', 'unknown', 'other', 'mixed', 'ultrafast')),
  speed_mode_source text NOT NULL CHECK (speed_mode_source IN (
    'rollout_thread_settings', 'turn_context_service_tier', 'lineage_inherited', 'unobserved', 'mixed')),
  api_service_tier text NOT NULL CHECK (api_service_tier IN (
    'standard', 'priority', 'flex', 'batch', 'unknown', 'other', 'mixed', 'ultrafast')),
  turns bigint NOT NULL CHECK (turns BETWEEN 1 AND 9007199254740991),
  speed_turns bigint NOT NULL CHECK (speed_turns BETWEEN 0 AND 9007199254740991),
  ttft_turns bigint NOT NULL CHECK (ttft_turns BETWEEN 0 AND 9007199254740991),
  completion_turns bigint NOT NULL CHECK (completion_turns BETWEEN 0 AND 9007199254740991),
  timed_responses bigint NOT NULL CHECK (timed_responses BETWEEN 0 AND 9007199254740991),
  speed_tokens bigint NOT NULL CHECK (speed_tokens BETWEEN 0 AND 9007199254740991),
  speed_duration_ms bigint NOT NULL CHECK (speed_duration_ms BETWEEN 0 AND 9007199254740991),
  speed_min bigint CHECK (speed_min BETWEEN 0 AND 9007199254740991),
  speed_max bigint CHECK (speed_max BETWEEN 0 AND 9007199254740991),
  ttft_min bigint CHECK (ttft_min BETWEEN 0 AND 9007199254740991),
  ttft_max bigint CHECK (ttft_max BETWEEN 0 AND 9007199254740991),
  completion_min bigint CHECK (completion_min BETWEEN 1 AND 9007199254740991),
  completion_max bigint CHECK (completion_max BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (report_id, cohort_index),
  UNIQUE (report_id, cohort_index, bucket_scheme_version),
  FOREIGN KEY (report_id, field_dictionary_version, bucket_scheme_version)
    REFERENCES telemetry_performance_reports(id, field_dictionary_version, bucket_scheme_version)
    ON DELETE CASCADE,
  CHECK (speed_turns <= turns AND ttft_turns <= turns AND completion_turns <= turns),
  CHECK (timed_responses >= speed_turns),
  -- 2026-09-21.1 (clients 0.1.24-0.1.26) has no Ultrafast labels: its
  -- Ultrafast turns are 'other'. Its speed_mode_source vocabulary is the full
  -- one, turn_context_service_tier included.
  CHECK (field_dictionary_version <> 'telemetry-performance-registry-2026-09-21.1'
    OR (speed_mode <> 'ultrafast' AND api_service_tier <> 'ultrafast')),
  CHECK ((speed_mode = 'unknown' AND speed_mode_source = 'unobserved')
    OR (speed_mode = 'mixed' AND speed_mode_source = 'mixed')
    OR (speed_mode IN ('fast', 'standard', 'ultrafast', 'other')
      AND speed_mode_source IN ('rollout_thread_settings', 'turn_context_service_tier', 'lineage_inherited'))),
  CHECK (speed_method <> 'unavailable' OR (speed_turns = 0 AND timed_responses = 0
    AND speed_tokens = 0 AND speed_duration_ms = 0)),
  CHECK (speed_method = 'unavailable' OR (speed_turns = turns
    AND speed_tokens >= speed_turns AND speed_duration_ms >= speed_turns)),
  CHECK ((speed_turns = 0) = (speed_min IS NULL) AND (speed_min IS NULL) = (speed_max IS NULL)
    AND (speed_min IS NULL OR speed_min <= speed_max)),
  CHECK ((ttft_turns = 0) = (ttft_min IS NULL) AND (ttft_min IS NULL) = (ttft_max IS NULL)
    AND (ttft_min IS NULL OR ttft_min <= ttft_max)),
  CHECK ((completion_turns = 0) = (completion_min IS NULL) AND (completion_min IS NULL) = (completion_max IS NULL)
    AND (completion_min IS NULL OR completion_min <= completion_max))
);
CREATE UNIQUE INDEX telemetry_performance_cohort_identity
  ON telemetry_performance_cohorts(
    report_id, provider, model_id, reasoning_effort, speed_method,
    speed_mode, speed_mode_source, api_service_tier);
CREATE INDEX telemetry_performance_cohorts_model
  ON telemetry_performance_cohorts(provider, model_id, speed_mode, report_id);

CREATE TABLE telemetry_performance_buckets (
  report_id text NOT NULL,
  cohort_index integer NOT NULL,
  bucket_scheme_version text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('speed', 'ttft', 'turnDuration')),
  bucket_index smallint NOT NULL CHECK (bucket_index BETWEEN 0 AND 95),
  bucket_count bigint NOT NULL CHECK (bucket_count BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (report_id, cohort_index, metric, bucket_index),
  FOREIGN KEY (report_id, cohort_index, bucket_scheme_version)
    REFERENCES telemetry_performance_cohorts(report_id, cohort_index, bucket_scheme_version)
    ON DELETE CASCADE,
  -- speed: 61 v1 buckets (60 is the overflow at 120 tokens/s) or 96 v2
  -- buckets (95 is the overflow); ttft 0..57 (0 is a real zero);
  -- turnDuration 1..57.
  CHECK ((metric = 'speed' AND bucket_scheme_version = 'performance-histogram-v1' AND bucket_index <= 60)
    OR (metric = 'speed' AND bucket_scheme_version = 'performance-histogram-v2' AND bucket_index <= 95)
    OR (metric = 'ttft' AND bucket_index <= 57)
    OR (metric = 'turnDuration' AND bucket_index BETWEEN 1 AND 57))
);

-- One receipt per admitted report. Its participant, device, day and revision
-- are its report's (composite foreign key), so with the report's own
-- UNIQUE (participant_id, device_id, report_day, report_revision) a report has
-- at most one receipt. An idempotent replay names an existing report revision
-- and writes nothing, so the outcome is accepted or replaced only (D1 0009
-- also allowed 'idempotent', which no writer ever stored).
CREATE TABLE telemetry_performance_receipts (
  id text PRIMARY KEY CHECK (length(id) = 36),
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  report_id text NOT NULL,
  report_day date NOT NULL,
  report_revision text NOT NULL CHECK (report_revision ~ '^[0-9a-f]{64}$'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'replaced')),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (report_id, participant_id, device_id, report_day, report_revision)
    REFERENCES telemetry_performance_reports(id, participant_id, device_id, report_day, report_revision)
    ON DELETE CASCADE,
  UNIQUE (participant_id, device_id, report_day, report_revision),
  UNIQUE (participant_id, device_id, envelope_digest)
);
CREATE INDEX telemetry_performance_receipts_owner
  ON telemetry_performance_receipts(participant_id, created_at, id);
CREATE INDEX telemetry_performance_receipts_report
  ON telemetry_performance_receipts(report_id);
-- The acceptance instant: max(created_at) reads one index entry (the ops
-- probe's newest acceptance and the admin section's latestAcceptedAt).
CREATE INDEX telemetry_performance_receipts_accepted_at
  ON telemetry_performance_receipts(created_at);

CREATE TRIGGER telemetry_performance_cohort_immutable
BEFORE UPDATE ON telemetry_performance_cohorts
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_row_immutable();
CREATE TRIGGER telemetry_performance_bucket_immutable
BEFORE UPDATE ON telemetry_performance_buckets
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_row_immutable();
CREATE TRIGGER telemetry_performance_receipt_immutable
BEFORE UPDATE ON telemetry_performance_receipts
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_row_immutable();

-- Accepted evidence is not withdrawn (decision D2, Variant B). A direct
-- DELETE is refused while the owner is active; the participant DELETE that
-- the offline purge performs cascades through, because by the time a
-- cascaded child row is deleted its participant row is gone (0027's rule).
CREATE FUNCTION telemetry_performance_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE owner_id text;
BEGIN
  IF TG_TABLE_NAME IN ('telemetry_performance_cohorts', 'telemetry_performance_buckets') THEN
    SELECT report.participant_id INTO owner_id
      FROM telemetry_performance_reports report WHERE report.id = OLD.report_id;
  ELSE
    owner_id := OLD.participant_id;
  END IF;
  IF owner_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM participants participant
     WHERE participant.id = owner_id AND participant.state = 'active') THEN
    RAISE EXCEPTION 'telemetry_performance_source_immutable' USING ERRCODE = 'P1005';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER accountless_telemetry_performance_authorization_delete_guard
BEFORE DELETE ON accountless_telemetry_performance_authorizations
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_delete_guard();
CREATE TRIGGER telemetry_performance_capability_delete_guard
BEFORE DELETE ON telemetry_performance_device_capabilities
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_delete_guard();
CREATE TRIGGER telemetry_performance_report_delete_guard
BEFORE DELETE ON telemetry_performance_reports
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_delete_guard();
CREATE TRIGGER telemetry_performance_cohort_delete_guard
BEFORE DELETE ON telemetry_performance_cohorts
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_delete_guard();
CREATE TRIGGER telemetry_performance_bucket_delete_guard
BEFORE DELETE ON telemetry_performance_buckets
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_delete_guard();
CREATE TRIGGER telemetry_performance_receipt_delete_guard
BEFORE DELETE ON telemetry_performance_receipts
FOR EACH ROW EXECUTE FUNCTION telemetry_performance_delete_guard();

-- ---------------------------------------------------------------------------
-- (f) Content-free refusal counters per UTC day, intake route, closed code
-- and status. No participant or device column; no retention trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE telemetry_performance_refusal_counts (
  day date NOT NULL,
  route_id text NOT NULL CHECK (route_id IN (
    'accountless_telemetry_performance_authorization',
    'telemetry_performance_capabilities',
    'telemetry_performance_reports')),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  status smallint NOT NULL CHECK (status BETWEEN 400 AND 599),
  refusals bigint NOT NULL CHECK (refusals >= 1),
  PRIMARY KEY (day, route_id, code, status)
);

-- ---------------------------------------------------------------------------
-- (h) Community publication heads (community-model-performance-v1): one
-- served head per (period, speed mode), 12 slots. Counts only: no
-- participant, device, report or owner identifier, and no owner_digest, so
-- nothing joins the offline-purge inventory; the heads are recomputed.
-- ---------------------------------------------------------------------------
CREATE TABLE analytics_v2_published_performance (
  period text NOT NULL CHECK (period IN ('1', '7', '30', 'all')),
  speed_mode text NOT NULL CHECK (speed_mode IN ('standard', 'fast', 'ultrafast')),
  revision integer NOT NULL CHECK (revision >= 1),
  released_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256 char(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  run_id uuid NOT NULL,
  kernel_id smallint NOT NULL REFERENCES analytics_v2_kernels(kernel_id),
  manifest_version integer NOT NULL CHECK (manifest_version >= 1),
  PRIMARY KEY (period, speed_mode),
  CHECK (octet_length(payload::text) <= 16777216),
  -- COALESCE: a missing payload field fails the check instead of passing as
  -- NULL; jsonb_typeof keeps "1" from standing in for 1 (and 7 for "7").
  CHECK (COALESCE(jsonb_typeof(payload -> 'schemaVersion') = 'string'
    AND payload ->> 'schemaVersion' = 'community-model-performance-v1', false)),
  CHECK (COALESCE(jsonb_typeof(payload -> 'period') = 'string' AND payload ->> 'period' = period, false)),
  CHECK (COALESCE(jsonb_typeof(payload -> 'speedMode') = 'string' AND payload ->> 'speedMode' = speed_mode, false)),
  CHECK (COALESCE(jsonb_typeof(payload -> 'revision') = 'number' AND payload ->> 'revision' = revision::text, false))
);

CREATE FUNCTION analytics_v2_published_performance_forward_only() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'analytics_v2_published_performance_no_delete' USING ERRCODE = 'P1005';
  END IF;
  IF NEW.period IS DISTINCT FROM OLD.period
      OR NEW.speed_mode IS DISTINCT FROM OLD.speed_mode
      OR NEW.revision <= OLD.revision
      OR NEW.payload_sha256 = OLD.payload_sha256 THEN
    RAISE EXCEPTION 'analytics_v2_published_performance_forward_only' USING ERRCODE = 'P1005';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER analytics_v2_published_performance_forward_only
BEFORE UPDATE OR DELETE ON analytics_v2_published_performance
FOR EACH ROW EXECUTE FUNCTION analytics_v2_published_performance_forward_only();
