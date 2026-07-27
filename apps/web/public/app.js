import {
  CommunityClient,
  LocalCompanionClient,
  demoDashboard,
  normalizeCommunitySnapshot,
  normalizeParticipantHistory,
  normalizeParticipantStats
} from "./data-client.js";
import {
  createTelemetryEnvelope,
  safeApiError,
  validateContributionForUpload
} from "./lib.js";

const localClient = new LocalCompanionClient();
let communitySession = null;
const communityClient = new CommunityClient({
  getCsrfToken: () => communitySession?.csrfToken ?? null,
  getParticipantId: () => communitySession?.participantId ?? null
});

let dashboard = null;
let activeWindowHours = 1;
let activeTimelineRangeDays = 7;
let activeUsageGrouping = "hour";
let activeAccountingPeriod = "7d";
let timelineViewport = null;
let timelinePointerStart = null;
let contributionSyncStatus = null;
let contributionSyncPreview = null;
let contributionSyncExactReview = null;
let contributionSyncBusy = false;
let selectedContributionValidated = false;
let contributionSelectionRevision = 0;
let contributionPreparationBusy = false;

const $ = (selector) => document.querySelector(selector);

function setCommunitySession(value) {
  communitySession = value;
  const deviceConsentTitle = $("#device-consent-title");
  if (deviceConsentTitle) {
    deviceConsentTitle.textContent = value?.consentVersion
      === "privacy-safe-telemetry-v0.2"
      ? "Allow this pairing to register privacy-safe account-scoped v0.2 uploads."
      : "Allow this pairing to register privacy-safe v0.1 uploads.";
  }
}

function showRecoveryCodeOnce(value) {
  const panel = $("#recovery-once");
  const code = $("#recovery-code-once");
  if (typeof value !== "string" || value.length === 0) {
    code.textContent = "";
    panel.hidden = true;
    return;
  }
  code.textContent = value;
  panel.hidden = false;
}

function showDevicePairingOnce(value) {
  const panel = $("#device-pairing-once");
  const code = $("#device-pairing-code");
  if (typeof value !== "string" || !value.startsWith("um_pair_") || value.length > 180) {
    code.textContent = "";
    panel.hidden = true;
    return;
  }
  code.textContent = value;
  panel.hidden = false;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatMoney(value, digits = 0) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      }).format(number);
}

function formatApiMoney(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6
      }).format(number);
}

function formatPercent(value, digits = 0) {
  const number = finite(value);
  return number === null ? "—" : `${number.toFixed(digits)}%`;
}

function formatPp(value, digits = 1) {
  const number = finite(value);
  return number === null ? "—" : `${number.toFixed(digits)} pp`;
}

