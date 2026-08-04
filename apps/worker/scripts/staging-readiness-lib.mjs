import { spawnSync } from "node:child_process";

export const STAGING_READINESS_SCHEMA_VERSION =
  "usage-monitor-staging-readiness-v0.1";
export const STAGING_OPERATION_RECEIPT_SCHEMA_VERSION =
  "usage-monitor-staging-operation-receipt-v0.1";
export const REQUIRED_STAGING_SECRETS = Object.freeze([
  "ENVELOPE_PRIVATE_JWK",
  "ENVELOPE_PUBLIC_JWK",
]);
export const REQUIRED_D1_BINDINGS = Object.freeze([
  Object.freeze({
    binding: "USAGE_MONITOR_DB",
    migrationsDir: "migrations",
  }),
  Object.freeze({
    binding: "DELETION_LEDGER",
    migrationsDir: "deletion-ledger-migrations",
  }),
]);
export const REQUIRED_RATE_LIMITS = Object.freeze([
  Object.freeze({ name: "ENROLLMENT_RATE_LIMIT", limit: 20 }),
  Object.freeze({ name: "RECOVERY_RATE_LIMIT", limit: 20 }),
  Object.freeze({ name: "CLIENT_ATTEMPT_RATE_LIMIT", limit: 5 }),
  Object.freeze({ name: "PUBLIC_READ_RATE_LIMIT", limit: 120 }),
]);
export const GENERATED_WORKER_ASSET_DIRECTORY =
  "../../.release-build/worker-assets";
const ALLOWED_WORKER_FIRST_ROUTES = Object.freeze([
  "/api/*",
  "/.well-known/apple-developer-domain-association.txt",
]);
const FORBIDDEN_PUBLIC_ROUTE_PATTERN =
  /(?:^|\/)(?:admin|app-open|contribution|sign-?in|signin)(?:\/|\*|$)/iu;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLACEHOLDER_UUID_PATTERN =
  /^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$/u;

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

function validStagingName(value) {
  return typeof value === "string"
    && /^app-usagemonitor-staging(?:-[a-z0-9-]+)?$/u.test(value);
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

function deployableAssetRoutesClosed(config) {
  return [
    config?.assets,
    config?.env?.staging?.assets,
    config?.env?.production?.assets,
  ].every((assets) => safeDeployableAssetRoute(assets));
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
    return validStagingName(binding?.database_name)
      && binding?.migrations_dir === expected.migrationsDir
      && typeof binding?.database_id === "string"
      && UUID_PATTERN.test(binding.database_id);
  });
}

function safeR2Binding(value) {
  return Array.isArray(value)
    && value.length === 1
    && value[0]?.binding === "QUARANTINE"
    && validStagingName(value[0]?.bucket_name)
    && value[0].bucket_name.endsWith("-quarantine");
}

function resourceIdentifiersConfigured(environment) {
  const ids = environment.d1_databases?.map((entry) => entry.database_id) ?? [];
  return ids.length === REQUIRED_D1_BINDINGS.length
    && new Set(ids).size === ids.length
    && ids.every((entry) => UUID_PATTERN.test(entry)
      && !PLACEHOLDER_UUID_PATTERN.test(entry));
}

