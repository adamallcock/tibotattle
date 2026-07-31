#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkLocalAccountingPackage,
} from "./check-local-accounting-package.mjs";
import {
  checkLocalWorkspacePackage,
} from "./check-local-workspace-package.mjs";
import {
  checkLocalTelemetryContractPackage,
} from "./check-local-telemetry-contract-package.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const QUOTA_ANALYSIS_PACKAGE = Object.freeze({
  errorCode: "QUOTA_ANALYSIS_PACKAGE_STALE",
  installedRoot: join(
    WORKER_ROOT,
    "node_modules",
    "@app-usagemonitor",
    "quota-analysis",
  ),
  packageName: "@app-usagemonitor/quota-analysis",
  sourceRoot: resolve(
    WORKER_ROOT,
    "..",
    "..",
    "packages",
    "quota-analysis",
  ),
});

function requiredCheck(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
  return value;
}

export function checkLocalQuotaAnalysisPackage(options = {}) {
  return checkLocalWorkspacePackage({
    ...QUOTA_ANALYSIS_PACKAGE,
    ...options,
  });
}

export async function checkLocalWorkspacePackages(options = {}) {
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
  ) {
    throw new TypeError("workspace package check options must be an object");
  }
  const {
    checkAccountingPackage = checkLocalAccountingPackage,
    checkQuotaAnalysisPackage = checkLocalQuotaAnalysisPackage,
    checkTelemetryContractPackage = checkLocalTelemetryContractPackage,
  } = options;
  const accounting = await requiredCheck(
    checkAccountingPackage,
    "checkAccountingPackage",
  )();
  const telemetryContract = await requiredCheck(
    checkTelemetryContractPackage,
    "checkTelemetryContractPackage",
  )();
  const quotaAnalysis = await requiredCheck(
    checkQuotaAnalysisPackage,
    "checkQuotaAnalysisPackage",
  )();
  const packages = Object.freeze([
    accounting,
    telemetryContract,
    quotaAnalysis,
  ]);
  return Object.freeze({
    packageCount: packages.length,
    packages,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  try {
    const result = await checkLocalWorkspacePackages();
    const summary = result.packages
      .map((receipt) =>
        `${receipt.packageName} (${receipt.fileCount} files, ${receipt.sha256})`)
      .join("; ");
    process.stdout.write(
      `Workspace package copies are current: ${summary}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error?.code ?? "WORKSPACE_PACKAGES_CHECK_FAILED"}: `
      + `${error instanceof Error ? error.message : "unknown failure"}\n`
      + "Remediation: run npm ci in apps/worker, then retry this check.\n",
    );
    process.exitCode = 1;
  }
}
