import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyWindowsFilesystemBindingProvenance,
  WINDOWS_FILESYSTEM_BINDING_PROVENANCE_STATUS,
} from "./windows-binding-provenance.js";

const require = createRequire(import.meta.url);
const NATIVE_BINDING_RELATIVE_PATH = Object.freeze([
  "native",
  "windows-filesystem",
  "build",
  "Release",
  "windows_filesystem.node",
].join("/"));
const NATIVE_BINDING_MANIFEST_RELATIVE_PATH = Object.freeze(
  `${NATIVE_BINDING_RELATIVE_PATH}.manifest.json`,
);
const NATIVE_BINDING_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "native",
  "windows-filesystem",
  "build",
  "Release",
  "windows_filesystem.node",
);
const BINDING_MANIFEST_SCHEMA_VERSION =
  "windows-filesystem-binding-manifest-v1";
const BINDING_PROVENANCE_CONTRACT_VERSION = "windows-binding-provenance-v1";
const BINDING_FILE_NAME = "windows_filesystem.node";
const BINDING_PLATFORM = "win32";
const BINDING_ARCHITECTURE = "x64";
const MAXIMUM_BINDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 1024 * 1024;
const UNQUALIFIED_BINDING_PROVENANCE_SOURCE = "unsigned-development-binding";
const AUTHENTICATED_BINDING_PROVENANCE_SOURCES = Object.freeze([
  "development-package",
  "audited-signed-native-binding",
]);
const REQUIRED_METHODS = Object.freeze([
  "inspectPath",
  "ensureDirectory",
  "readFile",
  "readFileBounded",
  "createFile",
  "deleteFile",
  "replaceFile",
  "inspectProtectedChild",
  "readProtectedChild",
  "createProtectedChild",
  "deleteProtectedChild",
  "replaceProtectedChild",
  "acquireCredentialAuditFileGuard",
  "releaseCredentialAuditFileGuard",
  "acquireCredentialMutex",
  "releaseCredentialMutex",
]);
const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "bindingFile",
  "platform",
  "architecture",
  "bytes",
  "sha256",
  "contractVersion",
  "securityContractVersion",
  "credentialAuditFileGuardContractVersion",
  "credentialMutexContractVersion",
  "requiredMethods",
  "nativeClaims",
  "approvedPolicy",
  "bindingProvenance",
]);
const WINDOWS_FILESYSTEM_ADAPTERS = new WeakSet();

export const WINDOWS_FILESYSTEM_BINDING_RELATIVE_PATH = NATIVE_BINDING_RELATIVE_PATH;
export const WINDOWS_FILESYSTEM_BINDING_MANIFEST_RELATIVE_PATH =
  NATIVE_BINDING_MANIFEST_RELATIVE_PATH;
export const WINDOWS_FILESYSTEM_BINDING_MANIFEST_SCHEMA_VERSION =
  BINDING_MANIFEST_SCHEMA_VERSION;
export const WINDOWS_FILESYSTEM_BINDING_PROVENANCE_CONTRACT_VERSION =
  BINDING_PROVENANCE_CONTRACT_VERSION;
export const WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS = REQUIRED_METHODS;

function failure(code) {
  const error = new Error("Windows filesystem native adapter unavailable");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function normalizeBindingPath(path, platform) {
  if (typeof path !== "string"
      || !(platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path))) {
    throw failure("INVALID_BINDING_PATH");
  }
  if (platform === "win32") {
    const suffix = ["native", "windows-filesystem", "build", "Release", "windows_filesystem.node"]
      .join(win32.sep);
    if (!path.toLowerCase().endsWith(`${win32.sep}${suffix.toLowerCase()}`)) {
      throw failure("INVALID_BINDING_PATH");
    }
  } else if (!path.endsWith("/native/windows-filesystem/build/Release/windows_filesystem.node")) {
    throw failure("INVALID_BINDING_PATH");
  }
  return path;
}

function normalizeBindingBytes(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)
      || bytes.byteLength <= 0
      || bytes.byteLength > MAXIMUM_BINDING_BYTES) {
    throw failure("INVALID_BINDING_BYTES");
  }
  return Buffer.from(bytes);
}

function bindingSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeManifestBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw failure("INVALID_MANIFEST");
}

function parseBindingManifest(value) {
  let parsed;
  try {
    parsed = JSON.parse(normalizeManifestBytes(value).toString("utf8"));
  } catch {
    throw failure("INVALID_MANIFEST");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw failure("INVALID_MANIFEST");
  }
  return parsed;
}

