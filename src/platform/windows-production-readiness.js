const READINESS_CONTRACT_VERSION = "windows-production-readiness-v1";
const BINDING_PROVENANCE_CONTRACT_VERSION = "windows-binding-provenance-v1";

const READINESS_ERROR_CODES = new Set([
  "invalid_configuration",
  "unsupported_architecture",
  "unqualified",
  "backend_unqualified",
]);

// These registries are deliberately module-private. A readiness-shaped object
// or a backend-shaped object copied from a receipt must never become a
// production authorization merely by crossing a JavaScript API boundary.
const READINESS_ATTESTATIONS = new WeakSet();
const TRUSTED_PRODUCTION_BACKENDS = new WeakSet();
const TRUSTED_CONSTRUCTION_AUTHORITY = Object.freeze({});

/**
 * The Windows credential consumers all depend on the same four facts. Keep
 * this list in one place so a selector cannot accidentally enable itself after
 * only proving the Credential Manager round-trip.
 */
export const WINDOWS_PRODUCTION_READINESS_FACTS = Object.freeze([
  "credentialMutexSafe",
  "durableAuditSafe",
  "protectedStatePathsSafe",
  "authenticatedBindingSafe",
]);

/**
 * This is the current product state, intentionally unqualified. It is a
 * summary for diagnostics and tests, not an attestation that can enable a
 * selector. A future Windows qualification step must create a branded
 * attestation through a trusted verifier inside this module.
 */
export const WINDOWS_PRODUCTION_READINESS = Object.freeze({
  contractVersion: READINESS_CONTRACT_VERSION,
  status: "disabled",
  platform: "win32",
  architecture: "x64",
  credentialMutexSafe: false,
  durableAuditSafe: false,
  protectedStatePathsSafe: false,
  authenticatedBindingSafe: false,
  bindingProvenance: Object.freeze({
    contractVersion: BINDING_PROVENANCE_CONTRACT_VERSION,
    status: "unqualified",
  }),
});

export class WindowsProductionReadinessError extends Error {
  constructor(code) {
    if (!READINESS_ERROR_CODES.has(code)) {
      throw new TypeError("Unknown Windows production readiness error code");
    }
    super("Windows production credential readiness is unavailable");
    this.name = "WindowsProductionReadinessError";
    this.code = `windows_production_readiness_${code}`;
  }
}

function fail(code) {
  throw new WindowsProductionReadinessError(code);
}

function exactQualifiedTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("invalid_configuration");
  }
  const parsed = new Date(value);
  if (parsed.toISOString() !== value) fail("invalid_configuration");
  return value;
}

function validBindingProvenance(value) {
  let valid = false;
  try {
    valid = value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && value.contractVersion === BINDING_PROVENANCE_CONTRACT_VERSION
      && value.status === "qualified"
      && value.source === "audited-signed-native-binding";
  } catch {
    // Treat hostile property access as an unqualified binding.
  }
  return valid;
}

/**
 * Internal-only construction hook for a future trusted verifier. The
 * authority is module-private and is not returned by any public API. No
 * current code calls this hook because the native/package provenance verifier
 * does not exist yet.
 */
function issueTrustedWindowsProductionReadinessAttestation({
  authority,
  qualifiedAt,
  qualificationReceipt,
} = {}) {
  if (authority !== TRUSTED_CONSTRUCTION_AUTHORITY) fail("invalid_configuration");
  if (typeof qualificationReceipt !== "string"
      || !/^windows-[a-z0-9][a-z0-9-]{2,127}$/u.test(qualificationReceipt)) {
    fail("invalid_configuration");
  }
  exactQualifiedTimestamp(qualifiedAt);

  const attestation = Object.freeze({
    contractVersion: READINESS_CONTRACT_VERSION,
    status: "qualified",
    platform: "win32",
    architecture: "x64",
    credentialMutexSafe: true,
    durableAuditSafe: true,
    protectedStatePathsSafe: true,
    authenticatedBindingSafe: true,
    bindingProvenance: Object.freeze({
      contractVersion: BINDING_PROVENANCE_CONTRACT_VERSION,
      status: "qualified",
      source: "audited-signed-native-binding",
    }),
    qualificationReceipt,
    qualifiedAt,
  });
  READINESS_ATTESTATIONS.add(attestation);
  return attestation;
}

/**
 * The old public constructor is retained as a compatibility surface for
 * callers that have not migrated, but it cannot mint an authorization. Until
 * a trusted native/package verifier exists, every attempted promotion is
 * unavailable, including one supplied with four true booleans and a receipt
 * that merely has the expected shape.
 */
