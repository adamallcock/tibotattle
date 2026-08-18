#!/usr/bin/env node

/**
 * Create the content-free integrity manifest shipped beside the reviewed
 * Windows filesystem binding. The manifest is deliberately generated only
 * after the native build and contains no absolute path, account data, or
 * native output. It records the exact bytes that the loader must verify.
 *
 * This is an integrity/mismatch check, not a signing operation. A release
 * process must authenticate the manifest (for example through a signed
 * installer or a separately signed manifest) before enabling production use.
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_FILESYSTEM_BINDING_MANIFEST_SCHEMA_VERSION,
  WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS,
} from "../src/platform/windows-filesystem.js";

const require = createRequire(import.meta.url);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const BINDING_RELATIVE_PATH =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const BINDING_PATH = resolve(REPOSITORY_ROOT, BINDING_RELATIVE_PATH);
const MANIFEST_PATH = `${BINDING_PATH}.manifest.json`;
const BINDING_FILE = "windows_filesystem.node";
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;

function failure(code) {
  const error = new Error("Windows filesystem binding manifest unavailable");
  error.code = code;
  return error;
}

function bindingSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertBindingShape(binding) {
  let valid = binding !== null && typeof binding === "object";
  try {
    for (const method of WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS) {
      valid = valid && typeof binding?.[method] === "function";
    }
    valid = valid
      && binding?.contractVersion === "windows-filesystem-v1"
      && binding?.securityContractVersion === "windows-filesystem-security-v1"
      && typeof binding?.productionSafe === "boolean"
      && typeof binding?.pathWalkRaceSafe === "boolean";
  } catch {
    valid = false;
  }
  if (!valid) throw failure("WINDOWS_FILESYSTEM_MANIFEST_INVALID_BINDING");
  return binding;
}

function normalizeBindingBytes(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
      || bytes.byteLength <= 0
      || bytes.byteLength > MAXIMUM_BINDING_BYTES) {
    throw failure("WINDOWS_FILESYSTEM_MANIFEST_INVALID_BYTES");
  }
  return Buffer.from(bytes);
}

/**
 * Build a deterministic manifest from a native binding and its exact bytes.
 * The approved policy is intentionally false until a separately reviewed
 * production change proves race-safe traversal and atomic replacement.
 */
export function createWindowsFilesystemBindingManifest({ bytes, binding }) {
  const normalizedBytes = normalizeBindingBytes(bytes);
  const native = assertBindingShape(binding);
  if (native.productionSafe !== false || native.pathWalkRaceSafe !== false) {
    throw failure("WINDOWS_FILESYSTEM_MANIFEST_NATIVE_CLAIM_UNREVIEWED");
  }
  return Object.freeze({
    schemaVersion: WINDOWS_FILESYSTEM_BINDING_MANIFEST_SCHEMA_VERSION,
    bindingFile: BINDING_FILE,
    platform: "win32",
    architecture: "x64",
    bytes: normalizedBytes.byteLength,
    sha256: bindingSha256(normalizedBytes),
    contractVersion: native.contractVersion,
    securityContractVersion: native.securityContractVersion,
    requiredMethods: [...WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS],
    nativeClaims: {
      productionSafe: native.productionSafe,
      pathWalkRaceSafe: native.pathWalkRaceSafe,
    },
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
    },
  });
}

export async function buildWindowsFilesystemBindingManifest({
  bindingPath = BINDING_PATH,
  manifestPath = `${bindingPath}.manifest.json`,
  readBinding = readFile,
  loadBinding = (path) => require(path),
  writeManifest = writeFile,
} = {}) {
  let bytes;
  let binding;
  try {
    bytes = await readBinding(bindingPath);
    binding = loadBinding(bindingPath);
  } catch {
    throw failure("WINDOWS_FILESYSTEM_MANIFEST_BINDING_UNAVAILABLE");
  }
  const manifest = createWindowsFilesystemBindingManifest({ bytes, binding });
  await writeManifest(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return manifest;
}

export async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw failure("WINDOWS_FILESYSTEM_MANIFEST_NATIVE_WINDOWS_REQUIRED");
  }
  await buildWindowsFilesystemBindingManifest();
  // Do not print the binary path or digest into a general build log. The
  // qualification receipt may expose aggregate digest metadata separately.
  console.log("WINDOWS_FILESYSTEM_BINDING_MANIFEST_BUILT");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(error?.code ?? "WINDOWS_FILESYSTEM_MANIFEST_FAILED");
    process.exitCode = 1;
  });
}
