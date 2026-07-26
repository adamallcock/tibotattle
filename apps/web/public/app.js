import {
  CommunityClient,
  LocalCompanionClient,
  demoDashboard,
  normalizeCommunitySnapshot,
  normalizeParticipantStats
} from "./data-client.js";
import {
  createTelemetryEnvelope,
  safeApiError,
  validateTelemetryContribution
} from "./lib.js";

const localClient = new LocalCompanionClient();
let communitySession = null;
const communityClient = new CommunityClient({
  getCsrfToken: () => communitySession?.csrfToken ?? null
});

let dashboard = null;
let activeWindowHours = 3;

const $ = (selector) => document.querySelector(selector);

function setCommunitySession(value) {
  communitySession = value;
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

function formatAge(value) {
  const seconds = finite(value);
  if (seconds === null) return "Unknown age";
  if (seconds < 90) return "Less than 2 minutes ago";
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hours ago`;
  return `${(seconds / 86400).toFixed(1)} days ago`;
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
    if (window.observedAt) card.append(node("p", "", `Observed ${formatUtc(window.observedAt)}`));
    container.append(card);
  }
}

function renderPricing(data) {
  const pricing = data.pricing;
  $("#cost-period").textContent = pricing.periodLabel;
  $("#cost-total").textContent = formatMoney(pricing.totalCostUsd, 2);
  $("#cost-coverage").textContent = pricing.coveragePercent === null
    ? "Price coverage is not available"
    : `${formatPercent(pricing.coveragePercent, 1)} of recorded usage priced · API tier: ${pricing.apiTier}`;
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
  const chip = $("#fit-chip");
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

function renderTimeline(data) {
  const points = groupRolling([...data.gradient.rollingHistory, ...data.gradient.rolling], activeWindowHours);
  $("#timeline-chart-title").textContent = `${activeWindowHours}-hour rolling quota change versus cost-implied change`;
  $("#timeline-chart-copy").textContent = "UTC timestamps · observed and API-cost-equivalent movement";
  const empty = $("#timeline-empty");
  const shell = $("#timeline-chart");
  if (!points.length) {
    shell.hidden = true;
    empty.hidden = false;
    empty.querySelector("strong").textContent = `No ${activeWindowHours}-hour series loaded`;
    empty.querySelector("p").textContent = "This is a missing-data state, not a zero-usage period.";
  } else {
    empty.hidden = true;
    shell.hidden = false;
    shell.replaceChildren(lineChart({
      points,
      series: [
        { key: "observed", className: "chart-line-observed", label: "Observed quota change" },
        { key: "expected", className: "chart-line-expected", label: "Expected from API cost" }
      ],
      yLabel: "Percentage points",
      title: `${activeWindowHours}-hour rolling quota movement`,
      description: "Observed quota movement compared with movement implied by priced token usage."
    }));
  }
  renderTimelineSummary(data, points);
  renderResiduals(data, points);
}

function renderTimelineSummary(data, points) {
  const summary = data.gradient.summary ?? {};
  const sensitivity = data.gradient.windowSensitivity.find((row) => finite(row.smoothing_hours ?? row.window_hours ?? row.hours) === activeWindowHours);
  const values = [
    ["Matched windows", compact(points.filter((row) => row.observed !== null && row.expected !== null).length)],
    ["Mean absolute error", formatPp(sensitivity?.mae_pp ?? sensitivity?.weighted_mae_pp ?? summary.mean_absolute_error_pp)],
    ["Peak residual", formatPp(summary.rolling_peak_absolute_residual_pp)],
    ["Coverage band", summary.points_within_80_band_fraction === undefined ? "—" : formatPercent(summary.points_within_80_band_fraction * 100)]
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
  const source = data.gradient.residual.length
    ? data.gradient.residual.map((row) => ({
        timestamp: row.timestamp ?? row.window_end_utc,
        observed: finite(row.observed_quota_change_pp),
        expected: finite(row.expected_quota_change_pp),
        residual: finite(row.residual_pp)
      }))
    : points.map((row) => ({ ...row, residual: row.observed === null || row.expected === null ? null : row.observed - row.expected }));
  return source.filter((row) => row.residual !== null && row.timestamp).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function renderResiduals(data, points) {
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
      includeZero: true
    }));
  }
  const table = $("#residual-table");
  clear(table);
  const largest = [...residuals].sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)).slice(0, 8);
  if (!largest.length) {
    const row = node("tr");
    const cell = node("td", "empty-cell", "No periods loaded.");
    cell.colSpan = 4;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const item of largest) {
    const row = node("tr");
    row.append(
      node("td", "", formatUtc(item.timestamp)),
      node("td", "", formatPp(item.observed)),
      node("td", "", formatPp(item.expected)),
      node("td", item.residual >= 0 ? "positive" : "negative", `${item.residual >= 0 ? "+" : ""}${formatPp(item.residual)}`)
    );
    table.append(row);
  }
}

function lineChart({ points, series, yLabel, title, description, includeZero = false, confidence = null }) {
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
  const x = (index) => margin.left + index / Math.max(1, points.length - 1) * (width - margin.left - margin.right);
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

  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1])];
  for (const index of labelIndexes) {
    const timestamp = points[index]?.timestamp ?? points[index]?.date;
    svg.append(svgText(x(index), height - 22, formatUtc(timestamp, { dateOnly: true }), "chart-axis-label", index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"));
  }
  const yAxisLabel = svgText(15, height / 2, yLabel, "chart-axis-label", "middle");
  yAxisLabel.setAttribute("transform", `rotate(-90 15 ${height / 2})`);
  svg.append(yAxisLabel);

  if (confidence) {
    const upper = points.map((point, index) => [x(index), y(finite(point[confidence.high], 0))]);
    const lower = points.map((point, index) => [x(index), y(finite(point[confidence.low], 0))]).reverse();
    const polygon = document.createElementNS(svg.namespaceURI, "polygon");
    polygon.setAttribute("points", [...upper, ...lower].map(([a, b]) => `${a},${b}`).join(" "));
    polygon.setAttribute("class", "chart-area-confidence");
    svg.append(polygon);
  }

  for (const item of series) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = finite(point[item.key]);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      } else segment.push([x(index), y(value)]);
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
  renderWeeklyTable(values);
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
    cell.colSpan = 5;
    row.append(cell);
    table.append(row);
    return;
  }
  for (const row of values.slice(-14).reverse()) {
    const transitions = finite(row.eligible_transitions, 0);
    const evidence = transitions < 25 ? "Low" : transitions < 75 ? "Moderate" : "Higher";
    const prior = finite(row.prior_prediction_mae_pp);
    const interpretation = prior === null
      ? "First estimate; no prior forecast"
      : prior < 3 ? "Prior forecast tracked closely" : prior < 7 ? "Meaningful model error" : "High-error period";
    const tr = node("tr");
    tr.append(
      node("td", "", formatUtc(row.timestamp, { dateOnly: true })),
      node("td", "", formatMoney(row.value)),
      node("td", "", row.low === null || row.high === null ? "—" : `${formatMoney(row.low)}–${formatMoney(row.high)}`),
      node("td", "", `${evidence} · ${transitions} transitions`),
      node("td", "", interpretation)
    );
    table.append(tr);
  }
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

  const issues = [...data.quality.opportunities, ...data.quality.blindSpots].slice(0, 10);
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
        node("p", "", item.evidence ?? item.description ?? item.action ?? "Additional evidence is required.")
      );
      issue.append(copy, node("span", "issue-priority", item.priority ?? "Open"));
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
}

async function loadLocalDashboard() {
  const button = $("#refresh-button");
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const [data, syncStatus] = await Promise.all([
      localClient.load(),
      localClient.contributionSyncStatus()
    ]);
    renderDashboard(data);
    renderContributionSyncStatus(syncStatus);
  } catch {
    dashboard = null;
    renderContributionSyncStatus(null);
    setGlobalState("offline");
    $("#latest-observation").textContent = "Companion unavailable";
    $("#data-source").textContent = "No real usage is displayed";
    showConnectionNotice({
      title: "The local companion is not available",
      copy: "Start the loopback server, then refresh. You can explore a clearly labeled demonstration in the meantime.",
      kind: "error",
      showDemo: true
    });
    renderDashboardSkeleton();
  } finally {
    button.disabled = false;
    button.textContent = "Refresh local data";
  }
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
  try {
    await localClient.refresh();
    let outcome = "running";
    for (let attempt = 0; attempt < 80 && outcome === "running"; attempt += 1) {
      button.textContent = attempt < 2 ? "Scanning local evidence…" : `Scanning… ${attempt + 1}s`;
      await new Promise((resolve) => setTimeout(resolve, 750));
      const status = await localClient.refreshStatus();
      outcome = status?.refresh?.status ?? "failed";
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
    validateTelemetryContribution(payload);
    return payload;
  });
}

async function ensureCommunitySession() {
  if (communitySession?.csrfToken) return communitySession;
  const inviteInput = $("#contribution-invite");
  const inviteCode = inviteInput.value.trim();
  let enrollment;
  try {
    enrollment = await communityClient.enroll(inviteCode || null);
  } finally {
    inviteInput.value = "";
  }
  if (typeof enrollment?.csrfToken !== "string") {
    throw new Error("The contribution service did not establish an anonymous web session.");
  }
  setCommunitySession({
    csrfToken: enrollment.csrfToken,
    participantId: enrollment.participantId ?? null
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
    await ensureCommunitySession();
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
    button.disabled = !($("#contribution-consent").checked && $("#contribution-file").files.length);
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

  renderParticipantQuotaMovement(container, stats.rollingQuotaMovement);
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
    container.append(node("p", "", "This weekly snapshot was withdrawn for privacy or quality reasons. It was not recomputed."));
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
    `Each value is clipped per participant, independently support-gated at ${compact(snapshot.minimumIndependentParticipants)} or more participants, rounded down, and never recalculated after publication.`
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
    const [healthResult, personalResult, communityResult, devicesResult] = await Promise.allSettled([
      communityClient.health(),
      communitySession?.csrfToken ? communityClient.personalStats() : Promise.resolve(null),
      communityClient.communityStats(),
      communitySession?.csrfToken ? communityClient.devices() : Promise.resolve(null)
    ]);
    const serviceReachable = healthResult.status === "fulfilled"
      || communityResult.status === "fulfilled"
      || (Boolean(communitySession?.csrfToken) && personalResult.status === "fulfilled");
    renderBackendHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
    service.textContent = serviceReachable ? "Service reachable" : "Service unavailable";
    service.className = serviceReachable ? "evidence-chip" : "evidence-chip neutral";
    renderPersonalStats(personal, personalResult.status === "fulfilled" ? personalResult.value : null);
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
    const pairing = await communityClient.createDevicePairing();
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
  const state = $("#backend-state");
  state.textContent = reachable ? "Backend ready" : "Backend unavailable";
  state.className = reachable ? "evidence-chip" : "evidence-chip neutral";
  $("#backend-database").textContent = health?.checks?.database === "ok"
    ? "Connected"
    : "Unavailable";
  $("#backend-storage").textContent = health?.checks?.encryptedObjectStore === "reachable"
    ? "Reachable"
    : "Unavailable";
  const enrollmentLabels = {
    local_open: "Open for local testing",
    invite_only: "Private invite pilot",
    disabled: "New enrollment paused"
  };
  $("#backend-enrollment").textContent = enrollmentLabels[health?.enrollmentMode]
    ?? "Unavailable";
  $("#backend-contract").textContent = health?.contracts?.acceptedContribution
    ?? "Unavailable";

  const accountContract = health?.contracts?.accountScopedContribution;
  $("#backend-contract-note").textContent = accountContract?.status === "implementation_disabled"
    ? `${accountContract.schemaVersion} account-scoped ingest is implemented and testable in the repository, but deliberately disabled on the HTTP route.`
    : "No account-scoped experimental contract was advertised by this backend.";
}

async function restoreCommunitySession() {
  try {
    const session = await communityClient.session();
    if (typeof session?.csrfToken !== "string") return;
    setCommunitySession({
      csrfToken: session.csrfToken,
      participantId: session.participantId ?? null
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
    $("#participant-controls").hidden = true;
    renderStats($("#personal-result"), null);
    await loadCommunityResults();
  } catch {
    status.className = "participant-action-status error";
    status.textContent = "The contributed data could not be deleted.";
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
      participantId: recovered.participantId ?? null
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
      participantId: reset.participantId ?? communitySession?.participantId ?? null
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
  renderStats($("#personal-result"), null);
  status.textContent = "Signed out. Use the latest recovery code to return.";
}

$("#refresh-button").addEventListener("click", requestRefresh);
$("#demo-button").addEventListener("click", () => renderDashboard(demoDashboard()));
$("#window-controls").addEventListener("click", (event) => {
  const button = event.target.closest("[data-hours]");
  if (!button || !dashboard) return;
  activeWindowHours = Number(button.dataset.hours);
  for (const control of $("#window-controls").querySelectorAll("button")) {
    const active = control === button;
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
  }
  renderTimeline(dashboard);
  renderComparison(dashboard);
});

$("#contribution-file").addEventListener("change", () => {
  const file = $("#contribution-file").files[0];
  const drop = $(".file-drop");
  drop.classList.toggle("selected", Boolean(file));
  $("#file-help").textContent = file ? `${file.name} · ${compact(file.size)} bytes` : "Privacy-safe JSON export · 1.25 MB browser validation limit";
  $("#contribution-submit").disabled = !($("#contribution-consent").checked && file);
});
$("#contribution-consent").addEventListener("change", () => {
  $("#contribution-submit").disabled = !($("#contribution-consent").checked && $("#contribution-file").files.length);
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

const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!visible) return;
  for (const link of document.querySelectorAll("[data-nav]")) {
    link.classList.toggle("active", link.dataset.nav === visible.target.id);
  }
}, { rootMargin: "-25% 0px -65% 0px", threshold: [0, .2, .7] });
for (const section of document.querySelectorAll(".dashboard-section")) observer.observe(section);

loadLocalDashboard();
restoreCommunitySession().finally(loadCommunityResults);
