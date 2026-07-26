const WEEKLY_WINDOW_MINS = 10_080;

function round(value, places = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function hourStart(value) {
  const date = new Date(value);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function displayHour(value, timeZone, timeZoneName) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName,
  }).format(new Date(value));
}

function rollingTimeLabels(start, end) {
  return {
    window_start_utc: start,
    window_end_utc: end,
    window_end_utc_label: displayHour(end, "UTC", "short"),
    window_end_eastern_label: displayHour(end, "America/New_York", "short"),
  };
}

function mainWeeklyReset(intervals) {
  const counts = new Map();
  for (const interval of intervals) {
    if (interval.windowDurationMins !== WEEKLY_WINDOW_MINS || !Number.isFinite(interval.resetsAt)) continue;
    const key = [
      interval.accountScopeId ?? "unattributed",
      interval.planVariant ?? "unknown",
      interval.provider,
      interval.planType,
      interval.limitId,
      interval.slot,
      interval.windowDurationMins,
      interval.resetsAt,
    ].join("|");
    const current = counts.get(key) ?? { count: 0, interval };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0] ?? null;
}

function sameReset(row, selected) {
  return (row.accountScopeId ?? "unattributed") === (selected.accountScopeId ?? "unattributed")
    && (row.planVariant ?? "unknown") === (selected.planVariant ?? "unknown")
    && row.provider === selected.provider
    && row.planType === selected.planType
    && row.limitId === selected.limitId
    && row.slot === selected.slot
    && row.windowDurationMins === selected.windowDurationMins
    && row.resetsAt === selected.resetsAt;
}

function isEligibleTransition(row) {
  return row.nextUsedPercent > row.priorUsedPercent
    && row.marginalUsageEventCount > 0
    && row.quality?.localCoverage?.elapsedTimeCoverageFraction === 1
    && (row.quality?.pricingWarnings?.length ?? 0) === 0
    && (row.quality?.attributionWarnings?.length ?? 0) === 0;
}

function buildCurve(transitions, diagnostic) {
  const ordered = [...transitions]
    .filter((row) => Number.isFinite(row.lastPriorCumulativeApiPricedUsd)
      && Number.isFinite(row.firstNextCumulativeApiPricedUsd)
      && Number.isFinite(row.priorUsedPercent)
      && Number.isFinite(row.nextUsedPercent)
      && isEligibleTransition(row))
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  if (ordered.length === 0) throw new Error("Selected reset has no usable percentage transitions");

  const baselineCost = ordered[0].lastPriorCumulativeApiPricedUsd;
  const baselineUsed = ordered[0].priorUsedPercent;
  const centralCapacity = diagnostic.descriptiveCapacityUsd;
  const lowerCapacity = diagnostic.central80PercentRangeUsd?.lower ?? null;
  const upperCapacity = diagnostic.central80PercentRangeUsd?.upper ?? null;
  const observed = [{
    api_cost_usd: 0,
    quota_consumed_pp: 0,
    observed_at: ordered[0].lastPriorObservedAt,
    series: "Observed quota",
  }];

  let monotonicUsed = baselineUsed;
  for (const row of ordered) {
    if (row.nextUsedPercent <= monotonicUsed) continue;
    const apiCost = row.firstNextCumulativeApiPricedUsd - baselineCost;
    const quotaConsumed = row.nextUsedPercent - baselineUsed;
    if (apiCost < 0 || quotaConsumed < 0) continue;
    observed.push({
      api_cost_usd: round(apiCost),
      quota_consumed_pp: round(quotaConsumed),
      observed_at: row.firstNextObservedAt,
      series: "Observed quota",
    });
    monotonicUsed = row.nextUsedPercent;
  }

  const fitted = observed.flatMap((point) => [
    point,
    {
      api_cost_usd: round(point.quota_consumed_pp * centralCapacity / 100),
      quota_consumed_pp: point.quota_consumed_pp,
      observed_at: point.observed_at,
      series: "Fitted gradient",
    },
  ]);
  const errors = observed.map((point) => {
    const expected = point.api_cost_usd * 100 / centralCapacity;
    const bandLow = Number.isFinite(upperCapacity) ? point.api_cost_usd * 100 / upperCapacity : null;
    const bandHigh = Number.isFinite(lowerCapacity) ? point.api_cost_usd * 100 / lowerCapacity : null;
    return {
      absolute: Math.abs(point.quota_consumed_pp - expected),
      inBand: Number.isFinite(bandLow) && Number.isFinite(bandHigh)
        ? point.quota_consumed_pp >= bandLow && point.quota_consumed_pp <= bandHigh
        : null,
    };
  });

  return {
    rows: fitted,
    observed,
    baselineCost,
    baselineUsed,
    meanAbsoluteErrorPp: round(errors.reduce((sum, item) => sum + item.absolute, 0) / errors.length),
    withinCentral80BandFraction: round(errors.filter((item) => item.inBand === true).length / errors.length),
    observedSpanPp: round(observed.at(-1).quota_consumed_pp - observed[0].quota_consumed_pp),
  };
}

