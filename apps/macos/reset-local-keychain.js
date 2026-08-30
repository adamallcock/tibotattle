#!/usr/bin/env node
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  MACOS_APP_KEYCHAIN_CAPABILITIES,
  deleteExportIdentityKeychainItemByAttributes,
  exportIdentityKeychainItemPresenceByAttributes,
} from "../../src/export-identity-keychain.js";

const CONFIRMATION_ARGUMENT = "--confirm-local-keychain-reset";
const RESULT_SCHEMA = "usage-monitor-local-keychain-reset-v1";
// The contribution-device credential exists in one of two storage
// generations: the app-minted `.app.v1` item and the companion-minted `.v1`
// item. Both are this device's upload credential, so the reset addresses both
// under the one reported state; whichever generation is absent reads as a
// clean miss and costs nothing.
//
// Both generations are cleared by fixed, attribute-addressed deletion. A reset
// is already an explicit unconditional destructive action, the companion is
// stopped before this helper runs, and no secret comparison can add safety in
// that state. Avoiding decryption means the helper needs neither the broker nor
// keytar, cannot display an ACL prompt, and cannot expose a secret in memory.
const TARGETS = Object.freeze([
  Object.freeze({
    attributeCapabilities: Object.freeze([
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice,
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp,
    ]),
    key: "contributionDevice",
    stateFile: "contribution-device-binding-v1.json",
  }),
  Object.freeze({
    attributeCapabilities: Object.freeze([
      EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity,
      MACOS_APP_KEYCHAIN_CAPABILITIES.exportIdentity,
    ]),
    key: "exportIdentity",
    stateFile: "export-participant-secret",
  }),
]);

class LocalKeychainResetError extends Error {
  constructor(code) {
    super("Local Keychain reset failed");
    this.name = "LocalKeychainResetError";
    this.code = code;
  }
}

function fail(code) {
  throw new LocalKeychainResetError(code);
}

