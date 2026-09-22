import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
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
import {
  classifyWindowsSyntheticSourceOwnerFailure,
  ensureWindowsSyntheticSourceOwner,
} from "../scripts/lib/windows-synthetic-source-owner.mjs";

import { createTimingFilesystem } from '../src/platform/inference-timing-filesystem.js';
import { openTimingStore, ingestTimingFile, readTimingRows } from '../src/platform/inference-timing-store.js';
import { createParser, digest, METHOD, MAX_STATE_BYTES } from '../src/providers/codex/logs.js';

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

async function writeSyntheticOwnedSource(path, contents) {
  await writeFile(path, contents, { flag: "wx" });
  // An elevated Windows token can default new files to a group owner. Give
  // only this disposable fixture the current user's owner SID; preserve its
  // ordinary source DACL instead of turning it into protected derived state.
  ensureWindowsSyntheticSourceOwner(path);
}

test("synthetic owner child removes inherited module paths without changing its parent", () => {
  const path = String.raw`C:\runner\owned\synthetic.jsonl`;
  const parent = Object.freeze({
    PSModulePath: "synthetic-pwsh7-modules",
    pSmOdUlEpAtH: "synthetic-other-inherited-modules",
    PATH: "synthetic-executable-search",
    SystemRoot: "synthetic-windows-root",
    TIBOTATTLE_SYNTHETIC_SOURCE_FILE: "synthetic-previous-source",
  });
  const before = { ...parent };
  let child;
  ensureWindowsSyntheticSourceOwner(path, {
    environment: parent,
    run: (_command, _args, options) => {
      child = options.env;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(child, {
    PATH: parent.PATH,
    SystemRoot: parent.SystemRoot,
    TIBOTATTLE_SYNTHETIC_SOURCE_FILE: path,
  });
  assert.deepEqual(parent, before);
});

test("synthetic owner setup failures report fixed categories without subprocess details", () => {
  const canary = "private-fixture-path-or-owner-canary";
  const path = String.raw`C:\runner\owned\synthetic.jsonl`;
  const failureCategories = {
    31: "current_owner_read_failed", 32: "acl_before_read_failed",
    33: "acl_before_snapshot_failed", 34: "owner_tool_invocation_failed",
    35: "owner_tool_exit_failed", 36: "acl_after_read_failed",
    37: "owner_after_read_failed", 38: "owner_readback_mismatch",
    39: "acl_after_snapshot_failed", 40: "dacl_changed",
  };
  for (const [result, category] of [
    ...Object.entries(failureCategories).map(([status, category]) => (
      [{ status: Number(status) }, category]
    )),
    [{ status: 1 }, "unexpected_setup_exit"],
    [{ status: null, error: { code: "ETIMEDOUT", message: canary } }, "setup_timed_out"],
    [{ status: null, error: { code: canary, message: canary } }, "setup_launch_failed"],
  ]) {
    assert.throws(() => ensureWindowsSyntheticSourceOwner(path, {
      run: () => ({ ...result, stdout: canary, stderr: canary }),
    }), (error) => {
      assert.equal(classifyWindowsSyntheticSourceOwnerFailure(error), `synthetic_owner_${category}`);
      assert.equal(error.message.includes(canary), false);
      return true;
    });
  }
  ensureWindowsSyntheticSourceOwner(path, {
    run: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  for (const field of ["stdout", "stderr"]) {
    assert.throws(() => ensureWindowsSyntheticSourceOwner(path, {
      run: () => ({ status: 0, stdout: "", stderr: "", [field]: canary }),
    }), (error) => {
      assert.equal(classifyWindowsSyntheticSourceOwnerFailure(error),
        "synthetic_owner_unexpected_setup_exit");
      assert.equal(error.message.includes(canary), false);
      return true;
    });
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

test("native protected child operations bind the supplied root and requested byte cap", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(({ adapter, root }) => {
  const rootIdentity = adapter.ensureDirectory(root);
  const binding = loadWindowsFilesystemBinding();
  const child = "protected-state.bin";
  const initial = Buffer.from("protected-state", "utf8");
  const replacementBytes = Buffer.from("replacement-state", "utf8");

  const created = binding.createProtectedChild(root, rootIdentity, child, initial);
  const metadata = binding.inspectProtectedChild(root, rootIdentity, child);
  assert.deepEqual(metadata.identity, created);
  assert.equal(metadata.isRegularFile, true);
  assert.equal(metadata.finalPathResolved, true);
  assert.deepEqual(
    binding.readProtectedChild(root, rootIdentity, child, initial.byteLength),
    { data: initial, identity: created },
  );
  assert.throws(
    () => binding.readProtectedChild(root, rootIdentity, child, initial.byteLength - 1),
    fixedNativeError("WINDOWS_FILESYSTEM_FILE_TOO_LARGE"),
  );
  assert.throws(
    () => binding.inspectProtectedChild(root, {
      ...rootIdentity,
      fileId: "ffffffffffffffffffffffffffffffff",
    }, child),
    fixedNativeError("WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"),
  );
  assert.throws(
    () => binding.inspectProtectedChild(root, rootIdentity, "..\\outside"),
    fixedNativeError("WINDOWS_FILESYSTEM_INVALID_PATH"),
  );
  assert.throws(
    () => binding.replaceProtectedChild(root, rootIdentity, child, {
      ...created,
      fileId: "ffffffffffffffffffffffffffffffff",
    }, replacementBytes),
    fixedNativeError("WINDOWS_FILESYSTEM_IDENTITY_MISMATCH"),
  );
  assert.deepEqual(
    binding.readProtectedChild(root, rootIdentity, child, initial.byteLength),
    { data: initial, identity: created },
  );

  const replacement = binding.replaceProtectedChild(
    root,
    rootIdentity,
    child,
    created,
    replacementBytes,
  );
  assert.notDeepEqual(replacement, created);
  assert.deepEqual(
    binding.readProtectedChild(root, rootIdentity, child, replacementBytes.byteLength),
    { data: replacementBytes, identity: replacement },
  );
  assert.deepEqual(binding.deleteProtectedChild(root, rootIdentity, child, replacement), {
    deleted: true,
    identity: replacement,
  });
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


test("native source handle holds its name, bounds reads and rejects links and foreign leases", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(async ({ adapter, root }) => {
  adapter.ensureDirectory(root);
  const native = loadWindowsFilesystemBinding();
  const source = join(root, "source Ω.jsonl");
  // Codex's ordinary source ACL is accepted; derived state still requires
  // the stricter owner-only protected DACL.
  await writeSyntheticOwnedSource(source, "synthetic\n");
  // Audit guards authenticate the file and its two nearest parent directories.
  const privateRoot = join(root, "private");
  adapter.ensureDirectory(privateRoot);
  const protectedFile = join(privateRoot, "protected.sqlite");
  adapter.createFile(protectedFile, Buffer.alloc(0));
  const protectedLease = native.acquireCredentialAuditFileGuard(protectedFile);
  try {
    assert.throws(() => native.closeSourceFile(protectedLease.guard));
    assert.throws(() => native.readSourceFile(protectedLease.guard, 0, 1));
  } finally { native.releaseCredentialAuditFileGuard(protectedLease.guard); }
  const lease = native.openSourceFile(source);
  try {
    assert.equal(native.statSourceFile(lease).size, 10);
    assert.equal(native.readSourceFile(lease, 0, 65536).toString(), "synthetic\n");
    assert.throws(() => native.readSourceFile(lease, 0, 65537));
    assert.throws(() => native.readSourceFile(lease, -1, 1));
    assert.throws(() => native.statSourceFile({}));
    await assert.rejects(rename(source, join(root, "moved.jsonl")));
    await assert.rejects(rename(root, `${root}-moved`));
  } finally { native.closeSourceFile(lease); }
  assert.throws(() => native.statSourceFile(lease));
  await rename(source, join(root, "moved.jsonl"));
  const linked = join(root, "hardlink.jsonl");
  await link(join(root, "moved.jsonl"), linked);
  assert.throws(() => native.openSourceFile(linked));
  const junction = `${root}-junction`;
  try {
    await symlink(root, junction, "junction");
    assert.throws(() => native.openSourceFile(join(junction, "moved.jsonl")));
  } finally { await rm(junction, { force: true }); }
}));

function syntheticTimingRecords() {
  const at = 1789200000000;
  return [
    { type: "session_meta", payload: { id: "synthetic-session" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "synthetic-turn" } },
    { type: "turn_context", payload: { turn_id: "synthetic-turn", model: "gpt-5.6-sol" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "synthetic-turn",
      duration_ms: 2_000, time_to_first_token_ms: 200 } },
  ].map((record, index) => ({
    ...record, timestamp: new Date(at + index * 1_000).toISOString(),
  }));
}

test("native timing fixture qualifies a 200 ms TTFT with a valid task boundary", () => {
  const parse = (records) => {
    const turns = [];
    const parser = createParser(Buffer.alloc(32, 7), null, (turn) => turns.push(turn));
    records.forEach((record, index) => (
      parser.line(Buffer.from(JSON.stringify(record)), index + 1, false)
    ));
    assert.equal(turns.length, 1);
    return turns[0];
  };
  const qualified = parse(syntheticTimingRecords());
  assert.equal(qualified.ttft, 200);
  assert.equal(qualified.duration, null, "TTFT does not manufacture generation timing");
  const missingDuration = syntheticTimingRecords();
  delete missingDuration.at(-1).payload.duration_ms;
  const unqualified = parse(missingDuration);
  assert.equal(unqualified.ttft, null);
  assert.equal(unqualified.quality, "invalid_boundary");
});

test("native timing SQLite retains guarded journal, reconstructs TTFT and reopens without duplication", {
  skip: NATIVE_SKIP,
}, () => withSyntheticRoot(async ({ adapter, root }) => {
  adapter.ensureDirectory(root);
  const native = loadWindowsFilesystemBinding();
  // Explicit qualification injection does not change production policy.
  const filesystem = createTimingFilesystem({ platform: "win32", loadWindowsBinding: () => native });
  const options = { createParser, digest, METHOD, MAX_STATE_BYTES, filesystem };
  const source = join(root, "synthetic.jsonl"), dir = join(root, "timing");
  await writeSyntheticOwnedSource(source,
    syntheticTimingRecords().map((record) => JSON.stringify(record)).join("\n") + "\n");
  let store = await openTimingStore(dir, options);
  try {
    await ingestTimingFile(store, source);
    assert.equal(readTimingRows(store)[0].ttft, 200);
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "persist");
    await assert.rejects(rename(store.file, `${store.file}.moved`));
    await assert.rejects(rename(`${store.file}-journal`, `${store.file}-journal.moved`));
    store.close();
    store = await openTimingStore(dir, options);
    assert.equal((await ingestTimingFile(store, source)).unchanged, true);
    assert.equal(readTimingRows(store).length, 1);
    store.close();
    const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createTimingFilesystem } from './src/platform/inference-timing-filesystem.js';
      import { loadWindowsFilesystemBinding } from './src/platform/windows-filesystem.js';
      import { openTimingStore } from './src/platform/inference-timing-store.js';
      import { createParser, digest, METHOD, MAX_STATE_BYTES } from './src/providers/codex/logs.js';
      const filesystem = createTimingFilesystem({ platform: 'win32', loadWindowsBinding: loadWindowsFilesystemBinding });
      const store = await openTimingStore(process.argv[1], { createParser, digest, METHOD, MAX_STATE_BYTES, filesystem });
      store.db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE; CREATE TABLE uncommitted(x BLOB); INSERT INTO uncommitted VALUES(zeroblob(1048576));');
      process.exit(0);
    `, dir], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(crash.status, 0, 'synthetic crash writer completed');
    store = await openTimingStore(dir, options);
    assert.equal(readTimingRows(store).length, 1, 'hot journal recovery preserves committed timing');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='uncommitted'").get().n, 0);
  } finally { store.close(); }
}));
