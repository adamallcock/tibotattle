import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEPLOYMENT_ENDPOINTS } from "../../../config/deployment-endpoints.js";
import { parse } from "jsonc-parser";
import { checkDeploymentEndpointConsumers } from "./check-deployment-endpoints.mjs";
import { checkLocalWorkspacePackages } from "./check-local-workspace-packages.mjs";
import { readDeploymentProof } from "./deployment-proof.mjs";
import { stageProductionAssets } from "./stage-production-assets.mjs";
import { runReleasePreflight } from "./release-preflight.mjs";

export const PRODUCTION_DEPLOY_CONFIRMATION =
  "DEPLOY_CONTAINED_PRODUCTION";

function localFailure(code) {
  return { ok: false, code };
}

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

function checkedOutSourceTreeClean(workerDirectory) {
  try {
    const value = execFileSync(
      "/usr/bin/git",
      [
        "-C",
        dirname(workerDirectory),
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      { encoding: "utf8" },
    );
    return value.trim() === "";
  } catch {
    return null;
  }
}

function verifySourceSnapshot({
  workerDirectory,
  expectedSourceCommit,
  sourceCommitCheck,
  sourceTreeCleanCheck,
}) {
  const sourceCommit = sourceCommitCheck(workerDirectory);
  if (!sourceCommit || !/^[a-f0-9]{7,64}$/u.test(sourceCommit)) {
    return localFailure("PRODUCTION_SOURCE_REVISION_UNAVAILABLE");
  }
  if (expectedSourceCommit !== null
      && sourceCommit !== expectedSourceCommit) {
    return localFailure("PRODUCTION_SOURCE_REVISION_CHANGED");
  }
  let clean;
  try {
    clean = sourceTreeCleanCheck(workerDirectory);
  } catch {
    clean = null;
  }
  if (clean !== true) {
    return localFailure("PRODUCTION_SOURCE_TREE_CHANGED");
  }
  return { ok: true, sourceCommit };
}

async function createImmutableSourceSnapshot({
  workerDirectory,
  sourceCommit,
}) {
  const repositoryRoot = dirname(workerDirectory);
  const snapshotParent = await mkdtemp(
    join(tmpdir(), "usage-monitor-production-source-"),
  );
  const snapshotRoot = join(snapshotParent, "repository");
  let worktreeAdded = false;
  try {
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        repositoryRoot,
        "worktree",
        "add",
        "--detach",
        "--quiet",
        snapshotRoot,
        sourceCommit,
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    worktreeAdded = true;

    const generatedSource = join(
      repositoryRoot,
      ".release-build",
      "public-release-site",
    );
    const snapshotGeneratedSource = join(
      snapshotRoot,
      ".release-build",
      "public-release-site",
    );
    await mkdir(dirname(snapshotGeneratedSource), {
      recursive: true,
      mode: 0o755,
    });
    await cp(generatedSource, snapshotGeneratedSource, {
      recursive: true,
      verbatimSymlinks: true,
    });

    // Wrangler is launched from the snapshot, but its installed dependency
    // tree is not source input and remains the locally checked dependency set.
    await symlink(
      join(workerDirectory, "node_modules"),
      join(snapshotRoot, "apps", "worker", "node_modules"),
      "dir",
    );

    return {
      repositoryRoot: snapshotRoot,
      workerDirectory: join(snapshotRoot, "apps", "worker"),
      async cleanup() {
        execFileSync(
          "/usr/bin/git",
          [
            "-C",
            repositoryRoot,
            "worktree",
            "remove",
            "--force",
            snapshotRoot,
          ],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        );
        await rm(snapshotParent, { recursive: true, force: false });
      },
    };
  } catch (error) {
    try {
      if (worktreeAdded) {
        execFileSync(
          "/usr/bin/git",
          [
            "-C",
            repositoryRoot,
            "worktree",
            "remove",
            "--force",
            snapshotRoot,
          ],
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        );
      }
      await rm(snapshotParent, { recursive: true, force: false });
    } catch (cleanupError) {
      cleanupError.code = "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED";
      throw cleanupError;
    }
    throw error;
  }
}

async function productionReleasePreflight({ workerDirectory, wrangler, spawn }) {
  const configPath = join(workerDirectory, "wrangler.jsonc");
  const config = parse(await readFile(configPath, "utf8"));
  return runReleasePreflight({
    config,
    configPath,
    workerDirectory,
    wrangler,
    spawn,
  });
}

function secureJsonHeaders(response) {
  return response.headers?.get("content-type")?.split(";", 1)[0]
      === "application/json"
    && response.headers.get("cache-control") === "no-store"
    && response.headers.get("referrer-policy") === "no-referrer"
    && response.headers.get("x-content-type-options") === "nosniff";
}

function containedProductionHealth(value) {
  return value?.status === "ok"
    && value?.enrollmentMode === "disabled"
    && value?.collectionControls?.state === "contained"
    && value?.collectionControls?.enrollment === false
    && value?.collectionControls?.uploadRegistration === false
    && value?.collectionControls?.processing === false
    && value?.collectionControls?.publication === false
    && value?.contracts?.accountScopedContribution
      ?.externalParticipantsAuthorized === false;
}

export async function recheckProductionContainment({
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const healthURL = new URL(
    "/api/health",
    DEPLOYMENT_ENDPOINTS.public.origin,
  ).href;
  let response;
  try {
    response = await fetchImpl(healthURL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNREACHABLE");
  }
  if (response?.url !== healthURL
      || response.status !== 200
      || !secureJsonHeaders(response)
      || typeof response.text !== "function") {
    return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }
  let body;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
    }
    body = JSON.parse(text);
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }
  if (!containedProductionHealth(body)) {
    return localFailure("PRODUCTION_HEALTH_RECHECK_NOT_CONTAINED");
  }
  return { ok: true, code: null };
}

async function runProductionDeploymentFromSnapshot({
  receiptFile,
  now = Date.now(),
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  checkEndpoints = checkDeploymentEndpointConsumers,
  stageAssets = stageProductionAssets,
  proofCheck = null,
  sourceCommit,
  snapshotRepositoryRoot,
  sourceCheckDirectory,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionContainment,
}) {
  const containmentProof = proofCheck ?? await readDeploymentProof({
    filename: receiptFile,
    kind: "production",
    now,
    expectedSourceCommit: sourceCommit,
  });
  if (!containmentProof.ok) return containmentProof;
  if (containmentProof.proof?.worker?.sourceCommit !== sourceCommit) {
    return localFailure("PRODUCTION_CONTAINMENT_PROOF_MISMATCH");
  }

  let preflight;
  try {
    preflight = await releasePreflight({ workerDirectory, wrangler, spawn });
  } catch {
    return localFailure("RELEASE_PREFLIGHT_BLOCKED");
  }
  if (preflight?.state !== "ready") {
    return {
      ok: false,
      code: "RELEASE_PREFLIGHT_BLOCKED",
      blockers: Array.isArray(preflight?.blockers)
        ? preflight.blockers
        : ["LOCAL_RELEASE_PREFLIGHT_FAILED"],
    };
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
    return localFailure(code);
  }
  try {
    await checkEndpoints();
  } catch {
    return localFailure("DEPLOYMENT_ENDPOINTS_INVALID");
  }
  try {
    await stageAssets({
      repositoryRoot: snapshotRepositoryRoot,
      sourceDirectory: join(
        snapshotRepositoryRoot,
        ".release-build",
        "public-release-site",
      ),
      destinationDirectory: join(
        snapshotRepositoryRoot,
        ".release-build",
        "worker-assets",
      ),
    });
  } catch {
    return localFailure("PRODUCTION_PUBLIC_ASSETS_INVALID");
  }
  let health;
  try {
    health = await healthRecheck({ fetchImpl });
  } catch {
    return localFailure("PRODUCTION_HEALTH_RECHECK_UNREACHABLE");
  }
  if (!health?.ok) {
    return health?.code
      ? health
      : localFailure("PRODUCTION_HEALTH_RECHECK_INVALID");
  }

  // This is deliberately immediately before Wrangler: health probing can
  // yield to another checkout, so the earlier post-staging check is not the
  // deployment boundary.
  const deploySource = verifySourceSnapshot({
    workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!deploySource.ok) return deploySource;

  let deployment;
  try {
    deployment = spawn(
      wrangler,
      ["deploy", "--env", "production", "--strict"],
      {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    return localFailure("PRODUCTION_DEPLOY_FAILED");
  }
  const postDeploySource = verifySourceSnapshot({
    workerDirectory: sourceCheckDirectory,
    expectedSourceCommit: sourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!postDeploySource.ok) return postDeploySource;
  if (deployment?.error || deployment?.status !== 0) {
    return localFailure("PRODUCTION_DEPLOY_FAILED");
  }
  return {
    ok: true,
    code: "PRODUCTION_DEPLOYED_AFTER_CONTAINMENT_PROOF",
    channel: "stable",
    collectionAuthorized: false,
    immediateHealthRecheck: "contained",
    containmentProof: {
      observedAt: containmentProof.proof.observedAt,
      workerRevision: containmentProof.proof.worker.revision,
    },
  };
}

export async function runProductionDeployment({
  confirmation,
  receiptFile,
  now = Date.now(),
  wrangler,
  workerDirectory,
  spawn = spawnSync,
  checkWorkspacePackages = checkLocalWorkspacePackages,
  checkEndpoints = checkDeploymentEndpointConsumers,
  stageAssets = stageProductionAssets,
  proofCheck = null,
  expectedSourceCommit = null,
  sourceCommitCheck = checkedOutSourceCommit,
  sourceTreeCleanCheck = checkedOutSourceTreeClean,
  createSourceSnapshot = createImmutableSourceSnapshot,
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionContainment,
}) {
  if (confirmation !== PRODUCTION_DEPLOY_CONFIRMATION) {
    return localFailure("CONFIRMATION_REQUIRED");
  }
  const initialSource = verifySourceSnapshot({
    workerDirectory,
    expectedSourceCommit,
    sourceCommitCheck,
    sourceTreeCleanCheck,
  });
  if (!initialSource.ok) return initialSource;
  const sourceCommit = initialSource.sourceCommit;

  let snapshot;
  try {
    snapshot = await createSourceSnapshot({ workerDirectory, sourceCommit });
  } catch (error) {
    return localFailure(
      error?.code === "PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED"
        ? error.code
        : "PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE",
    );
  }
  if (!snapshot
      || typeof snapshot.repositoryRoot !== "string"
      || typeof snapshot.workerDirectory !== "string"
      || typeof snapshot.cleanup !== "function") {
    if (typeof snapshot?.cleanup === "function") {
      try {
        await snapshot.cleanup();
      } catch {
        return localFailure("PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED");
      }
    }
    return localFailure("PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE");
  }

  let result;
  try {
    result = await runProductionDeploymentFromSnapshot({
      receiptFile,
      now,
      wrangler,
      workerDirectory: snapshot.workerDirectory,
      snapshotRepositoryRoot: snapshot.repositoryRoot,
      sourceCheckDirectory: workerDirectory,
      sourceCommit,
      spawn,
      checkWorkspacePackages,
      checkEndpoints,
      stageAssets,
      proofCheck,
      sourceCommitCheck,
      sourceTreeCleanCheck,
      releasePreflight,
      fetchImpl,
      healthRecheck,
    });
  } catch {
    result = localFailure("PRODUCTION_DEPLOYMENT_FAILED");
  }

  try {
    await snapshot.cleanup();
  } catch {
    return localFailure("PRODUCTION_SOURCE_SNAPSHOT_CLEANUP_FAILED");
  }
  return result;
}

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  return !value || value.startsWith("--") ? null : value;
}

async function main() {
  if (process.argv.length !== 6
      || process.argv[2] !== "--receipt-file"
      || process.argv[4] !== "--confirm") {
    process.stderr.write(
      "Usage: production-deploy.mjs --receipt-file /owner-only/path "
        + `--confirm ${PRODUCTION_DEPLOY_CONFIRMATION}\n`,
    );
    process.exit(2);
  }
  const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  let result;
  try {
    const wrangler = join(
      workerDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "wrangler.cmd" : "wrangler",
    );
    result = await runProductionDeployment({
      receiptFile: option("--receipt-file"),
      confirmation: option("--confirm"),
      wrangler,
      workerDirectory,
    });
  } catch {
    result = { ok: false, code: "PRODUCTION_DEPLOYMENT_FAILED" };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
