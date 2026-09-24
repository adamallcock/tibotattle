import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ADMIN_MODEL_CONFIG, LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
} from "../public/telemetry-shared.generated.js";
import {
  AdminResponseError,
  adminActionErrorMessage,
  adminResponseError,
  createAdminReadLane,
  isTransientAdminReadError,
  projectAdminAllowancePreview,
  projectAdminAction,
  projectAdminMetricsHistory,
  projectAdminOverview,
  projectAdminDatabaseHealth,
  projectAdminReconstructionProgress,
} from "../public/admin-client.js";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/${name}`, import.meta.url),
  "utf8",
));

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

test("admin read lanes are independent, single-flight, and reuse a pending request", async () => {
  let completeSlow;
  let slowReads = 0;
  const published = [];
  const failed = error => assert.fail(error.code);
  const slow = createAdminReadLane({
    read: () => { slowReads += 1; return new Promise(resolve => { completeSlow = resolve; }); },
    publish: value => published.push(value), failed,
  });
  const fast = createAdminReadLane({ read: async () => "fast", publish: value => published.push(value), failed });
  const pending = slow.run();
  assert.equal(slow.run(), pending);
  await fast.run();
  assert.equal(slowReads, 1);
  assert.deepEqual(published, ["fast"]);
  completeSlow("slow");
  await pending;
  assert.deepEqual(published, ["fast", "slow"]);
});

test("an admin read deadline aborts stalled work, frees its lane, and fences late completion", async () => {
  let finish, signal, onDeadline;
  const published = [], failures = [];
  let calls = 0;
  const lane = createAdminReadLane({
    read: options => {
      signal = options.signal;
      return ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : "recovered";
    },
    publish: value => published.push(value), failed: error => failures.push(error.code),
    schedule: (callback, milliseconds) => { assert.equal(milliseconds, 15_000); onDeadline = callback; return 1; },
    cancel: () => {},
  });
  const stalled = lane.run();
  await Promise.resolve();
  onDeadline();
  await stalled;
  assert.equal(signal.aborted, true);
  assert.deepEqual(failures, ["ADMIN_READ_TIMEOUT"]);
  await lane.run();
  finish("obsolete");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, ["recovered"]);
});

test("authoritative invalidation cancels an admin lane without publishing or reviving the old generation", async () => {
  let complete;
  let requests = 0;
  const values = [], failures = [];
  const lane = createAdminReadLane({
    read: () => ++requests === 1 ? new Promise(resolve => { complete = resolve; }) : "new",
    publish: value => values.push(value), failed: error => failures.push(error.code),
  });
  const older = lane.run();
  await Promise.resolve();
  lane.invalidate();
  await lane.run();
  complete("old");
  await older;
  assert.deepEqual(values, ["new"]);
  assert.deepEqual(failures, []);
});

test("admin storage failures are transient, while an authoritative missing cache or refusal is not", () => {
  for (const code of ["ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE", "ADMIN_METRICS_HISTORY_STORAGE_UNAVAILABLE"]) {
    assert.equal(isTransientAdminReadError(new AdminResponseError(code, null, 503)), true);
    assert.equal(isTransientAdminReadError(new AdminResponseError(code, null, 403)), false);
  }
  for (const code of ["ADMIN_ALLOWANCE_CACHE_UNAVAILABLE", "ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE", "PUBLICATION_DISABLED"]) {
    assert.equal(isTransientAdminReadError(new AdminResponseError(code, null, 503)), false);
  }
});

test("generation progress projects a closed, dated aggregate contract with explicit unknowns", async () => {
  const payload = await fixture("admin-reconstruction-progress-valid.json");
  const projected = projectAdminReconstructionProgress(payload);
  assert.deepEqual(projected, payload);
  assert.equal(Object.isFrozen(projected.history), true);
  assert.equal(projected.publication.preparedGeneration, null);
  for (const mutate of [
    value => { value.participantId = "synthetic-unexpected"; },
    value => { value.work.rawError = "synthetic-unexpected"; },
    value => { value.history.resolvedDays = 70; },
    value => { value.history.requiredDays = 71; },
    value => { value.history.completeAccounts = 16; },
    value => { value.history.activeDay = "2026-02-30"; },
    value => { value.publication.publishedGeneration = 43; },
    value => { value.work.restartReason = "raw_private_reason"; },
    value => { value.work.updatedAt = "yesterday"; },
    value => { value.history.requiredDays = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    assert.throws(() => projectAdminReconstructionProgress(invalid), error => error.code === "ADMIN_RECONSTRUCTION_PROGRESS_INVALID");
  }
  payload.work.phase = null;
  payload.work.updatedAt = null;
  payload.work.trigger = null;
  payload.work.restartReason = null;
  payload.history.activeDay = null;
  payload.history.completeAccounts = null;
  payload.history.requiredAccounts = null;
  assert.deepEqual(projectAdminReconstructionProgress(payload), payload);
});

test("preparation progress accepts the exact v2 aggregate extension without changing legacy v1", async () => {
  const legacy = await fixture("admin-reconstruction-progress-valid.json");
  assert.equal(Object.hasOwn(projectAdminReconstructionProgress(legacy), "preparation"), false);
  const payload = await fixture("admin-reconstruction-preparation-valid.json");
  const projected = projectAdminReconstructionProgress(payload);
  assert.deepEqual(projected, payload);
  assert.equal(Object.isFrozen(projected.preparation), true);
  assert.deepEqual(projected.history, legacy.history, "source days are not a replacement history denominator");
  payload.preparation = null;
  assert.equal(projectAdminReconstructionProgress(payload).preparation, null);
  payload.preparation = {
    trackedDays: 0, completeDays: 0, buildingDays: 0, retiringDays: 0,
    checkpointSteps: 0, quotaObservations: 0, usageEvents: 0,
  };
  assert.deepEqual(projectAdminReconstructionProgress(payload).preparation, payload.preparation);
  payload.preparation.trackedDays = 169_000;
  payload.preparation.completeDays = 169_000;
  payload.preparation.checkpointSteps = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(projectAdminReconstructionProgress(payload).preparation, payload.preparation);
});

test("preparation progress rejects cross-version fields, unknown fields, invalid counters and inconsistent day totals", async () => {
  const payload = await fixture("admin-reconstruction-preparation-valid.json");
  const mutations = [
    value => { value.schemaVersion = 1; },
    value => { value.schemaVersion = 3; },
    value => { delete value.preparation; },
    value => { value.preparation = []; },
    value => { value.participantId = "synthetic-unexpected"; },
    value => { value.preparation.participantId = "synthetic-unexpected"; },
    value => { value.preparation.completeDays += 1; },
    value => { value.preparation.buildingDays += 1; },
    value => { value.preparation.retiringDays += 1; },
  ];
  for (const key of Object.keys(payload.preparation)) {
    mutations.push(value => { delete value.preparation[key]; });
    for (const invalidCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", null]) {
      mutations.push(value => { value.preparation[key] = invalidCount; });
    }
  }
  for (const mutate of mutations) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    assert.throws(() => projectAdminReconstructionProgress(invalid), error => error.code === "ADMIN_RECONSTRUCTION_PROGRESS_INVALID");
  }
});

test("graph rebuild progress accepts the exact v3 window extension and keeps preparation optional", async () => {
  const payload = await fixture("admin-reconstruction-graph-valid.json");
  const projected = projectAdminReconstructionProgress(structuredClone(payload));
  assert.deepEqual(projected, payload);
  assert.equal(Object.hasOwn(projected, "preparation"), false, "v3 omits the optional section it was not given");
  for (const frozen of [projected.graph, projected.graph.window, projected.graph.days,
    projected.graph.days[0], projected.graph.work.checkpoints, projected.graph.throughput]) {
    assert.equal(Object.isFrozen(frozen), true);
  }
  assert.equal(projected.graph.days.length, projected.graph.window.days);
  assert.equal(projected.graph.days.at(0).day, projected.graph.window.to);
  assert.equal(projected.graph.days.at(-1).day, projected.graph.window.from);
  assert.deepEqual(projected.history, {
    resolvedDays: 6, requiredDays: 69, activeDay: "2026-09-04",
    completeAccounts: 8, requiredAccounts: 19,
  }, "v3 reports real account numbers rather than the typed-storage nulls");
  const withPreparation = structuredClone(payload);
  withPreparation.preparation = {
    trackedDays: 4, completeDays: 3, buildingDays: 1, retiringDays: 0,
    checkpointSteps: 9, quotaObservations: 40, usageEvents: 22,
  };
  assert.deepEqual(projectAdminReconstructionProgress(withPreparation).preparation, withPreparation.preparation);
  for (const relax of [
    value => { value.graph.throughput.estimatedHoursRemaining = null; },
    value => { value.graph.throughput.estimatedHoursRemaining = 0; },
    value => { value.graph.work.state = "idle"; value.graph.work.activeDay = null; value.graph.work.activeMetric = null; value.graph.work.leaseExpiresAt = null; },
    value => { value.graph.refusals = []; },
    value => { value.graph.work.checkpoints.phases = []; },
    value => { value.graph.work.checkpoints = null; },
    value => { value.graph.retirement.staleResults = null; },
  ]) {
    const relaxed = structuredClone(payload);
    relax(relaxed);
    assert.deepEqual(projectAdminReconstructionProgress(relaxed), relaxed);
  }
});

test("a capped graph read keeps its display-only counters null instead of collapsing them to zero", async () => {
  const payload = await fixture("admin-reconstruction-graph-capped.json");
  const projected = projectAdminReconstructionProgress(structuredClone(payload));
  assert.deepEqual(projected, payload);
  assert.equal(projected.graph.work.checkpoints, null);
  assert.equal(projected.graph.retirement.staleResults, null);
  assert.deepEqual(
    [projected.graph.throughput.resultsLastHour, projected.graph.throughput.resultsLast6Hours,
      projected.graph.throughput.estimatedHoursRemaining],
    [null, null, null],
  );
  assert.equal(projected.graph.throughput.remainingResults, 1042, "the remaining count is not display-only");
  for (const mutate of [
    value => { value.graph.throughput.estimatedHoursRemaining = 30.1; },
    value => { value.graph.throughput.resultsLastHour = 23; value.graph.throughput.estimatedHoursRemaining = 30.1; },
    value => { value.graph.work.checkpoints = []; },
    value => { value.graph.retirement.staleResults = -1; },
  ]) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    assert.throws(() => projectAdminReconstructionProgress(invalid), error => error.code === "ADMIN_RECONSTRUCTION_PROGRESS_INVALID");
  }
});

test("graph rebuild progress rejects unknown keys, broken day invariants and non-member codes", async () => {
  const payload = await fixture("admin-reconstruction-graph-valid.json");
  const mutations = [
    value => { delete value.graph; },
    value => { value.graph = null; },
    value => { value.graph = []; },
    value => { value.graph.participantId = "synthetic-unexpected"; },
    value => { value.graph.work.rawError = "synthetic-unexpected"; },
    value => { value.graph.window.label = "synthetic-unexpected"; },
    value => { value.graph.days[0].accountId = "synthetic-unexpected"; },
    value => { value.graph.days.pop(); },
    value => { value.graph.days.push(structuredClone(value.graph.days[0])); },
    // The window must span exactly as many calendar days as it declares.
    value => { value.graph.window.days -= 1; },
    value => { value.graph.window.days = 401; },
    value => { value.graph.window.from = "2026-07-11"; },
    value => { value.graph.window.to = "2026-09-17"; },
    value => { value.graph.window.from = "2026-02-30"; },
    value => { value.graph.window.from = value.graph.window.to; },
    value => { value.graph.days.reverse(); },
    value => { value.graph.days[3].day = value.graph.days[2].day; },
    value => { value.graph.days[0].ready += 1; },
    value => { value.graph.days[0].missing -= 1; },
    value => { value.graph.days[0].unsupported += 1; },
    value => { delete value.graph.days[0].unsupported; },
    value => { value.graph.owners.active += 1; },
    value => { value.graph.days[0].published = "true"; },
    value => { value.graph.days[0].publishedAt = "yesterday"; },
    // Fits carry no per-owner reason, so `refused` is not one of their keys.
    value => { value.graph.currentFits.noFit += 1; },
    value => { value.graph.currentFits.refused = 0; },
    value => { delete value.graph.currentFits.noFit; },
    value => { value.graph.work.state = "paused"; },
    value => { value.graph.work.activeMetric = "cost"; },
    value => { value.graph.work.leaseExpiresAt = "2026-09-17T12:04:00Z"; },
    value => { value.graph.refusals[0].metric = "model"; },
    value => { value.graph.refusals[0].reason = "Refused: /Users/owner/.codex"; },
    value => { value.graph.refusals[0].reason = ""; },
    value => { value.graph.refusals[0].reason = "ab"; },
    value => { value.graph.refusals[1] = structuredClone(value.graph.refusals[0]); },
    value => { value.graph.refusals[0].owners = -1; },
    value => { value.graph.work.checkpoints.phases[1].phase = "usage"; },
    value => { value.graph.work.checkpoints.phases[0].parts = 1.5; },
    value => { value.graph.throughput.estimatedHoursRemaining = -0.1; },
    value => { value.graph.throughput.estimatedHoursRemaining = Infinity; },
    value => { value.graph.throughput.estimatedHoursRemaining = "12"; },
    value => { value.graph.throughput.resultsLastHour = null; },
    value => { value.graph.throughput.resultsLast6Hours = null; },
    value => { value.graph.throughput.remainingResults = null; },
    value => { value.graph.throughput.remainingResults = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.graph.retirement.staleResults = "216"; },
  ];
  for (const section of ["selections", "checkpoints"]) {
    for (const key of Object.keys(payload.graph.work[section])) {
      mutations.push(value => { delete value.graph.work[section][key]; });
    }
  }
  for (const mutate of mutations) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    assert.throws(() => projectAdminReconstructionProgress(invalid), error => error.code === "ADMIN_RECONSTRUCTION_PROGRESS_INVALID");
  }
});

function reconstructionPayload() {
  return {
    schemaVersion: "admin-reconstruction-progress-v0.1",
    status: "available",
    observedAt: "2026-09-06T20:34:00.000Z",
    mode: "resumable",
    lookup: { complete: false, lastRecordId: 200, throughRecordId: 1_000 },
    calculations: {
      trackedAccounts: 15,
      completedAccounts: 8,
      preparingAccounts: 2,
      scanningAccounts: 2,
      finalizingAccounts: 2,
      sourceChangedAccounts: 1,
      checkpointsWritten: 84,
      bounded: false,
      newestResultAt: "2026-09-06T20:30:00.000Z",
    },
    maintenance: {
      running: true,
      lastRunAt: "2026-09-06T20:33:00.000Z",
      leaseExpiresAt: "2026-09-06T20:35:00.000Z",
    },
    publication: {
      state: "updating",
      pendingDays: 238,
      pendingDaysBounded: false,
      publishedDays: 70,
      pricedDays: 1,
      latestPublishedAt: "2026-09-06T20:31:00.000Z",
    },
  };
}

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
      promax: emptyAllowanceSummary(),
      plus: emptyAllowanceSummary(),
    },
  }));
  days.at(-1).combined = {
    fitCount: 7,
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
    promax: {
      fitCount: 1,
      participantCount: 1,
      centralUsd: 2_300,
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
    schemaVersion: "admin-community-allowance-preview-v0.4",
    generatedAt: "2026-08-23T10:30:00.000Z",
    from: "2026-06-15",
    to: "2026-08-23",
    basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_promax50_preview",
    referencePlanType: "pro",
    trailingDays: 30,
    qualification: "shared_reset_fit_gates_25pp_span_floor",
    spanFloorPp: 25,
    plans: [
      { planType: "pro", label: "Pro 20x", multiplier: 1 },
      { planType: "prolite", label: "Pro 5x", multiplier: 4 },
      { planType: "promax", label: "Pro 50x", multiplier: 0.4 },
      { planType: "plus", label: "Plus", multiplier: 20 },
    ],
    days,
    models: {
      modelConfig: ADMIN_MODEL_CONFIG,
      basis: "seven_day_codex_pro20x_equivalent_per_model_composition",
      gate: "shared_composition_kernel_identification",
      days: [{
        day: "2026-08-23",
        catalogVersion: LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION,
        values: [
          ["gpt-5.6-sol", 2_423, 1],
          ["gpt-5.6-terra", 1_101, 1],
          ["gpt-5.5", 2_124, 1],
        ],
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
  assert.deepEqual(preview.models.days[0].byModel["gpt-6-astra"], {
    capacityUsd: null, participantCount: null,
  });
  assert.equal(preview.models.modelConfig.length, ADMIN_MODEL_CONFIG.length);
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
    ["promax", 0.4],
    ["plus", 20],
  ]);
  assert.deepEqual(preview.days.at(-1).combined, {
    fitCount: 7,
    participantCount: 4,
    centralUsd: 2_100,
    band80Usd: { lowerUsd: 1_800, upperUsd: 2_400 },
  });
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.days), true);
  assert.equal(Object.isFrozen(preview.days.at(-1).byPlanType), true);
});

test("admin model display-label changes preserve results but analytical changes still fail closed", () => {
  const payload = structuredClone(allowancePreviewPayload());
  payload.models.modelConfig[0].label = "Previous reviewed display name";
  const projected = projectAdminAllowancePreview(payload);
  assert.deepEqual(projected.models.modelConfig, ADMIN_MODEL_CONFIG);
  assert.deepEqual(projected.models.days, projectAdminAllowancePreview(allowancePreviewPayload()).models.days);
  for (const label of ["", "x".repeat(81), null, 1]) {
    const invalid = structuredClone(payload);
    invalid.models.modelConfig[0].label = label;
    assert.throws(() => projectAdminAllowancePreview(invalid), { code: "ADMIN_ALLOWANCE_PREVIEW_INVALID" });
  }
  for (const field of ["modelId", "allowanceTrack", "pricingStatus"]) {
    const invalid = structuredClone(payload);
    invalid.models.modelConfig[0][field] = "unreviewed";
    assert.throws(() => projectAdminAllowancePreview(invalid), { code: "ADMIN_ALLOWANCE_PREVIEW_INVALID" }, field);
  }
  payload.models.modelConfig[0].label = "x".repeat(80);
  assert.deepEqual(projectAdminAllowancePreview(payload).models.modelConfig, ADMIN_MODEL_CONFIG);
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
    reconstruction: null,
    service: { environment: "production", telemetryStorageMode: "json" },
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
      lastCompletedAt: "2026-08-17T11:59:00.000Z",
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
        electronChecks: {
          requests: { last24Hours: 11, last7Days: 23 },
          sourceAddresses: { last24Hours: 9, last7Days: 13 },
        },
        sparkleDownloads: {
          requests: { last24Hours: 3, last7Days: 3 },
          sourceAddresses: { last24Hours: 3, last7Days: 3 },
        },
        currentVersion: "0.1.12",
        currentVersionSourceAddresses: { last24Hours: 18, last7Days: 19 },
        observedTotals: null,
        observedVersions: [{
          client: "native",
          operatingSystem: "macos",
          architecture: "arm64",
          version: "0.1.12",
          requestsLast7Days: 64,
          sourceAddressesLast7Days: 19,
        }, {
          client: "electron",
          operatingSystem: "macos",
          architecture: "x64",
          version: "0.1.23",
          requestsLast7Days: 12,
          sourceAddressesLast7Days: 7,
        }, {
          client: "native",
          operatingSystem: "macos",
          architecture: "arm64",
          version: "0.1.11",
          requestsLast7Days: 9,
          sourceAddressesLast7Days: 5,
        }, {
          client: "electron",
          operatingSystem: "windows",
          architecture: "x64",
          version: "0.1.23",
          requestsLast7Days: 8,
          sourceAddressesLast7Days: 4,
        }, {
          client: "electron",
          operatingSystem: "linux",
          architecture: "x64",
          version: null,
          requestsLast7Days: 3,
          sourceAddressesLast7Days: 2,
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
          dmgAssetCount: 3,
          assetCount: 6,
          releaseCount: 2,
        },
        releases: [{
          id: 12,
          tag: "v0.1.12",
          publishedAt: "2026-08-15T18:00:00.000Z",
          prerelease: false,
          dmgDownloads: 88,
          allAssetDownloads: 101,
          dmgAssetCount: 2,
          assetCount: 4,
          installerDownloads: { macArm64: 88, macX64: 0, windowsX64: 7, linuxX64: 6 },
        }, {
          id: 11,
          tag: "v0.1.11",
          publishedAt: "2026-08-01T18:00:00.000Z",
          prerelease: false,
          dmgDownloads: 22,
          allAssetDownloads: 34,
          dmgAssetCount: 1,
          assetCount: 2,
          installerDownloads: { macArm64: 22, macX64: null, windowsX64: null, linuxX64: null },
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
    pendingHistoricalRebuildsBounded: false,
    pendingHistoricalRebuilds: 0,
    historicalPublication: null,
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

test("expanded overview uses a new schema and requires an explicit recognized storage mode", async () => {
  const payload = await fixture("admin-overview-valid.json");
  for (const version of ["admin-overview-v0.3", "admin-overview-v0.4", "admin-overview-v0.6"]) {
    assert.throws(() => projectAdminOverview({ ...payload, schemaVersion: version }), /ADMIN_OVERVIEW_INVALID/u);
  }
  for (const mode of [undefined, "unknown"]) {
    assert.throws(() => projectAdminOverview({ ...payload, service: { ...payload.service, telemetryStorageMode: mode } }), /ADMIN_OVERVIEW_INVALID/u);
  }
});

test("typed admin overview projects target publication evidence without a legacy queue zero", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.schemaVersion = "admin-overview-v0.5";
  payload.service.telemetryStorageMode = "typed";
  payload.snapshots = [];
  payload.pendingHistoricalRebuilds = null;
  payload.pendingHistoricalRebuildsBounded = null;
  payload.historicalPublication = {
    publishedDays: 69,
    publishedDaysBounded: false,
    latestEvidenceDay: "2026-08-16",
    latestComputedAt: "2026-08-17T11:55:00.000Z",
    previewState: "current",
    previewGeneratedAt: "2026-08-17T11:56:00.000Z",
  };
  const overview = projectAdminOverview(payload);
  assert.equal(overview.service.telemetryStorageMode, "typed");
  assert.equal(overview.pendingHistoricalRebuilds, null);
  assert.deepEqual(overview.historicalPublication, payload.historicalPublication);

  for (const mutate of [
    value => { value.pendingHistoricalRebuilds = 0; },
    value => { value.pendingHistoricalRebuildsBounded = false; },
    value => { value.historicalPublication = null; },
    value => { value.historicalPublication.previewState = "unknown"; },
    value => { value.service.telemetryStorageMode = "json"; },
  ]) {
    const invalid = structuredClone(payload);
    mutate(invalid);
    assert.throws(() => projectAdminOverview(invalid), /ADMIN_OVERVIEW_INVALID/u);
  }
});

test("admin overview projects isolated reconstruction evidence and omits unknown fields", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.reconstruction = reconstructionPayload();
  payload.reconstruction.unreviewed = "omit-me";
  for (const section of ["lookup", "calculations", "maintenance", "publication"]) {
    payload.reconstruction[section].unreviewed = "omit-me";
  }
  const projected = projectAdminOverview(payload).reconstruction;
  assert.deepEqual(projected, reconstructionPayload());
  assert.equal(Object.isFrozen(projected), true);
  for (const section of ["lookup", "calculations", "maintenance", "publication"]) {
    assert.equal(Object.isFrozen(projected[section]), true, section);
    assert.notEqual(projected[section], payload.reconstruction[section], section);
  }
});

test("reconstruction unavailable status is minimal and legacy overview remains valid", async () => {
  const payload = await fixture("admin-overview-valid.json");
  const legacy = projectAdminOverview(payload);
  assert.equal(legacy.reconstruction, null);
  payload.reconstruction = null;
  assert.deepEqual(projectAdminOverview(payload), legacy);
  for (const mode of ["resumable", "synchronous", "paused", "unknown"]) {
    const minimal = {
      schemaVersion: "admin-reconstruction-progress-v0.1",
      status: "unavailable",
      observedAt: "2026-09-06T20:34:00.000Z",
      mode,
    };
    payload.reconstruction = { ...reconstructionPayload(), ...minimal };
    assert.deepEqual(projectAdminOverview(payload).reconstruction, minimal);
    payload.reconstruction = minimal;
    assert.deepEqual(projectAdminOverview(payload).reconstruction, minimal);
  }
});

test("reconstruction permits explicit unknown freshness and zero progress", async () => {
  const payload = await fixture("admin-overview-valid.json");
  const progress = reconstructionPayload();
  progress.lookup = { complete: true, lastRecordId: 0, throughRecordId: 0 };
  for (const name of Object.keys(progress.calculations)) {
    if (name.endsWith("Accounts") || name === "checkpointsWritten") {
      progress.calculations[name] = 0;
    }
  }
  progress.calculations.bounded = true;
  progress.calculations.newestResultAt = null;
  progress.maintenance = { running: false, lastRunAt: null, leaseExpiresAt: null };
  progress.publication = {
    state: "unknown", pendingDays: 0, pendingDaysBounded: true,
    publishedDays: 0, pricedDays: 0, latestPublishedAt: null,
  };
  for (const mode of ["resumable", "synchronous", "paused", "unknown"]) {
    for (const state of ["updating", "ready", "unknown"]) {
      progress.mode = mode;
      progress.publication.state = state;
      payload.reconstruction = progress;
      assert.deepEqual(projectAdminOverview(payload).reconstruction, progress);
    }
  }
});

test("invalid reconstruction structure, states and phase totals cannot reject a valid overview", async () => {
  const payload = await fixture("admin-overview-valid.json");
  const legacy = projectAdminOverview(payload);
  for (const malformed of [false, [], "available", {}, undefined]) {
    payload.reconstruction = malformed;
    assert.deepEqual(projectAdminOverview(payload), legacy);
  }
  const mutations = [
    (value) => { value.schemaVersion = "admin-reconstruction-progress-v0.2"; },
    (value) => { value.status = "ready"; },
    (value) => { value.mode = "automatic"; },
    (value) => { value.publication.state = "published"; },
    (value) => { value.lookup.complete = 1; },
    (value) => { value.calculations.bounded = 1; },
    (value) => { value.maintenance.running = 1; },
    (value) => { value.publication.pendingDaysBounded = 1; },
    (value) => { value.calculations.trackedAccounts += 1; },
    (value) => { value.calculations.completedAccounts += 1; },
    (value) => { value.calculations.sourceChangedAccounts += 1; },
    (value) => { value.lookup.lastRecordId = value.lookup.throughRecordId + 1; },
    (value) => { value.lookup.complete = true; },
    (value) => { value.publication.pricedDays = value.publication.publishedDays + 1; },
    ...["lookup", "calculations", "maintenance", "publication"].map((section) =>
      (value) => { delete value[section]; }),
  ];
  for (const mutate of mutations) {
    payload.reconstruction = reconstructionPayload();
    mutate(payload.reconstruction);
    assert.deepEqual(projectAdminOverview(payload), legacy);
  }
});

test("reconstruction requires nonnegative safe integer counts in every section", async () => {
  const payload = await fixture("admin-overview-valid.json");
  const legacy = projectAdminOverview(payload);
  const fields = {
    lookup: ["lastRecordId", "throughRecordId"],
    calculations: ["trackedAccounts", "completedAccounts", "preparingAccounts",
      "scanningAccounts", "finalizingAccounts", "sourceChangedAccounts", "checkpointsWritten"],
    publication: ["pendingDays", "publishedDays", "pricedDays"],
  };
  for (const [section, names] of Object.entries(fields)) {
    for (const name of names) {
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "0", null, undefined]) {
        payload.reconstruction = reconstructionPayload();
        payload.reconstruction[section][name] = invalid;
        assert.deepEqual(projectAdminOverview(payload), legacy, `${section}.${name}: ${invalid}`);
      }
    }
  }
});

test("reconstruction accepts safe integer boundaries without rounding progress", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.reconstruction = reconstructionPayload();
  payload.reconstruction.lookup = {
    complete: true,
    lastRecordId: Number.MAX_SAFE_INTEGER,
    throughRecordId: Number.MAX_SAFE_INTEGER,
  };
  payload.reconstruction.calculations.checkpointsWritten = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(projectAdminOverview(payload).reconstruction, payload.reconstruction);
});

test("reconstruction validates each timestamp and isolates unavailable metadata errors", async () => {
  const payload = await fixture("admin-overview-valid.json");
  const legacy = projectAdminOverview(payload);
  const fields = [[null, "observedAt"], ["calculations", "newestResultAt"],
    ["maintenance", "lastRunAt"], ["maintenance", "leaseExpiresAt"],
    ["publication", "latestPublishedAt"]];
  for (const [section, name] of fields) {
    for (const invalid of ["not-a-date", "September 6, 2026", "2026-02-30T00:00:00.000Z", 0, undefined]) {
      payload.reconstruction = reconstructionPayload();
      const target = section ? payload.reconstruction[section] : payload.reconstruction;
      target[name] = invalid;
      assert.deepEqual(projectAdminOverview(payload), legacy, `${section}.${name}: ${invalid}`);
    }
  }
  for (const field of ["observedAt", "schemaVersion", "mode", "status"]) {
    payload.reconstruction = { ...reconstructionPayload(), status: "unavailable" };
    delete payload.reconstruction[field];
    assert.deepEqual(projectAdminOverview(payload), legacy, field);
  }
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
    electronChecks: null,
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
    electronCheckRequests: 11,
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
    electronCheckRequests: 11,
    sparkleDownloadRequests: 3,
    currentVersionSourceAddresses: null,
  }];
  assert.throws(
    () => projectAdminOverview(payload),
    /ADMIN_OVERVIEW_INVALID/u,
  );
});

test("distribution version rows require a known app and operating system", async () => {
  const unknownClient = await fixture("admin-overview-valid.json");
  unknownClient.distribution.cloudflare.observedVersions[0].client = "desktop";
  assert.throws(
    () => projectAdminOverview(unknownClient),
    /ADMIN_OVERVIEW_INVALID/u,
  );

  const unknownOperatingSystem = await fixture("admin-overview-valid.json");
  unknownOperatingSystem.distribution.cloudflare.observedVersions[0]
    .operatingSystem = "darwin";
  assert.throws(
    () => projectAdminOverview(unknownOperatingSystem),
    /ADMIN_OVERVIEW_INVALID/u,
  );

  const unknownArchitecture = await fixture("admin-overview-valid.json");
  unknownArchitecture.distribution.cloudflare.observedVersions[0]
    .architecture = "unknown";
  assert.throws(
    () => projectAdminOverview(unknownArchitecture),
    /ADMIN_OVERVIEW_INVALID/u,
  );

  const unsupportedArchitecture = await fixture("admin-overview-valid.json");
  unsupportedArchitecture.distribution.cloudflare.observedVersions[3]
    .architecture = "arm64";
  assert.throws(
    () => projectAdminOverview(unsupportedArchitecture),
    /ADMIN_OVERVIEW_INVALID/u,
  );
});

test("installer breakdown refuses unclassified fields and impossible totals", async () => {
  const extraField = await fixture("admin-overview-valid.json");
  extraField.distribution.github.releases[0].installerDownloads
    .rawAssetName = "private-path";
  assert.throws(() => projectAdminOverview(extraField), /ADMIN_OVERVIEW_INVALID/u);

  const overcount = await fixture("admin-overview-valid.json");
  overcount.distribution.github.releases[0].installerDownloads
    .macX64 = 1;
  assert.throws(() => projectAdminOverview(overcount), /ADMIN_OVERVIEW_INVALID/u);
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

test("admin response errors retain only the bounded transport status, never a body-supplied status", () => {
  const error = adminResponseError(403, {
    error: { code: "ADMIN_REQUIRED", httpStatus: 503, status: 503 },
  });
  assert.equal(error.httpStatus, 403);
  assert.equal(error.code, "ADMIN_REQUIRED");
  assert.equal(adminResponseError(503, { error: { code: "BACKEND_STORAGE_UNAVAILABLE" } }).httpStatus, 503);
  for (const status of [null, undefined, "503", 99, 600, 500.5, Infinity, NaN, {}]) {
    assert.equal(adminResponseError(status, { error: { code: "INTERNAL_ERROR" } }).httpStatus, null);
  }
  assert.equal(new AdminResponseError("ADMIN_ALLOWANCE_PREVIEW_INVALID").httpStatus, null);
});


test("database health projects only closed, consistent role evidence", async () => {
  const input = await fixture("admin-database-health-valid.json");
  input.databases[0].privateIdentifier = "must-not-escape";
  const projected = projectAdminDatabaseHealth(input);
  assert.equal(projected.databases[2].databaseBytes, null);
  assert.doesNotMatch(JSON.stringify(projected), /must-not-escape/u);
  for (const alter of [
    x => { x.databases.pop(); },
    x => { x.databases[0].role = "unknown"; },
    x => { x.databases[0].responseMs = -1; },
    x => { x.databases[0].status = "unavailable"; },
    x => { x.databases[0].databaseBytes = NaN; },
    x => { x.status = "degraded"; },
    x => { x.storageMode = "json"; },
  ]) {
    const bad = structuredClone(input); alter(bad);
    assert.throws(() => projectAdminDatabaseHealth(bad), { message: "ADMIN_DATABASE_HEALTH_INVALID" });
  }
});


test("version totals validate OS coverage, counts and unavailable states without inferring legacy totals", async () => {
  const payload = await fixture("admin-overview-valid.json");
  assert.equal(projectAdminOverview(payload).distribution.cloudflare.observedTotals, null);
  const totals = {
    platforms: [
      { operatingSystem: "macos", requestsLast7Days: 85, sourceAddressesLast7Days: 25 },
      { operatingSystem: "windows", requestsLast7Days: 8, sourceAddressesLast7Days: 4 },
      { operatingSystem: "linux", requestsLast7Days: 3, sourceAddressesLast7Days: 2 },
    ],
    overall: { requestsLast7Days: 96, sourceAddressesLast7Days: 29 },
  };
  payload.distribution.cloudflare.observedTotals = totals;
  totals.overall.privateField = "omit me";
  const projected = projectAdminOverview(payload).distribution.cloudflare.observedTotals;
  assert.equal(projected.overall.privateField, undefined);
  assert.ok(Object.isFrozen(projected.platforms));
  assert.equal(projected.macosArchitectures, null);
  totals.macosArchitectures = [
    { architecture: "arm64", requestsLast7Days: 60, sourceAddressesLast7Days: 20 },
    { architecture: "x64", requestsLast7Days: 25, sourceAddressesLast7Days: 10 },
  ];
  assert.equal(projectAdminOverview(payload).distribution.cloudflare.observedTotals
    .macosArchitectures[1].architecture, "x64");
  for (const mutate of [
    p => p.platforms[0].operatingSystem = "darwin",
    p => p.platforms[1].operatingSystem = "macos",
    p => p.platforms.pop(),
    p => p.platforms[0].sourceAddressesLast7Days = 30,
    p => p.platforms[0].requestsLast7Days = -1,
    p => p.overall.requestsLast7Days = 97,
    p => p.overall.sourceAddressesLast7Days = 28,
    p => p.macosArchitectures[1].architecture = "arm64",
    p => p.macosArchitectures[0].requestsLast7Days = 61,
    p => p.macosArchitectures[0].sourceAddressesLast7Days = 26,
  ]) {
    const invalid = structuredClone(payload);
    mutate(invalid.distribution.cloudflare.observedTotals);
    assert.throws(() => projectAdminOverview(invalid), /ADMIN_OVERVIEW_INVALID/u);
  }
});