function compact(value) {
  const number = finite(value);
  return number === null
    ? "—"
    : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function formatUtc(value, { dateOnly = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat("en-US", dateOnly
    ? { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }
    : { timeZone: "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
  ).format(new Date(value));
}

function formatLocal(value, { dateOnly = false } = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Intl.DateTimeFormat("en-US", dateOnly
    ? { month: "short", day: "numeric", year: "numeric" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
  ).format(new Date(value));
}

function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) return "Unknown age";
  if (seconds < 90) return "Less than 2 minutes ago";
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours ago`;
  return `${(seconds / 86400).toFixed(1)} days ago`;
}

function formatTimeRemaining(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time remaining unavailable";
  const remainingMs = timestamp - Date.now();
  if (remainingMs <= 0) return "Reset due or recently passed";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function clear(element) {
  element.replaceChildren();
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function setGlobalState(state) {
  const labels = {
    live: "Live local evidence",
    stale: "Stale local evidence",
    insufficient: "Insufficient evidence",
    offline: "Companion offline",
    demo: "Labeled demo data"
  };
  const pill = $("#global-state");
  pill.className = `state-pill state-${state}`;
  pill.replaceChildren(node("span", "state-dot"), document.createTextNode(labels[state] ?? "Unknown state"));
}

function showConnectionNotice({ title, copy, kind = "warning", showDemo = false }) {
  const notice = $("#connection-notice");
  notice.className = `notice notice-${kind}`;
  $("#connection-title").textContent = title;
  $("#connection-copy").textContent = copy;
  $("#demo-button").hidden = !showDemo;
  notice.hidden = false;
}

function hideConnectionNotice() {
  $("#connection-notice").hidden = true;
}

function renderDashboard(data) {
  dashboard = data;
  setGlobalState(data.state);
  $("#latest-observation").textContent = data.freshness.latestObservedAt
    ? formatAge(data.freshness.ageSeconds ?? (Date.now() - Date.parse(data.freshness.latestObservedAt)) / 1000)
    : "No timestamp";
  $("#data-source").textContent = data.mode === "demo"
    ? "Illustrative fixture — not your usage"
    : `${formatUtc(data.freshness.latestObservedAt)} · local companion`;
  $("#schema-version").textContent = `Dashboard contract: ${data.schemaVersion}`;

  if (data.mode === "demo") {
    showConnectionNotice({
      title: "You are exploring a labeled demonstration",
      copy: "Every number on this page is illustrative. Start the local companion and refresh to load your own evidence.",
      kind: "demo"
    });
  } else if (data.state === "stale") {
    showConnectionNotice({
      title: "The local evidence is stale",
      copy: "The dashboard is showing real local artifacts, but the latest collector observation is older than its freshness threshold.",
      kind: "warning"
    });
  } else if (data.state === "insufficient") {
    showConnectionNotice({
      title: "The companion is connected, but evidence is incomplete",
      copy: "Available measurements are shown below. Missing estimates remain blank rather than being filled with demo values.",
      kind: "warning"
    });
  } else {
    hideConnectionNotice();
  }

  renderQuotaCards(data);
  renderPricing(data);
  renderComparison(data);
  renderTimeline(data);
  renderWeekly(data);
  renderAccounting(data);
  renderQuality(data);
  renderCollector(data);
  renderReports(data);
}

function renderQuotaCards(data) {
  const container = $("#quota-cards");
  clear(container);
  const windows = data.quotaWindows;
  if (!windows.length) {
    const card = node("article", "metric-card insufficient");
    card.innerHTML = `
      <div class="metric-card-header"><span class="metric-name">Quota observations</span><span class="evidence-chip">Insufficient</span></div>
      <strong class="metric-value">—</strong>
      <p>The local companion has not exposed a current allowance window.</p>
    `;
    container.append(card);
    return;
  }
  for (const window of windows) {
    const remaining = finite(window.remainingPercent);
    const card = node("article", `metric-card ${window.status === "stale" ? "stale" : ""}`);
    const header = node("div", "metric-card-header");
    header.append(
      node("span", "metric-name", window.label),
      node("span", "evidence-chip", window.planType || (data.mode === "demo" ? "Demo" : "Observed"))
    );
    const value = node("strong", "metric-value");
    value.textContent = remaining === null ? "—" : `${remaining.toFixed(window.precision ?? 0)}%`;
    value.append(node("small", "", " remaining"));
    const progress = node("div", "mini-progress");
    const fill = node("i");
    fill.style.width = `${Math.max(0, Math.min(100, remaining ?? 0))}%`;
    progress.append(fill);
    const meta = node("div", "metric-meta");
    meta.append(
      node("span", "", window.usedPercent === null ? "Used unknown" : `${formatPercent(window.usedPercent)} used`),
      node("span", "", window.resetAt ? `Resets ${formatUtc(window.resetAt)}` : "Reset unknown")
    );
    card.append(header, value, progress, meta);
    if (window.resetAt) card.append(node("p", "", formatTimeRemaining(window.resetAt)));
    if (window.observedAt) {
      const attribution = window.accountAttribution === "attributed_pseudonymous"
        ? "pseudonymous account attributed"
        : "account unattributed";
      card.append(node("p", "", `Observed ${formatUtc(window.observedAt)} · ${attribution}`));
    }
    container.append(card);
  }
}

function renderPricing(data) {
  const pricing = data.pricing;
  $("#cost-period").textContent = pricing.periodLabel;
  $("#cost-total").textContent = formatMoney(pricing.totalCostUsd, 2);
  const provenance = pricing.registryVersion
    ? ` · API price registry ${pricing.registryVersion}${pricing.registryObservedAt ? ` (${formatUtc(pricing.registryObservedAt)})` : ""}`
    : "";
  $("#cost-coverage").textContent = pricing.coveragePercent === null
    ? "Price coverage is not available"
    : `${formatPercent(pricing.coveragePercent, 1)} of recorded usage priced · API tier: ${pricing.apiTier}${provenance}`;
  const list = $("#cost-components");
  clear(list);
  if (!pricing.components.length) {
    list.append(node("p", "empty-inline", "No token-component accounting was returned."));
    return;
  }
  const max = Math.max(...pricing.components.map((row) => row.costUsd ?? row.tokens ?? 0), 1);
  for (const component of pricing.components) {
    const row = node("div", "component-row");
    row.append(node("span", "", humanize(component.name)));
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(1, ((component.costUsd ?? component.tokens ?? 0) / max) * 100)}%`;
    track.append(fill);
    row.append(track, node("strong", "", component.costUsd === null ? `${compact(component.tokens)} tok` : formatMoney(component.costUsd, 2)));
    list.append(row);
  }
}

function humanize(value) {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function latestRollingPair(data) {
  if (data.mode !== "demo" && data.timeline?.usage?.length) {
    const live = liveTimelinePoints(data)
      .filter((row) => row.observed !== null && row.expected !== null)
      .at(-1);
    if (live) return live;
  }
  if (data.gradient.rollingDetail.length) {
    const row = data.gradient.rollingDetail.at(-1);
    return {
      observed: finite(row.observed_quota_change_pp ?? row.observedQuotaChangePp),
      expected: finite(row.expected_quota_change_pp ?? row.expectedQuotaChangePp),
      residual: finite(row.residual_pp ?? row.residualPp)
    };
  }
  const groups = groupRolling(data.gradient.rolling, activeWindowHours);
  const last = groups.at(-1);
  return last ? { observed: last.observed, expected: last.expected, residual: last.observed - last.expected } : null;
}

function renderComparison(data) {
  const pair = latestRollingPair(data);
  const summary = data.gradient.summary ?? {};
  const mae = finite(summary.mean_absolute_error_pp ?? summary.meanAbsoluteErrorPp);
  const within = finite(summary.points_within_80_band_fraction ?? summary.pointsWithin80BandFraction);
  const capacity = finite(summary.capacity_usd ?? summary.capacityUsd);
  const lower = finite(summary.lower_80_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_usd ?? summary.upper80Usd);
  const chip = $("#fit-chip");
  renderCalibrationRate({ capacity, lower, upper });
  if (!pair || pair.observed === null || pair.expected === null) {
    chip.textContent = "Insufficient";
    $("#comparison-result").textContent = "There is not yet a matched quota-and-cost window to compare.";
    return;
  }
  const max = Math.max(Math.abs(pair.observed), Math.abs(pair.expected), 1);
  const rows = $("#comparison-visual").querySelectorAll(".comparison-row");
  const values = [pair.observed, pair.expected];
  rows.forEach((row, index) => {
    row.querySelector("i").style.width = `${Math.min(100, Math.abs(values[index]) / max * 100)}%`;
    row.querySelector("strong").textContent = formatPp(values[index]);
  });
  const residual = pair.residual ?? pair.observed - pair.expected;
  chip.textContent = mae === null ? "Matched window" : `MAE ${mae.toFixed(1)} pp`;
  $("#comparison-result").textContent = `${formatPp(Math.abs(residual))} separates the observed and cost-implied movement in the latest matched window.${within === null ? "" : ` Across the series, ${formatPercent(within * 100)} of points fall inside the modeled 80% band.`}`;
}

function renderCalibrationRate({ capacity, lower, upper }) {
  const rate = $("#calibration-rate");
  const range = $("#calibration-range");
  const example = $("#calibration-example");
  const explanation = $("#calibration-explanation");
  if (capacity === null || capacity <= 0) {
    rate.textContent = "Not estimable";
    range.textContent = "Not estimable";
    example.textContent = "Not estimable";
    explanation.textContent =
      "There is not yet enough matched cost and quota evidence for a positive fitted rate. API prices remain a measuring stick, not a subscription charge.";
    return;
  }
  const perPoint = capacity / 100;
  const movementForHundred = 10_000 / capacity;
  rate.textContent = `${formatMoney(perPoint, 2)} API equivalent per 1 percentage point`;
  range.textContent = lower !== null && lower > 0 && upper !== null && upper > 0
    ? `${formatMoney(lower / 100, 2)}–${formatMoney(upper / 100, 2)} per point`
    : "Range unavailable";
  example.textContent =
    `$100 of recorded API-price-equivalent usage corresponds to about ${movementForHundred.toFixed(1)} percentage points`;
  explanation.textContent = lower !== null && lower > 0 && upper !== null && upper > 0
    ? `The central fit implies a full 100-point allowance near ${formatMoney(capacity, 0)} API equivalent. The 80% range (${formatMoney(lower, 0)}–${formatMoney(upper, 0)}) describes variation across qualifying reset periods; it is not an 80% probability or a provider-published dollar cap.`
    : `The central fit implies a full 100-point allowance near ${formatMoney(capacity, 0)} API equivalent, but there is not yet a usable across-reset range. This is not a provider-published dollar cap.`;
}

function groupRolling(rows, hours) {
  const groups = new Map();
  for (const row of rows) {
    const rowHours = finite(row.smoothing_hours ?? row.smoothingHours, hours);
    if (rowHours !== hours) continue;
    const timestamp = row.timestamp ?? row.window_end_utc ?? row.observed_at;
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
    const group = groups.get(timestamp) ?? { timestamp, observed: null, expected: null };
    const series = String(row.series ?? "").toLowerCase();
    const value = finite(row.quota_change_pp ?? row.quotaChangePp);
    if (series.includes("observ")) group.observed = value;
    else if (series.includes("expect") || series.includes("cost")) group.expected = value;
    else {
      group.observed ??= finite(row.observed_quota_change_pp);
      group.expected ??= finite(row.expected_quota_change_pp);
    }
    groups.set(timestamp, group);
  }
  return [...groups.values()]
    .filter((row) => row.observed !== null || row.expected !== null)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function timelineCutoffMs(data) {
  const latest = data.timeline.usage.at(-1)?.endAt
    ?? data.timeline.quota.at(-1)?.observedAt
    ?? data.freshness.latestObservedAt;
  const latestMs = Date.parse(latest);
  return Number.isFinite(latestMs)
    ? latestMs - activeTimelineRangeDays * 24 * 60 * 60 * 1_000
    : Number.NEGATIVE_INFINITY;
}

function timelineBounds(points) {
  const values = points
    .map((point) => Date.parse(point.timestamp))
    .filter(Number.isFinite);
  if (values.length < 2) return null;
  return { startMs: Math.min(...values), endMs: Math.max(...values) };
}

function normalizeTimelineViewport(points) {
  const bounds = timelineBounds(points);
  if (bounds === null) return null;
  if (timelineViewport === null) return bounds;
  const startMs = Math.max(bounds.startMs, Math.min(timelineViewport.startMs, bounds.endMs));
  const endMs = Math.max(startMs + 1, Math.min(timelineViewport.endMs, bounds.endMs));
  if (endMs - startMs < 60_000) return bounds;
  return { startMs, endMs };
}

function timelinePointsInViewport(points, viewport) {
  if (viewport === null) return points;
  return points.filter((point) => {
    const timestamp = Date.parse(point.timestamp);
    return Number.isFinite(timestamp)
      && timestamp >= viewport.startMs
      && timestamp <= viewport.endMs;
  });
}

function resetTimelineViewport() {
  timelineViewport = null;
}

function updateTimelineViewport(points, update) {
  const bounds = timelineBounds(points);
  const current = normalizeTimelineViewport(points);
  if (bounds === null || current === null) return;
  const next = update({ ...current }, bounds);
  if (!next || !Number.isFinite(next.startMs) || !Number.isFinite(next.endMs)) return;
  const minimumSpanMs = Math.min(15 * 60_000, Math.max(60_000, (bounds.endMs - bounds.startMs) / 200));
  const startMs = Math.max(bounds.startMs, Math.min(next.startMs, bounds.endMs - minimumSpanMs));
  const endMs = Math.min(bounds.endMs, Math.max(next.endMs, startMs + minimumSpanMs));
  timelineViewport = endMs - startMs >= bounds.endMs - bounds.startMs - 1
    ? null
    : { startMs, endMs };
  if (dashboard) renderTimeline(dashboard);
}

function zoomTimeline(points, factor, anchorRatio = .5) {
  updateTimelineViewport(points, (current, bounds) => {
    const span = current.endMs - current.startMs;
    const nextSpan = Math.min(bounds.endMs - bounds.startMs, Math.max(60_000, span * factor));
    const anchor = current.startMs + span * Math.max(0, Math.min(1, anchorRatio));
    return {
      startMs: anchor - nextSpan * anchorRatio,
      endMs: anchor + nextSpan * (1 - anchorRatio),
    };
  });
}

function panTimeline(points, fraction) {
  updateTimelineViewport(points, (current, bounds) => {
    const span = current.endMs - current.startMs;
    const shift = span * fraction;
    let startMs = current.startMs + shift;
    let endMs = current.endMs + shift;
    if (startMs < bounds.startMs) {
      endMs += bounds.startMs - startMs;
      startMs = bounds.startMs;
    }
    if (endMs > bounds.endMs) {
      startMs -= endMs - bounds.endMs;
      endMs = bounds.endMs;
    }
    return { startMs, endMs };
  });
}

function timelineStatusLabel(status) {
  return {
    matched: "Matched quota bracket",
    missing_quota_bracket: "Missing quota bracket",
    reset_or_track_change: "Provider reset or quota-track change",
    backward_or_ambiguous: "Ambiguous quota movement",
  }[status] ?? "Historical calibration point";
}

function timelineStatusIntervals(points, viewport) {
  const rows = points
    .filter((point) => Number.isFinite(Date.parse(point.timestamp)))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return rows.flatMap((point, index) => {
    if (!point.status || point.status === "matched") return [];
    const current = Date.parse(point.timestamp);
    const previous = index === 0 ? viewport.startMs : Date.parse(rows[index - 1].timestamp);
    const next = index === rows.length - 1 ? viewport.endMs : Date.parse(rows[index + 1].timestamp);
    return [{
      status: point.status,
      startMs: Math.max(viewport.startMs, (previous + current) / 2),
      endMs: Math.min(viewport.endMs, (current + next) / 2),
    }];
  });
}

function latestQuotaAtOrBefore(rows, timestampMs) {
  let selected = null;
  for (const row of rows) {
    const observedMs = Date.parse(row.observedAt);
    if (observedMs > timestampMs) break;
    selected = row;
  }
  return selected;
}

function liveTimelinePoints(data) {
  const usage = data.timeline.usage;
  const capacity = finite(
    data.gradient.summary?.capacity_usd
      ?? data.weekly.summary?.median_weekly_value_usd
  );
  if (!usage.length) return [];
  const windowMs = activeWindowHours * 60 * 60 * 1_000;
  const cutoff = timelineCutoffMs(data);
  const preferredQuota = data.timeline.quota.filter((row) => row.limitId === "codex");
  const quota = (preferredQuota.length ? preferredQuota : data.timeline.quota)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const points = [];
  let startIndex = 0;
  let rollingCost = 0;
  let rollingEvents = 0;
  for (let index = 0; index < usage.length; index += 1) {
    const current = usage[index];
    const endMs = Date.parse(current.endAt);
    rollingCost += current.apiPriceEquivalentUsd;
    rollingEvents += current.usageEvents;
    while (startIndex <= index
        && Date.parse(usage[startIndex].endAt) <= endMs - windowMs) {
      rollingCost -= usage[startIndex].apiPriceEquivalentUsd;
      rollingEvents -= usage[startIndex].usageEvents;
      startIndex += 1;
    }
    if (endMs < cutoff) continue;
    const startMs = endMs - windowMs;
    const before = latestQuotaAtOrBefore(quota, startMs);
    const after = latestQuotaAtOrBefore(quota, endMs);
    const maximumBracketGapMs = Math.max(30 * 60 * 1_000, windowMs);
    const bracketed = before && after
      && startMs - Date.parse(before.observedAt) <= maximumBracketGapMs
      && endMs - Date.parse(after.observedAt) <= maximumBracketGapMs;
    const sameReset = bracketed && before.resetAt && before.resetAt === after.resetAt;
    const observed = sameReset && after.usedPercent >= before.usedPercent
      ? after.usedPercent - before.usedPercent
      : null;
    const expected = capacity !== null && capacity > 0
      ? rollingCost / capacity * 100
      : null;
    points.push({
      timestamp: current.endAt,
      observed,
      expected,
      residual: observed === null || expected === null ? null : observed - expected,
      apiCostUsd: Math.max(0, rollingCost),
      usageEvents: Math.max(0, rollingEvents),
      status: !bracketed ? "missing_quota_bracket"
        : !sameReset ? "reset_or_track_change"
          : observed === null ? "backward_or_ambiguous"
            : "matched"
    });
  }
  return points;
}

function groupedUsageTimeline(data) {
  const sizes = {
    hour: 60 * 60 * 1_000,
    day: 24 * 60 * 60 * 1_000,
    week: 7 * 24 * 60 * 60 * 1_000
  };
  const size = sizes[activeUsageGrouping] ?? sizes.hour;
  const cutoff = timelineCutoffMs(data);
  const groups = new Map();
  for (const row of data.timeline.usage) {
    const timestamp = Date.parse(row.startAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoff) continue;
    const startMs = Math.floor(timestamp / size) * size;
    const group = groups.get(startMs) ?? {
      timestamp: new Date(startMs).toISOString(),
      apiCostUsd: 0,
      usageEvents: 0,
      totalTokens: 0
    };
    group.apiCostUsd += row.apiPriceEquivalentUsd;
    group.usageEvents += row.usageEvents;
    group.totalTokens += row.totalTokens;
    groups.set(startMs, group);
  }
  return [...groups.values()]
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .map((row) => ({ ...row, apiCostUsd: Number(row.apiCostUsd.toFixed(6)) }));
}

function renderUsageTimeline(data) {
  const points = groupedUsageTimeline(data);
  const shell = $("#usage-timeline-chart");
  const empty = $("#usage-timeline-empty");
  const label = { hour: "hour", day: "day", week: "week" }[activeUsageGrouping];
  $("#usage-timeline-title").textContent =
    `API-price-equivalent usage by ${label} · latest ${activeTimelineRangeDays} day${activeTimelineRangeDays === 1 ? "" : "s"}`;
  if (!points.length) {
    shell.hidden = true;
    empty.hidden = false;
  } else {
    shell.hidden = false;
    empty.hidden = true;
    shell.replaceChildren(lineChart({
      points,
      series: [{
        key: "apiCostUsd",
        className: "chart-line-value",
        label: "API-price-equivalent usage"
      }],
      yLabel: "API-equivalent USD",
      title: "Real local API-price-equivalent usage over time",
      description: "Content-free local usage metadata grouped over the selected interval.",
      includeZero: true
    }));
  }
  const summary = $("#usage-timeline-summary");
  clear(summary);
  const total = points.reduce((sum, row) => sum + row.apiCostUsd, 0);
  const events = points.reduce((sum, row) => sum + row.usageEvents, 0);
  const tokens = points.reduce((sum, row) => sum + row.totalTokens, 0);
  for (const [name, value] of [
    ["Real local buckets", compact(points.length)],
    ["API-price equivalent", formatApiMoney(total)],
    ["Usage events", compact(events)],
    ["Recorded tokens", compact(tokens)]
  ]) {
    const item = node("div");
    item.append(node("span", "", name), node("strong", "", value));
    summary.append(item);
  }
}

function selectedTimelinePoints(data) {
  const livePoints = data.mode !== "demo" ? liveTimelinePoints(data) : [];
  const historicalPoints = groupRolling(
    [...data.gradient.rollingHistory, ...data.gradient.rolling],
    activeWindowHours,
  );
  const liveMatched = livePoints.filter(
    (row) => row.observed !== null && row.expected !== null,
  ).length;
  const usingLive = liveMatched > 0 || historicalPoints.length === 0;
  return { points: usingLive ? livePoints : historicalPoints, usingLive };
}

function renderTimeline(data) {
  renderUsageTimeline(data);
  const { points, usingLive } = selectedTimelinePoints(data);
  const viewport = normalizeTimelineViewport(points);
  const visiblePoints = timelinePointsInViewport(points, viewport);
  const windowLabel = activeWindowHours === 0.25
    ? "15-minute"
    : `${activeWindowHours}-hour`;
  $("#timeline-chart-title").textContent = `${windowLabel} rolling quota change versus cost-implied change`;
  $("#timeline-chart-copy").textContent = usingLive
    ? "Real local collector · UTC chart axis · exact UTC and local times in the table below"
    : `Historical local calibration artifact from ${formatUtc(data.artifactStatus.gradient.generatedAt)} · recent quota snapshots are too sparse to bracket ${windowLabel} endpoints`;
  const empty = $("#timeline-empty");
  const shell = $("#timeline-chart");
  if (!visiblePoints.length) {
    shell.hidden = true;
    empty.hidden = false;
    empty.querySelector("strong").textContent = `No ${windowLabel} series loaded`;
    empty.querySelector("p").textContent = "This is a missing-data state, not a zero-usage period.";
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(lineChart({
      points: visiblePoints,
      series: [
        { key: "observed", className: "chart-line-observed", label: "Observed quota change" },
        { key: "expected", className: "chart-line-expected", label: "Expected from API cost" }
      ],
      yLabel: "Percentage points",
      title: `${activeWindowHours}-hour rolling quota movement`,
      description: "Observed quota movement compared with movement implied by priced token usage. The horizontal axis is UTC; exact UTC and local times are listed below.",
      xDomain: viewport,
      statusIntervals: usingLive && viewport !== null
        ? timelineStatusIntervals(points, viewport)
        : [],
    }));
    bindTimelineInteractions(shell, points, viewport);
  }
  renderTimelineSummary(data, visiblePoints);
  renderTimelineConfidence(points, visiblePoints, usingLive, viewport);
  renderResiduals(data, visiblePoints, viewport);
}

function renderTimelineConfidence(allPoints, visiblePoints, usingLive, viewport) {
  const element = $("#timeline-confidence");
  const matched = visiblePoints.filter((point) => point.observed !== null && point.expected !== null).length;
  const excluded = visiblePoints.length - matched;
  const full = timelineBounds(allPoints);
  const zoomed = viewport !== null && full !== null
    && (viewport.startMs !== full.startMs || viewport.endMs !== full.endMs);
  element.classList.toggle("low", matched < 3 || excluded > matched);
  if (!visiblePoints.length) {
    element.textContent = "No points fall inside this zoomed interval. Reset the view to return to the available evidence.";
  } else if (!usingLive) {
    element.textContent = "This historical calibration view has no per-window reset annotations. Treat it as diagnostic evidence, not a live allowance reading.";
  } else if (matched < 3) {
    element.textContent = `Low confidence: only ${matched} matched quota window${matched === 1 ? "" : "s"} is visible; ${excluded} window${excluded === 1 ? " is" : "s are"} excluded for missing or ambiguous quota evidence.`;
  } else if (excluded > 0) {
    element.textContent = `${matched} matched windows are shown. ${excluded} excluded window${excluded === 1 ? " is" : "s are"} shaded above; do not read them as zero usage.`;
  } else {
    element.textContent = `${matched} matched quota windows are visible. This compares observed percentage-point movement with a priced-token estimate; it is not a provider-published allowance.`;
  }
  if (zoomed) element.textContent += " Use Reset view to return to the selected date range.";
}

function bindTimelineInteractions(shell, points, viewport) {
  if (viewport === null) return;
  shell.classList.add("interactive-chart");
  shell.tabIndex = 0;
  shell.setAttribute("aria-label", "Interactive UTC quota timeline. Use plus or minus to zoom, arrow keys to pan, Home to reset, or drag horizontally.");
  const status = $("#timeline-zoom-status");
  status.textContent = `Timeline shows ${formatUtc(new Date(viewport.startMs).toISOString())} through ${formatUtc(new Date(viewport.endMs).toISOString())}.`;
  shell.onwheel = (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    const bounds = shell.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : .5;
    zoomTimeline(points, event.deltaY > 0 ? 1.35 : .74, ratio);
  };
  shell.onpointerdown = (event) => {
    timelinePointerStart = { x: event.clientX };
    shell.setPointerCapture?.(event.pointerId);
    shell.classList.add("is-panning");
  };
  shell.onpointermove = (event) => {
    if (timelinePointerStart === null) return;
    const width = Math.max(1, shell.getBoundingClientRect().width);
    const delta = event.clientX - timelinePointerStart.x;
    if (Math.abs(delta) < 3) return;
    timelinePointerStart.x = event.clientX;
    event.preventDefault();
    panTimeline(points, -delta / width);
  };
  const stopPanning = (event) => {
    timelinePointerStart = null;
    shell.releasePointerCapture?.(event.pointerId);
    shell.classList.remove("is-panning");
  };
  shell.onpointerup = stopPanning;
  shell.onpointercancel = stopPanning;
  shell.onkeydown = (event) => {
    if (["+", "="].includes(event.key)) {
      event.preventDefault();
      zoomTimeline(points, .74);
    } else if (["-", "_"].includes(event.key)) {
      event.preventDefault();
      zoomTimeline(points, 1.35);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panTimeline(points, -.2);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panTimeline(points, .2);
    } else if (event.key === "Home") {
      event.preventDefault();
      resetTimelineViewport();
      renderTimeline(dashboard);
    }
  };
}

function renderTimelineSummary(data, points) {
  const summary = data.gradient.summary ?? {};
  const sensitivity = data.gradient.windowSensitivity.find((row) => finite(row.smoothing_hours ?? row.window_hours ?? row.hours) === activeWindowHours);
  const matched = points.filter((row) => row.observed !== null && row.expected !== null);
  const live = points.some((row) => Object.hasOwn(row, "status"));
  const liveMae = matched.length
    ? matched.reduce((sum, row) => sum + Math.abs(row.observed - row.expected), 0) / matched.length
    : null;
  const livePeak = matched.length
    ? Math.max(...matched.map((row) => Math.abs(row.observed - row.expected)))
    : null;
  const values = [
    ["Matched windows", compact(matched.length)],
    ["Mean absolute error", formatPp(live ? liveMae : sensitivity?.mae_pp ?? sensitivity?.weighted_mae_pp ?? summary.mean_absolute_error_pp)],
    ["Peak residual", formatPp(live ? livePeak : summary.rolling_peak_absolute_residual_pp)],
    ["Usable quota coverage", points.length
      ? formatPercent(matched.length / points.length * 100)
      : "—"]
  ];
  const container = $("#timeline-summary");
  clear(container);
  for (const [label, value] of values) {
    const item = node("div");
    item.append(node("span", "", label), node("strong", "", value));
    container.append(item);
  }
}

function residualRows(data, points) {
  const live = points.some((row) => Object.hasOwn(row, "status"));
  const visibleBounds = timelineBounds(points);
  const pointResiduals = points.map((row) => ({
    ...row,
    residual: row.observed === null || row.expected === null
      ? null
      : row.observed - row.expected,
  }));
  const artifactResiduals = !live && data.gradient.residual.length
    ? data.gradient.residual.map((row) => ({
        timestamp: row.timestamp ?? row.window_end_utc,
        observed: finite(row.observed_quota_change_pp),
        expected: finite(row.expected_quota_change_pp),
        residual: finite(row.residual_pp)
      }))
    : [];
  const visibleArtifactResiduals = artifactResiduals.filter((row) => {
    const timestamp = Date.parse(row.timestamp);
    return Number.isFinite(timestamp)
      && visibleBounds !== null
      && timestamp >= visibleBounds.startMs
      && timestamp <= visibleBounds.endMs;
  });
  const source = visibleArtifactResiduals.length
    ? visibleArtifactResiduals
    : pointResiduals;
  return source
    .filter((row) => {
      const timestamp = Date.parse(row.timestamp);
      return row.residual !== null
        && Number.isFinite(timestamp)
        && (visibleBounds === null
          || (timestamp >= visibleBounds.startMs && timestamp <= visibleBounds.endMs));
    })
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function renderResiduals(data, points, viewport = null) {
  const residuals = residualRows(data, points);
  const empty = $("#residual-empty");
  const shell = $("#residual-chart");
  if (!residuals.length) {
    empty.hidden = false;
    shell.hidden = true;
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(lineChart({
      points: residuals,
      series: [{ key: "residual", className: "chart-line-value", label: "Residual" }],
      yLabel: "Percentage points",
      title: "Quota movement residuals",
      description: "Observed quota change minus the API-cost-implied change.",
      includeZero: true,
      xDomain: viewport,
    }));
  }
  const table = $("#residual-table");
  clear(table);
  const unmatched = points
    .filter((point) => point.timestamp && point.status && point.status !== "matched")
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  const largest = [...residuals]
    .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  const inspection = [...unmatched, ...largest]
    .filter((row, index, rows) => rows.findIndex((candidate) => candidate.timestamp === row.timestamp) === index)
    .slice(0, 8);
  if (!inspection.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No periods loaded.");
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const item of inspection) {
    const row = node("tr");
    const residual = item.observed === null || item.expected === null
      ? null
      : item.residual;
    row.append(
      node("td", "", `${formatUtc(item.timestamp)} · ${formatLocal(item.timestamp)}`),
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", residual === null ? "" : residual >= 0 ? "positive" : "negative", residual === null ? "Not comparable" : `${residual >= 0 ? "+" : ""}${formatPp(residual)}`),
      node("td", "", timelineStatusLabel(item.status ?? "matched")),
    );
    table.append(row);
  }
}

function lineChart({
  points,
  series,
  yLabel,
  title,
  description,
  includeZero = false,
  confidence = null,
  xDomain = null,
  statusIntervals = [],
}) {
  const width = 900;
  const height = 330;
  const margin = { top: 24, right: 22, bottom: 50, left: 58 };
  const values = points.flatMap((point) => series.map((item) => finite(point[item.key])).filter((value) => value !== null));
  if (confidence) values.push(...points.flatMap((point) => [finite(point[confidence.low]), finite(point[confidence.high])].filter((value) => value !== null)));
  if (includeZero) values.push(0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * .1;
  min -= pad;
  max += pad;
  const timestamps = points.map((point) => Date.parse(point.timestamp ?? point.date));
  const timed = timestamps.every(Number.isFinite);
  const dataStartMs = timed ? Math.min(...timestamps) : 0;
  const dataEndMs = timed ? Math.max(...timestamps) : Math.max(1, points.length - 1);
  const domainStartMs = timed && Number.isFinite(xDomain?.startMs)
    ? xDomain.startMs
    : dataStartMs;
  const domainEndMs = timed && Number.isFinite(xDomain?.endMs)
    ? xDomain.endMs
    : dataEndMs;
  const safeDomainEndMs = domainEndMs > domainStartMs
    ? domainEndMs
    : domainStartMs + 1;
  const x = (index, point = points[index]) => {
    const coordinate = timed
      ? (Date.parse(point.timestamp ?? point.date) - domainStartMs)
        / (safeDomainEndMs - domainStartMs)
      : index / Math.max(1, points.length - 1);
    return margin.left + coordinate * (width - margin.left - margin.right);
  };
  const y = (value) => margin.top + (max - value) / (max - min) * (height - margin.top - margin.bottom);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  const titleNode = document.createElementNS(svg.namespaceURI, "title");
  titleNode.textContent = title;
  const descNode = document.createElementNS(svg.namespaceURI, "desc");
  descNode.textContent = description;
  svg.append(titleNode, descNode);

  for (let index = 0; index < 5; index += 1) {
    const value = max - index / 4 * (max - min);
    const yPosition = y(value);
    svg.append(svgLine(margin.left, yPosition, width - margin.right, yPosition, "chart-grid"));
    svg.append(svgText(margin.left - 8, yPosition + 3, value.toFixed(Math.abs(max - min) < 10 ? 1 : 0), "chart-axis-label", "end"));
  }

  if (includeZero && min <= 0 && max >= 0) {
    svg.append(svgLine(margin.left, y(0), width - margin.right, y(0), "chart-zero"));
  }

  if (timed) {
    for (let index = 0; index < 4; index += 1) {
      const timestamp = new Date(
        domainStartMs + (safeDomainEndMs - domainStartMs) * index / 3,
      ).toISOString();
      svg.append(svgText(
        margin.left + (width - margin.left - margin.right) * index / 3,
        height - 22,
        formatUtc(timestamp, { dateOnly: safeDomainEndMs - domainStartMs > 7 * 24 * 60 * 60 * 1_000 }),
        "chart-axis-label",
        index === 0 ? "start" : index === 3 ? "end" : "middle",
      ));
    }
    svg.append(svgText(width / 2, height - 6, "UTC", "chart-axis-label", "middle"));
  } else {
    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])];
    for (const index of labelIndexes) {
      const timestamp = points[index]?.timestamp ?? points[index]?.date;
      svg.append(svgText(x(index), height - 22, formatUtc(timestamp, { dateOnly: true }), "chart-axis-label", index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"));
    }
  }
  const yAxisLabel = svgText(15, height / 2, yLabel, "chart-axis-label", "middle");
  yAxisLabel.setAttribute("transform", `rotate(-90 15 ${height / 2})`);
  svg.append(yAxisLabel);

  if (confidence) {
    const upper = points.map((point, index) => [x(index, point), y(finite(point[confidence.high], 0))]);
    const lower = points.map((point, index) => [x(index, point), y(finite(point[confidence.low], 0))]).reverse();
    const polygon = document.createElementNS(svg.namespaceURI, "polygon");
    polygon.setAttribute("points", [...upper, ...lower].map(([a, b]) => `${a},${b}`).join(" "));
    polygon.setAttribute("class", "chart-area-confidence");
    svg.append(polygon);
  }

  for (const interval of statusIntervals) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)
        || interval.endMs <= interval.startMs) continue;
    const start = margin.left + (interval.startMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * (width - margin.left - margin.right);
    const end = margin.left + (interval.endMs - domainStartMs)
      / (safeDomainEndMs - domainStartMs) * (width - margin.left - margin.right);
    const rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", String(Math.max(margin.left, start)));
    rect.setAttribute("y", String(margin.top));
    rect.setAttribute("width", String(Math.max(1, Math.min(width - margin.right, end) - Math.max(margin.left, start))));
    rect.setAttribute("height", String(height - margin.top - margin.bottom));
    rect.setAttribute("class", `chart-status-${interval.status === "reset_or_track_change" ? "reset" : interval.status === "missing_quota_bracket" ? "missing" : "ambiguous"}`);
    const intervalTitle = document.createElementNS(svg.namespaceURI, "title");
    intervalTitle.textContent = timelineStatusLabel(interval.status);
    rect.append(intervalTitle);
    svg.append(rect);
  }

  for (const item of series) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push([x(index, point), y(value)]);
    });
    if (segment.length) segments.push(segment);
    for (const pathPoints of segments) {
      const path = document.createElementNS(svg.namespaceURI, "polyline");
      path.setAttribute("points", pathPoints.map(([a, b]) => `${a},${b}`).join(" "));
      path.setAttribute("class", item.className);
      svg.append(path);
    }
  }
  return svg;
}

