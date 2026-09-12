import { createHash } from "node:crypto";
import {
  closeSync,
  constants as filesystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const LINUX_CREDENTIAL_MUTEX_GENERATED_BINDING_RELATIVE_PATH = Object.freeze([
  "native",
  "linux-credential-mutex",
  "build",
  "Release",
  "linux_credential_mutex.node",
].join("/"));
export const LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH = Object.freeze([
  "native",
  "linux-credential-mutex",
  "build",
  "qualification",
  "linux_credential_mutex.node",
].join("/"));
export const LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_RELATIVE_PATH = Object.freeze(
  `${LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH}.manifest.json`,
);
export const LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_SCHEMA_VERSION =
  "linux-credential-mutex-binding-manifest-v1";
export const LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS = Object.freeze([
  "prepareLinuxCredentialState",
  "acquireCredentialMutex",
  "releaseCredentialMutex",
  "abandonCredentialMutex",
  "readAccountlessInstallationCredential",
  "createAccountlessInstallationCredentialIfMissing",
  "deleteAccountlessInstallationCredentialExact",
  "readAccountObservationCredential",
  "createAccountObservationCredentialIfMissing",
]);

const NATIVE_BINDING_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH,
);
const NATIVE_BINDING_PATH_TAIL = LINUX_CREDENTIAL_MUTEX_BINDING_RELATIVE_PATH
  .split("/")
  .join(sep);
const BINDING_FILE_NAME = "linux_credential_mutex.node";
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "bindingFile",
  "platform",
  "architecture",
  "bytes",
  "sha256",
  "contractVersion",
  "requiredMethods",
  "nativeClaims",
  "approvedPolicy",
]);
const NATIVE_CLAIM_KEYS = Object.freeze([
  "credentialMutexCrossProcessSafe",
  "sameNetworkNamespaceOnly",
  "durableAbandonmentMarker",
  "productionSafe",
]);
const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_path_invalid",
  "binding_path_unsafe",
  "manifest_path_unsafe",
  "manifest_invalid",
  "binding_integrity",
  "binding_mutated",
  "binding_invalid",
  "manifest_binding_mismatch",
]);

const trustedErrors = new WeakSet();
const verifiedBindingMetadata = new WeakMap();

export class LinuxCredentialMutexBindingError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux credential mutex binding error code");
    }
    super("Linux credential mutex binding failed");
    this.name = "LinuxCredentialMutexBindingError";
    this.code = `linux_credential_mutex_binding_${code}`;
    trustedErrors.add(this);
  }
}

export function isLinuxCredentialMutexBindingError(error) {
  return Boolean(error
    && trustedErrors.has(error)
    && Object.getPrototypeOf(error) === LinuxCredentialMutexBindingError.prototype);
}

function fail(code) {
  throw new LinuxCredentialMutexBindingError(code);
}

function exactKeys(value, keys) {
  let observed;
  try {
    observed = Object.keys(value);
  } catch {
    return false;
  }
  return observed.length === keys.length && keys.every((key) => observed.includes(key));
}

function nativeClaimsValid(value, { requireApprovedPolicy = false } = {}) {
  let valid = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && exactKeys(value, NATIVE_CLAIM_KEYS);
  try {
    valid = valid
      && value.credentialMutexCrossProcessSafe === true
      && value.sameNetworkNamespaceOnly === true
      && value.durableAbandonmentMarker === true
      && value.productionSafe === false;
    if (requireApprovedPolicy) {
      valid = valid
        && value.credentialMutexCrossProcessSafe === true
        && value.sameNetworkNamespaceOnly === true
        && value.durableAbandonmentMarker === true
        && value.productionSafe === false;
    }
  } catch {
    valid = false;
  }
  return valid;
}

function parseManifest(value) {
  let manifest;
  try {
    const text = Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value).toString("utf8")
      : value;
    if (typeof text !== "string") throw new TypeError("manifest is not text");
    manifest = JSON.parse(text);
  } catch {
    fail("manifest_invalid");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest_invalid");
  }
  return manifest;
}

/**
 * Validate the closed, content-free native sidecar shape. Packaging uses this
 * same pure validator before it records the final unpacked pair; this function
 * does not inspect paths, files, or a loaded native module.
 */
