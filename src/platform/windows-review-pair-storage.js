import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";

import {
  isWindowsFilesystemIdentity,
} from "./windows-filesystem.js";
import {
  isWindowsPreparedArtifactStorage,
} from "./windows-prepared-artifact-storage.js";

/**
 * Windows-only review-pair storage.
 *
 * The ordinary local-review writer is deliberately POSIX-shaped: it uses
 * Node's filesystem calls and hard links to make a receipt-first transaction.
 * Windows must not select that implementation.  This module presents the
 * same small pair concept over the root-bound prepared-artifact capability.
 * Every file operation below therefore carries the prepared root identity and
 * every publication is an identity-bound, no-clobber native rename.
 *
 * The capability remains qualification-only.  A successful operation here is
 * not a Windows production-readiness claim until the native matrix promotes
 * the underlying adapter.
 */
export const WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION =
  "windows-review-pair-storage-v1";
export const WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES =
  34 * 1024 * 1024;
export const WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES =
  1024 * 1024;
export const WINDOWS_REVIEW_PAIR_STORAGE_PRODUCTION_SAFE = false;
export const WINDOWS_REVIEW_PAIR_STORAGE_READINESS = false;
export const WINDOWS_REVIEW_PAIR_STORAGE_SAFE = false;

const REVIEW_TRANSACTION_ROOT = ".windows-review-pair-transactions";
const REVIEW_MANIFEST_NAME = "manifest.json";
const REVIEW_PREPARED_MARKER_NAME = "prepared.marker";
const REVIEW_TRANSACTION_SCHEMA = "windows-review-pair-transaction-v1";
const MAX_MANIFEST_BYTES = 64 * 1024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRANSACTION_DIRECTORY = /^transaction-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const ERROR_CODES = new Set([
  "invalid_configuration",
  "invalid_platform",
  "invalid_storage",
  "invalid_request",
  "invalid_path",
  "path_escape",
  "already_exists",
  "missing",
  "too_large",
  "identity_mismatch",
  "security_policy",
  "invalid_result",
  "recovery_conflict",
  "unavailable",
]);

const CONTEXTS = new WeakSet();
const ERRORS = new WeakSet();

export class WindowsReviewPairStorageError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows review pair storage error code");
    }
    // Do not include paths, transaction identifiers, native messages, or
    // artifact content in an error crossing the platform boundary.
    super("Windows review pair storage operation failed");
    this.name = "WindowsReviewPairStorageError";
    this.code = `windows_review_pair_storage_${code}`;
    ERRORS.add(this);
  }
}

export function isWindowsReviewPairStorageError(error) {
  try {
    return error instanceof WindowsReviewPairStorageError
      && ERRORS.has(error)
      && Object.getPrototypeOf(error)
        === WindowsReviewPairStorageError.prototype;
  } catch {
    return false;
  }
}

export function isWindowsReviewPairStorage(context) {
  try {
    return context !== null
      && typeof context === "object"
      && CONTEXTS.has(context);
  } catch {
    return false;
  }
}

function fail(code) {
  throw new WindowsReviewPairStorageError(code);
}

function nativeCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
}

