#!/usr/bin/env node

/**
 * Verify the one deterministic Windows NSIS installer produced by the
 * protected finalizer.
 *
 * This is intentionally a post-build evidence join, not an installer
 * runner.  It hashes the exact executable at the fixed artifacts root and
 * joins that observation to the canonical installer contract, authority
 * manifest, and bounded Authenticode inventory.  It never parses PE/NSIS
 * data, starts an installer, reads the registry, invokes an uninstaller,
 * signs, uploads, publishes, or contacts a service.
 *
 * Node does not provide openat-style directory handles.  The caller of the
 * eventual Windows finalizer must therefore retain exclusive ownership of
 * the fixed roots while this verifier runs.  Repeated root and file identity
 * checks close ordinary replacement and link mistakes; they do not pretend
 * to remove a kernel-level concurrent rename race.
 */

import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { isProxy } from "node:util/types";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateWindowsInstallerContract,
  windowsInstallerArtifactFileName,
  WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION,
  WINDOWS_INSTALLER_UPGRADE_GUID,
} from "../config/windows-installer-contract.js";
import {
  WINDOWS_PRODUCTION_AUTHENTICODE_ARTIFACTS_ROOT,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
  WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER,
  parseWindowsProductionAuthenticodeInventoryReceipt,
  serializeWindowsProductionAuthenticodeInventoryReceipt,
} from "./verify-windows-production-authenticode-inventory.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_APP_ID,
  WINDOWS_PRODUCTION_AUTHORITY_ARCHITECTURE,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_PRODUCT,
  parseWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const WINDOWS_PRODUCTION_INSTALLER_SCHEMA =
  "tibotattle-windows-production-installer-receipt-v1";
export const WINDOWS_PRODUCTION_INSTALLER_STATUS =
  "WINDOWS_PRODUCTION_INSTALLER_VERIFIED";
export const WINDOWS_PRODUCTION_INSTALLER_TARGET = "win32-x64";
export const WINDOWS_PRODUCTION_INSTALLER_PRODUCTION_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64",
);
export const WINDOWS_PRODUCTION_INSTALLER_ARTIFACTS_ROOT =
  WINDOWS_PRODUCTION_AUTHENTICODE_ARTIFACTS_ROOT;
export const WINDOWS_PRODUCTION_INSTALLER_EVIDENCE_ROOT = join(
  WINDOWS_PRODUCTION_INSTALLER_PRODUCTION_ROOT,
  "evidence",
);
export const WINDOWS_PRODUCTION_INSTALLER_AUTHORITY_FILE = "authority.json";
export const WINDOWS_PRODUCTION_INSTALLER_AUTHENTICODE_FILE =
  "authenticode-inventory.json";
export const WINDOWS_PRODUCTION_INSTALLER_RECEIPT_FILE =
  "installer-receipt.json";

export const WINDOWS_PRODUCTION_INSTALLER_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_PRODUCTION_INSTALLER_INPUT_INVALID",
  inputMissing: "WINDOWS_PRODUCTION_INSTALLER_INPUT_MISSING",
  optionsInvalid: "WINDOWS_PRODUCTION_INSTALLER_OPTIONS_INVALID",
  contractInvalid: "WINDOWS_PRODUCTION_INSTALLER_CONTRACT_INVALID",
  contractMismatch: "WINDOWS_PRODUCTION_INSTALLER_CONTRACT_MISMATCH",
  authorityInvalid: "WINDOWS_PRODUCTION_INSTALLER_AUTHORITY_INVALID",
  authorityNoncanonical: "WINDOWS_PRODUCTION_INSTALLER_AUTHORITY_NONCANONICAL",
  inventoryInvalid: "WINDOWS_PRODUCTION_INSTALLER_AUTHENTICODE_INVALID",
  inventoryNoncanonical: "WINDOWS_PRODUCTION_INSTALLER_AUTHENTICODE_NONCANONICAL",
  rootsInvalid: "WINDOWS_PRODUCTION_INSTALLER_ROOTS_INVALID",
  outOfRoot: "WINDOWS_PRODUCTION_INSTALLER_OUT_OF_ROOT",
  artifactMissing: "WINDOWS_PRODUCTION_INSTALLER_ARTIFACT_MISSING",
  artifactInvalid: "WINDOWS_PRODUCTION_INSTALLER_ARTIFACT_INVALID",
  linkRejected: "WINDOWS_PRODUCTION_INSTALLER_LINK_REJECTED",
  rootReplaced: "WINDOWS_PRODUCTION_INSTALLER_ROOT_REPLACED",
  fileReplaced: "WINDOWS_PRODUCTION_INSTALLER_FILE_REPLACED",
  bindingMismatch: "WINDOWS_PRODUCTION_INSTALLER_BINDING_MISMATCH",
  signatureMissing: "WINDOWS_PRODUCTION_INSTALLER_SIGNATURE_MISSING",
  receiptInvalid: "WINDOWS_PRODUCTION_INSTALLER_RECEIPT_INVALID",
  receiptNoncanonical: "WINDOWS_PRODUCTION_INSTALLER_RECEIPT_NONCANONICAL",
  outputInvalid: "WINDOWS_PRODUCTION_INSTALLER_OUTPUT_INVALID",
  outputExists: "WINDOWS_PRODUCTION_INSTALLER_OUTPUT_EXISTS",
  passed: WINDOWS_PRODUCTION_INSTALLER_STATUS,
});
export const FIXED_STATUS = WINDOWS_PRODUCTION_INSTALLER_FIXED_STATUS;

