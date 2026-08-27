#!/usr/bin/env node

/**
 * Check the exact TrustedSigning PowerShell module and exported command used
 * by the signed Windows packaging lane. This is a read-only preflight: it
 * never installs, imports, or invokes the module and it never emits module
 * paths, usernames, environment values, or PowerShell diagnostics.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REQUIRED_VERSION = "0.5.0";
const REQUIRED_COMMAND = "Invoke-TrustedSigning";
const CALLABLE_COMMAND_TYPES = Object.freeze([
  "Cmdlet",
  "ExternalScript",
  "Filter",
  "Function",
  "Script",
]);
const POWERSHELL_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  "$modules = @(Get-Module -ListAvailable -Name TrustedSigning)",
  "$versions = @($modules | ForEach-Object { $_.Version.ToString() })",
  "$commands = @($modules | ForEach-Object { if ($null -ne $_.ExportedCommands) { $_.ExportedCommands.GetEnumerator() | Where-Object { $_.Key -ceq 'Invoke-TrustedSigning' } | ForEach-Object { $_.Value } } })",
  "$commandNames = @($commands | ForEach-Object { [string]$_.Name })",
  "$commandModules = @($commands | ForEach-Object { [string]$_.ModuleName })",
  "$commandVersions = @($commands | ForEach-Object { if ($null -eq $_.Version) { '' } else { $_.Version.ToString() } })",
  "$commandTypes = @($commands | ForEach-Object { if ($null -eq $_.CommandType) { '' } else { $_.CommandType.ToString() } })",
  "[ordered]@{ count = $modules.Count; versions = $versions; commandCount = $commands.Count; commandNames = $commandNames; commandModules = $commandModules; commandVersions = $commandVersions; commandTypes = $commandTypes } | ConvertTo-Json -Compress",
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
 * version alongside 0.5.0 is deliberately rejected. The command must also
 * resolve exactly once, be exported by that module, and be a callable command
 * type. No path, diagnostic, or other ambient field is accepted.
 */
export function validateTrustedSigningProbe(value) {
  if (!exactKeys(value, [
    "count",
    "versions",
    "commandCount",
    "commandNames",
    "commandModules",
    "commandVersions",
    "commandTypes",
  ])
      || !Number.isSafeInteger(value.count)
      || value.count < 0
      || !Array.isArray(value.versions)
      || value.versions.length !== value.count
      || value.count !== 1
      || value.versions[0] !== REQUIRED_VERSION
      || !Number.isSafeInteger(value.commandCount)
      || value.commandCount < 0
      || value.commandCount !== 1
      || !Array.isArray(value.commandNames)
      || !Array.isArray(value.commandModules)
      || !Array.isArray(value.commandVersions)
      || !Array.isArray(value.commandTypes)
      || value.commandNames.length !== value.commandCount
      || value.commandModules.length !== value.commandCount
      || value.commandVersions.length !== value.commandCount
      || value.commandTypes.length !== value.commandCount
      || value.commandNames[0] !== REQUIRED_COMMAND
      || value.commandModules[0] !== "TrustedSigning"
      || value.commandVersions[0] !== REQUIRED_VERSION
      || !CALLABLE_COMMAND_TYPES.includes(value.commandTypes[0])) {
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
