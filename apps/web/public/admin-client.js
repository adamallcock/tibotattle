const ADMIN_OVERVIEW_SCHEMA_VERSION = "admin-overview-v0.3";
const ADMIN_ACTION_SCHEMA_VERSION = "admin-action-v0.1";
const ADMIN_ALLOWANCE_PREVIEW_SCHEMA_VERSION =
  "admin-community-allowance-preview-v0.2";
const ADMIN_ALLOWANCE_PREVIEW_BASIS =
  "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d_preview";
const ADMIN_ALLOWANCE_PREVIEW_DAYS = 70;
const ADMIN_METRICS_HISTORY_SCHEMA_VERSION = "admin-metrics-history-v0.2";
const ADMIN_METRICS_HISTORY_MAX_DAYS = 30;
const ADMIN_METRICS_HISTORY_MAX_SNAPSHOTS = 400;
const ADMIN_METRICS_HISTORY_MAX_GAUGES = 128;
const ADMIN_ALLOWANCE_PREVIEW_PLANS = Object.freeze([
  Object.freeze({ planType: "pro", label: "Pro 20x", multiplier: 1 }),
  Object.freeze({ planType: "prolite", label: "Pro 5x", multiplier: 4 }),
  Object.freeze({ planType: "plus", label: "Plus", multiplier: 20 }),
]);
const ADMIN_ALLOWANCE_PREVIEW_MODELS = Object.freeze([
  Object.freeze({ modelId: "gpt-5.6-sol", label: "Sol" }),
  Object.freeze({ modelId: "gpt-5.6-terra", label: "Terra" }),
  Object.freeze({ modelId: "gpt-5.6-luna", label: "Luna" }),
  Object.freeze({ modelId: "gpt-5.5", label: "GPT-5.5" }),
]);
const ADMIN_ALLOWANCE_MODELS_BASIS =
  "seven_day_codex_pro20x_equivalent_per_model_composition";
const ADMIN_ALLOWANCE_MODELS_GATE =
  "shared_composition_kernel_identification";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const ADMIN_ACTIONS = new Set([
  "set_collection_controls",
  "run_maintenance",
  "sync_distribution",
]);
const COLLECTION_STATES = new Set(["operational", "degraded", "contained"]);
const LIFECYCLE_STATES = new Set(["never_run", "running", "completed", "failed"]);
const RECONCILIATION_STATES = new Set([
  "never_run",
  "running",
  "completed",
  "failed",
]);
const SNAPSHOT_STATES = new Set(["published", "suppressed", "withdrawn"]);
const AUDIT_OUTCOMES = new Set(["started", "success", "failure"]);
const DISTRIBUTION_SOURCE_STATUSES = new Set([
  "available",
  "not_configured",
  "unavailable",
]);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AdminResponseError extends Error {
  constructor(code, requestId = null) {
    super(code);
    this.name = "AdminResponseError";
    this.code = code;
    this.requestId = requestId;
  }
}

function invalid(code) {
  throw new AdminResponseError(code);
}

function record(value, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(code);
  }
  return value;
}

function string(value, code) {
  if (typeof value !== "string" || value.length === 0) invalid(code);
  return value;
}

function nullableString(value, code) {
  return value === null ? null : string(value, code);
}

function boolean(value, code) {
  if (typeof value !== "boolean") invalid(code);
  return value;
}

function count(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(code);
  return value;
}

function positiveNumber(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    invalid(code);
  }
  return value;
}

function array(value, code) {
  if (!Array.isArray(value)) invalid(code);
  return value;
}

function enumValue(value, values, code) {
  if (typeof value !== "string" || !values.has(value)) invalid(code);
  return value;
}

function calendarDay(value, code) {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) invalid(code);
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch)
      || new Date(epoch).toISOString().slice(0, 10) !== value) {
    invalid(code);
  }
  return value;
}

function isoTimestamp(value, code) {
  const timestamp = string(value, code);
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch)) invalid(code);
  return timestamp;
}

function boundedArray(value, maximum, code) {
  const values = array(value, code);
  if (values.length > maximum) invalid(code);
  return values;
}

function projectAllowancePreviewCoverage(value) {
  if (value === undefined || value === null) return null;
  const code = "ADMIN_ALLOWANCE_PREVIEW_INVALID";
  const coverage = record(value, code);
  const projected = Object.freeze({
    uploadingParticipantCount: count(coverage.uploadingParticipantCount, code),
    cachedParticipantCount: count(coverage.cachedParticipantCount, code),
    recentFittedParticipantCount: count(coverage.recentFittedParticipantCount, code),
    mergeEligibleParticipantCount: count(coverage.mergeEligibleParticipantCount, code),
    noQualifyingFitParticipantCount: count(
      coverage.noQualifyingFitParticipantCount,
      code,
    ),
    noRecentFitParticipantCount: count(coverage.noRecentFitParticipantCount, code),
    unsupportedPlanParticipantCount: count(
      coverage.unsupportedPlanParticipantCount,
      code,
    ),
  });
  const gapCount = projected.noQualifyingFitParticipantCount
    + projected.noRecentFitParticipantCount
    + projected.unsupportedPlanParticipantCount;
  if (projected.cachedParticipantCount > projected.uploadingParticipantCount
      || projected.recentFittedParticipantCount > projected.cachedParticipantCount
      || projected.mergeEligibleParticipantCount > projected.recentFittedParticipantCount
      || gapCount !== projected.uploadingParticipantCount
        - projected.mergeEligibleParticipantCount) {
    invalid(code);
  }
  return projected;
}

function projectAllowancePreviewSummary(value) {
  const code = "ADMIN_ALLOWANCE_PREVIEW_INVALID";
  const summary = record(value, code);
  const fitCount = count(summary.fitCount, code);
  const participantCount = count(summary.participantCount, code);
  if ((fitCount === 0) !== (participantCount === 0)
      || participantCount > fitCount) {
    invalid(code);
  }
  if (fitCount === 0) {
    if (summary.centralUsd !== null || summary.band80Usd !== null) invalid(code);
    return Object.freeze({
      fitCount,
      participantCount,
      centralUsd: null,
      band80Usd: null,
    });
  }
  const centralUsd = positiveNumber(summary.centralUsd, code);
  let band80Usd = null;
  if (summary.band80Usd !== null) {
    const band = record(summary.band80Usd, code);
    const lowerUsd = positiveNumber(band.lowerUsd, code);
    const upperUsd = positiveNumber(band.upperUsd, code);
    if (upperUsd < lowerUsd
        || centralUsd < lowerUsd
        || centralUsd > upperUsd) {
      invalid(code);
    }
    band80Usd = Object.freeze({ lowerUsd, upperUsd });
  }
  if ((fitCount >= 3) !== (band80Usd !== null)) invalid(code);
  return Object.freeze({
    fitCount,
    participantCount,
    centralUsd,
    band80Usd,
  });
}

