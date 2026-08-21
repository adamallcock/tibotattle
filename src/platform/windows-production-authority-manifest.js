/**
 * Closed, content-free v2 contract for the handoff from the Windows
 * qualification lane to a protected signed-package finalizer.
 *
 * This module deliberately does not read files, inspect Authenticode, call
 * GitHub/Azure, mint a runtime brand, or accept a caller-supplied predicate.
 * The hashes and run metadata are claims which a later trusted finalizer must
 * bind to the exact bytes and workflow records.  A valid value from this
 * module is therefore a safe, deterministic data snapshot, not production
 * authorization by itself.
 *
 * The protected finalizer remains responsible for hashing the exact v2 handoff
 * bytes and matching its recorded digest, binding packageVersion to the
 * checked-out package metadata, inventorying the runtime manifest and
 * verifying every packaged native signature, and pinning the real Azure
 * Trusted Signing certificate identity.  This module intentionally does not
 * invent an Azure publisher identity or perform any of those I/O or external
 * policy checks.
 *
 * This manifest is generated before packaging and signing, so its finalizer
 * block records only the invocation identity known at that point: workflow,
 * repository, protected ref, event, run/attempt, head SHA, and source
 * revision.  It deliberately does not record a completed/successful
 * conclusion about its own run.  The post-sign release attestation/handoff
 * must prove those completion states after the final artifact exists and bind
 * that proof back to this manifest.
 *
 * The schema is intentionally small and closed.  The two native modules and
 * the runtime manifest are the only package subjects; source qualification,
 * native pre-sign, and the signed finalizer are the three provenance stages.
 * The finalizer can use this contract without importing any diagnostic
 * payload or user content.
 */

import { isProxy } from "node:util/types";

export const WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA =
  "tibotattle-windows-production-authority-manifest-v2";
export const WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS =
  "WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_VALID";

export const WINDOWS_PRODUCTION_AUTHORITY_PRODUCT = "TiboTattle";
export const WINDOWS_PRODUCTION_AUTHORITY_APP_ID = "com.usagemonitor.local";
export const WINDOWS_PRODUCTION_AUTHORITY_PLATFORM = "win32";
export const WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE = "x64";
export const WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY =
  "adamallcock/tibotattle";
export const WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW =
  ".github/workflows/windows-portability.yml";
export const WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW =
  ".github/workflows/windows-production-finalizer-signed.yml";
export const WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT = "workflow_dispatch";
export const WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF = "refs/heads/main";
export const WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA =
  "tibotattle-windows-finalizer-qualification-handoff-v2";
export const WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH = "package.json";
export const WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME = "app-usagemonitor";
export const WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA =
  "tibotattle-windows-native-presign-v1";
export const WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS =
  "WINDOWS_NATIVE_PRESIGN_PASSED";
export const WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET = "win32-x64";

export const WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH =
  "electron-runtime-manifest.json";

export const WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES = Object.freeze([
  Object.freeze({
    name: "windows-filesystem",
    packagedPath: "native/windows-filesystem/build/Release/windows_filesystem.node",
  }),
  Object.freeze({
    name: "keytar",
    packagedPath: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
  }),
]);

// These names are capability labels, not booleans.  They are the only local
// capabilities this data contract can describe as promoted.  Contribution
// upload, updater behavior, and Linux are explicitly unavailable so a later
// consumer cannot infer a broader product surface from an incomplete list.
export const WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES = Object.freeze([
  "local-dashboard",
  "local-credentials",
  "local-state",
]);
export const WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES = Object.freeze([
  "contribution-upload",
  "updater",
  "linux",
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "product",
  "appId",
  "packageVersion",
  "platform",
  "architecture",
  "repository",
  "sourceRevision",
  "sourcePackage",
  "sourceQualification",
  "finalizer",
  "nativeModules",
  "nativePresign",
  "runtimeManifest",
  "signerPolicy",
  "promotedCapabilities",
  "unavailableCapabilities",
]);

