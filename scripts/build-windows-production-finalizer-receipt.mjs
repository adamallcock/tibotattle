#!/usr/bin/env node

/**
 * Join the bounded evidence produced by the Windows signed-package finalizer.
 *
 * This module is deliberately a receipt join, not a signer, publisher, or
 * installed-app runner.  Every subject is supplied as bounded raw bytes.  We
 * hash those bytes before parsing, require the producer's closed/canonical
 * representation, and then bind the independent projections together.  The
 * returned value contains only fixed metadata, byte counts, and SHA-256
 * digests; it never contains an executable, certificate, path to a checkout,
 * log, or provider response.
 *
 * A valid receipt is an attestation of the stages that were actually supplied
 * to this join.  Installed lifecycle evidence remains explicitly `not_run`,
 * so this module cannot accidentally turn a package proof into a production
 * readiness claim.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_NATIVE_PRESIGN_MODULES,
  WINDOWS_NATIVE_PRESIGN_SCHEMA,
  WINDOWS_NATIVE_PRESIGN_STATUS,
  parseWindowsNativePresignReceipt,
  serializeWindowsNativePresignReceipt,
  validateWindowsNativePresignReceipt,
} from "./windows-native-presign.mjs";
import {
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_SCHEMA,
  WINDOWS_PRODUCTION_AUTHORITY_MANIFEST_STATUS,
  WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES,
  parseWindowsProductionAuthorityManifest,
  serializeWindowsProductionAuthorityManifest,
  validateWindowsProductionAuthorityManifest,
} from "../src/platform/windows-production-authority-manifest.js";
import {
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE,
  WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS,
  assertNativeWindowsProductionAuthenticodeInventoryReceipt,
  collectWindowsProductionAuthenticodeInventoryForFinalizer,
  parseWindowsProductionAuthenticodeInventoryReceipt,
  serializeWindowsProductionAuthenticodeInventoryReceipt,
  validateWindowsProductionAuthenticodeInventoryReceipt,
} from "./verify-windows-production-authenticode-inventory.mjs";
import {
  WINDOWS_PRODUCTION_INSTALLER_SCHEMA,
  WINDOWS_PRODUCTION_INSTALLER_RECEIPT_FILE,
  WINDOWS_PRODUCTION_INSTALLER_STATUS,
  parseWindowsProductionInstallerReceipt,
  serializeWindowsProductionInstallerReceipt,
  validateWindowsProductionInstallerReceipt,
  verifyWindowsProductionInstaller,
  writeWindowsProductionInstallerReceipt,
} from "./verify-windows-production-installer.mjs";
import {
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS,
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS,
  parseWindowsProductionPackagedArtifactReceipt as parsePackagedArtifactReceipt,
  serializeWindowsProductionPackagedArtifactReceipt as serializePackagedArtifactReceipt,
  validateWindowsProductionPackagedArtifactReceipt as validatePackagedArtifactReceipt,
  WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_FILE,
} from "./verify-windows-production-packaged-artifact.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export const WINDOWS_PRODUCTION_FINALIZER_RECEIPT_SCHEMA =
  "tibotattle-windows-production-finalizer-receipt-v1";
export const WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS =
  "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_VERIFIED";
export const WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET = "win32-x64";
export const WINDOWS_PRODUCTION_FINALIZER_RECEIPT_ROOT = resolve(
  REPOSITORY_ROOT,
  ".release-build/electron-production/windows-x64/evidence",
);
export const WINDOWS_PRODUCTION_FINALIZER_RECEIPT_LEAF =
  "windows-production-finalizer-receipt.json";
export const WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_LEAF = "authority.json";
export const WINDOWS_PRODUCTION_FINALIZER_SIGNING_LEDGER_LEAF =
  "windows-signing-operation-ledger.json";
export const WINDOWS_PRODUCTION_FINALIZER_PRESIGN_LEAF_PREFIX =
  "windows-native-presign-";

export const WINDOWS_PRODUCTION_FINALIZER_RECEIPT_FIXED_STATUS = Object.freeze({
  inputInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_INPUT_INVALID",
  inputMissing: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_INPUT_MISSING",
  authorityInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_AUTHORITY_INVALID",
  authorityNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_AUTHORITY_NONCANONICAL",
  presignInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_PRESIGN_INVALID",
  presignNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_PRESIGN_NONCANONICAL",
  ledgerInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_LEDGER_INVALID",
  ledgerNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_LEDGER_NONCANONICAL",
  packagedInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_PACKAGED_INVALID",
  packagedNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_PACKAGED_NONCANONICAL",
  inventoryInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_AUTHENTICODE_INVALID",
  inventoryNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_AUTHENTICODE_NONCANONICAL",
  installerInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_INSTALLER_INVALID",
  installerNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_INSTALLER_NONCANONICAL",
  probeModeInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_NATIVE_PROBE_REQUIRED",
  mismatch: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_BINDING_MISMATCH",
  outputInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_OUTPUT_INVALID",
  rootsInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_ROOTS_INVALID",
  rootReplaced: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_ROOT_REPLACED",
  linkRejected: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_LINK_REJECTED",
  outputExists: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_OUTPUT_EXISTS",
  receiptInvalid: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_INVALID",
  receiptNoncanonical: "WINDOWS_PRODUCTION_FINALIZER_RECEIPT_NONCANONICAL",
  passed: WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS,
});
export const FIXED_STATUS = WINDOWS_PRODUCTION_FINALIZER_RECEIPT_FIXED_STATUS;

const STATUS = FIXED_STATUS;
const OPTION_KEYS = Object.freeze([
  "authorityBytes",
  "nativePresignBytes",
  "signingLedgerBytes",
  "packagedArtifactBytes",
  "authenticodeInventoryBytes",
  "installerBytes",
]);
const RECEIPT_KEYS = Object.freeze([
  "authority",
  "authenticode",
  "installedLifecycle",
  "installer",
  "nativePresign",
  "packageVersion",
  "packagedArtifact",
  "preparation",
  "production",
  "publisher",
  "qualification",
  "revision",
  "schemaVersion",
  "signingLedger",
  "status",
  "target",
]);
const PREPARATION_KEYS = Object.freeze(["handoff", "source", "workflow"]);
const PREPARATION_HANDOFF_KEYS = Object.freeze(["sha256"]);
const PREPARATION_SOURCE_KEYS = Object.freeze([
  "ref",
  "revision",
  "run",
  "runAttempt",
  "workflow",
]);
const PREPARATION_WORKFLOW_KEYS = Object.freeze([
  "path",
  "ref",
  "revision",
  "run",
  "runAttempt",
]);
const DIGEST_KEYS = Object.freeze(["bytes", "sha256"]);
const LEDGER_KEYS = Object.freeze([
  "builder",
  "builderVersion",
  "classes",
  "ledgerCount",
  "operationCount",
  "schemaVersion",
  "status",
]);
const LEDGER_CLASS_KEYS = Object.freeze(["dll", "exe", "node", "unexpected"]);
const LIFECYCLE_KEYS = Object.freeze([
  "installed",
  "nativeProof",
  "registry",
  "retention",
  "status",
  "uninstaller",
]);
const PRODUCTION_KEYS = Object.freeze(["distribution", "enabled", "ready"]);
const INSTALLED_LIFECYCLE = Object.freeze({
  installed: "not_run",
  nativeProof: "not_run",
  registry: "not_run",
  retention: "not_run",
  status: "not_run",
  uninstaller: "not_run",
});
const MAXIMUM_AUTHORITY_BYTES = 512 * 1024;
const MAXIMUM_PRESIGN_BYTES = 64 * 1024;
const MAXIMUM_LEDGER_BYTES = 64 * 1024;
const MAXIMUM_PACKAGED_BYTES = 64 * 1024;
const MAXIMUM_INVENTORY_BYTES = 64 * 1024;
const MAXIMUM_INSTALLER_BYTES = 64 * 1024;
const MAXIMUM_RECEIPT_BYTES = 256 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 4096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,&()=+_-]{0,255}$/u;
const TEST_HOOK_KEYS = Object.freeze([
  "beforeOutputPublish",
  "afterOutputPublish",
]);
const TEST_FAULTS = new Set([
  "after-temp-open",
  "after-temp-write",
  "after-temp-sync",
  "before-publish",
  "after-publish",
]);

export class WindowsProductionFinalizerReceiptError extends Error {
  constructor(code) {
    super("Windows production finalizer receipt join failed");
    this.name = "WindowsProductionFinalizerReceiptError";
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsProductionFinalizerReceiptError(code);
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
  const selected = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true) {
      fail(code);
    }
    selected[key] = descriptor.value;
  }
  return selected;
}

function readArray(value, maximum, code = STATUS.inputInvalid) {
  rejectProxy(value, code);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
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
      || lengthDescriptor.enumerable !== false
      || lengthDescriptor.get !== undefined
      || lengthDescriptor.set !== undefined
      || ownKeys.some((key) => typeof key !== "string")) {
    fail(code);
  }
  if (value.length > maximum || ownKeys.length !== value.length + 1) fail(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined) {
      fail(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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

function stableJson(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDigest(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function assertRevision(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) fail(code);
  return value;
}

function assertVersion(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) fail(code);
  return value;
}

function assertPublisher(value, code = STATUS.inputInvalid) {
  if (typeof value !== "string"
      || value.length === 0
      || value !== value.trim()
      || !PUBLISHER_PATTERN.test(value)) fail(code);
  return value;
}

function assertPositiveInteger(value, maximum = Number.MAX_SAFE_INTEGER, code = STATUS.inputInvalid) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(code);
  return value;
}

function assertNonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER, code = STATUS.inputInvalid) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code);
  return value;
}

function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

// JSON.parse does not expose duplicate keys.  The bounded scanner keeps the
// raw-byte hash independent from parsing while rejecting duplicate-key tricks
// before any producer contract sees the object.
function scanJsonSyntax(text, invalidCode, duplicateCode) {
  if (typeof text !== "string" || text.length === 0) fail(invalidCode);
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (index < text.length && /[\t\n\r ]/u.test(text[index])) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail(invalidCode);
    index += 1;
    while (index < text.length) {
      const current = text[index];
      if (current === "\\") {
        index += 2;
        if (index > text.length) fail(invalidCode);
        continue;
      }
      if (current < " ") fail(invalidCode);
      index += 1;
      if (current === '"') {
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail(invalidCode);
        }
      }
    }
    fail(invalidCode);
  };
  const parseValue = (depth = 0) => {
    nodes += 1;
    if (depth > MAXIMUM_JSON_DEPTH || nodes > MAXIMUM_JSON_NODES) fail(invalidCode);
    whitespace();
    const current = text[index];
    if (current === "{") {
      index += 1;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail(duplicateCode);
        keys.add(key);
        whitespace();
        if (text[index] !== ":") fail(invalidCode);
        index += 1;
        parseValue(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(invalidCode);
        index += 1;
      }
    }
    if (current === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        parseValue(depth + 1);
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail(invalidCode);
        index += 1;
      }
    }
    if (current === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text.slice(index).match(
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u,
    );
    if (!number) fail(invalidCode);
    index += number[0].length;
  };
  parseValue();
  whitespace();
  if (index !== text.length) fail(invalidCode);
}

function parseRawJson(bytes, maximum, invalidCode, duplicateCode) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximum) {
    fail(invalidCode);
  }
  const text = decodeUtf8(bytes, invalidCode);
  scanJsonSyntax(text, invalidCode, duplicateCode);
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(invalidCode);
    return { text, value };
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerReceiptError) throw error;
    fail(invalidCode);
  }
}

function parseCanonicalSubject(bytes, {
  maximum,
  invalidCode,
  noncanonicalCode,
  parse,
  serialize,
}) {
  const parsed = parseRawJson(bytes, maximum, invalidCode, noncanonicalCode);
  let value;
  try {
    value = parse(parsed.text);
  } catch {
    fail(invalidCode);
  }
  let canonical;
  try {
    canonical = serialize(value);
  } catch {
    fail(invalidCode);
  }
  if (canonical !== parsed.text) fail(noncanonicalCode);
  return value;
}

function readOptions(value) {
  const source = readRecord(value, OPTION_KEYS, STATUS.inputInvalid);
  const maximums = {
    authorityBytes: MAXIMUM_AUTHORITY_BYTES,
    nativePresignBytes: MAXIMUM_PRESIGN_BYTES,
    signingLedgerBytes: MAXIMUM_LEDGER_BYTES,
    packagedArtifactBytes: MAXIMUM_PACKAGED_BYTES,
    authenticodeInventoryBytes: MAXIMUM_INVENTORY_BYTES,
    installerBytes: MAXIMUM_INSTALLER_BYTES,
  };
  const selected = {};
  for (const key of OPTION_KEYS) {
    if (!Buffer.isBuffer(source[key])) fail(STATUS.inputInvalid);
    if (source[key].byteLength === 0 || source[key].byteLength > maximums[key]) {
      fail(STATUS.inputInvalid);
    }
    selected[key] = Buffer.from(source[key]);
  }
  return selected;
}

function parseAuthority(bytes) {
  return parseCanonicalSubject(bytes, {
    maximum: MAXIMUM_AUTHORITY_BYTES,
    invalidCode: STATUS.authorityInvalid,
    noncanonicalCode: STATUS.authorityNoncanonical,
    parse: parseWindowsProductionAuthorityManifest,
    serialize: serializeWindowsProductionAuthorityManifest,
  });
}

function parsePresign(bytes) {
  return parseCanonicalSubject(bytes, {
    maximum: MAXIMUM_PRESIGN_BYTES,
    invalidCode: STATUS.presignInvalid,
    noncanonicalCode: STATUS.presignNoncanonical,
    parse: (text) => parseWindowsNativePresignReceipt(text),
    serialize: serializeWindowsNativePresignReceipt,
  });
}

function parseInventory(bytes) {
  return parseCanonicalSubject(bytes, {
    maximum: MAXIMUM_INVENTORY_BYTES,
    invalidCode: STATUS.inventoryInvalid,
    noncanonicalCode: STATUS.inventoryNoncanonical,
    parse: (text) => parseWindowsProductionAuthenticodeInventoryReceipt(text),
    serialize: serializeWindowsProductionAuthenticodeInventoryReceipt,
  });
}

function parseInstaller(bytes) {
  return parseCanonicalSubject(bytes, {
    maximum: MAXIMUM_INSTALLER_BYTES,
    invalidCode: STATUS.installerInvalid,
    noncanonicalCode: STATUS.installerNoncanonical,
    parse: (text) => parseWindowsProductionInstallerReceipt(text),
    serialize: serializeWindowsProductionInstallerReceipt,
  });
}

function parsePackagedArtifact(bytes) {
  try {
    return parsePackagedArtifactReceipt(bytes);
  } catch (error) {
    if (error?.code === WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_FIXED_STATUS.receiptNoncanonical) {
      fail(STATUS.packagedNoncanonical);
    }
    fail(STATUS.packagedInvalid);
  }
}

function validatePackagedArtifact(value) {
  try {
    return validatePackagedArtifactReceipt(value);
  } catch {
    fail(STATUS.receiptInvalid);
  }
}

function validateLedger(value) {
  const source = readRecord(value, LEDGER_KEYS, STATUS.ledgerInvalid);
  if (source.schemaVersion !== "tibotattle-windows-signing-operation-ledger-v1"
      || source.status !== "WINDOWS_SIGNING_OPERATION_LEDGER_RECORDED"
      || source.builder !== "app-builder-lib"
      || source.builderVersion !== "26.15.7"
      || source.ledgerCount !== 1) {
    fail(STATUS.ledgerInvalid);
  }
  const classesSource = readRecord(source.classes, LEDGER_CLASS_KEYS, STATUS.ledgerInvalid);
  const classes = {};
  for (const key of LEDGER_CLASS_KEYS) {
    classes[key] = assertNonNegativeInteger(classesSource[key], 1000000, STATUS.ledgerInvalid);
  }
  if (classes.node !== 0 || classes.unexpected !== 0
      || classes.exe + classes.dll !== source.operationCount
      || source.operationCount <= 0) {
    fail(STATUS.ledgerInvalid);
  }
  return deepFreeze({
    schemaVersion: source.schemaVersion,
    status: source.status,
    builder: source.builder,
    builderVersion: source.builderVersion,
    ledgerCount: source.ledgerCount,
    operationCount: source.operationCount,
    classes: {
      exe: classes.exe,
      dll: classes.dll,
      node: classes.node,
      unexpected: classes.unexpected,
    },
  });
}

function serializeLedger(value) {
  return `${JSON.stringify(validateLedger(value))}\n`;
}

function parseLedger(bytes) {
  const parsed = parseRawJson(bytes, MAXIMUM_LEDGER_BYTES, STATUS.ledgerInvalid, STATUS.ledgerNoncanonical);
  const selected = validateLedger(parsed.value);
  if (serializeLedger(selected) !== parsed.text) fail(STATUS.ledgerNoncanonical);
  return selected;
}

function compareModuleFacts(authority, presign) {
  if (authority.nativePresign.schemaVersion !== WINDOWS_NATIVE_PRESIGN_SCHEMA
      || authority.nativePresign.status !== WINDOWS_NATIVE_PRESIGN_STATUS
      || authority.nativePresign.target !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET
      || authority.nativePresign.revision !== authority.sourceRevision
      || authority.nativePresign.packageVersion !== authority.packageVersion
      || authority.nativePresign.qualificationHandoffSha256
        !== authority.sourceQualification.handoff.sha256
      || authority.nativePresign.certificateSubjectSha256
        !== presign.certificateSubjectSha256) fail(STATUS.mismatch);
  if (presign.schemaVersion !== WINDOWS_NATIVE_PRESIGN_SCHEMA
      || presign.status !== WINDOWS_NATIVE_PRESIGN_STATUS
      || presign.target !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET
      || presign.revision !== authority.sourceRevision
      || presign.packageVersion !== authority.packageVersion
      || presign.qualificationHandoffSha256
        !== authority.sourceQualification.handoff.sha256) fail(STATUS.mismatch);
  if (authority.nativeModules.length !== WINDOWS_NATIVE_PRESIGN_MODULES.length
      || presign.modules.length !== WINDOWS_NATIVE_PRESIGN_MODULES.length) fail(STATUS.mismatch);
  for (let index = 0; index < WINDOWS_NATIVE_PRESIGN_MODULES.length; index += 1) {
    const expected = WINDOWS_NATIVE_PRESIGN_MODULES[index];
    const authorityModule = authority.nativeModules[index];
    const presignModule = presign.modules[index];
    if (authorityModule.name !== expected.name
        || authorityModule.packagedPath !== expected.packagedPath
        || presignModule.name !== expected.name
        || presignModule.packagedPath !== expected.packagedPath
        || authorityModule.unsignedBytes !== presignModule.unsignedBytes
        || authorityModule.signedBytes !== presignModule.signedBytes
        || authorityModule.unsignedSha256 !== presignModule.unsignedSha256
        || authorityModule.signedSha256 !== presignModule.signedSha256
        || presignModule.authenticode.publisher !== authority.signerPolicy.publisher
        || presignModule.authenticode.subjectSha256
          !== authority.nativePresign.certificateSubjectSha256
        || presignModule.authenticode.status !== "Valid"
        || presignModule.authenticode.timestampPresent !== true
        || presignModule.authenticode.signtoolPaValid !== true
        || presignModule.authenticode.policy !== "authenticode-pa") {
      fail(STATUS.mismatch);
    }
  }
}

function compareInventoryFacts(
  authority,
  presign,
  inventory,
  inventoryHash,
  { allowInjected = false } = {},
) {
  if (inventory.probeMode !== "native-windows"
      && !(allowInjected && inventory.probeMode === "injected")) {
    fail(STATUS.probeModeInvalid);
  }
  if (inventory.revision !== authority.sourceRevision
      || inventory.packageVersion !== authority.packageVersion
      || inventory.publisher !== authority.signerPolicy.publisher
      || inventory.status !== WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_STATUS
      || inventory.schemaVersion !== WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_SCHEMA) {
    fail(STATUS.mismatch);
  }
  // Every PE row must carry the exact full certificate Subject digest that
  // was approved by the protected Azure profile preflight.  SimpleName alone
  // is not a sufficient identity: two certificates can expose the same
  // publisher name while having different distinguished Subjects.
  const expectedSubjectSha256 = authority.nativePresign.certificateSubjectSha256;
  if (inventory.files.some(
    (row) => row.authenticode.subjectSha256 !== expectedSubjectSha256,
  )) {
    fail(STATUS.mismatch);
  }
  const nativeRows = new Map(
    inventory.files
      .filter(({ role }) => role === "native-module")
      .map((row) => [row.path, row]),
  );
  for (const module of presign.modules) {
    const row = nativeRows.get(module.packagedPath);
    if (!row
        || row.bytes !== module.signedBytes
        || row.sha256 !== module.signedSha256) fail(STATUS.mismatch);
  }
  const installerRow = inventory.files.find(({ role }) => role === "installer");
  if (!installerRow
      || inventory.installer.bytes !== installerRow.bytes
      || inventory.installer.sha256 !== installerRow.sha256) fail(STATUS.mismatch);
  return inventoryHash;
}

function compareInstallerFacts(
  authority,
  authorityBytes,
  inventory,
  inventoryHash,
  installer,
  authorityHash,
) {
  if (installer.receiptSchemaVersion !== WINDOWS_PRODUCTION_INSTALLER_SCHEMA
      || installer.status !== WINDOWS_PRODUCTION_INSTALLER_STATUS
      || installer.target !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET
      || installer.revision !== authority.sourceRevision
      || installer.publisher !== authority.signerPolicy.publisher
      || installer.authority.sha256 !== authorityHash
      || installer.authority.bytes !== authorityBytes.byteLength
      || installer.authority.inventorySha256 !== inventoryHash
      || installer.signature.required !== true
      || installer.signature.source !== "authenticode_inventory_native_windows"
      || installer.signature.status !== "verified"
      || Object.values(installer.lifecycle).some((value) => value !== "not_run")
      || installer.nativeProof.status !== "not_run"
      || installer.publication.enabled !== false
      || installer.publication.distribution !== "unpublished") {
    fail(STATUS.mismatch);
  }
  const installerRow = inventory.files.find(({ role }) => role === "installer");
  if (!installerRow
      || installer.artifact.bytes !== installerRow.bytes
      || installer.artifact.sha256 !== installerRow.sha256) fail(STATUS.mismatch);
}

function projectQualification(authority) {
  const source = authority.sourceQualification;
  return {
    workflow: source.workflow,
    run: source.run,
    runAttempt: source.runAttempt,
    ref: source.ref,
    revision: source.revision,
    handoffSha256: source.handoff.sha256,
    receipts: source.receipts.map((receipt) => ({
      artifactDigest: receipt.artifactDigest,
      artifactId: receipt.artifactId,
      cacheMode: receipt.cacheMode,
      rawReceiptSha256: receipt.rawReceiptSha256,
    })),
  };
}

function buildReceipt(subjects, { nativeReceipt = null, allowInjected = false } = {}) {
  const {
    authority,
    authorityBytes,
    authorityHash,
    presign,
    presignBytes,
    presignHash,
    ledger,
    ledgerBytes,
    ledgerHash,
    packaged,
    packagedBytes,
    packagedHash,
    inventory,
    inventoryBytes,
    inventoryHash,
    installer,
    installerBytes,
    installerHash,
  } = subjects;
  if (nativeReceipt !== null && inventory !== nativeReceipt) {
    fail(STATUS.probeModeInvalid);
  }
  if (nativeReceipt === null && !allowInjected) {
    fail(STATUS.probeModeInvalid);
  }
  if (authority.sourceRevision !== presign.revision
      || authority.packageVersion !== presign.packageVersion
      || authority.signerPolicy.publisher !== inventory.publisher
      || authority.sourceRevision !== inventory.revision
      || authority.packageVersion !== inventory.packageVersion
      || authority.sourceRevision !== installer.revision
      || authority.packageVersion !== inferInstallerVersion(installer.artifact.name)) {
    fail(STATUS.mismatch);
  }
  compareModuleFacts(authority, presign);
  compareInventoryFacts(authority, presign, inventory, inventoryHash, { allowInjected });
  compareInstallerFacts(
    authority,
    authorityBytes,
    inventory,
    inventoryHash,
    installer,
    authorityHash,
  );
  if (authority.nativePresign.receiptSha256 !== presignHash
      || packaged.status !== WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_STATUS
      || packaged.target !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET
      || packaged.authority.bytes !== authorityBytes.byteLength
      || packaged.authority.sha256 !== authorityHash
      || installer.authority.bytes !== authorityBytes.byteLength
      || installer.authority.sha256 !== authorityHash
      || installerBytes.byteLength <= 0
      || packaged.ledger.bytes !== ledgerBytes.byteLength
      || packaged.ledger.sha256 !== ledgerHash
      || packaged.peInventory.bytes !== inventory.inventory.bytes
      || packaged.peInventory.count !== inventory.inventory.count
      || packaged.peInventory.sha256 !== inventory.inventory.sha256
      || packaged.peInventory.signedCount !== inventory.inventory.signedCount
      || ledger.classes.node !== 0
      || ledger.classes.unexpected !== 0) {
    fail(STATUS.mismatch);
  }
  const receipt = {
    schemaVersion: WINDOWS_PRODUCTION_FINALIZER_RECEIPT_SCHEMA,
    status: WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS,
    target: WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET,
    revision: authority.sourceRevision,
    packageVersion: authority.packageVersion,
    publisher: authority.signerPolicy.publisher,
    authority: {
      bytes: authorityBytes.byteLength,
      sha256: authorityHash,
      receipt: authority,
    },
    qualification: projectQualification(authority),
    preparation: authority.preparation,
    nativePresign: {
      bytes: presignBytes.byteLength,
      sha256: presignHash,
      receipt: presign,
    },
    signingLedger: {
      bytes: ledgerBytes.byteLength,
      sha256: ledgerHash,
      receipt: ledger,
    },
    packagedArtifact: {
      bytes: packagedBytes.byteLength,
      sha256: packagedHash,
      receipt: packaged,
    },
    authenticode: {
      bytes: inventoryBytes.byteLength,
      sha256: inventoryHash,
      receipt: inventory,
      signature: {
        policy: "authenticode-pa",
        publisher: inventory.publisher,
        signtoolPaValid: true,
        status: "Valid",
        timestampPresent: true,
      },
    },
    installer: {
      bytes: installerBytes.byteLength,
      sha256: installerHash,
      receipt: installer,
    },
    installedLifecycle: { ...INSTALLED_LIFECYCLE },
    production: {
      distribution: "unpublished",
      enabled: false,
      ready: false,
    },
  };
  return validateFinalizerReceipt(receipt, { allowInjected });
}

function inferInstallerVersion(name) {
  const match = /^TiboTattle-(.+)-Windows-x64\.exe$/u.exec(name);
  if (!match || !VERSION_PATTERN.test(match[1])) fail(STATUS.mismatch);
  return match[1];
}

function validateFinalizerReceipt(value, { allowInjected = false } = {}) {
  const source = readRecord(value, RECEIPT_KEYS, STATUS.receiptInvalid);
  if (source.schemaVersion !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_SCHEMA
      || source.status !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS
      || source.target !== WINDOWS_PRODUCTION_FINALIZER_RECEIPT_TARGET) fail(STATUS.receiptInvalid);
  const revision = assertRevision(source.revision, STATUS.receiptInvalid);
  const packageVersion = assertVersion(source.packageVersion, STATUS.receiptInvalid);
  const publisher = assertPublisher(source.publisher, STATUS.receiptInvalid);
  const authoritySource = readRecord(source.authority, ["bytes", "receipt", "sha256"], STATUS.receiptInvalid);
  const authorityReceipt = validateWindowsProductionAuthorityManifest(authoritySource.receipt);
  const authority = {
    bytes: assertPositiveInteger(authoritySource.bytes, MAXIMUM_AUTHORITY_BYTES, STATUS.receiptInvalid),
    sha256: assertDigest(authoritySource.sha256, STATUS.receiptInvalid),
    receipt: authorityReceipt,
  };
  const qualification = readRecord(source.qualification, [
    "handoffSha256",
    "receipts",
    "ref",
    "revision",
    "run",
    "runAttempt",
    "workflow",
  ], STATUS.receiptInvalid);
  if (qualification.revision !== revision
      || authorityReceipt.sourceQualification.handoff.sha256 !== qualification.handoffSha256
      || !Array.isArray(qualification.receipts)) fail(STATUS.receiptInvalid);
  const qualificationReceipts = readArray(qualification.receipts, 2, STATUS.receiptInvalid).map((entry) => {
    const valueAtEntry = readRecord(entry, ["artifactDigest", "artifactId", "cacheMode", "rawReceiptSha256"], STATUS.receiptInvalid);
    if (valueAtEntry.cacheMode !== "warm" && valueAtEntry.cacheMode !== "clean") fail(STATUS.receiptInvalid);
    assertPositiveInteger(valueAtEntry.artifactId, Number.MAX_SAFE_INTEGER, STATUS.receiptInvalid);
    assertDigest(valueAtEntry.rawReceiptSha256, STATUS.receiptInvalid);
    if (typeof valueAtEntry.artifactDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(valueAtEntry.artifactDigest)) fail(STATUS.receiptInvalid);
    return valueAtEntry;
  });
  if (new Set(qualificationReceipts.map(({ cacheMode }) => cacheMode)).size !== 2) fail(STATUS.receiptInvalid);
  const canonicalQualification = projectQualification(authorityReceipt);
  const normalizedQualification = {
    ...qualification,
    receipts: qualificationReceipts,
  };
  if (JSON.stringify(stableValue(normalizedQualification))
      !== JSON.stringify(stableValue(canonicalQualification))) {
    fail(STATUS.receiptInvalid);
  }
  const preparation = readRecord(source.preparation, PREPARATION_KEYS, STATUS.receiptInvalid);
  const preparationHandoff = readRecord(
    preparation.handoff,
    PREPARATION_HANDOFF_KEYS,
    STATUS.receiptInvalid,
  );
  const preparationSource = readRecord(
    preparation.source,
    PREPARATION_SOURCE_KEYS,
    STATUS.receiptInvalid,
  );
  const preparationWorkflow = readRecord(
    preparation.workflow,
    PREPARATION_WORKFLOW_KEYS,
    STATUS.receiptInvalid,
  );
  assertDigest(preparationHandoff.sha256, STATUS.receiptInvalid);
  assertRevision(preparationSource.revision, STATUS.receiptInvalid);
  assertRevision(preparationWorkflow.revision, STATUS.receiptInvalid);
  assertPositiveInteger(preparationSource.run, Number.MAX_SAFE_INTEGER, STATUS.receiptInvalid);
  assertPositiveInteger(preparationSource.runAttempt, Number.MAX_SAFE_INTEGER, STATUS.receiptInvalid);
  assertPositiveInteger(preparationWorkflow.run, Number.MAX_SAFE_INTEGER, STATUS.receiptInvalid);
  assertPositiveInteger(preparationWorkflow.runAttempt, Number.MAX_SAFE_INTEGER, STATUS.receiptInvalid);
  if (JSON.stringify(stableValue(preparation))
      !== JSON.stringify(stableValue(authorityReceipt.preparation))) {
    fail(STATUS.receiptInvalid);
  }
  const presignSource = readRecord(source.nativePresign, ["bytes", "receipt", "sha256"], STATUS.receiptInvalid);
  const presign = validateWindowsNativePresignReceipt(presignSource.receipt);
  const packagedSource = readRecord(source.packagedArtifact, ["bytes", "receipt", "sha256"], STATUS.receiptInvalid);
  const packaged = validatePackagedArtifact(packagedSource.receipt);
  const ledgerSource = readRecord(source.signingLedger, ["bytes", "receipt", "sha256"], STATUS.receiptInvalid);
  const ledger = validateLedger(ledgerSource.receipt);
  const inventorySource = readRecord(source.authenticode, ["bytes", "receipt", "sha256", "signature"], STATUS.receiptInvalid);
  const inventory = validateWindowsProductionAuthenticodeInventoryReceipt(inventorySource.receipt);
  const signature = readRecord(inventorySource.signature, ["policy", "publisher", "signtoolPaValid", "status", "timestampPresent"], STATUS.receiptInvalid);
  if (signature.policy !== "authenticode-pa"
      || signature.publisher !== publisher
      || signature.signtoolPaValid !== true
      || signature.status !== "Valid"
      || signature.timestampPresent !== true) fail(STATUS.receiptInvalid);
  const installerSource = readRecord(source.installer, ["bytes", "receipt", "sha256"], STATUS.receiptInvalid);
  const installer = validateWindowsProductionInstallerReceipt(installerSource.receipt);
  const lifecycle = readRecord(source.installedLifecycle, LIFECYCLE_KEYS, STATUS.receiptInvalid);
  if (Object.values(lifecycle).some((value) => value !== "not_run")) fail(STATUS.receiptInvalid);
  const production = readRecord(source.production, PRODUCTION_KEYS, STATUS.receiptInvalid);
  if (production.distribution !== "unpublished" || production.enabled !== false || production.ready !== false) fail(STATUS.receiptInvalid);
  if (authorityReceipt.sourceRevision !== revision
      || authorityReceipt.packageVersion !== packageVersion
      || authorityReceipt.signerPolicy.publisher !== publisher
      || presign.revision !== revision
      || presign.packageVersion !== packageVersion
      || inventory.revision !== revision
      || inventory.packageVersion !== packageVersion
      || installer.revision !== revision
      || installer.publisher !== publisher) fail(STATUS.receiptInvalid);
  const authorityCanonicalBytes = Buffer.from(
    serializeWindowsProductionAuthorityManifest(authorityReceipt),
    "utf8",
  );
  const presignCanonicalBytes = Buffer.from(
    serializeWindowsNativePresignReceipt(presign),
    "utf8",
  );
  const packagedCanonicalBytes = Buffer.from(
    serializePackagedArtifactReceipt(packaged),
    "utf8",
  );
  const inventoryCanonicalBytes = Buffer.from(
    serializeWindowsProductionAuthenticodeInventoryReceipt(inventory),
    "utf8",
  );
  const installerCanonicalBytes = Buffer.from(
    serializeWindowsProductionInstallerReceipt(installer),
    "utf8",
  );
  if (authoritySource.bytes !== authorityCanonicalBytes.byteLength
      || authoritySource.sha256 !== sha256(authorityCanonicalBytes)
      || presignSource.bytes !== presignCanonicalBytes.byteLength
      || presignSource.sha256 !== sha256(presignCanonicalBytes)
      || ledgerSource.bytes !== Buffer.byteLength(serializeLedger(ledgerSource.receipt), "utf8")
      || ledgerSource.sha256 !== sha256(Buffer.from(serializeLedger(ledgerSource.receipt), "utf8"))
      || packagedSource.bytes !== packagedCanonicalBytes.byteLength
      || packagedSource.sha256 !== sha256(packagedCanonicalBytes)
      || inventorySource.bytes !== inventoryCanonicalBytes.byteLength
      || inventorySource.sha256 !== sha256(inventoryCanonicalBytes)
      || installerSource.bytes !== installerCanonicalBytes.byteLength
      || installerSource.sha256 !== sha256(installerCanonicalBytes)
      || authorityReceipt.nativePresign.receiptSha256 !== presignSource.sha256
      || packaged.authority.bytes !== authoritySource.bytes
      || packaged.authority.sha256 !== authoritySource.sha256
      || installer.authority.bytes !== authoritySource.bytes
      || installer.authority.sha256 !== authoritySource.sha256
      || installer.authority.inventorySha256 !== inventorySource.sha256
      || packaged.ledger.bytes !== ledgerSource.bytes
      || packaged.ledger.sha256 !== ledgerSource.sha256
      || packaged.peInventory.bytes !== inventory.inventory.bytes
      || packaged.peInventory.count !== inventory.inventory.count
      || packaged.peInventory.sha256 !== inventory.inventory.sha256
      || packaged.peInventory.signedCount !== inventory.inventory.signedCount) {
    fail(STATUS.receiptInvalid);
  }
  compareModuleFacts(authorityReceipt, presign);
  compareInventoryFacts(
    authorityReceipt,
    presign,
    inventory,
    inventorySource.sha256,
    { allowInjected },
  );
  compareInstallerFacts(
    authorityReceipt,
    { byteLength: authoritySource.bytes },
    inventory,
    inventorySource.sha256,
    installer,
    authoritySource.sha256,
  );
  if (packaged.nativeFileCount !== WINDOWS_PRODUCTION_AUTHORITY_NATIVE_MODULES.length
      || ledger.classes.node !== 0
      || ledger.classes.unexpected !== 0) fail(STATUS.receiptInvalid);
  return deepFreeze({
    schemaVersion: source.schemaVersion,
    status: source.status,
    target: source.target,
    revision,
    packageVersion,
    publisher,
    authority,
    qualification: {
      ...qualification,
      receipts: qualificationReceipts,
    },
    preparation,
    nativePresign: {
      bytes: assertPositiveInteger(presignSource.bytes, MAXIMUM_PRESIGN_BYTES, STATUS.receiptInvalid),
      sha256: assertDigest(presignSource.sha256, STATUS.receiptInvalid),
      receipt: presign,
    },
    signingLedger: {
      bytes: assertPositiveInteger(ledgerSource.bytes, MAXIMUM_LEDGER_BYTES, STATUS.receiptInvalid),
      sha256: assertDigest(ledgerSource.sha256, STATUS.receiptInvalid),
      receipt: ledger,
    },
    packagedArtifact: {
      bytes: assertPositiveInteger(packagedSource.bytes, MAXIMUM_PACKAGED_BYTES, STATUS.receiptInvalid),
      sha256: assertDigest(packagedSource.sha256, STATUS.receiptInvalid),
      receipt: packaged,
    },
    authenticode: {
      bytes: assertPositiveInteger(inventorySource.bytes, MAXIMUM_INVENTORY_BYTES, STATUS.receiptInvalid),
      sha256: assertDigest(inventorySource.sha256, STATUS.receiptInvalid),
      receipt: inventory,
      signature,
    },
    installer: {
      bytes: assertPositiveInteger(installerSource.bytes, MAXIMUM_INSTALLER_BYTES, STATUS.receiptInvalid),
      sha256: assertDigest(installerSource.sha256, STATUS.receiptInvalid),
      receipt: installer,
    },
    installedLifecycle: { ...lifecycle },
    production: { ...production },
  });
}

export function validateWindowsProductionFinalizerReceipt(value) {
  return validateFinalizerReceipt(value);
}

/** Validate an injected, portable fixture receipt; never a production claim. */
export function validateWindowsProductionFinalizerReceiptForTest(value) {
  return validateFinalizerReceipt(value, { allowInjected: true });
}

