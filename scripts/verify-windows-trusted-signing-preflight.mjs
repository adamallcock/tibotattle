#!/usr/bin/env node

/**
 * Check the exact TrustedSigning PowerShell module used by the signed
 * Windows packaging lane. This is a read-only preflight: it never installs,
 * imports, or invokes the module and it never emits module paths, usernames,
 * environment values, or PowerShell diagnostics.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REQUIRED_VERSION = "0.5.0";
const POWERSHELL_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$modules = @(Get-Module -ListAvailable -Name TrustedSigning)",
  "$versions = @($modules | ForEach-Object { $_.Version.ToString() })",
  "[ordered]@{ count = $modules.Count; versions = $versions } | ConvertTo-Json -Compress",
].join("; ");
const PREFLIGHT_STATUS = Object.freeze({
  passed: "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_PASSED",
  unsupported: "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_NATIVE_WINDOWS_REQUIRED",
  invalid: "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_INVALID",
  unavailable: "WINDOWS_TRUSTEDSIGNING_PREFLIGHT_UNAVAILABLE",
});

function result(status, exitCode) {
  return Object.freeze({ status, exitCode });
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

/**
 * Validate the aggregate emitted by the fixed PowerShell query. Only one
 * module record may exist and its version must be exactly 0.5.0; a newer
 * version alongside 0.5.0 is deliberately rejected.
 */
export function validateTrustedSigningProbe(value) {
  if (!exactKeys(value, ["count", "versions"])
      || !Number.isSafeInteger(value.count)
      || value.count < 0
      || !Array.isArray(value.versions)
      || value.versions.length !== value.count
      || value.count !== 1
      || value.versions[0] !== REQUIRED_VERSION) {
    return false;
  }
  return true;
}

/**
 * Parse PowerShell output without allowing any child diagnostic to cross the
 * content-free boundary.
 */
export function parseTrustedSigningProbe(stdout) {
  if (typeof stdout !== "string") return result(PREFLIGHT_STATUS.invalid, 1);
  let parsed;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/u, "").trim());
  } catch {
    return result(PREFLIGHT_STATUS.invalid, 1);
  }
  return validateTrustedSigningProbe(parsed)
    ? result(PREFLIGHT_STATUS.passed, 0)
    : result(PREFLIGHT_STATUS.invalid, 1);
}

/** Exposed for tests and workflow contract checks; it is a fixed string. */
export function trustedSigningPowerShellCommand() {
  return POWERSHELL_COMMAND;
}

/**
 * Run the read-only Windows module inventory. Dependency injection keeps the
 * parser and failure behavior testable on macOS without emulating PowerShell.
 */
export function runTrustedSigningPreflight({
  platform = process.platform,
  executable = "powershell.exe",
  spawn = spawnSync,
} = {}) {
  if (platform !== "win32") {
    return result(PREFLIGHT_STATUS.unsupported, 1);
  }

  let child;
  try {
    child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-OutputFormat",
        "Text",
        "-Command",
        POWERSHELL_COMMAND,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return result(PREFLIGHT_STATUS.unavailable, 1);
  }

  if (child === null
      || typeof child !== "object"
      || child.error
      || child.status !== 0) {
    return result(PREFLIGHT_STATUS.unavailable, 1);
  }
  return parseTrustedSigningProbe(child.stdout);
}

export function formatTrustedSigningPreflight(resultValue) {
  if (!resultValue || !Object.values(PREFLIGHT_STATUS).includes(resultValue.status)) {
    return `${PREFLIGHT_STATUS.unavailable}\n`;
  }
  return `${resultValue.status}\n`;
}

function main() {
  const outcome = runTrustedSigningPreflight();
  process.stdout.write(formatTrustedSigningPreflight(outcome));
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main();
}
