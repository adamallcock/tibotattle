import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdtemp,
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
  assert.equal(metadata.broadAccess, false);
  assert.equal(metadata.nonOwnerAllow, false);
  assert.equal(metadata.finalPathResolved, true);
  assert.deepEqual(adapter.readFile(file).data, bytes);
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
