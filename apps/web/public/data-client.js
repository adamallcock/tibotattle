/**
 * Browser data boundary.
 *
 * Preferred local companion contract:
 *   GET  /api/local/v1/status
 *   GET  /api/local/v1/dashboard
 *   POST /api/local/refresh
 *
 * Split endpoint aliases are supported while the local server evolves:
 *   /api/local/{overview,gradient,weekly,quality,reports}
 *
 * Central contribution contract:
 *   POST /api/v1/contributions
 *   POST /api/v1/me/contributions/read
 *   POST /api/v1/me/contributions/delete
 *   GET  /api/v1/me
 *   GET  /api/v1/me/stats
 *   GET  /api/v1/stats/aggregate
 *   POST /api/v1/me/device-pairings
 *   GET  /api/v1/me/devices
 *   POST /api/v1/me/devices/revoke
 *
 * The normalizers below accept complete, partial, stale, and insufficient
 * responses, but never silently turn a failure into real-looking data.
 */

const LOCAL_ROOT = "/api/local";
const CENTRAL_ROOT = "/api/v1";
export const COMMUNITY_SNAPSHOT_SCHEMA_VERSION = "community-weekly-snapshot-v0.1";
export const PARTICIPANT_STATS_SCHEMA_VERSION = "participant-stats-v0.2";
export const PARTICIPANT_PROFILE_SCHEMA_VERSION = "participant-profile-v0.2";
export const PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION =
  "participant-community-comparison-v0.1";
export const CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION =
  "contribution-sync-status-v0.1";

const COMMUNITY_METRIC_UNITS = Object.freeze({
  usageEvents: "events_rounded_down",
  inputUncachedTokens: "tokens_rounded_down",
  inputCacheReadTokens: "tokens_rounded_down",
  inputCacheWriteTokens: "tokens_rounded_down",
  outputTextTokens: "tokens_rounded_down",
  outputReasoningTokens: "tokens_rounded_down",
  outputCombinedTokens: "tokens_rounded_down",
  toolUnits: "tool_units_rounded_down"
});
const PARTICIPANT_COMPARISON_METRIC_UNITS = Object.freeze({
  usageEvents: "events",
  inputUncachedTokens: "tokens",
  inputCacheReadTokens: "tokens",
  inputCacheWriteTokens: "tokens",
  outputTextTokens: "tokens",
  outputReasoningTokens: "tokens",
  outputCombinedTokens: "tokens",
  toolUnits: "units"
});
const CONTRIBUTION_ID_PATTERN =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTRIBUTION_SCHEMA_VERSIONS = new Set([
  "synthetic-contribution-v0.1",
  "telemetry-contribution-v0.1",
  "telemetry-contribution-v0.2"
]);
const CONTRIBUTION_POLICY_EPOCHS = new Set([
  "unknown",
  "openai_pre_agentic_pool_2026_07_09",
  "openai_agentic_pool_2026_07_09",
  "anthropic_unknown"
]);
const PARTICIPANT_CONSENT_VERSIONS = new Set([
  "synthetic-preview-v0.1",
  "privacy-safe-telemetry-v0.1",
  "privacy-safe-telemetry-v0.2",
  "ongoing-privacy-safe-telemetry-v0.1",
  "ongoing-privacy-safe-telemetry-v0.2"
]);

function array(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.rows)) return value.rows;
  return [];
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = "") {
  return typeof value === "string" && value.length <= 500 ? value : fallback;
}

function count(value, fallback = null) {
  const number = finite(value, fallback);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function nonNegative(value, fallback = null) {
  const number = finite(value, fallback);
  return number !== null && number >= 0 ? number : fallback;
}

export function normalizeContributionSyncStatus(payload) {
  const unavailable = {
    state: "unavailable",
    paused: null,
    counts: {
      pending: 0,
      inFlight: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0
    },
    dueNow: 0,
    nextAttemptAt: "",
    lastAcceptedAt: ""
  };
  if (payload?.schemaVersion !== CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION
      || payload?.status !== "available"
      || typeof payload?.paused !== "boolean"
      || payload?.includesContent !== false
      || payload?.includesPaths !== false
      || payload?.includesCredentials !== false) {
    return unavailable;
  }
  const names = ["pending", "inFlight", "accepted", "retryable", "rejected"];
  const counts = Object.fromEntries(names.map((name) => [
    name,
    count(payload?.counts?.[name], null)
  ]));
  if (Object.values(counts).some((value) => value === null)) return unavailable;
  const nextAttemptAt = text(payload.nextAttemptAt, "");
  const lastAcceptedAt = text(payload.lastAcceptedAt, "");
  if ((nextAttemptAt && !Number.isFinite(Date.parse(nextAttemptAt)))
      || (lastAcceptedAt && !Number.isFinite(Date.parse(lastAcceptedAt)))) {
    return unavailable;
  }
  return {
    state: payload.paused
      ? "paused"
      : counts.rejected > 0
        ? "attention"
        : counts.pending + counts.retryable + counts.inFlight > 0
          ? "active"
          : counts.accepted > 0
            ? "idle"
            : "empty",
    paused: payload.paused,
    counts,
    dueNow: count(payload.dueNow, 0),
    nextAttemptAt,
    lastAcceptedAt
  };
}

function snapshotMetric(value, expectedUnit) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  if (value.status === "suppressed") {
    return { status: "suppressed", value: null, unit: expectedUnit };
  }
  const numeric = finite(value.value, null);
  if (value.status !== "released"
      || value.unit !== expectedUnit
      || numeric === null
      || !Number.isSafeInteger(numeric)
      || numeric < 0) {
    return null;
  }
  return { status: "released", value: numeric, unit: expectedUnit };
}