export function serializeWindowsProductionFinalizerReceipt(value) {
  const selected = validateFinalizerReceipt(value);
  const serialized = stableJson(selected);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECEIPT_BYTES) fail(STATUS.outputInvalid);
  return serialized;
}

/** Serialize only the explicitly test-only injected receipt shape. */
export function serializeWindowsProductionFinalizerReceiptForTest(value) {
  const selected = validateFinalizerReceipt(value, { allowInjected: true });
  const serialized = stableJson(selected);
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECEIPT_BYTES) fail(STATUS.outputInvalid);
  return serialized;
}

export function parseWindowsProductionFinalizerReceipt(value) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") fail(STATUS.receiptInvalid);
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_RECEIPT_BYTES) fail(STATUS.receiptInvalid);
  const parsed = parseRawJson(bytes, MAXIMUM_RECEIPT_BYTES, STATUS.receiptInvalid, STATUS.receiptNoncanonical);
  const selected = validateFinalizerReceipt(parsed.value);
  if (stableJson(selected) !== parsed.text) fail(STATUS.receiptNoncanonical);
  return selected;
}

/** Parse only the explicitly test-only injected receipt shape. */
export function parseWindowsProductionFinalizerReceiptForTest(value) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") fail(STATUS.receiptInvalid);
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_RECEIPT_BYTES) fail(STATUS.receiptInvalid);
  const parsed = parseRawJson(bytes, MAXIMUM_RECEIPT_BYTES, STATUS.receiptInvalid, STATUS.receiptNoncanonical);
  const selected = validateFinalizerReceipt(parsed.value, { allowInjected: true });
  if (stableJson(selected) !== parsed.text) fail(STATUS.receiptNoncanonical);
  return selected;
}