function projectAllowanceModelSummary(value) {
  const code = "ADMIN_ALLOWANCE_PREVIEW_INVALID";
  const summary = record(value, code);
  const participantCount = count(summary.participantCount, code);
  if (summary.capacityUsd === null) {
    if (participantCount !== 0) invalid(code);
    return Object.freeze({ capacityUsd: null, participantCount: 0 });
  }
  if (participantCount === 0) invalid(code);
  return Object.freeze({
    capacityUsd: positiveNumber(summary.capacityUsd, code),
    participantCount,
  });
}

function projectAllowanceModels(value, latestAllowedDay) {
  const code = "ADMIN_ALLOWANCE_PREVIEW_INVALID";
  const models = record(value, code);
  if (models.basis !== ADMIN_ALLOWANCE_MODELS_BASIS
      || models.gate !== ADMIN_ALLOWANCE_MODELS_GATE) {
    invalid(code);
  }
  const modelConfig = array(models.modelConfig, code).map((entry, index) => {
    const model = record(entry, code);
    const expected = ADMIN_ALLOWANCE_PREVIEW_MODELS[index];
    if (!expected
        || model.modelId !== expected.modelId
        || model.label !== expected.label) {
      invalid(code);
    }
    return expected;
  });
  if (modelConfig.length !== ADMIN_ALLOWANCE_PREVIEW_MODELS.length) invalid(code);
  const expectedModelKeys = ADMIN_ALLOWANCE_PREVIEW_MODELS
    .map((model) => model.modelId)
    .sort();
  let previousDay = "";
  const days = array(models.days, code).map((entry) => {
    const day = record(entry, code);
    const dayValue = calendarDay(day.day, code);
    if (dayValue <= previousDay || dayValue > latestAllowedDay) invalid(code);
    previousDay = dayValue;
    const fitted = count(day.fittedParticipantCount, code);
    const unstable = count(day.unstableParticipantCount, code);
    const refused = count(day.refusedParticipantCount, code);
    const v1Count = count(day.v1ParticipantCount, code);
    const unsupported = count(day.unsupportedSourceParticipantCount, code);
    if (fitted + unstable + refused !== v1Count) invalid(code);
    const byModel = record(day.byModel, code);
    if (Object.keys(byModel).sort().join("|") !== expectedModelKeys.join("|")) {
      invalid(code);
    }
    const projectedByModel = Object.freeze(Object.fromEntries(
      ADMIN_ALLOWANCE_PREVIEW_MODELS.map((model) => {
        const summary = projectAllowanceModelSummary(byModel[model.modelId]);
        if (summary.participantCount > fitted) invalid(code);
        return [model.modelId, summary];
      }),
    ));
    return Object.freeze({
      day: dayValue,
      byModel: projectedByModel,
      fittedParticipantCount: fitted,
      unstableParticipantCount: unstable,
      refusedParticipantCount: refused,
      v1ParticipantCount: v1Count,
      unsupportedSourceParticipantCount: unsupported,
    });
  });
  if (days.length > ADMIN_ALLOWANCE_PREVIEW_DAYS) invalid(code);
  return Object.freeze({
    modelConfig: Object.freeze(modelConfig),
    basis: ADMIN_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_ALLOWANCE_MODELS_GATE,
    days: Object.freeze(days),
  });
}

/**
 * Fail-closed projection for the owner-only merge trial. The public client does
 * not understand this schema and remains pinned to the published Pro cohort.
 */
export function projectAdminAllowancePreview(value) {
  const code = "ADMIN_ALLOWANCE_PREVIEW_INVALID";
  const preview = record(value, code);
  if (preview.schemaVersion !== ADMIN_ALLOWANCE_PREVIEW_SCHEMA_VERSION
      || preview.basis !== ADMIN_ALLOWANCE_PREVIEW_BASIS
      || preview.referencePlanType !== "pro"
      || preview.trailingDays !== 30
      || preview.qualification !== "shared_reset_fit_gates_40pp_span_floor"
      || preview.spanFloorPp !== 40) {
    invalid(code);
  }
  const from = calendarDay(preview.from, code);
  const to = calendarDay(preview.to, code);
  const plans = array(preview.plans, code).map((value, index) => {
    const plan = record(value, code);
    const expected = ADMIN_ALLOWANCE_PREVIEW_PLANS[index];
    if (!expected
        || plan.planType !== expected.planType
        || plan.label !== expected.label
        || plan.multiplier !== expected.multiplier) {
      invalid(code);
    }
    return expected;
  });
  if (plans.length !== ADMIN_ALLOWANCE_PREVIEW_PLANS.length) invalid(code);
  const expectedPlanKeys = ADMIN_ALLOWANCE_PREVIEW_PLANS
    .map((plan) => plan.planType)
    .sort();
  const days = array(preview.days, code).map((value, index) => {
    const day = record(value, code);
    const dayValue = calendarDay(day.day, code);
    const expectedDay = new Date(
      Date.parse(`${from}T00:00:00.000Z`) + index * 24 * 60 * 60 * 1000,
    ).toISOString().slice(0, 10);
    if (dayValue !== expectedDay) invalid(code);
    const byPlanType = record(day.byPlanType, code);
    if (Object.keys(byPlanType).sort().join("|") !== expectedPlanKeys.join("|")) {
      invalid(code);
    }
    return Object.freeze({
      day: dayValue,
      combined: projectAllowancePreviewSummary(day.combined),
      byPlanType: Object.freeze(Object.fromEntries(
        ADMIN_ALLOWANCE_PREVIEW_PLANS.map((plan) => [
          plan.planType,
          projectAllowancePreviewSummary(byPlanType[plan.planType]),
        ]),
      )),
    });
  });
  if (days.length !== ADMIN_ALLOWANCE_PREVIEW_DAYS
      || days[0]?.day !== from
      || days.at(-1)?.day !== to) {
    invalid(code);
  }
  return Object.freeze({
    schemaVersion: ADMIN_ALLOWANCE_PREVIEW_SCHEMA_VERSION,
    generatedAt: string(preview.generatedAt, code),
    from,
    to,
    basis: ADMIN_ALLOWANCE_PREVIEW_BASIS,
    referencePlanType: "pro",
    trailingDays: 30,
    qualification: preview.qualification,
    spanFloorPp: 40,
    plans: Object.freeze(plans),
    days: Object.freeze(days),
    coverage: projectAllowancePreviewCoverage(preview.coverage),
    models: projectAllowanceModels(preview.models, to),
  });
}

