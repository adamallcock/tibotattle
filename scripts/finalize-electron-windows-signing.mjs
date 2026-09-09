#!/usr/bin/env node

/**
 * Prepare or explicitly invoke the reviewed Windows Azure signing builder.
 *
 * The default mode only validates the canonical source candidate and reports
 * whether the local Windows signing prerequisites are present. It never
 * contacts Azure, invokes electron-builder, signs a file, publishes a feed,
 * or writes a receipt. The explicit `--prepare-builder-host` mode performs
 * only electron-builder's TrustedSigning module preparation before Azure or
 * native signing. The separate `--sign` mode is deliberately explicit and
 * always supplies electron-builder with `--publish never`.
 *
 * This is not a production-credential or native-module qualification
 * finalizer.  The Windows runtime remains `required` until a later reviewed
 * native-module signature/rebinding and installed-artifact qualification
 * operation produces its own evidence.
 */

import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { productionElectronCandidatePlan } from "./package-electron-production.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const REQUIRE = createRequire(import.meta.url);

const RECEIPT_SCHEMA = "tibotattle-electron-windows-signing-preflight-v1";
const CANDIDATE_SCHEMA = "tibotattle-electron-production-source-candidate-v1";
const CANDIDATE_RECEIPT_LEAF = "production-source-candidate.json";
const CONFIGURATION_RELATIVE_PATH = "apps/electron/electron-builder.release.config.cjs";
const MAXIMUM_CANDIDATE_BYTES = 128 * 1024;
const MAXIMUM_CAPTURED_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAXIMUM_ENCRYPTED_DIAGNOSTIC_KEY_BYTES = 16 * 1024;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const BUILD_NUMBER = /^[1-9][0-9]{0,9}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const REQUIRED_NODE_VERSION = "v26.2.0";
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const RSA_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,64}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/u;
const ENCRYPTED_BUILDER_DIAGNOSTIC_SCHEMA = "tibotattle-electron-windows-builder-diagnostic-envelope-v1";
const ENCRYPTED_BUILDER_DIAGNOSTIC_LEAF = "windows-builder-failure.envelope.json";
const ENCRYPTED_BUILDER_DIAGNOSTIC_PUBLIC_KEY_BASE64_ENV = "TIBOTATTLE_ELECTRON_WINDOWS_BUILDER_DIAGNOSTIC_PUBLIC_KEY_BASE64";
const ENCRYPTED_BUILDER_DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV = "TIBOTATTLE_ELECTRON_WINDOWS_BUILDER_DIAGNOSTIC_PUBLIC_KEY_SHA256";

const AZURE_RESOURCE_ENVIRONMENT = Object.freeze([
  "TIBOTATTLE_ELECTRON_AZURE_PUBLISHER_NAME",
  "TIBOTATTLE_ELECTRON_AZURE_ENDPOINT",
  "TIBOTATTLE_ELECTRON_AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "TIBOTATTLE_ELECTRON_AZURE_CERTIFICATE_PROFILE_NAME",
]);

// Keep the builder process independent of ambient legacy signer credentials.
// Electron-builder's release config applies the authoritative exact resource
// validation and rejects all forbidden credential variables again.
const SYSTEM_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "ALLUSERSPROFILE",
  "APPDATA",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PSModulePath",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