function svgLine(x1, y1, x2, y2, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
  element.setAttribute("x1", x1);
  element.setAttribute("y1", y1);
  element.setAttribute("x2", x2);
  element.setAttribute("y2", y2);
  element.setAttribute("class", className);
  return element;
}

function svgText(x, y, value, className, anchor = "start") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "text");
  element.setAttribute("x", x);
  element.setAttribute("y", y);
  element.setAttribute("class", className);
  element.setAttribute("text-anchor", anchor);
  element.textContent = value;
  return element;
}

function renderWeekly(data) {
  const summary = data.weekly.summary ?? {};
  const estimate = finite(summary.median_weekly_value_usd ?? summary.medianWeeklyValueUsd);
  const lower = finite(summary.lower_80_across_resets_usd ?? summary.lower80Usd);
  const upper = finite(summary.upper_80_across_resets_usd ?? summary.upper80Usd);
  const qualifying = finite(summary.qualifying_resets ?? summary.qualifyingResets, 0);
  const strength = Math.min(100, Math.round(qualifying / 14 * 100));
  $("#weekly-estimate").textContent = estimate === null ? "Insufficient evidence" : `${formatMoney(estimate)} API equivalent`;
  $("#weekly-range").textContent = lower === null || upper === null
    ? "No evidence interval available"
    : `80% across-reset range: ${formatMoney(lower)}–${formatMoney(upper)}`;
  $("#evidence-meter").style.width = `${strength}%`;
  $("#evidence-label").textContent = qualifying < 3 ? "Insufficient" : qualifying < 8 ? "Developing" : qualifying < 14 ? "Moderate" : "Substantial";
  $("#weekly-explanation").textContent = qualifying
    ? `Based on ${qualifying} qualifying reset series. This is an API-price-equivalent calibration, not a published dollar cap.`
    : "The estimate will appear when enough quota transitions can be matched to priced usage.";

  const values = data.weekly.weeklyValues.map((row, index) => ({
    ...row,
    timestamp: row.reset_due_at ?? row.resetAt ?? row.first_observed_at,
    value: finite(row.value_usd ?? row.value),
    low: finite(row.pairwise_p10_usd ?? row.lower),
    high: finite(row.pairwise_p90_usd ?? row.upper),
    index
  })).filter((row) => row.timestamp && row.value !== null);
  const empty = $("#weekly-empty");
  const shell = $("#weekly-chart");
  if (!values.length) {
    empty.hidden = false;
    shell.hidden = true;
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(lineChart({
      points: values,
      series: [{ key: "value", className: "chart-line-value", label: "Weekly estimate" }],
      confidence: { low: "low", high: "high" },
      yLabel: "API-equivalent USD",
      title: "Weekly allowance estimate history",
      description: "Central weekly estimate with the 10th to 90th percentile across-reset range."
    }));
  }
  renderWeeklyStats(summary, values);
  renderWeeklyTrend(data.gradient.summary ?? {}, values);
  renderWeeklyTable(values);
}