function projectAdminEventSeries(value, generatedDay, expectedStartsAt) {
  const code = "ADMIN_METRICS_HISTORY_INVALID";
  const series = record(value, code);
  const byDayStartsAt = calendarDay(series.byDayStartsAt, code);
  if (byDayStartsAt !== expectedStartsAt) invalid(code);
  const byDay = boundedArray(series.byDay, ADMIN_METRICS_HISTORY_MAX_DAYS, code)
    .map((candidate) => {
      const row = record(candidate, code);
      return Object.freeze({
        day: calendarDay(row.day, code),
        count: count(row.count, code),
      });
    });
  let previousDay = null;
  for (const row of byDay) {
    if ((previousDay !== null && row.day <= previousDay)
        || row.day < byDayStartsAt
        || row.day > generatedDay) {
      invalid(code);
    }
    previousDay = row.day;
  }
  const total = count(series.total, code);
  const last24Hours = count(series.last24Hours, code);
  const previous24Hours = count(series.previous24Hours, code);
  if (last24Hours > total || previous24Hours > total) invalid(code);
  return Object.freeze({
    total,
    last24Hours,
    previous24Hours,
    byDayStartsAt,
    byDay: Object.freeze(byDay),
  });
}

/**
 * Fail-closed projection for the single aggregate history payload. New gauge
 * names are additive: the projector accepts only bounded, non-negative safe
 * integer values, while the renderer decides which known metric each key can
 * support. Missing new gauges remain an explicit history gap.
 */
export function projectAdminMetricsHistory(value) {
  const code = "ADMIN_METRICS_HISTORY_INVALID";
  const history = record(value, code);
  if (history.schemaVersion !== ADMIN_METRICS_HISTORY_SCHEMA_VERSION) invalid(code);
  const generatedAt = isoTimestamp(history.generatedAt, code);
  const generatedEpoch = Date.parse(generatedAt);
  const generatedDay = generatedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(generatedDay)) invalid(code);
  const expectedStartsAtDate = new Date(`${generatedDay}T00:00:00.000Z`);
  expectedStartsAtDate.setUTCDate(expectedStartsAtDate.getUTCDate() - 29);
  const expectedStartsAt = expectedStartsAtDate.toISOString().slice(0, 10);
  const events = record(history.events, code);
  const eventNames = [
    "participants",
    "webSessions",
    "devicePairings",
    "deviceCredentials",
    "deviceConsents",
    "uploadedChunks",
    "acceptedUploads",
    "uploadedRecords",
    "uploadingParticipants",
  ];
  const projectedEvents = Object.fromEntries(eventNames.map((name) => [
    name,
    projectAdminEventSeries(events[name], generatedDay, expectedStartsAt),
  ]));
  const downloads = record(history.downloads, code);
  const downloadStartsAt = calendarDay(downloads.byDayStartsAt, code);
  if (downloadStartsAt !== expectedStartsAt) invalid(code);
  const downloadRows = boundedArray(
    downloads.byDay,
    ADMIN_METRICS_HISTORY_MAX_DAYS,
    code,
  ).map((candidate) => {
    const row = record(candidate, code);
    return Object.freeze({
      day: calendarDay(row.day, code),
      cumulativeDmgDownloads: count(row.cumulativeDmgDownloads, code),
    });
  });
  let previousDownloadDay = null;
  for (const row of downloadRows) {
    if ((previousDownloadDay !== null && row.day <= previousDownloadDay)
        || row.day < downloadStartsAt
        || row.day > generatedDay) {
      invalid(code);
    }
    previousDownloadDay = row.day;
  }
  const downloadsAvailable = boolean(downloads.available, code);
  if (!downloadsAvailable && downloadRows.length !== 0) invalid(code);

  const gauges = record(history.gauges, code);
  const gaugeKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,79}$/u;
  const snapshots = boundedArray(
    gauges.snapshots,
    ADMIN_METRICS_HISTORY_MAX_SNAPSHOTS,
    code,
  ).map((candidate) => {
    const snapshot = record(candidate, code);
    const capturedAt = isoTimestamp(snapshot.capturedAt, code);
    const rawMetrics = record(snapshot.metrics, code);
    const entries = Object.entries(rawMetrics);
    if (entries.length > ADMIN_METRICS_HISTORY_MAX_GAUGES) invalid(code);
    const metrics = {};
    for (const [key, metricValue] of entries) {
      if (!gaugeKeyPattern.test(key)) invalid(code);
      const projected = count(metricValue, code);
      if (key.endsWith("Bounded") && projected > 1) invalid(code);
      metrics[key] = projected;
    }
    return Object.freeze({ capturedAt, metrics: Object.freeze(metrics) });
  });
  let previousCapturedAt = -Infinity;
  const earliestSnapshotAt = generatedEpoch - 30 * 24 * 60 * 60 * 1_000;
  for (const snapshot of snapshots) {
    const capturedAt = Date.parse(snapshot.capturedAt);
    if (capturedAt < earliestSnapshotAt
        || capturedAt <= previousCapturedAt
        || capturedAt > generatedEpoch) invalid(code);
    previousCapturedAt = capturedAt;
  }
  return Object.freeze({
    schemaVersion: ADMIN_METRICS_HISTORY_SCHEMA_VERSION,
    generatedAt,
    events: Object.freeze(projectedEvents),
    downloads: Object.freeze({
      available: downloadsAvailable,
      byDayStartsAt: downloadStartsAt,
      byDay: Object.freeze(downloadRows),
    }),
    gauges: Object.freeze({ snapshots: Object.freeze(snapshots) }),
  });
}

function projectCollection(value, code = "ADMIN_OVERVIEW_INVALID") {
  const collection = record(value, code);
  const flags = {
    enrollment: boolean(collection.enrollment, code),
    uploadRegistration: boolean(collection.uploadRegistration, code),
    processing: boolean(collection.processing, code),
    publication: boolean(collection.publication, code),
  };
  const state = enumValue(collection.state, COLLECTION_STATES, code);
  const enabled = Object.values(flags).filter(Boolean).length;
  if ((state === "operational" && enabled !== 4)
      || (state === "contained" && enabled !== 0)
      || (state === "degraded" && (enabled === 0 || enabled === 4))) {
    invalid(code);
  }
  return Object.freeze({
    state,
    revision: positiveInteger(collection.revision, code),
    ...flags,
  });
}

