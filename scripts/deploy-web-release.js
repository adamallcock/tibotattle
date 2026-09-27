#!/usr/bin/env node

import process from "node:process";
import { join, resolve } from "node:path";
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
    "Usage:",
    "  node scripts/deploy-web-release.js \\",
    "    --receipt /absolute/repository/.release-build/web-release-receipt.json \\",
    `    --confirm ${PRODUCTION_DEPLOY_CONFIRMATION} \\`,
    "    [--confirm-migrations BINDING:0000_name.sql,...]",
    "    [--inventory PRIVATE_JSON --inventory-sha256 SHA256",
    "     --retained-public-source FULL_SHA --expected-live-manifest-sha256 SHA256]",
  ].join("\n");
}

export function parseDeployWebReleaseArgs(argv) {
  const parsed = {
    confirmation: null,
    confirmedMigrations: null,
    receiptPath: null,
    inventoryPath: null,
    inventorySha256: null,
    retainedPublicSourceCommit: null,
    expectedLiveManifestSha256: null,
  };
  const fields = new Map([
    ["--confirm", "confirmation"],
    ["--confirm-migrations", "confirmedMigrations"],
    ["--receipt", "receiptPath"],
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
  const typedFields = ["inventoryPath", "inventorySha256", "retainedPublicSourceCommit", "expectedLiveManifestSha256"];
  const typedCount = typedFields.filter((field) => parsed[field] !== null).length;
  if (typedCount !== 0 && typedCount !== typedFields.length) {
    throw new TypeError(`Typed production deployment requires every inventory and public-site pin\n${usage()}`);
  }
  if (typedCount > 0 && (parsed.confirmedMigrations !== null
      || !/^[a-f0-9]{64}$/u.test(parsed.inventorySha256)
      || !/^[a-f0-9]{40}$/u.test(parsed.retainedPublicSourceCommit)
      || !/^[a-f0-9]{64}$/u.test(parsed.expectedLiveManifestSha256))) {
    throw new TypeError(`Typed production deployment pins are invalid\n${usage()}`);
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
  typedProduction = null,
  retainedPublicSourceCommit = null,
  expectedLiveManifestSha256 = null,
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
  if (typedProduction === null && (retainedPublicSourceCommit !== null
      || expectedLiveManifestSha256 !== null)) {
    throw new TypeError("Typed web release pins require a private production inventory.");
  }
  if (typedProduction !== null && (confirmedMigrations !== null
      || !/^[a-f0-9]{40}$/u.test(retainedPublicSourceCommit ?? "")
      || !/^[a-f0-9]{64}$/u.test(expectedLiveManifestSha256 ?? "")
      || !/^[a-f0-9]{64}$/u.test(verification.receipt?.site?.manifestSha256 ?? ""))) {
    throw new TypeError("Typed web release requires a verified candidate manifest and complete live pins.");
  }
  const deployment = await runProduction({
    confirmation,
    confirmedMigrations,
    expectedSourceCommit: verification.scope.sourceCommit,
    expectedPreviousSourceCommit: verification.scope.baseCommit,
    workerDirectory,
    wrangler,
    ...(typedProduction === null ? {} : {
      typedProduction,
      retainedPublicSourceCommit,
      expectedLiveManifestSha256,
      candidatePublicManifestSha256: verification.receipt.site.manifestSha256,
    }),
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
    const inventory = parsed.inventoryPath === null ? null : await readPrivateProductionInventory(
      parsed.inventoryPath,
      parsed.inventorySha256,
    );
    const result = await deployWebRelease({
      confirmation: parsed.confirmation,
      confirmedMigrations: parsed.confirmedMigrations,
      receiptPath: resolve(parsed.receiptPath),
      ...(inventory === null ? {} : {
        typedProduction: {
          inventory,
          provider: createProductionLiveProvider({
            accountId: inventory.accountId,
            workerName: inventory.workerName,
          }),
        },
        retainedPublicSourceCommit: parsed.retainedPublicSourceCommit,
        expectedLiveManifestSha256: parsed.expectedLiveManifestSha256,
      }),
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
