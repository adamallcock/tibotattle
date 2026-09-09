#!/usr/bin/env node

/**
 * Prepare or explicitly invoke the reviewed Windows Azure signing builder.
 *
 * The default mode only validates the canonical source candidate and reports
 * whether the local Windows signing prerequisites are present.  It never
 * contacts Azure, invokes electron-builder, signs a file, publishes a feed,
 * or writes a receipt.  The separate `--sign` mode is deliberately explicit
 * and always supplies electron-builder with `--publish never`.
 *
 * This is not a production-credential or native-module qualification
 * finalizer.  The Windows runtime remains `required` until a later reviewed
 * native-module signature/rebinding and installed-artifact qualification
 * operation produces its own evidence.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
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
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const BUILD_NUMBER = /^[1-9][0-9]{0,9}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const REQUIRED_NODE_VERSION = "v26.2.0";

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

function failure(code) {
  const error = new Error(`ELECTRON_WINDOWS_SIGNING_${code}`);
  error.code = error.message;
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

function createBuilderEnvironment({ candidatePath, candidate, environment }) {
  const selected = {};
  for (const name of SYSTEM_ENVIRONMENT_ALLOWLIST) {
    if (safeString(environment?.[name], 32 * 1024)) selected[name] = environment[name];
  }
  for (const name of AZURE_RESOURCE_ENVIRONMENT) {
    if (safeString(environment?.[name], 256)) selected[name] = environment[name];
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

function defaultRun(command, arguments_, { environment } = {}) {
  return spawnSync(command, arguments_, {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function successful(result) {
  return result !== null && typeof result === "object"
    && result.error === undefined && result.status === 0 && result.signal === null;
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

/** Parse a no-write preflight or explicit protected signing invocation. */
export function parseElectronWindowsSigningArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  if (argv.length === 2 && argv[0] === "--candidate-receipt" && safeString(argv[1])) {
    return Object.freeze({ candidateReceiptPath: argv[1], sign: false });
  }
  if (argv.length === 4 && argv[0] === "--sign"
      && argv[1] === "--confirm-azure-trusted-signing"
      && argv[2] === "--candidate-receipt" && safeString(argv[3])) {
    return Object.freeze({ candidateReceiptPath: argv[3], sign: true });
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

function assertCleanFrozenSource(candidate, run) {
  const head = run("git", ["rev-parse", "--verify", "HEAD"], { environment: process.env });
  if (!successful(head) || !safeString(head.stdout, 128)
      || head.stdout.trim() !== candidate.sourceRevision) {
    fail("SOURCE_REVISION_UNAVAILABLE");
  }
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    environment: process.env,
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
export async function invokeElectronWindowsSigning({ candidateReceiptPath } = {}, testOnly = {}) {
  const repositoryRoot = resolve(testOnly.repositoryRoot ?? REPOSITORY_ROOT);
  const expectedCandidatePath = canonicalCandidateReceiptPath(repositoryRoot);
  const selectedCandidatePath = typeof candidateReceiptPath === "string"
    ? resolve(candidateReceiptPath) : null;
  if (selectedCandidatePath !== expectedCandidatePath) fail("ARGUMENT_INVALID");
  const bytes = await readBoundedCandidate(repositoryRoot, selectedCandidatePath);
  const candidate = parseCanonicalCandidate(bytes);
  const environment = testOnly.environment ?? process.env;
  const run = testOnly.run ?? defaultRun;
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
  const configurationPath = resolve(repositoryRoot, CONFIGURATION_RELATIVE_PATH);
  if (!successful(run(process.execPath, configValidationArguments(configurationPath), {
    environment: builderEnvironment,
  }))) {
    fail("SIGNING_PREREQUISITES_UNAVAILABLE");
  }
  assertCleanFrozenSource(candidate, run);
  if (!successful(run("az", ["account", "show", "--only-show-errors", "--output", "none"], {
    environment: builderEnvironment,
  }))) {
    fail("AZURE_CLI_AUTHENTICATION_UNAVAILABLE");
  }
  const builderCli = testOnly.builderCli ?? REQUIRE.resolve("electron-builder/cli.js");
  if (!safeString(builderCli, 32 * 1024)) fail("BUILDER_UNAVAILABLE");
  if (!successful(run(process.execPath, [
    builderCli,
    "--config", resolve(repositoryRoot, CONFIGURATION_RELATIVE_PATH),
    "--win", "nsis", "--x64", "--publish", "never",
  ], { environment: builderEnvironment }))) {
    fail("BUILDER_SIGNING_FAILED");
  }
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: "builder_signing_completed_pending_native_module_finalization",
    scope: "azure_trusted_signing_builder_pass_only",
    candidate: candidateSummary(candidate),
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
      : await preflightElectronWindowsSigning(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${/^ELECTRON_WINDOWS_SIGNING_[A-Z_]+$/u.test(error?.code ?? "")
      ? error.code : "ELECTRON_WINDOWS_SIGNING_FAILED"}\n`);
    process.exitCode = 1;
  }
}
