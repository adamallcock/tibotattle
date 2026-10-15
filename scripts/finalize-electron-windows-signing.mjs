#!/usr/bin/env node

/**
 * Read-only validation of a canonical Windows source candidate.
 *
 * The former builder-host preparation and builder signing modes are retired:
 * their dependency initialization and generated executables cannot share a
 * process boundary with signing credentials. A validated source candidate is
 * not evidence that the replacement isolated signing pipeline is ready.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const RECEIPT_SCHEMA = "tibotattle-electron-windows-signing-preflight-v1";
const CANDIDATE_SCHEMA = "tibotattle-electron-production-source-candidate-v1";
const CANDIDATE_RECEIPT_LEAF = "production-source-candidate.json";
const MAXIMUM_CANDIDATE_BYTES = 128 * 1024;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const BUILD_NUMBER = /^[1-9][0-9]{0,9}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const REQUIRED_NODE_VERSION = "v26.2.0";

function fail(code) {
  const error = new Error(`ELECTRON_WINDOWS_SIGNING_${code}`);
  error.code = error.message;
  throw error;
}

function safeString(value, maximum = 512) {
  return typeof value === "string" && value.length > 0
    && value.length <= maximum && !value.includes("\0");
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

function isCandidateFile(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
    && Number.isSafeInteger(metadata.size) && metadata.size > 0
    && metadata.size <= MAXIMUM_CANDIDATE_BYTES;
}

function sameFileState(left, right) {
  return ["dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs"]
    .every((field) => left[field] === right[field]);
}

async function readBoundedCandidate(repositoryRoot, path) {
  await assertNoSymbolicLinkPathComponents(repositoryRoot, path);
  let handle;
  try {
    const before = await lstat(path);
    if (!isCandidateFile(before)) fail("CANDIDATE_UNAVAILABLE");
    // A replacement with a FIFO must not block before fstat can reject it.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!isCandidateFile(opened) || !sameFileState(before, opened)) fail("CANDIDATE_CHANGED");
    // The allocation and reads remain bounded even if the file grows after stat.
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const linked = await lstat(path);
    await assertNoSymbolicLinkPathComponents(repositoryRoot, path);
    if (offset !== before.size || !isCandidateFile(after) || !isCandidateFile(linked)
        || !sameFileState(before, after) || !sameFileState(before, linked)) {
      fail("CANDIDATE_CHANGED");
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (/^ELECTRON_WINDOWS_SIGNING_/u.test(error?.code ?? "")) throw error;
    fail("CANDIDATE_UNAVAILABLE");
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

async function parseCanonicalCandidate(bytes) {
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
  const { productionElectronCandidatePlan } = await import("./package-electron-production.mjs");
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

/** Only the candidate inspection form remains supported. */
export function parseElectronWindowsSigningArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  // Retire legacy modes even when the rest of their arguments are malformed.
  if (argv.includes("--prepare-builder-host") || argv.includes("--sign")) {
    fail("LEGACY_BUILDER_SIGNING_RETIRED");
  }
  if (argv.length === 2 && argv[0] === "--candidate-receipt" && safeString(argv[1])) {
    return Object.freeze({ candidateReceiptPath: argv[1], prepareBuilderHost: false, sign: false });
  }
  fail("ARGUMENT_INVALID");
}

/** Validate source identity only; never load signing configuration or credentials. */
export async function preflightElectronWindowsSigning({ candidateReceiptPath } = {}, testOnly = {}) {
  const repositoryRoot = resolve(testOnly.repositoryRoot ?? REPOSITORY_ROOT);
  const expectedCandidatePath = canonicalCandidateReceiptPath(repositoryRoot);
  const selectedCandidatePath = safeString(candidateReceiptPath, 32 * 1024)
    ? resolve(candidateReceiptPath) : null;
  if (selectedCandidatePath !== expectedCandidatePath) fail("ARGUMENT_INVALID");
  const candidate = await parseCanonicalCandidate(
    await readBoundedCandidate(repositoryRoot, selectedCandidatePath),
  );
  const eligible = (testOnly.platform ?? process.platform) === "win32"
    && (testOnly.architecture ?? process.arch) === "x64"
    && (testOnly.version ?? process.version) === REQUIRED_NODE_VERSION;
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA,
    status: "candidate_validated_signing_pipeline_required",
    scope: "candidate_validation_only_no_signing_or_packaging_performed",
    candidate: Object.freeze({
      buildNumber: candidate.buildNumber,
      sha256: candidate.sha256,
      sourceRevision: candidate.sourceRevision,
      target: candidate.target,
      version: candidate.version,
    }),
    signingPipeline: "isolated_signing_pipeline_required",
    azureResourceConfiguration: "not_evaluated",
    host: eligible ? "windows_x64_node_26_2_0" : "windows_x64_node_26_2_0_required",
    nativeModuleFinalization: "not_performed",
    windowsRuntimeQualification: "required",
  });
}

// Compatibility entrypoints refuse before reading arguments, dependencies,
// candidate files, configuration, credentials, or preparing any local state.
export async function prepareElectronWindowsBuilderHost() {
  fail("LEGACY_BUILDER_SIGNING_RETIRED");
}

export async function invokeElectronWindowsSigning() {
  fail("LEGACY_BUILDER_SIGNING_RETIRED");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const options = parseElectronWindowsSigningArguments(process.argv.slice(2));
    const receipt = await preflightElectronWindowsSigning(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${/^ELECTRON_WINDOWS_SIGNING_[A-Z_]+$/u.test(error?.code ?? "")
      ? error.code : "ELECTRON_WINDOWS_SIGNING_FAILED"}\n`);
    process.exitCode = 1;
  }
}
