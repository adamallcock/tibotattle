import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkDeploymentEndpointConsumers } from "./check-deployment-endpoints.mjs";
import { checkLocalWorkspacePackages } from "./check-local-workspace-packages.mjs";
import { readDeploymentProof } from "./deployment-proof.mjs";
import { stageProductionAssets } from "./stage-production-assets.mjs";

export const PRODUCTION_DEPLOY_CONFIRMATION =
  "DEPLOY_CONTAINED_PRODUCTION";

function localFailure(code) {
  return { ok: false, code };
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
}) {
  if (confirmation !== PRODUCTION_DEPLOY_CONFIRMATION) {
    return localFailure("CONFIRMATION_REQUIRED");
  }
  const containmentProof = proofCheck ?? await readDeploymentProof({
    filename: receiptFile,
    kind: "production",
    now,
  });
  if (!containmentProof.ok) return containmentProof;

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
