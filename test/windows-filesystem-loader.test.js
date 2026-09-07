import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertWindowsFilesystemProductionSafe,
  createWindowsFilesystemAdapter,
  isWindowsFilesystemAlreadyExists,
  isWindowsFilesystemNotFound,
  loadWindowsFilesystemBinding,
  WINDOWS_FILESYSTEM_BINDING_MANIFEST_SCHEMA_VERSION,
  WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
  WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED,
  WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE,
} from "../src/platform/windows-protected-state-store.js";

const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});
const BINDING_BYTES = Buffer.from("reviewed native binding bytes", "utf8");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(overrides = {}) {
  return {
    schemaVersion: WINDOWS_FILESYSTEM_BINDING_MANIFEST_SCHEMA_VERSION,
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: BINDING_BYTES.byteLength,
    sha256: sha256(BINDING_BYTES),
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    requiredMethods: [...WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS],
    nativeClaims: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
    },
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
    },
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    inspectPath: () => ({ identity: IDENTITY }),
    ensureDirectory: () => IDENTITY,
    readFile: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    createFile: () => IDENTITY,
    deleteFile: () => ({ deleted: true, identity: IDENTITY }),
    replaceFile: () => IDENTITY,
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => {},
    acquireAccountlessInstallationCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseAccountlessInstallationCredentialMutex: () => {},
    acquireCredentialAuditFileGuard: () => ({ lease: {} }),
    releaseCredentialAuditFileGuard: () => {},
    ...overrides,
  };
}

test("Windows native loader is inert on non-Windows hosts", () => {
  let resolved = false;
  assert.equal(createWindowsFilesystemAdapter({
    platform: "darwin",
    resolveBinding() {
      resolved = true;
      throw new Error("must not load");
    },
  }), null);
  assert.equal(resolved, false);
});

test("Windows native loader rejects unsupported platform and architecture before loading", () => {
  assert.throws(
    () => loadWindowsFilesystemBinding({ platform: "linux", architecture: "x64" }),
    (error) => error.code === "WINDOWS_FILESYSTEM_UNSUPPORTED_PLATFORM",
  );
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "arm64",
      resolveBinding() {
        throw new Error("must not load");
      },
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_UNSUPPORTED_ARCHITECTURE",
  );
});

test("Windows native loader accepts only the repository-owned binding contract", () => {
  const loaded = loadWindowsFilesystemBinding({
    platform: "win32",
    architecture: "x64",
    bindingPath: "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node",
    resolveBinding: (path) => path,
    readManifest: () => JSON.stringify(manifest()),
    readBindingBytes: () => BINDING_BYTES,
    requireBinding: () => binding(),
  });
  assert.equal(loaded.contractVersion, "windows-filesystem-v1");

  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath: "C:\\tmp\\untrusted.node",
      resolveBinding: (path) => path,
      requireBinding: () => binding(),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_BINDING_PATH",
  );
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath: "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node",
      resolveBinding: (path) => path,
      readManifest: () => JSON.stringify(manifest()),
      readBindingBytes: () => BINDING_BYTES,
      requireBinding: () => binding({ contractVersion: "unreviewed" }),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_BINDING",
  );
});

test("Windows native loader requires a sidecar manifest and exact binding digest", () => {
  const bindingPath = "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node";
  let required = false;
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath,
      resolveBinding: (path) => path,
      readManifest: () => {
        throw new Error("missing");
      },
      readBindingBytes: () => BINDING_BYTES,
      requireBinding: () => {
        required = true;
        return binding();
      },
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_MANIFEST_UNAVAILABLE",
  );
  assert.equal(required, false);

  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath,
      resolveBinding: (path) => path,
      readManifest: () => JSON.stringify(manifest()),
      readBindingBytes: () => Buffer.from("tampered binding", "utf8"),
      requireBinding: () => binding(),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_BINDING_INTEGRITY_MISMATCH",
  );
});

test("manifest policy and native claims are cross-checked before loading", () => {
  const bindingPath = "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node";
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath,
      resolveBinding: (path) => path,
      readManifest: () => JSON.stringify(manifest({
        nativeClaims: {
          productionSafe: true,
          pathWalkRaceSafe: true,
          credentialMutexSafe: true,
          credentialAuditFileGuardSafe: true,
        },
      })),
      readBindingBytes: () => BINDING_BYTES,
      requireBinding: () => binding(),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_MANIFEST_BINDING_MISMATCH",
  );
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath,
      resolveBinding: (path) => path,
      readManifest: () => JSON.stringify({
        ...manifest(),
        approvedPolicy: {
          productionSafe: true,
          pathWalkRaceSafe: true,
          credentialMutexSafe: true,
          credentialAuditFileGuardSafe: true,
        },
      }),
      readBindingBytes: () => BINDING_BYTES,
      requireBinding: () => binding(),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_MANIFEST",
  );
});

test("adapter production flags require the reviewed manifest policy as well as native claims", () => {
  const bindingPath = "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node";
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    bindingPath,
    resolveBinding: (path) => path,
    readManifest: () => JSON.stringify(manifest()),
    readBindingBytes: () => BINDING_BYTES,
    requireBinding: () => binding(),
  });
  assert.equal(adapter.productionSafe, false);
  assert.equal(adapter.pathWalkRaceSafe, false);
});

