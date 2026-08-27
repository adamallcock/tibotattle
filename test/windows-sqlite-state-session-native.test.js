import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWindowsFilesystemAdapter,
  isWindowsFilesystemNotFound,
} from "../src/platform/windows-filesystem.js";
import { classifyWindowsSqliteError } from "../scripts/windows-security-qualification.mjs";
import {
  WINDOWS_SQLITE_STATE_FIXTURE_TABLE,
} from "./fixtures/windows-sqlite-state-session-values.mjs";

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";
const requireNative = createRequire(import.meta.url);
const CHILD_FIXTURE = fileURLToPath(new URL(
  "./fixtures/windows-sqlite-state-session-child.mjs",
  import.meta.url,
));
const QUALIFICATION_BINDING_ENVIRONMENT =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH";
const QUALIFICATION_BINDING_FILE = "windows_filesystem_qualification.node";
const DATABASE_NAME = "sqlite-state-session-native.sqlite";
const SAME_PROCESS_DATABASE_NAME = "sqlite-state-session-native-same-process.sqlite";
const RELEASE_FAILURE_DATABASE_NAME = "sqlite-state-session-native-release-failure.sqlite";
const TABLE_NAME = WINDOWS_SQLITE_STATE_FIXTURE_TABLE;
const SIDECAR_BLOCKED_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "EPERM"]);

function qualificationBindingPath() {
  const configured = process.env[QUALIFICATION_BINDING_ENVIRONMENT];
  if (typeof configured !== "string"
      || !win32.isAbsolute(configured)
      || win32.basename(configured).toLowerCase()
        !== QUALIFICATION_BINDING_FILE.toLowerCase()) {
    throw new Error("WINDOWS_SQLITE_QUALIFICATION_BINDING_PATH_INVALID");
  }
  return configured;
}

function loadQualificationBinding(bindingPath) {
  let binding;
  try {
    binding = requireNative(bindingPath);
  } catch {
    throw new Error("WINDOWS_SQLITE_QUALIFICATION_BINDING_UNAVAILABLE");
  }
  const required = [
    "ensureDirectory",
    "inspectPath",
    "inspectProtectedChild",
    "acquireSqliteStateLease",
    "releaseSqliteStateLease",
    "armSqliteStateLeaseReleaseFailure",
  ];
  if (binding === null
      || typeof binding !== "object"
      || required.some((method) => typeof binding[method] !== "function")
      || binding.contractVersion !== "windows-filesystem-v1"
      || binding.sqliteStateLeaseContractVersion
        !== "windows-sqlite-state-lease-v1") {
    throw new Error("WINDOWS_SQLITE_QUALIFICATION_BINDING_INVALID");
  }
  return binding;
}

function nativeFailure(code) {
  return (error) => error?.code === code
    && error?.message === "Windows filesystem operation failed";
}

function assertMissingChild(adapter, root, rootIdentity, childName) {
  assert.throws(
    () => adapter.inspectProtectedChild(root, rootIdentity, childName),
    (error) => error?.message === "Windows filesystem operation failed"
      && isWindowsFilesystemNotFound(error),
  );
}

function assertNoWalOrSharedMemory(adapter, root, rootIdentity, databaseName) {
  assertMissingChild(adapter, root, rootIdentity, `${databaseName}-wal`);
  assertMissingChild(adapter, root, rootIdentity, `${databaseName}-shm`);
}

async function assertEventuallyNoWalOrSharedMemory(
  adapter,
  root,
  rootIdentity,
  databaseName,
  { timeoutMs = 2_000, intervalMs = 25 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertNoWalOrSharedMemory(adapter, root, rootIdentity, databaseName);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

function assertSidecarsReserved(root, databaseName) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = join(root, `${databaseName}${suffix}`);
    let descriptor;
    try {
      descriptor = openSync(sidecarPath, "wx");
    } catch (error) {
      assert.equal(SIDECAR_BLOCKED_CODES.has(error?.code), true);
      continue;
    }
    try {
      assert.fail("WINDOWS_SQLITE_SIDECAR_RESERVATION_MISSING");
    } finally {
      closeSync(descriptor);
      unlinkSync(sidecarPath);
    }
  }
}

function readPragma(database, name) {
  const row = database.prepare(`PRAGMA ${name};`).get();
  assert.ok(row !== null && typeof row === "object");
  const values = Object.values(row);
  assert.equal(values.length, 1);
  return values[0];
}