export function buildRollingHours(intervals, capacityUsd, smoothingHours = 3) {
  const ordered = [...intervals]
    .filter((row) => Number.isFinite(row.marginalApiPricedUsd)
      && Number.isFinite(row.priorUsedPercent)
      && Number.isFinite(row.nextUsedPercent))
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  if (ordered.length === 0) return [];

  const buckets = new Map();
  let monotonicUsed = ordered[0].priorUsedPercent;
  for (const row of ordered) {
    const key = hourStart(row.eventTime);
    const canonicalPrior = monotonicUsed;
    monotonicUsed = Math.max(monotonicUsed, row.nextUsedPercent);
    const bucket = buckets.get(key) ?? {
      timestamp: key,
      apiCostUsd: 0,
      eventCount: 0,
      startUsedPercent: canonicalPrior,
      endUsedPercent: monotonicUsed,
    };
    bucket.apiCostUsd += row.marginalApiPricedUsd;
    bucket.eventCount += row.marginalUsageEventCount ?? 0;
    bucket.endUsedPercent = monotonicUsed;
    buckets.set(key, bucket);
  }

  const firstHour = Date.parse(hourStart(ordered[0].eventTime));
  const lastHour = Date.parse(hourStart(ordered.at(-1).eventTime));
  const hours = [];
  let carry = ordered[0].priorUsedPercent;
  for (let timestamp = firstHour; timestamp <= lastHour; timestamp += 3_600_000) {
    const key = new Date(timestamp).toISOString();
    const observed = buckets.get(key);
    const row = observed ?? {
      timestamp: key,
      apiCostUsd: 0,
      eventCount: 0,
      startUsedPercent: carry,
      endUsedPercent: carry,
    };
    carry = row.endUsedPercent;
    hours.push(row);
  }

  return hours.slice(smoothingHours - 1).flatMap((hour, index) => {
    const window = hours.slice(index, index + smoothingHours);
    const cost = window.reduce((sum, item) => sum + item.apiCostUsd, 0);
    const observedChange = hour.endUsedPercent - window[0].startUsedPercent;
    const expectedChange = cost * 100 / capacityUsd;
    const windowEnd = new Date(Date.parse(hour.timestamp) + 3_600_000).toISOString();
    const shared = {
      timestamp: windowEnd,
      ...rollingTimeLabels(window[0].timestamp, windowEnd),
      rolling_api_cost_usd: round(cost),
      rolling_event_count: window.reduce((sum, item) => sum + item.eventCount, 0),
      smoothing_hours: smoothingHours,
    };
    return [
      { ...shared, series: "Observed quota change", quota_change_pp: round(observedChange) },
      { ...shared, series: "Expected from API cost", quota_change_pp: round(expectedChange) },
    ];
  });
}

function buildRollingResidual(rolling) {
  const paired = new Map();
  for (const row of rolling) {
    const item = paired.get(row.timestamp) ?? { timestamp: row.timestamp };
    if (row.series === "Observed quota change") item.observed = row.quota_change_pp;
    if (row.series === "Expected from API cost") item.expected = row.quota_change_pp;
    paired.set(row.timestamp, item);
  }
  const rows = [...paired.values()]
    .filter((row) => Number.isFinite(row.observed) && Number.isFinite(row.expected))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .map((row) => ({
      timestamp: row.timestamp,
      series: "Observed minus expected",
      observed_quota_change_pp: round(row.observed),
      expected_quota_change_pp: round(row.expected),
      residual_pp: round(row.observed - row.expected),
    }));

  let signedAuc = 0;
  let absoluteAuc = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const prior = rows[index - 1];
    const current = rows[index];
    const elapsedHours = (Date.parse(current.timestamp) - Date.parse(prior.timestamp)) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) continue;
    signedAuc += elapsedHours * (prior.residual_pp + current.residual_pp) / 2;
    absoluteAuc += elapsedHours * (Math.abs(prior.residual_pp) + Math.abs(current.residual_pp)) / 2;
  }

  return {
    rows,
    signedAucPpHours: round(signedAuc),
    absoluteAucPpHours: round(absoluteAuc),
    meanResidualPp: rows.length > 0
      ? round(rows.reduce((sum, row) => sum + row.residual_pp, 0) / rows.length)
      : null,
    peakAbsoluteResidualPp: rows.length > 0
      ? round(Math.max(...rows.map((row) => Math.abs(row.residual_pp))))
      : null,
  };
}

