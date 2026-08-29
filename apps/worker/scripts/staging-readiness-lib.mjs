import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGING_READINESS_SCHEMA_VERSION =
  "usage-monitor-staging-readiness-v0.1";
export const STAGING_OPERATION_RECEIPT_SCHEMA_VERSION =
  "usage-monitor-staging-operation-receipt-v0.1";
export const STAGING_PROOF_TYPES = Object.freeze({
  STATIC_CONFIGURATION: "static_configuration",
  LIVE_REMOTE: "live_remote_probe",
  OPERATION_RECEIPT: "operation_receipt",
});
export const REQUIRED_STAGING_SECRETS = Object.freeze([
  "ENVELOPE_PRIVATE_JWK",
  "ENVELOPE_PUBLIC_JWK",
]);
export const REQUIRED_D1_BINDINGS = Object.freeze([
  Object.freeze({
    binding: "USAGE_MONITOR_DB",
    databaseName: "app-usagemonitor-staging",
    migrationsDir: "migrations",
  }),
  Object.freeze({
    binding: "DELETION_LEDGER",
    databaseName: "app-usagemonitor-staging-deletion-ledger",
    migrationsDir: "deletion-ledger-migrations",
  }),
]);
export const REQUIRED_STAGING_R2_BUCKET_NAME =
  "app-usagemonitor-staging-quarantine";
export const EXPECTED_STAGING_MIGRATIONS = Object.freeze({
  USAGE_MONITOR_DB: Object.freeze([
    "0001_initial.sql",
    "0002_telemetry_ingest.sql",
    "0003_enrollment_grants.sql",
    "0004_web_sessions_and_upload_authorizations.sql",
    "0005_community_weekly_snapshots.sql",
    "0006_server_pricing.sql",
    "0007_account_track_v0_2.sql",
    "0008_device_upload_registration.sql",
    "0009_collection_controls.sql",
    "0010_retention_lifecycle.sql",
    "0011_account_scoped_device_consent.sql",
    "0012_revisioned_aggregate_rebuild.sql",
    "0013_quarantine_reconciliation.sql",
    "0014_bounded_contribution_admission.sql",
    "0015_identity_link.sql",
    "0016_apple_signin_handoff.sql",
    "0017_google_signin_handoff.sql",
    "0018_contribution_accepted_record_count.sql",
    "0019_admin_operations.sql",
    "0020_admin_operation_leases.sql",
    "0021_replace_oidc_token_handoffs.sql",
    "0022_historical_price_provenance.sql",
    "0023_community_aggregate_safety.sql",
    "0024_apple_signin_nonce_binding.sql",
    "0025_device_lifecycle.sql",
    "0026_signin_start_admission.sql",
    "0027_identity_reenrollment_cooldown_guard.sql",
    "0028_identity_link_secret_configuration.sql",
    "0029_sparkle_appcast_guard_nonces.sql",
    "0030_deletion_cascade_child_indexes.sql",
    "0031_incremental_contribution_v1.sql",
    "0032_signin_handoff_client_binding.sql",
    "0033_signin_handoff_processing_claim.sql",
    "0034_backfill_daily_allowance_revisions.sql",
    "0035_community_allowance_fit_cache.sql",
    "0036_v1_analysis_read_index.sql",
    // Added with the owner-only distribution sync (#18): widens the
    // admin_action_audit action vocabulary and adds the content-free GitHub
    // release-asset snapshot tables. No participant, device, or upload data.
    "0037_admin_distribution_history.sql",
    // Added with the owner metrics history (2026-08-21): one append-only table
    // of hourly gauge snapshots — named counts only, shape-capped at 4000
    // bytes. No participant, device, or upload data.
    "0038_admin_metrics_history.sql",
    // Added with the cache-only owner dashboard endpoints (2026-08-24):
    // singleton metrics-history and allowance-preview aggregate JSON payloads,
    // rebuilt by scheduled maintenance. Interactive admin requests read these
    // cache rows instead of event or per-account analysis tables.
    "0039_admin_metrics_history_cache.sql",
    "0040_community_allowance_publication_state.sql",
    // Adds bounded v1 model-composition evidence beside the private allowance
    // fit cache plus an hourly retry gate for scheduled admin projection.
    "0041_community_model_composition_cache.sql",
  ]),
  DELETION_LEDGER: Object.freeze([
    "0001_deletion_tombstones.sql",
    "0002_identity_reenrollment_cooldown.sql",
  ]),
});
export const REQUIRED_RATE_LIMITS = Object.freeze([
  Object.freeze({ name: "ENROLLMENT_RATE_LIMIT", limit: 20 }),
  Object.freeze({ name: "RECOVERY_RATE_LIMIT", limit: 20 }),
  Object.freeze({ name: "CLIENT_ATTEMPT_RATE_LIMIT", limit: 5 }),
  Object.freeze({ name: "PUBLIC_READ_RATE_LIMIT", limit: 120 }),
  Object.freeze({ name: "UPLOAD_AUTHORIZATION_RATE_LIMIT", limit: 300 }),
  Object.freeze({ name: "UPLOAD_PRINCIPAL_RATE_LIMIT", limit: 6 }),
  Object.freeze({ name: "UPLOAD_INGRESS_REQUEST_RATE_LIMIT", limit: 240 }),
  Object.freeze({ name: "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", limit: 20 }),
]);
export const REQUIRED_STAGING_VARIABLES = Object.freeze({
  ENVIRONMENT: "staging",
  ENROLLMENT_MODE: "disabled",
  ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  UPLOAD_INGRESS_QUEUE_MODE: "disabled",
  UPLOAD_INGRESS_MAX_CONCURRENT: "8",
  UPLOAD_INGRESS_MAX_STARTS_PER_MINUTE: "120",
  UPLOAD_INGRESS_BURST: "16",
  UPLOAD_INGRESS_LEASE_SECONDS: "90",
  UPLOAD_INGRESS_BODY_TOTAL_SECONDS: "60",
  UPLOAD_INGRESS_BODY_IDLE_SECONDS: "15",
  SIGN_IN_START_MAX_PER_MINUTE: "5",
  IDENTITY_LINK_SECRET_VERSION: "staging-v1",
});
export const REQUIRED_INGRESS_DURABLE_OBJECT_BINDING = Object.freeze({
  name: "UPLOAD_INGRESS_BUDGET",
  className: "UploadIngressBudget",
});
export const REQUIRED_INGRESS_DURABLE_OBJECT_MIGRATION = Object.freeze({
  tag: "upload-ingress-budget-v1",
  className: "UploadIngressBudget",
});
export const GENERATED_WORKER_ASSET_DIRECTORY =
  "../../.release-build/worker-assets";
export const PRODUCTION_PUBLIC_ASSET_DIRECTORY =
  "../../.release-build/public-release-site";

