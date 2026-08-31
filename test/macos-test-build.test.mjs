import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
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

async function retainedMenuBarOverviewFixture() {
  const nowMs = Date.now() - 1_000;
  const generatedAt = new Date(nowMs - 60_000).toISOString();
  const coveredAt = {
    startAt: new Date(nowMs - 30 * 24 * 60 * 60_000).toISOString(),
    endAt: generatedAt,
  };
  const pricingCoverage = { fullyPricedEvents: 2, partiallyPricedEvents: 1, unpricedEvents: 1 };
  const periods = ["24h", "7d", "30d"].map((periodId) => ({
    periodId, events: 4, totalTokens: 1_000, apiPriceEquivalentUsd: .2, pricingCoverage,
  }));
  const bucketEndMs = Math.floor((nowMs - 60_000) / 900_000) * 900_000;
  let candidate = {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    mode: "real_local_evidence",
    generatedAt,
    overview: {
      evidenceStatus: "available",
      freshness: { status: "live", accountingStatus: "available", staleAfterSeconds: 600 },
      quotaWindows: [{
        limitId: "codex", slot: "primary", durationMinutes: 10_080,
        remainingPercent: 80, usedPercent: 20, observedAt: generatedAt,
        resetAt: new Date(nowMs + 6 * 24 * 60 * 60_000).toISOString(),
      }],
      accounting: {
        sourceMode: "unified", generation: 1, generationMatched: true,
        generatedAt, coveredAt, events: 4, periods,
        projection: { status: "available", reason: null, terminal: false },
      },
      usage: periods.map(({ periodId, ...period }) => ({ id: periodId, ...period })),
      timeline: {
        source: "unified_local_index", coveredAt, bucketMinutes: 15,
        history: { status: "complete", coveredAt, generatedAt },
        usage: [{
          startAt: new Date(bucketEndMs - 900_000).toISOString(),
          endAt: new Date(bucketEndMs).toISOString(),
          usageEvents: 4, totalTokens: 1_000, apiPriceEquivalentUsd: .2, pricingCoverage,
        }],
      },
    },
    gradient: {}, weekly: {}, quality: {},
  };
  const store = new LocalCompanionDataStore({ builder: async () => candidate });
  await store.reload({ purpose: "full" });
  candidate = structuredClone(candidate);
  candidate.generatedAt = new Date(nowMs).toISOString();
  candidate.overview.freshness.accountingStatus = "unavailable";
  Object.assign(candidate.overview.quotaWindows[0], {
    observedAt: candidate.generatedAt, remainingPercent: 75, usedPercent: 25,
  });
  Object.assign(candidate.overview.accounting, {
    generation: 2, generationMatched: false, events: 0, periods: [],
    generatedAt: candidate.generatedAt, coveredAt: { startAt: null, endAt: null },
    projection: { status: "unavailable", reason: "local_unified_index_deferred", terminal: false },
  });
  candidate.overview.usage = [];
  Object.assign(candidate.overview.timeline, {
    source: "insufficient_evidence", coveredAt: { startAt: null, endAt: null },
    history: { status: "loading" }, usage: [],
  });
  await store.reload({ purpose: "quick" });
  return store.getOverview();
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
      /phases=allowlisted[\s\S]*unified=scanning[\s\S]*accounting=calculating[\s\S]*counts=bounded[\s\S]*quick_result=evidence-gated[\s\S]*unknown=generic[\s\S]*free_text=ignored/u,
    );
    const menuBarSmoke = spawnSync(
      launcher,
      ["--menu-bar-contract-smoke-test"],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(
      menuBarSmoke.status,
      0,
      menuBarSmoke.error?.message ?? menuBarSmoke.stderr,
    );
    assert.match(
      menuBarSmoke.stdout,
      /history=authoritative,coverage-named,fail-closed[\s\S]*history_retention=refresh,failure,source-reset/u,
    );
    assert.match(
      menuBarSmoke.stdout,
      /dismissal=escape,transient,same-app,outside,deactivation/u,
    );
    const retainedOverviewFixture = join(temporaryRoot, "retained-menu-bar-overview.json");
    const retainedOverview = await retainedMenuBarOverviewFixture();
    assert.equal(retainedOverview.accounting.projection.status, "retained");
    assert.equal(retainedOverview.accounting.generationMatched, false);
    const overviewRenderDirectory = join(temporaryRoot, "retained-menu-bar-render");
    await writeFile(retainedOverviewFixture, `${JSON.stringify(retainedOverview)}\n`, {
      encoding: "utf8", mode: 0o600,
    });
    const overviewRenderSmoke = spawnSync(launcher, [
      "--menu-bar-overview-render-smoke-test", retainedOverviewFixture, overviewRenderDirectory,
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(
      overviewRenderSmoke.status, 0,
      overviewRenderSmoke.error?.message ?? overviewRenderSmoke.stderr,
    );
    assert.match(overviewRenderSmoke.stdout,
      /USAGE_MONITOR_MACOS_MENU_BAR_OVERVIEW_RENDER ranges=7d,30d states=ready,updating,read-failure history=preserved freshness=labelled current_quota=cleared-on-failure/u);
    assert.deepEqual((await readdir(overviewRenderDirectory)).sort(),
      ["ready", "updating", "read-failure"].flatMap((state) => (
        ["7d", "30d"].map((range) => `${state}-${range}.png`)
      )).sort());
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