function validBindingProvenance(value) {
  let valid = false;
  try {
    valid = value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === 3
      && value.contractVersion === BINDING_PROVENANCE_CONTRACT_VERSION
      && ((value.status === "unqualified"
        && value.source === UNQUALIFIED_BINDING_PROVENANCE_SOURCE)
        || (value.status === "authenticated"
          && AUTHENTICATED_BINDING_PROVENANCE_SOURCES.includes(value.source)));
  } catch {
    // Treat hostile provenance objects as unqualified.
  }
  return valid;
}

function policyRequiresAuthenticatedProvenance(policy) {
  return policy.productionSafe === true || policy.pathWalkRaceSafe === true;
}

function manifestRequiresAuthenticatedProvenance(manifest) {
  return manifest.nativeClaims.productionSafe === true
    || manifest.nativeClaims.pathWalkRaceSafe === true
    || policyRequiresAuthenticatedProvenance(manifest.approvedPolicy);
}

function assertBindingProvenanceAvailable({ bindingPath, bindingBytes, manifest }) {
  const provenance = verifyWindowsFilesystemBindingProvenance({
    bindingPath,
    bindingBytes,
    manifest,
  });
  if (provenance.status !== "verified") {
    const reason = provenance.status === WINDOWS_FILESYSTEM_BINDING_PROVENANCE_STATUS.unavailable
      ? "PROVENANCE_VERIFIER_UNAVAILABLE"
      : "MANIFEST_PROVENANCE_UNAUTHENTICATED";
    throw failure(reason);
  }
}

function assertBindingManifest(manifest) {
  const nativeClaims = manifest.nativeClaims;
  const approvedPolicy = manifest.approvedPolicy;
  const bindingProvenance = manifest.bindingProvenance;
  const requiredMethods = manifest.requiredMethods;
  const manifestKeys = Object.keys(manifest);
  const valid = manifestKeys.length === MANIFEST_KEYS.length
    && MANIFEST_KEYS.every((key) => manifestKeys.includes(key))
    && manifest.schemaVersion === BINDING_MANIFEST_SCHEMA_VERSION
    && manifest.bindingFile === BINDING_FILE_NAME
    && manifest.platform === BINDING_PLATFORM
    && manifest.architecture === BINDING_ARCHITECTURE
    && Number.isSafeInteger(manifest.bytes)
    && manifest.bytes > 0
    && manifest.bytes <= MAXIMUM_BINDING_BYTES
    && typeof manifest.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(manifest.sha256)
    && manifest.contractVersion === "windows-filesystem-v1"
    && manifest.securityContractVersion === "windows-filesystem-security-v1"
    && manifest.credentialAuditFileGuardContractVersion
      === "windows-credential-audit-file-guard-v1"
    && manifest.credentialMutexContractVersion === "windows-credential-mutex-v1"
    && Array.isArray(requiredMethods)
    && requiredMethods.length === REQUIRED_METHODS.length
    && requiredMethods.every((method, index) => method === REQUIRED_METHODS[index])
    && nativeClaims !== null
    && typeof nativeClaims === "object"
    && !Array.isArray(nativeClaims)
    && Object.keys(nativeClaims).length === 4
    && Object.hasOwn(nativeClaims, "productionSafe")
    && Object.hasOwn(nativeClaims, "pathWalkRaceSafe")
    && Object.hasOwn(nativeClaims, "credentialMutexSafe")
    && Object.hasOwn(nativeClaims, "credentialAuditFileGuardSafe")
    && typeof nativeClaims.productionSafe === "boolean"
    && typeof nativeClaims.pathWalkRaceSafe === "boolean"
    && typeof nativeClaims.credentialMutexSafe === "boolean"
    && typeof nativeClaims.credentialAuditFileGuardSafe === "boolean"
    && approvedPolicy !== null
    && typeof approvedPolicy === "object"
    && !Array.isArray(approvedPolicy)
    && Object.keys(approvedPolicy).length === 4
    && Object.hasOwn(approvedPolicy, "productionSafe")
    && Object.hasOwn(approvedPolicy, "pathWalkRaceSafe")
    && Object.hasOwn(approvedPolicy, "credentialMutexSafe")
    && Object.hasOwn(approvedPolicy, "credentialAuditFileGuardSafe")
    && typeof approvedPolicy.productionSafe === "boolean"
    && typeof approvedPolicy.pathWalkRaceSafe === "boolean"
    && approvedPolicy.credentialMutexSafe === true
    && approvedPolicy.credentialAuditFileGuardSafe === true
    && nativeClaims.productionSafe === approvedPolicy.productionSafe
    && nativeClaims.pathWalkRaceSafe === approvedPolicy.pathWalkRaceSafe
    && nativeClaims.credentialMutexSafe === approvedPolicy.credentialMutexSafe
    && nativeClaims.credentialAuditFileGuardSafe
      === approvedPolicy.credentialAuditFileGuardSafe
    && validBindingProvenance(bindingProvenance)
    && (!policyRequiresAuthenticatedProvenance(approvedPolicy)
      || bindingProvenance.status === "authenticated");
  if (!valid) throw failure("INVALID_MANIFEST");
  return Object.freeze({
    ...manifest,
    nativeClaims: Object.freeze({ ...nativeClaims }),
    approvedPolicy: Object.freeze({ ...approvedPolicy }),
    bindingProvenance: Object.freeze({ ...bindingProvenance }),
    requiredMethods: Object.freeze([...requiredMethods]),
  });
}