export async function buildWindowsProductionFinalizerReceipt(options) {
  const source = readOptions(options);
  const hashes = Object.fromEntries(
    OPTION_KEYS.map((key) => [key, sha256(source[key])]),
  );
  const authority = parseAuthority(source.authorityBytes);
  const presign = parsePresign(source.nativePresignBytes);
  const ledger = parseLedger(source.signingLedgerBytes);
  const packaged = parsePackagedArtifact(source.packagedArtifactBytes);
  const inventory = parseInventory(source.authenticodeInventoryBytes);
  const installer = parseInstaller(source.installerBytes);
  return buildReceipt({
    authority,
    authorityBytes: source.authorityBytes,
    authorityHash: hashes.authorityBytes,
    presign,
    presignBytes: source.nativePresignBytes,
    presignHash: hashes.nativePresignBytes,
    ledger,
    ledgerBytes: source.signingLedgerBytes,
    ledgerHash: hashes.signingLedgerBytes,
    packaged,
    packagedBytes: source.packagedArtifactBytes,
    packagedHash: hashes.packagedArtifactBytes,
    inventory,
    inventoryBytes: source.authenticodeInventoryBytes,
    inventoryHash: hashes.authenticodeInventoryBytes,
    installer,
    installerBytes: source.installerBytes,
    installerHash: hashes.installerBytes,
  });
}

