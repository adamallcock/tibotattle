import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { FAST_MODE_QUOTA_MULTIPLIERS } from "@app-usagemonitor/accounting";
import {
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../../config/product-brand.js";

import {
  DIAGNOSTIC_REFERENCE_PATTERN,
  DIAGNOSTIC_SURFACES,
  buildSyntheticFixture,
  bytesToBase64Url,
  contributionBatchAdmission,
  createDiagnosticReference,
  createLatestContributionReviewFence,
  diagnosticErrorCode,
  diagnosticReferenceSentence,
  diagnosticSurface,
  serviceRequestId,
  createQuotaTimelineLookup,
  createRefreshPollingBudget,
  HISTORY_INFORMATIONAL_GAP_MAX_SHARE,
  historyCoverageNoticeKind,
  LOCAL_REFRESH_POLLING_WINDOW_MS,
  createSyntheticEnvelope,
  createTelemetryEnvelope,
  detectDeviationPeriods,
  historyIndexContinuationDecision,
  contributionReviewBootstrapAction,
  contributionReviewPreparationPermitted,
  withContributionReviewDeadline,
  DEVIATION_DRIFT_THRESHOLD_PP,
  DEVIATION_MIN_DURATION_MS,
  DEVIATION_MERGE_GAP_MS,
  DEVIATION_MAX_PERIODS,
  parseJsonWithUniqueObjectKeys,
  isContributionReviewableQueueState,
  refreshAccountingStatus,
  refreshQuickResultStatus,
  refreshNeedsContinuation,
  ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
  ENVELOPE_SCHEMA_VERSION,
  safeApiError,
  safeFilename,
  TELEMETRY_ENVELOPE_SCHEMA_VERSION,
  validateAccountScopedTelemetryContribution,
  validateSyntheticFixture,
  validateTelemetryContribution
} from "../public/lib.js";
import {
  CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
  CODEX_PRIMARY_LIMIT_ID,
  CODEX_SPARK_LIMIT_ID,
  CODEX_WEEKLY_ALLOWANCE_MINUTES,
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION,
  CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
  formatQuotaWindowDuration,
  isValidQuotaWindowDuration,
  LOCAL_ONBOARDING_SCHEMA_VERSION,
  CommunityClient,
  demoDashboard,
  LocalCompanionClient,
  normalizeCommunitySnapshot,
  normalizeContributionSyncStatus,
  normalizeContributionSyncPreview,
  normalizeContributionSyncRun,
  normalizeIncrementalContributionSyncStatus,
  normalizeContributionDeletionReceipt,
  normalizeBackendReadiness,
  normalizeLocalContributionDevicePairing,
  normalizeLocalContributionPreparation,
  normalizeLocalOnboarding,
  normalizeDashboardPayload,
  normalizeParticipantCommunityComparison,
  normalizeParticipantHistory,
  normalizeParticipantStats,
  normalizeLocalContributionDeviceDisconnect,
  normalizeLocalContributionDeviceReset,
  normalizeLocalContributionDiagnostics,
  normalizeLocalDiagnosticNote,
  normalizeHostedSignInHandoff,
  normalizeWindowBreakdown,
  PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
  PARTICIPANT_PROFILE_SCHEMA_VERSION,
  PARTICIPANT_STATS_SCHEMA_VERSION,
  selectAllowancePlanPopulation,
  selectPrimaryCodexQuotaWindow,
  isPrimaryCodexQuotaWindow,
  isPrimaryCodexWeeklyQuotaWindow,
  SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS,
  SUPPORTED_PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSIONS
} from "../public/data-client.js";
import {
  adaptiveChartTickCount,
  classifyTimelineEvidence,
  finite,
  formatChartTimestamp,
  formatLocal,
  formatNumber,
  formatReportingTime,
  formatTimeZoneLabel,
  formatUtcCalendarDay,
  numberFormatter,
  REPORTING_TIME_ZONE,
  reportingCalendarParts,
  selectAvailableAccountingPeriod,
  USER_LOCALE,
} from "../public/ui-format.js";
import {
  SUPPORTED_LOCALES,
  WEB_MESSAGES,
  WEB_PLURAL_MESSAGES,
  translate,
  translateLegacyText,
  translatePlural,
} from "../public/localization.js";
import {
  TELEMETRY_PLAN_DISPLAY_NAMES,
  TELEMETRY_PLAN_TYPES,
} from "../public/telemetry-shared.generated.js";

class FakeSvgElement {
  constructor(tagName, renderedWidth = 0) {
    this.tagName = tagName;
    this.namespaceURI = "http://www.w3.org/2000/svg";
    this.renderedWidth = renderedWidth;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.textContent = "";
    this.resizeObserver = null;
  }

  append(...children) {
    this.children.push(...children.filter(Boolean));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    const dispatched = event ?? {};
    dispatched.type ??= "event";
    dispatched.preventDefault ??= () => { dispatched.defaultPrevented = true; };
    for (const listener of this.listeners.get(dispatched.type) ?? []) {
      listener(dispatched);
    }
    return true;
  }

  focus() {
    this.dispatchEvent({ type: "focus" });
  }

  blur() {
    this.dispatchEvent({ type: "blur" });
  }

  getBoundingClientRect() {
    return { width: this.renderedWidth };
  }

  matches(selector) {
    const tag = selector.match(/^([a-z]+)/iu)?.[1];
    if (tag && this.tagName !== tag) return false;
    const className = selector.match(/\.([\w-]+)/u)?.[1];
    if (className && !this.getAttribute("class")?.split(/\s+/u).includes(className)) {
      return false;
    }
    const attribute = selector.match(/\[([^=\]]+)="([^"]*)"\]/u);
    if (attribute && this.getAttribute(attribute[1]) !== attribute[2]) return false;
    return true;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches?.(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeSvgDocument {
  constructor(renderedWidth = 900) {
    this.renderedWidth = renderedWidth;
  }

  createElementNS(_namespace, tagName) {
    return new FakeSvgElement(
      tagName,
      tagName === "svg" ? this.renderedWidth : 0,
    );
  }
}

class FakePeriodControls {
  constructor(periodIds) {
    this.buttons = periodIds.map((periodId) => {
      const button = new FakeSvgElement("button");
      button.dataset = { period: periodId };
      button.hidden = false;
      button.disabled = false;
      button.classList = {
        values: new Set(),
        toggle(name, active) {
          if (active) this.values.add(name);
          else this.values.delete(name);
        },
      };
      return button;
    });
  }

  querySelectorAll(selector) {
    return selector === "button" ? this.buttons : [];
  }
}

class FakeChartShell {
  constructor(width = 320) {
    this.width = width;
    this.classList = {
      values: new Set(),
      add: (...names) => names.forEach((name) => this.classList.values.add(name)),
      remove: (...names) => names.forEach((name) => this.classList.values.delete(name)),
    };
    this.attributes = new Map();
    this.capturedPointerId = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setPointerCapture(pointerId) {
    this.capturedPointerId = pointerId;
  }

  releasePointerCapture(pointerId) {
    this.releasedPointerId = pointerId;
  }

  getBoundingClientRect() {
    return { width: this.width, left: 0 };
  }
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe(element) {
    element.resizeObserver = this;
  }
}

async function loadLineChartRenderer(documentRef, { translate = null } = {}) {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // The slice starts at the point-style policy so the renderer arrives with the
  // constant that decides whether a series draws visible dots. A series that
  // omits it is rejected, which is the property the DOM tests below check.
  const start = appSource.indexOf("const CHART_POINT_STYLE = Object.freeze(");
  const end = appSource.indexOf("\nfunction isWellObservedWeeklyFit", start);
  assert.ok(start >= 0 && end > start, "lineChart DOM renderer is available");
  const chartSource = appSource.slice(start, end);
  const scope = Function(
    "document",
    "ResizeObserver",
    "adaptiveChartTickCount",
    "finite",
    "formatChartTimestamp",
    "formatMoney",
    "formatDecimal",
    "formatPercent",
    "formatChartTimeLabel",
    "timelineStatusKey",
    "setRawText",
    "t",
    "tPlural",
    `${chartSource}\nreturn { lineChart, CHART_POINT_STYLE, chartText };`,
  )(
    documentRef,
    FakeResizeObserver,
    adaptiveChartTickCount,
    (value, fallback = null) => typeof value === "number" && Number.isFinite(value) ? value : fallback,
    (value, { dateOnly = false } = {}) => {
      const iso = new Date(value).toISOString();
      return dateOnly ? iso.slice(0, 10) : iso;
    },
    (value) => `$${Number(value).toFixed(0)}`,
    (value) => Number(value).toFixed(1),
    (value) => `${Number(value).toFixed(0)}%`,
    (value, { dateOnly = false } = {}) => {
      const iso = new Date(value).toISOString();
      return dateOnly ? iso.slice(0, 10) : `${iso} UTC`;
    },
    (status) => `status.${status}`,
    (element, value) => { element.textContent = String(value); },
    translate ?? ((key, values = {}) => `[${key}]${Object.entries(values)
      .map(([name, value]) => ` ${name}=${value}`).join("")}`),
    (key, count) => `[${key}|${count}]`,
  );
  return scope;
}

/**
 * Run the shipped renderWeekly against a fake DOM at a chosen range/span, so
 * the hero copy can be compared across control positions instead of inferred
 * from the source.
 */
async function renderWeeklyHero(data, { span, rangeDays, locale = "en-US", planType = null }) {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const chartStart = appSource.indexOf("const CHART_POINT_STYLE = Object.freeze(");
  const chartEnd = appSource.indexOf("\nfunction firstFiniteForecastNumber", chartStart);
  const weeklyStart = appSource.indexOf("function renderWeekly(data) {");
  const weeklyEnd = appSource.indexOf("\nfunction accountingPeriod(data)", weeklyStart);
  assert.ok(chartStart >= 0 && weeklyStart > chartStart, "renderWeekly is available");
  const section = `${appSource.slice(chartStart, chartEnd)}\n${appSource.slice(weeklyStart, weeklyEnd)}`;

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: "",
        hidden: false,
        setAttribute() {},
        removeAttribute() {},
        replaceChildren() {},
        append() {},
      });
    }
    return elements.get(id);
  };
  const money = (value, digits = 0) => value === null || value === undefined
    ? "—"
    : `$${Number(value).toFixed(digits)}`;
  const { shareCardPlanLabel } = await loadShareCardPlan();
  let shared = null;
  let paceData = null;

  Function(
    "document", "ResizeObserver", "adaptiveChartTickCount", "finite",
    "formatChartTimestamp", "formatMoney", "formatDecimal", "formatPercent",
    "formatPp", "formatChartTimeLabel", "formatTimeZoneLabel", "timelineStatusKey",
    "setRawText", "setLocalizedText", "setLocalizedPluralText", "t", "tPlural",
    "shareCardDateLabel", "ALL_HISTORY_RANGE_DAYS",
    "$", "clear", "node", "formatLocal", "formatNumber",
    "renderWeeklyPaceForecast",
    // renderWeekly owns the share-card re-render (owner-verified regression,
    // 2026-08-08), so the hero harness stubs it like the other renderers.
    "renderShareCard",
    // The stale-serve recalculating note is rendered by the shared helper;
    // the hero harness stubs it like the other side-effect renderers.
    "renderStaleServeNote",
    "activeWeeklyRangeDays", "activeWeeklyMinimumObservedSpanPp",
    "selectAllowancePlanPopulation", "activeWeeklyPlanType",
    "renderWeeklyPlanControl", "shareCardPlanLabel",
    `${section}\nreturn renderWeekly;`,
  )(
    { createElementNS: () => new FakeSvgElement("g") },
    FakeResizeObserver,
    () => 5,
    (value, fallback = null) => typeof value === "number" && Number.isFinite(value) ? value : fallback,
    (value) => new Date(value).toISOString().slice(0, 16),
    money,
    (value, digits = 0) => Number(value).toFixed(digits),
    (value) => `${Number(value).toFixed(0)}%`,
    (value) => value === null ? "—" : `${Number(value).toFixed(1)} pp`,
    (value) => new Date(value).toISOString().slice(0, 10),
    () => "Eastern Time",
    (status) => `chart.status.${status}`,
    (target, value) => { target.textContent = String(value); },
    (target, key, values = {}) => { target.textContent = translate(key, values, locale); },
    (target, key, count, values = {}) => {
      target.textContent = translatePlural(key, count, values, locale);
    },
    (key, values = {}) => translate(key, values, locale),
    (key, count, values = {}) => translatePlural(key, count, values, locale),
    (at) => new Date(at).toISOString().slice(0, 10),
    36_500,
    element,
    () => {},
    () => ({ append() {}, textContent: "" }),
    (value) => new Date(value).toISOString().slice(0, 10),
    (value) => String(value),
    (selectedData) => { paceData = selectedData; },
    (selectedData, { history }) => { shared = { data: selectedData, history }; },
    () => {},
    rangeDays,
    span,
    selectAllowancePlanPopulation,
    planType,
    () => {},
    shareCardPlanLabel,
  )(data);

  return {
    label: element("#weekly-estimate-label").textContent,
    estimate: element("#weekly-estimate").textContent,
    range: element("#weekly-range").textContent,
    explanation: element("#weekly-explanation").textContent,
    timeZone: element("#weekly-chart-timezone").textContent,
    spanLabel: element("#weekly-span-label").textContent,
    spanNote: element("#weekly-span-note"),
    empty: element("#weekly-empty"),
    shared,
    paceData,
  };
}

async function loadAccountingPeriodSync(periodIds) {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function accountingPeriod(data)");
  const end = appSource.indexOf("\nfunction renderAccountingDimension", start);
  assert.ok(start >= 0 && end > start, "accounting period guard is available");
  const controls = new FakePeriodControls(periodIds);
  const section = appSource.slice(start, end);
  return Function(
    "$",
    "selectAvailableAccountingPeriod",
    "controls",
    `let activeAccountingPeriod = "history";\n${section}\nreturn {
      syncAccountingPeriodControls,
      getActive: () => activeAccountingPeriod,
      setActive: (value) => { activeAccountingPeriod = value; },
      controls,
    };`,
  )(
    () => controls,
    selectAvailableAccountingPeriod,
    controls,
  );
}

async function loadTimelineInteractions() {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function bindTimelineInteractions(");
  const end = appSource.indexOf("\nfunction renderTimelineSummary", start);
  assert.ok(start >= 0 && end > start, "timeline interaction binder is available");
  const section = appSource.slice(start, end);
  const calls = {};
  return Function(
    "$",
    "t",
    "setLocalizedText",
    "USER_TIME_ZONE",
    "formatLocal",
    "formatSpanLength",
    "wheelZoomFactor",
    "panTimeline",
    "zoomTimeline",
    "resetTimelineViewport",
    "renderTimeline",
    "dashboard",
    "calls",
    `let timelinePointerStart = null;\n${section}\nreturn { bind: bindTimelineInteractions, calls };`,
  )(
    () => ({ textContent: "" }),
    (_key, values) => JSON.stringify(values ?? {}),
    (element, _key, values) => {
      if (element) element.textContent = JSON.stringify(values ?? {});
    },
    "America/New_York",
    (value) => String(value),
    (value) => String(value),
    () => 1,
    (_points, fraction) => { calls.pan = fraction; },
    (_points, factor) => { calls.zoom = factor; },
    () => { calls.reset = true; },
    () => {},
    {},
    calls,
  );
}

test("browser reporting timestamps use one explicit system time zone", () => {
  const timestamp = "2026-08-03T16:23:00.000Z";
  const date = new Date(timestamp);
  const dateOptions = {
    timeZone: REPORTING_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  };
  const timeOptions = {
    timeZone: REPORTING_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  const expectedDate = new Intl.DateTimeFormat(USER_LOCALE, dateOptions).format(date);
  const expectedTime = new Intl.DateTimeFormat(USER_LOCALE, timeOptions).format(date);

  assert.equal(formatReportingTime(timestamp, { dateOnly: true }), expectedDate);
  assert.equal(formatReportingTime(timestamp), expectedTime);
  assert.equal(formatLocal(timestamp), expectedTime);
  assert.equal(
    reportingCalendarParts().format(date),
    new Intl.DateTimeFormat(USER_LOCALE, {
      timeZone: REPORTING_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date),
  );
  assert.equal(formatReportingTime("not a timestamp"), "Unknown");
});

test("UTC calendar-day formatting preserves published days and rejects invalid dates", () => {
  const expected = new Intl.DateTimeFormat(USER_LOCALE, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date("2024-02-29T00:00:00.000Z"));

  assert.equal(formatUtcCalendarDay("2024-02-29"), expected);
  assert.equal(formatUtcCalendarDay(null), "Unknown");
  assert.equal(formatUtcCalendarDay(undefined), "Unknown");
  assert.equal(formatUtcCalendarDay(""), "Unknown");
  assert.equal(formatUtcCalendarDay("2023-02-29"), "Unknown");
  assert.equal(formatUtcCalendarDay("2024-02-30"), "Unknown");
  assert.equal(formatUtcCalendarDay("not-a-day"), "Unknown");
});

test("human time-zone labels are direct localized Intl fixtures", () => {
  const value = "2026-01-15T12:00:00.000Z";
  assert.equal(
    formatTimeZoneLabel({
      locale: "en-US",
      timeZone: "America/New_York",
      value,
    }),
    "Eastern Time",
  );
  assert.equal(
    formatTimeZoneLabel({
      locale: "es",
      timeZone: "America/New_York",
      value,
    }),
    "hora oriental",
  );
  assert.equal(
    formatTimeZoneLabel({
      locale: "zh-Hans",
      timeZone: "Asia/Tokyo",
      value,
    }),
    "日本标准时间",
  );
});

test("chart and accounting shared helpers fail closed on unavailable evidence", () => {
  assert.equal(adaptiveChartTickCount(900), 7);
  assert.equal(adaptiveChartTickCount(320), 2);
  assert.ok(adaptiveChartTickCount(320) < adaptiveChartTickCount(900));

  const idle = classifyTimelineEvidence({
    bracketed: true,
    sameReset: true,
    observed: 0,
    expected: 0,
    usageEvents: 0,
    apiCostUsd: 0,
  });
  assert.deepEqual(idle, { status: "inactive", residual: 0 });

  const missing = classifyTimelineEvidence({
    bracketed: false,
    sameReset: false,
    observed: null,
    expected: 0,
    usageEvents: 0,
    apiCostUsd: 0,
  });
  assert.deepEqual(missing, {
    status: "missing_quota_bracket",
    residual: null,
  });

  const residual = classifyTimelineEvidence({
    bracketed: true,
    sameReset: true,
    observed: 12,
    expected: 8,
    usageEvents: 3,
    apiCostUsd: 4.5,
  });
  assert.deepEqual(residual, { status: "matched", residual: 4 });

  const periods = [{ periodId: "7d" }, { periodId: "all" }];
  assert.equal(selectAvailableAccountingPeriod(periods, "history"), "7d");
  assert.equal(
    selectAvailableAccountingPeriod([{ periodId: "history" }, ...periods], "history"),
    "history",
  );
  assert.equal(selectAvailableAccountingPeriod([{ periodId: "all" }], "history"), null);
  assert.equal(selectAvailableAccountingPeriod([], "history"), null);
});

// --- Deviation-period detector (added 2026-08-09) --------------------------
// The detector reads the same live cumulative-drift series the residual chart
// draws and reports only SUSTAINED runs. These fixtures pin the five behaviours
// the Trends panel depends on: a sustained positive run, a sustained negative
// run, a spike that cancels (must not flag), reset-boundary splitting, and the
// empty/no-drift cases.
const DEVIATION_STEP_MS = 15 * 60 * 1_000;
const DEVIATION_BASE_MS = Date.parse("2026-08-01T00:00:00.000Z");

// Build a 15-minute-spaced drift series. Each entry is a number (the drift, in
// pp) or `{ drift, residual, reanchor }`. `residual` defaults to the drift so
// the signed AUC carries the same sign as the run.
function driftSeries(entries, { startMs = DEVIATION_BASE_MS } = {}) {
  return entries.map((entry, index) => {
    const drift = typeof entry === "number" ? entry : entry.drift;
    const residual = typeof entry === "object" && "residual" in entry
      ? entry.residual
      : drift;
    const reanchor = typeof entry === "object" && entry.reanchor === true;
    const timestampMs = startMs + index * DEVIATION_STEP_MS;
    return {
      timestampMs,
      timestamp: new Date(timestampMs).toISOString(),
      cumulativeResidual: drift,
      residual,
      driftReanchor: reanchor,
    };
  });
}

test("deviation detector flags a sustained positive run as under-counted", () => {
  // Below-threshold lead-in, then 3 hours above +5 pp, then a return to zero.
  const series = driftSeries([
    0, 1, 2, 3, 4,
    8, 8, 9, 10, 9, 8, 8, 8, 9, 8, 8, 8, 9,
    3, 1, 0,
  ]);
  const result = detectDeviationPeriods(series);
  assert.equal(result.periods.length, 1);
  assert.equal(result.hasDriftSeries, true);
  const [period] = result.periods;
  assert.equal(period.direction, "under_costed");
  assert.equal(period.directionSign, 1);
  assert.ok(period.durationMs >= DEVIATION_MIN_DURATION_MS);
  assert.equal(period.absPeakDriftPp, 10);
  assert.ok(period.peakDriftPp > 0);
  assert.ok(period.signedAucPpHours > 0, "positive run accumulates positive area");
});

test("deviation detector flags a sustained negative run as over-counted", () => {
  const series = driftSeries([
    0, -1, -2, -3,
    -8, -9, -8, -8, -9, -8, -8, -9, -8, -8, -9, -8, -8,
    -2, 0,
  ]);
  const result = detectDeviationPeriods(series);
  assert.equal(result.periods.length, 1);
  const [period] = result.periods;
  assert.equal(period.direction, "over_costed");
  assert.equal(period.directionSign, -1);
  assert.equal(period.absPeakDriftPp, 9);
  assert.ok(period.peakDriftPp < 0);
  assert.ok(period.signedAucPpHours < 0, "negative run accumulates negative area");
});

test("deviation detector ignores a spike that cancels itself out", () => {
  // A tall but brief +excursion followed by an equally brief -excursion: net
  // ~zero, and neither side lasts the two-hour minimum. Nothing is a period.
  const series = driftSeries([
    0, 8, 12, 8, 0, -8, -12, -8, 0,
  ]);
  const result = detectDeviationPeriods(series);
  assert.equal(result.periods.length, 0);
  assert.equal(result.totalFound, 0);
  assert.equal(result.hasDriftSeries, true, "a spike is still real drift evidence");
});

test("deviation detector splits a run at a reset-boundary re-anchor", () => {
  // Twelve consecutive above-threshold buckets are one 165-minute period on
  // their own. A re-anchor at the midpoint (a reset boundary or track change)
  // splits them into two 75-minute halves, and neither half clears the floor.
  const values = Array.from({ length: 12 }, () => 8);
  const withoutReset = detectDeviationPeriods(driftSeries(values));
  assert.equal(withoutReset.periods.length, 1, "unbroken run is one period");

  const withReset = detectDeviationPeriods(driftSeries(
    values.map((drift, index) => (index === 6 ? { drift, reanchor: true } : drift)),
  ));
  assert.equal(withReset.periods.length, 0, "the reset ends the period at the boundary");
});

test("deviation detector treats a data gap as a hard boundary", () => {
  // A null drift is a missing bucket, not a zero: it ends the run in progress
  // exactly like a reset, so a run straddling the gap cannot be sustained.
  const series = driftSeries([
    8, 8, 8, 8, 8,
    { drift: null },
    8, 8, 8, 8, 8,
  ]);
  const result = detectDeviationPeriods(series);
  assert.equal(result.periods.length, 0);
});

test("a pool-saturated span never becomes or extends a deviation period", () => {
  // While the weekly pool is pegged at 100%, liveTimelinePoints suspends both
  // the residual and the cumulative drift (nulls, status "pool_saturated") —
  // the same shape as a data gap — so the detector can neither read the
  // post-peg interregnum as an over-cost period nor bridge a run across it,
  // and the excluded spans contribute nothing to any period's signed AUC.
  const series = driftSeries([
    -8, -8, -8, -8, -8, -8,
    { drift: null, residual: null },
    { drift: null, residual: null },
    { drift: null, residual: null },
    { drift: -8, reanchor: true }, -8, -8, -8, -8, -8,
  ]);
  const result = detectDeviationPeriods(series);
  // Each side is 75 minutes: below the two-hour sustain floor once the
  // saturated span refuses to connect them.
  assert.equal(result.periods.length, 0);
  assert.equal(result.hasDriftSeries, true);
});

test("deviation detector returns an explicit empty result with no drift series", () => {
  const empty = detectDeviationPeriods([]);
  assert.deepEqual(empty.periods, []);
  assert.equal(empty.totalFound, 0);
  assert.equal(empty.truncated, false);
  assert.equal(empty.hasDriftSeries, false);

  // Present-but-unusable: every point suspends the drift line. This must read
  // as "no series to judge", not "nothing diverged".
  const suspended = detectDeviationPeriods(
    driftSeries([{ drift: null }, { drift: null }, { drift: null }]),
  );
  assert.equal(suspended.periods.length, 0);
  assert.equal(suspended.hasDriftSeries, false);
});

test("deviation detector attaches exact per-period contributor totals from buckets", () => {
  const series = driftSeries([
    0, 0,
    8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
    0,
  ]);
  const [period] = detectDeviationPeriods(series).periods;
  // One bucket inside the run, one outside it, plus a bucket the run spans that
  // carries unpriced changes.
  const usageBuckets = [
    {
      startAt: "2026-07-31T23:00:00.000Z",
      endAt: "2026-08-01T00:00:00.000Z",
      apiPriceEquivalentUsd: 99,
      totalTokens: 9_999,
      usageEvents: 40,
      pricingCoverage: { unpricedEvents: 0 },
    },
    {
      startAt: new Date(period.startMs).toISOString(),
      endAt: new Date(period.startMs).toISOString(),
      apiPriceEquivalentUsd: 4,
      totalTokens: 2_000,
      usageEvents: 10,
      pricingCoverage: { unpricedEvents: 4 },
    },
    {
      startAt: new Date(period.endMs).toISOString(),
      endAt: new Date(period.endMs).toISOString(),
      apiPriceEquivalentUsd: 6,
      totalTokens: 3_000,
      usageEvents: 6,
      pricingCoverage: { unpricedEvents: 0 },
    },
  ];
  const [priced] = detectDeviationPeriods(series, { usageBuckets }).periods;
  assert.equal(priced.contributors.costUsd, 10);
  assert.equal(priced.contributors.totalTokens, 5_000);
  assert.equal(priced.contributors.usageEvents, 16);
  assert.equal(priced.contributors.unpricedEvents, 4);
  assert.equal(priced.contributors.pricedEvents, 12);
  assert.ok(Math.abs(priced.contributors.unpricedEventShare - 4 / 16) < 1e-9);
  assert.equal(priced.contributors.bucketCount, 2);
});

test("deviation detector caps the list and reports the full count", () => {
  const constants = {
    thresholdPp: DEVIATION_DRIFT_THRESHOLD_PP,
    minDurationMs: DEVIATION_MIN_DURATION_MS,
    mergeGapMs: DEVIATION_MERGE_GAP_MS,
    maxPeriods: DEVIATION_MAX_PERIODS,
  };
  assert.equal(constants.thresholdPp, 5);
  assert.equal(constants.minDurationMs, 2 * 60 * 60 * 1_000);
  assert.equal(constants.maxPeriods, 20);

  // Two well-separated sustained runs; capping to one keeps the widest and
  // still reports both were found, so nothing is silently dropped.
  const run = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8];
  const tallerRun = [12, 12, 12, 12, 12, 12, 12, 12, 12, 12];
  const series = driftSeries([
    ...run,
    ...Array.from({ length: 12 }, () => 0),
    ...tallerRun,
  ]);
  const result = detectDeviationPeriods(series, { maxPeriods: 1 });
  assert.equal(result.totalFound, 2);
  assert.equal(result.periods.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.periods[0].absPeakDriftPp, 12, "the widest period is kept");
});

test("browser JSON preflight rejects duplicate object keys before parsing", () => {
  for (const serialized of [
    '{"prompt":"first","prompt":"second"}',
    '{"row":{"accountScopeId":"first","accountScopeId":"second"}}',
    '{"content":"first","\\u0063ontent":"second"}',
    '{"safeCount":1,"safeCount":1}',
  ]) {
    assert.throws(
      () => parseJsonWithUniqueObjectKeys(serialized),
      (error) => (
        error instanceof SyntaxError
        && error.code === "duplicate_json_object_key"
        && error.message === "Duplicate JSON object keys are not accepted."
        && !error.message.includes("prompt")
        && !error.message.includes("accountScopeId")
        && !error.message.includes("content")
        && !error.message.includes("safeCount")
      ),
    );
  }
});

test("browser JSON preflight preserves canonical JSON object behavior", () => {
  const serialized = JSON.stringify({
    schemaVersion: "telemetry-contribution-v0.2",
    nested: {
      accountScopeId: "acct_opaque",
      values: [null, true, false, -12.5e3, "escaped\nvalue"],
    },
    siblings: [
      { repeatedAcrossObjects: 1 },
      { repeatedAcrossObjects: 2 },
    ],
  });
  assert.deepEqual(
    parseJsonWithUniqueObjectKeys(serialized),
    JSON.parse(serialized),
  );
  assert.deepEqual(
    parseJsonWithUniqueObjectKeys(
      '{"left":{"same":"allowed"},"right":{"same":"allowed"}}',
    ),
    {
      left: { same: "allowed" },
      right: { same: "allowed" },
    },
  );
  assert.throws(
    () => parseJsonWithUniqueObjectKeys('{"truncated":'),
    (error) => (
      error instanceof SyntaxError
      && error.code !== "duplicate_json_object_key"
      && !error.message.includes("truncated")
    ),
  );
});

test("quota timeline lookup preserves latest-at-or-before boundary semantics", () => {
  const rows = [
    { id: "late", observedAt: "2026-07-29T03:00:00.000Z" },
    { id: "first-at-duplicate", observedAt: "2026-07-29T02:00:00.000Z" },
    { id: "early", observedAt: "2026-07-29T01:00:00.000Z" },
    { id: "last-at-duplicate", observedAt: "2026-07-29T02:00:00.000Z" },
  ];
  const sorted = [...rows].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const reference = (timestampMs) => {
    let selected = null;
    for (const row of sorted) {
      if (Date.parse(row.observedAt) > timestampMs) break;
      selected = row;
    }
    return selected;
  };
  const lookup = createQuotaTimelineLookup(rows);

  for (const timestampMs of [
    Number.NEGATIVE_INFINITY,
    Date.parse("2026-07-29T00:59:59.999Z"),
    Date.parse("2026-07-29T01:00:00.000Z"),
    Date.parse("2026-07-29T01:59:59.999Z"),
    Date.parse("2026-07-29T02:00:00.000Z"),
    Date.parse("2026-07-29T02:59:59.999Z"),
    Date.parse("2026-07-29T03:00:00.000Z"),
    Number.POSITIVE_INFINITY,
  ]) {
    assert.strictEqual(
      lookup.atOrBefore(timestampMs)?.row ?? null,
      reference(timestampMs),
    );
  }
  assert.strictEqual(
    lookup.atOrBefore(Date.parse("2026-07-29T02:00:00.000Z"))?.row,
    rows[3],
    "the latest source row wins when observations share a timestamp",
  );
  assert.equal(lookup.atOrBefore(Number.NaN), null);
  assert.equal(createQuotaTimelineLookup([]).atOrBefore(Date.now()), null);
  assert.equal(
    createQuotaTimelineLookup([{ observedAt: "not-a-timestamp" }]).size,
    0,
  );
  assert.throws(
    () => createQuotaTimelineLookup(null),
    /Quota timeline rows must be an array/,
  );
});

test("quota timeline lookup answers earliest-at-or-after boundary semantics", () => {
  const rows = [
    { id: "late", observedAt: "2026-07-29T03:00:00.000Z" },
    { id: "first-at-duplicate", observedAt: "2026-07-29T02:00:00.000Z" },
    { id: "early", observedAt: "2026-07-29T01:00:00.000Z" },
    { id: "last-at-duplicate", observedAt: "2026-07-29T02:00:00.000Z" },
  ];
  const sorted = [...rows].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const reference = (timestampMs) => {
    for (const row of sorted) {
      if (Date.parse(row.observedAt) >= timestampMs) return row;
    }
    return null;
  };
  const lookup = createQuotaTimelineLookup(rows);

  for (const timestampMs of [
    Number.NEGATIVE_INFINITY,
    Date.parse("2026-07-29T00:59:59.999Z"),
    Date.parse("2026-07-29T01:00:00.000Z"),
    Date.parse("2026-07-29T01:59:59.999Z"),
    Date.parse("2026-07-29T02:00:00.000Z"),
    Date.parse("2026-07-29T02:59:59.999Z"),
    Date.parse("2026-07-29T03:00:00.000Z"),
    Number.POSITIVE_INFINITY,
  ]) {
    assert.strictEqual(
      lookup.atOrAfter(timestampMs)?.row ?? null,
      reference(timestampMs),
    );
  }
  assert.strictEqual(
    lookup.atOrAfter(Date.parse("2026-07-29T02:00:00.000Z"))?.row,
    rows[1],
    "the earliest source row wins when observations share a timestamp",
  );
  assert.equal(lookup.atOrAfter(Date.parse("2026-07-29T03:00:00.001Z")), null);
  assert.equal(lookup.atOrAfter(Number.NaN), null);
  assert.equal(createQuotaTimelineLookup([]).atOrAfter(0), null);
});

test("quota timeline lookup parses supported dashboard bounds only once", () => {
  const quotaRowCount = 10_000;
  const usagePointCount = 3_000;
  const startMs = Date.parse("2026-01-01T00:00:00.000Z");
  let observedAtReads = 0;
  const rows = Array.from({ length: quotaRowCount }, (_, id) => {
    const observedAt = new Date(startMs + id * 60_000).toISOString();
    return Object.defineProperty({ id }, "observedAt", {
      enumerable: true,
      get() {
        observedAtReads += 1;
        return observedAt;
      },
    });
  });

  const lookup = createQuotaTimelineLookup(rows);
  assert.equal(lookup.size, quotaRowCount);
  assert.equal(observedAtReads, quotaRowCount);
  for (let query = 0; query < usagePointCount; query += 1) {
    const expectedId = Math.floor(
      query * (quotaRowCount - 1) / (usagePointCount - 1),
    );
    assert.equal(
      lookup.atOrBefore(startMs + expectedId * 60_000)?.row.id,
      expectedId,
    );
  }
  assert.equal(observedAtReads, quotaRowCount);
  assert.equal(lookup.atOrBefore(startMs - 1), null);
  const last = lookup.atOrBefore(Number.POSITIVE_INFINITY);
  assert.equal(last?.row.id, quotaRowCount - 1);
  assert.equal(last?.timestampMs, startMs + (quotaRowCount - 1) * 60_000);
  assert.equal(observedAtReads, quotaRowCount);
});

test("refresh polling budget gives each accepted continuation a fresh window", () => {
  let nowMs = 1_000;
  const budget = createRefreshPollingBudget({
    now: () => nowMs,
    windowMs: 2_000,
    settlementGraceMs: 1_000,
    maximumContinuations: 2
  });

  assert.equal(budget.hasTime(), true);
  assert.equal(budget.canContinue(), true);
  nowMs = 3_000;
  assert.equal(budget.hasTime(), false);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.continuations, 1);
  nowMs = 4_999;
  assert.equal(budget.hasTime(), true);
  nowMs = 5_000;
  assert.equal(budget.hasTime(), false);
  budget.noteSettling();
  nowMs = 5_999;
  assert.equal(budget.hasTime(), true);
  assert.equal(budget.noteContinuation(), true);
  nowMs = 7_998;
  assert.equal(budget.hasTime(), true);
  assert.equal(budget.noteContinuation(), false);
});

test("default local analysis permits only two bounded continuations", () => {
  const budget = createRefreshPollingBudget();
  assert.equal(LOCAL_REFRESH_POLLING_WINDOW_MS, 241 * 60 * 1_000);
  assert.equal(budget.canContinue(), true);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.noteContinuation(), true);
  assert.equal(budget.canContinue(), false);
  assert.equal(budget.noteContinuation(), false);
});

test("quick-result progress never turns a loaded no-numbers overview into a headline claim", () => {
  const noNumbersOverview = {
    state: "insufficient",
    quotaWindows: [],
    accounting: { status: "unavailable" },
  };

  assert.deepEqual(noNumbersOverview.quotaWindows, []);
  assert.equal(
    refreshQuickResultStatus({
      dashboardLoaded: true,
      elapsedLabel: "7s",
    }),
    "Local summary updated · checking full history… 7s",
  );
  assert.equal(
    refreshQuickResultStatus({
      dashboardLoaded: false,
      elapsedLabel: "7s",
    }),
    "Preparing local summary… 7s",
  );
  assert.equal(
    refreshQuickResultStatus({ dashboardLoaded: true, elapsedLabel: "1m 2s" }),
    "Local summary updated · checking full history… 1m 2s",
  );
  assert.equal(
    refreshQuickResultStatus({ dashboardLoaded: true }),
    "Local summary updated · checking full history…",
  );
});

test("accounting progress is explicit work, with no source-counter or ready fallback", () => {
  const progress = { kind: "accounting", status: "calculating" };
  assert.equal(refreshAccountingStatus({ progress }), "Calculating accounting…");
  assert.equal(
    refreshAccountingStatus({ progress, elapsedLabel: "1m 7s" }),
    "Calculating accounting… 1m 7s",
  );
  for (const invalid of [
    null, [], "accounting",
    { kind: "accounting" },
    { ...progress, status: "complete" },
    { ...progress, phase: "quick_result" },
    { ...progress, filesProcessed: 7, filesSelected: 7_215 },
    { ...progress, message: "synthetic unreviewed text" },
    { kind: "future_worker", status: "calculating" },
    { phase: "accounting" },
  ]) {
    assert.equal(refreshAccountingStatus({ progress: invalid }), null);
  }
});

test("contribution admission uses participant allowance without inventing an unknown limit", () => {
  const known = contributionBatchAdmission({
    estimatedBatches: 8,
    participantAdmission: {
      state: "available",
      remainingBatches: 7,
      maximumBatches: 100,
      renewsAt: "2026-08-03T00:00:00.000Z",
    },
  });
  assert.equal(known.admissionKnown, true);
  assert.equal(known.exceedsParticipantAdmission, true);
  assert.equal(known.blocked, true);
  assert.equal(known.effectiveBatchLimit, 7);
  assert.equal(known.renewsAt, "2026-08-03T00:00:00.000Z");

  const exhausted = contributionBatchAdmission({
    estimatedBatches: 1,
    participantAdmission: {
      state: "exhausted",
      remainingBatches: 0,
      maximumBatches: 100,
      renewsAt: "2026-08-03T00:00:00.000Z",
    },
  });
  assert.equal(exhausted.blocked, true);
  assert.equal(exhausted.effectiveBatchLimit, 0);

  const unknown = contributionBatchAdmission({
    estimatedBatches: 8,
    participantAdmission: null,
  });
  assert.equal(unknown.admissionKnown, false);
  assert.equal(unknown.remainingBatches, null);
  assert.equal(unknown.blocked, false);
  assert.equal(unknown.effectiveBatchLimit, 100);

  assert.equal(
    contributionBatchAdmission({
      estimatedBatches: 101,
      participantAdmission: null,
    }).blocked,
    true,
  );
});

test("completed bounded passes continue under the original user action", () => {
  assert.equal(refreshNeedsContinuation({
    outcome: "succeeded",
    progress: { status: "bounded_pause" },
  }), true);
  assert.equal(refreshNeedsContinuation({
    outcome: "failed",
    errorCode: "refresh_timed_out",
    progress: { status: "bounded_pause" },
  }), true);
  assert.equal(refreshNeedsContinuation({
    outcome: "succeeded",
    progress: { status: "recent_7d_complete" },
  }), false);
  assert.equal(refreshNeedsContinuation({
    outcome: "failed",
    errorCode: "collector_failed",
    progress: { status: "bounded_pause" },
  }), false);
});

test("history auto-continuation stops on terminal gaps and unchanged receipts", () => {
  const history = {
    status: "partial",
    phase: "scanning",
    indexedSourceCount: 7,
    indexedBytes: 7_000,
    sourceCount: 10,
    sourceBytes: 10_000,
  };
  const advancing = historyIndexContinuationDecision({
    history,
    generation: 4,
    generationFingerprint: "a".repeat(64),
  });
  assert.equal(advancing.incomplete, true);
  assert.equal(advancing.shouldContinue, true);
  assert.equal(typeof advancing.receipt, "string");

  const unchanged = historyIndexContinuationDecision({
    history,
    generation: 4,
    generationFingerprint: "a".repeat(64),
    previousReceipt: advancing.receipt,
  });
  assert.equal(unchanged.incomplete, true);
  assert.equal(unchanged.shouldContinue, false);

  const advancedBytes = historyIndexContinuationDecision({
    history: { ...history, indexedBytes: 7_001 },
    generation: 4,
    generationFingerprint: "a".repeat(64),
    previousReceipt: advancing.receipt,
  });
  assert.equal(advancedBytes.shouldContinue, true);

  const terminalGap = historyIndexContinuationDecision({
    history: {
      ...history,
      phase: "partial_terminal",
      skippedSourceCount: 3,
    },
    generation: 5,
    generationFingerprint: "b".repeat(64),
    previousReceipt: advancing.receipt,
  });
  assert.equal(terminalGap.incomplete, false);
  assert.equal(terminalGap.shouldContinue, false);
  assert.equal(terminalGap.terminalGap, true);

  assert.equal(historyIndexContinuationDecision({
    history: { ...history, status: "complete" },
  }).shouldContinue, false);
});

test("terminal history gaps are informational only when small, coherent, and fully accounted", () => {
  const accountingProjection = { status: "available" };
  const history = {
    status: "partial",
    phase: "partial_terminal",
    sourceCount: 7_156,
    indexedSourceCount: 7_142,
    pendingSourceCount: 0,
    skippedSourceCount: 14,
  };
  assert.equal(HISTORY_INFORMATIONAL_GAP_MAX_SHARE, 0.01);
  assert.equal(historyCoverageNoticeKind({
    history,
    accountingProjection,
  }), "info");
  assert.equal(historyCoverageNoticeKind({
    history: {
      ...history,
      sourceCount: 100,
      indexedSourceCount: 99,
      skippedSourceCount: 1,
    },
    accountingProjection,
  }), "info");
  assert.equal(historyCoverageNoticeKind({
    history: {
      ...history,
      sourceCount: 100,
      indexedSourceCount: 98,
      skippedSourceCount: 2,
    },
    accountingProjection,
  }), "warning");
  assert.equal(historyCoverageNoticeKind({
    history: {
      ...history,
      sourceCount: 14,
      indexedSourceCount: 0,
      skippedSourceCount: 14,
    },
    accountingProjection,
  }), "warning");
  for (const status of ["retained", "unavailable"]) {
    assert.equal(historyCoverageNoticeKind({
      history,
      accountingProjection: { status },
    }), "warning");
  }
  assert.equal(historyCoverageNoticeKind({
    history: { ...history, pendingSourceCount: 1 },
    accountingProjection,
  }), "warning");
  assert.equal(historyCoverageNoticeKind({
    history: { ...history, indexedSourceCount: 7_141 },
    accountingProjection,
  }), "warning");
});

function communitySnapshot() {
  const releasedTokens = { status: "released", value: 100_000, unit: "tokens_rounded_down" };
  return {
    schemaVersion: COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
    releaseStatus: "published",
    snapshotId: "community-week:2026-07-13",
    period: {
      startAt: "2026-07-13T00:00:00.000Z",
      endAt: "2026-07-20T00:00:00.000Z"
    },
    ingestionCutoffAt: "2026-07-22T00:00:00.000Z",
    releasedAt: "2026-07-22T00:00:00.000Z",
    immutable: true,
    nonOverlapping: true,
    cohortEligibility: "provider_account_gated_open_cohort",
    privacyPolicy: {
      version: "community-weekly-v0.1",
      minimumProviderAccountParticipants: 20,
      maturity: {
        appliesTo: "open_provider_account_cohort",
        maturityDays: 7,
        minimumAcceptedCollectionDays: 2,
        acceptedCollectionDayBasis: "telemetry_contribution_created_at_before_cutoff",
      },
    },
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      metrics: {
        usageEvents: { status: "released", value: 30, unit: "events_rounded_down" },
        inputUncachedTokens: releasedTokens,
        inputCacheReadTokens: releasedTokens,
        inputCacheWriteTokens: releasedTokens,
        outputTextTokens: releasedTokens,
        outputReasoningTokens: releasedTokens,
        outputCombinedTokens: releasedTokens,
        toolUnits: { status: "released", value: 10, unit: "tool_units_rounded_down" }
      }
    }]
  };
}

function safeTelemetry() {
  const toolClassCounts = {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 1,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0
  };
  return {
    schemaVersion: "telemetry-contribution-v0.1",
    synthetic: false,
    createdAt: "2026-07-25T14:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T13:00:00.000Z",
      endAt: "2026-07-25T13:30:00.000Z"
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1",
      eventTime: "2026-07-25T13:10:00.000Z",
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "standard",
      apiServiceTier: "standard",
      reasoningEffort: "high",
      components: {
        inputUncachedTokens: 1200,
        inputCacheReadTokens: 9000,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 800,
        outputReasoningTokens: 300,
        outputCombinedTokens: null
      },
      totalInputContextTokens: 10200,
      surface: "local_interactive_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts,
      outcome: "completed",
      eventId: `event:v2:${"a".repeat(64)}`,
      accounting: {
        estimatedApiCostUsd: "0.420000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices"
      }
    }],
    quotaSnapshots: [],
    activityMarkers: [],
    accounting: {
      estimatedApiCostUsd: "0.420000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices"
    }
  };
}

function safeAccountScopedTelemetry() {
  const source = safeTelemetry();
  return {
    schemaVersion: ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION,
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: `dataset:v1:${"d".repeat(64)}`,
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: source.createdAt,
    coveredAt: source.coveredAt,
    clientPlatform: source.clientPlatform,
    providerPolicyEpoch: source.providerPolicyEpoch,
    usageEvents: source.usageEvents.map(({ accounting, ...row }) => ({
      ...row,
      schemaVersion: "usage-event-v0.2",
      accountTrackId: `account-track:v1:${"a".repeat(64)}`,
      accountingDiagnostic: {
        ...accounting,
        status: "untrusted_diagnostic",
        sourceSchemaVersion: "telemetry-contribution-v0.1"
      }
    })),
    quotaSnapshots: [],
    activityMarkers: [],
    accountingDiagnostic: {
      ...source.accounting,
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1"
    }
  };
}

async function rsaPair() {
  return webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );
}

async function decryptEnvelope(envelope, privateKey) {
  const decode = (value) => new Uint8Array(Buffer.from(value, "base64url"));
  const rawPayloadKey = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    decode(envelope.wrappedKey)
  );
  const payloadKey = await webcrypto.subtle.importKey(
    "raw",
    rawPayloadKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(envelope.iv) },
    payloadKey,
    decode(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

test("the legacy demo fixture remains fixed, synthetic, and content-free", () => {
  const fixture = buildSyntheticFixture();
  assert.equal(validateSyntheticFixture(fixture), true);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.fixtureId, "codex-weekly-demo-v0.1");
});

test("base64url encoding is unpadded and URL safe", () => {
  assert.equal(bytesToBase64Url(new Uint8Array([])), "");
  assert.equal(bytesToBase64Url(new TextEncoder().encode("foo")), "Zm9v");
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255])), "-_8");
});

test("synthetic hybrid envelope retains the existing contract", async () => {
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createSyntheticEnvelope({
    publicJwk,
    keyId: "key:test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, true);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), buildSyntheticFixture());
});

test("real privacy-safe telemetry is validated and encrypted without changing its payload", async () => {
  const payload = safeTelemetry();
  assert.equal(validateTelemetryContribution(payload), true);
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk,
    keyId: "key:real-test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, TELEMETRY_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, false);
  assert.equal("payload" in envelope, false);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), payload);
});

test("account-scoped local-preview telemetry is preflighted and encrypted unchanged", async () => {
  const payload = safeAccountScopedTelemetry();
  assert.equal(validateAccountScopedTelemetryContribution(payload), true);
  const pair = await rsaPair();
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createTelemetryEnvelope({
    payload,
    publicJwk,
    keyId: "key:account-scoped-test",
    cryptoImpl: webcrypto
  });
  assert.equal(envelope.schemaVersion, TELEMETRY_ENVELOPE_SCHEMA_VERSION);
  assert.deepEqual(await decryptEnvelope(envelope, pair.privateKey), payload);
});

function telemetryContractFailure(code, detailCode) {
  return (error) => {
    assert.equal(error?.code, code);
    assert.equal(error?.detailCode, detailCode);
    return true;
  };
}

test("account-scoped browser preflight rejects direct account scopes and content fields", () => {
  const directScope = safeAccountScopedTelemetry();
  directScope.usageEvents[0].accountTrackId = `account:v1:${"a".repeat(64)}`;
  assert.throws(
    () => validateAccountScopedTelemetryContribution(directScope),
    telemetryContractFailure(
      "PRIVACY_CANARY_DETECTED",
      "private_projection_invalid",
    ),
  );
  const content = safeAccountScopedTelemetry();
  content.usageEvents[0].prompt = "private";
  assert.throws(
    () => validateAccountScopedTelemetryContribution(content),
    telemetryContractFailure(
      "PRIVACY_CANARY_DETECTED",
      "private_projection_invalid",
    ),
  );
});

test("browser telemetry validation rejects raw-content-shaped and identity fields", () => {
  for (const [key, value] of [
    ["prompt", "private"],
    ["response", "private"],
    ["filePath", "/private/project"],
    ["commandArguments", ["--secret"]],
    ["email", "person@example.test"],
    ["participantId", "person_123"]
  ]) {
    const payload = safeTelemetry();
    payload.usageEvents[0][key] = value;
    assert.throws(
      () => validateTelemetryContribution(payload),
      telemetryContractFailure(
        "PRIVACY_CANARY_DETECTED",
        "privacy_canary_detected",
      ),
    );
  }
});

test("browser telemetry validation rejects synthetic, wrong-schema, oversized, and deeply nested inputs", () => {
  assert.throws(
    () => validateTelemetryContribution({ synthetic: false }),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "schema_version_invalid",
    ),
  );
  const synthetic = safeTelemetry();
  synthetic.synthetic = true;
  assert.throws(
    () => validateTelemetryContribution(synthetic),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "schema_version_invalid",
    ),
  );
  assert.throws(
    () => validateTelemetryContribution(safeTelemetry(), { maxSerializedBytes: 10 }),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_bytes_exceeded",
    ),
  );
  const nested = safeTelemetry();
  nested.extra = { a: { b: { c: 1 } } };
  assert.throws(
    () => validateTelemetryContribution(nested, { maxDepth: 1 }),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_depth_exceeded",
    ),
  );
  const tooMany = safeTelemetry();
  tooMany.usageEvents = Array.from(
    { length: 201 },
    () => structuredClone(tooMany.usageEvents[0]),
  );
  assert.throws(
    () => validateTelemetryContribution(tooMany),
    telemetryContractFailure(
      "TELEMETRY_RECORD_INVALID",
      "maximum_array_items_exceeded",
    ),
  );
});

test("local dashboard normalizer accepts artifact rows and keeps stale state explicit", () => {
  const result = normalizeDashboardPayload({
    schemaVersion: "local-dashboard-v0.1",
    mode: "real_local_evidence",
    status: "stale",
    freshness: { latestObservedAt: "2026-07-25T12:00:00Z", ageSeconds: 7200 },
    quotaWindows: [{
      id: "weekly",
      durationMinutes: 10080,
      usedPercent: 39,
      resetAt: "2026-07-28T17:00:00Z"
    }],
    pricing: {
      estimatedApiCostUsd: 12.34,
      pricedEventCoveragePercent: 91,
      components: { input_uncached: { tokens: 1000, costUsd: 1.25 } }
    },
    gradient: {
      snapshot: {
        datasets: {
          summary: [{ mean_absolute_error_pp: 2.7 }],
          rolling_history: [{ timestamp: "2026-07-25T12:00:00Z", series: "Observed quota change", quota_change_pp: 4 }]
        }
      }
    }
  });
  assert.equal(result.state, "stale");
  assert.equal(result.mode, "real_local_evidence");
  assert.equal(result.quotaWindows[0].remainingPercent, 61);
  assert.equal(result.pricing.totalCostUsd, 12.34);
  assert.equal(result.pricing.basis, "api_price_equivalent");
  assert.equal(result.pricing.apiServiceTier, "unknown");
  assert.equal(result.gradient.summary.mean_absolute_error_pp, 2.7);
  assert.equal(result.gradient.rollingHistory.length, 1);
});

test("history coverage only becomes complete from coherent archive evidence", () => {
  const complete = {
    status: "complete",
    phase: "idle",
    generatedAt: "2026-08-03T12:00:00.000Z",
    coveredAt: {
      startAt: "1970-01-01T00:00:00.000Z",
      endAt: "2026-08-03T12:00:00.000Z",
    },
    sourceCount: 3,
    indexedSourceCount: 3,
    pendingSourceCount: 0,
    sourceBytes: 100,
    indexedBytes: 100,
  };
  assert.equal(
    normalizeDashboardPayload({ pricing: { historyCoverage: complete } })
      .pricing.historyCoverage.status,
    "complete",
  );
  assert.equal(
    normalizeDashboardPayload({
      pricing: {
        historyCoverage: { ...complete, indexedSourceCount: 2 },
      },
    }).pricing.historyCoverage.status,
    "partial",
  );
  assert.equal(
    normalizeDashboardPayload({
      pricing: {
        historyCoverage: { ...complete, status: "scanning", phase: "scanning" },
      },
    }).pricing.historyCoverage.status,
    "partial",
  );
  assert.equal(
    normalizeDashboardPayload({
      pricing: {
        historyCoverage: { ...complete, status: "partial", phase: "awaiting_resume", errorCode: "archive_disk_space" },
      },
    }).pricing.historyCoverage.errorCode,
    "archive_disk_space",
  );
  const terminalGap = {
    status: "partial",
    phase: "partial_terminal",
    generatedAt: "2026-08-03T12:00:00.000Z",
    coveredAt: complete.coveredAt,
    sourceCount: 3,
    indexedSourceCount: 1,
    pendingSourceCount: 0,
    skippedSourceCount: 2,
    skippedSourceBytes: 60,
    skippedThreadCount: 1,
    sourceBytes: 100,
    indexedBytes: 40,
  };
  assert.deepEqual(
    normalizeDashboardPayload({ pricing: { historyCoverage: terminalGap } })
      .pricing.historyCoverage,
    {
      status: "partial",
      phase: "partial_terminal",
      sourceCount: 3,
      indexedSourceCount: 1,
      pendingSourceCount: 0,
      skippedSourceCount: 2,
      skippedSourceBytes: 60,
      skippedThreadCount: 1,
      sourceBytes: 100,
      indexedBytes: 40,
      generatedAt: "2026-08-03T12:00:00.000Z",
      errorCode: null,
      coveredAt: complete.coveredAt,
    },
  );
  assert.equal(
    normalizeDashboardPayload({
      pricing: {
        historyCoverage: { ...terminalGap, skippedSourceBytes: 59 },
      },
    }).pricing.historyCoverage.phase,
    "not_started",
  );
});

test("the cost card drops its metadata line while coverage honesty stays elsewhere", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const localizationSource = await readFile(
    new URL("../public/localization.js", import.meta.url),
    "utf8",
  );
  // The "{percent} coverage · {method}{provenance} · {history}" line under
  // the total is gone (owner-directed, 2026-08-10), together with its "stale
  // replay-safe cache" fragment: the companion had derived that label from
  // wall-clock cache age even though the refresh loop deliberately reuses the
  // cache on passes with no new rollout usage, so it condemned totals that
  // still covered every known usage record.
  assert.doesNotMatch(html, /id="cost-coverage"/u);
  assert.doesNotMatch(
    appSource,
    /cost-coverage|pricingMethodLabel|historyCoverageLabel|pricingRegistryProvenance/u,
  );
  assert.doesNotMatch(
    localizationSource,
    /dashboard\.pricing\.(?:coverage|noCoverage|replaySafe|staleReplaySafe|legacyProjection|registryProvenance|registryObservedAt|history)/u,
  );
  // The surviving coverage honesty surfaces: the history-progress block, the
  // accounting page's coverage sentences, and the routed evidence warnings.
  assert.match(appSource, /renderHistoryProgress\(data\)/u);
  assert.match(localizationSource, /"accounting\.pricing\.partialCoverage":/u);
  assert.match(localizationSource, /"accounting\.pricing\.coverageReviewed":/u);
  assert.match(localizationSource, /"accounting\.pricing\.coverageShort":/u);
  // Every retained usage change is priced at the rate in effect when it
  // occurred, so no surface claims a date before which history was unpriced.
  assert.doesNotMatch(appSource, /thirtyDayCoverageWarning|coverage-warning/u);
  assert.doesNotMatch(localizationSource, /thirtyDayCoverageWarning/u);
  assert.doesNotMatch(appSource, /cost-history-coverage/u);
  assert.doesNotMatch(appSource, /coverage-unpriced|unpricedTokens/u);
  assert.doesNotMatch(appSource, /pricedEventCoveragePercent[^\n]*priced/u);
});

test("a model row carries its own components, and a row without them says so rather than reporting zeroes", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      periodId: "7d",
      byModel: [
        {
          model: "gpt-5.6-sol",
          events: 4,
          totalTokens: 3_300,
          apiPriceEquivalentUsd: 12.5,
          pricingStatus: "priced",
          allowanceTrack: "primary",
          apiPriceEquivalentApplicable: true,
          components: {
            input_cache_read_tokens: 3_000,
            input_uncached_tokens: 200,
            output_text_tokens: 60,
            output_reasoning_tokens: 40,
          },
          componentCosts: {
            input_cache_read_tokens: { tokens: 3_000, costUsd: 1.5 },
            input_uncached_tokens: { tokens: 200, costUsd: 8 },
            output_text_tokens: { tokens: 60, costUsd: 1.8 },
            output_reasoning_tokens: { tokens: 40, costUsd: 1.2 },
          },
        },
        {
          // An older projection that never accumulated a split.
          model: "gpt-5.6-luna",
          events: 2,
          totalTokens: 900,
          apiPriceEquivalentUsd: 0.4,
          pricingStatus: "priced",
          allowanceTrack: "primary",
          apiPriceEquivalentApplicable: true,
        },
      ],
    },
  });
  const [sol, luna] = result.accounting.byModel;

  assert.equal(sol.components.input_cache_read_tokens, 3_000);
  assert.equal(sol.components.output_reasoning_tokens, 40);
  // Keys the row never mentioned are a real zero, because the row did report a
  // split and that split contained none of them.
  assert.equal(sol.components.input_cache_write_tokens, 0);
  assert.equal(sol.componentCosts.input_uncached_tokens.costUsd, 8);
  assert.equal(
    Object.values(sol.componentCosts).reduce((sum, cost) => sum + cost.costUsd, 0),
    sol.apiPriceEquivalentUsd,
  );

  // A row that reported no split at all must stay distinguishable from one
  // that reported an all-zero split: normalising it to six zeroes would make
  // the table draw a complete breakdown the row never claimed.
  assert.equal(luna.components, null);
  assert.equal(luna.componentCosts, null);
  assert.equal(luna.totalTokens, 900);
});

test("the client keeps both allowance tracks and the pricing status of each model", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      periodId: "7d",
      byModel: [
        {
          model: "gpt-5.6-sol",
          events: 193,
          totalTokens: 24_765_904,
          apiPriceEquivalentUsd: 23.8758,
          pricingStatus: "priced",
          allowanceTrack: "primary",
          apiPriceEquivalentApplicable: true,
        },
        {
          model: "codex-auto-review",
          events: 12,
          totalTokens: 4_400,
          apiPriceEquivalentUsd: 0,
          pricingStatus: "known_unpriced",
          allowanceTrack: "primary",
          apiPriceEquivalentApplicable: true,
        },
      ],
      spark: {
        byModel: [
          {
            model: "gpt-5.3-codex-spark",
            events: 8_143,
            totalTokens: 19_004_221,
            apiPriceEquivalentUsd: 0,
            pricingStatus: "known_unpriced",
            allowanceTrack: "spark",
            apiPriceEquivalentApplicable: false,
          },
        ],
      },
    },
  });
  const rows = result.accounting.modelUsage;
  assert.deepEqual(rows.map((row) => row.model), [
    "gpt-5.6-sol",
    "codex-auto-review",
    "gpt-5.3-codex-spark",
  ]);
  // The separately metered track survives the client boundary and keeps the
  // fact that no API-price equivalent is meaningful for it.
  const spark = rows.find((row) => row.model === "gpt-5.3-codex-spark");
  assert.equal(spark.allowanceTrack, "spark");
  assert.equal(spark.apiPriceEquivalentApplicable, false);
  assert.equal(spark.events, 8_143);
  // A recognised model with no published price card is not "unrecognized".
  assert.equal(
    rows.find((row) => row.model === "codex-auto-review").pricingStatus,
    "known_unpriced",
  );
  // A missing figure stays missing rather than becoming a priced zero.
  const missing = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      periodId: "7d",
      byModel: [{ model: "gpt-5.4", events: 3, totalTokens: 9 }],
    },
  });
  assert.equal(missing.accounting.byModel[0].apiPriceEquivalentUsd, null);
});

test("local dashboard retains the pricing epoch required to explain allowance fits", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    pricing: {
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
      eventTimeHistoricalTotalUsdExact: "12.345678",
      currentPriceSensitivityTotalUsdExact: null,
      registryVersion: "app-official-api-prices-v0.2",
      registryObservedAt: "2026-08-01T13:47:00Z",
      evidenceStartDate: "2026-07-26",
      priceCardIds: ["pre-change", "post-change"],
      priceCardBreakdown: [{ priceCardId: "pre-change", events: 1, costUsd: "2.5" }],
      mixedPriceCardWindows: true,
    },
  });
  assert.equal(
    result.pricing.priceEpochBasis,
    "event_time_when_registry_has_effective_evidence",
  );
  assert.equal(result.pricing.eventTimeHistoricalTotalUsdExact, "12.345678");
  assert.equal(result.pricing.currentPriceSensitivityTotalUsdExact, null);
  assert.equal(result.pricing.registryVersion, "app-official-api-prices-v0.2");
  assert.equal(result.pricing.evidenceStartDate, "2026-07-26");
  assert.deepEqual(result.pricing.priceCardIds, ["pre-change", "post-change"]);
  assert.deepEqual(result.pricing.priceCardBreakdown, [
    { priceCardId: "pre-change", events: 1, costUsd: "2.5" },
  ]);
  assert.equal(result.pricing.mixedPriceCardWindows, true);

  const forgedCurrentTotal = normalizeDashboardPayload({
    mode: "real_local_evidence",
    pricing: {
      priceEpochBasis: "event_time_when_registry_has_effective_evidence",
      eventTimeHistoricalTotalUsdExact: "12.345678",
      currentPriceSensitivityTotalUsdExact: "12.345678",
    },
  });
  assert.equal(forgedCurrentTotal.pricing.currentPriceSensitivityTotalUsdExact, null);
});

test("missing numeric evidence stays missing instead of becoming zero", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "insufficient",
    quotaWindows: [{ id: "weekly", usedPercent: null, remainingPercent: null }],
    pricing: { totalCostUsd: null, coveragePercent: null }
  });
  assert.equal(result.quotaWindows[0].usedPercent, null);
  assert.equal(result.quotaWindows[0].remainingPercent, null);
  assert.equal(result.pricing.totalCostUsd, null);
  assert.equal(result.pricing.coveragePercent, null);
});

test("newer-schema accounting remains a terminal unavailable state across the browser boundary", async () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    activity: { toolEvents: null },
    timeline: {
      usage: [],
      history: {
        status: "unavailable",
        reason: "local_unified_index_schema_newer",
        boundedDays: 31,
      },
    },
    accounting: {
      projection: {
        status: "unavailable",
        reason: "local_unified_index_schema_newer",
        terminal: true,
      },
      accountingCacheStatus: "unavailable",
      toolClasses: {
        status: "unavailable",
        reason: "typed_tool_history_partial",
        total: null,
        counts: {
          apply_patch: null,
          local_shell: null,
          other: null,
          subagent: null,
          tool_gateway: null,
        },
      },
      events: 0,
      totalTokens: 0,
      apiPriceEquivalentUsd: 0,
    },
  });
  assert.deepEqual(result.accounting.projection, {
    status: "unavailable",
    reason: "local_unified_index_schema_newer",
    terminal: true,
    retainedAt: null,
    coveredAt: null,
  });
  assert.equal(result.timeline.history.status, "unavailable");
  assert.equal(
    result.timeline.history.reason,
    "local_unified_index_schema_newer",
  );
  assert.equal(result.timeline.history.usageEvents, null);
  assert.equal(result.activity.toolEvents, null);
  assert.equal(result.accounting.toolClasses.total, null);
  assert.ok(Object.values(result.accounting.toolClasses.counts).every(
    (value) => value === null,
  ));

  const appSource = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /function accountingRequiresNewerBuild\(data\)/u);
  assert.match(appSource, /projection\.status !== "available"/u);
  assert.match(appSource, /accountingIsUnavailable\(data\).*activePoints\.length === 0/u);
  assert.match(appSource, /unavailable && visiblePoints\.length === 0[\s\S]*?"—"/u);
  assert.ok(
    appSource.includes('if (projection.status === "unavailable") return null;'),
    "share-card accounting selection closes on terminal unavailable data",
  );
  assert.ok(
    appSource.includes('&& finite(totalCostUsd, 0) <= 0'),
    "a retained zero cost is withheld rather than shared as measured evidence",
  );
  assert.ok(
    appSource.includes('t("share.detail.newerBuildRequired")'),
    "the shared-card unavailable state names the required newer build",
  );
  assert.ok(
    appSource.includes('"share.detail.lastVerifiedNewerBuild"'),
    "retained share-card evidence is labeled last verified and names the newer build",
  );
});

test("a contradictory available accounting attestation fails closed", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      projection: {
        status: "available",
        reason: "local_unified_index_schema_newer",
        terminal: true,
      },
      events: 0,
      totalTokens: 0,
      apiPriceEquivalentUsd: 0,
    },
  });
  assert.deepEqual(result.accounting.projection, {
    status: "unavailable",
    reason: "local_unified_index_unavailable",
    terminal: true,
    retainedAt: null,
    coveredAt: null,
  });
});

test("real local accounting without an authority attestation renders unavailable", async () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    accounting: {
      events: 0,
      totalTokens: 0,
      apiPriceEquivalentUsd: 0,
    },
  });
  assert.deepEqual(result.accounting.projection, {
    status: "unavailable",
    reason: "local_unified_index_unavailable",
    terminal: true,
    retainedAt: null,
    coveredAt: null,
  });

  const appSource = await readFile(
    new URL("../public/app.js", import.meta.url),
    "utf8",
  );
  assert.match(
    appSource,
    /if \(projection\.status !== "available"\)[\s\S]*?\$\("#cost-total"\)\.textContent = retainedEvidence[\s\S]*?: "—";/u,
    "an unavailable real-local projection must render a dash, not its zero placeholders",
  );
});

test("retained accounting provenance admits only reviewed reason codes", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    timeline: {
      history: {
        status: "partial",
        reason: "typed_tool_history_partial",
        coveredAt: {
          startAt: "2026-08-01T00:00:00.000Z",
          endAt: "2026-08-27T00:00:00.000Z",
        },
        usageEvents: 12,
        sourceCount: 3,
        indexBytes: 42,
      },
    },
    accounting: {
      projection: {
        status: "retained",
        reason: "private path /Users/example",
        terminal: true,
        retainedAt: "2026-08-27T00:00:00.000Z",
      },
      staleServe: {
        stale: true,
        reason: "local_unified_index_schema_newer",
        schemaVersion: "local-replay-safe-accounting-v0.13",
        computedAt: "2026-08-27T00:00:00.000Z",
        coveredAt: {
          startAt: "2026-08-01T00:00:00.000Z",
          endAt: "2026-08-27T00:00:00.000Z",
        },
        periods: [{
          periodId: "7d",
          periodLabel: "Last 7 days",
          events: 12,
          totalTokens: 123,
          apiPriceEquivalentUsd: 1.25,
        }],
      },
    },
  });
  assert.equal(
    result.accounting.projection.reason,
    "local_unified_index_unavailable",
  );
  assert.equal(
    result.accounting.staleServe.reason,
    "local_unified_index_schema_newer",
  );
  assert.equal(result.timeline.history.reason, "typed_tool_history_partial");
});

test("new accounting caveats survive the closed dashboard normalizer", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "stale",
    monitoringGaps: [
      { id: "provider_accounting_changes", status: "uncertain" },
      { id: "unknown_token_components", status: "observed_combined" },
      { id: "calculation_disagreement", status: "review_available" }
    ]
  });
  assert.deepEqual(
    result.monitoringGaps.map((row) => [row.id, row.status]),
    [
      ["provider_accounting_changes", "uncertain"],
      ["unknown_token_components", "observed_combined"],
      ["calculation_disagreement", "review_available"]
    ]
  );
});

test("the Fast-mode blind spot reports a share instead of a bare not-observed", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    monitoringGaps: [{ id: "fast_mode", status: "mostly_unknown" }]
  });
  assert.deepEqual(
    result.monitoringGaps.map((row) => [row.id, row.status]),
    [["fast_mode", "mostly_unknown"]]
  );
  // The copy must state the cause, not assert an unqualified absence.
  assert.match(
    result.monitoringGaps[0].explanation,
    /only when it is applied or changed, never at session start/u
  );
  assert.doesNotMatch(result.monitoringGaps[0].explanation, /NOT OBSERVED/iu);
});

test("the closed accounting normalizer keeps the speed-priced metric and its coverage split", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    accounting: {
      periodId: "7d",
      evidenceStartDate: "2026-07-26",
      events: 10,
      apiPriceEquivalentUsd: 20,
      quotaWeightedApiPriceEquivalentUsd: 34,
      speedWeighting: {
        fast: { "gpt-5.6-sol": { events: 4, apiPriceEquivalentUsd: 8 } },
        standard: { "gpt-5.4": { events: 2, apiPriceEquivalentUsd: 4 } },
        unknown: { unsupported: { events: 4, apiPriceEquivalentUsd: 8 } }
      },
      fastMode: {
        unresolvedScenario: "unresolved_as_standard",
        quotaWeightedApiPriceEquivalentUsd: 34,
        standardApiPriceEquivalentUsd: 20,
        unweightedUnknownApiPriceEquivalentUsd: 8,
        weightingStatus: "partial",
        appliedMultipliers: { "gpt-5.6-sol": 2.5 },
        coverage: {
          totalEvents: 10,
          observedEvents: 6,
          assumedEvents: 4,
          inferredEvents: 3,
          unknownEvents: 0,
          observedSharePercent: 60,
          unknownSharePercent: 0
        },
        inference: {
          status: "inferred",
          inferredFastWindows: 2,
          referenceWindowCount: 4,
          scoredWindowCount: 9,
          relativeTolerance: 0.1,
          // A server claiming inference changed the total must not be believed.
          appliedToWeighting: true
        }
      }
    }
  });
  const accounting = result.accounting;
  assert.equal(accounting.quotaWeightedApiPriceEquivalentUsd, 34);
  assert.equal(accounting.apiPriceEquivalentUsd, 20);
  assert.equal(accounting.evidenceStartDate, "2026-07-26");
  assert.equal(accounting.fastMode.unresolvedScenario, "unresolved_as_standard");
  assert.equal(accounting.fastMode.weightingStatus, "partial");
  assert.equal(accounting.fastMode.unweightedUnknownApiPriceEquivalentUsd, 8);
  assert.deepEqual(accounting.fastMode.coverage, {
    totalEvents: 10,
    observedEvents: 6,
    declaredFromConfigEvents: 0,
    assumedEvents: 4,
    inferredEvents: 3,
    unknownEvents: 0,
    observedSharePercent: 60,
    unknownSharePercent: 0
  });
  assert.ok(accounting.fastMode.coverage.inferredEvents
    <= accounting.fastMode.coverage.assumedEvents
      + accounting.fastMode.coverage.unknownEvents);
  // The multipliers and the metric name are stated by this page, never taken
  // from the server, and inference can never be reported as weighted.
  assert.deepEqual(accounting.fastMode.multipliers, { ...FAST_MODE_QUOTA_MULTIPLIERS });
  assert.equal(accounting.fastMode.metricLabel, "Speed-priced API-price equivalent");
  assert.equal(accounting.fastMode.inference.appliedToWeighting, false);
  assert.equal(accounting.fastMode.inference.inferredFastWindows, 2);
  assert.equal(accounting.fastMode.logRecordsTierChangesOnly, true);
  assert.equal(accounting.speedWeighting.fast["gpt-5.6-sol"].events, 4);
  assert.equal(accounting.speedWeighting.unknown.unsupported.apiPriceEquivalentUsd, 8);
  assert.equal(accounting.speedWeighting.fast["gpt-5.5"].events, 0);
});

test("config-only speed provenance survives normalization and appears in the rendered coverage sentence", async () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    accounting: {
      fastMode: {
        coverage: {
          totalEvents: 4,
          observedEvents: 0,
          declaredFromConfigEvents: 4,
          assumedEvents: 0,
          inferredEvents: 0,
          unknownEvents: 0,
          observedSharePercent: 0,
          unknownSharePercent: 0
        }
      }
    }
  });
  assert.equal(result.accounting.fastMode.coverage.declaredFromConfigEvents, 4);
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const match = source.match(/function fastModeCoverageSentence\(fastMode\) \{[\s\S]*?\n\}/u);
  assert.ok(match);
  const render = new Function("t", "compact", "formatPercent", "formatApiMoney",
    `${match[0]}; return fastModeCoverageSentence;`)(
    (key, values) => translate(key, values, "en"),
    String, (value) => `${value}%`, String,
  );
  assert.match(render(result.accounting.fastMode), /4 declared by timestamped Codex config/u);
  for (const locale of SUPPORTED_LOCALES) {
    const sentence = translate("accounting.fastMode.declaredFromConfig", { count: "4" }, locale);
    assert.ok(sentence.includes("4"));
    assert.ok(sentence.includes("Codex"));
    assert.notEqual(sentence, "accounting.fastMode.declaredFromConfig");
  }
});

test("an absent or hostile Fast-mode projection degrades to an explicit unknown", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    accounting: {
      events: 3,
      apiPriceEquivalentUsd: 5,
      quotaWeightedApiPriceEquivalentUsd: -12,
      fastMode: { unresolvedScenario: "turbo", weightingStatus: "definitely" }
    }
  });
  assert.equal(result.accounting.quotaWeightedApiPriceEquivalentUsd, null);
  assert.equal(
    result.accounting.fastMode.unresolvedScenario,
    "unresolved_as_standard",
  );
  assert.equal(result.accounting.fastMode.weightingStatus, "unknown");
  assert.equal(result.accounting.fastMode.coverage.totalEvents, 0);
  assert.equal(result.accounting.fastMode.inference.status, "not_run");
});

test("live weekly calibration keeps its explicit multi-account ambiguity label", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    weekly: {
      dataClass: "live_replay_safe_cache",
      accountAttribution: {
        status: "historical_unattributed",
        maySpanMultipleAccounts: true,
        label:
          "Historical estimate; account-unattributed and may combine multiple accounts"
      },
      datasets: {
        summary: [{
          median_weekly_value_usd: 1800,
          qualifying_resets: 3
        }]
      }
    }
  });
  assert.equal(result.weekly.dataClass, "live_replay_safe_cache");
  assert.equal(result.weekly.accountAttribution.maySpanMultipleAccounts, true);
  assert.match(result.weekly.accountAttribution.label, /may combine multiple accounts/);
});

test("normal Codex allowance selection uses stable identifiers, not labels", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    quotaWindows: [
      {
        limitId: CODEX_PRIMARY_LIMIT_ID,
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        label: "Límite semanal",
        usedPercent: 39
      },
      {
        limitId: CODEX_SPARK_LIMIT_ID,
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        label: "GPT-5.3-Codex-Spark limit",
        usedPercent: 0
      },
      {
        limitId: "Seven-day allowance",
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        label: "Seven-day allowance",
        usedPercent: 0
      }
    ]
  });
  assert.equal(CODEX_PRIMARY_LIMIT_ID, "codex");
  assert.equal(result.quotaWindows[0].label, "Seven-day allowance");
  // The Spark limit's recognized durations now carry their own fixed names —
  // still derived from (limitId, duration) alone, never from the provider's
  // label string supplied above.
  assert.equal(result.quotaWindows[1].label, "Spark seven-day allowance");
  assert.equal(result.quotaWindows[2].label, "Other observed 7-day allowance");
  assert.equal(result.quotaWindows[0].limitId, CODEX_PRIMARY_LIMIT_ID);
  assert.equal(result.quotaWindows[1].limitId, CODEX_SPARK_LIMIT_ID);
  assert.equal(result.quotaWindows[2].limitId, "unknown");
  assert.equal(isPrimaryCodexQuotaWindow(result.quotaWindows[0]), true);
  assert.equal(isPrimaryCodexQuotaWindow(result.quotaWindows[1]), false);
  assert.equal(isPrimaryCodexQuotaWindow(result.quotaWindows[2]), false);
  assert.equal(
    isPrimaryCodexQuotaWindow({
      limitId: CODEX_PRIMARY_LIMIT_ID,
      durationMinutes: CODEX_FIVE_HOUR_ALLOWANCE_MINUTES,
      label: "Límite de cinco horas"
    }),
    true
  );
  assert.equal(
    isPrimaryCodexWeeklyQuotaWindow({
      limitId: CODEX_PRIMARY_LIMIT_ID,
      durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
      label: "Weekly allowance"
    }),
    true
  );
  assert.doesNotMatch(result.quotaWindows.map((row) => row.label).join(" "), /bengalfox/);
  assert.doesNotMatch(result.quotaWindows.map((row) => row.label).join(" "), /Account/);
});

test("web quota normalization accepts bounded provider windows without monthly claims", () => {
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    quotaWindows: [
      {
        id: "generic",
        limitId: CODEX_PRIMARY_LIMIT_ID,
        slot: "secondary",
        durationMinutes: 43_200,
        usedPercent: 12,
        remainingPercent: 88,
        planType: "pro"
      },
      {
        id: "weekly",
        limitId: CODEX_PRIMARY_LIMIT_ID,
        slot: "primary",
        durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
        usedPercent: 39,
        remainingPercent: 61
      }
    ]
  });
  const generic = result.quotaWindows[0];
  assert.equal(generic.durationMinutes, 43_200);
  assert.equal(formatQuotaWindowDuration(generic.durationMinutes), "30-day");
  assert.equal(generic.label, "Provider-reported 30-day window");
  assert.doesNotMatch(generic.label, /month/i);
  assert.equal(isPrimaryCodexQuotaWindow(generic), true);
  assert.equal(
    selectPrimaryCodexQuotaWindow(result.quotaWindows),
    generic
  );
  assert.equal(
    selectPrimaryCodexQuotaWindow([
      result.quotaWindows[1],
      { ...generic, slot: "primary", id: "generic-primary" }
    ]).id,
    "generic-primary"
  );
  const tied = [
    { ...generic, id: "generic-secondary", slot: "secondary" },
    { ...generic, id: "generic-primary", slot: "primary" },
    { ...generic, id: "generic-primary-later", slot: "primary" }
  ];
  assert.equal(selectPrimaryCodexQuotaWindow(tied).id, "generic-primary");
});

test("web timeline quota normalization accepts documented plan types and fails closed", () => {
  const planTypes = [
    "free",
    "go",
    "plus",
    "pro",
    "business",
    "enterprise",
    "edu",
    "team",
    "unknown"
  ];
  const result = normalizeDashboardPayload({
    mode: "real_local_evidence",
    status: "live",
    timeline: {
      quota: planTypes.map((planType) => ({
        observedAt: "2026-08-03T12:00:00.000Z",
        usedPercent: 10,
        remainingPercent: 90,
        planType
      }))
    }
  });
  assert.deepEqual(
    result.timeline.quota.map((row) => row.planType),
    planTypes
  );

  const invalid = normalizeDashboardPayload({
    timeline: {
      quota: [{
        observedAt: "2026-08-03T12:00:00.000Z",
        usedPercent: 10,
        remainingPercent: 90,
        planType: "pro-20x"
      }]
    }
  });
  assert.equal(invalid.timeline.quota[0].planType, "unknown");
});

test("web timeline expands the compact weighted tuple and rejects encoding drift", () => {
  const encoding = {
    schemaVersion: "quota-weighted-timeline-v0.1",
    basisFamilyId:
      "codex_primary:speed_priced_api_equivalent:v3:priority_card_ratio_2026_08_30:event_time:observed_declared_scenario",
    scenarioOrder: [
      "unresolved_as_standard",
      "unresolved_as_fast"
    ],
    selectedScenario: "unresolved_as_standard"
  };
  const row = {
    startAt: "2026-08-03T12:00:00.000Z",
    endAt: "2026-08-03T12:15:00.000Z",
    usageEvents: 2,
    totalTokens: 200,
    apiPriceEquivalentUsd: 10,
    // Two eight-cell scenario blocks: status, weighted USD, covered USD,
    // observed, declared, assumed, inferred, unresolved.
    allowanceWeighting: [
      0, 10, 10, 0, 0, 2, 0, 0,
      0, 25, 25, 0, 0, 2, 0, 0
    ]
  };
  const normalized = normalizeDashboardPayload({
    timeline: {
      allowanceWeightingEncoding: encoding,
      usage: [row]
    }
  });
  assert.equal(normalized.timeline.usage.length, 1);
  assert.equal(
    normalized.timeline.usage[0].allowanceWeighting.selectedUsd,
    10
  );
  assert.equal(
    normalized.timeline.usage[0].allowanceWeighting.scenarios
      .unresolved_as_fast.quotaWeightedUsd,
    25
  );
  assert.equal(
    normalized.timeline.usage[0].allowanceWeighting.scenarios
      .unresolved_as_standard.coverage.assumedEvents,
    2
  );

  const malformedTuple = normalizeDashboardPayload({
    timeline: {
      allowanceWeightingEncoding: encoding,
      usage: [{ ...row, allowanceWeighting: row.allowanceWeighting.slice(1) }]
    }
  });
  assert.deepEqual(malformedTuple.timeline.usage, []);

  const mismatchedEncoding = normalizeDashboardPayload({
    timeline: {
      allowanceWeightingEncoding: {
        ...encoding,
        scenarioOrder: [...encoding.scenarioOrder].reverse()
      },
      usage: [row]
    }
  });
  assert.deepEqual(mismatchedEncoding.timeline.usage, []);
});

test("web quota normalization rejects malformed and out-of-range durations", () => {
  for (const durationMinutes of [
    0,
    -1,
    1.5,
    525_601,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    "not-a-duration"
  ]) {
    const result = normalizeDashboardPayload({
      mode: "real_local_evidence",
      status: "live",
      quotaWindows: [{
        limitId: CODEX_PRIMARY_LIMIT_ID,
        durationMinutes,
        usedPercent: 1,
        remainingPercent: 99
      }]
    });
    const row = result.quotaWindows[0];
    assert.equal(row.durationMinutes, null, String(durationMinutes));
    assert.equal(row.label, "Other observed allowance", String(durationMinutes));
    assert.equal(isPrimaryCodexQuotaWindow(row), false, String(durationMinutes));
  }
  assert.equal(isValidQuotaWindowDuration(1), true);
  assert.equal(isValidQuotaWindowDuration(525_600), true);
  assert.equal(isValidQuotaWindowDuration(525_601), false);
});

test("account-scoped normalization keeps generic and seven-day tracks separate", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    accountScopedQuotaAnalysis: {
      schemaVersion: "account-scoped-quota-analysis-v0.1",
      status: "ready",
      tracks: [
        {
          continuity: {
            provider: "openai_codex",
            planType: "pro-20x",
            planVariant: "pro-20x",
            limitId: CODEX_PRIMARY_LIMIT_ID,
            windowDurationMinutes: 43_200,
            policyEpoch: "openai_agentic_pool_2026_07_09"
          },
          calibration: { tracks: [] },
          rolling: { status: "not_testable" }
        },
        {
          continuity: {
            provider: "openai_codex",
            planType: "pro",
            planVariant: "pro-20x",
            limitId: CODEX_PRIMARY_LIMIT_ID,
            windowDurationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
            policyEpoch: "openai_agentic_pool_2026_07_09"
          },
          calibration: { tracks: [] },
          rolling: { status: "not_testable" }
        },
        {
          continuity: {
            provider: "openai_codex",
            planType: "pro",
            planVariant: "pro-20x",
            limitId: CODEX_PRIMARY_LIMIT_ID,
            windowDurationMinutes: 0,
            policyEpoch: "openai_agentic_pool_2026_07_09"
          },
          calibration: { tracks: [] },
          rolling: { status: "not_testable" }
        }
      ]
    }
  });
  assert.equal(result.accountScopedQuotaAnalysis.status, "ready");
  assert.deepEqual(
    result.accountScopedQuotaAnalysis.tracks.map((track) => track.windowDurationMinutes),
    [43_200, CODEX_WEEKLY_ALLOWANCE_MINUTES]
  );
  assert.deepEqual(
    result.accountScopedQuotaAnalysis.tracks.map((track) => track.planType),
    ["unknown", "pro"]
  );
  assert.doesNotMatch(
    JSON.stringify(result.accountScopedQuotaAnalysis),
    /monthly/i
  );
});

test("quota presentation keeps Spark separate and weekly surfaces exact", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /isSparkQuotaLimitId/u);
  assert.match(appSource, /const sparkWindows = data\.quotaWindows\.filter/u);
  assert.match(appSource, /const otherWindows = data\.quotaWindows\.filter/u);
  assert.match(appSource, /\.\.\.otherOrderedWindows/u);
  assert.match(appSource, /quota-card-spark/u);
  assert.match(appSource, /dashboard\.quota\.windowSpark/u);
  // The Spark limit's two recognized windows carry duration-named titles; the
  // duration-blind windowSpark key stays as the honest generic fallback only.
  assert.match(appSource, /dashboard\.quota\.windowSparkFiveHour/u);
  assert.match(appSource, /dashboard\.quota\.windowSparkSevenDay/u);
  assert.match(appSource, /dashboard\.quota\.windowOtherDuration/u);
  assert.match(appSource, /dashboard\.quota\.windowNamedObserved/u);
  assert.match(appSource, /dashboard\.quota\.spark/u);
  assert.match(appSource, /const normalWindows = data\.quotaWindows\.filter\(isPrimaryCodexQuotaWindow\)/u);
  assert.match(appSource, /rows\.filter\(isPrimaryCodexWeeklyQuotaWindow\)/u);
  assert.match(appSource, /title: \{ key: "weekly\.chart\.title" \}/u);
  assert.doesNotMatch(appSource, /renderAccountScopedQuotaAnalysis/u);
});

test("local split overview contract derives quota and seven-day pricing without exposing identities", () => {
  const result = normalizeDashboardPayload({}, {
    overview: {
      schemaVersion: "local-companion-v0.1",
      mode: "real_local_evidence",
      evidenceStatus: "available",
      latestEvidenceAt: "2026-07-25T12:00:00.000Z",
      freshness: { status: "live", ageSeconds: 30 },
      quota: {
        observedAt: "2026-07-25T12:00:00.000Z",
        windows: [{
          limitId: "codex",
          slot: "secondary",
          planType: "pro",
          usedPercent: 39,
          durationMinutes: 10080,
          resetAt: "2026-07-28T17:00:00.000Z"
        }]
      },
      usage: [
        { id: "24h", label: "Last 24 hours", events: 1, apiPriceEquivalentUsd: 1, pricedEventFraction: 1 },
        {
          id: "7d",
          label: "Last 7 days",
          events: 50,
          apiPriceEquivalentUsd: 511.64,
          pricedEventFraction: .55014,
          components: { input_uncached_tokens: 1000, output_text_tokens: 200 }
        }
      ],
      pricing: { apiServiceTier: "standard" }
    }
  });
  assert.equal(result.state, "live");
  assert.equal(result.quotaWindows[0].remainingPercent, 61);
  assert.equal(result.quotaWindows[0].observedAt, "2026-07-25T12:00:00.000Z");
  assert.equal(result.pricing.totalCostUsd, 511.64);
  assert.equal(result.pricing.coveragePercent, 55.014);
  assert.equal(result.pricing.components.length, 2);
  assert.equal(Object.hasOwn(result, "reports"), false);
});

test("demo data is labeled demo at the contract root and has multiple useful sections", () => {
  const result = demoDashboard();
  assert.equal(result.mode, "demo");
  assert.equal(result.state, "demo");
  assert.ok(result.quotaWindows.length >= 2);
  assert.ok(result.quotaWindows.every(isPrimaryCodexQuotaWindow));
  assert.ok(result.gradient.rolling.length > 20);
  assert.deepEqual(
    [...new Set(result.gradient.rolling.map((row) => row.smoothing_hours))].sort(),
    [1, 2, 3]
  );
  assert.ok(result.weekly.weeklyValues.length > 5);
  assert.ok(result.quality.opportunities.length > 2);
});

test("local client requests only implemented split endpoints", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/overview")) {
        return new Response(JSON.stringify({ schemaVersion: "split", status: "insufficient" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal((await client.load()).schemaVersion, "split");
  assert.deepEqual(calls, [
    "/api/local/overview",
    "/api/local/gradient",
    "/api/local/weekly",
    "/api/local/quality"
  ]);
});

test("local refresh uses the closed same-origin contract and exposes polling", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ refresh: { status: "succeeded" } }), {
        status: options.method === "POST" ? 202 : 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.refresh();
  await client.recalculateDetailedAccounting();
  await client.refreshStatus();
  assert.equal(calls[0].url, "/api/local/refresh/quick");
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.equal(calls[1].url, "/api/local/refresh");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[2].url, "/api/local/refresh");
  assert.equal(calls[2].options.method, undefined);
});

test("local health exposes the content-free preparation mode", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        capabilities: {
          contributionPreparationIdentityMode: "production_keychain"
        }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(
    (await client.health()).capabilities.contributionPreparationIdentityMode,
    "production_keychain"
  );
  assert.deepEqual(calls, ["/api/local/health"]);
});

test("local onboarding is path-free, bounded, and fails closed", async () => {
  const payload = {
    schemaVersion: LOCAL_ONBOARDING_SCHEMA_VERSION,
    status: "ready",
    source: {
      status: "ready",
      sessionsReadable: true,
      archivedSessionsReadable: false,
      rolloutFilesPresent: true,
      rolloutFilesObserved: 42,
      rolloutFilesObservedCapped: false
    },
    state: { status: "ready", writable: true },
    capabilities: {
      explicitRefresh: true,
      customCodexHomeConfigured: false,
      rawContentExposed: false,
      arbitraryPathAccess: false
    }
  };
  assert.deepEqual(normalizeLocalOnboarding(payload), {
    state: "ready",
    sourceStatus: "ready",
    sessionsReadable: true,
    archivedSessionsReadable: false,
    rolloutFilesPresent: true,
    rolloutFilesObserved: 42,
    rolloutFilesObservedCapped: false,
    stateStatus: "ready",
    stateWritable: true,
    explicitRefresh: true,
    customCodexHomeConfigured: false
  });
  assert.equal(
    normalizeLocalOnboarding({
      ...payload,
      privatePath: "/Users/private/.codex"
    }).state,
    "unavailable"
  );
  assert.equal(
    normalizeLocalOnboarding({
      ...payload,
      capabilities: {
        ...payload.capabilities,
        rawContentExposed: true
      }
    }).state,
    "unavailable"
  );

  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.onboarding()).state, "ready");
  assert.deepEqual(calls, ["/api/local/onboarding"]);
});

test("local contribution queue status remains bounded and fails closed", async () => {
  const normalized = normalizeContributionSyncStatus({
    schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
    status: "available",
    paused: false,
    counts: {
      pending: 2,
      inFlight: 1,
      accepted: 8,
      retryable: 3,
      rejected: 1
    },
    dueNow: 2,
    nextAttemptAt: "2026-07-26T13:00:00.000Z",
    lastAcceptedAt: "2026-07-26T12:00:00.000Z",
    includesContent: false,
    includesPaths: false,
    includesCredentials: false,
    privatePath: "/Users/private",
    deviceSecret: "must-not-survive"
  });
  assert.equal(normalized.state, "attention");
  assert.equal(normalized.counts.accepted, 8);
  assert.equal(Object.hasOwn(normalized, "privatePath"), false);
  assert.equal(Object.hasOwn(normalized, "deviceSecret"), false);

  assert.deepEqual(
    normalizeContributionSyncStatus({
      schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
      status: "available",
      paused: false,
      counts: {
        pending: 0,
        inFlight: 0,
        accepted: 1,
        retryable: 0,
        rejected: 0
      },
      dueNow: 0,
      includesContent: true,
      includesPaths: false,
      includesCredentials: false
    }).state,
    "unavailable"
  );

  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        schemaVersion: CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION,
        status: "available",
        paused: true,
        counts: {
          pending: 1,
          inFlight: 0,
          accepted: 0,
          retryable: 0,
          rejected: 0
        },
        dueNow: 1,
        nextAttemptAt: null,
        lastAcceptedAt: null,
        includesContent: false,
        includesPaths: false,
        includesCredentials: false
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.contributionSyncStatus()).state, "paused");
  assert.deepEqual(calls, ["/api/local/contribution/sync-status"]);
});

test("contribution diagnostics project only fixed, content-free support state", async () => {
  const payload = {
    schemaVersion: "local-contribution-diagnostics-v0.1",
    journeyPhase: "approved_connection_needed",
    previewState: "retry_wait",
    queueState: "retry_wait",
    consent: { approved: true, current: true },
    signedIn: { observed: true, value: true },
    pairing: { observed: true, paired: false },
    recentDiagnosticReferences: [{
      reference: "TT-7QF3K2",
      recordedAt: "2026-08-19T13:01:00.000Z",
    }],
    includesTokens: false,
    includesOauthState: false,
    includesVerifiers: false,
    includesDeviceIdentifiers: false,
    includesAccountIdentifiers: false,
    includesContent: false,
    includesPaths: false,
  };
  const normalized = normalizeLocalContributionDiagnostics(payload);
  assert.deepEqual(normalized, {
    status: "available",
    journeyPhase: "approved_connection_needed",
    previewState: "retry_wait",
    queueState: "retry_wait",
    consent: { approved: true, current: true },
    signedIn: { observed: true, value: true },
    pairing: { observed: true, paired: false },
    recentDiagnosticReferences: [{
      reference: "TT-7QF3K2",
      recordedAt: "2026-08-19T13:01:00.000Z",
    }],
  });
  for (const unsafe of [
    { ...payload, includesTokens: true },
    { ...payload, token: "must-not-survive" },
    { ...payload, path: "/Users/private/canary" },
    {
      ...payload,
      recentDiagnosticReferences: [{
        reference: "TT-7QF3K2",
        recordedAt: "/Users/private/canary",
      }],
    },
  ]) {
    assert.equal(
      normalizeLocalContributionDiagnostics(unsafe).status,
      "unavailable",
    );
  }

  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal((await client.contributionDiagnostics()).status, "available");
  assert.deepEqual(calls, [{
    url: "/api/local/diagnostics/contribution",
    options: { headers: { Accept: "application/json" } },
  }]);
});

test("the local OAuth recovery client is fixed-route, exact-shape, and fail closed", async () => {
  const state = "s".repeat(64);
  const verifier = "v".repeat(64);
  const startedAt = Date.parse("2026-08-19T12:00:00.000Z");
  const pending = {
    schemaVersion: "local-hosted-signin-handoff-v1",
    status: "pending",
    provider: "google",
    state,
    verifier,
    startedAt,
    expiresAt: startedAt + 15 * 60 * 1_000,
  };
  assert.deepEqual(normalizeHostedSignInHandoff(pending), {
    status: "pending",
    provider: "google",
    state,
    verifier,
    startedAt,
    expiresAt: startedAt + 15 * 60 * 1_000,
  });
  for (const invalid of [
    { ...pending, proof: "must-not-pass" },
    { ...pending, verifier: "short" },
    { ...pending, expiresAt: startedAt + 1 },
  ]) {
    assert.equal(normalizeHostedSignInHandoff(invalid).status, "unavailable");
  }

  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const action = options.body ? JSON.parse(options.body).action : "read";
      const payload = action === "clear"
        ? {
          schemaVersion: "local-hosted-signin-handoff-v1",
          status: "absent",
        }
        : pending;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal((await client.hostedSignInHandoff()).status, "pending");
  assert.equal((await client.storeHostedSignInHandoff({
    provider: "google",
    state,
    verifier,
  })).status, "pending");
  assert.equal((await client.clearHostedSignInHandoff()).status, "absent");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(
      call.url,
      "/api/local/identity/hosted-signin-handoff",
    );
    assert.equal(call.options.headers["X-Usage-Monitor-Local"], "1");
  }
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: "store",
    provider: "google",
    state,
    verifier,
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), { action: "clear" });
});

test("the browser client no longer exposes automatic contribution controls", () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error("retired automatic contribution route was called");
    }
  });

  assert.equal(client.automaticContributionStatus, undefined);
  assert.equal(client.enableAutomaticContribution, undefined);
  assert.equal(client.disableAutomaticContribution, undefined);
  assert.deepEqual(calls, []);
});

test("local reviewed-queue and device pairing stay behind fixed loopback routes", async () => {
  const privateCanary = "/Users/private/telemetry-secret.json";
  const previewPayload = {
    schemaVersion: CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION,
    status: "available",
    state: "ready",
    discoveredSets: 1,
    newlyQueued: 1,
    deliveryConfigured: true,
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    item: {
      schemaVersion: "telemetry-contribution-v0.1",
      clientPlatform: "macos",
      providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
      coveredAt: {
        startAt: "2026-07-26T12:00:00.000Z",
        endAt: "2026-07-26T12:30:00.000Z"
      },
      recordCounts: {
        usageEvents: 2,
        quotaSnapshots: 1,
        activityMarkers: 0,
        total: 3
      },
      accounting: {
        estimatedApiCostUsd: "1.250000",
        pricedEventCoveragePercent: 100,
        unknownModelEventCount: 0,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
        verification: "client_declared_unverified"
      },
      preparedBytes: 4096,
      reservedUploadBytes: 16384,
      attemptCount: 0,
      nextAttemptAt: "2026-07-26T13:00:00.000Z",
      privatePath: privateCanary,
      contributionId: "contribution:private"
    }
  };
  const normalizedPreview = normalizeContributionSyncPreview(previewPayload);
  assert.equal(normalizedPreview.state, "ready");
  assert.equal(normalizedPreview.item.recordCounts.total, 3);
  assert.equal(JSON.stringify(normalizedPreview).includes(privateCanary), false);
  assert.equal(JSON.stringify(normalizedPreview).includes("contribution:"), false);
  assert.equal(
    normalizeContributionSyncPreview({
      ...previewPayload,
      includesIdentifiers: true
    }).status,
    "unavailable"
  );

  const runPayload = {
    schemaVersion: CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION,
    status: "completed",
    discoveredSets: 1,
    newlyQueued: 0,
    processed: 1,
    accepted: 1,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 16384,
    bandwidthLimited: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    privatePath: privateCanary
  };
  assert.deepEqual(normalizeContributionSyncRun(runPayload), {
    status: "completed",
    discoveredSets: 1,
    newlyQueued: 0,
    processed: 1,
    accepted: 1,
    retryable: 0,
    rejected: 0,
    reservedUploadBytes: 16384,
    bandwidthLimited: false
  });

  const calls = [];
  const pairedPayload = {
    schemaVersion: "local-contribution-device-pairing-v0.1",
    status: "paired",
    scope: "upload_registration",
    expiresAt: "2026-07-26T14:00:00.000Z",
    includesCredentials: false,
    includesIdentifiers: false
  };
  assert.equal(
    normalizeLocalContributionDevicePairing(pairedPayload).status,
    "paired"
  );
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      const body = url.endsWith("device-pair") ? pairedPayload : previewPayload;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await client.contributionSyncPreview()).state, "ready");
  const pairingCode =
    "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(
    (await client.pairContributionDevice(pairingCode)).status,
    "paired"
  );
  assert.equal(client.runContributionSyncOnce, undefined);
  assert.equal(client.setContributionSyncPaused, undefined);
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/local/contribution/sync-next",
    "/api/local/contribution/device-pair"
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["X-Usage-Monitor-Local"], "1");
  }
  assert.equal(calls[0].options.body, "{}");
  assert.equal(calls[1].options.body, JSON.stringify({ pairingCode }));
});

test("the local review bootstrap is independent of delivery scheduling", () => {
  assert.equal(
    contributionReviewBootstrapAction({
      status: "available",
      state: "empty",
      item: null,
    }),
    "prepare",
    "a clean queue prepares one local review instance",
  );

  for (const state of ["ready", "retry_wait", "paused"]) {
    assert.equal(isContributionReviewableQueueState(state), true, state);
    assert.equal(
      contributionReviewBootstrapAction({
        status: "available",
        state,
        item: {},
      }),
      "review",
      `${state} changes delivery timing, not whether the verified payload can be reviewed`,
    );
  }

  for (const preview of [
    null,
    { status: "unavailable", state: "unavailable", item: null },
    { status: "not_configured", state: "unavailable", item: null },
    { status: "available", state: "paused", item: null },
    { status: "available", state: "paused", item: [] },
  ]) {
    assert.equal(
      contributionReviewBootstrapAction(preview),
      "unavailable",
      "a missing or unusable review must become an explicit recovery state",
    );
  }
});

test("the prepare bootstrap requires a positively read pre-consent verdict", () => {
  assert.equal(
    contributionReviewPreparationPermitted({
      status: "available",
      consent: { approved: false, current: false, consentedAt: null },
    }),
    true,
    "a fresh Mac's ceremony prepares its review instance",
  );
  assert.equal(
    contributionReviewPreparationPermitted({
      status: "available",
      consent: { approved: true, current: false, consentedAt: "2026-08-08T17:31:13.735Z" },
    }),
    true,
    "a consent-version change legitimately needs a fresh review",
  );
  assert.equal(
    contributionReviewPreparationPermitted({
      status: "available",
      consent: { approved: true, current: true, consentedAt: "2026-08-08T17:31:13.735Z" },
    }),
    false,
    "an approved Mac never mints a set the v0.1 queue cannot deliver",
  );
  for (const status of [
    null,
    undefined,
    { status: "unavailable", consent: { approved: false, current: false } },
    { status: "not_configured", consent: { approved: false, current: false } },
  ]) {
    assert.equal(
      contributionReviewPreparationPermitted(status),
      false,
      "an unreadable consent verdict must never prepare",
    );
  }
});

test("a local review operation cannot leave onboarding busy forever", async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    withContributionReviewDeadline(neverSettles, {
      timeoutMilliseconds: 1,
    }),
    (error) => error?.code === "local_review_timed_out",
  );

  assert.equal(
    await withContributionReviewDeadline(Promise.resolve("reviewed"), {
      timeoutMilliseconds: 100,
    }),
    "reviewed",
    "a normal local review is unchanged",
  );
  await assert.rejects(
    withContributionReviewDeadline(Promise.reject(new Error("original")), {
      timeoutMilliseconds: 100,
    }),
    /original/u,
    "a real failure is not rewritten as a timeout",
  );
});

test("late review responses cannot overwrite a newer retry", () => {
  const fence = createLatestContributionReviewFence();
  const first = fence.begin();
  assert.equal(fence.isCurrent(first), true);
  const retry = fence.begin();
  assert.equal(fence.isCurrent(first), false, "the superseded response is fenced");
  assert.equal(fence.isCurrent(retry), true, "only the latest retry may commit");
  assert.equal(fence.current(), retry);
});


test("local pairing preserves fixed identifier-shaped codes and drops anything else", async () => {
  const pairingCode =
    "um_pair_00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const rejectingClient = (error, status = 409) => new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error,
    }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
  // Every fixed companion code survives, so the page can explain the actual
  // cause instead of collapsing all of them into one vague sentence.
  for (const [code, status] of [
    ["contribution_device_recovery_required", 409],
    ["contribution_device_keychain_access_denied", 409],
    ["contribution_device_pairing_not_authorized", 403],
    ["contribution_device_pairing_not_configured", 409],
    ["sync_in_progress", 409],
    ["contribution_device_pairing_failed", 502],
    ["unsupported_media_type", 415],
    ["request_too_large", 413],
    ["invalid_json", 400],
    ["invalid_request", 400],
  ]) {
    await assert.rejects(
      rejectingClient({ code }, status).pairContributionDevice(pairingCode),
      (error) => error?.status === status && error?.code === code,
    );
  }

  // Anything that is not an identifier-shaped code cannot reach the page: a
  // sentence, a path, a non-string, or an extra member all drop back to a
  // codeless rejection carrying only the page's own fallback copy.
  for (const error of [
    { code: "Pairing failed at /Users/private/state.json" },
    { code: "MixedCase_Code" },
    { code: 42 },
    { code: "contribution_device_recovery_required", detail: "untrusted" },
  ]) {
    await assert.rejects(
      rejectingClient(error).pairContributionDevice(pairingCode),
      (rejected) => rejected?.status === 409 && rejected?.code === undefined,
    );
  }
});

test("exact prepared review uses a fixed local mutation route", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "contribution-sync-exact-review-v0.1",
        status: "available",
        state: "ready",
        networkActivity: false,
        payloadBytes: 100,
        reviewToken: "r".repeat(43),
        payload: { schemaVersion: "telemetry-contribution-v0.1" }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  await client.contributionSyncExactReview();
  assert.equal(calls[0].url, "/api/local/contribution/sync-inspect-exact");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
});

test("local contribution preparation exposes only verified bounded results", async () => {
  const privateCanary = "/Users/private/raw-rollout.jsonl";
  const payload = {
    schemaVersion: "local-contribution-preparation-result-v0.1",
    status: "prepared",
    coveredAt: {
      startAt: "2026-07-26T12:00:00.000Z",
      endAt: "2026-07-26T13:00:00.000Z"
    },
    recordCounts: {
      usageEvents: 10,
      quotaSnapshots: 2,
      activityMarkers: 1
    },
    privacy: {
      verdict: "passed",
      checksPassed: 8,
      checksFailed: 0,
      sourceTransportReady: false,
      provenanceRetained: true
    },
    prepared: {
      schemaVersion: "prepared-contribution-set-v0.1",
      eligibleSchemaVersion: "telemetry-contribution-v0.1",
      batchCount: 1,
      bytes: 4_096
    },
    networkActivity: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
    privatePath: privateCanary
  };
  const result = normalizeLocalContributionPreparation(payload);
  assert.equal(result.status, "prepared");
  assert.equal(result.recordCounts.usageEvents, 10);
  assert.equal(result.prepared.bytes, 4_096);
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(
    normalizeLocalContributionPreparation({
      ...payload,
      includesPaths: true
    }).status,
    "unavailable"
  );

  const requestedLookbacks = [];
  const successClient = new LocalCompanionClient({
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/local/contribution/prepare");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["X-Usage-Monitor-Local"], "1");
      const request = JSON.parse(options.body);
      assert.deepEqual(Object.keys(request), ["lookbackHours"]);
      assert.ok([1, 24, 7 * 24].includes(request.lookbackHours));
      requestedLookbacks.push(request.lookbackHours);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal((await successClient.prepareContribution()).status, "prepared");
  assert.equal(
    (await successClient.prepareContribution({ lookbackHours: 1 })).status,
    "prepared",
  );
  assert.equal(
    (await successClient.prepareContribution({
      lookbackHours: 7 * 24,
    })).status,
    "prepared",
  );
  assert.deepEqual(requestedLookbacks, [24, 1, 7 * 24]);
  await assert.rejects(
    successClient.prepareContribution({ lookbackHours: 2 }),
    /lookback is invalid/u,
  );
  await assert.rejects(
    successClient.prepareContribution({
      lookbackHours: 24,
      privatePath: "/Users/private",
    }),
    /options are invalid/u,
  );

  const failureClient = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "identity_unavailable",
      privatePath: privateCanary
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    })
  });
  await assert.rejects(
    failureClient.prepareContribution(),
    (error) => error.code === "identity_unavailable"
      && error.message === "Request failed (503)."
      && error.detail === null
      && !JSON.stringify(error).includes(privateCanary)
  );

  const migrationClient = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "identity_migration_required",
      privatePath: privateCanary,
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    migrationClient.prepareContribution(),
    (error) => error.code === "identity_migration_required"
      && error.message === "Request failed (503)."
      && error.detail === null
      && !JSON.stringify(error).includes(privateCanary),
  );

  // export_too_large classifies a whole family of ceilings. The bound the
  // companion named must reach the reader's error, and nothing else may.
  const boundedClient = (detail) => new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-contribution-preparation-error-v0.1",
      status: "failed",
      errorCode: "export_too_large",
      detail,
      privatePath: privateCanary
    }), {
      status: 413,
      headers: { "Content-Type": "application/json" }
    })
  });
  await assert.rejects(
    boundedClient({
      code: "export_resource_expanded_record_bytes",
      observed: 33_554_645,
      limit: 33_554_432
    }).prepareContribution(),
    (error) => error.code === "export_too_large"
      && error.detail.code === "export_resource_expanded_record_bytes"
      && error.detail.observed === 33_554_645
      && error.detail.limit === 33_554_432
      && !JSON.stringify(error).includes(privateCanary)
  );
  for (const hostile of [
    { code: `Failed reading ${privateCanary}`, observed: 2, limit: 1 },
    { code: 42 },
    null
  ]) {
    await assert.rejects(
      boundedClient(hostile).prepareContribution(),
      (error) => error.code === "export_too_large"
        && error.detail === null
        && !JSON.stringify(error).includes(privateCanary)
    );
  }
});

test("community adapter exposes only the current browser-session routes", async () => {
  const calls = [];
  const client = new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.health();
  await client.session();
  await client.createDevicePairing();
  await client.logout();
  assert.equal(calls[0].url, "/api/health");
  assert.equal(calls[1].url, "/api/v1/session");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[2].url, "/api/v1/me/device-pairings");
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[2].options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
  // Re-pinned 2026-08-08 (v1.0 wiring): a telemetry participant's pairing now
  // requests the v1.0 incremental consent identifier. The companion's CLAIM
  // of this pairing is what records the server-side consent-once grant that
  // v1.0 chunk uploads are verified against; the v0.1 identifier here left
  // production refusing every upload with 403 TELEMETRY_CONSENT_INVALID.
  assert.match(calls[2].options.body, /ongoing-privacy-safe-telemetry-v1\.0/);
  assert.doesNotMatch(calls[2].options.body, /ongoing-privacy-safe-telemetry-v0\.1/);
  assert.equal(calls[3].url, "/api/v1/logout");
  assert.equal(calls[3].options.headers["X-Usage-Monitor-CSRF"], "csrf-confirmation");
  await client.enroll("um_invite_test");
  assert.match(calls[4].options.body, /privacy-safe-telemetry-v0\.1/);
  assert.match(calls[4].options.body, /um_invite_test/);
  assert.equal(calls.some(({ options }) => options.method === "DELETE"), false);
  for (const retired of [
    "readiness",
    "recover",
    "registerUpload",
    "contributeSerialized",
    "contribution",
    "deleteContribution",
    "deleteParticipant",
    "personalStats",
    "participantProfile",
    "communityStats",
    "participantExport",
    "devices",
    "revokeDevice",
    "securityReset"
  ]) {
    assert.equal(typeof client[retired], "undefined", retired);
  }
});

test("community enrollment can atomically request one upload-only device pairing", async () => {
  const calls = [];
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "participant-bootstrap-v0.1",
        state: "pairing_ready"
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  await client.enroll(
    "invite-code",
    "telemetry-contribution-v0.1",
    { deviceBootstrap: true }
  );
  assert.equal(calls[0].url, "/api/v1/enroll");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    consentVersion: "privacy-safe-telemetry-v0.1",
    syntheticOnly: false,
    deviceBootstrap: {
      ongoingUpload: true,
      consentVersion: "ongoing-privacy-safe-telemetry-v0.1"
    },
    inviteCode: "invite-code"
  });
});

test("hosted Google sign-in starts, polls, and refuses anything but Google's authorize URL", async () => {
  const calls = [];
  const state = "G".repeat(64);
  let responseStatus = 200;
  let responsePayload = () => ({
    schemaVersion: "identity-google-start-v0.1",
    state,
    authorizeUrl:
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=test.apps.googleusercontent.com&state=${state}`
  });
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(responsePayload()), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const started = await client.identityGoogleStart();
  assert.equal(started.state, state);
  assert.equal(
    started.authorizeUrl.startsWith(
      "https://accounts.google.com/o/oauth2/v2/auth?"
    ),
    true
  );
  assert.equal(calls[0].url, "/api/v1/identity/google/start");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  // The start request carries only SHA-256(verifier): the client keeps the raw
  // verifier and the service still owns the client id, redirect, and PKCE. The
  // start also never returns the verifier or its digest to the page.
  const googleStartBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(googleStartBody), ["binding"]);
  assert.match(googleStartBody.binding, /^[0-9a-f]{64}$/u);
  assert.match(started.verifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.equal(started.authorizeUrl.includes(started.verifier), false);
  assert.equal(started.authorizeUrl.includes(googleStartBody.binding), false);

  // A tampered authorize URL is never handed to window.open.
  for (const authorizeUrl of [
    "https://attacker.example/o/oauth2/v2/auth?client_id=x",
    "https://accounts.google.com.attacker.example/o/oauth2/v2/auth?a=b",
    "https://accounts.google.com/o/oauth2/v2/authorize?a=b",
    "javascript:alert(1)",
    "https://accounts.google.com/o/oauth2/v2/auth"
  ]) {
    responsePayload = () => ({
      schemaVersion: "identity-google-start-v0.1",
      state,
      authorizeUrl
    });
    await assert.rejects(
      client.identityGoogleStart(),
      /usable Google sign-in request/u
    );
  }
  responsePayload = () => ({
    schemaVersion: "identity-google-start-v0.1",
    state: "too-short",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?a=b"
  });
  await assert.rejects(
    client.identityGoogleStart(),
    /usable Google sign-in request/u
  );
  // An Apple start payload can never satisfy a Google start.
  responsePayload = () => ({
    schemaVersion: "identity-apple-start-v0.1",
    state,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?a=b"
  });
  await assert.rejects(
    client.identityGoogleStart(),
    /usable Google sign-in request/u
  );

  responsePayload = () => ({
    schemaVersion: "identity-google-result-v0.1",
    proof: "P".repeat(64)
  });
  const identity = await client.identityGoogleResult(state, started.verifier);
  assert.deepEqual(identity, {
    provider: "google",
    proof: "P".repeat(64),
    verifier: started.verifier
  });
  const resultCall = calls.at(-1);
  assert.equal(resultCall.url, "/api/v1/identity/google/result");
  assert.equal(resultCall.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(resultCall.options.body), {
    state,
    verifier: started.verifier
  });

  await assert.rejects(
    client.identityGoogleResult("short", started.verifier),
    TypeError
  );
  await assert.rejects(
    client.identityGoogleResult(null, started.verifier),
    TypeError
  );
  // A missing or malformed verifier is refused before any request is made.
  await assert.rejects(client.identityGoogleResult(state, "short"), TypeError);
  await assert.rejects(client.identityGoogleResult(state), TypeError);

  // A pending sign-in is a signal to keep polling, not a failure.
  responseStatus = 404;
  responsePayload = () => ({ error: { code: "IDENTITY_RESULT_PENDING" } });
  await assert.rejects(
    client.identityGoogleResult(state, started.verifier),
    (error) => error.status === 404
      && error.code === "IDENTITY_RESULT_PENDING"
  );
  // A consumed, replayed, or expired state is refused outright.
  responseStatus = 401;
  responsePayload = () => ({ error: { code: "IDENTITY_TOKEN_INVALID" } });
  await assert.rejects(
    client.identityGoogleResult(state, started.verifier),
    (error) => error.status === 401 && error.code === "IDENTITY_TOKEN_INVALID"
  );
  responseStatus = 503;
  responsePayload = () => ({ error: { code: "IDENTITY_CONFIGURATION_INVALID" } });
  await assert.rejects(
    client.identityGoogleStart(),
    (error) => error.status === 503
      && error.code === "IDENTITY_CONFIGURATION_INVALID"
  );
  responseStatus = 401;
  responsePayload = () => ({ error: { code: "PRIVATE_DETAIL_MUST_NOT_PASS" } });
  await assert.rejects(
    client.identityGoogleResult(state, started.verifier),
    (error) => error.status === 401 && error.code === undefined
  );
  responseStatus = 200;
  responsePayload = () => ({
    schemaVersion: "identity-google-result-v0.1",
    proof: ""
  });
  await assert.rejects(
    client.identityGoogleResult(state, started.verifier),
    /usable Google sign-in proof/u
  );
});

// The client-side authorization request is gone, not merely unused. It built a
// provider URL in the page, kept a PKCE verifier there, and read the result out
// of a loopback callback's localStorage write — a completion signal the
// dashboard cannot receive when it runs inside the macOS app, whose web view
// refuses every remote origin and shares no storage with the browser that
// finishes the sign-in. Leaving any of it reachable would leave two ways to
// turn a code into an identity, one of them client-controlled.
test("no client-side Google authorization path survives in the shipped modules", async () => {
  const [libSource, appSource, clientSource] = await Promise.all([
    readFile(new URL("../public/lib.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/data-client.js", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of [
    ["lib.js", libSource],
    ["app.js", appSource],
    ["data-client.js", clientSource],
  ]) {
    for (const retired of [
      "createGoogleSignInRequest",
      "parseGoogleSignInResult",
      "GOOGLE_OAUTH_RESULT_STORAGE_KEY",
      "tibotattle-google-oauth-result",
      "identityGoogleExchange",
      "identity/google/exchange",
      "oauth/google/callback",
      "code_challenge",
      "codeVerifier",
    ]) {
      assert.equal(source.includes(retired), false, `${name}: ${retired}`);
    }
  }
  assert.doesNotMatch(
    appSource,
    /sessionStorage|localStorage/u,
    "dashboard presentation never stores a social handoff",
  );
  // The only provider URL any of these modules names is the one the service is
  // required to have built, checked before it is opened.
  assert.equal(
    (clientSource.match(/https:\/\/accounts\.google\.com/gu) ?? []).length,
    1
  );
  assert.equal(libSource.includes("accounts.google.com"), false);
  assert.equal(appSource.includes("accounts.google.com"), false);
});

test("a hosted identity enrolls same-origin with fixed error codes", async () => {
  const calls = [];
  const state = "G".repeat(64);
  const verifier = "V".repeat(64);
  let responseStatus = 200;
  let responsePayload = () => ({
    schemaVersion: "identity-google-result-v0.1",
    proof: "P".repeat(64)
  });
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(responsePayload()), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  const identity = await client.identityGoogleResult(state, verifier);
  assert.deepEqual(identity, {
    provider: "google",
    proof: "P".repeat(64),
    verifier
  });
  assert.equal(calls[0].url, "/api/v1/identity/google/result");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body), { state, verifier });

  await client.enroll(null, "telemetry-contribution-v0.1", {
    deviceBootstrap: true,
    identity
  });
  assert.equal(calls[1].url, "/api/v1/enroll");
  // The verifier is carried through to enrollment so proof consumption is bound
  // to the client that initiated the sign-in.
  assert.deepEqual(JSON.parse(calls[1].options.body).identity, {
    provider: "google",
    proof: "P".repeat(64),
    verifier
  });
  await client.enroll(null, "telemetry-contribution-v0.1", {
    identity: { provider: "apple", proof: "A".repeat(64), verifier }
  });
  assert.deepEqual(JSON.parse(calls[2].options.body).identity, {
    provider: "apple",
    proof: "A".repeat(64),
    verifier
  });
  assert.equal(
    Object.hasOwn(JSON.parse(calls[2].options.body), "deviceBootstrap"),
    false
  );
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "github", proof: "A".repeat(64), verifier }
    }),
    TypeError
  );
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "google", proof: "A".repeat(64), extra: true }
    }),
    TypeError
  );
  // A hosted identity missing its verifier is refused before any request.
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "google", proof: "A".repeat(64) }
    }),
    TypeError
  );
  assert.equal(calls.length, 3);

  responseStatus = 401;
  responsePayload = () => ({ error: { code: "IDENTITY_REQUIRED" } });
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", { identity: null }),
    (error) => error.status === 401 && error.code === "IDENTITY_REQUIRED"
  );

  // Enrollment errors are not hosted-identity endpoint errors. Preserve the
  // service's fixed code and request id so the connection view can tell the
  // user whether storage, enrollment policy, or another specific boundary
  // failed rather than showing a generic retry sentence.
  const requestId = "00000000-0000-4000-8000-000000000007";
  responseStatus = 503;
  responsePayload = () => ({
    error: { code: "BACKEND_STORAGE_UNAVAILABLE", requestId }
  });
  await assert.rejects(
    client.enroll(null, "telemetry-contribution-v0.1", {
      identity: { provider: "google", proof: "P".repeat(64), verifier }
    }),
    (error) => error.status === 503
      && error.code === "BACKEND_STORAGE_UNAVAILABLE"
      && error.requestId === requestId
  );
});

test("hosted Apple sign-in starts, polls, and refuses anything but Apple's authorize URL", async () => {
  const calls = [];
  const state = "S".repeat(64);
  let responseStatus = 200;
  let responsePayload = () => ({
    schemaVersion: "identity-apple-start-v0.1",
    state,
    authorizeUrl:
      `https://appleid.apple.com/auth/authorize?client_id=com.tibotattle.web&state=${state}`
  });
  const client = new CommunityClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(responsePayload()), {
        status: responseStatus,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const started = await client.identityAppleStart();
  assert.equal(started.state, state);
  assert.equal(
    started.authorizeUrl.startsWith("https://appleid.apple.com/auth/authorize?"),
    true
  );
  assert.equal(calls[0].url, "/api/v1/identity/apple/start");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  // The start carries only SHA-256(verifier); the raw verifier stays on the
  // client and is never returned to the page.
  const appleStartBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(appleStartBody), ["binding"]);
  assert.match(appleStartBody.binding, /^[0-9a-f]{64}$/u);
  assert.match(started.verifier, /^[A-Za-z0-9_-]{43,128}$/u);
  assert.equal(started.authorizeUrl.includes(started.verifier), false);
  assert.equal(started.authorizeUrl.includes(appleStartBody.binding), false);

  // A tampered authorize URL is never handed to window.open.
  for (const authorizeUrl of [
    "https://attacker.example/auth/authorize?client_id=x",
    "https://appleid.apple.com.attacker.example/auth/authorize?a=b",
    "javascript:alert(1)",
    "https://appleid.apple.com/auth/authorize"
  ]) {
    responsePayload = () => ({
      schemaVersion: "identity-apple-start-v0.1",
      state,
      authorizeUrl
    });
    await assert.rejects(
      client.identityAppleStart(),
      /usable Apple sign-in request/u
    );
  }
  responsePayload = () => ({
    schemaVersion: "identity-apple-start-v0.1",
    state: "too-short",
    authorizeUrl: "https://appleid.apple.com/auth/authorize?a=b"
  });
  await assert.rejects(
    client.identityAppleStart(),
    /usable Apple sign-in request/u
  );

  responsePayload = () => ({
    schemaVersion: "identity-apple-result-v0.1",
    proof: "A".repeat(64)
  });
  const identity = await client.identityAppleResult(state, started.verifier);
  assert.deepEqual(identity, {
    provider: "apple",
    proof: "A".repeat(64),
    verifier: started.verifier
  });
  const resultCall = calls.at(-1);
  assert.equal(resultCall.url, "/api/v1/identity/apple/result");
  assert.equal(resultCall.options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(resultCall.options.body), {
    state,
    verifier: started.verifier
  });

  await assert.rejects(
    client.identityAppleResult("short", started.verifier),
    TypeError
  );
  await assert.rejects(
    client.identityAppleResult(null, started.verifier),
    TypeError
  );
  await assert.rejects(client.identityAppleResult(state, "short"), TypeError);
  await assert.rejects(client.identityAppleResult(state), TypeError);

  responseStatus = 404;
  responsePayload = () => ({ error: { code: "IDENTITY_RESULT_PENDING" } });
  await assert.rejects(
    client.identityAppleResult(state, started.verifier),
    (error) => error.status === 404
      && error.code === "IDENTITY_RESULT_PENDING"
  );
  responseStatus = 401;
  responsePayload = () => ({ error: { code: "IDENTITY_TOKEN_INVALID" } });
  await assert.rejects(
    client.identityAppleResult(state, started.verifier),
    (error) => error.status === 401 && error.code === "IDENTITY_TOKEN_INVALID"
  );
  responseStatus = 503;
  responsePayload = () => ({ error: { code: "IDENTITY_CONFIGURATION_INVALID" } });
  await assert.rejects(
    client.identityAppleStart(),
    (error) => error.status === 503
      && error.code === "IDENTITY_CONFIGURATION_INVALID"
  );
  responseStatus = 200;
  responsePayload = () => ({
    schemaVersion: "identity-apple-result-v0.1",
    proof: ""
  });
  await assert.rejects(
    client.identityAppleResult(state, started.verifier),
    /usable Apple sign-in proof/u
  );
});

// Every point where the companion health response is stored, paired with the
// statements that follow it, so a test can require what must happen there.
function assignsCompanionHealth(source) {
  const branches = [];
  const assignment = /localCompanionHealth = localHealth;/gu;
  for (let match = assignment.exec(source); match !== null; match = assignment.exec(source)) {
    branches.push(source.slice(match.index, match.index + 600));
  }
  assert.ok(branches.length >= 2, "expected both the startup and recovery health paths");
  return branches;
}


test("backend readiness accepts fail-closed 503 state without calling it ready", async () => {
  const payload = {
    status: "not_ready",
    checks: {
      lifecycle: "stale",
      lifecycleFresh: false,
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      aggregateRebuildComplete: false,
      maintenanceCycleMatched: false,
      quarantineReconciliation: "running",
      quarantineReconciliationComplete: false
    },
    policy: {
      lifecycleStaleAfterMilliseconds: 3_600_000
    }
  };
  assert.equal(typeof CommunityClient.prototype.readiness, "undefined");
  const ready = {
    ...payload,
    status: "ready",
    checks: {
      lifecycle: "ready",
      lifecycleFresh: true,
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      aggregateRebuildComplete: true,
      maintenanceCycleMatched: true,
      quarantineReconciliation: "completed",
      quarantineReconciliationComplete: true
    }
  };
  assert.deepEqual(normalizeBackendReadiness(ready), {
    state: "ready",
    lifecycle: "ready",
    lifecycleFresh: true,
    quarantineRetentionComplete: true,
    restoreReplayComplete: true,
    aggregateRebuildComplete: true,
    maintenanceCycleMatched: true,
    quarantineReconciliation: "completed",
    quarantineReconciliationComplete: true
  });
  assert.equal(
    normalizeBackendReadiness({
      ...ready,
      checks: { ...ready.checks, maintenanceCycleMatched: false }
    }).state,
    "unavailable"
  );
  assert.equal(
    normalizeBackendReadiness({ ...payload, leakedPath: "/private/log" }).state,
    "unavailable"
  );
});

test("retired granular contribution methods are absent from the browser adapter", () => {
  assert.equal(typeof CommunityClient.prototype.contribution, "undefined");
  assert.equal(typeof CommunityClient.prototype.deleteContribution, "undefined");
});

test("historical granular deletion receipts remain parse-only and fail closed", () => {
  const contributionId = "contribution:00000000-0000-4000-8000-000000000001";

  assert.deepEqual(
    normalizeContributionDeletionReceipt(
      { deleted: true, contributionId },
      contributionId
    ),
    { deleted: true, contributionId }
  );

  assert.throws(
    () => normalizeContributionDeletionReceipt({ deleted: true }, contributionId),
    /invalid contribution deletion receipt/
  );
  assert.throws(
    () => normalizeContributionDeletionReceipt(
      {
        deleted: true,
        contributionId: "contribution:00000000-0000-4000-8000-000000000002"
      },
      contributionId
    ),
    /invalid contribution deletion receipt/
  );
  assert.equal(typeof CommunityClient.prototype.deleteContribution, "undefined");
});

test("community snapshots fail closed and never disclose threshold distance", () => {
  const published = normalizeCommunitySnapshot(communitySnapshot());
  assert.equal(published.state, "published");
  assert.equal(published.minimumParticipants, 20);
  assert.equal(published.participantCohort, "provider_account");
  assert.equal(published.cells[0].metrics.usageEvents.value, 30);

  const partialPayload = structuredClone(communitySnapshot());
  partialPayload.cells[0].metrics.outputReasoningTokens = { status: "suppressed" };
  assert.equal(normalizeCommunitySnapshot(partialPayload).state, "published_partial");
  delete partialPayload.cells[0].metrics.outputReasoningTokens;
  assert.equal(normalizeCommunitySnapshot(partialPayload).state, "unsupported_schema");

  const suppressedPayload = {
    ...communitySnapshot(),
    releaseStatus: "suppressed",
    reason: "minimum_cell_support_not_met",
    participantCount: 19,
    cells: []
  };
  const suppressed = normalizeCommunitySnapshot(suppressedPayload);
  assert.equal(suppressed.state, "suppressed");
  assert.equal(Object.hasOwn(suppressed, "participantCount"), false);

  assert.equal(normalizeCommunitySnapshot({
    publicationStatus: "development_diagnostic_not_publication_safe"
  }).state, "development_unsafe");
  assert.equal(normalizeCommunitySnapshot({
    ...communitySnapshot(),
    immutable: false
  }).state, "unsupported_schema");
  assert.equal(normalizeCommunitySnapshot({
    ...communitySnapshot(),
    releaseStatus: "withdrawn",
    cells: []
  }).state, "withdrawn");
  assert.equal(normalizeCommunitySnapshot({
    ...communitySnapshot(),
    releaseStatus: "not_yet_published",
    cells: []
  }).state, "not_yet_published");
});

test("participant v0.2 stats preserve server repricing, coverage states, and speed separation", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    totals: {
      contributions: 2,
      usageEvents: 10,
      quotaSnapshots: 4,
      activityMarkers: 1,
      apiPriceEquivalentUsd: "12.345678",
      serverUnknownBillableUnits: 90,
      fullyPricedEvents: 7,
      partiallyPricedEvents: 2,
      unpricedEvents: 1,
      priceVerification: "server_repriced",
      standardApiCounterfactualUsd: "11.100000",
      standardApiCounterfactualEvents: 8
    },
    insights: [{ code: "fast_event_share", value: 0.3 }],
    rollingQuotaMovement: {
      schemaVersion: "participant-quota-movement-v0.1",
      status: "conditional_estimate",
      accountContinuity: "not_transmitted",
      apiPriceEquivalentCapacityUsd: 617.2839,
      rows: [{
        timestamp: "2026-07-25T14:00:00.000Z",
        windowStartUtc: "2026-07-25T13:00:00.000Z",
        windowEndUtc: "2026-07-25T14:00:00.000Z",
        smoothingHours: 1,
        observedQuotaChangePp: 2,
        expectedQuotaChangePp: 1.8,
        apiPriceEquivalentUsd: "11.100000",
        usageEvents: 8
      }]
    }
  });
  assert.equal(result.state, "ready");
  assert.equal(result.totals.apiPriceEquivalentUsd, 12.345678);
  assert.deepEqual(result.pricingCoverage, {
    state: "partially_priced",
    percent: 90,
    fullyPricedEvents: 7,
    partiallyPricedEvents: 2,
    unpricedEvents: 1,
    unclassifiedEvents: 0
  });
  assert.equal(result.standardApiCounterfactual.apiPriceEquivalentUsd, 11.1);
  assert.equal(result.codexFastObservations.eventShare, 0.3);
  assert.equal(result.rollingQuotaMovement.rows[0].smoothingHours, 1);
  assert.equal(result.rollingQuotaMovement.accountContinuity, "not_transmitted");
});

test("participant stats normalize private account-scoped capacity and sensitivity", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    totals: {
      usageEvents: 20,
      quotaSnapshots: 24,
      apiPriceEquivalentUsd: "45.000000",
      priceVerification: "server_repriced",
      fullyPricedEvents: 20,
      partiallyPricedEvents: 0,
      unpricedEvents: 0
    },
    accountScopedQuotaAnalysis: {
      schemaVersion: "account-scoped-quota-analysis-v0.1",
      status: "ready",
      tracks: [{
        continuity: {
          provider: "openai_codex",
          planType: "pro",
          planVariant: "pro-20x",
          limitId: "codex",
          windowDurationMinutes: 10_080,
          policyEpoch: "openai_agentic_pool_2026_07_09"
        },
        calibration: {
          tracks: [{
            totalResetCount: 3,
            estimatedResetCount: 1,
            resets: [{
              status: "conditional_estimate",
              refusalCodes: [],
              capacityNanousd: 600_000_000_000,
              sensitivityRangeNanousd: {
                lower: 500_000_000_000,
                upper: 700_000_000_000
              },
              boundaryCount: 10,
              displayedSpanPp: 12
            }]
          }]
        },
        rolling: {
          status: "conditional_comparison",
          refusalCodes: [],
          comparisons: [{ smoothingHours: 1 }, { smoothingHours: 2 }]
        }
      }]
    }
  });
  const track = result.accountScopedQuotaAnalysis.tracks[0];
  assert.equal(result.accountScopedQuotaAnalysis.status, "ready");
  assert.equal(track.latestCapacityUsd, 600);
  assert.equal(track.sensitivityLowerUsd, 500);
  assert.equal(track.sensitivityUpperUsd, 700);
  assert.equal(track.rollingComparisonCount, 2);
});

test("private community comparison preserves own clipped versus public rounded semantics", () => {
  const metrics = Object.fromEntries([
    ["usageEvents", "events"],
    ["inputUncachedTokens", "tokens"],
    ["inputCacheReadTokens", "tokens"],
    ["inputCacheWriteTokens", "tokens"],
    ["outputTextTokens", "tokens"],
    ["outputReasoningTokens", "tokens"],
    ["outputCombinedTokens", "tokens"],
    ["toolUnits", "units"]
  ].map(([name, unit]) => [
    name,
    name === "outputReasoningTokens"
      ? { status: "community_not_released" }
      : {
          status: "comparable",
          participantClippedValue: name === "usageEvents" ? 1 : 900,
          communityRoundedValue: name === "usageEvents" ? 20 : 0,
          unit
        }
  ]));
  const normalized = normalizeParticipantCommunityComparison({
    schemaVersion: PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
    status: "ready",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 2,
    period: {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z"
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      participantHasActivity: true,
      metrics,
      participantCount: 20,
      accountTrackId: "must-not-survive"
    }]
  });
  assert.equal(normalized.status, "ready");
  assert.equal(normalized.snapshotRevision, 2);
  assert.equal(normalized.cells[0].metrics.inputCacheReadTokens.participantClippedValue, 900);
  assert.equal(normalized.cells[0].metrics.inputCacheReadTokens.communityRoundedValue, 0);
  assert.equal(normalized.cells[0].metrics.outputReasoningTokens.status, "community_not_released");
  assert.equal(Object.hasOwn(normalized.cells[0], "participantCount"), false);
  assert.equal(Object.hasOwn(normalized.cells[0], "accountTrackId"), false);

  const malformed = structuredClone({
    schemaVersion: PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
    status: "ready",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 2,
    period: {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z"
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      participantHasActivity: true,
      metrics
    }]
  });
  malformed.cells[0].metrics.inputCacheReadTokens.status = "comparable";
  malformed.cells[0].metrics.inputCacheReadTokens.participantClippedValue = -1;
  assert.equal(
    normalizeParticipantCommunityComparison(malformed).reason,
    "comparison_contract_invalid"
  );
  assert.equal(normalizeParticipantCommunityComparison({
    schemaVersion: PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION,
    status: "not_testable",
    reason: "community_snapshot_not_released",
    cells: []
  }).reason, "community_snapshot_not_released");
});

test("participant history keeps lifecycle and provenance bounded and private", async () => {
  const contributionId = "contribution:00000000-0000-4000-8000-000000000001";
  const profile = {
    schemaVersion: PARTICIPANT_PROFILE_SCHEMA_VERSION,
    participantId: "private-server-participant-id",
    createdAt: "2026-07-25T12:00:00.000Z",
    consentVersion: "privacy-safe-telemetry-v0.1",
    contributionCount: 1,
    contributionAdmission: {
      schemaVersion: "telemetry-contribution-admission-v0.1",
      state: "available",
      window: {
        kind: "fixed_utc",
        anchor: "monday_00_00_utc",
        startsAt: "2026-07-27T00:00:00.000Z",
        endsAt: "2026-08-03T00:00:00.000Z",
        durationMilliseconds: 604_800_000,
      },
      acceptedBatches: 37,
      remainingBatches: 63,
      maximumBatches: 100,
      slotRefundPolicy: "not_refunded_by_contribution_deletion",
    },
    historyPolicy: {
      maximumItems: 101,
      quarantineRetentionMilliseconds: 604_800_000,
      canonicalMetadataRetainedAfterQuarantine: true,
      clientSoftwareVersion: "unavailable_in_transport"
    },
    contributions: [{
      contributionId,
      status: "accepted",
      synthetic: false,
      schemaVersion: "telemetry-contribution-v0.1",
      transportSchemaVersion: "telemetry-contribution-v0.1",
      coveredAt: {
        startAt: "2026-07-25T12:00:00.000Z",
        endAt: "2026-07-25T12:30:00.000Z"
      },
      clientPlatform: "macos",
      providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
      recordCounts: { declared: 3, accepted: 2, deduplicated: 1 },
      serverAccounting: {
        apiPriceEquivalentUsd: "0.0032",
        priceBasis: "historical_api_prices",
        priceEpochBasis: "event_time_when_registry_has_effective_evidence",
        eventTimeRange: {
          startAt: "2026-07-25T12:05:00.000Z",
          endAt: "2026-07-25T12:05:00.000Z"
        },
        verification: "server_repriced",
        registrySha256: "private-projected-away"
      },
      quarantine: {
        state: "retained",
        scheduledDeletionAt: "2026-08-01T12:00:00.000Z",
        deletedAt: null,
        canonicalMetadataRetained: true
      },
      createdAt: "2026-07-25T12:00:00.000Z",
      datasetId: "private-projected-away",
      accountTrackId: "private-projected-away"
    }]
  };
  const normalized = normalizeParticipantHistory(profile);
  assert.equal(normalized.state, "ready");
  assert.equal(normalized.items[0].contributionId, contributionId);
  assert.equal(normalized.items[0].recordCounts.deduplicated, 1);
  assert.equal(normalized.items[0].serverAccounting.apiPriceEquivalentUsd, 0.0032);
  assert.equal(normalized.items[0].serverAccounting.priceBasis, "historical_api_prices");
  assert.equal(
    normalized.items[0].serverAccounting.priceEpochBasis,
    "event_time_when_registry_has_effective_evidence",
  );
  assert.deepEqual(normalized.items[0].serverAccounting.eventTimeRange, {
    startAt: "2026-07-25T12:05:00.000Z",
    endAt: "2026-07-25T12:05:00.000Z",
  });
  assert.equal(normalized.items[0].quarantine.state, "retained");
  assert.deepEqual(normalized.contributionAdmission, {
    state: "available",
    acceptedBatches: 37,
    remainingBatches: 63,
    maximumBatches: 100,
    renewsAt: "2026-08-03T00:00:00.000Z",
    slotRefundPolicy: "not_refunded_by_contribution_deletion",
  });
  assert.equal(Object.hasOwn(normalized, "participantId"), false);
  assert.equal(Object.hasOwn(normalized.items[0], "datasetId"), false);
  assert.equal(Object.hasOwn(normalized.items[0], "accountTrackId"), false);
  assert.equal(Object.hasOwn(normalized.items[0].serverAccounting, "registrySha256"), false);

  const badRetention = structuredClone(profile);
  badRetention.contributions[0].quarantine.scheduledDeletionAt =
    "2026-08-02T12:00:00.000Z";
  assert.equal(normalizeParticipantHistory(badRetention).reason, "invalid_contract");

  // Retention disabled: the service publishes a null window, and every
  // contribution must then carry a null schedule rather than a stale date.
  const retentionDisabled = structuredClone(profile);
  retentionDisabled.historyPolicy.quarantineRetentionMilliseconds = null;
  retentionDisabled.contributions[0].quarantine.scheduledDeletionAt = null;
  const disabledHistory = normalizeParticipantHistory(retentionDisabled);
  assert.equal(disabledHistory.state, "ready");
  assert.equal(disabledHistory.items[0].quarantine.scheduledDeletionAt, null);
  assert.equal(disabledHistory.items[0].quarantine.state, "retained");

  const disabledWithSchedule = structuredClone(retentionDisabled);
  disabledWithSchedule.contributions[0].quarantine.scheduledDeletionAt =
    "2026-08-01T12:00:00.000Z";
  assert.equal(
    normalizeParticipantHistory(disabledWithSchedule).reason,
    "invalid_contract",
  );

  const enabledWithoutSchedule = structuredClone(profile);
  enabledWithoutSchedule.contributions[0].quarantine.scheduledDeletionAt = null;
  assert.equal(
    normalizeParticipantHistory(enabledWithoutSchedule).reason,
    "invalid_contract",
  );

  // A zero window is a malformed contract, never "delete immediately".
  const zeroRetention = structuredClone(profile);
  zeroRetention.historyPolicy.quarantineRetentionMilliseconds = 0;
  assert.equal(normalizeParticipantHistory(zeroRetention).reason, "invalid_contract");

  const badCounts = structuredClone(profile);
  badCounts.contributions[0].recordCounts.accepted = 3;
  assert.equal(normalizeParticipantHistory(badCounts).reason, "invalid_contract");

  const duplicateIds = structuredClone(profile);
  duplicateIds.contributions.push(structuredClone(profile.contributions[0]));
  duplicateIds.contributionCount = 2;
  assert.equal(normalizeParticipantHistory(duplicateIds).reason, "invalid_contract");

  const wrongStatus = structuredClone(profile);
  wrongStatus.contributions[0].status = "accepted_synthetic";
  assert.equal(normalizeParticipantHistory(wrongStatus).reason, "invalid_contract");

  const impossibleDeletion = structuredClone(profile);
  impossibleDeletion.contributions[0].quarantine = {
    state: "deleted",
    scheduledDeletionAt: "2026-08-01T12:00:00.000Z",
    deletedAt: "2026-07-25T11:59:59.000Z",
    canonicalMetadataRetained: true
  };
  assert.equal(normalizeParticipantHistory(impossibleDeletion).reason, "invalid_contract");

  const oversized = structuredClone(profile);
  oversized.contributions = Array.from({ length: 102 }, () => profile.contributions[0]);
  oversized.contributionCount = 102;
  assert.equal(normalizeParticipantHistory(oversized).reason, "invalid_contract");

  const invalidAdmission = structuredClone(profile);
  invalidAdmission.contributionAdmission.remainingBatches = 64;
  assert.equal(
    normalizeParticipantHistory(invalidAdmission).reason,
    "invalid_contract",
  );

  const legacyWithoutAdmission = structuredClone(profile);
  delete legacyWithoutAdmission.contributionAdmission;
  assert.equal(
    normalizeParticipantHistory(legacyWithoutAdmission)
      .contributionAdmission.state,
    "unknown",
  );

  assert.equal(typeof CommunityClient.prototype.participantProfile, "undefined");
});

test("participant results fail closed for unverifiable prices and honest not-testable movement", () => {
  const result = normalizeParticipantStats({
    schemaVersion: PARTICIPANT_STATS_SCHEMA_VERSION,
    totals: {
      usageEvents: 0,
      apiPriceEquivalentUsd: "999.000000",
      priceVerification: "client_declared_unverified",
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0
    },
    rollingQuotaMovement: {
      status: "not_testable",
      reason: "no_observed_quota_movement",
      rows: [],
      accountContinuity: "not_transmitted"
    }
  });
  assert.equal(result.totals.apiPriceEquivalentUsd, null);
  assert.equal(result.pricingCoverage.state, "not_testable");
  assert.equal(result.standardApiCounterfactual.state, "not_separately_returned");
  assert.equal(result.codexFastObservations.state, "not_testable");
  assert.equal(result.rollingQuotaMovement.status, "not_testable");
  assert.equal(result.rollingQuotaMovement.reason, "no_observed_quota_movement");
  assert.equal(normalizeParticipantStats({ schemaVersion: "participant-stats-v0.1" }).state, "unsupported_schema");
});


test("native dashboard readiness follows both first-render outcomes", async () => {
  const [html, appSource, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  const markerStart = appSource.indexOf("function markLocalDashboardReady() {");
  const markerEnd = appSource.indexOf(
    "\n}\n\nasync function loadLocalDashboard",
    markerStart,
  );
  const loadStart = appSource.indexOf("async function loadLocalDashboard() {");
  const loadEnd = appSource.indexOf(
    "\n}\n\nfunction renderDashboardSkeleton",
    loadStart,
  );
  assert.ok(markerStart >= 0 && markerEnd > markerStart, "readiness marker is present");
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "dashboard loader is present");

  const marker = appSource.slice(markerStart, markerEnd);
  const loader = appSource.slice(loadStart, loadEnd);
  const bootSurface = html.match(
    /<section[\s\S]*?id="dashboard-boot-state"[\s\S]*?<\/section>/u,
  )?.[0] ?? "";
  assert.ok(bootSurface, "the native dashboard has a static boot surface");
  assert.match(bootSurface, /role="status"/u);
  assert.match(bootSurface, /aria-live="polite"/u);
  assert.match(bootSurface, /aria-busy="true"/u);
  assert.match(bootSurface, /Loading saved results…/u);
  assert.match(
    bootSurface,
    /Checking the summary on this Mac\. Nothing is sent while you look at it\./u,
  );
  const bootOpeningTag = bootSurface.match(/^<section[\s\S]*?>/u)?.[0] ?? "";
  assert.doesNotMatch(bootOpeningTag, /\shidden(?:\s|=|>)/u);
  assert.doesNotMatch(bootSurface, /data-requires-evidence/u);
  assert.match(styles, /\.dashboard-boot-state \{ display: none; \}/u);
  assert.match(
    styles,
    /html\.native-dashboard:not\(\[data-local-dashboard-ready="true"\]\) \.dashboard-boot-state,[\s\S]*?display: grid;/u,
  );
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*?\.dashboard-boot-card \.state-pill \{[\s\S]*?width: max-content;[\s\S]*?font-size: \.67rem;/u,
  );
  assert.match(
    marker,
    /document\.documentElement\.dataset\.localDashboardReady = "true";/u,
  );
  assert.doesNotMatch(marker, /querySelector\('#main'\)|innerText/u);

  const successRender = loader.indexOf("renderDashboard(data);");
  const successMarker = loader.indexOf("markLocalDashboardReady();", successRender);
  const unavailableRender = loader.indexOf("renderDashboardUnavailableState(");
  const unavailableMarker = loader.indexOf("markLocalDashboardReady();", unavailableRender);
  assert.ok(successRender >= 0 && successMarker > successRender);
  assert.ok(unavailableRender >= 0 && unavailableMarker > unavailableRender);
  assert.equal(
    (loader.match(/markLocalDashboardReady\(\)/gu) ?? []).length,
    2,
    "the first available or unavailable render marks readiness exactly once",
  );
});

test("native dashboard readiness does not wait on secondary companion reads", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const loadStart = appSource.indexOf("async function loadLocalDashboard() {");
  const loadEnd = appSource.indexOf(
    "\n}\n\nfunction renderDashboardSkeleton",
    loadStart,
  );
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "dashboard loader is present");

  const loader = appSource.slice(loadStart, loadEnd);
  const successEnd = loader.indexOf("\n  } catch {");
  const successPath = loader.slice(0, successEnd);
  const dashboardRender = successPath.indexOf("renderDashboard(data);");
  const onboardingRender = successPath.indexOf("renderLocalOnboarding(localOnboarding);");
  const readinessMarker = successPath.indexOf("markLocalDashboardReady();");
  const secondary = appSource.match(
    /^async function loadLocalDashboardSecondaryState\([\s\S]*?^\}/mu,
  )?.[0] ?? "";


  assert.ok(dashboardRender >= 0, "the primary dashboard render is present");
  assert.ok(onboardingRender > dashboardRender, "cached onboarding unhides the real result");
  assert.ok(
    readinessMarker > onboardingRender,
    "the native shell is released after the primary render",
  );
  assert.doesNotMatch(loader, /localClient\.(health|onboarding|refreshStatus|contributionSyncPreview|contributionSyncStatus)\(/u);
  assert.doesNotMatch(loader, /await load(?:IncrementalSyncStatus|LocalDashboardSecondaryState)\(/u);
  assert.ok(loader.indexOf("void loadLocalDashboardSecondaryState(") > loader.indexOf("} finally {"),
    "the shared secondary path starts after primary busy state is released");
  for (const method of ["health", "onboarding", "refreshStatus"]) {
    assert.ok(secondary.includes(`localClient.${method}()`));
  }
  assert.doesNotMatch(secondary, /contribution|consent|prepare/iu);
});

test("the primary dashboard owner resumes one deferred Electron startup pass after releasing its lock", async () => {
  const primary = dashboardStartupDeferred();
  const harness = await createDashboardStartupHarness({
    client: { load: () => primary.promise },
  });
  harness.context.electronStartupRefreshDeferred = true;

  const loading = harness.context.loadLocalDashboard();
  await settleDashboardStartupTasks();
  assert.equal(harness.context.localActionBusy, true);
  assert.equal(harness.context.electronStartupRefreshDeferred, true);
  assert.equal(harness.state.startupRefreshChecks, 0,
    "the launch pass remains deferred while the primary owner is busy");

  primary.resolve({ marker: "primary", mode: "real_local_evidence" });
  await loading;
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.electronStartupRefreshDeferred, false);
  assert.equal(harness.state.startupRefreshChecks, 1,
    "the real loader retries exactly once after restoring its previous busy state");
});

function dashboardStartupDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createDashboardStartupHarness({
  client = {},
  initialBusy = false,
  initialHealth = null,
} = {}) {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const state = {
    events: [], previews: [], primaryReads: 0, statusReads: 0, polls: 0,
    preparations: 0, reviewUnavailableReports: 0, returnRefreshChecks: 0,
    startupRefreshChecks: 0,
  };
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      disabled: false,
      hidden: false,
      textContent: "",
      setAttribute() {},
    });
    return elements.get(selector);
  };
  const context = createContext({
    $: element,
    window: { setTimeout: (callback) => { queueMicrotask(callback); } },
    document: { documentElement: { dataset: {} } },
    cacheDropThreadLinks: { loadToken: 0 },
    activeLocalDashboardLoad: null,
    localActionBusy: initialBusy,
    localRefreshInProgress: false,
    electronStartupRefreshDeferred: false,
    localCompanionHealth: initialHealth,
    localOnboarding: null,
    dashboard: null,
    accountingRebuildDeferral: { consecutive: 2 },
    demoDashboard: () => ({ marker: "demo", mode: "demo" }),
    localClient: {
      async load() {
        state.primaryReads += 1;
        return client.load ? client.load() : { marker: "primary", mode: "real_local_evidence" };
      },
      health: async () => ({ capabilities: {
        incrementalContributionSync: "telemetry-contribution-v1.0",
      } }),
      onboarding: async () => ({ state: "ready" }),
      refreshStatus: async () => ({ refresh: { result: {} } }),
      ...Object.fromEntries(Object.entries(client).filter(([key]) => key !== "load")),
    },
    runsInsideNativeDashboard: () => true,
    // The extracted startup harness exercises the loader without evaluating
    // Electron's launch coordinator. Keep that path explicitly inert so the
    // optional onboarding callback remains faithful to the browser/native
    // readiness tests.
    startElectronStartupRefresh: () => {
      state.startupRefreshChecks += 1;
      return true;
    },
    setJourneyState(value) { state.journey = value; },
    scheduleLocalReadinessPoll() { state.polls += 1; },
    scheduleReturningUserRefresh() { state.returnRefreshChecks += 1; },
    updateLocalActionButtons() {
      element("#refresh-button").disabled = context.localActionBusy;
    },
    renderDashboard(value) {
      context.dashboard = value;
      state.events.push(["primary", value.marker]);
    },
    renderDashboardUnavailableState(kind) { state.events.push(["unavailable", kind]); },
    renderAccounting() { state.events.push(["accounting"]); },
    // The extracted startup harness has no Electron preload bridge. Keep the
    // production loader's optional accountless-sharing read on its faithful
    // no-bridge path while the startup assertions exercise primary readiness.
    loadElectronSharingPreference: async () => null,
  });
  for (const name of [
    "renderLocalOnboarding", "markLocalDashboardReady", "loadLocalDashboard",
    "loadLocalDashboardSecondaryState", "loadQuickResultDashboard", "showDemoDashboard",
  ]) {
    const match = appSource.match(new RegExp(
      `^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu",
    ));
    // The optional helper is absent on the pre-fix loader; execute that loader
    // too so a regression fails on behavior, not on an extraction convention.
    if (name === "loadLocalDashboardSecondaryState" && match === null) continue;
    assert.ok(match, `${name} is executed from production source`);
    runInContext(match[0], context);
  }
  return { context, state, element };
}

const settleDashboardStartupTasks = () => new Promise(setImmediate);

test("primary startup renders and releases busy state while optional reads remain pending", async (t) => {
  for (const method of [
    "health", "onboarding", "refreshStatus", "contributionSyncPreview",
    "contributionSyncStatus", "incrementalStatus",
  ]) {
    await t.test(method, async () => {
      const pending = dashboardStartupDeferred();
      const harness = await createDashboardStartupHarness(method === "incrementalStatus"
        ? { incrementalStatus: () => pending.promise }
        : { client: { [method]: () => pending.promise } });
      let completed = false;
      const loading = harness.context.loadLocalDashboard().then(() => { completed = true; });
      try {
        await settleDashboardStartupTasks();
        assert.equal(harness.context.document.documentElement.dataset.localDashboardReady, "true");
        assert.equal(harness.context.dashboard.marker, "primary");
        assert.equal(harness.state.journey, "local-ready",
          "real evidence must not remain hidden by first-run while onboarding waits");
        assert.equal(completed, true, "only the primary result owns the dashboard load promise");
        assert.equal(harness.context.localActionBusy, false);
        assert.equal(harness.element("#refresh-button").disabled, false);
      } finally {
        pending.resolve(null);
        await loading;
      }
    });
  }
});

test("primary startup failure renders unavailable without waiting on optional recovery", async () => {
  const pending = dashboardStartupDeferred();
  const harness = await createDashboardStartupHarness({ client: {
    load: async () => { throw new Error("synthetic primary read failure"); },
    health: () => pending.promise,
    onboarding: () => pending.promise,
  } });
  let completed = false;
  const loading = harness.context.loadLocalDashboard().then(() => { completed = true; });
  try {
    await settleDashboardStartupTasks();
    assert.equal(harness.state.primaryReads, 2, "the existing single retry is retained");
    assert.equal(harness.context.dashboard, null);
    assert.equal(harness.state.events.filter(([kind]) => kind === "primary").length, 0);
    assert.deepEqual(harness.state.events.filter(([kind]) => kind === "unavailable"), [
      ["unavailable", "companion-unavailable"],
    ]);
    assert.equal(harness.context.document.documentElement.dataset.localDashboardReady, "true");
    assert.equal(completed, true);
    assert.equal(harness.context.localActionBusy, false);
  } finally {
    pending.resolve(null);
    await loading;
  }
  await settleDashboardStartupTasks();
  assert.ok(harness.state.polls > 0,
    "the failed primary path still starts optional companion recovery after readiness");
});

test("overlapping primary startup loads publish only the newest result and restore the original busy owner", async (t) => {
  for (const olderSettlesFirst of [true, false]) {
    await t.test(olderSettlesFirst ? "older settles first" : "newer settles first", async () => {
      const first = dashboardStartupDeferred();
      const second = dashboardStartupDeferred();
      const reads = [first, second];
      const harness = await createDashboardStartupHarness({
        client: { load: () => reads.shift().promise },
      });
      const older = harness.context.loadLocalDashboard();
      const newer = harness.context.loadLocalDashboard();
      if (olderSettlesFirst) {
        first.resolve({ marker: "old" });
        await older;
        assert.equal(harness.context.dashboard, null);
        assert.equal(harness.context.localActionBusy, true);
      }
      second.resolve({ marker: "new" });
      await newer;
      assert.equal(harness.context.dashboard.marker, "new");
      assert.equal(harness.context.localActionBusy, false);
      if (!olderSettlesFirst) {
        first.resolve({ marker: "old" });
        await older;
      }
      assert.equal(harness.context.dashboard.marker, "new");
      assert.equal(harness.context.localActionBusy, false);
      assert.deepEqual(harness.state.events.filter(([kind]) => kind === "primary"), [["primary", "new"]]);
    });
  }
  const outerOwner = await createDashboardStartupHarness({ initialBusy: true });
  await outerOwner.context.loadLocalDashboard();
  assert.equal(outerOwner.context.localActionBusy, true,
    "a surrounding analysis or setup action retains its own busy state");
});

test("startup optional failures preserve primary evidence and known health", async () => {
  const knownHealth = { capabilities: {
    incrementalContributionSync: "telemetry-contribution-v1.0",
  } };
  const fail = async () => { throw new Error("synthetic optional read failure"); };
  const harness = await createDashboardStartupHarness({
    client: Object.fromEntries([
      "health", "onboarding", "refreshStatus",
    ].map((method) => [method, fail])),
    initialHealth: knownHealth,
  });
  await harness.context.loadLocalDashboard();
  await settleDashboardStartupTasks();
  assert.equal(harness.context.document.documentElement.dataset.localDashboardReady, "true");
  assert.equal(harness.context.dashboard.marker, "primary");
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.context.localCompanionHealth, knownHealth);
  assert.equal(harness.context.accountingRebuildDeferral.consecutive, 2);
  assert.deepEqual(harness.state.previews, []);
  assert.equal(harness.state.preparations, 0);
  assert.equal(harness.state.events.filter(([kind]) => kind === "unavailable").length, 0);
  assert.equal(harness.state.polls, 1);
});


test("an older primary failure cannot clear a newer result or start an obsolete retry", async () => {
  const pending = dashboardStartupDeferred();
  let reads = 0;
  const harness = await createDashboardStartupHarness({ client: {
    load: () => ++reads === 1 ? pending.promise : Promise.resolve({ marker: "new" }),
  } });
  const older = harness.context.loadLocalDashboard();
  await harness.context.loadLocalDashboard();
  pending.reject(new Error("synthetic older primary failure"));
  await older;
  await settleDashboardStartupTasks();
  assert.equal(reads, 2);
  assert.equal(harness.context.dashboard.marker, "new");
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.state.events.filter(([kind]) => kind === "unavailable").length, 0);
});

test("older startup secondary reads cannot replace a newer load or native quick result", async (t) => {
  for (const nextLoad of ["loadLocalDashboard", "loadQuickResultDashboard"]) {
    await t.test(nextLoad, async () => {
      const newer = {
        health: { marker: "new", capabilities: { incrementalContributionSync: "telemetry-contribution-v1.0" } },
        onboarding: { state: "ready", marker: "new" },
        refreshStatus: { refresh: { result: { accountingRebuildDeferred: { consecutive: 3 } } } },
      };
      const pending = Object.fromEntries(Object.keys(newer).map((method) => [method, dashboardStartupDeferred()]));
      const reads = {};
      let primaryReads = 0;
      const harness = await createDashboardStartupHarness({ client: {
        load: async () => ({ marker: ++primaryReads === 1 ? "old" : "new" }),
        ...Object.fromEntries(Object.entries(newer).map(([method, value]) => [method, () => {
          reads[method] = (reads[method] ?? 0) + 1;
          return reads[method] === 1 ? pending[method].promise : Promise.resolve(value);
        }])),
      } });
      await harness.context.loadLocalDashboard();
      await settleDashboardStartupTasks();
      await harness.context[nextLoad]();
      await settleDashboardStartupTasks();
      assert.equal(harness.state.previews.length, 0);
      const eventCount = harness.state.events.length;
      const refreshChecks = harness.state.returnRefreshChecks;
      pending.health.resolve({ marker: "old", capabilities: {} });
      pending.onboarding.resolve({ state: "unavailable", marker: "old" });
      pending.refreshStatus.resolve({ refresh: { result: {} } });
      await settleDashboardStartupTasks();
      assert.equal(harness.context.dashboard.marker, "new");
      assert.equal(harness.context.localCompanionHealth, newer.health);
      assert.equal(harness.context.localOnboarding, newer.onboarding);
      assert.equal(harness.context.accountingRebuildDeferral.consecutive, 3);
      assert.equal(harness.state.previews.length, 0);
      assert.equal(harness.state.events.length, eventCount);
      assert.equal(harness.state.returnRefreshChecks, refreshChecks);
      assert.equal(harness.context.localActionBusy, false);
    });
  }
});


test("an older recovery health read cannot replace a newer dashboard health answer", async () => {
  const pending = dashboardStartupDeferred();
  const newerHealth = { marker: "new", capabilities: { incrementalContributionSync: "telemetry-contribution-v1.0" } };
  let healthReads = 0;
  const harness = await createDashboardStartupHarness({ client: {
    health: () => {
      healthReads += 1;
      if (healthReads === 1) return Promise.resolve(null);
      if (healthReads === 2) return pending.promise;
      return Promise.resolve(newerHealth);
    },
  } });
  await harness.context.loadLocalDashboard();
  await settleDashboardStartupTasks();
  const recovery = harness.context.loadLocalDashboardSecondaryState({
    isCurrent: () => harness.context.cacheDropThreadLinks.loadToken === 1,
  });
  await settleDashboardStartupTasks();
  assert.equal(healthReads, 2);
  await harness.context.loadLocalDashboard();
  await settleDashboardStartupTasks();
  const eventCount = harness.state.events.length;
  pending.resolve({ marker: "old", capabilities: {} });
  await settleDashboardStartupTasks();
  assert.equal(harness.context.localCompanionHealth, newerHealth);
  await recovery;
  assert.equal(harness.state.statusReads, 0);
  assert.equal(harness.state.events.length, eventCount);
});

test("quick reload races and failures preserve the newest real dashboard", async () => {
  const pending = dashboardStartupDeferred();
  let primaryReads = 0;
  const harness = await createDashboardStartupHarness({ client: {
    load: () => ++primaryReads === 1 ? pending.promise : Promise.resolve({ marker: "new" }),
  } });
  const olderQuick = harness.context.loadQuickResultDashboard();
  await harness.context.loadLocalDashboard();
  pending.resolve({ marker: "old" });
  await olderQuick;
  assert.equal(harness.context.dashboard.marker, "new");
  harness.context.localClient.load = async () => { throw new Error("synthetic quick failure"); };
  await assert.rejects(harness.context.loadQuickResultDashboard(), /synthetic quick failure/u);
  await settleDashboardStartupTasks();
  assert.equal(harness.context.dashboard.marker, "new");
  assert.equal(harness.context.localActionBusy, false);
  assert.equal(harness.state.events.filter(([kind]) => kind === "unavailable").length, 0);
  assert.equal(harness.context.localOnboarding.state, "ready",
    "a failed quick read still refreshes the optional onboarding state");
});

test("explicit demo selection fences pending primary, quick and secondary reads", async (t) => {
  for (const origin of ["primary", "quick", "secondary"]) {
    await t.test(origin, async () => {
      const pending = dashboardStartupDeferred();
      const harness = await createDashboardStartupHarness({ client: origin === "secondary"
        ? { health: () => pending.promise }
        : { load: () => pending.promise } });
      const loading = origin === "quick"
        ? harness.context.loadQuickResultDashboard()
        : harness.context.loadLocalDashboard();
      await settleDashboardStartupTasks();
      harness.context.showDemoDashboard();
      assert.equal(harness.context.dashboard.mode, "demo");
      assert.equal(harness.context.localActionBusy, false);
      const eventCount = harness.state.events.length;
      pending.resolve(origin === "secondary"
        ? { capabilities: { incrementalContributionSync: "telemetry-contribution-v1.0" } }
        : { marker: "obsolete" });
      await loading;
      await settleDashboardStartupTasks();
      assert.equal(harness.context.dashboard.mode, "demo");
      assert.equal(harness.context.localActionBusy, false);
      assert.equal(harness.state.events.length, eventCount);
      assert.equal(harness.state.previews.length, 0);
      assert.equal(harness.context.document.documentElement.dataset.localDashboardReady,
        origin === "secondary" ? "true" : undefined,
        "demo selection itself is never mistaken for a real local readiness result");
    });
  }
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /\$\("#demo-button"\)\.addEventListener\("click", showDemoDashboard\);/u);
});

test("first run is a truthful install and local preflight journey", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /<body class="first-run" data-i18n-root>/u);
  assert.match(
    html,
    /<meta name="usage-monitor-installer-url" content="">/u,
  );
  assert.match(
    html,
    /<meta name="usage-monitor-installer-version" content="">/u,
  );
  assert.match(
    html,
    /<meta name="usage-monitor-installer-sha256" content="">/u,
  );
  assert.match(
    html,
    new RegExp(
      `<meta name="usage-monitor-semantic-open-target" content="${SEMANTIC_OPEN_TARGET_PLACEHOLDER}">`,
      "u",
    ),
  );
  for (const name of [
    "usage-monitor-installer-bytes",
    "usage-monitor-minimum-macos",
    "usage-monitor-architectures",
    "usage-monitor-release-notes-url",
    "usage-monitor-privacy-url",
    "usage-monitor-security-url",
    "usage-monitor-support-url",
  ]) {
    assert.match(
      html,
      new RegExp(`<meta name="${name}" content="">`, "u"),
    );
  }
  assert.match(html, /<link rel="canonical" href="">/u);
  assert.match(html, /property="og:image" content=""/u);
  assert.match(html, /property="og:image:width" content="1200"/u);
  assert.match(html, /property="og:image:height" content="630"/u);
  assert.match(html, /name="twitter:card" content="summary_large_image"/u);
  assert.match(html, /name="twitter:image" content=""/u);
  assert.match(html, /id="installer-link"[^>]*hidden/u);
  assert.match(html, /id="open-installed-app" href=""/u);
  assert.match(html, /id="installer-details"[^>]*hidden/u);
  assert.match(html, /A public installer is not configured for this build/u);
  assert.match(html, /A normal website cannot read Codex files/u);
  assert.match(html, /Your real usage appears only on that loopback page/u);
  assert.match(html, /You may close this hosted browser tab at any time/u);
  assert.match(html, /A useful headline often appears in seconds/u);
  assert.match(html, /first deep pass can\s+take a few minutes/u);
  assert.match(html, /later updates are normally faster/u);
  assert.match(html, /id="release-notes-link"/u);
  assert.match(html, /id="privacy-link"/u);
  assert.match(html, /id="security-link"/u);
  assert.match(html, /id="support-link"/u);
  assert.match(html, /id="companion-check"/u);
  assert.match(html, /id="setup-check-again"/u);
  assert.match(html, /id="refresh-button"[^>]*disabled/u);
  assert.match(html, /data-requires-evidence/u);
  // Re-pinned 2026-08-08 (owner-directed): the prepare-and-review disclosure
  // is gone; the approve-once card carries the no-silent-upload promise now.
  assert.doesNotMatch(html, /id="community-contribution-disclosure"/u);
  assert.match(html, /id="electron-accountless-sharing-description"/u);
  assert.doesNotMatch(html, /id="incremental-consent"/u);
  assert.match(styles, /native-dashboard #setup-card/u);
  assert.match(appSource, /card\.hidden = true;[\s\S]*?card\.setAttribute\("aria-hidden", "true"\)/u);

  // The install call to action is one shared module used by both browser
  // entry points, so these guarantees are asserted where they now live.
  const installSource = await readFile(
    new URL("../public/install-cta.js", import.meta.url),
    "utf8",
  );
  assert.match(installSource, /function configuredInstallerUrl\(documentRef, architecture\)/u);
  assert.match(installSource, /function configuredInstallerMetadata\(/u);
  assert.match(
    installSource,
    /export function configuredInstallerRelease\(documentRef, \{ architecture = "arm64" \} = \{\}\)/u,
  );
  assert.doesNotMatch(installSource, /configuredSemanticOpenTarget|usage-monitor-semantic-open-target/u);
  assert.match(appSource, /from "\.\/install-cta\.js"/u);
  assert.match(appSource, /function configuredSemanticOpenTarget\(documentRef\)/u);
  assert.match(appSource, /const SEMANTIC_OPEN_TARGET = configuredSemanticOpenTarget\(document\);/u);
  assert.match(appSource, /installedAppLink\.href = SEMANTIC_OPEN_TARGET/u);
  assert.doesNotMatch(appSource, /usagemonitor:\/\/open/u);
  assert.match(installSource, /translateMessage\(\s*"installer\.sha256",\s*\{ value: release\.sha256 \}/u);
  assert.match(
    installSource,
    /translateMessage\(\s*\n\s*compactDetails\s*\n\s*\?\s*"installer\.compatibilitySummary"\s*\n\s*:\s*"installer\.requiresMacOS",/u,
  );
  assert.match(installSource, /selected\.protocol === "https:"/u);
  assert.doesNotMatch(appSource, /loopbackHttp/u);
  assert.match(appSource, /function openInstalledApp\(\)/u);
  assert.match(appSource, /function localAnalysisAllowed\(/u);
  assert.match(appSource, /if \(!localAnalysisAllowed\(\)\) \{/u);
  for (const status of [
    "codex_home_missing",
    "codex_home_unreadable",
    "session_directories_missing",
    "session_directories_unreadable",
    "no_rollout_files",
  ]) {
    assert.match(appSource, new RegExp(`${status}:`));
  }
  assert.match(appSource, /System Settings → Privacy & Security → Files and Folders/u);
  assert.match(appSource, /customCodexHomeConfigured/u);
  assert.match(appSource, /rolloutFilesObservedCapped/u);
  assert.match(appSource, /setup-check-again.*checkLocalSetup/su);
  assert.match(appSource, /setJourneyState\(ready \? "local-ready" : "needs-local-setup"\)/u);
  assert.match(appSource, /setup: "status\.setUpMac"/u);
  assert.match(appSource, /if \(!ready\) setGlobalState\("setup"/u);
  assert.doesNotMatch(appSource, /product laboratory/u);
  assert.match(styles, /body\.first-run \[data-requires-evidence\]/u);
  assert.match(styles, /body\.needs-local-setup \.journey-progressive/u);
  assert.match(styles, /\.state-setup/u);
});

test("local analysis exposes quick results and cancel-safe progress", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="cancel-refresh"[^>]*hidden/u);
  assert.match(appSource, /localClient\.cancelRefresh\(\)/u);
  assert.match(appSource, /\["running", "cancelling"\]\.includes\(outcome\)/u);
  assert.match(appSource, /phase === "quick_result"/u);
  assert.match(appSource, /await loadQuickResultDashboard\(\)/u);
  assert.match(appSource, /renderDashboard\(data\)/u);
  assert.match(appSource, /refreshQuickResultStatus\(\{/u);
  assert.match(appSource, /refreshAccountingStatus\(\{ progress \}\)/u);
  assert.match(appSource, /renderRefreshProgress\(button, phase, \{ processed, selected, elapsedSeconds \}\)/u);
  assert.match(appSource, /const accountingStatus = outcome === "running"/u);
  assert.match(appSource, /const collectorProgress = progress\?\.kind === undefined/u);
  assert.match(appSource, /if \(collectorProgress\s*&& progress\?\.phase === "quick_result"/u);
  assert.match(appSource, /const countedProgress = collectorProgress \|\| unifiedIndexScanning/u);
  assert.match(appSource, /outcome === "cancelling"[\s\S]*?accountingStatus !== null[\s\S]*?archiveScanning/u);
  assert.doesNotMatch(appSource, /Verified summary ready|Preparing verified summary/u);
  assert.match(appSource, /kind === "unified_index"/u);
  assert.match(appSource, /Scanning local history/u);
  assert.doesNotMatch(appSource, /Headline ready; finishing deeper accounting/u);
  assert.match(appSource, /Local analysis cancelled/u);
  assert.match(appSource, /Verified existing results were kept/u);
  assert.match(appSource, /preserving a resumable local checkpoint/u);
  assert.match(appSource, /refresh_resource_limited/u);
  assert.match(appSource, /This scan paused to protect your Mac/u);
  assert.match(appSource, /No partial result replaced your existing results/u);
  assert.match(appSource, /Deep analysis paused after two bounded continuations/u);
});

test("timeline keeps time, uncertainty, and primary navigation explicit", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const adminSource = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const id of [
    "timeline-zoom-in",
    "timeline-zoom-out",
    "timeline-pan-back",
    "timeline-pan-forward",
    "timeline-reset-zoom",
    "timeline-confidence",
    "timeline-zoom-status",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-nav="community"/);
  assert.doesNotMatch(html, /data-nav="data"/u);
  assert.match(html, /id="residual-time-heading">Local time/);
  assert.doesNotMatch(html, /Exact local \/ UTC time/);
  assert.match(html, /Missing quota bracket/);
  assert.match(appSource, /function selectedTimelinePoints/);
  assert.match(appSource, /function timelineStatusIntervals/);
  assert.match(appSource, /function bindTimelineInteractions/);
  assert.match(appSource, /event\.key === "ArrowLeft"/);
  assert.match(appSource, /event\.key === "Home"/);
  assert.match(appSource, /statusIntervals/);
  assert.match(appSource, /visibleBounds = timelineBounds\(points\)/);
  assert.match(appSource, /visibleArtifactResiduals\.length[\s\S]*pointResiduals/);
  assert.match(appSource, /renderResiduals\(data, visiblePoints, viewport\)/);
  assert.match(appSource, /safeDomainEndMs - domainStartMs/);
  assert.match(appSource, /adaptiveChartTickCount\(width, \{/u);
  assert.match(appSource, /tick\.alignment \?\? "middle"/u);
  assert.match(appSource, /function formatChartTimeLabel\(value/);
  assert.match(appSource, /new Intl\.DateTimeFormat\(getFormattingLocale\(\), \{[\s\S]*?timeZone: USER_TIME_ZONE/u);
  assert.doesNotMatch(
    appSource.match(/function formatChartTimeLabel\(value[\s\S]*?\n\}/u)?.[0] ?? "",
    /timeZoneName/u,
  );
  assert.match(appSource, /formatChartTimeLabel\(at/);
  assert.doesNotMatch(appSource, /function formatUtc/);
  assert.match(adminSource, /formatReportingTime/);
  assert.doesNotMatch(adminSource, /toLocaleString/);
  assert.match(appSource, /periodEndAt/);
  assert.match(appSource, /point\.periodEndAt \?\? point\.timestamp/);
  assert.match(appSource, /chart\.status\.unpricedLocalActivity/u);
  assert.doesNotMatch(appSource, /component\.unpricedTokens|tokensWithUnpriced/);
  assert.doesNotMatch(appSource, /accounting\.pricing\.evidenceStarts/);
  assert.match(styles, /native-dashboard #setup-card/);
  assert.match(appSource, /timelineStatusLabel/);
  // The `recent_7d_partial` pin lived in the preparation preflight estimate,
  // which left with the prepare flow (owner-directed, 2026-08-08); partial
  // index handling stays pinned through the measured history-progress block
  // (the terse coverage labels left with the cost card's metadata line,
  // owner-directed 2026-08-10).
  assert.match(appSource, /renderHistoryProgress\(data\)/u);
  assert.match(appSource, /chart\.status\.resetOrTrackChange/u);
  assert.match(appSource, /chart\.status\.backwardOrAmbiguous/u);
  assert.match(appSource, /Calculating usage and allowance/);
  assert.match(html, /id="calibration-range-controls"/);
  assert.match(html, /id="weekly-range-controls"/);
  assert.match(html, /id="weekly-partial-legend"/);
  // Re-pinned 2026-08-08 (owner-directed): the contribution lookback picker
  // and prepare button are removed with the legacy prepare flow.
  assert.doesNotMatch(html, /id="contribution-lookback-controls"/);
  assert.doesNotMatch(html, /Prepare and review last 24 hours/);
  // Owner decision 2026-08-06: the calibration chart leads Trends and its
  // disclosure is open by default. The previous assertion pinned the opposite
  // order, on the reviewed consumer hierarchy that a first-time reader should
  // meet the headline usage chart before the technical evidence. That
  // hierarchy was deliberately reversed, so this pins the new order rather
  // than being deleted - the ordering is still a decision, not an accident.
  assert.ok(
    html.indexOf("advanced-calibration") < html.indexOf('id="range-controls"'),
    "calibration chart leads Trends ahead of the usage chart",
  );
  assert.match(html, /<details class="advanced-calibration" open>/u);
  // Owner decision 2026-08-06: the calibration rolling comparison window is
  // fixed at three hours — the 15-minute and 1-hour widths proved inaccurate,
  // and a segmented control with one honest option is clutter. The previous
  // assertion pinned that the window control sat inside the advanced
  // calibration disclosure; the control itself is gone now, so this pins its
  // absence and the fixed width every consumer reads instead.
  assert.doesNotMatch(html, /id="window-controls"|data-hours=/u);
  assert.match(appSource, /const CALIBRATION_WINDOW_HOURS = 3;/u);
  assert.doesNotMatch(appSource, /activeWindowHours/u);
  assert.match(appSource, /row\?\.last_observed_at \?\? row\?\.first_observed_at/);
  assert.match(appSource, /label: \{ key: "weekly\.series\.shortObservation" \}/u);
  // The user-selected lookback left with the prepare flow (owner-directed,
  // 2026-08-08): the silent review bootstrap owns the fixed 24h→1h fallback.
  assert.doesNotMatch(appSource, /prepareContribution\(/u);
  assert.doesNotMatch(appSource, /activeContributionLookbackHours/u);
  assert.match(styles, /interactive-chart/);
  assert.match(styles, /chart-status-missing/);
  assert.match(styles, /touch-action: pan-y/);
  // Narrow screens shed compact buttons only from the crowded top toolbar, so
  // chart navigation stays reachable without needing its own exception rule.
  assert.match(styles, /\.topbar \.button\.compact \{ display: none; \}/);
  assert.doesNotMatch(styles, /^\s*\.button\.compact \{ display: none; \}/mu);
  assert.match(
    styles,
    /\.topbar \.history-index-badge \{ display: none; \}/u,
    "the later evidence-card rule cannot re-show the toolbar badge",
  );
  assert.match(
    styles,
    /\.index-progress \{\n  display: grid;/u,
    "the in-card history progress treatment owns the full-width layout",
  );
  assert.doesNotMatch(
    styles,
    /\.history-index-badge \{\n  display: grid;/u,
    "the compact toolbar badge cannot inherit the in-card progress layout",
  );
  assert.match(
    styles,
    /body:not\(\.community-site\) > \.topbar \.brand > span \{ display: none; \}/u,
    "the local toolbar sheds its wordmark before it can overlap controls",
  );
  assert.match(styles, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(styles, /min-height: 48px/);
  assert.match(styles, /\.primary-nav \{[\s\S]*overflow-x: auto;/);
});

test("default calibration view renders a stat row and keeps the example as prose", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const id of [
    "calibration-rate",
    "calibration-range",
    "calibration-example",
    "calibration-explanation",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // Owner-directed restyle (2026-08-10): the three-column definition list of
  // sentence-length cells is a two-tile stat row — figure prominent, short
  // label beneath — and the "example translation" sentence reads as prose
  // under the stats rather than as a third squeezed column.
  assert.match(html, /class="calibration-stats" id="calibration-facts"/u);
  assert.doesNotMatch(html, /<dl class="calibration-facts"|<dt>Central fitted rate<\/dt>|Example translation/u);
  assert.match(html, /<span>Central fitted rate · per point<\/span>/u);
  assert.match(html, /<span>Plausible 80% range · per point<\/span>/u);
  assert.match(styles, /\.calibration-stats strong \{[^\n}]*font-family: var\(--serif\)/u);
  assert.match(appSource, /function renderCalibrationRate/);
  assert.doesNotMatch(appSource, /dashboard\.calibration\.perPoint|dashboard\.calibration\.range"/u);
  assert.match(appSource, /setLocalizedText\(example, "dashboard\.calibration\.example"/u);
  assert.match(appSource, /"dashboard\.calibration\.rangeUnavailable"/u);
  assert.match(appSource, /"dashboard\.calibration\.withRange"/u);
  assert.match(appSource, /"dashboard\.calibration\.withoutRange"/u);
});

test("weekly view keeps the default surface to the estimate and its reset history", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="weekly-trend"/);
  assert.doesNotMatch(html, /id="weekly-stats"/);
  assert.match(html, /<summary>See individual usage changes<\/summary>/);
  assert.doesNotMatch(appSource, /function renderWeeklyTrend/);
  assert.doesNotMatch(appSource, /function renderWeeklyStats/);
});

test("weekly view keeps pricing provenance with accounting and removes the obsolete receipt", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.doesNotMatch(html, /id="weekly-pricing-receipt"|Price basis for the visible fits/iu);
  assert.doesNotMatch(appSource, /function renderWeeklyPricingReceipt|renderWeeklyPricingReceipt\(/u);
  assert.doesNotMatch(styles, /\.weekly-pricing-receipt/u);
  // The overview's registry-provenance fragment left with the cost card's
  // metadata line (owner-directed, 2026-08-10); the share card remains the
  // surface that publishes the price-registry version.
  assert.match(appSource, /shareCardRegistryVersion\(data\?\.pricing\?\.registryVersion\)/u);
});

test("weekly keeps every fit visible and marks short observations separately", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="weekly-evidence-controls"/u);
  assert.match(appSource, /const history = allowanceHistoryChartModel\(data\);/u);
  assert.match(appSource, /const chartValues = history\.points;/u);
  assert.match(
    appSource,
    /wellObserved: isWellObservedWeeklyFit\(observedSpanPp\),/u,
  );
  assert.match(
    appSource,
    /markerRadius: \(point\) => point\.wellObserved \? 4 : 0,/u,
  );
  assert.match(
    appSource,
    /markerRadius: \(point\) => point\.wellObserved \? 0 : 4,/u,
  );
  assert.match(appSource, /weekly-partial-legend"\)\.hidden = !chartValues\.some/u);
  assert.doesNotMatch(appSource, /showWeeklyPartialDiagnostics/u);
});

test("the weekly evidence slider is bounded below 100 and cannot create an accidental empty state", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /let activeWeeklyMinimumObservedSpanPp = 50;/u);
  const thresholdMatch = appSource.match(
    /function isWellObservedWeeklyFit\(observedSpanPp\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(thresholdMatch, "isWellObservedWeeklyFit is available for contract review");
  assert.match(
    thresholdMatch[1],
    /return observedSpanPp !== null && observedSpanPp >= activeWeeklyMinimumObservedSpanPp;/u,
  );
  assert.match(html, /id="weekly-span-control" type="range" min="0" max="99"/u);
  assert.match(appSource, /activeWeeklyMinimumObservedSpanPp = Math\.min\(99, Math\.max\(0, Number\(event\.target\.value\)\)\)/u);
});

test("chart tick labels stay compact and take their resolution from the axis span", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("const CHART_TICK_TIME_ONLY_SPAN_MS");
  const end = appSource.indexOf("\n/**\n * Whether a series draws its data points", start);
  assert.ok(start >= 0 && end > start, "the tick label formatter is available");
  const formatChartTimeLabel = Function(
    "t", "finite", "getFormattingLocale", "USER_TIME_ZONE", "formatChartTimestamp",
    `${appSource.slice(start, end)}\nreturn formatChartTimeLabel;`,
  )(
    () => "Unknown",
    (value, fallback = null) => typeof value === "number" && Number.isFinite(value) ? value : fallback,
    () => "en-US",
    "America/New_York",
    () => "fallback",
  );

  const at = Date.parse("2026-07-15T18:04:00.000Z");
  const hour = 3_600_000;
  assert.equal(formatChartTimeLabel(at, { spanMs: 24 * hour }), "2:04 PM");
  assert.equal(formatChartTimeLabel(at, { spanMs: 7 * 24 * hour }), "Jul 15");
  assert.equal(formatChartTimeLabel(at, { spanMs: 31 * 24 * hour }), "Jul 15");
  assert.equal(formatChartTimeLabel(at, { spanMs: 3 * 365 * 24 * hour }), "Jul 2026");
  assert.equal(formatChartTimeLabel("not a timestamp"), "Unknown");
  for (const spanMs of [24 * hour, 7 * 24 * hour, 31 * 24 * hour, 3 * 365 * 24 * hour, null]) {
    const label = formatChartTimeLabel(at, { spanMs });
    assert.doesNotMatch(label, / at /u, "no ICU date/time connective on a tick");
    assert.doesNotMatch(label, /EDT|EST|GMT|UTC|Eastern/u, "no zone name on a tick");
    assert.ok(label.length <= 18, `tick stays compact: ${label}`);
  }
  // Compact labels made rotation unnecessary, so no chart asks for it.
  assert.doesNotMatch(appSource, /rotateXTickLabels/u);
});

test("the weekly headline is a stable all-data median and says so on screen", async () => {
  // One estimate a week for a year, so the range buttons and the span slider
  // genuinely select different subsets of the same evidence.
  const weeklyValues = Array.from({ length: 52 }, (_, index) => ({
    last_observed_at: new Date(Date.UTC(2025, 7, 6) + index * 7 * 86_400_000).toISOString(),
    value_usd: 1500 + (index % 7) * 110,
    displayed_span_pp: index % 3 === 0 ? 22 : 55 + (index % 5) * 8,
    pairwise_p10_usd: 1400,
    pairwise_p90_usd: 2100,
  }));
  const data = {
    weekly: {
      summary: {
        median_weekly_value_usd: 1825,
        lower_80_across_resets_usd: 1650,
        upper_80_across_resets_usd: 2000,
        qualifying_resets: 52,
      },
      weeklyValues,
    },
  };

  const views = await Promise.all([
    { span: 50, rangeDays: 7 },
    { span: 50, rangeDays: 31 },
    { span: 50, rangeDays: 36_500 },
    { span: 0, rangeDays: 36_500 },
    { span: 90, rangeDays: 36_500 },
  ].map((view) => renderWeeklyHero(data, view)));

  assert.equal(
    new Set(views.map((view) => view.estimate)).size,
    1,
    "the headline never moves when a chart control moves",
  );
  assert.equal(
    new Set(views.map((view) => view.range)).size,
    1,
    "the across-reset range never moves when a chart control moves",
  );
  assert.equal(views[0].label, "Speed-priced all-data median");
  assert.match(views[0].range, /all data/u, "the range names the population it summarizes");
  assert.equal(
    new Set(views.map((view) => view.explanation)).size,
    views.length,
    "the explanation reports the subset each view is drawing",
  );
  for (const view of views) {
    assert.match(view.explanation, /never moves with the controls below/u);
    assert.match(view.explanation, /drawing \d+ of 52 estimates/u);
    // The range is anchored at the newest fit, and the sentence says so
    // (estimator audit, 2026-08-08): "7d" is seven days back from that fit,
    // not from today.
    assert.match(view.explanation, /anchored at the newest fit \(2026-07-29\)/u);
  }
  // Re-pinned 2026-08-08 (estimator audit): a 7-day window over a per-reset
  // series holds one or two fits, so the short range relaxes the span floor
  // to zero instead of filtering the window near-empty. Both weekly fits in
  // range draw — the 22pp one as an outlined short observation — and the
  // sentence names the relaxed floor.
  assert.match(views[0].explanation, /drawing 2 of 52/u);
  assert.match(views[0].explanation, /any length/u);
  assert.equal(views[0].spanLabel, "Well-observed quota span");
  assert.equal(views[0].spanNote.hidden, false);
  assert.match(views[0].spanNote.textContent, /includes all spans/u);
  assert.equal(views[1].spanLabel, "Minimum observed quota span");
  assert.equal(views[1].spanNote.hidden, true);

  assert.match(views[2].explanation, /drawing 34 of 52/u);
  assert.match(views[3].explanation, /drawing 52 of 52/u);
  // An empty chart names its reason with numbers instead of the generic
  // sentence (estimator audit, 2026-08-08): at a 90pp floor every fit in
  // range is filtered, and the message says exactly that.
  assert.equal(views[4].empty.hidden, false);
  assert.equal(
    views[4].empty.textContent,
    "52 fits are in range, all below the 90pp span floor.",
  );
  assert.equal(views[0].empty.hidden, true);
  assert.equal(views[0].timeZone, "Times shown in Eastern Time.");

  const spanish = await renderWeeklyHero(data, { span: 50, rangeDays: 31, locale: "es" });
  assert.match(spanish.explanation, /nunca cambia con los controles/u);
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(
      translate("weekly.headline.relationship", {}, locale).length > 40,
      `${locale} states the headline/chart relationship`,
    );
  }
});

test("the rendered allowance headline, history, pace and shared history use one selected plan", async () => {
  const populations = [["pro", 2_400], ["plus", 85]].map(([planType, value]) => ({
    planType,
    status: "available",
    planAttribution: {
      methodVersion: "plan-era-v1", status: "historical_plan_conditional",
      accountVerified: false, comparisonEligibility: "unavailable",
    },
    datasets: {
      summary: [{
        median_weekly_value_usd: value,
        lower_80_across_resets_usd: value * .8,
        upper_80_across_resets_usd: value * 1.2,
        qualifying_resets: 2,
      }],
      weekly_values: [0, 1].map((week) => ({
        plan_type: planType,
        aggregation_eligibility: "primary_conditional",
        value_usd: value,
        last_observed_at: new Date(Date.UTC(2026, 7, 20 + week * 7)).toISOString(),
        displayed_span_pp: week ? 80 : 35,
      })),
    },
  }));
  const data = normalizeDashboardPayload({ weekly: {
    ...populations[1], selectedPlanType: "plus", planPopulations: populations,
  } });
  const plus = await renderWeeklyHero(data, { span: 0, rangeDays: 36_500 });
  const pro = await renderWeeklyHero(data, { span: 50, rangeDays: 36_500, planType: "pro" });
  const proInSpanish = await renderWeeklyHero(data, {
    span: 0, rangeDays: 7, planType: "pro", locale: "es",
  });
  assert.match(plus.label, /Plus/u);
  assert.match(plus.estimate, /\$85/u);
  assert.match(plus.range, /\$68.*\$102/u);
  assert.match(pro.label, /Pro \(20×\)/u);
  assert.match(pro.estimate, /\$2400/u);
  assert.match(pro.range, /\$1920.*\$2880/u);
  assert.match(proInSpanish.label, /Pro \(20×\)/u);
  assert.match(proInSpanish.estimate, /\$2400/u);
  for (const [view, planType, value, shown] of [
    [plus, "plus", 85, 2], [pro, "pro", 2_400, 1], [proInSpanish, "pro", 2_400, 2],
  ]) {
    assert.equal(view.shared.data.weekly.planType, planType);
    assert.strictEqual(view.shared.data, view.paceData,
      "pace and the share card receive the same selected population as the headline");
    assert.equal(view.shared.history.points.length, shown);
    assert.ok(view.shared.history.points.every((row) => row.value === value),
      "the share card gets the exact selected-plan and filtered history, never a pooled graph");
    assert.strictEqual(view.shared.data.accounting, data.accounting,
      "plan-specific estimates do not discard the complete activity ledger");
  }
  assert.equal(pro.paceData.weekly.paceForecast, null);
  assert.deepEqual(pro.shared.data.quotaWindows, []);
});

test("reset boundaries tolerate the provider's timestamp jitter but not a real reset", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("const RESET_BOUNDARY_TOLERANCE_MS");
  const end = appSource.indexOf("\nfunction liveTimelinePoints(", start);
  assert.ok(start >= 0 && end > start, "reset boundary comparison is available");
  const { sameResetBoundary } = Function(
    `${appSource.slice(start, end)}\nreturn { sameResetBoundary };`,
  )();

  const base = "2026-08-07T12:00:00.000Z";
  const drifted = (seconds) => new Date(Date.parse(base) + seconds * 1_000).toISOString();

  // The observed restatement drift across this corpus is 1–22 seconds.
  for (const seconds of [0, 1, 7, 22, 60, 119]) {
    assert.equal(
      sameResetBoundary(base, drifted(seconds)),
      true,
      `${seconds}s of restatement drift is the same reset`,
    );
  }
  // A genuine change moves the boundary by hours: the short window is five
  // hours and the long one is seven days.
  for (const seconds of [600, 5 * 3_600, 7 * 86_400]) {
    assert.equal(
      sameResetBoundary(base, drifted(seconds)),
      false,
      `${seconds}s apart is a different reset`,
    );
  }
  assert.equal(sameResetBoundary(null, base), false);
  assert.equal(sameResetBoundary(base, null), false);
  assert.equal(sameResetBoundary("not-a-time", "not-a-time"), true);
  assert.equal(sameResetBoundary("not-a-time", "other"), false);

  // The reported false-flag rate: one window in ten restated its boundary.
  const windows = Array.from({ length: 1_000 }, (_, index) => [
    base,
    drifted(index % 10 === 0 ? 1 + (index % 22) : 0),
  ]);
  assert.equal(windows.filter(([a, b]) => a !== b).length, 100, "the fixture reproduces the jitter");
  assert.equal(
    windows.filter(([a, b]) => !sameResetBoundary(a, b)).length,
    0,
    "no jittered window is flagged as a reset or track change",
  );
});

test("inspect exact periods keeps comparable rows instead of filling with Not comparable", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function balancedInspectionRows(");
  const end = appSource.indexOf("\nfunction renderResiduals(", start);
  assert.ok(start >= 0 && end > start, "inspection row selection is available");
  const balancedInspectionRows = Function(
    `${appSource.slice(start, end)}\nreturn balancedInspectionRows;`,
  )();

  const day = (index) => `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`;
  const unmatched = Array.from({ length: 40 }, (_, index) => ({
    timestamp: day(index + 1),
    status: "missing_quota_bracket",
    residual: null,
  }));
  const comparable = Array.from({ length: 25 }, (_, index) => ({
    timestamp: day(index + 1).replace("T00", "T12"),
    status: "matched",
    residual: 25 - index,
  }));

  // The previous ordering concatenated the unbounded unmatched list first.
  const previous = [...unmatched, ...comparable]
    .filter((row, index, rows) =>
      rows.findIndex((candidate) => candidate.timestamp === row.timestamp) === index)
    .slice(0, 8);
  assert.equal(
    previous.filter((row) => row.residual !== null).length,
    0,
    "the fixture reproduces the all-Not-comparable table",
  );

  const rows = balancedInspectionRows(unmatched, comparable, 8);
  assert.equal(rows.length, 8);
  const withResiduals = rows.filter((row) => row.residual !== null);
  assert.equal(withResiduals.length, 4, "comparable periods get their reserved half");
  assert.deepEqual(
    withResiduals.map((row) => Math.abs(row.residual)).sort((left, right) => right - left),
    [25, 24, 23, 22],
    "the largest residuals are the comparable rows that survive",
  );
  const times = rows.map((row) => Date.parse(row.timestamp));
  assert.deepEqual(times, [...times].sort((left, right) => right - left), "newest first");

  // Either half alone still fills the table, and a shared timestamp is not
  // printed twice.
  assert.equal(balancedInspectionRows(unmatched, [], 8).length, 8);
  assert.equal(balancedInspectionRows([], comparable, 8).length, 8);
  assert.equal(balancedInspectionRows([], [], 8).length, 0);
  assert.equal(
    balancedInspectionRows(
      [{ timestamp: day(3), residual: null }],
      [{ timestamp: day(3), residual: 9 }, { timestamp: day(4), residual: 1 }],
      8,
    ).length,
    2,
  );
});

test("chart timestamps are composed, so no ICU connective or duplicate zone name reaches a chart", () => {
  const at = "2026-07-15T18:04:00.000Z";
  const stamped = formatChartTimestamp(at);
  assert.doesNotMatch(stamped, / at /u, "no localized date/time connective");
  assert.doesNotMatch(stamped, /EDT|EST|GMT|UTC/u, "the zone is stated once in the caption, not per point");
  assert.match(stamped, / · /u, "the two halves are joined by a separator we choose");
  assert.equal(formatChartTimestamp(at, { dateOnly: true }).includes("·"), false);
  assert.equal(formatChartTimestamp("not a timestamp"), "Unknown");
  // The caption's zone name is derived, never assumed.
  assert.equal(
    formatTimeZoneLabel({ locale: "en-US", timeZone: "Europe/Berlin", value: at }),
    "Central European Time",
  );
  assert.equal(
    formatTimeZoneLabel({ locale: "en-US", timeZone: "Asia/Tokyo", value: at }),
    "Japan Standard Time",
  );
});

test("allowance history draws visible evidence dots while the dense usage timeline does not", async () => {
  const documentRef = new FakeSvgDocument(900);
  const { lineChart, CHART_POINT_STYLE } = await loadLineChartRenderer(documentRef);
  const points = [0, 1, 2, 3].map((index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1 + index * 7)).toISOString(),
    value: 1800 + index * 20,
    wellObserved: index !== 2,
  }));

  // The allowance estimate history: sparse points, each one an observed reset.
  const sparse = lineChart({
    points,
    series: [
      {
        key: "value",
        className: "chart-point-weekly-mature",
        label: { key: "series.wellObserved" },
        connect: false,
        pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
        pointFilter: (point) => point.wellObserved,
        markerRadius: (point) => point.wellObserved ? 4 : 0,
      },
      {
        key: "value",
        className: "chart-point-weekly-partial",
        label: { key: "series.shortObservation" },
        connect: false,
        pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
        pointFilter: (point) => !point.wellObserved,
        markerRadius: (point) => point.wellObserved ? 0 : 4,
      },
    ],
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
  });
  const mature = sparse.querySelectorAll("circle.chart-point-weekly-mature");
  const partial = sparse.querySelectorAll("circle.chart-point-weekly-partial");
  assert.equal(mature.length, 3, "well-observed points have no short-series hit target");
  assert.equal(partial.length, 1, "only the short observation can show its tooltip");
  const drawn = [...mature, ...partial].filter(
    (circle) => Number(circle.getAttribute("r")) > 0
      && !circle.getAttribute("class").includes("chart-point-hit-target"),
  );
  assert.equal(
    drawn.length,
    points.length,
    "every reset estimate is drawn exactly once as a visible dot",
  );
  assert.equal(
    mature.filter((circle) => !circle.getAttribute("class").includes("hit-target")).length,
    3,
    "well-observed estimates use the filled marker",
  );
  assert.equal(
    partial.filter((circle) => !circle.getAttribute("class").includes("hit-target")).length,
    1,
    "the short observation uses the outlined marker",
  );

  // The dense usage timeline: no dots, but every sample stays reachable. The
  // rule is per chart, so this opposite answer must be expressible at the same
  // time as the one above.
  const dense = lineChart({
    points,
    series: [{
      key: "value",
      className: "chart-line-value",
      label: { key: "series.usage" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    }],
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
  });
  const hidden = dense.querySelectorAll("circle.chart-line-value");
  assert.equal(hidden.length, points.length);
  assert.equal(
    hidden.every((circle) => circle.getAttribute("class").includes("chart-point-hit-target")),
    true,
    "dense samples are hit targets, not drawn dots",
  );
  assert.equal(
    hidden.every((circle) => circle.getAttribute("tabindex") === "0"),
    true,
    "hidden samples stay keyboard reachable and hoverable",
  );
});

test("a chart series must state its point style and cannot pass untranslated text", async () => {
  const documentRef = new FakeSvgDocument(900);
  const { lineChart, CHART_POINT_STYLE, chartText } = await loadLineChartRenderer(documentRef);
  const points = [{ timestamp: "2026-01-01T00:00:00.000Z", value: 1 }];
  const series = (overrides) => ({
    key: "value",
    className: "chart-line-value",
    label: { key: "series.usage" },
    pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    ...overrides,
  });
  const chart = (overrides) => lineChart({
    points,
    series: [series(overrides.series ?? {})],
    title: overrides.title ?? { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: overrides.yLabel ?? { key: "chart.yLabel" },
  });

  assert.throws(
    () => chart({ series: { pointStyle: undefined } }),
    /needs an explicit pointStyle/u,
    "a new series cannot inherit a default that hides the owner's data points",
  );
  assert.throws(
    () => chart({ title: "Seven-day allowance estimate history" }),
    /localization descriptor/u,
    "hardcoded English cannot reach the SVG title",
  );
  assert.throws(
    () => chart({ yLabel: "7-day allowance ($)" }),
    /localization descriptor/u,
    "hardcoded English cannot reach an axis label",
  );
  assert.throws(
    () => chart({ series: { label: "Observed allowance remaining" } }),
    /localization descriptor/u,
    "hardcoded English cannot reach a series name",
  );
  assert.equal(chartText({ key: "a.b", values: { n: 2 } }), "[a.b] n=2");
  assert.equal(chartText({ data: "$1,825" }), "$1,825", "source values pass through untranslated");
  assert.equal(chartText(null), "");
});

test("chart descriptor keys all exist in the dashboard catalogue", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // Chart text is passed as `{ key: "..." }` descriptors, which the generic
  // `t("...")` scan in test/localization-system.test.js cannot see. A dotted
  // name distinguishes a catalogue key from a series' data key ("apiCostUsd").
  const referenced = [...appSource.matchAll(
    /\bkey:\s*"([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+)"/gu,
  )].map(([, key]) => key);
  assert.ok(referenced.length >= 20, "chart descriptors are present to check");
  for (const key of new Set(referenced)) {
    assert.equal(
      Object.hasOwn(WEB_MESSAGES, key) || Object.hasOwn(WEB_PLURAL_MESSAGES, key),
      true,
      `chart descriptor references a missing localization key: ${key}`,
    );
  }
});

test("the percentage axis uses round quarters rather than the dollar axis tick count", async () => {
  const documentRef = new FakeSvgDocument(900);
  const { lineChart, CHART_POINT_STYLE } = await loadLineChartRenderer(documentRef);
  const points = [0, 1, 2].map((index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    value: 3 + index,
    remaining: 80 - index * 10,
  }));
  const svg = lineChart({
    points,
    series: [{
      key: "value",
      className: "chart-line-value",
      label: { key: "series.usage" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    }],
    secondarySeries: [{
      key: "remaining",
      className: "chart-line-allowance",
      label: { key: "series.remaining" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    }],
    secondaryYLabel: { key: "chart.secondaryYLabel" },
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
  });
  const percentLabels = svg.querySelectorAll("text.chart-axis-label")
    .map((label) => label.textContent)
    .filter((text) => /^\d+%$/u.test(text));
  assert.deepEqual(
    percentLabels,
    ["100%", "75%", "50%", "25%", "0%"],
    "the right axis reads in quarters, not 100/67/33/0",
  );
});

test("weekly points carry measured ranges with pointer and keyboard detail", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(
    appSource,
    /errorBars: \{\s*low: "low",\s*high: "high",\s*className: "chart-error-bar-weekly",\s*label: \{ key: "weekly\.series\.measuredRange" \},\s*tooltip: false,/u,
  );
  assert.match(
    appSource,
    /confidence: \{[\s\S]*?label: \{ key: "weekly\.series\.acrossResetRange" \},[\s\S]*?format: \(value\) => formatMoney\(value\),[\s\S]*?\},/u,
  );
  assert.match(
    appSource,
    /if \(errorBars\) values\.push\([\s\S]*?errorBars\.low[\s\S]*?errorBars\.high/u,
  );
  const weeklyChart = appSource.match(
    /function renderAllowanceHistoryChart\(history\) \{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  assert.match(weeklyChart, /tooltip: false,/u);
  assert.match(weeklyChart, /detail: weeklyPointDetail,/u);
  assert.match(appSource, /weekly\.point\.detail/u);
  assert.match(appSource, /if \(errorBars\.tooltip !== false\)/u);
  assert.match(styles, /\.chart-error-bar-weekly \.chart-error-bar-line/u);
  // Re-pinned 2026-08-08 (estimator audit): the caption stopped presenting
  // the within-reset slope spread as a supported/measured range and now names
  // it a slope-agreement diagnostic, matching the calibration report.
  assert.match(html, /Each reset estimate is drawn with its slope-agreement range/u);
  assert.match(html, /a within-reset disagreement diagnostic,\s*\n?\s*not a confidence interval/u);
  // The assertion `/markers: false,\s*hitTargets: true/` used to sit here. It
  // asserted the defect: it required the allowance chart's reset estimates to
  // be drawn as invisible hit targets, so restoring the owner's plotted points
  // would have failed the suite. Removed rather than inverted — a regex over
  // one renderer's option literals is the wrong instrument for "these dots are
  // visible". `allowance history draws visible evidence dots…` below renders
  // the chart and reads the circles back instead.
  assert.doesNotMatch(html, /Per-week within-reset sensitivity|Scroll horizontally on a narrow screen/u);
});

test("lineChart DOM interactions cover default points, median, band, and narrow ticks", async () => {
  const documentRef = new FakeSvgDocument(900);
  const { lineChart, CHART_POINT_STYLE } = await loadLineChartRenderer(documentRef);
  const points = [0, 1, 2, 3, 4].map((index) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    value: 100 + index * 4,
    remaining: 70 - index * 3,
    median: 112,
    low: 90,
    high: 140,
  }));
  const svg = lineChart({
    points,
    series: [{
      key: "value",
      className: "chart-line-value",
      label: { key: "series.observedAllowance" },
      pointStyle: CHART_POINT_STYLE.EVIDENCE_DOTS,
      format: (value) => `$${value}`,
    }],
    secondarySeries: [{
      key: "remaining",
      className: "chart-line-allowance",
      label: { key: "series.allowanceRemaining" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    }],
    confidence: {
      low: "low",
      high: "high",
      label: { key: "series.acrossResetRange" },
      format: (value) => `$${value}`,
    },
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
  });

  const markers = svg.querySelectorAll('circle.chart-line-value[tabindex="0"]');
  const secondaryMarkers = svg.querySelectorAll('circle.chart-line-allowance[tabindex="0"]');
  assert.equal(markers.length, points.length, "primary markers are keyboard reachable without per-series opt-in");
  assert.equal(secondaryMarkers.length, points.length, "secondary markers share the same interaction defaults");
  assert.match(markers[0].getAttribute("aria-label"), /series\.observedAllowance/);
  markers[0].dispatchEvent({ type: "pointerenter" });
  assert.equal(svg.querySelector(".chart-hover-tooltip").getAttribute("visibility"), "visible");
  markers[0].dispatchEvent({ type: "pointerleave" });
  assert.equal(svg.querySelector(".chart-hover-tooltip").getAttribute("visibility"), "hidden");
  markers[0].focus();
  assert.equal(svg.querySelector(".chart-hover-tooltip").getAttribute("visibility"), "visible");
  markers[0].blur();

  const band = svg.querySelector(".chart-area-confidence");
  assert.equal(band.getAttribute("role"), "img");
  assert.equal(band.getAttribute("tabindex"), "0");
  assert.match(band.getAttribute("aria-label"), /series\.acrossResetRange.*\$90–\$140/u);
  band.dispatchEvent({ type: "pointerenter" });
  assert.equal(svg.querySelector(".chart-hover-tooltip").getAttribute("visibility"), "visible");

  const medianSvg = lineChart({
    points,
    series: [{
      key: "median",
      className: "chart-line-weekly-center",
      label: { key: "series.allDataMedian" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
      lineFocusable: true,
      lineDetail: (rows) => ({ key: "series.resetFits", plural: rows.length }),
      format: (value) => `$${value}`,
    }],
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
  });
  const medianLine = medianSvg.querySelector(".chart-line-weekly-center");
  assert.equal(medianLine.getAttribute("role"), "img");
  assert.equal(medianLine.getAttribute("tabindex"), "0");
  assert.match(medianLine.getAttribute("aria-label"), /series\.allDataMedian/);
  const medianHitTargets = medianSvg.querySelectorAll(
    'circle.chart-point-hit-target[tabindex="0"]',
  );
  assert.equal(
    medianHitTargets.length,
    points.length,
    "hidden median points keep accessible hover and focus targets",
  );

  const xLabels = [
    ...svg.querySelectorAll('text[display="inline"]'),
    ...svg.querySelectorAll('text[display="none"]'),
  ];
  const initialVisible = xLabels.filter((label) => label.getAttribute("display") === "inline");
  assert.ok(initialVisible.length >= 3, "wide chart keeps a useful tick set");
  svg.renderedWidth = 320;
  svg.resizeObserver.callback([{ contentRect: { width: 320 } }]);
  const narrowVisible = xLabels.filter((label) => label.getAttribute("display") === "inline");
  assert.ok(narrowVisible.length < initialVisible.length, "narrow chart sheds labels instead of scrolling");
  assert.equal(narrowVisible.length, 2, "narrow chart retains only endpoint labels");

  // The rotated-tick-label variant used to be exercised here. Rotation is gone:
  // a tick now reads "Jul 15" or "2:04 PM", so the -24° transform and its 66px
  // gutter only made short labels harder to read. Compact tick shapes are
  // covered by `chart tick labels stay compact…` below.
});

test("accounting controls hide unavailable history and enable it when indexed evidence exists", async () => {
  const withoutHistory = await loadAccountingPeriodSync(["24h", "7d", "30d", "all", "history"]);
  withoutHistory.syncAccountingPeriodControls({
    accounting: {
      periods: [{ periodId: "7d" }, { periodId: "all" }],
    },
  });
  assert.equal(withoutHistory.getActive(), "7d");
  const unavailableHistory = withoutHistory.controls.buttons.find(
    (button) => button.dataset.period === "history",
  );
  assert.equal(unavailableHistory.hidden, true);
  assert.equal(unavailableHistory.disabled, true);
  assert.equal(
    withoutHistory.controls.buttons.find((button) => button.dataset.period === "all").disabled,
    false,
  );

  const withHistory = await loadAccountingPeriodSync(["7d", "history", "all"]);
  withHistory.syncAccountingPeriodControls({
    accounting: {
      periods: [{ periodId: "7d" }, { periodId: "history" }, { periodId: "all" }],
    },
  });
  const historyButton = withHistory.controls.buttons.find(
    (button) => button.dataset.period === "history",
  );
  assert.equal(withHistory.getActive(), "history");
  assert.equal(historyButton.hidden, false);
  assert.equal(historyButton.disabled, false);

  const cacheOnly = await loadAccountingPeriodSync(["all", "history"]);
  cacheOnly.syncAccountingPeriodControls({
    accounting: {
      periods: [{ periodId: "all" }],
    },
  });
  assert.equal(cacheOnly.getActive(), null, "cache-only payloads do not impersonate indexed history");
  assert.equal(cacheOnly.controls.buttons.find((button) => button.dataset.period === "all").disabled, false);
});

test("timeline drag suppresses selection only during the chart gesture", async () => {
  const { bind, calls } = await loadTimelineInteractions();
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.chart-shell \{[\s\S]*?user-select: text;/u);
  assert.match(styles, /\.chart-shell\.interactive-chart\.is-pointer-active,[\s\S]*?user-select: none;/u);
  const shell = new FakeChartShell();
  const points = [
    { timestamp: "2026-01-01T00:00:00.000Z" },
    { timestamp: "2026-01-02T00:00:00.000Z" },
  ];
  bind(shell, points, {
    startMs: Date.parse(points[0].timestamp),
    endMs: Date.parse(points[1].timestamp),
  });

  const down = { button: 0, clientX: 100, pointerId: 7 };
  shell.onpointerdown(down);
  assert.ok(shell.classList.values.has("is-pointer-active"));
  const selectDuringGesture = {
    preventDefault() { this.defaultPrevented = true; },
  };
  shell.onselectstart(selectDuringGesture);
  assert.equal(selectDuringGesture.defaultPrevented, true);

  const move = {
    clientX: 130,
    pointerId: 7,
    preventDefault() { this.defaultPrevented = true; },
  };
  shell.onpointermove(move);
  assert.equal(move.defaultPrevented, true);
  assert.ok(shell.classList.values.has("is-panning"));
  assert.equal(typeof calls.pan, "number");

  const up = {
    pointerId: 7,
    preventDefault() { this.defaultPrevented = true; },
  };
  shell.onpointerup(up);
  assert.equal(up.defaultPrevented, true);
  assert.equal(shell.classList.values.has("is-pointer-active"), false);
  assert.equal(shell.classList.values.has("is-panning"), false);
  assert.equal(shell.releasedPointerId, 7);
});

test("metric information controls open an accessible popover instead of relying on title hover", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(appSource, /function openInformationPopover\(button\)/u);
  assert.match(appSource, /popover\.setAttribute\("role", "tooltip"\)/u);
  assert.match(appSource, /button\.setAttribute\("aria-expanded", "true"\)/u);
  assert.match(appSource, /button\.setAttribute\("aria-describedby", id\)/u);
  assert.match(appSource, /button\.addEventListener\("click", \(event\) => \{/u);
  assert.match(appSource, /document\.addEventListener\("keydown", \(event\) => \{/u);
  assert.match(appSource, /event\.key !== "Escape"/u);
  assert.match(appSource, /document\.addEventListener\("click", \(event\) => \{/u);
  assert.doesNotMatch(appSource, /button\.title = explanation/u);
  assert.match(styles, /\.info-popover \{/u);
  assert.match(styles, /\.info-button\[aria-expanded="true"\]/u);
});

test("calibration zoom moves in bounded granular steps on every input device", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(appSource, /const TIMELINE_WHEEL_ZOOM_STEP = 1\.12;/u);
  assert.match(appSource, /const TIMELINE_BUTTON_ZOOM_STEP = 1\.25;/u);
  assert.match(appSource, /const TIMELINE_MAXIMUM_ZOOM_STEP = 1\.25;/u);
  assert.match(appSource, /const TIMELINE_MINIMUM_SPAN_MS = 15 \* 60_000;/u);
  // A trackpad emits many small deltas per gesture, so the step is scaled by
  // the fraction of a mouse notch each event actually reports.
  const wheelMatch = appSource.match(
    /function wheelZoomFactor\(event\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(wheelMatch, "wheelZoomFactor is available for contract review");
  assert.match(
    wheelMatch[1],
    /TIMELINE_WHEEL_ZOOM_STEP \*\* \(pixels \/ TIMELINE_WHEEL_NOTCH_PIXELS\)/u,
  );
  assert.match(wheelMatch[1], /event\.deltaMode === 1/u);
  assert.match(wheelMatch[1], /event\.deltaMode === 2/u);
  // No single event may outrun one button press, and no zoom may pass the
  // minimum useful span or the full extent of the loaded evidence.
  const zoomMatch = appSource.match(
    /function zoomTimeline\(points, factor, anchorRatio = \.5\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(zoomMatch, "zoomTimeline is available for contract review");
  assert.match(
    zoomMatch[1],
    /Math\.max\(\s*1 \/ TIMELINE_MAXIMUM_ZOOM_STEP,\s*Math\.min\(TIMELINE_MAXIMUM_ZOOM_STEP, factor\),\s*\)/u,
  );
  assert.match(
    zoomMatch[1],
    /Math\.min\(\s*bounds\.endMs - bounds\.startMs,\s*Math\.max\(minimumTimelineSpanMs\(bounds\), span \* step\),\s*\)/u,
  );
  assert.match(appSource, /zoomTimeline\(points, wheelZoomFactor\(event\), ratio\);/u);
  assert.match(appSource, /zoomTimeline\(points, 1 \/ TIMELINE_BUTTON_ZOOM_STEP\)/u);
  assert.match(appSource, /zoomTimeline\(points, TIMELINE_BUTTON_ZOOM_STEP\)/u);
  assert.doesNotMatch(appSource, /zoomTimeline\([^)]*1\.35|zoomTimeline\([^)]*\.74/u);
  // The zoom level itself has to be readable without seeing the chart.
  assert.match(appSource, /"dashboard\.timeline\.status"/u);
});

test("residuals span the calibration range and show uncomputable windows as gaps", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // Rows with no computable residual are kept, so a shorter run of computable
  // residuals can never silently shorten the axis.
  const rowsMatch = appSource.match(
    /function residualRows\(data, points\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(rowsMatch, "residualRows is available for contract review");
  assert.doesNotMatch(rowsMatch[1], /return row\.residual !== null/u);
  assert.match(appSource, /const domain = viewport \?\? timelineBounds\(points\);/u);
  assert.match(appSource, /xDomain: domain,/u);
  assert.match(
    appSource,
    /statusIntervals: domain === null\s*\?\s*\[\]\s*: timelineStatusIntervals\(residuals, domain\),/u,
  );
  assert.match(
    appSource,
    /const computed = residuals\.filter\(\(row\) => row\.residual !== null\);/u,
  );
  assert.match(appSource, /function residualGapReasons/u);
  assert.match(appSource, /"dashboard\.residual\.partial"/u);
  assert.match(html, /id="residual-coverage"/u);
  assert.match(html, /Quiet periods with no\s+activity and no quota change are neutral, not errors/u);
});

test("the weekly allowance chart leads the dashboard", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.ok(
    html.indexOf('id="weekly"') < html.indexOf('id="timeline"'),
    "the weekly allowance section precedes the timeline section",
  );
  assert.ok(
    html.indexOf('data-nav="weekly"') < html.indexOf('data-nav="trends"'),
    "primary navigation follows the same order as the sections",
  );
  assert.match(html, /<p class="eyebrow">02 · Weekly allowance<\/p>/u);
  assert.match(html, /<p class="eyebrow">03 · Timeline<\/p>/u);
  assert.match(html, /class="dashboard-section lead-section(?: dashboard-page-inactive)?" id="weekly"/u);
  assert.match(html, /class="panel weekly-history-panel lead-chart-panel"/u);
  // The lead chart must use the available page width instead of introducing a
  // second horizontal scrollbar for a handful of reset estimates.
  assert.match(styles, /\.weekly-history-chart \{ overflow: visible; \}/u);
  assert.match(styles, /\.weekly-history-chart svg \{ min-width: 0; height: clamp\(270px, 30vw, 330px\); \}/u);
  assert.match(styles, /\.lead-chart-panel \.weekly-history-chart svg \{ height: clamp\(270px, 30vw, 330px\); \}/u);
  assert.match(styles, /\.weekly-span-control \{/u);
});

test("weekly details keep reset evidence concise and do not present speed coverage as known", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // Both halves of the paginated presentation (owner-directed 2026-08-10):
  // the row-set holder and the page renderer beneath it.
  const tableMatch = appSource.match(
    /function renderWeeklyTable\(values\) \{([\s\S]*?)\nfunction accountingPeriod\(data\)/u,
  );
  assert.ok(tableMatch, "renderWeeklyTable source is available for contract review");
  const tableSource = tableMatch[1];

  assert.match(html, /<summary>See individual usage changes<\/summary>/u);
  // Re-pinned 2026-08-08 (estimator audit): the per-reset bars are the
  // p10–p90 spread of pairwise slopes WITHIN a reset — a disagreement
  // diagnostic. Every surface now calls them the slope-agreement range
  // instead of a measured range, which overclaimed a confidence interval.
  assert.match(html, /<th scope="col">Observed<\/th>[\s\S]*?<th scope="col">Observed span<\/th>[\s\S]*?<th scope="col">Estimate<\/th>[\s\S]*?<th scope="col">Slope-agreement range<\/th>[\s\S]*?<th scope="col">Status<\/th>/u);
  assert.doesNotMatch(html, /Evidence available \/ reset due|Speed known|Known speed coverage/u);
  assert.doesNotMatch(tableSource, /resetDueAt|speedCoverage|known_speed_fraction/u);
  assert.match(tableSource, /weekly\.table\.wellObserved/u);
  assert.match(tableSource, /weekly\.series\.shortObservation/u);
  assert.match(appSource, /function isWellObservedWeeklyFit\(observedSpanPp\)/u);
  assert.doesNotMatch(appSource, /function renderWeeklyTrend|function renderWeeklyStats/u);
});

test("live timeline couples speed-priced usage to the matching allowance capacity", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, />Expected from speed-priced API cost</u);
  assert.doesNotMatch(html, />Expected from API cost</u);
  assert.match(html, /id="usage-cost-legend-label">Speed-priced API-equivalent usage</u);
  assert.match(html, /id="usage-allowance-legend"/u);
  assert.match(
    appSource,
    /\$\("#usage-cost-legend-label"\)[\s\S]*?chart\.series\.quotaWeightedUsage[\s\S]*?chart\.series\.standardApiUsage/u,
  );
  assert.match(appSource, /\$\("#usage-allowance-legend"\)\.hidden = !quotaComparable/u);
  const trackMatch = appSource.match(
    /function mainWeeklyQuotaTrack\(rows\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(trackMatch, "mainWeeklyQuotaTrack source is available for contract review");
  const trackSource = trackMatch[1];
  assert.match(
    trackSource,
    /rows\.filter\(isPrimaryCodexWeeklyQuotaWindow\)/u,
  );
  assert.doesNotMatch(trackSource, /row\.limitId|row\.durationMinutes/u);
  // Track identity is (limitId, duration): the provider's primary/secondary
  // slot is a server-assigned UI role that flipped for the weekly window
  // around 2026-07-06, so the track must never be selected or grouped by
  // slot — that filter cut the entire pre-flip era out of the series.
  assert.doesNotMatch(trackSource, /row\.slot|bySlot/u);

  const liveMatch = appSource.match(
    /function liveTimelinePoints\([\s\S]*?\) \{([\s\S]*?)\n\}\n\nfunction groupedUsageTimeline/u,
  );
  assert.ok(liveMatch, "liveTimelinePoints source is available for contract review");
  const liveSource = liveMatch[1];
  const capacityMatch = appSource.match(
    /function timelineCalibrationCapacity\(data\) \{([\s\S]*?)\n\}/u,
  );
  assert.ok(capacityMatch, "timeline capacity source is available for contract review");
  assert.match(
    capacityMatch[1],
    /data\?\.timeline\?\.allowanceCapacity[\s\S]*?capacity\?\.status !== "available"[\s\S]*?selected\.basisId/u,
  );
  assert.doesNotMatch(
    capacityMatch[1],
    /weekly\.summary|gradient\.summary|historicalGap/u,
  );
  assert.match(liveSource, /const capacitySelection = timelineCalibrationCapacity\(data\);/u);
  assert.match(liveSource, /const quota = mainWeeklyQuotaTrack\(data\.timeline\.quota\);/u);
  assert.match(liveSource, /timelineAllowanceWeightedCost\(row, capacitySelection\)/u);
  assert.match(liveSource, /capacitySelection\?\.basisId/u);
  assert.doesNotMatch(liveSource, /current\.apiPriceEquivalentUsd/u);
  assert.doesNotMatch(liveSource, /weeklyQuota|: data\.timeline\.quota/u);

  const usageMatch = appSource.match(
    /function usagePointsWithAllowance\(data, points, includeAllowance\) \{([\s\S]*?)\n\}\n\nfunction usageGroupingsForRange/u,
  );
  assert.ok(usageMatch, "usage allowance source is available for contract review");
  const usageSource = usageMatch[1];
  assert.match(usageSource, /const quota = mainWeeklyQuotaTrack\(data\.timeline\.quota\);/u);
  assert.match(usageSource, /point\.quotaWeightedCostUsd !== null/u);
  assert.doesNotMatch(usageSource, /fallback|data\.timeline\.quota\.filter/u);

  const groupedMatch = appSource.match(
    /function groupedUsageTimeline\(data\) \{([\s\S]*?)\n\}\n\nfunction usagePointsWithAllowance/u,
  );
  assert.ok(groupedMatch, "grouped usage source is available for contract review");
  assert.match(groupedMatch[1], /timelineAllowanceWeightedCost\(row, capacitySelection\)/u);
  assert.doesNotMatch(groupedMatch[1], /group\.apiCostUsd \+= row\.apiPriceEquivalentUsd/u);

  const totalMatch = appSource.match(
    /function completeUsageTimelineTotal\(points, key\) \{[\s\S]*?\n\}/u,
  );
  assert.ok(totalMatch, "usage totals keep the chart's gap semantics");
  const completeUsageTimelineTotal = new Function(
    "finite",
    `${totalMatch[0]}; return completeUsageTimelineTotal;`,
  )(finite);
  assert.equal(completeUsageTimelineTotal([
    { quotaWeightedCostUsd: 10 },
    { quotaWeightedCostUsd: 25 },
  ], "quotaWeightedCostUsd"), 35);
  assert.equal(completeUsageTimelineTotal([
    { quotaWeightedCostUsd: 10 },
    { quotaWeightedCostUsd: null },
  ], "quotaWeightedCostUsd"), null);

  const quotaCardsMatch = appSource.match(
    /function renderQuotaCards\(data\) \{([\s\S]*?)\n\}\n\nfunction renderPricing/u,
  );
  assert.ok(quotaCardsMatch, "quota-card source is available for contract review");
  assert.match(
    quotaCardsMatch[1],
    /data\.quotaWindows\.filter\(isPrimaryCodexQuotaWindow\)/u,
  );
  // Owner-directed 2026-08-20: the Spark cards lead the row and the
  // normal-Codex allowance follows. Future pools remain visible only after
  // both reviewed groups, never promoted into either one.
  assert.match(
    quotaCardsMatch[1],
    /const windows = \[[\s\S]*?\.\.\.sparkOrderedWindows,[\s\S]*?\.\.\.normalOrderedWindows,[\s\S]*?\.\.\.otherOrderedWindows,[\s\S]*?\];/u,
  );
  // Within the Spark pair the order comes from the window duration, not from
  // the provider's slot assignment, so five-hour precedes seven-day even if
  // Spark's slots move again as they did on 2026-08-19.
  const sparkSortMatch = quotaCardsMatch[1].match(
    /const sparkOrderedWindows = \[\.\.\.sparkWindows\]\.sort\(([\s\S]*?)\);\n/u,
  );
  assert.ok(sparkSortMatch, "Spark card ordering is available for contract review");
  const sparkComparator = new Function(
    "finite",
    `return ${sparkSortMatch[1]};`,
  )(finite);
  assert.deepEqual(
    [
      { durationMinutes: 10_080 },
      { durationMinutes: 525_600 },
      { durationMinutes: 300 },
    ].sort(sparkComparator).map((window) => window.durationMinutes),
    [300, 10_080, 525_600],
  );
});









test("export filenames and reflected API errors remain bounded", () => {
  assert.equal(safeFilename("../../private id"), "usage-monitor-privateid-export.json");
  assert.equal(safeApiError({ error: { code: "INVALID_ENVELOPE" } }, "failed"), "INVALID ENVELOPE");
  assert.equal(safeApiError({ message: "private server detail" }, "failed"), "failed");
});

test("every user-visible failure carries a quotable, content-free reference", () => {
  const references = new Set();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const reference = createDiagnosticReference(webcrypto);
    assert.match(reference, DIAGNOSTIC_REFERENCE_PATTERN);
    assert.equal(reference.length, 9);
    // Crockford base32: no I, L, O or U, so a reference read aloud or retyped
    // into a support conversation cannot collide with 1 or 0.
    assert.doesNotMatch(reference.slice(3), /[ILOU]/u);
    references.add(reference);
  }
  assert.ok(references.size > 480, "references are fresh randomness, not a counter");

  // The reference is minted from WebCrypto alone. Nothing the user typed and
  // nothing the service returned can influence it.
  const bytes = [];
  const recording = {
    getRandomValues(target) {
      bytes.push(target.length);
      target.fill(0);
      return target;
    },
  };
  assert.equal(createDiagnosticReference(recording), "TT-000000");
  assert.deepEqual(bytes, [6]);

  assert.equal(
    diagnosticReferenceSentence({ reference: "TT-7QF3K2" }),
    "Reference TT-7QF3K2.",
  );
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
    }),
    "Reference TT-7QF3K2.",
  );
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      writtenToLocalLog: true,
    }),
    "Reference TT-7QF3K2, also written to the local diagnostics log.",
  );
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      writtenToLocalLog: true,
    }),
    "Reference TT-7QF3K2 · service request 0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b. Both are written to the local diagnostics log.",
  );
  // A malformed request id is dropped rather than shown, and a malformed
  // reference yields no sentence at all instead of a misleading one.
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      requestId: "participant:private",
      writtenToLocalLog: true,
    }),
    "Reference TT-7QF3K2, also written to the local diagnostics log.",
  );
  assert.equal(diagnosticReferenceSentence({ reference: "nope" }), "");
  assert.equal(diagnosticReferenceSentence(), "");

  assert.equal(
    serviceRequestId("0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b"),
    "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
  );
  for (const invalid of ["", "not-a-uuid", null, 7, "0F2C7A11-4B93-4BB2-9A7C-1C0D2E3F4A5B"]) {
    assert.equal(serviceRequestId(invalid), "");
  }
  assert.equal(diagnosticErrorCode("INTERNAL_ERROR"), "INTERNAL_ERROR");
  assert.equal(
    diagnosticErrorCode("contribution_device_credential_conflict"),
    "contribution_device_credential_conflict",
  );
  for (const invalid of ["failed at /Users/private", "a".repeat(81), null, {}]) {
    assert.equal(diagnosticErrorCode(invalid), "");
  }
  assert.equal(diagnosticSurface("contribution_connect"), "contribution_connect");
  assert.equal(diagnosticSurface("anything_else"), "");
  assert.ok(DIAGNOSTIC_SURFACES.includes("device_credential_reset"));
});

test("service request ids survive rejection so both sides of a failure can be joined", async () => {
  const requestId = "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b";
  const failing = (payload, status = 500) => new CommunityClient({
    getCsrfToken: () => "csrf-confirmation",
    fetchImpl: async () => new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    failing({ error: { code: "INTERNAL_ERROR", requestId } }).session(),
    (error) => error.status === 500
      && error.code === "INTERNAL_ERROR"
      && error.requestId === requestId,
  );
  // A body that is not the service's fixed error shape contributes nothing:
  // no code to branch on and no request id to show.
  await assert.rejects(
    failing({ error: { code: "sorry, it broke", requestId: "private-value" } })
      .session(),
    (error) => error.code === undefined && error.requestId === undefined,
  );
  await assert.rejects(
    failing("not json at all").session(),
    (error) => error.status === 500
      && error.code === undefined
      && error.requestId === undefined,
  );
});

test("diagnostic notes are recorded through a fixed, bounded local route", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        schemaVersion: "local-diagnostic-note-v0.1",
        status: "recorded",
        reference: "TT-7QF3K2",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const recorded = await client.recordDiagnosticNote({
    reference: "TT-7QF3K2",
    surface: "contribution_connect",
    code: "contribution_device_recovery_required",
    requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
  });
  assert.deepEqual(recorded, { status: "recorded", reference: "TT-7QF3K2" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/local/diagnostics/note");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    reference: "TT-7QF3K2",
    surface: "contribution_connect",
    code: "contribution_device_recovery_required",
    requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
  });

  // A code or request id the boundary cannot vouch for is replaced, never
  // forwarded, so nothing free-form can reach the local log.
  await client.recordDiagnosticNote({
    reference: "TT-ZZ0011",
    surface: "contribution_send",
    code: "failed reading /Users/private/state.json",
    requestId: "private-value",
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    reference: "TT-ZZ0011",
    surface: "contribution_send",
    code: "unknown",
    requestId: "",
  });

  // A coarse code is worth little to whoever reads the reference later, so the
  // specific bound behind it travels too — under the same shape test, and only
  // when there is one to send.
  await client.recordDiagnosticNote({
    reference: "TT-4HJ7M2",
    surface: "contribution_prepare",
    code: "export_too_large",
    detail: "export_resource_expanded_record_bytes",
    requestId: "",
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    reference: "TT-4HJ7M2",
    surface: "contribution_prepare",
    code: "export_too_large",
    detail: "export_resource_expanded_record_bytes",
    requestId: "",
  });
  for (const detail of ["", "Failed reading /Users/private/state.json", 42]) {
    await client.recordDiagnosticNote({
      reference: "TT-4HJ7M3",
      surface: "contribution_prepare",
      code: "export_too_large",
      detail,
      requestId: "",
    });
    assert.equal(
      Object.hasOwn(JSON.parse(calls.at(-1).options.body), "detail"),
      false,
    );
  }

  const callsBeforeInvalid = calls.length;
  for (const invalid of [
    { reference: "nope", surface: "contribution_send" },
    { reference: "TT-7QF3K2", surface: "Not A Surface" },
    { reference: "TT-7QF3K2" },
  ]) {
    await assert.rejects(
      client.recordDiagnosticNote(invalid),
      /Diagnostic note inputs are invalid/u,
    );
  }
  assert.equal(calls.length, callsBeforeInvalid);

  assert.deepEqual(
    normalizeLocalDiagnosticNote({
      schemaVersion: "local-diagnostic-note-v0.1",
      status: "recorded",
      reference: "TT-IL0OU1",
    }),
    { status: "unavailable", reference: "" },
  );
  assert.deepEqual(
    normalizeLocalDiagnosticNote(null),
    { status: "unavailable", reference: "" },
  );
});

test("failed diagnostic writes reject and leave the user with only the reference", async () => {
  const client = new LocalCompanionClient({
    fetchImpl: async () => new Response(JSON.stringify({
      schemaVersion: "local-companion-v0.1",
      error: { code: "diagnostic_note_not_recorded" },
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await assert.rejects(
    client.recordDiagnosticNote({
      reference: "TT-7QF3K2",
      surface: "contribution_connect",
      code: "contribution_device_recovery_required",
      requestId: "",
    }),
    (error) => error?.status === 500
      && error?.code === "diagnostic_note_not_recorded",
  );
  assert.equal(
    diagnosticReferenceSentence({
      reference: "TT-7QF3K2",
      requestId: "0f2c7a11-4b93-4bb2-9a7c-1c0d2e3f4a5b",
      writtenToLocalLog: false,
    }),
    "Reference TT-7QF3K2.",
  );
});

test("clients never invoke browser-native fetch with themselves as receiver", async () => {
  // Window.fetch is receiver-sensitive: Blink throws "Illegal invocation" and
  // WebKit "Can only call Window.fetch on instances of Window" when it is
  // called as a property of anything else. Node's fetch tolerates any
  // receiver, which is exactly how this regression stayed invisible to tests
  // while every diagnostic note died in the page before a request was made.
  function receiverStrictFetch(url, options = {}) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    receiverStrictFetch.calls.push({ url, options });
    return Promise.resolve(new Response(JSON.stringify({
      schemaVersion: "local-diagnostic-note-v0.1",
      status: "recorded",
      reference: "TT-7QF3K2",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  receiverStrictFetch.calls = [];
  const local = new LocalCompanionClient({ fetchImpl: receiverStrictFetch });
  assert.deepEqual(
    await local.recordDiagnosticNote({
      reference: "TT-7QF3K2",
      surface: "hosted_identity",
      code: "",
      requestId: "",
    }),
    { status: "recorded", reference: "TT-7QF3K2" },
  );
  assert.equal(receiverStrictFetch.calls.length, 1);

  function receiverStrictHealth(url, options = {}) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    return Promise.resolve(new Response(JSON.stringify({
      status: "ready",
      checks: {},
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  const community = new CommunityClient({ fetchImpl: receiverStrictHealth });
  assert.deepEqual(await community.health(), { status: "ready", checks: {} });
});


test("disconnecting this Mac is a confirmed, non-identifying local transaction", async () => {
  const calls = [];
  const client = (payload, status = 200) => new LocalCompanionClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const disconnected = await client({
    schemaVersion: "local-contribution-device-disconnect-v0.1",
    status: "disconnected",
    deliveryPaused: true,
    localCredential: "deleted",
    localBinding: "removed",
    hostedDataDeleted: false,
    includesIdentifiers: false,
    includesCredentials: false,
  }).disconnectContributionDevice();
  assert.deepEqual(disconnected, {
    status: "disconnected",
    deliveryPaused: true,
    localCredential: "deleted",
    localBinding: "removed",
  });
  assert.equal(calls[0].url, "/api/local/contribution/device-disconnect");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-Local"], "1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    confirm: "disconnect_this_mac",
  });

  // The browser has no business learning the remote device id or receiving a
  // result that says its service data was deleted. Both claims fail closed.
  for (const payload of [
    {
      schemaVersion: "local-contribution-device-disconnect-v0.1",
      status: "disconnected",
      deliveryPaused: true,
      localCredential: "deleted",
      localBinding: "removed",
      hostedDataDeleted: false,
      includesIdentifiers: true,
      includesCredentials: false,
    },
    {
      schemaVersion: "local-contribution-device-disconnect-v0.1",
      status: "disconnected",
      deliveryPaused: true,
      localCredential: "deleted",
      localBinding: "removed",
      hostedDataDeleted: true,
      includesIdentifiers: false,
      includesCredentials: false,
    },
    {
      schemaVersion: "local-contribution-device-disconnect-v0.2",
      status: "disconnected",
      deliveryPaused: true,
      localCredential: "deleted",
      localBinding: "removed",
      hostedDataDeleted: false,
      includesIdentifiers: false,
      includesCredentials: false,
    },
  ]) {
    assert.equal(
      normalizeLocalContributionDeviceDisconnect(payload).status,
      "unavailable",
    );
  }
  assert.equal(
    normalizeLocalContributionDeviceDisconnect(null).status,
    "unavailable",
  );

  await assert.rejects(
    client({
      schemaVersion: "local-companion-v0.1",
      error: { code: "contribution_device_disconnect_cleanup_pending" },
    }, 409).disconnectContributionDevice(),
    (error) => error.status === 409
      && error.code === "contribution_device_disconnect_cleanup_pending",
  );
});

test("sealed snapshots stay readable across all released contracts", () => {
  assert.deepEqual(SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS, [
    "community-weekly-snapshot-v0.1",
    "community-weekly-snapshot-v0.2",
    "community-weekly-snapshot-v0.3",
  ]);

  // A sealed revision is immutable by design, so a week published under the
  // earlier contract keeps being served and must keep rendering.
  const v01 = structuredClone(communitySnapshot());
  v01.schemaVersion = "community-weekly-snapshot-v0.1";
  delete v01.cohortEligibility;
  v01.privacyPolicy = {
    version: "community-weekly-v0.1",
    minimumIndependentParticipants: 20,
  };
  delete v01.cells[0].planType;
  delete v01.cells[0].planVariant;
  const earlier = normalizeCommunitySnapshot(v01);
  assert.equal(earlier.state, "published");
  assert.equal(earlier.schemaVersion, "community-weekly-snapshot-v0.1");
  assert.equal(earlier.cells[0].metrics.usageEvents.value, 30);
  // Plan cohorts arrived with v0.2, so a v0.1 cell says unknown rather than
  // inventing a cohort or refusing the whole snapshot.
  assert.equal(earlier.cells[0].planType, "unknown");
  assert.equal(earlier.cells[0].planVariant, "unknown");

  const v02 = structuredClone(v01);
  v02.schemaVersion = "community-weekly-snapshot-v0.2";
  v02.cells[0].planType = "chatgpt_plus";
  v02.cells[0].planVariant = "standard";
  const current = normalizeCommunitySnapshot(v02);
  assert.equal(current.state, "published");
  assert.equal(current.schemaVersion, "community-weekly-snapshot-v0.2");
  assert.equal(current.cells[0].planType, "chatgpt_plus");
  assert.equal(current.cells[0].planVariant, "standard");

  const currentContract = normalizeCommunitySnapshot(communitySnapshot());
  assert.equal(currentContract.state, "published");
  assert.equal(currentContract.schemaVersion, "community-weekly-snapshot-v0.3");
  assert.equal(currentContract.participantCohort, "provider_account");
  assert.equal(currentContract.minimumParticipants, 20);

  for (const mutate of [
    (payload) => { payload.cohortEligibility = "independent_people"; },
    (payload) => { payload.privacyPolicy.version = "community-weekly-v0.0"; },
    (payload) => { delete payload.privacyPolicy.minimumProviderAccountParticipants; },
    (payload) => { payload.privacyPolicy.minimumProviderAccountParticipants = 19; },
    (payload) => { payload.privacyPolicy.maturity.appliesTo = "invite_cohort"; },
    (payload) => { payload.privacyPolicy.maturity.maturityDays = 6; },
    (payload) => { payload.privacyPolicy.maturity.minimumAcceptedCollectionDays = 1; },
    (payload) => {
      payload.privacyPolicy.maturity.acceptedCollectionDayBasis = "observed_at";
    },
  ]) {
    const broken = structuredClone(communitySnapshot());
    mutate(broken);
    assert.equal(normalizeCommunitySnapshot(broken).state, "unsupported_schema");
  }

  // A cell that claims a cohort under the earlier contract does not get one:
  // the contract, not the payload, decides whether the field means anything.
  const spoofed = structuredClone(v01);
  spoofed.cells[0].planType = "chatgpt_pro";
  spoofed.cells[0].planVariant = "priority";
  const ignored = normalizeCommunitySnapshot(spoofed);
  assert.equal(ignored.cells[0].planType, "unknown");
  assert.equal(ignored.cells[0].planVariant, "unknown");

  // Every other check stays exactly as strict on the older contract.
  for (const mutate of [
    (payload) => { payload.immutable = false; },
    (payload) => { payload.nonOverlapping = false; },
    (payload) => { payload.privacyPolicy.minimumIndependentParticipants = 2; },
    (payload) => { delete payload.cells[0].metrics.toolUnits; },
    (payload) => { payload.cells[0].metrics.usageEvents.unit = "tokens_rounded_down"; },
    (payload) => { payload.cells[0].modelId = ""; },
    (payload) => { payload.ingestionCutoffAt = ""; },
  ]) {
    const broken = structuredClone(v01);
    mutate(broken);
    assert.equal(normalizeCommunitySnapshot(broken).state, "unsupported_schema");
  }

  // A contract nobody has released is still refused rather than guessed at.
  for (const version of [
    "community-weekly-snapshot-v0.4",
    "community-weekly-snapshot",
    "participant-community-comparison-v0.2",
    "",
  ]) {
    const unsupported = structuredClone(communitySnapshot());
    unsupported.schemaVersion = version;
    assert.equal(
      normalizeCommunitySnapshot(unsupported).state,
      "unsupported_schema",
    );
  }
});

test("participant community comparison reads both released contracts", () => {
  assert.deepEqual(SUPPORTED_PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSIONS, [
    "participant-community-comparison-v0.1",
    "participant-community-comparison-v0.2",
  ]);
  const comparison = (schemaVersion, cell = {}) => ({
    schemaVersion,
    status: "ready",
    snapshotId: "community-weekly:2026-07-20",
    snapshotRevision: 2,
    period: {
      startAt: "2026-07-20T00:00:00.000Z",
      endAt: "2026-07-27T00:00:00.000Z",
    },
    interpretation: "own_clipped_contribution_vs_public_rounded_total",
    cells: [{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      participantHasActivity: true,
      metrics: Object.fromEntries([
        ["usageEvents", "events"],
        ["inputUncachedTokens", "tokens"],
        ["inputCacheReadTokens", "tokens"],
        ["inputCacheWriteTokens", "tokens"],
        ["outputTextTokens", "tokens"],
        ["outputReasoningTokens", "tokens"],
        ["outputCombinedTokens", "tokens"],
        ["toolUnits", "units"],
      ].map(([name, unit]) => [name, {
        status: "comparable",
        participantClippedValue: 3,
        communityRoundedValue: 20,
        unit,
      }])),
      ...cell,
    }],
  });

  const earlier = normalizeParticipantCommunityComparison(
    comparison("participant-community-comparison-v0.1"),
  );
  assert.equal(earlier.status, "ready");
  assert.equal(earlier.cells[0].metrics.usageEvents.participantClippedValue, 3);
  assert.equal(earlier.cells[0].planType, "unknown");
  assert.equal(earlier.cells[0].planVariant, "unknown");
  // v0.1 never checked a cohort, so false would be a claim it did not make.
  assert.equal(earlier.cells[0].cohortMatchesParticipant, "unknown");
  assert.deepEqual(earlier.participantPlanCohort, {
    planType: "unknown",
    planVariant: "unknown",
  });

  const current = normalizeParticipantCommunityComparison({
    ...comparison("participant-community-comparison-v0.2", {
      planType: "chatgpt_plus",
      planVariant: "standard",
      cohortMatchesParticipant: true,
    }),
    participantPlanCohort: {
      planType: "chatgpt_plus",
      planVariant: "standard",
    },
  });
  assert.equal(current.status, "ready");
  assert.equal(current.cells[0].planType, "chatgpt_plus");
  assert.equal(current.cells[0].cohortMatchesParticipant, true);
  assert.deepEqual(current.participantPlanCohort, {
    planType: "chatgpt_plus",
    planVariant: "standard",
  });

  // Cohort claims on a v0.1 payload are ignored, not adopted.
  const spoofed = normalizeParticipantCommunityComparison(
    comparison("participant-community-comparison-v0.1", {
      planType: "chatgpt_pro",
      cohortMatchesParticipant: true,
    }),
  );
  assert.equal(spoofed.cells[0].planType, "unknown");
  assert.equal(spoofed.cells[0].cohortMatchesParticipant, "unknown");

  // Everything else remains strict on the older contract.
  const invalidUnit = comparison("participant-community-comparison-v0.1");
  invalidUnit.cells[0].metrics.toolUnits.unit = "tokens";
  assert.equal(
    normalizeParticipantCommunityComparison(invalidUnit).reason,
    "comparison_contract_invalid",
  );
  const invalidProvider = comparison("participant-community-comparison-v0.1");
  invalidProvider.cells[0].provider = "unknown_provider";
  assert.equal(
    normalizeParticipantCommunityComparison(invalidProvider).reason,
    "comparison_contract_invalid",
  );

  // An unreleased contract is still refused.
  assert.equal(
    normalizeParticipantCommunityComparison(
      comparison("participant-community-comparison-v0.3"),
    ).status,
    "not_testable",
  );
});


test("the model table separates allowance tracks and never conflates zero with unpriced", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /id="accounting-model-pagination"/u);
  assert.match(html, /id="accounting-model-page-prev"/u);
  assert.match(html, /id="accounting-model-page-status"/u);
  assert.match(html, /id="accounting-model-page-next"/u);
  assert.match(
    appSource,
    /paginateCacheImpactRows\(\s*modelRows,\s*accountingModelsTablePagination,/u,
  );
  assert.doesNotMatch(
    styles,
    /\.model-identity\s*\{[^}]*display:\s*block/u,
    "the identity td must participate in the native table-column layout",
  );
  assert.match(styles, /\.model-identity\s*\{\s*display:\s*table-cell;\s*\}/u);
  const start = appSource.indexOf("function modelUsageRows(accounting) {");
  const end = appSource.indexOf("function renderAccountingModels(", start);
  assert.ok(start >= 0 && end > start, "the model-table helpers are available");
  const countStart = appSource.indexOf("function formatCount(value) {");
  const countEnd = appSource.indexOf("function formatDecimal(", countStart);
  assert.ok(countStart >= 0 && countEnd > countStart, "the count formatter is available");

  const table = Function(
    "node",
    "setLocalizedText",
    "setRawText",
    "t",
    "finite",
    "formatNumber",
    "formatApiMoney",
    `${appSource.slice(start, end)}\n${appSource.slice(countStart, countEnd)}`
      + "\nreturn { modelUsageRows, modelApiEquivalentCell, formatCount };",
  )(
    () => ({ title: "", textContent: "" }),
    (element, key) => { element.textContent = key; },
    (element, value) => { element.textContent = value; },
    (key) => key,
    (value, fallback = null) =>
      (typeof value === "number" && Number.isFinite(value) ? value : fallback),
    (value, options) => new Intl.NumberFormat("en-US", options).format(value),
    (value) => new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value),
  );

  const row = (model, extra) => ({
    model,
    events: 1,
    totalTokens: 1,
    apiPriceEquivalentUsd: 0,
    pricingStatus: "priced",
    allowanceTrack: "primary",
    apiPriceEquivalentApplicable: true,
    ...extra,
  });

  // Spark is metered separately, so it gets its own row and sorts last: there
  // is no money figure to rank it against the primary pool with.
  const rows = table.modelUsageRows({
    byModel: [row("gpt-5.6-sol", { apiPriceEquivalentUsd: 12 })],
    spark: {
      byModel: [row("gpt-5.3-codex-spark", {
        allowanceTrack: "spark",
        pricingStatus: "known_unpriced",
        apiPriceEquivalentApplicable: false,
      })],
    },
  });
  assert.deepEqual(rows.map((item) => item.model), [
    "gpt-5.6-sol",
    "gpt-5.3-codex-spark",
  ]);

  // Four situations one em dash used to cover, now four different sentences.
  const cellText = (candidate) =>
    table.modelApiEquivalentCell(candidate).textContent;
  assert.equal(cellText(rows[1]), "accounting.model.separateAllowance");
  assert.equal(
    cellText(row("codex-auto-review", { pricingStatus: "known_unpriced" })),
    "accounting.model.noPublishedPrice",
  );
  assert.equal(
    cellText(row("unknown", { pricingStatus: "unrecognized" })),
    "accounting.model.notPricedUnknown",
  );
  assert.equal(
    cellText(row("gpt-5.4", { apiPriceEquivalentUsd: null })),
    "accounting.model.notReported",
  );
  assert.equal(cellText(row("gpt-5.5")), "$0.00");

  // One formatter for the count columns: "154,900" beside "74", never
  // "154.9K" beside "74".
  assert.equal(table.formatCount(154_900), "154,900");
  assert.equal(table.formatCount(74), "74");
  assert.equal(table.formatCount(null), "accounting.model.notReported");
});


// The shareable card is the one surface whose output is meant to leave the
// machine as a picture, where nothing can be unshared and no reader can audit
// what produced it. These two tests hold the properties that make posting it
// safe: it can only paint fixed copy and formatted figures, and it always
// carries a reference in the format the diagnostic log records.
function shareCardSource(appSource) {
  const start = appSource.indexOf("// Shareable results card");
  const end = appSource.indexOf("function groupRolling(");
  assert.ok(start !== -1 && end > start, "the results-card section is available");
  return appSource.slice(start, end);
}

/**
 * The first argument of every `call` in `source`, whitespace-normalized.
 *
 * Scanning for the argument rather than matching a line catches a painted
 * value however it is formatted, including one wrapped across lines.
 */
function firstArguments(source, call) {
  const found = [];
  for (
    let index = source.indexOf(call);
    index !== -1;
    index = source.indexOf(call, index + call.length)
  ) {
    const start = index + call.length;
    let depth = 0;
    let cursor = start;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "(" || character === "[") depth += 1;
      else if (character === ")" || character === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === "," && depth === 0) break;
    }
    found.push(source.slice(start, cursor).trim().replace(/\s+/gu, " "));
  }
  return found;
}

/**
 * Load the plan-label helpers in isolation, injecting the two values they
 * intentionally depend on from the surrounding browser module.
 */
async function loadShareCardPlan() {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("const SHARE_CARD_PLAN_LABELS");
  const end = appSource.indexOf("\nlet shareCard = null;", start);
  assert.ok(start >= 0 && end > start, "the plan-label helpers are available");
  const section = appSource.slice(start, end);
  return Function(
    "finite",
    "TELEMETRY_PLAN_DISPLAY_NAMES",
    "TELEMETRY_PLAN_TYPES",
    `${section}\nreturn { SHARE_CARD_PLAN_LABELS, shareCardPlanLabel, shareCardPlan };`,
  )(
    (value, fallback = null) => (
      typeof value === "number" && Number.isFinite(value) ? value : fallback
    ),
    TELEMETRY_PLAN_DISPLAY_NAMES,
    TELEMETRY_PLAN_TYPES,
  );
}

test("the share card names only a known, most-recent Codex plan", async () => {
  const { SHARE_CARD_PLAN_LABELS, shareCardPlanLabel, shareCardPlan } =
    await loadShareCardPlan();

  assert.equal(shareCardPlanLabel("pro"), "Pro (20×)");
  assert.equal(shareCardPlanLabel("prolite"), "Pro Lite (5×)");
  assert.equal(shareCardPlanLabel("plus"), "Plus");
  assert.equal(shareCardPlanLabel("edu_plus"), "Edu Plus");
  assert.equal(shareCardPlanLabel("edu_pro"), "Edu Pro");
  assert.equal(
    shareCardPlanLabel("self_serve_business_prolite"),
    "Business · Pro Lite (5×)",
  );
  assert.equal(shareCardPlanLabel("unknown"), "");
  assert.equal(shareCardPlanLabel(""), "");
  assert.equal(shareCardPlanLabel("  "), "");
  assert.equal(shareCardPlanLabel("teamplus"), "");
  assert.equal(shareCardPlanLabel(undefined), "");
  assert.equal(shareCardPlanLabel(null), "");
  assert.ok(!Object.hasOwn(SHARE_CARD_PLAN_LABELS, "unknown"));
  assert.deepEqual(
    Object.keys(SHARE_CARD_PLAN_LABELS).sort(),
    TELEMETRY_PLAN_TYPES.filter((plan) => plan !== "unknown").sort(),
  );

  assert.equal(
    shareCardPlan([
      { planType: "plus", observedAt: "2026-08-01T00:00:00.000Z" },
      { planType: "pro", observedAt: "2026-08-13T00:00:00.000Z" },
    ]),
    "Pro (20×)",
  );
  assert.equal(
    shareCardPlan([
      { planType: "pro", observedAt: "2026-08-13T00:00:00.000Z" },
      { planType: "plus", observedAt: "2026-08-01T00:00:00.000Z" },
    ]),
    "Pro (20×)",
  );
  assert.equal(
    shareCardPlan([
      { planType: "pro", observedAt: "2026-08-13T00:00:00.000Z" },
      { planType: "unknown", observedAt: "2026-08-20T00:00:00.000Z" },
    ]),
    "Pro (20×)",
  );
  assert.equal(shareCardPlan([{ planType: "pro", observedAt: "" }]), "Pro (20×)");
  assert.equal(
    shareCardPlan([
      { planType: "plus", observedAt: "2026-08-13T00:00:00.000Z" },
      { planType: "pro", observedAt: "" },
    ]),
    "Plus",
  );
  assert.equal(shareCardPlan([{ planType: "unknown" }]), "");
  assert.equal(
    shareCardPlan([{ observedAt: "2026-08-20T00:00:00.000Z" }]),
    "",
  );
  assert.equal(shareCardPlan([]), "");
  assert.equal(shareCardPlan(null), "");
});

test("the share card wires plan copy through the canvas and transcript", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  assert.match(
    section,
    /const planLabel = data\.allowancePlanSelection\s*\n\s*\? shareCardPlanLabel\(data\?\.weekly\?\.planType\) \|\| t\("weekly\.plan\.unknown"\)\s*\n\s*: shareCardPlan\(data\?\.quotaWindows \?\? \[\]\);/u,
  );
  assert.match(
    section,
    /plan: planLabel === "" \? "" : t\(\s*\n\s*data\.allowancePlanSelection \? "share\.planAllowance" : "share\.plan",\s*\n\s*\{ plan: planLabel \},\s*\n\s*\),/u,
  );
  assert.match(
    section,
    /if \(card\.plan !== ""\) \{\s*\n\s*drawShareCardPlan\(context, card\.plan, SHARE_CARD_WIDTH - margin, 156\);/u,
  );
  assert.match(section, /function drawShareCardPlan\(context, plan, right, baseline\) \{/u);
  assert.match(section, /context\.fillText\(plan, x \+ 13, baseline\);/u);
  assert.doesNotMatch(
    section.match(/function drawShareCardPlan[\s\S]*?\n\}/u)?.[0] ?? "",
    /toLocaleUpperCase/u,
  );
  assert.match(
    section,
    /t\("share\.text\.header", \{ subtitle: card\.subtitle, title: card\.title \}\),\s*\n(?:\s*\/\/[^\n]*\n)*\s*card\.plan,/u,
  );

  assert.ok(Object.hasOwn(WEB_MESSAGES, "share.plan"));
  assert.equal(WEB_MESSAGES["share.plan"].length, SUPPORTED_LOCALES.length);
  for (const locale of SUPPORTED_LOCALES) {
    const copy = translate("share.plan", { plan: "Pro (20×)" }, locale);
    assert.match(copy, /Pro \(20×\)/u, locale);
    assert.doesNotMatch(copy, /\{plan\}/u, locale);
  }

  // The additive plan field must not replace the evidence date in the image
  // signature: a card remains tied to its observed headline date.
  const signature = section.match(/const signature = JSON\.stringify\(\[([\s\S]*?)\]\);/u)?.[1];
  assert.ok(signature, "the share-card signature is available");
  assert.match(signature, /headlineDate,/u);
  assert.match(signature, /shareCardPlan\(data\?\.quotaWindows \?\? \[\]\),/u);
  assert.match(signature, /data\.allowancePlanSelection \?\? null,/u);
  assert.match(section, /caveats\.push\(t\("share\.caveat\.planConditional"\)\);/u);
});

test("a posted results card can carry only fixed copy and formatted figures", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // Everything painted onto the image. Each entry is either a literal written
  // here, a formatted number, or a field of the frozen card model, so a
  // payload string cannot reach the canvas without failing this list. A
  // prompt, a response, a file path, a folder name, a URL, an account
  // identifier or an email would all have to arrive as one of these.
  // Re-pinned 2026-08-08 (owner-directed card v4): the identifier/debug line
  // left the image (it survives in the text transcript, the file name, and
  // the chip beside the card), the top-right corner prints the app version
  // instead of the home host, and the trend corner states the shown-of-total
  // population sentence rather than a bare subset count.
  assert.deepEqual(
    [...new Set(firstArguments(section, "context.fillText("))].sort(),
    [
      "\"TiboTattle\"",
      "badge",
      "card.trendCount",
      "card.trendEmpty",
      "card.trendEmptyDetail",
      "card.trendLabel.toLocaleUpperCase(localization.locale())",
      "card.versionLabel",
      // The plot's marker key, composed in `buildShareCard` from the chart's
      // own series labels and frozen onto `card.trendLegend` (2026-08-19):
      // the outlined short-observation marker is a claim about evidence the
      // picture could not otherwise explain.
      "entry.label",
      "formatMoney(value, axisDigits)",
      "line",
      "plan",
      "shareCardFit(context, card.subtitle, inner)",
      "shareCardFit(context, card.title, inner)",
      "shareCardFit(context, stat.value, textWidth)",
      "tick.label",
      "xAxisLabel",
      "yAxisLabel",
    ],
  );

  // The whole of the dashboard the card is allowed to see. Everything here is
  // a number, a fixed enumeration, or a version identifier; no field carries
  // user text, and a card that started reading one would fail this list.
  // data.accounting.periods joined 2026-08-10 (owner-directed): the activity
  // figure follows the usage chart's selected range, and the selection reads
  // only per-period numbers, the fastMode enum, and pricing-coverage counts,
  // then labels the range through fixed message keys — never a payload label.
  assert.deepEqual(
    [...new Set(
      [...section.matchAll(/data\??\.[A-Za-z]+(?:\?\.[A-Za-z]+)*/gu)].map((match) => match[0]),
    )].sort(),
    [
      "data.accounting",
      "data.allowancePlanSelection",
      "data?.accounting?.periods",
      "data?.freshness?.latestObservedAt",
      "data?.mode",
      "data?.pricing",
      "data?.pricing?.coveragePercent",
      "data?.pricing?.fastMode?.unweightedUnknownApiPriceEquivalentUsd",
      "data?.pricing?.fastMode?.weightingStatus",
      "data?.pricing?.quotaWeightedTotalCostUsd",
      "data?.pricing?.registryVersion",
      "data?.pricing?.totalCostUsd",
      "data?.quotaWindows",
      "data?.schemaVersion",
      "data?.weekly?.planType",
      "data?.weekly?.summary",
      "data?.weekly?.summary?.median",
      "data?.weekly?.summary?.medianWeeklyValueUsd",
    ],
  );

  // The card receives the same derived history model as the Allowance page.
  // It cannot independently read raw local records, change the active range,
  // hide shorter fits, or select a different vertical scale.
  const trend = section.match(
    /function shareCardTrend\(history\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(trend, "the plotted history builder is available");
  assert.deepEqual(
    [...new Set([...trend.matchAll(/point\?\.[A-Za-z0-9_]+/gu)].map((match) => match[0]))].sort(),
    [
      "point?.acrossResetHigh",
      "point?.acrossResetLow",
      "point?.at",
      "point?.high",
      "point?.historicalMedian",
      "point?.low",
      "point?.value",
    ],
  );
  assert.match(trend, /Array\.isArray\(history\?\.points\)/u);
  assert.match(trend, /dateLabel: point\.dateLabel,/u);
  assert.match(trend, /wellObserved: point\.wellObserved === true,/u);
  assert.match(trend, /const axisLow = finite\(history\?\.axis\?\.low\);/u);
  assert.match(trend, /axis: Object\.freeze\(\{[\s\S]*?low: axisLow,/u);
  assert.match(trend, /xTicks: Object\.freeze\(\[\.\.\.\(history\?\.xTicks \?\? \[\]\)\]\),/u);
  assert.match(trend, /firstDateLabel: points\[0\]\.dateLabel,/u);
  assert.match(trend, /lastDateLabel: points\[points\.length - 1\]\.dateLabel,/u);
  assert.doesNotMatch(
    section,
    /toLocaleString|toLocaleDateString|toLocaleTimeString|toISOString/u,
  );
  // The date formatter follows the independently selected regional format in
  // the viewer's time zone. It accepts the parsed number, not a source string.
  assert.match(
    section,
    /function shareCardDateLabel\(timestamp\) \{[\s\S]*?new Intl\.DateTimeFormat\(getFormattingLocale\(\), \{[\s\S]*?month: "short",[\s\S]*?day: "numeric",[\s\S]*?year: "numeric",/u,
  );
  assert.match(
    section,
    /if \(!Number\.isFinite\(timestamp\)\) return "";/u,
  );
  assert.match(
    section,
    /function shareCardHeadlineDate\(data, history\) \{\s*\n\s*const latestObservedAt = Date\.parse\(data\?\.freshness\?\.latestObservedAt \?\? ""\);\s*\n\s*const timestamp = Number\.isFinite\(history\?\.anchorAt\)\s*\n\s*\? history\.anchorAt\s*\n\s*: latestObservedAt;\s*\n\s*return shareCardDateLabel\(timestamp\);\s*\n\}/u,
  );
  assert.match(section, /const yAxisLabel = t\("share\.axis\.allowance"\);/u);
  assert.match(section, /const xAxisLabel = t\("share\.axis\.resetEstimateDate"\);/u);
  assert.match(section, /for \(const value of axis\.ticks\) \{[\s\S]*?formatMoney\(value, axisDigits\)/u);
  assert.match(section, /for \(const tick of xTicks\) \{[\s\S]*?context\.fillText\(tick\.label, tickX, plotBottom \+ 21\);/u);
  assert.match(section, /const bandLow = finite\(points\[0\]\?\.acrossResetLow\);/u);
  assert.match(section, /const median = finite\(points\[0\]\?\.historicalMedian\);/u);
  assert.doesNotMatch(
    section,
    /SHARE_CARD_TREND_MAX_POINTS|function shareCardTrendAxis|function shareCardTrendDateTicks/u,
  );
  // The classification is fixed in the shared model, not read from the
  // on-screen control, so two readers of the same evidence post the same
  // picture.
  assert.doesNotMatch(section, /weeklySpanThresholdPp|showWeeklyPartialDiagnostics/u);

  // The three free-form strings that do arrive are each replaced before use.
  // A window's own label is never printed and an allowance is selected only
  // through the stable normal-Codex quota predicate, not its translated label.
  assert.match(
    section,
    /function shareCardWindowKind\(window\) \{\s*\n\s*if \(!isPrimaryCodexQuotaWindow\(window\)\) return "other";\s*\n\s*const minutes = finite\(window\?\.durationMinutes\);/u,
  );
  // A provider-reported 30-day window is a real allowance denominator. It
  // must win selection rather than being silently replaced with the old
  // seven-day/five-hour fallback, and it must suppress weekly-only history.
  const providerReportedThirtyDayWindow = 43_200;
  assert.equal(providerReportedThirtyDayWindow, 30 * 24 * 60);
  assert.match(
    section,
    /const selected = selectPrimaryCodexQuotaWindow\(observed\);\s*\n\s*return selected;/u,
  );
  assert.doesNotMatch(section, /observed\.find\(/u);
  assert.match(
    section,
    // A selected plan population is itself an explicit seven-day calibration
    // contract, even when its historical account has no current quota window.
    // Legacy payloads still cannot borrow a seven-day fit for another duration.
    /const isWeeklyWindow = data\.allowancePlanSelection !== undefined\s*\n\s*\|\| shareCardWindowKind\(allowanceWindow\) === "seven_day";/u,
  );
  assert.match(
    section,
    /const capacity = isWeeklyWindow \? finite\(/u,
  );
  assert.match(
    section,
    /const trend = isWeeklyWindow \? shareCardTrend\(history\) : null;/u,
  );
  // The population sentence is composed only from the frozen trend's numbers
  // and fixed range/span vocabulary.
  assert.match(
    section,
    /trendCount: trend === null \? "" : shareCardTrendCountLabel\(trend\),/u,
  );
  assert.match(
    section,
    /\? t\("share\.trend\.countWithFloor", \{/u,
  );
  assert.match(
    section,
    /: t\("share\.trend\.countAnySpan", values\);/u,
  );
  assert.match(
    section,
    /localizedQuotaWindowDuration\(window\?\.durationMinutes\)/u,
  );
  assert.deepEqual(
    [...new Set(
      [...section.matchAll(/\b(?:window|allowanceWindow)\??\.[A-Za-z]+/gu)]
        .map((match) => match[0])
        .filter((value) => !value.startsWith("window.")),
    )].sort(),
    [
      "allowanceWindow?.durationMinutes",
      "allowanceWindow?.remainingPercent",
      "window?.durationMinutes",
      "window?.remainingPercent",
    ],
  );
  // A period name is looked up in the product's own vocabulary and then
  // translated from a stable key. The arriving string is matched, never
  // rendered, so even a recognized label reaches the image only as fixed copy.
  assert.match(
    section,
    /function shareCardPeriodLabel\(candidate\) \{\s*\n\s*return t\(SHARE_CARD_PERIOD_KEYS\.get\(candidate\) \?\? "share\.period\.recorded"\);/u,
  );
  const phrases = section.match(
    /const SHARE_CARD_PERIOD_KEYS = new Map\(\[([\s\S]*?)\]\);/u,
  )?.[1];
  assert.ok(phrases, "the period vocabulary is available");
  assert.deepEqual(
    [...phrases.matchAll(/\["([^"]+)", "([^"]+)"\]/gu)].map((match) => match[1]),
    [
      "All retained evidence",
      "Cached 31-day window",
      "Cached 31-day collector window",
      "Last 24 hours",
      "Last 30 days",
      "Last 7 days",
      "Recorded period",
    ],
  );
  // The range-selected label comes from the fixed SHARE_CARD_RANGE_PERIODS
  // key map (owner-directed, 2026-08-10); the payload's own period label
  // remains the fallback and still passes through the fixed vocabulary.
  assert.match(
    section,
    /const period = activity !== null\s*\n\s*\? t\(activity\.labelKey\)\s*\n\s*: shareCardPeriodLabel\(pricing\.periodLabel\);/u,
  );
  assert.match(
    section,
    /const SHARE_CARD_RANGE_PERIODS = Object\.freeze\(\{/u,
  );
  assert.equal(
    section.match(/pricing\.periodLabel/gu).length,
    1,
    "the period label is read only through the fixed vocabulary",
  );
  // Both version identifiers are accepted only in a shape that cannot hold a
  // path, a sentence, or a quoted value.
  assert.match(
    section,
    /const SHARE_CARD_REGISTRY_VERSION_PATTERN = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,47\}\$\/u;/u,
  );
  assert.match(
    section,
    /const SHARE_CARD_APP_VERSION_PATTERN = \/\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$\/u;/u,
  );
  assert.match(
    section,
    /return typeof candidate === "string"\s*\n\s*&& SHARE_CARD_REGISTRY_VERSION_PATTERN\.test\(candidate\)/u,
  );
  assert.match(
    section,
    /return SHARE_CARD_APP_VERSION_PATTERN\.test\(value \?\? ""\) \? value : "";/u,
  );

  // The link prints a host and nothing else, so no path, query or fragment
  // from the page's own canonical URL can be carried into a post.
  assert.match(
    section,
    /const host = new URL\(canonical\)\.hostname\.replace\(\/\^www\\\.\/u, ""\);\s*\n\s*return SHARE_CARD_HOME_PATTERN\.test\(host\) \? host : fallback;/u,
  );
  assert.doesNotMatch(section, /\.pathname|\.search|\.hash|location\.href/u);

  // Composed once and frozen, so nothing can be appended to a card between
  // composition and painting.
  assert.match(section, /return Object\.freeze\(\{\s*\n\s*reference,/u);
  assert.match(section, /stats: Object\.freeze\(stats\.map\(\(stat\) => Object\.freeze\(\{ \.\.\.stat \}\)\)\)/u);

  // The image and its accessible label are rendered from that one frozen card.
  // The redundant text transcript is intentionally absent from the primary UI.
  assert.match(section, /canvas\.setAttribute\("aria-label", shareCardText\(shareCard\)\);/u);
  assert.doesNotMatch(section, /renderShareCardReadout\(shareCard\);/u);
  assert.match(section, /if \(!drawShareCard\(canvas, shareCard\)\)/u);

  // The page makes the same promise beside the card.
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="share-panel"/u);
  // Re-pinned 2026-08-08 (third round): tolerate the caption's own wrapping —
  // the promise itself is what is pinned, not the line break positions.
  assert.match(
    html,
    /It contains no\s+prompts, responses, paths, account details, or raw\s+activity/u,
  );
  // Re-pinned 2026-08-08 (owner-directed, third round): the share panel sits
  // ABOVE the "See individual usage changes" disclosure, and its header is
  // the title plus ONE caption sentence — the filter promise and the privacy
  // promise together, with the earlier multi-paragraph explainer gone.
  const sharePosition = html.indexOf('id="share-panel"');
  const disclosurePosition = html.indexOf(
    "<summary>See individual usage changes</summary>",
  );
  assert.ok(sharePosition >= 0 && disclosurePosition >= 0);
  assert.ok(sharePosition < disclosurePosition);
  assert.match(
    html,
    /The card follows the chart’s active date range and span filter\.\s*\n?\s*It contains no\s*\n?\s*prompts, responses, paths, account details, or raw\s*\n?\s*activity\./u,
  );
  const sharePanelHtml = html.slice(
    sharePosition,
    html.indexOf('class="share-preview"', sharePosition),
  );
  assert.equal(
    (sharePanelHtml.match(/class="annotation"/gu) ?? []).length,
    1,
    "the share panel header carries exactly one caption paragraph",
  );
  assert.doesNotMatch(
    html,
    /A ready-to-post image of the three headline figures\./u,
  );
  // The chart renderer owns the card re-render (owner-verified regression,
  // 2026-08-08): renderWeekly ends by redrawing the card from the SAME
  // history model it drew, and the range/span handlers rely on that instead
  // of each carrying its own card call that a new path could forget.
  assert.match(
    appSource,
    /renderWeeklyTable\(values\);\s*\n[\s\S]{0,640}?renderShareCard\(data, \{ history \}\);\s*\n\}/u,
  );
  assert.doesNotMatch(appSource, /renderShareCard\(dashboard\);/u);
});

/**
 * The plotted-history helpers in isolation, with the same two formatters and
 * the real catalogue behind them, so the strings asserted here are the ones a
 * reader gets.
 */
async function loadShareCardTrendHelpers() {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);
  const helper = (name) => {
    const match = section.match(
      new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, "u"),
    );
    assert.ok(match, `${name} is available`);
    return match[0];
  };
  const names = [
    "shareCardTrend",
    "shareCardTrendLegend",
    "shareCardTrendShortText",
  ];
  return Function(
    "finite",
    "t",
    "tPlural",
    "formatDecimal",
    "formatNumber",
    `${names.map(helper).join("\n")}\nreturn { ${names.join(", ")} };`,
  )(
    finite,
    (key, values) => translate(key, values),
    (key, count, values) => translatePlural(key, count, values),
    (value, digits = 0) => numberFormatter({
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(value),
    formatNumber,
  );
}

function shareCardTrendHistory(shortSpans) {
  return {
    points: shortSpans.map((short, index) => ({
      at: Date.parse(`2026-08-1${index + 2}T00:00:00.000Z`),
      dateLabel: `Aug 1${index + 2}, 2026`,
      value: 1_900 + index,
      low: 1_800,
      high: 2_000,
      historicalMedian: 1_874,
      acrossResetLow: 1_541,
      acrossResetHigh: 2_432,
      wellObserved: !short,
    })),
    axis: { low: 1_000, high: 3_000, ticks: [1_000, 2_000, 3_000] },
    xTicks: [],
    totalCount: 31,
    spanFloorPp: 0,
    wellObservedFloorPp: 50,
    rangeDays: 7,
  };
}

test("a posted card explains its outlined marker, or draws none", async () => {
  const {
    shareCardTrend,
    shareCardTrendLegend,
    shareCardTrendShortText,
  } = await loadShareCardTrendHelpers();

  // A short observation only reaches the plot because a range of seven days
  // or less relaxes the inclusion floor to zero. The classification floor it
  // failed is a different number, and it is the one the key must name.
  const mixed = shareCardTrend(shareCardTrendHistory([true, false, false]));
  assert.equal(mixed.count, 3);
  assert.equal(mixed.shortCount, 1);
  assert.equal(mixed.spanFloorPp, 0);
  assert.equal(mixed.wellObservedFloorPp, 50);

  const legend = shareCardTrendLegend(mixed);
  assert.deepEqual(legend.map((entry) => entry.filled), [true, false]);
  assert.equal(legend[0].label, translate("weekly.series.wellObserved", { span: "50" }));
  assert.match(legend[0].label, /50/u);
  assert.equal(legend[1].label, translate("weekly.series.shortObservation"));
  assert.ok(Object.isFrozen(legend) && legend.every((entry) => Object.isFrozen(entry)));

  // The text transcript is the only card a screen reader or a text-only post
  // gets, so the difference the picture draws is stated there too.
  const sentence = shareCardTrendShortText({ trend: mixed });
  assert.match(sentence, /1 of these is a short observation/u);
  assert.match(sentence, /outlined marker/u);
  assert.equal(
    shareCardTrendShortText({ trend: { ...mixed, shortCount: 2 } }),
    translatePlural("share.text.shortObservation", 2, { count: "2" }),
  );

  // The common card draws no key and claims nothing: every plotted fit
  // carries the filled marker, so there is no difference to explain.
  const clean = shareCardTrend(shareCardTrendHistory([false, false]));
  assert.equal(clean.shortCount, 0);
  assert.deepEqual(shareCardTrendLegend(clean), []);
  assert.equal(shareCardTrendShortText({ trend: clean }), "");
  assert.deepEqual(shareCardTrendLegend(null), []);
  assert.equal(shareCardTrendShortText({ trend: null }), "");

  // A slider left at zero classifies nothing as short, but a fit with no
  // recorded span is still never promoted, so the key names the honest
  // all-spans series rather than a "0+ pp" threshold nobody set.
  const unfloored = shareCardTrend({
    ...shareCardTrendHistory([true, false]),
    wellObservedFloorPp: 0,
  });
  assert.equal(
    shareCardTrendLegend(unfloored)[0].label,
    translate("weekly.series.allSpans"),
  );

  // Every locale carries both forms, and both count the fits they describe.
  const entry = WEB_PLURAL_MESSAGES["share.text.shortObservation"];
  assert.ok(entry, "the short-observation sentence is catalogued");
  for (const form of ["one", "other"]) {
    assert.equal(entry[form].length, SUPPORTED_LOCALES.length);
    for (const message of entry[form]) assert.ok(message.includes("{count}"));
  }
});

test("the posted card's marker key is drawn by the same calls as its points", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // One palette, two draw sites: a key painted from its own colours could
  // drift from the markers it explains without any test noticing.
  assert.match(section, /context\.fillStyle = point\.wellObserved \? "#315f84" : "#fffef9";/u);
  assert.match(section, /context\.fillStyle = entry\.filled \? "#315f84" : "#fffef9";/u);
  assert.equal(section.match(/#a9492f/gu).length, 2);
  assert.equal(section.match(/context\.arc\([^\n]*4\.5, 0, Math\.PI \* 2\);/gu).length, 2);

  // The key is drawn only when the model composed one, and it restores the
  // canvas state the axis labels below it inherit.
  assert.match(
    section,
    /if \(card\.trendLegend\.length > 0\) \{\s*\n\s*context\.save\(\);[\s\S]*?context\.restore\(\);\s*\n\s*\}/u,
  );
  assert.match(section, /trendLegend: shareCardTrendLegend\(trend\),/u);
  // The transcript line joins the composed card text, where an empty string
  // is dropped by the existing filter.
  assert.match(section, /figures,\s*\n\s*shareCardTrendText\(card\),\s*\n\s*shareCardTrendShortText\(card\),/u);

  // The classification floor travels with the shared history model rather
  // than being read from the slider at paint time.
  assert.match(appSource, /wellObservedFloorPp: activeWeeklyMinimumObservedSpanPp,/u);
  assert.match(section, /wellObservedFloorPp: finite\(history\?\.wellObservedFloorPp, 0\),/u);
});

test("the posted allowance graph uses the exact history model from the dashboard", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // A single presentation model owns range selection, point inclusion,
  // classification, vertical bounds, and date landmarks. A seven-day card
  // takes that exact model; a different provider-reported allowance duration
  // deliberately receives no borrowed seven-day graph.
  assert.match(appSource, /function allowanceHistoryChartModel\(data,/u);
  assert.match(appSource, /function allowanceHistoryAxis\(points\)/u);
  assert.match(appSource, /function allowanceHistoryDateTicks\(points, maximum = 4\)/u);
  assert.match(
    appSource,
    /function renderWeekly\(data\) \{[\s\S]*?const history = allowanceHistoryChartModel\(data\);/u,
  );
  assert.match(appSource, /shell\.replaceChildren\(renderAllowanceHistoryChart\(history\)\);/u);
  assert.match(
    section,
    // Re-pinned 2026-08-08 (owner-verified regression): the chart renderer
    // hands its own model in; the card derives one only when rendered
    // standalone, and both reads share the active-filter state.
    /const isWeeklyWindow = data\.allowancePlanSelection !== undefined\s*\n\s*\|\| shareCardWindowKind\(allowanceWindow\) === "seven_day";\s*\n\s*const history = isWeeklyWindow\s*\n\s*\? sharedHistory \?\? allowanceHistoryChartModel\(data\)\s*\n\s*: null;\s*\n\s*const trend = isWeeklyWindow \? shareCardTrend\(history\) : null;/u,
  );
  assert.match(
    section,
    /history = null,/u,
  );
  assert.doesNotMatch(
    section,
    /SHARE_CARD_TREND_MAX_POINTS|shareCardTrendAxis|shareCardTrendDateTicks/u,
  );
});

test("a posted results card always carries a diagnostic-format reference", async () => {
  // The reference is minted by the same helper the diagnostic surfaces use, so
  // a card someone posts can be matched against the local log.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const reference = createDiagnosticReference(webcrypto);
    assert.match(reference, DIAGNOSTIC_REFERENCE_PATTERN);
    assert.match(reference, /^TT-[0-9A-Z]{6}$/u);
    assert.doesNotMatch(reference, /[ILOU]/u);
  }

  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);

  // No card is composed at all without a reference in that format, so an image
  // can never be saved or copied untraceable.
  assert.match(
    section,
    /if \(!DIAGNOSTIC_REFERENCE_PATTERN\.test\(reference \?\? ""\)\) \{\s*\n\s*throw new TypeError\("A results card requires a minted reference\."\);/u,
  );
  assert.match(section, /shareCardReference = createDiagnosticReference\(\);/u);
  assert.doesNotMatch(section, /Math\.random|Date\.now|new Date\(/u);

  // One image and one reference always describe the same figures: the
  // reference is re-minted whenever any printed figure changes.
  const signature = section.match(
    /const signature = JSON\.stringify\(\[([\s\S]*?)\]\);/u,
  )?.[1];
  assert.ok(signature, "the figure signature is available");
  for (const figure of [
    "data?.mode",
    "headlineDate,",
    "shareCardWindowKind(allowanceWindow)",
    "finite(allowanceWindow?.durationMinutes)",
    "finite(allowanceWindow?.remainingPercent)",
    "data.allowancePlanSelection ?? null",
    "finite(data?.pricing?.quotaWeightedTotalCostUsd)",
    "finite(data?.pricing?.totalCostUsd)",
    "finite(data?.pricing?.coveragePercent)",
    "finite(data?.weekly?.summary?.median_weekly_value_usd",
    "trend,",
  ]) {
    assert.ok(signature.includes(figure), `${figure} re-mints the reference`);
  }
  assert.match(
    section,
    // Re-pinned 2026-08-08 (owner-verified regression): the chart renderer
    // hands its own model in; the card derives one only when rendered
    // standalone, and both reads share the active-filter state.
    /const isWeeklyWindow = data\.allowancePlanSelection !== undefined\s*\n\s*\|\| shareCardWindowKind\(allowanceWindow\) === "seven_day";\s*\n\s*const history = isWeeklyWindow\s*\n\s*\? sharedHistory \?\? allowanceHistoryChartModel\(data\)\s*\n\s*: null;\s*\n\s*const trend = isWeeklyWindow \? shareCardTrend\(history\) : null;/u,
  );
  assert.match(
    section,
    /if \(signature !== shareCardSignature \|\| shareCardReference === ""\) \{/u,
  );

  // Re-pinned 2026-08-08 (owner-directed): the identifier line no longer
  // paints on the image — the reference reaches a reader through the text
  // transcript's trailer and the saved file's name — and the toasts stopped
  // claiming otherwise.
  assert.match(section, /const identifiers = \[\s*\n\s*t\("share\.identifier\.debug", \{ reference \}\),/u);
  assert.match(section, /t\("share\.identifier\.version", \{/u);
  assert.doesNotMatch(section, /price table \$\{registryVersion\}/u);
  assert.doesNotMatch(section, /fillText\(\s*\n?\s*shareCardFit\(context, card\.identifierLine/u);
  assert.match(section, /identifierLine: identifiers\.join\(" · "\),/u);
  assert.match(
    section,
    /return `tibotattle-results-\$\{card\.reference\}\.png`;/u,
  );
  assert.match(
    section,
    /The file name carries reference \$\{card\.reference\}\./u,
  );
  assert.doesNotMatch(section, /is printed on the image/u);

  // Re-pinned 2026-08-08 (owner-directed, second round): the "TT-XXXXXX"
  // header chip is gone from the panel — a code the reader could not act on.
  // The reference still travels with every saved file's name.
  assert.doesNotMatch(section, /share-card-reference/u);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="share-card-reference"/u);
  assert.doesNotMatch(html, /id="share-card-readout"/u);
});

test("a posted results card states a figure in full, dates real evidence, and marks a fixture", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const section = shareCardSource(appSource);
  const localizationSource = await readFile(new URL("../public/localization.js", import.meta.url), "utf8");

  // One type size for the whole row, chosen so the longest figure fits its
  // column whole. "Not estimable" and a seven-figure total both overrun the
  // column at the full size, and a figure cut off mid-word in the largest type
  // on the card is unreadable at a glance and easy to misread as a smaller
  // number.
  assert.match(
    section,
    /function shareCardValueSize\(context, values, maxWidth\) \{[\s\S]*?if \(values\.every\(\(value\) => context\.measureText\(value\)\.width <= maxWidth\)\) \{/u,
  );
  assert.match(
    section,
    /const valueSize = shareCardValueSize\(\s*\n\s*context,\s*\n\s*card\.stats\.map\(\(stat\) => stat\.value\),\s*\n\s*textWidth,\s*\n\s*\);/u,
  );
  assert.match(section, /context\.font = shareCardFont\(500, valueSize, "serif"\);/u);
  assert.doesNotMatch(section, /shareCardFont\(500, 54, "serif"\)/u);
  // Every value the card can print for missing evidence comes from a stable
  // semantic key, so the size that fits it is the size the row is drawn at.
  for (const key of [
    "share.value.notObserved",
    "share.value.notAvailable",
    "share.value.notEstimable",
  ]) {
    assert.ok(section.includes(`t("${key}")`), `${key} is one of the fixed figures`);
  }

  // A real card uses the line under the title for the weekly headline's
  // newest-fit date. The old local-privacy tagline is intentionally absent.
  assert.match(
    section,
    /subtitle: isDemo\s*\n\s*\? t\("share\.subtitle\.demo"\)\s*\n\s*: headlineDate,/u,
  );
  assert.doesNotMatch(appSource, /share\.subtitle\.local/u);
  assert.doesNotMatch(localizationSource, /Measured on my own Mac\. Nothing left it\./u);
  // A fixture is marked where a reader scrolling a timeline will see it: in
  // that same line and on a mark beside the wordmark, not only in the smallest
  // copy on the image.
  assert.match(section, /badge: isDemo \? t\("share\.badge\.demo"\) : "",/u);
  assert.match(section, /if \(card\.badge !== ""\) \{\s*\n\s*drawShareCardBadge\(/u);
  // The mark is drawn in the header, above the figures it qualifies.
  assert.ok(
    section.indexOf("drawShareCardBadge(\n      context,")
      < section.indexOf("card.stats.forEach"),
    "the demo mark is drawn before the figures",
  );
  // And the caveat that says the same thing stays, first in the list.
  assert.match(
    section,
    /if \(isDemo\) \{\s*\n\s*caveats\.push\(t\("share\.caveat\.demo"\)\);/u,
  );

  // The history takes exactly the room the qualifications leave, but a card
  // without material qualifications is allowed to use that visual height.
  // Re-pinned 2026-08-08 (owner-directed): the identifier footer and its rule
  // are gone from the image, so caveats anchor at the card's bottom edge and
  // the reclaimed footer band belongs to the chart.
  assert.match(
    section,
    /const caveatBaseY = SHARE_CARD_HEIGHT - 26;/u,
  );
  assert.match(
    section,
    /const caveatTop = caveatLines\.length === 0\s*\n\s*\? caveatBaseY \+ 22\s*\n\s*: caveatBaseY - \(caveatLines\.length - 1\) \* caveatStep;/u,
  );
  assert.doesNotMatch(section, /ruleY/u);
  assert.match(
    section,
    /const trendHeight = Math\.min\(\s*\n\s*SHARE_CARD_TREND_MAX_HEIGHT,\s*\n\s*Math\.max\(SHARE_CARD_TREND_MIN_HEIGHT, caveatTop - 30 - trendTop\),\s*\n\s*\);/u,
  );
  // Re-pinned 2026-08-07 (owner-directed card v3): the separate
  // activity-versus-allowance sentence row is gone — each stat's own detail
  // line names its denominator — and the chart takes the reclaimed height.
  assert.match(section, /const trendTop = statTop \+ statHeight \+ 34;/u);
  assert.doesNotMatch(section, /relationshipNote/u);
  assert.match(section, /label: t\(data\.allowancePlanSelection\s*\n\s*\? "share\.stat\.recordedActivityAllPlans" : "share\.stat\.recordedActivity"\),/u);
  assert.match(
    section,
    /label: isWeeklyWindow\s*\n\s*\? t\("share\.stat\.estimatedAllowance"\)\s*\n\s*: t\("share\.stat\.estimatedAllowanceUnavailable"\),/u,
  );
  assert.match(
    section,
    /detail: !isWeeklyWindow\s*\n\s*\? t\("share\.detail\.notApplicableToWindow"\)/u,
  );
  // The social image reuses the date landmarks and vertical domain from the
  // Allowance estimate history, instead of inventing a compact-card axis.
  assert.match(appSource, /function allowanceHistoryDateTicks\(points, maximum = 4\)/u);
  assert.match(appSource, /xTicks: history\.xTicks,/u);
  assert.match(appSource, /yDomain: history\.axis,/u);
  assert.match(section, /for \(const tick of xTicks\)/u);
  assert.match(
    section,
    /context\.textAlign = tick\.alignment === "middle" \? "center" : tick\.alignment;/u,
    "the shared SVG tick alignment is translated to a valid Canvas alignment",
  );
  assert.doesNotMatch(section, /shareCardTrendDateTicks|shareCardTrendAxis/u);
  // 420 → 472 (owner-directed, 2026-08-08): the retired identifier footer's
  // vertical band goes to the plot's ceiling.
  assert.match(section, /const SHARE_CARD_TREND_MAX_HEIGHT = 472;/u);
  assert.match(section, /const SHARE_CARD_TREND_MIN_HEIGHT = 168;/u);
  // Only the qualifications that can change interpretation survive on a
  // social image; the full evidence remains in the local app.
  assert.match(appSource, /const SHARE_CARD_MAX_CAVEATS = 2;/u);
  assert.match(appSource, /const SHARE_CARD_MAX_CAVEAT_LINES = 2;/u);

  // The posted image and the preview element describe the same picture.
  assert.match(appSource, /const SHARE_CARD_WIDTH = 1200;/u);
  assert.match(appSource, /const SHARE_CARD_HEIGHT = 800;/u);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<canvas\s+id="share-card-canvas"[\s\S]*?width="1200"\s*\n\s*height="800"/u,
  );
});

test("a refresh finished by the native shell makes the page re-read its evidence", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  // Inside the app window the page's own return-visit refresh stands down, so
  // nothing else moves the rendered numbers off the snapshot the document
  // loaded with. This listener is the only thing that does.
  assert.match(
    appSource,
    /window\.addEventListener\("tibotattle:local-evidence-updated", \(\) => \{\s*\n\s*void reloadLocalEvidenceAfterNativeRefresh\(\);/u,
  );
  assert.match(
    appSource,
    /async function reloadLocalEvidenceAfterNativeRefresh\(\) \{[\s\S]*?await loadQuickResultDashboard\(\);/u,
  );
  // A refresh this page is already driving re-renders on its own completion; a
  // second overlapping read would only race it.
  assert.match(
    appSource,
    /async function reloadLocalEvidenceAfterNativeRefresh\(\) \{[\s\S]*?if \(nativeEvidenceReloadInFlight \|\| localRefreshInProgress \|\| localActionBusy\) \{\s*\n\s*return;/u,
  );
  // And the reason the shell has to send that signal at all is unchanged: the
  // web return-visit timer must not race the native one.
  assert.match(
    appSource,
    /function scheduleReturningUserRefresh\(\) \{[\s\S]*?if \(runsInsideNativeDashboard\(\)\) return;/u,
  );
});

test("a chart says so when its series does not reach back as far as its label", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // Both trend charts carry the statement; both are drawn from the same
  // retained usage series and both are labelled by their own range control.
  assert.match(html, /<p class="series-coverage" id="timeline-coverage" role="status" hidden><\/p>/u);
  assert.match(html, /<p class="series-coverage" id="usage-timeline-coverage" role="status" hidden><\/p>/u);
  assert.match(
    appSource,
    /renderSeriesCoverage\(\s*\$\("#timeline-coverage"\),\s*data,\s*activeCalibrationRangeDays,\s*\)/u,
  );
  assert.match(
    appSource,
    /renderSeriesCoverage\(\s*\$\("#usage-timeline-coverage"\),\s*data,\s*activeUsageRangeDays,\s*\)/u,
  );

  // "All" claims everything retained, so it is covered by definition.
  assert.match(appSource, /const ALL_HISTORY_RANGE_DAYS = 36_500;/u);
  assert.match(
    appSource,
    /if \(!Number\.isFinite\(rangeDays\) \|\| rangeDays >= ALL_HISTORY_RANGE_DAYS\) return null;/u,
  );
  // Measured against the extent of the retained series, not the first drawn
  // point: an idle night inside a covered week is not a missing week.
  assert.match(
    appSource,
    /function seriesCoverageShortfall\(data, rangeDays\) \{[\s\S]*?const earliestMs = Date\.parse\(usage\[0\]\.startAt \?\? usage\[0\]\.endAt\);/u,
  );
  assert.match(
    appSource,
    /function seriesCoverageShortfall\(data, rangeDays\) \{[\s\S]*?if \(coveredMs >= claimedMs \* SERIES_COVERAGE_TOLERANCE\) return null;/u,
  );

  // A withheld accounting cache is named, because it is repairable and because
  // the existing warning for that state speaks only about prices.
  assert.match(
    appSource,
    /data\?\.pricing\?\.accountingCacheStatus === "unavailable"\s*\n\s*\? "dashboard\.series\.shortOfRangeWithheldCache"\s*\n\s*: "dashboard\.series\.shortOfRange"/u,
  );
});

// ---------------------------------------------------------------------------
// Degraded-state register (owner dogfood, 2026-08-19). A companion note whose
// state resolves by itself — a load already in flight, tracking that simply
// started fresh — is information, and must not wear the alert treatment that
// belongs to genuine caveats on degraded figures. The classing is matched on
// the companion's own vocabulary, so the published sentences and the matcher
// are pinned together: rewording either alone fails here instead of silently
// restyling the note. The withheld-cache sentences are deliberately not
// pinned in either direction — serve-stale-while-recalculating replaces that
// state wholesale, and its copy and rendering are owned there.
// ---------------------------------------------------------------------------

test("dashboard warnings omit internal tool history while preserving usage caveats and diagnostics", () => {
  const toolWarning =
    "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
  const usageWarning = "Some usage events name an unrecognized model and remain unpriced rather than being assigned a guessed price.";
  const historyWarning = "The unified local index is unreadable.";
  const otherToolWarning = "Some tool activity has unpriced usage.";
  const toolClasses = {
    status: "unavailable",
    reason: "typed_tool_history_partial",
    total: null,
    counts: Object.fromEntries(
      ["apply_patch", "local_shell", "other", "subagent", "tool_gateway"]
        .map((key) => [key, null]),
    ),
  };
  const overview = {
    warnings: [
      toolWarning,
      usageWarning,
      { message: toolWarning },
      { message: historyWarning },
      "",
      null,
      {},
      otherToolWarning,
    ],
    activity: { toolEvents: null },
    pricing: { totalCostUsd: 12.5 },
    accounting: { toolClasses },
    timeline: {
      history: { status: "partial", reason: "typed_tool_history_partial" },
    },
  };
  const original = structuredClone(overview);
  for (const dashboard of [
    normalizeDashboardPayload(overview),
    normalizeDashboardPayload({ overview }),
    normalizeDashboardPayload({}, { overview }),
  ]) {
    assert.deepEqual(dashboard.warnings, [usageWarning, historyWarning, otherToolWarning]);
    assert.equal(dashboard.pricing.totalCostUsd, 12.5);
    assert.equal(dashboard.activity.toolEvents, null);
    assert.deepEqual(dashboard.accounting.toolClasses, toolClasses);
    assert.equal(dashboard.timeline.history.status, "partial");
    assert.equal(dashboard.timeline.history.reason, "typed_tool_history_partial");
  }
  assert.deepEqual(overview, original, "source diagnostics stay unchanged for retention and inspection");
  assert.deepEqual(normalizeDashboardPayload({ warnings: [toolWarning] }).warnings, []);
});

test("self-resolving degraded notes are classed informational and keep the quiet style", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const companionSource = await readFile(
    new URL("../../../src/local-companion-data.js", import.meta.url),
    "utf8",
  );

  // The renderer consults the informational matcher and emits the class.
  const matcherSource = appSource.match(
    /const EVIDENCE_WARNING_INFORMATIONAL =\n  \/(.*)\/(\w+);/u,
  );
  assert.ok(matcherSource, "the informational matcher is available");
  const informational = new RegExp(matcherSource[1], matcherSource[2]);
  assert.match(
    appSource,
    /EVIDENCE_WARNING_INFORMATIONAL\.test\(message\)\s*\n\s*\? "evidence-warning informational"/u,
  );
  // The quiet treatment is the shared progress blue, not a third palette.
  assert.match(
    styles,
    /\.evidence-warning\.progress,\n\.evidence-warning\.informational \{\n  border-inline-start-color: var\(--blue\);/u,
  );
  assert.match(
    "Local analysis complete with limited history coverage",
    informational,
  );
  assert.match(appSource, /historyCoverageNoticeKind\(\{/u);
  assert.doesNotMatch("known gap", informational);

  // The self-resolving sentences the companion actually publishes. Each must
  // exist verbatim in the companion source and fall inside the matcher's
  // vocabulary, so a reword cannot silently drop one back to the alert style.
  const informationalSentences = [
    "Quota tracking started fresh on this Mac, so its retained records begin"
      + " on ${trackingStartDate}. Coverage of anything earlier is not claimed.",
    "Full indexed history is loading. The latest replay-safe snapshot is shown"
      + " meanwhile and will be replaced only by the completed full projection.",
  ];
  for (const sentence of informationalSentences) {
    assert.ok(
      companionSource.includes(sentence),
      `the companion publishes: ${sentence}`,
    );
    assert.match(sentence, informational);
  }

  // The retained-evidence relabel sentence (owner-reported, 2026-08-21): it
  // replaces the loading/withheld claims whenever the data store serves
  // retained figures, so it is on screen for part of every refresh cycle and
  // must keep the quiet progress treatment. The renderer consults the
  // progress matcher before the informational one, so "still" is what holds
  // the style.
  const progressMatcherSource = appSource.match(
    /const EVIDENCE_WARNING_PROGRESS =\n  \/(.*)\/(\w+);/u,
  );
  assert.ok(progressMatcherSource, "the progress matcher is available");
  const progress = new RegExp(progressMatcherSource[1], progressMatcherSource[2]);
  const retainedRefreshSentence =
    "The full history projection is still being recalculated in the"
      + " background. The figures shown are the most recent completed"
      + " projection and are replaced automatically when it finishes.";
  assert.ok(
    companionSource.includes(retainedRefreshSentence),
    "the companion publishes the retained-evidence refresh sentence",
  );
  assert.match(retainedRefreshSentence, progress);

  // Genuine caveats on the figures being shown (or genuinely missing) keep
  // the alert treatment: none may drift into the informational vocabulary.
  const alertSentences = [
    "The newest retained collector evidence is more than"
      + " ${Math.round(MAX_COLLECTOR_LIVE_AGE_MS / 60_000)} minutes old. This"
      + " is expected after an idle stretch; any newer usage is counted on the"
      + " next collector pass.",
    "Recent cost figures come from the live collector projection until the"
      + " replay-safe cache is refreshed. They may double-count usage that"
      + " forked child sessions inherited.",
    "Indexed-history totals include ${historyCoverage.indexedSourceCount} of"
      + " ${historyCoverage.sourceCount} verified sources."
      + " ${historyCoverage.skippedSourceCount} sources across"
      + " ${historyCoverage.skippedThreadCount} threads did not pass local"
      + " validation. This is a material coverage gap; missing usage remains"
      + " unavailable rather than zero.",
  ];
  for (const sentence of alertSentences) {
    assert.ok(
      companionSource.includes(sentence),
      `the companion publishes: ${sentence}`,
    );
    assert.doesNotMatch(sentence, informational);
  }
});

// ---------------------------------------------------------------------------
// Session-rejected repair fallback (owner-reported repair loop, 2026-08-08).
// A stored session the service no longer recognizes must produce ONE sign-in
// gate, never a repeated step-2 failure paragraph, and the ceremony must
// resume by itself after the next sign-in.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Exact-windows pagination (owner-directed, 2026-08-08): ten rows per page
// over the FULL merged inspection list, with the shown range stated as
// "N–M of T" and the page index clamped inside the renderer.
// ---------------------------------------------------------------------------

async function loadResidualInspectionTable({ rows, page = 0 }) {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function renderResidualInspectionTable()");
  const end = appSource.indexOf("\n// A tick label's resolution", start);
  assert.ok(start >= 0 && end > start, "the inspection-table renderer is available");
  const section = appSource.slice(start, end);

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        textContent: "",
        hidden: false,
        disabled: false,
        children: [],
        append(...appended) { this.children.push(...appended); },
      });
    }
    return elements.get(id);
  };
  const state = { page };
  Function(
    "$", "clear", "node", "t", "setLocalizedText",
    "formatNumber", "formatChartTimestamp", "formatPp", "timelineStatusLabel",
    "residualInspectionRows", "state",
    `const RESIDUAL_TABLE_PAGE_SIZE = 10;
let residualTablePage = state.page;
${section}
renderResidualInspectionTable();
state.page = residualTablePage;`,
  )(
    (selector) => element(selector),
    (target) => { target.children = []; },
    (tag, className = "", text = "") => ({
      tag,
      className,
      textContent: text,
      children: [],
      append(...appended) { this.children.push(...appended); },
    }),
    (key) => `[${key}]`,
    (target, key, values = {}) => {
      target.textContent = `[${key}] ${JSON.stringify(values)}`;
    },
    (value) => String(value),
    (value) => String(value),
    (value) => value === null ? "—" : `${value} pp`,
    (status) => `status:${status}`,
    rows,
    state,
  );
  return {
    page: state.page,
    table: element("#residual-table"),
    pagination: element("#residual-pagination"),
    status: element("#residual-page-status"),
    previous: element("#residual-page-prev"),
    next: element("#residual-page-next"),
  };
}

test("the exact-windows table pages ten rows at a time and states the shown range", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
    observed: index,
    expected: 1,
    residual: index - 1,
    status: "matched",
  }));

  const first = await loadResidualInspectionTable({ rows, page: 0 });
  assert.equal(first.table.children.length, 10);
  assert.equal(first.pagination.hidden, false);
  assert.equal(
    first.status.textContent,
    '[residual.table.page] {"start":"1","end":"10","total":"25"}',
  );
  assert.equal(first.previous.disabled, true);
  assert.equal(first.next.disabled, false);

  const last = await loadResidualInspectionTable({ rows, page: 2 });
  assert.equal(last.table.children.length, 5);
  assert.equal(
    last.status.textContent,
    '[residual.table.page] {"start":"21","end":"25","total":"25"}',
  );
  assert.equal(last.previous.disabled, false);
  assert.equal(last.next.disabled, true);

  // A page index that outlived its row set clamps instead of rendering blank.
  const clamped = await loadResidualInspectionTable({ rows, page: 99 });
  assert.equal(clamped.page, 2);
  assert.equal(clamped.table.children.length, 5);

  // No rows: the empty sentence renders and the pager leaves the page.
  const empty = await loadResidualInspectionTable({ rows: [], page: 0 });
  assert.equal(empty.pagination.hidden, true);
  assert.equal(empty.table.children.length, 1);
  assert.equal(empty.table.children[0].children[0].textContent, "[residual.table.empty]");
});

test("the inspection list keeps every row and restarts paging when the selection changes", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // Pagination replaced the eight-row cap: the merge takes both halves whole.
  assert.match(
    appSource,
    /const inspection = balancedInspectionRows\(\s*unmatched,\s*largest,\s*unmatched\.length \+ largest\.length,\s*\);/u,
  );
  assert.doesNotMatch(appSource, /balancedInspectionRows\(unmatched, largest, 8\)/u);
  // A changed selection restarts at the first page.
  assert.match(
    appSource,
    /if \(signature !== residualInspectionSignature\) \{\s*\n\s*residualInspectionSignature = signature;\s*\n\s*residualTablePage = 0;\s*\n\s*\}/u,
  );
  // The pager's controls exist on the page, and the Prev/Next labels carry
  // legacy translations for the static inventory.
  assert.match(html, /id="residual-pagination"/u);
  assert.match(html, /id="residual-page-prev"/u);
  assert.match(html, /id="residual-page-next"/u);
  assert.match(html, /id="residual-page-status"[^>]*role="status"/u);
  for (const locale of SUPPORTED_LOCALES) {
    const range = translate(
      "residual.table.page",
      { start: "11", end: "20", total: "40" },
      locale,
    );
    assert.ok(range.includes("11") && range.includes("20") && range.includes("40"), `${locale} pager range names all three figures`);
  }
});

// ---------------------------------------------------------------------------
// Cumulative residual view (owner-directed, 2026-08-08): a per-bucket
// non-overlapping running sum, re-anchored at each reset boundary or track
// change, plus the signed-AUC "Cumulative drift" stat beside MAE and peak.
// ---------------------------------------------------------------------------

const TEST_ALLOWANCE_BASIS_FAMILY =
  "codex_primary:speed_priced_api_equivalent:v3:priority_card_ratio_2026_08_30:event_time:observed_declared_scenario";
const testAllowanceBasisId = (scenario) =>
  `${TEST_ALLOWANCE_BASIS_FAMILY}:${scenario}`;
const testAllowanceWeighting = (selectedUsd, { available = true } = {}) => ({
  status: available ? "complete" : "unavailable",
  basisFamilyId: TEST_ALLOWANCE_BASIS_FAMILY,
  selectedScenario: available ? "unresolved_as_fast" : null,
  selectedUsd: available ? selectedUsd : null,
  scenarios: {
    unresolved_as_standard: {
      basisId: testAllowanceBasisId("unresolved_as_standard"),
      quotaWeightedUsd: available ? selectedUsd : null,
    },
    unresolved_as_fast: {
      basisId: testAllowanceBasisId("unresolved_as_fast"),
      quotaWeightedUsd: available ? selectedUsd : null,
    },
  },
  rangeUsd: null,
});
const testAllowanceCapacity = (medianCapacityUsd = 1_000) => ({
  status: "available",
  basisFamilyId: TEST_ALLOWANCE_BASIS_FAMILY,
  selectedScenario: "unresolved_as_fast",
  scenarios: {
    unresolved_as_fast: {
      basisId: testAllowanceBasisId("unresolved_as_fast"),
      medianCapacityUsd,
    },
  },
});

async function loadLiveTimelinePoints() {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const usageStart = appSource.indexOf("function allowanceTimelineUsage(data) {");
  const usageEnd = appSource.indexOf("\nfunction renderComparison(", usageStart);
  assert.ok(usageStart >= 0 && usageEnd > usageStart, "allowanceTimelineUsage is available");
  const start = appSource.indexOf("function mainWeeklyQuotaTrack(rows) {");
  const end = appSource.indexOf("\nfunction groupedUsageTimeline(");
  assert.ok(start >= 0 && end > start, "liveTimelinePoints is available");
  const section = appSource.slice(start, end);
  const liveTimelinePoints = Function(
    "finite",
    "timelineCutoffMs",
    "createQuotaTimelineLookup",
    "classifyTimelineEvidence",
    "isPrimaryCodexWeeklyQuotaWindow",
    "CALIBRATION_WINDOW_HOURS",
    "activeCalibrationRangeDays",
    `${appSource.slice(usageStart, usageEnd)}\n${section}\nreturn liveTimelinePoints;`,
  )(
    finite,
    () => Number.NEGATIVE_INFINITY,
    createQuotaTimelineLookup,
    classifyTimelineEvidence,
    isPrimaryCodexWeeklyQuotaWindow,
    3,
    36_500,
  );
  // Existing lifecycle tests predate the weighted DTO. Give those fixtures a
  // matching basis by default, while tests that exercise a mismatch provide
  // their own explicit weighting/capacity.
  return (data, options) => {
    const legacyCapacity = finite(
      data?.weekly?.summary?.blended_capacity_usd
        ?? data?.weekly?.summary?.median_weekly_value_usd
        ?? data?.gradient?.summary?.capacity_usd,
      1_000,
    );
    return liveTimelinePoints({
      ...data,
      timeline: {
        ...data.timeline,
        allowanceCapacity: data.timeline.allowanceCapacity
          ?? testAllowanceCapacity(legacyCapacity),
        usage: data.timeline.usage.map((row) => ({
          ...row,
          allowanceWeighting: row.allowanceWeighting
            ?? testAllowanceWeighting(row.apiPriceEquivalentUsd),
        })),
      },
    }, options);
  };
}

test("selected-plan rolling windows and cumulative drift cannot bridge an omitted era or ambiguous bucket", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const base = Date.parse("2026-08-05T00:00:00Z");
  const hour = (i) => new Date(base + i * 3_600_000).toISOString();
  const usage = [0, 1, 3, 4, 5].map((i) => ({ startAt: hour(i), endAt: hour(i + 1),
    usageEvents: 1, apiPriceEquivalentUsd: 10, allowanceWeighting: testAllowanceWeighting(10) }));
  const points = liveTimelinePoints({
    allowancePlanSelection: { comparisonAvailable: true },
    timeline: { usage, selectedPlanUsage: usage,
      comparisonIntervals: [[base, base + 2 * 3_600_000], [base + 3 * 3_600_000, base + 6 * 3_600_000]],
      quota: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ observedAt: hour(i),
        usedPercent: i * 2, remainingPercent: 100 - i * 2, limitId: "codex",
        durationMinutes: 10_080, resetAt: "2026-08-12T00:00:00Z" })) },
  }, { windowHours: 3 });
  const crossing = points.find((p) => p.timestamp === hour(4));
  assert.equal(crossing.expected, null);
  assert.equal(crossing.observed, null);
  assert.equal(crossing.residual, null);
  assert.equal(crossing.status, "reset_or_track_change");
  assert.equal(crossing.driftReanchor, true);
  assert.equal(crossing.cumulativeResidual, 0);
  const recovered = points.find((p) => p.timestamp === hour(6));
  assert.equal(recovered.expected, 3);
  assert.equal(recovered.observed, 6);
  assert.equal(recovered.residual, 3);
});

test("cumulative drift sums non-overlapping buckets and re-anchors at each reset boundary", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const hour = (index) => new Date(Date.UTC(2026, 7, 5, index)).toISOString();
  const quotaRow = (index, usedPercent, resetAt) => ({
    observedAt: hour(index),
    limitId: "codex",
    durationMinutes: 10_080,
    slot: "primary",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
  });
  const firstReset = "2026-08-10T00:00:00.000Z";
  const secondReset = "2026-08-17T00:00:00.000Z";
  const data = {
    timeline: {
      allowanceCapacity: testAllowanceCapacity(),
      usage: Array.from({ length: 9 }, (_, index) => ({
        startAt: hour(index),
        endAt: hour(index + 1),
        // Standard cost deliberately differs: every allowance-facing result
        // below must use the speed-priced $50 instead of this $20.
        apiPriceEquivalentUsd: 20,
        allowanceWeighting: testAllowanceWeighting(50),
        usageEvents: 5,
      })),
      quota: [
        quotaRow(1, 10, firstReset),
        quotaRow(2, 22, firstReset),
        quotaRow(3, 24, firstReset),
        // The provider moved to the next reset window: the accumulation must
        // restart at zero rather than bridging the discontinuity.
        quotaRow(4, 1, secondReset),
        quotaRow(5, 2, secondReset),
      ],
    },
  };
  const points = liveTimelinePoints(data);
  assert.equal(points.length, 9);
  // $50 of each hourly bucket against a $1,000 capacity implies 5 pp; the
  // observed quota rows move 12 pp then 2 pp, so the drift runs +7 then
  // decays; the boundary at hour 4 re-anchors to exactly zero; a quota
  // bracket older than the 3-hour freshness bound suspends the line (null)
  // instead of letting the static observation read as ever-growing drift.
  assert.deepEqual(
    points.map((point) => point.cumulativeResidual),
    [0, 7, 4, 0, -4, -9, -14, -19, null],
  );
  // The first comparable window is recovered forward from hour 1, so this
  // point legitimately spans two weighted buckets rather than the nominal
  // three-hour window.
  assert.equal(points[2].measuredSpanMs, 2 * 60 * 60 * 1_000);
  assert.equal(points[2].allowanceWeightedUsd, 100);
});

test("an unweightable bucket creates a red-line gap instead of falling back to Standard cost", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const hour = (index) => new Date(Date.UTC(2026, 7, 5, index)).toISOString();
  const data = {
    timeline: {
      allowanceCapacity: testAllowanceCapacity(),
      usage: [
        {
          startAt: hour(0),
          endAt: hour(1),
          usageEvents: 1,
          apiPriceEquivalentUsd: 20,
          allowanceWeighting: testAllowanceWeighting(50),
        },
        {
          startAt: hour(1),
          endAt: hour(2),
          usageEvents: 1,
          apiPriceEquivalentUsd: 20,
          allowanceWeighting: testAllowanceWeighting(null, {
            available: false,
          }),
        },
      ],
      quota: [],
    },
  };
  const points = liveTimelinePoints(data);
  assert.equal(points[0].expected, 5);
  assert.equal(points[0].allowanceWeightedUsd, 50);
  assert.equal(points[1].expected, null);
  assert.equal(points[1].allowanceWeightedUsd, null);
  assert.equal(points[1].status, "quota_weighting_unavailable");
  assert.notEqual(points[0].apiCostUsd, 20);
});

test("a single stale quota dip suspends one drift point instead of re-anchoring", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const hour = (index) => new Date(Date.UTC(2026, 7, 5, index)).toISOString();
  const resetAt = "2026-08-10T00:00:00.000Z";
  const quotaRow = (index, usedPercent) => ({
    observedAt: hour(index),
    limitId: "codex",
    durationMinutes: 10_080,
    slot: "primary",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
  });
  // Live-corpus shape (2026-05-26: 59 -> 6 -> 61): one interleaved reading
  // from a stale source, immediately recovered, same resetAt. Re-anchoring on
  // it would poison the baseline so the recovery books ~+55pp of fabricated
  // sustained drift; the two-consecutive-readings rule holds it to a single
  // suspended point.
  const data = {
    weekly: { summary: { median_weekly_value_usd: 2_000 } },
    gradient: { summary: {} },
    timeline: {
      usage: Array.from({ length: 12 }, (_, index) => ({
        startAt: hour(index),
        endAt: hour(index + 1),
        apiPriceEquivalentUsd: 10,
        usageEvents: 5,
      })),
      quota: [
        quotaRow(1, 55),
        quotaRow(2, 56),
        quotaRow(3, 57),
        quotaRow(4, 58),
        quotaRow(5, 6), // stale interleaved reading
        quotaRow(6, 58),
        quotaRow(7, 59),
        quotaRow(8, 59),
        quotaRow(9, 60),
        quotaRow(10, 60),
        quotaRow(11, 61),
      ],
    },
  };
  const points = liveTimelinePoints(data);
  // Exactly one re-anchor: the series start. The dip itself suspends.
  assert.deepEqual(
    points.flatMap((point, index) => (point.driftReanchor ? [index] : [])),
    [0],
  );
  assert.equal(points[4].cumulativeResidual, null);
  // Drift resumes from the SAME anchor after the recovery — never a jump of
  // the dip's magnitude.
  for (const point of points) {
    assert.ok(point.cumulativeResidual === null
      || Math.abs(point.cumulativeResidual) < 10);
  }
  const detection = detectDeviationPeriods(points, {
    usageBuckets: data.timeline.usage,
  });
  assert.equal(detection.periods.length, 0);
});

test("two consecutive confirming readings re-anchor the drift at a banked reset", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const hour = (index) => new Date(Date.UTC(2026, 7, 5, index)).toISOString();
  const resetAt = "2026-08-10T00:00:00.000Z";
  const quotaRow = (index, usedPercent) => ({
    observedAt: hour(index),
    limitId: "codex",
    durationMinutes: 10_080,
    slot: "primary",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
  });
  const data = {
    weekly: { summary: { median_weekly_value_usd: 2_000 } },
    gradient: { summary: {} },
    timeline: {
      usage: Array.from({ length: 8 }, (_, index) => ({
        startAt: hour(index),
        endAt: hour(index + 1),
        apiPriceEquivalentUsd: 10,
        usageEvents: 5,
      })),
      quota: [
        quotaRow(1, 55),
        quotaRow(2, 56),
        quotaRow(3, 57),
        // Banked reset keeps resets_at but the display drops and STAYS down.
        quotaRow(4, 6),
        quotaRow(5, 7),
        quotaRow(6, 8),
        quotaRow(7, 9),
      ],
    },
  };
  const points = liveTimelinePoints(data);
  // The first low reading suspends; the second confirms and re-anchors to 0.
  assert.equal(points[3].cumulativeResidual, null);
  assert.equal(points[3].driftReanchor, false);
  assert.equal(points[4].cumulativeResidual, 0);
  assert.equal(points[4].driftReanchor, true);
  // Post-reset drift measures from the new anchor, not the pre-reset level.
  for (const point of points.slice(5)) {
    assert.ok(point.cumulativeResidual === null
      || Math.abs(point.cumulativeResidual) < 10);
  }
});

test("a window starting inside a collection silence anchors forward and shrinks to the measured span", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const hour = (index) => new Date(Date.UTC(2026, 7, 5, index)).toISOString();
  const resetAt = "2026-08-10T00:00:00.000Z";
  const quotaRow = (index, usedPercent) => ({
    observedAt: hour(index),
    limitId: "codex",
    durationMinutes: 10_080,
    slot: "primary",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
  });
  const data = {
    weekly: { summary: { median_weekly_value_usd: 1_000 } },
    gradient: { summary: {} },
    timeline: {
      usage: Array.from({ length: 9 }, (_, index) => ({
        startAt: hour(index),
        endAt: hour(index + 1),
        apiPriceEquivalentUsd: 50,
        usageEvents: 5,
      })),
      // Collection was silent until hour 5 (sleep/idle): the first
      // observations of the work session sit INSIDE the early windows.
      quota: [
        quotaRow(5, 50),
        quotaRow(6, 55),
        quotaRow(7, 61),
        quotaRow(8, 68),
        quotaRow(9, 76),
      ],
    },
  };
  const points = liveTimelinePoints(data);
  assert.equal(points.length, 9);
  // Windows ending before any observation exists stay honestly excluded —
  // recovery requires an observation strictly inside the window.
  assert.deepEqual(
    points.slice(0, 5).map((point) => point.status),
    Array.from({ length: 5 }, () => "missing_quota_bracket"),
  );
  // Hour 6 (window hours 3..6): backward-only matching excluded this window;
  // the forward anchor at hour 5 shrinks the span to one hour, and the
  // expected side integrates that same hour — $50 of $1,000 is 5 pp against
  // the observed 55−50 = 5 pp.
  const recoveredOne = points[5];
  assert.equal(recoveredOne.status, "matched");
  assert.equal(recoveredOne.observed, 5);
  assert.equal(recoveredOne.expected, 5);
  assert.equal(recoveredOne.measuredSpanMs, 3_600_000);
  assert.equal(recoveredOne.apiCostUsd, 50);
  assert.equal(recoveredOne.usageEvents, 5);
  // Hour 7 (window hours 4..7): the span is two hours, so expected is 10 pp,
  // never the full-window 15 pp — the two lines integrate the same interval.
  const recoveredTwo = points[6];
  assert.equal(recoveredTwo.status, "matched");
  assert.equal(recoveredTwo.observed, 11);
  assert.equal(recoveredTwo.expected, 10);
  assert.equal(recoveredTwo.measuredSpanMs, 7_200_000);
  assert.equal(recoveredTwo.apiCostUsd, 100);
  // Hour 8 onward the backward match exists again: the nominal window is
  // measured in full.
  const nominal = points[7];
  assert.equal(nominal.status, "matched");
  assert.equal(nominal.observed, 18);
  assert.equal(nominal.expected, 15);
  assert.equal(nominal.measuredSpanMs, 10_800_000);
});

test("forward recovery requires a second observation and never integrates cost past it", async () => {
  const liveTimelinePoints = await loadLiveTimelinePoints();
  const hour = (index) => new Date(Date.UTC(2026, 7, 5, index)).toISOString();
  const atMinutes = (minutes) => new Date(Date.UTC(2026, 7, 5, 0, minutes)).toISOString();
  const resetAt = "2026-08-10T00:00:00.000Z";
  const quotaRow = (observedAt, usedPercent) => ({
    observedAt,
    limitId: "codex",
    durationMinutes: 10_080,
    slot: "primary",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
  });
  const usage = Array.from({ length: 9 }, (_, index) => ({
    startAt: hour(index),
    endAt: hour(index + 1),
    apiPriceEquivalentUsd: 50,
    usageEvents: 5,
  }));
  const capacity = { weekly: { summary: { median_weekly_value_usd: 1_000 } }, gradient: { summary: {} } };

  // A single observation inside the window: atOrAfter(start) and
  // atOrBefore(end) resolve to the SAME row, so observed would be zero over a
  // zero-length span while the window carries real cost. That window must stay
  // missing_quota_bracket — a matched point here would fabricate a negative
  // residual that renderDivergencePeriods reads as an unmeasured under-cost
  // period.
  const single = liveTimelinePoints({
    ...capacity,
    timeline: {
      usage,
      // One observation at 04:30, then silence until hour 8 restores real
      // backward brackets for the tail windows.
      quota: [quotaRow(atMinutes(4 * 60 + 30), 50), quotaRow(hour(8), 61), quotaRow(hour(9), 68)],
    },
  });
  assert.equal(single.length, 9);
  // Windows ending at hours 5..7 see only the 04:30 observation: no second
  // observation, no bracket, no fabricated residual.
  for (const point of single.slice(4, 7)) {
    assert.equal(point.status, "missing_quota_bracket");
    assert.equal(point.observed, null);
    assert.equal(point.residual, null);
  }

  // Two observations, but the end-edge one lags the bucket boundary: the
  // expected side must integrate only to the observation, never to the bucket
  // end, and the measured span must be the observation-to-observation span.
  const lagged = liveTimelinePoints({
    ...capacity,
    timeline: {
      usage,
      // Observations at 04:30 and 06:00; the window ending 07:00 anchors
      // forward on 04:30 and its end edge falls back to 06:00.
      quota: [quotaRow(atMinutes(4 * 60 + 30), 50), quotaRow(hour(6), 55)],
    },
  });
  assert.equal(lagged.length, 9);
  const recovered = lagged[6];
  assert.equal(recovered.status, "matched");
  assert.equal(recovered.observed, 5);
  // Only the buckets ending in (04:30, 06:00] count: hours 5 and 6, $100 of
  // $1,000 capacity = 10 pp. Integrating to the 07:00 bucket end would have
  // claimed 15 pp against 5 pp observed — movement nobody measured.
  assert.equal(recovered.expected, 10);
  assert.equal(recovered.apiCostUsd, 100);
  assert.equal(recovered.usageEvents, 10);
  assert.equal(recovered.measuredSpanMs, 90 * 60 * 1_000);
});

test("timeline exclusion copy names only the mechanisms that actually fired", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("const TIMELINE_EXCLUSION_MESSAGE_KEYS");
  const end = appSource.indexOf("\nfunction renderTimelineConfidence(");
  assert.ok(start >= 0 && end > start, "describeTimelineExclusions is available");
  const describeTimelineExclusions = Function(
    "t",
    "tPlural",
    `${appSource.slice(start, end)}\nreturn describeTimelineExclusions;`,
  )(
    (key) => (key === "dashboard.timeline.exclusionJoin" ? "; " : `<${key}>`),
    (key, count) => `${count} ${key.split(".").at(-1)}`,
  );
  const point = (status, matched = false) => ({
    status,
    observed: matched ? 1 : null,
    expected: matched ? 1 : null,
  });

  // Only the firing mechanisms are named, in classifier order.
  assert.equal(
    describeTimelineExclusions([
      point("missing_quota_bracket"),
      point("missing_quota_bracket"),
      point("reset_or_track_change"),
      point("matched", true),
    ]),
    "2 excludedMissingBracket; 1 excludedResetOrTrackChange",
  );
  // Zero ambiguous windows means the copy never claims ambiguity.
  assert.doesNotMatch(
    describeTimelineExclusions([point("missing_quota_bracket")]),
    /Ambiguous/iu,
  );
  assert.equal(
    describeTimelineExclusions([point("backward_or_ambiguous")]),
    "1 excludedAmbiguousMovement",
  );
  // Matched-family points are never counted as exclusions.
  assert.equal(
    describeTimelineExclusions([point("matched", true)]),
    "<dashboard.timeline.noExclusions>",
  );

  // Every mechanism's copy exists in all three locales, and the retired
  // conflated key is gone.
  for (const key of [
    "dashboard.timeline.excludedMissingBracket",
    "dashboard.timeline.excludedResetOrTrackChange",
    "dashboard.timeline.excludedAmbiguousMovement",
  ]) {
    const entry = WEB_PLURAL_MESSAGES[key];
    assert.ok(entry, `${key} is catalogued`);
    for (const form of ["one", "other"]) {
      assert.equal(entry[form].length, SUPPORTED_LOCALES.length);
      for (const message of entry[form]) {
        assert.ok(message.includes("{count}"), `${key} ${form} counts windows`);
      }
    }
  }
  assert.equal(WEB_PLURAL_MESSAGES["dashboard.timeline.excludedWindow"], undefined);
  assert.doesNotMatch(appSource, /dashboard\.timeline\.excludedWindow/u);
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(translate("dashboard.timeline.noExclusions", {}, locale).trim().length > 0);
    assert.ok(translate("dashboard.timeline.exclusionJoin", {}, locale).length > 0);
  }
});

test("the residual panel draws the cumulative line and states the signed-AUC drift", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // The second series reads the model's cumulative key with its own honest
  // label; the residual series keeps its own.
  assert.match(
    appSource,
    /key: "cumulativeResidual",\s*\n\s*className: "chart-line-expected",\s*\n\s*label: \{ key: "chart\.residual\.cumulativeSeries" \},/u,
  );
  // The stat sits beside MAE and peak, live view integrating the visible
  // residuals and the historical view reporting the artifact's own figure.
  assert.match(
    appSource,
    /t\("dashboard\.summary\.cumulativeDrift"\),\s*\n\s*t\("dashboard\.summary\.cumulativeDriftExplanation"\),\s*\n\s*formatSignedPpHours\(\s*\n?\s*live \? liveSignedAuc : summary\.rolling_signed_auc_pp_hours,?\s*\n?\s*\),/u,
  );
  // The panel names the semantics beside the chart, and the annotation is in
  // the legacy inventory (checked by the static-copy test).
  assert.match(
    html,
    /The second line is cumulative drift: the running sum of each\s*\n?\s*bucket’s observed-minus-expected movement, restarted at every\s*\n?\s*window boundary or track change\./u,
  );
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of [
      "chart.residual.cumulativeSeries",
      "dashboard.summary.cumulativeDrift",
      "dashboard.summary.cumulativeDriftExplanation",
    ]) {
      assert.ok(
        translate(key, {}, locale).trim().length > 0,
        `${locale} carries ${key}`,
      );
    }
    assert.ok(
      translate("format.ppHours", { value: "+4.0" }, locale).includes("+4.0"),
      `${locale} pp·h figure keeps its signed value`,
    );
  }
});

test("the signed AUC stat integrates observed-minus-expected trapezoids over hours", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function signedResidualAucPpHours(matched) {");
  const end = appSource.indexOf("\nfunction renderTimelineSummary", start);
  assert.ok(start >= 0 && end > start, "the signed AUC helper is available");
  const scope = Function(
    "finite",
    "pointTimestampMs",
    "t",
    "formatDecimal",
    `${appSource.slice(start, end)}\nreturn { signedResidualAucPpHours, formatSignedPpHours };`,
  )(
    finite,
    (point) => point.timestampMs,
    (key, values) => `[${key}] ${values.value}`,
    (value, digits = 0) => Number(value).toFixed(digits),
  );
  const base = Date.UTC(2026, 7, 5, 0);
  const point = (hours, observed, expected, residualSegment = 1) => ({
    timestampMs: base + hours * 3_600_000,
    observed,
    expected,
    residualSegment,
  });
  // Two hours between residuals of +1 and +3 pp integrates to +4 pp·h — the
  // exact trapezoid buildRollingResidual uses for the artifact summary.
  assert.equal(
    scope.signedResidualAucPpHours([point(0, 2, 1), point(2, 4, 1)]),
    4,
  );
  // A backwards or zero-length gap contributes nothing rather than NaN.
  assert.equal(
    scope.signedResidualAucPpHours([point(0, 2, 1), point(0, 4, 1)]),
    0,
  );
  assert.equal(
    scope.signedResidualAucPpHours([
      point(0, 2, 1, 1),
      point(2, 4, 1, 2),
    ]),
    0,
  );
  assert.equal(scope.signedResidualAucPpHours([point(0, 2, 1)]), null);
  assert.equal(scope.formatSignedPpHours(null), "—");
  assert.equal(scope.formatSignedPpHours(4), "[format.ppHours] +4.0");
  assert.equal(scope.formatSignedPpHours(-2.5), "[format.ppHours] -2.5");
});

test("divergence window-breakdown normalizer sanitizes to content-free numbers", () => {
  const payload = {
    schemaVersion: "local-companion-v0.1",
    breakdown: {
      status: "available",
      from: 1_000,
      to: 2_000,
      events: 30,
      unpricedShare: 0.1,
      costUsd: 12.5,
      tokens: 4_000,
      fastCostUsd: 3,
      fastEvents: 4,
      byModel: [
        {
          model: "gpt-5.6-sol",
          costUsd: 9,
          tokens: 3_000,
          events: 20,
          unpricedEvents: 0,
          unpricedShare: 0,
          fastModeMultiplier: 2.5,
        },
        // A row with no model name is not evidence and must be dropped.
        { costUsd: 1, events: 1 },
      ],
      bySpeed: {
        standard: { costUsd: 8, tokens: 2_000, events: 15, unpricedEvents: 0, unpricedShare: 0 },
        fast: { costUsd: 3, tokens: 900, events: 4, unpricedEvents: 0, unpricedShare: 0 },
      },
      spark: { events: 2, costUsd: 0.4 },
    },
  };
  const normalized = normalizeWindowBreakdown(payload);
  assert.equal(normalized.status, "available");
  assert.equal(normalized.from, 1_000);
  assert.equal(normalized.to, 2_000);
  assert.equal(normalized.costUsd, 12.5);
  assert.equal(normalized.byModel.length, 1);
  assert.equal(normalized.byModel[0].model, "gpt-5.6-sol");
  assert.equal(normalized.byModel[0].fastModeMultiplier, 2.5);
  assert.equal(normalized.bySpeed.fast.costUsd, 3);
  assert.equal(normalized.spark.events, 2);

  // Wrong schema, unavailable status, and a null payload all read back as
  // an explicit unavailable breakdown, never an empty-but-priced mix.
  assert.equal(normalizeWindowBreakdown(null).status, "unavailable");
  assert.equal(
    normalizeWindowBreakdown({ schemaVersion: "wrong", breakdown: { status: "available" } }).status,
    "unavailable",
  );
  const degraded = normalizeWindowBreakdown({
    schemaVersion: "local-companion-v0.1",
    breakdown: { status: "unavailable" },
  });
  assert.equal(degraded.status, "unavailable");
  assert.deepEqual(degraded.byModel, []);
});

test("divergence window-breakdown client sends bounded integers and degrades on 404", async () => {
  const calls = [];
  const client = new LocalCompanionClient({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        schemaVersion: "local-companion-v0.1",
        breakdown: {
          status: "available",
          from: 100,
          to: 200,
          events: 1,
          unpricedShare: 0,
          costUsd: 1,
          tokens: 1,
          fastCostUsd: 0,
          fastEvents: 0,
          byModel: [{ model: "gpt-5.6-sol", costUsd: 1, tokens: 1, events: 1, unpricedEvents: 0, unpricedShare: 0 }],
          bySpeed: { standard: { costUsd: 1, tokens: 1, events: 1, unpricedEvents: 0, unpricedShare: 0 } },
          spark: { events: 0, costUsd: 0 },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await client.windowBreakdown(100, 200);
  assert.equal(result.status, "available");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/api/local/timeline/window-breakdown?from=100&to=200");

  // A non-integer bound never leaves the page.
  const noCall = [];
  const guardClient = new LocalCompanionClient({
    fetchImpl: async (url) => { noCall.push(url); return new Response("{}", { status: 200 }); },
  });
  assert.equal((await guardClient.windowBreakdown(1.5, 2)).status, "unavailable");
  assert.equal(noCall.length, 0);

  // A companion predating the route answers 404; the panel degrades rather
  // than throwing.
  const oldClient = new LocalCompanionClient({
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.equal((await oldClient.windowBreakdown(100, 200)).status, "unavailable");
});

// The hourly usage chart was reported clipped at the bottom (x-axis and the
// foot of the lines hidden by the shell). At this revision it is not clipped:
// the SVG takes its height from the drawing's own ratio and the shell grows to
// fit, so nothing is letterboxed or clipped. A future edit that pins a fixed
// pixel height, or lets the CSS ratio drift from the viewBox height lineChart
// draws at, would bring the clip back — this pins the contract instead.
test("Trends usage chart sizes from its aspect ratio, never a fixed pixel height", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  const svgBlock = styles.match(/\.chart-shell svg \{([\s\S]*?)\}/u)?.[1] ?? "";
  assert.match(svgBlock, /height: auto;/u, "the shell SVG height is derived, not pinned");
  assert.doesNotMatch(svgBlock, /height: \d+px/u, "a fixed pixel height reinstates the letterbox/clip");
  const timelineRatio = svgBlock.match(/aspect-ratio: 900 \/ (\d+)/u)?.[1];
  assert.ok(timelineRatio, "the timeline chart shell declares an aspect ratio");
  const compactRatio = styles
    .match(/\.chart-shell\.compact-chart svg \{[^}]*aspect-ratio: 900 \/ (\d+)/u)?.[1];
  assert.ok(compactRatio, "the compact chart shell declares an aspect ratio");

  // The CSS ratio has to stay in step with the viewBox height each chart is
  // drawn at, or the SVG is scaled to a box of the wrong shape and clips.
  const timelineHeight = appSource.match(/const TIMELINE_CHART_HEIGHT = (\d+);/u)?.[1];
  const compactHeight = appSource.match(/const COMPACT_CHART_HEIGHT = (\d+);/u)?.[1];
  assert.equal(timelineRatio, timelineHeight, "timeline aspect-ratio matches TIMELINE_CHART_HEIGHT");
  assert.equal(compactRatio, compactHeight, "compact aspect-ratio matches COMPACT_CHART_HEIGHT");
});

// The "Show this window's cost mix" button was reported inert. The button
// expands the period, reprices just that window through the companion, and —
// when the companion cannot answer (an older route, or the accounting cache
// still rebuilding) — states that honestly rather than doing nothing. This
// pins the whole chain so a refactor cannot quietly return it to a dead click.
test("Trends cost-mix toggle expands and degrades honestly when repricing is unavailable", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const localization = await readFile(new URL("../public/localization.js", import.meta.url), "utf8");

  // The click handler toggles the panel and, only on expand, loads the mix.
  assert.match(appSource, /toggle\.addEventListener\("click", \(\) => \{/u);
  assert.match(appSource, /panel\.hidden = open;/u);
  assert.match(appSource, /if \(!open\) loadBreakdown\(\);/u);
  // Loading reprices the exact window; any failure is caught, not swallowed
  // into a no-op.
  assert.match(
    appSource,
    /breakdown = await localClient\.windowBreakdown\(period\.startMs, period\.endMs\);/u,
  );
  assert.match(appSource, /\} catch \{\s*breakdown = null;\s*\}/u);
  // A null or non-available breakdown renders an explicit unavailable state,
  // never an empty panel.
  assert.match(appSource, /if \(!breakdown \|\| breakdown\.status !== "available"\)/u);
  assert.match(appSource, /"divergence\.breakdown\.unavailable"/u);
  assert.match(appSource, /"divergence\.breakdown\.unavailablePlain"/u);
  // The honest-state copy exists in every locale.
  for (const key of ["divergence.breakdown.unavailable", "divergence.breakdown.unavailablePlain"]) {
    const row = localization.match(
      new RegExp(`"${key.replace(/\./gu, "\\.")}": \\[([\\s\\S]*?)\\]`, "u"),
    )?.[1];
    assert.ok(row, `${key} is defined`);
    assert.equal(
      (row.match(/"/gu) ?? []).length,
      6,
      `${key} carries all three languages`,
    );
  }
});

// Owner polish (2026-08-11): the calibration legend used to stack three rows
// high inside the right-aligned control column, and its seven entries all drew
// the same line swatch, so the two plotted lines were not distinguishable from
// the four shaded-window categories. It is a full-width row now, with square
// swatches (the shape the bands take) for the area categories.
test("Trends calibration legend is a full-width row with distinct line and area swatches", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /class="legend calibration-legend"/u);
  // The legend now sits below the heading controls, not inside them.
  assert.ok(
    html.indexOf("calibration-legend") > html.indexOf('id="timeline-reset-zoom"'),
    "the legend follows the chart controls rather than nesting in them",
  );
  assert.ok(
    html.indexOf("calibration-legend") < html.indexOf('id="timeline-empty"'),
    "the legend precedes the chart body",
  );
  // The two line series keep a stroke swatch; the five exclusion categories
  // carry the `area` class that renders a filled square.
  assert.match(html, /<i class="legend-dot observed">/u);
  assert.match(html, /<i class="legend-dot expected">/u);
  assert.doesNotMatch(html, /legend-dot area (?:observed|expected)/u);
  for (const status of ["missing", "reset", "weighting", "ambiguous", "saturated"]) {
    assert.match(
      html,
      new RegExp(`<i class="legend-dot area chart-status-${status}">`, "u"),
      `${status} swatch is an area square`,
    );
  }
  assert.match(styles, /\.legend-dot\.area \{[^}]*width: 12px;[^}]*height: 12px;/u);
  assert.match(styles, /\.calibration-legend \{[^}]*width: 100%;/u);
  assert.match(styles, /\.legend-group-sep \{/u);
});

// Owner polish (2026-08-11): "Missing quota bracket" and "Movement needs
// context" shared one grey, so a shaded region could not be mapped back to its
// exclusion. Each exclusion category now owns a distinct hue, and the legend
// swatch carries the same hue as the band it keys.
//
// Owner sanity check (2026-08-19): distinct hues were necessary but not
// sufficient. Every wash sat at .08-.1, where the composite over the card's
// cream lands within a few RGB units of every other and no hue survives, so the
// legend looked colourful and the plot did not. `quota_weighting_unavailable`
// was also a counted exclusion with no hue at all, and fell through the
// renderer's default into violet. Both are pinned here.
test("Trends exclusion bands and legend swatches use five distinct, matching, legible hues", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const names = ["missing", "reset", "weighting", "ambiguous", "saturated"];
  const declaration = (selector) =>
    styles.match(new RegExp(`${selector} \\{ (?:fill|background): rgba\\((\\d+, \\d+, \\d+), (\\.\\d+)\\)`, "u"));
  const bandRule = (name) => declaration(`\\.chart-status-${name}`);
  const tickRule = (name) => declaration(`\\.chart-status-tick\\.chart-status-${name}`);
  const swatchRule = (name) => declaration(`\\.legend-dot\\.chart-status-${name}`);

  const bands = names.map(bandRule);
  const ticks = names.map(tickRule);
  const swatches = names.map(swatchRule);
  assert.ok(bands.every(Boolean), "every exclusion band declares an rgba fill");
  assert.ok(ticks.every(Boolean), "every exclusion band declares an rgba tick fill");
  assert.ok(swatches.every(Boolean), "every legend swatch declares an rgba background");
  assert.equal(
    new Set(bands.map((rule) => rule[1])).size,
    5,
    "the five exclusion bands use five distinct hues",
  );
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    // The wash has to be dense enough for the hue to survive compositing onto
    // cream. Below roughly .12 the five bands are indistinguishable greys, which
    // is the whole defect this test exists to prevent regressing.
    assert.ok(
      Number(bands[index][2]) >= 0.14,
      `the ${name} band wash is dense enough to carry its hue (got ${bands[index][2]})`,
    );
    // The legend shows the reader the TICK, because at a month's zoom the tick
    // is the mark a single excluded window actually leaves on the plot.
    assert.equal(swatches[index][1], ticks[index][1], `${name} swatch matches its tick hue`);
    assert.equal(swatches[index][2], ticks[index][2], `${name} swatch matches its tick alpha`);
    assert.equal(ticks[index][1], bands[index][1], `${name} tick matches its band hue`);
    assert.ok(
      Number(ticks[index][2]) > Number(bands[index][2]) * 2,
      `the ${name} tick reads at identity strength, well above its wash`,
    );
  }
});

// Owner polish (2026-08-11): verify the allowance-exhausted band is wired, not
// silently broken. It renders (with the saturated class the CSS colours rust)
// the moment a pool_saturated window is present.
//
// Owner sanity check (2026-08-19): each exclusion now draws TWO rects — a wash
// at the interval's true extent, and a fixed-minimum tick along the top edge
// carrying the hue at identity strength. Widening the wash itself was rejected:
// it would claim a mechanism was in force for longer than it was.
test("timeline status bands render a wash and an identity tick per exclusion", async () => {
  const documentRef = new FakeSvgDocument(900);
  const { lineChart, CHART_POINT_STYLE } = await loadLineChartRenderer(documentRef);
  const base = Date.UTC(2026, 0, 1);
  const hour = 3_600_000;
  const at = (index) => base + index * hour;
  const points = [0, 1, 2, 3, 4, 5].map((index) => ({
    timestamp: new Date(at(index)).toISOString(),
    value: index,
  }));
  const draw = (statusIntervals) => lineChart({
    points,
    series: [{
      key: "value",
      className: "chart-line-observed",
      label: { key: "series.observed" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    }],
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
    statusIntervals,
  });

  const svg = draw([
    { status: "missing_quota_bracket", startMs: at(0), endMs: at(1) },
    { status: "reset_or_track_change", startMs: at(1), endMs: at(2) },
    { status: "quota_weighting_unavailable", startMs: at(2), endMs: at(3) },
    { status: "backward_or_ambiguous", startMs: at(3), endMs: at(4) },
    { status: "pool_saturated", startMs: at(4), endMs: at(5) },
  ]);

  for (const band of ["missing", "reset", "weighting", "ambiguous", "saturated"]) {
    const rects = svg.querySelectorAll(`rect.chart-status-${band}`);
    assert.equal(rects.length, 2, `${band} draws a wash and a tick`);
    const [wash, tick] = rects;
    assert.equal(wash.getAttribute("class"), `chart-status-${band}`);
    assert.equal(tick.getAttribute("class"), `chart-status-tick chart-status-${band}`);
    assert.ok(
      Number(wash.getAttribute("height")) > Number(tick.getAttribute("height")),
      `the ${band} wash spans the plot and its tick does not`,
    );
    // Both are hoverable and name the same mechanism: at a month's zoom the
    // wash is too narrow to be a usable pointer target on its own.
    assert.equal(wash.children[0].tagName, "title");
    assert.equal(tick.children[0].tagName, "title");
    assert.equal(tick.children[0].textContent, wash.children[0].textContent);
  }
  assert.equal(
    svg.querySelectorAll("rect.chart-status-saturated").length,
    2,
    "a pool_saturated window draws the allowance-exhausted band",
  );

  // A sub-unit interval is what the owner's 30d view is made of: four ambiguous
  // windows across 1,713, each well under a viewBox unit. The wash stays at its
  // (floored) true width while the tick widens to the legibility minimum.
  const sliver = draw([
    { status: "backward_or_ambiguous", startMs: at(2), endMs: at(2) + 1_000 },
  ]);
  const [washSliver, tickSliver] = sliver.querySelectorAll("rect.chart-status-ambiguous");
  assert.equal(Number(washSliver.getAttribute("width")), 1, "the wash never overstates extent");
  assert.ok(
    Number(tickSliver.getAttribute("width")) >= 3,
    "the tick widens to stay visible",
  );
  // Widening is symmetric, so the marker still points at the window it keys.
  const washCentre = Number(washSliver.getAttribute("x")) + 0.5;
  const tickCentre = Number(tickSliver.getAttribute("x"))
    + Number(tickSliver.getAttribute("width")) / 2;
  assert.ok(Math.abs(washCentre - tickCentre) < 0.001, "the tick is centred on its band");
});

// Owner sanity check (2026-08-19): "Allowance exhausted" was in the legend but
// had never once classified a window, and the cause was the classifier's order
// rather than the owner's data. Exhausting a pool spawns a fresh pool with a
// new `resets_at`, so the boundary changes at the instant the ceiling is hit —
// behind `!sameReset`, the saturated branch was shadowed by its own
// precondition. Saturation is tested first now; only `bracketed` outranks it.
test("a pegged pool classifies as exhausted even though its reset boundary moved", () => {
  const pegged = {
    bracketed: true,
    observed: null,
    expected: 4,
    usageEvents: 6,
    apiCostUsd: 9,
    poolSaturated: true,
  };
  assert.deepEqual(
    classifyTimelineEvidence({ ...pegged, sameReset: false }),
    { status: "pool_saturated", residual: null },
    "the peg is the reason the window is unmeasurable, so it is the label",
  );
  assert.deepEqual(
    classifyTimelineEvidence({ ...pegged, sameReset: true }),
    { status: "pool_saturated", residual: null },
  );
  // Without a reading on the start edge there is no ceiling to have observed,
  // so the missing bracket still outranks saturation.
  assert.equal(
    classifyTimelineEvidence({ ...pegged, bracketed: false, sameReset: false }).status,
    "missing_quota_bracket",
  );
  // A boundary change with no peg is still a plain track change.
  assert.equal(
    classifyTimelineEvidence({ ...pegged, poolSaturated: false, sameReset: false }).status,
    "reset_or_track_change",
  );
});

// Owner sanity check (2026-08-19): the intervals were emitted one per window and
// each is floored to a full viewBox unit by the renderer. At a month's zoom the
// spacing between windows is under half a unit, so neighbours in a run
// overlapped and composited their alpha repeatedly — the wash reported point
// DENSITY, not duration. Runs are merged before they reach the renderer.
test("timeline status intervals merge a run of one mechanism into one region", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function timelineStatusIntervals(");
  const end = appSource.indexOf("\n// The weekly track is identified", start);
  assert.ok(start >= 0 && end > start, "the interval builder is available");
  const timelineStatusIntervals = Function(
    "pointTimestampMs",
    "TIMELINE_STATUS_BAND_CLASSES",
    `${appSource.slice(start, end)}\nreturn timelineStatusIntervals;`,
  )(
    (point) => Date.parse(point.timestamp),
    Object.freeze({
      missing_quota_bracket: "missing",
      reset_or_track_change: "reset",
      quota_weighting_unavailable: "weighting",
      backward_or_ambiguous: "ambiguous",
      pool_saturated: "saturated",
    }),
  );

  const base = Date.UTC(2026, 0, 1);
  const hour = 3_600_000;
  const at = (index) => base + index * hour;
  const point = (index, status) => ({
    timestamp: new Date(at(index)).toISOString(),
    status,
  });
  const viewport = { startMs: at(0), endMs: at(9) };

  const merged = timelineStatusIntervals([
    point(0, "missing_quota_bracket"),
    point(1, "missing_quota_bracket"),
    point(2, "missing_quota_bracket"),
    point(3, "matched"),
    point(4, "missing_quota_bracket"),
    point(5, "reset_or_track_change"),
    point(6, "inactive"),
    point(7, "unpriced_local_activity"),
    point(8, "pool_saturated"),
  ], viewport);

  assert.deepEqual(
    merged.map((interval) => interval.status),
    [
      "missing_quota_bracket",
      "missing_quota_bracket",
      "reset_or_track_change",
      "pool_saturated",
    ],
    "a contiguous run collapses; a matched window in between breaks it, and a"
      + " measured state is never shaded at all",
  );
  assert.equal(merged[0].startMs, at(0), "the run is clamped to the viewport");
  assert.equal(merged[0].endMs, at(2) + hour / 2, "the run ends at its last window");
  assert.ok(
    merged[0].endMs - merged[0].startMs > merged[1].endMs - merged[1].startMs,
    "the merged run spans more than the isolated window that follows it",
  );
  // Regions never overlap, so no span composites its own alpha twice.
  for (let index = 1; index < merged.length; index += 1) {
    assert.ok(
      merged[index].startMs >= merged[index - 1].endMs,
      "shaded regions are disjoint",
    );
  }
});

// Owner sanity check (2026-08-19): the renderer's status test used to end in a
// bare `: "ambiguous"`, so three states with no legend entry drew in the violet
// captioned "Movement needs context" — two of which carry both series and are
// COUNTED AS MATCHED, meaning the chart shaded spans the caption beneath it
// calls excluded. Shading is now table-driven with no fallback.
test("timeline status bands shade only the mechanisms the legend keys", async () => {
  const documentRef = new FakeSvgDocument(900);
  const { lineChart, CHART_POINT_STYLE } = await loadLineChartRenderer(documentRef);
  const base = Date.UTC(2026, 0, 1);
  const hour = 3_600_000;
  const at = (index) => base + index * hour;
  const svg = lineChart({
    points: [0, 1, 2, 3].map((index) => ({
      timestamp: new Date(at(index)).toISOString(),
      value: index,
    })),
    series: [{
      key: "value",
      className: "chart-line-observed",
      label: { key: "series.observed" },
      pointStyle: CHART_POINT_STYLE.HOVER_ONLY,
    }],
    title: { key: "chart.title" },
    description: { key: "chart.description" },
    yLabel: { key: "chart.yLabel" },
    statusIntervals: [
      { status: "unpriced_local_activity", startMs: at(0), endMs: at(1) },
      { status: "unexplained_without_local_activity", startMs: at(1), endMs: at(2) },
      { status: "matched", startMs: at(2), endMs: at(3) },
    ],
  });
  assert.equal(
    svg.querySelectorAll("rect.chart-status-ambiguous").length,
    0,
    "a measured window is never shaded as an exclusion",
  );
  assert.equal(svg.querySelectorAll("rect.chart-status-tick").length, 0);
});

// Owner polish (2026-08-11): the five calibration summary tiles laid out
// four-across with a lone orphan beneath. An auto-fit grid distributes them
// evenly (five across, or three-plus-two when narrower) and the two tiles under
// the hourly chart still sit side by side.
test("Trends calibration summary tiles wrap evenly with an auto-fit grid", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const block = styles.match(/\.chart-summary-grid \{([\s\S]*?)\}/u)?.[1] ?? "";
  assert.match(block, /display: grid;/u);
  assert.match(block, /grid-template-columns: repeat\(auto-fit, minmax\(180px, 1fr\)\);/u);
  assert.doesNotMatch(block, /flex: 1 1 200px/u, "the four-plus-one flex fallback is gone");
});

// ===========================================================================
// First-sign-in device-pairing mint: the cookie-commit race, reproduced and
// then closed by the relay's session-cookie bridge (owner-reported
// AUTH_REQUIRED on v0.1.8, 2026-08-11).
//
// This harness drives the SHIPPED app.js mint ceremony
// (mintDevicePairingWithCookieCommitRetry, sliced and executed exactly like the
// renderer harnesses above) through a faithful model of the three moving parts:
//   * a WKWebView cookie jar whose fresh Set-Cookie commits after a chosen
//     latency — instant enough to model the ephemeral store, or beyond the retry
//     budget to model the persistent (disk-backed) store,
//   * the companion relay's cookie forwarding — either the stateless HEAD
//     behaviour (forward only the jar's cookie) or the REAL fix (the imported
//     createParticipantSessionCookieBridge), and
//   * the worker's real session verdict taxonomy: a request with no session
//     cookie is AUTH_REQUIRED (session.ts sessionCookieValue), a request bearing
//     a wrong/stale token is AUTH_INVALID (session.ts authenticateSession).
//
// The taxonomy is the proof: the owner's machine reported AUTH_REQUIRED, which
// can only mean the mint went out cookie-less (the commit-latency race) — a
// stale cookie being sent would be AUTH_INVALID. Both cases are asserted.
// ===========================================================================


// ---------------------------------------------------------------------------
// A companion health answer is not a constant of the page's lifetime (launch
// blocker, reproduced on a fresh macOS account 2026-08-20). The companion
// derives `capabilities.incrementalContributionSync` per request from the
// unified index, so a bootstrap read taken during first-run indexing answers a
// truthful `false` — or, having lost the race outright, does not answer at all.
// Read once and never again, either answer latched the approve ceremony out of
// the document for the life of the page, with no error, no retry, and a
// journey line blaming an index that had already finished.
// ---------------------------------------------------------------------------

const ADVERTISED_HEALTH = Object.freeze({
  capabilities: Object.freeze({
    contributionDevicePairing: true,
    incrementalContributionSync: "telemetry-contribution-v1.0",
  }),
});
// The same companion, answering mid-index: a service is configured, the upload
// source is not written yet, so the transport is honestly absent for now.
const INDEXING_HEALTH = Object.freeze({
  capabilities: Object.freeze({
    contributionDevicePairing: true,
    incrementalContributionSync: false,
  }),
});

test("Forest Ink dark appearance is explicit, balanced, and live-updateable", async () => {
  const [styles, appSource] = await Promise.all([
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(styles, /html\[data-theme="dark"\] \{/u);
  assert.match(styles, /--paper: #141a17;/u);
  assert.match(styles, /--surface-raised: #24322c;/u);
  assert.match(styles, /--ink: #f5f1e8;/u);
  assert.match(styles, /--green: #76aa9c;/u);
  assert.match(styles, /--feature-bg: #2d7466;/u);
  assert.match(styles, /--chart-accent: #99c5ba;/u);
  assert.match(styles, /--blue: #7d9eb8;/u);
  assert.match(
    styles,
    /html\[data-theme="dark"\] \.weekly-hero \{[\s\S]*?gap: 0;[\s\S]*?padding: 0;[\s\S]*?background: var\(--surface\);/u,
  );
  assert.match(
    styles,
    /html\[data-theme="dark"\] \.weekly-hero > div:first-child \{[\s\S]*?background: var\(--feature-bg\);/u,
  );
  assert.match(
    styles,
    /html\[data-theme="dark"\] \.notice\.notice-info\.accounting-disclosure \{[\s\S]*?border-inline-start: 3px solid var\(--blue\);[\s\S]*?background: var\(--surface\);/u,
  );
  assert.match(
    styles,
    /Portable share-card exports deliberately keep the existing light brand/u,
  );
  assert.doesNotMatch(
    styles,
    /@media[^\{]*prefers-color-scheme[^\{]*\{[\s\S]*?--paper: #141a17/u,
  );

  assert.match(
    appSource,
    /const NATIVE_APPEARANCE_THEMES = new Set\(\["light", "dark"\]\)/u,
  );
  assert.match(
    appSource,
    /if \(!NATIVE_APPEARANCE_THEMES\.has\(theme\)\) return false;/u,
  );
  assert.match(appSource, /document\.documentElement\.dataset\.theme = theme/u);
  assert.match(appSource, /__TIBOTATTLE_APPEARANCE__\?\.resolvedTheme/u);
  assert.match(appSource, /"tibotattle:appearance-override"/u);
  assert.match(
    appSource,
    /theme === "dark" \? "#141a17" : "#f5f1e8"/u,
  );
});
