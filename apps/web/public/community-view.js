// The community aggregate view. It needs no local companion, so the public
// website can show it honestly. The public site renders the day-partitioned
// daily series only: the legacy sealed weekly snapshot presentation was
// retired in favour of daily revisions, so no snapshot render path lives here
// any more.

import { normalizeCommunityDailySeries } from "./community-data.js";
import {
  compact,
  createDomHelpers,
  dateTimeFormatter,
  formatAge,
  formatLocal,
  numberFormatter,
} from "./ui-format.js";
import { translate, translatePlural } from "./localization.js";

/**
 * Fixed copy for the day-partitioned series states. No degraded state may
 * leave an empty panel that reads like a loading spinner that never ends.
 */
export const COMMUNITY_DAILY_STATE_COPY = Object.freeze({
  service_unavailable:
    "Daily community activity is temporarily unavailable. This does not tell us whether any day has been published.",
  unsupported_schema:
    "The daily community series cannot be displayed safely with this version of TiboTattle.",
  none_published:
    "No daily community activity has been published for the year window yet.",
});

const COMMUNITY_DAILY_STATE_KEYS = Object.freeze({
  service_unavailable: "community.daily.state.serviceUnavailable",
  unsupported_schema: "community.daily.state.unsupportedSchema",
  none_published: "community.daily.state.nonePublished",
});

const COMMUNITY_DAILY_COLUMN_KEYS = Object.freeze([
  "community.daily.day",
  "community.metric.usageEvents",
  "community.daily.quotaObservations",
  "community.daily.contributingDevices",
  "community.metric.combinedOutput",
  "community.released",
]);
// Header indexes that carry numbers; they right-align with tabular digits so
// magnitudes line up down a column.
const COMMUNITY_DAILY_NUMERIC_COLUMNS = Object.freeze(new Set([1, 2, 3, 4]));

/**
 * One unit for a whole column, chosen from the column maximum: mixing 44 and
 * 1.4K in the same column reads as a magnitude error, so every cell shares
 * the scale even when a single row would round to 0.0.
 */
