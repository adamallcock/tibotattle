import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowsAccountlessInstallationCredentialBackend,
  WindowsAccountlessInstallationCredentialError,
} from "../src/platform/windows-accountless-installation-credential.js";
import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";

const ROOT = "C:\\qualification\\accountless";
const SECRET = Buffer.alloc(32, 41);
const RECORD = "accountless-installation-credential-v1.bin";
const JOURNAL = ".accountless-installation-credential-v1.journal";
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00000000000000000000000000000001",
  linkCount: 1,
});

function nativeError(code) {
  return Object.assign(new Error("native detail must not escape"), {
    code: `WINDOWS_FILESYSTEM_${code}`,
  });
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function memoryBinding({
  beforeRecordRead = null,
  afterRecordCreate = null,
  abandoned = false,
  releaseFailure = null,
  journalCreateFailure = null,
} = {}) {
  const files = new Map();
  const calls = [];
  let nextIdentity = 2;
  let mutexHeld = false;
  let nextAbandoned = abandoned;
  let nextReleaseFailure = releaseFailure;
  let nextJournalCreateFailure = journalCreateFailure;

  function identity() {
    const value = Object.freeze({
      volumeSerialNumber: ROOT_IDENTITY.volumeSerialNumber,
      fileId: nextIdentity.toString(16).padStart(32, "0"),
      linkCount: 1,
    });
    nextIdentity += 1;
    return value;
  }

  function security(identityValue, isDirectory) {
    return Object.freeze({
      identity: identityValue,
      isDirectory,
      isRegularFile: !isDirectory,
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

  function assertRoot(root, rootIdentity) {
    if (root !== ROOT || !sameIdentity(rootIdentity, ROOT_IDENTITY)) {
      throw nativeError("IDENTITY_MISMATCH");
    }
  }

  function read(child, maximumBytes) {
    if (child === RECORD && beforeRecordRead !== null) {
      const failure = beforeRecordRead;
      beforeRecordRead = null;
      throw failure;
    }
    const record = files.get(child);
    if (record === undefined) throw nativeError("NOT_FOUND");
    if (record.data.byteLength > maximumBytes) throw nativeError("FILE_TOO_LARGE");
    return Object.freeze({ data: Buffer.from(record.data), identity: record.identity });
  }

  const binding = {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    inspectPath(path) {
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return security(ROOT_IDENTITY, true);
    },
    ensureDirectory(path) {
      if (path !== ROOT) throw nativeError("NOT_FOUND");
      return ROOT_IDENTITY;
    },
    readFile() { throw nativeError("NOT_FOUND"); },
    createFile() { return identity(); },
    deleteFile() { return Object.freeze({ deleted: true, identity: identity() }); },
    replaceFile() { return identity(); },
    inspectProtectedChild(root, rootIdentity, child) {
      assertRoot(root, rootIdentity);
      const record = files.get(child);
      if (record === undefined) throw nativeError("NOT_FOUND");
      return security(record.identity, false);
    },
    readProtectedChild(root, rootIdentity, child, maximumBytes) {
      assertRoot(root, rootIdentity);
      return read(child, maximumBytes);
    },
    createProtectedChild(root, rootIdentity, child, data) {
      assertRoot(root, rootIdentity);
      if (files.has(child)) throw nativeError("ALREADY_EXISTS");
      if (child === JOURNAL && nextJournalCreateFailure !== null) {
        const failure = nextJournalCreateFailure;
        nextJournalCreateFailure = null;
        throw failure;
      }
      const created = identity();
      files.set(child, { data: Buffer.from(data), identity: created });
      if (child === RECORD && afterRecordCreate !== null) throw afterRecordCreate;
      return created;
    },
    deleteProtectedChild(root, rootIdentity, child, expected) {
      assertRoot(root, rootIdentity);
      const record = files.get(child);
      if (record === undefined) throw nativeError("NOT_FOUND");
      if (!sameIdentity(record.identity, expected)) throw nativeError("IDENTITY_MISMATCH");
      files.delete(child);
      return Object.freeze({ deleted: true, identity: record.identity });
    },
    replaceProtectedChild(root, rootIdentity, child, expected, data) {
      assertRoot(root, rootIdentity);
      const record = files.get(child);
      if (record === undefined) throw nativeError("NOT_FOUND");
      if (!sameIdentity(record.identity, expected)) throw nativeError("IDENTITY_MISMATCH");
      const replacement = identity();
      files.set(child, { data: Buffer.from(data), identity: replacement });
      return replacement;
    },
    acquireCredentialAuditFileGuard() { return Object.freeze({ lease: {} }); },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() {
      calls.push("legacy_acquire");
      return Object.freeze({ abandoned: false, lease: {} });
    },
    releaseCredentialMutex() { calls.push("legacy_release"); },
    acquireAccountlessInstallationCredentialMutex() {
      calls.push("accountless_acquire");
      if (mutexHeld) throw nativeError("ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_CONTENDED");
      mutexHeld = true;
      const result = Object.freeze({ abandoned: nextAbandoned, lease: {} });
      nextAbandoned = false;
      return result;
    },
    releaseAccountlessInstallationCredentialMutex() {
      calls.push("accountless_release");
      if (!mutexHeld) throw nativeError("ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_FOREIGN");
      mutexHeld = false;
      if (nextReleaseFailure !== null) {
        const failure = nextReleaseFailure;
        nextReleaseFailure = null;
        throw failure;
      }
    },
  };
  return Object.freeze({ binding, calls, files });
}

function backend(fixture) {
  return createWindowsAccountlessInstallationCredentialBackend({
    platform: "win32",
    architecture: "x64",
    adapter: createWindowsFilesystemAdapter({
      platform: "win32",
      architecture: "x64",
      binding: fixture.binding,
    }),
    rootPath: ROOT,
  });
}

function backendError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsAccountlessInstallationCredentialError, true);
    assert.equal(error.code, `windows_accountless_installation_credential_${code}`);
    assert.equal(error.message, "Windows accountless installation credential backend failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("Windows accountless credential has a fixed 32-byte private surface outside FD4", async () => {
  const fixture = memoryBinding();
  const selected = backend(fixture);
  assert.deepEqual(Object.keys(selected).sort(), ["createIfMissing", "deleteExact", "read"]);
  assert.equal(await selected.read(), null);
  const supplied = Buffer.from(SECRET);
  assert.equal(await selected.createIfMissing(supplied), "created");
  assert.deepEqual(supplied, SECRET);
  const read = await selected.read();
  assert.deepEqual(read, SECRET);
  read.fill(0);
  assert.equal(await selected.createIfMissing(Buffer.alloc(32, 99)), "existing");
  assert.equal(await selected.deleteExact(Buffer.alloc(32, 3)), "mismatch");
  assert.equal(await selected.deleteExact(SECRET), "deleted");
  assert.equal(await selected.read(), null);
  assert.equal(fixture.calls.includes("legacy_acquire"), false);
  assert.equal(fixture.calls.includes("legacy_release"), false);
  assert.equal(fixture.calls.filter((call) => call === "accountless_acquire").length, 7);
  assert.equal(fixture.calls.filter((call) => call === "accountless_release").length, 7);
});

test("Windows accountless credential preserves recovery after malformed or ambiguously created records", async () => {
  const malformed = memoryBinding();
  const first = backend(malformed);
  assert.equal(await first.read(), null);
  malformed.files.set(RECORD, {
    data: Buffer.alloc(31, 7),
    identity: Object.freeze({
      volumeSerialNumber: ROOT_IDENTITY.volumeSerialNumber,
      fileId: "000000000000000000000000000000aa",
      linkCount: 1,
    }),
  });
  await assert.rejects(first.read(), backendError("recovery_required"));
  malformed.files.delete(RECORD);
  await assert.rejects(backend(malformed).createIfMissing(SECRET), backendError("recovery_required"));

  const ambiguous = memoryBinding({
    afterRecordCreate: nativeError("OPERATION_FAILED"),
  });
  const ambiguousBackend = backend(ambiguous);
  await assert.rejects(ambiguousBackend.createIfMissing(SECRET), backendError("recovery_required"));
  assert.equal(ambiguous.files.has(RECORD), true);
  await assert.rejects(backend(ambiguous).read(), backendError("recovery_required"));
});

test("known pre-mutation failures remain retryable while an injected abandoned lease latches recovery", async () => {
  const retryable = memoryBinding({
    beforeRecordRead: nativeError("OPERATION_FAILED"),
  });
  await assert.rejects(backend(retryable).createIfMissing(SECRET), backendError("unavailable"));
  assert.equal(retryable.files.has(JOURNAL), false);
  assert.equal(await backend(retryable).createIfMissing(SECRET), "created");

  const abandoned = memoryBinding({ abandoned: true });
  await assert.rejects(backend(abandoned).read(), backendError("recovery_required"));
  assert.equal(abandoned.files.has(JOURNAL), true);
  await assert.rejects(backend(abandoned).createIfMissing(SECRET), backendError("recovery_required"));

  const abandonedWithoutDurableLatch = memoryBinding({
    abandoned: true,
    journalCreateFailure: nativeError("OPERATION_FAILED"),
  });
  await assert.rejects(
    backend(abandonedWithoutDurableLatch).read(),
    backendError("operation_failed"),
  );
  assert.equal(abandonedWithoutDurableLatch.files.has(JOURNAL), false);
});

test("a release failure latches recovery before a fresh backend can read the record", async () => {
  const fixture = memoryBinding({
    releaseFailure: nativeError("ACCOUNTLESS_INSTALLATION_CREDENTIAL_MUTEX_RELEASE_FAILED"),
  });
  await assert.rejects(backend(fixture).read(), backendError("recovery_required"));
  assert.equal(fixture.files.has(JOURNAL), true);
  await assert.rejects(backend(fixture).read(), backendError("recovery_required"));
});

test("Windows accountless credential rejects unsupported targets, unsafe bindings, and non-32-byte input", async () => {
  const fixture = memoryBinding();
  assert.throws(
    () => createWindowsAccountlessInstallationCredentialBackend({
      platform: "linux",
      architecture: "x64",
      adapter: createWindowsFilesystemAdapter({ platform: "win32", architecture: "x64", binding: fixture.binding }),
      rootPath: ROOT,
    }),
    backendError("unsupported_platform"),
  );
  assert.throws(
    () => createWindowsAccountlessInstallationCredentialBackend({
      platform: "win32",
      architecture: "arm64",
      adapter: createWindowsFilesystemAdapter({ platform: "win32", architecture: "x64", binding: fixture.binding }),
      rootPath: ROOT,
    }),
    backendError("unsupported_architecture"),
  );
  assert.throws(
    () => createWindowsAccountlessInstallationCredentialBackend({
      platform: "win32",
      architecture: "x64",
      adapter: {},
      rootPath: ROOT,
    }),
    backendError("binding_invalid"),
  );
  await assert.rejects(backend(memoryBinding()).createIfMissing(Buffer.alloc(31)), backendError("invalid_secret"));
});
