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
} from "./ui-format.js";
import { translate } from "./localization.js";

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
  "community.daily.revision",
  "community.released",
]);

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
  for (const key of COMMUNITY_DAILY_COLUMN_KEYS) {
    const th = documentRef.createElement("th");
    th.scope = "col";
    th.textContent = t(key);
    header.append(th);
  }
  thead.append(header);
  const tbody = documentRef.createElement("tbody");
  // Most recent day first: freshness is what a reader scans for.
  for (const day of [...series.days].reverse()) {
    const row = documentRef.createElement("tr");
    const identity = documentRef.createElement("th");
    identity.scope = "row";
    identity.setAttribute("data-i18n-skip", "");
    identity.textContent = day.day;
    row.append(identity);
    for (const value of [
      compact(day.totals.usageEvents),
      compact(day.totals.quotaObservations),
      compact(day.totals.contributingDevices),
      compact(day.totals.outputCombinedTokens),
      `r${day.revision}`,
      formatLocal(day.releasedAt),
    ]) {
      const td = documentRef.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  breakdown.append(wrap);
  container.append(breakdown);
  return series.state;
}
