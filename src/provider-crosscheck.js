import { sanitizeAccountScope } from "./providers/codex/account.js";
import { policyEpochAt, policyEpochsInRange } from "./policy-epochs.js";

const SCHEMA_VERSION = "0.1";
const UI_SURFACES = new Set(["desktop_app", "cloud", "web", "mobile", "exec", "desktop", "cli", "extension", "code_review"]);

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function safePercentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeUiObservation(observation) {
  if (!observation || observation.kind !== "provider_ui_usage_snapshot") return null;
  if (!Number.isFinite(Date.parse(observation.capturedAt))) return null;
  const startAt = observation.range?.startAt;
  const endAt = observation.range?.endAt;
  if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt)) || Date.parse(endAt) < Date.parse(startAt)) return null;
  const surfaceCategories = Array.isArray(observation.surfaceCategories)
    ? observation.surfaceCategories.filter((surface) => UI_SURFACES.has(surface))
    : [];
  return {
    schemaVersion: "0.1",
    kind: "provider_ui_usage_snapshot",
    capturedAt: observation.capturedAt,
    accountScope: sanitizeAccountScope(observation.accountScope),
    range: { startAt, endAt },
    weekly: {
      remainingPercent: safePercentage(observation.weekly?.remainingPercent),
      resetsAt: Number.isFinite(Date.parse(observation.weekly?.resetsAt)) ? observation.weekly.resetsAt : null,
    },
    turnsByModelTotal: safeCount(observation.turnsByModelTotal),
    turnsBySurfaceTotal: safeCount(observation.turnsBySurfaceTotal),
    surfaceCategories: [...new Set(surfaceCategories)].sort(),
    workSharedPoolTextObserved: observation.workSharedPoolTextObserved === true,
    source: "authenticated_visible_dom",
  };
}

function dailyPlanContext(providerPlanType) {
  // The provider plan_type names the plan; there is no separate invented
  // variant layer. Historical local rollouts stay account-unattributed.
  return {
    providerPlanType,
    localAlias: null,
    source: "historical_local_account_unattributed",
  };
}

function classifyDailyComparison(localTokens, officialTokens) {
  if (officialTokens === null) return "official_bucket_unavailable";
  if (localTokens === 0 && officialTokens > 0) return "provider_only_activity";
  if (officialTokens === 0 && localTokens > 0) return "local_exceeds_zero_provider_bucket";
  if (officialTokens === 0 && localTokens === 0) return "both_zero";
  const ratio = localTokens / officialTokens;
  if (ratio < 0.8) return "material_provider_activity_unallocated";
  if (ratio > 1.2) return "local_exceeds_provider_activity";
  return "broadly_aligned";
}

