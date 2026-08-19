import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWindowsFilesystemAdapter,
} from "../src/platform/windows-filesystem.js";
import {
  createWindowsCompanionInstanceLeaseContext,
} from "../src/platform/windows-companion-instance-lease.js";
import {
  createOwnerOnlyAutomaticContributionStorageContext,
} from "../src/platform/owner-only-automatic-contribution-storage.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireNative = createRequire(import.meta.url);
const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const QUALIFICATION_BINDING_ENVIRONMENT =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH";
const QUALIFICATION_BINDING_FILE = "windows_filesystem_qualification.node";
const CHILD = resolve(
  REPOSITORY_ROOT,
  "test/fixtures/windows-companion-instance-lease-child.mjs",
);
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function qualificationBindingPath() {
  const configured = process.env[QUALIFICATION_BINDING_ENVIRONMENT];
  if (!NATIVE_WINDOWS) {
    return resolve(
      REPOSITORY_ROOT,
      "native",
      "windows-filesystem",
      "build",
      "Release",
      QUALIFICATION_BINDING_FILE,
    );
  }
  if (typeof configured !== "string"
      || !win32.isAbsolute(configured)
      || win32.basename(configured).toLowerCase()
        !== QUALIFICATION_BINDING_FILE.toLowerCase()) {
    throw new Error("WINDOWS_FILESYSTEM_QUALIFICATION_BINDING_PATH_INVALID");
  }
  return configured;
}

function nativeError(code) {
  const error = new Error("Windows filesystem operation failed");
  error.code = `WINDOWS_FILESYSTEM_${code}`;
  return error;
}

function adapterFixture({ abandoned = false } = {}) {
  let active = false;
  let nextLease = 0;
  const nativeLeases = new Set();
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
    acquireCredentialAuditFileGuard: () => ({ guard: {}, identity: IDENTITY }),
    releaseCredentialAuditFileGuard: () => {},
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => {},
    acquireSqliteStateLease: () => ({
      lease: {},
      databaseIdentity: IDENTITY,
      journalIdentity: IDENTITY,
    }),
    releaseSqliteStateLease: () => {},
    acquireCompanionInstanceMutex: () => {
      if (active) throw nativeError("COMPANION_INSTANCE_MUTEX_CONTENDED");
      active = true;
      const lease = { id: nextLease++ };
      nativeLeases.add(lease);
      const wasAbandoned = abandoned;
      abandoned = false;
      return { lease, abandoned: wasAbandoned };
    },
    releaseCompanionInstanceMutex: (lease) => {
      if (!nativeLeases.has(lease)) {
        throw nativeError("COMPANION_INSTANCE_MUTEX_FOREIGN");
      }
      nativeLeases.delete(lease);
      active = false;
    },
    inspectPreparedChild: () => ({ identity: IDENTITY }),
    ensurePreparedDirectory: () => IDENTITY,
    enumeratePreparedDirectory: () => [],
    removePreparedDirectory: () => ({ removed: true, identity: IDENTITY }),
    renamePreparedDirectory: () => ({ renamed: true, identity: IDENTITY }),
    createPreparedFile: () => IDENTITY,
    readPreparedFile: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    deletePreparedFile: () => ({ deleted: true, identity: IDENTITY }),
    publishPreparedFile: () => ({ published: true, identity: IDENTITY }),
  };
  return createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
}

test("Windows companion lease is branded, opaque, and reports only fixed recovery state", () => {
  const adapter = adapterFixture({ abandoned: true });
  const context = createWindowsCompanionInstanceLeaseContext({
    platform: "win32",
    architecture: "x64",
    adapter,
  });
  const lease = context.acquire();
  assert.deepEqual(lease, { abandoned: true });
  assert.equal(context.wasAbandoned(lease), true);
  assert.throws(
    () => context.acquire(),
    (error) => error?.code === "windows_companion_instance_lease_contended",
  );
  context.release(lease);
  assert.throws(
    () => context.release(lease),
    (error) => error?.code === "windows_companion_instance_lease_foreign",
  );
  assert.throws(
    () => context.release(Object.freeze({ abandoned: false })),
    (error) => error?.code === "windows_companion_instance_lease_foreign",
  );
});