export function validateLinuxCredentialMutexBindingManifest(manifest) {
  let valid = exactKeys(manifest, MANIFEST_KEYS);
  try {
    valid = valid
      && manifest.schemaVersion === LINUX_CREDENTIAL_MUTEX_BINDING_MANIFEST_SCHEMA_VERSION
      && manifest.bindingFile === BINDING_FILE_NAME
      && manifest.platform === "linux"
      && manifest.architecture === "x64"
      && Number.isSafeInteger(manifest.bytes)
      && manifest.bytes > 0
      && manifest.bytes <= MAXIMUM_BINDING_BYTES
      && typeof manifest.sha256 === "string"
      && /^[a-f0-9]{64}$/u.test(manifest.sha256)
      && manifest.contractVersion === "linux-credential-mutex-v1"
      && Array.isArray(manifest.requiredMethods)
      && manifest.requiredMethods.length
        === LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS.length
      && manifest.requiredMethods.every(
        (method, index) => method === LINUX_CREDENTIAL_MUTEX_BINDING_REQUIRED_METHODS[index],
      )
      && nativeClaimsValid(manifest.nativeClaims)
      && nativeClaimsValid(manifest.approvedPolicy, { requireApprovedPolicy: true });
  } catch {
    valid = false;
  }
  if (!valid) fail("manifest_invalid");
  return Object.freeze({
    ...manifest,
    requiredMethods: Object.freeze([...manifest.requiredMethods]),
    nativeClaims: Object.freeze({ ...manifest.nativeClaims }),
    approvedPolicy: Object.freeze({ ...manifest.approvedPolicy }),
  });
}

/**
 * Electron exposes JavaScript under app.asar but native modules must reside
 * beside it in app.asar.unpacked. Translate only a path derived from this
 * module and only the exact fixed binding tail; no caller-selected path can
 * reach this branch.
 */
function moduleOwnedUnpackedBindingPath(path) {
  const marker = `${sep}app.asar${sep}`;
  const index = path.lastIndexOf(marker);
  if (index === -1) return path;
  const tail = path.slice(index + marker.length);
  if (tail !== NATIVE_BINDING_PATH_TAIL) return null;
  return `${path.slice(0, index)}${sep}app.asar.unpacked${sep}${tail}`;
}

const MODULE_OWNED_BINDING_PATH = moduleOwnedUnpackedBindingPath(NATIVE_BINDING_PATH);

function normalizeBindingBytes(bytes, code) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
      || bytes.byteLength <= 0
      || bytes.byteLength > MAXIMUM_BINDING_BYTES) {
    fail(code);
  }
  try {
    return Buffer.from(bytes);
  } catch {
    fail(code);
  }
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultVerifyBindingPath(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

function safeManifestMetadata(path, metadata) {
  try {
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && Number.isSafeInteger(metadata.size)
      && metadata.size > 0
      && metadata.size <= MAXIMUM_MANIFEST_BYTES
      && realpathSync(path) === path;
  } catch {
    return false;
  }
}

/**
 * Read a fixed sidecar through one pinned descriptor. This is exported for
 * narrow filesystem-contract tests; the production loader supplies only its
 * repository-owned sidecar path.
 */
export function readLinuxCredentialMutexManifestFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    fail("manifest_path_unsafe");
  }
  let descriptor = -1;
  try {
    const namedBefore = lstatSync(path);
    if (!safeManifestMetadata(path, namedBefore)
        || !Number.isInteger(filesystemConstants.O_NOFOLLOW)) {
      fail("manifest_path_unsafe");
    }
    descriptor = openSync(
      path,
      filesystemConstants.O_RDONLY
        | filesystemConstants.O_NOFOLLOW
        | (filesystemConstants.O_CLOEXEC ?? 0),
    );
    const openedBefore = fstatSync(descriptor);
    if (!safeManifestMetadata(path, openedBefore)
        || !sameFileIdentity(namedBefore, openedBefore)) {
      fail("manifest_path_unsafe");
    }
    const bytes = Buffer.alloc(openedBefore.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        fail("manifest_path_unsafe");
      }
      offset += count;
    }
    const openedAfter = fstatSync(descriptor);
    const namedAfter = lstatSync(path);
    if (!safeManifestMetadata(path, openedAfter)
        || !safeManifestMetadata(path, namedAfter)
        || !sameFileIdentity(namedBefore, openedAfter)
        || !sameFileIdentity(namedBefore, namedAfter)) {
      fail("manifest_path_unsafe");
    }
    closeSync(descriptor);
    descriptor = -1;
    return bytes;
  } catch (error) {
    if (isLinuxCredentialMutexBindingError(error)) throw error;
    fail("manifest_path_unsafe");
  } finally {
    if (descriptor !== -1) {
      try {
        closeSync(descriptor);
      } catch {
        // The original trusted error remains authoritative.
      }
    }
  }
}