const STATUS = FIXED_STATUS;
const KNOWN_STATUSES = new Set(Object.values(STATUS));
const OPTION_KEYS = Object.freeze([
  "authorityBytes",
  "authenticodeInventoryBytes",
  "testHooks",
  "testOnly",
  "testRoot",
]);
const TEST_HOOK_KEYS = Object.freeze([
  "afterArtifactOpen",
  "beforeArtifactFinalPathCheck",
  "beforeArtifactRead",
  "beforeArtifactOpen",
  "beforeArtifactRootRecheck",
  "beforeOutputPublish",
  "afterOutputPublish",
]);
const RECEIPT_KEYS = Object.freeze([
  "artifact",
  "authority",
  "identity",
  "lifecycle",
  "nativeProof",
  "publication",
  "publisher",
  "receiptSchemaVersion",
  "revision",
  "rollback",
  "signature",
  "staticConfig",
  "status",
  "target",
  "retention",
]);
const ARTIFACT_KEYS = Object.freeze([
  "bytes",
  "format",
  "name",
  "sha256",
]);
const AUTHORITY_RECEIPT_KEYS = Object.freeze([
  "bytes",
  "sha256",
]);
const IDENTITY_KEYS = Object.freeze([
  "appId",
  "productName",
  "status",
  "upgradeGuid",
]);
const LIFECYCLE_KEYS = Object.freeze([
  "installed",
  "registry",
  "retention",
  "uninstaller",
]);
const NATIVE_PROOF_KEYS = Object.freeze(["status"]);
const PUBLICATION_KEYS = Object.freeze(["distribution", "enabled"]);
const ROLLBACK_KEYS = Object.freeze([
  "automaticDowngrade",
  "confirmation",
  "identity",
  "mode",
  "receipt",
  "rejection",
  "selection",
  "silentDowngrade",
  "state",
  "verification",
]);
const SIGNATURE_KEYS = Object.freeze(["required", "source", "status"]);
const STATIC_CONFIG_KEYS = Object.freeze([
  "allowElevation",
  "appId",
  "architecture",
  "artifactFormat",
  "artifactName",
  "oneClick",
  "perMachine",
  "productName",
  "status",
  "target",
  "upgradeGuid",
]);
const STATIC_POLICY_ONLY = "policy_only";
const STATIC_POLICY_BOUND_NOT_INSPECTED = "policy_bound_not_inspected";
const RETENTION_KEYS = Object.freeze(["explicitPurge", "ordinaryUninstall"]);
const EXPECTED_BINDING_KEYS = Object.freeze([
  "artifactBytes",
  "artifactSha256",
  "authorityBytes",
  "authoritySha256",
  "inventorySha256",
  "packageVersion",
  "publisher",
  "revision",
]);
const MAXIMUM_AUTHORITY_BYTES = 512 * 1024;
const MAXIMUM_INVENTORY_BYTES = 64 * 1024;
const MAXIMUM_RECEIPT_BYTES = 64 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const MAXIMUM_PATH_BYTES = 4096;
const MAXIMUM_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u;
const TEST_OUTPUT_FAULTS = new Set([
  "after-temp-open",
  "after-temp-write",
  "after-temp-sync",
  "before-publish",
  "after-publish",
]);
const READ_ONLY_FLAGS = fsConstants.O_RDONLY
  | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));

export class WindowsProductionInstallerError extends Error {
  constructor(code) {
    super("Windows production installer verification failed");
    this.name = "WindowsProductionInstallerError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionInstallerError(code);
}

function rejectProxy(value, code = STATUS.inputInvalid) {
  try {
    if (isProxy(value)) fail(code);
  } catch {
    fail(code);
  }
}

function readRecord(value, keys, code = STATUS.inputInvalid) {
  rejectProxy(value, code);
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
    fail(code);
  }
  const expected = new Set(keys);
  if (prototype !== Object.prototype
      || ownKeys.length !== keys.length
      || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    fail(code);
  }
  const selected = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    selected[key] = descriptor.value;
  }
  return selected;
}

function readOptionalRecord(value, keys, code = STATUS.optionsInvalid) {
  if (value === undefined) return {};
  return readRecord(value, keys, code);
}

function readArray(value, code = STATUS.receiptInvalid) {
  rejectProxy(value, code);
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
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || lengthDescriptor.value !== value.length
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined
      || ownKeys.length !== value.length + 1
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  const selected = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    selected.push(descriptor.value);
  }
  return selected;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertDataGraph(value, seen = new Set(), depth = 0, nodes = { count: 0 }) {
  if (value === null || typeof value !== "object") return;
  if (depth > MAXIMUM_JSON_DEPTH || nodes.count >= MAXIMUM_JSON_NODES) {
    fail(STATUS.receiptInvalid);
  }
  rejectProxy(value, STATUS.receiptInvalid);
  if (seen.has(value)) fail(STATUS.receiptInvalid);
  seen.add(value);
  nodes.count += 1;
  let prototype;
  let ownKeys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(STATUS.receiptInvalid);
  }
  const isArray = Array.isArray(value);
  if ((isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype)) {
    fail(STATUS.receiptInvalid);
  }
  if (isArray) {
    const length = descriptors.length;
    if (!length
        || !Object.hasOwn(length, "value")
        || length.value !== value.length
        || length.enumerable !== false
        || length.get !== undefined
        || length.set !== undefined
        || ownKeys.length !== value.length + 1) {
      fail(STATUS.receiptInvalid);
    }
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") fail(STATUS.receiptInvalid);
    if (isArray && key === "length") continue;
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || (isArray && descriptor.enumerable !== true)) {
      fail(STATUS.receiptInvalid);
    }
    assertDataGraph(descriptor.value, seen, depth + 1, nodes);
  }
  seen.delete(value);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertString(value, pattern, maximum, code = STATUS.inputInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > maximum
      || (pattern && !pattern.test(value))) {
    fail(code);
  }
  return value;
}