const AZURE_CLI_ACCOUNT_SHOW_COMMAND = "az account show --only-show-errors --output none";
// The supported GitHub-hosted Windows image provisions this machine-level
// cache outside USERPROFILE. Preserve only this fixed Azure CLI state path;
// no token or other ambient Azure credential setting enters the builder.
const GITHUB_HOSTED_AZURE_CLI_CONFIGURATION_DIRECTORY = "C:\\azureCli";
const AZURE_CLI_LAUNCH_ERROR_CODES = new Set(["EACCES", "ENOENT"]);
const AZURE_CLI_AUTHENTICATION_OUTPUT = /(?:please\s+run\s+['"]?az\s+login|not\s+logged\s+in|aadsts)/iu;
const AZURE_CLI_COMMAND_OUTPUT = /(?:not\s+recognized\s+as\s+(?:an\s+internal\s+or\s+external\s+command|the\s+name\s+of)|command\s+not\s+found)/iu;
const AZURE_CLI_CONFIGURATION_OUTPUT = /(?:azure_config_dir|(?:azure\s+)?config(?:uration)?\s+(?:is\s+)?(?:invalid|unavailable|not\s+found|missing))/iu;

const BUILDER_DIAGNOSTIC_PREFIX = "ELECTRON_WINDOWS_SIGNING_BUILDER_DIAGNOSTIC";
// Captured stdout and stderr have no trustworthy shared chronology. `stage`
// is therefore a fixed diagnostic hint, never a claim about final builder state.
const BUILDER_DIAGNOSTIC_STAGE_MARKER = /TIBOTATTLE_ELECTRON_BUILDER_STAGE=(OUTER_PWSH_LOOKUP|MODULE_INSTALL|MODULE_IMPORT)/gu;
const BUILDER_DIAGNOSTIC_VENDOR_CODE_PATTERN = /\b(ENOENT|EACCES|EPERM|ENOSPC|ETIMEDOUT)\b/giu;
const BUILDER_DIAGNOSTIC_MARKERS = Object.freeze([
  Object.freeze({
    key: "outerPwshLookup",
    pattern: /Get-Command\s+pwsh\.exe|identified\s+pwsh\.exe|falling\s+back\s+to\s+powershell\.exe/giu,
    stage: "outer_pwsh_lookup",
  }),
  Object.freeze({
    key: "moduleInstall",
    pattern: /Install-PackageProvider|Install-Module\s+-Name\s+TrustedSigning|PackageProvider\s+NuGet/giu,
    stage: "module_install",
  }),
  Object.freeze({
    key: "moduleImport",
    pattern: /Import-Module\s+-Name\s+TrustedSigning|Get-Command\s+-Name\s+Invoke-TrustedSigning|module\s+(?:was|is)\s+not\s+(?:loaded|found)/giu,
    stage: "module_import",
  }),
  Object.freeze({
    key: "commandSerialization",
    pattern: /positional\s+parameter|parameter\s+cannot\s+be\s+found|argument\s+transformation|SwitchParameter/giu,
    stage: "command_serialization",
  }),
  Object.freeze({
    key: "packagingMetadata",
    pattern: /electron-builder\s+configuration|package\.json|\bnsis\b|artifactName|configuration\s+(?:is\s+)?invalid/giu,
    stage: "packaging_metadata",
  }),
  Object.freeze({
    key: "signer",
    pattern: /Invoke-TrustedSigning|Authenticode|code\s+signing|timestamp|Azure\s+(?:credential|trusted)|AADSTS/giu,
    stage: "signer",
  }),
]);
const TRUSTED_SIGNING_SWITCH_PARAMETERS = Object.freeze([
  "ExcludeEnvironmentCredential",
  "ExcludeWorkloadIdentityCredential",
  "ExcludeManagedIdentityCredential",
  "ExcludeSharedTokenCacheCredential",
  "ExcludeVisualStudioCredential",
  "ExcludeVisualStudioCodeCredential",
  "ExcludeAzureCliCredential",
  "ExcludeAzurePowerShellCredential",
  "ExcludeAzureDeveloperCliCredential",
  "ExcludeInteractiveBrowserCredential",
]);
const TRUSTED_SIGNING_SWITCH_PARAMETER_LIST = TRUSTED_SIGNING_SWITCH_PARAMETERS
  .map((name) => `'${name}'`)
  .join(", ");
const BUILDER_HOST_MODULE_READY_MARKER = "TIBOTATTLE_ELECTRON_BUILDER_HOST_MODULE_READY";
const BUILDER_HOST_MODULE_PREFLIGHT_SCRIPT = [
  '"use strict";',
  'const { createRequire } = require("node:module");',
  'const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));',
  'const appBuilderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib/package.json"));',
  'const { WindowsSignAzureManager } = appBuilderRequire("./out/codeSign/windowsSignAzureManager");',
  'const { VmManager } = appBuilderRequire("./out/vm/vm");',
  'const config = require("./apps/electron/electron-builder.release.config.cjs");',
  'const stage = value => process.stdout.write(`TIBOTATTLE_ELECTRON_BUILDER_STAGE=${value}\\n`);',
  'const vm = new VmManager();',
  'const execute = vm.exec.bind(vm);',
  'vm.exec = async (...arguments_) => {',
  '  const command = Array.isArray(arguments_[1]) ? arguments_[1].at(-1) : "";',
  '  if (command === "Get-Command pwsh.exe") stage("OUTER_PWSH_LOOKUP");',
  '  else if (command.includes("Install-PackageProvider") || command.includes("Install-Module -Name TrustedSigning")) stage("MODULE_INSTALL");',
  '  else if (command.includes("Import-Module -Name TrustedSigning") || command.includes("Get-Command -Name Invoke-TrustedSigning")) stage("MODULE_IMPORT");',
  '  return execute(...arguments_);',
  '};',
  'const manager = new WindowsSignAzureManager({',
  '  platformSpecificBuildOptions: { azureSignOptions: config.win.azureSignOptions },',
  '  vm: { value: Promise.resolve(vm) },',
  '});',
  '(async () => {',
  '  await manager.initialize();',
  '  const powershell = await vm.powershellCommand.value;',
  '  await vm.exec(powershell, [',
  '    "-NoProfile", "-NonInteractive", "-Command",',
  `    "$ErrorActionPreference = 'Stop'; Import-Module -Name TrustedSigning -RequiredVersion 0.5.0 -Force -ErrorAction Stop; $command = Get-Command -Name Invoke-TrustedSigning -ErrorAction Stop; $expected = @(${TRUSTED_SIGNING_SWITCH_PARAMETER_LIST}); foreach ($name in $expected) { if ($null -eq $command.Parameters[$name] -or $command.Parameters[$name].ParameterType.FullName -ne 'System.Management.Automation.SwitchParameter') { throw 'TIBOTATTLE_TRUSTED_SIGNING_SWITCH_CONTRACT_INVALID' } } [Console]::Out.Write('TIBOTATTLE_ELECTRON_BUILDER_HOST_MODULE_READY')",`,
  '  ]);',
  `  process.stdout.write("${BUILDER_HOST_MODULE_READY_MARKER}\\n");`,
  '})().catch(() => { process.exitCode = 1; });',
].join("\n");

function failure(code, { diagnostic = null, encryptedDiagnostic = null } = {}) {
  const error = new Error(`ELECTRON_WINDOWS_SIGNING_${code}`);
  error.code = error.message;
  if (diagnostic !== null) error.diagnostic = diagnostic;
  if (encryptedDiagnostic !== null) error.encryptedDiagnostic = encryptedDiagnostic;
  return error;
}

function fail(code) {
  throw failure(code);
}

function safeString(value, maximum = 512) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function canonicalBase64(value, maximum = MAXIMUM_ENCRYPTED_DIAGNOSTIC_KEY_BYTES * 2) {
  if (!safeString(value, maximum) || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MAXIMUM_ENCRYPTED_DIAGNOSTIC_KEY_BYTES
      && bytes.toString("base64") === value
    ? bytes : null;
}

function encryptedBuilderDiagnosticBinding(candidate) {
  return Object.freeze({
    buildNumber: candidate.buildNumber,
    candidateSha256: candidate.sha256,
    sourceRevision: candidate.sourceRevision,
    target: candidate.target,
  });
}

function encryptedBuilderDiagnosticAuthenticatedData(binding) {
  return Buffer.from(JSON.stringify({
    binding,
    schemaVersion: ENCRYPTED_BUILDER_DIAGNOSTIC_SCHEMA,
  }), "utf8");
}

function encryptedBuilderDiagnosticContext(candidate, environment) {
  const keyBytes = canonicalBase64(environment?.[ENCRYPTED_BUILDER_DIAGNOSTIC_PUBLIC_KEY_BASE64_ENV]);
  const expectedDigest = environment?.[ENCRYPTED_BUILDER_DIAGNOSTIC_PUBLIC_KEY_SHA256_ENV];
  if (keyBytes === null || !SHA256.test(expectedDigest ?? "")) {
    fail("ENCRYPTED_BUILDER_DIAGNOSTIC_KEY_INVALID");
  }
  const pem = keyBytes.toString("utf8");
  if (!RSA_PUBLIC_KEY_PEM.test(pem)) fail("ENCRYPTED_BUILDER_DIAGNOSTIC_KEY_INVALID");
  const keyDigest = createHash("sha256").update(keyBytes).digest("hex");
  if (keyDigest !== expectedDigest) fail("ENCRYPTED_BUILDER_DIAGNOSTIC_KEY_INVALID");
  let key;
  try {
    key = createPublicKey(keyBytes);
  } catch {
    fail("ENCRYPTED_BUILDER_DIAGNOSTIC_KEY_INVALID");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "rsa"
      || key.asymmetricKeyDetails?.modulusLength !== 4096) {
    fail("ENCRYPTED_BUILDER_DIAGNOSTIC_KEY_INVALID");
  }
  return Object.freeze({
    binding: encryptedBuilderDiagnosticBinding(candidate),
    key,
    keyDigest,
  });
}

function canonicalCandidateReceiptPath(repositoryRoot) {
  return join(
    repositoryRoot,
    ".release-build",
    "electron-production",
    "win32-x64",
    CANDIDATE_RECEIPT_LEAF,
  );
}

function relativeRepositoryPath(repositoryRoot, value) {
  const selected = relative(repositoryRoot, value);
  if (selected === "" || selected === ".." || selected.startsWith(`..${sep}`)
      || selected.startsWith("../") || selected.startsWith("..\\")) {
    fail("CANDIDATE_PATH_INVALID");
  }
  return selected.split(sep).join("/");
}

async function assertNoSymbolicLinkPathComponents(repositoryRoot, value) {
  const relativePath = relativeRepositoryPath(repositoryRoot, value);
  let current = repositoryRoot;
  let rootMetadata;
  try {
    rootMetadata = await lstat(current);
  } catch {
    fail("CANDIDATE_PATH_INVALID");
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("CANDIDATE_PATH_INVALID");
  }
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch {
      fail("CANDIDATE_PATH_INVALID");
    }
    if (metadata.isSymbolicLink()) fail("CANDIDATE_PATH_INVALID");
  }
}

async function readBoundedCandidate(repositoryRoot, path) {
  await assertNoSymbolicLinkPathComponents(repositoryRoot, path);
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail("CANDIDATE_UNAVAILABLE");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || !Number.isSafeInteger(before.size) || before.size < 1
      || before.size > MAXIMUM_CANDIDATE_BYTES) {
    fail("CANDIDATE_UNAVAILABLE");
  }
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail("CANDIDATE_UNAVAILABLE");
  }
  let after;
  try {
    after = await lstat(path);
  } catch {
    fail("CANDIDATE_UNAVAILABLE");
  }
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.nlink !== after.nlink
      || bytes.byteLength !== before.size) {
    fail("CANDIDATE_CHANGED");
  }
  return bytes;
}

