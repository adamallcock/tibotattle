import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
} from "../src/export-identity-keychain.js";
import { selectProductionAccountObservationSecret } from "../src/account-observation-production.js";
import { createProductionClaudeCallbackBackend } from "../src/claude-callback-capability.js";
import { createProductionContributionDeviceBackend } from "../src/contribution-device-capability.js";
import { selectProductionParticipantIdentity } from "../src/export-identity-production.js";
import {
  WINDOWS_PRODUCTION_READINESS,
  WindowsProductionReadinessError,
  assertWindowsProductionBackend,
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
  createWindowsProductionReadinessAttestation,
} from "../src/platform/windows-production-readiness.js";

const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.exportIdentity;

function readinessError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsProductionReadinessError, true);
    assert.equal(error.code, `windows_production_readiness_${code}`);
    assert.equal(error.message, "Windows production credential readiness is unavailable");
    return true;
  };
}

function qualifiedReadiness() {
  return createWindowsProductionReadinessAttestation({
    qualifiedAt: "2026-08-17T12:00:00.000Z",
    qualificationReceipt: "windows-qualification-receipt-v1",
    credentialMutexSafe: true,
    durableAuditSafe: true,
    protectedStatePathsSafe: true,
    authenticatedBindingSafe: true,
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "qualified",
      source: "audited-signed-native-binding",
    },
  });
}

test("the current Windows readiness state is explicitly disabled", () => {
  assert.equal(WINDOWS_PRODUCTION_READINESS.status, "disabled");
  assert.equal(WINDOWS_PRODUCTION_READINESS.credentialMutexSafe, false);
  assert.equal(WINDOWS_PRODUCTION_READINESS.durableAuditSafe, false);
  assert.equal(WINDOWS_PRODUCTION_READINESS.protectedStatePathsSafe, false);
  assert.equal(WINDOWS_PRODUCTION_READINESS.authenticatedBindingSafe, false);
  assert.throws(
    () => assertWindowsProductionReadiness({
      platform: "win32",
      architecture: "x64",
      readiness: WINDOWS_PRODUCTION_READINESS,
    }),
    readinessError("unqualified"),
  );
});

test("Windows readiness requires all four facts and a qualified binding provenance", () => {
  assert.throws(
    () => createWindowsProductionReadinessAttestation({
      qualifiedAt: "2026-08-17T12:00:00.000Z",
      qualificationReceipt: "windows-qualification-receipt-v1",
      credentialMutexSafe: true,
      durableAuditSafe: true,
      protectedStatePathsSafe: true,
      authenticatedBindingSafe: false,
      bindingProvenance: {
        contractVersion: "windows-binding-provenance-v1",
        status: "qualified",
        source: "audited-signed-native-binding",
      },
    }),
    readinessError("invalid_configuration"),
  );
  assert.throws(
    () => createWindowsProductionReadinessAttestation({
      qualifiedAt: "2026-08-17T12:00:00.000Z",
      qualificationReceipt: "windows-qualification-receipt-v1",
      credentialMutexSafe: true,
      durableAuditSafe: true,
      protectedStatePathsSafe: true,
      authenticatedBindingSafe: true,
      bindingProvenance: {
        contractVersion: "windows-binding-provenance-v1",
        status: "qualified",
        source: "untrusted-input",
      },
    }),
    readinessError("invalid_configuration"),
  );
  const readiness = qualifiedReadiness();
  assert.equal(assertWindowsProductionReadiness({
    platform: "win32",
    architecture: "x64",
    readiness,
  }), readiness);
  assert.throws(
    () => assertWindowsProductionReadiness({
      platform: "win32",
      architecture: "x64",
      readiness: { ...readiness },
    }),
    readinessError("unqualified"),
  );
});

test("Windows capability adapter rejects the currently qualification-only manager", () => {
  const calls = [];
  const readiness = qualifiedReadiness();
  const backend = {
    productionSafe: false,
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    bindingProvenanceAuthenticated: false,
    read: async () => null,
    createIfMissing: async () => "created",
    replaceExact: async () => "replaced",
    deleteExact: async () => "deleted",
    withOperationLease: async () => {
      calls.push("withOperationLease");
    },
  };
  assert.throws(() => assertWindowsProductionBackend(backend), readinessError("backend_unqualified"));
  assert.throws(
    () => createWindowsProductionCapabilityBackend({
      backend,
      capability: CAPABILITY,
      readiness,
    }),
    readinessError("backend_unqualified"),
  );
  assert.deepEqual(calls, []);
});

