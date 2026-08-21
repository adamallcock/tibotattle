/**
 * Join the raw, content-free inputs of the protected Windows finalizer.
 *
 * This is an evidence join, not a signer and not a production capability
 * constructor.  It hashes the three bounded raw subjects before parsing them,
 * requires the canonical bytes emitted by their producers, and then passes
 * only validated projections to the closed authority-manifest contract.
 * Azure, Authenticode, the runtime inventory, and the Windows finalizer run
 * remain separate gates owned by the caller.
 */

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

import {
  WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256,
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  parseWindowsNativePresignReceipt,
  serializeWindowsNativePresignReceipt,
} from "./windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
  WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT,
  WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_PLATFORM,
  WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
  WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF,
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY,
  WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
  WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW,
  WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
  createWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  validateWindowsFinalizerQualificationHandoff,
  validateWindowsPortabilityRunMetadata,
} from "./verify-windows-finalizer-qualification-handoff.mjs";

export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_STATUS =
  "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_PASSED";
export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_REPOSITORY =
  WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY;
export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_SOURCE_REF =
  WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF;
export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_INPUT_INVALID",
  handoffInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_HANDOFF_INVALID",
  handoffNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_HANDOFF_NONCANONICAL",
  sourceRunInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_SOURCE_RUN_INVALID",
  sourceRunMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_SOURCE_RUN_MISMATCH",
  presignInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_PRESIGN_INVALID",
  presignNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_PRESIGN_NONCANONICAL",
  presignLinkageMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_PRESIGN_LINKAGE_MISMATCH",
  publisherMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_PUBLISHER_MISMATCH",
  moduleMismatch: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_MODULE_MISMATCH",
  finalizerInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FINALIZER_INVALID",
  runtimeInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_RUNTIME_INVALID",
  authorityInvalid: "WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_MANIFEST_INVALID",
  passed: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_STATUS,
});

const TOP_LEVEL_KEYS = Object.freeze([
  "handoffBytes",
  "nativePresignBytes",
  "sourceRunMetadata",
  "checkoutPackageJsonBytes",
  "publisher",
  "runtimeManifest",
  "finalizer",
]);
const RUNTIME_MANIFEST_KEYS = Object.freeze(["packagedPath", "bytes", "sha256"]);
const FINALIZER_KEYS = Object.freeze(["run", "runAttempt", "headSha"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const MAXIMUM_HANDOFF_BYTES = 512 * 1024;
const MAXIMUM_PRESIGN_BYTES = 64 * 1024;
const MAXIMUM_PACKAGE_JSON_BYTES = 64 * 1024;
const EXPECTED_RUNTIME_PATH = WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH;
const FIXED_REPOSITORY = WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY;
const FIXED_SOURCE_WORKFLOW = WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW;
const FIXED_FINALIZER_WORKFLOW = WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW;
const FIXED_FINALIZER_EVENT = WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT;
const FIXED_FINALIZER_REF = WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF;
const FIXED_TARGET = "win32-x64";
const FIXED_HANDOFF_SCHEMA = WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA;
const PRESIGN_MODULES = WINDOWS_NATIVE_PRESIGN_MODULES;
const PINNED_KEYTAR_SHA256 = WINDOWS_NATIVE_PRESIGN_KEYTAR_SHA256;
const PRESIGN_SCHEMA = WINDOWS_NATIVE_PRESIGN_SCHEMA;
const PRESIGN_STATUS = WINDOWS_NATIVE_PRESIGN_STATUS;

export class WindowsProductionFinalizerAuthorityError extends Error {
  constructor(code) {
    super("Windows production finalizer authority build failed");
    this.name = "WindowsProductionFinalizerAuthorityError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionFinalizerAuthorityError(code);
}

function rejectProxy(value, code) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function snapshotRecord(value, keys, code) {
  rejectProxy(value, code);
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
  const expected = new Set(keys);
  if (prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(code);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertSha256(value, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function assertRevision(value, code) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) fail(code);
  return value;
}

function assertVersion(value, code) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) fail(code);
  return value;
}

function assertPublisher(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value !== value.trim()
      || !PUBLISHER_PATTERN.test(value)) {
    fail(code);
  }
  return value;
}

function assertPositiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function assertRawBuffer(value, maximum, code) {
  if (!Buffer.isBuffer(value) || value.byteLength === 0 || value.byteLength > maximum) {
    fail(code);
  }
  return value;
}

function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(text, code) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
    return value;
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityError) throw error;
    fail(code);
  }
}

