import assert from "node:assert/strict";
import test from "node:test";
import {
  assessStagingConfiguration,
  GENERATED_WORKER_ASSET_DIRECTORY,
  probeStagingLive,
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
  assert.equal(result.checks.enrollmentDisabled, true);
  assert.equal(result.checks.accountScopedIngestDisabled, true);
  assert.equal(result.checks.assetsClosed, true);
  assert.equal(result.checks.resourceIdentifiersConfigured, false);
  assert.deepEqual(result.blockers, [
    "STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED",
  ]);
  assert.equal(JSON.stringify(result).includes("app-usagemonitor-staging"), false);
});

test("every deployable Worker asset environment uses the generated community tree", () => {
  for (const environment of [
    checkedInConfig,
    checkedInConfig.env.staging,
    checkedInConfig.env.production,
  ]) {
    assert.equal(environment.assets.directory, GENERATED_WORKER_ASSET_DIRECTORY);
    assert.equal(environment.assets.not_found_handling, "single-page-application");
  }
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
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(config.env.staging.d1_databases[0].database_id), false);
  assert.equal(serialized.includes(config.env.staging.r2_buckets[0].bucket_name), false);
});

test("live readiness blocks missing identity protection schema in either database", () => {
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
    assert.equal(result.blockers.includes(scenario.blocker), true, scenario.name);
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