export function createWindowsProductionReadinessAttestation() {
  fail("unqualified");
}

/**
 * Assert that a Windows selector has an explicit, complete qualification
 * receipt. Plain objects are not accepted, even if their fields look correct;
 * this prevents an accidental environment/configuration copy from becoming a
 * production authorization.
 */
export function assertWindowsProductionReadiness({
  platform,
  architecture,
  readiness = null,
} = {}) {
  if (platform !== "win32") return null;
  if (architecture !== "x64") fail("unsupported_architecture");
  if (!READINESS_ATTESTATIONS.has(readiness)) fail("unqualified");
  let valid = false;
  try {
    valid = readiness.contractVersion === READINESS_CONTRACT_VERSION
      && readiness.status === "qualified"
      && readiness.platform === "win32"
      && readiness.architecture === "x64"
      && WINDOWS_PRODUCTION_READINESS_FACTS.every((fact) => readiness[fact] === true)
      && validBindingProvenance(readiness.bindingProvenance);
  } catch {
    // Branded but malformed objects still fail closed.
  }
  if (!valid) fail("unqualified");
  return readiness;
}

/**
 * A qualified manager must expose the native/ durable guarantees before a
 * capability adapter is made visible to a consumer. The current Windows
 * manager intentionally reports productionSafe=false, so this gate remains
 * closed until the filesystem and binding work is complete.
 */
export function assertWindowsProductionBackend(backend) {
  let valid = false;
  try {
    valid = TRUSTED_PRODUCTION_BACKENDS.has(backend)
      && backend !== null
      && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function"
      && typeof backend.replaceExact === "function"
      && typeof backend.deleteExact === "function"
      && typeof backend.withOperationLease === "function"
      && backend.crossProcessSafe === true
      && backend.auditDurable === true
      && backend.auditFilesystemProtected === true
      && backend.startupRecoveryComplete === true
      && backend.bindingProvenanceAuthenticated === true
      && backend.productionSafe === true;
  } catch {
    // Collapse hostile backends to the fixed gate error.
  }
  if (!valid) fail("backend_unqualified");
  return backend;
}

/**
 * Internal-only backend branding hook for the future Windows manager. The
 * current manager deliberately cannot call this without a trusted native
 * binding/provenance verifier, so production promotion remains unavailable.
 */
function issueTrustedWindowsProductionBackend(backend, authority) {
  if (authority !== TRUSTED_CONSTRUCTION_AUTHORITY) fail("invalid_configuration");
  TRUSTED_PRODUCTION_BACKENDS.add(backend);
  return backend;
}

function assertCapability(capability, expected) {
  if (capability !== expected) fail("invalid_configuration");
}

/**
 * Adapt the manager's leased mutation API to the narrow backend contract used
 * by each existing credential capability. Reads remain direct; every create,
 * replace, and delete acquires the manager's named mutex and durable audit
 * lease before touching the native credential.
 */
export function createWindowsProductionCapabilityBackend({
  backend,
  capability,
  readiness = null,
} = {}) {
  assertWindowsProductionReadiness({
    platform: "win32",
    architecture: "x64",
    readiness,
  });
  const selected = assertWindowsProductionBackend(backend);
  if (capability === null || typeof capability !== "object") {
    fail("invalid_configuration");
  }

  async function read(receivedCapability) {
    assertCapability(receivedCapability, capability);
    return selected.read(capability);
  }

  async function mutate(operation, method, receivedCapability, ...args) {
    assertCapability(receivedCapability, capability);
    return selected.withOperationLease(
      capability,
      { operation },
      (lease) => selected[method](capability, ...args, lease),
    );
  }

  return Object.freeze({
    read,
    createIfMissing: (receivedCapability, secret) => mutate(
      "create",
      "createIfMissing",
      receivedCapability,
      secret,
    ),
    replaceExact: (receivedCapability, expected, replacement) => mutate(
      "replace",
      "replaceExact",
      receivedCapability,
      expected,
      replacement,
    ),
    deleteExact: (receivedCapability, expected) => mutate(
      "delete",
      "deleteExact",
      receivedCapability,
      expected,
    ),
    describe: () => Object.freeze({
      backend: "windows_credential_manager",
      status: "available",
    }),
    productionSafe: true,
    crossProcessSafe: true,
    auditDurable: true,
  });
}

export const WINDOWS_PRODUCTION_READINESS_CONTRACT_VERSION =
  READINESS_CONTRACT_VERSION;
export const WINDOWS_BINDING_PROVENANCE_CONTRACT_VERSION =
  BINDING_PROVENANCE_CONTRACT_VERSION;
