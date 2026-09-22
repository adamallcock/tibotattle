-- Independent daily performance reports.  This migration is intentionally
-- separate from telemetry_v12 usage transport: the runtime is staged, the
-- capability/consent tuple is distinct, and no usage grant or usage table is
-- consulted by these records.

CREATE TABLE telemetry_performance_runtime (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL CHECK (schema_version = 'model-performance-daily-v1'),
  field_dictionary_version TEXT NOT NULL CHECK (
    field_dictionary_version = 'telemetry-performance-registry-2026-09-21.1'
  ),
  privacy_contract_version TEXT NOT NULL CHECK (
    privacy_contract_version = 'privacy-safe-model-performance-v1'
  ),
  method_version TEXT NOT NULL CHECK (length(method_version) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'paused')),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO telemetry_performance_runtime (
  id, schema_version, field_dictionary_version, privacy_contract_version,
  method_version, state, policy_revision, created_at, updated_at
) VALUES (
  1, 'model-performance-daily-v1',
  'telemetry-performance-registry-2026-09-21.1',
  'privacy-safe-model-performance-v1', 'performance-daily-histogram-v1',
  'staged', 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
);

-- Accountless devices receive an explicit performance policy grant.  This is
-- deliberately a different row from accountless_v12_device_authorizations:
-- the usage successor grant can never authorize performance reports.
CREATE TABLE accountless_telemetry_performance_authorizations (
  -- Grants are append-only by authority tuple.  A lease renewal or a fresh
  -- consent must be able to append a new row while the expired/revoked
  -- predecessor remains immutable for replay and audit checks.
  enrollment_device_id TEXT NOT NULL
    REFERENCES accountless_enrollment_ledger(device_id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_credential_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL CHECK (schema_version = 'accountless-performance-owner-v1'),
  policy_version TEXT NOT NULL CHECK (
    policy_version = 'accountless-telemetry-performance-policy-v1'
  ),
  authorization_basis TEXT NOT NULL CHECK (
    authorization_basis = 'accountless-performance-policy-v1'
  ),
  performance_schema_version TEXT NOT NULL CHECK (
    performance_schema_version = 'model-performance-daily-v1'
  ),
  field_dictionary_version TEXT NOT NULL CHECK (
    field_dictionary_version = 'telemetry-performance-registry-2026-09-21.1'
  ),
  privacy_contract_version TEXT NOT NULL CHECK (
    privacy_contract_version = 'privacy-safe-model-performance-v1'
  ),
  scope TEXT NOT NULL CHECK (scope = 'model-performance-daily'),
  capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  authorized_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  revoked_at TEXT,
  revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN (
    'user_opt_out', 'security_reset', 'operator_containment'
  )),
  PRIMARY KEY (enrollment_device_id, capability_revision, authority_epoch),
  CHECK (expires_at > authorized_at),
  CHECK ((state = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
) STRICT;

CREATE INDEX accountless_telemetry_performance_authorizations_active
  ON accountless_telemetry_performance_authorizations(state, expires_at);
CREATE INDEX accountless_telemetry_performance_authorizations_head
  ON accountless_telemetry_performance_authorizations(
    enrollment_device_id, capability_revision DESC, authority_epoch DESC
  );

-- A grant head is monotonic for one enrollment/device authority.  The
-- authority epoch only advances after a revoked predecessor; ordinary expiry
-- and lease renewal retain the same authority epoch while capability_revision
-- fences stale bearer responses.
CREATE TRIGGER accountless_telemetry_performance_authorization_revision
BEFORE INSERT ON accountless_telemetry_performance_authorizations
WHEN NEW.capability_revision IS NOT COALESCE((
  SELECT prior.capability_revision
    FROM accountless_telemetry_performance_authorizations prior
   WHERE prior.enrollment_device_id = NEW.enrollment_device_id
   ORDER BY prior.capability_revision DESC, prior.authority_epoch DESC
   LIMIT 1
), 0) + 1
  OR NEW.authority_epoch IS NOT COALESCE((
    SELECT prior.authority_epoch
      FROM accountless_telemetry_performance_authorizations prior
     WHERE prior.enrollment_device_id = NEW.enrollment_device_id
     ORDER BY prior.capability_revision DESC, prior.authority_epoch DESC
     LIMIT 1
  ), 0) + CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM accountless_telemetry_performance_authorizations prior
       WHERE prior.enrollment_device_id = NEW.enrollment_device_id
    ) THEN 1
    WHEN EXISTS (
      SELECT 1
        FROM accountless_telemetry_performance_authorizations prior
       WHERE prior.enrollment_device_id = NEW.enrollment_device_id
         AND prior.capability_revision = COALESCE((
           SELECT latest.capability_revision
             FROM accountless_telemetry_performance_authorizations latest
            WHERE latest.enrollment_device_id = NEW.enrollment_device_id
            ORDER BY latest.capability_revision DESC, latest.authority_epoch DESC
            LIMIT 1
         ), 0)
         AND prior.authority_epoch = COALESCE((
           SELECT latest.authority_epoch
             FROM accountless_telemetry_performance_authorizations latest
            WHERE latest.enrollment_device_id = NEW.enrollment_device_id
            ORDER BY latest.capability_revision DESC, latest.authority_epoch DESC
            LIMIT 1
         ), 0)
         AND prior.state = 'revoked'
    ) THEN 1 ELSE 0 END
BEGIN SELECT RAISE(ABORT, 'accountless telemetry performance authorization revision conflict'); END;

CREATE TRIGGER accountless_telemetry_performance_authorization_admission
BEFORE INSERT ON accountless_telemetry_performance_authorizations
WHEN NOT EXISTS (
  SELECT 1
    FROM accountless_upload_owners owner
    JOIN accountless_enrollment_ledger ledger
      ON ledger.device_id = owner.enrollment_device_id
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
     AND d.accountless_enrollment_device_id = NEW.enrollment_device_id
     AND d.expires_at = NEW.expires_at
     AND r.state = 'active'
     AND NEW.state = 'active'
     AND NEW.performance_schema_version = r.schema_version
     AND NEW.field_dictionary_version = r.field_dictionary_version
     AND NEW.privacy_contract_version = r.privacy_contract_version
     AND NEW.scope = 'model-performance-daily'
)
BEGIN SELECT RAISE(ABORT, 'accountless telemetry performance authorization unavailable'); END;

CREATE TRIGGER accountless_telemetry_performance_authorization_immutable
BEFORE UPDATE ON accountless_telemetry_performance_authorizations
WHEN NEW.enrollment_device_id IS NOT OLD.enrollment_device_id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_credential_id IS NOT OLD.device_credential_id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.authorization_basis IS NOT OLD.authorization_basis
  OR NEW.performance_schema_version IS NOT OLD.performance_schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.scope IS NOT OLD.scope
  OR NEW.capability_revision IS NOT OLD.capability_revision
  OR NEW.authority_epoch IS NOT OLD.authority_epoch
  OR NEW.authorized_at IS NOT OLD.authorized_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.state = 'revoked'
  OR (NEW.state = 'active' AND (NEW.revoked_at IS NOT NULL OR NEW.revocation_reason IS NOT NULL))
  OR (NEW.state = 'revoked' AND (NEW.revoked_at IS NULL OR NEW.revocation_reason IS NULL))
  OR (NEW.state = 'revoked' AND NOT EXISTS (
    SELECT 1 FROM accountless_enrollment_ledger ledger
     WHERE ledger.device_id = OLD.enrollment_device_id AND ledger.state = 'revoked'
  ))
BEGIN SELECT RAISE(ABORT, 'accountless telemetry performance authorization immutable'); END;

CREATE TABLE telemetry_performance_device_capabilities (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL CHECK (schema_version = 'model-performance-daily-v1'),
  field_dictionary_version TEXT NOT NULL CHECK (
    field_dictionary_version = 'telemetry-performance-registry-2026-09-21.1'
  ),
  privacy_contract_version TEXT NOT NULL CHECK (
    privacy_contract_version = 'privacy-safe-model-performance-v1'
  ),
  scope TEXT NOT NULL CHECK (scope = 'model-performance-daily'),
  capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'revoked')),
  consented_at TEXT NOT NULL,
  revoked_at TEXT,
  -- Keep every authority tuple so expiry/revocation transitions cannot be
  -- rewritten in place.  Readers select only the monotonic head below.
  PRIMARY KEY (participant_id, device_id, capability_revision, authority_epoch),
  CHECK (expires_at > issued_at),
  CHECK ((state = 'accepted' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL))
) STRICT;