function assertAttributeOperation(operation) {
  if (typeof operation !== "function") {
    fail("UM_MACOS_KEYCHAIN_RESET_BACKEND_INVALID");
  }
  return operation;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnerOnlyDirectory(metadata) {
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (typeof process.getuid === "function"
        && metadata.uid !== process.getuid())
      || (process.platform !== "win32"
        && (metadata.mode & 0o077) !== 0)) {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
}

function assertOwnerOnlyRegularFile(metadata) {
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.nlink !== 1
      || (typeof process.getuid === "function"
        && metadata.uid !== process.getuid())
      || (process.platform !== "win32"
        && (metadata.mode & 0o077) !== 0)) {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
}

async function inspectStateRoot(stateRoot) {
  if (typeof stateRoot !== "string"
      || stateRoot.length < 1
      || stateRoot.length > 4_096
      || stateRoot.includes("\0")
      || !isAbsolute(stateRoot)) {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
  const selected = resolve(stateRoot);
  if (selected === parse(selected).root) {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
  let metadata;
  let canonical;
  try {
    metadata = await lstat(selected);
    canonical = await realpath(selected);
  } catch {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
  assertOwnerOnlyDirectory(metadata);
  if (canonical !== selected) {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
  return selected;
}

async function inspectOptionalStateFile(stateRoot, name) {
  const target = join(stateRoot, name);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_UNSAFE");
  }
  assertOwnerOnlyRegularFile(metadata);
  return Object.freeze({
    target,
    identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }),
  });
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    await handle.sync();
  } catch {
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_CHANGED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeInspectedStateFile(inspection) {
  if (inspection === null) return "missing";
  let handle;
  try {
    handle = await open(
      inspection.target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    assertOwnerOnlyRegularFile(opened);
    if (!sameIdentity(opened, inspection.identity)) {
      fail("UM_MACOS_KEYCHAIN_RESET_STATE_CHANGED");
    }
    const current = await lstat(inspection.target);
    assertOwnerOnlyRegularFile(current);
    if (!sameIdentity(current, inspection.identity)) {
      fail("UM_MACOS_KEYCHAIN_RESET_STATE_CHANGED");
    }
    await unlink(inspection.target);
    await syncDirectory(dirname(inspection.target));
    return "removed";
  } catch (error) {
    if (error instanceof LocalKeychainResetError) throw error;
    fail("UM_MACOS_KEYCHAIN_RESET_STATE_CHANGED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function fixedFailureCode(error) {
  if (error instanceof LocalKeychainResetError) return error.code;
  const upstream = typeof error?.code === "string" ? error.code : "";
  if (upstream === "export_identity_keychain_locked") {
    return "UM_MACOS_KEYCHAIN_LOCKED";
  }
  if (upstream === "export_identity_keychain_denied") {
    return "UM_MACOS_KEYCHAIN_DENIED";
  }
  return "UM_MACOS_KEYCHAIN_RESET_FAILED";
}

function baseResult() {
  return {
    schemaVersion: RESULT_SCHEMA,
    status: "reset",
    appState: {
      allAppStateErased: false,
      contributionDeviceBinding: "missing",
      exportIdentityFileResidue: "missing",
      otherAppStateRetained: true,
    },
    keychain: {
      contributionDevice: "missing",
      exportIdentity: "missing",
      secureErasureClaimed: false,
    },
    hosted: {
      dataDeleted: false,
      deviceRevoked: false,
    },
  };
}

/**
 * Reset only the local export identity and paired-device capability. This is a
 * deliberately different contract from remote device revocation or hosted data
 * deletion. No secret, path, device ID, or account value enters the result.
 */
export async function resetLocalKeychainIdentityAndDevice({
  stateRoot,
  keychainEnvironment = undefined,
  // Injected only so tests can drive them; production always runs the fixed
  // `security` CLI attribute paths.
  attributeProbe = exportIdentityKeychainItemPresenceByAttributes,
  attributeDelete = deleteExportIdentityKeychainItemByAttributes,
} = {}) {
  const selectedProbe = assertAttributeOperation(attributeProbe);
  const selectedAttributeDelete = assertAttributeOperation(attributeDelete);
  const keychainOptions = keychainEnvironment === undefined
    ? undefined
    : Object.freeze({ environment: keychainEnvironment });
  const selectedStateRoot = await inspectStateRoot(stateRoot);
  const inspectedFiles = new Map();
  const result = baseResult();

  // Complete every read-only preflight before mutating app state or Keychain.
  for (const target of TARGETS) {
    inspectedFiles.set(
      target.key,
      await inspectOptionalStateFile(selectedStateRoot, target.stateFile),
    );
    // Attribute inspection never asks for secret data and therefore cannot
    // consult a reader ACL or display a Keychain dialog.
    let attributePresent = false;
    for (const capability of target.attributeCapabilities) {
      let presence;
      try {
        presence = keychainOptions === undefined
          ? await selectedProbe(capability)
          : await selectedProbe(capability, keychainOptions);
      } catch {
        presence = "unknown";
      }
      if (presence === "present") attributePresent = true;
    }
    if (attributePresent) {
      result.keychain[target.key] = "retained";
    }
    if (inspectedFiles.get(target.key) !== null) {
      if (target.key === "contributionDevice") {
        result.appState.contributionDeviceBinding = "retained";
      } else {
        result.appState.exportIdentityFileResidue = "retained";
      }
    }
  }

  for (const target of TARGETS) {
    let stateStatus;
    try {
      stateStatus = await removeInspectedStateFile(
        inspectedFiles.get(target.key),
      );
    } catch (error) {
      result.status = "partial";
      result.failureCode = fixedFailureCode(error);
      stateStatus = "unknown";
    }
    if (target.key === "contributionDevice") {
      result.appState.contributionDeviceBinding = stateStatus;
    } else {
      result.appState.exportIdentityFileResidue = stateStatus;
    }
    if (result.status === "partial") return Object.freeze(result);
  }

  for (const target of TARGETS) {
    let anyDeleted = false;
    // Attribute-addressed generations first. They need no secret, so they
    // run unconditionally — including in the states a read cannot reach at
    // all, which is exactly why this generation is cleared this way.
    for (const capability of target.attributeCapabilities) {
      let outcome;
      try {
        outcome = keychainOptions === undefined
          ? await selectedAttributeDelete(capability)
          : await selectedAttributeDelete(capability, keychainOptions);
      } catch (error) {
        result.status = "partial";
        result.failureCode = fixedFailureCode(error);
        result.keychain[target.key] = "unknown";
        break;
      }
      if (outcome !== "deleted" && outcome !== "missing") {
        result.status = "partial";
        result.failureCode = "UM_MACOS_KEYCHAIN_RESET_PARTIAL";
        result.keychain[target.key] = "unknown";
        break;
      }
      if (outcome === "deleted") anyDeleted = true;
    }
    if (result.status === "partial") break;
    result.keychain[target.key] = anyDeleted ? "removed" : "missing";
  }

  if (result.status === "partial" && !result.failureCode) {
    result.failureCode = "UM_MACOS_KEYCHAIN_RESET_PARTIAL";
  }
  return Object.freeze(result);
}

async function main() {
  if (process.argv.length !== 3
      || process.argv[2] !== CONFIRMATION_ARGUMENT) {
    fail("UM_MACOS_KEYCHAIN_RESET_CONFIRMATION_REQUIRED");
  }
  const stateRoot = process.env.USAGE_MONITOR_STATE_ROOT;
  const result = await resetLocalKeychainIdentityAndDevice({
    keychainEnvironment: process.env,
    stateRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "reset") process.exitCode = 2;
}

if (process.argv[1]
    && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${fixedFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