const PRIMARY_IDENTITY_PROTECTION_SCHEMA_FIELDS = Object.freeze({
  cooldownTable: "primary_cooldown_table",
  participantCooldownDigestColumn: "primary_participant_cooldown_digest",
  cooldownDigestColumn: "primary_cooldown_digest",
  cooldownSchemaVersionColumn: "primary_cooldown_schema_version",
  cooldownDeletedAtColumn: "primary_cooldown_deleted_at",
  cooldownRetainUntilColumn: "primary_cooldown_retain_until",
  cooldownRetentionIndex: "primary_cooldown_retention_index",
  cooldownRetentionIndexShape: "primary_cooldown_retention_index_shape",
  cooldownGuardTrigger: "primary_cooldown_guard_trigger",
  identityLinkSecretConfigurationTable:
    "primary_identity_link_secret_configuration_table",
  identityLinkSecretConfigurationColumnsExact:
    "primary_identity_link_secret_configuration_columns_exact",
  identityLinkSecretConfigurationSingleton:
    "primary_identity_link_secret_configuration_singleton",
  identityLinkSecretConfigurationKeyVersion:
    "primary_identity_link_secret_configuration_key_version",
  identityLinkSecretConfigurationSecretFingerprint:
    "primary_identity_link_secret_configuration_secret_fingerprint",
  identityLinkSecretConfigurationRecordedAt:
    "primary_identity_link_secret_configuration_recorded_at",
  identityLinkSecretConfigurationSingletonCheck:
    "primary_identity_link_secret_configuration_singleton_check",
  identityLinkSecretConfigurationKeyVersionCheck:
    "primary_identity_link_secret_configuration_key_version_check",
  identityLinkSecretConfigurationFingerprintCheck:
    "primary_identity_link_secret_configuration_fingerprint_check",
  identityLinkSecretConfigurationCheckCount:
    "primary_identity_link_secret_configuration_check_count",
  identityLinkSecretConfigurationStrict:
    "primary_identity_link_secret_configuration_strict",
  identityLinkSecretConfigurationNoExtraObjects:
    "primary_identity_link_secret_configuration_no_extra_objects",
});

const DELETION_LEDGER_IDENTITY_PROTECTION_SCHEMA_FIELDS = Object.freeze({
  tombstoneTable: "deletion_tombstone_table",
  tombstoneParticipantDigestColumn: "deletion_tombstone_participant_digest",
  tombstoneSchemaVersionColumn: "deletion_tombstone_schema_version",
  tombstoneDeletedAtColumn: "deletion_tombstone_deleted_at",
  tombstoneRetainUntilColumn: "deletion_tombstone_retain_until",
  tombstoneRetentionIndex: "deletion_tombstone_retention_index",
  tombstoneRetentionIndexShape: "deletion_tombstone_retention_index_shape",
  cooldownTable: "deletion_cooldown_table",
  cooldownDigestColumn: "deletion_cooldown_digest",
  cooldownSchemaVersionColumn: "deletion_cooldown_schema_version",
  cooldownDeletedAtColumn: "deletion_cooldown_deleted_at",
  cooldownRetainUntilColumn: "deletion_cooldown_retain_until",
  cooldownRetentionIndex: "deletion_cooldown_retention_index",
  cooldownRetentionIndexShape: "deletion_cooldown_retention_index_shape",
});

function sqlStringLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL =
  "replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', '')";
const IDENTITY_LINK_SECRET_CONFIGURATION_KEY_VERSION_GLOB = sqlStringLiteral(
  "'*[^A-Za-z0-9._-]*'",
);
const IDENTITY_LINK_SECRET_CONFIGURATION_FINGERPRINT_GLOB = sqlStringLiteral(
  "'*[^0-9a-f]*'",
);

const PRIMARY_IDENTITY_PROTECTION_SCHEMA_SQL = `
SELECT
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_reenrollment_cooldowns'
  ) AS primary_cooldown_table,
  EXISTS(
    SELECT 1 FROM pragma_table_info('participants')
     WHERE name = 'identity_cooldown_digest'
  ) AS primary_participant_cooldown_digest,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'identity_cooldown_digest'
  ) AS primary_cooldown_digest,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'schema_version'
  ) AS primary_cooldown_schema_version,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'deleted_at'
  ) AS primary_cooldown_deleted_at,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'retain_until'
  ) AS primary_cooldown_retain_until,
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'index'
       AND name = 'identity_reenrollment_cooldowns_retention'
  ) AS primary_cooldown_retention_index,
  COALESCE((
    SELECT group_concat(name, ',')
      FROM (
        SELECT name
          FROM pragma_index_info('identity_reenrollment_cooldowns_retention')
         ORDER BY seqno
      )
  ), '') = 'retain_until,identity_cooldown_digest'
    AS primary_cooldown_retention_index_shape,
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'trigger'
       AND name = 'participants_identity_reenrollment_cooldown_guard'
  ) AS primary_cooldown_guard_trigger,
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_link_secret_configuration'
  ) AS primary_identity_link_secret_configuration_table,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_link_secret_configuration')
     WHERE name = 'singleton'
       AND upper(type) = 'INTEGER'
       AND "notnull" = 1
       AND pk = 1
       AND dflt_value IS NULL
  ) AS primary_identity_link_secret_configuration_singleton,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_link_secret_configuration')
     WHERE name = 'key_version'
       AND upper(type) = 'TEXT'
       AND "notnull" = 1
       AND pk = 0
       AND dflt_value IS NULL
  ) AS primary_identity_link_secret_configuration_key_version,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_link_secret_configuration')
     WHERE name = 'secret_fingerprint'
       AND upper(type) = 'TEXT'
       AND "notnull" = 1
       AND pk = 0
       AND dflt_value IS NULL
  ) AS primary_identity_link_secret_configuration_secret_fingerprint,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_link_secret_configuration')
     WHERE name = 'recorded_at'
       AND upper(type) = 'TEXT'
       AND "notnull" = 1
       AND pk = 0
       AND dflt_value IS NULL
  ) AS primary_identity_link_secret_configuration_recorded_at,
  (
    SELECT count(*) FROM pragma_table_xinfo(
      'identity_link_secret_configuration'
    )
  ) = 4
  AND NOT EXISTS(
    SELECT 1 FROM pragma_table_xinfo('identity_link_secret_configuration')
     WHERE name NOT IN ('singleton', 'key_version',
                        'secret_fingerprint', 'recorded_at')
        OR hidden <> 0
  ) AS primary_identity_link_secret_configuration_columns_exact,
  EXISTS(
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_link_secret_configuration'
       AND instr(
         lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
         'check(singleton=1)'
       ) > 0
  ) AS primary_identity_link_secret_configuration_singleton_check,
  EXISTS(
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_link_secret_configuration'
       AND instr(
         lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
         'length(key_version)between1and64'
       ) > 0
       AND instr(
         lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
         'key_versionnotglob'
       ) > 0
       AND instr(
         substr(
           ${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL},
           instr(
             lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
             'key_versionnotglob'
           )
         ),
         ${IDENTITY_LINK_SECRET_CONFIGURATION_KEY_VERSION_GLOB}
       ) > 0
  ) AS primary_identity_link_secret_configuration_key_version_check,
  EXISTS(
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_link_secret_configuration'
       AND instr(
         lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
         'length(secret_fingerprint)=64'
       ) > 0
       AND instr(
         lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
         'secret_fingerprintnotglob'
       ) > 0
       AND instr(
         substr(
           ${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL},
           instr(
             lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
             'secret_fingerprintnotglob'
           )
         ),
         ${IDENTITY_LINK_SECRET_CONFIGURATION_FINGERPRINT_GLOB}
       ) > 0
  ) AS primary_identity_link_secret_configuration_fingerprint_check,
  EXISTS(
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_link_secret_configuration'
       AND (
         length(lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}))
         - length(replace(
             lower(${IDENTITY_LINK_SECRET_CONFIGURATION_COMPACT_SQL}),
             'check(',
             ''
           ))
       ) / length('check(') = 3
  ) AS primary_identity_link_secret_configuration_check_count,
  EXISTS(
    SELECT 1 FROM pragma_table_list
     WHERE schema = 'main'
       AND type = 'table'
       AND name = 'identity_link_secret_configuration'
       AND strict = 1
       AND wr = 0
  ) AS primary_identity_link_secret_configuration_strict,
  NOT EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type IN ('index', 'trigger')
       AND tbl_name = 'identity_link_secret_configuration'
  )
  AND NOT EXISTS(
    SELECT 1 FROM pragma_foreign_key_list(
      'identity_link_secret_configuration'
    )
  ) AS primary_identity_link_secret_configuration_no_extra_objects;
`;