function normalizeBindingPath(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    fail("binding_path_invalid");
  }
  let normalized;
  try {
    normalized = resolve(path);
  } catch {
    fail("binding_path_invalid");
  }
  if (MODULE_OWNED_BINDING_PATH === null
      || (normalized !== NATIVE_BINDING_PATH
        && normalized !== MODULE_OWNED_BINDING_PATH)) {
    fail("binding_path_invalid");
  }
  return MODULE_OWNED_BINDING_PATH;
}

function snapshotBinding(binding) {
  let prepareLinuxCredentialState;
  let acquireCredentialMutex;
  let releaseCredentialMutex;
  let abandonCredentialMutex;
  let readAccountlessInstallationCredential;
  let createAccountlessInstallationCredentialIfMissing;
  let deleteAccountlessInstallationCredentialExact;
  let readAccountObservationCredential;
  let createAccountObservationCredentialIfMissing;
  let contractVersion;
  let crossProcessSafe;
  let sameNetworkNamespaceOnly;
  let durableAbandonmentMarker;
  let productionSafe;
  try {
    prepareLinuxCredentialState = binding?.prepareLinuxCredentialState;
    acquireCredentialMutex = binding?.acquireCredentialMutex;
    releaseCredentialMutex = binding?.releaseCredentialMutex;
    abandonCredentialMutex = binding?.abandonCredentialMutex;
    readAccountlessInstallationCredential = binding?.readAccountlessInstallationCredential;
    createAccountlessInstallationCredentialIfMissing =
      binding?.createAccountlessInstallationCredentialIfMissing;
    deleteAccountlessInstallationCredentialExact =
      binding?.deleteAccountlessInstallationCredentialExact;
    readAccountObservationCredential = binding?.readAccountObservationCredential;
    createAccountObservationCredentialIfMissing =
      binding?.createAccountObservationCredentialIfMissing;
    contractVersion = binding?.credentialMutexContractVersion;
    crossProcessSafe = binding?.credentialMutexCrossProcessSafe;
    sameNetworkNamespaceOnly = binding?.credentialMutexSameNetworkNamespaceOnly;
    durableAbandonmentMarker = binding?.credentialMutexDurableMarker;
    productionSafe = binding?.productionSafe;
  } catch {
    fail("binding_invalid");
  }
  if (typeof prepareLinuxCredentialState !== "function"
      || typeof acquireCredentialMutex !== "function"
      || typeof releaseCredentialMutex !== "function"
      || typeof abandonCredentialMutex !== "function"
      || typeof readAccountlessInstallationCredential !== "function"
      || typeof createAccountlessInstallationCredentialIfMissing !== "function"
      || typeof deleteAccountlessInstallationCredentialExact !== "function"
      || typeof readAccountObservationCredential !== "function"
      || typeof createAccountObservationCredentialIfMissing !== "function"
      || contractVersion !== "linux-credential-mutex-v1"
      || crossProcessSafe !== true
      || sameNetworkNamespaceOnly !== true
      || durableAbandonmentMarker !== true
      || productionSafe !== false) {
    fail("binding_invalid");
  }
  try {
    return Object.freeze({
      prepareLinuxCredentialState: prepareLinuxCredentialState.bind(binding),
      acquireCredentialMutex: acquireCredentialMutex.bind(binding),
      releaseCredentialMutex: releaseCredentialMutex.bind(binding),
      abandonCredentialMutex: abandonCredentialMutex.bind(binding),
      readAccountlessInstallationCredential:
        readAccountlessInstallationCredential.bind(binding),
      createAccountlessInstallationCredentialIfMissing:
        createAccountlessInstallationCredentialIfMissing.bind(binding),
      deleteAccountlessInstallationCredentialExact:
        deleteAccountlessInstallationCredentialExact.bind(binding),
      readAccountObservationCredential:
        readAccountObservationCredential.bind(binding),
      createAccountObservationCredentialIfMissing:
        createAccountObservationCredentialIfMissing.bind(binding),
      credentialMutexContractVersion: contractVersion,
      credentialMutexCrossProcessSafe: crossProcessSafe,
      credentialMutexSameNetworkNamespaceOnly: sameNetworkNamespaceOnly,
      credentialMutexDurableMarker: durableAbandonmentMarker,
      productionSafe,
    });
  } catch {
    fail("binding_invalid");
  }
}

function readSnapshot(readBindingBytes, path, code) {
  let bytes;
  try {
    bytes = readBindingBytes(path);
  } catch {
    fail(code);
  }
  return normalizeBindingBytes(bytes, code);
}

/**
 * Load only the repository-owned Linux x64 credential mutex binding. The
 * sidecar is an integrity check, not publisher authentication; the adapter
 * deliberately keeps `productionSafe` false until later platform work has
 * its own installed-artifact and physical-desktop evidence.
 */
