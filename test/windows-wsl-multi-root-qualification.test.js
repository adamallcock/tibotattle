import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIXED_WSL_QUALIFICATION_STATUS,
  fixedQualificationErrorCode,
  parseRunningWslDistributions,
  parseWslVerboseDistribution,
  runBoundedCommand,
  runWithAbortTimeout,
  runWithTemporaryCleanup,
  runWslQualificationLifecycle,
  validateWslQualificationEnvironment,
  wslCodexHome,
} from "../scripts/windows-wsl-multi-root-qualification.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(
  REPOSITORY_ROOT,
  "scripts/windows-wsl-multi-root-qualification.mjs",
);

function errorCode(code) {
  return (error) => error?.code === code;
}

function fakeChildProcess() {
  const child = new EventEmitter();
  const killSignals = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    killSignals.push(signal);
    return true;
  };
  return { child, killSignals };
}

test("WSL multi-root qualification is explicitly selected and native Windows x64 only", () => {
  const validEnvironment = {
    USAGE_MONITOR_WSL_QUALIFICATION: "1",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    TIBOTATTLE_WSL_QUALIFICATION_REVISION: "a".repeat(40),
    RUNNER_TEMP: resolve(REPOSITORY_ROOT, ".release-build"),
  };
  assert.deepEqual(validateWslQualificationEnvironment({
    platform: "win32",
    architecture: "x64",
    environment: validEnvironment,
  }), {
    revision: "a".repeat(40),
    temporaryRoot: resolve(validEnvironment.RUNNER_TEMP),
  });
  assert.throws(
    () => validateWslQualificationEnvironment({
      platform: "win32",
      architecture: "x64",
      environment: { ...validEnvironment, USAGE_MONITOR_WSL_QUALIFICATION: "0" },
    }),
    errorCode(FIXED_WSL_QUALIFICATION_STATUS.flagRequired),
  );
  assert.throws(
    () => validateWslQualificationEnvironment({
      platform: "darwin",
      architecture: "arm64",
      environment: validEnvironment,
    }),
    errorCode(FIXED_WSL_QUALIFICATION_STATUS.nativeWindowsRequired),
  );
  assert.throws(
    () => validateWslQualificationEnvironment({
      platform: "win32",
      architecture: "arm64",
      environment: validEnvironment,
    }),
    errorCode(FIXED_WSL_QUALIFICATION_STATUS.architectureRequired),
  );
  assert.throws(
    () => validateWslQualificationEnvironment({
      platform: "win32",
      architecture: "x64",
      environment: { ...validEnvironment, GITHUB_ACTIONS: "false" },
    }),
    errorCode(FIXED_WSL_QUALIFICATION_STATUS.hostedEnvironmentRequired),
  );
  assert.throws(
    () => validateWslQualificationEnvironment({
      platform: "win32",
      architecture: "x64",
      environment: { ...validEnvironment, RUNNER_ENVIRONMENT: "self-hosted" },
    }),
    errorCode(FIXED_WSL_QUALIFICATION_STATUS.hostedEnvironmentRequired),
  );
});

test("WSL parsing handles Windows NUL output and requires the exact WSL2 distribution", () => {
  assert.equal(
    wslCodexHome(),
    "\\\\wsl$\\Ubuntu-24.04\\root\\.codex",
  );
  assert.deepEqual(
    parseRunningWslDistributions(`${"Ubuntu-24.04".split("").join("\0")}\0\r\0\n\0`),
    ["Ubuntu-24.04"],
  );
  assert.deepEqual(parseWslVerboseDistribution([
    "  NAME              STATE           VERSION",
    "* Ubuntu-24.04      Running         2",
  ].join("\r\n")), {
    state: "Running",
    version: 2,
  });
  assert.equal(parseWslVerboseDistribution(
    "Ubuntu-22.04 Stopped 2",
  ), null);
});

test("the executable requires its explicit flag before native execution", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      USAGE_MONITOR_WSL_QUALIFICATION: "0",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      TIBOTATTLE_WSL_QUALIFICATION_REVISION: "a".repeat(40),
      RUNNER_TEMP: resolve(REPOSITORY_ROOT, ".release-build"),
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `${FIXED_WSL_QUALIFICATION_STATUS.flagRequired}\n`,
  );
  assert.doesNotMatch(result.stderr, /(?:at file:|\.codex|\\wsl|rollout-|\.jsonl)/iu);
});

test("bounded command execution maps a synchronous spawn failure to a fixed code", async () => {
  await assert.rejects(runBoundedCommand("wsl.exe", ["--status"], {
    timeoutMs: 1_000,
    spawnProcess: () => {
      throw new Error("private spawn detail");
    },
  }), errorCode(FIXED_WSL_QUALIFICATION_STATUS.commandFailed));
});