function intervalSpeedMode(row) {
  const counts = row.tierUsageEventCounts ?? {};
  if ((counts.fast ?? 0) > 0 && (counts.standard ?? 0) === 0 && (counts.unknown ?? 0) === 0) return "fast";
  if ((counts.standard ?? 0) > 0 && (counts.fast ?? 0) === 0 && (counts.unknown ?? 0) === 0) return "standard";
  return "unknown";
}

function tierWeightedCost(row, fastMultiplier) {
  const counts = row.tierUsageEventCounts ?? {};
  const fast = counts.fast ?? 0;
  const standard = counts.standard ?? 0;
  const unknown = counts.unknown ?? 0;
  const total = fast + standard + unknown;
  if (total <= 0) return row.marginalApiPricedUsd;
  return row.marginalApiPricedUsd * ((fast * fastMultiplier) + standard + unknown) / total;
}

function summarizeIntervalSegment(rows, { fastMultiplier }) {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const costs = { fast: 0, standard: 0, unknown: 0 };
  const events = { fast: 0, standard: 0, unknown: 0 };
  let weightedCost = 0;
  let endUsed = ordered[0].priorUsedPercent;
  for (const row of ordered) {
    const mode = intervalSpeedMode(row);
    costs[mode] += row.marginalApiPricedUsd;
    events[mode] += row.marginalUsageEventCount ?? 0;
    weightedCost += tierWeightedCost(row, fastMultiplier);
    endUsed = Math.max(endUsed, row.nextUsedPercent);
  }
  const startUsed = ordered[0].priorUsedPercent;
  const quotaChange = endUsed - startUsed;
  const rawCost = costs.fast + costs.standard + costs.unknown;
  return {
    firstObservedAt: ordered[0].eventTime,
    lastObservedAt: ordered.at(-1).eventTime,
    intervalCount: ordered.length,
    eventCounts: events,
    costs,
    rawCostUsd: round(rawCost),
    tierWeightedCostUsd: round(weightedCost),
    startUsedPercent: startUsed,
    endUsedPercent: endUsed,
    quotaChangePp: quotaChange,
    rawImpliedCapacityUsd: quotaChange > 0 ? round(rawCost * 100 / quotaChange) : null,
    tierWeightedImpliedCapacityUsd: quotaChange > 0 ? round(weightedCost * 100 / quotaChange) : null,
  };
}

