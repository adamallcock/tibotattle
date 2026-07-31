#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkLocalWorkspacePackage,
} from "./check-local-workspace-package.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKER_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const PACKAGE_NAME = "@app-usagemonitor/accounting";
const SOURCE_ROOT = resolve(
  WORKER_ROOT,
  "..",
  "..",
  "packages",
  "accounting",
);
const INSTALLED_ROOT = join(
  WORKER_ROOT,
  "node_modules",
  "@app-usagemonitor",
  "accounting",
);

export function checkLocalAccountingPackage(options = {}) {
  return checkLocalWorkspacePackage({
    packageName: PACKAGE_NAME,
    sourceRoot: SOURCE_ROOT,
    installedRoot: INSTALLED_ROOT,
    errorCode: "ACCOUNTING_PACKAGE_STALE",
    ...options,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  try {
    const result = await checkLocalAccountingPackage();
    process.stdout.write(
      `Accounting package copy is current (${result.fileCount} files, ${result.sha256}).\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error.code ?? "ACCOUNTING_PACKAGE_CHECK_FAILED"}: ${error.message}\n`
      + "Remediation: run npm ci in apps/worker, then retry this check.\n",
    );
    process.exitCode = 1;
  }
}