function configureDurableDatabase(database) {
  assert.equal(typeof database.enableDefensive, "function");
  database.enableDefensive(true);
  const journalMode = database.prepare("PRAGMA journal_mode=PERSIST;").get();
  assert.equal(
    String(journalMode?.journal_mode ?? "").toLowerCase(),
    "persist",
  );
  database.exec("PRAGMA synchronous=FULL;");
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec("PRAGMA trusted_schema=OFF;");
  database.exec("PRAGMA temp_store=MEMORY;");
  database.exec("PRAGMA mmap_size=0;");
  assert.equal(String(readPragma(database, "journal_mode")).toLowerCase(), "persist");
  assert.equal(Number(readPragma(database, "synchronous")), 2);
  assert.equal(Number(readPragma(database, "foreign_keys")), 1);
  assert.equal(Number(readPragma(database, "trusted_schema")), 0);
  assert.equal(Number(readPragma(database, "temp_store")), 2);
  assert.equal(Number(readPragma(database, "mmap_size")), 0);
}

function emitSqliteErrorDiagnostic(testContext, error) {
  // This marker is emitted only by the Windows qualification child. The
  // classifier reads Node's numeric errcode property and returns a fixed
  // category; no SQLite message, SQL, path, filename, errno, or raw object is
  // ever passed to the test diagnostic stream.
  if (process.env.USAGE_MONITOR_WINDOWS_QUALIFICATION !== "1") return;
  testContext.diagnostic(
    `windowsSqliteErrorCategory: ${classifyWindowsSqliteError(error)}`,
  );
}

function assertDatabaseLocation(database, expectedPath) {
  assert.equal(typeof database.location, "function");
  const actualPath = database.location("main");
  assert.equal(
    win32.normalize(actualPath).toLowerCase(),
    win32.normalize(expectedPath).toLowerCase(),
  );
}

function openLeasedDatabase({ adapter, root, rootIdentity, databaseName }) {
  const lease = adapter.acquireSqliteStateLease(root, rootIdentity, databaseName);
  const databasePath = join(root, databaseName);
  let database;
  try {
    database = new DatabaseSync(databasePath, { timeout: 5_000 });
    assertDatabaseLocation(database, databasePath);
    configureDurableDatabase(database);
    const databaseMetadata = adapter.inspectProtectedChild(root, rootIdentity, databaseName);
    const journalMetadata = adapter.inspectProtectedChild(
      root,
      rootIdentity,
      `${databaseName}-journal`,
    );
    assert.deepEqual(databaseMetadata.identity, lease.databaseIdentity);
    assert.deepEqual(journalMetadata.identity, lease.journalIdentity);
    assertSidecarsReserved(root, databaseName);
    return { database, lease, databasePath };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the fixed assertion or native failure above.
    }
    try {
      adapter.releaseSqliteStateLease(lease);
    } catch {
      // Preserve the fixed assertion or native failure above.
    }
    throw error;
  }
}

function startChild({ mode, bindingPath, root, rootIdentity, databaseName }) {
  const child = spawn(process.execPath, [
    CHILD_FIXTURE,
    mode,
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
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", () => rejectExit(new Error("WINDOWS_SQLITE_CHILD_SPAWN_FAILED")));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
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
    const timer = setTimeout(async () => {
      timingOut = true;
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exit;
      } catch {
        // The fixed timeout status remains authoritative.
      }
      finish(rejectMarker, new Error("WINDOWS_SQLITE_CHILD_TIMEOUT"));
    }, 15_000);
    const check = () => {
      if (output.includes(expected)) finish(resolveMarker, undefined);
      else if (output.includes("WINDOWS_SQLITE_STATE_CHILD_FAILED\n")) {
        finish(rejectMarker, new Error("WINDOWS_SQLITE_CHILD_FAILED"));
      }
    };
    child.stdout.on("data", check);
    child.once("exit", () => {
      if (!timingOut) {
        finish(rejectMarker, new Error("WINDOWS_SQLITE_CHILD_EXITED_EARLY"));
      }
    });
    check();
  });
  return { child, exit, marker, output: () => output };
}