function mapPreparedFailure(error, fallback = "unavailable") {
  if (isWindowsReviewPairStorageError(error)) throw error;
  const code = nativeCode(error);
  if (code.endsWith("_missing") || code === "ENOENT"
      || code === "WINDOWS_FILESYSTEM_NOT_FOUND") fail("missing");
  if (code.endsWith("_already_exists") || code === "EEXIST"
      || code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS") fail("already_exists");
  if (code.endsWith("_identity_mismatch")
      || code === "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH") {
    fail("identity_mismatch");
  }
  if (code.endsWith("_too_large")
      || code === "WINDOWS_FILESYSTEM_PREPARED_FILE_TOO_LARGE"
      || code === "WINDOWS_FILESYSTEM_INVALID_PREPARED_MAXIMUM_BYTES") {
    fail("too_large");
  }
  if (code.endsWith("_security_policy")
      || code === "WINDOWS_FILESYSTEM_REPARSE_POINT"
      || code === "WINDOWS_FILESYSTEM_HARD_LINK"
      || code === "WINDOWS_FILESYSTEM_SECURITY_POLICY") {
    fail("security_policy");
  }
  if (code.endsWith("_invalid_path")
      || code === "WINDOWS_FILESYSTEM_INVALID_PATH") fail("invalid_path");
  fail(fallback);
}

function invokeStorage(storage, method, argumentsList, fallback = "unavailable") {
  try {
    const callable = storage[method];
    if (typeof callable !== "function") fail("invalid_storage");
    return Reflect.apply(callable, storage, argumentsList);
  } catch (error) {
    mapPreparedFailure(error, fallback);
  }
}

async function invokeStorageAsync(storage, method, argumentsList, fallback = "unavailable") {
  try {
    const callable = storage[method];
    if (typeof callable !== "function") fail("invalid_storage");
    return await Reflect.apply(callable, storage, argumentsList);
  } catch (error) {
    mapPreparedFailure(error, fallback);
  }
}

function invalidComponent(component) {
  if (component.length === 0
      || component === "."
      || component === ".."
      || component.endsWith(".")
      || component.endsWith(" ")
      || /[<>:"|?*]/u.test(component)) {
    return true;
  }
  return RESERVED_DEVICE_NAMES.has(component.split(".", 1)[0].toUpperCase());
}

function relativeComponents(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string"
      || value.length > 32_767
      || value.includes("\0")) fail("invalid_path");
  const raw = value.replaceAll("/", "\\");
  if (raw.length === 0) {
    if (allowEmpty) return [];
    fail("invalid_path");
  }
  if (win32.isAbsolute(raw) || /^[A-Za-z]:/u.test(raw) || raw.startsWith("\\\\")) {
    fail("path_escape");
  }
  const components = raw.split("\\");
  if (components.some(invalidComponent)) fail("path_escape");
  return components;
}

function relativeDirectory(value) {
  const components = relativeComponents(value);
  if (components.includes(REVIEW_TRANSACTION_ROOT)) fail("invalid_path");
  return components.join("\\");
}

function artifactName(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    fail("invalid_request");
  }
  const components = relativeComponents(value);
  if (components.length !== 1) fail("path_escape");
  if (components[0] === REVIEW_TRANSACTION_ROOT) fail("invalid_request");
  return components[0];
}

function childPath(directory, name) {
  return `${directory}\\${name}`;
}

function artifactPath(pair, name) {
  return childPath(pair.directory, name);
}

function transactionRootPath(pair) {
  return childPath(pair.directory, REVIEW_TRANSACTION_ROOT);
}

function transactionPath(pair, transactionName) {
  return childPath(transactionRootPath(pair), transactionName);
}

function stagePath(transactionDirectory, stageName) {
  return childPath(transactionDirectory, stageName);
}

function reviewStageName(transactionName, kind) {
  return `.${transactionName}.${kind}.stage`;
}

function exactIdentity(value, failure = "invalid_result") {
  let valid = false;
  try {
    valid = isWindowsFilesystemIdentity(value)
      && value.linkCount === 1
      && Object.keys(value).sort().join("\0")
        === "fileId\0linkCount\0volumeSerialNumber";
  } catch {
    valid = false;
  }
  if (!valid) fail(failure);
  return Object.freeze({
    volumeSerialNumber: value.volumeSerialNumber,
    fileId: value.fileId,
    linkCount: 1,
  });
}

function sameIdentity(left, right) {
  return left.volumeSerialNumber === right.volumeSerialNumber
    && left.fileId === right.fileId
    && left.linkCount === right.linkCount;
}

function contentBytes(value, maximumBytes) {
  let length;
  if (typeof value === "string") length = Buffer.byteLength(value, "utf8");
  else if (value instanceof Uint8Array) length = value.byteLength;
  else fail("invalid_request");
  if (!Number.isSafeInteger(length) || length < 1 || length > maximumBytes) {
    fail("too_large");
  }
  try {
    return Buffer.from(value);
  } catch {
    fail("invalid_request");
  }
}

function maximum(value, ceiling) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    fail("too_large");
  }
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateTransactionId(value) {
  if (typeof value !== "string" || !UUID_V4.test(value)) fail("invalid_result");
  return value;
}

function stableManifestBytes(manifest) {
  try {
    const text = JSON.stringify(manifest);
    if (typeof text !== "string") fail("invalid_result");
    return Buffer.from(text, "utf8");
  } catch {
    fail("invalid_result");
  }
}

function inspectPresent(info, { directory, file } = {}) {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    fail("invalid_result");
  }
  if (info.isReparsePoint !== false
      || info.ownerMatches !== true
      || info.nullDacl !== false
      || info.daclProtected !== true
      || info.broadAccess !== false
      || info.nonOwnerAllow !== false
      || info.unrecognizedAce !== false
      || info.finalPathResolved !== true) {
    fail("security_policy");
  }
  if (directory && info.isDirectory !== true) fail("recovery_conflict");
  if (file && info.isRegularFile !== true) fail("recovery_conflict");
  return Object.freeze({
    ...info,
    identity: exactIdentity(info.identity),
  });
}

