import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { parseArgs, run } from "../src/cli.js";

async function captureLogs(callback) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await callback();
    return lines.join("\n");
  } finally {
    console.log = original;
  }
}

test("device pairing origin is command-specific", () => {
  assert.equal(
    parseArgs(["pair-contribution-device", "--origin", "https://usage.example"]).serviceOrigin,
    "https://usage.example",
  );
  assert.throws(
    () => parseArgs(["doctor", "--origin", "https://usage.example"]),
    /available only for contribution-device commands/,
  );
  assert.equal(
    parseArgs([
      "sync-contributions-once",
      "--directory",
      "./prepared",
      "--origin",
      "https://usage.example",
      "--max-uploads-per-pass",
      "7",
      "--max-upload-bytes-per-pass",
      "65536",
    ]).serviceOrigin,
    "https://usage.example",
  );
  assert.equal(
    parseArgs([
      "sync-contributions-watch",
      "--directory",
      "./prepared",
      "--origin",
      "https://usage.example",
      "--interval-seconds",
      "30",
    ]).intervalSeconds,
    30,
  );
  assert.throws(
    () => parseArgs(["doctor", "--queue-file", "./private.sqlite3"]),
    /available only for contribution-sync commands/,
  );
  assert.throws(
    () => parseArgs([
      "sync-contributions-once",
      "--max-uploads-per-pass",
      "0",
    ]),
    /integer from 1 to 100/,
  );
  assert.throws(
    () => parseArgs([
      "sync-contributions-watch",
      "--max-upload-bytes-per-pass",
      "16383",
    ]),
    /integer from 16384 to 268435456/,
  );
});

test("queue-backed one-shot sync prints only bounded aggregate status", async () => {
  const backend = {};
  const output = await captureLogs(() => run([
    "sync-contributions-once",
    "--directory",
    "./prepared",
    "--origin",
    "https://usage.example",
  ], {
    createContributionDeviceBackend: () => backend,
    runContributionSyncQueueOnceCommand: async (options) => {
      assert.equal(options.backend, backend);
      assert.equal(options.origin, "https://usage.example");
      assert.equal(options.maximumJobs, undefined);
      assert.equal(options.maximumReservedUploadBytes, undefined);
      return {
        status: "completed",
        discoveredSets: 1,
        enqueued: 2,
        processed: 2,
        accepted: 2,
        reservedUploadBytes: 24_000,
        bandwidthLimited: false,
        queue: {
          paused: false,
          counts: { retryable: 0, rejected: 0 },
        },
      };
    },
  }));
  assert.match(output, /Committed sets discovered: 1; newly queued: 2/);
  assert.match(output, /accepted or replayed: 2/i);
  assert.doesNotMatch(output, /usage\.example|prepared/);
});

test("inspect-next prints only a bounded local projection", async () => {
  const privateDirectory = resolve("/private/canary/prepared-spool");
  const privateQueue = resolve("/private/canary/queue.sqlite3");
  const output = await captureLogs(() => run([
    "sync-contributions-inspect-next",
    "--directory",
    privateDirectory,
    "--queue-file",
    privateQueue,
  ], {
    inspectNextContributionSyncUploadCommand: async (options) => {
      assert.equal(options.directory, privateDirectory);
      assert.equal(options.queueFile, privateQueue);
      return {
        state: "ready",
        discoveredSets: 2,
        enqueued: 1,
        item: {
          coveredAt: {
            startAt: "2026-07-26T10:00:00.000Z",
            endAt: "2026-07-26T10:10:00.000Z",
          },
          recordCounts: {
            usageEvents: 3,
            quotaSnapshots: 2,
            activityMarkers: 1,
            total: 6,
          },
          accounting: {
            estimatedApiCostUsd: "1.250000",
            pricedEventCoveragePercent: 80,
            unknownModelEventCount: 1,
            unknownBillableUnits: 2,
          },
          preparedBytes: 4096,
          reservedUploadBytes: 16_384,
          attemptCount: 0,
          nextAttemptAt: "2026-07-26T10:10:00.000Z",
        },
      };
    },
  }));
  assert.match(output, /Next contribution upload: ready/);
  assert.match(output, /Records: 6 \(3 usage, 2 quota, 1 activity\)/);
  assert.match(output, /conservative upload reservation: 16384/i);
  assert.match(output, /Network activity: none/);
  assert.doesNotMatch(
    output,
    /\/private\/|canary|prepared-spool|queue\.sqlite3|contribution:/,
  );
});

