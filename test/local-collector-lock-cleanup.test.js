import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLocalCollectorStateLock,
} from "../src/local-collector-state.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-lock-cleanup-"));
  return {
    root,
    stateFile: join(root, "state", "local-collector-state-v1.sqlite"),
  };
}

function lockRow(stateFile) {
  const database = new DatabaseSync(stateFile, { readOnly: true });
  try {
    return database.prepare(`
      SELECT name, pid, acquired_at
        FROM instance_locks
       WHERE name = 'collector'
    `).get() ?? null;
  } finally {
    database.close();
  }
}

function directDatabaseWithCloseFailure(path, { failClose }) {
  const database = new DatabaseSync(path, { readOnly: false, timeout: 5_000 });
  const close = database.close.bind(database);
  database.close = () => {
    close();
    if (failClose()) {
      const error = new Error("injected lock database close failure");
      error.code = "injected_lock_database_close_failure";
      throw error;
    }
  };
  return database;
}

test("a lock release callback cannot delete a newer same-PID acquisition", async () => {
  const value = await fixture();
  const clock = () => Date.parse("2026-09-13T00:00:00.000Z");
  try {
    const releaseFirst = await acquireLocalCollectorStateLock(value.stateFile, {
      clock,
      processExists: () => false,
    });
    const releaseSecond = await acquireLocalCollectorStateLock(value.stateFile, {
      clock,
      processExists: () => false,
    });

    await releaseFirst();
    assert.equal(lockRow(value.stateFile)?.pid, process.pid);
    await releaseSecond();
    assert.equal(lockRow(value.stateFile), null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a post-insert database close failure removes only its own lock row", async () => {
  const value = await fixture();
  let closeFailures = 1;
  const clock = () => Date.parse("2026-09-13T00:00:00.000Z");
  try {
    await assert.rejects(
      () => acquireLocalCollectorStateLock(value.stateFile, {
        clock,
        processExists: () => false,
        openDatabaseForLock: (path) => directDatabaseWithCloseFailure(path, {
          failClose: () => closeFailures-- > 0,
        }),
      }),
      (error) => error?.code === "injected_lock_database_close_failure",
    );
    assert.equal(lockRow(value.stateFile), null);

    const release = await acquireLocalCollectorStateLock(value.stateFile, { clock });
    await release();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a post-insert sync failure removes its own lock before returning the error", async () => {
  const value = await fixture();
  let syncCalls = 0;
  const clock = () => Date.parse("2026-09-13T00:00:00.000Z");
  try {
    await assert.rejects(
      () => acquireLocalCollectorStateLock(value.stateFile, {
        clock,
        processExists: () => false,
        syncStateFileForLock: async () => {
          syncCalls += 1;
          if (syncCalls === 1) {
            const error = new Error("injected lock sync failure");
            error.code = "injected_lock_sync_failure";
            throw error;
          }
        },
      }),
      (error) => error?.code === "injected_lock_sync_failure",
    );
    assert.equal(lockRow(value.stateFile), null);
    assert.equal(syncCalls, 2, "initial sync and owned-row cleanup sync both run");

    const release = await acquireLocalCollectorStateLock(value.stateFile, { clock });
    await release();
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a transient release sync failure can be retried without losing ownership", async () => {
  const value = await fixture();
  let syncCalls = 0;
  const clock = () => Date.parse("2026-09-13T00:00:00.000Z");
  try {
    const release = await acquireLocalCollectorStateLock(value.stateFile, {
      clock,
      syncStateFileForLock: async () => {
        syncCalls += 1;
        if (syncCalls === 2) {
          const error = new Error("injected release sync failure");
          error.code = "injected_release_sync_failure";
          throw error;
        }
      },
    });
    await assert.rejects(release, { code: "injected_release_sync_failure" });
    await release();
    assert.equal(lockRow(value.stateFile), null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a replacement owner survives cleanup after the previous owner loses its sync", async () => {
  const value = await fixture();
  let replacementRelease = null;
  let firstSync = true;
  const clock = () => Date.parse("2026-09-13T00:00:00.000Z");
  try {
    await assert.rejects(
      () => acquireLocalCollectorStateLock(value.stateFile, {
        clock,
        processExists: () => false,
        syncStateFileForLock: async (path) => {
          if (firstSync) {
            firstSync = false;
            replacementRelease = await acquireLocalCollectorStateLock(path, {
              clock,
              processExists: () => false,
              syncStateFileForLock: async () => {},
            });
            const error = new Error("injected first-owner sync failure");
            error.code = "injected_first_owner_sync_failure";
            throw error;
          }
        },
      }),
      (error) => error?.code === "injected_first_owner_sync_failure",
    );
    assert.equal(typeof replacementRelease, "function");
    assert.equal(lockRow(value.stateFile)?.pid, process.pid);
    await replacementRelease();
    assert.equal(lockRow(value.stateFile), null);
  } finally {
    await replacementRelease?.().catch(() => {});
    await rm(value.root, { recursive: true, force: true });
  }
});