export function analyzeFastDiagnostic(diagnostic, {
  fastMultiplier = 2.5,
  fastStart = "2026-07-13T14:00:00.000Z",
  fastEnd = "2026-07-13T18:00:00.000Z",
  referenceStart = "2026-07-13T22:00:00.000Z",
  referenceEnd = "2026-07-14T00:00:00.000Z",
} = {}) {
  const selection = mainWeeklyReset(diagnostic.snapshotIntervals ?? []);
  if (!selection) throw new Error("Fast diagnostic has no weekly snapshot intervals");
  const selected = selection.interval;
  const intervals = diagnostic.snapshotIntervals
    .filter((row) => sameReset(row, selected))
    .sort((left, right) => left.eventTime.localeCompare(right.eventTime));
  const fastRows = intervals.filter((row) => row.eventTime >= fastStart && row.eventTime < fastEnd);
  const referenceRows = intervals.filter((row) => row.eventTime >= referenceStart && row.eventTime < referenceEnd);
  const fast = summarizeIntervalSegment(fastRows, { fastMultiplier });
  const reference = summarizeIntervalSegment(referenceRows, { fastMultiplier });
  if (!fast || !reference || !Number.isFinite(reference.rawImpliedCapacityUsd)) {
    throw new Error("Fast diagnostic cannot form the requested Fast and reference segments");
  }

  const buckets = new Map();
  let monotonicUsed = intervals[0].priorUsedPercent;
  for (const row of intervals) {
    const key = hourStart(row.eventTime);
    const canonicalPrior = monotonicUsed;
    monotonicUsed = Math.max(monotonicUsed, row.nextUsedPercent);
    const bucket = buckets.get(key) ?? {
      timestamp: key,
      rawCostUsd: 0,
      weightedCostUsd: 0,
      eventCount: 0,
      fastEventCount: 0,
      standardEventCount: 0,
      unknownEventCount: 0,
      startUsedPercent: canonicalPrior,
      endUsedPercent: monotonicUsed,
    };
    bucket.rawCostUsd += row.marginalApiPricedUsd;
    bucket.weightedCostUsd += tierWeightedCost(row, fastMultiplier);
    bucket.eventCount += row.marginalUsageEventCount ?? 0;
    bucket.fastEventCount += row.tierUsageEventCounts?.fast ?? 0;
    bucket.standardEventCount += row.tierUsageEventCounts?.standard ?? 0;
    bucket.unknownEventCount += row.tierUsageEventCounts?.unknown ?? 0;
    bucket.endUsedPercent = monotonicUsed;
    buckets.set(key, bucket);
  }
  const firstHour = Date.parse(hourStart(intervals[0].eventTime));
  const lastHour = Date.parse(hourStart(intervals.at(-1).eventTime));
  const contiguousBuckets = [];
  let carryUsed = intervals[0].priorUsedPercent;
  for (let timestamp = firstHour; timestamp <= lastHour; timestamp += 3_600_000) {
    const key = new Date(timestamp).toISOString();
    const observed = buckets.get(key);
    const bucket = observed ?? {
      timestamp: key,
      rawCostUsd: 0,
      weightedCostUsd: 0,
      eventCount: 0,
      fastEventCount: 0,
      standardEventCount: 0,
      unknownEventCount: 0,
      startUsedPercent: carryUsed,
      endUsedPercent: carryUsed,
    };
    bucket.startUsedPercent = carryUsed;
    carryUsed = bucket.endUsedPercent;
    contiguousBuckets.push(bucket);
  }

  const hourly = contiguousBuckets.flatMap((bucket) => {
    const windowEnd = new Date(Date.parse(bucket.timestamp) + 3_600_000).toISOString();
    const shared = {
      timestamp: windowEnd,
      hour_start_utc: bucket.timestamp,
      hour_end_utc: windowEnd,
      hour_end_utc_label: displayHour(windowEnd, "UTC", "short"),
      hour_end_eastern_label: displayHour(windowEnd, "America/New_York", "short"),
      api_cost_usd: round(bucket.rawCostUsd),
      tier_weighted_cost_usd: round(bucket.weightedCostUsd),
      usage_events: bucket.eventCount,
      fast_events: bucket.fastEventCount,
      standard_events: bucket.standardEventCount,
      unknown_events: bucket.unknownEventCount,
    };
    return [
      { ...shared, series: "Observed quota change", quota_change_pp: round(bucket.endUsedPercent - bucket.startUsedPercent) },
      { ...shared, series: "Expected if all Standard", quota_change_pp: round(bucket.rawCostUsd * 100 / reference.rawImpliedCapacityUsd) },
      { ...shared, series: `Expected with captured Fast ${fastMultiplier}x`, quota_change_pp: round(bucket.weightedCostUsd * 100 / reference.rawImpliedCapacityUsd) },
    ];
  });

  const windowRowsByHours = {};
  const windowDiagnostics = [];
  for (const windowHours of [1, 2, 3]) {
    const windowRows = contiguousBuckets.slice(windowHours - 1).map((bucket, index) => {
      const window = contiguousBuckets.slice(index, index + windowHours);
      const windowEnd = new Date(Date.parse(bucket.timestamp) + 3_600_000).toISOString();
      const rawCost = window.reduce((sum, row) => sum + row.rawCostUsd, 0);
      const weightedCost = window.reduce((sum, row) => sum + row.weightedCostUsd, 0);
      const observedChange = bucket.endUsedPercent - window[0].startUsedPercent;
      const rawExpected = rawCost * 100 / reference.rawImpliedCapacityUsd;
      const weightedExpected = weightedCost * 100 / reference.rawImpliedCapacityUsd;
      return {
        window_end_utc: windowEnd,
        window_end_utc_label: displayHour(windowEnd, "UTC", "short"),
        window_end_eastern_label: displayHour(windowEnd, "America/New_York", "short"),
        window_hours: windowHours,
        observed_quota_change_pp: round(observedChange),
        raw_expected_quota_change_pp: round(rawExpected),
        weighted_expected_quota_change_pp: round(weightedExpected),
        raw_residual_pp: round(observedChange - rawExpected),
        weighted_residual_pp: round(observedChange - weightedExpected),
        api_cost_usd: round(rawCost),
        tier_weighted_cost_usd: round(weightedCost),
        usage_events: window.reduce((sum, row) => sum + row.eventCount, 0),
        fast_events: window.reduce((sum, row) => sum + row.fastEventCount, 0),
      };
    });
    windowRowsByHours[windowHours] = windowRows;
    const focal = windowRows.filter((row) => row.window_end_utc > fastStart && row.window_end_utc <= fastEnd);
    const meanAbsolute = (field) => focal.length > 0
      ? focal.reduce((sum, row) => sum + Math.abs(row[field]), 0) / focal.length
      : null;
    const rawMae = meanAbsolute("raw_residual_pp");
    const weightedMae = meanAbsolute("weighted_residual_pp");
    windowDiagnostics.push({
      window_hours: windowHours,
      focal_window: "July 13 captured Fast period",
      focal_points: focal.length,
      raw_mae_pp: round(rawMae),
      weighted_mae_pp: round(weightedMae),
      weighted_mae_reduction_fraction: Number.isFinite(rawMae) && rawMae > 0
        ? round(1 - weightedMae / rawMae)
        : null,
      raw_peak_absolute_residual_pp: focal.length > 0
        ? round(Math.max(...focal.map((row) => Math.abs(row.raw_residual_pp))))
        : null,
      weighted_peak_absolute_residual_pp: focal.length > 0
        ? round(Math.max(...focal.map((row) => Math.abs(row.weighted_residual_pp))))
        : null,
    });
  }

  const segmentTable = [
    {
      segment: "Captured Fast run",
      first_observed_at: fast.firstObservedAt,
      last_observed_at: fast.lastObservedAt,
      speed_evidence: `${fast.eventCounts.fast} Fast events`,
      quota_change_pp: fast.quotaChangePp,
      standard_api_cost_usd: fast.rawCostUsd,
      weighted_api_equivalent_usd: fast.tierWeightedCostUsd,
      raw_implied_capacity_usd: fast.rawImpliedCapacityUsd,
      weighted_implied_capacity_usd: fast.tierWeightedImpliedCapacityUsd,
    },
    {
      segment: "Later Standard/unknown reference",
      first_observed_at: reference.firstObservedAt,
      last_observed_at: reference.lastObservedAt,
      speed_evidence: `${reference.eventCounts.standard} Standard + ${reference.eventCounts.unknown} unknown events`,
      quota_change_pp: reference.quotaChangePp,
      standard_api_cost_usd: reference.rawCostUsd,
      weighted_api_equivalent_usd: reference.tierWeightedCostUsd,
      raw_implied_capacity_usd: reference.rawImpliedCapacityUsd,
      weighted_implied_capacity_usd: reference.tierWeightedImpliedCapacityUsd,
    },
  ];

  return {
    fastMultiplier,
    referenceCapacityUsd: reference.rawImpliedCapacityUsd,
    fast,
    reference,
    hourly,
    windowRowsByHours,
    windowDiagnostics,
    segmentTable,
  };
}

