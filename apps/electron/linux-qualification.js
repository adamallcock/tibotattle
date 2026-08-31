import { isProxy } from "node:util/types";

export const LINUX_ELECTRON_QUALIFICATION_CONTRACT =
  "linux-electron-qualification-v1";

const INPUT_KEYS = Object.freeze([
  "platform",
  "architecture",
  "sourceRevision",
  "distribution",
  "desktopProtocol",
  "credentialStoreMode",
  "subjectKind",
  "artifactDigest",
  "developmentOnly",
]);
const RECEIPT_KEYS = Object.freeze([
  "contractVersion",
  ...INPUT_KEYS,
]);
const ARCHITECTURE_VALUES = Object.freeze(["arm64", "x64"]);
const DISTRIBUTION_VALUES = Object.freeze(["debian-bookworm", "ubuntu-24.04"]);
const DESKTOP_PROTOCOL_VALUES = Object.freeze(["x11", "wayland", "none"]);
const CREDENTIAL_STORE_MODE_VALUES = Object.freeze([
  "unavailable",
  "isolated-secret-service",
  "native-secret-service",
]);
const SUBJECT_KIND_VALUES = Object.freeze(["source", "unpacked", "installed"]);
const ARCHITECTURES = new Set(ARCHITECTURE_VALUES);
const DISTRIBUTIONS = new Set(DISTRIBUTION_VALUES);
const DESKTOP_PROTOCOLS = new Set(DESKTOP_PROTOCOL_VALUES);
const CREDENTIAL_STORE_MODES = new Set(CREDENTIAL_STORE_MODE_VALUES);
const SUBJECT_KINDS = new Set(SUBJECT_KIND_VALUES);
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CONTEXTS = new WeakSet();
const ERROR_CODES = new Set([
  "shape_invalid",
  "identity_invalid",
  "source_revision_invalid",
  "matrix_invalid",
  "subject_invalid",
  "development_only_required",
  "artifact_invalid",
  "context_untrusted",
  "contract_invalid",
  "native_identity_invalid",
]);

export class LinuxQualificationError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Linux qualification error code");
    }
    super("Linux Electron qualification context is invalid");
    this.name = "LinuxQualificationError";
    this.code = `linux_electron_qualification_${code}`;
  }
}

function fail(code) {
  throw new LinuxQualificationError(code);
}

function exactDataRecord(value, keys) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("shape_invalid");
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    fail("shape_invalid");
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true) {
      fail("shape_invalid");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function normalizedFields(source) {
  if (source.platform !== "linux" || !ARCHITECTURES.has(source.architecture)) {
    fail("identity_invalid");
  }
  if (typeof source.sourceRevision !== "string"
      || !REVISION_PATTERN.test(source.sourceRevision)) {
    fail("source_revision_invalid");
  }
  if (!DISTRIBUTIONS.has(source.distribution)
      || !DESKTOP_PROTOCOLS.has(source.desktopProtocol)
      || !CREDENTIAL_STORE_MODES.has(source.credentialStoreMode)) {
    fail("matrix_invalid");
  }
  if (!SUBJECT_KINDS.has(source.subjectKind)) fail("subject_invalid");
  if (source.developmentOnly !== true) fail("development_only_required");
  if (source.subjectKind === "source") {
    if (source.artifactDigest !== null) fail("artifact_invalid");
  } else if (typeof source.artifactDigest !== "string"
      || !SHA256_PATTERN.test(source.artifactDigest)) {
    fail("artifact_invalid");
  }
  return Object.freeze({
    contractVersion: LINUX_ELECTRON_QUALIFICATION_CONTRACT,
    platform: "linux",
    architecture: source.architecture,
    sourceRevision: source.sourceRevision,
    distribution: source.distribution,
    desktopProtocol: source.desktopProtocol,
    credentialStoreMode: source.credentialStoreMode,
    subjectKind: source.subjectKind,
    artifactDigest: source.artifactDigest,
    developmentOnly: true,
  });
}

/**
 * Create an authority-bearing, development-only L0 context. This object is
 * deliberately not wired into the Electron entrypoint or any support gate.
 */
export function createLinuxQualificationContext(configuration) {
  const context = normalizedFields(exactDataRecord(configuration, INPUT_KEYS));
  CONTEXTS.add(context);
  return context;
}

/** Create a serializable content-free receipt from an authentic context. */
export function createLinuxQualificationReceipt(context) {
  if (!CONTEXTS.has(context)) fail("context_untrusted");
  return Object.freeze({ ...context });
}

export function assertLinuxQualificationReceipt(receipt) {
  const source = exactDataRecord(receipt, RECEIPT_KEYS);
  if (source.contractVersion !== LINUX_ELECTRON_QUALIFICATION_CONTRACT) {
    fail("contract_invalid");
  }
  return normalizedFields(source);
}

/**
 * Native Linux acceptance is x86_64-only for the first declared matrix.
 * ARM64 source evidence remains useful but cannot cross this assertion.
 */
export function assertLinuxNativeQualificationReceipt(receipt) {
  const value = assertLinuxQualificationReceipt(receipt);
  if (value.platform !== "linux" || value.architecture !== "x64") {
    fail("native_identity_invalid");
  }
  return value;
}

export {
  CREDENTIAL_STORE_MODE_VALUES as LINUX_QUALIFICATION_CREDENTIAL_STORE_MODES,
  DESKTOP_PROTOCOL_VALUES as LINUX_QUALIFICATION_DESKTOP_PROTOCOLS,
  DISTRIBUTION_VALUES as LINUX_QUALIFICATION_DISTRIBUTIONS,
  SUBJECT_KIND_VALUES as LINUX_QUALIFICATION_SUBJECT_KINDS,
};