export function normalizeCommunitySnapshot(payload) {
  if (!payload) return { state: "service_unavailable", cells: [] };
  if (payload.publicationStatus === "development_diagnostic_not_publication_safe") {
    return { state: "development_unsafe", cells: [] };
  }
  if (payload.schemaVersion !== COMMUNITY_SNAPSHOT_SCHEMA_VERSION
      || payload.immutable !== true
      || payload.nonOverlapping !== true) {
    return { state: "unsupported_schema", cells: [] };
  }

  const base = {
    snapshotId: text(payload.snapshotId, ""),
    period: {
      startAt: text(payload.period?.startAt, ""),
      endAt: text(payload.period?.endAt, "")
    },
    ingestionCutoffAt: text(payload.ingestionCutoffAt, ""),
    releasedAt: text(payload.releasedAt, ""),
    policyVersion: text(payload.privacyPolicy?.version, ""),
    minimumIndependentParticipants: finite(
      payload.privacyPolicy?.minimumIndependentParticipants,
      null
    ),
    cells: []
  };

  if (payload.releaseStatus === "not_yet_published") {
    return { ...base, state: "not_yet_published" };
  }
  if (payload.releaseStatus === "withdrawn") {
    return { ...base, state: "withdrawn" };
  }
  if (payload.releaseStatus === "suppressed") {
    return { ...base, state: "suppressed" };
  }
  if (payload.releaseStatus !== "published"
      || !base.snapshotId
      || !base.period.startAt
      || !base.period.endAt
      || !base.ingestionCutoffAt
      || !base.releasedAt
      || !base.policyVersion
      || !Number.isSafeInteger(base.minimumIndependentParticipants)
      || base.minimumIndependentParticipants < 3
      || !Array.isArray(payload.cells)
      || payload.cells.length > 100) {
    return { ...base, state: "unsupported_schema" };
  }

  const cells = [];
  let partial = false;
  for (const candidate of payload.cells) {
    const provider = text(candidate?.provider, "");
    const modelId = text(candidate?.modelId, "");
    if (!provider || !modelId || !candidate.metrics
        || typeof candidate.metrics !== "object"
        || Array.isArray(candidate.metrics)) {
      return { ...base, state: "unsupported_schema" };
    }
    const metrics = {};
    for (const [metricName, expectedUnit] of Object.entries(COMMUNITY_METRIC_UNITS)) {
      const metric = snapshotMetric(candidate.metrics[metricName], expectedUnit);
      if (!metric) return { ...base, state: "unsupported_schema" };
      metrics[metricName] = metric;
      partial ||= metric.status === "suppressed";
    }
    cells.push({ provider, modelId, metrics });
  }
  return {
    ...base,
    state: partial ? "published_partial" : "published",
    cells
  };
}

function normalizeQuotaMovement(payload) {
  const status = text(payload?.status, "not_testable");
  const base = {
    schemaVersion: text(payload?.schemaVersion, ""),
    status: status === "conditional_estimate" ? status : "not_testable",
    reason: text(payload?.reason, status === "conditional_estimate" ? "" : "insufficient_quota_observations"),
    interpretation: text(payload?.interpretation, ""),
    accountContinuity: text(payload?.accountContinuity, "not_transmitted"),
    provider: text(payload?.provider, ""),
    planType: text(payload?.planType, ""),
    planVariant: text(payload?.planVariant, ""),
    limitId: text(payload?.limitId, ""),
    slot: text(payload?.slot, ""),
    resetsAt: text(payload?.resetsAt, ""),
    apiPriceEquivalentCapacityUsd: nonNegative(payload?.apiPriceEquivalentCapacityUsd, null),
    observedUsedPercentSpan: finite(payload?.observedUsedPercentSpan, null),
    pricedUsageUsd: nonNegative(payload?.pricedUsageUsd, null),
    rows: []
  };
  if (base.status !== "conditional_estimate") return base;

  base.rows = array(payload?.rows).slice(0, 6000).flatMap((row) => {
    const smoothingHours = count(row?.smoothingHours, null);
    const timestamp = text(row?.timestamp ?? row?.windowEndUtc, "");
    const windowStartUtc = text(row?.windowStartUtc, "");
    const windowEndUtc = text(row?.windowEndUtc ?? row?.timestamp, "");
    const observedQuotaChangePp = finite(row?.observedQuotaChangePp, null);
    const expectedQuotaChangePp = finite(row?.expectedQuotaChangePp, null);
    const apiPriceEquivalentUsd = nonNegative(row?.apiPriceEquivalentUsd, null);
    const usageEvents = count(row?.usageEvents, null);
    if (![1, 2, 3].includes(smoothingHours)
        || !Number.isFinite(Date.parse(timestamp))
        || !Number.isFinite(Date.parse(windowStartUtc))
        || !Number.isFinite(Date.parse(windowEndUtc))
        || observedQuotaChangePp === null
        || expectedQuotaChangePp === null
        || apiPriceEquivalentUsd === null
        || usageEvents === null) {
      return [];
    }
    return [{
      smoothingHours,
      timestamp,
      windowStartUtc,
      windowEndUtc,
      observedQuotaChangePp,
      expectedQuotaChangePp,
      apiPriceEquivalentUsd,
      usageEvents
    }];
  });
  if (!base.rows.length) {
    base.status = "not_testable";
    base.reason = "no_valid_rolling_rows";
  }
  return base;
}

