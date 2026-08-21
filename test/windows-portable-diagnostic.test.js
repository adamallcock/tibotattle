import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  WINDOWS_PORTABLE_STATUS,
  WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS,
  WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS,
  WINDOWS_PORTABLE_SUITE_TIMEOUT_MS,
  WINDOWS_PORTABLE_TEST_TIMEOUT_MS,
  WINDOWS_PORTABLE_QUALIFICATION_ENVIRONMENT_KEYS,
  formatWindowsPortableDiagnosticFailure,
  runWindowsPortableTestFiles,
  terminateWindowsPortableProcessTree,
} from "../scripts/run-windows-portable-diagnostic.mjs";
import { WINDOWS_PORTABLE_TEST_FILES } from "../scripts/portable-test-manifest.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function fakeChild(pid = 9001) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = pid;
  child.kill = () => true;
  child.stdout = new PassThrough();
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
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
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

test("Windows portable diagnostic continues ordinary nonzero test exits and aggregates them", async () => {
  const calls = [];
  let terminationCalls = 0;
  const spawnProcess = (command, arguments_, options) => {
    const child = fakeChild(9100 + calls.length);
    const code = calls.length === 0 ? 7 : 0;
    calls.push({ command, arguments_, options });
    queueMicrotask(() => {
      child.exitCode = code;
      child.emit("close", code);
    });
    return child;
  };

  await assert.rejects(
    runWindowsPortableTestFiles([
      "test/test-lanes.test.js",
      "test/windows-test-manifest.test.js",
    ], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      spawnProcess,
      terminateProcessTree: async () => {
        terminationCalls += 1;
        return true;
      },
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.failed);
      assert.equal(error.failureCount, 1);
      assert.deepEqual(error.failures, [{
        file: "test/test-lanes.test.js",
        ordinal: 1,
        status: WINDOWS_PORTABLE_STATUS.failed,
      }]);
      assert.equal(error.failuresTruncated, false);
      return true;
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(terminationCalls, 0);
});

test("Windows portable diagnostic stops on a timeout after an ordinary failure", async () => {
  const calls = [];
  let terminationCalls = 0;
  const spawnProcess = () => {
    const child = fakeChild(9150 + calls.length);
    calls.push(child);
    if (calls.length === 1) {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
    }
    return child;
  };

  await assert.rejects(
    runWindowsPortableTestFiles([
      "test/test-lanes.test.js",
      "test/windows-test-manifest.test.js",
      "test/windows-skip-ledger.test.js",
    ], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      timeoutMs: 10,
      spawnProcess,
      terminateProcessTree: async () => {
        terminationCalls += 1;
        return true;
      },
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.timedOut);
      assert.equal(error.file, "test/windows-test-manifest.test.js");
      assert.equal(error.ordinal, 2);
      assert.equal(Object.hasOwn(error, "failures"), false);
      return true;
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(terminationCalls, 1);
});

test("Windows portable diagnostic caps aggregate failure metadata at the fixed bound", async () => {
  const files = Array.from(
    { length: WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS + 1 },
    () => "test/test-lanes.test.js",
  );
  let calls = 0;
  const spawnProcess = () => {
    const child = fakeChild(9200 + calls);
    calls += 1;
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    runWindowsPortableTestFiles(files, {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      spawnProcess,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.failed);
      assert.equal(error.failureCount, WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS + 1);
      assert.equal(error.failures.length, WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS);
      assert.equal(error.failures.at(-1).ordinal, WINDOWS_PORTABLE_MAXIMUM_FAILURE_METADATA_ITEMS);
      assert.equal(error.failuresTruncated, true);
      return true;
    },
  );
  assert.equal(calls, files.length);
});

test("Windows portable diagnostic stops on signal termination instead of aggregating it", async () => {
  let calls = 0;
  const spawnProcess = () => {
    const child = fakeChild(9300);
    calls += 1;
    queueMicrotask(() => {
      child.signalCode = "SIGTERM";
      child.emit("close", null, "SIGTERM");
    });
    return child;
  };

  await assert.rejects(
    runWindowsPortableTestFiles([
      "test/test-lanes.test.js",
      "test/windows-test-manifest.test.js",
    ], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      spawnProcess,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.failed);
      assert.equal(error.file, "test/test-lanes.test.js");
      assert.equal(error.ordinal, 1);
      assert.equal(Object.hasOwn(error, "failures"), false);
      return true;
    },
  );
  assert.equal(calls, 1);
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
      assert.equal(error.progressUnits, 0);
      return true;
    },
  );
  assert.equal(terminated, true);
});

