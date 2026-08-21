#!/usr/bin/env node

/**
 * Pre-sign the two fixed Windows native modules before electron-builder runs.
 *
 * This is deliberately a narrow finalizer primitive, not production authority.
 * Its caller must already have verified the v2 qualification handoff, runtime
 * inventory, filesystem sidecar, checkout version, and protected workflow
 * identity. The production runtime loader remains a separate gate.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { isProxy } from "node:util/types";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const WINDOWS_NATIVE_PRESIGN_SCHEMA =
  "tibotattle-windows-native-presign-v1";
export const WINDOWS_NATIVE_PRESIGN_STATUS = "WINDOWS_NATIVE_PRESIGN_PASSED";
export const WINDOWS_NATIVE_PRESIGN_TARGET = "win32-x64";
export const WINDOWS_NATIVE_PRESIGN_STAGING_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64/app",
);
export const WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64/evidence",
);
export const WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256 =
  "b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc";
export const WINDOWS_NATIVE_PRESIGN_MODULES = Object.freeze([
  Object.freeze({
    name: "windows-filesystem",
    packagedPath: "native/windows-filesystem/build/Release/windows_filesystem.node",
  }),
  Object.freeze({
    name: "keytar",
    packagedPath: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
  }),
]);
// TrustedSigning 0.5.0 exposes ten DefaultAzureCredential exclusion
// switches.  The protected OIDC finalizer deliberately enables every
// exclusion except ExcludeAzureCliCredential: azure/login establishes the
// approved service-principal session in the Azure CLI cache, while ambient
// environment, workload, developer, and interactive credentials remain out.
export const WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS =
  Object.freeze([
    "ExcludeEnvironmentCredential",
    "ExcludeWorkloadIdentityCredential",
    "ExcludeManagedIdentityCredential",
    "ExcludeSharedTokenCacheCredential",
    "ExcludeVisualStudioCredential",
    "ExcludeVisualStudioCodeCredential",
    "ExcludeAzurePowerShellCredential",
    "ExcludeAzureDeveloperCliCredential",
    "ExcludeInteractiveBrowserCredential",
  ]);
export const WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_CREDENTIAL_MODE =
  "azure-cli-only";
// These non-secret Azure resource values are fixed by the reviewed Artifact
// Signing handoff.  Keep the native primitive closed as well as the release
// config: a caller must not redirect a presign operation to another account,
// profile, endpoint, or publisher merely by satisfying the syntax checks.
export const WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY = Object.freeze({
  endpoint: "https://eus.codesigning.azure.net/",
  codeSigningAccountName: "tibotattlesigning",
  certificateProfileName: "tibotattle-windows-public",
  publisher: "Adam Allcock",
  timestampRfc3161: "http://timestamp.acs.microsoft.com",
});
export const WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY = Object.freeze({
  trustedSigningModuleVersion: "0.5.0",
  trustedSigningCredentialMode:
    WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_CREDENTIAL_MODE,
  excludedCredentials:
    WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS,
  requestedFileDigest: "SHA256",
  timestampRfc3161: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.timestampRfc3161,
  requestedTimestampDigest: "SHA256",
});

const MAXIMUM_NATIVE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_INPUT_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const ENDPOINT_HOST_PATTERN = /^[a-z0-9-]+\.codesigning\.azure\.net$/u;
const THUMBPRINT_PATTERN = /^[0-9a-f]{40}$/iu;
const INVALIDATION_MARKER = ".tibotattle-windows-native-presign-invalidated";

const OPTION_KEYS = Object.freeze([
  "stagingRoot",
  "revision",
  "packageVersion",
  "qualificationHandoffSha256",
  "filesystemBinding",
  "keytarSha256",
  "azure",
]);
const BINDING_KEYS = Object.freeze(["bytes", "sha256"]);
const AZURE_KEYS = Object.freeze([
  "endpoint",
  "codeSigningAccountName",
  "certificateProfileName",
  "publisher",
]);
const AUTHENTICODE_KEYS = Object.freeze([
  "status",
  "publisher",
  "signerThumbprint",
  "timestampPresent",
  "policy",
  "signtoolPaValid",
]);
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "target",
  "revision",
  "packageVersion",
  "qualificationHandoffSha256",
  "signingRequestPolicy",
  "modules",
]);
const SIGNING_REQUEST_POLICY_KEYS = Object.freeze([
  "trustedSigningModuleVersion",
  "trustedSigningCredentialMode",
  "excludedCredentials",
  "requestedFileDigest",
  "timestampRfc3161",
  "requestedTimestampDigest",
]);
const NATIVE_PRESIGN_MODULE_KEYS = Object.freeze([
  "name",
  "packagedPath",
  "unsignedBytes",
  "signedBytes",
  "unsignedSha256",
  "signedSha256",
  "authenticode",
]);
const EXPECTED_RECEIPT_BINDING_KEYS = Object.freeze([
  "revision",
  "packageVersion",
  "qualificationHandoffSha256",
  "filesystemBinding",
  "publisher",
]);

export const WINDOWS_NATIVE_PRESIGN_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_NATIVE_PRESIGN_INPUT_INVALID",
  platformRequired: "WINDOWS_NATIVE_PRESIGN_NATIVE_WINDOWS_REQUIRED",
  fileInvalid: "WINDOWS_NATIVE_PRESIGN_FILE_INVALID",
  unsignedMismatch: "WINDOWS_NATIVE_PRESIGN_UNSIGNED_MISMATCH",
  signingFailed: "WINDOWS_NATIVE_PRESIGN_SIGNING_FAILED",
  authenticodeInvalid: "WINDOWS_NATIVE_PRESIGN_AUTHENTICODE_INVALID",
  signedBytesInvalid: "WINDOWS_NATIVE_PRESIGN_SIGNED_BYTES_INVALID",
  outputExists: "WINDOWS_NATIVE_PRESIGN_OUTPUT_EXISTS",
  outputInvalid: "WINDOWS_NATIVE_PRESIGN_OUTPUT_INVALID",
  stagingInvalidated: "WINDOWS_NATIVE_PRESIGN_STAGING_INVALIDATED",
  passed: WINDOWS_NATIVE_PRESIGN_STATUS,
});

const KNOWN_STATUSES = new Set(Object.values(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS));

export class WindowsNativePresignError extends Error {
  constructor(code) {
    super("Windows native pre-sign failed");
    this.name = "WindowsNativePresignError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsNativePresignError(code);
}

function readRecord(value, keys, code = WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    fail(code);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readArray(
  value,
  expectedLength,
  code = WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid,
) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code);
  }
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code);
  }
  if (value.length !== expectedLength
      || ownKeys.length !== expectedLength + 1
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.value !== expectedLength
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined) {
    fail(code);
  }
  const result = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  if (ownKeys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail(code);
  }
  return result;
}

function assertString(value, pattern, maximumBytes = 512) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || !pattern.test(value)) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return value;
}

function assertPositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return value;
}

function assertAbsolutePath(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || resolve(value) !== value) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return value;
}

function assertEndpoint(value) {
  if (typeof value !== "string" || value.length > 256) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:"
        || endpoint.username !== ""
        || endpoint.password !== ""
        || endpoint.port !== ""
        || endpoint.pathname !== "/"
        || endpoint.search !== ""
        || endpoint.hash !== ""
        || !ENDPOINT_HOST_PATTERN.test(endpoint.hostname)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
  } catch (error) {
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return value;
}

function assertExactAzureIdentity(azure) {
  const endpoint = assertEndpoint(azure.endpoint);
  const codeSigningAccountName = assertString(
    azure.codeSigningAccountName,
    RESOURCE_PATTERN,
    128,
  );
  const certificateProfileName = assertString(
    azure.certificateProfileName,
    RESOURCE_PATTERN,
    128,
  );
  const publisher = assertString(azure.publisher, PUBLISHER_PATTERN, 256);
  if (endpoint !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.endpoint
      || codeSigningAccountName
        !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.codeSigningAccountName
      || certificateProfileName
        !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.certificateProfileName
      || publisher !== WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return Object.freeze({
    endpoint: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.endpoint,
    codeSigningAccountName:
      WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.codeSigningAccountName,
    certificateProfileName:
      WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.certificateProfileName,
    publisher: WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.publisher,
  });
}

export function validateWindowsNativePresignOptions(
  value,
  {
    expectedStagingRoot = WINDOWS_NATIVE_PRESIGN_STAGING_ROOT,
    expectedReceiptRoot = WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT,
  } = {},
) {
  const source = readRecord(value, OPTION_KEYS);
  const stagingRoot = assertAbsolutePath(source.stagingRoot);
  if (stagingRoot !== resolve(expectedStagingRoot)) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  const revision = assertString(source.revision, REVISION_PATTERN, 40);
  const receiptRoot = assertAbsolutePath(resolve(expectedReceiptRoot));
  const receiptRootRelative = relative(stagingRoot, receiptRoot);
  if (receiptRootRelative === ""
      || (!receiptRootRelative.startsWith("..") && !isAbsolute(receiptRootRelative))) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  const receiptPath = join(receiptRoot, `windows-native-presign-${revision}.json`);
  const binding = readRecord(source.filesystemBinding, BINDING_KEYS);
  const azure = readRecord(source.azure, AZURE_KEYS);
  const keytarSha256 = assertString(source.keytarSha256, SHA256_PATTERN, 64);
  if (keytarSha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return Object.freeze({
    stagingRoot,
    receiptPath,
    revision,
    packageVersion: assertString(source.packageVersion, VERSION_PATTERN, 32),
    qualificationHandoffSha256: assertString(
      source.qualificationHandoffSha256,
      SHA256_PATTERN,
      64,
    ),
    filesystemBinding: Object.freeze({
      bytes: assertPositiveInteger(binding.bytes),
      sha256: assertString(binding.sha256, SHA256_PATTERN, 64),
    }),
    keytarSha256,
    azure: assertExactAzureIdentity(azure),
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readOnlyFlags(platform = process.platform) {
  // Node does not expose a portable Windows no-follow open flag. On Windows,
  // the protected finalizer therefore relies on the trusted attempt-scoped
  // staging root plus lstat/open/fstat identity checks; native reparse-race
  // qualification remains mandatory before this is production evidence.
  return fsConstants.O_RDONLY
    | (platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
}

async function captureRegularFile(path, { platform = process.platform } = {}) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
  }
  if (!before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.size <= 0
      || before.size > MAXIMUM_NATIVE_BYTES) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
  }

  let handle;
  try {
    handle = await open(path, readOnlyFlags(platform));
    const opened = await handle.stat();
    if (!opened.isFile()
        || opened.nlink !== 1
        || opened.size !== before.size
        || !sameIdentity(before, opened)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAXIMUM_NATIVE_BYTES) {
        fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
      }
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (bytes !== opened.size
        || after.size !== opened.size
        || after.nlink !== 1
        || !sameIdentity(opened, after)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
    }
    return Object.freeze({
      bytes,
      sha256: hash.digest("hex"),
      identity: Object.freeze({ dev: opened.dev, ino: opened.ino }),
    });
  } catch (error) {
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildTrustedSigningPowerShellCommand(path, azure) {
  const selected = readRecord(azure, AZURE_KEYS);
  const exactIdentity = assertExactAzureIdentity(selected);
  const endpoint = exactIdentity.endpoint;
  const account = exactIdentity.codeSigningAccountName;
  const profile = exactIdentity.certificateProfileName;
  assertAbsolutePath(path);
  const credentialExclusionSwitches =
    WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS
      .map((name) => `-${name}`)
      .join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module TrustedSigning -RequiredVersion 0.5.0 -Force",
    [
      "Invoke-TrustedSigning",
      `-Endpoint ${powershellLiteral(endpoint)}`,
      `-CertificateProfileName ${powershellLiteral(profile)}`,
      `-CodeSigningAccountName ${powershellLiteral(account)}`,
      `-TimestampRfc3161 '${WINDOWS_NATIVE_PRESIGN_AZURE_IDENTITY.timestampRfc3161}'`,
      "-TimestampDigest 'SHA256'",
      "-FileDigest 'SHA256'",
      credentialExclusionSwitches,
      `-Files ${powershellLiteral(path)}`,
    ].join(" "),
  ].join("; ");
}

export function buildAuthenticodeProbeCommand(path) {
  const literal = powershellLiteral(path);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$signature = Get-AuthenticodeSignature -LiteralPath ${literal}`,
    "$publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)",
    `& signtool.exe verify /pa /all ${literal} *> $null`,
    "$signtoolValid = ($LASTEXITCODE -eq 0)",
    "[ordered]@{ status = $signature.Status.ToString(); publisher = $publisher; signerThumbprint = $signature.SignerCertificate.Thumbprint; timestampPresent = ($null -ne $signature.TimeStamperCertificate); policy = 'authenticode-pa'; signtoolPaValid = $signtoolValid } | ConvertTo-Json -Compress",
  ].join("; ");
}

function parseAuthenticodeProbe(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 4096) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
  try {
    return JSON.parse(stdout.replace(/^\uFEFF/u, "").trim());
  } catch {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
}

export function validateAuthenticodeAggregate(value, expectedPublisher) {
  // `publisher` is the certificate SimpleName returned by GetNameInfo, not
  // the full distinguished Subject. The latter is a separate activation fact
  // and is intentionally absent from this caller-controlled receipt input.
  const source = readRecord(
    value,
    AUTHENTICODE_KEYS,
    WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid,
  );
  if (source.status !== "Valid"
      || source.publisher !== expectedPublisher
      || typeof source.signerThumbprint !== "string"
      || !THUMBPRINT_PATTERN.test(source.signerThumbprint)
      || source.timestampPresent !== true
      || source.policy !== "authenticode-pa"
      || source.signtoolPaValid !== true) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
  return Object.freeze({
    status: "Valid",
    publisher: source.publisher,
    signerThumbprint: source.signerThumbprint.toLowerCase(),
    timestampPresent: true,
    policy: "authenticode-pa",
    signtoolPaValid: true,
  });
}

function runPowerShell(command, { capture = false } = {}) {
  const child = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-OutputFormat",
      "Text",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    },
  );
  if (child.error || child.status !== 0) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.signingFailed);
  }
  return capture ? child.stdout : "";
}

async function nativeSignAndProbe({ path, azure }) {
  runPowerShell(buildTrustedSigningPowerShellCommand(path, azure));
  return parseAuthenticodeProbe(runPowerShell(buildAuthenticodeProbeCommand(path), {
    capture: true,
  }));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function validateReceiptPolicy(value) {
  const policy = readRecord(value, SIGNING_REQUEST_POLICY_KEYS);
  const excludedCredentials = readArray(
    policy.excludedCredentials,
    WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS.length,
  );
  if (policy.trustedSigningModuleVersion
      !== WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.trustedSigningModuleVersion
      || policy.trustedSigningCredentialMode
        !== WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.trustedSigningCredentialMode
      || policy.requestedFileDigest
        !== WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.requestedFileDigest
      || policy.timestampRfc3161
        !== WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.timestampRfc3161
      || policy.requestedTimestampDigest
        !== WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.requestedTimestampDigest
      || excludedCredentials.some((name, index) =>
        name !== WINDOWS_NATIVE_PRESIGN_TRUSTEDSIGNING_EXCLUDED_CREDENTIALS[index])) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return Object.freeze({
    trustedSigningModuleVersion: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.trustedSigningModuleVersion,
    trustedSigningCredentialMode:
      WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.trustedSigningCredentialMode,
    excludedCredentials: Object.freeze([...excludedCredentials]),
    requestedFileDigest: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.requestedFileDigest,
    timestampRfc3161: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.timestampRfc3161,
    requestedTimestampDigest: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY.requestedTimestampDigest,
  });
}

function validateReceiptAuthenticode(value, expectedPublisher) {
  // Receipts bind the exact configured certificate SimpleName. A full Subject
  // DN is never accepted as a substitute for that display-name comparison.
  const source = readRecord(
    value,
    AUTHENTICODE_KEYS,
    WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid,
  );
  if (source.status !== "Valid"
      || source.timestampPresent !== true
      || source.policy !== "authenticode-pa"
      || source.signtoolPaValid !== true) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
  let publisher;
  try {
    publisher = assertString(source.publisher, PUBLISHER_PATTERN, 256);
  } catch {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
  if (expectedPublisher !== undefined && publisher !== expectedPublisher) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  let signerThumbprint;
  try {
    signerThumbprint = assertString(source.signerThumbprint, THUMBPRINT_PATTERN, 40);
  } catch {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
  const normalizedThumbprint = signerThumbprint.toLowerCase();
  if (signerThumbprint !== normalizedThumbprint) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }
  return Object.freeze({
    status: "Valid",
    publisher,
    signerThumbprint: normalizedThumbprint,
    timestampPresent: true,
    policy: "authenticode-pa",
    signtoolPaValid: true,
  });
}

function validateExpectedReceiptBinding(value) {
  if (value === undefined) return undefined;
  const expected = readRecord(value, EXPECTED_RECEIPT_BINDING_KEYS);
  const filesystemBinding = readRecord(expected.filesystemBinding, BINDING_KEYS);
  return Object.freeze({
    revision: assertString(expected.revision, REVISION_PATTERN, 40),
    packageVersion: assertString(expected.packageVersion, VERSION_PATTERN, 32),
    qualificationHandoffSha256: assertString(
      expected.qualificationHandoffSha256,
      SHA256_PATTERN,
      64,
    ),
    filesystemBinding: Object.freeze({
      bytes: assertPositiveInteger(filesystemBinding.bytes),
      sha256: assertString(filesystemBinding.sha256, SHA256_PATTERN, 64),
    }),
    publisher: assertString(expected.publisher, PUBLISHER_PATTERN, 256),
  });
}

/**
 * Validate one exact native pre-sign receipt and return a detached, deeply
 * frozen snapshot.  The optional expected binding is itself a closed object;
 * callers cannot smuggle a partial or diagnostic-rich expectation into this
 * contract, and all mismatches use the fixed content-free error surface.
 */