test("bounded command execution kills and reports an actual timeout without private detail", async () => {
  const privateCommand = "C:\\private\\wsl-timeout-canary.exe";
  const privateArgument = "private-timeout-argument-canary";
  const { child, killSignals } = fakeChildProcess();
  const startedAt = Date.now();
  await assert.rejects(runBoundedCommand(privateCommand, [privateArgument], {
    timeoutMs: 5,
    spawnProcess: (command, args, options) => {
      assert.equal(command, privateCommand);
      assert.deepEqual(args, [privateArgument]);
      assert.deepEqual(options, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return child;
    },
  }), (error) => {
    assert.equal(error?.name, "WslQualificationError");
    assert.equal(error?.code, FIXED_WSL_QUALIFICATION_STATUS.commandTimedOut);
    assert.equal(error?.message, FIXED_WSL_QUALIFICATION_STATUS.commandTimedOut);
    assert.equal(error.message.includes(privateCommand), false);
    assert.equal(error.message.includes(privateArgument), false);
    return true;
  });
  assert.deepEqual(killSignals, ["SIGKILL"]);
  assert.ok(Date.now() - startedAt < 1_000, "command timeout did not remain bounded");
});

test("bounded command execution kills oversized output without retaining private output", async () => {
  const privateOutput = "private-command-output-canary";
  const { child, killSignals } = fakeChildProcess();
  await assert.rejects(runBoundedCommand("wsl.exe", ["--status"], {
    timeoutMs: 1_000,
    maximumOutputBytes: 8,
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(privateOutput, "utf8"));
      });
      return child;
    },
  }), (error) => {
    assert.equal(error?.name, "WslQualificationError");
    assert.equal(
      error?.code,
      FIXED_WSL_QUALIFICATION_STATUS.commandOutputExceeded,
    );
    assert.equal(
      error?.message,
      FIXED_WSL_QUALIFICATION_STATUS.commandOutputExceeded,
    );
    assert.equal(error.message.includes(privateOutput), false);
    return true;
  });
  assert.deepEqual(killSignals, ["SIGKILL"]);
});

test("refresh timeout awaits cooperative abort settlement before temporary cleanup", async () => {
  const events = [];
  await assert.rejects(runWithTemporaryCleanup(
    () => runWithAbortTimeout((signal) => new Promise((resolvePromise) => {
      signal.addEventListener("abort", () => {
        events.push("aborted");
        queueMicrotask(() => {
          events.push("settled");
          resolvePromise("late-success");
        });
      }, { once: true });
    }), {
      timeoutMs: 5,
      abortGraceMs: 100,
    }),
    async () => {
      events.push("cleanup");
    },
  ), errorCode(FIXED_WSL_QUALIFICATION_STATUS.refreshTimedOut));
  assert.deepEqual(events, ["aborted", "settled", "cleanup"]);
});

test("refresh timeout bounds abort grace and skips racing cleanup when still in flight", async () => {
  const events = [];
  const startedAt = Date.now();
  await assert.rejects(runWithTemporaryCleanup(
    () => runWithAbortTimeout((signal) => new Promise(() => {
      signal.addEventListener("abort", () => events.push("aborted"), { once: true });
    }), {
      timeoutMs: 5,
      abortGraceMs: 10,
    }),
    async () => {
      events.push("cleanup");
    },
  ), errorCode(FIXED_WSL_QUALIFICATION_STATUS.refreshTimedOut));
  assert.deepEqual(events, ["aborted"]);
  assert.ok(Date.now() - startedAt < 1_000, "abort grace did not remain bounded");
});

test("temporary cleanup failure has a fixed content-free status", async () => {
  await assert.rejects(runWithTemporaryCleanup(
    async () => FIXED_WSL_QUALIFICATION_STATUS.passed,
    async () => {
      throw new Error("C:\\private\\qualification-state");
    },
  ), errorCode(FIXED_WSL_QUALIFICATION_STATUS.cleanupFailed));
  assert.equal(
    fixedQualificationErrorCode({
      code: FIXED_WSL_QUALIFICATION_STATUS.cleanupFailed,
      message: "C:\\private\\qualification-state",
    }),
    FIXED_WSL_QUALIFICATION_STATUS.cleanupFailed,
  );
});

test("temporary cleanup failure never overrides the established qualification failure", async () => {
  const primary = new Error("established qualification failure");
  primary.code = FIXED_WSL_QUALIFICATION_STATUS.phaseInvalid;
  await assert.rejects(runWithTemporaryCleanup(
    async () => {
      throw primary;
    },
    async () => {
      throw new Error("C:\\private\\cleanup-failure");
    },
  ), (error) => error === primary);
});