function medianValue(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderWeeklyTrend(gradientSummary, values) {
  const container = $("#weekly-trend");
  const earlyFromArtifact = finite(gradientSummary.early_three_median_usd);
  const recentFromArtifact = finite(gradientSummary.recent_three_median_usd);
  const artifactChange = finite(gradientSummary.early_to_recent_change);
  const enoughRows = values.length >= 6;
  const early = earlyFromArtifact
    ?? (enoughRows ? medianValue(values.slice(0, 3).map((row) => row.value)) : null);
  const recent = recentFromArtifact
    ?? (enoughRows ? medianValue(values.slice(-3).map((row) => row.value)) : null);
  const change = artifactChange
    ?? (early !== null && early > 0 && recent !== null ? recent / early - 1 : null);
  const heading = node("strong", "", "Has the inferred limit changed?");
  let conclusion;
  if (change === null || early === null || recent === null) {
    conclusion = "Not enough comparable resets yet. We need at least three early and three recent weekly estimates before making even a descriptive comparison.";
  } else {
    const magnitude = Math.abs(change);
    const direction = change >= 0 ? "higher" : "lower";
    const comparison = `The recent three-reset median is ${formatPercent(magnitude * 100, 1)} ${direction} than the early three-reset median (${formatMoney(early)} → ${formatMoney(recent)} API equivalent).`;
    conclusion = magnitude < 0.15
      ? `${comparison} That is not a clear regime change given the observed uncertainty, so the practical conclusion is “no convincing change detected.”`
      : `${comparison} This is a possible accounting or allowance shift, but not proof: it must persist across later resets and remain after plan, account, model, and Fast-mode differences are controlled.`;
  }
  container.replaceChildren(heading, node("p", "", conclusion));
}

function renderWeeklyStats(summary, values) {
  const stats = [
    ["Qualifying resets", finite(summary.qualifying_resets, values.length)],
    ["Held-out MAE", formatPp(summary.selected_holdout_mae_pp)],
    ["Prior-reset MAE", formatPp(summary.prior_reset_mae_pp)],
    ["80th pct error", formatPp(summary.prior_reset_p80_absolute_error_pp)]
  ];
  const container = $("#weekly-stats");
  clear(container);
  for (const [label, value] of stats) {
    const card = node("div", "weekly-stat");
    card.append(node("span", "", label), node("strong", "", value));
    container.append(card);
  }
}

function renderWeeklyTable(values) {
  const table = $("#weekly-table");
  clear(table);
  if (!values.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No weekly evidence loaded.");
    cell.colSpan = 8;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const row of values.slice(-14).reverse()) {
    const transitions = finite(row.eligible_transitions, 0);
    const span = finite(row.displayed_span_pp);
    const observedCost = span === null ? null : row.value * span / 100;
    const speedCoverage = finite(row.known_speed_fraction);
    const evidence = transitions < 25 ? "Low" : transitions < 75 ? "Moderate" : "Higher";
    const prior = finite(row.prior_prediction_mae_pp);
    const caveat = prior === null
      ? "First estimate; no prior forecast"
      : prior < 3 ? "Prior forecast tracked closely" : prior < 7 ? "Meaningful model error" : "High-error period";
    const tr = node("tr");
    tr.append(
      node("td", "", formatUtc(row.timestamp, { dateOnly: true })),
      node("td", "", formatApiMoney(observedCost)),
      node("td", "", formatPp(span)),
      node("td", "", formatMoney(row.value)),
      node("td", "", row.low === null || row.high === null ? "—" : `${formatMoney(row.low)}–${formatMoney(row.high)}`),
      node("td", "", `${transitions} transitions`),
      node("td", "", `${evidence}${speedCoverage === null ? "" : ` · ${formatPercent(speedCoverage * 100)} speed known`}`),
      node("td", "", caveat)
    );
    table.append(tr);
  }
}

function accountingPeriod(data) {
  return data.accounting.periods.find((period) => period.periodId === activeAccountingPeriod)
    ?? data.accounting;
}

function renderAccountingDimension(containerSelector, dimension, {
  emptyMessage = "No observations in this period."
} = {}) {
  const container = $(containerSelector);
  clear(container);
  const rows = Object.entries(dimension ?? {})
    .filter(([, row]) => finite(row.events, 0) > 0)
    .sort((left, right) => right[1].events - left[1].events);
  if (!rows.length) {
    container.append(node("p", "empty-inline", emptyMessage));
    return;
  }
  const total = rows.reduce((sum, [, row]) => sum + row.events, 0);
  for (const [key, row] of rows) {
    const item = node("div", "dimension-row");
    const copy = node("div");
    copy.append(
      node("strong", "", humanize(key)),
      node("span", "", `${compact(row.events)} events · ${compact(row.totalTokens)} tokens`)
    );
    item.append(
      copy,
      node("span", "dimension-share", formatPercent(row.events / Math.max(1, total) * 100, 1))
    );
    container.append(item);
  }
}

function renderAccounting(data) {
  const accounting = accountingPeriod(data);
  const summary = $("#accounting-summary");
  clear(summary);
  const pricedEvents = Object.values(accounting.byModel ?? {})
    .reduce((sum, row) => sum + finite(row.events, 0), 0);
  const attributed = finite(accounting.accountAttribution?.attributedPseudonymousEvents, 0);
  for (const [label, value, note] of [
    ["API-price equivalent", formatApiMoney(accounting.apiPriceEquivalentUsd), accounting.periodLabel],
    ["Usage events", compact(accounting.events ?? pricedEvents), "Content-free rollout snapshots"],
    ["Recorded tokens", compact(accounting.totalTokens), "All available token components"],
    ["Account attribution", formatPercent(attributed / Math.max(1, accounting.events) * 100, attributed > 0 ? 2 : 1), "Pseudonymous and local only"]
  ]) {
    const card = node("article", "metric-card compact-metric");
    card.append(
      node("span", "metric-name", label),
      node("strong", "metric-value", value),
      node("p", "", note)
    );
    summary.append(card);
  }

  const components = $("#accounting-components");
  clear(components);
  const componentRows = Object.entries(accounting.components ?? {})
    .sort((left, right) => right[1] - left[1]);
  const maximum = Math.max(1, ...componentRows.map(([, value]) => value));
  for (const [key, value] of componentRows) {
    const row = node("div", "component-row");
    row.append(node("span", "", humanize(key)));
    const track = node("div", "component-track");
    const fill = node("i");
    fill.style.width = `${Math.max(value > 0 ? 1 : 0, value / maximum * 100)}%`;
    track.append(fill);
    row.append(track, node("strong", "", compact(value)));
    components.append(row);
  }

  const models = $("#accounting-models");
  clear(models);
  const modelRows = [...(accounting.byModel ?? [])]
    .sort((left, right) => right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd);
  if (!modelRows.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No model accounting in this period.");
    cell.colSpan = 4;
    row.append(cell);
    models.append(row);
  } else {
    for (const model of modelRows) {
      const row = node("tr");
      row.append(
        node("td", "", model.model === "unknown" ? "Unknown / unrecognized" : model.model),
        node("td", "", compact(model.events)),
        node("td", "", compact(model.totalTokens)),
        node("td", "", formatApiMoney(model.apiPriceEquivalentUsd))
      );
      models.append(row);
    }
  }

  renderAccountingDimension("#accounting-speed", accounting.bySpeed);
  renderAccountingDimension("#accounting-tier", accounting.byApiServiceTier);
  renderAccountingDimension("#accounting-surface", accounting.bySurface);
  renderAccountingDimension("#accounting-lineage", accounting.byLineage);
  renderAccountingDimension("#accounting-effort", accounting.byReasoningEffort, {
    emptyMessage: "Reasoning effort is unavailable in the retained collector schema."
  });
  const toolDimension = Object.fromEntries(
    Object.entries(data.accounting.toolClasses?.counts ?? {}).map(([key, events]) => [
      key,
      { events, totalTokens: 0, apiPriceEquivalentUsd: 0 }
    ])
  );
  renderAccountingDimension("#accounting-tools", toolDimension, {
    emptyMessage: "No coarse tool-class events are retained."
  });
}

function renderQuality(data) {
  const coverage = data.quality.coverage;
  const summary = data.quality.summary ?? {};
  const overall = finite(data.coverage?.overallPercent ?? data.coverage?.percent, null);
  $("#coverage-total").textContent = overall === null ? `${coverage.length} signals` : formatPercent(overall, 1);
  const list = $("#coverage-list");
  clear(list);
  const rows = coverage.length ? coverage : [
    { dimension: "Fit-eligible transitions", coverage_fraction: summary.fit_eligible_fraction },
    { dimension: "Known speed tier", coverage_fraction: summary.known_speed_fraction }
  ].filter((row) => finite(row.coverage_fraction) !== null);
  if (!rows.length) {
    list.append(node("p", "empty-inline", "No coverage dimensions were returned."));
  } else {
    for (const item of rows) {
      const fraction = Math.max(0, Math.min(1, finite(item.coverage_fraction ?? item.coverageFraction, 0)));
      const row = node("div", "coverage-row");
      row.append(node("span", "", item.dimension ?? item.label ?? "Coverage"));
      const track = node("div", "coverage-track");
      const fill = node("i");
      fill.style.width = `${fraction * 100}%`;
      track.append(fill);
      row.append(track, node("strong", "", formatPercent(fraction * 100)));
      list.append(row);
    }
  }

  const issues = [
    ...data.monitoringGaps,
    ...data.quality.opportunities,
    ...data.quality.blindSpots
  ].slice(0, 18);
  const issueList = $("#blind-spot-list");
  clear(issueList);
  if (!issues.length) {
    issueList.append(node("div", "empty-inline", "No blind-spot inventory was returned."));
  } else {
    for (const item of issues) {
      const issue = node("div", "issue");
      issue.append(node("span", "issue-icon", "!"));
      const copy = node("div");
      copy.append(
        node("strong", "", item.title ?? item.dimension ?? "Unresolved coverage gap"),
        node("p", "", item.explanation ?? item.evidence ?? item.description ?? item.action ?? "Additional evidence is required.")
      );
      issue.append(copy, node("span", "issue-priority", humanize(item.status ?? item.priority ?? "Open")));
      issueList.append(issue);
    }
  }
}

function renderReports(data) {
  const container = $("#report-links");
  clear(container);
  if (!data.reports.length) {
    container.append(node("span", "empty-inline", "No reports advertised by the local companion."));
    return;
  }
  for (const report of data.reports) {
    if (data.mode === "demo") {
      container.append(node("span", "report-link", `${report.title} · demo only`));
      continue;
    }
    const link = node("a", "report-link", report.title);
    link.href = report.href;
    link.target = "_blank";
    link.rel = "noopener";
    container.append(link);
  }
}

function renderCollector(data) {
  const collector = data.collector ?? {};
  const state = $("#collector-state");
  state.textContent = data.state === "live" ? "Current" : humanize(data.state);
  state.className = `evidence-chip ${data.state === "live" ? "" : "neutral"}`;
  const rows = [
    ["Last scan", formatUtc(collector.lastScanAt ?? data.activity?.lastScanAt ?? data.freshness.latestObservedAt)],
    ["Safe records", compact(collector.safeRecordCount ?? data.activity?.safeRecordCount ?? data.activity?.recordCount)],
    ["Covered from", collector.coveredAt?.startAt ? formatUtc(collector.coveredAt.startAt) : "Unavailable"],
    ["Covered through", collector.coveredAt?.endAt ? formatUtc(collector.coveredAt.endAt) : "Unavailable"],
    ["Contribution through", collector.exportableCoveredAt?.endAt
      ? formatUtc(collector.exportableCoveredAt.endAt)
      : "No rollout usage available"],
    ["Usage / quota rows", `${compact(collector.recordCounts?.usage)} / ${compact(collector.recordCounts?.quota)}`],
    ["Index state", humanize(collector.indexingState || "Unavailable")],
    ["Source bytes", "Not exposed to browser"],
    ["Identity", collector.identityMode ?? "Pseudonymous"]
  ];
  const dl = $("#collector-details");
  clear(dl);
  for (const [term, value] of rows) {
    const wrapper = node("div");
    wrapper.append(node("dt", "", term), node("dd", "", value));
    dl.append(wrapper);
  }
  renderIndexProgress(collector.indexing ?? null, {
    status: collector.indexing?.status ?? collector.indexingState
  });
}

function renderIndexProgress(progress, { status = "" } = {}) {
  const container = $("#index-progress");
  if (!container) return;
  if (!progress || typeof progress !== "object") {
    container.hidden = true;
    return;
  }
  const allowedPhases = new Set([
    "starting",
    "discovering",
    "rollout_index",
    "quota_refresh",
    "reloading",
    "complete",
    "paused",
    "prospective",
    "failed"
  ]);
  const phase = allowedPhases.has(progress.phase) ? progress.phase : "rollout_index";
  const filesSelected = Number.isSafeInteger(progress.filesSelected)
    && progress.filesSelected >= 0 ? progress.filesSelected : null;
  const filesProcessed = Number.isSafeInteger(progress.filesProcessed)
    && progress.filesProcessed >= 0 ? progress.filesProcessed : 0;
  const recordsWritten = Number.isSafeInteger(progress.recordsWritten)
    && progress.recordsWritten >= 0 ? progress.recordsWritten : 0;
  const startAt = Number.isFinite(Date.parse(progress.coveredAt?.startAt))
    ? progress.coveredAt.startAt : "";
  const endAt = Number.isFinite(Date.parse(progress.coveredAt?.endAt))
    ? progress.coveredAt.endAt : "";
  const bar = $("#index-progress-bar");
  if (filesSelected !== null && filesSelected > 0) {
    bar.max = filesSelected;
    bar.value = Math.min(filesProcessed, filesSelected);
  } else {
    bar.max = 1;
    bar.removeAttribute("value");
  }
  $("#index-progress-title").textContent =
    status === "recent_7d_complete"
      ? "Recent local history indexed"
      : status === "recent_7d_partial"
        ? "Useful recent history indexed"
      : status === "prospective_only"
        ? "Collecting new activity prospectively"
        : status === "bounded_pause"
          ? "Recent history indexing paused"
          : "Indexing recent local history";
  $("#index-progress-phase").textContent = humanize(
    status === "recent_7d_complete" ? "complete" : phase
  );
  $("#index-progress-summary").textContent = status === "prospective_only"
    ? `${compact(recordsWritten)} safe records retained since local collection began. Older activity was not retroactively indexed for this existing checkpoint.`
    : status === "recent_7d_partial"
      ? `${compact(recordsWritten)} safe records retained from a bounded recent tail. The scan completed safely, but cannot prove it reached the entire requested seven-day window.`
      : filesSelected === null
        ? `${compact(recordsWritten)} safe records retained; discovering bounded recent rollouts.`
        : `${compact(filesProcessed)} of ${compact(filesSelected)} bounded rollout files processed · ${compact(recordsWritten)} safe records retained.`;
  $("#index-progress-coverage").textContent = startAt && endAt
    ? `Content-free evidence currently covers ${formatUtc(startAt)} through ${formatUtc(endAt)}. Raw content and source paths never enter this page.`
    : "Raw log contents and source paths never enter this page.";
  container.hidden = false;
}

function renderContributionSyncStatus(status) {
  const value = status ?? {
    state: "unavailable",
    paused: null,
    counts: {
      pending: 0,
      inFlight: 0,
      accepted: 0,
      retryable: 0,
      rejected: 0
    },
    nextAttemptAt: "",
    lastAcceptedAt: ""
  };
  const labels = {
    unavailable: "Queue unavailable",
    paused: "Queue paused",
    attention: "Needs attention",
    active: "Delivery active",
    idle: "Up to date",
    empty: "Nothing queued"
  };
  const chip = $("#sync-state");
  chip.textContent = labels[value.state] ?? "Queue unavailable";
  chip.className = ["active", "idle"].includes(value.state)
    ? "evidence-chip"
    : "evidence-chip neutral";
  const counts = value.counts;
  $("#sync-waiting").textContent = compact(counts.pending + counts.retryable);
  $("#sync-in-flight").textContent = compact(counts.inFlight);
  $("#sync-accepted").textContent = compact(counts.accepted);
  $("#sync-attention").textContent = compact(counts.retryable + counts.rejected);
  $("#sync-next-attempt").textContent = value.nextAttemptAt
    ? formatUtc(value.nextAttemptAt)
    : "None scheduled";
  $("#sync-last-accepted").textContent = value.lastAcceptedAt
    ? formatUtc(value.lastAcceptedAt)
    : "No accepted batch yet";
  const descriptions = {
    unavailable: "No verified local queue state is available. Nothing about a file, path, identity, origin, or credential is inferred.",
    paused: "Delivery is paused locally. Prepared batches remain content-free and will not be sent until you explicitly resume.",
    attention: "At least one batch is waiting for a retry or was rejected. Use the local status command for bounded counts; it does not print paths or identifiers.",
    active: "Committed privacy-safe batches are waiting, retrying, or currently leased to the foreground sender.",
    idle: "Every discovered committed batch has been accepted or replayed, and no retry is due.",
    empty: "No committed privacy-safe prepared set has entered this queue yet."
  };
  $("#sync-description").textContent = descriptions[value.state]
    ?? descriptions.unavailable;
  contributionSyncStatus = value;
  updateContributionSyncButtons();
}

function renderContributionSyncPreview(preview) {
  const value = preview ?? {
    status: "unavailable",
    state: "unavailable",
    item: null
  };
  contributionSyncPreview = value;
  const labels = {
    ready: "Ready",
    retry_wait: "Waiting to retry",
    paused: "Paused",
    empty: "Nothing queued",
    not_configured: "Not configured",
    unavailable: "Unavailable"
  };
  const chip = $("#sync-next-state");
  const state = value.status === "available"
    ? value.state
    : value.status;
  chip.textContent = labels[state] ?? "Unavailable";
  chip.className = state === "ready"
    ? "evidence-chip"
    : "evidence-chip neutral";
  if (!value.item) {
    $("#sync-next-coverage").textContent = value.status === "not_configured"
      ? "Set prepared directory at launch"
      : "—";
    $("#sync-next-records").textContent = "—";
    $("#sync-next-cost").textContent = "—";
    $("#sync-next-bytes").textContent = "—";
    updateContributionSyncButtons();
    return;
  }
  const item = value.item;
  $("#sync-next-coverage").textContent =
    `${formatUtc(item.coveredAt.startAt)} – ${formatUtc(item.coveredAt.endAt)}`;
  $("#sync-next-records").textContent =
    `${compact(item.recordCounts.total)} total · ${compact(item.recordCounts.usageEvents)} usage · ${compact(item.recordCounts.quotaSnapshots)} quota`;
  $("#sync-next-cost").textContent =
    `${item.accounting.estimatedApiCostUsd === null ? "Unpriced" : `$${item.accounting.estimatedApiCostUsd}`} · ${item.accounting.pricedEventCoveragePercent}% priced`;
  $("#sync-next-bytes").textContent =
    `${compact(item.reservedUploadBytes)} bytes reserved (${compact(item.preparedBytes)} prepared)`;
  updateContributionSyncButtons();
}

function updateContributionSyncButtons() {
  const available = contributionSyncPreview?.status === "available";
  const paused = contributionSyncStatus?.paused === true;
  $("#sync-inspect").disabled = contributionSyncBusy;
  $("#sync-run-once").disabled = contributionSyncBusy
    || !available
    || contributionSyncPreview?.deliveryConfigured !== true
    || contributionSyncPreview?.state !== "ready"
    || contributionSyncExactReview?.state !== "ready"
    || paused;
  $("#sync-pause").disabled = contributionSyncBusy
    || !available
    || contributionSyncStatus?.state === "unavailable"
    || paused;
  $("#sync-resume").disabled = contributionSyncBusy
    || !available
    || contributionSyncStatus?.state === "unavailable"
    || !paused;
}

function showContributionSyncAction(message, error = false) {
  const status = $("#sync-action-status");
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("error", error);
}

function clearContributionSyncExactReview() {
  contributionSyncExactReview = null;
  $("#sync-exact-review").hidden = true;
  $("#sync-exact-review-json").textContent = "";
}

function renderContributionSyncExactReview(value) {
  if (value?.schemaVersion !== "contribution-sync-exact-review-v0.1"
      || value.status !== "available"
      || value.state !== "ready"
      || value.networkActivity !== false
      || value.includesExactRetainedFields !== true
      || value.includesRawContent !== false
      || value.includesPaths !== false
      || value.includesDirectIdentifiers !== false
      || value.includesCredentials !== false
      || !/^[A-Za-z0-9_-]{43}$/u.test(value.reviewToken ?? "")
      || !Number.isSafeInteger(value.payloadBytes)
      || value.payloadBytes < 1
      || value.payloadBytes > 1_310_720) {
    throw new Error("The exact local review response was not usable.");
  }
  validateContributionForUpload(value.payload);
  contributionSyncExactReview = {
    state: value.state,
    payloadBytes: value.payloadBytes,
    reviewToken: value.reviewToken,
  };
  $("#sync-exact-review-json").textContent = JSON.stringify(value.payload, null, 2);
  $("#sync-exact-review-state").textContent =
    `Verified · ${compact(value.payloadBytes)} bytes`;
  $("#sync-exact-review").hidden = false;
}

async function refreshContributionSyncControls() {
  clearContributionSyncExactReview();
  // Preview discovery commits newly prepared sets to the queue. Read queue
  // status afterwards so the two cards describe the same durable state.
  const preview = await localClient.contributionSyncPreview();
  const status = await localClient.contributionSyncStatus();
  renderContributionSyncStatus(status);
  renderContributionSyncPreview(preview);
}

async function runContributionSyncAction(action) {
  if (contributionSyncBusy) return;
  contributionSyncBusy = true;
  updateContributionSyncButtons();
  showContributionSyncAction(
    action === "run"
      ? "Running one bounded foreground pass…"
      : action === "pause" ? "Pausing local delivery…" : "Resuming local delivery…"
  );
  try {
    if (action === "run") {
      if (contributionSyncExactReview?.state !== "ready") {
        throw new Error("exact review required");
      }
      const result = await localClient.runContributionSyncOnce(
        contributionSyncExactReview.reviewToken
      );
      if (result.status === "unavailable") throw new Error("sync unavailable");
      showContributionSyncAction(
        `Pass ${result.status}: ${compact(result.processed)} processed, ${compact(result.accepted)} accepted, ${compact(result.reservedUploadBytes)} upload bytes reserved${result.bandwidthLimited ? "; stopped at byte cap" : ""}.`
      );
    } else {
      const status = await localClient.setContributionSyncPaused(action === "pause");
      if (status.state === "unavailable") throw new Error("control unavailable");
      showContributionSyncAction(
        action === "pause" ? "Local delivery is paused." : "Local delivery is resumed."
      );
    }
    await refreshContributionSyncControls();
  } catch {
    showContributionSyncAction(
      "The local companion rejected or could not complete this action. Durable queue state was retained.",
      true
    );
  } finally {
    contributionSyncBusy = false;
    updateContributionSyncButtons();
  }
}

async function loadLocalDashboard() {
  const button = $("#refresh-button");
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const [data, syncStatus, syncPreview, localHealth] = await Promise.all([
      localClient.load(),
      localClient.contributionSyncStatus(),
      localClient.contributionSyncPreview(),
      localClient.health().catch(() => null)
    ]);
    renderDashboard(data);
    renderPreparationIdentity(localHealth);
    renderContributionSyncStatus(syncStatus);
    renderContributionSyncPreview(syncPreview);
  } catch {
    const [localHealth, backendHealth] = await Promise.all([
      localClient.health().catch(() => null),
      communityClient.health().catch(() => null)
    ]);
    const backendOnly = localHealth === null
      && backendHealth?.checks?.database === "ok";
    dashboard = null;
    renderContributionSyncStatus(null);
    renderContributionSyncPreview(null);
    renderPreparationIdentity(null);
    setGlobalState("offline");
    $("#latest-observation").textContent = backendOnly
      ? "Backend-only origin"
      : "Companion unavailable";
    $("#data-source").textContent = "No real usage is displayed";
    showConnectionNotice({
      title: backendOnly
        ? "This address is the backend-only service"
        : localHealth
          ? "The companion could not load the local dashboard"
          : "The local companion is not available",
      copy: backendOnly
        ? "Open the unified portal URL printed by the product laboratory. Local usage APIs are intentionally unavailable on the backend origin."
        : localHealth
          ? "The loopback server is running, but its local evidence contract could not be loaded. Existing evidence remains on this machine."
          : "Start the product laboratory, then open its printed portal URL. You can explore a clearly labeled demonstration in the meantime.",
      kind: "error",
      showDemo: true
    });
    renderDashboardSkeleton();
  } finally {
    button.disabled = false;
    button.textContent = "Refresh local data";
  }
}