function normalizeAccountScopedQuotaAnalysis(payload) {
  const unavailable = {
    status: "not_testable",
    reason: text(payload?.reason, "account_scoped_dataset_unavailable"),
    tracks: []
  };
  if (payload?.schemaVersion !== "account-scoped-quota-analysis-v0.1") {
    return unavailable;
  }
  if (payload.status !== "ready" || !Array.isArray(payload.tracks)) {
    return unavailable;
  }
  const tracks = payload.tracks.slice(0, 20).flatMap((source, index) => {
    const continuity = source?.continuity ?? {};
    const windowDurationMinutes = count(continuity.windowDurationMinutes, null);
    if (
      !["openai_codex", "anthropic_claude_code"].includes(continuity.provider)
      || ![300, 10_080].includes(windowDurationMinutes)
    ) {
      return [];
    }
    const calibrationTrack = array(source?.calibration?.tracks)[0] ?? {};
    const resetRows = array(calibrationTrack.resets);
    const estimates = resetRows.filter((row) => (
      row?.status === "conditional_estimate"
      && nonNegative(row?.capacityNanousd, null) !== null
    ));
    const latestEstimate = estimates.at(-1) ?? null;
    const range = latestEstimate?.sensitivityRangeNanousd;
    const rollingComparisons = source?.rolling?.status === "conditional_comparison"
      ? array(source?.rolling?.comparisons)
      : [];
    return [{
      index: index + 1,
      provider: text(continuity.provider, ""),
      planType: text(continuity.planType, "unknown"),
      planVariant: text(continuity.planVariant, "unknown"),
      limitId: text(continuity.limitId, "unknown"),
      windowDurationMinutes,
      policyEpoch: text(continuity.policyEpoch, "unknown"),
      totalResets: count(calibrationTrack.totalResetCount, resetRows.length),
      estimatedResets: count(calibrationTrack.estimatedResetCount, estimates.length),
      latestCapacityUsd: latestEstimate
        ? nonNegative(latestEstimate.capacityNanousd, null) / 1_000_000_000
        : null,
      sensitivityLowerUsd: nonNegative(range?.lower, null) === null
        ? null
        : range.lower / 1_000_000_000,
      sensitivityUpperUsd: nonNegative(range?.upper, null) === null
        ? null
        : range.upper / 1_000_000_000,
      boundaryCount: count(latestEstimate?.boundaryCount, null),
      displayedSpanPp: finite(latestEstimate?.displayedSpanPp, null),
      refusalCodes: [...new Set(resetRows.flatMap((row) => (
        Array.isArray(row?.refusalCodes)
          ? row.refusalCodes.filter((code) => typeof code === "string").slice(0, 10)
          : []
      )))].slice(0, 10),
      rollingStatus: text(source?.rolling?.status, "not_testable"),
      rollingRefusalCodes: array(source?.rolling?.refusalCodes)
        .filter((code) => typeof code === "string")
        .slice(0, 10),
      rollingComparisonCount: rollingComparisons.length
    }];
  });
  return {
    status: tracks.length > 0 ? "ready" : "not_testable",
    reason: tracks.length > 0 ? "" : "supported_quota_track_unavailable",
    tracks
  };
}

export function normalizeParticipantCommunityComparison(payload) {
  const unavailable = {
    status: "not_testable",
    reason: text(payload?.reason, "stable_snapshot_unavailable"),
    snapshotId: text(payload?.snapshotId, ""),
    snapshotRevision: count(payload?.snapshotRevision, null),
    period: {
      startAt: text(payload?.period?.startAt, ""),
      endAt: text(payload?.period?.endAt, "")
    },
    cells: []
  };
  if (payload?.schemaVersion !== PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION) {
    return unavailable;
  }
  if (payload.status === "not_testable") return unavailable;
  if (payload.status !== "ready"
      || payload.interpretation !== "own_clipped_contribution_vs_public_rounded_total"
      || !unavailable.snapshotId
      || unavailable.snapshotRevision === null
      || unavailable.snapshotRevision < 1
      || !Number.isFinite(Date.parse(unavailable.period.startAt))
      || !Number.isFinite(Date.parse(unavailable.period.endAt))
      || !Array.isArray(payload.cells)
      || payload.cells.length > 100) {
    return { ...unavailable, reason: "comparison_contract_invalid" };
  }
  const cells = [];
  for (const candidate of payload.cells) {
    const provider = text(candidate?.provider, "");
    const modelId = text(candidate?.modelId, "");
    if (!["openai_codex", "anthropic_claude_code"].includes(provider)
        || !modelId
        || typeof candidate?.participantHasActivity !== "boolean"
        || !candidate?.metrics
        || typeof candidate.metrics !== "object"
        || Array.isArray(candidate.metrics)) {
      return { ...unavailable, reason: "comparison_contract_invalid" };
    }
    const metrics = {};
    for (const [metricName, expectedUnit] of Object.entries(
      PARTICIPANT_COMPARISON_METRIC_UNITS
    )) {
      const source = candidate.metrics[metricName];
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        return { ...unavailable, reason: "comparison_contract_invalid" };
      }
      if (source.status === "community_not_released") {
        metrics[metricName] = {
          status: "community_not_released",
          participantClippedValue: null,
          communityRoundedValue: null,
          unit: expectedUnit
        };
        continue;
      }
      const communityRoundedValue = count(source.communityRoundedValue, null);
      if (source.unit !== expectedUnit || communityRoundedValue === null) {
        return { ...unavailable, reason: "comparison_contract_invalid" };
      }
      if (source.status === "participant_component_unavailable") {
        metrics[metricName] = {
          status: "participant_component_unavailable",
          participantClippedValue: null,
          communityRoundedValue,
          unit: expectedUnit
        };
        continue;
      }
      const participantClippedValue = count(source.participantClippedValue, null);
      if (source.status !== "comparable" || participantClippedValue === null) {
        return { ...unavailable, reason: "comparison_contract_invalid" };
      }
      metrics[metricName] = {
        status: "comparable",
        participantClippedValue,
        communityRoundedValue,
        unit: expectedUnit
      };
    }
    cells.push({
      provider,
      modelId,
      participantHasActivity: candidate.participantHasActivity,
      metrics
    });
  }
  return {
    ...unavailable,
    status: "ready",
    reason: "",
    cells
  };
}

