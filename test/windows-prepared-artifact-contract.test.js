import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
  isWindowsFilesystemAdapter,
  WINDOWS_FILESYSTEM_PREPARED_ARTIFACT_CONTRACT_VERSION,
} from "../src/platform/windows-filesystem.js";

const ROOT = "C:\\state";
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});
const CHILD_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "ffeeddccbbaa99887766554433221100",
  linkCount: 1,
});

function nativeBinding(overrides = {}) {
  const calls = [];
  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: WINDOWS_FILESYSTEM_PREPARED_ARTIFACT_CONTRACT_VERSION,
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    preparedArtifactSafe: false,
    inspectPath: () => ({ identity: ROOT_IDENTITY }),
    ensureDirectory: () => ROOT_IDENTITY,
    readFile: () => ({ data: Buffer.from("data"), identity: CHILD_IDENTITY }),
    readFileBounded: () => ({ data: Buffer.from("data"), identity: CHILD_IDENTITY }),
    createFile: () => CHILD_IDENTITY,
    deleteFile: () => ({ deleted: true, identity: CHILD_IDENTITY }),
    replaceFile: () => CHILD_IDENTITY,
    inspectProtectedChild: () => ({ identity: CHILD_IDENTITY }),
    readProtectedChild: () => ({ data: Buffer.from("data"), identity: CHILD_IDENTITY }),
    createProtectedChild: () => CHILD_IDENTITY,
    deleteProtectedChild: () => ({ deleted: true, identity: CHILD_IDENTITY }),
    replaceProtectedChild: () => CHILD_IDENTITY,
    acquireSqliteStateLease: () => ({
      lease: {},
      databaseIdentity: CHILD_IDENTITY,
      journalIdentity: CHILD_IDENTITY,
    }),
    releaseSqliteStateLease: () => undefined,
    acquireCredentialAuditFileGuard: () => ({ lease: {} }),
    releaseCredentialAuditFileGuard: () => undefined,
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => undefined,
    acquireCompanionInstanceMutex: () => ({ lease: {}, abandoned: false }),
    releaseCompanionInstanceMutex: () => undefined,
    inspectPreparedChild: (...args) => {
      calls.push(["inspect", args]);
      return {
        identity: CHILD_IDENTITY,
        isDirectory: true,
        isRegularFile: false,
        isReparsePoint: false,
      };
    },
    ensurePreparedDirectory: (...args) => {
      calls.push(["ensure", args]);
      return CHILD_IDENTITY;
    },
    enumeratePreparedDirectory: (...args) => {
      calls.push(["enumerate", args]);
      return [{
        name: "stage",
        identity: CHILD_IDENTITY,
        isDirectory: true,
        isRegularFile: false,
        isReparsePoint: false,
      }];
    },
    removePreparedDirectory: (...args) => {
      calls.push(["remove", args]);
      return { removed: true, identity: CHILD_IDENTITY };
    },
    renamePreparedDirectory: (...args) => {
      calls.push(["rename", args]);
      return { renamed: true, identity: CHILD_IDENTITY };
    },
    createPreparedFile: (...args) => {
      calls.push(["create", args]);
      return CHILD_IDENTITY;
    },
    readPreparedFile: (...args) => {
      calls.push(["read", args]);
      return { data: Buffer.from("prepared"), identity: CHILD_IDENTITY };
    },
    deletePreparedFile: (...args) => {
      calls.push(["delete", args]);
      return { deleted: true, identity: CHILD_IDENTITY };
    },
    publishPreparedFile: (...args) => {
      calls.push(["publish", args]);
      return { published: true, identity: CHILD_IDENTITY };
    },
    ...overrides,
  };
  return { binding, calls };
}

function adapterFor(binding) {
  return createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
}

