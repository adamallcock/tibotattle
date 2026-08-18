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
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    requiredMethods: [...WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS],
    nativeClaims: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
    },
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
    },
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    inspectPath: () => ({ identity: IDENTITY }),
    ensureDirectory: () => IDENTITY,
    readFile: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    createFile: () => IDENTITY,
    deleteFile: () => ({ deleted: true, identity: IDENTITY }),
    replaceFile: () => IDENTITY,
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => {},
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
