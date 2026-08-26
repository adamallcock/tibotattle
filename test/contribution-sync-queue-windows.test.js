import assert from "node:assert/strict";
import { lstat, mkdtemp } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalContributionSyncQueueStorageContext,
} from "../src/platform/local-contribution-sync-queue-storage.js";

const JOB_STATES = [
  "pending",
  "in_flight",
  "accepted",
  "retryable",
  "rejected",
];

function createError(code) {
  const error = new Error("queue storage failed");
  error.code = `contribution_sync_queue_${code}`;
  return error;
}

function createStorage(options = {}) {
  return createLocalContributionSyncQueueStorageContext({
    createError,
    queueSchemaVersion: "contribution-sync-queue-v0.1",
    queueStatusSchemaVersion: "contribution-sync-status-v0.1",
    maximumQueueBytes: 128 * 1024 * 1024,
    maximumQueueJobs: 25_600,
    jobStates: JOB_STATES,
    platform: "win32",
    ...options,
  });
}

function queueUnavailable(error) {
  assert.equal(error?.code, "contribution_sync_queue_queue_unavailable");
  return true;
}

test("Windows queue refuses to fall back when no qualified SQLite session is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-queue-win32-no-fallback-"));
  const privateRoot = join(root, "private");
  const queueFile = join(privateRoot, "contribution-sync-v0.1.sqlite3");
  const storage = createStorage();

  await assert.rejects(
    storage.openQueue({
      queueFile,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    }),
    queueUnavailable,
  );
  await assert.rejects(lstat(privateRoot), (error) => error?.code === "ENOENT");
  await assert.rejects(lstat(queueFile), (error) => error?.code === "ENOENT");
});

test("Windows queue rejects a shape-only or copied session before touching the queue path", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-queue-win32-forgery-"));
  const queueFile =
    "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\private\\contribution-sync-v0.1.sqlite3";
  const calls = [];
  const storage = createStorage({
    windowsSqliteStateSessionFactory(options) {
      calls.push(options);
      return Object.freeze({
        contractVersion: "windows-sqlite-state-session-v1",
        productionSafe: true,
        sqliteStateLeaseSafe: true,
        database: Object.freeze({
          exec() {},
          prepare() {},
        }),
        close() {},
      });
    },
  });

  await assert.rejects(
    storage.openQueue({
      queueFile,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    }),
    queueUnavailable,
  );
  assert.deepEqual(calls, [{
    rootPath:
      "C:\\Users\\tester\\AppData\\Local\\TiboTattle\\private",
    databaseName: "contribution-sync-v0.1.sqlite3",
    queueFile,
  }]);
  await assert.rejects(lstat(join(root, "private")), (error) => error?.code === "ENOENT");
});
