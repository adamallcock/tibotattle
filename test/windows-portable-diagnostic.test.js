import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WINDOWS_PORTABLE_STATUS,
  WINDOWS_PORTABLE_SUITE_TIMEOUT_MS,
  WINDOWS_PORTABLE_TEST_TIMEOUT_MS,
  WINDOWS_PORTABLE_QUALIFICATION_ENVIRONMENT_KEYS,
  runWindowsPortableTestFiles,
  terminateWindowsPortableProcessTree,
} from "../scripts/run-windows-portable-diagnostic.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function fakeChild(pid = 9001) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = pid;
  child.kill = () => true;
  return child;
}

test("Windows portable diagnostic is unsupported away from native x64 Windows", async () => {
  await assert.rejects(
    runWindowsPortableTestFiles(["test/test-lanes.test.js"], {
      platform: "darwin",
      architecture: "arm64",
      cwd: REPOSITORY_ROOT,
    }),
    (error) => error.code === WINDOWS_PORTABLE_STATUS.unsupported,
  );
});

test("Windows portable diagnostic preserves manifest order and strips qualification modes", async () => {
  const calls = [];
  const environment = {
    SAFE_TEST_ENVIRONMENT: "1",
    USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "run-id",
    TIBOTATTLE_WINDOWS_QUALIFICATION_STATE_ROOT: "C:\\state",
    TIBOTATTLE_QUALIFICATION_REVISION: "a".repeat(40),
    TIBOTATTLE_QUALIFICATION_CACHE_MODE: "warm",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
    // Native hook tests use this path explicitly; it is not a mode marker.
    TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH:
      "C:\\runner-temp\\windows_filesystem_qualification.node",
  };
  const spawnProcess = (command, arguments_, options) => {
    assert.equal(command, process.execPath);
    calls.push({ arguments_, options });
    const child = fakeChild(9000 + calls.length);
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("close", 0);
    });
    return child;
  };

  const result = await runWindowsPortableTestFiles([
    "test/test-lanes.test.js",
    "test/windows-test-manifest.test.js",
  ], {
    platform: "win32",
    architecture: "x64",
    cwd: REPOSITORY_ROOT,
    environment,
    spawnProcess,
  });

  assert.deepEqual(result, {
    fileCount: 2,
    globalTimeoutMs: WINDOWS_PORTABLE_SUITE_TIMEOUT_MS,
    timeoutMs: WINDOWS_PORTABLE_TEST_TIMEOUT_MS,
  });
  assert.deepEqual(calls.map(({ arguments_ }) => arguments_.at(-1)), [
    "test/test-lanes.test.js",
    "test/windows-test-manifest.test.js",
  ]);
  for (const { arguments_, options } of calls) {
    assert.deepEqual(arguments_.slice(0, 4), [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=dot",
      arguments_.at(-1),
    ]);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.SAFE_TEST_ENVIRONMENT, "1");
    assert.equal(
      options.env.TIBOTATTLE_QUALIFICATION_REVISION,
      environment.TIBOTATTLE_QUALIFICATION_REVISION,
    );
    assert.equal(
      options.env.TIBOTATTLE_QUALIFICATION_CACHE_MODE,
      environment.TIBOTATTLE_QUALIFICATION_CACHE_MODE,
    );
    for (const key of WINDOWS_PORTABLE_QUALIFICATION_ENVIRONMENT_KEYS) {
      assert.equal(Object.hasOwn(options.env, key), false, key);
    }
    assert.equal(
      options.env.TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH,
      environment.TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH,
    );
  }
});

test("Windows portable diagnostic reports the file ordinal on a bounded timeout", async () => {
  const child = fakeChild(9010);
  let terminated = false;
  await assert.rejects(
    runWindowsPortableTestFiles(["test/test-lanes.test.js"], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      timeoutMs: 10,
      spawnProcess: () => child,
      terminateProcessTree: async () => {
        terminated = true;
        return true;
      },
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.timedOut);
      assert.equal(error.file, "test/test-lanes.test.js");
      assert.equal(error.ordinal, 1);
      assert.equal(Number.isSafeInteger(error.elapsedMs), true);
      assert.equal(error.elapsedMs <= 10, true);
      return true;
    },
  );
  assert.equal(terminated, true);
});

test("Windows portable process-tree termination targets only the owned root", async () => {
  const child = fakeChild(9011);
  const killer = new EventEmitter();
  const calls = [];
  const terminated = terminateWindowsPortableProcessTree(child, {
    platform: "win32",
    spawnProcess(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      queueMicrotask(() => killer.emit("close", 0));
      return killer;
    },
  });
  assert.equal(await terminated, true);
  assert.deepEqual(calls, [{
    command: "taskkill.exe",
    arguments_: ["/pid", "9011", "/t", "/f"],
    options: {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  }]);
});

test("Windows portable diagnostic rejects a timeout larger than the fixed bound", async () => {
  await assert.rejects(
    runWindowsPortableTestFiles(["test/test-lanes.test.js"], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      timeoutMs: WINDOWS_PORTABLE_TEST_TIMEOUT_MS + 1,
    }),
    (error) => error.code === WINDOWS_PORTABLE_STATUS.invalid,
  );
});