function parseCanonicalCandidate(bytes) {
  let candidate;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CANDIDATE_INVALID");
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)
      || candidate.schemaVersion !== CANDIDATE_SCHEMA
      || candidate.target !== "win32-x64"
      || !SOURCE_REVISION.test(candidate.sourceRevision)
      || !BUILD_NUMBER.test(candidate.buildNumber)
      || !VERSION.test(candidate.version)) {
    fail("CANDIDATE_INVALID");
  }
  let expected;
  try {
    expected = {
      ...productionElectronCandidatePlan({
        target: "win32-x64",
        sourceRevision: candidate.sourceRevision,
        buildNumber: candidate.buildNumber,
        hostPlatform: "win32",
        hostArchitecture: "x64",
      }),
      status: "production_source_staged",
      stagedManifest: "app/package.json",
      runtimeManifest: "app/electron-runtime-manifest.json",
    };
  } catch {
    fail("CANDIDATE_INVALID");
  }
  if (!isDeepStrictEqual(candidate, expected)) fail("CANDIDATE_INVALID");
  return Object.freeze({
    buildNumber: candidate.buildNumber,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceRevision: candidate.sourceRevision,
    target: candidate.target,
    updateFeed: candidate.updateFeed,
    version: candidate.version,
  });
}

function resourceEnvironmentPresent(environment) {
  return AZURE_RESOURCE_ENVIRONMENT.every((name) => safeString(environment?.[name], 256));
}

