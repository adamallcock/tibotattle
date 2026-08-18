import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertWindowsFilesystemProductionSafe,
  createWindowsFilesystemAdapter,
  isWindowsFilesystemAlreadyExists,
  isWindowsFilesystemAdapter,
  isWindowsFilesystemNotFound,
  loadWindowsFilesystemBinding,
  WINDOWS_FILESYSTEM_BINDING_MANIFEST_SCHEMA_VERSION,
  WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS,
} from "../src/platform/windows-filesystem.js";

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
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
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

test("Windows native loader rejects malformed binding provenance before loading", () => {
  const bindingPath = "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node";
  let required = false;
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath,
      resolveBinding: (path) => path,
      readManifest: () => JSON.stringify(manifest({
        bindingProvenance: {
          contractVersion: "windows-binding-provenance-v1",
          status: "unqualified",
          source: "unsigned-development-binding",
          extra: "reject",
        },
      })),
      readBindingBytes: () => BINDING_BYTES,
      requireBinding: () => {
        required = true;
        return binding();
      },
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_MANIFEST",
  );
  assert.equal(required, false);
});

test("manifest policy and native claims are cross-checked before loading", () => {
  const bindingPath = "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node";
  let nativeClaimBindingRequired = false;
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
      requireBinding: () => {
        nativeClaimBindingRequired = true;
        return binding();
      },
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_PROVENANCE_VERIFIER_UNAVAILABLE",
  );
  assert.equal(nativeClaimBindingRequired, false);
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
  assert.equal(isWindowsFilesystemAdapter(adapter), true);
  assert.equal(adapter.productionSafe, false);
  assert.equal(adapter.pathWalkRaceSafe, false);
});

test("production promotion remains blocked until a package verifier exists", () => {
  const bindingPath = "C:\\checkout\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node";
  const authenticatedManifest = manifest({
    nativeClaims: {
      productionSafe: true,
      pathWalkRaceSafe: true,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
    },
    approvedPolicy: {
      productionSafe: true,
      pathWalkRaceSafe: true,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
    },
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "authenticated",
      source: "development-package",
    },
  });
  const manifestText = JSON.stringify(authenticatedManifest);
  let bindingRequired = 0;
  const common = {
    platform: "win32",
    architecture: "x64",
    bindingPath,
    resolveBinding: (path) => path,
    readManifest: () => manifestText,
    readBindingBytes: () => BINDING_BYTES,
    requireBinding: () => {
      bindingRequired += 1;
      return binding({
        productionSafe: true,
        pathWalkRaceSafe: true,
      });
    },
  };

  assert.throws(
    () => loadWindowsFilesystemBinding(common),
    (error) => error.code === "WINDOWS_FILESYSTEM_PROVENANCE_VERIFIER_UNAVAILABLE",
  );
  assert.equal(bindingRequired, 0);
  assert.throws(
    () => createWindowsFilesystemAdapter(common),
    (error) => error.code === "WINDOWS_FILESYSTEM_PROVENANCE_VERIFIER_UNAVAILABLE",
  );
  assert.equal(bindingRequired, 0);
  let callbackCalled = false;
  assert.throws(
    () => createWindowsFilesystemAdapter({
      ...common,
      authenticateManifest: () => {
        callbackCalled = true;
        return true;
      },
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_PROVENANCE_VERIFIER_UNAVAILABLE",
  );
  assert.equal(callbackCalled, false);
  assert.throws(
    () => createWindowsFilesystemAdapter({
      ...common,
      authenticateManifest: () => ({
        contractVersion: "windows-binding-provenance-v1",
        status: "authenticated",
        source: "development-package",
      }),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_PROVENANCE_VERIFIER_UNAVAILABLE",
  );
});

test("injected caller booleans cannot promote a portable binding", () => {
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding({
      productionSafe: true,
      pathWalkRaceSafe: true,
      bindingProvenanceAuthenticated: true,
    }),
  });
  assert.equal(isWindowsFilesystemAdapter(adapter), true);
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

test("production integration guard requires a branded safe adapter", () => {
  assert.throws(
    () => assertWindowsFilesystemProductionSafe({ productionSafe: false, pathWalkRaceSafe: false }),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE",
  );

  const fullShape = {
    productionSafe: true,
    pathWalkRaceSafe: true,
    inspectPath() {},
    ensureDirectory() {},
    readFile() {},
    createFile() {},
    deleteFile() {},
    replaceFile() {},
  };
  assert.equal(isWindowsFilesystemAdapter(fullShape), false);
  assert.throws(
    () => assertWindowsFilesystemProductionSafe(fullShape),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE",
  );

  const current = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding: binding(),
  });
  assert.equal(isWindowsFilesystemAdapter(current), true);
  assert.equal(current.productionSafe, false);
  assert.equal(current.pathWalkRaceSafe, false);
  assert.throws(
    () => assertWindowsFilesystemProductionSafe(current),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE",
  );

  const copied = {
    ...current,
    productionSafe: true,
    pathWalkRaceSafe: true,
  };
  assert.equal(isWindowsFilesystemAdapter(copied), false);
  assert.throws(
    () => assertWindowsFilesystemProductionSafe(copied),
    (error) => error.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE",
  );
});