CREATE INDEX telemetry_performance_capabilities_device
  ON telemetry_performance_device_capabilities(device_id, state, expires_at);
CREATE INDEX telemetry_performance_capabilities_head
  ON telemetry_performance_device_capabilities(
    participant_id, device_id, capability_revision DESC, authority_epoch DESC
  );

CREATE TRIGGER telemetry_performance_capability_revision
BEFORE INSERT ON telemetry_performance_device_capabilities
WHEN NEW.capability_revision IS NOT COALESCE((
  SELECT prior.capability_revision
    FROM telemetry_performance_device_capabilities prior
   WHERE prior.participant_id = NEW.participant_id
     AND prior.device_id = NEW.device_id
   ORDER BY prior.capability_revision DESC, prior.authority_epoch DESC
   LIMIT 1
), 0) + 1
  OR NEW.authority_epoch IS NOT COALESCE((
    SELECT prior.authority_epoch
      FROM telemetry_performance_device_capabilities prior
     WHERE prior.participant_id = NEW.participant_id
       AND prior.device_id = NEW.device_id
   ORDER BY prior.capability_revision DESC, prior.authority_epoch DESC
   LIMIT 1
  ), 0) + CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM telemetry_performance_device_capabilities prior
       WHERE prior.participant_id = NEW.participant_id
         AND prior.device_id = NEW.device_id
    ) THEN 1
    WHEN EXISTS (
      SELECT 1
        FROM telemetry_performance_device_capabilities prior
       WHERE prior.participant_id = NEW.participant_id
         AND prior.device_id = NEW.device_id
         AND prior.capability_revision = COALESCE((
           SELECT latest.capability_revision
             FROM telemetry_performance_device_capabilities latest
            WHERE latest.participant_id = NEW.participant_id
              AND latest.device_id = NEW.device_id
            ORDER BY latest.capability_revision DESC, latest.authority_epoch DESC
            LIMIT 1
         ), 0)
         AND prior.authority_epoch = COALESCE((
           SELECT latest.authority_epoch
             FROM telemetry_performance_device_capabilities latest
            WHERE latest.participant_id = NEW.participant_id
              AND latest.device_id = NEW.device_id
            ORDER BY latest.capability_revision DESC, latest.authority_epoch DESC
            LIMIT 1
         ), 0)
         AND prior.state = 'revoked'
    ) THEN 1 ELSE 0 END