export function loadLinuxCredentialMutexBinding(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("invalid_configuration");
  }
  let platform;
  let architecture;
  let bindingPath;
  let resolveBinding;
  let readManifest;
  let readBindingBytes;
  let requireBinding;
  let verifyBindingPath;
  let usesDefaultPathVerifier;
  let usesDefaultManifestReader;
  try {
    usesDefaultPathVerifier = !Object.hasOwn(options, "verifyBindingPath");
    usesDefaultManifestReader = !Object.hasOwn(options, "readManifest");
    ({
      platform = process.platform,
      architecture = process.arch,
      bindingPath = NATIVE_BINDING_PATH,
      resolveBinding = (path) => path,
      readManifest = readLinuxCredentialMutexManifestFile,
      readBindingBytes = (path) => readFileSync(path),
      requireBinding = (path) => require(path),
      verifyBindingPath = defaultVerifyBindingPath,
    } = options);
  } catch {
    fail("invalid_configuration");
  }
  if (platform !== "linux") fail("unsupported_platform");
  if (architecture !== "x64") fail("unsupported_architecture");
  if (typeof resolveBinding !== "function"
      || typeof readManifest !== "function"
      || typeof readBindingBytes !== "function"
      || typeof requireBinding !== "function"
      || typeof verifyBindingPath !== "function") {
    fail("invalid_configuration");
  }

  let resolved;
  try {
    resolved = normalizeBindingPath(resolveBinding(bindingPath));
  } catch (error) {
    if (isLinuxCredentialMutexBindingError(error)) throw error;
    fail("binding_unavailable");
  }
  let pathSafe;
  try {
    pathSafe = verifyBindingPath(resolved) === true;
  } catch {
    pathSafe = false;
  }
  if (!pathSafe) fail("binding_path_unsafe");

  let manifest;
  try {
    manifest = validateLinuxCredentialMutexBindingManifest(
      parseManifest(readManifest(`${resolved}.manifest.json`)),
    );
  } catch (error) {
    if (isLinuxCredentialMutexBindingError(error)) throw error;
    fail("binding_unavailable");
  }

  const before = readSnapshot(readBindingBytes, resolved, "binding_unavailable");
  let beforeDigest;
  try {
    beforeDigest = digest(before);
  } finally {
    before.fill(0);
  }
  if (before.byteLength !== manifest.bytes || beforeDigest !== manifest.sha256) {
    fail("binding_integrity");
  }

  let binding;
  try {
    binding = snapshotBinding(requireBinding(resolved));
  } catch (error) {
    if (isLinuxCredentialMutexBindingError(error)) throw error;
    fail("binding_unavailable");
  }
  if (binding.credentialMutexContractVersion !== manifest.contractVersion
      || binding.credentialMutexCrossProcessSafe
        !== manifest.nativeClaims.credentialMutexCrossProcessSafe
      || binding.credentialMutexSameNetworkNamespaceOnly
        !== manifest.nativeClaims.sameNetworkNamespaceOnly
      || binding.credentialMutexDurableMarker
        !== manifest.nativeClaims.durableAbandonmentMarker
      || binding.productionSafe !== manifest.nativeClaims.productionSafe) {
    fail("manifest_binding_mismatch");
  }

  const after = readSnapshot(readBindingBytes, resolved, "binding_unavailable");
  let afterDigest;
  try {
    afterDigest = digest(after);
  } finally {
    after.fill(0);
  }
  if (after.byteLength !== manifest.bytes
      || afterDigest !== beforeDigest
      || afterDigest !== manifest.sha256) {
    fail("binding_mutated");
  }

  verifiedBindingMetadata.set(binding, Object.freeze({
    bytes: manifest.bytes,
    sha256: manifest.sha256,
    pathSafetyVerified: usesDefaultPathVerifier,
    manifestPathSafetyVerified: usesDefaultManifestReader,
    bindingIntegrityVerifiedBeforeAndAfter: true,
    crossProcessScope: "same_linux_network_namespace",
    productionSafe: false,
  }));
  return binding;
}

export function linuxCredentialMutexBindingEvidence(binding) {
  let metadata;
  try {
    metadata = verifiedBindingMetadata.get(binding);
  } catch {
    return null;
  }
  if (!metadata) return null;
  return Object.freeze({
    target: "linux-x64",
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    pathSafetyVerified: metadata.pathSafetyVerified,
    manifestPathSafetyVerified: metadata.manifestPathSafetyVerified,
    bindingIntegrityVerifiedBeforeAndAfter:
      metadata.bindingIntegrityVerifiedBeforeAndAfter,
    crossProcessScope: metadata.crossProcessScope,
    productionSafe: metadata.productionSafe,
  });
}