function renderPreparationIdentity(health) {
  const chip = $("#preparation-identity");
  const mode = health?.capabilities?.contributionPreparationIdentityMode;
  const labels = {
    production_keychain: "Keychain checked on prepare",
    development_file_override: "Development file ready",
    development_environment_override: "Development environment override",
  };
  chip.textContent = labels[mode] ?? "Unavailable";
  chip.className = mode === "development_file_override"
    ? "evidence-chip"
    : "evidence-chip neutral";
}

function renderDashboardSkeleton() {
  const container = $("#quota-cards");
  clear(container);
  const card = node("article", "metric-card insufficient");
  const header = node("div", "metric-card-header");
  header.append(node("span", "metric-name", "No local evidence"), node("span", "evidence-chip", "Offline"));
  card.append(header, node("strong", "metric-value", "—"), node("p", "", "This empty state is intentional. Demo values are never substituted automatically."));
  container.append(card);
}

async function requestRefresh() {
  const button = $("#refresh-button");
  button.disabled = true;
  button.textContent = "Starting scan…";
  renderIndexProgress({
    phase: "starting",
    filesSelected: null,
    filesProcessed: 0,
    recordsWritten: 0,
    coveredAt: { startAt: "", endAt: "" }
  }, { status: "running" });
  try {
    await localClient.refresh();
    let outcome = "running";
    for (let attempt = 0; attempt < 400 && outcome === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const status = await localClient.refreshStatus();
      const refresh = status?.refresh ?? {};
      outcome = refresh.status ?? "failed";
      const progress = refresh.progress ?? refresh.result?.indexing ?? null;
      if (progress) renderIndexProgress(progress, { status: outcome });
      const processed = Number.isSafeInteger(progress?.filesProcessed)
        ? progress.filesProcessed : null;
      const selected = Number.isSafeInteger(progress?.filesSelected)
        ? progress.filesSelected : null;
      button.textContent = processed !== null && selected !== null
        ? `Indexing ${processed}/${selected} files…`
        : attempt < 2 ? "Scanning local evidence…" : `Scanning… ${attempt + 1}s`;
      if (outcome === "failed"
          && refresh.errorCode === "refresh_timed_out") {
        if (progress?.status === "bounded_pause") {
          try {
            await localClient.refresh();
            button.textContent = "Continuing bounded index…";
          } catch (error) {
            // A 409 means the aborted run is still finishing its durable
            // checkpoint. Keep polling until it becomes resumable.
            if (error?.status !== 409) throw error;
          }
        } else {
          button.textContent = "Finalizing bounded pause…";
        }
        outcome = "running";
      }
    }
    if (outcome !== "succeeded") throw new Error("The local refresh did not complete successfully.");
    button.textContent = "Loading updated evidence…";
    await loadLocalDashboard();
  } catch {
    showConnectionNotice({
      title: "Refresh could not be started",
      copy: "The local companion may be offline, busy, or rejecting this request. Existing evidence has not been altered.",
      kind: "error",
      showDemo: !dashboard
    });
  } finally {
    button.disabled = false;
    button.textContent = "Refresh local data";
  }
}

async function prepareLocalContribution() {
  if (contributionPreparationBusy) return;
  contributionPreparationBusy = true;
  const button = $("#prepare-contribution");
  const status = $("#prepare-contribution-status");
  button.disabled = true;
  button.textContent = "Preparing locally…";
  status.classList.remove("error");
  status.textContent =
    "Building and independently verifying a content-free latest-hour contribution. No network upload is performed.";
  clearContributionSyncExactReview();
  try {
    const result = await localClient.prepareContribution();
    if (result.status !== "prepared") {
      throw new Error("Preparation did not return a verified contribution.");
    }
    const records = result.recordCounts.usageEvents
      + result.recordCounts.quotaSnapshots
      + result.recordCounts.activityMarkers;
    status.textContent =
      `Prepared ${compact(result.prepared.batchCount)} verified batch${result.prepared.batchCount === 1 ? "" : "es"} with ${compact(records)} safe records (${compact(result.prepared.bytes)} bytes). Nothing was uploaded.`;
    await refreshContributionSyncControls();
  } catch (error) {
    status.classList.add("error");
    const preparationMessages = {
      identity_unavailable:
        "The local Keychain identity is unavailable. Open Keychain Access, select the login Keychain, unlock it, then retry. Do not reset, delete, rotate, or broaden access to the identity. No upload occurred.",
      coverage_unavailable:
        "No usable local coverage is available yet. Refresh local data first. No upload occurred.",
      coverage_invalid:
        "The latest local coverage interval is not usable for a contribution. No upload occurred.",
      no_safe_records:
        "No privacy-safe records were found in the latest covered hour. No upload occurred.",
      export_too_large:
        "The latest-hour export exceeded a fixed safety bound. No upload occurred.",
      privacy_verification_failed:
        "Privacy verification rejected the prepared data, so it was not queued or uploaded.",
      preparation_in_progress:
        "A local preparation is already running. Nothing has been uploaded."
    };
    status.textContent = preparationMessages[error?.code]
      ?? "A privacy-verified contribution could not be prepared. No upload occurred and incomplete staging is ignored by the queue.";
  } finally {
    contributionPreparationBusy = false;
    button.disabled = false;
    button.textContent = "Prepare latest hour locally";
  }
}

function parseSafeExport(file) {
  if (!file || file.size > 1_310_720) throw new Error("Choose a JSON export no larger than 1.25 MB.");
  if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") {
    throw new Error("Choose the JSON export produced by Usage Monitor.");
  }
  return file.text().then((content) => {
    let payload;
    try {
      payload = JSON.parse(content);
    } catch {
      throw new Error("The selected file is not valid JSON.");
    }
    validateContributionForUpload(payload);
    return payload;
  });
}

function resetSelectedContributionInspection() {
  selectedContributionValidated = false;
  $("#selected-contribution-inspection").hidden = true;
  $("#selected-contribution-state").textContent = "Not validated";
  $("#selected-contribution-state").className = "evidence-chip neutral";
  $("#selected-contribution-message").textContent =
    "Choose a Usage Monitor export to validate it locally.";
  $("#selected-contribution-schema").textContent = "—";
  $("#selected-contribution-bytes").textContent = "—";
  $("#selected-contribution-usage").textContent = "—";
  $("#selected-contribution-quota").textContent = "—";
  $("#selected-contribution-json").textContent = "";
}

function renderSelectedContributionInspection(file, payload) {
  const usageRows = Array.isArray(payload.usageEvents)
    ? payload.usageEvents.length
    : 0;
  const quotaRows = Array.isArray(payload.quotaSnapshots)
    ? payload.quotaSnapshots.length
    : 0;
  selectedContributionValidated = true;
  $("#selected-contribution-inspection").hidden = false;
  $("#selected-contribution-state").textContent = "Validated locally";
  $("#selected-contribution-state").className = "evidence-chip";
  $("#selected-contribution-message").textContent =
    "The closed-schema browser preflight passed. Expand the review below before consenting.";
  $("#selected-contribution-schema").textContent = payload.schemaVersion;
  $("#selected-contribution-bytes").textContent =
    `${new Intl.NumberFormat("en-US").format(file.size)} bytes`;
  $("#selected-contribution-usage").textContent = compact(usageRows);
  $("#selected-contribution-quota").textContent = compact(quotaRows);
  $("#selected-contribution-json").textContent = JSON.stringify(payload, null, 2);
}

function renderSelectedContributionError(error) {
  selectedContributionValidated = false;
  $("#selected-contribution-inspection").hidden = false;
  $("#selected-contribution-state").textContent = "Rejected locally";
  $("#selected-contribution-state").className = "evidence-chip error";
  $("#selected-contribution-message").textContent =
    error instanceof Error
      ? error.message
      : "The selected file did not pass the closed-schema browser preflight.";
  $("#selected-contribution-schema").textContent = "Not accepted";
  $("#selected-contribution-bytes").textContent = "—";
  $("#selected-contribution-usage").textContent = "—";
  $("#selected-contribution-quota").textContent = "—";
  $("#selected-contribution-json").textContent = "";
}

async function ensureCommunitySession(contributionSchemaVersion) {
  const requiredConsent = contributionSchemaVersion === "telemetry-contribution-v0.2"
    ? "privacy-safe-telemetry-v0.2"
    : "privacy-safe-telemetry-v0.1";
  if (communitySession?.csrfToken) {
    if (communitySession.consentVersion !== requiredConsent) {
      throw new Error(
        `This browser session accepted ${communitySession.consentVersion || "an older consent contract"}. Sign out and enroll with this export, or recover the matching anonymous participant.`
      );
    }
    return communitySession;
  }
  const inviteInput = $("#contribution-invite");
  const inviteCode = inviteInput.value.trim();
  let enrollment;
  try {
    enrollment = await communityClient.enroll(
      inviteCode || null,
      contributionSchemaVersion
    );
  } finally {
    inviteInput.value = "";
  }
  if (typeof enrollment?.csrfToken !== "string") {
    throw new Error("The contribution service did not establish an anonymous web session.");
  }
  setCommunitySession({
    csrfToken: enrollment.csrfToken,
    participantId: enrollment.participantId ?? null,
    consentVersion: requiredConsent
  });
  showRecoveryCodeOnce(enrollment.recoveryCode);
  return communitySession;
}

