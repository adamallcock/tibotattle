import assert from "node:assert/strict";
import test from "node:test";
import {
  assessStagingConfiguration,
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

test("unsafe staging admission configuration fails closed", () => {
  const config = structuredClone(checkedInConfig);
  config.env.staging.vars.ENROLLMENT_MODE = "local_open";
  const result = assessStagingConfiguration(config);
  assert.equal(result.state, "unsafe_configuration");
  assert.equal(result.checks.enrollmentDisabled, false);
  assert.equal(result.blockers.includes("CONFIG_ENROLLMENT_DISABLED"), true);
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
  assert.deepEqual(result.blockers, []);
  assert.equal(calls.filter((args) => args[0] === "d1").length, 4);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(config.env.staging.d1_databases[0].database_id), false);
  assert.equal(serialized.includes(config.env.staging.r2_buckets[0].bucket_name), false);
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