BEGIN SELECT RAISE(ABORT, 'telemetry performance capability revision conflict'); END;

CREATE TRIGGER telemetry_performance_capability_admission
BEFORE INSERT ON telemetry_performance_device_capabilities
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM telemetry_performance_runtime r
      JOIN participants p ON p.id = NEW.participant_id
      JOIN device_credentials d ON d.id = NEW.device_id AND d.participant_id = p.id
     WHERE r.id = 1 AND r.state = 'active'
       AND p.state = 'active' AND d.state = 'active'
       AND NEW.state = 'accepted'
       AND NEW.schema_version = r.schema_version
       AND NEW.field_dictionary_version = r.field_dictionary_version
       AND NEW.privacy_contract_version = r.privacy_contract_version
       AND (
         (p.owner_kind = 'social' AND d.authority_kind = 'social')
         OR (
           p.owner_kind = 'accountless' AND d.authority_kind = 'accountless'
           AND EXISTS (
             SELECT 1
               FROM accountless_telemetry_performance_authorizations a
               JOIN accountless_upload_owners owner
                 ON owner.enrollment_device_id = a.enrollment_device_id
               JOIN accountless_enrollment_ledger ledger
                 ON ledger.device_id = owner.enrollment_device_id
              WHERE a.participant_id = p.id AND a.device_credential_id = d.id
                AND a.state = 'active' AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                AND a.capability_revision = (
                  SELECT MAX(head.capability_revision)
                    FROM accountless_telemetry_performance_authorizations head
                   WHERE head.enrollment_device_id = a.enrollment_device_id
                )
                AND a.authority_epoch = (
                  SELECT head.authority_epoch
                    FROM accountless_telemetry_performance_authorizations head
                   WHERE head.enrollment_device_id = a.enrollment_device_id
                   ORDER BY head.capability_revision DESC, head.authority_epoch DESC
                   LIMIT 1
                )
                AND a.capability_revision = NEW.capability_revision
                AND a.authority_epoch = NEW.authority_epoch
                AND owner.state = 'active' AND ledger.state = 'active'
                AND owner.participant_id = a.participant_id
                AND owner.device_credential_id = a.device_credential_id
                AND owner.expires_at = a.expires_at AND ledger.expires_at = a.expires_at
           )
         )
       )
  ) THEN RAISE(ABORT, 'telemetry_performance_capability_unavailable') END;
END;