function trustedAzureCliConfigurationDirectory(environment) {
  const value = environment?.AZURE_CONFIG_DIR;
  if (!safeString(value, 32 * 1024)) return null;
  const normalized = win32.normalize(value);
  if (!win32.isAbsolute(normalized)) return null;
  const canonical = normalized.replace(/[\\/]+$/u, "").toLowerCase();
  if (canonical !== GITHUB_HOSTED_AZURE_CLI_CONFIGURATION_DIRECTORY.toLowerCase()) return null;
  return GITHUB_HOSTED_AZURE_CLI_CONFIGURATION_DIRECTORY;
}

function createBuilderEnvironment({ candidatePath, candidate, environment }) {
  const selected = {};
  for (const name of SYSTEM_ENVIRONMENT_ALLOWLIST) {
    if (safeString(environment?.[name], 32 * 1024)) selected[name] = environment[name];
  }
  for (const name of AZURE_RESOURCE_ENVIRONMENT) {
    if (safeString(environment?.[name], 256)) selected[name] = environment[name];
  }
  const azureCliConfigurationDirectory = trustedAzureCliConfigurationDirectory(environment);
  if (azureCliConfigurationDirectory !== null) {
    selected.AZURE_CONFIG_DIR = azureCliConfigurationDirectory;
  }
  Object.assign(selected, {
    TIBOTATTLE_ELECTRON_BUILD_NUMBER: candidate.buildNumber,
    TIBOTATTLE_ELECTRON_SIGNING_MODE: "azure-trusted-signing",
    TIBOTATTLE_ELECTRON_SOURCE_REVISION: candidate.sourceRevision,
    TIBOTATTLE_ELECTRON_TARGET: "win32-x64",
    TIBOTATTLE_ELECTRON_VERSION: candidate.version,
    TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_RECEIPT: candidatePath,
    TIBOTATTLE_ELECTRON_WINDOWS_SOURCE_CANDIDATE_SHA256: candidate.sha256,
  });
  return Object.freeze(selected);
}

function defaultRun(command, arguments_, { environment, captureOutput = false } = {}) {
  return spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: "utf8",
    maxBuffer: captureOutput ? MAXIMUM_CAPTURED_PROCESS_OUTPUT_BYTES : undefined,
    stdio: ["ignore", captureOutput ? "pipe" : "ignore", captureOutput ? "pipe" : "ignore"],
    windowsHide: true,
  });
}

function successful(result) {
  return result !== null && typeof result === "object"
    && result.error === undefined && result.status === 0 && result.signal === null;
}

function fixedWindowsCommandInterpreter(environment) {
  const systemRoot = environment?.SystemRoot;
  if (!safeString(systemRoot, 32 * 1024) || !win32.isAbsolute(systemRoot)) return null;
  return win32.join(systemRoot, "System32", "cmd.exe");
}

function azureCliAccountShowInvocation(environment) {
  const command = fixedWindowsCommandInterpreter(environment);
  if (command === null) return null;
  return Object.freeze({
    command,
    arguments: Object.freeze(["/d", "/s", "/c", AZURE_CLI_ACCOUNT_SHOW_COMMAND]),
  });
}

function capturedText(result) {
  if (result === null || typeof result !== "object") return "";
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.length <= MAXIMUM_CAPTURED_PROCESS_OUTPUT_BYTES)
    .join("\n");
}

function boundedBuilderFailurePayload(result) {
  const header = Buffer.from("tibotattle-electron-windows-builder-output-v1\nstdout:\n", "utf8");
  const separator = Buffer.from("\nstderr:\n", "utf8");
  const sectionBytes = Math.floor((MAXIMUM_CAPTURED_PROCESS_OUTPUT_BYTES
    - header.byteLength - separator.byteLength) / 2);
  const stdout = boundedBuilderOutputTail(result?.stdout, sectionBytes);
  const stderr = boundedBuilderOutputTail(result?.stderr, sectionBytes);
  try {
    return Buffer.concat([header, stdout, separator, stderr]);
  } finally {
    stdout.fill(0);
    stderr.fill(0);
  }
}

function boundedBuilderOutputTail(value, maximum) {
  const marker = Buffer.from("[tibotattle-builder-output-truncated]\n", "utf8");
  if (typeof value !== "string" || maximum < marker.byteLength) return Buffer.alloc(0);
  // spawnSync bounds normal captured output. Clamp injected or malformed
  // results as well, then retain the tail where builder errors are emitted.
  const source = value.length > MAXIMUM_CAPTURED_PROCESS_OUTPUT_BYTES
    ? value.slice(-MAXIMUM_CAPTURED_PROCESS_OUTPUT_BYTES) : value;
  const bytes = Buffer.from(source, "utf8");
  try {
    if (bytes.byteLength <= maximum) return Buffer.from(bytes);
    return Buffer.concat([
      marker,
      bytes.subarray(bytes.byteLength - (maximum - marker.byteLength)),
    ]);
  } finally {
    bytes.fill(0);
  }
}

