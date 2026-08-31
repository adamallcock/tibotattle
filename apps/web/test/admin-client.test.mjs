import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AdminResponseError,
  adminActionErrorMessage,
  adminResponseError,
  projectAdminAllowancePreview,
  projectAdminAction,
  projectAdminMetricsHistory,
  projectAdminOverview,
} from "../public/admin-client.js";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/${name}`, import.meta.url),
  "utf8",
));

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

function emptyAllowanceSummary() {
  return {
    fitCount: 0,
    participantCount: 0,
    centralUsd: null,
    band80Usd: null,
  };
}

function allowancePreviewPayload() {
  const fromMs = Date.parse("2026-06-15T00:00:00.000Z");
  const days = Array.from({ length: 70 }, (_, index) => ({
    day: new Date(fromMs + index * DAY_MILLISECONDS).toISOString().slice(0, 10),
    combined: emptyAllowanceSummary(),
    byPlanType: {
      pro: emptyAllowanceSummary(),
      prolite: emptyAllowanceSummary(),
      plus: emptyAllowanceSummary(),
    },
  }));
  days.at(-1).combined = {
    fitCount: 6,
    participantCount: 4,
    centralUsd: 2_100,
    band80Usd: { lowerUsd: 1_800, upperUsd: 2_400 },
  };
  days.at(-1).byPlanType = {
    pro: {
      fitCount: 2,
      participantCount: 2,
      centralUsd: 2_050,
      band80Usd: null,
    },
    prolite: {
      fitCount: 1,
      participantCount: 1,
      centralUsd: 2_200,
      band80Usd: null,
    },
    plus: {
      fitCount: 3,
      participantCount: 2,
      centralUsd: 1_900,
      band80Usd: { lowerUsd: 1_700, upperUsd: 2_100 },
    },
  };
  return {
    schemaVersion: "admin-community-allowance-preview-v0.2",
    generatedAt: "2026-08-23T10:30:00.000Z",
    from: "2026-06-15",
    to: "2026-08-23",
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_preview",
    referencePlanType: "pro",
    trailingDays: 30,
    qualification: "shared_reset_fit_gates_40pp_span_floor",
    spanFloorPp: 40,
    plans: [
      { planType: "pro", label: "Pro 20x", multiplier: 1 },
      { planType: "prolite", label: "Pro 5x", multiplier: 4 },
      { planType: "plus", label: "Plus", multiplier: 20 },
    ],
    days,
    models: {
      modelConfig: [
        { modelId: "gpt-5.6-sol", label: "Sol" },
        { modelId: "gpt-5.6-terra", label: "Terra" },
        { modelId: "gpt-5.6-luna", label: "Luna" },
        { modelId: "gpt-5.5", label: "GPT-5.5" },
      ],
      basis: "seven_day_codex_pro20x_equivalent_per_model_composition",
      gate: "shared_composition_kernel_identification",
      days: [{
        day: "2026-08-23",
        byModel: {
          "gpt-5.6-sol": { capacityUsd: 2_423, participantCount: 1 },
          "gpt-5.6-terra": { capacityUsd: 1_101, participantCount: 1 },
          "gpt-5.6-luna": { capacityUsd: null, participantCount: 0 },
          "gpt-5.5": { capacityUsd: 2_124, participantCount: 1 },
        },
        fittedParticipantCount: 1,
        unstableParticipantCount: 0,
        staleParticipantCount: 0,
        refusedParticipantCount: 0,
        v1ParticipantCount: 1,
        unsupportedSourceParticipantCount: 2,
      }],
    },
  };
}

function metricsHistoryPayload() {
  const event = {
    total: 30,
    last24Hours: 2,
    previous24Hours: 1,
    byDayStartsAt: "2026-07-25",
    byDay: [
      { day: "2026-08-22", count: 1 },
      { day: "2026-08-23", count: 2 },
    ],
  };
  return {
    schemaVersion: "admin-metrics-history-v0.2",
    generatedAt: "2026-08-23T12:00:00.000Z",
    events: Object.fromEntries([
      "participants",
      "webSessions",
      "devicePairings",
      "deviceCredentials",
      "deviceConsents",
      "uploadedChunks",
      "uploadedRecords",
      "uploadingParticipants",
      "acceptedUploads",
    ].map((name) => [name, structuredClone(event)])),
    downloads: {
      available: true,
      byDayStartsAt: "2026-07-25",
      byDay: [
        { day: "2026-08-22", cumulativeDmgDownloads: 10 },
        { day: "2026-08-23", cumulativeDmgDownloads: 12 },
      ],
    },
    gauges: {
      snapshots: [{
        capturedAt: "2026-08-22T12:00:00.000Z",
        metrics: { participantsActive: 5 },
      }, {
        capturedAt: "2026-08-23T11:00:00.000Z",
        metrics: { participantsActive: 6, contributingAccountsTotal: 4 },
      }],
    },
  };
}

test("admin allowance preview projects the fixed merge trial contract", () => {
  const preview = projectAdminAllowancePreview(allowancePreviewPayload());
  assert.equal(preview.days.length, 70);
  assert.equal(preview.models.days.length, 1);
  assert.deepEqual(preview.models.days[0].byModel["gpt-5.6-sol"], {
    capacityUsd: 2_423,
    participantCount: 1,
  });
  assert.deepEqual(preview.models.days[0].byModel["gpt-5.6-luna"], {
    capacityUsd: null,
    participantCount: 0,
  });
  assert.throws(() => projectAdminAllowancePreview({
    ...allowancePreviewPayload(),
    models: undefined,
  }));
  const inconsistent = allowancePreviewPayload();
  inconsistent.models.days[0].fittedParticipantCount = 0;
  assert.throws(() => projectAdminAllowancePreview(inconsistent));
  assert.deepEqual(preview.plans.map((plan) => [plan.planType, plan.multiplier]), [
    ["pro", 1],
    ["prolite", 4],
    ["plus", 20],
  ]);
  assert.deepEqual(preview.days.at(-1).combined, {
    fitCount: 6,
    participantCount: 4,
    centralUsd: 2_100,
    band80Usd: { lowerUsd: 1_800, upperUsd: 2_400 },
  });
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.days), true);
  assert.equal(Object.isFrozen(preview.days.at(-1).byPlanType), true);
});

test("admin allowance preview validates additive upload-to-merge coverage", () => {
  const payload = allowancePreviewPayload();
  payload.coverage = {
    uploadingParticipantCount: 8,
    cachedParticipantCount: 8,
    recentFittedParticipantCount: 6,
    mergeEligibleParticipantCount: 5,
    noQualifyingFitParticipantCount: 2,
    noRecentFitParticipantCount: 0,
    unsupportedPlanParticipantCount: 1,
  };
  assert.deepEqual(projectAdminAllowancePreview(payload).coverage, payload.coverage);
  payload.coverage.unsupportedPlanParticipantCount = 0;
  assert.throws(
    () => projectAdminAllowancePreview(payload),
    /ADMIN_ALLOWANCE_PREVIEW_INVALID/u,
  );
});

test("metrics history projector keeps bounded dated points and additive gauges", () => {
  const history = projectAdminMetricsHistory(metricsHistoryPayload());
  assert.equal(history.events.acceptedUploads.total, 30);
  assert.equal(history.events.acceptedUploads.byDayStartsAt, "2026-07-25");
  assert.equal(history.gauges.snapshots.at(-1).metrics.contributingAccountsTotal, 4);
  assert.equal(Object.isFrozen(history.gauges.snapshots.at(-1).metrics), true);

  const badGauge = metricsHistoryPayload();
  badGauge.gauges.snapshots[0].metrics.participantsActive = -1;
  assert.throws(() => projectAdminMetricsHistory(badGauge), /ADMIN_METRICS_HISTORY_INVALID/u);

  const badBoundedFlag = metricsHistoryPayload();
  badBoundedFlag.gauges.snapshots[0].metrics.participantsActiveBounded = 2;
  assert.throws(
    () => projectAdminMetricsHistory(badBoundedFlag),
    /ADMIN_METRICS_HISTORY_INVALID/u,
  );

  const unsorted = metricsHistoryPayload();
  unsorted.events.participants.byDay.reverse();
  assert.throws(() => projectAdminMetricsHistory(unsorted), /ADMIN_METRICS_HISTORY_INVALID/u);
});

test("metrics history projector enforces the declared recent window", () => {
  const bounded = metricsHistoryPayload();
  bounded.events.participants.byDay.unshift({
    day: "2026-07-24",
    count: 1,
  });
  assert.throws(
    () => projectAdminMetricsHistory(bounded),
    /ADMIN_METRICS_HISTORY_INVALID/u,
  );

  const impossibleWindow = metricsHistoryPayload();
  impossibleWindow.events.webSessions.last24Hours = 31;
  assert.throws(
    () => projectAdminMetricsHistory(impossibleWindow),
    /ADMIN_METRICS_HISTORY_INVALID/u,
  );

  const oldSchema = metricsHistoryPayload();
  oldSchema.schemaVersion = "admin-metrics-history-v0.1";
  assert.throws(
    () => projectAdminMetricsHistory(oldSchema),
    /ADMIN_METRICS_HISTORY_INVALID/u,
  );
});

test("admin allowance preview rejects drifted factors, chronology, and evidence", () => {
  const mutations = [
    (payload) => { payload.basis = "different-basis"; },
    (payload) => { payload.plans[1].multiplier = 5; },
    (payload) => { payload.days[1].day = payload.days[0].day; },
    (payload) => { payload.days.at(-1).combined.band80Usd = null; },
    (payload) => { payload.days[0].combined.participantCount = 1; },
    (payload) => { delete payload.days.at(-1).byPlanType.plus; },
  ];
  for (const mutate of mutations) {
    const payload = allowancePreviewPayload();
    mutate(payload);
    assert.throws(
      () => projectAdminAllowancePreview(payload),
      /ADMIN_ALLOWANCE_PREVIEW_INVALID/u,
    );
  }
});

test("admin overview fixture projects to the renderer's explicit contract", async () => {
  const overview = projectAdminOverview(await fixture("admin-overview-valid.json"));
  assert.deepEqual(overview, {
    generatedAt: "2026-08-17T12:00:00.000Z",
    service: { environment: "production" },
    collection: {
      state: "operational",
      revision: 7,
      enrollment: true,
      uploadRegistration: true,
      processing: true,
      publication: true,
    },
    counts: {
      participants: {
        active: 5,
        total: 6,
        bounded: false,
        enrolledLast24Hours: 1,
        enrolledLast7Days: 3,
      },
      contributions: {
        contributingAccounts: {
          total: 2,
          bounded: false,
          acceptedLast24Hours: 1,
          acceptedLast7Days: 1,
          acceptedLast30Days: 1,
        },
        telemetry: {
          accepted: 9,
          total: 10,
          bounded: false,
          acceptedLast24Hours: 2,
          acceptedLast7Days: 6,
        },
        incrementalChunks: {
          current: 10,
          total: 12,
          bounded: false,
          acceptedLast24Hours: 3,
          acceptedLast7Days: 8,
        },
        acceptedLast24Hours: 5,
        acceptedLast7Days: 14,
        latestAcceptedAt: "2026-08-17T11:21:58.898Z",
        storedTelemetryRecords: 22,
        storedTelemetryRecordsBounded: false,
      },
    },
    quarantine: {
      pendingObjects: 110,
      pendingObjectsBounded: false,
      gracePeriodMinutes: 60,
      cutoffAt: "2026-08-17T11:00:00.000Z",
      withinGrace: 110,
      dueReferenced: 0,
      dueUnreferenced: 0,
      oldestRegisteredAt: "2026-08-17T11:19:32.269Z",
      newestRegisteredAt: "2026-08-17T11:21:58.898Z",
      nextEligibleAt: "2026-08-17T12:19:32.269Z",
    },
    lifecycle: {
      state: "completed",
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      maintenanceRunAt: "2026-08-17T11:59:00.000Z",
      failureCode: null,
    },
    reconciliation: {
      state: "completed",
      lastCompletedAt: "2026-08-17T11:59:00.000Z",
      maintenanceRunAt: "2026-08-17T11:59:00.000Z",
      cutoffAt: "2026-08-17T10:59:00.000Z",
      registrationsExamined: 0,
      orphanObjectsDeleted: 0,
      referencedObjectsPreserved: 0,
      reconciliationComplete: true,
      failureCode: null,
    },
    ingress: {
      activeLeases: 3,
      maximumConcurrent: 16,
      availableStartTokens: 240,
      burst: 300,
      concurrencyDenials: 4,
      startRateDenials: 2,
      lastDeniedAt: "2026-08-02T09:15:00.000Z",
    },
    distribution: {
      methodology: {
        unit: "distinct_source_ip_addresses",
        lookbackDays: 7,
        storesRawAddresses: false,
      },
      cloudflare: {
        status: "available",
        reasonCode: null,
        sampled: false,
        bounded: false,
        window: {
          startsAt: "2026-08-10T12:00:00.000Z",
          endsAt: "2026-08-17T12:00:00.000Z",
        },
        activeSourceAddresses: { last24Hours: 19, last7Days: 29 },
        preflight: {
          requests: { last24Hours: 22, last7Days: 78 },
          sourceAddresses: { last24Hours: 16, last7Days: 25 },
        },
        sparkleChecks: {
          requests: { last24Hours: 14, last7Days: 40 },
          sourceAddresses: { last24Hours: 13, last7Days: 21 },
        },
        sparkleDownloads: {
          requests: { last24Hours: 3, last7Days: 3 },
          sourceAddresses: { last24Hours: 3, last7Days: 3 },
        },
        currentVersion: "0.1.12",
        currentVersionSourceAddresses: { last24Hours: 18, last7Days: 19 },
        observedVersions: [{
          version: "0.1.12",
          requestsLast7Days: 64,
          sourceAddressesLast7Days: 19,
        }, {
          version: "0.1.11",
          requestsLast7Days: 9,
          sourceAddressesLast7Days: 5,
        }],
        bySegment: [],
        observedVersionsBounded: false,
      },
      github: {
        status: "available",
        reasonCode: null,
        repository: "adamallcock/tibotattle",
        release: {
          tag: "v0.1.12",
          publishedAt: "2026-08-15T18:00:00.000Z",
          dmgDownloads: 88,
          allAssetDownloads: 101,
        },
        summary: {
          dmgDownloads: 110,
          allAssetDownloads: 135,
          dmgAssetCount: 2,
          assetCount: 4,
          releaseCount: 2,
        },
        releases: [{
          id: 12,
          tag: "v0.1.12",
          publishedAt: "2026-08-15T18:00:00.000Z",
          prerelease: false,
          dmgDownloads: 88,
          allAssetDownloads: 101,
          dmgAssetCount: 1,
          assetCount: 2,
        }, {
          id: 11,
          tag: "v0.1.11",
          publishedAt: "2026-08-01T18:00:00.000Z",
          prerelease: false,
          dmgDownloads: 22,
          allAssetDownloads: 34,
          dmgAssetCount: 1,
          assetCount: 2,
        }],
        releasesBounded: false,
        history: {
          firstObservedAt: "2026-08-16T12:00:00.000Z",
          previousObservedAt: "2026-08-16T12:00:00.000Z",
          latestObservedAt: "2026-08-17T12:00:00.000Z",
          dmgDownloadsSincePrevious: 6,
          counterRegressions: 0,
        },
        sync: {
          lastAttemptedAt: "2026-08-17T12:00:00.000Z",
          lastSuccessAt: "2026-08-17T12:00:00.000Z",
          lastFailureCode: null,
          stale: false,
        },
      },
    },
    snapshots: [{
      snapshotId: "community-weekly:2026-07-26",
      weekStart: "2026-07-26T00:00:00.000Z",
      weekEnd: "2026-08-02T00:00:00.000Z",
      releaseState: "published",
      releasedAt: "2026-08-02T11:30:00.000Z",
    }],
    dailyPublication: {
      latestEvidenceDay: "2026-08-01",
      latestReleasedAt: "2026-08-02T11:40:00.000Z",
      pendingRebuilds: 0,
      pendingRebuildsBounded: false,
    },
    pendingHistoricalRebuilds: 0,
    errors: {
      retentionDays: 30,
      sampled: true,
      capacity: 256,
      groups: [{
        routeClass: "admin_overview",
        errorCode: "BACKEND_STORAGE_UNAVAILABLE",
        status: 503,
        occurrences: 2,
        ratePerDay: 0.29,
        latestAt: "2026-08-02T10:00:00.000Z",
      }],
      recentDiagnostics: [{
        requestId: "019fc0b7-6c19-7b40-bda0-a1a1d7202100",
        routeClass: "admin_overview",
        errorCode: "BACKEND_STORAGE_UNAVAILABLE",
        status: 503,
        occurredAt: "2026-08-02T10:00:00.000Z",
      }],
      lookup: null,
    },
    audit: [{
      action: "run_maintenance",
      outcome: "success",
      details: { code: "OK" },
      createdAt: "2026-08-02T11:00:00.000Z",
    }],
  });
  assert.equal(Object.isFrozen(overview), true);
  assert.equal(Object.isFrozen(overview.collection), true);
});

test("an unavailable ingress budget projects to null instead of failing the view", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.ingress = null;
  assert.equal(projectAdminOverview(payload).ingress, null);
  delete payload.ingress;
  assert.equal(projectAdminOverview(payload).ingress, null);
});

test("admin overview projector rejects malformed ingress pressure values", async () => {
  for (const ingress of [
    { activeLeases: -1 },
    { ...{
      activeLeases: 0,
      maximumConcurrent: 16,
      availableStartTokens: 0,
      burst: 300,
      concurrencyDenials: 0,
      startRateDenials: 0,
    }, lastDeniedAt: 12345 },
    "unavailable",
  ]) {
    const payload = await fixture("admin-overview-valid.json");
    payload.ingress = ingress;
    assert.throws(
      () => projectAdminOverview(payload),
      /ADMIN_OVERVIEW_INVALID/u,
    );
  }
});

test("quarantine projection keeps recent, referenced, and orphan counts exhaustive", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.quarantine.withinGrace = 109;
  assert.throws(
    () => projectAdminOverview(payload),
    /ADMIN_OVERVIEW_INVALID/u,
  );

  const missingWindow = await fixture("admin-overview-valid.json");
  missingWindow.quarantine.nextEligibleAt = null;
  assert.throws(
    () => projectAdminOverview(missingWindow),
    /ADMIN_OVERVIEW_INVALID/u,
  );
});

test("distribution sources may degrade without invalidating exact D1 counts", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.distribution.cloudflare = {
    status: "not_configured",
    reasonCode: "ANALYTICS_NOT_CONFIGURED",
    sampled: null,
    bounded: null,
    window: null,
    activeSourceAddresses: null,
    preflight: null,
    sparkleChecks: null,
    sparkleDownloads: null,
    currentVersion: null,
    currentVersionSourceAddresses: null,
    observedVersions: [],
    observedVersionsBounded: false,
  };
  const overview = projectAdminOverview(payload);
  assert.equal(overview.distribution.cloudflare.status, "not_configured");
  assert.equal(overview.counts.contributions.contributingAccounts.total, 2);
});

test("Cloudflare activity stays available when GitHub has no current release", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.distribution.cloudflare.currentVersion = null;
  payload.distribution.cloudflare.currentVersionSourceAddresses = null;
  payload.distribution.cloudflare.bySegment = [{
    startsAt: "2026-08-16T12:00:00.000Z",
    endsAt: "2026-08-17T12:00:00.000Z",
    activeSourceAddresses: 19,
    preflightRequests: 22,
    sparkleCheckRequests: 14,
    sparkleDownloadRequests: 3,
    currentVersionSourceAddresses: null,
  }];
  payload.distribution.github = {
    status: "unavailable",
    reasonCode: "GITHUB_SNAPSHOT_PENDING",
    repository: "adamallcock/tibotattle",
    release: null,
    summary: null,
    releases: [],
    releasesBounded: false,
    history: {
      firstObservedAt: null,
      previousObservedAt: null,
      latestObservedAt: null,
      dmgDownloadsSincePrevious: null,
      counterRegressions: 0,
    },
    sync: {
      lastAttemptedAt: null,
      lastSuccessAt: null,
      lastFailureCode: null,
      stale: false,
    },
  };

  const overview = projectAdminOverview(payload);
  assert.equal(overview.distribution.cloudflare.status, "available");
  assert.equal(
    overview.distribution.cloudflare.bySegment[0].currentVersionSourceAddresses,
    null,
  );
  assert.equal(overview.distribution.github.status, "unavailable");
});

test("distribution segments agree with current-version availability", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.distribution.cloudflare.bySegment = [{
    startsAt: "2026-08-16T12:00:00.000Z",
    endsAt: "2026-08-17T12:00:00.000Z",
    activeSourceAddresses: 19,
    preflightRequests: 22,
    sparkleCheckRequests: 14,
    sparkleDownloadRequests: 3,
    currentVersionSourceAddresses: null,
  }];
  assert.throws(
    () => projectAdminOverview(payload),
    /ADMIN_OVERVIEW_INVALID/u,
  );
});

test("distribution projection rejects stale values behind unavailable sources", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.distribution.cloudflare.status = "unavailable";
  payload.distribution.cloudflare.reasonCode = "ANALYTICS_UNAVAILABLE";
  assert.throws(
    () => projectAdminOverview(payload),
    /ADMIN_OVERVIEW_INVALID/u,
  );

  const inconsistent = await fixture("admin-overview-valid.json");
  inconsistent.distribution.github.release.dmgDownloads = 102;
  assert.throws(
    () => projectAdminOverview(inconsistent),
    /ADMIN_OVERVIEW_INVALID/u,
  );
});

test("admin overview projector rejects missing and malformed render values", async () => {
  for (const name of [
    "admin-overview-missing-counts.json",
    "admin-overview-malformed.json",
  ]) {
    const payload = await fixture(name);
    assert.throws(
      () => projectAdminOverview(payload),
      /ADMIN_OVERVIEW_INVALID/u,
    );
  }
});

test("admin action projection rejects malformed successful responses", () => {
  assert.throws(
    () => projectAdminAction({
      schemaVersion: "admin-action-v0.1",
      action: "run_maintenance",
      result: {},
    }, "run_maintenance"),
    (error) => error instanceof AdminResponseError
      && error.code === "ADMIN_ACTION_INVALID",
  );
});

test("admin action conflicts explain that the displayed revision is stale", async () => {
  const error = adminResponseError(409, await fixture("admin-action-stale-revision.json"));
  assert.equal(error.code, "ADMIN_ACTION_CONFLICT");
  assert.equal(
    adminActionErrorMessage(error),
    "The collection state changed elsewhere. Refresh the operations view before trying again.",
  );
});

test("admin action failures retain a verified diagnostic reference for display", async () => {
  const error = adminResponseError(503, await fixture("admin-action-error.json"));
  assert.equal(
    adminActionErrorMessage(error),
    "BACKEND_STORAGE_UNAVAILABLE (019fc0b7-6c19-7b40-bda0-a1a1d7202180)",
  );
  assert.equal(
    adminActionErrorMessage(adminResponseError(503, { error: { code: 42 } })),
    "HTTP_503",
  );
});