function projectOverviewCounts(value) {
  const counts = record(value, "ADMIN_OVERVIEW_INVALID");
  const participants = record(counts.participants, "ADMIN_OVERVIEW_INVALID");
  const contributions = record(counts.contributions, "ADMIN_OVERVIEW_INVALID");
  const contributingAccounts = record(
    contributions.contributingAccounts,
    "ADMIN_OVERVIEW_INVALID",
  );
  const telemetry = record(contributions.telemetry, "ADMIN_OVERVIEW_INVALID");
  const incrementalChunks = record(
    contributions.incrementalChunks,
    "ADMIN_OVERVIEW_INVALID",
  );
  return Object.freeze({
    participants: Object.freeze({
      active: count(participants.active, "ADMIN_OVERVIEW_INVALID"),
      total: count(participants.total, "ADMIN_OVERVIEW_INVALID"),
      bounded: boolean(participants.bounded, "ADMIN_OVERVIEW_INVALID"),
      enrolledLast24Hours: count(
        participants.enrolledLast24Hours,
        "ADMIN_OVERVIEW_INVALID",
      ),
      enrolledLast7Days: count(
        participants.enrolledLast7Days,
        "ADMIN_OVERVIEW_INVALID",
      ),
    }),
    contributions: Object.freeze({
      contributingAccounts: Object.freeze({
        total: count(contributingAccounts.total, "ADMIN_OVERVIEW_INVALID"),
        bounded: boolean(
          contributingAccounts.bounded,
          "ADMIN_OVERVIEW_INVALID",
        ),
        acceptedLast24Hours: count(
          contributingAccounts.acceptedLast24Hours,
          "ADMIN_OVERVIEW_INVALID",
        ),
        acceptedLast7Days: count(
          contributingAccounts.acceptedLast7Days,
          "ADMIN_OVERVIEW_INVALID",
        ),
        acceptedLast30Days: count(
          contributingAccounts.acceptedLast30Days,
          "ADMIN_OVERVIEW_INVALID",
        ),
      }),
      telemetry: Object.freeze({
        accepted: count(telemetry.accepted, "ADMIN_OVERVIEW_INVALID"),
        total: count(telemetry.total, "ADMIN_OVERVIEW_INVALID"),
        bounded: boolean(telemetry.bounded, "ADMIN_OVERVIEW_INVALID"),
        acceptedLast24Hours: count(
          telemetry.acceptedLast24Hours,
          "ADMIN_OVERVIEW_INVALID",
        ),
        acceptedLast7Days: count(
          telemetry.acceptedLast7Days,
          "ADMIN_OVERVIEW_INVALID",
        ),
      }),
      incrementalChunks: Object.freeze({
        current: count(incrementalChunks.current, "ADMIN_OVERVIEW_INVALID"),
        total: count(incrementalChunks.total, "ADMIN_OVERVIEW_INVALID"),
        bounded: boolean(incrementalChunks.bounded, "ADMIN_OVERVIEW_INVALID"),
        acceptedLast24Hours: count(
          incrementalChunks.acceptedLast24Hours,
          "ADMIN_OVERVIEW_INVALID",
        ),
        acceptedLast7Days: count(
          incrementalChunks.acceptedLast7Days,
          "ADMIN_OVERVIEW_INVALID",
        ),
      }),
      acceptedLast24Hours: count(
        contributions.acceptedLast24Hours,
        "ADMIN_OVERVIEW_INVALID",
      ),
      acceptedLast7Days: count(
        contributions.acceptedLast7Days,
        "ADMIN_OVERVIEW_INVALID",
      ),
      latestAcceptedAt: nullableString(
        contributions.latestAcceptedAt,
        "ADMIN_OVERVIEW_INVALID",
      ),
      storedTelemetryRecords: count(
        contributions.storedTelemetryRecords,
        "ADMIN_OVERVIEW_INVALID",
      ),
      storedTelemetryRecordsBounded: boolean(
        contributions.storedTelemetryRecordsBounded,
        "ADMIN_OVERVIEW_INVALID",
      ),
    }),
  });
}

function projectQuarantine(value) {
  const quarantine = record(value, "ADMIN_OVERVIEW_INVALID");
  const pendingObjects = count(
    quarantine.pendingObjects,
    "ADMIN_OVERVIEW_INVALID",
  );
  const withinGrace = count(quarantine.withinGrace, "ADMIN_OVERVIEW_INVALID");
  const dueReferenced = count(
    quarantine.dueReferenced,
    "ADMIN_OVERVIEW_INVALID",
  );
  const dueUnreferenced = count(
    quarantine.dueUnreferenced,
    "ADMIN_OVERVIEW_INVALID",
  );
  const oldestRegisteredAt = nullableString(
    quarantine.oldestRegisteredAt,
    "ADMIN_OVERVIEW_INVALID",
  );
  const newestRegisteredAt = nullableString(
    quarantine.newestRegisteredAt,
    "ADMIN_OVERVIEW_INVALID",
  );
  const nextEligibleAt = nullableString(
    quarantine.nextEligibleAt,
    "ADMIN_OVERVIEW_INVALID",
  );
  const hasRegistrationBounds = oldestRegisteredAt !== null
    && newestRegisteredAt !== null;
  if (withinGrace + dueReferenced + dueUnreferenced !== pendingObjects
      || (pendingObjects === 0 && (
        oldestRegisteredAt !== null || newestRegisteredAt !== null
      ))
      || (pendingObjects > 0 && !hasRegistrationBounds)
      || (withinGrace === 0) !== (nextEligibleAt === null)) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }
  return Object.freeze({
    pendingObjects,
    pendingObjectsBounded: boolean(
      quarantine.pendingObjectsBounded,
      "ADMIN_OVERVIEW_INVALID",
    ),
    gracePeriodMinutes: positiveInteger(
      quarantine.gracePeriodMinutes,
      "ADMIN_OVERVIEW_INVALID",
    ),
    cutoffAt: string(quarantine.cutoffAt, "ADMIN_OVERVIEW_INVALID"),
    withinGrace,
    dueReferenced,
    dueUnreferenced,
    oldestRegisteredAt,
    newestRegisteredAt,
    nextEligibleAt,
  });
}