export function normalizeParticipantHistory(payload) {
  const unavailable = (reason) => ({
    state: "not_available",
    reason,
    consentVersion: "",
    participantCreatedAt: "",
    contributionCount: 0,
    clientSoftwareVersion: "unavailable_in_transport",
    items: []
  });
  if (!payload) return unavailable("service_unavailable");
  if (payload.schemaVersion !== PARTICIPANT_PROFILE_SCHEMA_VERSION) {
    return unavailable("unsupported_schema");
  }
  if (!PARTICIPANT_CONSENT_VERSIONS.has(payload.consentVersion)
      || !Number.isFinite(Date.parse(payload.createdAt))
      || !Array.isArray(payload.contributions)
      || payload.contributions.length > 101
      || count(payload.contributionCount, null) !== payload.contributions.length
      || count(payload.historyPolicy?.maximumItems, null) !== 101
      || count(payload.historyPolicy?.quarantineRetentionMilliseconds, null)
        !== 7 * 24 * 60 * 60 * 1000
      || payload.historyPolicy?.canonicalMetadataRetainedAfterQuarantine !== true
      || payload.historyPolicy?.clientSoftwareVersion !== "unavailable_in_transport") {
    return unavailable("invalid_contract");
  }

  const items = [];
  const contributionIds = new Set();
  for (const candidate of payload.contributions) {
    const contributionId = text(candidate?.contributionId, "");
    const status = text(candidate?.status, "");
    const schemaVersion = text(candidate?.schemaVersion, "");
    const transportSchemaVersion = text(candidate?.transportSchemaVersion, "");
    const createdAt = text(candidate?.createdAt, "");
    const startAt = text(candidate?.coveredAt?.startAt, "");
    const endAt = text(candidate?.coveredAt?.endAt, "");
    const clientPlatform = text(candidate?.clientPlatform, "");
    const providerPolicyEpoch = text(candidate?.providerPolicyEpoch, "");
    const quarantineState = text(candidate?.quarantine?.state, "");
    const scheduledDeletionAt = text(candidate?.quarantine?.scheduledDeletionAt, "");
    const deletedAt = candidate?.quarantine?.deletedAt === null
      ? null
      : text(candidate?.quarantine?.deletedAt, "");
    const createdEpoch = Date.parse(createdAt);
    const startEpoch = Date.parse(startAt);
    const endEpoch = Date.parse(endAt);
    const scheduledEpoch = Date.parse(scheduledDeletionAt);
    const deletedEpoch = deletedAt === null ? null : Date.parse(deletedAt);
    if (!CONTRIBUTION_ID_PATTERN.test(contributionId)
        || contributionIds.has(contributionId)
        || !["accepted", "accepted_synthetic", "deleting"].includes(status)
        || typeof candidate?.synthetic !== "boolean"
        || !CONTRIBUTION_SCHEMA_VERSIONS.has(schemaVersion)
        || !CONTRIBUTION_SCHEMA_VERSIONS.has(transportSchemaVersion)
        || (candidate.synthetic
          && (schemaVersion !== "synthetic-contribution-v0.1"
            || transportSchemaVersion !== "synthetic-contribution-v0.1"
            || !["accepted_synthetic", "deleting"].includes(status)))
        || (!candidate.synthetic
          && (schemaVersion === "synthetic-contribution-v0.1"
            || transportSchemaVersion === "synthetic-contribution-v0.1"
            || !["accepted", "deleting"].includes(status)))
        || !["macos", "linux", "windows", "other", "unknown"].includes(clientPlatform)
        || !CONTRIBUTION_POLICY_EPOCHS.has(providerPolicyEpoch)
        || !Number.isFinite(createdEpoch)
        || !Number.isFinite(startEpoch)
        || !Number.isFinite(endEpoch)
        || endEpoch < startEpoch
        || !Number.isFinite(scheduledEpoch)
        || scheduledEpoch !== createdEpoch + (7 * 24 * 60 * 60 * 1000)
        || !["retained", "deleted"].includes(quarantineState)
        || (quarantineState === "retained" && deletedAt !== null)
        || (quarantineState === "deleted"
          && (deletedAt === null
            || !Number.isFinite(deletedEpoch)
            || deletedEpoch < createdEpoch))
        || candidate?.quarantine?.canonicalMetadataRetained !== true) {
      return unavailable("invalid_contract");
    }
    contributionIds.add(contributionId);

    let recordCounts = null;
    if (candidate.recordCounts !== null) {
      const declared = count(candidate?.recordCounts?.declared, null);
      const accepted = count(candidate?.recordCounts?.accepted, null);
      const deduplicated = count(candidate?.recordCounts?.deduplicated, null);
      if (declared === null || accepted === null || deduplicated === null
          || accepted + deduplicated !== declared) {
        return unavailable("invalid_contract");
      }
      recordCounts = { declared, accepted, deduplicated };
    }

    const priceVerification = text(candidate?.serverAccounting?.verification, "");
    const serverPrice = priceVerification === "server_repriced"
      ? nonNegative(candidate?.serverAccounting?.apiPriceEquivalentUsd, null)
      : null;
    if (!["server_repriced", "server_repricing_unavailable"].includes(priceVerification)
        || (priceVerification === "server_repriced" && serverPrice === null)
        || (priceVerification === "server_repricing_unavailable"
          && candidate?.serverAccounting?.apiPriceEquivalentUsd !== null)) {
      return unavailable("invalid_contract");
    }

    items.push({
      contributionId,
      status,
      synthetic: candidate?.synthetic === true,
      schemaVersion,
      transportSchemaVersion,
      createdAt,
      coveredAt: { startAt, endAt },
      clientPlatform,
      providerPolicyEpoch,
      recordCounts,
      serverAccounting: {
        apiPriceEquivalentUsd: serverPrice,
        verification: priceVerification
      },
      quarantine: {
        state: quarantineState,
        scheduledDeletionAt,
        deletedAt,
        canonicalMetadataRetained: true
      }
    });
  }
  items.sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
      || right.contributionId.localeCompare(left.contributionId)
  ));
  return {
    state: "ready",
    reason: "",
    consentVersion: payload.consentVersion,
    participantCreatedAt: payload.createdAt,
    contributionCount: items.length,
    clientSoftwareVersion: "unavailable_in_transport",
    items
  };
}

