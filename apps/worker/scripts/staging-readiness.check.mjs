import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  assessStagingConfiguration,
  EXPECTED_STAGING_MIGRATIONS,
  GENERATED_WORKER_ASSET_DIRECTORY,
  PRODUCTION_PUBLIC_ASSET_DIRECTORY,
  probeStagingLive,
  STAGING_PROOF_TYPES,
  stagingOperationReceipt,
  validateStagingMigrationInventory,
} from "./staging-readiness-lib.mjs";
import {
  checkedInConfig,
  provisionedConfig,
  successSpawn,
  workerDirectory,
} from "./staging-test-fixtures.mjs";

test("checked-in staging configuration is closed and intentionally unprovisioned", () => {
  const result = assessStagingConfiguration(checkedInConfig);
  assert.equal(result.state, "safe_unprovisioned");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.evidenceType, STAGING_PROOF_TYPES.STATIC_CONFIGURATION);
  assert.equal(result.liveProof, false);
  assert.equal(result.checks.enrollmentDisabled, true);
  assert.equal(result.checks.accountScopedIngestDisabled, true);
  assert.equal(result.checks.assetsClosed, true);
  assert.equal(result.checks.migrationInventorySafe, true);
  assert.deepEqual(
    result.migrationInventory.USAGE_MONITOR_DB.slice(-6),
    EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.slice(-6),
  );
  assert.deepEqual(
    result.migrationInventory.DELETION_LEDGER,
    EXPECTED_STAGING_MIGRATIONS.DELETION_LEDGER,
  );
  assert.equal(result.checks.resourceIdentifiersConfigured, false);
  assert.deepEqual(result.blockers, [
    "STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED",
  ]);
  assert.equal(JSON.stringify(result).includes("app-usagemonitor-staging"), false);
});

