import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_PRODUCTION_SAFE,
  WINDOWS_PREPARED_ARTIFACT_STORAGE_READINESS,
  createWindowsPreparedArtifactStorageContext,
  isWindowsPreparedArtifactStorage,
  isWindowsPreparedArtifactStorageError,
} from "../src/platform/windows-prepared-artifact-storage.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\prepared";
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
  const error = new Error("native detail must not cross the boundary");
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

function createFixture({
  bindingOverrides = {},
  entries: initialEntries = new Map(),
} = {}) {
  const entries = new Map(initialEntries);
  entries.set(ROOT, { identity: IDENTITY, directory: true });
  let nextIdentity = 2;
  const calls = [];

  function full(relativeName) {
    return `${ROOT}\\${relativeName}`;
  }

  function requireRoot(rootPath, rootIdentity) {
    if (rootPath !== ROOT
        || rootIdentity.fileId !== IDENTITY.fileId
        || rootIdentity.volumeSerialNumber !== IDENTITY.volumeSerialNumber
        || rootIdentity.linkCount !== IDENTITY.linkCount) {
      throw nativeError("IDENTITY_MISMATCH");
    }
  }

  function get(relativeName) {
    const entry = entries.get(full(relativeName));
    if (!entry) throw nativeError("NOT_FOUND");
    return entry;
  }

  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    sqliteStateLeaseContractVersion: "windows-sqlite-state-lease-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    companionInstanceMutexContractVersion: "windows-companion-instance-mutex-v1",
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
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return metadata(IDENTITY, { directory: true });
    },
    ensureDirectory(path) {
      calls.push(["ensureDirectory", path]);
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return IDENTITY;
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
    deleteProtectedChild(rootPath, rootIdentity, childPath, expected) {
      calls.push(["deleteProtectedChild", rootPath, rootIdentity, childPath, expected]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (entry.identity.fileId !== expected.fileId) throw nativeError("IDENTITY_MISMATCH");
      entries.delete(full(childPath));
      return { deleted: true, identity: entry.identity };
    },
    replaceProtectedChild() {
      throw nativeError("OPERATION_FAILED");
    },
    acquireCredentialMutex() {
      return { lease: {}, abandoned: false };
    },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() {
      return { lease: {}, abandoned: false };
    },
    releaseCompanionInstanceMutex() {},
    acquireCredentialAuditFileGuard() {
      return { lease: {} };
    },
    releaseCredentialAuditFileGuard() {},
    acquireSqliteStateLease() {
      return {
        lease: {},
        databaseIdentity: IDENTITY,
        journalIdentity: IDENTITY,
      };
    },
    releaseSqliteStateLease() {},
    inspectPreparedChild(rootPath, rootIdentity, childPath) {
      calls.push(["inspectPreparedChild", rootPath, rootIdentity, childPath]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      return metadata(entry.identity, { directory: entry.directory });
    },
    ensurePreparedDirectory(rootPath, rootIdentity, childPath) {
      calls.push(["ensurePreparedDirectory", rootPath, rootIdentity, childPath]);
      requireRoot(rootPath, rootIdentity);
      const path = full(childPath);
      const existing = entries.get(path);
      if (existing && !existing.directory) throw nativeError("NOT_DIRECTORY");
      if (existing) return existing.identity;
      const created = identity(nextIdentity++);
      entries.set(path, { identity: created, directory: true });
      return created;
    },
    enumeratePreparedDirectory(rootPath, rootIdentity, childPath, maximumEntries) {
      calls.push(["enumeratePreparedDirectory", rootPath, rootIdentity, childPath, maximumEntries]);
      requireRoot(rootPath, rootIdentity);
      const prefix = `${full(childPath)}\\`;
      const result = [];
      for (const [path, entry] of entries) {
        if (!path.startsWith(prefix)) continue;
        const remainder = path.slice(prefix.length);
        if (remainder.includes("\\")) continue;
        result.push({
          name: remainder,
          identity: entry.identity,
          isDirectory: entry.directory,
          isRegularFile: !entry.directory,
          isReparsePoint: false,
        });
      }
      if (result.length > maximumEntries) throw nativeError("PREPARED_DIRECTORY_LIMIT");
      return result;
    },
    removePreparedDirectory(rootPath, rootIdentity, childPath, expected) {
      calls.push(["removePreparedDirectory", rootPath, rootIdentity, childPath, expected]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (!entry.directory) throw nativeError("NOT_DIRECTORY");
      if (entry.identity.fileId !== expected.fileId) throw nativeError("IDENTITY_MISMATCH");
      const prefix = `${full(childPath)}\\`;
      if ([...entries.keys()].some((path) => path.startsWith(prefix))) {
        throw nativeError("PREPARED_DIRECTORY_NOT_EMPTY");
      }
      entries.delete(full(childPath));
      return { removed: true, identity: entry.identity };
    },
    renamePreparedDirectory(rootPath, rootIdentity, source, expected, target) {
      calls.push(["renamePreparedDirectory", rootPath, rootIdentity, source, expected, target]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(source);
      if (!entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if (entries.has(full(target))) throw nativeError("ALREADY_EXISTS");
      entries.set(full(target), entry);
      entries.delete(full(source));
      return { renamed: true, identity: entry.identity };
    },
    createPreparedFile(rootPath, rootIdentity, childPath, data) {
      calls.push(["createPreparedFile", rootPath, rootIdentity, childPath, Buffer.from(data)]);
      requireRoot(rootPath, rootIdentity);
      if (entries.has(full(childPath))) throw nativeError("ALREADY_EXISTS");
      const created = identity(nextIdentity++);
      entries.set(full(childPath), { identity: created, directory: false, data: Buffer.from(data) });
      return created;
    },
    readPreparedFile(rootPath, rootIdentity, childPath, maximumBytes) {
      calls.push(["readPreparedFile", rootPath, rootIdentity, childPath, maximumBytes]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (entry.directory) throw nativeError("NOT_REGULAR_FILE");
      if (entry.data.length > maximumBytes) throw nativeError("FILE_TOO_LARGE");
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    deletePreparedFile(rootPath, rootIdentity, childPath, expected) {
      calls.push(["deletePreparedFile", rootPath, rootIdentity, childPath, expected]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(childPath);
      if (entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      entries.delete(full(childPath));
      return { deleted: true, identity: entry.identity };
    },
    publishPreparedFile(rootPath, rootIdentity, source, expected, target) {
      calls.push(["publishPreparedFile", rootPath, rootIdentity, source, expected, target]);
      requireRoot(rootPath, rootIdentity);
      const entry = get(source);
      if (entry.directory || entry.identity.fileId !== expected.fileId) {
        throw nativeError("IDENTITY_MISMATCH");
      }
      if (entries.has(full(target))) throw nativeError("ALREADY_EXISTS");
      entries.set(full(target), entry);
      entries.delete(full(source));
      return { published: true, identity: entry.identity };
    },
    ...bindingOverrides,
  };
  return {
    adapter: createWindowsFilesystemAdapter({
      platform: "win32",
      architecture: "x64",
      binding,
    }),
    calls,
    entries,
  };
}

function createContext(options = {}) {
  const fixture = createFixture(options.fixture);
  return {
    fixture,
    context: createWindowsPreparedArtifactStorageContext({
      adapter: fixture.adapter,
      rootPath: ROOT,
      ...options,
    }),
  };
}

test("prepared artifact context requires the repository-branded adapter", () => {
  assert.throws(
    () => createWindowsPreparedArtifactStorageContext({
      adapter: {},
      rootPath: ROOT,
    }),
    (error) => error.code === "windows_prepared_artifact_storage_invalid_adapter",
  );
  const fixture = createFixture();
  assert.throws(
    () => createWindowsPreparedArtifactStorageContext({
      adapter: { ...fixture.adapter },
      rootPath: ROOT,
    }),
    (error) => error.code === "windows_prepared_artifact_storage_invalid_adapter",
  );
});

test("prepared artifact context rejects unsafe roots and relative names", () => {
  const fixture = createFixture();
  for (const rootPath of [
    "prepared",
    "C:\\",
    "\\\\server\\share\\prepared",
    "C:\\Users\\tester\\..\\prepared",
    "C:\\Users\\tester\\CON\\prepared",
    "C:\\Users\\tester\\prepared.",
  ]) {
    assert.throws(
      () => createWindowsPreparedArtifactStorageContext({
        adapter: fixture.adapter,
        rootPath,
      }),
      (error) => error.code === "windows_prepared_artifact_storage_invalid_root",
    );
  }

  const { context } = createContext();
  for (const name of [
    "../escape",
    "nested/../../escape",
    "C:\\escape",
    "\\\\server\\share\\escape",
    "CON.txt",
    "nested\\NUL",
    "trailing.",
    "trailing ",
    "nested//file",
  ]) {
    assert.throws(
      () => context.inspect(name),
      (error) => error.code === "windows_prepared_artifact_storage_invalid_path"
        || error.code === "windows_prepared_artifact_storage_path_escape",
    );
  }
});

test("prepared artifact context exposes a false readiness gate and bounds payloads", () => {
  const { context } = createContext();
  assert.equal(isWindowsPreparedArtifactStorage(context), true);
  assert.equal(context.productionSafe, WINDOWS_PREPARED_ARTIFACT_STORAGE_PRODUCTION_SAFE);
  assert.equal(context.readiness, WINDOWS_PREPARED_ARTIFACT_STORAGE_READINESS);
  assert.equal(context.preparedArtifactSafe, false);
  assert.equal(
    context.maximumFileBytes,
    WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES,
  );

  assert.throws(
    () => context.createFile("too-large.bin", Buffer.alloc(
      WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES + 1,
    )),
    (error) => error.code === "windows_prepared_artifact_storage_too_large",
  );
  assert.throws(
    () => context.readFile(
      "missing.bin",
      WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_CONTRIBUTION_BYTES + 1,
    ),
    (error) => error.code === "windows_prepared_artifact_storage_too_large",
  );
  assert.throws(
    () => createWindowsPreparedArtifactStorageContext({
      adapter: createFixture().adapter,
      rootPath: ROOT,
      maximumFileBytes: WINDOWS_PREPARED_ARTIFACT_STORAGE_MAXIMUM_ARTIFACT_BYTES + 1,
    }),
    (error) => error.code === "windows_prepared_artifact_storage_invalid_configuration",
  );
});

test("prepared artifact operations remain root-bound and map to native methods", () => {
  const { context, fixture } = createContext({ maximumFileBytes: 4096 });
  const directory = context.ensureDirectory("set-1");
  const stage = context.createFile("set-1\\bundle.stage", Buffer.from("payload"));
  const read = context.readFile("set-1/bundle.stage");
  assert.deepEqual(read.data, Buffer.from("payload"));
  assert.equal(read.bytes, 7);
  assert.equal(read.identity.fileId, stage.identity.fileId);

  const inspected = context.inspect("set-1/bundle.stage");
  assert.equal(inspected.isRegularFile, true);
  assert.equal(inspected.relativePath, "set-1\\bundle.stage");
  assert.equal(inspected.path, `${ROOT}\\set-1\\bundle.stage`);

  const entries = context.enumerateDirectory("set-1");
  assert.deepEqual(entries.map((entry) => entry.name), ["bundle.stage"]);
  assert.equal(directory.identity.fileId.length, 32);

  const published = context.publishFile(
    "set-1/bundle.stage",
    stage.identity,
    "set-1/bundle.json",
  );
  assert.equal(published.published, true);
  const removed = context.deleteFile("set-1/bundle.json", stage.identity);
  assert.equal(removed.deleted, true);

  const oldDirectory = context.ensureDirectory("set-1/old");
  const renamed = context.renameDirectory(
    "set-1/old",
    oldDirectory.identity,
    "set-1/new",
  );
  assert.equal(renamed.renamed, true);
  const removedDirectory = context.removeDirectory("set-1/new", oldDirectory.identity);
  assert.equal(removedDirectory.removed, true);

  const names = fixture.calls.map(([method]) => method);
  assert.ok(names.includes("inspectPath"));
  assert.ok(names.includes("ensurePreparedDirectory"));
  assert.ok(names.includes("enumeratePreparedDirectory"));
  assert.ok(names.includes("createPreparedFile"));
  assert.ok(names.includes("readPreparedFile"));
  assert.ok(names.includes("publishPreparedFile"));
  assert.ok(names.includes("deletePreparedFile"));
  assert.ok(names.includes("renamePreparedDirectory"));
  assert.ok(names.includes("removePreparedDirectory"));
  const readCall = fixture.calls.find(([method]) => method === "readPreparedFile");
  assert.equal(readCall[1], ROOT);
  assert.equal(readCall[2].fileId, IDENTITY.fileId);
  assert.equal(readCall[3], "set-1\\bundle.stage");
  assert.equal(readCall[4], 4096);
});

test("malformed native responses and hostile metadata fail with fixed errors", () => {
  const malformed = createFixture({
    bindingOverrides: {
      inspectPreparedChild() {
        return {
          identity: IDENTITY,
          isDirectory: false,
          isRegularFile: true,
          isReparsePoint: false,
          ownerMatches: false,
          nullDacl: false,
          daclProtected: true,
          broadAccess: false,
          nonOwnerAllow: false,
          unrecognizedAce: false,
          finalPathResolved: true,
        };
      },
    },
    entries: new Map([[`${ROOT}\\bad.bin`, {
      identity: identity(9),
      directory: false,
      data: Buffer.from("bad"),
    }]]),
  });
  const context = createWindowsPreparedArtifactStorageContext({
    adapter: malformed.adapter,
    rootPath: ROOT,
  });
  assert.throws(
    () => context.inspect("bad.bin"),
    (error) => isWindowsPreparedArtifactStorageError(error)
      && error.code === "windows_prepared_artifact_storage_security_policy"
      && error.message === "Windows prepared artifact storage operation failed",
  );

  const invalidResult = createFixture({
    bindingOverrides: {
      createPreparedFile() {
        return { notAnIdentity: true };
      },
    },
  });
  const invalidContext = createWindowsPreparedArtifactStorageContext({
    adapter: invalidResult.adapter,
    rootPath: ROOT,
  });
  assert.throws(
    () => invalidContext.createFile("invalid.bin", Buffer.from("x")),
    (error) => error.code === "windows_prepared_artifact_storage_invalid_result",
  );

  const invalidEntries = createFixture({
    bindingOverrides: {
      enumeratePreparedDirectory() {
        return [{
          name: "nested\\escape",
          identity: IDENTITY,
          isDirectory: false,
          isRegularFile: true,
          isReparsePoint: false,
        }];
      },
    },
  });
  const invalidEntriesContext = createWindowsPreparedArtifactStorageContext({
    adapter: invalidEntries.adapter,
    rootPath: ROOT,
  });
  assert.throws(
    () => invalidEntriesContext.enumerateDirectory("set-1"),
    (error) => error.code === "windows_prepared_artifact_storage_invalid_result",
  );
});