/**
 * Portable pure join for injected fixtures.  It is deliberately separate
 * from the production builder and emits `probeMode: injected`, never a native
 * provenance claim.
 */
export async function buildWindowsProductionFinalizerReceiptForTest(options) {
  const source = readOptions(options);
  const hashes = Object.fromEntries(
    OPTION_KEYS.map((key) => [key, sha256(source[key])]),
  );
  const authority = parseAuthority(source.authorityBytes);
  const presign = parsePresign(source.nativePresignBytes);
  const ledger = parseLedger(source.signingLedgerBytes);
  const packaged = parsePackagedArtifact(source.packagedArtifactBytes);
  const inventory = parseInventory(source.authenticodeInventoryBytes);
  const installer = parseInstaller(source.installerBytes);
  if (inventory.probeMode !== "injected") fail(STATUS.probeModeInvalid);
  return buildReceipt({
    authority,
    authorityBytes: source.authorityBytes,
    authorityHash: hashes.authorityBytes,
    presign,
    presignBytes: source.nativePresignBytes,
    presignHash: hashes.nativePresignBytes,
    ledger,
    ledgerBytes: source.signingLedgerBytes,
    ledgerHash: hashes.signingLedgerBytes,
    packaged,
    packagedBytes: source.packagedArtifactBytes,
    packagedHash: hashes.packagedArtifactBytes,
    inventory,
    inventoryBytes: source.authenticodeInventoryBytes,
    inventoryHash: hashes.authenticodeInventoryBytes,
    installer,
    installerBytes: source.installerBytes,
    installerHash: hashes.installerBytes,
  }, { allowInjected: true });
}

