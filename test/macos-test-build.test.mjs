import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MACOS_BUILD_PROFILES,
  buildMacOSApp,
} from "../scripts/build-macos-app.js";
import {
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
} from "../src/local-companion-data.js";
import {
  WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION,
} from "../src/weekly-pace-projection.js";

const BUILD_SUPPORTED =
  process.platform === "darwin"
  && process.arch === "arm64"
  && process.version === "v26.2.0";

const WEEKLY_PACE_FIXTURE_NOW_MS = Date.parse("2026-08-03T12:30:00.000Z");

async function currentWeeklyPaceFixture() {
  const hoursToReset = 100;
  const remainingPercent = 50;
  const overallRate = .75;
  const resetsAt = new Date(
    WEEKLY_PACE_FIXTURE_NOW_MS + hoursToReset * 60 * 60_000,
  ).toISOString();
  const hoursToExhaustion = remainingPercent / overallRate;
  const forecast = {
    schemaVersion: "local-weekly-pace-forecast-v0.2",
    status: "available",
    currentUsedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt,
    pace: {
      method: "median_adjacent_quota_slope",
      sampleCount: 2,
      elapsedHours: 2,
      movementPp: overallRate * 2,
      activePercentagePointsPerHour: 1,
      overallPercentagePointsPerHour: overallRate,
    },
    observationCount: 3,
    etaAt: new Date(
      WEEKLY_PACE_FIXTURE_NOW_MS + hoursToExhaustion * 60 * 60_000,
    ).toISOString(),
    hoursToExhaustion,
    hoursToReset,
  };
  const store = new LocalCompanionDataStore({
    builder: async () => ({
      schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
      mode: "real_local_evidence",
      generatedAt: new Date(WEEKLY_PACE_FIXTURE_NOW_MS).toISOString(),
      overview: {},
      gradient: {},
      weekly: {
        datasets: {},
        paceForecast: forecast,
      },
      quality: {},
      reports: [],
    }),
  });
  await store.reload({ purpose: "full" });
  const paceOutlook = store.getWeeklyPaceOutlook({
    nowMs: WEEKLY_PACE_FIXTURE_NOW_MS,
  });
  assert.equal(
    paceOutlook.schemaVersion,
    WEEKLY_PACE_OUTLOOK_SCHEMA_VERSION,
  );
  assert.equal(paceOutlook.status, "available");
  assert.equal(paceOutlook.standing, "over");
  assert.equal(paceOutlook.critical, false);
  return { weekly: { paceOutlook } };
}

test("test compiler profile builds a development-only launcher that runs", {
  skip: BUILD_SUPPORTED ? false : "requires pinned macOS arm64 Node v26.2.0 builder",
  timeout: 90_000,
}, async () => {
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-macos-test-profile-"),
  );
  const output = join(temporaryRoot, "TiboTattle.app");
  try {
    const build = await buildMacOSApp({
      output,
      buildProfile: MACOS_BUILD_PROFILES.test,
    });
    assert.deepEqual(
      {
        buildProfile: build.buildProfile,
        channel: build.channel,
        externalDistributionRequested: build.externalDistributionRequested,
        updaterEnabled: build.updaterEnabled,
      },
      {
        buildProfile: MACOS_BUILD_PROFILES.test,
        channel: "development",
        externalDistributionRequested: false,
        updaterEnabled: false,
      },
    );
    const launcher = join(output, "Contents", "MacOS", "TiboTattle");
    const smoke = spawnSync(launcher, ["--updater-contract-smoke-test"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(smoke.status, 0, smoke.error?.message ?? smoke.stderr);
    assert.match(smoke.stdout, /runtime=development_disabled/u);
    const progressSmoke = spawnSync(
      launcher,
      ["--native-analysis-progress-contract-smoke-test"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(
      progressSmoke.status,
      0,
      progressSmoke.error?.message ?? progressSmoke.stderr,
    );
    assert.match(
      progressSmoke.stdout,
      /phases=allowlisted[\s\S]*unified=scanning[\s\S]*counts=bounded[\s\S]*quick_result=evidence-gated[\s\S]*unknown=generic[\s\S]*free_text=ignored/u,
    );
    const weeklyPaceFixture = join(temporaryRoot, "weekly-pace-outlook.json");
    await writeFile(
      weeklyPaceFixture,
      `${JSON.stringify(await currentWeeklyPaceFixture())}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const weeklyPaceSmoke = spawnSync(
      launcher,
      [
        "--native-weekly-pace-projection-contract-smoke-test",
        weeklyPaceFixture,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(
      weeklyPaceSmoke.status,
      0,
      weeklyPaceSmoke.error?.message ?? weeklyPaceSmoke.stderr,
    );
    assert.match(
      weeklyPaceSmoke.stdout,
      /schema=exact-v0\.1 status=available standing=over binding=exact mismatch=rejected schema_mismatch=rejected/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