export function communityDailyColumnFormatter(values) {
  const maximum = Math.max(0, ...values);
  if (maximum >= 1_000_000) {
    return (value) => `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (maximum >= 1_000) {
    return (value) => `${(value / 1_000).toFixed(1)}K`;
  }
  return (value) => String(value);
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export const COMMUNITY_DAILY_CHART_WIDTH = 900;
export const COMMUNITY_DAILY_CHART_HEIGHT = 300;
// Beyond this span, per-day tick labels would repeat month names ambiguously,
// so ticks switch to month-plus-year labels.
const MONTH_TICK_SPAN_DAYS = 150;

function communityDayStartMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * A round tick step (1/2/2.5/5 × 10^n) that covers the value range with the
 * requested number of divisions. Same shape as the dashboard's chart axes so
 * public and in-app charts agree on what a readable axis is.
 */
function chartTickStep(span, target = 4) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 2.5 ? 2.5
        : normalized <= 5 ? 5
          : 10;
  return factor * magnitude;
}

function valueAxis(maximum, plotTop, plotBottom) {
  const top = Math.max(1, maximum);
  const step = chartTickStep(top);
  const axisTop = Math.ceil(top / step) * step;
  const y = (value) => plotBottom
    - (value / axisTop) * (plotBottom - plotTop);
  const ticks = [];
  for (let value = 0; value <= axisTop + step / 100; value += step) {
    ticks.push({ value, y: y(value) });
  }
  return { axisTop, y, ticks };
}

/**
 * Pure geometry for the public daily-series chart: usage events as bars on
 * the left axis and combined output tokens as a line on the right axis.
 *
 * The mapping is honest about the series' shape:
 * - the x scale covers the published days only, positioned by real date, so a
 *   day that was never published is a gap, not a zero;
 * - the output line breaks at any gap wider than one day instead of bridging
 *   days that do not exist;
 * - one or two published days mark the series as `sparse`, which the renderer
 *   turns into visible dots plus a still-filling note;
 * - a year of days thins the date ticks to a handful of month labels instead
 *   of stacking hundreds of unreadable ones.
 *
 * Returns null for every non-published state. The model carries no formatted
 * strings: days stay ISO day strings and values stay numbers, so locale
 * changes never invalidate it.
 */
export function buildCommunityDailyChartModel(series, {
  width = COMMUNITY_DAILY_CHART_WIDTH,
  height = COMMUNITY_DAILY_CHART_HEIGHT,
  maximumDayTicks = 6,
} = {}) {
  if (!series || series.state !== "published" || series.days.length === 0) {
    return null;
  }
  const margin = { top: 16, right: 64, bottom: 32, left: 56 };
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const days = series.days.map((day) => ({
    day: day.day,
    atMs: communityDayStartMs(day.day),
    usageEvents: day.totals.usageEvents,
    outputCombinedTokens: day.totals.outputCombinedTokens,
  }));
  const startMs = days[0].atMs;
  const endMs = days[days.length - 1].atMs;
  const spanDays = Math.round((endMs - startMs) / MILLISECONDS_PER_DAY) + 1;
  const plotWidth = width - margin.left - margin.right;
  const slotWidth = plotWidth / spanDays;
  const barWidth = Math.max(1.5, Math.min(22, slotWidth * 0.62));
  const usableWidth = Math.max(1, plotWidth - barWidth);
  const x = (atMs) => (spanDays === 1
    ? margin.left + plotWidth / 2
    : margin.left + barWidth / 2 + ((atMs - startMs) / (endMs - startMs)) * usableWidth);

  const events = valueAxis(
    Math.max(...days.map((day) => day.usageEvents)),
    plotTop,
    plotBottom,
  );
  const output = valueAxis(
    Math.max(...days.map((day) => day.outputCombinedTokens)),
    plotTop,
    plotBottom,
  );

  const bars = days.map((day) => {
    const center = x(day.atMs);
    const top = events.y(day.usageEvents);
    return {
      day: day.day,
      usageEvents: day.usageEvents,
      x: center - barWidth / 2,
      y: top,
      width: barWidth,
      height: plotBottom - top,
    };
  });

  const outputPoints = days.map((day) => ({
    day: day.day,
    outputCombinedTokens: day.outputCombinedTokens,
    x: x(day.atMs),
    y: output.y(day.outputCombinedTokens),
  }));
  // Split the line at unpublished days: consecutive points stay connected only
  // when their days are adjacent on the calendar.
  const outputSegments = [];
  let segment = [outputPoints[0]];
  for (let index = 1; index < days.length; index += 1) {
    const gapDays = Math.round(
      (days[index].atMs - days[index - 1].atMs) / MILLISECONDS_PER_DAY,
    );
    if (gapDays > 1) {
      outputSegments.push(segment);
      segment = [];
    }
    segment.push(outputPoints[index]);
  }
  outputSegments.push(segment);

  // Date ticks: every published day while they fit, then evenly spaced
  // calendar positions across the span, labelled by month once the span makes
  // repeated day labels ambiguous.
  const tickLabelStyle = spanDays > MONTH_TICK_SPAN_DAYS ? "month" : "day";
  let dayTicks;
  if (days.length <= maximumDayTicks) {
    dayTicks = days.map((day) => ({ day: day.day, x: x(day.atMs) }));
  } else {
    const count = Math.max(2, maximumDayTicks);
    dayTicks = [];
    for (let index = 0; index < count; index += 1) {
      const atMs = startMs
        + Math.round(((endMs - startMs) * index) / (count - 1) / MILLISECONDS_PER_DAY)
          * MILLISECONDS_PER_DAY;
      const day = new Date(atMs).toISOString().slice(0, 10);
      if (dayTicks.length === 0 || dayTicks[dayTicks.length - 1].day !== day) {
        dayTicks.push({ day, x: x(atMs) });
      }
    }
  }

  return {
    width,
    height,
    margin,
    plot: {
      top: plotTop,
      bottom: plotBottom,
      left: margin.left,
      right: width - margin.right,
    },
    spanDays,
    barWidth,
    sparse: days.length <= 2,
    bars,
    outputPoints,
    outputSegments,
    eventsTicks: events.ticks,
    outputTicks: output.ticks,
    dayTicks,
    tickLabelStyle,
  };
}

export const COMMUNITY_ALLOWANCE_CHART_WIDTH = 900;
export const COMMUNITY_ALLOWANCE_CHART_HEIGHT = 320;

/**
 * Pure geometry for the community allowance chart: the fitted seven-day
 * allowance in API-price-equivalent dollars, one point per published day that
 * carries at least one qualifying reset fit.
 *
 * Honesty rules, matching the daily-activity model's idiom:
 * - only days whose allowance block has a central estimate become points; a
 *   published day with `fitCount: 0` (or an old revision without the block)
 *   is a gap, never a zero-dollar reading;
 * - the central line breaks at calendar gaps wider than one day;
 * - the plausible-range band renders only where the day published one (three
 *   or more fits), split at the same gaps, so the band never bridges days
 *   that did not earn it;
 * - each point carries its fit count, and the dot radius grows with it, so a
 *   one-fit day visibly claims less than a twelve-fit day;
 * - `rangeDays` slices by calendar day, anchored at the latest published day
 *   in the series (not the viewer's clock), and `null` means the whole
 *   published series.
 *
 * Returns null when the series is not published or no day in the selected
 * range carries an estimate; the caller distinguishes those two states from
 * the series itself.
 */
export function buildCommunityAllowanceChartModel(series, {
  rangeDays = null,
  width = COMMUNITY_ALLOWANCE_CHART_WIDTH,
  height = COMMUNITY_ALLOWANCE_CHART_HEIGHT,
  maximumDayTicks = 6,
} = {}) {
  if (!series || series.state !== "published" || series.days.length === 0) {
    return null;
  }
  let candidates = series.days.filter((day) => (
    day.allowance !== null
    && day.allowance !== undefined
    && day.allowance.centralUsd !== null
  ));
  if (Number.isFinite(rangeDays) && rangeDays >= 1) {
    const anchor = series.days[series.days.length - 1].day;
    const cutoffMs = communityDayStartMs(anchor)
      - (rangeDays - 1) * MILLISECONDS_PER_DAY;
    candidates = candidates.filter((day) => (
      communityDayStartMs(day.day) >= cutoffMs
    ));
  }
  if (candidates.length === 0) return null;

  const margin = { top: 16, right: 24, bottom: 32, left: 64 };
  const plotTop = margin.top;
  const plotBottom = height - margin.bottom;
  const points = candidates.map((day) => ({
    day: day.day,
    atMs: communityDayStartMs(day.day),
    centralUsd: day.allowance.centralUsd,
    band80Usd: day.allowance.band80Usd,
    fitCount: day.allowance.fitCount,
    participantCount: day.allowance.participantCount,
  }));
  const startMs = points[0].atMs;
  const endMs = points[points.length - 1].atMs;
  const spanDays = Math.round((endMs - startMs) / MILLISECONDS_PER_DAY) + 1;
  const plotWidth = width - margin.left - margin.right;
  const x = (atMs) => (spanDays === 1
    ? margin.left + plotWidth / 2
    : margin.left + ((atMs - startMs) / (endMs - startMs)) * plotWidth);

  const dollars = valueAxis(
    Math.max(...points.map((point) => (
      point.band80Usd === null ? point.centralUsd : point.band80Usd.upperUsd
    ))),
    plotTop,
    plotBottom,
  );

  const dots = points.map((point) => ({
    day: point.day,
    centralUsd: point.centralUsd,
    band80Usd: point.band80Usd,
    fitCount: point.fitCount,
    participantCount: point.participantCount,
    x: x(point.atMs),
    y: dollars.y(point.centralUsd),
    // One fit reads as a small mark; the radius grows sublinearly so a busy
    // day emphasizes without swallowing the line.
    radius: Math.min(7, 2.6 + Math.sqrt(point.fitCount)),
  }));

  // Split both the central line and the band at unpublished or estimate-free
  // days: connected only across calendar-adjacent points.
  const centralSegments = [];
  let central = [dots[0]];
  for (let index = 1; index < points.length; index += 1) {
    const gapDays = Math.round(
      (points[index].atMs - points[index - 1].atMs) / MILLISECONDS_PER_DAY,
    );
    if (gapDays > 1) {
      centralSegments.push(central);
      central = [];
    }
    central.push(dots[index]);
  }
  centralSegments.push(central);

  const bandSegments = [];
  for (const segment of centralSegments) {
    let band = [];
    for (const dot of segment) {
      if (dot.band80Usd === null) {
        if (band.length > 0) bandSegments.push(band);
        band = [];
        continue;
      }
      band.push({
        day: dot.day,
        x: dot.x,
        upperY: dollars.y(dot.band80Usd.upperUsd),
        lowerY: dollars.y(dot.band80Usd.lowerUsd),
      });
    }
    if (band.length > 0) bandSegments.push(band);
  }

  const tickLabelStyle = spanDays > MONTH_TICK_SPAN_DAYS ? "month" : "day";
  let dayTicks;
  if (points.length <= maximumDayTicks) {
    dayTicks = points.map((point) => ({ day: point.day, x: x(point.atMs) }));
  } else {
    const count = Math.max(2, maximumDayTicks);
    dayTicks = [];
    for (let index = 0; index < count; index += 1) {
      const atMs = startMs
        + Math.round(((endMs - startMs) * index) / (count - 1) / MILLISECONDS_PER_DAY)
          * MILLISECONDS_PER_DAY;
      const day = new Date(atMs).toISOString().slice(0, 10);
      if (dayTicks.length === 0 || dayTicks[dayTicks.length - 1].day !== day) {
        dayTicks.push({ day, x: x(atMs) });
      }
    }
  }

  return {
    width,
    height,
    margin,
    plot: {
      top: plotTop,
      bottom: plotBottom,
      left: margin.left,
      right: width - margin.right,
    },
    spanDays,
    sparse: points.length <= 2,
    dots,
    centralSegments,
    bandSegments,
    dollarTicks: dollars.ticks,
    dayTicks,
    tickLabelStyle,
    latest: dots[dots.length - 1],
  };
}

function svgNode(documentRef, tag, className = "", attributes = {}) {
  const element = documentRef.createElementNS(SVG_NAMESPACE, tag);
  // SVG elements take their class through setAttribute: assigning
  // `.className` writes to an SVGAnimatedString and is silently ignored.
  if (className) element.setAttribute("class", className);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function tickLabelFormatter(style) {
  // Published days are UTC calendar days. Formatting them in the viewer's
  // zone would shift "2026-08-07" to Aug 6 west of Greenwich, so the labels
  // pin UTC while still following the selected formatting locale.
  return dateTimeFormatter(style === "month"
    ? { timeZone: "UTC", month: "short", year: "numeric" }
    : { timeZone: "UTC", month: "short", day: "numeric" });
}

/**
 * Renders the inline SVG daily chart. The site is CSP-strict and
 * dependency-free, so this is plain SVG construction: bars for usage events
 * on the left axis, a line for combined output tokens on the right axis, and
 * dots plus a note while the series is still one or two days long.
 */
function appendCommunityDailyChart({ documentRef, container, series, t }) {
  const model = buildCommunityDailyChartModel(series);
  if (model === null) return;
  const { node } = createDomHelpers(documentRef);

  const figure = node("div", "community-daily-chart");
  const legend = node("p", "community-daily-legend");
  for (const [swatchClass, labelKey] of [
    ["daily-legend-swatch events", "community.metric.usageEvents"],
    ["daily-legend-swatch output", "community.metric.combinedOutput"],
  ]) {
    const item = node("span");
    const swatch = node("span", swatchClass);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, node("span", "", t(labelKey)));
    legend.append(item);
  }
  figure.append(legend);

  const svg = svgNode(documentRef, "svg", "", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    role: "img",
    "aria-label": t("community.daily.chartLabel"),
    "aria-description": t("community.daily.chartDescription"),
  });
  svg.setAttribute("data-i18n-skip", "");

  for (const tick of model.eventsTicks) {
    svg.append(svgNode(documentRef, "line", "chart-grid", {
      x1: model.plot.left,
      x2: model.plot.right,
      y1: tick.y,
      y2: tick.y,
    }));
    const label = svgNode(documentRef, "text", "chart-axis-label daily-axis-events", {
      x: model.plot.left - 8,
      y: tick.y + 3,
      "text-anchor": "end",
    });
    label.textContent = compact(tick.value);
    svg.append(label);
  }
  for (const tick of model.outputTicks) {
    const label = svgNode(documentRef, "text", "chart-axis-label daily-axis-output", {
      x: model.plot.right + 8,
      y: tick.y + 3,
      "text-anchor": "start",
    });
    label.textContent = compact(tick.value);
    svg.append(label);
  }
  const formatTick = tickLabelFormatter(model.tickLabelStyle);
  for (const tick of model.dayTicks) {
    const label = svgNode(documentRef, "text", "chart-axis-label", {
      x: tick.x,
      y: model.height - 10,
      "text-anchor": "middle",
    });
    label.textContent = formatTick.format(new Date(communityDayStartMs(tick.day)));
    svg.append(label);
  }

  for (const bar of model.bars) {
    svg.append(svgNode(documentRef, "rect", "daily-events-bar", {
      x: bar.x,
      y: bar.y,
      width: bar.width,
      height: Math.max(0, bar.height),
    }));
  }

  for (const segment of model.outputSegments) {
    if (segment.length >= 2) {
      svg.append(svgNode(documentRef, "polyline", "daily-output-line", {
        points: segment
          .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
          .join(" "),
      }));
    }
    // An isolated day has no line to sit on, and a one-or-two-day series is
    // easier to read as marked points; both get explicit dots.
    if (segment.length === 1 || model.sparse) {
      for (const point of segment) {
        svg.append(svgNode(documentRef, "circle", "daily-output-dot", {
          cx: point.x,
          cy: point.y,
          r: 3.4,
        }));
      }
    }
  }

  figure.append(svg);
  if (model.sparse) {
    figure.append(node("p", "annotation", t("community.daily.seriesFilling")));
  }
  container.append(figure);
}

/**
 * Renders the day-partitioned community series: the latest published
 * revision per day inside the requested year window. Revision freshness is
 * first-class — every row carries its revision and release time, and the
 * headline names the latest published day's revision and age — because a day
 * here is never sealed: late contributions replace it with a new revision.
 */
export function renderCommunityDailySeries({
  documentRef,
  container,
  stateNode = null,
  payload,
  now = Date.now(),
}) {
  const { clear, node } = createDomHelpers(documentRef);
  const locale = documentRef?.documentElement?.lang ?? "en-US";
  const t = (key, values = {}) => translate(key, values, locale);
  clear(container);
  const series = normalizeCommunityDailySeries(payload);
  if (stateNode) {
    stateNode.textContent = series.state === "published"
      ? t("community.daily.seriesAvailable")
      : t("community.daily.seriesUnavailable");
    stateNode.className = series.state === "published"
      ? "evidence-chip"
      : "evidence-chip neutral";
  }
  if (series.state !== "published") {
    container.append(node("p", "", t(COMMUNITY_DAILY_STATE_KEYS[series.state])));
    return series.state;
  }

  const latest = series.days[series.days.length - 1];
  const quality = node("dl", "snapshot-quality-grid");
  for (const [term, value] of [
    [t("community.daily.latestDay"), formatLocal(latest.day, { dateOnly: true })],
    [t("community.daily.revision"), `r${latest.revision}`],
    [t("community.released"), formatLocal(latest.releasedAt)],
    [
      t("community.daily.revisionAge"),
      formatAge(Math.max(0, (now - Date.parse(latest.releasedAt)) / 1_000)),
    ],
    [t("community.daily.publishedDays"), compact(series.days.length)],
  ]) {
    const item = node("div");
    item.append(node("dt", "", term), node("dd", "", value));
    quality.append(item);
  }
  container.append(quality);
  container.append(node(
    "p",
    "snapshot-disclosure",
    t("community.daily.recomputeNote"),
  ));

  appendCommunityDailyChart({ documentRef, container, series, t });

  const breakdown = node("details", "journey-disclosure snapshot-breakdown");
  const summary = node("summary");
  summary.append(node(
    "span",
    "",
    t("community.daily.detailedDays", { count: compact(series.days.length) }),
  ));
  breakdown.append(summary);
  const wrap = node("div", "table-wrap snapshot-table");
  const table = documentRef.createElement("table");
  const caption = node("caption", "sr-only", t("community.daily.metricsCaption"));
  const thead = documentRef.createElement("thead");
  const header = documentRef.createElement("tr");
  COMMUNITY_DAILY_COLUMN_KEYS.forEach((key, index) => {
    const th = documentRef.createElement("th");
    th.scope = "col";
    if (COMMUNITY_DAILY_NUMERIC_COLUMNS.has(index)) {
      th.className = "numeric";
    }
    th.textContent = t(key);
    header.append(th);
  });
  thead.append(header);
  const tbody = documentRef.createElement("tbody");
  const formatColumn = (values) => communityDailyColumnFormatter(values);
  const formatUsageEvents = formatColumn(
    series.days.map((day) => day.totals.usageEvents),
  );
  const formatQuotaObservations = formatColumn(
    series.days.map((day) => day.totals.quotaObservations),
  );
  const formatContributingDevices = formatColumn(
    series.days.map((day) => day.totals.contributingDevices),
  );
  const formatOutputTokens = formatColumn(
    series.days.map((day) => day.totals.outputCombinedTokens),
  );
  // Most recent day first: freshness is what a reader scans for.
  for (const day of [...series.days].reverse()) {
    const row = documentRef.createElement("tr");
    const identity = documentRef.createElement("th");
    identity.scope = "row";
    identity.setAttribute("data-i18n-skip", "");
    identity.textContent = day.day;
    row.append(identity);
    const cells = [
      formatUsageEvents(day.totals.usageEvents),
      formatQuotaObservations(day.totals.quotaObservations),
      formatContributingDevices(day.totals.contributingDevices),
      formatOutputTokens(day.totals.outputCombinedTokens),
      formatLocal(day.releasedAt),
    ];
    cells.forEach((value, index) => {
      const td = documentRef.createElement("td");
      if (COMMUNITY_DAILY_NUMERIC_COLUMNS.has(index + 1)) {
        td.className = "numeric";
      }
      // Narrow layouts stack each row into a labelled card; the label is the
      // translated column header carried on the cell itself.
      td.setAttribute(
        "data-label",
        t(COMMUNITY_DAILY_COLUMN_KEYS[index + 1] ?? ""),
      );
      td.textContent = value;
      row.append(td);
    });
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  breakdown.append(wrap);
  container.append(breakdown);
  return series.state;
}

const COMMUNITY_ALLOWANCE_STATE_KEYS = Object.freeze({
  service_unavailable: "community.allowance.state.serviceUnavailable",
  unsupported_schema: "community.allowance.state.unsupportedSchema",
  none_published: "community.allowance.state.nonePublished",
});

function usdFormatter(maximumFractionDigits = 0) {
  return numberFormatter({
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

/**
 * Renders the inline SVG allowance chart: the shaded plausible-range band
 * where days published one, the central line, and per-day dots sized by fit
 * count. Same CSP-strict plain-SVG construction as the daily chart.
 */
function appendCommunityAllowanceChart({ documentRef, container, model, t }) {
  const { node } = createDomHelpers(documentRef);
  const dollars = usdFormatter();

  const figure = node("div", "community-daily-chart community-allowance-chart");
  const legend = node("p", "community-daily-legend");
  for (const [swatchClass, labelKey] of [
    ["daily-legend-swatch allowance-central", "community.allowance.legendCentral"],
    ["daily-legend-swatch allowance-band", "community.allowance.legendBand"],
    ["daily-legend-swatch allowance-dot", "community.allowance.legendDots"],
  ]) {
    const item = node("span");
    const swatch = node("span", swatchClass);
    swatch.setAttribute("aria-hidden", "true");
    item.append(swatch, node("span", "", t(labelKey)));
    legend.append(item);
  }
  figure.append(legend);

  const svg = svgNode(documentRef, "svg", "", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    role: "img",
    "aria-label": t("community.allowance.chartLabel"),
    "aria-description": t("community.allowance.chartDescription"),
  });
  svg.setAttribute("data-i18n-skip", "");

  for (const tick of model.dollarTicks) {
    svg.append(svgNode(documentRef, "line", "chart-grid", {
      x1: model.plot.left,
      x2: model.plot.right,
      y1: tick.y,
      y2: tick.y,
    }));
    const label = svgNode(documentRef, "text", "chart-axis-label", {
      x: model.plot.left - 8,
      y: tick.y + 3,
      "text-anchor": "end",
    });
    label.textContent = dollars.format(tick.value);
    svg.append(label);
  }
  const formatTick = tickLabelFormatter(model.tickLabelStyle);
  for (const tick of model.dayTicks) {
    const label = svgNode(documentRef, "text", "chart-axis-label", {
      x: tick.x,
      y: model.height - 10,
      "text-anchor": "middle",
    });
    label.textContent = formatTick.format(new Date(communityDayStartMs(tick.day)));
    svg.append(label);
  }

  // The band renders under the central line. A single banded day has no area
  // to shade, so it degrades to a vertical range mark at that day.
  for (const band of model.bandSegments) {
    if (band.length >= 2) {
      const forward = band
        .map((point) => `${point.x.toFixed(1)},${point.upperY.toFixed(1)}`);
      const backward = [...band].reverse()
        .map((point) => `${point.x.toFixed(1)},${point.lowerY.toFixed(1)}`);
      svg.append(svgNode(documentRef, "path", "allowance-band-area", {
        d: `M${[...forward, ...backward].join(" L")} Z`,
      }));
    } else {
      svg.append(svgNode(documentRef, "line", "allowance-band-mark", {
        x1: band[0].x,
        x2: band[0].x,
        y1: band[0].upperY,
        y2: band[0].lowerY,
      }));
    }
  }

  for (const segment of model.centralSegments) {
    if (segment.length >= 2) {
      svg.append(svgNode(documentRef, "polyline", "allowance-central-line", {
        points: segment
          .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
          .join(" "),
      }));
    }
  }

  for (const dot of model.dots) {
    const circle = svgNode(documentRef, "circle", "allowance-fit-dot", {
      cx: dot.x,
      cy: dot.y,
      r: dot.radius,
    });
    const title = svgNode(documentRef, "title");
    title.textContent = `${dot.day}: ${dollars.format(dot.centralUsd)} — ${
      translatePlural(
        "community.allowance.fitCount",
        dot.fitCount,
        {},
        documentRef?.documentElement?.lang ?? "en-US",
      )
    }`;
    circle.append(title);
    svg.append(circle);
  }

  figure.append(svg);
  if (model.sparse) {
    figure.append(node("p", "annotation", t("community.allowance.sparseNote")));
  }
  container.append(figure);
}

/**
 * Renders the community allowance section: the headline dollar estimate, the
 * visible participant-and-fit caveat (never a tooltip), the chart, and the
 * method note. Range selection is a pure re-render over the already fetched
 * year window.
 *
 * Honest states, in order of specificity:
 * - a non-published series shows the fixed allowance state copy;
 * - a published series with no allowance-bearing day anywhere shows
 *   "estimates still accumulating" (the daily activity below proves data is
 *   arriving even while no fit qualifies yet);
 * - estimates that exist but all fall outside the selected range say so
 *   rather than showing an empty chart.
 */
export function renderCommunityAllowanceSection({
  documentRef,
  container,
  stateNode = null,
  payload,
  rangeDays = null,
}) {
  const { clear, node } = createDomHelpers(documentRef);
  const locale = documentRef?.documentElement?.lang ?? "en-US";
  const t = (key, values = {}) => translate(key, values, locale);
  const plural = (key, count) => translatePlural(key, count, {}, locale);
  clear(container);
  const series = normalizeCommunityDailySeries(payload);
  const setChip = (labelKey, published) => {
    if (!stateNode) return;
    stateNode.textContent = t(labelKey);
    stateNode.className = published ? "evidence-chip" : "evidence-chip neutral";
  };
  if (series.state !== "published") {
    setChip("community.allowance.unavailable", false);
    container.append(
      node("p", "", t(COMMUNITY_ALLOWANCE_STATE_KEYS[series.state])),
    );
    return series.state;
  }

  const model = buildCommunityAllowanceChartModel(series, { rangeDays });
  if (model === null) {
    const anyEstimate = series.days.some((day) => (
      day.allowance && day.allowance.centralUsd !== null
    ));
    setChip("community.allowance.accumulating", false);
    container.append(node(
      "p",
      "",
      t(anyEstimate
        ? "community.allowance.noneInRange"
        : "community.allowance.stillAccumulating"),
    ));
    return anyEstimate ? "no_estimates_in_range" : "estimates_accumulating";
  }

  setChip("community.allowance.available", true);
  const dollars = usdFormatter();
  const headline = node("div", "allowance-headline");
  const value = node("p", "allowance-headline-value");
  value.append(
    node("strong", "", dollars.format(model.latest.centralUsd)),
    node("span", "", t("community.allowance.perWindow")),
  );
  headline.append(value);
  if (model.latest.band80Usd !== null) {
    headline.append(node(
      "p",
      "allowance-headline-band",
      t("community.allowance.bandSentence", {
        lower: dollars.format(model.latest.band80Usd.lowerUsd),
        upper: dollars.format(model.latest.band80Usd.upperUsd),
      }),
    ));
  }
  // The participant count is a visible claim beside the number, never a
  // tooltip: "from 1 contributing account" is part of the estimate.
  headline.append(node(
    "p",
    "allowance-headline-caveat",
    t("community.allowance.caveatSentence", {
      latest: t("community.allowance.latestLabel", {
        day: formatLocal(model.latest.day, { dateOnly: true }),
      }),
      accounts: plural(
        "community.allowance.accountCount",
        model.latest.participantCount,
      ),
      fits: plural("community.allowance.fitCount", model.latest.fitCount),
    }),
  ));
  container.append(headline);

  appendCommunityAllowanceChart({ documentRef, container, model, t });

  container.append(node(
    "p",
    "snapshot-disclosure",
    t("community.allowance.methodNote"),
  ));
  return "published";
}