function componentTotal(components) {
  return Object.values(components ?? {}).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

export function createProspectiveAccountScopedAccumulator({
  accountScope,
  providerPlanType,
  startAt,
  endAt,
} = {}) {
  const sanitizedAccountScope = sanitizeAccountScope(accountScope);
  if (!Number.isFinite(Date.parse(startAt)) || !Number.isFinite(Date.parse(endAt))) {
    throw new TypeError("Prospective account accumulator requires bounded timestamps");
  }
  const plan = providerPlanType ?? "unknown";
  const daily = new Map();
  let eventCount = 0;
  let totalTokens = 0;
  let firstObservedAt = null;
  let lastObservedAt = null;
  return {
    add(record) {
      if (record?.kind !== "codex_rollout_usage_snapshot"
          || record.accountScope?.status !== "available"
          || record.accountScope.scopeId !== sanitizedAccountScope.scopeId
          || typeof record.observedAt !== "string"
          || !Number.isFinite(Date.parse(record.observedAt))
          || record.observedAt < startAt
          || record.observedAt > endAt) return;
      const date = record.observedAt.slice(0, 10);
      const tokens = componentTotal(record.components);
      const row = daily.get(date) ?? { date, providerPlanType: plan, eventCount: 0, localTokens: 0 };
      row.eventCount += 1;
      row.localTokens += tokens;
      daily.set(date, row);
      eventCount += 1;
      totalTokens += tokens;
      if (firstObservedAt === null) firstObservedAt = record.observedAt;
      lastObservedAt = record.observedAt;
    },
    finalize({ officialByDate = new Map() } = {}) {
      const rows = [...daily.values()]
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((row) => {
          const officialTokens = Number.isFinite(officialByDate.get(row.date))
            ? officialByDate.get(row.date)
            : null;
          return {
            ...row,
            officialAccountTokens: officialTokens,
            partialLocalToOfficialRatio: officialTokens > 0
              ? round(row.localTokens / officialTokens)
              : null,
            coverage: "partial_prospective_marker_window_not_full_day",
          };
        });
      return {
        status: eventCount > 0 ? "available_partial" : "not_yet_observed",
        accountScope: sanitizedAccountScope,
        providerPlanType: plan,
        eventCount,
        totalTokens,
        firstObservedAt,
        lastObservedAt,
        daily: rows,
        interpretation: "These records are account-matched prospectively, but their marker window may cover only part of a provider UTC day and is never treated as full account coverage.",
      };
    },
  };
}

function summarizeProspectiveAccountScoped({
  records,
  accountScope,
  officialByDate,
  providerPlanType,
  startAt,
  endAt,
}) {
  const accumulator = createProspectiveAccountScopedAccumulator({
    accountScope,
    providerPlanType,
    startAt,
    endAt,
  });
  for (const record of records ?? []) accumulator.add(record);
  return accumulator.finalize({ officialByDate });
}

function summarizeEpochs(daily) {
  const groups = {};
  for (const row of daily) {
    const epoch = policyEpochAt(`${row.date}T12:00:00.000Z`);
    const group = groups[epoch.id] ??= {
      epochId: epoch.id,
      status: epoch.status,
      startDate: row.date,
      endDate: row.date,
      days: 0,
      localTokens: 0,
      comparableLocalTokens: 0,
      officialTokens: 0,
      officialDays: 0,
      localApiPricedUsd: 0,
      providerOnlyDays: 0,
      components: {},
      byModel: {},
      speedModeCounts: {},
    };
    group.startDate = row.date < group.startDate ? row.date : group.startDate;
    group.endDate = row.date > group.endDate ? row.date : group.endDate;
    group.days += 1;
    group.localTokens += row.localTokens;
    group.localApiPricedUsd += row.localApiPricedUsd;
    for (const [component, value] of Object.entries(row.localComponents ?? {})) {
      group.components[component] = (group.components[component] ?? 0) + value;
    }
    for (const [model, value] of Object.entries(row.localByModel ?? {})) {
      const target = group.byModel[model] ??= { events: 0, totalTokens: 0, costUsd: 0 };
      target.events += value.events ?? 0;
      target.totalTokens += value.totalTokens ?? 0;
      target.costUsd += value.costUsd ?? 0;
    }
    for (const [mode, value] of Object.entries(row.localSpeedModeCounts ?? {})) {
      group.speedModeCounts[mode] = (group.speedModeCounts[mode] ?? 0) + value;
    }
    if (row.officialTokens !== null) {
      group.comparableLocalTokens += row.localTokens;
      group.officialTokens += row.officialTokens;
      group.officialDays += 1;
    }
    if (row.classification === "provider_only_activity" || row.classification === "material_provider_activity_unallocated") group.providerOnlyDays += 1;
  }
  return Object.values(groups).map((group) => ({
    ...group,
    localApiPricedUsd: round(group.localApiPricedUsd),
    byModel: Object.fromEntries(Object.entries(group.byModel).map(([model, value]) => [model, {
      ...value,
      costUsd: round(value.costUsd),
    }])),
    localToOfficialRatio: group.officialTokens > 0 ? round(group.comparableLocalTokens / group.officialTokens) : null,
  }));
}

export function analyzeProviderCrosscheck({
  localScan,
  accountSnapshot,
  providerUiObservations = [],
  prospectiveCollectorRecords = [],
  prospectiveCollectorAccumulator = null,
  cacheValidation = { status: "unspecified" },
}) {
  if (!localScan || !Number.isFinite(Date.parse(localScan.startAt)) || !Number.isFinite(Date.parse(localScan.endAt))) {
    throw new Error("Provider crosscheck requires a bounded local scan");
  }
  const accountScope = sanitizeAccountScope(accountSnapshot?.accountScope);
  const providerPlanType = accountSnapshot?.canonical?.planType ?? accountScope.planType ?? "unknown";
  const localByDate = new Map((localScan.daily ?? []).map((row) => [row.date, row]));
  const officialByDate = new Map((accountSnapshot?.officialDailyTokens ?? []).map((row) => [row.date, row.tokens]));
  const dates = [...new Set([...localByDate.keys(), ...officialByDate.keys()])]
    .filter((date) => `${date}T23:59:59.999Z` >= localScan.startAt && `${date}T00:00:00.000Z` <= localScan.endAt)
    .sort();
  const daily = dates.map((date) => {
    const local = localByDate.get(date);
    const localTokens = local?.totalTokens ?? 0;
    const officialTokens = Number.isFinite(officialByDate.get(date)) ? officialByDate.get(date) : null;
    const plan = dailyPlanContext(providerPlanType);
    return {
      date,
      localTokens,
      officialTokens,
      localToOfficialRatio: officialTokens > 0 ? round(localTokens / officialTokens) : null,
      unallocatedProviderTokens: officialTokens === null ? null : Math.max(0, officialTokens - localTokens),
      localApiPricedUsd: round(local?.totalUsd ?? 0),
      localUsageEvents: local?.events ?? 0,
      localBySurface: local?.bySurface ?? {},
      localComponents: local?.components ?? {},
      localByModel: local?.byModel ?? {},
      localSpeedModeCounts: local?.speedModeCounts ?? {},
      classification: classifyDailyComparison(localTokens, officialTokens),
      plan,
      policyEpoch: policyEpochAt(`${date}T12:00:00.000Z`),
    };
  });
  const ui = providerUiObservations.map(sanitizeUiObservation).filter(Boolean);
  const matchingUi = ui.filter((observation) => observation.accountScope.scopeId && observation.accountScope.scopeId === accountScope.scopeId);
  const canonicalWindow = accountSnapshot?.canonical?.primary ?? null;
  const uiComparisons = matchingUi.map((observation) => {
    const uiUsedPercent = observation.weekly.remainingPercent === null ? null : 100 - observation.weekly.remainingPercent;
    const appResetAt = canonicalWindow?.resetsAt ? new Date(canonicalWindow.resetsAt * 1000).toISOString() : null;
    const captureSeparationSeconds = accountSnapshot?.capturedAt
      ? Math.abs(Date.parse(observation.capturedAt) - Date.parse(accountSnapshot.capturedAt)) / 1000
      : null;
    const comparable = Number.isFinite(captureSeparationSeconds) && captureSeparationSeconds <= 60 * 60;
    return {
      capturedAt: observation.capturedAt,
      uiUsedPercent,
      appServerUsedPercent: canonicalWindow?.usedPercent ?? null,
      comparisonStatus: comparable ? "comparable_within_one_hour" : "not_comparable_stale_or_missing_capture",
      captureSeparationSeconds,
      percentagePointDifference: comparable && Number.isFinite(uiUsedPercent) && Number.isFinite(canonicalWindow?.usedPercent)
        ? round(uiUsedPercent - canonicalWindow.usedPercent, 3)
        : null,
      uiResetsAt: observation.weekly.resetsAt,
      appServerResetsAt: appResetAt,
      resetDifferenceSeconds: comparable && observation.weekly.resetsAt && appResetAt
        ? Math.abs(Date.parse(observation.weekly.resetsAt) - Date.parse(appResetAt)) / 1000
        : null,
      workSharedPoolTextObserved: observation.workSharedPoolTextObserved,
    };
  });
  const officialComparableRows = daily.filter((row) => row.officialTokens !== null);
  const localTokens = officialComparableRows.reduce((sum, row) => sum + row.localTokens, 0);
  const officialTokens = officialComparableRows.reduce((sum, row) => sum + row.officialTokens, 0);
  const providerLifetimeTokens = accountSnapshot?.officialUsageSummary?.lifetimeTokens;
  const localToProviderLifetimeRatio = Number.isFinite(providerLifetimeTokens) && providerLifetimeTokens > 0
    ? localScan.totalTokens / providerLifetimeTokens
    : null;
  const accountCompatibility = localToProviderLifetimeRatio !== null && localToProviderLifetimeRatio > 1.05
    ? "incompatible_current_account_cannot_cover_all_local_tokens"
    : "not_disproven_by_lifetime_total";
  const prospectiveAccountScoped = typeof prospectiveCollectorAccumulator?.finalize === "function"
    ? prospectiveCollectorAccumulator.finalize({ officialByDate })
    : summarizeProspectiveAccountScoped({
      records: prospectiveCollectorRecords,
      accountScope,
      officialByDate,
      providerPlanType,
      startAt: localScan.startAt,
      endAt: localScan.endAt,
    });
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "provider_local_account_crosscheck",
    materializedAt: accountSnapshot?.capturedAt ?? localScan.endAt,
    scope: {
      startAt: localScan.startAt,
      endAt: localScan.endAt,
      accountScope,
      accountScopeAppliesTo: "provider_snapshot_only",
      providerPlanType,
      localRolloutAccountAttribution: "unavailable_historical_rollouts_do_not_carry_account_subject",
    },
    local: {
      usageEvents: localScan.eventCount,
      totalTokens: localScan.totalTokens,
      totalApiPricedUsd: round(localScan.runcost?.totalUsd),
      bySurface: localScan.bySurface ?? {},
      rolloutsBySurface: localScan.diagnostics?.rolloutsBySurface ?? {},
      rolloutsByThreadSource: localScan.diagnostics?.rolloutsByThreadSource ?? {},
      rolloutsByAgentScope: localScan.diagnostics?.rolloutsByAgentScope ?? {},
      forkReplayEventsSkipped: localScan.diagnostics?.forkReplayEventsSkipped ?? 0,
      cacheValidation: {
        status: ["fresh_scan", "current", "current_after_end_growth", "stale_override"].includes(cacheValidation?.status)
          ? cacheValidation.status
          : "unspecified",
      },
    },
    provider: {
      capturedAt: accountSnapshot?.capturedAt ?? null,
      officialDailyBucketCount: accountSnapshot?.officialDailyTokens?.length ?? 0,
      officialUsageSummary: accountSnapshot?.officialUsageSummary ?? null,
      canonicalWeeklyWindow: canonicalWindow,
      uiObservations: matchingUi,
    },
    comparisons: {
      daily,
      comparableDayCount: officialComparableRows.length,
      aggregateLocalToOfficialTokenRatio: officialTokens > 0 ? round(localTokens / officialTokens) : null,
      aggregateUnallocatedProviderTokens: Math.max(0, officialTokens - localTokens),
      aggregateLocalExcessTokens: Math.max(0, localTokens - officialTokens),
      accountPartitioning: {
        providerAccountScope: accountScope,
        localHistoricalScope: "unattributed_mixed_account_possible",
        comparisonEligibility: "coverage_diagnostic_only_not_account_matched",
        futureScopedCollectorSupport: true,
      },
      accountCompatibility: {
        verdict: accountCompatibility,
        localToProviderLifetimeRatio: round(localToProviderLifetimeRatio),
        interpretation: "A local total above the current account's provider lifetime total proves the local corpus cannot be treated as one current-account history under equal token semantics; account switching, legacy metric differences, or residual duplication remain candidate causes.",
      },
      uiVsAppServer: uiComparisons,
      byPolicyEpoch: summarizeEpochs(daily),
      officialBucketGapDates: daily.filter((row) => row.officialTokens === null).map((row) => row.date),
      prospectiveAccountScoped,
    },
    boundaryFlags: {
      localCollectionStart: localScan.startAt,
      localCollectionEnd: localScan.endAt,
      providerAccountCapturedAt: accountSnapshot?.capturedAt ?? null,
      policyEvents: policyEpochsInRange(localScan.startAt, localScan.endAt),
      officialBucketGapDates: daily.filter((row) => row.officialTokens === null).map((row) => row.date),
    },
    policyEventsInRange: policyEpochsInRange(localScan.startAt, localScan.endAt),
    limitations: [
      "Official daily token buckets are account-level and do not allocate ChatGPT Work, Codex cloud, desktop, automation, or subagent activity.",
      "Historical local rollouts do not carry a provider account subject, so account switching cannot be reconstructed retroactively.",
      "Provider UI turn totals and local request-like token events use different denominators and are not compared as equal units.",
      "The provider-reported plan_type names the plan; no separate plan variant is inferred.",
      ...(cacheValidation?.status === "stale_override"
        ? ["The local-history cache failed source-freshness validation and was included only because an explicit stale override was requested."]
        : []),
    ],
  };
}

