import assert from "node:assert/strict";
import { test } from "node:test";

import { createAutomaticContributionController } from "../src/automatic-contribution.js";
import {
  createCodexSpeedBaselineController,
  CodexSpeedBaselineError,
} from "../src/codex-speed-baseline.js";
import {
  FastModePreferenceError,
  createFastModePreferenceController,
} from "../src/fast-mode-preference.js";
import { createIncrementalContributionSyncController } from "../src/incremental-contribution.js";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStore,
} from "../src/platform/index.js";
import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "../src/platform/owner-only-automatic-contribution-storage.js";

const ROOT = "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\state";
const ROOT_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

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

function operationError(code) {
  const error = new Error("Windows filesystem operation failed");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function createProtectedStoreFixture() {
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
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    companionInstanceMutexSafe: false,
    credentialAuditFileGuardSafe: true,
    sqliteStateLeaseSafe: false,
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
      if (entry.data.byteLength > maximumBytes) {
        throw operationError("FILE_TOO_LARGE");
      }
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
      calls.push(["replaceProtectedChild", root, name]);
      assertRoot(root, expectedRoot);
      const entry = entryAt(childPath(name));
      if (!sameIdentity(entry.identity, expected)) {
        throw operationError("IDENTITY_MISMATCH");
      }
      entry.data = Buffer.from(data);
      entry.identity = identity(nextIdentity++);
      return entry.identity;
    },
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
  });
  return { calls, entries, store };
}

function errorFactory(code) {
  return new Error(code);
}

test("Windows fixed-state storage routes settings through the exact protected child", async () => {
  const fixture = createProtectedStoreFixture();
  const storage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: errorFactory,
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
  });
  const settingsFile = `${ROOT}\\fast-mode-preference-v0.1.json`;

  await storage.writeSettingsText({
    settingsFile,
    text: "protected-value\n",
    maximumBytes: 4 * 1024,
  });
  assert.equal(
    await storage.readSettingsText({ settingsFile, maximumBytes: 4 * 1024 }),
    "protected-value\n",
  );
  await storage.writeSettingsText({
    settingsFile,
    text: "protected-replacement\n",
    maximumBytes: 4 * 1024,
  });
  assert.equal(
    await storage.readSettingsText({ settingsFile, maximumBytes: 4 * 1024 }),
    "protected-replacement\n",
  );
  assert.equal(fixture.calls.some(([name]) => name === "readFile"), false);
  assert.equal(fixture.calls.some(([name]) => name === "createFile"), false);
  assert.equal(
    fixture.calls.some(([name, root, child]) => name === "readProtectedChild"
      && root === ROOT
      && child === "fast-mode-preference-v0.1.json"),
    true,
  );
  await assert.rejects(
    () => storage.acquireInstanceLock({
      lockFile: `${ROOT}\\automatic-contribution.lock`,
      maximumBytes: 4 * 1024,
    }),
    (error) => error?.message === "instance_lock_unavailable",
  );
});

test("fast mode, baseline, automatic, and incremental controllers use the protected store", async () => {
  const fixture = createProtectedStoreFixture();
  assert.equal(isWindowsProtectedStateStore(fixture.store), true);
  const fastMode = createFastModePreferenceController({
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
    settingsFile: `${ROOT}\\fast-mode-preference-v0.1.json`,
    now: () => new Date("2026-08-18T12:00:00.000Z"),
  });
  assert.equal((await fastMode.select("fast")).mode, "fast");
  assert.equal(await fastMode.readMode(), "fast");

  const baseline = createCodexSpeedBaselineController({
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
    ledgerFile: `${ROOT}\\codex-speed-baseline-v0.1.json`,
    configFile: `${ROOT}\\codex\\config.toml`,
    readServiceTier: async () => ({ status: "declared", serviceTier: "priority" }),
    now: () => new Date("2026-08-18T12:00:00.000Z"),
  });
  assert.equal((await baseline.record()).status, "opened");

  const automatic = createAutomaticContributionController({
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
    settingsFile: `${ROOT}\\automatic-contribution-v0.1.json`,
    destinationOrigin: null,
    prepareRunner: async () => ({}),
    uploadRunner: async () => ({}),
  });
  await automatic.initialize();
  await automatic.disable();

  const incremental = createIncrementalContributionSyncController({
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
    settingsFile: `${ROOT}\\incremental-contribution-v1.json`,
    destinationOrigin: "http://127.0.0.1:8787",
    runner: async () => ({
      schemaVersion: "incremental-contribution-sync-run-v1.0",
      status: "complete",
      daysTotal: 0,
      daysSynced: 0,
      daysPending: 0,
      chunksUploaded: 0,
      failure: null,
    }),
  });
  await incremental.initialize();
  await incremental.approve();

  const protectedCalls = fixture.calls.filter(([name]) => name.endsWith("ProtectedChild"));
  assert.ok(protectedCalls.length >= 8);
});

test("Windows fixed-state factories reject forged stores, path escapes, and ordinary storage injection", async () => {
  const fixture = createProtectedStoreFixture();
  const forged = { ...fixture.store };
  assert.equal(isWindowsProtectedStateStore(forged), false);

  assert.throws(
    () => createOwnerOnlyAutomaticContributionStorageContext({
      createError: errorFactory,
      platform: "win32",
      windowsProtectedStateStore: forged,
    }),
    TypeError,
  );

  const validStorage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: errorFactory,
    platform: "win32",
    windowsProtectedStateStore: fixture.store,
  });
  await assert.rejects(
    () => validStorage.readSettingsText({
      settingsFile: `${ROOT}\\nested\\escaped.json`,
      maximumBytes: 1024,
    }),
    (error) => error?.message === "configuration_invalid",
  );

  assert.throws(
    () => createFastModePreferenceController({
      platform: "win32",
      settingsFile: `${ROOT}\\fast.json`,
      storage: {
        readSettingsText: async () => null,
        writeSettingsText: async () => {},
      },
    }),
    (error) => error instanceof FastModePreferenceError
      && error.code === "fast_mode_preference_invalid",
  );
  assert.throws(
    () => createCodexSpeedBaselineController({
      platform: "win32",
      ledgerFile: `${ROOT}\\baseline.json`,
      configFile: `${ROOT}\\config.toml`,
      storage: {
        readSettingsText: async () => null,
        writeSettingsText: async () => {},
      },
    }),
    (error) => error instanceof CodexSpeedBaselineError
      && error.code === "codex_speed_baseline_unavailable",
  );

  assert.throws(
    () => createFastModePreferenceController({
      platform: "linux",
      windowsProtectedStateStore: fixture.store,
      settingsFile: "/tmp/fast.json",
    }),
    (error) => error instanceof FastModePreferenceError
      && error.code === "fast_mode_preference_invalid",
  );
  assert.throws(
    () => createIncrementalContributionSyncController({
      platform: "win32",
      windowsProtectedStateStore: forged,
      settingsFile: `${ROOT}\\incremental.json`,
      destinationOrigin: "http://127.0.0.1:8787",
      runner: async () => null,
    }),
    TypeError,
  );
});