function parseCheckoutPackageJson(bytes) {
  const text = decodeUtf8(
    bytes,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  const packageJson = parseJson(
    text,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  if (packageJson.name !== WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME
      || packageJson.private !== true
      || packageJson.type !== "module") {
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid);
  }
  return {
    name: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
    version: assertVersion(
      packageJson.version,
      WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
    ),
  };
}

function canonicalHandoffBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parsePresignReceipt(value, expected) {
  try {
    const parsed = parseWindowsNativePresignReceipt(value, expected);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid);
    }
    return parsed;
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityError) throw error;
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid);
  }
}

function serializePresignReceipt(value) {
  try {
    return Buffer.from(serializeWindowsNativePresignReceipt(value), "utf8");
  } catch {
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid);
  }
}

function validateTopLevel(value) {
  const source = snapshotRecord(
    value,
    TOP_LEVEL_KEYS,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  assertRawBuffer(
    source.handoffBytes,
    MAXIMUM_HANDOFF_BYTES,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  assertRawBuffer(
    source.nativePresignBytes,
    MAXIMUM_PRESIGN_BYTES,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  assertRawBuffer(
    source.checkoutPackageJsonBytes,
    MAXIMUM_PACKAGE_JSON_BYTES,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  assertPublisher(
    source.publisher,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.inputInvalid,
  );
  const runtime = snapshotRecord(
    source.runtimeManifest,
    RUNTIME_MANIFEST_KEYS,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.runtimeInvalid,
  );
  if (runtime.packagedPath !== EXPECTED_RUNTIME_PATH) {
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.runtimeInvalid);
  }
  assertPositiveInteger(runtime.bytes,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.runtimeInvalid);
  assertSha256(runtime.sha256,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.runtimeInvalid);
  const finalizer = snapshotRecord(
    source.finalizer,
    FINALIZER_KEYS,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.finalizerInvalid,
  );
  assertPositiveInteger(finalizer.run,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.finalizerInvalid);
  assertPositiveInteger(finalizer.runAttempt,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.finalizerInvalid);
  assertRevision(finalizer.headSha,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.finalizerInvalid);
  return { ...source, runtimeManifest: runtime, finalizer };
}

function sourceQualificationFromHandoff(handoff) {
  const sorted = [...handoff.receipts].sort((left, right) => {
    const order = { warm: 0, clean: 1 };
    return order[left.cacheMode] - order[right.cacheMode];
  });
  if (sorted.length !== 2 || sorted[0].cacheMode !== "warm" || sorted[1].cacheMode !== "clean") {
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.sourceRunMismatch);
  }
  return {
    workflow: FIXED_SOURCE_WORKFLOW,
    run: handoff.run.databaseId,
    runAttempt: handoff.run.runAttempt,
    ref: handoff.run.ref,
    revision: handoff.revision,
    handoff: {
      schemaVersion: FIXED_HANDOFF_SCHEMA,
      sha256: handoff.__rawSha256,
    },
    binding: { ...sorted[0].binding },
    receipts: sorted.map((receipt) => ({
      cacheMode: receipt.cacheMode,
      run: receipt.artifact.runId,
      runAttempt: handoff.run.runAttempt,
      revision: handoff.revision,
      artifactId: receipt.artifact.id,
      artifactDigest: receipt.artifact.digest,
      rawReceiptSha256: receipt.receiptProvenance.sha256,
    })),
  };
}

function projectNativeModules(receipt, publisher) {
  if (!Array.isArray(receipt.modules) || receipt.modules.length !== PRESIGN_MODULES.length) {
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.moduleMismatch);
  }
  return receipt.modules.map((module, index) => {
    const expected = PRESIGN_MODULES[index];
    if (module.name !== expected.name || module.packagedPath !== expected.packagedPath) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.moduleMismatch);
    }
    if (module.authenticode?.publisher !== publisher) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.publisherMismatch);
    }
    return {
      name: module.name,
      packagedPath: module.packagedPath,
      unsignedBytes: module.unsignedBytes,
      signedBytes: module.signedBytes,
      unsignedSha256: module.unsignedSha256,
      signedSha256: module.signedSha256,
    };
  });
}