export function renderProviderCrosscheckReport(report) {
  const lines = [
    "---",
    "title: Provider and Local Usage Crosscheck",
    `date: ${report.materializedAt.slice(0, 10)}`,
    "type: research",
    "status: complete",
    "---",
    "",
    "# Provider and Local Usage Crosscheck",
    "",
    `Local coverage: ${report.scope.startAt} through ${report.scope.endAt}.`,
    "",
    `The replay-safe scan retained ${report.local.usageEvents} request-like usage events and excluded ${report.local.forkReplayEventsSkipped} fork-replay events. Historical local events remain account-unattributed; the current provider snapshot uses a Keychain-HMAC pseudonymous scope.`,
    "",
    `Local-history source status: ${report.local.cacheValidation?.status ?? "unspecified"}.`,
    "",
    `Across ${report.comparisons.comparableDayCount} days with official buckets, the aggregate local/provider token ratio is ${report.comparisons.aggregateLocalToOfficialTokenRatio ?? "unavailable"}. This is a coverage diagnostic, not a quota conversion factor.`,
    "",
    `Account-compatibility diagnostic: ${report.comparisons.accountCompatibility.verdict}; local/provider-lifetime ratio ${report.comparisons.accountCompatibility.localToProviderLifetimeRatio ?? "unavailable"}.`,
    "",
    "## Surface coverage",
    "",
    ...Object.entries(report.local.rolloutsBySurface).map(([surface, count]) => `- ${surface}: ${count} rollout(s)`),
    "",
    "## Provider UI crosscheck",
    "",
    ...(report.comparisons.uiVsAppServer.length === 0
      ? ["No same-scope provider UI observation was available."]
      : report.comparisons.uiVsAppServer.map((row) => `- ${row.capturedAt}: UI/app-server used percentage difference ${row.percentagePointDifference ?? "unavailable"} pp; reset difference ${row.resetDifferenceSeconds ?? "unavailable"} seconds; shared Work/Codex text observed: ${row.workSharedPoolTextObserved}.`)),
    "",
    "## Interpretation boundary",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
  ];
  return lines.join("\n");
}
