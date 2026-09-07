#!/usr/bin/env node

/**
 * Normalize node-gyp's hard-linked Release projection into the one-link,
 * qualification-only native binding consumed by the manifest and loader.
 *
 * This is a source-qualification build step. It does not select a credential
 * backend, package the binding, or make Linux production-safe.
 */

import { createHash } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
  LINUX_CREDENTIAL_MUTEX_GENERATED_BINDING_RELATIVE_PATH,
} from "../src/platform/linux-credential-mutex.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const GENERATED_BINDING_PATH = resolve(
  REPOSITORY_ROOT,
  LINUX_CREDENTIAL_MUTEX_GENERATED_BINDING_RELATIVE_PATH,
);
const QUALIFICATION_BINDING_PATH = resolve(
  REPOSITORY_ROOT,
  LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
);
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;

function fail(code) {
  const error = new Error("Linux credential mutex staging failed");
  error.name = "LinuxCredentialMutexStagingError";
  error.code = `linux_credential_mutex_staging_${code}`;
  throw error;
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function normalizedAbsolutePath(path) {
  return typeof path === "string" && isAbsolute(path) && resolve(path) === path;
}

async function safeGeneratedBindingMetadata(path, metadata) {
  try {
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && Number.isSafeInteger(metadata.nlink)
      && metadata.nlink >= 1
      && Number.isSafeInteger(metadata.size)
      && metadata.size > 0
      && metadata.size <= MAXIMUM_BINDING_BYTES
      && await realpath(path) === path;
  } catch {
    return false;
  }
}

async function safeQualificationBindingMetadata(path, metadata, expectedSize) {
  try {
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && (metadata.mode & 0o777) === 0o644
      && metadata.size === expectedSize
      && await realpath(path) === path;
  } catch {
    return false;
  }
}

async function safeQualificationDirectory(path, metadata) {
  try {
    return metadata.isDirectory()
      && !metadata.isSymbolicLink()
      && (metadata.mode & 0o777) === 0o700
      && metadata.uid === process.getuid()
      && await realpath(path) === path;
  } catch {
    return false;
  }
}

async function readExact(handle, size, code) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    let bytesRead;
    try {
      ({ bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      ));
    } catch {
      fail(code);
    }
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) fail(code);
    offset += bytesRead;
  }
  return bytes;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let bytesWritten;
    try {
      ({ bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      ));
    } catch {
      fail("write_failed");
    }
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) fail("write_failed");
    offset += bytesWritten;
  }
}

async function syncQualificationDirectory(path) {
  let handle = null;
  try {
    handle = await open(
      path,
      filesystemConstants.O_RDONLY
        | (filesystemConstants.O_DIRECTORY ?? 0)
        | (filesystemConstants.O_CLOEXEC ?? 0),
    );
    await handle.sync();
  } catch {
    fail("directory_sync_failed");
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // A checked staging failure remains authoritative.
      }
    }
  }
}

/**
 * Copy the exact node-gyp Release bytes to the separate qualification path.
 * The output is O_EXCL-created rather than replacing a pre-existing file: a
 * stale or substituted target fails closed and is never overwritten.
 */