export function summarizeSlotSemantics(historyTransitions) {
  const groups = new Map();
  for (const row of historyTransitions.transitions ?? []) {
    const key = `${row.slot}|${row.windowDurationMins}`;
    const current = groups.get(key) ?? {
      slot: row.slot,
      window_minutes: row.windowDurationMins,
      window_label: row.windowDurationMins === 300
        ? "5 hours"
        : row.windowDurationMins === WEEKLY_WINDOW_MINS ? "7 days" : `${row.windowDurationMins} minutes`,
      transitions: 0,
      first_observed_at: row.eventTime,
      last_observed_at: row.eventTime,
    };
    current.transitions += 1;
    current.first_observed_at = current.first_observed_at < row.eventTime ? current.first_observed_at : row.eventTime;
    current.last_observed_at = current.last_observed_at > row.eventTime ? current.last_observed_at : row.eventTime;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => left.first_observed_at.localeCompare(right.first_observed_at));
}

function buildResetTrend(diagnostics) {
  const usable = diagnostics
    .filter((row) => row.usableDiagnostic === true
      && Number.isFinite(row.descriptiveCapacityUsd)
      && Number.isFinite(row.central80PercentRangeUsd?.lower)
      && Number.isFinite(row.central80PercentRangeUsd?.upper))
    .sort((left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt));
  const rows = usable.flatMap((row) => {
    const shared = {
      first_observed_at: row.firstObservedAt,
      reset_at: row.resetIdentity,
      reset_key: `${row.slot}|${row.resetsAt}`,
      eligible_transitions: row.eligibleTransitions,
      observed_span_pp: row.percentSpan,
    };
    return [
      { ...shared, series: "Median pairwise gradient", capacity_usd: row.descriptiveCapacityUsd },
      { ...shared, series: "Pairwise p10", capacity_usd: row.central80PercentRangeUsd.lower },
      { ...shared, series: "Pairwise p90", capacity_usd: row.central80PercentRangeUsd.upper },
    ];
  });
  const table = usable.map((row) => ({
    first_observed_at: row.firstObservedAt,
    reset_at: row.resetIdentity,
    slot: row.slot,
    capacity_usd: row.descriptiveCapacityUsd,
    lower_80_usd: row.central80PercentRangeUsd.lower,
    upper_80_usd: row.central80PercentRangeUsd.upper,
    eligible_transitions: row.eligibleTransitions,
    observed_span_pp: row.percentSpan,
  }));
  return { rows, table, usable };
}