test("Windows capability adapter holds a leased mutation boundary for qualified backends", async () => {
  const readiness = qualifiedReadiness();
  const calls = [];
  const stored = { value: null };
  const backend = {
    productionSafe: true,
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    bindingProvenanceAuthenticated: true,
    async read(capability) {
      assert.equal(capability, CAPABILITY);
      calls.push(["read"]);
      return stored.value === null ? null : Buffer.from(stored.value);
    },
    async withOperationLease(capability, options, callback) {
      assert.equal(capability, CAPABILITY);
      calls.push(["lease", options.operation]);
      return callback({ token: true });
    },
    async createIfMissing(capability, secret, lease) {
      assert.equal(capability, CAPABILITY);
      assert.deepEqual(lease, { token: true });
      calls.push(["create"]);
      if (stored.value !== null) return "existing";
      stored.value = Buffer.from(secret);
      return "created";
    },
    async replaceExact(capability, expected, replacement, lease) {
      assert.equal(capability, CAPABILITY);
      assert.deepEqual(lease, { token: true });
      calls.push(["replace"]);
      if (!stored.value) return "missing";
      if (!stored.value.equals(expected)) return "conflict";
      stored.value = Buffer.from(replacement);
      return "replaced";
    },
    async deleteExact(capability, expected, lease) {
      assert.equal(capability, CAPABILITY);
      assert.deepEqual(lease, { token: true });
      calls.push(["delete"]);
      if (!stored.value) return "missing";
      if (!stored.value.equals(expected)) return "conflict";
      stored.value = null;
      return "deleted";
    },
  };
  const adapted = createWindowsProductionCapabilityBackend({
    backend,
    capability: CAPABILITY,
    readiness,
  });
  const secret = Buffer.alloc(32, 44);
  assert.deepEqual(adapted.describe(), {
    backend: "windows_credential_manager",
    status: "available",
  });
  assert.equal(await adapted.createIfMissing(CAPABILITY, secret), "created");
  assert.equal(await adapted.replaceExact(CAPABILITY, secret, Buffer.alloc(32, 45)), "replaced");
  assert.equal(await adapted.deleteExact(CAPABILITY, Buffer.alloc(32, 45)), "deleted");
  assert.deepEqual(calls.map(([event]) => event), ["lease", "create", "lease", "replace", "lease", "delete"]);
  await assert.rejects(
    adapted.read({ ...CAPABILITY }),
    readinessError("invalid_configuration"),
  );
});

test("qualified participant selection retains the required Windows filesystem seam", () => {
  const readiness = qualifiedReadiness();
  const filesystem = {
    productionSafe: true,
    pathWalkRaceSafe: true,
  };
  const backend = {
    productionSafe: true,
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    bindingProvenanceAuthenticated: true,
    read: async () => null,
    createIfMissing: async () => "created",
    replaceExact: async () => "replaced",
    deleteExact: async () => "deleted",
    withOperationLease: async (capability, options, callback) => callback({}),
  };
  const selected = selectProductionParticipantIdentity({
    environmentSecret: null,
    explicitSecretFile: null,
    platform: "win32",
    architecture: "x64",
    appStateSecretFile: "C:\\app-state\\export-secret",
    windowsReadiness: readiness,
    createWindowsBackend: () => backend,
    windowsFilesystemAdapter: filesystem,
  });
  assert.equal(selected.mode, "windows_credential_manager");
  assert.equal(selected.identityOptions.windowsFilesystemAdapter, filesystem);
  assert.deepEqual(selected.identityOptions.participantSecretBackend.describe(), {
    backend: "windows_credential_manager",
    status: "available",
  });
});

test("all four production selectors remain closed while the manager reports qualification-only", () => {
  const readiness = qualifiedReadiness();
  let constructions = 0;
  const qualificationOnlyBackend = {
    productionSafe: false,
    crossProcessSafe: true,
    auditDurable: true,
    auditFilesystemProtected: true,
    startupRecoveryComplete: true,
    bindingProvenanceAuthenticated: false,
    read: async () => null,
    createIfMissing: async () => "created",
    replaceExact: async () => "replaced",
    deleteExact: async () => "deleted",
    withOperationLease: async () => null,
  };
  const createWindowsBackend = () => {
    constructions += 1;
    return qualificationOnlyBackend;
  };
  assert.throws(() => selectProductionParticipantIdentity({
    environmentSecret: null,
    explicitSecretFile: null,
    platform: "win32",
    architecture: "x64",
    appStateSecretFile: "C:\\app-state\\export-secret",
    windowsReadiness: readiness,
    createWindowsBackend,
    windowsFilesystemAdapter: {
      productionSafe: true,
      pathWalkRaceSafe: true,
    },
  }), (error) => error.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE");
  assert.throws(() => selectProductionAccountObservationSecret({
    platform: "win32",
    architecture: "x64",
    operationLockFile: "C:\\app-state\\account-operation.lock",
    windowsReadiness: readiness,
    createWindowsBackend,
  }), (error) => error.code === "ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  assert.throws(() => createProductionClaudeCallbackBackend({
    platform: "win32",
    architecture: "x64",
    windowsReadiness: readiness,
    createWindowsBackend,
  }), (error) => error.code === "claude_callback_invalid_configuration");
  assert.throws(() => createProductionContributionDeviceBackend({
    platform: "win32",
    architecture: "x64",
    windowsReadiness: readiness,
    createWindowsBackend,
  }), (error) => error.code === "contribution_device_invalid_configuration");
  assert.equal(constructions, 4);
});
