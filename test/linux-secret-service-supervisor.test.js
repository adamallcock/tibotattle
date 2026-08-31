import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  cleanupLinuxQualificationProcesses,
  parseLinuxProcStartTime,
  runLinuxSecretServiceSupervisor,
  signalLinuxProcessIdentity,
  validateLinuxQualificationSupervisorReceipt,
} from "../scripts/run-linux-secret-service-qualification.mjs";

const RECEIPT = Object.freeze({
  schemaVersion: "linux-credential-qualification-v1",
  status: "passed",
  scope: "development_only",
  platform: "linux",
  architecture: "x64",
  subject: "pinned_native_binding",
  capabilities: 4,
  lifecycle: "round_trip_absence_confirmed",
  cleanup: "confirmed",
  leaseCrossProcessSafe: false,
  crashRecoveryComplete: false,
});

function createQualificationChild({ stdout = "", stderr = "" } = {}) {
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const child = Object.freeze({
    pid: 42,
    stdout: stdoutStream,
    stderr: stderrStream,
  });
  queueMicrotask(() => {
    stdoutStream.end(stdout);
    stderrStream.end(stderr);
  });
  return child;
}

function isolatedSupervisorRuntime(overrides = {}) {
  return {
    platform: "linux",
    architecture: "x64",
    environment: {
      HOME: "/home/node",
      TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED: "1",
    },
    listProcesses: async () => [],
    spawnChild: () => createQualificationChild({
      stdout: JSON.stringify(RECEIPT),
    }),
    readProcessGroupIdentity: async () => Object.freeze({
      pid: 42,
      executable: "/usr/bin/dbus-run-session",
      startTime: "100",
    }),
    cleanupProcesses: async () => true,
    waitForChildClose: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return [0, null];
    },
    scheduleDeadline: () => Object.freeze({ kind: "fake-timer" }),
    cancelDeadline: () => {},
    ...overrides,
  };
}

test("Linux Secret Service supervisor parses exact process start identities", () => {
  const fieldsThreeThroughTwentyTwo = [
    "S", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "10", "11", "12", "13", "14", "15", "16", "17", "18", "98765",
  ];
  assert.equal(
    parseLinuxProcStartTime(`42 (gnome keyring daemon) ${fieldsThreeThroughTwentyTwo.join(" ")}`),
    "98765",
  );
  assert.equal(parseLinuxProcStartTime("42 malformed"), null);
  assert.equal(parseLinuxProcStartTime("x".repeat(16_385)), null);
});

test("Linux Secret Service supervisor accepts only the exact content-free receipt", () => {
  assert.deepEqual(validateLinuxQualificationSupervisorReceipt({ ...RECEIPT }), RECEIPT);
  assert.equal(validateLinuxQualificationSupervisorReceipt({ ...RECEIPT, extra: true }), null);
  assert.equal(validateLinuxQualificationSupervisorReceipt({
    ...RECEIPT,
    cleanup: "best_effort",
  }), null);
  assert.equal(validateLinuxQualificationSupervisorReceipt(Object.create(RECEIPT)), null);
});

test("Linux Secret Service supervisor rejects a preexisting qualification daemon before spawn", async () => {
  let spawnCalls = 0;
  const identity = Object.freeze({
    pid: 77,
    executable: "/usr/bin/gnome-keyring-daemon",
    startTime: "200",
  });
  const outcome = await runLinuxSecretServiceSupervisor(
    isolatedSupervisorRuntime({
      listProcesses: async () => [identity],
      spawnChild: () => {
        spawnCalls += 1;
        return createQualificationChild();
      },
    }),
  );
  assert.deepEqual(outcome, {
    status: "failed",
    code: "LINUX_SECRET_SERVICE_SUPERVISOR_ISOLATION_DIRTY",
  });
  assert.equal(spawnCalls, 0);
});

test("Linux Secret Service supervisor times out only after cleanup is confirmed", async () => {
  const processGroupIdentity = Object.freeze({
    pid: 42,
    executable: "/usr/bin/dbus-run-session",
    startTime: "100",
  });
  const cleanupCalls = [];
  let cancelledTimer = null;
  const timer = Object.freeze({ kind: "deadline" });
  const outcome = await runLinuxSecretServiceSupervisor(
    isolatedSupervisorRuntime({
      readProcessGroupIdentity: async () => processGroupIdentity,
      waitForChildClose: () => new Promise(() => {}),
      scheduleDeadline: (callback, durationMs) => {
        assert.equal(durationMs, 123);
        queueMicrotask(callback);
        return timer;
      },
      cancelDeadline: (value) => {
        cancelledTimer = value;
      },
      cleanupProcesses: async (identity) => {
        cleanupCalls.push(identity);
        return true;
      },
      waitFor: async (durationMs) => {
        assert.equal(durationMs, 17);
      },
      childDeadlineMs: 123,
      killCleanupDeadlineMs: 17,
    }),
  );
  assert.deepEqual(outcome, {
    status: "failed",
    code: "LINUX_SECRET_SERVICE_SUPERVISOR_DEADLINE_EXCEEDED",
  });
  assert.equal(cancelledTimer, timer);
  assert.deepEqual(cleanupCalls, [processGroupIdentity]);
});