function buildAuthorityInput({
  handoff,
  handoffSha256,
  presign,
  presignSha256,
  sourcePackage,
  runtime,
  finalizer,
  publisher,
}) {
  const nativeModules = projectNativeModules(presign, publisher);
  const nativePresign = {
    receiptSha256: presignSha256,
    schemaVersion: presign.schemaVersion,
    status: presign.status,
    target: presign.target,
    revision: presign.revision,
    packageVersion: presign.packageVersion,
    qualificationHandoffSha256: presign.qualificationHandoffSha256,
  };
  const sourceQualification = sourceQualificationFromHandoff({
    ...handoff,
    __rawSha256: handoffSha256,
  });
  const input = {
    schemaVersion: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
    status: WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
    product: WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
    appId: WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
    packageVersion: sourcePackage.version,
    platform: WINDOWS_PRODUCTION_AUTHORITY_PLATFORM,
    architecture: WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
    repository: FIXED_REPOSITORY,
    sourceRevision: handoff.revision,
    sourcePackage: {
      path: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
      name: sourcePackage.name,
      version: sourcePackage.version,
      revision: handoff.revision,
      bytes: sourcePackage.bytes,
      sha256: sourcePackage.sha256,
    },
    sourceQualification,
    finalizer: {
      workflow: FIXED_FINALIZER_WORKFLOW,
      repository: FIXED_REPOSITORY,
      run: finalizer.run,
      runAttempt: finalizer.runAttempt,
      ref: FIXED_FINALIZER_REF,
      event: FIXED_FINALIZER_EVENT,
      headSha: finalizer.headSha,
      sourceRevision: handoff.revision,
    },
    nativeModules,
    runtimeManifest: {
      packagedPath: runtime.packagedPath,
      bytes: runtime.bytes,
      sha256: runtime.sha256,
    },
    signerPolicy: { publisher, match: "exact" },
    promotedCapabilities: [
      ...WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
    ],
    unavailableCapabilities: [
      ...WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
    ],
    nativePresign,
  };
  return input;
}

/**
 * Join raw handoff/presign bytes and independently supplied finalizer facts
 * into the closed authority snapshot.  No caller-supplied native module rows
 * are accepted; those rows come only from the validated presign receipt.
 */
