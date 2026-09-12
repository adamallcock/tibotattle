import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  runWindowsAccountlessQualificationSmokeForTest,
} from "../windows-accountless-qualification-smoke.js";

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";

function backendFixture(initial = null) {
  let stored = initial === null ? null : Buffer.from(initial);
  const calls = [];
  return {
    backend: {
      async read() {
        calls.push("read");
        return stored === null ? null : Buffer.from(stored);
      },
      async createIfMissing(value) {
        calls.push("create");
        if (stored !== null) return "existing";
        stored = Buffer.from(value);
        return "created";
      },
      async deleteExact(value) {
        calls.push("delete");
        if (stored === null) return "missing";
        if (!stored.equals(value)) return "mismatch";
        stored.fill(0);
        stored = null;
        return "deleted";
      },
    },
    calls,
    value() {
      return stored === null ? null : Buffer.from(stored);
    },
  };
}

test("Windows accountless smoke uses two owned FD3 children and removes its synthetic credential", async () => {
  const fixture = backendFixture();
  const spawns = [];
  const result = await runWindowsAccountlessQualificationSmokeForTest({
    backend: fixture.backend,
    environment: {
      USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://must-not-reach-the-child.example",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: RUN_ID,
    },
    runId: RUN_ID,
    spawnProcess(command, args, options) {
      spawns.push({ command, args, environment: options.env, stdio: options.stdio });
      return spawn(command, args, options);
    },
  });
  assert.deepEqual(result, { status: "passed-v1" });
  assert.deepEqual(fixture.calls, ["read", "create", "read", "read", "delete", "read"]);
  assert.equal(fixture.value(), null);
  assert.equal(spawns.length, 2, "the second FD3 child re-reads native state after the first exits");
  for (const selected of spawns) {
    assert.deepEqual(selected.stdio, ["ignore", "ignore", "ignore", "ipc"]);
    assert.equal(selected.environment.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(selected.environment.USAGE_MONITOR_ACCOUNTLESS_ORIGIN, undefined);
    assert.equal(selected.environment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID, undefined);
  }
});

test("Windows accountless smoke refuses a pre-existing credential without overwriting or deleting it", async () => {
  const preserved = Buffer.alloc(32, 67);
  const fixture = backendFixture(preserved);
  await assert.rejects(runWindowsAccountlessQualificationSmokeForTest({
    backend: fixture.backend,
    environment: {},
    runId: RUN_ID,
  }));
  assert.deepEqual(fixture.calls, ["read"]);
  assert.deepEqual(fixture.value(), preserved);
});

test("Windows accountless smoke validates its fixed run identifier before it can spawn a child", async () => {
  const fixture = backendFixture();
  let spawns = 0;
  await assert.rejects(runWindowsAccountlessQualificationSmokeForTest({
    backend: fixture.backend,
    environment: {},
    runId: "not-a-qualified-run-id",
    spawnProcess() {
      spawns += 1;
      throw new Error("must not spawn");
    },
  }));
  assert.equal(spawns, 0);
  assert.deepEqual(fixture.calls, []);
});