function assertBinding(binding) {
  let valid = binding !== null && typeof binding === "object";
  try {
    for (const method of REQUIRED_METHODS) valid = valid && typeof binding?.[method] === "function";
    valid = valid
      && binding?.contractVersion === "windows-filesystem-v1"
      && binding?.securityContractVersion === "windows-filesystem-security-v1"
      && binding?.credentialAuditFileGuardContractVersion
        === "windows-credential-audit-file-guard-v1"
      && binding?.credentialMutexContractVersion === "windows-credential-mutex-v1"
      && typeof binding?.productionSafe === "boolean"
      && typeof binding?.pathWalkRaceSafe === "boolean"
      && binding?.credentialMutexSafe === true;
    valid = valid && binding?.credentialAuditFileGuardSafe === true;
  } catch {
    valid = false;
  }
  if (!valid) throw failure("INVALID_BINDING");
  return binding;
}

function bindingManifestPath(bindingPath) {
  // The manifest is a fixed sidecar of the repository-owned binary. It is not
  // caller-selectable, which prevents a caller from pairing a binary with a
  // manifest from another directory or package.
  return `${bindingPath}.manifest.json`;
}

function verifyBindingIntegrity({
  bindingPath,
  readManifest,
  readBindingBytes,
  requireBinding,
}) {
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = normalizeManifestBytes(
      readManifest(bindingManifestPath(bindingPath)),
    );
    manifest = assertBindingManifest(parseBindingManifest(manifestBytes));
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_FILESYSTEM_")) throw error;
    throw failure("MANIFEST_UNAVAILABLE");
  }

  let bytes;
  try {
    bytes = normalizeBindingBytes(readBindingBytes(bindingPath));
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_FILESYSTEM_")) throw error;
    throw failure("BINDING_UNAVAILABLE");
  }
  if (bytes.byteLength !== manifest.bytes
      || bindingSha256(bytes) !== manifest.sha256) {
    throw failure("BINDING_INTEGRITY_MISMATCH");
  }

  // Reject any manifest/native production claim before loading executable
  // binding code. The current verifier has no trusted OS/package boundary,
  // so an authenticated-looking sidecar cannot cause requireBinding() to run.
  if (manifestRequiresAuthenticatedProvenance(manifest)) {
    assertBindingProvenanceAvailable({
      bindingPath,
      bindingBytes: bytes,
      manifest,
    });
  }

  let binding;
  try {
    binding = assertBinding(requireBinding(bindingPath));
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_FILESYSTEM_")) throw error;
    throw failure("BINDING_UNAVAILABLE");
  }
  if (binding.contractVersion !== manifest.contractVersion
      || binding.securityContractVersion !== manifest.securityContractVersion
      || binding.productionSafe !== manifest.nativeClaims.productionSafe
      || binding.pathWalkRaceSafe !== manifest.nativeClaims.pathWalkRaceSafe
      || binding.credentialAuditFileGuardSafe
        !== manifest.nativeClaims.credentialAuditFileGuardSafe
      || binding.credentialMutexSafe !== manifest.nativeClaims.credentialMutexSafe
      || binding.credentialAuditFileGuardContractVersion
        !== manifest.credentialAuditFileGuardContractVersion
      || binding.credentialMutexContractVersion !== manifest.credentialMutexContractVersion) {
    throw failure("MANIFEST_BINDING_MISMATCH");
  }

  return Object.freeze({ binding, manifest });
}

/**
 * Load the repository-owned native Windows adapter. This is deliberately
 * platform- and architecture-gated: a missing or unreviewed binary must not
 * silently turn a POSIX-style path check into a Windows production claim.
 */