function inspectEnumeratedEntry(entry, { directory = false, file = false } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.name !== "string"
      || entry.isReparsePoint !== false
      || typeof entry.isDirectory !== "boolean"
      || typeof entry.isRegularFile !== "boolean"
      || entry.isDirectory === entry.isRegularFile) {
    fail("recovery_conflict");
  }
  if (directory && !entry.isDirectory) fail("recovery_conflict");
  if (file && !entry.isRegularFile) fail("recovery_conflict");
  return Object.freeze({
    name: entry.name,
    identity: exactIdentity(entry.identity, "recovery_conflict"),
    isDirectory: entry.isDirectory,
    isRegularFile: entry.isRegularFile,
    isReparsePoint: false,
  });
}

function isMissing(error) {
  return isWindowsReviewPairStorageError(error)
    && error.code === "windows_review_pair_storage_missing";
}

async function inspectMaybe(storage, path) {
  try {
    return inspectPresent(
      await invokeStorageAsync(storage, "inspect", [path]),
    );
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function absoluteRelativePath(storage, value) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    fail("invalid_path");
  }
  const root = String(storage.rootPath).replaceAll("/", "\\");
  const candidate = win32.normalize(value.replaceAll("/", "\\"));
  const prefix = `${root}\\`.toLowerCase();
  if (!candidate.toLowerCase().startsWith(prefix)) fail("path_escape");
  const relative = candidate.slice(prefix.length);
  return relativeDirectory(relative);
}

function pairFromAbsolutePaths(storage, firstPath, secondPath) {
  const firstRelative = absoluteRelativePath(storage, firstPath);
  const secondRelative = absoluteRelativePath(storage, secondPath);
  const firstComponents = firstRelative.split("\\");
  const secondComponents = secondRelative.split("\\");
  if (firstComponents.length < 2 || secondComponents.length < 2) {
    fail("path_escape");
  }
  const firstName = artifactName(firstComponents.at(-1));
  const secondName = artifactName(secondComponents.at(-1));
  const firstDirectory = relativeDirectory(firstComponents.slice(0, -1).join("\\"));
  const secondDirectory = relativeDirectory(secondComponents.slice(0, -1).join("\\"));
  if (firstDirectory.toLowerCase() !== secondDirectory.toLowerCase()) {
    fail("invalid_request");
  }
  return Object.freeze({
    directory: firstDirectory,
    bundleName: firstName,
    receiptName: secondName,
  });
}

function normalizePair(storage, request, { read = false } = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    fail("invalid_request");
  }
  const firstPath = read ? request.bundleFile : request.firstPath;
  const secondPath = read ? request.receiptFile : request.secondPath;
  let pair;
  if (firstPath !== undefined || secondPath !== undefined) {
    if (typeof firstPath !== "string" || typeof secondPath !== "string") {
      fail("invalid_request");
    }
    pair = pairFromAbsolutePaths(storage, firstPath, secondPath);
  } else {
    const directory = relativeDirectory(
      request.directory ?? request.relativeDirectory,
    );
    pair = Object.freeze({
      directory,
      bundleName: artifactName(request.bundleName ?? request.firstBasename),
      receiptName: artifactName(request.receiptName ?? request.secondBasename),
    });
  }
  if (pair.bundleName.toLowerCase() === pair.receiptName.toLowerCase()) {
    fail("invalid_request");
  }
  return pair;
}

function normalizeFailpoint(value) {
  if (value === undefined) return async () => {};
  if (typeof value !== "function") fail("invalid_configuration");
  return value;
}

function manifestArtifact({ name, stageName, bytes, sha256, identity }) {
  return {
    bytes,
    identity: {
      volumeSerialNumber: identity.volumeSerialNumber,
      fileId: identity.fileId,
      linkCount: identity.linkCount,
    },
    name,
    sha256,
    stageName,
  };
}

function validateManifestArtifact(value, maximumBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0")
        !== "bytes\0identity\0name\0sha256\0stageName"
      || !Number.isSafeInteger(value.bytes)
      || value.bytes < 1
      || value.bytes > maximumBytes
      || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || value.stageName === undefined
      || value.name === undefined) {
    fail("recovery_conflict");
  }
  return Object.freeze({
    bytes: value.bytes,
    identity: exactIdentity(value.identity, "recovery_conflict"),
    name: artifactName(value.name),
    sha256: value.sha256,
    stageName: artifactName(value.stageName),
  });
}