export function validateWindowsNativePresignReceipt(value, expectedBinding) {
  const expected = validateExpectedReceiptBinding(expectedBinding);
  const source = readRecord(value, RECEIPT_KEYS);
  if (source.schemaVersion !== WINDOWS_NATIVE_PRESIGN_SCHEMA
      || source.status !== WINDOWS_NATIVE_PRESIGN_STATUS
      || source.target !== WINDOWS_NATIVE_PRESIGN_TARGET) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  const revision = assertString(source.revision, REVISION_PATTERN, 40);
  const packageVersion = assertString(source.packageVersion, VERSION_PATTERN, 32);
  const qualificationHandoffSha256 = assertString(
    source.qualificationHandoffSha256,
    SHA256_PATTERN,
    64,
  );
  if (expected !== undefined
      && (revision !== expected.revision
        || packageVersion !== expected.packageVersion
        || qualificationHandoffSha256 !== expected.qualificationHandoffSha256)) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }

  const signingRequestPolicy = validateReceiptPolicy(source.signingRequestPolicy);
  const sourceModules = readArray(source.modules, WINDOWS_NATIVE_PRESIGN_MODULES.length);
  const modules = sourceModules.map((valueAtIndex, index) => {
    const module = readRecord(valueAtIndex, NATIVE_PRESIGN_MODULE_KEYS);
    const expectedModule = WINDOWS_NATIVE_PRESIGN_MODULES[index];
    if (module.name !== expectedModule.name || module.packagedPath !== expectedModule.packagedPath) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    const unsignedBytes = assertPositiveInteger(module.unsignedBytes);
    const signedBytes = assertPositiveInteger(module.signedBytes);
    const unsignedSha256 = assertString(module.unsignedSha256, SHA256_PATTERN, 64);
    const signedSha256 = assertString(module.signedSha256, SHA256_PATTERN, 64);
    if (unsignedSha256 === signedSha256) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    if (index === 1 && unsignedSha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    const authenticode = validateReceiptAuthenticode(
      module.authenticode,
      expected?.publisher,
    );
    return {
      name: expectedModule.name,
      packagedPath: expectedModule.packagedPath,
      unsignedBytes,
      signedBytes,
      unsignedSha256,
      signedSha256,
      authenticode,
    };
  });

  if (modules[0].authenticode.publisher !== modules[1].authenticode.publisher) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.authenticodeInvalid);
  }

  if (expected !== undefined
      && (modules[0].unsignedBytes !== expected.filesystemBinding.bytes
        || modules[0].unsignedSha256 !== expected.filesystemBinding.sha256)) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }

  return deepFreeze({
    schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_NATIVE_PRESIGN_TARGET,
    revision,
    packageVersion,
    qualificationHandoffSha256,
    signingRequestPolicy,
    modules,
  });
}

