#!/usr/bin/env node
/**
 * Prints a source-only plan for the one synthetic accountless rehearsal lane.
 * It never runs Wrangler, reads credentials, or contacts a remote service.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../../../config/deployment-endpoints.js";
import { validateWorkerDeploymentEndpoints } from "./check-deployment-endpoints.mjs";
import {
  assessStagingConfiguration,
  EXPECTED_STAGING_MIGRATIONS,
  REQUIRED_D1_BINDINGS,
  REQUIRED_STAGING_R2_BUCKET_NAME,
} from "./staging-readiness-lib.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const DEFAULT_WORKER_DIRECTORY = dirname(dirname(SCRIPT_FILE));
export const ACCOUNTLESS_STAGING_REHEARSAL_PLAN_SCHEMA_VERSION =
  "accountless-staging-rehearsal-plan-v0.1";
export const HOSTED_REHEARSAL_ACKNOWLEDGEMENT =
  "RUN_SYNTHETIC_ACCOUNTLESS_STAGING_REHEARSAL_V1";

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;

function command(...argv) {
  return Object.freeze(argv);
}

function sourceCommitFor(workerDirectory) {
  try {
    const sourceCommit = execFileSync(
      "/usr/bin/git",
      ["-C", dirname(workerDirectory), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    return SOURCE_COMMIT_PATTERN.test(sourceCommit) ? sourceCommit : null;
  } catch {
    return null;
  }
}

function endpointProjectionMatches(config) {
  try {
    validateWorkerDeploymentEndpoints(config);
    return true;
  } catch {
    return false;
  }
}

function fixedTarget() {
  const staging = DEPLOYMENT_ENDPOINTS.staging;
  return Object.freeze({
    environment: "staging",
    origin: staging.origin,
    previewUrls: staging.previewUrls,
    routes: Object.freeze([]),
    workerName: staging.workerName,
    workersDev: staging.workersDev,
  });
}

function reviewedResources() {
  return Object.freeze({
    d1: Object.freeze(REQUIRED_D1_BINDINGS.map((binding) => Object.freeze({
      binding: binding.binding,
      databaseName: binding.databaseName,
      finalMigration: EXPECTED_STAGING_MIGRATIONS[binding.binding].at(-1),
      migrationsDir: binding.migrationsDir,
    }))),
    r2: Object.freeze({
      binding: "QUARANTINE",
      bucketName: REQUIRED_STAGING_R2_BUCKET_NAME,
    }),
  });
}

function rehearsalActions(sourceCommit) {
  const target = fixedTarget();
  const [primary, deletionLedger] = REQUIRED_D1_BINDINGS;
  return Object.freeze([
    Object.freeze({
      kind: "create_d1",
      command: command("wrangler", "d1", "create", primary.databaseName),
      resource: primary.binding,
    }),
    Object.freeze({
      kind: "create_d1",
      command: command("wrangler", "d1", "create", deletionLedger.databaseName),
      resource: deletionLedger.binding,
    }),
    Object.freeze({
      kind: "create_r2",
      command: command("wrangler", "r2", "bucket", "create", REQUIRED_STAGING_R2_BUCKET_NAME),
      resource: "QUARANTINE",
    }),
    Object.freeze({
      kind: "record_created_d1_ids",
      requiredSourceChange: Object.freeze({
        file: "apps/worker/wrangler.jsonc",
        requirement: "replace only the two reviewed staging D1 placeholder IDs with create output",
      }),
    }),
    Object.freeze({
      kind: "generate_isolated_envelope_keys",
      command: command("node", "./scripts/generate-dev-keys.mjs", "--environment", "staging"),
      localSecretMaterial: true,
      ownerOnlyFile: ".dev.vars.staging",
    }),
    Object.freeze({
      kind: "compatible_disabled_bootstrap",
      existingEntryPoint: "staging:deploy",
      command: command(
        "npm", "run", "staging:deploy", "--",
        "--origin", target.origin,
        "--phase", "pre_migration_compatibility",
        "--identity-receipt-file", "OWNER_ONLY_FILE",
        "--confirm", "DEPLOY_COMPATIBLE_DISABLED_STAGING",
      ),
    }),
    Object.freeze({
      kind: "fresh_bootstrap_owner_migrations",
      automatic: false,
      requiredBlocker: "OWNER_CONTAINMENT_REQUIRED_BEFORE_MIGRATIONS",
      rationale: "the existing staging preparation entrypoint deliberately refuses an uninitialized target",
      commands: Object.freeze([primary, deletionLedger].map((binding) => command(
        "wrangler", "d1", "migrations", "apply", binding.binding,
        "--remote", "--env", "staging",
      ))),
      expectedFinalMigrations: Object.freeze({
        [primary.binding]: EXPECTED_STAGING_MIGRATIONS[primary.binding].at(-1),
        [deletionLedger.binding]: EXPECTED_STAGING_MIGRATIONS[deletionLedger.binding].at(-1),
      }),
    }),
    Object.freeze({
      kind: "deploy_checked_in_disabled_staging",
      existingEntryPoint: "staging:deploy",
      generatedSecretFile: ".dev.vars.staging",
      installsIfAbsent: Object.freeze([
        "ENVELOPE_PRIVATE_JWK",
        "ENVELOPE_PUBLIC_JWK",
        "IDENTITY_LINK_SECRET",
      ]),
      installMechanism: "existing staging:deploy validates the owner-only generated file and passes --secrets-file only when required staging secrets are absent",
      command: command(
        "npm", "run", "staging:deploy", "--",
        "--origin", target.origin,
        "--confirm", "DEPLOY_DISABLED_STAGING",
      ),
    }),
    Object.freeze({
      kind: "owner_reviewed_collection_control",
      expectedBefore: Object.freeze({
        enrollment: false,
        processing: false,
        publication: false,
        state: "contained",
        uploadRegistration: false,
      }),
      requiredLiveRevision: "read immediately before mutation",
      requested: Object.freeze({
        enrollment: true,
        processing: true,
        publication: false,
        state: "degraded",
        uploadRegistration: true,
      }),
    }),
    Object.freeze({
      kind: "deploy_accountless_rehearsal_override",
      command: command(
        "wrangler", "deploy", "--env", "staging", "--strict",
        "--var", `DEPLOYMENT_SOURCE_COMMIT:${sourceCommit}`,
        "--var", "ENROLLMENT_MODE:disabled",
        "--var", "ACCOUNT_SCOPED_INGEST_MODE:disabled",
        "--var", "ACCOUNTLESS_ENROLLMENT_MODE:enabled",
        "--var", "ACCOUNTLESS_OWNERSHIP_MODE:enabled",
      ),
    }),
    Object.freeze({
      kind: "run_synthetic_hosted_client",
      command: command(
        "env",
        "TIBOTATTLE_RUN_HOSTED_ACCOUNTLESS_REHEARSAL=1",
        `TIBOTATTLE_ACCOUNTLESS_HOSTED_REHEARSAL_ACK=${HOSTED_REHEARSAL_ACKNOWLEDGEMENT}`,
        "node", "--test", "../../test/contribution-accountless-client-hosted-rehearsal.e2e.test.js",
      ),
      proofScope: "hosted_client_only",
      targetOrigin: target.origin,
    }),
    Object.freeze({
      kind: "restore_containment",
      requiredLiveRevision: "read immediately before mutation",
      requested: Object.freeze({
        enrollment: false,
        processing: false,
        publication: false,
        state: "contained",
        uploadRegistration: false,
      }),
    }),
    Object.freeze({
      kind: "restore_checked_in_disabled_staging",
      existingEntryPoint: "staging:deploy",
      command: command(
        "npm", "run", "staging:deploy", "--",
        "--origin", target.origin,
        "--confirm", "DEPLOY_DISABLED_STAGING",
      ),
    }),
  ]);
}

/** Builds a reviewable plan only; it has no confirmation or remote path. */
export function planAccountlessStagingRehearsal({
  config,
  sourceCommit,
  workerDirectory = DEFAULT_WORKER_DIRECTORY,
} = {}) {
  assertDeploymentEndpoints();
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit ?? "")) {
    throw new TypeError("sourceCommit must be an exact Git revision");
  }
  const readiness = assessStagingConfiguration(config, { workerDirectory });
  const endpointMatched = endpointProjectionMatches(config);
  const safelyInactive = readiness.state !== "unsafe_configuration"
    && readiness.checks.accountlessAdmissionDisabled === true
    && endpointMatched;
  const blockers = Object.freeze([...new Set([
    ...readiness.blockers,
    ...(endpointMatched ? [] : ["STAGING_ENDPOINT_CONFIGURATION_MISMATCH"]),
    "OWNER_REMOTE_AUTHORIZATION_REQUIRED",
  ])]);
  const state = safelyInactive
    ? readiness.state === "safe_unprovisioned"
      ? "blocked_unprovisioned"
      : "blocked_owner_review"
    : "blocked_unsafe_configuration";
  return Object.freeze({
    accountlessRuntime: Object.freeze({
      enrollmentMode: "enabled_for_one_rehearsal_deploy_only",
      ownershipMode: "enabled_for_one_rehearsal_deploy_only",
      rendererSelectable: false,
    }),
    blockers,
    publicPolicy: Object.freeze({
      accountScopedIngest: "disabled",
      enrollmentMode: "disabled",
      publication: false,
    }),
    remoteActionsAuthorized: false,
    requiredRemoteActions: safelyInactive
      ? rehearsalActions(sourceCommit)
      : Object.freeze([]),
    resources: reviewedResources(),
    schemaVersion: ACCOUNTLESS_STAGING_REHEARSAL_PLAN_SCHEMA_VERSION,
    source: Object.freeze({ revision: sourceCommit }),
    stagingReadiness: Object.freeze({
      checks: Object.freeze({
        accountlessAdmissionDisabled: readiness.checks.accountlessAdmissionDisabled === true,
        endpointMatched,
        resourceIdentifiersConfigured:
          readiness.checks.resourceIdentifiersConfigured === true,
      }),
      state: readiness.state,
    }),
    state,
    syntheticClient: Object.freeze({
      acknowledgement: HOSTED_REHEARSAL_ACKNOWLEDGEMENT,
      excludes: Object.freeze(["installed_scheduler"]),
      entryPoint: "test/contribution-accountless-client-hosted-rehearsal.e2e.test.js",
      fixedOrigin: DEPLOYMENT_ENDPOINTS.staging.origin,
      proofScope: "hosted_client_only",
    }),
    target: fixedTarget(),
  });
}

async function main() {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: accountless-staging-rehearsal-plan.mjs\n");
    process.exitCode = 2;
    return;
  }
  const configFile = join(DEFAULT_WORKER_DIRECTORY, "wrangler.jsonc");
  let config;
  try {
    const errors = [];
    config = parse(await readFile(configFile, "utf8"), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) throw new TypeError(printParseErrorCode(errors[0].error));
  } catch {
    process.stderr.write("Staging configuration is invalid JSONC\n");
    process.exitCode = 1;
    return;
  }
  const sourceCommit = sourceCommitFor(DEFAULT_WORKER_DIRECTORY);
  if (sourceCommit === null) {
    process.stderr.write("Checked-out source revision is unavailable\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(planAccountlessStagingRehearsal({
    config,
    sourceCommit,
  }), null, 2)}\n`);
}

if (process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(SCRIPT_FILE).href) {
  await main();
}
