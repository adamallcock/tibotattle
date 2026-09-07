#!/usr/bin/env node

/**
 * Execute the narrow native Linux x64 mutex qualification after its binding
 * and sidecar have been built. Its disposable native test exercises the
 * fixed accountless record only under a temporary owner-only state root; it
 * accesses no production credential, selects no production backend, and
 * carries no Linux support or packaging claim.
 */

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  linuxCredentialMutexBindingEvidence,
  loadLinuxCredentialMutexBinding,
} from "../src/platform/linux-credential-mutex.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const NATIVE_TEST = "test/linux-credential-mutex-native.test.js";
const MAXIMUM_OUTPUT_BYTES = 64 * 1024;

function fail(code) {
  const error = new Error("Linux credential mutex qualification failed");
  error.name = "LinuxCredentialMutexQualificationError";
  error.code = `linux_credential_mutex_qualification_${code}`;
  throw error;
}

/**
 * Run only the explicit native mutex test. It uses disposable owner-only
 * state roots, including synthetic fixed accountless records and a fresh
 * runtime namespace after a crash.
 */
export function qualifyLinuxCredentialMutex({
  platform = process.platform,
  architecture = process.arch,
  executable = process.execPath,
  environment = process.env,
  spawnSync = nodeSpawnSync,
  loadBinding = loadLinuxCredentialMutexBinding,
  bindingEvidence = linuxCredentialMutexBindingEvidence,
} = {}) {
  if (platform !== "linux") fail("native_linux_required");
  if (architecture !== "x64") fail("native_linux_x64_required");
  if (typeof executable !== "string"
      || executable.length === 0
      || typeof spawnSync !== "function"
      || typeof loadBinding !== "function"
      || typeof bindingEvidence !== "function"
      || environment === null
      || typeof environment !== "object") {
    fail("invalid_configuration");
  }

  let evidence;
  try {
    const binding = loadBinding({ platform, architecture });
    evidence = bindingEvidence(binding);
  } catch {
    fail("binding_unavailable");
  }
  if (evidence === null
      || evidence.target !== "linux-x64"
      || evidence.pathSafetyVerified !== true
      || evidence.manifestPathSafetyVerified !== true
      || evidence.bindingIntegrityVerifiedBeforeAndAfter !== true
      || evidence.crossProcessScope !== "same_linux_network_namespace"
      || evidence.productionSafe !== false) {
    fail("binding_unavailable");
  }

  let result;
  try {
    result = spawnSync(executable, ["--test", NATIVE_TEST], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...environment,
        USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_NATIVE_TEST: "1",
      },
      encoding: "utf8",
      maxBuffer: MAXIMUM_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    });
  } catch {
    fail("native_test_failed");
  }
  if (result?.error || result?.status !== 0 || result?.signal !== null) {
    fail("native_test_failed");
  }
  return Object.freeze({
    schemaVersion: "linux-credential-mutex-qualification-v1",
    status: "passed",
    scope: "native_mutex_only",
    syntheticAccountlessInstallationRecordTested: true,
    productionCredentialAccessed: false,
    platform: "linux",
    architecture: "x64",
    contractVersion: "linux-credential-mutex-v1",
    crossProcessSafe: true,
    crossProcessScope: "same_linux_network_namespace",
    durableAbandonmentMarker: true,
    productionSafe: false,
  });
}

export function main() {
  const receipt = qualifyLinuxCredentialMutex();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.code ?? "linux_credential_mutex_qualification_failed"}\n`);
    process.exitCode = 1;
  }
}
