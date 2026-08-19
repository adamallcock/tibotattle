#!/usr/bin/env node

/**
 * Local guard around the release SBOM action.
 *
 * Native platform finalizers call `prepare` before the pinned Syft release
 * writes the SBOM and `validate` immediately afterwards. Keeping these checks
 * local means the composite action needs no credentials or platform shell.
 * This module validates the artifact evidence boundary and reuses the
 * canonical SPDX-2.3 shape validator used by the release manifest. It does
 * not attempt to implement the complete SPDX specification.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  createWriteStream,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import { validateSpdxJson } from "./release-evidence.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export const SYFT_VERSION = "1.51.0";
export const SYFT_RELEASE_BASE_URL =
  "https://github.com/anchore/syft/releases/download/v1.51.0";
export const MAX_SBOM_BYTES = 16 * 1024 * 1024;
// Syft's official release archives are small, but the downloader must not
// allow a compromised or misconfigured endpoint to consume unbounded disk
// space before the pinned checksum is checked.  Keep this limit comfortably
// above the v1.51.0 assets while retaining a finite failure boundary.
export const MAX_SYFT_ARCHIVE_BYTES = 64 * 1024 * 1024;
const SBOM_READ_CHUNK_BYTES = 64 * 1024;
const SBOM_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

// These values are copied from Anchore's signed v1.51.0 release checksum
// manifest.  They are intentionally hardcoded: downloading a checksum file
// beside the binary would let a compromised release endpoint replace both.
// Keep this table in lockstep with the release asset names and update it only
// from the official release page/checksum manifest.
export const SYFT_RELEASE_ASSETS = Object.freeze({
  darwin_arm64: Object.freeze({
    fileName: "syft_1.51.0_darwin_arm64.tar.gz",
    sha256: "4f37f4c7fefce0a68e4cf71ba3f5f9829a99e65d89b29f7ee41b8c2c10ea8c59",
    archive: "tar.gz",
  }),
  darwin_x64: Object.freeze({
    fileName: "syft_1.51.0_darwin_amd64.tar.gz",
    sha256: "cddf9a044145caf0a1a3194d00d1dd51a1666f4814f2919cdb4768a0c062ad95",
    archive: "tar.gz",
  }),
  linux_arm64: Object.freeze({
    fileName: "syft_1.51.0_linux_arm64.tar.gz",
    sha256: "6c0466811541ea03add5213a60a1562f0851e4c0b0ecfdee1a694a9455285900",
    archive: "tar.gz",
  }),
  linux_x64: Object.freeze({
    fileName: "syft_1.51.0_linux_amd64.tar.gz",
    sha256: "2a2e837a2c8d59ec9af5472ee22d3b04ee463c4e44476ecf993fd1e5ab6ebc7f",
    archive: "tar.gz",
  }),
  win32_arm64: Object.freeze({
    fileName: "syft_1.51.0_windows_arm64.zip",
    sha256: "3fd075e644e67d1a9ae63fbc67991c510fc623030a67b93f5de9e2fd2da5d3c2",
    archive: "zip",
  }),
  win32_x64: Object.freeze({
    fileName: "syft_1.51.0_windows_amd64.zip",
    sha256: "fc5ffaeffb993576ece9c791da5a688fb2c8969a1479bbfe58583672c64da336",
    archive: "zip",
  }),
});

export class ReleaseSbomValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseSbomValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseSbomValidationError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function sha256File(path) {
  const hash = createHash("sha256");
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } catch (error) {
    fail("RELEASE_SBOM_OUTPUT_UNAVAILABLE", `unable to hash ${path}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return hash.digest("hex");
}

function requiredPath(value, label) {
  assert(typeof value === "string" && value.length > 0 && !value.includes("\0"),
    "RELEASE_SBOM_PATH_INVALID", `${label} is required`);
  return resolve(value);
}

function lstatIfPresent(path, label) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail("RELEASE_SBOM_PATH_UNAVAILABLE", `${label}: ${error.message}`);
  }
}

function assertScanDirectory(scanPath) {
  const selected = requiredPath(scanPath, "scan path");
  const metadata = lstatIfPresent(selected, "scan path");
  assert(metadata !== null && metadata.isDirectory() && !metadata.isSymbolicLink(),
    "RELEASE_SBOM_SCAN_PATH_INVALID",
    "scan path must be an existing regular directory, not a symlink");
  try {
    return realpathSync(selected);
  } catch (error) {
    fail("RELEASE_SBOM_SCAN_PATH_INVALID", `scan path cannot be canonicalized: ${error.message}`);
  }
}

function assertOutputAbsent(outputPath) {
  const metadata = lstatIfPresent(outputPath, "SBOM output path");
  assert(metadata === null, "RELEASE_SBOM_OUTPUT_EXISTS",
    "SBOM output path must not exist before generation; stale evidence is forbidden");
}

function assertOutputParent(outputPath) {
  const parent = dirname(outputPath);
  const metadata = lstatIfPresent(parent, "SBOM output directory");
  if (metadata === null) {
    mkdirSync(parent, { recursive: true });
  } else {
    assert(metadata.isDirectory() || metadata.isSymbolicLink(),
      "RELEASE_SBOM_OUTPUT_DIRECTORY_INVALID",
      "SBOM output directory must be a directory or directory symlink");
  }
  let first;
  let second;
  try {
    first = realpathSync(parent);
    second = realpathSync(parent);
  } catch (error) {
    fail("RELEASE_SBOM_OUTPUT_DIRECTORY_INVALID",
      `SBOM output directory cannot be canonicalized: ${error.message}`);
  }
  const resolvedMetadata = lstatIfPresent(first, "canonical SBOM output directory");
  assert(resolvedMetadata !== null && resolvedMetadata.isDirectory(),
    "RELEASE_SBOM_OUTPUT_DIRECTORY_INVALID",
    "canonical SBOM output parent must be a directory");
  assert(first === second, "RELEASE_SBOM_PATH_RACE",
    "SBOM output directory changed while it was being canonicalized");
  return first;
}

function canonicalOutputPath(outputPath, label = "SBOM output path") {
  const selected = requiredPath(outputPath, label);
  const parent = dirname(selected);
  const parentMetadata = lstatIfPresent(parent, "SBOM output directory");
  assert(parentMetadata !== null
      && (parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()),
    "RELEASE_SBOM_OUTPUT_DIRECTORY_INVALID",
    "SBOM output directory must be a directory or directory symlink");
  let first;
  let second;
  try {
    first = realpathSync(parent);
    second = realpathSync(parent);
  } catch (error) {
    fail("RELEASE_SBOM_OUTPUT_DIRECTORY_INVALID",
      `SBOM output directory cannot be canonicalized: ${error.message}`);
  }
  const resolvedMetadata = lstatIfPresent(first, "canonical SBOM output directory");
  assert(resolvedMetadata !== null && resolvedMetadata.isDirectory(),
    "RELEASE_SBOM_OUTPUT_DIRECTORY_INVALID",
    "canonical SBOM output parent must be a directory");
  assert(first === second, "RELEASE_SBOM_PATH_RACE",
    "SBOM output directory changed while it was being canonicalized");
  return join(first, basename(selected));
}

function pathWithin(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === ""
    || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function trustedOutputRoot(explicitRoot) {
  const selected = explicitRoot === undefined
    ? process.env.GITHUB_WORKSPACE
    : explicitRoot;
  if (selected === undefined || selected === null || selected === "") return null;
  const root = requiredPath(selected, "trusted output root");
  const metadata = lstatIfPresent(root, "trusted output root");
  assert(metadata !== null && metadata.isDirectory(),
    "RELEASE_SBOM_TRUSTED_ROOT_INVALID",
    "trusted output root must be an existing directory");
  try {
    return realpathSync(root);
  } catch (error) {
    fail("RELEASE_SBOM_TRUSTED_ROOT_INVALID",
      `trusted output root cannot be canonicalized: ${error.message}`);
  }
}

function assertTrustedOutputPath(outputPath, explicitRoot) {
  const root = trustedOutputRoot(explicitRoot);
  if (root === null) return;
  assert(pathWithin(root, outputPath),
    "RELEASE_SBOM_OUTPUT_OUTSIDE_TRUSTED_ROOT",
    "SBOM output must remain inside the trusted workspace or staging root");
}

function writeOutput(path, value) {
  if (path === undefined || path === null || path === "") return;
  const selected = requiredPath(path, "GITHUB_OUTPUT");
  assert(!value.includes("\r") && !value.includes("\n"),
    "RELEASE_SBOM_OUTPUT_INVALID", "SBOM output path contains a newline");
  appendFileSync(selected, `sbom-path=${value}\n`, "utf8");
}

function sameFileMetadata(left, right) {
  const identityAvailable = left.dev !== 0 && left.ino !== 0
    && right.dev !== 0 && right.ino !== 0;
  if (identityAvailable && (left.dev !== right.dev || left.ino !== right.ino)) {
    return false;
  }
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readSpdxJson(outputPath) {
  const metadata = lstatIfPresent(outputPath, "SBOM output path");
  assert(metadata !== null && metadata.isFile() && !metadata.isSymbolicLink(),
    "RELEASE_SBOM_OUTPUT_INVALID",
    "SBOM output must be a regular non-symlink file");
  assert(metadata.size > 0 && metadata.size <= MAX_SBOM_BYTES,
    "RELEASE_SBOM_OUTPUT_SIZE_INVALID",
    `SBOM output must be non-empty and no larger than ${MAX_SBOM_BYTES} bytes`);

  let descriptor;
  let value;
  try {
    // Keep the read attached to one descriptor.  A path replacement after
    // the lstat above cannot redirect this read to an arbitrarily large
    // file, and the fixed-size chunks keep allocation bounded even when a
    // file grows after it is opened.
    descriptor = openSync(outputPath, SBOM_READ_FLAGS);
    const opened = fstatSync(descriptor);
    assert(opened.isFile() && !opened.isSymbolicLink(),
      "RELEASE_SBOM_OUTPUT_INVALID",
      "SBOM output must be a regular non-symlink file");
    assert(sameFileMetadata(metadata, opened),
      "RELEASE_SBOM_PATH_RACE",
      "SBOM output changed while it was being opened");
    assert(opened.size > 0 && opened.size <= MAX_SBOM_BYTES,
      "RELEASE_SBOM_OUTPUT_SIZE_INVALID",
      `SBOM output must be non-empty and no larger than ${MAX_SBOM_BYTES} bytes`);

    const chunks = [];
    const buffer = Buffer.allocUnsafe(SBOM_READ_CHUNK_BYTES);
    let bytes = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      assert(bytes <= MAX_SBOM_BYTES,
        "RELEASE_SBOM_OUTPUT_SIZE_INVALID",
        `SBOM output must be non-empty and no larger than ${MAX_SBOM_BYTES} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const final = fstatSync(descriptor);
    assert(sameFileMetadata(opened, final) && bytes === final.size,
      "RELEASE_SBOM_PATH_RACE",
      "SBOM output changed while it was being read");
    value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch (error) {
    if (error instanceof ReleaseSbomValidationError) throw error;
    if (error instanceof SyntaxError) {
      fail("RELEASE_SBOM_JSON_INVALID", "SBOM output is not valid JSON");
    }
    fail("RELEASE_SBOM_OUTPUT_UNAVAILABLE", `SBOM output: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  try {
    validateSpdxJson(value, "SBOM output");
  } catch {
    fail("RELEASE_SBOM_DOCUMENT_INVALID",
      "SBOM output must satisfy the canonical SPDX-2.3 release contract");
  }
  return value;
}

export function prepareReleaseSbom({
  scanPath,
  outputPath,
  trustedRoot,
} = {}) {
  const scan = assertScanDirectory(scanPath);
  const requestedOutput = requiredPath(outputPath, "SBOM output path");
  // Check the caller-visible path before resolving its parent. This catches a
  // final symlink, including one planted between prepare and generation.
  assertOutputAbsent(requestedOutput);
  const canonicalParent = assertOutputParent(requestedOutput);
  const output = canonicalOutputPath(requestedOutput);
  assert(canonicalParent === dirname(output), "RELEASE_SBOM_PATH_RACE",
    "SBOM output parent changed while it was being canonicalized");
  assertTrustedOutputPath(output, trustedRoot);
  assert(!pathWithin(scan, output),
    "RELEASE_SBOM_OUTPUT_INSIDE_SCAN",
    "SBOM output must be outside the scanned payload tree after canonicalization");
  // Check again after creating the parent in case a concurrent process placed
  // stale evidence or a final symlink at either path during setup.
  assertOutputAbsent(requestedOutput);
  assertOutputAbsent(output);
  assert(canonicalOutputPath(requestedOutput) === output,
    "RELEASE_SBOM_PATH_RACE",
    "SBOM output parent changed after the reservation check");
  assertTrustedOutputPath(output, trustedRoot);
  return Object.freeze({ scanPath: scan, outputPath: output });
}

export function validateReleaseSbom({ outputPath, githubOutput, trustedRoot } = {}) {
  const requestedOutput = requiredPath(outputPath, "SBOM output path");
  const requestedMetadata = lstatIfPresent(requestedOutput, "SBOM output path");
  assert(requestedMetadata === null || !requestedMetadata.isSymbolicLink(),
    "RELEASE_SBOM_OUTPUT_INVALID",
    "SBOM output must not be a final symlink");
  const output = canonicalOutputPath(requestedOutput);
  const currentMetadata = lstatIfPresent(requestedOutput, "SBOM output path");
  assert(currentMetadata !== null && currentMetadata.isFile()
      && !currentMetadata.isSymbolicLink(),
    "RELEASE_SBOM_OUTPUT_INVALID",
    "SBOM output must be a regular non-symlink file");
  let requestedCanonical;
  try {
    requestedCanonical = realpathSync(requestedOutput);
  } catch (error) {
    fail("RELEASE_SBOM_PATH_RACE",
      `SBOM output changed while it was being canonicalized: ${error.message}`);
  }
  assert(requestedCanonical === output, "RELEASE_SBOM_PATH_RACE",
    "SBOM output path changed while it was being canonicalized");
  assertTrustedOutputPath(output, trustedRoot);
  const value = readSpdxJson(output);
  writeOutput(githubOutput, output);
  return Object.freeze({ outputPath: output, value });
}

/**
 * Install an already validated SBOM with an atomic no-clobber operation.
 * Keeping the generated file private until this link succeeds means a
 * concurrent release cannot cause Syft to truncate or replace the requested
 * public output path.
 */