async function withNativeRoot(run) {
  const bindingPath = qualificationBindingPath();
  const binding = loadQualificationBinding(bindingPath);
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    binding,
  });
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-windows-sqlite-native-"));
  const root = join(parent, "private state Ω");
  try {
    const rootIdentity = adapter.ensureDirectory(root);
    return await run({ adapter, binding, bindingPath, root, rootIdentity });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("native Windows SQLite session qualifies durable recovery and lease contention", {
  skip: NATIVE_SKIP,
}, async (testContext) => withNativeRoot(async ({ adapter, bindingPath, root, rootIdentity }) => {
  // Same-process contention must be rejected before a second SQLite writer can
  // open the identity-bound database.
  const sameProcessLease = adapter.acquireSqliteStateLease(
    root,
    rootIdentity,
    SAME_PROCESS_DATABASE_NAME,
  );
  try {
    assert.throws(
      () => adapter.acquireSqliteStateLease(
        root,
        rootIdentity,
        SAME_PROCESS_DATABASE_NAME,
      ),
      nativeFailure("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_CONTENDED"),
    );
  } finally {
    adapter.releaseSqliteStateLease(sameProcessLease);
  }

  // Keep the cross-process child on the untouched database name.  Its lease
  // must create and then open the DB/journal from a genuinely fresh root;
  // using the same name for the preceding same-process check would
  // pre-materialize those files and mask fresh-file handle sharing.
  const holdingChild = startChild({
    mode: "hold",
    bindingPath,
    root,
    rootIdentity,
    databaseName: DATABASE_NAME,
  });
  try {
    await holdingChild.marker("WINDOWS_SQLITE_STATE_CHILD_READY\n");
    assert.throws(
      () => adapter.acquireSqliteStateLease(root, rootIdentity, DATABASE_NAME),
      nativeFailure("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_CONTENDED"),
    );
  } finally {
    if (holdingChild.child.exitCode === null) holdingChild.child.stdin.end("release\n");
    await holdingChild.exit;
  }
  assert.equal(holdingChild.child.exitCode, 0);
  assert.equal(holdingChild.output(),
    "WINDOWS_SQLITE_STATE_CHILD_READY\nWINDOWS_SQLITE_STATE_CHILD_RELEASED\n");
  await assertEventuallyNoWalOrSharedMemory(adapter, root, rootIdentity, DATABASE_NAME);

  const first = openLeasedDatabase({
    adapter,
    root,
    rootIdentity,
    databaseName: DATABASE_NAME,
  });
  try {
    const { database } = first;
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);`);
    } catch (error) {
      emitSqliteErrorDiagnostic(testContext, error);
      throw error;
    }
    database.exec("BEGIN IMMEDIATE;");
    database.prepare(`INSERT INTO ${TABLE_NAME}(marker) VALUES ('committed-marker');`).run();
    database.exec("COMMIT;");
    database.exec("BEGIN IMMEDIATE;");
    database.prepare(`INSERT INTO ${TABLE_NAME}(marker) VALUES ('rolled-back-marker');`).run();
    database.exec("ROLLBACK;");
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAME};`).get().count, 1);
    assertSidecarsReserved(root, DATABASE_NAME);
  } finally {
    first.database.close();
    adapter.releaseSqliteStateLease(first.lease);
  }
  await assertEventuallyNoWalOrSharedMemory(adapter, root, rootIdentity, DATABASE_NAME);

  const reopened = openLeasedDatabase({
    adapter,
    root,
    rootIdentity,
    databaseName: DATABASE_NAME,
  });
  try {
    assert.equal(
      reopened.database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAME};`).get().count,
      1,
    );
    assertSidecarsReserved(root, DATABASE_NAME);
  } finally {
    reopened.database.close();
    adapter.releaseSqliteStateLease(reopened.lease);
  }
  await assertEventuallyNoWalOrSharedMemory(adapter, root, rootIdentity, DATABASE_NAME);

  const crashChild = startChild({
    mode: "crash",
    bindingPath,
    root,
    rootIdentity,
    databaseName: DATABASE_NAME,
  });
  await crashChild.marker("WINDOWS_SQLITE_STATE_CHILD_PREPARED\n");
  const crashResult = await crashChild.exit;
  assert.equal(crashResult.code, 17);
  assert.equal(crashResult.signal, null);
  assert.equal(crashChild.output(), "WINDOWS_SQLITE_STATE_CHILD_PREPARED\n");

  // The abrupt child leaves a hot persistent rollback journal. The native
  // inspection is used instead of ordinary Node filesystem access so the
  // diagnostic remains inside the same protected root boundary.
  const crashJournal = adapter.inspectProtectedChild(
    root,
    rootIdentity,
    `${DATABASE_NAME}-journal`,
  );
  assert.equal(crashJournal.isRegularFile, true);
  assert.equal(crashJournal.isReparsePoint, false);
  assert.equal(crashJournal.ownerMatches, true);
  assert.equal(crashJournal.broadAccess, false);
  await assertEventuallyNoWalOrSharedMemory(adapter, root, rootIdentity, DATABASE_NAME);

  const recovered = openLeasedDatabase({
    adapter,
    root,
    rootIdentity,
    databaseName: DATABASE_NAME,
  });
  try {
    assert.equal(
      recovered.database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAME};`).get().count,
      1,
    );
    assertSidecarsReserved(root, DATABASE_NAME);
  } finally {
    recovered.database.close();
    adapter.releaseSqliteStateLease(recovered.lease);
  }
  await assertEventuallyNoWalOrSharedMemory(adapter, root, rootIdentity, DATABASE_NAME);
}));

