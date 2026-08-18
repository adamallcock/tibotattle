#!/usr/bin/env node

import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRODUCTION_DEPLOY_CONFIRMATION,
  runProductionDeployment,
} from "../apps/worker/scripts/production-deploy.mjs";
import { verifyWebReleaseReceipt } from "./web-release-lane.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return [
    "Usage:",
    "  node scripts/deploy-web-release.js \\",
    "    --receipt /absolute/repository/.release-build/web-release-receipt.json \\",
    `    --confirm ${PRODUCTION_DEPLOY_CONFIRMATION} \\`,
    "    [--confirm-migrations BINDING:0000_name.sql,...]",
  ].join("\n");
}

export function parseDeployWebReleaseArgs(argv) {
  const parsed = {
    confirmation: null,
    confirmedMigrations: null,
    receiptPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--confirm", "--confirm-migrations", "--receipt"].includes(arg)) {
      throw new TypeError(`Unknown web-release deployment argument: ${arg}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${arg}\n${usage()}`);
    }
    index += 1;
    if (arg === "--confirm") parsed.confirmation = value;
    else if (arg === "--confirm-migrations") parsed.confirmedMigrations = value;
    else parsed.receiptPath = value;
  }
  if (!parsed.confirmation || !parsed.receiptPath) {
    throw new TypeError(`A receipt and explicit confirmation are required\n${usage()}`);
  }
  return parsed;
}

/**
 * The only production entry point for a prepared web-only release. It checks
 * the receipt and committed scope again, then delegates to the existing
 * immutable-snapshot Worker deployment guard with the receipt's exact SHA.
 */
export async function deployWebRelease({
  repositoryRoot = REPOSITORY_ROOT,
  receiptPath,
  confirmation,
  confirmedMigrations = null,
  runProduction = runProductionDeployment,
  verifyReceipt = verifyWebReleaseReceipt,
}) {
  const repository = resolve(repositoryRoot);
  const verification = await verifyReceipt({
    repositoryRoot: repository,
    receiptPath: resolve(receiptPath),
  });
  const workerDirectory = join(repository, "apps", "worker");
  const wrangler = join(
    workerDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const deployment = await runProduction({
    confirmation,
    confirmedMigrations,
    expectedSourceCommit: verification.scope.sourceCommit,
    workerDirectory,
    wrangler,
  });
  return Object.freeze({
    deployment,
    receipt: verification.receipt,
    sourceCommit: verification.scope.sourceCommit,
  });
}

async function main() {
  try {
    const parsed = parseDeployWebReleaseArgs(process.argv.slice(2));
    const result = await deployWebRelease({
      confirmation: parsed.confirmation,
      confirmedMigrations: parsed.confirmedMigrations,
      receiptPath: resolve(parsed.receiptPath),
    });
    process.stdout.write(`${JSON.stringify(result.deployment, null, 2)}\n`);
    process.exitCode = result.deployment?.ok === true ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