async function submitContribution(event) {
  event.preventDefault();
  const file = $("#contribution-file").files[0];
  const status = $("#upload-status");
  const button = $("#contribution-submit");
  status.hidden = false;
  status.className = "upload-status";
  status.textContent = "Validating the privacy-safe export in this browser…";
  button.disabled = true;
  try {
    const payload = await parseSafeExport(file);
    await ensureCommunitySession(payload.schemaVersion);
    status.textContent = "Encrypting the validated export in this browser…";
    const key = await communityClient.envelopeKey();
    if (key?.algorithm && key.algorithm !== "RSA-OAEP-256") throw new Error("The server offered an unsupported envelope algorithm.");
    const envelope = await createTelemetryEnvelope({
      payload,
      publicJwk: key.publicJwk,
      keyId: key.keyId
    });
    const serializedEnvelope = JSON.stringify(envelope);
    const contentLengthBytes = new TextEncoder().encode(serializedEnvelope).byteLength;
    const envelopeDigest = await sha256Hex(serializedEnvelope);
    status.textContent = "Registering a one-use authorization for this exact encrypted envelope…";
    const registration = await communityClient.registerUpload({
      envelopeDigest,
      contentLengthBytes,
      contentType: "application/json"
    });
    if (typeof registration?.uploadAuthorization !== "string") {
      throw new Error("The service did not return a one-use upload authorization.");
    }
    status.textContent = "Submitting encrypted telemetry for immediate server-side validation…";
    const receipt = await communityClient.contributeSerialized(
      serializedEnvelope,
      registration.uploadAuthorization
    );
    setCommunitySession({ ...communitySession, contributionId: receipt.contributionId });
    status.textContent = `Accepted as ${receipt.contributionId}. The server reported ${compact(receipt.recordCounts?.deduplicated ?? 0)} deduplicated records.`;
    await loadCommunityResults();
  } catch (error) {
    status.className = "upload-status error";
    status.textContent = error instanceof Error ? error.message : safeApiError(error, "The contribution was rejected.");
  } finally {
    button.disabled = !(
      selectedContributionValidated
      && $("#contribution-consent").checked
      && $("#contribution-file").files.length
    );
  }
}

function renderPersonalStats(container, payload) {
  clear(container);
  const stats = normalizeParticipantStats(payload);
  if (stats.state === "service_unavailable") {
    container.append(node("p", "", "No personal result is available."));
    return;
  }
  if (stats.state === "unsupported_schema") {
    container.append(node(
      "p",
      "result-state result-state-warning",
      `The service returned ${stats.schemaVersion || "an unknown schema"}, not participant-stats-v0.2. No personal values were displayed.`
    ));
    return;
  }

  const source = stats.totals;
  const grid = node("div", "result-metrics");
  const metrics = [
    ["Safe usage events", source.usageEvents, compact],
    ["Server-repriced API equivalent", source.apiPriceEquivalentUsd, formatApiMoney],
    ["Quota snapshots", source.quotaSnapshots, compact]
  ];
  for (const [label, value, formatter] of metrics) {
    const card = node("div");
    card.append(
      node("span", "", label),
      node("strong", "", value === null ? "Not available" : formatter(value))
    );
    grid.append(card);
  }
  container.append(grid);

  const verification = node("p", "result-verification");
  verification.append(
    node("strong", "", "Server-repriced API equivalent. "),
    document.createTextNode(
      "This is a current public API price-card comparison calculated by the server, not a subscription charge or OpenAI’s internal quota unit."
    )
  );
  container.append(verification);

  const coverage = stats.pricingCoverage;
  const coveragePanel = node("section", "participant-detail");
  coveragePanel.append(node("h4", "", "Server pricing coverage"));
  const coverageState = node("span", `coverage-state coverage-${coverage.state}`, coverage.state.replaceAll("_", " "));
  const coverageHeading = node("div", "participant-detail-heading");
  coverageHeading.append(
    coverageState,
    node(
      "strong",
      "",
      coverage.percent === null ? "Coverage not testable" : `${formatPercent(coverage.percent, 1)} of events at least partly priced`
    )
  );
  coveragePanel.append(coverageHeading);
  const coverageGrid = node("div", "coverage-counts");
  for (const [label, value] of [
    ["Fully priced", coverage.fullyPricedEvents],
    ["Partly priced", coverage.partiallyPricedEvents],
    ["Unpriced", coverage.unpricedEvents],
    ["Unclassified", coverage.unclassifiedEvents]
  ]) {
    const item = node("div");
    item.append(node("span", "", label), node("strong", "", value === null ? "Unknown" : compact(value)));
    coverageGrid.append(item);
  }
  coveragePanel.append(coverageGrid);
  if (source.serverUnknownBillableUnits > 0) {
    coveragePanel.append(node(
      "p",
      "result-state result-state-warning",
      `${compact(source.serverUnknownBillableUnits)} observed billable units were not assigned a server price.`
    ));
  }
  container.append(coveragePanel);

  const pricingBasis = node("section", "participant-detail");
  pricingBasis.append(node("h4", "", "Keep subscription speed separate from API pricing"));
  const basisGrid = node("div", "pricing-basis-grid");
  const standard = node("article", "basis-card");
  standard.append(
    node("span", "basis-label", "Standard API counterfactual"),
    node(
      "strong",
      "",
      stats.standardApiCounterfactual.apiPriceEquivalentUsd === null
        ? "Not separately returned"
        : formatApiMoney(stats.standardApiCounterfactual.apiPriceEquivalentUsd)
    ),
    node(
      "p",
      "",
      stats.standardApiCounterfactual.apiPriceEquivalentUsd === null
        ? "This response does not isolate a Standard-only subtotal. The total above remains the verified server-repriced API equivalent."
        : `${stats.standardApiCounterfactual.events === null ? "Eligible subscription events" : compact(stats.standardApiCounterfactual.events) + " events"} repriced against the Standard API card.`
    )
  );
  const fast = node("article", "basis-card basis-fast");
  const fastValue = stats.codexFastObservations.eventShare === null
    ? stats.codexFastObservations.eventCount === null
      ? "Not testable"
      : `${compact(stats.codexFastObservations.eventCount)} events`
    : `${formatPercent(stats.codexFastObservations.eventShare * 100, 1)} of events`;
  fast.append(
    node("span", "basis-label", "Codex Fast observations"),
    node("strong", "", fastValue),
    node(
      "p",
      "",
      "Fast is a subscription speed observation. It is not API Priority tier, and no invented Fast price multiplier is applied here."
    )
  );
  basisGrid.append(standard, fast);
  pricingBasis.append(basisGrid);
  container.append(pricingBasis);

  const accountScoped = renderAccountScopedQuotaAnalysis(
    container,
    stats.accountScopedQuotaAnalysis
  );
  if (!accountScoped) {
    renderParticipantQuotaMovement(container, stats.rollingQuotaMovement);
  }
  renderPrivateCommunityComparison(container, stats.communityComparison);
}

const ACCOUNT_CALIBRATION_REASONS = Object.freeze({
  account_scoped_dataset_unavailable: "No complete account-scoped dataset has been contributed yet.",
  supported_quota_track_unavailable: "No five-hour or seven-day quota track is available in the contributed data.",
  source_evidence_refused: "The source dataset is partial or otherwise ineligible for calibration.",
  too_few_boundaries: "At least eight useful quota boundaries are required inside a reset window.",
  insufficient_displayed_span: "The visible quota movement covers less than five percentage points.",
  insufficient_training_boundaries: "There are too few earlier points to train this reset estimate.",
  insufficient_holdout_boundaries: "There are too few later points to test the estimate out of sample.",
  capacity_not_estimable: "Cost and quota movement do not yet form an estimable positive gradient.",
  sensitivity_too_wide: "The plausible capacity range is still too wide to report as a useful estimate.",
  prior_reset_forecast_unavailable: "At least two completed prior reset estimates are needed before a rolling comparison is honest.",
  endpoint_brackets_unavailable: "Quota observations do not bracket the exact rolling-hour endpoints closely enough."
});

function renderAccountScopedQuotaAnalysis(container, analysis) {
  if (analysis?.status !== "ready" || !analysis.tracks?.length) return false;
  const section = node("section", "participant-detail quota-movement");
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Account-scoped quota calibration"),
    node(
      "p",
      "",
      "Usage and quota evidence are partitioned by a participant-scoped pseudonym. These results are private and are never copied into community output."
    )
  );
  heading.append(title, node("span", "private-chip", "Private result"));
  section.append(heading);

  const grid = node("div", "pricing-basis-grid");
  for (const track of analysis.tracks) {
    const card = node("article", "basis-card");
    const windowLabel = track.windowDurationMinutes === 10_080
      ? "Seven-day allowance"
      : "Five-hour allowance";
    const estimate = track.latestCapacityUsd === null
      ? "Collecting evidence"
      : formatApiMoney(track.latestCapacityUsd);
    card.append(
      node(
        "span",
        "basis-label",
        `${windowLabel} · ${track.planVariant || track.planType}`
      ),
      node("strong", "", estimate)
    );
    if (track.latestCapacityUsd !== null) {
      const range = track.sensitivityLowerUsd !== null
        && track.sensitivityUpperUsd !== null
        ? ` Plausible sensitivity range: ${formatApiMoney(track.sensitivityLowerUsd)}–${formatApiMoney(track.sensitivityUpperUsd)}.`
        : "";
      card.append(node(
        "p",
        "",
        `API-price-equivalent capacity from ${compact(track.estimatedResets)} qualified reset${track.estimatedResets === 1 ? "" : "s"}.${range}`
      ));
    } else {
      card.append(node(
        "p",
        "",
        `${compact(track.totalResets)} reset window${track.totalResets === 1 ? "" : "s"} observed; none yet passes every calibration gate.`
      ));
    }
    const rolling = track.rollingStatus === "conditional_comparison"
      ? `${compact(track.rollingComparisonCount)} honest 1–3 hour rolling comparisons available.`
      : "Rolling observed-versus-expected comparison is not testable yet.";
    card.append(node("p", "", rolling));
    const reasons = [...new Set([
      ...track.refusalCodes,
      ...track.rollingRefusalCodes
    ])].slice(0, 3);
    if (reasons.length) {
      const list = node("ul", "calibration-reasons");
      for (const reason of reasons) {
        list.append(node(
          "li",
          "",
          ACCOUNT_CALIBRATION_REASONS[reason] ?? reason.replaceAll("_", " ")
        ));
      }
      card.append(list);
    }
    grid.append(card);
  }
  section.append(grid);
  container.append(section);
  return true;
}

const QUOTA_MOVEMENT_REASONS = Object.freeze({
  account_continuity_not_transmitted: "Account continuity is deliberately absent from this privacy-safe contribution, so the server will not calculate an account-specific quota conversion.",
  insufficient_quota_observations: "There are not yet two usable quota observations in one reset window.",
  analysis_record_limit_exceeded: "The private analysis exceeded its bounded record limit.",
  stale_quota_observation: "At least one provider quota observation arrived too late to support this comparison.",
  backward_quota_observation: "The quota percentage moved backwards inside one reset window, so this track was rejected as ambiguous.",
  incomplete_server_pricing_in_interval: "At least one overlapping usage event was not fully priced by the server.",
  no_observed_quota_movement: "The recorded quota percentage did not move in this window.",
  no_server_priced_usage_in_interval: "No server-priced usage overlaps this quota interval.",
  no_usage_in_interval: "No usage events overlap this quota interval.",
  no_valid_rolling_rows: "The response contained no valid 1-, 2-, or 3-hour comparison rows."
});

function renderParticipantQuotaMovement(container, movement) {
  const section = node("section", "participant-detail quota-movement");
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Private rolling quota movement"),
    node("p", "", "Observed quota decrease versus movement implied by server-repriced API equivalent, bucketed in UTC.")
  );
  heading.append(title, node("span", "private-chip", "Private result"));
  section.append(heading);

  if (movement.accountContinuity === "not_transmitted") {
    section.append(node(
      "p",
      "result-state result-state-warning",
      "Account continuity was not transmitted. Participant-wide usage may span accounts, so this comparison must not be treated as an account-specific quota conversion."
    ));
  }

  if (movement.status !== "conditional_estimate") {
    const copy = QUOTA_MOVEMENT_REASONS[movement.reason]
      ?? "The available private evidence cannot support this comparison yet.";
    const state = node("div", "not-testable-state");
    state.append(
      node("strong", "", "Not testable"),
      node("p", "", copy)
    );
    section.append(state);
  } else {
    const metadata = node("div", "movement-metadata");
    const resetLabel = movement.resetsAt ? `Reset ${formatUtc(movement.resetsAt)}` : "Reset time unavailable";
    const capacityLabel = movement.apiPriceEquivalentCapacityUsd === null
      ? "Capacity estimate unavailable"
      : `${formatApiMoney(movement.apiPriceEquivalentCapacityUsd)} per 100 percentage points`;
    metadata.append(
      node("span", "", [movement.planType, movement.planVariant, movement.limitId, movement.slot].filter(Boolean).join(" · ") || "Quota track"),
      node("span", "", resetLabel),
      node("span", "", capacityLabel)
    );
    section.append(metadata);
    section.append(node(
      "p",
      "snapshot-disclosure",
      "The capacity figure is a conditional API-price-equivalent gradient, not a provider-reported allowance. Tables show the latest 12 valid points for each smoothing window."
    ));

    for (const smoothingHours of [1, 2, 3]) {
      const rows = movement.rows
        .filter((row) => row.smoothingHours === smoothingHours)
        .sort((left, right) => Date.parse(left.windowEndUtc) - Date.parse(right.windowEndUtc))
        .slice(-12);
      const group = node("section", "movement-window");
      const groupHeading = node("div", "movement-window-heading");
      groupHeading.append(
        node("h5", "", `${smoothingHours}-hour rolling window`),
        node("span", "", rows.length ? `${rows.length} latest points` : "Not testable")
      );
      group.append(groupHeading);
      if (!rows.length) {
        group.append(node(
          "p",
          "empty-inline",
          `Not testable: the response does not yet contain a valid ${smoothingHours}-hour rolling point.`
        ));
        section.append(group);
        continue;
      }
      const wrap = node("div", "table-wrap movement-table");
      const table = document.createElement("table");
      const caption = node(
        "caption",
        "sr-only",
        `${smoothingHours}-hour private rolling quota movement in UTC`
      );
      const thead = document.createElement("thead");
      const header = document.createElement("tr");
      for (const label of ["Window ending (UTC)", "Observed", "Expected", "Difference", "API equivalent", "Events"]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = label;
        header.append(th);
      }
      thead.append(header);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        const difference = row.observedQuotaChangePp - row.expectedQuotaChangePp;
        for (const value of [
          formatUtc(row.windowEndUtc),
          formatPp(row.observedQuotaChangePp, 2),
          formatPp(row.expectedQuotaChangePp, 2),
          formatPp(difference, 2),
          formatApiMoney(row.apiPriceEquivalentUsd),
          compact(row.usageEvents)
        ]) {
          tr.append(node("td", "", value));
        }
        tbody.append(tr);
      }
      table.append(caption, thead, tbody);
      wrap.append(table);
      group.append(wrap);
      section.append(group);
    }
  }
  container.append(section);
}

const COMMUNITY_METRIC_LABELS = Object.freeze({
  usageEvents: "Usage events",
  inputUncachedTokens: "Input uncached",
  inputCacheReadTokens: "Cache read",
  inputCacheWriteTokens: "Cache write",
  outputTextTokens: "Output text",
  outputReasoningTokens: "Reasoning output",
  outputCombinedTokens: "Combined output",
  toolUnits: "Tool units"
});

