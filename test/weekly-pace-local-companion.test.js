import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import {
  commitLocalCollectorState,
  defaultLocalCollectorStatePath,
  prepareLocalCollectorState,
} from "../src/local-collector-state.js";
import {
  projectWeeklyPaceForecast,
  weeklyPaceSnapshotsFromCollectorRecord,
} from "../src/weekly-pace-projection.js";

const NOW = Date.parse("2026-08-03T12:30:00.000Z");
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

function quotaRecord({
  observedAt,
  usedPercent,
  account = "A",
  source = "app_server_read",
}) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt,
    receivedAt: observedAt,
    stalenessMs: 0,
    source,
    accountScope: account === null ? {
      status: "unavailable",
      reason: "missing_secret",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    } : accountScope(account),
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "secondary",
      windowDurationMins: 10_080,
      resetsAt: RESETS_AT,
      usedPercent,
    }],
  };
}

// These fixtures exercise the current owner-only SQLite state directly.
// Legacy JSON migration remains covered by local-collector-state.test.js.
async function writeCollectorState(root, records) {
  const stateFile = defaultLocalCollectorStatePath(root);
  await prepareLocalCollectorState({ stateFile, clock: () => NOW });
  await commitLocalCollectorState({
    stateFile,
    checkpoint: {},
    records,
    clock: () => NOW,
  });
}

test("local companion sends a private account-scoped pace ETA as a safe public projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "weekly-pace-local-companion-"));
  const stateFile = defaultLocalCollectorStatePath(root);
  const records = [
    quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 20 }),
    quotaRecord({ observedAt: "2026-08-03T12:30:00.000Z", usedPercent: 30 }),
  ];
  try {
    await writeCollectorState(root, records);
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => NOW,
      allowDevelopmentArtifactFallback: false,
    });
    assert.deepEqual(snapshot.weekly.paceForecast, {
      schemaVersion: "local-weekly-pace-forecast-v0.1",
      status: "available",
      currentUsedPercent: 30,
      remainingPercent: 70,
      resetsAt: "2026-08-10T12:00:00.000Z",
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: 1,
        elapsedHours: 0.25,
        movementPp: 10,
        percentagePointsPerHour: 40,
      },
      observationCount: 2,
      etaAt: "2026-08-03T14:15:00.000Z",
      hoursToExhaustion: 1.75,
      hoursToReset: 167.5,
    });
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(accountScope("A").scopeId), false);
    assert.equal(serialized.includes("accountScope"), false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the local pace adapter refuses an unattributed or non-app-server current observation", () => {
  const prior = quotaRecord({
    observedAt: "2026-08-03T12:15:00.000Z",
    usedPercent: 20,
  });
  const current = quotaRecord({
    observedAt: "2026-08-03T12:30:00.000Z",
    usedPercent: 30,
    account: null,
  });
  const observations = [prior, current].flatMap(
    weeklyPaceSnapshotsFromCollectorRecord,
  );
  assert.equal(projectWeeklyPaceForecast({
    currentRecord: current,
    observations,
    nowMs: NOW,
  }).status, "unavailable");

  const untrustedCurrent = quotaRecord({
    observedAt: "2026-08-03T12:30:00.000Z",
    usedPercent: 30,
    source: "rollout_log",
  });
  assert.equal(projectWeeklyPaceForecast({
    currentRecord: untrustedCurrent,
    observations,
    nowMs: NOW,
  }).status, "unavailable");
});

test("local companion retains one safe observation as a non-predictive waiting state", async () => {
  const root = await mkdtemp(join(tmpdir(), "weekly-pace-waiting-state-"));
  const stateFile = defaultLocalCollectorStatePath(root);
  const records = [
    quotaRecord({ observedAt: "2026-08-03T12:15:00.000Z", usedPercent: 20 }),
  ];
  try {
    await writeCollectorState(root, records);
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: stateFile,
      now: () => NOW,
      allowDevelopmentArtifactFallback: false,
    });
    assert.deepEqual(snapshot.weekly.paceForecast, {
      schemaVersion: "local-weekly-pace-forecast-v0.1",
      status: "insufficient_observations",
      currentUsedPercent: 20,
      remainingPercent: 80,
      resetsAt: "2026-08-10T12:00:00.000Z",
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: 0,
        elapsedHours: 0,
        movementPp: 0,
        percentagePointsPerHour: null,
      },
      observationCount: 1,
      etaAt: null,
      hoursToExhaustion: null,
      hoursToReset: 167.75,
    });
  } finally {
    await rm(root, { recursive: true });
  }
});
