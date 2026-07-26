import test from "node:test";
import assert from "node:assert/strict";

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
    ]).serviceOrigin,
    "https://usage.example",
  );
});

test("one-shot sync prints only bounded batch status", async () => {
  const backend = {};
  const output = await captureLogs(() => run([
    "sync-contributions-once",
    "--directory",
    "./prepared",
    "--origin",
    "https://usage.example",
  ], {
    createContributionDeviceBackend: () => backend,
    syncPreparedContributionSetOnceCommand: async (options) => {
      assert.equal(options.backend, backend);
      assert.equal(options.origin, "https://usage.example");
      return {
        status: "succeeded",
        preparedSetBatches: 2,
        accepted: [
          { contributionId: "PRIVATE_ONE" },
          { contributionId: "PRIVATE_TWO" },
        ],
      };
    },
  }));
  assert.match(output, /Committed privacy-safe batches: 2/);
  assert.match(output, /Accepted or replayed: 2/);
  assert.doesNotMatch(output, /PRIVATE_ONE|PRIVATE_TWO|usage\.example|prepared/);
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