test("Linux Secret Service supervisor reports cleanup failure ahead of timeout", async () => {
  const outcome = await runLinuxSecretServiceSupervisor(
    isolatedSupervisorRuntime({
      waitForChildClose: () => new Promise(() => {}),
      scheduleDeadline: (callback) => {
        queueMicrotask(callback);
        return Object.freeze({ kind: "deadline" });
      },
      cleanupProcesses: async () => false,
    }),
  );
  assert.deepEqual(outcome, {
    status: "failed",
    code: "LINUX_SECRET_SERVICE_SUPERVISOR_PROCESS_CLEANUP_FAILED",
  });
});

test("Linux Secret Service supervisor fails closed when captured output overflows", async () => {
  let cleanupCalls = 0;
  const outcome = await runLinuxSecretServiceSupervisor(
    isolatedSupervisorRuntime({
      spawnChild: () => createQualificationChild({ stdout: "123456789" }),
      cleanupProcesses: async () => {
        cleanupCalls += 1;
        return true;
      },
      maxOutputBytes: 8,
    }),
  );
  assert.deepEqual(outcome, {
    status: "failed",
    code: "LINUX_SECRET_SERVICE_SUPERVISOR_OUTPUT_INVALID",
  });
  assert.equal(cleanupCalls, 1);
});

test("Linux Secret Service cleanup escalates exact identities from TERM to KILL", async () => {
  const group = Object.freeze({
    pid: 42,
    executable: "/usr/bin/dbus-run-session",
    startTime: "100",
  });
  const daemon = Object.freeze({
    pid: 43,
    executable: "/usr/bin/gnome-keyring-daemon",
    startTime: "101",
  });
  const events = [];
  const cleanupConfirmed = await cleanupLinuxQualificationProcesses(group, {
    signalGroup: async (identity, signal) => {
      events.push(["group", identity, signal]);
    },
    listProcesses: async () => {
      events.push(["list"]);
      return [daemon];
    },
    signalIdentity: async (identity, signal) => {
      events.push(["identity", identity, signal]);
    },
    waitForExit: async (deadlineMs) => {
      events.push(["wait", deadlineMs]);
      return false;
    },
    cleanupDeadlineMs: 123,
    killCleanupDeadlineMs: 17,
  });
  assert.equal(cleanupConfirmed, false);
  assert.deepEqual(events, [
    ["group", group, "SIGTERM"],
    ["list"],
    ["identity", daemon, "SIGTERM"],
    ["wait", 123],
    ["group", group, "SIGKILL"],
    ["list"],
    ["identity", daemon, "SIGKILL"],
    ["wait", 17],
  ]);
});

test("Linux Secret Service cleanup accepts a proved post-KILL exit", async () => {
  const waits = [];
  const cleanupConfirmed = await cleanupLinuxQualificationProcesses(
    Object.freeze({
      pid: 42,
      executable: "/usr/bin/dbus-run-session",
      startTime: "100",
    }),
    {
      signalGroup: async () => {},
      listProcesses: async () => [],
      signalIdentity: async () => {},
      waitForExit: async (deadlineMs) => {
        waits.push(deadlineMs);
        return waits.length === 2;
      },
      cleanupDeadlineMs: 123,
      killCleanupDeadlineMs: 17,
    },
  );
  assert.equal(cleanupConfirmed, true);
  assert.deepEqual(waits, [123, 17]);
});

test("Linux Secret Service signaling rejects PID-reused identities", async () => {
  const expected = Object.freeze({
    pid: 42,
    executable: "/usr/bin/gnome-keyring-daemon",
    startTime: "100",
  });
  const signals = [];
  const killProcess = (pid, signal) => signals.push([pid, signal]);
  const startTimeChanged = await signalLinuxProcessIdentity(expected, "SIGTERM", {
    readIdentity: async () => Object.freeze({ ...expected, startTime: "101" }),
    killProcess,
  });
  const executableChanged = await signalLinuxProcessIdentity(expected, "SIGTERM", {
    readIdentity: async () => Object.freeze({
      ...expected,
      executable: "/usr/bin/dbus-daemon",
    }),
    killProcess,
  });
  const exactGroup = await signalLinuxProcessIdentity(expected, "SIGKILL", {
    asProcessGroup: true,
    readIdentity: async () => expected,
    killProcess,
  });
  assert.equal(startTimeChanged, false);
  assert.equal(executableChanged, false);
  assert.equal(exactGroup, true);
  assert.deepEqual(signals, [[-42, "SIGKILL"]]);
});