export function installValidatedReleaseSbom({
  stagedOutputPath,
  outputPath,
  trustedRoot,
} = {}) {
  const staged = requiredPath(stagedOutputPath, "staged SBOM output path");
  const requestedOutput = requiredPath(outputPath, "SBOM output path");
  const stagedResult = validateReleaseSbom({ outputPath: staged, trustedRoot });
  const destination = canonicalOutputPath(requestedOutput);
  assert(staged !== destination, "RELEASE_SBOM_OUTPUT_INVALID",
    "staged SBOM output and requested output must be different paths");
  assertOutputAbsent(requestedOutput);
  assertOutputAbsent(destination);
  assertTrustedOutputPath(destination, trustedRoot);
  try {
    // link(2) is atomic and fails with EEXIST.  Unlike rename, it can never
    // replace a destination created by another process between our checks.
    linkSync(staged, destination);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("RELEASE_SBOM_OUTPUT_EXISTS",
        "SBOM output path was created concurrently; existing evidence was preserved");
    }
    fail("RELEASE_SBOM_OUTPUT_INSTALL_FAILED",
      `unable to install validated SBOM: ${error.message}`);
  }
  return validateReleaseSbom({ outputPath: destination, trustedRoot });
}

function syftAssetForPlatform({ platform = process.platform, architecture = process.arch } = {}) {
  const key = `${platform}_${architecture === "x64" ? "x64" : architecture}`;
  const asset = SYFT_RELEASE_ASSETS[key];
  assert(asset !== undefined, "RELEASE_SBOM_SYFT_PLATFORM_UNSUPPORTED",
    `Syft ${SYFT_VERSION} has no pinned release asset for ${platform}/${architecture}`);
  return Object.freeze({ ...asset, key });
}

