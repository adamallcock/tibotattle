import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import {
  createWindowsFilesystemAdapter,
  loadWindowsFilesystemBinding,
} from "../src/platform/windows-filesystem.js";
import { createWindowsCredentialAuditFileGuardContext } from "../src/platform/windows-credential-audit-file-guard.js";
import { createWindowsCredentialOperationAuditStore } from "../src/platform/windows-credential-operation-audit.js";
import {
  WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST,
  WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST,
} from "../scripts/windows-security-qualification.mjs";

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";
const QUALIFICATION_HOOK_METHODS = Object.freeze([
  "armReplacementPause",
  "waitForReplacementPause",
  "releaseReplacementPause",
  "armSqliteStateLeaseReleaseFailure",
]);
const requireNative = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUALIFICATION_BINDING_ENVIRONMENT =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH";
const QUALIFICATION_BINDING_FILE = "windows_filesystem_qualification.node";
const SQLITE_LEASE_CHILD_FIXTURE = fileURLToPath(new URL(
  "./fixtures/windows-sqlite-state-session-child.mjs",
  import.meta.url,
));
const SQLITE_CHILD_READY_TIMEOUT_MS = 10_000;
const SQLITE_CHILD_CLEANUP_TIMEOUT_MS = 5_000;
const QUALIFICATION_CLEANUP_TIMEOUT_MS = 5_000;
const QUALIFICATION_ATTACK_TIMEOUT_MS = 5_000;
const FINAL_TARGET_MUTATION_FAILURE_CODES = new Set([
  "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH",
  "WINDOWS_FILESYSTEM_INVALID_PATH",
]);

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

function loadQualificationBinding(bindingPath = qualificationBindingPath()) {
  return requireNative(bindingPath);
}

function awaitWithin(promise, timeoutMs, timeoutCode) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    timer = setTimeout(() => {
      finish(rejectPromise, new Error(timeoutCode));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish(resolvePromise, value),
      (error) => finish(rejectPromise, error),
    );
  });
}