const SOURCE_QUALIFICATION_KEYS = Object.freeze([
  "workflow",
  "run",
  "runAttempt",
  "ref",
  "revision",
  "handoff",
  "binding",
  "receipts",
]);
const HANDOFF_KEYS = Object.freeze(["schemaVersion", "sha256"]);
const RECEIPT_KEYS = Object.freeze([
  "cacheMode",
  "run",
  "runAttempt",
  "revision",
  "artifactId",
  "artifactDigest",
  "rawReceiptSha256",
]);
const FINALIZER_KEYS = Object.freeze([
  "workflow",
  "repository",
  "run",
  "runAttempt",
  "ref",
  "event",
  "headSha",
  "sourceRevision",
]);
const NATIVE_MODULE_KEYS = Object.freeze([
  "name",
  "packagedPath",
  "unsignedBytes",
  "signedBytes",
  "unsignedSha256",
  "signedSha256",
]);
const NATIVE_PRESIGN_KEYS = Object.freeze([
  "receiptSha256",
  "schemaVersion",
  "status",
  "target",
  "revision",
  "packageVersion",
  "qualificationHandoffSha256",
]);
const SOURCE_PACKAGE_KEYS = Object.freeze([
  "path",
  "name",
  "version",
  "revision",
  "bytes",
  "sha256",
]);
const BINDING_KEYS = Object.freeze(["bytes", "sha256"]);
const RUNTIME_MANIFEST_KEYS = Object.freeze([
  "packagedPath",
  "bytes",
  "sha256",
]);
const SIGNER_POLICY_KEYS = Object.freeze(["publisher", "match"]);

const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const REF_PATTERN = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const WORKFLOW_PATTERN = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:yml|yaml)$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const MAXIMUM_JSON_BYTES = 512 * 1024;
const MAXIMUM_SOURCE_PACKAGE_BYTES = 64 * 1024;
const MAXIMUM_PATH_BYTES = 256;

const NATIVE_MODULE_ORDER = Object.freeze(
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.map(({ name }) => name),
);
const RECEIPT_ORDER = Object.freeze(["warm", "clean"]);

const ERROR_MESSAGES = Object.freeze({
  invalid: "Windows production authority manifest is invalid",
  unsafe: "Windows production authority manifest contains unsafe data",
  mismatch: "Windows production authority manifest contains mismatched provenance",
  duplicate: "Windows production authority manifest contains duplicate provenance",
});

export const WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_DEPTH = 64;
export const WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_NODES = 4096;

export class WindowsProductionAuthorityManifestError extends Error {
  constructor(code = "invalid") {
    const message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.invalid;
    super(message);
    this.name = "WindowsProductionAuthorityManifestError";
    this.code = `windows_production_authority_manifest_${code}`;
  }
}

function fail(code = "invalid") {
  throw new WindowsProductionAuthorityManifestError(code);
}