export function serializeWindowsNativePresignReceipt(value) {
  const selected = validateWindowsNativePresignReceipt(value);
  const serialized = `${JSON.stringify(stableValue(selected))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_INPUT_BYTES) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return serialized;
}

/** Parse only exact canonical JSON receipt bytes. */
export function parseWindowsNativePresignReceipt(value, expectedBinding) {
  if (typeof value !== "string"
      || value.length === 0
      || Buffer.byteLength(value, "utf8") > MAXIMUM_INPUT_BYTES) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  const selected = validateWindowsNativePresignReceipt(parsed, expectedBinding);
  if (value !== serializeWindowsNativePresignReceipt(selected)) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  }
  return selected;
}

export async function buildWindowsNativePresignReceipt(
  value,
  {
    platform = process.platform,
    expectedStagingRoot = WINDOWS_NATIVE_PRESIGN_STAGING_ROOT,
    signAndProbe,
    captureFile = captureRegularFile,
  } = {},
) {
  const options = validateWindowsNativePresignOptions(value, { expectedStagingRoot });
  const canonicalStagingRoot = await requireSafeStagingRoot(
    options.stagingRoot,
    platform,
  );
  const signer = signAndProbe ?? (platform === "win32" ? nativeSignAndProbe : null);
  if (typeof signer !== "function") {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.platformRequired);
  }

  const unsigned = [];
  for (const module of WINDOWS_NATIVE_PRESIGN_MODULES) {
    const logicalPath = join(options.stagingRoot, ...module.packagedPath.split("/"));
    const path = await resolveContainedNativeFile(logicalPath, canonicalStagingRoot);
    const captured = await captureFile(path, { platform });
    unsigned.push({ module, path, captured });
  }
  if (unsigned[0].captured.bytes !== options.filesystemBinding.bytes
      || unsigned[0].captured.sha256 !== options.filesystemBinding.sha256
      || unsigned[1].captured.sha256 !== WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.unsignedMismatch);
  }

  const modules = [];
  for (const entry of unsigned) {
    // Re-open and re-hash immediately before the irreversible signing call.
    // The first capture proves the whole unsigned pair before any mutation;
    // this second capture closes the inter-module TOCTOU window.
    const immediate = await captureFile(entry.path, { platform });
    if (!sameIdentity(entry.captured.identity, immediate.identity)
        || entry.captured.bytes !== immediate.bytes
        || entry.captured.sha256 !== immediate.sha256) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.unsignedMismatch);
    }
    let rawAggregate;
    try {
      rawAggregate = await signer({
        name: entry.module.name,
        path: entry.path,
        azure: options.azure,
        command: buildTrustedSigningPowerShellCommand(entry.path, options.azure),
      });
    } catch (error) {
      if (error instanceof WindowsNativePresignError) throw error;
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.signingFailed);
    }
    const authenticode = validateAuthenticodeAggregate(
      rawAggregate,
      options.azure.publisher,
    );
    const signed = await captureFile(entry.path, { platform });
    if (!sameIdentity(entry.captured.identity, signed.identity)
        || entry.captured.sha256 === signed.sha256) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.signedBytesInvalid);
    }
    modules.push({
      name: entry.module.name,
      packagedPath: entry.module.packagedPath,
      unsignedBytes: entry.captured.bytes,
      signedBytes: signed.bytes,
      unsignedSha256: entry.captured.sha256,
      signedSha256: signed.sha256,
      authenticode,
    });
  }

  return deepFreeze({
    schemaVersion: WINDOWS_NATIVE_PRESIGN_SCHEMA,
    status: WINDOWS_NATIVE_PRESIGN_STATUS,
    target: WINDOWS_NATIVE_PRESIGN_TARGET,
    revision: options.revision,
    packageVersion: options.packageVersion,
    qualificationHandoffSha256: options.qualificationHandoffSha256,
    signingRequestPolicy: WINDOWS_NATIVE_PRESIGN_REQUEST_POLICY,
    modules,
  });
}

function normalizedPathForComparison(value, platform = process.platform) {
  const selected = resolve(value);
  return platform === "win32" ? selected.toLowerCase() : selected;
}

async function requireSafeReceiptRoot(root, platform = process.platform) {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputInvalid);
    }
    const canonical = await realpath(root);
    if (normalizedPathForComparison(canonical, platform)
        !== normalizedPathForComparison(root, platform)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputInvalid);
    }
  } catch (error) {
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputInvalid);
  }
}

async function requireSafeStagingRoot(root, platform = process.platform) {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated);
    }
    const canonical = await realpath(root);
    if (normalizedPathForComparison(canonical, platform)
        !== normalizedPathForComparison(root, platform)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated);
    }
    return canonical;
  } catch (error) {
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated);
  }
}

async function resolveContainedNativeFile(logicalPath, canonicalStagingRoot) {
  try {
    const canonicalFile = await realpath(logicalPath);
    const selected = relative(canonicalStagingRoot, canonicalFile);
    if (selected === ""
        || selected.startsWith("..")
        || isAbsolute(selected)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
    }
    return canonicalFile;
  } catch (error) {
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.fileInvalid);
  }
}

async function requireReceiptPathAvailable(path) {
  for (const candidate of [path, `${path}.tmp`]) {
    try {
      await lstat(candidate);
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputExists);
    } catch (error) {
      if (error instanceof WindowsNativePresignError) throw error;
      if (error?.code !== "ENOENT") {
        fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputInvalid);
      }
    }
  }
}

export async function writeWindowsNativePresignReceipt(
  path,
  receipt,
  {
    expectedReceiptRoot = WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT,
    platform = process.platform,
  } = {},
) {
  const selectedReceipt = validateWindowsNativePresignReceipt(receipt);
  const root = resolve(expectedReceiptRoot);
  const expectedPath = join(root, `windows-native-presign-${selectedReceipt.revision}.json`);
  if (normalizedPathForComparison(path, platform)
      !== normalizedPathForComparison(expectedPath, platform)) {
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputInvalid);
  }
  await requireSafeReceiptRoot(root, platform);
  const serialized = serializeWindowsNativePresignReceipt(selectedReceipt);
  const temporaryPath = `${path}.tmp`;
  let handle;
  let temporaryCreated = false;
  let published = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, path);
    published = true;
    await unlink(temporaryPath);
    temporaryCreated = false;
  } catch (error) {
    if (error?.code === "EEXIST" && !published) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputExists);
    }
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryCreated && !published) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

async function invalidateAttemptStaging(stagingRoot) {
  const markerPath = join(stagingRoot, INVALIDATION_MARKER);
  let handle;
  try {
    handle = await open(markerPath, "wx", 0o600);
    await handle.writeFile("WINDOWS_NATIVE_PRESIGN_STAGING_INVALIDATED\n", "utf8");
    await handle.sync();
    return markerPath;
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated);
    }
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function runWindowsNativePresign(value, dependencies) {
  const options = validateWindowsNativePresignOptions(value, {
    expectedStagingRoot: dependencies?.expectedStagingRoot,
    expectedReceiptRoot: dependencies?.expectedReceiptRoot,
  });
  await requireSafeStagingRoot(options.stagingRoot, dependencies?.platform);
  await requireSafeReceiptRoot(
    resolve(dependencies?.expectedReceiptRoot ?? WINDOWS_NATIVE_PRESIGN_RECEIPT_ROOT),
    dependencies?.platform,
  );
  await requireReceiptPathAvailable(options.receiptPath);
  // The marker intentionally remains after every failed or interrupted run.
  // That makes a partly signed tree non-retryable: the finalizer must discard
  // and freshly materialize the entire attempt-scoped staging root.
  const markerPath = await invalidateAttemptStaging(options.stagingRoot);
  try {
    const receipt = await buildWindowsNativePresignReceipt(value, dependencies);
    await writeWindowsNativePresignReceipt(options.receiptPath, receipt, {
      expectedReceiptRoot: dependencies?.expectedReceiptRoot,
      platform: dependencies?.platform,
    });
    try {
      await unlink(markerPath);
    } catch {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.stagingInvalidated);
    }
    return receipt;
  } catch (error) {
    throw error;
  }
}

async function readBoundedInput(path) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile()
        || before.isSymbolicLink()
        || before.nlink !== 1
        || before.size <= 0
        || before.size > MAXIMUM_INPUT_BYTES) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    handle = await open(path, readOnlyFlags(process.platform));
    const opened = await handle.stat();
    if (!opened.isFile()
        || opened.nlink !== 1
        || opened.size !== before.size
        || !sameIdentity(before, opened)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAXIMUM_INPUT_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAXIMUM_INPUT_BYTES) {
        fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (bytes !== opened.size
        || after.size !== opened.size
        || after.nlink !== 1
        || !sameIdentity(opened, after)) {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } catch (error) {
    if (error instanceof WindowsNativePresignError) throw error;
    fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function fixedStatus(error) {
  return error instanceof WindowsNativePresignError && KNOWN_STATUSES.has(error.code)
    ? error.code
    : WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid;
}

async function main(argv) {
  try {
    if (process.platform !== "win32") {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.platformRequired);
    }
    if (argv.length !== 2 || argv[0] !== "--input") {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    const text = await readBoundedInput(resolve(argv[1]));
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      fail(WINDOWS_NATIVE_PRESIGN_FIXED_STATUS.inputInvalid);
    }
    await runWindowsNativePresign(input);
    process.stdout.write(`${WINDOWS_NATIVE_PRESIGN_STATUS}\n`);
  } catch (error) {
    process.stdout.write(`${fixedStatus(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main(process.argv.slice(2));
}
