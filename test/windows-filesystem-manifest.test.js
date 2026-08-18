import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWindowsFilesystemBindingManifest,
  createWindowsFilesystemBindingManifest,
} from "../scripts/build-windows-filesystem-manifest.mjs";

const BYTES = Buffer.from("reviewed native bytes", "utf8");
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

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
    readFileBounded: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    createFile: () => IDENTITY,
    deleteFile: () => ({ deleted: true, identity: IDENTITY }),
    replaceFile: () => IDENTITY,
    inspectProtectedChild: () => ({ identity: IDENTITY }),
    readProtectedChild: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    createProtectedChild: () => IDENTITY,
    deleteProtectedChild: () => ({ deleted: true, identity: IDENTITY }),
    replaceProtectedChild: () => IDENTITY,
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => {},
    acquireCredentialAuditFileGuard: () => ({ lease: {} }),
    releaseCredentialAuditFileGuard: () => {},
    ...overrides,
  };
}

test("binding manifest is deterministic, content-free, and policy-disabled", () => {
  const manifest = createWindowsFilesystemBindingManifest({
    bytes: BYTES,
    binding: binding(),
  });
  assert.deepEqual(manifest, {
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: BYTES.byteLength,
    sha256: createHash("sha256").update(BYTES).digest("hex"),
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    requiredMethods: [
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
    ],
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
  });
  assert.equal(Object.keys(manifest).some((key) => /path|account|secret|content/iu.test(key)), false);
});

test("manifest builder refuses an unreviewed native production claim", () => {
  assert.throws(
    () => createWindowsFilesystemBindingManifest({
      bytes: BYTES,
      binding: binding({ productionSafe: true }),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_MANIFEST_NATIVE_CLAIM_UNREVIEWED",
  );
});

test("manifest builder writes only the exact native digest and safe aggregate fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-manifest-"));
  try {
    const manifestPath = join(root, "binding.manifest.json");
    const result = await buildWindowsFilesystemBindingManifest({
      bindingPath: join(root, "windows_filesystem.node"),
      manifestPath,
      readBinding: async () => BYTES,
      loadBinding: () => binding(),
    });
    assert.equal(result.sha256, createHash("sha256").update(BYTES).digest("hex"));
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
