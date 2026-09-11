#!/usr/bin/env node

/**
 * Build the content-free sidecar for the native Linux credential mutex.
 *
 * This script is source qualification only. It neither selects the Linux
 * credential backend nor enables a production platform path. The sidecar
 * detects a mismatched binding; a future installed artifact must still bind
 * exact final bytes to a platform trust mechanism before use.
 */

import { createHash } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_SCHEMA_VERSION,
  LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
  LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS,
} from "../src/platform/linux-credential-mutex.js";

const require = createRequire(import.meta.url);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const BINDING_PATH = resolve(
  REPOSITORY_ROOT,
  LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
);
const BINDING_FILE = "linux_credential_mutex.node";
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;

function fail(code) {
  const error = new Error("Linux credential mutex manifest failed");
  error.name = "LinuxCredentialMutexManifestError";
  error.code = `linux_credential_mutex_manifest_${code}`;
  throw error;
}

function normalizeBytes(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
      || bytes.byteLength <= 0
      || bytes.byteLength > MAXIMUM_BINDING_BYTES) {
    fail("invalid_bytes");
  }
  return Buffer.from(bytes);
}

function assertBinding(binding) {
  let valid = binding !== null && typeof binding === "object";
  try {
    for (const method of LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS) {
      valid = valid && typeof binding?.[method] === "function";
    }
    valid = valid
      && binding?.credentialMutexContractVersion === "linux-credential-mutex-v1"
      && binding?.credentialMutexCrossProcessSafe === true
      && binding?.credentialMutexSameNetworkNamespaceOnly === true
      && binding?.credentialMutexDurableMarker === true
      && binding?.productionSafe === false;
  } catch {
    valid = false;
  }
  if (!valid) fail("invalid_binding");
  return binding;
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function safeManifestMetadata(path, metadata, { allowEmpty = false } = {}) {
  try {
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && (metadata.mode & 0o777) === 0o600
      && Number.isSafeInteger(metadata.size)
      && metadata.size >= (allowEmpty ? 0 : 1)
      && metadata.size <= MAXIMUM_MANIFEST_BYTES
      && await realpath(path) === path;
  } catch {
    return false;
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let written;
    try {
      ({ bytesWritten: written } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      ));
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(written) || written <= 0) return false;
    offset += written;
  }
  return true;
}

/**
 * Rewrite only a checked regular sidecar through one pinned descriptor.
 * Existing files are never opened with O_TRUNC: the file descriptor must
 * match the fixed pathname before truncation and again after fsync.
 */