export function normalizeParticipantStats(payload) {
  if (!payload) {
    return {
      state: "service_unavailable",
      schemaVersion: "",
      totals: {},
      pricingCoverage: { state: "not_testable" },
      standardApiCounterfactual: { state: "not_testable", apiPriceEquivalentUsd: null },
      codexFastObservations: { state: "not_testable", eventShare: null, eventCount: null },
      rollingQuotaMovement: normalizeQuotaMovement(null),
      accountScopedQuotaAnalysis: normalizeAccountScopedQuotaAnalysis(null),
      communityComparison: normalizeParticipantCommunityComparison(null)
    };
  }
  if (payload.schemaVersion !== PARTICIPANT_STATS_SCHEMA_VERSION) {
    return {
      state: "unsupported_schema",
      schemaVersion: text(payload?.schemaVersion, ""),
      totals: {},
      pricingCoverage: { state: "not_testable" },
      standardApiCounterfactual: { state: "not_testable", apiPriceEquivalentUsd: null },
      codexFastObservations: { state: "not_testable", eventShare: null, eventCount: null },
      rollingQuotaMovement: normalizeQuotaMovement(null),
      accountScopedQuotaAnalysis: normalizeAccountScopedQuotaAnalysis(null),
      communityComparison: normalizeParticipantCommunityComparison(null)
    };
  }

  const source = payload.totals ?? {};
  const usageEvents = count(source.usageEvents, null);
  const fullyPricedEvents = count(source.fullyPricedEvents, null);
  const partiallyPricedEvents = count(source.partiallyPricedEvents, null);
  const unpricedEvents = count(source.unpricedEvents, null);
  const classifiedEvents = [fullyPricedEvents, partiallyPricedEvents, unpricedEvents]
    .every((value) => value !== null)
    ? fullyPricedEvents + partiallyPricedEvents + unpricedEvents
    : null;
  const classifiedWithinTotal = usageEvents !== null
    && classifiedEvents !== null
    && classifiedEvents <= usageEvents;
  const pricedEvents = classifiedWithinTotal
    ? fullyPricedEvents + partiallyPricedEvents
    : null;
  const pricingCoveragePercent = usageEvents > 0 && pricedEvents !== null
    ? Number((pricedEvents * 100 / usageEvents).toFixed(6))
    : null;
  let pricingCoverageState = "unknown";
  if (usageEvents === 0) pricingCoverageState = "not_testable";
  else if (classifiedWithinTotal && pricedEvents === 0) pricingCoverageState = "unpriced";
  else if (classifiedWithinTotal
      && fullyPricedEvents === usageEvents
      && partiallyPricedEvents === 0
      && unpricedEvents === 0) {
    pricingCoverageState = "fully_priced";
  } else if (classifiedWithinTotal && pricedEvents > 0) {
    pricingCoverageState = "partially_priced";
  }

  const priceVerification = text(source.priceVerification, "");
  const apiPriceEquivalentUsd = priceVerification === "server_repriced"
    ? nonNegative(source.apiPriceEquivalentUsd, null)
    : null;
  const standardSource = payload.standardApiCounterfactual
    ?? source.standardApiCounterfactual
    ?? {};
  const standardApiPriceEquivalentUsd = nonNegative(
    source.standardApiCounterfactualUsd
      ?? standardSource.apiPriceEquivalentUsd,
    null
  );
  const standardEvents = count(
    source.standardApiCounterfactualEvents
      ?? standardSource.events,
    null
  );
  const fastInsight = array(payload.insights).find((item) => item?.code === "fast_event_share");
  const fastEventShare = finite(
    source.fastEventShare
      ?? payload.codexFastObservations?.eventShare
      ?? fastInsight?.value,
    null
  );
  const safeFastEventShare = fastEventShare !== null && fastEventShare >= 0 && fastEventShare <= 1
    ? fastEventShare
    : null;
  const fastEventCount = count(
    source.fastEvents
      ?? payload.codexFastObservations?.eventCount,
    null
  );

  return {
    state: "ready",
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    generatedAt: text(payload.generatedAt, ""),
    totals: {
      contributions: count(source.contributions, null),
      usageEvents,
      quotaSnapshots: count(source.quotaSnapshots, null),
      activityMarkers: count(source.activityMarkers, null),
      apiPriceEquivalentUsd,
      priceVerification,
      serverUnknownBillableUnits: count(source.serverUnknownBillableUnits, null)
    },
    pricingCoverage: {
      state: pricingCoverageState,
      percent: pricingCoveragePercent,
      fullyPricedEvents,
      partiallyPricedEvents,
      unpricedEvents,
      unclassifiedEvents: classifiedWithinTotal ? usageEvents - classifiedEvents : null
    },
    standardApiCounterfactual: {
      state: standardApiPriceEquivalentUsd === null ? "not_separately_returned" : "server_repriced",
      apiPriceEquivalentUsd: standardApiPriceEquivalentUsd,
      events: standardEvents,
      basis: text(
        source.standardApiCounterfactualBasis
          ?? standardSource.basis,
        "subscription_standard_counterfactual"
      )
    },
    codexFastObservations: {
      state: safeFastEventShare === null && fastEventCount === null ? "not_testable" : "observed",
      eventShare: safeFastEventShare,
      eventCount: fastEventCount
    },
    rollingQuotaMovement: normalizeQuotaMovement(payload.rollingQuotaMovement),
    accountScopedQuotaAnalysis: normalizeAccountScopedQuotaAnalysis(
      payload.accountScopedQuotaAnalysis
    ),
    communityComparison: normalizeParticipantCommunityComparison(
      payload.communityComparison
    )
  };
}

function artifactData(payload) {
  return payload?.snapshot?.datasets ?? payload?.datasets ?? payload ?? {};
}

function safeState(value, fallback = "insufficient") {
  const normalized = String(value ?? "").toLowerCase();
  if (["live", "current", "ok", "ready"].includes(normalized)) return "live";
  if (["stale", "delayed"].includes(normalized)) return "stale";
  if (["demo", "synthetic"].includes(normalized)) return "demo";
  if (["offline", "unavailable", "error"].includes(normalized)) return "offline";
  return fallback;
}

function normalizeQuota(window, index) {
  const used = finite(window?.usedPercent ?? window?.used_percent ?? window?.used, null);
  const remaining = finite(window?.remainingPercent ?? window?.remaining_percent, used === null ? null : 100 - used);
  const durationMinutes = finite(window?.durationMinutes ?? window?.duration_minutes ?? window?.windowMinutes, null);
  return {
    id: text(window?.id ?? window?.limitId, `quota-${index}`),
    label: text(window?.label, durationMinutes === 10080 ? "Seven-day allowance" : durationMinutes === 300 ? "Five-hour allowance" : "Quota window"),
    durationMinutes,
    usedPercent: used,
    remainingPercent: remaining,
    resetAt: text(window?.resetAt ?? window?.reset_at, ""),
    observedAt: text(window?.observedAt ?? window?.observed_at, ""),
    precision: finite(window?.precision ?? window?.displayPrecision, null),
    planType: text(window?.planType ?? window?.plan_type, ""),
    status: safeState(window?.status, "live")
  };
}

