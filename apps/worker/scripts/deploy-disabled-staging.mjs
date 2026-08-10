import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import {
  assessStagingConfiguration,
  identityProtectionSchemaVerified,
  probeStagingLive,
  stagingOperationReceipt,
} from "./staging-readiness-lib.mjs";
import { createStagingDeploymentIdentity } from "./deployment-proof.mjs";
import {
  checkLocalWorkspacePackages,
} from "./check-local-workspace-packages.mjs";
import { stageProductionAssets } from "./stage-production-assets.mjs";

export const DEPLOY_CONFIRMATION = "DEPLOY_DISABLED_STAGING";
export const COMPATIBLE_DEPLOY_CONFIRMATION =
  "DEPLOY_COMPATIBLE_DISABLED_STAGING";

function checkedOutSourceCommit(workerDirectory) {
  try {
    const value = execFileSync(
      "/usr/bin/git",
      ["-C", dirname(workerDirectory), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    return /^[a-f0-9]{7,64}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeDeploymentIdentity(filename, identity) {
  if (typeof filename !== "string" || filename.length === 0) return false;
  try {
    await writeFile(filename, `${JSON.stringify(identity)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(filename, 0o600);
    return true;
  } catch {
    return false;
  }
}

async function validStagingSecretsFile(filename) {
  if (!filename) return false;
  let metadata;
  let contents;
  try {
    metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size <= 0 || metadata.size > 32 * 1024
        || (metadata.mode & 0o777) !== 0o600
        || (typeof process.getuid === "function"
          && metadata.uid !== process.getuid())) {
      return false;
    }
    contents = await readFile(filename, "utf8");
  } catch {
    return false;
  }
  const lines = contents.trim().split("\n");
  if (lines.length !== 2) return false;
  const privateMatch = /^ENVELOPE_PRIVATE_JWK='([^'\r\n]+)'$/u.exec(lines[0]);
  const publicMatch = /^ENVELOPE_PUBLIC_JWK='([^'\r\n]+)'$/u.exec(lines[1]);
  if (!privateMatch?.[1] || !publicMatch?.[1]) return false;
  let privateJwk;
  let publicJwk;
  try {
    privateJwk = JSON.parse(privateMatch[1]);
    publicJwk = JSON.parse(publicMatch[1]);
  } catch {
    return false;
  }
  return privateJwk?.kty === "RSA"
    && publicJwk?.kty === "RSA"
    && typeof privateJwk?.kid === "string"
    && /^key:[A-Za-z0-9._-]{1,64}$/u.test(privateJwk.kid)
    && privateJwk.kid === publicJwk?.kid
    && typeof privateJwk?.n === "string"
    && privateJwk.n === publicJwk?.n
    && typeof privateJwk?.e === "string"
    && privateJwk.e === publicJwk?.e
    && typeof privateJwk?.d === "string"
    && !Object.hasOwn(publicJwk, "d");
}

function closedHealth(value) {
  return value?.status === "ok"
    && value?.enrollmentMode === "disabled"
    && value?.collectionControls?.state === "contained"
    && value?.collectionControls?.enrollment === false
    && value?.collectionControls?.uploadRegistration === false
    && value?.collectionControls?.processing === false
    && value?.collectionControls?.publication === false
    && value?.contracts?.accountScopedContribution
      ?.externalParticipantsAuthorized === false
    && value?.capabilities?.encryptedUpload === false
    && value?.capabilities?.delayedAggregateStats === false
    && value?.capabilities?.ongoingDeviceUploadRegistration === false;
}

function lifecycleReadiness(value, status) {
  return [200, 503].includes(status)
    && value?.status === (status === 200 ? "ready" : "not_ready")
    && typeof value?.checks === "object"
    && value.checks !== null
    && typeof value.checks.lifecycleFresh === "boolean"
    && typeof value.checks.quarantineRetentionComplete === "boolean"
    && typeof value.checks.restoreReplayComplete === "boolean"
    && typeof value.checks.aggregateRebuildComplete === "boolean"
    && typeof value.checks.maintenanceCycleMatched === "boolean"
    && typeof value.checks.quarantineReconciliationComplete === "boolean"
    && value?.policy?.lifecycleStaleAfterMilliseconds === 2 * 60 * 60 * 1000;
}

function safeJsonHeaders(response) {
  return response.headers.get("content-type")?.split(";", 1)[0]
      === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

function deployedWorkersDevOrigins(output) {
  return [...output.matchAll(
    /https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.workers\.dev/giu,
  )].flatMap((match) => {
    try {
      return [new URL(match[0]).origin];
    } catch {
      return [];
    }
  });
}

function compatibleRuntimeConfiguration(config, workerDirectory) {
  let assessment;
  try {
    assessment = assessStagingConfiguration(config, { workerDirectory });
  } catch {
    return {
      ok: false,
      blockers: ["STAGING_RUNTIME_CONFIGURATION_UNREADABLE"],
    };
  }
  const requiredChecks = [
    "environmentDeclared",
    "publicNameSafe",
    "workersDevHttpsEnabled",
    "originBoundaryClosed",
    "previewUrlsDisabled",
    "enrollmentDisabled",
    "accountScopedIngestDisabled",
    "noUnexpectedVariables",
    "assetsClosed",
    "deployableAssetsClosed",
    "ingressBudgetBindingSafe",
    "ingressBudgetMigrationSafe",
  ];
  const failedChecks = requiredChecks
    .filter((name) => assessment.checks?.[name] !== true)
    .map((name) => `CONFIG_${name.replaceAll(/([A-Z])/gu, "_$1").toUpperCase()}`);
  const blockers = [...new Set([
    ...failedChecks,
    ...(assessment.state === "unsafe_configuration"
      ? assessment.blockers.filter(
        (code) => code !== "STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED",
      )
      : []),
  ])];
  return {
    ok: assessment.state !== "unsafe_configuration"
      && blockers.length === 0
      && assessment.collectionAuthorized === false,
    blockers,
  };
}

export async function runDisabledStagingDeployment({
  config,
  origin,
  confirmation,
  phase = "final",
  wrangler,
  workerDirectory,
  secretsFile = null,
  spawn = spawnSync,
  fetchImpl = fetch,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  stageAssets = stageProductionAssets,
  identityReceiptFile = null,
  expectedSourceCommit = null,
  writeIdentityReceipt = writeDeploymentIdentity,
}) {
  if (![
    "final",
    "pre_migration_compatibility",
  ].includes(phase)) {
    return { ok: false, code: "STAGING_DEPLOY_PHASE_INVALID" };
  }
  const compatiblePhase = phase === "pre_migration_compatibility";
  if (confirmation !== (compatiblePhase
    ? COMPATIBLE_DEPLOY_CONFIRMATION
    : DEPLOY_CONFIRMATION)) {
    return { ok: false, code: "CONFIRMATION_REQUIRED" };
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return { ok: false, code: "STAGING_ORIGIN_INVALID" };
  }
  if (parsedOrigin.protocol !== "https:"
      || parsedOrigin.username || parsedOrigin.password
      || parsedOrigin.pathname !== "/" || parsedOrigin.search
      || parsedOrigin.hash) {
    return { ok: false, code: "STAGING_ORIGIN_INVALID" };
  }
  if (compatiblePhase) {
    const runtimeConfiguration = compatibleRuntimeConfiguration(
      config,
      workerDirectory,
    );
    if (!runtimeConfiguration.ok) {
      return {
        ok: false,
        code: "STAGING_COMPATIBLE_RUNTIME_CONFIGURATION_BLOCKED",
        blockers: runtimeConfiguration.blockers,
      };
    }
    if (!identityReceiptFile) {
      return {
        ok: false,
        code: "STAGING_DEPLOYMENT_IDENTITY_RECEIPT_REQUIRED",
      };
    }
    const sourceCommit = expectedSourceCommit
      ?? checkedOutSourceCommit(workerDirectory);
    if (!sourceCommit || !/^[a-f0-9]{7,64}$/u.test(sourceCommit)) {
      return {
        ok: false,
        code: "STAGING_SOURCE_REVISION_UNAVAILABLE",
      };
    }
  }
  try {
    await checkWorkspacePackages();
  } catch (error) {
    const code = [
      "ACCOUNTING_PACKAGE_STALE",
      "TELEMETRY_CONTRACT_PACKAGE_STALE",
      "QUOTA_ANALYSIS_PACKAGE_STALE",
    ].includes(error?.code)
      ? error.code
      : "WORKSPACE_PACKAGES_CHECK_FAILED";
    return { ok: false, code };
  }
  try {
    await stageAssets();
  } catch {
    return { ok: false, code: "STAGING_PUBLIC_ASSETS_INVALID" };
  }

  if (compatiblePhase) {
    const sourceCommit = expectedSourceCommit
      ?? checkedOutSourceCommit(workerDirectory);
    if (!sourceCommit || !/^[a-f0-9]{7,64}$/u.test(sourceCommit)) {
      return {
        ok: false,
        code: "STAGING_SOURCE_REVISION_UNAVAILABLE",
      };
    }
    const deployment = spawn(
      wrangler,
      [
        "deploy", "--env", "staging", "--strict",
        "--var", `DEPLOYMENT_SOURCE_COMMIT:${sourceCommit}`,
      ],
      {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (deployment.error || deployment.status !== 0) {
      return { ok: false, code: "STAGING_COMPATIBLE_DEPLOY_FAILED" };
    }
    const deployedOrigins = [...new Set(deployedWorkersDevOrigins(
      `${deployment.stdout ?? ""}\n${deployment.stderr ?? ""}`,
    ))];
    if (deployedOrigins.length !== 1
        || deployedOrigins[0] !== parsedOrigin.origin) {
      return { ok: false, code: "STAGING_DEPLOY_ORIGIN_MISMATCH" };
    }
    const deploymentIdentity = createStagingDeploymentIdentity({
      origin: deployedOrigins[0],
      sourceCommit,
      workerName: config.env.staging.name,
    });
    if (!await writeIdentityReceipt(identityReceiptFile, deploymentIdentity)) {
      return {
        ok: false,
        code: "STAGING_DEPLOYMENT_IDENTITY_RECEIPT_WRITE_FAILED",
      };
    }
    return {
      ok: true,
      code: "COMPATIBLE_DISABLED_STAGING_DEPLOYED",
      collectionAuthorized: false,
      receiptRequired: true,
      liveContainmentObserved: false,
      runtimeConfiguration: "disabled_contained",
      deploymentIdentity,
    };
  }

  const readiness = probeStagingLive({
    config,
    wrangler,
    workerDirectory,
    spawn,
  });
  const predeployBlockers = readiness.blockers.filter(
    (code) => code !== "REQUIRED_STAGING_SECRETS_MISSING",
  );
  if (predeployBlockers.length > 0
      || !readiness.checks.remoteMigrationInventoryCurrent
      || !readiness.checks.migrationsCurrent
      || !readiness.checks.collectionContained
      || !identityProtectionSchemaVerified(readiness)) {
    return {
      ok: false,
      code: "STAGING_READINESS_BLOCKED",
      blockers: predeployBlockers,
    };
  }
  const needsFirstDeploymentSecrets = !readiness.checks.requiredSecretsInstalled;
  if (needsFirstDeploymentSecrets
      && !await validStagingSecretsFile(secretsFile)) {
    return { ok: false, code: "STAGING_SECRETS_FILE_INVALID" };
  }

  const deployment = spawn(
    wrangler,
    [
      "deploy", "--env", "staging", "--strict",
      ...(needsFirstDeploymentSecrets
        ? ["--secrets-file", secretsFile]
        : []),
    ],
    {
      cwd: workerDirectory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (deployment.error || deployment.status !== 0) {
    return { ok: false, code: "STAGING_DEPLOY_FAILED" };
  }
  if (!deployedWorkersDevOrigins(
    `${deployment.stdout ?? ""}\n${deployment.stderr ?? ""}`,
  ).includes(parsedOrigin.origin)) {
    return { ok: false, code: "STAGING_DEPLOY_ORIGIN_MISMATCH" };
  }

  let response;
  try {
    response = await fetchImpl(new URL("/api/health", parsedOrigin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: "STAGING_HEALTH_UNREACHABLE" };
  }
  if (!response.ok || !safeJsonHeaders(response)) {
    return { ok: false, code: "STAGING_HEALTH_INVALID" };
  }
  let health;
  try {
    health = await response.json();
  } catch {
    return { ok: false, code: "STAGING_HEALTH_INVALID" };
  }
  if (!closedHealth(health)) {
    return { ok: false, code: "STAGING_NOT_CONTAINED" };
  }

  let readinessResponse;
  try {
    readinessResponse = await fetchImpl(new URL("/api/ready", parsedOrigin), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: "STAGING_READINESS_UNREACHABLE" };
  }
  if (!safeJsonHeaders(readinessResponse)) {
    return { ok: false, code: "STAGING_READINESS_INVALID" };
  }
  let lifecycle;
  try {
    lifecycle = await readinessResponse.json();
  } catch {
    return { ok: false, code: "STAGING_READINESS_INVALID" };
  }
  if (!lifecycleReadiness(lifecycle, readinessResponse.status)) {
    return { ok: false, code: "STAGING_READINESS_INVALID" };
  }
  return {
    ok: true,
    code: "DISABLED_STAGING_DEPLOYED",
    collectionAuthorized: false,
    receipt: stagingOperationReceipt("disabled_staging_deployed", {
      originMatchedWranglerOutput: true,
      remoteResourcesVerified: readiness.checks.d1ResourcesExist
        && readiness.checks.r2ResourceExists,
      remoteReadOnlyProof: true,
      migrationInventoryCurrent:
        readiness.checks.remoteMigrationInventoryCurrent,
      migrationsCurrent: readiness.checks.migrationsCurrent,
      pilotSchemaCurrent: readiness.checks.pilotSchemaCurrent,
      primaryReenrollmentSchemaCurrent:
        readiness.checks.primaryReenrollmentSchemaCurrent,
      deletionLedgerSchemaCurrent:
        readiness.checks.deletionLedgerSchemaCurrent,
      identityProtectionSchemaCurrent:
        readiness.checks.identityProtectionSchemaCurrent,
      identityProtectionSchema: readiness.evidence.identityProtectionSchema,
      collectionContained: readiness.checks.collectionContained,
      healthContained: true,
      lifecycleReadiness: lifecycle.status,
    }),
  };
}

async function main() {
  function option(name) {
    const index = process.argv.indexOf(name);
    const value = index < 0 ? null : process.argv[index + 1];
    if (!value || value.startsWith("--")) return null;
    return value;
  }
  if (![6, 10].includes(process.argv.length)
      || process.argv[2] !== "--origin"
      || (process.argv.length === 6 && process.argv[4] !== "--confirm")
      || (process.argv.length === 10
        && (process.argv[4] !== "--phase"
          || process.argv[6] !== "--identity-receipt-file"
          || process.argv[8] !== "--confirm"))) {
    process.stderr.write(
      "Usage: deploy-disabled-staging.mjs --origin https://HOST "
        + `[--phase pre_migration_compatibility --identity-receipt-file /owner-only/path`
        + ` --confirm ${COMPATIBLE_DEPLOY_CONFIRMATION}`
        + `|--confirm ${DEPLOY_CONFIRMATION}]\n`,
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const configText = await readFile(join(workerDirectory, "wrangler.jsonc"), "utf8");
  const config = parse(configText);
  const wrangler = join(
    workerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = await runDisabledStagingDeployment({
    config,
    origin: option("--origin"),
    confirmation: option("--confirm"),
    phase: option("--phase") ?? "final",
    identityReceiptFile: option("--identity-receipt-file"),
    wrangler,
    workerDirectory,
    secretsFile: join(workerDirectory, ".dev.vars.staging"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