test("adapter validates native identities and keeps operation errors fixed", () => {
  const calls = [];
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding({
      readFile(path) {
        calls.push(["read", path]);
        return { data: Buffer.from("secret"), identity: IDENTITY };
      },
    }),
  });
  assert.equal(adapter.productionSafe, false);
  assert.equal(adapter.pathWalkRaceSafe, false);
  assert.deepEqual(adapter.readFile("C:\\state\\secret"), {
    data: Buffer.from("secret"),
    identity: IDENTITY,
  });
  assert.deepEqual(adapter.inspectPath("C:\\state\\secret").identity, IDENTITY);
  assert.deepEqual(adapter.replaceFile("C:\\state\\secret", IDENTITY, Buffer.from("next")), IDENTITY);
  assert.equal(calls.length, 1);

  const missing = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding({
      readFile() {
        const error = new Error("path must not appear");
        error.code = "WINDOWS_FILESYSTEM_NOT_FOUND";
        throw error;
      },
    }),
  });
  assert.throws(() => missing.readFile("C:\\private\\secret"), (error) => {
    assert.equal(error.code, "ENOENT");
    assert.equal(error.message.includes("private"), false);
    return true;
  });
  assert.equal(isWindowsFilesystemNotFound({ code: "ENOENT" }), true);
  assert.equal(isWindowsFilesystemAlreadyExists({ code: "EEXIST" }), true);
});

test("adapter forwards every root-bound protected-child operation", () => {
  const calls = [];
  const protectedMetadata = Object.freeze({ marker: "inspect" });
  const protectedRead = Object.freeze({ data: Buffer.from("protected"), identity: IDENTITY });
  const protectedDelete = Object.freeze({ deleted: true, identity: IDENTITY });
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding({
      inspectProtectedChild(...arguments_) {
        calls.push(["inspect", ...arguments_]);
        return protectedMetadata;
      },
      readProtectedChild(...arguments_) {
        calls.push(["read", ...arguments_]);
        return protectedRead;
      },
      createProtectedChild(...arguments_) {
        calls.push(["create", ...arguments_]);
        return IDENTITY;
      },
      deleteProtectedChild(...arguments_) {
        calls.push(["delete", ...arguments_]);
        return protectedDelete;
      },
      replaceProtectedChild(...arguments_) {
        calls.push(["replace", ...arguments_]);
        return IDENTITY;
      },
    }),
  });
  const root = "C:\\state\\private";
  const child = "settings.json";
  const first = Buffer.from("first", "utf8");
  const second = Buffer.from("second", "utf8");

  assert.equal(adapter.inspectProtectedChild(root, IDENTITY, child), protectedMetadata);
  assert.equal(adapter.readProtectedChild(root, IDENTITY, child, 64), protectedRead);
  assert.deepEqual(adapter.createProtectedChild(root, IDENTITY, child, first), IDENTITY);
  assert.equal(adapter.deleteProtectedChild(root, IDENTITY, child, IDENTITY), protectedDelete);
  assert.deepEqual(adapter.replaceProtectedChild(root, IDENTITY, child, IDENTITY, second), IDENTITY);
  assert.deepEqual(calls, [
    ["inspect", root, IDENTITY, child],
    ["read", root, IDENTITY, child, 64],
    ["create", root, IDENTITY, child, first],
    ["delete", root, IDENTITY, child, IDENTITY],
    ["replace", root, IDENTITY, child, IDENTITY, second],
  ]);
});

test("adapter exposes the fixed private accountless mutex without a legacy capability ID", () => {
  const calls = [];
  const nativeLease = Object.freeze({ native: true });
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding({
      acquireAccountlessInstallationCredentialMutex(...arguments_) {
        calls.push(["acquire", ...arguments_]);
        return Object.freeze({ abandoned: true, lease: nativeLease });
      },
      releaseAccountlessInstallationCredentialMutex(...arguments_) {
        calls.push(["release", ...arguments_]);
      },
    }),
  });
  const acquired = adapter.acquireAccountlessInstallationCredentialMutex();
  assert.equal(acquired.abandoned, true);
  assert.equal(acquired.lease, nativeLease);
  adapter.releaseAccountlessInstallationCredentialMutex(acquired.lease);
  assert.deepEqual(calls, [
    ["acquire"],
    ["release", nativeLease],
  ]);
});

test("protected state rejects an adapter without the complete native child surface", () => {
  assert.equal(WINDOWS_PROTECTED_STATE_STORE_ROOT_BINDING_SAFE, false);
  assert.equal(WINDOWS_PROTECTED_STATE_STORE_NATIVE_READ_BOUNDED, false);
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding(),
  });
  assert.throws(
    () => createWindowsProtectedStateStore({
      adapter,
      rootPath: "C:\\state\\private",
    }),
    (error) => isWindowsProtectedStateStoreError(error)
      && error.code === "windows_protected_state_store_invalid_adapter",
  );
});

test("adapter rejects malformed native identities before use", () => {
  const malformed = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding({
      readFile: () => ({ data: Buffer.from("secret"), identity: { fileId: "bad" } }),
    }),
  });
  assert.throws(
    () => malformed.readFile("C:\\state\\secret"),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_IDENTITY",
  );
});

test("production integration guard rejects the unproven native path walk", () => {
  assert.throws(
    () => assertWindowsFilesystemProductionSafe({ productionSafe: false, pathWalkRaceSafe: false }),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE",
  );
  const safe = { productionSafe: true, pathWalkRaceSafe: true };
  assert.equal(assertWindowsFilesystemProductionSafe(safe), safe);
});
