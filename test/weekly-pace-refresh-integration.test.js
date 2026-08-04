import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReplaySafeAccountingCache,
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";

const NOW = Date.parse("2026-08-03T12:45:00.000Z");
const RESETS_AT = Math.floor(Date.parse("2026-08-10T12:00:00.000Z") / 1_000);

function accountScope(letter) {
  return {
    status: "available",
    reason: null,
    version: "openai-account-v1",
    scopeId: `openai-account:v1:${letter.repeat(43)}`,
    planType: "pro",
  };
}

function snapshot({ timestamp, usedPercent, account = null, slot = "secondary" }) {
  return {
    timestamp,
    timestampMs: Date.parse(timestamp),
    ...(account === null ? {} : { accountScope: accountScope(account) }),
    receivedAt: timestamp,
    window: {
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot,
      windowDurationMins: 10_080,
      resetsAt: RESETS_AT,
      usedPercent,
    },
  };
}

function build(snapshots, now = NOW) {
  return buildReplaySafeAccountingCache({
    now: () => now,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const row of snapshots) onRateLimitSnapshot(row);
      return { diagnostics: {} };
    },
  });
}

test("refresh projects a safe account-scoped weekly pace ETA", async () => {
  const cache = await build([
    snapshot({
      timestamp: "2026-08-03T12:15:00.000Z",
      usedPercent: 20,
      account: "A",
    }),
    snapshot({
      timestamp: "2026-08-03T12:30:00.000Z",
      usedPercent: 30,
      account: "A",
    }),
  ]);

  assert.deepEqual(cache.weekly.paceForecast, {
    status: "available",
    currentUsedPercent: 30,
    remainingPercent: 70,
    resetsAt: "2026-08-10T12:00:00.000Z",
    pace: { percentagePointsPerHour: 40 },
    etaAt: "2026-08-03T14:15:00.000Z",
    hoursToExhaustion: 1.75,
    hoursToReset: 167.5,
  });
  const serialized = JSON.stringify(cache.weekly);
  assert.equal(serialized.includes("openai-account:"), false);
  assert.equal(serialized.includes("accountTrackId"), false);
  assert.equal(cache.quotaTimeline[0].accountAttribution, "historical_unattributed");
});

test("owner-only refresh retains the safe pace card through cache validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-pace-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const written = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(snapshot({
        timestamp: "2026-08-03T12:15:00.000Z",
        usedPercent: 20,
        account: "A",
      }));
      onRateLimitSnapshot(snapshot({
        timestamp: "2026-08-03T12:30:00.000Z",
        usedPercent: 30,
        account: "A",
      }));
      return { diagnostics: {} };
    },
  });
  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "available");
  assert.deepEqual(read.cache.weekly, written.weekly);
});

test("pace refresh never combines observations from different account scopes", async () => {
  const cache = await build([
    snapshot({
      timestamp: "2026-08-03T12:05:00.000Z",
      usedPercent: 10,
      account: "A",
    }),
    snapshot({
      timestamp: "2026-08-03T12:15:00.000Z",
      usedPercent: 20,
      account: "A",
    }),
    snapshot({
      timestamp: "2026-08-03T12:30:00.000Z",
      usedPercent: 30,
      account: "B",
    }),
  ]);

  assert.equal(cache.weekly.paceForecast.status, "insufficient_observations");
  assert.equal(cache.weekly.paceForecast.pace.percentagePointsPerHour, null);
  assert.equal(cache.weekly.paceForecast.etaAt, null);
});

test("unattributed history is omitted from the pace forecast", async () => {
  const cache = await build([
    snapshot({
      timestamp: "2026-08-03T12:15:00.000Z",
      usedPercent: 20,
    }),
    snapshot({
      timestamp: "2026-08-03T12:30:00.000Z",
      usedPercent: 30,
    }),
  ]);

  assert.equal(Object.hasOwn(cache, "weekly"), false);
});

test("stale and backward account-scoped history fail closed", async (t) => {
  await t.test("stale current observation", async () => {
    const cache = await build([
      snapshot({
        timestamp: "2026-08-03T12:05:00.000Z",
        usedPercent: 10,
        account: "A",
      }),
      snapshot({
        timestamp: "2026-08-03T12:20:00.000Z",
        usedPercent: 20,
        account: "A",
      }),
    ], Date.parse("2026-08-03T13:30:00.000Z"));
    assert.equal(cache.weekly.paceForecast.status, "unavailable");
    assert.equal(cache.weekly.paceForecast.pace.percentagePointsPerHour, null);
    assert.equal(cache.weekly.paceForecast.etaAt, null);
  });

  await t.test("backward movement", async () => {
    const cache = await build([
      snapshot({
        timestamp: "2026-08-03T12:15:00.000Z",
        usedPercent: 30,
        account: "A",
      }),
      snapshot({
        timestamp: "2026-08-03T12:30:00.000Z",
        usedPercent: 20,
        account: "A",
      }),
    ]);
    assert.equal(cache.weekly.paceForecast.status, "unavailable");
    assert.equal(cache.weekly.paceForecast.etaAt, null);
  });
});