test("Windows automatic-contribution storage never falls back to a caller-named file lock", async () => {
  const adapter = adapterFixture();
  const context = createWindowsCompanionInstanceLeaseContext({
    platform: "win32",
    architecture: "x64",
    adapter,
  });
  const storage = createOwnerOnlyAutomaticContributionStorageContext({
    createError: (code) => Object.assign(new Error(code), { code }),
    platform: "win32",
    windowsCompanionInstanceLease: context,
  });
  const lock = await storage.acquireInstanceLock({
    lockFile: "C:\\caller\\controlled\\ignored.lock",
    maximumBytes: 4 * 1024,
  });
  assert.equal(lock.recovered, false);
  await lock.release();
  assert.throws(
    () => createWindowsCompanionInstanceLeaseContext({
      platform: "win32",
      architecture: "x64",
      adapter: {},
    }),
    (error) => error?.code === "windows_companion_instance_lease_invalid_adapter",
  );
});

test("native source exposes only the fixed owner-only companion mutex boundary", async () => {
  const source = await readFile(
    resolve(REPOSITORY_ROOT, "native/windows-filesystem/windows-filesystem.cc"),
    "utf8",
  );
  assert.match(source, /GetArguments\(env, info, &arguments, 0\)/u);
  assert.match(source, /Local\\\\TiboTattle-CompanionInstance-v1-/u);
  assert.match(source, /CreateMutexExW\(/u);
  assert.match(source, /WAIT_ABANDONED_0/u);
  assert.match(source, /CompanionInstanceMutexContended\(\)/u);
  assert.match(source, /ownerThreadId != GetCurrentThreadId\(\)/u);
  assert.match(source, /AttemptCompanionInstanceMutexReleaseFromWorkerCallback/u);
  assert.match(source, /std::thread worker\(\[lease, &result\]/u);
  assert.match(source, /"acquireCompanionInstanceMutex"/u);
  assert.match(source, /"releaseCompanionInstanceMutex"/u);
  assert.doesNotMatch(
    source.slice(source.indexOf("napi_value AcquireCompanionInstanceMutexCallback")),
    /GetString\(env/u,
  );
});

function runChild(mode) {
  return spawnSync(process.execPath, [CHILD, mode], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
}

test("native companion mutex serializes child processes and can be reacquired", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, () => {
  const context = createWindowsCompanionInstanceLeaseContext();
  const lease = context.acquire();
  try {
    const contender = runChild("once");
    assert.equal(contender.status, 2);
    assert.equal(contender.stdout.trim(), "WINDOWS_COMPANION_INSTANCE_CHILD_CONTENDED");
    assert.equal(contender.stderr, "");
  } finally {
    context.release(lease);
  }
  const reacquired = runChild("once");
  assert.equal(reacquired.status, 0);
  assert.equal(reacquired.stdout.trim(), "WINDOWS_COMPANION_INSTANCE_CHILD_ACQUIRED");
  assert.equal(reacquired.stderr, "");
});

test("native companion mutex transfers abandoned ownership as content-free recovery", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, () => {
  const crashed = runChild("crash");
  assert.equal(crashed.status, 17);
  assert.equal(crashed.stdout.trim(), "WINDOWS_COMPANION_INSTANCE_CHILD_ACQUIRED");
  assert.equal(crashed.stderr, "");
  const context = createWindowsCompanionInstanceLeaseContext();
  const lease = context.acquire();
  try {
    assert.equal(context.wasAbandoned(lease), true);
  } finally {
    context.release(lease);
  }
});

test("native companion mutex rejects same-process recursive acquisition", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, () => {
  const context = createWindowsCompanionInstanceLeaseContext();
  const lease = context.acquire();
  try {
    assert.throws(
      () => context.acquire(),
      (error) => error?.code === "windows_companion_instance_lease_contended",
    );
  } finally {
    context.release(lease);
  }
});

test("native companion mutex rejects worker-thread release without mutating the owner lease", {
  skip: NATIVE_WINDOWS ? false : "native Windows x64 only",
}, () => {
  const binding = requireNative(qualificationBindingPath());
  assert.equal(
    typeof binding.attemptCompanionInstanceMutexReleaseFromWorker,
    "function",
  );
  const acquired = binding.acquireCompanionInstanceMutex();
  let released = false;
  try {
    assert.deepEqual(
      binding.attemptCompanionInstanceMutexReleaseFromWorker(acquired.lease),
      { rejected: true },
    );
    assert.throws(
      () => binding.acquireCompanionInstanceMutex(),
      (error) => error?.code === "WINDOWS_FILESYSTEM_COMPANION_INSTANCE_MUTEX_CONTENDED",
    );
    assert.doesNotThrow(() => binding.releaseCompanionInstanceMutex(acquired.lease));
    released = true;
  } finally {
    if (!released) {
      try {
        binding.releaseCompanionInstanceMutex(acquired.lease);
      } catch {
        // Preserve the primary assertion failure while attempting cleanup.
      }
    }
  }
  const reacquired = binding.acquireCompanionInstanceMutex();
  binding.releaseCompanionInstanceMutex(reacquired.lease);
});