function projectDailyPublication(value) {
  const publication = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    latestEvidenceDay: nullableString(
      publication.latestEvidenceDay,
      "ADMIN_OVERVIEW_INVALID",
    ),
    latestReleasedAt: nullableString(
      publication.latestReleasedAt,
      "ADMIN_OVERVIEW_INVALID",
    ),
    pendingRebuilds: count(
      publication.pendingRebuilds,
      "ADMIN_OVERVIEW_INVALID",
    ),
    pendingRebuildsBounded: boolean(
      publication.pendingRebuildsBounded,
      "ADMIN_OVERVIEW_INVALID",
    ),
  });
}

function projectDistributionWindow(value) {
  const window = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    last24Hours: count(window.last24Hours, "ADMIN_OVERVIEW_INVALID"),
    last7Days: count(window.last7Days, "ADMIN_OVERVIEW_INVALID"),
  });
}

function projectDistributionRequests(value) {
  const requests = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    requests: projectDistributionWindow(requests.requests),
    sourceAddresses: projectDistributionWindow(requests.sourceAddresses),
  });
}

function projectDistribution(value) {
  const distribution = record(value, "ADMIN_OVERVIEW_INVALID");
  const methodology = record(
    distribution.methodology,
    "ADMIN_OVERVIEW_INVALID",
  );
  if (methodology.unit !== "distinct_source_ip_addresses"
      || methodology.lookbackDays !== 7
      || methodology.storesRawAddresses !== false) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }

  const cloudflare = record(distribution.cloudflare, "ADMIN_OVERVIEW_INVALID");
  const cloudflareStatus = enumValue(
    cloudflare.status,
    DISTRIBUTION_SOURCE_STATUSES,
    "ADMIN_OVERVIEW_INVALID",
  );
  const observedVersions = array(
    cloudflare.observedVersions,
    "ADMIN_OVERVIEW_INVALID",
  ).map((value) => {
    const version = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      version: string(version.version, "ADMIN_OVERVIEW_INVALID"),
      requestsLast7Days: count(
        version.requestsLast7Days,
        "ADMIN_OVERVIEW_INVALID",
      ),
      sourceAddressesLast7Days: count(
        version.sourceAddressesLast7Days,
        "ADMIN_OVERVIEW_INVALID",
      ),
    });
  });
  const bySegment = boundedArray(
    cloudflare.bySegment ?? [],
    32,
    "ADMIN_OVERVIEW_INVALID",
  ).map((value) => {
    const segment = record(value, "ADMIN_OVERVIEW_INVALID");
    const startsAt = isoTimestamp(segment.startsAt, "ADMIN_OVERVIEW_INVALID");
    const endsAt = isoTimestamp(segment.endsAt, "ADMIN_OVERVIEW_INVALID");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) invalid("ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      startsAt,
      endsAt,
      activeSourceAddresses: count(
        segment.activeSourceAddresses,
        "ADMIN_OVERVIEW_INVALID",
      ),
      preflightRequests: count(segment.preflightRequests, "ADMIN_OVERVIEW_INVALID"),
      sparkleCheckRequests: count(
        segment.sparkleCheckRequests,
        "ADMIN_OVERVIEW_INVALID",
      ),
      sparkleDownloadRequests: count(
        segment.sparkleDownloadRequests,
        "ADMIN_OVERVIEW_INVALID",
      ),
      currentVersionSourceAddresses: segment.currentVersionSourceAddresses === null
        ? null
        : count(
          segment.currentVersionSourceAddresses,
          "ADMIN_OVERVIEW_INVALID",
        ),
    });
  });
  for (let index = 1; index < bySegment.length; index += 1) {
    if (bySegment[index].startsAt < bySegment[index - 1].endsAt) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
  }
  let cloudflareWindow = null;
  let activeSourceAddresses = null;
  let preflight = null;
  let sparkleChecks = null;
  let sparkleDownloads = null;
  if (cloudflareStatus === "available") {
    if (cloudflare.reasonCode !== null
        || typeof cloudflare.sampled !== "boolean"
        || typeof cloudflare.bounded !== "boolean") {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    cloudflareWindow = record(cloudflare.window, "ADMIN_OVERVIEW_INVALID");
    activeSourceAddresses = projectDistributionWindow(
      cloudflare.activeSourceAddresses,
    );
    preflight = projectDistributionRequests(cloudflare.preflight);
    sparkleChecks = projectDistributionRequests(cloudflare.sparkleChecks);
    sparkleDownloads = projectDistributionRequests(cloudflare.sparkleDownloads);
  } else if (cloudflare.window !== null
      || cloudflare.activeSourceAddresses !== null
      || cloudflare.preflight !== null
      || cloudflare.sparkleChecks !== null
      || cloudflare.sparkleDownloads !== null
      || cloudflare.sampled !== null
      || cloudflare.bounded !== null
      || cloudflare.currentVersion !== null
      || cloudflare.currentVersionSourceAddresses !== null
      || observedVersions.length !== 0
      || bySegment.length !== 0
      || cloudflare.observedVersionsBounded !== false
      || typeof cloudflare.reasonCode !== "string") {
    invalid("ADMIN_OVERVIEW_INVALID");
  }
  const currentVersion = nullableString(
    cloudflare.currentVersion,
    "ADMIN_OVERVIEW_INVALID",
  );
  const currentVersionSourceAddresses = cloudflare.currentVersionSourceAddresses
    === null
    ? null
    : projectDistributionWindow(cloudflare.currentVersionSourceAddresses);
  if ((currentVersion === null) !== (currentVersionSourceAddresses === null)) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }
  if (bySegment.some((segment) => (
    (segment.currentVersionSourceAddresses === null) !== (currentVersion === null)
  ))) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }

  const github = record(distribution.github, "ADMIN_OVERVIEW_INVALID");
  const githubStatus = enumValue(
    github.status,
    DISTRIBUTION_SOURCE_STATUSES,
    "ADMIN_OVERVIEW_INVALID",
  );
  const projectGithubRelease = (value) => {
    const candidate = record(value, "ADMIN_OVERVIEW_INVALID");
    const release = Object.freeze({
      id: positiveInteger(candidate.id, "ADMIN_OVERVIEW_INVALID"),
      tag: string(candidate.tag, "ADMIN_OVERVIEW_INVALID"),
      publishedAt: string(candidate.publishedAt, "ADMIN_OVERVIEW_INVALID"),
      prerelease: boolean(candidate.prerelease, "ADMIN_OVERVIEW_INVALID"),
      dmgDownloads: count(candidate.dmgDownloads, "ADMIN_OVERVIEW_INVALID"),
      allAssetDownloads: count(
        candidate.allAssetDownloads,
        "ADMIN_OVERVIEW_INVALID",
      ),
      dmgAssetCount: count(candidate.dmgAssetCount, "ADMIN_OVERVIEW_INVALID"),
      assetCount: count(candidate.assetCount, "ADMIN_OVERVIEW_INVALID"),
    });
    if (release.dmgDownloads > release.allAssetDownloads
        || release.dmgAssetCount > release.assetCount) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    return release;
  };
  const projectGithubHistory = (value) => {
    const history = record(value, "ADMIN_OVERVIEW_INVALID");
    const projected = Object.freeze({
      firstObservedAt: nullableString(
        history.firstObservedAt,
        "ADMIN_OVERVIEW_INVALID",
      ),
      previousObservedAt: nullableString(
        history.previousObservedAt,
        "ADMIN_OVERVIEW_INVALID",
      ),
      latestObservedAt: nullableString(
        history.latestObservedAt,
        "ADMIN_OVERVIEW_INVALID",
      ),
      dmgDownloadsSincePrevious: history.dmgDownloadsSincePrevious === null
        ? null
        : count(history.dmgDownloadsSincePrevious, "ADMIN_OVERVIEW_INVALID"),
      counterRegressions: count(
        history.counterRegressions,
        "ADMIN_OVERVIEW_INVALID",
      ),
    });
    if ((projected.firstObservedAt === null) !== (projected.latestObservedAt === null)
        || (projected.previousObservedAt === null)
          !== (projected.dmgDownloadsSincePrevious === null)) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    return projected;
  };
  const projectGithubSync = (value) => {
    const sync = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      lastAttemptedAt: nullableString(
        sync.lastAttemptedAt,
        "ADMIN_OVERVIEW_INVALID",
      ),
      lastSuccessAt: nullableString(
        sync.lastSuccessAt,
        "ADMIN_OVERVIEW_INVALID",
      ),
      lastFailureCode: nullableString(
        sync.lastFailureCode,
        "ADMIN_OVERVIEW_INVALID",
      ),
      stale: boolean(sync.stale, "ADMIN_OVERVIEW_INVALID"),
    });
  };
  const githubHistory = projectGithubHistory(github.history);
  const githubSync = projectGithubSync(github.sync);
  const releasesBounded = boolean(
    github.releasesBounded,
    "ADMIN_OVERVIEW_INVALID",
  );
  const releases = array(github.releases, "ADMIN_OVERVIEW_INVALID")
    .map(projectGithubRelease);
  const releaseIds = new Set();
  for (const candidate of releases) {
    if (releaseIds.has(candidate.id)) invalid("ADMIN_OVERVIEW_INVALID");
    releaseIds.add(candidate.id);
  }
  let release = null;
  let summary = null;
  if (githubStatus === "available") {
    if (github.reasonCode !== null || releasesBounded) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    const candidate = github.release === null
      ? null
      : record(github.release, "ADMIN_OVERVIEW_INVALID");
    release = candidate === null
      ? null
      : Object.freeze({
        tag: string(candidate.tag, "ADMIN_OVERVIEW_INVALID"),
        publishedAt: string(candidate.publishedAt, "ADMIN_OVERVIEW_INVALID"),
        dmgDownloads: count(candidate.dmgDownloads, "ADMIN_OVERVIEW_INVALID"),
        allAssetDownloads: count(
          candidate.allAssetDownloads,
          "ADMIN_OVERVIEW_INVALID",
        ),
      });
    if (release !== null && release.dmgDownloads > release.allAssetDownloads) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    const candidateSummary = record(github.summary, "ADMIN_OVERVIEW_INVALID");
    summary = Object.freeze({
      dmgDownloads: count(candidateSummary.dmgDownloads, "ADMIN_OVERVIEW_INVALID"),
      allAssetDownloads: count(
        candidateSummary.allAssetDownloads,
        "ADMIN_OVERVIEW_INVALID",
      ),
      dmgAssetCount: count(
        candidateSummary.dmgAssetCount,
        "ADMIN_OVERVIEW_INVALID",
      ),
      assetCount: count(candidateSummary.assetCount, "ADMIN_OVERVIEW_INVALID"),
      releaseCount: count(
        candidateSummary.releaseCount,
        "ADMIN_OVERVIEW_INVALID",
      ),
    });
    if (summary.dmgDownloads > summary.allAssetDownloads
        || summary.dmgAssetCount > summary.assetCount
        || summary.releaseCount !== releases.length) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    const calculated = releases.reduce((totals, candidateRelease) => ({
      dmgDownloads: totals.dmgDownloads + candidateRelease.dmgDownloads,
      allAssetDownloads: totals.allAssetDownloads + candidateRelease.allAssetDownloads,
      dmgAssetCount: totals.dmgAssetCount + candidateRelease.dmgAssetCount,
      assetCount: totals.assetCount + candidateRelease.assetCount,
    }), {
      dmgDownloads: 0,
      allAssetDownloads: 0,
      dmgAssetCount: 0,
      assetCount: 0,
    });
    if (!Number.isSafeInteger(calculated.dmgDownloads)
        || !Number.isSafeInteger(calculated.allAssetDownloads)
        || !Number.isSafeInteger(calculated.dmgAssetCount)
        || !Number.isSafeInteger(calculated.assetCount)
        || calculated.dmgDownloads !== summary.dmgDownloads
        || calculated.allAssetDownloads !== summary.allAssetDownloads
        || calculated.dmgAssetCount !== summary.dmgAssetCount
        || calculated.assetCount !== summary.assetCount
        || (release === null) !== (releases.length === 0)) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    if (release !== null && !releases.some((candidateRelease) =>
      candidateRelease.tag === release.tag
      && candidateRelease.publishedAt === release.publishedAt
      && candidateRelease.dmgDownloads === release.dmgDownloads
      && candidateRelease.allAssetDownloads === release.allAssetDownloads)) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
  } else if (github.release !== null
      || github.summary !== null
      || releases.length !== 0
      || releasesBounded
      || githubHistory.firstObservedAt !== null
      || githubHistory.previousObservedAt !== null
      || githubHistory.latestObservedAt !== null
      || githubHistory.dmgDownloadsSincePrevious !== null
      || githubHistory.counterRegressions !== 0
      || typeof github.reasonCode !== "string") {
    invalid("ADMIN_OVERVIEW_INVALID");
  }

  return Object.freeze({
    methodology: Object.freeze({
      unit: methodology.unit,
      lookbackDays: 7,
      storesRawAddresses: false,
    }),
    cloudflare: Object.freeze({
      status: cloudflareStatus,
      reasonCode: nullableString(
        cloudflare.reasonCode,
        "ADMIN_OVERVIEW_INVALID",
      ),
      sampled: cloudflare.sampled === null
        ? null
        : boolean(cloudflare.sampled, "ADMIN_OVERVIEW_INVALID"),
      bounded: cloudflare.bounded === null
        ? null
        : boolean(cloudflare.bounded, "ADMIN_OVERVIEW_INVALID"),
      window: cloudflareWindow === null
        ? null
        : Object.freeze({
          startsAt: string(cloudflareWindow.startsAt, "ADMIN_OVERVIEW_INVALID"),
          endsAt: string(cloudflareWindow.endsAt, "ADMIN_OVERVIEW_INVALID"),
        }),
      activeSourceAddresses,
      preflight,
      sparkleChecks,
      sparkleDownloads,
      currentVersion,
      currentVersionSourceAddresses,
      observedVersions: Object.freeze(observedVersions),
      bySegment: Object.freeze(bySegment),
      observedVersionsBounded: boolean(
        cloudflare.observedVersionsBounded,
        "ADMIN_OVERVIEW_INVALID",
      ),
    }),
    github: Object.freeze({
      status: githubStatus,
      reasonCode: nullableString(github.reasonCode, "ADMIN_OVERVIEW_INVALID"),
      repository: string(github.repository, "ADMIN_OVERVIEW_INVALID"),
      release,
      summary,
      releases: Object.freeze(releases),
      releasesBounded,
      history: githubHistory,
      sync: githubSync,
    }),
  });
}