function assertDigest(value, code = STATUS.inputInvalid) {
  return assertString(value, SHA256_PATTERN, 64, code);
}

function assertRevision(value, code = STATUS.inputInvalid) {
  return assertString(value, REVISION_PATTERN, 40, code);
}

function assertVersion(value, code = STATUS.inputInvalid) {
  return assertString(value, VERSION_PATTERN, 32, code);
}

function assertPublisher(value, code = STATUS.inputInvalid) {
  return assertString(value, PUBLISHER_PATTERN, 256, code);
}

function assertPositiveInteger(value, maximum = MAXIMUM_FILE_BYTES, code = STATUS.inputInvalid) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(code);
  return value;
}

function bytesInput(value, maximum, code) {
  if (!(Buffer.isBuffer(value) || typeof value === "string") || value.length === 0) {
    fail(code);
  }
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > maximum) fail(code);
  return bytes;
}

function utf8(bytes, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

function parseCanonicalJson(value, maximum, parse, serialize, invalid, noncanonical) {
  const bytes = bytesInput(value, maximum, invalid);
  const text = utf8(bytes, invalid);
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    if (error instanceof WindowsProductionInstallerError) throw error;
    fail(invalid);
  }
  let canonical;
  try {
    canonical = serialize(parsed);
  } catch {
    fail(invalid);
  }
  if (canonical !== text) fail(noncanonical);
  return Object.freeze({ bytes, value: parsed });
}

function parseAuthority(value) {
  return parseCanonicalJson(
    value,
    MAXIMUM_AUTHORITY_BYTES,
    parseWindowsProductionAuthorityManifest,
    serializeWindowsProductionAuthorityManifest,
    STATUS.authorityInvalid,
    STATUS.authorityNoncanonical,
  );
}

function parseInventory(value) {
  return parseCanonicalJson(
    value,
    MAXIMUM_INVENTORY_BYTES,
    (text) => parseWindowsProductionAuthenticodeInventoryReceipt(text),
    serializeWindowsProductionAuthenticodeInventoryReceipt,
    STATUS.inventoryInvalid,
    STATUS.inventoryNoncanonical,
  );
}

function readTestHooks(value, testOnly) {
  if (value === undefined) return undefined;
  if (!testOnly || value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(STATUS.optionsInvalid);
  }
  rejectProxy(value, STATUS.optionsInvalid);
  let hookKeys;
  let hookDescriptors;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(STATUS.optionsInvalid);
    hookKeys = Reflect.ownKeys(value);
    hookDescriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(STATUS.optionsInvalid);
  }
  const allowedHooks = new Set(TEST_HOOK_KEYS);
  const selected = {};
  for (const key of hookKeys) {
    if (typeof key !== "string" || !allowedHooks.has(key)) fail(STATUS.optionsInvalid);
    const descriptor = hookDescriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || typeof descriptor.value !== "function") {
      fail(STATUS.optionsInvalid);
    }
    rejectProxy(descriptor.value, STATUS.optionsInvalid);
    selected[key] = descriptor.value;
  }
  return Object.freeze(selected);
}

function readOptions(value) {
  rejectProxy(value, STATUS.optionsInvalid);
  if (value === undefined) fail(STATUS.optionsInvalid);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(STATUS.optionsInvalid);
  }
  let ownKeys;
  let descriptors;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail(STATUS.optionsInvalid);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(STATUS.optionsInvalid);
  }
  const source = {};
  const allowed = new Set(OPTION_KEYS);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !allowed.has(key)) fail(STATUS.optionsInvalid);
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(STATUS.optionsInvalid);
    }
    source[key] = descriptor.value;
  }
  if (source.authorityBytes === undefined || source.authenticodeInventoryBytes === undefined) {
    fail(STATUS.optionsInvalid);
  }
  if (source.testOnly !== undefined && typeof source.testOnly !== "boolean") {
    fail(STATUS.optionsInvalid);
  }
  if (source.testRoot !== undefined && typeof source.testRoot !== "string") {
    fail(STATUS.optionsInvalid);
  }
  const testOnly = source.testOnly === true;
  const testHooks = readTestHooks(source.testHooks, testOnly);
  if (source.testRoot !== undefined && !testOnly) fail(STATUS.optionsInvalid);
  if (testOnly && source.testRoot === undefined) fail(STATUS.optionsInvalid);
  return Object.freeze({
    authorityBytes: source.authorityBytes,
    authenticodeInventoryBytes: source.authenticodeInventoryBytes,
    testHooks,
    testOnly,
    testRoot: source.testRoot,
  });
}

function isUncPath(value) {
  return value.startsWith("\\\\") || value.startsWith("//");
}

async function runTestHook(testHooks, name) {
  const hook = testHooks?.[name];
  if (hook === undefined) return;
  try {
    await hook();
  } catch (error) {
    if (error instanceof WindowsProductionInstallerError) throw error;
    fail(STATUS.artifactInvalid);
  }
}