export function assessStagingConfiguration(config) {
  const environment = config?.env?.staging;
  const checks = {
    environmentDeclared:
      typeof environment === "object" && environment !== null,
    publicNameSafe: validStagingName(environment?.name),
    workersDevHttpsEnabled: environment?.workers_dev === true,
    previewUrlsDisabled: environment?.preview_urls === false,
    observabilityEnabled: environment?.observability?.enabled === true
      && environment?.observability?.head_sampling_rate === 1,
    hourlyLifecycleDeclared:
      Array.isArray(environment?.triggers?.crons)
      && environment.triggers.crons.length === 1
      && environment.triggers.crons[0] === "0 * * * *",
    enrollmentDisabled: environment?.vars?.ENVIRONMENT === "staging"
      && environment?.vars?.ENROLLMENT_MODE === "disabled",
    accountScopedIngestDisabled:
      environment?.vars?.ACCOUNT_SCOPED_INGEST_MODE === "disabled",
    noUnexpectedVariables: environment?.vars
      && Object.keys(environment.vars).length === 3,
    requiredSecretsDeclared: exactStringSet(
      environment?.secrets?.required,
      REQUIRED_STAGING_SECRETS,
    ),
    d1BindingsSafe: safeD1Bindings(environment?.d1_databases),
    d1ResourcesDistinct:
      new Set(
        environment?.d1_databases?.map((entry) => entry.database_name) ?? [],
      ).size === REQUIRED_D1_BINDINGS.length,
    r2BindingSafe: safeR2Binding(environment?.r2_buckets),
    rateLimitsSafe: safeRateLimits(environment?.ratelimits),
    assetsClosed: oneApiAssetRoute(environment?.assets),
    deployableAssetsClosed: deployableAssetRoutesClosed(config),
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
    ...(!checks.resourceIdentifiersConfigured
      ? ["STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED"]
      : []),
  ];
  return {
    schemaVersion: STAGING_READINESS_SCHEMA_VERSION,
    environment: "staging",
    state: safetyBlockers.length > 0
      ? "unsafe_configuration"
      : checks.resourceIdentifiersConfigured
        ? "configured_unverified"
        : "safe_unprovisioned",
    collectionAuthorized: false,
    checks,
    blockers,
  };
}

function runWrangler(wrangler, workerDirectory, args, spawn = spawnSync) {
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
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function migrationCurrent(output) {
  return /No migrations to apply[.!]?/iu.test(output);
}

function collectionControlRow(value) {
  const statements = Array.isArray(value) ? value : [];
  return statements.findLast(
    (entry) => Array.isArray(entry?.results) && entry.results.length === 1,
  )?.results?.[0] ?? null;
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
  return {
    schemaVersion: STAGING_OPERATION_RECEIPT_SCHEMA_VERSION,
    operation,
    environment: "staging",
    generatedAt,
    collectionAuthorized: false,
    activationState: "not_authorized",
    evidence,
  };
}

export function probeStagingLive({
  config,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
}) {
  const configuration = assessStagingConfiguration(config);
  const environment = config?.env?.staging ?? {};
  const checks = {
    authenticated: false,
    d1ServiceReachable: false,
    r2ServiceReachable: false,
    d1ResourcesExist: false,
    r2ResourceExists: false,
    requiredSecretsInstalled: false,
    migrationsCurrent: false,
    pilotSchemaCurrent: false,
    collectionContained: false,
  };
  const blockers = [...configuration.blockers];

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

    const migrationResults = REQUIRED_D1_BINDINGS.map((entry) =>
      runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "migrations", "list", entry.binding,
          "--remote", "--env", "staging",
        ],
        spawn,
      ));
    checks.migrationsCurrent = migrationResults.every((result) =>
      result.ok && migrationCurrent(`${result.stdout}${result.stderr}`));
    if (!checks.migrationsCurrent) blockers.push("REMOTE_MIGRATIONS_PENDING");

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

      const control = runWrangler(
        wrangler,
        workerDirectory,
        [
          "d1", "execute", "USAGE_MONITOR_DB",
          "--remote", "--env", "staging",
          "--command",
          `SELECT schema_version,
                  control_state,
                  enrollment_enabled,
                  upload_registration_enabled,
                  processing_enabled,
                  publication_enabled
             FROM collection_controls
            WHERE singleton = 1;`,
          "--json",
        ],
        spawn,
      );
      const row = collectionControlRow(parseJson(control.stdout));
      checks.collectionContained = control.ok
        && row?.schema_version === "collection-controls-v0.1"
        && row?.control_state === "contained"
        && row?.enrollment_enabled === 0
        && row?.upload_registration_enabled === 0
        && row?.processing_enabled === 0
        && row?.publication_enabled === 0;
      if (!checks.collectionContained) {
        blockers.push("REMOTE_COLLECTION_NOT_CONTAINED");
      }
    }
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    schemaVersion: STAGING_READINESS_SCHEMA_VERSION,
    environment: "staging",
    state: uniqueBlockers.length === 0
      ? "ready_for_disabled_deploy"
      : configuration.state === "unsafe_configuration"
        ? "unsafe_configuration"
        : "blocked",
    collectionAuthorized: false,
    checks: {
      ...configuration.checks,
      ...checks,
    },
    blockers: uniqueBlockers,
  };
}