export async function stageLinuxCredentialMutexBinding({
  generatedBindingPath = GENERATED_BINDING_PATH,
  qualificationBindingPath = QUALIFICATION_BINDING_PATH,
  syncDirectory = syncQualificationDirectory,
} = {}) {
  if (!normalizedAbsolutePath(generatedBindingPath)
      || !normalizedAbsolutePath(qualificationBindingPath)
      || generatedBindingPath === qualificationBindingPath
      || typeof syncDirectory !== "function"
      || !Number.isInteger(filesystemConstants.O_NOFOLLOW)) {
    fail("invalid_configuration");
  }

  let generatedHandle = null;
  let qualificationHandle = null;
  let generatedBytes = null;
  try {
    const namedGeneratedBefore = await lstat(generatedBindingPath).catch(() => null);
    if (!namedGeneratedBefore
        || !await safeGeneratedBindingMetadata(generatedBindingPath, namedGeneratedBefore)) {
      fail("generated_path_unsafe");
    }

    try {
      generatedHandle = await open(
        generatedBindingPath,
        filesystemConstants.O_RDONLY
          | filesystemConstants.O_NOFOLLOW
          | (filesystemConstants.O_CLOEXEC ?? 0),
      );
    } catch {
      fail("generated_path_unsafe");
    }
    const openedGeneratedBefore = await generatedHandle.stat().catch(() => null);
    if (!openedGeneratedBefore
        || !await safeGeneratedBindingMetadata(generatedBindingPath, openedGeneratedBefore)
        || !sameFileIdentity(namedGeneratedBefore, openedGeneratedBefore)) {
      fail("generated_path_unsafe");
    }
    generatedBytes = await readExact(
      generatedHandle,
      openedGeneratedBefore.size,
      "generated_read_failed",
    );
    const openedGeneratedAfter = await generatedHandle.stat().catch(() => null);
    const namedGeneratedAfter = await lstat(generatedBindingPath).catch(() => null);
    if (!openedGeneratedAfter
        || !namedGeneratedAfter
        || !await safeGeneratedBindingMetadata(generatedBindingPath, openedGeneratedAfter)
        || !await safeGeneratedBindingMetadata(generatedBindingPath, namedGeneratedAfter)
        || !sameFileIdentity(namedGeneratedBefore, openedGeneratedAfter)
        || !sameFileIdentity(namedGeneratedBefore, namedGeneratedAfter)) {
      fail("generated_path_unsafe");
    }
    await generatedHandle.close();
    generatedHandle = null;

    const qualificationDirectory = dirname(qualificationBindingPath);
    await mkdir(qualificationDirectory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(qualificationDirectory).catch(() => null);
    if (!directoryMetadata
        || !await safeQualificationDirectory(qualificationDirectory, directoryMetadata)) {
      fail("qualification_directory_unsafe");
    }
    const existingQualification = await lstat(qualificationBindingPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail("qualification_path_unsafe");
    });
    if (existingQualification !== null) fail("qualification_path_exists");

    try {
      qualificationHandle = await open(
        qualificationBindingPath,
        filesystemConstants.O_RDWR
          | filesystemConstants.O_CREAT
          | filesystemConstants.O_EXCL
          | filesystemConstants.O_NOFOLLOW
          | (filesystemConstants.O_CLOEXEC ?? 0),
        0o644,
      );
      await qualificationHandle.chmod(0o644);
    } catch (error) {
      if (error?.code === "EEXIST") fail("qualification_path_exists");
      fail("qualification_path_unsafe");
    }

    const openedQualificationBefore = await qualificationHandle.stat().catch(() => null);
    const namedQualificationBefore = await lstat(qualificationBindingPath).catch(() => null);
    if (!openedQualificationBefore
        || !namedQualificationBefore
        || !await safeQualificationBindingMetadata(
          qualificationBindingPath,
          openedQualificationBefore,
          0,
        )
        || !await safeQualificationBindingMetadata(
          qualificationBindingPath,
          namedQualificationBefore,
          0,
        )
        || !sameFileIdentity(openedQualificationBefore, namedQualificationBefore)
        || sameFileIdentity(openedGeneratedBefore, openedQualificationBefore)) {
      fail("qualification_path_unsafe");
    }

    await writeAll(qualificationHandle, generatedBytes);
    await qualificationHandle.sync();
    const stagedBytes = await readExact(
      qualificationHandle,
      generatedBytes.byteLength,
      "qualification_read_failed",
    );
    const openedQualificationAfter = await qualificationHandle.stat().catch(() => null);
    const namedQualificationAfter = await lstat(qualificationBindingPath).catch(() => null);
    if (!openedQualificationAfter
        || !namedQualificationAfter
        || !await safeQualificationBindingMetadata(
          qualificationBindingPath,
          openedQualificationAfter,
          generatedBytes.byteLength,
        )
        || !await safeQualificationBindingMetadata(
          qualificationBindingPath,
          namedQualificationAfter,
          generatedBytes.byteLength,
        )
        || !sameFileIdentity(openedQualificationBefore, openedQualificationAfter)
        || !sameFileIdentity(openedQualificationBefore, namedQualificationAfter)
        || sameFileIdentity(openedGeneratedBefore, openedQualificationAfter)
        || !stagedBytes.equals(generatedBytes)) {
      fail("qualification_integrity");
    }
    const sha256 = createHash("sha256").update(generatedBytes).digest("hex");
    stagedBytes.fill(0);
    generatedBytes.fill(0);
    generatedBytes = null;
    await qualificationHandle.close();
    qualificationHandle = null;
    await syncDirectory(qualificationDirectory);
    const namedQualificationFinal = await lstat(qualificationBindingPath).catch(() => null);
    if (!namedQualificationFinal
        || !await safeQualificationBindingMetadata(
          qualificationBindingPath,
          namedQualificationFinal,
          openedQualificationAfter.size,
        )) {
      fail("qualification_path_unsafe");
    }
    return Object.freeze({
      bytes: openedQualificationAfter.size,
      sha256,
    });
  } catch (error) {
    if (error?.code?.startsWith("linux_credential_mutex_staging_")) throw error;
    fail("staging_failed");
  } finally {
    if (generatedBytes !== null) generatedBytes.fill(0);
    if (generatedHandle !== null) {
      try {
        await generatedHandle.close();
      } catch {
        // A checked staging failure remains authoritative.
      }
    }
    if (qualificationHandle !== null) {
      try {
        await qualificationHandle.close();
      } catch {
        // A checked staging failure remains authoritative.
      }
    }
  }
}

export async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("native_linux_x64_required");
  }
  await stageLinuxCredentialMutexBinding();
  process.stdout.write("LINUX_CREDENTIAL_MUTEX_BINDING_STAGED\n");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "linux_credential_mutex_staging_failed"}\n`);
    process.exitCode = 1;
  });
}