function sealEncryptedBuilderDiagnostic(context, result) {
  const aes = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = boundedBuilderFailurePayload(result);
  const authenticatedData = encryptedBuilderDiagnosticAuthenticatedData(context.binding);
  try {
    const cipher = createCipheriv("aes-256-gcm", aes, iv);
    cipher.setAAD(authenticatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Object.freeze({
      binding: context.binding,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      publicKeySha256: context.keyDigest,
      schemaVersion: ENCRYPTED_BUILDER_DIAGNOSTIC_SCHEMA,
      tag: cipher.getAuthTag().toString("base64"),
      wrappedKey: publicEncrypt({ key: context.key, oaepHash: "sha256" }, aes).toString("base64"),
    });
  } finally {
    aes.fill(0);
    plaintext.fill(0);
    authenticatedData.fill(0);
  }
}

async function writeEncryptedBuilderDiagnostic({ candidateReceiptPath, diagnosticContext,
  repositoryRoot, result }) {
  const candidateRoot = dirname(candidateReceiptPath);
  const evidenceRoot = join(candidateRoot, "evidence");
  const envelopePath = join(evidenceRoot, ENCRYPTED_BUILDER_DIAGNOSTIC_LEAF);
  try {
    await mkdir(evidenceRoot, { mode: 0o700, recursive: true });
    await assertNoSymbolicLinkPathComponents(repositoryRoot, evidenceRoot);
    const evidenceMetadata = await lstat(evidenceRoot);
    if (!evidenceMetadata.isDirectory() || evidenceMetadata.isSymbolicLink()) {
      fail("ENCRYPTED_BUILDER_DIAGNOSTIC_WRITE_FAILED");
    }
  } catch (error) {
    if (error?.code === "ELECTRON_WINDOWS_SIGNING_ENCRYPTED_BUILDER_DIAGNOSTIC_WRITE_FAILED") throw error;
    fail("ENCRYPTED_BUILDER_DIAGNOSTIC_WRITE_FAILED");
  }
  const envelope = Buffer.from(`${JSON.stringify(sealEncryptedBuilderDiagnostic(diagnosticContext, result))}\n`, "utf8");
  let handle;
  let created = false;
  let writeFailure = null;
  try {
    handle = await open(envelopePath, "wx", 0o600);
    created = true;
    await handle.writeFile(envelope);
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== envelope.byteLength) {
      fail("ENCRYPTED_BUILDER_DIAGNOSTIC_WRITE_FAILED");
    }
  } catch (error) {
    writeFailure = error;
  } finally {
    envelope.fill(0);
    if (handle !== undefined) {
      try { await handle.close(); } catch (error) { writeFailure ??= error; }
    }
  }
  if (writeFailure !== null) {
    if (created) {
      try { await unlink(envelopePath); } catch {}
    }
    fail("ENCRYPTED_BUILDER_DIAGNOSTIC_WRITE_FAILED");
  }
  return "written";
}

function finalMatchIndex(pattern, text) {
  pattern.lastIndex = 0;
  let finalIndex = -1;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    finalIndex = match.index;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return finalIndex;
}

function builderDiagnosticStage(text) {
  const markerStages = new Map([
    ["OUTER_PWSH_LOOKUP", "outer_pwsh_lookup"],
    ["MODULE_INSTALL", "module_install"],
    ["MODULE_IMPORT", "module_import"],
  ]);
  const stages = [];
  let marker;
  BUILDER_DIAGNOSTIC_STAGE_MARKER.lastIndex = 0;
  while ((marker = BUILDER_DIAGNOSTIC_STAGE_MARKER.exec(text)) !== null) {
    stages.push({ index: marker.index, stage: markerStages.get(marker[1]) });
  }
  BUILDER_DIAGNOSTIC_STAGE_MARKER.lastIndex = 0;
  for (const markerDefinition of BUILDER_DIAGNOSTIC_MARKERS) {
    const index = finalMatchIndex(markerDefinition.pattern, text);
    if (index >= 0) stages.push({ index, stage: markerDefinition.stage });
  }
  stages.sort((left, right) => left.index - right.index);
  return stages.at(-1)?.stage ?? "unknown";
}

function builderDiagnosticExit(result) {
  if (result === null || typeof result !== "object") return "invalid";
  if (result.error !== undefined) return "none";
  if (typeof result.signal === "string" && result.signal !== "") return "signal";
  if (Number.isInteger(result.status) && result.status >= 0 && result.status <= 255) {
    return `code_${result.status}`;
  }
  return "other";
}

function builderDiagnosticSpawn(result) {
  const code = typeof result?.error?.code === "string" ? result.error.code : "";
  if (code === "") return "none";
  if (code === "ENOENT") return "not_found";
  if (code === "EACCES") return "access_denied";
  if (code === "ENOBUFS") return "buffer_overflow";
  return "other";
}

function builderDiagnosticVendorCode(text) {
  let selected = "unknown";
  let match;
  BUILDER_DIAGNOSTIC_VENDOR_CODE_PATTERN.lastIndex = 0;
  while ((match = BUILDER_DIAGNOSTIC_VENDOR_CODE_PATTERN.exec(text)) !== null) {
    selected = match[1];
  }
  BUILDER_DIAGNOSTIC_VENDOR_CODE_PATTERN.lastIndex = 0;
  return selected;
}