test("status and pause lifecycle remain local and content-free", async () => {
  const privateCanary = resolve("/private/canary/queue.sqlite3");
  const status = {
    paused: false,
    dueNow: 1,
    counts: {
      pending: 1,
      in_flight: 0,
      retryable: 2,
      accepted: 3,
      rejected: 4,
    },
  };
  const statusOutput = await captureLogs(() => run([
    "sync-contributions-status",
    "--queue-file",
    privateCanary,
  ], {
    inspectContributionSyncQueueCommand: async ({ queueFile }) => {
      assert.equal(queueFile, privateCanary);
      return status;
    },
  }));
  assert.match(statusOutput, /Pending: 1/);
  assert.match(statusOutput, /Accepted: 3; rejected: 4/);
  assert.doesNotMatch(statusOutput, /private|canary|sqlite/);

  const pauseOutput = await captureLogs(() => run([
    "sync-contributions-pause",
    "--queue-file",
    privateCanary,
  ], {
    setContributionSyncPausedCommand: async ({ paused, queueFile }) => {
      assert.equal(paused, true);
      assert.equal(queueFile, privateCanary);
      return { ...status, paused: true };
    },
  }));
  assert.match(pauseOutput, /queue: paused/);
  assert.match(pauseOutput, /Network activity: none/);
  assert.doesNotMatch(pauseOutput, /private|canary|sqlite/);
});

test("foreground watch reports bounded totals and never claims installation", async () => {
  const backend = {};
  const output = await captureLogs(() => run([
    "sync-contributions-watch",
    "--directory",
    "./prepared-spool",
    "--origin",
    "https://usage.example",
    "--interval-seconds",
    "30",
    "--duration-ms",
    "1000",
    "--max-uploads-per-pass",
    "7",
    "--max-upload-bytes-per-pass",
    "65536",
  ], {
    createContributionDeviceBackend: () => backend,
    runContributionSyncQueueWatchCommand: async (options) => {
      assert.equal(options.backend, backend);
      assert.equal(options.intervalSeconds, 30);
      assert.equal(options.durationMilliseconds, 1000);
      assert.equal(options.maximumJobs, 7);
      assert.equal(options.maximumReservedUploadBytes, 65_536);
      assert.equal(options.signal instanceof AbortSignal, true);
      return {
        status: "completed",
        passes: 2,
        enqueued: 1,
        processed: 1,
        accepted: 1,
        reservedUploadBytes: 12_000,
        bandwidthLimitedPasses: 0,
        queue: {
          paused: false,
          counts: { retryable: 0, rejected: 0 },
        },
      };
    },
  }));
  assert.match(output, /Foreground contribution watch: completed/);
  assert.match(output, /Installed background service: false/);
  assert.doesNotMatch(
    output,
    /prepared-spool|usage\.example|Device|Upload um_|contribution:/,
  );
});

test("device pairing CLI keeps the pairing capability and device identity out of output", async () => {
  const pairingCode = `um_pair_22222222-2222-4222-8222-222222222222.${"A".repeat(43)}`;
  const deviceId = "11111111-1111-4111-8111-111111111111";
  const backend = {};
  let received = null;
  const output = await captureLogs(() => run([
    "pair-contribution-device",
    "--origin",
    "https://usage.example",
  ], {
    readPairingCode: async () => pairingCode,
    createContributionDeviceBackend: () => backend,
    claimContributionDevicePairingCommand: async (options) => {
      received = options;
      return {
        status: "paired",
        scope: "upload_registration",
        expiresAt: "2026-08-25T12:00:00.000Z",
        deviceId,
      };
    },
  }));
  assert.equal(received.pairingCode, pairingCode);
  assert.equal(received.capabilityOptions.backend, backend);
  assert.match(output, /pairing: active/);
  assert.match(output, /Upload-only scope: upload_registration/);
  assert.doesNotMatch(output, /um_pair_|11111111|usage\.example/);
});