const DELETION_LEDGER_IDENTITY_PROTECTION_SCHEMA_SQL = `
SELECT
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'table'
       AND name = 'deletion_tombstones'
  ) AS deletion_tombstone_table,
  EXISTS(
    SELECT 1 FROM pragma_table_info('deletion_tombstones')
     WHERE name = 'participant_digest'
  ) AS deletion_tombstone_participant_digest,
  EXISTS(
    SELECT 1 FROM pragma_table_info('deletion_tombstones')
     WHERE name = 'schema_version'
  ) AS deletion_tombstone_schema_version,
  EXISTS(
    SELECT 1 FROM pragma_table_info('deletion_tombstones')
     WHERE name = 'deleted_at'
  ) AS deletion_tombstone_deleted_at,
  EXISTS(
    SELECT 1 FROM pragma_table_info('deletion_tombstones')
     WHERE name = 'retain_until'
  ) AS deletion_tombstone_retain_until,
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'index'
       AND name = 'deletion_tombstones_retention'
  ) AS deletion_tombstone_retention_index,
  COALESCE((
    SELECT group_concat(name, ',')
      FROM (
        SELECT name
          FROM pragma_index_info('deletion_tombstones_retention')
         ORDER BY seqno
      )
  ), '') = 'retain_until,participant_digest'
    AS deletion_tombstone_retention_index_shape,
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'table'
       AND name = 'identity_reenrollment_cooldowns'
  ) AS deletion_cooldown_table,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'identity_cooldown_digest'
  ) AS deletion_cooldown_digest,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'schema_version'
  ) AS deletion_cooldown_schema_version,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'deleted_at'
  ) AS deletion_cooldown_deleted_at,
  EXISTS(
    SELECT 1 FROM pragma_table_info('identity_reenrollment_cooldowns')
     WHERE name = 'retain_until'
  ) AS deletion_cooldown_retain_until,
  EXISTS(
    SELECT 1 FROM sqlite_master
     WHERE type = 'index'
       AND name = 'identity_reenrollment_cooldowns_retention'
  ) AS deletion_cooldown_retention_index,
  COALESCE((
    SELECT group_concat(name, ',')
      FROM (
        SELECT name
          FROM pragma_index_info('identity_reenrollment_cooldowns_retention')
         ORDER BY seqno
      )
  ), '') = 'retain_until,identity_cooldown_digest'
    AS deletion_cooldown_retention_index_shape;
`;
const ALLOWED_WORKER_FIRST_ROUTES = Object.freeze([
  "/api/*",
  "/.well-known/apple-developer-domain-association.txt",
]);
// Production serves an explicit canonical public host. Its Worker must run
// before every asset so the www alias redirects before static HTML is served;
// the regular ASSETS.fetch fallback then handles all allowed public files.
// Staging and synthetic have no public canonical host, so they retain their
// narrow worker-first allow-list.
const FORBIDDEN_PUBLIC_ROUTE_PATTERN =
  /(?:^|\/)(?:app-open|contribution|sign-?in|signin)(?:\/|\*|$)/iu;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLACEHOLDER_UUID_PATTERN =
  /^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/u;
const MIGRATION_FILENAME_PATTERN = /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/u;
const DEFAULT_WORKER_DIRECTORY = dirname(
  dirname(fileURLToPath(import.meta.url)),
);

function exactNamedMembers(value, expectedNames, key) {
  if (!Array.isArray(value) || value.length !== expectedNames.length) {
    return false;
  }
  const names = value.map((entry) => entry?.[key]);
  return names.every((name) => typeof name === "string")
    && new Set(names).size === names.length
    && expectedNames.every((name) => names.includes(name));
}

function exactStringSet(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry) => typeof entry === "string")
    && new Set(value).size === value.length
    && expected.every((entry) => value.includes(entry));
}

function exactStringMap(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, expectedValue]) =>
      value[key] === expectedValue);
}