export function analyzeSimpleQuotaGradient(recent, history, { smoothingHours = 3 } = {}) {
  const selection = mainWeeklyReset(recent.snapshotIntervals ?? []);
  if (!selection) throw new Error("No weekly quota snapshot intervals were found");
  const selected = selection.interval;
  const intervals = recent.snapshotIntervals.filter((row) => sameReset(row, selected));
  const transitions = recent.transitions.filter((row) => sameReset(row, selected));
  const diagnostic = history.resetDiagnostics.find((row) => sameReset(row, selected));
  if (!diagnostic?.usableDiagnostic || !Number.isFinite(diagnostic.descriptiveCapacityUsd)) {
    throw new Error(`No usable reset diagnostic matches ${selected.resetsAt}`);
  }

  const curve = buildCurve(transitions, diagnostic);
  const rolling = buildRollingHours(intervals, diagnostic.descriptiveCapacityUsd, smoothingHours);
  const residual = buildRollingResidual(rolling);
  const trend = buildResetTrend(history.resetDiagnostics);
  const recentThree = trend.usable.slice(-3).map((row) => row.descriptiveCapacityUsd);
  const earlyThree = trend.usable.slice(0, 3).map((row) => row.descriptiveCapacityUsd);
  const recentMedian = median(recentThree);
  const earlyMedian = median(earlyThree);

  return {
    selectedReset: {
      provider: selected.provider,
      planType: selected.planType,
      slot: selected.slot,
      resetsAt: selected.resetsAt,
      resetIdentity: new Date(selected.resetsAt * 1000).toISOString(),
      snapshotIntervals: intervals.length,
      transitions: transitions.length,
      smoothingHours,
    },
    gradient: {
      capacityUsd: diagnostic.descriptiveCapacityUsd,
      central80LowerUsd: diagnostic.central80PercentRangeUsd.lower,
      central80UpperUsd: diagnostic.central80PercentRangeUsd.upper,
      eligibleTransitions: diagnostic.eligibleTransitions,
      observedSpanPp: curve.observedSpanPp,
      meanAbsoluteErrorPp: curve.meanAbsoluteErrorPp,
      withinCentral80BandFraction: curve.withinCentral80BandFraction,
      rollingSignedAucPpHours: residual.signedAucPpHours,
      rollingAbsoluteAucPpHours: residual.absoluteAucPpHours,
      rollingMeanResidualPp: residual.meanResidualPp,
      rollingPeakAbsoluteResidualPp: residual.peakAbsoluteResidualPp,
    },
    history: {
      usableResetCount: trend.usable.length,
      firstObservedAt: trend.usable[0]?.firstObservedAt ?? null,
      lastObservedAt: trend.usable.at(-1)?.firstObservedAt ?? null,
      recentThreeMedianUsd: round(recentMedian),
      earlyThreeMedianUsd: round(earlyMedian),
      earlyToRecentChange: Number.isFinite(recentMedian) && earlyMedian > 0
        ? round(recentMedian / earlyMedian - 1)
        : null,
    },
    datasets: {
      curve: curve.rows,
      rolling,
      rollingResidual: residual.rows,
      resetTrend: trend.rows,
      resetTable: trend.table,
    },
  };
}