function rejectProxy(value, code = "unsafe") {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

/**
 * Read only ordinary data properties.  Descriptor inspection happens before
 * any property value is consumed, which rejects accessors, inherited fields,
 * symbols, custom prototypes, and hostile proxy objects.
 */
function readRecord(value, keys, code = "invalid") {
  rejectProxy(value, "unsafe");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code);
  }

  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("unsafe");
  }
  if (prototype !== Object.prototype) fail("unsafe");
  if (ownKeys.some((key) => typeof key !== "string")) fail("unsafe");

  const expected = new Set(keys);
  if (ownKeys.length !== keys.length
      || ownKeys.some((key) => !expected.has(key))) {
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
      fail("unsafe");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readArray(value, code = "invalid") {
  rejectProxy(value, "unsafe");
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code);
  }
  let ownKeys;
  let descriptors;
  try {
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("unsafe");
  }
  if (ownKeys.some((key) => typeof key !== "string")) fail("unsafe");
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.value !== value.length
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined) {
    fail("unsafe");
  }
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail("unsafe");
    }
  }
  if (ownKeys.length !== value.length + 1
      || ownKeys.some((key) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail("invalid");
  }
  return value.map((item) => item);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// Validate the object graph before the shape-specific readers recurse.  A
// cyclic caller object is not JSON data and would otherwise make a malformed
// manifest recurse forever.  Accessors and proxies are rejected here before
// their values are touched; repeated non-cyclic references remain harmless.
function assertAcyclicData(value) {
  const active = new WeakSet();
  let nodeCount = 0;

  function visit(current, depth) {
    if (current === null || typeof current !== "object") return;
    if (depth > WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_DEPTH) {
      fail("unsafe");
    }
    nodeCount += 1;
    if (nodeCount > WINDOWS_PRODUCTION_AUTHORITY_MAXIMUM_OBJECT_GRAPH_NODES) {
      fail("unsafe");
    }
    rejectProxy(current, "unsafe");
    let prototype;
    let keys;
    let descriptors;
    try {
      prototype = Object.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      fail("unsafe");
    }
    const isArray = Array.isArray(current);
    if ((isArray && prototype !== Array.prototype)
        || (!isArray && prototype !== Object.prototype)) {
      fail("unsafe");
    }
    if (keys.some((key) => typeof key !== "string")) fail("unsafe");
    if (active.has(current)) fail("unsafe");
    active.add(current);
    for (const key of keys) {
      if (isArray && key === "length") continue;
      const descriptor = descriptors[key];
      if (!descriptor
          || !Object.hasOwn(descriptor, "value")
          || descriptor.get !== undefined
          || descriptor.set !== undefined) {
        fail("unsafe");
      }
      visit(descriptor.value, depth + 1);
    }
    active.delete(current);
  }

  visit(value, 0);
}

function assertString(value, pattern, code = "invalid", maximumBytes = 512) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || !pattern.test(value)) {
    fail(code);
  }
  return value;
}

function assertRevision(value, code = "invalid") {
  return assertString(value, REVISION_PATTERN, code, 40);
}

function assertSha256(value, code = "invalid") {
  return assertString(value, SHA256_PATTERN, code, 64);
}