function assertAbsolutePath(value, code) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > MAXIMUM_PATH_BYTES
      || isUncPath(value)
      || (!isAbsolute(value) && !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value))) {
    fail(code);
  }
  const selected = resolve(value);
  if (selected !== value) fail(code);
  return selected;
}

function pathInside(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === ""
    || (suffix !== ".."
      && !suffix.startsWith(`..${parent.includes("\\") ? "\\" : "/"}`)
      && !isAbsolute(suffix));
}

async function assertNoSymlinkPathComponents(path, code = STATUS.linkRejected) {
  let current = resolve(path);
  while (true) {
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") fail(code);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      continue;
    }
    if (metadata.isSymbolicLink()) {
      // `/var` is a compatibility symlink on macOS; temporary test roots may
      // legitimately be addressed through that platform alias.
      if (process.platform === "darwin"
          && current === "/var"
          && await realpath(current) === "/private/var") {
        current = dirname(current);
        continue;
      }
      fail(code);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function captureDirectory(path, code = STATUS.rootsInvalid) {
  const selected = assertAbsolutePath(path, code);
  await assertNoSymlinkPathComponents(selected, code);
  let metadata;
  try {
    metadata = await lstat(selected);
  } catch (error) {
    fail(error?.code === "ENOENT" ? STATUS.inputMissing : code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  let canonical;
  try {
    canonical = await realpath(selected);
  } catch {
    fail(code);
  }
  if (canonical !== selected || isUncPath(canonical)) fail(code);
  return Object.freeze({ path: selected, canonical, metadata });
}

async function assertDirectoryState(state, code = STATUS.rootReplaced) {
  let metadata;
  try {
    metadata = await lstat(state.path);
  } catch {
    fail(code);
  }
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || !sameIdentity(metadata, state.metadata)) {
    fail(code);
  }
  let canonical;
  try {
    canonical = await realpath(state.path);
  } catch {
    fail(code);
  }
  if (canonical !== state.canonical) fail(code);
}

async function selectRoots(testOnly, testRoot) {
  const productionRoot = testOnly
    ? assertAbsolutePath(testRoot, STATUS.rootsInvalid)
    : WINDOWS_PRODUCTION_INSTALLER_PRODUCTION_ROOT;
  const root = await captureDirectory(productionRoot);
  const artifacts = await captureDirectory(join(root.path, "artifacts"));
  if (!pathInside(root.path, artifacts.path)
      || relative(root.path, artifacts.path).split(/[\\/]/u).length !== 1
      || relative(root.path, artifacts.path) !== "artifacts") {
    fail(STATUS.rootsInvalid);
  }
  return Object.freeze({ root, artifacts });
}

async function readRegularFile(
  path,
  rootState,
  maximum = MAXIMUM_FILE_BYTES,
  testHooks = undefined,
) {
  const selected = assertAbsolutePath(path, STATUS.outOfRoot);
  if (!pathInside(rootState.path, selected)) fail(STATUS.outOfRoot);
  await assertNoSymlinkPathComponents(selected, STATUS.linkRejected);
  let before;
  try {
    before = await lstat(selected);
  } catch (error) {
    fail(error?.code === "ENOENT" ? STATUS.artifactMissing : STATUS.artifactInvalid);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(STATUS.linkRejected);
  }
  if (before.size <= 0 || before.size > maximum) fail(STATUS.artifactInvalid);
  let handle;
  try {
    await runTestHook(testHooks, "beforeArtifactOpen");
    handle = await open(selected, READ_ONLY_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile()
        || opened.isSymbolicLink()
        || opened.nlink !== 1
        || opened.size !== before.size
        || !sameIdentity(before, opened)) {
      fail(STATUS.fileReplaced);
    }
    await runTestHook(testHooks, "afterArtifactOpen");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maximum) fail(STATUS.artifactInvalid);
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (!after.isFile()
        || after.nlink !== 1
        || after.size !== opened.size
        || !sameIdentity(opened, after)
        || bytes !== opened.size) {
      fail(STATUS.fileReplaced);
    }
    await runTestHook(testHooks, "beforeArtifactFinalPathCheck");
    const finalPath = await lstat(selected).catch(() => null);
    if (!finalPath
        || !finalPath.isFile()
        || finalPath.isSymbolicLink()
        || finalPath.nlink !== 1
        || !sameIdentity(opened, finalPath)
        || finalPath.size !== opened.size) {
      fail(STATUS.fileReplaced);
    }
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } catch (error) {
    if (error instanceof WindowsProductionInstallerError) throw error;
    fail(STATUS.artifactInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertContractAndAuthority(authority) {
  let contract;
  try {
    contract = validateWindowsInstallerContract();
  } catch {
    fail(STATUS.contractInvalid);
  }
  if (contract.schemaVersion !== WINDOWS_INSTALLER_CONTRACT_SCHEMA_VERSION
      || contract.platform !== "win32"
      || contract.architecture !== "x64"
      || contract.application.productName !== WINDOWS_PRODUCTION_AUTHORITY_PRODUCT
      || contract.application.appId !== WINDOWS_PRODUCTION_AUTHORITY_APP_ID
      || contract.installer.target !== "nsis"
      || contract.installer.artifactFormat !== "exe"
      || contract.publication.enabled !== false
      || contract.publication.distribution !== "unpublished"
      || contract.dataRetention.explicitPurge.status !== "policy_only") {
    fail(STATUS.contractMismatch);
  }
  if (authority.schemaVersion !== WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA
      || authority.status !== WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS
      || authority.product !== contract.application.productName
      || authority.appId !== contract.application.appId
      || authority.platform !== contract.platform
      || authority.architecture !== contract.architecture
      || authority.signerPolicy.match !== "exact"
      || authority.signerPolicy.publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) {
    fail(STATUS.contractMismatch);
  }
  if (authority.packageVersion !== authority.sourcePackage.version
      || authority.sourceRevision !== authority.sourcePackage.revision) {
    fail(STATUS.bindingMismatch);
  }
  return contract;
}

function inventoryInstallerRow(inventory, expectedName) {
  if (inventory.schemaVersion !== WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA
      || inventory.status !== WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS
      || inventory.publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) {
    fail(STATUS.inventoryInvalid);
  }
  const rows = readArray(inventory.files, STATUS.inventoryInvalid);
  const installerRows = rows.filter((row) => row?.role === "installer");
  if (installerRows.length !== 1) fail(STATUS.signatureMissing);
  const row = readRecord(
    installerRows[0],
    ["authenticode", "bytes", "path", "role", "sha256"],
    STATUS.inventoryInvalid,
  );
  if (row.role !== "installer" || row.path !== expectedName) fail(STATUS.signatureMissing);
  assertPositiveInteger(row.bytes, MAXIMUM_FILE_BYTES, STATUS.inventoryInvalid);
  assertDigest(row.sha256, STATUS.inventoryInvalid);
  return Object.freeze({
    bytes: row.bytes,
    path: row.path,
    role: row.role,
    sha256: row.sha256,
  });
}

function staticConfig() {
  return {
    status: STATIC_POLICY_BOUND_NOT_INSPECTED,
    target: STATIC_POLICY_ONLY,
    artifactFormat: STATIC_POLICY_ONLY,
    artifactName: STATIC_POLICY_ONLY,
    oneClick: STATIC_POLICY_ONLY,
    perMachine: STATIC_POLICY_ONLY,
    allowElevation: STATIC_POLICY_ONLY,
    architecture: STATIC_POLICY_ONLY,
    productName: STATIC_POLICY_ONLY,
    appId: STATIC_POLICY_ONLY,
    upgradeGuid: STATIC_POLICY_ONLY,
  };
}

function receiptFromVerification({ authorityBytes, inventoryBytes, authority, inventory, artifact, contract }) {
  const installerName = windowsInstallerArtifactFileName(authority.packageVersion);
  const receipt = {
    receiptSchemaVersion: WINDOWS_PRODUCTION_INSTALLER_SCHEMA,
    status: WINDOWS_PRODUCTION_INSTALLER_STATUS,
    target: WINDOWS_PRODUCTION_INSTALLER_TARGET,
    revision: authority.sourceRevision,
    publisher: authority.signerPolicy.publisher,
    artifact: {
      format: contract.installer.artifactFormat,
      name: installerName,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    },
    authority: {
      bytes: authorityBytes.byteLength,
      sha256: sha256(authorityBytes),
    },
    identity: {
      status: STATIC_POLICY_BOUND_NOT_INSPECTED,
      productName: contract.application.productName,
      appId: contract.application.appId,
      upgradeGuid: contract.application.upgradeGuid,
    },
    signature: {
      required: true,
      source: "authenticode_inventory_native_windows",
      status: "verified",
    },
    staticConfig: staticConfig(),
    lifecycle: {
      installed: "not_run",
      registry: "not_run",
      uninstaller: "not_run",
      retention: "not_run",
    },
    nativeProof: { status: "not_run" },
    rollback: contract.rollback,
    retention: {
      ordinaryUninstall: "not_run",
      explicitPurge: "policy_only",
    },
    publication: {
      enabled: contract.publication.enabled,
      distribution: contract.publication.distribution,
    },
  };
  // Keep the inventory binding in the receipt without exposing its rows or
  // any raw native diagnostics/certificate material.
  receipt.authority.inventorySha256 = sha256(inventoryBytes);
  void inventory;
  return deepFreeze(receipt);
}

function validateReceipt(value, expectedBinding = undefined) {
  assertDataGraph(value);
  const source = readRecord(value, RECEIPT_KEYS, STATUS.receiptInvalid);
  if (source.receiptSchemaVersion !== WINDOWS_PRODUCTION_INSTALLER_SCHEMA
      || source.status !== WINDOWS_PRODUCTION_INSTALLER_STATUS
      || source.target !== WINDOWS_PRODUCTION_INSTALLER_TARGET) {
    fail(STATUS.receiptInvalid);
  }
  const revision = assertRevision(source.revision, STATUS.receiptInvalid);
  const publisher = assertPublisher(source.publisher, STATUS.receiptInvalid);
  if (publisher !== WINDOWS_PRODUCTION_AUTHENTICODE_PUBLISHER) fail(STATUS.receiptInvalid);
  const artifactSource = readRecord(source.artifact, ARTIFACT_KEYS, STATUS.receiptInvalid);
  const artifact = {
    bytes: assertPositiveInteger(artifactSource.bytes, MAXIMUM_FILE_BYTES, STATUS.receiptInvalid),
    format: artifactSource.format,
    name: assertString(artifactSource.name, /^[A-Za-z0-9][A-Za-z0-9 ._-]*\.exe$/u, 256, STATUS.receiptInvalid),
    sha256: assertDigest(artifactSource.sha256, STATUS.receiptInvalid),
  };
  if (artifact.format !== "exe"
      || artifact.name !== windowsInstallerArtifactFileName(
        expectedBinding?.packageVersion ?? inferVersionFromInstallerName(artifact.name),
      )) {
    fail(STATUS.receiptInvalid);
  }
  const authoritySource = readRecord(
    source.authority,
    AUTHORITY_RECEIPT_KEYS.concat("inventorySha256"),
    STATUS.receiptInvalid,
  );
  const authorityEvidence = {
    bytes: assertPositiveInteger(authoritySource.bytes, MAXIMUM_AUTHORITY_BYTES, STATUS.receiptInvalid),
    sha256: assertDigest(authoritySource.sha256, STATUS.receiptInvalid),
    inventorySha256: assertDigest(authoritySource.inventorySha256, STATUS.receiptInvalid),
  };
  const identitySource = readRecord(source.identity, IDENTITY_KEYS, STATUS.receiptInvalid);
  const identity = {
    status: identitySource.status,
    productName: identitySource.productName,
    appId: identitySource.appId,
    upgradeGuid: identitySource.upgradeGuid,
  };
  if (identity.status !== STATIC_POLICY_BOUND_NOT_INSPECTED
      || identity.productName !== WINDOWS_PRODUCTION_AUTHORITY_PRODUCT
      || identity.appId !== WINDOWS_PRODUCTION_AUTHORITY_APP_ID
      || identity.upgradeGuid !== WINDOWS_INSTALLER_UPGRADE_GUID) fail(STATUS.receiptInvalid);
  const signatureSource = readRecord(source.signature, SIGNATURE_KEYS, STATUS.receiptInvalid);
  if (signatureSource.required !== true
      || signatureSource.source !== "authenticode_inventory_native_windows"
      || signatureSource.status !== "verified") fail(STATUS.receiptInvalid);
  const staticSource = readRecord(source.staticConfig, STATIC_CONFIG_KEYS, STATUS.receiptInvalid);
  if (staticSource.status !== STATIC_POLICY_BOUND_NOT_INSPECTED
      || Object.entries(staticSource)
        .filter(([key]) => key !== "status")
        .some(([, value]) => value !== STATIC_POLICY_ONLY)) {
    fail(STATUS.receiptInvalid);
  }
  const lifecycleSource = readRecord(source.lifecycle, LIFECYCLE_KEYS, STATUS.receiptInvalid);
  for (const valueAtKey of Object.values(lifecycleSource)) {
    if (valueAtKey !== "not_run") fail(STATUS.receiptInvalid);
  }
  const nativeSource = readRecord(source.nativeProof, NATIVE_PROOF_KEYS, STATUS.receiptInvalid);
  if (nativeSource.status !== "not_run") fail(STATUS.receiptInvalid);
  const rollback = readRecord(source.rollback, ROLLBACK_KEYS, STATUS.receiptInvalid);
  let canonicalContract;
  try {
    canonicalContract = validateWindowsInstallerContract();
  } catch {
    fail(STATUS.contractInvalid);
  }
  if (JSON.stringify(stableValue(rollback))
      !== JSON.stringify(stableValue(canonicalContract.rollback))) {
    fail(STATUS.receiptInvalid);
  }
  const retention = readRecord(source.retention, RETENTION_KEYS, STATUS.receiptInvalid);
  if (retention.ordinaryUninstall !== "not_run"
      || retention.explicitPurge !== "policy_only") fail(STATUS.receiptInvalid);
  const publication = readRecord(source.publication, PUBLICATION_KEYS, STATUS.receiptInvalid);
  if (publication.enabled !== false || publication.distribution !== "unpublished") {
    fail(STATUS.receiptInvalid);
  }
  if (expectedBinding !== undefined) {
    const expected = readRecord(expectedBinding, EXPECTED_BINDING_KEYS, STATUS.bindingMismatch);
    if (revision !== assertRevision(expected.revision, STATUS.bindingMismatch)
        || artifact.bytes !== assertPositiveInteger(expected.artifactBytes, MAXIMUM_FILE_BYTES, STATUS.bindingMismatch)
        || artifact.sha256 !== assertDigest(expected.artifactSha256, STATUS.bindingMismatch)
        || source.authority.sha256 !== assertDigest(expected.authoritySha256, STATUS.bindingMismatch)
        || authorityEvidence.inventorySha256 !== assertDigest(expected.inventorySha256, STATUS.bindingMismatch)
        || source.authority.bytes !== assertPositiveInteger(expected.authorityBytes, MAXIMUM_AUTHORITY_BYTES, STATUS.bindingMismatch)
        || publisher !== assertPublisher(expected.publisher, STATUS.bindingMismatch)
        || artifact.name !== windowsInstallerArtifactFileName(assertVersion(expected.packageVersion, STATUS.bindingMismatch))) {
      fail(STATUS.bindingMismatch);
    }
  }
  return deepFreeze({
    receiptSchemaVersion: source.receiptSchemaVersion,
    status: source.status,
    target: source.target,
    revision,
    publisher,
    artifact,
    authority: authorityEvidence,
    identity,
    signature: {
      required: signatureSource.required,
      source: signatureSource.source,
      status: signatureSource.status,
    },
    staticConfig: { ...staticSource },
    lifecycle: { ...lifecycleSource },
    nativeProof: { status: nativeSource.status },
    rollback: { ...rollback },
    retention: { ...retention },
    publication: { ...publication },
  });
}

function inferVersionFromInstallerName(name) {
  const match = /^TiboTattle-(.+)-Windows-x64\.exe$/u.exec(name);
  if (!match || !VERSION_PATTERN.test(match[1])) fail(STATUS.receiptInvalid);
  return match[1];
}

export function validateWindowsProductionInstallerReceipt(value, expectedBinding) {
  return validateReceipt(value, expectedBinding);
}

export function serializeWindowsProductionInstallerReceipt(value) {
  const selected = validateReceipt(value);
  const serialized = `${JSON.stringify(stableValue(selected))}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECEIPT_BYTES) {
    fail(STATUS.outputInvalid);
  }
  return serialized;
}

export function parseWindowsProductionInstallerReceipt(value, expectedBinding) {
  const bytes = bytesInput(value, MAXIMUM_RECEIPT_BYTES, STATUS.receiptInvalid);
  const text = utf8(bytes, STATUS.receiptInvalid);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(STATUS.receiptInvalid);
  }
  const selected = validateReceipt(parsed, expectedBinding);
  if (serializeWindowsProductionInstallerReceipt(selected) !== text) {
    fail(STATUS.receiptNoncanonical);
  }
  return selected;
}

/**
 * Verify the deterministic NSIS installer at the fixed artifacts root.
 * `testOnly`/`testRoot` is an explicit portable-test seam; production calls
 * cannot redirect the root or supply an installer path.
 */
export async function verifyWindowsProductionInstaller(options = undefined) {
  try {
    const source = readOptions(options);
    const authoritySubject = parseAuthority(source.authorityBytes);
    const inventorySubject = parseInventory(source.authenticodeInventoryBytes);
    const authority = authoritySubject.value;
    const inventory = inventorySubject.value;
    const contract = assertContractAndAuthority(authority);
    if (inventory.probeMode !== "native-windows") {
      fail(STATUS.inventoryInvalid);
    }
    const expectedName = windowsInstallerArtifactFileName(authority.packageVersion);
    if (inventory.revision !== authority.sourceRevision
        || inventory.packageVersion !== authority.packageVersion
        || inventory.publisher !== authority.signerPolicy.publisher) {
      fail(STATUS.bindingMismatch);
    }
    const inventoryRow = inventoryInstallerRow(inventory, expectedName);
    const roots = await selectRoots(source.testOnly, source.testRoot);
    await assertDirectoryState(roots.root);
    await assertDirectoryState(roots.artifacts);
    const artifactPath = join(roots.artifacts.path, expectedName);
    if (!pathInside(roots.artifacts.path, artifactPath)
        || artifactPath !== join(roots.artifacts.path, expectedName)) {
      fail(STATUS.outOfRoot);
    }
    await runTestHook(source.testHooks, "beforeArtifactRead");
    const artifact = await readRegularFile(artifactPath, roots.artifacts, MAXIMUM_FILE_BYTES, source.testHooks);
    await runTestHook(source.testHooks, "beforeArtifactRootRecheck");
    await assertDirectoryState(roots.root);
    await assertDirectoryState(roots.artifacts);
    if (inventoryRow.bytes !== artifact.bytes
        || inventoryRow.sha256 !== artifact.sha256
        || inventory.installer.bytes !== artifact.bytes
        || inventory.installer.sha256 !== artifact.sha256) {
      fail(STATUS.bindingMismatch);
    }
    const receipt = receiptFromVerification({
      authorityBytes: authoritySubject.bytes,
      inventoryBytes: inventorySubject.bytes,
      authority,
      inventory,
      artifact,
      contract,
    });
    return receipt;
  } catch (error) {
    if (error instanceof WindowsProductionInstallerError) throw error;
    fail(STATUS.artifactInvalid);
  }
}

function outputRootState(root) {
  return captureDirectory(root);
}

async function removeOwnedTemp(path, identity) {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile()
        && (metadata.nlink === 1 || metadata.nlink === 2)
        && sameIdentity(metadata, identity)) {
      await unlink(path);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeReceiptOnce(rootState, receipt, faultAt = null, testHooks = undefined) {
  if (faultAt !== null && !TEST_OUTPUT_FAULTS.has(faultAt)) fail(STATUS.optionsInvalid);
  await assertDirectoryState(rootState);
  const bytes = Buffer.from(serializeWindowsProductionInstallerReceipt(receipt), "utf8");
  const outputPath = join(rootState.path, WINDOWS_PRODUCTION_INSTALLER_RECEIPT_FILE);
  const temporaryPath = join(
    rootState.path,
    `.${WINDOWS_PRODUCTION_INSTALLER_RECEIPT_FILE}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryIdentity;
  let published = false;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryIdentity = await handle.stat();
    if (temporaryIdentity.nlink !== 1 || !temporaryIdentity.isFile()) fail(STATUS.outputInvalid);
    if (faultAt === "after-temp-open") fail(STATUS.outputInvalid);
    await handle.writeFile(bytes);
    if (faultAt === "after-temp-write") fail(STATUS.outputInvalid);
    await handle.sync();
    if (faultAt === "after-temp-sync") fail(STATUS.outputInvalid);
    await assertDirectoryState(rootState);
    const existingOutput = await lstat(outputPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(STATUS.outputInvalid);
    });
    if (existingOutput) {
      if (existingOutput.isSymbolicLink() || !existingOutput.isFile() || existingOutput.nlink !== 1) {
        fail(STATUS.linkRejected);
      }
      fail(STATUS.outputExists);
    }
    if (faultAt === "before-publish") fail(STATUS.outputInvalid);
    await runTestHook(testHooks, "beforeOutputPublish");
    try {
      await link(temporaryPath, outputPath);
      published = true;
    } catch (error) {
      if (error?.code === "EEXIST") fail(STATUS.outputExists);
      fail(STATUS.outputInvalid);
    }
    if (faultAt === "after-publish") fail(STATUS.outputInvalid);
    await runTestHook(testHooks, "afterOutputPublish");
    await assertDirectoryState(rootState);
    const target = await lstat(outputPath);
    if (!target.isFile()
        || target.isSymbolicLink()
        || target.nlink !== 2
        || target.size !== bytes.byteLength
        || !sameIdentity(target, temporaryIdentity)) {
      fail(STATUS.outputInvalid);
    }
    await unlink(temporaryPath);
    temporaryIdentity = null;
    const final = await lstat(outputPath);
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1) fail(STATUS.outputInvalid);
    return Object.freeze({
      path: outputPath,
      bytes: final.size,
      sha256: sha256(bytes),
    });
  } catch (error) {
    if (error instanceof WindowsProductionInstallerError) throw error;
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryIdentity) await removeOwnedTemp(temporaryPath, temporaryIdentity);
  }
}

/** Write only to the fixed production evidence root; no output path is accepted. */
export async function writeWindowsProductionInstallerReceipt(receipt) {
  if (arguments.length !== 1) fail(STATUS.optionsInvalid);
  const rootState = await outputRootState(WINDOWS_PRODUCTION_INSTALLER_EVIDENCE_ROOT);
  return writeReceiptOnce(rootState, receipt);
}

/** Portable test seam for transactional/no-clobber output validation. */
export async function writeWindowsProductionInstallerReceiptForTest(
  testRoot,
  receipt,
  faultAt = null,
  testHooks = undefined,
) {
  if (typeof testRoot !== "string" || arguments.length < 2 || arguments.length > 4) {
    fail(STATUS.optionsInvalid);
  }
  const hooks = readTestHooks(testHooks, true);
  const rootState = await outputRootState(assertAbsolutePath(testRoot, STATUS.rootsInvalid));
  return writeReceiptOnce(rootState, receipt, faultAt, hooks);
}

function evidenceFilePath(name) {
  if (name !== WINDOWS_PRODUCTION_INSTALLER_AUTHORITY_FILE
      && name !== WINDOWS_PRODUCTION_INSTALLER_AUTHENTICODE_FILE) {
    fail(STATUS.inputInvalid);
  }
  return join(WINDOWS_PRODUCTION_INSTALLER_EVIDENCE_ROOT, name);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (!Array.isArray(argv) || argv.length !== 0) fail(STATUS.optionsInvalid);
    const receipt = await verifyWindowsProductionInstaller({
      authorityBytes: await readRawEvidence(
        WINDOWS_PRODUCTION_INSTALLER_AUTHORITY_FILE,
        MAXIMUM_AUTHORITY_BYTES,
      ),
      authenticodeInventoryBytes: await readRawEvidence(
        WINDOWS_PRODUCTION_INSTALLER_AUTHENTICODE_FILE,
        MAXIMUM_INVENTORY_BYTES,
      ),
    });
    await writeWindowsProductionInstallerReceipt(receipt);
    process.stdout.write(`${JSON.stringify(stableValue(receipt))}\n`);
  } catch (error) {
    const status = KNOWN_STATUSES.has(error?.code) ? error.code : STATUS.artifactInvalid;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

async function readRawEvidence(name, maximum) {
  const root = await captureDirectory(WINDOWS_PRODUCTION_INSTALLER_EVIDENCE_ROOT);
  const path = evidenceFilePath(name);
  // A second exact open/read is intentional: the verifier binds the exact
  // bytes used in its receipt, and does not reuse a mutable intermediate.
  const selected = assertAbsolutePath(path, STATUS.outOfRoot);
  if (!pathInside(root.path, selected)) fail(STATUS.outOfRoot);
  await assertNoSymlinkPathComponents(selected, STATUS.linkRejected);
  let before;
  try {
    before = await lstat(selected);
  } catch {
    fail(STATUS.inputMissing);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(STATUS.linkRejected);
  }
  let handle;
  try {
    handle = await open(selected, READ_ONLY_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile()
        || stat.nlink !== 1
        || stat.size !== before.size
        || !sameIdentity(before, stat)
        || stat.size <= 0
        || stat.size > maximum) {
      fail(STATUS.fileReplaced);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) fail(STATUS.inputInvalid);
      offset += bytesRead;
    }
    const after = await handle.stat();
    const finalPath = await lstat(selected).catch(() => null);
    if (!after.isFile()
        || after.nlink !== 1
        || !sameIdentity(stat, after)
        || after.size !== stat.size
        || !finalPath
        || !finalPath.isFile()
        || finalPath.isSymbolicLink()
        || finalPath.nlink !== 1
        || !sameIdentity(stat, finalPath)) {
      fail(STATUS.fileReplaced);
    }
    await assertDirectoryState(root);
    return bytes;
  } catch (error) {
    if (error instanceof WindowsProductionInstallerError) throw error;
    fail(STATUS.inputInvalid);
  } finally {
    await handle?.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  await main();
}