function builderFailureDiagnostic(result) {
  const text = capturedText(result);
  const markers = {};
  for (const marker of BUILDER_DIAGNOSTIC_MARKERS) {
    markers[marker.key] = finalMatchIndex(marker.pattern, text) >= 0 ? "yes" : "no";
  }
  return [
    BUILDER_DIAGNOSTIC_PREFIX,
    `stage=${builderDiagnosticStage(text)}`,
    `exit=${builderDiagnosticExit(result)}`,
    `spawn=${builderDiagnosticSpawn(result)}`,
    `vendor_code=${builderDiagnosticVendorCode(text)}`,
    `outer_pwsh_lookup=${markers.outerPwshLookup}`,
    `module_install=${markers.moduleInstall}`,
    `module_import=${markers.moduleImport}`,
    `command_serialization=${markers.commandSerialization}`,
    `packaging_metadata=${markers.packagingMetadata}`,
    `signer=${markers.signer}`,
  ].join(";");
}

const BUILDER_DIAGNOSTIC_FORMAT = new RegExp(
  `^${BUILDER_DIAGNOSTIC_PREFIX};stage=(?:outer_pwsh_lookup|module_install|module_import|command_serialization|packaging_metadata|signer|unknown);exit=(?:none|signal|invalid|other|code_[0-9]{1,3});spawn=(?:none|not_found|access_denied|buffer_overflow|other);vendor_code=(?:ENOENT|EACCES|EPERM|ENOSPC|ETIMEDOUT|unknown);outer_pwsh_lookup=(?:yes|no);module_install=(?:yes|no);module_import=(?:yes|no);command_serialization=(?:yes|no);packaging_metadata=(?:yes|no);signer=(?:yes|no)$`,
  "u",
);

function isBuilderFailureDiagnostic(value) {
  return typeof value === "string" && BUILDER_DIAGNOSTIC_FORMAT.test(value);
}

function azureCliAccountShowFailure(result) {
  if (successful(result)) return null;
  if (result === null || typeof result !== "object") return "AZURE_CLI_ACCOUNT_SHOW_RESULT_UNAVAILABLE";
  const errorCode = typeof result.error?.code === "string" ? result.error.code : "";
  if (AZURE_CLI_LAUNCH_ERROR_CODES.has(errorCode)) return "AZURE_CLI_ACCOUNT_SHOW_LAUNCH_UNAVAILABLE";
  if (errorCode !== "") return "AZURE_CLI_ACCOUNT_SHOW_LAUNCH_FAILED";
  const output = capturedText(result);
  if (AZURE_CLI_COMMAND_OUTPUT.test(output)) return "AZURE_CLI_ACCOUNT_SHOW_LAUNCH_UNAVAILABLE";
  if (AZURE_CLI_AUTHENTICATION_OUTPUT.test(output)) return "AZURE_CLI_ACCOUNT_SHOW_AUTHENTICATION_UNAVAILABLE";
  if (AZURE_CLI_CONFIGURATION_OUTPUT.test(output)) return "AZURE_CLI_ACCOUNT_SHOW_CONFIGURATION_UNAVAILABLE";
  return "AZURE_CLI_ACCOUNT_SHOW_FAILED";
}

function hostEligible({ platform, architecture, version }) {
  return platform === "win32" && architecture === "x64" && version === REQUIRED_NODE_VERSION;
}

function configValidationArguments(configPath) {
  return ["-e", `require(${JSON.stringify(configPath)});`];
}

function candidateSummary(candidate) {
  return Object.freeze({
    buildNumber: candidate.buildNumber,
    sha256: candidate.sha256,
    sourceRevision: candidate.sourceRevision,
    target: candidate.target,
    version: candidate.version,
  });
}

function preflightReceipt({ candidate, configurationValid, eligible }) {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: configurationValid && eligible ? "preflight_ready" : "preflight_incomplete",
    scope: "no_signing_or_packaging_performed",
    candidate: candidateSummary(candidate),
    builderConfiguration: CONFIGURATION_RELATIVE_PATH,
    azureResourceConfiguration: configurationValid ? "validated" : "missing_or_invalid",
    host: eligible ? "windows_x64_node_26_2_0" : "windows_x64_node_26_2_0_required",
    nativeModuleFinalization: "not_performed",
    windowsRuntimeQualification: "required",
  });
}

/** Parse a no-write preflight, builder-host preparation, or protected signing invocation. */
export function parseElectronWindowsSigningArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  if (argv.length === 2 && argv[0] === "--candidate-receipt" && safeString(argv[1])) {
    return Object.freeze({ candidateReceiptPath: argv[1], prepareBuilderHost: false, sign: false });
  }
  if (argv.length === 3 && argv[0] === "--prepare-builder-host"
      && argv[1] === "--candidate-receipt" && safeString(argv[2])) {
    return Object.freeze({ candidateReceiptPath: argv[2], prepareBuilderHost: true, sign: false });
  }
  if (argv.length === 4 && argv[0] === "--sign"
      && argv[1] === "--confirm-azure-trusted-signing"
      && argv[2] === "--candidate-receipt" && safeString(argv[3])) {
    return Object.freeze({ candidateReceiptPath: argv[3], prepareBuilderHost: false, sign: true });
  }
  if (argv.length === 5 && argv[0] === "--sign"
      && argv[1] === "--confirm-azure-trusted-signing"
      && argv[2] === "--capture-encrypted-builder-diagnostic"
      && argv[3] === "--candidate-receipt" && safeString(argv[4])) {
    return Object.freeze({
      candidateReceiptPath: argv[4],
      captureEncryptedBuilderDiagnostic: true,
      prepareBuilderHost: false,
      sign: true,
    });
  }
  fail("ARGUMENT_INVALID");
}