CREATE TRIGGER telemetry_performance_capability_immutable
BEFORE UPDATE ON telemetry_performance_device_capabilities
WHEN NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_id IS NOT OLD.device_id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.scope IS NOT OLD.scope
  OR NEW.capability_revision IS NOT OLD.capability_revision
  OR NEW.authority_epoch IS NOT OLD.authority_epoch
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.consented_at IS NOT OLD.consented_at
  OR OLD.state = 'revoked'
BEGIN SELECT RAISE(ABORT, 'telemetry_performance_capability_immutable'); END;

CREATE TABLE telemetry_performance_reports (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  report_day TEXT NOT NULL CHECK (
    length(report_day) = 10
    AND report_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  report_revision TEXT NOT NULL CHECK (
    length(report_revision) = 64 AND report_revision NOT GLOB '*[^0-9a-f]*'
  ),
  source_generation TEXT NOT NULL CHECK (length(source_generation) BETWEEN 1 AND 128),
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  method_version TEXT NOT NULL CHECK (length(method_version) BETWEEN 1 AND 128),
  parser_version TEXT NOT NULL CHECK (length(parser_version) BETWEEN 1 AND 128),
  schema_version TEXT NOT NULL CHECK (schema_version = 'model-performance-daily-v1'),
  field_dictionary_version TEXT NOT NULL CHECK (
    field_dictionary_version = 'telemetry-performance-registry-2026-09-21.1'
  ),
  privacy_contract_version TEXT NOT NULL CHECK (
    privacy_contract_version = 'privacy-safe-model-performance-v1'
  ),
  bucket_scheme_version TEXT NOT NULL CHECK (bucket_scheme_version = 'performance-histogram-v1'),
  measurement_version TEXT NOT NULL CHECK (measurement_version = 'model-performance-samples-v1'),
  -- A zero-record report is a revisioned day tombstone. It supersedes an older
  -- current revision when local eligibility disappears, without storing a
  -- fabricated cohort or bucket.
  record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 1024),
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes BETWEEN 1 AND 1250000),
  capability_revision INTEGER NOT NULL CHECK (capability_revision >= 1),
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('current', 'superseded')),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (participant_id, device_id, report_day, report_revision),
  CHECK ((state = 'current' AND superseded_at IS NULL)
    OR (state = 'superseded' AND superseded_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX telemetry_performance_current_day
  ON telemetry_performance_reports(participant_id, device_id, report_day)
  WHERE state = 'current';
CREATE INDEX telemetry_performance_reports_owner_day
  ON telemetry_performance_reports(participant_id, report_day, state, created_at);

-- Source revisions are the generic local mutation fence for one device/day.
-- The generation and digest are opaque provenance.  A higher persistent
-- source_revision may replace a prior generation; an equal revision must have
-- the exact same generation and digest.  Checking all retained rows (including
-- superseded history) keeps direct SQL writers from replaying an older snapshot
-- after the current row has been replaced.
CREATE TRIGGER telemetry_performance_report_revision_order
BEFORE INSERT ON telemetry_performance_reports
WHEN NEW.state = 'current' AND EXISTS (
  SELECT 1
    FROM telemetry_performance_reports prior
   WHERE prior.participant_id = NEW.participant_id
     AND prior.device_id = NEW.device_id
     AND prior.report_day = NEW.report_day
     AND (
       prior.source_revision > NEW.source_revision
       OR (
         prior.source_revision = NEW.source_revision
         AND (
           prior.source_generation IS NOT NEW.source_generation
           OR prior.source_digest IS NOT NEW.source_digest
         )
       )
     )
)
BEGIN SELECT RAISE(ABORT, 'telemetry_performance_report_revision_conflict'); END;

CREATE TRIGGER telemetry_performance_report_admission
BEFORE INSERT ON telemetry_performance_reports
BEGIN
  SELECT CASE WHEN NEW.state != 'current' OR NOT EXISTS (
    SELECT 1
       FROM telemetry_performance_runtime r
      JOIN participants p ON p.id = NEW.participant_id
      JOIN device_credentials d ON d.id = NEW.device_id AND d.participant_id = p.id
      JOIN telemetry_performance_device_capabilities c
        ON c.participant_id = p.id AND c.device_id = d.id
       AND c.capability_revision = (
         SELECT MAX(head.capability_revision)
           FROM telemetry_performance_device_capabilities head
          WHERE head.participant_id = p.id AND head.device_id = d.id
       )
       AND c.authority_epoch = (
         SELECT head.authority_epoch
           FROM telemetry_performance_device_capabilities head
          WHERE head.participant_id = p.id AND head.device_id = d.id
          ORDER BY head.capability_revision DESC, head.authority_epoch DESC
          LIMIT 1
       )
     WHERE r.id = 1 AND r.state = 'active'
       AND p.state = 'active' AND d.state = 'active'
       AND c.state = 'accepted' AND c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       AND c.schema_version = r.schema_version
       AND c.field_dictionary_version = r.field_dictionary_version
       AND c.privacy_contract_version = r.privacy_contract_version
       AND NEW.schema_version = r.schema_version
       AND NEW.field_dictionary_version = r.field_dictionary_version
       AND NEW.privacy_contract_version = r.privacy_contract_version
       AND NEW.method_version = r.method_version
       AND NEW.capability_revision = c.capability_revision
       AND NEW.authority_epoch = c.authority_epoch
       AND (
         (p.owner_kind = 'social' AND d.authority_kind = 'social')
         OR (
           p.owner_kind = 'accountless' AND d.authority_kind = 'accountless'
           AND EXISTS (
             SELECT 1
               FROM accountless_telemetry_performance_authorizations a
               JOIN accountless_upload_owners owner
                 ON owner.enrollment_device_id = a.enrollment_device_id
               JOIN accountless_enrollment_ledger ledger
                 ON ledger.device_id = owner.enrollment_device_id
              WHERE a.participant_id = p.id AND a.device_credential_id = d.id
                AND a.state = 'active' AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                AND a.capability_revision = (
                  SELECT MAX(head.capability_revision)
                    FROM accountless_telemetry_performance_authorizations head
                   WHERE head.enrollment_device_id = a.enrollment_device_id
                )
                AND a.authority_epoch = (
                  SELECT head.authority_epoch
                    FROM accountless_telemetry_performance_authorizations head
                   WHERE head.enrollment_device_id = a.enrollment_device_id
                   ORDER BY head.capability_revision DESC, head.authority_epoch DESC
                   LIMIT 1
                )
                AND a.capability_revision = NEW.capability_revision
                AND a.authority_epoch = NEW.authority_epoch
                AND owner.state = 'active' AND ledger.state = 'active'
                AND owner.participant_id = a.participant_id
                AND owner.device_credential_id = a.device_credential_id
                AND owner.expires_at = a.expires_at AND ledger.expires_at = a.expires_at
           )
         )
       )
  ) THEN RAISE(ABORT, 'telemetry_performance_report_admission_denied') END;
END;

CREATE TRIGGER telemetry_performance_report_immutable
BEFORE UPDATE ON telemetry_performance_reports
WHEN NEW.id IS NOT OLD.id
  OR NEW.participant_id IS NOT OLD.participant_id
  OR NEW.device_id IS NOT OLD.device_id
  OR NEW.report_day IS NOT OLD.report_day
  OR NEW.report_revision IS NOT OLD.report_revision
  OR NEW.source_generation IS NOT OLD.source_generation
  OR NEW.source_digest IS NOT OLD.source_digest
  OR NEW.source_revision IS NOT OLD.source_revision
  OR NEW.method_version IS NOT OLD.method_version
  OR NEW.parser_version IS NOT OLD.parser_version
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.field_dictionary_version IS NOT OLD.field_dictionary_version
  OR NEW.privacy_contract_version IS NOT OLD.privacy_contract_version
  OR NEW.bucket_scheme_version IS NOT OLD.bucket_scheme_version
  OR NEW.measurement_version IS NOT OLD.measurement_version
  OR NEW.record_count IS NOT OLD.record_count
  OR NEW.canonical_bytes IS NOT OLD.canonical_bytes
  OR NEW.capability_revision IS NOT OLD.capability_revision
  OR NEW.authority_epoch IS NOT OLD.authority_epoch
  OR (OLD.state = 'superseded' AND NEW.state IS NOT OLD.state)
  OR (NEW.state = 'current' AND NEW.superseded_at IS NOT NULL)
  OR (NEW.state = 'superseded' AND NEW.superseded_at IS NULL)
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'telemetry_performance_report_immutable'); END;

CREATE TABLE telemetry_performance_cohorts (
  report_id TEXT NOT NULL REFERENCES telemetry_performance_reports(id) ON DELETE CASCADE,
  cohort_index INTEGER NOT NULL CHECK (cohort_index BETWEEN 0 AND 1023),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 64),
  reasoning_effort TEXT NOT NULL CHECK (length(reasoning_effort) BETWEEN 1 AND 16),
  speed_method TEXT NOT NULL CHECK (speed_method IN ('receipt', 'legacy', 'tool_free', 'unavailable')),
  speed_mode TEXT NOT NULL CHECK (speed_mode IN ('fast', 'standard', 'unknown', 'other', 'mixed')),
  speed_mode_source TEXT NOT NULL CHECK (
    speed_mode_source IN ('rollout_thread_settings', 'lineage_inherited', 'unobserved', 'mixed')
  ),
  api_service_tier TEXT NOT NULL CHECK (
    api_service_tier IN ('standard', 'priority', 'flex', 'batch', 'unknown', 'other', 'mixed')
  ),
  turns INTEGER NOT NULL CHECK (turns BETWEEN 1 AND 9007199254740991),
  speed_turns INTEGER NOT NULL CHECK (speed_turns BETWEEN 0 AND 9007199254740991),
  ttft_turns INTEGER NOT NULL CHECK (ttft_turns BETWEEN 0 AND 9007199254740991),
  completion_turns INTEGER NOT NULL CHECK (completion_turns BETWEEN 0 AND 9007199254740991),
  timed_responses INTEGER NOT NULL CHECK (timed_responses BETWEEN 0 AND 9007199254740991),
  speed_tokens INTEGER NOT NULL CHECK (speed_tokens BETWEEN 0 AND 9007199254740991),
  speed_duration_ms INTEGER NOT NULL CHECK (speed_duration_ms BETWEEN 0 AND 9007199254740991),
  speed_min INTEGER CHECK (speed_min IS NULL OR speed_min BETWEEN 0 AND 9007199254740991),
  speed_max INTEGER CHECK (speed_max IS NULL OR speed_max BETWEEN 0 AND 9007199254740991),
  ttft_min INTEGER CHECK (ttft_min IS NULL OR ttft_min BETWEEN 0 AND 9007199254740991),
  ttft_max INTEGER CHECK (ttft_max IS NULL OR ttft_max BETWEEN 0 AND 9007199254740991),
  completion_min INTEGER CHECK (completion_min IS NULL OR completion_min BETWEEN 1 AND 9007199254740991),
  completion_max INTEGER CHECK (completion_max IS NULL OR completion_max BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (report_id, cohort_index),
  CHECK (speed_turns <= turns AND ttft_turns <= turns AND completion_turns <= turns),
  CHECK (timed_responses >= speed_turns)
) STRICT;

CREATE TABLE telemetry_performance_buckets (
  report_id TEXT NOT NULL,
  cohort_index INTEGER NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('speed', 'ttft', 'turnDuration')),
  bucket_index INTEGER NOT NULL CHECK (bucket_index BETWEEN 0 AND 60),
  bucket_count INTEGER NOT NULL CHECK (bucket_count BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (report_id, cohort_index, metric, bucket_index),
  FOREIGN KEY (report_id, cohort_index)
    REFERENCES telemetry_performance_cohorts(report_id, cohort_index) ON DELETE CASCADE
) STRICT;

-- The parser rejects duplicate population partitions before admission.  Keep
-- the same boundary in storage so a future maintenance writer cannot create
-- two histograms for one report/model/effort/method/mode/source/tier tuple.
CREATE UNIQUE INDEX telemetry_performance_cohort_identity
  ON telemetry_performance_cohorts(
    report_id, provider, model_id, reasoning_effort, speed_method,
    speed_mode, speed_mode_source, api_service_tier
  );

CREATE INDEX telemetry_performance_buckets_report
  ON telemetry_performance_buckets(report_id, metric, cohort_index, bucket_index);

CREATE TABLE telemetry_performance_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_credentials(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES telemetry_performance_reports(id) ON DELETE CASCADE,
  report_day TEXT NOT NULL CHECK (length(report_day) = 10),
  report_revision TEXT NOT NULL CHECK (
    length(report_revision) = 64 AND report_revision NOT GLOB '*[^0-9a-f]*'
  ),
  envelope_digest TEXT NOT NULL CHECK (
    length(envelope_digest) = 64 AND envelope_digest NOT GLOB '*[^0-9a-f]*'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'replaced', 'idempotent')),
  created_at TEXT NOT NULL,
  UNIQUE (participant_id, device_id, report_day, report_revision),
  UNIQUE (participant_id, device_id, envelope_digest)
) STRICT;

CREATE INDEX telemetry_performance_receipts_owner
  ON telemetry_performance_receipts(participant_id, created_at, id);
