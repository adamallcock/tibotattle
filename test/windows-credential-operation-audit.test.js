import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS,
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_PENDING_ROWS,
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_TERMINAL_ROWS,
  WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION,
  WindowsCredentialOperationAuditError,
  configureDatabase,
  createWindowsCredentialOperationAuditStore,
  defaultWindowsCredentialOperationAuditFile,
  isWindowsCredentialOperationAuditError,
  isWindowsCredentialOperationAuditStore,
} from "../src/platform/windows-credential-operation-audit.js";
import { createWindowsCredentialAuditFileGuardContext } from "../src/platform/windows-credential-audit-file-guard.js";
import { loadWindowsFilesystemBinding } from "../src/platform/windows-filesystem.js";

const PAIR = WINDOWS_CREDENTIAL_OPERATION_AUDIT_CAPABILITY_PAIRS[0];
const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";

async function nativeProtectedAuditRoot(prefix) {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const root = join(parent, "protected-state");
  loadWindowsFilesystemBinding().ensureDirectory(root);
  return { parent, root };
}

function leaseId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function operation(store, index, result = "created") {
  const id = leaseId(index);
  store.prepare({
    leaseId: id,
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "create",
    at: index,
  });
  return store.settle({ leaseId: id, result, at: index + 100 });
}

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-"));
  const filePath = join(root, "private", "windows-credential-operation-audit-v1.sqlite");
  const store = createWindowsCredentialOperationAuditStore({
    filePath,
    clock: () => 999,
  });
  try {
    return await run({ root, filePath, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function auditError(code) {
  return (error) => {
    assert.equal(error instanceof WindowsCredentialOperationAuditError, true);
    assert.equal(isWindowsCredentialOperationAuditError(error), true);
    assert.equal(error.code, `windows_credential_operation_audit_${code}`);
    assert.equal(error.message, "Windows credential operation audit store failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("default Windows audit path is fixed beneath the private state root", () => {
  assert.equal(
    defaultWindowsCredentialOperationAuditFile({
      platform: "win32",
      homeDirectory: "C:\\Users\\Ada",
      environment: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
    }),
    "C:\\Users\\Ada\\AppData\\Local\\app-usagemonitor\\private\\windows-credential-operation-audit-v1.sqlite",
  );
  assert.equal(
    defaultWindowsCredentialOperationAuditFile({
      platform: "linux",
      homeDirectory: "/home/ada",
      environment: { XDG_STATE_HOME: "/home/ada/.state" },
    }),
    "/home/ada/.state/app-usagemonitor/private/windows-credential-operation-audit-v1.sqlite",
  );
});

test("audit store is branded and creates a fixed SQLite schema", async () => withStore(async ({ filePath, store }) => {
  assert.equal(isWindowsCredentialOperationAuditStore(store), true);
  assert.equal(isWindowsCredentialOperationAuditStore({
    read() { return []; },
  }), false);
  assert.equal(store.filePath, filePath);
  assert.equal(store.closed, false);
  assert.equal(store.filesystemProtected, false);
  const bytes = await readFile(filePath);
  assert.ok(bytes.byteLength > 0);
  const text = bytes.toString("utf8");
  for (const forbidden of [filePath, "app-usagemonitor.", "installation", "DO-NOT-LEAK"]) {
    assert.equal(text.includes(forbidden), false);
  }
  assert.equal(WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION, "windows-credential-operation-audit-v1");
}));

test("audit database configures and verifies the durable SQLite restrictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-pragmas-"));
  const filePath = join(root, "audit.sqlite");
  const database = new DatabaseSync(filePath);
  try {
    configureDatabase(database);
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "persist");
    assert.equal(Number(database.prepare("PRAGMA synchronous").get().synchronous), 2);
    assert.equal(Number(database.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    assert.equal(Number(database.prepare("PRAGMA trusted_schema").get().trusted_schema), 0);
    assert.equal(Number(database.prepare("PRAGMA temp_store").get().temp_store), 2);
    assert.equal(Number(database.prepare("PRAGMA mmap_size").get().mmap_size), 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("audit database fails closed when SQLite refuses the requested journal mode", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.throws(
      () => configureDatabase(database),
      auditError("journal_mode_refused"),
    );
  } finally {
    database.close();
  }
});

test("prepare and settle persist only fixed, content-free operation metadata", async () => withStore(async ({ filePath, store }) => {
  const prepared = store.prepare({
    leaseId: leaseId(1),
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "replace",
    at: 10,
  });
  assert.deepEqual(prepared, {
    version: WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION,
    sequence: 1,
    leaseId: leaseId(1),
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "replace",
    phase: "prepared",
    result: null,
    failureClass: null,
    preparedAt: 10,
    settledAt: null,
    recoveredAt: null,
    recoveryClass: null,
  });
  assert.deepEqual(store.readPending(), [prepared]);
  const settled = store.settle({
    leaseId: leaseId(1),
    result: "replaced",
    at: 20,
  });
  assert.equal(settled.phase, "settled");
  assert.equal(settled.result, "replaced");
  assert.equal(settled.settledAt, 20);
  assert.deepEqual(store.readPending(), []);
  const serialized = JSON.stringify(store.read());
  for (const forbidden of [filePath, "DO-NOT-LEAK", "app-usagemonitor.", "installation"]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  store.close();
  const reopened = createWindowsCredentialOperationAuditStore({ filePath, clock: () => 999 });
  try {
    assert.deepEqual(reopened.read(), [settled]);
  } finally {
    reopened.close();
  }
}));

test("audit store settles native failure with only an allowlisted failure class", async () => withStore(async ({ store }) => {
  store.prepare({
    leaseId: leaseId(2),
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "delete",
  });
  const settled = store.settle({
    leaseId: leaseId(2),
    result: "failed",
    failureClass: "readback_mismatch",
  });
  assert.equal(settled.result, "failed");
  assert.equal(settled.failureClass, "readback_mismatch");
  assert.throws(
    () => store.settle({ leaseId: leaseId(2), result: "failed", failureClass: "DO-NOT-LEAK" }),
    auditError("invalid_record"),
  );
}));

test("audit store recovers an in-flight operation conservatively", async () => withStore(async ({ store }) => {
  store.prepare({
    leaseId: leaseId(3),
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "replace",
    at: 30,
  });
  const recovered = store.recover({
    leaseId: leaseId(3),
    recoveryClass: "unknown_after_crash",
    at: 40,
  });
  assert.deepEqual(recovered, {
    version: WINDOWS_CREDENTIAL_OPERATION_AUDIT_SCHEMA_VERSION,
    sequence: 1,
    leaseId: leaseId(3),
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "replace",
    phase: "recovered",
    result: null,
    failureClass: null,
    preparedAt: 30,
    settledAt: null,
    recoveredAt: 40,
    recoveryClass: "unknown_after_crash",
  });
  assert.deepEqual(store.readPending(), []);
  assert.throws(
    () => store.settle({ leaseId: leaseId(3), result: "replaced" }),
    auditError("invalid_transition"),
  );
}));

test("audit store enforces one-way transitions and pending bounds", async () => withStore(async ({ store }) => {
  const first = leaseId(4);
  store.prepare({
    leaseId: first,
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "create",
  });
  assert.throws(
    () => store.prepare({
      leaseId: first,
      owner: PAIR.owner,
      capability: PAIR.capability,
      operation: "create",
    }),
    auditError("duplicate"),
  );
  assert.throws(
    () => store.settle({ leaseId: leaseId(99), result: "created" }),
    auditError("missing"),
  );
  for (let index = 5; index < 5 + WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_PENDING_ROWS - 1; index += 1) {
    store.prepare({
      leaseId: leaseId(index),
      owner: PAIR.owner,
      capability: PAIR.capability,
      operation: "create",
    });
  }
  assert.equal(store.readPending().length, WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_PENDING_ROWS);
  assert.throws(
    () => store.prepare({
      leaseId: leaseId(99),
      owner: PAIR.owner,
      capability: PAIR.capability,
      operation: "create",
    }),
    auditError("pending_limit"),
  );
}));

test("audit store retains only the bounded terminal window and never prunes pending rows", async () => withStore(async ({ store }) => {
  for (let index = 100; index < 100 + WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_TERMINAL_ROWS + 7; index += 1) {
    operation(store, index);
  }
  const retained = store.read();
  assert.equal(retained.length, WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_TERMINAL_ROWS);
  assert.equal(retained[0].leaseId, leaseId(107));
  const pendingId = leaseId(999);
  store.prepare({
    leaseId: pendingId,
    owner: PAIR.owner,
    capability: PAIR.capability,
    operation: "delete",
  });
  for (let index = 1_000; index < 1_000 + 8; index += 1) operation(store, index);
  assert.equal(store.readPending().length, 1);
  assert.equal(store.read().some((row) => row.leaseId === pendingId), true);
  assert.equal(store.read().filter((row) => row.phase !== "prepared").length, WINDOWS_CREDENTIAL_OPERATION_AUDIT_MAXIMUM_TERMINAL_ROWS);
}));

test("audit store rejects malformed or tampered files with fixed errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-invalid-"));
  const filePath = join(root, "audit.sqlite");
  try {
    await writeFile(filePath, Buffer.from("not-a-sqlite-database"));
    await chmod(filePath, 0o600);
    assert.throws(
      () => createWindowsCredentialOperationAuditStore({ filePath }),
      auditError("schema_invalid"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit store rejects marker-compatible v1 schema without the composite capability check", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-legacy-v1-"));
  const filePath = join(root, "windows-credential-operation-audit-v1.sqlite");
  const database = new DatabaseSync(filePath);
  try {
    database.exec(`
      PRAGMA application_id=1430470997;
      PRAGMA user_version=1;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value)
        VALUES ('schema_version', 'windows-credential-operation-audit-v1');
      CREATE TABLE credential_operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        lease_id TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        capability TEXT NOT NULL,
        operation TEXT NOT NULL,
        phase TEXT NOT NULL,
        result TEXT,
        failure_class TEXT,
        prepared_at INTEGER NOT NULL,
        settled_at INTEGER,
        recovered_at INTEGER,
        recovery_class TEXT
      ) STRICT;
    `);
  } finally {
    database.close();
  }
  await chmod(filePath, 0o600);
  try {
    assert.throws(
      () => createWindowsCredentialOperationAuditStore({ filePath }),
      auditError("schema_invalid"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit store rejects future application and user schema markers without rewriting", async () => {
  for (const [marker, value] of [
    ["application_id", 1430470998],
    ["user_version", 2],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `tibotattle-windows-audit-${marker}-`));
    const filePath = join(root, "windows-credential-operation-audit-v1.sqlite");
    const store = createWindowsCredentialOperationAuditStore({ filePath });
    store.close();
    const database = new DatabaseSync(filePath);
    try {
      database.exec(`PRAGMA ${marker}=${value}`);
    } finally {
      database.close();
    }
    await chmod(filePath, 0o600);
    try {
      const before = await readFile(filePath);
      assert.throws(
        () => createWindowsCredentialOperationAuditStore({ filePath }),
        auditError("schema_invalid"),
      );
      assert.deepEqual(await readFile(filePath), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("audit store rejects a symlinked state boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-link-"));
  const target = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-target-"));
  const alias = join(root, "state-alias");
  try {
    await symlink(target, alias, "dir");
    assert.throws(
      () => createWindowsCredentialOperationAuditStore({
        filePath: join(alias, "private", "windows-credential-operation-audit-v1.sqlite"),
      }),
      auditError("unavailable"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("audit store rejects invalid records without exposing caller content", async () => withStore(async ({ store }) => {
  const canary = "DO-NOT-LEAK-audit-input";
  const cases = [
    { leaseId: canary, owner: PAIR.owner, capability: PAIR.capability, operation: "create" },
    { leaseId: leaseId(7), owner: "untrusted-owner", capability: PAIR.capability, operation: "create" },
    { leaseId: leaseId(8), owner: PAIR.owner, capability: PAIR.capability, operation: "unknown" },
  ];
  for (const value of cases) {
    assert.throws(
      () => store.prepare(value),
      (error) => {
        auditError("invalid_record")(error);
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(canary), false);
        return true;
      },
    );
  }
  assert.throws(() => store.read().push({}), TypeError);
}));

test("audit store close is idempotent and branded operations fail after close", async () => withStore(async ({ store }) => {
  store.close();
  store.close();
  assert.equal(store.closed, true);
  assert.throws(() => store.read(), auditError("closed"));
  assert.throws(() => store.prepare({}), auditError("closed"));
}));

test("audit store retains an open SQLite connection after close failure for a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-audit-close-failure-"));
  const filePath = join(root, "audit.sqlite");
  const originalClose = DatabaseSync.prototype.close;
  let closeAttempts = 0;
  DatabaseSync.prototype.close = function injectedCloseFailure() {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("DO-NOT-LEAK-close-failure");
    return originalClose.call(this);
  };
  let store;
  try {
    store = createWindowsCredentialOperationAuditStore({ filePath });
    assert.throws(() => store.close(), auditError("unavailable"));
    assert.equal(store.closed, false);
    assert.throws(() => store.read(), auditError("closed"));
    store.close();
    assert.equal(store.closed, true);
    assert.equal(closeAttempts, 2);
  } finally {
    DatabaseSync.prototype.close = originalClose;
    if (store !== undefined && !store.closed) {
      try {
        store.close();
      } catch {
        // Preserve the primary assertion failure while restoring the fixture.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("guarded audit close closes SQLite before releasing the native identity guard", {
  skip: NATIVE_SKIP,
}, async () => {
  const { parent, root } = await nativeProtectedAuditRoot(
    "tibotattle-windows-audit-guarded-",
  );
  const filePath = join(root, "private", "windows-credential-operation-audit-v1.sqlite");
  const movedPath = `${filePath}.moved`;
  const guardContext = createWindowsCredentialAuditFileGuardContext();
  const store = createWindowsCredentialOperationAuditStore({
    filePath,
    fileGuardContext: guardContext,
  });
  try {
    store.prepare({
      leaseId: leaseId(77),
      owner: PAIR.owner,
      capability: PAIR.capability,
      operation: "create",
    });
    // The guard remains active while SQLite is open, so path replacement is
    // denied. close() must close SQLite first and release the guard second.
    await assert.rejects(rename(filePath, movedPath));
    store.close();
    await rename(filePath, movedPath);
    await rename(movedPath, filePath);
  } finally {
    store.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("guarded audit close retains the guard when native release fails", {
  skip: NATIVE_SKIP,
}, async () => {
  const { parent, root } = await nativeProtectedAuditRoot(
    "tibotattle-windows-audit-release-failure-",
  );
  const filePath = join(root, "private", "windows-credential-operation-audit-v1.sqlite");
  const journalPath = `${filePath}-journal`;
  const movedPath = `${filePath}.moved`;
  const native = loadWindowsFilesystemBinding();
  const capturedGuards = [];
  let releaseAttempts = 0;
  const binding = {
    ...native,
    acquireCredentialAuditFileGuard(path) {
      const result = native.acquireCredentialAuditFileGuard(path);
      capturedGuards.push(result.guard);
      return result;
    },
    releaseCredentialAuditFileGuard() {
      releaseAttempts += 1;
      throw new Error("DO-NOT-LEAK-release-failure");
    },
  };
  const guardContext = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const store = createWindowsCredentialOperationAuditStore({
    filePath,
    fileGuardContext: guardContext,
  });
  try {
    assert.throws(() => store.close(), auditError("unavailable"));
    assert.equal(store.closed, false);
    assert.equal(releaseAttempts, 2);
    await assert.rejects(rename(filePath, movedPath));
    await assert.rejects(rename(journalPath, `${journalPath}.moved`));
    assert.throws(() => store.close(), auditError("unavailable"));
  } finally {
    try {
      store.close();
    } catch {
      // The context intentionally marks a failed release lease as foreign.
    }
    for (const guard of [...capturedGuards].reverse()) {
      try {
        native.releaseCredentialAuditFileGuard(guard);
      } catch {
        // A guard may have been released by a partially successful context.
      }
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test("guarded corrupt-database cleanup retains the native guard when SQLite close fails", {
  skip: NATIVE_SKIP,
}, async () => {
  const { parent, root } = await nativeProtectedAuditRoot(
    "tibotattle-windows-audit-corrupt-",
  );
  const privateRoot = join(root, "private");
  const filePath = join(privateRoot, "windows-credential-operation-audit-v1.sqlite");
  const movedPath = `${filePath}.moved`;
  const native = loadWindowsFilesystemBinding();
  native.ensureDirectory(privateRoot);
  // A Node-created child is not guaranteed to inherit the reviewed owner-only
  // DACL from this non-inheriting directory. Create the corrupt fixture
  // through the same native primitive that the audit guard validates.
  native.createFile(filePath, Buffer.from("DO-NOT-LEAK-corrupt-sqlite"));
  const capturedGuards = [];
  let releaseAttempts = 0;
  const binding = {
    ...native,
    acquireCredentialAuditFileGuard(path) {
      const result = native.acquireCredentialAuditFileGuard(path);
      capturedGuards.push(result.guard);
      return result;
    },
    releaseCredentialAuditFileGuard(guard) {
      releaseAttempts += 1;
      return native.releaseCredentialAuditFileGuard(guard);
    },
  };
  const guardContext = createWindowsCredentialAuditFileGuardContext({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const originalClose = DatabaseSync.prototype.close;
  let failedDatabase;
  DatabaseSync.prototype.close = function injectedCloseFailure() {
    failedDatabase = this;
    throw new Error("DO-NOT-LEAK-corrupt-close-failure");
  };
  try {
    assert.throws(
      () => createWindowsCredentialOperationAuditStore({
        filePath,
        fileGuardContext: guardContext,
      }),
      auditError("schema_invalid"),
    );
    assert.equal(releaseAttempts, 0);
    await assert.rejects(rename(filePath, movedPath));
  } finally {
    DatabaseSync.prototype.close = originalClose;
    if (failedDatabase !== undefined) {
      try {
        originalClose.call(failedDatabase);
      } catch {
        // The injected close failure is already covered by the assertion.
      }
    }
    for (const guard of [...capturedGuards].reverse()) {
      try {
        native.releaseCredentialAuditFileGuard(guard);
      } catch {
        // A guard may have been released by an earlier implementation.
      }
    }
    await rm(parent, { recursive: true, force: true });
  }
});