test("native Windows SQLite release failure retains the opaque token for one retry", {
  skip: NATIVE_SKIP,
}, async () => withNativeRoot(async ({ adapter, binding, root, rootIdentity }) => {
  const lease = adapter.acquireSqliteStateLease(
    root,
    rootIdentity,
    RELEASE_FAILURE_DATABASE_NAME,
  );
  let database;
  let released = false;
  try {
    const databasePath = join(root, RELEASE_FAILURE_DATABASE_NAME);
    database = new DatabaseSync(databasePath, { timeout: 5_000 });
    assertDatabaseLocation(database, databasePath);
    configureDurableDatabase(database);
    assertSidecarsReserved(root, RELEASE_FAILURE_DATABASE_NAME);

    // The JS owner closes SQLite before asking native release to clean up its
    // sidecar reservations. The qualification-only seam fails after native
    // sidecar mark/close and absence proof, leaving the same adapter lease
    // token valid for the retry below.
    database.close();
    database = null;
    assert.equal(binding.armSqliteStateLeaseReleaseFailure(), true);
    assert.throws(
      () => adapter.releaseSqliteStateLease(lease),
      nativeFailure("WINDOWS_FILESYSTEM_SQLITE_STATE_LEASE_RELEASE_FAILED"),
    );
    await assertEventuallyNoWalOrSharedMemory(
      adapter,
      root,
      rootIdentity,
      RELEASE_FAILURE_DATABASE_NAME,
    );

    // Passing the original opaque adapter lease proves the WeakMap entry was
    // retained when native release failed. A fresh lease also proves the
    // second release completed ordinary-handle/mutex cleanup and registry
    // unregistration.
    assert.doesNotThrow(() => adapter.releaseSqliteStateLease(lease));
    released = true;
    await assertEventuallyNoWalOrSharedMemory(
      adapter,
      root,
      rootIdentity,
      RELEASE_FAILURE_DATABASE_NAME,
    );

    const reopened = openLeasedDatabase({
      adapter,
      root,
      rootIdentity,
      databaseName: RELEASE_FAILURE_DATABASE_NAME,
    });
    try {
      assertDatabaseLocation(reopened.database, databasePath);
    } finally {
      reopened.database.close();
      adapter.releaseSqliteStateLease(reopened.lease);
    }
    await assertEventuallyNoWalOrSharedMemory(
      adapter,
      root,
      rootIdentity,
      RELEASE_FAILURE_DATABASE_NAME,
    );
  } finally {
    try {
      database?.close();
    } catch {
      // Preserve the primary native qualification assertion.
    }
    if (!released) {
      try {
        adapter.releaseSqliteStateLease(lease);
      } catch {
        // Preserve the primary native qualification assertion.
      }
    }
  }
}));

test("native Windows SQLite qualification fails closed without its bound addon", {
  skip: NATIVE_SKIP,
}, () => {
  assert.throws(
    () => loadQualificationBinding("C:\\missing\\windows_filesystem_qualification.node"),
    /WINDOWS_SQLITE_QUALIFICATION_BINDING_UNAVAILABLE|WINDOWS_SQLITE_QUALIFICATION_BINDING_INVALID/u,
  );
});
