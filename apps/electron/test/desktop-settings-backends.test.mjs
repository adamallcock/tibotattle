import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DESKTOP_DEFAULT_SETTINGS,
  validateDesktopSettingsSnapshot,
} from "../desktop-contract.js";
import {
  createPosixDesktopSettingsBackend,
  createWindowsDesktopSettingsBackend,
  DESKTOP_SETTINGS_BACKEND_MAX_BYTES,
  DESKTOP_SETTINGS_FILE_NAME,
  DESKTOP_SETTINGS_STAGE_PREFIX,
} from "../desktop-settings-backends.js";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
} from "../../../src/platform/index.js";

const SETTINGS_FILE = DESKTOP_SETTINGS_FILE_NAME;
const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\state";
const POSIX_TEST_SKIP = process.platform === "win32"
  ? "POSIX owner-mode backend coverage is not a Windows ACL test"
  : false;
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(overrides = {}) {
  return validateDesktopSettingsSnapshot({
    ...clone(DESKTOP_DEFAULT_SETTINGS),
    ...overrides,
  });
}

async function temporaryRoot(callback) {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-desktop-settings-"));
  try {
    return await callback(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function operationError(code) {
  const error = new Error("Windows filesystem operation failed");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function identity(number) {
  return Object.freeze({
    volumeSerialNumber: ROOT_IDENTITY.volumeSerialNumber,
    fileId: number.toString(16).padStart(32, "0"),
    linkCount: 1,
  });
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function metadata(entry) {
  return {
    identity: entry.identity,
    isDirectory: entry.directory === true,
    isRegularFile: entry.directory !== true,
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

function createWindowsStoreFixture() {
  const entries = new Map([
    [ROOT, { directory: true, identity: ROOT_IDENTITY }],
  ]);
  const calls = [];
  let nextIdentity = 2;
  const childPath = (name) => `${ROOT}\\${name}`;
  const entryAt = (path) => {
    const entry = entries.get(path);
    if (!entry) throw operationError("NOT_FOUND");
    return entry;
  };
  const assertRoot = (root, expected) => {
    const entry = entryAt(root);
    if (!sameIdentity(entry.identity, expected)) {
      throw operationError("IDENTITY_MISMATCH");
    }
  };
  const createChild = (name, data) => {
    const path = childPath(name);
    if (entries.has(path)) throw operationError("ALREADY_EXISTS");
    const fileIdentity = identity(nextIdentity++);
    entries.set(path, { data: Buffer.from(data), identity: fileIdentity });
    return fileIdentity;
  };
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
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
    preparedArtifactSafe: false,
    inspectPath(path) {
      calls.push(["inspectPath", path]);
      return metadata(entryAt(path));
    },
    ensureDirectory(path) {
      calls.push(["ensureDirectory", path]);
      const existing = entries.get(path);
      if (existing) return existing.identity;
      const directoryIdentity = identity(nextIdentity++);
      entries.set(path, { directory: true, identity: directoryIdentity });
      return directoryIdentity;
    },
    readFile(path) {
      calls.push(["readFile", path]);
      const entry = entryAt(path);
      if (entry.directory) throw operationError("NOT_REGULAR_FILE");
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    readFileBounded(path) {
      return this.readFile(path);
    },
    createFile(path, data) {
      calls.push(["createFile", path]);
      if (entries.has(path)) throw operationError("ALREADY_EXISTS");
      const fileIdentity = identity(nextIdentity++);
      entries.set(path, { data: Buffer.from(data), identity: fileIdentity });
      return fileIdentity;
    },
    deleteFile(path, expected) {
      const entry = entryAt(path);
      if (!sameIdentity(entry.identity, expected)) {
        throw operationError("IDENTITY_MISMATCH");
      }
      entries.delete(path);
      return { deleted: true, identity: entry.identity };
    },
    replaceFile(path, expected, data) {
      const entry = entryAt(path);
      if (!sameIdentity(entry.identity, expected)) {
        throw operationError("IDENTITY_MISMATCH");
      }
      entry.data = Buffer.from(data);
      entry.identity = identity(nextIdentity++);
      return entry.identity;
    },
    inspectProtectedChild(root, expectedRoot, name) {
      calls.push(["inspectProtectedChild", root, name]);
      assertRoot(root, expectedRoot);
      return metadata(entryAt(childPath(name)));
    },
    readProtectedChild(root, expectedRoot, name, maximumBytes) {
      calls.push(["readProtectedChild", root, name, maximumBytes]);
      assertRoot(root, expectedRoot);
      const entry = entryAt(childPath(name));
      if (entry.directory) throw operationError("NOT_REGULAR_FILE");
      if (entry.data.byteLength > maximumBytes) throw operationError("FILE_TOO_LARGE");
      return { data: Buffer.from(entry.data), identity: entry.identity };
    },
    createProtectedChild(root, expectedRoot, name, data) {
      calls.push(["createProtectedChild", root, name]);
      assertRoot(root, expectedRoot);
      return createChild(name, data);
    },
    deleteProtectedChild(root, expectedRoot, name, expected) {
      calls.push(["deleteProtectedChild", root, name]);
      assertRoot(root, expectedRoot);
      const path = childPath(name);
      const entry = entryAt(path);
      if (!sameIdentity(entry.identity, expected)) {
        throw operationError("IDENTITY_MISMATCH");
      }
      entries.delete(path);
      return { deleted: true, identity: entry.identity };
    },
    replaceProtectedChild(root, expectedRoot, name, expected, data) {
      calls.push(["replaceProtectedChild", root, name, expected]);
      assertRoot(root, expectedRoot);
      const entry = entryAt(childPath(name));
      if (!sameIdentity(entry.identity, expected)) {
        throw operationError("IDENTITY_MISMATCH");
      }
      entry.data = Buffer.from(data);
      entry.identity = identity(nextIdentity++);
      return entry.identity;
    },
    inspectPreparedChild: () => ({ identity: ROOT_IDENTITY }),
    ensurePreparedDirectory: () => ROOT_IDENTITY,
    enumeratePreparedDirectory: () => [],
    removePreparedDirectory: () => ({ removed: true, identity: ROOT_IDENTITY }),
    renamePreparedDirectory: () => ({ renamed: true, identity: ROOT_IDENTITY }),
    createPreparedFile: () => ROOT_IDENTITY,
    readPreparedFile: () => ({ data: Buffer.from("data"), identity: ROOT_IDENTITY }),
    deletePreparedFile: () => ({ deleted: true, identity: ROOT_IDENTITY }),
    publishPreparedFile: () => ({ published: true, identity: ROOT_IDENTITY }),
    acquireSqliteStateLease() {
      return { lease: {}, databaseIdentity: ROOT_IDENTITY, journalIdentity: ROOT_IDENTITY };
    },
    releaseSqliteStateLease() {},
    acquireCredentialAuditFileGuard() {
      return { guard: {}, identity: ROOT_IDENTITY };
    },
    releaseCredentialAuditFileGuard() {},
    acquireCredentialMutex() {
      return { lease: {}, abandoned: false };
    },
    releaseCredentialMutex() {},
    acquireCompanionInstanceMutex() {
      return { lease: {}, abandoned: false };
    },
    releaseCompanionInstanceMutex() {},
  };
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const store = createWindowsProtectedStateStore({
    adapter,
    rootPath: ROOT,
    maxBytes: DESKTOP_SETTINGS_BACKEND_MAX_BYTES,
  });
  return { calls, entries, store };
}

test("POSIX backend returns missing for a fresh root and persists valid snapshots", {
  skip: POSIX_TEST_SKIP,
}, async () => {
  await temporaryRoot(async (parent) => {
    const root = join(parent, "state");
    const backend = createPosixDesktopSettingsBackend({ rootPath: root });
    assert.equal(await backend.load(), null);
    const saved = await backend.save(snapshot({ language: "es" }));
    assert.equal(saved.language, "es");
    const reloaded = await createPosixDesktopSettingsBackend({ rootPath: root }).load();
    assert.deepEqual(reloaded, saved);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(root, SETTINGS_FILE))).mode & 0o777, 0o600);
  });
});

test("POSIX backend rejects unsafe roots, files, symlinks, and hard links", {
  skip: POSIX_TEST_SKIP,
}, async () => {
  await temporaryRoot(async (parent) => {
    const root = join(parent, "state");
    const backend = createPosixDesktopSettingsBackend({ rootPath: root });
    await backend.save(snapshot());
    await chmod(root, 0o755);
    await assert.rejects(backend.load(), (error) => error.code
      === "desktop_settings_backend_unsafe_state");

    await chmod(root, 0o700);
    await chmod(join(root, SETTINGS_FILE), 0o644);
    await assert.rejects(backend.load(), (error) => error.code
      === "desktop_settings_backend_unsafe_state");
    await chmod(join(root, SETTINGS_FILE), 0o600);
    await link(join(root, SETTINGS_FILE), join(root, "hard-link.json"));
    await assert.rejects(backend.load(), (error) => error.code
      === "desktop_settings_backend_unsafe_state");
    await fs.unlink(join(root, "hard-link.json"));

    const outside = join(parent, "outside.json");
    await writeFile(outside, JSON.stringify(snapshot()), { mode: 0o600 });
    await fs.unlink(join(root, SETTINGS_FILE));
    await symlink(outside, join(root, SETTINGS_FILE));
    await assert.rejects(backend.load(), (error) => error.code
      === "desktop_settings_backend_unsafe_state");

    const realRoot = join(parent, "real-state");
    await fs.mkdir(realRoot, { mode: 0o700 });
    const symlinkRoot = join(parent, "linked-state");
    await symlink(realRoot, symlinkRoot);
    await assert.rejects(
      createPosixDesktopSettingsBackend({ rootPath: symlinkRoot }).load(),
      (error) => error.code === "desktop_settings_backend_unsafe_state",
    );
  });
});

test("POSIX backend rejects corrupt and oversized content without repairing it", {
  skip: POSIX_TEST_SKIP,
}, async () => {
  await temporaryRoot(async (parent) => {
    const root = join(parent, "state");
    await fs.mkdir(root, { mode: 0o700 });
    const path = join(root, SETTINGS_FILE);
    await writeFile(path, "not-json", { mode: 0o600 });
    await assert.rejects(
      createPosixDesktopSettingsBackend({ rootPath: root }).load(),
      (error) => error.code === "desktop_settings_backend_corrupt",
    );
    assert.equal(await readFile(path, "utf8"), "not-json");

    await writeFile(path, Buffer.alloc(DESKTOP_SETTINGS_BACKEND_MAX_BYTES + 1, 65), {
      mode: 0o600,
    });
    await assert.rejects(
      createPosixDesktopSettingsBackend({ rootPath: root }).load(),
      (error) => error.code === "desktop_settings_backend_too_large",
    );
  });
});

test("POSIX replacement failure retains the last committed bytes", {
  skip: POSIX_TEST_SKIP,
}, async () => {
  await temporaryRoot(async (parent) => {
    const root = join(parent, "state");
    let failRename = false;
    const failingFs = {
      ...fs,
      async rename(...args) {
        if (failRename) {
          const error = new Error("rename failed");
          error.code = "EIO";
          throw error;
        }
        return fs.rename(...args);
      },
    };
    const backend = createPosixDesktopSettingsBackend({ rootPath: root, fs: failingFs });
    const oldSnapshot = snapshot({ language: "en" });
    const nextSnapshot = snapshot({ language: "es" });
    await backend.save(oldSnapshot);
    failRename = true;
    await assert.rejects(backend.save(nextSnapshot), (error) => error.code
      === "desktop_settings_backend_unavailable");
    assert.deepEqual(
      await createPosixDesktopSettingsBackend({ rootPath: root }).load(),
      oldSnapshot,
    );
  });
});

test("POSIX post-rename failure reconciles to the published bytes", {
  skip: POSIX_TEST_SKIP,
}, async () => {
  await temporaryRoot(async (parent) => {
    const root = join(parent, "state");
    let failSync = false;
    const backend = createPosixDesktopSettingsBackend({
      rootPath: root,
      syncDirectory: async () => {
        if (failSync) {
          const error = new Error("directory sync failed after publication");
          error.code = "EIO";
          throw error;
        }
      },
    });
    const oldSnapshot = snapshot({ language: "en" });
    const nextSnapshot = snapshot({ language: "es" });
    await backend.save(oldSnapshot);
    failSync = true;
    assert.deepEqual(await backend.save(nextSnapshot), nextSnapshot);
    assert.deepEqual(await backend.load(), nextSnapshot);
  });
});

test("POSIX staging is no-clobber when a deterministic stage name already exists", {
  skip: POSIX_TEST_SKIP,
}, async () => {
  await temporaryRoot(async (parent) => {
    const root = join(parent, "state");
    const backend = createPosixDesktopSettingsBackend({
      rootPath: root,
      idFactory: () => "collision",
    });
    const oldSnapshot = snapshot({ language: "en" });
    await backend.save(oldSnapshot);
    const stage = join(
      root,
      `.${DESKTOP_SETTINGS_STAGE_PREFIX.slice(1)}.${SETTINGS_FILE}.collision.tmp`,
    );
    await writeFile(stage, "foreign-stage", { mode: 0o600 });
    await assert.rejects(backend.save(snapshot({ language: "es" })), (error) => error.code
      === "desktop_settings_backend_write_failed");
    assert.equal(await readFile(stage, "utf8"), "foreign-stage");
    assert.deepEqual(await backend.load(), oldSnapshot);
  });
});

test("Windows backend creates, reloads, and identity-replaces only its fixed child", async () => {
  const fixture = createWindowsStoreFixture();
  const backend = createWindowsDesktopSettingsBackend({
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
  });
  assert.equal(await backend.load(), null);
  const first = snapshot({ language: "zh-Hans" });
  const second = snapshot({ language: "es" });
  await backend.save(first);
  assert.deepEqual(await backend.load(), first);
  await backend.save(second);
  assert.deepEqual(await backend.load(), second);
  assert.equal(
    fixture.calls.some(([name, root, child]) => name === "createProtectedChild"
      && root === ROOT && child === SETTINGS_FILE),
    true,
  );
  assert.equal(
    fixture.calls.some(([name, root, child, expected]) => name === "replaceProtectedChild"
      && root === ROOT && child === SETTINGS_FILE && sameIdentity(expected, identity(2))),
    true,
  );
  assert.equal(fixture.calls.some(([name]) => name === "readFile" || name === "createFile"), false);
});

test("Windows backend rejects unbranded stores before any filesystem fallback", () => {
  const calls = [];
  assert.throws(
    () => createWindowsDesktopSettingsBackend({
      platform: "win32",
      windowsProtectedStateStore: {
        readJson: () => calls.push("read"),
        createJson: () => calls.push("create"),
        replaceJson: () => calls.push("replace"),
      },
      fs: {
        readFile: () => calls.push("fallback"),
      },
    }),
    (error) => error.code === "desktop_settings_backend_store_invalid",
  );
  assert.deepEqual(calls, []);
});

test("POSIX backend rejects win32 before touching a filesystem fallback", () => {
  const calls = [];
  assert.throws(
    () => createPosixDesktopSettingsBackend({
      platform: "win32",
      rootPath: "/tmp/tibotattle-desktop-settings",
      fs: {
        chmod: () => calls.push("chmod"),
        lstat: () => calls.push("lstat"),
        mkdir: () => calls.push("mkdir"),
        open: () => calls.push("open"),
        rename: () => calls.push("rename"),
        unlink: () => calls.push("unlink"),
      },
    }),
    (error) => error.code === "desktop_settings_backend_unsupported_platform",
  );
  assert.deepEqual(calls, []);
});