const FIXED_READ_ONLY_FLAGS = fsConstants.O_RDONLY
  | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));

async function readFixedEvidenceFile(rootState, leaf, maximum, code) {
  if (typeof leaf !== "string"
      || leaf.length === 0
      || leaf.includes("\0")
      || leaf.includes("/")
      || leaf.includes("\\")) {
    fail(STATUS.inputInvalid);
  }
  await assertRootState(rootState);
  const path = join(rootState.path, leaf);
  if (!pathInside(rootState.path, path)) fail(STATUS.rootsInvalid);
  await assertNoSymlinkPathComponents(path, code);
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") fail(STATUS.inputMissing);
    fail(code);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || !Number.isSafeInteger(before.size) || before.size <= 0 || before.size > maximum) {
    fail(code);
  }
  let handle;
  try {
    handle = await open(path, FIXED_READ_ONLY_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink?.() || opened.nlink !== 1
        || opened.size !== before.size || !sameIdentity(opened, before)) {
      fail(code);
    }
    const bytes = Buffer.from(await handle.readFile());
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink?.() || after.nlink !== 1
        || after.size !== bytes.byteLength
        || after.size !== before.size
        || !sameIdentity(after, before)
        || !sameIdentity(pathAfter, before)
        || pathAfter.nlink !== 1) {
      fail(code);
    }
    await assertRootState(rootState);
    return bytes;
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerReceiptError) throw error;
    if (error?.code === "ENOENT") fail(STATUS.inputMissing);
    fail(code);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function runClosedFinalizerForTest(evidenceRootPath) {
  const root = await captureRoot(evidenceRootPath);
  const authorityBytes = await readFixedEvidenceFile(
    root,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_LEAF,
    MAXIMUM_AUTHORITY_BYTES,
    STATUS.authorityInvalid,
  );
  const authority = parseAuthority(authorityBytes);
  const revision = authority.sourceRevision;
  const subjects = {
    authorityBytes,
    nativePresignBytes: await readFixedEvidenceFile(
      root,
      `${WINDOWS_PRODUCTION_FINALIZER_PRESIGN_LEAF_PREFIX}${revision}.json`,
      MAXIMUM_PRESIGN_BYTES,
      STATUS.presignInvalid,
    ),
    signingLedgerBytes: await readFixedEvidenceFile(
      root,
      WINDOWS_PRODUCTION_FINALIZER_SIGNING_LEDGER_LEAF,
      MAXIMUM_LEDGER_BYTES,
      STATUS.ledgerInvalid,
    ),
    packagedArtifactBytes: await readFixedEvidenceFile(
      root,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_FILE,
      MAXIMUM_PACKAGED_BYTES,
      STATUS.packagedInvalid,
    ),
    authenticodeInventoryBytes: await readFixedEvidenceFile(
      root,
      WINDOWS_PRODUCTION_AUTHENTICODE_INVENTORY_FILE,
      MAXIMUM_INVENTORY_BYTES,
      STATUS.inventoryInvalid,
    ),
    installerBytes: await readFixedEvidenceFile(
      root,
      WINDOWS_PRODUCTION_INSTALLER_RECEIPT_FILE,
      MAXIMUM_INSTALLER_BYTES,
      STATUS.installerInvalid,
    ),
  };
  const receipt = await buildWindowsProductionFinalizerReceiptForTest(subjects);
  await assertRootState(root);
  const publication = await writeReceiptOnce(root, receipt, null, {}, { allowInjected: true });
  return Object.freeze({ receipt, publication });
}