const COMMUNITY_COMPARISON_REASONS = Object.freeze({
  stable_snapshot_unavailable: "No stable released community week is available yet.",
  community_snapshot_not_released: "The latest community week is withdrawn or privacy-suppressed, so no personal comparison is shown.",
  community_snapshot_contract_invalid: "The released community week could not be compared safely.",
  participant_comparison_too_large: "The comparison exceeded its fixed safe size.",
  participant_comparison_contract_invalid: "The participant comparison could not be constructed safely.",
  comparison_contract_invalid: "The comparison response did not pass browser validation."
});

function renderPrivateCommunityComparison(container, comparison) {
  const section = node("section", "participant-detail community-comparison");
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Your contribution in the released week"),
    node(
      "p",
      "",
      "Your value uses the publication clipping cap. The community value is the already-public total rounded down."
    )
  );
  heading.append(title, node("span", "private-chip", "Private comparison"));
  section.append(heading);

  if (comparison?.status !== "ready") {
    const state = node("div", "not-testable-state");
    state.append(
      node("strong", "", "Not testable"),
      node(
        "p",
        "",
        COMMUNITY_COMPARISON_REASONS[comparison?.reason]
          ?? "A disclosure-safe released week is required before this comparison can be shown."
      )
    );
    section.append(state);
    container.append(section);
    return;
  }

  section.append(node(
    "p",
    "snapshot-disclosure",
    `${formatUtc(comparison.period.startAt, { dateOnly: true })}–${formatUtc(comparison.period.endAt, { dateOnly: true })} · revision ${compact(comparison.snapshotRevision)}. This is not an average, percentile, bill, or provider allowance. A rounded-down public total can be lower than your own clipped value.`
  ));
  const activeCells = comparison.cells.filter((cell) => cell.participantHasActivity);
  if (!activeCells.length) {
    const state = node("div", "not-testable-state");
    state.append(
      node("strong", "", "No matched released cell"),
      node(
        "p",
        "",
        "Your accepted activity did not contribute to a provider/model cell released for this fixed week."
      )
    );
    section.append(state);
    container.append(section);
    return;
  }

  const wrap = node("div", "table-wrap comparison-table");
  const table = document.createElement("table");
  const caption = node(
    "caption",
    "sr-only",
    "Private clipped contribution compared with public rounded community total"
  );
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of [
    "Provider / model",
    "Metric",
    "Your clipped contribution",
    "Public rounded total",
    "Interpretation"
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  }
  thead.append(header);
  const tbody = document.createElement("tbody");
  for (const cell of activeCells) {
    for (const [metricName, label] of Object.entries(COMMUNITY_METRIC_LABELS)) {
      const metric = cell.metrics[metricName];
      const row = document.createElement("tr");
      const identity = document.createElement("th");
      identity.scope = "row";
      identity.textContent = `${cell.provider} · ${cell.modelId}`;
      row.append(identity, node("td", "", label));
      if (metric.status === "community_not_released") {
        row.append(
          node("td", "suppressed-value", "Not shown"),
          node("td", "suppressed-value", "Not released"),
          node("td", "", "Community support did not pass the fixed release rule.")
        );
      } else if (metric.status === "participant_component_unavailable") {
        row.append(
          node("td", "suppressed-value", "Not observed"),
          node("td", "", compact(metric.communityRoundedValue)),
          node("td", "", "Your source did not report this component.")
        );
      } else {
        row.append(
          node("td", "", compact(metric.participantClippedValue)),
          node("td", "", compact(metric.communityRoundedValue)),
          node(
            "td",
            "",
            metric.participantClippedValue > metric.communityRoundedValue
              ? "Public rounding makes a share calculation invalid."
              : "Same fixed week; no average or percentile is inferred."
          )
        );
      }
      tbody.append(row);
    }
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  section.append(wrap);
  container.append(section);
}

const CONTRIBUTION_STATUS_LABELS = Object.freeze({
  accepted: "Accepted",
  accepted_synthetic: "Accepted fixture",
  deleting: "Deletion in progress"
});

function renderContributionHistory(container, payload) {
  clear(container);
  const history = normalizeParticipantHistory(payload);
  if (!communitySession?.csrfToken) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const heading = node("div", "participant-detail-heading");
  const title = node("div");
  title.append(
    node("h4", "", "Accepted contribution history"),
    node(
      "p",
      "",
      "Each row is private to this participant and comes from canonical backend state."
    )
  );
  heading.append(title, node("span", "private-chip", "Private history"));
  container.append(heading);

  if (history.state !== "ready") {
    const unavailable = node("div", "not-testable-state");
    unavailable.append(
      node("strong", "", "History unavailable"),
      node(
        "p",
        "",
        history.reason === "unsupported_schema"
          ? "The service returned an unsupported participant-history contract."
          : history.reason === "invalid_contract"
            ? "The service response did not pass the browser's closed history contract."
            : "The participant-history service could not be reached."
      )
    );
    container.append(unavailable);
    return;
  }

  const disclosure = node("p", "history-disclosure");
  disclosure.textContent = history.items.length === 0
    ? "No accepted contribution batches remain."
    : `${compact(history.contributionCount)} accepted or deleting batch${history.contributionCount === 1 ? "" : "es"}. The current transport does not carry a reviewed client software version.`;
  container.append(disclosure);
  if (history.items.length === 0) return;

  const list = node("div", "history-list");
  history.items.forEach((item, index) => {
    const card = node("article", "history-card");
    const cardHeading = node("div", "history-card-heading");
    const label = node("div");
    label.append(
      node("strong", "", `Contribution ${history.items.length - index}`),
      node("small", "", `Received ${formatUtc(item.createdAt)}`)
    );
    cardHeading.append(
      label,
      node(
        "span",
        item.status === "deleting"
          ? "history-state history-state-deleting"
          : "history-state",
        CONTRIBUTION_STATUS_LABELS[item.status]
      )
    );
    card.append(cardHeading);

    const details = node("dl", "history-facts");
    const recordSummary = item.recordCounts === null
      ? "Fixture contract"
      : `${compact(item.recordCounts.accepted)} accepted · ${compact(item.recordCounts.deduplicated)} duplicate`;
    const pricingSummary = item.serverAccounting.verification === "server_repriced"
      ? `${formatApiMoney(item.serverAccounting.apiPriceEquivalentUsd)} API-price equivalent`
      : "Server repricing unavailable";
    const quarantineSummary = item.quarantine.state === "deleted"
      ? `Encrypted object deleted ${formatUtc(item.quarantine.deletedAt)}`
      : `Encrypted object scheduled for deletion after ${formatUtc(item.quarantine.scheduledDeletionAt)}`;
    for (const [term, description] of [
      ["Covered period", `${formatUtc(item.coveredAt.startAt)}–${formatUtc(item.coveredAt.endAt)}`],
      ["Records", recordSummary],
      ["Contract", `${item.transportSchemaVersion} · ${item.clientPlatform}`],
      ["Pricing", pricingSummary],
      ["Quarantine", quarantineSummary]
    ]) {
      const fact = node("div");
      fact.append(node("dt", "", term), node("dd", "", description));
      details.append(fact);
    }
    card.append(details);
    card.append(node(
      "p",
      "history-retention-note",
      "Deleting the encrypted quarantine object does not delete the canonical metadata used for your private results. Use the button below to delete this contribution from canonical results."
    ));
    if (item.status !== "deleting") {
      const remove = node("button", "button button-danger history-delete", "Delete this contribution");
      remove.type = "button";
      remove.dataset.contributionId = item.contributionId;
      card.append(remove);
    }
    list.append(card);
  });
  container.append(list);
}

