#!/usr/bin/env node

import process from "node:process";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRODUCTION_DEPLOY_CONFIRMATION,
  runProductionDeployment,
} from "../apps/worker/scripts/production-deploy.mjs";
import { readPrivateProductionInventory } from "../apps/worker/scripts/production-reconcile.mjs";
import { createProductionLiveProvider } from "../apps/worker/scripts/production-live-provider.mjs";
import { verifyWebReleaseReceipt } from "./web-release-lane.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return [
    "Usage (typed only; from P1 on use production:deploy with --edge-mode):",
    "  node scripts/deploy-web-release.js \\",
    "    --receipt /absolute/repository/.release-build/web-release-receipt.json \\",
    `    --confirm ${PRODUCTION_DEPLOY_CONFIRMATION} \\`,
    "    [--operation /absolute/private/new-operation-directory] \\",
    "    --inventory PRIVATE_JSON --inventory-sha256 SHA256 \\",
    "    --retained-public-source FULL_SHA --expected-live-manifest-sha256 SHA256",
  ].join("\n");
}

// The untyped form renders the checked-in env.production: on this line the
// JSON storage layout without the edge entry. Over typed production or a live
// edge it would replace the Worker and skip every edge gate, so it is refused
// before the receipt is read (the same code as production:deploy).
function untypedDeployRefused() {
  return Object.assign(
    new TypeError(`PRODUCTION_UNTYPED_DEPLOY_REFUSED: a web-only release deploy needs the private inventory and live-site pins\n${usage()}`),
    { code: "PRODUCTION_UNTYPED_DEPLOY_REFUSED" },
  );
}

export function parseDeployWebReleaseArgs(argv) {
  const parsed = {
    confirmation: null,
    confirmedMigrations: null,
    receiptPath: null,
    operationDirectory: null,
    inventoryPath: null,
    inventorySha256: null,
    retainedPublicSourceCommit: null,
    expectedLiveManifestSha256: null,
  };
  const fields = new Map([
    ["--confirm", "confirmation"],
    ["--confirm-migrations", "confirmedMigrations"],
    ["--receipt", "receiptPath"],
    ["--operation", "operationDirectory"],
    ["--inventory", "inventoryPath"],
    ["--inventory-sha256", "inventorySha256"],
    ["--retained-public-source", "retainedPublicSourceCommit"],
    ["--expected-live-manifest-sha256", "expectedLiveManifestSha256"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const field = fields.get(arg);
    if (!field || parsed[field] !== null) {
      throw new TypeError(`Unknown web-release deployment argument: ${arg}\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`Missing value for ${arg}\n${usage()}`);
    }
    index += 1;
    parsed[field] = value;
  }
  if (!parsed.confirmation || !parsed.receiptPath) {
    throw new TypeError(`A receipt and explicit confirmation are required\n${usage()}`);
  }
  if (parsed.operationDirectory !== null
      && (!isAbsolute(parsed.operationDirectory)
        || parsed.operationDirectory.length > 4096
        || /[\0\r\n]/u.test(parsed.operationDirectory))) {
    throw new TypeError(`A custom operation directory must be an absolute private path\n${usage()}`);
  }
  const typedFields = ["inventoryPath", "inventorySha256", "retainedPublicSourceCommit", "expectedLiveManifestSha256"];
  const typedCount = typedFields.filter((field) => parsed[field] !== null).length;
  if (typedCount === 0) throw untypedDeployRefused();
  if (typedCount !== typedFields.length) {
    throw new TypeError(`Typed production deployment requires every inventory and public-site pin\n${usage()}`);
  }
  if (parsed.confirmedMigrations !== null
      || !/^[a-f0-9]{64}$/u.test(parsed.inventorySha256)
      || !/^[a-f0-9]{40}$/u.test(parsed.retainedPublicSourceCommit)
      || !/^[a-f0-9]{64}$/u.test(parsed.expectedLiveManifestSha256)) {
    throw new TypeError(`Typed production deployment pins are invalid\n${usage()}`);
  }
  return parsed;
}

/**
 * The production entry point for a prepared web-only release before P1. It
 * refuses the untyped form, checks the receipt and committed scope again, then
 * delegates to the typed immutable-snapshot Worker deployment guard with the
 * receipt's exact SHA. From P1 on the guard refuses it too
 * (EDGE_MODE_REQUIRED_FOR_EDGE_LIVE): it has no edge mode.
 */
export async function deployWebRelease({
  repositoryRoot = REPOSITORY_ROOT,
  receiptPath,
  confirmation,
  operationDirectory = null,
  confirmedMigrations = null,
  typedProduction = null,
  retainedPublicSourceCommit = null,
  expectedLiveManifestSha256 = null,
  runProduction = runProductionDeployment,
  verifyReceipt = verifyWebReleaseReceipt,
}) {
  if (!typedProduction || typeof typedProduction !== "object") throw untypedDeployRefused();
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
  if (confirmedMigrations !== null
      || !/^[a-f0-9]{40}$/u.test(retainedPublicSourceCommit ?? "")
      || !/^[a-f0-9]{64}$/u.test(expectedLiveManifestSha256 ?? "")
      || !/^[a-f0-9]{64}$/u.test(verification.receipt?.site?.manifestSha256 ?? "")) {
    throw new TypeError("Typed web release requires a verified candidate manifest and complete live pins.");
  }
  const deployment = await runProduction({
    confirmation,
    confirmedMigrations,
    expectedSourceCommit: verification.scope.sourceCommit,
    expectedPreviousSourceCommit: verification.scope.baseCommit,
    workerDirectory,
    wrangler,
    ...(operationDirectory === null ? {} : { operationDirectory }),
    typedProduction,
    retainedPublicSourceCommit,
    expectedLiveManifestSha256,
    candidatePublicManifestSha256: verification.receipt.site.manifestSha256,
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
    const inventory = await readPrivateProductionInventory(
      parsed.inventoryPath,
      parsed.inventorySha256,
    );
    const result = await deployWebRelease({
      confirmation: parsed.confirmation,
      confirmedMigrations: parsed.confirmedMigrations,
      receiptPath: resolve(parsed.receiptPath),
      operationDirectory: parsed.operationDirectory,
      typedProduction: {
        inventory,
        provider: createProductionLiveProvider({
          accountId: inventory.accountId,
          workerName: inventory.workerName,
        }),
      },
      retainedPublicSourceCommit: parsed.retainedPublicSourceCommit,
      expectedLiveManifestSha256: parsed.expectedLiveManifestSha256,
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