/** Portable test seam for the closed fixed-leaf CLI runner. */
export async function runWindowsProductionFinalizerReceiptForTest(evidenceRoot) {
  if (typeof evidenceRoot !== "string" || evidenceRoot.length === 0) fail(STATUS.inputInvalid);
  return runClosedFinalizerForTest(resolve(evidenceRoot));
}

/**
 * Production-only finalizer composition.  Native Authenticode collection is
 * the first operation and returns an in-memory branded receipt; serialized
 * Authenticode or installer leaves are never used as authority.  The final
 * command publishes only the installer receipt derived from that branded
 * object and the aggregate receipt. Stale pre-existing leaves cannot bypass
 * native collection or be mistaken for the receipt consumed below.
 */
async function runProductionFinalizer() {
  const nativeReceipt = await collectWindowsProductionAuthenticodeInventoryForFinalizer();
  const nativeEvidence = assertNativeWindowsProductionAuthenticodeInventoryReceipt(nativeReceipt);
  const root = await captureRoot(WINDOWS_PRODUCTION_FINALIZER_RECEIPT_ROOT);
  const authorityBytes = await readFixedEvidenceFile(
    root,
    WINDOWS_PRODUCTION_FINALIZER_AUTHORITY_LEAF,
    MAXIMUM_AUTHORITY_BYTES,
    STATUS.authorityInvalid,
  );
  const authority = parseAuthority(authorityBytes);
  const revision = authority.sourceRevision;
  const subjects = {
    authorityBytes,
    nativePresignBytes: await readFixedEvidenceFile(
      root,
      `${WINDOWS_PRODUCTION_FINALIZER_PRESIGN_LEAF_PREFIX}${revision}.json`,
      MAXIMUM_PRESIGN_BYTES,
      STATUS.presignInvalid,
    ),
    signingLedgerBytes: await readFixedEvidenceFile(
      root,
      WINDOWS_PRODUCTION_FINALIZER_SIGNING_LEDGER_LEAF,
      MAXIMUM_LEDGER_BYTES,
      STATUS.ledgerInvalid,
    ),
    packagedArtifactBytes: await readFixedEvidenceFile(
      root,
      WINDOWS_PRODUCTION_PACKAGED_ARTIFACT_RECEIPT_FILE,
      MAXIMUM_PACKAGED_BYTES,
      STATUS.packagedInvalid,
    ),
    authenticodeInventoryBytes: nativeEvidence.bytes,
    installerBytes: null,
  };
  const installer = await verifyWindowsProductionInstaller({
    authorityBytes,
    authenticodeInventoryBytes: nativeEvidence.bytes,
  });
  subjects.installerBytes = Buffer.from(
    serializeWindowsProductionInstallerReceipt(installer),
    "utf8",
  );
  // Publish the installer leaf only after it has been verified against the
  // branded native inventory.  The writer is fixed-root/no-clobber; an
  // independently pre-existing installer receipt therefore stops the run.
  await writeWindowsProductionInstallerReceipt(installer);
  const source = readOptions(subjects);
  const hashes = Object.fromEntries(
    OPTION_KEYS.map((key) => [key, sha256(source[key])]),
  );
  const presign = parsePresign(source.nativePresignBytes);
  const ledger = parseLedger(source.signingLedgerBytes);
  const packaged = parsePackagedArtifact(source.packagedArtifactBytes);
  // Keep the exact branded object returned by the collector; reparsing its
  // canonical bytes would discard the in-memory native provenance marker.
  const inventory = nativeReceipt;
  const installerReceipt = parseInstaller(source.installerBytes);
  const receipt = buildReceipt({
    authority,
    authorityBytes: source.authorityBytes,
    authorityHash: hashes.authorityBytes,
    presign,
    presignBytes: source.nativePresignBytes,
    presignHash: hashes.nativePresignBytes,
    ledger,
    ledgerBytes: source.signingLedgerBytes,
    ledgerHash: hashes.signingLedgerBytes,
    packaged,
    packagedBytes: source.packagedArtifactBytes,
    packagedHash: hashes.packagedArtifactBytes,
    inventory,
    inventoryBytes: source.authenticodeInventoryBytes,
    inventoryHash: hashes.authenticodeInventoryBytes,
    installer: installerReceipt,
    installerBytes: source.installerBytes,
    installerHash: hashes.installerBytes,
  }, { nativeReceipt });
  await assertRootState(root);
  const publication = await writeReceiptOnce(root, receipt, null, {});
  return Object.freeze({ receipt, publication });
}