export async function writeLinuxCredentialMutexManifestFile(path, content) {
  if (typeof path !== "string"
      || !isAbsolute(path)
      || resolve(path) !== path
      || typeof content !== "string"
      || Buffer.byteLength(content, "utf8") === 0
      || Buffer.byteLength(content, "utf8") > MAXIMUM_MANIFEST_BYTES
      || !Number.isInteger(filesystemConstants.O_NOFOLLOW)) {
    fail("manifest_path_unsafe");
  }
  const bytes = Buffer.from(content, "utf8");
  let handle = null;
  try {
    let namedBefore;
    try {
      namedBefore = await lstat(path);
    } catch (error) {
      if (error?.code !== "ENOENT") fail("manifest_path_unsafe");
    }

    if (namedBefore === undefined) {
      try {
        handle = await open(
          path,
          filesystemConstants.O_RDWR
            | filesystemConstants.O_CREAT
            | filesystemConstants.O_EXCL
            | filesystemConstants.O_NOFOLLOW
            | (filesystemConstants.O_CLOEXEC ?? 0),
          0o600,
        );
      } catch {
        fail("manifest_path_unsafe");
      }
      try {
        await handle.chmod(0o600);
      } catch {
        fail("manifest_path_unsafe");
      }
      const opened = await handle.stat().catch(() => null);
      const namedAfterCreate = await lstat(path).catch(() => null);
      if (!opened
          || !namedAfterCreate
          || !await safeManifestMetadata(path, opened, { allowEmpty: true })
          || !await safeManifestMetadata(path, namedAfterCreate, { allowEmpty: true })
          || !sameFileIdentity(opened, namedAfterCreate)) {
        fail("manifest_path_unsafe");
      }
    } else {
      if (!await safeManifestMetadata(path, namedBefore)) {
        fail("manifest_path_unsafe");
      }
      try {
        handle = await open(
          path,
          filesystemConstants.O_RDWR
            | filesystemConstants.O_NOFOLLOW
            | (filesystemConstants.O_CLOEXEC ?? 0),
        );
      } catch {
        fail("manifest_path_unsafe");
      }
      const opened = await handle.stat().catch(() => null);
      const namedBeforeTruncate = await lstat(path).catch(() => null);
      if (!opened
          || !namedBeforeTruncate
          || !await safeManifestMetadata(path, opened)
          || !await safeManifestMetadata(path, namedBeforeTruncate)
          || !sameFileIdentity(namedBefore, opened)
          || !sameFileIdentity(namedBefore, namedBeforeTruncate)) {
        fail("manifest_path_unsafe");
      }
    }

    try {
      await handle.truncate(0);
      if (!await writeAll(handle, bytes)) fail("write_failed");
      await handle.sync();
    } catch (error) {
      if (error?.code?.startsWith("linux_credential_mutex_manifest_")) throw error;
      fail("write_failed");
    }
    const openedAfter = await handle.stat().catch(() => null);
    const namedAfter = await lstat(path).catch(() => null);
    if (!openedAfter
        || !namedAfter
        || !await safeManifestMetadata(path, openedAfter)
        || !await safeManifestMetadata(path, namedAfter)
        || !sameFileIdentity(openedAfter, namedAfter)) {
      fail("manifest_path_unsafe");
    }
    await handle.close();
    handle = null;
  } catch (error) {
    if (error?.code?.startsWith("linux_credential_mutex_manifest_")) throw error;
    fail("write_failed");
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // A trusted failure from the checked operation remains authoritative.
      }
    }
  }
}

/**
 * Create the exact native claim surface accepted by the loader. False for
 * production safety is intentional: a real mutex and durable journal do not
 * constitute Linux identity, Secret Service, artifact, or release support.
 */
export function createLinuxCredentialMutexBindingManifest({ bytes, binding } = {}) {
  const copiedBytes = normalizeBytes(bytes);
  const native = assertBinding(binding);
  return Object.freeze({
    schemaVersion: LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_SCHEMA_VERSION,
    bindingFile: BINDING_FILE,
    platform: "linux",
    architecture: "x64",
    bytes: copiedBytes.byteLength,
    sha256: createHash("sha256").update(copiedBytes).digest("hex"),
    contractVersion: native.credentialMutexContractVersion,
    requiredMethods: [...LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS],
    nativeClaims: {
      credentialMutexCrossProcessSafe:
        native.credentialMutexCrossProcessSafe,
      sameNetworkNamespaceOnly:
        native.credentialMutexSameNetworkNamespaceOnly,
      durableAbandonmentMarker: native.credentialMutexDurableMarker,
      productionSafe: native.productionSafe,
    },
    approvedPolicy: {
      credentialMutexCrossProcessSafe: true,
      sameNetworkNamespaceOnly: true,
      durableAbandonmentMarker: true,
      productionSafe: false,
    },
  });
}

export async function buildLinuxCredentialMutexBindingManifest({
  bindingPath = BINDING_PATH,
  manifestPath = `${bindingPath}.manifest.json`,
  readBinding = readFile,
  loadBinding = (path) => require(path),
} = {}) {
  let bytes;
  let binding;
  try {
    bytes = await readBinding(bindingPath);
    binding = loadBinding(bindingPath);
  } catch {
    fail("binding_unavailable");
  }
  const manifest = createLinuxCredentialMutexBindingManifest({ bytes, binding });
  await writeLinuxCredentialMutexManifestFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("native_linux_x64_required");
  }
  await buildLinuxCredentialMutexBindingManifest();
  process.stdout.write("LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_BUILT\n");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "linux_credential_mutex_manifest_failed"}\n`);
    process.exitCode = 1;
  });
}