function startSqliteLeaseChild({ bindingPath, root, rootIdentity, databaseName }) {
  const child = spawn(process.execPath, [
    SQLITE_LEASE_CHILD_FIXTURE,
    "lease",
    bindingPath,
    root,
    JSON.stringify(rootIdentity),
    databaseName,
  ], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.on("error", () => {
    // Cleanup can race a child that has already exited. The fixed child status
    // and exit result remain authoritative; never expose the pipe error.
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.once("error", () => finish(rejectExit,
      new Error("WINDOWS_FILESYSTEM_SQLITE_CHILD_SPAWN_FAILED")));
    child.once("exit", (code, signal) => finish(resolveExit, { code, signal }));
  });
  const marker = (expected) => new Promise((resolveMarker, rejectMarker) => {
    let settled = false;
    let timingOut = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const check = () => {
      if (output.includes(expected)) {
        finish(resolveMarker, undefined);
      } else if (output.includes("WINDOWS_SQLITE_STATE_CHILD_FAILED\n")) {
        finish(rejectMarker, new Error("WINDOWS_FILESYSTEM_SQLITE_CHILD_FAILED"));
      }
    };
    const timer = setTimeout(() => {
      timingOut = true;
      void (async () => {
        if (child.exitCode === null) child.kill("SIGKILL");
        try {
          await awaitWithin(
            exit,
            SQLITE_CHILD_CLEANUP_TIMEOUT_MS,
            "WINDOWS_FILESYSTEM_SQLITE_CHILD_CLEANUP_TIMEOUT",
          );
        } catch {
          // The fixed timeout status remains authoritative.
        }
        finish(rejectMarker, new Error("WINDOWS_FILESYSTEM_SQLITE_CHILD_TIMEOUT"));
      })();
    }, SQLITE_CHILD_READY_TIMEOUT_MS);
    child.stdout.on("data", check);
    child.once("error", () => {
      finish(rejectMarker, new Error("WINDOWS_FILESYSTEM_SQLITE_CHILD_SPAWN_FAILED"));
    });
    child.once("exit", () => {
      if (!timingOut) {
        finish(rejectMarker, new Error("WINDOWS_FILESYSTEM_SQLITE_CHILD_EXITED_EARLY"));
      }
    });
    check();
  });
  const release = async () => {
    try {
      if (child.exitCode === null && !child.stdin.destroyed) {
        child.stdin.end("release\n");
      }
      const result = await awaitWithin(
        exit,
        SQLITE_CHILD_CLEANUP_TIMEOUT_MS,
        "WINDOWS_FILESYSTEM_SQLITE_CHILD_CLEANUP_TIMEOUT",
      );
      if (result.code !== 0
          || output !== "WINDOWS_SQLITE_STATE_CHILD_READY\nWINDOWS_SQLITE_STATE_CHILD_RELEASED\n") {
        throw new Error("WINDOWS_FILESYSTEM_SQLITE_CHILD_RELEASE_FAILED");
      }
    } catch (error) {
      if (child.exitCode === null) child.kill("SIGKILL");
      try {
        await awaitWithin(
          exit,
          SQLITE_CHILD_CLEANUP_TIMEOUT_MS,
          "WINDOWS_FILESYSTEM_SQLITE_CHILD_CLEANUP_TIMEOUT",
        );
      } catch {
        // Preserve the fixed release/timeout error above.
      }
      throw error;
    }
  };
  return { child, exit, marker, output: () => output, release };
}

function runReplacementWorker({ bindingPath, path, expectedIdentity, bytes }) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    try {
      const binding = require(workerData.bindingPath);
      binding.replaceFile(
        workerData.path,
        workerData.expectedIdentity,
        Buffer.from(workerData.bytes),
      );
      parentPort.postMessage({ status: "ok" });
    } catch (error) {
      parentPort.postMessage({
        status: "error",
        code: typeof error?.code === "string"
          ? error.code
          : "WINDOWS_FILESYSTEM_UNKNOWN",
      });
    }
  `, {
    eval: true,
    workerData: {
      bindingPath,
      path,
      expectedIdentity,
      bytes: [...bytes],
    },
  });

  const result = new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let messageReceived = false;
    let message;
    let exitReceived = false;
    let exitCode;
    let timeout;
    const finishIfClean = () => {
      if (settled || !messageReceived || !exitReceived) return;
      settled = true;
      clearTimeout(timeout);
      if (exitCode !== 0) {
        rejectResult(new Error("WINDOWS_FILESYSTEM_QUALIFICATION_WORKER_EXIT"));
        return;
      }
      resolveResult(message);
    };
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      rejectResult(new Error("WINDOWS_FILESYSTEM_QUALIFICATION_WORKER_TIMEOUT"));
    }, 10000);
    worker.once("message", (value) => {
      if (settled) return;
      messageReceived = true;
      message = value;
      finishIfClean();
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectResult(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      exitReceived = true;
      exitCode = code;
      if (code !== 0) {
        settled = true;
        clearTimeout(timeout);
        rejectResult(new Error("WINDOWS_FILESYSTEM_QUALIFICATION_WORKER_EXIT"));
        return;
      }
      finishIfClean();
    });
  });
  return { worker, result };
}

const REVIEWED_SHARING_OR_PERMISSION_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);

async function assertBoundedFilesystemRejection(operation, attackerPromises) {
  let timer;
  const attempt = Promise.resolve().then(operation);
  attackerPromises.push(attempt);
  try {
    await assert.rejects(
      Promise.race([
        attempt,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("WINDOWS_FILESYSTEM_QUALIFICATION_RACE_TIMEOUT")),
            QUALIFICATION_ATTACK_TIMEOUT_MS,
          );
        }),
      ]),
      (error) => REVIEWED_SHARING_OR_PERMISSION_CODES.has(error?.code),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function attemptBoundedFilesystemMutation(operation, attackerPromises) {
  const attempt = Promise.resolve().then(operation);
  attackerPromises.push(attempt);
  try {
    await awaitWithin(
      attempt,
      QUALIFICATION_ATTACK_TIMEOUT_MS,
      "WINDOWS_FILESYSTEM_QUALIFICATION_RACE_TIMEOUT",
    );
    return true;
  } catch (error) {
    if (error?.message === "WINDOWS_FILESYSTEM_QUALIFICATION_RACE_TIMEOUT") {
      throw error;
    }
    if (!REVIEWED_SHARING_OR_PERMISSION_CODES.has(error?.code)) {
      throw error;
    }
    return false;
  }
}

async function withPausedReplacement(run) {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-windows-qualification-race-"));
  const root = join(parent, `private state Ω ${randomUUID()}`);
  const ancestor = join(root, "nested");
  const path = join(ancestor, "state.bin");
  const movedAncestor = join(root, "nested-moved");
  const originalBytes = Buffer.from("original-state\n", "utf8");
  const replacementBytes = Buffer.from("replacement-state\n", "utf8");
  const bindingPath = qualificationBindingPath();
  const binding = loadQualificationBinding(bindingPath);
  let operation;
  const attackerPromises = [];
  let primaryError;
  try {
    binding.ensureDirectory(root);
    binding.ensureDirectory(ancestor);
    const identity = binding.createFile(path, originalBytes);
    binding.armReplacementPause();
    assert.throws(
      () => binding.armReplacementPause(),
      fixedNativeError("WINDOWS_FILESYSTEM_QUALIFICATION_PAUSE_ALREADY_ARMED"),
    );
    operation = runReplacementWorker({
      bindingPath,
      path,
      expectedIdentity: identity,
      bytes: replacementBytes,
    });
    assert.equal(binding.waitForReplacementPause(5000), true);
    assert.throws(
      () => binding.armReplacementPause(),
      fixedNativeError("WINDOWS_FILESYSTEM_QUALIFICATION_PAUSE_ALREADY_ARMED"),
    );
    return await run({
      binding,
      root,
      ancestor,
      movedAncestor,
      path,
      originalBytes,
      replacementBytes,
      operation,
      attackerPromises,
      release: () => binding.releaseReplacementPause(),
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (operation !== undefined) {
      try {
        binding.releaseReplacementPause();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await awaitWithin(
          Promise.allSettled(attackerPromises),
          QUALIFICATION_CLEANUP_TIMEOUT_MS,
          "WINDOWS_FILESYSTEM_QUALIFICATION_ATTACKER_CLEANUP_TIMEOUT",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await awaitWithin(
          operation.result.catch(() => {}),
          QUALIFICATION_CLEANUP_TIMEOUT_MS,
          "WINDOWS_FILESYSTEM_QUALIFICATION_WORKER_RESULT_TIMEOUT",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await awaitWithin(
          operation.worker.terminate(),
          QUALIFICATION_CLEANUP_TIMEOUT_MS,
          "WINDOWS_FILESYSTEM_QUALIFICATION_WORKER_CLEANUP_TIMEOUT",
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await awaitWithin(
        rm(parent, { recursive: true, force: true }),
        QUALIFICATION_CLEANUP_TIMEOUT_MS,
        "WINDOWS_FILESYSTEM_QUALIFICATION_ROOT_CLEANUP_TIMEOUT",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (primaryError === undefined && cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  }
}

async function assertOriginalReplacementPaths({
  path,
  ancestor,
  movedAncestor,
  alias,
  originalBytes,
}) {
  const ancestorStat = await lstat(ancestor);
  assert.equal(ancestorStat.isDirectory(), true);
  assert.equal(ancestorStat.isSymbolicLink(), false);
  const sourceStat = await lstat(path);
  assert.equal(sourceStat.isFile(), true);
  assert.equal(sourceStat.isSymbolicLink(), false);
  assert.equal(sourceStat.size, originalBytes.byteLength);
  // The paused native replacement deliberately holds the destination with
  // DELETE sharing. The binding read primitive requests an incompatible share
  // mode while that handle is open, so use an ordinary Node read only for the
  // paused byte check; the post-release assertions below retain native reads.
  assert.deepEqual(await readFile(path), originalBytes);
  await assert.rejects(
    lstat(movedAncestor),
    (error) => error?.code === "ENOENT",
  );
  if (alias !== undefined) {
    await assert.rejects(
      lstat(alias),
      (error) => error?.code === "ENOENT",
    );
  }
}

async function withSyntheticRoot(run) {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-windows-security-"));
  const root = join(parent, `private state Ω ${randomUUID()}`);
  const adapter = createWindowsFilesystemAdapter();
  try {
    return await run({ adapter, root });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("production binding has no qualification hooks and qualification binding has all hooks", {
  skip: NATIVE_SKIP,
}, () => {
  const production = loadWindowsFilesystemBinding();
  const qualification = loadQualificationBinding();
  for (const method of QUALIFICATION_HOOK_METHODS) {
    assert.equal(Object.hasOwn(production, method), false, method);
    assert.equal(typeof qualification[method], "function", method);
  }
});

function fixedNativeError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, "Windows filesystem operation failed");
    return true;
  };
}

function fixedAdapterError(code) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.message, "Windows filesystem native adapter unavailable");
    return true;
  };
}

test("native adapter creates owner-only roots and stable content-free identities", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  assert.match(rootIdentity.volumeSerialNumber, /^[0-9a-f]{16}$/u);
  assert.match(rootIdentity.fileId, /^[0-9a-f]{32}$/u);
  assert.equal(rootIdentity.linkCount, 1);

  const file = join(root, "state.bin");
  const bytes = Buffer.from("synthetic-state\n", "utf8");
  const created = adapter.createFile(file, bytes);
  const metadata = adapter.inspectPath(file);
  assert.equal(metadata.isRegularFile, true);
  assert.equal(metadata.isDirectory, false);
  assert.equal(metadata.isReparsePoint, false);
  assert.equal(metadata.ownerMatches, true);
  assert.equal(metadata.nullDacl, false);
  if (Object.hasOwn(metadata, "daclProtected")) {
    assert.equal(metadata.daclProtected, true);
  }
  assert.equal(metadata.broadAccess, false);
  assert.equal(metadata.nonOwnerAllow, false);
  assert.equal(metadata.finalPathResolved, true);
  assert.deepEqual(metadata.identity, created);
  assert.deepEqual(adapter.inspectPath(file).identity, created);
  assert.deepEqual(adapter.readFile(file).data, bytes);
  assert.deepEqual(adapter.readFile(file).identity, created);
  assert.deepEqual(adapter.deleteFile(file, created), {
    deleted: true,
    identity: created,
  });
  assert.throws(() => adapter.readFile(file), fixedNativeError("ENOENT"));
}));

test("native protected-child methods inspect, create, read, replace, and delete", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const childPath = "state.bin";
  const originalBytes = Buffer.from("protected-child-original\n", "utf8");
  const replacementBytes = Buffer.from("protected-child-replacement\n", "utf8");
  const createdIdentity = adapter.createProtectedChild(
    root,
    rootIdentity,
    childPath,
    originalBytes,
  );
  assert.match(createdIdentity.fileId, /^[0-9a-f]{32}$/u);
  assert.equal(createdIdentity.linkCount, 1);

  const metadata = adapter.inspectProtectedChild(root, rootIdentity, childPath);
  assert.equal(metadata.isDirectory, false);
  assert.equal(metadata.isRegularFile, true);
  assert.equal(metadata.isReparsePoint, false);
  assert.equal(metadata.ownerMatches, true);
  assert.equal(metadata.nullDacl, false);
  assert.equal(metadata.daclProtected, true);
  assert.equal(metadata.broadAccess, false);
  assert.equal(metadata.nonOwnerAllow, false);
  assert.equal(metadata.finalPathResolved, true);
  assert.deepEqual(metadata.identity, createdIdentity);

  const read = adapter.readProtectedChild(
    root,
    rootIdentity,
    childPath,
    originalBytes.byteLength,
  );
  assert.deepEqual(read.data, originalBytes);
  assert.deepEqual(read.identity, createdIdentity);

  const replacedIdentity = adapter.replaceProtectedChild(
    root,
    rootIdentity,
    childPath,
    createdIdentity,
    replacementBytes,
  );
  assert.notDeepEqual(replacedIdentity, createdIdentity);
  assert.equal(replacedIdentity.linkCount, 1);
  assert.deepEqual(
    adapter.readProtectedChild(root, rootIdentity, childPath, replacementBytes.byteLength).data,
    replacementBytes,
  );

  const deleted = adapter.deleteProtectedChild(
    root,
    rootIdentity,
    childPath,
    replacedIdentity,
  );
  assert.deepEqual(deleted, { deleted: true, identity: replacedIdentity });
  assert.throws(
    () => adapter.inspectProtectedChild(root, rootIdentity, childPath),
    fixedNativeError("ENOENT"),
  );
}));

test("native protected-child bounded reads reject over-limit content without disclosure", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const childPath = "bounded-state.bin";
  const secretBytes = Buffer.from("bounded protected content must not leak\n", "utf8");
  adapter.createProtectedChild(root, rootIdentity, childPath, secretBytes);

  assert.throws(
    () => adapter.readProtectedChild(
      root,
      rootIdentity,
      childPath,
      secretBytes.byteLength - 1,
    ),
    (error) => {
      assert.equal(error?.code, "WINDOWS_FILESYSTEM_FILE_TOO_LARGE");
      assert.equal(error?.message, "Windows filesystem operation failed");
      const rendered = `${error.stack}\n${JSON.stringify(error)}`;
      assert.equal(rendered.includes(secretBytes.toString("utf8")), false);
      assert.equal(rendered.includes(root), false);
      return true;
    },
  );
  assert.deepEqual(
    adapter.readProtectedChild(root, rootIdentity, childPath, secretBytes.byteLength).data,
    secretBytes,
  );
}));

test("native protected-child operations bind to the expected root identity", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const childPath = "state.bin";
  const childBytes = Buffer.from("root-bound-state\n", "utf8");
  const childIdentity = adapter.createProtectedChild(
    root,
    rootIdentity,
    childPath,
    childBytes,
  );
  const forgedRootIdentity = {
    ...rootIdentity,
    fileId: "ffffffffffffffffffffffffffffffff",
  };
  const expectMismatch = (operation) => assert.throws(
    operation,
    fixedNativeError("WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"),
  );

  expectMismatch(() => adapter.inspectProtectedChild(root, forgedRootIdentity, childPath));
  expectMismatch(() => adapter.readProtectedChild(root, forgedRootIdentity, childPath, 1024));
  expectMismatch(() => adapter.createProtectedChild(
    root,
    forgedRootIdentity,
    "other-state.bin",
    Buffer.from("should not be created\n", "utf8"),
  ));
  expectMismatch(() => adapter.deleteProtectedChild(
    root,
    forgedRootIdentity,
    childPath,
    childIdentity,
  ));
  expectMismatch(() => adapter.replaceProtectedChild(
    root,
    forgedRootIdentity,
    childPath,
    childIdentity,
    Buffer.from("should not replace\n", "utf8"),
  ));

  const movedRoot = `${root}-moved`;
  await rename(root, movedRoot);
  adapter.ensureDirectory(root);
  expectMismatch(() => adapter.inspectProtectedChild(root, rootIdentity, childPath));
  assert.deepEqual(
    adapter.readFile(join(movedRoot, childPath)).data,
    childBytes,
  );
}));

test("native protected-child methods reject traversal, repeated, and trailing separators", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const childIdentity = adapter.createProtectedChild(
    root,
    rootIdentity,
    "state.bin",
    Buffer.from("path-bound-state\n", "utf8"),
  );
  const invalidChildPaths = [
    "..",
    ".",
    "nested\\..\\state.bin",
    "nested\\\\state.bin",
    "nested//state.bin",
    "nested\\",
    "\\state.bin",
    "C:\\state.bin",
  ];
  for (const childPath of invalidChildPaths) {
    const expectInvalidPath = (operation) => assert.throws(
      operation,
      fixedNativeError("WINDOWS_FILESYSTEM_INVALID_PATH"),
      childPath,
    );
    expectInvalidPath(() => adapter.inspectProtectedChild(root, rootIdentity, childPath));
    expectInvalidPath(() => adapter.readProtectedChild(root, rootIdentity, childPath, 1024));
    expectInvalidPath(() => adapter.createProtectedChild(
      root,
      rootIdentity,
      childPath,
      Buffer.from("must not be written\n", "utf8"),
    ));
    expectInvalidPath(() => adapter.deleteProtectedChild(
      root,
      rootIdentity,
      childPath,
      childIdentity,
    ));
    expectInvalidPath(() => adapter.replaceProtectedChild(
      root,
      rootIdentity,
      childPath,
      childIdentity,
      Buffer.from("must not replace\n", "utf8"),
    ));
  }
  assert.deepEqual(
    adapter.readProtectedChild(root, rootIdentity, "state.bin", 1024).data,
    Buffer.from("path-bound-state\n", "utf8"),
  );
}));

test("native SQLite state lease creates both rollback files and releases exactly once", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const lease = adapter.acquireSqliteStateLease(root, rootIdentity, "state.sqlite");
  assert.equal(lease.databaseIdentity.linkCount, 1);
  assert.equal(lease.journalIdentity.linkCount, 1);
  assert.deepEqual(
    adapter.inspectProtectedChild(root, rootIdentity, "state.sqlite").identity,
    lease.databaseIdentity,
  );
  assert.deepEqual(
    adapter.inspectProtectedChild(root, rootIdentity, "state.sqlite-journal").identity,
    lease.journalIdentity,
  );
  assert.equal(adapter.sqliteStateLeaseSafe, false);
  adapter.releaseSqliteStateLease(lease);
  assert.throws(
    () => adapter.releaseSqliteStateLease(lease),
    (error) => error?.code === "WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_FOREIGN",
  );
  const native = loadQualificationBinding();
  const direct = native.acquireSqliteStateLease(root, rootIdentity, "state.sqlite");
  native.releaseSqliteStateLease(direct.lease);
  assert.throws(
    () => native.releaseSqliteStateLease(direct.lease),
    fixedNativeError("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_FOREIGN"),
  );
}));

test("native SQLite state lease rejects caller sidecars and non-canonical names", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  adapter.createProtectedChild(
    root,
    rootIdentity,
    "state.sqlite-wal",
    Buffer.from("wal-present\n", "utf8"),
  );
  assert.throws(
    () => adapter.acquireSqliteStateLease(root, rootIdentity, "state.sqlite"),
    fixedNativeError("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_SIDECAR_PRESENT"),
  );
  for (const name of [
    "state.sqlite-journal",
    "state.sqlite-wal",
    "state.sqlite-shm",
    "nested\\state.sqlite",
    "nested/state.sqlite",
  ]) {
    assert.throws(
      () => adapter.acquireSqliteStateLease(root, rootIdentity, name),
      fixedAdapterError("WINDOWS_FILESYSTEM_INVALID_SQLITE_DATABASE_NAME"),
      name,
    );
  }
  assert.throws(
    () => adapter.acquireSqliteStateLease(root, rootIdentity, ".."),
    fixedNativeError("WINDOWS_FILESYSTEM_INVALID_PATH"),
    "..",
  );
}));

test("native SQLite state lease rejects aliases and serializes duplicate leases", {
  skip: NATIVE_SKIP,
}, async (t) => withSyntheticRoot(async ({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const databasePath = join(root, "state.sqlite");
  const aliasPath = join(root, "state-alias.sqlite");
  adapter.createFile(databasePath, Buffer.from("database\n", "utf8"));
  try {
    await link(databasePath, aliasPath);
    assert.throws(
      () => adapter.acquireSqliteStateLease(root, rootIdentity, "state-alias.sqlite"),
      fixedNativeError("WINDOWS_FILESYSTEM_HARD_LINK"),
    );
  } finally {
    await rm(aliasPath, { force: true });
  }

  const lease = adapter.acquireSqliteStateLease(root, rootIdentity, "state.sqlite");
  assert.throws(
    () => adapter.acquireSqliteStateLease(root, rootIdentity, "state.sqlite"),
    fixedNativeError("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_CONTENDED"),
  );
  adapter.releaseSqliteStateLease(lease);

  const symlinkPath = join(root, "state-link.sqlite");
  try {
    await symlink(databasePath, symlinkPath, "file");
    assert.throws(
      () => adapter.acquireSqliteStateLease(root, rootIdentity, "state-link.sqlite"),
      fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EINVAL") {
      t.skip("symbolic-link creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  } finally {
    await rm(symlinkPath, { force: true });
  }
}));

test("native SQLite staging clones, rejects aliases, and publishes atomically", {
  skip: NATIVE_SKIP,
}, async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-windows-sqlite-staging-"));
  const root = join(parent, `private state Ω ${randomUUID()}`);
  const movedRoot = `${root}-moved`;
  const liveName = "local-unified-index-v1.sqlite";
  const stageName = `${liveName}.building-qualification`;
  const bytes = Buffer.from("sqlite-staging-qualification\n", "utf8");
  const replacement = Buffer.from("sqlite-staging-replacement\n", "utf8");
  const binding = loadQualificationBinding();
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const publishWithDiagnostic = (operation) => {
    try {
      return operation();
    } catch (error) {
      const stage = typeof error?.windowsFilesystemStage === "string"
        && WINDOWS_SQLITE_PUBLISH_STAGE_ALLOWLIST.includes(
          error.windowsFilesystemStage,
        )
        ? error.windowsFilesystemStage
        : null;
      const errorCode = typeof error?.code === "string"
        && WINDOWS_SQLITE_PUBLISH_ERROR_ALLOWLIST.includes(error.code)
        ? error.code
        : null;
      if (stage !== null) t.diagnostic(`windowsFilesystemStage: ${stage}`);
      if (errorCode !== null) t.diagnostic(`windowsFilesystemError: ${errorCode}`);
      throw error;
    }
  };
  try {
    const rootIdentity = adapter.ensureDirectory(root);
    const liveIdentity = adapter.createFile(join(root, liveName), bytes);
    const cloned = adapter.cloneSqliteDatabase(
      root,
      rootIdentity,
      liveName,
      stageName,
    );
    assert.deepEqual(cloned.sourceIdentity, liveIdentity);
    assert.deepEqual(adapter.readFile(join(root, stageName)).data, bytes);
    assert.equal(adapter.sqliteStateStagingSafe, false);

    const published = publishWithDiagnostic(() => adapter.publishSqliteDatabase(
      root,
      rootIdentity,
      stageName,
      cloned.stageIdentity,
      liveName,
      liveIdentity,
    ));
    assert.equal(published.published, true);
    assert.deepEqual(adapter.readFile(join(root, liveName)).data, bytes);

    const secondStage = `${liveName}.building-replacement`;
    const second = adapter.createSqliteDatabase(root, rootIdentity, secondStage);
    adapter.replaceFile(join(root, secondStage), second, replacement);
    const current = adapter.inspectPath(join(root, liveName)).identity;
    const republished = publishWithDiagnostic(() => adapter.publishSqliteDatabase(
      root,
      rootIdentity,
      secondStage,
      adapter.inspectPath(join(root, secondStage)).identity,
      liveName,
      current,
    ));
    assert.equal(republished.published, true);
    assert.deepEqual(adapter.readFile(join(root, liveName)).data, replacement);

    const alias = join(root, "local-unified-index-alias.sqlite");
    await link(join(root, liveName), alias);
    assert.throws(
      () => adapter.cloneSqliteDatabase(root, rootIdentity, "local-unified-index-alias.sqlite", `${liveName}.building-alias`),
      fixedNativeError("WINDOWS_FILESYSTEM_HARD_LINK"),
    );
    await rm(alias, { force: true });

    await rename(root, movedRoot);
    adapter.ensureDirectory(root);
    assert.throws(
      () => adapter.cloneSqliteDatabase(root, rootIdentity, liveName, `${liveName}.building-root-swap`),
      fixedNativeError("WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("native SQLite state lease pins the root against rename until release", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const movedRoot = `${root}-moved`;
  const lease = adapter.acquireSqliteStateLease(root, rootIdentity, "state.sqlite");
  await assert.rejects(rename(root, movedRoot));
  adapter.releaseSqliteStateLease(lease);
  await rename(root, movedRoot);
  await rename(movedRoot, root);
}));

test("native SQLite state lease contention crosses a process boundary", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const child = startSqliteLeaseChild({
    bindingPath: qualificationBindingPath(),
    root,
    rootIdentity,
    databaseName: "cross-process.sqlite",
  });
  let primaryError;
  try {
    await child.marker("WINDOWS_SQLITE_STATE_CHILD_READY\n");
    assert.throws(
      () => adapter.acquireSqliteStateLease(root, rootIdentity, "cross-process.sqlite"),
      fixedNativeError("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_CONTENDED"),
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await child.release();
    } catch (error) {
      if (primaryError === undefined) throw error;
    }
  }
  const lease = adapter.acquireSqliteStateLease(
    root,
    rootIdentity,
    "cross-process.sqlite",
  );
  adapter.releaseSqliteStateLease(lease);
}));

test("native protected-child methods reject hard-link and reparse aliases", {
  skip: NATIVE_SKIP,
}, async (t) => withSyntheticRoot(async ({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const childPath = "state.bin";
  const sourcePath = join(root, childPath);
  const childIdentity = adapter.createProtectedChild(
    root,
    rootIdentity,
    childPath,
    Buffer.from("alias-resistant-state\n", "utf8"),
  );
  const hardLinkPath = join(root, "state-hard-link.bin");
  const reparsePath = join(root, "state-reparse-link.bin");
  try {
    await link(sourcePath, hardLinkPath);
    assert.throws(
      () => adapter.readProtectedChild(root, rootIdentity, "state-hard-link.bin", 1024),
      fixedNativeError("WINDOWS_FILESYSTEM_HARD_LINK"),
    );
    assert.throws(
      () => adapter.replaceProtectedChild(
        root,
        rootIdentity,
        "state-hard-link.bin",
        childIdentity,
        Buffer.from("must not replace\n", "utf8"),
      ),
      fixedNativeError("WINDOWS_FILESYSTEM_HARD_LINK"),
    );
  } finally {
    await rm(hardLinkPath, { force: true });
  }

  try {
    await symlink(sourcePath, reparsePath, "file");
    assert.throws(
      () => adapter.inspectProtectedChild(root, rootIdentity, "state-reparse-link.bin"),
      fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
    );
    assert.throws(
      () => adapter.readProtectedChild(root, rootIdentity, "state-reparse-link.bin", 1024),
      fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EINVAL") {
      t.skip("symbolic-link creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  } finally {
    await rm(reparsePath, { force: true });
  }
}));

test("native protected-child traversal rejects a reparse-point ancestor", {
  skip: NATIVE_SKIP,
}, async (t) => withSyntheticRoot(async ({ adapter, root }) => {
  const outside = await mkdtemp(join(tmpdir(), "tibotattle-windows-protected-child-outside-"));
  const rootIdentity = adapter.ensureDirectory(root);
  const junction = join(root, "state-junction");
  try {
    await symlink(outside, junction, "junction");
    assert.throws(
      () => adapter.readProtectedChild(
        root,
        rootIdentity,
        "state-junction\\secret.bin",
        1024,
      ),
      fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EINVAL") {
      t.skip("junction creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  } finally {
    await rm(junction, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
}));

test("native protected-child replacement leaves no temporary artifacts", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const childPath = "state.bin";
  const originalBytes = Buffer.from("temporary cleanup original\n", "utf8");
  const replacementBytes = Buffer.from("temporary cleanup replacement\n", "utf8");
  const childIdentity = adapter.createProtectedChild(
    root,
    rootIdentity,
    childPath,
    originalBytes,
  );
  assert.throws(
    () => adapter.replaceProtectedChild(
      root,
      rootIdentity,
      childPath,
      { ...childIdentity, fileId: "ffffffffffffffffffffffffffffffff" },
      replacementBytes,
    ),
    fixedNativeError("WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"),
  );
  assert.deepEqual(
    adapter.readProtectedChild(root, rootIdentity, childPath, originalBytes.byteLength).data,
    originalBytes,
  );
  const replacementIdentity = adapter.replaceProtectedChild(
    root,
    rootIdentity,
    childPath,
    childIdentity,
    replacementBytes,
  );
  assert.notDeepEqual(replacementIdentity, childIdentity);
  const entries = await readdir(root);
  assert.equal(
    entries.some((entry) => entry.startsWith(".tibotattle-rotation-")),
    false,
  );
}));

test("native adapter rejects hard-link aliases and reparse-point aliases", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ adapter, root }) => {
  const file = join(root, "state.bin");
  const hardLink = join(root, "state-alias.bin");
  const symbolicLink = join(root, "state-link.bin");
  adapter.ensureDirectory(root);
  adapter.createFile(file, Buffer.from("synthetic-state\n", "utf8"));

  await link(file, hardLink);
  assert.throws(
    () => adapter.readFile(hardLink),
    fixedNativeError("WINDOWS_FILESYSTEM_HARD_LINK"),
  );

  await symlink(file, symbolicLink, "file");
  assert.throws(
    () => adapter.readFile(symbolicLink),
    fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
  );
}));

test("native adapter rejects a reparse-point ancestor, not only a final alias", {
  skip: NATIVE_SKIP,
}, async (t) => withSyntheticRoot(async ({ adapter, root }) => {
  const outside = await mkdtemp(join(tmpdir(), "tibotattle-windows-outside-"));
  const junction = join(root, "state-junction");
  try {
    adapter.ensureDirectory(root);
    await symlink(outside, junction, "junction");
    assert.throws(
      () => adapter.readFile(join(junction, "secret.bin")),
      fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EINVAL") {
      t.skip("junction creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}));

test("native handle-bound replacement is conditional on the expected identity", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  adapter.ensureDirectory(root);
  const path = join(root, "state.bin");
  const oldBytes = Buffer.from("old-state\n", "utf8");
  const newBytes = Buffer.from("new-state\n", "utf8");
  const oldIdentity = adapter.createFile(path, oldBytes);
  const binding = loadWindowsFilesystemBinding();

  assert.throws(
    () => binding.replaceFile(path, {
      ...oldIdentity,
      fileId: "ffffffffffffffffffffffffffffffff",
    }, newBytes),
    fixedNativeError("WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"),
  );
  assert.deepEqual(adapter.readFile(path).data, oldBytes);

  const replacement = binding.replaceFile(path, oldIdentity, newBytes);
  assert.notDeepEqual(replacement, oldIdentity);
  assert.deepEqual(adapter.readFile(path).data, newBytes);
  assert.equal(binding.productionSafe, false);
  assert.equal(binding.pathWalkRaceSafe, false);
}));

test("native replacement rejects a path replaced after identity capture", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ adapter, root }) => {
  adapter.ensureDirectory(root);
  const path = join(root, "state.bin");
  const displacedPath = join(root, "state-displaced.bin");
  const originalBytes = Buffer.from("original-state\n", "utf8");
  const currentBytes = Buffer.from("current-state\n", "utf8");
  const replacementBytes = Buffer.from("replacement-state\n", "utf8");
  const capturedIdentity = adapter.createFile(path, originalBytes);
  const binding = loadWindowsFilesystemBinding();

  await rename(path, displacedPath);
  adapter.createFile(path, currentBytes);

  assert.throws(
    () => binding.replaceFile(path, capturedIdentity, replacementBytes),
    (error) => {
      assert.equal(error?.code, "WINDOWS_FILESYSTEM_IDENTITY_MISMATCH");
      assert.equal(error?.message, "Windows filesystem operation failed");
      const rendered = `${error.stack}\n${JSON.stringify(error)}`;
      assert.equal(rendered.includes(path), false);
      assert.equal(rendered.includes(originalBytes.toString("utf8")), false);
      assert.equal(rendered.includes(replacementBytes.toString("utf8")), false);
      return true;
    },
  );
  assert.deepEqual(adapter.readFile(path).data, currentBytes);
  assert.deepEqual(adapter.readFile(displacedPath).data, originalBytes);
}));

test("native adapter supports case-insensitive access through long paths", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const segments = Array.from(
    { length: 8 },
    (_, index) => `long-segment-${index}-${"x".repeat(30)}`,
  );
  const directory = join(root, ...segments);
  const path = join(directory, "State.Case");
  const bytes = Buffer.from("long-case-state\n", "utf8");
  adapter.ensureDirectory(root);
  adapter.ensureDirectory(directory);
  const identity = adapter.createFile(path, bytes);
  const caseVariant = path.replace(/[A-Za-z]/gu, (character) => (
    character === character.toUpperCase()
      ? character.toLowerCase()
      : character.toUpperCase()
  ));

  assert.ok(path.length > 260);
  assert.notEqual(caseVariant, path);
  assert.deepEqual(adapter.readFile(caseVariant).data, bytes);
  assert.deepEqual(adapter.readFile(caseVariant).identity, identity);
}));

test("native adapter keeps hostile path failures fixed and content-free", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  adapter.ensureDirectory(root);
  const canary = join(root, "secret-account-path-canary");
  assert.throws(
    () => adapter.readFile(canary),
    (error) => {
      assert.equal(error?.code, "ENOENT");
      assert.equal(error?.message, "Windows filesystem operation failed");
      const rendered = `${error.stack}\n${JSON.stringify(error)}`;
      assert.equal(rendered.includes(canary), false);
      return true;
    },
  );
}));

test("native adapter rejects reserved and traversal path components", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  adapter.ensureDirectory(root);
  for (const component of ["CON", "state.", "state ", "..", "."]) {
    const candidate = component === "." || component === ".."
      ? `${root}\\${component}`
      : join(root, component);
    assert.throws(
      () => adapter.readFile(candidate),
      fixedNativeError("WINDOWS_FILESYSTEM_INVALID_PATH"),
      component,
    );
  }
}));

test("native audit guards coexist with SQLite and pin its file and private directory", {
  skip: NATIVE_SKIP,
}, async () => withSyntheticRoot(async ({ root }) => {
  const privateRoot = join(root, "private");
  const movedPrivateRoot = join(root, "private-moved");
  const movedStateRoot = `${root}-moved`;
  const filePath = join(
    privateRoot,
    "windows-credential-operation-audit-v1.sqlite",
  );
  const guardContext = createWindowsCredentialAuditFileGuardContext();
  const store = createWindowsCredentialOperationAuditStore({
    filePath,
    fileGuardContext: guardContext,
  });
  try {
    store.prepare({
      leaseId: "00000000-0000-4000-8000-000000000301",
      owner: "participant-identity",
      capability: "export_identity",
      operation: "create",
    });
    store.settle({
      leaseId: "00000000-0000-4000-8000-000000000301",
      result: "created",
    });
    assert.equal(store.read().length, 1);
    await assert.rejects(rename(filePath, `${filePath}.moved`));
    await assert.rejects(rm(filePath));
    await assert.rejects(rename(`${filePath}-journal`, `${filePath}-journal.moved`));
    await assert.rejects(rm(`${filePath}-journal`));
    await assert.rejects(rename(privateRoot, movedPrivateRoot));
    await assert.rejects(rename(root, movedStateRoot));
  } finally {
    store.close();
  }
  await rename(privateRoot, movedPrivateRoot);
  await rename(movedPrivateRoot, privateRoot);
  await rename(root, movedStateRoot);
  await rename(movedStateRoot, root);
}));

test("native audit guard rejects hard-linked and reparse-point database files", {
  skip: NATIVE_SKIP,
}, async (t) => withSyntheticRoot(async ({ adapter, root }) => {
  const privateRoot = join(root, "private");
  const filePath = join(
    privateRoot,
    "windows-credential-operation-audit-v1.sqlite",
  );
  const aliasPath = `${filePath}.alias`;
  adapter.ensureDirectory(root);
  adapter.ensureDirectory(privateRoot);
  adapter.createFile(filePath, Buffer.alloc(0));
  await link(filePath, aliasPath);
  const binding = loadWindowsFilesystemBinding();
  assert.throws(
    () => binding.acquireCredentialAuditFileGuard(filePath),
    fixedNativeError("WINDOWS_FILESYSTEM_HARD_LINK"),
  );
  await rm(aliasPath);
  await rm(filePath);
  try {
    await symlink(aliasPath, filePath, "file");
    assert.throws(
      () => binding.acquireCredentialAuditFileGuard(filePath),
      fixedNativeError("WINDOWS_FILESYSTEM_REPARSE_POINT"),
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EINVAL") {
      t.skip("symbolic-link creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  }
}));

test("qualification hook blocks ancestor rename and recursive delete during replacement", {
  skip: NATIVE_SKIP,
}, () => withPausedReplacement(async ({
  binding,
  ancestor,
  movedAncestor,
  operation,
  path,
  originalBytes,
  replacementBytes,
  release,
  attackerPromises,
}) => {
  await assertBoundedFilesystemRejection(
    () => rename(ancestor, movedAncestor),
    attackerPromises,
  );
  await assertBoundedFilesystemRejection(
    () => rm(ancestor, { recursive: true }),
    attackerPromises,
  );
  await assertOriginalReplacementPaths({
    path,
    ancestor,
    movedAncestor,
    originalBytes,
  });
  release();
  const result = await operation.result;
  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(binding.readFile(path).data, replacementBytes);
  await assert.rejects(
    lstat(movedAncestor),
    (error) => error?.code === "ENOENT",
  );
}));

test("qualification hook fails closed for a final-target rename during replacement", {
  skip: NATIVE_SKIP,
}, () => withPausedReplacement(async ({
  binding,
  operation,
  path,
  ancestor,
  originalBytes,
  replacementBytes,
  release,
  attackerPromises,
}) => {
  const movedPath = join(ancestor, "state-attacker.bin");
  const attackerSucceeded = await attemptBoundedFilesystemMutation(
    () => rename(path, movedPath),
    attackerPromises,
  );
  release();
  const result = await operation.result;
  if (!attackerSucceeded) {
    assert.deepEqual(result, { status: "ok" });
    assert.deepEqual(binding.readFile(path).data, replacementBytes);
    await assert.rejects(
      lstat(movedPath),
      (error) => error?.code === "ENOENT",
    );
    return;
  }
  assert.equal(result.status, "error");
  assert.equal(FINAL_TARGET_MUTATION_FAILURE_CODES.has(result.code), true);
  assert.deepEqual(binding.readFile(movedPath).data, originalBytes);
  await assert.rejects(
    lstat(path),
    (error) => error?.code === "ENOENT",
  );
}));

test("qualification hook handles hard-link creation during replacement", {
  skip: NATIVE_SKIP,
}, () => withPausedReplacement(async ({
  binding,
  operation,
  path,
  ancestor,
  movedAncestor,
  originalBytes,
  replacementBytes,
  release,
  attackerPromises,
}) => {
  const alias = join(ancestor, "state-hard-link-alias.bin");
  const attackerSucceeded = await attemptBoundedFilesystemMutation(
    () => link(path, alias),
    attackerPromises,
  );
  if (!attackerSucceeded) {
    // The replacement is still paused: prove that a blocked attacker left the
    // original path untouched before allowing the worker to continue.
    await assertOriginalReplacementPaths({
      path,
      ancestor,
      movedAncestor,
      alias,
      originalBytes,
    });
    release();
    const result = await operation.result;
    assert.deepEqual(result, { status: "ok" });
    assert.deepEqual(binding.readFile(path).data, replacementBytes);
    await assert.rejects(
      lstat(alias),
      (error) => error?.code === "ENOENT",
    );
    return;
  }

  // A permitted hard link must not be able to turn into a successful
  // replacement. Check both names while the replacement remains paused.
  await assertOriginalReplacementPaths({
    path,
    ancestor,
    movedAncestor,
    originalBytes,
  });
  assert.deepEqual(await readFile(alias), originalBytes);
  release();
  const result = await operation.result;
  assert.deepEqual(result, {
    status: "error",
    code: "WINDOWS_FILESYSTEM_HARD_LINK",
  });
  await assertOriginalReplacementPaths({
    path,
    ancestor,
    movedAncestor,
    originalBytes,
  });
  const aliasStat = await lstat(alias);
  assert.equal(aliasStat.isFile(), true);
  assert.equal(aliasStat.isSymbolicLink(), false);
  assert.equal(aliasStat.size, originalBytes.byteLength);
  // The native read primitive deliberately rejects hard-linked files. Use
  // ordinary Node reads for this fail-closed branch to prove both names kept
  // the original bytes and never received the replacement.
  assert.deepEqual(await readFile(path), originalBytes);
  assert.deepEqual(await readFile(alias), originalBytes);
}));