test("migration inventory is exact and rejects missing or unreviewed files", () => {
  const inventory = structuredClone(EXPECTED_STAGING_MIGRATIONS);
  assert.equal(
    inventory.USAGE_MONITOR_DB.at(-1),
    "0041_community_model_composition_cache.sql",
  );
  assert.deepEqual(validateStagingMigrationInventory(inventory), {
    ok: true,
    code: null,
  });

  inventory.USAGE_MONITOR_DB.pop();
  assert.deepEqual(validateStagingMigrationInventory(inventory), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const extra = structuredClone(EXPECTED_STAGING_MIGRATIONS);
  extra.USAGE_MONITOR_DB.push("0029_unreviewed.sql");
  extra.USAGE_MONITOR_DB.sort();
  assert.deepEqual(validateStagingMigrationInventory(extra), {
    ok: false,
    code: "LOCAL_MIGRATION_INVENTORY_DRIFT",
  });

  const missing = assessStagingConfiguration(checkedInConfig, {
    workerDirectory: "/definitely-missing-staging-worker-directory",
  });
  assert.equal(missing.state, "unsafe_configuration");
  assert.equal(missing.checks.migrationInventorySafe, false);
  assert.equal(
    missing.blockers.includes("LOCAL_MIGRATION_INVENTORY_DRIFT"),
    true,
  );
});

test("staging readiness rejects production resources and custom-domain targets", () => {
  const productionResource = structuredClone(checkedInConfig);
  productionResource.env.staging.d1_databases[0].database_name =
    productionResource.env.production.d1_databases[0].database_name;
  const productionResult = assessStagingConfiguration(productionResource);
  assert.equal(productionResult.state, "unsafe_configuration");
  assert.equal(productionResult.checks.d1BindingsSafe, false);
  assert.equal(productionResult.blockers.includes(
    "CONFIG_D1_BINDINGS_SAFE",
  ), true);

  const customDomain = structuredClone(checkedInConfig);
  customDomain.env.staging.routes = [
    { pattern: "tibotattle.com", custom_domain: true },
  ];
  const customDomainResult = assessStagingConfiguration(customDomain);
  assert.equal(customDomainResult.state, "unsafe_configuration");
  assert.equal(customDomainResult.checks.originBoundaryClosed, false);
  assert.equal(customDomainResult.blockers.includes(
    "CONFIG_ORIGIN_BOUNDARY_CLOSED",
  ), true);
});

test("deployable Worker asset environments fail closed around generated public trees", () => {
  for (const environment of [
    checkedInConfig,
    checkedInConfig.env.staging,
  ]) {
    assert.equal(environment.assets.directory, GENERATED_WORKER_ASSET_DIRECTORY);
    assert.equal(environment.assets.not_found_handling, "single-page-application");
  }
  assert.equal(
    checkedInConfig.env.production.assets.directory,
    PRODUCTION_PUBLIC_ASSET_DIRECTORY,
  );
  assert.equal(
    checkedInConfig.env.production.assets.not_found_handling,
    "404-page",
  );
  assert.equal(
    checkedInConfig.env.production.assets.run_worker_first,
    true,
  );
  assert.equal(
    assessStagingConfiguration(checkedInConfig).checks.deployableAssetsClosed,
    true,
  );
});

test("staging readiness rejects dashboard source and local control asset routes", () => {
  for (const directory of [
    "../web/public",
    "../../.release-build/public-release-site",
  ]) {
    const config = structuredClone(checkedInConfig);
    config.env.staging.assets.directory = directory;
    const result = assessStagingConfiguration(config);
    assert.equal(result.checks.assetsClosed, false, directory);
    assert.equal(result.checks.deployableAssetsClosed, false, directory);
  }
  for (const route of [
    "/admin/*",
    "/sign-in/*",
    "/contribution/*",
    "/app-open/*",
  ]) {
    const config = structuredClone(checkedInConfig);
    config.env.staging.assets.run_worker_first = ["/api/*", route];
    const result = assessStagingConfiguration(config);
    assert.equal(result.checks.assetsClosed, false, route);
    assert.equal(result.checks.deployableAssetsClosed, false, route);
  }
});

test("production asset routing fails closed without full Worker-first canonicalization", () => {
  for (const runWorkerFirst of [
    false,
    ["/api/*", "/admin", "/admin/*"],
  ]) {
    const config = structuredClone(checkedInConfig);
    config.env.production.assets.run_worker_first = runWorkerFirst;
    const result = assessStagingConfiguration(config);
    assert.equal(result.checks.deployableAssetsClosed, false);
  }
});

test("unsafe staging admission configuration fails closed", () => {
  const config = structuredClone(checkedInConfig);
  config.env.staging.vars.ENROLLMENT_MODE = "local_open";
  const result = assessStagingConfiguration(config);
  assert.equal(result.state, "unsafe_configuration");
  assert.equal(result.checks.enrollmentDisabled, false);
  assert.equal(result.blockers.includes("CONFIG_ENROLLMENT_DISABLED"), true);
});

test("staging readiness rejects a missing ingress budget binding or migration", () => {
  const withoutBinding = structuredClone(checkedInConfig);
  withoutBinding.env.staging.durable_objects.bindings = [];
  const bindingResult = assessStagingConfiguration(withoutBinding);
  assert.equal(bindingResult.state, "unsafe_configuration");
  assert.equal(bindingResult.blockers.includes(
    "CONFIG_INGRESS_BUDGET_BINDING_SAFE",
  ), true);

  const withoutMigration = structuredClone(checkedInConfig);
  withoutMigration.migrations = [];
  const migrationResult = assessStagingConfiguration(withoutMigration);
  assert.equal(migrationResult.state, "unsafe_configuration");
  assert.equal(migrationResult.blockers.includes(
    "CONFIG_INGRESS_BUDGET_MIGRATION_SAFE",
  ), true);
});

test("live readiness proves resources, secrets, migrations, and containment", () => {
  const config = provisionedConfig();
  const calls = [];
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: successSpawn(config, calls),
  });
  assert.equal(result.state, "ready_for_disabled_deploy");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(result.evidenceType, STAGING_PROOF_TYPES.LIVE_REMOTE);
  assert.equal(result.liveProof, true);
  assert.equal(result.checks.remoteMigrationInventoryCurrent, true);
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.checks.primaryReenrollmentSchemaCurrent, true);
  assert.equal(result.checks.deletionLedgerSchemaCurrent, true);
  assert.equal(result.checks.identityProtectionSchemaCurrent, true);
  assert.equal(result.evidence.identityProtectionSchema.status, "verified");
  assert.equal(result.evidence.identityProtectionSchema.verified, true);
  assert.equal(
    result.evidence.identityProtectionSchema.primary.columns.participantCooldownDigest,
    true,
  );
  assert.equal(
    result.evidence.identityProtectionSchema.deletionLedger.columns.participantDigest,
    true,
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(calls.filter((args) => args[0] === "d1").length, 7);
  assert.equal(calls.some((args) => args.includes("migrations")), false);
  assert.equal(
    calls.filter((args) => args.some((value) =>
      typeof value === "string" && value.includes("FROM d1_migrations"))).length,
    2,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(config.env.staging.d1_databases[0].database_id), false);
  assert.equal(serialized.includes(config.env.staging.r2_buckets[0].bucket_name), false);
});