function responseContentLength(response) {
  const value = response?.headers?.get?.("content-length");
  if (value === null || value === undefined || value === "") return null;
  assert(/^\d+$/u.test(value),
    "RELEASE_SBOM_SYFT_DOWNLOAD_SIZE_INVALID",
    "Syft release response has an invalid Content-Length");
  const length = Number(value);
  assert(Number.isSafeInteger(length),
    "RELEASE_SBOM_SYFT_DOWNLOAD_SIZE_INVALID",
    "Syft release response Content-Length is outside the safe integer range");
  assert(length <= MAX_SYFT_ARCHIVE_BYTES,
    "RELEASE_SBOM_SYFT_DOWNLOAD_TOO_LARGE",
    `Syft release archive exceeds the ${MAX_SYFT_ARCHIVE_BYTES}-byte limit`);
  return length;
}

function boundedArchiveTransform() {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      bytes += value.length;
      if (bytes > MAX_SYFT_ARCHIVE_BYTES) {
        callback(new ReleaseSbomValidationError(
          "RELEASE_SBOM_SYFT_DOWNLOAD_TOO_LARGE",
          `Syft release archive exceeds the ${MAX_SYFT_ARCHIVE_BYTES}-byte limit`,
        ));
        return;
      }
      callback(null, value);
    },
  });
  Object.defineProperty(stream, "bytes", { get: () => bytes });
  return stream;
}