function parseManifest(bytes, pair, transactionName) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
      || bytes.byteLength > MAX_MANIFEST_BYTES) fail("recovery_conflict");
  const text = Buffer.from(bytes).toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("recovery_conflict");
  }
  let canonical;
  try {
    canonical = JSON.stringify(value);
  } catch {
    fail("recovery_conflict");
  }
  if (canonical !== text
      || !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join("\0")
        !== "artifacts\0directory\0schemaVersion\0transactionId"
      || value.schemaVersion !== REVIEW_TRANSACTION_SCHEMA
      || value.directory !== pair.directory
      || value.transactionId !== transactionName.slice("transaction-".length)
      || !value.artifacts
      || typeof value.artifacts !== "object"
      || Array.isArray(value.artifacts)
      || Object.keys(value.artifacts).sort().join("\0") !== "bundle\0receipt") {
    fail("recovery_conflict");
  }
  const bundle = validateManifestArtifact(
    value.artifacts.bundle,
    WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES,
  );
  const receipt = validateManifestArtifact(
    value.artifacts.receipt,
    WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES,
  );
  if (bundle.name !== pair.bundleName
      || receipt.name !== pair.receiptName
      || bundle.stageName !== reviewStageName(transactionName, "bundle")
      || receipt.stageName !== reviewStageName(transactionName, "receipt")
      || bundle.name.toLowerCase() === receipt.name.toLowerCase()) {
    fail("recovery_conflict");
  }
  return Object.freeze({
    artifacts: Object.freeze({ bundle, receipt }),
    directory: pair.directory,
    schemaVersion: REVIEW_TRANSACTION_SCHEMA,
    transactionId: value.transactionId,
  });
}

function validateConfiguration(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  const {
    platform = process.platform,
    storage,
    createTransactionId = randomUUID,
  } = options;
  if (platform !== "win32") fail("invalid_platform");
  if (!isWindowsPreparedArtifactStorage(storage)) fail("invalid_storage");
  if (typeof createTransactionId !== "function") fail("invalid_configuration");
  if (typeof storage.rootPath !== "string" || storage.rootPath.length < 1) {
    fail("invalid_storage");
  }
  return { platform, storage, createTransactionId };
}

/**
 * Compose the Windows review-pair port over a branded prepared-artifact
 * storage context.  The context accepts root-relative pair requests for
 * explicit composition, and exposes compatibility-shaped absolute-path
 * adapters for the metadata export and verification application facades.
 */
