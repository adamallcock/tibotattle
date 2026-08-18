import test from "node:test";
import assert from "node:assert/strict";

import { syncDirectory } from "../src/platform/owner-only-filesystem.js";

test("directory sync is an explicit no-op on Windows", async () => {
  let opens = 0;
  await syncDirectory("C:\\state", {
    platform: "win32",
    openDirectory: async () => {
      opens += 1;
      throw new Error("Windows must not try to open a directory for fsync");
    },
  });
  assert.equal(opens, 0);
});

test("directory sync retains the POSIX open, flush, and close barrier", async () => {
  const operations = [];
  await syncDirectory("/state", {
    platform: "linux",
    openDirectory: async (path, flags) => {
      operations.push(["open", path, flags]);
      return {
        async sync() {
          operations.push(["sync"]);
        },
        async close() {
          operations.push(["close"]);
        },
      };
    },
  });
  assert.deepEqual(operations, [
    ["open", "/state", "r"],
    ["sync"],
    ["close"],
  ]);
});

test("directory sync closes its POSIX handle when flushing fails", async () => {
  let closed = false;
  await assert.rejects(
    syncDirectory("/state", {
      platform: "darwin",
      openDirectory: async () => ({
        async sync() {
          throw new Error("flush failed");
        },
        async close() {
          closed = true;
        },
      }),
    }),
    /flush failed/u,
  );
  assert.equal(closed, true);
});
