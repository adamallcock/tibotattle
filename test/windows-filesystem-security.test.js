import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWindowsFilesystemAdapter,
  loadWindowsFilesystemBinding,
} from "../src/platform/windows-filesystem.js";
import { createWindowsCredentialAuditFileGuardContext } from "../src/platform/windows-credential-audit-file-guard.js";
import { createWindowsCredentialOperationAuditStore } from "../src/platform/windows-credential-operation-audit.js";

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";

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