export function createWindowsReviewPairStorageContext(options = {}) {
  const { storage, createTransactionId } = validateConfiguration(options);

  function createTransactionName() {
    let transactionId;
    try {
      transactionId = validateTransactionId(createTransactionId());
    } catch (error) {
      if (isWindowsReviewPairStorageError(error)) throw error;
      fail("invalid_configuration");
    }
    return `transaction-${transactionId}`;
  }

  async function ensureDirectory(path) {
    return invokeStorageAsync(storage, "ensureDirectory", [path]);
  }

  async function ensureFreshTransaction(pair) {
    const rootPath = transactionRootPath(pair);
    const rootInfo = await inspectMaybe(storage, rootPath);
    let root;
    if (rootInfo === null) {
      root = await ensureDirectory(rootPath);
    } else {
      root = rootInfo;
    }
    const transactionName = createTransactionName();
    const path = transactionPath(pair, transactionName);
    if (await inspectMaybe(storage, path)) fail("already_exists");
    const transaction = await ensureDirectory(path);
    return Object.freeze({
      name: transactionName,
      path,
      root,
      transaction,
    });
  }

  async function inspectTarget(path) {
    const info = await inspectMaybe(storage, path);
    if (info !== null) fail("already_exists");
  }

  async function invokeFailpoint(failpoint, marker) {
    try {
      await Reflect.apply(failpoint, undefined, [marker]);
    } catch {
      fail("unavailable");
    }
  }

  async function writeReviewPair(request = {}) {
    const pair = normalizePair(storage, request);
    const bundleContent = contentBytes(
      request.bundleContent ?? request.firstContent,
      WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES,
    );
    const receiptContent = contentBytes(
      request.receiptContent ?? request.secondContent,
      WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES,
    );
    const failpoint = normalizeFailpoint(request.failpoint);
    await ensureDirectory(pair.directory);
    await inspectTarget(artifactPath(pair, pair.bundleName));
    await inspectTarget(artifactPath(pair, pair.receiptName));
    const transaction = await ensureFreshTransaction(pair);
    const bundleStageName = reviewStageName(transaction.name, "bundle");
    const receiptStageName = reviewStageName(transaction.name, "receipt");
    let bundleStage;
    let receiptStage;
    let markerCreated;
    let manifest;
    try {
      for (const stageName of [bundleStageName, receiptStageName]) {
        if (await inspectMaybe(storage, stagePath(pair.directory, stageName))) {
          fail("already_exists");
        }
      }
      markerCreated = await invokeStorageAsync(storage, "createFile", [
        stagePath(transaction.path, REVIEW_PREPARED_MARKER_NAME),
        Buffer.from("1"),
      ]);
      bundleStage = await invokeStorageAsync(storage, "createFile", [
        stagePath(pair.directory, bundleStageName),
        bundleContent,
      ]);
      receiptStage = await invokeStorageAsync(storage, "createFile", [
        stagePath(pair.directory, receiptStageName),
        receiptContent,
      ]);
      manifest = {
        artifacts: {
          bundle: manifestArtifact({
            name: pair.bundleName,
            stageName: bundleStageName,
            bytes: bundleContent.byteLength,
            sha256: digest(bundleContent),
            identity: exactIdentity(bundleStage.identity),
          }),
          receipt: manifestArtifact({
            name: pair.receiptName,
            stageName: receiptStageName,
            bytes: receiptContent.byteLength,
            sha256: digest(receiptContent),
            identity: exactIdentity(receiptStage.identity),
          }),
        },
        directory: pair.directory,
        schemaVersion: REVIEW_TRANSACTION_SCHEMA,
        transactionId: transaction.name.slice("transaction-".length),
      };
      const manifestCreated = await invokeStorageAsync(storage, "createFile", [
        stagePath(transaction.path, REVIEW_MANIFEST_NAME),
        stableManifestBytes(manifest),
      ]);
      await invokeFailpoint(failpoint, "after_manifest");
      await invokeStorageAsync(storage, "publishFile", [
        stagePath(pair.directory, receiptStageName),
        exactIdentity(receiptStage.identity),
        artifactPath(pair, pair.receiptName),
      ]);
      await invokeFailpoint(failpoint, "after_receipt");
      await invokeStorageAsync(storage, "publishFile", [
        stagePath(pair.directory, bundleStageName),
        exactIdentity(bundleStage.identity),
        artifactPath(pair, pair.bundleName),
      ]);
      await invokeFailpoint(failpoint, "after_bundle");
      await invokeStorageAsync(storage, "deleteFile", [
        stagePath(transaction.path, REVIEW_MANIFEST_NAME),
        exactIdentity(manifestCreated.identity),
      ]);
      const marker = await inspectMaybe(
        storage,
        stagePath(transaction.path, REVIEW_PREPARED_MARKER_NAME),
      );
      if (marker !== null && !sameIdentity(marker.identity, markerCreated.identity)) {
        fail("identity_mismatch");
      }
      if (marker !== null) {
        await invokeStorageAsync(storage, "deleteFile", [
          stagePath(transaction.path, REVIEW_PREPARED_MARKER_NAME),
          markerCreated.identity,
        ]);
      }
      await invokeStorageAsync(storage, "removeDirectory", [
        transaction.path,
        exactIdentity(transaction.transaction.identity),
      ]);
      const remainingRootEntries = await invokeStorageAsync(
        storage,
        "enumerateDirectory",
        [transactionRootPath(pair)],
      );
      if (remainingRootEntries.length === 0) {
        await invokeStorageAsync(storage, "removeDirectory", [
          transactionRootPath(pair),
          exactIdentity(transaction.root.identity),
        ]);
      }
      return Object.freeze({
        status: "published",
        directory: pair.directory,
        bundleName: pair.bundleName,
        receiptName: pair.receiptName,
      });
    } catch (error) {
      if (isWindowsReviewPairStorageError(error)) throw error;
      mapPreparedFailure(error);
    }
  }

  async function readReviewPair(request = {}) {
    const pair = normalizePair(storage, request, { read: true });
    const maximumBundleBytes = maximum(
      request.maximumBundleBytes
        ?? WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES,
      WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES,
    );
    const maximumReceiptBytes = maximum(
      request.maximumReceiptBytes
        ?? WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES,
      WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES,
    );
    // Receipt is intentionally read first.  A bundle is never treated as
    // reviewable without its paired privacy receipt.
    const receipt = await invokeStorageAsync(storage, "readFile", [
      artifactPath(pair, pair.receiptName),
      maximumReceiptBytes,
    ]);
    const bundle = await invokeStorageAsync(storage, "readFile", [
      artifactPath(pair, pair.bundleName),
      maximumBundleBytes,
    ]);
    return Object.freeze({
      bundleBytes: Buffer.from(bundle.data),
      receiptBytes: Buffer.from(receipt.data),
      bundleIdentity: exactIdentity(bundle.identity),
      receiptIdentity: exactIdentity(receipt.identity),
    });
  }

  async function removeManifestlessTransaction(
    pair,
    transactionName,
    transactionPathValue,
    transactionIdentity,
  ) {
    const currentTransaction = await inspectMaybe(storage, transactionPathValue);
    if (currentTransaction === null
        || !currentTransaction.isDirectory
        || !sameIdentity(currentTransaction.identity, transactionIdentity)) {
      fail("identity_mismatch");
    }
    const entries = await invokeStorageAsync(storage, "enumerateDirectory", [
      transactionPathValue,
    ]);
    for (const entry of entries) {
      if (entry.isDirectory || entry.name !== REVIEW_PREPARED_MARKER_NAME) {
        fail("recovery_conflict");
      }
      const enumerated = inspectEnumeratedEntry(entry, { file: true });
      const child = await inspectMaybe(
        storage,
        childPath(transactionPathValue, enumerated.name),
      );
      if (child === null || !sameIdentity(child.identity, enumerated.identity)) {
        fail("identity_mismatch");
      }
      await invokeStorageAsync(storage, "deleteFile", [
        childPath(transactionPathValue, enumerated.name),
        child.identity,
      ]);
    }
    for (const stageName of [
      reviewStageName(transactionName, "bundle"),
      reviewStageName(transactionName, "receipt"),
    ]) {
      const stage = await inspectMaybe(storage, childPath(pair.directory, stageName));
      if (stage !== null) {
        if (!stage.isRegularFile) fail("recovery_conflict");
        await invokeStorageAsync(storage, "deleteFile", [
          childPath(pair.directory, stageName),
          stage.identity,
        ]);
      }
    }
    await invokeStorageAsync(storage, "removeDirectory", [
      transactionPathValue,
      transactionIdentity,
    ]);
  }

  async function readTransactionArtifact(pair, artifact, targetPathValue) {
    const stage = await inspectMaybe(
      storage,
      stagePath(pair.directory, artifact.stageName),
    );
    const target = await inspectMaybe(storage, targetPathValue);
    if (stage !== null && !sameIdentity(stage.identity, artifact.identity)) {
      fail("identity_mismatch");
    }
    if (target !== null && !sameIdentity(target.identity, artifact.identity)) {
      fail("identity_mismatch");
    }
    if (stage !== null && !stage.isRegularFile) fail("recovery_conflict");
    if (target !== null && !target.isRegularFile) fail("recovery_conflict");
    if (stage !== null && target !== null) fail("recovery_conflict");
    const present = target ?? stage;
    if (present === null) return { stage: null, target: null };
    const read = await invokeStorageAsync(storage, "readFile", [
      present.relativePath ?? targetPathValue,
      artifact.bytes,
    ]);
    if (!sameIdentity(exactIdentity(read.identity), artifact.identity)
        || read.data.byteLength !== artifact.bytes
        || digest(read.data) !== artifact.sha256) {
      fail("recovery_conflict");
    }
    return { stage, target, present };
  }

  async function recoverTransaction(pair, transactionName, transactionIdentity) {
    const transactionDirectory = transactionPath(pair, transactionName);
    const currentTransaction = await inspectMaybe(storage, transactionDirectory);
    if (currentTransaction === null
        || !currentTransaction.isDirectory
        || !sameIdentity(currentTransaction.identity, transactionIdentity)) {
      fail("identity_mismatch");
    }
    const entries = await invokeStorageAsync(storage, "enumerateDirectory", [
      transactionDirectory,
    ]);
    if (!entries.some((entry) => entry.name === REVIEW_MANIFEST_NAME)) {
      await removeManifestlessTransaction(
        pair,
        transactionName,
        transactionDirectory,
        transactionIdentity,
      );
      return;
    }
    if (entries.some((entry) => ![
      REVIEW_MANIFEST_NAME,
      REVIEW_PREPARED_MARKER_NAME,
    ].includes(entry.name))
        || !entries.some((entry) => entry.name === REVIEW_MANIFEST_NAME)
        || !entries.some((entry) => entry.name === REVIEW_PREPARED_MARKER_NAME)) {
      fail("recovery_conflict");
    }
    const manifestInfo = entries.find((entry) => entry.name === REVIEW_MANIFEST_NAME);
    const manifestEnumerated = inspectEnumeratedEntry(manifestInfo, { file: true });
    const markerInfo = entries.find((entry) => entry.name === REVIEW_PREPARED_MARKER_NAME);
    const markerEnumerated = inspectEnumeratedEntry(markerInfo, { file: true });
    const manifestEntry = await inspectMaybe(
      storage,
      childPath(transactionDirectory, manifestInfo.name),
    );
    if (manifestEntry === null
        || !manifestEntry.isRegularFile
        || !sameIdentity(manifestEntry.identity, manifestEnumerated.identity)) {
      fail("recovery_conflict");
    }
    const manifestRead = await invokeStorageAsync(storage, "readFile", [
      childPath(transactionDirectory, REVIEW_MANIFEST_NAME),
      MAX_MANIFEST_BYTES,
    ]);
    if (!sameIdentity(exactIdentity(manifestRead.identity), manifestEntry.identity)) {
      fail("identity_mismatch");
    }
    const manifest = parseManifest(
      manifestRead.data,
      pair,
      transactionName,
    );
    const receiptState = await readTransactionArtifact(
      pair,
      manifest.artifacts.receipt,
      artifactPath(pair, pair.receiptName),
    );
    const bundleState = await readTransactionArtifact(
      pair,
      manifest.artifacts.bundle,
      artifactPath(pair, pair.bundleName),
    );
    if (receiptState.stage === null && receiptState.target === null) {
      fail("recovery_conflict");
    }
    if (bundleState.stage === null && bundleState.target === null) {
      fail("recovery_conflict");
    }
    if (receiptState.target === null) {
      await invokeStorageAsync(storage, "publishFile", [
        stagePath(pair.directory, manifest.artifacts.receipt.stageName),
        manifest.artifacts.receipt.identity,
        artifactPath(pair, pair.receiptName),
      ]);
    }
    if (bundleState.target === null) {
      await invokeStorageAsync(storage, "publishFile", [
        stagePath(pair.directory, manifest.artifacts.bundle.stageName),
        manifest.artifacts.bundle.identity,
        artifactPath(pair, pair.bundleName),
      ]);
    }
    // Reinspect both final files after publication.  This also makes a
    // target identity swap fail before any transaction evidence is removed.
    const finalReceipt = await inspectMaybe(storage, artifactPath(pair, pair.receiptName));
    const finalBundle = await inspectMaybe(storage, artifactPath(pair, pair.bundleName));
    if (finalReceipt === null || finalBundle === null
        || !sameIdentity(finalReceipt.identity, manifest.artifacts.receipt.identity)
        || !sameIdentity(finalBundle.identity, manifest.artifacts.bundle.identity)) {
      fail("identity_mismatch");
    }
    const finalReceiptRead = await invokeStorageAsync(storage, "readFile", [
      artifactPath(pair, pair.receiptName),
      manifest.artifacts.receipt.bytes,
    ]);
    const finalBundleRead = await invokeStorageAsync(storage, "readFile", [
      artifactPath(pair, pair.bundleName),
      manifest.artifacts.bundle.bytes,
    ]);
    if (!sameIdentity(exactIdentity(finalReceiptRead.identity), manifest.artifacts.receipt.identity)
        || !sameIdentity(exactIdentity(finalBundleRead.identity), manifest.artifacts.bundle.identity)
        || finalReceiptRead.data.byteLength !== manifest.artifacts.receipt.bytes
        || finalBundleRead.data.byteLength !== manifest.artifacts.bundle.bytes
        || digest(finalReceiptRead.data) !== manifest.artifacts.receipt.sha256
        || digest(finalBundleRead.data) !== manifest.artifacts.bundle.sha256) {
      fail("recovery_conflict");
    }
    await invokeStorageAsync(storage, "deleteFile", [
      childPath(transactionDirectory, REVIEW_MANIFEST_NAME),
      manifestEntry.identity,
    ]);
    const marker = await inspectMaybe(
      storage,
      childPath(transactionDirectory, REVIEW_PREPARED_MARKER_NAME),
    );
    if (marker === null || !sameIdentity(marker.identity, markerEnumerated.identity)) {
      fail("identity_mismatch");
    }
    if (marker !== null) {
      await invokeStorageAsync(storage, "deleteFile", [
        childPath(transactionDirectory, REVIEW_PREPARED_MARKER_NAME),
        marker.identity,
      ]);
    }
    await invokeStorageAsync(storage, "removeDirectory", [
      transactionDirectory,
      transactionIdentity,
    ]);
  }

  async function recoverReviewPairTransactions(request = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      fail("invalid_request");
    }
    const directory = request.directoryPath
      ? absoluteRelativePath(storage, request.directoryPath)
      : relativeDirectory(request.directory ?? request.relativeDirectory);
    const pair = Object.freeze({
      directory,
      // These names are only used to parse an individual manifest. A recovery
      // call may contain transactions for more than one pair name, so each
      // manifest is checked against its own declared target names below.
      bundleName: "recovery.bundle",
      receiptName: "recovery.receipt",
    });
    const rootInfo = await inspectMaybe(storage, transactionRootPath(pair));
    if (rootInfo === null) return Object.freeze({ recovered: 0, transactionsFound: 0 });
    if (!rootInfo.isDirectory) fail("recovery_conflict");
    const entries = await invokeStorageAsync(storage, "enumerateDirectory", [
      transactionRootPath(pair),
    ]);
    let recovered = 0;
    for (const entry of entries) {
      if (!TRANSACTION_DIRECTORY.test(entry.name) || !entry.isDirectory) {
        fail("recovery_conflict");
      }
      const transactionPathValue = transactionPath(pair, entry.name);
      const transactionInfo = await inspectMaybe(storage, transactionPathValue);
      if (transactionInfo === null || !transactionInfo.isDirectory) {
        fail("recovery_conflict");
      }
      const manifestInfo = await inspectMaybe(
        storage,
        childPath(transactionPathValue, REVIEW_MANIFEST_NAME),
      );
      if (manifestInfo === null) {
        await removeManifestlessTransaction(
          pair,
          entry.name,
          transactionPathValue,
          transactionInfo.identity,
        );
        recovered += 1;
        continue;
      }
      const manifestRead = await invokeStorageAsync(storage, "readFile", [
        childPath(transactionPathValue, REVIEW_MANIFEST_NAME),
        MAX_MANIFEST_BYTES,
      ]);
      const text = Buffer.from(manifestRead.data).toString("utf8");
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        fail("recovery_conflict");
      }
      if (!value || typeof value.directory !== "string"
          || typeof value.artifacts?.bundle?.name !== "string"
          || typeof value.artifacts?.receipt?.name !== "string") {
        fail("recovery_conflict");
      }
      const declaredPair = Object.freeze({
        directory,
        bundleName: artifactName(value.artifacts.bundle.name),
        receiptName: artifactName(value.artifacts.receipt.name),
      });
      await recoverTransaction(declaredPair, entry.name, transactionInfo.identity);
      recovered += 1;
    }
    const remaining = await invokeStorageAsync(storage, "enumerateDirectory", [
      transactionRootPath(pair),
    ]);
    if (remaining.length === 0) {
      await invokeStorageAsync(storage, "removeDirectory", [
        transactionRootPath(pair),
        rootInfo.identity,
      ]);
    }
    return Object.freeze({
      recovered,
      transactionsFound: entries.length,
    });
  }

  // Names match the existing local-export storage vocabulary so the parent
  // application composition can inject this context without teaching the
  // domain/application layer about Windows native method names.
  const recoverOwnerOnlyPairTransactions = recoverReviewPairTransactions;

  async function writeOwnerOnlyPairNoClobber(request = {}) {
    return writeReviewPair({
      ...request,
      bundleContent: request.firstContent,
      receiptContent: request.secondContent,
    });
  }

  async function readOwnerOnlyLocalMetadataBundlePair(request = {}) {
    try {
      return await readReviewPair(request);
    } catch (error) {
      if (typeof request.createError === "function"
          && isWindowsReviewPairStorageError(error)) {
        throw request.createError(error.code);
      }
      throw error;
    }
  }

  const context = Object.freeze({
    contractVersion: WINDOWS_REVIEW_PAIR_STORAGE_CONTRACT_VERSION,
    maximumBundleBytes: WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_BUNDLE_BYTES,
    maximumReceiptBytes: WINDOWS_REVIEW_PAIR_STORAGE_MAXIMUM_RECEIPT_BYTES,
    productionSafe: WINDOWS_REVIEW_PAIR_STORAGE_PRODUCTION_SAFE,
    readiness: WINDOWS_REVIEW_PAIR_STORAGE_READINESS,
    reviewPairSafe: WINDOWS_REVIEW_PAIR_STORAGE_SAFE,
    writeReviewPair,
    readReviewPair,
    recoverReviewPairTransactions,
    recoverOwnerOnlyPairTransactions,
    writeOwnerOnlyPairNoClobber,
    readOwnerOnlyLocalMetadataBundlePair,
  });
  CONTEXTS.add(context);
  return context;
}