export function buildWindowsProductionFinalizerAuthority(options) {
  try {
    const source = validateTopLevel(options);
    // Copy and hash the exact checkout bytes before parsing.  The package
    // version used below is therefore derived from the bounded source bytes,
    // never accepted as an independent caller claim.
    const checkoutPackageJsonBytes = Buffer.from(source.checkoutPackageJsonBytes);
    const checkoutPackageJsonSha256 = sha256(checkoutPackageJsonBytes);
    const checkoutPackage = parseCheckoutPackageJson(checkoutPackageJsonBytes);
    const handoffBytes = Buffer.from(source.handoffBytes);
    const handoffSha256 = sha256(handoffBytes);
    const handoffText = decodeUtf8(
      handoffBytes,
      WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.handoffInvalid,
    );
    const handoffValue = parseJson(
      handoffText,
      WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.handoffInvalid,
    );
    let handoff;
    try {
      handoff = validateWindowsFinalizerQualificationHandoff(handoffValue, {
        repository: FIXED_REPOSITORY,
        revision: handoffValue.revision,
        ref: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_SOURCE_REF,
      });
    } catch {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.handoffInvalid);
    }
    if (handoff.repository !== FIXED_REPOSITORY
        || handoff.target !== FIXED_TARGET
        || handoff.run.ref !== WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_SOURCE_REF) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.handoffInvalid);
    }
    if (!Buffer.from(canonicalHandoffBytes(handoff)).equals(handoffBytes)) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.handoffNoncanonical);
    }

    let sourceRun;
    try {
      sourceRun = validateWindowsPortabilityRunMetadata(source.sourceRunMetadata, {
        repository: FIXED_REPOSITORY,
        revision: handoff.revision,
        ref: WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_SOURCE_REF,
      });
    } catch {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.sourceRunInvalid);
    }
    if (sourceRun.workflowPath !== FIXED_SOURCE_WORKFLOW
        || sourceRun.repository !== handoff.repository
        || sourceRun.databaseId !== handoff.run.databaseId
        || sourceRun.runAttempt !== handoff.run.runAttempt
        || sourceRun.ref !== handoff.run.ref
        || sourceRun.headSha !== handoff.revision
        || sourceRun.event !== handoff.run.event
        || sourceRun.status !== handoff.run.status
        || sourceRun.conclusion !== handoff.run.conclusion) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.sourceRunMismatch);
    }

    const presignBytes = Buffer.from(source.nativePresignBytes);
    const presignSha256 = sha256(presignBytes);
    const presignText = decodeUtf8(
      presignBytes,
      WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignInvalid,
    );
    const expectedBinding = handoff.receipts[0].binding;
    const expectedPresignBinding = {
      revision: handoff.revision,
      packageVersion: checkoutPackage.version,
      qualificationHandoffSha256: handoffSha256,
      filesystemBinding: expectedBinding,
      publisher: source.publisher,
    };
    const presign = parsePresignReceipt(presignText, expectedPresignBinding);
    if (!serializePresignReceipt(presign).equals(presignBytes)) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignNoncanonical);
    }
    if (presign.schemaVersion !== PRESIGN_SCHEMA
        || presign.status !== PRESIGN_STATUS
        || presign.target !== FIXED_TARGET
        || presign.revision !== handoff.revision
        || presign.packageVersion !== checkoutPackage.version
        || presign.qualificationHandoffSha256 !== handoffSha256) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.presignLinkageMismatch);
    }
    if (presign.modules?.[0]?.unsignedBytes !== expectedBinding.bytes
        || presign.modules?.[0]?.unsignedSha256 !== expectedBinding.sha256
        || presign.modules?.[1]?.unsignedSha256 !== PINNED_KEYTAR_SHA256) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.moduleMismatch);
    }

    const runtime = source.runtimeManifest;
    const finalizer = source.finalizer;
    if (finalizer.headSha !== handoff.revision) {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.finalizerInvalid);
    }
    const authorityInput = buildAuthorityInput({
      handoff,
      handoffSha256,
      presign,
      presignSha256,
      sourcePackage: {
        ...checkoutPackage,
        revision: handoff.revision,
        bytes: checkoutPackageJsonBytes.byteLength,
        sha256: checkoutPackageJsonSha256,
      },
      runtime,
      finalizer,
      publisher: source.publisher,
    });
    try {
      return createWindowsProductionAuthorityManifest(authorityInput);
    } catch {
      fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.authorityInvalid);
    }
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerAuthorityError) throw error;
    fail(WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_FIXED_STATUS.authorityInvalid);
  }
}

export const buildWindowsProductionFinalizerAuthorityManifest =
  buildWindowsProductionFinalizerAuthority;