/** Closed production seam; callers cannot redirect roots or supply subjects. */
export async function runWindowsProductionFinalizerReceiptForProduction(...args) {
  if (args.length !== 0) fail(STATUS.inputInvalid);
  return runProductionFinalizer();
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev
    && left?.ino === right?.ino;
}

function sameDirectoryIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function assertNoSymlinkPathComponents(path, code) {
  const selected = resolve(path);
  let current = selected;
  for (;;) {
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
      if (process.platform === "darwin"
          && current === "/var"
          && await realpath(current) === "/private/var") {
        current = dirname(current);
        continue;
      }
      fail(code);
    }
    if (!metadata.isDirectory() && current !== selected) fail(code);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function pathInside(parent, child) {
  const suffix = relative(resolve(parent), resolve(child));
  return suffix === ""
    || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function captureRoot(path, code = STATUS.rootsInvalid) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) fail(code);
  const selected = resolve(path);
  await assertNoSymlinkPathComponents(selected, code);
  let metadata;
  let canonical;
  try {
    metadata = await lstat(selected);
    canonical = await realpath(selected);
  } catch {
    fail(code);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== selected) fail(code);
  return Object.freeze({ path: selected, canonical, identity: metadata });
}

async function assertRootState(state) {
  await assertNoSymlinkPathComponents(state.path, STATUS.rootReplaced);
  let metadata;
  let canonical;
  try {
    metadata = await lstat(state.path);
    canonical = await realpath(state.path);
  } catch {
    fail(STATUS.rootReplaced);
  }
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || canonical !== state.canonical
      || !sameDirectoryIdentity(metadata, state.identity)) fail(STATUS.rootReplaced);
}

