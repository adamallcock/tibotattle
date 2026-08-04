import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  releasePreflight = productionReleasePreflight,
  fetchImpl = globalThis.fetch,
  healthRecheck = recheckProductionContainment,
}) {
  if (confirmation !== PRODUCTION_DEPLOY_CONFIRMATION) {
    return localFailure("CONFIRMATION_REQUIRED");
  }
  const sourceCommit = expectedSourceCommit
    ?? sourceCommitCheck(workerDirectory);
  if (!sourceCommit || !/^[a-f0-9]{7,64}$/u.test(sourceCommit)) {
    return localFailure("PRODUCTION_SOURCE_REVISION_UNAVAILABLE");
  }
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
    await stageAssets();
  } catch {
    return localFailure("PRODUCTION_PUBLIC_ASSETS_INVALID");
  }
  const deploySourceCommit = sourceCommitCheck(workerDirectory);
  if (deploySourceCommit !== sourceCommit) {
    return localFailure("PRODUCTION_SOURCE_REVISION_CHANGED");
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