test("the dependency-injected lifecycle stops, retains, and recovers without rebinding", async () => {
  const codexHomes = ["C:\\synthetic\\.codex", "\\\\wsl$\\Ubuntu-24.04\\root\\.codex"];
  const owners = Object.freeze([
    Object.freeze({ source: "1".repeat(64), owner: "a".repeat(64) }),
    Object.freeze({ source: "2".repeat(64), owner: "b".repeat(64) }),
  ]);
  const coverage = (status) => ({
    status,
    configuredRoots: 2,
    availableRoots: status === "partial" ? 1 : 2,
    emptyRoots: 0,
    unavailableRoots: status === "partial" ? 1 : 0,
    retainedHistory: status === "partial",
    unavailableOwnerSources: status === "partial" ? 1 : 0,
    ambiguousSources: 0,
  });
  let running = true;
  const phases = [];
  const commands = [];
  const result = await runWslQualificationLifecycle({
    codexHomes,
    primaryCodexHome: codexHomes[0],
    privateValues: codexHomes,
    refresh: async ({ phase, codexHomes: activityRoots, primaryCodexHome }) => {
      phases.push({ phase, running });
      assert.deepEqual(activityRoots, codexHomes);
      assert.equal(primaryCodexHome, codexHomes[0]);
      return {
        unifiedIndex: {
          totalUsageEvents: 2,
          rootCoverage: coverage(phase === "stopped" ? "partial" : "ready"),
        },
      };
    },
    readOwners: () => owners,
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (args[0] === "--terminate") running = false;
      if (args.at(-1) === "true") running = true;
      return { stdout: "", stderr: "" };
    },
    listRunning: async () => running ? ["Ubuntu-24.04"] : [],
    waitForDistroState: async (expected) => assert.equal(running, expected),
  });
  assert.equal(result, FIXED_WSL_QUALIFICATION_STATUS.passed);
  assert.deepEqual(phases, [
    { phase: "initial", running: true },
    { phase: "stopped", running: false },
    { phase: "recovered", running: true },
  ]);
  assert.deepEqual(commands, [
    ["wsl.exe", "--terminate", "Ubuntu-24.04"],
    ["wsl.exe", "--distribution", "Ubuntu-24.04", "--user", "root", "--", "true"],
  ]);
});

test("the lifecycle fails when touching the stopped WSL share wakes the distro", async () => {
  const codexHomes = ["C:\\synthetic\\.codex", "\\\\wsl$\\Ubuntu-24.04\\root\\.codex"];
  let running = true;
  const coverage = (status) => ({
    status,
    configuredRoots: 2,
    availableRoots: status === "partial" ? 1 : 2,
    emptyRoots: 0,
    unavailableRoots: status === "partial" ? 1 : 0,
    retainedHistory: status === "partial",
    unavailableOwnerSources: status === "partial" ? 1 : 0,
    ambiguousSources: 0,
  });
  await assert.rejects(runWslQualificationLifecycle({
    codexHomes,
    primaryCodexHome: codexHomes[0],
    privateValues: codexHomes,
    refresh: async ({ phase }) => {
      if (phase === "stopped") running = true;
      return {
        unifiedIndex: {
          totalUsageEvents: 2,
          rootCoverage: coverage(phase === "stopped" ? "partial" : "ready"),
        },
      };
    },
    readOwners: () => [
      { source: "1".repeat(64), owner: "a".repeat(64) },
      { source: "2".repeat(64), owner: "b".repeat(64) },
    ],
    runCommand: async (_command, args) => {
      if (args[0] === "--terminate") running = false;
      return { stdout: "", stderr: "" };
    },
    listRunning: async () => running ? ["Ubuntu-24.04"] : [],
    waitForDistroState: async (expected) => assert.equal(running, expected),
  }), errorCode(FIXED_WSL_QUALIFICATION_STATUS.distroStateInvalid));
});

test("the lifecycle rejects private Windows paths from its public receipt", async () => {
  const codexHomes = ["C:\\synthetic\\.codex", "\\\\wsl$\\Ubuntu-24.04\\root\\.codex"];
  await assert.rejects(runWslQualificationLifecycle({
    codexHomes,
    primaryCodexHome: codexHomes[0],
    privateValues: codexHomes,
    refresh: async () => ({
      privatePath: codexHomes[0],
      unifiedIndex: {
        totalUsageEvents: 2,
        rootCoverage: {
          status: "ready",
          configuredRoots: 2,
          availableRoots: 2,
          emptyRoots: 0,
          unavailableRoots: 0,
          retainedHistory: false,
          unavailableOwnerSources: 0,
          ambiguousSources: 0,
        },
      },
    }),
    readOwners: () => [],
    runCommand: async () => ({ stdout: "", stderr: "" }),
    listRunning: async () => [],
    waitForDistroState: async () => {},
  }), errorCode(FIXED_WSL_QUALIFICATION_STATUS.publicReceiptInvalid));
});

test("the harness source never emits captured command output or invokes a shell", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /shell: false/u);
  assert.match(source, /windowsHide: true/u);
  assert.match(source, /maximumOutputBytes/u);
  assert.match(source, /\\\\wsl\$/u);
  assert.doesNotMatch(source, /console\.(?:log|error)|process\.(?:stdout|stderr)\.write\([^`]*\.stdout/u);
  assert.equal(
    fixedQualificationErrorCode({ code: "private-path:C:\\Users\\runner" }),
    FIXED_WSL_QUALIFICATION_STATUS.unexpected,
  );
});