function readTestHooks(value) {
  if (value === undefined) return Object.freeze({});
  const source = readRecord(value, TEST_HOOK_KEYS, STATUS.outputInvalid);
  for (const key of TEST_HOOK_KEYS) {
    if (source[key] !== undefined && typeof source[key] !== "function") fail(STATUS.outputInvalid);
  }
  return source;
}

async function removeOwnedTemp(path, identity) {
  try {
    const metadata = await lstat(path);
    if (metadata.isFile() && (metadata.nlink === 1 || metadata.nlink === 2)
        && sameIdentity(metadata, identity)) await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeReceiptOnce(rootState, receipt, faultAt, testHooks, { allowInjected = false } = {}) {
  if (faultAt !== null && !TEST_FAULTS.has(faultAt)) fail(STATUS.outputInvalid);
  const serialized = allowInjected
    ? serializeWindowsProductionFinalizerReceiptForTest(receipt)
    : serializeWindowsProductionFinalizerReceipt(receipt);
  const bytes = Buffer.from(serialized, "utf8");
  await assertRootState(rootState);
  const outputPath = join(rootState.path, WINDOWS_PRODUCTION_FINALIZER_RECEIPT_LEAF);
  if (!pathInside(rootState.path, outputPath)) fail(STATUS.outputInvalid);
  const temporaryPath = join(
    rootState.path,
    `.${WINDOWS_PRODUCTION_FINALIZER_RECEIPT_LEAF}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryIdentity;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryIdentity = await handle.stat();
    if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1) fail(STATUS.outputInvalid);
    if (faultAt === "after-temp-open") fail(STATUS.outputInvalid);
    await handle.writeFile(bytes);
    if (faultAt === "after-temp-write") fail(STATUS.outputInvalid);
    await handle.sync();
    if (faultAt === "after-temp-sync") fail(STATUS.outputInvalid);
    await assertRootState(rootState);
    const existing = await lstat(outputPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      fail(STATUS.outputInvalid);
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) fail(STATUS.linkRejected);
      fail(STATUS.outputExists);
    }
    if (faultAt === "before-publish") fail(STATUS.outputInvalid);
    await testHooks.beforeOutputPublish?.();
    await assertRootState(rootState);
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error?.code === "EEXIST") fail(STATUS.outputExists);
      fail(STATUS.outputInvalid);
    }
    if (faultAt === "after-publish") fail(STATUS.outputInvalid);
    await testHooks.afterOutputPublish?.();
    await assertRootState(rootState);
    const published = await lstat(outputPath);
    if (!published.isFile()
        || published.isSymbolicLink()
        || published.nlink !== 2
        || published.size !== bytes.byteLength
        || !sameIdentity(published, temporaryIdentity)) fail(STATUS.outputInvalid);
    await unlink(temporaryPath);
    temporaryIdentity = null;
    const final = await lstat(outputPath);
    if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1) fail(STATUS.outputInvalid);
    return Object.freeze({
      bytes: final.size,
      path: outputPath,
      sha256: sha256(bytes),
    });
  } catch (error) {
    if (error instanceof WindowsProductionFinalizerReceiptError) throw error;
    fail(STATUS.outputInvalid);
  } finally {
    await handle?.close().catch(() => {});
    if (temporaryIdentity) await removeOwnedTemp(temporaryPath, temporaryIdentity);
  }
}

/** Write only to the fixed production evidence root; no path is accepted. */
export async function writeWindowsProductionFinalizerReceipt(receipt) {
  if (arguments.length !== 1) fail(STATUS.outputInvalid);
  const root = await captureRoot(WINDOWS_PRODUCTION_FINALIZER_RECEIPT_ROOT);
  return writeReceiptOnce(root, receipt, null, {});
}

/** Portable test seam for transactional/no-clobber and root-race tests. */
export async function writeWindowsProductionFinalizerReceiptForTest(
  testRoot,
  receipt,
  faultAt = null,
  testHooks = undefined,
) {
  if (arguments.length < 2 || arguments.length > 4) fail(STATUS.outputInvalid);
  const hooks = readTestHooks(testHooks);
  const root = await captureRoot(testRoot);
  return writeReceiptOnce(root, receipt, faultAt, hooks, { allowInjected: true });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (!Array.isArray(argv) || argv.length !== 0) fail(STATUS.inputInvalid);
    await runWindowsProductionFinalizerReceiptForProduction();
    process.stdout.write(`${WINDOWS_PRODUCTION_FINALIZER_RECEIPT_STATUS}\n`);
  } catch (error) {
    const status = Object.values(STATUS).includes(error?.code)
      ? error.code
      : STATUS.receiptInvalid;
    process.stderr.write(`${status}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === SCRIPT_FILE) {
  await main();
}