test("Windows portable diagnostic counts only fixed status bytes across chunks", async () => {
  const child = fakeChild(9014);
  const chunks = [".secret", Buffer.from("X\n."), "ignored"];
  await assert.rejects(
    runWindowsPortableTestFiles([WINDOWS_PORTABLE_TEST_FILES[0]], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      timeoutMs: 10,
      spawnProcess: () => {
        queueMicrotask(() => {
          for (const chunk of chunks) child.stdout.write(chunk);
        });
        return child;
      },
      terminateProcessTree: async () => true,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.timedOut);
      assert.equal(error.progressUnits, 3);
      const formatted = formatWindowsPortableDiagnosticFailure(error);
      assert.match(formatted, /progress_units=3/u);
      assert.doesNotMatch(formatted, /secret|ignored/u);
      return true;
    },
  );
});

test("Windows portable diagnostic caps content-free progress metadata", async () => {
  const child = fakeChild(9015);
  await assert.rejects(
    runWindowsPortableTestFiles([WINDOWS_PORTABLE_TEST_FILES[0]], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      timeoutMs: 10,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write(".".repeat(WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS - 1));
          child.stdout.write("X.".repeat(4));
        });
        return child;
      },
      terminateProcessTree: async () => true,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.timedOut);
      assert.equal(error.progressUnits, WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS);
      assert.match(
        formatWindowsPortableDiagnosticFailure(error),
        new RegExp(`progress_units=${WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS}\\b`, "u"),
      );
      return true;
    },
  );
});

test("Windows portable diagnostic removes child and stdout listeners on settle", async () => {
  const child = fakeChild(9016);
  await runWindowsPortableTestFiles(["test/test-lanes.test.js"], {
    platform: "win32",
    architecture: "x64",
    cwd: REPOSITORY_ROOT,
    spawnProcess: () => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
});

test("Windows portable diagnostic fails closed when child stdout is unavailable", async () => {
  const child = fakeChild(9017);
  child.stdout = null;
  let terminationCalls = 0;
  await assert.rejects(
    runWindowsPortableTestFiles(["test/test-lanes.test.js"], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      spawnProcess: () => child,
      terminateProcessTree: async () => {
        terminationCalls += 1;
        return true;
      },
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.failed);
      assert.equal(Object.hasOwn(error, "progressUnits"), false);
      return true;
    },
  );
  assert.equal(terminationCalls, 1);
});

test("Windows portable diagnostic reports unproven cleanup for missing stdout", async () => {
  const child = fakeChild(9018);
  child.stdout = null;
  await assert.rejects(
    runWindowsPortableTestFiles([WINDOWS_PORTABLE_TEST_FILES[0]], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      spawnProcess: () => child,
      terminateProcessTree: async () => false,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.terminationFailed);
      assert.equal(error.progressUnits, 0);
      assert.match(
        formatWindowsPortableDiagnosticFailure(error),
        /progress_units=0/u,
      );
      return true;
    },
  );
});

test("Windows portable diagnostic handles stdout errors without exposing content", async () => {
  const child = fakeChild(9019);
  let terminationCalls = 0;
  await assert.rejects(
    runWindowsPortableTestFiles([WINDOWS_PORTABLE_TEST_FILES[0]], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.emit("error", new Error("stdout-private-canary"));
        });
        return child;
      },
      terminateProcessTree: async () => {
        terminationCalls += 1;
        return true;
      },
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.failed);
      assert.doesNotMatch(
        formatWindowsPortableDiagnosticFailure(error),
        /stdout-private-canary/u,
      );
      return true;
    },
  );
  assert.equal(terminationCalls, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stdout.listenerCount("error"), 0);
});