function renderCommunitySnapshot(container, payload) {
  clear(container);
  const snapshot = normalizeCommunitySnapshot(payload);
  if (snapshot.state === "service_unavailable") {
    container.append(node("p", "", "The central service is unavailable. This is separate from whether a weekly snapshot exists."));
    return;
  }
  if (snapshot.state === "development_unsafe") {
    container.append(node("p", "", "Live cumulative community totals are development-only and are not displayed."));
    return;
  }
  if (snapshot.state === "unsupported_schema") {
    container.append(node("p", "", "The service returned an unsupported community-snapshot contract. No values were displayed."));
    return;
  }
  if (snapshot.state === "not_yet_published") {
    container.append(node("p", "", "No stable weekly snapshot is available yet."));
    return;
  }
  if (snapshot.state === "withdrawn") {
    container.append(node("p", "", "This weekly revision was withdrawn for privacy or quality reasons. A replacement revision may be pending."));
    return;
  }
  if (snapshot.state === "suppressed") {
    container.append(node("p", "", "This week did not pass the fixed privacy release policy. We do not disclose why or how close the cohort was."));
    return;
  }

  const heading = node("div", "snapshot-heading");
  heading.append(
    node("strong", "", `${formatUtc(snapshot.period.startAt, { dateOnly: true })} – ${formatUtc(snapshot.period.endAt, { dateOnly: true })}`),
    node("span", "", `Ingestion cutoff ${formatUtc(snapshot.ingestionCutoffAt)} · released ${formatUtc(snapshot.releasedAt)}`)
  );
  container.append(heading);
  container.append(node(
    "p",
    "snapshot-disclosure",
    `Each value is clipped per participant, independently support-gated at ${compact(snapshot.minimumIndependentParticipants)} or more participants, and rounded down. A sealed revision is never rewritten; deletion creates a replacement revision.`
  ));
  if (snapshot.state === "published_partial") {
    container.append(node("p", "snapshot-partial", "Some metrics were not released because their independent support was insufficient."));
  }

  const wrap = node("div", "table-wrap snapshot-table");
  const table = document.createElement("table");
  const caption = node("caption", "sr-only", "Privacy-safe delayed weekly community metrics");
  const thead = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of ["Provider / model", ...Object.values(COMMUNITY_METRIC_LABELS)]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  }
  thead.append(header);
  const tbody = document.createElement("tbody");
  for (const cell of snapshot.cells) {
    const row = document.createElement("tr");
    const identity = document.createElement("th");
    identity.scope = "row";
    identity.textContent = `${cell.provider} · ${cell.modelId}`;
    row.append(identity);
    for (const metricName of Object.keys(COMMUNITY_METRIC_LABELS)) {
      const td = document.createElement("td");
      const metric = cell.metrics[metricName];
      td.textContent = metric.status === "released" ? compact(metric.value) : "Not released";
      if (metric.status !== "released") td.className = "suppressed-value";
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  container.append(wrap);
}

async function loadCommunityResults() {
  const service = $("#service-state");
  const personal = $("#personal-result");
  const community = $("#community-result");
  const participantControls = $("#participant-controls");
  try {
    const [
      healthResult,
      personalResult,
      communityResult,
      devicesResult,
      profileResult
    ] = await Promise.allSettled([
      communityClient.health(),
      communitySession?.csrfToken ? communityClient.personalStats() : Promise.resolve(null),
      communityClient.communityStats(),
      communitySession?.csrfToken ? communityClient.devices() : Promise.resolve(null),
      communitySession?.csrfToken ? communityClient.participantProfile() : Promise.resolve(null)
    ]);
    const serviceReachable = healthResult.status === "fulfilled"
      || communityResult.status === "fulfilled"
      || (Boolean(communitySession?.csrfToken) && personalResult.status === "fulfilled");
    renderBackendHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
    service.textContent = serviceReachable ? "Service reachable" : "Service unavailable";
    service.className = serviceReachable ? "evidence-chip" : "evidence-chip neutral";
    renderPersonalStats(personal, personalResult.status === "fulfilled" ? personalResult.value : null);
    renderContributionHistory(
      $("#contribution-history"),
      profileResult.status === "fulfilled" ? profileResult.value : null
    );
    renderCommunitySnapshot(community, communityResult.status === "fulfilled" ? communityResult.value : null);
    renderDevices(devicesResult.status === "fulfilled" ? devicesResult.value : null);
    participantControls.hidden = !(communitySession?.csrfToken && personalResult.status === "fulfilled");
    const enrollmentMode = healthResult.status === "fulfilled" ? healthResult.value?.enrollmentMode : null;
    $("#invite-help").textContent = enrollmentMode === "invite_only"
      ? "Required for this invite-only service. It is used once and never stored by this page."
      : enrollmentMode === "disabled"
        ? "New enrollment is currently paused. Existing participants can still manage their data."
        : "Required only for an invite-only pilot. It is used once and never stored by this page.";
  } catch {
    renderBackendHealth(null);
    service.textContent = "Service unavailable";
    service.className = "evidence-chip neutral";
    participantControls.hidden = true;
    renderDevices(null);
    renderContributionHistory($("#contribution-history"), null);
  }
}

function renderDevices(payload) {
  const container = $("#device-list");
  const count = $("#device-count");
  const devices = Array.isArray(payload) ? payload : Array.isArray(payload?.devices) ? payload.devices : [];
  const safeDevices = devices.filter((device) => (
    typeof device?.deviceId === "string"
    && /^[0-9a-f-]{36}$/u.test(device.deviceId)
    && ["active", "revoked", "expired"].includes(device.state)
  )).slice(0, 20);
  count.textContent = safeDevices.length === 0
    ? "No devices"
    : `${safeDevices.length} device${safeDevices.length === 1 ? "" : "s"}`;
  count.className = safeDevices.some((device) => device.state === "active")
    ? "evidence-chip"
    : "evidence-chip neutral";
  clear(container);
  if (safeDevices.length === 0) {
    container.append(node("p", "", "No upload-only devices are paired."));
    return;
  }
  for (const device of safeDevices) {
    const row = node("div", "device-row");
    const detail = node("div");
    detail.append(
      node("strong", "", `Device …${device.deviceId.slice(-8)} · ${device.state}`),
      node(
        "small",
        "",
        `Paired ${formatUtc(device.createdAt ?? device.issuedAt)} · expires ${formatUtc(device.expiresAt)}`
      )
    );
    row.append(detail);
    if (device.state === "active") {
      const revoke = node("button", "button button-danger", "Revoke");
      revoke.type = "button";
      revoke.dataset.deviceId = device.deviceId;
      row.append(revoke);
    }
    container.append(row);
  }
}

async function createDevicePairing() {
  const status = $("#device-action-status");
  const button = $("#create-device-pairing");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Creating a short-lived upload-only pairing capability…";
  button.disabled = true;
  try {
    const pairing = await communityClient.createDevicePairing(
      communitySession?.consentVersion === "privacy-safe-telemetry-v0.2"
    );
    if (typeof pairing?.pairingCode !== "string") {
      throw new Error("The service did not return a pairing capability.");
    }
    showDevicePairingOnce(pairing.pairingCode);
    $("#device-consent").checked = false;
    status.textContent = `Pairing ready until ${formatUtc(pairing.expiresAt)}. It can be claimed once.`;
  } catch (error) {
    status.className = "participant-action-status error";
    status.textContent = safeApiError(error, "The device pairing could not be created.");
  } finally {
    button.disabled = !$("#device-consent").checked;
  }
}

async function revokeDevice(deviceId) {
  const status = $("#device-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Revoking this upload-only device and its pending authorizations…";
  try {
    await communityClient.revokeDevice(deviceId);
    showDevicePairingOnce(null);
    status.textContent = "Device revoked. It can no longer register uploads.";
    renderDevices(await communityClient.devices());
  } catch (error) {
    status.className = "participant-action-status error";
    status.textContent = safeApiError(error, "The device could not be revoked.");
  }
}

function renderBackendHealth(health) {
  const reachable = health?.status === "ok";
  const controls = health?.collectionControls;
  const collectionState = reachable
    && ["operational", "degraded", "contained"].includes(controls?.state)
    ? controls.state
    : null;
  const state = $("#backend-state");
  const stateLabels = {
    operational: "Backend ready",
    degraded: "Collection partially paused",
    contained: "Collection contained"
  };
  const stateLabel = reachable
    ? stateLabels[collectionState] ?? "Backend status incomplete"
    : "Backend unavailable";
  state.textContent = stateLabel;
  state.className = reachable && collectionState === "operational"
    ? "evidence-chip"
    : "evidence-chip neutral";
  const centralState = $("#central-state");
  centralState.replaceChildren(
    node("span", "state-dot"),
    document.createTextNode(stateLabel)
  );
  centralState.className = reachable && collectionState === "operational"
    ? "state-pill"
    : reachable
      ? "state-pill state-insufficient"
      : "state-pill state-offline";
  $("#backend-database").textContent = health?.checks?.database === "ok"
    ? "Connected"
    : "Unavailable";
  $("#backend-deletion-ledger").textContent = health?.checks?.deletionLedger === "ok"
    ? "Independent digest-only store reachable"
    : "Unavailable";
  $("#backend-storage").textContent = health?.checks?.encryptedObjectStore === "reachable"
    ? "Reachable"
    : "Unavailable";
  const lifecycleLabels = {
    never_run: "Awaiting first scheduled pass",
    running: "Lifecycle pass running",
    completed: health?.checks?.quarantineRetentionComplete === true
      && health?.checks?.restoreReplayComplete === true
      ? "Retention and restore replay current"
      : "Catching up; publication held",
    failed: "Lifecycle pass failed; operator review required"
  };
  $("#backend-lifecycle").textContent = lifecycleLabels[health?.checks?.lifecycle]
    ?? "Unavailable";
  $("#backend-collection-state").textContent = {
    operational: "Operational",
    degraded: "One or more intake stages paused",
    contained: "All collection and publication paused"
  }[collectionState] ?? "Unavailable";
  const enrollmentLabels = {
    local_open: "Open for local testing",
    invite_only: "Private invite pilot",
    disabled: "New enrollment paused"
  };
  $("#backend-enrollment").textContent = controls?.enrollment === false
    ? "Paused"
    : enrollmentLabels[health?.enrollmentMode] ?? "Unavailable";
  const controlLabel = (value) => value === true
    ? "Enabled"
    : value === false
      ? "Paused"
      : "Unavailable";
  $("#backend-upload-registration").textContent = controlLabel(
    controls?.uploadRegistration
  );
  $("#backend-processing").textContent = controlLabel(controls?.processing);
  $("#backend-publication").textContent = controlLabel(controls?.publication);
  $("#backend-participant-rights").textContent = reachable
    && health?.capabilities?.participantStats === true
    && health?.capabilities?.participantExport === true
    && health?.capabilities?.participantDeletion === true
    ? "View, export, and delete remain available"
    : "Unavailable";
  $("#backend-contract").textContent = health?.contracts?.acceptedContribution
    ?? "Unavailable";

  const accountContract = health?.contracts?.accountScopedContribution;
  $("#backend-contract-note").textContent =
    accountContract?.status === "local_preview_loopback_only"
      ? `${accountContract.schemaVersion} account-scoped ingest is active only on this loopback development server. It remains unauthorized for external participants.`
      : accountContract?.status === "implementation_disabled"
        ? `${accountContract.schemaVersion} account-scoped ingest is implemented and testable, but disabled on this HTTP route.`
        : "No account-scoped experimental contract was advertised by this backend.";
}

async function restoreCommunitySession() {
  try {
    const session = await communityClient.session();
    if (typeof session?.csrfToken !== "string") return;
    setCommunitySession({
      csrfToken: session.csrfToken,
      participantId: session.participantId ?? null,
      consentVersion: session.consentVersion ?? null
    });
  } catch {
    setCommunitySession(null);
  }
}

async function downloadParticipantExport() {
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Preparing your content-free participant export…";
  try {
    const payload = await communityClient.participantExport();
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "usage-monitor-participant-export.json";
    anchor.click();
    URL.revokeObjectURL(href);
    status.textContent = "Your content-free participant export is ready.";
  } catch {
    status.className = "participant-action-status error";
    status.textContent = "The participant export could not be prepared.";
  }
}

async function deleteParticipantData() {
  if (!window.confirm("Delete every contribution and personal statistic associated with this anonymous participant? This cannot be undone.")) return;
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Deleting your contributed data…";
  try {
    const receipt = await communityClient.deleteParticipant();
    setCommunitySession(null);
    showRecoveryCodeOnce(null);
    showDevicePairingOnce(null);
    $("#contribution-file").value = "";
    $("#contribution-consent").checked = false;
    $("#contribution-submit").disabled = true;
    $(".file-drop").classList.remove("selected");
    $("#file-help").textContent = "Privacy-safe JSON export · 1.25 MB browser validation limit";
    const uploadStatus = $("#upload-status");
    uploadStatus.hidden = false;
    uploadStatus.className = "upload-status";
    uploadStatus.textContent = `Deleted ${compact(receipt?.contributionsDeleted ?? 0)} contribution batches and the anonymous participant capability.`;
    status.textContent = "Your contributed data and anonymous participant capability were deleted.";
    $("#participant-controls").hidden = true;
    renderPersonalStats($("#personal-result"), null);
    renderContributionHistory($("#contribution-history"), null);
    await loadCommunityResults();
  } catch {
    status.className = "participant-action-status error";
    status.textContent = "The contributed data could not be deleted.";
  }
}

async function deleteSingleContribution(contributionId) {
  if (!window.confirm(
    "Delete this contribution from canonical private results and any current project-controlled aggregate? Other accepted contributions remain."
  )) return;
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Deleting this contribution and refreshing derived results…";
  try {
    await communityClient.deleteContribution(contributionId);
    status.textContent = "Contribution deleted. Private and community results have been refreshed.";
    await loadCommunityResults();
  } catch {
    status.className = "participant-action-status error";
    status.textContent = "The contribution could not be deleted.";
  }
}

async function recoverParticipant(event) {
  event.preventDefault();
  const input = $("#recover-code");
  const status = $("#recover-status");
  const recoveryCode = input.value.trim();
  input.value = "";
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Rotating the anonymous recovery code and prior access…";
  try {
    const recovered = await communityClient.recover(recoveryCode);
    if (typeof recovered?.csrfToken !== "string"
        || typeof recovered?.recoveryCode !== "string") {
      throw new Error("Recovery did not establish a replacement session.");
    }
    setCommunitySession({
      csrfToken: recovered.csrfToken,
      participantId: recovered.participantId ?? null,
      consentVersion: recovered.consentVersion ?? null
    });
    showRecoveryCodeOnce(recovered.recoveryCode);
    showDevicePairingOnce(null);
    status.textContent = "Access restored. Save the replacement recovery code shown above.";
    await loadCommunityResults();
  } catch {
    setCommunitySession(null);
    status.className = "participant-action-status error";
    status.textContent = "That recovery code was invalid, expired, or already used.";
  }
}

async function resetParticipantSecurity() {
  if (!window.confirm("Revoke every other session and unused upload authorization, and replace your recovery code?")) return;
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Revoking other access and rotating recovery…";
  try {
    const reset = await communityClient.securityReset();
    if (typeof reset?.csrfToken !== "string"
        || typeof reset?.recoveryCode !== "string") {
      throw new Error("Security reset did not return replacement authority.");
    }
    setCommunitySession({
      csrfToken: reset.csrfToken,
      participantId: reset.participantId ?? communitySession?.participantId ?? null,
      consentVersion: reset.consentVersion ?? communitySession?.consentVersion ?? null
    });
    showRecoveryCodeOnce(reset.recoveryCode);
    showDevicePairingOnce(null);
    renderDevices(null);
    status.textContent = "Other sessions and unused uploads were revoked. Save the new recovery code.";
  } catch {
    status.className = "participant-action-status error";
    status.textContent = "The security reset could not be completed.";
  }
}

async function logoutParticipant() {
  const status = $("#participant-action-status");
  status.hidden = false;
  status.className = "participant-action-status";
  status.textContent = "Signing out this browser session…";
  try {
    await communityClient.logout();
  } catch {
    // The local state is still cleared; the server also clears the cookie on
    // expired or already-revoked sessions.
  }
  setCommunitySession(null);
  showRecoveryCodeOnce(null);
  showDevicePairingOnce(null);
  renderDevices(null);
  $("#participant-controls").hidden = true;
  renderPersonalStats($("#personal-result"), null);
  renderContributionHistory($("#contribution-history"), null);
  status.textContent = "Signed out. Use the latest recovery code to return.";
}

$("#refresh-button").addEventListener("click", requestRefresh);
$("#prepare-contribution").addEventListener("click", prepareLocalContribution);
$("#demo-button").addEventListener("click", () => renderDashboard(demoDashboard()));
$("#sync-inspect").addEventListener("click", async () => {
  contributionSyncBusy = true;
  updateContributionSyncButtons();
  showContributionSyncAction("Inspecting locally verified metadata through loopback; no service request or upload is performed.");
  try {
    await refreshContributionSyncControls();
    const review = await localClient.contributionSyncExactReview();
    renderContributionSyncExactReview(review);
    showContributionSyncAction("Exact inspection complete. Review every retained field and value below; no service request or upload was performed.");
  } catch {
    showContributionSyncAction("The next contribution could not be inspected.", true);
  } finally {
    contributionSyncBusy = false;
    updateContributionSyncButtons();
  }
});
$("#sync-run-once").addEventListener("click", () => runContributionSyncAction("run"));
$("#sync-pause").addEventListener("click", () => runContributionSyncAction("pause"));
$("#sync-resume").addEventListener("click", () => runContributionSyncAction("resume"));
$("#window-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-hours]");
  if (!button || !dashboard) return;
  activeWindowHours = Number(button.dataset.hours);
  for (const control of $("#window-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  resetTimelineViewport();
  renderTimeline(dashboard);
  renderComparison(dashboard);
});
$("#range-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-days]");
  if (!button || !dashboard) return;
  activeTimelineRangeDays = Number(button.dataset.days);
  for (const control of $("#range-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  resetTimelineViewport();
  renderTimeline(dashboard);
  renderComparison(dashboard);
});
$("#timeline-zoom-in").addEventListener("click", () => {
  if (!dashboard) return;
  zoomTimeline(selectedTimelinePoints(dashboard).points, .74);
});
$("#timeline-zoom-out").addEventListener("click", () => {
  if (!dashboard) return;
  zoomTimeline(selectedTimelinePoints(dashboard).points, 1.35);
});
$("#timeline-pan-back").addEventListener("click", () => {
  if (!dashboard) return;
  panTimeline(selectedTimelinePoints(dashboard).points, -.2);
});
$("#timeline-pan-forward").addEventListener("click", () => {
  if (!dashboard) return;
  panTimeline(selectedTimelinePoints(dashboard).points, .2);
});
$("#timeline-reset-zoom").addEventListener("click", () => {
  resetTimelineViewport();
  if (dashboard) renderTimeline(dashboard);
});
$("#usage-group-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-group]");
  if (!button || !dashboard) return;
  activeUsageGrouping = button.dataset.group;
  for (const control of $("#usage-group-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  renderUsageTimeline(dashboard);
});
$("#accounting-period-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-period]");
  if (!button || !dashboard) return;
  activeAccountingPeriod = button.dataset.period;
  for (const control of $("#accounting-period-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  renderAccounting(dashboard);
});

$("#contribution-file").addEventListener("change", async () => {
  contributionSelectionRevision += 1;
  const selectionRevision = contributionSelectionRevision;
  const file = $("#contribution-file").files[0];
  const drop = $(".file-drop");
  drop.classList.toggle("selected", Boolean(file));
  $("#file-help").textContent = file ? `${file.name} · ${compact(file.size)} bytes` : "Privacy-safe JSON export · 1.25 MB browser validation limit";
  resetSelectedContributionInspection();
  $("#contribution-consent").checked = false;
  $("#contribution-consent-title").textContent =
    "I reviewed this as a privacy-safe Usage Monitor export.";
  $("#contribution-consent-detail").textContent =
    "Uploading is optional and can be tested against a local backend.";
  if (file) {
    try {
      const payload = await parseSafeExport(file);
      if (
        selectionRevision !== contributionSelectionRevision
        || $("#contribution-file").files[0] !== file
      ) return;
      renderSelectedContributionInspection(file, payload);
      if (payload?.schemaVersion === "telemetry-contribution-v0.2") {
        $("#contribution-consent-title").textContent =
          "I consent to upload participant-scoped pseudonymous account tracks.";
        $("#contribution-consent-detail").textContent =
          "They link usage and quota rows only within this anonymous participant for private calibration; they are never published in community output and are deleted with the participant.";
      }
    } catch (error) {
      if (
        selectionRevision !== contributionSelectionRevision
        || $("#contribution-file").files[0] !== file
      ) return;
      renderSelectedContributionError(error);
    }
  }
  $("#contribution-submit").disabled = true;
});
$("#contribution-consent").addEventListener("change", () => {
  $("#contribution-submit").disabled = !(
    selectedContributionValidated
    && $("#contribution-consent").checked
    && $("#contribution-file").files.length
  );
});
$("#contribution-form").addEventListener("submit", submitContribution);
$("#recover-form").addEventListener("submit", recoverParticipant);
$("#acknowledge-recovery").addEventListener("click", () => showRecoveryCodeOnce(null));
$("#device-consent").addEventListener("change", () => {
  $("#create-device-pairing").disabled = !$("#device-consent").checked;
});
$("#create-device-pairing").addEventListener("click", createDevicePairing);
$("#acknowledge-device-pairing").addEventListener("click", () => showDevicePairingOnce(null));
$("#device-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-device-id]");
  if (button?.dataset.deviceId) revokeDevice(button.dataset.deviceId);
});
$("#download-participant").addEventListener("click", downloadParticipantExport);
$("#security-reset").addEventListener("click", resetParticipantSecurity);
$("#logout-participant").addEventListener("click", logoutParticipant);
$("#delete-participant").addEventListener("click", deleteParticipantData);
$("#contribution-history").addEventListener("click", (event) => {
  const button = event.target.closest("[data-contribution-id]");
  if (button?.dataset.contributionId) {
    deleteSingleContribution(button.dataset.contributionId);
  }
});

const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  for (const link of document.querySelectorAll("[data-nav]")) {
    const active = link.dataset.nav === visible.target.id;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}, { rootMargin: "-25% 0px -65% 0px", threshold: [0, .2, .7] });
for (const section of document.querySelectorAll(".dashboard-section, [data-nav-target]")) observer.observe(section);

function syncNavigationFromHash() {
  const id = window.location.hash.slice(1);
  if (!id) return;
  for (const link of document.querySelectorAll("[data-nav]")) {
    const active = link.dataset.nav === id;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", syncNavigationFromHash);
syncNavigationFromHash();

loadLocalDashboard();
restoreCommunitySession().finally(loadCommunityResults);