/**
 * Validate the canonical source candidate without Azure, builder, signing, or
 * local writes.  If the non-secret resource selection is supplied, loading
 * the canonical builder config also validates it against the candidate.
 */
export async function preflightElectronWindowsSigning({ candidateReceiptPath } = {}, testOnly = {}) {
  const repositoryRoot = resolve(testOnly.repositoryRoot ?? REPOSITORY_ROOT);
  const expectedCandidatePath = canonicalCandidateReceiptPath(repositoryRoot);
  const selectedCandidatePath = typeof candidateReceiptPath === "string"
    ? resolve(candidateReceiptPath) : null;
  if (selectedCandidatePath !== expectedCandidatePath) fail("ARGUMENT_INVALID");
  const bytes = await readBoundedCandidate(repositoryRoot, selectedCandidatePath);
  const candidate = parseCanonicalCandidate(bytes);
  const environment = testOnly.environment ?? process.env;
  const builderEnvironment = createBuilderEnvironment({
    candidate,
    candidatePath: selectedCandidatePath,
    environment,
  });
  const configurationPath = resolve(repositoryRoot, CONFIGURATION_RELATIVE_PATH);
  const run = testOnly.run ?? defaultRun;
  const configurationValid = resourceEnvironmentPresent(environment)
    && successful(run(process.execPath, configValidationArguments(configurationPath), {
      environment: builderEnvironment,
    }));
  return preflightReceipt({
    candidate,
    configurationValid,
    eligible: hostEligible({
      platform: testOnly.platform ?? process.platform,
      architecture: testOnly.architecture ?? process.arch,
      version: testOnly.version ?? process.version,
    }),
  });
}

async function protectedSigningContext({ candidateReceiptPath,
  captureEncryptedBuilderDiagnostic = false } = {}, testOnly = {}) {
  const repositoryRoot = resolve(testOnly.repositoryRoot ?? REPOSITORY_ROOT);
  const expectedCandidatePath = canonicalCandidateReceiptPath(repositoryRoot);
  const selectedCandidatePath = typeof candidateReceiptPath === "string"
    ? resolve(candidateReceiptPath) : null;
  if (selectedCandidatePath !== expectedCandidatePath) fail("ARGUMENT_INVALID");
  const bytes = await readBoundedCandidate(repositoryRoot, selectedCandidatePath);
  const candidate = parseCanonicalCandidate(bytes);
  const environment = testOnly.environment ?? process.env;
  const run = testOnly.run ?? defaultRun;
  if (captureEncryptedBuilderDiagnostic !== false && captureEncryptedBuilderDiagnostic !== true) {
    fail("ARGUMENT_INVALID");
  }
  const diagnosticContext = captureEncryptedBuilderDiagnostic
    ? encryptedBuilderDiagnosticContext(candidate, environment) : null;
  if (!hostEligible({
    platform: testOnly.platform ?? process.platform,
    architecture: testOnly.architecture ?? process.arch,
    version: testOnly.version ?? process.version,
  }) || !resourceEnvironmentPresent(environment)) {
    fail("SIGNING_PREREQUISITES_UNAVAILABLE");
  }
  const builderEnvironment = createBuilderEnvironment({
    candidate,
    candidatePath: selectedCandidatePath,
    environment,
  });
  if (builderEnvironment.AZURE_CONFIG_DIR !== GITHUB_HOSTED_AZURE_CLI_CONFIGURATION_DIRECTORY) {
    fail("AZURE_CLI_CONFIG_DIRECTORY_UNAVAILABLE");
  }
  const configurationPath = resolve(repositoryRoot, CONFIGURATION_RELATIVE_PATH);
  if (!successful(run(process.execPath, configValidationArguments(configurationPath), {
    environment: builderEnvironment,
  }))) {
    fail("SIGNING_PREREQUISITES_UNAVAILABLE");
  }
  return Object.freeze({
    builderEnvironment,
    candidate,
    diagnosticContext,
    configurationPath,
    repositoryRoot,
    run,
    selectedCandidatePath,
  });
}

function builderHostModulePreflightResult({ builderEnvironment, run, testOnly }) {
  if (typeof testOnly.builderHostModulePreflight === "function") {
    return testOnly.builderHostModulePreflight({
      environment: builderEnvironment,
      script: BUILDER_HOST_MODULE_PREFLIGHT_SCRIPT,
    });
  }
  return run(process.execPath, ["-e", BUILDER_HOST_MODULE_PREFLIGHT_SCRIPT], {
    environment: builderEnvironment,
    captureOutput: true,
  });
}

/**
 * Prepare the exact electron-builder PowerShell host and TrustedSigning module
 * that later package signing will use. This intentionally permits only the
 * builder's module installation; it does not authenticate to Azure, sign, or
 * package an artifact.
 */