function loadVerifiedWindowsFilesystemBinding({
  platform = process.platform,
  architecture = process.arch,
  bindingPath = NATIVE_BINDING_PATH,
  resolveBinding = (path) => path,
  requireBinding = (path) => require(path),
  readManifest = (path) => readFileSync(path, "utf8"),
  readBindingBytes = (path) => readFileSync(path),
} = {}) {
  if (platform !== "win32") throw failure("UNSUPPORTED_PLATFORM");
  if (architecture !== "x64") throw failure("UNSUPPORTED_ARCHITECTURE");
  if (typeof resolveBinding !== "function"
      || typeof requireBinding !== "function"
      || typeof readManifest !== "function"
      || typeof readBindingBytes !== "function") {
    throw failure("INVALID_CONFIGURATION");
  }
  let resolved;
  try {
    resolved = resolveBinding(bindingPath);
    normalizeBindingPath(resolved, platform);
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_FILESYSTEM_")) throw error;
    throw failure("BINDING_UNAVAILABLE");
  }
  try {
    return verifyBindingIntegrity({
      bindingPath: resolved,
      readManifest,
      readBindingBytes,
      requireBinding,
    });
  } catch (error) {
    if (error?.code?.startsWith("WINDOWS_FILESYSTEM_")) throw error;
    throw failure("BINDING_UNAVAILABLE");
  }
}

export function loadWindowsFilesystemBinding(options = {}) {
  return loadVerifiedWindowsFilesystemBinding(options).binding;
}

function fixedOperationError(code) {
  const error = new Error("Windows filesystem operation failed");
  error.code = code;
  return error;
}

function normalizeNativeError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "ENOENT" || code === "EEXIST") return error;
  if (code === "WINDOWS_FILESYSTEM_NOT_FOUND") return fixedOperationError("ENOENT");
  if (code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS") return fixedOperationError("EEXIST");
  return error?.code?.startsWith("WINDOWS_FILESYSTEM_")
    ? error
    : fixedOperationError("WINDOWS_FILESYSTEM_OPERATION_FAILED");
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
      || typeof identity.volumeSerialNumber !== "string"
      || !/^[0-9a-f]{16}$/u.test(identity.volumeSerialNumber)
      || typeof identity.fileId !== "string"
      || !/^[0-9a-f]{32}$/u.test(identity.fileId)
      || !Number.isSafeInteger(identity.linkCount)
      || identity.linkCount < 0) {
    throw failure("INVALID_IDENTITY");
  }
  return Object.freeze({
    volumeSerialNumber: identity.volumeSerialNumber,
    fileId: identity.fileId,
    linkCount: identity.linkCount,
  });
}

function normalizeReadMaximum(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes)
      || maximumBytes < 0
      || maximumBytes > MAXIMUM_FILE_BYTES) {
    throw failure("INVALID_MAXIMUM_BYTES");
  }
  return maximumBytes;
}

function normalizeProtectedRootIdentity(identity) {
  const normalized = normalizeIdentity(identity);
  if (normalized.linkCount !== 1) throw failure("INVALID_IDENTITY");
  return normalized;
}

function normalizeDataResult(result) {
  if (!result || !Buffer.isBuffer(result.data)) throw failure("INVALID_RESULT");
  return Object.freeze({
    data: Buffer.from(result.data),
    identity: normalizeIdentity(result.identity),
  });
}

function normalizeMetadataResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw failure("INVALID_RESULT");
  }
  return Object.freeze({
    ...result,
    identity: normalizeIdentity(result.identity),
  });
}