test("prepared adapter surface is branded, bounded, and root-identity-bound", () => {
  const { binding, calls } = nativeBinding();
  const adapter = adapterFor(binding);
  assert.equal(isWindowsFilesystemAdapter(adapter), true);
  assert.equal(adapter.preparedArtifactContractVersion,
    WINDOWS_FILESYSTEM_PREPARED_ARTIFACT_CONTRACT_VERSION);
  assert.equal(adapter.preparedArtifactSafe, false);

  const result = adapter.ensurePreparedDirectory(ROOT, ROOT_IDENTITY, "prepared\\stage");
  assert.deepEqual(result, CHILD_IDENTITY);
  assert.equal(calls[0][0], "ensure");
  assert.deepEqual(calls[0][1].slice(0, 3), [ROOT, ROOT_IDENTITY, "prepared\\stage"]);
  assert.deepEqual(
    adapter.inspectPreparedChild(ROOT, ROOT_IDENTITY, "prepared\\stage"),
    {
      identity: CHILD_IDENTITY,
      isDirectory: true,
      isRegularFile: false,
      isReparsePoint: false,
    },
  );
  assert.deepEqual(
    adapter.enumeratePreparedDirectory(ROOT, ROOT_IDENTITY, "prepared", 8),
    [{
      name: "stage",
      identity: CHILD_IDENTITY,
      isDirectory: true,
      isRegularFile: false,
      isReparsePoint: false,
    }],
  );
  assert.deepEqual(
    adapter.deletePreparedFile(ROOT, ROOT_IDENTITY, "prepared\\stage.bin", CHILD_IDENTITY),
    { deleted: true, identity: CHILD_IDENTITY },
  );
  assert.throws(
    () => adapter.ensurePreparedDirectory(ROOT, { ...ROOT_IDENTITY, linkCount: 2 }, "prepared"),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_IDENTITY",
  );
  assert.throws(
    () => adapter.enumeratePreparedDirectory(ROOT, ROOT_IDENTITY, "prepared", 257),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_PREPARED_DIRECTORY_LIMIT",
  );
});

test("prepared adapter validates entry shape and mutation markers", () => {
  const malformedEntries = nativeBinding({
    enumeratePreparedDirectory: () => [{
      name: "link",
      identity: CHILD_IDENTITY,
      isDirectory: false,
      isRegularFile: true,
      isReparsePoint: true,
    }],
  });
  const adapter = adapterFor(malformedEntries.binding);
  assert.throws(
    () => adapter.enumeratePreparedDirectory(ROOT, ROOT_IDENTITY, "prepared", 8),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_RESULT",
  );

  const malformedMutation = nativeBinding({
    publishPreparedFile: () => ({ published: false, identity: CHILD_IDENTITY }),
  });
  const mutationAdapter = adapterFor(malformedMutation.binding);
  assert.throws(
    () => mutationAdapter.publishPreparedFile(
      ROOT,
      ROOT_IDENTITY,
      "prepared\\stage.bin",
      CHILD_IDENTITY,
      "prepared\\published.bin",
    ),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_RESULT",
  );
});

test("prepared adapter copies bounded file payloads and rejects oversized values", () => {
  const { binding, calls } = nativeBinding();
  const adapter = adapterFor(binding);
  const source = new Uint8Array([1, 2, 3]);
  assert.deepEqual(
    adapter.createPreparedFile(ROOT, ROOT_IDENTITY, "prepared\\stage.bin", source),
    CHILD_IDENTITY,
  );
  assert.equal(Buffer.isBuffer(calls[0][1][3]), true);
  assert.notEqual(calls[0][1][3], source);
  assert.deepEqual(
    adapter.readPreparedFile(ROOT, ROOT_IDENTITY, "prepared\\stage.bin", 8).data,
    Buffer.from("prepared"),
  );

  const oversized = new Uint8Array((34 * 1024 * 1024) + 1);
  assert.throws(
    () => adapter.createPreparedFile(ROOT, ROOT_IDENTITY, "prepared\\stage.bin", oversized),
    (error) => error.code === "WINDOWS_FILESYSTEM_PREPARED_FILE_TOO_LARGE",
  );
  assert.throws(
    () => adapter.readPreparedFile(ROOT, ROOT_IDENTITY, "prepared\\stage.bin", 0),
    (error) => error.code === "WINDOWS_FILESYSTEM_INVALID_PREPARED_MAXIMUM_BYTES",
  );
});