function projectLifecycle(value) {
  const lifecycle = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    state: enumValue(lifecycle.state, LIFECYCLE_STATES, "ADMIN_OVERVIEW_INVALID"),
    quarantineRetentionComplete: boolean(
      lifecycle.quarantineRetentionComplete,
      "ADMIN_OVERVIEW_INVALID",
    ),
    restoreReplayComplete: boolean(
      lifecycle.restoreReplayComplete,
      "ADMIN_OVERVIEW_INVALID",
    ),
    maintenanceRunAt: nullableString(
      lifecycle.maintenanceRunAt,
      "ADMIN_OVERVIEW_INVALID",
    ),
    failureCode: nullableString(lifecycle.failureCode, "ADMIN_OVERVIEW_INVALID"),
  });
}

function projectReconciliation(value) {
  const reconciliation = record(value, "ADMIN_OVERVIEW_INVALID");
  const state = enumValue(
    reconciliation.state,
    RECONCILIATION_STATES,
    "ADMIN_OVERVIEW_INVALID",
  );
  const reconciliationComplete = boolean(
    reconciliation.reconciliationComplete,
    "ADMIN_OVERVIEW_INVALID",
  );
  const failureCode = nullableString(
    reconciliation.failureCode,
    "ADMIN_OVERVIEW_INVALID",
  );
  if ((reconciliationComplete && state !== "completed")
      || (state === "failed") !== (failureCode !== null)) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }
  return Object.freeze({
    state,
    lastCompletedAt: nullableString(
      reconciliation.lastCompletedAt,
      "ADMIN_OVERVIEW_INVALID",
    ),
    maintenanceRunAt: nullableString(
      reconciliation.maintenanceRunAt,
      "ADMIN_OVERVIEW_INVALID",
    ),
    cutoffAt: nullableString(
      reconciliation.cutoffAt,
      "ADMIN_OVERVIEW_INVALID",
    ),
    registrationsExamined: count(
      reconciliation.registrationsExamined,
      "ADMIN_OVERVIEW_INVALID",
    ),
    orphanObjectsDeleted: count(
      reconciliation.orphanObjectsDeleted,
      "ADMIN_OVERVIEW_INVALID",
    ),
    referencedObjectsPreserved: count(
      reconciliation.referencedObjectsPreserved,
      "ADMIN_OVERVIEW_INVALID",
    ),
    reconciliationComplete,
    failureCode,
  });
}