function call(binding, method, args) {
  try {
    return binding[method](...args);
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

/**
 * Return the adapter for a Windows host, or null on every other host. An
 * injected binding is supported for portable contract tests; production
 * callers should let the loader select the repository-owned binary.
 */
export function createWindowsFilesystemAdapter({
  platform = process.platform,
  architecture = process.arch,
  binding = null,
  ...loaderOptions
} = {}) {
  if (platform !== "win32") return null;
  let native;
  if (binding === null) {
    const loadOptions = {
      platform,
      architecture,
      ...loaderOptions,
    };
    const verified = loadVerifiedWindowsFilesystemBinding(loadOptions);
    native = verified.binding;
  } else {
    native = assertBinding(binding);
  }
  const adapter = Object.freeze({
    // The current loader has no trusted package verifier, so these remain
    // false even if an injected/native object or sidecar claims otherwise.
    productionSafe: false,
    pathWalkRaceSafe: false,
    inspectPath(path) {
      try {
        return normalizeMetadataResult(call(native, "inspectPath", [path]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    ensureDirectory(path) {
      try {
        return normalizeIdentity(call(native, "ensureDirectory", [path]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    readFile(path) {
      try {
        return normalizeDataResult(call(native, "readFile", [path]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    readFileBounded(path, maximumBytes) {
      const maximum = normalizeReadMaximum(maximumBytes);
      try {
        return normalizeDataResult(call(native, "readFileBounded", [path, maximum]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    createFile(path, data) {
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw failure("INVALID_DATA");
      try {
        return normalizeIdentity(call(native, "createFile", [path, Buffer.from(data)]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    deleteFile(path, identity) {
      const expected = normalizeIdentity(identity);
      try {
        const result = call(native, "deleteFile", [path, expected]);
        if (!result?.deleted) throw failure("INVALID_RESULT");
        return Object.freeze({ deleted: true, identity: normalizeIdentity(result.identity) });
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    replaceFile(path, identity, data) {
      const expected = normalizeIdentity(identity);
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw failure("INVALID_DATA");
      try {
        return normalizeIdentity(call(native, "replaceFile", [
          path,
          expected,
          Buffer.from(data),
        ]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    inspectProtectedChild(rootPath, rootIdentity, childPath) {
      const expectedRoot = normalizeProtectedRootIdentity(rootIdentity);
      try {
        return normalizeMetadataResult(call(native, "inspectProtectedChild", [
          rootPath,
          expectedRoot,
          childPath,
        ]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    readProtectedChild(rootPath, rootIdentity, childPath, maximumBytes) {
      const expectedRoot = normalizeProtectedRootIdentity(rootIdentity);
      const maximum = normalizeReadMaximum(maximumBytes);
      try {
        return normalizeDataResult(call(native, "readProtectedChild", [
          rootPath,
          expectedRoot,
          childPath,
          maximum,
        ]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    createProtectedChild(rootPath, rootIdentity, childPath, data) {
      const expectedRoot = normalizeProtectedRootIdentity(rootIdentity);
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
        throw failure("INVALID_DATA");
      }
      try {
        return normalizeIdentity(call(native, "createProtectedChild", [
          rootPath,
          expectedRoot,
          childPath,
          Buffer.from(data),
        ]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    deleteProtectedChild(rootPath, rootIdentity, childPath, identity) {
      const expectedRoot = normalizeProtectedRootIdentity(rootIdentity);
      const expected = normalizeIdentity(identity);
      try {
        const result = call(native, "deleteProtectedChild", [
          rootPath,
          expectedRoot,
          childPath,
          expected,
        ]);
        if (!result?.deleted) throw failure("INVALID_RESULT");
        return Object.freeze({
          deleted: true,
          identity: normalizeIdentity(result.identity),
        });
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
    replaceProtectedChild(rootPath, rootIdentity, childPath, identity, data) {
      const expectedRoot = normalizeProtectedRootIdentity(rootIdentity);
      const expected = normalizeIdentity(identity);
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
        throw failure("INVALID_DATA");
      }
      try {
        return normalizeIdentity(call(native, "replaceProtectedChild", [
          rootPath,
          expectedRoot,
          childPath,
          expected,
          Buffer.from(data),
        ]));
      } catch (error) {
        throw normalizeNativeError(error);
      }
    },
  });
  WINDOWS_FILESYSTEM_ADAPTERS.add(adapter);
  return adapter;
}

export function isWindowsFilesystemAdapter(adapter) {
  try {
    return adapter !== null
      && typeof adapter === "object"
      && WINDOWS_FILESYSTEM_ADAPTERS.has(adapter);
  } catch {
    return false;
  }
}

export function isWindowsFilesystemNotFound(error) {
  return error?.code === "ENOENT" || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND";
}

export function isWindowsFilesystemAlreadyExists(error) {
  return error?.code === "EEXIST" || error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS";
}

export function isWindowsFilesystemIdentity(identity) {
  try {
    normalizeIdentity(identity);
    return true;
  } catch {
    return false;
  }
}

export function assertWindowsFilesystemProductionSafe(adapter) {
  let valid = false;
  try {
    valid = isWindowsFilesystemAdapter(adapter)
      && adapter.productionSafe === true
      && adapter.pathWalkRaceSafe === true;
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error("Windows filesystem production policy is unavailable");
    error.code = "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE";
    throw error;
  }
  return adapter;
}
