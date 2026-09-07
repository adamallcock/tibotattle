import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  identityProtectionSchemaVerified,
  probeStagingLive,
  REQUIRED_D1_BINDINGS,
  STAGING_PROOF_TYPES,
  stagingOperationReceipt,
} from "./staging-readiness-lib.mjs";
import {
  readStagingDeploymentIdentity,
  readDeploymentProof,
  validateDeploymentProof,
} from "./deployment-proof.mjs";
import { runReleasePreflight } from "./release-preflight.mjs";

export const PREPARE_CONFIRMATION = "PREPARE_DISABLED_STAGING";

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;

const CONTAINMENT_SQL = `
UPDATE collection_controls
   SET enrollment_enabled = 0,
       upload_registration_enabled = 0,
       processing_enabled = 0,
       publication_enabled = 0,
       control_state = 'contained',
       revision = revision + 1,
       reason_code = 'maintenance',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE singleton = 1;
`;

function run(spawn, wrangler, workerDirectory, args) {
  try {
    const result = spawn(wrangler, args, {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function isFreshBootstrapTarget(readiness) {
  const migrationProof = readiness?.migrationProof;
  return Array.isArray(migrationProof)
    && migrationProof.length === REQUIRED_D1_BINDINGS.length
    && migrationProof.every((state, index) =>
      state?.binding === REQUIRED_D1_BINDINGS[index].binding
      && state.status === "uninitialized");
}

function readinessBlockers(readiness, fallback) {
  return Array.isArray(readiness?.blockers)
    && readiness.blockers.length > 0
    ? readiness.blockers
    : [fallback];
}

function safeJsonHeaders(response) {
  return response.headers.get("content-type")?.split(";", 1)[0]
      === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

export function validateStagingRuntimeIdentity({
  health,
  deploymentIdentity,
  expectedSourceCommit = null,
} = {}) {
  const expected = expectedSourceCommit
    ?? deploymentIdentity?.deployment?.sourceCommit;
  const receiptSourceCommit = deploymentIdentity?.deployment?.sourceCommit;
  if (!SOURCE_COMMIT_PATTERN.test(expected ?? "")
      || !SOURCE_COMMIT_PATTERN.test(receiptSourceCommit ?? "")) {
    return {
      ok: false,
      code: "STAGING_RUNTIME_SOURCE_COMMIT_EXPECTED_INVALID",
    };
  }
  if (health === null || typeof health !== "object"
      || Array.isArray(health)
      || !Object.hasOwn(health, "deployment")
      || health.deployment === null
      || typeof health.deployment !== "object"
      || Array.isArray(health.deployment)
      || !Object.hasOwn(health.deployment, "sourceCommit")
      || health.deployment.sourceCommit === null
      || health.deployment.sourceCommit === "") {
    return { ok: false, code: "STAGING_RUNTIME_SOURCE_COMMIT_MISSING" };
  }
  const runtimeSourceCommit = health.deployment.sourceCommit;
  if (typeof runtimeSourceCommit !== "string"
      || !SOURCE_COMMIT_PATTERN.test(runtimeSourceCommit)) {
    return { ok: false, code: "STAGING_RUNTIME_SOURCE_COMMIT_INVALID" };
  }
  if (runtimeSourceCommit !== receiptSourceCommit
      || runtimeSourceCommit !== expected) {
    return { ok: false, code: "STAGING_RUNTIME_SOURCE_COMMIT_MISMATCH" };
  }
  return { ok: true, code: null, sourceCommit: runtimeSourceCommit };
}

export async function verifyStagingRuntimeIdentity({
  stagingOrigin,
  deploymentIdentity,
  expectedSourceCommit = null,
  fetchImpl = fetch,
} = {}) {
  let healthResponse;
  try {
    const origin = new URL(stagingOrigin);
    if (origin.origin !== stagingOrigin
        || origin.protocol !== "https:"
        || origin.pathname !== "/"
        || origin.username
        || origin.password
        || origin.search
        || origin.hash) {
      return { ok: false, code: "STAGING_ORIGIN_INVALID" };
    }
    healthResponse = await fetchImpl(new URL("/api/health", origin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: "STAGING_RUNTIME_IDENTITY_UNAVAILABLE" };
  }
  if (!healthResponse.ok || !safeJsonHeaders(healthResponse)) {
    return { ok: false, code: "STAGING_RUNTIME_IDENTITY_UNAVAILABLE" };
  }
  let health;
  try {
    health = await healthResponse.json();
  } catch {
    return { ok: false, code: "STAGING_RUNTIME_IDENTITY_UNAVAILABLE" };
  }
  return validateStagingRuntimeIdentity({
    health,
    deploymentIdentity,
    expectedSourceCommit,
  });
}

async function containAndVerify({
  readiness,
  spawn,
  wrangler,
  workerDirectory,
  config,
  verifyRuntimeIdentity,
}) {
  if (readiness?.checks?.collectionContained === true) {
    return { ok: true, readiness };
  }
  if (readiness?.collectionControlState !== "uncontained") {
    return {
      ok: false,
      code: "STAGING_CONTAINMENT_UNVERIFIED",
      blockers: readinessBlockers(
        readiness,
        "REMOTE_COLLECTION_NOT_CONTAINED",
      ),
    };
  }
  const runtimeIdentity = await verifyRuntimeIdentity();
  if (!runtimeIdentity.ok) return runtimeIdentity;
  if (!run(
    spawn,
    wrangler,
    workerDirectory,
    [
      "d1", "execute", "USAGE_MONITOR_DB",
      "--remote", "--env", "staging",
      "--command", CONTAINMENT_SQL,
    ],
  )) {
    return { ok: false, code: "STAGING_CONTAINMENT_FAILED" };
  }

  let afterContainment;
  try {
    afterContainment = probeStagingLive({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return {
      ok: false,
      code: "STAGING_CONTAINMENT_UNVERIFIED",
      blockers: ["REMOTE_COLLECTION_NOT_CONTAINED"],
    };
  }
  if (!afterContainment.checks.collectionContained) {
    return {
      ok: false,
      code: "STAGING_CONTAINMENT_UNVERIFIED",
      blockers: readinessBlockers(
        afterContainment,
        "REMOTE_COLLECTION_NOT_CONTAINED",
      ),
    };
  }
  return { ok: true, readiness: afterContainment };
}

export async function prepareDisabledStaging({
  config,
  confirmation,
  stagingOrigin,
  deploymentIdentity = null,
  deploymentProof,
  expectedSourceCommit = null,
  deploymentProofCheck = null,
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  fetchImpl = fetch,
  localPreflight = runReleasePreflight,
}) {
  if (confirmation !== PREPARE_CONFIRMATION) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" };
  }
  if (!deploymentIdentity) {
    return { ok: false, code: "STAGING_DEPLOYMENT_IDENTITY_REQUIRED" };
  }
  if (stagingOrigin !== deploymentIdentity.deployment?.origin) {
    return {
      ok: false,
      code: "STAGING_DEPLOYMENT_IDENTITY_MISMATCH",
    };
  }
  const proofCheck = deploymentProofCheck?.ok === false
    ? deploymentProofCheck
    : validateDeploymentProof({
      proof: deploymentProofCheck?.proof ?? deploymentProof,
      kind: "staging",
      expectedOrigin: deploymentIdentity.deployment?.origin,
      expectedSourceCommit,
      expectedDeploymentIdentity: deploymentIdentity,
    });
  if (!proofCheck.ok) return proofCheck;
  let localReadiness;
  try {
    localReadiness = await localPreflight({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return { ok: false, code: "LOCAL_STAGING_PREFLIGHT_FAILED" };
  }
  if (localReadiness?.state !== "ready") {
    return {
      ok: false,
      code: "LOCAL_STAGING_PREFLIGHT_BLOCKED",
      blockers: readinessBlockers(
        localReadiness,
        "LOCAL_STAGING_PREFLIGHT_BLOCKED",
      ),
    };
  }
  const verifyRuntimeIdentity = () => verifyStagingRuntimeIdentity({
    stagingOrigin,
    deploymentIdentity,
    expectedSourceCommit,
    fetchImpl,
  });
  const initialRuntimeIdentity = await verifyRuntimeIdentity();
  if (!initialRuntimeIdentity.ok) return initialRuntimeIdentity;
  let before;
  try {
    before = probeStagingLive({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return { ok: false, code: "STAGING_READINESS_FAILED" };
  }
  const infrastructureReady = before.checks.authenticated
    && before.checks.resourceIdentifiersConfigured
    && before.checks.d1ServiceReachable
    && before.checks.r2ServiceReachable
    && before.checks.d1ResourcesExist
    && before.checks.r2ResourceExists;
  const migrationPreflightBlockers = before.blockers.filter((code) =>
    ![
      "REMOTE_MIGRATIONS_PENDING",
      "REMOTE_MIGRATION_STATE_UNINITIALIZED",
      "REMOTE_COLLECTION_NOT_CONTAINED",
      "REQUIRED_STAGING_SECRETS_MISSING",
    ].includes(code)
      && !code.startsWith("REMOTE_IDENTITY_REENROLLMENT_SCHEMA_")
      && !code.startsWith("REMOTE_DELETION_LEDGER_SCHEMA_"));
  if (before.state === "unsafe_configuration"
      || !infrastructureReady
      || migrationPreflightBlockers.length > 0) {
    return {
      ok: false,
      code: "STAGING_INFRASTRUCTURE_BLOCKED",
      blockers: migrationPreflightBlockers,
    };
  }
  if (before.checks.migrationsCurrent
      && !identityProtectionSchemaVerified(before)) {
    const schemaBlockers = before.blockers.filter((code) =>
      code.startsWith("REMOTE_IDENTITY_REENROLLMENT_SCHEMA_")
      || code.startsWith("REMOTE_DELETION_LEDGER_SCHEMA_"));
    return {
      ok: false,
      code: "STAGING_SCHEMA_PROTECTION_BLOCKED",
      blockers: schemaBlockers.length > 0
        ? schemaBlockers
        : ["REMOTE_IDENTITY_PROTECTION_SCHEMA_UNVERIFIED"],
    };
  }

  if (isFreshBootstrapTarget(before)) {
    return {
      ok: false,
      code: "STAGING_FRESH_BOOTSTRAP_REQUIRES_OWNER_CONTAINMENT",
      blockers: ["OWNER_CONTAINMENT_REQUIRED_BEFORE_MIGRATIONS"],
    };
  }

  let readiness = before;
  for (let index = 0; index < REQUIRED_D1_BINDINGS.length; index += 1) {
    if (!readiness.checks.collectionContained) {
      const containment = await containAndVerify({
        readiness,
        spawn,
        wrangler,
        workerDirectory,
        config,
        verifyRuntimeIdentity,
      });
      if (!containment.ok) return containment;
      readiness = containment.readiness;
    }
    const { binding } = REQUIRED_D1_BINDINGS[index];
    const runtimeIdentity = await verifyRuntimeIdentity();
    if (!runtimeIdentity.ok) return runtimeIdentity;
    if (!run(
      spawn,
      wrangler,
      workerDirectory,
      [
        "d1", "migrations", "apply", binding,
        "--remote", "--env", "staging",
      ],
    )) {
      return { ok: false, code: "STAGING_MIGRATION_FAILED" };
    }
    if (index === REQUIRED_D1_BINDINGS.length - 1) continue;

    try {
      readiness = probeStagingLive({
        config,
        wrangler,
        workerDirectory,
        spawn,
      });
    } catch {
      return { ok: false, code: "STAGING_MIGRATIONS_UNVERIFIED" };
    }
    if (!readiness.checks.collectionContained) {
      const containment = await containAndVerify({
        readiness,
        spawn,
        wrangler,
        workerDirectory,
        config,
        verifyRuntimeIdentity,
      });
      if (!containment.ok) return containment;
      readiness = containment.readiness;
    }
  }

  let afterMigrations;
  try {
    afterMigrations = probeStagingLive({
      config,
      wrangler,
      workerDirectory,
      spawn,
    });
  } catch {
    return { ok: false, code: "STAGING_MIGRATIONS_UNVERIFIED" };
  }
  const migrationVerificationBlockers = afterMigrations.blockers.filter(
    (code) => code !== "REQUIRED_STAGING_SECRETS_MISSING",
  );
  if (!afterMigrations.checks.migrationsCurrent
      || !afterMigrations.checks.pilotSchemaCurrent
      || !afterMigrations.checks.attributionSchemaCurrent
      || !afterMigrations.checks.collectionContained
      || !identityProtectionSchemaVerified(afterMigrations)
      || migrationVerificationBlockers.length > 0) {
    return {
      ok: false,
      code: "STAGING_MIGRATIONS_UNVERIFIED",
      blockers: migrationVerificationBlockers.length > 0
        ? migrationVerificationBlockers
        : ["REMOTE_MIGRATIONS_PENDING"],
    };
  }
  return {
    ok: true,
    code: "DISABLED_STAGING_PREPARED",
    collectionAuthorized: false,
    secretsInstalled: afterMigrations.checks.requiredSecretsInstalled,
    receipt: stagingOperationReceipt("disabled_staging_prepared", {
      resourcesVerified: afterMigrations.checks.d1ResourcesExist
        && afterMigrations.checks.r2ResourceExists,
      staticConfigurationChecked: afterMigrations.evidenceType
        === STAGING_PROOF_TYPES.LIVE_REMOTE,
      remoteReadOnlyProof: true,
      migrationInventoryCurrent:
        afterMigrations.checks.remoteMigrationInventoryCurrent,
      migrationsCurrent: afterMigrations.checks.migrationsCurrent,
      pilotSchemaCurrent: afterMigrations.checks.pilotSchemaCurrent,
      attributionSchemaCurrent: afterMigrations.checks.attributionSchemaCurrent,
      primaryReenrollmentSchemaCurrent:
        afterMigrations.checks.primaryReenrollmentSchemaCurrent,
      deletionLedgerSchemaCurrent:
        afterMigrations.checks.deletionLedgerSchemaCurrent,
      identityProtectionSchemaCurrent:
        afterMigrations.checks.identityProtectionSchemaCurrent,
      identityProtectionSchema: afterMigrations.evidence.identityProtectionSchema,
      collectionContained: afterMigrations.checks.collectionContained,
      secretsInstalled: afterMigrations.checks.requiredSecretsInstalled,
    }),
  };
}

async function main() {
  if (process.argv.length !== 10
      || process.argv[2] !== "--origin"
      || process.argv[4] !== "--receipt-file"
      || process.argv[6] !== "--identity-receipt-file"
      || process.argv[8] !== "--confirm") {
    process.stderr.write(
      "Usage: prepare-disabled-staging.mjs --origin https://HOST "
        + "--receipt-file /owner-only/proof.json "
        + "--identity-receipt-file /owner-only/identity.json "
        + `--confirm ${PREPARE_CONFIRMATION}\n`,
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  let result;
  try {
    const config = parse(
      await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8"),
    );
    const wrangler = join(
      workerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    );
    const sourceCommitResult = spawnSync(
      "/usr/bin/git",
      ["-C", dirname(workerDirectory), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    const expectedSourceCommit = sourceCommitResult.status === 0
      ? sourceCommitResult.stdout.trim()
      : "source-revision-unavailable";
    const deploymentIdentityCheck = await readStagingDeploymentIdentity({
      filename: process.argv[7],
      expectedOrigin: process.argv[3],
      expectedSourceCommit,
    });
    if (!deploymentIdentityCheck.ok) {
      result = deploymentIdentityCheck;
    } else {
      const deploymentProofCheck = await readDeploymentProof({
        filename: process.argv[5],
        kind: "staging",
        expectedOrigin: deploymentIdentityCheck.identity.deployment.origin,
        expectedSourceCommit,
        expectedDeploymentIdentity: deploymentIdentityCheck.identity,
      });
      result = await prepareDisabledStaging({
        config,
        confirmation: process.argv[9],
        stagingOrigin: process.argv[3],
        deploymentIdentity: deploymentIdentityCheck.identity,
        expectedSourceCommit,
        deploymentProofCheck,
        wrangler,
        workerDirectory,
      });
    }
  } catch {
    result = { ok: false, code: "STAGING_PREPARATION_FAILED" };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
