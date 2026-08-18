import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  link,
  lstat,
  mkdtemp,
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

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";
const QUALIFICATION_HOOK_METHODS = Object.freeze([
  "armReplacementPause",
  "waitForReplacementPause",
  "releaseReplacementPause",
]);
const requireNative = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUALIFICATION_BINDING_ENVIRONMENT =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH";
const QUALIFICATION_BINDING_FILE = "windows_filesystem_qualification.node";

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
            5000,
          );
        }),
      ]),
      (error) => REVIEWED_SHARING_OR_PERMISSION_CODES.has(error?.code),
    );
  } finally {
    clearTimeout(timer);
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
  } finally {
    if (operation !== undefined) {
      binding.releaseReplacementPause();
      await Promise.allSettled(attackerPromises);
      await operation.result.catch(() => {});
      await operation.worker.terminate();
    }
    await rm(parent, { recursive: true, force: true });
  }
}

async function assertOriginalReplacementPaths({
  binding,
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
  assert.deepEqual(binding.readFile(path).data, originalBytes);
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
    binding,
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

test("qualification hook blocks hard-link creation during replacement", {
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
  await assertBoundedFilesystemRejection(
    () => link(path, alias),
    attackerPromises,
  );
  await assertOriginalReplacementPaths({
    binding,
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
}));
