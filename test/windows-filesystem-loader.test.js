import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDesktopFirstRunReceiptBackend,
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
} from "../apps/electron/desktop-first-run.js";
import {
  createWindowsFilesystemBindingManifest,
} from "../scripts/build-windows-filesystem-manifest.mjs";
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
import {
  assertWindowsQualificationResourceAuthority,
  createWindowsQualificationModeContext,
  WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
} from "../src/platform/windows-qualification-mode.js";

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
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
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

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function identityFor(sequence) {
  return Object.freeze({
    volumeSerialNumber: IDENTITY.volumeSerialNumber,
    fileId: sequence.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function protectedMetadata(identity, directory) {
  return Object.freeze({
    identity,
    isDirectory: directory,
    isRegularFile: !directory,
    isReparsePoint: false,
    ownerMatches: true,
    nullDacl: false,
    daclProtected: true,
    broadAccess: false,
    nonOwnerAllow: false,
    unrecognizedAce: false,
    finalPathResolved: true,
  });
}

function nativeFailure(code) {
  const error = new Error("synthetic Windows native operation failed");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

/**
 * This fixture is deliberately shaped like the native binding producer: it
 * contains only the four published claim fields. The manifest is generated
 * by the production-side builder below, so a qualification consumer cannot
 * quietly depend on legacy fixture-only claims.
 */
function qualificationBinding() {
  const children = new Map();
  let nextSequence = 2;
  const assertRoot = (identity) => {
    if (!sameIdentity(identity, IDENTITY)) throw nativeFailure("IDENTITY_MISMATCH");
  };
  const record = (name) => {
    const value = children.get(name);
    if (!value) throw nativeFailure("NOT_FOUND");
    return value;
  };
  const nextIdentity = () => identityFor(nextSequence++);

  return binding({
    inspectPath() {
      return protectedMetadata(IDENTITY, true);
    },
    ensureDirectory() {
      return IDENTITY;
    },
    inspectProtectedChild(_root, rootIdentity, name) {
      assertRoot(rootIdentity);
      return protectedMetadata(record(name).identity, false);
    },
    readProtectedChild(_root, rootIdentity, name, maximumBytes) {
      assertRoot(rootIdentity);
      const value = record(name);
      if (!Number.isSafeInteger(maximumBytes) || value.data.byteLength > maximumBytes) {
        throw nativeFailure("FILE_TOO_LARGE");
      }
      return Object.freeze({ data: Buffer.from(value.data), identity: value.identity });
    },
    createProtectedChild(_root, rootIdentity, name, data) {
      assertRoot(rootIdentity);
      if (children.has(name)) throw nativeFailure("ALREADY_EXISTS");
      const identity = nextIdentity();
      children.set(name, Object.freeze({ data: Buffer.from(data), identity }));
      return identity;
    },
    deleteProtectedChild(_root, rootIdentity, name, expectedIdentity) {
      assertRoot(rootIdentity);
      const value = record(name);
      if (!sameIdentity(value.identity, expectedIdentity)) {
        throw nativeFailure("IDENTITY_MISMATCH");
      }
      children.delete(name);
      return Object.freeze({ deleted: true, identity: value.identity });
    },
    replaceProtectedChild(_root, rootIdentity, name, expectedIdentity, data) {
      assertRoot(rootIdentity);
      const value = record(name);
      if (!sameIdentity(value.identity, expectedIdentity)) {
        throw nativeFailure("IDENTITY_MISMATCH");
      }
      const identity = nextIdentity();
      children.set(name, Object.freeze({ data: Buffer.from(data), identity }));
      return identity;
    },
  });
}

const QUALIFICATION_RESOURCE_BINDING =
  "native/windows-filesystem/build/Release/windows_filesystem.node";
const QUALIFICATION_RESOURCE_BINDING_MANIFEST =
  `${QUALIFICATION_RESOURCE_BINDING}.manifest.json`;
const QUALIFICATION_RESOURCE_KEYTAR =
  "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node";

function qualificationResourceKind(path) {
  if (path === QUALIFICATION_RESOURCE_BINDING
      || path === QUALIFICATION_RESOURCE_BINDING_MANIFEST) {
    return "windows_native_binding";
  }
  if (path === QUALIFICATION_RESOURCE_KEYTAR) return "third_party_dependency";
  if (path === "apps/local/server.js") return "companion_source";
  if (path === "apps/web/public/index.html") return "dashboard_asset";
  return "electron_shell";
}

function qualificationResourceManifest(omitPath = null) {
  const bytes = new Map([
    [QUALIFICATION_RESOURCE_BINDING, BINDING_BYTES],
    [QUALIFICATION_RESOURCE_BINDING_MANIFEST, Buffer.from("manifest", "utf8")],
    [QUALIFICATION_RESOURCE_KEYTAR, Buffer.from("keytar", "utf8")],
  ]);
  const paths = new Set([
    ...WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
    QUALIFICATION_RESOURCE_BINDING,
    QUALIFICATION_RESOURCE_BINDING_MANIFEST,
    QUALIFICATION_RESOURCE_KEYTAR,
  ]);
  const files = [...paths].filter((path) => path !== omitPath).map((path) => {
    const value = bytes.get(path) ?? Buffer.from(path, "utf8");
    return Object.freeze({
      bytes: value.byteLength,
      kind: qualificationResourceKind(path),
      path,
      sha256: sha256(value),
    });
  }).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const payload = createHash("sha256");
  let totalBytes = 0;
  for (const row of files) {
    totalBytes += row.bytes;
    payload.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  const binding = files.find((row) => row.path === QUALIFICATION_RESOURCE_BINDING);
  return Object.freeze({
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    architecture: "x64",
    releaseVersion: "0.1.0-test",
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files,
    payload: Object.freeze({ bytes: totalBytes, sha256: payload.digest("hex") }),
    windowsBinding: Object.freeze({
      binding: Object.freeze({
        bytes: binding.bytes,
        path: QUALIFICATION_RESOURCE_BINDING,
        sha256: binding.sha256,
      }),
      included: true,
      manifest: Object.freeze({ path: QUALIFICATION_RESOURCE_BINDING_MANIFEST }),
      status: "included_unverified",
      verified: false,
    }),
  });
}

async function withQualificationResourceRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-qualification-producer-"));
  try {
    await writeFile(
      join(root, "electron-runtime-manifest.json"),
      `${JSON.stringify(qualificationResourceManifest())}\n`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("qualification authority refuses a self-consistent manifest missing any observation credential boundary module", async () => {
  await withQualificationResourceRoot(async (resourceRoot) => {
    assertWindowsQualificationResourceAuthority({ resourceRoot });
    for (const omitted of [
      "apps/electron/desktop-windows-account-observation-broker.js",
      "apps/electron/desktop-windows-account-observation-qualification.js",
      "apps/electron/windows-account-observation-qualification-smoke-child.mjs",
      "apps/electron/windows-account-observation-qualification-smoke.js",
      "src/platform/windows-account-observation-credential.js",
      "src/platform/windows-account-observation-broker.js",
      "src/platform/windows-credential-manager.js",
      "src/platform/windows-credential-operation-lease.js",
      "src/platform/windows-credential-mutex.js",
      "src/platform/windows-credential-operation-audit.js",
      "src/platform/windows-credential-audit-file-guard.js",
    ]) {
      await writeFile(join(resourceRoot, "electron-runtime-manifest.json"), JSON.stringify(qualificationResourceManifest(omitted)));
      assert.throws(() => assertWindowsQualificationResourceAuthority({ resourceRoot }),
        { code: "windows_qualification_mode_resource_authority" }, omitted);
    }
  });
});

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
  assert.throws(
    () => loadWindowsFilesystemBinding({
      platform: "win32",
      architecture: "x64",
      bindingPath,
      resolveBinding: (path) => path,
      readManifest: () => JSON.stringify(manifest({
        bindingProvenance: {
          contractVersion: "windows-binding-provenance-v1",
          status: "qualified",
          source: "unsigned-development-binding",
        },
      })),
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
  assert.equal(adapter.credentialMutexSafe, true);
  assert.equal(adapter.credentialAuditFileGuardSafe, true);
});

test("verified producer claims compose the qualification context and protected first-run receipt", async () => {
  const native = qualificationBinding();
  const sidecar = createWindowsFilesystemBindingManifest({
    bytes: BINDING_BYTES,
    binding: native,
  });
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    bindingPath: "C:\\qualification\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node",
    resolveBinding: (path) => path,
    readManifest: () => JSON.stringify(sidecar),
    readBindingBytes: () => BINDING_BYTES,
    requireBinding: () => native,
  });
  assert.equal(adapter.productionSafe, false);
  assert.equal(adapter.pathWalkRaceSafe, false);
  assert.equal(adapter.credentialMutexSafe, true);
  assert.equal(adapter.credentialAuditFileGuardSafe, true);
  assert.equal(Object.hasOwn(adapter, "sqliteStateLeaseSafe"), false);
  assert.equal(Object.hasOwn(adapter, "preparedArtifactSafe"), false);
  assert.equal(Object.hasOwn(adapter, "companionInstanceMutexSafe"), false);

  await withQualificationResourceRoot(async (resourceRoot) => {
    const context = createWindowsQualificationModeContext({
      platform: "win32",
      architecture: "x64",
      adapter,
      resourceRoot,
      environment: {
        USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
        USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
        TEMP: "C:\\qualification",
        USERPROFILE: "C:\\qualification\\home",
        HOME: "C:\\qualification\\home",
        CODEX_HOME: "C:\\qualification\\codex",
        CLAUDE_CONFIG_DIR: "C:\\qualification\\claude",
        USAGE_MONITOR_STATE_ROOT: "C:\\qualification\\state",
      },
    });
    const store = createWindowsProtectedStateStore({
      adapter,
      rootPath: "C:\\qualification\\state\\desktop-settings",
      windowsQualificationModeContext: context,
      resourceRoot,
    });
    const receiptBackend = createDesktopFirstRunReceiptBackend({
      platform: "win32",
      windowsProtectedStateStore: store,
    });
    const receipt = Object.freeze({
      schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
      acknowledged: true,
    });
    assert.deepEqual(await receiptBackend.save(receipt), receipt);
    assert.deepEqual(await receiptBackend.load(), receipt);
  });
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