function assertPositiveInteger(value, code = "invalid") {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function validateBinding(value, code = "invalid") {
  const binding = readRecord(value, BINDING_KEYS, code);
  return {
    bytes: assertPositiveInteger(binding.bytes, code),
    sha256: assertSha256(binding.sha256, code),
  };
}

function assertRelativePath(value, expected = null) {
  if (typeof value !== "string"
      || value.length === 0
      || value === "."
      || value === ".."
      || value.includes("\\")
      || value.includes("\0")
      || value.startsWith("/")
      || /^[A-Za-z]:/u.test(value)
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES) {
    fail("unsafe");
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail("unsafe");
  }
  if (expected !== null && value !== expected) fail("mismatch");
  return value;
}

function assertWorkflow(value) {
  return assertString(value, WORKFLOW_PATTERN, "unsafe", MAXIMUM_PATH_BYTES);
}

function assertRef(value) {
  const selected = assertString(value, REF_PATTERN, "invalid", MAXIMUM_PATH_BYTES);
  // Keep this stricter than a display label: these are Git refs consumed by
  // the finalizer, so reject spellings Git itself treats as ambiguous.
  if (selected.includes("..")
      || selected.includes("@{")
      || selected.endsWith(".")
      || selected.includes("//")
      || selected.split("/").some((part) => part.endsWith(".lock"))) {
    fail("invalid");
  }
  return selected;
}

function assertExactArray(value, expected, code = "mismatch") {
  const selected = readArray(value, code);
  if (selected.length !== expected.length
      || selected.some((item, index) => item !== expected[index])) {
    fail(code);
  }
  return [...expected];
}

function validateHandoff(value) {
  const source = readRecord(value, HANDOFF_KEYS);
  if (source.schemaVersion !== WINDOWS_PRODUCTION_AUTHORITY_HANDOFF_SCHEMA) {
    fail("mismatch");
  }
  return {
    schemaVersion: source.schemaVersion,
    sha256: assertSha256(source.sha256),
  };
}

function validateReceipt(value, source) {
  const receipt = readRecord(value, RECEIPT_KEYS);
  if (!RECEIPT_ORDER.includes(receipt.cacheMode)) fail("invalid");
  if (assertPositiveInteger(receipt.run) !== source.run
      || assertPositiveInteger(receipt.runAttempt) !== source.runAttempt
      || assertRevision(receipt.revision) !== source.revision) {
    fail("mismatch");
  }
  const artifactId = assertPositiveInteger(receipt.artifactId);
  const artifactDigest = assertString(receipt.artifactDigest, ARTIFACT_DIGEST_PATTERN, "invalid", 71);
  const rawReceiptSha256 = assertSha256(receipt.rawReceiptSha256);
  if (artifactDigest !== `sha256:${rawReceiptSha256}`) fail("mismatch");
  return {
    cacheMode: receipt.cacheMode,
    run: receipt.run,
    runAttempt: receipt.runAttempt,
    revision: receipt.revision,
    artifactId,
    artifactDigest,
    rawReceiptSha256,
  };
}

function validateSourceQualification(value, sourceRevision) {
  const source = readRecord(value, SOURCE_QUALIFICATION_KEYS);
  const workflow = assertWorkflow(source.workflow);
  if (workflow !== WINDOWS_PRODUCTION_AUTHORITY_SOURCE_WORKFLOW) fail("mismatch");
  const run = assertPositiveInteger(source.run);
  const runAttempt = assertPositiveInteger(source.runAttempt);
  const ref = assertRef(source.ref);
  const revision = assertRevision(source.revision);
  if (revision !== sourceRevision) fail("mismatch");
  const handoff = validateHandoff(source.handoff);
  const binding = validateBinding(source.binding);
  const receipts = readArray(source.receipts, "invalid");
  if (receipts.length !== RECEIPT_ORDER.length) fail("invalid");
  const validatedReceipts = receipts.map((receipt) => validateReceipt(receipt, {
    run,
    runAttempt,
    revision,
  }));
  if (validatedReceipts.some((receipt, index) => receipt.cacheMode !== RECEIPT_ORDER[index])) {
    fail("invalid");
  }
  const artifactIds = new Set();
  const artifactDigests = new Set();
  const rawReceiptHashes = new Set();
  for (const receipt of validatedReceipts) {
    if (artifactIds.has(receipt.artifactId)
        || artifactDigests.has(receipt.artifactDigest)
        || rawReceiptHashes.has(receipt.rawReceiptSha256)) {
      fail("duplicate");
    }
    artifactIds.add(receipt.artifactId);
    artifactDigests.add(receipt.artifactDigest);
    rawReceiptHashes.add(receipt.rawReceiptSha256);
  }
  return {
    workflow,
    run,
    runAttempt,
    ref,
    revision,
    handoff,
    binding,
    receipts: validatedReceipts,
  };
}

function validateFinalizer(value, sourceRevision, sourceRun) {
  const finalizer = readRecord(value, FINALIZER_KEYS);
  const workflow = assertWorkflow(finalizer.workflow);
  if (workflow !== WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_WORKFLOW) fail("mismatch");
  if (finalizer.repository !== WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY) fail("mismatch");
  const run = assertPositiveInteger(finalizer.run);
  const runAttempt = assertPositiveInteger(finalizer.runAttempt);
  const ref = assertRef(finalizer.ref);
  if (ref !== WINDOWS_PRODUCTION_AUTHORITY_PROTECTED_REF) fail("mismatch");
  if (finalizer.event !== WINDOWS_PRODUCTION_AUTHORITY_FINALIZER_EVENT) {
    fail("mismatch");
  }
  const headSha = assertRevision(finalizer.headSha);
  const revision = assertRevision(finalizer.sourceRevision);
  if (revision !== sourceRevision || headSha !== sourceRevision) fail("mismatch");
  if (run === sourceRun) fail("mismatch");
  return {
    workflow,
    repository: finalizer.repository,
    run,
    runAttempt,
    ref,
    event: finalizer.event,
    headSha,
    sourceRevision: revision,
  };
}

function validateNativeModules(value, sourceBinding) {
  const modules = readArray(value, "invalid");
  if (modules.length !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.length) {
    fail("invalid");
  }
  const result = modules.map((value) => {
    const module = readRecord(value, NATIVE_MODULE_KEYS);
    const expected = WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.find(
      (candidate) => candidate.name === module.name,
    );
    if (!expected) fail("mismatch");
    return {
      name: module.name,
      packagedPath: assertRelativePath(module.packagedPath, expected.packagedPath),
      unsignedBytes: assertPositiveInteger(module.unsignedBytes),
      signedBytes: assertPositiveInteger(module.signedBytes),
      unsignedSha256: assertSha256(module.unsignedSha256),
      signedSha256: assertSha256(module.signedSha256),
    };
  });
  const names = new Set();
  const paths = new Set();
  for (const module of result) {
    if (names.has(module.name) || paths.has(module.packagedPath)) fail("duplicate");
    if (module.unsignedSha256 === module.signedSha256) fail("mismatch");
    names.add(module.name);
    paths.add(module.packagedPath);
  }
  if (result.some((module, index) => module.name !== NATIVE_MODULE_ORDER[index])) {
    fail("invalid");
  }
  const filesystem = result[0];
  if (filesystem.unsignedBytes !== sourceBinding.bytes
      || filesystem.unsignedSha256 !== sourceBinding.sha256) {
    fail("mismatch");
  }
  return result;
}

function validateNativePresign(value, sourceRevision, packageVersion, handoffSha256) {
  const presign = readRecord(value, NATIVE_PRESIGN_KEYS);
  if (presign.schemaVersion !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_SCHEMA
      || presign.status !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_STATUS
      || presign.target !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_PRESIGN_TARGET) {
    fail("mismatch");
  }
  const receiptSha256 = assertSha256(presign.receiptSha256);
  const revision = assertRevision(presign.revision);
  const selectedPackageVersion = assertString(
    presign.packageVersion,
    VERSION_PATTERN,
    "invalid",
    32,
  );
  const qualificationHandoffSha256 = assertSha256(presign.qualificationHandoffSha256);
  if (revision !== sourceRevision
      || selectedPackageVersion !== packageVersion
      || qualificationHandoffSha256 !== handoffSha256) {
    fail("mismatch");
  }
  return {
    receiptSha256,
    schemaVersion: presign.schemaVersion,
    status: presign.status,
    target: presign.target,
    revision,
    packageVersion: selectedPackageVersion,
    qualificationHandoffSha256,
  };
}

function validateSourcePackage(value, sourceRevision, packageVersion) {
  const sourcePackage = readRecord(value, SOURCE_PACKAGE_KEYS);
  const path = assertRelativePath(
    sourcePackage.path,
    WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_PATH,
  );
  if (sourcePackage.name !== WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME) {
    fail("mismatch");
  }
  const version = assertString(sourcePackage.version, VERSION_PATTERN, "invalid", 32);
  const revision = assertRevision(sourcePackage.revision);
  const bytes = assertPositiveInteger(sourcePackage.bytes);
  if (bytes > MAXIMUM_SOURCE_PACKAGE_BYTES) fail("invalid");
  const sha256 = assertSha256(sourcePackage.sha256);
  if (version !== packageVersion || revision !== sourceRevision) {
    fail("mismatch");
  }
  return {
    path,
    name: WINDOWS_PRODUCTION_AUTHORITY_SOURCE_PACKAGE_NAME,
    version,
    revision,
    bytes,
    sha256,
  };
}

function validateRuntimeManifest(value) {
  const runtime = readRecord(value, RUNTIME_MANIFEST_KEYS);
  return {
    packagedPath: assertRelativePath(
      runtime.packagedPath,
      WINDOWS_PRODUCTION_AUTHORITY_RUNTIME_MANIFEST_PATH,
    ),
    bytes: assertPositiveInteger(runtime.bytes),
    sha256: assertSha256(runtime.sha256),
  };
}

function validateSignerPolicy(value) {
  const signer = readRecord(value, SIGNER_POLICY_KEYS);
  return {
    publisher: assertString(signer.publisher, PUBLISHER_PATTERN, "invalid", 256),
    match: signer.match === "exact" ? signer.match : fail("mismatch"),
  };
}

function snapshotValidated(value) {
  const source = readRecord(value, TOP_LEVEL_KEYS);
  if (source.schemaVersion !== WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA
      || source.status !== WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS
      || source.product !== WINDOWS_PRODUCTION_AUTHORITY_PRODUCT
      || source.appId !== WINDOWS_PRODUCTION_AUTHORITY_APP_ID
      || source.platform !== WINDOWS_PRODUCTION_AUTHORITY_PLATFORM
      || source.architecture !== WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE
      || source.repository !== WINDOWS_PRODUCTION_AUTHORITY_REPOSITORY) {
    fail("mismatch");
  }

  const packageVersion = assertString(source.packageVersion, VERSION_PATTERN, "invalid", 32);
  const sourceRevision = assertRevision(source.sourceRevision);
  const sourcePackage = validateSourcePackage(
    source.sourcePackage,
    sourceRevision,
    packageVersion,
  );
  const sourceQualification = validateSourceQualification(
    source.sourceQualification,
    sourceRevision,
  );
  const finalizer = validateFinalizer(
    source.finalizer,
    sourceRevision,
    sourceQualification.run,
  );
  const nativeModules = validateNativeModules(
    source.nativeModules,
    sourceQualification.binding,
  );
  const nativePresign = validateNativePresign(
    source.nativePresign,
    sourceRevision,
    packageVersion,
    sourceQualification.handoff.sha256,
  );
  const runtimeManifest = validateRuntimeManifest(source.runtimeManifest);
  const signerPolicy = validateSignerPolicy(source.signerPolicy);
  const promotedCapabilities = assertExactArray(
    source.promotedCapabilities,
    WINDOWS_PRODUCTION_AUTHORITY_PROMOTED_CAPABILITIES,
  );
  const unavailableCapabilities = assertExactArray(
    source.unavailableCapabilities,
    WINDOWS_PRODUCTION_AUTHORITY_UNAVAILABLE_CAPABILITIES,
  );

  return {
    schemaVersion: source.schemaVersion,
    status: source.status,
    product: source.product,
    appId: source.appId,
    packageVersion,
    platform: source.platform,
    architecture: source.architecture,
    repository: source.repository,
    sourceRevision,
    sourcePackage,
    sourceQualification,
    finalizer,
    nativeModules,
    nativePresign,
    runtimeManifest,
    signerPolicy,
    promotedCapabilities,
    unavailableCapabilities,
  };
}

/**
 * Validate and return a fresh deeply frozen data snapshot.  No reference to
 * caller-owned objects or arrays is retained.  The exported function is a
 * contract validator, not an authority constructor.
 */
export function validateWindowsProductionAuthorityManifest(value) {
  assertAcyclicData(value);
  return deepFreeze(snapshotValidated(value));
}

/**
 * Build a manifest snapshot for a later finalizer.  The input is still fully
 * validated and the result carries no hidden brand or authority marker.
 */
export function createWindowsProductionAuthorityManifest(value) {
  return validateWindowsProductionAuthorityManifest(value);
}

export const buildWindowsProductionAuthorityManifest =
  createWindowsProductionAuthorityManifest;
export const generateWindowsProductionAuthorityManifest =
  createWindowsProductionAuthorityManifest;

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

/** Return canonical JSON with lexicographically ordered object keys. */
export function serializeWindowsProductionAuthorityManifest(value) {
  const selected = validateWindowsProductionAuthorityManifest(value);
  const serialized = `${JSON.stringify(stableValue(selected))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_JSON_BYTES) fail("invalid");
  return serialized;
}

/** Parse only JSON data and validate it through the same closed contract. */
export function parseWindowsProductionAuthorityManifest(value) {
  if (typeof value !== "string"
      || value.length === 0
      || Buffer.byteLength(value, "utf8") > MAXIMUM_JSON_BYTES) {
    fail("invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("invalid");
  }
  const selected = validateWindowsProductionAuthorityManifest(parsed);
  return selected;
}