test("Windows portable diagnostic stops when timeout termination cannot be proven", async () => {
  const child = fakeChild(9012);
  let calls = 0;
  await assert.rejects(
    runWindowsPortableTestFiles([
      "test/test-lanes.test.js",
      "test/windows-test-manifest.test.js",
    ], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      timeoutMs: 10,
      spawnProcess: () => {
        calls += 1;
        return child;
      },
      terminateProcessTree: async () => false,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.terminationFailed);
      assert.equal(error.file, "test/test-lanes.test.js");
      assert.equal(error.ordinal, 1);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("Windows portable diagnostic stops at the global suite timeout", async () => {
  const clockValues = [1000, 1000, 1002];
  const now = () => clockValues.shift() ?? 1002;
  let calls = 0;
  const spawnProcess = () => {
    const child = fakeChild(9400);
    calls += 1;
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("close", 1);
    });
    return child;
  };

  await assert.rejects(
    runWindowsPortableTestFiles([
      "test/test-lanes.test.js",
      "test/windows-test-manifest.test.js",
    ], {
      platform: "win32",
      architecture: "x64",
      cwd: REPOSITORY_ROOT,
      globalTimeoutMs: 1,
      spawnProcess,
      now,
    }),
    (error) => {
      assert.equal(error.code, WINDOWS_PORTABLE_STATUS.suiteTimedOut);
      assert.equal(error.file, "test/windows-test-manifest.test.js");
      assert.equal(error.ordinal, 2);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("Windows portable diagnostic formatting is fixed and content-free", () => {
  const aggregate = new Error("do not emit this message");
  aggregate.code = WINDOWS_PORTABLE_STATUS.failed;
  aggregate.failureCount = 1;
  aggregate.failures = [{
    file: WINDOWS_PORTABLE_TEST_FILES[0],
    ordinal: 1,
    status: WINDOWS_PORTABLE_STATUS.failed,
  }];
  aggregate.failuresTruncated = false;
  const formatted = formatWindowsPortableDiagnosticFailure(aggregate);
  assert.equal(
    formatted,
    "WINDOWS_PORTABLE_DIAGNOSTIC_FAILED failure_count=1 recorded_failures=1 truncated=0\n"
      + `WINDOWS_PORTABLE_DIAGNOSTIC_FAILURE file=${WINDOWS_PORTABLE_TEST_FILES[0]} ordinal=1 `
      + "status=WINDOWS_PORTABLE_DIAGNOSTIC_TEST_FAILED",
  );
  assert.doesNotMatch(formatted, /do not emit|stdout|stderr|secret/iu);

  const timeout = new Error("do not emit this message either");
  timeout.code = WINDOWS_PORTABLE_STATUS.timedOut;
  timeout.file = WINDOWS_PORTABLE_TEST_FILES[0];
  timeout.ordinal = 1;
  timeout.elapsedMs = 60_000;
  timeout.progressUnits = 7;
  assert.match(
    formatWindowsPortableDiagnosticFailure(timeout),
    /status=WINDOWS_PORTABLE_DIAGNOSTIC_TEST_TIMED_OUT elapsed_ms=60000 progress_units=7/u,
  );

  const unsafeProgress = new Error("private message");
  unsafeProgress.code = WINDOWS_PORTABLE_STATUS.terminationFailed;
  unsafeProgress.file = WINDOWS_PORTABLE_TEST_FILES[0];
  unsafeProgress.ordinal = 1;
  unsafeProgress.progressUnits = WINDOWS_PORTABLE_MAXIMUM_PROGRESS_UNITS + 1;
  assert.match(
    formatWindowsPortableDiagnosticFailure(unsafeProgress),
    /progress_units=unavailable/u,
  );

  const unsafe = new Error("private message");
  unsafe.code = WINDOWS_PORTABLE_STATUS.failed;
  unsafe.failureCount = 1;
  unsafe.failures = [{
    file: "C:\\private\\secret.test.js",
    ordinal: 1,
    status: "PRIVATE_FAILURE",
  }];
  unsafe.failuresTruncated = false;
  assert.equal(
    formatWindowsPortableDiagnosticFailure(unsafe),
    WINDOWS_PORTABLE_STATUS.failed,
  );
});

test("Windows portable process-tree termination waits for the owned child close", async () => {
  const child = fakeChild(9011);
  const killer = new EventEmitter();
  const calls = [];
  let closeListenerAttached = false;
  const childOnce = child.once.bind(child);
  child.once = (event, listener) => {
    if (event === "close") closeListenerAttached = true;
    return childOnce(event, listener);
  };
  const terminated = terminateWindowsPortableProcessTree(child, {
    platform: "win32",
    spawnProcess(command, arguments_, options) {
      assert.equal(closeListenerAttached, true);
      calls.push({ command, arguments_, options });
      queueMicrotask(() => killer.emit("close", 0));
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
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

test("Windows portable process-tree termination accepts child close before taskkill", async () => {
  const child = fakeChild(9012);
  const killer = new EventEmitter();
  const terminated = terminateWindowsPortableProcessTree(child, {
    platform: "win32",
    timeoutMs: 100,
    spawnProcess() {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("close", 1);
      });
      setTimeout(() => killer.emit("close", 0), 0);
      return killer;
    },
  });
  assert.equal(await terminated, true);
});

test("Windows portable process-tree termination fails without child close proof", async () => {
  const child = fakeChild(9013);
  const killer = new EventEmitter();
  const terminated = terminateWindowsPortableProcessTree(child, {
    platform: "win32",
    timeoutMs: 10,
    spawnProcess() {
      queueMicrotask(() => killer.emit("close", 0));
      return killer;
    },
  });
  assert.equal(await terminated, false);
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