test("live readiness rejects an unreviewed remote migration inventory", () => {
  const config = provisionedConfig();
  const calls = [];
  const baseSpawn = successSpawn(config, calls);
  const spawn = (command, args, options) => {
    if (args[2] === "USAGE_MONITOR_DB" && args.some((value) =>
      typeof value === "string" && value.includes("FROM d1_migrations"))) {
      calls.push(args);
      return {
        status: 0,
        stdout: JSON.stringify([{
          results: [
            ...EXPECTED_STAGING_MIGRATIONS.USAGE_MONITOR_DB.map((name) => ({ name })),
            { name: "0029_unreviewed.sql" },
          ],
        }]),
        stderr: "private remote output",
      };
    }
    return baseSpawn(command, args, options);
  };
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.remoteMigrationInventoryCurrent, false);
  assert.equal(result.blockers.includes(
    "REMOTE_MIGRATION_INVENTORY_DRIFT",
  ), true);
  assert.equal(JSON.stringify(result).includes("0029_unreviewed.sql"), false);
  assert.equal(JSON.stringify(result).includes("private remote output"), false);
});

test("unsafe target configuration stops before any live command", () => {
  const config = structuredClone(checkedInConfig);
  config.env.staging.vars.PUBLIC_ORIGIN = "https://tibotattle.com";
  let called = false;
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: () => {
      called = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.state, "unsafe_configuration");
  assert.equal(result.liveProof, false);
  assert.equal(called, false);
});

test("operation receipts keep evidence fixed and non-secret", () => {
  const receipt = stagingOperationReceipt("disabled_staging_prepared", {
    resourcesVerified: true,
    lifecycleReadiness: "unexpected",
    secret: "do-not-record",
    commandOutput: "private command output",
  });
  assert.deepEqual(receipt.evidence, { resourcesVerified: true });
  assert.equal(JSON.stringify(receipt).includes("do-not-record"), false);
  assert.equal(JSON.stringify(receipt).includes("private command output"), false);
});

test("live readiness blocks missing or altered identity protection schema", () => {
  for (const scenario of [
    {
      name: "primary re-enrollment protection",
      options: { missingPrimarySchema: true },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
    },
    {
      name: "deletion-ledger cooldown protection",
      options: { missingDeletionLedgerSchema: true },
      check: "deletionLedgerSchemaCurrent",
      blocker: "REMOTE_DELETION_LEDGER_SCHEMA_INCOMPLETE",
      side: "deletionLedger",
    },
    {
      name: "primary identity-link secret configuration table",
      options: { missingIdentityLinkSecretConfiguration: true },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "tables",
      evidenceKey: "identityLinkSecretConfiguration",
    },
    {
      name: "primary identity-link secret configuration column",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_key_version",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "columns",
      evidenceKey: "identityLinkSecretConfigurationKeyVersion",
    },
    {
      name: "primary identity-link secret configuration extra column",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_columns_exact",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationColumnsExact",
    },
    {
      name: "primary identity-link secret configuration singleton check",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_singleton_check",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationSingletonCheck",
    },
    {
      name: "primary identity-link secret configuration key-version check",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_key_version_check",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationKeyVersionCheck",
    },
    {
      name: "primary identity-link secret configuration fingerprint check",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_fingerprint_check",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationFingerprintCheck",
    },
    {
      name: "primary identity-link secret configuration check count",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_check_count",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationCheckCount",
    },
    {
      name: "primary identity-link secret configuration strict flag",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_strict",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationStrict",
    },
    {
      name: "primary identity-link secret configuration extra object",
      options: {
        malformedIdentityLinkSecretConfigurationField:
          "primary_identity_link_secret_configuration_no_extra_objects",
      },
      check: "primaryReenrollmentSchemaCurrent",
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
      side: "primary",
      evidenceGroup: "constraints",
      evidenceKey: "identityLinkSecretConfigurationNoExtraObjects",
    },
  ]) {
    const config = provisionedConfig();
    const result = probeStagingLive({
      config,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn: successSpawn(config, [], scenario.options),
    });
    assert.equal(result.state, "blocked", scenario.name);
    assert.equal(result.checks[scenario.check], false, scenario.name);
    assert.equal(result.checks.identityProtectionSchemaCurrent, false);
    assert.equal(
      result.evidence.identityProtectionSchema.status,
      "incomplete",
      scenario.name,
    );
    assert.equal(
      result.evidence.identityProtectionSchema[scenario.side].status,
      "incomplete",
      scenario.name,
    );
    if (scenario.evidenceGroup) {
      assert.equal(
        result.evidence.identityProtectionSchema[scenario.side]
          [scenario.evidenceGroup][scenario.evidenceKey],
        false,
        scenario.name,
      );
    }
    assert.equal(result.blockers.includes(scenario.blocker), true, scenario.name);
  }
});