function normalizePricing(pricing = {}) {
  const source = pricing?.components ?? pricing?.componentTotals ?? {};
  const componentRows = Array.isArray(source)
    ? source
    : Object.entries(source).map(([name, value]) => ({
        name,
        tokens: value?.tokens ?? value?.tokenCount ?? value,
        costUsd: value?.costUsd ?? value?.estimatedCostUsd
      }));
  return {
    totalCostUsd: finite(pricing?.totalCostUsd ?? pricing?.estimatedApiCostUsd ?? pricing?.total_usd, null),
    periodLabel: text(pricing?.periodLabel ?? pricing?.label, "Recorded period"),
    coveragePercent: finite(pricing?.coveragePercent ?? pricing?.pricedCoveragePercent ?? pricing?.pricedEventCoveragePercent, null),
    eventCount: finite(pricing?.eventCount ?? pricing?.pricedEventCount, null),
    apiTier: text(pricing?.apiTier ?? pricing?.tier, "standard"),
    components: componentRows.slice(0, 12).map((row) => ({
      name: text(row?.name ?? row?.component, "Unknown"),
      tokens: finite(row?.tokens ?? row?.value, 0),
      costUsd: finite(row?.costUsd, null)
    }))
  };
}

function normalizeGradient(payload = {}) {
  const source = artifactData(payload?.gradient ?? payload);
  const diagnosticRolling = [
    ...array(source.fastHourly ?? source.fast_hourly).map((row) => ({
      ...row,
      smoothing_hours: 1
    })),
    ...array(source.fastTwoHour ?? source.fast_two_hour).map((row) => ({
      ...row,
      smoothing_hours: 2
    }))
  ];
  return {
    summary: array(source.summary)[0] ?? source.summary ?? {},
    curve: array(source.curve),
    rolling: [...array(source.rolling), ...diagnosticRolling],
    rollingHistory: array(source.rollingHistory ?? source.rolling_history),
    rollingDetail: array(source.rollingDetail ?? source.current_rolling_detail),
    residual: array(source.residual ?? source.rolling_residual),
    windowSensitivity: array(source.windowSensitivity ?? source.window_sensitivity)
  };
}

function normalizeWeekly(payload = {}) {
  const source = artifactData(payload?.weekly ?? payload);
  return {
    summary: array(source.summary)[0] ?? source.summary ?? {},
    weeklyValues: array(source.weeklyValues ?? source.weekly_values),
    valueSeries: array(source.valueSeries ?? source.value_series),
    holdoutSeries: array(source.holdoutSeries ?? source.holdout_series),
    errorConcentration: array(source.errorConcentration ?? source.error_concentration),
    providerEpochs: array(source.providerEpochs ?? source.provider_epochs)
  };
}

function normalizeQuality(payload = {}) {
  const source = artifactData(payload?.quality ?? payload);
  return {
    summary: array(source.summary)[0] ?? source.summary ?? {},
    coverage: array(source.coverage),
    signals: array(source.signals),
    opportunities: array(source.opportunities),
    blindSpots: array(source.blindSpots ?? source.blind_spots)
  };
}

