#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkLocalWorkspacePackage,
} from "./check-local-workspace-package.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const PACKAGE_NAME = "@app-usagemonitor/telemetry-contract";
const SOURCE_ROOT = resolve(
  WORKER_ROOT,
  "..",
  "..",
  "packages",
  "telemetry-contract",
);
const INSTALLED_ROOT = join(
  WORKER_ROOT,
  "node_modules",
  "@app-usagemonitor",
  "telemetry-contract",
);

export function checkLocalTelemetryContractPackage(options = {}) {
  return checkLocalWorkspacePackage({
    packageName: PACKAGE_NAME,
    sourceRoot: SOURCE_ROOT,
    installedRoot: INSTALLED_ROOT,
    errorCode: "TELEMETRY_CONTRACT_PACKAGE_STALE",
    ...options,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  try {
    const result = await checkLocalTelemetryContractPackage();
    process.stdout.write(
      `Telemetry contract package copy is current (${result.fileCount} files, ${result.sha256}).\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error.code ?? "TELEMETRY_CONTRACT_PACKAGE_CHECK_FAILED"}: ${error.message}\n`
      + "Remediation: run npm ci in apps/worker, then retry this check.\n",
    );
    process.exitCode = 1;
  }
}
