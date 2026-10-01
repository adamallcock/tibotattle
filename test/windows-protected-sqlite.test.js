import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import * as platformPath from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  acquireProtectedSqliteFiles,
  configureGuardedSqliteConnection,
  isWindowsProtectedSqliteError,
} from "../src/platform/windows-protected-sqlite.js";

const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001", fileId: "00000000000000000000000000000002", linkCount: 1,
});

function fixture() {
  const guards = new Set();
  const released = [];
  const native = {
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialAuditFileGuardSafe: true,
    ensureDirectory() {},
    createFile() {},
    acquireCredentialAuditFileGuard(path) {
      const guard = { path };
      guards.add(guard);
      return { guard, identity: IDENTITY };
    },
    releaseCredentialAuditFileGuard(guard) { released.push(guard.path); guards.delete(guard); },
  };
  return { native, guards, released };
}

function fixedError(code) {
  return error => {
    assert.equal(isWindowsProtectedSqliteError(error), true);
    assert.equal(error.code, code);
    assert.equal(error.message, "Windows protected SQLite operation failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}

test("shared SQLite guards distinguish existing database and release all handles once", () => {
  const { native, guards, released } = fixture();
  native.createFile = path => { if (!path.endsWith("-journal")) throw { code: "EEXIST" }; };
  const lease = acquireProtectedSqliteFiles({ native, path: "/private/store.sqlite", pathApi: posix });
  assert.equal(lease.created, false);
  assert.equal(guards.size, 2);
  const release = native.releaseCredentialAuditFileGuard;
  native.releaseCredentialAuditFileGuard = guard => { release(guard); throw new Error("DO-NOT-LEAK"); };
  assert.throws(() => lease.release(), fixedError("release_failed"));
  assert.deepEqual(released, ["/private/store.sqlite-journal", "/private/store.sqlite"]);
  assert.equal(guards.size, 0);
  assert.throws(() => lease.release(), fixedError("foreign"));
});

test("shared SQLite guards clean up malformed and partially acquired leases", () => {
  for (const malformed of [false, true]) {
    const { native, guards } = fixture();
    const acquire = native.acquireCredentialAuditFileGuard;
    native.acquireCredentialAuditFileGuard = path => {
      if (!path.endsWith("-journal")) return acquire(path);
      if (!malformed) throw { code: "WINDOWS_FILESYSTEM_REPARSE_POINT" };
      return { ...acquire(path), identity: null };
    };
    assert.throws(() => acquireProtectedSqliteFiles({
      native, path: "/private/store.sqlite", pathApi: posix,
    }), fixedError(malformed ? "unavailable" : "security_policy"));
    assert.equal(guards.size, 0);
  }
});

test("shared SQLite guard rejects malformed bindings and paths before mutation", () => {
  const { native } = fixture();
  native.ensureDirectory = () => assert.fail("must not mutate");
  for (const path of ["relative.sqlite", "", "/bad\0path"]) {
    assert.throws(() => acquireProtectedSqliteFiles({ native, path, pathApi: posix }),
      fixedError("invalid_configuration"));
  }
  assert.throws(() => acquireProtectedSqliteFiles({
    native: { ...native, credentialAuditFileGuardSafe: false }, path: "/private/store.sqlite", pathApi: posix,
  }), fixedError("invalid_configuration"));
});

test("guarded SQLite startup failures remain fixed and leave cleanup to the owning store", () => {
  for (let failing = 0; failing < 4; failing += 1) {
    let step = 0;
    const run = () => { if (step++ === failing) throw new Error("DO-NOT-LEAK sqlite detail"); };
    const database = { exec: run, prepare() { return { get: run }; } };
    assert.throws(() => configureGuardedSqliteConnection(database), fixedError("unavailable"));
  }
});

// This is portable SQLite recovery evidence. The injected guards track lifetime
// and file identity; Windows kernel delete-sharing enforcement needs native QA.
test("hot-journal recovery preserves the guarded journal and releases its exclusive lock", () => {
  const root = mkdtempSync(join(tmpdir(), "protected-sqlite-recovery-"));
  const path = join(root, "private", "store.sqlite");
  mkdirSync(join(root, "private"), { mode: 0o700 });
  let first;
  let second;
  let lease;
  try {
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA cache_size=2;');
      db.exec('CREATE TABLE observations(id INTEGER PRIMARY KEY, value TEXT);');
      db.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO observations SELECT x, printf('%01000d', x) FROM n;");
      db.exec("BEGIN IMMEDIATE; UPDATE observations SET value=printf('%01000d', 999);");
      process.exit(23);
    `, path], { timeout: 10_000, encoding: "utf8" });
    assert.equal(crashed.status, 23, crashed.stderr);
    const journalPath = `${path}-journal`;
    assert.deepEqual([...readFileSync(journalPath).subarray(0, 8)], [217, 213, 5, 249, 32, 161, 99, 215]);
    const journalIdentity = lstatSync(journalPath).ino;
    const { native, guards } = fixture();
    native.createFile = file => writeFileSync(file, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    // Real open handles remain live throughout recovery, as Windows guards do.
    const acquire = native.acquireCredentialAuditFileGuard;
    native.acquireCredentialAuditFileGuard = file => {
      const result = acquire(file);
      result.guard.fd = openSync(file, "r+");
      return result;
    };
    const release = native.releaseCredentialAuditFileGuard;
    native.releaseCredentialAuditFileGuard = guard => { closeSync(guard.fd); release(guard); };
    lease = acquireProtectedSqliteFiles({ native, path, pathApi: platformPath });
    assert.equal(lease.created, false);
    first = new DatabaseSync(path, { timeout: 100 });
    const guarded = {
      exec(sql) {
        assert.equal(guards.size, 2);
        first.exec(sql);
        assert.equal(lstatSync(journalPath).ino, journalIdentity);
      },
      prepare(sql) {
        assert.equal(guards.size, 2);
        const statement = first.prepare(sql);
        return { get() {
          const result = statement.get();
          assert.equal(lstatSync(journalPath).ino, journalIdentity);
          return result;
        } };
      },
    };
    configureGuardedSqliteConnection(guarded);
    assert.equal(first.prepare("SELECT value FROM observations WHERE id=1").get().value, "1".padStart(1000, "0"));
    assert.equal(first.prepare("PRAGMA locking_mode").get().locking_mode, "normal");
    second = new DatabaseSync(path, { timeout: 100 });
    configureGuardedSqliteConnection(second);
    second.exec("INSERT INTO observations VALUES (101, 'committed');");
    assert.equal(first.prepare("SELECT COUNT(*) AS n FROM observations").get().n, 101);
    second.close(); second = null;
    first.close(); first = null;
    assert.equal(lstatSync(journalPath).ino, journalIdentity);
    assert.equal(guards.size, 2);
    lease.release(); lease = null;
    assert.equal(guards.size, 0);
  } finally {
    second?.close(); first?.close(); lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});