test("semantic identity-link proof matches the checked-in migrated table", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(readFileSync(join(
      workerDirectory,
      "migrations",
      "0028_identity_link_secret_configuration.sql",
    ), "utf8"));
    const config = provisionedConfig();
    const calls = [];
    const baseSpawn = successSpawn(config, calls);
    let identityProbeRow;
    const spawn = (command, args, options) => {
      const commandIndex = args.indexOf("--command");
      const commandText = commandIndex >= 0
        ? String(args[commandIndex + 1])
        : "";
      if (args[0] === "d1"
          && args[1] === "execute"
          && args[2] === "USAGE_MONITOR_DB"
          && commandText.includes(
            "primary_identity_link_secret_configuration_check_count",
          )) {
        identityProbeRow = database.prepare(commandText).get();
        return {
          status: 0,
          stdout: JSON.stringify([{ results: [identityProbeRow] }]),
          stderr: "",
        };
      }
      return baseSpawn(command, args, options);
    };
    probeStagingLive({
      config,
      wrangler: "/fake/wrangler",
      workerDirectory,
      spawn,
    });
    assert.deepEqual(
      Object.fromEntries([
        "primary_identity_link_secret_configuration_columns_exact",
        "primary_identity_link_secret_configuration_singleton_check",
        "primary_identity_link_secret_configuration_key_version_check",
        "primary_identity_link_secret_configuration_fingerprint_check",
        "primary_identity_link_secret_configuration_check_count",
        "primary_identity_link_secret_configuration_strict",
        "primary_identity_link_secret_configuration_no_extra_objects",
      ].map((key) => [key, identityProbeRow?.[key]])),
      {
        primary_identity_link_secret_configuration_columns_exact: 1,
        primary_identity_link_secret_configuration_singleton_check: 1,
        primary_identity_link_secret_configuration_key_version_check: 1,
        primary_identity_link_secret_configuration_fingerprint_check: 1,
        primary_identity_link_secret_configuration_check_count: 1,
        primary_identity_link_secret_configuration_strict: 1,
        primary_identity_link_secret_configuration_no_extra_objects: 1,
      },
    );
  } finally {
    database.close();
  }
});

test("live readiness marks an unavailable schema probe unknown without leaking output", () => {
  const config = provisionedConfig();
  const result = probeStagingLive({
    config,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: successSpawn(config, [], { primarySchemaError: true }),
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.checks.primaryReenrollmentSchemaCurrent, false);
  assert.equal(result.evidence.identityProtectionSchema.status, "unknown");
  assert.equal(result.evidence.identityProtectionSchema.primary.status, "unknown");
  assert.equal(
    result.blockers.includes("REMOTE_IDENTITY_REENROLLMENT_SCHEMA_UNKNOWN"),
    true,
  );
  assert.equal(JSON.stringify(result).includes("provider-secret"), false);
});

test("live readiness reports R2 account enablement without leaking command output", () => {
  const calls = [];
  const spawn = (_command, args) => {
    calls.push(args);
    if (args.join(" ") === "whoami") {
      return { status: 0, stdout: "private account details", stderr: "" };
    }
    if (args.join(" ") === "d1 list --json") {
      return { status: 0, stdout: "[]", stderr: "" };
    }
    if (args.join(" ") === "r2 bucket list") {
      return {
        status: 1,
        stdout: "",
        stderr: "Please enable R2 through the Dashboard. [code: 10042]",
      };
    }
    throw new Error("Unexpected fake Wrangler call");
  };
  const result = probeStagingLive({
    config: checkedInConfig,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.blockers.includes("R2_NOT_ENABLED"), true);
  assert.equal(JSON.stringify(result).includes("private account details"), false);
  assert.equal(JSON.stringify(result).includes("Dashboard"), false);
});
