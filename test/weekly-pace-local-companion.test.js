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
  projectWeeklyPaceOutlook,
  weeklyPaceSnapshotsFromCollectorRecord,
} from "../src/weekly-pace-projection.js";
import {
  normalizeDashboardPayload,
} from "../apps/web/public/data-client.js";

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
      schemaVersion: "local-weekly-pace-forecast-v0.2",
      status: "available",
      currentUsedPercent: 30,
      remainingPercent: 70,
      resetsAt: "2026-08-10T12:00:00.000Z",
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: 1,
        elapsedHours: 0.25,
        movementPp: 10,
        // One 15-minute interval that moved, so the working rate and the
        // wall-clock rate are the same 40pp/hour here.
        activePercentagePointsPerHour: 40,
        overallPercentagePointsPerHour: 40,
      },
      observationCount: 2,
      etaAt: "2026-08-03T14:15:00.000Z",
      hoursToExhaustion: 1.75,
      hoursToReset: 167.5,
    });
    assert.deepEqual(snapshot.weekly.paceOutlook, {
      schemaVersion: "local-weekly-pace-outlook-v0.1",
      status: "available",
      standing: "over",
      critical: true,
      earlyEstimate: true,
      remainingPercent: 70,
      resetsAt: "2026-08-10T12:00:00.000Z",
      observationCount: 2,
      elapsedHours: 0.25,
      rates: {
        activePercentagePointsPerHour: 40,
        overallPercentagePointsPerHour: 40,
        headlinePercentagePointsPerHour: 40,
        sustainablePercentagePointsPerHour: 0.417910447761194,
        ratio: 95.71428571428572,
      },
      projection: {
        hoursToReset: 167.5,
        coveredHours: 1.75,
        dryHours: 165.75,
        sparePercent: 0,
        projectedExhaustionAt: "2026-08-03T14:15:00.000Z",
      },
      track: {
        coveredFraction: 0.010447761194029851,
        activeExhaustionFraction: null,
      },
    });
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(accountScope("A").scopeId), false);
    assert.equal(serialized.includes("accountScope"), false);
    assert.doesNotMatch(
      JSON.stringify(snapshot.weekly.paceOutlook),
      /account|scope|path|credit|redeem|token|provider/iu,
    );
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
      schemaVersion: "local-weekly-pace-forecast-v0.2",
      status: "insufficient_observations",
      currentUsedPercent: 20,
      remainingPercent: 80,
      resetsAt: "2026-08-10T12:00:00.000Z",
      pace: {
        method: "median_adjacent_quota_slope",
        sampleCount: 0,
        elapsedHours: 0,
        movementPp: 0,
        activePercentagePointsPerHour: null,
        overallPercentagePointsPerHour: null,
      },
      observationCount: 1,
      etaAt: null,
      hoursToExhaustion: null,
      hoursToReset: 167.75,
    });
    assert.deepEqual(snapshot.weekly.paceOutlook, {
      schemaVersion: "local-weekly-pace-outlook-v0.1",
      status: "collecting",
      standing: null,
      critical: false,
      earlyEstimate: false,
      remainingPercent: 80,
      resetsAt: "2026-08-10T12:00:00.000Z",
      observationCount: 1,
      elapsedHours: 0,
      rates: {
        activePercentagePointsPerHour: null,
        overallPercentagePointsPerHour: null,
        headlinePercentagePointsPerHour: null,
        sustainablePercentagePointsPerHour: null,
        ratio: null,
      },
      projection: {
        hoursToReset: 167.5,
        coveredHours: null,
        dryHours: null,
        sparePercent: null,
        projectedExhaustionAt: null,
      },
      track: {
        coveredFraction: null,
        activeExhaustionFraction: null,
      },
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the projection the companion publishes survives the browser boundary", () => {
  // Three files hold an independent exact-key check on this payload: the
  // engine builds it, `publicForecast` republishes it, and the browser's
  // `normalizeWeeklyPaceForecast` refuses anything whose shape or schema
  // version it does not recognise. Each layer has its own tests, and all of
  // them would still pass if a field were renamed in two places out of three -
  // the card would simply stop rendering, silently, in production only.
  //
  // This is the assertion that closes that gap: a real projection, run through
  // the real browser validator, must come back byte-identical.
  const observations = [];
  for (let minute = 0; minute < 240; minute += 10) {
    observations.push(quotaRecord({
      observedAt: new Date(Date.parse("2026-08-03T08:00:00.000Z") + minute * 60_000)
        .toISOString(),
      usedPercent: minute < 20 ? 0 : 1,
    }));
  }
  const snapshots = observations.flatMap(weeklyPaceSnapshotsFromCollectorRecord);
  const forecast = projectWeeklyPaceForecast({
    currentRecord: quotaRecord({
      observedAt: "2026-08-03T12:00:00.000Z",
      usedPercent: 1,
    }),
    observations: snapshots,
    nowMs: NOW,
  });
  const outlook = projectWeeklyPaceOutlook({ forecast, nowMs: NOW });

  // Dense polling with one moving interval: the two rates must be far apart,
  // or this fixture is not exercising the thing it exists to protect.
  assert.equal(forecast.pace.activePercentagePointsPerHour, 6);
  assert.equal(forecast.pace.overallPercentagePointsPerHour, 0.25);

  const normalized = normalizeDashboardPayload({
    weekly: { paceForecast: forecast, paceOutlook: outlook },
  });
  assert.deepEqual(normalized.weekly.paceForecast, forecast);
  assert.deepEqual(normalized.weekly.paceOutlook, outlook);
});