export function normalizeDashboardPayload(payload = {}, fragments = {}) {
  const overview = payload?.overview ?? fragments.overview ?? payload;
  const freshness = overview?.freshness ?? {};
  const usagePeriods = array(overview?.usage);
  const selectedUsage = usagePeriods.find((period) => period?.id === "7d" && finite(period?.events, 0) > 0)
    ?? usagePeriods.find((period) => period?.id === "all")
    ?? usagePeriods[0]
    ?? {};
  const pricing = overview?.pricing ?? overview?.live?.pricing ?? {};
  const quota = overview?.quota ?? overview?.live?.quota ?? {};
  const quotaRows = array(overview?.quotaWindows ?? overview?.live?.quotaWindows ?? quota?.windows);
  const mode = text(overview?.mode ?? payload?.mode, "local");
  const state = mode === "demo"
    ? "demo"
    : safeState(freshness?.status ?? overview?.status ?? overview?.evidenceStatus ?? payload?.status, "insufficient");
  const reportsPayload = payload?.reports ?? fragments.reports ?? {};
  const quotaWindows = quotaRows.map((window, index) => normalizeQuota({
    ...window,
    observedAt: window?.observedAt ?? quota?.observedAt
  }, index));
  const durationCounts = new Map();
  for (const window of quotaWindows) {
    const key = window.durationMinutes ?? window.label;
    durationCounts.set(key, (durationCounts.get(key) ?? 0) + 1);
  }
  const durationOrdinals = new Map();
  for (const window of quotaWindows) {
    const key = window.durationMinutes ?? window.label;
    if ((durationCounts.get(key) ?? 0) < 2) continue;
    const ordinal = (durationOrdinals.get(key) ?? 0) + 1;
    durationOrdinals.set(key, ordinal);
    window.label = `Account ${ordinal} · ${window.label.toLowerCase()}`;
  }
  return {
    schemaVersion: text(overview?.schemaVersion ?? payload?.schemaVersion, "local-dashboard-unknown"),
    mode,
    state,
    generatedAt: text(overview?.generatedAt ?? payload?.generatedAt, ""),
    freshness: {
      status: state,
      latestObservedAt: text(freshness?.latestObservedAt ?? overview?.latestObservedAt ?? overview?.latestEvidenceAt, ""),
      ageSeconds: finite(freshness?.ageSeconds ?? freshness?.age_seconds, null),
      staleAfterSeconds: finite(freshness?.staleAfterSeconds, null)
    },
    quotaWindows,
    activity: {
      ...(overview?.activity ?? overview?.live?.activity ?? {}),
      usageEvents: overview?.activity?.usageEvents ?? selectedUsage?.events,
      totalTokens: overview?.activity?.totalTokens ?? selectedUsage?.totalTokens
    },
    pricing: normalizePricing({
      ...pricing,
      totalCostUsd: pricing?.totalCostUsd ?? selectedUsage?.apiPriceEquivalentUsd,
      periodLabel: pricing?.periodLabel ?? selectedUsage?.label,
      coveragePercent: pricing?.coveragePercent ?? (
        finite(selectedUsage?.pricedEventFraction) === null
          ? null
          : Number((selectedUsage.pricedEventFraction * 100).toFixed(6))
      ),
      eventCount: pricing?.eventCount ?? selectedUsage?.events,
      components: pricing?.components ?? selectedUsage?.components
    }),
    coverage: overview?.coverage ?? {},
    warnings: array(overview?.warnings).map((warning) => text(warning?.message ?? warning, "")).filter(Boolean),
    collector: overview?.collector ?? {},
    gradient: normalizeGradient(payload?.gradient ?? fragments.gradient),
    weekly: normalizeWeekly(payload?.weekly ?? fragments.weekly),
    quality: normalizeQuality(payload?.quality ?? fragments.quality),
    reports: array(reportsPayload?.reports ?? reportsPayload).slice(0, 20).map((report) => ({
      id: text(report?.id, ""),
      title: text(report?.title, "Detailed report"),
      href: text(report?.href, ""),
      updatedAt: text(report?.updatedAt ?? report?.modifiedAt, ""),
      status: safeState(report?.status, "live")
    })).filter((report) => report.href.startsWith("/") && !report.href.startsWith("//"))
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetchImpl(url, {
    ...requestOptions,
    headers: { Accept: "application/json", ...headers }
  });
  if (!response.ok) {
    const error = new Error(`Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export class LocalCompanionClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async load() {
    try {
      const [status, dashboard] = await Promise.all([
        fetchJson(this.fetchImpl, `${LOCAL_ROOT}/v1/status`).catch(() => null),
        fetchJson(this.fetchImpl, `${LOCAL_ROOT}/v1/dashboard`)
      ]);
      return normalizeDashboardPayload({ ...dashboard, status: dashboard?.status ?? status?.status });
    } catch (error) {
      if (![404, 405].includes(error.status)) throw error;
    }

    const paths = ["overview", "gradient", "weekly", "quality", "reports"];
    const settled = await Promise.allSettled(paths.map((path) => fetchJson(this.fetchImpl, `${LOCAL_ROOT}/${path}`)));
    const fragments = Object.fromEntries(settled.map((result, index) => [
      paths[index],
      result.status === "fulfilled" ? result.value : null
    ]));
    if (!fragments.overview) throw new Error("The local companion did not return an overview.");
    return normalizeDashboardPayload({}, fragments);
  }

  async refresh() {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1"
      },
      body: JSON.stringify({})
    });
  }

  refreshStatus() {
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/refresh`);
  }

  async contributionSyncStatus() {
    try {
      return normalizeContributionSyncStatus(
        await fetchJson(
          this.fetchImpl,
          `${LOCAL_ROOT}/contribution/sync-status`
        )
      );
    } catch {
      return normalizeContributionSyncStatus(null);
    }
  }
}

export class CommunityClient {
  constructor({ fetchImpl = globalThis.fetch, getCsrfToken = () => null } = {}) {
    this.fetchImpl = fetchImpl;
    this.getCsrfToken = getCsrfToken;
    this.pendingRecovery = null;
  }

  sessionOptions(options = {}) {
    return { credentials: "same-origin", ...options };
  }

  mutationOptions(options = {}) {
    const csrfToken = this.getCsrfToken();
    if (typeof csrfToken !== "string" || csrfToken.length === 0) {
      throw new Error("A current session confirmation is required.");
    }
    return this.sessionOptions({
      ...options,
      headers: {
        "X-Usage-Monitor-CSRF": csrfToken,
        ...(options.headers ?? {})
      }
    });
  }

  health() {
    return fetchJson(this.fetchImpl, "/api/health");
  }

  session() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/session`, this.sessionOptions());
  }

  enroll(inviteCode = null, contributionSchemaVersion = "telemetry-contribution-v0.1") {
    const accountScoped = contributionSchemaVersion === "telemetry-contribution-v0.2";
    const body = {
      consentVersion: accountScoped
        ? "privacy-safe-telemetry-v0.2"
        : "privacy-safe-telemetry-v0.1",
      syntheticOnly: false
    };
    if (typeof inviteCode === "string" && inviteCode.length > 0) body.inviteCode = inviteCode;
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/enroll`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async recover(recoveryCode) {
    if (this.pendingRecovery?.recoveryCode !== recoveryCode) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const secret = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      this.pendingRecovery = {
        recoveryCode,
        recoveryAttemptId: `um_recovery_attempt_${secret}`
      };
    }
    try {
      const result = await fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/recover`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.pendingRecovery)
      });
      this.pendingRecovery = null;
      return result;
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status < 500) {
        this.pendingRecovery = null;
      }
      throw error;
    }
  }

  envelopeKey() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/envelope-key`);
  }

  registerUpload({ envelopeDigest, contentLengthBytes, contentType = "application/json" }) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/upload-authorizations`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelopeDigest, contentLengthBytes, contentType })
    }));
  }

  contributeSerialized(serializedEnvelope, uploadAuthorization) {
    if (typeof uploadAuthorization !== "string" || uploadAuthorization.length === 0) {
      throw new Error("A one-use upload authorization is required.");
    }
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/contributions`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Upload ${uploadAuthorization}`
      },
      body: serializedEnvelope
    });
  }

  contribution(contributionId) {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/contributions/read`,
      this.mutationOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributionId })
      })
    );
  }

  deleteContribution(contributionId) {
    if (typeof contributionId !== "string"
        || !CONTRIBUTION_ID_PATTERN.test(contributionId)) {
      throw new Error("Choose a valid contribution.");
    }
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/contributions/delete`,
      this.mutationOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contributionId })
      })
    );
  }

  async personalStats() {
    try {
      return await fetchJson(
        this.fetchImpl,
        `${CENTRAL_ROOT}/me/stats`,
        this.sessionOptions()
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      return fetchJson(
        this.fetchImpl,
        `${CENTRAL_ROOT}/me/insights`,
        this.sessionOptions()
      );
    }
  }

  participantProfile() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me`,
      this.sessionOptions()
    );
  }

  async communityStats() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/stats/aggregate`);
  }

  participantExport() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/export`,
      this.sessionOptions()
    );
  }

  deleteParticipant() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me`,
      this.mutationOptions({ method: "DELETE" })
    );
  }

  createDevicePairing(accountScoped = false) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/device-pairings`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consentVersion: accountScoped
          ? "ongoing-privacy-safe-telemetry-v0.2"
          : "ongoing-privacy-safe-telemetry-v0.1",
        ongoingUpload: true
      })
    }));
  }

  devices() {
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/devices`,
      this.sessionOptions()
    );
  }

  revokeDevice(deviceId) {
    if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/u.test(deviceId)) {
      throw new Error("Choose a valid paired device.");
    }
    return fetchJson(
      this.fetchImpl,
      `${CENTRAL_ROOT}/me/devices/revoke`,
      this.mutationOptions({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId })
      })
    );
  }

  logout() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/logout`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }));
  }

  securityReset() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/security-reset`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }));
  }
}

export function demoDashboard() {
  const now = "2026-07-25T14:00:00.000Z";
  const rolling = [];
  for (const smoothingHours of [1, 2, 3]) {
    for (let index = 0; index < 36; index += 1) {
      const timestamp = new Date(Date.parse(now) - (35 - index) * 3_600_000).toISOString();
      const scale = smoothingHours / 3;
      const observed = Math.max(
        0,
        (4.8 + Math.sin(index / 3) * 2.5 + (index > 20 && index < 25 ? 3.2 : 0)) * scale
      );
      rolling.push({
        timestamp,
        series: "Observed quota change",
        quota_change_pp: Number(observed.toFixed(2)),
        smoothing_hours: smoothingHours
      });
      rolling.push({
        timestamp,
        series: "Expected from API cost",
        quota_change_pp: Number((observed * .82 + Math.cos(index / 4) * .8 * scale).toFixed(2)),
        smoothing_hours: smoothingHours
      });
    }
  }
  const weeklyValues = Array.from({ length: 7 }, (_, index) => ({
    sequence: index + 1,
    reset_due_at: new Date(Date.parse("2026-06-13T00:00:00Z") + index * 7 * 86_400_000).toISOString(),
    value_usd: [2125, 2080, 2022, 1960, 1905, 1875, 1888][index],
    pairwise_p10_usd: [1790, 1740, 1690, 1650, 1590, 1600, 1610][index],
    pairwise_p90_usd: [2370, 2310, 2240, 2170, 2080, 2100, 2120][index],
    holdout_mae_pp: [2.1, 2.8, 2.2, 3.4, 2.5, 1.9, 2.2][index],
    eligible_transitions: 70 + index * 9
  }));
  return normalizeDashboardPayload({
    schemaVersion: "demo-dashboard-v0.1",
    mode: "demo",
    status: "demo",
    generatedAt: now,
    freshness: { status: "demo", latestObservedAt: now, ageSeconds: 0 },
    quotaWindows: [
      { id: "weekly", label: "Seven-day allowance", durationMinutes: 10080, usedPercent: 39, remainingPercent: 61, resetAt: "2026-07-28T17:06:03Z", observedAt: now, planType: "pro", status: "demo" },
      { id: "primary", label: "Five-hour allowance", durationMinutes: 300, usedPercent: 18, remainingPercent: 82, resetAt: "2026-07-25T18:05:00Z", observedAt: now, planType: "pro", status: "demo" }
    ],
    activity: { eventCount: 8120, safeRecordCount: 11432, lastScanAt: now },
    pricing: {
      totalCostUsd: 463.82,
      periodLabel: "Last 7 days",
      coveragePercent: 91.4,
      eventCount: 8120,
      apiTier: "standard",
      components: [
        { name: "Uncached input", tokens: 38_200_000, costUsd: 212.4 },
        { name: "Cached input", tokens: 214_000_000, costUsd: 71.2 },
        { name: "Output text", tokens: 9_800_000, costUsd: 98.7 },
        { name: "Reasoning output", tokens: 7_300_000, costUsd: 81.52 }
      ]
    },
    gradient: {
      summary: [{ mean_absolute_error_pp: 2.7, points_within_80_band_fraction: .62, rolling_peak_absolute_residual_pp: 3.2 }],
      rolling,
      rolling_residual: rolling.filter((row) => row.series.startsWith("Observed")).map((row, index) => {
        const expected = rolling[index * 2 + 1]?.quota_change_pp ?? 0;
        return { timestamp: row.timestamp, observed_quota_change_pp: row.quota_change_pp, expected_quota_change_pp: expected, residual_pp: row.quota_change_pp - expected };
      }),
      window_sensitivity: [{ smoothing_hours: 1, mae_pp: 3.1 }, { smoothing_hours: 2, mae_pp: 2.4 }, { smoothing_hours: 3, mae_pp: 2.7 }]
    },
    weekly: {
      summary: [{ median_weekly_value_usd: 1878.75, lower_80_across_resets_usd: 1640.96, upper_80_across_resets_usd: 2280.38, qualifying_resets: 14, selected_holdout_mae_pp: 2.16, prior_reset_p80_absolute_error_pp: 7.39 }],
      weekly_values: weeklyValues
    },
    quality: {
      summary: [{ fit_eligible_fraction: .0088, known_speed_fraction: .912, collector_age_hours: 0.1 }],
      coverage: [
        { dimension: "Priced model", coverage_fraction: .914 },
        { dimension: "Speed tier known", coverage_fraction: .912 },
        { dimension: "Quota transitions", coverage_fraction: .67 },
        { dimension: "Account scope known", coverage_fraction: .12 }
      ],
      opportunities: [
        { priority: "P0", title: "Unknown model tokens", evidence: "Some historical events cannot be matched to a current API price card." },
        { priority: "P0", title: "Integer quota display", evidence: "Quota observations are rounded to whole percentage points." },
        { priority: "P1", title: "Shared agentic surfaces", evidence: "Work, Workspace Agents, and Voice task work may draw from the same pool." },
        { priority: "P1", title: "Fast-mode attribution", evidence: "Historical records do not always identify the subscription speed tier." }
      ]
    },
    reports: {
      reports: [
        { id: "gradient", title: "Full gradient report", href: "/reports/simple-quota-gradient", status: "demo" },
        { id: "weekly", title: "Weekly calibration report", href: "/reports/weekly-calibration", status: "demo" },
        { id: "quality", title: "Monitoring quality report", href: "/reports/monitoring-quality", status: "demo" }
      ]
    }
  });
}