function validStagingName(value, expected) {
  return typeof value === "string" && value === expected;
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function localMigrationNames(workerDirectory, migrationsDir) {
  let entries;
  try {
    entries = readdirSync(join(workerDirectory, migrationsDir), {
      withFileTypes: true,
    });
  } catch {
    return null;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

export function validateStagingMigrationInventory(
  inventory,
  expected = EXPECTED_STAGING_MIGRATIONS,
) {
  if (inventory === null || typeof inventory !== "object"
      || Array.isArray(inventory)) {
    return Object.freeze({
      ok: false,
      code: "LOCAL_MIGRATION_INVENTORY_UNAVAILABLE",
    });
  }
  for (const binding of REQUIRED_D1_BINDINGS) {
    const names = inventory[binding.binding];
    const expectedNames = expected[binding.binding];
    if (!Array.isArray(names) || !Array.isArray(expectedNames)) {
      return Object.freeze({
        ok: false,
        code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
      });
    }
    if (!names.every((name) => MIGRATION_FILENAME_PATTERN.test(name))) {
      return Object.freeze({
        ok: false,
        code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
      });
    }
    if (!sameStringArray(names, [...names].sort())
        || !sameStringArray(names, expectedNames)) {
      return Object.freeze({
        ok: false,
        code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
      });
    }
  }
  return Object.freeze({ ok: true, code: null });
}

export function inspectStagingMigrationInventory({
  workerDirectory = DEFAULT_WORKER_DIRECTORY,
} = {}) {
  const inventory = {};
  for (const binding of REQUIRED_D1_BINDINGS) {
    inventory[binding.binding] = localMigrationNames(
      workerDirectory,
      binding.migrationsDir,
    );
  }
  const validation = validateStagingMigrationInventory(inventory);
  return Object.freeze({
    schemaVersion: "usage-monitor-staging-migration-inventory-v0.1",
    ok: validation.ok,
    code: validation.code,
    inventory: Object.freeze({
      USAGE_MONITOR_DB: Object.freeze([
        ...(inventory.USAGE_MONITOR_DB ?? []),
      ]),
      DELETION_LEDGER: Object.freeze([
        ...(inventory.DELETION_LEDGER ?? []),
      ]),
    }),
  });
}

function oneApiAssetRoute(value) {
  return value?.binding === "ASSETS"
    && value?.directory === GENERATED_WORKER_ASSET_DIRECTORY
    && value?.not_found_handling === "single-page-application"
    && Array.isArray(value?.run_worker_first)
    && value.run_worker_first.length === 1
    && value.run_worker_first[0] === "/api/*"
    && value.run_worker_first.every((route) =>
      typeof route === "string" && !FORBIDDEN_PUBLIC_ROUTE_PATTERN.test(route));
}

function safeDeployableAssetRoute(value) {
  return value?.binding === "ASSETS"
    && value?.directory === GENERATED_WORKER_ASSET_DIRECTORY
    && value?.not_found_handling === "single-page-application"
    && Array.isArray(value?.run_worker_first)
    && value.run_worker_first.length >= 1
    && value.run_worker_first.every((route) =>
      typeof route === "string"
      && ALLOWED_WORKER_FIRST_ROUTES.includes(route)
      && !FORBIDDEN_PUBLIC_ROUTE_PATTERN.test(route));
}

function safeProductionAssetRoute(value) {
  return value?.binding === "ASSETS"
    && value?.directory === PRODUCTION_PUBLIC_ASSET_DIRECTORY
    && value?.not_found_handling === "404-page"
    && value?.run_worker_first === true;
}

function deployableAssetRoutesClosed(config) {
  return safeDeployableAssetRoute(config?.assets)
    && safeDeployableAssetRoute(config?.env?.staging?.assets)
    && safeProductionAssetRoute(config?.env?.production?.assets);
}

function safeRateLimits(value) {
  if (!exactNamedMembers(
    value,
    REQUIRED_RATE_LIMITS.map((entry) => entry.name),
    "name",
  )) {
    return false;
  }
  const namespaceIds = value.map((entry) => entry.namespace_id);
  return namespaceIds.every((entry) => /^[1-9][0-9]{0,9}$/u.test(entry))
    && new Set(namespaceIds).size === namespaceIds.length
    && REQUIRED_RATE_LIMITS.every((expected) => {
      const configured = value.find((entry) => entry.name === expected.name);
      return configured?.simple?.limit === expected.limit
        && configured.simple?.period === 60;
    });
}

function safeIngressDurableObjectBinding(value) {
  return exactNamedMembers(
    value,
    [REQUIRED_INGRESS_DURABLE_OBJECT_BINDING.name],
    "name",
  ) && value[0]?.class_name === REQUIRED_INGRESS_DURABLE_OBJECT_BINDING.className;
}

function safeIngressDurableObjectMigration(value) {
  return Array.isArray(value) && value.some((migration) => (
    migration?.tag === REQUIRED_INGRESS_DURABLE_OBJECT_MIGRATION.tag
    && Array.isArray(migration.new_sqlite_classes)
    && migration.new_sqlite_classes.length === 1
    && migration.new_sqlite_classes[0]
      === REQUIRED_INGRESS_DURABLE_OBJECT_MIGRATION.className
  ));
}

function safeD1Bindings(value) {
  if (!exactNamedMembers(
    value,
    REQUIRED_D1_BINDINGS.map((entry) => entry.binding),
    "binding",
  )) {
    return false;
  }
  return REQUIRED_D1_BINDINGS.every((expected) => {
    const binding = value.find((entry) => entry.binding === expected.binding);
    return validStagingName(binding?.database_name, expected.databaseName)
      && binding?.migrations_dir === expected.migrationsDir
      && typeof binding?.database_id === "string"
      && UUID_PATTERN.test(binding.database_id);
  });
}

function safeR2Binding(value) {
  return Array.isArray(value)
    && value.length === 1
    && value[0]?.binding === "QUARANTINE"
    && value[0]?.bucket_name === REQUIRED_STAGING_R2_BUCKET_NAME;
}

function resourceIdentifiersConfigured(environment) {
  const ids = Array.isArray(environment?.d1_databases)
    ? environment.d1_databases.map((entry) => entry?.database_id)
    : [];
  return ids.length === REQUIRED_D1_BINDINGS.length
    && new Set(ids).size === ids.length
    && ids.every((entry) => UUID_PATTERN.test(entry)
      && !PLACEHOLDER_UUID_PATTERN.test(entry));
}

export function assessStagingConfiguration(
  config,
  { workerDirectory = DEFAULT_WORKER_DIRECTORY } = {},
) {
  const environment = config?.env?.staging;
  const migrationInventory = inspectStagingMigrationInventory({
    workerDirectory,
  });
  const d1DatabaseNames = Array.isArray(environment?.d1_databases)
    ? environment.d1_databases.map((entry) => entry?.database_name)
    : [];
  const checks = {
    environmentDeclared:
      typeof environment === "object" && environment !== null,
    publicNameSafe: validStagingName(
      environment?.name,
      "app-usagemonitor-staging",
    ),
    workersDevHttpsEnabled: environment?.workers_dev === true,
    originBoundaryClosed: environment?.workers_dev === true
      && !Object.hasOwn(environment ?? {}, "routes")
      && !Object.hasOwn(environment?.vars ?? {}, "PUBLIC_ORIGIN"),
    previewUrlsDisabled: environment?.preview_urls === false,
    observabilityEnabled: environment?.observability?.enabled === true
      && environment?.observability?.head_sampling_rate === 1,
    // Retain the established check key for receipt compatibility. Scheduled
    // maintenance moved to every minute in 3e82884 so bounded quarantine
    // reconciliation drains promptly instead of delaying publication.
    hourlyLifecycleDeclared:
      Array.isArray(environment?.triggers?.crons)
      && environment.triggers.crons.length === 1
      && environment.triggers.crons[0] === "* * * * *",
    enrollmentDisabled: environment?.vars?.ENVIRONMENT === "staging"
      && environment?.vars?.ENROLLMENT_MODE === "disabled",
    accountScopedIngestDisabled:
      environment?.vars?.ACCOUNT_SCOPED_INGEST_MODE === "disabled",
    noUnexpectedVariables: exactStringMap(
      environment?.vars,
      REQUIRED_STAGING_VARIABLES,
    ),
    requiredSecretsDeclared: exactStringSet(
      environment?.secrets?.required,
      REQUIRED_STAGING_SECRETS,
    ),
    d1BindingsSafe: safeD1Bindings(environment?.d1_databases),
    d1ResourcesDistinct: d1DatabaseNames.length === REQUIRED_D1_BINDINGS.length
      && new Set(d1DatabaseNames).size === d1DatabaseNames.length,
    r2BindingSafe: safeR2Binding(environment?.r2_buckets),
    rateLimitsSafe: safeRateLimits(environment?.ratelimits),
    ingressBudgetBindingSafe: safeIngressDurableObjectBinding(
      environment?.durable_objects?.bindings,
    ),
    ingressBudgetMigrationSafe: safeIngressDurableObjectMigration(
      config?.migrations,
    ),
    assetsClosed: oneApiAssetRoute(environment?.assets),
    deployableAssetsClosed: deployableAssetRoutesClosed(config),
    migrationInventorySafe: migrationInventory.ok,
    resourceIdentifiersConfigured:
      resourceIdentifiersConfigured(environment ?? {}),
  };
  const safetyCheckNames = Object.keys(checks)
    .filter((name) => name !== "resourceIdentifiersConfigured");
  const safetyBlockers = safetyCheckNames
    .filter((name) => !checks[name])
    .map((name) => `CONFIG_${name.replaceAll(/([A-Z])/gu, "_$1").toUpperCase()}`);
  const blockers = [
    ...safetyBlockers,
    ...(!migrationInventory.ok ? [migrationInventory.code] : []),
    ...(!checks.resourceIdentifiersConfigured
      ? ["STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED"]
      : []),
  ];
  return {
    schemaVersion: STAGING_READINESS_SCHEMA_VERSION,
    environment: "staging",
    evidenceType: STAGING_PROOF_TYPES.STATIC_CONFIGURATION,
    liveProof: false,
    state: safetyBlockers.length > 0
      ? "unsafe_configuration"
      : checks.resourceIdentifiersConfigured
        ? "configured_unverified"
        : "safe_unprovisioned",
    collectionAuthorized: false,
    migrationInventory: migrationInventory.inventory,
    checks,
    blockers,
  };
}

function runWrangler(wrangler, workerDirectory, args, spawn = spawnSync) {
  try {
    const result = spawn(wrangler, args, {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch {
    return { ok: false, stdout: "", stderr: "" };
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function migrationNames(value) {
  if (!Array.isArray(value) || value.length !== 1
      || !Array.isArray(value[0]?.results)) {
    return null;
  }
  const rows = value[0].results;
  const names = rows.map((row) => row?.name);
  return names.every((name) => typeof name === "string")
    ? names
    : null;
}

function classifyMigrationProbe(result, expectedNames) {
  if (!result.ok) {
    const output = `${result.stdout}${result.stderr}`;
    if (/no such table[\s:]+.*d1_migrations|d1_migrations.*no such table/iu.test(
      output,
    )) {
      return {
        status: "uninitialized",
        code: "REMOTE_MIGRATION_STATE_UNINITIALIZED",
      };
    }
    return { status: "unavailable", code: "REMOTE_MIGRATION_STATE_UNAVAILABLE" };
  }
  const names = migrationNames(parseJson(result.stdout));
  if (names === null) {
    return { status: "invalid", code: "REMOTE_MIGRATION_STATE_INVALID" };
  }
  if (!sameStringArray(names, [...new Set(names)])) {
    return { status: "drift", code: "REMOTE_MIGRATION_INVENTORY_DRIFT" };
  }
  if (sameStringArray(names, expectedNames)) {
    return { status: "current", code: null };
  }
  if (names.every((name, index) => name === expectedNames[index])) {
    return { status: "pending", code: "REMOTE_MIGRATIONS_PENDING" };
  }
  return { status: "drift", code: "REMOTE_MIGRATION_INVENTORY_DRIFT" };
}

const READ_ONLY_MIGRATION_PROBE_SQL =
  "SELECT name FROM d1_migrations ORDER BY id;";

const COLLECTION_CONTROL_PROBE_SQL = `
SELECT schema_version,
       control_state,
       enrollment_enabled,
       upload_registration_enabled,
       processing_enabled,
       publication_enabled
  FROM collection_controls
 WHERE singleton = 1;
`;

function collectionControlRow(value) {
  const statements = Array.isArray(value) ? value : [];
  return statements.findLast(
    (entry) => Array.isArray(entry?.results) && entry.results.length === 1,
  )?.results?.[0] ?? null;
}

function collectionControlProbeState(result) {
  if (!result.ok) {
    const output = `${result.stdout}${result.stderr}`;
    return /no such table[\s:]+.*collection_controls|collection_controls.*no such table/iu
      .test(output)
      ? "missing"
      : "unknown";
  }
  const row = collectionControlRow(parseJson(result.stdout));
  if (row === null
      || row.schema_version !== "collection-controls-v0.1"
      || !["operational", "degraded", "contained"].includes(
        row.control_state,
      )
      || !["enrollment_enabled", "upload_registration_enabled",
        "processing_enabled", "publication_enabled"]
        .every((field) => row[field] === 0 || row[field] === 1)) {
    return "invalid";
  }
  return row.control_state === "contained"
      && row.enrollment_enabled === 0
      && row.upload_registration_enabled === 0
      && row.processing_enabled === 0
      && row.publication_enabled === 0
    ? "contained"
    : "uncontained";
}

function schemaProbeValues(result, fields) {
  const row = result.ok
    ? collectionControlRow(parseJson(result.stdout))
    : null;
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      const value = row?.[field];
      return [name, value === 1 || value === true
        ? true
        : value === 0 || value === false
          ? false
          : null];
    }),
  );
}

function schemaEvidenceStatus(values) {
  const statuses = Object.values(values);
  return statuses.every((value) => value === true)
    ? "verified"
    : statuses.some((value) => value === null)
      ? "unknown"
      : "incomplete";
}

function primaryIdentityProtectionSchemaEvidence(result) {
  const values = schemaProbeValues(
    result,
    PRIMARY_IDENTITY_PROTECTION_SCHEMA_FIELDS,
  );
  const status = schemaEvidenceStatus(values);
  return {
    status,
    verified: status === "verified",
    tables: {
      identityReenrollmentCooldowns: values.cooldownTable,
      identityLinkSecretConfiguration:
        values.identityLinkSecretConfigurationTable,
    },
    columns: {
      participantCooldownDigest: values.participantCooldownDigestColumn,
      cooldownDigest: values.cooldownDigestColumn,
      schemaVersion: values.cooldownSchemaVersionColumn,
      deletedAt: values.cooldownDeletedAtColumn,
      retainUntil: values.cooldownRetainUntilColumn,
      identityLinkSecretConfigurationSingleton:
        values.identityLinkSecretConfigurationSingleton,
      identityLinkSecretConfigurationKeyVersion:
        values.identityLinkSecretConfigurationKeyVersion,
      identityLinkSecretConfigurationSecretFingerprint:
        values.identityLinkSecretConfigurationSecretFingerprint,
      identityLinkSecretConfigurationRecordedAt:
        values.identityLinkSecretConfigurationRecordedAt,
    },
    constraints: {
      identityLinkSecretConfigurationColumnsExact:
        values.identityLinkSecretConfigurationColumnsExact,
      identityLinkSecretConfigurationSingletonCheck:
        values.identityLinkSecretConfigurationSingletonCheck,
      identityLinkSecretConfigurationKeyVersionCheck:
        values.identityLinkSecretConfigurationKeyVersionCheck,
      identityLinkSecretConfigurationFingerprintCheck:
        values.identityLinkSecretConfigurationFingerprintCheck,
      identityLinkSecretConfigurationCheckCount:
        values.identityLinkSecretConfigurationCheckCount,
      identityLinkSecretConfigurationStrict:
        values.identityLinkSecretConfigurationStrict,
      identityLinkSecretConfigurationNoExtraObjects:
        values.identityLinkSecretConfigurationNoExtraObjects,
    },
    indexes: {
      retention: values.cooldownRetentionIndex,
      retentionShape: values.cooldownRetentionIndexShape,
    },
    triggers: {
      reenrollmentCooldownGuard: values.cooldownGuardTrigger,
    },
  };
}

function deletionLedgerIdentityProtectionSchemaEvidence(result) {
  const values = schemaProbeValues(
    result,
    DELETION_LEDGER_IDENTITY_PROTECTION_SCHEMA_FIELDS,
  );
  const status = schemaEvidenceStatus(values);
  return {
    status,
    verified: status === "verified",
    tables: {
      deletionTombstones: values.tombstoneTable,
      identityReenrollmentCooldowns: values.cooldownTable,
    },
    columns: {
      participantDigest: values.tombstoneParticipantDigestColumn,
      tombstoneSchemaVersion: values.tombstoneSchemaVersionColumn,
      tombstoneDeletedAt: values.tombstoneDeletedAtColumn,
      tombstoneRetainUntil: values.tombstoneRetainUntilColumn,
      cooldownDigest: values.cooldownDigestColumn,
      cooldownSchemaVersion: values.cooldownSchemaVersionColumn,
      cooldownDeletedAt: values.cooldownDeletedAtColumn,
      cooldownRetainUntil: values.cooldownRetainUntilColumn,
    },
    indexes: {
      tombstoneRetention: values.tombstoneRetentionIndex,
      tombstoneRetentionShape: values.tombstoneRetentionIndexShape,
      cooldownRetention: values.cooldownRetentionIndex,
      cooldownRetentionShape: values.cooldownRetentionIndexShape,
    },
  };
}

function identityProtectionSchemaEvidence(
  primaryResult = { ok: false },
  deletionLedgerResult = { ok: false },
) {
  const primary = primaryIdentityProtectionSchemaEvidence(primaryResult);
  const deletionLedger = deletionLedgerIdentityProtectionSchemaEvidence(
    deletionLedgerResult,
  );
  const statuses = [primary.status, deletionLedger.status];
  const status = statuses.every((value) => value === "verified")
    ? "verified"
    : statuses.some((value) => value === "unknown")
      ? "unknown"
      : "incomplete";
  return {
    status,
    verified: status === "verified",
    primary,
    deletionLedger,
  };
}

function schemaProtectionBlocker(status, prefix) {
  return status === "verified"
    ? null
    : `REMOTE_${prefix}_SCHEMA_${status === "unknown" ? "UNKNOWN" : "INCOMPLETE"}`;
}

export function identityProtectionSchemaVerified(readiness) {
  return readiness?.checks?.identityProtectionSchemaCurrent === true
    && readiness?.evidence?.identityProtectionSchema?.status === "verified"
    && readiness.evidence.identityProtectionSchema.verified === true;
}

function safeSchemaEvidence(value) {
  const status = ["verified", "incomplete", "unknown"].includes(value?.status)
    ? value.status
    : null;
  if (status === null) return null;
  const booleanOrNull = (candidate) =>
    candidate === true || candidate === false || candidate === null
      ? candidate
      : null;
  const side = (
    candidate,
    { tables, columns, constraints = null, indexes, triggers = null },
  ) => {
    const sideStatus = ["verified", "incomplete", "unknown"].includes(
      candidate?.status,
    )
      ? candidate.status
      : null;
    if (sideStatus === null) return null;
    const safeSide = {
      status: sideStatus,
      verified: sideStatus === "verified",
      tables: Object.fromEntries(
        tables.map((key) => [key, booleanOrNull(candidate?.tables?.[key])]),
      ),
      columns: Object.fromEntries(
        columns.map((key) => [key, booleanOrNull(candidate?.columns?.[key])]),
      ),
    };
    if (constraints !== null) {
      safeSide.constraints = Object.fromEntries(
        constraints.map((key) => [
          key,
          booleanOrNull(candidate?.constraints?.[key]),
        ]),
      );
    }
    safeSide.indexes = Object.fromEntries(
      indexes.map((key) => [key, booleanOrNull(candidate?.indexes?.[key])]),
    );
    if (triggers !== null) {
      safeSide.triggers = Object.fromEntries(
        triggers.map((key) => [key, booleanOrNull(candidate?.triggers?.[key])]),
      );
    }
    return safeSide;
  };
  const primary = side(value.primary, {
    tables: [
      "identityReenrollmentCooldowns",
      "identityLinkSecretConfiguration",
    ],
    columns: [
      "participantCooldownDigest",
      "cooldownDigest",
      "schemaVersion",
      "deletedAt",
      "retainUntil",
      "identityLinkSecretConfigurationSingleton",
      "identityLinkSecretConfigurationKeyVersion",
      "identityLinkSecretConfigurationSecretFingerprint",
      "identityLinkSecretConfigurationRecordedAt",
    ],
    constraints: [
      "identityLinkSecretConfigurationColumnsExact",
      "identityLinkSecretConfigurationSingletonCheck",
      "identityLinkSecretConfigurationKeyVersionCheck",
      "identityLinkSecretConfigurationFingerprintCheck",
      "identityLinkSecretConfigurationCheckCount",
      "identityLinkSecretConfigurationStrict",
      "identityLinkSecretConfigurationNoExtraObjects",
    ],
    indexes: ["retention", "retentionShape"],
    triggers: ["reenrollmentCooldownGuard"],
  });
  const deletionLedger = side(value.deletionLedger, {
    tables: ["deletionTombstones", "identityReenrollmentCooldowns"],
    columns: [
      "participantDigest",
      "tombstoneSchemaVersion",
      "tombstoneDeletedAt",
      "tombstoneRetainUntil",
      "cooldownDigest",
      "cooldownSchemaVersion",
      "cooldownDeletedAt",
      "cooldownRetainUntil",
    ],
    indexes: [
      "tombstoneRetention",
      "tombstoneRetentionShape",
      "cooldownRetention",
      "cooldownRetentionShape",
    ],
  });
  if (primary === null || deletionLedger === null) return null;
  return {
    status,
    verified: status === "verified",
    primary,
    deletionLedger,
  };
}
export function stagingOperationReceipt(
  operation,
  evidence,
  generatedAt = new Date().toISOString(),
) {
  if (![
    "disabled_staging_prepared",
    "disabled_staging_deployed",
  ].includes(operation)) {
    throw new Error("Unsupported staging receipt operation");
  }
  const allowedEvidence = [
    "originMatchedWranglerOutput",
    "remoteResourcesVerified",
    "resourcesVerified",
    "staticConfigurationChecked",
    "remoteReadOnlyProof",
    "migrationInventoryCurrent",
    "migrationsCurrent",
    "pilotSchemaCurrent",
    "primaryReenrollmentSchemaCurrent",
    "deletionLedgerSchemaCurrent",
    "identityProtectionSchemaCurrent",
    "collectionContained",
    "secretsInstalled",
    "healthContained",
  ];
  const fixedEvidence = Object.fromEntries(
    allowedEvidence
      .filter((key) => typeof evidence?.[key] === "boolean")
      .map((key) => [key, evidence[key]]),
  );
  const safeIdentitySchema = safeSchemaEvidence(evidence?.identityProtectionSchema);
  if (safeIdentitySchema !== null) {
    fixedEvidence.identityProtectionSchema = safeIdentitySchema;
  }
  if (typeof evidence?.lifecycleReadiness === "string"
      && ["ready", "not_ready"].includes(evidence.lifecycleReadiness)) {
    fixedEvidence.lifecycleReadiness = evidence.lifecycleReadiness;
  }
  return {
    schemaVersion: STAGING_OPERATION_RECEIPT_SCHEMA_VERSION,
    operation,
    environment: "staging",
    evidenceType: STAGING_PROOF_TYPES.OPERATION_RECEIPT,
    generatedAt,
    collectionAuthorized: false,
    activationState: "not_authorized",
    evidence: fixedEvidence,
  };
}

export function probeStagingLive({
  config,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  const configuration = assessStagingConfiguration(config, { workerDirectory });
  const environment = config?.env?.staging ?? {};
  const checks = {
    authenticated: false,
    d1ServiceReachable: false,
    r2ServiceReachable: false,
    d1ResourcesExist: false,
    r2ResourceExists: false,
    requiredSecretsInstalled: false,
    remoteMigrationInventoryCurrent: false,
    migrationsCurrent: false,
    pilotSchemaCurrent: false,
    primaryReenrollmentSchemaCurrent: false,
    deletionLedgerSchemaCurrent: false,
    identityProtectionSchemaCurrent: false,
    collectionContained: false,
  };
  let migrationProof = [];
  let collectionControlState = "unknown";
  let identitySchemaEvidence = identityProtectionSchemaEvidence();
  const blockers = [...configuration.blockers];

  if (configuration.state === "unsafe_configuration") {
    return {
      schemaVersion: STAGING_READINESS_SCHEMA_VERSION,
      environment: "staging",
      evidenceType: STAGING_PROOF_TYPES.STATIC_CONFIGURATION,
      liveProof: false,
      state: "unsafe_configuration",
      collectionAuthorized: false,
      migrationInventory: configuration.migrationInventory,
      collectionControlState,
      evidence: {
        identityProtectionSchema: identitySchemaEvidence,
      },
      checks: {
        ...configuration.checks,
        ...checks,
      },
      blockers: [...new Set(blockers)],
    };
  }

  const authenticated = runWrangler(
    wrangler,
    workerDirectory,
    ["whoami"],
    spawn,
  );
  checks.authenticated = authenticated.ok;
  if (!authenticated.ok) blockers.push("CLOUDFLARE_AUTHENTICATION_UNAVAILABLE");

  const d1List = runWrangler(
    wrangler,
    workerDirectory,
    ["d1", "list", "--json"],
    spawn,
  );
  checks.d1ServiceReachable = d1List.ok && Array.isArray(parseJson(d1List.stdout));
  if (!checks.d1ServiceReachable) blockers.push("D1_SERVICE_UNAVAILABLE");

  const r2List = runWrangler(
    wrangler,
    workerDirectory,
    ["r2", "bucket", "list"],
    spawn,
  );
  checks.r2ServiceReachable = r2List.ok;
  if (!r2List.ok) {
    blockers.push(
      /(?:code:\s*10042|enable R2)/iu.test(`${r2List.stderr}${r2List.stdout}`)
        ? "R2_NOT_ENABLED"
        : "R2_SERVICE_UNAVAILABLE",
    );
  }

  if (configuration.checks.resourceIdentifiersConfigured
      && checks.d1ServiceReachable) {
    const databases = parseJson(d1List.stdout);
    checks.d1ResourcesExist = environment.d1_databases.every((binding) =>
      databases.some((database) =>
        database?.uuid === binding.database_id
        && database?.name === binding.database_name));
    if (!checks.d1ResourcesExist) blockers.push("D1_RESOURCES_MISSING");
  }

  if (checks.r2ServiceReachable && configuration.checks.r2BindingSafe) {
    const bucket = environment.r2_buckets[0];
    const r2Info = runWrangler(
      wrangler,
      workerDirectory,
      ["r2", "bucket", "info", bucket.bucket_name, "--json"],
      spawn,
    );
    const info = parseJson(r2Info.stdout);
    checks.r2ResourceExists = r2Info.ok
      && info?.name === bucket.bucket_name;
    if (!checks.r2ResourceExists) blockers.push("R2_RESOURCE_MISSING");
  }

  if (configuration.checks.resourceIdentifiersConfigured
      && checks.d1ResourcesExist && checks.r2ResourceExists) {
    const secrets = runWrangler(
      wrangler,
      workerDirectory,
      ["secret", "list", "--env", "staging", "--format", "json"],
      spawn,
    );
    const secretRows = parseJson(secrets.stdout);
    const secretNames = Array.isArray(secretRows)
      ? secretRows.map((entry) => entry?.name)
      : [];
    checks.requiredSecretsInstalled = secrets.ok
      && REQUIRED_STAGING_SECRETS.every((name) => secretNames.includes(name));
    if (!checks.requiredSecretsInstalled) {
      blockers.push("REQUIRED_STAGING_SECRETS_MISSING");
    }

    const migrationStates = REQUIRED_D1_BINDINGS.map((entry) => {
      const result = runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "execute", entry.binding,
          "--remote", "--env", "staging",
          "--command", READ_ONLY_MIGRATION_PROBE_SQL,
          "--json",
        ],
        spawn,
      );
      const state = classifyMigrationProbe(
        result,
        EXPECTED_STAGING_MIGRATIONS[entry.binding],
      );
      return Object.freeze({
        binding: entry.binding,
        status: state.status,
        code: state.code,
      });
    });
    migrationProof = migrationStates;
    checks.remoteMigrationInventoryCurrent = migrationStates.every(
      (state) => state.status === "current",
    );
    checks.migrationsCurrent = checks.remoteMigrationInventoryCurrent;
    blockers.push(
      ...migrationStates
        .map((state) => state.code)
        .filter((code) => code !== null),
    );

    const probeCollectionControls = () => {
      const control = runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "execute", "USAGE_MONITOR_DB",
          "--remote", "--env", "staging",
          "--command", COLLECTION_CONTROL_PROBE_SQL,
          "--json",
        ],
        spawn,
      );
      collectionControlState = collectionControlProbeState(control);
      if (collectionControlState === "missing"
          && migrationStates.every((state) => state.status === "uninitialized")) {
        collectionControlState = "fresh";
      } else if (collectionControlState === "uncontained") {
        blockers.push("REMOTE_COLLECTION_NOT_CONTAINED");
      } else if (collectionControlState === "invalid") {
        blockers.push("REMOTE_COLLECTION_CONTROLS_INVALID");
      } else if (collectionControlState === "unknown") {
        blockers.push("REMOTE_COLLECTION_CONTROLS_UNKNOWN");
      } else if (collectionControlState === "missing") {
        blockers.push("REMOTE_COLLECTION_CONTROLS_UNAVAILABLE");
      }
      checks.collectionContained = collectionControlState === "contained";
    };

    if (!checks.migrationsCurrent) probeCollectionControls();

    if (checks.migrationsCurrent) {
      const schemaProbe = runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "execute", "USAGE_MONITOR_DB",
          "--remote", "--env", "staging",
          "--command",
          `SELECT
             EXISTS(
               SELECT 1 FROM sqlite_master
                WHERE type = 'table'
                  AND name = 'telemetry_contribution_admission_windows'
             ) AS admission_table,
             EXISTS(
               SELECT 1 FROM sqlite_master
                WHERE type = 'trigger'
                  AND name = 'telemetry_contributions_enforce_admission_window'
             ) AS admission_guard,
             EXISTS(
               SELECT 1 FROM sqlite_master
                WHERE type = 'trigger'
                  AND name = 'telemetry_contributions_record_admission_window'
             ) AS admission_counter,
             EXISTS(
               SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'pending_quarantine_objects'
             ) AS quarantine_reconciliation,
             EXISTS(
               SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'retention_state'
             ) AS lifecycle_status;`,
          "--json",
        ],
        spawn,
      );
      const schemaRow = collectionControlRow(parseJson(schemaProbe.stdout));
      checks.pilotSchemaCurrent = schemaProbe.ok
        && schemaRow?.admission_table === 1
        && schemaRow?.admission_guard === 1
        && schemaRow?.admission_counter === 1
        && schemaRow?.quarantine_reconciliation === 1
        && schemaRow?.lifecycle_status === 1;
      if (!checks.pilotSchemaCurrent) {
        blockers.push("REMOTE_PILOT_SCHEMA_INCOMPLETE");
      }

      const primaryIdentitySchemaProbe = runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "execute", "USAGE_MONITOR_DB",
          "--remote", "--env", "staging",
          "--command", PRIMARY_IDENTITY_PROTECTION_SCHEMA_SQL,
          "--json",
        ],
        spawn,
      );
      const deletionLedgerIdentitySchemaProbe = runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "execute", "DELETION_LEDGER",
          "--remote", "--env", "staging",
          "--command", DELETION_LEDGER_IDENTITY_PROTECTION_SCHEMA_SQL,
          "--json",
        ],
        spawn,
      );
      identitySchemaEvidence = identityProtectionSchemaEvidence(
        primaryIdentitySchemaProbe,
        deletionLedgerIdentitySchemaProbe,
      );
      checks.primaryReenrollmentSchemaCurrent =
        identitySchemaEvidence.primary.verified;
      checks.deletionLedgerSchemaCurrent =
        identitySchemaEvidence.deletionLedger.verified;
      checks.identityProtectionSchemaCurrent = identitySchemaEvidence.verified;
      const primarySchemaBlocker = schemaProtectionBlocker(
        identitySchemaEvidence.primary.status,
        "IDENTITY_REENROLLMENT",
      );
      if (primarySchemaBlocker) blockers.push(primarySchemaBlocker);
      const deletionLedgerSchemaBlocker = schemaProtectionBlocker(
        identitySchemaEvidence.deletionLedger.status,
        "DELETION_LEDGER",
      );
      if (deletionLedgerSchemaBlocker) {
        blockers.push(deletionLedgerSchemaBlocker);
      }

    }
    if (checks.migrationsCurrent) probeCollectionControls();
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    schemaVersion: STAGING_READINESS_SCHEMA_VERSION,
    environment: "staging",
    evidenceType: STAGING_PROOF_TYPES.LIVE_REMOTE,
    liveProof: true,
    state: uniqueBlockers.length === 0
      ? "ready_for_disabled_deploy"
      : configuration.state === "unsafe_configuration"
        ? "unsafe_configuration"
        : "blocked",
    collectionAuthorized: false,
    migrationInventory: configuration.migrationInventory,
    migrationProof,
    collectionControlState,
    checks: {
      ...configuration.checks,
      ...checks,
    },
    evidence: {
      identityProtectionSchema: identitySchemaEvidence,
    },
    blockers: uniqueBlockers,
  };
}