export async function prepareElectronWindowsBuilderHost({ candidateReceiptPath } = {}, testOnly = {}) {
  const context = await protectedSigningContext({ candidateReceiptPath }, testOnly);
  const result = await builderHostModulePreflightResult({
    builderEnvironment: context.builderEnvironment,
    run: context.run,
    testOnly,
  });
  if (!successful(result) || !capturedText(result).includes(BUILDER_HOST_MODULE_READY_MARKER)) {
    throw failure("BUILDER_HOST_MODULE_PREFLIGHT_FAILED", {
      diagnostic: builderFailureDiagnostic(result),
    });
  }
  return Object.freeze({
    schemaVersion: "tibotattle-electron-windows-builder-host-preflight-v1",
    status: "builder_host_module_ready",
    scope: "builder_dependency_initialization_only_no_azure_signing",
    candidate: candidateSummary(context.candidate),
    azureResourceConfiguration: "validated",
    builderConfiguration: CONFIGURATION_RELATIVE_PATH,
    builderHost: "electron_builder_vm_manager",
    trustedSigningModulePreflight: "required_version_0_5_0_import_switch_contract_verified",
    nativeModuleFinalization: "not_performed",
    signing: "not_performed",
    windowsRuntimeQualification: "required",
  });
}

function assertCleanFrozenSource(candidate, run) {
  const head = run("git", ["rev-parse", "--verify", "HEAD"], {
    environment: process.env, captureOutput: true,
  });
  if (!successful(head) || !safeString(head.stdout, 128)
      || head.stdout.trim() !== candidate.sourceRevision) {
    fail("SOURCE_REVISION_UNAVAILABLE");
  }
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    environment: process.env, captureOutput: true,
  });
  if (!successful(status) || typeof status.stdout !== "string" || status.stdout !== "") {
    fail("SOURCE_NOT_CLEAN");
  }
}

/**
 * Invoke only the canonical electron-builder signing/package pass.  This mode
 * is protected by two explicit flags and never publishes an updater feed.
 * Its result intentionally remains short of a final signed-candidate receipt:
 * the two unpacked native modules require later signature/rebinding evidence.
 */
export async function invokeElectronWindowsSigning({ candidateReceiptPath,
  captureEncryptedBuilderDiagnostic = false } = {}, testOnly = {}) {
  const context = await protectedSigningContext({
    candidateReceiptPath,
    captureEncryptedBuilderDiagnostic,
  }, testOnly);
  assertCleanFrozenSource(context.candidate, context.run);
  const azureCliInvocation = azureCliAccountShowInvocation(context.builderEnvironment);
  if (azureCliInvocation === null) fail("AZURE_CLI_ACCOUNT_SHOW_LAUNCH_UNAVAILABLE");
  const azureCliFailure = azureCliAccountShowFailure(context.run(
    azureCliInvocation.command,
    azureCliInvocation.arguments,
    { environment: context.builderEnvironment, captureOutput: true },
  ));
  if (azureCliFailure !== null) fail(azureCliFailure);
  const builderCli = testOnly.builderCli ?? REQUIRE.resolve("electron-builder/cli.js");
  if (!safeString(builderCli, 32 * 1024)) fail("BUILDER_UNAVAILABLE");
  const builderResult = context.run(process.execPath, [
    builderCli,
    "--config", context.configurationPath,
    "--win", "nsis", "--x64", "--publish", "never",
  ], { environment: context.builderEnvironment, captureOutput: true });
  if (!successful(builderResult)) {
    let encryptedDiagnostic = null;
    if (context.diagnosticContext !== null) {
      try {
        encryptedDiagnostic = await writeEncryptedBuilderDiagnostic({
          candidateReceiptPath: context.selectedCandidatePath,
          diagnosticContext: context.diagnosticContext,
          repositoryRoot: context.repositoryRoot,
          result: builderResult,
        });
      } catch {
        encryptedDiagnostic = "unavailable";
      }
    }
    throw failure("BUILDER_SIGNING_FAILED", {
      diagnostic: builderFailureDiagnostic(builderResult),
      encryptedDiagnostic,
    });
  }
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: "builder_signing_completed_pending_native_module_finalization",
    scope: "azure_trusted_signing_builder_pass_only",
    candidate: candidateSummary(context.candidate),
    nativeModuleFinalization: "required_before_signed_candidate_receipt",
    publishing: "not_performed",
    windowsRuntimeQualification: "required",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const options = parseElectronWindowsSigningArguments(process.argv.slice(2));
    const receipt = options.sign
      ? await invokeElectronWindowsSigning(options)
      : options.prepareBuilderHost
        ? await prepareElectronWindowsBuilderHost(options)
        : await preflightElectronWindowsSigning(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${/^ELECTRON_WINDOWS_SIGNING_[A-Z_]+$/u.test(error?.code ?? "")
      ? error.code : "ELECTRON_WINDOWS_SIGNING_FAILED"}\n`);
    if (isBuilderFailureDiagnostic(error?.diagnostic)) {
      process.stderr.write(`${error.diagnostic}\n`);
    }
    if (error?.encryptedDiagnostic === "written") {
      process.stderr.write("ELECTRON_WINDOWS_SIGNING_BUILDER_ENCRYPTED_DIAGNOSTIC_WRITTEN\n");
    } else if (error?.encryptedDiagnostic === "unavailable") {
      process.stderr.write("ELECTRON_WINDOWS_SIGNING_BUILDER_ENCRYPTED_DIAGNOSTIC_UNAVAILABLE\n");
    }
    process.exitCode = 1;
  }
}
