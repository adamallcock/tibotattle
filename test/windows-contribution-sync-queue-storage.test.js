import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsPreparedArtifactStorageContext,
} from "../src/platform/windows-prepared-artifact-storage.js";
import {
  createWindowsContributionSyncQueuePreparedStoragePorts,
} from "../src/platform/windows-contribution-sync-queue-storage.js";
import {
  createLocalContributionSyncQueueStorageContext,
} from "../src/platform/local-contribution-sync-queue-storage.js";
import {
  createLocalContributionSyncQueueContext,
} from "../src/application/local-contribution-sync-queue.js";
import { syncPreparedContributionEntryOnce } from
  "../src/contribution-device-sync.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\prepared";
const PARENT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle";
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function identity(number) {
  return Object.freeze({
    volumeSerialNumber: IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function nativeError(code) {
  const error = new Error("native detail must stay behind the queue boundary");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function metadata(value, { directory = false } = {}) {
  return {
    identity: value,
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
  };
}

function createFixture({ rootIdentity = IDENTITY } = {}) {
  const entries = new Map([
    [PARENT, { identity: identity(1), directory: true }],
    [ROOT, { identity: rootIdentity, directory: true }],
  ]);
  const calls = [];
  let nextIdentity = 2;

  function full(root, relative) {
    return relative.length === 0 ? root : `${root}\\${relative}`;
  }

  function requireRoot(root, expected) {
    const entry = entries.get(root);
    if (!entry || !entry.directory || entry.identity.fileId !== expected.fileId) {
      throw nativeError("IDENTITY_MISMATCH");
    }
  }

  function entryAt(root, relative) {
    const entry = entries.get(full(root, relative));
    if (!entry) throw nativeError("NOT_FOUND");
    return entry;
  }

  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion:
      "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion:
      "windows-companion-instance-mutex-v1",
    preparedArtifactContractVersion: "windows-prepared-artifact-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    companionInstanceMutexSafe: false,
    preparedArtifactSafe: false,
    inspectPath(path) {
      calls.push(["inspectPath", path]);
      const entry = entries.get(path);
      if (!entry) throw nativeError("NOT_FOUND");
      return metadata(entry.identity, { directory: entry.directory });
    },
    ensureDirectory(path) {
      calls.push(["ensureDirectory", path]);
      const entry = entries.get(path);
      if (entry && !entry.directory) throw nativeError("NOT_DIRECTORY");
      if (entry) return entry.identity;
      const created = identity(nextIdentity++);
      entries.set(path, { identity: created, directory: true });
      return created;
    },
    readFile() {
      throw nativeError("OPERATION_FAILED");
    },
    readFileBounded() {
      throw nativeError("OPERATION_FAILED");
    },
    createFile() {
      throw nativeError("OPERATION_FAILED");
    },
    deleteFile() {
      throw nativeError("OPERATION_FAILED");
    },
    replaceFile() {
      throw nativeError("OPERATION_FAILED");
    },
    inspectProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    readProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    createProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    deleteProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    replaceProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    acquireSqliteStateLease() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseSqliteStateLease() {},
    acquireCredentialAuditFileGuard() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() {
      throw nativeError("OPERATION_FAILED");
    },
    releaseCompanionInstanceMutex() {},
    inspectPreparedChild(root, expected, relative) {
      calls.push(["inspectPreparedChild", root, relative]);
      requireRoot(root, expected);
      const entry = entryAt(root, relative);
      return metadata(entry.identity, { directory: entry.directory });
    },
    ensurePreparedDirectory(root, expected, relative) {
      calls.push(["ensurePreparedDirectory", root, relative]);
      requireRoot(root, expected);
      const path = full(root, relative);
      const entry = entries.get(path);
      if (entry && !entry.directory) throw nativeError("NOT_DIRECTORY");
      if (entry) return entry.identity;
      const created = identity(nextIdentity++);
      entries.set(path, { identity: created, directory: true });
      return created;
    },
    enumeratePreparedDirectory(root, expected, relative, maximumEntries) {
      calls.push(["enumeratePreparedDirectory", root, relative, maximumEntries]);
      requireRoot(root, expected);
      const prefix = `${full(root, relative)}\\`;
      const result = [];
      for (const [path, entry] of entries) {
        if (!path.startsWith(prefix)) continue;
        const child = path.slice(prefix.length);
        if (child.includes("\\")) continue;
        result.push({
          name: child,
          identity: entry.identity,
          isDirectory: entry.directory,
          isRegularFile: !entry.directory,
          isReparsePoint: false,
        });
      }
      if (result.length > maximumEntries) {
        throw nativeError("PREPARED_DIRECTORY_LIMIT");
      }
      return result;
    },
    removePreparedDirectory(root, expected, relative, expectedDirectory) {
      calls.push(["removePreparedDirectory", root, relative]);
      requireRoot(root, expected);
      const path = full(root, relative);
      const entry = entryAt(root, relative);
      if (!entry.directory || entry.identity.fileId !== expectedDirectory.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if ([...entries.keys()].some((candidate) =>
        candidate.startsWith(`${path}\\`))) {
        throw nativeError("PREPARED_DIRECTORY_NOT_EMPTY");
      }
      entries.delete(path);
      return { removed: true, identity: entry.identity };
    },
    renamePreparedDirectory() {
      throw nativeError("OPERATION_FAILED");
    },
    createPreparedFile(root, expected, relative, data) {
      calls.push(["createPreparedFile", root, relative]);
      requireRoot(root, expected);
      const path = full(root, relative);
      if (entries.has(path)) throw nativeError("ALREADY_EXISTS");
      const created = identity(nextIdentity++);
      entries.set(path, {
        identity: created,
        directory: false,
        data: Buffer.from(data),
      });
      return created;
    },
    readPreparedFile(root, expected, relative, maximumBytes) {
      calls.push(["readPreparedFile", root, relative]);
      requireRoot(root, expected);
      const entry = entryAt(root, relative);
      if (entry.directory || entry.data.length > maximumBytes) {
        throw nativeError("FILE_TOO_LARGE");
      }
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    deletePreparedFile(root, expected, relative, expectedFile) {
      calls.push(["deletePreparedFile", root, relative]);
      requireRoot(root, expected);
      const path = full(root, relative);
      const entry = entryAt(root, relative);
      if (entry.directory || entry.identity.fileId !== expectedFile.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      entries.delete(path);
      return { deleted: true, identity: entry.identity };
    },
    publishPreparedFile() {
      throw nativeError("OPERATION_FAILED");
    },
  };

  return {
    entries,
    calls,
    adapter: createWindowsFilesystemAdapter({
      platform: "win32",
      architecture: "x64",
      binding,
    }),
  };
}

function createStateStorage(fixture) {
  return createWindowsPreparedArtifactStorageContext({
    adapter: fixture.adapter,
    rootPath: PARENT,
  });
}

function queueError(code) {
  const error = new Error("queue storage failed");
  error.code = `contribution_sync_queue_${code}`;
  return error;
}

test("Windows queue storage rejects missing and forged branded storage before access", async () => {
  const calls = [];
  assert.throws(
    () => createWindowsContributionSyncQueuePreparedStoragePorts({
      createError: queueError,
      storage: {
        get rootPath() {
          calls.push(["forged", "rootPath"]);
          return ROOT;
        },
      },
    }),
    (error) => error.code === "contribution_sync_queue_prepared_root_invalid",
  );
  assert.deepEqual(calls, []);

  const storage = createLocalContributionSyncQueueStorageContext({
    createError: queueError,
    queueSchemaVersion: "contribution-sync-queue-v0.1",
    queueStatusSchemaVersion: "contribution-sync-status-v0.1",
    maximumQueueBytes: 128 * 1024 * 1024,
    maximumQueueJobs: 25_600,
    jobStates: ["pending", "in_flight", "accepted", "retryable", "rejected"],
    platform: "win32",
  });
  await assert.rejects(
    storage.canonicalPreparedRoot(ROOT),
    (error) => error.code === "contribution_sync_queue_prepared_root_invalid",
  );
});

test("Windows queue storage uses branded roots for manifest reads and bounded discovery", async () => {
  const fixture = createFixture();
  const ports = createWindowsContributionSyncQueuePreparedStoragePorts({
    createError: queueError,
    storage: createStateStorage(fixture),
  });
  fixture.entries.set(`${ROOT}\\prepared-set-11111111-1111-4111-8111-111111111111`, {
    identity: identity(4),
    directory: true,
  });
  fixture.entries.set(`${ROOT}\\loose.bin`, {
    identity: identity(5),
    directory: false,
    data: Buffer.from("loose"),
  });
  fixture.entries.set(`${ROOT}\\manifest.json`, {
    identity: identity(6),
    directory: false,
    data: Buffer.from("{\"ok\":true}\n"),
  });
  assert.equal(await ports.canonicalPreparedRoot(ROOT), ROOT);
  assert.equal(await ports.manifestExists(ROOT, "manifest.json"), true);
  assert.deepEqual(
    [...await ports.readManifest(ROOT, "manifest.json", 1024)],
    [...Buffer.from("{\"ok\":true}\n")],
  );
  const discovered = await ports.preparedSetDirectories({
    root: ROOT,
    maximumEntries: 4,
    matches: (name) => name.startsWith("prepared-set-"),
  });
  assert.equal(discovered.length, 1);
  assert.equal(
    discovered[0].directory,
    `${ROOT}\\prepared-set-11111111-1111-4111-8111-111111111111`,
  );
  assert.ok(fixture.calls.some(([method]) => method === "enumeratePreparedDirectory"));
});

test("Windows queue storage rejects a prepared-root identity swap", async () => {
  const fixture = createFixture();
  const ports = createWindowsContributionSyncQueuePreparedStoragePorts({
    createError: queueError,
    storage: createStateStorage(fixture),
  });
  assert.equal(await ports.canonicalPreparedRoot(ROOT), ROOT);
  fixture.entries.set(ROOT, { identity: identity(99), directory: true });
  await assert.rejects(
    ports.manifestExists(ROOT, "manifest.json"),
    (error) => error.code === "contribution_sync_queue_prepared_root_invalid",
  );
  await assert.rejects(
    ports.canonicalPreparedRoot(
      "C:\\Users\\tester\\AppData\\Local\\outside\\prepared",
    ),
    (error) => error.code === "contribution_sync_queue_prepared_root_invalid",
  );
});

test("Windows queue storage retires only bounded regular files and is restart-safe", async () => {
  const fixture = createFixture();
  const setName = "prepared-set-11111111-1111-4111-8111-111111111111";
  const setPath = `${ROOT}\\${setName}`;
  fixture.entries.set(setPath, { identity: identity(7), directory: true });
  fixture.entries.set(`${setPath}\\one.json`, {
    identity: identity(8),
    directory: false,
    data: Buffer.from("one"),
  });
  const ports = createWindowsContributionSyncQueuePreparedStoragePorts({
    createError: queueError,
    storage: createStateStorage(fixture),
  });
  assert.equal(await ports.retireFlatDirectory({
    root: ROOT,
    name: setName,
    maximumEntries: 4,
  }), true);
  assert.equal(fixture.entries.has(setPath), false);
  assert.equal(await ports.retireFlatDirectory({
    root: ROOT,
    name: setName,
    maximumEntries: 4,
  }), false);

  fixture.entries.set(setPath, { identity: identity(9), directory: true });
  fixture.entries.set(`${setPath}\\nested`, {
    identity: identity(10),
    directory: true,
  });
  await assert.rejects(
    ports.retireFlatDirectory({
      root: ROOT,
      name: setName,
      maximumEntries: 4,
    }),
    (error) => error.code === "contribution_sync_queue_retirement_invalid",
  );

  // A file at the requested directory target is a collision, not an artifact
  // to overwrite or unlink through a POSIX fallback.
  const collision = `${ROOT}\\${setName}`;
  fixture.entries.delete(`${collision}\\nested`);
  fixture.entries.set(collision, {
    identity: identity(11),
    directory: false,
    data: Buffer.from("collision"),
  });
  await assert.rejects(
    ports.retireFlatDirectory({
      root: ROOT,
      name: setName,
      maximumEntries: 4,
    }),
    (error) => error.code === "contribution_sync_queue_retirement_invalid",
  );
});

test("Windows entry sync requires an explicit prepared loader", async () => {
  await assert.rejects(
    syncPreparedContributionEntryOnce({
      platform: "win32",
      directory: ROOT,
      entry: { basename: "contribution.json" },
      origin: "https://usage.example",
      backend: {},
    }),
    (error) => error.code === "contribution_device_sync_invalid_configuration",
  );

  let calls = 0;
  await assert.rejects(
    syncPreparedContributionEntryOnce({
      platform: "win32",
      directory: ROOT,
      entry: { basename: "contribution.json" },
      origin: "https://usage.example",
      backend: {},
      loadContribution: async () => {
        calls += 1;
        throw new Error("injected Windows loader reached");
      },
      fetchImpl: async () => {
        throw new Error("network must not run before local load");
      },
    }),
    /injected Windows loader reached/u,
  );
  assert.equal(calls, 1);
});

test("Windows queue application does not invoke the POSIX loader without an explicit context", async () => {
  let verifyCalls = 0;
  let loadCalls = 0;
  const context = createLocalContributionSyncQueueContext({
    platform: "win32",
    createStorage: createLocalContributionSyncQueueStorageContext,
    resolvePath: (...parts) => parts.join("\\"),
    verifyPreparedSet: async () => {
      verifyCalls += 1;
      throw new Error("POSIX verifier must not run");
    },
    loadPreparedContribution: async () => {
      loadCalls += 1;
      throw new Error("POSIX loader must not run");
    },
    syncPreparedEntry: async () => {
      throw new Error("POSIX sync must not run");
    },
  });
  await assert.rejects(
    context.discoverCommittedPreparedSets({ directory: ROOT }),
    (error) => error.code === "contribution_sync_queue_prepared_root_invalid",
  );
  assert.equal(verifyCalls, 0);
  assert.equal(loadCalls, 0);
});

test("Windows queue storage module has no POSIX filesystem fallback", async () => {
  const source = await readFile(
    new URL("../src/platform/windows-contribution-sync-queue-storage.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:fs(?:\/promises)?/u);
  assert.doesNotMatch(source, /\b(?:unlink|rename|link|lstat|readdir|mkdir)\b/u);
});