/**
 * The ingress budget is a separate Durable Object; the Worker deliberately
 * reports `null` when it is unconfigured or unreachable so the rest of the
 * overview stays renderable. `null` is therefore a valid projected value.
 */
function projectIngress(value) {
  if (value === null || value === undefined) return null;
  const ingress = record(value, "ADMIN_OVERVIEW_INVALID");
  return Object.freeze({
    activeLeases: count(ingress.activeLeases, "ADMIN_OVERVIEW_INVALID"),
    maximumConcurrent: positiveInteger(
      ingress.maximumConcurrent,
      "ADMIN_OVERVIEW_INVALID",
    ),
    availableStartTokens: count(
      ingress.availableStartTokens,
      "ADMIN_OVERVIEW_INVALID",
    ),
    burst: positiveInteger(ingress.burst, "ADMIN_OVERVIEW_INVALID"),
    concurrencyDenials: count(
      ingress.concurrencyDenials,
      "ADMIN_OVERVIEW_INVALID",
    ),
    startRateDenials: count(ingress.startRateDenials, "ADMIN_OVERVIEW_INVALID"),
    lastDeniedAt: nullableString(ingress.lastDeniedAt, "ADMIN_OVERVIEW_INVALID"),
  });
}

function projectErrors(value) {
  const errors = record(value, "ADMIN_OVERVIEW_INVALID");
  const groups = array(errors.groups, "ADMIN_OVERVIEW_INVALID").map((value) => {
    const group = record(value, "ADMIN_OVERVIEW_INVALID");
    if (!Number.isSafeInteger(group.status)
        || group.status < 500
        || group.status > 599) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    return Object.freeze({
      routeClass: string(group.routeClass, "ADMIN_OVERVIEW_INVALID"),
      errorCode: string(group.errorCode, "ADMIN_OVERVIEW_INVALID"),
      status: group.status,
      occurrences: count(group.occurrences, "ADMIN_OVERVIEW_INVALID"),
      ratePerDay: typeof group.ratePerDay === "number" && Number.isFinite(group.ratePerDay)
        ? group.ratePerDay
        : invalid("ADMIN_OVERVIEW_INVALID"),
      latestAt: string(group.latestAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  const projectLookup = (value) => {
    if (value === null) return null;
    const lookup = record(value, "ADMIN_OVERVIEW_INVALID");
    if (!Number.isSafeInteger(lookup.status)
        || lookup.status < 500
        || lookup.status > 599) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    return Object.freeze({
      requestId: string(lookup.requestId, "ADMIN_OVERVIEW_INVALID"),
      errorCode: string(lookup.errorCode, "ADMIN_OVERVIEW_INVALID"),
      routeClass: string(lookup.routeClass, "ADMIN_OVERVIEW_INVALID"),
      occurredAt: string(lookup.occurredAt, "ADMIN_OVERVIEW_INVALID"),
      status: lookup.status,
    });
  };
  const recentDiagnostics = array(
    errors.recentDiagnostics,
    "ADMIN_OVERVIEW_INVALID",
  ).map((value) => {
    const diagnostic = record(value, "ADMIN_OVERVIEW_INVALID");
    if (!Number.isSafeInteger(diagnostic.status)
        || diagnostic.status < 100
        || diagnostic.status > 599) {
      invalid("ADMIN_OVERVIEW_INVALID");
    }
    return Object.freeze({
      requestId: string(diagnostic.requestId, "ADMIN_OVERVIEW_INVALID"),
      routeClass: string(diagnostic.routeClass, "ADMIN_OVERVIEW_INVALID"),
      errorCode: string(diagnostic.errorCode, "ADMIN_OVERVIEW_INVALID"),
      status: diagnostic.status,
      occurredAt: string(diagnostic.occurredAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  return Object.freeze({
    retentionDays: positiveInteger(errors.retentionDays, "ADMIN_OVERVIEW_INVALID"),
    sampled: boolean(errors.sampled, "ADMIN_OVERVIEW_INVALID"),
    capacity: positiveInteger(errors.capacity, "ADMIN_OVERVIEW_INVALID"),
    groups: Object.freeze(groups),
    recentDiagnostics: Object.freeze(recentDiagnostics),
    lookup: projectLookup(errors.lookup),
  });
}

/**
 * Project exactly the fields the operations renderer consumes. A server
 * response is either rendered from this stable local shape or rejected before
 * it can put controls into an unknown state.
 */
export function projectAdminOverview(value) {
  const overview = record(value, "ADMIN_OVERVIEW_INVALID");
  if (overview.schemaVersion !== ADMIN_OVERVIEW_SCHEMA_VERSION) {
    invalid("ADMIN_OVERVIEW_INVALID");
  }
  const service = record(overview.service, "ADMIN_OVERVIEW_INVALID");
  const snapshots = array(overview.snapshots, "ADMIN_OVERVIEW_INVALID").map((value) => {
    const snapshot = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      snapshotId: string(snapshot.snapshotId, "ADMIN_OVERVIEW_INVALID"),
      weekStart: string(snapshot.weekStart, "ADMIN_OVERVIEW_INVALID"),
      weekEnd: string(snapshot.weekEnd, "ADMIN_OVERVIEW_INVALID"),
      releaseState: enumValue(
        snapshot.releaseState,
        SNAPSHOT_STATES,
        "ADMIN_OVERVIEW_INVALID",
      ),
      releasedAt: string(snapshot.releasedAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  const audit = array(overview.audit, "ADMIN_OVERVIEW_INVALID").map((value) => {
    const item = record(value, "ADMIN_OVERVIEW_INVALID");
    return Object.freeze({
      action: enumValue(item.action, ADMIN_ACTIONS, "ADMIN_OVERVIEW_INVALID"),
      outcome: enumValue(item.outcome, AUDIT_OUTCOMES, "ADMIN_OVERVIEW_INVALID"),
      details: item.details,
      createdAt: string(item.createdAt, "ADMIN_OVERVIEW_INVALID"),
    });
  });
  return Object.freeze({
    generatedAt: string(overview.generatedAt, "ADMIN_OVERVIEW_INVALID"),
    service: Object.freeze({
      environment: string(service.environment, "ADMIN_OVERVIEW_INVALID"),
    }),
    collection: projectCollection(overview.collection),
    counts: projectOverviewCounts(overview.counts),
    quarantine: projectQuarantine(overview.quarantine),
    lifecycle: projectLifecycle(overview.lifecycle),
    reconciliation: projectReconciliation(overview.reconciliation),
    ingress: projectIngress(overview.ingress),
    distribution: projectDistribution(overview.distribution),
    snapshots: Object.freeze(snapshots),
    dailyPublication: projectDailyPublication(overview.dailyPublication),
    pendingHistoricalRebuilds: count(
      overview.pendingHistoricalRebuilds,
      "ADMIN_OVERVIEW_INVALID",
    ),
    errors: projectErrors(overview.errors),
    audit: Object.freeze(audit),
  });
}

export function projectAdminAction(value, expectedAction) {
  if (!ADMIN_ACTIONS.has(expectedAction)) invalid("ADMIN_ACTION_INVALID");
  const action = record(value, "ADMIN_ACTION_INVALID");
  if (action.schemaVersion !== ADMIN_ACTION_SCHEMA_VERSION
      || action.action !== expectedAction) {
    invalid("ADMIN_ACTION_INVALID");
  }
  if (expectedAction === "set_collection_controls") {
    return Object.freeze({
      action: expectedAction,
      collection: projectCollection(action.collection, "ADMIN_ACTION_INVALID"),
    });
  }
  const result = record(action.result, "ADMIN_ACTION_INVALID");
  return Object.freeze({
    action: expectedAction,
    result: Object.freeze({
      code: string(result.code, "ADMIN_ACTION_INVALID"),
    }),
  });
}

export function adminResponseError(status, value) {
  const error = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value.error
    : null;
  const details = typeof error === "object" && error !== null && !Array.isArray(error)
    ? error
    : null;
  const code = typeof details?.code === "string" && ERROR_CODE_PATTERN.test(details.code)
    ? details.code
    : `HTTP_${Number.isSafeInteger(status) ? status : 0}`;
  const requestId = typeof details?.requestId === "string"
      && REQUEST_ID_PATTERN.test(details.requestId)
    ? details.requestId
    : null;
  return new AdminResponseError(code, requestId);
}

export function adminActionErrorMessage(error) {
  const response = error instanceof AdminResponseError ? error : null;
  if (response?.code === "ADMIN_ACTION_CONFLICT") {
    return "The collection state changed elsewhere. Refresh the operations view before trying again.";
  }
  if (response?.code === "ADMIN_ACTION_INVALID") {
    return "The service returned an invalid action response. No further action was taken.";
  }
  const code = response?.code ?? "UNEXPECTED_ERROR";
  const reference = response?.requestId ? ` (${response.requestId})` : "";
  return `${code}${reference}`;
}
