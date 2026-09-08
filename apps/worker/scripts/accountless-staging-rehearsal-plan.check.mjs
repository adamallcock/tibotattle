import assert from "node:assert/strict";
import test from "node:test";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import {
  HOSTED_REHEARSAL_ACKNOWLEDGEMENT,
  planAccountlessStagingRehearsal,
} from "./accountless-staging-rehearsal-plan.mjs";
import { checkedInConfig, provisionedConfig } from "./staging-test-fixtures.mjs";

const SOURCE_COMMIT = "45fde21ec4de8a1edd9f7508e6bacaaad94bf6cb";

test("accountless hosted rehearsal plan fixes one origin and stays blocked before provisioning", () => {
  const plan = planAccountlessStagingRehearsal({
    config: checkedInConfig,
    sourceCommit: SOURCE_COMMIT,
  });
  assert.equal(plan.state, "blocked_unprovisioned");
  assert.equal(plan.remoteActionsAuthorized, false);
  assert.deepEqual(plan.target, {
    environment: "staging",
    origin: DEPLOYMENT_ENDPOINTS.staging.origin,
    previewUrls: false,
    routes: [],
    workerName: "app-usagemonitor-staging",
    workersDev: true,
  });
  assert.deepEqual(plan.publicPolicy, {
    accountScopedIngest: "disabled",
    enrollmentMode: "disabled",
    publication: false,
  });
  assert.deepEqual(plan.accountlessRuntime, {
    enrollmentMode: "enabled_for_one_rehearsal_deploy_only",
    ownershipMode: "enabled_for_one_rehearsal_deploy_only",
    rendererSelectable: false,
  });
  assert.equal(plan.syntheticClient.fixedOrigin, DEPLOYMENT_ENDPOINTS.staging.origin);
  assert.equal(plan.syntheticClient.acknowledgement, HOSTED_REHEARSAL_ACKNOWLEDGEMENT);
  assert.equal(plan.syntheticClient.proofScope, "hosted_client_only");
  assert.deepEqual(plan.syntheticClient.excludes, ["installed_scheduler"]);
  assert.equal(plan.requiredRemoteActions.some((step) => step.kind === "create_d1"), true);
  assert.equal(plan.requiredRemoteActions.some((step) => step.kind === "create_r2"), true);
  const freshBootstrap = plan.requiredRemoteActions.find(
    (step) => step.kind === "fresh_bootstrap_owner_migrations",
  );
  assert.equal(freshBootstrap.automatic, false);
  assert.equal(
    freshBootstrap.requiredBlocker,
    "OWNER_CONTAINMENT_REQUIRED_BEFORE_MIGRATIONS",
  );
  assert.deepEqual(freshBootstrap.commands, [
    ["wrangler", "d1", "migrations", "apply", "USAGE_MONITOR_DB", "--remote", "--env", "staging"],
    ["wrangler", "d1", "migrations", "apply", "DELETION_LEDGER", "--remote", "--env", "staging"],
  ]);
  assert.deepEqual(freshBootstrap.expectedFinalMigrations, {
    USAGE_MONITOR_DB: "0048_accountless_upload_renewal.sql",
    DELETION_LEDGER: "0002_identity_reenrollment_cooldown.sql",
  });
  const disabledDeployment = plan.requiredRemoteActions.find(
    (step) => step.kind === "deploy_checked_in_disabled_staging",
  );
  assert.equal(disabledDeployment.generatedSecretFile, ".dev.vars.staging");
  assert.deepEqual(disabledDeployment.installsIfAbsent, [
    "ENVELOPE_PRIVATE_JWK",
    "ENVELOPE_PUBLIC_JWK",
  ]);
  assert.match(disabledDeployment.installMechanism, /--secrets-file/u);
  const hostedClient = plan.requiredRemoteActions.find(
    (step) => step.kind === "run_synthetic_hosted_client",
  );
  assert.equal(hostedClient.proofScope, "hosted_client_only");
  assert.equal(JSON.stringify(plan).includes("ENVELOPE_PRIVATE_JWK='"), false);
});

test("configured staging still requires owner review and unsafe source produces no remote commands", () => {
  const configured = planAccountlessStagingRehearsal({
    config: provisionedConfig(),
    sourceCommit: SOURCE_COMMIT,
  });
  assert.equal(configured.state, "blocked_owner_review");
  assert.equal(configured.requiredRemoteActions.length > 0, true);

  const unsafe = structuredClone(checkedInConfig);
  unsafe.env.staging.vars.ACCOUNTLESS_ENROLLMENT_MODE = "enabled";
  const blocked = planAccountlessStagingRehearsal({
    config: unsafe,
    sourceCommit: SOURCE_COMMIT,
  });
  assert.equal(blocked.state, "blocked_unsafe_configuration");
  assert.deepEqual(blocked.requiredRemoteActions, []);
  assert.equal(blocked.blockers.includes("CONFIG_ACCOUNTLESS_ADMISSION_DISABLED"), true);
});

test("accountless hosted rehearsal plan rejects a non-Git source revision", () => {
  assert.throws(() => planAccountlessStagingRehearsal({
    config: checkedInConfig,
    sourceCommit: "not-a-revision",
  }), /exact Git revision/u);
});
