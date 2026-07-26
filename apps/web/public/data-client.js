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
 *   GET  /api/v1/contributions/:id
 *   GET  /api/v1/me/stats
 *   GET  /api/v1/stats/aggregate
 *
 * The normalizers below accept complete, partial, stale, and insufficient
 * responses, but never silently turn a failure into real-looking data.
 */

const LOCAL_ROOT = "/api/local";
const CENTRAL_ROOT = "/api/v1";

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
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", ...(options.headers ?? {}) },
    ...options
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
}

export class CommunityClient {
  constructor({ fetchImpl = globalThis.fetch, getAccessToken = () => null } = {}) {
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
  }

  headers() {
    const token = this.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  enroll() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentVersion: "privacy-safe-telemetry-v0.1", syntheticOnly: false })
    });
  }

  envelopeKey() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/envelope-key`);
  }

  contribute(envelope) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers() },
      body: JSON.stringify(envelope)
    });
  }

  contribution(contributionId) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/contributions/${encodeURIComponent(contributionId)}`, {
      headers: this.headers()
    });
  }

  async personalStats() {
    try {
      return await fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/stats`, { headers: this.headers() });
    } catch (error) {
      if (error.status !== 404) throw error;
      return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/insights`, { headers: this.headers() });
    }
  }

  async communityStats() {
    try {
      return await fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/stats/aggregate`);
    } catch (error) {
      if (error.status !== 404) throw error;
      return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/community/insights`);
    }
  }

  participantExport() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/export`, {
      headers: this.headers()
    });
  }

  deleteParticipant() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me`, {
      method: "DELETE",
      headers: this.headers()
    });
  }
}

export function demoDashboard() {
  const now = "2026-07-25T14:00:00.000Z";
  const rolling = [];
  for (let index = 0; index < 36; index += 1) {
    const timestamp = new Date(Date.parse(now) - (35 - index) * 3_600_000).toISOString();
    const observed = Math.max(0, 4.8 + Math.sin(index / 3) * 2.5 + (index > 20 && index < 25 ? 3.2 : 0));
    rolling.push({ timestamp, series: "Observed quota change", quota_change_pp: Number(observed.toFixed(2)), smoothing_hours: 3 });
    rolling.push({ timestamp, series: "Expected from API cost", quota_change_pp: Number((observed * .82 + Math.cos(index / 4) * .8).toFixed(2)), smoothing_hours: 3 });
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