function writeResponseToFile(response, destination) {
  assert(response?.ok === true && response.body !== null,
    "RELEASE_SBOM_SYFT_DOWNLOAD_FAILED",
    `Syft release download failed with HTTP ${response?.status ?? "unknown"}`);
  const contentLength = responseContentLength(response);
  const bounded = boundedArchiveTransform();
  return pipeline(
    Readable.fromWeb(response.body),
    bounded,
    createWriteStream(destination, { flags: "wx" }),
  ).then(() => {
    if (contentLength !== null && bounded.bytes !== contentLength) {
      fail(
        "RELEASE_SBOM_SYFT_DOWNLOAD_SIZE_MISMATCH",
        `Syft release response Content-Length ${contentLength} did not match streamed bytes ${bounded.bytes}`,
      );
    }
  });
}

export async function downloadSyft(asset, destination) {
  let response;
  try {
    response = await fetch(`${SYFT_RELEASE_BASE_URL}/${asset.fileName}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    await writeResponseToFile(response, destination);
  } catch (error) {
    if (error instanceof ReleaseSbomValidationError) throw error;
    fail("RELEASE_SBOM_SYFT_DOWNLOAD_FAILED", `unable to download Syft: ${error.message}`);
  }
  const actual = sha256File(destination);
  assert(actual === asset.sha256, "RELEASE_SBOM_SYFT_CHECKSUM_MISMATCH",
    `Syft ${asset.fileName} checksum mismatch: expected ${asset.sha256}, got ${actual}`);
}

function extractSyft(archivePath, destination, archive) {
  try {
    execFileSync("tar", archive === "zip"
      ? ["-xf", archivePath, "-C", destination]
      : ["-xzf", archivePath, "-C", destination], {
      stdio: "inherit",
      windowsHide: true,
    });
  } catch (error) {
    fail("RELEASE_SBOM_SYFT_EXTRACTION_FAILED", `unable to extract Syft: ${error.message}`);
  }
}

function syftExecutable(root, platform) {
  const path = join(root, `syft${platform === "win32" ? ".exe" : ""}`);
  const metadata = lstatIfPresent(path, "Syft executable");
  assert(metadata !== null && metadata.isFile() && !metadata.isSymbolicLink(),
    "RELEASE_SBOM_SYFT_EXECUTABLE_INVALID",
    "the pinned Syft archive did not contain a regular syft executable");
  return path;
}

/**
 * Download the exact official Syft release asset for this runner, verify its
 * hardcoded SHA-256, and execute it without invoking an installer or mutable
 * action.  The archive and generated SPDX document are held in a private
 * temporary directory on the output filesystem.  The validated document is
 * installed only after generation through a true no-clobber link operation.
 */
export async function generateReleaseSbom({
  scanPath,
  outputPath,
  trustedRoot,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  const prepared = prepareReleaseSbom({ scanPath, outputPath, trustedRoot });
  const asset = syftAssetForPlatform({ platform, architecture });
  const temporary = await mkdtemp(join(dirname(prepared.outputPath), ".tibotattle-syft-"));
  const archivePath = join(temporary, asset.fileName);
  const stagedOutputPath = join(temporary, basename(prepared.outputPath));
  try {
    await downloadSyft(asset, archivePath);
    extractSyft(archivePath, temporary, asset.archive);
    const executable = syftExecutable(temporary, platform);
    try {
      execFileSync(executable, [
        prepared.scanPath,
        "--base-path",
        prepared.scanPath,
        "-o",
        `spdx-json=${stagedOutputPath}`,
      ], {
        stdio: "inherit",
        windowsHide: true,
      });
    } catch (error) {
      fail("RELEASE_SBOM_SYFT_FAILED", `Syft failed: ${error.message}`);
    }
    return installValidatedReleaseSbom({
      stagedOutputPath,
      outputPath: prepared.outputPath,
      trustedRoot,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    assert(argument.startsWith("--") && index + 1 < argv.length,
      "RELEASE_SBOM_ARGUMENT_INVALID", `invalid argument: ${argument}`);
    options[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function cliConfig(options) {
  return {
    scanPath: options["scan-path"] ?? process.env.RELEASE_SBOM_SCAN_PATH,
    outputPath: options["output-path"] ?? process.env.RELEASE_SBOM_OUTPUT_PATH,
    githubOutput: options["github-output"] ?? process.env.GITHUB_OUTPUT,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  const command = process.argv[2] ?? "validate";
  try {
    const config = cliConfig(cliOptions(process.argv.slice(3)));
    if (command === "prepare") {
      const result = prepareReleaseSbom(config);
      console.log(`Prepared release SBOM output: ${result.outputPath}`);
    } else if (command === "generate") {
      const result = await generateReleaseSbom(config);
      console.log(`Generated and validated SPDX-2.3 SBOM: ${result.outputPath}`);
    } else if (command === "validate") {
      const result = validateReleaseSbom(config);
      console.log(`Validated SPDX-2.3 SBOM: ${result.outputPath}`);
    } else {
      fail("RELEASE_SBOM_ARGUMENT_INVALID", `unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`${error.code ?? "RELEASE_SBOM_VALIDATION_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  }
}
